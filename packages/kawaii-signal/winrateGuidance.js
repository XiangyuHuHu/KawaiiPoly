/**
 * 用历史方向判断样本指导新判断。
 * 样本越多，条件胜率越有依据；不足时明确标注「样本不足」。
 */

const DEFAULT_MIN_SAMPLES = 8;
const EDGE_THRESHOLD = 0.55;

export function buildDirectionJudgmentId({ timeframe = '5m', targetTimeIso, symbol = 'BTC-USD' } = {}) {
  const tf = timeframe === '15m' ? '15m' : '5m';
  return `dj_${tf}_${String(targetTimeIso || '')}_${String(symbol || 'BTC-USD').toUpperCase()}`;
}

export function resolveHourBucket(isoOrDate = new Date()) {
  const ms = isoOrDate instanceof Date ? isoOrDate.getTime() : Date.parse(isoOrDate);
  if (!Number.isFinite(ms)) return null;
  // 上海时区小时档（UTC+8），便于按交易时段切片
  const shanghaiHour = (new Date(ms).getUTCHours() + 8) % 24;
  return shanghaiHour;
}

export function resolveVolatilityBucket(volatilityPct = null) {
  const value = Number(volatilityPct);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 0.002) return 'low';
  if (value < 0.006) return 'mid';
  return 'high';
}

export function extractJudgmentFromSignal(signal, {
  timeframe = '15m',
  source = null,
  generatedAt = new Date().toISOString(),
  requireLock = true
} = {}) {
  if (!signal) return null;
  const tf = timeframe === '15m' ? '15m' : '5m';
  const locked = signal.lockedDecision;
  const polymarket = signal.polymarket;
  // 与旧加密台一致：未锁定前不记方向、不展示判断（前端显示「未知」）
  const direction = locked?.direction
    || locked?.lockedPolymarketPredictedDirection
    || (!requireLock && polymarket?.available ? resolvePmDirection(polymarket) : null)
    || (!requireLock && (signal.direction === 'up' || signal.direction === 'down') ? signal.direction : null);
  if (!['up', 'down'].includes(direction)) return null;

  const up = Number(locked?.upProbability ?? polymarket?.upProbability ?? polymarket?.upPrice);
  const down = Number(locked?.downProbability ?? polymarket?.downProbability ?? polymarket?.downPrice);
  const confidence = Number(
    locked?.confidence
    ?? signal.compositeConfidence
    ?? signal.confidence
    ?? Math.max(Number.isFinite(up) ? up : 0, Number.isFinite(down) ? down : 0)
  );
  const targetTimeIso = signal.prediction?.targetTimeIso
    || signal.schedule?.nextSlotIso
    || null;
  if (!targetTimeIso) return null;

  const predictedAtIso = locked?.lockedAtIso || generatedAt || new Date().toISOString();
  const sameDirectionAsPrev = signal.nextSlotPrediction?.sameDirectionAsPrev ?? null;
  const volatilityPct = Number(
    signal.indicators?.volatility15mPct
    ?? signal.indicators?.volatility5mPct
    ?? signal.indicators?.volatilityPct
  );
  // Once Plan5 locks, keep the spot price captured at that same instant.
  // Refreshing the row with a later price while retaining lockedAtIso creates
  // look-ahead contamination in direction backtests.
  const livePrice = Number(
    locked?.optimization?.marketState?.currentPrice
    ?? signal.currentPrice
    ?? signal.price
    ?? signal.indicators?.currentPrice
  );
  const candleClose = Number(signal.indicators?.close ?? signal.candles?.at?.(-1)?.close);

  return {
    id: buildDirectionJudgmentId({ timeframe: tf, targetTimeIso, symbol: signal.symbol }),
    symbol: String(signal.symbol || 'BTC-USD').toUpperCase(),
    timeframe: tf,
    slotIso: signal.schedule?.currentSlotIso || null,
    targetTimeIso,
    predictedDirection: direction,
    predictedAtIso,
    confidence: Number.isFinite(confidence) ? confidence : null,
    upProb: Number.isFinite(up) ? up : null,
    downProb: Number.isFinite(down) ? down : null,
    lockStrength: locked?.strength || locked?.lockStrength || signal.nextSlotPrediction?.lockStrength || null,
    lockGap: Number.isFinite(Number(locked?.pmGap ?? locked?.lockGap))
      ? Number(locked.pmGap ?? locked.lockGap)
      : (Number.isFinite(up) && Number.isFinite(down) ? Math.abs(up - down) : null),
    price: (Number.isFinite(livePrice) && livePrice > 0)
      ? livePrice
      : ((Number.isFinite(candleClose) && candleClose > 0) ? candleClose : null),
    source: locked?.source || (polymarket?.available ? 'polymarket' : (source || null)),
    hourBucket: resolveHourBucket(predictedAtIso),
    volatilityBucket: resolveVolatilityBucket(volatilityPct),
    sameDirectionAsPrev,
    status: 'pending'
  };
}

function resolvePmDirection(sentiment) {
  const up = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const down = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
  if (up === down) return null;
  return up > down ? 'up' : 'down';
}

/**
 * 基于历史样本构建对新判断的指导标注。
 * @returns {{
 *   sampleInsufficient: boolean,
 *   overall: object,
 *   conditional: object,
 *   suggestedWeight: number,
 *   alignsWithHistoricalEdge: boolean|null,
 *   preferredDirection: 'up'|'down'|null,
 *   note: string,
 *   slices: object
 * }}
 */
export function buildJudgmentGuidance({
  judgment,
  statsDb = null,
  lookbackDays = 14,
  minSamples = DEFAULT_MIN_SAMPLES
} = {}) {
  const empty = {
    sampleInsufficient: true,
    overall: emptySlice(),
    conditional: emptySlice(),
    suggestedWeight: 1,
    alignsWithHistoricalEdge: null,
    preferredDirection: null,
    note: '样本不足：尚无足够历史结算记录指导本判断。',
    slices: {},
    hourRegime: { active: false, weak: false, sampleCount: 0 }
  };

  if (!judgment?.predictedDirection || !statsDb?.enabled) return empty;

  const baseFilter = {
    lookbackDays,
    timeframe: judgment.timeframe,
    symbol: judgment.symbol
  };

  // 一次读出本币种/周期结算样本，内存切片；避免原先 8 次全表 getConditionalWinRates
  const rows = typeof statsDb.getDirectionJudgments === 'function'
    ? (statsDb.getDirectionJudgments({ ...baseFilter, settledOnly: true }) || [])
    : [];

  const sliceWhere = (predicate) => summarizeGuidanceRows(rows.filter(predicate));

  const overall = rows.length
    ? summarizeGuidanceRows(rows)
    : (statsDb.getConditionalWinRates?.(baseFilter) || emptySlice());
  const byDirection = sliceWhere((row) => row.predictedDirection === judgment.predictedDirection);
  const byStrength = judgment.lockStrength
    ? sliceWhere((row) => (
      row.predictedDirection === judgment.predictedDirection
      && row.lockStrength === judgment.lockStrength
    ))
    : emptySlice();
  const byStrengthHour = judgment.lockStrength && judgment.hourBucket != null
    ? sliceWhere((row) => (
      row.predictedDirection === judgment.predictedDirection
      && row.lockStrength === judgment.lockStrength
      && Number(row.hourBucket) === Number(judgment.hourBucket)
    ))
    : emptySlice();
  const byHour = judgment.hourBucket != null
    ? sliceWhere((row) => (
      row.predictedDirection === judgment.predictedDirection
      && Number(row.hourBucket) === Number(judgment.hourBucket)
    ))
    : emptySlice();
  const allDirectionsByHour = judgment.hourBucket != null
    ? sliceWhere((row) => Number(row.hourBucket) === Number(judgment.hourBucket))
    : emptySlice();
  const byVol = judgment.volatilityBucket
    ? sliceWhere((row) => (
      row.predictedDirection === judgment.predictedDirection
      && row.volatilityBucket === judgment.volatilityBucket
    ))
    : emptySlice();
  const byContinuity = judgment.sameDirectionAsPrev != null
    ? sliceWhere((row) => (
      row.predictedDirection === judgment.predictedDirection
      && row.sameDirectionAsPrev === Boolean(judgment.sameDirectionAsPrev)
    ))
    : emptySlice();

  // 优先用最细且样本够的切片；否则逐级回退
  const candidates = [
    { key: 'strength+hour', slice: byStrengthHour },
    { key: 'strength', slice: byStrength },
    { key: 'hour', slice: byHour },
    { key: 'volatility', slice: byVol },
    { key: 'continuity', slice: byContinuity },
    { key: 'direction', slice: byDirection },
    { key: 'overall', slice: overall }
  ].filter((item) => item.slice && Number(item.slice.total) > 0);

  let best = null;
  for (const candidate of candidates) {
    if (Number(candidate.slice.total) >= minSamples) {
      best = candidate;
      break;
    }
  }
  if (!best && candidates.length) {
    best = candidates[0];
  }

  const conditional = best?.slice || emptySlice();
  const sampleInsufficient = Number(conditional.total) < minSamples;
  const winRate = Number(conditional.winRate) || 0;
  const hourRegime = buildRecentHourRegime({
    rows,
    judgment,
    allDirectionsByHour,
    overall
  });
  const effectiveSampleInsufficient = sampleInsufficient && !hourRegime.weak;

  const upEdge = sliceWhere((row) => row.predictedDirection === 'up');
  const downEdge = sliceWhere((row) => row.predictedDirection === 'down');
  let preferredDirection = null;
  if (Number(upEdge.total) >= minSamples || Number(downEdge.total) >= minSamples) {
    const upScore = Number(upEdge.total) >= Math.min(minSamples, 5) ? Number(upEdge.winRate) : -1;
    const downScore = Number(downEdge.total) >= Math.min(minSamples, 5) ? Number(downEdge.winRate) : -1;
    if (upScore >= EDGE_THRESHOLD || downScore >= EDGE_THRESHOLD) {
      preferredDirection = upScore >= downScore ? 'up' : 'down';
    }
  }

  const alignsWithHistoricalEdge = preferredDirection == null
    ? null
    : preferredDirection === judgment.predictedDirection;

  let suggestedWeight = 1;
  if (!sampleInsufficient) {
    if (winRate >= 0.62) suggestedWeight = 1.15;
    else if (winRate >= EDGE_THRESHOLD) suggestedWeight = 1.05;
    else if (winRate < 0.42) suggestedWeight = 0.7;
    else if (winRate < 0.48) suggestedWeight = 0.85;
    if (alignsWithHistoricalEdge === false) {
      suggestedWeight = Math.min(suggestedWeight, 0.8);
    } else if (alignsWithHistoricalEdge === true) {
      suggestedWeight = Math.min(1.2, suggestedWeight + 0.05);
    }
  }
  if (hourRegime.weak) {
    suggestedWeight = Math.min(suggestedWeight, 0.8);
  }

  let note = buildGuidanceNote({
    sampleInsufficient: effectiveSampleInsufficient,
    conditional,
    bestKey: best?.key,
    preferredDirection,
    alignsWithHistoricalEdge,
    suggestedWeight,
    judgment,
    minSamples
  });
  if (hourRegime.weak) {
    note = `${note} · 最近${hourRegime.lookbackHours}小时上海${judgment.hourBucket}点胜率 ${(
      hourRegime.recentWinRate * 100
    ).toFixed(1)}%（n=${hourRegime.sampleCount}），处于弱势状态，权重上限 ×0.80`;
  }

  return {
    sampleInsufficient: effectiveSampleInsufficient,
    overall: withInsufficient(overall, minSamples),
    conditional: withInsufficient(conditional, minSamples),
    suggestedWeight: Math.round(suggestedWeight * 100) / 100,
    alignsWithHistoricalEdge,
    preferredDirection,
    note,
    hourRegime,
    slices: {
      byDirection: withInsufficient(byDirection, minSamples),
      byStrength: withInsufficient(byStrength, minSamples),
      byStrengthHour: withInsufficient(byStrengthHour, minSamples),
      byHour: withInsufficient(byHour, minSamples),
      allDirectionsByHour: withInsufficient(allDirectionsByHour, minSamples),
      byVolatility: withInsufficient(byVol, minSamples),
      byContinuity: withInsufficient(byContinuity, minSamples)
    }
  };
}

function intersectEnough(a, b, minSamples) {
  // 仅作占位：真正交集需在 SQL 层；此处若 strength 样本够则优先 strength
  return Number(a?.total) >= minSamples;
}

function emptySlice() {
  return { total: 0, correct: 0, wrong: 0, winRate: 0, sampleInsufficient: true };
}

function buildRecentHourRegime({
  rows = [],
  judgment = {},
  allDirectionsByHour = emptySlice(),
  overall = emptySlice(),
  lookbackHours = 72,
  minSamples = 12,
  weakWinRate = 0.56,
  minDrop = 0.08
} = {}) {
  if (judgment.hourBucket == null) {
    return { active: false, weak: false, sampleCount: 0, lookbackHours };
  }
  const nowMs = Date.parse(judgment.predictedAtIso || '');
  const anchorMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoffMs = anchorMs - lookbackHours * 60 * 60 * 1000;
  const recentRows = rows.filter((row) => {
    if (Number(row.hourBucket) !== Number(judgment.hourBucket)) return false;
    const rowMs = Date.parse(row.predictedAtIso || row.targetTimeIso || '');
    return Number.isFinite(rowMs) && rowMs >= cutoffMs && rowMs <= anchorMs;
  });
  const recent = summarizeGuidanceRows(recentRows);
  const baseline = Number(allDirectionsByHour.total) >= minSamples
    ? Number(allDirectionsByHour.winRate)
    : Number(overall.winRate);
  const enough = recent.total >= minSamples;
  const drop = Number.isFinite(baseline) ? baseline - recent.winRate : 0;
  const weak = enough && recent.winRate < weakWinRate && drop >= minDrop;
  return {
    active: enough,
    weak,
    sampleCount: recent.total,
    recentWinRate: recent.winRate,
    baselineWinRate: Number.isFinite(baseline) ? baseline : 0,
    drop,
    lookbackHours
  };
}

function summarizeGuidanceRows(rows = []) {
  let correct = 0;
  let wrong = 0;
  for (const row of rows) {
    if (row.correct === true) correct += 1;
    else if (row.correct === false) wrong += 1;
  }
  const total = correct + wrong;
  return {
    total,
    correct,
    wrong,
    winRate: total ? correct / total : 0,
    sampleInsufficient: total < 8
  };
}

function withInsufficient(slice, minSamples) {
  const total = Number(slice?.total) || 0;
  return {
    total,
    correct: Number(slice?.correct) || 0,
    wrong: Number(slice?.wrong) || 0,
    winRate: Number(slice?.winRate) || 0,
    sampleInsufficient: total < minSamples
  };
}

function buildGuidanceNote({
  sampleInsufficient,
  conditional,
  bestKey,
  preferredDirection,
  alignsWithHistoricalEdge,
  suggestedWeight,
  judgment,
  minSamples
}) {
  const dirLabel = judgment.predictedDirection === 'up' ? 'UP' : 'DOWN';
  if (sampleInsufficient) {
    const n = Number(conditional?.total) || 0;
    return n > 0
      ? `样本不足：同条件仅 ${n} 条（需 ≥${minSamples}），当前 ${dirLabel} 仅供参考，不建议加仓。`
      : `样本不足：尚无足够历史结算记录指导本判断（需 ≥${minSamples}）。`;
  }

  const wr = ((Number(conditional.winRate) || 0) * 100).toFixed(1);
  const parts = [
    `历史同条件胜率 ${wr}%（${conditional.correct}/${conditional.total}，切片 ${bestKey || 'overall'}）`
  ];
  if (preferredDirection) {
    const pref = preferredDirection === 'up' ? 'UP' : 'DOWN';
    if (alignsWithHistoricalEdge) {
      parts.push(`与历史优势方向 ${pref} 一致`);
    } else {
      parts.push(`与历史优势方向 ${pref} 不一致，建议降权`);
    }
  }
  parts.push(`建议权重 ×${Number(suggestedWeight).toFixed(2)}`);
  return parts.join(' · ');
}

/**
 * 把 guidance 叠到信号上：标注 + 可选置信度微调（不翻转方向）。
 */
export function applyGuidanceToSignal(signal, guidance) {
  if (!signal || !guidance) return signal;
  const baseConfidence = Number(signal.confidence) || 0;
  const weight = Number(guidance.suggestedWeight) || 1;
  const adjustedConfidence = guidance.sampleInsufficient
    ? baseConfidence
    : Math.max(0, Math.min(0.99, baseConfidence * weight));

  return {
    ...signal,
    winrateGuidance: guidance,
    confidence: adjustedConfidence,
    confidenceBeforeGuidance: baseConfidence,
    guidanceWeight: weight,
    guidanceNote: guidance.note
  };
}
