// Independently funded entry comparison. Neither ledger can write to the main portfolio.
import { PLAN14_VERSION, PLAN14_PROFIT_EXPERIMENT_VERSION } from './polymarketPlan14.js';
import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';
const round = n => Math.round(n * 100) / 100;
export const PROFIT_EXPERIMENT_ID = 'plan14-entry-ab-20261005-v1';
export function createPlan14ProfitExperiment(nowMs) {
  const lanes = Object.fromEntries(['baseline', 'candidate', 'baselineStress', 'candidateStress'].map(key => [key, {
    version: key.startsWith('baseline') ? PLAN14_VERSION : PLAN14_PROFIT_EXPERIMENT_VERSION,
    slippage: key.endsWith('Stress') ? .01 : 0, cash: 500, invested: 0, realizedPnl: 0,
    filled: 0, settled: 0, wins: 0, skips: 0, open: [], lastFilledTargetMs: {},
    peakEquity: 500, maxRealizedDrawdown: 0
  }]));
  return { id: PROFIT_EXPERIMENT_ID, startedAtIso: new Date(nowMs).toISOString(),
    startingCash: 500, fixedOrderUsd: 10, redemptionDelayMs: 240000, lanes, recentSettlements: [] };
}

export function observePlan14ProfitExperiment(state, plan, sentiment, nowMs, feeRate = .07) {
  const events = [];
  if (!state || state.id !== PROFIT_EXPERIMENT_ID || !plan.profitExperiment || plan.timeframe !== '5m') return events;
  const observedMs = Date.parse(plan.generatedAtIso), targetMs = Date.parse(plan.targetTimeIso);
  const marketSlug = sentiment?.marketSlug || sentiment?.slug;
  if (!marketSlug || !Number.isFinite(observedMs) || !Number.isFinite(targetMs) || observedMs < Date.parse(state.startedAtIso)
    || nowMs < observedMs || nowMs - observedMs > 10000 || targetMs <= nowMs || targetMs - observedMs < 45000) return events;
  // One scan supplies the same spot and both book snapshots to every ledger.
  for (const [key, lane] of Object.entries(state.lanes)) {
    const decision = plan.profitExperiment[key.startsWith('baseline') ? 'baseline' : 'candidate'];
    const model = decision?.model, selected = decision?.selected;
    if (!decision?.allowed || !model?.freshBook || !selected || !['up', 'down'].includes(selected.direction)) continue;
    if ([model.inputs?.quoteTimeMs, model.bookTimeMs?.up, model.bookTimeMs?.down]
      .some(t => !Number.isFinite(t) || nowMs - t < -2000 || nowMs - t > 10000)) continue;
    if ((lane.lastFilledTargetMs[plan.symbol] || 0) >= targetMs) continue;
    const ask = selected.ask + lane.slippage, usd = state.fixedOrderUsd;
    if (!(ask > 0 && ask < 1) || lane.cash + 1e-9 < usd) { lane.skips++; continue; }
    const grossShares = usd / ask, feeUsd = polymarketCryptoTakerFee(grossShares, ask, feeRate);
    const order = { id: `${key}|${plan.symbol}|${targetMs}`, lane: key, symbol: plan.symbol, timeframe: '5m',
      marketSlug, slotIso: plan.slotIso, targetTimeIso: plan.targetTimeIso, direction: selected.direction,
      entryMs: observedMs, targetMs, releaseMs: targetMs + state.redemptionDelayMs,
      ask, usd, shares: grossShares - feeUsd / ask, feeUsd, feeRate,
      p: selected.p, status: 'open', settlementStatus: 'open' };
    lane.cash = round(lane.cash - usd); lane.invested = round(lane.invested + usd); lane.filled++;
    lane.lastFilledTargetMs[plan.symbol] = targetMs; lane.open.push(order);
    events.push({ type: 'entry', experimentId: state.id, order });
  }
  return events;
}

/** Only verified official outcomes can resolve; capital stays reserved until the delay elapses. */
export function resolvePlan14ProfitExperiment(state, marketSlug, outcome, nowMs) {
  if (outcome?.priceSource !== 'polymarket-official' || !['up', 'down'].includes(outcome.actualDirection)) return;
  for (const lane of Object.values(state.lanes)) for (const order of lane.open) {
    if (order.marketSlug !== marketSlug || order.status !== 'open' || nowMs < order.targetMs) continue;
    order.status = 'resolved'; order.actualDirection = outcome.actualDirection;
    order.payoutUsd = order.direction === outcome.actualDirection ? round(order.shares) : 0;
    order.pnl = round(order.payoutUsd - order.usd); order.resolvedAtIso = new Date(nowMs).toISOString();
    order.settlementPriceSource = 'polymarket-official';
  }
}

export function releasePlan14ProfitExperiment(state, nowMs) {
  const events = [];
  for (const [key, lane] of Object.entries(state.lanes)) {
    const targets = [...new Set(lane.open.filter(o => o.status === 'resolved' && o.releaseMs <= nowMs).map(o => o.targetMs))].sort((a,b)=>a-b);
    for (const targetMs of targets) {
      const due = lane.open.filter(o => o.targetMs === targetMs && o.status === 'resolved' && o.releaseMs <= nowMs);
      for (const order of due) {
        lane.cash = round(lane.cash + order.payoutUsd); lane.realizedPnl = round(lane.realizedPnl + order.pnl);
        lane.settled++; if (order.pnl > 0) lane.wins++;
        order.status = 'settled'; order.settlementStatus = 'settled'; order.settledAtIso = new Date(nowMs).toISOString();
        events.push({ type: 'settlement', experimentId: state.id, order: { ...order } });
      }
      lane.open = lane.open.filter(o => o.status !== 'settled');
      const equity = lane.cash + lane.open.reduce((sum,o)=>sum+o.usd,0);
      lane.peakEquity = Math.max(lane.peakEquity, equity);
      lane.maxRealizedDrawdown = round(Math.max(lane.maxRealizedDrawdown, lane.peakEquity - equity));
    }
  }
  state.recentSettlements = [...events.map(e=>e.order), ...state.recentSettlements].slice(0,100);
  return events;
}

export function summarizePlan14ProfitExperiment(state) {
  if (!state) return null;
  const lanes = Object.fromEntries(Object.entries(state.lanes).map(([key,lane])=>[key, {
    version: lane.version, slippage: lane.slippage, cash: lane.cash, invested: lane.invested,
    realizedPnl: lane.realizedPnl, filled: lane.filled, settled: lane.settled, pending: lane.open.length,
    equityAtCost: round(lane.cash + lane.open.reduce((s,o)=>s+o.usd,0)), skips: lane.skips,
    maxRealizedDrawdown: lane.maxRealizedDrawdown
  }]));
  return { id: state.id, startedAtIso: state.startedAtIso, startingCash: state.startingCash,
    fixedOrderUsd: state.fixedOrderUsd, redemptionDelayMs: state.redemptionDelayMs, lanes,
    delta: round(lanes.candidate.realizedPnl - lanes.baseline.realizedPnl),
    stressDelta: round(lanes.candidateStress.realizedPnl - lanes.baselineStress.realizedPnl),
    note: 'Four independent $500/$10 paper ledgers, same fresh quote stream; both policies hold to official settlement with 4-minute minimum redemption delay. Entry comparison only, not the main v9 exit/Kelly account. +1c ledgers stress entry slippage. No depth/latency simulation; no automatic promotion.' };
}
