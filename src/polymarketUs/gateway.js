import { US_GATEWAY_BASE, US_MARKET_PATHS } from './constants.js';
import { usRequest } from './http.js';
import { isIntlHost } from './rules.js';
import { readNumber, tradingSlug } from './shape.js';

function amount(node) {
  if (node == null || node === '') return null;
  if (typeof node === 'number' || typeof node === 'string') return readNumber(node);
  return readNumber(node.value, node.px, node.price);
}

function unwrapRecord(payload, keys) {
  if (!payload || typeof payload !== 'object') return {};
  for (const key of keys) {
    if (payload[key] && typeof payload[key] === 'object' && !Array.isArray(payload[key])) return payload[key];
  }
  return payload;
}

export function eventSlug(slug) {
  return String(slug || '').replace(/^cpc-/, '');
}

export function eventUrl(slug, origin = 'https://polymarket.us') {
  const display = eventSlug(slug);
  if (!display) return null;
  return `${origin.replace(/\/$/, '')}/event/${display}`;
}

export function normalizeUsBbo(payload, observedAt = new Date().toISOString()) {
  const row = unwrapRecord(payload, ['marketData', 'bbo', 'data']);
  const bestBid = amount(row.bestBid ?? row.bid);
  const bestAsk = amount(row.bestAsk ?? row.ask);
  const longQuote = amount(row.longQuote);
  const shortQuote = amount(row.shortQuote);
  const askShares = readNumber(row.askShares, row.askDepth);
  const bidShares = readNumber(row.bidShares, row.bidDepth);
  const sampledAt = row.lastPriceSample?.ts || null;
  return {
    slug: row.marketSlug || null,
    bestBid,
    bestAsk,
    longQuote,
    shortQuote,
    longAsk: longQuote ?? bestAsk,
    shortAsk: shortQuote,
    yesAsk: bestAsk ?? longQuote,
    noAsk: shortQuote ?? (bestBid == null ? null : Math.round((1 - bestBid) * 10000) / 10000),
    spread: bestBid != null && bestAsk != null ? Math.round((bestAsk - bestBid) * 10000) / 10000 : null,
    askShares,
    bidShares,
    state: row.state || null,
    observedAt: sampledAt || observedAt,
    sampledAt,
    raw: payload
  };
}

/** Scan pipeline name for the same BBO shape. */
export function normalizeBbo(payload) {
  return normalizeUsBbo(payload);
}

export function quoteForSide(bbo, side) {
  if (!bbo) return null;
  if (side === 'no') return bbo.noAsk ?? null;
  return bbo.yesAsk ?? bbo.bestAsk ?? null;
}

function level(row) {
  const price = amount(row?.px ?? row?.price);
  const shares = readNumber(row?.qty, row?.quantity, row?.size);
  return { price, shares, size: shares };
}

export function normalizeUsBook(payload) {
  const row = unwrapRecord(payload, ['marketData', 'book', 'data']);
  const bids = (row.bids || []).map(level).filter((item) => item.price != null && item.price > 0 && item.shares > 0)
    .sort((left, right) => right.price - left.price);
  const asks = (row.offers || row.asks || []).map(level).filter((item) => item.price != null && item.price > 0 && item.shares > 0)
    .sort((left, right) => left.price - right.price);
  return {
    slug: row.marketSlug || null,
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bestAskSize: asks[0]?.size ?? null,
    state: row.state || null,
    stats: row.stats || null
  };
}

export function normalizeBook(payload) {
  return normalizeUsBook(payload);
}

function marketRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.markets)) return payload.markets;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export function normalizeUsMarket(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...row,
    id: row.id ?? null,
    slug: row.slug || row.marketSlug || null,
    title: row.title || row.question || row.name || null,
    eventSlug: row.eventSlug || row.event?.slug || null,
    closed: row.closed === true,
    active: row.active !== false,
    endDate: row.endDate || row.end_date || null,
    resolutionSource: row.resolutionSource || row.resolution_source || null
  };
}

function unwrapMarket(payload, slug) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.markets)) {
    return payload.markets.find((market) => !slug || market?.slug === slug) || payload.markets[0] || null;
  }
  if (payload.market && typeof payload.market === 'object') return payload.market;
  if (payload.slug || payload.marketSlug) return payload;
  return null;
}

function gatewayOrigin(value) {
  return String(value || US_GATEWAY_BASE).replace(/\/$/, '').replace(/\/v1$/, '');
}

export class PolymarketUsGateway {
  constructor({
    baseUrl,
    gatewayBaseUrl = US_GATEWAY_BASE,
    requestTimeoutMs = 12_000,
    fetchImpl
  } = {}) {
    if (baseUrl && isIntlHost(baseUrl)) {
      throw new Error('US gateway client refuses international Gamma/CLOB hosts');
    }
    this.gatewayBaseUrl = gatewayOrigin(baseUrl || gatewayBaseUrl);
    this.baseUrl = this.gatewayBaseUrl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.line = 'polymarket_us';
  }

  request(path, query) {
    return usRequest({
      baseUrl: this.gatewayBaseUrl,
      method: 'GET',
      path,
      query,
      timeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
      label: '美国盘行情'
    });
  }

  async listMarkets({
    endDateMin,
    endDateMax,
    limit = 100,
    offset = 0,
    closed = false,
    active,
    slug
  } = {}) {
    const { data } = await this.request(US_MARKET_PATHS.list, {
      endDateMin,
      endDateMax,
      limit,
      offset,
      closed: closed === true || closed === 'true' ? 'true' : 'false',
      active,
      slug
    });
    return marketRows(data).map(normalizeUsMarket).filter(Boolean);
  }

  async getMarket(slug) {
    if (!slug) throw new Error('slug is required');
    const safe = encodeURIComponent(tradingSlug(slug));
    try {
      const { data } = await this.request(`${US_MARKET_PATHS.bbo}/${safe}`);
      const market = unwrapMarket(data, slug);
      if (market?.slug || market?.marketSlug) return normalizeUsMarket(market);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    try {
      const { data } = await this.request(US_MARKET_PATHS.list, { slug, limit: 5, closed: 'false' });
      const market = unwrapMarket(data, slug);
      if (market?.slug || market?.marketSlug) return normalizeUsMarket(market);
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    try {
      const { data } = await this.request(`${US_MARKET_PATHS.bySlug}/${safe}`);
      const row = unwrapMarket(data, slug) || data?.market || data;
      const market = normalizeUsMarket(row);
      if (market?.slug) return market;
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
    const missing = new Error(`US market not found: ${slug}`);
    missing.code = 'NOT_FOUND';
    missing.status = 404;
    throw missing;
  }

  async getBbo(slug) {
    if (!slug) throw new Error('slug is required');
    const safe = encodeURIComponent(tradingSlug(slug));
    const { data } = await this.request(`${US_MARKET_PATHS.bbo}/${safe}/bbo`);
    return normalizeUsBbo(data);
  }

  async getBook(slug) {
    if (!slug) throw new Error('slug is required');
    const safe = encodeURIComponent(tradingSlug(slug));
    const { data } = await this.request(`${US_MARKET_PATHS.book}/${safe}/book`);
    return normalizeUsBook(data);
  }

  async getSettlement(slug) {
    const safe = encodeURIComponent(tradingSlug(slug));
    const { data } = await this.request(`${US_MARKET_PATHS.settlement}/${safe}/settlement`);
    return data;
  }
}
