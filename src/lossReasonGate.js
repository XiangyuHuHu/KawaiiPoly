/**
 * 亏损原因反馈门控：只使用下单前已经可识别的原因做 skip / 降仓。
 * 冷启动样本不足默认放行；不拖慢止损路径（仅入场前评估）。
 */
import {
  DEFAULT_AVOIDABLE_LOSS_REASONS,
  LOSS_REASON_LABELS,
  lossReasonLabel
} from './lossReasonTaxonomy.js';

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e4) / 1e4;
}

function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function clampNumber(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeFeatureKey(parts = {}) {
  return [
    parts.planId || 'plan',
    parts.timeframe || 'any',
    parts.entryType || 'any',
    parts.lockStrength || 'any',
    parts.band || 'any',
    parts.symbol || 'any'
  ].join('|');
}

/**
 * 从订单列表聚合某特征桶的亏损原因占比。
 * orders: { won, lossReason, timeframe, entryType, lockStrength, planId, symbol, ... }
 */
export function aggregateLossReasonBucket(orders = [], {
  planId = null,
  timeframe = null,
  entryType = null,
  lockStrength = null,
  band = null,
  symbol = null,
  reasons = DEFAULT_AVOIDABLE_LOSS_REASONS,
  sourceWeights = null,
  recencyHalfLifeDays = null,
  now = new Date()
} = {}) {
  const reasonSet = new Set((reasons || []).map(String));
  const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
  const filtered = (orders || []).filter((order) => {
    if (planId && String(order.planId || '') !== String(planId)) return false;
    if (timeframe && String(order.timeframe || '') !== String(timeframe)) return false;
    if (entryType && String(order.entryType || '') !== String(entryType)) return false;
    if (normalizedSymbol) {
      const orderSymbol = String(order.symbol || 'BTC-USD').toUpperCase();
      if (orderSymbol !== normalizedSymbol) return false;
    }
    if (lockStrength) {
      const strength = order.lockStrength
        || order.lossAnalysis?.detail?.lockStrength
        || null;
      if (String(strength || '').toLowerCase() !== String(lockStrength).toLowerCase()) return false;
    }
    if (band != null && order.band != null && String(order.band) !== String(band)) return false;
    const won = order.won;
    if (won !== true && won !== false && order.won !== 0 && order.won !== 1) {
      // allow pnl-derived
      if (!Number.isFinite(Number(order.pnl))) return false;
    }
    return true;
  });

  let total = 0;
  let losses = 0;
  let weightedTotal = 0;
  let weightedLosses = 0;
  const byReason = {};
  const weightedByReason = {};
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const halfLifeMs = Number(recencyHalfLifeDays) > 0
    ? Number(recencyHalfLifeDays) * 86_400_000
    : null;
  for (const order of filtered) {
    const won = order.won === true || order.won === 1
      ? true
      : order.won === false || order.won === 0
        ? false
        : Number(order.pnl) > 0
          ? true
          : Number(order.pnl) < 0
            ? false
            : null;
    if (won == null) continue;
    const source = String(order.source || 'paper').toLowerCase();
    const sourceWeight = sourceWeights && Number.isFinite(Number(sourceWeights[source]))
      ? Math.max(0, Number(sourceWeights[source]))
      : 1;
    const settledMs = Date.parse(order.settledAtIso || order.closedAtIso || '');
    const ageMs = Number.isFinite(settledMs) ? Math.max(0, nowMs - settledMs) : 0;
    const recencyWeight = halfLifeMs ? 0.5 ** (ageMs / halfLifeMs) : 1;
    const weight = sourceWeight * recencyWeight;
    total += 1;
    weightedTotal += weight;
    if (won) continue;
    losses += 1;
    weightedLosses += weight;
    const reason = order.lossReason || order.lossAnalysis?.lossReason || 'unknown';
    byReason[reason] = (byReason[reason] || 0) + 1;
    weightedByReason[reason] = (weightedByReason[reason] || 0) + weight;
  }

  let avoidableLosses = 0;
  let weightedAvoidableLosses = 0;
  for (const [reason, count] of Object.entries(byReason)) {
    if (reasonSet.has(reason)) avoidableLosses += count;
  }
  for (const [reason, count] of Object.entries(weightedByReason)) {
    if (reasonSet.has(reason)) weightedAvoidableLosses += count;
  }

  const rankedActionable = Object.entries(sourceWeights ? weightedByReason : byReason)
    .filter(([reason]) => reasonSet.has(reason))
    .sort((a, b) => b[1] - a[1]);
  const topReason = rankedActionable[0] || null;

  return {
    featureKey: normalizeFeatureKey({ planId, timeframe, entryType, lockStrength, band, symbol: normalizedSymbol }),
    total,
    losses,
    wins: total - losses,
    weightedTotal: round4(weightedTotal),
    weightedLosses: round4(weightedLosses),
    lossRate: weightedTotal ? weightedLosses / weightedTotal : 0,
    avoidableLosses,
    weightedAvoidableLosses: round4(weightedAvoidableLosses),
    avoidableLossRate: weightedTotal ? weightedAvoidableLosses / weightedTotal : 0,
    actionableLosses: avoidableLosses,
    weightedActionableLosses: round4(weightedAvoidableLosses),
    actionableLossRate: weightedTotal ? weightedAvoidableLosses / weightedTotal : 0,
    byReason,
    topReason: topReason ? { reason: topReason[0], count: topReason[1], label: lossReasonLabel(topReason[0]) } : null
  };
}

/**
 * @param {object} params
 * @param {object[]} [params.orders] 近期已结算订单（含 lossReason）
 * @param {object} [params.preaggregated] 若已有聚合结果可直接传入
 * @param {object} [params.config]
 */
export function evaluateLossReasonGate({
  planId,
  timeframe = null,
  entryType = null,
  lockStrength = null,
  band = null,
  symbol = null,
  orders = null,
  preaggregated = null,
  config = {},
  planLabel = null,
  sourceWeights = null,
  recencyHalfLifeDays = null,
  now = new Date()
} = {}) {
  if (config.lossReasonGateEnabled === false) {
    return { allowed: true, skipped: true, sizeScale: 1 };
  }

  const minSamples = Number(config.lossReasonGateMinSamples) || 12;
  const maxLossRate = Number(config.lossReasonGateMaxLossRate);
  const threshold = Number.isFinite(maxLossRate) ? maxLossRate : 0.55;
  const sizeScaleFloor = clampNumber(config.lossReasonGateSizeScaleFloor, 0.25, 1, 0.5);
  const label = planLabel || String(planId || 'Plan').replace(/^plan/i, 'Plan');

  const avoidable = Array.isArray(config.lossReasonGateAvoidableReasons)
    && config.lossReasonGateAvoidableReasons.length
    ? config.lossReasonGateAvoidableReasons
    : DEFAULT_AVOIDABLE_LOSS_REASONS;

  const stats = preaggregated || aggregateLossReasonBucket(orders || [], {
    planId,
    timeframe,
    entryType,
    lockStrength,
    band,
    symbol,
    reasons: avoidable,
    sourceWeights,
    recencyHalfLifeDays,
    now
  });

  const sampleCount = Number(stats.total) || 0;
  if (!sampleCount || sampleCount < minSamples) {
    if (config.lossReasonGateRequireSamples === true) {
      return {
        allowed: false,
        insufficientSamples: true,
        sampleCount,
        minSamples,
        sizeScale: 1,
        stats,
        reason: `${label} 亏损归因样本不足（${sampleCount}/${minSamples}），暂缓开仓。`
      };
    }
    return {
      allowed: true,
      insufficientSamples: true,
      sampleCount,
      minSamples,
      sizeScale: 1,
      stats
    };
  }

  const lossRate = Number(stats.actionableLossRate ?? stats.avoidableLossRate);
  const rate = Number.isFinite(lossRate) ? lossRate : Number(stats.lossRate) || 0;
  const top = stats.topReason;

  if (rate >= threshold) {
    const topText = top
      ? `主因 ${top.label || LOSS_REASON_LABELS[top.reason] || top.reason}（${formatCount(top.count)}）`
      : '下单前可识别亏损占比过高';
    return {
      allowed: false,
      sampleCount,
      lossRate: round4(rate),
      threshold: round4(threshold),
      sizeScale: 1,
      stats,
      reason: `${label} 近期同类下单前可识别亏损占比 ${(rate * 100).toFixed(0)}%（${stats.actionableLosses ?? stats.avoidableLosses}/${sampleCount}）≥ ${(threshold * 100).toFixed(0)}%，${topText}，跳过重复错误模式。`
    };
  }

  // 接近阈值时略降仓，远离则不缩放
  let sizeScale = 1;
  if (config.lossReasonGateSizeScaleEnabled !== false && rate > threshold * 0.7) {
    const t = (rate - threshold * 0.7) / Math.max(1e-6, threshold * 0.3);
    sizeScale = clampNumber(1 - t * (1 - sizeScaleFloor), sizeScaleFloor, 1, 1);
  }

  return {
    allowed: true,
    sampleCount,
    lossRate: round4(rate),
    threshold: round4(threshold),
    sizeScale: round4(sizeScale),
    stats
  };
}
