/**
 * Plan1/2/3/5 结算亏损归因：从 exitStatus / entry metadata / 方向结果推导主因。
 * Plan3 优先复用 polymarketPlan3LossAnalytics；本模块做统一落库字段。
 */
import {
  LOSS_REASONS,
  LOSS_REASON_LABELS,
  lossReasonLabel
} from './lossReasonTaxonomy.js';
import {
  applyPlan3SettlementLossAnalysis,
  classifyPlan3LossReason,
  PLAN3_LOSS_REASONS
} from './polymarketPlan3LossAnalytics.js';

const PLAN3_TO_UNIFIED = Object.freeze({
  [PLAN3_LOSS_REASONS.DIRECTION_WRONG]: LOSS_REASONS.DIRECTION_WRONG,
  [PLAN3_LOSS_REASONS.FLIP_INTO_ENTRY]: LOSS_REASONS.FLIP_INTO_ENTRY,
  [PLAN3_LOSS_REASONS.POST_ENTRY_PM_REVERSAL]: LOSS_REASONS.POST_ENTRY_PM_REVERSAL,
  [PLAN3_LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV]: LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV,
  [PLAN3_LOSS_REASONS.LATE_ENTRY_EXPENSIVE]: LOSS_REASONS.LATE_ENTRY_EXPENSIVE,
  [PLAN3_LOSS_REASONS.FAK_FILL_WORSE]: LOSS_REASONS.FAK_FILL_WORSE,
  [PLAN3_LOSS_REASONS.UNKNOWN]: LOSS_REASONS.UNKNOWN
});

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

function normalizePlanId(value) {
  const id = String(value || '').toLowerCase();
  if (id === 'plan1' || id === 'plan2' || id === 'plan3' || id === 'plan4' || id === 'plan5') return id;
  return id || null;
}

function resolvePlanId(order = {}) {
  const explicit = normalizePlanId(order.planId);
  if (explicit) return explicit;
  const entry = String(order.entryType || '').toLowerCase();
  if (entry === 'settlement_capture' || entry === 'settlement_capture_early') return 'plan3';
  if (entry === 'lock_strength' || entry.startsWith('plan5') || entry === 'pm_lock_strength' || entry === 'pm_lock_add' || entry === 'pre_open') return 'plan5';
  if (entry === 'wallet_follow') return 'plan4';
  if (/^(probe|main|late_capture|late|sustained|reversal|ultra_late|settlement_capture_90|cross_follow)/.test(entry)) {
    return 'plan2';
  }
  return 'plan1';
}

function isLossOrder(order = {}) {
  const pnl = Number(order.pnl);
  if (Number.isFinite(pnl)) return pnl < 0;
  if (order.won === false) return true;
  if (order.won === true) return false;
  const direction = normalizeDirection(order.direction);
  const actual = normalizeDirection(order.actualDirection);
  if (direction && actual) return direction !== actual;
  return false;
}

function isWinOrder(order = {}) {
  const pnl = Number(order.pnl);
  if (Number.isFinite(pnl)) return pnl > 0;
  if (order.won === true) return true;
  const direction = normalizeDirection(order.direction);
  const actual = normalizeDirection(order.actualDirection);
  if (direction && actual) return direction === actual;
  return false;
}

function normalizeExitStatus(order = {}) {
  return String(order.exitStatus || order.exitReason || '').toLowerCase();
}

function holdMs(order = {}) {
  const entryMs = Date.parse(order.filledAtIso || order.createdAtIso || order.openedAtIso || '');
  const settleMs = Date.parse(order.settledAtIso || order.closedAtIso || '');
  if (!Number.isFinite(entryMs) || !Number.isFinite(settleMs) || settleMs < entryMs) return null;
  return settleMs - entryMs;
}

function classifyStopLossReason(exitStatus) {
  const status = String(exitStatus || '').toLowerCase();
  if (status.includes('hard-stop') || status.includes('hard_stop')) {
    return LOSS_REASONS.HARD_STOP_LOSS;
  }
  if (status.includes('direction-reversal') || status.includes('reversal-stop')) {
    return LOSS_REASONS.REVERSAL_STOP_LOSS;
  }
  if (status.includes('dynamic-stop') || status.includes('soft-stop') || status.includes('soft_stop')) {
    return LOSS_REASONS.SOFT_STOP_LOSS;
  }
  if (status.includes('time-stop') || status.includes('time_stop')) {
    return LOSS_REASONS.TIME_STOP;
  }
  if (status.includes('stop-loss') || status.includes('stop_loss')) {
    return LOSS_REASONS.STOP_LOSS;
  }
  return null;
}

function buildDetail(order = {}, extra = {}) {
  const action = order.action || order.plan?.action || null;
  const signalQuality = order.signalQuality || action?.signalQuality || null;
  const expectedValueGate = order.expectedValueGate || action?.expectedValueGate || null;
  const lockStrength = order.lockStrength || action?.lockStrength || order.plan?.lockStrength || order.intervalPmLock?.strength || null;
  const lockPmGap = round4(order.lockPmGap ?? action?.lockPmGap ?? order.intervalPmLock?.pmGap);
  const decisionTrace = order.decisionTrace || {
    finalDirection: normalizeDirection(order.direction),
    signalDirection: normalizeDirection(order.signalDirection ?? action?.signalDirection),
    technicalDirection: normalizeDirection(order.technicalDirection ?? action?.technicalDirection),
    spotDirection: normalizeDirection(order.spotDirection ?? action?.spotDirection),
    directionRecheck: order.directionRecheck || action?.directionRecheck || null,
    liveDirectionRecheck: order.liveDirectionRecheck || action?.liveDirectionRecheck || null,
    marketAlignment: order.marketAlignment || action?.marketAlignment || null,
    consensusGate: order.consensusGate || action?.consensusGate || null,
    entryTiming: order.entryTiming || action?.entryTiming || null,
    entryPriceGate: order.entryPriceGate || action?.entryPriceGate || null,
    historyWinRateGate: order.historyWinRateGate || action?.historyWinRateGate || null,
    winrateGuidanceGate: order.winrateGuidanceGate || action?.winrateGuidanceGate || null,
    lossReasonGate: order.lossReasonGate || action?.lossReasonGate || null
  };
  const judgmentErrors = [];
  if (Number.isFinite(Number(expectedValueGate?.expectedRoi)) && Number(expectedValueGate.expectedRoi) <= 0) {
    judgmentErrors.push('entry_expected_value_non_positive');
  }
  if (
    Number.isFinite(Number(expectedValueGate?.conservativeWinRate))
    && Number.isFinite(Number(order.entryPrice ?? order.limitPrice))
    && Number(expectedValueGate.conservativeWinRate) <= Number(order.entryPrice ?? order.limitPrice)
  ) {
    judgmentErrors.push('entry_price_exceeded_conservative_win_rate');
  }
  if (lockStrength === 'weak' || (Number.isFinite(lockPmGap) && lockPmGap < 0.06)) {
    judgmentErrors.push('weak_lock_edge');
  }
  if (Number.isFinite(Number(signalQuality?.reverseBps)) && Number(signalQuality.reverseBps) >= 4) {
    judgmentErrors.push('underlying_reversal_already_visible');
  }
  if (Number.isFinite(Number(signalQuality?.pullbackFromPeak)) && Number(signalQuality.pullbackFromPeak) >= 0.025) {
    judgmentErrors.push('pm_leader_pullback_already_visible');
  }
  if (order.pmReversal === true || order.lossAnalysis?.pmReversal?.anyLargeReversal === true) {
    judgmentErrors.push('post_entry_pm_reversal');
  }
  return {
    planId: resolvePlanId(order),
    timeframe: order.timeframe || null,
    entryType: order.entryType || null,
    exitStatus: order.exitStatus || null,
    exitReason: order.exitReason || null,
    direction: normalizeDirection(order.direction),
    actualDirection: normalizeDirection(order.actualDirection),
    entryPrice: round4(order.entryPrice ?? order.limitPrice ?? order.fillPrice),
    exitPrice: round4(order.exitPrice),
    pnl: round2(order.pnl),
    holdMs: holdMs(order),
    lockStrength,
    lockPmGap,
    lockedAtIso: order.lockedAtIso || action?.lockedAtIso || order.intervalPmLock?.lockedAtIso || null,
    signalQuality,
    expectedValueGate,
    decisionTrace,
    strategyVersion: order.strategyVersion || action?.strategyVersion || null,
    judgmentErrors,
    symbol: order.symbol || order.plan?.symbol || null,
    crossSymbolAligned: order.crossSymbolAligned ?? order.plan?.crossSymbolAligned ?? null,
    crossSymbolLeader: order.crossSymbolLeader || order.plan?.crossSymbolLeader || null,
    ...extra
  };
}

function resultPayload({
  isLoss,
  isWin,
  lossReason,
  tags = [],
  detail = {},
  pmReversal = null
}) {
  const reason = isWin ? null : lossReason;
  return {
    isLoss: Boolean(isLoss),
    isWin: Boolean(isWin),
    lossReason: reason,
    lossReasonLabel: reason ? lossReasonLabel(reason) : (isWin ? LOSS_REASON_LABELS[LOSS_REASONS.WIN] : null),
    tags: [...new Set(tags)],
    detail,
    pmReversal
  };
}

/**
 * 通用分类（Plan1/2/5；Plan3 也可直接用，但优先走 Plan3 analytics）。
 */
export function classifyOrderLossReason(order = {}, options = {}) {
  const planId = resolvePlanId(order);
  if (planId === 'plan3' && options.preferPlan3 !== false) {
    return classifyViaPlan3(order, options);
  }

  const detail = buildDetail(order);
  const tags = [];

  if (isWinOrder(order)) {
    return resultPayload({
      isLoss: false,
      isWin: true,
      lossReason: null,
      tags: ['win'],
      detail
    });
  }

  if (!isLossOrder(order)) {
    return resultPayload({
      isLoss: false,
      isWin: false,
      lossReason: null,
      tags: ['flat_or_unsettled'],
      detail
    });
  }

  const exitStatus = normalizeExitStatus(order);
  const direction = normalizeDirection(order.direction);
  const actual = normalizeDirection(order.actualDirection);
  const entryType = String(order.entryType || '').toLowerCase();
  const entryPrice = Number(order.entryPrice ?? order.limitPrice ?? order.fillPrice);
  const hold = holdMs(order);

  // 1) 明确退出路径
  const stopReason = classifyStopLossReason(exitStatus);
  if (stopReason) {
    tags.push(stopReason);
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: stopReason,
      tags,
      detail: { ...detail, classifier: 'exit_status_stop' }
    });
  }

  if (exitStatus.includes('direction-flip') || exitStatus.includes('direction_flip')) {
    tags.push(LOSS_REASONS.DIRECTION_FLIP_LOSS);
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: LOSS_REASONS.DIRECTION_FLIP_LOSS,
      tags,
      detail: { ...detail, classifier: 'direction_flip' }
    });
  }

  // 2) Plan2 跨币跟随失败
  if (planId === 'plan2' && (entryType === 'cross_follow' || detail.crossSymbolAligned === true)) {
    tags.push(LOSS_REASONS.CROSS_FOLLOW_FAILED);
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: LOSS_REASONS.CROSS_FOLLOW_FAILED,
      tags,
      detail: { ...detail, classifier: 'cross_follow' }
    });
  }

  // 3) Plan5 锁定强度误判（到期方向错 + 有 strength）
  if (planId === 'plan5' && detail.lockStrength && direction && actual && direction !== actual) {
    tags.push(LOSS_REASONS.LOCK_STRENGTH_MISJUDGE);
    tags.push(LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS);
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: LOSS_REASONS.LOCK_STRENGTH_MISJUDGE,
      tags,
      detail: {
        ...detail,
        classifier: 'lock_strength',
        judgmentErrors: detail.judgmentErrors.length ? detail.judgmentErrors : ['locked_direction_wrong_at_settlement']
      }
    });
  }

  // 4) 入场过贵（负 EV 高价）
  const highEntry = Number(options.highEntryPrice) || 0.85;
  if (Number.isFinite(entryPrice) && entryPrice >= highEntry) {
    tags.push(LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV);
  }

  // 5) 短窗反转：持仓很短且方向错 / 止损类已覆盖；到期短持仓反向
  const shortHoldMs = Number(options.shortHoldMs) || 90_000;
  if (
    Number.isFinite(hold)
    && hold <= shortHoldMs
    && direction
    && actual
    && direction !== actual
  ) {
    tags.push(LOSS_REASONS.SHORT_WINDOW_REVERSAL);
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: LOSS_REASONS.SHORT_WINDOW_REVERSAL,
      tags,
      detail: { ...detail, classifier: 'short_hold_reversal' }
    });
  }

  // 6) 到期结算输
  if (
    exitStatus.includes('expiry')
    || exitStatus === ''
    || order.exitStatus === 'expiry'
  ) {
    if (tags.includes(LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV)) {
      return resultPayload({
        isLoss: true,
        isWin: false,
        lossReason: LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV,
        tags: [...tags, LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS],
        detail: { ...detail, classifier: 'high_entry_expiry' }
      });
    }
    if (direction && actual && direction !== actual) {
      tags.push(LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS);
      tags.push(LOSS_REASONS.DIRECTION_WRONG);
      return resultPayload({
        isLoss: true,
        isWin: false,
        lossReason: LOSS_REASONS.EXPIRY_SETTLEMENT_LOSS,
        tags,
        detail: { ...detail, classifier: 'expiry' }
      });
    }
  }

  if (tags.includes(LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV)) {
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: LOSS_REASONS.HIGH_ENTRY_NEGATIVE_EV,
      tags,
      detail: { ...detail, classifier: 'high_entry' }
    });
  }

  if (direction && actual && direction !== actual) {
    tags.push(LOSS_REASONS.DIRECTION_WRONG);
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: LOSS_REASONS.DIRECTION_WRONG,
      tags,
      detail: { ...detail, classifier: 'direction_wrong' }
    });
  }

  if (!direction || !actual) {
    return resultPayload({
      isLoss: true,
      isWin: false,
      lossReason: LOSS_REASONS.DATA_INSUFFICIENT,
      tags: [LOSS_REASONS.DATA_INSUFFICIENT],
      detail: { ...detail, classifier: 'data_insufficient' }
    });
  }

  return resultPayload({
    isLoss: true,
    isWin: false,
    lossReason: LOSS_REASONS.UNKNOWN,
    tags: [LOSS_REASONS.UNKNOWN],
    detail: { ...detail, classifier: 'unknown' }
  });
}

function classifyViaPlan3(order, options = {}) {
  const classified = classifyPlan3LossReason(order, options);
  const mapped = classified.lossReason
    ? (PLAN3_TO_UNIFIED[classified.lossReason] || classified.lossReason)
    : null;
  const detail = buildDetail(order, {
    plan3Reason: classified.lossReason || null,
    secondsRemaining: classified.secondsRemaining ?? null,
    fillPrice: classified.fillPrice ?? null,
    intendedLimitPrice: classified.intendedLimitPrice ?? null,
    classifier: 'plan3'
  });

  // Plan3 短窗：5m + 入场后反转 → 额外打 short_window 标签，主因仍用 Plan3 主因
  const tags = [...(classified.tags || [])].map((tag) => PLAN3_TO_UNIFIED[tag] || tag);
  if (
    classified.isLoss
    && mapped === LOSS_REASONS.POST_ENTRY_PM_REVERSAL
    && String(order.timeframe || '') === '5m'
  ) {
    tags.push(LOSS_REASONS.SHORT_WINDOW_REVERSAL);
  }

  return {
    isLoss: classified.isLoss,
    isWin: classified.isWin,
    lossReason: classified.isWin ? null : mapped,
    lossReasonLabel: classified.isWin
      ? LOSS_REASON_LABELS[LOSS_REASONS.WIN]
      : (mapped ? lossReasonLabel(mapped) : classified.lossReasonLabel),
    tags: [...new Set(tags)],
    detail,
    pmReversal: classified.pmReversal || null,
    plan3: classified
  };
}

/**
 * 结算后写入 order.lossReason / lossAnalysis（纸面+实盘共用）。
 * 不改变退出路径时序；仅归因落字段。
 */
export function applySettlementLossAnalysis(order, {
  opportunityLog = [],
  windowTrack = null,
  now = new Date(),
  ...classifyOptions
} = {}) {
  if (!order) return false;
  if (order.exitStatus === 'expired-unfilled') return false;
  if (order.won == null && !Number.isFinite(Number(order.pnl)) && !order.actualDirection) {
    return false;
  }

  const planId = resolvePlanId(order);
  if (planId === 'plan3') {
    applyPlan3SettlementLossAnalysis(order, {
      opportunityLog,
      windowTrack,
      lookbackMs: classifyOptions.lookbackMs,
      extremePrice: classifyOptions.extremePrice,
      highEntryPrice: classifyOptions.highEntryPrice,
      lateSeconds: classifyOptions.lateSeconds,
      now
    });
    // 统一字段：把 Plan3 reason 映射到统一 taxonomy（若尚未映射）
    if (order.lossReason && PLAN3_TO_UNIFIED[order.lossReason]) {
      const unified = PLAN3_TO_UNIFIED[order.lossReason];
      if (order.lossAnalysis) {
        order.lossAnalysis.unifiedLossReason = unified;
        order.lossAnalysis.lossReasonLabel = lossReasonLabel(unified) || order.lossAnalysis.lossReasonLabel;
      }
      order.lossReason = unified;
    }
    return Boolean(order.lossAnalysis);
  }

  const classified = classifyOrderLossReason(order, { ...classifyOptions, preferPlan3: false });
  order.lossAnalysis = {
    ...classified,
    analyzedAtIso: now.toISOString()
  };
  order.lossReason = classified.lossReason;
  if (classified.pmReversal?.anyLargeReversal != null) {
    order.pmReversal = classified.pmReversal.anyLargeReversal === true;
  }
  return true;
}

export { resolvePlanId as resolveLossAnalysisPlanId };
