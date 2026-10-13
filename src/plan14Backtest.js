// Offline analysis only. None of these helpers modifies a trading account.
export const BACKTEST_FEE_RATE = 0.07;
export const netShares = (usd, ask, rate = BACKTEST_FEE_RATE) => usd / ask * (1 - rate * (1 - ask));
export const netSale = (shares, bid, rate = BACKTEST_FEE_RATE) => shares * bid * (1 - rate * (1 - bid));
const round = n => Math.round(n * 100) / 100;
const logit = p => Math.log(Math.max(0.005, Math.min(0.995, p)) / (1 - Math.max(0.005, Math.min(0.995, p))));
export function normalizedProbability(market, spot, weight = 0.23) {
  return 1 / (1 + Math.exp(-(logit(market) + weight * logit(spot)) / (1 + weight)));
}

export const ENTRY_CANDIDATES = [
  ['all', 0.10, 0.90], ['40-90', 0.40, 0.90], ['40-65', 0.40, 0.65],
  ['40-70', 0.40, 0.70], ['50-75', 0.50, 0.75], ['65-90', 0.65, 0.90], ['80-90', 0.80, 0.90]
].flatMap(([name, minPrice, maxPrice]) => [null, 0.01, 0.04].map(minEdge => ({
  id: `${name}_${minEdge == null ? 'historical-entry' : `edge${minEdge}`}_hold`,
  minPrice, maxPrice, minEdge, weight: 0.23
})));

export function qualifies(row, candidate) {
  if (row.ask < candidate.minPrice - 1e-9 || row.ask > candidate.maxPrice + 1e-9) return false;
  if (candidate.minEdge == null) return true;
  const pUp = normalizedProbability(row.marketUp, row.spotUp, candidate.weight);
  const p = row.direction === 'up' ? pUp : 1 - pUp;
  return p - row.cost >= candidate.minEdge - 1e-9;
}

/** Split whole target windows; simultaneous coins must never straddle train/test. */
export function chronologicalSplit(rows) {
  const targets = [...new Set(rows.map(r => r.targetMs))].sort((a, b) => a - b);
  const trainEnd = targets[Math.max(0, Math.floor(targets.length * 0.6) - 1)];
  const validationEnd = targets[Math.max(0, Math.floor(targets.length * 0.8) - 1)];
  return { train: rows.filter(r => r.targetMs <= trainEnd),
    validation: rows.filter(r => r.targetMs > trainEnd && r.targetMs <= validationEnd),
    test: rows.filter(r => r.targetMs > validationEnd),
    trainEndIso: new Date(trainEnd).toISOString(), validationEndIso: new Date(validationEnd).toISOString() };
}

/** Same $500 starting balance, $10 fixed intents; no leverage, no synthetic late fills. */
export function portfolioReplay(rows, { startingCash = 500, stake = 10, slippage = 0 } = {}) {
  let cash = startingCash, realized = 0, maxDrawdown = 0, peak = startingCash, invested = 0, skipped = 0;
  const open = [], trades = [];
  const release = time => {
    const dueTimes = [...new Set(open.filter(t => t.releaseMs <= time).map(t => t.releaseMs))].sort((a, b) => a - b);
    for (const due of dueTimes) {
      // Settle simultaneous coins as a group; array order is not an equity path.
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].releaseMs !== due) continue;
        const t = open.splice(i, 1)[0];
        cash += t.payout; realized += t.pnl;
      }
      const equity = cash + open.reduce((sum, p) => sum + p.usd, 0);
      peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
  };
  const keys = new Set();
  for (const row of [...rows].sort((a, b) => a.entryMs - b.entryMs || a.id.localeCompare(b.id))) {
    if (![row.entryMs, row.targetMs, row.releaseMs].every(Number.isFinite)
      || row.entryMs >= row.targetMs || row.releaseMs < row.targetMs || typeof row.wins !== 'boolean') {
      throw new Error(`Invalid replay timing or official outcome: ${row.id}`);
    }
    release(row.entryMs);
    const key = `${row.symbol}|${row.targetMs}`;
    if (keys.has(key)) continue;
    const ask = row.ask + slippage;
    const cost = ask > 0 && ask < 1 ? ask / (1 - (row.feeRate ?? BACKTEST_FEE_RATE) * (1 - ask)) : NaN;
    // A dynamic sizer only receives features known at entry, never the outcome.
    const usd = typeof stake === 'function' ? stake({ cash, candidate: { ask, cost, p: row.p } }) : stake;
    if (!(usd > 0 && Number.isFinite(usd)) || cash + 1e-9 < usd || !(ask > 0 && ask < 1)) { skipped++; continue; }
    const shares = netShares(usd, ask, row.feeRate);
    const payout = row.wins ? shares : 0;
    const trade = { ...row, usd, ask, payout, pnl: payout - usd };
    cash -= usd; invested += usd; keys.add(key); open.push(trade); trades.push(trade);
  }
  const times = [...new Set(open.map(t => t.releaseMs))].sort((a, b) => a - b);
  for (const time of times) release(time);
  return { n: trades.length, windows: new Set(trades.map(t => t.targetMs)).size,
    pnl: round(realized), endingCash: round(cash), invested: round(invested),
    roiPct: invested ? round(realized / invested * 100) : null,
    maxRealizedDrawdown: round(maxDrawdown), profitable: trades.filter(t => t.pnl > 0).length,
    cashOrPriceSkips: skipped, trades };
}

export function summarize(rows, getter = r => r.holdPnl) {
  return { n: rows.length, windows: new Set(rows.map(r => r.targetMs)).size,
    pnl: round(rows.reduce((sum, r) => sum + getter(r), 0)),
    invested: round(rows.reduce((sum, r) => sum + r.usd, 0)),
    wins: rows.filter(r => getter(r) > 0).length };
}

/** Cluster by entire 5m target window, preserving correlation across coins. */
export function clusterInterval(trades, samples = 3000) {
  const sums = new Map();
  for (const t of trades) sums.set(t.targetMs, (sums.get(t.targetMs) || 0) + t.pnl);
  const groups = [...sums.values()];
  if (groups.length < 2) return null;
  let seed = 47271;
  const random = () => ((seed = Math.imul(1664525, seed) + 1013904223 >>> 0) / 4294967296);
  const distribution = Array.from({ length: samples }, () => groups.reduce(sum => sum + groups[Math.floor(random() * groups.length)], 0)).sort((a, b) => a - b);
  return { lower: round(distribution[Math.floor(samples * 0.025)]),
    upper: round(distribution[Math.floor(samples * 0.975)]), clusters: groups.length,
    note: 'Window-cluster bootstrap; temporal dependence and historical model selection are not removed.' };
}

/** Exit alternatives may only use quotes actually observed before the original exit. */
export function replayExit(row, { stop = null, take = null, adverseTick = 0 } = {}) {
  for (const q of row.trace || []) {
    const now = Date.parse(q.observedAtIso);
    if (now < row.entryMs || now >= row.targetMs || !(q.bid > 0 && q.bid < 1)) continue;
    if (!Number.isFinite(q.bookTimeMs) || now - q.bookTimeMs < -2000 || now - q.bookTimeMs > 10000) continue;
    const proceeds = netSale(row.shares, q.bid, row.feeRate);
    const roi = proceeds / row.usd - 1;
    if ((stop != null && roi <= -stop + 1e-9) || (take != null && roi >= take - 1e-9)) {
      return { known: true, pnl: netSale(row.shares, Math.max(0, q.bid - adverseTick), row.feeRate) - row.usd,
        at: q.observedAtIso, reason: roi < 0 ? 'stop' : 'take' };
    }
  }
  if (stop == null && take == null) return { known: true, pnl: row.holdPnl, reason: 'hold' };
  if (row.exitStatus === 'expiry' && row.trace?.length && row.targetMs - Date.parse(row.trace.at(-1).observedAtIso) <= 10000
    && !row.traceDropped) return { known: true, pnl: row.holdPnl, reason: 'hold-covered-end' };
  return { known: false, reason: 'trace-censored', lower: -row.usd, upper: row.shares - row.usd };
}
