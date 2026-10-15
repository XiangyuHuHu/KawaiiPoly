import { parseJsonArray } from './polymarketClient.js';
import { PLAN20_SEGMENT_RULES } from './plan20SegmentRules.js';

export { PLAN20_SEGMENT_RULES };
export const PLAN20_ID = 'plan20';
export const PLAN20_VERSION = 'plan20_settled_segments_v1';
export const PLAN20_ENTRY_ADAPTER = 'plan20_paper_price_hour_v1';
export const PLAN20_DEFAULTS = Object.freeze({
  startingCash: 500,
  orderUsd: 2,
  maxOpen: 40,
  cashFloor: 10,
  maxTradePct: 0.05,
  maxExposurePct: 0.30
});
// Gamma price is only a prescreen. The fill uses the book ask, which can sit a few cents away.
export const PLAN20_BOOK_PRESCREEN = Object.freeze({ min: 0.15, max: 0.45 });
const FEATURES = new Set(['plan_id', 'category', 'price', 'direction', 'timeframe', 'resolution', 'symbol', 'hour']);

// Only explicit entry-observable features can match; absent features fail closed.
export function matchesPlan20Rule(features, rule) {
  rule = rule?.match ?? rule;
  return !!features && !!rule && Object.keys(rule).length > 0
    && Object.entries(rule).every(([key, value]) => FEATURES.has(key)
      && Object.hasOwn(features, key) && features[key] !== 'unknown' && features[key] === value);
}

// Same bucketing as scripts/mine-settled-segments.mjs.
export function plan20EntryFeatures({ entryPrice, entryTimeMs } = {}) {
  const p = Number(entryPrice);
  const t = Number(entryTimeMs);
  const bands = [[.2, '0-.20'], [.35, '.20-.35'], [.5, '.35-.50'], [.65, '.50-.65'], [.8, '.65-.80']];
  const price = Number.isFinite(p) ? (bands.find(([edge]) => p < edge)?.[1] ?? '.80+') : 'unknown';
  const h = Number.isFinite(t) ? Math.floor(new Date(t).getUTCHours() / 4) * 4 : null;
  return { price, hour: h === null ? 'unknown' : `${h}-${h + 4}` };
}

export function evaluatePlan20Candidate({ features, mode = 'paper' } = {}) {
  if (mode !== 'paper') return { ok: false, reason: 'paper_only' };
  if (!PLAN20_SEGMENT_RULES.length) return { ok: false, reason: 'no_surviving_segments' };
  const rule = PLAN20_SEGMENT_RULES.find((item) => matchesPlan20Rule(features, item));
  return rule ? { ok: true, rule } : { ok: false, reason: 'no_matching_segment' };
}

export function plan20Stake({ cash, startingCash = 500, exposure = 0, openCount = 0, ...options } = {}) {
  const cfg = { ...PLAN20_DEFAULTS, ...options };
  if (![cash, startingCash, exposure, openCount, cfg.orderUsd, cfg.maxOpen, cfg.cashFloor, cfg.maxTradePct, cfg.maxExposurePct].every(Number.isFinite)
    || cash < 0 || startingCash <= 0 || exposure < 0 || openCount < 0 || cfg.maxOpen <= 0
    || cfg.cashFloor < 0 || cfg.maxTradePct < 0 || cfg.maxTradePct > 1 || cfg.maxExposurePct < 0 || cfg.maxExposurePct > 1
    || openCount >= cfg.maxOpen) return 0;
  const usd = Math.floor(Math.max(0, Math.min(cfg.orderUsd, cash - cfg.cashFloor, startingCash * cfg.maxTradePct, startingCash * cfg.maxExposurePct - exposure)) * 100 + 1e-8) / 100;
  return usd >= 1 ? usd : 0;
}

export function plan20BookAsk(book) {
  const ask = Number(book?.bestAsk ?? book?.ask);
  return ask > 0 && ask < 1 ? ask : null;
}

function list(value) {
  return parseJsonArray(value);
}

// Active Gamma events, the same discovery source Plan15 uses. One quote per outcome.
export function plan20QuotesFromGamma(rows = []) {
  const quotes = [];
  for (const row of rows || []) {
    const market = row?.market && typeof row.market === 'object' ? row.market : row;
    if (!market || typeof market !== 'object') continue;
    if (market.closed === true || market.active === false || market.acceptingOrders === false) continue;
    const outcomes = list(market.outcomes).map(String);
    const prices = list(market.outcomePrices).map(Number);
    const tokenIds = list(market.clobTokenIds).map(String);
    const slug = String(market.slug || row?.event?.slug || '');
    if (!slug || !outcomes.length) continue;
    outcomes.forEach((outcome, index) => {
      const gamma = prices[index];
      if (!Number.isFinite(gamma)) return;
      quotes.push({
        marketSlug: slug,
        conditionId: market.conditionId || null,
        tokenId: tokenIds[index] || '',
        outcome,
        entryPrice: gamma,
        gammaPrice: gamma,
        title: market.question || row?.event?.title || slug,
        endDate: market.endDate || row?.event?.endDate || null,
        categoryId: row?.categoryId || null,
        symbol: row?.symbol || row?.categoryId || 'event',
        timeframe: row?.timeframe || 'event'
      });
    });
  }
  return quotes;
}

// Drop quotes whose book has no ask. Entry price becomes that ask, not the Gamma print.
export function plan20ExecutableQuotes(quotes = [], booksByToken = new Map()) {
  const executable = [];
  for (const quote of quotes || []) {
    const gamma = Number(quote?.gammaPrice ?? quote?.entryPrice);
    if (!(gamma >= PLAN20_BOOK_PRESCREEN.min && gamma < PLAN20_BOOK_PRESCREEN.max)) continue;
    const ask = plan20BookAsk(booksByToken.get(String(quote?.tokenId || '')));
    if (ask == null || !quote?.tokenId || !quote?.marketSlug) continue;
    executable.push({ ...quote, entryPrice: ask });
  }
  return executable;
}

function quotesFromScanMarkets(markets = []) {
  const quotes = [];
  for (const row of markets || []) {
    if (!row || typeof row !== 'object') continue;
    if (row.market || row.outcomes || row.outcomePrices) {
      quotes.push(...plan20QuotesFromGamma([row]));
      continue;
    }
    const entryPrice = Number(row.entryPrice ?? row.ask);
    if (!Number.isFinite(entryPrice)) continue;
    quotes.push({
      marketSlug: String(row.marketSlug || ''),
      conditionId: row.conditionId || null,
      tokenId: row.tokenId ? String(row.tokenId) : '',
      outcome: String(row.outcome || ''),
      entryPrice,
      title: row.title || row.marketSlug || '',
      endDate: row.endDate || null,
      categoryId: row.categoryId || null,
      symbol: row.symbol || row.categoryId || 'event',
      timeframe: row.timeframe || 'event'
    });
  }
  return quotes;
}

// Reviewed paper entry adapter: price band [0.20, 0.35) and UTC hour bucket 12-16 only.
export function selectPlan20PaperEntries({
  markets = [],
  nowMs = Date.now(),
  cash,
  startingCash = PLAN20_DEFAULTS.startingCash,
  exposure = 0,
  openCount = 0,
  heldKeys = [],
  mode = 'paper',
  ...stakeOptions
} = {}) {
  if (mode !== 'paper') return { entries: [], bought: 0, reason: 'paper_only' };
  if (!PLAN20_SEGMENT_RULES.length) return { entries: [], bought: 0, reason: 'no_surviving_segments' };
  const held = new Set((heldKeys || []).map(String));
  const entries = [];
  let nextCash = Number(cash);
  let nextExposure = Number(exposure);
  let nextOpen = Number(openCount);
  for (const quote of quotesFromScanMarkets(markets)) {
    if (!quote.marketSlug || !quote.tokenId) continue;
    const tokenKey = String(quote.tokenId);
    const outcomeKey = `${quote.marketSlug}:${quote.outcome}`;
    if (held.has(tokenKey) || held.has(outcomeKey)) continue;
    const features = plan20EntryFeatures({ entryPrice: quote.entryPrice, entryTimeMs: nowMs });
    const decision = evaluatePlan20Candidate({ features, mode: 'paper' });
    if (!decision.ok) continue;
    const usd = plan20Stake({
      cash: nextCash,
      startingCash,
      exposure: nextExposure,
      openCount: nextOpen,
      ...stakeOptions
    });
    if (!(usd >= 1)) {
      if (!entries.length) return { entries, bought: 0, reason: 'capped' };
      break;
    }
    entries.push({
      ...quote,
      usd,
      features,
      ruleId: decision.rule.id || null,
      mode: 'paper'
    });
    held.add(tokenKey);
    held.add(outcomeKey);
    nextCash -= usd;
    nextExposure += usd;
    nextOpen += 1;
  }
  return {
    entries,
    bought: entries.length,
    reason: entries.length ? 'matched' : 'no_matching_segment'
  };
}
