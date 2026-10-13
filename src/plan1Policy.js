import { computeDynamicExitPrices, computeTradeEdge, resolveStopLossAbsoluteFloor } from './polymarketSizing.js';
import { computePmStabilityConfidence } from './polymarketRegime.js';

function parseOptionalBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

export function resolvePlan1MaxEntryPrice(timeframe = '15m', config = {}) {
  if (timeframe === '5m') {
    const tf = Number(config.plan1MaxEntryPrice5m);
    if (Number.isFinite(tf) && tf > 0) return tf;
  } else {
    const tf = Number(config.plan1MaxEntryPrice15m);
    if (Number.isFinite(tf) && tf > 0) return tf;
  }
  const unified = Number(config.plan1MaxEntryPrice);
  if (Number.isFinite(unified) && unified > 0) return unified;
  return 0.70;
}

/** 实盘提交/追价时硬卡上限，防止决策价合规但 FAK 吃到高价。 */
export function assertPlan1LiveEntryPriceAllowed(price, timeframe = '15m', config = {}) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0 || px >= 1) {
    throw new Error('Plan1 执行价无效，拒绝提交。');
  }
  const max = resolvePlan1MaxEntryPrice(timeframe, config);
  if (Number.isFinite(max) && max > 0 && px > max + 1e-9) {
    throw new Error(
      `Plan1 执行价 ${(px * 100).toFixed(1)}% 超过上限 ${(max * 100).toFixed(0)}%，拒绝提交/追价。`
    );
  }
  return px;
}

/** Plan1 最低入场价；15m 默认禁廉价侧 <0.45（历史负 EV），5m 默认不限制。 */
export function resolvePlan1MinEntryPrice(timeframe = '15m', config = {}) {
  if (timeframe === '5m') {
    const tf = Number(config.plan1MinEntryPrice5m);
    if (Number.isFinite(tf) && tf > 0) return tf;
  } else {
    const tf = Number(config.plan1MinEntryPrice15m);
    if (Number.isFinite(tf) && tf > 0) return tf;
  }
  const unified = Number(config.plan1MinEntryPrice);
  if (Number.isFinite(unified) && unified > 0) return unified;
  return timeframe === '15m' ? 0.45 : 0;
}

export function resolvePlan1EntryMinElapsedPct(timeframe = '15m', config = {}) {
  if (timeframe === '5m') {
    const v = Number(config.plan1EntryMinElapsedPct5m);
    if (Number.isFinite(v)) return v;
  } else {
    const v = Number(config.plan1EntryMinElapsedPct15m);
    if (Number.isFinite(v)) return v;
  }
  const fallback = Number(config.plan1EntryMinElapsedPct);
  if (Number.isFinite(fallback)) return fallback;
  return timeframe === '5m' ? 0.08 : 0.08;
}

export function resolvePlan1EntryMaxElapsedPct(timeframe = '15m', config = {}) {
  if (timeframe === '5m') {
    const v = Number(config.plan1EntryMaxElapsedPct5m);
    if (Number.isFinite(v)) return v;
  } else {
    const v = Number(config.plan1EntryMaxElapsedPct15m);
    if (Number.isFinite(v)) return v;
  }
  const fallback = Number(config.plan1EntryMaxElapsedPct);
  if (Number.isFinite(fallback)) return fallback;
  return timeframe === '5m' ? 0.75 : 0.80;
}

export function resolvePlan1FlipEnabled(timeframe = '15m', config = {}) {
  if (timeframe === '5m') {
    return parseOptionalBool(config.plan1DirectionFlipEnabled5m, false);
  }
  return parseOptionalBool(
    config.plan1DirectionFlipEnabled15m,
    parseOptionalBool(config.plan1DirectionFlipEnabled, true)
  );
}

export function resolvePlan1ExitOffsets(entryPrice, config = {}) {
  const entry = Number(entryPrice);
  const fallbackTp = Number(config.plan1TakeProfitOffset) || 0.14;
  const fallbackSl = Number(config.plan1StopLossOffset) || 0.10;
  if (!Number.isFinite(entry) || entry <= 0) {
    return { takeProfitOffset: fallbackTp, stopLossOffset: fallbackSl };
  }
  if (entry <= 0.55) {
    return { takeProfitOffset: 0.16, stopLossOffset: 0.12 };
  }
  if (entry <= 0.65) {
    return { takeProfitOffset: 0.14, stopLossOffset: 0.10 };
  }
  return { takeProfitOffset: 0.10, stopLossOffset: 0.07 };
}

export function computePlan1ExitPrices(entryPrice, config = {}) {
  const offsets = resolvePlan1ExitOffsets(entryPrice, config);
  const stopLossConfig = Object.prototype.hasOwnProperty.call(config, 'plan1StopLossAbsoluteFloor')
    ? { ...config, stopLossAbsoluteFloor: config.plan1StopLossAbsoluteFloor }
    : config;
  return computeDynamicExitPrices(entryPrice, {
    ...offsets,
    absoluteStopLossFloor: resolveStopLossAbsoluteFloor(stopLossConfig)
  });
}

export function resolvePlan1EdgeConfidence(strategies, timeframe = '15m', config = {}, sentiment = null) {
  const tech = strategies?.tech;
  const composite = strategies?.composite;
  const mode = String(config.plan1EdgeConfidenceMode || 'tech_heavy').toLowerCase();
  if (!tech && !composite) return null;
  if (!tech) return Number(composite.confidence) || null;
  if (!composite) return Number(tech.confidence) || null;

  const direction = composite.direction || tech.direction;
  const techConf = direction === 'up' ? Number(tech.upProbability) : Number(tech.downProbability);
  if (mode === 'tech_heavy') {
    const techWeight = Number(config.plan1TechEdgeWeight) || 0.75;
    const pmStability = computePmStabilityConfidence(sentiment);
    return round4(techWeight * techConf + (1 - techWeight) * pmStability);
  }

  const compConf = Number(composite.confidence) || Math.max(composite.upProbability, composite.downProbability);
  const minTechWeight = timeframe === '5m' ? 0.70 : 0.60;
  const techWeight = Math.max(minTechWeight, Number(composite.techWeight) || 0);
  const blended = techWeight * techConf + (1 - techWeight) * compConf;
  return round4(blended);
}

export function computePlan1Edge(edgeConfidence, entryPrice) {
  return computeTradeEdge(edgeConfidence, entryPrice);
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function bucketEntryPrice(price) {
  const p = Number(price);
  if (!Number.isFinite(p)) return 'unknown';
  if (p < 0.50) return '0.35-0.50';
  if (p < 0.60) return '0.50-0.60';
  if (p < 0.70) return '0.60-0.70';
  return '0.70-0.78';
}

function bucketElapsedPct(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return 'unknown';
  if (p < 0.20) return '0-20%';
  if (p < 0.40) return '20-40%';
  if (p < 0.60) return '40-60%';
  if (p < 0.80) return '60-80%';
  return '80-100%';
}

function summarizeOrders(orders) {
  const settled = orders.filter((o) => o.settlementStatus === 'settled');
  const wins = settled.filter((o) => Number(o.pnl) > 0);
  const losses = settled.filter((o) => Number(o.pnl) < 0);
  const winPnls = wins.map((o) => Number(o.pnl) || 0);
  const lossPnls = losses.map((o) => Number(o.pnl) || 0);
  const totalPnl = settled.reduce((s, o) => s + (Number(o.pnl) || 0), 0);
  return {
    count: settled.length,
    wins: wins.length,
    losses: losses.length,
    winRate: settled.length ? wins.length / settled.length : 0,
    totalPnl: round2(totalPnl),
    avgWinPnl: winPnls.length ? round2(winPnls.reduce((a, b) => a + b, 0) / winPnls.length) : 0,
    avgLossPnl: lossPnls.length ? round2(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length) : 0,
    avgWinPct: avgReturnPct(wins),
    avgLossPct: avgReturnPct(losses)
  };
}

function avgReturnPct(orders) {
  const pcts = orders
    .map((o) => {
      const usd = Number(o.usd) || 0;
      const pnl = Number(o.pnl) || 0;
      return usd > 0 ? pnl / usd : null;
    })
    .filter((v) => Number.isFinite(v));
  if (!pcts.length) return 0;
  return round4(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function computePlan1Analytics(paperOrders = []) {
  const plan1 = (paperOrders || []).filter((o) => (o.planId || 'plan1') === 'plan1');
  const settled = plan1.filter((o) => o.settlementStatus === 'settled');
  const overall = summarizeOrders(plan1);

  const byTimeframe = {};
  for (const tf of ['5m', '15m']) {
    byTimeframe[tf] = summarizeOrders(settled.filter((o) => (o.timeframe || '15m') === tf));
  }

  const byExit = {};
  for (const order of settled) {
    const key = order.exitStatus || 'expiry';
    if (!byExit[key]) byExit[key] = [];
    byExit[key].push(order);
  }
  const byExitReason = Object.fromEntries(
    Object.entries(byExit).map(([key, orders]) => [key, summarizeOrders(orders)])
  );

  const byEntryPrice = {};
  for (const order of settled) {
    const key = bucketEntryPrice(order.limitPrice ?? order.entryPrice);
    if (!byEntryPrice[key]) byEntryPrice[key] = [];
    byEntryPrice[key].push(order);
  }
  const byEntryPriceBucket = Object.fromEntries(
    Object.entries(byEntryPrice).map(([key, orders]) => [key, summarizeOrders(orders)])
  );

  const byWindowProgress = {};
  for (const order of settled) {
    const elapsed = order.entryElapsedPct ?? order.plan?.elapsedPct ?? null;
    const key = bucketElapsedPct(elapsed);
    if (!byWindowProgress[key]) byWindowProgress[key] = [];
    byWindowProgress[key].push(order);
  }
  const byWindowProgressBucket = Object.fromEntries(
    Object.entries(byWindowProgress).map(([key, orders]) => [key, summarizeOrders(orders)])
  );

  return {
    overall,
    byTimeframe,
    byExitReason,
    byEntryPriceBucket,
    byWindowProgressBucket
  };
}
