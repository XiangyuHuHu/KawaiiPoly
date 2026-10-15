import { PLAN20_SEGMENT_RULES } from './plan20SegmentRules.js';
export { PLAN20_SEGMENT_RULES };
export const PLAN20_ID = 'plan20';
export const PLAN20_VERSION = 'plan20_settled_segments_v1';
export const PLAN20_DEFAULTS = Object.freeze({ startingCash: 500, orderUsd: 2, maxOpen: 40, cashFloor: 10, maxTradePct: .05, maxExposurePct: .30 });
const FEATURES = new Set(['plan_id', 'category', 'price', 'direction', 'timeframe', 'resolution', 'symbol', 'hour']);

// Only explicit entry-observable features can match; absent features fail closed.
export function matchesPlan20Rule(features, rule) {
  return !!features && !!rule && Object.keys(rule).length > 0
    && Object.entries(rule).every(([key, value]) => FEATURES.has(key)
      && Object.hasOwn(features, key) && features[key] !== 'unknown' && features[key] === value);
}
export function evaluatePlan20Candidate({ features, mode = 'paper' } = {}) {
  if (mode !== 'paper') return { ok: false, reason: 'paper_only' };
  if (!PLAN20_SEGMENT_RULES.length) return { ok: false, reason: 'no_surviving_segments' };
  const rule = PLAN20_SEGMENT_RULES.find(rule => matchesPlan20Rule(features, rule));
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
// There are no approved discovery sources when the mined rule set is empty.
// Do not borrow the divination selectors or invent a replacement strategy.
export function plan20ScanDecision() {
  return { bought: 0, reason: PLAN20_SEGMENT_RULES.length ? 'entry_adapter_required' : 'no_surviving_segments' };
}
