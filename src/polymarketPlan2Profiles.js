/**
 * Plan2 profiles：
 * - plan2   = 经典（贴近 origin/main：默认同步纸面入场/退出，不默认开增强门控）
 * - plan2_5 = 增强（历史/亏损归因门控、分币胜率仓位、入场严格+退出对齐、纸面 ask 成交 realism）
 * - plan2_6 = 收紧（复用 plan2_5 架构；仅 sustained_momentum + 严格 late_capture）
 */

import {
  PLAN2_6_ID,
  resolvePlan26ProfileOverrides
} from './polymarketPlan2_6.js';
import {
  PLAN13_ID,
  resolvePlan13ProfileOverrides
} from './polymarketPlan13.js';

export const PLAN2_CLASSIC_ID = 'plan2';
export const PLAN2_ENHANCED_ID = 'plan2_5';
export const PLAN2_TIGHT_ID = PLAN2_6_ID;
export const PLAN2_RELAXED_SL_ID = PLAN13_ID;
export const PLAN2_FAMILY_IDS = [PLAN2_CLASSIC_ID, PLAN2_ENHANCED_ID, PLAN2_TIGHT_ID, PLAN2_RELAXED_SL_ID];

export function isPlan2Family(planId) {
  const id = String(planId || '').toLowerCase();
  return id === PLAN2_CLASSIC_ID
    || id === PLAN2_ENHANCED_ID
    || id === PLAN2_TIGHT_ID
    || id === PLAN2_RELAXED_SL_ID;
}

export function normalizePlan2FamilyId(planId) {
  const id = String(planId || '').toLowerCase();
  if (id === PLAN2_RELAXED_SL_ID) return PLAN2_RELAXED_SL_ID;
  if (id === PLAN2_TIGHT_ID) return PLAN2_TIGHT_ID;
  if (id === PLAN2_ENHANCED_ID) return PLAN2_ENHANCED_ID;
  return PLAN2_CLASSIC_ID;
}

export function plan2FamilyLabel(planId) {
  const id = normalizePlan2FamilyId(planId);
  if (id === PLAN2_RELAXED_SL_ID) return 'Plan13';
  if (id === PLAN2_TIGHT_ID) return 'Plan2.6';
  if (id === PLAN2_ENHANCED_ID) return 'Plan2.5';
  return 'Plan2';
}

function normalizedSet(value, fallback = []) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const normalized = values.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  return new Set(normalized.length ? normalized : fallback);
}

export function evaluatePlan25RecoveryGate({
  symbol,
  timeframe,
  direction,
  technicalDirection,
  spotDirection,
  entryType,
  entryPrice,
  edge,
  config = {}
} = {}) {
  if (config._plan2Profile !== PLAN2_ENHANCED_ID || config.plan25RecoveryGateEnabled !== true) {
    return { allowed: true, enabled: false };
  }
  const symbols = normalizedSet(config.plan25RecoverySymbols, ['eth-usd', 'sol-usd', 'xrp-usd']);
  const timeframes = normalizedSet(config.plan25RecoveryTimeframes, ['15m']);
  const directions = normalizedSet(config.plan25RecoveryDirections, ['down']);
  const entryTypes = normalizedSet(config.plan25RecoveryEntryTypes, ['sustained_momentum']);
  const minPrice = Number.isFinite(Number(config.plan25RecoveryMinPrice)) ? Number(config.plan25RecoveryMinPrice) : 0.55;
  const maxPrice = Number.isFinite(Number(config.plan25RecoveryMaxPrice)) ? Number(config.plan25RecoveryMaxPrice) : 0.86;
  const minEdge = Number.isFinite(Number(config.plan25RecoveryMinEdge)) ? Number(config.plan25RecoveryMinEdge) : 0.02;
  const price = Number(entryPrice);
  const candidateEdge = Number(edge);

  if (!symbols.has(String(symbol || '').toLowerCase())) return { allowed: false, enabled: true, reason: `Plan2.5 recovery excludes ${symbol}.` };
  if (!timeframes.has(String(timeframe || '').toLowerCase())) return { allowed: false, enabled: true, reason: `Plan2.5 recovery excludes ${timeframe}.` };
  if (!directions.has(String(direction || '').toLowerCase())) return { allowed: false, enabled: true, reason: `Plan2.5 recovery excludes ${direction}.` };
  if (String(technicalDirection || '').toLowerCase() !== String(direction || '').toLowerCase()) {
    return { allowed: false, enabled: true, reason: `Plan2.5 recovery requires independent technical alignment (${technicalDirection || '--'} vs ${direction}).` };
  }
  if (String(spotDirection || '').toLowerCase() !== String(direction || '').toLowerCase()) {
    return { allowed: false, enabled: true, reason: `Plan2.5 recovery requires spot/open alignment (${spotDirection || '--'} vs ${direction}).` };
  }
  if (!entryTypes.has(String(entryType || '').toLowerCase())) return { allowed: false, enabled: true, reason: `Plan2.5 recovery excludes ${entryType}.` };
  if (!Number.isFinite(price) || price < minPrice || price > maxPrice) {
    return { allowed: false, enabled: true, reason: `Plan2.5 recovery entry price must be ${minPrice.toFixed(2)}-${maxPrice.toFixed(2)}.` };
  }
  if (!Number.isFinite(candidateEdge) || candidateEdge < minEdge) {
    return { allowed: false, enabled: true, reason: `Plan2.5 recovery edge must be at least ${(minEdge * 100).toFixed(1)}%.` };
  }
  return { allowed: true, enabled: true, cohort: 'non_btc_15m_down_sustained_momentum', minEdge };
}

function resolvePlan25EnhancedConfig(config = {}) {
  // Plan2.5 live entry-max ON by default (wallet safety). Opt out with
  // plan2_5LiveEntryMaxEnabled=false for paper-parity chase experiments only.
  const liveEntryMaxEnabled = config.plan2_5LiveEntryMaxEnabled !== false;
  const entryHardRaw = Number(config.plan2_5EntryHardMaxPrice);
  const entryHardMax = Number.isFinite(entryHardRaw) && entryHardRaw > 0 ? entryHardRaw : 0.92;
  const entryMaxRaw = Number(config.plan2_5EntryMaxPrice);
  const entryMax = liveEntryMaxEnabled
    ? Math.min(
      entryHardMax,
      Number.isFinite(entryMaxRaw) && entryMaxRaw > 0 ? entryMaxRaw : 0.88
    )
    // Open signal band for live (paper still reapplies plan2PaperEntryMaxPrice).
    : 0.99;
  return {
    ...config,
    // 增强版：保留全局门控默认（通常为开），可用 plan25* 显式覆盖
    historyWinRateGateEnabled: config.plan25HistoryWinRateGateEnabled != null
      ? config.plan25HistoryWinRateGateEnabled !== false
      : config.historyWinRateGateEnabled !== false,
    lossReasonGateEnabled: config.plan25LossReasonGateEnabled != null
      ? config.plan25LossReasonGateEnabled !== false
      : config.lossReasonGateEnabled !== false,
    symbolWrSizingEnabled: config.plan25SymbolWrSizingEnabled != null
      ? config.plan25SymbolWrSizingEnabled !== false
      : config.symbolWrSizingEnabled !== false,
    plan2PaperRequireAskFillable: config.plan25PaperRequireAskFillable != null
      ? config.plan25PaperRequireAskFillable !== false
      : config.plan2PaperRequireAskFillable !== false,
    plan2PaperFillSlippageTicks: config.plan25PaperFillSlippageTicks != null
      ? Number(config.plan25PaperFillSlippageTicks)
      : Number(config.plan2PaperFillSlippageTicks) || 0,
    // 入场默认可严格；退出默认同步纸面 OFF —— 实盘保留硬止损（止损必须及时）。
    plan2LiveSyncPaperEntryEnabled: config.plan25LiveSyncPaperEntryEnabled != null
      ? config.plan25LiveSyncPaperEntryEnabled === true
      : (config.plan2LiveSyncPaperEntryEnabled === true),
    plan2LiveSyncPaperExitEnabled: config.plan25LiveSyncPaperExitEnabled != null
      ? config.plan25LiveSyncPaperExitEnabled !== false
      : (config.plan2LiveSyncPaperExitEnabled != null
        ? config.plan2LiveSyncPaperExitEnabled !== false
        : false),
    plan25RecoveryGateEnabled: config.plan25RecoveryGateEnabled === true,
    plan2_5LiveEntryMaxEnabled: liveEntryMaxEnabled,
    // Override shared plan2EntryMax (often 0.62) for Plan2.5 only.
    plan2EntryMaxPrice: entryMax,
    plan2_5EntryMaxPrice: liveEntryMaxEnabled ? entryMax : entryMaxRaw,
    plan2_5EntryHardMaxPrice: entryHardMax,
    _plan2Profile: PLAN2_ENHANCED_ID
  };
}

/**
 * 按 planId 叠加 profile 默认值。显式 env/config 仍可通过 plan2Classic* / plan25* / plan2_6* 覆盖。
 */
export function resolvePlan2ProfileConfig(config = {}, planId = PLAN2_CLASSIC_ID) {
  const id = normalizePlan2FamilyId(planId);

  if (id === PLAN2_RELAXED_SL_ID) {
    const enhanced = resolvePlan25EnhancedConfig(config);
    const relaxed = resolvePlan13ProfileOverrides(config);
    return {
      ...enhanced,
      ...relaxed,
      plan2LiveSyncPaperEntryEnabled: relaxed.plan2LiveSyncPaperEntryEnabled === true,
      plan2LiveSyncPaperExitEnabled: false,
      _plan2Profile: PLAN2_RELAXED_SL_ID
    };
  }

  if (id === PLAN2_TIGHT_ID) {
    const enhanced = resolvePlan25EnhancedConfig(config);
    const tight = resolvePlan26ProfileOverrides(config);
    // Plan2.6: entry may sync paper; exit sync defaults OFF so live hard SL stays on.
    // Explicit POLYMARKET_PLAN26_LIVE_SYNC_PAPER_* wins.
    const syncEntry = config.plan26LiveSyncPaperEntryEnabled != null
      ? config.plan26LiveSyncPaperEntryEnabled === true
      : true;
    const syncExit = config.plan26LiveSyncPaperExitEnabled != null
      ? config.plan26LiveSyncPaperExitEnabled !== false
      : false;
    return {
      ...enhanced,
      ...tight,
      plan2LiveSyncPaperEntryEnabled: syncEntry,
      plan2LiveSyncPaperExitEnabled: syncExit,
      // Keep Plan2.5 gates; only overlay entry allowlist / late thresholds.
      _plan2Profile: PLAN2_TIGHT_ID
    };
  }

  if (id === PLAN2_ENHANCED_ID) {
    return resolvePlan25EnhancedConfig(config);
  }

  // 经典 Plan2：main 风格——默认同步纸面入场/退出，不默认开增强门控与纸面 ask realism
  return {
    ...config,
    historyWinRateGateEnabled: config.plan2ClassicHistoryGateEnabled === true,
    lossReasonGateEnabled: config.plan2ClassicLossReasonGateEnabled === true,
    symbolWrSizingEnabled: config.plan2ClassicSymbolWrSizingEnabled === true,
    plan2PaperRequireAskFillable: config.plan2ClassicPaperRequireAskFillable === true,
    plan2PaperFillSlippageTicks: Number(config.plan2ClassicPaperFillSlippageTicks) || 0,
    // main：LIVE_SYNC_PAPER 开启时实盘入场也走纸面放宽
    plan2LiveSyncPaperEntryEnabled: config.plan2ClassicLiveSyncPaperEntryEnabled != null
      ? config.plan2ClassicLiveSyncPaperEntryEnabled !== false
      : (config.plan2LiveSyncPaperEnabled !== false),
    plan2LiveSyncPaperExitEnabled: config.plan2ClassicLiveSyncPaperExitEnabled != null
      ? config.plan2ClassicLiveSyncPaperExitEnabled !== false
      : (config.plan2LiveSyncPaperEnabled !== false),
    _plan2Profile: PLAN2_CLASSIC_ID
  };
}
