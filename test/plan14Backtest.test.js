import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netShares, netSale, normalizedProbability, chronologicalSplit,
  portfolioReplay, replayExit, qualifies, clusterInterval } from '../src/plan14Backtest.js';

const order = (overrides = {}) => ({ id: 'first', symbol: 'BTC', entryMs: 100000,
  targetMs: 300000, releaseMs: 540000, ask: 0.5, feeRate: 0.07, wins: true, ...overrides });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('buy fees reduce redeemable shares and a round trip pays sell fees too', () => {
  close(netShares(10, 0.5), 19.3);
  close(netSale(19.3, 0.5), 9.31225);
  close(netShares(10, 0.5, 0), 20);
  assert.equal(portfolioReplay([order()]).pnl, 9.3);
});

test('normalized blend stays between its inputs and uses fee-inclusive entry cost', () => {
  close(normalizedProbability(0.8, 0.8), 0.8);
  assert.ok(normalizedProbability(0.3, 0.7) > 0.3);
  assert.ok(normalizedProbability(0.3, 0.7) < 0.7);
  assert.equal(qualifies({ ask: 0.5, marketUp: 0.52, spotUp: 0.52, direction: 'up', cost: 10 / 19.3 },
    { minPrice: 0.4, maxPrice: 0.65, minEdge: 0.01 }), false);
});

test('chronological split keeps all coins in the same target window together', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ['BTC', 'ETH'].map(symbol =>
    order({ id: `${i}-${symbol}`, symbol, targetMs: (i + 1) * 300000 }))).flat();
  const split = chronologicalSplit(rows);
  assert.equal(split.train.length, 12);
  assert.equal(split.validation.length, 4);
  assert.equal(split.test.length, 4);
  assert.ok(Math.max(...split.train.map(r => r.targetMs)) < Math.min(...split.validation.map(r => r.targetMs)));
  assert.ok(Math.max(...split.validation.map(r => r.targetMs)) < Math.min(...split.test.map(r => r.targetMs)));
});

test('cash cannot be borrowed or used before delayed redemption', () => {
  const rows = [order(), order({ id: 'eth', symbol: 'ETH', entryMs: 400000,
    targetMs: 600000, releaseMs: 840000 })];
  const result = portfolioReplay(rows, { startingCash: 10 });
  assert.equal(result.n, 1);
  assert.equal(result.cashOrPriceSkips, 1);
  assert.equal(result.endingCash, 19.3);
  const released = portfolioReplay([rows[0], { ...rows[1], entryMs: 540000 }], { startingCash: 10 });
  assert.equal(released.n, 2);
});

test('dynamic sizing sees only entry features, never outcome, and respects funded cash',()=>{
  let calls=0;
  const result=portfolioReplay([order({p:.55}),order({id:'eth',symbol:'ETH',wins:false,p:.55})],{
    startingCash:10,stake:input=>{calls++;assert.deepEqual(Object.keys(input),['cash','candidate']);
      assert.deepEqual(Object.keys(input.candidate),['ask','cost','p']);return 6;}});
  assert.equal(calls,2);assert.equal(result.n,1);assert.equal(result.cashOrPriceSkips,1);
  assert.equal(portfolioReplay([order()],{stake:()=>NaN}).n,0);
  assert.equal(portfolioReplay([order()],{stake:()=>-1}).n,0);
});

test('only one entry per coin/window but independent coins remain available', () => {
  const result = portfolioReplay([order(), order({ id: 'second', entryMs: 110000 }),
    order({ id: 'eth', symbol: 'ETH' })]);
  assert.equal(result.n, 2);
  assert.equal(result.pnl, 18.6);
});

test('drawdown settles simultaneous coins as a group and different releases in time order', () => {
  const winner = order({ id: 'a-win', ask: 0.4 });
  const loser = order({ id: 'b-loss', symbol: 'ETH', wins: false });
  assert.equal(portfolioReplay([winner, loser]).maxRealizedDrawdown, 0);
  // Winner then loser: final profit is positive but there is a $10 drawdown.
  const sequential = portfolioReplay([winner, { ...loser, releaseMs: 840000 }]);
  assert.equal(sequential.maxRealizedDrawdown, 10);
  assert.equal(portfolioReplay([order({ wins: false })]).maxRealizedDrawdown, 10);
});

test('invalid timing must fail loudly rather than generate free future cash', () => {
  assert.throws(() => portfolioReplay([order({ releaseMs: NaN })]), /Invalid replay/);
  assert.throws(() => portfolioReplay([order({ entryMs: 300000 })]), /Invalid replay/);
  assert.throws(() => portfolioReplay([order({ wins: null })]), /Invalid replay/);
});

test('alternate exits never invent quotes after an original early exit', () => {
  const row = { ...order(), usd: 10, shares: 19.3, holdPnl: 9.3, exitStatus: 'model-stop-loss',
    trace: [{ observedAtIso: new Date(200000).toISOString(), bid: 0.4, bookTimeMs: 200000 }] };
  const stop40 = replayExit(row, { stop: 0.4 });
  assert.equal(stop40.known, false);
  assert.equal(stop40.lower, -10);
  assert.equal(stop40.upper, 9.3);
  assert.equal(replayExit(row).pnl, 9.3);
  const stop20 = replayExit(row, { stop: 0.2 });
  assert.equal(stop20.known, true);
  close(stop20.pnl, netSale(19.3, 0.4) - 10);
});

test('stale, future, and pre-entry exit quotes cannot trigger a synthetic stop', () => {
  const quotes = [[200000, 180000], [200000, 210000], [90000, 90000]];
  for (const [observed, bookTimeMs] of quotes) {
    const row = { ...order(), usd: 10, shares: 19.3, holdPnl: 9.3,
      trace: [{ observedAtIso: new Date(observed).toISOString(), bookTimeMs, bid: 0.1 }] };
    assert.equal(replayExit(row, { stop: 0.2 }).known, false);
  }
});

test('window bootstrap counts correlated coins as one cluster', () => {
  assert.equal(clusterInterval([{ targetMs: 1, pnl: 5 }, { targetMs: 1, pnl: -5 }]), null);
  const interval = clusterInterval([{ targetMs: 1, pnl: 5 }, { targetMs: 1, pnl: 2 }, { targetMs: 2, pnl: 3 }]);
  assert.equal(interval.clusters, 2);
  assert.equal(interval.lower, 6);
  assert.equal(interval.upper, 14);
});
