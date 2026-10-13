import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  blendPlan14Up,
  buildPolymarketPaperPlan14,
  computePlan14OrderUsd,
  estimatePlan14SpotUp,
  evaluatePlan14Entry,
  evaluatePlan14Exit,
  confirmPlan14Stop,
  evaluatePlan14Exposure,
  rankPlan14Views,
  PLAN14_VERSION,
  PLAN14_V9_VERSION,
  PLAN14_V8_VERSION,
  PLAN14_PREVIOUS_VERSION,
  PLAN14_V3_VERSION
} from '../src/polymarketPlan14.js';
import { PolymarketTradingService, summarizePaperOrderForApi } from '../src/polymarketTrading.js';

const SLOT_ISO = '2099-01-10T00:00:00.000Z';
const TARGET_ISO = '2099-01-10T00:05:00.000Z';
const NOW = new Date('2099-01-10T00:02:30.000Z');

function signal({ spot = 100.1, open = 100, vol = 0.001, quoteAgeMs = 1000, now = NOW } = {}) {
  return {
    symbol: 'BTC-USD',
    schedule: { currentSlotIso: SLOT_ISO, nextSlotIso: TARGET_ISO, slotMinutes: 5, secondsToNext: 150 },
    prediction: { targetTimeIso: TARGET_ISO, comparisonBasePrice: open },
    indicators: {
      currentPrice: spot,
      slotStartPrice: open,
      volatility15mPct: vol,
      currentQuoteTime: new Date(now.getTime() - quoteAgeMs).toISOString()
    }
  };
}

function sentiment(up = 0.5) {
  return {
    available: true,
    symbol: 'BTC-USD',
    timeframe: '5m',
    upTokenId: 'up-token',
    downTokenId: 'down-token',
    upPrice: up,
    downPrice: 1 - up,
    upBestAsk: up + 0.01,
    downBestAsk: 1 - up + 0.01
  };
}

function book(up = 0.5) {
  return {
    up: { bid: up - 0.01, ask: up + 0.01, bookTimeMs: NOW.getTime() },
    down: { bid: 1 - up - 0.01, ask: 1 - up + 0.01, bookTimeMs: NOW.getTime() }
  };
}

test('spot model is symmetric around the window open', () => {
  const args = { open: 100, volatility: 0.001, secondsRemaining: 150, slotSeconds: 300 };
  const above = estimatePlan14SpotUp({ ...args, spot: 100.1 });
  const below = estimatePlan14SpotUp({ ...args, spot: 99.9 });
  assert.ok(above > 0.9);
  assert.ok(Math.abs(above + below - 1) < 0.002);
  assert.ok(Math.abs(estimatePlan14SpotUp({ ...args, spot: 100 }) - 0.5) < 1e-6);
});

test('blend stays anchored on the market and only tilts toward the spot model', () => {
  const tilted = blendPlan14Up({ marketUp: 0.5, spotUp: 0.92, timeframe: '5m' });
  assert.ok(tilted > 0.6 && tilted < 0.66, `tilted ${tilted}`);
  assert.equal(blendPlan14Up({ marketUp: 0.3, spotUp: null }), 0.3);
  const cheapSide = blendPlan14Up({ marketUp: 0.15, spotUp: 0.5 });
  assert.ok(cheapSide > 0.15 && cheapSide < 0.5, 'normalized estimate stays between its inputs');
  assert.ok(Math.abs(blendPlan14Up({ marketUp: 0.8, spotUp: 0.8 }) - 0.8) < 1e-9);
  assert.ok(blendPlan14Up({ marketUp: 0.8, spotUp: 0.8, legacy: true }) > 0.84);
});

test('cached quotes only prescreen; the fresh book makes the trade', () => {
  const pre = evaluatePlan14Entry({ signal: signal(), sentiment: sentiment(0.5), now: NOW });
  assert.equal(pre.allowed, false);
  assert.equal(pre.prescreen, true);
  assert.equal(pre.skipReason, 'awaiting_fresh_book');

  const fresh = evaluatePlan14Entry({ signal: signal(), sentiment: sentiment(0.5), book: book(0.5), now: NOW });
  assert.equal(fresh.allowed, true, fresh.reason);
  assert.equal(fresh.selected.direction, 'up');
  assert.equal(fresh.selected.ask, 0.51);
  assert.ok(fresh.selected.edge > 0.08);
});

test('no edge when spot agrees with the market price', () => {
  const decision = evaluatePlan14Entry({
    signal: signal({ spot: 100 }),
    sentiment: sentiment(0.5),
    book: book(0.5),
    now: NOW
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.skipReason, 'model_not_above_mid');
});

test('stale spot, late window and inconsistent books are rejected', () => {
  const stale = evaluatePlan14Entry({ signal: signal({ quoteAgeMs: 20_000 }), sentiment: sentiment(0.5), book: book(0.5), now: NOW });
  assert.equal(stale.skipReason, 'stale_spot_quote');

  const late = evaluatePlan14Entry({ signal: signal(), sentiment: sentiment(0.5), book: book(0.5), now: new Date('2099-01-10T00:04:40.000Z') });
  assert.equal(late.skipReason, 'outside_entry_window');

  const broken = evaluatePlan14Entry({
    signal: signal(),
    sentiment: sentiment(0.5),
    book: { up: { bid: 0.08, ask: 0.09 }, down: { bid: 0.49, ask: 0.51 } },
    now: NOW
  });
  assert.equal(broken.allowed, false);
});

test('kelly sizing grows with edge, caps at max pct and keeps the 5-share floor', () => {
  const small = computePlan14OrderUsd({ cash: 500, candidate: { cost: 0.53, p: 0.58, ask: 0.51 } });
  const big = computePlan14OrderUsd({ cash: 500, candidate: { cost: 0.53, p: 0.70, ask: 0.51 } });
  assert.ok(big > small);
  assert.equal(big, 15);
  assert.equal(computePlan14OrderUsd({ cash: 500, candidate: { cost: 0.53, p: 0.531, ask: 0.51 } }), 2.55);
});

test('exit: model take-profit, model stop-loss, and hold without a fresh spot', () => {
  const nowMs = NOW.getTime();
  const order = { direction: 'up', timeframe: '5m', targetTimeIso: TARGET_ISO, limitPrice: 0.5 };
  const fresh = { quoteTimeMs: nowMs - 1000, open: 100, volatility: 0.001 };

  const neutral = evaluatePlan14Exit({ order, inputs: { ...fresh, bid: 0.80, ask: 0.82, spot: 100 }, nowMs });
  assert.equal(neutral.exit, false, 'a fairly priced winner rides to fee-free settlement');

  const tp = evaluatePlan14Exit({ order, inputs: { ...fresh, bid: 0.80, ask: 0.82, spot: 99.95 }, nowMs });
  assert.equal(tp.exit, true);
  assert.equal(tp.exitStatus, 'model-take-profit');

  const sl = evaluatePlan14Exit({ order, inputs: { ...fresh, bid: 0.45, ask: 0.47, spot: 99.9 }, nowMs });
  assert.equal(sl.exit, true);
  assert.equal(sl.exitStatus, 'model-stop-loss');

  const hold = evaluatePlan14Exit({ order, inputs: { ...fresh, bid: 0.55, ask: 0.57, spot: 100.1 }, nowMs });
  assert.equal(hold.exit, false);

  const blind = evaluatePlan14Exit({ order, inputs: { bid: 0.45, ask: 0.47, quoteTimeMs: nowMs - 60_000, spot: 99.9, open: 100, volatility: 0.001 }, nowMs });
  assert.equal(blind.exit, false);
});

test('builder emits a sized action priced at the fresh ask with one key per window', () => {
  const plan = buildPolymarketPaperPlan14({
    signal: signal(),
    sentiment: sentiment(0.5),
    plan14Book: book(0.5),
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, cash: 500 },
    now: NOW
  });
  assert.equal(plan.planId, 'plan14');
  assert.equal(plan.action.shouldTrade, true, plan.action.reason);
  assert.equal(plan.action.direction, 'up');
  assert.equal(plan.action.limitPrice, 0.51);
  assert.equal(plan.action.executionKey, `${SLOT_ISO}_BTC-USD_5m_plan14`);
});

test('plan14 live is hard-disabled and filtered from live plans', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true },
    statePath: join(tmpdir(), `pm-plan14-${Date.now()}-${Math.random()}.json`)
  });
  await assert.rejects(() => service.setLiveAutoPlan('plan14', true), /Plan14 仅用于前向模拟验证/);
});

test('plan14 paper fills at the fresh ask and the model exit books fee-adjusted proceeds', async () => {
  const service = new PolymarketTradingService({
    config: {
      paperLiveParityEnabled: false,
      maxOrderUsd: 500,
      paperExecutableAskFillEnabled: true,
      paperTakerFeeEnabled: true,
      paperTakerFeeRate: 0.07
    },
    statePath: join(tmpdir(), `pm-plan14-exit-${Date.now()}-${Math.random()}.json`)
  });
  await service.configurePortfolio({ planId: 'plan14', cash: 500 });
  const order = await service.createPaperOrder({
    planId: 'plan14',
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 10,
    sentiment: { ...sentiment(0.40), schedule: { currentSlotIso: SLOT_ISO } },
    plan: {
      timeframe: '5m',
      slotIso: SLOT_ISO,
      targetTimeIso: TARGET_ISO,
      action: { shouldTrade: true, direction: 'up', limitPrice: 0.5 }
    }
  }, 'plan14');
  assert.equal(order.limitPrice, 0.5);
  const nowMs = NOW.getTime();
  const first = await service.processPlan14PaperExits(async () => ({
    bid: 0.80, ask: 0.82, spot: 99.95, open: 100, volatility: 0.001, quoteTimeMs: nowMs - 1000, bookTimeMs: nowMs
  }), { nowMs });
  assert.equal(first.length, 0);
  const closed = await service.processPlan14PaperExits(async () => ({
    bid: 0.80, ask: 0.82, spot: 99.95, open: 100, volatility: 0.001,
    quoteTimeMs: nowMs + 3000, bookTimeMs: nowMs + 3000
  }), { nowMs: nowMs + 3000 });
  assert.equal(closed.length, 1);
  assert.equal(order.exitStatus, 'model-take-profit');
  assert.ok(order.paperExitFeeUsd > 0);
  assert.ok(order.pnl > 0);
});

test('15m cannot enter through the strategy, auto config, or direct paper order', async () => {
  assert.equal(evaluatePlan14Entry({ timeframe: '15m' }).skipReason, 'timeframe_paused');
  const service = new PolymarketTradingService({ config: { paperLiveParityEnabled: false } });
  service.persist = async () => {};
  await service.configurePortfolio({ planId: 'plan14', cash: 500 });
  const auto = await service.setAuto(true, { planId: 'plan14', timeframes: ['5m', '15m'] });
  assert.deepEqual(auto.timeframes, ['5m']);
  await assert.rejects(service.createPaperOrder({
    symbol: 'BTC-USD', direction: 'up', usd: 10,
    sentiment: { ...sentiment(), timeframe: '15m' },
    plan: { timeframe: '15m', action: { limitPrice: 0.5 } }
  }, 'plan14'), /15m 暂停/);
});

test('stop confirmation requires distinct quotes, duration, continuity and fresh evidence', () => {
  const order = { timeframe: '5m' };
  const decision = { exit: true, exitStatus: 'model-stop-loss' };
  const base = NOW.getTime();
  function sample(offset, quoteOffset = offset, d = decision) {
    const result = confirmPlan14Stop(order, d, { quoteTimeMs: base + quoteOffset }, base + offset);
    order.plan14StopConfirmation = result.state;
    return result;
  }
  assert.equal(sample(0).confirmed, false);
  assert.equal(sample(5000, 0).state.count, 1, 'cached quote must not count');
  assert.equal(sample(6000).confirmed, false);
  assert.equal(sample(9000).confirmed, false, '3 samples before 10 seconds must wait');
  assert.equal(sample(11000).confirmed, true);
  assert.equal(sample(12000, 12000, { exit: false }).state, null);
  assert.equal(sample(13000).state.count, 1);
  assert.equal(sample(14000, -60000).state, null, 'stale data breaks continuity');
  assert.equal(sample(15000).state.count, 1);
  assert.equal(sample(40000).state.count, 1, 'long sampling gap starts over');
});

test('paper stop waits, resets after recovery, exits once, and official comparison preserves cash/PnL', async () => {
  const service = new PolymarketTradingService({ config: { paperTakerFeeEnabled: true, paperTakerFeeRate: 0.07 } });
  service.persist = async () => {};
  const bucket = service.getBucket('plan14');
  const order = {
    id: 'confirmation-test', planId: 'plan14', direction: 'up', timeframe: '5m',
    slotIso: SLOT_ISO, targetTimeIso: TARGET_ISO, marketSlug: 'test-market',
    settlementStatus: 'open', limitPrice: 0.5, usd: 10, shares: 19.3
  };
  bucket.paperOrders = [order];
  bucket.portfolio.cash = 490;
  const base = NOW.getTime();
  async function tick(offset, spot = 99.9) {
    return service.processPlan14PaperExits(async () => ({
      bid: 0.45, ask: 0.47, spot, open: 100, volatility: 0.001, quoteTimeMs: base + offset
    }), { nowMs: base + offset });
  }
  assert.equal((await tick(0)).length, 0);
  assert.equal((await tick(5000)).length, 0);
  assert.equal((await tick(6000, 100.1)).length, 0);
  assert.equal(order.plan14StopConfirmation, null);
  assert.equal((await tick(10000)).length, 0);
  assert.equal((await tick(15000)).length, 0);
  assert.equal((await tick(20000)).length, 1);
  assert.equal((await tick(21000)).length, 0);
  assert.equal(order.exitStatus, 'model-stop-loss');
  assert.equal(order.plan14LastExitObservation.confirmation.count, 3);
  const cash = bucket.portfolio.cash;
  const pnl = order.pnl;
  const now = new Date('2099-01-10T00:06:00Z');
  await service.backfillEarlyExitOutcomes(async () => ({ actualDirection: 'up', priceSource: 'binance' }), { now });
  assert.equal(order.counterfactualHoldPnl, undefined, 'only official outcomes evaluate Plan14');
  await service.backfillEarlyExitOutcomes(async () => ({
    actualDirection: 'up', officialOutcome: 'Up', outcomePrices: [1, 0], priceSource: 'polymarket-official'
  }), { now });
  assert.equal(order.counterfactualHoldPnl, 9.3);
  assert.equal(order.counterfactualOutcomeSource, 'polymarket-official');
  assert.equal(bucket.portfolio.cash, cash);
  assert.equal(order.pnl, pnl);
});

test('existing 15m positions retain exits while new 15m entries are paused', async () => {
  const service = new PolymarketTradingService({ config: {} });
  service.persist = async () => {};
  const order = { planId: 'plan14', timeframe: '15m', direction: 'up', slotIso: SLOT_ISO,
    targetTimeIso: '2099-01-10T00:15:00Z', limitPrice: 0.5, usd: 10, shares: 20, settlementStatus: 'open' };
  service.getBucket('plan14').paperOrders = [order];
  const closed = await service.processPlan14PaperExits(async () => ({ bid: 0.4, ask: 0.42,
    spot: 99, open: 100, volatility: 0.001, quoteTimeMs: NOW.getTime() }), { nowMs: NOW.getTime() });
  assert.equal(closed.length, 1);
});

test('order row labels model exits honestly and shows hold comparison separately', () => {
  const source = readFileSync(new URL('../public/polymarket-paper.js', import.meta.url), 'utf8');
  const label = source.slice(source.indexOf('function formatOrderExitLabel('), source.indexOf('function renderStrategyCard('));
  const row = source.slice(source.indexOf('function renderOrderRow('), source.indexOf('function setOrderResult('));
  const context = vm.createContext({ formatNumber: n => Number(n).toFixed(2), pct: n => `${n * 100}%`,
    formatTime: () => '18:22', formatOrderSymbol: () => 'ETH', escapeHtml: s => String(s) });
  vm.runInContext(label + row, context);
  const apiOrder = summarizePaperOrderForApi({ planId: 'plan14', settlementStatus: 'settled',
    exitStatus: 'model-stop-loss', exitPrice: 0.85, limitPrice: 0.86, usd: 11.61,
    pnl: -0.37, outcome: 'DOWN', actualDirection: 'down', counterfactualHoldPnl: 1.76 });
  const html = context.renderOrderRow(apiOrder);
  assert.match(html, /模型止损/);
  assert.doesNotMatch(html, /结算赎回/);
  assert.match(html, /1\.76/);
  assert.match(html, /85%/);
  assert.match(html, /-0\.37/);
  assert.match(context.renderOrderRow({ ...apiOrder, exitTrigger: 'net-loss-risk' }), /风险止损/);
});

test('v4 sizing does not let minimum shares override the order risk budget', () => {
  assert.equal(computePlan14OrderUsd({ cash: 50, candidate: { cost: 0.81, p: 0.90, ask: 0.80 } }), 0);
});

test('v4 exposure is cross-symbol, timestamp-normalized, and consumed even after an exit', () => {
  const filled = { symbol: 'ETH-USD', timeframe: '5m', slotIso: SLOT_ISO,
    direction: 'down', usd: 10, shares: 12, settlementStatus: 'settled' };
  const args = { orders: [filled], slotIso: SLOT_ISO.replace('.000Z', 'Z'), direction: 'down',
    config: { plan14MaxSameDirectionEntriesPerSlot: 1 } };
  assert.equal(evaluatePlan14Exposure(args).allowed, false);
  assert.equal(evaluatePlan14Exposure({ ...args, direction: 'up' }).allowed, true);
  assert.equal(evaluatePlan14Exposure({ ...args, slotIso: TARGET_ISO }).allowed, true);
  assert.equal(evaluatePlan14Exposure({ ...args, orders: [{ ...filled, usd: 0 }] }).allowed, true);
  assert.equal(evaluatePlan14Exposure({ ...args, slotIso: null }).allowed, false);
});

test('v4 ranks actionable fresh-view edge, not the configured symbol order', () => {
  const views = [
    { symbol: 'BTC-USD', view: { plan: { action: { shouldTrade: true, edge: 0.05 } } } },
    { symbol: 'SOL-USD', view: { plan: { action: { shouldTrade: false, edge: 0.8 } } } },
    { symbol: 'ETH-USD', view: { plan: { action: { shouldTrade: true, edge: 0.09 } } } }
  ];
  assert.deepEqual(rankPlan14Views(views).map(x => x.symbol), ['ETH-USD', 'BTC-USD', 'SOL-USD']);
  assert.equal(views[0].symbol, 'BTC-USD');
});

test('v4 direct/concurrent entry cannot bypass same-direction or size limits', async () => {
  const service = new PolymarketTradingService({ config: { paperLiveParityEnabled: false, plan14MaxSameDirectionEntriesPerSlot: 1 } });
  service.persist = async () => {};
  await service.configurePortfolio({ planId: 'plan14', cash: 500 });
  const input = symbol => ({ symbol, direction: 'up', usd: 10,
    sentiment: { ...sentiment(), symbol, schedule: { currentSlotIso: SLOT_ISO } },
    plan: { timeframe: '5m', slotIso: SLOT_ISO, targetTimeIso: TARGET_ISO,
      action: { shouldTrade: true, direction: 'up', limitPrice: 0.5 } } });
  const results = await Promise.allSettled(['BTC-USD', 'ETH-USD'].map(s => service.createPaperOrder(input(s), 'plan14')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /同向最多/);
  const order = service.getBucket('plan14').paperOrders[0];
  assert.equal(order.strategyVersion, PLAN14_VERSION);
  order.settlementStatus = 'settled';
  await assert.rejects(service.createPaperOrder({ ...input('XRP-USD'), allowFlipReentry: true }, 'plan14'), /同向最多/);
  const nextSlot = input('SOL-USD');
  nextSlot.plan.slotIso = TARGET_ISO;
  nextSlot.sentiment.schedule.currentSlotIso = TARGET_ISO;
  nextSlot.usd = 30;
  await assert.rejects(service.createPaperOrder(nextSlot, 'plan14'), /单笔现金比例上限/);
  assert.equal(service.getBucket('plan14').paperOrders.length, 1);
});

test('v4 risk exit uses net proceeds, a fresh bid, and no spot or tight-spread prerequisite', () => {
  const nowMs = NOW.getTime();
  const order = { strategyVersion: PLAN14_PREVIOUS_VERSION, direction: 'up', timeframe: '5m',
    targetTimeIso: TARGET_ISO, limitPrice: 0.5, usd: 10, shares: 19.3 };
  const inputs = { bid: 0.4, ask: 0.6, bookTimeMs: nowMs }; // Wide spread; spot is unavailable.
  const risk = evaluatePlan14Exit({ order, inputs, nowMs });
  assert.equal(risk.exitTrigger, 'net-loss-risk', 'entry + exit fees push net loss beyond 25%');
  assert.equal(risk.emergency, true);
  assert.equal(confirmPlan14Stop(order, risk, inputs, nowMs).confirmed, true);
  assert.equal(evaluatePlan14Exit({ order, inputs, nowMs, exitTakerFeeRate: 0 }).exit, false, 'fee-free proceeds have not hit trigger');
  assert.equal(evaluatePlan14Exit({ order, inputs: { ...inputs, bid: 0.2, bookTimeMs: nowMs - 11000 }, nowMs }).reason, 'stale_book');
  assert.equal(evaluatePlan14Exit({ order, inputs: { ...inputs, bookTimeMs: null }, nowMs }).reason, 'stale_book');
  assert.equal(evaluatePlan14Exit({ order, inputs: { ...inputs, bookTimeMs: nowMs + 3000 }, nowMs }).reason, 'stale_book');
  assert.equal(evaluatePlan14Exit({ order, inputs: { ...inputs, bid: null }, nowMs }).reason, 'no_bid');
  assert.equal(evaluatePlan14Exit({ order: { ...order, strategyVersion: PLAN14_V3_VERSION }, inputs, nowMs }).exit, false, 'old orders do not silently acquire new exits');
});

test('v4 risk exit books once, preserves history and gets official hold comparison', async () => {
  const service = new PolymarketTradingService({ config: { paperTakerFeeEnabled: true, paperTakerFeeRate: 0.07 } });
  service.persist = async () => {};
  const bucket = service.getBucket('plan14');
  const order = { id: 'risk-test', planId: 'plan14', strategyVersion: PLAN14_PREVIOUS_VERSION,
    direction: 'down', timeframe: '5m', slotIso: SLOT_ISO, targetTimeIso: TARGET_ISO,
    marketSlug: 'test-risk', settlementStatus: 'open', limitPrice: 0.8, usd: 10, shares: 12.325 };
  bucket.paperOrders = [order];
  bucket.portfolio.cash = 490;
  const nowMs = NOW.getTime();
  const quote = async () => ({ bid: 0.50, ask: 0.51, bookTimeMs: nowMs });
  assert.equal((await service.processPlan14PaperExits(quote, { nowMs })).length, 1);
  assert.equal(order.exitTrigger, 'net-loss-risk');
  assert.equal(order.exitPolicyVersion, PLAN14_PREVIOUS_VERSION);
  assert.ok(order.pnl < -2.5, 'trigger is not a guaranteed 25% exit price');
  assert.equal(order.plan14ExitObservations.length, 1);
  assert.equal(order.plan14FirstStopObservation.bid, 0.50);
  assert.equal(order.plan14FirstStopObservation.executableNetPnl, order.pnl);
  const cash = bucket.portfolio.cash, pnl = order.pnl;
  assert.equal((await service.processPlan14PaperExits(quote, { nowMs })).length, 0);
  await service.backfillEarlyExitOutcomes(async () => ({ actualDirection: 'down',
    officialOutcome: 'Down', outcomePrices: [0, 1], priceSource: 'polymarket-official'
  }), { now: new Date('2099-01-10T00:06:00Z') });
  assert.equal(order.counterfactualHoldPnl, 2.33);
  assert.equal(bucket.portfolio.cash, cash);
  assert.equal(order.pnl, pnl);
  assert.equal(summarizePaperOrderForApi(order).exitTrigger, 'net-loss-risk');
});

test('v4 trace records holds/resets, bounds size, preserves first trigger and counts fetch failures', async () => {
  const service = new PolymarketTradingService({ config: {} });
  service.persist = async () => {};
  const order = { id: 'trace-test', planId: 'plan14', strategyVersion: PLAN14_VERSION,
    direction: 'up', timeframe: '5m', slotIso: SLOT_ISO, targetTimeIso: TARGET_ISO,
    settlementStatus: 'open', limitPrice: 0.5, usd: 10, shares: 20 };
  service.getBucket('plan14').paperOrders = [order];
  const base = NOW.getTime();
  await service.processPlan14PaperExits(async () => ({ bid: 0.45, ask: 0.47,
    spot: 99.9, open: 100, volatility: 0.001, quoteTimeMs: base, bookTimeMs: base }), { nowMs: base });
  assert.equal(order.settlementStatus, 'open', 'ordinary model stop still waits');
  assert.equal(order.plan14FirstStopObservation.bid, 0.45);
  for (let i = 1; i <= 260; i++) {
    await service.processPlan14PaperExits(async () => ({ bid: 0.6, ask: 0.62,
      bookTimeMs: base + i }), { nowMs: base + i });
  }
  assert.equal(order.plan14StopConfirmation, null);
  assert.equal(order.plan14ExitObservations.length, 256);
  assert.equal(order.plan14ExitObservationsDropped, 5);
  assert.equal(order.plan14FirstStopObservation.bid, 0.45);
  await service.processPlan14PaperExits(async () => { throw new Error('offline'); }, { nowMs: base + 300 });
  assert.equal(order.plan14ExitObservationErrors, 1);
  assert.equal(order.settlementStatus, 'open');
});

test('v5 probability is symmetric, bounded by inputs, and does not amplify agreement', () => {
  for (const marketUp of [0.1, 0.3, 0.5, 0.8, 0.9]) {
    for (const spotUp of [0.1, 0.3, 0.5, 0.8, 0.9]) {
      const p = blendPlan14Up({ marketUp, spotUp });
      assert.ok(p >= Math.min(marketUp, spotUp) - 1e-9 && p <= Math.max(marketUp, spotUp) + 1e-9);
      assert.ok(Math.abs(p + blendPlan14Up({ marketUp: 1 - marketUp, spotUp: 1 - spotUp }) - 1) < 1e-9);
    }
  }
});

test('v11 refuses a new sub-40c entry; v9 still buys that side when the model and fee clear', () => {
  const decision = evaluatePlan14Entry({ signal: signal({ spot: 100.1 }), sentiment: sentiment(0.15),
    book: book(0.15), now: NOW });
  assert.equal(decision.allowed, false, decision.reason);
  assert.equal(decision.skipReason, 'model_not_above_mid');
  const v9 = evaluatePlan14Entry({ signal: signal({ spot: 100.1 }), sentiment: sentiment(0.15),
    book: book(0.15), now: NOW, policyVersion: PLAN14_V9_VERSION });
  assert.equal(v9.allowed, true, v9.reason);
  assert.equal(v9.selected.direction, 'up');
  assert.equal(v9.selected.ask, 0.16);
  assert.ok(v9.selected.edge >= 0.01);
  assert.ok(v9.selected.modelOverMid >= 0.01);
  const againstSpot = evaluatePlan14Entry({
    signal: signal({ spot: 100 }),
    sentiment: sentiment(0.75),
    book: {
      up: { bid: 0.74, ask: 0.76, bookTimeMs: NOW.getTime() },
      down: { bid: 0.24, ask: 0.26, bookTimeMs: NOW.getTime() }
    },
    now: NOW
  });
  assert.equal(againstSpot.allowed, false, againstSpot.reason);
  assert.equal(againstSpot.skipReason, 'spot_disagrees');
  const c = v9.selected;
  const expectedNetSharesPerDollar = (1 - 0.07 * (1 - c.ask)) / c.ask;
  assert.ok(Math.abs(c.expectedRoi - (c.p * expectedNetSharesPerDollar - 1)) < 0.001);
  assert.equal(computePlan14OrderUsd({ cash: 500, candidate: { cost: 0.53, p: 0.52, ask: 0.51 } }), 0);
  const stale = book(); stale.up.bookTimeMs -= 11000;
  assert.equal(evaluatePlan14Entry({ signal: signal(), sentiment: sentiment(), book: stale, now: NOW }).skipReason, 'stale_book');
});

test('v6 does not buy a cheap ask when the adjusted probability is still below the midpoint', () => {
  const decision = evaluatePlan14Entry({
    signal: signal({ spot: 100 }),
    sentiment: sentiment(0.6),
    book: {
      up: { bid: 0.50, ask: 0.52, bookTimeMs: NOW.getTime() },
      down: { bid: 0.40, ask: 0.42, bookTimeMs: NOW.getTime() }
    },
    now: NOW
  });
  assert.equal(decision.allowed, false, decision.reason);
  assert.equal(decision.skipReason, 'model_not_above_mid');
  assert.ok(decision.selected.edge > 0, 'the ask is cheap enough that fee-adjusted edge alone would buy');
  assert.ok(decision.selected.modelOverMid < 0.01);
});

test('v6 skill line compares settled model error with the midpoint', () => {
  const plan = buildPolymarketPaperPlan14({
    signal: signal(),
    sentiment: sentiment(),
    plan14Book: book(),
    portfolio: { portfolioInitialized: true, cash: 500 },
    plan14Orders: [{
      strategyVersion: PLAN14_VERSION,
      actualDirection: 'up',
      expectedValueGate: { marketUp: 0.4, blendedUp: 0.7 }
    }],
    now: NOW
  });
  assert.match(plan.decision.reason, /修正概率误差 0.090/);
  assert.match(plan.decision.reason, /中间价误差 0.360/);
  assert.match(plan.decision.reason, /修正更准/);
});

test('v8 retains its cheap stop while higher-priced v9 rules remain unchanged', () => {
  const nowMs = NOW.getTime();
  const cheap = { strategyVersion: PLAN14_V8_VERSION, direction: 'up', timeframe: '5m', targetTimeIso: TARGET_ISO,
    limitPrice: 0.22, usd: 2, shares: 9 };
  const inputs = { bid: 0.12, ask: 0.14, spot: 99.9, open: 100, volatility: 0.001,
    quoteTimeMs: nowMs, bookTimeMs: nowMs };
  const stopped = evaluatePlan14Exit({ order: cheap, inputs, nowMs });
  assert.equal(stopped.exit, true);
  assert.equal(stopped.exitTrigger, 'cheap-side-risk');
  assert.equal(stopped.emergency, true);
  const mid = { ...cheap, limitPrice: 0.72, usd: 10, shares: 12.3 };
  assert.equal(evaluatePlan14Exit({ order: mid, inputs: { ...inputs, bid: 0.5, ask: 0.52, spot: 100.1 }, nowMs }).exit, false);
  const favorite = { strategyVersion: PLAN14_VERSION, direction: 'up', timeframe: '5m', targetTimeIso: TARGET_ISO,
    limitPrice: 0.85, usd: 7.72, shares: 8.987 };
  const stoppedFavorite = evaluatePlan14Exit({
    order: favorite,
    inputs: { bid: 0.66, ask: 0.67, spot: 100.2, open: 100, volatility: 0.001, quoteTimeMs: nowMs, bookTimeMs: nowMs },
    nowMs
  });
  assert.equal(stoppedFavorite.exit, true);
  assert.equal(stoppedFavorite.exitTrigger, 'high-price-risk');
  assert.equal(stoppedFavorite.emergency, true);
  const recovered = { ...favorite, limitPrice: 0.88, usd: 8.47, shares: 9.548 };
  assert.equal(evaluatePlan14Exit({
    order: recovered,
    inputs: { bid: 0.69, ask: 0.70, spot: 100.05, open: 100, volatility: 0.001, quoteTimeMs: nowMs, bookTimeMs: nowMs },
    nowMs
  }).exit, false);
});

test('v9 entry selection stays equal to v8; v11 only drops new sub-40c buys', () => {
  for (const market of [0.15, 0.4, 0.5, 0.6, 0.85]) {
    for (const spot of [99.9, 100, 100.1]) {
      const args = { signal: signal({ spot }), sentiment: sentiment(market), book: book(market), now: NOW };
      const old = evaluatePlan14Entry({ ...args, policyVersion: PLAN14_V8_VERSION });
      const v9 = evaluatePlan14Entry({ ...args, policyVersion: PLAN14_V9_VERSION });
      assert.deepEqual({ ...v9, model: { ...v9.model, policyVersion: PLAN14_V8_VERSION } }, old);
      const v11 = evaluatePlan14Entry(args);
      if (v9.allowed && v9.selected.ask < 0.40) {
        assert.equal(v11.allowed, false);
        assert.equal(v11.skipReason, 'model_not_above_mid');
      } else {
        assert.equal(v11.allowed, v9.allowed);
        assert.equal(v11.skipReason ?? null, v9.skipReason ?? null);
      }
    }
  }
});

test('v5 ranks expected dollars rather than confidence or absolute edge', () => {
  const view = (symbol, expectedProfitUsd, edge) => ({ symbol, view: { plan: { action: { shouldTrade: true, expectedProfitUsd, edge } } } });
  assert.equal(rankPlan14Views([view('BTC', 0.5, 0.09), view('ETH', 1.5, 0.05)])[0].symbol, 'ETH');
});

test('v5 permits multiple same-direction symbols, but not repeat entries or oversized trades', async () => {
  const service = new PolymarketTradingService({ config: { paperLiveParityEnabled: false } });
  service.persist = async () => {};
  await service.configurePortfolio({ planId: 'plan14', cash: 500 });
  const input = symbol => ({ symbol, direction: 'up', usd: 10,
    sentiment: { ...sentiment(), symbol, schedule: { currentSlotIso: SLOT_ISO } },
    plan: { timeframe: '5m', slotIso: SLOT_ISO, targetTimeIso: TARGET_ISO,
      action: { shouldTrade: true, direction: 'up', limitPrice: 0.5 } } });
  for (const symbol of ['BTC-USD', 'ETH-USD', 'SOL-USD']) await service.createPaperOrder(input(symbol), 'plan14');
  assert.equal(service.getBucket('plan14').paperOrders.length, 3);
  await assert.rejects(service.createPaperOrder({ ...input('BTC-USD'), allowFlipReentry: true }, 'plan14'), /本窗口/);
  await assert.rejects(service.createPaperOrder({ ...input('XRP-USD'), usd: 40 }, 'plan14'), /单笔现金比例上限/);
});

test('v5 holds a large losing position when hold value is higher; old v4 still risk-exits', () => {
  const nowMs = NOW.getTime();
  const order = { strategyVersion: PLAN14_VERSION, direction: 'up', timeframe: '5m', targetTimeIso: TARGET_ISO,
    limitPrice: 0.72, usd: 10, shares: 12.3 };
  const inputs = { bid: 0.5, ask: 0.52, spot: 100.1, open: 100, volatility: 0.001,
    quoteTimeMs: nowMs, bookTimeMs: nowMs };
  assert.equal(evaluatePlan14Exit({ order, inputs, nowMs }).exit, false);
  assert.equal(evaluatePlan14Exit({ order: { ...order, strategyVersion: PLAN14_PREVIOUS_VERSION }, inputs, nowMs }).emergency, true);
  assert.equal(evaluatePlan14Exit({ order, inputs: { ...inputs, spot: null }, nowMs }).exit, false);
});

test('v5 value exits need two distinct fresh spot AND book observations, not ten seconds', () => {
  const order = { strategyVersion: PLAN14_VERSION, timeframe: '5m' };
  const decision = { exit: true, exitStatus: 'model-take-profit' };
  const base = NOW.getTime();
  function tick(t, quote = t, book = t, d = decision) {
    const r = confirmPlan14Stop(order, d, { quoteTimeMs: base + quote, bookTimeMs: base + book }, base + t);
    order.plan14StopConfirmation = r.state; return r;
  }
  assert.equal(tick(0).confirmed, false);
  assert.equal(tick(1000, 0).confirmed, false);
  assert.equal(tick(2000, 2000, 0).confirmed, false);
  assert.equal(tick(3000).confirmed, true);
  assert.equal(tick(4000, 4000, 4000, { exit: false }).state, null);
  assert.equal(tick(5000).confirmed, false);
  assert.equal(tick(21000).state.count, 1, 'long gap resets');
  assert.equal(tick(22000, 0).state, null, 'stale spot cannot confirm');
});

test('same-quote forecast log keeps rejected opportunities without creating trades or changing cash', async () => {
  const service = new PolymarketTradingService({ config: {} }); service.persist = async () => {};
  const bucket = service.getBucket('plan14'); bucket.portfolio.cash = 500;
  const plan = buildPolymarketPaperPlan14({ signal: signal(), sentiment: sentiment(),
    plan14Book: book(), portfolio: { portfolioInitialized: true, cash: 500 }, now: NOW });
  assert.equal(plan.comparison.model.policyVersion, PLAN14_PREVIOUS_VERSION);
  await service.recordPlan14Opportunity(plan, { marketSlug: 'test' });
  await service.recordPlan14Opportunity(plan, { marketSlug: 'test' });
  assert.equal(bucket.plan14OpportunityLog.length, 1);
  assert.equal(bucket.plan14OpportunityLog[0].marketSlug, 'test');
  assert.equal(bucket.paperOrders.length, 0);
  assert.equal(bucket.portfolio.cash, 500);
});

test('v5 final entry recheck rejects a candidate that aged while other symbols were scanned', async () => {
  const service = new PolymarketTradingService({ config: { paperLiveParityEnabled: false } });
  service.persist = async () => {};
  await service.configurePortfolio({ planId: 'plan14', cash: 500 });
  const expired = Date.now() - 20000;
  const input = { symbol: 'BTC-USD', direction: 'up', usd: 10,
    sentiment: { ...sentiment(), schedule: { currentSlotIso: SLOT_ISO } },
    plan: { timeframe: '5m', slotIso: SLOT_ISO, targetTimeIso: TARGET_ISO,
      action: { shouldTrade: true, direction: 'up', limitPrice: 0.5,
        expectedValueGate: { policyVersion: PLAN14_VERSION, inputs: { quoteTimeMs: expired },
          bookTimeMs: { up: expired, down: expired } } } } };
  await assert.rejects(service.createPaperOrder(input, 'plan14'), /报价已过期/);
  assert.equal(service.getBucket('plan14').paperOrders.length, 0);
  assert.equal(service.getBucket('plan14').portfolio.cash, 500);
});
