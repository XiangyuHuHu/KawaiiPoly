/**
 * Plan3 亏损原因分析（纸面 + 实盘）。
 * 专注记录/归因，不改仓位或下单逻辑。
 */
import { getWindowTrackSnapshot } from './polymarketWindowTrack.js';

export const PLAN3_LOSS_REASONS = Object.freeze({
  DIRECTION_WRONG: 'direction_wrong',
  FLIP_INTO_ENTRY: 'flip_into_entry',
  POST_ENTRY_PM_REVERSAL: 'post_entry_pm_reversal',
  HIGH_ENTRY_NEGATIVE_EV: 'high_entry_negative_ev',
  LATE_ENTRY_EXPENSIVE: 'late_entry_expensive',
  FAK_FILL_WORSE: 'fak_fill_worse',
  UNKNOWN: 'unknown'
});

export const PLAN3_LOSS_REASON_LABELS = Object.freeze({
  [PLAN3_LOSS_REASONS.DIRECTION_WRONG]: '方向错误（到期反向）',
  [PLAN3_LOSS_REASONS.FLIP_INTO_ENTRY]: '入场前大幅反转后追入',
  [PLAN3_LOSS_REASONS.POST_ENTRY_PM_REVERSAL]: '入场后 PM 大幅反转',
  [PLAN3_LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV]: '高价入场负期望',
  [PLAN3_LOSS_REASONS.LATE_ENTRY_EXPENSIVE]: '过晚高价入场',
  [PLAN3_LOSS_REASONS.FAK_FILL_WORSE]: 'FAK/成交价劣于意图价',
  [PLAN3_LOSS_REASONS.UNKNOWN]: '未知'
});

const DEFAULT_REVERSAL_LOOKBACK_MS = 5 * 60 * 1000;
const DEFAULT_EXTREME_PRICE = 0.95;
const DEFAULT_HIGH_ENTRY_PRICE = 0.97;
const DEFAULT_LATE_SECONDS = 15;

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e4) / 1e4;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function normalizeDirection(value) {
  const dir = String(value || '').toLowerCase();
  return dir === 'up' || dir === 'down' ? dir : null;
}

function oppositeDirection(direction) {
  const dir = normalizeDirection(direction);
  if (dir === 'up') return 'down';
  if (dir === 'down') return 'up';
  return null;
}

function sampleTs(sample) {
  if (Number.isFinite(Number(sample?.ts))) return Number(sample.ts);
  if (sample?.iso) {
    const ms = Date.parse(sample.iso);
    return Number.isFinite(ms) ? ms : null;
  }
  if (sample?.recordedAtIso) {
    const ms = Date.parse(sample.recordedAtIso);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function dominantSide(sample, extremePrice = DEFAULT_EXTREME_PRICE) {
  const up = Number(sample?.upPrice ?? sample?.pmUpPrice);
  const down = Number(sample?.downPrice ?? sample?.pmDownPrice);
  const extreme = Number(extremePrice) || DEFAULT_EXTREME_PRICE;
  if (Number.isFinite(up) && up >= extreme) return 'up';
  if (Number.isFinite(down) && down >= extreme) return 'down';
  return null;
}

function normalizePmSample(raw = {}) {
  const up = Number(raw.upPrice ?? raw.pmUpPrice);
  const down = Number(raw.downPrice ?? raw.pmDownPrice);
  const token = Number(raw.tokenPrice);
  let upPrice = Number.isFinite(up) ? up : null;
  let downPrice = Number.isFinite(down) ? down : null;
  // opportunity log 有时只写 leading tokenPrice
  if ((upPrice == null || downPrice == null) && Number.isFinite(token)) {
    const dir = normalizeDirection(raw.direction);
    if (dir === 'up') {
      upPrice = upPrice ?? token;
      downPrice = downPrice ?? round4(Math.max(0, 1 - token));
    } else if (dir === 'down') {
      downPrice = downPrice ?? token;
      upPrice = upPrice ?? round4(Math.max(0, 1 - token));
    }
  }
  const ts = sampleTs(raw);
  return {
    ts,
    iso: ts != null ? new Date(ts).toISOString() : (raw.iso || raw.recordedAtIso || null),
    upPrice: round4(upPrice),
    downPrice: round4(downPrice),
    tokenPrice: Number.isFinite(token) ? round4(token) : null,
    direction: normalizeDirection(raw.direction),
    source: raw.source || null
  };
}

/**
 * 检测 lookback 内是否出现「一侧极端 → 对侧极端」的大幅反转。
 */
function finiteMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function detectPmReversal(samples = [], {
  lookbackMs = DEFAULT_REVERSAL_LOOKBACK_MS,
  extremePrice = DEFAULT_EXTREME_PRICE,
  asOfMs = null,
  fromMs = null,
  toMs = null
} = {}) {
  const endMs = finiteMs(toMs) ?? finiteMs(asOfMs) ?? Date.now();
  const startMs = finiteMs(fromMs) ?? (endMs - (Number(lookbackMs) || DEFAULT_REVERSAL_LOOKBACK_MS));

  const normalized = (samples || [])
    .map(normalizePmSample)
    .filter((sample) => sample.ts != null && sample.ts >= startMs && sample.ts <= endMs)
    .sort((a, b) => a.ts - b.ts);

  if (normalized.length < 2) {
    return {
      detected: false,
      flipped: false,
      fromSide: null,
      toSide: null,
      fromSample: null,
      toSample: null,
      magnitude: null,
      lookbackMs: Number(lookbackMs) || DEFAULT_REVERSAL_LOOKBACK_MS,
      sampleCount: normalized.length
    };
  }

  let firstExtreme = null;
  let oppositeExtreme = null;
  for (const sample of normalized) {
    const side = dominantSide(sample, extremePrice);
    if (!side) continue;
    if (!firstExtreme) {
      firstExtreme = { side, sample };
      continue;
    }
    if (side !== firstExtreme.side) {
      oppositeExtreme = { side, sample };
      break;
    }
    // 同侧更极端则刷新起点
    const priceField = side === 'up' ? 'upPrice' : 'downPrice';
    const prev = Number(firstExtreme.sample[priceField]);
    const next = Number(sample[priceField]);
    if (Number.isFinite(next) && (!Number.isFinite(prev) || next >= prev)) {
      firstExtreme = { side, sample };
    }
  }

  if (!firstExtreme || !oppositeExtreme) {
    return {
      detected: false,
      flipped: false,
      fromSide: firstExtreme?.side || null,
      toSide: null,
      fromSample: firstExtreme?.sample || null,
      toSample: null,
      magnitude: null,
      lookbackMs: Number(lookbackMs) || DEFAULT_REVERSAL_LOOKBACK_MS,
      sampleCount: normalized.length
    };
  }

  const fromPrice = Number(
    firstExtreme.side === 'up' ? firstExtreme.sample.upPrice : firstExtreme.sample.downPrice
  );
  const toPrice = Number(
    oppositeExtreme.side === 'up' ? oppositeExtreme.sample.upPrice : oppositeExtreme.sample.downPrice
  );
  const magnitude = Number.isFinite(fromPrice) && Number.isFinite(toPrice)
    ? round4(fromPrice + toPrice)
    : null;

  return {
    detected: true,
    flipped: true,
    fromSide: firstExtreme.side,
    toSide: oppositeExtreme.side,
    fromSample: firstExtreme.sample,
    toSample: oppositeExtreme.sample,
    magnitude,
    lookbackMs: Number(lookbackMs) || DEFAULT_REVERSAL_LOOKBACK_MS,
    sampleCount: normalized.length,
    flipLagMs: oppositeExtreme.sample.ts - firstExtreme.sample.ts
  };
}

function pickSnapshotNear(samples, targetMs, maxDeltaMs = 30_000) {
  if (!Number.isFinite(targetMs) || !samples?.length) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const raw of samples) {
    const sample = normalizePmSample(raw);
    if (sample.ts == null) continue;
    const delta = Math.abs(sample.ts - targetMs);
    if (delta < bestDelta) {
      best = sample;
      bestDelta = delta;
    }
  }
  if (!best || bestDelta > maxDeltaMs) return best;
  return best;
}

export function collectPlan3PmSamples({
  order = null,
  opportunityLog = [],
  windowTrack = null,
  extraSamples = []
} = {}) {
  const samples = [];
  const track = windowTrack || (
    order?.slotIso && order?.timeframe
      ? getWindowTrackSnapshot(order.slotIso, order.timeframe, order.symbol)
      : null
  );
  for (const sample of track?.samples || []) {
    samples.push({ ...sample, source: 'window_track' });
  }
  for (const item of opportunityLog || []) {
    if (order?.slotIso && item.slotIso && item.slotIso !== order.slotIso) continue;
    if (order?.timeframe && item.timeframe && item.timeframe !== order.timeframe) continue;
    samples.push({
      ...item,
      upPrice: item.pmUpPrice ?? item.upPrice,
      downPrice: item.pmDownPrice ?? item.downPrice,
      source: 'opportunity_log'
    });
  }
  if (order?.entryPmSnapshot) {
    samples.push({ ...order.entryPmSnapshot, source: 'entry_snapshot' });
  }
  if (order?.pmUpPrice != null || order?.pmDownPrice != null) {
    samples.push({
      ts: Date.parse(order.filledAtIso || order.orderFilledAtIso || order.createdAtIso || 0) || Date.now(),
      upPrice: order.pmUpPrice,
      downPrice: order.pmDownPrice,
      direction: order.direction,
      source: 'order_pm'
    });
  }
  for (const sample of extraSamples || []) samples.push(sample);
  return samples.map(normalizePmSample).filter((s) => s.ts != null);
}

/**
 * 入场时写入的轻量上下文（挂到订单上，供结算归因）。
 */
export function buildPlan3EntryContext({
  plan = null,
  sentiment = null,
  action = null,
  now = new Date(),
  lookbackMs = DEFAULT_REVERSAL_LOOKBACK_MS,
  extremePrice = DEFAULT_EXTREME_PRICE
} = {}) {
  const act = action || plan?.action || {};
  const slotIso = plan?.slotIso || act.slotIso || null;
  const timeframe = plan?.timeframe || act.timeframe || null;
  const symbol = plan?.symbol || act.symbol || sentiment?.symbol || 'BTC-USD';
  const direction = normalizeDirection(act.direction);
  const nowMs = now.getTime();
  const track = slotIso && timeframe ? getWindowTrackSnapshot(slotIso, timeframe, symbol) : null;
  const samples = collectPlan3PmSamples({
    order: {
      slotIso,
      timeframe,
      symbol,
      direction,
      pmUpPrice: act.pmUpPrice ?? sentiment?.upPrice,
      pmDownPrice: act.pmDownPrice ?? sentiment?.downPrice,
      createdAtIso: now.toISOString()
    },
    windowTrack: track
  });
  const preEntryReversal = detectPmReversal(samples, {
    lookbackMs,
    extremePrice,
    asOfMs: nowMs
  });
  const entryPmSnapshot = {
    ts: nowMs,
    iso: now.toISOString(),
    upPrice: round4(act.pmUpPrice ?? sentiment?.upPrice),
    downPrice: round4(act.pmDownPrice ?? sentiment?.downPrice),
    tokenPrice: round4(act.tokenPrice ?? act.limitPrice),
    direction,
    source: 'entry'
  };

  return {
    capturedAtIso: now.toISOString(),
    slotIso,
    timeframe,
    direction,
    entryPrice: round4(act.limitPrice ?? act.tokenPrice),
    intendedLimitPrice: round4(act.limitPrice),
    tokenPrice: round4(act.tokenPrice),
    secondsRemaining: Number.isFinite(Number(act.secondsRemaining)) ? Number(act.secondsRemaining) : null,
    distanceFromOpenBps: Number.isFinite(Number(act.distanceFromOpenBps)) ? Number(act.distanceFromOpenBps) : null,
    recentReverseBps: Number.isFinite(Number(act.recentReverseBps)) ? Number(act.recentReverseBps) : null,
    volatilityBpsPerSecond: Number.isFinite(Number(act.volatilityBpsPerSecond)) ? Number(act.volatilityBpsPerSecond) : null,
    entryConfirmation: act.entryConfirmation || null,
    strategyVersion: act.strategyVersion || null,
    entryPmSnapshot,
    preEntryPmReversal: preEntryReversal,
    windowSampleCount: track?.sampleCount ?? samples.length
  };
}

function resolveEntryMs(order) {
  const iso = order?.filledAtIso || order?.orderFilledAtIso || order?.createdAtIso;
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? ms : null;
}

function resolveSettleMs(order) {
  const iso = order?.settledAtIso || order?.closedAtIso;
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * 分类 Plan3 亏损（或结算）原因。胜利用 `win` / null lossReason。
 */
export function classifyPlan3LossReason(order = {}, {
  samples = null,
  lookbackMs = DEFAULT_REVERSAL_LOOKBACK_MS,
  extremePrice = DEFAULT_EXTREME_PRICE,
  highEntryPrice = DEFAULT_HIGH_ENTRY_PRICE,
  lateSeconds = DEFAULT_LATE_SECONDS
} = {}) {
  const direction = normalizeDirection(order.direction);
  const actual = normalizeDirection(order.actualDirection);
  const pnl = Number(order.pnl);
  const entryPrice = Number(order.entryPrice ?? order.limitPrice ?? order.fillPrice);
  const fillPrice = Number(order.fillPrice ?? order.avgFillPrice ?? order.entryPrice ?? order.limitPrice);
  const intended = Number(
    order.intendedLimitPrice
    ?? order.entryContext?.intendedLimitPrice
    ?? order.limitPrice
  );
  const secondsRemaining = Number(
    order.secondsRemaining
    ?? order.entryContext?.secondsRemaining
  );
  const entryMs = resolveEntryMs(order);
  const settleMs = resolveSettleMs(order);
  const pmSamples = samples || collectPlan3PmSamples({ order });

  const preEntryReversal = detectPmReversal(pmSamples, {
    lookbackMs,
    extremePrice,
    asOfMs: entryMs ?? settleMs
  });
  const postEntryReversal = entryMs != null
    ? detectPmReversal(pmSamples, {
      lookbackMs,
      extremePrice,
      fromMs: entryMs,
      toMs: settleMs
    })
    : { detected: false, flipped: false };

  // 若轨迹样本不足，用入场极端价 + 结算附近对侧极端价推断入场后反转
  if (!postEntryReversal.flipped && direction && Number.isFinite(entryPrice) && entryPrice >= extremePrice) {
    const settleSnap = pickSnapshotNear(pmSamples, settleMs, 120_000);
    const settleOpp = settleSnap
      ? Number(direction === 'up' ? settleSnap.downPrice : settleSnap.upPrice)
      : null;
    if (Number.isFinite(settleOpp) && settleOpp >= extremePrice) {
      Object.assign(postEntryReversal, {
        detected: true,
        flipped: true,
        fromSide: direction,
        toSide: oppositeDirection(direction),
        fromSample: {
          ts: entryMs,
          iso: entryMs != null ? new Date(entryMs).toISOString() : null,
          upPrice: direction === 'up' ? round4(entryPrice) : round4(Math.max(0, 1 - entryPrice)),
          downPrice: direction === 'down' ? round4(entryPrice) : round4(Math.max(0, 1 - entryPrice)),
          source: 'entry_price_inferred'
        },
        toSample: settleSnap,
        magnitude: round4(entryPrice + settleOpp),
        lookbackMs,
        sampleCount: pmSamples.length,
        inferred: true
      });
    }
  }

  const tags = [];
  let primary = PLAN3_LOSS_REASONS.UNKNOWN;

  const isLoss = Number.isFinite(pnl) ? pnl < 0 : (actual && direction && actual !== direction);
  const isWin = Number.isFinite(pnl) ? pnl > 0 : (actual && direction && actual === direction);

  if (isWin) {
    return {
      isLoss: false,
      isWin: true,
      lossReason: null,
      lossReasonLabel: null,
      tags: ['win'],
      pmReversal: {
        preEntry: preEntryReversal,
        postEntry: postEntryReversal,
        anyLargeReversal: Boolean(preEntryReversal.flipped || postEntryReversal.flipped)
      },
      entryPrice: round4(entryPrice),
      fillPrice: round4(fillPrice),
      intendedLimitPrice: round4(intended),
      pnl: round2(pnl),
      direction,
      actualDirection: actual
    };
  }

  if (!isLoss) {
    return {
      isLoss: false,
      isWin: false,
      lossReason: null,
      lossReasonLabel: null,
      tags: ['flat_or_unsettled'],
      pmReversal: {
        preEntry: preEntryReversal,
        postEntry: postEntryReversal,
        anyLargeReversal: Boolean(preEntryReversal.flipped || postEntryReversal.flipped)
      },
      entryPrice: round4(entryPrice),
      fillPrice: round4(fillPrice),
      intendedLimitPrice: round4(intended),
      pnl: round2(pnl),
      direction,
      actualDirection: actual
    };
  }

  // 亏损主因优先级：入场前追反转 > 入场后反转 > FAK 劣价 > 过晚高价 > 高价负 EV > 方向错误
  if (
    preEntryReversal.flipped
    && direction
    && preEntryReversal.toSide === direction
    && preEntryReversal.fromSide === oppositeDirection(direction)
  ) {
    primary = PLAN3_LOSS_REASONS.FLIP_INTO_ENTRY;
    tags.push(PLAN3_LOSS_REASONS.FLIP_INTO_ENTRY);
  } else if (
    postEntryReversal.flipped
    && direction
    && postEntryReversal.fromSide === direction
    && postEntryReversal.toSide === oppositeDirection(direction)
  ) {
    primary = PLAN3_LOSS_REASONS.POST_ENTRY_PM_REVERSAL;
    tags.push(PLAN3_LOSS_REASONS.POST_ENTRY_PM_REVERSAL);
  }

  if (
    Number.isFinite(fillPrice)
    && Number.isFinite(intended)
    && fillPrice - intended >= 0.01
  ) {
    tags.push(PLAN3_LOSS_REASONS.FAK_FILL_WORSE);
    if (primary === PLAN3_LOSS_REASONS.UNKNOWN) {
      primary = PLAN3_LOSS_REASONS.FAK_FILL_WORSE;
    }
  }

  if (
    Number.isFinite(secondsRemaining)
    && secondsRemaining <= lateSeconds
    && Number.isFinite(entryPrice)
    && entryPrice >= highEntryPrice
  ) {
    tags.push(PLAN3_LOSS_REASONS.LATE_ENTRY_EXPENSIVE);
    if (primary === PLAN3_LOSS_REASONS.UNKNOWN) {
      primary = PLAN3_LOSS_REASONS.LATE_ENTRY_EXPENSIVE;
    }
  }

  if (Number.isFinite(entryPrice) && entryPrice >= highEntryPrice) {
    tags.push(PLAN3_LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV);
    if (primary === PLAN3_LOSS_REASONS.UNKNOWN) {
      primary = PLAN3_LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV;
    }
  }

  if (direction && actual && direction !== actual) {
    tags.push(PLAN3_LOSS_REASONS.DIRECTION_WRONG);
    if (primary === PLAN3_LOSS_REASONS.UNKNOWN) {
      primary = PLAN3_LOSS_REASONS.DIRECTION_WRONG;
    }
  }

  if (primary === PLAN3_LOSS_REASONS.UNKNOWN) {
    primary = PLAN3_LOSS_REASONS.DIRECTION_WRONG;
    tags.push(PLAN3_LOSS_REASONS.DIRECTION_WRONG);
  }

  const preSnap = pickSnapshotNear(pmSamples, entryMs != null ? entryMs - Math.min(lookbackMs, 120_000) : null);
  const atEntrySnap = pickSnapshotNear(pmSamples, entryMs)
    || order.entryPmSnapshot
    || order.entryContext?.entryPmSnapshot
    || null;
  const nearSettleSnap = pickSnapshotNear(pmSamples, settleMs);

  return {
    isLoss: true,
    isWin: false,
    lossReason: primary,
    lossReasonLabel: PLAN3_LOSS_REASON_LABELS[primary] || primary,
    tags: [...new Set(tags)],
    pmReversal: {
      preEntry: preEntryReversal,
      postEntry: postEntryReversal,
      anyLargeReversal: Boolean(preEntryReversal.flipped || postEntryReversal.flipped)
    },
    snapshots: {
      preEntry: preSnap,
      atEntry: atEntrySnap ? normalizePmSample(atEntrySnap) : null,
      nearSettle: nearSettleSnap
    },
    entryPrice: round4(entryPrice),
    fillPrice: round4(fillPrice),
    intendedLimitPrice: round4(intended),
    pnl: round2(pnl),
    direction,
    actualDirection: actual,
    slotIso: order.slotIso || null,
    timeframe: order.timeframe || null,
    secondsRemaining: Number.isFinite(secondsRemaining) ? secondsRemaining : null
  };
}

/**
 * 结算后写入 order.lossAnalysis（胜负都记，便于对照）。
 */
export function applyPlan3SettlementLossAnalysis(order, {
  opportunityLog = [],
  windowTrack = null,
  lookbackMs = DEFAULT_REVERSAL_LOOKBACK_MS,
  extremePrice = DEFAULT_EXTREME_PRICE,
  highEntryPrice = DEFAULT_HIGH_ENTRY_PRICE,
  lateSeconds = DEFAULT_LATE_SECONDS,
  now = new Date()
} = {}) {
  if (!order || (order.planId && order.planId !== 'plan3')) return false;
  const isPlan3 = order.planId === 'plan3'
    || order.entryType === 'settlement_capture'
    || order.entryType === 'settlement_capture_early'
    || String(order.algorithm || '').includes('plan3');
  if (!isPlan3) return false;
  if (order.exitStatus === 'expired-unfilled') return false;
  if (order.won == null && !Number.isFinite(Number(order.pnl)) && !order.actualDirection) return false;

  const samples = collectPlan3PmSamples({ order, opportunityLog, windowTrack });
  const classified = classifyPlan3LossReason(order, {
    samples,
    lookbackMs,
    extremePrice,
    highEntryPrice,
    lateSeconds
  });

  order.lossAnalysis = {
    ...classified,
    strategyVersion: order.strategyVersion || order.entryContext?.strategyVersion || order.plan?.action?.strategyVersion || null,
    entryConfirmation: order.entryConfirmation || order.entryContext?.entryConfirmation || order.plan?.action?.entryConfirmation || null,
    distanceFromOpenBps: Number.isFinite(Number(order.distanceFromOpenBps ?? order.entryContext?.distanceFromOpenBps))
      ? Number(order.distanceFromOpenBps ?? order.entryContext?.distanceFromOpenBps)
      : null,
    recentReverseBps: Number.isFinite(Number(order.recentReverseBps ?? order.entryContext?.recentReverseBps))
      ? Number(order.recentReverseBps ?? order.entryContext?.recentReverseBps)
      : null,
    volatilityBpsPerSecond: Number.isFinite(Number(order.volatilityBpsPerSecond ?? order.entryContext?.volatilityBpsPerSecond))
      ? Number(order.volatilityBpsPerSecond ?? order.entryContext?.volatilityBpsPerSecond)
      : null,
    analyzedAtIso: now.toISOString(),
    sampleCount: samples.length,
    lookbackMs,
    extremePrice
  };
  order.lossReason = classified.lossReason;
  order.pmReversal = classified.pmReversal?.anyLargeReversal === true;
  return true;
}

export function listPlan3Losses(orders = [], { limit = 50 } = {}) {
  return (orders || [])
    .filter((order) => {
      const plan3 = order.planId === 'plan3'
        || order.entryType === 'settlement_capture'
        || order.entryType === 'settlement_capture_early';
      if (!plan3) return false;
      if (order.exitStatus === 'expired-unfilled') return false;
      return Number(order.pnl) < 0 || order.won === false;
    })
    .slice()
    .sort((a, b) => {
      const aMs = Date.parse(a.settledAtIso || a.closedAtIso || a.createdAtIso || 0);
      const bMs = Date.parse(b.settledAtIso || b.closedAtIso || b.createdAtIso || 0);
      return bMs - aMs;
    })
    .slice(0, Math.max(1, Number(limit) || 50))
    .map((order) => ({
      id: order.id,
      source: order.source || null,
      timeframe: order.timeframe || null,
      direction: order.direction || null,
      actualDirection: order.actualDirection || null,
      entryPrice: Number(order.entryPrice ?? order.limitPrice) || null,
      fillPrice: Number(order.fillPrice ?? order.entryPrice ?? order.limitPrice) || null,
      usd: Number(order.usd) || null,
      pnl: Number(order.pnl) || null,
      slotIso: order.slotIso || null,
      createdAtIso: order.createdAtIso || null,
      settledAtIso: order.settledAtIso || order.closedAtIso || null,
      lossReason: order.lossReason || order.lossAnalysis?.lossReason || null,
      lossReasonLabel: order.lossAnalysis?.lossReasonLabel
        || PLAN3_LOSS_REASON_LABELS[order.lossReason]
        || null,
      pmReversal: order.pmReversal ?? order.lossAnalysis?.pmReversal?.anyLargeReversal ?? null,
      tags: order.lossAnalysis?.tags || [],
      lossAnalysis: order.lossAnalysis || null
    }));
}

export function computePlan3LossAnalytics(orders = [], {
  opportunityLog = [],
  backfill = true,
  lookbackMs = DEFAULT_REVERSAL_LOOKBACK_MS
} = {}) {
  const plan3Orders = (orders || []).filter((order) => (
    order.planId === 'plan3'
    || order.entryType === 'settlement_capture'
    || order.entryType === 'settlement_capture_early'
  ));
  const settled = plan3Orders.filter((order) => (
    order.settlementStatus === 'settled'
    || order.positionStatus === 'closed'
    || order.won != null
    || Number.isFinite(Number(order.pnl))
  )).filter((order) => order.exitStatus !== 'expired-unfilled');

  if (backfill) {
    for (const order of settled) {
      if (!order.lossAnalysis) {
        applyPlan3SettlementLossAnalysis(order, { opportunityLog, lookbackMs });
      }
    }
  }

  const losses = settled.filter((order) => Number(order.pnl) < 0 || order.won === false);
  const wins = settled.filter((order) => Number(order.pnl) > 0 || order.won === true);
  const reasonCounts = {};
  let reversalLosses = 0;
  for (const order of losses) {
    const reason = order.lossReason || order.lossAnalysis?.lossReason || PLAN3_LOSS_REASONS.UNKNOWN;
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    if (order.pmReversal || order.lossAnalysis?.pmReversal?.anyLargeReversal) {
      reversalLosses += 1;
    }
  }

  return {
    settledOrders: settled.length,
    wins: wins.length,
    losses: losses.length,
    winRate: settled.length ? round4(wins.length / settled.length) : 0,
    totalLossPnl: round2(losses.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0)),
    totalWinPnl: round2(wins.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0)),
    reasonCounts,
    reversalLosses,
    reversalLossShare: losses.length ? round4(reversalLosses / losses.length) : 0,
    recentLosses: listPlan3Losses(losses, { limit: 30 })
  };
}

function formatShanghaiLocal(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return `${(n * 100).toFixed(1)}%`;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n >= 0 ? `$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

export function renderPlan3LossMarkdown(analytics = {}, {
  title = 'Plan3 亏损原因统计',
  generatedAtIso = new Date().toISOString(),
  scope = 'all'
} = {}) {
  const reasonRows = Object.entries(analytics.reasonCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `| ${PLAN3_LOSS_REASON_LABELS[reason] || reason} | ${count} |`)
    .join('\n');

  const recentRows = (analytics.recentLosses || []).map((order) => (
    `| ${formatShanghaiLocal(order.settledAtIso || order.createdAtIso)} | ${order.timeframe || '--'} | ${order.direction || '--'} | ${order.actualDirection || '--'} | ${order.entryPrice ?? '--'} | ${money(order.pnl)} | ${order.lossReasonLabel || order.lossReason || '--'} | ${order.pmReversal ? '是' : '否'} |`
  )).join('\n');

  return [
    '---',
    'tags:',
    '  - polymarket',
    '  - plan3',
    '  - loss-analysis',
    `  - ${scope}`,
    '---',
    '',
    `# ${title}`,
    '',
    `> 更新时间：${formatShanghaiLocal(generatedAtIso)}`,
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    `| 已结算 | ${analytics.settledOrders ?? 0} |`,
    `| 盈利 | ${analytics.wins ?? 0} |`,
    `| 亏损 | ${analytics.losses ?? 0} |`,
    `| 胜率 | ${pct(analytics.winRate)} |`,
    `| 亏损合计 | ${money(analytics.totalLossPnl)} |`,
    `| 盈利合计 | ${money(analytics.totalWinPnl)} |`,
    `| 含大幅反转的亏损 | ${analytics.reversalLosses ?? 0} |`,
    `| 反转亏损占比 | ${pct(analytics.reversalLossShare)} |`,
    '',
    '## 亏损原因分布',
    '',
    '| 原因 | 笔数 |',
    '| --- | ---: |',
    reasonRows || '| -- | 0 |',
    '',
    '## 最近亏损',
    '',
    '| 时间 | 周期 | 押注 | 到期 | 入场价 | PnL | 原因 | 反转 |',
    '| --- | --- | --- | --- | ---: | ---: | --- | --- |',
    recentRows || '| -- | -- | -- | -- | -- | -- | -- | -- |',
    '',
    '---',
    '',
    '*由 polymarketPlan3LossAnalytics 自动生成*',
    ''
  ].join('\n');
}
