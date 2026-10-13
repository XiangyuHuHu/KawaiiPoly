import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ENTRY_CANDIDATES, chronologicalSplit, qualifies, portfolioReplay, summarize,
  normalizedProbability, clusterInterval, replayExit, netShares } from '../src/plan14Backtest.js';

const folder = resolve(process.argv[2] || 'data/analysis/plan14-backtest-20261004');
const input = JSON.parse(readFileSync(join(folder, 'input.json'), 'utf8'));
const official = JSON.parse(readFileSync(join(folder, 'official-outcomes.json'), 'utf8'));
const round = n => Math.round(n * 100) / 100;
const rows = input.orders.filter(o => o.timeframe === '5m' && o.settlementStatus === 'settled'
  && official[o.marketSlug]?.actualDirection && o.expectedValueGate?.freshBook
  && Number.isFinite(o.expectedValueGate.marketUp) && Number.isFinite(o.expectedValueGate.spotUp)
  && Number(o.shares) > 0 && Number(o.usd) > 0 && Date.parse(o.createdAtIso) < Date.parse(o.targetTimeIso))
  .map(o => { const wins = official[o.marketSlug].actualDirection === o.direction;
    return { id: o.id, symbol: o.symbol, version: o.strategyVersion, direction: o.direction,
      entryMs: Date.parse(o.createdAtIso), targetMs: Date.parse(o.targetTimeIso),
      // Official redemption delays are not reconstructed as instant cash at expiry.
      releaseMs: Math.max(Date.parse(o.targetTimeIso) + 240000, Date.parse(o.settledAtIso)),
      ask: o.limitPrice, cost: o.usd / o.shares, marketUp: o.expectedValueGate.marketUp,
      spotUp: o.expectedValueGate.spotUp, originalP: o.expectedValueGate.pHat, wins,
      usd: o.usd, shares: o.shares, feeRate: o.paperTakerFeeRate ?? 0.07,
      actualPnl: o.pnl, holdPnl: (wins ? o.shares : 0) - o.usd,
      trace: o.plan14ExitObservations || [], traceDropped: o.plan14ExitObservationsDropped || 0,
      exitStatus: o.exitStatus, spotAgeMs: o.expectedValueGate.spotAgeMs,
      elapsed: (Date.parse(o.createdAtIso) - Date.parse(o.slotIso)) / 300000 }; })
  .sort((a, b) => a.entryMs - b.entryMs);
const split = chronologicalSplit(rows);
const strip = ({ trades, ...rest }) => rest;
const table = ENTRY_CANDIDATES.map(candidate => {
  const replay = name => strip(portfolioReplay(split[name].filter(r => qualifies(r, candidate))));
  return { candidate, train: replay('train'), validation: replay('validation'), test: replay('test'),
    all: strip(portfolioReplay(rows.filter(r => qualifies(r, candidate)))) };
});
const eligible = table.filter(r => r.train.n >= 30);
const selected = [...eligible].sort((a, b) => b.train.pnl - a.train.pnl || a.candidate.id.localeCompare(b.candidate.id))[0];
const chosenRows = selected ? rows.filter(r => qualifies(r, selected.candidate)) : [];
const chosenTest = selected ? portfolioReplay(split.test.filter(r => qualifies(r, selected.candidate))) : null;
const byVersion = [...new Set(rows.map(r => r.version))].map(version => {
  const rs = rows.filter(r => r.version === version);
  return { version, actual: summarize(rs, r => r.actualPnl), hold: summarize(rs),
    cheapEntryHold: summarize(rs, r => r.ask < 0.40 ? r.holdPnl : r.actualPnl),
    cheapOrders: rs.filter(r => r.ask < 0.40).length };
});
const priceBands = [[0.10, 0.40], [0.40, 0.65], [0.65, 0.80], [0.80, 0.901]].map(([min, max]) => {
  const rs = rows.filter(r => r.ask >= min && r.ask < max);
  return { min, max, actual: summarize(rs, r => r.actualPnl), hold: summarize(rs),
    officialWinRatePct: round(rs.filter(r => r.wins).length / rs.length * 100),
    averageAsk: round(rs.reduce((s, r) => s + r.ask, 0) / rs.length),
    fixed10: strip(portfolioReplay(rs)) };
});
const day = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const byDay = [...new Set(rows.map(r => day(r.entryMs)))].map(date => ({ date,
  actual: summarize(rows.filter(r => day(r.entryMs) === date), r => r.actualPnl),
  selectedHold: summarize(chosenRows.filter(r => day(r.entryMs) === date)),
  selectedFixed10: strip(portfolioReplay(chosenRows.filter(r => day(r.entryMs) === date))) }));
const score = rs => {
  const metric = prediction => rs.reduce((s, r) => s + (prediction(r) - (r.wins ? 1 : 0)) ** 2, 0) / rs.length;
  return { n: rs.length, originalBrier: metric(r => r.originalP),
    marketBrier: metric(r => r.direction === 'up' ? r.marketUp : 1 - r.marketUp),
    normalizedBrier: metric(r => { const p = normalizedProbability(r.marketUp, r.spotUp); return r.direction === 'up' ? p : 1 - p; }) };
};
const exitPolicies = [{ id: 'hold' }, { id: 'stop25', stop: 0.25 }, { id: 'stop40', stop: 0.40 },
  { id: 'take20', take: 0.20 }, { id: 'stop25_take20', stop: 0.25, take: 0.20 }].map(policy => {
  const results = rows.filter(r => r.trace.length).map(r => ({ row: r, result: replayExit(r, policy) }));
  const known = results.filter(r => r.result.known), unknown = results.filter(r => !r.result.known);
  return { policy, observedOrders: results.length, known: known.length, censored: unknown.length,
    knownPnl: round(known.reduce((s, r) => s + r.result.pnl, 0)),
    knownOriginalPnl: round(known.reduce((s, r) => s + r.row.actualPnl, 0)),
    knownHoldPnl: round(known.reduce((s, r) => s + r.row.holdPnl, 0)),
    conservativeWholeLower: round(known.reduce((s, r) => s + r.result.pnl, 0) + unknown.reduce((s, r) => s + r.result.lower, 0)),
    conservativeWholeUpper: round(known.reduce((s, r) => s + r.result.pnl, 0) + unknown.reduce((s, r) => s + r.result.upper, 0)) };
});
// Independent, same-book opportunity replay; no opposite entry is priced as 1-originalAsk.
const quotes = input.opportunities.filter(q => official[q.marketSlug]?.actualDirection && q.model?.freshBook)
  .sort((a, b) => a.observedAtIso.localeCompare(b.observedAtIso));
function quoteReplay(candidate, recordedCurrent = false, slippage = 0) {
  const chosen = [], keys = new Set();
  for (const quote of quotes) {
    const entryMs = Date.parse(quote.observedAtIso), targetMs = Date.parse(quote.targetTimeIso);
    const key = `${quote.symbol}|${targetMs}`;
    if (keys.has(key) || targetMs - entryMs < 45000 || targetMs - entryMs > 270000) continue;
    const candidates = recordedCurrent ? (quote.decision.allowed ? [quote.decision.selected] : []) : quote.candidates;
    const viable = candidates.filter(c => c && c.bid > 0 && c.ask > c.bid && c.spread <= 0.05 + 1e-9
      && c.ask >= candidate.minPrice && c.ask <= candidate.maxPrice
      && [quote.model.bookTimeMs?.up, quote.model.bookTimeMs?.down, quote.model.inputs?.quoteTimeMs].every(t => Number.isFinite(t) && entryMs - t >= -2000 && entryMs - t <= 10000))
      .map(c => ({ ...c, edge: (c.direction === 'up' ? normalizedProbability(quote.model.marketUp, quote.model.spotUp) : 1 - normalizedProbability(quote.model.marketUp, quote.model.spotUp)) - 10 / netShares(10, c.ask) }))
      .filter(c => recordedCurrent || c.edge >= (candidate.minEdge ?? 0) - 1e-9)
      .sort((a, b) => b.edge - a.edge);
    if (!viable.length) continue;
    const c = viable[0]; keys.add(key);
    chosen.push({ id: key, symbol: quote.symbol, entryMs, targetMs, releaseMs: targetMs + 240000,
      ask: c.ask, feeRate: 0.07, wins: official[quote.marketSlug].actualDirection === c.direction });
  }
  return portfolioReplay(chosen, { slippage });
}
const currentOpportunities = quoteReplay({ minPrice: 0.01, maxPrice: 0.99 }, true);
const proposedOpportunities = selected ? quoteReplay(selected.candidate) : null;
const report = { frozenAtIso: input.frozenAtIso, generatedAtIso: new Date().toISOString(),
  data: { mergedOrders: input.orders.length, primaryOrders: rows.length,
    officialOutcomeMarkets: Object.keys(official).length, primaryWindows: new Set(rows.map(r => r.targetMs)).size,
    first: new Date(rows[0].entryMs).toISOString(), last: new Date(rows.at(-1).entryMs).toISOString(),
    freshQuoteWindows: new Set(quotes.map(q => `${q.symbol}|${q.targetTimeIso}`)).size,
    spotAgesOverTenSeconds: rows.filter(r => r.spotAgeMs > 10000).length },
  assumptions: { startingCash: 500, fixedStake: 10, entryFeeRate: 0.07, redemptionCashDelaySeconds: 240,
    candidateCount: ENTRY_CANDIDATES.length, selection: 'max train absolute profit among >=30 trades; no validation/test optimization',
    limitations: input.limitations.concat(['historic fixed entries are selected by changing versions',
      'price-band exploration saw the full aggregate before temporal scoring; not a pristine blind holdout',
      'latest opportunities span only a few hours and are correlated',
      'no order-book depth or quote-to-fill latency simulation',
      'exit trace censorship prevents complete alternative stop/take-profit backtests']) },
  baseline: { actual: summarize(rows, r => r.actualPnl), hold: summarize(rows),
    cheapEntryHold: summarize(rows, r => r.ask < 0.40 ? r.holdPnl : r.actualPnl),
    fixed10Hold: strip(portfolioReplay(rows)) },
  byVersion, priceBands, byDay, splits: { trainEndIso: split.trainEndIso, validationEndIso: split.validationEndIso,
    trainN: split.train.length, validationN: split.validation.length, testN: split.test.length },
  selected, selectionPassed: !!selected && selected.train.pnl > 0 && selected.validation.pnl > 0 && selected.test.pnl > 0,
  selectedTestClusterInterval: chosenTest ? clusterInterval(chosenTest.trades) : null,
  selectedOneCentAdverseFill: selected ? {
    validation: strip(portfolioReplay(split.validation.filter(r => qualifies(r, selected.candidate)), { slippage: 0.01 })),
    test: strip(portfolioReplay(split.test.filter(r => qualifies(r, selected.candidate)), { slippage: 0.01 })) } : null,
  calibration: { train: score(split.train), validation: score(split.validation), test: score(split.test) },
  exitPolicies, candidateResults: table,
  exploratoryPositiveAllSegments: table.filter(r => r.train.pnl > 0 && r.validation.pnl > 0 && r.test.pnl > 0),
  cheapEntryHoldCaution: 'Exact terminal payout comparison on fixed historical entries/stakes; preserves original exits only for entries >=40c. Not a rerun of Kelly sizing, cash gating, or future entry changes. v7/v8 samples are short and do not supply an independent validation segment.',
  recentFreshOpportunityReplay: { currentEntryHold: strip(currentOpportunities),
    currentEntryAdverseOneCent: strip(quoteReplay({ minPrice: 0.01, maxPrice: 0.99 }, true, 0.01)),
    trainingSelectedEntryHold: proposedOpportunities ? strip(proposedOpportunities) : null,
    trainingSelectedAdverseOneCent: selected ? strip(quoteReplay(selected.candidate, false, 0.01)) : null,
    starting: quotes[0]?.observedAtIso, ending: quotes.at(-1)?.observedAtIso } };
writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ data: report.data, baseline: report.baseline, splits: report.splits, selected,
  selectionPassed: report.selectionPassed, selectedTestClusterInterval: report.selectedTestClusterInterval,
  priceBands, byDay, exitPolicies, recentFreshOpportunityReplay: report.recentFreshOpportunityReplay }, null, 2));
