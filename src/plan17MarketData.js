const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const DVOL_TTL_MS = 5 * 60_000;
const dvolCache = new Map();

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function binance(path) {
  let lastError = null;
  for (const host of BINANCE_HOSTS) {
    try { return await getJson(`${host}${path}`); } catch (error) { lastError = error; }
  }
  throw lastError || new Error('binance unavailable');
}

export async function fetchPlan17Dvol(currency, nowMs = Date.now()) {
  const cached = dvolCache.get(currency);
  if (cached && nowMs - cached.atMs < DVOL_TTL_MS) return cached.value;
  const payload = await getJson(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}`
    + `&start_timestamp=${nowMs - 3 * 3_600_000}&end_timestamp=${nowMs}&resolution=60`);
  const rows = payload?.result?.data || [];
  const value = Number(rows.at(-1)?.[4]);
  if (!(value > 0)) throw new Error(`DVOL ${currency} missing`);
  dvolCache.set(currency, { atMs: nowMs, value });
  return value;
}

/**
 * Last Binance 1m close plus the high/low of every 1m candle since fromMs
 * (the same candles the hit markets resolve on).
 */
export async function fetchPlan17Spot(symbol, fromMs = null, nowMs = Date.now()) {
  const ticker = await binance(`/api/v3/ticker/price?symbol=${symbol}`);
  const spot = Number(ticker?.price);
  let high = null; let low = null;
  if (Number.isFinite(fromMs) && fromMs < nowMs) {
    let cursor = Math.floor(fromMs / 60_000) * 60_000;
    for (let page = 0; page < 3 && cursor < nowMs; page += 1) {
      const rows = await binance(`/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${cursor}&limit=1000`);
      if (!rows?.length) break;
      for (const row of rows) {
        const h = Number(row[2]); const l = Number(row[3]);
        if (high == null || h > high) high = h;
        if (low == null || l < low) low = l;
      }
      cursor = rows.at(-1)[0] + 60_000;
    }
  }
  return { spot, high, low };
}
