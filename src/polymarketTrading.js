import { mkdir, readdir, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { describePolymarketSizing, computePolymarketOrderUsd } from './polymarketSizing.js';
import {
  extractClobOpenOrderProgress,
  hasClobTransactionHashes,
  humanizeClobError,
  isClobBuyFillConfirmed,
  isClobOrderFilled,
  isClobOrderTerminal,
  isInvalidMakerAmountError,
  isUnsellableDustShares,
  normalizeClobBuyAmounts
} from './polymarketLiveClob.js';
import { submitPolymarketLiveOrder, submitPolymarketLiveSellOrder } from './polymarketLiveOrder.js';
import { shouldPlan1DirectionFlip, windowElapsedPct } from './polymarketPlan.js';
import {
  assertPlan1LiveEntryPriceAllowed,
  computePlan1ExitPrices,
  computePlan1Analytics
} from './plan1Policy.js';
import {
  applyExitDecisionEvaluation,
  computeExitDecisionAnalytics as aggregateExitDecisionAnalytics,
  isEarlyExitStatus
} from './polymarketExitAnalytics.js';
import { buildPlan2DelayedEntryKey, evaluatePlan2StopLossReversal, isPlan2StopLossExitStatus } from './polymarketPlan2.js';
import { isPlan2Family, normalizePlan2FamilyId, plan2FamilyLabel, resolvePlan2ProfileConfig } from './polymarketPlan2Profiles.js';
import { PLAN2_6_ID, PLAN2_6_VERSION, buildPlan26RulesSnapshot } from './polymarketPlan2_6.js';
import {
  PLAN13_ID,
  PLAN13_VERSION,
  buildPlan13RulesSnapshot,
  resolvePlan13SpotDirection
} from './polymarketPlan13.js';
import {
  PLAN11_ID,
  PLAN11_VERSION,
  assertPlan11LiveEntryPriceAllowed,
  buildPlan11RulesSnapshot,
  computePlan11ExitPrices,
  isPlan11StopLossEnabled
} from './polymarketPlan11.js';
import {
  PLAN14_ID,
  PLAN14_VERSION,
  PLAN14_V9_VERSION,
  PLAN14_V8_VERSION,
  PLAN14_V7_VERSION,
  PLAN14_V6_VERSION,
  PLAN14_V5_VERSION,
  PLAN14_PREVIOUS_VERSION,
  PLAN14_V3_VERSION,
  buildPlan14RulesSnapshot,
  evaluatePlan14Exposure,
  evaluatePlan14Exit,
  confirmPlan14Stop
} from './polymarketPlan14.js';
import { observePlan14ExitControl, summarizePlan14ExitControl } from './plan14ExitControl.js';
import { createPlan14ProfitExperiment, observePlan14ProfitExperiment, resolvePlan14ProfitExperiment,
  releasePlan14ProfitExperiment, summarizePlan14ProfitExperiment } from './plan14ProfitExperiment.js';
import { PLAN15_ID, PLAN15_VERSION } from './polymarketPlan15.js';
import { PLAN16_ID, PLAN16_VERSION } from './polymarketPlan16.js';
import { PLAN17_ID, PLAN17_VERSION } from './polymarketPlan17.js';
import { PLAN18_ID, PLAN19_ID, DIVINATION_PLANS, DIVINATION_PLAN_IDS } from './polymarketPlan18.js';
import { resolvePlan2ExitLockThresholds } from './fiveMinuteDecision.js';
import { buildConfidenceCalibrationTable } from './polymarketCalibration.js';
import { computeDynamicExitPrices, computeTradeEdge, resolveStopLossAbsoluteFloor, updateAndEvaluateTrailingTakeProfit } from './polymarketSizing.js';
import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';
import {
  PLAN3_VERSION,
  buildPlan3SlotKey,
  buildPolymarketPaperPlan3,
  calculatePlan3OrderUsd,
  computePlan3Analytics,
  describePlan3ActionSkipReason,
  estimatePlan3ExpectedFillPrice,
  isPlan3SlotSubmissionLocked,
  isPlan3WideBandRuntimeEnabled,
  resolvePlan3RuntimeConfig
} from './polymarketPlan3.js';
import {
  buildPlan3EntryContext,
  computePlan3LossAnalytics
} from './polymarketPlan3LossAnalytics.js';
import { applySettlementLossAnalysis } from './lossReasonClassifier.js';
import { buildPolymarketAnalyticsDashboard } from './polymarketAnalytics.js';
import { DEFAULT_AVOIDABLE_LOSS_REASONS } from './lossReasonTaxonomy.js';
import { PLAN5_VERSION, evaluatePlan5StopLoss, summarizePlan5OpportunityLog } from './polymarketPlan5.js';
import { PLAN3_6_LANES, PLAN3_6_PAPER_TIMEFRAMES, PLAN3_6_LIVE_TIMEFRAMES, PLAN3_6_VERSION } from './polymarketPlan3_6.js';
import { computeAdaptiveLiveOrderCap } from './polymarketLiveRisk.js';
import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';
import {
  collapseSettledOrdersByWindow,
  computeSettledStreaks,
  isStreakSizingEnabled,
  resolveEntrySizeScale
} from './streakSizing.js';

export const PLAN_IDS = ['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan11', 'plan13', 'plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan3', 'plan3_5', 'plan3_6', 'plan5'];
export const PAPER_ORDERS_HARD_CAP = 500;
const PLAN2_STRATEGY_VERSIONS = Object.freeze({
  plan2: 'plan2_classic_v20260729',
  plan2_5: 'plan2_5_audit_v20260729',
  plan2_6: PLAN2_6_VERSION,
  plan13: PLAN13_VERSION
});

function resolvePlan2StrategyVersion(planId) {
  return PLAN2_STRATEGY_VERSIONS[String(planId || '').toLowerCase()] || null;
}

/**
 * Shared physical entry floor for paper and live execution. Paper parity must
 * model an order that could actually be submitted to CLOB; otherwise a paper
 * winner at an impossible size makes the strategy look better than production.
 */
/** 纸面 ask 未成交等写入的 usd=0 幽灵单：不占窗、不计成交。 */
export function isPaperZeroGhostOrder(order = {}) {
  if (!order) return false;
  const usd = Number(order.usd);
  const shares = Number(order.shares ?? order.filledShares);
  if (usd > 0 || shares > 0) return false;
  const exit = String(order.exitStatus || '').toLowerCase();
  const fill = String(order.fillStatus || '').toLowerCase();
  return exit === 'expired-unfilled' || fill === 'expired' || exit.includes('unfilled');
}

/** 本金/风控上限长期低于 CLOB 最小份数：结构性无法成交，应少重试。 */
export function isStructuralLiveUnderfundError(message = '') {
  return /按本金风控后上限.*低于 CLOB|按本金风控后金额.*低于 CLOB|低于 CLOB 最小|风控可下单额度不足|余额 .*不足以满足 CLOB|余额\/敞口不够最小单/.test(String(message || ''));
}

/**
 * 敞口已满 / 余额撑不起最小单等结构性拒绝：落盘成「买入拦截」无操作价值，只刷屏。
 * Plan2.x probe 的连亏/噪声跳过同理。
 */
export function shouldSkipLiveBlockedBuyRecord(message = '', { planId = null, entryType = null } = {}) {
  const text = String(message || '');
  if (!text) return false;
  if (isStructuralLiveUnderfundError(text)) return true;
  const id = String(planId || '').toLowerCase();
  const isPlan2 = id === 'plan2' || id === 'plan2_5' || id === 'plan2_6' || id === 'plan13';
  if (isPlan2 && entryType === 'probe' && /连续亏损|恢复模式|冷却|噪声单|低于.*最小单/.test(text)) {
    return true;
  }
  return false;
}

/** 历史噪音：结构性资金/敞口不足的 blocked 买单，前端与统计展示都应隐藏。 */
export function isNoisyStructuralBlockedBuy(order = {}) {
  if (!order || String(order.orderSide || '').toUpperCase() !== 'BUY') return false;
  if (String(order.status || '').toLowerCase() !== 'blocked') return false;
  if (order.clobOrderId) return false;
  return isStructuralLiveUnderfundError(`${order.error || ''} ${order.note || ''}`);
}

/** Plan1 实盘可执行底：避免 5 份×廉价 token ≈ $1 的灰尘单（CLOB 易超时/卖不出）。 */
export const PLAN1_LIVE_EXECUTABLE_FLOOR_USD = 2.5;
/** @deprecated 已改为「余额/敞口够则抬到 floor」，不再按意向金额跳过。 */
export const PLAN1_LIVE_DUST_SKIP_USD = 2;

export function resolveUnifiedEntryFloorUsd({ config = {}, planId = 'plan1', timeframe = '15m', price }) {
  const id = String(planId || 'plan1').toLowerCase();
  const isPlan2 = id === 'plan2' || id === 'plan2_5' || id === 'plan2_6' || id === 'plan13';
  // Plan1 / Plan2.x：只用 CLOB 协议层真实 5 份底，不叠加自设噪声最小单。
  // Plan5 等仍可保留 liveMinSharesBuffer（卖出路径缓冲）。
  const minShares = (id === 'plan1' || isPlan2)
    ? 5
    : Math.max(5, Number(config.liveMinSharesBuffer) || 6);
  const minClobUsd = Math.ceil((Number(price) || 0) * minShares * 100) / 100;
  const globalMin = Math.max(5, Number(config.minOrderUsd) || 5);
  const planMin = isPlan2
    ? Number(timeframe === '5m' ? config.plan2LiveMinOrderUsd5m : config.plan2LiveMinOrderUsd15m)
    : id === 'plan1'
      ? (Number.isFinite(Number(config.plan1LiveMinOrderUsd)) ? Number(config.plan1LiveMinOrderUsd) : 5)
      : id === 'plan5'
        ? (Number.isFinite(Number(config.plan5LiveMinOrderUsd)) ? Number(config.plan5LiveMinOrderUsd) : 1)
        : 0;
  if (id === 'plan3_6') return Math.max(0.01, minClobUsd);
  if (id === PLAN14_ID) return Math.max(0.01, Math.ceil((Number(price) || 0) * 5 * 100) / 100);
  if (id === 'plan1') {
    const executableFloor = Number.isFinite(Number(config.plan1LiveExecutableFloorUsd))
      ? Math.max(0, Number(config.plan1LiveExecutableFloorUsd))
      : PLAN1_LIVE_EXECUTABLE_FLOOR_USD;
    return Math.max(
      Number.isFinite(planMin) && planMin > 0 ? planMin : 0,
      minClobUsd,
      executableFloor
    );
  }
  if (id === 'plan5') {
    return Math.max(Number.isFinite(planMin) && planMin > 0 ? planMin : 0, minClobUsd);
  }
  if (id === 'plan11') {
    const plan11Min = Number.isFinite(Number(config.plan11LiveMinOrderUsd))
      ? Number(config.plan11LiveMinOrderUsd)
      : 5;
    return Math.max(plan11Min > 0 ? plan11Min : 0, Math.ceil((Number(price) || 0) * 5 * 100) / 100);
  }
  // Plan2/2.5/2.6：忽略全局 $5 与配置噪声底，只保留 CLOB 5 份物理最小，避免
  // 「风控 room $5.16 < 自设最小单 $6 → blocked」互掐。
  if (isPlan2) return Math.max(0.01, minClobUsd);
  return Math.max(globalMin, Number.isFinite(planMin) && planMin > 0 ? planMin : 0, minClobUsd);
}

/** 二元窗已结束后结果风险锁定；待官方结算不应再占用下一窗的敞口额度。 */
export function isLiveExposureWindowOpen(order, nowMs = Date.now()) {
  const targetMs = Date.parse(String(order?.targetTimeIso || ''));
  if (Number.isFinite(targetMs)) return targetMs > nowMs;
  // 缺 targetTimeIso 的老仓/恢复仓：用 slot/成交时间 + 周期推断窗结束，避免永久占满敞口。
  const startMs = Date.parse(String(
    order?.slotIso || order?.filledAtIso || order?.createdAtIso || order?.createdAt || ''
  ));
  if (!Number.isFinite(startMs)) return false;
  const tf = String(order?.timeframe || '15m').toLowerCase();
  const slotMs = tf === '5m'
    ? 5 * 60 * 1000
    : tf === '1h'
      ? 60 * 60 * 1000
      : tf === '1d'
        ? 24 * 60 * 60 * 1000
        : 15 * 60 * 1000;
  return startMs + slotMs > nowMs;
}

/** hardCap 低于 CLOB/实盘最小单时的可读跳过原因（避免展示 $0.01 伪上限）。 */
export function formatLiveHardCapBelowFloorReason({
  hardCap,
  liveFloorUsd,
  requestedUsd = null,
  cash = null,
  singleOrderCap = null,
  totalExposureRoom = null,
  timeframeExposureRoom = null,
  timeframe = null,
  maxSingleOrderUsd = null,
  maxTotalOpenExposureUsd = null,
  maxTimeframeOpenExposureUsd = null,
  totalOpenExposureUsd = null,
  timeframeOpenExposureUsd = null
} = {}) {
  const floor = Math.max(0, Number(liveFloorUsd) || 0);
  const floorText = `CLOB 最小约 $${floor.toFixed(2)}（约 5 份）`;
  const cashUsd = Number(cash);
  if (Number.isFinite(cashUsd) && cashUsd + 0.005 < floor) {
    return `余额 $${cashUsd.toFixed(2)} 不足以满足 ${floorText}，无法下单。`;
  }
  const constraints = [
    {
      room: Number(timeframeExposureRoom),
      label: `${timeframe || '周期'}敞口余量`,
      detail: Number.isFinite(Number(timeframeOpenExposureUsd)) && Number.isFinite(Number(maxTimeframeOpenExposureUsd))
        ? `已用 $${Number(timeframeOpenExposureUsd).toFixed(2)} / 上限 $${Number(maxTimeframeOpenExposureUsd).toFixed(2)}`
        : null
    },
    {
      room: Number(totalExposureRoom),
      label: '总敞口余量',
      detail: Number.isFinite(Number(totalOpenExposureUsd)) && Number.isFinite(Number(maxTotalOpenExposureUsd))
        ? `已用 $${Number(totalOpenExposureUsd).toFixed(2)} / 上限 $${Number(maxTotalOpenExposureUsd).toFixed(2)}`
        : null
    },
    {
      room: Number(singleOrderCap),
      label: '单笔风控上限',
      detail: Number.isFinite(Number(maxSingleOrderUsd))
        ? `权益比例上限 $${Number(maxSingleOrderUsd).toFixed(2)}`
        : null
    }
  ];
  const binding = constraints
    .filter((row) => Number.isFinite(row.room))
    .sort((a, b) => a.room - b.room)[0];
  const intent = Number.isFinite(Number(requestedUsd))
    ? `本金比例算出 $${Number(requestedUsd).toFixed(2)}，`
    : '';
  if (binding && binding.room + 0.005 < floor) {
    const detail = binding.detail ? `（${binding.detail}）` : '';
    return (
      `${intent}余额/敞口不够最小单：${binding.label} $${Math.max(0, binding.room).toFixed(2)}`
      + `${detail} 低于 ${floorText}，跳过。`
    );
  }
  const cap = Math.max(0, Number(hardCap) || 0);
  return `${intent}余额/敞口不够最小单：可下单额度 $${cap.toFixed(2)} 低于 ${floorText}，跳过。`;
}

function resolvePlan5CurrentPmDirection(planView) {
  const explicit = String(planView?.polymarket?.predictedDirection || '').toLowerCase();
  if (explicit === 'up' || explicit === 'down') return explicit;
  const up = Number(planView?.polymarket?.upPrice);
  const down = Number(planView?.polymarket?.downPrice);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up === down) return null;
  return up > down ? 'up' : 'down';
}

/** 压缩落盘/内存中的纸面订单：去掉完整 plan/recommendation 大对象，保留去重与展示所需字段。 */
export function slimStoredPaperOrder(order) {
  if (!order || typeof order !== 'object') return order;
  let next = order;
  const plan = order.plan;
  if (plan && typeof plan === 'object') {
    const fat = Object.keys(plan).length > 10
      || plan.sentiment
      || plan.intervalPmLock
      || plan.recommendation
      || (plan.action && (plan.action.reason || plan.action.diagnostics || Object.keys(plan.action).length > 12));
    if (fat) {
      next = { ...next, plan: {
        symbol: plan.symbol || order.symbol || null,
        timeframe: plan.timeframe || order.timeframe || null,
        slotIso: plan.slotIso || order.slotIso || null,
        targetTimeIso: plan.targetTimeIso || order.targetTimeIso || null,
        entryType: plan.entryType || order.entryType || null,
        key: plan.key || order.planKey || null,
        action: plan.action ? {
          executionKey: plan.action.executionKey || null,
          entryType: plan.action.entryType || null,
          lockStrength: plan.action.lockStrength || null,
          lockPmGap: plan.action.lockPmGap ?? null,
          trajectoryPattern: plan.action.trajectoryPattern || null,
          trajectoryExperiment: plan.action.trajectoryExperiment || null
        } : undefined
      } };
    }
  }
  const recommendation = next.recommendation;
  if (recommendation && typeof recommendation === 'object') {
    const fatRec = Object.keys(recommendation).length > 6
      || recommendation.features
      || recommendation.reasons
      || recommendation.components;
    if (fatRec) {
      next = {
        ...next,
        recommendation: {
          direction: recommendation.direction ?? null,
          confidence: recommendation.confidence ?? null,
          timeframe: recommendation.timeframe ?? null,
          qualityScore: recommendation.qualityScore ?? null
        }
      };
    }
  }
  return next;
}

/** UI 列表用精简字段，避免每次轮询传输完整订单 JSON。 */
export function summarizePaperOrderForApi(order) {
  if (!order || typeof order !== 'object') return order;
  return {
    id: order.id,
    createdAtIso: order.createdAtIso,
    symbol: order.symbol || order.plan?.symbol || 'BTC-USD',
    timeframe: order.timeframe || null,
    outcome: order.outcome || null,
    direction: order.direction || null,
    limitPrice: order.limitPrice ?? null,
    usd: order.usd ?? null,
    pnl: order.pnl ?? null,
    market: order.market || null,
    settlementStatus: order.settlementStatus || null,
    fillStatus: order.fillStatus || null,
    exitStatus: order.exitStatus || null,
    exitReason: order.exitReason || null,
    exitPrice: order.exitPrice ?? null,
    exitTrigger: order.exitTrigger || null,
    actualDirection: order.actualDirection || null,
    counterfactualHoldPnl: order.counterfactualHoldPnl ?? null,
    counterfactualOutcomeSource: order.counterfactualOutcomeSource || null,
    exitVsHoldPnlDelta: order.exitVsHoldPnlDelta ?? null,
    plan14ExitControl: order.plan14ExitControl ? {
      version: order.plan14ExitControl.version, status: order.plan14ExitControl.status,
      exitPrice: order.plan14ExitControl.exitPrice ?? null,
      pnl: order.plan14ExitControl.pnl ?? null
    } : null,
    peakPrice: order.peakPrice ?? null,
    trailStopPrice: order.trailStopPrice ?? null,
    priceBand: order.priceBand || null,
    planId: order.planId || null,
    trajectoryPattern: order.trajectoryPattern || null,
    trajectoryExperimentReason: order.trajectoryExperimentReason || null,
    trajectoryAligned: order.trajectoryAligned ?? null,
    experimentLane: order.experimentLane || null,
    shadowOnly: order.shadowOnly === true,
    strategyVersion: order.strategyVersion || null,
    planKey: order.planKey
      || order.plan?.action?.executionKey
      || order.plan?.key
      || null,
    won: order.won ?? null
  };
}

export function summarizeLiveOrderForApi(order) {
  if (!order || typeof order !== 'object') return order;
  return {
    id: order.id,
    createdAtIso: order.createdAtIso,
    status: order.status || null,
    orderSide: order.orderSide || 'BUY',
    positionStatus: order.positionStatus || null,
    symbol: order.symbol || 'BTC-USD',
    timeframe: order.timeframe || null,
    direction: order.direction || null,
    outcome: order.outcome || null,
    usd: order.usd ?? null,
    limitPrice: order.limitPrice ?? null,
    entryPrice: order.entryPrice ?? null,
    exitPrice: order.exitPrice ?? null,
    exitStatus: order.exitStatus || null,
    exitReason: order.exitReason || null,
    stopLossPrice: order.stopLossPrice ?? null,
    relatedBuyOrderId: order.relatedBuyOrderId || null,
    peakPrice: order.peakPrice ?? null,
    trailStopPrice: order.trailStopPrice ?? null,
    pnl: order.pnl ?? null,
    payoutUsd: order.payoutUsd ?? null,
    planId: normalizeLiveOrderPlanId(order),
    entryType: order.entryType || null,
    market: order.market || null,
    marketSlug: order.marketSlug || null,
    shares: order.shares ?? null,
    remainingShares: order.remainingShares ?? null,
    dustTopUpPending: order.dustTopUpPending === true,
    dustHolding: order.dustHolding === true,
    dustSellMinShares: order.dustSellMinShares ?? null,
    dustHoldingReason: order.dustHoldingReason || null,
    clobStatus: order.clobStatus || order.clobResponse?.status || null,
    error: order.error || null,
    note: order.note || null,
    lastExitError: order.lastExitError || null,
    retryCount: Number(order.retryCount) || 0,
    lastRetryAtIso: order.lastRetryAtIso || null,
    nextRetryAtIso: order.nextRetryAtIso || null
  };
}

export function pruneLiveOrdersByPlan(orders = [], perPlanLimit = 80) {
  const counts = new Map();
  const kept = [];
  for (const order of orders) {
    const planId = normalizeLiveOrderPlanId(order);
    const isActive = order?.positionStatus === 'open'
      || order?.positionStatus === 'pending'
      || order?.status === 'pending';
    const count = counts.get(planId) || 0;
    if (!isActive && count >= perPlanLimit) continue;
    kept.push(order);
    if (!isActive) counts.set(planId, count + 1);
  }
  return kept.slice(0, PLAN_IDS.length * perPlanLimit + 100);
}

function freshPlanBucket(planId = 'plan1') {
  const threeCoin = planId === 'plan3_5';
  const base = {
    paperOrders: [],
    portfolio: {
      startingCash: 0,
      cash: 0,
      portfolioInitialized: false
    },
    auto: {
      enabled: false,
      strategy: planId,
      timeframes: planId === 'plan3_6' ? [...PLAN3_6_PAPER_TIMEFRAMES] : ['5m', '15m'],
      symbols: threeCoin
        ? ['BTC-USD', 'ETH-USD', 'SOL-USD']
        : planId === 'plan3'
          ? ['BTC-USD']
          : ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'],
      lastExecutedKeys: []
    },
    pendingDelayedEntries: {},
    lastFlipAt: {},
    daily: {
      dateKey: null,
      realizedPnl: 0
    }
  };
  if (planId === 'plan1' || planId === 'plan2' || planId === 'plan2_5' || planId === 'plan2_6' || planId === 'plan13' || planId === 'plan11') {
    return {
      ...base,
      trajectoryExperimentLog: []
    };
  }
  if (planId === 'plan3') {
    return {
      ...base,
      plan3SubmittedSlots: {},
      plan3OpportunityLog: [],
      plan3Daily: {
        dateKey: null,
        realizedPnl: 0,
        lossCount: 0,
        executionErrors: 0,
        stopped: false,
        stopReason: null
      }
    };
  }
  if (planId === 'plan5') {
    return {
      ...base,
      plan5OpportunityLog: [],
      plan5ShadowObservations: []
    };
  }
  if (planId === 'plan3_6') {
    return {
      ...base,
      plan36ObservationLog: []
    };
  }
  return base;
}

const DEFAULT_STATE = {
  plans: {
    plan1: freshPlanBucket('plan1'),
    plan2: freshPlanBucket('plan2'),
    plan2_5: freshPlanBucket('plan2_5'),
    plan2_6: freshPlanBucket('plan2_6'),
    plan11: freshPlanBucket('plan11'),
    plan13: freshPlanBucket('plan13'),
    plan14: freshPlanBucket('plan14'),
    plan15: freshPlanBucket('plan15'),
    plan16: freshPlanBucket('plan16'),
    plan17: freshPlanBucket('plan17'),
    plan18: freshPlanBucket('plan18'),
    plan19: freshPlanBucket('plan19'),
    plan3: freshPlanBucket('plan3'),
    plan3_5: freshPlanBucket('plan3_5'),
    plan3_6: freshPlanBucket('plan3_6'),
    plan5: freshPlanBucket('plan5')
  },
  liveControl: {
    enabled: false,
    startedAtIso: null,
    stoppedAtIso: null,
    startingBalanceUsdc: 0,
    currentBalanceUsdc: 0,
    lastValidBalanceUsdc: 0,
    balanceUpdatedAtIso: null
  },
  liveAuto: {
    enabled: false,
    enabledPlans: [],
    planRuns: {},
    planId: 'plan1',
    timeframes: ['5m', '15m'],
    symbols: ['BTC-USD'],
    lastExecutedKeys: [],
    pendingDelayedEntries: {},
    lastRunAtIso: null,
    lastError: null,
    lastAction: null,
    lastReason: null,
    lastOrderId: null,
    startedAtIso: null,
    stoppedAtIso: null,
    lastFlipAt: {},
    riskControls: {
      globalDailyLossProtectionEnabled: true
    }
  },
  liveOrders: []
};

export class PolymarketTradingService {
  constructor({ config, stateDir = null, statePath = null, defaultStartingCash = 500, statsDb = null }) {
    this.config = config;
    this.defaultStartingCash = defaultStartingCash;
    this.statsDb = statsDb;
    this._statsDbSyncedIds = new Set();
    this.splitState = Boolean(stateDir);
    if (this.splitState) {
      this.stateDir = stateDir;
      this.legacyStatePath = statePath || join(dirname(stateDir), 'polymarket-paper-state.json');
      this.planStatePaths = Object.fromEntries(
        PLAN_IDS.map((planId) => [planId, join(stateDir, `${planId}-state.json`)])
      );
      this.liveStatePath = join(stateDir, 'live-state.json');
      this.statePath = null;
    } else {
      this.stateDir = null;
      this.legacyStatePath = null;
      this.planStatePaths = null;
      this.liveStatePath = null;
      this.statePath = statePath || join('data', 'polymarket-paper-state.json');
    }
    this.state = structuredClone(DEFAULT_STATE);
    /** 实盘同 key 提交互斥：防止 await CLOB 期间并发 tick 重复下单 */
    this.liveExecutionClaims = new Set();
    this.persistQueues = new Map();
    this.plan14ResearchQueues = new Map();
    this.opportunityPersistAtMs = new Map();
    this.analysisCache = new Map();
    this.liveDailyStatsCache = { at: 0, dateKey: '', value: null };
  }

  getCachedAnalysis(key, maxAgeMs, build) {
    const now = Date.now();
    const cached = this.analysisCache.get(key);
    if (cached && now - cached.at < maxAgeMs) return cached.value;
    const value = build();
    this.analysisCache.set(key, { at: now, value });
    if (this.analysisCache.size > 100) {
      for (const [cacheKey, entry] of this.analysisCache) {
        if (now - entry.at >= maxAgeMs) this.analysisCache.delete(cacheKey);
      }
    }
    return value;
  }

  async load() {
    if (this.splitState) {
      await this.loadSplitState();
      return;
    }
    await this.loadLegacyState();
  }

  async loadLegacyState() {
    const tryParse = async (path) => JSON.parse(await readFile(path, 'utf8'));
    try {
      this.state = migrateState(await tryParse(this.statePath));
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.normalizeAutoState();
        return;
      }
      const backupPath = `${this.statePath}.bak`;
      try {
        this.state = migrateState(await tryParse(backupPath));
        await this.persist();
        console.warn(`Polymarket state restored from backup: ${backupPath}`);
        await this.normalizeAutoState();
        return;
      } catch {
        // fall through
      }
      const repaired = await repairTruncatedStateFile(this.statePath);
      if (repaired) {
        this.state = migrateState(repaired);
        await this.persist();
        console.warn(`Polymarket state auto-repaired from truncated file: ${this.statePath}`);
        await this.normalizeAutoState();
        return;
      }
      throw error;
    }
    await this.normalizeAutoState();
  }

  async loadSplitState() {
    await mkdir(this.stateDir, { recursive: true });
    await cleanupStaleStateTempFiles(this.stateDir).catch((error) => {
      console.warn(`Polymarket stale tmp cleanup skipped: ${error.message}`);
    });
    let loadedAny = false;

    for (const planId of PLAN_IDS) {
      const bucket = await readPlanStateWithBackup(this.planStatePaths[planId]);
      if (bucket) {
        this.state.plans[planId] = mergePlanBucket(planId, bucket);
        loadedAny = true;
      }
    }

    const live = await readPlanStateWithBackup(this.liveStatePath);
    if (live) {
      this.state.liveControl = { ...DEFAULT_STATE.liveControl, ...(live.liveControl || {}) };
      this.state.liveAuto = {
        ...DEFAULT_STATE.liveAuto,
        ...(live.liveAuto || {}),
        lastFlipAt: live.liveAuto?.lastFlipAt || {},
        riskControls: {
          ...DEFAULT_STATE.liveAuto.riskControls,
          ...(live.liveAuto?.riskControls || {})
        }
      };
      this.state.liveOrders = live.liveOrders || [];
      loadedAny = true;
    }

    if (!loadedAny) {
      const migrated = await this.migrateFromLegacyCombinedState();
      if (!migrated) {
        await this.restoreSplitStateFromLegacyBackups();
        loadedAny = PLAN_IDS.some((planId) => bucketHasData(this.state.plans[planId]));
      }
      if (!loadedAny) {
        await this.normalizeAutoState();
        return;
      }
    } else {
      await this.repairEmptySplitBuckets();
    }

    this.slimAllLoadedPaperOrders();
    this.hydrateStatsDbSyncedIds();
    const repairedDustClosures = this.repairSyntheticDustClosures();
    if (repairedDustClosures > 0) {
      await this.persist('live');
      console.warn(`Polymarket reopened ${repairedDustClosures} synthetic dust closure(s) for real holding/official settlement.`);
    }
    const clearedSettledDustFlags = this.clearSettledDustHoldingFlags();
    if (clearedSettledDustFlags > 0) {
      await this.persist('live');
      console.warn(`Polymarket cleared stale dust-holding flags from ${clearedSettledDustFlags} settled live position(s).`);
    }
    const removedDustSells = this.repairSyntheticDustSellRecords();
    if (removedDustSells > 0) {
      await this.persist('live');
      console.warn(`Polymarket removed ${removedDustSells} synthetic dust sell row(s) from live history.`);
    }
    await this.normalizeAutoState();
  }

  slimAllLoadedPaperOrders() {
    for (const planId of PLAN_IDS) {
      const bucket = this.state.plans[planId];
      if (!bucket?.paperOrders?.length) continue;
      bucket.paperOrders = bucket.paperOrders.map(slimStoredPaperOrder);
    }
  }

  async repairEmptySplitBuckets() {
    // 空账户合法。优先用同计划 .bak 补回缺失主文件；
    // 只有全部分片主文件与 bak 都不存在时，才允许超旧 legacy 回灌。
    let anySplitPresent = false;
    for (const planId of PLAN_IDS) {
      const path = this.planStatePaths[planId];
      const primaryExists = await pathExists(path);
      const bakExists = await pathExists(`${path}.bak`);
      if (primaryExists || bakExists) anySplitPresent = true;
      if (!primaryExists && bakExists) {
        const bak = await readJsonFileOptional(`${path}.bak`);
        if (bak) {
          await writeFile(path, `${JSON.stringify(bak)}\n`, 'utf8');
          this.state.plans[planId] = mergePlanBucket(planId, bak);
          console.warn(`Polymarket restored primary from bak for ${path}`);
        }
      }
    }
    const livePath = this.liveStatePath;
    const livePrimaryExists = await pathExists(livePath);
    const liveBakExists = await pathExists(`${livePath}.bak`);
    if (livePrimaryExists || liveBakExists) anySplitPresent = true;
    if (!livePrimaryExists && liveBakExists) {
      const bak = await readJsonFileOptional(`${livePath}.bak`);
      if (bak) {
        await writeFile(livePath, `${JSON.stringify(bak)}\n`, 'utf8');
        this.state.liveControl = { ...DEFAULT_STATE.liveControl, ...(bak.liveControl || {}) };
        this.state.liveAuto = {
          ...DEFAULT_STATE.liveAuto,
          ...(bak.liveAuto || {}),
          lastFlipAt: bak.liveAuto?.lastFlipAt || {},
          riskControls: {
            ...DEFAULT_STATE.liveAuto.riskControls,
            ...(bak.liveAuto?.riskControls || {})
          }
        };
        this.state.liveOrders = bak.liveOrders || [];
        console.warn(`Polymarket restored live primary from bak for ${livePath}`);
      }
    }
    if (anySplitPresent) return false;
    return this.restoreSplitStateFromLegacyBackups();
  }

  async migrateFromLegacyCombinedState() {
    const candidates = [
      this.legacyStatePath,
      join(dirname(this.stateDir), 'polymarket-paper-state.json'),
      join(dirname(this.stateDir), 'polymarket-paper-state.json.bak')
    ].filter(Boolean);

    for (const legacyPath of candidates) {
      let parsed = await readJsonFileOptional(legacyPath);
      if (!parsed) {
        parsed = await repairTruncatedStateFile(legacyPath);
      }
      if (!parsed) continue;

      this.state = migrateState(parsed);
      await this.persist('all');
      try {
        await rename(legacyPath, `${legacyPath}.migrated-${Date.now()}.bak`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      console.warn(`Polymarket state migrated from legacy file: ${legacyPath}`);
      return true;
    }
    return false;
  }

  async restoreSplitStateFromLegacyBackups() {
    const candidates = [
      join(dirname(this.stateDir), 'polymarket-paper-state.json.bak'),
      join(dirname(this.stateDir), 'polymarket-paper-state.json.migrated-1783310787020.bak'),
      join(dirname(this.stateDir), 'polymarket-paper-state.json.pre-merge-1783310660514.bak')
    ];
    for (const legacyPath of candidates) {
      const parsed = await readJsonFileOptional(legacyPath);
      if (!parsed?.plans) continue;
      let changed = false;
      for (const planId of PLAN_IDS) {
        // 已有分片主文件或 bak（含重置后的空账户）绝不用 legacy 覆盖
        if (await pathExists(this.planStatePaths[planId]) || await pathExists(`${this.planStatePaths[planId]}.bak`)) {
          continue;
        }
        const legacyBucket = parsed.plans[planId];
        if (!legacyBucket || !bucketHasData(legacyBucket)) continue;
        this.state.plans[planId] = mergePlanBucket(planId, legacyBucket);
        changed = true;
      }
      if (!(await pathExists(this.liveStatePath)) && !(await pathExists(`${this.liveStatePath}.bak`)) && !this.state.liveOrders?.length) {
        const rootLive = await readJsonFileOptional(join(dirname(this.stateDir), 'live-state.json'));
        if (rootLive?.liveOrders?.length) {
          this.state.liveOrders = rootLive.liveOrders;
          this.state.liveControl = { ...DEFAULT_STATE.liveControl, ...(rootLive.liveControl || {}) };
          this.state.liveAuto = {
            ...DEFAULT_STATE.liveAuto,
            ...(rootLive.liveAuto || {}),
            lastFlipAt: rootLive.liveAuto?.lastFlipAt || {},
            riskControls: {
              ...DEFAULT_STATE.liveAuto.riskControls,
              ...(rootLive.liveAuto?.riskControls || {})
            }
          };
          changed = true;
        }
      }
      if (!changed) continue;
      await this.persist('all');
      console.warn(`Polymarket split state restored from legacy backup: ${legacyPath}`);
      return true;
    }
    return false;
  }

  async normalizeAutoState() {
    let changed = false;
    for (const planId of PLAN_IDS) {
      const bucket = this.getBucket(planId);
      if (bucket.auto.enabled && !bucket.portfolio.portfolioInitialized) {
        bucket.auto.enabled = false;
        changed = true;
      }
      const hasSymbols = Array.isArray(bucket.auto?.symbols) && bucket.auto.symbols.length > 0;
      if (!hasSymbols) {
        bucket.auto = {
          ...bucket.auto,
          symbols: [...LIVE_AUTO_SYMBOLS]
        };
        changed = true;
      } else {
        const normalized = normalizeLiveSymbols(bucket.auto.symbols);
        if (normalized.join(',') !== bucket.auto.symbols.join(',')) {
          bucket.auto.symbols = normalized;
          changed = true;
        }
      }
    }
    const retiredPlan2 = this.getBucket('plan2');
    if (retiredPlan2.auto?.enabled) {
      retiredPlan2.auto = {
        ...retiredPlan2.auto,
        enabled: false,
        stoppedAtIso: new Date().toISOString(),
        lastAction: 'retired',
        lastReason: '已合并到 Plan2.5'
      };
      changed = true;
    }
    const liveAuto = this.state.liveAuto || {};
    const legacyLiveEnabled = Array.isArray(liveAuto.enabledPlans) && liveAuto.enabledPlans.includes('plan2');
    if (legacyLiveEnabled || (liveAuto.enabled && liveAuto.planId === 'plan2')) {
      const enabledPlans = [...new Set((liveAuto.enabledPlans || [liveAuto.planId])
        .map((planId) => planId === 'plan2' ? 'plan2_5' : planId))];
      const planRuns = this.ensureLiveAutoPlanRuns(liveAuto.planRuns);
      planRuns.plan2 = {
        ...planRuns.plan2,
        enabled: false,
        stoppedAtIso: new Date().toISOString(),
        lastAction: 'retired',
        lastReason: '已合并到 Plan2.5'
      };
      this.state.liveAuto = {
        ...liveAuto,
        planId: liveAuto.planId === 'plan2' ? 'plan2_5' : liveAuto.planId,
        enabledPlans,
        planRuns
      };
      changed = true;
    }
    const normalizedPlanRuns = this.ensureLiveAutoPlanRuns(liveAuto.planRuns);
    const normalizedEnabledPlans = this.resolveLiveAutoEnabledPlans(liveAuto);
    const currentEnabledPlans = Array.isArray(liveAuto.enabledPlans) ? liveAuto.enabledPlans : [];
    const hasRetiredLiveState = Object.keys(liveAuto.planRuns || {}).some((planId) => !PLAN_IDS.includes(planId))
      || currentEnabledPlans.some((planId) => !PLAN_IDS.includes(planId))
      || (liveAuto.planId && !PLAN_IDS.includes(liveAuto.planId));
    if (hasRetiredLiveState) {
      this.state.liveAuto = {
        ...(this.state.liveAuto || {}),
        enabled: normalizedEnabledPlans.length > 0,
        enabledPlans: normalizedEnabledPlans,
        planId: normalizedEnabledPlans[0] || 'plan1',
        planRuns: normalizedPlanRuns
      };
      changed = true;
    }
    if (changed) await this.persist('all');
  }

  normalizePlanId(planId = 'plan1') {
    return PLAN_IDS.includes(planId) ? planId : 'plan1';
  }

  isPlan2FamilyPlan(planId = 'plan1') {
    return isPlan2Family(this.normalizePlanId(planId));
  }

  appliesLiveGlobalLossRecovery(planId = 'plan1') {
    const id = this.normalizePlanId(planId);
    if (id === 'plan3' || id === 'plan3_5' || id === 'plan3_6') return false;
    if (id === 'plan1') return this.config.plan1ApplyLossStreakRecovery === true;
    if (id === PLAN11_ID) return this.config.plan11ApplyLossStreakRecovery === true;
    if (id === 'plan5') return this.config.plan5ApplyLossStreakScale !== false;
    return true;
  }

  resolvePlan2Config(planId = 'plan2') {
    return resolvePlan2ProfileConfig(this.config, this.normalizePlanId(planId));
  }

  isPlan2ExitSyncedToPaperFor(planId = 'plan2') {
    const cfg = this.resolvePlan2Config(planId);
    if (cfg.plan2LiveSyncPaperExitEnabled === false) return false;
    if (cfg.plan2LiveSyncPaperExitEnabled === true) return true;
    return cfg.plan2LiveSyncPaperEnabled !== false;
  }

  /**
   * Paper plan2_5 / plan2_6 hold to expiry when SYNC_PAPER_EXIT is on.
   * Plan13 always keeps live/paper hard SL (no TP this version).
   */
  isPlan2LiveEarlyExitEnabled(planId = 'plan2') {
    const id = this.normalizePlanId(planId);
    if (id === PLAN13_ID) return true;
    if ((id === 'plan2_5' || id === 'plan2_6') && this.isPlan2ExitSyncedToPaperFor(id)) {
      return false;
    }
    return true;
  }

  isPlan2TakeProfitEnabled(planId = 'plan2') {
    if (this.normalizePlanId(planId) === PLAN13_ID) return false;
    return this.config.plan2TakeProfitEnabled !== false;
  }

  /** Hard SL remains available even when paper-exit sync would otherwise hold to settlement. */
  isPlan2LiveHardStopLossEnabled(planId = 'plan2') {
    const id = this.normalizePlanId(planId);
    if (id === PLAN13_ID) return this.config.plan13StopLossEnabled !== false;
    if (!this.isPlan2FamilyPlan(planId)) return this.config.plan2StopLossEnabled !== false;
    return this.config.plan2StopLossEnabled !== false;
  }

  isPlan2TrailingTakeProfitEnabled(planId = 'plan2') {
    const id = this.normalizePlanId(planId);
    if (id === PLAN13_ID || id === 'plan2_5' || id === 'plan2_6') return false;
    if (!this.isPlan2FamilyPlan(planId)) return false;
    return this.config.plan2TrailingTakeProfitEnabled === true;
  }

  applyPlan2TrailingPeak(position, currentPrice) {
    if (!position || !this.isPlan2TrailingTakeProfitEnabled(position.planId)) {
      return { changed: false, trail: null };
    }
    const entryPrice = Number(position.entryPrice ?? position.limitPrice);
    const trail = updateAndEvaluateTrailingTakeProfit({
      entryPrice,
      currentPrice,
      peakPrice: position.peakPrice,
      trailOffset: Number(this.config.plan2TrailingTakeProfitOffset) || 0.10
    });
    const prevPeak = Number(position.peakPrice);
    const nextPeak = Number(trail.peakPrice);
    const peakChanged = Number.isFinite(nextPeak) && nextPeak !== prevPeak;
    if (Number.isFinite(nextPeak)) position.peakPrice = nextPeak;
    if (Number.isFinite(Number(trail.trailStopPrice))) {
      position.trailStopPrice = Number(trail.trailStopPrice);
    }
    return { changed: peakChanged, trail };
  }

  isPlan2EntrySyncedToPaperFor(planId = 'plan2') {
    return this.resolvePlan2Config(planId).plan2LiveSyncPaperEntryEnabled === true;
  }

  getBucket(planId = 'plan1') {
    const id = this.normalizePlanId(planId);
    if (!this.state.plans[id]) {
      this.state.plans[id] = freshPlanBucket(id);
    }
    return this.state.plans[id];
  }

  buildPlan5RulesSnapshot() {
    const cfg = this.config;
    return {
      enabled: cfg.plan5Enabled !== false,
      liveEnabled: cfg.plan5LiveEnabled === true,
      liveImmediateOnly: cfg.plan5LiveImmediateOnly !== false,
      liveFakBumpSteps: Math.max(0, Number(cfg.plan5LiveFakBumpSteps) || 0),
      liveViewTimeoutMs: Math.max(1000, Number(cfg.plan5LiveViewTimeoutMs) || 25000),
      strategyVersion: PLAN5_VERSION,
      weakCashPct: cfg.plan5WeakCashPct,
      normalCashPct: cfg.plan5NormalCashPct,
      strongCashPct: cfg.plan5StrongCashPct,
      minOrderUsd: cfg.plan5MinOrderUsd,
      liveMinOrderUsd: cfg.plan5LiveMinOrderUsd,
      consensusEnabled: cfg.plan5ConsensusEnabled === true,
      consensusMinConfidence5m: cfg.plan5ConsensusMinConfidence5m,
      consensusMinConfidence15m: cfg.plan5ConsensusMinConfidence15m,
      consensusMinPmGap5m: cfg.plan5ConsensusMinPmGap5m,
      consensusMinPmGap15m: cfg.plan5ConsensusMinPmGap15m,
      consensusRequireTechnicalAlignment: cfg.plan5ConsensusRequireTechnicalAlignment !== false,
      consensusRequireSpotAlignment: cfg.plan5ConsensusRequireSpotAlignment !== false,
      historyGateEnabled: cfg.plan5HistoryGateEnabled !== false,
      historyGateMode: cfg.plan5HistoryGateMode || 'soft',
      historyRecentLookbackDays: cfg.plan5HistoryLookbackDays,
      historyLongTermLookbackDays: cfg.plan5LongTermLookbackDays,
      learningRecentWeight: cfg.plan5LearningRecentWeight,
      learningRecentWeightMin: cfg.plan5LearningRecentWeightMin,
      learningRecentWeightMax: cfg.plan5LearningRecentWeightMax,
      learningDriftThreshold: cfg.plan5LearningDriftThreshold,
      learningConservativeZ: cfg.plan5LearningConservativeZ,
      historyMargin: cfg.plan5HistoryMargin,
      historyHardRejectGap: cfg.plan5HistoryHardRejectGap,
      evGateMode: cfg.plan5EvGateMode || 'soft',
      evHardRejectRoi: cfg.plan5EvHardRejectRoi,
      evMargin: cfg.plan5EvMargin,
      evStrictExecutionEnabled: cfg.plan5EvStrictExecutionEnabled === true,
      evExecutionPriceBufferAbs: cfg.plan5EvExecutionPriceBufferAbs,
      evLiveWeight: cfg.plan5EvLiveWeight,
      evPaperWeight: cfg.plan5EvPaperWeight,
      evRecencyHalfLifeDays: cfg.plan5EvRecencyHalfLifeDays,
      evStrategyVersionIsolationEnabled: cfg.plan5EvStrategyVersionIsolationEnabled === true,
      evRealizedRoiWeight: cfg.plan5EvRealizedRoiWeight,
      evRealizedRoiWeightLive: cfg.plan5EvRealizedRoiWeightLive,
      evLiveOnlyEnabled: cfg.plan5EvLiveOnlyEnabled !== false,
      evPaperOnlyEnabled: cfg.plan5EvPaperOnlyEnabled === true,
      evRealizedOverrideEnabled: cfg.plan5EvRealizedOverrideEnabled === true,
      evExploratoryVetoEnabled: cfg.plan5EvExploratoryVetoEnabled !== false,
      evExploratoryMinSamples: cfg.plan5EvExploratoryMinSamples,
      evExploratoryHardRejectRoi: cfg.plan5EvExploratoryHardRejectRoi,
      evExploratoryHardRejectGap: cfg.plan5EvExploratoryHardRejectGap,
      liveParityEnabled: cfg.plan5LiveParityEnabled === true,
      evRecentLiveEnabled: cfg.plan5EvRecentLiveEnabled !== false,
      evRecentLiveMinSamples: cfg.plan5EvRecentLiveMinSamples,
      evRecentLiveLookbackSamples: cfg.plan5EvRecentLiveLookbackSamples,
      evRecentLiveMinRoi: cfg.plan5EvRecentLiveMinRoi,
      stopLossEnabled: cfg.plan5StopLossEnabled !== false,
      conditionalStopPrice: cfg.plan5ConditionalStopPrice,
      emergencyStopPrice: cfg.plan5EmergencyStopPrice,
      signalQualityMode: cfg.plan5SignalQualityMode || 'soft',
      signalQualityMinStableMs5m: cfg.plan5SignalQualityMinStableMs5m,
      signalQualityMinStableMs15m: cfg.plan5SignalQualityMinStableMs15m,
      signalQualityRequireSamplesLive: cfg.plan5SignalQualityRequireSamplesLive !== false,
      signalQualityMaxPullback: cfg.plan5SignalQualityMaxPullback,
      signalQualityMaxReverseBps: cfg.plan5SignalQualityMaxReverseBps,
      lockedSignalSizingOnlyEnabled: cfg.plan5LockedSignalSizingOnlyEnabled !== false,
      lockedSignalMinSizeScale: cfg.plan5LockedSignalMinSizeScale,
      lockDirectionOptimizationEnabled: cfg.plan5LockDirectionOptimizationEnabled === true,
      directionLookbackDays: cfg.plan5DirectionLookbackDays,
      directionRecentSamples: cfg.plan5DirectionRecentSamples,
      directionMinSamples: cfg.plan5DirectionMinSamples,
      continuityEnabled: cfg.plan5ContinuityEnabled !== false,
      continuityMinSamples: cfg.plan5ContinuityMinSamples,
      continuityMaxWeight: cfg.plan5ContinuityMaxWeight,
      priceCalibrationEnabled: cfg.plan5PriceCalibrationEnabled !== false,
      priceCalibrationMinSamples: cfg.plan5PriceCalibrationMinSamples,
      priceCalibrationWeight: cfg.plan5PriceCalibrationWeight,
      entryTimingEnabled: cfg.plan5EntryTimingEnabled !== false,
      minElapsedPct5m: cfg.plan5MinElapsedPct5m,
      minElapsedPct15m: cfg.plan5MinElapsedPct15m,
      weakMinElapsedPct5m: cfg.plan5WeakMinElapsedPct5m,
      weakMinElapsedPct15m: cfg.plan5WeakMinElapsedPct15m,
      opportunityLogEnabled: cfg.plan5OpportunityLogEnabled !== false,
      shadowEnabled: cfg.plan5ShadowEnabled !== false,
      shadowHypotheticalUsd: cfg.plan5ShadowHypotheticalUsd,
      sameDirBoostEnabled: cfg.plan5SameDirBoostEnabled !== false,
      sameDirBoost: cfg.plan5SameDirBoost,
      sameDirBoostMax: cfg.plan5SameDirBoostMax,
      preOpenEnabled: cfg.plan5PreOpenEnabled === true,
      preOpenMinAccuracy: cfg.plan5PreOpenMinAccuracy,
      preOpenSizeFraction: cfg.plan5PreOpenSizeFraction,
      combinedSizeScaleCap: cfg.plan5CombinedSizeScaleCap,
      slotExposureEnabled: cfg.plan5SlotExposureEnabled === true,
      slotMaxSymbols: cfg.plan5SlotMaxSymbols,
      slotMaxExposurePct: cfg.plan5SlotMaxExposurePct,
      basketAllocationEnabled: cfg.plan5BasketAllocationEnabled !== false,
      basketMaxSymbols: cfg.plan5BasketMaxSymbols,
      basketPrimaryShare: cfg.plan5BasketPrimaryShare,
      basketMinExpectedRoi: cfg.plan5BasketMinExpectedRoi,
      basketMinNetEdge: cfg.plan5BasketMinNetEdge,
      liveLossCircuitEnabled: cfg.plan5LiveLossCircuitEnabled === true,
      liveLossCircuitMaxLosses: cfg.plan5LiveLossCircuitMaxLosses,
      liveLossCircuitCooldownEnabled: cfg.plan5LiveLossCircuitCooldownEnabled === true,
      liveLossCircuitCooldownMs: cfg.plan5LiveLossCircuitCooldownMs,
      minEntryPrice: cfg.plan5MinEntryPrice,
      maxEntryPrice: cfg.plan5MaxEntryPrice,
      paperRequireAskFillable: cfg.plan5PaperRequireAskFillable !== false,
      paperFillSlippageTicks: cfg.plan5PaperFillSlippageTicks,
      paperFillTickSize: cfg.plan5PaperFillTickSize,
      applyLossStreakScale: cfg.plan5ApplyLossStreakScale === true,
      exitMode: 'hold_to_settlement'
    };
  }

  buildPlan3RulesSnapshot() {
    const cfg = this.config;
    const runtime = resolvePlan3RuntimeConfig(cfg);
    const liveWide = isPlan3WideBandRuntimeEnabled(cfg) && cfg.plan3LiveEnabled === true;
    const paperWide = isPlan3WideBandRuntimeEnabled(cfg) && cfg.plan3LiveEnabled !== true;
    let entryType = 'settlement_capture (late 99¢+)';
    if (liveWide || paperWide) {
      entryType = `settlement_capture (wide ${((runtime.plan3MinPrice || 0.93) * 100).toFixed(0)}–${((runtime.plan3MaxPrice || 0.998) * 100).toFixed(1)}¢)`;
    }

    return {
      strategyVersion: PLAN3_VERSION,
      enabled: cfg.plan3Enabled === true,
      liveEnabled: cfg.plan3LiveEnabled === true,
      liveWideBandEnabled: liveWide,
      earlyCaptureLiveEnabled: cfg.plan3EarlyCaptureLiveEnabled === true,
      entryType,
      earlyCaptureEnabled: cfg.plan3EarlyCaptureEnabled !== false,
      earlyPriceBand: `${((cfg.plan3EarlyMinPrice || 0.90) * 100).toFixed(0)}–${((cfg.plan3EarlyMaxPrice || 0.989) * 100).toFixed(1)}¢`,
      earlySecondsWindow5m: `${cfg.plan3EarlyMinSecondsRemaining5m || 46}–${cfg.plan3EarlyMaxSecondsRemaining5m || 120}s`,
      earlySecondsWindow15m: `${cfg.plan3EarlyMinSecondsRemaining15m || 91}–${cfg.plan3EarlyMaxSecondsRemaining15m || 180}s`,
      earlyMinDistanceBps5m: cfg.plan3EarlyMinDistanceBps5m,
      earlyMinDistanceBps15m: cfg.plan3EarlyMinDistanceBps15m,
      secondsWindow5m: `${runtime.plan3MinSecondsRemaining5m ?? cfg.plan3MinSecondsRemaining5m ?? 3}–${runtime.plan3MaxSecondsRemaining5m ?? cfg.plan3MaxSecondsRemaining5m ?? 10}s`,
      secondsWindow15m: `${runtime.plan3MinSecondsRemaining15m ?? cfg.plan3MinSecondsRemaining15m ?? 5}–${runtime.plan3MaxSecondsRemaining15m ?? cfg.plan3MaxSecondsRemaining15m ?? 20}s`,
      minDistanceBps5m: runtime.plan3MinDistanceBps5m ?? cfg.plan3MinDistanceBps5m,
      minDistanceBps15m: runtime.plan3MinDistanceBps15m ?? cfg.plan3MinDistanceBps15m,
      maxReverseBps: runtime.plan3MaxReverseBps ?? cfg.plan3MaxReverseBps,
      reverseLookbackSeconds: cfg.plan3ReverseLookbackSeconds,
      minPrice: runtime.plan3MinPrice ?? cfg.plan3MinPrice,
      maxPrice: runtime.plan3MaxPrice ?? cfg.plan3MaxPrice,
      priceMode: cfg.plan3PriceMode,
      minMarketQuality: runtime.plan3MinMarketQuality ?? cfg.plan3MinMarketQuality,
      maxSpread: runtime.plan3MaxSpread ?? cfg.plan3MaxSpread,
      orderPct: cfg.plan3OrderPct,
      probSizingEnabled: cfg.plan3ProbSizingEnabled !== false,
      probSizingReference: `$${cfg.plan3ProbSizingReferenceOrderUsd} @ ${(cfg.plan3ProbSizingReferencePrice * 100).toFixed(0)}¢ on $${cfg.plan3ProbSizingReferenceEquity}`,
      maxOrderPct: cfg.plan3MaxOrderPct,
      maxSlotExposurePct: cfg.plan3MaxSlotExposurePct,
      dailyLossLimitPct: cfg.plan3DailyLossLimitPct,
      dailyLossLimitEnabled: false,
      stopAfterOneLoss: cfg.plan3StopAfterOneLoss === true,
      paperDirectFill: cfg.plan3PaperDirectFill === true,
      paperSimulateFakBump: cfg.plan3PaperSimulateFakBump !== false,
      paperFillBumpSteps: Number(cfg.plan3BandStatsFillBumpSteps) || 0,
      bandStatsPreferLive: cfg.plan3BandStatsPreferLive !== false,
      bandStatsHierarchy: 'symbol_price -> symbol_band -> global_band',
      bandStatsMinSamples: cfg.plan3BandStatsMinSamples,
      bandStatsMargin: cfg.plan3BandStatsMargin,
      legacyPlan35Merged: cfg.plan3MergePlan35History !== false,
      paperRelaxedEnabled: cfg.plan3PaperRelaxedEnabled !== false,
      paperMinDirectionalBps: cfg.plan3PaperMinDirectionalBps,
      paperMinDistanceBps5m: cfg.plan3PaperMinDistanceBps5m,
      paperMinDistanceBps15m: cfg.plan3PaperMinDistanceBps15m,
      paperWideBandEnabled: cfg.plan3PaperWideBandEnabled !== false,
      paper15mEnabled: cfg.plan3Paper15mEnabled !== false,
      paperMinOrderUsd: runtime.plan3MinOrderUsd,
      paperMaxOrderPct: runtime.plan3MaxOrderPct,
      paperWidePriceBand: `${((cfg.plan3PaperWideMinPrice || 0.93) * 100).toFixed(0)}–${((cfg.plan3PaperWideMaxPrice || 0.998) * 100).toFixed(1)}¢`,
      paperWideSecondsWindow5m: `${cfg.plan3MinSecondsRemaining5m || 3}–${cfg.plan3PaperWideMaxSecondsRemaining5m || 120}s`,
      paperWideSecondsWindow15m: `${cfg.plan3MinSecondsRemaining15m || 5}–${cfg.plan3PaperWideMaxSecondsRemaining15m || 180}s`,
      maxOrdersPerSlot: cfg.plan3MaxOrdersPerSlot,
      orderTtlMs5m: cfg.plan3OrderTtlMs5m,
      orderTtlMs15m: cfg.plan3OrderTtlMs15m,
      liveMaxOrderUsd: cfg.plan3LiveMaxOrderUsd,
      fastLoopMs: cfg.plan3FastLoopMs
    };
  }

  buildPlan35RulesSnapshot() {
    const cfg = this.config;
    return {
      enabled: cfg.plan3_5Enabled !== false,
      liveEnabled: cfg.plan3_5LiveEnabled === true,
      archived: cfg.plan3_5Enabled === false,
      mergedInto: cfg.plan3MergePlan35History !== false ? 'plan3' : null,
      entryType: 'last_minute_99',
      minPrice: cfg.plan3_5MinPrice,
      maxSecondsRemaining: cfg.plan3_5MaxSecondsRemaining,
      minSecondsRemaining: cfg.plan3_5MinSecondsRemaining,
      sizePct: cfg.plan3_5SizePct,
      minOrderUsd: cfg.plan3_5MinOrderUsd,
      exitMode: 'hold_to_settlement',
      fastLoopMs: cfg.plan3_5FastLoopMs
    };
  }

  buildPlan36RulesSnapshot() {
    const cfg = this.config;
    return {
      enabled: cfg.plan3_6Enabled !== false,
      liveEnabled: cfg.plan3_6LiveEnabled === true,
      strategyVersion: PLAN3_6_VERSION,
      entryType: 'v6_model_confirmed_favorite',
      cheapSideBand: {
        minPrice: cfg.plan3_6CheapMinPrice,
        maxPrice: cfg.plan3_6CheapMaxPrice
      },
      favoriteBand: {
        minPrice: cfg.plan3_6FavoriteMinPrice,
        maxPrice: cfg.plan3_6FavoriteMaxPrice
      },
      primaryLane: {
        timeframe: '5m',
        mode: 'model_confirmed_favorite'
      },
      shadow15mLane: {
        timeframe: '15m',
        mode: 'paper_trade_live_observe_only'
      },
      paper1hLane: {
        timeframe: '1h',
        mode: 'paper_trade_live_observe_only'
      },
      paper1dLane: {
        timeframe: '1d',
        mode: 'paper_trade_live_observe_only'
      },
      paperTimeframes: [...PLAN3_6_PAPER_TIMEFRAMES],
      liveTimeframes: [...PLAN3_6_LIVE_TIMEFRAMES],
      liveBlockedRetryAfterMs: cfg.plan3_6LiveBlockedRetryAfterMs,
      liveBlockedRetryMaxPerKey: cfg.plan3_6LiveBlockedRetryMaxPerKey,
      liveFakBumpSteps: cfg.plan3_6LiveFakBumpSteps,
      minSignalConfidence: cfg.plan3_6MinSignalConfidence,
      maxOverround: cfg.plan3_6MaxOverround,
      paperSlippageTicks: cfg.plan3_6PaperSlippageTicks,
      paperTickSize: cfg.plan3_6PaperTickSize,
      orderUsd: cfg.plan3_6OrderUsd,
      minSecondsRemaining: cfg.plan3_6MinSecondsRemaining,
      maxSecondsRemaining5m: cfg.plan3_6MaxSecondsRemaining5m,
      maxSecondsRemaining15m: cfg.plan3_6MaxSecondsRemaining15m,
      maxSecondsRemaining1h: cfg.plan3_6MaxSecondsRemaining1h,
      minSecondsRemaining1d: cfg.plan3_6MinSecondsRemaining1d,
      maxSecondsRemaining1d: cfg.plan3_6MaxSecondsRemaining1d,
      exitMode: 'hold_to_settlement',
      fastLoopMs: cfg.plan3_6FastLoopMs
    };
  }

  status(planId = null) {
    if (planId) {
      return this.statusForPlan(planId);
    }
    const plans = Object.fromEntries(PLAN_IDS.map((id) => [id, this.statusForPlan(id)]));
    const plan1Return = plans.plan1.stats.totalReturn;
    const plan2Return = plans.plan2.stats.totalReturn;
    let leader = null;
    if (plans.plan1.portfolio.portfolioInitialized && plans.plan2.portfolio.portfolioInitialized) {
      if (plan1Return > plan2Return) leader = 'plan1';
      else if (plan2Return > plan1Return) leader = 'plan2';
    }
    return {
      enabled: this.config.enabled,
      liveTradingEnabled: this.config.liveTradingEnabled,
      configured: this.config.configured,
      liveMaxOrderUsd: this.config.liveMaxOrderUsd,
      paperTradingEnabled: true,
      defaultOrderUsd: this.config.defaultOrderUsd,
      maxOrderUsd: this.config.maxOrderUsd,
      dailyMaxLossUsd: this.config.dailyMaxLossUsd,
      defaultStartingCash: this.defaultStartingCash,
      sizing: describePolymarketSizing(this.config),
      plan2Rules: {
        entryMinPrice: this.config.plan2EntryMinPrice,
        entryMaxPrice: this.config.plan2EntryMaxPrice,
        minConfidence: this.config.plan2MinConfidence,
        minEdge: this.config.plan2MinEdge,
        takeProfitOffset: this.config.plan2TakeProfitOffset,
        takeProfitEnabled: this.config.plan2TakeProfitEnabled !== false,
        trailingTakeProfitEnabled: this.config.plan2TrailingTakeProfitEnabled === true,
        trailingTakeProfitOffset: Number(this.config.plan2TrailingTakeProfitOffset) || 0.10,
        stopLossOffset: this.config.plan2StopLossOffset,
        stopLossEnabled: this.config.plan2StopLossEnabled !== false,
        plan25LiveExitMode: this.isPlan2LiveEarlyExitEnabled('plan2_5') ? 'tp_sl' : 'hold_to_settlement',
        plan26LiveExitMode: this.isPlan2LiveEarlyExitEnabled('plan2_6') ? 'tp_sl' : 'hold_to_settlement',
        plan13LiveExitMode: 'hard_sl_hold_to_settlement',
        highEntryMinPrice: this.config.plan2HighEntryMinPrice,
        highEntryDelayMs: this.config.plan2HighEntryDelayMs,
        entryMinElapsedPct: this.config.plan2EntryMinElapsedPct,
        maxEntryElapsedPct: this.config.plan2MaxEntryElapsedPct,
        lateCaptureEnabled: this.config.plan2LateCaptureEnabled !== false,
        lateCaptureMinElapsedPct: this.config.plan2LateCaptureMinElapsedPct,
        lateCaptureMaxElapsedPct: this.config.plan2LateCaptureMaxElapsedPct,
        lateCaptureMinPrice: this.config.plan2LateCaptureMinPrice,
        lateCaptureMaxPrice: this.config.plan2LateCaptureMaxPrice,
        lateCaptureMinDistanceBps: this.config.plan2LateCaptureMinDistanceBps,
        lateCaptureMaxReverseBps: this.config.plan2LateCaptureMaxReverseBps,
        lateCaptureSizeMultiplier: this.config.plan2LateCaptureSizeMultiplier,
        ultraLateCaptureEnabled: this.config.plan2UltraLateCaptureEnabled !== false,
        ultraLateCaptureMinPrice: this.config.plan2UltraLateCaptureMinPrice,
        ultraLateCaptureMaxPrice: this.config.plan2UltraLateCaptureMaxPrice,
        ultraLateCaptureMinSeconds5m: this.config.plan2UltraLateCaptureMinSeconds5m,
        ultraLateCaptureMaxSeconds5m: this.config.plan2UltraLateCaptureMaxSeconds5m,
        ultraLateCaptureMinSeconds15m: this.config.plan2UltraLateCaptureMinSeconds15m,
        ultraLateCaptureMaxSeconds15m: this.config.plan2UltraLateCaptureMaxSeconds15m,
        ultraLateCaptureMinDistanceBps: this.config.plan2UltraLateCaptureMinDistanceBps,
        ultraLateCaptureMaxReverseBps: this.config.plan2UltraLateCaptureMaxReverseBps,
        ultraLateCaptureSizeMultiplier: this.config.plan2UltraLateCaptureSizeMultiplier,
        sustainedMomentumEnabled: this.config.plan2SustainedMomentumEnabled !== false,
        sustainedMomentumMinPrice5m: this.config.plan2SustainedMomentumMinPrice5m,
        sustainedMomentumMinPrice15m: this.config.plan2SustainedMomentumMinPrice15m,
        sustainedMomentumMaxPrice5m: this.config.plan2SustainedMomentumMaxPrice5m,
        sustainedMomentumMaxPrice15m: this.config.plan2SustainedMomentumMaxPrice15m,
        sustainedMomentumMaxPullback5m: this.config.plan2SustainedMomentumMaxPullback5m,
        sustainedMomentumMaxPullback15m: this.config.plan2SustainedMomentumMaxPullback15m,
        sustainedMomentumMinElapsedPct5m: this.config.plan2SustainedMomentumMinElapsedPct5m,
        sustainedMomentumMinElapsedPct15m: this.config.plan2SustainedMomentumMinElapsedPct15m,
        sustainedMomentumMaxElapsedPct5m: this.config.plan2SustainedMomentumMaxElapsedPct5m,
        sustainedMomentumMaxElapsedPct15m: this.config.plan2SustainedMomentumMaxElapsedPct15m,
        sustainedMomentumMinSamples5m: this.config.plan2SustainedMomentumMinSamples5m,
        sustainedMomentumMinSamples15m: this.config.plan2SustainedMomentumMinSamples15m,
        sustainedMomentumMinHoldMs5m: this.config.plan2SustainedMomentumMinHoldMs5m,
        sustainedMomentumMinHoldMs15m: this.config.plan2SustainedMomentumMinHoldMs15m,
        sustainedMomentumMinDistanceBps5m: this.config.plan2SustainedMomentumMinDistanceBps5m,
        sustainedMomentumMinDistanceBps15m: this.config.plan2SustainedMomentumMinDistanceBps15m,
        sustainedMomentumMaxReverseBps5m: this.config.plan2SustainedMomentumMaxReverseBps5m,
        sustainedMomentumMaxReverseBps15m: this.config.plan2SustainedMomentumMaxReverseBps15m,
        sustainedMomentumSizeMultiplier5m: this.config.plan2SustainedMomentumSizeMultiplier5m,
        sustainedMomentumSizeMultiplier15m: this.config.plan2SustainedMomentumSizeMultiplier15m,
        sustainedMomentumMinQuality: this.config.plan2SustainedMomentumMinQuality,
        stopLossReversalEnabled: this.config.plan2StopLossReversalEnabled !== false,
        liveSlotLossCircuitEnabled: this.config.plan2LiveSlotLossCircuitEnabled !== false,
        liveSlotLossCircuitMaxLosses: this.config.plan2LiveSlotLossCircuitMaxLosses,
        minMarketQuality: this.config.plan2MinMarketQuality,
        requirePolymarketAlignment: this.config.plan2RequirePolymarketAlignment !== false,
        lowPriceMinPrice: this.config.plan2LowPriceMinPrice,
        lowPriceMinConfidence: this.config.plan2LowPriceMinConfidence,
        lowPriceMinEdge: this.config.plan2LowPriceMinEdge,
        downMinConfidence5m: this.config.plan2DownMinConfidence5m,
        downMinConfidence15m: this.config.plan2DownMinConfidence15m,
        downMinEdge: this.config.plan2DownMinEdge,
        liveProbeEnabled: this.config.plan2LiveProbeEnabled === true
      },
      plan1Rules: {
        entryTiers: 'tier1≤60% tier2≤68% tier3≤75% tier4≤78% (>78% skip)',
        tierMinConfidence: this.config.plan1MinConfidence,
        basketConflictProbeEnabled: this.config.plan1BasketConflictProbeEnabled !== false,
        fiveMinutePathGuardEnabled: this.config.plan1FiveMinutePathGuardEnabled === true,
        historyHierarchyEnabled: this.config.plan1HistoryHierarchyEnabled !== false,
        lateCaptureEnabled: this.config.plan1LateCaptureEnabled !== false,
        maxEntryPrice: this.config.plan1MaxEntryPrice,
        minMarketQuality: this.config.plan1MinMarketQuality ?? this.config.minMarketQuality,
        entryMinElapsedPct: this.config.plan1EntryMinElapsedPct,
        entryMaxElapsedPct: this.config.plan1EntryMaxElapsedPct,
        takeProfitOffset: this.config.plan1TakeProfitOffset,
        stopLossOffset: this.config.plan1StopLossOffset,
        holdToSettlementEnabled: this.config.plan1HoldToSettlementEnabled === true,
        directionFlipEnabled: this.config.plan1DirectionFlipEnabled !== false,
        flipCooldownMs: this.config.plan1FlipCooldownMs,
        flipMinHoldMs: this.config.plan1FlipMinHoldMs,
        flipMinConfidence: this.config.plan1FlipMinConfidence,
        flipMinEdge: this.config.plan1FlipMinEdge,
        flipMaxFloatingLossPct: this.config.plan1FlipMaxFloatingLossPct,
        flipMaxElapsedPct: this.config.plan1FlipMaxElapsedPct
      },
      plan11Rules: buildPlan11RulesSnapshot(this.config),
      plan13Rules: buildPlan13RulesSnapshot(this.config),
      plan14Rules: buildPlan14RulesSnapshot(this.config),
      plan2_6Rules: buildPlan26RulesSnapshot(this.config),
      plan3Rules: this.buildPlan3RulesSnapshot(),
      plan3_5Rules: this.buildPlan35RulesSnapshot(),
      plan3_6Rules: this.buildPlan36RulesSnapshot(),
      plan5Rules: this.buildPlan5RulesSnapshot(),
      liveControl: this.liveControlStatus(),
      liveAuto: this.liveAutoStatus(),
      autoLoopIntervalMs: this.config.autoLoopIntervalMs,
      settlementLoopIntervalMs: this.config.settlementLoopIntervalMs,
      plans,
      comparison: { plan1Return, plan2Return, leader },
      requires: [
        'Polymarket KYC / region eligibility',
        'CLOB L2 API credentials',
        'wallet private key',
        'funded proxy wallet / allowance'
      ],
      warning: '真实下单默认关闭。地区限制和平台合规要求必须由用户自行确认。'
    };
  }

  liveControlStatus(currentBalanceUsdc = null) {
    const control = this.state.liveControl || {};
    const startingBalance = Number(control.startingBalanceUsdc) || 0;
    const hasCurrentBalance = currentBalanceUsdc !== null
      && currentBalanceUsdc !== undefined
      && currentBalanceUsdc !== ''
      && Number.isFinite(Number(currentBalanceUsdc));
    const currentBalance = hasCurrentBalance
      ? Number(currentBalanceUsdc)
      : Number(control.currentBalanceUsdc) || 0;
    const stats = this.computeLiveStats();
    return {
      enabled: Boolean(control.enabled),
      startedAtIso: control.startedAtIso || null,
      stoppedAtIso: control.stoppedAtIso || null,
      startingBalanceUsdc: round2(startingBalance),
      currentBalanceUsdc: round2(currentBalance),
      balanceDeltaUsdc: round2(currentBalance - startingBalance),
      pnlUsdc: stats.realizedPnl,
      totalReturn: stats.totalReturn,
      stats
    };
  }

  async setLiveControl(enabled, { currentBalanceUsdc = null } = {}) {
    const nowIso = new Date().toISOString();
    const currentBalance = Math.max(0, Number(currentBalanceUsdc) || 0);
    const existing = this.state.liveControl || DEFAULT_STATE.liveControl;
    const lastValidBalance = currentBalance > 0
      ? currentBalance
      : Math.max(
        0,
        Number(existing.lastValidBalanceUsdc) || Number(existing.currentBalanceUsdc) || 0
      );
    this.state.liveControl = {
      ...existing,
      enabled: Boolean(enabled),
      currentBalanceUsdc: currentBalance,
      lastValidBalanceUsdc: lastValidBalance,
      balanceUpdatedAtIso: currentBalance > 0 ? nowIso : existing.balanceUpdatedAtIso || null,
      startedAtIso: enabled ? nowIso : existing.startedAtIso || null,
      stoppedAtIso: enabled ? null : nowIso,
      startingBalanceUsdc: enabled ? currentBalance : Number(existing.startingBalanceUsdc) || 0
    };
    await this.persist('live');
    return this.liveControlStatus(currentBalance);
  }

  async updateLiveControlBalance(currentBalanceUsdc = 0) {
    if (!this.state.liveControl) this.state.liveControl = { ...DEFAULT_STATE.liveControl };
    const next = Math.max(0, Number(currentBalanceUsdc) || 0);
    const prev = Number(this.state.liveControl.currentBalanceUsdc) || 0;
    if (prev > 0 && !(Number(this.state.liveControl.lastValidBalanceUsdc) > 0)) {
      this.state.liveControl.lastValidBalanceUsdc = prev;
    }
    // CLOB 瞬时读到 $0 很常见：不要把 current 写成 0 污染后续硬拦/UI
    if (next <= 0) {
      const keep = prev > 0
        ? prev
        : Math.max(0, Number(this.state.liveControl.lastValidBalanceUsdc) || 0);
      return this.liveControlStatus(keep > 0 ? keep : 0);
    }
    this.state.liveControl.currentBalanceUsdc = next;
    this.state.liveControl.lastValidBalanceUsdc = next;
    this.state.liveControl.balanceUpdatedAtIso = new Date().toISOString();
    // 纸面/status 轮询很密：余额无实质变化时跳过落盘，避免拖死整站
    const changedEnough = Math.abs(next - prev) >= 0.01;
    const lastPersistMs = Number(this._liveBalancePersistAtMs) || 0;
    const due = (Date.now() - lastPersistMs) >= 30_000;
    if (changedEnough && due) {
      this._liveBalancePersistAtMs = Date.now();
      await this.persist('live');
    }
    return this.liveControlStatus(next);
  }

  freshLiveAutoPlanRun() {
    return {
      enabled: false,
      startedAtIso: null,
      stoppedAtIso: null,
      lastRunAtIso: null,
      lastAction: null,
      lastReason: null,
      lastError: null,
      lastOrderId: null
    };
  }

  ensureLiveAutoPlanRuns(planRuns = {}) {
    return Object.fromEntries(PLAN_IDS.map((planId) => [
      planId,
      { ...this.freshLiveAutoPlanRun(), ...(planRuns[planId] || {}) }
    ]));
  }

  resolveLiveAutoEnabledPlans(auto = {}) {
    const merged = { ...DEFAULT_STATE.liveAuto, ...(auto || {}) };
    let enabled = [];
    if (Array.isArray(merged.enabledPlans) && merged.enabledPlans.length) {
      enabled = merged.enabledPlans
        .map((planId) => String(planId || '').toLowerCase())
        .filter((planId) => PLAN_IDS.includes(planId))
        .map((planId) => planId === 'plan2' ? 'plan2_5' : planId)
        .filter((planId) => PLAN_IDS.includes(planId));
    } else if (merged.enabled && merged.planId) {
      const normalized = String(merged.planId || '').toLowerCase();
      if (PLAN_IDS.includes(normalized)) {
        enabled = [normalized === 'plan2' ? 'plan2_5' : normalized];
      }
    }
    if (this.config.plan3MergePlan35History !== false && enabled.includes('plan3_5')) {
      enabled = enabled.filter((planId) => planId !== 'plan3_5');
      enabled.push('plan3');
    }
    // 未显式打开时：即使状态里残留 plan5，也不跑实盘
    if (this.config.plan5LiveEnabled !== true) {
      enabled = enabled.filter((planId) => planId !== 'plan5');
    }
    if (this.config.plan3LiveEnabled !== true) {
      enabled = enabled.filter((planId) => planId !== 'plan3');
    }
    if (this.config.plan3_5LiveEnabled !== true) {
      enabled = enabled.filter((planId) => planId !== 'plan3_5');
    }
    if (this.config.plan3_6LiveEnabled !== true) {
      enabled = enabled.filter((planId) => planId !== 'plan3_6');
    }
    // Plan2.6 live never auto-starts; require explicit LIVE_ENABLED + manual start.
    if (this.config.plan2_6LiveEnabled !== true) {
      enabled = enabled.filter((planId) => planId !== PLAN2_6_ID);
    }
    if (this.config.plan11LiveEnabled !== true) {
      enabled = enabled.filter((planId) => planId !== PLAN11_ID);
    }
    if (this.config.plan13LiveEnabled !== true) {
      enabled = enabled.filter((planId) => planId !== PLAN13_ID);
    }
    // Plan14 is a forward-validation experiment. Historical selection alone
    // can never put it into the live scheduler.
    enabled = enabled.filter((planId) => planId !== PLAN14_ID && planId !== PLAN15_ID && planId !== PLAN16_ID && planId !== PLAN17_ID && planId !== PLAN18_ID && planId !== PLAN19_ID);
    if (this.config.plan5Enabled !== true) {
      enabled = enabled.filter((planId) => planId !== 'plan5');
    }
    return PLAN_IDS.filter((planId) => enabled.includes(planId));
  }

  liveAutoPlanStatus(auto = {}, planId = 'plan1') {
    const id = this.normalizePlanId(planId);
    const enabledPlans = this.resolveLiveAutoEnabledPlans(auto);
    const planRuns = this.ensureLiveAutoPlanRuns(auto.planRuns);
    const run = planRuns[id] || this.freshLiveAutoPlanRun();
    return {
      planId: id,
      enabled: enabledPlans.includes(id),
      startedAtIso: run.startedAtIso || null,
      stoppedAtIso: run.stoppedAtIso || null,
      lastRunAtIso: run.lastRunAtIso || null,
      lastAction: run.lastAction || null,
      lastReason: run.lastReason || null,
      lastError: run.lastError || null,
      lastOrderId: run.lastOrderId || null
    };
  }

  liveAutoStatus() {
    this.pruneLivePlan2DelayedEntries();
    const auto = {
      ...DEFAULT_STATE.liveAuto,
      ...(this.state.liveAuto || {}),
      riskControls: {
        ...DEFAULT_STATE.liveAuto.riskControls,
        ...(this.state.liveAuto?.riskControls || {}),
        globalDailyLossProtectionEnabled: this.isGlobalDailyLossProtectionEnabled()
      }
    };
    delete auto.riskControls.plan3DailyLossLimitEnabled;
    const enabledPlans = this.resolveLiveAutoEnabledPlans(auto);
    const planRuns = this.ensureLiveAutoPlanRuns(auto.planRuns);
    const plans = Object.fromEntries(
      PLAN_IDS.map((planId) => [planId, this.liveAutoPlanStatus({ ...auto, planRuns }, planId)])
    );
    const latestRun = PLAN_IDS
      .map((planId) => plans[planId])
      .filter((run) => run.lastRunAtIso)
      .sort((left, right) => new Date(right.lastRunAtIso).getTime() - new Date(left.lastRunAtIso).getTime())[0]
      || null;
    return {
      enabled: enabledPlans.length > 0,
      enabledPlans,
      plans,
      planId: enabledPlans[0] || this.normalizePlanId(auto.planId),
      timeframes: normalizeTimeframes(auto.timeframes),
      symbols: normalizeLiveSymbols(auto.symbols),
      lastExecutedKeys: auto.lastExecutedKeys || [],
      lastRunAtIso: latestRun?.lastRunAtIso || auto.lastRunAtIso || null,
      lastError: latestRun?.lastError || auto.lastError || null,
      lastAction: latestRun?.lastAction || auto.lastAction || null,
      lastReason: latestRun?.lastReason || auto.lastReason || null,
      lastOrderId: latestRun?.lastOrderId || auto.lastOrderId || null,
      startedAtIso: auto.startedAtIso || null,
      stoppedAtIso: auto.stoppedAtIso || null,
      riskControls: auto.riskControls,
      globalDailyLoss: this.globalLiveDailyLossSnapshot({
        clobBalanceUsdc: this.state.liveControl?.currentBalanceUsdc
      }),
      pendingDelayedCount: Object.keys(auto.pendingDelayedEntries || {}).length
    };
  }

  isGlobalDailyLossProtectionEnabled() {
    const controls = this.state.liveAuto?.riskControls || {};
    if (Object.hasOwn(controls, 'plan3DailyLossLimitEnabled')) {
      return controls.plan3DailyLossLimitEnabled !== false;
    }
    if (Object.hasOwn(controls, 'globalDailyLossProtectionEnabled')) {
      return controls.globalDailyLossProtectionEnabled !== false;
    }
    return this.config.globalDailyLossProtectionEnabled !== false;
  }

  isPlan3DailyLossLimitEnabled() {
    return this.isGlobalDailyLossProtectionEnabled();
  }

  async setLiveRiskControls(controls = {}) {
    const existing = {
      ...DEFAULT_STATE.liveAuto,
      ...(this.state.liveAuto || {}),
      riskControls: {
        ...DEFAULT_STATE.liveAuto.riskControls,
        ...(this.state.liveAuto?.riskControls || {})
      }
    };
    const nextControls = { ...existing.riskControls };
    const hasGlobalControl = Object.hasOwn(controls, 'globalDailyLossProtectionEnabled');
    const hasLegacyControl = Object.hasOwn(controls, 'plan3DailyLossLimitEnabled');
    if (hasGlobalControl || hasLegacyControl) {
      const enabled = hasGlobalControl
        ? controls.globalDailyLossProtectionEnabled !== false
        : controls.plan3DailyLossLimitEnabled !== false;
      nextControls.globalDailyLossProtectionEnabled = enabled;
      delete nextControls.plan3DailyLossLimitEnabled;
      if (!enabled) {
        const daily = this.refreshPlan3Daily('plan3');
        if (daily.stopReason === 'daily_loss_limit_reached') {
          daily.stopped = false;
          daily.stopReason = null;
        }
      }
    }
    this.state.liveAuto = {
      ...existing,
      riskControls: nextControls
    };
    await this.persist('all');
    return this.liveAutoStatus();
  }

  async setLiveAutoTimeframes(timeframes = ['5m', '15m']) {
    const existing = {
      ...DEFAULT_STATE.liveAuto,
      ...(this.state.liveAuto || {}),
      riskControls: {
        ...DEFAULT_STATE.liveAuto.riskControls,
        ...(this.state.liveAuto?.riskControls || {})
      }
    };
    this.state.liveAuto = {
      ...existing,
      timeframes: normalizeTimeframes(timeframes)
    };
    await this.persist('live');
    return this.liveAutoStatus();
  }

  async setLiveAutoSymbols(symbols = ['BTC-USD']) {
    const existing = {
      ...DEFAULT_STATE.liveAuto,
      ...(this.state.liveAuto || {}),
      riskControls: {
        ...DEFAULT_STATE.liveAuto.riskControls,
        ...(this.state.liveAuto?.riskControls || {})
      }
    };
    this.state.liveAuto = {
      ...existing,
      symbols: normalizeLiveSymbols(symbols)
    };
    await this.persist('live');
    return this.liveAutoStatus();
  }

  async setLiveAutoPlan(planId, enabled, { timeframes = null, symbols = null } = {}) {
    let id = this.normalizePlanId(planId);
    if (id === 'plan2') id = 'plan2_5';
    if (id === 'plan3_5' && this.config.plan3MergePlan35History !== false) id = 'plan3';
    if (id === 'plan3' && enabled && this.config.plan3LiveEnabled !== true) {
      throw new Error('Plan3 合并策略实盘需 POLYMARKET_PLAN3_LIVE_ENABLED=true。');
    }
    if (id === 'plan5' && this.config.plan5Enabled === false) {
      throw new Error('Plan5 已禁用（POLYMARKET_PLAN5_ENABLED=false）。');
    }
    if (id === 'plan5' && enabled && this.config.plan5LiveEnabled !== true) {
      throw new Error('Plan5 实盘需 POLYMARKET_PLAN5_LIVE_ENABLED=true。');
    }
    if (id === 'plan3_6' && enabled && this.config.plan3_6LiveEnabled !== true) {
      throw new Error('Plan3.6 实盘需 POLYMARKET_PLAN3_6_LIVE_ENABLED=true。');
    }
    if (id === 'plan3_5' && enabled && this.config.plan3_5LiveEnabled !== true) {
      throw new Error('Plan3.5 实盘需 POLYMARKET_PLAN3_5_LIVE_ENABLED=true。');
    }
    if (id === PLAN2_6_ID && enabled && this.config.plan2_6LiveEnabled !== true) {
      throw new Error('Plan2.6 实盘需 POLYMARKET_PLAN2_6_LIVE_ENABLED=true。');
    }
    if (id === PLAN2_6_ID && enabled && this.config.plan2_6Enabled === false) {
      throw new Error('Plan2.6 已禁用（POLYMARKET_PLAN2_6_ENABLED=false）。');
    }
    if (id === PLAN11_ID && enabled && this.config.plan11LiveEnabled !== true) {
      throw new Error('Plan11 实盘需 POLYMARKET_PLAN11_LIVE_ENABLED=true。');
    }
    if (id === PLAN11_ID && enabled && this.config.plan11Enabled === false) {
      throw new Error('Plan11 已禁用（POLYMARKET_PLAN11_ENABLED=false）。');
    }
    if (id === PLAN14_ID && enabled) {
      throw new Error('Plan14 仅用于前向模拟验证，当前禁止实盘。');
    }
    if (id === PLAN15_ID && enabled) {
      throw new Error('Plan15 仅用于事件盘模拟，当前禁止实盘。');
    }
    if (id === PLAN16_ID && enabled) {
      throw new Error('Plan16 仅用于天气预报模拟，当前禁止实盘。');
    }
    if (id === PLAN17_ID && enabled) {
      throw new Error('Plan17 仅用于价格档位盘模拟，当前禁止实盘。');
    }
    if ((id === PLAN18_ID || id === PLAN19_ID) && enabled) {
      throw new Error(`${id === PLAN18_ID ? 'Plan18' : 'Plan19'} 是随机对照组，禁止实盘。`);
    }
    if (id === PLAN13_ID && enabled && this.config.plan13LiveEnabled !== true) {
      throw new Error('Plan13 实盘需 POLYMARKET_PLAN13_LIVE_ENABLED=true。');
    }
    if (id === PLAN13_ID && enabled && this.config.plan13Enabled === false) {
      throw new Error('Plan13 已禁用（POLYMARKET_PLAN13_ENABLED=false）。');
    }
    if (id === 'plan5' && enabled && this.config.plan5Enabled !== true) {
      throw new Error('Plan5 已停用：历史实盘负期望，默认不再开仓。');
    }
    const nowIso = new Date().toISOString();
    const existing = {
      ...DEFAULT_STATE.liveAuto,
      ...(this.state.liveAuto || {}),
      riskControls: {
        ...DEFAULT_STATE.liveAuto.riskControls,
        ...(this.state.liveAuto?.riskControls || {})
      }
    };
    let enabledPlans = this.resolveLiveAutoEnabledPlans(existing);
    const planRuns = this.ensureLiveAutoPlanRuns(existing.planRuns);
    const nextTimeframes = normalizeTimeframes(timeframes || existing.timeframes, id);
    const nextSymbols = symbols ? normalizeLiveSymbols(symbols) : normalizeLiveSymbols(existing.symbols);

    if (enabled) {
      enabledPlans = PLAN_IDS.filter((item) => enabledPlans.includes(item) || item === id);
      planRuns[id] = {
        ...planRuns[id],
        enabled: true,
        startedAtIso: planRuns[id].startedAtIso || nowIso,
        stoppedAtIso: null,
        lastAction: 'started',
        lastReason: `${id} 自动实盘已启动`,
        lastError: null
      };
    } else {
      enabledPlans = enabledPlans.filter((item) => item !== id);
      planRuns[id] = {
        ...planRuns[id],
        enabled: false,
        stoppedAtIso: nowIso,
        lastAction: 'stopped',
        lastReason: `${id} 自动实盘已停止`
      };
    }

    this.state.liveAuto = {
      ...existing,
      enabled: enabledPlans.length > 0,
      enabledPlans,
      planRuns,
      planId: enabledPlans[0] || id,
      timeframes: nextTimeframes,
      symbols: nextSymbols,
      startedAtIso: enabledPlans.length ? (existing.startedAtIso || nowIso) : existing.startedAtIso,
      stoppedAtIso: enabledPlans.length ? null : nowIso,
      lastAction: enabled ? 'started' : (enabledPlans.length ? 'stopped' : 'stopped'),
      lastReason: enabled
        ? `${id} 自动实盘已启动`
        : (enabledPlans.length ? `${id} 已停止` : '全部自动实盘已停止'),
      lastError: enabled ? null : existing.lastError
    };
    await this.persist('live');
    return this.liveAutoStatus();
  }

  async setLiveAuto(enabled, { planId = null, timeframes = null, symbols = null, planIds = null } = {}) {
    if (!enabled) {
      if (planId) {
        return this.setLiveAutoPlan(planId, false, { timeframes, symbols });
      }
      const existing = {
        ...DEFAULT_STATE.liveAuto,
        ...(this.state.liveAuto || {}),
        riskControls: {
          ...DEFAULT_STATE.liveAuto.riskControls,
          ...(this.state.liveAuto?.riskControls || {})
        }
      };
      const activePlans = this.resolveLiveAutoEnabledPlans(existing);
      for (const id of activePlans) {
        await this.setLiveAutoPlan(id, false);
      }
      if (timeframes) {
        await this.setLiveAutoTimeframes(timeframes);
      }
      if (symbols) {
        this.state.liveAuto = {
          ...DEFAULT_STATE.liveAuto,
          ...(this.state.liveAuto || {}),
          symbols: normalizeLiveSymbols(symbols)
        };
        await this.persist('live');
      }
      return this.liveAutoStatus();
    }

    if (Array.isArray(planIds) && planIds.length) {
      for (const id of planIds) {
        await this.setLiveAutoPlan(id, true, { timeframes, symbols });
      }
      return this.liveAutoStatus();
    }

    return this.setLiveAutoPlan(planId || 'plan1', true, { timeframes, symbols });
  }

  async applyLiveAutoEnvDefault() {
    // 不再根据 ENV 偷偷自动开实盘：自动实盘必须由 UI/API 手动 start。
    // POLYMARKET_LIVE_AUTO_ENABLED 仅保留兼容告警，不起动任何 plan。
    if (this.config.liveAutoEnabled) {
      console.warn(
        'POLYMARKET_LIVE_AUTO_ENABLED=true is ignored; start live auto manually via /api/polymarket/live-auto/start or the live console.'
      );
    }
    return this.liveAutoStatus();
  }

  getLivePendingDelayedEntry(delayedEntryKey) {
    if (!delayedEntryKey) return null;
    this.pruneLivePlan2DelayedEntries();
    return this.state.liveAuto?.pendingDelayedEntries?.[delayedEntryKey] || null;
  }

  async scheduleLivePlan2DelayedEntry({ plan }) {
    const action = plan?.action;
    if (!action?.scheduleDelayedEntry || !action.delayedEntryKey) {
      throw new Error('Plan2 delayed entry payload is invalid.');
    }
    if (!this.state.liveAuto) this.state.liveAuto = { ...DEFAULT_STATE.liveAuto };
    if (!this.state.liveAuto.pendingDelayedEntries) this.state.liveAuto.pendingDelayedEntries = {};
    this.state.liveAuto.pendingDelayedEntries[action.delayedEntryKey] = {
      key: action.delayedEntryKey,
      planKey: plan.key,
      slotIso: plan.slotIso,
      timeframe: plan.timeframe,
      direction: action.direction,
      executeAfterMs: Date.parse(action.executeAfterIso),
      scheduledAtIso: new Date().toISOString(),
      initialLimitPrice: action.limitPrice,
      delayMs: action.delayMs
    };
    await this.persist('live');
    return this.state.liveAuto.pendingDelayedEntries[action.delayedEntryKey];
  }

  async scheduleLivePlan2ProbeUpgrade({ plan, draft }) {
    const action = plan?.action;
    if (!action?.scheduleProbeUpgrade || !plan?.slotIso || !plan?.timeframe) return null;
    if (!this.state.liveAuto) this.state.liveAuto = { ...DEFAULT_STATE.liveAuto };
    if (!this.state.liveAuto.pendingDelayedEntries) this.state.liveAuto.pendingDelayedEntries = {};
    const key = this.buildPlan2DelayedEntryKey(
      plan.slotIso,
      plan.timeframe,
      plan.symbol,
      plan.planId || plan.action?.planId || 'plan2_5'
    );
    const nowMs = Date.now();
    this.state.liveAuto.pendingDelayedEntries[key] = {
      key,
      type: 'probe_upgrade',
      planKey: plan.key,
      slotIso: plan.slotIso,
      timeframe: plan.timeframe,
      symbol: plan.symbol || 'BTC-USD',
      direction: action.direction,
      executeAfterMs: nowMs + (Number(action.probeUpgradeAfterMs) || 10000),
      expiresAtMs: nowMs + (Number(action.probeUpgradeExpiresMs) || 35000),
      scheduledAtIso: new Date(nowMs).toISOString(),
      initialLimitPrice: action.limitPrice,
      probePrice: Number(draft?.limitPrice ?? action.limitPrice),
      confidenceAtProbe: Number(action.confidence) || null,
      delayMs: Number(action.probeUpgradeAfterMs) || 10000
    };
    await this.persist('live');
    return this.state.liveAuto.pendingDelayedEntries[key];
  }

  async clearLivePlan2DelayedEntry(delayedEntryKey) {
    if (!delayedEntryKey || !this.state.liveAuto?.pendingDelayedEntries?.[delayedEntryKey]) return;
    delete this.state.liveAuto.pendingDelayedEntries[delayedEntryKey];
    await this.persist('live');
  }

  getLiveOrdersForWindow({ planId = 'plan1', timeframe, slotIso, symbol = null, marketSlug = null }) {
    if (!slotIso || !timeframe) return [];
    const id = this.normalizePlanId(planId);
    return (this.state.liveOrders || []).filter((order) => {
      if (order.orderSide === 'SELL') return false;
      if (order.status === 'blocked' || order.status === 'expired') return false;
      if (!['submitted', 'pending'].includes(order.status) && order.positionStatus !== 'closed') return false;
      if (this.normalizePlanId(order.planId) !== id) return false;
      if ((order.timeframe || '15m') !== timeframe) return false;
      if (symbol && (order.symbol || 'BTC-USD') !== symbol) return false;
      if (marketSlug && order.marketSlug && order.marketSlug !== marketSlug) return false;
      return order.slotIso === slotIso;
    });
  }

  getOpenLivePositionForWindow({ planId = 'plan1', timeframe, slotIso, symbol = null, marketSlug = null }) {
    return this.getLiveOrdersForWindow({ planId, timeframe, slotIso, symbol, marketSlug })
      .find((order) => this.isLivePositionOpen(order)) || null;
  }

  isLiveBuyFilled(order) {
    if (!order || order.orderSide === 'SELL') return false;
    if (order.positionStatus === 'pending' || order.fillUnconfirmed === true) return false;
    const status = String(order.clobStatus || order.clobResponse?.status || '').toLowerCase();
    if (status === 'live' || status === 'open') return false;
    if (order.fillConfirmed === true) return true;
    // matched 无 tx 可能是幽灵成交；仅在有交易哈希或 getOrder 已确认时视为真正成交。
    return isClobBuyFillConfirmed(order.clobResponse || { status: order.clobStatus });
  }

  isLivePositionOpen(order) {
    if (!order || order.status !== 'submitted') return false;
    if (order.orderSide === 'SELL') return false;
    if (order.positionStatus === 'closed') return false;
    if (order.positionStatus === 'pending' || order.fillUnconfirmed === true) return false;
    if (order.positionStatus === 'open') return true;
    return this.isLiveBuyFilled(order);
  }

  isLivePositionPending(order) {
    if (!order || order.orderSide === 'SELL') return false;
    return order.positionStatus === 'pending';
  }

  shouldRetryLiveExit(position, nowMs = Date.now()) {
    const retryAfter = Number(position?.exitRetryAfterMs) || 0;
    return !retryAfter || nowMs >= retryAfter;
  }

  resolveLiveExitRetryMs(position, exitStatus = null) {
    const timeframe = String(position?.timeframe || '').toLowerCase();
    const status = String(exitStatus || position?.lastPendingExitStatus || '').toLowerCase();
    const isStop = /hard-stop|dynamic-stop|stop-loss|direction-reversal/.test(status);
    const isTakeProfit = /take-profit|profit/.test(status);
    if (timeframe === '5m') {
      if (isStop) {
        const urgent = Number(this.config.liveExitRetryMs5mUrgent);
        if (Number.isFinite(urgent) && urgent >= 0) return urgent;
      }
      if (isTakeProfit) {
        const slow = Number(this.config.liveExitRetryMs5mTakeProfit);
        if (Number.isFinite(slow) && slow >= 0) return slow;
      }
      const value = Number(this.config.liveExitRetryMs5m);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    if (timeframe === '15m') {
      if (isTakeProfit) {
        const slow = Number(this.config.liveExitRetryMs15mTakeProfit);
        if (Number.isFinite(slow) && slow >= 0) return slow;
      }
      const value = Number(this.config.liveExitRetryMs15m);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return Number(this.config.liveExitRetryMs) || 60000;
  }

  isPlan2ExitSyncedToPaper(planId = 'plan2') {
    return this.isPlan2ExitSyncedToPaperFor(planId);
  }

  isPlan2EntrySyncedToPaper(planId = 'plan2') {
    return this.isPlan2EntrySyncedToPaperFor(planId);
  }

  resolveLiveMinHoldBeforeExitMs(position) {
    const planId = this.normalizePlanId(position?.planId || 'plan1');
    const timeframe = String(position?.timeframe || '').toLowerCase();
    // 与模拟盘对齐：模拟盘无最短持仓，同步模式下实盘也不拖延止盈/止损。
    if (this.isPlan2FamilyPlan(planId) && this.isPlan2ExitSyncedToPaper(planId)) {
      return 0;
    }
    if (this.isPlan2FamilyPlan(planId) && timeframe === '5m') {
      const plan2Hold = Number(this.config.plan2MinHoldBeforeExitMs5m);
      if (Number.isFinite(plan2Hold) && plan2Hold >= 0) return plan2Hold;
    }
    const entryType = String(position?.entryType || '').toLowerCase();
    if (entryType === 'probe') {
      const probeValue = timeframe === '5m'
        ? Number(this.config.liveMinHoldBeforeExitMsProbe5m)
        : timeframe === '15m'
          ? Number(this.config.liveMinHoldBeforeExitMsProbe15m)
          : NaN;
      if (Number.isFinite(probeValue) && probeValue >= 0) return probeValue;
    }
    const value = timeframe === '5m'
      ? Number(this.config.liveMinHoldBeforeExitMs5m)
      : timeframe === '15m'
        ? Number(this.config.liveMinHoldBeforeExitMs15m)
        : NaN;
    if (Number.isFinite(value) && value >= 0) return value;
    return Number(this.config.liveMinHoldBeforeExitMs ?? 30000);
  }

  resolvePlan2StopLossOffset(position) {
    // 与模拟盘对齐：统一用 plan2StopLossOffset，不区分探针更宽止损。
    if (this.isPlan2ExitSyncedToPaper(position?.planId || 'plan2')) {
      return Number(this.config.plan2StopLossOffset) || 0.12;
    }
    const entryType = String(position?.entryType || '').toLowerCase();
    if (entryType !== 'probe') {
      return Number(this.config.plan2StopLossOffset) || 0.12;
    }
    const timeframe = String(position?.timeframe || '').toLowerCase();
    const probeOffset = timeframe === '5m'
      ? Number(this.config.plan2ProbeStopLossOffset5m)
      : Number(this.config.plan2ProbeStopLossOffset15m);
    if (Number.isFinite(probeOffset) && probeOffset > 0) return probeOffset;
    return Number(this.config.plan2StopLossOffset) || 0.12;
  }

  async markLiveExitRetry(position, errorMessage, cooldownMs = null, exitStatus = null) {
    const ms = Number(cooldownMs) || this.resolveLiveExitRetryMs(position, exitStatus);
    position.exitRetryAfterMs = Date.now() + ms;
    position.lastExitError = errorMessage;
    position.lastExitAttemptAtIso = new Date().toISOString();
    if (exitStatus) position.lastPendingExitStatus = exitStatus;
    await this.persist('live');
  }

  shouldLogLiveExitBlocked(position, nowMs = Date.now()) {
    const last = Number(position?.lastExitBlockedLogAt) || 0;
    const cooldown = this.resolveLiveExitRetryMs(position);
    return nowMs - last >= cooldown;
  }

  async markLiveExitBlockedLog(position) {
    position.lastExitBlockedLogAt = Date.now();
    await this.persist('live');
  }

  isLiveExitPendingBuyError(message) {
    return /买单可能尚未成交|条件 token 余额 0|暂不能卖出|CLOB 卖单校验失败|授权.*不足|缓存未同步|not enough balance\s*\/\s*allowance/i.test(String(message || ''));
  }

  resolveLiveMinTradeableShares() {
    return Math.max(5, Math.floor((Number(this.config.liveMinSharesBuffer) || 6) - 1));
  }

  isLiveDustUnsellablePosition(position) {
    const shares = Number(position?.remainingShares ?? position?.shares) || 0;
    const usd = Number(position?.remainingCostUsd ?? position?.usd) || 0;
    const minShares = this.resolveLiveMinTradeableShares();
    if (isUnsellableDustShares(shares, minShares)) return true;
    // 名义过小（如 $0.12）即使份数因价格显示异常也视为灰尘
    return Number.isFinite(usd) && usd > 0 && usd < 1;
  }

  /** True while the market window is still open enough to retry/combine an undersized fill. */
  isLiveEntryWindowOpenForDustRetry(position, nowMs = Date.now()) {
    const targetMs = Date.parse(String(position?.targetTimeIso || ''));
    if (Number.isFinite(targetMs)) return nowMs < targetMs - 5_000;
    const slotMs = Date.parse(String(position?.slotIso || ''));
    const tf = String(position?.timeframe || '');
    const slotMinutes = tf === '5m' ? 5 : (tf === '15m' ? 15 : 0);
    if (Number.isFinite(slotMs) && slotMinutes > 0) {
      return nowMs < slotMs + slotMinutes * 60_000 - 5_000;
    }
    // Unknown window end: prefer retry over synthetic close.
    return true;
  }

  findLiveDustTopUpParent({ planId, planKey = null, symbol = null, timeframe = null, slotIso = null } = {}) {
    const id = this.normalizePlanId(planId);
    return (this.state.liveOrders || []).find((order) => (
      this.normalizePlanId(order.planId || 'plan1') === id
      && order.orderSide !== 'SELL'
      && order.dustTopUpPending === true
      && this.isLivePositionOpen(order)
      && (!planKey || order.planKey === planKey)
      && (!symbol || order.symbol === symbol)
      && (!timeframe || order.timeframe === timeframe)
      && (!slotIso || order.slotIso === slotIso)
    )) || null;
  }

  async maybeMergeLiveDustTopUpFill(record, planId) {
    if (!record || record.dustTopUpPending) return null;
    const parent = this.findLiveDustTopUpParent({
      planId,
      planKey: record.planKey,
      symbol: record.symbol,
      timeframe: record.timeframe,
      slotIso: record.slotIso
    });
    if (!parent || parent.id === record.id) return null;
    const parentShares = Number(parent.remainingShares ?? parent.shares) || 0;
    const parentUsd = Number(parent.remainingCostUsd ?? parent.usd) || 0;
    const addShares = Number(record.remainingShares ?? record.shares) || 0;
    const addUsd = Number(record.remainingCostUsd ?? record.usd) || 0;
    const mergedShares = parentShares + addShares;
    const mergedUsd = parentUsd + addUsd;
    const avgPrice = mergedShares > 0 ? mergedUsd / mergedShares : Number(parent.entryPrice) || 0;
    parent.shares = mergedShares;
    parent.usd = mergedUsd;
    parent.remainingShares = mergedShares;
    parent.remainingCostUsd = mergedUsd;
    parent.originalShares = Number(parent.originalShares ?? parentShares) + addShares;
    parent.originalUsd = Number(parent.originalUsd ?? parentUsd) + addUsd;
    parent.entryPrice = avgPrice;
    parent.limitPrice = avgPrice;
    parent.dustTopUpPending = this.isLiveDustUnsellablePosition(parent);
    parent.note = `${parent.note || ''} · 已合并加仓 +${addShares.toFixed(4)} 份 / $${addUsd.toFixed(2)}`.trim();
    record.status = 'merged';
    record.positionStatus = 'closed';
    record.exitStatus = 'dust-topup-merged';
    record.exitReason = `加仓合并入 ${parent.id}`;
    record.relatedBuyOrderId = parent.id;
    record.pnl = 0;
    record.payoutUsd = addUsd;
    record.closedAtIso = new Date().toISOString();
    record.remainingShares = 0;
    record.remainingCostUsd = 0;
    if (!parent.dustTopUpPending) {
      await this.markLiveExecuted(parent.planKey || record.planKey, planId);
    } else {
      this.unmarkLiveExecuted(parent.planKey || record.planKey, planId);
    }
    await this.persist('live');
    return parent;
  }

  repairSyntheticDustClosures() {
    const orders = this.state.liveOrders || [];
    const syntheticSellIds = new Set();
    let repaired = 0;
    for (const buy of orders) {
      if (buy.orderSide === 'SELL') continue;
      if (buy.positionStatus !== 'closed') continue;
      if (!['dust-undersized-fill', 'dust-unsellable'].includes(String(buy.exitStatus || ''))) continue;
      const syntheticSell = orders.find((order) => (
        order.orderSide === 'SELL'
        && order.relatedBuyOrderId === buy.id
        && order.exitStatus === 'dust-undersized-fill'
        && !order.clobOrderId
      ));
      if (syntheticSell) syntheticSellIds.add(syntheticSell.id);
      buy.status = 'submitted';
      buy.positionStatus = 'open';
      buy.exitStatus = null;
      buy.exitPrice = null;
      buy.exitReason = null;
      buy.pnl = null;
      buy.payoutUsd = null;
      buy.closedAtIso = null;
      buy.won = null;
      buy.remainingShares = Number(buy.originalShares ?? buy.shares) || 0;
      buy.remainingCostUsd = Number(buy.originalUsd ?? buy.usd) || 0;
      buy.realizedPnlUsd = 0;
      buy.realizedProceedsUsd = 0;
      buy.dustTopUpPending = this.isLiveDustUnsellablePosition(buy);
      buy.dustHolding = buy.dustTopUpPending;
      buy.dustSellMinShares = this.resolveLiveMinTradeableShares();
      buy.note = `${buy.note || ''} · 已恢复为 PM 真实持仓，等待补仓或官方结算`.trim();
      repaired += 1;
    }
    if (syntheticSellIds.size) {
      this.state.liveOrders = orders.filter((order) => !syntheticSellIds.has(order.id));
    }
    return repaired;
  }

  // Backward-compatible entry point retained for existing callers/tests.
  repairSyntheticPlan5DustClosures() {
    return this.repairSyntheticDustClosures();
  }

  clearSettledDustHoldingFlags() {
    let cleared = 0;
    for (const order of this.state.liveOrders || []) {
      if (order.orderSide === 'SELL' || order.positionStatus !== 'closed') continue;
      if (order.dustHolding !== true && order.dustTopUpPending !== true && !order.dustHoldingReason) continue;
      order.dustHolding = false;
      order.dustTopUpPending = false;
      order.dustHoldingReason = null;
      cleared += 1;
    }
    return cleared;
  }

  /** Strip fake “卖出/平仓” rows from local dust flatten (no CLOB sell happened). */
  repairSyntheticDustSellRecords() {
    const orders = this.state.liveOrders || [];
    const next = orders.filter((order) => !isSyntheticDustSellOrder(order));
    const removed = orders.length - next.length;
    if (removed > 0) this.state.liveOrders = next;
    return removed;
  }

  async holdLiveDustPosition(position, {
    exitReason = '成交份额低于 CLOB 自动卖出门槛，保留真实持仓等待补仓或官方结算',
    errorMessage = null
  } = {}) {
    if (!position || position.orderSide === 'SELL') {
      throw new Error('只能保留真实买入持仓。');
    }
    const remainingShares = Number(position.remainingShares ?? position.shares) || 0;
    const remainingCostUsd = Number(position.remainingCostUsd ?? position.usd) || 0;
    position.status = 'submitted';
    position.positionStatus = 'open';
    position.exitStatus = null;
    position.exitPrice = null;
    position.exitReason = null;
    position.pnl = null;
    position.payoutUsd = null;
    position.closedAtIso = null;
    position.remainingShares = remainingShares;
    position.remainingCostUsd = remainingCostUsd;
    position.dustTopUpPending = true;
    position.dustHolding = true;
    position.dustSellMinShares = this.resolveLiveMinTradeableShares();
    position.dustHoldingReason = errorMessage
      ? `${exitReason} · ${errorMessage}`
      : exitReason;
    position.note = `${position.note || ''} · 小额真实持仓仍在 PM，未卖出、未本地结清`.trim();
    await this.persist('live');
    await this.updateLiveAutoRun({
      lastAction: 'dust-holding',
      lastReason: `${position.timeframe || ''} 小额真实持仓 ${remainingShares.toFixed(4)} 份，等待补仓或官方结算`.trim(),
      lastError: errorMessage || null,
      lastOrderId: position.id || null
    });
    return {
      position,
      sellRecord: null,
      result: null,
      draft: null,
      pending: false,
      dustHeld: true,
      remainingShares
    };
  }

  // Kept as an alias so older code paths cannot synthesize a local close.
  async closeLiveDustPosition(position, options = {}) {
    return this.holdLiveDustPosition(position, options);
  }

  shouldWaitAfterBuyFill(position, currentPrice = null, nowMs = Date.now()) {
    const price = Number(currentPrice);
    if (Number.isFinite(price) && this.shouldBypassMinHoldForExit(position, price)) {
      return false;
    }
    const minHoldMs = this.resolveLiveMinHoldBeforeExitMs(position);
    if (!Number.isFinite(minHoldMs) || minHoldMs <= 0) return false;
    const filledAt = position?.filledAtIso || position?.createdAtIso;
    if (!filledAt) return false;
    return nowMs - new Date(filledAt).getTime() < minHoldMs;
  }

  shouldBypassMinHoldForExit(position, currentPrice) {
    const price = Number(currentPrice);
    if (!Number.isFinite(price)) return false;
    const entry = Number(position?.entryPrice ?? position?.limitPrice);
    if (!Number.isFinite(entry) || entry <= 0) return false;

    if (this.config.liveMinHoldBypassOnHardStop !== false && this.isPlan2FamilyPlan(position?.planId)) {
      const hardOffset = Number(this.config.plan2ExitHardStopOffset) || 0.22;
      const hardStop = Math.max(0.01, entry - hardOffset);
      if (price <= hardStop) return true;
    }

    if (
      this.config.liveMinHoldBypassOnStopLoss5m !== false
      && String(position?.timeframe || '').toLowerCase() === '5m'
      && !this.isPlan2FamilyPlan(position?.planId)
    ) {
      const stopLoss = Number(position?.stopLossPrice);
      if (Number.isFinite(stopLoss) && price <= stopLoss) return true;
    }

    if (this.normalizePlanId(position?.planId) === PLAN11_ID && isPlan11StopLossEnabled(this.config)) {
      const stopLoss = Number(position?.stopLossPrice);
      const slOffset = Number(this.config.plan11StopLossOffset) || 0.10;
      const hardStop = Number.isFinite(stopLoss) ? stopLoss : Math.max(0.01, entry - slOffset);
      if (price <= hardStop) return true;
    }

    return false;
  }

  getOpenLivePositions(planId = null) {
    return (this.state.liveOrders || []).filter((order) => {
      if (planId && this.normalizePlanId(order.planId) !== this.normalizePlanId(planId)) return false;
      return this.isLivePositionOpen(order);
    });
  }

  resolveLiveCashBalance(clobBalanceUsdc = null) {
    const supplied = clobBalanceUsdc !== null
      && clobBalanceUsdc !== undefined
      && clobBalanceUsdc !== ''
      && Number.isFinite(Number(clobBalanceUsdc))
      ? Math.max(0, Number(clobBalanceUsdc))
      : null;
    if (supplied > 0) {
      return { cash: supplied, source: 'fresh' };
    }
    const control = this.state.liveControl || {};
    const current = Math.max(0, Number(control.currentBalanceUsdc) || 0);
    if (current > 0) {
      return { cash: current, source: 'cached-current' };
    }
    const lastValid = Math.max(0, Number(control.lastValidBalanceUsdc) || 0);
    if (lastValid > 0) {
      return { cash: lastValid, source: 'cached-last-valid' };
    }
    return { cash: supplied || 0, source: supplied === 0 ? 'fresh-zero' : 'unavailable' };
  }

  livePortfolioSnapshot({ clobBalanceUsdc = null } = {}) {
    const resolvedBalance = this.resolveLiveCashBalance(clobBalanceUsdc);
    const cash = resolvedBalance.cash;
    const openPositions = this.getOpenLivePositions();
    const pendingBuys = (this.state.liveOrders || []).filter((order) => (
      order.orderSide !== 'SELL'
      && (order.status === 'pending' || order.positionStatus === 'pending')
    ));
    const openExposureUsd = [...openPositions, ...pendingBuys]
      .reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    return {
      startingCash: round2(cash + openExposureUsd),
      cash: round2(cash),
      balanceSource: resolvedBalance.source,
      portfolioInitialized: true,
      equity: round2(cash + openExposureUsd),
      openExposureUsd: round2(openExposureUsd)
    };
  }

  liveRiskSnapshot({ clobBalanceUsdc = null, timeframe = null, planId = null, nowMs = Date.now() } = {}) {
    const portfolio = this.livePortfolioSnapshot({ clobBalanceUsdc });
    const normalizedPlanId = planId ? this.normalizePlanId(planId) : null;
    const openPositions = this.getOpenLivePositions(normalizedPlanId || null);
    const pendingBuys = (this.state.liveOrders || []).filter((order) => (
      order.orderSide !== 'SELL'
      && (order.status === 'pending' || order.positionStatus === 'pending')
      && (!normalizedPlanId || this.normalizePlanId(order.planId || 'plan1') === normalizedPlanId)
    ));
    // 与 getOpenExposureOrders 一致：窗已结束后结果风险锁定，不占下一窗 hardCap 余量。
    // 否则待结算仓会把 timeframe room 挤成 $0.01，误报「本金风控上限」。
    const exposed = [...openPositions, ...pendingBuys]
      .filter((order) => isLiveExposureWindowOpen(order, nowMs));
    const totalOpenExposureUsd = exposed.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const timeframeOpenExposureUsd = exposed
      .filter((order) => !timeframe || (order.timeframe || '15m') === timeframe)
      .reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const lossRisk = this.liveLossRiskSnapshot(nowMs, planId);
    return {
      ...portfolio,
      totalOpenExposureUsd: round2(totalOpenExposureUsd),
      timeframeOpenExposureUsd: round2(timeframeOpenExposureUsd),
      maxSingleOrderUsd: round2(Math.max(
        portfolio.equity * (Number(this.config.maxOrderEquityPct) || 0.08),
        // 小账户：权益比例帽可能低于 CLOB 5 份，至少抬到 Plan1/全局最小单（再由 cash/绝对上限截断）
        Math.min(
          Number(portfolio.cash) || portfolio.equity || 0,
          Number(this.config.plan1LiveMinOrderUsd) || Number(this.config.minOrderUsd) || 5
        )
      )),
      maxTotalOpenExposureUsd: round2(portfolio.equity * (Number(this.config.maxTotalOpenExposurePct) || 0.25)),
      maxTimeframeOpenExposureUsd: round2(portfolio.equity * (Number(this.config.maxTimeframeOpenExposurePct) || 0.12)),
      ...lossRisk
    };
  }

  getOpenExposureOrders() {
    const open = [];
    const nowMs = Date.now();
    for (const id of PLAN_IDS) {
      for (const order of this.getBucket(id).paperOrders || []) {
        if (order.settlementStatus !== 'open') continue;
        if (!isLiveExposureWindowOpen(order, nowMs)) continue;
        open.push({ ...order, planId: order.planId || id, source: 'paper' });
      }
    }
    for (const order of this.state.liveOrders || []) {
      if (order.orderSide === 'SELL') continue;
      if (!isLiveExposureWindowOpen(order, nowMs)) continue;
      if (this.isLivePositionOpen(order) || order.status === 'pending' || order.positionStatus === 'pending') {
        open.push({ ...order, source: 'live' });
      }
    }
    return open;
  }

  computeConfidenceCalibrationTable() {
    const preferLive = this.config.plan2CalibrationPreferLive !== false;
    const lookbackDays = Number(this.config.calibrationLookbackDays) || 45;
    const cacheKey = `confidence-calibration:${preferLive ? 'live' : 'all'}:${lookbackDays}`;
    return this.getCachedAnalysis(cacheKey, 30_000, () => {
      const orders = [];
      for (const id of PLAN_IDS) {
        for (const order of this.getBucket(id).paperOrders || []) {
          if (preferLive) continue; // 默认不用纸面样本污染校准/historyGate
          orders.push({ ...order, planId: order.planId || id, source: 'paper' });
        }
      }
      for (const order of this.state.liveOrders || []) {
        if (order.orderSide === 'SELL') continue;
        if (order.positionStatus !== 'closed') continue;
        if (order.exitStatus === 'expired-unfilled') continue;
        orders.push({ ...order, source: 'live' });
      }
      // 统计库补齐历史样本，state 裁剪/重启后仍能用长期校准表。
      if (this.statsDb?.enabled) {
        const seen = new Set(orders.map((order) => order.id).filter(Boolean));
        const source = preferLive ? 'live' : 'all';
        for (const order of this.statsDb.getCalibrationOrders({ lookbackDays, source })) {
          if (order.id && !seen.has(order.id)) orders.push(order);
        }
        // live 样本过少时回退 all，避免冷启动无校准。
        if (preferLive && orders.length < (Number(this.config.confidenceMinBucketSamples) || 20)) {
          for (const order of this.statsDb.getCalibrationOrders({ lookbackDays, source: 'all' })) {
            if (order.id && !seen.has(order.id)) {
              seen.add(order.id);
              orders.push(order);
            }
          }
        }
      }
      return buildConfidenceCalibrationTable(orders);
    });
  }

  getPlan3BandStats({ source = null, preferLive = null } = {}) {
    if (!this.statsDb?.enabled) return null;
    const lookbackDays = Number(this.config.plan3BandStatsLookbackDays) || 30;
    const prefer = preferLive ?? (this.config.plan3BandStatsPreferLive !== false);
    const explicitSource = source
      || this.config.plan3BandStatsSource
      || null;
    const includeLegacyPlan35 = this.config.plan3MergePlan35History !== false;
    const cacheKey = `plan3-bands:${explicitSource || 'auto'}:${prefer}:${lookbackDays}:${this.config.plan3LiveEnabled === true}:${includeLegacyPlan35}`;
    return this.getCachedAnalysis(cacheKey, 30_000, () => {
    if (explicitSource && explicitSource !== 'all') {
      return this.statsDb.getPlan3BandStats({ lookbackDays, source: explicitSource, includeLegacyPlan35 });
    }
    if (prefer && this.config.plan3LiveEnabled === true) {
      const liveBands = this.statsDb.getPlan3BandStats({ lookbackDays, source: 'live', includeLegacyPlan35 });
      const minSamples = Number(this.config.plan3BandStatsMinSamples) || 30;
      const liveSampleCount = Object.values(liveBands || {}).reduce((sum, band) => sum + (Number(band?.total) || 0), 0);
      if (liveSampleCount >= minSamples) return liveBands;
      // live 样本不足时回退 all，但标记来源，避免误以为已 live-only。
      const allBands = this.statsDb.getPlan3BandStats({ lookbackDays, source: 'all', includeLegacyPlan35 });
      return { ...allBands, _statsSource: 'all_fallback', _liveSampleCount: liveSampleCount };
    }
    if (prefer === false && this.config.plan3LiveEnabled !== true) {
      return this.statsDb.getPlan3BandStats({ lookbackDays, source: 'paper', includeLegacyPlan35 });
    }
    return this.statsDb.getPlan3BandStats({ lookbackDays, source: 'all', includeLegacyPlan35 });
    });
  }

  /** 启动时把统计库已有 id 记入内存，避免冷启动后每次 persist/reset 重扫全量订单。 */
  hydrateStatsDbSyncedIds() {
    if (!this.statsDb?.enabled || typeof this.statsDb.listSettledOrderIds !== 'function') return 0;
    try {
      const ids = this.statsDb.listSettledOrderIds();
      for (const id of ids || []) this._statsDbSyncedIds.add(String(id));
      return this._statsDbSyncedIds.size;
    } catch (error) {
      console.warn(`Stats DB hydrate synced ids skipped: ${error.message}`);
      return 0;
    }
  }

  /**
   * 已结算/已平仓订单增量同步到统计库（upsert 幂等，失败不影响主流程）。
   * @param {{ planIds?: string[]|null, includeLive?: boolean, maxBatch?: number }} [options]
   */
  syncSettledOrdersToStatsDb({ planIds = null, includeLive = true, maxBatch = Infinity } = {}) {
    if (!this.statsDb?.enabled) return 0;
    const batch = [];
    const limit = Number.isFinite(Number(maxBatch)) ? Math.max(0, Number(maxBatch)) : Infinity;
    const ids = Array.isArray(planIds) && planIds.length
      ? planIds.map((id) => this.normalizePlanId(id))
      : PLAN_IDS;
    for (const id of ids) {
      for (const order of this.getBucket(id).paperOrders || []) {
        if (batch.length >= limit) break;
        if (order.settlementStatus !== 'settled' || !order.id) continue;
        if (order.exitStatus === 'expired-unfilled') continue;
        if (this._statsDbSyncedIds.has(order.id)) continue;
        batch.push({ order: { ...order, planId: order.planId || id }, source: 'paper' });
      }
      if (batch.length >= limit) break;
    }
    if (includeLive && batch.length < limit) {
      for (const order of this.state.liveOrders || []) {
        if (batch.length >= limit) break;
        if (order.orderSide === 'SELL' || order.positionStatus !== 'closed' || !order.id) continue;
        if (order.exitStatus === 'expired-unfilled') continue;
        if (this._statsDbSyncedIds.has(order.id)) continue;
        batch.push({ order, source: 'live' });
      }
    }
    if (!batch.length) return 0;
    const written = this.statsDb.recordSettledOrders(batch);
    if (written > 0) {
      for (const item of batch) this._statsDbSyncedIds.add(item.order.id);
    }
    return written;
  }

  /** 重置热路径：不阻塞请求；后台轻量补同步。 */
  scheduleBackgroundStatsSync(planId = null) {
    if (!this.statsDb?.enabled) return;
    const run = () => {
      try {
        this.syncSettledOrdersToStatsDb({
          planIds: planId ? [planId] : null,
          includeLive: !planId,
          maxBatch: 200
        });
      } catch (error) {
        console.error(`Background stats sync failed: ${error.message}`);
      }
    };
    if (typeof setImmediate === 'function') setImmediate(run);
    else setTimeout(run, 0);
  }

  isPlan12GlobalExposureOrder(order) {
    const planId = this.normalizePlanId(order?.planId || 'plan1');
    return planId === 'plan1' || planId === PLAN11_ID || this.isPlan2FamilyPlan(planId);
  }

  computeGlobalExposureSnapshot({
    timeframe = null,
    slotIso = null,
    direction = null,
    equity = null,
    clobBalanceUsdc = null,
    source = 'all'
  } = {}) {
    const liveRisk = this.liveRiskSnapshot({ clobBalanceUsdc, timeframe });
    const hasExplicitEquity = equity !== null
      && equity !== undefined
      && equity !== ''
      && Number.isFinite(Number(equity));
    const eq = hasExplicitEquity ? Number(equity) : liveRisk.equity;
    const totalOnlyMode = this.config.globalExposureMode === 'total_only';
    const openOrders = this.getOpenExposureOrders().filter((order) => (
      (source === 'all' || order.source === source)
      && (order.source !== 'live' || totalOnlyMode || this.isPlan12GlobalExposureOrder(order))
    ));
    // 同窗同向敞口必须按 timeframe 隔离：5m/15m 即使 slotIso 相同（整点对齐）也不能互相占坑。
    const slotDirectionExposureUsd = openOrders
      .filter((order) => (
        (!timeframe || (order.timeframe || '15m') === timeframe)
        && (!slotIso || (order.slotIso || order.plan?.slotIso) === slotIso)
        && (!direction || order.direction === direction)
      ))
      .reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const timeframeExposureUsd = openOrders
      .filter((order) => !timeframe || (order.timeframe || '15m') === timeframe)
      .reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const totalBtcExposureUsd = openOrders.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const maxSlotDirectionExposureUsd = round2(eq * (Number(this.config.globalSlotDirectionMaxExposurePct) || 0.08));
    const maxTimeframeExposureUsd = round2(eq * (Number(this.config.globalTimeframeMaxExposurePct) || 0.12));
    const maxTotalBtcExposureUsd = round2(eq * (Number(this.config.globalTotalBtcMarketExposurePct) || 0.20));
    return {
      equity: round2(eq),
      slotDirectionExposureUsd: round2(slotDirectionExposureUsd),
      timeframeExposureUsd: round2(timeframeExposureUsd),
      totalBtcExposureUsd: round2(totalBtcExposureUsd),
      maxSlotDirectionExposureUsd,
      maxTimeframeExposureUsd,
      maxTotalBtcExposureUsd,
      slotDirectionRoomUsd: round2(Math.max(0, maxSlotDirectionExposureUsd - slotDirectionExposureUsd)),
      timeframeRoomUsd: round2(Math.max(0, maxTimeframeExposureUsd - timeframeExposureUsd)),
      totalBtcRoomUsd: round2(Math.max(0, maxTotalBtcExposureUsd - totalBtcExposureUsd))
    };
  }

  checkGlobalExposure({
    timeframe,
    slotIso,
    direction,
    newOrderUsd,
    equity = null,
    clobBalanceUsdc = null,
    source = 'all'
  }) {
    if (this.config.globalExposureCapEnabled !== true) {
      return { allowed: true, reason: null };
    }
    const snap = this.computeGlobalExposureSnapshot({
      timeframe,
      slotIso,
      direction,
      equity,
      clobBalanceUsdc,
      source
    });
    const usd = Number(newOrderUsd) || 0;
    const totalOnlyMode = this.config.globalExposureMode === 'total_only';
    if (!totalOnlyMode && usd > snap.slotDirectionRoomUsd) {
      return {
        allowed: false,
        reason: `同窗口同方向 Plan1+Plan2 总暴露将达到 $${(snap.slotDirectionExposureUsd + usd).toFixed(2)}，超过上限 $${snap.maxSlotDirectionExposureUsd.toFixed(2)}。`
      };
    }
    if (!totalOnlyMode && usd > snap.timeframeRoomUsd) {
      return {
        allowed: false,
        reason: `${timeframe || '当前'} 周期总暴露将达到 $${(snap.timeframeExposureUsd + usd).toFixed(2)}，超过上限 $${snap.maxTimeframeExposureUsd.toFixed(2)}。`
      };
    }
    if (usd > snap.totalBtcRoomUsd) {
      return {
        allowed: false,
        reason: `全部实盘未结算总暴露将达到 $${(snap.totalBtcExposureUsd + usd).toFixed(2)}，超过宽松上限 $${snap.maxTotalBtcExposureUsd.toFixed(2)}。`
      };
    }
    return { allowed: true, reason: null, snapshot: snap };
  }

  getLiveClosedBuys(planId = null) {
    const normalizedPlanId = planId ? this.normalizePlanId(planId) : null;
    return (this.state.liveOrders || [])
      .filter((order) => (
        order.orderSide !== 'SELL'
        && order.positionStatus === 'closed'
        && !isExpiredUnfilledLiveOrder(order)
        && !isDustClosedLiveOrder(order)
        && Number.isFinite(Number(order.pnl))
        && (!normalizedPlanId || this.normalizePlanId(order.planId || 'plan1') === normalizedPlanId)
      ))
      .sort((a, b) => Date.parse(b.closedAtIso || b.createdAtIso || 0) - Date.parse(a.closedAtIso || a.createdAtIso || 0));
  }

  globalLiveDailyLossSnapshot({ now = new Date(), clobBalanceUsdc = null } = {}) {
    const dateKey = formatShanghaiDate(now);
    const nowMs = now.getTime();
    let dailyStats = this.liveDailyStatsCache.value;
    if (!dailyStats || this.liveDailyStatsCache.dateKey !== dateKey || nowMs - this.liveDailyStatsCache.at >= 1000) {
      let realizedPnl = 0;
      let settledTrades = 0;
      for (const order of this.state.liveOrders || []) {
        if (order.orderSide === 'SELL' || order.positionStatus !== 'closed') continue;
        if (isExpiredUnfilledLiveOrder(order) || isDustClosedLiveOrder(order)) continue;
        if (!Number.isFinite(Number(order.pnl))) continue;
        const closedAt = order.closedAtIso || order.settledAtIso || order.targetTimeIso || order.createdAtIso;
        if (!closedAt || formatShanghaiDate(closedAt) !== dateKey) continue;
        realizedPnl += Number(order.pnl) || 0;
        settledTrades += 1;
      }
      dailyStats = { realizedPnl: round2(realizedPnl), settledTrades };
      this.liveDailyStatsCache = { at: nowMs, dateKey, value: dailyStats };
    }
    const equity = this.livePortfolioSnapshot({ clobBalanceUsdc }).equity;
    const absoluteLimit = Number(this.config.dailyMaxLossUsd) || 0;
    const limitPct = Number(this.config.globalDailyLossLimitPct)
      || Number(this.config.plan3DailyLossLimitPct)
      || 0.01;
    const limitUsd = round2(absoluteLimit > 0 ? absoluteLimit : equity * limitPct);
    const enabled = this.isGlobalDailyLossProtectionEnabled();
    return {
      enabled,
      dateKey,
      realizedPnl: dailyStats.realizedPnl,
      settledTrades: dailyStats.settledTrades,
      equity: round2(equity),
      limitPct,
      limitUsd,
      triggered: enabled && limitUsd > 0 && dailyStats.realizedPnl <= -limitUsd
    };
  }

  computeLiveLossStreak(planId = null) {
    return this.liveLossRiskSnapshot(Date.now(), planId).lossStreak;
  }

  liveLossRiskSnapshot(nowMs = Date.now(), planId = null) {
    const closedBuys = this.getLiveClosedBuys(planId);
    const streakOrders = this.normalizePlanId(planId || '') === 'plan5'
      ? collapseSettledOrdersByWindow(closedBuys)
      : closedBuys;
    let streak = 0;
    let weightedStreak = 0;
    let lastLossAtMs = null;
    let lastLossAtIso = null;
    for (const order of streakOrders) {
      const pnl = Number(order.pnl) || 0;
      if (pnl < 0) {
        if (lastLossAtMs == null) {
          lastLossAtIso = order.closedAtIso || order.createdAtIso || null;
          lastLossAtMs = Date.parse(lastLossAtIso);
        }
        streak += 1;
        weightedStreak += getLiveLossWeight(order);
      } else if (pnl > 0) {
        break;
      }
    }
    weightedStreak = Math.round(weightedStreak * 10) / 10;

    const cooldown4Ms = Math.max(0, Number(this.config.lossStreakCooldown4Ms) || 15 * 60 * 1000);
    const cooldown5Ms = Math.max(cooldown4Ms, Number(this.config.lossStreakCooldown5Ms) || 30 * 60 * 1000);
    const recoveryScale = clampNumber(Number(this.config.lossStreakRecoveryScale), 0.05, 0.5, 0.25);
    const lossRisk = getLossStreakRisk({
      streak: weightedStreak,
      lastLossAtMs,
      nowMs,
      cooldown4Ms,
      cooldown5Ms,
      recoveryScale
    });
    const settledStreaks = computeSettledStreaks(streakOrders);
    const streakSizing = resolveEntrySizeScale({
      planId,
      config: this.config,
      winStreak: settledStreaks.winStreak,
      lossStreak: settledStreaks.lossStreak,
      lossStreakScale: lossRisk.scale,
      lossRecoveryMode: lossRisk.recoveryMode,
      appliesGlobalLossRecovery: false
    }).streak;
    return {
      lossStreak: streak,
      lossStreakWeighted: weightedStreak,
      winStreak: settledStreaks.winStreak,
      lastLossAtIso,
      lossStreakScale: lossRisk.scale,
      lossCooldownUntilIso: lossRisk.cooldownUntilMs ? new Date(lossRisk.cooldownUntilMs).toISOString() : null,
      lossCooldownRemainingMs: lossRisk.cooldownRemainingMs,
      lossRecoveryMode: lossRisk.recoveryMode,
      streakSizingEnabled: streakSizing.enabled === true,
      streakSizingScale: streakSizing.scale,
      streakSizingMode: streakSizing.mode,
      streakSizingLevels: streakSizing.levels,
      streakSizingBelowMinMode: streakSizing.belowMinMode
    };
  }

  /**
   * 纸面连赢/连亏：按 plan bucket 已结算订单，与实盘 streak 隔离。
   */
  paperStreakRiskSnapshot(planId = 'plan1') {
    const id = this.normalizePlanId(planId);
    const closedBuys = (this.getBucket(id).paperOrders || [])
      .filter((order) => (
        order.orderSide !== 'SELL'
        && order.settlementStatus === 'settled'
        && Number.isFinite(Number(order.pnl))
        && !(order.exitStatus === 'expired-unfilled' && Number(order.pnl) === 0)
      ))
      .sort((a, b) => Date.parse(b.settledAtIso || b.closedAtIso || b.createdAtIso || 0)
        - Date.parse(a.settledAtIso || a.closedAtIso || a.createdAtIso || 0));
    const streakOrders = id === 'plan5'
      ? collapseSettledOrdersByWindow(closedBuys)
      : closedBuys;
    const settledStreaks = computeSettledStreaks(streakOrders);
    const streakSizing = resolveEntrySizeScale({
      planId: id,
      config: this.config,
      winStreak: settledStreaks.winStreak,
      lossStreak: settledStreaks.lossStreak,
      appliesGlobalLossRecovery: false
    }).streak;
    return {
      winStreak: settledStreaks.winStreak,
      lossStreak: settledStreaks.lossStreak,
      streakSizingEnabled: streakSizing.enabled === true,
      streakSizingScale: streakSizing.scale,
      streakSizingMode: streakSizing.mode,
      streakSizingLevels: streakSizing.levels,
      streakSizingBelowMinMode: streakSizing.belowMinMode
    };
  }

  isStreakSizingEnabledForPlan(planId = null) {
    return isStreakSizingEnabled(this.config, planId ? this.normalizePlanId(planId) : null);
  }

  computeLegacyLiveLossStreak() {
    const closedBuys = (this.state.liveOrders || [])
      .filter((order) => order.orderSide !== 'SELL' && order.positionStatus === 'closed' && Number.isFinite(Number(order.pnl)))
      .sort((a, b) => Date.parse(b.closedAtIso || b.createdAtIso || 0) - Date.parse(a.closedAtIso || a.createdAtIso || 0));
    let streak = 0;
    for (const order of closedBuys) {
      const pnl = Number(order.pnl) || 0;
      if (pnl < 0) streak += 1;
      else if (pnl > 0) break;
    }
    return streak;
  }

  canOpenNewLiveEntryForWindow({
    planId = 'plan1',
    timeframe,
    slotIso,
    symbol = null,
    marketSlug = null,
    entryType = null,
    direction = null
  }) {
    const normalizedPlanId = this.normalizePlanId(planId);
    const orders = this.getLiveOrdersForWindow({
      planId: normalizedPlanId,
      timeframe,
      slotIso,
      // Plan13 is a four-symbol competition: one position total per 15m slot.
      symbol: normalizedPlanId === PLAN13_ID ? null : symbol,
      marketSlug: normalizedPlanId === PLAN13_ID ? null : marketSlug
    });
    const normalizedEntry = String(entryType || '').toLowerCase();
    const isPlan1Hedge = this.normalizePlanId(planId) === 'plan1' && normalizedEntry === 'opposite_hedge';
    if (isPlan1Hedge) {
      const existingHedge = orders.find((order) => (
        this.isLivePositionOpen(order)
        && String(order.entryType || '').toLowerCase() === 'opposite_hedge'
      ));
      if (existingHedge) {
        return { allowed: false, openPosition: existingHedge, reason: `${timeframe} 本窗口已有反向保险仓。` };
      }
      const mainOrder = orders.find((order) => (
        this.isLivePositionOpen(order)
        && String(order.entryType || '').toLowerCase() !== 'opposite_hedge'
        && (!direction || order.direction !== direction)
      ));
      if (!mainOrder) {
        return { allowed: false, openPosition: null, reason: `${timeframe} 本窗口没有可对冲的主仓。` };
      }
      return { allowed: true, openPosition: null, reason: null };
    }
    const openPosition = orders.find((order) => this.isLivePositionOpen(order));
    if (openPosition) {
      // Undersized dust awaiting top-up: allow same-window combine/retry entry.
      if (openPosition.dustTopUpPending === true && this.isLiveDustUnsellablePosition(openPosition)) {
        return {
          allowed: true,
          openPosition,
          dustTopUpPending: true,
          reason: null
        };
      }
      return { allowed: false, openPosition, reason: `${timeframe} 本窗口已有实盘持仓。` };
    }
    const pendingBuy = orders.find((order) => this.isLivePositionPending(order));
    if (pendingBuy) {
      return { allowed: false, openPosition: pendingBuy, reason: `${timeframe} 本窗口买单待成交。` };
    }
    if (this.isPlan2FamilyPlan(planId)) {
      const circuit = this.checkPlan2LiveSlotLossCircuit({ timeframe, slotIso, symbol, planId });
      if (!circuit.allowed) return circuit;
    }
    if (this.normalizePlanId(planId) === 'plan5') {
      const circuit = this.checkPlan5LiveLossCircuit();
      if (!circuit.allowed) return circuit;
    }
    const blockingClosed = orders.find((order) => (
      order.orderSide !== 'SELL'
      && order.positionStatus === 'closed'
      && order.exitStatus !== 'direction-flip'
      // 未成交过期允许同窗重评后再下；blocked 走 blocked-retry
      && order.exitStatus !== 'expired-unfilled'
      && order.status !== 'blocked'
    ));
    if (blockingClosed) {
      return { allowed: false, openPosition: null, reason: `${timeframe} 本窗口已交易过。` };
    }
    return { allowed: true, openPosition: null, reason: null };
  }

  /**
   * Plan5 跨币连亏熔断：最近 N 笔已结算买单连续亏损则可进入冷却期。
   * 冷却有独立开关（plan5LiveLossCircuitCooldownEnabled，默认关）：
   * - 关：只计数/提示，不因连亏暂停开仓（避免无冷却时永久死锁）
   * - 开：冷却内禁止新开仓；冷却起点=连亏 streak 最新亏损单 closedAt/settledAt
   * 与 Plan2 本币本窗熔断不同——Plan5 同向多币齐开时，必须按全局连亏计。
   */
  checkPlan5LiveLossCircuit({ nowMs = Date.now() } = {}) {
    if (this.config.plan5LiveLossCircuitEnabled === false) {
      return {
        allowed: true,
        reason: null,
        consecutiveLosses: 0,
        cooldownEnabled: false,
        circuitEnabled: false
      };
    }
    const maxLosses = Math.max(1, Number(this.config.plan5LiveLossCircuitMaxLosses) || 3);
    const cooldownEnabled = this.config.plan5LiveLossCircuitCooldownEnabled === true;
    const cooldownMs = Math.max(0, Number(this.config.plan5LiveLossCircuitCooldownMs) || (45 * 60 * 1000));
    const closedBuys = collapseSettledOrdersByWindow(this.getLiveClosedBuys('plan5'));
    let consecutiveLosses = 0;
    let latestLossOrder = null;
    for (const order of closedBuys) {
      const pnl = Number(order.pnl) || 0;
      if (pnl < 0) {
        consecutiveLosses += 1;
        if (!latestLossOrder) latestLossOrder = order;
      } else if (pnl > 0) {
        break;
      }
    }
    if (consecutiveLosses < maxLosses) {
      return {
        allowed: true,
        reason: null,
        consecutiveLosses,
        maxLosses,
        cooldownMs,
        cooldownEnabled,
        circuitEnabled: true,
        planId: 'plan5'
      };
    }

    const triggeredAtIso = latestLossOrder?.closedAtIso
      || latestLossOrder?.settledAtIso
      || latestLossOrder?.createdAtIso
      || null;
    const triggeredAtMs = triggeredAtIso ? Date.parse(triggeredAtIso) : NaN;
    // 无时间戳时视为冷却早已结束（避免依赖从未写入的 untilIso 而死锁）
    const cooldownUntilMs = Number.isFinite(triggeredAtMs) ? (triggeredAtMs + cooldownMs) : 0;
    const remainingMs = cooldownUntilMs - nowMs;

    // 冷却关：连亏只提示，不拦新开仓
    if (!cooldownEnabled) {
      return {
        allowed: true,
        reason: `Plan5 最近连续亏损 ${consecutiveLosses} 笔（阈值 ${maxLosses}），熔断已关冷却故不拦开仓。`,
        consecutiveLosses,
        maxLosses,
        cooldownMs,
        cooldownEnabled: false,
        circuitEnabled: true,
        triggeredAtIso,
        cooledDown: false,
        planId: 'plan5'
      };
    }

    if (remainingMs > 0) {
      const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
      return {
        allowed: false,
        reason: `Plan5 最近连续亏损 ${consecutiveLosses} 笔（阈值 ${maxLosses}），触发连亏熔断，冷却中约剩 ${remainingMin} 分钟后可重新开仓。`,
        consecutiveLosses,
        maxLosses,
        cooldownMs,
        cooldownEnabled: true,
        circuitEnabled: true,
        cooldownUntilIso: new Date(cooldownUntilMs).toISOString(),
        triggeredAtIso,
        remainingMs,
        planId: 'plan5'
      };
    }
    return {
      allowed: true,
      reason: null,
      consecutiveLosses,
      maxLosses,
      cooldownMs,
      cooldownEnabled: true,
      circuitEnabled: true,
      cooldownUntilIso: Number.isFinite(triggeredAtMs) ? new Date(cooldownUntilMs).toISOString() : null,
      triggeredAtIso,
      cooledDown: true,
      planId: 'plan5'
    };
  }

  canOpenPlan2MainUpgradeForWindow({ timeframe, slotIso, direction, symbol = null, planId = 'plan2' }) {
    const id = this.normalizePlanId(planId);
    const orders = this.getLiveOrdersForWindow({ planId: id, timeframe, slotIso, symbol });
    const active = orders.filter((order) => this.isLivePositionOpen(order) || this.isLivePositionPending(order));
    const opposite = active.find((order) => order.direction && order.direction !== direction);
    if (opposite) {
      return { allowed: false, openPosition: opposite, reason: `${timeframe} 本窗口已有反向实盘仓位。` };
    }
    const existingMain = active.find((order) => order.direction === direction && order.entryType === 'main');
    if (existingMain) {
      return { allowed: false, openPosition: existingMain, reason: `${timeframe} 本窗口主仓已存在。` };
    }
    const probe = active.find((order) => order.direction === direction && order.entryType === 'probe');
    if (!probe) {
      return { allowed: false, openPosition: null, reason: `${timeframe} 本窗口没有同向探针仓，不能追加主仓。` };
    }
    const circuit = this.checkPlan2LiveSlotLossCircuit({ timeframe, slotIso, symbol, planId: id });
    if (!circuit.allowed) return circuit;
    return { allowed: true, openPosition: null, probe };
  }

  canOpenLiveStopLossReversalForWindow({ timeframe, slotIso, direction, planId = 'plan2', symbol = null }) {
    const reversalPlanId = this.normalizePlanId(planId);
    if (
      reversalPlanId === PLAN13_ID
      || this.config.plan2StopLossReversalEnabled === false
      || this.isPlan2ExitSyncedToPaper(reversalPlanId)
    ) {
      return { allowed: false, reason: `${plan2FamilyLabel(reversalPlanId)} 止损反向单已关闭。` };
    }
    const orders = this.getLiveOrdersForWindow({ planId: reversalPlanId, timeframe, slotIso, symbol });
    const openPosition = orders.find((order) => this.isLivePositionOpen(order));
    if (openPosition) {
      return { allowed: false, openPosition, reason: `${timeframe} 本窗口仍有未平仓位。` };
    }
    const pendingBuy = orders.find((order) => this.isLivePositionPending(order));
    if (pendingBuy) {
      return { allowed: false, openPosition: pendingBuy, reason: `${timeframe} 本窗口买单待成交。` };
    }
    const reversalBuy = orders.find((order) => (
      order.orderSide !== 'SELL'
      && order.entryType === 'stop_loss_reversal'
    ));
    if (reversalBuy) {
      return { allowed: false, openPosition: reversalBuy, reason: `${timeframe} 本窗口已下过止损反向单。` };
    }
    const circuit = this.checkPlan2LiveSlotLossCircuit({ timeframe, slotIso, symbol, planId: reversalPlanId });
    if (!circuit.allowed) return circuit;
    const stopped = orders
      .filter((order) => (
        order.orderSide !== 'SELL'
        && order.positionStatus === 'closed'
        && isPlan2StopLossExitStatus(order.exitStatus)
        && order.reversalFollowed !== true
      ))
      .sort((a, b) => Date.parse(b.closedAtIso || b.createdAtIso || 0) - Date.parse(a.closedAtIso || a.createdAtIso || 0));
    const priorOrder = stopped[0];
    if (!priorOrder) {
      return { allowed: false, reason: `${timeframe} 本窗口没有可反向的止损单。` };
    }
    if (
      priorOrder.exitStatus === 'direction-reversal-stop'
      && this.config.plan2StopLossReversalAfterDirectionStop !== true
    ) {
      priorOrder.reversalFollowed = true;
      priorOrder.reversalBlockedReason = 'direction-reversal-stop';
      priorOrder.reversalBlockedAtIso = new Date().toISOString();
      return {
        allowed: false,
        priorOrder,
        reason: `${timeframe} 本窗口刚因方向反转止损，默认不再反手追单，避免震荡里连续双亏。`
      };
    }
    const opposite = priorOrder.direction === 'up' ? 'down' : 'up';
    if (direction && String(direction).toLowerCase() !== opposite) {
      return { allowed: false, priorOrder, reason: `止损反向需买 ${opposite.toUpperCase()}，当前为 ${String(direction || '--').toUpperCase()}。` };
    }
    return { allowed: true, priorOrder, oppositeDirection: opposite, reason: null };
  }

  checkPlan2LiveSlotLossCircuit({ timeframe, slotIso, symbol = null, planId = 'plan2' }) {
    const id = this.normalizePlanId(planId);
    const cfg = this.resolvePlan2Config(id);
    if (cfg.plan2LiveSlotLossCircuitEnabled === false) {
      return { allowed: true, reason: null, consecutiveLosses: 0 };
    }
    const maxLosses = Math.max(1, Number(cfg.plan2LiveSlotLossCircuitMaxLosses) || 2);
    const closedBuys = this.getLiveOrdersForWindow({ planId: id, timeframe, slotIso, symbol })
      .filter((order) => (
        order.orderSide !== 'SELL'
        && order.positionStatus === 'closed'
        && !isExpiredUnfilledLiveOrder(order)
        && !isDustClosedLiveOrder(order)
        && Number.isFinite(Number(order.pnl))
      ))
      .sort((a, b) => Date.parse(b.closedAtIso || b.createdAtIso || 0) - Date.parse(a.closedAtIso || a.createdAtIso || 0));
    let consecutiveLosses = 0;
    for (const order of closedBuys) {
      const pnl = Number(order.pnl) || 0;
      if (pnl < 0) consecutiveLosses += 1;
      else if (pnl > 0) break;
    }
    if (consecutiveLosses >= maxLosses) {
      const label = plan2FamilyLabel(id);
      const symbolNote = symbol ? ` ${symbol}` : '';
      return {
        allowed: false,
        reason: `${timeframe}${symbolNote} 本窗口 ${label} 已连续亏损 ${consecutiveLosses} 笔，触发本币熔断，停止继续开仓。`,
        consecutiveLosses,
        maxLosses,
        symbol: symbol || null,
        planId: id
      };
    }
    return { allowed: true, reason: null, consecutiveLosses, maxLosses, symbol: symbol || null, planId: id };
  }

  resolveReversalConfidence(planView, direction) {
    const dir = String(direction || '').toLowerCase();
    const signal = planView?.signal;
    const sentiment = planView?.polymarket;
    const recommendation = planView?.recommendation;
    if (signal?.direction === dir && Number.isFinite(Number(signal.confidence))) {
      return Number(signal.confidence);
    }
    if (recommendation?.direction === dir && Number.isFinite(Number(recommendation.confidence))) {
      return Number(recommendation.confidence);
    }
    if (sentiment?.available) {
      const poly = dir === 'up'
        ? Number(sentiment.upProbability ?? sentiment.upPrice)
        : Number(sentiment.downProbability ?? sentiment.downPrice);
      if (Number.isFinite(poly)) return poly;
    }
    return NaN;
  }

  hasLiveOrderForWindow({ planId = 'plan1', timeframe, slotIso }) {
    return Boolean(this.getOpenLivePositionForWindow({ planId, timeframe, slotIso }));
  }

  /** Scope claim/lastExecuted by planId so plan2_5 / plan2_6 do not steal each other's slots. */
  liveExecutionScopeKey(executionKey, planId = null) {
    if (!executionKey) return null;
    const id = planId ? this.normalizePlanId(planId) : null;
    return id ? `${id}::${executionKey}` : executionKey;
  }

  /** 同 executionKey 是否已有成功/挂起买单（不含 blocked / FAK 未成交可重试 / 窗口内灰尘待加仓）。 */
  hasBlockingLiveOrderForExecutionKey(executionKey, planId = null) {
    if (!executionKey) return false;
    const id = planId ? this.normalizePlanId(planId) : null;
    return (this.state.liveOrders || []).some((order) => {
      if (order.planKey !== executionKey || order.orderSide === 'SELL') return false;
      if (id && this.normalizePlanId(order.planId || 'plan1') !== id) return false;
      if (order.status === 'blocked' || order.exitStatus === 'expired-unfilled') return false;
      // Dust awaiting top-up must not block the same plan's retry/combine entry.
      if (order.dustTopUpPending === true) return false;
      return true;
    });
  }

  /** 同步占坑：CLOB await 期间阻止并发 tick 用同一 key 再下一单。 */
  tryClaimLiveExecutionKey(executionKey, planId = null) {
    if (!executionKey) return true;
    const claimKey = this.liveExecutionScopeKey(executionKey, planId);
    if (!this.liveExecutionClaims) this.liveExecutionClaims = new Set();
    if (this.liveExecutionClaims.has(claimKey)) return false;
    if (this.hasBlockingLiveOrderForExecutionKey(executionKey, planId)) return false;
    this.liveExecutionClaims.add(claimKey);
    return true;
  }

  releaseLiveExecutionKey(executionKey, planId = null) {
    if (!executionKey || !this.liveExecutionClaims) return;
    this.liveExecutionClaims.delete(this.liveExecutionScopeKey(executionKey, planId));
    // Also clear legacy unscoped claims from older builds.
    if (planId) this.liveExecutionClaims.delete(executionKey);
  }

  async markLiveExecuted(key, planId = null) {
    if (!key) return;
    if (!this.state.liveAuto) this.state.liveAuto = { ...DEFAULT_STATE.liveAuto };
    const scoped = this.liveExecutionScopeKey(key, planId);
    this.state.liveAuto.lastExecutedKeys = [
      scoped,
      ...(this.state.liveAuto.lastExecutedKeys || []).filter((item) => item !== scoped && item !== key)
    ].slice(0, 240);
    await this.persist('live');
  }

  unmarkLiveExecuted(key, planId = null) {
    if (!key || !Array.isArray(this.state.liveAuto?.lastExecutedKeys)) return;
    const scoped = this.liveExecutionScopeKey(key, planId);
    this.state.liveAuto.lastExecutedKeys = this.state.liveAuto.lastExecutedKeys
      .filter((item) => item !== scoped && item !== key);
  }

  hasLiveExecutedKey(key, planId = null) {
    if (!key) return false;
    const keys = this.state.liveAuto?.lastExecutedKeys || [];
    const scoped = this.liveExecutionScopeKey(key, planId);
    if (keys.includes(scoped)) return true;
    // Bare keys are legacy / unscoped writes. Never let them cross-block plans:
    // plan2_5 and plan2_6 historically shared "..._plan2_<entryType>" keys, and
    // matching bare keys here made the later plan look "already tried".
    // Per-plan window gates + hasBlockingLiveOrderForExecutionKey still prevent
    // true same-plan duplicates.
    if (!planId) return keys.includes(key);
    return false;
  }

  async updateLiveAutoRun(update = {}, planId = null) {
    if (!this.state.liveAuto) this.state.liveAuto = { ...DEFAULT_STATE.liveAuto };
    const nowIso = new Date().toISOString();
    this.state.liveAuto.lastRunAtIso = nowIso;
    if (Object.hasOwn(update, 'lastAction')) this.state.liveAuto.lastAction = update.lastAction;
    if (Object.hasOwn(update, 'lastReason')) this.state.liveAuto.lastReason = update.lastReason;
    if (Object.hasOwn(update, 'lastError')) this.state.liveAuto.lastError = update.lastError;
    if (Object.hasOwn(update, 'lastOrderId')) this.state.liveAuto.lastOrderId = update.lastOrderId;

    if (planId) {
      const id = this.normalizePlanId(planId);
      const planRuns = this.ensureLiveAutoPlanRuns(this.state.liveAuto.planRuns);
      planRuns[id] = {
        ...planRuns[id],
        lastRunAtIso: nowIso,
        ...(Object.hasOwn(update, 'lastAction') ? { lastAction: update.lastAction } : {}),
        ...(Object.hasOwn(update, 'lastReason') ? { lastReason: update.lastReason } : {}),
        ...(Object.hasOwn(update, 'lastError') ? { lastError: update.lastError } : {}),
        ...(Object.hasOwn(update, 'lastOrderId') ? { lastOrderId: update.lastOrderId } : {})
      };
      this.state.liveAuto.planRuns = planRuns;
    }
    await this.persist('live');
  }

  async maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc = null,
    closedOnly = false,
    readinessReady = true,
    resolveCurrentPrice = null
  }) {
    const auto = this.liveAutoStatus();
    let plan = planView?.plan;
    const sentiment = planView?.polymarket;
    const planId = this.normalizePlanId(planView?.planId || plan?.planId || planView?.plan?.planId);
    const noteRun = (update) => this.updateLiveAutoRun(update, planId);
    if (!auto.enabledPlans.includes(planId)) {
      return { executed: false, planId, reason: `${planId} 自动实盘未启动` };
    }
    if (!this.config.liveTradingEnabled) {
      await noteRun({ lastAction: 'skipped', lastReason: '实盘下单开关未开启', lastError: null });
      return { executed: false, planId, reason: '实盘下单开关未开启' };
    }
    if (planId === 'plan3' && this.config.plan3LiveEnabled !== true) {
      const reason = 'Plan3 实盘未启用（POLYMARKET_PLAN3_LIVE_ENABLED）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === 'plan3_5' && this.config.plan3_5LiveEnabled !== true) {
      const reason = 'Plan3.5 实盘未启用（POLYMARKET_PLAN3_5_LIVE_ENABLED）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === 'plan3_6' && this.config.plan3_6LiveEnabled !== true) {
      const reason = 'Plan3.6 实盘未启用（POLYMARKET_PLAN3_6_LIVE_ENABLED）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === 'plan5' && this.config.plan5Enabled !== true) {
      const reason = 'Plan5 已停用：历史实盘负期望，默认不再开仓。';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === PLAN11_ID && this.config.plan11Enabled === false) {
      const reason = 'Plan11 已禁用（POLYMARKET_PLAN11_ENABLED=false）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === PLAN11_ID && this.config.plan11LiveEnabled !== true) {
      const reason = 'Plan11 实盘未启用（POLYMARKET_PLAN11_LIVE_ENABLED≠true）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === PLAN13_ID && this.config.plan13Enabled === false) {
      const reason = 'Plan13 已禁用（POLYMARKET_PLAN13_ENABLED=false）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === PLAN13_ID && this.config.plan13LiveEnabled !== true) {
      const reason = 'Plan13 实盘未启用（POLYMARKET_PLAN13_LIVE_ENABLED≠true）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (planId === 'plan5' && this.config.plan5LiveEnabled !== true) {
      const reason = 'Plan5 实盘未启用（POLYMARKET_PLAN5_LIVE_ENABLED≠true）';
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (closedOnly) {
      await noteRun({ lastAction: 'skipped', lastReason: '账号处于 closed-only 限制', lastError: null });
      return { executed: false, planId, reason: '账号处于 closed-only 限制' };
    }
    // Plan2.5 / Plan1：有可用余额缓存时不因 readiness 瞬时失败整窗放弃。
    const cachedBalance = Number(clobBalanceUsdc);
    const allowWithoutFreshReady = (
      (
        this.isPlan2FamilyPlan(planId)
        && this.isPlan2EntrySyncedToPaperFor(planId)
      )
      || planId === 'plan1'
    )
      && Number.isFinite(cachedBalance)
      && cachedBalance > 0;
    if (!readinessReady && !allowWithoutFreshReady) {
      await noteRun({ lastAction: 'skipped', lastReason: '实盘 API 未就绪', lastError: null });
      return { executed: false, planId, reason: '实盘 API 未就绪' };
    }

    if (planId === 'plan1' && plan?.timeframe && plan?.slotIso) {
      const isOppositeHedge = String(plan?.action?.entryType || '').toLowerCase() === 'opposite_hedge';
      const openPosition = this.getOpenLivePositionForWindow({
        planId,
        timeframe: plan.timeframe,
        slotIso: plan.slotIso,
        symbol: plan.symbol
      });
      // opposite_hedge is a second window leg, not a direction flip of the main.
      if (!isOppositeHedge && openPosition && plan?.action?.shouldTrade && openPosition.direction !== plan.action.direction) {
        if (typeof resolveCurrentPrice !== 'function') {
          return { executed: false, planId, reason: 'direction flip requires price resolver' };
        }
        try {
          const flip = await this.maybeFlipLivePlan1Position({
            planView,
            resolveCurrentPrice,
            clobBalanceUsdc,
            closedOnly,
            readinessReady
          });
          if (flip.flipped) {
            return { executed: true, planId, flipped: true, closed: flip.closed, record: flip.record, result: flip.result };
          }
          if (openPosition) {
            const reason = flip.reason || 'direction flip blocked';
            await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
            return { executed: false, planId, reason };
          }
        } catch (error) {
          const friendly = humanizeClobError(error);
          await noteRun({
            lastAction: 'error',
            lastReason: friendly,
            lastError: friendly
          });
          return { executed: false, planId, reason: friendly };
        }
      }
      if (!isOppositeHedge && openPosition && plan?.action?.shouldTrade && openPosition.direction === plan.action.direction) {
        const reason = `${plan.timeframe} 本窗口已持有同方向仓位`;
        await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
        return { executed: false, planId, reason };
      }
    }

    if (this.isPlan2FamilyPlan(planId) && planId !== PLAN13_ID && plan?.timeframe && plan?.slotIso) {
      try {
        const reversal = await this.maybeLivePlan2StopLossReversal({
          planView,
          clobBalanceUsdc,
          closedOnly,
          readinessReady
        });
        if (reversal.reversed) {
          return {
            executed: true,
            planId,
            reversed: true,
            record: reversal.record,
            result: reversal.result,
            priorOrder: reversal.priorOrder
          };
        }
      } catch (error) {
        const friendly = humanizeClobError(error);
        await noteRun({
          lastAction: 'error',
          lastReason: friendly,
          lastError: friendly
        });
        return { executed: false, planId, reason: friendly };
      }
    }

    if (this.isPlan2FamilyPlan(planId) && plan?.action?.scheduleDelayedEntry) {
      await this.scheduleLivePlan2DelayedEntry({ plan });
      await noteRun({
        lastAction: 'scheduled',
        lastReason: plan.action.reason || 'Plan2 延迟入场已调度',
        lastError: null
      });
      return {
        executed: false,
        planId,
        scheduled: true,
        reason: plan.action.reason || 'Plan2 delayed entry scheduled'
      };
    }

    if (planId === 'plan5' && this.config.plan5OpportunityLogEnabled !== false) {
      const recorded = this.recordPlan5Opportunity(plan, 'plan5', sentiment);
      if (recorded) await this.persistOpportunityLog('plan5');
    }
    if (planId === 'plan3' && this.config.plan3OpportunityLogEnabled !== false) {
      this.recordPlan3Opportunity(plan, 'plan3', 'live');
      const skipReason = plan?.action?.skipReason;
      if (plan?.action?.shouldTrade || (skipReason && skipReason !== 'not_in_time_window')) {
        await this.persistOpportunityLog('plan3');
      }
    }

    // Plan5 / Plan2：同窗 FAK 无对手盘 blocked 后，即便本轮信号质量把 shouldTrade 打成 false，
    // 只要仍在冷却结束且未达重试上限，就继续用上次 blocked 草稿快速重试——
    // 否则会出现「一整窗只试 1–2 次就停」的死窗（5m 尤其致命）。
    let effectivePlanView = planView;
    let effectivePlan = plan;
    const blockedRetrySeed = (planId === 'plan5' || this.isPlan2FamilyPlan(planId))
      ? this.findRetryableBlockedLiveOrder({
        planId,
        symbol: plan?.symbol,
        timeframe: plan?.timeframe,
        slotIso: plan?.slotIso
      })
      : null;
    if (!effectivePlan?.action?.shouldTrade && blockedRetrySeed) {
      const retryLabel = planId === 'plan5'
        ? 'Plan5'
        : (this.isPlan2FamilyPlan(planId) ? plan2FamilyLabel(planId) : planId);
      // Prefer intended signal price over last failed/bumped limit so preflight
      // can reprice to the live ask instead of sticking on a stale 90¢ ceiling.
      const retryIntended = Number(blockedRetrySeed.intendedLimitPrice)
        || Number(blockedRetrySeed.limitPrice)
        || Number(effectivePlan.action?.intendedLimitPrice)
        || Number(effectivePlan.action?.limitPrice);
      effectivePlan = {
        ...effectivePlan,
        action: {
          ...(effectivePlan.action || {}),
          shouldTrade: true,
          direction: blockedRetrySeed.direction || effectivePlan.action?.direction,
          usd: Number(blockedRetrySeed.usd) || effectivePlan.action?.usd,
          limitPrice: Number.isFinite(retryIntended) ? retryIntended : effectivePlan.action?.limitPrice,
          intendedLimitPrice: Number.isFinite(retryIntended) ? retryIntended : effectivePlan.action?.intendedLimitPrice,
          executionKey: blockedRetrySeed.planKey || effectivePlan.action?.executionKey || effectivePlan.key,
          entryType: blockedRetrySeed.entryType || effectivePlan.action?.entryType || null,
          basketAllocation: blockedRetrySeed.basketAllocation || effectivePlan.action?.basketAllocation || null,
          expectedValueGate: blockedRetrySeed.expectedValueGate || effectivePlan.action?.expectedValueGate || null,
          lockStrength: blockedRetrySeed.lockStrength || effectivePlan.action?.lockStrength || null,
          lockPmGap: blockedRetrySeed.lockPmGap ?? effectivePlan.action?.lockPmGap ?? null,
          lockUpProbability: blockedRetrySeed.lockUpProbability ?? effectivePlan.action?.lockUpProbability ?? null,
          lockDownProbability: blockedRetrySeed.lockDownProbability ?? effectivePlan.action?.lockDownProbability ?? null,
          blockedRetryForce: true,
          reason: `${retryLabel} 同窗 FAK 未成交快速重试（第 ${(Number(blockedRetrySeed.retryCount) || 1) + 1} 次）。`
        },
        slotIso: effectivePlan.slotIso || blockedRetrySeed.slotIso,
        timeframe: effectivePlan.timeframe || blockedRetrySeed.timeframe,
        targetTimeIso: effectivePlan.targetTimeIso || blockedRetrySeed.targetTimeIso,
        symbol: effectivePlan.symbol || blockedRetrySeed.symbol
      };
      effectivePlanView = { ...planView, plan: effectivePlan, planId };
    }

    // Plan2 family dust top-up: FAK crumbs (<5 shares) must keep combining even after
    // the original lane (often settlement_capture_90) flips shouldTrade→false.
    // Always reuse the parent planKey so merge + sizing bump still match.
    const dustTopUpSeed = this.isPlan2FamilyPlan(planId)
      ? this.findLiveDustTopUpParent({
        planId,
        symbol: effectivePlan?.symbol || plan?.symbol,
        timeframe: effectivePlan?.timeframe || plan?.timeframe,
        slotIso: effectivePlan?.slotIso || plan?.slotIso
      })
      : null;
    if (dustTopUpSeed && this.isLiveEntryWindowOpenForDustRetry(dustTopUpSeed)) {
      const retryLabel = plan2FamilyLabel(planId);
      const topUpPx = Number(dustTopUpSeed.entryPrice)
        || Number(dustTopUpSeed.limitPrice)
        || Number(effectivePlan?.action?.limitPrice)
        || 0.5;
      const parentShares = Number(dustTopUpSeed.remainingShares ?? dustTopUpSeed.shares) || 0;
      const minShares = this.resolveLiveMinTradeableShares();
      // Only buy the deficit to reach min shares. Never place a second full min-size
      // order (that doubles notional on an already-bad partial FAK fill).
      const needShares = Math.max(0, minShares - parentShares);
      const topUpShares = Math.ceil(needShares - 1e-9);
      if (topUpShares > 0 && topUpShares + 1e-9 < minShares) {
        // CLOB typically rejects sub-min orders; skipping avoids ~2× loss size.
        // Parent remains dust-unsellable / local-close rather than doubled risk.
      } else if (topUpShares > 0) {
        const topUpUsd = Math.ceil(topUpShares * Math.max(topUpPx, 0.01) * 100) / 100;
        effectivePlan = {
          ...effectivePlan,
          action: {
            ...(effectivePlan?.action || {}),
            shouldTrade: true,
            direction: dustTopUpSeed.direction || effectivePlan?.action?.direction,
            usd: topUpUsd,
            limitPrice: Number.isFinite(topUpPx) ? topUpPx : effectivePlan?.action?.limitPrice,
            intendedLimitPrice: Number.isFinite(topUpPx) ? topUpPx : effectivePlan?.action?.intendedLimitPrice,
            executionKey: dustTopUpSeed.planKey || effectivePlan?.action?.executionKey || effectivePlan?.key,
            entryType: dustTopUpSeed.entryType || effectivePlan?.action?.entryType || null,
            sizeMultiplier: dustTopUpSeed.sizeMultiplier ?? effectivePlan?.action?.sizeMultiplier ?? null,
            dustTopUpForce: true,
            reason: `${retryLabel} 灰尘仓强制加仓（现有 ${parentShares.toFixed(4)} 份 → 补 ${topUpShares} 份至 ≥${minShares}）。`
          },
          slotIso: effectivePlan?.slotIso || dustTopUpSeed.slotIso,
          timeframe: effectivePlan?.timeframe || dustTopUpSeed.timeframe,
          targetTimeIso: effectivePlan?.targetTimeIso || dustTopUpSeed.targetTimeIso,
          symbol: effectivePlan?.symbol || dustTopUpSeed.symbol
        };
        effectivePlanView = { ...planView, plan: effectivePlan, planId };
      }
    }

    if (!effectivePlan?.action?.shouldTrade) {
      if (this.isPlan2FamilyPlan(planId) && effectivePlan?.action?.clearDelayedEntry && effectivePlan?.action?.delayedEntryKey) {
        await this.clearLivePlan2DelayedEntry(effectivePlan.action.delayedEntryKey);
      }
      // Plan5 unlocked: wait every tick — do not treat as a consumed skip.
      if (planId === 'plan5' && (effectivePlan?.action?.waitingForLock || effectivePlan?.action?.observeOnly)) {
        const reason = effectivePlan?.action?.reason || 'Plan5 未锁定，等待锁定';
        await noteRun({ lastAction: 'waiting', lastReason: reason, lastError: null });
        return { executed: false, planId, waitingForLock: true, observed: true, reason };
      }
      const reason = planId === 'plan3'
        ? (describePlan3ActionSkipReason(effectivePlan?.action) || 'plan skipped')
        : (effectivePlan?.action?.skipReason || effectivePlan?.action?.reason || 'plan skipped');
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }

    // Prefer hydrated plan for the rest of this execution path.
    planView = effectivePlanView;
    plan = effectivePlan;

    if (planId === 'plan1') {
      const maxOpenRaw = Number(this.config.plan1MaxOpenLivePositions);
      const maxOpen = Number.isFinite(maxOpenRaw) && maxOpenRaw > 0 ? Math.floor(maxOpenRaw) : 1;
      const openN = this.getOpenLivePositions('plan1').length;
      const pendingN = (this.state.liveOrders || []).filter((order) => (
        this.normalizePlanId(order.planId || 'plan1') === 'plan1'
        && order.orderSide !== 'SELL'
        && (order.status === 'pending' || order.positionStatus === 'pending')
      )).length;
      if (openN + pendingN >= maxOpen) {
        const reason = `Plan1 已有 ${openN + pendingN} 笔未结算仓（上限 ${maxOpen}），跳过新开仓。`;
        await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
        return { executed: false, planId, reason };
      }
      try {
        assertPlan1LiveEntryPriceAllowed(
          plan.action?.limitPrice,
          plan.timeframe || '15m',
          this.config
        );
      } catch (error) {
        const reason = error?.message || 'Plan1 执行价超过上限';
        await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
        return { executed: false, planId, reason };
      }
    }
    if (planId === PLAN11_ID) {
      const maxOpenRaw = Number(this.config.plan11MaxOpenLivePositions);
      const maxOpen = Number.isFinite(maxOpenRaw) && maxOpenRaw > 0 ? Math.floor(maxOpenRaw) : 1;
      const openN = this.getOpenLivePositions(PLAN11_ID).length;
      const pendingN = (this.state.liveOrders || []).filter((order) => (
        this.normalizePlanId(order.planId) === PLAN11_ID
        && order.orderSide !== 'SELL'
        && (order.status === 'pending' || order.positionStatus === 'pending')
      )).length;
      if (openN + pendingN >= maxOpen) {
        const reason = `Plan11 已有 ${openN + pendingN} 笔未结算仓（上限 ${maxOpen}），跳过新开仓。`;
        await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
        return { executed: false, planId, reason };
      }
      try {
        assertPlan11LiveEntryPriceAllowed(plan.action?.limitPrice, this.config);
      } catch (error) {
        const reason = error?.message || 'Plan11 执行价超过上限';
        await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
        return { executed: false, planId, reason };
      }
    }

    const globalDailyLoss = this.globalLiveDailyLossSnapshot({ clobBalanceUsdc });
    if (globalDailyLoss.triggered) {
      const reason = `全策略日亏损保护已触发：今日实盘已实现 PnL -$${Math.abs(globalDailyLoss.realizedPnl).toFixed(2)}，上限 $${globalDailyLoss.limitUsd.toFixed(2)}；停止所有 Plan 新开仓。`;
      await noteRun({ lastAction: 'risk-blocked', lastReason: reason, lastError: null });
      return { executed: false, planId, reason, globalDailyLoss };
    }

    const executionKey = plan.action?.executionKey || plan.key;
    const entry = this.isPlan2FamilyPlan(planId) && plan.action?.entryType === 'main'
        ? this.canOpenPlan2MainUpgradeForWindow({
          planId,
          timeframe: plan.timeframe,
          slotIso: plan.slotIso,
          direction: plan.action.direction,
          symbol: plan.symbol
        })
        : this.canOpenNewLiveEntryForWindow({
          planId,
          timeframe: plan.timeframe,
          slotIso: plan.slotIso,
          symbol: plan.symbol,
          marketSlug: plan.sentiment?.marketSlug || sentiment?.marketSlug,
          entryType: plan.action?.entryType,
          direction: plan.action?.direction
        });
    if (!entry.allowed) {
      const reason = entry.reason || `${plan.timeframe} 本窗口已下单`;
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason };
    }
    if (this.hasLiveExecutedKey(executionKey, planId)) {
      const allowBlockedRetry = this.shouldAllowLiveBlockedRetry(planId, executionKey);
      if (!allowBlockedRetry) {
        const reason = `${plan.timeframe} 本窗口已尝试过`;
        await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
        return { executed: false, planId, reason };
      }
    }
    // 必须在任何 await 之前同步占坑，否则两轮 tick 会在 CLOB 返回前各下一单。
    if (!this.tryClaimLiveExecutionKey(executionKey, planId)) {
      const reason = `${plan.timeframe} 同 key 正在提交或已成交，跳过重复下单`;
      await noteRun({ lastAction: 'skipped', lastReason: reason, lastError: null });
      return { executed: false, planId, reason, duplicateClaim: true };
    }

    try {
      // The live scan already completed readiness once for this tick. Reusing
      // that bounded snapshot avoids repeating profile, Polygon and CLOB checks
      // before every symbol order (one stalled check used to freeze the plan).
      const readinessInput = {
        ready: readinessReady === true,
        configured: true,
        liveTradingEnabled: true,
        clob: {
          ok: readinessReady === true,
          closedOnly: closedOnly === true,
          collateral: {
            balanceUsdc: Number(clobBalanceUsdc) || 0
          }
        }
      };
      const result = await this.createLiveOrder({
        planView,
        clobBalanceUsdc,
        readinessInput
      });
      const draft = result.draft || {};
      const actualPlan1Exits = planId === 'plan1'
        ? computePlan1ExitPrices(draft.limitPrice, this.config)
        : null;
      // matched 但无 tx hash 时不可直接记成交：CLOB 超时窗口会出现幽灵 matched。
      const filled = result.filled !== false && isClobBuyFillConfirmed(result.response);
      const awaitingConfirm = !filled && (
        result.awaitingConfirm === true
        || (isClobOrderFilled(result.response) && !hasClobTransactionHashes(result.response))
      );
      const buyOrderType = String(
        result.orderType || draft.orderType || this.config.liveBuyOrderType || 'FAK'
      ).toUpperCase();
      // FAK 未成交即死单：立刻标 expired-unfilled，下一 tick 可重评信号再下（受 maxPerKey 限制）
      // 有 matched 待确认时走 pending，交给 syncLivePendingBuys / getOrder 核实。
      const fakUnfilled = !filled && !awaitingConfirm
        && buyOrderType === 'FAK'
        && this.config.liveUnfilledRetryEnabled !== false;
      const record = await this.recordLiveOrder({
        status: filled ? 'submitted' : (fakUnfilled ? 'expired' : 'pending'),
        orderSide: 'BUY',
        positionStatus: filled ? 'open' : (fakUnfilled ? 'closed' : 'pending'),
        filledAtIso: filled ? new Date().toISOString() : null,
        fillConfirmed: filled === true,
        fillUnconfirmed: awaitingConfirm === true,
        ...(fakUnfilled ? {
          exitStatus: 'expired-unfilled',
          exitReason: 'FAK buy not filled · release for re-eval',
          pnl: 0,
          payoutUsd: 0,
          closedAtIso: new Date().toISOString()
        } : {}),
        symbol: draft.symbol || plan.symbol || 'BTC-USD',
        timeframe: draft.timeframe || plan.timeframe,
        planId: draft.planId || planId,
        planKey: executionKey || draft.planKey || plan.key || null,
        entryType: draft.entryType || plan.action?.entryType || null,
        entryTier: draft.entryTier || plan.action?.entryTier || null,
        lockStrength: draft.lockStrength
          || plan.action?.lockStrength
          || plan.intervalPmLock?.strength
          || null,
        lockPmGap: draft.lockPmGap ?? plan.action?.lockPmGap ?? plan.intervalPmLock?.pmGap ?? null,
        lockedAtIso: draft.lockedAtIso || plan.action?.lockedAtIso || plan.intervalPmLock?.lockedAtIso || null,
        signalQuality: draft.signalQuality || plan.action?.signalQuality || null,
        expectedValueGate: draft.expectedValueGate || plan.action?.expectedValueGate || null,
        marketAlignment: draft.marketAlignment || plan.action?.marketAlignment || null,
        consensusGate: draft.consensusGate || plan.action?.consensusGate || null,
        entryTiming: draft.entryTiming || plan.action?.entryTiming || null,
        entryPriceGate: draft.entryPriceGate || plan.action?.entryPriceGate || null,
        historyWinRateGate: draft.historyWinRateGate || plan.action?.historyWinRateGate || null,
        winrateGuidanceGate: draft.winrateGuidanceGate || plan.action?.winrateGuidanceGate || null,
        lossReasonGate: draft.lossReasonGate || plan.action?.lossReasonGate || null,
        basketAllocation: draft.basketAllocation || plan.action?.basketAllocation || null,
        directionRecheck: draft.directionRecheck || plan.action?.directionRecheck || null,
        liveDirectionRecheck: draft.liveDirectionRecheck || null,
        signalDirection: draft.signalDirection || plan.action?.signalDirection || null,
        technicalDirection: draft.technicalDirection || plan.action?.technicalDirection || null,
        spotDirection: draft.spotDirection || plan.action?.spotDirection || null,
        lockUpProbability: draft.lockUpProbability ?? plan.action?.lockUpProbability ?? null,
        lockDownProbability: draft.lockDownProbability ?? plan.action?.lockDownProbability ?? null,
        strategyVersion: draft.strategyVersion || plan.action?.strategyVersion || null,
        modelDirection: draft.modelDirection || plan.action?.modelDirection || null,
        modelConfidence: draft.modelConfidence ?? plan.action?.modelConfidence ?? null,
        modelEdge: draft.modelEdge ?? plan.action?.modelEdge ?? null,
        sizeMultiplier: draft.sizeMultiplier ?? plan.action?.sizeMultiplier ?? null,
        sizeBand: draft.sizeBand ?? plan.action?.sizeBand ?? null,
        sizeScale: draft.sizeScale ?? plan.action?.sizeScale ?? null,
        sizeFloorBumpNote: draft.sizeFloorBumpNote || null,
        intendedLimitPrice: draft.intendedLimitPrice ?? null,
        intendedUsd: draft.intendedUsd ?? draft.requestedUsd ?? null,
        executionPreflightPrice: draft.executionPreflightPrice ?? null,
        slotIso: draft.slotIso || plan.slotIso || null,
        direction: draft.direction,
        outcome: draft.outcome,
        usd: draft.usd,
        shares: draft.shares,
        limitPrice: draft.limitPrice,
        entryPrice: draft.limitPrice,
        tokenId: draft.tokenId,
        market: draft.market,
        marketSlug: draft.marketSlug,
        targetTimeIso: draft.targetTimeIso || plan.targetTimeIso || null,
        takeProfitPrice: actualPlan1Exits?.takeProfitPrice ?? plan.action?.takeProfitPrice ?? null,
        stopLossPrice: actualPlan1Exits?.stopLossPrice ?? plan.action?.stopLossPrice ?? null,
        confidence: Number(plan.action?.confidence) || null,
        clobOrderId: result.clobOrderId,
        clobStatus: result.response?.status,
        clobSuccess: result.response?.success,
        clobResponse: result.response,
        note: [
          draft.sizeFloorBumpNote || null,
          filled
            ? `Live auto ${plan.timeframe} ${planId} buy submitted.`
            : awaitingConfirm
              ? `Live auto ${plan.timeframe} ${planId} CLOB 回报 matched 但无交易哈希，待确认后才计入持仓。`
              : fakUnfilled
                ? `Live auto ${plan.timeframe} ${planId} FAK 未成交，已释放可重试。`
                : `Live auto ${plan.timeframe} ${planId} buy pending fill (${result.response?.status || 'unknown'}).`
        ].filter(Boolean).join(' · '),
        ...(planId === 'plan3' ? {
          pmUpPrice: draft.entryPmSnapshot?.upPrice ?? plan.action?.pmUpPrice ?? sentiment?.upPrice ?? null,
          pmDownPrice: draft.entryPmSnapshot?.downPrice ?? plan.action?.pmDownPrice ?? sentiment?.downPrice ?? null,
          secondsRemaining: plan.action?.secondsRemaining ?? draft.entryContext?.secondsRemaining ?? null,
          intendedLimitPrice: draft.intendedLimitPrice ?? draft.limitPrice ?? null,
          entryPmSnapshot: draft.entryPmSnapshot || null,
          entryContext: draft.entryContext || null,
          preEntryPmReversal: draft.preEntryPmReversal || null
        } : {})
      });
      if (filled) {
        await this.markLiveExecuted(executionKey, planId);
        // If this fill is a top-up for an earlier undersized dust, merge into parent.
        const mergedParent = await this.maybeMergeLiveDustTopUpFill(record, planId);
        if (mergedParent) {
          await noteRun({
            lastAction: 'dust-topup-merged',
            lastReason: `${plan.timeframe} 灰尘仓加仓合并至 ${Number(mergedParent.shares || 0).toFixed(4)} 份`,
            lastError: null,
            lastOrderId: mergedParent.id
          });
          return {
            executed: true,
            planId,
            pending: false,
            dustTopUpMerged: true,
            record: mergedParent,
            result
          };
        }
        // Plan5 holds to official settlement. An undersized fill cannot be sold,
        // but that does not mean it was actually sold or that its PnL is zero.
        // Keep it open; the settlement loop will assign the real payout.
        if (this.isLiveDustUnsellablePosition(record) && planId !== 'plan5') {
          // Still inside entry window: keep open and retry/combine with a bumped
          // FAK instead of synthetic dust-close (recoverable undersized fill).
          if (this.isLiveEntryWindowOpenForDustRetry(record)) {
            record.dustTopUpPending = true;
            record.note = `${record.note || ''} · 成交过小，窗口内将加仓补到可卖份数`.trim();
            this.unmarkLiveExecuted(executionKey, planId);
            await this.persist('live');
            await noteRun({
              lastAction: 'dust-topup-pending',
              lastReason: `${plan.timeframe} 成交过小（$${Number(record.usd || 0).toFixed(2)} / ${Number(record.shares || 0).toFixed(4)} 份），窗口内重试加仓`,
              lastError: null,
              lastOrderId: record.id
            });
            return {
              executed: true,
              planId,
              pending: false,
              dustTopUpPending: true,
              record,
              result
            };
          }
          await this.holdLiveDustPosition(record, {
            exitReason: `FAK 成交过小（$${Number(record.usd || 0).toFixed(2)} / ${Number(record.shares || 0).toFixed(4)} 份），保留真实持仓等待官方结算`
          });
          await noteRun({
            lastAction: 'dust-holding',
            lastReason: `${plan.timeframe} 小额真实持仓 ${Number(record.shares || 0).toFixed(4)} 份，未卖出`,
            lastError: null,
            lastOrderId: record.id
          });
          return { executed: true, planId, pending: false, dustHeld: true, record, result };
        }
        if (draft.tokenId) {
          import('./polymarketLiveClob.js')
            .then(async ({ createPolymarketClobClient, warmConditionalTokenForSell }) => {
              const client = await createPolymarketClobClient(this.config);
              return warmConditionalTokenForSell(client, draft.tokenId, {
                expectedShares: draft.shares,
                retries: 5,
                delayMs: 2000
              });
            })
            .catch(() => {});
        }
        if (planId === 'plan1') {
          await this.placeLivePlan1TakeProfitOrder(record);
        }
      } else if (fakUnfilled) {
        // 记一次尝试；同 key 可由 shouldAllowLiveBlockedRetry 在冷却后放行
        await this.markLiveExecuted(executionKey, planId);
      } else {
        // GTC pending：也写入 executionKey，释放后走 blocked-retry / maxPerKey，避免无限挂单
        if (executionKey) await this.markLiveExecuted(executionKey, planId);
      }
      if (this.isPlan2FamilyPlan(planId) && plan.action?.delayedEntryKey && filled) {
        await this.clearLivePlan2DelayedEntry(plan.action.delayedEntryKey);
      }
      if (this.isPlan2FamilyPlan(planId) && plan.action?.scheduleProbeUpgrade && filled) {
        await this.scheduleLivePlan2ProbeUpgrade({ plan, draft });
      }
      await noteRun({
        lastAction: filled ? 'submitted' : (awaitingConfirm ? 'pending-confirm' : (fakUnfilled ? 'unfilled-retryable' : 'pending')),
        lastReason: filled
          ? `${plan.timeframe} ${draft.outcome} $${draft.usd}`
          : awaitingConfirm
            ? `${plan.timeframe} matched 待确认（无 tx）`
          : fakUnfilled
            ? `${plan.timeframe} FAK 未成交，等待重评再下`
            : `${plan.timeframe} 买单待成交 (${result.response?.status || 'live'})`,
        lastError: null,
        lastOrderId: record.id
      });
      return {
        executed: filled,
        planId,
        pending: !filled && !fakUnfilled,
        awaitingConfirm,
        unfilledRetryable: fakUnfilled,
        record,
        result
      };
    } catch (error) {
      const action = plan?.action || {};
      let draftMeta = {};
      try {
        draftMeta = this.buildLiveOrderDraft({
          plan,
          sentiment,
          recommendation: planView.recommendation,
          planId,
          clobBalanceUsdc
        });
      } catch {
        // keep plan-level fallback fields below
      }
      const friendlyError = humanizeClobError(error, draftMeta);
      // 敞口已满 / 余额不够最小单等：静默跳过，不写「买入拦截」刷屏（Plan1 与 Plan2.x 对齐）。
      if (shouldSkipLiveBlockedBuyRecord(friendlyError, {
        planId,
        entryType: action.entryType || draftMeta.entryType || null
      })) {
        await noteRun({
          lastAction: 'skipped',
          lastReason: friendlyError,
          lastError: null
        });
        return { executed: false, planId, reason: friendlyError, skippedNoisyBlock: true };
      }
      const existingBlocked = (this.state.liveOrders || []).find((order) => (
        order.status === 'blocked'
        && order.orderSide === 'BUY'
        && order.planKey === executionKey
      ));
      if (existingBlocked) {
        const retryableBlocked = this.liveBlockedRetryEnabled(planId);
        const nowIso = new Date().toISOString();
        const retryDelayMs = this.resolveLiveBlockedRetryDelayMs(
          friendlyError,
          planId,
          existingBlocked.timeframe || plan.timeframe
        );
        existingBlocked.error = friendlyError;
        existingBlocked.retryCount = (Number(existingBlocked.retryCount) || 1) + 1;
        existingBlocked.lastRetryAtIso = nowIso;
        existingBlocked.nextRetryAtIso = retryableBlocked
          ? new Date(Date.now() + retryDelayMs).toISOString()
          : null;
        existingBlocked.note = retryableBlocked
          ? (isStructuralLiveUnderfundError(friendlyError)
            ? `${planId.toUpperCase()} 结构性资金不足（风控上限低于 CLOB 最小），本窗口第 ${existingBlocked.retryCount} 次后冷却，下次 ${existingBlocked.nextRetryAtIso}。`
            : `${planId.toUpperCase()} live order blocked；本窗口第 ${existingBlocked.retryCount} 次尝试，下次重试 ${existingBlocked.nextRetryAtIso}。`)
          : 'Live auto order blocked (updated).';
        await this.persist('live');
        if (executionKey) await this.markLiveExecuted(executionKey, planId);
        await noteRun({
          lastAction: retryableBlocked ? 'blocked' : 'error',
          lastReason: friendlyError,
          lastError: friendlyError,
          lastOrderId: existingBlocked.id
        });
        return { executed: false, planId, reason: friendlyError, record: existingBlocked, retryable: retryableBlocked };
      }
      const retryableBlocked = this.liveBlockedRetryEnabled(planId);
      const retryDelayMs = this.resolveLiveBlockedRetryDelayMs(
        friendlyError,
        planId,
        draftMeta.timeframe || plan.timeframe
      );
      const nextRetryAtIso = retryableBlocked
        ? new Date(Date.now() + retryDelayMs).toISOString()
        : null;
      const record = await this.recordLiveOrder({
        status: 'blocked',
        orderSide: 'BUY',
        positionStatus: null,
        symbol: draftMeta.symbol || plan.symbol || 'BTC-USD',
        timeframe: draftMeta.timeframe || plan.timeframe,
        planId,
        planKey: executionKey || null,
        entryType: draftMeta.entryType || action.entryType || null,
        entryTier: draftMeta.entryTier || action.entryTier || null,
        sizeMultiplier: draftMeta.sizeMultiplier ?? action.sizeMultiplier ?? null,
        directionRecheck: draftMeta.directionRecheck || action.directionRecheck || null,
        signalDirection: draftMeta.signalDirection || action.signalDirection || null,
        technicalDirection: draftMeta.technicalDirection || action.technicalDirection || null,
        spotDirection: draftMeta.spotDirection || action.spotDirection || null,
        lockUpProbability: draftMeta.lockUpProbability ?? action.lockUpProbability ?? null,
        lockDownProbability: draftMeta.lockDownProbability ?? action.lockDownProbability ?? null,
        basketAllocation: draftMeta.basketAllocation || action.basketAllocation || null,
        expectedValueGate: draftMeta.expectedValueGate || action.expectedValueGate || null,
        slotIso: draftMeta.slotIso || plan.slotIso || null,
        direction: draftMeta.direction || action.direction,
        outcome: draftMeta.outcome || (action.direction === 'up' ? 'UP' : action.direction === 'down' ? 'DOWN' : null),
        usd: draftMeta.usd ?? action.usd,
        shares: draftMeta.shares ?? null,
        limitPrice: draftMeta.limitPrice ?? action.limitPrice,
        tokenId: draftMeta.tokenId || null,
        market: draftMeta.market || null,
        marketSlug: draftMeta.marketSlug || null,
        targetTimeIso: draftMeta.targetTimeIso || plan.targetTimeIso || null,
        ...(planId === 'plan3' ? {
          pmUpPrice: draftMeta.entryPmSnapshot?.upPrice ?? action.pmUpPrice ?? planView.polymarket?.upPrice ?? null,
          pmDownPrice: draftMeta.entryPmSnapshot?.downPrice ?? action.pmDownPrice ?? planView.polymarket?.downPrice ?? null,
          secondsRemaining: action.secondsRemaining ?? draftMeta.entryContext?.secondsRemaining ?? null,
          intendedLimitPrice: draftMeta.intendedLimitPrice ?? action.limitPrice ?? null,
          entryPmSnapshot: draftMeta.entryPmSnapshot || null,
          entryContext: draftMeta.entryContext || null,
          preEntryPmReversal: draftMeta.preEntryPmReversal || null
        } : {}),
        error: friendlyError,
        retryCount: 1,
        lastRetryAtIso: new Date().toISOString(),
        nextRetryAtIso,
        note: retryableBlocked
          ? (isStructuralLiveUnderfundError(friendlyError)
            ? `${planId.toUpperCase()} 结构性资金不足（风控上限低于 CLOB 最小），本窗口冷却至 ${nextRetryAtIso}。`
            : `${planId.toUpperCase()} live order blocked before fill；本窗口第 1 次尝试，下次重试 ${nextRetryAtIso}。`)
          : 'Live auto order blocked before or during CLOB submission.'
      });
      if (executionKey) await this.markLiveExecuted(executionKey, planId);
      await noteRun({
        lastAction: retryableBlocked ? 'blocked' : 'error',
        lastReason: friendlyError,
        lastError: friendlyError,
        lastOrderId: record.id
      });
      return { executed: false, planId, reason: friendlyError, record, retryable: retryableBlocked };
    } finally {
      this.releaseLiveExecutionKey(executionKey, planId);
    }
  }

  statusForPlan(planId = 'plan1') {
    if (this.isPlan2FamilyPlan(planId)) this.prunePlan2DelayedEntries(this.normalizePlanId(planId));
    const bucket = this.getBucket(planId);
    const stats = this.computeStats(planId);
    const equity = stats.equity || bucket.portfolio.startingCash || this.defaultStartingCash;
    const cashForSizing = bucket.portfolio.portfolioInitialized ? bucket.portfolio.cash : equity;
    const plan3SizingConfig = planId === 'plan3'
      ? resolvePlan3RuntimeConfig(this.config)
      : this.config;
    const plan3SizingAt99 = calculatePlan3OrderUsd({
      equity,
      cash: cashForSizing,
      tokenPrice: 0.99,
      config: plan3SizingConfig,
      paperMode: this.config.plan3LiveEnabled !== true
    });
    const plan3SizingAt90 = calculatePlan3OrderUsd({
      equity,
      cash: cashForSizing,
      tokenPrice: 0.90,
      config: plan3SizingConfig,
      paperMode: this.config.plan3LiveEnabled !== true
    });
    return {
      planId,
      algorithm: planId,
      auto: {
        ...bucket.auto,
        symbols: normalizeLiveSymbols(
          Array.isArray(bucket.auto?.symbols) && bucket.auto.symbols.length
            ? bucket.auto.symbols
            : DEFAULT_STATE.plans.plan1.auto.symbols
        )
      },
      portfolio: this.snapshotPortfolio(planId),
      stats,
      currentVersionStats: planId === 'plan5'
        ? this.computeStrategyVersionStats(planId, PLAN5_VERSION)
        : planId === PLAN14_ID ? this.computeStrategyVersionStats(planId, PLAN14_VERSION) : undefined,
      previousVersionStats: planId === PLAN14_ID ? this.computeStrategyVersionStats(planId, PLAN14_V8_VERSION) : undefined,
      exitControlComparison: planId === PLAN14_ID ? summarizePlan14ExitControl(bucket.paperOrders) : undefined,
      profitExperiment: planId === PLAN14_ID ? summarizePlan14ProfitExperiment(bucket.plan14ProfitExperiment) : undefined,
      researchArchiveErrors: planId === PLAN14_ID ? (bucket.plan14ResearchArchiveErrors || 0) : undefined,
      opportunitySummary: planId === 'plan5'
        ? this.summarizePlan5Opportunities(planId)
        : undefined,
      shadowAnalytics: planId === 'plan5'
        ? this.computePlan5ShadowAnalytics()
        : undefined,
      recentOpportunities: planId === 'plan5'
        ? (bucket.plan5OpportunityLog || []).slice(0, 40)
        : undefined,
      recentTrajectoryExperiments: ['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan13'].includes(planId)
        ? (bucket.trajectoryExperimentLog || []).slice(0, 40)
        : undefined,
      strategyVersion: resolvePlan2StrategyVersion(planId)
        || (planId === PLAN11_ID ? PLAN11_VERSION : undefined)
        || (planId === PLAN13_ID ? PLAN13_VERSION : undefined)
        || (planId === PLAN14_ID ? PLAN14_VERSION : undefined),
      plan2_6Rules: planId === PLAN2_6_ID ? buildPlan26RulesSnapshot(this.config) : undefined,
      plan11Rules: planId === PLAN11_ID ? buildPlan11RulesSnapshot(this.config) : undefined,
      plan13Rules: planId === PLAN13_ID ? buildPlan13RulesSnapshot(this.config) : undefined,
      plan14Rules: planId === PLAN14_ID ? buildPlan14RulesSnapshot(this.config) : undefined,
      currentSizing: planId === 'plan3'
        ? {
          equity: round2(equity),
          '5m': { usd: plan3SizingAt99, atPrice: 0.99, exampleAt90: plan3SizingAt90 },
          '15m': { usd: plan3SizingAt99, atPrice: 0.99, exampleAt90: plan3SizingAt90 }
        }
        : {
          equity: round2(equity),
          '5m': computePolymarketOrderUsd({ equity, cash: cashForSizing, timeframe: '5m', config: this.config }),
          '15m': computePolymarketOrderUsd({ equity, cash: cashForSizing, timeframe: '15m', config: this.config })
        }
    };
  }

  async configurePortfolio({ cash, planId = 'plan1' } = {}) {
    const id = this.normalizePlanId(planId);
    const bucket = this.getBucket(id);
    const startingCash = Math.max(0, Number(cash));
    if (!Number.isFinite(startingCash) || startingCash <= 0) {
      throw new Error('初始本金必须大于 0。');
    }
    const openOrders = bucket.paperOrders.filter((order) => order.settlementStatus === 'open');
    if (openOrders.length) {
      throw new Error(`${id} 仍有未结算订单，请先清空后再修改本金。`);
    }
    bucket.portfolio = { startingCash, cash: startingCash, portfolioInitialized: true };
    bucket.daily = { dateKey: currentDateKey(), realizedPnl: 0 };
    await this.persist(id);
    return this.snapshotPortfolio(id);
  }

  async resetPortfolio(planId = 'plan1') {
    const id = this.normalizePlanId(planId);
    // 重置热路径：先停自动、清空内存，写盘跳过 stats 同步，避免卡死前端
    const existingAuto = this.getBucket(id)?.auto || {};
    if (existingAuto.enabled) {
      existingAuto.enabled = false;
      existingAuto.stoppedAtIso = new Date().toISOString();
      existingAuto.lastAction = 'reset-stopped';
    }
    this.state.plans[id] = freshPlanBucket(id);
    await this.persist(id, { skipStatsSync: true });
    this.scheduleBackgroundStatsSync(id);
    return this.snapshotPortfolio(id);
  }

  snapshotPortfolio(planId = 'plan1') {
    const stats = this.computeStats(planId);
    const bucket = this.getBucket(planId);
    return {
      planId,
      ...bucket.portfolio,
      equity: round2(stats.equity),
      openExposureUsd: round2(stats.openExposureUsd),
      realizedPnl: round2(stats.realizedPnl),
      totalReturn: round4(stats.totalReturn)
    };
  }

  computeStats(planId = 'plan1', timeframe = null) {
    const bucket = this.getBucket(planId);
    const startingCash = Number(bucket.portfolio.startingCash) || 0;
    const cash = Number(bucket.portfolio.cash) || 0;
    const orders = timeframe
      ? (bucket.paperOrders || []).filter((order) => (order.timeframe || '15m') === timeframe)
      : bucket.paperOrders || [];
    const settled = orders.filter((order) => order.settlementStatus === 'settled');
    const open = orders.filter((order) => order.settlementStatus === 'open');
    const wins = settled.filter((order) => order.won);
    const retainedRealizedPnl = settled.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
    const openExposureUsd = open.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const equity = cash + openExposureUsd;
    const lifetimeRealizedPnl = timeframe || startingCash <= 0
      ? retainedRealizedPnl
      : equity - startingCash;
    const bySymbol = {};
    for (const order of settled) {
      const symbol = String(order.symbol || 'BTC-USD').toUpperCase();
      if (!bySymbol[symbol]) {
        bySymbol[symbol] = { total: 0, wins: 0, losses: 0, totalPnl: 0 };
      }
      bySymbol[symbol].total += 1;
      if (order.won) bySymbol[symbol].wins += 1;
      else bySymbol[symbol].losses += 1;
      bySymbol[symbol].totalPnl = Math.round(
        (bySymbol[symbol].totalPnl + (Number(order.pnl) || 0)) * 100
      ) / 100;
    }
    for (const symbol of Object.keys(bySymbol)) {
      const row = bySymbol[symbol];
      row.winRate = row.total ? row.wins / row.total : 0;
      row.samples = row.total;
      row.settledOrders = row.total;
    }
    return {
      planId,
      startingCash,
      cash,
      equity,
      openExposureUsd,
      openOrders: open.length,
      settledOrders: settled.length,
      winRate: settled.length ? wins.length / settled.length : 0,
      wins: wins.length,
      losses: settled.length - wins.length,
      realizedPnl: lifetimeRealizedPnl,
      retainedRealizedPnl,
      lifetimeRealizedPnl,
      historyTruncated: !timeframe && orders.length >= PAPER_ORDERS_HARD_CAP,
      totalReturn: startingCash > 0 ? (equity - startingCash) / startingCash : 0,
      dailyRealizedPnl: this.currentDailyRealizedPnl(planId),
      bySymbol
    };
  }

  getAdaptiveLiveRiskRows({ planId, source, lookbackDays }) {
    const normalizedPlanId = this.normalizePlanId(planId || 'plan1');
    const cacheKey = `live-adaptive-risk:${normalizedPlanId}:${source}:${lookbackDays}`;
    return this.getCachedAnalysis(cacheKey, 30000, () => {
      if (this.statsDb?.enabled && typeof this.statsDb.getLossReasonOrders === 'function') {
        return this.statsDb.getLossReasonOrders({
          planId: normalizedPlanId,
          source,
          lookbackDays
        });
      }
      if (source === 'live') return this.getLiveClosedBuys(normalizedPlanId);
      return (this.getBucket(normalizedPlanId).paperOrders || []).filter((order) => (
        order.settlementStatus === 'settled'
        && order.exitStatus !== 'expired-unfilled'
        && (order.won === true || order.won === false)
      ));
    });
  }

  buildAdaptiveLiveOrderCap({
    planId,
    symbol,
    timeframe,
    entryType,
    entryPrice,
    equity,
    minOrderUsd,
    confidence,
    edge,
    qualityScore
  }) {
    if (this.config.liveAdaptiveCapEnabled !== true) return null;
    const lookbackDays = Math.max(1, Number(this.config.liveAdaptiveCapLookbackDays) || 30);
    return computeAdaptiveLiveOrderCap({
      equity,
      absoluteMaxUsd: Number(this.config.liveMaxOrderUsd) || Number(this.config.maxOrderUsd) || 100,
      baseEquityPct: Number(this.config.liveAdaptiveCapBaseEquityPct) || 0.08,
      floorEquityPct: Number(this.config.liveAdaptiveCapFloorEquityPct) || 0.03,
      maxEquityPct: Number(this.config.liveAdaptiveCapMaxEquityPct) || 0.10,
      minOrderUsd,
      minSamples: Math.max(1, Number(this.config.liveAdaptiveCapMinSamples) || 12),
      paperWeight: Math.max(0, Math.min(1, Number(this.config.liveAdaptiveCapPaperWeight) || 0.20)),
      liveOrders: this.getAdaptiveLiveRiskRows({ planId, source: 'live', lookbackDays }),
      paperOrders: this.getAdaptiveLiveRiskRows({ planId, source: 'paper', lookbackDays }),
      symbol,
      timeframe,
      entryType,
      entryPrice,
      confidence,
      edge,
      qualityScore
    });
  }

  computeStrategyVersionStats(planId, strategyVersion) {
    const version = String(strategyVersion || '').trim();
    const settled = (this.getBucket(planId).paperOrders || []).filter((order) => (
      order.settlementStatus === 'settled'
      && String(order.strategyVersion || '') === version
    ));
    const wins = settled.filter((order) => order.won === true).length;
    const realizedPnl = settled.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
    return {
      strategyVersion: version,
      settledOrders: settled.length,
      wins,
      losses: settled.length - wins,
      winRate: settled.length ? wins / settled.length : 0,
      realizedPnl: round2(realizedPnl)
    };
  }

  /**
   * 分币胜率：优先纸面 bucket；若 lookbackDays 指定且 statsDb 可用，可叠加 DB 样本。
   * sizing 默认用纸面 bySymbol（与当前账户一致）。
   */
  getSymbolWinRates(planId = 'plan1', { timeframe = null, lookbackDays = null } = {}) {
    const paperStats = this.computeStats(planId, timeframe);
    const bySymbol = { ...(paperStats.bySymbol || {}) };
    const days = Number(lookbackDays);
    if (Number.isFinite(days) && days > 0 && this.statsDb?.enabled && typeof this.statsDb.getPlanEntryStatsBySymbol === 'function') {
      const cacheKey = `symbol-win-rates:${planId}:${timeframe || 'all'}:${days}`;
      const dbStats = this.getCachedAnalysis(cacheKey, 30_000, () => (
        this.statsDb.getPlanEntryStatsBySymbol({
          planId,
          timeframe,
          lookbackDays: days,
          source: 'all'
        })
      ));
      for (const [symbol, row] of Object.entries(dbStats || {})) {
        const key = String(symbol).toUpperCase();
        if (!bySymbol[key] || (Number(row.total) || 0) > (Number(bySymbol[key].total) || 0)) {
          bySymbol[key] = row;
        }
      }
    }
    return bySymbol;
  }

  computePlan1Analytics() {
    return computePlan1Analytics(this.getBucket('plan1').paperOrders || []);
  }

  computeExitDecisionAnalytics({ planId = null, includeLive = true, source = null } = {}) {
    const orders = [];
    const planIds = planId && planId !== 'all'
      ? [this.normalizePlanId(planId)]
      : PLAN_IDS;
    const wantPaper = source !== 'live';
    const wantLive = source !== 'paper' && includeLive !== false;

    if (wantPaper) {
      for (const id of planIds) {
        for (const order of this.getBucket(id).paperOrders || []) {
          if (order.settlementStatus !== 'settled') continue;
          orders.push({ ...order, planId: order.planId || id, source: 'paper' });
        }
      }
    }
    if (wantLive) {
      for (const order of this.state.liveOrders || []) {
        if (order.orderSide === 'SELL') continue;
        if (order.positionStatus !== 'closed') continue;
        if (order.exitStatus === 'expired-unfilled') continue;
        orders.push({ ...order, source: 'live' });
      }
    }
    return aggregateExitDecisionAnalytics(orders);
  }

  async backfillEarlyExitOutcomes(resolveOutcome, { now = new Date() } = {}) {
    if (typeof resolveOutcome !== 'function') {
      throw new Error('resolveOutcome callback is required.');
    }
    const nowMs = now.getTime();
    const cache = new Map();
    let updated = 0;

    const resolveCached = async (order) => {
      const key = `${order.symbol || 'BTC-USD'}_${order.timeframe || '15m'}_${order.targetTimeIso}`;
      if (!cache.has(key)) {
        cache.set(key, await resolveOutcome(order));
      }
      return cache.get(key);
    };

    const needsEvaluation = (order) => {
      if (!isEarlyExitStatus(order.exitStatus)) return false;
      if (!order.targetTimeIso || Date.parse(order.targetTimeIso) > nowMs - 15_000) return false;
      return !order.actualDirection || order.exitDecisionCorrect == null;
    };

    for (const planId of PLAN_IDS) {
      for (const order of this.getBucket(planId).paperOrders || []) {
        if (order.settlementStatus !== 'settled') continue;
        if (!needsEvaluation(order)) continue;
        try {
          const outcome = await resolveCached(order);
          if (planId === PLAN14_ID && outcome?.priceSource !== 'polymarket-official') continue;
          if (applyExitDecisionEvaluation(order, outcome)) {
            updated += 1;
            if (planId === PLAN14_ID) await this.archivePlan14Settlement(order);
          }
        } catch (error) {
          order.settlementError = error.message;
        }
      }
    }

    for (const order of this.state.liveOrders || []) {
      if (order.orderSide === 'SELL') continue;
      if (order.positionStatus !== 'closed') continue;
      if (!needsEvaluation(order)) continue;
      try {
        const outcome = await resolveCached(order);
        if (applyExitDecisionEvaluation(order, outcome)) updated += 1;
      } catch (error) {
        order.settlementError = error.message;
      }
    }

    if (updated) await this.persist();
    return { updated };
  }

  dailyOrderSummary(date = new Date()) {
    const dateKey = formatShanghaiDate(date);
    const orders = [];
    for (const planId of PLAN_IDS) {
      for (const order of this.getBucket(planId).paperOrders || []) {
        if (order.settlementStatus !== 'settled') continue;
        const orderDate = formatShanghaiDate(order.targetTimeIso || order.settledAtIso || order.createdAtIso);
        if (orderDate !== dateKey) continue;
        orders.push({
          id: order.id,
          planId,
          timeframe: order.timeframe || '15m',
          symbol: order.symbol || 'BTC-USD',
          direction: order.direction || null,
          won: Boolean(order.won),
          pnl: Number(order.pnl) || 0,
          usd: Number(order.usd) || 0,
          limitPrice: Number(order.limitPrice) || null,
          entryType: order.entryType || null,
          captureTier: order.captureTier || null,
          priceBand: order.priceBand || null,
          targetTimeIso: order.targetTimeIso || null,
          settledAtIso: order.settledAtIso || null,
          createdAtIso: order.createdAtIso || null,
          market: order.market || order.marketSlug || '',
          exitStatus: order.exitStatus || 'expiry'
        });
      }
    }
    const liveOrders = (this.state.liveOrders || [])
      .filter((order) => {
        const dates = [
          order.createdAtIso,
          order.targetTimeIso,
          order.closedAtIso,
          order.filledAtIso
        ].filter(Boolean).map((value) => formatShanghaiDate(value));
        return dates.includes(dateKey);
      })
      .map((order) => ({
        id: order.id,
        orderSide: order.orderSide || 'BUY',
        status: order.status || null,
        positionStatus: order.positionStatus || null,
        planId: order.planId || null,
        timeframe: order.timeframe || '15m',
        symbol: order.symbol || 'BTC-USD',
        direction: order.direction || null,
        outcome: order.outcome || null,
        usd: Number(order.usd) || 0,
        shares: Number(order.shares) || null,
        limitPrice: Number(order.limitPrice) || null,
        entryPrice: Number(order.entryPrice) || null,
        entryType: order.entryType || null,
        entryTier: order.entryTier || null,
        sizeMultiplier: Number(order.sizeMultiplier) || null,
        takeProfitPrice: Number(order.takeProfitPrice) || null,
        stopLossPrice: Number(order.stopLossPrice) || null,
        exitStatus: order.exitStatus || null,
        exitPrice: Number(order.exitPrice) || null,
        exitReason: order.exitReason || null,
        pnl: Number.isFinite(Number(order.pnl)) ? Number(order.pnl) : null,
        payoutUsd: Number(order.payoutUsd) || null,
        market: order.market || order.marketSlug || '',
        clobOrderId: order.clobOrderId || null,
        error: order.error || null,
        lastExitError: order.lastExitError || null,
        note: order.note || null,
        createdAtIso: order.createdAtIso || null,
        filledAtIso: order.filledAtIso || null,
        closedAtIso: order.closedAtIso || null,
        targetTimeIso: order.targetTimeIso || null
      }));
    orders.sort((a, b) => String(a.targetTimeIso || '').localeCompare(String(b.targetTimeIso || '')));
    liveOrders.sort((a, b) => String(a.createdAtIso || '').localeCompare(String(b.createdAtIso || '')));
    return {
      date: dateKey,
      stats: buildDailyOrderStats(orders),
      orders,
      liveStats: buildDailyLiveOrderStats(liveOrders),
      liveOrders
    };
  }

  currentDailyRealizedPnl(planId = 'plan1') {
    this.refreshDailyBucket(planId);
    return Number(this.getBucket(planId).daily.realizedPnl) || 0;
  }

  refreshDailyBucket(planId = 'plan1', now = new Date()) {
    const bucket = this.getBucket(planId);
    const dateKey = currentDateKey(now);
    if (bucket.daily.dateKey !== dateKey) {
      bucket.daily = { dateKey, realizedPnl: 0 };
    }
  }

  ensurePortfolioReady(planId = 'plan1') {
    if (!this.getBucket(planId).portfolio.portfolioInitialized) {
      throw new Error(`请先在 ${planId.toUpperCase()} 设置初始本金。`);
    }
  }

  ensureDailyLossBudget() {
    // 模拟盘不启用日损上限；仅保留 daily 统计供展示。
  }

  async setAuto(enabled, options = {}) {
    let planId = this.normalizePlanId(options.planId || 'plan1');
    if (planId === 'plan2') planId = 'plan2_5';
    const bucket = this.getBucket(planId);
    if (enabled && planId === 'plan5' && this.config.plan5Enabled === false) {
      throw new Error('Plan5 已停用：历史实盘负期望，默认不再开仓。');
    }
    if (enabled && planId === 'plan3_6' && this.config.plan3_6Enabled === false) {
      throw new Error('Plan3.6 已停用：当前版本负期望，默认不再开仓。');
    }
    if (enabled && planId === PLAN11_ID && this.config.plan11Enabled === false) {
      throw new Error('Plan11 已禁用（POLYMARKET_PLAN11_ENABLED=false）。');
    }
    if (enabled && planId === PLAN14_ID && this.config.plan14Enabled === false) {
      throw new Error('Plan14 已禁用（POLYMARKET_PLAN14_ENABLED=false）。');
    }
    if (enabled && planId === PLAN15_ID && this.config.plan15Enabled === false) {
      throw new Error('Plan15 已禁用（POLYMARKET_PLAN15_ENABLED=false）。');
    }
    if (enabled && planId === PLAN16_ID && this.config.plan16Enabled === false) {
      throw new Error('Plan16 已禁用（POLYMARKET_PLAN16_ENABLED=false）。');
    }
    if (enabled && planId === PLAN17_ID && this.config.plan17Enabled === false) {
      throw new Error('Plan17 已禁用（POLYMARKET_PLAN17_ENABLED=false）。');
    }
    if (enabled && planId === PLAN18_ID && this.config.plan18Enabled === false) {
      throw new Error('Plan18 已禁用（POLYMARKET_PLAN18_ENABLED=false）。');
    }
    if (enabled && planId === PLAN19_ID && this.config.plan19Enabled === false) {
      throw new Error('Plan19 已禁用（POLYMARKET_PLAN19_ENABLED=false）。');
    }
    if (enabled && planId === PLAN13_ID && this.config.plan13Enabled === false) {
      throw new Error('Plan13 已禁用（POLYMARKET_PLAN13_ENABLED=false）。');
    }
    if (enabled) {
      this.ensurePortfolioReady(planId);
    }
    const nextSymbols = options.symbols
      ? normalizeLiveSymbols(options.symbols)
      : normalizeLiveSymbols(bucket.auto?.symbols || DEFAULT_STATE.plans.plan1.auto.symbols);
    bucket.auto = {
      ...bucket.auto,
      enabled: Boolean(enabled),
      strategy: options.strategy || bucket.auto.strategy || planId,
      timeframes: normalizeTimeframes(options.timeframes || bucket.auto.timeframes, planId),
      symbols: nextSymbols
    };
    if (planId === 'plan2_5') {
      const legacy = this.getBucket('plan2');
      if (legacy.auto?.enabled) {
        legacy.auto = {
          ...legacy.auto,
          enabled: false,
          stoppedAtIso: new Date().toISOString(),
          lastAction: 'retired',
          lastReason: '已合并到 Plan2.5'
        };
        await this.persist('plan2');
      }
    }
    await this.persist(planId);
    return { planId, ...bucket.auto };
  }

  async createPlan15PaperOrder(input = {}) {
    const id = PLAN15_ID;
    if (this.config.plan15Enabled === false) throw new Error('Plan15 已禁用。');
    this.ensurePortfolioReady(id);
    const ask = Number(input.ask);
    let usd = round2(Number(input.usd));
    if (!(ask > 0 && ask < 1) || !(usd > 0)) throw new Error('Plan15 报价或金额无效。');
    const bucket = this.getBucket(id);
    const bankroll = Number(bucket.portfolio.startingCash);
    const safePct = (value, fallback) => {
      const pct = Number(value ?? fallback);
      return Number.isFinite(pct) && pct >= 0 && pct <= 1 ? pct : fallback;
    };
    const tradeCap = bankroll * safePct(this.config.plan15MaxTradeBankrollPct, 0.05);
    const exposureCap = bankroll * safePct(this.config.plan15MaxOpenExposureBankrollPct, 0.30);
    const exposure = bucket.paperOrders
      .filter((order) => order.settlementStatus === 'open')
      .reduce((sum, order) => sum + Math.max(0, Number(order.usd) || 0), 0);
    usd = Math.floor(Math.min(usd, tradeCap, exposureCap - exposure, Number(bucket.portfolio.cash)) * 100 + 1e-8) / 100;
    if (!(usd > 0)) throw new Error('Plan15 现金不足或敞口上限已满。');
    const slug = String(input.marketSlug || '');
    if (!slug) throw new Error('Plan15 缺少市场。');
    if (bucket.paperOrders.some((order) => order.marketSlug === slug)) return null;
    const openCount = bucket.paperOrders.filter((order) => order.settlementStatus === 'open').length;
    const maxOpen = Number(this.config.plan15MaxOpen);
    if (maxOpen > 0 && openCount >= maxOpen) throw new Error('Plan15 未结算订单已满。');
    const grossShares = usd / ask;
    const draft = applyPaperEntryTakerFee({
      planId: id,
      symbol: input.categoryLabel || input.categoryId || 'event',
      timeframe: 'event',
      outcome: String(input.outcome || ''),
      direction: 'event',
      limitPrice: ask,
      entryPrice: ask,
      shares: grossShares,
      usd,
      market: input.title || slug,
      marketSlug: slug,
      conditionId: input.conditionId || null,
      tokenId: input.tokenId || null,
      categoryId: input.categoryId || null,
      targetTimeIso: input.endDate || null,
      strategyVersion: PLAN15_VERSION,
      createdAtIso: new Date().toISOString(),
      settlementStatus: 'open',
      status: 'paper-filled',
      mode: 'paper'
    }, this.config);
    if (!(Number(draft.shares) > 0)) throw new Error('Plan15 成交份数为 0。');
    const order = {
      id: `pm-plan15-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      ...draft
    };
    bucket.portfolio.cash = round2(bucket.portfolio.cash - usd);
    bucket.paperOrders.push(order);
    bucket.auto = {
      ...bucket.auto,
      lastAction: 'bought',
      lastReason: `${input.categoryId || 'event'} ${order.outcome} @ ${(ask * 100).toFixed(0)}¢`,
      lastOrderId: order.id,
      lastRunAtIso: order.createdAtIso
    };
    await this.persist(id);
    return order;
  }

  async notePlan15Scan({ reason = '', bought = 0 } = {}) {
    const bucket = this.getBucket(PLAN15_ID);
    bucket.auto = {
      ...bucket.auto,
      lastAction: bought > 0 ? 'bought' : 'skip',
      lastReason: reason,
      lastRunAtIso: new Date().toISOString()
    };
    await this.persist(PLAN15_ID);
  }

  async createPlan16PaperOrder(input = {}) {
    const id = PLAN16_ID;
    if (this.config.plan16Enabled === false) throw new Error('Plan16 已禁用。');
    this.ensurePortfolioReady(id);
    const ask = Number(input.ask);
    const usd = round2(Number(input.usd));
    if (!(ask > 0 && ask < 1) || !(usd > 0)) throw new Error('Plan16 报价或金额无效。');
    const bucket = this.getBucket(id);
    if (bucket.portfolio.cash + 0.005 < usd) throw new Error('Plan16 现金不足。');
    const slug = String(input.marketSlug || '');
    const groupKey = String(input.groupKey || '');
    if (!slug || !groupKey) throw new Error('Plan16 缺少市场。');
    if (bucket.paperOrders.some((order) => order.marketSlug === slug || order.plan16GroupKey === groupKey)) return null;
    const openCount = bucket.paperOrders.filter((order) => order.settlementStatus === 'open').length;
    const maxOpen = Number(this.config.plan16MaxOpen);
    if (maxOpen > 0 && openCount >= maxOpen) throw new Error('Plan16 未结算订单已满。');
    const grossShares = usd / ask;
    const draft = applyPaperEntryTakerFee({
      planId: id,
      symbol: input.city || '天气',
      timeframe: 'event',
      outcome: String(input.outcome || ''),
      direction: 'event',
      limitPrice: ask,
      entryPrice: ask,
      shares: grossShares,
      usd,
      market: input.title || slug,
      marketSlug: slug,
      conditionId: input.conditionId || null,
      tokenId: input.tokenId || null,
      categoryId: 'weather',
      plan16GroupKey: groupKey,
      plan16Forecast: {
        pYes: input.pYes,
        p: input.p,
        edge: input.edge,
        members: input.members,
        icao: input.icao,
        date: input.date,
        kind: input.kind,
        bucket: input.bucket
      },
      targetTimeIso: input.endDate || null,
      strategyVersion: PLAN16_VERSION,
      createdAtIso: new Date().toISOString(),
      settlementStatus: 'open',
      status: 'paper-filled',
      mode: 'paper'
    }, this.config);
    if (!(Number(draft.shares) > 0)) throw new Error('Plan16 成交份数为 0。');
    const order = {
      id: `pm-plan16-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      ...draft
    };
    bucket.portfolio.cash = round2(bucket.portfolio.cash - usd);
    bucket.paperOrders.push(order);
    bucket.auto = {
      ...bucket.auto,
      lastAction: 'bought',
      lastReason: `${input.city || '天气'} ${order.outcome} @ ${(ask * 100).toFixed(0)}¢`,
      lastOrderId: order.id,
      lastRunAtIso: order.createdAtIso
    };
    await this.persist(id);
    return order;
  }

  async notePlan16Scan({ reason = '', bought = 0 } = {}) {
    const bucket = this.getBucket(PLAN16_ID);
    bucket.auto = {
      ...bucket.auto,
      lastAction: bought > 0 ? 'bought' : 'skip',
      lastReason: reason,
      lastRunAtIso: new Date().toISOString()
    };
    await this.persist(PLAN16_ID);
  }

  async createPlan17PaperOrder(input = {}) {
    const id = PLAN17_ID;
    if (this.config.plan17Enabled === false) throw new Error('Plan17 已禁用。');
    this.ensurePortfolioReady(id);
    const ask = Number(input.ask);
    const usd = round2(Number(input.usd));
    if (!(ask > 0 && ask < 1) || !(usd > 0)) throw new Error('Plan17 报价或金额无效。');
    const bucket = this.getBucket(id);
    if (bucket.portfolio.cash + 0.005 < usd) throw new Error('Plan17 现金不足。');
    const slug = String(input.marketSlug || '');
    if (!slug) throw new Error('Plan17 缺少市场。');
    if (bucket.paperOrders.some((order) => order.marketSlug === slug)) return null;
    const openCount = bucket.paperOrders.filter((order) => order.settlementStatus === 'open').length;
    const maxOpen = Number(this.config.plan17MaxOpen);
    if (maxOpen > 0 && openCount >= maxOpen) throw new Error('Plan17 未结算订单已满。');
    const draft = applyPaperEntryTakerFee({
      planId: id,
      symbol: input.symbol || 'BTC',
      timeframe: 'event',
      outcome: String(input.outcome || ''),
      direction: 'event',
      limitPrice: ask,
      entryPrice: ask,
      shares: usd / ask,
      usd,
      market: input.title || slug,
      marketSlug: slug,
      conditionId: input.conditionId || null,
      tokenId: input.tokenId || null,
      categoryId: 'crypto-ladder',
      plan17EventSlug: input.eventSlug || null,
      plan17Model: {
        family: input.family,
        type: input.type,
        strike: input.strike,
        pYes: input.pYes,
        p: input.p,
        edge: input.edge,
        cost: input.cost ?? null,
        kellyFull: input.kellyFull ?? null,
        kellyFraction: input.kellyFraction ?? null,
        spot: input.spot,
        iv: input.iv,
        volScale: input.volScale
      },
      targetTimeIso: input.endDate || null,
      strategyVersion: PLAN17_VERSION,
      createdAtIso: new Date().toISOString(),
      settlementStatus: 'open',
      status: 'paper-filled',
      mode: 'paper'
    }, this.config);
    if (!(Number(draft.shares) > 0)) throw new Error('Plan17 成交份数为 0。');
    const order = {
      id: `pm-plan17-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      ...draft
    };
    bucket.portfolio.cash = round2(bucket.portfolio.cash - usd);
    bucket.paperOrders.push(order);
    bucket.auto = {
      ...bucket.auto,
      lastAction: 'bought',
      lastReason: `${input.symbol || ''} ${order.outcome} ${input.title || ''} @ ${(ask * 100).toFixed(1)}¢`,
      lastOrderId: order.id,
      lastRunAtIso: order.createdAtIso
    };
    await this.persist(id);
    return order;
  }

  async notePlan17Scan({ reason = '', bought = 0 } = {}) {
    const bucket = this.getBucket(PLAN17_ID);
    bucket.auto = {
      ...bucket.auto,
      lastAction: bought > 0 ? 'bought' : 'skip',
      lastReason: reason,
      lastRunAtIso: new Date().toISOString()
    };
    await this.persist(PLAN17_ID);
  }

  /**
   * Plan18（梅花）/ Plan19（小六壬）共用。扫描一轮会下多笔，调用方传 persist:false 后统一落盘一次，
   * 避免四币三周期下每笔都重写一遍状态文件。
   */
  async createPlan18PaperOrder(input = {}, { persist = true } = {}) {
    const id = DIVINATION_PLAN_IDS.includes(input.planId) ? input.planId : PLAN18_ID;
    const plan = DIVINATION_PLANS[id];
    const label = id === PLAN18_ID ? 'Plan18' : 'Plan19';
    if (this.config[`${id}Enabled`] === false) throw new Error(`${label} 已禁用。`);
    this.ensurePortfolioReady(id);
    const ask = Number(input.ask);
    const usd = round2(Number(input.usd));
    if (!(ask > 0 && ask < 1) || !(usd > 0)) throw new Error(`${label} 报价或金额无效。`);
    const bucket = this.getBucket(id);
    if (bucket.portfolio.cash + 0.005 < usd) throw new Error(`${label} 现金不足。`);
    const slug = String(input.marketSlug || '');
    if (!slug) throw new Error(`${label} 缺少市场。`);
    if (bucket.paperOrders.some((order) => order.marketSlug === slug)) return null;
    const divination = input.divination || {};
    const draft = applyPaperEntryTakerFee({
      planId: id,
      symbol: input.symbol || 'BTC',
      timeframe: ['5m', '15m', '1h'].includes(input.timeframe) ? input.timeframe : '1h',
      outcome: String(input.outcome || ''),
      direction: String(input.outcome || '').toLowerCase() === 'up' ? 'up' : 'down',
      limitPrice: ask,
      entryPrice: ask,
      shares: usd / ask,
      usd,
      market: input.title || slug,
      marketSlug: slug,
      conditionId: input.conditionId || null,
      tokenId: input.tokenId || null,
      categoryId: 'divination-control',
      plan18Divination: {
        method: plan.method,
        text: divination.text,
        meihua: divination.meihua,
        liuren: divination.liuren,
        agree: divination.agree,
        castAtIso: input.startIso || null
      },
      slotIso: input.startIso || null,
      targetTimeIso: input.endDate || null,
      strategyVersion: plan.version,
      createdAtIso: new Date().toISOString(),
      settlementStatus: 'open',
      status: 'paper-filled',
      mode: 'paper'
    }, this.config);
    if (!(Number(draft.shares) > 0)) throw new Error(`${label} 成交份数为 0。`);
    const order = {
      id: `pm-${id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      ...draft
    };
    bucket.portfolio.cash = round2(bucket.portfolio.cash - usd);
    bucket.paperOrders.push(order);
    bucket.auto = {
      ...bucket.auto,
      lastAction: 'bought',
      lastReason: `${input.symbol || ''} ${order.timeframe} ${order.outcome} @ ${(ask * 100).toFixed(1)}¢ · ${divination.text || ''}`,
      lastOrderId: order.id,
      lastRunAtIso: order.createdAtIso
    };
    if (persist) await this.persist(id);
    return order;
  }

  async notePlan18Scan({ planId = PLAN18_ID, reason = '', bought = 0 } = {}) {
    const id = DIVINATION_PLAN_IDS.includes(planId) ? planId : PLAN18_ID;
    const bucket = this.getBucket(id);
    bucket.auto = {
      ...bucket.auto,
      lastAction: bought > 0 ? 'bought' : 'skip',
      lastReason: reason,
      lastRunAtIso: new Date().toISOString()
    };
    await this.persist(id);
  }

  /**
   * 对照组现金见底时追加本金：cash 与 startingCash 同步上调，不清空订单、不改收益率口径。
   * 只用于算卦对照组；它们按设计每天稳定亏约 3%，不补钱几周内就会停摆。
   */
  async topUpDivinationCash(planId, usd) {
    const id = DIVINATION_PLAN_IDS.includes(planId) ? planId : null;
    const amount = round2(Number(usd));
    if (!id || !(amount > 0)) return null;
    const bucket = this.getBucket(id);
    bucket.portfolio.cash = round2((Number(bucket.portfolio.cash) || 0) + amount);
    bucket.portfolio.startingCash = round2((Number(bucket.portfolio.startingCash) || 0) + amount);
    bucket.portfolio.topUps = [...(bucket.portfolio.topUps || []), { atIso: new Date().toISOString(), usd: amount }];
    await this.persist(id);
    return { planId: id, usd: amount, cash: bucket.portfolio.cash, startingCash: bucket.portfolio.startingCash };
  }

  /**
   * 算卦对照组一天约 1600 笔，状态文件不能无限长。超过保留期的已结算订单追加到
   * data/polymarket/<plan>-settled-archive.jsonl 后从状态里移除；30 天分析窗口仍在保留期内。
   */
  async archiveDivinationSettledOrders(planId, { retentionDays = 35, nowMs = Date.now() } = {}) {
    const id = DIVINATION_PLAN_IDS.includes(planId) ? planId : null;
    if (!id || !this.stateDir) return { archived: 0 };
    const bucket = this.getBucket(id);
    const cutoffMs = nowMs - Math.max(1, Number(retentionDays) || 35) * 86_400_000;
    const stale = [];
    const keep = [];
    for (const order of bucket.paperOrders || []) {
      const settledMs = Date.parse(order.settledAtIso || '');
      if (order.settlementStatus === 'settled' && Number.isFinite(settledMs) && settledMs < cutoffMs) stale.push(order);
      else keep.push(order);
    }
    if (!stale.length) return { archived: 0 };
    const path = join(this.stateDir, `${id}-settled-archive.jsonl`);
    await mkdir(this.stateDir, { recursive: true });
    await appendFile(path, stale.map((order) => JSON.stringify(order)).join('\n') + '\n', 'utf8');
    bucket.paperOrders = keep;
    await this.persist(id);
    return { archived: stale.length };
  }

  buildOrderDraft({
    symbol = 'BTC-USD',
    direction,
    usd,
    sentiment,
    recommendation,
    plan = null,
    planId = 'plan1',
    ignoreCashLimit = false
  }) {
    if (!sentiment?.available) throw new Error(`Polymarket market unavailable: ${sentiment?.reason || 'unknown'}`);
    if (!['up', 'down'].includes(direction)) throw new Error('direction must be up or down');
    const normalizedPlanId = this.normalizePlanId(planId);
    const bucket = this.getBucket(normalizedPlanId);
    const baseRequestedUsd = Number(usd || this.config.defaultOrderUsd);
    const paperStreak = this.paperStreakRiskSnapshot(normalizedPlanId);
    const paperEntryScale = resolveEntrySizeScale({
      planId: normalizedPlanId,
      config: this.config,
      winStreak: paperStreak.winStreak,
      lossStreak: paperStreak.lossStreak,
      appliesGlobalLossRecovery: false
    });
    const streakScale = paperEntryScale.streak.enabled ? (Number(paperEntryScale.sizeScale) || 1) : 1;
    const requestedUsd = Number.isFinite(baseRequestedUsd) ? baseRequestedUsd * streakScale : baseRequestedUsd;
    const maxUsd = this.config.paperLiveParityEnabled !== false
      ? (Number(this.config.liveMaxOrderUsd) || Number(this.config.maxOrderUsd) || 500)
      : (Number(this.config.maxOrderUsd) || 500);
    const availableCash = ignoreCashLimit || !bucket.portfolio.portfolioInitialized ? maxUsd : Number(bucket.portfolio.cash) || 0;
    const tokenId = direction === 'up' ? sentiment.upTokenId : sentiment.downTokenId;
    const marketPrice = Number(direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
    const actionLimit = Number(plan?.action?.limitPrice);
    // Plan14 prices its entry on a CLOB book fetched moments ago; the cached sentiment ask is older.
    const price = (normalizedPlanId === 'plan3_6' || normalizedPlanId === PLAN14_ID)
      && Number.isFinite(actionLimit)
      && actionLimit > 0
      && actionLimit < 1
      ? actionLimit
      : resolvePaperExecutableEntryPrice({ direction, sentiment, quotePrice: marketPrice, config: this.config });
    if (!tokenId || !Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error('Polymarket token price is not tradable right now.');
    }
    const paperMinUsd = this.config.paperLiveParityEnabled !== false
      ? resolveUnifiedEntryFloorUsd({
        config: this.config,
        planId: normalizedPlanId,
        timeframe: sentiment.timeframe || plan?.timeframe || '15m',
        price
      })
      : Math.max(1, Number(this.config.minOrderUsd) || 1);
    const belowMinMode = paperEntryScale.streak.belowMinMode || 'clamp';
    if (
      paperEntryScale.streak.enabled
      && belowMinMode === 'skip'
      && Number.isFinite(requestedUsd)
      && requestedUsd > 0
      && requestedUsd + 0.005 < paperMinUsd
      && availableCash + 0.005 >= paperMinUsd
    ) {
      throw new Error(
        `纸面连${paperStreak.lossStreak > 0 ? '亏' : '赢'} streak 缩放后 $${Math.max(0, requestedUsd).toFixed(2)} 低于最小单 $${paperMinUsd.toFixed(2)}，跳过噪声单。`
      );
    }
    const cappedUsd = Math.max(paperMinUsd, Math.min(maxUsd, requestedUsd, availableCash));
    if (!ignoreCashLimit && bucket.portfolio.portfolioInitialized && cappedUsd > availableCash) {
      throw new Error(`可用现金不足：$${availableCash.toFixed(2)}`);
    }
    const planKey = plan?.action?.executionKey || plan?.key || plan?.planKey || null;
    return {
      planId: normalizedPlanId,
      algorithm: normalizedPlanId,
      symbol,
      timeframe: sentiment.timeframe || plan?.timeframe || '15m',
      direction,
      outcome: direction === 'up' ? 'UP' : 'DOWN',
      market: sentiment.market,
      marketSlug: sentiment.marketSlug,
      conditionId: sentiment.conditionId,
      tokenId,
      upTokenId: sentiment.upTokenId || null,
      downTokenId: sentiment.downTokenId || null,
      oppositeTokenId: direction === 'up' ? (sentiment.downTokenId || null) : (sentiment.upTokenId || null),
      quotedUpPrice: Number(sentiment.upPrice) || null,
      quotedDownPrice: Number(sentiment.downPrice) || null,
      orderType: 'BUY',
      requestedUsd: round2(baseRequestedUsd),
      streakSizingScale: round4(streakScale),
      streakSizingMode: paperEntryScale.streak.mode,
      winStreak: paperStreak.winStreak,
      lossStreak: paperStreak.lossStreak,
      entryType: plan?.action?.entryType || plan?.entryType || null,
      lockStrength: plan?.action?.lockStrength || plan?.lockStrength || plan?.intervalPmLock?.strength || null,
      lockPmGap: Number(plan?.action?.lockPmGap ?? plan?.intervalPmLock?.pmGap) || null,
      lockedAtIso: plan?.action?.lockedAtIso || plan?.intervalPmLock?.lockedAtIso || null,
      signalQuality: plan?.action?.signalQuality || null,
      expectedValueGate: plan?.action?.expectedValueGate || null,
      directionRecheck: plan?.action?.directionRecheck || null,
      signalDirection: plan?.action?.signalDirection || null,
      technicalDirection: plan?.action?.technicalDirection || null,
      spotDirection: plan?.action?.spotDirection || null,
      marketAlignment: plan?.action?.marketAlignment || null,
      consensusGate: plan?.action?.consensusGate || null,
      entryTiming: plan?.action?.entryTiming || null,
      entryPriceGate: plan?.action?.entryPriceGate || null,
      historyWinRateGate: plan?.action?.historyWinRateGate || null,
      winrateGuidanceGate: plan?.action?.winrateGuidanceGate || null,
      lossReasonGate: plan?.action?.lossReasonGate || null,
      basketAllocation: plan?.action?.basketAllocation || null,
      lockUpProbability: Number(plan?.action?.lockUpProbability ?? plan?.intervalPmLock?.upProbability) || null,
      lockDownProbability: Number(plan?.action?.lockDownProbability ?? plan?.intervalPmLock?.downProbability) || null,
      strategyVersion: plan?.action?.strategyVersion || resolvePlan2StrategyVersion(normalizedPlanId),
      experimentLane: plan?.action?.experimentLane || plan?.experimentLane || null,
      shadowOnly: plan?.action?.shadowOnly === true,
      rawBestAsk: Number(plan?.observation?.rawBestAsk) || null,
      paperSlippageTicks: Number(plan?.observation?.paperSlippageTicks) || 0,
      modelDirection: plan?.action?.modelDirection || plan?.observation?.modelDirection || null,
      modelConfidence: Number(plan?.action?.modelConfidence ?? plan?.observation?.modelConfidence) || null,
      modelAligned: plan?.action?.modelAligned ?? plan?.observation?.modelAligned ?? null,
      cheapDirection: plan?.action?.cheapDirection || plan?.observation?.cheapDirection || null,
      cheapPrice: Number(plan?.action?.cheapPrice ?? plan?.observation?.cheapPrice) || null,
      marketOverround: Number(plan?.action?.marketOverround ?? plan?.observation?.marketOverround) || null,
      trajectoryPattern: plan?.action?.trajectoryPattern || plan?.trajectoryPath?.pattern || null,
      trajectoryExperimentReason: plan?.action?.trajectoryExperiment?.reason
        || plan?.trajectoryExperiment?.reason
        || null,
      trajectoryAligned: plan?.action?.trajectoryExperiment?.aligned
        ?? plan?.trajectoryExperiment?.aligned
        ?? null,
      trajectoryMetrics: plan?.action?.trajectoryMetrics || plan?.trajectoryPath || null,
      // Top-level planKey keeps paper/live window dedupe stable across drafts.
      planKey,
      limitPrice: round4(price),
      paperQuotePrice: Number.isFinite(marketPrice) ? round4(marketPrice) : null,
      usd: round2(cappedUsd),
      shares: round4(cappedUsd / price),
      aggregate: plan?.action?.aggregate || null,
      takeProfitPrice: Number(plan?.exitRule?.takeProfitPrice ?? plan?.action?.takeProfitPrice ?? plan?.takeProfitPrice) || null,
      stopLossPrice: Number(plan?.exitRule?.stopLossPrice ?? plan?.action?.stopLossPrice ?? plan?.stopLossPrice) || null,
      peakPrice: round4(price),
      trailStopPrice: null,
      targetTimeIso: plan?.targetTimeIso || plan?.action?.targetTimeIso || sentiment.targetTimeIso || null,
      slotIso: plan?.slotIso || plan?.action?.slotIso || sentiment.schedule?.currentSlotIso || null,
      entryElapsedPct: Number(plan?.action?.entryElapsedPct ?? plan?.elapsedPct) || null,
      startPrice: Number(plan?.action?.startPrice ?? plan?.startPrice) || null,
      qualityScore: Number(sentiment.qualityScore) || null,
      qualityLabel: sentiment.qualityLabel || null,
      recommendation: recommendation || null,
      plan,
      crossSymbolAligned: plan?.action?.crossSymbolAligned ?? plan?.crossSymbolAligned ?? null,
      crossSymbolLeader: plan?.action?.crossSymbolLeader || plan?.crossSymbolLeader || null,
      leaderLimitPrice: plan?.action?.leaderLimitPrice ?? plan?.leaderLimitPrice ?? null,
      createdAtIso: new Date().toISOString()
    };
  }

  async createPaperOrder(input, planId = 'plan1') {
    const id = this.normalizePlanId(planId || input.planId || input.plan?.planId || 'plan1');
    this.ensurePortfolioReady(id);
    this.ensureDailyLossBudget(id);
    const bucket = this.getBucket(id);
    const draft = this.buildOrderDraft({ ...input, planId: id });
    const timeframe = draft.timeframe || '15m';
    if (id === PLAN14_ID && timeframe !== '5m') {
      throw new Error('Plan14：15m 暂停新开仓，仅验证 5m。');
    }
    const slotIso = draft.slotIso || input.plan?.slotIso;
    if (id === PLAN14_ID) {
      const gate = input.plan?.action?.expectedValueGate;
      if (gate?.policyVersion === PLAN14_VERSION) {
        const sampledTimes = [gate.inputs?.quoteTimeMs, gate.bookTimeMs?.up, gate.bookTimeMs?.down];
        const nowMs = Date.now();
        const maxAgeMs = buildPlan14RulesSnapshot(this.config).maxSpotAgeSeconds * 1000;
        if (sampledTimes.some(t => !Number.isFinite(t) || nowMs - t < -2000 || nowMs - t > maxAgeMs)) {
          throw new Error('Plan14：候选等待期间报价已过期，本轮不按旧价模拟成交。');
        }
      }
      const exposure = evaluatePlan14Exposure({ orders: bucket.paperOrders, slotIso, timeframe,
        direction: draft.direction, config: this.config });
      if (!exposure.allowed) throw new Error(exposure.reason);
      draft.strategyVersion = PLAN14_VERSION;
    }
    const allowFlipReentry = id !== PLAN14_ID && Boolean(input.allowFlipReentry);
    if (!allowFlipReentry) {
      const stats = this.computeStats(id);
      const globalExposure = this.checkGlobalExposure({
        timeframe,
        slotIso,
        direction: draft.direction,
        newOrderUsd: draft.usd,
        equity: stats.equity,
        source: 'paper'
      });
      if (!globalExposure.allowed) {
        throw new Error(globalExposure.reason);
      }
    }
    if (slotIso && !allowFlipReentry) {
      const entry = this.isPlan2FamilyPlan(id) && draft.plan?.entryType === 'main'
        ? this.canOpenPlan2PaperMainUpgradeForWindow({
          timeframe,
          slotIso,
          direction: draft.direction,
          symbol: draft.symbol
        })
        : this.canOpenNewPaperEntryForWindow({
          planId: id,
          timeframe,
          slotIso,
          symbol: draft.symbol,
          entryType: draft.plan?.entryType || draft.plan?.action?.entryType,
          direction: draft.direction
        });
      if (!entry.allowed) {
        throw new Error(entry.reason || `${timeframe} 本窗口无法再次买入。`);
      }
    }
    if (draft.usd > bucket.portfolio.cash) {
      throw new Error(`可用现金不足：$${bucket.portfolio.cash.toFixed(2)}`);
    }

    // Plan2 / Plan5 纸面成交 realism：要求 ask<=limit，并按 tick 滑点抬高入场价（贴近 FAK 摩擦）。
    let fillDraft = draft;
    if (this.isPlan2FamilyPlan(id)) {
      const cfg = this.resolvePlan2Config(id);
      const requireFillable = cfg.plan2PaperRequireAskFillable !== false;
      const actionFillable = input.plan?.action?.paperFillable;
      const askPrice = Number(
        draft.direction === 'up' ? input.sentiment?.upPrice : input.sentiment?.downPrice
      );
      const limitPrice = Number(draft.limitPrice);
      const canFill = actionFillable === true
        || (!requireFillable)
        || (actionFillable !== false
          && Number.isFinite(askPrice)
          && Number.isFinite(limitPrice)
          && askPrice <= limitPrice + 1e-9);
      if (!canFill) {
        // 无效成交：直接 skip，绝不写入 usd=0 幽灵单（会占窗、污染统计、挡同窗重试）。
        throw new Error(
          `${plan2FamilyLabel(id)} 纸面：ask 高于限价，模拟未成交（跳过，不落库）。`
        );
      }
      const slipTicks = Math.max(0, Number(cfg.plan2PaperFillSlippageTicks) || 0);
      const tick = Number(cfg.plan2PaperFillTickSize) || 0.01;
      if (slipTicks > 0) {
        const entryPrice = round4(Math.min(0.99, limitPrice + tick * slipTicks));
        fillDraft = {
          ...draft,
          entryPrice,
          limitPrice: entryPrice,
          shares: round4(draft.usd / entryPrice),
          fillSlippageTicks: slipTicks
        };
      }
      if (id === PLAN13_ID) {
        const hardMax = Number(cfg.plan13EntryHardMaxPrice ?? this.config.plan13EntryHardMaxPrice ?? 0.88);
        const executablePrice = Number(fillDraft.entryPrice ?? fillDraft.limitPrice);
        if (!Number.isFinite(executablePrice) || executablePrice > hardMax + 1e-9) {
          throw new Error(`Plan13 v2 滑点后成交价超过 ${(hardMax * 100).toFixed(0)}¢ 硬上限，跳过。`);
        }
      }
    } else if (id === 'plan5') {
      const requireFillable = this.config.plan5PaperRequireAskFillable !== false;
      const actionFillable = input.plan?.action?.paperFillable;
      const bookAsk = Number(
        draft.direction === 'up'
          ? input.sentiment?.upBestAsk
          : input.sentiment?.downBestAsk
      );
      const quoteAsk = Number(
        draft.direction === 'up' ? input.sentiment?.upPrice : input.sentiment?.downPrice
      );
      const askPrice = Number.isFinite(bookAsk) && bookAsk > 0 && bookAsk < 1
        ? bookAsk
        : quoteAsk;
      const actionLimit = Number(input.plan?.action?.limitPrice);
      const limitPrice = Number.isFinite(actionLimit) && actionLimit > 0 && actionLimit < 1
        ? actionLimit
        : Number(draft.limitPrice);
      const canFill = actionFillable === true
        || (!requireFillable)
        || (actionFillable !== false
          && Number.isFinite(askPrice)
          && Number.isFinite(limitPrice)
          && askPrice <= limitPrice + 1e-9);
      if (!canFill) {
        // 无效成交：直接 skip，绝不写入 usd=0 幽灵单（会占窗、污染统计、挡同窗重试）。
        throw new Error(
          `Plan5 纸面：ask ${Number.isFinite(askPrice) ? (askPrice * 100).toFixed(1) : '--'}¢ 高于限价 ${Number.isFinite(limitPrice) ? (limitPrice * 100).toFixed(1) : '--'}¢，模拟未成交（跳过，不落库）。`
        );
      }
      const slipTicks = Math.max(0, Number(this.config.plan5PaperFillSlippageTicks) || 0);
      const tick = Number(this.config.plan5PaperFillTickSize) || 0.01;
      const baseFill = Number.isFinite(askPrice)
        ? Math.max(askPrice, Number.isFinite(limitPrice) ? limitPrice : askPrice)
        : limitPrice;
      if (slipTicks > 0 || Number.isFinite(askPrice)) {
        const entryPrice = round4(Math.min(0.99, baseFill + tick * slipTicks));
        fillDraft = {
          ...draft,
          entryPrice,
          limitPrice: entryPrice,
          intendedLimitPrice: Number.isFinite(limitPrice) ? round4(limitPrice) : draft.limitPrice,
          rawBestAsk: Number.isFinite(askPrice) ? round4(askPrice) : null,
          shares: round4(draft.usd / entryPrice),
          fillSlippageTicks: slipTicks,
          paperSlippageTicks: slipTicks
        };
      }
    }

    if (this.config.paperLiveParityEnabled !== false) {
      const finalPrice = Number(fillDraft.entryPrice ?? fillDraft.limitPrice);
      const executableFloorUsd = resolveUnifiedEntryFloorUsd({
        config: this.config,
        planId: id,
        timeframe,
        price: finalPrice
      });
      if (Number(fillDraft.usd) + 0.005 < executableFloorUsd) {
        if (bucket.portfolio.cash + 0.005 < executableFloorUsd) {
          throw new Error(`可用现金不足以满足 CLOB 最低份数：需要 $${executableFloorUsd.toFixed(2)}。`);
        }
        fillDraft = {
          ...fillDraft,
          usd: round2(executableFloorUsd),
          shares: round4(executableFloorUsd / finalPrice),
          parityFloorAdjusted: true
        };
      }
    }

    if (!(Number(fillDraft.usd) > 0) || !(Number(fillDraft.shares) > 0)) {
      throw new Error(`${id.toUpperCase()} 纸面金额/份数为 0，跳过无效单（不落库）。`);
    }
    if (id === PLAN14_ID) {
      const budget = bucket.portfolio.cash * buildPlan14RulesSnapshot(this.config).maxOrderPct;
      if (Number(fillDraft.usd) > budget + 0.005) {
        throw new Error('Plan14：成交金额超过单笔现金比例上限，最低份数不能覆盖风险预算。');
      }
    }
    fillDraft = applyPaperEntryTakerFee(fillDraft, this.config);

    const order = {
      id: `pm-${id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      status: 'paper-filled',
      settlementStatus: 'open',
      exitStatus: null,
      exitPrice: null,
      exitReason: null,
      won: null,
      pnl: null,
      payoutUsd: null,
      actualDirection: null,
      actualClose: null,
      settledAtIso: null,
      ...fillDraft
    };
    bucket.portfolio.cash = round2(bucket.portfolio.cash - order.usd);
    bucket.paperOrders.unshift(slimStoredPaperOrder(order));
    bucket.paperOrders = bucket.paperOrders.slice(0, PAPER_ORDERS_HARD_CAP);
    await this.persist(id);
    return order;
  }

  getWindowOrders({ planId = 'plan1', timeframe, slotIso, symbol = null }) {
    if (!slotIso || !timeframe) return [];
    return this.getBucket(planId).paperOrders.filter((order) => {
      if ((order.timeframe || '15m') !== timeframe) return false;
      if (symbol && (order.symbol || 'BTC-USD') !== symbol) return false;
      return (order.slotIso || order.plan?.slotIso) === slotIso;
    });
  }

  getOpenPaperOrderForWindow({ planId = 'plan1', timeframe, slotIso, symbol = null }) {
    return this.getWindowOrders({ planId, timeframe, slotIso, symbol })
      .find((order) => order.settlementStatus === 'open') || null;
  }

  getPendingDelayedEntry(planId = 'plan2', delayedEntryKey) {
    if (!delayedEntryKey) return null;
    this.prunePlan2DelayedEntries(planId);
    return this.getBucket(planId).pendingDelayedEntries?.[delayedEntryKey] || null;
  }

  pruneLivePlan2DelayedEntries(nowMs = Date.now()) {
    const entries = this.state.liveAuto?.pendingDelayedEntries;
    if (!entries) return 0;
    return this.pruneDelayedEntriesObject(entries, nowMs);
  }

  prunePlan2DelayedEntries(planId = 'plan2', nowMs = Date.now()) {
    const bucket = this.getBucket(planId);
    if (!bucket.pendingDelayedEntries) return 0;
    return this.pruneDelayedEntriesObject(bucket.pendingDelayedEntries, nowMs);
  }

  pruneDelayedEntriesObject(entries, nowMs = Date.now()) {
    let removed = 0;
    for (const [key, entry] of Object.entries(entries || {})) {
      if (this.isPlan2DelayedEntryExpired(entry, nowMs)) {
        delete entries[key];
        removed += 1;
      }
    }
    return removed;
  }

  isPlan2DelayedEntryExpired(entry, nowMs = Date.now()) {
    if (!entry) return true;
    const slotMs = Date.parse(entry.slotIso || 0);
    const timeframe = entry.timeframe || '15m';
    const slotMinutes = timeframeToSlotMinutes(timeframe);
    const slotEndMs = Number.isFinite(slotMs) ? slotMs + slotMinutes * 60 * 1000 : 0;
    if (slotEndMs && nowMs > slotEndMs) return true;
    const scheduledMs = Date.parse(entry.scheduledAtIso || 0);
    const ttlMs = timeframe === '5m'
      ? Number(this.config.plan2DelayedEntryTtlMs5m) || 30000
      : Number(this.config.plan2DelayedEntryTtlMs15m) || 120000;
    if (Number.isFinite(scheduledMs) && scheduledMs > 0 && nowMs - scheduledMs > ttlMs) return true;
    if (Number(entry.expiresAtMs) && nowMs > Number(entry.expiresAtMs)) return true;
    return false;
  }

  canOpenNewPaperEntryForWindow({ planId = 'plan1', timeframe, slotIso, symbol = null, entryType = null, direction = null }) {
    const normalizedPlanId = this.normalizePlanId(planId);
    const orders = this.getWindowOrders({
      planId: normalizedPlanId,
      timeframe,
      slotIso,
      // Plan13 ranks BTC/ETH/SOL/XRP together and may open only one of them.
      symbol: normalizedPlanId === PLAN13_ID ? null : symbol
    });
    const normalizedEntry = String(entryType || '').toLowerCase();
    // Plan5 开盘后加仓：允许同窗已有 pre_open 持仓时再下一笔 pm_lock_add
    if (planId === 'plan5' && normalizedEntry === 'pm_lock_add') {
      const open = orders.filter((order) => order.settlementStatus === 'open');
      const preOpen = open.find((order) => String(order.entryType || order.plan?.entryType || '').toLowerCase() === 'pre_open');
      if (!preOpen) {
        return { allowed: false, openOrder: null, reason: `${timeframe} 本窗口没有开盘前小仓，不能加仓。` };
      }
      if (direction && preOpen.direction && preOpen.direction !== direction) {
        return { allowed: false, openOrder: preOpen, reason: `${timeframe} 开盘前小仓方向冲突，不加仓。` };
      }
      const existingAdd = open.find((order) => String(order.entryType || order.plan?.entryType || '').toLowerCase() === 'pm_lock_add');
      if (existingAdd) {
        return { allowed: false, openOrder: existingAdd, reason: `${timeframe} 本窗口已加仓。` };
      }
      return { allowed: true, openOrder: preOpen, reason: null };
    }
    // Plan5 开盘前小仓：同窗尚无持仓即可
    if (planId === 'plan5' && normalizedEntry === 'pre_open') {
      const openOrder = orders.find((order) => order.settlementStatus === 'open');
      if (openOrder) {
        return { allowed: false, openOrder, reason: `${timeframe} 本窗口已有持仓。` };
      }
      return { allowed: true, openOrder: null, reason: null };
    }
    const isPlan1Hedge = planId === 'plan1' && normalizedEntry === 'opposite_hedge';
    if (isPlan1Hedge) {
      const existingHedge = orders.find((order) => (
        order.settlementStatus === 'open'
        && String(order.entryType || order.plan?.entryType || '').toLowerCase() === 'opposite_hedge'
      ));
      if (existingHedge) {
        return { allowed: false, openOrder: existingHedge, reason: `${timeframe} 本窗口已有反向保险仓。` };
      }
      const mainOrder = orders.find((order) => (
        order.settlementStatus === 'open'
        && String(order.entryType || order.plan?.entryType || '').toLowerCase() !== 'opposite_hedge'
        && (!direction || order.direction !== direction)
      ));
      if (!mainOrder) {
        return { allowed: false, openOrder: null, reason: `${timeframe} 本窗口没有可对冲的主仓。` };
      }
      return { allowed: true, openOrder: null, reason: null };
    }
    const openOrder = orders.find((order) => order.settlementStatus === 'open');
    if (openOrder) {
      return { allowed: false, openOrder, reason: `${timeframe} 本窗口已有持仓。` };
    }
    // 历史 usd=0 / 未成交幽灵单不占窗，允许同窗在 ask 可成交时重试。
    const blockingSettled = orders.find((order) => (
      order.settlementStatus === 'settled'
      && order.exitStatus !== 'direction-flip'
      && !isPaperZeroGhostOrder(order)
    ));
    if (blockingSettled) {
      return { allowed: false, openOrder: null, reason: `${timeframe} 本窗口已交易过。` };
    }
    return { allowed: true, openOrder: null, reason: null };
  }

  canOpenPlan2PaperMainUpgradeForWindow({ timeframe, slotIso, direction, symbol = null, planId = 'plan2' }) {
    const orders = this.getWindowOrders({ planId: this.normalizePlanId(planId), timeframe, slotIso, symbol });
    const open = orders.filter((order) => order.settlementStatus === 'open');
    const opposite = open.find((order) => order.direction && order.direction !== direction);
    if (opposite) {
      return { allowed: false, openOrder: opposite, reason: `${timeframe} 本窗口已有反向模拟仓位。` };
    }
    const existingMain = open.find((order) => order.direction === direction && order.plan?.entryType === 'main');
    if (existingMain) {
      return { allowed: false, openOrder: existingMain, reason: `${timeframe} 本窗口模拟主仓已存在。` };
    }
    const probe = open.find((order) => order.direction === direction && order.plan?.entryType === 'probe');
    if (!probe) {
      return { allowed: false, openOrder: null, reason: `${timeframe} 本窗口没有同向模拟探针仓，不能追加主仓。` };
    }
    return { allowed: true, openOrder: null, probe };
  }

  hasPaperOrderForWindow({ planId = 'plan1', timeframe, slotIso }) {
    if (!slotIso || !timeframe) return false;
    return this.getWindowOrders({ planId, timeframe, slotIso }).length > 0;
  }

  async schedulePlan2DelayedEntry({ plan, planId = 'plan2' }) {
    const id = this.normalizePlanId(planId);
    const action = plan?.action;
    if (!action?.scheduleDelayedEntry || !action.delayedEntryKey) {
      throw new Error('Plan2 delayed entry payload is invalid.');
    }
    const bucket = this.getBucket(id);
    if (!bucket.pendingDelayedEntries) bucket.pendingDelayedEntries = {};
    bucket.pendingDelayedEntries[action.delayedEntryKey] = {
      key: action.delayedEntryKey,
      planKey: plan.key,
      slotIso: plan.slotIso,
      timeframe: plan.timeframe,
      symbol: plan.symbol || 'BTC-USD',
      direction: action.direction,
      executeAfterMs: Date.parse(action.executeAfterIso),
      scheduledAtIso: new Date().toISOString(),
      initialLimitPrice: action.limitPrice,
      delayMs: action.delayMs
    };
    await this.persist(id);
    return bucket.pendingDelayedEntries[action.delayedEntryKey];
  }

  async schedulePlan2ProbeUpgrade({ plan, order, planId = 'plan2' }) {
    const id = this.normalizePlanId(planId);
    const action = plan?.action;
    if (!action?.scheduleProbeUpgrade || !plan?.slotIso || !plan?.timeframe) return null;
    const bucket = this.getBucket(id);
    if (!bucket.pendingDelayedEntries) bucket.pendingDelayedEntries = {};
    const key = this.buildPlan2DelayedEntryKey(plan.slotIso, plan.timeframe, plan.symbol, id);
    const nowMs = Date.now();
    bucket.pendingDelayedEntries[key] = {
      key,
      type: 'probe_upgrade',
      planKey: plan.key,
      slotIso: plan.slotIso,
      timeframe: plan.timeframe,
      symbol: plan.symbol || 'BTC-USD',
      direction: action.direction,
      executeAfterMs: nowMs + (Number(action.probeUpgradeAfterMs) || 10000),
      expiresAtMs: nowMs + (Number(action.probeUpgradeExpiresMs) || 35000),
      scheduledAtIso: new Date(nowMs).toISOString(),
      initialLimitPrice: action.limitPrice,
      probePrice: Number(order?.limitPrice ?? action.limitPrice),
      confidenceAtProbe: Number(action.confidence) || null,
      delayMs: Number(action.probeUpgradeAfterMs) || 10000
    };
    await this.persist(id);
    return bucket.pendingDelayedEntries[key];
  }

  async clearPlan2DelayedEntry(delayedEntryKey, planId = 'plan2') {
    const bucket = this.getBucket(planId);
    if (!delayedEntryKey || !bucket.pendingDelayedEntries?.[delayedEntryKey]) return;
    delete bucket.pendingDelayedEntries[delayedEntryKey];
    await this.persist(planId);
  }

  buildPlan2DelayedEntryKey(slotIso, timeframe = '15m', symbol = 'BTC-USD', planId = null) {
    return buildPlan2DelayedEntryKey(slotIso, timeframe, symbol, planId);
  }

  recordPaperExitProceeds(order, exitPrice) {
    const shares = Number(order.shares) || 0;
    const price = Number(exitPrice) || 0;
    const feeUsd = polymarketCryptoTakerFee(shares, price, resolvePaperTakerFeeRate(this.config));
    if (feeUsd > 0) order.paperExitFeeUsd = round4(feeUsd);
    return round2(shares * price - feeUsd);
  }

  async closePaperOrderEarly(order, resolveCurrentPrice, {
    exitStatus = 'direction-flip',
    exitReason = null,
    planId = null
  } = {}) {
    if (!order || order.settlementStatus !== 'open') {
      throw new Error('只能平仓未结算订单。');
    }
    if (typeof resolveCurrentPrice !== 'function') {
      throw new Error('resolveCurrentPrice callback is required.');
    }
    const id = this.normalizePlanId(planId || order.planId || 'plan1');
    const bucket = this.getBucket(id);
    let currentPrice = Number(await resolveCurrentPrice(order));
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || currentPrice >= 1) {
      currentPrice = Number(order.limitPrice) || 0;
    }
    const proceeds = this.recordPaperExitProceeds(order, currentPrice);
    const pnl = round2(proceeds - Number(order.usd));
    order.settlementStatus = 'settled';
    order.exitStatus = exitStatus;
    order.exitPrice = round4(currentPrice);
    order.exitReason = exitReason || `${exitStatus} at ${(currentPrice * 100).toFixed(1)}%`;
    order.won = pnl > 0;
    order.pnl = pnl;
    order.payoutUsd = proceeds;
    order.settledAtIso = new Date().toISOString();
    this.attachSettlementLossAnalysis(order);
    bucket.portfolio.cash = round2(bucket.portfolio.cash + proceeds);
    this.refreshDailyBucket(id);
    bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
    await this.persist(id);
    return order;
  }

  evaluatePlan1DirectionFlip({
    plan,
    planId = 'plan1',
    sentiment = null,
    currentPrice = null,
    now = new Date()
  }) {
    const id = this.normalizePlanId(planId);
    const openOrder = this.getOpenPaperOrderForWindow({
      planId: id,
      timeframe: plan.timeframe,
      slotIso: plan.slotIso,
      symbol: plan.symbol
    });
    if (!openOrder || !plan?.action?.shouldTrade) {
      return { flip: false, openOrder, reason: openOrder ? 'plan skipped' : 'no open order' };
    }
    const windowKey = `${plan.timeframe}_${plan.slotIso}_${plan.symbol || 'BTC-USD'}`;
    const bucket = this.getBucket(id);
    const lastFlipAtMs = bucket.lastFlipAt?.[windowKey] || null;
    const entryPrice = Number(openOrder.limitPrice) || 0;
    const price = Number.isFinite(Number(currentPrice))
      ? Number(currentPrice)
      : Number(sentiment?.[openOrder.direction === 'up' ? 'upPrice' : 'downPrice']) || entryPrice;
    const newDirectionPrice = Number(plan.action.direction === 'up'
      ? sentiment?.upPrice
      : sentiment?.downPrice) || price;
    const floatingLossPct = entryPrice > 0 ? (price - entryPrice) / entryPrice : null;
    const elapsedPct = Number.isFinite(Number(plan.elapsedPct))
      ? Number(plan.elapsedPct)
      : windowElapsedPct(getSlotSchedule(now, timeframeToSlotMinutes(plan.timeframe)));
    return {
      ...shouldPlan1DirectionFlip({
        openDirection: openOrder.direction,
        newDirection: plan.action.direction,
        config: this.config,
        timeframe: plan.timeframe || '15m',
        openOrderCreatedAtIso: openOrder.createdAtIso,
        lastFlipAtMs,
        newConfidence: plan.action.edgeConfidence ?? plan.action.confidence,
        reverseEdge: computeTradeEdge(plan.action.edgeConfidence ?? plan.action.confidence, newDirectionPrice),
        floatingLossPct,
        elapsedPct,
        now
      }),
      openOrder,
      windowKey
    };
  }

  async maybeFlipPlan1Position({ plan, sentiment, recommendation, resolveCurrentPrice, planId = 'plan1' }) {
    const id = this.normalizePlanId(planId);
    const openOrder = this.getOpenPaperOrderForWindow({
      planId: id,
      timeframe: plan?.timeframe,
      slotIso: plan?.slotIso,
      symbol: plan?.symbol
    });
    const currentPrice = openOrder && typeof resolveCurrentPrice === 'function'
      ? Number(await resolveCurrentPrice(openOrder))
      : null;
    const evaluation = this.evaluatePlan1DirectionFlip({
      plan,
      planId: id,
      sentiment,
      currentPrice
    });
    if (!evaluation.flip || !evaluation.openOrder) {
      return { flipped: false, ...evaluation };
    }
    const closed = await this.closePaperOrderEarly(evaluation.openOrder, resolveCurrentPrice, {
      exitStatus: 'direction-flip',
      exitReason: evaluation.reason,
      planId: id
    });
    const bucket = this.getBucket(id);
    if (!bucket.lastFlipAt) bucket.lastFlipAt = {};
    bucket.lastFlipAt[evaluation.windowKey] = Date.now();
    await this.persist(id);
    const order = await this.createPaperOrderFromPlan({
      plan: {
        ...plan,
        action: {
          ...plan.action,
          reason: `${evaluation.reason} 原仓 ${closed.direction?.toUpperCase()} 已平仓（PnL $${closed.pnl?.toFixed(2)}），反向开仓。`
        }
      },
      sentiment,
      recommendation,
      planId: id,
      allowFlipReentry: true
    });
    return { flipped: true, closed, order, reason: evaluation.reason };
  }

  async createPaperOrderFromPlan({ plan, sentiment, recommendation, planId = 'plan1', allowFlipReentry = false }) {
    const id = this.normalizePlanId(planId || plan?.planId || 'plan1');
    if (!plan?.action?.shouldTrade) {
      throw new Error(plan?.action?.reason || 'Current plan says skip.');
    }
    const entry = this.isPlan2FamilyPlan(id) && plan.action?.entryType === 'main'
      ? this.canOpenPlan2PaperMainUpgradeForWindow({
        timeframe: plan.timeframe,
        slotIso: plan.slotIso,
        direction: plan.action.direction,
        symbol: plan.symbol
      })
      : this.canOpenNewPaperEntryForWindow({
        planId: id,
        timeframe: plan.timeframe,
        slotIso: plan.slotIso,
        symbol: plan.symbol,
        entryType: plan.action?.entryType,
        direction: plan.action?.direction
      });
    if (!entry.allowed && !(allowFlipReentry && !entry.openOrder)) {
      throw new Error(entry.reason || `${plan.timeframe} 本窗口已买过，每个窗口只能模拟一次。`);
    }
    const order = await this.createPaperOrder({
      symbol: plan.symbol,
      direction: plan.action.direction,
      usd: plan.action.usd,
      sentiment,
      recommendation,
      planId: id,
      allowFlipReentry,
      plan: {
        key: plan.key,
        planId: id,
        timeframe: plan.timeframe,
        phaseKey: plan.window?.key || plan.phase?.key || 'window',
        phaseLabel: plan.window?.label || plan.phase?.label || plan.timeframe,
        strategy: plan.action.strategy,
        entryType: plan.action.entryType || null,
        entryTier: plan.action.entryTier || null,
        sizeMultiplier: plan.action.sizeMultiplier ?? null,
        lateCapture: plan.action.lateCapture || null,
        lockStrength: plan.action.lockStrength || plan.intervalPmLock?.strength || null,
        confidence: plan.action.confidence,
        reason: plan.action.reason,
        startPrice: plan.action.startPrice,
        targetTimeIso: plan.targetTimeIso,
        slotIso: plan.slotIso,
        takeProfitPrice: plan.action.takeProfitPrice,
        stopLossPrice: plan.action.stopLossPrice,
        exitRule: plan.exitRule,
        crossSymbolAligned: plan.action.crossSymbolAligned ?? plan.directionEntry?.crossSymbolAligned ?? null,
        crossSymbolLeader: plan.action.crossSymbolLeader || plan.directionEntry?.crossSymbolLeader || null,
        leaderLimitPrice: plan.action.leaderLimitPrice ?? plan.directionEntry?.leaderLimitPrice ?? null,
        action: plan.action
      }
    }, id);
    await this.markExecuted(plan.action?.executionKey || plan.key, id);
    return order;
  }

  refreshPlan3Daily(planId = 'plan3', now = new Date()) {
    const bucket = this.getBucket(planId);
    const dateKey = currentDateKey(now);
    if (!bucket.plan3Daily) {
      bucket.plan3Daily = freshPlanBucket('plan3').plan3Daily;
    }
    if (bucket.plan3Daily.dateKey !== dateKey) {
      bucket.plan3Daily = {
        dateKey,
        realizedPnl: 0,
        lossCount: 0,
        executionErrors: 0,
        stopped: false,
        stopReason: null
      };
    }
    return bucket.plan3Daily;
  }

  getPlan3SubmittedKeys(planId = 'plan3') {
    const bucket = this.getBucket(planId);
    const keys = Object.entries(bucket.plan3SubmittedSlots || {})
      .filter(([, entry]) => isPlan3SlotSubmissionLocked(entry))
      .map(([key]) => key);
    return new Set(keys);
  }

  liveBlockedRetryEnabled(planId = 'plan3') {
    const id = this.normalizePlanId(planId);
    // 未成交/被拦后允许短暂重评再下：覆盖主策略族
    if (id === 'plan3' || id === 'plan3_5' || id === 'plan3_6') return true;
    if (this.isPlan2FamilyPlan(id)) return this.config.plan2LiveBlockedRetryEnabled !== false;
    if (id === 'plan1' || id === 'plan5') return this.config.liveUnfilledRetryEnabled !== false;
    return false;
  }

  countLiveUnfilledRetries(planId, executionKey) {
    const id = this.normalizePlanId(planId);
    return (this.state.liveOrders || []).filter((order) => (
      this.normalizePlanId(order.planId) === id
      && order.planKey === executionKey
      && order.orderSide === 'BUY'
      && order.exitStatus === 'expired-unfilled'
    )).length;
  }

  findRetryableBlockedLiveOrder({
    planId = 'plan5',
    symbol = null,
    timeframe = null,
    slotIso = null
  } = {}) {
    const id = this.normalizePlanId(planId);
    if (!this.liveBlockedRetryEnabled(id)) return null;
    const sym = symbol ? String(symbol).toUpperCase() : null;
    const tf = timeframe || null;
    const candidates = (this.state.liveOrders || [])
      .filter((order) => (
        this.normalizePlanId(order.planId) === id
        && order.orderSide === 'BUY'
        && order.status === 'blocked'
        && order.planKey
        && (!sym || String(order.symbol || '').toUpperCase() === sym)
        && (!tf || (order.timeframe || '5m') === tf)
        && (!slotIso || order.slotIso === slotIso)
      ))
      .sort((a, b) => (
        Date.parse(b.lastRetryAtIso || b.createdAtIso || 0)
        - Date.parse(a.lastRetryAtIso || a.createdAtIso || 0)
      ));
    for (const order of candidates) {
      if (this.shouldAllowLiveBlockedRetry(id, order.planKey)) return order;
    }
    return null;
  }

  shouldAllowLiveBlockedRetry(planId, executionKey) {
    const id = this.normalizePlanId(planId);
    if (!this.liveBlockedRetryEnabled(id) || !executionKey) return false;
    const maxUnfilled = id === 'plan5'
      ? Math.max(1, Number(this.config.plan5LiveUnfilledRetryMaxPerKey) || 12)
      : this.isPlan2FamilyPlan(id)
        ? Math.max(1, Number(this.config.plan2LiveUnfilledRetryMaxPerKey) || 10)
        : Math.max(1, Number(this.config.liveUnfilledRetryMaxPerKey) || 5);
    if (this.countLiveUnfilledRetries(id, executionKey) >= maxUnfilled) return false;
    const orders = (this.state.liveOrders || []).filter((order) => (
      this.normalizePlanId(order.planId) === id
      && order.planKey === executionKey
      && order.orderSide === 'BUY'
    ));
    if (!orders.length) return false;
    const hasActive = orders.some((order) => (
      (['submitted', 'pending'].includes(order.status) && order.exitStatus !== 'expired-unfilled')
      || this.isLivePositionOpen(order)
      || this.isLivePositionPending(order)
    ));
    if (hasActive) return false;
    const retryable = orders.filter((order) => (
      order.status === 'blocked'
      || order.exitStatus === 'expired-unfilled'
    ));
    if (!retryable.length) return false;
    const blocked = retryable
      .filter((order) => order.status === 'blocked')
      .sort((a, b) => Date.parse(b.lastRetryAtIso || b.createdAtIso || 0) - Date.parse(a.lastRetryAtIso || a.createdAtIso || 0));
    if (blocked.length) {
      const latestBlocked = blocked[0];
      const structuralUnderfund = isStructuralLiveUnderfundError(latestBlocked.error);
      const configuredMax = id === 'plan3_6'
        ? Math.max(1, Number(this.config.plan3_6LiveBlockedRetryMaxPerKey) || 8)
        : id === 'plan5'
          ? Math.max(1, Number(this.config.plan5LiveBlockedRetryMaxPerKey) || 12)
          : this.isPlan2FamilyPlan(id)
            ? Math.max(1, Number(this.config.plan2LiveBlockedRetryMaxPerKey) || 16)
            : Math.max(1, Number(this.config.liveBlockedRetryMaxPerKey) || 5);
      // 风控上限长期低于 CLOB 最小份数：结构性无法成交，最多试 2 次，避免刷屏。
      const maxBlocked = structuralUnderfund ? Math.min(2, configuredMax) : configuredMax;
      if ((Number(latestBlocked.retryCount) || 1) >= maxBlocked) return false;
      const nextRetryMs = Date.parse(latestBlocked.nextRetryAtIso || 0);
      if (Number.isFinite(nextRetryMs) && Date.now() < nextRetryMs) return false;
    }
    // 仅对未成交释放施加冷却；blocked（余额不足等）保持原即时重试
    const unfilled = retryable.filter((order) => order.exitStatus === 'expired-unfilled');
    if (unfilled.length) {
      const latestOrder = unfilled
        .slice()
        .sort((a, b) => Date.parse(b.closedAtIso || b.createdAtIso || 0) - Date.parse(a.closedAtIso || a.createdAtIso || 0))[0];
      const tf = String(latestOrder?.timeframe || '').toLowerCase();
      const retryAfterMs = id === 'plan5'
        ? Math.max(0, Number(this.config.plan5LiveUnfilledRetryAfterMs) || 2000)
        : this.isPlan2FamilyPlan(id)
          ? Math.max(
            0,
            tf === '5m'
              ? (Number(this.config.plan2LiveUnfilledRetryAfterMs5m) || 1500)
              : (Number(this.config.plan2LiveUnfilledRetryAfterMs) || 2000)
          )
          : Math.max(0, Number(this.config.liveUnfilledRetryAfterMs) || 12000);
      const latest = Date.parse(latestOrder?.closedAtIso || latestOrder?.createdAtIso || 0);
      if (Number.isFinite(latest) && (Date.now() - latest) < retryAfterMs) return false;
    }
    return true;
  }

  resolveLiveBlockedRetryDelayMs(errorMessage = '', planId = null, timeframe = null) {
    const message = String(errorMessage || '');
    const id = this.normalizePlanId(planId);
    const tf = String(timeframe || '').toLowerCase();
    if (isStructuralLiveUnderfundError(message)) {
      // 本金/风控 cap 撑不起 CLOB 5 份：长冷却，避免同窗反复记 blocked。
      return Math.max(
        60_000,
        Number(this.config.plan5LiveStructuralBlockRetryAfterMs)
          || Number(this.config.liveStructuralBlockRetryAfterMs)
          || 180_000
      );
    }
    if (id === 'plan5' && /no orders found to match|FAK .*match|CLOB .*invalid|FAK 即时成交失败|暂无对手盘|当前限价未吃到卖盘|CLOB 最新买入盘口无效/i.test(message)) {
      return Math.max(250, Number(this.config.plan5LiveBlockedRetryAfterMs) || 500);
    }
    if (this.isPlan2FamilyPlan(id)
      && /no orders found to match|FAK .*match|CLOB .*invalid|FAK 即时成交失败|暂无对手盘|当前限价未吃到卖盘|CLOB 最新买入盘口无效/i.test(message)) {
      // 5m 亚秒级重试；15m 也走快速路径（默认 500ms）
      if (tf === '5m') {
        return Math.max(200, Number(this.config.plan2LiveBlockedRetryAfterMs5m) || 300);
      }
      return Math.max(250, Number(this.config.plan2LiveBlockedRetryAfterMs) || 500);
    }
    if (id === 'plan3') {
      return Math.max(500, Number(this.config.plan3LiveBlockedRetryAfterMs) || 2000);
    }
    if (id === 'plan3_6') {
      // FAK 无对手盘：加快刷新 ask 重试（对齐 Plan5）；崩价/廉价侧拦截用稍长冷却
      if (/no orders found to match|FAK .*match|暂无对手盘|当前限价未吃到卖盘|CLOB 最新买入盘口无效/i.test(message)) {
        return Math.max(250, Number(this.config.plan3_6LiveBlockedRetryAfterMs) || 500);
      }
      if (/廉价侧|崩价|热门侧硬下限|尾盘崩价/i.test(message)) {
        return Math.max(2000, Number(this.config.plan3_6LiveJunkBlockRetryAfterMs) || 8000);
      }
      return Math.max(500, Number(this.config.plan3_6LiveBlockedRetryAfterMs) || 500);
    }
    const cooldown = message.match(/冷却中.*?约\s*(\d+)\s*分钟/);
    if (cooldown) return Math.max(60_000, Number(cooldown[1]) * 60_000);
    if (/恢复模式|要求置信度|要求 edge|未达任何 tier|市场质量|价格.*不在/.test(message)) {
      return 15_000;
    }
    return Math.max(1000, Number(this.config.liveBlockedRetryAfterMs) || 8000);
  }

  shouldAllowPlan3LiveRetry(executionKey) {
    return this.shouldAllowLiveBlockedRetry('plan3', executionKey);
  }

  recordPlan3Opportunity(plan, planId = 'plan3', source = 'paper') {
    const bucket = this.getBucket(planId);
    if (!bucket.plan3OpportunityLog) bucket.plan3OpportunityLog = [];
    const action = plan?.action || {};
    const symbol = plan?.symbol || 'BTC-USD';
    const secondsRemaining = plan?.secondsRemaining ?? action.secondsRemaining ?? null;
    const reasonKey = action.skipReason || (action.shouldTrade ? 'trade' : action.reason || 'skipped');
    const secondsBucket = Number.isFinite(Number(secondsRemaining))
      ? Math.floor(Number(secondsRemaining) / (reasonKey === 'not_in_time_window' ? 30 : 5))
      : 'na';
    const signature = [
      source,
      plan?.timeframe || '',
      plan?.slotIso || '',
      symbol,
      reasonKey,
      plan?.direction ?? action.direction ?? '',
      secondsBucket
    ].join('|');
    if (bucket.plan3OpportunityLog[0]?.signature === signature) return;
    const entry = {
      signature,
      recordedAtIso: new Date().toISOString(),
      source,
      symbol,
      timeframe: plan?.timeframe || null,
      slotIso: plan?.slotIso || null,
      secondsRemaining,
      direction: plan?.direction ?? action.direction ?? null,
      skipReason: action.skipReason || (action.shouldTrade ? null : action.reason || 'skipped'),
      shouldTrade: Boolean(action.shouldTrade),
      distanceFromOpenBps: plan?.distanceFromOpenBps ?? action.distanceFromOpenBps ?? null,
      recentReverseBps: plan?.recentReverseBps ?? action.recentReverseBps ?? null,
      volatilityBpsPerSecond: plan?.volatilityBpsPerSecond ?? action.volatilityBpsPerSecond ?? null,
      tokenPrice: plan?.tokenPrice ?? action.tokenPrice ?? null,
      pmUpPrice: action.pmUpPrice ?? null,
      pmDownPrice: action.pmDownPrice ?? null,
      spread: action.spread ?? plan?.spread ?? null,
      maxSpread: action.maxSpread ?? null,
      settlementThresholdBps: action.settlementThresholdBps ?? null,
      settlementSkipDetail: action.settlementSkipDetail ?? null,
      minPrice: action.minPrice ?? null,
      maxPrice: action.maxPrice ?? null,
      limitPrice: action.limitPrice ?? plan?.limitPrice ?? null,
      orderUsd: action.usd ?? plan?.orderUsd ?? null
    };
    const seen = new Set();
    const maxEntries = Math.max(50, Number(this.config.plan3OpportunityLogMaxEntries) || 400);
    bucket.plan3OpportunityLog = [entry, ...bucket.plan3OpportunityLog]
      .filter((item) => {
        if (!item?.signature) return true;
        if (seen.has(item.signature)) return false;
        seen.add(item.signature);
        return true;
      })
      .slice(0, maxEntries);
  }

  recordPlan5ShadowObservation(plan, sentiment = null, planId = 'plan5') {
    if (this.config.plan5ShadowEnabled === false) return null;
    const id = this.normalizePlanId(planId);
    if (id !== 'plan5') return null;
    const action = plan?.action || {};
    const direction = String(action.direction || plan?.direction || '').toLowerCase();
    const quotedEntryPrice = Number(action.limitPrice);
    if (!['up', 'down'].includes(direction) || !Number.isFinite(quotedEntryPrice)
      || quotedEntryPrice <= 0 || quotedEntryPrice >= 1 || !plan?.slotIso || !plan?.targetTimeIso) {
      return null;
    }
    const bucket = this.getBucket(id);
    if (!Array.isArray(bucket.plan5ShadowObservations)) bucket.plan5ShadowObservations = [];
    const key = ['plan5-shadow', plan.timeframe || '', plan.slotIso, plan.symbol || 'BTC-USD', direction].join('|');
    const nowIso = new Date().toISOString();
    const existing = bucket.plan5ShadowObservations.find((item) => item.key === key);
    if (existing) {
      existing.lastObservedAtIso = nowIso;
      existing.lastSkipReason = action.shouldTrade ? null : (action.skipReason || 'skipped');
      existing.eventuallyTradeable = existing.eventuallyTradeable || action.shouldTrade === true;
      return null;
    }
    const priceBuffer = Math.max(0, Number(this.config.plan5EvExecutionPriceBufferAbs) || 0);
    const entryPrice = Math.min(0.99, quotedEntryPrice + priceBuffer);
    const hypotheticalUsd = round2(Math.max(0.01, Number(this.config.plan5ShadowHypotheticalUsd) || 5));
    const lock = plan?.intervalPmLock || {};
    const observation = {
      id: `pm-plan5-shadow-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      key,
      planId: 'plan5',
      strategyVersion: PLAN5_VERSION,
      status: 'open',
      settlementStatus: 'open',
      recordedAtIso: nowIso,
      lastObservedAtIso: nowIso,
      symbol: plan.symbol || sentiment?.symbol || 'BTC-USD',
      timeframe: plan.timeframe || null,
      slotIso: plan.slotIso,
      targetTimeIso: plan.targetTimeIso,
      direction,
      market: sentiment?.market || null,
      marketSlug: sentiment?.marketSlug || sentiment?.slug || null,
      conditionId: sentiment?.conditionId || null,
      quotedEntryPrice: round4(quotedEntryPrice),
      entryPrice: round4(entryPrice),
      hypotheticalUsd,
      hypotheticalShares: round4(hypotheticalUsd / entryPrice),
      shouldTrade: action.shouldTrade === true,
      eventuallyTradeable: action.shouldTrade === true,
      skipReason: action.shouldTrade ? null : (action.skipReason || 'skipped'),
      lastSkipReason: action.shouldTrade ? null : (action.skipReason || 'skipped'),
      lockStrength: action.lockStrength || lock.strength || null,
      lockPmGap: action.lockPmGap ?? lock.pmGap ?? null,
      lockedAtIso: action.lockedAtIso || lock.lockedAtIso || null,
      lockUpProbability: action.lockUpProbability ?? lock.upProbability ?? null,
      lockDownProbability: action.lockDownProbability ?? lock.downProbability ?? null,
      signalDirection: action.signalDirection || null,
      technicalDirection: action.technicalDirection || null,
      spotDirection: action.spotDirection || null,
      consensusGate: action.consensusGate || null,
      expectedValueGate: action.expectedValueGate || null
    };
    bucket.plan5ShadowObservations.unshift(observation);
    const maxEntries = Math.max(500, Number(this.config.plan5ShadowMaxEntries) || 10000);
    bucket.plan5ShadowObservations = bucket.plan5ShadowObservations.slice(0, maxEntries);
    return observation;
  }

  recordPlan5Opportunity(plan, planId = 'plan5', sentiment = null) {
    const id = this.normalizePlanId(planId);
    if (id !== 'plan5') return null;
    const shadowObservation = this.recordPlan5ShadowObservation(plan, sentiment, id);
    if (this.config.plan5OpportunityLogEnabled === false) return shadowObservation;
    const bucket = this.getBucket(id);
    if (!bucket.plan5OpportunityLog) bucket.plan5OpportunityLog = [];
    const action = plan?.action || {};
    const symbol = plan?.symbol || 'BTC-USD';
    const reasonKey = action.skipReason
      || (action.shouldTrade ? 'trade' : (action.waitingForLock ? 'waiting_for_lock' : (action.reason || 'skipped')));
    const price = Number(action.limitPrice);
    const priceBucket = Number.isFinite(price)
      ? (Math.floor(price * 20) / 20).toFixed(2)
      : 'na';
    // waiting 用 30s 桶去重，其它评估用 10s，避免刷爆日志但仍覆盖每次决策变化
    const nowMs = Date.now();
    const timeBucketMs = reasonKey === 'waiting_for_lock' ? 30_000 : 10_000;
    const timeBucket = Math.floor(nowMs / timeBucketMs);
    const signature = [
      plan?.timeframe || '',
      plan?.slotIso || '',
      symbol,
      reasonKey,
      plan?.direction ?? action.direction ?? '',
      action.lockStrength || '',
      priceBucket,
      timeBucket
    ].join('|');
    if (bucket.plan5OpportunityLog[0]?.signature === signature) return shadowObservation;
    const entry = {
      signature,
      recordedAtIso: new Date(nowMs).toISOString(),
      symbol,
      timeframe: plan?.timeframe || null,
      slotIso: plan?.slotIso || null,
      targetTimeIso: plan?.targetTimeIso || null,
      direction: plan?.direction ?? action.direction ?? null,
      shouldTrade: Boolean(action.shouldTrade),
      waitingForLock: Boolean(action.waitingForLock),
      observeOnly: Boolean(action.observeOnly),
      skipReason: action.shouldTrade ? null : (action.skipReason || reasonKey),
      reason: action.reason || null,
      lockStrength: action.lockStrength || plan?.intervalPmLock?.strength || null,
      lockPmGap: action.lockPmGap ?? plan?.intervalPmLock?.pmGap ?? null,
      quotedEntryPrice: Number.isFinite(price) ? price : null,
      executionEntryPrice: action.executionEntryPrice
        ?? action.expectedValueGate?.executionEntryPrice
        ?? null,
      signalDirection: action.signalDirection || null,
      technicalDirection: action.technicalDirection || null,
      spotDirection: action.spotDirection || null,
      consensusSizeScale: action.consensusGate?.sizeScale ?? null,
      limitPrice: Number.isFinite(price) ? price : null,
      orderUsd: action.usd ?? null,
      cashPct: action.cashPct ?? null,
      expectedRoi: action.expectedValueGate?.expectedRoi ?? null,
      evSizeScale: action.expectedValueGate?.sizeScale ?? null,
      historyWinRate: action.historyWinRateGate?.winRate ?? null,
      historyRequiredWinRate: action.historyWinRateGate?.requiredWinRate ?? null,
      historySizeScale: action.historyWinRateGate?.sizeScale ?? null,
      signalStableMs: action.signalQuality?.stableMs ?? null,
      signalPullback: action.signalQuality?.pullbackFromPeak ?? null,
      signalReverseBps: action.signalQuality?.reverseBps ?? null,
      signalSizeScale: action.signalQuality?.sizeScale ?? null,
      softReject: Boolean(
        action.expectedValueGate?.softReject
        || action.historyWinRateGate?.softReject
        || action.signalQuality?.softReject
      )
    };
    const seen = new Set();
    const maxEntries = Math.max(50, Number(this.config.plan5OpportunityLogMaxEntries) || 800);
    bucket.plan5OpportunityLog = [entry, ...bucket.plan5OpportunityLog]
      .filter((item) => {
        if (!item?.signature) return true;
        if (seen.has(item.signature)) return false;
        seen.add(item.signature);
        return true;
      })
      .slice(0, maxEntries);
    return entry;
  }

  computePlan5ShadowAnalytics() {
    const rows = this.getBucket('plan5').plan5ShadowObservations || [];
    const summarize = (items) => {
      const settled = items.filter((item) => item.settlementStatus === 'settled');
      const invested = settled.reduce((sum, item) => sum + (Number(item.hypotheticalUsd) || 0), 0);
      const pnl = settled.reduce((sum, item) => sum + (Number(item.hypotheticalPnl) || 0), 0);
      const wins = settled.filter((item) => item.won === true).length;
      return {
        total: items.length,
        open: items.filter((item) => item.settlementStatus === 'open').length,
        settled: settled.length,
        wins,
        winRate: settled.length ? round4(wins / settled.length) : 0,
        pnl: round2(pnl),
        roi: invested > 0 ? round4(pnl / invested) : 0
      };
    };
    const skipReasons = [...new Set(rows.map((item) => item.skipReason || 'trade'))];
    return {
      strategyVersion: PLAN5_VERSION,
      overall: summarize(rows),
      byTimeframe: {
        '5m': summarize(rows.filter((item) => item.timeframe === '5m')),
        '15m': summarize(rows.filter((item) => item.timeframe === '15m'))
      },
      bySkipReason: Object.fromEntries(skipReasons.map((reason) => [
        reason,
        summarize(rows.filter((item) => (item.skipReason || 'trade') === reason))
      ])),
      recentSettled: rows.filter((item) => item.settlementStatus === 'settled').slice(0, 20),
      recentOpen: rows.filter((item) => item.settlementStatus === 'open').slice(0, 20)
    };
  }

  updateLivePlan1StopConfirmation(position, exit, currentPrice, nowMs = Date.now()) {
    const isStop = exit?.exitStatus === 'stop-loss';
    if (!isStop || this.config.plan1LiveStopConfirmationEnabled !== true) {
      if (!isStop && position?.plan1StopConfirmation) delete position.plan1StopConfirmation;
      return { confirmed: Boolean(isStop), count: isStop ? 1 : 0, elapsedMs: 0 };
    }

    const timeframe = position?.timeframe === '5m' ? '5m' : '15m';
    const requiredSamples = Math.max(2, Number(this.config.plan1LiveStopConfirmSamples) || 3);
    const requiredMs = Math.max(0, Number(
      timeframe === '5m'
        ? this.config.plan1LiveStopConfirmMs5m
        : this.config.plan1LiveStopConfirmMs15m
    ) || (timeframe === '5m' ? 6000 : 12000));
    const maxGapMs = Math.max(15000, requiredMs * 2);
    const previous = position.plan1StopConfirmation;
    const previousAtMs = Date.parse(previous?.lastAtIso || '');
    const reset = !previous || !Number.isFinite(previousAtMs) || nowMs - previousAtMs > maxGapMs;
    const firstAtMs = reset ? nowMs : Date.parse(previous.firstAtIso);
    const count = reset ? 1 : (Number(previous.count) || 0) + 1;
    const price = Number(currentPrice);
    const state = {
      count,
      firstAtIso: new Date(Number.isFinite(firstAtMs) ? firstAtMs : nowMs).toISOString(),
      lastAtIso: new Date(nowMs).toISOString(),
      minPrice: Number.isFinite(price)
        ? Math.min(Number.isFinite(Number(previous?.minPrice)) ? Number(previous.minPrice) : price, price)
        : null,
      maxPrice: Number.isFinite(price)
        ? Math.max(Number.isFinite(Number(previous?.maxPrice)) ? Number(previous.maxPrice) : price, price)
        : null
    };
    position.plan1StopConfirmation = state;
    const elapsedMs = Math.max(0, nowMs - Date.parse(state.firstAtIso));
    return {
      confirmed: count >= requiredSamples && elapsedMs >= requiredMs,
      count,
      requiredSamples,
      elapsedMs,
      requiredMs,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice
    };
  }

  updatePlan13StopConfirmation(position, exit, currentPrice, currentPlanView = null, nowMs = Date.now()) {
    const isPlan13 = this.normalizePlanId(position?.planId) === PLAN13_ID;
    const isStop = isPlan2StopLossExitStatus(exit?.exitStatus);
    if (!isPlan13) return { confirmed: Boolean(isStop), changed: false };
    if (!isStop) {
      const changed = Boolean(position?.plan13StopConfirmation);
      if (changed) delete position.plan13StopConfirmation;
      return { confirmed: false, changed, count: 0 };
    }

    const oppositeDirection = position?.direction === 'up' ? 'down' : 'up';
    const signal = currentPlanView?.signal || {};
    const technicalDirection = String(
      signal.technicalDirection
      || currentPlanView?.plan?.directionEntry?.direction
      || ''
    ).toLowerCase() || null;
    const spotDirection = resolvePlan13SpotDirection(signal);
    const requireSpot = this.config.plan13StopRequireSpotReversal !== false;
    const reversalConfirmed = technicalDirection === oppositeDirection
      && (!requireSpot || spotDirection === oppositeDirection);
    if (!reversalConfirmed) {
      const changed = Boolean(position.plan13StopConfirmation);
      if (changed) delete position.plan13StopConfirmation;
      return {
        confirmed: false,
        changed,
        count: 0,
        technicalDirection,
        spotDirection,
        oppositeDirection,
        reason: '盘口已触发止损，但 Binance 技术/现货反转尚未确认。'
      };
    }

    const requiredSamples = Math.max(2, Number(this.config.plan13StopConfirmSamples) || 2);
    const requiredMs = Math.max(0, Number(this.config.plan13StopConfirmMs) || 0);
    const maxGapMs = Math.max(30_000, requiredMs * 2);
    const previous = position.plan13StopConfirmation;
    const previousAtMs = Date.parse(previous?.lastAtIso || '');
    const reset = !previous || !Number.isFinite(previousAtMs) || nowMs - previousAtMs > maxGapMs;
    const firstAtMs = reset ? nowMs : Date.parse(previous.firstAtIso);
    const count = reset ? 1 : (Number(previous.count) || 0) + 1;
    const state = {
      count,
      firstAtIso: new Date(Number.isFinite(firstAtMs) ? firstAtMs : nowMs).toISOString(),
      lastAtIso: new Date(nowMs).toISOString(),
      technicalDirection,
      spotDirection,
      oppositeDirection,
      lastPmPrice: Number.isFinite(Number(currentPrice)) ? round4(currentPrice) : null
    };
    position.plan13StopConfirmation = state;
    const elapsedMs = Math.max(0, nowMs - Date.parse(state.firstAtIso));
    return {
      confirmed: count >= requiredSamples && elapsedMs >= requiredMs,
      changed: true,
      count,
      requiredSamples,
      elapsedMs,
      requiredMs,
      technicalDirection,
      spotDirection,
      oppositeDirection
    };
  }

  recordTrajectoryExperimentOpportunity(plan, planId = 'plan1') {
    const id = this.normalizePlanId(planId);
    if (!['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan13'].includes(id)) return null;
    const evaluation = plan?.action?.trajectoryExperiment || plan?.trajectoryExperiment;
    if (evaluation?.applied !== true) return null;

    const bucket = this.getBucket(id);
    if (!bucket.trajectoryExperimentLog) bucket.trajectoryExperimentLog = [];
    const action = plan?.action || {};
    const path = action.trajectoryMetrics || plan?.trajectoryPath || {};
    const candidateDirection = action.candidateDirection || action.direction || null;
    const signature = [
      plan?.slotIso || '',
      plan?.symbol || 'BTC-USD',
      path.pattern || evaluation.pattern || '',
      candidateDirection || '',
      evaluation.reason || ''
    ].join('|');
    if (bucket.trajectoryExperimentLog.some((entry) => entry.signature === signature)) return null;

    const entry = {
      signature,
      recordedAtIso: new Date().toISOString(),
      planId: id,
      symbol: plan?.symbol || 'BTC-USD',
      timeframe: plan?.timeframe || null,
      slotIso: plan?.slotIso || null,
      targetTimeIso: plan?.targetTimeIso || null,
      candidateDirection,
      executedDirection: action.shouldTrade ? action.direction || null : null,
      shouldTrade: Boolean(action.shouldTrade),
      allowed: evaluation.allowed !== false,
      aligned: evaluation.aligned ?? null,
      pattern: path.pattern || evaluation.pattern || null,
      reason: evaluation.reason || null,
      earlyMoveBps: path.earlyMoveBps ?? null,
      plateauRangeBps: path.plateauRangeBps ?? null,
      plateauDriftBps: path.plateauDriftBps ?? null,
      reversalBps: path.reversalBps ?? null,
      retracementRatio: path.retracementRatio ?? null,
      pmDirection: path.pmDirection || null,
      pmGap: path.pmGap ?? null,
      sampleCount: path.sampleCount ?? null
    };
    bucket.trajectoryExperimentLog.unshift(entry);
    bucket.trajectoryExperimentLog = bucket.trajectoryExperimentLog.slice(0, 400);
    return entry;
  }

  recordPlan36Observation(plan) {
    const observation = plan?.observation;
    if (observation?.candidate !== true || !observation.key) return null;
    const bucket = this.getBucket('plan3_6');
    if (!Array.isArray(bucket.plan36ObservationLog)) bucket.plan36ObservationLog = [];
    const nowIso = new Date().toISOString();
    const existing = bucket.plan36ObservationLog.find((item) => item.key === observation.key);
    const update = {
      strategyVersion: observation.strategyVersion || PLAN3_6_VERSION,
      experimentLane: observation.experimentLane || PLAN3_6_LANES.REJECTED,
      tokenPrice: Number(observation.tokenPrice) || null,
      rawBestAsk: Number(observation.rawBestAsk) || null,
      paperSlippageTicks: Number(observation.paperSlippageTicks) || 0,
      modelDirection: observation.modelDirection || null,
      modelConfidence: Number(observation.modelConfidence) || null,
      modelAligned: observation.modelAligned ?? null,
      cheapDirection: observation.cheapDirection || null,
      cheapPrice: Number(observation.cheapPrice) || null,
      marketOverround: Number(observation.marketOverround) || null,
      qualified: observation.qualified === true,
      secondsRemaining: Number(observation.secondsRemaining) || null,
      shouldTrade: plan?.action?.shouldTrade === true,
      skipReason: plan?.action?.shouldTrade ? null : (plan?.action?.skipReason || 'observed_only'),
      lastObservedAtIso: nowIso
    };
    const hypotheticalUsd = round2(Number(this.config.plan3_6OrderUsd) || 5);
    if (existing) {
      if (existing.qualified !== true && update.qualified === true) {
        const tokenPrice = Number(observation.tokenPrice);
        Object.assign(existing, update, {
          hypotheticalUsd,
          hypotheticalShares: tokenPrice > 0 ? round4(hypotheticalUsd / tokenPrice) : 0,
          recordedAtIso: nowIso
        });
      }
      existing.lastObservedAtIso = nowIso;
      existing.lastSeenSecondsRemaining = update.secondsRemaining;
      return existing;
    }
    const tokenPrice = Number(observation.tokenPrice);
    const entry = {
      id: `pm-plan36-observation-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      key: observation.key,
      planId: 'plan3_6',
      symbol: observation.symbol || plan?.symbol || 'BTC-USD',
      timeframe: observation.timeframe || plan?.timeframe || null,
      slotIso: observation.slotIso || plan?.slotIso || null,
      targetTimeIso: observation.targetTimeIso || plan?.targetTimeIso || null,
      market: observation.market || null,
      marketSlug: observation.marketSlug || null,
      direction: observation.direction || plan?.direction || plan?.action?.direction || null,
      status: 'open',
      settlementStatus: 'open',
      hypotheticalUsd,
      hypotheticalShares: tokenPrice > 0 ? round4(hypotheticalUsd / tokenPrice) : 0,
      recordedAtIso: nowIso,
      ...update
    };
    bucket.plan36ObservationLog.unshift(entry);
    const maxEntries = Math.max(500, Number(this.config.plan3_6ObservationLogMaxEntries) || 10000);
    bucket.plan36ObservationLog = bucket.plan36ObservationLog.slice(0, maxEntries);
    return entry;
  }

  computePlan36Analytics() {
    const bucket = this.getBucket('plan3_6');
    const allObservations = Array.isArray(bucket.plan36ObservationLog) ? bucket.plan36ObservationLog : [];
    const observations = allObservations.filter((row) => row.strategyVersion === PLAN3_6_VERSION);
    const qualifiedObservations = observations.filter((row) => row.qualified === true);
    const summarize = (rows) => {
      const settled = rows.filter((row) => row.settlementStatus === 'settled');
      const wins = settled.filter((row) => row.won === true).length;
      const cost = settled.reduce((sum, row) => sum + (Number(row.hypotheticalUsd ?? row.usd) || 0), 0);
      const pnl = settled.reduce((sum, row) => sum + (Number(row.hypotheticalPnl ?? row.pnl) || 0), 0);
      const avgPrice = settled.length
        ? settled.reduce((sum, row) => sum + (Number(row.tokenPrice ?? row.limitPrice) || 0), 0) / settled.length
        : 0;
      return {
        total: rows.length,
        open: rows.filter((row) => row.settlementStatus === 'open').length,
        settled: settled.length,
        wins,
        losses: settled.length - wins,
        winRate: settled.length ? wins / settled.length : 0,
        cost: round2(cost),
        pnl: round2(pnl),
        roi: cost > 0 ? round4(pnl / cost) : 0,
        avgPrice: round4(avgPrice)
      };
    };
    const byLane = Object.fromEntries(Object.values(PLAN3_6_LANES).map((lane) => [
      lane,
      summarize(qualifiedObservations.filter((row) => row.experimentLane === lane))
    ]));
    const currentOrders = (bucket.paperOrders || []).filter((order) => order.strategyVersion === PLAN3_6_VERSION);
    const legacyOrders = (bucket.paperOrders || []).filter((order) => order.strategyVersion !== PLAN3_6_VERSION);
    return {
      strategyVersion: PLAN3_6_VERSION,
      candidates: summarize(observations),
      observations: summarize(qualifiedObservations),
      byLane,
      paperOrders: summarize(currentOrders),
      legacyPaperOrders: summarize(legacyOrders),
      recentSettled: qualifiedObservations.filter((row) => row.settlementStatus === 'settled').slice(0, 20),
      recentOpen: qualifiedObservations.filter((row) => row.settlementStatus === 'open').slice(0, 20)
    };
  }

  summarizePlan5Opportunities(planId = 'plan5') {
    const bucket = this.getBucket(planId);
    return summarizePlan5OpportunityLog(bucket.plan5OpportunityLog || []);
  }

  async createPlan3PaperOrder({ plan, sentiment, recommendation, planId = 'plan3' }) {
    const id = this.normalizePlanId(planId);
    const bucket = this.getBucket(id);
    const action = plan?.action;
    if (!action?.shouldTrade && !action?.observeOnly) {
      throw new Error(action?.skipReason || action?.reason || 'Plan3 skipped.');
    }
    if (!action?.shouldTrade) {
      this.recordPlan3Opportunity(plan, id);
      return null;
    }

    const submitKey = action.executionKey || buildPlan3SlotKey(plan.slotIso, plan.timeframe, action.direction, plan.symbol);
    if (bucket.plan3SubmittedSlots?.[submitKey]) {
      throw new Error('Plan3 本窗口已提交过订单。');
    }

    const limitPrice = Number(action.limitPrice);
    const askPrice = Number(action.tokenPrice ?? (action.direction === 'up' ? sentiment.upPrice : sentiment.downPrice));
    // 默认关闭乐观 direct-fill：需 ask<=limit，或显式 POLYMARKET_PLAN3_PAPER_DIRECT_FILL=true。
    const paperDirectFill = this.config.plan3PaperDirectFill === true;
    const paperFillable = paperDirectFill
      || (action.paperFillable === true)
      || (action.paperFillable !== false
        && Number.isFinite(askPrice)
        && Number.isFinite(limitPrice)
        && askPrice <= limitPrice + 1e-9);
    const fillEstimate = estimatePlan3ExpectedFillPrice({
      tokenPrice: askPrice,
      limitPrice,
      config: this.config,
      live: false
    });
    const entryFillPrice = paperFillable
      ? round4(
        Number(action.expectedFillPrice)
        || fillEstimate.expectedFillPrice
        || Math.max(askPrice || 0, limitPrice || 0)
        || limitPrice
      )
      : round4(limitPrice);
    const nowMs = Date.now();
    const ttlMs = Number(action.orderTtlMs) || 3000;
    const usd = Number(action.usd);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new Error('Plan3 订单金额无效。');
    }

    if (paperFillable && usd > bucket.portfolio.cash) {
      throw new Error(`Plan3 可用现金不足：$${bucket.portfolio.cash.toFixed(2)}`);
    }

    const entryFee = paperFillable && entryFillPrice > 0
      ? applyPaperEntryTakerFee({ shares: round4(usd / entryFillPrice), limitPrice: entryFillPrice }, this.config)
      : { shares: 0 };
    const filledShares = entryFee.shares;
    const order = {
      id: `pm-plan3-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      status: paperFillable ? 'paper-filled' : 'paper-submitted',
      settlementStatus: paperFillable ? 'open' : 'pending',
      fillStatus: paperFillable ? 'filled' : 'submitted',
      exitStatus: null,
      exitPrice: null,
      exitReason: null,
      won: null,
      pnl: null,
      payoutUsd: null,
      planId: 'plan3',
      algorithm: 'plan3',
      entryType: action.entryType || 'settlement_capture',
      captureTier: action.captureTier || null,
      priceBand: action.priceBand || null,
      symbol: plan.symbol || 'BTC-USD',
      timeframe: plan.timeframe,
      direction: action.direction,
      outcome: action.direction === 'up' ? 'UP' : 'DOWN',
      market: sentiment.market,
      marketSlug: sentiment.marketSlug,
      conditionId: sentiment.conditionId,
      tokenId: action.direction === 'up' ? sentiment.upTokenId : sentiment.downTokenId,
      orderType: 'BUY',
      limitPrice: round4(limitPrice),
      entryPrice: entryFillPrice,
      expectedFillPrice: entryFillPrice,
      fillBumpSteps: paperFillable ? (fillEstimate.bumpSteps || 0) : 0,
      usd: paperFillable ? round2(usd) : 0,
      reservedUsd: paperFillable ? 0 : round2(usd),
      shares: filledShares,
      takeProfitPrice: null,
      stopLossPrice: null,
      targetTimeIso: plan.targetTimeIso,
      slotIso: plan.slotIso,
      secondsRemaining: action.secondsRemaining,
      distanceFromOpenBps: action.distanceFromOpenBps,
      recentReverseBps: action.recentReverseBps,
      volatilityBpsPerSecond: action.volatilityBpsPerSecond,
      slotOpenPrice: action.slotOpenPrice,
      currentReferencePrice: action.referencePrice,
      pmUpPrice: action.pmUpPrice,
      pmDownPrice: action.pmDownPrice,
      spread: action.spread,
      qualityScore: action.marketQuality,
      entryConfirmation: action.entryConfirmation || null,
      strategyVersion: action.strategyVersion || null,
      orderSubmittedAtIso: new Date(nowMs).toISOString(),
      orderFilledAtIso: paperFillable ? new Date(nowMs).toISOString() : null,
      orderExpiresAtMs: nowMs + ttlMs,
      filledShares,
      grossShares: entryFee.grossShares ?? null,
      paperEntryFeeUsd: entryFee.paperEntryFeeUsd ?? null,
      paperTakerFeeRate: entryFee.paperTakerFeeRate ?? null,
      recommendation: recommendation || null,
      plan,
      createdAtIso: new Date(nowMs).toISOString(),
      ...this.buildPlan3OrderEntryAnalytics({ plan, sentiment, action })
    };

    if (paperFillable) {
      bucket.portfolio.cash = round2(bucket.portfolio.cash - order.usd);
    }

    bucket.plan3SubmittedSlots = bucket.plan3SubmittedSlots || {};
    bucket.plan3SubmittedSlots[submitKey] = {
      slotIso: plan.slotIso,
      timeframe: plan.timeframe,
      direction: action.direction,
      submittedAtIso: order.orderSubmittedAtIso,
      fillStatus: order.fillStatus
    };

    bucket.paperOrders.unshift(slimStoredPaperOrder(order));
    bucket.paperOrders = bucket.paperOrders.slice(0, Math.max(PAPER_ORDERS_HARD_CAP, 400));
    await this.markExecuted(submitKey, id);
    await this.persist('plan3');
    return order;
  }

  async processPlan3PendingOrders(planId = 'plan3', nowMs = Date.now()) {
    const bucket = this.getBucket(planId);
    const expired = [];
    for (const order of bucket.paperOrders || []) {
      if (order.planId !== 'plan3') continue;
      if (order.fillStatus !== 'submitted' || order.settlementStatus !== 'pending') continue;
      if (!order.orderExpiresAtMs || nowMs <= Number(order.orderExpiresAtMs)) continue;
      order.fillStatus = 'expired';
      order.settlementStatus = 'settled';
      order.exitStatus = 'expired-unfilled';
      order.exitReason = 'Plan3 订单 TTL 过期未成交';
      order.won = null;
      order.pnl = 0;
      order.payoutUsd = 0;
      order.settledAtIso = new Date(nowMs).toISOString();
      order.orderExpiredAtIso = order.settledAtIso;
      expired.push(order);
    }
    if (expired.length) await this.persist('plan3');
    return expired;
  }

  async maybeAutoExecutePlan3({ plan, sentiment, recommendation, planId = 'plan3' }) {
    const id = this.normalizePlanId(planId);
    const bucket = this.getBucket(id);
    if (this.config.plan3Enabled !== true) {
      return { executed: false, planId: id, reason: 'plan3 disabled' };
    }
    if (!bucket.auto.enabled) {
      return { executed: false, planId: id, reason: 'plan3 auto disabled' };
    }
    if (!bucket.portfolio.portfolioInitialized) {
      return { executed: false, planId: id, reason: 'portfolio not configured' };
    }

    this.refreshPlan3Daily(id);
    if (this.config.plan3OpportunityLogEnabled !== false) {
      this.recordPlan3Opportunity(plan, id);
      const skipReason = plan?.action?.skipReason;
      if (plan?.action?.shouldTrade || (skipReason && skipReason !== 'not_in_time_window')) {
        await this.persistOpportunityLog('plan3');
      }
    }
    if (!plan?.action?.shouldTrade) {
      return { executed: false, planId: id, reason: plan?.action?.skipReason || plan?.action?.reason || 'plan3 skipped', observed: true };
    }

    const executionKey = plan.action.executionKey || plan.key;
    if (bucket.auto.lastExecutedKeys.includes(executionKey)) {
      const submitKey = executionKey;
      const locked = isPlan3SlotSubmissionLocked(bucket.plan3SubmittedSlots?.[submitKey]);
      if (locked) {
        return { executed: false, planId: id, reason: 'plan3 slot already executed' };
      }
    }

    try {
      const order = await this.createPlan3PaperOrder({ plan, sentiment, recommendation, planId: id });
      if (!order) {
        return { executed: false, planId: id, reason: 'plan3 observe only', observed: true };
      }
      return { executed: true, planId: id, order };
    } catch (error) {
      const daily = this.refreshPlan3Daily(id);
      daily.executionErrors = (Number(daily.executionErrors) || 0) + 1;
      if (this.config.plan3LiveEnabled === true && daily.executionErrors >= (Number(this.config.plan3MaxExecutionErrorsPerDay) || 3)) {
        daily.stopped = true;
        daily.stopReason = 'execution_error_limit_reached';
      }
      await this.persist('plan3');
      return { executed: false, planId: id, reason: error.message };
    }
  }

  computePlan3Analytics(planId = 'plan3') {
    const bucket = this.getBucket(planId);
    return computePlan3Analytics(bucket.paperOrders || [], bucket.plan3OpportunityLog || []);
  }

  buildPlan3OrderEntryAnalytics({ plan, sentiment, action = null } = {}) {
    const act = action || plan?.action || {};
    try {
      const entryContext = buildPlan3EntryContext({
        plan,
        sentiment,
        action: act,
        lookbackMs: Number(this.config.plan3LossReversalLookbackMs) || 5 * 60 * 1000,
        extremePrice: Number(this.config.plan3LossReversalExtremePrice) || 0.95
      });
      return {
        entryContext,
        entryPmSnapshot: entryContext.entryPmSnapshot || null,
        intendedLimitPrice: entryContext.intendedLimitPrice ?? round4(act.limitPrice),
        preEntryPmReversal: entryContext.preEntryPmReversal || null
      };
    } catch {
      return {
        entryContext: null,
        entryPmSnapshot: {
          iso: new Date().toISOString(),
          upPrice: round4(act.pmUpPrice ?? sentiment?.upPrice),
          downPrice: round4(act.pmDownPrice ?? sentiment?.downPrice),
          tokenPrice: round4(act.tokenPrice ?? act.limitPrice),
          direction: act.direction || null,
          source: 'entry_fallback'
        },
        intendedLimitPrice: round4(act.limitPrice),
        preEntryPmReversal: null
      };
    }
  }

  attachPlan3LossAnalysis(order, { opportunityLog = null } = {}) {
    return this.attachSettlementLossAnalysis(order, { opportunityLog, forcePlan3: true });
  }

  /**
   * 结算后写入统一 lossReason / lossAnalysis（Plan1/2/3/4/5/6）。
   * 仅归因落库字段，不改变退出时序。
   */
  attachSettlementLossAnalysis(order, { opportunityLog = null, forcePlan3 = false } = {}) {
    if (!order) return false;
    const planId = this.normalizePlanId(order.planId || 'plan1');
    const isPlan3 = forcePlan3
      || planId === 'plan3'
      || order.entryType === 'settlement_capture'
      || order.entryType === 'settlement_capture_early';
    if (isPlan3) {
      const bucket = this.getBucket('plan3');
      const log = opportunityLog || bucket.plan3OpportunityLog || [];
      return applySettlementLossAnalysis(order, {
        opportunityLog: log,
        lookbackMs: Number(this.config.plan3LossReversalLookbackMs) || 5 * 60 * 1000,
        extremePrice: Number(this.config.plan3LossReversalExtremePrice) || 0.95,
        highEntryPrice: Number(this.config.plan3LossHighEntryPrice) || 0.97,
        lateSeconds: Number(this.config.plan3LossLateSeconds) || 15
      });
    }
    if (!['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan13', 'plan3_5', 'plan3_6', 'plan5'].includes(planId)) return false;
    return applySettlementLossAnalysis(order, {
      highEntryPrice: Number(this.config.lossReasonHighEntryPrice) || 0.85,
      shortHoldMs: Number(this.config.lossReasonShortHoldMs) || 90_000
    });
  }

  getLossReasonOrders({ planId = null, lookbackDays = null, source = 'all' } = {}) {
    if (!this.statsDb?.enabled) return [];
    const days = Number(lookbackDays) || Number(this.config.lossReasonGateLookbackDays) || 14;
    const cacheKey = `loss-reason-orders:${planId || 'all'}:${days}:${source}`;
    return this.getCachedAnalysis(cacheKey, 30_000, () => (
      this.statsDb.getLossReasonOrders({ planId, lookbackDays: days, source })
    ));
  }

  getLossReasonStats({ planId = null, lookbackDays = null, source = 'all' } = {}) {
    if (!this.statsDb?.enabled) {
      return { total: 0, wins: 0, losses: 0, winRate: 0, byReason: {}, orders: [] };
    }
    const days = Number(lookbackDays) || Number(this.config.lossReasonGateLookbackDays) || 14;
    return this.statsDb.getLossReasonStats({ planId, lookbackDays: days, source });
  }

  /**
   * 数据分析页仪表盘：优先 statsDb（含 paper|live source），不足时回退内存订单。
   */
  computeAnalyticsDashboard({
    planId = null,
    planIds = null,
    source = 'all',
    symbol = null,
    lookbackDays = null
  } = {}) {
    const days = Number(lookbackDays)
      || Number(this.config.analyticsLookbackDays)
      || Number(this.config.lossReasonGateLookbackDays)
      || 30;
    const normalizedSource = ['live', 'paper', 'all'].includes(String(source || '').toLowerCase())
      ? String(source).toLowerCase()
      : 'all';
    const requestedIds = Array.isArray(planIds)
      ? planIds.filter((id) => PLAN_IDS.includes(id))
      : null;
    const normalizedPlan = !requestedIds && planId && PLAN_IDS.includes(planId) ? planId : null;
    const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
    const scopeIds = requestedIds || (normalizedPlan ? [normalizedPlan] : null);

    let orders = [];
    if (this.statsDb?.enabled) {
      orders = scopeIds
        ? scopeIds.flatMap((id) => this.statsDb.getLossReasonOrders({
          planId: id,
          lookbackDays: days,
          source: normalizedSource,
          symbol: normalizedSymbol
        }) || [])
        : (this.statsDb.getLossReasonOrders({
          planId: normalizedPlan,
          lookbackDays: days,
          source: normalizedSource,
          symbol: normalizedSymbol
        }) || []);
    }

    const wantPaper = normalizedSource !== 'live';
    const wantLive = normalizedSource !== 'paper';
    const hasLiveInDb = orders.some((order) => String(order.source || '').toLowerCase() === 'live');
    const hasPaperInDb = orders.some((order) => String(order.source || '').toLowerCase() !== 'live');
    // statsDb 空、或「合并」缺 live、或「实盘」无行时，回退内存订单并打上 source。
    // 注意：不能仅在 orders.length===0 时回退，否则 paper 已入库会挡住 live-state 补齐。
    const needFallback = !orders.length
      || (wantLive && !hasLiveInDb)
      || (wantPaper && !hasPaperInDb && normalizedSource === 'paper');

    if (needFallback) {
      const fallback = [];
      const seen = new Set(orders.map((order) => String(order.id)));
      const planIds = scopeIds || PLAN_IDS;
      const cutoffMs = Date.now() - days * 86_400_000;
      if (wantPaper && (!orders.length || !hasPaperInDb)) {
        for (const id of planIds) {
          for (const order of this.getBucket(id).paperOrders || []) {
            if (order.settlementStatus !== 'settled') continue;
            if (order.exitStatus === 'expired-unfilled') continue;
            if (!order.id || seen.has(String(order.id))) continue;
            if (normalizedSymbol && String(order.symbol || order.plan?.symbol || 'BTC-USD').toUpperCase() !== normalizedSymbol) {
              continue;
            }
            const settledMs = Date.parse(order.settledAtIso || order.closedAtIso || '');
            if (Number.isFinite(settledMs) && settledMs < cutoffMs) continue;
            seen.add(String(order.id));
            fallback.push({
              ...order,
              planId: order.planId || id,
              source: 'paper',
              symbol: order.symbol || order.plan?.symbol || 'BTC-USD',
              lockStrength: order.lockStrength
                || order.plan?.action?.lockStrength
                || order.lossAnalysis?.detail?.lockStrength
                || null
            });
          }
        }
      }
      if (wantLive && (!orders.length || !hasLiveInDb)) {
        for (const order of this.state.liveOrders || []) {
          if (order.orderSide === 'SELL') continue;
          if (order.positionStatus !== 'closed') continue;
          if (order.exitStatus === 'expired-unfilled') continue;
          if (!order.id || seen.has(String(order.id))) continue;
          if (normalizedPlan && this.normalizePlanId(order.planId || 'plan1') !== normalizedPlan) continue;
          const symbol = order.symbol || order.plan?.symbol || 'BTC-USD';
          if (normalizedSymbol && String(symbol).toUpperCase() !== normalizedSymbol) continue;
          const settledMs = Date.parse(order.settledAtIso || order.closedAtIso || '');
          if (Number.isFinite(settledMs) && settledMs < cutoffMs) continue;
          seen.add(String(order.id));
          fallback.push({
            ...order,
            source: 'live',
            planId: order.planId || 'plan1',
            symbol,
            lockStrength: order.lockStrength
              || order.plan?.action?.lockStrength
              || order.lossAnalysis?.detail?.lockStrength
              || null
          });
        }
      }
      if (fallback.length) {
        orders = [...orders, ...fallback];
      }
    }

    const memoryIds = (scopeIds || ['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19']).filter((id) => ['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19'].includes(id));
    if (wantPaper && memoryIds.length) {
      const seen = new Set(orders.map((order) => String(order.id)));
      const cutoffMs = Date.now() - days * 86_400_000;
      for (const id of memoryIds) {
        for (const order of this.getBucket(id).paperOrders || []) {
          if (order.settlementStatus !== 'settled' || order.exitStatus === 'expired-unfilled') continue;
          if (!order.id || seen.has(String(order.id))) continue;
          if (normalizedSymbol && String(order.symbol || '').toUpperCase() !== normalizedSymbol) continue;
          const settledMs = Date.parse(order.settledAtIso || order.closedAtIso || '');
          if (Number.isFinite(settledMs) && settledMs < cutoffMs) continue;
          seen.add(String(order.id));
          orders.push({
            ...order,
            planId: order.planId || id,
            source: 'paper',
            symbol: order.symbol || (id === 'plan14' ? 'BTC-USD' : '未分类')
          });
        }
      }
    }
    const positionInventory = {
      plan14: this.summarizePaperInventory('plan14'),
      plan15: this.summarizePaperInventory('plan15'),
      plan16: this.summarizePaperInventory('plan16'),
      plan17: this.summarizePaperInventory('plan17'),
      plan18: this.summarizePaperInventory('plan18'),
      plan19: this.summarizePaperInventory('plan19')
    };

    let plan3LossAnalytics = null;
    let plan3BandStats = null;
    if (!normalizedPlan || normalizedPlan === 'plan3') {
      plan3LossAnalytics = this.computePlan3LossAnalytics({
        source: normalizedSource,
        limit: 20
      });
      plan3BandStats = this.statsDb?.enabled
        ? this.statsDb.getPlan3BandStats({ lookbackDays: days, source: normalizedSource })
        : {};
    }

    let nextSlotPredictions = null;
    let lockStrengthStats = null;
    if ((!normalizedPlan || normalizedPlan === 'plan5') && this.statsDb?.enabled) {
      nextSlotPredictions = this.statsDb.getNextSlotPredictions({
        lookbackDays: days,
        symbol: normalizedSymbol
      }) || [];
      // 窗口锁定强度胜率（非订单，来自 window_locks）
      try {
        const locks = this.statsDb.getLockRecords({
          timeframe: '5m',
          lookbackDays: days,
          symbol: normalizedSymbol
        }) || [];
        lockStrengthStats = { strong: { total: 0, correct: 0 }, normal: { total: 0, correct: 0 }, weak: { total: 0, correct: 0 } };
        for (const lock of locks) {
          if (!lock.decisionLocked) continue;
          const key = ['strong', 'normal', 'weak'].includes(lock.lockStrength) ? lock.lockStrength : null;
          if (!key) continue;
          if (lock.polymarketCorrect == null) continue;
          lockStrengthStats[key].total += 1;
          if (lock.polymarketCorrect === true) lockStrengthStats[key].correct += 1;
        }
        for (const key of Object.keys(lockStrengthStats)) {
          const b = lockStrengthStats[key];
          b.accuracy = b.total ? b.correct / b.total : 0;
        }
      } catch {
        lockStrengthStats = null;
      }
    }

    const avoidable = Array.isArray(this.config.lossReasonGateAvoidableReasons)
      && this.config.lossReasonGateAvoidableReasons.length
      ? this.config.lossReasonGateAvoidableReasons
      : DEFAULT_AVOIDABLE_LOSS_REASONS;

    if (scopeIds) {
      orders = orders.filter((order) => scopeIds.includes(String(order.planId || '')));
    }

    return buildPolymarketAnalyticsDashboard({
      orders,
      planId: requestedIds
        ? (requestedIds.length === 1 ? requestedIds[0] : 'current')
        : normalizedPlan,
      source: normalizedSource,
      symbol: normalizedSymbol,
      lookbackDays: days,
      plan3LossAnalytics,
      plan3BandStats,
      nextSlotPredictions,
      lockStrengthStats,
      avoidableReasons: avoidable,
      positionInventory
    });
  }

  summarizePaperInventory(planId) {
    const open = (this.getBucket(planId).paperOrders || [])
      .filter((order) => order.settlementStatus === 'open' && Number(order.usd) > 0);
    const by = {};
    for (const order of open) {
      const key = String(order.symbol || order.categoryId || '未分类');
      by[key] = (by[key] || 0) + 1;
    }
    return {
      open: open.length,
      openUsd: round2(open.reduce((sum, order) => sum + (Number(order.usd) || 0), 0)),
      by
    };
  }

  computePlan3LossAnalytics({ source = 'all', limit = 30 } = {}) {
    const paperOrders = this.getBucket('plan3').paperOrders || [];
    const liveOrders = (this.state.liveOrders || [])
      .filter((order) => normalizeLiveOrderPlanId(order) === 'plan3')
      .map((order) => ({ ...order, source: 'live' }));
    const opportunityLog = this.getBucket('plan3').plan3OpportunityLog || [];
    let orders = [];
    if (source === 'live') orders = liveOrders;
    else if (source === 'paper') orders = paperOrders.map((order) => ({ ...order, source: 'paper' }));
    else {
      orders = [
        ...liveOrders,
        ...paperOrders.map((order) => ({ ...order, source: 'paper' }))
      ];
    }
    const analytics = computePlan3LossAnalytics(orders, {
      opportunityLog,
      backfill: true,
      lookbackMs: Number(this.config.plan3LossReversalLookbackMs) || 5 * 60 * 1000
    });
    if (limit && analytics.recentLosses) {
      analytics.recentLosses = analytics.recentLosses.slice(0, Math.max(1, Number(limit) || 30));
    }
    return analytics;
  }

  async maybeAutoExecute({ plan, sentiment, recommendation, planId = 'plan1', resolveCurrentPrice = null }) {
    const id = this.normalizePlanId(planId || plan?.planId || 'plan1');
    if (id === 'plan3') {
      return this.maybeAutoExecutePlan3({ plan, sentiment, recommendation, planId: id });
    }
    const bucket = this.getBucket(id);
    if (id === 'plan5' && this.config.plan5Enabled !== true) {
      return { executed: false, planId: id, reason: 'plan5 disabled' };
    }
    if (id === 'plan3_6' && this.config.plan3_6Enabled !== true) {
      return { executed: false, planId: id, reason: 'plan3_6 disabled' };
    }
    if (!bucket.auto.enabled) return { executed: false, planId: id, reason: 'auto paper trading disabled' };
    if (!bucket.portfolio.portfolioInitialized) return { executed: false, planId: id, reason: 'portfolio not configured' };

    if (id === 'plan5' && this.config.plan5OpportunityLogEnabled !== false) {
      const recorded = this.recordPlan5Opportunity(plan, id, sentiment);
      if (recorded) await this.persistOpportunityLog(id);
    }
    if (['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan13'].includes(id)) {
      const recorded = this.recordTrajectoryExperimentOpportunity(plan, id);
      if (recorded) await this.persistOpportunityLog(id);
    }
    if (id === 'plan3_6') {
      const recorded = this.recordPlan36Observation(plan);
      if (recorded) await this.persistOpportunityLog(id, 5000);
    }

    if (id === 'plan1') {
      const isOppositeHedge = String(plan?.action?.entryType || '').toLowerCase() === 'opposite_hedge';
      const openOrder = this.getOpenPaperOrderForWindow({
        planId: id,
        timeframe: plan?.timeframe,
        slotIso: plan?.slotIso,
        symbol: plan?.symbol
      });
      // opposite_hedge is additive insurance, not a main-direction flip.
      if (!isOppositeHedge && openOrder && plan?.action?.shouldTrade && openOrder.direction !== plan.action.direction) {
        if (typeof resolveCurrentPrice !== 'function') {
          return { executed: false, planId: id, reason: 'direction flip requires price resolver' };
        }
        try {
          const flip = await this.maybeFlipPlan1Position({
            plan,
            sentiment,
            recommendation,
            resolveCurrentPrice,
            planId: id
          });
          if (flip.flipped) {
            return { executed: true, planId: id, order: flip.order, flipped: true, closed: flip.closed };
          }
          if (openOrder) {
            return { executed: false, planId: id, reason: flip.reason || 'direction flip blocked' };
          }
        } catch (error) {
          return { executed: false, planId: id, reason: error.message };
        }
      }
      if (!isOppositeHedge && openOrder && plan?.action?.shouldTrade && openOrder.direction === plan.action.direction) {
        return { executed: false, planId: id, reason: `${plan.timeframe} 本窗口已持有同方向仓位` };
      }
    }

    if (this.isPlan2FamilyPlan(id) && plan?.action?.scheduleDelayedEntry) {
      await this.schedulePlan2DelayedEntry({ plan, planId: id });
      return {
        executed: false,
        planId: id,
        scheduled: true,
        reason: plan.action.reason || 'Plan2 delayed entry scheduled'
      };
    }

    if (!plan?.action?.shouldTrade) {
      if (this.isPlan2FamilyPlan(id) && plan?.action?.clearDelayedEntry && plan?.action?.delayedEntryKey) {
        await this.clearPlan2DelayedEntry(plan.action.delayedEntryKey, id);
      }
      // Plan5 unlocked: observe/wait every tick — never consume lastExecutedKeys.
      if (id === 'plan5' && (plan?.action?.waitingForLock || plan?.action?.observeOnly)) {
        return {
          executed: false,
          planId: id,
          observed: true,
          waitingForLock: true,
          reason: plan?.action?.reason || 'Plan5 未锁定，等待锁定'
        };
      }
      return { executed: false, planId: id, reason: plan?.action?.reason || 'plan skipped' };
    }

    const executionKey = plan.action?.executionKey || plan.key;
    const entry = this.isPlan2FamilyPlan(id) && plan.action?.entryType === 'main'
      ? this.canOpenPlan2PaperMainUpgradeForWindow({
        timeframe: plan.timeframe,
        slotIso: plan.slotIso,
        direction: plan.action.direction,
        symbol: plan.symbol
      })
      : this.canOpenNewPaperEntryForWindow({
        planId: id,
        timeframe: plan.timeframe,
        slotIso: plan.slotIso,
        symbol: plan.symbol,
        entryType: plan.action?.entryType,
        direction: plan.action?.direction
      });
    if (!entry.allowed) {
      return { executed: false, planId: id, reason: entry.reason || `${plan.timeframe} 本窗口已有订单` };
    }
    if (bucket.auto.lastExecutedKeys.includes(executionKey)) {
      return { executed: false, planId: id, reason: `${plan.timeframe} 本窗口已模拟过` };
    }
    try {
      this.ensureDailyLossBudget(id);
    } catch (error) {
      return { executed: false, planId: id, reason: error.message };
    }
    let order;
    try {
      order = await this.createPaperOrderFromPlan({ plan, sentiment, recommendation, planId: id });
    } catch (error) {
      return { executed: false, planId: id, reason: error.message };
    }
    if (this.isPlan2FamilyPlan(id) && plan.action?.delayedEntryKey) {
      await this.clearPlan2DelayedEntry(plan.action.delayedEntryKey, id);
    }
    if (this.isPlan2FamilyPlan(id) && plan.action?.scheduleProbeUpgrade) {
      await this.schedulePlan2ProbeUpgrade({ plan, order, planId: id });
    }
    return { executed: true, planId: id, order };
  }

  async processPlan1Exits(resolveCurrentPrice, resolveElapsedPct = null) {
    if (this.config.plan1HoldToSettlementEnabled === true) return [];
    if (typeof resolveCurrentPrice !== 'function') return [];
    const bucket = this.getBucket('plan1');
    const closed = [];
    const timeStopRemainingPct = Number(this.config.plan1TimeStopRemainingPct) || 0.25;

    for (const order of bucket.paperOrders) {
      if (order.settlementStatus !== 'open' || order.planId !== 'plan1') continue;
      const entryPrice = Number(order.limitPrice);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      const exits = computePlan1ExitPrices(entryPrice, this.config);
      const takeProfit = Number(order.takeProfitPrice ?? exits.takeProfitPrice);
      const stopLoss = Number(order.stopLossPrice ?? exits.stopLossPrice);

      let currentPrice;
      try {
        currentPrice = Number(await resolveCurrentPrice(order));
      } catch {
        continue;
      }
      if (!Number.isFinite(currentPrice)) continue;

      let elapsedPct = null;
      if (typeof resolveElapsedPct === 'function') {
        try {
          elapsedPct = Number(await resolveElapsedPct(order));
        } catch {
          elapsedPct = null;
        }
      }
      if (!Number.isFinite(elapsedPct)) {
        elapsedPct = windowElapsedPct(getSlotSchedule(new Date(), timeframeToSlotMinutes(order.timeframe || '15m')));
      }

      let exit = null;
      if (Number.isFinite(stopLoss) && currentPrice <= stopLoss) {
        exit = {
          exitPrice: currentPrice,
          exitStatus: 'stop-loss',
          exitReason: `price ${(currentPrice * 100).toFixed(1)}% <= SL ${(stopLoss * 100).toFixed(0)}%`
        };
      } else if (Number.isFinite(takeProfit) && currentPrice >= takeProfit) {
        exit = {
          exitPrice: currentPrice,
          exitStatus: 'take-profit',
          exitReason: `price ${(currentPrice * 100).toFixed(1)}% >= TP ${(takeProfit * 100).toFixed(0)}%`
        };
      } else if (elapsedPct >= 1 - timeStopRemainingPct && currentPrice < entryPrice) {
        exit = {
          exitPrice: currentPrice,
          exitStatus: 'time-stop',
          exitReason: `窗口剩余 < ${(timeStopRemainingPct * 100).toFixed(0)}% 且价 ${(currentPrice * 100).toFixed(1)}% < 入场 ${(entryPrice * 100).toFixed(1)}%`
        };
      }
      if (!exit) continue;

      const proceeds = this.recordPaperExitProceeds(order, exit.exitPrice);
      const pnl = round2(proceeds - Number(order.usd));
      order.settlementStatus = 'settled';
      order.exitStatus = exit.exitStatus;
      order.exitPrice = round4(exit.exitPrice);
      order.exitReason = exit.exitReason;
      order.won = pnl > 0;
      order.pnl = pnl;
      order.payoutUsd = proceeds;
      order.settledAtIso = new Date().toISOString();
      this.attachSettlementLossAnalysis(order);
      bucket.portfolio.cash = round2(bucket.portfolio.cash + proceeds);
      this.refreshDailyBucket('plan1');
      bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
      closed.push(order);
    }
    if (closed.length) await this.persist('plan1');
    return closed;
  }

  async processPlan11PaperExits(resolveCurrentPrice) {
    if (!isPlan11StopLossEnabled(this.config)) return [];
    if (typeof resolveCurrentPrice !== 'function') return [];
    const bucket = this.getBucket(PLAN11_ID);
    const closed = [];
    const slOffset = Number(this.config.plan11StopLossOffset) || 0.10;

    for (const order of bucket.paperOrders) {
      if (order.settlementStatus !== 'open') continue;
      if (this.normalizePlanId(order.planId || PLAN11_ID) !== PLAN11_ID) continue;
      const entryPrice = Number(order.entryPrice ?? order.limitPrice);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      let currentPrice;
      try {
        currentPrice = Number(await resolveCurrentPrice(order));
      } catch {
        continue;
      }
      if (!Number.isFinite(currentPrice)) continue;

      const computed = computePlan11ExitPrices(entryPrice, this.config);
      const stopLoss = Number(order.stopLossPrice ?? computed.stopLossPrice ?? Math.max(0.01, entryPrice - slOffset));
      if (!Number.isFinite(stopLoss) || currentPrice > stopLoss) continue;

      const proceeds = this.recordPaperExitProceeds(order, currentPrice);
      const pnl = round2(proceeds - Number(order.usd));
      order.settlementStatus = 'settled';
      order.exitStatus = 'stop-loss';
      order.exitPrice = round4(currentPrice);
      order.exitReason = `Plan11 硬止损：价 ${(currentPrice * 100).toFixed(1)}% <= SL ${(stopLoss * 100).toFixed(0)}%`;
      order.won = pnl > 0;
      order.pnl = pnl;
      order.payoutUsd = proceeds;
      order.settledAtIso = new Date().toISOString();
      this.attachSettlementLossAnalysis(order);
      bucket.portfolio.cash = round2(bucket.portfolio.cash + proceeds);
      this.refreshDailyBucket(PLAN11_ID);
      bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
      closed.push(order);
    }
    if (closed.length) await this.persist(PLAN11_ID);
    return closed;
  }

  /** Append-only daily research data; bounded API/state logs are not the archive. */
  async archivePlan14Research(kind, row) {
    if (!this.stateDir || !['opportunities', 'exits', 'settlements', 'experiments'].includes(kind)) return;
    const observedMs = Date.parse(row.observedAtIso);
    if (!Number.isFinite(observedMs)) return;
    const folder = join(this.stateDir, 'plan14-research');
    const path = join(folder, `${new Date(observedMs).toISOString().slice(0, 10)}-${kind}.jsonl`);
    const previous = this.plan14ResearchQueues.get(path) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      await mkdir(folder, { recursive: true });
      await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8');
    });
    this.plan14ResearchQueues.set(path, task);
    try { await task; }
    catch (error) {
      const bucket = this.getBucket(PLAN14_ID);
      bucket.plan14ResearchArchiveErrors = (bucket.plan14ResearchArchiveErrors || 0) + 1;
      bucket.plan14LastArchiveError = { at: new Date().toISOString(), message: error.message };
      console.warn(`Plan14 research archive failed: ${error.message}`);
    } finally {
      if (this.plan14ResearchQueues.get(path) === task) this.plan14ResearchQueues.delete(path);
    }
  }

  async archivePlan14Settlement(order) {
    const { plan14ExitObservations, plan14LastExitObservation, plan, recommendation, ...record } = order;
    await this.archivePlan14Research('settlements', { observedAtIso: new Date().toISOString(), order: record });
  }

  async recordPlan14Opportunity(plan, sentiment) {
    if (!plan?.decision?.model?.freshBook || !plan.comparison) return;
    const bucket = this.getBucket(PLAN14_ID);
    const rows = bucket.plan14OpportunityLog || [];
    const time = Date.parse(plan.generatedAtIso);
    if (!Number.isFinite(time)) return;
    const recent = rows.find(row => row.symbol === plan.symbol && row.slotIso === plan.slotIso);
    if (recent && time - Date.parse(recent.observedAtIso) < 3000) return;
    rows.unshift({ observedAtIso: plan.generatedAtIso, symbol: plan.symbol, timeframe: plan.timeframe,
      slotIso: plan.slotIso, targetTimeIso: plan.targetTimeIso, marketSlug: sentiment?.marketSlug || sentiment?.slug,
      version: PLAN14_VERSION, model: plan.decision.model, candidates: plan.decision.candidates,
      decision: { allowed: plan.decision.allowed, skipReason: plan.decision.skipReason, selected: plan.decision.selected },
      previous: { version: PLAN14_PREVIOUS_VERSION, allowed: plan.comparison.allowed,
        skipReason: plan.comparison.skipReason, selected: plan.comparison.selected },
      note: 'Same-quote forecast comparison, not filled orders or equal-capital PnL.' });
    if (rows.length > 4000) bucket.plan14OpportunitiesDropped = (bucket.plan14OpportunitiesDropped || 0) + rows.length - 4000;
    bucket.plan14OpportunityLog = rows.slice(0, 4000);
    if (this.config.plan14ProfitExperimentEnabled !== false && bucket.auto?.enabled && plan.profitExperiment) {
      bucket.plan14ProfitExperiment ||= createPlan14ProfitExperiment(time);
      const events = observePlan14ProfitExperiment(bucket.plan14ProfitExperiment, plan, sentiment, Date.now(), resolvePaperTakerFeeRate(this.config));
      for (const event of events) await this.archivePlan14Research('experiments', { observedAtIso: new Date().toISOString(), ...event });
      rows[0].profitExperiment = { baseline: { allowed: plan.profitExperiment.baseline.allowed,
        selected: plan.profitExperiment.baseline.selected, model: plan.profitExperiment.baseline.model },
      candidate: { allowed: plan.profitExperiment.candidate.allowed, selected: plan.profitExperiment.candidate.selected,
        model: plan.profitExperiment.candidate.model } };
    }
    await this.archivePlan14Research('opportunities', rows[0]);
    await this.persist(PLAN14_ID);
  }

  async settlePlan14ProfitExperiment(resolveOutcome, { nowMs = Date.now() } = {}) {
    const bucket = this.getBucket(PLAN14_ID), state = bucket.plan14ProfitExperiment;
    if (!state) return 0;
    const due = new Map();
    for (const lane of Object.values(state.lanes)) for (const order of lane.open) {
      if (order.status === 'open' && order.targetMs <= nowMs - 15000) due.set(order.marketSlug, order);
    }
    let changed = false;
    // Bounded parallel lookups and rotating retries: one unresolved market must
    // not monopolize the queue or serially delay the main simulation for minutes.
    const attempts = [...due.values()].filter(o=>nowMs-(o.lastOfficialAttemptAtMs||0)>=30000)
      .sort((a,b)=>(a.lastOfficialAttemptAtMs||0)-(b.lastOfficialAttemptAtMs||0)).slice(0,4);
    await Promise.all(attempts.map(async order => {
      order.lastOfficialAttemptAtMs = nowMs;
      changed = true;
      try {
        const outcome = await resolveOutcome(order);
        if (outcome?.priceSource !== 'polymarket-official' || !['up','down'].includes(outcome.actualDirection)) return;
        resolvePlan14ProfitExperiment(state, order.marketSlug, outcome, nowMs);
        changed = true;
      } catch (error) { state.lastSettlementError = { at: new Date(nowMs).toISOString(), message: error.message }; changed = true; }
    }));
    const events = releasePlan14ProfitExperiment(state, nowMs);
    for (const event of events) await this.archivePlan14Research('experiments', { observedAtIso: new Date(nowMs).toISOString(), ...event });
    if (changed || events.length) await this.persist(PLAN14_ID);
    return events.length;
  }

  async processPlan14PaperExits(resolveExitInputs, { nowMs = null } = {}) {
    if (this.config.plan14Enabled === false || typeof resolveExitInputs !== 'function') return [];
    const bucket = this.getBucket(PLAN14_ID);
    const closed = [];
    let changed = false;
    for (const order of bucket.paperOrders) {
      // V9 research continues after an account exit until its window expires.
      if (order.settlementStatus !== 'open'
        && !(order.settlementStatus === 'settled' && [PLAN14_VERSION, PLAN14_V9_VERSION].includes(order.strategyVersion))) continue;
      if (this.normalizePlanId(order.planId || PLAN14_ID) !== PLAN14_ID) continue;
      const slotMs = Date.parse(order.slotIso);
      const slotMinutes = timeframeToSlotMinutes(order.timeframe || '5m');
      if (!Number.isFinite(slotMs) || !(slotMinutes > 0)) continue;
      const elapsedPct = ((nowMs ?? Date.now()) - slotMs) / (slotMinutes * 60_000);
      if (!(elapsedPct > 0 && elapsedPct < 1)) continue;

      let quote;
      try {
        quote = await resolveExitInputs(order);
      } catch {
        if (order.plan14StopConfirmation) {
          delete order.plan14StopConfirmation;
          changed = true;
        }
        order.plan14ExitObservationErrors = (order.plan14ExitObservationErrors || 0) + 1;
        if (order.plan14ExitControl) order.plan14ExitControl.confirmation = null;
        order.plan14LastExitErrorAtIso = new Date(nowMs ?? Date.now()).toISOString();
        changed = true;
        continue;
      }
      const observedAtMs = nowMs ?? Date.now();
      // Fetching inputs can straddle expiry; official settlement owns the expired window.
      if (observedAtMs >= Date.parse(order.targetTimeIso)) continue;
      observePlan14ExitControl(order, quote, observedAtMs, this.config, resolvePaperTakerFeeRate(this.config));
      const decision = evaluatePlan14Exit({ order, inputs: quote, nowMs: observedAtMs, config: this.config,
        exitTakerFeeRate: resolvePaperTakerFeeRate(this.config) });
      if (Number.isFinite(decision.holdValue)) order.plan14HoldValue = decision.holdValue;
      const confirmation = confirmPlan14Stop(order, decision, quote, observedAtMs, this.config);
      {
        order.plan14StopConfirmation = confirmation.state;
        const observation = {
          observedAtIso: new Date(observedAtMs).toISOString(),
          ...quote,
          ...decision,
          confirmation: confirmation.state,
          confirmed: confirmation.confirmed
        };
        const shares = Number(order.shares) || 0;
        const executableBid = Number(quote.bid);
        if (executableBid > 0 && executableBid < 1) {
          observation.executableNetPnl = round2(shares * executableBid
            - polymarketCryptoTakerFee(shares, executableBid, resolvePaperTakerFeeRate(this.config)) - Number(order.usd));
        }
        order.plan14LastExitObservation = observation;
        const observations = order.plan14ExitObservations || [];
        observations.push(observation);
        if (observations.length > 256) {
          order.plan14ExitObservationsDropped = (order.plan14ExitObservationsDropped || 0) + observations.length - 256;
        }
        order.plan14ExitObservations = observations.slice(-256);
        await this.archivePlan14Research('exits', {
          observedAtIso: observation.observedAtIso, orderId: order.id, strategyVersion: order.strategyVersion,
          symbol: order.symbol, timeframe: order.timeframe, slotIso: order.slotIso, targetTimeIso: order.targetTimeIso,
          marketSlug: order.marketSlug, direction: order.direction, entryPrice: order.limitPrice,
          usd: order.usd, shares: order.shares, accountPositionOpen: order.settlementStatus === 'open',
          observation, exitControl: order.plan14ExitControl || null
        });
        // Kept separately so the bounded trace cannot erase the initial trigger price.
        if (decision.exit && decision.exitStatus === 'model-stop-loss' && !order.plan14FirstStopObservation) {
          order.plan14FirstStopObservation = observation;
        }
        changed = true;
      }
      if (order.settlementStatus !== 'open' || !decision.exit) continue;
      if (!confirmation.confirmed) continue;

      const bid = Number(quote.bid);
      const proceeds = this.recordPaperExitProceeds(order, bid);
      const pnl = round2(proceeds - Number(order.usd));
      order.settlementStatus = 'settled';
      order.exitStatus = decision.exitStatus;
      order.exitPrice = round4(bid);
      order.exitReason = decision.exitReason;
      order.exitTrigger = decision.exitTrigger || 'model';
      order.exitPolicyVersion = [PLAN14_VERSION, PLAN14_V9_VERSION, PLAN14_V8_VERSION, PLAN14_V7_VERSION, PLAN14_V6_VERSION, PLAN14_V5_VERSION, PLAN14_PREVIOUS_VERSION].includes(order.strategyVersion)
        ? order.strategyVersion : PLAN14_V3_VERSION;
      if (confirmation.state) {
        order.exitReason += ` · ${confirmation.state.count} 次新报价、持续 ${Math.floor((observedAtMs - confirmation.state.firstAtMs) / 1000)} 秒确认`;
      }
      order.won = pnl > 0;
      order.pnl = pnl;
      order.payoutUsd = proceeds;
      order.settledAtIso = new Date(observedAtMs).toISOString();
      this.attachSettlementLossAnalysis(order);
      bucket.portfolio.cash = round2(bucket.portfolio.cash + proceeds);
      this.refreshDailyBucket(PLAN14_ID);
      bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
      closed.push(order);
    }
    if (closed.length || changed) await this.persist(PLAN14_ID);
    return closed;
  }

  async processPlan5StopLosses(resolveCurrentPrice, { resolveCurrentPlanView = null } = {}) {
    if (this.config.plan5StopLossEnabled === false || typeof resolveCurrentPrice !== 'function') return [];
    const bucket = this.getBucket('plan5');
    const closed = [];
    for (const order of bucket.paperOrders) {
      if (order.settlementStatus !== 'open' || order.planId !== 'plan5') continue;
      let currentPrice;
      try {
        currentPrice = Number(await resolveCurrentPrice(order));
      } catch {
        continue;
      }
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;
      order.lowestExecutableBid = round4(Math.min(
        Number.isFinite(Number(order.lowestExecutableBid)) ? Number(order.lowestExecutableBid) : currentPrice,
        currentPrice
      ));
      order.lastStopObservedAtIso = new Date().toISOString();

      let currentPlanView = null;
      if (typeof resolveCurrentPlanView === 'function') {
        try {
          currentPlanView = await resolveCurrentPlanView(order);
        } catch {
          currentPlanView = null;
        }
      }
      const exit = evaluatePlan5StopLoss({
        positionDirection: order.direction,
        currentPrice,
        currentPmDirection: resolvePlan5CurrentPmDirection(currentPlanView),
        config: this.config
      });
      if (!exit) continue;

      const proceeds = this.recordPaperExitProceeds(order, exit.exitPrice);
      const pnl = round2(proceeds - Number(order.usd));
      order.settlementStatus = 'settled';
      order.exitStatus = exit.exitStatus;
      order.exitPrice = round4(exit.exitPrice);
      order.exitReason = exit.exitReason;
      order.won = pnl > 0;
      order.pnl = pnl;
      order.payoutUsd = proceeds;
      order.settledAtIso = new Date().toISOString();
      this.attachSettlementLossAnalysis(order);
      bucket.portfolio.cash = round2(bucket.portfolio.cash + proceeds);
      this.refreshDailyBucket('plan5');
      bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
      closed.push(order);
    }
    if (closed.length) await this.persist('plan5');
    return closed;
  }

  async processPlan2TakeProfits(resolveCurrentPrice, { resolveCurrentPlanView = null } = {}) {
    if (typeof resolveCurrentPrice !== 'function') return [];
    const trailingOn = this.config.plan2TrailingTakeProfitEnabled === true;
    if (
      this.config.plan2TakeProfitEnabled === false
      && this.config.plan2StopLossEnabled === false
      && !trailingOn
    ) return [];

    const closed = [];
    for (const planId of ['plan2', 'plan2_5', 'plan2_6', 'plan13']) {
      closed.push(...await this.processPlan2FamilyPaperExits(planId, resolveCurrentPrice, { resolveCurrentPlanView }));
    }
    return closed;
  }

  async processPlan2FamilyPaperExits(planId, resolveCurrentPrice, { resolveCurrentPlanView = null } = {}) {
    const id = this.normalizePlanId(planId);
    const bucket = this.getBucket(id);
    const closed = [];
    let peakChanged = false;
    let confirmationChanged = false;
    const tpOffset = Number(this.config.plan2TakeProfitOffset) || 0.18;
    const slOffset = Number(this.config.plan2StopLossOffset) || 0.12;
    const trailingEnabled = this.isPlan2TrailingTakeProfitEnabled(id);

    for (const order of bucket.paperOrders) {
      if (order.settlementStatus !== 'open') continue;
      if (!order.planId) order.planId = id;
      if (isPlan2HoldToExpiryEntryType(order)) continue;
      const entryPrice = Number(order.limitPrice);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      const exits = computeDynamicExitPrices(entryPrice, {
        takeProfitOffset: tpOffset,
        stopLossOffset: slOffset,
        absoluteStopLossFloor: resolveStopLossAbsoluteFloor(this.config)
      });
      const stopLoss = Number(order.stopLossPrice ?? exits.stopLossPrice);
      const takeProfit = Number(order.takeProfitPrice ?? exits.takeProfitPrice);

      let currentPrice;
      try {
        currentPrice = Number(await resolveCurrentPrice(order));
      } catch {
        continue;
      }
      if (!Number.isFinite(currentPrice)) continue;

      const trailing = trailingEnabled ? this.applyPlan2TrailingPeak(order, currentPrice) : { changed: false, trail: null };
      if (trailing.changed) peakChanged = true;

      let exit = null;
      if (this.isPlan2LiveHardStopLossEnabled(id) && Number.isFinite(stopLoss) && currentPrice <= stopLoss) {
        exit = {
          exitPrice: currentPrice,
          exitStatus: 'stop-loss',
          exitReason: `price ${(currentPrice * 100).toFixed(1)}% <= SL ${(stopLoss * 100).toFixed(0)}%`
        };
      } else if (trailingEnabled && trailing.trail?.exit) {
        exit = trailing.trail.exit;
      } else if (
        !trailingEnabled
        && this.isPlan2TakeProfitEnabled(id)
        && Number.isFinite(takeProfit)
        && currentPrice >= takeProfit
      ) {
        exit = {
          exitPrice: currentPrice,
          exitStatus: 'take-profit',
          exitReason: `price ${(currentPrice * 100).toFixed(1)}% >= TP ${(takeProfit * 100).toFixed(0)}%`
        };
      }
      let currentPlanView = null;
      if (id === PLAN13_ID && exit && typeof resolveCurrentPlanView === 'function') {
        try {
          currentPlanView = await resolveCurrentPlanView(order);
        } catch {
          currentPlanView = null;
        }
      }
      if (id === PLAN13_ID) {
        const confirmation = this.updatePlan13StopConfirmation(order, exit, currentPrice, currentPlanView);
        if (confirmation.changed) confirmationChanged = true;
        if (exit && !confirmation.confirmed) continue;
        if (exit) {
          exit.exitReason = `${exit.exitReason} · Binance 技术/现货反转连续 ${confirmation.count}/${confirmation.requiredSamples} 次确认`;
        }
      }
      if (!exit) continue;

      const proceeds = this.recordPaperExitProceeds(order, exit.exitPrice);
      const pnl = round2(proceeds - Number(order.usd));
      order.settlementStatus = 'settled';
      order.exitStatus = exit.exitStatus;
      order.exitPrice = round4(exit.exitPrice);
      order.exitReason = exit.exitReason;
      order.won = pnl > 0;
      order.pnl = pnl;
      order.payoutUsd = proceeds;
      order.settledAtIso = new Date().toISOString();
      this.attachSettlementLossAnalysis(order);
      bucket.portfolio.cash = round2(bucket.portfolio.cash + proceeds);
      this.refreshDailyBucket(id);
      bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
      closed.push(order);
    }
    if (closed.length || peakChanged || confirmationChanged) await this.persist(id);
    return closed;
  }

  async settleOpenOrders(planId, resolveOutcome) {
    if (typeof resolveOutcome !== 'function') throw new Error('resolveOutcome callback is required.');
    const id = this.normalizePlanId(planId);
    const bucket = this.getBucket(id);
    const nowMs = Date.now();
    const settledOrders = [];
    let settledObservations = 0;
    let settlementStateChanged = false;
    if (id === 'plan3_6') {
      const observations = Array.isArray(bucket.plan36ObservationLog) ? bucket.plan36ObservationLog : [];
      const due = observations
        .filter((item) => item.settlementStatus === 'open'
          && item.targetTimeIso
          && Date.parse(item.targetTimeIso) <= nowMs - 15_000)
        .slice(0, 30);
      for (const item of due) {
        let outcome;
        try {
          outcome = await resolveOutcome(item);
        } catch (error) {
          item.settlementError = error.message;
          continue;
        }
        if (!outcome?.actualDirection) continue;
        const won = item.direction === outcome.actualDirection;
        const payoutUsd = won ? round2(Number(item.hypotheticalShares) || 0) : 0;
        item.settlementStatus = 'settled';
        item.status = 'settled';
        item.won = won;
        item.actualDirection = outcome.actualDirection;
        item.payoutUsd = payoutUsd;
        item.hypotheticalPnl = round2(payoutUsd - (Number(item.hypotheticalUsd) || 0));
        item.actualClose = Number(outcome.actualClose) || null;
        item.startPrice = Number(outcome.startPrice) || null;
        item.settledAtIso = new Date().toISOString();
        item.settlementError = null;
        if (outcome.priceSource === 'polymarket-official') {
          item.settlementPriceSource = outcome.priceSource;
          item.officialOutcome = outcome.officialOutcome || outcome.actualDirection;
          item.officialOutcomePrices = outcome.outcomePrices || null;
          item.officialOutcomeVerifiedAtIso = new Date().toISOString();
        }
        settledObservations += 1;
      }
    }
    if (id === 'plan5') {
      const observations = Array.isArray(bucket.plan5ShadowObservations)
        ? bucket.plan5ShadowObservations
        : [];
      const due = observations
        .filter((item) => item.settlementStatus === 'open'
          && item.targetTimeIso
          && Date.parse(item.targetTimeIso) <= nowMs - 15_000)
        .slice(0, 50);
      for (const item of due) {
        let outcome;
        try {
          outcome = await resolveOutcome(item);
        } catch (error) {
          item.settlementError = error.message;
          continue;
        }
        if (!outcome?.actualDirection) continue;
        const won = item.direction === outcome.actualDirection;
        const payoutUsd = won ? round2(Number(item.hypotheticalShares) || 0) : 0;
        item.settlementStatus = 'settled';
        item.status = 'settled';
        item.won = won;
        item.actualDirection = outcome.actualDirection;
        item.payoutUsd = payoutUsd;
        item.hypotheticalPnl = round2(payoutUsd - (Number(item.hypotheticalUsd) || 0));
        item.actualClose = Number(outcome.actualClose) || null;
        item.startPrice = Number(outcome.startPrice) || null;
        item.settledAtIso = new Date().toISOString();
        item.settlementError = null;
        if (outcome.priceSource === 'polymarket-official') {
          item.settlementPriceSource = outcome.priceSource;
          item.officialOutcome = outcome.officialOutcome || outcome.actualDirection;
          item.officialOutcomePrices = outcome.outcomePrices || null;
          item.officialOutcomeVerifiedAtIso = new Date().toISOString();
        }
        settledObservations += 1;
      }
    }
    for (const order of bucket.paperOrders) {
      if (order.settlementStatus !== 'open') continue;
      const endMs = Date.parse(order.targetTimeIso);
      if (!Number.isFinite(endMs) || endMs > nowMs) continue;
      order.firstPastEndAtIso ||= new Date(nowMs).toISOString();
      order.resolutionWaitMs = nowMs - endMs;
      settlementStateChanged = true;
      if (endMs > nowMs - 15_000) continue;
      let outcome;
      try {
        outcome = await resolveOutcome(order);
        order.lastSettlementError = null;
        order.settlementError = null;
      } catch (error) {
        order.lastSettlementError = error.message || String(error);
        order.settlementError = order.lastSettlementError;
        order.settlementFetchFailures = (Number(order.settlementFetchFailures) || 0) + 1;
        continue;
      }
      if (id === PLAN15_ID || id === PLAN16_ID || id === PLAN17_ID || id === PLAN18_ID || id === PLAN19_ID) {
        if (outcome?.priceSource !== 'polymarket-official') continue;
        const label = String(outcome?.officialOutcome || '').trim();
        let won;
        let payoutUsd;
        if (outcome.void) {
          // 作废/平局：Polymarket 按 outcomePrices（通常各 0.5）每股兑付，不是输也不是赢。
          const index = (outcome.outcomes || []).findIndex((name) => String(name).toLowerCase() === String(order.outcome || '').trim().toLowerCase());
          const perShare = index >= 0 ? Number(outcome.outcomePrices?.[index]) : NaN;
          if (!Number.isFinite(perShare)) continue;
          won = null;
          payoutUsd = round2((Number(order.shares) || 0) * perShare);
          order.voidSettlement = true;
        } else {
          if (!label) continue;
          won = label.toLowerCase() === String(order.outcome || '').trim().toLowerCase();
          payoutUsd = won ? round2(Number(order.shares) || 0) : 0;
        }
        const pnl = round2(payoutUsd - Number(order.usd));
        order.settlementStatus = 'settled';
        order.exitStatus = order.exitStatus || 'expiry';
        order.won = won;
        order.pnl = pnl;
        order.payoutUsd = payoutUsd;
        order.officialOutcome = outcome.void ? '作废（按 outcomePrices 兑付）' : outcome.officialOutcome;
        order.officialOutcomePrices = outcome.outcomePrices || null;
        order.settlementPriceSource = outcome.priceSource;
        order.officialOutcomeVerifiedAtIso = new Date().toISOString();
        order.settledAtIso = new Date().toISOString();
        order.settlementError = null;
        bucket.portfolio.cash = round2(bucket.portfolio.cash + payoutUsd);
        this.refreshDailyBucket(id);
        bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
        settledOrders.push(order);
        continue;
      }
      if (!outcome?.actualDirection) continue;
      if (id === PLAN14_ID && outcome.priceSource !== 'polymarket-official') {
        order.settlementError = 'Plan14：等待官方结果，不以现货方向代替结算';
        continue;
      }
      const won = order.direction === outcome.actualDirection;
      const payoutUsd = won ? round2(Number(order.shares) || 0) : 0;
      const pnl = round2(payoutUsd - Number(order.usd));
      order.settlementStatus = 'settled';
      order.exitStatus = order.exitStatus || 'expiry';
      order.won = won;
      order.pnl = pnl;
      order.payoutUsd = payoutUsd;
      order.actualDirection = outcome.actualDirection;
      order.actualClose = Number(outcome.actualClose) || null;
      order.startPrice = Number(outcome.startPrice ?? order.startPrice) || order.startPrice;
      if (outcome.priceSource === 'polymarket-official') {
        order.settlementPriceSource = outcome.priceSource;
        order.officialOutcome = outcome.officialOutcome || outcome.actualDirection;
        order.officialOutcomePrices = outcome.outcomePrices || null;
        order.officialOutcomeVerifiedAtIso = new Date().toISOString();
      }
      order.settledAtIso = new Date().toISOString();
      order.settlementError = null;
      this.attachSettlementLossAnalysis(order);
      bucket.portfolio.cash = round2(bucket.portfolio.cash + payoutUsd);
      this.refreshDailyBucket(id);
      bucket.daily.realizedPnl = round2(bucket.daily.realizedPnl + pnl);
      if (id === 'plan3') {
        const plan3Daily = this.refreshPlan3Daily(id);
        plan3Daily.realizedPnl = round2((Number(plan3Daily.realizedPnl) || 0) + pnl);
        if (pnl < 0) {
          plan3Daily.lossCount = (Number(plan3Daily.lossCount) || 0) + 1;
          if (this.config.plan3LiveEnabled === true && this.config.plan3StopAfterOneLoss === true) {
            plan3Daily.stopped = true;
            plan3Daily.stopReason = 'stop_after_one_loss';
          }
        }
        // 日亏损门控统一按全部实盘 Plan 的当日已实现 PnL 计算。
      }
      settledOrders.push(order);
      if (id === PLAN14_ID) await this.archivePlan14Settlement(order);
    }
    if (settledOrders.length || settledObservations || settlementStateChanged) await this.persist(id);
    if (id === PLAN14_ID) await this.settlePlan14ProfitExperiment(resolveOutcome, { nowMs });
    return settledOrders;
  }

  async reconcilePaperOfficialSettlements(resolveOutcome, { planId = 'plan3_6', limit = 25 } = {}) {
    if (typeof resolveOutcome !== 'function') throw new Error('resolveOutcome callback is required.');
    const id = this.normalizePlanId(planId);
    const bucket = this.getBucket(id);
    const candidates = (bucket.paperOrders || [])
      .filter((order) => (
        order.settlementStatus === 'settled'
        && order.exitStatus === 'expiry'
        && order.marketSlug
        && !order.officialOutcomeVerifiedAtIso
      ))
      .slice(0, Math.max(1, Number(limit) || 25));
    const corrected = [];
    let verified = 0;
    const resolutions = await Promise.all(candidates.map(async (order) => {
      try {
        return { order, outcome: await resolveOutcome(order), error: null };
      } catch (error) {
        return { order, outcome: null, error };
      }
    }));
    for (const { order, outcome, error } of resolutions) {
      if (error) {
        order.settlementError = error.message;
        continue;
      }
      if (!outcome?.actualDirection || outcome.priceSource !== 'polymarket-official') continue;
      verified += 1;
      const previousDirection = order.actualDirection || null;
      const previousPnl = Number(order.pnl) || 0;
      const previousPayout = Number(order.payoutUsd) || 0;
      const won = order.direction === outcome.actualDirection;
      const payoutUsd = won ? round2(Number(order.shares) || 0) : 0;
      const pnl = round2(payoutUsd - (Number(order.usd) || 0));
      order.actualDirection = outcome.actualDirection;
      order.actualClose = Number(outcome.actualClose) || null;
      order.startPrice = Number(outcome.startPrice ?? order.startPrice) || order.startPrice;
      order.won = won;
      order.pnl = pnl;
      order.payoutUsd = payoutUsd;
      order.settlementPriceSource = outcome.priceSource;
      order.officialOutcome = outcome.officialOutcome || outcome.actualDirection;
      order.officialOutcomePrices = outcome.outcomePrices || null;
      order.officialOutcomeVerifiedAtIso = new Date().toISOString();
      order.settlementError = null;
      this.attachSettlementLossAnalysis(order);
      this._statsDbSyncedIds.delete(order.id);
      const payoutDelta = round2(payoutUsd - previousPayout);
      if (payoutDelta) bucket.portfolio.cash = round2((Number(bucket.portfolio.cash) || 0) + payoutDelta);
      if (bucket.daily?.dateKey && formatShanghaiDate(order.settledAtIso || order.targetTimeIso) === bucket.daily.dateKey) {
        bucket.daily.realizedPnl = round2((Number(bucket.daily.realizedPnl) || 0) + (pnl - previousPnl));
      }
      if (previousDirection !== order.actualDirection || previousPnl !== pnl) corrected.push(order);
    }
    if (verified) await this.persist(id);
    return { planId: id, checked: candidates.length, verified, corrected };
  }

  async markExecuted(key, planId = 'plan1') {
    const bucket = this.getBucket(planId);
    bucket.auto.lastExecutedKeys = [key, ...bucket.auto.lastExecutedKeys.filter((item) => item !== key)].slice(0, 240);
    await this.persist(planId);
  }

  buildLiveOrderDraft({
    plan,
    sentiment,
    recommendation = null,
    planId = 'plan1',
    usd = null,
    clobBalanceUsdc = null
  }) {
    if (!plan?.action?.shouldTrade) {
      throw new Error(plan?.action?.reason || 'Current plan says skip.');
    }
    if (!sentiment?.available) {
      throw new Error(`Polymarket market unavailable: ${sentiment?.reason || 'unknown'}`);
    }

    const direction = plan.action.direction;
    if (!['up', 'down'].includes(direction)) {
      throw new Error('计划方向无效。');
    }

    const normalizedPlanId = this.normalizePlanId(planId || plan.planId || 'plan1');
    const globalDailyLoss = this.globalLiveDailyLossSnapshot({ clobBalanceUsdc });
    if (globalDailyLoss.triggered) {
      throw new Error(
        `全策略日亏损保护已触发：今日实盘已实现 PnL -$${Math.abs(globalDailyLoss.realizedPnl).toFixed(2)}，上限 $${globalDailyLoss.limitUsd.toFixed(2)}；停止所有 Plan 新开仓。`
      );
    }
    const globalLiveMaxUsd = Number(this.config.liveMaxOrderUsd) || Number(this.config.maxOrderUsd) || 500;
    const liveMaxUsd = normalizedPlanId === 'plan3'
      ? (this.config.plan3ProbSizingEnabled === true
        ? Math.min(globalLiveMaxUsd, Number(this.config.plan3LiveMaxOrderUsd) || 3)
        : globalLiveMaxUsd)
      : globalLiveMaxUsd;
    const explicitUsd = usd != null && usd !== '';
    const requestedUsd = Number(explicitUsd ? usd : plan.action.usd);
    if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) {
      throw new Error('买入金额无效。');
    }

    const risk = this.liveRiskSnapshot({
      clobBalanceUsdc,
      timeframe: plan.timeframe || sentiment.timeframe || '15m',
      planId: normalizedPlanId
    });
    const isSimpleSettlementPlan = normalizedPlanId === 'plan3'
      || normalizedPlanId === 'plan3_5'
      || normalizedPlanId === 'plan3_6';
    if (normalizedPlanId === 'plan5') {
      const circuit = this.checkPlan5LiveLossCircuit();
      if (!circuit.allowed) {
        throw new Error(circuit.reason || 'Plan5 连亏熔断中。');
      }
    }
    const balanceCap = risk.cash > 0 ? risk.cash : liveMaxUsd;
    const totalExposureRoom = Math.max(0, risk.maxTotalOpenExposureUsd - risk.totalOpenExposureUsd);
    const timeframeExposureRoom = Math.max(0, risk.maxTimeframeOpenExposureUsd - risk.timeframeOpenExposureUsd);
    const plan5CashPct = Number(plan.action?.cashPct)
      || Number(this.config.plan5StrongCashPct)
      || 0.30;
    const planSingleOrderCap = normalizedPlanId === 'plan3'
      ? risk.equity * (Number(this.config.plan3LiveMaxOrderEquityPct) || Number(this.config.plan3MaxOrderPct) || 0.10)
      : normalizedPlanId === 'plan3_5'
        ? risk.equity * (Number(this.config.plan3_5SizePct) || 0.20)
      : normalizedPlanId === 'plan3_6'
        ? (Number(this.config.plan3_6OrderUsd) || 5)
        : normalizedPlanId === 'plan5'
          // 单笔上限用强档现金比例天花板；勿用 action.cashPct（那是本笔意图仓位，
          // 否则 $5 意图单会被当成 hardCap，高价时无法上浮到 CLOB 最小份数金额）。
          ? Math.min(
            liveMaxUsd,
            risk.cash > 0
              ? risk.cash * Math.max(
                Number(this.config.plan5StrongCashPct) || 0.15,
                Number(this.config.plan5NormalCashPct) || 0.10,
                Number(plan5CashPct) || 0
              )
              : liveMaxUsd
          )
          : risk.maxSingleOrderUsd;
    if (explicitUsd && requestedUsd > liveMaxUsd) {
      throw new Error(`实盘单笔上限 $${liveMaxUsd.toFixed(2)}，请求 $${requestedUsd.toFixed(2)} 超限。`);
    }
    const riskLossStreak = Number(risk.lossStreakWeighted) || Number(risk.lossStreak) || 0;
    // Plan3.x / Plan1(默认) / Plan11(默认) / Plan5(默认) 不走 4/5 连亏时间冷却。
    // PLAN2_STREAK_SIZING_ENABLED 只关阶梯仓位，不会关掉这条拦截。
    const appliesGlobalLossRecovery = this.appliesLiveGlobalLossRecovery(normalizedPlanId);
    const lossStreakScale = appliesGlobalLossRecovery
      ? (Number(risk.lossStreakScale) || 0)
      : 1;
    const entrySize = resolveEntrySizeScale({
      planId: normalizedPlanId,
      config: this.config,
      winStreak: Number(risk.winStreak) || 0,
      lossStreak: Number(risk.lossStreak) || 0,
      lossStreakScale,
      lossRecoveryMode: risk.lossRecoveryMode || 'normal',
      appliesGlobalLossRecovery
    });
    if (entrySize.blocked || (appliesGlobalLossRecovery && risk.lossStreakScale <= 0)) {
      const remainingMin = Math.max(1, Math.ceil((Number(risk.lossCooldownRemainingMs) || 0) / 60000));
      throw new Error(`连续亏损权重 ${formatLossStreak(riskLossStreak)}，风控冷却中，约 ${remainingMin} 分钟后恢复小仓。`);
    }
    const sizeScale = Number(entrySize.sizeScale) || 1;
    // 实盘最小单默认 $5：过小会买得进、卖时 invalid maker amount 死循环
    // Plan3.6 有意半仓（5–10¢ → $2.5），只保留 CLOB 物理最小份数约束
    const minOrderUsd = Math.max(5, Number(this.config.minOrderUsd) || 5);
    const tokenId = direction === 'up' ? sentiment.upTokenId : sentiment.downTokenId;
    const marketPrice = Number(direction === 'up' ? sentiment.upPrice : sentiment.downPrice);
    const actionLimit = Number(plan?.action?.limitPrice);
    // Plan3.6：用策略确认的热门侧限价，避免 sentiment mid/last 把草稿拉到廉价侧。
    const price = normalizedPlanId === 'plan3_6'
      && Number.isFinite(actionLimit)
      && actionLimit > 0
      && actionLimit < 1
      ? actionLimit
      : marketPrice;
    if (!tokenId || !Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error('Polymarket token price is not tradable right now.');
    }
    if (normalizedPlanId === 'plan3_6') {
      const favoriteMin = Number(this.config.plan3_6FavoriteMinPrice ?? 0.75);
      const liveMin = Number(this.config.plan3_6LiveMinPrice ?? favoriteMin);
      const floor = Math.max(
        0.50,
        Number.isFinite(favoriteMin) ? favoriteMin : 0.75,
        Number.isFinite(liveMin) ? liveMin : 0
      );
      if (price + 1e-9 < floor) {
        throw new Error(
          `Plan3.6 拒绝廉价侧：草稿价 ${(price * 100).toFixed(2)}¢ 低于热门侧硬下限 ${(floor * 100).toFixed(0)}¢。`
        );
      }
    }
    // 下单按 liveMinSharesBuffer（默认 6）留 FAK 部分成交余量；
    // 卖出判定仍用 resolveLiveMinTradeableShares（≈5）。
    const clobMinBudgetShares = Math.max(5, Number(this.config.liveMinSharesBuffer) || 6);
    const minClobUsd = Math.ceil(price * clobMinBudgetShares * 100) / 100;
    const adaptiveMinOrderUsd = (
      normalizedPlanId === 'plan3_6'
      || this.isPlan2FamilyPlan(normalizedPlanId)
    )
      ? minClobUsd
      : Math.max(minOrderUsd, minClobUsd);
    const adaptiveLiveCap = this.buildAdaptiveLiveOrderCap({
      planId: normalizedPlanId,
      symbol: plan.symbol || sentiment.symbol || 'BTC-USD',
      timeframe: plan.timeframe || sentiment.timeframe || '15m',
      entryType: plan.action?.entryType || null,
      entryPrice: price,
      equity: risk.equity,
      minOrderUsd: adaptiveMinOrderUsd,
      confidence: plan.action?.confidence ?? plan.action?.modelConfidence,
      edge: plan.action?.edge ?? plan.action?.modelEdge ?? plan.action?.expectedValueGate?.netEdge,
      qualityScore: sentiment.qualityScore ?? plan.action?.signalQuality?.score
    });
    const singleOrderCap = Math.min(
      liveMaxUsd,
      planSingleOrderCap || liveMaxUsd,
      adaptiveLiveCap?.capUsd ?? liveMaxUsd
    );
    const scaledRequestedUsd = requestedUsd * sizeScale;
    if (appliesGlobalLossRecovery && risk.lossRecoveryMode === 'recovery' && riskLossStreak >= 5) {
      const minRecoveryConfidence = Number(this.config.lossStreakRecoveryMinConfidence) || 0.65;
      const minRecoveryEdge = Number(this.config.lossStreakRecoveryMinEdge) || 0.08;
      const actionConfidence = Number(plan.action?.confidence);
      const actionEdge = Number(plan.action?.edge);
      if (!Number.isFinite(actionConfidence) || actionConfidence < minRecoveryConfidence) {
        throw new Error(
          `连续亏损权重 ${formatLossStreak(riskLossStreak)} 后处于恢复模式，要求置信度 ≥ ${(minRecoveryConfidence * 100).toFixed(0)}%，当前 ${Number.isFinite(actionConfidence) ? (actionConfidence * 100).toFixed(0) : '--'}%。`
        );
      }
      if (!Number.isFinite(actionEdge) || actionEdge < minRecoveryEdge) {
        throw new Error(
          `连续亏损权重 ${formatLossStreak(riskLossStreak)} 后处于恢复模式，要求 edge ≥ ${(minRecoveryEdge * 100).toFixed(0)}%，当前 ${Number.isFinite(actionEdge) ? (actionEdge * 100).toFixed(1) : '--'}%。`
        );
      }
      if (scaledRequestedUsd < minClobUsd) {
        throw new Error(
          `连续亏损权重 ${formatLossStreak(riskLossStreak)} 后处于恢复模式，缩放后金额 $${Math.max(0, scaledRequestedUsd).toFixed(2)} 低于 CLOB 最小约 $${minClobUsd.toFixed(2)}，跳过小仓噪声单。`
        );
      }
    }
    // Plan3.x 结算策略 / Plan11 对齐纸面：只受单笔上限与可用余额约束，不受全局敞口 room 误拦多币同窗。
    let hardCap = isSimpleSettlementPlan || normalizedPlanId === PLAN11_ID
      ? Math.min(liveMaxUsd, singleOrderCap, balanceCap)
      : normalizedPlanId === 'plan5'
        ? Math.min(singleOrderCap, balanceCap)
        : Math.min(singleOrderCap, totalExposureRoom, timeframeExposureRoom, balanceCap);
    if (normalizedPlanId === PLAN11_ID) {
      const plan11Max = Number(this.config.plan11LiveMaxOrderUsd);
      if (Number.isFinite(plan11Max) && plan11Max > 0) {
        hardCap = Math.min(hardCap, plan11Max);
      }
    }
    const timeframe = plan.timeframe || sentiment.timeframe || '15m';
    let liveFloorUsd = resolveUnifiedEntryFloorUsd({
      config: this.config,
      planId: normalizedPlanId,
      timeframe,
      price
    });
    // Plan1/5 / Plan2.x / Plan3.x：CLOB 物理底可能略高于意向/风控 hardCap；余额够时上浮到可下单，
    // 避免「intent $5 < CLOB $5.40」或「room $3.44 < CLOB $4.30」互掐死窗。
    const allowsClobMinTopUp = normalizedPlanId === 'plan1'
      || normalizedPlanId === 'plan5'
      || normalizedPlanId === PLAN11_ID
      || this.isPlan2FamilyPlan(normalizedPlanId)
      || isSimpleSettlementPlan;
    const clobMinTopUpSlack = Number(this.config.liveClobMinTopUpSlackUsd);
    const topUpSlackUsd = Number.isFinite(clobMinTopUpSlack)
      ? Math.max(0, clobMinTopUpSlack)
      : (allowsClobMinTopUp ? 6 : 2);
    const physicalMinClobUsd = Math.ceil(price * 5 * 100) / 100;
    const plan1ExecutableFloor = Number.isFinite(Number(this.config.plan1LiveExecutableFloorUsd))
      ? Math.max(0, Number(this.config.plan1LiveExecutableFloorUsd))
      : PLAN1_LIVE_EXECUTABLE_FLOOR_USD;
    if (
      (normalizedPlanId === 'plan1' || this.isPlan2FamilyPlan(normalizedPlanId))
      && hardCap + 0.005 < liveFloorUsd
      && hardCap + 0.005 >= physicalMinClobUsd
      // Plan1：禁止把 floor 降到 <$2.5 灰尘区（廉价侧 5 份≈$1 会超时/卖不出）
      && (
        normalizedPlanId !== 'plan1'
        || physicalMinClobUsd + 0.005 >= plan1ExecutableFloor
      )
    ) {
      liveFloorUsd = physicalMinClobUsd;
    }
    if (
      allowsClobMinTopUp
      && liveFloorUsd > hardCap + 0.005
      && liveFloorUsd - hardCap <= topUpSlackUsd + 1e-9
      && balanceCap + 0.005 >= liveFloorUsd
      && liveMaxUsd + 0.005 >= liveFloorUsd
    ) {
      hardCap = liveFloorUsd;
    }
    const hardCapBelowFloorReason = () => formatLiveHardCapBelowFloorReason({
      hardCap,
      liveFloorUsd,
      requestedUsd: scaledRequestedUsd,
      cash: risk.cash,
      singleOrderCap,
      totalExposureRoom,
      timeframeExposureRoom,
      timeframe,
      maxSingleOrderUsd: risk.maxSingleOrderUsd,
      maxTotalOpenExposureUsd: risk.maxTotalOpenExposureUsd,
      maxTimeframeOpenExposureUsd: risk.maxTimeframeOpenExposureUsd,
      totalOpenExposureUsd: risk.totalOpenExposureUsd,
      timeframeOpenExposureUsd: risk.timeframeOpenExposureUsd
    });
    let cappedUsd = Math.min(scaledRequestedUsd, hardCap);
    // Undersized dust top-up: bump to at least CLOB min so the combine fill is sellable.
    const dustParent = this.findLiveDustTopUpParent({
      planId: normalizedPlanId,
      planKey: plan.action?.executionKey || plan.key || null,
      symbol: plan.symbol || sentiment.symbol || null,
      timeframe,
      slotIso: plan.slotIso || plan.action?.slotIso || null
    });
    if (dustParent) {
      const parentShares = Number(dustParent.remainingShares ?? dustParent.shares) || 0;
      const needShares = Math.max(0, clobMinBudgetShares - parentShares);
      // Deficit-only floor. Skip bump when another full CLOB-min order would be required.
      if (needShares > 0 && needShares + 1e-9 >= clobMinBudgetShares) {
        const topUpFloor = Math.ceil(needShares * price * 100) / 100;
        if (hardCap + 0.005 >= topUpFloor) {
          cappedUsd = Math.max(cappedUsd, topUpFloor);
        }
      }
    }
    // Risk caps are calculated from percentages and can land a fraction of a
    // cent below an exact CLOB minimum (for example 4.999999 vs 5.00).
    // Orders settle in cents, so treat a sub-half-cent difference as equal.
    const hardCapCanFundFloor = hardCap + 0.005 >= liveFloorUsd;
    const streakBelowMinMode = entrySize.streak?.belowMinMode || risk.streakSizingBelowMinMode || 'clamp';
    let sizeFloorBumpNote = null;
    if (cappedUsd < liveFloorUsd) {
      if (!hardCapCanFundFloor) {
        throw new Error(hardCapBelowFloorReason());
      }
      // streak 缩仓后低于最小单：skip=跳过；clamp=卡在 min（默认，与旧行为一致）
      if (
        entrySize.streak?.enabled
        && streakBelowMinMode === 'skip'
        && scaledRequestedUsd + 0.005 < liveFloorUsd
      ) {
        throw new Error(
          `连${(Number(risk.lossStreak) || 0) > 0 ? '亏' : '赢'} streak×${sizeScale.toFixed(2)} 后 $${Math.max(0, scaledRequestedUsd).toFixed(2)} 低于 CLOB 最小约 $${liveFloorUsd.toFixed(2)}，跳过。`
        );
      }
      // Plan1 等：Kelly/本金比例意向常 <$2，但余额与敞口够最小单时抬到 floor 成交，避免全信号被「灰尘单」误杀。
      sizeFloorBumpNote = (
        `本金比例算出 $${Math.max(0, scaledRequestedUsd).toFixed(2)}，`
        + `已抬到 CLOB/可执行最小 $${liveFloorUsd.toFixed(2)}`
      );
      cappedUsd = liveFloorUsd;
    }

    let normalized = normalizeClobBuyAmounts(price, cappedUsd, { tickSize: '0.01', marketOrder: true });
    const requiredShares = clobMinBudgetShares;
    if (normalized.shares < requiredShares || normalized.usd < liveFloorUsd - 0.01) {
      if (!hardCapCanFundFloor) {
        throw new Error(hardCapBelowFloorReason());
      }
      normalized = normalizeClobBuyAmounts(price, liveFloorUsd, { tickSize: '0.01', marketOrder: true });
    }
    const usesTotalOnlyExposure = this.config.globalExposureMode === 'total_only';
    const usesLayeredExposure = !isSimpleSettlementPlan
      && normalizedPlanId !== 'plan5';
    if (this.config.globalExposureCapEnabled === true && (usesTotalOnlyExposure || usesLayeredExposure)) {
      const globalExposure = this.checkGlobalExposure({
        timeframe,
        slotIso: plan.slotIso || plan.action?.slotIso,
        direction,
        newOrderUsd: normalized.usd,
        equity: risk.equity,
        clobBalanceUsdc,
        source: 'live'
      });
      if (!globalExposure.allowed) {
        throw new Error(globalExposure.reason);
      }
    }
    return {
      planId: normalizedPlanId,
      algorithm: plan.algorithm || plan.planId || planId,
      symbol: plan.symbol || sentiment.symbol || 'BTC-USD',
      timeframe,
      direction,
      outcome: direction === 'up' ? 'UP' : 'DOWN',
      market: sentiment.market,
      marketSlug: sentiment.marketSlug,
      conditionId: sentiment.conditionId,
      tokenId,
      orderType: 'BUY',
      limitPrice: normalized.limitPrice,
      usd: normalized.usd,
      shares: normalized.shares,
      requestedUsd: round2(requestedUsd),
      liveMaxOrderUsd: round2(liveMaxUsd),
      sizeFloorBumpNote,
      liveRisk: {
        principal: round2(risk.equity),
        cash: round2(risk.cash),
        openExposureUsd: round2(risk.totalOpenExposureUsd),
        timeframeOpenExposureUsd: round2(risk.timeframeOpenExposureUsd),
        maxSingleOrderUsd: round2(singleOrderCap),
        adaptiveCap: adaptiveLiveCap ? {
          capUsd: round2(adaptiveLiveCap.capUsd),
          equityPct: adaptiveLiveCap.equityPct,
          scope: adaptiveLiveCap.scope,
          liveSamples: adaptiveLiveCap.liveSamples,
          paperSamples: adaptiveLiveCap.paperSamples,
          effectiveSamples: adaptiveLiveCap.samples,
          rawWinRate: adaptiveLiveCap.rawWinRate,
          calibratedWinRate: adaptiveLiveCap.calibratedWinRate,
          breakEvenWinRate: adaptiveLiveCap.breakEvenWinRate,
          realizedRoi: adaptiveLiveCap.realizedRoi,
          pnlUsd: round2(adaptiveLiveCap.pnlUsd),
          dataFactor: adaptiveLiveCap.dataFactor,
          signalFactor: adaptiveLiveCap.signalFactor
        } : null,
        maxTotalOpenExposureUsd: round2(risk.maxTotalOpenExposureUsd),
        maxTimeframeOpenExposureUsd: round2(risk.maxTimeframeOpenExposureUsd),
        lossStreak: risk.lossStreak,
        lossStreakWeighted: risk.lossStreakWeighted,
        winStreak: risk.winStreak,
        lossStreakScale: risk.lossStreakScale,
        lossCooldownUntilIso: risk.lossCooldownUntilIso,
        lossCooldownRemainingMs: risk.lossCooldownRemainingMs,
        lossRecoveryMode: risk.lossRecoveryMode,
        streakSizingEnabled: entrySize.streak?.enabled === true,
        streakSizingScale: round4(sizeScale),
        streakSizingMode: entrySize.streak?.mode || risk.streakSizingMode || 'flat',
        streakSizingLevels: entrySize.streak?.levels ?? risk.streakSizingLevels ?? 0
      },
      targetTimeIso: plan.targetTimeIso || sentiment.targetTimeIso || null,
      slotIso: plan.slotIso || sentiment.schedule?.currentSlotIso || null,
      startPrice: Number(plan.action?.startPrice) || null,
      qualityScore: Number(sentiment.qualityScore) || null,
      qualityLabel: sentiment.qualityLabel || null,
      recommendation: recommendation || null,
      planKey: plan.key || null,
      planReason: plan.action?.reason || null,
      confidence: Number(plan.action?.confidence) || null,
      entryType: plan.action?.entryType || null,
      entryTier: plan.action?.entryTier || null,
      lockStrength: plan.action?.lockStrength || plan.intervalPmLock?.strength || null,
      lockPmGap: Number(plan.action?.lockPmGap ?? plan.intervalPmLock?.pmGap) || null,
      lockUpProbability: Number(plan.action?.lockUpProbability ?? plan.intervalPmLock?.upProbability) || null,
      lockDownProbability: Number(plan.action?.lockDownProbability ?? plan.intervalPmLock?.downProbability) || null,
      lockedAtIso: plan.action?.lockedAtIso || plan.intervalPmLock?.lockedAtIso || null,
      lockOptimization: plan.action?.lockOptimization || plan.intervalPmLock?.optimization || null,
      directionRecheck: plan.action?.directionRecheck || null,
      signalDirection: plan.action?.signalDirection || null,
      technicalDirection: plan.action?.technicalDirection || null,
      spotDirection: plan.action?.spotDirection || null,
      signalQuality: plan.action?.signalQuality || null,
      expectedValueGate: plan.action?.expectedValueGate || null,
      marketAlignment: plan.action?.marketAlignment || null,
      consensusGate: plan.action?.consensusGate || null,
      entryTiming: plan.action?.entryTiming || null,
      entryPriceGate: plan.action?.entryPriceGate || null,
      historyWinRateGate: plan.action?.historyWinRateGate || null,
      winrateGuidanceGate: plan.action?.winrateGuidanceGate || null,
      lossReasonGate: plan.action?.lossReasonGate || null,
      basketAllocation: plan.action?.basketAllocation || null,
      maxLivePrice: normalizedPlanId !== 'plan5' && Number.isFinite(Number(plan.action?.maxLivePrice))
        ? Number(plan.action.maxLivePrice)
        : (normalizedPlanId === 'plan3_6'
          ? Number(this.config.plan3_6FavoriteMaxPrice ?? 0.85)
          : (normalizedPlanId === PLAN13_ID
            ? Number(this.config.plan13EntryMaxPrice ?? this.config.plan13EntryHardMaxPrice ?? 0.92)
          : (normalizedPlanId === 'plan2_6' && this.config.plan2_6LiveEntryMaxEnabled === true
            ? Number(
              this.config.plan2_6EntryMaxPrice
              ?? this.config.plan2_6EntryHardMaxPrice
              ?? 0.97
            )
            : null))),
      minLivePrice: Number.isFinite(Number(plan.action?.minLivePrice))
        ? Number(plan.action.minLivePrice)
        : (normalizedPlanId === 'plan3_6'
          ? Math.max(
            0.50,
            Number(this.config.plan3_6FavoriteMinPrice ?? 0.75),
            Number(this.config.plan3_6LiveMinPrice ?? this.config.plan3_6FavoriteMinPrice ?? 0.75)
          )
          : null),
      intendedLimitPrice: Number.isFinite(actionLimit) && actionLimit > 0 && actionLimit < 1
        ? actionLimit
        : (Number.isFinite(price) ? price : null),
      strategyVersion: plan.action?.strategyVersion || resolvePlan2StrategyVersion(normalizedPlanId),
      modelDirection: plan.action?.modelDirection || null,
      modelConfidence: plan.action?.modelConfidence ?? null,
      modelEdge: plan.action?.modelEdge ?? null,
      sizeMultiplier: plan.action?.sizeMultiplier ?? null,
      sizeBand: plan.action?.sizeBand ?? null,
      sizeScale: plan.action?.sizeScale ?? null,
      crossSymbolAligned: plan.action?.crossSymbolAligned ?? plan.directionEntry?.crossSymbolAligned ?? null,
      crossSymbolLeader: plan.action?.crossSymbolLeader || plan.directionEntry?.crossSymbolLeader || null,
      leaderLimitPrice: plan.action?.leaderLimitPrice ?? plan.directionEntry?.leaderLimitPrice ?? null,
      createdAtIso: new Date().toISOString(),
      ...(normalizedPlanId === 'plan3'
        ? this.buildPlan3OrderEntryAnalytics({ plan, sentiment, action: plan.action })
        : {})
    };
  }

  async createLiveOrder(input = {}) {
    if (input.planView) {
      const { submitLiveOrderFromPlan } = await import('./polymarketLiveOrder.js');
        return submitLiveOrderFromPlan({
          planView: input.planView,
          tradingService: this,
          config: this.config,
          usd: input.usd,
          knownClobBalanceUsdc: input.clobBalanceUsdc,
          readiness: input.readinessInput || null
        });
    }
    if (!input.draft) {
      throw new Error('缺少当前窗口计划或订单草稿。');
    }
    return submitPolymarketLiveOrder({
      config: this.config,
      draft: input.draft,
      knownClobBalanceUsdc: input.clobBalanceUsdc,
      tradingService: this
    });
  }

  async submitLiveSellOrder(input = {}) {
    return submitPolymarketLiveSellOrder(input);
  }

  buildLiveSellDraft(position, sellPrice, { preferGtcTakeProfit = false, liquidateAll = false } = {}) {
    const price = Number(sellPrice);
    const shares = Number(position?.remainingShares ?? position?.shares) || 0;
    if (!position?.tokenId) throw new Error('持仓缺少 tokenId。');
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error('卖单价格无效。');
    }
    if (!Number.isFinite(shares) || shares <= 0) {
      throw new Error('持仓份额无效。');
    }
    // 灰尘仓 / 本地强平：卖光剩余，避免 97% 比例再留出不可卖尾仓
    const sellRatio = liquidateAll || this.isLiveDustUnsellablePosition(position)
      ? 1
      : clampNumber(Number(this.config.liveSellShareRatio), 0.5, 1, 0.97);
    const sellShares = round4(shares * sellRatio);
    return {
      planId: position.planId,
      symbol: position.symbol || 'BTC-USD',
      timeframe: position.timeframe || '15m',
      direction: position.direction,
      outcome: position.outcome,
      tokenId: position.tokenId,
      orderType: 'SELL',
      limitPrice: round4(price),
      shares: sellShares,
      usd: round2(price * sellShares),
      slotIso: position.slotIso || null,
      targetTimeIso: position.targetTimeIso || null,
      relatedBuyOrderId: position.id || null,
      preferGtcTakeProfit: preferGtcTakeProfit === true,
      createdAtIso: new Date().toISOString()
    };
  }

  resolveLiveExitSellPlan(position, currentPrice, exitStatus = '') {
    const marketPrice = Number(currentPrice);
    const status = String(exitStatus || '').toLowerCase();
    const isStop = /stop|loss|reversal|flip/.test(status);
    const isTrailingTakeProfit = /trailing-take-profit/.test(status);
    const isTakeProfit = /profit|take/.test(status);
    const price = this.resolveLiveExitSellLimitPrice(position, marketPrice, exitStatus);
    const preferGtcTakeProfit = isTakeProfit
      && !isStop
      && !isTrailingTakeProfit
      && this.config.liveTakeProfitSellUseGtc !== false
      && this.shouldPreferGtcTakeProfitSell(position, marketPrice);
    return { price, preferGtcTakeProfit, preferGtcStop: false };
  }

  shouldPreferGtcTakeProfitSell(position, marketPrice) {
    const takeProfit = Number(position?.takeProfitPrice);
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) return false;
    return Number(marketPrice) >= takeProfit * 0.95;
  }

  resolveLiveExitSellLimitPrice(position, currentPrice, exitStatus = '') {
    const marketPrice = Number(currentPrice);
    if (!Number.isFinite(marketPrice) || marketPrice <= 0) return marketPrice;
    if (this.config.liveDynamicSellLimitEnabled === false) return round4(marketPrice);

    const status = String(exitStatus || '').toLowerCase();
    const timeframe = String(position?.timeframe || '').toLowerCase();
    const isStop = /stop|loss|reversal|flip/.test(status);
    const isTrailingTakeProfit = /trailing-take-profit/.test(status);
    const isTakeProfit = /profit|take/.test(status);
    const minPrice = clampNumber(Number(this.config.liveMinSellLimitPrice), 0.001, 0.25, 0.01);

    if (isTakeProfit && !isTrailingTakeProfit && this.config.liveTakeProfitSellUseGtc !== false) {
      const takeProfit = Number(position.takeProfitPrice);
      const gtcOffset = Number(this.config.liveTakeProfitGtcSellOffset) || 0.005;
      if (Number.isFinite(takeProfit) && takeProfit > 0) {
        const anchored = round4(Math.max(minPrice, takeProfit - gtcOffset));
        return round4(Math.max(minPrice, Math.min(anchored, marketPrice)));
      }
    }

    const stopOffset = timeframe === '5m'
      ? Number(this.config.liveStopSellOffset5m)
      : Number(this.config.liveStopSellOffset15m);
    let offset = 0;
    if (isStop) {
      offset = Number.isFinite(stopOffset) ? stopOffset : (timeframe === '5m' ? 0.03 : 0.02);
    } else if (isTakeProfit) {
      offset = Number(this.config.liveTakeProfitSellOffset) || 0.005;
    }

    const targetMs = Date.parse(position?.targetTimeIso || '');
    const remainingMs = Number.isFinite(targetMs) ? targetMs - Date.now() : Infinity;
    const urgentWindowMs = timeframe === '5m' ? 35_000 : 90_000;
    if (isStop && remainingMs <= urgentWindowMs) {
      offset += Number(this.config.liveUrgentSellExtraOffset) || 0.01;
    }

    return round4(clampNumber(marketPrice - offset, minPrice, 0.99, marketPrice));
  }

  shouldPrepostLivePlan1TakeProfit(position) {
    if (this.config.plan1HoldToSettlementEnabled === true) return false;
    if (this.config.plan1PrepostedTakeProfitEnabled === false) return false;
    if (this.normalizePlanId(position?.planId) !== 'plan1') return false;
    if (position?.orderSide === 'SELL' || position?.positionStatus !== 'open') return false;
    if (this.isLivePositionPending(position) || this.isLiveDustUnsellablePosition(position)) return false;
    const targetMs = Date.parse(position?.targetTimeIso || '');
    if (Number.isFinite(targetMs) && targetMs <= Date.now() + 15_000) return false;
    const takeProfit = Number(position?.takeProfitPrice);
    const entryPrice = Number(position?.entryPrice ?? position?.limitPrice);
    return Number.isFinite(takeProfit)
      && takeProfit > 0
      && takeProfit < 1
      && (!Number.isFinite(entryPrice) || takeProfit > entryPrice);
  }

  async createLiveClobClient() {
    const { createPolymarketClobClient } = await import('./polymarketLiveClob.js');
    return createPolymarketClobClient(this.config);
  }

  async placeLivePlan1TakeProfitOrder(position) {
    if (!this.shouldPrepostLivePlan1TakeProfit(position)) {
      return { placed: false, reason: 'not-eligible', position };
    }
    if (position.takeProfitOrderId) {
      return { placed: false, reason: 'already-posted', position };
    }
    const lastAttemptMs = Date.parse(position.takeProfitOrderLastAttemptAtIso || '');
    if (Number.isFinite(lastAttemptMs) && Date.now() - lastAttemptMs < 5000) {
      return { placed: false, reason: 'retry-cooldown', position };
    }

    position.takeProfitOrderLastAttemptAtIso = new Date().toISOString();
    const targetPrice = Number(position.takeProfitPrice);
    const draft = this.buildLiveSellDraft(position, targetPrice, {
      preferGtcTakeProfit: true,
      liquidateAll: true
    });
    try {
      const result = await this.submitLiveSellOrder({
        config: this.config,
        draft,
        position
      });
      if (!result?.clobOrderId) {
        throw new Error('止盈 GTC 已提交但未返回订单 ID。');
      }
      const executedDraft = result.draft || draft;
      position.takeProfitOrderId = result.clobOrderId;
      position.takeProfitOrderPrice = Number(executedDraft.limitPrice) || targetPrice;
      position.takeProfitOrderShares = Number(executedDraft.shares) || Number(draft.shares) || 0;
      position.takeProfitOrderMatchedShares = 0;
      position.takeProfitOrderStatus = result.filled ? 'matched' : (result.response?.status || 'live');
      position.takeProfitOrderPlacedAtIso = new Date().toISOString();
      position.takeProfitOrderError = null;
      position.takeProfitOrderResponse = result.response || null;

      if (result.filled) {
        const closed = await this.closeLivePosition(position, {
          sellPrice: position.takeProfitOrderPrice,
          exitStatus: 'take-profit',
          exitReason: `预挂止盈单立即成交 @${(position.takeProfitOrderPrice * 100).toFixed(1)}%`,
          preSubmittedResult: result,
          preSubmittedDraft: executedDraft,
          liquidateAll: true
        });
        position.takeProfitOrderMatchedShares = position.takeProfitOrderShares;
        position.takeProfitOrderStatus = 'filled';
        await this.persist('live');
        return { placed: true, filled: true, ...closed };
      }

      position.note = `${position.note || ''} · 已预挂止盈 GTC @${(position.takeProfitOrderPrice * 100).toFixed(1)}%`.trim();
      await this.persist('live');
      return { placed: true, filled: false, position, result, draft: executedDraft };
    } catch (error) {
      position.takeProfitOrderStatus = 'error';
      position.takeProfitOrderError = humanizeClobError(error, { shares: draft.shares });
      await this.persist('live');
      return { placed: false, reason: position.takeProfitOrderError, position, error };
    }
  }

  async reconcileLivePlan1TakeProfitOrder(position, remote) {
    if (!position?.takeProfitOrderId || !remote) {
      return { changed: false, closed: position?.positionStatus === 'closed', position };
    }
    const expectedShares = Number(position.takeProfitOrderShares)
      || Number(position.originalShares)
      || Number(position.shares)
      || 0;
    const progress = extractClobOpenOrderProgress(remote, expectedShares);
    const previouslyApplied = Number(position.takeProfitOrderMatchedShares) || 0;
    const matchedTotal = Math.max(previouslyApplied, progress.matchedShares);
    const availableShares = Number(position.remainingShares ?? position.shares) || 0;
    const matchedDelta = round4(Math.min(availableShares, Math.max(0, matchedTotal - previouslyApplied)));
    position.takeProfitOrderStatus = remote?.status || position.takeProfitOrderStatus || null;
    position.takeProfitOrderResponse = remote;
    position.takeProfitOrderLastSyncAtIso = new Date().toISOString();

    let accounting = null;
    if (matchedDelta > 0.0001 && position.positionStatus !== 'closed') {
      const fillPrice = Number(remote?.price) || Number(position.takeProfitOrderPrice) || Number(position.takeProfitPrice);
      const draft = {
        ...this.buildLiveSellDraft(position, fillPrice, {
          preferGtcTakeProfit: true,
          liquidateAll: true
        }),
        limitPrice: round4(fillPrice),
        shares: matchedDelta,
        usd: round2(matchedDelta * fillPrice)
      };
      const result = {
        draft,
        response: remote,
        clobOrderId: position.takeProfitOrderId,
        filled: true,
        orderType: 'GTC'
      };
      accounting = await this.closeLivePosition(position, {
        sellPrice: fillPrice,
        exitStatus: 'take-profit',
        exitReason: `预挂止盈 GTC 成交 ${matchedDelta.toFixed(4)} 份 @${(fillPrice * 100).toFixed(1)}%`,
        preSubmittedResult: result,
        preSubmittedDraft: draft,
        liquidateAll: matchedDelta >= availableShares - 0.0001
      });
      position.takeProfitOrderMatchedShares = round4(previouslyApplied + matchedDelta);
    }

    if (progress.filled || position.positionStatus === 'closed') {
      position.takeProfitOrderStatus = 'filled';
      position.takeProfitOrderFilledAtIso ||= new Date().toISOString();
    }
    await this.persist('live');
    return {
      changed: matchedDelta > 0.0001,
      closed: position.positionStatus === 'closed',
      position,
      progress,
      accounting,
      sellRecord: accounting?.sellRecord || null,
      result: accounting?.result || null,
      draft: accounting?.draft || null
    };
  }

  async cancelLivePlan1TakeProfitOrder(position, { client = null } = {}) {
    const orderId = position?.takeProfitOrderId;
    if (!orderId) return { cancelled: false, closed: position?.positionStatus === 'closed', position };
    const clob = client || await this.createLiveClobClient();
    let remote = null;
    try {
      remote = await clob.getOrder(orderId);
    } catch {
      // A cancel attempt below is authoritative even when the detail endpoint races a fill.
    }
    if (remote) {
      const reconciled = await this.reconcileLivePlan1TakeProfitOrder(position, remote);
      if (reconciled.closed) return { cancelled: false, ...reconciled };
      if (isClobOrderTerminal(remote)) {
        position.lastTakeProfitOrderId = orderId;
        position.takeProfitOrderId = null;
        position.takeProfitOrderStatus = remote.status || 'terminal';
        await this.persist('live');
        return { cancelled: false, closed: false, terminal: true, position };
      }
    }

    if (typeof clob.cancelOrder === 'function') {
      await clob.cancelOrder({ orderID: orderId });
    } else if (typeof clob.cancelOrders === 'function') {
      await clob.cancelOrders([orderId]);
    } else {
      throw new Error('CLOB 客户端不支持撤单，为避免重复卖出已阻止止损。');
    }

    try {
      const afterCancel = await clob.getOrder(orderId);
      const reconciled = await this.reconcileLivePlan1TakeProfitOrder(position, afterCancel);
      if (reconciled.closed) return { cancelled: true, ...reconciled };
    } catch {
      // Cancelled orders may disappear from the open-order endpoint immediately.
    }
    position.lastTakeProfitOrderId = orderId;
    position.takeProfitOrderId = null;
    position.takeProfitOrderStatus = 'cancelled';
    position.takeProfitOrderCancelledAtIso = new Date().toISOString();
    await this.persist('live');
    return { cancelled: true, closed: false, position };
  }

  async syncLivePlan1TakeProfitOrders() {
    const positions = this.getOpenLivePositions('plan1')
      .filter((position) => !this.isLivePositionPending(position));
    if (!positions.length || this.config.plan1PrepostedTakeProfitEnabled === false) return [];
    let client = null;
    const changed = [];
    for (const position of positions) {
      try {
        if (!position.takeProfitOrderId) {
          const placed = await this.placeLivePlan1TakeProfitOrder(position);
          if (placed.placed) changed.push(placed);
          continue;
        }
        client ||= await this.createLiveClobClient();
        const remote = await client.getOrder(position.takeProfitOrderId);
        const reconciled = await this.reconcileLivePlan1TakeProfitOrder(position, remote);
        if (reconciled.changed || reconciled.closed) changed.push(reconciled);
        if (!reconciled.closed && isClobOrderTerminal(remote)) {
          position.lastTakeProfitOrderId = position.takeProfitOrderId;
          position.takeProfitOrderId = null;
          await this.persist('live');
        }
      } catch (error) {
        position.takeProfitOrderError = humanizeClobError(error, {
          shares: Number(position.remainingShares ?? position.shares) || 0
        });
        position.takeProfitOrderLastSyncAtIso = new Date().toISOString();
        await this.persist('live');
      }
    }
    return changed;
  }

  async syncLivePendingSells() {
    const pending = (this.state.liveOrders || []).filter((order) => (
      order.orderSide === 'SELL'
      && order.positionStatus === 'open'
      && order.clobOrderId
    ));
    if (!pending.length) return [];
    let client;
    try {
      client = await this.createLiveClobClient();
    } catch {
      return [];
    }
    const changed = [];
    for (const order of pending) {
      const parent = (this.state.liveOrders || []).find((item) => item.id === order.relatedBuyOrderId);
      const targetMs = Date.parse(order.targetTimeIso || '');
      const createdMs = Date.parse(order.createdAtIso || '');
      const orphanExpired = !parent && (
        (Number.isFinite(targetMs) && targetMs < Date.now() - 15_000)
        || (Number.isFinite(createdMs) && createdMs < Date.now() - 30 * 60 * 1000)
      );
      try {
        const remote = await client.getOrder(order.clobOrderId);
        order.clobStatus = remote?.status || order.clobStatus;
        order.clobResponse = remote;
        if (parent?.positionStatus === 'closed' || orphanExpired || isClobOrderTerminal(remote)) {
          if ((parent?.positionStatus === 'closed' || orphanExpired) && !isClobOrderTerminal(remote)) {
            if (typeof client.cancelOrder === 'function') {
              await client.cancelOrder({ orderID: order.clobOrderId });
            }
            else if (typeof client.cancelOrders === 'function') await client.cancelOrders([order.clobOrderId]);
            order.clobStatus = 'cancelled';
          }
          order.positionStatus = 'closed';
          order.note = `${order.note || ''} · 远端卖单状态已同步`.trim();
          changed.push(order);
        }
      } catch {
        if (parent?.positionStatus === 'closed' || orphanExpired) {
          order.positionStatus = 'closed';
          order.note = `${order.note || ''} · 父持仓已关闭或记录已过期，清理历史卖单记录`.trim();
          changed.push(order);
        }
      }
    }
    if (changed.length) await this.persist('live');
    return changed;
  }

  evaluateLiveExitTrigger(position, currentPrice, {
    takeProfitOffset = null,
    stopLossOffset = null,
    timeStopRemainingPct = null,
    elapsedPct = null,
    currentAction = null,
    fiveMinuteLock = null,
    fiveMinuteLockStats = null
  } = {}) {
    if (position?.planId === 'plan1' && this.config.plan1HoldToSettlementEnabled === true) return null;
    if (this.normalizePlanId(position?.planId) === PLAN11_ID) {
      if (!isPlan11StopLossEnabled(this.config)) return null;
      const entryPrice = Number(position.entryPrice ?? position.limitPrice);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
      const price = Number(currentPrice);
      if (!Number.isFinite(price)) return null;
      const slOffset = Number(this.config.plan11StopLossOffset) || 0.10;
      const computed = computePlan11ExitPrices(entryPrice, this.config);
      const stopLoss = Number(position.stopLossPrice ?? computed.stopLossPrice ?? (entryPrice - slOffset));
      if (Number.isFinite(stopLoss) && price <= stopLoss) {
        return {
          exitPrice: price,
          exitStatus: 'stop-loss',
          exitReason: `Plan11 硬止损：价 ${(price * 100).toFixed(1)}% <= SL ${(stopLoss * 100).toFixed(0)}%`
        };
      }
      return null;
    }
    if (isPlan2HoldToExpiryEntryType(position)) return null;
    const entryPrice = Number(position.entryPrice ?? position.limitPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
    const price = Number(currentPrice);
    if (!Number.isFinite(price)) return null;

    const tpOffset = takeProfitOffset ?? (
      this.isPlan2FamilyPlan(position.planId)
        ? Number(this.config.plan2TakeProfitOffset) || 0.18
        : null
    );
    const slOffset = stopLossOffset ?? (
      this.isPlan2FamilyPlan(position.planId)
        ? this.resolvePlan2StopLossOffset(position)
        : null
    );
    const exits = this.isPlan2FamilyPlan(position.planId)
      ? computeDynamicExitPrices(entryPrice, {
        takeProfitOffset: tpOffset,
        stopLossOffset: slOffset,
        absoluteStopLossFloor: resolveStopLossAbsoluteFloor(this.config)
      })
      : computePlan1ExitPrices(entryPrice, this.config);
    const takeProfit = Number(position.takeProfitPrice ?? exits.takeProfitPrice);
    const stopLoss = Number(position.stopLossPrice ?? exits.stopLossPrice);
    const plan2StopLossDisabled = this.isPlan2FamilyPlan(position?.planId)
      && !this.isPlan2LiveHardStopLossEnabled(position.planId);
    const plan2TakeProfitDisabled = this.isPlan2FamilyPlan(position?.planId)
      && !this.isPlan2TakeProfitEnabled(position.planId);
    const paperExitSyncHold = this.isPlan2FamilyPlan(position?.planId)
      && !this.isPlan2LiveEarlyExitEnabled(position.planId);

    // LIVE_SYNC_PAPER_EXIT: suppress TP/dynamic, but hard SL still fires (wallet protection).
    if (paperExitSyncHold) {
      if (!plan2StopLossDisabled && Number.isFinite(stopLoss) && price <= stopLoss) {
        return {
          exitPrice: price,
          exitStatus: 'stop-loss',
          exitReason: `price ${(price * 100).toFixed(1)}% <= SL ${(stopLoss * 100).toFixed(0)}% (live hard SL; paper sync does not disable)`
        };
      }
      return null;
    }

    const trailingEnabled = this.isPlan2FamilyPlan(position?.planId)
      && this.isPlan2TrailingTakeProfitEnabled(position.planId);
    const trailing = trailingEnabled ? this.applyPlan2TrailingPeak(position, price) : { changed: false, trail: null };

    const dynamicExit = this.evaluatePlan2DynamicExit(position, {
      price,
      entryPrice,
      takeProfit,
      stopLoss,
      currentAction,
      fiveMinuteLock,
      fiveMinuteLockStats
    });
    const dynamicExitIsStop = /stop|loss|reversal|flip/.test(String(dynamicExit?.exit?.exitStatus || '').toLowerCase());
    const dynamicExitIsTakeProfit = /take-profit|profit/.test(String(dynamicExit?.exit?.exitStatus || '').toLowerCase());
    if (dynamicExit?.exit
      && !(plan2StopLossDisabled && dynamicExitIsStop)
      && !(plan2TakeProfitDisabled && dynamicExitIsTakeProfit)
      && !(trailingEnabled && dynamicExitIsTakeProfit)) {
      return dynamicExit.exit;
    }
    if (dynamicExit?.hold && !trailingEnabled) return null;

    if (!plan2StopLossDisabled && Number.isFinite(stopLoss) && price <= stopLoss) {
      return {
        exitPrice: price,
        exitStatus: 'stop-loss',
        exitReason: `price ${(price * 100).toFixed(1)}% <= SL ${(stopLoss * 100).toFixed(0)}%`
      };
    }
    if (trailingEnabled && trailing.trail?.exit) {
      return trailing.trail.exit;
    }
    if (!trailingEnabled && !plan2TakeProfitDisabled && Number.isFinite(takeProfit) && price >= takeProfit) {
      return {
        exitPrice: price,
        exitStatus: 'take-profit',
        exitReason: `price ${(price * 100).toFixed(1)}% >= TP ${(takeProfit * 100).toFixed(0)}%`
      };
    }

    const remainingPct = timeStopRemainingPct ?? (Number(this.config.plan1TimeStopRemainingPct) || 0.25);
    if (
      position.planId === 'plan1'
      && Number.isFinite(elapsedPct)
      && elapsedPct >= 1 - remainingPct
      && price < entryPrice
    ) {
      return {
        exitPrice: price,
        exitStatus: 'time-stop',
        exitReason: `窗口剩余 < ${(remainingPct * 100).toFixed(0)}% 且价 ${(price * 100).toFixed(1)}% < 入场 ${(entryPrice * 100).toFixed(1)}%`
      };
    }
    return null;
  }

  evaluatePlan2DynamicExit(position, {
    price,
    entryPrice,
    takeProfit,
    stopLoss,
    currentAction = null,
    fiveMinuteLock = null,
    fiveMinuteLockStats = null
  } = {}) {
    if (isPlan2HoldToExpiryEntryType(position)) return null;
    if (position?.planId !== 'plan2' || this.config.plan2DynamicExitEnabled === false) return null;
    // 与模拟盘对齐：只用固定 TP/SL，不做 5m 锁动态持有/反转止损。
    if (this.isPlan2ExitSyncedToPaper(position?.planId || 'plan2')) return null;

    const isProbe = String(position?.entryType || '').toLowerCase() === 'probe';
    const heldDirection = String(position.direction || '').toLowerCase();
    let actionDirection;
    let confidence;

    if (currentAction?.shouldTrade === true) {
      actionDirection = String(currentAction.direction || '').toLowerCase();
      confidence = Number(currentAction.confidence);
    } else if (isProbe) {
      actionDirection = heldDirection;
      confidence = Number(position.confidence);
      if (!Number.isFinite(confidence)) return null;
    } else {
      return null;
    }

    if (!['up', 'down'].includes(heldDirection) || !['up', 'down'].includes(actionDirection) || !Number.isFinite(confidence)) {
      return null;
    }

    const lockThresholds = resolvePlan2ExitLockThresholds({
      positionDirection: heldDirection,
      fiveMinuteLock,
      fiveMinuteLockStats,
      config: this.config,
      isProbe
    });
    const reverseConfidence = lockThresholds.reverseConfidence;
    const holdConfidence = lockThresholds.holdConfidence;
    const weakConfidence = lockThresholds.weakConfidence;
    const lockNote = lockThresholds.lockNote ? `（${lockThresholds.lockNote}）` : '';
    const effectiveLockConfidence = Number.isFinite(lockThresholds.effectiveConfidence)
      ? lockThresholds.effectiveConfidence
      : null;
    const sameDirection = actionDirection === heldDirection;
    const lockConflicts = fiveMinuteLock?.direction && fiveMinuteLock.direction !== heldDirection;
    let judgmentConfidence = confidence;
    if (sameDirection && Number.isFinite(effectiveLockConfidence)) {
      judgmentConfidence = Math.max(confidence, effectiveLockConfidence);
    } else if (!sameDirection && lockConflicts && actionDirection === fiveMinuteLock.direction && Number.isFinite(effectiveLockConfidence)) {
      judgmentConfidence = Math.max(confidence, effectiveLockConfidence);
    }

    if (!sameDirection && judgmentConfidence >= reverseConfidence) {
      return {
        exit: {
          exitPrice: price,
          exitStatus: 'direction-reversal-stop',
          exitReason: `方向反转到 ${actionDirection.toUpperCase()}，置信 ${(judgmentConfidence * 100).toFixed(0)}% >= ${(reverseConfidence * 100).toFixed(0)}%${lockNote}`
        }
      };
    }

    if (sameDirection && judgmentConfidence >= holdConfidence) {
      if (Number.isFinite(takeProfit) && price >= takeProfit) {
        return { hold: true, reason: `已盈利但同向置信 ${(judgmentConfidence * 100).toFixed(0)}%，继续持有${lockNote}` };
      }
    }

    if (Number.isFinite(takeProfit) && price >= takeProfit && (!sameDirection || judgmentConfidence < weakConfidence)) {
      return {
        exit: {
          exitPrice: price,
          exitStatus: 'dynamic-take-profit',
          exitReason: `已达 TP ${(takeProfit * 100).toFixed(0)}%，当前方向 ${actionDirection.toUpperCase()} 置信 ${(judgmentConfidence * 100).toFixed(0)}%，锁定利润${lockNote}`
        }
      };
    }

    if (Number.isFinite(stopLoss) && price <= stopLoss) {
      return {
        exit: {
          exitPrice: price,
          exitStatus: 'stop-loss',
          exitReason: `价格 ${(price * 100).toFixed(1)}% <= SL ${(stopLoss * 100).toFixed(0)}%，及时止损`
        }
      };
    }

    return null;
  }

  evaluateLivePlan1DirectionFlip({
    plan,
    sentiment = null,
    currentPrice = null,
    now = new Date()
  }) {
    if (this.config.plan1HoldToSettlementEnabled === true) {
      return { flip: false, openPosition: null, reason: 'Plan1 configured to hold until settlement' };
    }
    const openPosition = this.getOpenLivePositionForWindow({
      planId: 'plan1',
      timeframe: plan?.timeframe,
      slotIso: plan?.slotIso,
      symbol: plan?.symbol
    });
    if (!openPosition || !plan?.action?.shouldTrade) {
      return { flip: false, openPosition, reason: openPosition ? 'plan skipped' : 'no open position' };
    }
    const windowKey = `${plan.timeframe}_${plan.slotIso}_${plan.symbol || 'BTC-USD'}`;
    const lastFlipAtMs = this.state.liveAuto?.lastFlipAt?.[windowKey] || null;
    const entryPrice = Number(openPosition.entryPrice ?? openPosition.limitPrice) || 0;
    const price = Number.isFinite(Number(currentPrice))
      ? Number(currentPrice)
      : Number(sentiment?.[openPosition.direction === 'up' ? 'upPrice' : 'downPrice']) || entryPrice;
    const newDirectionPrice = Number(plan.action.direction === 'up'
      ? sentiment?.upPrice
      : sentiment?.downPrice) || price;
    const floatingLossPct = entryPrice > 0 ? (price - entryPrice) / entryPrice : null;
    const elapsedPct = Number.isFinite(Number(plan.elapsedPct))
      ? Number(plan.elapsedPct)
      : windowElapsedPct(getSlotSchedule(now, timeframeToSlotMinutes(plan.timeframe)));
    return {
      ...shouldPlan1DirectionFlip({
        openDirection: openPosition.direction,
        newDirection: plan.action.direction,
        config: this.config,
        timeframe: plan.timeframe || '15m',
        openOrderCreatedAtIso: openPosition.createdAtIso,
        lastFlipAtMs,
        newConfidence: plan.action.edgeConfidence ?? plan.action.confidence,
        reverseEdge: computeTradeEdge(plan.action.edgeConfidence ?? plan.action.confidence, newDirectionPrice),
        floatingLossPct,
        elapsedPct,
        now
      }),
      openPosition,
      windowKey
    };
  }

  async closeLivePosition(position, {
    sellPrice,
    exitStatus,
    exitReason,
    closedOnly = false,
    readinessReady = true,
    skipClob = false,
    liquidateAll = false,
    preSubmittedResult = null,
    preSubmittedDraft = null,
    clobClient = null
  } = {}) {
    if (!position || position.positionStatus === 'closed' || position.orderSide === 'SELL') {
      throw new Error('只能平仓未关闭的实盘持仓。');
    }
    const accountingOnly = Boolean(preSubmittedResult);
    if (!accountingOnly && !this.config.liveTradingEnabled) {
      throw new Error('实盘下单开关未开启。');
    }
    if (!accountingOnly && !readinessReady && !closedOnly) {
      throw new Error('实盘 API 未就绪。');
    }

    if (!accountingOnly && position.takeProfitOrderId) {
      if (/profit|take/i.test(String(exitStatus || ''))) {
        return {
          position,
          sellRecord: null,
          result: null,
          draft: null,
          pending: true,
          existingTakeProfit: true
        };
      }
      const cancelled = await this.cancelLivePlan1TakeProfitOrder(position, { client: clobClient });
      if (cancelled.closed || position.positionStatus === 'closed') {
        return {
          position,
          sellRecord: cancelled.sellRecord || null,
          result: cancelled.result || null,
          draft: cancelled.draft || null,
          pending: false,
          alreadyClosed: true
        };
      }
    }

    // 尾仓低于 CLOB 下单门槛：禁止提交无效卖单，但必须保留真实持仓与余额。
    const forceLiquidate = liquidateAll || this.isLiveDustUnsellablePosition(position);
    if (!skipClob && this.isLiveDustUnsellablePosition(position)) {
      const trigger = exitStatus && !isDustExitStatus(exitStatus) ? String(exitStatus) : null;
      return this.holdLiveDustPosition(position, {
        exitReason: trigger
          ? `小额持仓低于 CLOB 卖出门槛（忽略中途触发 ${trigger}，继续真实持有）`
          : (exitReason || '剩余份额低于 CLOB 可卖最小量，继续真实持有')
      });
    }

    let price = Number(sellPrice);
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      price = Number(position.limitPrice) || 0;
    }
    const marketSellPrice = price;
    const sellPlan = this.resolveLiveExitSellPlan(position, marketSellPrice, exitStatus);
    price = sellPlan.price;
    const draft = preSubmittedDraft || this.buildLiveSellDraft(position, price, {
      preferGtcTakeProfit: sellPlan.preferGtcTakeProfit,
      liquidateAll: forceLiquidate
    });
    let result = preSubmittedResult;
    if (!skipClob && !preSubmittedResult) {
      result = await this.submitLiveSellOrder({
        config: this.config,
        draft,
        position
      });
    }

    const executedDraft = result?.draft || draft;
    const sellFilled = skipClob || result?.filled !== false;
    if (!sellFilled) {
      const pendingRecord = await this.recordLiveOrder({
        status: 'submitted',
        orderSide: 'SELL',
        positionStatus: 'open',
        symbol: position.symbol,
        timeframe: position.timeframe,
        planId: position.planId,
        planKey: position.planKey,
        slotIso: position.slotIso,
        direction: position.direction,
        outcome: position.outcome,
        usd: executedDraft.usd,
        shares: executedDraft.shares,
        limitPrice: executedDraft.limitPrice,
        entryPrice: position.entryPrice ?? position.limitPrice,
        tokenId: position.tokenId,
        market: position.market,
        marketSlug: position.marketSlug,
        targetTimeIso: position.targetTimeIso,
        relatedBuyOrderId: position.id,
        exitStatus: exitStatus || 'manual-exit',
        exitPrice: round4(price),
        exitReason: exitReason || `${exitStatus || 'exit'} at ${(price * 100).toFixed(1)}%`,
        clobOrderId: result?.clobOrderId || null,
        clobStatus: result?.response?.status,
        clobSuccess: result?.response?.success,
        clobResponse: result?.response,
        note: `Live sell ${position.timeframe} ${position.planId} ${exitStatus || 'exit'} pending fill.`
      });
      await this.persist('live');
      return { position, sellRecord: pendingRecord, result, draft: executedDraft, pending: true };
    }

    const availableShares = Number(position.remainingShares ?? position.shares) || 0;
    const availableCost = Number(position.remainingCostUsd ?? position.usd) || 0;
    // "liquidateAll" controls requested size only. FAK may still partially fill,
    // so local accounting must always follow the actual normalized fill size.
    const soldShares = Math.min(availableShares, Number(executedDraft.shares) || 0);
    const proceeds = round2(
      Number(executedDraft.usd) || soldShares * price
    );
    const allocatedCost = availableShares > 0
      ? round2(Math.min(availableCost, availableCost * (soldShares / availableShares)))
      : 0;
    const legPnl = round2(proceeds - allocatedCost);
    let remainingShares = round4(Math.max(0, availableShares - soldShares));
    let remainingCost = round2(Math.max(0, availableCost - allocatedCost));
    const cumulativePnl = round2((Number(position.realizedPnlUsd) || 0) + legPnl);
    const cumulativeProceeds = round2((Number(position.realizedProceedsUsd) || 0) + proceeds);
    const minTradeable = this.resolveLiveMinTradeableShares();
    // 剩余低于可卖门槛或名义 <$1：视为结清，避免 97% 卖出后尾仓刷 invalid maker amount
    const leftoverIsDust = remainingShares > 0 && (
      remainingShares < minTradeable
      || remainingCost < 1
      || remainingShares <= Math.max(0.01, availableShares * 0.001)
    );
    if (leftoverIsDust) {
      position.dustResidualShares = remainingShares;
      position.dustResidualCostUsd = remainingCost;
      position.dustResidualRecordedAtIso = new Date().toISOString();
    }
    // A real partial sell does not erase an unsold remainder. Keep it open so
    // official settlement can account for the actual shares still held on PM.
    const fullyClosed = remainingShares <= 0;
    if (fullyClosed) {
      remainingShares = 0;
      remainingCost = 0;
    }

    position.originalShares ??= Number(position.shares) || availableShares;
    position.originalUsd ??= Number(position.usd) || availableCost;
    position.remainingShares = fullyClosed ? 0 : remainingShares;
    position.remainingCostUsd = fullyClosed ? 0 : remainingCost;
    position.realizedPnlUsd = cumulativePnl;
    position.realizedProceedsUsd = cumulativeProceeds;
    position.lastExitPrice = round4(Number(executedDraft.limitPrice) || price);
    position.lastExitReason = exitReason || `${exitStatus || 'exit'} at ${(price * 100).toFixed(1)}%`;
    if (leftoverIsDust && !fullyClosed) {
      position.dustTopUpPending = true;
      position.dustHolding = true;
      position.dustSellMinShares = minTradeable;
      position.dustHoldingReason = `${position.lastExitReason} · PM 仍持有 ${remainingShares.toFixed(4)} 份`;
    }
    if (fullyClosed) {
      position.positionStatus = 'closed';
      position.exitStatus = leftoverIsDust && !forceLiquidate
        ? (exitStatus || 'dust-unsellable')
        : (exitStatus || 'manual-exit');
      position.exitPrice = position.lastExitPrice;
      position.exitReason = leftoverIsDust && !skipClob
        ? `${position.lastExitReason} · Polymarket 仍余 ${Number(position.dustResidualShares || 0).toFixed(4)} 份灰尘仓（成本 $${Number(position.dustResidualCostUsd || 0).toFixed(2)}）`
        : position.lastExitReason;
      position.pnl = cumulativePnl;
      position.payoutUsd = cumulativeProceeds;
      position.closedAtIso = new Date().toISOString();
      this.attachSettlementLossAnalysis(position);
    }
    if (
      this.isPlan2FamilyPlan(position.planId)
      && this.normalizePlanId(position.planId) !== PLAN13_ID
      && fullyClosed
      && isPlan2StopLossExitStatus(position.exitStatus)
      && this.config.plan2StopLossReversalEnabled !== false
    ) {
      position.reversalEligible = true;
    }

    // Local dust flatten (closeLiveDustPosition): keep CLOB-safe buy close, but do not
    // invent a user-facing 「卖出/平仓」 row — paper has no synthetic sells either.
    if (skipClob && liquidateAll) {
      await this.persist('live');
      return {
        position,
        sellRecord: null,
        result,
        draft: executedDraft,
        pending: false,
        partial: !fullyClosed,
        soldShares,
        remainingShares,
        dustLocalClose: true
      };
    }

    const sellRecord = await this.recordLiveOrder({
      status: 'submitted',
      orderSide: 'SELL',
      positionStatus: fullyClosed ? 'closed' : 'open',
      symbol: position.symbol,
      timeframe: position.timeframe,
      planId: position.planId,
      planKey: position.planKey,
      slotIso: position.slotIso,
      direction: position.direction,
      outcome: position.outcome,
      usd: executedDraft.usd,
      shares: executedDraft.shares,
      limitPrice: executedDraft.limitPrice,
      entryPrice: position.entryPrice ?? position.limitPrice,
      tokenId: position.tokenId,
      market: position.market,
      marketSlug: position.marketSlug,
      targetTimeIso: position.targetTimeIso,
      relatedBuyOrderId: position.id,
      exitStatus: exitStatus || 'manual-exit',
      exitPrice: round4(Number(executedDraft.limitPrice) || price),
      exitReason: exitReason || `${exitStatus || 'exit'} at ${(price * 100).toFixed(1)}%`,
      pnl: legPnl,
      payoutUsd: proceeds,
      clobOrderId: result?.clobOrderId || null,
      clobStatus: result?.response?.status,
      clobSuccess: result?.response?.success,
      clobResponse: result?.response,
      note: fullyClosed
        ? `Live sell ${position.timeframe} ${position.planId} ${position.exitStatus}.`
        : `Live partial sell ${position.timeframe} ${position.planId}: ${soldShares.toFixed(4)} sold, ${remainingShares.toFixed(4)} remaining.`
    });
    await this.persist('live');
    return {
      position,
      sellRecord,
      result,
      draft: executedDraft,
      pending: false,
      partial: !fullyClosed,
      soldShares,
      remainingShares
    };
  }

  async maybeFlipLivePlan1Position({
    planView,
    resolveCurrentPrice,
    closedOnly = false,
    readinessReady = true
  }) {
    const plan = planView?.plan;
    const sentiment = planView?.polymarket;
    const openPosition = this.getOpenLivePositionForWindow({
      planId: 'plan1',
      timeframe: plan?.timeframe,
      slotIso: plan?.slotIso,
      symbol: plan?.symbol
    });
    const currentPrice = openPosition && typeof resolveCurrentPrice === 'function'
      ? Number(await resolveCurrentPrice(openPosition))
      : null;
    const evaluation = this.evaluateLivePlan1DirectionFlip({
      plan,
      sentiment,
      currentPrice
    });
    if (!evaluation.flip || !evaluation.openPosition) {
      return { flipped: false, ...evaluation };
    }

    const closed = await this.closeLivePosition(evaluation.openPosition, {
      sellPrice: currentPrice,
      exitStatus: 'direction-flip',
      exitReason: evaluation.reason,
      closedOnly,
      readinessReady
    });
    if (closed.partial) {
      return {
        flipped: false,
        partialExit: true,
        openPosition: closed.position,
        reason: '原方向仅部分成交，保留剩余仓位且不建立反向仓。'
      };
    }

    if (!this.state.liveAuto) this.state.liveAuto = { ...DEFAULT_STATE.liveAuto };
    if (!this.state.liveAuto.lastFlipAt) this.state.liveAuto.lastFlipAt = {};
    this.state.liveAuto.lastFlipAt[evaluation.windowKey] = Date.now();
    await this.persist('live');

    const buyResult = await this.createLiveOrder({ planView });
    const draft = buyResult.draft || {};
    const record = await this.recordLiveOrder({
      status: 'submitted',
      orderSide: 'BUY',
      positionStatus: 'open',
      symbol: draft.symbol || plan.symbol || 'BTC-USD',
      timeframe: draft.timeframe || plan.timeframe,
      planId: 'plan1',
      planKey: draft.planKey || plan.key || null,
      slotIso: draft.slotIso || plan.slotIso || null,
      direction: draft.direction,
      outcome: draft.outcome,
      usd: draft.usd,
      shares: draft.shares,
      limitPrice: draft.limitPrice,
      entryPrice: draft.limitPrice,
      tokenId: draft.tokenId,
      market: draft.market,
      marketSlug: draft.marketSlug,
      targetTimeIso: draft.targetTimeIso || plan.targetTimeIso || null,
      takeProfitPrice: plan.action?.takeProfitPrice ?? null,
      stopLossPrice: plan.action?.stopLossPrice ?? null,
      clobOrderId: buyResult.clobOrderId,
      clobStatus: buyResult.response?.status,
      clobSuccess: buyResult.response?.success,
      clobResponse: buyResult.response,
      note: `Live flip buy after closing ${closed.position.direction?.toUpperCase()} (PnL $${closed.position.pnl?.toFixed(2)}).`
    });
    await this.placeLivePlan1TakeProfitOrder(record);
    await this.markLiveExecuted(plan.key, 'plan1');
    await this.updateLiveAutoRun({
      lastAction: 'flipped',
      lastReason: evaluation.reason,
      lastError: null,
      lastOrderId: record.id
    });
    return { flipped: true, closed: closed.position, record, result: buyResult, reason: evaluation.reason };
  }

  async maybeLivePlan2StopLossReversal({
    planView,
    clobBalanceUsdc = null,
    closedOnly = false,
    readinessReady = true
  }) {
    const plan = planView?.plan;
    const sentiment = planView?.polymarket;
    if (!plan?.timeframe || !plan?.slotIso || !sentiment?.available) {
      return { reversed: false, reason: 'plan or market unavailable' };
    }

    const reversalPlanId = this.normalizePlanId(
      planView?.planId || plan.planId || plan.action?.planId || 'plan2_5'
    );
    const gate = this.canOpenLiveStopLossReversalForWindow({
      planId: reversalPlanId,
      timeframe: plan.timeframe,
      slotIso: plan.slotIso,
      symbol: plan.symbol
    });
    if (!gate.allowed || !gate.priorOrder) {
      return { reversed: false, reason: gate.reason || 'stop-loss reversal blocked' };
    }

    const reversalDirection = gate.oppositeDirection;
    const limitPrice = Number(reversalDirection === 'up' ? sentiment.upPrice : sentiment.downPrice);
    const confidence = this.resolveReversalConfidence(planView, reversalDirection);
    const evaluation = evaluatePlan2StopLossReversal({
      priorDirection: gate.priorOrder.direction,
      reversalDirection,
      limitPrice,
      confidence,
      elapsedPct: Number(plan.elapsedPct),
      timeframe: plan.timeframe,
      config: this.config,
      sentiment,
      signal: planView?.signal
    });
    if (!evaluation.allowed) {
      return { reversed: false, priorOrder: gate.priorOrder, reason: evaluation.reason };
    }

    const sizedUsd = computePolymarketOrderUsd({
      equity: Number(clobBalanceUsdc) || Number(this.state.liveControl?.currentBalanceUsdc) || 0,
      cash: Number(clobBalanceUsdc) || Number(this.state.liveControl?.currentBalanceUsdc) || 0,
      timeframe: plan.timeframe,
      config: this.config
    });
    const usd = round2(Math.max(Number(sizedUsd.usd) || 0, 0) * evaluation.sizeMultiplier);
    const reversalPlan = {
      ...plan,
      planId: reversalPlanId,
      action: {
        shouldTrade: true,
        direction: reversalDirection,
        outcome: reversalDirection === 'up' ? 'UP' : 'DOWN',
        limitPrice: evaluation.limitPrice,
        takeProfitPrice: evaluation.takeProfitPrice,
        stopLossPrice: evaluation.stopLossPrice,
        confidence: evaluation.confidence,
        edge: evaluation.edge,
        usd,
        entryType: 'stop_loss_reversal',
        entryTier: evaluation.tier,
        sizeMultiplier: evaluation.sizeMultiplier,
        executionKey: `${plan.slotIso}_${plan.symbol || 'BTC-USD'}_${plan.timeframe}_${reversalPlanId}_sl_rev`,
        reason: evaluation.reason
      }
    };

    const buyResult = await this.createLiveOrder({
      planView: { ...planView, plan: reversalPlan, planId: reversalPlanId },
      usd
    });
    const draft = buyResult.draft || {};
    const filled = buyResult.filled !== false && isClobBuyFillConfirmed(buyResult.response);
    const awaitingConfirm = !filled && (
      buyResult.awaitingConfirm === true
      || (isClobOrderFilled(buyResult.response) && !hasClobTransactionHashes(buyResult.response))
    );
    gate.priorOrder.reversalFollowed = true;
    gate.priorOrder.reversalFollowedAtIso = new Date().toISOString();
    await this.persist('live');

    const record = await this.recordLiveOrder({
      status: filled ? 'submitted' : 'pending',
      orderSide: 'BUY',
      positionStatus: filled ? 'open' : 'pending',
      filledAtIso: filled ? new Date().toISOString() : null,
      fillConfirmed: filled === true,
      fillUnconfirmed: awaitingConfirm === true,
      symbol: draft.symbol || plan.symbol || 'BTC-USD',
      timeframe: plan.timeframe,
      planId: reversalPlanId,
      planKey: reversalPlan.action.executionKey,
      entryType: 'stop_loss_reversal',
      entryTier: evaluation.tier,
      sizeMultiplier: evaluation.sizeMultiplier,
      slotIso: plan.slotIso,
      direction: reversalDirection,
      outcome: draft.outcome,
      usd: draft.usd,
      shares: draft.shares,
      limitPrice: draft.limitPrice,
      entryPrice: draft.limitPrice,
      tokenId: draft.tokenId,
      market: draft.market,
      marketSlug: draft.marketSlug,
      targetTimeIso: draft.targetTimeIso || plan.targetTimeIso || null,
      takeProfitPrice: evaluation.takeProfitPrice,
      stopLossPrice: evaluation.stopLossPrice,
      clobOrderId: buyResult.clobOrderId,
      clobStatus: buyResult.response?.status,
      clobSuccess: buyResult.response?.success,
      clobResponse: buyResult.response,
      reversalOfOrderId: gate.priorOrder.id,
      note: awaitingConfirm
        ? `Live stop-loss reversal ${gate.priorOrder.direction?.toUpperCase()}→${reversalDirection.toUpperCase()} after ${gate.priorOrder.exitStatus} · matched 待确认（无 tx）。`
        : `Live stop-loss reversal ${gate.priorOrder.direction?.toUpperCase()}→${reversalDirection.toUpperCase()} after ${gate.priorOrder.exitStatus}.`
    });
    await this.markLiveExecuted(reversalPlan.action.executionKey, reversalPlanId);
    await this.updateLiveAutoRun({
      lastAction: filled ? 'reversed' : (awaitingConfirm ? 'reversal-pending-confirm' : 'reversal-pending'),
      lastReason: evaluation.reason,
      lastError: null,
      lastOrderId: record.id
    });
    return {
      reversed: filled,
      pending: !filled,
      priorOrder: gate.priorOrder,
      record,
      result: buyResult,
      reason: evaluation.reason
    };
  }

  async processLivePlan5StopLosses(resolveCurrentPrice, {
    closedOnly = false,
    readinessReady = true,
    resolveCurrentPlanView = null
  } = {}) {
    if (!this.config.liveTradingEnabled || this.config.plan5StopLossEnabled === false) return [];
    if (typeof resolveCurrentPrice !== 'function') return [];
    const closed = [];
    for (const position of this.getOpenLivePositions('plan5')) {
      if (this.isLivePositionPending(position) || !this.shouldRetryLiveExit(position)) continue;
      const targetTimeMs = Date.parse(position.targetTimeIso || '');
      if (Number.isFinite(targetTimeMs) && Date.now() >= targetTimeMs) {
        // Once the market window ends, CLOB exits are invalid; official settlement owns it.
        continue;
      }
      if (this.isLiveDustUnsellablePosition(position)) continue;
      let currentPrice;
      try {
        currentPrice = Number(await resolveCurrentPrice(position));
      } catch {
        continue;
      }
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;
      position.lowestExecutableBid = round4(Math.min(
        Number.isFinite(Number(position.lowestExecutableBid)) ? Number(position.lowestExecutableBid) : currentPrice,
        currentPrice
      ));
      position.lastStopObservedAtIso = new Date().toISOString();

      let currentPlanView = null;
      if (typeof resolveCurrentPlanView === 'function') {
        try {
          currentPlanView = await resolveCurrentPlanView(position);
        } catch {
          currentPlanView = null;
        }
      }
      const exit = evaluatePlan5StopLoss({
        positionDirection: position.direction,
        currentPrice,
        currentPmDirection: resolvePlan5CurrentPmDirection(currentPlanView),
        config: this.config
      });
      if (!exit) continue;

      try {
        const result = await this.closeLivePosition(position, {
          sellPrice: exit.exitPrice,
          exitStatus: exit.exitStatus,
          exitReason: exit.exitReason,
          closedOnly,
          readinessReady,
          liquidateAll: true
        });
        if (result.pending) {
          await this.updateLiveAutoRun({
            lastAction: 'sell-pending',
            lastReason: `${position.timeframe} ${exit.exitStatus}: sell submitted but not filled`,
            lastOrderId: result.sellRecord?.id || null
          });
          continue;
        }
        if (result.partial) {
          await this.updateLiveAutoRun({
            lastAction: 'sell-partial',
            lastReason: `${position.timeframe} ${exit.exitStatus}: 部分成交，剩余 ${Number(result.remainingShares || 0).toFixed(4)} 份继续平仓`,
            lastOrderId: result.sellRecord?.id || null
          });
          continue;
        }
        closed.push(result.position);
        await this.updateLiveAutoRun({
          lastAction: 'sold',
          lastReason: `${position.timeframe} ${exit.exitStatus}: ${exit.exitReason}`,
          lastError: null,
          lastOrderId: result.sellRecord?.id || null
        });
      } catch (error) {
        const remainingShares = Number(position.remainingShares ?? position.shares) || 0;
        const msg = humanizeClobError(error, { shares: remainingShares });
        await this.markLiveExitRetry(position, msg, null, exit.exitStatus);
        await this.updateLiveAutoRun({ lastAction: 'error', lastReason: msg, lastError: msg });
      }
    }
    return closed;
  }

  async processLivePlan1Exits(resolveCurrentPrice, resolveElapsedPct = null, {
    closedOnly = false,
    readinessReady = true
  } = {}) {
    if (!this.config.liveTradingEnabled) return [];
    if (typeof resolveCurrentPrice !== 'function') return [];
    const closed = [];
    for (const position of [
      ...this.getOpenLivePositions('plan1'),
      ...this.getOpenLivePositions(PLAN11_ID)
    ]) {
      if (this.isLivePositionPending(position)) continue;
      if (!this.shouldRetryLiveExit(position)) continue;
      const targetTimeMs = Date.parse(position.targetTimeIso || '');
      if (Number.isFinite(targetTimeMs) && Date.now() >= targetTimeMs) {
        // Resolved/expiring markets reject CLOB exits; the settlement loop owns them now.
        continue;
      }
      if (this.isLiveDustUnsellablePosition(position)) {
        if (!position.dustHolding) {
          await this.holdLiveDustPosition(position, {
            exitReason: `Plan1 小额真实持仓（约 ${Number(position.remainingShares ?? position.shares ?? 0).toFixed(4)} 份 / $${Number(position.remainingCostUsd ?? position.usd ?? 0).toFixed(2)}），等待补仓或官方结算`
          });
        }
        continue;
      }
      let currentPrice;
      try {
        currentPrice = Number(await resolveCurrentPrice(position));
      } catch {
        continue;
      }
      if (this.shouldWaitAfterBuyFill(position, currentPrice)) continue;
      let elapsedPct = null;
      if (typeof resolveElapsedPct === 'function') {
        try {
          elapsedPct = Number(await resolveElapsedPct(position));
        } catch {
          elapsedPct = null;
        }
      }
      if (!Number.isFinite(elapsedPct)) {
        elapsedPct = windowElapsedPct(getSlotSchedule(new Date(), timeframeToSlotMinutes(position.timeframe || '15m')));
      }
      const exit = this.evaluateLiveExitTrigger(position, currentPrice, { elapsedPct });
      const isPlan11 = this.normalizePlanId(position.planId) === PLAN11_ID;
      const stopConfirmation = isPlan11
        ? { confirmed: true, count: 1, elapsedMs: 0 }
        : this.updateLivePlan1StopConfirmation(position, exit, currentPrice);
      if (!exit) continue;
      if (exit.exitStatus === 'take-profit' && position.takeProfitOrderId) {
        // The resting GTC owns this exit. Its remote fill is reconciled before this loop.
        continue;
      }
      if (exit.exitStatus === 'stop-loss' && !stopConfirmation.confirmed) {
        await this.persist('live');
        continue;
      }
      if (exit.exitStatus === 'stop-loss' && !isPlan11) {
        exit.exitReason = `${exit.exitReason} · 连续 ${stopConfirmation.count} 次/${Math.round(stopConfirmation.elapsedMs / 1000)} 秒确认`;
      }
      try {
        const result = await this.closeLivePosition(position, {
          sellPrice: exit.exitPrice,
          exitStatus: exit.exitStatus,
          exitReason: exit.exitReason,
          closedOnly,
          readinessReady
        });
        if (result.pending) {
          await this.updateLiveAutoRun({
            lastAction: 'sell-pending',
            lastReason: `${position.timeframe} ${exit.exitStatus}: sell submitted but not filled`,
            lastOrderId: result.sellRecord?.id || null
          });
          continue;
        }
        if (result.partial) {
          await this.updateLiveAutoRun({
            lastAction: 'sell-partial',
            lastReason: `${position.timeframe} ${exit.exitStatus}: 部分成交，剩余 ${Number(result.remainingShares || 0).toFixed(4)} 份继续平仓`,
            lastOrderId: result.sellRecord?.id || null
          });
          continue;
        }
        closed.push(result.position);
        await this.updateLiveAutoRun({
          lastAction: 'sold',
          lastReason: `${position.timeframe} ${exit.exitStatus}: ${exit.exitReason}`,
          lastOrderId: result.sellRecord?.id || null
        });
      } catch (error) {
        const remainingShares = Number(position.remainingShares ?? position.shares) || 0;
        const msg = humanizeClobError(error, { shares: remainingShares });
        if (isInvalidMakerAmountError(error) || /灰尘仓|invalid maker amount/i.test(msg)) {
          await this.holdLiveDustPosition(position, {
            exitReason: `Plan1 卖单低于 CLOB 门槛（原触发 ${exit?.exitStatus || 'exit'}），继续真实持有`,
            errorMessage: msg
          });
          continue;
        }
        await this.markLiveExitRetry(position, msg, null, exit?.exitStatus);
        if (!this.isLiveExitPendingBuyError(msg) && this.shouldLogLiveExitBlocked(position)) {
          await this.recordLiveOrder({
            status: 'blocked',
            orderSide: 'SELL',
            positionStatus: 'closed',
            symbol: position.symbol,
            timeframe: position.timeframe,
            planId: position.planId,
            slotIso: position.slotIso,
            direction: position.direction,
            shares: remainingShares,
            usd: Number(position.remainingCostUsd ?? position.usd) || null,
            relatedBuyOrderId: position.id,
            error: msg,
            note: `Live plan1 exit blocked: ${exit.exitStatus}.`
          });
          await this.markLiveExitBlockedLog(position);
        }
        await this.updateLiveAutoRun({
          lastAction: 'error',
          lastReason: msg,
          lastError: msg
        });
      }
    }
    return closed;
  }

  async processLivePlan2Exits(resolveCurrentPrice, {
    closedOnly = false,
    readinessReady = true,
    resolveCurrentPlanView = null
  } = {}) {
    if (!this.config.liveTradingEnabled) return [];
    if (typeof resolveCurrentPrice !== 'function') return [];
    const closed = [];
    let peakChanged = false;
    // Include plan2 / plan2_5 / plan2_6 — filtering only 'plan2' silently skipped 2.5/2.6 exits.
    const positions = (this.state.liveOrders || []).filter((order) => (
      this.isPlan2FamilyPlan(order.planId) && this.isLivePositionOpen(order)
    ));
    for (const position of positions) {
      if (this.isLivePositionPending(position)) continue;
      if (!this.shouldRetryLiveExit(position)) continue;
      const targetTimeMs = Date.parse(position.targetTimeIso || '');
      if (Number.isFinite(targetTimeMs) && Date.now() >= targetTimeMs) {
        // Resolved/expiring markets reject CLOB exits; official settlement owns them.
        continue;
      }
      if (this.isLiveDustUnsellablePosition(position)) {
        if (!position.dustHolding) {
          await this.holdLiveDustPosition(position, {
            exitReason: `${position.planId || 'plan2'} 小额真实持仓低于 CLOB 卖出门槛，等待补仓或官方结算`
          });
        }
        continue;
      }
      let currentPrice;
      try {
        currentPrice = Number(await resolveCurrentPrice(position));
      } catch {
        continue;
      }
      const trailingTouch = this.applyPlan2TrailingPeak(position, currentPrice);
      if (trailingTouch.changed) peakChanged = true;
      if (this.shouldWaitAfterBuyFill(position, currentPrice)) continue;
      let currentPlanView = null;
      if (typeof resolveCurrentPlanView === 'function') {
        try {
          currentPlanView = await resolveCurrentPlanView(position);
        } catch {
          currentPlanView = null;
        }
      }
      const exit = this.evaluateLiveExitTrigger(position, currentPrice, {
        currentAction: currentPlanView?.plan?.action || null,
        fiveMinuteLock: currentPlanView?.plan?.fiveMinuteLock || null,
        fiveMinuteLockStats: currentPlanView?.plan?.fiveMinuteLockStats || null
      });
      if (this.normalizePlanId(position.planId) === PLAN13_ID) {
        const confirmation = this.updatePlan13StopConfirmation(
          position,
          exit,
          currentPrice,
          currentPlanView
        );
        if (confirmation.changed) peakChanged = true;
        if (exit && !confirmation.confirmed) continue;
        if (exit) {
          exit.exitReason = `${exit.exitReason} · Binance 技术/现货反转连续 ${confirmation.count}/${confirmation.requiredSamples} 次确认`;
        }
      }
      if (!exit) continue;
      try {
        const result = await this.closeLivePosition(position, {
          sellPrice: exit.exitPrice,
          exitStatus: exit.exitStatus,
          exitReason: exit.exitReason,
          closedOnly,
          readinessReady
        });
        if (result.pending) {
          await this.updateLiveAutoRun({
            lastAction: 'sell-pending',
            lastReason: `${position.timeframe} ${exit.exitStatus}: sell submitted but not filled`,
            lastOrderId: result.sellRecord?.id || null
          });
          continue;
        }
        if (result.partial) {
          await this.updateLiveAutoRun({
            lastAction: 'sell-partial',
            lastReason: `${position.timeframe} ${exit.exitStatus}: 部分成交，剩余 ${Number(result.remainingShares || 0).toFixed(4)} 份继续平仓`,
            lastOrderId: result.sellRecord?.id || null
          });
          continue;
        }
        closed.push(result.position);
        await this.updateLiveAutoRun({
          lastAction: 'sold',
          lastReason: `${position.timeframe} ${exit.exitStatus}: ${exit.exitReason}`,
          lastOrderId: result.sellRecord?.id || null
        });
        if (
          this.normalizePlanId(position.planId) !== PLAN13_ID
          &&
          isPlan2StopLossExitStatus(exit.exitStatus)
          && currentPlanView
          && this.config.plan2StopLossReversalEnabled !== false
          && !this.isPlan2ExitSyncedToPaper(position.planId)
        ) {
          try {
            await this.maybeLivePlan2StopLossReversal({
              planView: currentPlanView,
              clobBalanceUsdc: Number(this.state.liveControl?.currentBalanceUsdc) || 0,
              closedOnly,
              readinessReady
            });
          } catch {
            // reversal is best-effort after stop-loss
          }
        }
      } catch (error) {
        const remainingShares = Number(position.remainingShares ?? position.shares) || 0;
        const msg = humanizeClobError(error, { shares: remainingShares });
        if (isInvalidMakerAmountError(error) || /灰尘仓|invalid maker amount/i.test(msg)) {
          await this.holdLiveDustPosition(position, {
            exitReason: `${position.planId || 'plan2'} 卖单低于 CLOB 门槛（原触发 ${exit?.exitStatus || 'exit'}），继续真实持有`,
            errorMessage: msg
          });
          continue;
        }
        await this.markLiveExitRetry(position, msg, null, exit?.exitStatus);
        if (!this.isLiveExitPendingBuyError(msg) && this.shouldLogLiveExitBlocked(position)) {
          await this.recordLiveOrder({
            status: 'blocked',
            orderSide: 'SELL',
            positionStatus: 'closed',
            symbol: position.symbol,
            timeframe: position.timeframe,
            planId: position.planId,
            slotIso: position.slotIso,
            direction: position.direction,
            shares: remainingShares,
            usd: Number(position.remainingCostUsd ?? position.usd) || null,
            relatedBuyOrderId: position.id,
            error: msg,
            note: `Live ${position.planId || 'plan2'} exit blocked: ${exit.exitStatus}.`
          });
          await this.markLiveExitBlockedLog(position);
        }
        await this.updateLiveAutoRun({
          lastAction: 'error',
          lastReason: msg,
          lastError: msg
        });
      }
    }
    if (peakChanged && !closed.length) await this.persist('live');
    return closed;
  }

  async settleExpiredLivePositions(resolveOutcome, { now = new Date() } = {}) {
    if (typeof resolveOutcome !== 'function') throw new Error('resolveOutcome callback is required.');
    const nowMs = now.getTime();
    const settled = [];
    const outcomeCandidates = [];
    for (const order of this.state.liveOrders || []) {
      if (order.orderSide === 'SELL') continue;
      if (order.positionStatus === 'closed') continue;
      if (!['submitted', 'pending'].includes(order.status)) continue;
      if (!order.targetTimeIso || Date.parse(order.targetTimeIso) > nowMs - 15_000) continue;

      if (this.isLivePositionPending(order)) {
        order.status = 'expired';
        order.positionStatus = 'closed';
        order.exitStatus = 'expired-unfilled';
        order.exitReason = 'window expired before local fill confirmation';
        order.pnl = 0;
        order.payoutUsd = 0;
        order.closedAtIso = new Date().toISOString();
        settled.push(order);
        continue;
      }

      if (order.takeProfitOrderId) {
        if (isClobOrderTerminal({ status: order.takeProfitOrderStatus })) {
          order.lastTakeProfitOrderId = order.takeProfitOrderId;
          order.takeProfitOrderId = null;
        } else {
          try {
            const cancelled = await this.cancelLivePlan1TakeProfitOrder(order);
            if (cancelled.closed || order.positionStatus === 'closed') {
              settled.push(order);
              continue;
            }
          } catch (error) {
            order.settlementError = `expiry take-profit cancel failed: ${humanizeClobError(error)}`;
            continue;
          }
        }
      }

      outcomeCandidates.push(order);
    }

    // 官方结果彼此独立；限制并发，避免一笔慢请求串行堵住所有到期仓位。
    const outcomeRows = new Map();
    let nextCandidateIndex = 0;
    const workerCount = Math.min(4, outcomeCandidates.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextCandidateIndex < outcomeCandidates.length) {
        const index = nextCandidateIndex;
        nextCandidateIndex += 1;
        const order = outcomeCandidates[index];
        try {
          outcomeRows.set(order, { outcome: await resolveOutcome(order), error: null });
        } catch (error) {
          outcomeRows.set(order, { outcome: null, error });
        }
      }
    });
    await Promise.all(workers);

    for (const order of outcomeCandidates) {
      const { outcome, error } = outcomeRows.get(order) || {};
      if (error) {
        order.settlementError = error.message;
        continue;
      }
      if (!outcome?.actualDirection) continue;

      const won = order.direction === outcome.actualDirection;
      const remainingShares = Number(order.remainingShares ?? order.shares) || 0;
      const remainingCost = Number(order.remainingCostUsd ?? order.usd) || 0;
      const expiryPayout = won ? round2(remainingShares) : 0;
      const expiryPnl = round2(expiryPayout - remainingCost);
      const payoutUsd = round2((Number(order.realizedProceedsUsd) || 0) + expiryPayout);
      const pnl = round2((Number(order.realizedPnlUsd) || 0) + expiryPnl);
      order.positionStatus = 'closed';
      order.exitStatus = order.exitStatus || 'expiry';
      order.exitPrice = won ? 1 : 0;
      order.exitReason = `expiry ${won ? 'won' : 'lost'} (${outcome.actualDirection})`;
      order.won = won;
      order.pnl = pnl;
      order.payoutUsd = payoutUsd;
      order.remainingShares = 0;
      order.remainingCostUsd = 0;
      order.dustTopUpPending = false;
      order.dustHolding = false;
      order.dustHoldingReason = null;
      order.actualDirection = outcome.actualDirection;
      order.actualClose = Number(outcome.actualClose) || null;
      order.startPrice = Number(outcome.startPrice ?? order.startPrice) || order.startPrice;
      order.closedAtIso = new Date().toISOString();
      order.settlementError = null;
      this.attachSettlementLossAnalysis(order);
      settled.push(order);
    }
    if (settled.length) await this.persist('live');
    return settled;
  }

  async reconcileLiveOfficialSettlements(resolveOutcome, { limit = 20 } = {}) {
    if (typeof resolveOutcome !== 'function') throw new Error('resolveOutcome callback is required.');
    const candidates = (this.state.liveOrders || [])
      .filter((order) => (
        order.orderSide !== 'SELL'
        && order.positionStatus === 'closed'
        && order.exitStatus === 'expiry'
        && order.marketSlug
        && !order.officialOutcomeVerifiedAtIso
        && !(
          Number(order.realizedProceedsUsd) > 0
          || (Number.isFinite(Number(order.realizedPnlUsd)) && Number(order.realizedPnlUsd) !== 0)
        )
      ))
      .slice(0, Math.max(1, Number(limit) || 20));
    const corrected = [];
    let verified = 0;
    for (const order of candidates) {
      let outcome;
      try {
        outcome = await resolveOutcome(order);
      } catch (error) {
        order.settlementError = error.message;
        continue;
      }
      if (!outcome?.actualDirection || outcome.priceSource !== 'polymarket-official') continue;
      verified += 1;
      const previousDirection = order.actualDirection || null;
      const previousPnl = Number(order.pnl) || 0;
      const won = order.direction === outcome.actualDirection;
      const shares = Number(order.shares) || 0;
      const cost = Number(order.usd) || 0;
      const payoutUsd = won ? round2(shares) : 0;
      const pnl = round2(payoutUsd - cost);
      order.actualDirection = outcome.actualDirection;
      order.startPrice = Number(outcome.startPrice ?? order.startPrice) || order.startPrice;
      order.won = won;
      order.exitPrice = won ? 1 : 0;
      order.exitReason = `expiry ${won ? 'won' : 'lost'} (${outcome.actualDirection}) · Polymarket official`;
      order.payoutUsd = payoutUsd;
      order.pnl = pnl;
      order.settlementPriceSource = outcome.priceSource;
      order.officialOutcome = outcome.officialOutcome || outcome.actualDirection;
      order.officialOutcomePrices = outcome.outcomePrices || null;
      order.officialOutcomeVerifiedAtIso = new Date().toISOString();
      order.settlementError = null;
      this.attachSettlementLossAnalysis(order);
      this._statsDbSyncedIds.delete(order.id);
      if (previousDirection !== order.actualDirection || previousPnl !== pnl) {
        corrected.push(order);
      }
    }
    if (verified) await this.persist('live');
    return { checked: candidates.length, verified, corrected };
  }

  listLiveOrders(planId = null, { limit = null, summary = false } = {}) {
    let orders = (this.state.liveOrders || [])
      .filter((order) => !shouldHideLiveOrderRow(order));
    if (planId) orders = orders.filter((order) => normalizeLiveOrderPlanId(order) === planId);
    if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
      orders = orders.slice(0, Math.floor(Number(limit)));
    }
    return summary ? orders.map(summarizeLiveOrderForApi) : orders;
  }

  computeLiveStats(planId = null, { planIds = null } = {}) {
    let allOrders;
    if (planId) {
      allOrders = this.listLiveOrders(planId);
    } else if (Array.isArray(planIds)) {
      const allowed = new Set(planIds.map((id) => String(id || '').toLowerCase()).filter(Boolean));
      allOrders = (this.state.liveOrders || [])
        .filter((order) => allowed.has(normalizeLiveOrderPlanId(order)) && !shouldHideLiveOrderRow(order));
    } else {
      allOrders = (this.state.liveOrders || []).filter((order) => !shouldHideLiveOrderRow(order));
    }
    const closedBuys = allOrders.filter((order) => (
      order.orderSide !== 'SELL'
      && order.positionStatus === 'closed'
      && !isExpiredUnfilledLiveOrder(order)
      && !isDustClosedLiveOrder(order)
      && Number.isFinite(Number(order.pnl))
      && Number.isFinite(Number(order.usd))
      && Number(order.usd) > 0
    ));
    const realizedPnl = closedBuys.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
    const investedUsd = closedBuys.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const wins = closedBuys.filter((order) => Number(order.pnl) > 0);
    const losses = closedBuys.filter((order) => Number(order.pnl) < 0);
    const expiredUnfilled = allOrders.filter((order) => isExpiredUnfilledLiveOrder(order));
    const byPlan = buildLiveStatsByPlan(allOrders, closedBuys);
    return {
      settledTrades: closedBuys.length,
      wins: wins.length,
      losses: losses.length,
      expiredUnfilled: expiredUnfilled.length,
      investedUsd: round2(investedUsd),
      realizedPnl: round2(realizedPnl),
      totalReturn: investedUsd > 0 ? round4(realizedPnl / investedUsd) : 0,
      winRate: closedBuys.length ? round4(wins.length / closedBuys.length) : 0,
      byPlan
    };
  }

  async syncLivePendingBuys() {
    const pending = (this.state.liveOrders || []).filter((order) => (
      order.orderSide !== 'SELL'
      && (order.status === 'pending' || order.positionStatus === 'pending')
      && order.clobOrderId
    ));
    if (!pending.length) return [];

    let client;
    try {
      client = await this.createLiveClobClient();
    } catch {
      return [];
    }

    const opened = [];
    const released = [];
    const retryEnabled = this.config.liveUnfilledRetryEnabled !== false;
    const nowMs = Date.now();

    for (const order of pending) {
      try {
        const planId = this.normalizePlanId(order.planId || 'plan1');
        const retryAfterMs = planId === 'plan3'
          ? Math.max(2000, Number(this.config.plan3LivePendingTtlMs) || 4000)
          : planId === 'plan5'
            ? Math.max(500, Number(this.config.plan5LiveUnfilledRetryAfterMs) || 2000)
            : Math.max(2000, Number(this.config.liveUnfilledRetryAfterMs) || 12000);
        let remote = await client.getOrder(order.clobOrderId);
        let progress = extractClobOpenOrderProgress(remote, Number(order.shares) || 0);
        const hasMatchedShares = progress.matchedShares > 0.0001;
        if (hasMatchedShares && !progress.filled && !isClobOrderTerminal(remote)) {
          try {
            if (typeof client.cancelOrder === 'function') {
              await client.cancelOrder({ orderID: order.clobOrderId });
            } else if (typeof client.cancelOrders === 'function') {
              await client.cancelOrders([order.clobOrderId]);
            } else {
              throw new Error('CLOB client does not support cancel');
            }
            remote = await client.getOrder(order.clobOrderId).catch(() => remote);
            progress = extractClobOpenOrderProgress(remote, Number(order.shares) || 0);
          } catch {
            order.clobPartialMatchedShares = progress.matchedShares;
            order.clobStatus = remote?.status || order.clobStatus;
            order.note = `${order.note || ''} · 买单已部分成交，等待撤销剩余挂单`.trim();
            await this.persist('live');
            continue;
          }
        }
        // getOrder 的 size_matched / terminal matched 才算确认；单纯 post 回报 matched 不够。
        const filled = progress.filled
          || progress.matchedShares > 0.0001
          || isClobBuyFillConfirmed(remote)
          || (isClobOrderFilled(remote) && Number(progress.originalShares) > 0 && progress.matchedShares > 0);
        if (filled) {
          if (progress.matchedShares > 0) {
            order.originalShares ??= Number(order.shares) || progress.originalShares;
            order.originalUsd ??= Number(order.usd) || 0;
            order.shares = round4(progress.matchedShares);
            const fillPrice = Number(remote?.price) || Number(order.limitPrice) || Number(order.entryPrice) || 0;
            order.usd = round2(order.shares * fillPrice);
            order.limitPrice = fillPrice || order.limitPrice;
            order.entryPrice = fillPrice || order.entryPrice;
          }
          order.status = 'submitted';
          order.positionStatus = 'open';
          order.filledAtIso = new Date().toISOString();
          order.fillConfirmed = true;
          order.fillUnconfirmed = false;
          order.clobStatus = remote?.status || order.clobStatus;
          order.clobResponse = remote;
          order.note = `${order.note || ''} · 买单已成交${progress.filled ? '' : '（部分成交后已撤余单）'}`.trim();
          if (order.tokenId) {
            try {
              const { warmConditionalTokenForSell } = await import('./polymarketLiveClob.js');
              await warmConditionalTokenForSell(client, order.tokenId, {
                expectedShares: order.shares,
                retries: 4,
                delayMs: 2500
              });
            } catch {
              // balance may land later; exit loop will retry sell
            }
          }
          if (order.planKey) {
            await this.markLiveExecuted(order.planKey, order.planId || planId);
          }
          if (this.normalizePlanId(order.planId) === 'plan1') {
            await this.placeLivePlan1TakeProfitOrder(order);
          }
          opened.push(order);
          continue;
        }

        // FAK/未成交：短暂等待后释放窗口，允许下一 tick 重评信号再下单
        if (!retryEnabled) continue;
        const createdMs = Date.parse(order.createdAtIso || 0);
        if (!Number.isFinite(createdMs) || (nowMs - createdMs) < retryAfterMs) continue;
        const maxRetries = planId === 'plan5'
          ? Math.max(1, Number(this.config.plan5LiveUnfilledRetryMaxPerKey) || 12)
          : Math.max(1, Number(this.config.liveUnfilledRetryMaxPerKey) || 5);
        const priorRetries = order.planKey
          ? this.countLiveUnfilledRetries(planId, order.planKey)
          : 0;
        const retriesExhausted = (priorRetries + 1) >= maxRetries;

        try {
          if (typeof client.cancelOrder === 'function') {
            await client.cancelOrder({ orderID: order.clobOrderId });
          } else if (typeof client.cancelOrders === 'function') {
            await client.cancelOrders([order.clobOrderId]);
          }
        } catch {
          // cancel best-effort；本地仍释放以免 pending 永久锁窗
        }
        order.status = 'expired';
        order.positionStatus = 'closed';
        order.exitStatus = 'expired-unfilled';
        order.exitReason = retriesExhausted
          ? `pending unfilled max retries (${maxRetries}) · window locked`
          : `pending unfilled >${Math.round(retryAfterMs / 1000)}s · release for re-eval`;
        order.pnl = 0;
        order.payoutUsd = 0;
        order.closedAtIso = new Date().toISOString();
        order.clobStatus = remote?.status || order.clobStatus;
        order.clobResponse = remote;
        order.note = retriesExhausted
          ? `${order.note || ''} · 未成交达上限，本窗不再重试`.trim()
          : `${order.note || ''} · 未成交已释放可重试`.trim();
        if (order.planKey && Array.isArray(this.state.liveAuto?.lastExecutedKeys)) {
          const orderPlanId = order.planId || planId;
          if (retriesExhausted) {
            // 保留 executionKey，避免同窗无限刷 GTC
            await this.markLiveExecuted(order.planKey, orderPlanId);
          } else {
            this.unmarkLiveExecuted(order.planKey, orderPlanId);
          }
        }
        released.push(order);
      } catch {
        // ignore per-order sync errors
      }
    }
    if (opened.length || released.length) await this.persist('live');
    return opened;
  }

  async recordLiveOrder(record = {}) {
    const isBlockedSell = record.status === 'blocked' && record.orderSide === 'SELL';
    const entry = {
      id: `pm-live-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAtIso: new Date().toISOString(),
      status: record.status || 'logged',
      orderSide: record.orderSide || 'BUY',
      positionStatus: record.positionStatus ?? (record.orderSide === 'SELL' && !isBlockedSell ? 'closed' : null),
      symbol: record.symbol || 'BTC-USD',
      timeframe: record.timeframe || null,
      direction: record.direction || null,
      outcome: record.outcome || null,
      usd: Number(record.usd) || null,
      limitPrice: Number(record.limitPrice) || null,
      entryPrice: Number(record.entryPrice ?? record.limitPrice) || null,
      shares: Number(record.shares) || null,
      tokenId: record.tokenId || null,
      market: record.market || null,
      marketSlug: record.marketSlug || null,
      targetTimeIso: record.targetTimeIso || null,
      takeProfitPrice: Number(record.takeProfitPrice) || null,
      stopLossPrice: Number(record.stopLossPrice) || null,
      peakPrice: Number(record.peakPrice ?? record.entryPrice ?? record.limitPrice) || null,
      trailStopPrice: Number(record.trailStopPrice) || null,
      relatedBuyOrderId: record.relatedBuyOrderId || null,
      exitStatus: record.exitStatus || null,
      exitPrice: Number(record.exitPrice) || null,
      exitReason: record.exitReason || null,
      pnl: Number(record.pnl) || null,
      payoutUsd: Number(record.payoutUsd) || null,
      closedAtIso: record.closedAtIso || null,
      filledAtIso: record.filledAtIso || null,
      fillConfirmed: record.fillConfirmed === true,
      fillUnconfirmed: record.fillUnconfirmed === true,
      clobOrderId: record.clobOrderId || null,
      planId: record.planId || null,
      planKey: record.planKey || null,
      entryType: record.entryType || null,
      entryTier: record.entryTier || null,
      lockStrength: record.lockStrength || null,
      lockPmGap: Number(record.lockPmGap) || null,
      lockedAtIso: record.lockedAtIso || null,
      signalQuality: record.signalQuality || null,
      expectedValueGate: record.expectedValueGate || null,
      marketAlignment: record.marketAlignment || null,
      consensusGate: record.consensusGate || null,
      entryTiming: record.entryTiming || null,
      entryPriceGate: record.entryPriceGate || null,
      historyWinRateGate: record.historyWinRateGate || null,
      winrateGuidanceGate: record.winrateGuidanceGate || null,
      lossReasonGate: record.lossReasonGate || null,
      basketAllocation: record.basketAllocation || null,
      directionRecheck: record.directionRecheck || null,
      liveDirectionRecheck: record.liveDirectionRecheck || null,
      signalDirection: record.signalDirection || null,
      technicalDirection: record.technicalDirection || null,
      spotDirection: record.spotDirection || null,
      lockUpProbability: Number.isFinite(Number(record.lockUpProbability)) ? Number(record.lockUpProbability) : null,
      lockDownProbability: Number.isFinite(Number(record.lockDownProbability)) ? Number(record.lockDownProbability) : null,
      strategyVersion: record.strategyVersion || null,
      sizeMultiplier: Number(record.sizeMultiplier) || null,
      confidence: Number(record.confidence) || null,
      slotIso: record.slotIso || null,
      response: record.response || null,
      clobStatus: record.clobStatus || null,
      clobSuccess: record.clobSuccess ?? null,
      clobResponse: record.clobResponse || null,
      error: record.error ? humanizeClobError(record.error) : null,
      note: record.note || null,
      pmUpPrice: Number(record.pmUpPrice) || null,
      pmDownPrice: Number(record.pmDownPrice) || null,
      secondsRemaining: Number.isFinite(Number(record.secondsRemaining)) ? Number(record.secondsRemaining) : null,
      intendedLimitPrice: Number(record.intendedLimitPrice) || null,
      entryPmSnapshot: record.entryPmSnapshot || null,
      entryContext: record.entryContext || null,
      preEntryPmReversal: record.preEntryPmReversal || null,
      lossAnalysis: record.lossAnalysis || null,
      lossReason: record.lossReason || null,
      pmReversal: record.pmReversal ?? null,
      retryCount: Number(record.retryCount) || 0,
      lastRetryAtIso: record.lastRetryAtIso || null,
      nextRetryAtIso: record.nextRetryAtIso || null,
      remainingShares: Number.isFinite(Number(record.remainingShares))
        ? Number(record.remainingShares)
        : (record.positionStatus === 'open' ? Number(record.shares) || null : null),
      remainingCostUsd: Number.isFinite(Number(record.remainingCostUsd))
        ? Number(record.remainingCostUsd)
        : (record.positionStatus === 'open' ? Number(record.usd) || null : null),
      dustTopUpPending: record.dustTopUpPending === true
    };
    this.state.liveOrders = pruneLiveOrdersByPlan([entry, ...(this.state.liveOrders || [])]);
    await this.persist('live');
    return entry;
  }

  listPaperOrders(planId = 'plan1', { limit = null, summary = false } = {}) {
    const id = this.normalizePlanId(planId);
    let orders = [...(this.getBucket(id).paperOrders || [])]
      .map((order) => ({
        ...order,
        // 历史订单可能缺 planId/symbol；列表统一回填，避免前端按 plan 分支误判「无记录」
        planId: order.planId || id,
        symbol: order.symbol || order.plan?.symbol || 'BTC-USD',
        planKey: order.planKey
          || order.plan?.action?.executionKey
          || order.plan?.key
          || null
      }))
      .sort((a, b) => String(b.createdAtIso || '').localeCompare(String(a.createdAtIso || '')));
    if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
      orders = orders.slice(0, Math.floor(Number(limit)));
    }
    if (summary) {
      orders = orders.map(summarizePaperOrderForApi);
    }
    return orders;
  }

  async resetPaperOrders(planId = 'plan1') {
    const id = this.normalizePlanId(planId);
    const bucket = this.getBucket(id);
    const openExposure = bucket.paperOrders
      .filter((order) => order.settlementStatus === 'open')
      .reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    if (bucket.portfolio.portfolioInitialized) {
      bucket.portfolio.cash = round2(bucket.portfolio.cash + openExposure);
    }
    bucket.paperOrders = [];
    bucket.auto.lastExecutedKeys = [];
    bucket.pendingDelayedEntries = {};
    bucket.lastFlipAt = {};
    if (id === 'plan3') {
      bucket.plan3OpportunityLog = [];
      bucket.plan3SubmittedSlots = {};
    }
    if (id === 'plan5') {
      bucket.plan5OpportunityLog = [];
      bucket.plan5ShadowObservations = [];
    }
    if (id === 'plan3_6') {
      bucket.plan36ObservationLog = [];
    }
    if (['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan13', 'plan11'].includes(id)) {
      bucket.trajectoryExperimentLog = [];
    }
    await this.persist(id, { skipStatsSync: true });
    this.scheduleBackgroundStatsSync(id);
  }

  async persistOpportunityLog(planId, minIntervalMs = 30_000) {
    const id = this.normalizePlanId(planId);
    const now = Date.now();
    const last = Number(this.opportunityPersistAtMs.get(id)) || 0;
    if (now - last < minIntervalMs) return false;
    this.opportunityPersistAtMs.set(id, now);
    await this.persist(id, { skipStatsSync: true });
    return true;
  }

  async persist(scope = 'all', { skipStatsSync = false } = {}) {
    if (!skipStatsSync) {
      try {
        // 只扫描本次变化的分片，避免一个计划写盘时重复遍历全部历史订单。
        this.syncSettledOrdersToStatsDb({
          planIds: PLAN_IDS.includes(scope) ? [scope] : null,
          includeLive: scope === 'all' || scope === 'live',
          maxBatch: 250
        });
      } catch (error) {
        console.error(`Stats DB order sync failed: ${error.message}`);
      }
    }
    if (!this.splitState) {
      await this.persistLegacyCombinedState();
      return;
    }

    const tasks = [];
    if (scope === 'all' || scope === 'live') {
      const livePayload = structuredClone({
        liveControl: this.state.liveControl,
        liveAuto: this.state.liveAuto,
        liveOrders: this.state.liveOrders
      });
      tasks.push(queueFileWrite(
        this.persistQueues,
        this.liveStatePath,
        () => writeJsonAtomic(this.liveStatePath, livePayload)
      ));
    }

    const planIds = scope === 'all'
      ? PLAN_IDS
      : (PLAN_IDS.includes(scope) ? [scope] : []);
    for (const planId of planIds) {
      const path = this.planStatePaths[planId];
      const bucket = this.state.plans[planId];
      if (Array.isArray(bucket?.paperOrders) && bucket.paperOrders.length) {
        bucket.paperOrders = bucket.paperOrders.map(slimStoredPaperOrder);
      }
      const payload = structuredClone(bucket);
      tasks.push(queueFileWrite(
        this.persistQueues,
        path,
        () => writeJsonAtomic(path, payload)
      ));
    }
    await Promise.all(tasks);
  }

  async persistLegacyCombinedState() {
    await queueFileWrite(
      this.persistQueues,
      this.statePath,
      () => writeJsonAtomic(this.statePath, structuredClone(this.state))
    );
  }
}

function queueFileWrite(queueMap, filePath, writeTask) {
  // 同路径最新写盘覆盖排队中的旧任务，避免大 state 积压导致重置/API 长时间无响应
  const previous = queueMap.get(filePath);
  if (previous) previous.cancelled = true;
  const entry = { cancelled: false, promise: null };
  const previousPromise = previous?.promise || Promise.resolve();
  entry.promise = previousPromise
    .catch(() => {})
    .then(async () => {
      if (entry.cancelled) return;
      await writeTask();
    })
    .finally(() => {
      if (queueMap.get(filePath) === entry) queueMap.delete(filePath);
    });
  queueMap.set(filePath, entry);
  return entry.promise;
}

function mergePlanBucket(planId, source = {}) {
  const fresh = freshPlanBucket(planId);
  const sourceAuto = source.auto || {};
  const hasSymbols = Array.isArray(sourceAuto.symbols) && sourceAuto.symbols.length > 0;
  const merged = {
    ...fresh,
    ...source,
    auto: {
      ...fresh.auto,
      ...sourceAuto,
      // 旧 state 可能缺 symbols；浅合并会整段覆盖掉默认四币，导致纸面只跑 BTC
      symbols: hasSymbols
        ? normalizeLiveSymbols(sourceAuto.symbols)
        : [...(fresh.auto.symbols || LIVE_AUTO_SYMBOLS)]
    },
    pendingDelayedEntries: source.pendingDelayedEntries || {},
    lastFlipAt: source.lastFlipAt || {},
    paperOrders: Array.isArray(source.paperOrders)
      ? source.paperOrders.map(slimStoredPaperOrder)
      : []
  };
  if (planId === 'plan3') {
    merged.plan3SubmittedSlots = source.plan3SubmittedSlots || {};
    merged.plan3OpportunityLog = source.plan3OpportunityLog || [];
    merged.plan3Daily = { ...freshPlanBucket('plan3').plan3Daily, ...(source.plan3Daily || {}) };
  }
  if (planId === 'plan5') {
    merged.plan5OpportunityLog = Array.isArray(source.plan5OpportunityLog)
      ? source.plan5OpportunityLog.slice(0, 800)
      : [];
    merged.plan5ShadowObservations = Array.isArray(source.plan5ShadowObservations)
      ? source.plan5ShadowObservations.slice(0, 10000)
      : [];
  }
  if (planId === 'plan3_6') {
    merged.plan36ObservationLog = Array.isArray(source.plan36ObservationLog)
      ? source.plan36ObservationLog.slice(0, 10000)
      : [];
  }
  if (planId === 'plan1' || planId === 'plan2' || planId === 'plan2_5' || planId === 'plan2_6' || planId === 'plan13' || planId === 'plan11') {
    merged.trajectoryExperimentLog = Array.isArray(source.trajectoryExperimentLog)
      ? source.trajectoryExperimentLog.slice(0, 400)
      : [];
  }
  return merged;
}

async function readJsonFileOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // 截断/损坏的 JSON 视为不可用，交给 bak 恢复路径
    if (error instanceof SyntaxError) {
      console.warn(`Polymarket state JSON corrupt, ignoring ${filePath}: ${error.message}`);
      return null;
    }
    throw error;
  }
}

function bucketHasData(bucket) {
  if (!bucket) return false;
  return Boolean(
    bucket.portfolio?.portfolioInitialized
    || (bucket.paperOrders?.length || 0) > 0
    || (bucket.liveOrders?.length || 0) > 0
  );
}

function bucketScore(bucket) {
  if (!bucket) return -1;
  return (bucket.paperOrders?.length || 0) * 1000
    + (bucket.liveOrders?.length || 0) * 1000
    + (bucket.portfolio?.portfolioInitialized ? 500 : 0)
    + Number(bucket.portfolio?.startingCash || 0);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readPlanStateWithBackup(filePath) {
  const primary = await readJsonFileOptional(filePath);
  if (primary) return primary;
  // 仅在主文件缺失/损坏时回退 bak。不能用「订单更多」偏好 bak，
  // 否则模拟盘重置后的空 state 会在重启时被旧 bak 回滚。
  const backup = await readJsonFileOptional(`${filePath}.bak`);
  if (backup) {
    console.warn(`Polymarket state recovered from backup for ${filePath}`);
    try {
      await writeFile(filePath, `${JSON.stringify(backup)}\n`, 'utf8');
    } catch (error) {
      console.warn(`Polymarket failed to rewrite primary from bak for ${filePath}: ${error.message}`);
    }
  }
  return backup;
}

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  // 紧凑 JSON：多计划 state 可达数 MB，pretty-print 会显著拖慢每次落盘与备份
  const payload = `${JSON.stringify(data)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const backupPath = `${filePath}.bak`;
  await writeFile(tmpPath, payload, 'utf8');
  try {
    // 仅用文件大小判断是否值得备份，避免每次写盘都 parse 数 MB JSON
    const existingStat = await stat(filePath);
    if (existingStat.size > 64) {
      await rename(filePath, backupPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rename(tmpPath, filePath);
  // 重置后的空账户也同步一份 bak，避免旧 bak 在异常恢复路径里带回历史订单
  if (!bucketHasData(data)) {
    try {
      await writeFile(backupPath, payload, 'utf8');
    } catch {
      // bak 同步失败不影响主文件
    }
  }
}

async function cleanupStaleStateTempFiles(stateDir, { maxAgeMs = 30 * 60 * 1000 } = {}) {
  let entries = [];
  try {
    entries = await readdir(stateDir);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.tmp')) continue;
    const fullPath = join(stateDir, name);
    try {
      const info = await stat(fullPath);
      const age = now - Number(info.mtimeMs || 0);
      // 清理长时间残留的原子写临时文件（含 0 字节半截写）
      if (info.size === 0 || age > maxAgeMs) {
        await unlink(fullPath);
        removed += 1;
      }
    } catch {
      // ignore individual cleanup failures
    }
  }
  if (removed > 0) {
    console.warn(`Polymarket cleaned ${removed} stale state tmp file(s) in ${basename(stateDir)}`);
  }
  return removed;
}

async function repairTruncatedStateFile(statePath) {
  let raw = '';
  try {
    raw = await readFile(statePath, 'utf8');
    JSON.parse(raw);
    return null;
  } catch {
    if (!raw) return null;
  }

  const incompleteIdx = raw.search(/\r?\n\s*\{\s*$/);
  const cutAt = incompleteIdx > 0 ? incompleteIdx : raw.length;
  let head = raw.slice(0, cutAt).trimEnd();
  if (head.endsWith(',')) head = head.slice(0, -1);
  if (!head.includes('"paperOrders"')) return null;

  const lastOrderClose = head.lastIndexOf('\n        },');
  if (lastOrderClose >= 0) {
    head = head.slice(0, lastOrderClose + '\n        },'.length);
  }

  const tail = `,
      "portfolio": {
        "startingCash": 500,
        "cash": 500,
        "portfolioInitialized": true
      },
      "auto": {
        "enabled": false,
        "strategy": "plan1",
        "timeframes": ["5m", "15m"],
        "lastExecutedKeys": []
      },
      "pendingDelayedEntries": {},
      "lastFlipAt": {},
      "daily": { "dateKey": null, "realizedPnl": 0 }
    },
    "plan2": ${JSON.stringify(freshPlanBucket('plan2'))},
    "plan3": ${JSON.stringify(freshPlanBucket('plan3'))}
  },
  "liveControl": ${JSON.stringify(DEFAULT_STATE.liveControl)},
  "liveAuto": ${JSON.stringify(DEFAULT_STATE.liveAuto)},
  "liveOrders": []
}`;

  try {
    const repaired = JSON.parse(`${head}\n      ]${tail}`);
    return repaired;
  } catch {
    return null;
  }
}

function migrateState(parsed = {}) {
  const mergeBucket = mergePlanBucket;
  if (parsed.plans?.plan1 && parsed.plans?.plan2) {
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      plans: Object.fromEntries(
        PLAN_IDS.map((planId) => [planId, mergeBucket(planId, parsed.plans[planId] || {})])
      ),
      liveControl: { ...DEFAULT_STATE.liveControl, ...(parsed.liveControl || {}) },
      liveAuto: {
        ...DEFAULT_STATE.liveAuto,
        ...(parsed.liveAuto || {}),
        lastFlipAt: parsed.liveAuto?.lastFlipAt || {},
        riskControls: {
          ...DEFAULT_STATE.liveAuto.riskControls,
          ...(parsed.liveAuto?.riskControls || {})
        }
      },
      liveOrders: parsed.liveOrders || []
    };
  }
  return {
    plans: {
      plan1: {
        ...freshPlanBucket('plan1'),
        paperOrders: (parsed.paperOrders || []).map((order) => ({ planId: 'plan1', algorithm: 'plan1', ...order })),
        portfolio: parsed.portfolio || freshPlanBucket('plan1').portfolio,
        auto: parsed.auto || freshPlanBucket('plan1').auto,
        daily: parsed.daily || freshPlanBucket('plan1').daily
      },
      plan2: freshPlanBucket('plan2'),
      plan2_5: freshPlanBucket('plan2_5'),
      plan2_6: freshPlanBucket('plan2_6'),
      plan11: freshPlanBucket('plan11'),
    plan13: freshPlanBucket('plan13'),
      plan14: freshPlanBucket('plan14'),
      plan3: freshPlanBucket('plan3'),
      plan3_5: freshPlanBucket('plan3_5'),
      plan3_6: freshPlanBucket('plan3_6'),
      plan5: freshPlanBucket('plan5')
    },
    liveControl: { ...DEFAULT_STATE.liveControl, ...(parsed.liveControl || {}) },
    liveAuto: {
      ...DEFAULT_STATE.liveAuto,
      ...(parsed.liveAuto || {}),
      riskControls: {
        ...DEFAULT_STATE.liveAuto.riskControls,
        ...(parsed.liveAuto?.riskControls || {})
      }
    },
    liveOrders: parsed.liveOrders || []
  };
}

function normalizeTimeframes(timeframes, planId = null) {
  const id = String(planId || '').toLowerCase();
  if (id === PLAN14_ID) return ['5m'];
  const allowed = id === PLAN13_ID
    ? new Set(['15m'])
    : id === 'plan3_6'
    ? new Set(['5m', '15m', '1h', '1d', 'hourly', 'daily', '60m', '24h'])
    : new Set(['5m', '15m']);
  const fallback = id === PLAN13_ID
    ? ['15m']
    : id === 'plan3_6'
      ? [...PLAN3_6_PAPER_TIMEFRAMES]
      : ['5m', '15m'];
  const normalized = (Array.isArray(timeframes) ? timeframes : fallback)
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => {
      if (item === 'hourly' || item === '60m') return '1h';
      if (item === 'daily' || item === '24h') return '1d';
      return item;
    })
    .filter((item) => allowed.has(item));
  const unique = [...new Set(normalized.filter((item) => item === '5m' || item === '15m' || item === '1h' || item === '1d'))];
  return unique.length ? unique : fallback;
}

export const LIVE_AUTO_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];

export function normalizeLiveSymbols(symbols) {
  const allowed = new Set(LIVE_AUTO_SYMBOLS);
  const normalized = (Array.isArray(symbols) ? symbols : ['BTC-USD'])
    .map((item) => String(item || '').toUpperCase().trim())
    .map((item) => (item.endsWith('-USD') ? item : `${item}-USD`))
    .filter((item) => allowed.has(item));
  const unique = [...new Set(normalized)];
  return unique.length ? unique : ['BTC-USD'];
}

function currentDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function formatShanghaiDate(value) {
  return SHANGHAI_DATE_FORMATTER.format(new Date(value || Date.now()));
}

function buildDailyOrderStats(orders) {
  const rows = [];
  for (const timeframe of ['5m', '15m']) {
    const timeframeOrders = orders.filter((order) => order.timeframe === timeframe);
    rows.push(summarizeOrders(`${timeframe} 合计`, timeframeOrders, timeframe, 'all'));
    for (const planId of PLAN_IDS) {
      rows.push(summarizeOrders(`${timeframe} ${planId.toUpperCase()}`, timeframeOrders.filter((order) => order.planId === planId), timeframe, planId));
    }
  }
  return rows;
}

function buildDailyLiveOrderStats(orders) {
  const rows = [];
  for (const timeframe of ['5m', '15m']) {
    const timeframeOrders = orders.filter((order) => order.timeframe === timeframe);
    rows.push(summarizeLiveOrders(`${timeframe} 实盘`, timeframeOrders, timeframe));
    for (const planId of PLAN_IDS) {
      rows.push(summarizeLiveOrders(
        `${timeframe} ${planId.toUpperCase()} 实盘`,
        timeframeOrders.filter((order) => normalizeLiveOrderPlanId(order) === planId),
        timeframe,
        planId
      ));
    }
  }
  for (const planId of PLAN_IDS) {
    rows.push(summarizeLiveOrders(
      `${planId.toUpperCase()} 实盘合计`,
      orders.filter((order) => normalizeLiveOrderPlanId(order) === planId),
      'all',
      planId
    ));
  }
  rows.push(summarizeLiveOrders('实盘合计', orders, 'all'));
  return rows;
}

export function resolveOrderEntryType(order = {}) {
  return String(order.entryType || order.plan?.entryType || '').toLowerCase();
}

export function isPlan2HoldToExpiryEntryType(entryOrOrder = '') {
  const entry = typeof entryOrOrder === 'object' && entryOrOrder !== null
    ? resolveOrderEntryType(entryOrOrder)
    : String(entryOrOrder || '').toLowerCase();
  return entry === 'settlement_capture_90';
}

export function resolvePlanFromEntryType(entryType = '') {
  const entry = String(entryType || '').toLowerCase();
  // Historical wallet-follow orders keep plan4 attribution for analytics.
  if (entry === 'wallet_follow' || entry === 'wallet_follow_add') return 'plan4';
  if (entry === 'pm_lock_strength' || entry === 'pm_lock_add' || entry === 'pre_open') return 'plan5';
  if (entry === 'settlement_capture' || entry === 'settlement_capture_early') return 'plan3';
  if (entry === 'settlement_capture_90') return 'plan2';
  if (/^(probe|main|late_capture|late|sustained|reversal|ultra_late|settlement_capture_90|cross_follow)/.test(entry)) return 'plan2';
  return 'plan1';
}

export function normalizeLiveOrderPlanId(order = {}) {
  const id = String(order.planId || '').toLowerCase();
  if (PLAN_IDS.includes(id)) return id;
  return resolvePlanFromEntryType(order.entryType);
}

function buildLiveStatsByPlan(allOrders = [], closedBuys = []) {
  const buyOrders = allOrders.filter((order) => order.orderSide !== 'SELL');
  const stats = {};
  for (const planId of PLAN_IDS) {
    const planClosed = closedBuys.filter((order) => normalizeLiveOrderPlanId(order) === planId);
    const planBuys = buyOrders.filter((order) => normalizeLiveOrderPlanId(order) === planId);
    const investedUsd = planClosed.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
    const realizedPnl = planClosed.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
    const wins = planClosed.filter((order) => Number(order.pnl) > 0).length;
    const losses = planClosed.filter((order) => Number(order.pnl) < 0).length;
    stats[planId] = {
      orderCount: planBuys.length,
      settledTrades: planClosed.length,
      wins,
      losses,
      investedUsd: round2(investedUsd),
      realizedPnl: round2(realizedPnl),
      totalReturn: investedUsd > 0 ? round4(realizedPnl / investedUsd) : 0
    };
  }
  return stats;
}

function summarizeOrders(label, orders, timeframe, planId) {
  const wins = orders.filter((order) => order.won).length;
  const losses = orders.length - wins;
  const pnl = orders.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
  return {
    label,
    timeframe,
    planId,
    total: orders.length,
    wins,
    losses,
    accuracy: orders.length ? wins / orders.length : 0,
    pnl: round2(pnl)
  };
}

function summarizeLiveOrders(label, orders, timeframe, planId = 'all') {
  const closedBuys = orders.filter((order) => (
    order.orderSide !== 'SELL'
    && order.positionStatus === 'closed'
    && order.exitStatus !== 'expired-unfilled'
    && Number.isFinite(Number(order.pnl))
  ));
  const wins = closedBuys.filter((order) => Number(order.pnl) > 0).length;
  const losses = closedBuys.filter((order) => Number(order.pnl) < 0).length;
  const pnl = closedBuys.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
  const investedUsd = closedBuys.reduce((sum, order) => sum + (Number(order.usd) || 0), 0);
  return {
    label,
    timeframe,
    planId,
    total: closedBuys.length,
    wins,
    losses,
    accuracy: closedBuys.length ? wins / closedBuys.length : 0,
    investedUsd: round2(investedUsd),
    pnl: round2(pnl),
    returnPct: investedUsd > 0 ? round4(pnl / investedUsd) : 0,
    submitted: orders.filter((order) => order.status === 'submitted').length,
    pending: orders.filter((order) => order.status === 'pending').length,
    blocked: orders.filter((order) => order.status === 'blocked').length,
    expiredUnfilled: orders.filter((order) => order.exitStatus === 'expired-unfilled').length
  };
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function resolvePaperTakerFeeRate(config = {}) {
  if (config?.paperTakerFeeEnabled !== true) return 0;
  const rate = Number(config.paperTakerFeeRate);
  return Number.isFinite(rate) && rate >= 0 ? rate : 0.07;
}

// FAK buys fill at the best ask, not the midpoint quote; a book ask far above the
// quote means the live limit would not have filled, so paper must not either.
export function resolvePaperExecutableEntryPrice({ direction, sentiment, quotePrice, config = {} }) {
  if (config?.paperExecutableAskFillEnabled !== true) return quotePrice;
  const ask = Number(direction === 'up' ? sentiment?.upBestAsk : sentiment?.downBestAsk);
  if (!(ask > 0 && ask < 1)) return quotePrice;
  const quote = Number(quotePrice);
  const maxGap = Number(config.paperMaxAskQuoteGap);
  if (quote > 0 && quote < 1 && Number.isFinite(maxGap) && maxGap > 0 && ask - quote > maxGap + 1e-9) {
    throw new Error(
      `纸面：卖一 ${(ask * 100).toFixed(1)}¢ 比报价 ${(quote * 100).toFixed(1)}¢ 高出超过 ${(maxGap * 100).toFixed(0)}¢，按 FAK 视为未成交。`
    );
  }
  if (quote > 0 && quote < 1 && Number.isFinite(maxGap) && maxGap > 0 && quote - ask > maxGap + 1e-9) {
    throw new Error(
      `纸面：卖一 ${(ask * 100).toFixed(1)}¢ 比报价 ${(quote * 100).toFixed(1)}¢ 低出超过 ${(maxGap * 100).toFixed(0)}¢，盘口快照不一致，不按失真价成交。`
    );
  }
  return ask;
}

// Polymarket charges buy-side taker fees in shares: fee = rate × shares × p × (1 − p) USDC.
export function applyPaperEntryTakerFee(draft, config = {}) {
  const rate = resolvePaperTakerFeeRate(config);
  const price = Number(draft?.entryPrice ?? draft?.limitPrice);
  const grossShares = Number(draft?.shares);
  if (!(rate > 0) || !(price > 0 && price < 1) || !(grossShares > 0)) return draft;
  const feeUsd = polymarketCryptoTakerFee(grossShares, price, rate);
  return {
    ...draft,
    grossShares: round4(grossShares),
    shares: round4(grossShares - feeUsd / price),
    paperEntryFeeUsd: round4(feeUsd),
    paperTakerFeeRate: rate
  };
}

function getLossStreakRisk({
  streak,
  lastLossAtMs,
  nowMs,
  cooldown4Ms,
  cooldown5Ms,
  recoveryScale
}) {
  const count = Number(streak) || 0;
  const lastLoss = Number(lastLossAtMs);
  const now = Number(nowMs) || Date.now();

  if (count >= 5) {
    const cooldown = buildCooldownRisk({ lastLossAtMs: lastLoss, nowMs: now, cooldownMs: cooldown5Ms });
    if (cooldown.cooldownRemainingMs > 0) {
      return { ...cooldown, scale: 0, recoveryMode: 'cooldown' };
    }
    return { scale: recoveryScale, cooldownUntilMs: null, cooldownRemainingMs: 0, recoveryMode: 'recovery' };
  }

  if (count >= 4) {
    const cooldown = buildCooldownRisk({ lastLossAtMs: lastLoss, nowMs: now, cooldownMs: cooldown4Ms });
    if (cooldown.cooldownRemainingMs > 0) {
      return { ...cooldown, scale: 0, recoveryMode: 'cooldown' };
    }
    return { scale: 0.3, cooldownUntilMs: null, cooldownRemainingMs: 0, recoveryMode: 'reduced' };
  }

  if (count >= 3) return { scale: 0.5, cooldownUntilMs: null, cooldownRemainingMs: 0, recoveryMode: 'reduced' };
  if (count >= 2) return { scale: 0.7, cooldownUntilMs: null, cooldownRemainingMs: 0, recoveryMode: 'reduced' };
  return { scale: 1, cooldownUntilMs: null, cooldownRemainingMs: 0, recoveryMode: 'normal' };
}

function getLiveLossWeight(order) {
  const entryType = String(order?.entryType || order?.plan?.entryType || '').toLowerCase();
  if (entryType === 'probe') return 0.5;
  if (entryType === 'cross_follow') return Number.isFinite(Number(order?.sizeMultiplier)) ? Number(order.sizeMultiplier) : 0.35;
  if (entryType === 'sustained_momentum') return 1.3;
  if (entryType === 'late_capture') return 1.2;
  if (entryType === 'ultra_late_capture') return 1.5;
  if (entryType === 'stop_loss_reversal') return 1.1;
  return 1;
}

function isExpiredUnfilledLiveOrder(order) {
  return order?.status === 'expired'
    && order?.exitStatus === 'expired-unfilled'
    && Number(order?.pnl) === 0;
}

function isDustExitStatus(exitStatus) {
  const status = String(exitStatus || '').toLowerCase();
  return status === 'dust-undersized-fill'
    || status === 'dust-unsellable'
    || status.startsWith('dust-');
}

function isDustClosedLiveOrder(order) {
  if (!order || String(order.orderSide || '').toUpperCase() === 'SELL') return false;
  return isDustExitStatus(order.exitStatus);
}

/** Local-only dust flatten rows (no CLOB sell id) that should not appear as 「卖出/平仓」. */
function isSyntheticDustSellOrder(order) {
  if (!order || String(order.orderSide || '').toUpperCase() !== 'SELL') return false;
  if (order.clobOrderId) return false;
  if (isDustExitStatus(order.exitStatus)) return true;
  const text = `${order.exitReason || ''} ${order.note || ''}`;
  return /灰尘仓|成交过小|dust-undersized|dust-unsellable|无法后续止损卖出|无法 CLOB 卖出|invalid maker amount/i.test(text);
}

function isBlockedExitAttemptSell(order) {
  if (!order || String(order.orderSide || '').toUpperCase() !== 'SELL') return false;
  if (String(order.status || '').toLowerCase() !== 'blocked') return false;
  if (order.clobOrderId) return false;
  return /exit blocked/i.test(`${order.note || ''} ${order.error || ''}`);
}

function shouldHideLiveOrderRow(order) {
  return isSyntheticDustSellOrder(order)
    || isBlockedExitAttemptSell(order)
    || isNoisyStructuralBlockedBuy(order);
}

function formatLossStreak(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function buildCooldownRisk({ lastLossAtMs, nowMs, cooldownMs }) {
  if (!Number.isFinite(lastLossAtMs) || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    return { cooldownUntilMs: null, cooldownRemainingMs: 0 };
  }
  const cooldownUntilMs = lastLossAtMs + cooldownMs;
  return {
    cooldownUntilMs,
    cooldownRemainingMs: Math.max(0, cooldownUntilMs - nowMs)
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export {
  computeBinaryPnl,
  isDustExitStatus,
  isDustClosedLiveOrder,
  isSyntheticDustSellOrder,
  isBlockedExitAttemptSell,
  shouldHideLiveOrderRow
};

function computeBinaryPnl({ usd, limitPrice, won }) {
  const cost = Number(usd) || 0;
  const price = Number(limitPrice) || 0;
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return { payoutUsd: 0, pnl: 0 };
  }
  const shares = cost / price;
  const payoutUsd = won ? round2(shares) : 0;
  return { payoutUsd, pnl: round2(payoutUsd - cost), shares: round4(shares) };
}
