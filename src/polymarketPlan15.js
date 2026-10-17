import { parseJsonArray } from './polymarketClient.js';
import { isShortWindowCryptoUpDown } from './polymarketCatalog.js';

export const PLAN15_ID = 'plan15';
export const PLAN15_VERSION = 'plan15_esports_macro_055_070_v3';

/** 2026-10-18 review: esports and macro (catalog id `finance`) only. */
export const PLAN15_TIGHT_CATEGORIES = Object.freeze(['esports', 'finance']);
export const PLAN15_TIGHT_MIN_PRICE = 0.55;
export const PLAN15_TIGHT_MAX_PRICE = 0.70;
export const PLAN15_PAUSED_CATEGORIES = Object.freeze(['weather']);

export function normalizePlan15Category(categoryId) {
  const id = String(categoryId || '').trim().toLowerCase();
  return id === 'macro' ? 'finance' : id;
}

export function plan15CategoryPaused(categoryId, paused = PLAN15_PAUSED_CATEGORIES) {
  const id = normalizePlan15Category(categoryId);
  const list = Array.isArray(paused) ? paused : PLAN15_PAUSED_CATEGORIES;
  return list.map((item) => normalizePlan15Category(item)).includes(id);
}

/**
 * Other categories keep the caller band (default 0.40–0.70).
 * Esports and macro are tightened to about 0.55–0.70 and cannot be widened past that.
 */
export function plan15CategoryBand(categoryId, {
  minPrice = 0.40,
  maxPrice = 0.70,
  tightMinPrice = PLAN15_TIGHT_MIN_PRICE,
  tightMaxPrice = PLAN15_TIGHT_MAX_PRICE,
  tightCategories = PLAN15_TIGHT_CATEGORIES
} = {}) {
  const id = normalizePlan15Category(categoryId);
  const tightIds = (Array.isArray(tightCategories) ? tightCategories : PLAN15_TIGHT_CATEGORIES)
    .map((item) => normalizePlan15Category(item));
  const floor = Number(minPrice);
  const ceiling = Number(maxPrice);
  const min = Number.isFinite(floor) ? floor : 0.40;
  const max = Number.isFinite(ceiling) ? ceiling : 0.70;
  if (!tightIds.includes(id)) return { minPrice: min, maxPrice: max };
  const tightMin = Number(tightMinPrice);
  const tightMax = Number(tightMaxPrice);
  const nextMin = Math.max(
    min,
    PLAN15_TIGHT_MIN_PRICE,
    Number.isFinite(tightMin) ? tightMin : PLAN15_TIGHT_MIN_PRICE
  );
  const nextMax = Math.min(
    max,
    PLAN15_TIGHT_MAX_PRICE,
    Number.isFinite(tightMax) ? tightMax : PLAN15_TIGHT_MAX_PRICE
  );
  return {
    minPrice: Math.min(nextMin, PLAN15_TIGHT_MAX_PRICE),
    maxPrice: Math.max(Math.min(nextMin, PLAN15_TIGHT_MAX_PRICE), nextMax)
  };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function list(value) {
  return parseJsonArray(value).map((item) => item);
}

/**
 * 事件盘只买领先结果，而且要买得起、卖得掉、两天内能结算。
 * 90¢ 以上的热门和更久才结束的市场不进这个模拟账本。
 */
export function evaluatePlan15Candidate({
  market = null,
  event = null,
  categoryId = '',
  now = Date.now(),
  minPrice = 0.40,
  maxPrice = 0.70,
  tightMinPrice = PLAN15_TIGHT_MIN_PRICE,
  tightMaxPrice = PLAN15_TIGHT_MAX_PRICE,
  tightCategories = PLAN15_TIGHT_CATEGORIES,
  pausedCategories = PLAN15_PAUSED_CATEGORIES,
  maxSpread = 0.05,
  maxDays = 2,
  minVolume24hr = 1000,
  book = null
} = {}) {
  if (!market || typeof market !== 'object') {
    return { ok: false, reason: 'missing_market' };
  }
  if (plan15CategoryPaused(categoryId, pausedCategories)) {
    return { ok: false, reason: 'category_paused' };
  }
  const band = plan15CategoryBand(categoryId, {
    minPrice,
    maxPrice,
    tightMinPrice,
    tightMaxPrice,
    tightCategories
  });
  minPrice = band.minPrice;
  maxPrice = band.maxPrice;
  if (categoryId === 'crypto' && isShortWindowCryptoUpDown(event || market)) {
    return { ok: false, reason: 'short_window_crypto' };
  }
  if (market.closed === true || market.active === false || market.acceptingOrders === false) {
    return { ok: false, reason: 'not_open' };
  }
  const outcomes = list(market.outcomes).map(String);
  const prices = list(market.outcomePrices).map((price) => finite(price));
  const tokenIds = list(market.clobTokenIds).map(String);
  if (outcomes.length < 2 || prices.length !== outcomes.length) {
    return { ok: false, reason: 'missing_outcomes' };
  }
  let leader = -1;
  for (let index = 0; index < prices.length; index += 1) {
    const price = prices[index];
    if (price == null) continue;
    if (leader < 0 || price > prices[leader]) leader = index;
  }
  if (leader < 0 || !tokenIds[leader]) {
    return { ok: false, reason: 'missing_token' };
  }
  const endMs = Date.parse(market.endDate || event?.endDate || '');
  const days = (endMs - now) / 86_400_000;
  if (!Number.isFinite(endMs) || !(days > 0.05 && days <= maxDays)) {
    return { ok: false, reason: 'horizon' };
  }
  const volume = finite(market.volume24hr) ?? finite(event?.volume24hr) ?? finite(event?.volume) ?? 0;
  if (volume + 1e-9 < minVolume24hr) {
    return { ok: false, reason: 'thin_volume' };
  }
  const gammaPrice = prices[leader];
  if (gammaPrice + 1e-9 < minPrice || gammaPrice - 1e-9 > maxPrice) {
    return { ok: false, reason: 'price_out_of_range' };
  }
  const base = {
    outcome: outcomes[leader],
    tokenId: tokenIds[leader],
    gammaPrice,
    endDate: new Date(endMs).toISOString(),
    marketSlug: String(market.slug || ''),
    conditionId: market.conditionId || null,
    volume24hr: volume
  };
  if (!base.marketSlug) return { ok: false, reason: 'missing_slug' };
  if (!book) return { ok: true, stage: 'prescreen', ...base };
  const bid = finite(book.bestBid);
  const ask = finite(book.bestAsk);
  if (bid == null || ask == null || ask <= bid) {
    return { ok: false, reason: 'incomplete_book', ...base };
  }
  if (ask - bid > maxSpread + 1e-9) {
    return { ok: false, reason: 'wide_spread', ask, bid, ...base };
  }
  if (ask + 1e-9 < minPrice || ask - 1e-9 > maxPrice) {
    return { ok: false, reason: 'price_out_of_range', ask, bid, ...base };
  }
  return { ok: true, stage: 'book', ask, bid, spread: ask - bid, ...base };
}
