const VALID_DIRECTIONS = new Set(['up', 'down']);

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function normalizeDirection(value) {
  const direction = String(value || '').toLowerCase();
  return VALID_DIRECTIONS.has(direction) ? direction : null;
}

export function resolvePlan5PriceBucket(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return null;
  const lower = Math.min(0.9, Math.floor((value + 1e-9) * 10) / 10);
  const upper = lower >= 0.9 ? 1 : lower + 0.1;
  return {
    key: lower >= 0.9 ? '0.90-1.00' : `${lower.toFixed(2)}-${upper.toFixed(2)}`,
    lower,
    upper
  };
}

function inPriceBucket(price, bucket) {
  const value = Number(price);
  if (!bucket || !Number.isFinite(value)) return false;
  return value >= bucket.lower && (bucket.upper >= 1 ? value < 1 : value < bucket.upper);
}

function dateMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function summarizeBinary(rows, priorProbability = 0.5, priorStrength = 6) {
  const usable = (Array.isArray(rows) ? rows : []).filter((row) => row?.won === true || row?.won === false);
  const wins = usable.reduce((total, row) => total + (row.won === true ? 1 : 0), 0);
  const total = usable.length;
  const prior = clamp(priorProbability, 0.01, 0.99, 0.5);
  const strength = Math.max(0, Number(priorStrength) || 0);
  const winRate = total ? wins / total : prior;
  const calibratedWinRate = (wins + prior * strength) / Math.max(1, total + strength);
  const totalUsd = usable.reduce((sum, row) => sum + Math.max(0, Number(row.usd) || 0), 0);
  const totalPnl = usable.reduce((sum, row) => sum + (Number(row.pnl) || 0), 0);
  return {
    total,
    wins,
    losses: total - wins,
    winRate: round4(winRate),
    calibratedWinRate: round4(calibratedWinRate),
    totalPnl: round4(totalPnl),
    realizedRoi: totalUsd > 0 ? round4(totalPnl / totalUsd) : null
  };
}

function summarizeJudgments(rows, priorProbability = 0.5, priorStrength = 6) {
  return summarizeBinary(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.correct === true || row?.correct === false)
      .map((row) => ({ won: row.correct, usd: 0, pnl: 0 })),
    priorProbability,
    priorStrength
  );
}

function blendRecentAndLongTerm(recent, longTerm, recentWeight = 0.7) {
  if (!longTerm?.total) return 0.5;
  if (!recent?.total) return longTerm.calibratedWinRate;
  const weight = clamp(recentWeight, 0, 1, 0.7) * Math.min(1, recent.total / 12);
  return round4(
    recent.calibratedWinRate * weight
      + longTerm.calibratedWinRate * (1 - weight)
  );
}

function uniqueActualWindows(rows = [], beforeTargetIso = null) {
  const beforeMs = dateMs(beforeTargetIso) || Number.POSITIVE_INFINITY;
  const byTarget = new Map();
  for (const row of rows) {
    const direction = normalizeDirection(row?.actualDirection);
    const targetMs = dateMs(row?.targetTimeIso);
    if (!direction || !targetMs || targetMs >= beforeMs) continue;
    const previous = byTarget.get(targetMs);
    if (!previous || dateMs(row.evaluatedAtIso) >= dateMs(previous.evaluatedAtIso)) {
      byTarget.set(targetMs, row);
    }
  }
  return [...byTarget.values()].sort((a, b) => dateMs(a.targetTimeIso) - dateMs(b.targetTimeIso));
}

export function buildPlan5ContinuityEvidence(rows = [], {
  targetTimeIso = null,
  minSamples = 10,
  maxStreak = 4
} = {}) {
  const windows = uniqueActualWindows(rows, targetTimeIso);
  if (!windows.length) return { available: false, sampleCount: 0, streak: 0 };

  let currentDirection = normalizeDirection(windows.at(-1)?.actualDirection);
  let currentStreak = 0;
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    if (normalizeDirection(windows[index]?.actualDirection) !== currentDirection) break;
    currentStreak += 1;
  }
  const streakBucket = Math.min(Math.max(1, currentStreak), Math.max(1, Number(maxStreak) || 4));
  const exact = [];
  const fallback = [];
  let previousDirection = null;
  let previousStreak = 0;
  for (const window of windows) {
    const actual = normalizeDirection(window.actualDirection);
    if (previousDirection) {
      const continued = actual === previousDirection;
      fallback.push({ won: continued, usd: 0, pnl: 0 });
      if (
        previousDirection === currentDirection
        && Math.min(previousStreak, Math.max(1, Number(maxStreak) || 4)) === streakBucket
      ) {
        exact.push({ won: continued, usd: 0, pnl: 0 });
      }
    }
    if (actual === previousDirection) previousStreak += 1;
    else {
      previousDirection = actual;
      previousStreak = 1;
    }
  }
  const required = Math.max(1, Number(minSamples) || 10);
  const sample = exact.length >= required ? exact : fallback;
  const summary = summarizeBinary(sample, 0.5, 8);
  return {
    available: sample.length > 0,
    currentDirection,
    streak: currentStreak,
    streakBucket,
    level: exact.length >= required ? 'direction_streak' : 'all_transitions',
    sampleCount: summary.total,
    continuationRate: summary.calibratedWinRate,
    rawContinuationRate: summary.winRate
  };
}

export function buildPlan5PriceCalibration({
  orders = [],
  direction,
  price,
  timeframe = '5m',
  symbol = null,
  baseProbability = 0.5,
  config = {}
} = {}) {
  const bucket = resolvePlan5PriceBucket(price);
  const normalizedDirection = normalizeDirection(direction);
  if (!bucket || !normalizedDirection) return { available: false, sampleCount: 0, probability: baseProbability };

  const eligible = (Array.isArray(orders) ? orders : [])
    .filter((order) => (order?.won === true || order?.won === false))
    .filter((order) => String(order?.planId || '').toLowerCase() === 'plan5')
    .filter((order) => !order?.strategyVersion || String(order.strategyVersion).startsWith('plan5_'))
    .filter((order) => normalizeDirection(order?.direction) === normalizedDirection)
    .filter((order) => !timeframe || String(order?.timeframe || '') === String(timeframe))
    .filter((order) => inPriceBucket(order?.entryPrice ?? order?.limitPrice, bucket))
    .sort((a, b) => dateMs(b.settledAtIso) - dateMs(a.settledAtIso));
  const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
  const symbolRows = normalizedSymbol
    ? eligible.filter((order) => String(order?.symbol || '').toUpperCase() === normalizedSymbol)
    : eligible;
  const minSamples = Math.max(1, Number(config.plan5PriceCalibrationMinSamples) || 8);
  const selected = symbolRows.length >= minSamples ? symbolRows : eligible;
  const recentSamples = Math.max(1, Number(config.plan5PriceCalibrationRecentSamples) || 20);
  const longTerm = summarizeBinary(selected, baseProbability, 8);
  const recent = summarizeBinary(selected.slice(0, recentSamples), baseProbability, 8);
  const calibrated = blendRecentAndLongTerm(
    recent,
    longTerm,
    Number(config.plan5DirectionRecentWeight) || 0.7
  );
  const sampleFactor = Math.min(1, longTerm.total / minSamples);
  const configuredWeight = clamp(config.plan5PriceCalibrationWeight, 0, 0.85, 0.45);
  const weight = configuredWeight * sampleFactor;
  const probability = round4(baseProbability * (1 - weight) + calibrated * weight);
  return {
    available: longTerm.total > 0,
    level: symbolRows.length >= minSamples ? 'symbol_timeframe_direction_price' : 'timeframe_direction_price',
    bucket: bucket.key,
    sampleCount: longTerm.total,
    recentSampleCount: recent.total,
    rawWinRate: longTerm.winRate,
    recentWinRate: recent.winRate,
    calibratedWinRate: calibrated,
    realizedRoi: longTerm.realizedRoi,
    recentRealizedRoi: recent.realizedRoi,
    weight: round4(weight),
    probability
  };
}

export function selectPlan5PriceAwareDirection({
  upProbability,
  downProbability,
  upPrice,
  downPrice,
  config = {}
} = {}) {
  const probabilities = {
    up: clamp(upProbability, 0.01, 0.99, 0.5),
    down: clamp(downProbability, 0.01, 0.99, 0.5)
  };
  const prices = { up: Number(upPrice), down: Number(downPrice) };
  const candidates = ['up', 'down'].map((direction) => {
    const price = prices[direction];
    const probability = probabilities[direction];
    const tradable = Number.isFinite(price) && price > 0 && price < 1;
    const netEdge = tradable ? probability - price : Number.NEGATIVE_INFINITY;
    const expectedRoi = tradable ? netEdge / price : Number.NEGATIVE_INFINITY;
    return {
      direction,
      price: tradable ? round4(price) : null,
      probability: round4(probability),
      netEdge: tradable ? round4(netEdge) : null,
      expectedRoi: tradable ? round4(expectedRoi) : null,
      tradable
    };
  }).sort((a, b) => (b.expectedRoi ?? -Infinity) - (a.expectedRoi ?? -Infinity));
  const selected = candidates[0];
  const minEdge = Number.isFinite(Number(config.plan5DirectionMinProbabilityEdge))
    ? Number(config.plan5DirectionMinProbabilityEdge)
    : 0.005;
  const minRoi = Number.isFinite(Number(config.plan5DirectionMinExpectedRoi))
    ? Number(config.plan5DirectionMinExpectedRoi)
    : 0.01;
  const allowed = selected?.tradable === true
    && Number(selected.netEdge) >= minEdge
    && Number(selected.expectedRoi) >= minRoi;
  return {
    allowed,
    direction: selected?.direction || null,
    price: selected?.price ?? null,
    probability: selected?.probability ?? null,
    netEdge: selected?.netEdge ?? null,
    expectedRoi: selected?.expectedRoi ?? null,
    candidates,
    minEdge,
    minExpectedRoi: minRoi,
    reason: allowed
      ? null
      : `Plan5 两边按最新价格计算后都未达到正期望门槛（edge≥${(minEdge * 100).toFixed(1)}%，ROI≥${(minRoi * 100).toFixed(1)}%）。`
  };
}

export function buildPlan5StrengthDirection({
  lockDirection,
  marketState = {},
  config = {}
} = {}) {
  const rawDirection = normalizeDirection(lockDirection);
  const startPrice = Number(marketState.startPrice);
  const currentPrice = Number(marketState.currentPrice);
  if (!rawDirection || !Number.isFinite(startPrice) || startPrice <= 0
    || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { available: false, direction: rawDirection, reason: 'spot_strength_unavailable' };
  }

  const elapsedPct = clamp(marketState.elapsedPct, 0.02, 1, 0.5);
  const currentMoveBps = (currentPrice / startPrice - 1) * 10_000;
  const currentPaceBps = currentMoveBps / Math.sqrt(elapsedPct);
  const previousMoveBps = Number.isFinite(Number(marketState.previousClosedCandleMovePct))
    ? Number(marketState.previousClosedCandleMovePct) * 10_000
    : 0;
  const recentMovesBps = (Array.isArray(marketState.recentClosedCandleMovesPct)
    ? marketState.recentClosedCandleMovesPct
    : [])
    .map((value) => Number(value) * 10_000)
    .filter(Number.isFinite);
  const recentThreeMoveBps = recentMovesBps.slice(-3).reduce((sum, value) => sum + value, 0);
  const pmDirectionScore = rawDirection === 'up' ? 1 : -1;
  const weights = {
    pm: Number.isFinite(Number(config.plan5StrengthPmWeight)) ? Number(config.plan5StrengthPmWeight) : 1,
    current: Number.isFinite(Number(config.plan5StrengthCurrentMoveWeight)) ? Number(config.plan5StrengthCurrentMoveWeight) : 0.5,
    pace: Number.isFinite(Number(config.plan5StrengthCurrentPaceWeight)) ? Number(config.plan5StrengthCurrentPaceWeight) : 0.25,
    previous: Number.isFinite(Number(config.plan5StrengthPreviousMoveWeight)) ? Number(config.plan5StrengthPreviousMoveWeight) : 0.5,
    recentThree: Number.isFinite(Number(config.plan5StrengthRecentThreeWeight)) ? Number(config.plan5StrengthRecentThreeWeight) : -0.25
  };
  const score = weights.pm * pmDirectionScore
    + weights.current * clamp(currentMoveBps / 10, -4, 4, 0)
    + weights.pace * clamp(currentPaceBps / 10, -5, 5, 0)
    + weights.previous * clamp(previousMoveBps / 10, -4, 4, 0)
    + weights.recentThree * clamp(recentThreeMoveBps / 20, -4, 4, 0);
  const direction = score >= 0 ? 'up' : 'down';
  const confidence = clamp(0.60 + Math.min(0.12, Math.abs(score) * 0.04), 0.55, 0.72, 0.62);
  return {
    available: true,
    model: 'pm_spot_strength_v14',
    direction,
    reversed: direction !== rawDirection,
    score: round4(score),
    confidence: round4(confidence),
    currentMoveBps: round4(currentMoveBps),
    currentPaceBps: round4(currentPaceBps),
    previousMoveBps: round4(previousMoveBps),
    recentThreeMoveBps: round4(recentThreeMoveBps),
    elapsedPct: round4(elapsedPct),
    weights
  };
}

export function buildPlan5DirectionDecision({
  lock,
  sentiment,
  symbol,
  timeframe = '5m',
  targetTimeIso = null,
  statsDb = null,
  orders = [],
  marketState = {},
  config = {},
  now = new Date()
} = {}) {
  const lockDirection = normalizeDirection(lock?.direction);
  const strengthDirection = buildPlan5StrengthDirection({ lockDirection, marketState, config });
  const decisionDirection = strengthDirection.direction || lockDirection;
  if (!lockDirection) return { allowed: false, reason: 'Plan5 锁定方向无效。' };
  const lockConfidence = clamp(
    lock?.confidence,
    0.50,
    0.99,
    Math.max(Number(sentiment?.upPrice) || 0.5, Number(sentiment?.downPrice) || 0.5)
  );
  let judgments = [];
  if (statsDb && typeof statsDb.getDirectionJudgments === 'function') {
    try {
      judgments = statsDb.getDirectionJudgments({
        lookbackDays: Math.max(1, Number(config.plan5DirectionLookbackDays) || 30),
        timeframe,
        symbol,
        settledOnly: true
      }) || [];
    } catch {
      judgments = [];
    }
  }
  const beforeMs = dateMs(targetTimeIso) || Number.POSITIVE_INFINITY;
  const cohort = judgments
    .filter((row) => dateMs(row.targetTimeIso) < beforeMs)
    .filter((row) => normalizeDirection(row.predictedDirection) === decisionDirection)
    .filter((row) => !lock?.strength || !row.lockStrength || row.lockStrength === lock.strength)
    .sort((a, b) => dateMs(b.evaluatedAtIso || b.predictedAtIso) - dateMs(a.evaluatedAtIso || a.predictedAtIso));
  const recentLimit = Math.max(8, Number(config.plan5DirectionRecentSamples) || 40);
  const recent = summarizeJudgments(cohort.slice(0, recentLimit), lockConfidence, 8);
  const longTerm = summarizeJudgments(cohort, lockConfidence, 8);
  const minSamples = Math.max(1, Number(config.plan5DirectionMinSamples) || 12);
  const observedFollowProbability = blendRecentAndLongTerm(
    recent,
    longTerm,
    Number(config.plan5DirectionRecentWeight) || 0.7
  );
  const sampleFactor = Math.min(1, longTerm.total / minSamples);
  // Historical results are a confidence adjustment, never a replacement for
  // the PM lock. The previous implementation reached 100% historical weight
  // after only 12 samples and could turn a DOWN lock into an UP order.
  const historyMaxWeight = clamp(config.plan5DirectionHistoryMaxWeight, 0, 0.5, 0.25);
  const historyWeight = historyMaxWeight * sampleFactor;
  const baseDirectionProbability = strengthDirection.reversed
    ? strengthDirection.confidence
    : lockConfidence;
  let directionProbability = round4(
    baseDirectionProbability * (1 - historyWeight)
      + observedFollowProbability * historyWeight
  );

  const continuity = config.plan5ContinuityEnabled === false
    ? { available: false, sampleCount: 0, streak: 0 }
    : buildPlan5ContinuityEvidence(judgments, {
      targetTimeIso,
      minSamples: Number(config.plan5ContinuityMinSamples) || 10,
      maxStreak: Number(config.plan5ContinuityMaxStreak) || 4
    });
  if (continuity.available) {
    const minContinuitySamples = Math.max(1, Number(config.plan5ContinuityMinSamples) || 10);
    const continuityWeight = clamp(config.plan5ContinuityMaxWeight, 0, 0.25, 0.10)
      * Math.min(1, continuity.sampleCount / minContinuitySamples);
    const continuationSupportsLock = continuity.currentDirection === decisionDirection;
    const continuityLockProbability = continuationSupportsLock
      ? continuity.continuationRate
      : 1 - continuity.continuationRate;
    directionProbability = directionProbability * (1 - continuityWeight)
      + continuityLockProbability * continuityWeight;
    continuity.weight = round4(continuityWeight);
    continuity.supportsLock = continuationSupportsLock;
    continuity.lockProbability = round4(continuityLockProbability);
  }
  directionProbability = clamp(directionProbability, 0.01, 0.99, lockConfidence);

  const priceCalibrations = {};
  if (config.plan5PriceCalibrationEnabled !== false) {
    const lockedPrice = decisionDirection === 'up' ? sentiment?.upPrice : sentiment?.downPrice;
    priceCalibrations[decisionDirection] = buildPlan5PriceCalibration({
      orders,
      direction: decisionDirection,
      price: lockedPrice,
      timeframe,
      symbol,
      baseProbability: directionProbability,
      config
    });
    directionProbability = clamp(
      priceCalibrations[decisionDirection].probability,
      0.01,
      0.99,
      directionProbability
    );
  }
  const upProbability = decisionDirection === 'up' ? directionProbability : 1 - directionProbability;
  const downProbability = 1 - upProbability;
  const rawSelection = selectPlan5PriceAwareDirection({
    upProbability,
    downProbability,
    upPrice: decisionDirection === 'up' ? sentiment?.upPrice : null,
    downPrice: decisionDirection === 'down' ? sentiment?.downPrice : null,
    config
  });
  const selected = rawSelection.candidates.find((candidate) => candidate.direction === decisionDirection);
  const meetsEdge = selected?.tradable === true
    && Number(selected.netEdge) >= Number(rawSelection.minEdge)
    && Number(selected.expectedRoi) >= Number(rawSelection.minExpectedRoi);
  const selection = {
    ...rawSelection,
    allowed: meetsEdge,
    direction: decisionDirection,
    price: selected?.price ?? null,
    probability: selected?.probability ?? null,
    netEdge: selected?.netEdge ?? null,
    expectedRoi: selected?.expectedRoi ?? null,
    reason: meetsEdge
      ? null
      : selected?.tradable !== true
        ? 'Plan5 selected direction has no executable quote.'
        : `Plan5 selected direction is below the hard EV floor (edge>=${rawSelection.minEdge}, ROI>=${rawSelection.minExpectedRoi}).`
  };
  return {
    ...selection,
    enabled: true,
    evaluatedAtIso: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    lockDirection,
    direction: decisionDirection,
    reversed: decisionDirection !== lockDirection,
    directionModel: strengthDirection.model || 'pm_lock_fallback',
    strengthDirection,
    marketState: strengthDirection.available ? {
      startPrice: Number(marketState.startPrice),
      currentPrice: Number(marketState.currentPrice),
      elapsedPct: strengthDirection.elapsedPct,
      previousClosedCandleMovePct: Number(marketState.previousClosedCandleMovePct),
      recentClosedCandleMovesPct: marketState.recentClosedCandleMovesPct || []
    } : null,
    rawLockConfidence: round4(lockConfidence),
    historyWeight: round4(historyWeight),
    upProbability: round4(upProbability),
    downProbability: round4(downProbability),
    lockEvidence: {
      sampleCount: longTerm.total,
      recentSampleCount: recent.total,
      rawWinRate: longTerm.winRate,
      recentWinRate: recent.winRate,
      followProbability: round4(directionProbability),
      observedFollowProbability,
      historyWeight: round4(historyWeight)
    },
    continuity,
    priceCalibrations
  };
}
