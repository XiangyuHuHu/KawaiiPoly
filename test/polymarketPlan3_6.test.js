import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PLAN3_6_LANES, PLAN3_6_VERSION } from '../src/polymarketPlan3_6.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

function observationPlan(overrides = {}) {
  return {
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: '2020-01-01T10:00:00.000Z',
    targetTimeIso: '2020-01-01T10:15:00.000Z',
    action: { shouldTrade: true },
    observation: {
      candidate: true,
      key: '2020-01-01T10:00:00.000Z_BTC_15m_plan3_6_up',
      planId: 'plan3_6',
      strategyVersion: PLAN3_6_VERSION,
      symbol: 'BTC-USD',
      timeframe: '5m',
      slotIso: '2020-01-01T10:00:00.000Z',
      targetTimeIso: '2020-01-01T10:15:00.000Z',
      market: 'Bitcoin Up or Down',
      marketSlug: 'btc-updown-test',
      direction: 'down',
      tokenPrice: 0.86,
      rawBestAsk: 0.85,
      paperSlippageTicks: 1,
      experimentLane: PLAN3_6_LANES.PRIMARY,
      cheapDirection: 'up',
      cheapPrice: 0.18,
      marketOverround: 1.04,
      qualified: true,
      modelDirection: 'down',
      modelConfidence: 0.7,
      modelAligned: true,
      secondsRemaining: 120,
      ...overrides
    }
  };
}

test('Plan3.6 candidate observations settle officially and survive restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan36-forward-'));
  const statePath = join(root, 'state.json');
  const config = {
    defaultOrderUsd: 5,
    maxOrderUsd: 500,
    dailyMaxLossUsd: 50,
    plan3_6OrderUsd: 5,
    plan3_6ObservationLogMaxEntries: 10000
  };
  try {
    const service = new PolymarketTradingService({ config, statePath });
    const first = service.recordPlan36Observation(observationPlan());
    const repeated = service.recordPlan36Observation(observationPlan({
      tokenPrice: 0.90,
      experimentLane: PLAN3_6_LANES.REJECTED,
      secondsRemaining: 90
    }));
    assert.equal(first.id, repeated.id);
    assert.equal(service.getBucket('plan3_6').plan36ObservationLog.length, 1);
    assert.equal(repeated.tokenPrice, 0.86);
    assert.equal(repeated.experimentLane, PLAN3_6_LANES.PRIMARY);
    assert.equal(repeated.lastSeenSecondsRemaining, 90);

    await service.settleOpenOrders('plan3_6', async () => ({
      actualDirection: 'down',
      officialOutcome: 'Down',
      outcomePrices: ['0', '1'],
      priceSource: 'polymarket-official'
    }));
    const analytics = service.computePlan36Analytics();
    assert.equal(analytics.observations.settled, 1);
    assert.equal(analytics.byLane[PLAN3_6_LANES.PRIMARY].wins, 1);
    assert.equal(analytics.byLane[PLAN3_6_LANES.PRIMARY].pnl, 0.81);

    const restored = new PolymarketTradingService({ config, statePath });
    await restored.load();
    assert.equal(restored.computePlan36Analytics().observations.settled, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan3.6 live scheduling is removed when its live flag is disabled', () => {
  const service = new PolymarketTradingService({
    config: { plan3_5LiveEnabled: false, plan3_6LiveEnabled: false, plan5LiveEnabled: false }
  });
  assert.deepEqual(
    service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan1', 'plan3_5', 'plan3_6', 'plan5'] }),
    ['plan1']
  );
});

test('merged Plan3.5 live scheduling is controlled by Plan3', () => {
  const service = new PolymarketTradingService({
    config: {
      plan3LiveEnabled: true,
      plan3_5LiveEnabled: false,
      plan3MergePlan35History: true,
      plan5LiveEnabled: false
    }
  });
  assert.deepEqual(
    service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan3_5'] }),
    ['plan3']
  );
});

test('paper stats distinguish lifetime account pnl from retained order history', () => {
  const service = new PolymarketTradingService({ config: {} });
  const bucket = service.getBucket('plan3_6');
  bucket.portfolio = { startingCash: 500, cash: 600, portfolioInitialized: true };
  bucket.paperOrders = [{
    id: 'retained-order',
    symbol: 'BTC-USD',
    settlementStatus: 'settled',
    won: true,
    pnl: 10,
    usd: 5
  }];
  const stats = service.computeStats('plan3_6');
  assert.equal(stats.realizedPnl, 100);
  assert.equal(stats.lifetimeRealizedPnl, 100);
  assert.equal(stats.retainedRealizedPnl, 10);
});

test('Plan3.6 paper auto accepts 15m/1h/1d timeframes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan36-tf-'));
  const statePath = join(root, 'state.json');
  try {
    const service = new PolymarketTradingService({
      config: { defaultOrderUsd: 5, plan3_6LiveEnabled: false },
      statePath
    });
    service.getBucket('plan3_6').portfolio = {
      startingCash: 500,
      cash: 500,
      portfolioInitialized: true
    };
    const auto = await service.setAuto(true, {
      planId: 'plan3_6',
      timeframes: ['5m', '15m', '1h', '1d', 'hourly', 'daily']
    });
    assert.deepEqual(auto.timeframes, ['5m', '15m', '1h', '1d']);
    assert.equal(auto.enabled, true);
    assert.deepEqual(
      service.buildPlan36RulesSnapshot().paperTimeframes,
      ['5m', '15m', '1h', '1d']
    );
    assert.deepEqual(
      service.buildPlan36RulesSnapshot().liveTimeframes,
      ['5m']
    );
    assert.equal(service.buildPlan36RulesSnapshot().shadow15mLane.mode, 'paper_trade_live_observe_only');
    assert.equal(service.buildPlan36RulesSnapshot().liveEnabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan3.6 live flag allows setLiveAutoPlan without auto-enabling on boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan36-live-'));
  const statePath = join(root, 'state.json');
  try {
    const service = new PolymarketTradingService({
      config: { plan3_6LiveEnabled: true, plan5LiveEnabled: false },
      statePath
    });
    assert.deepEqual(service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan2_5'] }), ['plan2_5']);
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan2_5', 'plan3_6'] }),
      ['plan2_5', 'plan3_6']
    );
    const started = await service.setLiveAutoPlan('plan3_6', true, {
      timeframes: ['5m', '15m']
    });
    assert.ok(started.enabledPlans.includes('plan3_6'));
    assert.equal(service.buildPlan36RulesSnapshot().liveEnabled, true);
    assert.deepEqual(service.buildPlan36RulesSnapshot().liveTimeframes, ['5m']);
    // Boot / fresh state must not auto-enable plan3_6 without an explicit start.
    const fresh = new PolymarketTradingService({
      config: { plan3_6LiveEnabled: true },
      statePath: join(root, 'fresh-state.json')
    });
    assert.deepEqual(fresh.resolveLiveAutoEnabledPlans({}), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
