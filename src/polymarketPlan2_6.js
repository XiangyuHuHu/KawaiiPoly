/**
 * Plan2.6 — Plan2.5 architecture with a tighter entry allowlist.
 *
 * Primary edge: sustained_momentum
 * Optional: late_capture only when strict (entry ≥ lateMin, default 0.90)
 * Hard skip: standard / cross_follow / settlement_capture_90 / ultra_late (~0.99)
 * Hard cap: reject entries above entryHardMax (default 0.92)
 *
 * Exit: paper may hold to settlement; live keeps hard SL even if SYNC_PAPER_EXIT is on.
 */

export const PLAN2_6_ID = 'plan2_6';
export const PLAN2_6_VERSION = 'plan2_6_v1_momentum_strict_late';

export const PLAN2_6_PRIMARY_ENTRY_TYPES = new Set(['sustained_momentum']);
export const PLAN2_6_CONDITIONAL_ENTRY_TYPES = new Set(['late_capture']);
export const PLAN2_6_HARD_SKIP_ENTRY_TYPES = new Set([
  'standard',
  'cross_follow',
  'settlement_capture_90',
  'ultra_late_capture',
  'probe',
  'main',
  'opposite_hedge',
  'stop_loss_reversal'
]);

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Profile overlays applied on top of Plan2.5 enhanced defaults.
 * Explicit POLYMARKET_PLAN2_6_* env keys win via config.
 */
export function resolvePlan26ProfileOverrides(config = {}) {
  const lateMin = num(config.plan2_6LateCaptureMinPrice, 0.90);
  const lateMax = num(config.plan2_6LateCaptureMaxPrice, 0.90);
  const entryHardMax = num(config.plan2_6EntryHardMaxPrice, 0.92);
  // Chase/signal ceiling for Plan2.6 only. Defaults to hard max so legacy
  // POLYMARKET_PLAN2_ENTRY_MAX_PRICE=0.62 cannot kill mid-band momentum favorites.
  const entryMax = Math.min(entryHardMax, num(config.plan2_6EntryMaxPrice, 0.90));
  const momentumMax = Math.min(entryMax, num(config.plan2_6SustainedMomentumMaxPrice, 0.90));
  return {
    // Kill weak / lottery-inverse lanes at the config level (defense in depth).
    plan2SettlementCapture90Enabled: false,
    plan2UltraLateCaptureEnabled: false,
    plan2CrossFollowEnabled: false,
    plan2ProbeEnabled: false,
    plan2LiveProbeEnabled: false,
    // Strict late: only high-certainty ≥ lateMin; band capped below ~99¢.
    plan2LateCaptureEnabled: config.plan2_6LateCaptureEnabled !== false,
    plan2LateCaptureMinPrice: lateMin,
    plan2LateCaptureMaxPrice: Math.min(lateMax, entryHardMax),
    // Plan2.6-specific caps (do not loosen Plan2.5 shared plan2EntryMaxPrice).
    plan2EntryMaxPrice: entryMax,
    plan2PaperEntryMaxPrice: num(config.plan2_6PaperEntryMaxPrice, entryMax),
    plan2SustainedMomentumMaxPrice5m: num(config.plan2_6SustainedMomentumMaxPrice5m, momentumMax),
    plan2SustainedMomentumMaxPrice15m: num(config.plan2_6SustainedMomentumMaxPrice15m, momentumMax),
    plan2PaperSustainedMomentumMaxPrice5m: num(
      config.plan2_6PaperSustainedMomentumMaxPrice5m,
      momentumMax
    ),
    plan2PaperSustainedMomentumMaxPrice15m: num(
      config.plan2_6PaperSustainedMomentumMaxPrice15m,
      momentumMax
    ),
    plan2_6EntryHardMaxPrice: entryHardMax,
    plan2_6EntryMaxPrice: entryMax,
    plan2_6LateCaptureMinPrice: lateMin,
    plan2_6LateCaptureSoftMode: config.plan2_6LateCaptureSoftMode === true,
    plan2_6LateCaptureSoftSizeScale: num(config.plan2_6LateCaptureSoftSizeScale, 0.35),
    plan2_6AllowEntryTypes: config.plan2_6AllowEntryTypes || ['sustained_momentum', 'late_capture'],
    _plan2Profile: PLAN2_6_ID,
    _plan26PolicyEnabled: true
  };
}

/**
 * Decide whether a chosen Plan2 entry type/price is allowed under Plan2.6.
 */
export function evaluatePlan26EntryPolicy({
  entryType,
  entryPrice,
  config = {}
} = {}) {
  const type = String(entryType || '').toLowerCase();
  const price = Number(entryPrice);
  const lateMin = num(config.plan2_6LateCaptureMinPrice ?? config.plan2LateCaptureMinPrice, 0.90);
  const entryHardMax = num(config.plan2_6EntryHardMaxPrice, 0.92);
  const softMode = config.plan2_6LateCaptureSoftMode === true;
  const softScale = Math.max(0.05, Math.min(1, num(config.plan2_6LateCaptureSoftSizeScale, 0.35)));
  const allowList = Array.isArray(config.plan2_6AllowEntryTypes)
    ? config.plan2_6AllowEntryTypes.map((item) => String(item || '').toLowerCase())
    : ['sustained_momentum', 'late_capture'];
  const allowSet = new Set(allowList);

  if (!type) {
    return { allowed: false, reason: 'missing entryType', entryType: type, sizeScale: 0 };
  }

  if (PLAN2_6_HARD_SKIP_ENTRY_TYPES.has(type) || !allowSet.has(type)) {
    return {
      allowed: false,
      reason: `hard-skip entryType=${type}`,
      entryType: type,
      sizeScale: 0
    };
  }

  if (Number.isFinite(price) && price > entryHardMax) {
    return {
      allowed: false,
      reason: `entry price ${price.toFixed(3)} above hard max ${entryHardMax.toFixed(2)} (avoid ~99¢ lottery-inverse)`,
      entryType: type,
      sizeScale: 0,
      entryHardMax
    };
  }

  if (type === 'sustained_momentum') {
    return {
      allowed: true,
      reason: 'primary edge sustained_momentum',
      entryType: type,
      sizeScale: 1,
      lane: 'primary'
    };
  }

  if (type === 'late_capture') {
    if (!Number.isFinite(price)) {
      return { allowed: false, reason: 'late_capture missing entry price', entryType: type, sizeScale: 0 };
    }
    if (price >= lateMin) {
      return {
        allowed: true,
        reason: `strict late_capture price ${price.toFixed(3)} ≥ ${lateMin.toFixed(2)}`,
        entryType: type,
        sizeScale: 1,
        lane: 'strict_late'
      };
    }
    if (softMode) {
      return {
        allowed: true,
        reason: `soft late_capture price ${price.toFixed(3)} < ${lateMin.toFixed(2)}; size×${softScale}`,
        entryType: type,
        sizeScale: softScale,
        lane: 'soft_late'
      };
    }
    return {
      allowed: false,
      reason: `weak late_capture price ${price.toFixed(3)} < ${lateMin.toFixed(2)} hard-skipped`,
      entryType: type,
      sizeScale: 0,
      lane: 'weak_late_rejected'
    };
  }

  return {
    allowed: false,
    reason: `entryType=${type} not in Plan2.6 allowlist`,
    entryType: type,
    sizeScale: 0
  };
}

/**
 * Apply Plan2.6 policy to a Plan2 action object (skip or size-down).
 */
export function applyPlan26EntryPolicy(action, config = {}, planLabel = 'Plan2.6') {
  if (!action) return action;
  const trading = action.shouldTrade === true || action.scheduleDelayedEntry === true;
  if (!trading) return action;

  const entryType = action.entryType || action.tier || null;
  const entryPrice = Number(
    action.limitPrice
    ?? action.price
    ?? action.tokenPrice
    ?? action?.tier?.limitPrice
  );
  const decision = evaluatePlan26EntryPolicy({ entryType, entryPrice, config });

  if (decision.allowed) {
    if (Number.isFinite(decision.sizeScale) && decision.sizeScale > 0 && decision.sizeScale < 1) {
      const usd = Number(action.usd);
      const nextUsd = Number.isFinite(usd) && usd > 0 ? round2(usd * decision.sizeScale) : action.usd;
      const prevMult = Number(action.sizeMultiplier);
      return {
        ...action,
        usd: nextUsd,
        sizeMultiplier: Number.isFinite(prevMult) ? round2(prevMult * decision.sizeScale) : decision.sizeScale,
        plan26Policy: decision
      };
    }
    return { ...action, plan26Policy: decision };
  }

  return {
    shouldTrade: false,
    scheduleDelayedEntry: false,
    clearDelayedEntry: action.clearDelayedEntry === true,
    delayedEntryKey: action.delayedEntryKey || null,
    entryType: String(entryType || '').toLowerCase() || null,
    limitPrice: Number.isFinite(entryPrice) ? entryPrice : null,
    reason: `${planLabel} 收紧过滤：${decision.reason}`,
    plan26Policy: decision
  };
}

export function buildPlan26RulesSnapshot(config = {}) {
  const overrides = resolvePlan26ProfileOverrides(config);
  return {
    enabled: config.plan2_6Enabled !== false,
    liveEnabled: config.plan2_6LiveEnabled === true,
    strategyVersion: PLAN2_6_VERSION,
    primaryEntryTypes: [...PLAN2_6_PRIMARY_ENTRY_TYPES],
    conditionalEntryTypes: [...PLAN2_6_CONDITIONAL_ENTRY_TYPES],
    hardSkipEntryTypes: [...PLAN2_6_HARD_SKIP_ENTRY_TYPES],
    lateCaptureMinPrice: overrides.plan2_6LateCaptureMinPrice,
    lateCaptureMaxPrice: overrides.plan2LateCaptureMaxPrice,
    lateCaptureSoftMode: overrides.plan2_6LateCaptureSoftMode === true,
    lateCaptureSoftSizeScale: overrides.plan2_6LateCaptureSoftSizeScale,
    entryMaxPrice: overrides.plan2_6EntryMaxPrice,
    entryHardMaxPrice: overrides.plan2_6EntryHardMaxPrice,
    sustainedMomentumMaxPrice: overrides.plan2SustainedMomentumMaxPrice15m,
    paperTimeframes: ['5m', '15m'],
    liveTimeframes: ['5m', '15m'],
    exitMode: (config.plan26LiveSyncPaperExitEnabled === true)
      ? 'hold_to_settlement_with_live_hard_sl'
      : 'tp_sl',
    liveSyncPaperExit: config.plan26LiveSyncPaperExitEnabled === true,
    liveEntryMaxEnabled: config.plan2_6LiveEntryMaxEnabled !== false,
    note: 'Clone of Plan2.5 infra; live safe defaults: entry max ~0.90, hard max ~0.92, hard SL on (SYNC_PAPER_EXIT no longer disables SL). Do not stack with plan2_5.'
  };
}
