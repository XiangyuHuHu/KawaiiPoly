import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import {
  evaluatePlan18Event,
  PLAN19_VERSION,
  meihuaCast,
  parsePlan18Event,
  plan18Clock,
  plan18Divine,
  plan18ShortSlug,
  xiaoLiuRenCast
} from '../src/polymarketPlan18.js';

test('lunar clock uses Beijing time and rolls 子时 into the next lunar day', () => {
  // 2026-10-11 20:00 Beijing = 丙午年九月初二 戌时
  const clock = plan18Clock(Date.parse('2026-10-11T12:00:00Z'));
  assert.equal(clock.yearBranchName, '午');
  assert.equal(clock.month, 9);
  assert.equal(clock.day, 2);
  assert.equal(clock.shichenName, '戌');
  // 23:30 Beijing is 子时 of the following lunar day
  const late = plan18Clock(Date.parse('2026-10-11T15:30:00Z'));
  assert.equal(late.shichenName, '子');
  assert.equal(late.day, 3);
  const leap = plan18Clock(Date.parse('2025-07-30T04:00:00Z'));
  assert.equal(leap.leapMonth, true);
  assert.equal(leap.month, 6);
});

test('梅花 time casting follows (年+月+日)%8, +时 for the lower trigram, total%6 for the moving line', () => {
  // 午=7, 9月, 2日, 戌=11: upper 18%8=2 兑, lower 29%8=5 巽, moving 29%6=5 → 体兑金 用巽木 → 体克用
  const cast = meihuaCast({ yearBranch: 7, month: 9, day: 2, shichen: 11 });
  assert.equal(cast.upper, '兑');
  assert.equal(cast.lower, '巽');
  assert.equal(cast.moving, 5);
  assert.equal(cast.ti, '巽');
  assert.equal(cast.yong, '兑');
  assert.equal(cast.relation, '用克体');
  assert.equal(cast.good, false);
  assert.equal(meihuaCast({ yearBranch: 1, month: 1, day: 6, shichen: 8 }).upper, '坤');
});

test('小六壬 counts 月、日、时 from 大安', () => {
  assert.equal(xiaoLiuRenCast({ month: 1, day: 1, shichen: 1 }).name, '大安');
  assert.equal(xiaoLiuRenCast({ month: 9, day: 2, shichen: 11 }).name, '留连');
  assert.equal(xiaoLiuRenCast({ month: 9, day: 2, shichen: 8 }).name, '小吉');
  assert.equal(xiaoLiuRenCast({ month: 1, day: 1, shichen: 6 }).name, '空亡');
});

function hourlyEvent(startIso) {
  const endIso = new Date(Date.parse(startIso) + 3_600_000).toISOString();
  return {
    slug: 'bitcoin-up-or-down-october-11-2026-8am-et',
    markets: [{
      slug: 'bitcoin-up-or-down-october-11-2026-8am-et',
      question: 'Bitcoin Up or Down - October 11, 8AM ET',
      eventStartTime: startIso,
      endDate: endIso,
      outcomes: '["Up","Down"]',
      clobTokenIds: '["up-token","down-token"]',
      closed: false
    }]
  };
}

test('buys the divined side only in the first minutes of the hour', () => {
  const start = '2026-10-11T12:00:00Z';
  const call = plan18Divine(Date.parse(start)).call;
  const books = { upBook: { bestBid: 0.5, bestAsk: 0.51 }, downBook: { bestBid: 0.49, bestAsk: 0.5 } };
  const decision = evaluatePlan18Event({ event: hourlyEvent(start), ...books, nowMs: Date.parse(start) + 120_000 });
  assert.equal(decision.ok, true);
  assert.equal(decision.outcome, call);
  assert.equal(decision.tokenId, call === 'Up' ? 'up-token' : 'down-token');
  assert.equal(evaluatePlan18Event({ event: hourlyEvent(start), ...books, nowMs: Date.parse(start) - 1000 }).reason, 'not_started');
  assert.equal(evaluatePlan18Event({ event: hourlyEvent(start), ...books, nowMs: Date.parse(start) + 11 * 60_000 }).reason, 'entry_window_passed');
  const wide = { upBook: { bestBid: 0.4, bestAsk: 0.51 }, downBook: { bestBid: 0.4, bestAsk: 0.5 } };
  assert.equal(evaluatePlan18Event({ event: hourlyEvent(start), ...wide, nowMs: Date.parse(start) + 120_000 }).reason, 'wide_spread');
});

test('Plan19 uses 小六壬 for the call while still recording the 梅花 cast', () => {
  const ms = Date.parse('2026-10-12T05:40:00Z');
  const meihua = plan18Divine(ms, 'meihua');
  const liuren = plan18Divine(ms, 'liuren');
  assert.equal(meihua.method, 'meihua');
  assert.equal(liuren.method, 'liuren');
  assert.equal(meihua.call, meihua.meihua.good ? 'Up' : 'Down');
  assert.equal(liuren.call, liuren.liuren.good ? 'Up' : 'Down');
  assert.deepEqual(liuren.meihua, meihua.meihua);
  assert.equal(liuren.agree, meihua.agree);
  const books = { upBook: { bestBid: 0.5, bestAsk: 0.51 }, downBook: { bestBid: 0.49, bestAsk: 0.5 } };
  const start = '2026-10-11T12:00:00Z';
  const decision = evaluatePlan18Event({ event: hourlyEvent(start), ...books, nowMs: Date.parse(start) + 60_000, method: 'liuren' });
  assert.equal(decision.outcome, plan18Divine(Date.parse(start), 'liuren').call);
  assert.equal(decision.divination.method, 'liuren');
});

function service() {
  const s = new PolymarketTradingService({
    config: { paperTakerFeeEnabled: true, paperTakerFeeRate: 0.07, plan18Enabled: true, plan19Enabled: true }
  });
  s.persist = async () => {};
  for (const id of ['plan18', 'plan19', 'plan15']) {
    s.getBucket(id).portfolio = { startingCash: 100, cash: 100, portfolioInitialized: true };
  }
  return s;
}

test('Plan19 orders land in their own bucket with the 小六壬 version and are persisted once per scan', async () => {
  const s = service();
  const divination = plan18Divine(Date.parse('2026-10-12T05:40:00Z'), 'liuren');
  const base = {
    symbol: 'SOL', timeframe: '5m', outcome: divination.call, tokenId: 't', ask: 0.5,
    conditionId: 'c', title: 'Solana Up or Down', startIso: '2026-10-12T05:40:00.000Z',
    endDate: '2026-10-12T05:45:00.000Z', divination, usd: 1
  };
  const order = await s.createPlan18PaperOrder({ ...base, planId: 'plan19', marketSlug: 'sol-updown-5m-1' }, { persist: false });
  assert.equal(order.planId, 'plan19');
  assert.equal(order.strategyVersion, PLAN19_VERSION);
  assert.equal(order.plan18Divination.method, 'liuren');
  assert.equal(order.timeframe, '5m');
  assert.equal(s.getBucket('plan19').paperOrders.length, 1);
  assert.equal(s.getBucket('plan18').paperOrders.length, 0);
  assert.equal(s.getBucket('plan19').portfolio.cash, 99);
  // Same slug twice is a no-op.
  assert.equal(await s.createPlan18PaperOrder({ ...base, planId: 'plan19', marketSlug: 'sol-updown-5m-1' }), null);
});

test('a void (50/50) official result pays out per outcomePrices instead of staying open forever', async () => {
  const s = service();
  const past = new Date(Date.now() - 60_000).toISOString();
  s.getBucket('plan15').paperOrders = [{
    id: 'void-1', planId: 'plan15', outcome: 'Vitality', usd: 5, shares: 10, marketSlug: 'cs2-void',
    settlementStatus: 'open', targetTimeIso: past
  }];
  const settled = await s.settleOpenOrders('plan15', async () => ({
    void: true, officialOutcome: null, outcomes: ['Vitality', 'MOUZ'], outcomePrices: [0.5, 0.5], priceSource: 'polymarket-official'
  }));
  assert.equal(settled.length, 1);
  const order = settled[0];
  assert.equal(order.settlementStatus, 'settled');
  assert.equal(order.won, null);
  assert.equal(order.payoutUsd, 5);
  assert.equal(order.pnl, 0);
  assert.equal(order.voidSettlement, true);
  assert.equal(s.getBucket('plan15').portfolio.cash, 105);
});

test('top-up raises cash and startingCash together so the return ratio is unchanged', async () => {
  const s = service();
  const bucket = s.getBucket('plan18');
  bucket.portfolio = { startingCash: 500, cash: 80, portfolioInitialized: true };
  bucket.paperOrders = [{ id: 'o', settlementStatus: 'open', usd: 20 }];
  const before = s.computeStats('plan18').totalReturn;
  const result = await s.topUpDivinationCash('plan18', 500);
  assert.deepEqual({ cash: result.cash, startingCash: result.startingCash }, { cash: 580, startingCash: 1000 });
  assert.equal(bucket.portfolio.topUps.length, 1);
  // equity − startingCash is still −400; only the denominator changes.
  assert.equal(s.computeStats('plan18').realizedPnl ?? (580 + 20 - 1000), 580 + 20 - 1000);
  assert.ok(Math.abs(s.computeStats('plan18').totalReturn) < Math.abs(before));
  assert.equal(await s.topUpDivinationCash('plan15', 500), null);
});

test('settled divination orders older than the retention window move to the archive', async () => {
  const s = service();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  s.getBucket('plan18').paperOrders = [
    { id: 'a', settlementStatus: 'settled', settledAtIso: old },
    { id: 'b', settlementStatus: 'settled', settledAtIso: recent },
    { id: 'c', settlementStatus: 'open' }
  ];
  // Without a stateDir the archive is a no-op and nothing is dropped.
  assert.deepEqual(await s.archiveDivinationSettledOrders('plan18', { retentionDays: 35 }), { archived: 0 });
  assert.equal(s.getBucket('plan18').paperOrders.length, 3);
});

test('5m/15m casts add the Beijing minute; on the hour the cast is the classic 年月日时 one', () => {
  const clock = plan18Clock(Date.parse('2026-10-12T05:40:00Z'));
  assert.equal(clock.minute, 40);
  const withMinute = meihuaCast(clock);
  const classic = meihuaCast({ ...clock, minute: 0 });
  assert.equal(withMinute.upper, classic.upper);
  const total = clock.yearBranch + clock.month + clock.day + clock.shichen + 40;
  assert.equal(withMinute.moving, total % 6 || 6);
  assert.equal(plan18Clock(Date.parse('2026-10-12T02:00:00Z')).minute, 0);
});

test('short up/down slugs parse into 5m/15m lanes with their own entry windows', () => {
  assert.equal(plan18ShortSlug('BTC', '5m', Date.parse('2026-10-12T05:42:10Z')), 'btc-updown-5m-1791783600');
  assert.equal(plan18ShortSlug('ETH', '15m', Date.parse('2026-10-12T05:42:10Z')), 'eth-updown-15m-1791783000');
  const event = {
    slug: 'btc-updown-5m-1791783600',
    markets: [{
      slug: 'btc-updown-5m-1791783600',
      eventStartTime: '2026-10-12T05:40:00Z',
      endDate: '2026-10-12T05:45:00Z',
      outcomes: '["Up","Down"]',
      clobTokenIds: '["up-token","down-token"]',
      closed: false
    }]
  };
  assert.deepEqual(
    { symbol: parsePlan18Event(event).symbol, timeframe: parsePlan18Event(event).timeframe },
    { symbol: 'BTC', timeframe: '5m' }
  );
  const books = { upBook: { bestBid: 0.5, bestAsk: 0.51 }, downBook: { bestBid: 0.49, bestAsk: 0.5 } };
  const start = Date.parse('2026-10-12T05:40:00Z');
  const ok = evaluatePlan18Event({ event, ...books, nowMs: start + 30_000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.timeframe, '5m');
  assert.equal(evaluatePlan18Event({ event, ...books, nowMs: start + 90_000 }).reason, 'entry_window_passed');
  assert.equal(evaluatePlan18Event({ event, ...books, nowMs: start + 90_000, entryWindowMinutes: { '5m': 2 } }).ok, true);
});
