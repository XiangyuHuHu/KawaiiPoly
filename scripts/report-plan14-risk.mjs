// Read-only experiment report. No state changes or external requests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLAN14_VERSION, PLAN14_V8_VERSION, PLAN14_V7_VERSION, PLAN14_V6_VERSION,
  PLAN14_V5_VERSION, PLAN14_PREVIOUS_VERSION, PLAN14_V3_VERSION } from '../src/polymarketPlan14.js';
import { summarizePlan14ExitControl } from '../src/plan14ExitControl.js';
import { summarizePlan14ProfitExperiment } from '../src/plan14ProfitExperiment.js';

const path = resolve(process.argv[2] || 'data/polymarket/plan14-state.json');
const state = JSON.parse(readFileSync(path, 'utf8'));
const sum = (rows, field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
const round = value => Math.round(value * 100) / 100;
const reports = [PLAN14_V3_VERSION, PLAN14_PREVIOUS_VERSION, PLAN14_V5_VERSION,
  PLAN14_V6_VERSION, PLAN14_V7_VERSION, PLAN14_V8_VERSION, PLAN14_VERSION].map(version => {
  const all = state.paperOrders.filter(order => order.strategyVersion === version);
  const rows = all.filter(order => order.settlementStatus === 'settled');
  const invested = sum(rows, 'usd');
  const pnl = sum(rows, 'pnl');
  const exits = {};
  for (const row of rows) {
    const key = row.exitTrigger === 'net-loss-risk' ? 'risk-stop' : row.exitStatus || 'settlement';
    const group = exits[key] ||= { count: 0, pnl: 0, invested: 0 };
    group.count++;
    group.pnl = round(group.pnl + Number(row.pnl));
    group.invested = round(group.invested + Number(row.usd));
  }
  const knownHolds = rows.filter(row => row.counterfactualOutcomeSource === 'polymarket-official'
    && Number.isFinite(row.counterfactualHoldPnl));
  const modeled = rows.filter(row => Number.isFinite(row.expectedValueGate?.pHat));
  const slots = new Set(rows.map(row => row.slotIso));
  return { version, settled: rows.length, open: all.length - rows.length,
    windows: slots.size, invested: round(invested), pnl: round(pnl),
    roiOnTradedNotionalPct: invested > 0 ? round(pnl / invested * 100) : null,
    pnlPerTrade: rows.length ? round(pnl / rows.length) : null,
    profitableTrades: rows.filter(row => row.pnl > 0).length,
    meanEstimatedProbability: modeled.length
      ? round(modeled.reduce((total, row) => total + row.expectedValueGate.pHat, 0) / modeled.length * 100) : null,
    exits, officialHoldComparison: { matched: knownHolds.length,
      actualPnl: round(sum(knownHolds, 'pnl')), holdPnl: round(sum(knownHolds, 'counterfactualHoldPnl')) },
    traceOrders: all.filter(row => row.plan14ExitObservations?.length).length,
    traceSamplesDropped: sum(all, 'plan14ExitObservationsDropped'),
    inputFetchErrors: sum(all, 'plan14ExitObservationErrors') };
});
const opportunities = state.plan14OpportunityLog || [];
console.log(JSON.stringify({ readAt: new Date().toISOString(), reports,
  exitControlComparison: summarizePlan14ExitControl(state.paperOrders),
  profitExperiment: summarizePlan14ProfitExperiment(state.plan14ProfitExperiment),
  sameQuoteForecasts: { count: opportunities.length, dropped: state.plan14OpportunitiesDropped || 0,
    newOnly: opportunities.filter(x => x.decision.allowed && !x.previous.allowed).length,
    previousOnly: opportunities.filter(x => !x.decision.allowed && x.previous.allowed).length,
    both: opportunities.filter(x => x.decision.allowed && x.previous.allowed).length,
    note: 'Repeated scans, not independent trades; this is not a PnL A/B test.' },
  warning: 'Different time periods and entries are not an A/B test. Less total loss with fewer trades is not proof of improved edge. Hold comparison uses only matched official outcomes; risk thresholds do not guarantee fills.' }, null, 2));
