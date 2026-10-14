import { isIntlHost, US_GATEWAY_ORIGIN } from './rules.js';

function quoteValue(node) {
  if (node == null || node === '') return null;
  if (typeof node === 'number') return Number.isFinite(node) ? node : null;
  if (typeof node === 'string') {
    const value = Number(node);
    return Number.isFinite(value) ? value : null;
  }
  if (typeof node === 'object') return quoteValue(node.value);
  return null;
}

export function eventSlug(slug) {
  return String(slug || '').replace(/^cpc-/, '');
}

export function eventUrl(slug, origin = 'https://polymarket.us') {
  const display = eventSlug(slug);
  if (!display) return null;
  return `${origin.replace(/\/$/, '')}/event/${display}`;
}

export function normalizeBbo(payload) {
  const data = payload?.marketData || payload || {};
  return {
    slug: data.marketSlug || null,
    bestBid: quoteValue(data.bestBid),
    bestAsk: quoteValue(data.bestAsk),
    longAsk: quoteValue(data.longQuote) ?? quoteValue(data.bestAsk),
    shortAsk: quoteValue(data.shortQuote),
    bidShares: quoteValue(data.bidShares),
    askShares: quoteValue(data.askShares),
    sampledAt: data.lastPriceSample?.ts || null,
    state: data.state || null
  };
}

export function normalizeBook(payload) {
  const data = payload?.marketData || payload || {};
  const levels = (rows) => (Array.isArray(rows) ? rows : [])
    .map((level) => ({
      price: quoteValue(level?.px ?? level?.price),
      size: quoteValue(level?.qty ?? level?.size)
    }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0);
  const bids = levels(data.bids).sort((left, right) => right.price - left.price);
  const asks = levels(data.offers || data.asks).sort((left, right) => left.price - right.price);
  return {
    slug: data.marketSlug || null,
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bestAskSize: asks[0]?.size ?? null,
    state: data.state || null
  };
}

function unwrapMarket(payload, slug) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.markets)) {
    return payload.markets.find((market) => !slug || market?.slug === slug) || payload.markets[0] || null;
  }
  if (payload.market && typeof payload.market === 'object') return payload.market;
  if (payload.slug) return payload;
  return null;
}

export class PolymarketUsGateway {
  constructor({
    baseUrl = US_GATEWAY_ORIGIN,
    requestTimeoutMs = 12_000,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (isIntlHost(baseUrl)) {
      throw new Error('US gateway client refuses international Gamma/CLOB hosts');
    }
    this.baseUrl = String(baseUrl || US_GATEWAY_ORIGIN).replace(/\/$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async listMarkets({
    endDateMin,
    endDateMax,
    limit = 100,
    offset = 0,
    closed = false
  } = {}) {
    const payload = await this.request('/markets', {
      endDateMin,
      endDateMax,
      limit,
      offset,
      closed: closed ? 'true' : 'false'
    });
    return Array.isArray(payload?.markets) ? payload.markets : [];
  }

  async getMarket(slug) {
    if (!slug) throw new Error('slug is required');
    try {
      const direct = await this.request(`/markets/${encodeURIComponent(slug)}`);
      const market = unwrapMarket(direct, slug);
      if (market) return market;
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    const listed = await this.request('/markets', { slug, limit: 5, closed: 'false' });
    const market = unwrapMarket(listed, slug);
    if (!market) {
      const missing = new Error(`US market not found: ${slug}`);
      missing.code = 'NOT_FOUND';
      missing.status = 404;
      throw missing;
    }
    return market;
  }

  async getBbo(slug) {
    if (!slug) throw new Error('slug is required');
    return normalizeBbo(await this.request(`/markets/${encodeURIComponent(slug)}/bbo`));
  }

  async getBook(slug) {
    if (!slug) throw new Error('slug is required');
    return normalizeBook(await this.request(`/markets/${encodeURIComponent(slug)}/book`));
  }

  async request(path, query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const target = params.size ? `${this.baseUrl}${path}?${params}` : `${this.baseUrl}${path}`;
    if (isIntlHost(target)) {
      throw new Error('US gateway client refuses international Gamma/CLOB hosts');
    }
    const response = await this.fetchImpl(target, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const text = await response.text();
    const data = text ? safeJson(text) : null;
    if (!response.ok) {
      const error = new Error(typeof data === 'object' && data?.message
        ? data.message
        : `US gateway ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
