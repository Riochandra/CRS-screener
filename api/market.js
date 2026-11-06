const PROVIDERS = {
  binanceSpot: {
    origin: 'https://data-api.binance.vision',
    prefixes: ['/api/v3/'],
  },
  binanceFutures: {
    // Binance documents several USD-M Futures REST hosts. Try the mirrors
    // in sequence because a particular egress route may be blocked.
    origins: ['https://fapi.binance.com', 'https://fapi1.binance.com', 'https://fapi2.binance.com', 'https://fapi3.binance.com', 'https://fapi4.binance.com'],
    prefixes: ['/fapi/v1/'],
  },
  bybit: {
    // Official Bybit global mainnet hosts; try the documented alternate if one is blocked.
    origins: ['https://api.bybit.com', 'https://api.bytick.com'],
    prefixes: ['/v5/market/'],
  },
  coingecko: {
    origin: 'https://api.coingecko.com',
    prefixes: ['/api/v3/coins/markets'],
  },
  coinpaprika: {
    origin: 'https://api.coinpaprika.com',
    prefixes: ['/v1/tickers'],
  },
};

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const providerName = String(req.query.provider || '');
  const path = String(req.query.path || '');
  const provider = PROVIDERS[providerName];
  if (!provider || !path.startsWith('/') || path.includes('..') || !provider.prefixes.some(prefix => path.startsWith(prefix))) {
    return res.status(400).json({ error: 'Unsupported market-data provider or endpoint' });
  }

  const origins = provider.origins || [provider.origin];
  const makeUpstream = origin => {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'provider' || key === 'path') continue;
      if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, String(v)));
      else if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  };

  // Cache slow-changing market-cap lists longer; keep live prices/klines short.
  const cacheSeconds = providerName === 'coingecko' || providerName === 'coinpaprika' ? 300 : 2;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let upstreamResponse;
    let upstreamUrl;
    const attempts = [];
    try {
      for (const origin of origins) {
        upstreamUrl = makeUpstream(origin);
        upstreamResponse = await fetch(upstreamUrl, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': 'CRS-Screener/1.0' },
          signal: controller.signal,
        });
        if (upstreamResponse.ok) break;
        const failureBody = await upstreamResponse.text();
        attempts.push({ host: new URL(origin).hostname, status: upstreamResponse.status, detail: failureBody.slice(0, 180) });
        // A 4xx response is normally host/region-specific or an endpoint issue;
        // try the next documented mirror before returning the final diagnostic.
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!upstreamResponse) throw new Error('No upstream response');
    if (!upstreamResponse.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(upstreamResponse.status).json({ error: `${providerName} upstream HTTP ${upstreamResponse.status}`, provider: providerName, attempts });
    }
    const body = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('content-type') || '';
    res.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`);
    res.setHeader('X-Market-Data-Provider', providerName);
    // Always return valid JSON for API errors, even if an upstream sends an HTML block page.
    if (!contentType.includes('json')) {
      return res.status(502).json({ error: `${providerName} returned a non-JSON response`, provider: providerName, contentType, detail: body.slice(0, 500) });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try { JSON.parse(body); } catch (_) {
      return res.status(502).json({ error: `${providerName} returned invalid JSON`, provider: providerName, detail: body.slice(0, 500) });
    }
    return res.status(200).send(body);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return res.status(502).json({
      error: timedOut ? 'Upstream market-data request timed out' : 'Unable to reach upstream market-data provider',
      provider: providerName,
    });
  }
};
