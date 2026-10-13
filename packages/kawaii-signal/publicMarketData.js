const SYMBOL_TO_BINANCE = {
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'SOL-USD': 'SOLUSDT',
  'XRP-USD': 'XRPUSDT',
  'DOGE-USD': 'DOGEUSDT'
};

const BINANCE_TO_SYMBOL = Object.fromEntries(
  Object.entries(SYMBOL_TO_BINANCE).map(([symbol, pair]) => [pair, symbol])
);

export class PublicMarketDataClient {
  constructor({
    baseUrls = ['https://data-api.binance.vision', 'https://api.binance.com'],
    requestTimeoutMs = 8000,
    restrictedCooldownMs = 5 * 60 * 1000
  } = {}) {
    this.baseUrls = baseUrls;
    this.requestTimeoutMs = requestTimeoutMs;
    this.restrictedCooldownMs = restrictedCooldownMs;
    // A restriction or transient policy response belongs to one endpoint, not to
    // every symbol and every mirror.  Keeping a global cooldown here used to
    // freeze the whole signal pipeline for five minutes after one bad response.
    this.restrictedBaseUntilMs = new Map();
    this.restrictedBaseReasons = new Map();
    this.responseCache = new Map();
    this.inflightRequests = new Map();
  }

  toBinancePair(symbol) {
    const pair = SYMBOL_TO_BINANCE[symbol];
    if (!pair) throw new Error(`Unsupported symbol for public market data: ${symbol}`);
    return pair;
  }

  async request(path, { cacheTtlMs = 0 } = {}) {
    const now = Date.now();
    const cached = this.responseCache.get(path);
    if (cached && now - cached.at < cacheTtlMs) return cached.payload;
    if (this.inflightRequests.has(path)) return this.inflightRequests.get(path);

    const inflight = this.requestFresh(path)
      .then((payload) => {
        if (cacheTtlMs > 0) this.responseCache.set(path, { at: Date.now(), payload });
        this.inflightRequests.delete(path);
        this.pruneResponseCache();
        return payload;
      })
      .catch((error) => {
        this.inflightRequests.delete(path);
        throw error;
      });
    this.inflightRequests.set(path, inflight);
    return inflight;
  }

  async requestFresh(path) {
    let lastError;
    let attempted = 0;
    let restrictedCount = 0;
    const now = Date.now();
    for (const baseUrl of this.baseUrls) {
      const restrictedUntilMs = Number(this.restrictedBaseUntilMs.get(baseUrl)) || 0;
      if (now < restrictedUntilMs) {
        restrictedCount += 1;
        continue;
      }
      attempted += 1;
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
        const text = await response.text();
        const data = text ? safeJson(text) : null;
        if (!response.ok) {
          throw new Error(typeof data === 'object' ? JSON.stringify(data) : text || response.statusText);
        }
        this.restrictedBaseUntilMs.delete(baseUrl);
        this.restrictedBaseReasons.delete(baseUrl);
        return data;
      } catch (error) {
        lastError = error;
        if (isRestrictedLocationError(error)) {
          restrictedCount += 1;
          this.restrictedBaseReasons.set(baseUrl, error?.message || String(error));
          this.restrictedBaseUntilMs.set(
            baseUrl,
            Date.now() + Math.max(30_000, Number(this.restrictedCooldownMs) || 0)
          );
          // Try the next mirror. One restricted endpoint must not stop all
          // market signals and lock decisions.
          continue;
        }
      }
    }
    if (attempted === 0 && restrictedCount >= this.baseUrls.length) {
      const reason = [...this.restrictedBaseReasons.values()][0] || 'restricted location';
      throw new Error(`Public market source temporarily disabled: ${reason}`);
    }
    throw new Error(`Public market request failed: ${lastError?.message || 'unknown error'}`);
  }

  pruneResponseCache(now = Date.now()) {
    for (const [key, entry] of this.responseCache) {
      if (!entry || now - entry.at > 60_000) this.responseCache.delete(key);
    }
  }

  async getQuotes(symbols = ['BTC-USD', 'ETH-USD']) {
    const pairs = symbols.map((symbol) => this.toBinancePair(symbol));
    const payload = await this.request(
      `/api/v3/ticker/bookTicker?symbols=${encodeURIComponent(JSON.stringify(pairs))}`,
      { cacheTtlMs: 750 }
    );
    const rows = Array.isArray(payload) ? payload : [payload];

    return {
      source: 'binance',
      results: rows.map((row) => this.normalizeQuote(row))
    };
  }

  async getHistoricalCloses(symbols = ['BTC-USD', 'ETH-USD'], interval = '1h', limit = 120) {
    const series = {};
    for (const symbol of symbols) {
      const candles = await this.getCandles(symbol, interval, limit);
      series[symbol] = candles.map((candle) => candle.close).filter((value) => Number.isFinite(value) && value > 0);
    }
    return series;
  }

  async getCandles(symbol, interval = '1h', limit = 300) {
    const pair = this.toBinancePair(symbol);
    const safeLimit = Math.min(Math.max(Number(limit) || 300, 1), 1000);
    const rows = await this.request(
      `/api/v3/klines?symbol=${pair}&interval=${encodeURIComponent(interval)}&limit=${safeLimit}`,
      { cacheTtlMs: 1000 }
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Empty Binance kline payload');

    return rows.map(([time, open, high, low, close, volume]) => ({
      time: Math.floor(Number(time) / 1000),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume)
    }));
  }

  async getClosedCandleClose(symbol, interval = '15m', closeTimeIso) {
    const candle = await this.getClosedCandle(symbol, interval, closeTimeIso);
    return candle.close;
  }

  async getWindowPrices(symbol, interval = '15m', closeTimeIso) {
    const candle = await this.getClosedCandle(symbol, interval, closeTimeIso);
    return {
      startPrice: candle.open,
      actualClose: candle.close,
      actualDirection: candle.close >= candle.open ? 'up' : 'down'
    };
  }

  async getClosedCandle(symbol, interval = '15m', closeTimeIso) {
    const pair = this.toBinancePair(symbol);
    const closeMs = Date.parse(closeTimeIso);
    if (!Number.isFinite(closeMs)) throw new Error(`Invalid close time: ${closeTimeIso}`);
    const rows = await this.request(
      `/api/v3/klines?symbol=${pair}&interval=${encodeURIComponent(interval)}&endTime=${closeMs}&limit=2`,
      { cacheTtlMs: 60_000 }
    );
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('Empty Binance kline payload');

    const candle = [...rows].reverse().find((row) => {
      const openMs = Number(row[0]);
      const closeTimeMs = Number(row[6]);
      return Number.isFinite(openMs) && Number.isFinite(closeTimeMs) && openMs < closeMs && closeTimeMs <= closeMs;
    });
    const open = Number(candle?.[1]);
    const close = Number(candle?.[4]);
    if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(close) || close <= 0) {
      throw new Error(`No closed ${interval} candle for ${symbol} at ${closeTimeIso}`);
    }
    return { open, close };
  }

  async getMarketView(symbols = ['BTC-USD', 'ETH-USD'], interval = '1h', sparklineLimit = 24) {
    const [quotes, sparklines] = await Promise.all([
      this.getQuotes(symbols),
      this.getSparklines(symbols, interval, sparklineLimit)
    ]);

    return {
      source: 'binance',
      results: quotes.results.map((quote) => ({
        ...quote,
        sparkline: sparklines[quote.symbol] || []
      }))
    };
  }

  async getSparklines(symbols, interval = '1h', limit = 24) {
    const sparklines = {};
    for (const symbol of symbols) {
      const pair = this.toBinancePair(symbol);
      const candles = await this.request(
        `/api/v3/klines?symbol=${pair}&interval=${encodeURIComponent(interval)}&limit=${limit}`,
        { cacheTtlMs: 5000 }
      );
      sparklines[symbol] = candles.map((candle) => Number(candle[4])).filter((value) => Number.isFinite(value) && value > 0);
    }
    return sparklines;
  }

  normalizeQuote(row) {
    const symbol = BINANCE_TO_SYMBOL[row.symbol];
    if (!symbol) throw new Error(`Unknown Binance pair: ${row.symbol}`);

    const bid = Number(row.bidPrice);
    const ask = Number(row.askPrice);
    const mid = (bid + ask) / 2;
    const spread = Math.max(ask - bid, 0);

    return {
      symbol,
      price: mid.toFixed(8),
      bid_inclusive_of_sell_spread: bid.toFixed(8),
      sell_spread: (spread / 2).toFixed(8),
      ask_inclusive_of_buy_spread: ask.toFixed(8),
      buy_spread: (spread / 2).toFixed(8),
      timestamp: new Date().toISOString(),
      source: 'binance'
    };
  }
}

function isRestrictedLocationError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('restricted location')
    || message.includes('eligibility')
    || message.includes('service unavailable from a restricted');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
