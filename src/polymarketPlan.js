import {
  computePolymarketOrderUsd,
  computePlan1PaperOrderUsd,
  evaluateTieredEntry,
  resolvePlan1MinConfidence,
  scalePolymarketOrderByConfidence,
  applyKellyCapToSizing,
  resolveSymbolWrSizedOrderPct
} from './polymarketSizing.js';
import { resolveCalibratedEdge } from './polymarketCalibration.js';
import { evaluateHistoryWinRateGate } from './historyGate.js';
import { evaluateLossReasonGate } from './lossReasonGate.js';
import { buildChopRegimeGuard } from './polymarketRegime.js';
import {
  computePlan1ExitPrices,
  resolvePlan1EdgeConfidence,
  resolvePlan1EntryMaxElapsedPct,
  resolvePlan1EntryMinElapsedPct,
  resolvePlan1FlipEnabled,
  resolvePlan1MaxEntryPrice,
  resolvePlan1MinEntryPrice
} from './plan1Policy.js';

import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';
import { applyFiveMinutePathExperiment } from './polymarketWindowTrack.js';



export function buildPolymarketPaperPlan({

  signal,

  sentiment,

  basketSentiments = [],

  openExposureOrders = [],

  config,

  risk,

  tradingStats = null,

  timeframe = '15m',

  portfolio = null,

  calibrationTable = null,

  lossReasonOrders = null,

  paperMode = true,

  paperExperiment = false,

  now = new Date()

}) {

  const slotMinutes = timeframeToSlotMinutes(timeframe);

  const schedule = signal?.schedule || getSlotSchedule(now, slotMinutes);

  const elapsedPct = windowElapsedPct(schedule);

  const window = windowMeta(timeframe);

  const tech = buildTechEntry(signal);

  const polymarket = buildPolymarketEntry(sentiment);

  const basket = buildBasketEntry({ primarySymbol: signal?.symbol || sentiment?.symbol || 'BTC-USD', basketSentiments });

  const composite = tech && polymarket ? buildCompositeEntry(tech, polymarket, elapsedPct, timeframe, basket) : null;

  const strategies = { tech, polymarket, basket, composite };

  let action = chooseAction({

    window,

    strategies,

    config,

    risk,

    tradingStats,

    signal,

    sentiment,

    timeframe,

    portfolio,

    calibrationTable,

    lossReasonOrders,

    openExposureOrders,

    elapsedPct,

    paperMode

  });

  const trajectoryPath = timeframe === '5m' ? sentiment?.windowTrack?.path || null : null;
  const trajectoryResult = applyFiveMinutePathExperiment(action, trajectoryPath, {
    enabled: timeframe === '5m'
      && config.fiveMinutePathExperimentEnabled !== false
      && (paperExperiment || config.plan1FiveMinutePathGuardEnabled === true)
  });
  action = trajectoryResult.action;

  const targetTimeIso = signal?.prediction?.targetTimeIso || schedule.nextSlotIso || null;

  const slotIso = schedule.currentSlotIso || null;

  const exitRule = buildPlan1ExitRule(config);



  return {

    key: buildWindowPlanKey(slotIso, timeframe, signal?.symbol || sentiment?.symbol || 'BTC-USD'),

    planId: 'plan1',

    algorithm: 'plan1',

    symbol: signal?.symbol || sentiment?.symbol || 'BTC-USD',

    timeframe,

    slotMinutes,

    generatedAtIso: now.toISOString(),

    targetTimeIso,

    slotIso,

    window,

    phase: window,

    elapsedPct: round4(elapsedPct),

    strategies,

    trajectoryPath,

    trajectoryExperiment: trajectoryResult.evaluation,

    exitRule,

    action

  };

}



export function buildWindowPlanKey(slotIso, timeframe = '15m', symbol = 'BTC-USD') {

  return `${slotIso || 'unknown'}_${symbol || 'BTC-USD'}_${timeframe}`;

}



export function windowElapsedPct(schedule) {

  if (!schedule?.slotMinutes) return 0;

  return Math.max(0, Math.min(0.999, 1 - Number(schedule.secondsToNext || 0) / (schedule.slotMinutes * 60)));

}



export function buildPlan1ExitRule(config = {}, entryPrice = null) {

  const offsets = entryPrice != null
    ? computePlan1ExitPrices(entryPrice, config)
    : null;

  return {

    takeProfitOffset: Number(config.plan1TakeProfitOffset) || 0.14,

    stopLossOffset: Number(config.plan1StopLossOffset) || 0.10,

    timeStopRemainingPct: Number(config.plan1TimeStopRemainingPct) || 0.25,

    takeProfitPrice: offsets?.takeProfitPrice ?? null,

    stopLossPrice: offsets?.stopLossPrice ?? null,

    dynamicByEntryPrice: true

  };

}



export function shouldPlan1DirectionFlip({

  openDirection,

  newDirection,

  config,

  timeframe = '15m',

  openOrderCreatedAtIso,

  lastFlipAtMs = null,

  newConfidence = null,

  reverseEdge = null,

  floatingLossPct = null,

  elapsedPct = null,

  isChop = false,

  now = new Date()

}) {

  if (isChop) {
    return { flip: false, reason: '震荡过滤期间禁止 Plan1 方向翻转。' };
  }

  if (!resolvePlan1FlipEnabled(timeframe, config)) {

    return { flip: false, reason: `Plan1 ${timeframe} 方向翻转已关闭。` };

  }

  if (!['up', 'down'].includes(openDirection) || !['up', 'down'].includes(newDirection)) {

    return { flip: false, reason: '方向无效。' };

  }

  if (openDirection === newDirection) {

    return { flip: false, reason: '方向未变化。' };

  }



  const configuredFlipMaxElapsed = Number(config?.plan1FlipMaxElapsedPct);

  const maxElapsedPct = Number.isFinite(configuredFlipMaxElapsed) && configuredFlipMaxElapsed > 0
    ? configuredFlipMaxElapsed
    : 0.75;

  if (Number.isFinite(elapsedPct) && elapsedPct >= maxElapsedPct) {

    return { flip: false, reason: `窗口已过 ${(maxElapsedPct * 100).toFixed(0)}%，禁止翻转。` };

  }



  const minFlipConfidence = Number(config?.plan1FlipMinConfidence) || 0.64;

  const conf = Number(newConfidence);

  if (Number.isFinite(conf) && conf < minFlipConfidence) {

    return {

      flip: false,

      reason: `反向置信度 ${(conf * 100).toFixed(1)}% 低于翻转门槛 ${(minFlipConfidence * 100).toFixed(0)}%。`

    };

  }



  const minFlipEdge = Number(config?.plan1FlipMinEdge) || 0.035;

  const edge = Number(reverseEdge);

  if (Number.isFinite(edge) && edge < minFlipEdge) {

    return {

      flip: false,

      reason: `反向 edge ${(edge * 100).toFixed(1)}% 低于 ${(minFlipEdge * 100).toFixed(0)}%。`

    };

  }



  const maxFloatingLossPct = Number(config?.plan1FlipMaxFloatingLossPct) || 0.25;

  const lossPct = Number(floatingLossPct);

  if (Number.isFinite(lossPct) && lossPct < -maxFloatingLossPct) {

    return {

      flip: false,

      reason: `浮亏 ${(lossPct * 100).toFixed(1)}% 超过翻转上限 -${(maxFloatingLossPct * 100).toFixed(0)}%。`

    };

  }



  const nowMs = now.getTime();

  const minHoldMs = Number.isFinite(Number(config?.plan1FlipMinHoldMs))

    ? Number(config.plan1FlipMinHoldMs)

    : 90000;

  const createdMs = Date.parse(openOrderCreatedAtIso);

  if (Number.isFinite(createdMs) && nowMs - createdMs < minHoldMs) {

    const waitSec = Math.ceil((minHoldMs - (nowMs - createdMs)) / 1000);

    return { flip: false, reason: `Plan1 持仓未满 ${Math.ceil(minHoldMs / 1000)}s，约 ${waitSec}s 后可翻转。` };

  }

  const cooldownMs = Number.isFinite(Number(config?.plan1FlipCooldownMs))

    ? Number(config.plan1FlipCooldownMs)

    : 120000;

  if (Number.isFinite(lastFlipAtMs) && nowMs - lastFlipAtMs < cooldownMs) {

    const waitSec = Math.ceil((cooldownMs - (nowMs - lastFlipAtMs)) / 1000);

    return { flip: false, reason: `Plan1 翻转冷却中，约 ${waitSec}s 后可再次翻转。` };

  }

  return {

    flip: true,

    reason: `Plan1 窗口内方向 ${openDirection.toUpperCase()} → ${newDirection.toUpperCase()}，平仓并反向开仓。`

  };

}



function windowMeta(timeframe = '15m') {

  return {

    key: 'window',

    label: timeframe === '5m' ? '5分钟窗口' : '15分钟窗口'

  };

}



function techWeightForElapsed(timeframe, elapsedPct) {

  if (timeframe === '5m') {

    return 0.25 + elapsedPct * 0.3;

  }

  return 0.05 + elapsedPct * 0.45;

}



function buildTechEntry(signal) {

  const direction = signal?.technicalDirection ?? signal?.direction;

  if (!signal || !['up', 'down'].includes(direction)) return null;

  const upProbability = Number(
    signal.technicalProbabilities?.up
    ?? signal.probabilities?.up
    ?? signal.prediction?.upProbability
  );

  const downProbability = Number(
    signal.technicalProbabilities?.down
    ?? signal.probabilities?.down
    ?? signal.prediction?.downProbability
  );

  return normalizeEntry({

    source: 'tech',

    direction,

    upProbability,

    downProbability,

    confidence: Number(signal.technicalConfidence ?? signal.confidence),

    previousClosedCandleMovePct: Number(signal.indicators?.previousClosedCandleMovePct),

    referencePrice: Number(signal.indicators?.currentPrice ?? signal.prediction?.estimatedClose)

  });

}



function buildPolymarketEntry(sentiment) {

  if (!sentiment?.available) return null;

  const upProbability = Number(sentiment.upProbability ?? sentiment.upPrice);

  const downProbability = Number(sentiment.downProbability ?? sentiment.downPrice);

  if (!Number.isFinite(upProbability) || !Number.isFinite(downProbability)) return null;

  return normalizeEntry({

    source: 'polymarket',

    direction: upProbability >= downProbability ? 'up' : 'down',

    upProbability,

    downProbability,

    confidence: Math.max(upProbability, downProbability),

    qualityScore: Number(sentiment.qualityScore),

    limitPrice: upProbability >= downProbability ? upProbability : downProbability

  });

}

function buildBasketEntry({ primarySymbol = 'BTC-USD', basketSentiments = [] } = {}) {
  const weights = {
    'BTC-USD': 0.45,
    'ETH-USD': 0.25,
    'SOL-USD': 0.20,
    'XRP-USD': 0.10
  };
  const rows = (basketSentiments || [])
    .filter((item) => item?.available)
    .map((item) => {
      const up = Number(item.upProbability ?? item.upPrice);
      const down = Number(item.downProbability ?? item.downPrice);
      if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
      const symbol = item.symbol || primarySymbol;
      const weight = Number(weights[symbol]) || (symbol === primarySymbol ? 0.45 : 0.10);
      return {
        symbol,
        weight,
        direction: up >= down ? 'up' : 'down',
        upProbability: up,
        downProbability: down,
        confidence: Math.max(up, down),
        gap: Math.abs(up - down),
        qualityScore: Number(item.qualityScore)
      };
    })
    .filter(Boolean);
  if (!rows.length) return null;

  const weightSum = rows.reduce((sum, row) => sum + row.weight, 0) || 1;
  const upScore = rows.reduce((sum, row) => sum + row.upProbability * row.weight, 0) / weightSum;
  const downScore = rows.reduce((sum, row) => sum + row.downProbability * row.weight, 0) / weightSum;
  const direction = upScore >= downScore ? 'up' : 'down';
  const alignedCount = rows.filter((row) => row.direction === direction).length;
  const primary = rows.find((row) => row.symbol === primarySymbol);
  const primaryAligned = primary ? primary.direction === direction : true;
  return normalizeEntry({
    source: 'crypto_basket',
    direction,
    upProbability: upScore,
    downProbability: downScore,
    confidence: Math.max(upScore, downScore),
    qualityScore: average(rows.map((row) => row.qualityScore).filter(Number.isFinite)),
    basketRows: rows,
    alignedCount,
    totalCount: rows.length,
    primaryAligned,
    alignmentScore: alignedCount / rows.length
  });
}



function buildCompositeEntry(tech, polymarket, elapsedPct, timeframe = '15m', basket = null) {

  const techUp = Number(tech.upProbability) || 0;

  const techDown = Number(tech.downProbability) || 0;

  const polyUp = Number(polymarket.upProbability) || 0;

  const polyDown = Number(polymarket.downProbability) || 0;

  const techSum = Math.max(techUp + techDown, 0.000001);

  const polySum = Math.max(polyUp + polyDown, 0.000001);

  const qualityScore = clamp(Number(polymarket.qualityScore), 0.15, 1, 1);

  const baseTechWeight = techWeightForElapsed(timeframe, elapsedPct);

  const skipQualityAdjustment = timeframe === '15m' && elapsedPct < 5 / 15;

  const techWeight = skipQualityAdjustment
    ? baseTechWeight
    : baseTechWeight + (1 - baseTechWeight) * (1 - qualityScore);

  const basketWeight = basket ? (timeframe === '5m' ? 0.18 : 0.14) : 0;

  const polyWeight = Math.max(0, 1 - techWeight - basketWeight);

  const basketUp = basket ? Number(basket.upProbability) || 0 : 0;

  const basketDown = basket ? Number(basket.downProbability) || 0 : 0;

  const basketSum = Math.max(basketUp + basketDown, 0.000001);

  const adjusted = applyPreviousMoveReversalBias({

    upProbability: (techUp / techSum) * techWeight + (polyUp / polySum) * polyWeight + (basketUp / basketSum) * basketWeight,

    downProbability: (techDown / techSum) * techWeight + (polyDown / polySum) * polyWeight + (basketDown / basketSum) * basketWeight,

    previousMovePct: tech.previousClosedCandleMovePct,

    elapsedPct,

    timeframe

  });

  return normalizeEntry({

    source: 'composite',

    direction: adjusted.upProbability >= adjusted.downProbability ? 'up' : 'down',

    upProbability: adjusted.upProbability,

    downProbability: adjusted.downProbability,

    confidence: Math.max(adjusted.upProbability, adjusted.downProbability),

    qualityScore,

    techWeight,

    polymarketWeight: polyWeight,

    basketWeight,

    basketAlignmentScore: basket?.alignmentScore ?? null,

    previousMoveAdjustment: adjusted.adjustment

  });

}



function chooseAction({
  window,
  strategies,
  config,
  signal,
  sentiment,
  timeframe = '15m',
  portfolio = null,
  calibrationTable = null,
  lossReasonOrders = null,
  openExposureOrders = [],
  elapsedPct = 0,
  paperMode = true
}) {
  const preferred = strategies.composite || strategies.tech || strategies.polymarket;
  if (!preferred) return skip('没有可用判断。');
  if (!sentiment?.available) return skip(`Polymarket ${timeframe} 市场不可用。`);

  const minElapsedPct = resolvePlan1EntryMinElapsedPct(timeframe, config);
  const maxElapsedPct = resolvePlan1EntryMaxElapsedPct(timeframe, config);
  const basketAlignment = resolvePlan1BasketAlignment(preferred.direction, strategies.basket);
  const regimeGuard = buildChopRegimeGuard({ signal, sentiment, config });
  const directionConfidence = Number(preferred.confidence);
  const rawEdgeConfidence = resolvePlan1EdgeConfidence(strategies, timeframe, config, sentiment) ?? directionConfidence;
  const limitPrice = Number(preferred.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
  const qualityScore = Number(preferred.qualityScore ?? sentiment.qualityScore);
  const equity = Number(portfolio?.equity ?? portfolio?.startingCash ?? config.defaultStartingCash) || 0;

  const hedgeAction = buildPlan1OppositeHedgeAction({
    preferred,
    sentiment,
    signal,
    timeframe,
    config,
    portfolio,
    openExposureOrders,
    elapsedPct
  });
  if (hedgeAction) return hedgeAction;

  const calibrated = resolveCalibratedEdge({
    rawConfidence: rawEdgeConfidence,
    entryPrice: limitPrice,
    planId: 'plan1',
    symbol: signal?.symbol || preferred?.symbol || 'BTC-USD',
    timeframe,
    direction: preferred.direction,
    entryType: 'main',
    calibrationTable: calibrationTable || {},
    config
  });
  const edgeConfidence = calibrated.calibratedConfidence;

  const lateCaptureAction = buildPlan1LateCaptureAction({
    preferred,
    sentiment,
    signal,
    timeframe,
    config,
    portfolio,
    directionConfidence,
    edgeConfidence,
    rawEdgeConfidence,
    calibrated,
    calibrationTable,
    lossReasonOrders,
    basketAlignment,
    qualityScore,
    limitPrice,
    elapsedPct,
    equity,
    paperMode
  });
  if (lateCaptureAction) return lateCaptureAction;

  if (elapsedPct < minElapsedPct) {
    return skip(`窗口前 ${(minElapsedPct * 100).toFixed(0)}% 禁止普通入场（当前 ${(elapsedPct * 100).toFixed(0)}%）。`);
  }
  if (elapsedPct > maxElapsedPct) {
    return skip(`窗口后 ${((1 - maxElapsedPct) * 100).toFixed(0)}% 禁止普通入场（当前 ${(elapsedPct * 100).toFixed(0)}%）。`);
  }
  if (regimeGuard.isChop && !regimeGuard.allowMain) {
    return skip(`Plan1 震荡过滤：${regimeGuard.reason || '当前市场不适合主仓。'}`);
  }

  const maxEntryPrice = resolvePlan1MaxEntryPrice(timeframe, config);
  const minEntryPrice = resolvePlan1MinEntryPrice(timeframe, config);
  const minConfidence = resolvePlan1MinConfidence(timeframe, config);
  const tierCheck = evaluateTieredEntry({
    confidence: edgeConfidence,
    entryPrice: limitPrice,
    timeframe,
    config,
    marketQuality: qualityScore,
    minConfidence,
    minEntryPrice,
    maxEntryPrice,
    planLabel: 'Plan1'
  });
  if (!tierCheck.allowed) return skip(tierCheck.reason);
  if (Number.isFinite(calibrated.edge)) tierCheck.edge = calibrated.edge;
  if (regimeGuard.scale < 1) {
    tierCheck.sizeMultiplier = round4((tierCheck.sizeMultiplier || 1) * regimeGuard.scale);
  }

  let entryType = 'main';
  let sizeMultiplier = tierCheck.sizeMultiplier || 1;
  if (basketAlignment.status === 'aligned') {
    sizeMultiplier = round4(Math.min(sizeMultiplier * 1.18, 1.35));
  } else if (basketAlignment.status === 'conflict') {
    if (config.plan1BasketConflictProbeEnabled === false) {
      return skip('Plan1 篮子方向与当前信号冲突，已按历史亏损归因关闭 basket probe。');
    }
    entryType = 'basket_probe';
    sizeMultiplier = round4(Math.max(0.05, Number(config.plan1BasketConflictProbeMultiplier) || 0.15));
  }

  const action = buildPlan1SizedAction({
    preferred,
    signal,
    timeframe,
    config,
    portfolio,
    directionConfidence,
    edgeConfidence,
    rawEdgeConfidence,
    calibrated,
    calibrationTable,
    lossReasonOrders,
    qualityScore,
    limitPrice,
    equity,
    elapsedPct,
    entryType,
    sizeMultiplier,
    paperMode,
    reasonPrefix: `Plan1 ${timeframe} ${window.label}: ${entryType}，basket=${basketAlignment.status}，edge ${(Number(tierCheck.edge || 0) * 100).toFixed(1)}%`
  });
  if (action.shouldTrade) {
    action.regime = regimeGuard.regime;
    action.basketAlignment = basketAlignment.status;
    action.basketScore = strategies.basket?.alignmentScore ?? null;
    action.entryTier = tierCheck.tierKey;
    action.edge = tierCheck.edge;
  }
  return action;
}

function resolvePlan1BasketAlignment(direction, basket) {
  if (!basket?.basketRows?.length || !['up', 'down'].includes(direction)) {
    return { status: 'none', aligned: 0, total: 0, score: null };
  }
  const rows = basket.basketRows;
  const aligned = rows.filter((row) => row.direction === direction).length;
  const score = aligned / rows.length;
  if (score >= 0.75) return { status: 'aligned', aligned, total: rows.length, score };
  if (score <= 0.4) return { status: 'conflict', aligned, total: rows.length, score };
  return { status: 'mixed', aligned, total: rows.length, score };
}

function buildPlan1LateCaptureAction({
  preferred,
  sentiment,
  signal,
  timeframe,
  config,
  portfolio,
  directionConfidence,
  edgeConfidence,
  rawEdgeConfidence,
  calibrated,
  calibrationTable = null,
  lossReasonOrders = null,
  basketAlignment,
  qualityScore,
  limitPrice,
  elapsedPct,
  equity,
  paperMode = true
}) {
  if (config.plan1LateCaptureEnabled === false) return null;
  const minElapsed = Number(config.plan1LateCaptureMinElapsedPct);
  const maxElapsed = Number(config.plan1LateCaptureMaxElapsedPct);
  const elapsedLo = Number.isFinite(minElapsed) ? minElapsed : (timeframe === '5m' ? 0.45 : 0.50);
  const elapsedHi = Number.isFinite(maxElapsed) ? maxElapsed : 0.92;
  if (elapsedPct < elapsedLo || elapsedPct > elapsedHi) return null;
  const minPrice = Number(config.plan1LateCaptureMinPrice) || 0.70;
  const maxPrice = Number(config.plan1LateCaptureMaxPrice) || 0.88;
  if (!Number.isFinite(limitPrice) || limitPrice < minPrice || limitPrice > maxPrice) return null;
  const minQuality = Number(config.plan1LateCaptureMinMarketQuality) || 0.40;
  if (Number.isFinite(qualityScore) && qualityScore < minQuality) return null;
  const minLateConf = Number(config.plan1LateCaptureMinConfidence);
  const confFloor = Number.isFinite(minLateConf) && minLateConf > 0 ? minLateConf : 0.58;
  const lateConf = Number.isFinite(Number(edgeConfidence))
    ? Number(edgeConfidence)
    : Number(directionConfidence);
  if (!Number.isFinite(lateConf) || lateConf + 1e-9 < confFloor) return null;
  if (basketAlignment.status === 'conflict') return null;
  const startPrice = Number(signal?.prediction?.comparisonBasePrice) || null;
  const currentPrice = Number(signal?.indicators?.currentPrice);
  // 距开盘距离用实时价；若盘口已是强热门侧，允许用 PM 方向替代 spot 距离，避免「价已 80¢+ 但 spot 回撤几 bp」误杀。
  const referencePrice = Number.isFinite(currentPrice) && currentPrice > 0
    ? currentPrice
    : Number(signal?.prediction?.estimatedClose) || null;
  const signedDistanceBps = startPrice && referencePrice
    ? ((referencePrice - startPrice) / startPrice) * 10000
    : 0;
  const distanceBps = Math.abs(signedDistanceBps);
  const rawMinDistance = Number(config.plan1LateCaptureMinDistanceBps);
  const minDistanceBps = Number.isFinite(rawMinDistance)
    ? Math.max(0, rawMinDistance)
    : (timeframe === '5m' ? 3 : 5);
  const up = Number(sentiment?.upPrice);
  const down = Number(sentiment?.downPrice);
  const pmFavorite = Number.isFinite(up) && Number.isFinite(down)
    ? (up >= down ? 'up' : 'down')
    : null;
  const strongPmFavorite = pmFavorite
    && preferred?.direction === pmFavorite
    && Number.isFinite(limitPrice)
    && limitPrice >= minPrice;
  if (!strongPmFavorite) {
    if (distanceBps < minDistanceBps) return null;
    const expectedDirection = signedDistanceBps >= 0 ? 'up' : 'down';
    if (expectedDirection !== preferred.direction) return null;
  }
  const sizeMultiplier = limitPrice <= 0.80
    ? (Number(config.plan1LateCaptureMidSizeMultiplier) || 0.35)
    : (Number(config.plan1LateCaptureHighSizeMultiplier) || 0.18);
  return buildPlan1SizedAction({
    preferred,
    signal,
    timeframe,
    config,
    portfolio,
    directionConfidence,
    edgeConfidence,
    rawEdgeConfidence,
    calibrated,
    calibrationTable,
    lossReasonOrders,
    qualityScore,
    limitPrice,
    equity,
    elapsedPct,
    entryType: 'late_capture',
    sizeMultiplier,
    paperMode,
    reasonPrefix: `Plan1 late_capture ${timeframe}: ${Math.round(limitPrice * 100)}c 高价定型捕捉，basket=${basketAlignment.status}，distance=${distanceBps.toFixed(1)}bps${strongPmFavorite ? '，pm_favorite' : ''}`
  });
}

/** Paper uses settlementStatus; live openExposure uses positionStatus. */
function isPlan1OpenExposureOrder(order) {
  if (!order) return false;
  if (order.settlementStatus === 'open' || order.settlementStatus === 'pending') return true;
  if (order.positionStatus === 'open' || order.positionStatus === 'pending') return true;
  // Live builder already filtered via getOpenLivePositions(); treat submitted live rows as open.
  if (order.source === 'live' && order.status === 'submitted' && order.positionStatus !== 'closed') {
    return true;
  }
  return false;
}

function buildPlan1OppositeHedgeAction({
  preferred,
  sentiment,
  signal,
  timeframe,
  config,
  portfolio,
  openExposureOrders,
  elapsedPct
}) {
  if (config.plan1OppositeHedgeEnabled === false) return null;
  if (!sentiment?.available || !['up', 'down'].includes(preferred?.direction)) return null;
  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';
  const slotIso = signal?.schedule?.currentSlotIso || null;
  const minRemainingPct = Number(config.plan1OppositeHedgeMinRemainingPct) || (timeframe === '5m' ? 0.20 : 0.12);
  if (1 - elapsedPct < minRemainingPct) return null;
  const main = (openExposureOrders || []).find((order) => (
    (order.planId || 'plan1') === 'plan1'
    && (order.symbol || 'BTC-USD') === symbol
    && (order.timeframe || '15m') === timeframe
    && (order.slotIso || order.plan?.slotIso) === slotIso
    && isPlan1OpenExposureOrder(order)
    && String(order.entryType || order.plan?.entryType || '').toLowerCase() !== 'opposite_hedge'
    && order.direction === preferred.direction
  ));
  if (!main) return null;
  const alreadyHedged = (openExposureOrders || []).some((order) => (
    (order.planId || 'plan1') === 'plan1'
    && (order.symbol || 'BTC-USD') === symbol
    && (order.timeframe || '15m') === timeframe
    && (order.slotIso || order.plan?.slotIso) === slotIso
    && isPlan1OpenExposureOrder(order)
    && String(order.entryType || order.plan?.entryType || '').toLowerCase() === 'opposite_hedge'
  ));
  if (alreadyHedged) return null;
  const oppositeDirection = preferred.direction === 'up' ? 'down' : 'up';
  const limitPrice = Number(oppositeDirection === 'up' ? sentiment.upPrice : sentiment.downPrice);
  const maxPrice = Number(config.plan1OppositeHedgeMaxPrice) || 0.15;
  if (!Number.isFinite(limitPrice) || limitPrice > maxPrice) return null;
  const hedgePct = Number(config.plan1OppositeHedgeSizePct) || 0.05;
  const usd = round2(Math.max(0.5, Number(main.usd || 0) * hedgePct));
  if (!portfolio?.portfolioInitialized || usd > Number(portfolio.cash)) return null;
  const exits = computePlan1ExitPrices(limitPrice, config);
  const executionKey = `${slotIso || 'unknown'}_${symbol}_${timeframe}_${oppositeDirection}_opposite_hedge`;
  return {
    shouldTrade: true,
    strategy: 'opposite_hedge',
    direction: oppositeDirection,
    entryType: 'opposite_hedge',
    label: oppositeDirection === 'up' ? 'Hedge UP' : 'Hedge DOWN',
    confidence: round4(1 - limitPrice),
    edgeConfidence: round4(1 - limitPrice),
    rawEdgeConfidence: round4(1 - limitPrice),
    calibratedConfidence: round4(1 - limitPrice),
    confidenceCalibrated: false,
    edge: round4((1 - limitPrice) - limitPrice),
    executionKey,
    entryTier: 'hedge',
    sizeMultiplier: hedgePct,
    entryElapsedPct: round4(elapsedPct),
    usd,
    sizing: { usd, rawUsd: usd, cappedUsd: usd },
    limitPrice: round4(limitPrice),
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    estimatedClose: Number(signal?.prediction?.estimatedClose) || null,
    startPrice: Number(signal?.prediction?.comparisonBasePrice) || null,
    reason: `Plan1 opposite hedge: ${symbol} ${timeframe} 主仓 ${preferred.direction.toUpperCase()} 已存在，反向 ${oppositeDirection.toUpperCase()} ${Math.round(limitPrice * 100)}c <= ${Math.round(maxPrice * 100)}c，小仓 ${Math.round(hedgePct * 100)}% 保险。`
  };
}

function buildPlan1SizedAction({
  preferred,
  signal,
  timeframe,
  config,
  portfolio,
  directionConfidence,
  edgeConfidence,
  rawEdgeConfidence,
  calibrated,
  calibrationTable = null,
  lossReasonOrders = null,
  qualityScore,
  limitPrice,
  equity,
  elapsedPct,
  entryType,
  sizeMultiplier,
  paperMode = true,
  reasonPrefix
}) {
  if (!portfolio?.portfolioInitialized) return skip('请先在控制台设置初始本金。');
  const symbol = signal?.symbol || preferred?.symbol || 'BTC-USD';
  const historyGate = evaluateHistoryWinRateGate({
    rawConfidence: rawEdgeConfidence,
    entryPrice: limitPrice,
    planId: 'plan1',
    symbol,
    timeframe,
    direction: preferred.direction,
    entryType,
    calibrationTable: calibrationTable || {},
    config: config.plan1HistoryHierarchyEnabled === false
      ? config
      : { ...config, confidenceCalibrationHierarchyEnabled: true },
    planLabel: 'Plan1'
  });
  if (!historyGate.allowed) return skip(historyGate.reason);

  const lossGate = evaluateLossReasonGate({
    planId: 'plan1',
    timeframe,
    entryType,
    symbol,
    orders: lossReasonOrders,
    config,
    planLabel: 'Plan1'
  });
  if (!lossGate.allowed) return skip(lossGate.reason);

  let effectiveSizeMultiplier = Number(sizeMultiplier) || 1;
  if (Number.isFinite(historyGate.sizeScale) && historyGate.sizeScale < 1) {
    effectiveSizeMultiplier = round4(effectiveSizeMultiplier * historyGate.sizeScale);
  }
  if (Number.isFinite(lossGate.sizeScale) && lossGate.sizeScale < 1) {
    effectiveSizeMultiplier = round4(effectiveSizeMultiplier * lossGate.sizeScale);
  }

  const basePaperPct = Number(config.plan1PaperOrderPct) || 0.05;
  const activeSymbols = Array.isArray(config.plan1Symbols) && config.plan1Symbols.length
    ? config.plan1Symbols
    : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  const symbolWr = resolveSymbolWrSizedOrderPct({
    symbol,
    baseOrderPct: basePaperPct,
    activeSymbols,
    winRates: portfolio?.symbolWinRates || config._symbolWinRates || null,
    config
  });
  const effectivePaperPct = symbolWr.orderPct;

  let sizing;
  if (paperMode !== false && config.plan1PaperCashPctEnabled !== false) {
    const paperUsd = computePlan1PaperOrderUsd({
      cash: portfolio?.cash,
      config,
      orderPct: effectivePaperPct
    });
    sizing = {
      usd: paperUsd,
      paperSizing: true,
      orderPct: effectivePaperPct,
      baseOrderPct: basePaperPct,
      symbolWrSizeScale: symbolWr.sizeScale,
      symbolWrRank: symbolWr.rank ?? null,
      minOrderUsd: Number.isFinite(Number(config.plan1PaperMinOrderUsd)) ? Number(config.plan1PaperMinOrderUsd) : 1,
      sizeMultiplier: effectiveSizeMultiplier,
      availableCash: Number(portfolio?.cash) || 0
    };
  } else {
    const baseSizing = computePolymarketOrderUsd({ equity, cash: portfolio?.cash, timeframe, config });
    const wrScaledUsd = round2((Number(baseSizing.usd) || 0) * (Number(symbolWr.sizeScale) || 1));
    const wrSizing = {
      ...baseSizing,
      usd: wrScaledUsd,
      orderPct: round4((Number(baseSizing.orderPct) || 0) * (Number(symbolWr.sizeScale) || 1)),
      symbolWrSizeScale: symbolWr.sizeScale,
      symbolWrRank: symbolWr.rank ?? null
    };
    sizing = applyKellyCapToSizing(
      scalePolymarketOrderByConfidence({
        sizing: wrSizing,
        confidence: edgeConfidence,
        qualityScore,
        minConfidence: resolvePlan1MinConfidence(timeframe, config),
        sizeMultiplier: effectiveSizeMultiplier,
        cash: portfolio?.cash
      }),
      { calibratedConfidence: edgeConfidence, entryPrice: limitPrice, equity, config }
    );
  }
  let usd = Number(sizing.usd) || 0;
  // 实盘：soft/late 叠乘后易把小账户压到灰尘单；现金够时抬到可执行底仓（CLOB 5 份 / 配置 floor）。
  if (paperMode === false) {
    const cash = Number(portfolio?.cash) || 0;
    const liveMinCfg = Number(config.plan1LiveMinOrderUsd);
    const execFloor = Number.isFinite(Number(config.plan1LiveExecutableFloorUsd))
      ? Math.max(0, Number(config.plan1LiveExecutableFloorUsd))
      : 2.5;
    const clobMin = Math.ceil((Number(limitPrice) || 0) * 5 * 100) / 100;
    const floorUsd = Math.max(
      Number.isFinite(clobMin) ? clobMin : 0,
      Number.isFinite(liveMinCfg) && liveMinCfg > 0 ? liveMinCfg : 0,
      execFloor
    );
    const maxCashPct = Number(config.plan1LiveMaxOrderCashPct);
    const cashCap = cash * (Number.isFinite(maxCashPct) && maxCashPct > 0 ? Math.min(1, maxCashPct) : 0.35);
    const cappedFloor = round2(Math.min(floorUsd, cash, Math.max(0, cashCap)));
    if (cash + 1e-9 >= Math.max(0.5, clobMin || 0) && cappedFloor >= 0.5) {
      usd = Math.max(usd, cappedFloor);
    }
  }
  if (usd < 0.5) return skip('按当前净值计算的买入金额不足 $0.50。');
  if (Number(portfolio.cash) < usd) {
    return skip(`可用现金 $${Number(portfolio.cash).toFixed(2)} 不足以按计划买入 $${usd.toFixed(2)}。`);
  }
  const exits = computePlan1ExitPrices(limitPrice, config);
  const wrNote = symbolWr.enabled && Number(symbolWr.sizeScale) !== 1
    ? `；分币胜率奖赏×${Number(symbolWr.sizeScale).toFixed(2)}（排名${symbolWr.rank ?? '中性'}）`
    : '';
  return {
    shouldTrade: true,
    strategy: preferred.source,
    direction: preferred.direction,
    entryType,
    label: preferred.direction === 'up' ? 'Buy UP' : 'Buy DOWN',
    // 落盘/校准用 edgeConfidence，避免 directionConfidence 低导致「门槛 0.60 仍见 <0.55」假泄漏
    confidence: round4(edgeConfidence),
    directionConfidence: round4(directionConfidence),
    edgeConfidence: round4(edgeConfidence),
    rawEdgeConfidence: round4(rawEdgeConfidence),
    calibratedConfidence: round4(edgeConfidence),
    confidenceCalibrated: calibrated?.calibrated || false,
    edge: round4(edgeConfidence - limitPrice),
    entryTier: entryType,
    sizeMultiplier,
    entryElapsedPct: round4(elapsedPct),
    historyWinRateGate: historyGate.insufficientSamples
      ? { passed: true, insufficientSamples: true, sampleCount: historyGate.sampleCount }
      : {
        passed: true,
        sampleCount: historyGate.sampleCount,
        requiredWinRate: historyGate.requiredWinRate,
        winRate: historyGate.winRate ?? null,
        softReject: Boolean(historyGate.softReject),
        sizeScale: historyGate.sizeScale ?? null,
        originalReason: historyGate.originalReason || null
      },
    lossReasonGate: lossGate.insufficientSamples
      ? { passed: true, insufficientSamples: true, sampleCount: lossGate.sampleCount }
      : {
        passed: true,
        sampleCount: lossGate.sampleCount,
        lossRate: lossGate.lossRate,
        sizeScale: lossGate.sizeScale
      },
    symbolWrSizing: symbolWr.enabled
      ? {
        sizeScale: symbolWr.sizeScale,
        rank: symbolWr.rank ?? null,
        orderPct: symbolWr.orderPct,
        winRate: symbolWr.winRate ?? null,
        samples: symbolWr.samples ?? null,
        coldStart: Boolean(symbolWr.coldStart)
      }
      : null,
    usd,
    sizing,
    limitPrice: round4(limitPrice),
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    estimatedClose: Number(signal?.prediction?.estimatedClose) || null,
    startPrice: Number(signal?.prediction?.comparisonBasePrice) || null,
    reason: sizing.paperSizing
      ? `${reasonPrefix}；模拟盘按剩余现金 ${(Number(sizing.orderPct) * 100).toFixed(0)}% 计划买入 $${usd.toFixed(2)}（现金 $${Number(portfolio.cash).toFixed(2)}）${wrNote}。`
      : `${reasonPrefix}；按净值 $${equity.toFixed(2)} 计划买入 $${usd.toFixed(2)}${wrNote}。`
  };
}

function chooseActionLegacy({

  window,

  strategies,

  config,

  risk,

  tradingStats,

  signal,

  sentiment,

  timeframe = '15m',

  portfolio = null,

  calibrationTable = null,

  elapsedPct = 0

}) {

  const preferred = strategies.composite || strategies.tech || strategies.polymarket;

  if (!preferred) {

    return skip('没有可用判断。');

  }

  if (!sentiment?.available) {

    return skip(`Polymarket ${timeframe} 市场不可用。`);

  }



  const minElapsedPct = resolvePlan1EntryMinElapsedPct(timeframe, config);

  const maxElapsedPct = resolvePlan1EntryMaxElapsedPct(timeframe, config);

  if (elapsedPct < minElapsedPct) {

    return skip(`窗口前 ${(minElapsedPct * 100).toFixed(0)}% 禁止入场（当前 ${(elapsedPct * 100).toFixed(0)}%）。`);

  }

  if (elapsedPct > maxElapsedPct) {

    return skip(`窗口后 ${((1 - maxElapsedPct) * 100).toFixed(0)}% 禁止入场（当前 ${(elapsedPct * 100).toFixed(0)}%）。`);

  }

  const regimeGuard = buildChopRegimeGuard({ signal, sentiment, config });
  if (regimeGuard.isChop && !regimeGuard.allowMain) {
    return skip(`Plan1 震荡过滤：${regimeGuard.reason || '当前市场不适合主仓。'}`);
  }



  const directionConfidence = Number(preferred.confidence);

  const rawEdgeConfidence = resolvePlan1EdgeConfidence(strategies, timeframe, config, sentiment) ?? directionConfidence;
  const calibrated = resolveCalibratedEdge({
    rawConfidence: rawEdgeConfidence,
    entryPrice: Number(preferred.direction === 'up' ? sentiment.upPrice : sentiment.downPrice),
    planId: 'plan1',
    symbol: signal?.symbol || preferred?.symbol || 'BTC-USD',
    timeframe,
    direction: preferred.direction,
    entryType: 'main',
    calibrationTable: calibrationTable || {},
    config
  });
  const edgeConfidence = calibrated.calibratedConfidence;

  const minConfidence = resolvePlan1MinConfidence(timeframe, config);

  const limitPrice = Number(preferred.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);

  const qualityScore = Number(preferred.qualityScore ?? sentiment.qualityScore);

  const maxEntryPrice = resolvePlan1MaxEntryPrice(timeframe, config);
  const minEntryPrice = resolvePlan1MinEntryPrice(timeframe, config);

  const tierCheck = evaluateTieredEntry({

    confidence: edgeConfidence,

    entryPrice: limitPrice,

    timeframe,

    config,

    marketQuality: qualityScore,

    minConfidence,

    minEntryPrice,

    maxEntryPrice,

    planLabel: 'Plan1'

  });

  if (!tierCheck.allowed) {

    return skip(tierCheck.reason);

  }

  if (Number.isFinite(calibrated.edge)) {
    tierCheck.edge = calibrated.edge;
  }
  if (regimeGuard.scale < 1) {
    tierCheck.sizeMultiplier = round4((tierCheck.sizeMultiplier || 1) * regimeGuard.scale);
  }



  const settledOrders = Number(tradingStats?.settledOrders) || 0;

  const timeframeWinRate = settledOrders > 0 && Number.isFinite(Number(tradingStats?.winRate))

    ? Number(tradingStats.winRate)

    : null;

  const historyText = formatTimeframeHistory({

    timeframe,

    winRate: timeframeWinRate,

    wins: Number(tradingStats?.wins) || 0,

    settledOrders

  });

  const equity = Number(portfolio?.equity ?? portfolio?.startingCash ?? config.defaultStartingCash) || 0;

  const baseSizing = computePolymarketOrderUsd({

    equity,

    cash: portfolio?.cash,

    timeframe,

    config

  });

  const sizing = applyKellyCapToSizing(
    scalePolymarketOrderByConfidence({

    sizing: baseSizing,

    confidence: edgeConfidence,

    qualityScore,

    minConfidence,

    sizeMultiplier: tierCheck.sizeMultiplier,

    cash: portfolio?.cash

    }),
    {
      calibratedConfidence: edgeConfidence,
      entryPrice: limitPrice,
      equity,
      config
    }
  );

  const usd = sizing.usd;



  if (!portfolio?.portfolioInitialized) {

    return skip('请先在控制台设置初始本金。');

  }

  if (usd < 0.5) {

    return skip('按当前净值计算的买入金额不足 $0.50。');

  }

  if (Number(portfolio.cash) < usd) {

    return skip(`可用现金 $${Number(portfolio.cash).toFixed(2)} 不足以按计划买入 $${usd.toFixed(2)}。`);

  }



  const exits = computePlan1ExitPrices(limitPrice, config);



  return {

    shouldTrade: true,

    strategy: preferred.source,

    direction: preferred.direction,

    label: preferred.direction === 'up' ? '买 UP / 看涨' : '买 DOWN / 看跌',

    confidence: round4(edgeConfidence),

    directionConfidence: round4(directionConfidence),

    edgeConfidence: round4(edgeConfidence),

    rawEdgeConfidence: round4(rawEdgeConfidence),

    calibratedConfidence: round4(edgeConfidence),

    confidenceCalibrated: calibrated.calibrated,

    regime: regimeGuard.regime,

    edge: tierCheck.edge,

    entryTier: tierCheck.tierKey,

    sizeMultiplier: tierCheck.sizeMultiplier,

    entryElapsedPct: round4(elapsedPct),

    usd,

    sizing,

    limitPrice: Number.isFinite(limitPrice) ? round4(limitPrice) : null,

    takeProfitPrice: exits.takeProfitPrice,

    stopLossPrice: exits.stopLossPrice,

    estimatedClose: Number(signal?.prediction?.estimatedClose) || null,

    startPrice: Number(signal?.prediction?.comparisonBasePrice) || null,

    reason: `使用 ${timeframe} ${window.label} 综合方向 + tech-heavy edge，${tierCheck.tierLabel}，方向置信 ${(directionConfidence * 100).toFixed(1)}%，edge置信 ${(edgeConfidence * 100).toFixed(1)}%，edge ${(tierCheck.edge * 100).toFixed(1)}%，${historyText}。按净值 $${equity.toFixed(2)} 计划买入 $${usd.toFixed(2)}（tier ×${tierCheck.sizeMultiplier}，TP/SL 按入场价分层）。`

  };

}



function formatTimeframeHistory({ timeframe, winRate, wins, settledOrders }) {

  if (!settledOrders || !Number.isFinite(winRate)) {

    return `本策略 ${timeframe} 暂无已结算胜率`;

  }

  return `本策略 ${timeframe} 胜率 ${(winRate * 100).toFixed(1)}%（${wins}/${settledOrders}）`;

}



function normalizeEntry(entry) {

  if (!entry) return null;

  const up = Number(entry.upProbability);

  const down = Number(entry.downProbability);

  const sum = Math.max(up + down, 0.000001);

  const upProbability = up / sum;

  const downProbability = down / sum;

  return {

    ...entry,

    direction: entry.direction || (upProbability >= downProbability ? 'up' : 'down'),

    upProbability: round4(upProbability),

    downProbability: round4(downProbability),

    confidence: round4(Number(entry.confidence) || Math.max(upProbability, downProbability))

  };

}



function applyPreviousMoveReversalBias({ upProbability, downProbability, previousMovePct, elapsedPct, timeframe = '15m' }) {

  const move = Number(previousMovePct);

  if (!Number.isFinite(move)) {

    return { upProbability, downProbability, adjustment: 0 };

  }

  const absMove = Math.abs(move);

  const minMove = timeframe === '5m' ? 0.002 : 0.003;

  const maxMove = timeframe === '5m' ? 0.004 : 0.005;

  if (absMove < minMove || absMove >= maxMove) {

    return { upProbability, downProbability, adjustment: 0 };

  }

  const boost = timeframe === '5m'

    ? 0.03 - elapsedPct * 0.01

    : 0.04 - elapsedPct * 0.02;

  const adjustedUp = move < 0 ? upProbability + boost : upProbability - boost;

  const up = clamp(adjustedUp, 0.02, 0.98, upProbability);

  return {

    upProbability: up,

    downProbability: 1 - up,

    adjustment: move < 0 ? boost : -boost

  };

}



function skip(reason) {

  return {

    shouldTrade: false,

    strategy: null,

    direction: null,

    label: '跳过',

    confidence: 0,

    usd: 0,

    limitPrice: null,

    reason

  };

}



function clamp(value, min, max, fallback = min) {

  if (!Number.isFinite(value)) return fallback;

  return Math.max(min, Math.min(max, value));

}

function average(values) {
  const list = (values || []).filter((value) => Number.isFinite(Number(value))).map(Number);
  if (!list.length) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}



function round4(value) {

  return Math.round(Number(value) * 1e4) / 1e4;

}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
