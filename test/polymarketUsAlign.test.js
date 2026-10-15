import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { US_BBO_MAX_AGE_MS, US_EDGE_BTC_MISPRICE } from '../src/polymarketUs/constants.js';
import { buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import { evaluateUsSignal as evaluateScan, minEdgeFor, sizeForRecord } from '../src/polymarketUs/evaluate.js';
import { cleanerEdgeFloor, US_RULES } from '../src/polymarketUs/rules.js';
import { btcCandidatesFromContext, loadSectorStats } from '../src/polymarketUs/scan.js';
import { evaluateUsSignal as evaluateTrade, isLiveEndgame } from '../src/polymarketUs/strategy.js';
import { usdBuyingPower } from '../src/polymarketUs/trading.js';

const NOW = new Date('2026-10-14T15:37:00.000Z');

function scanInput(overrides = {}) {
  return {
    now: NOW,
    sector: 'weather',
    side: 'Yes',
    slug: 'nyc-high-70',
    city: 'New York',
    modelProb: 0.46,
    ask: 0.40,
    bid: 0.39,
    spreadCents: 1,
    depthUsd: 80,
    liquidityUsd: 500,
    resolutionRisk: 'Low',
    confidence: 'High',
    bboSampledAt: NOW.toISOString(),
    expiresAt: '2026-10-15T07:00:00.000Z',
    windowId: null,
    timeframe: null,
    ptDate: '2026-10-14',
    basis: 'ensemble',
    record: { wins: 4, losses: 6, lossStreak: 0 },
    dailyFilled: 0,
    dailyPending: 0,
    buyingPower: 40,
    ...overrides
  };
}

function tradeSignal(overrides = {}) {
  return {
    sector: 'weather',
    slug: 'nyc-high-70',
    side: 'Yes',
    limit_price: 0.4,
    ask: 0.4,
    model_prob: 0.46,
    spread_cents: 1,
    liquidity_usd: 80,
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending',
    bbo_at: NOW.toISOString(),
    ...overrides
  };
}

function trade(signal, context = {}) {
  return evaluateTrade(signal, { now: NOW, dryRun: true, ...context });
}

test('endgame published by scan is still endgame when trade reads it', () => {
  const published = evaluateScan(scanInput({
    sector: 'live',
    liveKind: 'endgame',
    side: 'Yes',
    slug: 'tec-nba-game',
    city: null,
    modelProb: 0.93,
    ask: 0.94,
    bid: 0.93,
    windowId: null
  }));
  assert.equal(published.ok, true);
  assert.equal(published.signal.live_kind, 'endgame');
  assert.equal(published.signal.live_phase, 'endgame');
  assert.equal(published.signal.endgame, true);
  assert.equal(published.signal.model_prob, 0.93);
  assert.equal(isLiveEndgame(published.signal), true);
  assert.equal(isLiveEndgame({ live_kind: 'endgame' }), true);
  assert.equal(isLiveEndgame({ liveKind: 'endgame' }), true);

  const placed = trade(published.signal);
  assert.equal(placed.action, 'place');
  assert.equal(placed.code, 'pass');

  const camelOnly = trade({
    ...published.signal,
    live_kind: undefined,
    live_phase: undefined,
    endgame: false,
    liveKind: 'endgame'
  });
  assert.equal(camelOnly.action, 'place');

  const capped = trade({
    ...published.signal,
    live_kind: null,
    live_phase: null,
    endgame: false,
    liveKind: null
  });
  assert.equal(capped.code, 'model_cap');
});

test('btc misprice sector keys normalize before win-rate and daily fills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'us-sector-'));
  try {
    const rows = [];
    for (let index = 0; index < 9; index += 1) {
      rows.push({
        venue: 'polymarket.us',
        event_url: `https://polymarket.us/event/btc-up-${index}`,
        sector: index % 2 ? 'btc-misprice' : 'btc_misprice',
        won: true,
        status: 'filled',
        pt_date: '2026-10-14',
        side: 'Up',
        dry_run: false
      });
    }
    rows.push({
      venue: 'polymarket_us',
      url: 'https://polymarket.us/event/btc-runner',
      sector: 'btc-misprice',
      won: true,
      fill_status: 'filled',
      time_pt: '2026-10-14T08:37:00 PT',
      side: 'Up',
      dry_run: false
    });
    rows.push({
      venue: 'polymarket.us',
      url: 'https://polymarket.us/event/btc-dry',
      sector: 'btc_misprice',
      won: true,
      status: 'filled',
      pt_date: '2026-10-14',
      dry_run: true
    });
    await writeFile(join(root, 'real-orders.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    await writeFile(join(root, 'account.json'), JSON.stringify({
      buyingPower: 16,
      cash_usd: 100,
      currentBalance: 80
    }));
    const stats = await loadSectorStats(root, 'btc-misprice', NOW);
    assert.equal(stats.record.wins, 10);
    assert.equal(stats.record.losses, 0);
    assert.equal(stats.dailyFilled, 10);
    assert.equal(stats.buyingPower, 16);
    assert.equal(sizeForRecord(stats.record).usd, 5);

    const published = evaluateScan(scanInput({
      sector: 'btc-misprice',
      slug: 'cpc-btc-updown-15m-2026-10-14-1530z',
      side: 'Up',
      timeframe: '15m',
      modelProb: 0.62,
      ask: 0.55,
      bid: 0.54,
      city: null,
      record: stats.record,
      dailyFilled: 0,
      buyingPower: 40,
      distanceBps: 6
    }));
    assert.equal(published.ok, true);
    assert.equal(published.signal.sector, 'btc_misprice');
    assert.equal(published.signal.size_usd, 5);
    assert.match(published.signal.id, /^btc_misprice:/);

    await writeFile(join(root, 'account.json'), JSON.stringify({ cash_usd: 100, currentBalance: 80 }));
    assert.equal((await loadSectorStats(root, 'btc_misprice', NOW)).buyingPower, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cold edge and BBO age are the same for scan and trade', () => {
  assert.equal(US_BBO_MAX_AGE_MS, 45_000);
  assert.equal(US_RULES.edge.bboMaxAgeMs, US_BBO_MAX_AGE_MS);
  assert.equal(US_EDGE_BTC_MISPRICE, 0.04);
  assert.equal(US_RULES.edge.btcMisprice, US_EDGE_BTC_MISPRICE);
  assert.equal(minEdgeFor('btc-misprice'), US_EDGE_BTC_MISPRICE);
  assert.equal(US_RULES.edge.nonBtcNonLive, 0.03);
  assert.equal(US_RULES.edge.liveInGame, 0.04);
  assert.equal(US_RULES.edge.weakEdgeMultiplier, 1.5);
  assert.equal(cleanerEdgeFloor(0.03, false), 0.03);
  assert.equal(cleanerEdgeFloor(0.03, true), 0.045);
  assert.equal(cleanerEdgeFloor(0.05, true), 0.075);
  assert.equal(cleanerEdgeFloor(US_EDGE_BTC_MISPRICE, false), 0.04);
  assert.equal(cleanerEdgeFloor(US_EDGE_BTC_MISPRICE, true), 0.06);
  assert.equal(buildPolymarketUsConfig({}).bboMaxAgeMs, US_BBO_MAX_AGE_MS);
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const sample = example.match(/^#?\s*POLYMARKET_US_BBO_MAX_AGE_MS=(\d+)\s*$/m);
  assert.equal(Number(sample?.[1]), 45_000);
  assert.equal(Number(sample?.[1]), US_BBO_MAX_AGE_MS);

  const coldStats = { weather: { samples: 10, winRate: 0.4, streakLosses: 0 } };
  assert.equal(evaluateScan(scanInput({ modelProb: 0.44 })).reason, 'edge');
  assert.equal(evaluateScan(scanInput({ modelProb: 0.46 })).ok, true);
  assert.equal(trade(tradeSignal({ model_prob: 0.44 }), { stats: coldStats }).code, 'edge');
  assert.equal(trade(tradeSignal({ model_prob: 0.46 }), { stats: coldStats }).action, 'place');

  const freshAt = new Date(NOW.getTime() - 5_000).toISOString();
  const exactAt = new Date(NOW.getTime() - US_BBO_MAX_AGE_MS).toISOString();
  const justStaleAt = new Date(NOW.getTime() - (US_BBO_MAX_AGE_MS + 1)).toISOString();
  const staleAt = new Date(NOW.getTime() - (US_BBO_MAX_AGE_MS + 1_000)).toISOString();
  const btc = {
    sector: 'btc-misprice',
    slug: 'cpc-btc-updown-15m-2026-10-14-1530z',
    side: 'Up',
    timeframe: '15m',
    modelProb: 0.62,
    ask: 0.55,
    bid: 0.54,
    city: null,
    record: { wins: 0, losses: 0, lossStreak: 0 },
    distanceBps: 6,
    buyingPower: 40
  };
  const withinOldWindow = new Date(NOW.getTime() - 30_000).toISOString();
  assert.equal(evaluateScan(scanInput({ ...btc, bboSampledAt: freshAt })).ok, true);
  assert.equal(evaluateScan(scanInput({ ...btc, bboSampledAt: withinOldWindow })).ok, true);
  assert.equal(evaluateScan(scanInput({ ...btc, bboSampledAt: exactAt })).ok, true);
  assert.equal(evaluateScan(scanInput({ ...btc, bboSampledAt: justStaleAt })).reason, 'stale-bbo');
  assert.equal(evaluateScan(scanInput({ ...btc, bboSampledAt: staleAt })).reason, 'stale-bbo');

  const tradeBtc = {
    sector: 'btc_misprice',
    slug: 'cpc-btc-updown-15m-2026-10-14-1530z',
    side: 'Up',
    limit_price: 0.55,
    ask: 0.55,
    model_prob: 0.62,
    spread_cents: 1,
    liquidity_usd: 80,
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  };
  assert.equal(trade(tradeSignal({ ...tradeBtc, bbo_at: freshAt })).action, 'place');
  assert.equal(trade(tradeSignal({ ...tradeBtc, bbo_at: withinOldWindow })).action, 'place');
  assert.equal(trade(tradeSignal({ ...tradeBtc, bbo_at: exactAt })).action, 'place');
  assert.equal(trade(tradeSignal({ ...tradeBtc, bbo_at: justStaleAt })).code, 'stale_bbo');
  assert.equal(trade(tradeSignal({ ...tradeBtc, bbo_at: staleAt })).code, 'stale_bbo');

  for (const timeframe of ['15m', '1h']) {
    const scanEdge = {
      ...btc,
      timeframe,
      slug: `cpc-btc-updown-${timeframe}-2026-10-14-1530z`,
      ask: 0.55,
      bid: 0.54,
      bboSampledAt: withinOldWindow
    };
    const tradeEdge = {
      ...tradeBtc,
      timeframe,
      slug: `cpc-btc-updown-${timeframe}-2026-10-14-1530z`,
      ask: 0.55,
      limit_price: 0.55,
      bbo_at: withinOldWindow
    };
    assert.equal(evaluateScan(scanInput({ ...scanEdge, modelProb: 0.59 })).ok, true);
    assert.equal(evaluateScan(scanInput({ ...scanEdge, modelProb: 0.58 })).reason, 'edge');
    assert.equal(trade(tradeSignal({ ...tradeEdge, model_prob: 0.59 })).action, 'place');
    assert.equal(trade(tradeSignal({ ...tradeEdge, model_prob: 0.58 })).code, 'edge');
    assert.equal(
      evaluateScan(scanInput({ ...scanEdge, modelProb: 0.59 })).signal.edge,
      0.04
    );
  }

  const weak = { wins: 4, losses: 6, lossStreak: 0 };
  const momentum = {
    sector: 'momentum',
    modelProb: 0.84,
    ask: 0.80,
    bid: 0.79,
    sameWay: true,
    record: weak,
    distanceBps: 4
  };
  assert.equal(evaluateScan(scanInput(momentum)).reason, 'momentum-distance');
  assert.equal(evaluateScan(scanInput({ ...momentum, distanceBps: 8 })).ok, true);
  const coldMomentum = { momentum: { samples: 10, winRate: 0.4, streakLosses: 0 } };
  assert.equal(trade(tradeSignal({
    sector: 'momentum',
    limit_price: 0.8,
    ask: 0.8,
    model_prob: 0.84,
    mos: true,
    same_way: true,
    distance_bps: 4
  }), { stats: coldMomentum }).code, 'momentum_distance');
  assert.equal(trade(tradeSignal({
    sector: 'momentum',
    limit_price: 0.8,
    ask: 0.8,
    model_prob: 0.84,
    mos: true,
    same_way: true,
    distance_bps: 8
  }), { stats: coldMomentum }).action, 'place');
});

test('same window blocks only the opposite side', () => {
  const context = {
    market: {
      slug: 'cpc-btc-updown-15m-2026-10-14-1530z',
      description: 'settle to Up if the Bitcoin price is greater than or equal. Outcome sourced from CF Benchmarks BRTI. The official value is the simple average of these prices, rounded to the nearest 2 decimal places.',
      assetPriceTerms: {
        indexSymbol: 'BRTI',
        marketType: 'ASSET_PRICE_MARKET_TYPE_UP_DOWN',
        priceDecimals: 2,
        windowStart: '2026-10-14T15:30:00.000Z',
        windowEnd: '2026-10-14T15:45:00.000Z'
      }
    },
    bbo: {
      bestBid: 0.54,
      bestAsk: 0.55,
      longAsk: 0.55,
      shortAsk: 0.46,
      askShares: 8000,
      bidShares: 8000,
      sampledAt: NOW.toISOString()
    },
    book: { asks: [{ price: 0.55, size: 8000 }], bids: [{ price: 0.54, size: 8000 }] },
    signal: {
      confidence: 0.64,
      probabilities: { up: 0.70 },
      indicators: { bodyPct: 0.0006 }
    },
    window: {
      start: new Date('2026-10-14T15:30:00.000Z'),
      end: new Date('2026-10-14T15:45:00.000Z')
    },
    timeframe: '15m',
    now: NOW
  };
  const stats = {
    record: { wins: 0, losses: 0, lossStreak: 0 },
    dailyFilled: 0,
    dailyPending: 0,
    buyingPower: 40,
    ptDate: '2026-10-14',
    openWindows: []
  };
  const sameSide = btcCandidatesFromContext({
    ...context,
    mispriceStats: {
      ...stats,
      openWindows: [{ windowId: '2026-10-14T15:30:00.000Z', side: 'Up', status: 'filled' }]
    },
    momentumStats: stats
  });
  assert.equal(sameSide.signals.length, 1);
  assert.equal(sameSide.signals[0].side, 'Up');
  assert.equal(sameSide.skipped.includes('window-open'), false);

  const opposite = btcCandidatesFromContext({
    ...context,
    mispriceStats: {
      ...stats,
      openWindows: [{ windowId: '2026-10-14T15:30:00.000Z', side: 'Down', status: 'filled' }]
    },
    momentumStats: stats
  });
  assert.equal(opposite.signals.length, 0);
  assert.equal(opposite.skipped.includes('window-open'), false);
  assert.equal(opposite.skipped.includes('one-sided'), true);
});

test('usdBuyingPower ignores currentBalance', () => {
  assert.equal(usdBuyingPower({
    balances: [{ currency: 'USD', buyingPower: 41.91, currentBalance: 65.73 }]
  }), 41.91);
  assert.equal(usdBuyingPower({
    balances: [{ currency: 'USD', currentBalance: 65.73 }]
  }), null);
});
