import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolymarketClient } from '../src/polymarketClient.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

const resolved = { slug: 'market', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' };

test('settlement lookup distinguishes successful unresolved responses from API failures', async () => {
  for (const method of ['getNamedMarketOutcome', 'getResolvedMarketOutcome']) {
    const client = new PolymarketClient();
    client.request = async () => [];
    assert.equal(await client[method]('market'), null);
    for (const failedRequest of [0, 1, 2, 'all']) {
      let calls = 0;
      client.request = async () => {
        const call = calls++;
        if (failedRequest === 'all' || call === failedRequest) throw new Error('API unavailable');
        return [];
      };
      await assert.rejects(client[method]('market'), /API unavailable/);
      assert.equal(calls, 3);
    }
  }
});

test('official fallback outcome can settle despite another endpoint failing', async () => {
  const client = new PolymarketClient();
  client.request = async (url) => {
    if (url.endsWith('/markets')) throw new Error('markets unavailable');
    return [{ slug: 'market', markets: [resolved] }];
  };
  assert.equal((await client.getNamedMarketOutcome('market')).officialOutcome, 'Yes');
});

for (const planId of ['plan15', 'plan16', 'plan17']) {
  test(`${planId} persists wait duration and errors without releasing expired positions`, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'settlement-wait-'));
    try {
      const service = new PolymarketTradingService({ config: { plan16MaxOpen: 1 }, stateDir });
      await service.configurePortfolio({ cash: 100, planId });
      const input = { marketSlug: 'market', groupKey: 'group', usd: 5, ask: 0.5, outcome: 'Yes', endDate: new Date(Date.now() - 60_000).toISOString() };
      let order = await service[`create${planId[0].toUpperCase()}${planId.slice(1)}PaperOrder`](input);
      const cash = service.getBucket(planId).portfolio.cash;
      assert.deepEqual(await service.settleOpenOrders(planId, async () => { throw new Error('API unavailable'); }), []);
      order = service.getBucket(planId).paperOrders[0];
      assert.equal(order.lastSettlementError, 'API unavailable');
      assert.equal(order.settlementFetchFailures, 1);
      assert.ok(order.resolutionWaitMs >= 60_000);
      const firstPastEnd = order.firstPastEndAtIso;
      assert.ok(Number.isFinite(Date.parse(firstPastEnd)));
      await service.settleOpenOrders(planId, async () => null);
      order = service.getBucket(planId).paperOrders[0];
      assert.equal(order.lastSettlementError, null);
      assert.equal(order.settlementError, null);
      assert.equal(order.settlementFetchFailures, 1);
      assert.equal(order.firstPastEndAtIso, firstPastEnd);
      assert.equal(order.settlementStatus, 'open');
      assert.equal(service.getBucket(planId).portfolio.cash, cash);
      const persisted = JSON.parse(await readFile(service.planStatePaths[planId], 'utf8'));
      assert.equal(persisted.paperOrders[0].resolutionWaitMs, order.resolutionWaitMs);
      if (planId === 'plan16') {
        await assert.rejects(service.createPlan16PaperOrder({ ...input, marketSlug: 'second', groupKey: 'second' }), /未结算订单已满/);
      }
      const settled = await service.settleOpenOrders(planId, async () => ({ priceSource: 'polymarket-official', officialOutcome: 'Yes' }));
      assert.equal(settled.length, 1);
      assert.equal(order.settlementStatus, 'settled');
      assert.equal(service.getBucket(planId).portfolio.cash, Math.round((cash + order.shares) * 100) / 100);
      if (planId === 'plan16') assert.ok(await service.createPlan16PaperOrder({ ...input, marketSlug: 'second', groupKey: 'second' }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}
