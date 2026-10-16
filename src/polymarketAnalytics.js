/**
 * Polymarket 数据分析仪表盘聚合（纯函数，便于单测）。
 * 数据源优先 statsDb settled_orders（含 source=paper|live）。
 */
import {
  DEFAULT_AVOIDABLE_LOSS_REASONS,
  LOSS_REASONS,
  RETROSPECTIVE_ONLY_LOSS_REASONS,
  lossReasonLabel
} from './lossReasonTaxonomy.js';
import { summarizeNextSlotPredictions } from './nextSlotPrediction.js';
import { buildConfidenceCalibrationTable } from './polymarketCalibration.js';

const REVERSAL_REASONS = new Set([
  LOSS_REASONS.POST_ENTRY_PM_REVERSAL,
  LOSS_REASONS.SHORT_WINDOW_REVERSAL,
  LOSS_REASONS.FLIP_INTO_ENTRY,
  LOSS_REASONS.REVERSAL_STOP_LOSS
]);

const STOP_LOSS_STATUSES = new Set([
  'stop-loss',
  'soft-stop-loss',
  'hard-stop-loss',
  'reversal-stop-loss',
  'time-stop'
]);

const TAKE_PROFIT_STATUSES = new Set([
  'take-profit',
  'take_profit',
  'tp',
  'trailing-take-profit',
  'dynamic-take-profit'
]);

const EXPIRY_STATUSES = new Set([
  'expiry',
  'settled',
  'expired',
  'hold-to-expiry',
  'settlement'
]);

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e4) / 1e4;
}

function normalizeSymbol(symbol) {
  if (!symbol) return 'BTC-USD';
  return String(symbol).toUpperCase();
}

function plan14PriceBand(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '未知';
  if (p < 0.40) return '<40¢';
  if (p < 0.70) return '40–70¢';
  if (p < 0.80) return '70–80¢';
  if (p < 0.90) return '80–90¢';
  return '≥90¢';
}

function plan16PriceBand(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '未知';
  if (p < 0.20) return '8–20¢';
  if (p < 0.40) return '20–40¢';
  if (p < 0.60) return '40–60¢';
  return '60–80¢';
}

function plan21WindowLabel(order) {
  const minutes = Number(order.plan21Entry?.windowMinutes);
  if (minutes === 4) return '还剩约 4 分钟 · 20–35¢';
  if (minutes === 3) return '还剩约 3 分钟 · 10–20¢';
  if (minutes === 2) return '还剩约 2 分钟 · 10–35¢';
  return '未知窗口';
}

function plan21PriceBand(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '未知';
  if (p < 0.10) return '<10¢';
  if (p < 0.20) return '10–20¢';
  if (p < 0.35) return '20–35¢';
  return '≥35¢';
}

function plan17PriceBand(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '未知';
  if (p < 0.10) return '<10¢';
  if (p < 0.25) return '10–25¢';
  if (p < 0.50) return '25–50¢';
  if (p < 0.75) return '50–75¢';
  return '≥75¢';
}

function plan15PriceBand(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return '未知';
  if (p < 0.50) return '40–50¢';
  if (p < 0.60) return '50–60¢';
  return '60–70¢';
}

function bucketSettledOrders(orders, keyFn) {
  const buckets = {};
  for (const order of orders) {
    const key = keyFn(order);
    if (!buckets[key]) buckets[key] = emptyBucket();
    bumpOrderBucket(buckets[key], order);
  }
  return buckets;
}

function emptyBucket() {
  return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 };
}

function bumpOrderBucket(bucket, order) {
  if (order.won == null && !Number.isFinite(Number(order.pnl))) return;
  bucket.total += 1;
  const won = order.won === true || (order.won == null && Number(order.pnl) > 0);
  if (won) bucket.wins += 1;
  else if (order.won === false || Number(order.pnl) < 0) bucket.losses += 1;
  bucket.totalPnl = round2(bucket.totalPnl + (Number(order.pnl) || 0));
  bucket.winRate = bucket.total ? round4(bucket.wins / bucket.total) : 0;
}

function classifyExitFamily(exitStatus) {
  const key = String(exitStatus || '').toLowerCase();
  if (TAKE_PROFIT_STATUSES.has(key) || key.includes('take-profit') || key.includes('take_profit')) {
    return 'take-profit';
  }
  if (STOP_LOSS_STATUSES.has(key) || key.includes('stop')) return 'stop-loss';
  if (EXPIRY_STATUSES.has(key) || key.includes('expir') || key.includes('settle')) return 'expiry';
  if (!key) return 'unknown';
  return key;
}

function isSettledOrder(order) {
  if (!order) return false;
  if (order.exitStatus === 'expired-unfilled') return false;
  if (order.won != null) return true;
  if (order.settlementStatus === 'settled') return true;
  if (order.positionStatus === 'closed') return true;
  return Number.isFinite(Number(order.pnl));
}

/**
 * 过滤已结算订单。
 */
export function filterAnalyticsOrders(orders = [], {
  planId = null,
  source = 'all',
  symbol = null,
  lookbackDays = null
} = {}) {
  const want = String(source || 'all').toLowerCase();
  const normalizedSymbol = symbol ? normalizeSymbol(symbol) : null;
  const cutoffMs = Number.isFinite(Number(lookbackDays)) && Number(lookbackDays) > 0
    ? Date.now() - Number(lookbackDays) * 86_400_000
    : null;

  return (orders || []).filter((order) => {
    if (!isSettledOrder(order)) return false;
    if (planId && String(order.planId || '') !== String(planId)) return false;
    if (want !== 'all' && String(order.source || '').toLowerCase() !== want) return false;
    if (normalizedSymbol && normalizeSymbol(order.symbol || 'BTC-USD') !== normalizedSymbol) return false;
    if (cutoffMs != null) {
      const settledMs = Date.parse(order.settledAtIso || order.closedAtIso || order.updatedAtIso || '');
      if (Number.isFinite(settledMs) && settledMs < cutoffMs) return false;
    }
    return true;
  });
}

export function summarizeOverview(orders = []) {
  const overview = emptyBucket();
  let paper = 0;
  let live = 0;
  for (const order of orders) {
    bumpOrderBucket(overview, order);
    const src = String(order.source || '').toLowerCase();
    if (src === 'live') live += 1;
    else paper += 1;
  }
  return {
    ...overview,
    paperOrders: paper,
    liveOrders: live
  };
}

function normalizeDirection(value) {
  const direction = String(value || '').toLowerCase();
  return direction === 'up' || direction === 'down' ? direction : null;
}

function actualDirectionOf(order = {}) {
  return normalizeDirection(
    order.actualDirection
    || order.lossAnalysis?.detail?.actualDirection
    || order.lossAnalysis?.actualDirection
  );
}

function entryPriceOf(order = {}) {
  const price = Number(order.entryPrice ?? order.limitPrice ?? order.fillPrice);
  return Number.isFinite(price) && price > 0 && price <= 1 ? price : null;
}

function expectedValueSnapshotOf(order = {}) {
  return order.expectedValueGate
    || order.lossAnalysis?.detail?.expectedValueGate
    || order.lossAnalysis?.expectedValueGate
    || null;
}

function signalQualitySnapshotOf(order = {}) {
  return order.signalQuality
    || order.lossAnalysis?.detail?.signalQuality
    || order.lossAnalysis?.signalQuality
    || null;
}

function lockStrengthOf(order = {}) {
  const raw = order.lockStrength
    || order.lossAnalysis?.detail?.lockStrength
    || order.lossAnalysis?.lockStrength
    || null;
  return ['strong', 'normal', 'weak'].includes(raw) ? raw : null;
}

function decisionTraceOf(order = {}) {
  return order.decisionTrace
    || order.lossAnalysis?.detail?.decisionTrace
    || order.lossAnalysis?.decisionTrace
    || {
      finalDirection: normalizeDirection(order.direction),
      signalDirection: normalizeDirection(order.signalDirection),
      technicalDirection: normalizeDirection(order.technicalDirection),
      spotDirection: normalizeDirection(order.spotDirection),
      directionRecheck: order.directionRecheck || null,
      liveDirectionRecheck: order.liveDirectionRecheck || null,
      marketAlignment: order.marketAlignment || null,
      consensusGate: order.consensusGate || null,
      entryTiming: order.entryTiming || null,
      entryPriceGate: order.entryPriceGate || null,
      historyWinRateGate: order.historyWinRateGate || null,
      winrateGuidanceGate: order.winrateGuidanceGate || null,
      lossReasonGate: order.lossReasonGate || null
    };
}

export function summarizeProfitability(orders = []) {
  const settled = (orders || []).filter((order) => (
    order.won != null || Number.isFinite(Number(order.pnl))
  ));
  const investedUsd = settled.reduce((sum, order) => sum + Math.max(0, Number(order.usd) || 0), 0);
  const totalPnl = settled.reduce((sum, order) => sum + (Number(order.pnl) || 0), 0);
  const priced = settled.filter((order) => Number.isFinite(Number(order.entryPrice ?? order.limitPrice)));
  const avgEntryPrice = priced.length
    ? priced.reduce((sum, order) => sum + Number(order.entryPrice ?? order.limitPrice), 0) / priced.length
    : null;
  const wins = settled.filter((order) => order.won === true || Number(order.pnl) > 0);
  const losses = settled.filter((order) => order.won === false || Number(order.pnl) < 0);
  const actualWinRate = settled.length ? wins.length / settled.length : null;
  const grossProfit = wins.reduce((sum, order) => sum + Math.max(0, Number(order.pnl) || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, order) => sum + Math.min(0, Number(order.pnl) || 0), 0));
  return {
    samples: settled.length,
    investedUsd: round2(investedUsd),
    totalPnl: round2(totalPnl),
    roi: investedUsd > 0 ? round4(totalPnl / investedUsd) : null,
    avgEntryPrice: avgEntryPrice == null ? null : round4(avgEntryPrice),
    actualWinRate: actualWinRate == null ? null : round4(actualWinRate),
    binaryPriceEdge: avgEntryPrice == null || actualWinRate == null
      ? null
      : round4(actualWinRate - avgEntryPrice),
    profitFactor: grossLoss > 0 ? round4(grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0),
    avgWinPnl: wins.length ? round2(grossProfit / wins.length) : 0,
    avgLossPnl: losses.length ? round2(-grossLoss / losses.length) : 0
  };
}

function summarizeDecisionCohort(orders = []) {
  const settled = (orders || []).filter((order) => (
    order.won != null || Number.isFinite(Number(order.pnl))
  ));
  const profitability = summarizeProfitability(settled);
  let directionSamples = 0;
  let directionCorrect = 0;
  let weightedPriceTotal = 0;
  let weightedUsd = 0;

  for (const order of settled) {
    const direction = normalizeDirection(order.direction);
    const actualDirection = actualDirectionOf(order);
    if (direction && actualDirection) {
      directionSamples += 1;
      if (direction === actualDirection) directionCorrect += 1;
    }
    const entryPrice = entryPriceOf(order);
    const usd = Math.max(0, Number(order.usd) || 0);
    if (entryPrice != null && usd > 0) {
      weightedPriceTotal += entryPrice * usd;
      weightedUsd += usd;
    }
  }

  const weightedEntryPrice = weightedUsd > 0 ? weightedPriceTotal / weightedUsd : null;
  const breakEvenWinRate = weightedEntryPrice ?? profitability.avgEntryPrice;
  const observedWinRate = profitability.actualWinRate;
  return {
    total: profitability.samples,
    wins: settled.filter((order) => order.won === true || Number(order.pnl) > 0).length,
    losses: settled.filter((order) => order.won === false || Number(order.pnl) < 0).length,
    winRate: observedWinRate,
    totalPnl: profitability.totalPnl,
    investedUsd: profitability.investedUsd,
    roi: profitability.roi,
    avgEntryPrice: profitability.avgEntryPrice,
    weightedEntryPrice: weightedEntryPrice == null ? null : round4(weightedEntryPrice),
    breakEvenWinRate: breakEvenWinRate == null ? null : round4(breakEvenWinRate),
    priceAdjustedEdge: observedWinRate == null || breakEvenWinRate == null
      ? null
      : round4(observedWinRate - breakEvenWinRate),
    profitFactor: profitability.profitFactor,
    avgWinPnl: profitability.avgWinPnl,
    avgLossPnl: profitability.avgLossPnl,
    directionSamples,
    directionCorrect,
    directionAccuracy: directionSamples ? round4(directionCorrect / directionSamples) : null
  };
}

export function summarizePaperLiveParity(orders = []) {
  const grouped = new Map();
  for (const order of orders || []) {
    const source = String(order.source || '').toLowerCase();
    if (source !== 'paper' && source !== 'live') continue;
    const key = [
      order.planId || 'unknown',
      normalizeSymbol(order.symbol || 'BTC-USD'),
      order.timeframe || '15m',
      order.slotIso || order.targetTimeIso || '',
      order.direction || '',
      order.entryType || ''
    ].join('|');
    if (!grouped.has(key)) grouped.set(key, {});
    grouped.get(key)[source] = order;
  }
  const pairs = [...grouped.values()].filter((row) => row.paper && row.live);
  if (!pairs.length) return { matchedPairs: 0, outcomeAgreement: null, avgLivePriceDelta: null, paperPnl: 0, livePnl: 0 };
  let sameOutcome = 0;
  let priceDeltaSum = 0;
  let priceDeltaCount = 0;
  let paperPnl = 0;
  let livePnl = 0;
  for (const { paper, live } of pairs) {
    const paperWon = paper.won === true || Number(paper.pnl) > 0;
    const liveWon = live.won === true || Number(live.pnl) > 0;
    if (paperWon === liveWon) sameOutcome += 1;
    const pp = Number(paper.entryPrice ?? paper.limitPrice);
    const lp = Number(live.entryPrice ?? live.limitPrice);
    if (Number.isFinite(pp) && Number.isFinite(lp)) {
      priceDeltaSum += lp - pp;
      priceDeltaCount += 1;
    }
    paperPnl += Number(paper.pnl) || 0;
    livePnl += Number(live.pnl) || 0;
  }
  return {
    matchedPairs: pairs.length,
    outcomeAgreement: round4(sameOutcome / pairs.length),
    avgLivePriceDelta: priceDeltaCount ? round4(priceDeltaSum / priceDeltaCount) : null,
    paperPnl: round2(paperPnl),
    livePnl: round2(livePnl),
    pnlGap: round2(livePnl - paperPnl)
  };
}

export function summarizeBySymbol(orders = []) {
  const bySymbol = {};
  for (const order of orders) {
    const symbol = normalizeSymbol(order.symbol || 'BTC-USD');
    if (!bySymbol[symbol]) bySymbol[symbol] = emptyBucket();
    bumpOrderBucket(bySymbol[symbol], order);
  }
  return bySymbol;
}

export function summarizeLossReasons(orders = [], {
  avoidableReasons = DEFAULT_AVOIDABLE_LOSS_REASONS
} = {}) {
  const avoidableSet = new Set((avoidableReasons || []).map(String));
  const retrospectiveSet = new Set(RETROSPECTIVE_ONLY_LOSS_REASONS.map(String));
  const byReason = {};
  let losses = 0;
  let wins = 0;
  let avoidableLosses = 0;
  let retrospectiveLosses = 0;
  let reversalLosses = 0;
  let pmReversalFlagged = 0;

  for (const order of orders) {
    if (order.won === true || (order.won == null && Number(order.pnl) > 0)) {
      wins += 1;
      continue;
    }
    if (order.won !== false && !(Number(order.pnl) < 0)) continue;
    losses += 1;
    const reason = order.lossReason || order.lossAnalysis?.lossReason || LOSS_REASONS.UNKNOWN;
    if (!byReason[reason]) {
      byReason[reason] = {
        reason,
        label: lossReasonLabel(reason) || reason,
        count: 0,
        totalPnl: 0,
        avoidable: avoidableSet.has(reason),
        actionableAtEntry: avoidableSet.has(reason),
        retrospectiveOnly: retrospectiveSet.has(reason),
        classification: avoidableSet.has(reason)
          ? 'entry_observable'
          : retrospectiveSet.has(reason)
            ? 'retrospective'
            : 'descriptive'
      };
    }
    byReason[reason].count += 1;
    byReason[reason].totalPnl = round2(byReason[reason].totalPnl + (Number(order.pnl) || 0));
    if (avoidableSet.has(reason)) avoidableLosses += 1;
    if (retrospectiveSet.has(reason)) retrospectiveLosses += 1;
    if (REVERSAL_REASONS.has(reason)) reversalLosses += 1;
    if (
      order.pmReversal === true
      || order.lossAnalysis?.pmReversal?.anyLargeReversal === true
      || order.lossAnalysis?.pmReversal?.postEntry?.flipped === true
    ) {
      pmReversalFlagged += 1;
    }
  }

  const ranked = Object.values(byReason).sort((a, b) => b.count - a.count);
  return {
    wins,
    losses,
    byReason,
    ranked,
    avoidableLosses,
    avoidableLossShare: losses ? round4(avoidableLosses / losses) : 0,
    actionableLosses: avoidableLosses,
    actionableLossShare: losses ? round4(avoidableLosses / losses) : 0,
    retrospectiveLosses,
    retrospectiveLossShare: losses ? round4(retrospectiveLosses / losses) : 0,
    reversalLosses,
    reversalLossShare: losses ? round4(reversalLosses / losses) : 0,
    pmReversalFlagged,
    pmReversalShareOfLosses: losses ? round4(pmReversalFlagged / losses) : 0
  };
}

export function summarizeReversals(orders = []) {
  const losses = orders.filter((order) => order.won === false || Number(order.pnl) < 0);
  const settled = orders.filter((order) => order.won != null || Number.isFinite(Number(order.pnl)));
  let postEntry = 0;
  let shortWindow = 0;
  let flipInto = 0;
  let pmFlag = 0;
  for (const order of orders) {
    const reason = order.lossReason || order.lossAnalysis?.lossReason || null;
    if (reason === LOSS_REASONS.POST_ENTRY_PM_REVERSAL) postEntry += 1;
    if (reason === LOSS_REASONS.SHORT_WINDOW_REVERSAL) shortWindow += 1;
    if (reason === LOSS_REASONS.FLIP_INTO_ENTRY) flipInto += 1;
    if (
      order.pmReversal === true
      || order.lossAnalysis?.pmReversal?.anyLargeReversal === true
    ) {
      pmFlag += 1;
    }
  }
  return {
    settled: settled.length,
    losses: losses.length,
    postEntryPmReversal: postEntry,
    shortWindowReversal: shortWindow,
    flipIntoEntry: flipInto,
    pmReversalFlagged: pmFlag,
    postEntryShareOfLosses: losses.length ? round4(postEntry / losses.length) : 0,
    pmReversalShareOfSettled: settled.length ? round4(pmFlag / settled.length) : 0,
    pmReversalShareOfLosses: losses.length ? round4(pmFlag / losses.length) : 0
  };
}

/**
 * 用结算结果回看判断链。这里的“事后回溯”只定位模块，不会被当作单笔可提前拦截信号；
 * “入场前可见”分组则同时统计该特征下的盈利单和亏损单，防止只看亏损造成幸存者偏差。
 */
export function summarizeJudgmentDiagnostics(orders = []) {
  const settled = (orders || []).filter(isSettledOrder);
  const hasDirectionOutcome = (order) => (
    Boolean(normalizeDirection(order.direction)) && Boolean(actualDirectionOf(order))
  );
  const directionWrong = (order) => (
    hasDirectionOutcome(order)
    && normalizeDirection(order.direction) !== actualDirectionOf(order)
  );
  const directionCorrectButLost = (order) => (
    hasDirectionOutcome(order)
    && normalizeDirection(order.direction) === actualDirectionOf(order)
    && Number(order.pnl) < 0
  );
  const expectedValueWasNonPositive = (order) => {
    const snapshot = expectedValueSnapshotOf(order);
    const expectedRoi = Number(snapshot?.expectedRoi);
    const conservativeWinRate = Number(snapshot?.conservativeWinRate);
    const entryPrice = entryPriceOf(order);
    return (
      (Number.isFinite(expectedRoi) && expectedRoi <= 0)
      || (
        Number.isFinite(conservativeWinRate)
        && entryPrice != null
        && conservativeWinRate <= entryPrice
      )
    );
  };
  const visibleUnderlyingReversal = (order) => {
    const quality = signalQualitySnapshotOf(order);
    return Number.isFinite(Number(quality?.reverseBps)) && Number(quality.reverseBps) >= 4;
  };
  const visiblePmPullback = (order) => {
    const quality = signalQualitySnapshotOf(order);
    return (
      Number.isFinite(Number(quality?.pullbackFromPeak))
      && Number(quality.pullbackFromPeak) >= 0.025
    );
  };
  const definitions = [
    {
      key: 'direction_model_wrong',
      label: '锁定方向与最终结果相反',
      module: '方向判断',
      evidence: 'retrospective',
      description: '只能用于回溯方向模型，不能直接证明当时可规避。',
      matches: directionWrong
    },
    {
      key: 'direction_correct_but_lost',
      label: '方向正确但交易仍亏损',
      module: '价格 / 退出 / 执行',
      evidence: 'retrospective',
      description: '方向不是主因，应检查成交价、退出方式和费用。',
      matches: directionCorrectButLost
    },
    {
      key: 'negative_ev_snapshot',
      label: '下单时估值已经不覆盖买价',
      module: '估值判断',
      evidence: 'entry_observable',
      description: '下单前已有负期望或保守胜率不高于买价的记录。',
      matches: expectedValueWasNonPositive
    },
    {
      key: 'high_entry_price',
      label: '高价入场（≥85¢）',
      module: '入场估值',
      evidence: 'entry_observable',
      description: '高价本身下单前可见，但是否应过滤必须同时比较该组盈利单。',
      matches: (order) => entryPriceOf(order) != null && entryPriceOf(order) >= 0.85
    },
    {
      key: 'weak_lock_signal',
      label: '弱锁定信号',
      module: '锁定强度',
      evidence: 'entry_observable',
      description: '检查 weak 分级是否具有足够的价格调整后优势。',
      matches: (order) => lockStrengthOf(order) === 'weak'
    },
    {
      key: 'underlying_reversal_visible',
      label: '锁定时已经出现标的反转',
      module: '行情动量',
      evidence: 'entry_observable',
      description: '反转幅度在下单前的信号质量快照中已经可见。',
      matches: visibleUnderlyingReversal
    },
    {
      key: 'pm_pullback_visible',
      label: '锁定时领先方向已经明显回撤',
      module: 'PM 盘口动量',
      evidence: 'entry_observable',
      description: '领先方向回撤在下单前的信号质量快照中已经可见。',
      matches: visiblePmPullback
    },
    {
      key: 'direction_recheck_flipped',
      label: '下单前方向复核发生翻转',
      module: '反转判断',
      evidence: 'entry_observable',
      description: '比较复核翻转后的完整订单组，判断该修正究竟提升还是破坏方向。',
      matches: (order) => (
        decisionTraceOf(order)?.directionRecheck?.flipped === true
        || decisionTraceOf(order)?.liveDirectionRecheck?.flipped === true
      )
    },
    {
      key: 'technical_direction_disagreed',
      label: '最终方向与技术方向冲突',
      module: '技术方向修正',
      evidence: 'entry_observable',
      description: '统计忽略技术方向的订单整体是否仍有正的价格调整后优势。',
      matches: (order) => {
        const trace = decisionTraceOf(order);
        const finalDirection = normalizeDirection(trace?.finalDirection || order.direction);
        const technicalDirection = normalizeDirection(trace?.technicalDirection);
        return Boolean(finalDirection && technicalDirection && finalDirection !== technicalDirection);
      }
    },
    {
      key: 'spot_direction_disagreed',
      label: '最终方向与现货方向冲突',
      module: '现货动量修正',
      evidence: 'entry_observable',
      description: '统计忽略现货方向的订单整体是否仍有正的价格调整后优势。',
      matches: (order) => {
        const trace = decisionTraceOf(order);
        const finalDirection = normalizeDirection(trace?.finalDirection || order.direction);
        const spotDirection = normalizeDirection(trace?.spotDirection);
        return Boolean(finalDirection && spotDirection && finalDirection !== spotDirection);
      }
    },
    {
      key: 'consensus_warning',
      label: '跨币共振曾发出风险提示',
      module: '跨币共振',
      evidence: 'entry_observable',
      description: '比较共振警告下的所有盈亏，判断 3:1 等修正是否真正有效。',
      matches: (order) => {
        const gate = decisionTraceOf(order)?.consensusGate;
        return Boolean(gate && (gate.softReject || gate.sizingOnlyBypass || gate.allowed === false));
      }
    },
    {
      key: 'market_alignment_warning',
      label: '盘口/行情一致性曾发出风险提示',
      module: '行情一致性',
      evidence: 'entry_observable',
      description: '比较一致性警告下的完整订单组，而不是只统计其中的亏损。',
      matches: (order) => {
        const gate = decisionTraceOf(order)?.marketAlignment;
        return Boolean(gate && (gate.softReject || gate.sizingOnlyBypass || gate.allowed === false));
      }
    },
    {
      key: 'entry_timing_warning',
      label: '锁定/入场时机曾发出风险提示',
      module: '锁定时机',
      evidence: 'entry_observable',
      description: '用于判断过早、过晚或稳定时间不足是否造成系统性负贡献。',
      matches: (order) => {
        const gate = decisionTraceOf(order)?.entryTiming;
        return Boolean(gate && (gate.softReject || gate.sizingOnlyBypass || gate.allowed === false));
      }
    },
    {
      key: 'post_entry_reversal',
      label: '入场后才发生反转',
      module: '行情变化',
      evidence: 'retrospective',
      description: '入场后才出现，不能假装成下单时已经知道。',
      matches: (order) => (
        order.pmReversal === true
        || order.lossAnalysis?.pmReversal?.anyLargeReversal === true
        || order.lossAnalysis?.pmReversal?.postEntry?.flipped === true
      )
    }
  ];

  const rows = definitions.map((definition) => {
    const matched = settled.filter(definition.matches);
    return {
      key: definition.key,
      label: definition.label,
      module: definition.module,
      evidence: definition.evidence,
      actionableAtEntry: definition.evidence === 'entry_observable',
      description: definition.description,
      ...summarizeDecisionCohort(matched)
    };
  }).filter((row) => row.total > 0);

  const entryObservableDefinitions = definitions.filter((definition) => definition.evidence === 'entry_observable');
  const losingOrders = settled.filter((order) => order.won === false || Number(order.pnl) < 0);
  const riskEvidenceLosses = losingOrders.filter((order) => (
    entryObservableDefinitions.some((definition) => definition.matches(order))
  )).length;

  const coverage = {
    samples: settled.length,
    actualDirection: settled.filter(hasDirectionOutcome).length,
    lockStrength: settled.filter((order) => lockStrengthOf(order) != null).length,
    expectedValueSnapshot: settled.filter((order) => expectedValueSnapshotOf(order) != null).length,
    signalQualitySnapshot: settled.filter((order) => signalQualitySnapshotOf(order) != null).length,
    decisionTrace: settled.filter((order) => {
      const trace = decisionTraceOf(order);
      return Boolean(
        trace?.directionRecheck
        || trace?.liveDirectionRecheck
        || trace?.signalDirection
        || trace?.technicalDirection
        || trace?.spotDirection
        || trace?.marketAlignment
        || trace?.consensusGate
        || trace?.entryTiming
      );
    }).length
  };
  return {
    coverage,
    rows,
    entryObservable: rows.filter((row) => row.actionableAtEntry),
    retrospective: rows.filter((row) => !row.actionableAtEntry),
    riskEvidenceLosses,
    riskEvidenceLossShare: losingOrders.length ? round4(riskEvidenceLosses / losingOrders.length) : 0
  };
}

export function summarizeExits(orders = []) {
  const byStatus = {};
  const byFamily = {
    'take-profit': emptyBucket(),
    'stop-loss': emptyBucket(),
    expiry: emptyBucket(),
    other: emptyBucket()
  };

  for (const order of orders) {
    const status = String(order.exitStatus || 'unknown').toLowerCase() || 'unknown';
    if (!byStatus[status]) byStatus[status] = emptyBucket();
    bumpOrderBucket(byStatus[status], order);

    const family = classifyExitFamily(status);
    const familyKey = ['take-profit', 'stop-loss', 'expiry'].includes(family) ? family : 'other';
    bumpOrderBucket(byFamily[familyKey], order);
  }

  const tp = byFamily['take-profit'];
  const sl = byFamily['stop-loss'];
  const early = tp.total + sl.total;
  return {
    byStatus,
    byFamily,
    takeProfitHitRate: early ? round4(tp.total / early) : null,
    stopLossHitRate: early ? round4(sl.total / early) : null,
    tpWinRate: tp.winRate,
    slWinRate: sl.winRate,
    expiryWinRate: byFamily.expiry.winRate
  };
}

export function summarizeLockStrengthBuckets(orders = []) {
  const grouped = { strong: [], normal: [], weak: [], unknown: [] };
  for (const order of orders) {
    const raw = lockStrengthOf(order);
    const key = ['strong', 'normal', 'weak'].includes(raw) ? raw : 'unknown';
    grouped[key].push(order);
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([key, cohort]) => [key, summarizeDecisionCohort(cohort)])
  );
}

export function summarizeCrossFollow(orders = []) {
  const crossOrders = orders.filter((order) => (
    order.entryType === 'cross_follow'
    || order.crossSymbolAligned != null
    || order.crossSymbolLeader
    || order.lossReason === LOSS_REASONS.CROSS_FOLLOW_FAILED
  ));
  const overview = emptyBucket();
  let aligned = 0;
  let failed = 0;
  for (const order of crossOrders) {
    bumpOrderBucket(overview, order);
    if (order.crossSymbolAligned === true) aligned += 1;
    if (order.lossReason === LOSS_REASONS.CROSS_FOLLOW_FAILED) failed += 1;
  }
  return {
    ...overview,
    aligned,
    failed,
    failedShareOfCross: overview.total ? round4(failed / overview.total) : 0
  };
}

function summarizeCalibrationCompact(orders = []) {
  const table = buildConfidenceCalibrationTable(orders);
  const buckets = Object.values(table || {})
    .filter((row) => row?.sampleCount > 0)
    .sort((a, b) => (b.sampleCount || 0) - (a.sampleCount || 0))
    .slice(0, 24);
  const byConf = {};
  for (const row of buckets) {
    const key = row.confidenceBucket || 'unknown';
    if (!byConf[key]) byConf[key] = { confidenceBucket: key, sampleCount: 0, wins: 0, losses: 0, totalPnl: 0 };
    byConf[key].sampleCount += row.sampleCount || 0;
    byConf[key].wins += row.wins || 0;
    byConf[key].losses += row.losses || 0;
    byConf[key].totalPnl = round2(byConf[key].totalPnl + (row.avgPnl || 0) * (row.sampleCount || 0));
  }
  for (const key of Object.keys(byConf)) {
    const b = byConf[key];
    b.winRate = b.sampleCount ? round4(b.wins / b.sampleCount) : 0;
    b.avgPnl = b.sampleCount ? round2(b.totalPnl / b.sampleCount) : 0;
  }
  return {
    bucketCount: buckets.length,
    buckets,
    byConfidenceBucket: byConf
  };
}

/**
 * 构建仪表盘 payload。
 */
export function buildPolymarketAnalyticsDashboard({
  orders = [],
  planId = null,
  source = 'all',
  symbol = null,
  lookbackDays = 30,
  plan3LossAnalytics = null,
  plan3BandStats = null,
  nextSlotPredictions = null,
  lockStrengthStats = null,
  avoidableReasons = DEFAULT_AVOIDABLE_LOSS_REASONS,
  positionInventory = null
} = {}) {
  const filtered = filterAnalyticsOrders(orders, {
    planId: planId && planId !== 'current' ? planId : null,
    source,
    symbol,
    lookbackDays
  });
  const overview = summarizeOverview(filtered);
  const profitability = summarizeProfitability(filtered);
  const bySymbol = summarizeBySymbol(filtered);
  const lossReasons = summarizeLossReasons(filtered, { avoidableReasons });
  const reversals = summarizeReversals(filtered);
  const judgmentDiagnostics = summarizeJudgmentDiagnostics(filtered);
  const exits = summarizeExits(filtered);
  const calibration = summarizeCalibrationCompact(filtered);

  const planSpecific = {};
  if (!planId || planId === 'plan3') {
    planSpecific.plan3 = {
      bandStats: plan3BandStats || {},
      lossAnalytics: plan3LossAnalytics || null
    };
  }
  if (!planId || planId === 'plan5') {
    planSpecific.plan5 = {
      lockStrengthOrders: summarizeLockStrengthBuckets(
        filtered.filter((order) => order.planId === 'plan5')
      ),
      lockStrengthStats: lockStrengthStats || null,
      nextSlot: nextSlotPredictions
        ? summarizeNextSlotPredictions(nextSlotPredictions)
        : null
    };
  }
  const showCurrent = !planId || ['current', 'plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19', 'plan21'].includes(planId);
  if (showCurrent && (!planId || planId === 'current' || planId === 'plan14')) {
    const plan14Orders = filtered.filter((order) => order.planId === 'plan14');
    planSpecific.plan14 = {
      byPrice: bucketSettledOrders(plan14Orders, (order) => plan14PriceBand(order.limitPrice ?? order.entryPrice)),
      byVersion: bucketSettledOrders(plan14Orders, (order) => order.strategyVersion || '未知版本'),
      open: positionInventory?.plan14 || null
    };
  }
  if (showCurrent && (!planId || planId === 'current' || planId === 'plan15')) {
    const plan15Orders = filtered.filter((order) => order.planId === 'plan15');
    planSpecific.plan15 = {
      byCategory: bucketSettledOrders(plan15Orders, (order) => order.symbol || order.categoryId || '未分类'),
      byPrice: bucketSettledOrders(plan15Orders, (order) => plan15PriceBand(order.limitPrice ?? order.entryPrice)),
      open: positionInventory?.plan15 || null
    };
  }
  if (showCurrent && (!planId || planId === 'current' || planId === 'plan16')) {
    const plan16Orders = filtered.filter((order) => order.planId === 'plan16');
    planSpecific.plan16 = {
      byCity: bucketSettledOrders(plan16Orders, (order) => order.symbol || '未分类'),
      byPrice: bucketSettledOrders(plan16Orders, (order) => plan16PriceBand(order.limitPrice ?? order.entryPrice)),
      open: positionInventory?.plan16 || null
    };
  }
  if (showCurrent && (!planId || planId === 'current' || planId === 'plan17')) {
    const plan17Orders = filtered.filter((order) => order.planId === 'plan17');
    const familyLabel = { hitDaily: '碰线日盘', above: '收盘高于' };
    planSpecific.plan17 = {
      byFamily: bucketSettledOrders(plan17Orders, (order) => `${order.symbol || ''} ${familyLabel[order.plan17Model?.family] || '未知'} · 买${order.outcome || ''}`),
      byPrice: bucketSettledOrders(plan17Orders, (order) => plan17PriceBand(order.limitPrice ?? order.entryPrice)),
      open: positionInventory?.plan17 || null
    };
  }
  for (const id of ['plan18', 'plan19']) {
    if (!(showCurrent && (!planId || planId === 'current' || planId === id))) continue;
    const orders = filtered.filter((order) => order.planId === id);
    planSpecific[id] = {
      byTimeframe: bucketSettledOrders(orders, (order) => `${order.symbol || ''} ${order.timeframe || '1h'}`),
      byDirection: bucketSettledOrders(orders, (order) => `${order.timeframe || '1h'} 买${order.outcome || ''}`),
      byRelation: bucketSettledOrders(orders, (order) => `梅花 ${order.plan18Divination?.meihua?.relation || '未知'} · 买${order.outcome || ''}`),
      byLiuren: bucketSettledOrders(orders, (order) => `小六壬 ${order.plan18Divination?.liuren?.name || '未知'} · 买${order.outcome || ''}`),
      byAgreement: bucketSettledOrders(orders, (order) => (order.plan18Divination?.agree ? '两法一致' : '两法相反')),
      open: positionInventory?.[id] || null
    };
  }
  if (showCurrent && (!planId || planId === 'current' || planId === 'plan21')) {
    const plan21Orders = filtered.filter((order) => order.planId === 'plan21');
    planSpecific.plan21 = {
      byWindow: bucketSettledOrders(plan21Orders, plan21WindowLabel),
      byPrice: bucketSettledOrders(plan21Orders, (order) => plan21PriceBand(order.limitPrice ?? order.entryPrice)),
      open: positionInventory?.plan21 || null
    };
  }

  if (!planId || planId === 'plan2' || planId === 'plan2_5') {
    const targetPlan = planId === 'plan2_5' ? 'plan2_5' : (planId === 'plan2' ? 'plan2' : null);
    const familyOrders = filtered.filter((order) => (
      targetPlan
        ? order.planId === targetPlan
        : (order.planId === 'plan2' || order.planId === 'plan2_5')
    ));
    if (!planId || planId === 'plan2') {
      planSpecific.plan2 = {
        crossFollow: summarizeCrossFollow(
          familyOrders.filter((order) => order.planId === 'plan2')
        )
      };
    }
    if (!planId || planId === 'plan2_5') {
      planSpecific.plan2_5 = {
        crossFollow: summarizeCrossFollow(
          familyOrders.filter((order) => order.planId === 'plan2_5')
        )
      };
    }
  }

  const emptyMessage = filtered.length
    ? null
    : (
      source === 'live'
        ? '暂无实盘结算样本（statsDb / live-state 均无已平仓实盘单）'
        : source === 'paper'
          ? '暂无模拟结算样本'
          : '暂无结算样本'
    );

  return {
    planId: planId || 'all',
    source,
    symbol: symbol || 'all',
    lookbackDays: Number(lookbackDays) || 30,
    sampleCount: filtered.length,
    empty: filtered.length === 0,
    emptyMessage,
    overview,
    profitability,
    paperLiveParity: source === 'all' ? summarizePaperLiveParity(filtered) : null,
    bySymbol,
    lossReasons,
    judgmentDiagnostics,
    reversals,
    exits,
    historyGate: {
      samples: overview.total,
      losses: lossReasons.losses,
      riskEvidenceLosses: judgmentDiagnostics.riskEvidenceLosses,
      riskEvidenceLossShare: judgmentDiagnostics.riskEvidenceLossShare,
      actionableLosses: lossReasons.actionableLosses,
      actionableLossShare: lossReasons.actionableLossShare,
      retrospectiveLosses: lossReasons.retrospectiveLosses,
      retrospectiveLossShare: lossReasons.retrospectiveLossShare,
      topActionable: lossReasons.ranked.filter((row) => row.actionableAtEntry).slice(0, 8),
      topRetrospective: lossReasons.ranked.filter((row) => row.retrospectiveOnly).slice(0, 8),
      // 旧字段保留给仍在使用旧 payload 的页面；含义已收紧为“下单前可识别”。
      avoidableLosses: lossReasons.avoidableLosses,
      avoidableLossShare: lossReasons.avoidableLossShare,
      topAvoidable: lossReasons.ranked.filter((row) => row.actionableAtEntry).slice(0, 8)
    },
    calibration,
    planSpecific
  };
}
