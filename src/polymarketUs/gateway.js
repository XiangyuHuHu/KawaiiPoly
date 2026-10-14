import { US_GATEWAY_BASE, US_MARKET_PATHS } from './constants.js';
import { usRequest } from './http.js';
import { readNumber, tradingSlug } from './shape.js';

function amount(node) {
  if (node == null) return null;
  if (typeof node === 'number' || typeof node === 'string') return readNumber(node);
  return readNumber(node.value, node.px, node.price);
}

function unwrapRecord(payload, keys) {
  if (!payload || typeof payload !== 'object') return {};
  for (const key of keys) {
    if (payload[key] && typeof payload[key] === 'object') return payload[key];
  }
  return payload;
}

export function normalizeUsBbo(payload, observedAt = new Date().toISOString()) {
  const row = unwrapRecord(payload, ['marketData', 'bbo', 'data']);
  const bestBid = amount(row.bestBid ?? row.bid);
  const bestAsk = amount(row.bestAsk ?? row.ask);
  const longQuote = amount(row.longQuote);
  const shortQuote = amount(row.shortQuote);
  const askShares = readNumber(row.askShares, row.askDepth);
  const bidShares = readNumber(row.bidShares, row.bidDepth);
  return {
    bestBid,
    bestAsk,
    longQuote,
    shortQuote,
    yesAsk: bestAsk ?? longQuote,
    noAsk: shortQuote ?? (bestBid == null ? null : Math.round((1 - bestBid) * 10000) / 10000),
    spread: bestBid != null && bestAsk != null ? Math.round((bestAsk - bestBid) * 10000) / 10000 : null,
    askShares,
    bidShares,
    state: row.state || null,
    observedAt,
    raw: payload
  };
}

export function quoteForSide(bbo, side) {
  if (!bbo) return null;
  if (side === 'no') return bbo.noAsk ?? null;
  return bbo.yesAsk ?? bbo.bestAsk ?? null;
}

function level(row) {
  return {
    price: amount(row?.px ?? row?.price),
    shares: readNumber(row?.qty, row?.quantity, row?.size)
  };
}

export function normalizeUsBook(payload) {
  const row = unwrapRecord(payload, ['marketData', 'book', 'data']);
  const bids = (row.bids || []).map(level).filter((item) => item.price != null);
  const asks = (row.offers || row.asks || []).map(level).filter((item) => item.price != null);
  return { bids, asks, state: row.state || null, stats: row.stats || null };
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

export class PolymarketUsGateway {
  constructor({
    gatewayBaseUrl = US_GATEWAY_BASE,
    requestTimeoutMs = 12000,
    fetchImpl
  } = {}) {
    this.gatewayBaseUrl = gatewayBaseUrl;
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
    limit,
    closed = false,
    active,
    offset,
    slug
  } = {}) {
    const { data } = await this.request(US_MARKET_PATHS.list, {
      endDateMin,
      endDateMax,
      limit,
      closed,
      active,
      offset,
      slug
    });
    return marketRows(data).map(normalizeUsMarket).filter(Boolean);
  }

  async getMarket(slug) {
    const safe = encodeURIComponent(tradingSlug(slug));
    const { data } = await this.request(`${US_MARKET_PATHS.bySlug}/${safe}`);
    const row = data?.market || data;
    return normalizeUsMarket(row);
  }

  async getBbo(slug) {
    const safe = encodeURIComponent(tradingSlug(slug));
    const { data } = await this.request(`${US_MARKET_PATHS.bbo}/${safe}/bbo`);
    return normalizeUsBbo(data);
  }

  async getBook(slug) {
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
