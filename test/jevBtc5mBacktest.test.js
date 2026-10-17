import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { netShares } from '../src/plan14Backtest.js';
import { polymarketCryptoTakerFee } from '../src/polymarketMarketUtils.js';
import {
  JEV_DEFAULTS, PACIFIC_TIME_ZONE, askBucket, calendarDay, chooseOutcome, cohortReport,
  createLcg, evaluateJevQuote, feeAdjustedCost, feeAdjustedEdge, filterCalendarDay,
  indexOfficialOutcomes, loadResearchDirectory, maxDrawdown, normalizeOpportunity,
  quotesFromOpportunityFiles, sameAskBucketBaseline, utcDatesAround
} from '../src/jevBtc5mBacktest.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function opportunity({
  observedAtIso, targetTimeIso, marketSlug, spot, open, volatility = 0.001,
  upAsk, upBid, downAsk, downBid, symbol = 'BTC-USD', timeframe = '5m'
}) {
  const observedMs = Date.parse(observedAtIso);
  return {
    observedAtIso,
    symbol,
    timeframe,
    slotIso: new Date(Date.parse(targetTimeIso) - 300_000).toISOString(),
    targetTimeIso,
    marketSlug,
    model: {
      marketUp: 0.5,
      spotUp: 0.5,
      freshBook: true,
      inputs: {
        spot, open, volatility, quoteTimeMs: observedMs,
        secondsRemaining: (Date.parse(targetTimeIso) - observedMs) / 1000,
        slotSeconds: 300
      },
      bookTimeMs: { up: observedMs, down: observedMs }
    },
    candidates: [
      { direction: 'up', ask: upAsk, bid: upBid, spread: upAsk - upBid },
      { direction: 'down', ask: downAsk, bid: downBid, spread: downAsk - downBid }
    ]
  };
}

test('fee-adjusted edge uses net-share cost, not the raw ask', () => {
  close(feeAdjustedCost(0.5, 0.07), 0.5 / 0.965);
  close(netShares(10, 0.5, 0.07), 19.3);
  const gross = 10 / 0.42;
  const fee = polymarketCryptoTakerFee(gross, 0.42, 0.07);
  close(netShares(10, 0.42, 0.07), gross - fee / 0.42);
  const raw = 0.60 - 0.58;
  const edge = feeAdjustedEdge(0.60, 0.58, 0.07);
  assert.ok(raw >= 0.01);
  assert.ok(edge < 0.01);
  assert.equal(feeAdjustedEdge(0.5, 1, 0.07), null);
});

test('fixture replay buys the underpriced side once, settles $1/$0, and draws down on the loss', () => {
  const win = opportunity({
    observedAtIso: '2026-10-16T15:00:00.000Z',
    targetTimeIso: '2026-10-16T15:02:30.000Z',
    marketSlug: 'btc-updown-5m-win',
    spot: 100.2, open: 100, upAsk: 0.50, upBid: 0.48, downAsk: 0.55, downBid: 0.53
  });
  const later = opportunity({
    ...win,
    observedAtIso: '2026-10-16T15:01:00.000Z'
  });
  later.model.inputs.quoteTimeMs = Date.parse(later.observedAtIso);
  later.model.bookTimeMs = { up: Date.parse(later.observedAtIso), down: Date.parse(later.observedAtIso) };
  const flat = opportunity({
    observedAtIso: '2026-10-16T15:05:00.000Z',
    targetTimeIso: '2026-10-16T15:07:30.000Z',
    marketSlug: 'btc-updown-5m-flat',
    spot: 100, open: 100, upAsk: 0.51, upBid: 0.49, downAsk: 0.51, downBid: 0.49
  });
  const loss = opportunity({
    observedAtIso: '2026-10-16T15:10:00.000Z',
    targetTimeIso: '2026-10-16T15:12:30.000Z',
    marketSlug: 'btc-updown-5m-loss',
    spot: 100.2, open: 100, upAsk: 0.50, upBid: 0.48, downAsk: 0.40, downBid: 0.38
  });
  const early = opportunity({
    observedAtIso: '2026-10-16T16:00:20.000Z',
    targetTimeIso: '2026-10-16T16:05:00.000Z',
    marketSlug: 'btc-updown-5m-late',
    spot: 100.2, open: 100, upAsk: 0.50, upBid: 0.48, downAsk: 0.55, downBid: 0.53
  });
  const earlyHit = opportunity({
    observedAtIso: '2026-10-16T16:02:00.000Z',
    targetTimeIso: '2026-10-16T16:05:00.000Z',
    marketSlug: 'btc-updown-5m-late',
    spot: 100.2, open: 100, upAsk: 0.50, upBid: 0.48, downAsk: 0.55, downBid: 0.53
  });
  const files = [{ name: 'tape', rows: [
    { symbol: 'ETH-USD', timeframe: '5m' },
    { symbol: 'BTC-USD', timeframe: '15m' },
    early, earlyHit, win, later, flat, loss
  ] }];
  const { quotes, rejected } = quotesFromOpportunityFiles(files);
  assert.equal(rejected.symbol, 1);
  assert.equal(rejected.timeframe, 1);
  assert.equal(evaluateJevQuote(normalizeOpportunity(flat).quote, JEV_DEFAULTS).reason, 'edge');
  assert.equal(evaluateJevQuote(normalizeOpportunity(early).quote, JEV_DEFAULTS).reason, 'outside-window');
  const outcomes = new Map([
    ['btc-updown-5m-win', { actualDirection: 'up', source: 'archive-polymarket-official' }],
    ['btc-updown-5m-loss', { actualDirection: 'down', source: 'archive-polymarket-official' }],
    ['btc-updown-5m-late', { actualDirection: 'up', source: 'archive-polymarket-official' }]
  ]);
  const report = cohortReport(quotes, (quote) => outcomes.get(quote.marketSlug) || null, JEV_DEFAULTS);
  assert.equal(report.summary.trades, 3);
  assert.equal(report.summary.wins, 2);
  assert.equal(report.summary.losses, 1);
  const winner = report.trades.find((trade) => trade.marketSlug === 'btc-updown-5m-win');
  assert.equal(winner.direction, 'up');
  assert.equal(winner.probabilitySource, 'spot-open-remaining');
  close(winner.shares, 19.3);
  close(winner.grossPnl, 10);
  close(winner.netPnl, 9.3);
  close(report.summary.grossPnl, 10);
  close(report.summary.netPnl, 8.6);
  close(report.summary.feeDrag, 1.4);
  assert.equal(report.summary.maxDrawdown, 10);
  assert.equal(report.trades.filter((trade) => trade.marketSlug === 'btc-updown-5m-win').length, 1);
  const random = createLcg(JEV_DEFAULTS.seed);
  const firstDraw = ['up', 'down'][Math.floor(random() * 2)];
  const baseline = sameAskBucketBaseline(report.trades, JEV_DEFAULTS);
  assert.equal(baseline.trades[0].direction, firstDraw);
  assert.equal(baseline.forcedSameSide, 1);
  assert.deepEqual(sameAskBucketBaseline(report.trades, JEV_DEFAULTS).trades.map((trade) => trade.direction),
    baseline.trades.map((trade) => trade.direction));
});

test('calendar cohorts split Pacific Time from UTC and official outcomes beat spot', () => {
  assert.deepEqual(utcDatesAround('2026-10-16'), ['2026-10-15', '2026-10-16', '2026-10-17']);
  const earlyUtc = Date.parse('2026-10-16T06:30:00.000Z');
  assert.equal(calendarDay(earlyUtc, 'UTC'), '2026-10-16');
  assert.equal(calendarDay(earlyUtc, PACIFIC_TIME_ZONE), '2026-10-15');
  const afternoon = Date.parse('2026-10-16T15:00:00.000Z');
  assert.equal(calendarDay(afternoon, PACIFIC_TIME_ZONE), '2026-10-16');
  const quotes = [
    normalizeOpportunity(opportunity({
      observedAtIso: '2026-10-16T06:30:00.000Z', targetTimeIso: '2026-10-16T06:32:30.000Z',
      marketSlug: 'early', spot: 100.2, open: 100, upAsk: 0.5, upBid: 0.48, downAsk: 0.55, downBid: 0.53
    })).quote,
    normalizeOpportunity(opportunity({
      observedAtIso: '2026-10-16T15:00:00.000Z', targetTimeIso: '2026-10-16T15:02:30.000Z',
      marketSlug: 'late', spot: 100.2, open: 100, upAsk: 0.5, upBid: 0.48, downAsk: 0.55, downBid: 0.53
    })).quote
  ];
  assert.equal(filterCalendarDay(quotes, '2026-10-16', PACIFIC_TIME_ZONE).length, 1);
  assert.equal(filterCalendarDay(quotes, '2026-10-16', 'UTC').length, 2);
  const chosen = chooseOutcome(
    { actualDirection: 'down', source: 'archive-polymarket-official' },
    { actualDirection: 'up', source: 'binance-5m' }
  );
  assert.equal(chosen.disagreement, true);
  assert.equal(chosen.outcome.source, 'archive-polymarket-official');
  assert.equal(chooseOutcome(null, { actualDirection: 'up', source: 'binance-5m' }).outcome.source, 'binance-5m');
  assert.equal(chooseOutcome({ conflict: true }, { actualDirection: 'up', source: 'binance-5m' }).outcome, null);
  assert.equal(askBucket(0.5, 0.1), 0.5);
  assert.equal(askBucket(0.599, 0.1), 0.5);
  assert.equal(askBucket(0.6, 0.1), 0.6);
});

test('research jsonl loader keeps the btc tape, ignores a torn last line, and requires an official source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-btc-5m-'));
  try {
    const row = opportunity({
      observedAtIso: '2026-10-16T15:00:00.000Z', targetTimeIso: '2026-10-16T15:02:30.000Z',
      marketSlug: 'btc-updown-5m-1', spot: 100.2, open: 100,
      upAsk: 0.5, upBid: 0.48, downAsk: 0.55, downBid: 0.53
    });
    await writeFile(join(dir, '2026-10-16-opportunities.jsonl'), `${JSON.stringify(row)}\n{"torn":`);
    await writeFile(join(dir, '2026-10-15-opportunities.jsonl'), `${JSON.stringify({
      ...row, symbol: 'ETH-USD', marketSlug: 'eth'
    })}\n`);
    const official = { observedAtIso: row.observedAtIso, order: {
      symbol: 'BTC-USD', timeframe: '5m', marketSlug: row.marketSlug, targetTimeIso: row.targetTimeIso,
      actualDirection: 'up', settlementPriceSource: 'polymarket-official'
    } };
    const spotLabeled = { observedAtIso: row.observedAtIso, order: {
      symbol: 'BTC-USD', timeframe: '5m', marketSlug: 'btc-spot-only', targetTimeIso: row.targetTimeIso,
      actualDirection: 'down', settlementPriceSource: 'binance-5m'
    } };
    await writeFile(join(dir, '2026-10-16-settlements.jsonl'), `${JSON.stringify(official)}\n${JSON.stringify(spotLabeled)}\n`);
    const loaded = loadResearchDirectory(dir, '2026-10-16');
    assert.equal(loaded.partial, 1);
    assert.equal(loaded.opportunityFiles.length, 2);
    const indexed = indexOfficialOutcomes(loaded.outcomeRows);
    assert.equal(indexed.bySlug.get(row.marketSlug).actualDirection, 'up');
    assert.equal(indexed.bySlug.has('btc-spot-only'), false);
    const replay = cohortReport(quotesFromOpportunityFiles(loaded.opportunityFiles).quotes,
      (quote) => indexed.bySlug.get(quote.marketSlug) || null, JEV_DEFAULTS);
    assert.equal(replay.summary.trades, 1);
    assert.equal(replay.summary.wins, 1);
    close(replay.summary.netPnl, 9.3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second slot is skipped when the loss has not left enough cash', () => {
  const first = normalizeOpportunity(opportunity({
    observedAtIso: '2026-10-16T15:00:00.000Z', targetTimeIso: '2026-10-16T15:02:30.000Z',
    marketSlug: 'cash-a', spot: 100.2, open: 100, upAsk: 0.5, upBid: 0.48, downAsk: 0.55, downBid: 0.53
  })).quote;
  const second = normalizeOpportunity(opportunity({
    observedAtIso: '2026-10-16T15:10:00.000Z', targetTimeIso: '2026-10-16T15:12:30.000Z',
    marketSlug: 'cash-b', spot: 100.2, open: 100, upAsk: 0.5, upBid: 0.48, downAsk: 0.55, downBid: 0.53
  })).quote;
  const report = cohortReport([first, second], () => ({ actualDirection: 'down', source: 'test' }), {
    ...JEV_DEFAULTS, startingCash: 10
  });
  assert.equal(report.summary.trades, 1);
  assert.equal(report.summary.netPnl, -10);
  assert.equal(report.skips.cash, 1);
});

test('stale books are not trades and logged spot is only a fallback', () => {
  const row = opportunity({
    observedAtIso: '2026-10-16T15:00:00.000Z', targetTimeIso: '2026-10-16T15:02:30.000Z',
    marketSlug: 'stale', spot: 100.2, open: 100, upAsk: 0.5, upBid: 0.48, downAsk: 0.55, downBid: 0.53
  });
  row.model.bookTimeMs = { up: Date.parse(row.observedAtIso) - 30_000, down: Date.parse(row.observedAtIso) - 30_000 };
  assert.equal(evaluateJevQuote(normalizeOpportunity(row).quote, JEV_DEFAULTS).reason, 'stale-quote');
  const quote = normalizeOpportunity(row).quote;
  quote.bookTimeMs = { up: NaN, down: NaN };
  quote.inputs.quoteTimeMs = NaN;
  quote.inputs.volatility = NaN;
  quote.loggedSpotUp = 0.95;
  const decision = evaluateJevQuote(quote, JEV_DEFAULTS);
  assert.equal(decision.take, true);
  assert.equal(decision.prob.source, 'logged-spot');
  const lone = {
    ...quote,
    marketUp: 0.61,
    up: { ask: 0.62, bid: 0.60, spread: 0.02 },
    down: { ask: 0.40, bid: 0.38, spread: 0.02 }
  };
  const forced = sameAskBucketBaseline([{
    ...evaluateToTrade(lone, 'down'), book: { up: lone.up, down: lone.down }
  }], JEV_DEFAULTS);
  assert.equal(forced.forcedSameSide, 1);
  assert.equal(forced.trades[0].direction, 'up');
});

function evaluateToTrade(quote, actualDirection) {
  const decision = evaluateJevQuote(quote, JEV_DEFAULTS);
  assert.equal(decision.take, true);
  return {
    observedMs: quote.observedMs,
    targetMs: quote.targetMs,
    ask: decision.side.ask,
    settled: true,
    won: decision.side.direction === actualDirection,
    actualDirection,
    outcomeSource: 'test',
    usd: 10,
    payout: decision.side.direction === actualDirection ? netShares(10, decision.side.ask, 0.07) : 0,
    grossPnl: 0,
    netPnl: (decision.side.direction === actualDirection ? netShares(10, decision.side.ask, 0.07) : 0) - 10,
    book: { up: quote.up, down: quote.down }
  };
}

test('the command prints a pacific and utc summary from a local fixture and does not trade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-run-'));
  const dir = join(root, 'research');
  await mkdir(dir);
  const row = opportunity({
    observedAtIso: '2026-10-16T15:00:00.000Z', targetTimeIso: '2026-10-16T15:02:30.000Z',
    marketSlug: 'btc-updown-5m-cmd', spot: 100.2, open: 100,
    upAsk: 0.5, upBid: 0.48, downAsk: 0.55, downBid: 0.53
  });
  await writeFile(join(dir, '2026-10-16-opportunities.jsonl'), `${JSON.stringify(row)}\n`);
  await writeFile(join(dir, '2026-10-16-settlements.jsonl'), `${JSON.stringify({
    observedAtIso: row.observedAtIso,
    order: {
      symbol: 'BTC-USD', timeframe: '5m', marketSlug: row.marketSlug, targetTimeIso: row.targetTimeIso,
      actualDirection: 'up', settlementPriceSource: 'polymarket-official'
    }
  })}\n`);
  const result = spawnSync(process.execPath, [
    'scripts/backtest-jev-btc-5m.mjs', '--date', '2026-10-16', '--dir', dir,
    '--no-fetch', '--no-spot-fallback'
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /纸面回测/);
  assert.match(result.stdout, /美国太平洋时间 2026-10-16/);
  assert.match(result.stdout, /UTC 2026-10-16/);
  assert.match(result.stdout, /净损益 \$9\.30/);
  assert.match(result.stdout, /最大回撤/);
  assert.match(result.stdout, /同卖一档随机对照/);
  assert.doesNotMatch(result.stdout, /live trading enabled/i);
  const missing = spawnSync(process.execPath, [
    'scripts/backtest-jev-btc-5m.mjs', '--dir', join(root, 'missing')
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /没有找到/);
  await rm(root, { recursive: true, force: true });
  assert.equal(maxDrawdown([{
    observedMs: 0, targetMs: 1, usd: 10, payout: 0, netPnl: -10, settled: true
  }]), 10);
});
