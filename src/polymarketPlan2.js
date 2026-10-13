import {

  computeDynamicExitPrices,

  computePolymarketOrderUsd,

  computePlan2PaperOrderUsd,

  computeTradeEdge,

  evaluateTieredEntry,

  resolveStopLossAbsoluteFloor,

  resolveTierMinConfidence,

  scalePolymarketOrderByConfidence,

  applyKellyCapToSizing,

  resolveSymbolWrSizedOrderPct

} from './polymarketSizing.js';
import { resolveCalibratedEdge } from './polymarketCalibration.js';
import { evaluateHistoryWinRateGate } from './historyGate.js';
import { evaluateLossReasonGate } from './lossReasonGate.js';

import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';

import { buildWindowPlanKey, windowElapsedPct } from './polymarketPlan.js';
import { buildPlan2FiveMinuteLockGuard, plan2EntryBlockedByFiveMinuteLock, applyFiveMinuteLockToPlan2Direction } from './fiveMinuteDecision.js';
import {
  PLAN2_CLASSIC_ID,
  PLAN2_ENHANCED_ID,
  PLAN2_TIGHT_ID,
  PLAN2_RELAXED_SL_ID,
  isPlan2Family,
  normalizePlan2FamilyId,
  plan2FamilyLabel,
  resolvePlan2ProfileConfig,
  evaluatePlan25RecoveryGate
} from './polymarketPlan2Profiles.js';
import { applyPlan26EntryPolicy } from './polymarketPlan2_6.js';
import { PLAN13_ID, applyPlan13EntryPolicy } from './polymarketPlan13.js';

export {
  PLAN2_CLASSIC_ID,
  PLAN2_ENHANCED_ID,
  PLAN2_TIGHT_ID,
  PLAN2_RELAXED_SL_ID,
  isPlan2Family,
  normalizePlan2FamilyId,
  plan2FamilyLabel,
  resolvePlan2ProfileConfig
};

/** 实盘是否与模拟盘共用放宽入场规则。退出同步见 plan2LiveSyncPaperExitEnabled。 */
export function resolvePlan2PaperMode(config = {}, { paperMode = true } = {}) {
  if (paperMode) return true;
  // Plan2.5：默认 false（严格入场）；经典 Plan2 profile 会把 ENTRY sync 设为 true（main 风格）。
  return config.plan2LiveSyncPaperEntryEnabled === true;
}

/** 模拟盘 / 实盘同步：在 paperMode 下合并放宽后的 Plan2 参数。 */
export function resolvePlan2EffectiveConfig(config = {}, { paperMode = true } = {}) {
  const paperRelaxed = resolvePlan2PaperMode(config, { paperMode }) && config.plan2PaperRelaxedEnabled !== false;
  const lateCaptureRequireCalibratedEdge = config.plan2LateCaptureRequireCalibratedEdge === true;
  // 实盘入场同步纸面时：取消高价延迟等待。否则模拟已走 late/settlement 入场，
  // 实盘仍卡在「≥70% 等 10s」再被 readiness 打断，整窗跟不上。
  const syncLiveEntry = !paperMode && config.plan2LiveSyncPaperEntryEnabled === true;
  if (!paperRelaxed) {
    return {
      ...config,
      plan2LateCaptureRequireCalibratedEdge: lateCaptureRequireCalibratedEdge,
      ...(syncLiveEntry ? {
        plan2HighEntryDelayMs: 0,
        plan2HighEntryDelayMs5m: 0,
        plan2HighEntryDelayMs15m: 0,
        _plan2LiveSyncEntry: true
      } : {})
    };
  }
  return {
    ...config,
    plan2RegimeFilterEnabled: config.plan2PaperRegimeFilterEnabled !== false,
    plan2EntryMaxPrice: Number(config.plan2PaperEntryMaxPrice) || 0.82,
    plan2ProbeMaxPrice: Number(config.plan2PaperProbeMaxPrice) || 0.80,
    plan2ProbeMaxElapsedPct: Number(config.plan2PaperProbeMaxElapsedPct) || 0.78,
    plan2MinConfidence: Number(config.plan2PaperMinConfidence) || 0.52,
    plan2MinEdge: Number.isFinite(Number(config.plan2PaperMinEdge)) ? Number(config.plan2PaperMinEdge) : 0.04,
    plan2DownMinConfidence5m: Number(config.plan2PaperDownMinConfidence) || 0.52,
    plan2DownMinConfidence15m: Number(config.plan2PaperDownMinConfidence) || 0.52,
    plan2DownMinEdge: Number(config.plan2PaperDownMinEdge) || 0.0,
    plan2HighEntryMinPrice: Number(config.plan2PaperHighEntryMinPrice) || 0.95,
    plan2HighEntryDelayMs: Number(config.plan2PaperHighEntryDelayMs) || 0,
    plan2HighEntryDelayMs5m: Number(config.plan2PaperHighEntryDelayMs5m) || 0,
    plan2HighEntryDelayMs15m: Number(config.plan2PaperHighEntryDelayMs15m) || 0,
    plan2FiveMinuteLockEnabled: config.plan2PaperFiveMinuteLockEnabled !== false,
    plan2LateCaptureRequireCalibratedEdge: config.plan2PaperLateCaptureRequireCalibratedEdge === true,
    plan2LateCaptureMinElapsedPct: Number(config.plan2PaperLateCaptureMinElapsedPct) || 0.65,
    plan2LateCaptureMinQuality: Number(config.plan2PaperLateCaptureMinQuality) || 0.35,
    plan2LateCaptureMinDistanceBps: Number(config.plan2PaperLateCaptureMinDistanceBps) || 1,
    plan2LateCaptureMaxReverseBps: Number(config.plan2PaperLateCaptureMaxReverseBps) || 6,
    plan2LateCaptureBypassChop: config.plan2PaperLateCaptureBypassChop !== false,
    plan2SettlementCapture90MinQuality: Number(config.plan2PaperSettlementCapture90MinQuality) || 0.30,
    plan2SettlementCapture90MinDistanceBps: Number(config.plan2PaperSettlementCapture90MinDistanceBps) || 0.5,
    plan2SettlementCapture90MaxReverseBps: Number(config.plan2PaperSettlementCapture90MaxReverseBps) || 6,
    plan2RegimeSkipMainRisk: Number(config.plan2PaperRegimeSkipMainRisk) || 5,
    plan2RegimeSkipAllRisk: Number(config.plan2PaperRegimeSkipAllRisk) || 7,
    plan2RequirePolymarketAlignment: config.plan2PaperRequirePmAlignment !== false,
    plan2ProbeMinConfidence: Number(config.plan2PaperProbeMinConfidence) || 0.52,
    plan2ProbeMinEdge: Number(config.plan2PaperProbeMinEdge) || 0.001,
    plan2ProbeMinPmEdge: Number(config.plan2ProbeMinPmEdge) || 0.04,
    plan2DirectionPmGapLead: Number(config.plan2DirectionPmGapLead) || 0.05,
    plan2MaxEntryElapsedPct5m: Number(config.plan2PaperMaxEntryElapsedPct5m) || 0.88,
    plan2MaxEntryElapsedPct15m: Number(config.plan2PaperMaxEntryElapsedPct15m) || 0.86,
    plan2MinMarketQuality: Number(config.plan2PaperMinMarketQuality) || 0.35,
    plan2ProbeMarketQuality: Number(config.plan2PaperProbeMarketQuality) || 0.28,
    plan2ChopAllowProbe: config.plan2PaperChopAllowProbe !== false,
    plan2SustainedMomentumMinQuality: Number(config.plan2PaperSustainedMomentumMinQuality) || 0.38,
    plan2SustainedMomentumMinDistanceBps5m: Number(config.plan2PaperSustainedMomentumMinDistanceBps5m) || 5,
    plan2SustainedMomentumMinDistanceBps15m: Number(config.plan2PaperSustainedMomentumMinDistanceBps15m) || 5,
    plan2SustainedMomentumMaxPrice5m: Number(config.plan2PaperSustainedMomentumMaxPrice5m) || 0.82,
    plan2SustainedMomentumMaxPrice15m: Number(config.plan2PaperSustainedMomentumMaxPrice15m) || 0.80,
    plan2SettlementCapture90MaxSecondsRemaining5m: Number(config.plan2PaperSettlementCapture90MaxSecondsRemaining5m) || 180,
    plan2SettlementCapture90MaxSecondsRemaining15m: Number(config.plan2PaperSettlementCapture90MaxSecondsRemaining15m) || 240,
    kellyCapEnabled: config.plan2PaperKellyCapEnabled === true,
    _plan2PaperRelaxed: true
  };
}

function resolvePlan2PmLeadingConfidence(directionEntry, sentiment, limitPrice) {
  const price = Number(limitPrice);
  const tech = Number(directionEntry?.confidence);
  const pm = directionEntry?.direction === 'up'
    ? Number(sentiment?.upProbability ?? sentiment?.upPrice)
    : Number(sentiment?.downProbability ?? sentiment?.downPrice);
  if (Number.isFinite(price) && price >= 0.80 && Number.isFinite(pm) && pm > 0) {
    return Math.max(Number.isFinite(tech) ? tech : 0, pm);
  }
  return tech;
}

function resolvePlan2PaperRelaxedTier({ limitPrice, confidence, timeframe, config, sentiment = null, directionEntry = null }) {
  const price = Number(limitPrice);
  const rawConf = Number(confidence);
  const effectiveConf = resolvePlan2PmLeadingConfidence(
    directionEntry || { direction: sentiment ? resolvePolymarketDirection(sentiment).direction : null, confidence: rawConf },
    sentiment,
    price
  );
  const conf = Number.isFinite(effectiveConf) ? effectiveConf : rawConf;
  const minPrice = Number(config.plan2EntryMinPrice) || 0.35;
  const maxPrice = Number(config.plan2EntryMaxPrice) || 0.92;
  const minConf = price >= 0.82
    ? Math.max(0.52, price - 0.03)
    : (Number(config.plan2MinConfidence) || 0.52);
  // ≥82% 区 PM 自证时 edge≈0；靠更低 sizeMultiplier + PAPER_ENTRY_MAX 压负 EV，不在此强制 minEdge。
  const minEdge = price >= 0.82 ? 0 : (Number(config.plan2MinEdge) || 0);
  const edge = computeTradeEdge(conf, price);
  if (!Number.isFinite(price) || price < minPrice || price > maxPrice) return null;
  if (!Number.isFinite(conf) || conf < minConf) return null;
  if (price < 0.82 && (!Number.isFinite(edge) || edge < minEdge)) return null;
  if (price >= 0.82 && Number.isFinite(rawConf) && conf > rawConf) {
    // 高价票置信度来自 PM 价格本身（自证），要求 BTC 距开盘方向确认，否则跳过负 EV 追价。
    const direction = directionEntry?.direction;
    const rawDistanceBps = directionEntry?.distanceBps;
    const distanceBps = rawDistanceBps == null ? NaN : Number(rawDistanceBps);
    if (Number.isFinite(distanceBps) && !btcAlignsWithPlan2Direction(direction, distanceBps)) {
      return null;
    }
  }

  let sizeMultiplier = 1.0;
  // 高价仓位再压一档：均赢 $1–3 vs 均亏 $10–18，薄仓降低 expiry/全损冲击。
  if (price > 0.82) sizeMultiplier = 0.10;
  else if (price > 0.78) sizeMultiplier = 0.20;
  else if (price > 0.72) sizeMultiplier = 0.35;
  else if (price > 0.68) sizeMultiplier = 0.55;

  const tpOffset = Number(config.plan2TakeProfitOffset) || 0.18;
  const slOffset = Number(config.plan2StopLossOffset) || 0.12;
  const exits = buildPlan2ExitPrices(price, config, { takeProfitOffset: tpOffset, stopLossOffset: slOffset });
  return {
    allowed: true,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    sizeMultiplier,
    tier: 'paper_relaxed',
    tierLabel: `模拟盘 tier · 限价 ${(price * 100).toFixed(1)}% · 仓位 ×${sizeMultiplier.toFixed(2)}`
  };
}

function buildPlan2ExitPrices(entryPrice, config, overrides = {}) {
  return computeDynamicExitPrices(entryPrice, {
    takeProfitOffset: Number(config.plan2TakeProfitOffset) || 0.18,
    stopLossOffset: Number(config.plan2StopLossOffset) || 0.12,
    absoluteStopLossFloor: resolveStopLossAbsoluteFloor(config),
    ...overrides
  });
}

import { analyzeWindowTrajectory, applyFiveMinutePathExperiment } from './polymarketWindowTrack.js';



export function buildPlan2DelayedEntryKey(slotIso, timeframe = '15m', symbol = 'BTC-USD', planId = null) {
  const base = `${buildWindowPlanKey(slotIso, timeframe, symbol)}_plan2_delay`;
  const id = planId ? normalizePlan2FamilyId(planId) : null;
  // Include planId so plan2_5 / plan2_6 live delayed queues do not collide.
  return id ? `${base}_${id}` : base;
}



export function resolvePlan2DelayedEntry({

  limitPrice,

  confidence,

  timeframe,

  config,

  marketQuality = null,

  pendingEntry = null,

  now = new Date()

}) {

  const highEntryMin = Number(config.plan2HighEntryMinPrice) || 0.66;

  const timeframeDelayMs = timeframe === '5m'
    ? Number(config.plan2HighEntryDelayMs5m)
    : Number(config.plan2HighEntryDelayMs15m);
  const delayMs = Number.isFinite(timeframeDelayMs) && timeframeDelayMs > 0
    ? timeframeDelayMs
    : (Number(config.plan2HighEntryDelayMs) || 60000);

  const price = Number(limitPrice);

  const nowMs = now.getTime();

  if (config._plan2PaperRelaxed || config._plan2LiveSyncEntry === true) {
    return { phase: 'immediate', pendingEntry: null };
  }



  if (pendingEntry?.executeAfterMs) {

    if (nowMs < pendingEntry.executeAfterMs) {

      return {

        phase: 'waiting',

        pendingEntry,

        waitMs: pendingEntry.executeAfterMs - nowMs

      };

    }



    const tier = resolvePlan2EntryTier({ limitPrice: price, confidence, timeframe, config, marketQuality });

    return {

      phase: tier.allowed ? 'ready' : 'invalid',

      pendingEntry,

      tier

    };

  }



  if (!Number.isFinite(price) || price < highEntryMin) {

    return { phase: 'immediate', pendingEntry: null };

  }



  return {

    phase: 'schedule',

    pendingEntry: {

      executeAfterMs: nowMs + delayMs,

      scheduledAtMs: nowMs,

      initialLimitPrice: price,

      delayMs

    },

    waitMs: delayMs

  };

}



export function resolvePlan2EntryTier({ limitPrice, confidence, timeframe, config, marketQuality = null, paperMode = true, sentiment = null, directionEntry = null }) {
  config = resolvePlan2EffectiveConfig(config, { paperMode });

  const minPrice = Number(config.plan2EntryMinPrice) || 0.35;

  const tpOffset = Number(config.plan2TakeProfitOffset) || 0.18;

  const slOffset = Number(config.plan2StopLossOffset) || 0.12;

  const price = Number(limitPrice);

  const confPct = (Number(confidence) * 100).toFixed(1);

  const pricePct = (price * 100).toFixed(1);



  const tierCheck = evaluateTieredEntry({

    confidence,

    entryPrice: price,

    timeframe,

    config,

    marketQuality,

    minMarketQuality: config.plan2MinMarketQuality,

    minEntryPrice: minPrice,

    maxEntryPrice: Number(config.plan2EntryMaxPrice) || 0.78,

    planLabel: 'Plan2'

  });

  if (!tierCheck.allowed) {
    const paperTier = config._plan2PaperRelaxed
      ? resolvePlan2PaperRelaxedTier({ limitPrice: price, confidence, timeframe, config, sentiment, directionEntry })
      : null;
    if (paperTier) return paperTier;
    return { allowed: false, reason: tierCheck.reason };
  }



  const exits = buildPlan2ExitPrices(price, config, { takeProfitOffset: tpOffset, stopLossOffset: slOffset });

  return {

    allowed: true,

    takeProfitPrice: exits.takeProfitPrice,

    stopLossPrice: exits.stopLossPrice,

    edge: tierCheck.edge,

    sizeMultiplier: tierCheck.sizeMultiplier,

    tier: tierCheck.tierKey,

    tierLabel: `${tierCheck.tierLabel} · 限价 ${pricePct}% · TP +${(tpOffset * 100).toFixed(0)}% · SL -${(slOffset * 100).toFixed(0)}% · 置信 ${confPct}%`

  };

}



export function buildPolymarketPaperPlan2({

  signal,

  sentiment,

  config,

  risk,

  tradingStats = null,

  timeframe = '15m',

  portfolio = null,

  pendingDelayedEntry = null,

  calibrationTable = null,

  lossReasonOrders = null,

  fiveMinuteLock = null,

  fiveMinuteLockStats = null,

  crossSymbolLeader = null,

  paperMode = true,

  paperExperiment = false,

  planId = PLAN2_CLASSIC_ID,

  now = new Date()

}) {
  const resolvedPlanId = normalizePlan2FamilyId(planId);
  const planLabel = plan2FamilyLabel(resolvedPlanId);
  config = resolvePlan2EffectiveConfig(resolvePlan2ProfileConfig(config, resolvedPlanId), { paperMode });

  const slotMinutes = timeframeToSlotMinutes(timeframe);

  const schedule = signal?.schedule || getSlotSchedule(now, slotMinutes);

  const elapsedPct = windowElapsedPct(schedule);

  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';

  const window = {

    key: 'window',

    label: timeframe === '5m' ? '5分钟窗口' : '15分钟窗口'

  };

  const directionEntry = applyCrossSymbolLeaderToDirection(
    buildPlan2DirectionEntry(signal, sentiment, config, { fiveMinuteLock, fiveMinuteLockStats }),
    { crossSymbolLeader, symbol, config }
  );
  const fiveMinuteLockGuard = buildPlan2FiveMinuteLockGuard({
    planDirection: directionEntry?.direction,
    fiveMinuteLock,
    fiveMinuteLockStats,
    config
  });

  let action = choosePlan2Action({

    window,

    directionEntry,

    config,

    risk,

    tradingStats,

    signal,

    sentiment,

    timeframe,

    symbol,

    portfolio,

    pendingDelayedEntry,

    slotIso: schedule.currentSlotIso || null,

    elapsedPct,

    calibrationTable,

    lossReasonOrders,

    fiveMinuteLockGuard,

    planId: resolvedPlanId,

    planLabel,

    now

  });

  const targetTimeIso = signal?.prediction?.targetTimeIso || schedule.nextSlotIso || null;

  const slotIso = schedule.currentSlotIso || null;

  // 本币自身不触发入场时，允许跟随 leader 币（默认 BTC）方向买入更便宜的同向票。
  if (!action?.shouldTrade && !action?.scheduleDelayedEntry) {
    const crossFollow = buildPlan2CrossFollowTier({
      crossSymbolLeader,
      symbol,
      directionEntry,
      sentiment,
      signal,
      timeframe,
      config,
      elapsedPct
    });
    if (crossFollow.allowed) {
      action = buildPlan2TradeAction({
        window,
        directionEntry: crossFollow.directionEntry,
        config,
        tradingStats,
        signal,
        sentiment,
        timeframe,
        portfolio,
        slotIso,
        limitPrice: crossFollow.limitPrice,
        tier: crossFollow,
        pendingDelayedEntry: null,
        entryType: 'cross_follow',
        calibrationTable,
        lossReasonOrders,
        planId: resolvedPlanId,
        planLabel
      });
    }
  }

  // Plan2.6: tighten entry allowlist after Plan2.5 action selection (no behavior change for 2/2.5).
  if (resolvedPlanId === PLAN2_TIGHT_ID || config._plan26PolicyEnabled === true) {
    action = applyPlan26EntryPolicy(action, config, planLabel);
  }

  if (resolvedPlanId === PLAN13_ID) {
    action = applyPlan13EntryPolicy(action, { timeframe, signal, config });
  }

  const trajectoryPath = timeframe === '5m' ? sentiment?.windowTrack?.path || null : null;
  const trajectoryResult = applyFiveMinutePathExperiment(action, trajectoryPath, {
    enabled: paperExperiment && timeframe === '5m' && config.fiveMinutePathExperimentEnabled !== false
  });
  action = trajectoryResult.action;

  return {

    key: `${buildWindowPlanKey(slotIso, timeframe, symbol)}_${resolvedPlanId}`,

    planId: resolvedPlanId,

    algorithm: resolvedPlanId,

    symbol,

    timeframe,

    slotMinutes,

    generatedAtIso: now.toISOString(),

    targetTimeIso,

    slotIso,

    window,

    phase: window,

    elapsedPct: round4(elapsedPct),

    directionEntry,

    fiveMinuteLock,

    fiveMinuteLockStats,

    fiveMinuteLockGuard,

    trajectoryPath,

    trajectoryExperiment: trajectoryResult.evaluation,

    exitRule: {

      takeProfitOffset: Number(config.plan2TakeProfitOffset) || 0.18,

      takeProfitEnabled: config.plan2TakeProfitEnabled !== false && config._plan2Profile !== 'plan13',

      stopLossOffset: Number(config.plan2StopLossOffset) || 0.12,

      trailingTakeProfitEnabled: config._plan2Profile !== 'plan13' && config.plan2TrailingTakeProfitEnabled === true,

      trailingTakeProfitOffset: Number(config.plan2TrailingTakeProfitOffset) || 0.10,

      entryMinPrice: Number(config.plan2EntryMinPrice) || 0.35,

      entryMaxPrice: Number(config.plan2EntryMaxPrice) || 0.78

    },

    action

  };

}



function resolvePlan2BtcDistanceBps(signal) {
  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(startPrice) || startPrice <= 0) return null;
  return ((currentPrice - startPrice) / startPrice) * 10000;
}

/** leader 币（默认 BTC）方向同向时给本币方向判断小幅加成；反向时小幅降权。 */
export function applyCrossSymbolLeaderToDirection(directionEntry, { crossSymbolLeader = null, symbol = null, config = {} } = {}) {
  if (!directionEntry?.direction) return directionEntry;
  if (config.plan2CrossSymbolEnabled === false) return directionEntry;
  const leader = crossSymbolLeader;
  if (!leader || !['up', 'down'].includes(leader.direction)) return directionEntry;
  if (leader.symbol && symbol && leader.symbol === symbol) return directionEntry;
  const minLeaderConf = Number(config.plan2CrossSymbolMinLeaderConfidence) || 0.62;
  const leaderConf = Number(leader.confidence);
  if (!Number.isFinite(leaderConf) || leaderConf < minLeaderConf) return directionEntry;

  const boost = Number(config.plan2CrossSymbolAlignBoost) || 0.02;
  if (directionEntry.direction === leader.direction) {
    return {
      ...directionEntry,
      confidence: round4(Math.min(0.99, Number(directionEntry.confidence) + boost)),
      crossSymbolAligned: true,
      crossSymbolLeader: leader.symbol || null
    };
  }
  return {
    ...directionEntry,
    confidence: round4(Math.max(0.45, Number(directionEntry.confidence) - boost)),
    crossSymbolAligned: false,
    crossSymbolLeader: leader.symbol || null
  };
}

/**
 * 跨币跟随入场：leader 币（默认 BTC）已确认方向且置信足够时，
 * 若本币同方向票价明显更便宜且本币盘口未强烈反向，则小仓买入本币同向票。
 */
export function buildPlan2CrossFollowTier({
  crossSymbolLeader = null,
  symbol = null,
  directionEntry = null,
  sentiment = null,
  signal = null,
  timeframe = '15m',
  config = {},
  elapsedPct = 0
}) {
  if (config.plan2CrossFollowEnabled === false) {
    return { allowed: false, reason: '跨币跟随已关闭。' };
  }
  const leader = crossSymbolLeader;
  if (!leader || !['up', 'down'].includes(leader.direction)) {
    return { allowed: false, reason: '无 leader 方向。' };
  }
  if (leader.symbol && symbol && leader.symbol === symbol) {
    return { allowed: false, reason: 'leader 自身不做跨币跟随。' };
  }
  if (leader.shouldTrade !== true) {
    return { allowed: false, reason: 'leader 本窗口未触发入场。' };
  }
  const leaderEntryType = String(leader.entryType || '').toLowerCase();
  if (['probe', 'opposite_hedge', 'ultra_late_capture', 'settlement_capture_90'].includes(leaderEntryType)) {
    return { allowed: false, reason: `leader 入场类型 ${leaderEntryType} 不触发跨币跟随。` };
  }
  const minLeaderConf = Number(config.plan2CrossFollowMinLeaderConfidence) || 0.64;
  const leaderConf = Number(leader.confidence);
  if (!Number.isFinite(leaderConf) || leaderConf < minLeaderConf) {
    return { allowed: false, reason: `leader 置信 ${(Number(leaderConf) * 100).toFixed(0)}% 低于 ${(minLeaderConf * 100).toFixed(0)}%。` };
  }

  const minElapsed = Number(config.plan2CrossFollowMinElapsedPct) || 0.10;
  const maxElapsed = Number(config.plan2CrossFollowMaxElapsedPct) || 0.72;
  if (elapsedPct < minElapsed || elapsedPct > maxElapsed) {
    return { allowed: false, reason: `跨币跟随只在窗口 ${(minElapsed * 100).toFixed(0)}%-${(maxElapsed * 100).toFixed(0)}% 执行。` };
  }

  const direction = leader.direction;
  const price = Number(direction === 'up' ? sentiment?.upPrice : sentiment?.downPrice);
  const minPrice = Number(config.plan2CrossFollowMinPrice) || 0.40;
  const maxPrice = Number(config.plan2CrossFollowMaxPrice) || 0.85;
  if (!Number.isFinite(price) || price < minPrice || price > maxPrice) {
    return { allowed: false, reason: `跨币跟随限价需在 ${(minPrice * 100).toFixed(0)}%-${(maxPrice * 100).toFixed(0)}%。` };
  }

  // 核心条件：本币同向票要比 leader 票便宜出折扣（BTC UP 70¢ 时 ETH UP 60¢ 才值得跟）。
  const leaderPrice = Number(leader.limitPrice);
  const minDiscount = Number(config.plan2CrossFollowMinDiscount) || 0.04;
  if (Number.isFinite(leaderPrice) && price > leaderPrice - minDiscount) {
    return {
      allowed: false,
      reason: `本币 ${(price * 100).toFixed(1)}¢ 相对 leader ${(leaderPrice * 100).toFixed(1)}¢ 折扣不足 ${(minDiscount * 100).toFixed(0)}¢。`
    };
  }

  // 本币盘口不能强烈反向。
  const upProb = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const downProb = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  const opposingGap = Number.isFinite(upProb) && Number.isFinite(downProb)
    ? (direction === 'up' ? downProb - upProb : upProb - downProb)
    : null;
  const maxOpposingGap = Number(config.plan2CrossFollowMaxOpposingGap) || 0.10;
  if (opposingGap != null && opposingGap > maxOpposingGap) {
    return { allowed: false, reason: `本币盘口反向 gap ${(opposingGap * 100).toFixed(1)}% 超过 ${(maxOpposingGap * 100).toFixed(0)}%。` };
  }

  // 本币自身价格走势不能与 leader 方向明显相反。
  const distanceBps = resolvePlan2BtcDistanceBps(signal);
  const maxReverseDistanceBps = Number(config.plan2CrossFollowMaxReverseDistanceBps) || 6;
  if (Number.isFinite(distanceBps)) {
    const reverseBps = direction === 'up' ? Math.max(0, -distanceBps) : Math.max(0, distanceBps);
    if (reverseBps > maxReverseDistanceBps) {
      return { allowed: false, reason: `本币距开盘反向 ${reverseBps.toFixed(1)} bps 超过 ${maxReverseDistanceBps} bps，不跟。` };
    }
  }

  const quality = Number(sentiment?.qualityScore);
  const minQuality = Number(config.plan2CrossFollowMinQuality) || 0.35;
  if (Number.isFinite(quality) && quality < minQuality) {
    return { allowed: false, reason: `本币市场质量 ${(quality * 100).toFixed(0)}% 低于 ${(minQuality * 100).toFixed(0)}%。` };
  }

  const exits = buildPlan2ExitPrices(price, config);
  const followConfidence = round4(Math.max(
    Number(directionEntry?.direction === direction ? directionEntry?.confidence : 0) || 0,
    leaderConf * 0.92
  ));
  const edge = computeTradeEdge(followConfidence, price);
  const sizeMultiplier = clamp(Number(config.plan2CrossFollowSizeMultiplier), 0.05, 0.6, 0.35);
  return {
    allowed: true,
    limitPrice: price,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    sizeMultiplier,
    tier: 'cross_follow',
    tierLabel: `跨币跟随 tier · ${(leader.symbol || 'BTC-USD').replace('-USD', '')} ${direction.toUpperCase()} ${(Number(leaderPrice) * 100 || 0).toFixed(1)}¢ → 本币 ${(price * 100).toFixed(1)}¢ · 仓位 ×${sizeMultiplier.toFixed(2)}`,
    directionEntry: {
      direction,
      confidence: followConfidence,
      source: 'cross_follow',
      crossSymbolAligned: true,
      crossSymbolLeader: leader.symbol || 'BTC-USD',
      leaderConfidence: round4(leaderConf),
      leaderLimitPrice: Number.isFinite(leaderPrice) ? round4(leaderPrice) : null
    }
  };
}

function btcAlignsWithPlan2Direction(direction, distanceBps, minBps = 1) {
  if (!['up', 'down'].includes(direction) || !Number.isFinite(distanceBps)) return false;
  return direction === 'up' ? distanceBps >= minBps : distanceBps <= -minBps;
}

export function buildPlan2DirectionEntry(signal, sentiment, config = {}, { fiveMinuteLock = null, fiveMinuteLockStats = null } = {}) {
  const rawTechDir = signal?.technicalDirection ?? signal?.direction;
  const techDir = ['up', 'down'].includes(rawTechDir) ? rawTechDir : null;
  const techConf = Number(signal?.technicalConfidence ?? signal?.confidence);
  const compositeDir = ['up', 'down'].includes(signal?.compositeDirection) ? signal.compositeDirection : null;
  const compositeConf = Number(signal?.compositeConfidence);
  const pm = resolvePolymarketDirection(sentiment);
  const pmDir = sentiment?.available ? pm.direction : null;
  const upProb = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const downProb = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  const pmEdge = Number.isFinite(upProb) && Number.isFinite(downProb) ? Math.abs(upProb - downProb) : null;
  const pmGapLead = Number(config.plan2DirectionPmGapLead) || 0.05;
  const techHighConf = Number(config.plan2DirectionTechHighConfidence) || 0.68;
  const compositeMinConf = Number(config.plan2DirectionCompositeMinConfidence) || 0.62;
  const distanceBps = resolvePlan2BtcDistanceBps(signal);

  const meta = {
    pmEdge: pmEdge != null ? round4(pmEdge) : null,
    techDir,
    pmDir,
    distanceBps: distanceBps != null ? round4(distanceBps) : null
  };

  function withTripleAlignBoost(direction, confidence, source) {
    if (pmDir === direction && techDir === direction && btcAlignsWithPlan2Direction(direction, distanceBps)) {
      return {
        direction,
        confidence: round4(Math.min(0.99, confidence + Math.min(0.06, (pmEdge || 0) * 0.3))),
        source: 'triple_align',
        ...meta
      };
    }
    return { direction, confidence: round4(confidence), source, ...meta };
  }

  if (compositeDir && Number.isFinite(compositeConf) && compositeConf >= compositeMinConf) {
    let direction = compositeDir;
    let confidence = compositeConf;
    let source = 'composite';
    if (pmDir && pmDir !== compositeDir && pmEdge != null && pmEdge >= pmGapLead) {
      const techOverride = techDir === compositeDir
        && Number.isFinite(techConf)
        && techConf >= techHighConf
        && btcAlignsWithPlan2Direction(compositeDir, distanceBps);
      if (!techOverride) {
        direction = pmDir;
        confidence = Math.max(pm.probability || 0, compositeConf * 0.95);
        source = 'polymarket_override';
      }
    }
    return applyFiveMinuteLockToPlan2Direction(
      withTripleAlignBoost(direction, confidence, source),
      { fiveMinuteLock, fiveMinuteLockStats, config }
    );
  }

  if (!techDir && !pmDir) return null;

  let direction;
  let confidence;
  let source;
  const pmClear = pmEdge != null && pmEdge >= pmGapLead;
  const techOverride = techDir
    && Number.isFinite(techConf)
    && techConf >= techHighConf
    && btcAlignsWithPlan2Direction(techDir, distanceBps);

  if (techDir && pmDir && techDir !== pmDir) {
    if (pmClear && !techOverride) {
      direction = pmDir;
      confidence = pm.probability || Math.max(upProb, downProb);
      source = 'polymarket';
    } else if (techOverride) {
      direction = techDir;
      confidence = techConf;
      source = 'tech';
    } else {
      direction = pmDir || techDir;
      confidence = pmDir ? (pm.probability || 0.52) : techConf;
      source = pmDir ? 'polymarket_weak' : 'tech';
    }
  } else if (techDir && pmDir) {
    direction = techDir;
    confidence = Math.max(Number.isFinite(techConf) ? techConf : 0, pm.probability || 0);
    source = 'tech_pm_agree';
    return applyFiveMinuteLockToPlan2Direction(
      withTripleAlignBoost(direction, confidence, source),
      { fiveMinuteLock, fiveMinuteLockStats, config }
    );
  } else {
    direction = techDir || pmDir;
    confidence = Number.isFinite(techConf) ? techConf : (pm.probability || 0);
    source = techDir ? 'tech' : 'polymarket';
  }

  return applyFiveMinuteLockToPlan2Direction(
    { direction, confidence: round4(confidence), source, ...meta },
    { fiveMinuteLock, fiveMinuteLockStats, config }
  );
}



function choosePlan2Action({

  window,

  directionEntry,

  config,

  risk,

  tradingStats,

  signal,

  sentiment,

  timeframe,

  symbol = 'BTC-USD',

  portfolio,

  pendingDelayedEntry = null,

  slotIso = null,

  elapsedPct = 0,

  calibrationTable = null,

  lossReasonOrders = null,

  fiveMinuteLockGuard = null,

  planId = PLAN2_CLASSIC_ID,

  planLabel = 'Plan2',

  now = new Date()

}) {
  planId = normalizePlan2FamilyId(planId);
  planLabel = planLabel || plan2FamilyLabel(planId);

  if (!directionEntry) {

    return skip(`${planLabel} 暂无可用方向判断。`);

  }

  const lockGuard = fiveMinuteLockGuard || buildPlan2FiveMinuteLockGuard({
    planDirection: directionEntry.direction,
    fiveMinuteLock: null,
    fiveMinuteLockStats: null,
    config
  });

  function blockByFiveMinuteLock(entryType) {
    const reason = plan2EntryBlockedByFiveMinuteLock(entryType, lockGuard);
    return reason ? skip(`${planLabel} 5m PM 锁定过滤：${reason}`) : null;
  }

  if (!sentiment?.available) {

    return skip(`Polymarket ${timeframe} 市场不可用。`);

  }



  const configuredMinElapsed = Number(config.plan2EntryMinElapsedPct);

  const minElapsedPct = Number.isFinite(configuredMinElapsed) && configuredMinElapsed >= 0
    ? configuredMinElapsed
    : 0.12;

  const configuredMaxElapsed = timeframe === '5m'
    ? Number(config.plan2MaxEntryElapsedPct5m)
    : Number(config.plan2MaxEntryElapsedPct15m);
  const legacyMaxElapsed = Number(config.plan2MaxEntryElapsedPct);
  const maxElapsedPct = Number.isFinite(configuredMaxElapsed) && configuredMaxElapsed > 0
    ? configuredMaxElapsed
    : (Number.isFinite(legacyMaxElapsed) && legacyMaxElapsed > 0 ? legacyMaxElapsed : 0.78);

  if (elapsedPct < minElapsedPct) {

    return skip(`Plan2 窗口前 ${(minElapsedPct * 100).toFixed(0)}% 禁止入场（当前 ${(elapsedPct * 100).toFixed(0)}%）。`);

  }

  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const remainingSeconds = Math.max(0, (1 - Number(elapsedPct || 0)) * slotMinutes * 60);
  const settlementCapture90 = buildPlan2SettlementCapture90Tier({
    directionEntry,
    sentiment,
    signal,
    timeframe,
    config,
    remainingSeconds,
    calibrationTable,
    lossReasonOrders
  });
  if (settlementCapture90.allowed) {
    const lockBlock = blockByFiveMinuteLock('settlement_capture_90');
    if (lockBlock) return lockBlock;
    return buildPlan2TradeAction({
      window,
      directionEntry,
      config,
      tradingStats,
      signal,
      sentiment,
      timeframe,
      portfolio,
      slotIso,
      limitPrice: settlementCapture90.limitPrice,
      tier: settlementCapture90,
      pendingDelayedEntry,
      entryType: 'settlement_capture_90',
      calibrationTable,
      lossReasonOrders,
      planId,
      planLabel
    });
  }

  const earlyLimitPrice = Number(directionEntry.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
  const regimeGuard = buildPlan2RegimeGuard({
    directionEntry,
    sentiment,
    signal,
    timeframe,
    config,
    limitPrice: earlyLimitPrice
  });

  const sustainedMomentum = buildPlan2SustainedMomentumTier({
    directionEntry,
    sentiment,
    signal,
    timeframe,
    config,
    elapsedPct,
    slotIso,
    now
  });
  if (sustainedMomentum.allowed) {
    if (!regimeGuard.allowMain) {
      return skip(`Plan2 持续动量被震荡过滤阻止：${regimeGuard.reason}`);
    }
    const lockBlock = blockByFiveMinuteLock('sustained_momentum');
    if (lockBlock) return lockBlock;
    return buildPlan2TradeAction({
      window,
      directionEntry,
      config,
      tradingStats,
      signal,
      sentiment,
      timeframe,
      portfolio,
      slotIso,
      limitPrice: sustainedMomentum.limitPrice,
      tier: sustainedMomentum,
      pendingDelayedEntry,
      entryType: 'sustained_momentum',
      calibrationTable,
      lossReasonOrders,
      planId,
      planLabel
    });
  }

  if (config._plan2PaperRelaxed) {
    const earlyLateCapture = buildPlan2LateCaptureTier({
      directionEntry,
      sentiment,
      signal,
      timeframe,
      config,
      elapsedPct,
      calibrationTable,
      regimeGuard
    });
    if (earlyLateCapture.allowed) {
      const lockBlock = blockByFiveMinuteLock('late_capture');
      if (lockBlock) return lockBlock;
      return buildPlan2TradeAction({
        window,
        directionEntry,
        config,
        tradingStats,
        signal,
        sentiment,
        timeframe,
        portfolio,
        slotIso,
        limitPrice: earlyLateCapture.limitPrice,
        tier: earlyLateCapture,
        pendingDelayedEntry,
        entryType: 'late_capture',
        calibrationTable,
        lossReasonOrders,
        planId,
        planLabel
      });
    }
  }

  if (elapsedPct > maxElapsedPct) {

    const ultraLateCapture = buildPlan2UltraLateCaptureTier({
      directionEntry,
      sentiment,
      signal,
      timeframe,
      config,
      elapsedPct
    });
    if (ultraLateCapture.allowed) {
      const lockBlock = blockByFiveMinuteLock('ultra_late_capture');
      if (lockBlock) return lockBlock;
      return buildPlan2TradeAction({
        window,
        directionEntry,
        config,
        tradingStats,
        signal,
        sentiment,
        timeframe,
        portfolio,
        slotIso,
        limitPrice: ultraLateCapture.limitPrice,
        tier: ultraLateCapture,
        pendingDelayedEntry,
        entryType: 'ultra_late_capture'
      });
    }

    const lateCapture = buildPlan2LateCaptureTier({
      directionEntry,
      sentiment,
      signal,
      timeframe,
      config,
      elapsedPct,
      calibrationTable,
      regimeGuard
    });
    if (!lateCapture.allowed) {
      return skip(`Plan2 窗口后 ${((1 - maxElapsedPct) * 100).toFixed(0)}% 禁止普通入场（当前 ${(elapsedPct * 100).toFixed(0)}%）。${ultraLateCapture.reason} ${lateCapture.reason}`);
    }
    const lockBlock = blockByFiveMinuteLock('late_capture');
    if (lockBlock) return lockBlock;
    return buildPlan2TradeAction({
      window,
      directionEntry,
      config,
      tradingStats,
      signal,
      sentiment,
      timeframe,
      portfolio,
      slotIso,
      limitPrice: lateCapture.limitPrice,
      tier: lateCapture,
      pendingDelayedEntry,
      entryType: 'late_capture',
      calibrationTable,
      lossReasonOrders,
      planId,
      planLabel
    });

  }



  const limitPrice = Number(directionEntry.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);

  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {

    return skip('Plan2 当前限价无效。');

  }

  const qualityGuard = buildPlan2QualityGuard({
    directionEntry,
    sentiment,
    timeframe,
    config,
    limitPrice
  });
  if (!qualityGuard.allowed) {
    return skip(qualityGuard.reason);
  }
  if (!regimeGuard.allowed) {
    return skip(regimeGuard.reason);
  }
  const combinedQualityScale = clamp(
    qualityGuard.scale * regimeGuard.scale * (lockGuard.scale || 1),
    0.01,
    1,
    1
  );
  const combinedQualityReason = [qualityGuard.reason, regimeGuard.reason, lockGuard.reason].filter(Boolean).join('；');

  if (pendingDelayedEntry?.type === 'probe_upgrade') {
      const upgrade = buildPlan2ProbeUpgradeTier({
        pendingEntry: pendingDelayedEntry,
        directionEntry,
        timeframe,
        sentiment,
        signal,
      config,
      elapsedPct,
      limitPrice,
      qualityScale: combinedQualityScale,
      calibrationTable,
      regimeGuard,
      now
    });
    if (upgrade.phase === 'waiting') {
      return skip(upgrade.reason);
    }
    if (!upgrade.allowed) {
      return {
        ...skip(upgrade.reason),
        clearDelayedEntry: true,
        delayedEntryKey: buildPlan2DelayedEntryKey(slotIso, timeframe, symbol, planId)
      };
    }
    const lockBlock = blockByFiveMinuteLock('main');
    if (lockBlock) return lockBlock;
    return buildPlan2TradeAction({
      window,
      directionEntry,
      config,
      tradingStats,
      signal,
      sentiment,
      timeframe,
      portfolio,
      slotIso,
      limitPrice: upgrade.limitPrice,
      tier: upgrade,
      pendingDelayedEntry,
      entryType: 'main',
      calibrationTable,
      lossReasonOrders,
      planId,
      planLabel
    });
  }

  const probe = buildPlan2ProbeTier({
    directionEntry,
    sentiment,
    signal,
    timeframe,
    config,
    elapsedPct,
    limitPrice,
    qualityScale: combinedQualityScale,
    calibrationTable
  });
  if (probe.allowed) {
    if (!regimeGuard.allowProbe) {
      return skip(`Plan2 市场状态不允许探针：${regimeGuard.reason}`);
    }
    const lockBlock = blockByFiveMinuteLock('probe');
    if (lockBlock) return lockBlock;
    return buildPlan2TradeAction({
      window,
      directionEntry,
      config,
      tradingStats,
      signal,
      sentiment,
      timeframe,
      portfolio,
      slotIso,
      limitPrice: probe.limitPrice,
      tier: probe,
      pendingDelayedEntry,
      entryType: 'probe',
      calibrationTable,
      lossReasonOrders,
      planId,
      planLabel
    });
  }

  if (!regimeGuard.allowMain) {
    return skip(`Plan2 市场状态只允许探针/跳过：${regimeGuard.reason}；${probe.reason || '当前不满足探针条件。'}`);
  }



  const delay = resolvePlan2DelayedEntry({

    limitPrice,

    confidence: directionEntry.confidence,

    timeframe,

    config,

    marketQuality: sentiment.qualityScore,

    pendingEntry: pendingDelayedEntry,

    now

  });



  if (delay.phase === 'schedule') {
    const lockBlock = blockByFiveMinuteLock('standard');
    if (lockBlock) return lockBlock;

    const lateCapture = buildPlan2LateCaptureTier({
      directionEntry,
      sentiment,
      signal,
      timeframe,
      config,
      elapsedPct,
      calibrationTable,
      regimeGuard
    });
    if (lateCapture.allowed) {
      const lateLockBlock = blockByFiveMinuteLock('late_capture');
      if (lateLockBlock) return lateLockBlock;
      return buildPlan2TradeAction({
        window,
        directionEntry,
        config,
        tradingStats,
        signal,
        sentiment,
        timeframe,
        portfolio,
        slotIso,
        limitPrice: lateCapture.limitPrice,
        tier: lateCapture,
        pendingDelayedEntry,
        entryType: 'late_capture',
        calibrationTable,
        lossReasonOrders,
        planId,
        planLabel
      });
    }

    const delaySec = Math.ceil((delay.waitMs || 0) / 1000);

    return {

      shouldTrade: false,

      scheduleDelayedEntry: true,

      delayedEntryKey: buildPlan2DelayedEntryKey(slotIso, timeframe, symbol, planId),

      executeAfterIso: new Date(delay.pendingEntry.executeAfterMs).toISOString(),

      delayMs: delay.pendingEntry.delayMs,

      strategy: directionEntry.source,

      direction: directionEntry.direction,

      label: '延迟入场',

      confidence: directionEntry.confidence,

      usd: 0,

      limitPrice: round4(limitPrice),

      reason: `Plan2 限价 ${(limitPrice * 100).toFixed(1)}% ≥ ${((Number(config.plan2HighEntryMinPrice) || 0.66) * 100).toFixed(0)}%，等待 ${delaySec}s 后重评再入场。`

    };

  }



  if (delay.phase === 'waiting') {

    const waitSec = Math.ceil((delay.waitMs || 0) / 1000);

    return skip(`Plan2 延迟入场等待中，约 ${waitSec}s 后重评（初始 ${(Number(pendingDelayedEntry?.initialLimitPrice || limitPrice) * 100).toFixed(1)}%）。`);

  }



  if (delay.phase === 'invalid') {

    return {

      ...skip(delay.tier?.reason || 'Plan2 延迟结束后条件不再满足，跳过。'),

      clearDelayedEntry: true,

      delayedEntryKey: buildPlan2DelayedEntryKey(slotIso, timeframe, symbol, planId)

    };

  }



  const tier = delay.phase === 'ready'

    ? delay.tier

    : resolvePlan2EntryTier({

      limitPrice,

      confidence: directionEntry.confidence,

      timeframe,

      config,

      marketQuality: null,

      sentiment,

      directionEntry

    });
  const scaledTier = applyPlan2QualityScale(tier, combinedQualityScale, combinedQualityReason);

  if (!scaledTier.allowed) {

    const lateCapture = buildPlan2LateCaptureTier({
      directionEntry,
      sentiment,
      signal,
      timeframe,
      config,
      elapsedPct,
      calibrationTable,
      regimeGuard
    });
    if (!lateCapture.allowed) {
      return skip(`${scaledTier.reason} ${lateCapture.reason}`);
    }
    const lateLockBlock = blockByFiveMinuteLock('late_capture');
    if (lateLockBlock) return lateLockBlock;
    return buildPlan2TradeAction({
      window,
      directionEntry,
      config,
      tradingStats,
      signal,
      sentiment,
      timeframe,
      portfolio,
      slotIso,
      limitPrice: lateCapture.limitPrice,
      tier: lateCapture,
      pendingDelayedEntry,
      entryType: 'late_capture',
      calibrationTable,
      lossReasonOrders,
      planId,
      planLabel
    });

  }

  const lockBlock = blockByFiveMinuteLock('standard');
  if (lockBlock) return lockBlock;

  return buildPlan2TradeAction({
    window,
    directionEntry,
    config,
    tradingStats,
    signal,
    sentiment,
    timeframe,
    portfolio,
    slotIso,
    limitPrice,
    tier: scaledTier,
    pendingDelayedEntry,
    entryType: 'standard',
    calibrationTable,
    lossReasonOrders,
    planId,
    planLabel
  });

}



function buildPlan2TradeAction({

  window,

  directionEntry,

  config,

  tradingStats,

  signal,

  sentiment,

  timeframe,

  portfolio,

  slotIso,

  limitPrice,

  tier,

  pendingDelayedEntry = null,

  entryType = 'standard',

  calibrationTable = null,

  lossReasonOrders = null,

  planId = PLAN2_CLASSIC_ID,

  planLabel = 'Plan2'

}) {
  planId = normalizePlan2FamilyId(planId);
  planLabel = planLabel || plan2FamilyLabel(planId);

  const { takeProfitPrice: tierTakeProfit, stopLossPrice } = tier;

  let takeProfitPrice = tierTakeProfit;
  if (
    directionEntry?.lockAligned
    && directionEntry?.lockStrength === 'strong'
    && config.plan2FiveMinuteLockEnabled !== false
  ) {
    const tpBonus = Number(config.plan2FiveMinuteLockStrongTpOffsetBonus) || 0.02;
    const exits = buildPlan2ExitPrices(limitPrice, config, {
      takeProfitOffset: (Number(config.plan2TakeProfitOffset) || 0.18) + tpBonus,
      stopLossOffset: Number(config.plan2StopLossOffset) || 0.12
    });
    takeProfitPrice = exits.takeProfitPrice;
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

  const minConfidence = resolveTierMinConfidence(timeframe);

  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';
  const basePaperPct = Number(config.plan2PaperOrderPct) || 0.05;
  const activeSymbols = Array.isArray(config.plan2Symbols) && config.plan2Symbols.length
    ? config.plan2Symbols
    : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
  const symbolWr = resolveSymbolWrSizedOrderPct({
    symbol,
    baseOrderPct: basePaperPct,
    activeSymbols,
    winRates: portfolio?.symbolWinRates || tradingStats?.bySymbol || config._symbolWinRates || null,
    config
  });
  const effectivePaperPct = symbolWr.orderPct;

  let sizing;
  if (config._plan2PaperRelaxed) {
    const paperUsd = computePlan2PaperOrderUsd({
      cash: portfolio?.cash,
      config,
      orderPct: effectivePaperPct
    });
    // 与 tier 设计对齐：probe/高价兜底的 sizeMultiplier 必须生效，避免「probe 标签 + 主仓金额」。
    const tierMult = Number(tier?.sizeMultiplier);
    const scaledUsd = Number.isFinite(tierMult) && tierMult > 0 && tierMult < 1
      ? Math.max(Number.isFinite(Number(config.plan2PaperMinOrderUsd)) ? Number(config.plan2PaperMinOrderUsd) : 1, Math.round(paperUsd * tierMult * 100) / 100)
      : paperUsd;
    const minPaperUsd = Number.isFinite(Number(config.plan2PaperMinOrderUsd))
      ? Number(config.plan2PaperMinOrderUsd)
      : 1;
    const basePaperSizing = {
      usd: scaledUsd,
      paperSizing: true,
      orderPct: effectivePaperPct,
      baseOrderPct: basePaperPct,
      symbolWrSizeScale: symbolWr.sizeScale,
      symbolWrRank: symbolWr.rank ?? null,
      minOrderUsd: minPaperUsd,
      availableCash: Number(portfolio?.cash) || 0,
      sizeMultiplier: Number.isFinite(tierMult) ? tierMult : 1
    };
    const confidenceSized = scalePolymarketOrderByConfidence({
      sizing: basePaperSizing,
      confidence: directionEntry.confidence,
      qualityScore: sentiment.qualityScore,
      minConfidence,
      // tierMult has already been applied to scaledUsd above.
      sizeMultiplier: 1,
      cash: portfolio?.cash
    });
    const confidenceUsd = Number(confidenceSized.usd) || 0;
    const availableCash = Number(portfolio?.cash) || 0;
    sizing = {
      ...confidenceSized,
      // A valid paper signal must remain tradable. Confidence changes the
      // amount, while the configured paper minimum is the final floor.
      usd: confidenceUsd > 0 && availableCash >= minPaperUsd
        ? Math.max(minPaperUsd, confidenceUsd)
        : confidenceUsd,
      paperSizing: true,
      sizeMultiplier: basePaperSizing.sizeMultiplier,
      confidenceSizingOnly: true
    };
  } else {
    const baseSizing = computePolymarketOrderUsd({

      equity,

      cash: portfolio?.cash,

      timeframe,

      config

    });
    const wrScale = Number(symbolWr.sizeScale) || 1;
    const wrSizing = {
      ...baseSizing,
      usd: Math.round(((Number(baseSizing.usd) || 0) * wrScale) * 100) / 100,
      orderPct: Math.round(((Number(baseSizing.orderPct) || 0) * wrScale) * 1e4) / 1e4,
      symbolWrSizeScale: symbolWr.sizeScale,
      symbolWrRank: symbolWr.rank ?? null
    };

    sizing = applyKellyCapToSizing(
      scalePolymarketOrderByConfidence({

      sizing: wrSizing,

      confidence: directionEntry.confidence,

      qualityScore: sentiment.qualityScore,

      minConfidence,

      sizeMultiplier: tier.sizeMultiplier,

      cash: portfolio?.cash

      }),
      {
        calibratedConfidence: tier.calibratedConfidence ?? directionEntry.confidence,
        entryPrice: limitPrice,
        equity,
        config
      }
    );
  }

  const usd = sizing.usd;



  if (!portfolio?.portfolioInitialized) {

    return skip('请先在 Plan2 设置初始本金。');

  }

  if (usd < 0.5) {

    return skip('按当前净值计算的买入金额不足 $0.50。');

  }

  if (Number(portfolio.cash) < usd) {

    return skip(`Plan2 可用现金 $${Number(portfolio.cash).toFixed(2)} 不足以买入 $${usd.toFixed(2)}。`);

  }



  const calibrated = resolvePlan2CalibratedEdge({
    rawConfidence: directionEntry.confidence,
    entryPrice: limitPrice,
    planId,
    symbol,
    timeframe,
    direction: directionEntry.direction,
    entryType,
    calibrationTable,
    config
  });
  const edge = tier.edge ?? calibrated.edge ?? computeTradeEdge(calibrated.calibratedConfidence, limitPrice);
  const recoveryGate = evaluatePlan25RecoveryGate({
    symbol,
    timeframe,
    direction: tier.tradeDirection || directionEntry.direction,
    technicalDirection: signal?.technicalDirection,
    spotDirection: signal?.spotDirection,
    entryType,
    entryPrice: limitPrice,
    edge,
    config
  });
  if (!recoveryGate.allowed) return skip(recoveryGate.reason);
  const historyGate = evaluateHistoryWinRateGate({
    rawConfidence: directionEntry.confidence,
    entryPrice: limitPrice,
    planId,
    symbol,
    timeframe,
    direction: directionEntry.direction,
    entryType,
    calibrationTable: calibrationTable || {},
    config,
    planLabel
  });
  if (!historyGate.allowed) return skip(historyGate.reason);
  const lossGate = evaluateLossReasonGate({
    planId,
    timeframe,
    entryType,
    symbol,
    orders: lossReasonOrders,
    config,
    planLabel
  });
  if (!lossGate.allowed) return skip(lossGate.reason);
  let sizedUsd = usd;
  if (Number.isFinite(lossGate.sizeScale) && lossGate.sizeScale < 1 && sizing) {
    const scaled = Math.round(((Number(sizing.usd) || usd) * lossGate.sizeScale) * 100) / 100;
    sizedUsd = Math.max(0, scaled);
    sizing = { ...sizing, usd: sizedUsd, lossReasonSizeScale: lossGate.sizeScale };
    if (sizedUsd < 0.5) return skip('亏损归因降仓后买入金额不足 $0.50。');
    if (Number(portfolio.cash) < sizedUsd) {
      return skip(`${planLabel} 可用现金 ${Number(portfolio.cash).toFixed(2)} 不足以买入 ${sizedUsd.toFixed(2)}。`);
    }
  }
  return {

    shouldTrade: true,

    strategy: directionEntry.source,

    entryType,

    direction: tier.tradeDirection || directionEntry.direction,

    label: (tier.tradeDirection || directionEntry.direction) === 'up' ? '买 UP / 看涨' : '买 DOWN / 看跌',

    confidence: directionEntry.confidence,

    calibratedConfidence: calibrated.calibratedConfidence,

    confidenceCalibrated: calibrated.calibrated,

    edge,

    historyWinRateGate: historyGate.insufficientSamples
      ? { passed: true, insufficientSamples: true, sampleCount: historyGate.sampleCount }
      : { passed: true, sampleCount: historyGate.sampleCount, requiredWinRate: historyGate.requiredWinRate },
    lossReasonGate: lossGate.insufficientSamples
      ? { passed: true, insufficientSamples: true, sampleCount: lossGate.sampleCount }
      : { passed: true, sampleCount: lossGate.sampleCount, lossRate: lossGate.lossRate, sizeScale: lossGate.sizeScale },
    recoveryGate: recoveryGate.enabled
      ? { passed: true, cohort: recoveryGate.cohort, minEdge: recoveryGate.minEdge }
      : null,
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

    usd: sizedUsd,

    sizing,

    limitPrice: round4(limitPrice),

    takeProfitPrice: round4(takeProfitPrice),

    stopLossPrice: round4(stopLossPrice),

    entryTier: tier.tier,

    sizeMultiplier: tier.sizeMultiplier,

    // Include planId so plan2_5 / plan2_6 do not share live lastExecutedKeys / claims.
    executionKey: slotIso
      ? `${buildWindowPlanKey(slotIso, timeframe, signal?.symbol || sentiment?.symbol || 'BTC-USD')}_${planId}_${entryType}`
      : null,

    estimatedClose: Number(signal?.prediction?.estimatedClose) || null,

    startPrice: Number(signal?.prediction?.comparisonBasePrice) || null,

    delayedEntry: Boolean(pendingDelayedEntry?.executeAfterMs),

    delayedEntryKey: pendingDelayedEntry
      ? buildPlan2DelayedEntryKey(slotIso, timeframe, signal?.symbol || sentiment?.symbol || 'BTC-USD', planId)
      : null,

    scheduleProbeUpgrade: entryType === 'probe',

    probeUpgradeAfterMs: entryType === 'probe' ? resolvePlan2ProbeUpgradeMs({ timeframe, config, type: 'min' }) : null,

    probeUpgradeExpiresMs: entryType === 'probe' ? resolvePlan2ProbeUpgradeMs({ timeframe, config, type: 'max' }) : null,

    lateCapture: tier.lateCapture || null,

    windowTrack: tier.windowTrack || null,

    crossSymbolAligned: directionEntry?.crossSymbolAligned ?? null,

    crossSymbolLeader: directionEntry?.crossSymbolLeader || null,

    leaderLimitPrice: directionEntry?.leaderLimitPrice ?? null,

    reason: `${pendingDelayedEntry?.executeAfterMs ? 'Plan2 延迟入场通过，' : ''}${entryType === 'probe' ? 'Plan2 探针小单，' : ''}${entryType === 'main' ? 'Plan2 probe 确认后主仓，' : ''}${entryType === 'sustained_momentum' ? 'Plan2 持续动量加仓，' : ''}${entryType === 'late_capture' ? 'Plan2 尾盘确定性入场，' : ''}${entryType === 'ultra_late_capture' ? 'Plan2 超尾盘 95-99¢ 小仓入场，' : ''}${entryType === 'settlement_capture_90' ? 'Plan2 90-92¢ 结算扫盘，' : ''}${entryType === 'cross_follow' ? 'Plan2 跨币跟随入场，' : ''}方向 ${directionEntry.direction.toUpperCase()}，${tier.tierLabel}，edge ${Number.isFinite(edge) ? (edge * 100).toFixed(1) : '--'}%，tier ×${tier.sizeMultiplier}。${historyText}，买入 $${usd.toFixed(2)}。`

  };

}

function applyPlan2QualityScale(tier, scale = 1, reason = '') {
  if (!tier?.allowed) return tier;
  const normalizedScale = clamp(scale, 0.03, 1, 1);
  if (normalizedScale >= 0.999) return tier;
  return {
    ...tier,
    sizeMultiplier: clamp((Number(tier.sizeMultiplier) || 1) * normalizedScale, 0.01, 1, Number(tier.sizeMultiplier) || 1),
    tierLabel: `${tier.tierLabel} · ${reason || `质量降仓 ×${normalizedScale.toFixed(2)}`}`
  };
}

function buildPlan2QualityGuard({
  directionEntry,
  sentiment,
  timeframe,
  config,
  limitPrice
}) {
  const quality = Number(sentiment?.qualityScore);
  const minQuality = Number(config.plan2MinMarketQuality) || 0.55;
  const probeQuality = Number(config.plan2ProbeMarketQuality) || 0.40;
  let scale = 1;
  const notes = [];
  if (!Number.isFinite(quality) || quality <= 0) {
    if (config._plan2PaperRelaxed) {
      scale *= 0.55;
      notes.push('市场质量缺失，模拟盘降仓 ×0.55');
    }
  } else if (quality < probeQuality) {
    return {
      allowed: false,
      reason: `Plan2 市场质量 ${(quality * 100).toFixed(0)}% 低于探针下限 ${(probeQuality * 100).toFixed(0)}%，跳过低流动性/高噪声盘口。`
    };
  }
  if (Number.isFinite(quality) && quality < minQuality) {
    const qualityScale = quality < 0.50
      ? (Number(config.plan2QualityScaleLow) || 0.35)
      : (Number(config.plan2QualityScaleMid) || 0.60);
    scale *= qualityScale;
    notes.push(`市场质量 ${(quality * 100).toFixed(0)}%，降仓 ×${qualityScale}`);
  }

  const polymarket = resolvePolymarketDirection(sentiment);
  const requireAlignment = config.plan2RequirePolymarketAlignment !== false;
  if (
    requireAlignment
    && polymarket.direction
    && directionEntry.direction
    && polymarket.direction !== directionEntry.direction
  ) {
    const confidence = Number(directionEntry.confidence);
    const edge = computeTradeEdge(confidence, limitPrice);
    if (!Number.isFinite(confidence) || confidence < 0.66 || !Number.isFinite(edge) || edge < 0.06) {
      return {
        allowed: false,
        reason: `Plan2 技术方向 ${directionEntry.direction.toUpperCase()} 与 Polymarket 盘口 ${polymarket.direction.toUpperCase()} 冲突，且技术优势不足以探针。`
      };
    }
    scale *= 0.20;
    notes.push(`技术/盘口冲突，仅强技术探针 ×0.20`);
  }

  const confidence = Number(directionEntry.confidence);
  const edge = computeTradeEdge(confidence, limitPrice);
  const lowPriceGuard = getPlan2LowPriceScale({ limitPrice, confidence, edge });
  if (!lowPriceGuard.allowed) {
    return { allowed: false, reason: lowPriceGuard.reason };
  }
  if (lowPriceGuard.scale < 1) {
    scale *= lowPriceGuard.scale;
    notes.push(lowPriceGuard.reason);
  }

  if (directionEntry.direction === 'down') {
    const downGuard = getPlan2DownScale({ confidence, edge, timeframe, config });
    if (!downGuard.allowed) return { allowed: false, reason: downGuard.reason };
    if (downGuard.scale < 1) {
      scale *= downGuard.scale;
      notes.push(downGuard.reason);
    }
  }

  return { allowed: true, reason: notes.join('；'), scale: clamp(scale, 0.03, 1, 1) };
}

export function buildPlan2RegimeGuard({
  directionEntry,
  sentiment,
  signal,
  timeframe,
  config,
  limitPrice
}) {
  if (config.plan2RegimeFilterEnabled === false) {
    return { allowed: true, allowMain: true, allowProbe: true, isChop: false, scale: 1, reason: '', regime: 'disabled' };
  }

  const reasons = [];
  let noTradeRisk = 0;
  const confidence = Number(directionEntry?.confidence);
  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  const distanceBps = Number.isFinite(currentPrice) && Number.isFinite(startPrice) && currentPrice > 0 && startPrice > 0
    ? ((currentPrice - startPrice) / startPrice) * 10000
    : null;
  const absDistanceBps = distanceBps == null ? null : Math.abs(distanceBps);
  const maxChopDistanceBps = Number(config.plan2ChopMaxDistanceBps) || 4;
  const nearOpen = absDistanceBps != null && absDistanceBps <= maxChopDistanceBps;

  const upProb = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const downProb = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  const pmEdge = Number.isFinite(upProb) && Number.isFinite(downProb) ? Math.abs(upProb - downProb) : null;
  const maxPmEdge = Number(config.plan2ChopMaxPmEdge) || 0.08;
  const pmNearTie = pmEdge != null && pmEdge <= maxPmEdge;

  const pmDirection = resolvePolymarketDirection(sentiment).direction;
  const techPmConflict = Boolean(pmDirection && directionEntry?.direction && pmDirection !== directionEntry.direction);
  const quality = Number(sentiment?.qualityScore);
  const minQuality = Number(config.plan2MinMarketQuality) || 0.55;
  const probeQuality = Number(config.plan2ProbeMarketQuality) || 0.40;
  const spread = Number(sentiment?.spread);
  const maxSpread = Number(config.plan2RegimeMaxSpread) || 0.06;
  const recentVolBps = Number(signal?.indicators?.volatility15mPct) * 10000;
  const maxVolBps = timeframe === '5m'
    ? Number(config.plan2RegimeMaxVolBps5m) || 18
    : Number(config.plan2RegimeMaxVolBps15m) || 14;
  const directionFlipCount = Number(sentiment?.directionFlipCount5m) || 0;
  const minDirectionFlips = Number(config.plan2ChopMinDirectionFlips) || 3;

  if (nearOpen && pmNearTie) {
    noTradeRisk += 2;
    reasons.push(`BTC 距开盘 ${absDistanceBps.toFixed(1)} bps 且 PM 接近50/50`);
  } else if (nearOpen) {
    noTradeRisk += 1;
    reasons.push(`BTC 距开盘仅 ${absDistanceBps.toFixed(1)} bps`);
  }

  if (directionFlipCount >= minDirectionFlips) {
    noTradeRisk += 2;
    reasons.push(`PM 5m 方向翻转 ${directionFlipCount} 次`);
  }

  if (pmNearTie && Number.isFinite(confidence) && confidence < (Number(config.plan2ChopMaxTechConfidence) || 0.62)) {
    noTradeRisk += 1;
    reasons.push(`PM 胶着且技术置信 ${(confidence * 100).toFixed(0)}% 不强`);
  }

  if (techPmConflict) {
    noTradeRisk += 1;
    reasons.push(`技术 ${directionEntry.direction.toUpperCase()} 与 PM ${pmDirection.toUpperCase()} 冲突`);
  }

  const conflictChopProbeBlock = techPmConflict && pmNearTie && nearOpen;
  if (conflictChopProbeBlock) {
    noTradeRisk += 1;
    reasons.push('技术/PM 冲突且盘口胶着近开盘');
  }

  if (Number.isFinite(quality) && quality < probeQuality) {
    noTradeRisk += 2;
    reasons.push(`市场质量 ${(quality * 100).toFixed(0)}% 低于探针线`);
  } else if (Number.isFinite(quality) && quality < minQuality) {
    noTradeRisk += 1;
    reasons.push(`市场质量 ${(quality * 100).toFixed(0)}% 偏低`);
  }

  if (Number.isFinite(spread) && spread > 0.20) {
    noTradeRisk += 2;
    reasons.push(`spread ${(spread * 100).toFixed(1)}% 异常大，盘口疑似失效`);
  } else if (Number.isFinite(spread) && spread > maxSpread) {
    noTradeRisk += 1;
    reasons.push(`spread ${(spread * 100).toFixed(1)}% 偏大`);
  }

  if (Number.isFinite(recentVolBps) && recentVolBps > maxVolBps && pmNearTie) {
    noTradeRisk += 1;
    reasons.push(`短线波动 ${recentVolBps.toFixed(1)} bps 但盘口未出方向`);
  }

  const skipAllRisk = Number(config.plan2RegimeSkipAllRisk) || 4;
  const skipMainRisk = Number(config.plan2RegimeSkipMainRisk) || 3;
  const chopScale = Number(config.plan2ChopMainSizeScale) || 0.20;
  const mildScale = Number(config.plan2RegimeMildSizeScale) || 0.65;
  const reason = reasons.length ? `市场状态过滤 risk=${noTradeRisk}：${reasons.join('；')}` : '';

  if (noTradeRisk >= skipAllRisk) {
    return {
      allowed: false,
      allowMain: false,
      allowProbe: false,
      isChop: true,
      scale: 0,
      reason: `${reason}，跳过本窗口。`,
      regime: 'no_trade',
      noTradeRisk
    };
  }

  if (noTradeRisk >= skipMainRisk) {
    const allowProbe = conflictChopProbeBlock
      ? false
      : (config.plan2ChopAllowProbe !== false);
    return {
      allowed: true,
      allowMain: false,
      allowProbe,
      isChop: true,
      scale: clamp(chopScale, 0.01, 1, 0.20),
      reason: `${reason}${conflictChopProbeBlock ? '，禁止探针。' : '，禁止主仓，只允许小探针。'}`,
      regime: 'chop',
      noTradeRisk
    };
  }

  if (noTradeRisk > 0) {
    const scale = noTradeRisk >= 2 ? clamp(mildScale, 0.05, 1, 0.65) : 1;
    return {
      allowed: true,
      allowMain: true,
      allowProbe: true,
      isChop: false,
      scale,
      reason: scale < 1 ? `${reason}，降仓。` : `${reason}，观察。`,
      regime: 'cautious',
      noTradeRisk
    };
  }

  return {
    allowed: true,
    allowMain: true,
    allowProbe: true,
    isChop: false,
    scale: 1,
    reason: '',
    regime: 'normal',
    noTradeRisk: 0
  };
}

function getPlan2LowPriceScale({ limitPrice, confidence, edge }) {
  const price = Number(limitPrice);
  if (!Number.isFinite(price) || price >= 0.55) {
    return { allowed: true, scale: 1, reason: null };
  }
  if (price < 0.48) {
    if (confidence >= 0.67 && edge >= 0.12) {
      return { allowed: true, scale: 0.35, reason: `低价票 ${(price * 100).toFixed(1)}%，强优势探针 ×0.35` };
    }
    return { allowed: false, reason: `低价票 ${(price * 100).toFixed(1)}% 低于 48%，需要置信 ≥67%、edge ≥12%。` };
  }
  if (confidence >= 0.66 && edge >= 0.10) {
    return { allowed: true, scale: 0.80, reason: `低价票 ${(price * 100).toFixed(1)}%，强优势降仓 ×0.80` };
  }
  if (confidence >= 0.62 && edge >= 0.05) {
    return { allowed: true, scale: 0.45, reason: `低价票 ${(price * 100).toFixed(1)}%，中等优势降仓 ×0.45` };
  }
  if (confidence >= 0.58 && edge >= 0.02) {
    return { allowed: true, scale: 0.18, reason: `低价票 ${(price * 100).toFixed(1)}%，仅探针 ×0.18` };
  }
  return { allowed: false, reason: `低价票 ${(price * 100).toFixed(1)}% 优势不足，跳过。` };
}

function getPlan2DownScale({ confidence, edge, timeframe, config }) {
  const baseConf = Number(config.plan2MinConfidence) || 0.64;
  const fullConf = timeframe === '5m'
    ? Number(config.plan2DownMinConfidence5m) || baseConf
    : Number(config.plan2DownMinConfidence15m) || baseConf;
  const fullEdge = Math.max(Number(config.plan2MinEdge) || 0.06, Number(config.plan2DownMinEdge) || 0.04);
  if (confidence >= fullConf && edge >= fullEdge) {
    return { allowed: true, scale: 1, reason: null };
  }
  if (confidence >= fullConf - 0.01 && edge >= fullEdge * 0.75) {
    return { allowed: true, scale: 0.50, reason: `DOWN 降仓观察 ×0.50` };
  }
  if (confidence >= fullConf - 0.02 && edge >= fullEdge * 0.60) {
    return { allowed: true, scale: 0.20, reason: `DOWN 仅探针 ×0.20` };
  }
  return {
    allowed: false,
    reason: `Plan2 DOWN 方向要求至少置信 ≥ ${((fullConf - 0.02) * 100).toFixed(0)}%、edge ≥ ${(fullEdge * 0.60 * 100).toFixed(1)}%。`
  };
}

function buildPlan2ProbeTier({
  directionEntry,
  sentiment,
  signal,
  timeframe,
  config,
  elapsedPct,
  limitPrice,
  qualityScale = 1,
  calibrationTable = null
}) {
  if (config.plan2ProbeEnabled === false) return { allowed: false, reason: '探针入场已关闭。' };
  if (config.liveTradingEnabled === true && config.plan2LiveProbeEnabled !== true && !config._plan2PaperRelaxed) {
    return { allowed: false, reason: '实盘探针小单已关闭（仅模拟盘保留探针）。' };
  }
  const price = Number(limitPrice);
  const minPrice = Number(config.plan2ProbeMinPrice) || 0.48;
  const maxPrice = Number(config.plan2ProbeMaxPrice) || 0.62;
  const minElapsed = Number(config.plan2ProbeMinElapsedPct) || 0.08;
  const maxElapsed = Number(config.plan2ProbeMaxElapsedPct) || 0.55;
  if (elapsedPct < minElapsed || elapsedPct > maxElapsed) {
    return { allowed: false, reason: `探针只在窗口 ${(minElapsed * 100).toFixed(0)}%-${(maxElapsed * 100).toFixed(0)}% 执行。` };
  }
  if (!Number.isFinite(price) || price < minPrice || price > maxPrice) {
    return { allowed: false, reason: `探针限价需在 ${(minPrice * 100).toFixed(0)}%-${(maxPrice * 100).toFixed(0)}%。` };
  }
  const upProb = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const downProb = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  const pmEdge = Number.isFinite(upProb) && Number.isFinite(downProb) ? Math.abs(upProb - downProb) : null;
  const minPmEdge = Number(config.plan2ProbeMinPmEdge) || 0.04;
  const pmDir = resolvePolymarketDirection(sentiment).direction;
  const distanceBps = resolvePlan2BtcDistanceBps(signal);
  const pmSupportsDirection = pmDir === directionEntry.direction && pmEdge != null && pmEdge >= minPmEdge;
  const btcSupportsDirection = btcAlignsWithPlan2Direction(directionEntry.direction, distanceBps);
  if (!pmSupportsDirection && !btcSupportsDirection) {
    return {
      allowed: false,
      reason: `探针需 PM edge ≥ ${(minPmEdge * 100).toFixed(0)}% 且方向一致，或 BTC 距开盘与 ${directionEntry.direction.toUpperCase()} 对齐。`
    };
  }
  const confidence = Number(directionEntry.confidence);
  const calibrated = resolvePlan2CalibratedEdge({
    rawConfidence: confidence,
    entryPrice: price,
    planId: config._plan2Profile,
    symbol: signal?.symbol,
    timeframe,
    direction: directionEntry.direction,
    entryType: 'probe',
    calibrationTable,
    config
  });
  const edge = calibrated.edge ?? computeTradeEdge(confidence, price);
  const minConfidence = Number(config.plan2ProbeMinConfidence) || 0.56;
  const minEdge = Number(config.plan2ProbeMinEdge) || 0.005;
  if (!Number.isFinite(confidence) || confidence < minConfidence || !Number.isFinite(edge) || edge < minEdge) {
    return { allowed: false, reason: `探针要求置信 ≥ ${(minConfidence * 100).toFixed(0)}%、edge ≥ ${(minEdge * 100).toFixed(1)}%。` };
  }
  const historicalGate = evaluatePlan2ProbeHistoricalEdge({
    calibrationTable,
    planId: config._plan2Profile,
    symbol: signal?.symbol,
    timeframe,
    direction: directionEntry.direction,
    entryPrice: price,
    config
  });
  if (!historicalGate.allowed) return historicalGate;
  const probeSlOffset = timeframe === '5m'
    ? Number(config.plan2ProbeStopLossOffset5m)
    : Number(config.plan2ProbeStopLossOffset15m);
  const stopLossOffset = Number.isFinite(probeSlOffset) && probeSlOffset > 0
    ? probeSlOffset
    : (Number(config.plan2StopLossOffset) || 0.12);
  const exits = buildPlan2ExitPrices(price, config, {
    takeProfitOffset: Number(config.plan2TakeProfitOffset) || 0.18,
    stopLossOffset
  });
  const timeframeBase = timeframe === '5m'
    ? Number(config.plan2ProbeSizeMultiplier5m)
    : Number(config.plan2ProbeSizeMultiplier15m);
  const base = (Number.isFinite(timeframeBase) && timeframeBase > 0)
    ? timeframeBase
    : (Number(config.plan2ProbeSizeMultiplier) || 0.18);
  const sizeMultiplier = clamp(base * (Number(qualityScale) || 1), 0.01, 0.65, 0.32);
  return {
    allowed: true,
    limitPrice: price,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    calibratedConfidence: calibrated.calibratedConfidence,
    historicalEdge: historicalGate,
    sizeMultiplier,
    tier: 'probe',
    tierLabel: `探针 tier · 限价 ${(price * 100).toFixed(1)}% · 仓位 ×${sizeMultiplier.toFixed(2)}`
  };
}

export function evaluatePlan2ProbeHistoricalEdge({
  calibrationTable = {},
  planId = null,
  symbol = null,
  timeframe = '15m',
  direction = null,
  entryPrice,
  config = {}
} = {}) {
  if (config.plan2ProbeHistoricalEdgeGateEnabled === false) {
    return { allowed: true, disabled: true };
  }
  const targetPlanId = planId || config._plan2Profile || null;
  const targetSymbol = symbol || null;
  const timeframeRows = Object.values(calibrationTable || {}).filter((row) => (
    row?.entryType === 'probe'
    && (!targetPlanId || row?.planId === String(targetPlanId).toLowerCase())
    && (!targetSymbol || row?.symbol === String(targetSymbol).toUpperCase())
    && row?.timeframe === timeframe
  ));
  const directionRows = timeframeRows.filter((row) => !direction || row?.direction === direction);
  const directionSamples = directionRows.reduce((sum, row) => sum + (Number(row.sampleCount) || 0), 0);
  const minSamples = Math.max(1, Number(config.plan2ProbeHistoricalEdgeMinSamples) || 20);
  const rows = directionSamples >= minSamples ? directionRows : timeframeRows;
  const scope = rows === directionRows ? 'direction' : 'timeframe';
  const sampleCount = rows.reduce((sum, row) => sum + (Number(row.sampleCount) || 0), 0);
  const wins = rows.reduce((sum, row) => sum + (Number(row.wins) || 0), 0);
  if (sampleCount < minSamples) {
    return { allowed: true, insufficientSamples: true, sampleCount, minSamples, scope };
  }
  const empiricalWinRate = wins / sampleCount;
  const margin = Math.max(0, Number(config.plan2ProbeHistoricalEdgeMargin) || 0.01);
  const requiredWinRate = Number(entryPrice) + margin;
  if (empiricalWinRate < requiredWinRate) {
    return {
      allowed: false,
      sampleCount,
      wins,
      empiricalWinRate: round4(empiricalWinRate),
      requiredWinRate: round4(requiredWinRate),
      scope,
      reason: `Plan2 ${timeframe} 探针历史胜率 ${(empiricalWinRate * 100).toFixed(1)}%（${wins}/${sampleCount}）低于当前买价 ${(Number(entryPrice) * 100).toFixed(1)}% + ${(margin * 100).toFixed(1)}% 安全边际。`
    };
  }
  return {
    allowed: true,
    sampleCount,
    wins,
    empiricalWinRate: round4(empiricalWinRate),
    requiredWinRate: round4(requiredWinRate),
    scope
  };
}

function resolvePlan2ProbeUpgradeMs({ timeframe, config, type }) {
  const value = type === 'min'
    ? (timeframe === '5m' ? Number(config.plan2ProbeUpgradeMinMs5m) : Number(config.plan2ProbeUpgradeMinMs15m))
    : (timeframe === '5m' ? Number(config.plan2ProbeUpgradeMaxMs5m) : Number(config.plan2ProbeUpgradeMaxMs15m));
  const fallback = type === 'min'
    ? (Number(config.plan2ProbeUpgradeMinMs) || 10000)
    : (Number(config.plan2ProbeUpgradeMaxMs) || 35000);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolvePlan2CalibratedEdge({
  rawConfidence,
  entryPrice,
  planId = null,
  symbol = null,
  timeframe,
  direction,
  entryType,
  calibrationTable,
  config
}) {
  return resolveCalibratedEdge({
    rawConfidence,
    entryPrice,
    planId: planId || config?._plan2Profile || 'plan2_5',
    symbol,
    timeframe,
    direction,
    entryType,
    calibrationTable: calibrationTable || {},
    config
  });
}

function normalizeUpdateComponent(value, scale = 0.05) {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isFinite(scale) || scale <= 0) return 0;
  return clamp(num / scale, 0, 1);
}

export function computeProbeUpdateScore({
  probePrice,
  currentPrice,
  probeConfidence,
  currentConfidence,
  probeDistanceBps = null,
  currentDistanceBps = null,
  pmStabilityScore = 0.5,
  reverseMoveScore = 0,
  spreadWidenScore = 0,
  config = {}
}) {
  const priceMove = normalizeUpdateComponent(Number(currentPrice) - Number(probePrice), Number(config.plan2ProbeUpdatePriceScale) || 0.05);
  const confidenceDelta = normalizeUpdateComponent(Number(currentConfidence) - Number(probeConfidence), Number(config.plan2ProbeUpdateConfidenceScale) || 0.08);
  const distanceDelta = Number.isFinite(Number(currentDistanceBps)) && Number.isFinite(Number(probeDistanceBps))
    ? normalizeUpdateComponent(Number(currentDistanceBps) - Number(probeDistanceBps), Number(config.plan2ProbeUpdateDistanceScale) || 8)
    : 0;
  const stability = clamp(Number(pmStabilityScore), 0, 1, 0.5);
  const reverse = clamp(Number(reverseMoveScore), 0, 1, 0);
  const spread = clamp(Number(spreadWidenScore), 0, 1, 0);

  const score = round4(
    0.35 * priceMove
    + 0.25 * confidenceDelta
    + 0.20 * distanceDelta
    + 0.20 * stability
    - 0.30 * reverse
    - 0.20 * spread
  );
  return {
    score,
    components: {
      priceMove,
      confidenceDelta,
      distanceDelta,
      stability,
      reverse,
      spread
    }
  };
}

function buildPlan2ProbeUpgradeTier({
  pendingEntry,
  directionEntry,
  timeframe,
  sentiment,
  signal,
  config,
  elapsedPct,
  limitPrice,
  qualityScale = 1,
  calibrationTable = null,
  regimeGuard = null,
  now = new Date()
}) {
  if (timeframe === '5m' && config.plan2ProbeUpgradeEnabled5m === false) {
    return { allowed: false, reason: 'Plan2 5m 暂停 probe 后追加主仓。' };
  }
  if (regimeGuard && regimeGuard.allowMain === false) {
    return { allowed: false, reason: `Plan2 探针确认被震荡过滤阻止：${regimeGuard.reason || '禁止主仓升级。'}` };
  }
  const nowMs = now.getTime();
  if (nowMs < Number(pendingEntry?.executeAfterMs || 0)) {
    const waitSec = Math.max(1, Math.ceil((Number(pendingEntry.executeAfterMs) - nowMs) / 1000));
    return { phase: 'waiting', allowed: false, reason: `Plan2 探针确认等待中，约 ${waitSec}s 后重评。` };
  }
  if (Number(pendingEntry?.expiresAtMs) && nowMs > Number(pendingEntry.expiresAtMs)) {
    return { allowed: false, reason: 'Plan2 探针确认超时，取消追加主仓。' };
  }
  if (pendingEntry?.direction && directionEntry.direction !== pendingEntry.direction) {
    return { allowed: false, reason: `Plan2 探针后方向从 ${pendingEntry.direction.toUpperCase()} 切到 ${directionEntry.direction.toUpperCase()}，取消追加。` };
  }
  const price = Number(limitPrice);
  const probePrice = Number(pendingEntry?.probePrice ?? pendingEntry?.initialLimitPrice);
  const minMove = Number(config.plan2ProbeUpgradeMinPriceMove) || 0.025;
  const useUpdateScore = config.plan2ProbeUpdateScoreEnabled !== false;
  if (useUpdateScore) {
    const currentPrice = Number(signal?.indicators?.currentPrice);
    const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
    const currentDistanceBps = Number.isFinite(currentPrice) && Number.isFinite(startPrice) && startPrice > 0
      ? ((currentPrice - startPrice) / startPrice) * 10000
      : null;
    const probeDistanceBps = Number(pendingEntry?.distanceFromOpenBpsAtProbe ?? pendingEntry?.distanceFromOpenBps);
    const return3Bps = Number(signal?.indicators?.return3Pct) * 10000;
    const reverseBps = directionEntry.direction === 'up' ? Math.max(0, -return3Bps) : Math.max(0, return3Bps);
    const reverseMoveScore = normalizeUpdateComponent(reverseBps, Number(config.plan2LateCaptureMaxReverseBps) || 3);
    const probeSpread = Number(pendingEntry?.spreadAtProbe);
    const currentSpread = Number(sentiment?.spread);
    const spreadWidenScore = Number.isFinite(probeSpread) && Number.isFinite(currentSpread)
      ? normalizeUpdateComponent(Math.max(0, currentSpread - probeSpread), 0.03)
      : 0;
    const update = computeProbeUpdateScore({
      probePrice,
      currentPrice: price,
      probeConfidence: Number(pendingEntry?.confidenceAtProbe),
      currentConfidence: Number(directionEntry.confidence),
      probeDistanceBps,
      currentDistanceBps,
      pmStabilityScore: Number(sentiment?.qualityScore) || 0.5,
      reverseMoveScore,
      spreadWidenScore,
      config
    });
    const minScore = Number(config.plan2ProbeUpdateScoreMin) || 0.65;
    if (update.score < minScore) {
      return {
        allowed: false,
        reason: `Plan2 探针更新分数 ${update.score.toFixed(2)} 低于 ${minScore.toFixed(2)}（价格 ${(price * 100).toFixed(1)}% / 探针 ${Number.isFinite(probePrice) ? (probePrice * 100).toFixed(1) : '--'}%）。`
      };
    }
  } else if (!Number.isFinite(price) || !Number.isFinite(probePrice) || price < probePrice + minMove) {
    return { allowed: false, reason: `Plan2 探针确认要求 token 至少正向 +${(minMove * 100).toFixed(1)}¢。` };
  }
  const maxPrice = Number(config.plan2ProbeUpgradeMaxPrice) || 0.72;
  if (price > maxPrice) {
    return { allowed: false, reason: `Plan2 探针确认限价 ${(price * 100).toFixed(1)}% 高于 ${(maxPrice * 100).toFixed(0)}%。` };
  }
  const maxElapsed = Number(config.plan2ProbeUpgradeMaxElapsedPct) || 0.70;
  if (elapsedPct > maxElapsed) {
    return { allowed: false, reason: `Plan2 探针确认超过窗口 ${(maxElapsed * 100).toFixed(0)}%，取消追加。` };
  }
  const confidence = Number(directionEntry.confidence);
  const probeConfidence = Number(pendingEntry?.confidenceAtProbe);
  if (Number.isFinite(probeConfidence) && confidence < probeConfidence) {
    return { allowed: false, reason: `Plan2 探针后置信度从 ${(probeConfidence * 100).toFixed(0)}% 降到 ${(confidence * 100).toFixed(0)}%，取消追加。` };
  }
  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (Number.isFinite(currentPrice) && Number.isFinite(startPrice) && startPrice > 0) {
    const distanceBps = ((currentPrice - startPrice) / startPrice) * 10000;
    const expectedDirection = distanceBps >= 0 ? 'up' : 'down';
    if (expectedDirection !== directionEntry.direction) {
      return { allowed: false, reason: `Plan2 探针后 BTC 与窗口开盘价方向不一致（${distanceBps.toFixed(1)} bps）。` };
    }
  }
  const return3Bps = Number(signal?.indicators?.return3Pct) * 10000;
  const reverseBps = directionEntry.direction === 'up' ? Math.max(0, -return3Bps) : Math.max(0, return3Bps);
  const maxReverseBps = Number(config.plan2LateCaptureMaxReverseBps) || 3;
  if (Number.isFinite(reverseBps) && reverseBps > maxReverseBps) {
    return { allowed: false, reason: `Plan2 探针后最近反向波动 ${reverseBps.toFixed(1)} bps 超过 ${maxReverseBps} bps。` };
  }

  const exits = buildPlan2ExitPrices(price, config);
  const calibrated = resolvePlan2CalibratedEdge({
    rawConfidence: Number(directionEntry.confidence),
    entryPrice: price,
    planId: config._plan2Profile,
    symbol: signal?.symbol,
    timeframe,
    direction: directionEntry.direction,
    entryType: 'probe_main',
    calibrationTable,
    config
  });
  const edge = calibrated.edge ?? computeTradeEdge(calibrated.calibratedConfidence, price);
  const base = Number(config.plan2ProbeUpgradeSizeMultiplier) || 0.85;
  const sizeMultiplier = clamp(base * (Number(qualityScale) || 1), 0.05, 1.25, 1.10);
  return {
    allowed: true,
    limitPrice: price,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    sizeMultiplier,
    tier: 'probe_main',
    tierLabel: `探针确认主仓 · 探针 ${(probePrice * 100).toFixed(1)}% -> ${(price * 100).toFixed(1)}% · 仓位 ×${sizeMultiplier.toFixed(2)}`
  };
}

function resolvePolymarketDirection(sentiment) {
  const up = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const down = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up <= 0 || down <= 0) {
    return { direction: null, probability: null };
  }
  return up >= down
    ? { direction: 'up', probability: up }
    : { direction: 'down', probability: down };
}


function buildPlan2SustainedMomentumTier({
  directionEntry,
  sentiment,
  signal,
  timeframe,
  config,
  elapsedPct,
  slotIso,
  now = new Date()
}) {
  if (config.plan2SustainedMomentumEnabled === false) {
    return { allowed: false, reason: '持续动量入场已关闭。' };
  }
  if (!slotIso) {
    return { allowed: false, reason: '持续动量入场缺少窗口 slot。' };
  }

  const windowTrack = analyzeWindowTrajectory({
    slotIso,
    timeframe,
    symbol: signal?.symbol || sentiment?.symbol || 'BTC-USD',
    direction: directionEntry.direction,
    config,
    now
  });
  if (!windowTrack.sustained) {
    return {
      allowed: false,
      reason: '持续动量条件未满足（阈值、回撤、样本或持仓时长不足）。',
      windowTrack
    };
  }

  const minPrice = timeframe === '5m'
    ? Number(config.plan2SustainedMomentumMinPrice5m) || 0.72
    : Number(config.plan2SustainedMomentumMinPrice15m) || 0.70;
  const maxPrice = timeframe === '5m'
    ? Number(config.plan2SustainedMomentumMaxPrice5m) || 0.88
    : Number(config.plan2SustainedMomentumMaxPrice15m) || 0.85;
  const minElapsed = timeframe === '5m'
    ? Number(config.plan2SustainedMomentumMinElapsedPct5m) || 0.25
    : Number(config.plan2SustainedMomentumMinElapsedPct15m) || 0.20;
  const maxElapsed = timeframe === '5m'
    ? Number(config.plan2SustainedMomentumMaxElapsedPct5m) || 0.72
    : Number(config.plan2SustainedMomentumMaxElapsedPct15m) || 0.74;

  const limitPrice = Number(directionEntry.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
  if (!Number.isFinite(limitPrice) || limitPrice < minPrice || limitPrice > maxPrice) {
    return {
      allowed: false,
      reason: `持续动量限价需在 ${(minPrice * 100).toFixed(0)}%-${(maxPrice * 100).toFixed(0)}%（当前 ${Number.isFinite(limitPrice) ? (limitPrice * 100).toFixed(1) : '--'}%）。`,
      windowTrack
    };
  }
  if (elapsedPct < minElapsed || elapsedPct > maxElapsed) {
    return {
      allowed: false,
      reason: `持续动量要求窗口进度 ${(minElapsed * 100).toFixed(0)}%-${(maxElapsed * 100).toFixed(0)}%（当前 ${(elapsedPct * 100).toFixed(0)}%）。`,
      windowTrack
    };
  }

  const quality = Number(sentiment.qualityScore);
  const minQuality = Number(config.plan2SustainedMomentumMinQuality) || 0.55;
  if (Number.isFinite(quality) && quality < minQuality) {
    return {
      allowed: false,
      reason: `持续动量市场质量 ${(quality * 100).toFixed(0)}% 低于 ${(minQuality * 100).toFixed(0)}%。`,
      windowTrack
    };
  }

  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(startPrice) || currentPrice <= 0 || startPrice <= 0) {
    return { allowed: false, reason: '持续动量缺少 BTC 当前价或窗口开盘价。', windowTrack };
  }

  const distanceBps = ((currentPrice - startPrice) / startPrice) * 10000;
  const expectedDirection = distanceBps >= 0 ? 'up' : 'down';
  const absDistanceBps = Math.abs(distanceBps);
  const minDistanceBps = timeframe === '5m'
    ? Number(config.plan2SustainedMomentumMinDistanceBps5m) || 10
    : Number(config.plan2SustainedMomentumMinDistanceBps15m) || 8;
  if (expectedDirection !== directionEntry.direction) {
    return {
      allowed: false,
      reason: `持续动量方向与开盘价距离不一致（BTC ${distanceBps.toFixed(1)} bps）。`,
      windowTrack
    };
  }
  if (absDistanceBps < minDistanceBps) {
    return {
      allowed: false,
      reason: `持续动量要求距离开盘价 ≥ ${minDistanceBps} bps（当前 ${absDistanceBps.toFixed(1)} bps）。`,
      windowTrack
    };
  }

  const return3Bps = Number(signal?.indicators?.return3Pct) * 10000;
  const reverseBps = directionEntry.direction === 'up' ? Math.max(0, -return3Bps) : Math.max(0, return3Bps);
  const maxReverseBps = timeframe === '5m'
    ? Number(config.plan2SustainedMomentumMaxReverseBps5m) || 4
    : Number(config.plan2SustainedMomentumMaxReverseBps15m) || 5;
  if (Number.isFinite(reverseBps) && reverseBps > maxReverseBps) {
    return {
      allowed: false,
      reason: `持续动量最近反向波动 ${reverseBps.toFixed(1)} bps 超过 ${maxReverseBps} bps。`,
      windowTrack
    };
  }

  const tpOffset = Number(config.plan2TakeProfitOffset) || 0.18;
  const slOffset = Number(config.plan2StopLossOffset) || 0.12;
  const exits = buildPlan2ExitPrices(limitPrice, config, { takeProfitOffset: tpOffset, stopLossOffset: slOffset });
  const sizeMultiplier = clamp(
    timeframe === '5m'
      ? Number(config.plan2SustainedMomentumSizeMultiplier5m)
      : Number(config.plan2SustainedMomentumSizeMultiplier15m),
    0.01,
    2,
    timeframe === '5m' ? 1.35 : 1.25
  );
  const confidence = Number(directionEntry.confidence);
  const edge = computeTradeEdge(confidence, limitPrice);

  return {
    allowed: true,
    limitPrice,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    sizeMultiplier,
    tier: 'sustained_momentum',
    tierLabel: `持续动量 tier · 限价 ${(limitPrice * 100).toFixed(1)}% · 峰值回撤 ${windowTrack.pullbackFromPeak != null ? (windowTrack.pullbackFromPeak * 100).toFixed(1) : '--'}¢ · 距开盘 ${absDistanceBps.toFixed(1)} bps`,
    windowTrack
  };
}


function resolvePlan2BandEntry({
  directionEntry,
  sentiment,
  signal,
  minPrice,
  maxPrice,
  usePmLeadingPrice = true
}) {
  const upPrice = Number(sentiment.upPrice);
  const downPrice = Number(sentiment.downPrice);
  const directionalPrice = directionEntry.direction === 'up' ? upPrice : downPrice;

  if (Number.isFinite(directionalPrice) && directionalPrice >= minPrice && directionalPrice <= maxPrice) {
    return {
      direction: directionEntry.direction,
      limitPrice: directionalPrice,
      priceSource: 'directional'
    };
  }

  if (!usePmLeadingPrice) return null;

  const candidates = [
    { direction: 'up', limitPrice: upPrice },
    { direction: 'down', limitPrice: downPrice }
  ].filter((item) => Number.isFinite(item.limitPrice) && item.limitPrice >= minPrice && item.limitPrice <= maxPrice);
  if (!candidates.length) return null;

  const leading = candidates.sort((a, b) => b.limitPrice - a.limitPrice)[0];
  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(startPrice) || startPrice <= 0) {
    return { ...leading, priceSource: 'pm_leading' };
  }

  const distanceBps = ((currentPrice - startPrice) / startPrice) * 10000;
  const expectedDirection = distanceBps >= 0 ? 'up' : 'down';
  if (leading.direction !== expectedDirection) return null;

  return { ...leading, priceSource: 'pm_leading' };
}

function buildPlan2SettlementCapture90Tier({
  directionEntry,
  sentiment,
  signal,
  timeframe,
  config,
  remainingSeconds,
  calibrationTable = null
}) {
  if (config.plan2SettlementCapture90Enabled === false) {
    return { allowed: false, reason: '90-92¢ 结算扫盘已关闭。' };
  }

  const minSeconds = timeframe === '5m'
    ? Number(config.plan2SettlementCapture90MinSecondsRemaining5m) || 3
    : Number(config.plan2SettlementCapture90MinSecondsRemaining15m) || 5;
  const maxSeconds = timeframe === '5m'
    ? Number(config.plan2SettlementCapture90MaxSecondsRemaining5m) || 120
    : Number(config.plan2SettlementCapture90MaxSecondsRemaining15m) || 180;
  const sec = Number(remainingSeconds);
  if (!Number.isFinite(sec) || sec < minSeconds || sec > maxSeconds) {
    return {
      allowed: false,
      reason: `90-92¢ 结算扫盘只在剩余 ${minSeconds}-${maxSeconds}s 执行（当前 ${Number.isFinite(sec) ? sec.toFixed(0) : '--'}s）。`
    };
  }

  const minPrice = Number(config.plan2SettlementCapture90MinPrice) || 0.90;
  const maxPrice = Number(config.plan2SettlementCapture90MaxPrice) || 0.92;
  const bandEntry = resolvePlan2BandEntry({
    directionEntry,
    sentiment,
    signal,
    minPrice,
    maxPrice,
    usePmLeadingPrice: config.plan2SettlementCapture90UsePmLeadingPrice !== false
  });
  if (!bandEntry) {
    const directionalPrice = Number(directionEntry.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
    return {
      allowed: false,
      reason: `90-92¢ 结算扫盘限价需在 ${(minPrice * 100).toFixed(0)}%-${(maxPrice * 100).toFixed(0)}%（当前 ${Number.isFinite(directionalPrice) ? (directionalPrice * 100).toFixed(1) : '--'}%）。`
    };
  }

  const tradeDirection = bandEntry.direction;
  const limitPrice = Number(bandEntry.limitPrice);

  const quality = Number(sentiment.qualityScore);
  const minQuality = Number(config.plan2SettlementCapture90MinQuality) || 0.40;
  if (Number.isFinite(quality) && quality < minQuality) {
    return { allowed: false, reason: `90-92¢ 结算扫盘市场质量 ${(quality * 100).toFixed(0)}% 低于 ${(minQuality * 100).toFixed(0)}%。` };
  }

  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(startPrice) || currentPrice <= 0 || startPrice <= 0) {
    return { allowed: false, reason: '90-92¢ 结算扫盘缺少 BTC 当前价或窗口开盘价。' };
  }

  const distanceBps = ((currentPrice - startPrice) / startPrice) * 10000;
  const expectedDirection = distanceBps >= 0 ? 'up' : 'down';
  const absDistanceBps = Math.abs(distanceBps);
  const minDistanceBps = Number(config.plan2SettlementCapture90MinDistanceBps) || 1;
  if (expectedDirection !== tradeDirection) {
    return { allowed: false, reason: `90-92¢ 结算扫盘方向与开盘价距离不一致（BTC ${distanceBps.toFixed(1)} bps）。` };
  }
  if (absDistanceBps < minDistanceBps) {
    return { allowed: false, reason: `90-92¢ 结算扫盘要求距离开盘价 ≥ ${minDistanceBps} bps（当前 ${absDistanceBps.toFixed(1)} bps）。` };
  }

  const return3Bps = Number(signal?.indicators?.return3Pct) * 10000;
  const reverseBps = tradeDirection === 'up' ? Math.max(0, -return3Bps) : Math.max(0, return3Bps);
  const maxReverseBps = Number(config.plan2SettlementCapture90MaxReverseBps) || 4;
  if (Number.isFinite(reverseBps) && reverseBps > maxReverseBps) {
    return { allowed: false, reason: `90-92¢ 结算扫盘最近反向波动 ${reverseBps.toFixed(1)} bps 超过 ${maxReverseBps} bps。` };
  }

  const takeProfitPrice = Number(config.plan2SettlementCapture90TakeProfitPrice) || 0.99;
  const stopLossPrice = Number(config.plan2SettlementCapture90StopLossPrice) || 0.05;
  const sizeMultiplier = clamp(Number(config.plan2SettlementCapture90SizeMultiplier), 0.01, 0.25, 0.15);
  const confidence = Number(directionEntry.confidence);
  const calibrated = resolvePlan2CalibratedEdge({
    rawConfidence: confidence,
    entryPrice: limitPrice,
    planId: config._plan2Profile,
    symbol: signal?.symbol,
    timeframe,
    direction: tradeDirection,
    entryType: 'settlement_capture_90',
    calibrationTable,
    config
  });
  const edge = calibrated.edge ?? computeTradeEdge(calibrated.calibratedConfidence, limitPrice);
  if (config.plan2SettlementCapture90RequireCalibratedEdge === true) {
    const safetyMargin = Number(config.plan2LateCaptureSafetyMargin) || 0.025;
    if (!Number.isFinite(edge) || edge < safetyMargin) {
      return {
        allowed: false,
        reason: `90-92¢ 结算扫盘要求校准 edge ≥ ${(safetyMargin * 100).toFixed(1)}%（当前 ${Number.isFinite(edge) ? (edge * 100).toFixed(1) : '--'}%）。`
      };
    }
  }

  return {
    allowed: true,
    limitPrice,
    tradeDirection,
    priceSource: bandEntry.priceSource,
    takeProfitPrice,
    stopLossPrice,
    holdToExpiry: true,
    edge,
    calibratedConfidence: calibrated.calibratedConfidence,
    sizeMultiplier,
    tier: 'settlement_capture_90',
    tierLabel: `90-92¢ 结算扫盘 · ${tradeDirection.toUpperCase()} ${(limitPrice * 100).toFixed(1)}% · 剩余 ${sec.toFixed(0)}s · 距开盘 ${absDistanceBps.toFixed(1)} bps`,
    lateCapture: {
      mode: 'settlement_capture_90',
      remainingSeconds: round4(sec),
      distanceFromOpenBps: round4(distanceBps),
      absDistanceFromOpenBps: round4(absDistanceBps),
      recentReverseMoveBps: Number.isFinite(reverseBps) ? round4(reverseBps) : null,
      minDistanceBps,
      maxReverseBps,
      minPrice,
      maxPrice
    }
  };
}


function buildPlan2UltraLateCaptureTier({
  directionEntry,
  sentiment,
  signal,
  timeframe,
  config,
  elapsedPct
}) {
  if (config.plan2UltraLateCaptureEnabled === false) {
    return { allowed: false, reason: '超尾盘入场已关闭。' };
  }

  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const remainingSeconds = Math.max(0, (1 - Number(elapsedPct || 0)) * slotMinutes * 60);
  const minSeconds = timeframe === '5m'
    ? Number(config.plan2UltraLateCaptureMinSeconds5m) || 20
    : Number(config.plan2UltraLateCaptureMinSeconds15m) || 45;
  const maxSeconds = timeframe === '5m'
    ? Number(config.plan2UltraLateCaptureMaxSeconds5m) || 45
    : Number(config.plan2UltraLateCaptureMaxSeconds15m) || 90;
  if (remainingSeconds < minSeconds || remainingSeconds > maxSeconds) {
    return {
      allowed: false,
      reason: `超尾盘入场只在剩余 ${minSeconds}-${maxSeconds}s 执行（当前 ${remainingSeconds.toFixed(0)}s）。`
    };
  }

  const limitPrice = Number(directionEntry.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
  const minPrice = Number(config.plan2UltraLateCaptureMinPrice) || 0.95;
  const maxPrice = Number(config.plan2UltraLateCaptureMaxPrice) || 0.99;
  if (!Number.isFinite(limitPrice) || limitPrice < minPrice || limitPrice > maxPrice) {
    return {
      allowed: false,
      reason: `超尾盘入场限价需在 ${(minPrice * 100).toFixed(0)}%-${(maxPrice * 100).toFixed(0)}%（当前 ${Number.isFinite(limitPrice) ? (limitPrice * 100).toFixed(1) : '--'}%）。`
    };
  }

  const quality = Number(sentiment.qualityScore);
  const minQuality = Number(config.plan2UltraLateCaptureMinQuality) || 0.65;
  if (Number.isFinite(quality) && quality < minQuality) {
    return { allowed: false, reason: `超尾盘入场市场质量 ${(quality * 100).toFixed(0)}% 低于 ${(minQuality * 100).toFixed(0)}%。` };
  }

  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(startPrice) || currentPrice <= 0 || startPrice <= 0) {
    return { allowed: false, reason: '超尾盘入场缺少 BTC 当前价或窗口开盘价。' };
  }

  const distanceBps = ((currentPrice - startPrice) / startPrice) * 10000;
  const expectedDirection = distanceBps >= 0 ? 'up' : 'down';
  const absDistanceBps = Math.abs(distanceBps);
  const minDistanceBps = Number(config.plan2UltraLateCaptureMinDistanceBps) || 15;
  if (expectedDirection !== directionEntry.direction) {
    return { allowed: false, reason: `超尾盘方向与开盘价距离不一致（BTC ${distanceBps.toFixed(1)} bps）。` };
  }
  if (absDistanceBps < minDistanceBps) {
    return { allowed: false, reason: `超尾盘要求距离开盘价 ≥ ${minDistanceBps} bps（当前 ${absDistanceBps.toFixed(1)} bps）。` };
  }

  const return3Bps = Number(signal?.indicators?.return3Pct) * 10000;
  const reverseBps = directionEntry.direction === 'up' ? Math.max(0, -return3Bps) : Math.max(0, return3Bps);
  const maxReverseBps = Number(config.plan2UltraLateCaptureMaxReverseBps) || 2;
  if (Number.isFinite(reverseBps) && reverseBps > maxReverseBps) {
    return { allowed: false, reason: `超尾盘最近反向波动 ${reverseBps.toFixed(1)} bps 超过 ${maxReverseBps} bps。` };
  }

  const exits = buildPlan2ExitPrices(limitPrice, config);
  const sizeMultiplier = clamp(Number(config.plan2UltraLateCaptureSizeMultiplier), 0.01, 0.12, 0.06);
  const confidence = Number(directionEntry.confidence);
  const edge = computeTradeEdge(confidence, limitPrice);

  return {
    allowed: true,
    limitPrice,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    sizeMultiplier,
    tier: 'ultra_late_capture',
    tierLabel: `超尾盘 95-99¢ tier · 限价 ${(limitPrice * 100).toFixed(1)}% · 剩余 ${remainingSeconds.toFixed(0)}s · 距开盘 ${absDistanceBps.toFixed(1)} bps`,
    lateCapture: {
      mode: 'ultra_late_capture',
      elapsedPct: round4(elapsedPct),
      remainingSeconds: round4(remainingSeconds),
      distanceFromOpenBps: round4(distanceBps),
      absDistanceFromOpenBps: round4(absDistanceBps),
      recentReverseMoveBps: Number.isFinite(reverseBps) ? round4(reverseBps) : null,
      minDistanceBps,
      maxReverseBps,
      minPrice,
      maxPrice
    }
  };
}



function buildPlan2LateCaptureTier({

  directionEntry,

  sentiment,

  signal,

  timeframe,

  config,

  elapsedPct,

  calibrationTable = null,

  regimeGuard = null

}) {

  if (regimeGuard?.isChop && config.plan2LateCaptureBypassChop === false) {
    return { allowed: false, reason: `尾盘入场被震荡过滤阻止：${regimeGuard?.reason || '当前不适合 late_capture。'}` };
  }
  if (regimeGuard?.allowMain === false && config.plan2LateCaptureBypassChop === false) {
    return { allowed: false, reason: `尾盘入场被震荡过滤阻止：${regimeGuard?.reason || '当前不适合 late_capture。'}` };
  }

  if (config.plan2LateCaptureEnabled === false) {
    return { allowed: false, reason: '尾盘确定性入场已关闭。' };
  }

  const minElapsed = Number(config.plan2LateCaptureMinElapsedPct) || 0.75;
  const maxElapsed = Number(config.plan2LateCaptureMaxElapsedPct) || 0.96;
  if (elapsedPct < minElapsed) {
    return { allowed: false, reason: `尾盘入场要求窗口进度 ≥ ${(minElapsed * 100).toFixed(0)}%。` };
  }
  if (elapsedPct > maxElapsed) {
    return { allowed: false, reason: `尾盘入场超过 ${(maxElapsed * 100).toFixed(0)}% 后不追单。` };
  }

  const minPrice = Number(config.plan2LateCaptureMinPrice) || 0.82;
  const maxPrice = Number(config.plan2LateCaptureMaxPrice) || 0.92;
  const bandEntry = resolvePlan2BandEntry({
    directionEntry,
    sentiment,
    signal,
    minPrice,
    maxPrice,
    usePmLeadingPrice: config.plan2LateCaptureUsePmLeadingPrice !== false
  });
  if (!bandEntry) {
    const directionalPrice = Number(directionEntry.direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
    return {
      allowed: false,
      reason: `尾盘入场限价需在 ${(minPrice * 100).toFixed(0)}%-${(maxPrice * 100).toFixed(0)}%（当前 ${Number.isFinite(directionalPrice) ? (directionalPrice * 100).toFixed(1) : '--'}%）。`
    };
  }

  const tradeDirection = bandEntry.direction;
  const limitPrice = Number(bandEntry.limitPrice);

  const quality = Number(sentiment.qualityScore);
  const minQuality = Number(config.plan2LateCaptureMinQuality) || 0.45;
  if (Number.isFinite(quality) && quality < minQuality) {
    return { allowed: false, reason: `尾盘入场市场质量 ${(quality * 100).toFixed(0)}% 低于 ${(minQuality * 100).toFixed(0)}%。` };
  }

  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(startPrice) || currentPrice <= 0 || startPrice <= 0) {
    return { allowed: false, reason: '尾盘入场缺少 BTC 当前价或窗口开盘价。' };
  }

  const distanceBps = ((currentPrice - startPrice) / startPrice) * 10000;
  const expectedDirection = distanceBps >= 0 ? 'up' : 'down';
  const absDistanceBps = Math.abs(distanceBps);
  const minDistanceBps = Number(config.plan2LateCaptureMinDistanceBps) || 3;
  if (expectedDirection !== tradeDirection) {
    return { allowed: false, reason: `尾盘入场方向与开盘价距离不一致（BTC ${distanceBps.toFixed(1)} bps）。` };
  }
  if (absDistanceBps < minDistanceBps) {
    return { allowed: false, reason: `尾盘入场要求距离开盘价 ≥ ${minDistanceBps} bps（当前 ${absDistanceBps.toFixed(1)} bps）。` };
  }

  const return3Bps = Number(signal?.indicators?.return3Pct) * 10000;
  const reverseBps = tradeDirection === 'up' ? Math.max(0, -return3Bps) : Math.max(0, return3Bps);
  const maxReverseBps = Number(config.plan2LateCaptureMaxReverseBps) || 3;
  if (Number.isFinite(reverseBps) && reverseBps > maxReverseBps) {
    return { allowed: false, reason: `尾盘入场最近反向波动 ${reverseBps.toFixed(1)} bps 超过 ${maxReverseBps} bps。` };
  }

  const tpOffset = Number(config.plan2TakeProfitOffset) || 0.18;
  const slOffset = Number(config.plan2StopLossOffset) || 0.12;
  const exits = buildPlan2ExitPrices(limitPrice, config, { takeProfitOffset: tpOffset, stopLossOffset: slOffset });
  const sizeMultiplier = clamp(Number(config.plan2LateCaptureSizeMultiplier), 0.01, 0.25, 0.10);
  const confidence = Number(directionEntry.confidence);
  const calibrated = resolvePlan2CalibratedEdge({
    rawConfidence: confidence,
    entryPrice: limitPrice,
    planId: config._plan2Profile,
    symbol: signal?.symbol,
    timeframe,
    direction: tradeDirection,
    entryType: 'late_capture',
    calibrationTable,
    config
  });
  const edge = calibrated.edge ?? computeTradeEdge(calibrated.calibratedConfidence, limitPrice);
  if (config.plan2LateCaptureRequireCalibratedEdge !== false) {
    const safetyMargin = Number(config.plan2LateCaptureSafetyMargin) || 0.025;
    if (!Number.isFinite(edge) || edge < safetyMargin) {
      return {
        allowed: false,
        reason: `尾盘入场要求校准 edge ≥ ${(safetyMargin * 100).toFixed(1)}%（当前 ${Number.isFinite(edge) ? (edge * 100).toFixed(1) : '--'}%，校准胜率 ${(calibrated.calibratedConfidence * 100).toFixed(1)}%）。`
      };
    }
  }

  return {
    allowed: true,
    limitPrice,
    tradeDirection,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    calibratedConfidence: calibrated.calibratedConfidence,
    sizeMultiplier,
    tier: 'late_capture',
    tierLabel: `尾盘确定性 tier · 限价 ${(limitPrice * 100).toFixed(1)}% · 距开盘 ${absDistanceBps.toFixed(1)} bps · 反向 ${Number.isFinite(reverseBps) ? reverseBps.toFixed(1) : '--'} bps`,
    lateCapture: {
      elapsedPct: round4(elapsedPct),
      distanceFromOpenBps: round4(distanceBps),
      absDistanceFromOpenBps: round4(absDistanceBps),
      recentReverseMoveBps: Number.isFinite(reverseBps) ? round4(reverseBps) : null,
      minDistanceBps,
      maxReverseBps,
      minPrice,
      maxPrice
    }
  };
}



function formatTimeframeHistory({ timeframe, winRate, wins, settledOrders }) {

  if (!settledOrders || !Number.isFinite(winRate)) {

    return `本策略 ${timeframe} 暂无已结算胜率`;

  }

  return `本策略 ${timeframe} 胜率 ${(winRate * 100).toFixed(1)}%（${wins}/${settledOrders}）`;

}



export function isPlan2StopLossExitStatus(exitStatus) {
  const status = String(exitStatus || '').toLowerCase();
  return status === 'stop-loss'
    || status === 'dynamic-stop-loss'
    || status === 'hard-stop-loss'
    || status === 'direction-reversal-stop';
}

export function evaluatePlan2StopLossReversal({
  priorDirection,
  reversalDirection,
  limitPrice,
  confidence,
  elapsedPct,
  timeframe = '15m',
  config = {},
  sentiment = null,
  signal = null
}) {
  if (config.plan2StopLossReversalEnabled === false) {
    return { allowed: false, reason: 'Plan2 止损反向单已关闭。' };
  }
  const prior = String(priorDirection || '').toLowerCase();
  const next = String(reversalDirection || '').toLowerCase();
  if (!['up', 'down'].includes(prior) || !['up', 'down'].includes(next)) {
    return { allowed: false, reason: '止损反向方向无效。' };
  }
  if (prior === next) {
    return { allowed: false, reason: '反向单需与止损方向相反。' };
  }

  const maxElapsed = timeframe === '5m'
    ? Number(config.plan2StopLossReversalMaxElapsedPct5m)
    : Number(config.plan2StopLossReversalMaxElapsedPct15m);
  const maxElapsedFallback = Number(config.plan2StopLossReversalMaxElapsedPct) || 0.78;
  const maxCap = Number.isFinite(maxElapsed) && maxElapsed > 0 ? maxElapsed : maxElapsedFallback;
  if (Number(elapsedPct) > maxCap) {
    return {
      allowed: false,
      reason: `止损反向单要求窗口进度 ≤ ${(maxCap * 100).toFixed(0)}%（当前 ${(Number(elapsedPct) * 100).toFixed(0)}%）。`
    };
  }

  const price = Number(limitPrice);
  const minPrice = Number(config.plan2StopLossReversalMinPrice) || 0.48;
  const maxPrice = Number(config.plan2StopLossReversalMaxPrice) || 0.68;
  if (!Number.isFinite(price) || price < minPrice || price > maxPrice) {
    return {
      allowed: false,
      reason: `反向单限价需在 ${(minPrice * 100).toFixed(0)}%-${(maxPrice * 100).toFixed(0)}%（当前 ${Number.isFinite(price) ? (price * 100).toFixed(1) : '--'}%）。`
    };
  }

  const conf = Number(confidence);
  const minConfidence = Number(config.plan2StopLossReversalMinConfidence) || 0.58;
  if (!Number.isFinite(conf) || conf < minConfidence) {
    return {
      allowed: false,
      reason: `反向单要求置信 ≥ ${(minConfidence * 100).toFixed(0)}%（当前 ${Number.isFinite(conf) ? (conf * 100).toFixed(0) : '--'}%）。`
    };
  }

  const edge = computeTradeEdge(conf, price);
  const minEdge = Number(config.plan2StopLossReversalMinEdge) || 0.04;
  if (!Number.isFinite(edge) || edge < minEdge) {
    return {
      allowed: false,
      reason: `反向单要求 edge ≥ ${(minEdge * 100).toFixed(0)}%（当前 ${Number.isFinite(edge) ? (edge * 100).toFixed(1) : '--'}%）。`
    };
  }

  if (config.plan2ReversalRequirePmAlign !== false && sentiment?.available) {
    const pm = resolvePolymarketDirection(sentiment);
    const upProb = Number(sentiment.upProbability ?? sentiment.upPrice);
    const downProb = Number(sentiment.downProbability ?? sentiment.downPrice);
    const pmEdge = Number.isFinite(upProb) && Number.isFinite(downProb) ? Math.abs(upProb - downProb) : null;
    const pmGapLead = Number(config.plan2DirectionPmGapLead) || 0.05;
    const pmSupportsReversal = pm.direction === next && pmEdge != null && pmEdge >= pmGapLead;
    if (!pmSupportsReversal) {
      const distanceBps = resolvePlan2BtcDistanceBps(signal);
      const maxChopDistanceBps = Number(config.plan2ChopMaxDistanceBps) || 4;
      const nearOpen = Number.isFinite(distanceBps) && Math.abs(distanceBps) <= maxChopDistanceBps;
      const maxPmEdge = Number(config.plan2ChopMaxPmEdge) || 0.08;
      const pmNearTie = pmEdge != null && pmEdge <= maxPmEdge;
      const chopMinConf = Number(config.plan2ReversalChopMinConfidence) || 0.66;
      if (nearOpen && pmNearTie) {
        if (!Number.isFinite(conf) || conf < chopMinConf) {
          return {
            allowed: false,
            reason: `震荡盘口反向单需置信 ≥ ${(chopMinConf * 100).toFixed(0)}% 且 PM 支持 ${next.toUpperCase()}（当前 ${Number.isFinite(conf) ? (conf * 100).toFixed(0) : '--'}%）。`
          };
        }
      } else {
        return {
          allowed: false,
          reason: `反向单 ${next.toUpperCase()} 未获 PM 领先支持（gap ${pmEdge != null ? (pmEdge * 100).toFixed(1) : '--'}%）。`
        };
      }
    }
  }

  const tpOffset = Number(config.plan2TakeProfitOffset) || 0.16;
  const slOffset = Number(config.plan2StopLossOffset) || 0.08;
  const exits = buildPlan2ExitPrices(price, config, { takeProfitOffset: tpOffset, stopLossOffset: slOffset });
  const sizeMultiplier = timeframe === '5m'
    ? Number(config.plan2StopLossReversalSizeMultiplier5m)
    : Number(config.plan2StopLossReversalSizeMultiplier15m);
  const baseMult = Number.isFinite(sizeMultiplier) && sizeMultiplier > 0
    ? sizeMultiplier
    : (Number(config.plan2StopLossReversalSizeMultiplier) || 0.32);

  return {
    allowed: true,
    limitPrice: price,
    takeProfitPrice: exits.takeProfitPrice,
    stopLossPrice: exits.stopLossPrice,
    edge,
    confidence: round4(conf),
    sizeMultiplier: clamp(baseMult, 0.05, 0.65, 0.32),
    tier: 'stop_loss_reversal',
    tierLabel: `止损反向 tier · ${prior.toUpperCase()}→${next.toUpperCase()} · 限价 ${(price * 100).toFixed(1)}% · ×${clamp(baseMult, 0.05, 0.65, 0.32).toFixed(2)}`,
    reason: `Plan2 止损反向：${prior.toUpperCase()} 止损后试 ${next.toUpperCase()}，edge ${(edge * 100).toFixed(1)}%。`
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



function round4(value) {

  return Math.round(Number(value) * 1e4) / 1e4;

}



function clamp(value, min, max, fallback) {

  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;

  return Math.min(max, Math.max(min, number));

}


export { buildPlan2SustainedMomentumTier, buildPlan2SettlementCapture90Tier };

