import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';
import { getWindowTrackSnapshot } from './polymarketWindowTrack.js';
import { evaluateLossReasonGate } from './lossReasonGate.js';

export const PLAN3_VERSION = 'plan3_execution_v4';

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function buildPlan3SlotKey(slotIso, timeframe, direction = null, symbol = null) {
  const coin = symbol ? `_${String(symbol).toUpperCase().replace(/-USD$/, '')}` : '';
  const base = `${slotIso || 'unknown'}${coin}_${timeframe}_plan3`;
  return direction ? `${base}_${direction}` : base;
}

export function isPlan3PaperTrading(config = {}) {
  return config.plan3LiveEnabled !== true;
}

export function isPlan3LiveWideBandEnabled(config = {}) {
  return isPlan3WideBandRuntimeEnabled(config);
}

export function isPlan3WideBandRuntimeEnabled(config = {}) {
  if (config.plan3LiveEnabled === true) {
    return config.plan3LiveWideBandEnabled !== false;
  }
  return isPlan3PaperTrading(config)
    && config.plan3PaperRelaxedEnabled !== false
    && config.plan3PaperWideBandEnabled !== false;
}

function buildPlan3RelaxedWideBase(config = {}) {
  return {
    ...config,
    plan3PaperMode: true,
    plan3PaperWideBand: true,
    plan3MinDistanceBps5m: Number(config.plan3PaperMinDistanceBps5m ?? 2),
    plan3MinDistanceBps15m: Number(config.plan3PaperMinDistanceBps15m ?? 3),
    plan3PaperMinDirectionalBps: Number(config.plan3PaperMinDirectionalBps ?? 0.5),
    plan3MinMarketQuality: Number(config.plan3PaperMinMarketQuality ?? 0.45),
    plan3MaxSpread: Number(config.plan3PaperMaxSpread ?? 0.03),
    plan3PaperUsePmLeadingPrice: config.plan3PaperUsePmLeadingPrice !== false,
    plan3BandStatsGateEnabled: config.plan3PaperBandStatsGateEnabled !== false,
    plan3DynamicSettlementEnabled: config.plan3PaperDynamicSettlementEnabled === true,
    plan3MinOrderUsd: Number(config.plan3PaperMinOrderUsd ?? config.plan3MinOrderUsd ?? 1),
    plan3MaxOrderPct: Number(config.plan3PaperMaxOrderPct ?? config.plan3MaxOrderPct ?? 0.05)
  };
}

function buildPlan3WideBandRuntime(base, config = {}) {
  const live = config.plan3LiveEnabled === true;
  return {
    ...base,
    plan3PaperWideBand: true,
    plan3MinPrice: Number(live
      ? (config.plan3LiveWideMinPrice ?? 0.93)
      : (config.plan3PaperWideMinPrice ?? 0.93)),
    plan3MaxPrice: Number(live
      ? (config.plan3LiveWideMaxPrice ?? config.plan3MaxPrice ?? 0.99)
      : (config.plan3PaperWideMaxPrice ?? 0.998)),
    plan3MinSecondsRemaining5m: Number(live
      ? (config.plan3LiveWideMinSecondsRemaining5m ?? 20)
      : (config.plan3PaperWideMinSecondsRemaining5m ?? config.plan3MinSecondsRemaining5m ?? 12)),
    plan3MaxSecondsRemaining5m: Number(live
      ? (config.plan3LiveWideMaxSecondsRemaining5m ?? 120)
      : (config.plan3PaperWideMaxSecondsRemaining5m ?? 120)),
    plan3MinSecondsRemaining15m: Number(live
      ? (config.plan3LiveWideMinSecondsRemaining15m ?? 30)
      : (config.plan3PaperWideMinSecondsRemaining15m ?? config.plan3MinSecondsRemaining15m ?? 12)),
    plan3MaxSecondsRemaining15m: Number(live
      ? (config.plan3LiveWideMaxSecondsRemaining15m ?? 180)
      : (config.plan3PaperWideMaxSecondsRemaining15m ?? 180)),
    plan3MaxReverseBps: Number(live
      ? (config.plan3LiveWideMaxReverseBps ?? config.plan3PaperWideMaxReverseBps ?? 4)
      : (config.plan3PaperWideMaxReverseBps ?? 4)),
    plan3MaxSpread: Number(live
      ? (config.plan3LiveWideMaxSpread ?? config.plan3PaperWideMaxSpread ?? 0.08)
      : (config.plan3PaperWideMaxSpread ?? 0.08)),
    plan3PaperUsePmLeadingPrice: config.plan3PaperUsePmLeadingPrice !== false,
    plan3PaperWideSkipSpreadCheck: config.plan3PaperWideSkipSpreadCheck === true
  };
}

export function resolvePlan3RuntimeConfig(config = {}) {
  if (isPlan3WideBandRuntimeEnabled(config)) {
    return buildPlan3WideBandRuntime(buildPlan3RelaxedWideBase(config), config);
  }

  if (!isPlan3PaperTrading(config) || config.plan3PaperRelaxedEnabled === false) {
    return { ...config, plan3PaperMode: false, plan3PaperWideBand: false };
  }

  const base = {
    ...config,
    plan3PaperMode: true,
    plan3PaperWideBand: false,
    plan3MaxSecondsRemaining5m: Number(config.plan3PaperMaxSecondsRemaining5m ?? 45),
    plan3MaxSecondsRemaining15m: Number(config.plan3PaperMaxSecondsRemaining15m ?? 90),
    plan3MinDistanceBps5m: Number(config.plan3PaperMinDistanceBps5m ?? 2),
    plan3MinDistanceBps15m: Number(config.plan3PaperMinDistanceBps15m ?? 3),
    plan3PaperMinDirectionalBps: Number(config.plan3PaperMinDirectionalBps ?? 0.5),
    plan3MinMarketQuality: Number(config.plan3PaperMinMarketQuality ?? 0.45),
    plan3MaxSpread: Number(config.plan3PaperMaxSpread ?? 0.03),
    plan3PaperUsePmLeadingPrice: config.plan3PaperUsePmLeadingPrice !== false
  };

  return {
    ...base,
    plan3MinPrice: Number(config.plan3PaperMinPrice ?? 0.85)
  };
}

export function resolvePlan3MaxSpreadForEntry({ tokenPrice, config = {} }) {
  const price = Number(tokenPrice);
  if (!config.plan3PaperWideBand) {
    return Number(config.plan3MaxSpread) || 0.01;
  }
  const tight = Number(config.plan3PaperMaxSpread) || 0.03;
  const wide = Number(config.plan3PaperWideMaxSpread) || 0.08;
  if (!Number.isFinite(price)) return wide;
  if (price >= 0.99) return tight;
  if (price >= 0.96) return Math.max(tight, Number(config.plan3PaperWideMidSpread) || 0.06);
  return wide;
}

export function resolvePlan3MaxReverseBpsForEntry({ tokenPrice, config = {} }) {
  const base = Number(config.plan3MaxReverseBps) || 2;
  if (!config.plan3PaperWideBand) return base;
  const price = Number(tokenPrice);
  if (!Number.isFinite(price) || price >= 0.99) return base;
  return Number(config.plan3PaperWideMaxReverseBps) || 4;
}

export function resolvePlan3EntrySpread({ sentiment = {}, direction = null }) {
  const directionalSpread = direction === 'up'
    ? Number(sentiment.upSpread ?? sentiment.upBookSpread)
    : direction === 'down'
      ? Number(sentiment.downSpread ?? sentiment.downBookSpread)
      : NaN;
  if (Number.isFinite(directionalSpread)) return directionalSpread;

  const upPrice = Number(sentiment.upPrice);
  const downPrice = Number(sentiment.downPrice);
  const binaryGap = Math.abs(1 - (upPrice + downPrice));
  if (Number.isFinite(binaryGap)) return binaryGap;

  return Number(sentiment.spread);
}

export function buildPlan3EntryRuntimeConfig(config = {}, tokenPrice = null) {
  if (!config.plan3PaperWideBand || !Number.isFinite(Number(tokenPrice))) return config;
  return {
    ...config,
    plan3MaxSpread: resolvePlan3MaxSpreadForEntry({ tokenPrice, config }),
    plan3MaxReverseBps: resolvePlan3MaxReverseBpsForEntry({ tokenPrice, config })
  };
}

export function resolvePlan3PriceBand(tokenPrice) {
  const price = Number(tokenPrice);
  if (!Number.isFinite(price)) return 'unknown';
  const cents = price * 100;
  if (cents >= 99) return '99+';
  if (cents >= 96) return '96-98';
  if (cents >= 93) return '93-95';
  return '<93';
}

export function resolvePlan3PriceCentKey(tokenPrice) {
  const price = Number(tokenPrice);
  if (!Number.isFinite(price) || price <= 0) return 'unknown';
  return String(Math.min(99, Math.max(0, Math.floor((price + 1e-9) * 100))));
}

export function getPlan3MinDistanceBps(timeframe = '15m', config = {}) {
  return timeframe === '5m'
    ? Number(config.plan3MinDistanceBps5m) || 22
    : Number(config.plan3MinDistanceBps15m) || 30;
}

export function getPlan3SettlementDistanceThreshold(timeframe = '15m', config = {}, secondsRemaining = null) {
  if (config.plan3PaperMode) {
    return Number(config.plan3PaperMinDirectionalBps ?? 0.5);
  }
  const sec = Number(secondsRemaining);
  if (!Number.isFinite(sec)) return getPlan3MinDistanceBps(timeframe, config);
  if (timeframe === '5m') {
    if (sec > 30) return 35;
    if (sec > 10) return 25;
    return Math.max(18, getPlan3MinDistanceBps(timeframe, config));
  }
  if (sec > 30) return 42;
  if (sec > 10) return 30;
  return Math.max(22, getPlan3MinDistanceBps(timeframe, config));
}

export function resolvePlan3WinningTokenPrice({
  direction,
  sentiment = {},
  config = {}
}) {
  const upPrice = Number(sentiment.upPrice);
  const downPrice = Number(sentiment.downPrice);
  const directionalPrice = direction === 'up' ? upPrice : downPrice;
  const minPrice = Number(config.plan3MinPrice) || 0.990;
  const maxPrice = Number(config.plan3MaxPrice) || 0.998;

  if (Number.isFinite(directionalPrice) && directionalPrice >= minPrice && directionalPrice <= maxPrice) {
    return { tokenPrice: directionalPrice, tokenDirection: direction, priceSource: 'directional' };
  }

  if (canPlan3UsePmLeadingPrice(config)) {
    const candidates = [
      { tokenPrice: upPrice, tokenDirection: 'up' },
      { tokenPrice: downPrice, tokenDirection: 'down' }
    ].filter((item) => Number.isFinite(item.tokenPrice) && item.tokenPrice >= minPrice && item.tokenPrice <= maxPrice);
    if (candidates.length) {
      const leading = candidates.sort((a, b) => b.tokenPrice - a.tokenPrice)[0];
      return { ...leading, priceSource: 'pm_leading' };
    }
  }

  return {
    tokenPrice: Number.isFinite(directionalPrice) ? directionalPrice : null,
    tokenDirection: direction,
    priceSource: 'directional'
  };
}

function canPlan3UsePmLeadingPrice(config = {}) {
  return config.plan3PaperWideBand === true && config.plan3PaperUsePmLeadingPrice !== false;
}

export function resolvePlan3SecondsWindow(timeframe = '15m', config = {}) {
  const is5m = timeframe === '5m';
  return {
    min: Number(is5m ? config.plan3MinSecondsRemaining5m : config.plan3MinSecondsRemaining15m) || (is5m ? 3 : 5),
    max: Number(is5m ? config.plan3MaxSecondsRemaining5m : config.plan3MaxSecondsRemaining15m) || (is5m ? 10 : 20)
  };
}

export function resolvePlan3EarlySecondsWindow(timeframe = '15m', config = {}) {
  const is5m = timeframe === '5m';
  return {
    min: Number(is5m ? config.plan3EarlyMinSecondsRemaining5m : config.plan3EarlyMinSecondsRemaining15m) || (is5m ? 46 : 91),
    max: Number(is5m ? config.plan3EarlyMaxSecondsRemaining5m : config.plan3EarlyMaxSecondsRemaining15m) || (is5m ? 120 : 180)
  };
}

export function isPlan3EarlyCaptureEnabled(config = {}) {
  if (config.plan3EarlyCaptureEnabled === false) return false;
  if (config.plan3EarlyCaptureLiveEnabled === true) return true;
  return isPlan3PaperTrading(config);
}

export function isInPlan3EarlyTimeWindow(timeframe, secondsRemaining, config = {}) {
  if (!isPlan3EarlyCaptureEnabled(config)) return false;
  const window = resolvePlan3EarlySecondsWindow(timeframe, config);
  const sec = Number(secondsRemaining);
  return Number.isFinite(sec) && sec >= window.min && sec <= window.max;
}

export function buildPlan3TierConfig(config = {}, tier = 'late') {
  if (tier !== 'early') return config;
  return {
    ...config,
    plan3MinPrice: Number(config.plan3EarlyMinPrice) || 0.90,
    plan3MaxPrice: Number(config.plan3EarlyMaxPrice) || 0.989,
    plan3MinDistanceBps5m: Number(config.plan3EarlyMinDistanceBps5m) || 18,
    plan3MinDistanceBps15m: Number(config.plan3EarlyMinDistanceBps15m) || 25,
    plan3PaperMinDirectionalBps: Number(config.plan3EarlyMinDirectionalBps)
      || Number(config.plan3PaperMinDirectionalBps)
      || 8
  };
}

export function resolvePlan3CaptureTier({
  timeframe = '15m',
  secondsRemaining,
  tokenPrice,
  config = {}
}) {
  const sec = Number(secondsRemaining);
  const price = Number(tokenPrice);
  if (!Number.isFinite(sec) || !Number.isFinite(price)) return null;

  if (config.plan3PaperWideBand) {
    const window = resolvePlan3SecondsWindow(timeframe, config);
    const min = Number(config.plan3MinPrice) || 0.93;
    const max = Number(config.plan3MaxPrice) || 0.998;
    if (sec >= window.min && sec <= window.max && price >= min && price <= max) {
      return {
        tier: 'wide',
        entryType: 'settlement_capture',
        strategy: 'settlement_capture',
        labelSuffix: '宽档扫盘',
        priceBand: resolvePlan3PriceBand(price),
        minPrice: min,
        maxPrice: max,
        config
      };
    }
    return null;
  }

  const lateWindow = resolvePlan3SecondsWindow(timeframe, config);
  const lateMin = Number(config.plan3MinPrice) || 0.990;
  const lateMax = Number(config.plan3MaxPrice) || 0.998;
  if (sec >= lateWindow.min && sec <= lateWindow.max && price >= lateMin && price <= lateMax) {
    return {
      tier: 'late',
      entryType: 'settlement_capture',
      strategy: 'settlement_capture',
      labelSuffix: '结算扫盘',
      minPrice: lateMin,
      maxPrice: lateMax,
      config: buildPlan3TierConfig(config, 'late')
    };
  }

  if (!isPlan3EarlyCaptureEnabled(config)) return null;

  const earlyWindow = resolvePlan3EarlySecondsWindow(timeframe, config);
  const earlyMin = Number(config.plan3EarlyMinPrice) || 0.90;
  const earlyMax = Number(config.plan3EarlyMaxPrice) || 0.989;
  if (sec >= earlyWindow.min && sec <= earlyWindow.max && price >= earlyMin && price <= earlyMax) {
    return {
      tier: 'early',
      entryType: 'settlement_capture_early',
      strategy: 'settlement_capture_early',
      labelSuffix: '提前扫盘',
      minPrice: earlyMin,
      maxPrice: earlyMax,
      config: buildPlan3TierConfig(config, 'early')
    };
  }

  return null;
}

export function isInPlan3TimeWindow(timeframe, secondsRemaining, config = {}) {
  const window = resolvePlan3SecondsWindow(timeframe, config);
  const sec = Number(secondsRemaining);
  return Number.isFinite(sec) && sec >= window.min && sec <= window.max;
}

export function computeRecentReverseBps({
  direction,
  samples = [],
  lookbackSeconds = 3,
  now = new Date()
}) {
  const cutoff = now.getTime() - Math.max(1, Number(lookbackSeconds) || 3) * 1000;
  const recent = (samples || []).filter((sample) => (
    sample.ts >= cutoff && Number.isFinite(Number(sample.btcPrice)) && Number(sample.btcPrice) > 0
  ));
  if (recent.length < 2) return 0;

  const prices = recent.map((sample) => Number(sample.btcPrice));
  const last = prices.at(-1);
  if (direction === 'up') {
    const peak = Math.max(...prices);
    return peak > 0 ? round4(Math.max(0, ((peak - last) / peak) * 10000)) : 0;
  }
  const trough = Math.min(...prices);
  return trough > 0 ? round4(Math.max(0, ((last - trough) / trough) * 10000)) : 0;
}

export function computeVolatilityBpsPerSecond(samples = [], lookbackSeconds = 3, now = new Date()) {
  const cutoff = now.getTime() - Math.max(1, Number(lookbackSeconds) || 3) * 1000;
  const recent = (samples || [])
    .filter((sample) => sample.ts >= cutoff && Number.isFinite(Number(sample.btcPrice)) && Number(sample.btcPrice) > 0)
    .sort((a, b) => a.ts - b.ts);
  if (recent.length < 2) return 0;

  const perSecond = [];
  for (let index = 1; index < recent.length; index += 1) {
    const prev = recent[index - 1];
    const curr = recent[index];
    const dtSec = Math.max(0.001, (curr.ts - prev.ts) / 1000);
    const bps = ((curr.btcPrice - prev.btcPrice) / prev.btcPrice) * 10000;
    perSecond.push(Math.abs(bps) / dtSec);
  }
  if (!perSecond.length) return 0;
  return round4(perSecond.reduce((sum, value) => sum + value, 0) / perSecond.length);
}

export function isEffectivelySettled({
  timeframe = '15m',
  secondsRemaining,
  distanceFromOpenBps,
  recentReverseBps,
  volatilityBpsPerSecond = 0,
  config = {}
}) {
  const minDistance = getPlan3SettlementDistanceThreshold(timeframe, config, secondsRemaining);
  const maxReverse = Number(config.plan3MaxReverseBps) || 2;
  const absDistance = Math.abs(Number(distanceFromOpenBps));

  const inLate = isInPlan3TimeWindow(timeframe, secondsRemaining, config);
  const inEarly = !config.plan3PaperWideBand && isInPlan3EarlyTimeWindow(timeframe, secondsRemaining, config);
  if (!inLate && !inEarly) return false;
  if (!Number.isFinite(absDistance) || absDistance < minDistance) return false;
  if (Number(recentReverseBps) > maxReverse) return false;

  const dynamicEnabled = config.plan3DynamicSettlementEnabled === true
    && (!config.plan3PaperMode || config.plan3PaperDynamicSettlementEnabled === true);
  if (dynamicEnabled) {
    const safety = Number(config.plan3DynamicSafetyMultiplier) || 2.0;
    const minVolatility = Math.max(0, Number(config.plan3DynamicMinVolatilityBpsPerSecond) || 0.05);
    const requiredBuffer = Number(recentReverseBps) * 2
      + Math.max(minVolatility, Number(volatilityBpsPerSecond) || 0) * Number(secondsRemaining) * safety;
    return absDistance > requiredBuffer;
  }

  return true;
}

export function evaluatePlan3EntryConfirmation({
  direction,
  tradeDirection,
  samples = [],
  timeframe = '5m',
  now = new Date(),
  config = {}
} = {}) {
  if (config.plan3EntryConfirmationEnabled !== true) return { allowed: true, skipped: true };
  if (config.plan3RequirePmTechAlignment !== false && direction !== tradeDirection) {
    return {
      allowed: false,
      reason: `PM 领先方向 ${String(tradeDirection || '').toUpperCase()} 与标的方向 ${String(direction || '').toUpperCase()} 不一致`
    };
  }
  const valid = (Array.isArray(samples) ? samples : []).filter((sample) => (
    Number.isFinite(Number(sample.ts))
    && Number.isFinite(Number(sample.upPrice))
    && Number.isFinite(Number(sample.downPrice))
  ));
  const minSamples = Math.max(2, Number(config.plan3ConfirmationMinSamples) || 4);
  if (valid.length < minSamples) {
    return { allowed: false, insufficientSamples: true, sampleCount: valid.length, minSamples, reason: `盘口确认样本不足 ${valid.length}/${minSamples}` };
  }
  const lookback = valid.slice(-Math.max(minSamples, Number(config.plan3ConfirmationLookbackSamples) || 10));
  const leaders = lookback.map((sample) => Number(sample.upPrice) >= Number(sample.downPrice) ? 'up' : 'down');
  let stableSamples = 0;
  for (let index = leaders.length - 1; index >= 0 && leaders[index] === tradeDirection; index -= 1) stableSamples += 1;
  if (stableSamples < minSamples) {
    return { allowed: false, sampleCount: valid.length, stableSamples, reason: `PM 领先方向仅连续 ${stableSamples} 个样本` };
  }
  const stableStart = lookback[lookback.length - stableSamples];
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const stableMs = Math.max(0, nowMs - Number(stableStart.ts));
  const minStableMs = Math.max(0, Number(
    timeframe === '5m' ? config.plan3ConfirmationMinStableMs5m : config.plan3ConfirmationMinStableMs15m
  ) || (timeframe === '5m' ? 6000 : 12000));
  if (stableMs < minStableMs) {
    return { allowed: false, sampleCount: valid.length, stableSamples, stableMs, minStableMs, reason: `PM 领先方向仅稳定 ${(stableMs / 1000).toFixed(0)} 秒` };
  }
  const latest = lookback.at(-1);
  const leaderPrice = Number(tradeDirection === 'up' ? latest.upPrice : latest.downPrice);
  const first = lookback[lookback.length - stableSamples];
  const firstLeaderPrice = Number(tradeDirection === 'up' ? first.upPrice : first.downPrice);
  const deterioration = firstLeaderPrice - leaderPrice;
  const maxDeterioration = Number(config.plan3ConfirmationMaxPmDeterioration) || 0.02;
  if (Number.isFinite(deterioration) && deterioration > maxDeterioration) {
    return { allowed: false, sampleCount: valid.length, stableSamples, stableMs, deterioration: round4(deterioration), reason: `PM 领先价格已回落 ${deterioration.toFixed(3)}` };
  }
  return {
    allowed: true,
    sampleCount: valid.length,
    stableSamples,
    stableMs,
    leaderPrice: round4(leaderPrice),
    deterioration: round4(Math.max(0, deterioration))
  };
}

export function describePlan3SettlementSkip({
  timeframe = '15m',
  secondsRemaining = null,
  distanceFromOpenBps,
  recentReverseBps,
  config = {}
}) {
  const absDistance = Math.abs(Number(distanceFromOpenBps));
  const minDistance = getPlan3SettlementDistanceThreshold(timeframe, config, secondsRemaining);
  const maxReverse = Number(config.plan3MaxReverseBps) || 2;

  if (!Number.isFinite(absDistance)) {
    return '缺少距开盘 bps';
  }
  if (absDistance < minDistance) {
    return `距开盘 ${absDistance.toFixed(1)}bps < 门槛 ${minDistance}bps`;
  }
  if (Number(recentReverseBps) > maxReverse) {
    return `反向 ${Number(recentReverseBps).toFixed(1)}bps > 上限 ${maxReverse}bps`;
  }
  return null;
}

export function choosePlan3LimitPrice({ tokenPrice, config = {}, tier = 'late' }) {
  const ask = Number(tokenPrice);
  const minPrice = Number(config.plan3MinPrice) || 0.990;
  const maxPrice = Number(config.plan3MaxPrice) || 0.998;

  if (tier === 'early' || tier === 'wide') {
    if (!Number.isFinite(ask) || ask <= 0) return round4(minPrice);
    // 宽档/提前档：限价贴 ask，但纸面不再靠 direct-fill 强行成交；
    // 真实可成交性与 EV 由 estimatePlan3ExpectedFillPrice / band gate 约束。
    return round4(Math.min(maxPrice, Math.max(minPrice, ask)));
  }

  const mode = String(config.plan3PriceMode || 'balanced').toLowerCase();

  let target;
  if (mode === 'conservative') {
    target = Number(config.plan3PriceConservative) || 0.992;
  } else if (mode === 'aggressive') {
    target = Number(config.plan3PriceAggressive) || 0.998;
  } else {
    target = Number(config.plan3PriceBalanced) || 0.995;
  }

  if (Number.isFinite(ask) && ask > 0) {
    target = Math.min(target, ask);
  }
  return round4(Math.min(maxPrice, Math.max(minPrice, target)));
}

/**
 * 估计 Plan3 真实可成交价（FAK 加价后的悲观/中性预期）。
 * 纸面默认模拟 bump，避免按理想限价记账；ask > limit 且非 direct-fill 时视为不可成交。
 */
export function estimatePlan3ExpectedFillPrice({
  tokenPrice,
  limitPrice = null,
  config = {},
  live = null
} = {}) {
  const ask = Number(tokenPrice);
  const limit = Number(limitPrice);
  const isLive = live ?? (config.plan3LiveEnabled === true);
  const tick = Number(config.plan3FillTickSize) || 0.01;
  const paperDirectFill = !isLive && config.plan3PaperDirectFill === true;
  const simulateBump = isLive || config.plan3PaperSimulateFakBump !== false;

  if (!paperDirectFill && Number.isFinite(ask) && Number.isFinite(limit) && ask > limit + 1e-9) {
    return { fillable: false, expectedFillPrice: null, bumpSteps: 0, askPrice: ask, limitPrice: limit };
  }

  let base = Number.isFinite(ask) ? ask : limit;
  if (!Number.isFinite(base) || base <= 0) {
    return { fillable: false, expectedFillPrice: null, bumpSteps: 0, askPrice: ask, limitPrice: limit };
  }
  if (Number.isFinite(limit) && limit > 0) {
    // 买入：成交价取 ask 与限价中更差（更高）的一侧作为起点
    base = Math.max(base, Math.min(limit, ask || limit));
  }

  const maxBump = simulateBump
    ? Math.max(0, Math.min(10, Number(config.plan3LiveFakBumpSteps) || 4))
    : 0;
  const explicitGateBump = Number(config.plan3BandStatsFillBumpSteps);
  const bumpSteps = Number.isFinite(explicitGateBump) && explicitGateBump >= 0
    ? Math.min(10, explicitGateBump)
    : Math.max(0, Math.ceil(maxBump / 2));
  // CLOB bump 上限 0.99，但买入成交价不得低于 ask/base（否则 99¢+ 会被错误压低）。
  const bumped = round4(Math.min(0.99, base + tick * bumpSteps));
  const expectedFillPrice = round4(Math.max(base, bumped));
  return {
    fillable: true,
    expectedFillPrice,
    bumpSteps,
    askPrice: Number.isFinite(ask) ? ask : null,
    limitPrice: Number.isFinite(limit) ? limit : null
  };
}

export function repricePlan3LiveDraft(draft, freshPrice, config = {}) {
  const price = round4(Number(freshPrice));
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('Plan3 execution preflight did not return a tradable ask.');
  }
  const configuredMax = Number(
    draft?.maxLivePrice
    ?? config.plan3LiveWideMaxPrice
    ?? config.plan3MaxPrice
    ?? 0.99
  );
  if (Number.isFinite(configuredMax) && price > configuredMax + 1e-9) {
    throw new Error(
      `Plan3 executable ask ${(price * 100).toFixed(2)}c exceeds the ${(configuredMax * 100).toFixed(2)}c positive-EV cap.`
    );
  }
  const usd = round2(Number(draft?.usd));
  if (!(usd > 0)) throw new Error('Plan3 live order amount is invalid.');
  return {
    ...draft,
    intendedLimitPrice: draft?.intendedLimitPrice ?? draft?.limitPrice ?? null,
    intendedUsd: draft?.intendedUsd ?? draft?.usd ?? null,
    executionPreflightPrice: price,
    limitPrice: price,
    usd,
    shares: round4(usd / price),
    requestedUsd: usd,
    maxLivePrice: Number.isFinite(configuredMax) ? configuredMax : null
  };
}

export function resolvePlan3ProbSizingCoeff(config = {}) {
  const explicit = Number(config.plan3ProbSizingCoeff);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const refOrder = Number(config.plan3ProbSizingReferenceOrderUsd) || 100;
  const refEquity = Number(config.plan3ProbSizingReferenceEquity) || 500;
  const refPrice = Number(config.plan3ProbSizingReferencePrice) || 0.99;
  return refOrder / (refEquity * refPrice);
}

export function isPlan3SlotSubmissionLocked(entry = null) {
  if (!entry) return false;
  const fillStatus = String(entry.fillStatus || entry.status || '').toLowerCase();
  if (fillStatus === 'blocked' || fillStatus === 'expired') return false;
  return [
    'filled',
    'submitted',
    'open',
    'pending',
    'paper-filled',
    'paper-submitted'
  ].includes(fillStatus);
}

export function calculatePlan3OrderUsd({ equity, cash, tokenPrice, clobMinUsd = 0, config = {}, paperMode = null }) {
  const netEquity = Number(equity) || 0;
  const availableCash = Number.isFinite(Number(cash)) && Number(cash) >= 0
    ? Number(cash)
    : netEquity;
  if (availableCash <= 0) return 0;

  const minUsd = Number(config.plan3MinOrderUsd) || 50;
  const maxOrderPct = Number(config.plan3MaxOrderPct) || 0.10;
  const price = Number(tokenPrice);

  let usd;
  if (config.plan3ProbSizingEnabled === true) {
    if (netEquity <= 0 || !Number.isFinite(price) || price <= 0) return 0;
    const coeff = resolvePlan3ProbSizingCoeff(config);
    usd = round2(netEquity * price * coeff);
    usd = Math.min(usd, round2(netEquity * maxOrderPct));
    usd = Math.min(usd, round2(availableCash));
    if (usd < minUsd) return 0;
  } else {
    usd = round2(availableCash * maxOrderPct);
    if (usd < minUsd) {
      if (availableCash >= minUsd) usd = minUsd;
      else return 0;
    }
    usd = Math.min(usd, round2(availableCash));
  }

  const isPaper = paperMode ?? (config.plan3LiveEnabled !== true);
  if (isPaper) {
    return round2(Math.min(usd, availableCash));
  }

  const minShares = Math.max(5, Number(config.liveMinSharesBuffer) || 6);
  const minByShares = round2(price * minShares);
  const clobMin = Number(clobMinUsd) || minByShares;
  return applyPlan3LiveMinOrder({
    calculatedUsd: usd,
    clobMinUsd: clobMin,
    equity: netEquity,
    config
  });
}

export function applyPlan3LiveMinOrder({ calculatedUsd, clobMinUsd, equity, config = {} }) {
  const calc = Number(calculatedUsd) || 0;
  const minUsd = Number(clobMinUsd) || 0;
  const eq = Number(equity) || 0;
  const maxAllowed = eq * (Number(config.plan3LiveMinOrderMaxEquityPct) || 0.005);

  if (calc >= minUsd) return round2(calc);
  if (minUsd > 0 && minUsd <= maxAllowed) return round2(minUsd);
  return 0;
}

/** 概率定仓才套 $100 类硬顶；现金×比例定仓已由 calculatePlan3OrderUsd 封顶。 */
export function resolvePlan3FinalOrderUsd(orderUsd, config = {}) {
  const usd = Number(orderUsd) || 0;
  if (config.plan3LiveEnabled !== true) return usd;
  if (config.plan3ProbSizingEnabled === true) {
    const liveMaxUsd = Number(config.plan3LiveMaxOrderUsd) || 3;
    return Math.min(usd, liveMaxUsd);
  }
  return usd;
}

export function passesPlan3RiskChecks({
  equity,
  slotIso,
  direction,
  newOrderUsd,
  openExposureOrders = [],
  plan3Daily = {},
  config = {}
}) {
  const eq = Number(equity) || 0;
  const usd = Number(newOrderUsd) || 0;
  if (usd <= 0) return { allowed: false, reason: 'order_too_small_or_min_too_large' };

  const liveRiskStopsEnabled = config.plan3LiveEnabled === true;
  const riskExposureOrders = liveRiskStopsEnabled
    ? openExposureOrders
    : openExposureOrders.filter((order) => order.planId === 'plan3');
  const stopAfterOneLossEnabled = liveRiskStopsEnabled && config.plan3StopAfterOneLoss === true;
  const dailyLossLimitEnabled = liveRiskStopsEnabled && config.plan3DailyLossLimitEnabled !== false;

  if (plan3Daily.stopped) {
    const stopReason = plan3Daily.stopReason || 'daily_loss_limit_reached';
    const stopAfterOneLossIgnored = stopReason === 'stop_after_one_loss' && !stopAfterOneLossEnabled;
    const dailyLossIgnored = stopReason === 'daily_loss_limit_reached' && !dailyLossLimitEnabled;
    if (!stopAfterOneLossIgnored && !dailyLossIgnored) {
      return { allowed: false, reason: stopReason };
    }
  }

  const dailyLimitPct = Number(config.plan3DailyLossLimitPct) || 0.01;
  const dailyPnl = Number(plan3Daily.realizedPnl) || 0;
  if (dailyLossLimitEnabled && dailyPnl <= -eq * dailyLimitPct) {
    return { allowed: false, reason: 'daily_loss_limit_reached' };
  }

  if (stopAfterOneLossEnabled && Number(plan3Daily.lossCount) >= 1) {
    return { allowed: false, reason: 'stop_after_one_loss' };
  }

  const maxExecErrors = Number(config.plan3MaxExecutionErrorsPerDay) || 3;
  if (Number(plan3Daily.executionErrors) >= maxExecErrors) {
    return { allowed: false, reason: 'execution_error_limit_reached' };
  }

  const maxSlotExposure = eq * (Number(config.plan3MaxSlotExposurePct) || 0.25);
  const slotExposure = riskExposureOrders
    .filter((order) => (
      (order.slotIso || order.plan?.slotIso) === slotIso
      && order.planId === 'plan3'
      && order.settlementStatus === 'open'
    ))
    .reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
  if (slotExposure + usd > maxSlotExposure) {
    return { allowed: false, reason: 'plan3_slot_exposure_exceeded' };
  }

  const opposite = direction === 'up' ? 'down' : 'up';
  const conflicting = riskExposureOrders.find((order) => (
    (order.slotIso || order.plan?.slotIso) === slotIso
    && order.direction === opposite
    && order.settlementStatus === 'open'
    && Number(order.usd) > eq * 0.005
  ));
  if (conflicting) {
    return { allowed: false, reason: 'opposite_direction_exposure_conflict' };
  }

  return { allowed: true, reason: null };
}

const PLAN3_SKIP_REASON_LABELS = {
  order_too_small_or_min_too_large: 'Plan3 订单金额不足（低于最低单量或超出净值比例上限）',
  not_in_time_window: '不在 Plan3 扫盘时间窗',
  not_effectively_settled: '未满足结算确认条件',
  price_out_of_range: 'token 价格不在 Plan3 档位范围',
  spread_too_wide: '买卖价差过大',
  market_quality_low: '市场质量不足',
  already_submitted_this_slot: '本窗口已提交过 Plan3 订单',
  portfolio_not_configured: '模拟盘组合未配置',
  live_disabled: '实盘下单开关未开启',
  plan3_disabled: 'Plan3 未启用',
  daily_loss_limit_reached: 'Plan3 日亏损上限已触发',
  stop_after_one_loss: 'Plan3 首亏后暂停',
  execution_error_limit_reached: 'Plan3 执行错误次数达上限',
  plan3_slot_exposure_exceeded: 'Plan3 单窗口敞口超限',
  opposite_direction_exposure_conflict: '同窗口反向敞口冲突',
  market_not_open: 'Polymarket 市场未开放',
  missing_reference_price: '缺少 BTC 参考价',
  band_win_rate_below_breakeven: 'Plan3 档位历史胜率低于盈亏平衡，跳过该单',
  band_negative_ev_at_fill: 'Plan3 按预期成交价计算为负期望，跳过该单',
  entry_confirmation_failed: 'Plan3 PM/标的方向与稳定性确认不足',
  paper_timeframe_not_validated: 'Plan3 模拟 15m 历史未验证为正期望'
};

/**
 * 档位 EV 门控：用 expectedFillPrice（限价/FAK bump 后）而非裸 tokenPrice 算盈亏平衡胜率。
 * band 仍按 tokenPrice/entry 分档，避免 bump 把单子挪到更高档统计桶。
 */
export function evaluatePlan3BandStatsGate({
  tokenPrice,
  effectiveFillPrice = null,
  bandStats = null,
  symbol = null,
  config = {}
} = {}) {
  if (config.plan3BandStatsGateEnabled === false || !bandStats) {
    return { allowed: true, band: resolvePlan3PriceBand(tokenPrice), stats: null };
  }
  const band = resolvePlan3PriceBand(tokenPrice);
  const minSamples = Number(config.plan3BandStatsMinSamples) || 30;
  const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
  const fillPrice = Number(effectiveFillPrice);
  const price = Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : Number(tokenPrice);
  const priceKey = resolvePlan3PriceCentKey(price);
  const candidates = [
    {
      scope: 'symbol_price',
      label: `${normalizedSymbol || 'unknown'} ${priceKey}¢`,
      stats: normalizedSymbol ? bandStats._bySymbolPrice?.[normalizedSymbol]?.[priceKey] : null
    },
    {
      scope: 'symbol_band',
      label: `${normalizedSymbol || 'unknown'} ${band}`,
      stats: normalizedSymbol ? bandStats._bySymbol?.[normalizedSymbol]?.[band] : null
    },
    { scope: 'global_band', label: `档位 ${band}`, stats: bandStats[band] }
  ];
  const selected = candidates.find((candidate) => (
    Number.isFinite(candidate.stats?.total) && candidate.stats.total >= minSamples
  ));
  const fallbackStats = candidates.find((candidate) => candidate.stats)?.stats || null;
  const stats = selected?.stats || fallbackStats;
  if (!stats || !Number.isFinite(stats.total) || stats.total < minSamples) {
    return {
      allowed: true,
      band,
      priceKey,
      stats: stats || null,
      statsScope: null,
      insufficientSamples: true
    };
  }
  const margin = Number(config.plan3BandStatsMargin) || 0.005;
  const requiredWinRate = Number.isFinite(price) ? Math.min(0.999, price + margin) : 0.99;
  if (stats.winRate < requiredWinRate) {
    return {
      allowed: false,
      band,
      priceKey,
      stats,
      statsScope: selected.scope,
      requiredWinRate,
      effectiveFillPrice: Number.isFinite(price) ? price : null,
      reason: `${selected.label} 历史胜率 ${(stats.winRate * 100).toFixed(1)}%（${stats.wins}/${stats.total}）低于盈亏平衡 ${(requiredWinRate * 100).toFixed(1)}%（按成交价 ${(price * 100).toFixed(2)}¢）`
    };
  }
  return {
    allowed: true,
    band,
    priceKey,
    stats,
    statsScope: selected.scope,
    requiredWinRate,
    effectiveFillPrice: Number.isFinite(price) ? price : null
  };
}

export function evaluatePlan3QuoteCoherence({ upPrice, downPrice, config = {} } = {}) {
  const up = Number(upPrice);
  const down = Number(downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up <= 0 || down <= 0) {
    return { allowed: false, quoteSum: null, reason: 'UP/DOWN 双边报价不完整。' };
  }
  const quoteSum = round4(up + down);
  const min = Number(config.plan3QuoteSumMin) || 0.95;
  const max = Number(config.plan3QuoteSumMax) || 1.08;
  if (quoteSum < min || quoteSum > max) {
    return {
      allowed: false,
      quoteSum,
      min,
      max,
      reason: `UP/DOWN 报价和 ${quoteSum.toFixed(3)} 超出 ${min.toFixed(2)}-${max.toFixed(2)}，盘口不同步。`
    };
  }
  return { allowed: true, quoteSum, min, max };
}

export function describePlan3ActionSkipReason(action = {}) {
  if (!action || action.shouldTrade) return null;
  const key = action.skipReason || null;
  if (key && PLAN3_SKIP_REASON_LABELS[key]) {
    const label = PLAN3_SKIP_REASON_LABELS[key];
    if (key === 'not_effectively_settled' && action.settlementSkipDetail) {
      return `${label}：${action.settlementSkipDetail}`;
    }
    if (key === 'order_too_small_or_min_too_large' && Number.isFinite(Number(action.orderUsd))) {
      return `${label}（计算 $${Number(action.orderUsd).toFixed(2)}）`;
    }
    if (key === 'price_out_of_range' && Number.isFinite(Number(action.tokenPrice))) {
      return `${label}（${(Number(action.tokenPrice) * 100).toFixed(1)}¢）`;
    }
    return label;
  }
  if (action.settlementSkipDetail) return action.settlementSkipDetail;
  if (action.reason && !String(action.reason).startsWith('Plan3 ')) return action.reason;
  return key || action.reason || 'plan skipped';
}

function skip(reason, meta = {}) {
  return {
    shouldTrade: false,
    observeOnly: true,
    skipReason: reason,
    ...meta
  };
}

export function buildPolymarketPaperPlan3({
  signal,
  sentiment,
  config,
  portfolio = null,
  timeframe = '15m',
  openExposureOrders = [],
  plan3Daily = {},
  alreadySubmittedKeys = new Set(),
  plan3BandStats = null,
  lossReasonOrders = null,
  paperMode = null,
  now = new Date()
}) {
  const usePaperMode = paperMode ?? isPlan3PaperTrading(config);
  config = usePaperMode ? { ...config, plan3LiveEnabled: false } : config;
  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';
  const buildPlan3Shell = (args) => buildPlan3ShellBase({ symbol, ...args });
  if (config.plan3Enabled !== true) {
    return buildPlan3Shell({ timeframe, now, action: skip('plan3_disabled') });
  }

  const runtimeConfig = resolvePlan3RuntimeConfig(config);

  if (usePaperMode && timeframe === '15m' && runtimeConfig.plan3Paper15mEnabled === false) {
    return buildPlan3Shell({ timeframe, now, action: skip('paper_timeframe_not_validated') });
  }

  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const schedule = signal?.schedule || getSlotSchedule(now, slotMinutes);
  const secondsRemaining = Number(schedule.secondsToNext);
  const slotIso = schedule.currentSlotIso || null;
  const targetTimeIso = schedule.nextSlotIso || null;

  if (!sentiment?.available) {
    return buildPlan3Shell({ timeframe, slotIso, targetTimeIso, secondsRemaining, now, action: skip('market_not_open') });
  }

  const inWindow = runtimeConfig.plan3PaperWideBand
    ? isInPlan3TimeWindow(timeframe, secondsRemaining, runtimeConfig)
    : null;
  const inLateWindow = inWindow ?? isInPlan3TimeWindow(timeframe, secondsRemaining, runtimeConfig);
  const inEarlyWindow = runtimeConfig.plan3PaperWideBand
    ? false
    : isInPlan3EarlyTimeWindow(timeframe, secondsRemaining, runtimeConfig);
  const candidateTier = runtimeConfig.plan3PaperWideBand
    ? (inLateWindow ? 'wide' : null)
    : (inLateWindow ? 'late' : (inEarlyWindow ? 'early' : null));
  if (!candidateTier) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      now,
      action: skip('not_in_time_window', { secondsRemaining })
    });
  }

  const tierRuntimeConfig = runtimeConfig.plan3PaperWideBand
    ? runtimeConfig
    : buildPlan3TierConfig(runtimeConfig, candidateTier);

  const slotOpenPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  const referencePrice = Number(signal?.indicators?.currentPrice);
  if (!Number.isFinite(slotOpenPrice) || slotOpenPrice <= 0 || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      now,
      action: skip('missing_reference_price')
    });
  }

  const distanceFromOpenBps = ((referencePrice - slotOpenPrice) / slotOpenPrice) * 10000;
  const direction = distanceFromOpenBps >= 0 ? 'up' : 'down';
  const pmUpPrice = round4(Number(sentiment.upPrice));
  const pmDownPrice = round4(Number(sentiment.downPrice));
  const quoteCoherence = evaluatePlan3QuoteCoherence({
    upPrice: pmUpPrice,
    downPrice: pmDownPrice,
    config: runtimeConfig
  });
  const track = getWindowTrackSnapshot(slotIso, timeframe, symbol);
  const samples = track?.samples || [];
  const lookbackSeconds = Number(runtimeConfig.plan3ReverseLookbackSeconds) || 3;
  const recentReverseBps = computeRecentReverseBps({ direction, samples, lookbackSeconds, now });
  const volatilityBpsPerSecond = computeVolatilityBpsPerSecond(samples, lookbackSeconds, now);
  const settlementThresholdBps = getPlan3SettlementDistanceThreshold(timeframe, tierRuntimeConfig, secondsRemaining);

  if (!isEffectivelySettled({
    timeframe,
    secondsRemaining,
    distanceFromOpenBps,
    recentReverseBps,
    volatilityBpsPerSecond,
    config: tierRuntimeConfig
  })) {
    const settlementSkipDetail = describePlan3SettlementSkip({
      timeframe,
      secondsRemaining,
      distanceFromOpenBps,
      recentReverseBps,
      config: tierRuntimeConfig
    });
    const directionalTokenPrice = Number(direction === 'up' ? pmUpPrice : pmDownPrice);
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      volatilityBpsPerSecond,
      tokenPrice: Number.isFinite(directionalTokenPrice) ? directionalTokenPrice : null,
      now,
      action: skip('not_effectively_settled', {
        distanceFromOpenBps: round4(distanceFromOpenBps),
        recentReverseBps,
        volatilityBpsPerSecond,
        settlementThresholdBps,
        settlementSkipDetail,
        pmUpPrice,
        pmDownPrice
      })
    });
  }

  const { tokenPrice: resolvedTokenPrice, tokenDirection, priceSource } = resolvePlan3WinningTokenPrice({
    direction,
    sentiment,
    config: tierRuntimeConfig
  });
  const tradeDirection = tokenDirection || direction;
  const tokenPrice = Number(resolvedTokenPrice);
  const tradeReverseBps = tradeDirection === direction
    ? recentReverseBps
    : computeRecentReverseBps({ direction: tradeDirection, samples, lookbackSeconds, now });
  const captureTier = resolvePlan3CaptureTier({
    timeframe,
    secondsRemaining,
    tokenPrice,
    config: runtimeConfig
  });
  if (!captureTier) {
    const minPrice = Number(tierRuntimeConfig.plan3MinPrice) || 0.990;
    const maxPrice = Number(tierRuntimeConfig.plan3MaxPrice) || 0.998;
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      now,
      action: skip('price_out_of_range', {
        tokenPrice,
        pmUpPrice,
        pmDownPrice,
        priceSource,
        minPrice,
        maxPrice,
        candidateTier
      })
    });
  }

  const entryConfirmation = evaluatePlan3EntryConfirmation({
    direction,
    tradeDirection,
    samples,
    timeframe,
    now,
    config: runtimeConfig
  });
  if (!entryConfirmation.allowed) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps: tradeReverseBps,
      tokenPrice,
      now,
      action: skip('entry_confirmation_failed', {
        pmUpPrice,
        pmDownPrice,
        entryConfirmation,
        settlementSkipDetail: entryConfirmation.reason
      })
    });
  }

  if (!quoteCoherence.allowed) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps: tradeReverseBps,
      tokenPrice,
      now,
      action: skip('market_quote_incoherent', {
        pmUpPrice,
        pmDownPrice,
        quoteSum: quoteCoherence.quoteSum,
        settlementSkipDetail: quoteCoherence.reason
      })
    });
  }

  const activeTierConfig = captureTier.config;

  const spread = resolvePlan3EntrySpread({ sentiment, direction: tradeDirection });
  const entryConfig = buildPlan3EntryRuntimeConfig(runtimeConfig, tokenPrice);
  const skipSpreadCheck = runtimeConfig.plan3PaperWideBand
    && runtimeConfig.plan3PaperWideSkipSpreadCheck === true
    && Number(tokenPrice) >= (Number(runtimeConfig.plan3MinPrice) || 0.93);
  const maxSpread = resolvePlan3MaxSpreadForEntry({ tokenPrice, config: runtimeConfig });
  if (!skipSpreadCheck && Number.isFinite(spread) && spread > maxSpread) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      spread,
      now,
      action: skip('spread_too_wide', { spread, maxSpread, tokenPrice: round4(tokenPrice) })
    });
  }

  if (Number(tradeReverseBps) > Number(entryConfig.plan3MaxReverseBps)) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps: tradeReverseBps,
      tokenPrice,
      now,
      action: skip('not_effectively_settled', {
        recentReverseBps: tradeReverseBps,
        maxReverseBps: entryConfig.plan3MaxReverseBps,
        tokenPrice: round4(tokenPrice),
        priceSource
      })
    });
  }

  const quality = Number(sentiment.qualityScore);
  const minQuality = Number(entryConfig.plan3MinMarketQuality) || 0.65;
  if (Number.isFinite(quality) && quality < minQuality) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      spread,
      quality,
      now,
      action: skip('market_quality_low', { quality })
    });
  }

  const submitKey = buildPlan3SlotKey(slotIso, timeframe, tradeDirection, symbol);
  if (alreadySubmittedKeys.has(submitKey)) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      now,
      action: skip('already_submitted_this_slot')
    });
  }

  const equity = Number(portfolio?.equity ?? portfolio?.startingCash ?? config.defaultStartingCash) || 0;
  const cash = portfolio?.portfolioInitialized ? Number(portfolio?.cash) : null;
  const limitPrice = choosePlan3LimitPrice({
    tokenPrice,
    config: activeTierConfig,
    tier: captureTier.tier
  });
  const fillEstimate = estimatePlan3ExpectedFillPrice({
    tokenPrice,
    limitPrice,
    config: runtimeConfig,
    live: !isPlan3PaperTrading(config)
  });
  const bandGate = evaluatePlan3BandStatsGate({
    tokenPrice,
    effectiveFillPrice: fillEstimate.expectedFillPrice ?? limitPrice,
    bandStats: plan3BandStats,
    symbol: signal?.symbol,
    config: runtimeConfig
  });
  if (!bandGate.allowed) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      limitPrice,
      now,
      action: skip('band_win_rate_below_breakeven', {
        tokenPrice: round4(tokenPrice),
        limitPrice: round4(limitPrice),
        expectedFillPrice: fillEstimate.expectedFillPrice,
        priceBand: bandGate.band,
        bandStatsScope: bandGate.statsScope,
        bandWinRate: bandGate.stats?.winRate ?? null,
        bandSamples: bandGate.stats?.total ?? null,
        requiredWinRate: bandGate.requiredWinRate ?? null,
        settlementSkipDetail: bandGate.reason
      })
    });
  }

  const priceBand = bandGate.band || resolvePlan3PriceBand(fillEstimate.expectedFillPrice ?? limitPrice);
  const lossGate = evaluateLossReasonGate({
    planId: 'plan3',
    timeframe,
    entryType: captureTier?.tier === 'early' ? 'settlement_capture_early' : 'settlement_capture',
    band: priceBand,
    orders: (lossReasonOrders || []).map((order) => ({
      ...order,
      band: order.band || resolvePlan3PriceBand(order.entryPrice ?? order.limitPrice)
    })),
    config: runtimeConfig,
    planLabel: 'Plan3'
  });
  if (!lossGate.allowed) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      limitPrice,
      now,
      action: skip('loss_reason_gate', {
        tokenPrice: round4(tokenPrice),
        limitPrice: round4(limitPrice),
        priceBand,
        settlementSkipDetail: lossGate.reason,
        lossReasonGate: {
          sampleCount: lossGate.sampleCount,
          lossRate: lossGate.lossRate,
          threshold: lossGate.threshold
        }
      })
    });
  }

  const clobMinUsd = round2(limitPrice * Math.max(5, Number(config.liveMinSharesBuffer) || 6));
  let orderUsd = calculatePlan3OrderUsd({
    equity,
    cash: Number.isFinite(cash) ? cash : undefined,
    tokenPrice,
    clobMinUsd,
    config: runtimeConfig,
    paperMode: isPlan3PaperTrading(config)
  });
  if (Number.isFinite(lossGate.sizeScale) && lossGate.sizeScale < 1) {
    orderUsd = round2(orderUsd * lossGate.sizeScale);
  }

  const risk = passesPlan3RiskChecks({
    equity,
    slotIso,
    direction: tradeDirection,
    newOrderUsd: orderUsd,
    openExposureOrders,
    plan3Daily,
    config: runtimeConfig
  });
  if (!risk.allowed) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      limitPrice,
      orderUsd,
      now,
      action: skip(risk.reason)
    });
  }

  if (!portfolio?.portfolioInitialized) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      limitPrice,
      orderUsd,
      now,
      action: skip('portfolio_not_configured')
    });
  }

  if (config.plan3LiveEnabled === true && config.liveTradingEnabled !== true) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      limitPrice,
      orderUsd,
      now,
      action: skip('live_disabled')
    });
  }

  const finalUsd = resolvePlan3FinalOrderUsd(orderUsd, config);
  if (finalUsd < 0.5) {
    return buildPlan3Shell({
      timeframe,
      slotIso,
      targetTimeIso,
      secondsRemaining,
      direction: tradeDirection,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      tokenPrice,
      limitPrice,
      orderUsd: finalUsd,
      now,
      action: skip('order_too_small_or_min_too_large')
    });
  }

  const ttlMs = timeframe === '5m'
    ? Number(runtimeConfig.plan3OrderTtlMs5m) || 3000
    : Number(runtimeConfig.plan3OrderTtlMs15m) || 5000;
  const askPrice = tokenPrice;
  // 默认关闭乐观 direct-fill：纸面需 ask<=limit，或显式开启 DIRECT_FILL 才秒成。
  const paperDirectFill = isPlan3PaperTrading(config) && config.plan3PaperDirectFill === true;
  const paperFillable = paperDirectFill
    || (Number.isFinite(askPrice) && Number.isFinite(limitPrice) && askPrice <= limitPrice + 1e-9);
  const liveFillEnabled = config.plan3LiveEnabled === true && config.liveTradingEnabled === true;
  const fillEnabled = isPlan3PaperTrading(config)
    ? config.plan3PaperFillEnabled !== false
    : liveFillEnabled;
  const paperModeLabel = isPlan3PaperTrading(config)
    ? (paperDirectFill ? '（模拟盘直接成交）' : (paperFillable ? '（模拟盘可成交）' : '（模拟盘挂单待成交）'))
    : '';
  const tierLabel = captureTier.labelSuffix;
  const expectedFillPrice = paperFillable
    ? (fillEstimate.expectedFillPrice ?? round4(Math.max(askPrice || 0, limitPrice || 0)))
    : null;

  return buildPlan3Shell({
    timeframe,
    slotIso,
    targetTimeIso,
    secondsRemaining,
    direction: tradeDirection,
    distanceFromOpenBps: round4(distanceFromOpenBps),
    recentReverseBps,
    volatilityBpsPerSecond,
    tokenPrice,
    limitPrice,
    orderUsd: finalUsd,
    spread,
    quality,
    slotOpenPrice,
    referencePrice,
    now,
    action: {
      shouldTrade: fillEnabled,
      observeOnly: !fillEnabled,
      entryType: captureTier.entryType,
      strategy: captureTier.strategy,
      captureTier: captureTier.tier,
      priceBand: captureTier.priceBand || resolvePlan3PriceBand(tokenPrice),
      direction: tradeDirection,
      label: tradeDirection === 'up' ? `${tierLabel} UP` : `${tierLabel} DOWN`,
      limitPrice,
      tokenPrice: round4(tokenPrice),
      usd: finalUsd,
      shares: round4(finalUsd / limitPrice),
      secondsRemaining,
      distanceFromOpenBps: round4(distanceFromOpenBps),
      recentReverseBps,
      volatilityBpsPerSecond,
      spread: Number.isFinite(spread) ? round4(spread) : null,
      maxSpread: skipSpreadCheck ? null : (Number.isFinite(maxSpread) ? round4(maxSpread) : null),
      spreadCheckSkipped: skipSpreadCheck || undefined,
      marketQuality: Number.isFinite(quality) ? round4(quality) : null,
      slotOpenPrice: round4(slotOpenPrice),
      referencePrice: round4(referencePrice),
      orderTtlMs: ttlMs,
      paperFillable,
      paperDirectFill,
      expectedFillPrice,
      fillBumpSteps: fillEstimate.bumpSteps ?? 0,
      maxLivePrice: captureTier.maxPrice,
      executionKey: submitKey,
      pmUpPrice,
      pmDownPrice,
      priceSource,
      settlementThresholdBps,
      entryConfirmation,
      paperMode: usePaperMode,
        strategyVersion: PLAN3_VERSION,
      lossReasonGate: lossGate.insufficientSamples
        ? { passed: true, insufficientSamples: true, sampleCount: lossGate.sampleCount }
        : {
          passed: true,
          sampleCount: lossGate.sampleCount,
          lossRate: lossGate.lossRate,
          sizeScale: lossGate.sizeScale
        },
      reason: `Plan3 ${tierLabel} ${tradeDirection.toUpperCase()}${paperModeLabel}，剩余 ${secondsRemaining}s，距开盘 ${Math.abs(distanceFromOpenBps).toFixed(1)} bps，反向 ${recentReverseBps.toFixed(1)} bps，限价 ${(limitPrice * 100).toFixed(2)}¢，token ${(tokenPrice * 100).toFixed(2)}¢${expectedFillPrice != null ? `，预期成交 ${(expectedFillPrice * 100).toFixed(2)}¢` : ''}${priceSource === 'pm_leading' ? '（PM 领先侧）' : ''}，$${finalUsd.toFixed(2)}。`
    }
  });
}

function buildPlan3ShellBase({
  symbol = 'BTC-USD',
  timeframe,
  slotIso = null,
  targetTimeIso = null,
  secondsRemaining = null,
  direction = null,
  distanceFromOpenBps = null,
  recentReverseBps = null,
  volatilityBpsPerSecond = null,
  tokenPrice = null,
  limitPrice = null,
  orderUsd = null,
  spread = null,
  quality = null,
  slotOpenPrice = null,
  referencePrice = null,
  now,
  action
}) {
  return {
    symbol,
    key: action?.executionKey || buildPlan3SlotKey(slotIso, timeframe, direction, symbol),
    planId: 'plan3',
    algorithm: 'plan3',
    timeframe,
    slotIso,
    targetTimeIso,
    generatedAtIso: now.toISOString(),
    secondsRemaining,
    direction,
    distanceFromOpenBps,
    recentReverseBps,
    volatilityBpsPerSecond,
    tokenPrice,
    limitPrice,
    orderUsd,
    spread,
    quality,
    slotOpenPrice,
    referencePrice,
    exitRule: {
      mode: 'settlement_redeem',
      takeProfitPrice: null,
      stopLossPrice: null
    },
    action
  };
}

export function computePlan3Analytics(orders = [], opportunities = []) {
  const plan3Orders = (orders || []).filter((order) => (order.planId || 'plan3') === 'plan3');
  const submitted = plan3Orders.filter((order) => order.fillStatus !== 'skipped');
  const filled = submitted.filter((order) => order.fillStatus === 'filled' || order.settlementStatus === 'open' || order.settlementStatus === 'settled');
  const settled = plan3Orders.filter((order) => order.settlementStatus === 'settled');
  const wins = settled.filter((order) => Number(order.pnl) > 0);
  const losses = settled.filter((order) => Number(order.pnl) < 0);
  const filledWins = filled.filter((order) => order.settlementStatus === 'settled' && Number(order.pnl) > 0);

  const sumSubmittedPnl = submitted.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
  const sumFilledPnl = filled.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
  const avgEntry = filled.length
    ? filled.reduce((sum, order) => sum + (Number(order.limitPrice ?? order.entryPrice) || 0), 0) / filled.length
    : 0;

  const skipCounts = {};
  for (const item of opportunities || []) {
    const reason = item.skipReason || item.action?.skipReason || 'unknown';
    skipCounts[reason] = (skipCounts[reason] || 0) + 1;
  }

  const byPriceBand = {};
  for (const order of settled) {
    const band = order.priceBand || resolvePlan3PriceBand(order.limitPrice ?? order.entryPrice);
    if (!byPriceBand[band]) {
      byPriceBand[band] = { orders: 0, wins: 0, losses: 0, totalPnl: 0 };
    }
    byPriceBand[band].orders += 1;
    byPriceBand[band].totalPnl = round2(byPriceBand[band].totalPnl + (Number(order.pnl) || 0));
    if (Number(order.pnl) > 0) byPriceBand[band].wins += 1;
    if (Number(order.pnl) < 0) byPriceBand[band].losses += 1;
  }
  for (const band of Object.keys(byPriceBand)) {
    const bucket = byPriceBand[band];
    bucket.winRate = bucket.orders ? round4(bucket.wins / bucket.orders) : 0;
    bucket.totalPnl = round2(bucket.totalPnl);
  }

  const summarizeSettled = (rows) => {
    const versionSettled = rows.filter((order) => order.settlementStatus === 'settled');
    const versionWins = versionSettled.filter((order) => Number(order.pnl) > 0).length;
    const invested = versionSettled.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const pnl = versionSettled.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
    return {
      settledOrders: versionSettled.length,
      wins: versionWins,
      losses: versionSettled.length - versionWins,
      winRate: versionSettled.length ? round4(versionWins / versionSettled.length) : null,
      invested: round2(invested),
      totalPnl: round2(pnl),
      roi: invested ? round4(pnl / invested) : null
    };
  };
  const byStrategyVersion = {};
  for (const order of settled) {
    const version = order.strategyVersion || 'legacy';
    if (!byStrategyVersion[version]) byStrategyVersion[version] = [];
    byStrategyVersion[version].push(order);
  }
  for (const version of Object.keys(byStrategyVersion)) {
    byStrategyVersion[version] = summarizeSettled(byStrategyVersion[version]);
  }

  return {
    submittedOrders: submitted.length,
    filledOrders: filled.filter((order) => order.fillStatus === 'filled' || order.settlementStatus !== 'pending').length,
    fillRate: submitted.length ? round4(filled.length / submitted.length) : 0,
    settledOrders: settled.length,
    winRateFilled: settled.length ? round4(filledWins.length / settled.length) : 0,
    winRateSettled: settled.length ? round4(wins.length / settled.length) : 0,
    losses: losses.length,
    avgEntryPrice: round4(avgEntry),
    avgGrossEdge: round4(1 - avgEntry),
    profitPerFilledOrder: filled.length ? round2(sumFilledPnl / filled.length) : 0,
    profitPerSubmittedOrder: submitted.length ? round2(sumSubmittedPnl / submitted.length) : 0,
    totalPnl: round2(settled.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0)),
    opportunitiesLogged: (opportunities || []).length,
    skipReasonCounts: skipCounts,
      wrongSettlementCount: losses.length,
      byPriceBand,
      strategyVersion: PLAN3_VERSION,
      forward: summarizeSettled(settled.filter((order) => order.strategyVersion === PLAN3_VERSION)),
      byStrategyVersion
  };
}
