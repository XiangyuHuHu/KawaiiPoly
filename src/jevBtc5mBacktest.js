/**
 * Paper-only Jev-style replay for Polymarket BTC 5-minute Up/Down.
 * Estimates P(Up) from the logged spot/open/time state and the book, then
 * buys at the ask only when the fee-adjusted edge clears a threshold.
 * Nothing here submits an order or reads a trading key.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { estimatePlan14SpotUp, blendPlan14Up } from './polymarketPlan14.js';
import { netShares } from './plan14Backtest.js';
import { buildCryptoUpDownMarketSlug } from './polymarketClient.js';

export const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
export const JEV_DEFAULTS = Object.freeze({
  minEdge: 0.01,
  feeRate: 0.07,
  modelWeight: 0.23,
  stake: 10,
  startingCash: 500,
  minAsk: 0.05,
  maxAsk: 0.95,
  maxSpread: 0.05,
  minRemainingSeconds: 30,
  maxRemainingSeconds: 270,
  maxQuoteAgeMs: 10_000,
  bucketWidth: 0.1,
  seed: 20261016
});

export const DATA_ASSUMPTIONS = Object.freeze([
  'Opportunity rows are sampled quotes (about every few seconds), not a full order book or a trade tape.',
  'A fill is assumed at the logged ask for the whole stake. Depth, queue position, and latency are not simulated.',
  'Fees follow the crypto taker curve: net shares = stake/ask * (1 - feeRate * (1 - ask)). The 0.07 figure is the curve parameter, not a flat 7% commission.',
  'Each 5-minute slot contributes at most one trade, the first quote whose fee-adjusted edge clears the threshold.',
  'Settlement pays $1 or $0 per net share. Official Polymarket resolutions win over a Binance open-to-close proxy. Binance close >= open is labeled Up and is not the Chainlink print Polymarket uses.',
  'The same-ask-bucket baseline, at the same quote, picks a seeded random side whose ask sits in the same price bucket. A one-sided bucket is forced to that side and counted.',
  'Stake is taken from cash already freed by earlier settlements. A slot whose quote qualifies but cannot be funded is skipped once. A missing outcome is not booked as a loss, and its stake is returned at the window end.'
]);

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function sideQuote(candidate) {
  const ask = finite(candidate?.ask);
  const bid = finite(candidate?.bid);
  const spread = finite(candidate?.spread);
  return {
    ask,
    bid,
    spread: Number.isFinite(spread) ? spread : (Number.isFinite(ask) && Number.isFinite(bid) ? ask - bid : NaN)
  };
}

function mid(side) {
  return side.bid > 0 && side.ask > side.bid ? (side.bid + side.ask) / 2 : NaN;
}

/** Book-implied Up probability. Falls back to the logged model mid. */
export function marketUpFromQuote(up, down, loggedMarketUp = NaN) {
  const upMid = mid(up);
  const downMid = mid(down);
  const blended = Number.isFinite(upMid) && Number.isFinite(downMid)
    ? (upMid + (1 - downMid)) / 2
    : (Number.isFinite(upMid) ? upMid : (Number.isFinite(downMid) ? 1 - downMid : NaN));
  if (blended > 0 && blended < 1) return blended;
  return loggedMarketUp > 0 && loggedMarketUp < 1 ? loggedMarketUp : NaN;
}

/**
 * Cost of one net redeemable share after the buy-side taker fee is paid in shares.
 * Equivalent to stake / netShares(stake, ask, feeRate).
 */
export function feeAdjustedCost(ask, feeRate = JEV_DEFAULTS.feeRate) {
  if (!(ask > 0 && ask < 1) || !(feeRate >= 0)) return null;
  const keep = 1 - feeRate * (1 - ask);
  if (!(keep > 0)) return null;
  return ask / keep;
}

/** Model probability minus fee-adjusted cost. Positive means the ask is cheap versus the model. */
export function feeAdjustedEdge(probability, ask, feeRate = JEV_DEFAULTS.feeRate) {
  const cost = feeAdjustedCost(ask, feeRate);
  if (cost == null || !(probability >= 0 && probability <= 1)) return null;
  return probability - cost;
}

export function grossShares(usd, ask) {
  if (!(usd > 0) || !(ask > 0 && ask < 1)) return null;
  return usd / ask;
}

export function calendarDay(ms, timeZone) {
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(ms);
}

export function utcDatesAround(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`Expected YYYY-MM-DD, received ${isoDate}`);
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return [-1, 0, 1].map((shift) => new Date(utc + shift * 86_400_000).toISOString().slice(0, 10));
}

export function readJsonl(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rows = [];
  let partial = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (error) {
      if (i === lines.length - 1) {
        partial += 1;
        continue;
      }
      throw new Error(`${file}:${i + 1}: ${error.message}`);
    }
  }
  return { rows, partial };
}

export function loadResearchDirectory(dir, isoDate) {
  const dates = utcDatesAround(isoDate);
  const opportunityFiles = [];
  const outcomeRows = [];
  const missing = [];
  let partial = 0;
  for (const date of dates) {
    for (const kind of ['opportunities', 'settlements', 'experiments']) {
      const name = `${date}-${kind}.jsonl`;
      const path = join(dir, name);
      if (!existsSync(path)) {
        missing.push(name);
        continue;
      }
      const parsed = readJsonl(path);
      partial += parsed.partial;
      if (kind === 'opportunities') opportunityFiles.push({ name, path, rows: parsed.rows });
      else outcomeRows.push(...parsed.rows);
    }
  }
  return { dates, opportunityFiles, outcomeRows, missing, partial };
}

/**
 * Plan14 archives `{ observedAtIso, symbol, timeframe, model, candidates, decision }`.
 * Rows that are not BTC 5m, or that lack both outcome asks, are counted and dropped.
 */
export function normalizeOpportunity(row, seq = 0) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'not-object' };
  if (row.symbol !== 'BTC-USD') return { ok: false, reason: 'symbol' };
  if (row.timeframe !== '5m') return { ok: false, reason: 'timeframe' };
  const observedMs = Date.parse(row.observedAtIso);
  const targetMs = Date.parse(row.targetTimeIso);
  if (!Number.isFinite(observedMs) || !Number.isFinite(targetMs) || observedMs >= targetMs) {
    return { ok: false, reason: 'time' };
  }
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const up = sideQuote(candidates.find((candidate) => candidate?.direction === 'up'));
  const down = sideQuote(candidates.find((candidate) => candidate?.direction === 'down'));
  if (!(up.ask > 0) && !(down.ask > 0)) return { ok: false, reason: 'missing-ask' };
  const inputs = row.model?.inputs && typeof row.model.inputs === 'object' ? row.model.inputs : {};
  const marketSlug = row.marketSlug || buildCryptoUpDownMarketSlug(row.targetTimeIso, '5m', 'bitcoin');
  const bookTimeMs = {
    up: finite(row.model?.bookTimeMs?.up),
    down: finite(row.model?.bookTimeMs?.down)
  };
  return {
    ok: true,
    quote: {
      seq,
      observedAtIso: row.observedAtIso,
      observedMs,
      targetMs,
      targetTimeIso: row.targetTimeIso,
      slotIso: row.slotIso || null,
      marketSlug,
      symbol: row.symbol,
      timeframe: row.timeframe,
      remainingSeconds: (targetMs - observedMs) / 1000,
      inputs: {
        spot: finite(inputs.spot),
        open: finite(inputs.open),
        volatility: finite(inputs.volatility),
        secondsRemaining: finite(inputs.secondsRemaining),
        slotSeconds: finite(inputs.slotSeconds),
        quoteTimeMs: finite(inputs.quoteTimeMs)
      },
      loggedSpotUp: finite(row.model?.spotUp),
      loggedMarketUp: finite(row.model?.marketUp),
      freshBook: row.model?.freshBook !== false,
      bookTimeMs,
      up,
      down,
      marketUp: marketUpFromQuote(up, down, finite(row.model?.marketUp))
    }
  };
}

export function quotesFromOpportunityFiles(files) {
  const quotes = [];
  const rejected = {};
  let seq = 0;
  for (const file of files) {
    for (const row of file.rows) {
      const normalized = normalizeOpportunity(row, seq);
      seq += 1;
      if (!normalized.ok) {
        rejected[normalized.reason] = (rejected[normalized.reason] || 0) + 1;
        continue;
      }
      quotes.push(normalized.quote);
    }
  }
  quotes.sort((a, b) => a.observedMs - b.observedMs || a.seq - b.seq);
  return { quotes, rejected };
}

export function schemaCoverage(quotes) {
  const count = (predicate) => quotes.filter(predicate).length;
  const slots = new Set(quotes.map((quote) => quote.marketSlug || quote.targetMs));
  return {
    rows: quotes.length,
    slots: slots.size,
    spot: count((quote) => quote.inputs.spot > 0),
    open: count((quote) => quote.inputs.open > 0),
    volatility: count((quote) => quote.inputs.volatility > 0),
    loggedSpotUp: count((quote) => quote.loggedSpotUp > 0 && quote.loggedSpotUp < 1),
    marketUp: count((quote) => quote.marketUp > 0 && quote.marketUp < 1),
    bothAsks: count((quote) => quote.up.ask > 0 && quote.down.ask > 0),
    freshBook: count((quote) => quote.freshBook),
    bookTime: count((quote) => Number.isFinite(quote.bookTimeMs.up) && Number.isFinite(quote.bookTimeMs.down)),
    spotTime: count((quote) => Number.isFinite(quote.inputs.quoteTimeMs))
  };
}

export function indexOfficialOutcomes(rows) {
  const bySlug = new Map();
  const byTarget = new Map();
  let conflicts = 0;
  const put = (map, key, record) => {
    if (key == null || key === '') return;
    const previous = map.get(key);
    if (!previous) {
      map.set(key, record);
      return;
    }
    if (previous.conflict || previous.actualDirection === record.actualDirection) return;
    map.set(key, { ...previous, conflict: true, actualDirection: null, source: 'official-conflict' });
    conflicts += 1;
  };
  for (const row of rows) {
    const order = row?.order && typeof row.order === 'object' ? row.order : null;
    if (!order) continue;
    const source = order.settlementPriceSource || order.priceSource;
    if (source !== 'polymarket-official' || !['up', 'down'].includes(order.actualDirection)) continue;
    if (order.symbol && order.symbol !== 'BTC-USD') continue;
    if (order.timeframe && order.timeframe !== '5m') continue;
    const targetMs = Date.parse(order.targetTimeIso);
    const record = {
      actualDirection: order.actualDirection,
      source: 'archive-polymarket-official',
      marketSlug: order.marketSlug || null,
      targetMs: Number.isFinite(targetMs) ? targetMs : null
    };
    put(bySlug, order.marketSlug, record);
    if (Number.isFinite(targetMs)) put(byTarget, targetMs, record);
  }
  return { bySlug, byTarget, conflicts };
}

export function lookupArchivedOutcome(index, quote) {
  const found = (quote.marketSlug && index.bySlug.get(quote.marketSlug)) || index.byTarget.get(quote.targetMs) || null;
  if (found?.conflict) return { conflict: true, source: 'official-conflict', actualDirection: null };
  return found;
}

/** Official direction wins. Spot is only a label when the official result is absent. */
export function chooseOutcome(official, spot) {
  if (official?.conflict) return { outcome: null, disagreement: false, conflict: true };
  const officialDirection = ['up', 'down'].includes(official?.actualDirection) ? official : null;
  const spotDirection = ['up', 'down'].includes(spot?.actualDirection) ? spot : null;
  if (officialDirection && spotDirection && officialDirection.actualDirection !== spotDirection.actualDirection) {
    return { outcome: officialDirection, disagreement: true, conflict: false };
  }
  if (officialDirection) return { outcome: officialDirection, disagreement: false, conflict: false };
  if (spotDirection) return { outcome: spotDirection, disagreement: false, conflict: false };
  return { outcome: null, disagreement: false, conflict: false };
}

export function estimateQuoteProbability(quote, { modelWeight = JEV_DEFAULTS.modelWeight } = {}) {
  const slotSeconds = quote.inputs.slotSeconds > 0 ? quote.inputs.slotSeconds : 300;
  let spotUp = null;
  let source = null;
  if (quote.inputs.spot > 0 && quote.inputs.open > 0 && quote.inputs.volatility > 0 && quote.remainingSeconds > 0) {
    spotUp = estimatePlan14SpotUp({
      spot: quote.inputs.spot,
      open: quote.inputs.open,
      volatility: quote.inputs.volatility,
      secondsRemaining: quote.remainingSeconds,
      slotSeconds
    });
    source = 'spot-open-remaining';
  }
  if (!(spotUp > 0 && spotUp < 1) && quote.loggedSpotUp > 0 && quote.loggedSpotUp < 1) {
    spotUp = quote.loggedSpotUp;
    source = 'logged-spot';
  }
  const marketUp = quote.marketUp > 0 && quote.marketUp < 1
    ? quote.marketUp
    : (quote.loggedMarketUp > 0 && quote.loggedMarketUp < 1 ? quote.loggedMarketUp : null);
  if (!(marketUp > 0 && marketUp < 1) || !(spotUp > 0 && spotUp < 1)) return null;
  const pUp = blendPlan14Up({
    marketUp,
    spotUp,
    timeframe: '5m',
    config: { plan14ModelWeight5m: modelWeight }
  });
  if (!(pUp > 0 && pUp < 1)) return null;
  return { pUp, spotUp, marketUp, source };
}

function timestampFresh(stampMs, observedMs, maxQuoteAgeMs) {
  if (!Number.isFinite(stampMs)) return true;
  const age = observedMs - stampMs;
  return age >= -2000 && age <= maxQuoteAgeMs;
}

function sideTradable(side, options) {
  if (!(side.ask > 0 && side.ask < 1 && side.bid > 0 && side.ask > side.bid)) return false;
  if (side.ask < options.minAsk - 1e-9 || side.ask > options.maxAsk + 1e-9) return false;
  if (!(side.spread <= options.maxSpread + 1e-9)) return false;
  return true;
}

export function evaluateJevQuote(quote, options = JEV_DEFAULTS) {
  if (quote.freshBook === false) return { take: false, reason: 'stale-book' };
  if (quote.remainingSeconds < options.minRemainingSeconds - 1e-9
    || quote.remainingSeconds > options.maxRemainingSeconds + 1e-9) {
    return { take: false, reason: 'outside-window' };
  }
  const stamps = [quote.inputs.quoteTimeMs, quote.bookTimeMs.up, quote.bookTimeMs.down];
  if (stamps.some((stamp) => !timestampFresh(stamp, quote.observedMs, options.maxQuoteAgeMs))) {
    return { take: false, reason: 'stale-quote' };
  }
  const prob = estimateQuoteProbability(quote, options);
  if (!prob) return { take: false, reason: 'no-probability' };
  const ranked = ['up', 'down'].map((direction) => {
    const book = quote[direction];
    const p = direction === 'up' ? prob.pUp : 1 - prob.pUp;
    return {
      direction,
      ask: book.ask,
      bid: book.bid,
      spread: book.spread,
      p,
      edge: feeAdjustedEdge(p, book.ask, options.feeRate),
      tradable: sideTradable(book, options)
    };
  }).filter((side) => side.tradable && side.edge != null)
    .sort((a, b) => b.edge - a.edge || b.p - a.p || a.direction.localeCompare(b.direction));
  const best = ranked[0];
  if (!best) return { take: false, reason: 'book', prob };
  if (best.edge + 1e-12 < options.minEdge) return { take: false, reason: 'edge', best, prob };
  return { take: true, reason: null, side: best, prob };
}

function buildTrade(quote, decision, outcome, options) {
  const ask = decision.side.ask;
  const usd = options.stake;
  const shares = netShares(usd, ask, options.feeRate);
  const unmarked = grossShares(usd, ask);
  const settled = Boolean(outcome && ['up', 'down'].includes(outcome.actualDirection));
  const won = settled ? decision.side.direction === outcome.actualDirection : null;
  return {
    marketSlug: quote.marketSlug,
    observedAtIso: quote.observedAtIso,
    observedMs: quote.observedMs,
    targetMs: quote.targetMs,
    targetTimeIso: quote.targetTimeIso,
    direction: decision.side.direction,
    ask,
    p: decision.side.p,
    edge: decision.side.edge,
    spotUp: decision.prob.spotUp,
    marketUp: decision.prob.marketUp,
    pUp: decision.prob.pUp,
    probabilitySource: decision.prob.source,
    usd,
    shares,
    grossShares: unmarked,
    won,
    settled,
    outcomeSource: settled ? outcome.source : null,
    actualDirection: settled ? outcome.actualDirection : null,
    grossPnl: settled ? (won ? unmarked : 0) - usd : null,
    netPnl: settled ? (won ? shares : 0) - usd : null,
    payout: settled ? (won ? shares : 0) : null,
    book: { up: { ...quote.up }, down: { ...quote.down } }
  };
}

export function replayJev(quotes, outcomeFor, options = JEV_DEFAULTS) {
  const skips = {};
  const decided = new Set();
  const trades = [];
  const slots = new Set();
  const open = [];
  let cash = options.startingCash;
  const release = (time) => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].targetMs > time) continue;
      const position = open.splice(i, 1)[0];
      cash += position.settled ? position.payout : position.usd;
    }
  };
  for (const quote of quotes) {
    const key = quote.marketSlug || String(quote.targetMs);
    slots.add(key);
    if (decided.has(key)) continue;
    release(quote.observedMs);
    const decision = evaluateJevQuote(quote, options);
    if (!decision.take) {
      skips[decision.reason] = (skips[decision.reason] || 0) + 1;
      continue;
    }
    if (!(cash + 1e-9 >= options.stake)) {
      skips.cash = (skips.cash || 0) + 1;
      decided.add(key);
      continue;
    }
    const outcome = outcomeFor(quote);
    const trade = buildTrade(quote, decision, outcome, options);
    decided.add(key);
    cash -= options.stake;
    open.push({
      targetMs: trade.targetMs,
      payout: trade.payout,
      usd: trade.usd,
      settled: trade.settled
    });
    trades.push(trade);
  }
  return { trades, skips, slots: slots.size, entered: trades.length };
}

export function maxDrawdown(trades, startingCash = JEV_DEFAULTS.startingCash) {
  const settled = trades.filter((trade) => trade.settled && Number.isFinite(trade.netPnl));
  const events = [];
  for (const trade of settled) {
    events.push({ ms: trade.observedMs, cash: -trade.usd, open: trade.usd, order: 0 });
    events.push({ ms: trade.targetMs, cash: trade.payout, open: -trade.usd, order: 1 });
  }
  events.sort((a, b) => a.ms - b.ms || a.order - b.order);
  let cash = startingCash;
  let open = 0;
  let peak = startingCash;
  let drawdown = 0;
  for (const event of events) {
    cash += event.cash;
    open += event.open;
    const equity = cash + open;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

export function summarizeTrades(trades, startingCash = JEV_DEFAULTS.startingCash) {
  const settled = trades.filter((trade) => trade.settled && Number.isFinite(trade.netPnl));
  const wins = settled.filter((trade) => trade.won).length;
  const grossPnl = settled.reduce((sum, trade) => sum + trade.grossPnl, 0);
  const netPnl = settled.reduce((sum, trade) => sum + trade.netPnl, 0);
  const invested = settled.reduce((sum, trade) => sum + trade.usd, 0);
  const sources = {};
  for (const trade of settled) sources[trade.outcomeSource] = (sources[trade.outcomeSource] || 0) + 1;
  return {
    trades: trades.length,
    settled: settled.length,
    unsettled: trades.length - settled.length,
    wins,
    losses: settled.length - wins,
    winRate: settled.length ? wins / settled.length : null,
    invested,
    grossPnl,
    netPnl,
    feeDrag: grossPnl - netPnl,
    maxDrawdown: maxDrawdown(trades, startingCash),
    endingCash: startingCash + netPnl,
    outcomeSources: sources
  };
}

/** Lower edge of the ask bucket. Width 0.1 matches Plan14's 10-cent price band. */
export function askBucket(price, width = JEV_DEFAULTS.bucketWidth) {
  if (!(price > 0 && price < 1) || !(width > 0 && width < 1)) return null;
  const index = Math.floor((price + 1e-9) / width);
  return Math.round(index * width * 1_000_000) / 1_000_000;
}

export function createLcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223 >>> 0;
    return state / 4294967296;
  };
}

export function sameAskBucketBaseline(trades, options = JEV_DEFAULTS) {
  const random = createLcg(options.seed);
  const baseline = [];
  let forcedSameSide = 0;
  let noCandidate = 0;
  for (const trade of trades) {
    if (!trade.settled) continue;
    const bucket = askBucket(trade.ask, options.bucketWidth);
    const choices = ['up', 'down'].filter((direction) => askBucket(trade.book[direction].ask, options.bucketWidth) === bucket
      && trade.book[direction].ask > 0 && trade.book[direction].ask < 1);
    if (!choices.length) {
      noCandidate += 1;
      continue;
    }
    if (choices.length === 1) forcedSameSide += 1;
    const direction = choices[Math.floor(random() * choices.length)];
    const ask = trade.book[direction].ask;
    const won = direction === trade.actualDirection;
    const shares = netShares(options.stake, ask, options.feeRate);
    const unmarked = grossShares(options.stake, ask);
    baseline.push({
      observedMs: trade.observedMs,
      targetMs: trade.targetMs,
      direction,
      ask,
      usd: options.stake,
      settled: true,
      won,
      actualDirection: trade.actualDirection,
      outcomeSource: trade.outcomeSource,
      payout: won ? shares : 0,
      grossPnl: (won ? unmarked : 0) - options.stake,
      netPnl: (won ? shares : 0) - options.stake,
      bucket
    });
  }
  return {
    trades: baseline,
    forcedSameSide,
    noCandidate,
    summary: summarizeTrades(baseline, options.startingCash)
  };
}

export function bucketComparison(strategyTrades, baselineTrades, width = JEV_DEFAULTS.bucketWidth) {
  const buckets = new Map();
  const ensure = (price) => {
    const lower = askBucket(price, width);
    if (lower == null) return null;
    if (!buckets.has(lower)) buckets.set(lower, { bucket: lower, strategyTrades: 0, strategyNet: 0, baselineTrades: 0, baselineNet: 0 });
    return buckets.get(lower);
  };
  for (const trade of strategyTrades) {
    if (!trade.settled) continue;
    const row = ensure(trade.ask);
    if (!row) continue;
    row.strategyTrades += 1;
    row.strategyNet += trade.netPnl;
  }
  for (const trade of baselineTrades) {
    const row = ensure(trade.ask);
    if (!row) continue;
    row.baselineTrades += 1;
    row.baselineNet += trade.netPnl;
  }
  return [...buckets.values()].sort((a, b) => a.bucket - b.bucket);
}

export function filterCalendarDay(quotes, isoDate, timeZone) {
  return quotes.filter((quote) => calendarDay(quote.observedMs, timeZone) === isoDate);
}

export function cohortReport(quotes, outcomeFor, options = JEV_DEFAULTS) {
  const replay = replayJev(quotes, outcomeFor, options);
  const summary = summarizeTrades(replay.trades, options.startingCash);
  const baseline = sameAskBucketBaseline(replay.trades, options);
  return {
    quotes: quotes.length,
    slots: replay.slots,
    skips: replay.skips,
    schema: schemaCoverage(quotes),
    summary: displaySummary(summary),
    baseline: {
      ...displaySummary(baseline.summary),
      forcedSameSide: baseline.forcedSameSide,
      noCandidate: baseline.noCandidate
    },
    buckets: bucketComparison(replay.trades, baseline.trades, options.bucketWidth).map((row) => ({
      ...row,
      strategyNet: round2(row.strategyNet),
      baselineNet: round2(row.baselineNet)
    })),
    trades: replay.trades
  };
}

function displaySummary(summary) {
  return {
    ...summary,
    invested: round2(summary.invested),
    grossPnl: round2(summary.grossPnl),
    netPnl: round2(summary.netPnl),
    feeDrag: round2(summary.feeDrag),
    maxDrawdown: round2(summary.maxDrawdown),
    endingCash: round2(summary.endingCash),
    winRate: summary.winRate == null ? null : Math.round(summary.winRate * 10000) / 10000
  };
}

export function listResearchFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
}
