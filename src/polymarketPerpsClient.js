const DEFAULT_BASE = 'https://api.perpetuals.polymarket.com';
const CACHE_MS = 15_000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pick(row, snake, camel) {
  if (!row) return undefined;
  return row[snake] ?? row[camel];
}

export function buildPerpsBoard(instruments = [], tickers = []) {
  const byId = new Map();
  for (const ticker of tickers) {
    const id = Number(pick(ticker, 'instrument_id', 'instrumentId'));
    if (Number.isFinite(id)) byId.set(id, ticker);
  }
  const rows = instruments.map((instrument) => {
    const id = Number(pick(instrument, 'instrument_id', 'id'));
    const ticker = byId.get(id) || {};
    const markPrice = finite(pick(ticker, 'mark_price', 'markPrice'));
    const indexPrice = finite(pick(ticker, 'index_price', 'indexPrice'));
    const lastPrice = finite(pick(ticker, 'last_price', 'lastPrice'));
    const openPrice = finite(pick(ticker, 'open_price', 'openPrice'));
    return {
      id,
      symbol: instrument.symbol || '',
      category: instrument.category || 'other',
      baseAsset: pick(instrument, 'base_asset', 'baseAsset') || '',
      maxLeverage: finite(pick(instrument, 'max_leverage', 'maxLeverage')),
      fundingInterval: pick(instrument, 'funding_interval', 'fundingInterval') || null,
      closeOnly: Boolean(instrument.close_only ?? instrument.closeOnly),
      markPrice,
      indexPrice,
      lastPrice,
      openInterest: finite(pick(ticker, 'open_interest', 'openInterest')),
      volume24h: finite(pick(ticker, 'volume_24h', 'volume24h')) || 0,
      fundingRate: finite(pick(ticker, 'funding_rate', 'fundingRate')),
      change24h: openPrice > 0 && lastPrice != null ? (lastPrice - openPrice) / openPrice : null,
      basis: indexPrice > 0 && markPrice != null ? (markPrice - indexPrice) / indexPrice : null
    };
  }).filter((row) => row.symbol);
  rows.sort((left, right) => right.volume24h - left.volume24h || left.symbol.localeCompare(right.symbol));
  const categories = {};
  for (const row of rows) categories[row.category] = (categories[row.category] || 0) + 1;
  return {
    tradable: false,
    reason: '公开行情已接入。下单需要单独的 proxy 签名、保证金和强平，不并入现有 CLOB 实盘。',
    count: rows.length,
    categories,
    rows
  };
}

export class PolymarketPerpsClient {
  constructor({
    baseUrl = DEFAULT_BASE,
    requestTimeoutMs = 12000,
    cacheMs = CACHE_MS,
    fetchImpl = fetch
  } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE).replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.cacheMs = cacheMs;
    this.fetchImpl = fetchImpl;
    this.cached = null;
  }

  async snapshot({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.at < this.cacheMs) return this.cached.value;
    const [instruments, tickers] = await Promise.all([
      this.get('/v1/info/instruments'),
      this.get('/v1/info/tickers')
    ]);
    const value = {
      ok: true,
      updatedAtIso: new Date().toISOString(),
      source: this.baseUrl,
      ...buildPerpsBoard(
        Array.isArray(instruments) ? instruments : [],
        Array.isArray(tickers) ? tickers : []
      )
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  async get(path) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data && typeof data === 'object' ? JSON.stringify(data) : text || response.statusText;
      throw new Error(`Perps ${path} ${response.status}: ${message}`);
    }
    return data;
  }
}
