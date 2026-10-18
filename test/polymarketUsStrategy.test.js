import test from 'node:test';
import assert from 'node:assert/strict';
import {
  US_BBO_MAX_AGE_MS,
  US_DAILY_CAPS,
  US_EDGE_BTC_MISPRICE,
  US_EDGE_STANDARD,
  US_MOMENTUM_MAX_PRICE,
  US_MOMENTUM_TRIGGER_SCALE,
  US_SPEC_VERSION
} from '../src/polymarketUs/constants.js';
import { buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import {
  evaluateUsSchedule,
  evaluateUsSignal,
  pacificParts,
  resolveUsSizeUsd
} from '../src/polymarketUs/strategy.js';

const WED_OPEN = new Date('2026-10-14T15:37:00.000Z');
const WED_CLOSED = new Date('2026-10-14T15:20:00.000Z');
const SAT_ANY = new Date('2026-10-17T18:00:00.000Z');
const MON_LONG = new Date('2026-10-12T16:00:00.000Z');

function signal(overrides = {}) {
  return {
    sector: 'weather',
    slug: 'nyc-high-72',
    side: 'Yes',
    limit_price: 0.4,
    model_prob: 0.5,
    ask: 0.4,
    spread_cents: 1,
    liquidity_usd: 50,
    confidence: 'High',
    resolution_risk: 'Low',
    basis: 'ensemble 占比',
    bbo_at: WED_OPEN.toISOString(),
    status: 'pending',
    ...overrides
  };
}

function place(overrides = {}, context = {}) {
  return evaluateUsSignal(signal(overrides), {
    now: WED_OPEN,
    dryRun: true,
    scheduleWindowMinutes: 15,
    bboMaxAgeMs: US_BBO_MAX_AGE_MS,
    ...context
  });
}

test('SCAN_SPEC v3.3 caps, edges, and momentum scale are constants', () => {
  assert.equal(US_SPEC_VERSION, 'v3.3');
  assert.deepEqual(US_DAILY_CAPS, {
    live: 10,
    momentum: 15,
    btc_misprice: 8,
    pregame: 6,
    weather: 4,
    macro: 3,
    crypto: 4,
    master: 4
  });
  assert.equal(US_EDGE_STANDARD, 0.03);
  assert.equal(US_EDGE_BTC_MISPRICE, 0.04);
  assert.equal(US_MOMENTUM_MAX_PRICE, 0.88);
  assert.equal(US_MOMENTUM_TRIGGER_SCALE, 0.5);
});

test('weekday 8:37 PT is a named window and 8:20 PT is still full suite', () => {
  assert.equal(pacificParts(WED_OPEN).weekday, 'Wed');
  assert.equal(pacificParts(WED_OPEN).hour, 8);
  assert.equal(pacificParts(WED_OPEN).minute, 37);
  assert.equal(evaluateUsSchedule(WED_OPEN, signal(), 15).open, true);
  assert.equal(evaluateUsSchedule(WED_OPEN, signal(), 15).code, 'weekday');
  const offWindow = evaluateUsSchedule(WED_CLOSED, signal(), 15);
  assert.equal(offWindow.open, true);
  assert.equal(offWindow.code, 'full_suite');
  assert.equal(evaluateUsSchedule(SAT_ANY, signal(), 15).windowId, 'weekend');
});

test('weekday BTC short dense is 24/7 and other sectors stay open all day', () => {
  const nine = new Date('2026-10-14T16:00:00.000Z');
  assert.equal(evaluateUsSchedule(nine, signal({ sector: 'weather' }), 15).open, true);
  assert.equal(evaluateUsSchedule(nine, signal({ sector: 'weather' }), 15).code, 'full_suite');
  assert.equal(evaluateUsSchedule(nine, signal({ sector: 'pregame' }), 15).open, true);
  assert.equal(evaluateUsSchedule(nine, signal({ sector: 'btc_misprice' }), 15).code, 'weekday_btc_dense');
  assert.equal(evaluateUsSchedule(nine, signal({ sector: 'btc-misprice' }), 15).open, true);
  assert.equal(evaluateUsSchedule(nine, signal({ sector: 'momentum' }), 15).windowId, 'wd-btc-dense');
  const evening = new Date('2026-10-15T05:00:00.000Z');
  assert.equal(evaluateUsSchedule(evening, signal({ sector: 'btc_misprice' }), 15).open, true);
  assert.equal(evaluateUsSchedule(evening, signal({ sector: 'btc_misprice' }), 15).code, 'weekday_btc_dense');
  assert.equal(evaluateUsSchedule(evening, signal({ sector: 'momentum' }), 15).windowId, 'wd-btc-dense');
  assert.equal(evaluateUsSchedule(evening, signal({ sector: 'weather' }), 15).open, true);
  assert.equal(evaluateUsSchedule(evening, signal({ sector: 'weather' }), 15).code, 'full_suite');
  const early = new Date('2026-10-14T14:30:00.000Z');
  assert.equal(evaluateUsSchedule(early, signal({ sector: 'momentum' }), 15).open, true);
  assert.equal(evaluateUsSchedule(early, signal({ sector: 'pregame' }), 15).code, 'full_suite');
  const narrow = {
    schedule: {
      fullSuiteEveryLoop: false,
      weekdayBtcDense: { start: '08:00', end: '20:00' },
      sessionLengthMinutes: 15,
      weekdaySessions: ['08:37', '12:37', '18:37'],
      mondayLongDated: '08:50',
      timeZone: 'America/Los_Angeles'
    }
  };
  assert.equal(evaluateUsSchedule(evening, signal({ sector: 'weather' }), 15, narrow).open, false);
  assert.equal(evaluateUsSchedule(evening, signal({ sector: 'weather' }), 15, narrow).code, 'outside_schedule');
});

test('Monday 9:00 PT still labels master and also opens the rest of the suite', () => {
  const parts = pacificParts(MON_LONG);
  assert.equal(parts.isMonday, true);
  assert.equal(parts.hour, 9);
  assert.equal(evaluateUsSchedule(MON_LONG, signal({ sector: 'weather' }), 15).open, true);
  assert.equal(evaluateUsSchedule(MON_LONG, signal({ sector: 'weather' }), 15).code, 'full_suite');
  assert.equal(evaluateUsSchedule(MON_LONG, signal({ sector: 'master', long_horizon: true }), 15).windowId, 'mon-0850');
});

test('weather signal becomes a US limit-buy payload inside the window', () => {
  const result = place();
  assert.equal(result.action, 'place');
  assert.equal(result.sizeUsd, 2);
  assert.equal(result.order.intent, 'ORDER_INTENT_BUY_LONG');
  assert.equal(result.order.type, 'ORDER_TYPE_LIMIT');
  assert.equal(result.order.price.value, '0.40');
  assert.equal(result.order.price.currency, 'USD');
  assert.equal(result.order.quantity, 5);
  assert.equal(result.order.tif, 'TIME_IN_FORCE_GOOD_TILL_CANCEL');
  assert.equal(result.order.marketSlug, 'nyc-high-72');
  assert.equal(result.event_url, 'https://polymarket.us/event/nyc-high-72');
});

test('cpc slug stays on the order and leaves the event url', () => {
  const result = place({ slug: 'cpc-nyc-high-72' });
  assert.equal(result.order.marketSlug, 'cpc-nyc-high-72');
  assert.equal(result.event_url, 'https://polymarket.us/event/nyc-high-72');
});

test('No side buys the short outcome', () => {
  const result = place({ side: 'Down', sector: 'btc_misprice', model_prob: 0.6, edge: 0.2 });
  assert.equal(result.order.intent, 'ORDER_INTENT_BUY_SHORT');
});

test('edge below 3pp is skipped and does not touch a schedule defer', () => {
  const result = place({ model_prob: 0.42, edge: 0.02 });
  assert.equal(result.action, 'skip');
  assert.equal(result.code, 'edge');
  assert.equal(result.updateStatus, true);
});

test('outside the old weekday windows a valid non-BTC signal still places', () => {
  const result = place({}, { now: WED_CLOSED });
  assert.equal(result.action, 'place');
  assert.notEqual(result.code, 'outside_schedule');
});

test('win-rate tiers and a cold sector stay at $2 with a cleaner edge', () => {
  const hot = { weather: { samples: 10, winRate: 0.8, streakLosses: 0 } };
  assert.equal(resolveUsSizeUsd('weather', hot, null).sizeUsd, 5);
  const mid = { weather: { samples: 5, winRate: 0.7, streakLosses: 0 } };
  assert.equal(resolveUsSizeUsd('weather', mid, 5).sizeUsd, 3);
  const cold = { weather: { samples: 10, winRate: 0.4, streakLosses: 1 } };
  assert.equal(resolveUsSizeUsd('weather', cold, 5).sizeUsd, 2);
  const rejected = place({ model_prob: 0.44 }, { stats: cold });
  assert.equal(rejected.code, 'edge');
  const accepted = place({ model_prob: 0.46 }, { stats: cold });
  assert.equal(accepted.action, 'place');
  assert.equal(accepted.sizeUsd, 2);
});

test('daily cap, one-sided window, intl url, and low confidence stop the order', () => {
  const capped = place({}, { dailyCounts: { weather: 4, live: 0, momentum: 0, btc_misprice: 0, pregame: 0, macro: 0, crypto: 0, master: 0 } });
  assert.equal(capped.code, 'daily_cap');
  const clash = place({}, { openWindows: [{ windowId: 'nyc-high-72', side: 'no' }] });
  assert.equal(clash.code, 'one_sided');
  assert.equal(place({ url: 'https://polymarket.com/event/nyc-high-72' }).code, 'intl_market');
  assert.equal(place({ confidence: 'Low' }).code, 'low_confidence');
  assert.equal(place({ resolution_risk: 'High' }).code, 'resolution_risk');
});

test('cash reserve blocks a live-sized order that would leave less than $15', () => {
  const result = place({}, { buyingPower: 16, cashReserveUsd: 15 });
  assert.equal(result.code, 'cash_reserve');
  const ok = place({}, { buyingPower: 20, cashReserveUsd: 15 });
  assert.equal(ok.action, 'place');
});

test('null liquidity does not hide a real depth, and a quoted zero still blocks', () => {
  const fromGates = place({
    liquidity_usd: null,
    gates: { liquidity_usd: null, depth_usd: 80, spread_cents: 1 }
  });
  assert.equal(fromGates.action, 'place');
  const empty = place({}, {
    quote: {
      yesAsk: 0.4,
      spread: 0.01,
      depthUsd: 0,
      observedAt: WED_OPEN.toISOString()
    }
  });
  assert.equal(empty.code, 'depth');
});

test('BTC age is measured against the trade-time clock, not the scan timestamp', () => {
  const asOf = WED_OPEN;
  const fresh = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    bbo_at: new Date(asOf.getTime() - 120_000).toISOString()
  }, {
    bboAsOf: asOf,
    quote: {
      yesAsk: 0.4,
      spread: 0.01,
      depthUsd: 50,
      observedAt: new Date(asOf.getTime() - 30_000).toISOString()
    }
  });
  assert.equal(fresh.action, 'place');
  const quiet = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    ask: 0.4,
    limit_price: 0.4,
    bbo_at: asOf.toISOString()
  }, {
    bboAsOf: asOf,
    quote: {
      yesAsk: 0.4,
      spread: 0.01,
      depthUsd: 50,
      observedAt: new Date(asOf.getTime() - 46_000).toISOString()
    }
  });
  assert.equal(quiet.action, 'place');
  assert.equal(quiet.code, 'pass');
  const midMoved = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    ask: 0.4,
    limit_price: 0.4,
    market_p: 0.395
  }, {
    bboAsOf: asOf,
    quote: {
      yesAsk: 0.4,
      bestAsk: 0.4,
      bestBid: 0.33,
      spread: 0.07,
      depthUsd: 50,
      observedAt: new Date(asOf.getTime() - 46_000).toISOString()
    }
  });
  assert.equal(midMoved.code, 'stale_bbo');
  const moved = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    ask: 0.4,
    limit_price: 0.4,
    market_p: 0.4
  }, {
    bboAsOf: asOf,
    quote: {
      yesAsk: 0.34,
      bestAsk: 0.34,
      bestBid: 0.33,
      spread: 0.01,
      depthUsd: 50,
      observedAt: new Date(asOf.getTime() - 46_000).toISOString()
    }
  });
  assert.equal(moved.code, 'stale_bbo');
  const chased = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    ask: 0.4,
    limit_price: 0.4
  }, {
    bboAsOf: asOf,
    quote: {
      yesAsk: 0.46,
      bestAsk: 0.46,
      bestBid: 0.45,
      spread: 0.01,
      depthUsd: 50,
      observedAt: new Date(asOf.getTime() - 46_000).toISOString()
    }
  });
  assert.equal(chased.code, 'price_ran_away');
});

test('BTC misprice requires 4pp and a 45s BBO; momentum needs gates and the 0.88 cap', () => {
  const quietClock = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    bbo_at: new Date(WED_OPEN.getTime() - 60_000).toISOString()
  });
  assert.equal(quietClock.action, 'place');
  const absurdClock = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    bbo_at: new Date(WED_OPEN.getTime() - 301_000).toISOString()
  });
  assert.equal(absurdClock.code, 'stale_bbo');
  const within45s = place({
    sector: 'btc_misprice',
    model_prob: 0.6,
    bbo_at: new Date(WED_OPEN.getTime() - 30_000).toISOString()
  });
  assert.equal(within45s.action, 'place');
  const thin = place({ sector: 'btc_misprice', model_prob: 0.43, edge: 0.03 });
  assert.equal(thin.action, 'skip');
  assert.equal(thin.code, 'model_floor');
  const rawFourPp = place({ sector: 'btc_misprice', model_prob: 0.44, bid: 0.39 });
  assert.equal(rawFourPp.code, 'model_floor');
  const belowSoft = place({ sector: 'btc_misprice', model_prob: 0.42 });
  assert.equal(belowSoft.code, 'model_floor');
  const fatEdge = place({
    sector: 'btc_misprice',
    model_prob: 0.90,
    ask: 0.40,
    limit_price: 0.40,
    bid: 0.39
  });
  assert.equal(fatEdge.code, 'edge_cap');
  const blended = place({
    sector: 'btc_misprice',
    model_prob: 0.64,
    ask: 0.55,
    limit_price: 0.55,
    bid: 0.54
  });
  assert.equal(blended.action, 'place');
  assert.equal(blended.order_kind, 'normal');
  assert.equal(blended.sizeUsd, 2);
  assert.equal(blended.pUsed, 0.5973);
  assert.equal(blended.edge, 0.0473);
  const atFloor = place({
    sector: 'btc_misprice',
    model_prob: 0.56,
    ask: 0.35,
    limit_price: 0.35,
    bid: 0.34
  });
  assert.equal(atFloor.action, 'place');
  const belowFloor = place({
    sector: 'btc_misprice',
    model_prob: 0.80,
    ask: 0.34,
    limit_price: 0.34,
    bid: 0.33
  });
  assert.equal(belowFloor.code, 'price_band');
  const atCap = place({
    sector: 'btc_misprice',
    model_prob: 0.80,
    ask: 0.65,
    limit_price: 0.65,
    bid: 0.64
  });
  assert.equal(atCap.action, 'place');
  const aboveCap = place({
    sector: 'btc_misprice',
    model_prob: 0.80,
    ask: 0.66,
    limit_price: 0.66,
    bid: 0.65
  });
  assert.equal(aboveCap.code, 'price_band');
  const longshot = place({
    sector: 'btc_misprice',
    model_prob: 0.8,
    ask: 0.21,
    limit_price: 0.21,
    bid: 0.2
  });
  assert.equal(longshot.code, 'price_band');
  const momentum = place({
    sector: 'momentum',
    limit_price: 0.9,
    ask: 0.9,
    model_prob: 0.87,
    mos: true,
    same_way: true
  });
  assert.equal(momentum.code, 'price_band');
  const ungated = place({ sector: 'momentum', limit_price: 0.6, ask: 0.6, model_prob: 0.7 });
  assert.equal(ungated.code, 'momentum_gates');
  const shortDistance = place({
    sector: 'momentum',
    limit_price: 0.6,
    ask: 0.6,
    model_prob: 0.7,
    mos: true,
    same_way: true,
    distance_bps: 3
  });
  assert.equal(shortDistance.action, 'place');
  assert.equal(shortDistance.code, 'exploratory');
  assert.equal(shortDistance.order_kind, 'exploratory');
  assert.equal(shortDistance.sizeUsd, 1);
  const tooShort = place({
    sector: 'momentum',
    limit_price: 0.6,
    ask: 0.6,
    model_prob: 0.7,
    mos: true,
    same_way: true,
    distance_bps: 1
  });
  assert.equal(tooShort.code, 'momentum_distance');
  const gated = place({
    sector: 'momentum',
    limit_price: 0.6,
    ask: 0.6,
    model_prob: 0.7,
    mos: true,
    same_way: true,
    distance_bps: 4
  });
  assert.equal(gated.action, 'place');
  assert.equal(gated.code, 'pass');
  assert.equal(gated.order_kind, 'normal');
  assert.equal(gated.sizeUsd, 2);
  assert.equal(gated.order.price.value, '0.60');
});

test('exploratory $1 stays inside the soft band and hard gates still skip', () => {
  const liveSoft = place({
    sector: 'live',
    slug: 'tec-nba-live',
    model_prob: 0.69,
    ask: 0.66,
    limit_price: 0.66
  });
  assert.equal(liveSoft.code, 'exploratory');
  assert.equal(liveSoft.order_kind, 'exploratory');
  assert.equal(liveSoft.sizeUsd, 1);
  assert.equal(liveSoft.edge, 0.03);
  const liveFull = place({
    sector: 'live',
    slug: 'tec-nba-live',
    model_prob: 0.7,
    ask: 0.66,
    limit_price: 0.66
  });
  assert.equal(liveFull.code, 'pass');
  assert.equal(liveFull.order_kind, 'normal');
  assert.equal(liveFull.sizeUsd, 2);
  const liveTiny = place({
    sector: 'live',
    slug: 'tec-nba-live',
    model_prob: 0.67,
    ask: 0.66,
    limit_price: 0.66
  });
  assert.equal(liveTiny.code, 'edge');

  const cold = { btc_misprice: { samples: 10, winRate: 0.4, streakLosses: 0 } };
  const coldGap = place({
    sector: 'btc_misprice',
    model_prob: 0.645,
    ask: 0.55,
    limit_price: 0.55,
    bid: 0.54
  }, { stats: cold });
  assert.equal(coldGap.code, 'edge');
  const coldSoft = place({ sector: 'btc_misprice', model_prob: 0.43 }, { stats: cold });
  assert.equal(coldSoft.code, 'model_floor');

  const soft = {
    sector: 'btc_misprice',
    model_prob: 0.64,
    ask: 0.50,
    limit_price: 0.50,
    bid: 0.49,
    slug: 'cpc-btc-updown-15m-demo'
  };
  const stale = place(soft, {
    bboAsOf: WED_OPEN,
    quote: {
      yesAsk: 0.50,
      spread: 0.01,
      depthUsd: 40,
      observedAt: new Date(WED_OPEN.getTime() - 46_000).toISOString()
    }
  });
  assert.equal(stale.action, 'place');
  assert.equal(stale.code, 'pass');
  assert.equal(stale.order_kind, 'normal');
  assert.equal(stale.sizeUsd, 2);
  const empty = place(soft, {
    quote: { yesAsk: 0.4, spread: 0.01, depthUsd: 0, observedAt: WED_OPEN.toISOString() }
  });
  assert.equal(empty.code, 'depth');
  const ran = place({ ...soft, limit_price: 0.3 }, {
    quote: { yesAsk: 0.4, spread: 0.01, depthUsd: 40, observedAt: WED_OPEN.toISOString() }
  });
  assert.equal(ran.code, 'price_ran_away');
  const outside = place({ ...soft, ask: 0.21, limit_price: 0.21 });
  assert.equal(outside.code, 'price_band');
  const clash = place(soft, { openWindows: [{ slug: 'cpc-btc-updown-15m-demo', side: 'no' }] });
  assert.equal(clash.code, 'one_sided');
  const braked = place(soft, {
    sectorPauses: {
      btc_misprice: { pausedUntil: new Date(WED_OPEN.getTime() + 3_600_000).toISOString(), wins: 2, pnlUsd: -4 }
    }
  });
  assert.equal(braked.code, 'sector_brake');
  const reserveOk = place(soft, { buyingPower: 17 });
  assert.equal(reserveOk.action, 'place');
  assert.equal(reserveOk.sizeUsd, 2);
  const reserveFail = place(soft, { buyingPower: 16.5 });
  assert.equal(reserveFail.code, 'cash_reserve');
  const fullReserve = place({ sector: 'btc_misprice', model_prob: 0.6, slug: 'cpc-btc-updown-15m-demo' }, { buyingPower: 16 });
  assert.equal(fullReserve.code, 'cash_reserve');
});

test('live in-play uses 4pp up to 0.95 and endgame allows a high model', () => {
  const inplay = place({
    sector: 'live',
    model_prob: 0.7,
    limit_price: 0.66,
    ask: 0.66
  });
  assert.equal(inplay.action, 'place');
  const rich = place({
    sector: 'live',
    model_prob: 0.7,
    limit_price: 0.96,
    ask: 0.96
  });
  assert.equal(rich.code, 'price_band');
  const endgame = place({
    sector: 'live',
    endgame: true,
    model_prob: 0.91,
    limit_price: 0.9,
    ask: 0.9
  });
  assert.equal(endgame.action, 'place');
  assert.equal(endgame.order.price.value, '0.90');
});

test('dry-run stays on unless live flag, dry-run off, and both keys are set', () => {
  assert.equal(buildPolymarketUsConfig({}).dryRun, true);
  assert.equal(buildPolymarketUsConfig({}).liveBlockedReason, 'missing_credentials');
  assert.equal(buildPolymarketUsConfig({
    POLYMARKET_US_ACCESS_KEY: 'kid',
    POLYMARKET_US_SECRET_KEY: 'secret',
    POLYMARKET_US_LIVE_TRADING_ENABLED: 'true'
  }).liveBlockedReason, 'dry_run_flag');
  const live = buildPolymarketUsConfig({
    POLYMARKET_US_ACCESS_KEY: 'kid',
    POLYMARKET_US_SECRET_KEY: 'secret',
    POLYMARKET_US_LIVE_TRADING_ENABLED: 'true',
    POLYMARKET_US_DRY_RUN: 'false'
  });
  assert.equal(live.dryRun, false);
  assert.equal(live.gatewayBaseUrl, 'https://gateway.polymarket.us');
  assert.equal(live.apiBaseUrl, 'https://api.polymarket.us');
  assert.equal(live.line, 'polymarket_us');
});
