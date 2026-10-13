import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import { getConfig } from '../src/config.js';

async function withService(config, run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'plan15-caps-'));
  try {
    const service = new PolymarketTradingService({ config, stateDir });
    await service.configurePortfolio({ cash: 500, planId: 'plan15' });
    await run(service);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}
const order = (marketSlug, usd = 450) => ({ marketSlug, usd, ask: 0.5, outcome: 'Yes' });

test('Plan15 caps each order at 5% and all open exposure at 30% of bankroll', async () => {
  await withService({}, async (service) => {
    for (let i = 0; i < 6; i += 1) {
      const filled = await service.createPlan15PaperOrder(order(`market-${i}`));
      assert.equal(filled.usd, 25);
    }
    assert.equal(service.getBucket('plan15').portfolio.cash, 350);
    await assert.rejects(service.createPlan15PaperOrder(order('over-cap')), /敞口上限/);
    const settled = service.getBucket('plan15').paperOrders[0];
    settled.settlementStatus = 'settled';
    assert.equal((await service.createPlan15PaperOrder(order('after-settlement'))).usd, 25);
  });
});

test('Plan15 honors env caps, clips remaining capacity to cents, and does not overshoot', async () => {
  const keys = ['POLYMARKET_PLAN15_MAX_TRADE_BANKROLL_PCT', 'POLYMARKET_PLAN15_MAX_OPEN_EXPOSURE_BANKROLL_PCT'];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env[keys[0]] = '0.02';
    process.env[keys[1]] = '0.025';
    const config = getConfig().polymarket;
    assert.equal(config.plan15MaxTradeBankrollPct, 0.02);
    assert.equal(config.plan15MaxOpenExposureBankrollPct, 0.025);
    await withService(config, async (service) => {
      assert.equal((await service.createPlan15PaperOrder(order('first'))).usd, 10);
      assert.equal((await service.createPlan15PaperOrder(order('second'))).usd, 2.5);
      await assert.rejects(service.createPlan15PaperOrder(order('third')), /敞口上限/);
    });
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});

test('Plan15 invalid caps retain safe defaults; zero caps block orders', async () => {
  await withService({ plan15MaxTradeBankrollPct: NaN, plan15MaxOpenExposureBankrollPct: 2 }, async (service) => {
    assert.equal((await service.createPlan15PaperOrder(order('invalid-config'))).usd, 25);
  });
  await withService({ plan15MaxTradeBankrollPct: 0 }, async (service) => {
    await assert.rejects(service.createPlan15PaperOrder(order('disabled')), /敞口上限/);
  });
});
