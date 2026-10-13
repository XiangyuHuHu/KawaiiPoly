import { PLAN17_DEFAULTS, plan17IvSkipReason } from './polymarketPlan17.js';

const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

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

export async function fetchPlan17Dvol(currency, nowMs = Date.now(), {
  maxIvAgeMs = PLAN17_DEFAULTS.maxIvAgeMs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}`
    + `&start_timestamp=${nowMs - 3 * 3_600_000}&end_timestamp=${nowMs}&resolution=60`;
  const startedMs = Date.now();
  let payload;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      payload = await getJson(url);
      if (payload?.error) throw new Error(`Deribit: ${payload.error.message || 'RPC error'}`);
      break;
    } catch (cause) {
      if (attempt === 2) throw Object.assign(new Error(`DVOL ${currency} unavailable: ${cause.message}`), { reason: 'iv_unavailable', cause });
      await sleep(Math.min(1000, 250 * 2 ** attempt));
    }
  }
  const rows = payload?.result?.data;
  const row = Array.isArray(rows) ? rows.at(-1) : null;
  const data = { iv: row?.[4], ivTimestampMs: row?.[0] };
  const reason = plan17IvSkipReason(data, nowMs + Math.max(0, Date.now() - startedMs), maxIvAgeMs);
  if (reason) throw Object.assign(new Error(`DVOL ${currency}: ${reason}`), { reason });
  return data;
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
