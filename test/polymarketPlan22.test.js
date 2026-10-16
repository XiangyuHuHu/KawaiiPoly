import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntervalSignal } from '../src/intervalSignal.js';
import {
  applyPaperPlanDisableList,
  PAPER_DISABLE_PLAN_IDS,
  getConfig
} from '../src/config.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import {
  PLAN22_PHASE_TECH_WEIGHTS,
  PLAN22_VERSION,
  backtestPlan22,
  evaluatePlan22,
  plan22InputsFromSignal,
  plan22SmokeRows
} from '../src/polymarketPlan22.js';

const start = Date.parse('2026-10-16T02:00:00Z');
const end = start + 900_000;

function edgeInput(overrides = {}) {
  return {
    startMs: start,
    endMs: end,
    nowMs: start + 8 * 60_000,
    spot: 100.12,
    slotOpen: 100,
    spotQuoteMs: start + 8 * 60_000,
    techUp: 0.74,
    techDown: 0.26,
    previousMovePct: 0.001,
    upBook: { bestBid: 0.46, bestAsk: 0.48 },
    downBook: { bestBid: 0.52, bestAsk: 0.54 },
    marketSlug: 'btc-updown-15m-1',
    randomControl: true,
    ...overrides
  };
}

test('phase weights match the 15m composite monitor', () => {
  assert.deepEqual(PLAN22_PHASE_TECH_WEIGHTS, { phase1: 0.05, phase2: 0.35, phase3: 0.5 });
});

test('buys only a 15m lock with after-fee mispricing', () => {
  const hit = evaluatePlan22(edgeInput());
  assert.equal(hit.ok, true);
  assert.equal(hit.outcome, 'Up');
  assert.equal(hit.phase, 'phase2');
  assert.ok(hit.edgeAfterFee >= 0.02);
  assert.ok(hit.pHat > hit.mid);
  assert.equal(hit.control.hypothetical, true);
  assert.equal(evaluatePlan22(edgeInput({ nowMs: start + 60_000 })).reason, 'outside_phase');
  assert.equal(evaluatePlan22(edgeInput({ endMs: start + 300_000 })).reason, 'not_15m');
  assert.equal(evaluatePlan22(edgeInput({
    upBook: { bestBid: 0.68, bestAsk: 0.70 },
    downBook: { bestBid: 0.30, bestAsk: 0.32 }
  })).reason, 'edge_after_fee');
  assert.equal(evaluatePlan22(edgeInput({ upBook: { bestBid: 0.30, bestAsk: 0.48 } })).reason, 'wide_spread');
  assert.equal(evaluatePlan22(edgeInput({ spotQuoteMs: start })).reason, 'spot_age');
  assert.equal(evaluatePlan22(edgeInput({ spot: 99.8 })).reason, 'spot_disagrees');
});

test('smoke backtest is positive after fees and the random control is separate', () => {
  const report = backtestPlan22(plan22SmokeRows());
  assert.equal(report.trades, 30);
  assert.ok(report.pnl > 0);
  assert.equal(report.skipped.outside_phase, 1);
  assert.equal(report.skipped.edge_after_fee, 1);
  assert.equal(report.skipped.wide_spread, 1);
  assert.equal(report.skipped.spot_age, 1);
  assert.equal(report.skipped.spot_disagrees, 1);
  assert.equal(report.control.trades, 30);
  assert.ok(report.control.pnl < report.pnl);
});

test('Binance 15m candles feed the same entry gate', () => {
  const slot = start;
  const candles = [];
  let price = 100;
  for (let index = 40; index >= 1; index -= 1) {
    const open = price;
    price *= 1.002;
    candles.push({
      time: Math.floor((slot - index * 900_000) / 1000),
      open,
      high: price,
      low: open,
      close: price,
      volume: 1
    });
  }
  const spot = price * 1.002;
  const signal = buildIntervalSignal({
    symbol: 'BTC-USD',
    candles,
    currentPrice: spot,
    currentQuoteTime: new Date(slot + 8 * 60_000).toISOString(),
    now: new Date(slot + 8 * 60_000)
  });
  const inputs = plan22InputsFromSignal(signal, slot + 8 * 60_000);
  assert.ok(inputs);
  assert.equal(inputs.spot > inputs.slotOpen, true);
  const decision = evaluatePlan22({
    ...edgeInput(),
    ...inputs,
    nowMs: slot + 8 * 60_000,
    spotQuoteMs: slot + 8 * 60_000
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.direction, 'up');
});

test('Plan22 paper ledger is independent and live stays blocked', async () => {
  const config = getConfig().polymarket;
  assert.equal(config.plan22Enabled, false);
  assert.equal(config.plan22NewEntriesEnabled, false);
  assert.notEqual(config.liveTradingEnabled, true);
  const s = new PolymarketTradingService({
    config: { ...config, plan22Enabled: true, paperTakerFeeEnabled: true, paperTakerFeeRate: 0.07, liveTradingEnabled: true }
  });
  s.persist = async () => {};
  s.getBucket('plan22').portfolio = { startingCash: 500, cash: 500, portfolioInitialized: true };
  const decision = evaluatePlan22(edgeInput());
  const order = await s.createPlan22PaperOrder({
    symbol: 'BTC',
    outcome: decision.outcome,
    ask: decision.ask,
    usd: 5,
    marketSlug: 'btc-updown-15m-1',
    tokenId: 't',
    title: 'Bitcoin Up or Down',
    endDate: new Date(end).toISOString(),
    phase: decision.phase,
    elapsedPct: decision.elapsedPct,
    pHat: decision.pHat,
    edgeAfterFee: decision.edgeAfterFee,
    control: decision.control
  });
  assert.equal(order.planId, 'plan22');
  assert.equal(order.strategyVersion, PLAN22_VERSION);
  assert.equal(order.timeframe, '15m');
  assert.equal(order.mode, 'paper');
  assert.equal(order.plan22Entry.phase, 'phase2');
  assert.equal(s.getBucket('plan22').paperOrders.length, 1);
  assert.equal(s.getBucket('plan21').paperOrders.length, 0);
  assert.ok(s.getBucket('plan22').portfolio.cash < 500);
  assert.equal(s.getBucket('plan22').portfolio.startingCash, 500);
  assert.equal(await s.createPlan22PaperOrder({
    symbol: 'BTC', outcome: 'Up', ask: 0.48, usd: 5, marketSlug: 'btc-updown-15m-1'
  }), null);
  await assert.rejects(() => s.setLiveAutoPlan('plan22', true), /禁止实盘/);
  await assert.rejects(() => s.createLiveOrder({ planId: 'plan22' }), /禁止实盘/);
  await assert.rejects(() => s.createPaperOrder({ direction: 'up', usd: 5 }, 'plan22'), /15 分钟扫描/);
  const past = new Date(Date.now() - 60_000).toISOString();
  order.targetTimeIso = past;
  const settled = await s.settleOpenOrders('plan22', async () => ({
    officialOutcome: 'Up',
    priceSource: 'polymarket-official'
  }));
  assert.equal(settled.length, 1);
  assert.equal(settled[0].won, true);
  assert.equal(settled[0].exitStatus, 'expiry');
  assert.equal(settled[0].plan22Control.hypothetical, true);
  assert.ok(Number.isFinite(settled[0].plan22Control.pnl));
  assert.ok(s.getBucket('plan22').portfolio.cash > 500 - 5);
});

test('disable list stops 17/18/19/20 flags without touching other plans', () => {
  assert.deepEqual([...PAPER_DISABLE_PLAN_IDS], ['plan17', 'plan18', 'plan19', 'plan20']);
  const next = applyPaperPlanDisableList({
    plan17Enabled: true,
    plan17NewEntriesEnabled: true,
    plan18Enabled: true,
    plan18NewEntriesEnabled: true,
    plan19Enabled: true,
    plan20Enabled: true,
    plan20NewEntriesEnabled: true,
    plan21Enabled: true,
    plan21NewEntriesEnabled: true,
    plan22Enabled: true
  }, ['plan17', 'plan18', 'plan19', 'plan20', 'plan22']);
  assert.equal(next.plan17Enabled, false);
  assert.equal(next.plan17NewEntriesEnabled, false);
  assert.equal(next.plan18Enabled, false);
  assert.equal(next.plan19Enabled, false);
  assert.equal(next.plan20Enabled, false);
  assert.equal(next.plan20NewEntriesEnabled, false);
  assert.equal(next.plan21Enabled, true);
  assert.equal(next.plan22Enabled, true);
});
