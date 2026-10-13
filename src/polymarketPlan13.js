import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';

/**
 * Plan13 v2 — 15m 单机会、费后正期望版本。
 *
 * 只保留标准入场；四币同窗只执行费后 EV 最高的一笔。DOWN 使用基础门槛，
 * 历史较弱的 UP 额外要求更高置信度、费后 edge 及 Binance 现货方向确认。
 * 不止盈、不止损反手；硬止损需盘口触发后再由技术/现货反转连续确认。
 */

export const PLAN13_ID = 'plan13';
export const PLAN13_VERSION = 'plan13_15m_standard_fee_edge_v2';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function resolvePlan13SpotDirection(signal = {}) {
  const explicit = String(signal?.spotDirection || '').toLowerCase();
  if (explicit === 'up' || explicit === 'down') return explicit;
  const current = Number(signal?.indicators?.currentPrice);
  const base = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  if (!Number.isFinite(current) || !Number.isFinite(base) || current === base) return null;
  return current > base ? 'up' : 'down';
}

export function resolvePlan13ProfileOverrides(config = {}) {
  const entryMin = num(config.plan13EntryMinPrice, 0.65);
  const entryHardMax = num(config.plan13EntryHardMaxPrice, 0.88);
  const entryMax = Math.min(entryHardMax, num(config.plan13EntryMaxPrice, 0.88));
  return {
    plan2ProbeEnabled: false,
    plan2LiveProbeEnabled: false,
    plan2SettlementCapture90Enabled: false,
    plan2UltraLateCaptureEnabled: false,
    plan2LateCaptureEnabled: false,
    plan2SustainedMomentumEnabled: false,
    plan2CrossSymbolFollowEnabled: false,
    plan2StopLossReversalEnabled: false,
    plan2EntryMinPrice: entryMin,
    plan2PaperEntryMinPrice: entryMin,
    plan2EntryMaxPrice: entryMax,
    plan2PaperEntryMaxPrice: entryMax,
    plan2HighEntryDelayMs: 0,
    plan2HighEntryDelayMs5m: 0,
    plan2HighEntryDelayMs15m: 0,
    plan2TakeProfitEnabled: false,
    plan2TrailingTakeProfitEnabled: false,
    plan2StopLossEnabled: config.plan13StopLossEnabled !== false,
    plan2LiveSyncPaperEntryEnabled: config.plan13LiveSyncPaperEntryEnabled === true,
    plan2LiveSyncPaperExitEnabled: false,
    plan13EntryMinPrice: entryMin,
    plan13EntryMaxPrice: entryMax,
    plan13EntryHardMaxPrice: entryHardMax,
    _plan2Profile: PLAN13_ID
  };
}

function rejectAction(action, reason, policy = {}) {
  return {
    ...action,
    shouldTrade: false,
    scheduleDelayedEntry: false,
    scheduleProbeUpgrade: false,
    usd: 0,
    reason,
    strategyVersion: PLAN13_VERSION,
    plan13Policy: { passed: false, ...policy, reason }
  };
}

export function applyPlan13EntryPolicy(action, { timeframe = '15m', signal = {}, config = {} } = {}) {
  if (!action?.shouldTrade) return action;

  const direction = String(action.direction || '').toLowerCase();
  const entryType = String(action.entryType || '').toLowerCase();
  const price = Number(action.limitPrice);
  const confidence = Number.isFinite(Number(action.calibratedConfidence))
    ? Number(action.calibratedConfidence)
    : Number(action.confidence);
  const entryMin = num(config.plan13EntryMinPrice, 0.65);
  const entryMax = Math.min(num(config.plan13EntryHardMaxPrice, 0.88), num(config.plan13EntryMaxPrice, 0.88));
  const feeRate = Math.max(0, num(config.plan13TakerFeeRate, 0.07));
  const feePerShare = Number.isFinite(price) ? polymarketCryptoTakerFee(1, price, feeRate) : NaN;
  const allInCost = Number.isFinite(price) ? price + feePerShare : NaN;
  const edgeAfterFee = Number.isFinite(confidence) && Number.isFinite(allInCost) ? confidence - allInCost : NaN;
  const minEdgeAfterFee = direction === 'up'
    ? num(config.plan13UpMinEdgeAfterFee, 0.05)
    : num(config.plan13MinEdgeAfterFee, 0.02);
  const technicalDirection = String(signal?.technicalDirection || '').toLowerCase() || null;
  const spotDirection = resolvePlan13SpotDirection(signal);
  const policy = {
    timeframe,
    entryType,
    direction,
    price: Number.isFinite(price) ? round(price, 4) : null,
    confidence: Number.isFinite(confidence) ? round(confidence, 6) : null,
    feeRate,
    feePerShare: Number.isFinite(feePerShare) ? round(feePerShare, 6) : null,
    allInCost: Number.isFinite(allInCost) ? round(allInCost, 6) : null,
    edgeAfterFee: Number.isFinite(edgeAfterFee) ? round(edgeAfterFee, 6) : null,
    minEdgeAfterFee,
    technicalDirection,
    spotDirection
  };

  if (timeframe !== '15m') return rejectAction(action, 'Plan13 v2 只交易 15m。', policy);
  if (entryType !== 'standard') return rejectAction(action, `Plan13 v2 只允许 standard 入场（当前 ${entryType || '--'}）。`, policy);
  if (!Number.isFinite(price) || price < entryMin || price > entryMax) {
    return rejectAction(action, `Plan13 v2 入场价须在 ${(entryMin * 100).toFixed(0)}–${(entryMax * 100).toFixed(0)}¢。`, policy);
  }
  if (!Number.isFinite(edgeAfterFee) || edgeAfterFee < minEdgeAfterFee) {
    return rejectAction(action, `Plan13 v2 费后 edge 须 ≥ ${(minEdgeAfterFee * 100).toFixed(1)}%。`, policy);
  }
  if (direction === 'up') {
    const minConfidence = num(config.plan13UpMinConfidence, 0.72);
    if (!Number.isFinite(confidence) || confidence < minConfidence) {
      return rejectAction(action, `Plan13 v2 UP 校准置信度须 ≥ ${(minConfidence * 100).toFixed(0)}%。`, { ...policy, minConfidence });
    }
    if (config.plan13RequireUpSpotAlignment !== false && (technicalDirection !== 'up' || spotDirection !== 'up')) {
      return rejectAction(action, 'Plan13 v2 UP 要求技术方向与 Binance 现货方向同时向上。', policy);
    }
  }

  return {
    ...action,
    strategyVersion: PLAN13_VERSION,
    feePerShare: round(feePerShare, 6),
    allInCost: round(allInCost, 6),
    edgeAfterFee: round(edgeAfterFee, 6),
    plan13Policy: { passed: true, ...policy }
  };
}

export function selectBestPlan13Candidate(rows = []) {
  const candidates = (Array.isArray(rows) ? rows : []).filter(({ view }) => (
    view?.plan?.planId === PLAN13_ID
    && view?.plan?.timeframe === '15m'
    && view?.plan?.action?.shouldTrade === true
    && Number.isFinite(Number(view.plan.action.edgeAfterFee))
    && Number(view.plan.action.edgeAfterFee) > 0
  ));
  candidates.sort((a, b) => (
    Number(b.view.plan.action.edgeAfterFee) - Number(a.view.plan.action.edgeAfterFee)
    || Number(b.view.plan.action.calibratedConfidence ?? b.view.plan.action.confidence)
      - Number(a.view.plan.action.calibratedConfidence ?? a.view.plan.action.confidence)
    || String(a.symbol || '').localeCompare(String(b.symbol || ''))
  ));
  return candidates[0] || null;
}

export function buildPlan13RulesSnapshot(config = {}) {
  const overrides = resolvePlan13ProfileOverrides(config);
  return {
    enabled: config.plan13Enabled !== false,
    liveEnabled: config.plan13LiveEnabled === true,
    strategyVersion: PLAN13_VERSION,
    entryMinPrice: overrides.plan13EntryMinPrice,
    entryMaxPrice: overrides.plan13EntryMaxPrice,
    entryHardMaxPrice: overrides.plan13EntryHardMaxPrice,
    allowedEntryTypes: ['standard'],
    minEdgeAfterFee: num(config.plan13MinEdgeAfterFee, 0.02),
    upMinConfidence: num(config.plan13UpMinConfidence, 0.72),
    upMinEdgeAfterFee: num(config.plan13UpMinEdgeAfterFee, 0.05),
    requireUpSpotAlignment: config.plan13RequireUpSpotAlignment !== false,
    takeProfitEnabled: false,
    trailingTakeProfitEnabled: false,
    stopLossEnabled: overrides.plan2StopLossEnabled !== false,
    stopLossOffset: num(config.plan2StopLossOffset, 0.08),
    stopConfirmSamples: Math.max(2, num(config.plan13StopConfirmSamples, 2)),
    stopConfirmMs: Math.max(0, num(config.plan13StopConfirmMs, 0)),
    stopRequireSpotReversal: config.plan13StopRequireSpotReversal !== false,
    stopLossReversalEnabled: false,
    paperTimeframes: ['15m'],
    liveTimeframes: ['15m'],
    selectionMode: 'highest_positive_fee_adjusted_ev_per_slot',
    exitMode: 'confirmed_hard_sl_hold_to_settlement',
    note: '仅 15m standard；65–88¢；四币同窗只选费后 EV 最高的一笔；UP 加严；止损需技术/现货连续确认且不反手。'
  };
}
