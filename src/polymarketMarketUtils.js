import { parseMarketOutcomes } from './polymarketClient.js';

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeOrderBook(book = {}) {
  const normalizeLevels = (levels) => (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: finite(level?.price, NaN), size: finite(level?.size, 0) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && level.size > 0);
  const bids = normalizeLevels(book.bids).sort((a, b) => b.price - a.price);
  const asks = normalizeLevels(book.asks).sort((a, b) => a.price - b.price);
  return {
    bids,
    asks,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    tickSize: Math.max(0.0001, finite(book.tick_size ?? book.tickSize, 0.01)),
    minOrderSize: Math.max(1, finite(book.min_order_size ?? book.minOrderSize, 5)),
    timestamp: book.timestamp || null
  };
}

export function polymarketCryptoTakerFee(shares, price, feeRate = 0.07) {
  const size = Math.max(0, finite(shares));
  const p = Math.min(1, Math.max(0, finite(price)));
  return round(size * Math.max(0, finite(feeRate, 0.07)) * p * (1 - p), 6);
}

export function resolveMarketFeeRate(market = {}, fallback = 0.07) {
  let schedule = market?.feeSchedule;
  if (typeof schedule === 'string') {
    try {
      schedule = JSON.parse(schedule);
    } catch {
      schedule = null;
    }
  }
  const rate = Number(schedule?.rate);
  return Number.isFinite(rate) && rate >= 0 ? rate : Math.max(0, finite(fallback, 0.07));
}

/** @deprecated Use resolveMarketFeeRate */
export const resolvePlan7MarketFeeRate = resolveMarketFeeRate;

export function eventCategory(event = {}) {
  const tags = (Array.isArray(event.tags) ? event.tags : [])
    .map((tag) => String(tag?.slug || tag?.label || '').toLowerCase());
  const text = [event.category, event.title, ...tags].filter(Boolean).join(' ').toLowerCase();
  if (tags.includes('weather') || /temperature|weather/.test(text)) return 'weather';
  if (tags.includes('sports') || /sports|soccer|baseball|basketball|football|tennis|fifa|nba|mlb|nfl|nhl/.test(text)) {
    return 'sports';
  }
  if (/crypto|bitcoin|ethereum|solana|xrp/.test(text)) return 'crypto';
  if (/politics|election|geopolitics/.test(text)) return 'politics';
  if (/economy|economic|finance|fed|business/.test(text)) return 'economics';
  if (/pop-culture|culture|entertainment/.test(text)) return 'culture';
  return 'other';
}

export function buildNegativeRiskCatalog(events = []) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.closed !== true && event?.active !== false)
    .filter((event) => event?.negRisk === true || String(event?.negRisk).toLowerCase() === 'true')
    .filter((event) => event?.negRiskAugmented !== true && String(event?.negRiskAugmented).toLowerCase() !== 'true')
    .map((event) => {
      const sourceMarkets = Array.isArray(event.markets) ? event.markets : [];
      const markets = sourceMarkets
        .map((market) => {
          if (market?.closed === true || market?.active === false) return null;
          if (market?.acceptingOrders === false || market?.enableOrderBook === false) return null;
          const parsed = parseMarketOutcomes(market);
          if (!parsed.upTokenId || !parsed.downTokenId) return null;
          return {
            eventSlug: event.slug || String(event.id || ''),
            eventTitle: event.title || 'Negative risk event',
            marketSlug: market.slug || String(market.conditionId || ''),
            marketTitle: market.question || market.groupItemTitle || market.slug || 'Event outcome',
            groupItemTitle: market.groupItemTitle || market.question || '',
            conditionId: market.conditionId || market.condition_id || null,
            endDate: market.endDate || event.endDate || null,
            yesTokenId: parsed.upTokenId,
            noTokenId: parsed.downTokenId,
            feeSchedule: market.feeSchedule || null,
            market
          };
        })
        .filter(Boolean);
      if (sourceMarkets.length < 2 || markets.length !== sourceMarkets.length) return null;
      return {
        eventSlug: event.slug || String(event.id || ''),
        title: event.title || 'Negative risk event',
        category: eventCategory(event),
        endDate: event.endDate || null,
        volume: finite(event.volume),
        liquidity: finite(event.liquidity),
        markets
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.volume - a.volume);
}

/**
 * Cached Gamma negative-risk event catalog for Plan3 weather/sports branches.
 */
export function createNegativeRiskCatalogProvider(client, {
  limit = 300,
  refreshMs = 60000,
  categories = null
} = {}) {
  let cache = [];
  let refreshAt = 0;
  const allowed = Array.isArray(categories) && categories.length
    ? new Set(categories.map((category) => String(category || '').toLowerCase()))
    : null;

  return async function negativeRiskCatalogProvider() {
    const now = Date.now();
    if (!cache.length || now >= refreshAt) {
      const events = typeof client?.getActiveNegativeRiskEvents === 'function'
        ? await client.getActiveNegativeRiskEvents({ limit })
        : typeof client?.getActiveWeatherEvents === 'function'
          ? await client.getActiveWeatherEvents({ limit })
          : [];
      cache = buildNegativeRiskCatalog(events);
      refreshAt = now + Math.max(5000, Number(refreshMs) || 60000);
    }
    return allowed
      ? cache.filter((event) => allowed.has(event.category))
      : cache;
  };
}
