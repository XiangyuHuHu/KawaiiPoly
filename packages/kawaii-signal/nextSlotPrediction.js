import { slotIsoFromTargetTime, timeframeToSlotMinutes } from './polymarketSchedule.js';

/**
 * 当前窗锁定方向 → 预测下一相邻窗方向（carry-forward）。
 * 仅记录与统计，不参与下一窗独立锁判定 / Plan5 入场门控。
 *
 * 预测锁晚于普通 PM 展示锁：首次达到更严格阈值后写入，之后同 source 窗不再改方向。
 */

export function resolveSlotMinutes(timeframe = '5m') {
  return timeframeToSlotMinutes(timeframe === '15m' ? '15m' : '5m');
}

export function resolveSourceSlotIso(record) {
  if (record?.sourceSlotIso) return record.sourceSlotIso;
  if (record?.slotIso) return record.slotIso;
  const timeframe = record?.timeframe === '15m' ? '15m' : '5m';
  return slotIsoFromTargetTime(record?.targetTimeIso, timeframe);
}

export function nextAdjacentSlotIso(slotIso, timeframe = '5m') {
  const ms = Date.parse(slotIso);
  if (!Number.isFinite(ms)) return null;
  const minutes = resolveSlotMinutes(timeframe);
  return new Date(ms + minutes * 60_000).toISOString();
}

export function buildNextSlotPredictionId({ sourceTimeframe, sourceSlotIso, symbol = 'BTC-USD' } = {}) {
  const tf = sourceTimeframe === '15m' ? '15m' : '5m';
  return `nsp_${tf}_${sourceSlotIso}_${String(symbol || 'BTC-USD').toUpperCase()}`;
}

function readNextSlotPredictionEnv(env, timeframe, key, fallback) {
  const prefix = timeframe === '15m' ? 'FIFTEEN_MINUTE' : 'FIVE_MINUTE';
  const shared = 'NEXT_SLOT_PREDICTION';
  const value = env[`${prefix}_NEXT_SLOT_PREDICTION_${key}`]
    ?? env[`${shared}_${key}`]
    ?? env[`INTERVAL_NEXT_SLOT_PREDICTION_${key}`];
  return value ?? fallback;
}

/**
 * 下轮预测锁配置：
 * - 软锁：比普通 display lock（~12% / gap 0.03）更晚、更严
 * - 硬截止：窗口末期强制用当前最佳方向锁定，避免拖到结束仍无预测
 */
export function buildNextSlotPredictionLockConfig(timeframe = '5m', env = process.env) {
  const tf = timeframe === '15m' ? '15m' : '5m';
  const allowWeakRaw = readNextSlotPredictionEnv(env, tf, 'ALLOW_WEAK', 'true');
  const defaultHardRemaining = tf === '15m' ? 60 : 30;
  return {
    timeframe: tf,
    minElapsedPct: Number(readNextSlotPredictionEnv(env, tf, 'LOCK_MIN_ELAPSED_PCT', 0.5)),
    minPmGap: Number(readNextSlotPredictionEnv(env, tf, 'LOCK_MIN_PM_GAP', 0.06)),
    allowWeak: String(allowWeakRaw).toLowerCase() !== 'false',
    weakMinElapsedPct: Number(readNextSlotPredictionEnv(env, tf, 'LOCK_WEAK_MIN_ELAPSED_PCT', 0.6)),
    minStrength: String(readNextSlotPredictionEnv(env, tf, 'LOCK_MIN_STRENGTH', 'normal') || 'normal'),
    // 硬截止：进度达此比例，或剩余秒数低于阈值时强制锁定（绕过 gap/强度）
    hardMinElapsedPct: Number(readNextSlotPredictionEnv(env, tf, 'LOCK_HARD_MIN_ELAPSED_PCT', 0.9)),
    hardMaxRemainingSec: Number(
      readNextSlotPredictionEnv(env, tf, 'LOCK_HARD_MAX_REMAINING_SEC', defaultHardRemaining)
    )
  };
}

function resolveElapsedPct(record, elapsedPct = null) {
  const elapsed = Number(
    elapsedPct
    ?? record?.lastElapsedInCurrentSlotPct
    ?? record?.lockElapsedPct
    ?? record?.elapsedInCurrentSlotPct
  );
  return Number.isFinite(elapsed) ? elapsed : null;
}

function resolveRemainingSeconds(record, elapsedPct = null) {
  const elapsed = resolveElapsedPct(record, elapsedPct);
  if (!Number.isFinite(elapsed)) return null;
  const minutes = resolveSlotMinutes(record?.timeframe === '15m' ? '15m' : '5m');
  return Math.max(0, (1 - elapsed) * minutes * 60);
}

function hasLockedDirection(record) {
  if (!record?.decisionLocked) return false;
  const direction = record.lockedPolymarketPredictedDirection
    || record.polymarketPredictedDirection
    || null;
  return ['up', 'down'].includes(direction);
}

function strengthRank(strength) {
  if (strength === 'strong') return 3;
  if (strength === 'normal') return 2;
  if (strength === 'weak') return 1;
  return 0;
}

/**
 * 软锁：须已有普通 PM 锁，且进度/gap/强度更严。
 */
export function meetsNextSlotPredictionLock(record, {
  elapsedPct = null,
  config = buildNextSlotPredictionLockConfig(record?.timeframe)
} = {}) {
  if (!hasLockedDirection(record)) return false;

  const elapsed = resolveElapsedPct(record, elapsedPct);
  if (!Number.isFinite(elapsed) || elapsed < Number(config.minElapsedPct)) {
    return false;
  }

  const gap = Number(record.lockedPmGap ?? record.lockGap);
  if (Number.isFinite(gap) && gap < Number(config.minPmGap)) {
    return false;
  }

  const strength = record.lockStrength || 'weak';
  const minStrength = config.minStrength === 'strong'
    ? 'strong'
    : config.minStrength === 'weak'
      ? 'weak'
      : 'normal';

  if (strength === 'weak') {
    // Weak only after a later elapsed threshold (and only if explicitly allowed).
    if (!config.allowWeak) return false;
    if (elapsed < Number(config.weakMinElapsedPct)) return false;
    return true;
  }

  if (strengthRank(strength) < strengthRank(minStrength)) {
    return false;
  }
  return true;
}

/**
 * 硬截止：窗口末期强制锁定。
 * 条件：已有普通 PM 方向锁，且（进度 ≥ hardMinElapsedPct 或 剩余秒数 ≤ hardMaxRemainingSec）。
 * 绕过 gap / 强度阈值；无方向时仍不锁。
 */
export function meetsNextSlotPredictionHardDeadline(record, {
  elapsedPct = null,
  config = buildNextSlotPredictionLockConfig(record?.timeframe),
  forceSettlement = false
} = {}) {
  if (!hasLockedDirection(record)) return false;
  if (forceSettlement === true) return true;

  const hardPct = Number(config.hardMinElapsedPct);
  const hardRemaining = Number(config.hardMaxRemainingSec);
  const elapsed = resolveElapsedPct(record, elapsedPct);
  if (Number.isFinite(elapsed) && Number.isFinite(hardPct) && elapsed >= hardPct) {
    return true;
  }
  const remaining = resolveRemainingSeconds(record, elapsedPct);
  if (Number.isFinite(remaining) && Number.isFinite(hardRemaining) && remaining <= hardRemaining) {
    return true;
  }
  return false;
}

/** soft | hard | null */
export function resolveNextSlotPredictionLockMode(record, {
  elapsedPct = null,
  config = buildNextSlotPredictionLockConfig(record?.timeframe),
  force = false,
  forceSettlement = false
} = {}) {
  if (force === true || forceSettlement === true) {
    return hasLockedDirection(record) ? (forceSettlement ? 'hard' : 'force') : null;
  }
  if (meetsNextSlotPredictionLock(record, { elapsedPct, config })) return 'soft';
  if (meetsNextSlotPredictionHardDeadline(record, { elapsedPct, config, forceSettlement })) {
    return 'hard';
  }
  return null;
}

/**
 * 从已锁定的 window record 生成下一窗预测。
 * 默认：软锁或硬截止任一满足即可；force/forceSettlement 时仅需普通 decisionLocked + 方向。
 */
export function buildNextSlotPredictionFromLock(record, nowIso = new Date().toISOString(), options = {}) {
  const {
    force = false,
    forceSettlement = false,
    elapsedPct = null,
    predictionLockConfig = null
  } = options;
  if (!record?.decisionLocked) return null;

  const config = predictionLockConfig
    || buildNextSlotPredictionLockConfig(record.timeframe === '15m' ? '15m' : '5m');
  const lockMode = resolveNextSlotPredictionLockMode(record, {
    elapsedPct,
    config,
    force,
    forceSettlement
  });
  if (!lockMode) return null;

  const direction = record.lockedPolymarketPredictedDirection
    || record.polymarketPredictedDirection
    || null;
  if (!['up', 'down'].includes(direction)) return null;

  const sourceTimeframe = record.timeframe === '15m' ? '15m' : '5m';
  const sourceSlotIso = resolveSourceSlotIso(record);
  if (!sourceSlotIso) return null;

  const predictedSlotIso = record.targetTimeIso
    || nextAdjacentSlotIso(sourceSlotIso, sourceTimeframe);
  if (!predictedSlotIso) return null;

  const symbol = String(record.symbol || 'BTC-USD').toUpperCase();
  const predictedAtIso = nowIso
    || record.decisionLockedAtIso
    || record.predictedAtIso
    || new Date().toISOString();
  const resolvedElapsed = resolveElapsedPct(record, elapsedPct);
  const softMet = meetsNextSlotPredictionLock(record, { elapsedPct, config });
  const hardMet = lockMode === 'hard' || forceSettlement === true;
  return {
    id: buildNextSlotPredictionId({ sourceTimeframe, sourceSlotIso, symbol }),
    sourceSlotIso,
    sourceTimeframe,
    sourceTargetTimeIso: record.targetTimeIso || null,
    predictedSlotIso,
    predictedDirection: direction,
    predictedAtIso,
    lockStrength: record.lockStrength || null,
    lockGap: Number.isFinite(Number(record.lockedPmGap)) ? Number(record.lockedPmGap) : null,
    lockReason: hardMet && !softMet
      ? (forceSettlement ? 'hard_deadline_settlement' : 'hard_deadline')
      : (record.lockReason || null),
    lockMode: hardMet && !softMet ? 'hard' : (softMet ? 'soft' : lockMode),
    lockElapsedPct: Number.isFinite(resolvedElapsed) ? resolvedElapsed : null,
    symbol,
    status: 'pending',
    correct: null,
    actualDirection: null,
    evaluatedAtIso: null,
    evaluationSource: null
  };
}

export function evaluateNextSlotPrediction(prediction, actualDirection, {
  evaluatedAtIso = new Date().toISOString(),
  evaluationSource = 'actual'
} = {}) {
  if (!prediction || !['up', 'down'].includes(actualDirection)) return null;
  if (!['up', 'down'].includes(prediction.predictedDirection)) return null;
  const correct = prediction.predictedDirection === actualDirection;
  return {
    ...prediction,
    status: correct ? 'correct' : 'wrong',
    correct,
    actualDirection,
    evaluatedAtIso,
    evaluationSource
  };
}

/** 用已结算窗的 actualDirection 匹配「预测该窗」的记录。 */
export function resolvePredictedSlotIsoFromSettledRecord(record) {
  const timeframe = record?.timeframe === '15m' ? '15m' : '5m';
  return resolveSourceSlotIso({ ...record, timeframe });
}

function emptyBucket() {
  return { total: 0, correct: 0, wrong: 0, pending: 0, accuracy: 0 };
}

function bumpBucket(bucket, prediction) {
  if (prediction.correct === true) {
    bucket.total += 1;
    bucket.correct += 1;
  } else if (prediction.correct === false) {
    bucket.total += 1;
    bucket.wrong += 1;
  } else {
    bucket.pending += 1;
  }
  bucket.accuracy = bucket.total ? bucket.correct / bucket.total : 0;
}

/**
 * 相对「上一笔同币种/同周期预测」是否同向。
 * previous：通常是 predicted_slot_iso === 本笔 source_slot_iso 的那条（预测了本源窗）。
 * 返回 true | false | null（无上一笔 / 无法比较）。
 */
export function resolveSameDirectionAsPrev(prediction, previousPrediction = null) {
  if (prediction?.sameDirectionAsPrev === true || prediction?.sameDirectionAsPrev === false) {
    return prediction.sameDirectionAsPrev;
  }
  if (prediction?.same_direction_as_prev === 1) return true;
  if (prediction?.same_direction_as_prev === 0) return false;
  const cur = prediction?.predictedDirection;
  const prev = previousPrediction?.predictedDirection;
  if (!['up', 'down'].includes(cur) || !['up', 'down'].includes(prev)) return null;
  return cur === prev;
}

export function annotateSameDirectionAsPrev(prediction, previousPrediction = null) {
  if (!prediction) return null;
  const same = resolveSameDirectionAsPrev(
    { ...prediction, sameDirectionAsPrev: undefined, same_direction_as_prev: undefined },
    previousPrediction
  );
  return {
    ...prediction,
    sameDirectionAsPrev: same,
    continuity: same === true ? 'same' : same === false ? 'flip' : 'first'
  };
}

export function summarizeNextSlotPredictions(predictions = []) {
  const overall = emptyBucket();
  const byStrength = {
    strong: emptyBucket(),
    normal: emptyBucket(),
    weak: emptyBucket(),
    unknown: emptyBucket()
  };
  const byTimeframe = {
    '5m': emptyBucket(),
    '15m': emptyBucket()
  };
  const byContinuity = {
    same: emptyBucket(),
    flip: emptyBucket(),
    first: emptyBucket()
  };

  for (const prediction of predictions || []) {
    bumpBucket(overall, prediction);
    const strength = ['strong', 'normal', 'weak'].includes(prediction.lockStrength)
      ? prediction.lockStrength
      : 'unknown';
    bumpBucket(byStrength[strength], prediction);
    const tf = prediction.sourceTimeframe === '15m' ? '15m' : '5m';
    bumpBucket(byTimeframe[tf], prediction);
    const same = resolveSameDirectionAsPrev(prediction);
    const continuity = same === true ? 'same' : same === false ? 'flip' : 'first';
    bumpBucket(byContinuity[continuity], prediction);
  }

  return { overall, byStrength, byTimeframe, byContinuity };
}

/**
 * Plan5 连续同向奖赏：仅当「本次相对上一预测同向」且同向历史胜率更高、样本足够时 boost。
 * sizeScale 默认 1；上限由 config.plan5SameDirBoostMax 控制（默认 1.35）。
 */
export function evaluatePlan5SameDirectionBoost({
  sameDirectionAsPrev = null,
  continuityStats = null,
  config = {}
} = {}) {
  if (config.plan5SameDirBoostEnabled === false) {
    return { enabled: false, boost: 1, reason: 'disabled' };
  }
  if (sameDirectionAsPrev !== true) {
    return {
      enabled: true,
      boost: 1,
      applied: false,
      sameDirectionAsPrev,
      reason: sameDirectionAsPrev === false ? 'flip_or_not_same' : 'first_or_unknown'
    };
  }

  const minSamples = Number(config.plan5SameDirMinSamples) || 15;
  const same = continuityStats?.same || continuityStats?.byContinuity?.same || emptyBucket();
  const flip = continuityStats?.flip || continuityStats?.byContinuity?.flip || emptyBucket();
  const sameTotal = Number(same.total) || 0;
  const flipTotal = Number(flip.total) || 0;
  const sameWr = Number(same.accuracy) || 0;
  const flipWr = Number(flip.accuracy) || 0;

  if (sameTotal < minSamples) {
    return {
      enabled: true,
      boost: 1,
      applied: false,
      insufficientSamples: true,
      sampleCount: sameTotal,
      minSamples,
      sameWinRate: sameWr,
      flipWinRate: flipWr,
      reason: 'insufficient_same_samples'
    };
  }

  // 同向胜率需严格高于反向（若反向样本不足，则要求高于整体阈值）
  const minEdge = Number(config.plan5SameDirMinEdge);
  const edgeNeed = Number.isFinite(minEdge) ? minEdge : 0.03;
  const compareWr = flipTotal >= Math.max(5, Math.floor(minSamples / 2))
    ? flipWr
    : (Number(continuityStats?.overall?.accuracy) || flipWr);
  if (!(sameWr > compareWr + edgeNeed)) {
    return {
      enabled: true,
      boost: 1,
      applied: false,
      sampleCount: sameTotal,
      sameWinRate: sameWr,
      flipWinRate: flipWr,
      compareWinRate: compareWr,
      reason: 'same_wr_not_higher'
    };
  }

  const configured = Number(config.plan5SameDirBoost);
  const boostCap = Number(config.plan5SameDirBoostMax);
  const rawBoost = Number.isFinite(configured) && configured > 1 ? configured : 1.25;
  const maxBoost = Number.isFinite(boostCap) && boostCap >= 1 ? boostCap : 1.35;
  const boost = Math.min(maxBoost, Math.max(1, rawBoost));
  return {
    enabled: true,
    boost: Math.round(boost * 1e4) / 1e4,
    applied: boost > 1,
    sampleCount: sameTotal,
    sameWinRate: sameWr,
    flipWinRate: flipWr,
    compareWinRate: compareWr,
    reason: 'same_direction_edge'
  };
}

export function justBecameLocked(previous, next) {
  if (!next?.decisionLocked) return false;
  if (previous?.decisionLocked) return false;
  return Boolean(
    next.lockedPolymarketPredictedDirection || next.polymarketPredictedDirection
  );
}

/** 是否应尝试写入下轮预测（软锁或硬截止；可重复调用——写入侧幂等）。 */
export function shouldRecordNextSlotPrediction(record, {
  elapsedPct = null,
  config = null,
  forceSettlement = false
} = {}) {
  const lockConfig = config
    || buildNextSlotPredictionLockConfig(record?.timeframe === '15m' ? '15m' : '5m');
  return resolveNextSlotPredictionLockMode(record, {
    elapsedPct,
    config: lockConfig,
    forceSettlement
  }) != null;
}
