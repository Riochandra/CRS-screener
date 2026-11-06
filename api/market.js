const PROVIDERS = {
  binanceSpot: {
    origin: 'https://data-api.binance.vision',
    prefixes: ['/api/v3/'],
  },
  binanceFutures: {
    origin: 'https://fapi.binance.com',
    prefixes: ['/fapi/v1/'],
  },
  bybit: {
    origin: 'https://api.bybit.com',
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

  const upstream = new URL(path, provider.origin);
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'provider' || key === 'path') continue;
    if (Array.isArray(value)) value.forEach(v => upstream.searchParams.append(key, String(v)));
    else if (value !== undefined) upstream.searchParams.set(key, String(value));
  }

  // Cache slow-changing market-cap lists longer; keep live prices/klines short.
  const cacheSeconds = providerName === 'coingecko' || providerName === 'coinpaprika' ? 300 : 2;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstream, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'CRS-Screener/1.0' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const body = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('content-type') || '';
    res.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`);
    res.setHeader('X-Market-Data-Provider', providerName);
    // Always return valid JSON for API errors, even if an upstream sends an HTML block page.
    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({ error: `${providerName} upstream HTTP ${upstreamResponse.status}`, provider: providerName, detail: body.slice(0, 500) });
    }
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
