import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PLAN14_V9_VERSION, PLAN14_V8_VERSION, PLAN14_V7_VERSION, evaluatePlan14Exit,
  buildPlan14RulesSnapshot } from '../src/polymarketPlan14.js';
import { observePlan14ExitControl, summarizePlan14ExitControl } from '../src/plan14ExitControl.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

const targetMs = Date.now() - 120000;
const slotMs = targetMs - 300000;
const nowMs = slotMs + 150000;
const order = (more = {}) => ({ id: 'control-test', symbol: 'BTC-USD', planId: 'plan14',
  strategyVersion: PLAN14_V9_VERSION, direction: 'up', timeframe: '5m',
  slotIso: new Date(slotMs).toISOString(), targetTimeIso: new Date(targetMs).toISOString(),
  settlementStatus: 'open', limitPrice: 0.22, usd: 2, shares: 9, ...more });
const quote = (time = nowMs, more = {}) => ({ bid: 0.12, ask: 0.14,
  bookTimeMs: time, quoteTimeMs: time, spot: 99.9, open: 100, volatility: 0.001, ...more });
const service = () => {
  const s = new PolymarketTradingService({ config: { paperTakerFeeEnabled: true, paperTakerFeeRate: 0.07 } });
  s.persist = async () => {};
  s.getBucket('plan14').portfolio.cash = 498;
  return s;
};

test('v9 cheap entries hold through both a crash and a profitable rally, in either direction', () => {
  for (const direction of ['up', 'down']) {
    for (const inputs of [quote(), quote(nowMs, { bid: 0.01, ask: 0.02 }),
      quote(nowMs, { bid: 0.9, ask: 0.91 }), {}, { bid: null }]) {
      const d = evaluatePlan14Exit({ order: order({ direction }), inputs, nowMs });
      assert.equal(d.exit, false);
      assert.equal(d.reason, 'cheap_hold_to_settlement');
    }
  }
  assert.equal(evaluatePlan14Exit({ order: order({ limitPrice: 0.40 }), inputs: quote(), nowMs }).reason,
    undefined, '40c is not included in the cheap-hold band');
  assert.equal(buildPlan14RulesSnapshot().cheapEntryHoldBelow, 0.40);
});

test('older v7/v8 orders keep their original stops, with no silent migration', () => {
  for (const version of [PLAN14_V7_VERSION, PLAN14_V8_VERSION]) {
    const o = order({ strategyVersion: version });
    assert.equal(evaluatePlan14Exit({ order: o, inputs: quote(), nowMs }).exitTrigger, 'cheap-side-risk');
    assert.equal(observePlan14ExitControl(o, quote(), nowMs), null);
    assert.equal(o.plan14ExitControl, undefined);
  }
});

test('same-entry control exits once without changing the account or actual order', async () => {
  const s = service(), o = order(); s.getBucket('plan14').paperOrders = [o];
  assert.equal((await s.processPlan14PaperExits(async () => quote(), { nowMs })).length, 0);
  assert.equal(o.settlementStatus, 'open');
  assert.equal(o.pnl, undefined);
  assert.equal(s.getBucket('plan14').portfolio.cash, 498);
  const c = structuredClone(o.plan14ExitControl);
  assert.equal(c.status, 'exited');
  assert.equal(c.exitTrigger, 'cheap-side-risk');
  assert.ok(c.pnl < 0);
  await s.processPlan14PaperExits(async () => quote(nowMs + 3000, { bid: 0.9, ask: 0.91 }), { nowMs: nowMs + 3000 });
  assert.deepEqual(o.plan14ExitControl, c);
  assert.equal(o.plan14ExitObservations.length, 2);
  assert.equal(s.getBucket('plan14').portfolio.cash, 498);
  assert.equal(summarizePlan14ExitControl([o]).matched, 0);
});

test('cheap winner settles at official payout; the comparison does not credit extra cash', async () => {
  const s = service(), o = order(); s.getBucket('plan14').paperOrders = [o];
  await s.processPlan14PaperExits(async () => quote(), { nowMs });
  await s.settleOpenOrders('plan14', async () => ({ actualDirection: 'up', priceSource: 'polymarket-official' }));
  assert.equal(o.pnl, 7);
  assert.equal(o.exitStatus, 'expiry');
  assert.equal(s.getBucket('plan14').portfolio.cash, 507);
  const c = summarizePlan14ExitControl([o]);
  assert.equal(c.matched, 1);
  assert.equal(c.actualPnl, 7);
  assert.ok(c.controlPnl < 0);
  assert.equal(c.invested, 2);
  assert.equal(s.getBucket('plan14').portfolio.cash, 507);
});

test('cheap loser really loses all its stake, even when the old stop would save money', async () => {
  const s = service(), o = order(); s.getBucket('plan14').paperOrders = [o];
  await s.processPlan14PaperExits(async () => quote(), { nowMs });
  await s.settleOpenOrders('plan14', async () => ({ actualDirection: 'down', priceSource: 'polymarket-official' }));
  assert.equal(o.pnl, -2);
  assert.equal(s.getBucket('plan14').portfolio.cash, 498);
  assert.ok(summarizePlan14ExitControl([o]).delta < 0);
});

test('Plan14 never settles or credits cash from a non-official outcome', async () => {
  const s = service(), o = order(); s.getBucket('plan14').paperOrders = [o];
  const settled = await s.settleOpenOrders('plan14', async () => ({ actualDirection: 'up', priceSource: 'binance' }));
  assert.equal(settled.length, 0);
  assert.equal(o.settlementStatus, 'open');
  assert.equal(s.getBucket('plan14').portfolio.cash, 498);
});

test('non-cheap exit matches control, research continues afterwards without closing twice', async () => {
  const s = service(), o = order({ limitPrice: 0.5, usd: 10, shares: 19.3 });
  s.getBucket('plan14').paperOrders = [o];
  const q = t => quote(t, { bid: 0.8, ask: 0.82 });
  await s.processPlan14PaperExits(async () => q(nowMs), { nowMs });
  assert.equal(o.plan14ExitControl.status, 'open');
  const closed = await s.processPlan14PaperExits(async () => q(nowMs + 3000), { nowMs: nowMs + 3000 });
  assert.equal(closed.length, 1);
  assert.equal(o.plan14ExitControl.pnl, o.pnl);
  const cash = s.getBucket('plan14').portfolio.cash, pnl = o.pnl;
  await s.processPlan14PaperExits(async () => q(nowMs + 6000), { nowMs: nowMs + 6000 });
  assert.equal(o.plan14ExitObservations.length, 3);
  assert.equal(o.pnl, pnl);
  assert.equal(s.getBucket('plan14').portfolio.cash, cash);
  assert.equal(summarizePlan14ExitControl([o]).delta, 0);
  let fetched = false;
  await s.processPlan14PaperExits(async () => { fetched = true; return q(targetMs); }, { nowMs: targetMs });
  assert.equal(fetched, false, 'expiry belongs to official settlement');
});

test('stale books and cached quotes cannot advance or trigger the old-rule control', () => {
  const o = order();
  observePlan14ExitControl(o, quote(nowMs - 11000), nowMs);
  assert.equal(o.plan14ExitControl.status, 'open');
  const mid = order({ limitPrice: 0.5, usd: 10, shares: 19.3 });
  const inputs = quote(nowMs, { bid: 0.8, ask: 0.82 });
  observePlan14ExitControl(mid, inputs, nowMs);
  observePlan14ExitControl(mid, inputs, nowMs + 1000);
  assert.equal(mid.plan14ExitControl.status, 'open');
  observePlan14ExitControl(mid, quote(nowMs + 3000, { bid: 0.8, ask: 0.82 }), nowMs + 3000);
  assert.equal(mid.plan14ExitControl.status, 'exited');
});

test('comparison does not substitute a spot outcome for an official unresolved hold', () => {
  const o = order({ settlementStatus: 'settled', actualDirection: 'up', pnl: 7,
    settlementPriceSource: 'binance', plan14ExitControl: { status: 'open', version: PLAN14_V8_VERSION } });
  assert.equal(summarizePlan14ExitControl([o]).matched, 0);
  o.settlementPriceSource = 'polymarket-official';
  assert.equal(summarizePlan14ExitControl([o]).controlPnl, 7);
});

test('daily append-only archive persists concurrent rows independently of bounded state logs', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'plan14-research-test-'));
  try {
    const s = new PolymarketTradingService({ config: {}, stateDir: folder });
    s.persist = async () => {};
    const observedAtIso = new Date(nowMs).toISOString();
    await Promise.all(Array.from({ length: 12 }, (_, i) => s.archivePlan14Research('exits', { observedAtIso, orderId: i })));
    const file = join(folder, 'plan14-research', `${observedAtIso.slice(0, 10)}-exits.jsonl`);
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.orderId), Array.from({ length: 12 }, (_, i) => i));
    assert.equal(s.plan14ResearchQueues.size, 0);
  } finally {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    await rm(folder, { recursive: true });
  }
});
