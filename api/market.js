const PROVIDERS = {
  binanceSpot: {
    origin: 'https://api.binance.com',
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
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const body = await upstreamResponse.text();
    res.setHeader('Content-Type', upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`);
    res.setHeader('X-Market-Data-Provider', providerName);
    return res.status(upstreamResponse.status).send(body);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return res.status(502).json({
      error: timedOut ? 'Upstream market-data request timed out' : 'Unable to reach upstream market-data provider',
      provider: providerName,
    });
  }
};
