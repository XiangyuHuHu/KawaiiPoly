import {
  buildFifteenMinuteDecisionConfig,
  buildFiveMinuteDecisionConfig,
  evaluateDisplayPmLock,
  evaluateLowWinrateHourGate,
  formatLockStrengthLabel,
  resolveFiveMinuteLockStrengthStat
} from './fiveMinuteDecision.js';
import { windowElapsedPct } from './polymarketPlan.js';
import { timeframeToSlotMinutes, getSlotSchedule } from './polymarketSchedule.js';
import { evaluateLossReasonGate } from './lossReasonGate.js';
import { resolveSymbolWrSizedOrderPct } from './polymarketSizing.js';
import { evaluatePlan5SameDirectionBoost } from './nextSlotPrediction.js';
import {
  buildJudgmentGuidance,
  resolveHourBucket,
  resolveVolatilityBucket
} from './winrateGuidance.js';

const VALID_STRENGTHS = new Set(['weak', 'normal', 'strong']);
const DEFAULT_CASH_PCT = { weak: 0.05, normal: 0.10, strong: 0.15 };
const DEFAULT_COMBINED_SIZE_CAP = 1.8;

const PLAN5_PRICE_BANDS = [0.45, 0.55, 0.65, 0.75];
export const PLAN5_VERSION = 'plan5_live_direction_recheck_v15';
const PLAN5_VERSION_BOOTSTRAP_PREDECESSORS = new Set([
  'plan5_strength_direction_v14',
  'plan5_independent_direction_v13'
]);

export function evaluatePlan5DirectionRecheck({
  lock,
  upPrice,
  downPrice,
  signal = null,
  config = {}
} = {}) {
  const originalDirection = String(lock?.direction || '').toLowerCase();
  if (!['up', 'down'].includes(originalDirection)) {
    return { direction: originalDirection || null, flipped: false, reason: 'invalid_lock_direction' };
  }
  if (config.plan5DirectionRecheckEnabled === false) {
    return { direction: originalDirection, flipped: false, skipped: true };
  }

  const up = Number(upPrice);
  const down = Number(downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up <= 0 || down <= 0) {
    return { direction: originalDirection, flipped: false, reason: 'incomplete_current_quotes' };
  }

  const oppositeDirection = originalDirection === 'up' ? 'down' : 'up';
  const selectedPrice = originalDirection === 'up' ? up : down;
  const oppositePrice = originalDirection === 'up' ? down : up;
  const lockedSelectedPrice = Number(
    originalDirection === 'up' ? lock?.upProbability : lock?.downProbability
  );
  const priceDropAbs = Number.isFinite(lockedSelectedPrice)
    ? Math.max(0, lockedSelectedPrice - selectedPrice)
    : 0;
  const strength = String(lock?.strength || lock?.lockStrength || 'weak').toLowerCase();
  const pmGap = Number(lock?.pmGap);
  const technicalDirection = String(
    signal?.technicalDirection || signal?.techDirection || signal?.indicators?.direction || ''
  ).toLowerCase();
  const spotDirection = String(signal?.spotDirection || '').toLowerCase();
  const signalDirection = String(signal?.direction || '').toLowerCase();
  const currentPmDirection = up >= down ? 'up' : 'down';
  const technicalOpposes = technicalDirection === oppositeDirection;
  const spotOpposes = spotDirection === oppositeDirection;
  const signalOpposes = signalDirection === oppositeDirection;
  const configuredCollapse = Number(config.plan5DirectionRecheckCollapsePrice);
  const collapsePrice = Number.isFinite(configuredCollapse)
    ? Math.min(0.75, Math.max(0.20, configuredCollapse))
    : 0.54;
  const configuredDrop = Number(config.plan5DirectionRecheckMinDropAbs);
  const minDropAbs = Number.isFinite(configuredDrop)
    ? Math.min(0.40, Math.max(0.01, configuredDrop))
    : 0.04;
  const configuredExtreme = Number(config.plan5DirectionRecheckExtremePrice);
  const extremePrice = Number.isFinite(configuredExtreme)
    ? Math.min(collapsePrice, Math.max(0.05, configuredExtreme))
    : 0.20;

  const priceCollapsed = selectedPrice < collapsePrice;
  const lowGap = Number.isFinite(pmGap) && pmGap < 0.15;
  const independentOpposition = [technicalOpposes, spotOpposes, signalOpposes]
    .filter(Boolean).length;
  const originalSupport = [
    technicalDirection === originalDirection,
    spotDirection === originalDirection,
    signalDirection === originalDirection
  ].filter(Boolean).length;
  let flipReason = null;

  if (selectedPrice < extremePrice && currentPmDirection === oppositeDirection) {
    flipReason = 'extreme_price_reversal';
  } else if (strength !== 'strong' && priceCollapsed) {
    // A narrow/near-50 market is uncertainty, not a reversal. Only change the
    // locked side after the opposite side has actually taken the lead and the
    // original side has either fallen materially or lost independent support.
    const collapseConfirmed = currentPmDirection === oppositeDirection
      && (priceDropAbs >= minDropAbs || independentOpposition >= 1);
    const independentlyPreserved = originalSupport >= 2 && selectedPrice >= extremePrice;
    if (collapseConfirmed && !independentlyPreserved) flipReason = 'collapsed_locked_side';
  } else if (
    strength === 'weak'
    && selectedPrice < 0.70
    && technicalOpposes
    && spotOpposes
  ) {
    flipReason = 'technical_spot_reversal';
  }

  if (!flipReason) {
    return {
      direction: originalDirection,
      originalDirection,
      oppositeDirection,
      flipped: false,
      strength,
      selectedPrice,
      oppositePrice,
      lockedSelectedPrice: Number.isFinite(lockedSelectedPrice) ? lockedSelectedPrice : null,
      priceDropAbs,
      collapsePrice,
      currentPmDirection,
      technicalDirection: technicalDirection || null,
      spotDirection: spotDirection || null,
      signalDirection: signalDirection || null,
      originalSupport
    };
  }

  return {
    direction: oppositeDirection,
    originalDirection,
    oppositeDirection,
    flipped: true,
    flipReason,
    strength,
    selectedPrice,
    oppositePrice,
    lockedSelectedPrice: Number.isFinite(lockedSelectedPrice) ? lockedSelectedPrice : null,
    priceDropAbs,
    collapsePrice,
    currentPmDirection,
    technicalDirection: technicalDirection || null,
    spotDirection: spotDirection || null,
    signalDirection: signalDirection || null,
    originalSupport,
    reason: `Plan5 执行前重判：原 ${originalDirection.toUpperCase()} 最新仅 ${(selectedPrice * 100).toFixed(1)}¢，改为 ${oppositeDirection.toUpperCase()}。`
  };
}

export function evaluatePlan5ConsensusGate({
  signal,
  lock,
  timeframe = '5m',
  config = {},
  now = new Date()
} = {}) {
  if (config.plan5ConsensusEnabled !== true) {
    return { allowed: true, skipped: true };
  }
  const signalDirection = String(signal?.direction || '').toLowerCase();
  const lockDirection = String(lock?.direction || '').toLowerCase();
  const technicalDirection = String(signal?.technicalDirection || signal?.techDirection || '').toLowerCase();
  const spotDirection = String(signal?.spotDirection || '').toLowerCase();
  const confidence = Number(signal?.confidence);
  const minConfidence = Number(
    timeframe === '15m'
      ? config.plan5ConsensusMinConfidence15m
      : config.plan5ConsensusMinConfidence5m
  );
  const requiredConfidence = Number.isFinite(minConfidence) ? minConfidence : 0.62;
  const timeframeGap = timeframe === '15m'
    ? Number(config.plan5ConsensusMinPmGap15m)
    : Number(config.plan5ConsensusMinPmGap5m);
  const minPmGap = Number.isFinite(timeframeGap)
    ? timeframeGap
    : (Number.isFinite(Number(config.plan5ConsensusMinPmGap))
      ? Number(config.plan5ConsensusMinPmGap)
      : (timeframe === '15m' ? 0.40 : 0.30));
  if (!['up', 'down'].includes(signalDirection)) {
    return {
      allowed: false,
      signalDirection,
      lockDirection,
      confidence: Number.isFinite(confidence) ? confidence : null,
      minConfidence: requiredConfidence,
      reason: 'Plan5 v10 等待当前综合方向确认，暂不只凭 PM 锁定入场。'
    };
  }
  if (signalDirection !== lockDirection) {
    return {
      allowed: false,
      signalDirection,
      lockDirection,
      confidence: Number.isFinite(confidence) ? confidence : null,
      minConfidence: requiredConfidence,
      reason: `Plan5 v10 锁定方向 ${lockDirection.toUpperCase()} 与当前综合方向 ${signalDirection.toUpperCase()} 冲突，跳过。`
    };
  }
  if (!Number.isFinite(Number(lock?.pmGap)) || Number(lock.pmGap) < minPmGap) {
    return {
      allowed: false,
      signalDirection,
      lockDirection,
      technicalDirection,
      spotDirection,
      confidence: Number.isFinite(confidence) ? confidence : null,
      minConfidence: requiredConfidence,
      minPmGap,
      reason: `Plan5 v13 PM gap 必须至少 ${(minPmGap * 100).toFixed(0)}%，避免把接近随机的盘口领先误判为锁定。`
    };
  }
  const technicalAvailable = ['up', 'down'].includes(technicalDirection);
  const technicalConflict = technicalAvailable && technicalDirection !== lockDirection;
  const strongLock = String(lock?.strength || '').toLowerCase() === 'strong';
  if (config.plan5ConsensusRequireTechnicalAlignment !== false && technicalConflict && !strongLock) {
    return {
      allowed: false,
      signalDirection,
      lockDirection,
      technicalDirection,
      spotDirection,
      confidence: Number.isFinite(confidence) ? confidence : null,
      minConfidence: requiredConfidence,
      reason: `Plan5 独立技术方向 ${technicalDirection.toUpperCase()} 与 PM 锁定 ${lockDirection.toUpperCase()} 冲突。`
    };
  }
  const spotAvailable = ['up', 'down'].includes(spotDirection);
  const spotConflict = spotAvailable && spotDirection !== lockDirection;
  if (!Number.isFinite(confidence) || confidence < requiredConfidence) {
    return {
      allowed: false,
      signalDirection,
      lockDirection,
      confidence: Number.isFinite(confidence) ? confidence : null,
      minConfidence: requiredConfidence,
      reason: `Plan5 v10 综合置信度 ${Number.isFinite(confidence) ? `${(confidence * 100).toFixed(1)}%` : '--'} 低于 ${(requiredConfidence * 100).toFixed(0)}%，等待更可靠确认。`
    };
  }
  const hourConfig = timeframe === '15m'
    ? buildFifteenMinuteDecisionConfig()
    : buildFiveMinuteDecisionConfig();
  const hourGate = evaluateLowWinrateHourGate({
    timeframe,
    at: now,
    pmGap: lock?.pmGap,
    confidence,
    pmDirection: lockDirection,
    techDirection: signal?.techDirection
  }, hourConfig);
  if (!hourGate.allowed) {
    const policy = hourGate.policy;
    const threshold = hourGate.reason === 'low_winrate_hour_gap'
      ? `PM gap 至少 ${(policy.minPmGap * 100).toFixed(0)}%`
      : hourGate.reason === 'low_winrate_hour_confidence'
        ? `综合置信度至少 ${(policy.minConfidence * 100).toFixed(0)}%`
        : '技术方向必须与 PM 同向';
    return {
      allowed: false,
      signalDirection,
      lockDirection,
      confidence,
      minConfidence: requiredConfidence,
      hourGate,
      reason: `Plan5 v10 上海${String(policy.shanghaiHour).padStart(2, '0')}点属于低胜率时段，要求${threshold}。`
    };
  }
  return {
    allowed: true,
    signalDirection,
    lockDirection,
    technicalDirection,
    spotDirection,
    confidence,
    minConfidence: requiredConfidence,
    minPmGap,
    technicalMissing: !technicalAvailable,
    technicalConflict,
    spotMissing: !spotAvailable,
    spotConflict,
    sizeScale: round4(
      (config.plan5ConsensusRequireTechnicalAlignment === false
        ? 1
        : (technicalConflict ? 0.50 : (technicalAvailable ? 1 : 0.85)))
      * (config.plan5ConsensusRequireSpotAlignment === false
        ? 1
        : (spotConflict ? 0.75 : (spotAvailable ? 1 : 0.90)))
    ),
    technicalPmAligned: signal?.polymarket?.aligned ?? null,
    hourGate
  };
}

export function enforcePlan5StrictExecutionGate(gate, {
  config = {},
  quotedEntryPrice = null,
  executionEntryPrice = null
} = {}) {
  if (config.plan5EvStrictExecutionEnabled !== true || !gate || gate.skipped) return gate;
  const conservativeWinRate = Number(gate.conservativeWinRate);
  const requiredWinRate = Number(gate.requiredWinRate);
  const expectedRoi = Number(gate.expectedRoi);
  const hasCalibratedEdge = Number.isFinite(conservativeWinRate)
    && Number.isFinite(requiredWinRate)
    && conservativeWinRate >= requiredWinRate
    && Number.isFinite(expectedRoi)
    && expectedRoi >= 0;
  if (gate.allowed !== false && hasCalibratedEdge && gate.insufficientSamples !== true) {
    return {
      ...gate,
      strictExecution: true,
      quotedEntryPrice: Number.isFinite(Number(quotedEntryPrice)) ? Number(quotedEntryPrice) : null,
      executionEntryPrice: Number.isFinite(Number(executionEntryPrice)) ? Number(executionEntryPrice) : null
    };
  }
  return {
    ...gate,
    allowed: false,
    strictExecution: true,
    shadowCandidate: true,
    quotedEntryPrice: Number.isFinite(Number(quotedEntryPrice)) ? Number(quotedEntryPrice) : null,
    executionEntryPrice: Number.isFinite(Number(executionEntryPrice)) ? Number(executionEntryPrice) : null,
    reason: gate.reason || 'Plan5 可成交价格后的保守 EV 未达到正值，仅记录影子样本。'
  };
}

export function evaluatePlan5ExpectedValueGate({
  symbol,
  timeframe = '5m',
  strength,
  direction = null,
  entryPrice,
  orders = null,
  lockStrengthStats = null,
  config = {},
  paperMode = true,
  now = new Date()
} = {}) {
  if (config.plan5ExpectedValueGateEnabled === false) {
    return { allowed: true, skipped: true };
  }
  const price = Number(entryPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { allowed: false, reason: 'Plan5 EV 无法计算：入场价格无效。' };
  }

  const normalizedSymbol = String(symbol || 'BTC-USD').toUpperCase();
  const normalizedDirection = ['up', 'down'].includes(String(direction || '').toLowerCase())
    ? String(direction).toLowerCase()
    : null;
  const band = resolvePlan5PriceBand(price);
  const sinceMs = Date.parse(config.plan5EvCalibrationSinceIso || '2026-07-10T02:35:00.000Z');
  const allSettled = dedupePlan5CalibrationOrders(orders)
    .filter((order) => {
      if (String(order.planId || '').toLowerCase() !== 'plan5') return false;
      const settledMs = Date.parse(order.settledAtIso || order.closedAtIso || '');
      if (Number.isFinite(sinceMs) && Number.isFinite(settledMs) && settledMs < sinceMs) return false;
      return resolveOrderWon(order) != null && Number.isFinite(resolveOrderEntryPrice(order));
    });
  const isolateVersion = config.plan5EvStrategyVersionIsolationEnabled === true;
  const currentVersionSettled = allSettled.filter(
    (order) => String(order.strategyVersion || '') === PLAN5_VERSION
  );
  const bootstrapMinSamples = Math.max(12, Number(config.plan5EvVersionBootstrapMinSamples) || 48);
  const versionBootstrap = isolateVersion && currentVersionSettled.length < bootstrapMinSamples;
  const settled = !isolateVersion
    ? allSettled
    : (versionBootstrap
        ? allSettled.filter((order) => (
            String(order.strategyVersion || '') === PLAN5_VERSION
            || PLAN5_VERSION_BOOTSTRAP_PREDECESSORS.has(String(order.strategyVersion || ''))
          ))
        : currentVersionSettled);

  const buildCandidates = (rows) => [
    {
      level: 'symbol_timeframe_direction_price',
      minSamples: Number(config.plan5EvPriceMinSamples)
        || Number(config.plan5EvExactMinSamples)
        || 8,
      rows: rows.filter((order) => matchesPlan5Order(
        order, normalizedSymbol, timeframe, band, null, normalizedDirection
      ))
    },
    {
      level: 'timeframe_direction_price',
      minSamples: Number(config.plan5EvTimeframePriceMinSamples) || 12,
      rows: rows.filter((order) => matchesPlan5Order(
        order, null, timeframe, band, null, normalizedDirection
      ))
    },
    {
      level: 'symbol_timeframe_direction',
      minSamples: Number(config.plan5EvSymbolTimeframeMinSamples) || 16,
      rows: rows.filter((order) => matchesPlan5Order(
        order, normalizedSymbol, timeframe, null, null, normalizedDirection
      ))
    }
  ];
  const isLive = paperMode === false;
  const liveParity = config.plan5LiveParityEnabled === true;
  const paperOnly = !isLive && config.plan5EvPaperOnlyEnabled === true;
  const shadowLive = !paperOnly && liveParity;
  const liveOnly = (isLive || shadowLive) && config.plan5EvLiveOnlyEnabled !== false;
  const calibrationSource = paperOnly ? 'paper' : (liveOnly ? 'live' : 'mixed');
  const calibrationRows = paperOnly
    ? settled.filter((order) => String(order.source || '').toLowerCase() !== 'live')
    : (liveOnly
        ? settled.filter((order) => String(order.source || '').toLowerCase() === 'live')
        : settled);
  const candidates = buildCandidates(calibrationRows);
  let cohort = candidates.find((item) => item.rows.length >= item.minSamples);
  let provisionalCohort = false;
  if (!cohort && !isLive && !shadowLive && config.plan5EvExploratoryVetoEnabled !== false) {
    const largest = [...candidates].sort((a, b) => b.rows.length - a.rows.length)[0];
    const exploratoryMinSamples = Math.max(2, Number(config.plan5EvExploratoryMinSamples) || 8);
    if (largest?.rows.length >= exploratoryMinSamples) {
      cohort = largest;
      provisionalCohort = true;
    }
  }
  if (!cohort) {
    const sampleCount = Math.max(0, ...candidates.map((item) => item.rows.length));
    // A new direction model must first generate its own evidence.  During that
    // bootstrap period EV is sizing information only; lack of predecessor
    // samples cannot veto a direction selected by the new model.
    if (versionBootstrap) {
      return {
        allowed: true,
        insufficientSamples: true,
        versionBootstrap: true,
        sizingOnlyBootstrap: true,
        sampleCount,
        priceBand: band,
        direction: normalizedDirection,
        calibrationSource,
        sizeScale: 1,
        reason: `Plan5 ${PLAN5_VERSION} 正在积累自身样本（${currentVersionSettled.length}/${bootstrapMinSamples}），旧版 EV 不拦截，仅供后续调仓。`
      };
    }
    // A completed direction lock owns participation. Missing EV calibration is
    // uncertainty, not negative evidence: keep collecting live samples with the
    // configured minimum sizing scale instead of creating a hidden second lock.
    if (isLive || shadowLive || config.plan5EvRejectInsufficientSamples === true) {
      const configuredFloor = Number(config.plan5LockedSignalMinSizeScale);
      const sizeScale = clampNumber(configuredFloor, 0.05, 1, 0.25);
      return {
        allowed: true,
        insufficientSamples: true,
        softReject: true,
        sizingOnlyBypass: true,
        sampleCount,
        priceBand: band,
        direction: normalizedDirection,
        calibrationSource,
        sizeScale,
        reason: `Plan5 EV 分层${liveOnly ? '实盘' : ''}样本不足（n=${sampleCount}，方向=${normalizedDirection || 'n/a'}），仅降为最小探索仓×${sizeScale.toFixed(2)}，不否决已锁定方向。`
      };
    }
    return {
      allowed: true,
      insufficientSamples: true,
      sampleCount,
      priceBand: band,
      direction: normalizedDirection,
      calibrationSource,
      reason: 'Plan5 EV 分层样本不足，模拟盘继续积累方向样本。'
    };
  }

  const sampleCount = cohort.rows.length;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const weightedRows = cohort.rows.map((order) => ({
    order,
    weight: resolvePlan5OrderWeight(order, config, nowMs),
    won: resolveOrderWon(order),
    realizedRoi: resolveOrderRealizedRoi(order)
  }));
  const effectiveSampleCount = weightedRows.reduce((sum, item) => sum + item.weight, 0);
  const weightedWins = weightedRows.reduce((sum, item) => sum + (item.won === true ? item.weight : 0), 0);
  const wins = cohort.rows.filter((order) => resolveOrderWon(order) === true).length;
  const realizedRows = weightedRows.filter((item) => Number.isFinite(item.realizedRoi));
  const realizedWeight = realizedRows.reduce((sum, item) => sum + item.weight, 0);
  const realizedRoi = realizedWeight > 0
    ? realizedRows.reduce((sum, item) => sum + item.realizedRoi * item.weight, 0) / realizedWeight
    : null;

  const recentLive = evaluateRecentPlan5LiveNetRoi(cohort.rows, config);
  if ((isLive || shadowLive) && !versionBootstrap
    && config.plan5EvRecentLiveEnabled !== false && recentLive.ready && !recentLive.allowed) {
    return {
      allowed: false,
      level: cohort.level,
      sampleCount,
      priceBand: band,
      direction: normalizedDirection,
      calibrationSource,
      versionBootstrap,
      liveSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() === 'live').length,
      paperSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() !== 'live').length,
      recentLive,
      expectedRoi: round4(recentLive.roi),
      reason: `Plan5 ${normalizedSymbol.replace(/-USD$/, '')} ${timeframe} ${normalizedDirection || ''} 同类实盘最近 ${recentLive.sampleCount} 笔净 ROI ${(recentLive.roi * 100).toFixed(1)}%，低于要求 ${(recentLive.minRoi * 100).toFixed(1)}%，停止使用已失效信号。`
    };
  }
  // v6：零优势先验 = 市场价格（入场价）；不再用锁定强度历史胜率抬先验
  const priorWinRate = price;
  const priorWeight = Math.max(0, Number(config.plan5EvPriorWeight) || 6);
  const posteriorWinRate = (weightedWins + priorWeight * priorWinRate) / (effectiveSampleCount + priorWeight);
  const uncertaintyWeight = Math.max(0, Number(config.plan5EvUncertaintyWeight) || 0.35);
  const standardError = Math.sqrt(
    Math.max(0, posteriorWinRate * (1 - posteriorWinRate)) / Math.max(1, effectiveSampleCount + priorWeight)
  );
  const conservativeWinRate = clampNumber(posteriorWinRate - uncertaintyWeight * standardError, 0, 1);
  const margin = Number.isFinite(Number(config.plan5EvMargin))
    ? Number(config.plan5EvMargin)
    : (Number.isFinite(Number(config.plan5HistoryMargin)) ? Number(config.plan5HistoryMargin) : 0.01);
  const requiredWinRate = Math.min(0.99, price + margin);
  const probabilityExpectedRoi = conservativeWinRate / price - 1;
  const realizedWeightConfig = (isLive || shadowLive)
    ? clampNumber(config.plan5EvRealizedRoiWeightLive, 0, 1, 1)
    : clampNumber(config.plan5EvRealizedRoiWeight, 0, 0.8, 0.35);
  const realizedBlendWeight = Number.isFinite(realizedRoi) ? realizedWeightConfig : 0;
  const expectedRoi = probabilityExpectedRoi * (1 - realizedBlendWeight)
    + (Number.isFinite(realizedRoi) ? realizedRoi * realizedBlendWeight : 0);
  const probabilityBelowBreakEven = conservativeWinRate < requiredWinRate;
  const realizedEvidenceMinRoi = Math.max(0, Number(config.plan5EvRecentLiveMinRoi) || 0);
  const realizedEvidenceOverride = config.plan5EvRealizedOverrideEnabled === true
    && probabilityBelowBreakEven
    && recentLive.ready
    && recentLive.allowed
    && Number.isFinite(realizedRoi)
    && realizedRoi >= realizedEvidenceMinRoi
    && expectedRoi >= realizedEvidenceMinRoi;
  const negativeExpectedValue = (probabilityBelowBreakEven && !realizedEvidenceOverride) || expectedRoi < 0;
  const exploratoryHardRejectRoi = Number.isFinite(Number(config.plan5EvExploratoryHardRejectRoi))
    ? Number(config.plan5EvExploratoryHardRejectRoi)
    : -0.15;
  const exploratoryHardRejectGap = Number.isFinite(Number(config.plan5EvExploratoryHardRejectGap))
    ? Number(config.plan5EvExploratoryHardRejectGap)
    : 0.12;
  const winRateGap = requiredWinRate - conservativeWinRate;
  if (provisionalCohort && negativeExpectedValue
    && expectedRoi > exploratoryHardRejectRoi
    && winRateGap < exploratoryHardRejectGap) {
    return {
      allowed: true,
      insufficientSamples: true,
      provisionalCohort: true,
      level: cohort.level,
      sampleCount,
      effectiveSampleCount: round4(effectiveSampleCount),
      wins,
      priceBand: band,
      direction: normalizedDirection,
      conservativeWinRate: round4(conservativeWinRate),
      requiredWinRate: round4(requiredWinRate),
      expectedRoi: round4(expectedRoi),
      probabilityExpectedRoi: round4(probabilityExpectedRoi),
      realizedRoi: Number.isFinite(realizedRoi) ? round4(realizedRoi) : null,
      calibrationSource,
      realizedEvidenceOverride,
      liveSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() === 'live').length,
      paperSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() !== 'live').length,
      sizeScale: 1,
      reason: `Plan5 探索分层 n=${sampleCount} 尚未达正式门槛，负 EV 未达到严重否决线，继续积累模拟样本。`
    };
  }
  if (negativeExpectedValue) {
    const mode = String(config.plan5EvGateMode || 'soft').toLowerCase();
    const hardRejectRoi = Number.isFinite(Number(config.plan5EvHardRejectRoi))
      ? Number(config.plan5EvHardRejectRoi)
      : -0.40;
    const winRateScale = conservativeWinRate / Math.max(requiredWinRate, 1e-6);
    const roiScale = 1 + expectedRoi;
    const sizeScale = clampNumber(Math.min(winRateScale, roiScale), 0.25, 1);
    const base = {
      level: cohort.level,
      sampleCount,
      effectiveSampleCount: round4(effectiveSampleCount),
      wins,
      priceBand: band,
      direction: normalizedDirection,
      priorWinRate: round4(priorWinRate),
      posteriorWinRate: round4(posteriorWinRate),
      conservativeWinRate: round4(conservativeWinRate),
      requiredWinRate: round4(requiredWinRate),
      expectedRoi: round4(expectedRoi),
      probabilityExpectedRoi: round4(probabilityExpectedRoi),
      realizedRoi: Number.isFinite(realizedRoi) ? round4(realizedRoi) : null,
      realizedEvidenceOverride,
      provisionalCohort,
      calibrationSource,
      recentLive,
      liveSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() === 'live').length,
      paperSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() !== 'live').length,
      sizeScale: round4(sizeScale)
    };
    if (versionBootstrap) {
      return {
        allowed: true,
        softReject: true,
        sizingOnlyBootstrap: true,
        versionBootstrap: true,
        ...base,
        reason: `Plan5 ${PLAN5_VERSION} 正在积累自身样本（${currentVersionSettled.length}/${bootstrapMinSamples}）；旧版保守 EV ${(expectedRoi * 100).toFixed(1)}% 只用于调仓×${sizeScale.toFixed(2)}，不否决新版方向。`
      };
    }
    // hard 模式，或期望 ROI 极差时才硬拒；默认 soft 降仓继续交易，避免几乎全 skip
    if (mode === 'hard' || expectedRoi < 0 || expectedRoi <= hardRejectRoi) {
      return {
        allowed: false,
        ...base,
        reason: `Plan5 ${normalizedSymbol.replace(/-USD$/, '')} ${timeframe} ${normalizedDirection || ''} ${band} 保守胜率 ${(conservativeWinRate * 100).toFixed(1)}% 低于当前价格要求 ${(requiredWinRate * 100).toFixed(1)}%（n=${sampleCount}），属于负期望信号。`
      };
    }
    return {
      allowed: true,
      softReject: true,
      ...base,
      reason: `Plan5 ${normalizedSymbol.replace(/-USD$/, '')} ${timeframe} ${normalizedDirection || ''} ${band} 保守 EV ${(expectedRoi * 100).toFixed(1)}%，软降仓×${sizeScale.toFixed(2)}（n=${sampleCount}）。`
    };
  }
  return {
    allowed: true,
    level: cohort.level,
    sampleCount,
    effectiveSampleCount: round4(effectiveSampleCount),
    wins,
    priceBand: band,
    direction: normalizedDirection,
    priorWinRate: round4(priorWinRate),
    posteriorWinRate: round4(posteriorWinRate),
    conservativeWinRate: round4(conservativeWinRate),
    requiredWinRate: round4(requiredWinRate),
    expectedRoi: round4(expectedRoi),
    probabilityExpectedRoi: round4(probabilityExpectedRoi),
    realizedRoi: Number.isFinite(realizedRoi) ? round4(realizedRoi) : null,
    calibrationSource,
    recentLive,
    realizedEvidenceOverride,
    provisionalCohort,
    insufficientSamples: provisionalCohort,
    liveSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() === 'live').length,
    paperSampleCount: cohort.rows.filter((order) => String(order.source || '').toLowerCase() !== 'live').length,
    sizeScale: 1
  };
}

function evaluateRecentPlan5LiveNetRoi(rows, config = {}) {
  const minSamples = Math.max(2, Number(config.plan5EvRecentLiveMinSamples) || 6);
  const lookbackSamples = Math.max(minSamples, Number(config.plan5EvRecentLiveLookbackSamples) || 8);
  const minRoi = Number.isFinite(Number(config.plan5EvRecentLiveMinRoi))
    ? Number(config.plan5EvRecentLiveMinRoi)
    : 0;
  const recent = rows
    .filter((order) => (
      String(order?.source || '').toLowerCase() === 'live'
      && Number.isFinite(Number(order?.usd))
      && Number(order.usd) > 0
      && Number.isFinite(Number(order?.pnl))
    ))
    .sort((a, b) => Date.parse(b.settledAtIso || b.closedAtIso || '') - Date.parse(a.settledAtIso || a.closedAtIso || ''))
    .slice(0, lookbackSamples);
  const investedUsd = recent.reduce((sum, order) => sum + Number(order.usd), 0);
  const pnl = recent.reduce((sum, order) => sum + Number(order.pnl), 0);
  const roi = investedUsd > 0 ? pnl / investedUsd : null;
  return {
    ready: recent.length >= minSamples && Number.isFinite(roi),
    allowed: recent.length < minSamples || !Number.isFinite(roi) || roi >= minRoi,
    sampleCount: recent.length,
    minSamples,
    lookbackSamples,
    investedUsd: round4(investedUsd),
    pnl: round4(pnl),
    roi: Number.isFinite(roi) ? round4(roi) : null,
    minRoi
  };
}

export function evaluatePlan5SignalQuality({ lock, sentiment, timeframe = '5m', now = new Date(), config = {}, paperMode = true } = {}) {
  if (config.plan5SignalQualityEnabled === false) return { allowed: true, skipped: true };
  const samples = sentiment?.windowTrack?.snapshot?.samples;
  const direction = String(lock?.direction || '').toLowerCase();
  const requireSamples = (paperMode === false || config.plan5LiveParityEnabled === true)
    && config.plan5SignalQualityRequireSamplesLive !== false;
  if (!Array.isArray(samples) || !samples.length || !['up', 'down'].includes(direction)) {
    return requireSamples
      ? { allowed: false, insufficientSamples: true, skipReason: 'signal_quality_samples_missing', reason: `Plan5 ${timeframe} 缺少实盘口径的盘口稳定性样本。` }
      : { allowed: true, insufficientSamples: true };
  }
  const minSamples = Math.max(2, Number(config.plan5SignalQualityMinSamples) || (timeframe === '5m' ? 3 : 4));
  if (samples.length < minSamples) {
    return requireSamples
      ? { allowed: false, insufficientSamples: true, skipReason: 'signal_quality_samples_insufficient', sampleCount: samples.length, minSamples, reason: `Plan5 ${timeframe} 实盘口径的盘口样本不足（${samples.length}/${minSamples}）。` }
      : { allowed: true, insufficientSamples: true, sampleCount: samples.length, minSamples };
  }

  const leaders = samples.map((sample) => Number(sample.upPrice) >= Number(sample.downPrice) ? 'up' : 'down');
  let tailCount = 0;
  for (let index = leaders.length - 1; index >= 0 && leaders[index] === direction; index -= 1) tailCount += 1;
  if (tailCount < minSamples) {
    return {
      allowed: false,
      skipReason: 'signal_quality_unstable',
      sampleCount: samples.length,
      stableSamples: tailCount,
      reason: `Plan5 ${timeframe} 当前领先方向只连续 ${tailCount} 个样本，尚未形成稳定锁定。`
    };
  }

  const stableStart = samples[samples.length - tailCount];
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const stableMs = Math.max(0, nowMs - Number(stableStart?.ts || nowMs));
  const minStableMs = Math.max(0, Number(
    timeframe === '5m' ? config.plan5SignalQualityMinStableMs5m : config.plan5SignalQualityMinStableMs15m
  ) || (timeframe === '5m' ? 5000 : 10000));
  if (stableMs < minStableMs) {
    return {
      allowed: false,
      skipReason: 'signal_quality_not_stable_yet',
      sampleCount: samples.length,
      stableSamples: tailCount,
      stableMs,
      minStableMs,
      reason: `Plan5 ${timeframe} 方向仅稳定 ${(stableMs / 1000).toFixed(0)} 秒，等待达到 ${(minStableMs / 1000).toFixed(0)} 秒确认。`
    };
  }

  const softMode = String(config.plan5SignalQualityMode || 'soft').toLowerCase() !== 'hard';
  const trajectory = sentiment.windowTrack?.[direction] || null;
  const maxPullback = Number.isFinite(Number(config.plan5SignalQualityMaxPullback))
    ? Number(config.plan5SignalQualityMaxPullback)
    : (timeframe === '5m' ? 0.10 : 0.12);
  const pullback = Number(trajectory?.pullbackFromPeak);
  if (Number.isFinite(pullback) && pullback > maxPullback) {
    const sizeScale = clampNumber(maxPullback / Math.max(pullback, 1e-6), 0.35, 1);
    const base = {
      sampleCount: samples.length,
      stableSamples: tailCount,
      stableMs,
      pullbackFromPeak: pullback,
      sizeScale: round4(sizeScale),
      reason: `Plan5 ${timeframe} 锁定方向已从峰值回撤 ${pullback.toFixed(3)}，超过 ${maxPullback.toFixed(3)}，信号正在衰减。`
    };
    if (!softMode) {
      return { allowed: false, skipReason: 'signal_quality_pullback', ...base };
    }
    return { allowed: true, softReject: true, skipReason: 'signal_quality_pullback_soft', ...base };
  }

  const maxReverseBps = Number(config.plan5SignalQualityMaxReverseBps) || (timeframe === '5m' ? 20 : 28);
  const reverseBps = Number(trajectory?.btcMaxReverseBps);
  if (Number.isFinite(reverseBps) && reverseBps > maxReverseBps) {
    const sizeScale = clampNumber(maxReverseBps / Math.max(reverseBps, 1e-6), 0.35, 1);
    const base = {
      sampleCount: samples.length,
      stableSamples: tailCount,
      stableMs,
      reverseBps,
      sizeScale: round4(sizeScale),
      reason: `Plan5 ${timeframe} 标的价格已反向 ${reverseBps.toFixed(1)}bps，锁定信号失真。`
    };
    if (!softMode) {
      return { allowed: false, skipReason: 'signal_quality_reverse', ...base };
    }
    return { allowed: true, softReject: true, skipReason: 'signal_quality_reverse_soft', ...base };
  }
  return {
    allowed: true,
    sampleCount: samples.length,
    stableSamples: tailCount,
    stableMs,
    pullbackFromPeak: Number.isFinite(pullback) ? pullback : null,
    reverseBps: Number.isFinite(reverseBps) ? reverseBps : null,
    sizeScale: 1
  };
}

export function evaluatePlan5EntryTiming({ lock, schedule = null, timeframe = '5m', now = new Date(), config = {} } = {}) {
  if (config.plan5EntryTimingEnabled !== true) return { allowed: true, skipped: true };
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const slotMs = Date.parse(schedule?.currentSlotIso || '');
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const derivedElapsed = Number.isFinite(slotMs)
    ? (nowMs - slotMs) / (slotMinutes * 60_000)
    : null;
  const elapsedPct = Number.isFinite(Number(schedule?.elapsedInCurrentSlotPct))
    ? Number(schedule.elapsedInCurrentSlotPct)
    : derivedElapsed;
  const weak = String(lock?.strength || '').toLowerCase() === 'weak';
  const configuredMin = timeframe === '15m'
    ? (weak ? config.plan5WeakMinElapsedPct15m : config.plan5MinElapsedPct15m)
    : (weak ? config.plan5WeakMinElapsedPct5m : config.plan5MinElapsedPct5m);
  const minElapsedPct = clampNumber(configuredMin, 0, 0.9, 0.25);
  if (!Number.isFinite(elapsedPct) || elapsedPct < minElapsedPct) {
    return {
      allowed: false,
      skipReason: 'entry_timing_too_early',
      elapsedPct: Number.isFinite(elapsedPct) ? round4(elapsedPct) : null,
      minElapsedPct,
      reason: `Plan5 ${timeframe} ${weak ? '弱锁定' : '锁定'}形成过早，窗口进度 ${Number.isFinite(elapsedPct) ? `${(elapsedPct * 100).toFixed(0)}%` : '未知'}，等待至少 ${(minElapsedPct * 100).toFixed(0)}%。`
    };
  }
  const lockedAtMs = Date.parse(lock?.lockedAtIso || '');
  const configuredAge = timeframe === '15m' ? config.plan5MinLockAgeMs15m : config.plan5MinLockAgeMs5m;
  const parsedAge = Number(configuredAge);
  const minLockAgeMs = Math.max(0, Number.isFinite(parsedAge) ? parsedAge : (timeframe === '15m' ? 30000 : 15000));
  const lockAgeMs = Number.isFinite(lockedAtMs) ? Math.max(0, nowMs - lockedAtMs) : null;
  const lockSource = String(lock?.lockSource || lock?.source || '').toLowerCase();
  const enforceLockAge = lockSource !== 'display' && minLockAgeMs > 0;
  if (enforceLockAge && Number.isFinite(lockAgeMs) && lockAgeMs < minLockAgeMs) {
    return {
      allowed: false,
      skipReason: 'entry_lock_too_fresh',
      elapsedPct: round4(elapsedPct),
      lockAgeMs,
      minLockAgeMs,
      reason: `Plan5 ${timeframe} 锁定仅保持 ${(lockAgeMs / 1000).toFixed(0)} 秒，等待至少 ${(minLockAgeMs / 1000).toFixed(0)} 秒确认。`
    };
  }
  return { allowed: true, elapsedPct: round4(elapsedPct), lockAgeMs, minElapsedPct, minLockAgeMs, enforceLockAge };
}

export function evaluatePlan5StopLoss({
  positionDirection,
  currentPrice,
  currentPmDirection = null,
  config = {}
} = {}) {
  if (config.plan5StopLossEnabled === false) return null;
  const price = Number(currentPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  const held = String(positionDirection || '').toLowerCase();
  const current = String(currentPmDirection || '').toLowerCase();
  const conditionalStop = clampNumber(config.plan5ConditionalStopPrice, 0.05, 0.60, 0.30);
  const emergencyStop = Math.min(
    conditionalStop,
    clampNumber(config.plan5EmergencyStopPrice, 0.01, 0.40, 0.20)
  );

  if (price <= emergencyStop) {
    return {
      exitPrice: price,
      exitStatus: 'plan5-emergency-stop',
      exitReason: `Plan5 可成交 bid ${(price * 100).toFixed(1)}¢ <= 紧急止损 ${(emergencyStop * 100).toFixed(0)}¢`
    };
  }
  if (
    price <= conditionalStop
    && ['up', 'down'].includes(held)
    && ['up', 'down'].includes(current)
    && current !== held
  ) {
    return {
      exitPrice: price,
      exitStatus: 'plan5-reversal-stop',
      exitReason: `Plan5 可成交 bid ${(price * 100).toFixed(1)}¢ <= 条件止损 ${(conditionalStop * 100).toFixed(0)}¢，PM 方向已反转为 ${current.toUpperCase()}`
    };
  }
  return null;
}

/**
 * 胜率页「同条件胜率 / 建议权重」→ Plan5 软调仓。
 * 样本不足时不挡买入；样本够时用 suggestedWeight 缩放仓位（默认不硬拒）。
 */
export function evaluatePlan5WinrateGuidanceGate({
  symbol = 'BTC-USD',
  timeframe = '5m',
  direction = null,
  lock = null,
  signal = null,
  sameDirectionAsPrev = null,
  statsDb = null,
  config = {},
  now = new Date()
} = {}) {
  if (config.plan5WinrateGuidanceEnabled === false) {
    return { allowed: true, skipped: true, sizeScale: 1 };
  }
  if (!['up', 'down'].includes(direction)) {
    return { allowed: true, insufficientSamples: true, sizeScale: 1, reason: '无锁定方向，跳过同条件指导。' };
  }
  if (!statsDb?.enabled) {
    return { allowed: true, insufficientSamples: true, sizeScale: 1, reason: 'Stats DB 未启用。' };
  }

  const volatilityPct = Number(
    signal?.indicators?.volatility15mPct
    ?? signal?.indicators?.volatility5mPct
    ?? signal?.indicators?.volatilityPct
  );
  const judgment = {
    symbol: String(symbol || 'BTC-USD').toUpperCase(),
    timeframe: timeframe === '15m' ? '15m' : '5m',
    predictedDirection: direction,
    lockStrength: lock?.strength || lock?.lockStrength || null,
    hourBucket: resolveHourBucket(now),
    volatilityBucket: resolveVolatilityBucket(volatilityPct),
    sameDirectionAsPrev: sameDirectionAsPrev == null ? null : Boolean(sameDirectionAsPrev),
    predictedAtIso: now instanceof Date ? now.toISOString() : String(now)
  };
  const lookbackDays = Number(config.plan5WinrateGuidanceLookbackDays)
    || Number(config.plan5HistoryLookbackDays)
    || 14;
  const minSamples = Number(config.plan5WinrateGuidanceMinSamples) || 8;
  const recentGuidance = buildJudgmentGuidance({
    judgment,
    statsDb,
    lookbackDays,
    minSamples
  });
  const longTermLookbackDays = Math.max(
    lookbackDays,
    Number(config.plan5LongTermLookbackDays) || 3650
  );
  const longTermGuidance = longTermLookbackDays > lookbackDays
    ? buildJudgmentGuidance({
        judgment,
        statsDb,
        lookbackDays: longTermLookbackDays,
        minSamples
      })
    : recentGuidance;
  const guidance = blendPlan5WinrateGuidance(recentGuidance, longTermGuidance, config);

  if (guidance.sampleInsufficient) {
    return {
      allowed: true,
      insufficientSamples: true,
      sizeScale: 1,
      sampleCount: Number(guidance.conditional?.total) || 0,
      minSamples,
      guidance,
      reason: guidance.note
    };
  }

  const rawWeight = Number(guidance.suggestedWeight);
  const weight = Number.isFinite(rawWeight) ? rawWeight : 1;
  const floor = Number(config.plan5WinrateGuidanceSizeFloor);
  const sizeFloor = Number.isFinite(floor) && floor > 0 ? Math.min(1, floor) : 0.5;
  const sizeScale = round4(Math.max(sizeFloor, Math.min(1.2, weight)));
  const mode = String(config.plan5WinrateGuidanceMode || 'soft').toLowerCase();
  const hardRejectWeight = Number(config.plan5WinrateGuidanceHardRejectWeight);
  const rejectBelow = Number.isFinite(hardRejectWeight) ? hardRejectWeight : 0.55;

  if (mode === 'hard' && weight < rejectBelow) {
    return {
      allowed: false,
      sizeScale,
      sampleCount: Number(guidance.conditional?.total) || 0,
      conditionalWinRate: Number(guidance.conditional?.winRate) || 0,
      suggestedWeight: weight,
      guidance,
      skipReason: 'winrate_guidance_hard_reject',
      reason: `Plan5 同条件胜率指导权重 ×${weight.toFixed(2)} 过低（硬拒 <${rejectBelow}），${guidance.note || ''}`.trim()
    };
  }

  return {
    allowed: true,
    insufficientSamples: false,
    sizeScale,
    sampleCount: Number(guidance.conditional?.total) || 0,
    conditionalWinRate: Number(guidance.conditional?.winRate) || 0,
    suggestedWeight: weight,
    alignsWithHistoricalEdge: guidance.alignsWithHistoricalEdge,
    guidance,
    softReject: sizeScale < 0.999,
    reason: guidance.note
  };
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

export function blendPlan5LearningStat(recent = {}, longTerm = {}, config = {}) {
  const recentTotal = Math.max(0, Number(recent?.total) || 0);
  const recentCorrect = Math.max(0, Number(recent?.correct) || 0);
  const longTotal = Math.max(0, Number(longTerm?.total) || 0);
  const longCorrect = Math.max(0, Number(longTerm?.correct) || 0);
  const alpha = Math.max(0, Number(config.plan5LearningPriorAlpha) || 1);
  const beta = Math.max(0, Number(config.plan5LearningPriorBeta) || 1);
  const posterior = (correct, total) => (
    total > 0 ? (correct + alpha) / Math.max(1, total + alpha + beta) : null
  );
  const recentRate = posterior(recentCorrect, recentTotal);
  const longRate = posterior(longCorrect, longTotal);
  if (recentRate == null && longRate == null) {
    return {
      total: 0, correct: 0, wrong: 0, accuracy: 0,
      recent: { total: 0, correct: 0, accuracy: null },
      longTerm: { total: 0, correct: 0, accuracy: null },
      recentWeight: 0,
      drift: 0,
      conservativeAccuracy: 0
    };
  }

  const minWeight = clampNumber(config.plan5LearningRecentWeightMin, 0, 1, 0.15);
  const maxWeight = clampNumber(config.plan5LearningRecentWeightMax, minWeight, 1, 0.70);
  const baseWeight = clampNumber(config.plan5LearningRecentWeight, minWeight, maxWeight, 0.35);
  const minRecentSamples = Math.max(1, Number(config.plan5HistoryMinSamples) || 20);
  const coverage = recentTotal / (recentTotal + minRecentSamples);
  const drift = recentRate != null && longRate != null ? Math.abs(recentRate - longRate) : 0;
  const driftThreshold = Math.max(0.001, Number(config.plan5LearningDriftThreshold) || 0.05);
  const driftBoost = Math.min(1, drift / driftThreshold) * (maxWeight - baseWeight);
  let recentWeight = recentRate == null
    ? 0
    : longRate == null
      ? 1
      : minWeight + (baseWeight - minWeight) * coverage + driftBoost;
  recentWeight = clampNumber(recentWeight, 0, maxWeight, baseWeight);

  const fusedAccuracy = longRate == null
    ? recentRate
    : recentRate == null
      ? longRate
      : longRate * (1 - recentWeight) + recentRate * recentWeight;
  const effectiveSamples = Math.max(
    1,
    longTotal * (1 - recentWeight) + recentTotal * recentWeight + alpha + beta
  );
  const standardError = Math.sqrt(
    Math.max(0, fusedAccuracy * (1 - fusedAccuracy)) / effectiveSamples
  );
  const conservativeZ = Math.max(0, Number(config.plan5LearningConservativeZ) || 0.50);
  const conservativeAccuracy = clampNumber(
    fusedAccuracy - conservativeZ * standardError,
    0,
    1,
    fusedAccuracy
  );
  const total = longTotal || recentTotal;
  const correct = longTotal ? longCorrect : recentCorrect;
  return {
    total,
    correct,
    wrong: Math.max(0, total - correct),
    accuracy: round4(conservativeAccuracy),
    rawAccuracy: round4(fusedAccuracy),
    conservativeAccuracy: round4(conservativeAccuracy),
    effectiveSamples: round4(effectiveSamples),
    recentWeight: round4(recentWeight),
    drift: round4(drift),
    recent: {
      total: recentTotal,
      correct: recentCorrect,
      accuracy: recentRate == null ? null : round4(recentRate)
    },
    longTerm: {
      total: longTotal,
      correct: longCorrect,
      accuracy: longRate == null ? null : round4(longRate)
    }
  };
}

export function blendPlan5LockStrengthStats(recent = {}, longTerm = {}, config = {}) {
  const keys = new Set([
    'weak', 'normal', 'strong',
    ...Object.keys(recent || {}),
    ...Object.keys(longTerm || {})
  ]);
  return Object.fromEntries(
    [...keys].map((key) => [
      key,
      blendPlan5LearningStat(recent?.[key], longTerm?.[key], config)
    ])
  );
}

function plan5WeightFromWinRate(winRate, alignsWithHistoricalEdge = null) {
  let weight = 1;
  if (winRate >= 0.62) weight = 1.15;
  else if (winRate >= 0.55) weight = 1.05;
  else if (winRate < 0.42) weight = 0.70;
  else if (winRate < 0.48) weight = 0.85;
  if (alignsWithHistoricalEdge === false) weight = Math.min(weight, 0.80);
  else if (alignsWithHistoricalEdge === true) weight = Math.min(1.20, weight + 0.05);
  return weight;
}

export function blendPlan5WinrateGuidance(recent = {}, longTerm = {}, config = {}) {
  const memory = blendPlan5LearningStat(recent?.conditional, longTerm?.conditional, config);
  if (!memory.total) return recent;
  const alignsWithHistoricalEdge = recent?.alignsWithHistoricalEdge
    ?? longTerm?.alignsWithHistoricalEdge
    ?? null;
  let suggestedWeight = plan5WeightFromWinRate(memory.accuracy, alignsWithHistoricalEdge);
  if (recent?.hourRegime?.weak) suggestedWeight = Math.min(suggestedWeight, 0.80);
  const minSamples = Number(config.plan5WinrateGuidanceMinSamples) || 8;
  return {
    ...recent,
    sampleInsufficient: memory.total < minSamples,
    conditional: {
      total: memory.total,
      correct: memory.correct,
      wrong: memory.wrong,
      winRate: memory.accuracy,
      sampleInsufficient: memory.total < minSamples
    },
    suggestedWeight: round4(suggestedWeight),
    alignsWithHistoricalEdge,
    learningMemory: memory,
    recentGuidance: recent,
    longTermGuidance: longTerm,
    note: `Plan5 同条件双记忆保守胜率 ${(memory.accuracy * 100).toFixed(1)}%（长期 n=${memory.longTerm.total}，近期 n=${memory.recent.total}，近期权重 ${(memory.recentWeight * 100).toFixed(0)}%）`
  };
}

export function evaluatePlan5LockHistoryGate({
  strength, entryPrice, lockStrengthStats = null, config = {}
} = {}) {
  if (config.plan5HistoryGateEnabled === false) {
    return { allowed: true, skipped: true, sizeScale: 1 };
  }
  const key = String(strength || '').toLowerCase();
  const stats = resolveFiveMinuteLockStrengthStat(lockStrengthStats, key);
  const minSamples = Number(config.plan5HistoryMinSamples) || 20;
  const sampleCount = Number(stats.total) || 0;
  const winRate = Number(stats.accuracy);
  const learningMemory = stats.longTerm || stats.recent
    ? {
        longTerm: stats.longTerm || null,
        recent: stats.recent || null,
        recentWeight: stats.recentWeight ?? null,
        drift: stats.drift ?? null,
        rawAccuracy: stats.rawAccuracy ?? null,
        conservativeAccuracy: stats.conservativeAccuracy ?? stats.accuracy ?? null,
        effectiveSamples: stats.effectiveSamples ?? null
      }
    : null;
  if (!sampleCount || sampleCount < minSamples || !Number.isFinite(winRate)) {
    if (config.plan5HistoryRequireSamples === true) {
      return {
        allowed: false, insufficientSamples: true, sampleCount, minSamples, sizeScale: 1,
        skipReason: 'history_insufficient_samples',
        reason: `Plan5 ${key || '未知'}锁历史样本不足（${sampleCount}/${minSamples}），暂缓开仓。`
      };
    }
    return {
      allowed: true,
      insufficientSamples: true,
      sampleCount,
      minSamples,
      sizeScale: 1,
      learningMemory
    };
  }
  const price = Number(entryPrice);
  const margin = Number(config.plan5HistoryMargin);
  // 默认 margin=0：历史胜率只需覆盖入场价；不足时 soft 降仓而非少买
  const safetyMargin = Number.isFinite(margin) ? margin : 0;
  const requiredWinRate = Number.isFinite(price) && price > 0 && price < 1
    ? Math.min(0.99, price + safetyMargin)
    : (Number(config.plan5HistoryMinAccuracy) || 0.55);
  if (winRate < requiredWinRate) {
    const gap = requiredWinRate - winRate;
    const hardGap = Number.isFinite(Number(config.plan5HistoryHardRejectGap))
      ? Number(config.plan5HistoryHardRejectGap)
      : 0.15;
    const mode = String(config.plan5HistoryGateMode || 'soft').toLowerCase();
    const sizeScale = clampNumber(winRate / Math.max(requiredWinRate, 1e-6), 0.25, 1);
    const base = {
      sampleCount,
      winRate: round4(winRate),
      requiredWinRate: round4(requiredWinRate),
      sizeScale: round4(sizeScale),
      gap: round4(gap),
      learningMemory
    };
    // hard 模式，或历史胜率显著低于盈亏平衡时才硬拒；默认 soft 降仓继续交易
    if (mode === 'hard' || gap >= hardGap) {
      return {
        allowed: false,
        skipReason: 'history_negative_ev',
        ...base,
        reason: `Plan5 ${key}锁历史胜率 ${(winRate * 100).toFixed(1)}%（${stats.correct || 0}/${sampleCount}）低于盈亏平衡 ${(requiredWinRate * 100).toFixed(1)}%，跳过负期望单。`
      };
    }
    return {
      allowed: true,
      softReject: true,
      skipReason: 'history_soft_scale',
      ...base,
      reason: `Plan5 ${key}锁历史胜率 ${(winRate * 100).toFixed(1)}% < ${(requiredWinRate * 100).toFixed(1)}%，软降仓×${sizeScale.toFixed(2)}（n=${sampleCount}）。`
    };
  }
  let sizeScale = 1;
  if (config.plan5HistorySizeScaleEnabled === true) {
    const edge = winRate - requiredWinRate;
    sizeScale = clampNumber(0.7 + edge * 4, 0.7, 1.25);
  }
  return {
    allowed: true,
    sampleCount,
    winRate: round4(winRate),
    requiredWinRate: round4(requiredWinRate),
    sizeScale: round4(sizeScale),
    learningMemory
  };
}

/**
 * Plan5 同窗多币敞口门控：限制同一 slotIso 下同时开仓的币种数与总名义敞口。
 * 防止「同向齐开 SOL/ETH/XRP」一次方向错全军 -100%。
 */
export function evaluatePlan5SlotExposureGate({
  symbol,
  timeframe,
  slotIso,
  direction = null,
  usd = null,
  openPlan5Orders = null,
  portfolio = null,
  config = {}
} = {}) {
  if (config.plan5SlotExposureEnabled === false) {
    return { allowed: true, skipped: true };
  }
  const maxSymbols = Math.max(1, Number(config.plan5SlotMaxSymbols) || 2);
  const maxExposurePct = Number(config.plan5SlotMaxExposurePct);
  const exposurePct = Number.isFinite(maxExposurePct) && maxExposurePct > 0 ? maxExposurePct : 0.35;
  const cash = Number(portfolio?.cash ?? portfolio?.equity) || 0;
  const maxExposureUsd = cash > 0 ? cash * exposurePct : Infinity;
  const newUsd = Number(usd) || 0;
  const sym = String(symbol || 'BTC-USD').toUpperCase();
  const tf = timeframe || '5m';
  const dir = direction ? String(direction).toLowerCase() : null;

  const peers = (Array.isArray(openPlan5Orders) ? openPlan5Orders : []).filter((order) => {
    if (!order) return false;
    const pos = String(order.positionStatus || '').toLowerCase();
    const settle = String(order.settlementStatus || '').toLowerCase();
    const status = String(order.status || '').toLowerCase();
    const exitStatus = String(order.exitStatus || '').toLowerCase();
    const isOpenLive = pos === 'open' || pos === 'pending';
    const isOpenPaper = settle === 'open' || settle === 'pending';
    // 实盘 FAK blocked / 未成交也占同窗币种名额，防止异步锁定刷出第 3/4 币。
    const isLiveAttempt = status === 'blocked'
      || status === 'pending'
      || exitStatus === 'expired-unfilled';
    // 调用方通常已过滤 open；此处兼容 paper/live 两种字段
    if (pos || settle || status || exitStatus) {
      if (!isOpenLive && !isOpenPaper && !isLiveAttempt) return false;
    }
    if ((order.timeframe || '5m') !== tf) return false;
    if (slotIso && order.slotIso && order.slotIso !== slotIso) return false;
    if (dir && order.direction && String(order.direction).toLowerCase() !== dir) return false;
    return true;
  });

  const symbolSet = new Set(
    peers.map((order) => String(order.symbol || 'BTC-USD').toUpperCase())
  );
  const alreadyIn = symbolSet.has(sym);
  if (!alreadyIn && symbolSet.size >= maxSymbols) {
    return {
      allowed: false,
      reason: `Plan5 ${tf} 同窗已开 ${symbolSet.size} 币（上限 ${maxSymbols}）：${[...symbolSet].map((s) => s.replace(/-USD$/, '')).join('/')}，跳过 ${sym.replace(/-USD$/, '')} 以防同向齐开全损。`,
      openSymbols: [...symbolSet],
      maxSymbols
    };
  }

  // 敞口只计真实持仓/挂单；blocked / FAK 未成交占名额但不占现金。
  const openUsd = peers.reduce((sum, order) => {
    const pos = String(order.positionStatus || '').toLowerCase();
    const settle = String(order.settlementStatus || '').toLowerCase();
    const counts = pos === 'open' || pos === 'pending' || settle === 'open' || settle === 'pending';
    return counts ? sum + (Number(order.usd) || 0) : sum;
  }, 0);
  const projected = openUsd + (alreadyIn ? 0 : newUsd);
  // 同币加仓仍计入新增 usd
  const projectedWithAdd = openUsd + newUsd;
  if (Number.isFinite(maxExposureUsd) && projectedWithAdd > maxExposureUsd + 1e-6) {
    const room = Math.max(0, maxExposureUsd - openUsd);
    if (room < (Number(config.plan5MinOrderUsd) || 1) && !alreadyIn) {
      return {
        allowed: false,
        reason: `Plan5 ${tf} 同窗敞口已 $${openUsd.toFixed(2)} / 上限 $${maxExposureUsd.toFixed(2)}（现金×${(exposurePct * 100).toFixed(0)}%），剩余不足再开新币。`,
        openUsd,
        maxExposureUsd,
        cappedUsd: room
      };
    }
    if (room <= 0) {
      return {
        allowed: false,
        reason: `Plan5 ${tf} 同窗敞口已达上限 $${maxExposureUsd.toFixed(2)}（当前 $${openUsd.toFixed(2)}）。`,
        openUsd,
        maxExposureUsd,
        cappedUsd: 0
      };
    }
    return {
      allowed: true,
      cappedUsd: round2(Math.min(newUsd, room)),
      openUsd,
      maxExposureUsd,
      openSymbols: [...symbolSet],
      reason: `Plan5 同窗敞口剩余 $${room.toFixed(2)}，本笔降仓。`
    };
  }

  return {
    allowed: true,
    openUsd,
    maxExposureUsd: Number.isFinite(maxExposureUsd) ? maxExposureUsd : null,
    openSymbols: [...symbolSet],
    projectedUsd: projectedWithAdd
  };
}

export function evaluatePlan5CurrentMarketAlignment({ lock, sentiment, config = {} } = {}) {
  const up = Number(sentiment?.upPrice);
  const down = Number(sentiment?.downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up <= 0 || down <= 0) {
    return { allowed: false, reason: 'Plan5 当前 UP/DOWN 双边报价不完整。' };
  }
  const quoteSum = round4(up + down);
  const min = Number(config.plan5QuoteSumMin) || 0.95;
  const max = Number(config.plan5QuoteSumMax) || 1.08;
  if (quoteSum < min || quoteSum > max) {
    if (config.plan5LockedSignalSizingOnlyEnabled !== false && ['up', 'down'].includes(lock?.direction)) {
      const configuredFloor = Number(config.plan5LockedSignalMinSizeScale);
      const sizeScale = clampNumber(configuredFloor, 0.05, 1, 0.25);
      return {
        allowed: true,
        quoteSum,
        quoteDesynced: true,
        executionQuoteRefreshRequired: true,
        softReject: true,
        sizingOnlyBypass: true,
        sizeScale,
        reason: `Plan5 UP/DOWN 报价和 ${quoteSum.toFixed(3)} 异常；保留锁定方向并降仓×${sizeScale.toFixed(2)}，下单前刷新所选 token 的真实可成交价。`
      };
    }
    return { allowed: false, quoteSum, reason: `Plan5 UP/DOWN 报价和 ${quoteSum.toFixed(3)} 异常，等待盘口同步。` };
  }
  const currentDirection = up >= down ? 'up' : 'down';
  const lockDirection = String(lock?.direction || '').toLowerCase();
  const selectedPrice = lockDirection === 'up' ? up : lockDirection === 'down' ? down : NaN;
  const configuredCollapse = Number(config.plan5DirectionRecheckCollapsePrice);
  const collapsePrice = Number.isFinite(configuredCollapse)
    ? Math.min(0.75, Math.max(0.20, configuredCollapse))
    : 0.54;
  if (config.plan5RequireCurrentPmAlignment !== false && lockDirection && lockDirection !== currentDirection) {
    // Locked side already lost the lead and collapsed: do not treat the dying
    // ticket as a "discount" — hard-skip even in sizing-only mode.
    const collapsedAgainstLeader = Number.isFinite(selectedPrice) && selectedPrice < collapsePrice;
    return {
      allowed: false,
      quoteSum,
      currentDirection,
      lockDirection,
      selectedPrice: Number.isFinite(selectedPrice) ? round4(selectedPrice) : null,
      collapsePrice,
      collapsedAgainstLeader,
      skipReason: collapsedAgainstLeader ? 'collapsed_against_pm_leader' : 'market_alignment',
      reason: collapsedAgainstLeader
        ? `Plan5 锁定 ${lockDirection.toUpperCase()} 已跌至 ${(selectedPrice * 100).toFixed(0)}¢ 且 PM 领先改为 ${currentDirection.toUpperCase()}，禁止逆向追低价票。`
        : `Plan5 锁定方向 ${lockDirection.toUpperCase()} 已与当前 PM 领先方向 ${currentDirection.toUpperCase()} 冲突。`
    };
  }
  return {
    allowed: true,
    quoteSum,
    currentDirection,
    lockDirection: lockDirection || null,
    selectedPrice: Number.isFinite(selectedPrice) ? round4(selectedPrice) : null
  };
}

function clampNumber(value, min, max, fallback = min) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function buildPolymarketPaperPlan5({
  signal, sentiment, config, timeframe = '15m', portfolio = null,
  intervalPmLock = null, lockStrengthStats = null, lossReasonOrders = null,
  nextSlotPrediction = null, incomingNextSlotPrediction = null, nextSlotPredictionSummary = null,
  nextSlotMarketSentiment = null, openPlan5Orders = null, statsDb = null, paperMode = true,
  now = new Date()
} = {}) {
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const schedule = signal?.schedule || getSlotSchedule(now, slotMinutes);
  const slotIso = schedule.currentSlotIso || null;
  const targetTimeIso = schedule.nextSlotIso || signal?.prediction?.targetTimeIso || null;
  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';
  const waitKey = buildPlan5WaitKey(slotIso, targetTimeIso, timeframe, symbol);

  if (config?.plan5Enabled === false) {
    return buildPlan5Shell({ symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, key: waitKey, action: skip('Plan5 已禁用（POLYMARKET_PLAN5_ENABLED=false）。', { skipReason: 'disabled' }) });
  }
  if (!portfolio?.portfolioInitialized) {
    return buildPlan5Shell({ symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, key: waitKey, action: skip('Plan5 请先设置模拟本金。', { skipReason: 'portfolio_not_ready' }) });
  }

  // 当前窗已锁定 → 主仓/加仓优先；未锁定时才尝试开盘前买下一窗
  let lock = sentiment?.available
    ? resolvePlan5EntryLock({ intervalPmLock, sentiment, schedule, timeframe, config })
    : null;
  if (!lock) {
    const preOpen = maybeBuildPlan5PreOpenAction({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, config, portfolio,
      nextSlotPrediction, nextSlotPredictionSummary, nextSlotMarketSentiment, openPlan5Orders,
      lossReasonOrders, lockStrengthStats, waitKey, intervalPmLock, paperMode
    });
    if (preOpen) return preOpen;
    if (!sentiment?.available) {
      return buildPlan5Shell({
        symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, key: waitKey,
        action: skip(sentiment?.reason || 'Plan5 市场不可用。', { skipReason: 'market_unavailable' })
      });
    }
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: normalizePlan5Lock(intervalPmLock), key: waitKey,
      action: skipWaitingForLock(`Plan5 ${timeframe} 未锁定，等待锁定。`)
    });
  }

  const directionRecheck = evaluatePlan5DirectionRecheck({
    lock,
    upPrice: sentiment?.upPrice ?? sentiment?.upProbability,
    downPrice: sentiment?.downPrice ?? sentiment?.downProbability,
    signal,
    config
  });
  if (directionRecheck.flipped) {
    lock = {
      ...lock,
      direction: directionRecheck.direction,
      rejudgedFromDirection: directionRecheck.originalDirection,
      directionRecheck
    };
  }

  const baseCashPct = resolvePlan5CashPct(lock.strength, config);
  if (!Number.isFinite(baseCashPct) || baseCashPct <= 0) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(`Plan5 锁定强度 ${lock.strength} 无效或未配置仓位比例。`, {
        skipReason: 'invalid_strength',
        lockStrength: lock.strength
      })
    });
  }

  const direction = lock.direction;
  const candidateLimitPrice = direction === 'up'
    ? Number(sentiment?.upPrice)
    : Number(sentiment?.downPrice);
  const consensusGate = softenPlan5LockedSignalGate(
    evaluatePlan5ConsensusGate({ signal, lock, timeframe, config, now }),
    { config, kind: 'consensus' }
  );
  if (!consensusGate.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(consensusGate.reason || 'Plan5 综合方向尚未确认。', {
        skipReason: 'consensus_not_confirmed',
        direction,
        limitPrice: Number.isFinite(candidateLimitPrice) ? round4(candidateLimitPrice) : null,
        lockStrength: lock.strength,
        lockPmGap: lock.pmGap ?? null,
        lockedAtIso: lock.lockedAtIso || null,
        lockUpProbability: lock.upProbability ?? null,
        lockDownProbability: lock.downProbability ?? null,
        signalDirection: signal?.direction || null,
        technicalDirection: signal?.technicalDirection || signal?.techDirection || null,
        spotDirection: signal?.spotDirection || null,
        consensusGate
      })
    });
  }
  const entryTiming = softenPlan5LockedSignalGate(
    evaluatePlan5EntryTiming({ lock, schedule, timeframe, now, config }),
    { config, kind: 'entry_timing' }
  );
  if (!entryTiming.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(entryTiming.reason || 'Plan5 锁定尚未成熟。', {
        skipReason: entryTiming.skipReason || 'entry_timing',
        direction,
        limitPrice: Number.isFinite(candidateLimitPrice) ? round4(candidateLimitPrice) : null,
        lockStrength: lock.strength,
        lockPmGap: lock.pmGap ?? null,
        consensusGate,
        entryTiming
      })
    });
  }
  const rawMarketAlignment = evaluatePlan5CurrentMarketAlignment({ lock, sentiment, config });
  // 报价缺失/报价和异常仍不可交易；锁定方向与当前领先方向冲突则只降仓。
  const marketAlignment = softenPlan5LockedSignalGate(
    rawMarketAlignment,
    { config, kind: 'market_alignment' }
  );
  if (!marketAlignment.allowed) {
    return buildPlan5Shell({
      symbol,
      timeframe,
      slotIso,
      targetTimeIso,
      schedule,
      now,
      intervalPmLock: lock,
      key: waitKey,
      action: skip(marketAlignment.reason, {
        skipReason: 'market_alignment',
        direction,
        limitPrice: Number.isFinite(candidateLimitPrice) ? round4(candidateLimitPrice) : null,
        lockStrength: lock.strength,
        lockPmGap: lock.pmGap ?? null,
        consensusGate,
        marketAlignment
      })
    });
  }
  const signalQuality = softenPlan5LockedSignalGate(
    evaluatePlan5SignalQuality({ lock, sentiment, timeframe, now, config, paperMode }),
    { config, kind: 'signal_quality' }
  );
  if (!signalQuality.allowed) {
    return buildPlan5Shell({
      symbol,
      timeframe,
      slotIso,
      targetTimeIso,
      schedule,
      now,
      intervalPmLock: lock,
      key: waitKey,
      action: skip(signalQuality.reason || 'Plan5 实时信号质量不足。', {
        skipReason: signalQuality.skipReason || 'signal_quality',
        direction,
        limitPrice: Number.isFinite(candidateLimitPrice) ? round4(candidateLimitPrice) : null,
        signalQuality,
        lockStrength: lock.strength,
        lockPmGap: lock.pmGap ?? null,
        consensusGate
      })
    });
  }
  const limitPrice = candidateLimitPrice;
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip('Plan5 当前 token 价格不可交易。', { skipReason: 'invalid_price', direction })
    });
  }

  const minEntry = Number(config.plan5MinEntryPrice);
  const maxEntry = Number(config.plan5MaxEntryPrice);
  let entryPriceGate = { allowed: true, sizeScale: 1 };
  if (Number.isFinite(minEntry) && minEntry > 0 && limitPrice < minEntry) {
    entryPriceGate = softenPlan5LockedSignalGate({
      allowed: false,
      sizeScale: limitPrice / minEntry,
      skipReason: 'entry_price_too_low',
      limitPrice: round4(limitPrice),
      entryPrice: round4(limitPrice),
      reason: `Plan5 入场价 ${limitPrice.toFixed(2)} 低于参考下限 ${minEntry.toFixed(2)}。`
    }, { config, kind: 'entry_price' });
    if (!entryPriceGate.allowed) {
      return buildPlan5Shell({
        symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
        action: skip(entryPriceGate.reason, {
          skipReason: 'entry_price_too_low', direction, limitPrice: round4(limitPrice), lockStrength: lock.strength
        })
      });
    }
  }
  if (Number.isFinite(maxEntry) && maxEntry > 0 && maxEntry < 1 && limitPrice > maxEntry) {
    entryPriceGate = softenPlan5LockedSignalGate({
      allowed: false,
      sizeScale: (1 - limitPrice) / Math.max(1 - maxEntry, 1e-6),
      skipReason: 'entry_price_too_high',
      reason: `Plan5 入场价 ${limitPrice.toFixed(2)} 高于参考上限 ${maxEntry.toFixed(2)}。`
    }, { config, kind: 'entry_price' });
    if (!entryPriceGate.allowed) {
      return buildPlan5Shell({
        symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
        action: skip(entryPriceGate.reason, {
          skipReason: 'entry_price_too_high', direction, limitPrice: round4(limitPrice), lockStrength: lock.strength
        })
      });
    }
  }

  const historyGate = softenPlan5LockedSignalGate(
    evaluatePlan5LockHistoryGate({ strength: lock.strength, entryPrice: limitPrice, lockStrengthStats, config }),
    { config, kind: 'history' }
  );
  if (!historyGate.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(historyGate.reason || 'Plan5 历史胜率门控跳过。', {
        skipReason: historyGate.skipReason || 'history_gate',
        direction,
        limitPrice: round4(limitPrice),
        lockStrength: lock.strength,
        historyWinRateGate: historyGate
      })
    });
  }

  const winrateGuidanceGate = softenPlan5LockedSignalGate(evaluatePlan5WinrateGuidanceGate({
    symbol,
    timeframe,
    direction,
    lock,
    signal,
    sameDirectionAsPrev: (incomingNextSlotPrediction || nextSlotPrediction)?.sameDirectionAsPrev ?? null,
    statsDb,
    config,
    now
  }), { config, kind: 'winrate' });
  if (!winrateGuidanceGate.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(winrateGuidanceGate.reason || 'Plan5 同条件胜率指导跳过。', {
        skipReason: winrateGuidanceGate.skipReason || 'winrate_guidance',
        direction,
        limitPrice: round4(limitPrice),
        lockStrength: lock.strength,
        winrateGuidanceGate
      })
    });
  }

  const executionPriceBuffer = config.plan5EvStrictExecutionEnabled === true
    ? Math.max(0, Number(config.plan5EvExecutionPriceBufferAbs) || 0)
    : 0;
  const executionEntryPrice = Math.min(0.99, limitPrice + executionPriceBuffer);
  const rawExpectedValueGate = evaluatePlan5ExpectedValueGate({
    symbol,
    timeframe,
    strength: lock.strength,
    direction,
    entryPrice: executionEntryPrice,
    orders: lossReasonOrders,
    lockStrengthStats,
    config,
    paperMode,
    now
  });
  const expectedValueGate = softenPlan5LockedSignalGate(enforcePlan5StrictExecutionGate(
    rawExpectedValueGate,
    { config, quotedEntryPrice: limitPrice, executionEntryPrice }
  ), { config, kind: 'expected_value' });
  if (!expectedValueGate.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(expectedValueGate.reason || 'Plan5 分层 EV 为负。', {
        skipReason: 'expected_value_negative',
        direction,
        limitPrice: round4(limitPrice),
        lockStrength: lock.strength,
        expectedValueGate
      })
    });
  }

  const lossGate = softenPlan5LockedSignalGate(evaluateLossReasonGate({
    planId: 'plan5',
    timeframe,
    entryType: 'pm_lock_strength',
    lockStrength: lock.strength,
    symbol,
    orders: lossReasonOrders,
    config,
    planLabel: 'Plan5',
    sourceWeights: {
      live: Number(config.plan5EvLiveWeight) || 3,
      paper: Number(config.plan5EvPaperWeight) || 1
    },
    recencyHalfLifeDays: Number(config.plan5EvRecencyHalfLifeDays) || 7,
    now
  }), { config, kind: 'loss_reason' });
  if (!lossGate.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(lossGate.reason || 'Plan5 亏损归因门控跳过。', {
        skipReason: 'loss_reason_gate',
        direction,
        limitPrice: round4(limitPrice),
        lockStrength: lock.strength,
        lossReasonGate: lossGate
      })
    });
  }

  const existingPreOpen = findOpenPlan5PreOpenOrder(openPlan5Orders, { symbol, timeframe, slotIso, targetTimeIso });
  if (existingPreOpen) {
    const preDir = String(existingPreOpen.direction || '').toLowerCase();
    if (preDir && preDir !== direction) {
      return buildPlan5Shell({
        symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
        action: {
          shouldTrade: false, waitingForLock: false, observeOnly: true, holdPreOpen: true,
          strategy: 'pm_lock_strength', direction: preDir, entryType: 'pre_open_hold', usd: 0, limitPrice: null,
          skipReason: 'pre_open_direction_conflict',
          reason: `Plan5 开盘后锁定 ${direction.toUpperCase()} 与开盘前小仓 ${preDir.toUpperCase()} 冲突，不加仓，持有小仓至结算。`
        }
      });
    }
  }

  const sameDirBoost = evaluatePlan5SameDirectionBoost({
    sameDirectionAsPrev: (incomingNextSlotPrediction || nextSlotPrediction)?.sameDirectionAsPrev ?? null,
    continuityStats: nextSlotPredictionSummary,
    config
  });
  const adaptiveSizing = config.plan5AdaptiveSizingEnabled === true;
  const evSizeScale = Number.isFinite(Number(expectedValueGate.sizeScale))
    ? Number(expectedValueGate.sizeScale)
    : 1;
  const historySizeScale = Number.isFinite(Number(historyGate.sizeScale))
    ? Number(historyGate.sizeScale)
    : 1;
  const qualitySizeScale = Number.isFinite(Number(signalQuality.sizeScale))
    ? Number(signalQuality.sizeScale)
    : 1;
  const winrateGuidanceSizeScale = Number.isFinite(Number(winrateGuidanceGate.sizeScale))
    ? Number(winrateGuidanceGate.sizeScale)
    : 1;
  const consensusSizeScale = Number.isFinite(Number(consensusGate.sizeScale))
    ? Number(consensusGate.sizeScale)
    : 1;
  const marketAlignmentSizeScale = Number.isFinite(Number(marketAlignment.sizeScale))
    ? Number(marketAlignment.sizeScale)
    : 1;
  const lossSizeScale = Number.isFinite(Number(lossGate.sizeScale))
    ? Number(lossGate.sizeScale)
    : 1;
  const entryTimingSizeScale = Number.isFinite(Number(entryTiming.sizeScale))
    ? Number(entryTiming.sizeScale)
    : 1;
  const entryPriceSizeScale = Number.isFinite(Number(entryPriceGate.sizeScale))
    ? Number(entryPriceGate.sizeScale)
    : 1;
  // 已锁定信号的质量/历史条件统一叠加为仓位系数，不再消费交易机会。
  const calibratedConfidenceScale = Number.isFinite(Number(lock.optimization?.rawLockConfidence))
    && Number(lock.optimization.rawLockConfidence) > 0
    && Number.isFinite(Number(lock.confidence))
    ? clampNumber(Number(lock.confidence) / Number(lock.optimization.rawLockConfidence), 0.50, 1.15, 1)
    : 1;
  const softSizeScale = round4(
    calibratedConfidenceScale
      * historySizeScale
      * evSizeScale
      * qualitySizeScale
      * winrateGuidanceSizeScale
      * consensusSizeScale
      * marketAlignmentSizeScale
      * lossSizeScale
      * entryTimingSizeScale
      * entryPriceSizeScale
  );
  const sizeScaleRaw = adaptiveSizing
    ? round4(softSizeScale * (Number(sameDirBoost.boost) || 1))
    : softSizeScale;
  const combinedCap = Number(config.plan5CombinedSizeScaleCap) || DEFAULT_COMBINED_SIZE_CAP;
  const sizeScale = round4(Math.min(combinedCap, sizeScaleRaw));
  const activeSymbols = Array.isArray(config?.plan1Symbols) && config.plan1Symbols.length
    ? config.plan1Symbols
    : (Array.isArray(config?.plan5Symbols) && config.plan5Symbols.length ? config.plan5Symbols : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
  const symbolWr = resolveSymbolWrSizedOrderPct({
    symbol, baseOrderPct: baseCashPct, activeSymbols,
    winRates: portfolio?.symbolWinRates || config?._symbolWinRates || null, config: config || {}
  });
  let targetCashPct = adaptiveSizing
    ? round4(Math.min(combinedCap * baseCashPct, baseCashPct * sizeScale * (Number(symbolWr.sizeScale) || 1)))
    : round4(baseCashPct * Math.min(1, softSizeScale));
  const cash = Number(portfolio.cash ?? portfolio.equity) || 0;
  const minUsd = paperMode === false
    ? Math.max(Number(config?.plan5LiveMinOrderUsd) || 1, Number(config?.plan5MinOrderUsd) || 5)
    : (Number(config?.plan5MinOrderUsd) || 1);
  let targetUsd;

  if (existingPreOpen) {
    const existingUsd = Number(existingPreOpen.usd) || 0;
    const fullTarget = round2(Math.min(cash + existingUsd, (cash + existingUsd) * targetCashPct));
    const addUsd = round2(Math.max(0, fullTarget - existingUsd));
    if (addUsd < minUsd) {
      return buildPlan5Shell({
        symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
        action: {
          shouldTrade: false, observeOnly: true, holdPreOpen: true, strategy: 'pm_lock_strength',
          direction, entryType: 'pre_open_hold', usd: 0, limitPrice: null,
          skipReason: 'pre_open_add_below_min',
          reason: `Plan5 已有开盘前小仓 $${existingUsd.toFixed(2)}，加仓额 $${addUsd.toFixed(2)} 低于最小单，持有至结算。`
        }
      });
    }
    targetUsd = addUsd;
  } else {
    targetUsd = round2(Math.min(cash, cash * targetCashPct));
    if (
      config.plan5LockedSignalSizingOnlyEnabled !== false
      && targetUsd > 0
      && targetUsd < minUsd
      && cash >= minUsd
    ) {
      targetUsd = round2(minUsd);
      targetCashPct = round4(targetUsd / cash);
    }
    if (targetUsd < minUsd || targetUsd <= 0) {
      return buildPlan5Shell({
        symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
        action: skip(`Plan5 按剩余现金 $${cash.toFixed(2)} × ${(targetCashPct * 100).toFixed(0)}% = $${Math.max(0, targetUsd).toFixed(2)}，低于最小单 $${minUsd.toFixed(2)}。`, {
          skipReason: 'below_min_order',
          direction,
          limitPrice: round4(limitPrice),
          lockStrength: lock.strength,
          cashPct: targetCashPct
        })
      });
    }
  }

  const slotExposure = evaluatePlan5SlotExposureGate({
    symbol, timeframe, slotIso, direction, usd: targetUsd, openPlan5Orders, portfolio, config
  });
  if (!slotExposure.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
      action: skip(slotExposure.reason || 'Plan5 同窗多币敞口超限。', {
        skipReason: 'slot_exposure',
        direction,
        limitPrice: round4(limitPrice),
        lockStrength: lock.strength,
        slotExposure
      })
    });
  }
  if (Number.isFinite(Number(slotExposure.cappedUsd)) && Number(slotExposure.cappedUsd) < targetUsd) {
    const capped = round2(Number(slotExposure.cappedUsd));
    if (capped < minUsd) {
      return buildPlan5Shell({
        symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: waitKey,
        action: skip(slotExposure.reason || `Plan5 同窗敞口剩余 $${capped.toFixed(2)} 低于最小单。`, {
          skipReason: 'slot_exposure_below_min',
          direction,
          limitPrice: round4(limitPrice),
          lockStrength: lock.strength
        })
      });
    }
    targetUsd = capped;
  }

  const entryType = existingPreOpen ? 'pm_lock_add' : 'pm_lock_strength';
  const strengthLabel = formatLockStrengthLabel(direction, lock.strength);
  const executionKey = existingPreOpen
    ? buildPlan5AddExecutionKey(slotIso, targetTimeIso, timeframe, direction, symbol)
    : buildPlan5ExecutionKey(slotIso, targetTimeIso, timeframe, direction, symbol);
  const historyNote = historyGate.skipped
    ? '历史胜率仅记录'
    : historyGate.insufficientSamples
    ? `历史样本不足（${historyGate.sampleCount || 0}/${historyGate.minSamples || 20}），按基础仓位`
    : historyGate.softReject
      ? `历史胜率 ${(Number(historyGate.winRate) * 100).toFixed(1)}% 软降仓×${Number(historySizeScale).toFixed(2)}`
      : `历史胜率 ${(Number(historyGate.winRate) * 100).toFixed(1)}%（n=${historyGate.sampleCount}）`;
  const evNote = expectedValueGate.insufficientSamples
    ? '；分层 EV 样本积累中'
    : expectedValueGate.softReject
      ? `；加权订单 EV ${(Number(expectedValueGate.expectedRoi) * 100).toFixed(1)}% 软降仓×${Number(evSizeScale).toFixed(2)}（实${expectedValueGate.liveSampleCount || 0}/模${expectedValueGate.paperSampleCount || 0}）`
      : `；加权订单 EV ${(Number(expectedValueGate.expectedRoi) * 100).toFixed(1)}%（${expectedValueGate.level}, 实${expectedValueGate.liveSampleCount || 0}/模${expectedValueGate.paperSampleCount || 0}）`;
  const qualityNote = signalQuality.insufficientSamples
    ? ''
    : signalQuality.softReject
      ? `；信号质量软降仓×${Number(qualitySizeScale).toFixed(2)}`
      : `；方向稳定 ${(Number(signalQuality.stableMs) / 1000).toFixed(0)}s`;
  const winrateNote = winrateGuidanceGate.insufficientSamples || winrateGuidanceGate.skipped
    ? ''
    : winrateGuidanceGate.softReject
      ? `；同条件胜率 ${(Number(winrateGuidanceGate.conditionalWinRate) * 100).toFixed(1)}% 软降仓×${Number(winrateGuidanceSizeScale).toFixed(2)}`
      : `；同条件胜率 ${(Number(winrateGuidanceGate.conditionalWinRate) * 100).toFixed(1)}%×${Number(winrateGuidanceSizeScale).toFixed(2)}`;
  const lossNote = lossGate.insufficientSamples ? '' : `；归因门控 lossRate=${((Number(lossGate.lossRate) || 0) * 100).toFixed(0)}%`;
  const wrNote = symbolWr.enabled && Number(symbolWr.sizeScale) !== 1 ? `；分币奖赏×${Number(symbolWr.sizeScale).toFixed(2)}` : '';
  const sameNote = sameDirBoost.applied ? `；连续同向×${Number(sameDirBoost.boost).toFixed(2)}` : '';
  const addNote = existingPreOpen ? `；开盘后同向加仓（已有小仓 $${Number(existingPreOpen.usd).toFixed(2)}）` : '';

  return buildPlan5Shell({
    symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock: lock, key: executionKey,
    action: {
      shouldTrade: true, strategy: 'pm_lock_strength', direction, entryType,
      label: existingPreOpen ? `${strengthLabel}·加仓` : strengthLabel,
      confidence: round4(lock.confidence ?? Math.max(Number(sentiment.upPrice) || 0, Number(sentiment.downPrice) || 0)),
      edge: round4((1 - limitPrice) - limitPrice),
      usd: targetUsd, cashPct: targetCashPct, baseCashPct, historySizeScale: sizeScale,
      symbolWrSizing: symbolWr.enabled ? { sizeScale: symbolWr.sizeScale, rank: symbolWr.rank ?? null, orderPct: symbolWr.orderPct, winRate: symbolWr.winRate ?? null, samples: symbolWr.samples ?? null, coldStart: Boolean(symbolWr.coldStart) } : null,
      sameDirectionBoost: sameDirBoost,
      relatedPreOpenOrderId: existingPreOpen?.id || null,
      historyWinRateGate: historyGate.insufficientSamples
        ? { passed: true, insufficientSamples: true, sampleCount: historyGate.sampleCount }
        : {
          passed: true,
          softReject: Boolean(historyGate.softReject),
          sizingOnlyBypass: Boolean(historyGate.sizingOnlyBypass),
          originalReason: historyGate.originalReason || null,
          sampleCount: historyGate.sampleCount,
          winRate: historyGate.winRate,
          requiredWinRate: historyGate.requiredWinRate,
          sizeScale: historyGate.sizeScale
        },
      expectedValueGate: { passed: true, ...expectedValueGate },
      executionEntryPrice: round4(executionEntryPrice),
      directionRecheck,
      signalDirection: signal?.direction || null,
      technicalDirection: signal?.technicalDirection || signal?.techDirection || null,
      spotDirection: signal?.spotDirection || null,
      marketAlignment: { passed: true, ...marketAlignment },
      consensusGate: { passed: true, ...consensusGate },
      signalQuality: { passed: true, ...signalQuality },
      winrateGuidanceGate: winrateGuidanceGate.insufficientSamples || winrateGuidanceGate.skipped
        ? {
          passed: true,
          insufficientSamples: Boolean(winrateGuidanceGate.insufficientSamples),
          skipped: Boolean(winrateGuidanceGate.skipped),
          sampleCount: winrateGuidanceGate.sampleCount || 0
        }
        : {
          passed: true,
          softReject: Boolean(winrateGuidanceGate.softReject),
          sampleCount: winrateGuidanceGate.sampleCount,
          conditionalWinRate: winrateGuidanceGate.conditionalWinRate,
          suggestedWeight: winrateGuidanceGate.suggestedWeight,
          sizeScale: winrateGuidanceGate.sizeScale,
          alignsWithHistoricalEdge: winrateGuidanceGate.alignsWithHistoricalEdge,
          sizingOnlyBypass: Boolean(winrateGuidanceGate.sizingOnlyBypass),
          originalReason: winrateGuidanceGate.originalReason || null
        },
      strategyVersion: PLAN5_VERSION,
      entryTiming,
      entryPriceGate,
      lossReasonGate: lossGate.insufficientSamples
        ? { passed: true, insufficientSamples: true, sampleCount: lossGate.sampleCount }
        : {
          passed: true,
          sampleCount: lossGate.sampleCount,
          lossRate: lossGate.lossRate,
          sizeScale: lossGate.sizeScale,
          sizingOnlyBypass: Boolean(lossGate.sizingOnlyBypass),
          originalReason: lossGate.originalReason || null
        },
      lockStrength: lock.strength, lockPmGap: lock.pmGap, lockedAtIso: lock.lockedAtIso || null, limitPrice: round4(limitPrice),
      lockUpProbability: lock.upProbability ?? null,
      lockDownProbability: lock.downProbability ?? null,
      lockOptimization: lock.optimization || null,
      // The lock decides the side; execution reprices without a post-lock
      // probability cap. Only the sub-20c reversal check remains in preflight.
      maxLivePrice: null,
      takeProfitPrice: null,
      stopLossPrice: config.plan5StopLossEnabled === false
        ? null
        : round4(clampNumber(config.plan5ConditionalStopPrice, 0.05, 0.60, 0.30)),
      executionKey,
      sizingOnlyMode: config.plan5LockedSignalSizingOnlyEnabled !== false,
      reason: `Plan5 v12 ${timeframe} ${strengthLabel}：锁定置信度 ${(Number(lock.confidence ?? consensusGate.confidence) * 100).toFixed(1)}%；${historyNote}${evNote}${qualityNote}${winrateNote}${lossNote}${adaptiveSizing ? `${wrNote}${sameNote}` : ''}${addNote}；剩余现金 $${cash.toFixed(2)} × ${(targetCashPct * 100).toFixed(1)}% → 本笔 $${targetUsd.toFixed(2)}；${config.plan5StopLossEnabled === false ? '持有至官方结算' : '30¢ 反转止损 / 20¢ 紧急止损'}。`
    }
  });
}

function softenPlan5LockedSignalGate(gate, { config = {}, kind = 'gate' } = {}) {
  if (!gate || gate.allowed !== false || config.plan5LockedSignalSizingOnlyEnabled === false) return gate;
  // Consensus is the anti-false-lock gate: tech/spot/composite must confirm PM.
  // Soft-sizing here would keep trading the exact lock_strength_misjudge losses.
  if (kind === 'consensus') return gate;
  if (kind === 'expected_value' && config.plan5EvStrictExecutionEnabled === true) return gate;
  if (kind === 'expected_value') {
    // Exact settled-window auditing showed two distinct regimes: mildly
    // negative cohorts (-25%..0%) were profitable when followed, while severe
    // cohorts (<= -25%) lost heavily. Keep missing/invalid calibration and
    // severe deterioration as hard vetoes; turn only the mild band into sizing.
    if (gate.insufficientSamples === true || !Number.isFinite(Number(gate.expectedRoi))) return gate;
    const configuredHardFloor = Number(config.plan5EvHardRejectRoi);
    const hardFloor = Number.isFinite(configuredHardFloor) ? configuredHardFloor : -0.25;
    const observedRois = [Number(gate.expectedRoi), Number(gate.recentLive?.roi)]
      .filter((value) => Number.isFinite(value));
    if (!observedRois.length || Math.min(...observedRois) <= hardFloor) return gate;
  }
  // Lottery tickets stay hard rejects. Soft sizing may absorb a mild dip under
  // the reference min entry (e.g. 0.48 vs 0.50), but not a collapsed 26¢ chase.
  if (kind === 'entry_price' && gate.skipReason === 'entry_price_too_low') {
    const price = Number(gate.limitPrice ?? gate.entryPrice);
    const configuredHardMin = Number(config.plan5HardMinEntryPrice);
    const hardMin = Number.isFinite(configuredHardMin)
      ? Math.min(0.49, Math.max(0.05, configuredHardMin))
      : 0.35;
    if (Number.isFinite(price) && price + 1e-9 < hardMin) return gate;
  }
  // Once the shared optimized lock exists it decides participation. Stability,
  // a changed leader and other short-lived checks remain useful sizing inputs, but must not
  // create a second hidden "lock" that disagrees with the win-rate page.
  // A missing/invalid two-sided quote is different: no executable price exists.
  if (kind === 'market_alignment' && !gate.currentDirection) return gate;
  // Collapsed locked side vs flipped PM leader is not a "short-lived" disagreement.
  if (
    kind === 'market_alignment'
    && (gate.collapsedAgainstLeader === true || gate.skipReason === 'collapsed_against_pm_leader')
  ) {
    return gate;
  }
  // Invalid token prices are rejected before this helper is called, and severe
  // post-lock price deterioration is still rejected by the live preflight.
  const configuredFloor = Number(config.plan5LockedSignalMinSizeScale);
  const floor = clampNumber(configuredFloor, 0.05, 1, 0.25);
  const candidates = [
    Number(gate.sizeScale),
    Number(gate.suggestedWeight),
    Number.isFinite(Number(gate.expectedRoi)) ? 1 + Number(gate.expectedRoi) : NaN,
    Number.isFinite(Number(gate.recentLive?.roi)) ? 1 + Number(gate.recentLive.roi) : NaN,
    Number.isFinite(Number(gate.winRate)) && Number(gate.requiredWinRate) > 0
      ? Number(gate.winRate) / Number(gate.requiredWinRate)
      : NaN,
    Number.isFinite(Number(gate.confidence)) && Number(gate.minConfidence) > 0
      ? Number(gate.confidence) / Number(gate.minConfidence)
      : NaN
  ].filter((value) => Number.isFinite(value) && value > 0);
  const rawScale = candidates.length ? Math.min(...candidates) : floor;
  const sizeScale = round4(clampNumber(rawScale, floor, 1, floor));
  return {
    ...gate,
    allowed: true,
    softReject: true,
    sizingOnlyBypass: true,
    originalReason: gate.reason || null,
    sizeScale,
    reason: `${gate.reason || `Plan5 ${kind} 条件未通过`} 已改为仅降仓×${sizeScale.toFixed(2)}，不停止锁定信号交易。`
  };
}

function maybeBuildPlan5PreOpenAction({
  symbol, timeframe, slotIso, targetTimeIso, schedule, now, config, portfolio,
  nextSlotPrediction, nextSlotPredictionSummary, nextSlotMarketSentiment, openPlan5Orders,
  lossReasonOrders, lockStrengthStats, waitKey, intervalPmLock, paperMode = true
}) {
  if (config?.plan5PreOpenEnabled === false) return null;
  if (!nextSlotPrediction?.predictedDirection) return null;
  const predictedSlot = nextSlotPrediction.predictedSlotIso;
  if (!predictedSlot) return null;
  // predictedSlotIso = 下一窗起点（= 当前 schedule.nextSlotIso / source.targetTimeIso）
  if (targetTimeIso && predictedSlot !== targetTimeIso) return null;
  const predictedStartMs = Date.parse(predictedSlot);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Number.isFinite(predictedStartMs) || nowMs >= predictedStartMs) return null;

  const nextSlotIso = predictedSlot;
  const nextTargetTimeIso = new Date(predictedStartMs + timeframeToSlotMinutes(timeframe) * 60_000).toISOString();
  const existing = findOpenPlan5OrderForSlot(openPlan5Orders, { symbol, timeframe, slotIso: nextSlotIso, targetTimeIso: nextTargetTimeIso });
  if (existing) return null;

  const minAcc = Number(config.plan5PreOpenMinAccuracy);
  const requiredAcc = Number.isFinite(minAcc) ? minAcc : 0.65;
  const overall = nextSlotPredictionSummary?.overall || null;
  const sampleCount = Number(overall?.total) || 0;
  const accuracy = Number(overall?.accuracy) || 0;
  const minSamples = Number(config.plan5PreOpenMinSamples) || 20;
  if (sampleCount < minSamples || accuracy < requiredAcc) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, nextSlotPrediction, key: waitKey,
      action: {
        shouldTrade: false, observeOnly: true, strategy: 'pm_lock_pre_open', direction: null, usd: 0, limitPrice: null,
        reason: sampleCount < minSamples
          ? `Plan5 开盘前：next-slot 样本不足（${sampleCount}/${minSamples}），暂不提前买。`
          : `Plan5 开盘前：next-slot 准确率 ${(accuracy * 100).toFixed(1)}% < ${(requiredAcc * 100).toFixed(0)}%，暂不提前买。`
      }
    });
  }

  if (!nextSlotMarketSentiment?.available) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, nextSlotPrediction, key: waitKey,
      action: {
        shouldTrade: false, observeOnly: true, strategy: 'pm_lock_pre_open',
        direction: nextSlotPrediction.predictedDirection, usd: 0, limitPrice: null, preOpenMarketMissing: true,
        reason: nextSlotMarketSentiment?.reason || 'Plan5 开盘前：下一窗市场尚未可交易（slug 可解析，但 Polymarket 暂无该市场）。'
      }
    });
  }

  const direction = nextSlotPrediction.predictedDirection;
  const limitPrice = direction === 'up' ? Number(nextSlotMarketSentiment.upPrice) : Number(nextSlotMarketSentiment.downPrice);
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {
    return buildPlan5Shell({ symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, nextSlotPrediction, key: waitKey, action: skip('Plan5 开盘前：下一窗 token 价格不可交易。') });
  }

  const strengthKey = String(nextSlotPrediction.lockStrength || 'normal').toLowerCase();
  const normalizedStrength = VALID_STRENGTHS.has(strengthKey) ? strengthKey : 'normal';
  const expectedValueGate = evaluatePlan5ExpectedValueGate({
    symbol,
    timeframe,
    strength: normalizedStrength,
    direction,
    entryPrice: limitPrice,
    orders: lossReasonOrders,
    lockStrengthStats,
    config,
    paperMode,
    now
  });
  if (!expectedValueGate.allowed) {
    return buildPlan5Shell({
      symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, nextSlotPrediction, key: waitKey,
      action: skip(expectedValueGate.reason || 'Plan5 开盘前分层 EV 为负。', {
        skipReason: 'pre_open_expected_value_negative',
        direction,
        limitPrice: round4(limitPrice),
        expectedValueGate
      })
    });
  }
  const baseCashPct = resolvePlan5CashPct(VALID_STRENGTHS.has(strengthKey) ? strengthKey : 'normal', config) || Number(config.plan5NormalCashPct) || 0.20;
  const fraction = Number(config.plan5PreOpenSizeFraction);
  const sizeFraction = Number.isFinite(fraction) && fraction > 0 && fraction <= 1 ? fraction : 0.4;
  const sameDirBoost = evaluatePlan5SameDirectionBoost({
    sameDirectionAsPrev: nextSlotPrediction.sameDirectionAsPrev === true,
    continuityStats: nextSlotPredictionSummary,
    config
  });
  const combinedCap = Number(config.plan5CombinedSizeScaleCap) || DEFAULT_COMBINED_SIZE_CAP;
  const cashPct = round4(Math.min(baseCashPct * sizeFraction * (Number(sameDirBoost.boost) || 1), baseCashPct * combinedCap * sizeFraction));
  const cash = Number(portfolio.cash ?? portfolio.equity) || 0;
  const minUsd = Number(config?.plan5MinOrderUsd) || 1;
  const usd = round2(Math.min(cash, cash * cashPct));
  if (usd < minUsd || usd <= 0) {
    return buildPlan5Shell({ symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, nextSlotPrediction, key: waitKey, action: skip(`Plan5 开盘前小仓 $${Math.max(0, usd).toFixed(2)} 低于最小单 $${minUsd.toFixed(2)}。`) });
  }

  const executionKey = buildPlan5PreOpenExecutionKey(nextSlotIso, nextTargetTimeIso, timeframe, direction, symbol);
  const sameNote = sameDirBoost.applied ? `；连续同向×${Number(sameDirBoost.boost).toFixed(2)}` : '';
  return buildPlan5Shell({
    symbol, timeframe, slotIso: nextSlotIso, targetTimeIso: nextTargetTimeIso, schedule, now, intervalPmLock, nextSlotPrediction, key: executionKey,
    action: {
      shouldTrade: true, strategy: 'pm_lock_pre_open', direction, entryType: 'pre_open',
      label: `开盘前 ${direction === 'up' ? 'UP' : 'DOWN'}`,
      confidence: round4(Math.max(Number(nextSlotMarketSentiment.upPrice) || 0, Number(nextSlotMarketSentiment.downPrice) || 0)),
      edge: round4((1 - limitPrice) - limitPrice),
      usd, cashPct, baseCashPct, preOpenSizeFraction: sizeFraction, sameDirectionBoost: sameDirBoost,
      nextSlotAccuracy: accuracy, nextSlotSamples: sampleCount,
      lockStrength: normalizedStrength,
      lockPmGap: Number.isFinite(Number(nextSlotPrediction.lockGap)) ? Number(nextSlotPrediction.lockGap) : null,
      limitPrice: round4(limitPrice),
      takeProfitPrice: null,
      stopLossPrice: round4(clampNumber(config.plan5ConditionalStopPrice, 0.05, 0.60, 0.30)),
      expectedValueGate: { passed: true, ...expectedValueGate },
      strategyVersion: PLAN5_VERSION,
      executionKey,
      preOpen: true, predictedSlotIso: predictedSlot,
      reason: `Plan5 开盘前小仓：next-slot 准确率 ${(accuracy * 100).toFixed(1)}%（n=${sampleCount}）≥ ${(requiredAcc * 100).toFixed(0)}%，按基础仓 ${(baseCashPct * 100).toFixed(0)}% × ${(sizeFraction * 100).toFixed(0)}%${sameNote} = $${usd.toFixed(2)}，待开盘后同向加仓。`
    }
  });
}

export function findOpenPlan5PreOpenOrder(orders, { symbol, timeframe, slotIso, targetTimeIso }) {
  const list = Array.isArray(orders) ? orders : [];
  const sym = String(symbol || 'BTC-USD').toUpperCase();
  return list.find((order) => {
    if (String(order.symbol || 'BTC-USD').toUpperCase() !== sym) return false;
    if ((order.timeframe || '5m') !== timeframe) return false;
    if (order.settlementStatus && order.settlementStatus !== 'open') return false;
    const entryType = String(order.entryType || order.plan?.entryType || order.action?.entryType || '').toLowerCase();
    if (entryType !== 'pre_open') return false;
    if (slotIso && order.slotIso && order.slotIso !== slotIso) return false;
    if (targetTimeIso && order.targetTimeIso && order.targetTimeIso !== targetTimeIso) return false;
    return true;
  }) || null;
}

export function findOpenPlan5OrderForSlot(orders, { symbol, timeframe, slotIso, targetTimeIso }) {
  const list = Array.isArray(orders) ? orders : [];
  const sym = String(symbol || 'BTC-USD').toUpperCase();
  return list.find((order) => {
    if (String(order.symbol || 'BTC-USD').toUpperCase() !== sym) return false;
    if ((order.timeframe || '5m') !== timeframe) return false;
    if (order.settlementStatus && order.settlementStatus !== 'open') return false;
    if (slotIso && order.slotIso && order.slotIso !== slotIso) return false;
    if (targetTimeIso && order.targetTimeIso && order.targetTimeIso !== targetTimeIso) return false;
    return true;
  }) || null;
}

export function resolvePlan5EntryLock({ intervalPmLock = null, sentiment = null, schedule = null, timeframe = '5m', config = null } = {}) {
  if (intervalPmLock?.optimizationBlocked === true || intervalPmLock?.eligible === false) return null;
  const fromRecorder = normalizePlan5Lock(intervalPmLock);
  if (fromRecorder) return { ...fromRecorder, lockSource: fromRecorder.source || 'recorder' };
  if (config?.plan5RequireDisplayedLock === true) return null;
  if (!sentiment?.available) return null;
  const decisionConfig = timeframe === '15m' ? buildFifteenMinuteDecisionConfig() : buildFiveMinuteDecisionConfig();
  const elapsedPct = Number.isFinite(Number(schedule?.elapsedInCurrentSlotPct)) ? Number(schedule.elapsedInCurrentSlotPct) : windowElapsedPct(schedule || {});
  const up = Number(sentiment.upProbability ?? sentiment.upPrice);
  const down = Number(sentiment.downProbability ?? sentiment.downPrice);
  const direction = resolveSentimentDirection(sentiment);
  if (!direction) return null;
  const displayEval = evaluateDisplayPmLock({
    elapsedInCurrentSlotPct: elapsedPct,
    polymarket: { predictedDirection: direction, upProbability: up, downProbability: down, qualityScore: sentiment.qualityScore }
  }, decisionConfig);
  if (!displayEval.shouldLock) return null;
  return normalizePlan5Lock({
    source: 'display', direction, strength: displayEval.lockStrength || 'weak', pmGap: displayEval.pmGap,
    confidence: Math.max(Number.isFinite(up) ? up : 0, Number.isFinite(down) ? down : 0),
    upProbability: Number.isFinite(up) ? up : null, downProbability: Number.isFinite(down) ? down : null,
    lockedAtIso: null, lockReason: displayEval.reason || 'display_threshold'
  });
}

export function resolvePlan5CashPct(strength, config = {}) {
  const key = String(strength || '').toLowerCase();
  if (!VALID_STRENGTHS.has(key)) return null;
  const fromConfig = { weak: Number(config.plan5WeakCashPct), normal: Number(config.plan5NormalCashPct), strong: Number(config.plan5StrongCashPct) };
  const pct = Number.isFinite(fromConfig[key]) && fromConfig[key] > 0 ? fromConfig[key] : DEFAULT_CASH_PCT[key];
  return Number.isFinite(pct) && pct > 0 ? pct : null;
}

export function normalizePlan5Lock(lock) {
  if (!lock || typeof lock !== 'object') return null;
  const direction = String(lock.direction || '').toLowerCase();
  if (direction !== 'up' && direction !== 'down') return null;
  const strength = String(lock.strength || lock.lockStrength || '').toLowerCase();
  if (!VALID_STRENGTHS.has(strength)) return null;
  const normalized = {
    source: lock.source || 'polymarket', direction, strength,
    pmGap: Number.isFinite(Number(lock.pmGap)) ? Number(lock.pmGap) : null,
    confidence: Number.isFinite(Number(lock.confidence)) ? Number(lock.confidence) : null,
    upProbability: Number.isFinite(Number(lock.upProbability)) ? Number(lock.upProbability) : null,
    downProbability: Number.isFinite(Number(lock.downProbability)) ? Number(lock.downProbability) : null,
    lockedAtIso: lock.lockedAtIso || null, lockReason: lock.lockReason || null
  };
  if (lock.optimization) normalized.optimization = lock.optimization;
  return normalized;
}

export function buildPlan5ExecutionKey(slotIso, targetTimeIso, timeframe, direction, symbol = 'BTC-USD') {
  const coin = String(symbol || 'BTC-USD').toUpperCase().replace(/-USD$/, '') || 'BTC';
  return `plan5_${coin}_${slotIso || targetTimeIso || 'na'}_${timeframe}_${direction}`;
}
export function buildPlan5PreOpenExecutionKey(slotIso, targetTimeIso, timeframe, direction, symbol = 'BTC-USD') {
  const coin = String(symbol || 'BTC-USD').toUpperCase().replace(/-USD$/, '') || 'BTC';
  return `plan5_pre_${coin}_${slotIso || targetTimeIso || 'na'}_${timeframe}_${direction}`;
}
export function buildPlan5AddExecutionKey(slotIso, targetTimeIso, timeframe, direction, symbol = 'BTC-USD') {
  const coin = String(symbol || 'BTC-USD').toUpperCase().replace(/-USD$/, '') || 'BTC';
  return `plan5_add_${coin}_${slotIso || targetTimeIso || 'na'}_${timeframe}_${direction}`;
}
export function buildPlan5WaitKey(slotIso, targetTimeIso, timeframe, symbol = 'BTC-USD') {
  const coin = String(symbol || 'BTC-USD').toUpperCase().replace(/-USD$/, '') || 'BTC';
  return `plan5_${coin}_${slotIso || targetTimeIso || 'na'}_${timeframe}_wait`;
}

function resolveSentimentDirection(sentiment) {
  const up = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const down = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
  return up >= down ? 'up' : 'down';
}

function resolvePlan5PriceBand(price) {
  const value = Number(price);
  if (value < PLAN5_PRICE_BANDS[0]) return '<0.45';
  if (value < PLAN5_PRICE_BANDS[1]) return '0.45-0.55';
  if (value < PLAN5_PRICE_BANDS[2]) return '0.55-0.65';
  if (value < PLAN5_PRICE_BANDS[3]) return '0.65-0.75';
  return '>=0.75';
}

function resolveOrderEntryPrice(order) {
  return Number(order?.entryPrice ?? order?.limitPrice);
}

function resolveOrderWon(order) {
  if (order?.won === true || order?.won === false) return order.won;
  const pnl = Number(order?.pnl);
  if (!Number.isFinite(pnl) || pnl === 0) return null;
  return pnl > 0;
}

function resolveOrderRealizedRoi(order) {
  const usd = Number(order?.usd);
  const pnl = Number(order?.pnl);
  if (Number.isFinite(usd) && usd > 0 && Number.isFinite(pnl)) return pnl / usd;
  const won = resolveOrderWon(order);
  const price = resolveOrderEntryPrice(order);
  if (won == null || !Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return won ? (1 / price) - 1 : -1;
}

function resolvePlan5OrderWeight(order, config, nowMs) {
  const source = String(order?.source || 'paper').toLowerCase();
  const sourceWeight = source === 'live'
    ? Math.max(0, Number(config.plan5EvLiveWeight) || 3)
    : Math.max(0, Number(config.plan5EvPaperWeight) || 1);
  const halfLifeDays = Math.max(0, Number(config.plan5EvRecencyHalfLifeDays) || 7);
  const settledMs = Date.parse(order?.settledAtIso || order?.closedAtIso || '');
  if (!Number.isFinite(settledMs) || !halfLifeDays) return sourceWeight;
  const ageMs = Math.max(0, nowMs - settledMs);
  return sourceWeight * (0.5 ** (ageMs / (halfLifeDays * 86_400_000)));
}

function resolveOrderLockStrength(order) {
  return String(
    order?.lockStrength
      || order?.plan?.action?.lockStrength
      || order?.lossAnalysis?.detail?.lockStrength
      || ''
  ).toLowerCase();
}

function matchesPlan5Order(order, symbol, timeframe, priceBand = null, strength = null, direction = null) {
  if (symbol && String(order?.symbol || 'BTC-USD').toUpperCase() !== symbol) return false;
  if (timeframe && String(order?.timeframe || '5m') !== timeframe) return false;
  if (priceBand && resolvePlan5PriceBand(resolveOrderEntryPrice(order)) !== priceBand) return false;
  if (strength && resolveOrderLockStrength(order) !== strength) return false;
  if (direction) {
    const orderDir = String(order?.direction || '').toLowerCase();
    if (orderDir && orderDir !== direction) return false;
  }
  return true;
}

function dedupePlan5CalibrationOrders(orders) {
  const preferred = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order) continue;
    const key = [
      String(order.symbol || 'BTC-USD').toUpperCase(),
      order.timeframe || '5m',
      order.slotIso || order.targetTimeIso || order.id,
      order.direction || '',
      order.entryType || ''
    ].join('|');
    const existing = preferred.get(key);
    const isLive = String(order.source || '').toLowerCase() === 'live';
    const existingLive = String(existing?.source || '').toLowerCase() === 'live';
    if (!existing || (isLive && !existingLive)) preferred.set(key, order);
  }
  return [...preferred.values()];
}

function buildPlan5Shell({ symbol, timeframe, slotIso, targetTimeIso, schedule, now, intervalPmLock, nextSlotPrediction = null, key = null, action }) {
  return {
    key: key || action?.executionKey || buildPlan5WaitKey(slotIso, targetTimeIso, timeframe, symbol),
    planId: 'plan5', algorithm: 'plan5', symbol, timeframe,
    slotMinutes: timeframeToSlotMinutes(timeframe),
    generatedAtIso: (now instanceof Date ? now : new Date(now)).toISOString(),
    targetTimeIso, slotIso, schedule,
    intervalPmLock: intervalPmLock || null,
    nextSlotPrediction: nextSlotPrediction || null,
    action
  };
}

function skip(reason, extra = {}) {
  const {
    direction = null,
    limitPrice = null,
    skipReason = 'skipped',
    ...rest
  } = extra || {};
  return {
    shouldTrade: false,
    waitingForLock: false,
    observeOnly: false,
    strategy: 'pm_lock_strength',
    direction,
    usd: 0,
    limitPrice,
    reason,
    skipReason,
    ...rest
  };
}
function skipWaitingForLock(reason) {
  return {
    shouldTrade: false,
    waitingForLock: true,
    observeOnly: true,
    strategy: 'pm_lock_strength',
    direction: null,
    usd: 0,
    limitPrice: null,
    reason,
    skipReason: 'waiting_for_lock'
  };
}

/** 汇总 Plan5 机会日志的 skip 原因占比，便于前端/排障。 */
export function summarizePlan5OpportunityLog(opportunityLog = [], { limit = 20 } = {}) {
  const counts = new Map();
  let trade = 0;
  let total = 0;
  for (const item of opportunityLog || []) {
    if (!item) continue;
    total += 1;
    if (item.shouldTrade) {
      trade += 1;
      const key = 'trade';
      counts.set(key, (counts.get(key) || 0) + 1);
      continue;
    }
    const key = item.skipReason || 'skipped';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const skipReasonCounts = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, pct: total ? round4(count / total) : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, Number(limit) || 20));
  return { total, trade, skipped: Math.max(0, total - trade), skipReasonCounts };
}
function round2(value) { return Math.round(Number(value) * 100) / 100; }

export { evaluatePlan5SameDirectionBoost };


