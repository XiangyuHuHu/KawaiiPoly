import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../src/config.js';
import { brtiOfficialPrice, brtiSettlesUp, settlementFromUsMarket } from '../src/polymarketUs/brti.js';
import { summarizeUsSettlements, runUsDigest } from '../src/polymarketUs/digest.js';
import { evaluateUsSignal, sizeForRecord } from '../src/polymarketUs/evaluate.js';
import { PolymarketUsGateway, eventUrl } from '../src/polymarketUs/gateway.js';
import { US_RULES } from '../src/polymarketUs/rules.js';
import { btcCandidatesFromContext, runUsScan } from '../src/polymarketUs/scan.js';
import { publishUsSignal, readJsonl } from '../src/polymarketUs/signals.js';
import { describeSession } from '../src/polymarketUs/time.js';

const NOW = new Date('2026-10-14T15:37:00.000Z');

function passing(overrides = {}) {
  return {
    now: NOW,
    sector: 'btc-misprice',
    side: 'Up',
    slug: 'cpc-btc-updown-15m-2026-10-14-1530z',
    modelProb: 0.62,
    ask: 0.55,
    bid: 0.54,
    spreadCents: 1,
    depthUsd: 80,
    liquidityUsd: 5000,
    resolutionRisk: 'Low',
    confidence: 'High',
    bboSampledAt: NOW.toISOString(),
    expiresAt: '2026-10-14T15:45:00.000Z',
    windowId: '2026-10-14T15:30:00.000Z',
    timeframe: '15m',
    ptDate: '2026-10-14',
    basis: 'BRTI 模型高于美国站卖价',
    record: { wins: 0, losses: 0, lossStreak: 0 },
    dailyFilled: 0,
    dailyPending: 0,
    cashUsd: 40,
    distanceBps: 6,
    sameWay: true,
    ...overrides
  };
}

test('US and international endpoints stay separate', () => {
  const config = getConfig();
  assert.equal(config.polymarket.gammaBaseUrl, 'https://gamma-api.polymarket.com');
  assert.equal(config.polymarket.clobBaseUrl, 'https://clob.polymarket.com');
  assert.match(config.polymarketUs.gatewayBaseUrl, /^https:\/\/gateway\.polymarket\.us/);
  assert.match(config.polymarketUs.apiBaseUrl, /api\.polymarket\.us/);
  assert.equal(config.polymarketUs.siteBaseUrl, 'https://polymarket.us');
  assert.equal(config.polymarket.line, 'intl-paper');
  assert.equal(config.polymarket.intlPaperEnabled, true);
  assert.equal(config.polymarketUs.line, 'polymarket_us');
  assert.equal(config.polymarketUs.scannerPlacesOrders, false);
  assert.equal(config.polymarketUs.standingAutoOrder, true);
  assert.equal(config.polymarketUs.perTradeConfirm, false);
  assert.equal(config.polymarketUs.dryRun, true);
  assert.equal(config.polymarketUs.liveTradingEnabled, false);
  assert.match(String(config.polymarketUs.specVersion), /3\.2/);
  assert.throws(
    () => new PolymarketUsGateway({ baseUrl: 'https://gamma-api.polymarket.com' }),
    /refuses international/
  );
});

test('event url strips the cpc prefix', () => {
  assert.equal(
    eventUrl('cpc-btc-updown-15m-2026-10-14-1530z'),
    'https://polymarket.us/event/btc-updown-15m-2026-10-14-1530z'
  );
});

test('gateway reads markets, bbo, and book without Gamma', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/bbo')) {
      return jsonResponse({
        marketData: {
          marketSlug: 'cpc-btc-updown-15m-2026-10-14-1530z',
          bestBid: { value: '0.5400', currency: 'USD' },
          bestAsk: { value: '0.5500', currency: 'USD' },
          longQuote: { value: '0.5500' },
          shortQuote: { value: '0.4600' },
          askShares: '100',
          lastPriceSample: { ts: NOW.toISOString() },
          state: 'MARKET_STATE_OPEN'
        }
      });
    }
    if (url.includes('/book')) {
      return jsonResponse({
        marketData: {
          bids: [{ px: { value: '0.5400' }, qty: '20' }],
          offers: [{ px: { value: '0.5500' }, qty: '40' }]
        }
      });
    }
    if (url.includes('/markets/cpc-btc')) {
      return jsonResponse({}, 404);
    }
    return jsonResponse({
      markets: [{ slug: 'cpc-btc-updown-15m-2026-10-14-1530z', question: 'BTC Up or Down 15m' }]
    });
  };
  const gateway = new PolymarketUsGateway({ fetchImpl });
  const listed = await gateway.listMarkets({
    endDateMin: '2026-10-14T15:30:00Z',
    endDateMax: '2026-10-14T16:00:00Z',
    limit: 20
  });
  assert.equal(listed.length, 1);
  assert.match(calls[0], /^https:\/\/gateway\.polymarket\.us\/v1\/markets\?/);
  assert.match(calls[0], /endDateMin=/);
  assert.match(calls[0], /closed=false/);
  const market = await gateway.getMarket('cpc-btc-updown-15m-2026-10-14-1530z');
  assert.equal(market.slug, 'cpc-btc-updown-15m-2026-10-14-1530z');
  const bbo = await gateway.getBbo(market.slug);
  assert.equal(bbo.bestAsk, 0.55);
  assert.equal(bbo.shortAsk, 0.46);
  const book = await gateway.getBook(market.slug);
  assert.equal(book.bestAskSize, 40);
  assert.equal(calls.some((url) => url.includes('gamma-api') || url.includes('clob.polymarket.com')), false);
});

test('v3.2 standing auto-order, edge, size, and sector caps', () => {
  const signal = evaluateUsSignal(passing());
  assert.equal(signal.ok, true);
  assert.equal(signal.signal.side, 'Up');
  assert.equal(signal.signal.size_usd, 2);
  assert.equal(signal.signal.edge, 0.07);
  assert.equal(signal.signal.spec_version, '3.2');
  assert.equal(signal.signal.auto_order.scanner_places_orders, false);
  assert.equal(signal.signal.auto_order.authorized, true);
  assert.equal(signal.signal.auto_order.per_trade_confirm, false);
  assert.match(signal.signal.auto_order.note, /无需逐笔确认/);
  assert.equal(signal.signal.event_url, 'https://polymarket.us/event/btc-updown-15m-2026-10-14-1530z');

  assert.equal(evaluateUsSignal(passing({ ask: 0.60, modelProb: 0.62 })).reason, 'edge');
  assert.equal(evaluateUsSignal(passing({ ask: 0.90, modelProb: 0.99 })).reason, 'price-band');
  assert.equal(evaluateUsSignal(passing({ bboSampledAt: '2026-10-14T15:36:00.000Z' })).reason, 'stale-bbo');
  assert.equal(evaluateUsSignal(passing({ resolutionRisk: 'High' })).reason, 'resolution-risk');
  assert.equal(evaluateUsSignal(passing({ confidence: 'Low' })).reason, 'confidence');
  assert.equal(evaluateUsSignal(passing({ spreadCents: 4 })).reason, 'spread');
  assert.equal(evaluateUsSignal(passing({ liquidityUsd: null })).ok, true);
  assert.equal(evaluateUsSignal(passing({ slug: 'eth-updown-15m', title: 'ETH up or down' })).reason, 'intl-only');
  assert.equal(evaluateUsSignal(passing({ alreadyPicked: true })).reason, 'already-picked');
  assert.equal(evaluateUsSignal(passing({
    openWindows: [{ windowId: '2026-10-14T15:30:00.000Z', side: 'Down', status: 'pending' }]
  })).reason, 'one-sided');
  assert.equal(evaluateUsSignal(passing({ dailyFilled: 7 })).ok, true);
  assert.equal(evaluateUsSignal(passing({ dailyFilled: 8 })).reason, 'daily-cap');
  assert.equal(evaluateUsSignal(passing({ dailyOrders: 3, dailyFilled: 0 })).ok, true);
  assert.equal(evaluateUsSignal(passing({ cashUsd: 16 })).reason, 'cash-reserve');

  const weather = evaluateUsSignal(passing({
    sector: 'weather',
    slug: 'nyc-high-70',
    city: 'New York',
    modelProb: 0.40,
    ask: 0.36,
    timeframe: null,
    windowId: null
  }));
  assert.equal(weather.ok, true);
  assert.equal(weather.signal.edge, 0.04);

  const momentum = evaluateUsSignal(passing({ sector: 'momentum', ask: 0.80, modelProb: 0.84 }));
  assert.equal(momentum.ok, true);
  assert.equal(momentum.signal.size_usd, 2);
  assert.equal(evaluateUsSignal(passing({ sector: 'momentum', distanceBps: 3 })).reason, 'momentum-distance');
  assert.equal(evaluateUsSignal(passing({ sector: 'momentum', sameWay: false, distanceBps: 9 })).reason, 'momentum-same-way');
  assert.equal(evaluateUsSignal(passing({ sector: 'momentum', ask: 0.90, modelProb: 0.95 })).reason, 'momentum-price-cap');

  const endgame = evaluateUsSignal(passing({
    sector: 'live',
    liveKind: 'endgame',
    side: 'Yes',
    timeframe: null,
    modelProb: 0.93,
    ask: 0.94,
    slug: 'tec-nba-game'
  }));
  assert.equal(endgame.ok, true);
  assert.equal(endgame.signal.model_prob, 0.93);
  assert.equal(endgame.signal.side, 'Yes');
  assert.equal(evaluateUsSignal(passing({
    sector: 'live',
    liveKind: 'endgame',
    modelProb: 0.87,
    ask: 0.80,
    slug: 'tec-nba-early'
  })).reason, 'live-endgame-model');

  const inGame = evaluateUsSignal(passing({
    sector: 'live',
    liveKind: 'in-game',
    ask: 0.80,
    modelProb: 0.84,
    slug: 'tec-nba-live',
    timeframe: null,
    windowId: null
  }));
  assert.equal(inGame.ok, true);
  assert.equal(inGame.signal.edge, 0.04);
  assert.equal(evaluateUsSignal(passing({
    sector: 'live',
    liveKind: 'in-game',
    ask: 0.96,
    modelProb: 0.99,
    slug: 'tec-nba-rich'
  })).reason, 'live-in-game-price');

  assert.equal(sizeForRecord({ wins: 8, losses: 2 }).usd, 5);
  assert.equal(sizeForRecord({ wins: 7, losses: 3 }).usd, 3);
  assert.equal(sizeForRecord({ wins: 2, losses: 3 }).usd, 2);
  assert.equal(sizeForRecord({ wins: 8, losses: 2, lossStreak: 3 }).tier, 'weak');
  assert.equal(US_RULES.specVersion, '3.2');
  assert.equal(US_RULES.edge.nonBtcNonLive, 0.03);
  assert.equal(US_RULES.edge.btcMisprice, 0.05);
  assert.equal(US_RULES.edge.liveInGame, 0.04);
  assert.equal(US_RULES.edge.liveEndgameMinModel, 0.88);
  assert.equal(US_RULES.edge.momentumDistanceBps, 4);
  assert.equal(US_RULES.edge.momentumPriceCap, 0.88);
  assert.equal(US_RULES.dailyCaps.live, 10);
  assert.equal(US_RULES.dailyCaps.momentum, 15);
  assert.equal(US_RULES.dailyCaps['btc-misprice'], 8);
  assert.equal(US_RULES.dailyCaps.pregame, 6);
  assert.equal(US_RULES.dailyCaps.weather, 4);
  assert.equal(US_RULES.dailyCaps.macro, 3);
  assert.equal(US_RULES.dailyCaps.crypto, 4);
  assert.equal(US_RULES.dailyCaps.master, 4);
  assert.equal(US_RULES.standingAutoOrder.perTradeConfirm, false);
  assert.equal(US_RULES.scannerPlacesOrders, false);
});

test('Pacific schedule matches weekday and weekend sessions', () => {
  const morning = describeSession(NOW, US_RULES);
  assert.equal(morning.btcShort, true);
  assert.equal(morning.weekdaySession, '08:37');
  assert.equal(morning.fullSuite, false);
  const closed = describeSession(new Date('2026-10-14T16:00:00.000Z'), US_RULES);
  assert.equal(closed.label, 'closed');
  const weekend = describeSession(new Date('2026-10-17T18:00:00.000Z'), US_RULES);
  assert.equal(weekend.fullSuite, true);
  assert.equal(weekend.btcShort, true);
  const monday = describeSession(new Date('2026-10-12T15:50:00.000Z'), US_RULES);
  assert.equal(monday.longDated, true);
  assert.equal(monday.weekdaySession, '08:37');
});

test('BRTI official price is a 60-print average rounded to cents', () => {
  const samples = Array.from({ length: 60 }, () => 81380.174);
  assert.deepEqual(brtiOfficialPrice(samples.slice(0, 59)).ok, false);
  assert.equal(brtiOfficialPrice(samples).price, 81380.17);
  assert.equal(brtiSettlesUp(81380.17, 81380.17), true);
  assert.equal(brtiSettlesUp(81380.17, 81380.16), false);
  assert.equal(settlementFromUsMarket({
    assetPriceTerms: {
      indexSymbol: 'BRTI',
      priceToBeat: { value: '81380.17' },
      settlementPrice: { value: '81390.00' }
    }
  }).officialOutcome, 'Up');
});

test('empty and repeat scans do not write a second SIGNAL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'us-ledger-'));
  const workspace = await mkdtemp(join(tmpdir(), 'us-workspace-'));
  try {
    const outside = await runUsScan({
      now: new Date('2026-10-14T16:00:00.000Z'),
      ledgerRoot: root,
      workspaceRoot: workspace,
      loadWindow: async () => { throw new Error('should not load'); }
    });
    assert.equal(outside.published, 0);
    assert.equal(outside.reason, 'outside-window');
    await assert.rejects(stat(join(root, 'signals', 'pending.jsonl')));
    await assert.rejects(stat(join(root, 'candidates.jsonl')));

    const decision = evaluateUsSignal(passing());
    const first = await publishUsSignal({
      ledgerRoot: root,
      workspaceRoot: workspace,
      signal: decision.signal,
      now: NOW
    });
    assert.equal(first.wrote, true);
    const pendingBefore = await stat(join(root, 'signals', 'pending.jsonl'));
    const second = await publishUsSignal({
      ledgerRoot: root,
      workspaceRoot: workspace,
      signal: decision.signal,
      now: NOW
    });
    assert.equal(second.wrote, false);
    const pendingAfter = await stat(join(root, 'signals', 'pending.jsonl'));
    assert.equal(pendingBefore.mtimeMs, pendingAfter.mtimeMs);
    const rows = await readJsonl(join(root, 'signals', 'pending.jsonl'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    const compat = await readFile(join(workspace, 'btc15-20261014T1530Z', 'signal.json'), 'utf8');
    assert.match(compat, /polymarket\.us\/event\/btc-updown-15m/);
    assert.doesNotMatch(compat, /private|secret|mnemonic/i);
    await rm(join(root, 'signals', 'pending.jsonl'));
    const third = await publishUsSignal({
      ledgerRoot: root,
      workspaceRoot: workspace,
      signal: decision.signal,
      now: NOW
    });
    assert.equal(third.wrote, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('session scan writes one US signal and skips the opposite momentum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'us-scan-'));
  const workspace = await mkdtemp(join(tmpdir(), 'us-scan-ws-'));
  try {
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
      }
    };
    const preview = btcCandidatesFromContext({
      ...context,
      timeframe: '15m',
      now: NOW,
      mispriceStats: emptyStats(),
      momentumStats: emptyStats()
    });
    assert.equal(preview.signals.length, 1);
    assert.equal(preview.signals[0].sector, 'btc-misprice');

    let loads = 0;
    const result = await runUsScan({
      now: NOW,
      ledgerRoot: root,
      workspaceRoot: workspace,
      loadWindow: async ({ timeframe }) => {
        loads += 1;
        if (timeframe === '1h') return { market: null };
        return context;
      }
    });
    assert.equal(result.published, 1);
    assert.equal(loads, 2);
    const pending = await readJsonl(join(root, 'signals', 'pending.jsonl'));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].auto_order.scanner_places_orders, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('nightly digest is one Chinese line and ignores paper or Gamma rows', async () => {
  const summary = summarizeUsSettlements([
    { venue: 'paper', won: true, pnl_usd: 50, pt_date: '2026-10-14', size_usd: 10 },
    { event_url: 'https://polymarket.com/event/intl', won: false, pnl_usd: -5, pt_date: '2026-10-14' },
    {
      venue: 'polymarket.us',
      event_url: 'https://polymarket.us/event/btc-updown-15m-2026-10-14-1530z',
      won: true,
      pnl_usd: 1.2,
      pt_date: '2026-10-14',
      settled_pt_date: '2026-10-14',
      sector: 'btc-misprice'
    },
    {
      venue: 'polymarket.us',
      event_url: 'https://polymarket.us/event/older',
      won: false,
      pnl_usd: -2,
      pt_date: '2026-10-13',
      settled_pt_date: '2026-10-13'
    }
  ], { now: NOW });
  assert.equal(summary.line, '太平洋时间10月14日结算：新增1笔，胜1负0，当日盈亏+1.20美元；累计2笔，胜率50%。');
  assert.equal(summary.changed, true);
  const root = await mkdtemp(join(tmpdir(), 'us-digest-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'real-orders.jsonl'), `${JSON.stringify({
      venue: 'polymarket.us',
      event_url: 'https://polymarket.us/event/btc',
      won: true,
      pnl_usd: 1.2,
      pt_date: '2026-10-14',
      settled_pt_date: '2026-10-14'
    })}\n`);
    const first = await runUsDigest({ ledgerRoot: root, now: NOW });
    const second = await runUsDigest({ ledgerRoot: root, now: NOW });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal((await readFile(join(root, 'digests', 'nightly.txt'), 'utf8')).trim(), first.line);
    const settlement = await readFile(join(root, 'nightly-settlement-2026-10-14.json'), 'utf8');
    assert.doesNotMatch(settlement, /gamma-api\.polymarket\.com/);
    assert.match(settlement, /gateway\.polymarket\.us/);
    await writeFile(join(root, 'real-orders.jsonl'), `${JSON.stringify({
      venue: 'polymarket.us',
      slug: 'cpc-btc-updown-15m-x',
      event_url: 'https://polymarket.us/event/btc-updown-15m-x',
      side: 'Up',
      size_usd: 2,
      limit_price: 0.5,
      status: 'filled',
      pt_date: '2026-10-14'
    })}\n`);
    const looked = await runUsDigest({
      ledgerRoot: root,
      now: NOW,
      lookup: async () => ({
        assetPriceTerms: {
          indexSymbol: 'BRTI',
          priceToBeat: { value: '100' },
          settlementPrice: { value: '101' }
        }
      })
    });
    assert.equal(looked.line, '太平洋时间10月14日结算：新增1笔，胜1负0，当日盈亏+2.00美元；累计1笔，胜率100%。');
    const saved = JSON.parse((await readFile(join(root, 'real-orders.jsonl'), 'utf8')).trim());
    assert.equal(saved.won, true);
    assert.equal(saved.settlement_source, 'cf-benchmarks-brti');
    const again = await runUsDigest({
      ledgerRoot: root,
      now: NOW,
      lookup: async () => { throw new Error('gamma should not be required'); }
    });
    assert.equal(again.changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function emptyStats() {
  return {
    record: { wins: 0, losses: 0, lossStreak: 0 },
    dailyFilled: 0,
    dailyPending: 0,
    cashUsd: 40,
    openWindows: [],
    ptDate: '2026-10-14'
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}
