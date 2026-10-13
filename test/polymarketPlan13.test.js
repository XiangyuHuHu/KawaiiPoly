import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLAN13_ID,
  PLAN13_VERSION,
  buildPlan13RulesSnapshot
} from '../src/polymarketPlan13.js';
import {
  isPlan2Family,
  normalizePlan2FamilyId,
  plan2FamilyLabel,
  resolvePlan2ProfileConfig
} from '../src/polymarketPlan2Profiles.js';
import { buildPolymarketPaperPlan2 } from '../src/polymarketPlan2.js';
import { PLAN_IDS, PolymarketTradingService } from '../src/polymarketTrading.js';

function sentiment({ up = 0.80, down = 0.20, quality = 0.70 } = {}) {
  return {
    available: true,
    upPrice: up,
    downPrice: down,
    upProbability: up,
    downProbability: down,
    qualityScore: quality
  };
}

function signal({
  direction = 'up',
  start = 100,
  current = 100.12,
  timeframe = '5m'
} = {}) {
  return {
    symbol: 'BTC-USD',
    timeframe,
    direction,
    technicalDirection: direction,
    prediction: {
      comparisonBasePrice: start,
      estimatedClose: current,
      targetTimeIso: '2026-08-26T02:05:00.000Z'
    },
    indicators: {
      currentPrice: current,
      slotStartPrice: start,
      return3Pct: 0.0012
    },
    schedule: {
      slotMinutes: timeframe === '5m' ? 5 : 15,
      currentSlotIso: '2026-08-26T02:00:00.000Z',
      nextSlotIso: '2026-08-26T02:05:00.000Z',
      secondsToNext: timeframe === '5m' ? 210 : 630
    }
  };
}

test('PLAN_IDS keeps dormant plan13 but drops plan12', () => {
  assert.ok(PLAN_IDS.includes(PLAN13_ID));
  assert.ok(!PLAN_IDS.includes('plan12'));
});

test('plan13 is a Plan2-family profile with its own label', () => {
  assert.equal(isPlan2Family('plan13'), true);
  assert.equal(normalizePlan2FamilyId('plan13'), PLAN13_ID);
  assert.equal(plan2FamilyLabel('plan13'), 'Plan13');
});

test('plan13 profile relaxes entry to 58-92 and disables take-profit', () => {
  const cfg = resolvePlan2ProfileConfig({
    plan2EntryMaxPrice: 0.62,
    plan2PaperEntryMaxPrice: 0.75,
    plan2TakeProfitEnabled: true,
    plan2TrailingTakeProfitEnabled: true
  }, 'plan13');
  assert.equal(cfg._plan2Profile, PLAN13_ID);
  assert.equal(cfg.plan2EntryMinPrice, 0.58);
  assert.equal(cfg.plan2EntryMaxPrice, 0.92);
  assert.equal(cfg.plan2PaperEntryMaxPrice, 0.92);
  assert.equal(cfg.plan2TakeProfitEnabled, false);
  assert.equal(cfg.plan2TrailingTakeProfitEnabled, false);
  assert.equal(cfg.plan2LiveSyncPaperExitEnabled, false);
  assert.equal(cfg.plan2ProbeEnabled, false);
  assert.equal(cfg.plan2SettlementCapture90Enabled, false);
  const snap = buildPlan13RulesSnapshot(cfg);
  assert.equal(snap.strategyVersion, PLAN13_VERSION);
  assert.equal(snap.takeProfitEnabled, false);
  assert.equal(snap.exitMode, 'hard_sl_hold_to_settlement');
});

test('plan13 plan view uses 0.92 entry cap and disables take-profit flags', () => {
  const plan = buildPolymarketPaperPlan2({
    signal: signal(),
    sentiment: sentiment({ up: 0.85, down: 0.15 }),
    timeframe: '5m',
    planId: 'plan13',
    paperMode: true,
    config: {
      plan2SustainedMomentumEnabled: true,
      plan2MinConfidence: 0.50,
      plan2MinEdge: 0.01,
      plan2RequirePolymarketAlignment: false
    }
  });
  assert.equal(plan.planId, 'plan13');
  assert.equal(plan.exitRule.takeProfitEnabled, false);
  assert.equal(plan.exitRule.trailingTakeProfitEnabled, false);
  assert.equal(plan.exitRule.entryMinPrice, 0.58);
  assert.equal(plan.exitRule.entryMaxPrice, 0.92);
});

test('plan13 paper stop-loss closes; pullback does not take profit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan13-'));
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      dailyMaxLossUsd: 50,
      plan2StopLossOffset: 0.12,
      plan2TakeProfitEnabled: true,
      plan2TrailingTakeProfitEnabled: true,
      plan2StopLossEnabled: true,
      plan13StopLossEnabled: true
    },
    stateDir: dir
  });
  try {
    await service.configurePortfolio({ cash: 500, planId: 'plan13' });
    await service.createPaperOrder({
      symbol: 'BTC-USD',
      direction: 'up',
      usd: 100,
      planId: 'plan13',
      sentiment: {
        available: true,
        timeframe: '15m',
        upTokenId: '1',
        downTokenId: '2',
        upPrice: 0.80,
        downPrice: 0.20,
        targetTimeIso: '2099-01-01T00:15:00.000Z',
        schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
      },
      plan: { takeProfitPrice: 0.98, stopLossPrice: 0.68, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
    }, 'plan13');

    assert.equal((await service.processPlan2TakeProfits(async () => 0.90)).length, 0);
    assert.equal(service.getBucket('plan13').paperOrders[0].settlementStatus, 'open');

    const stopped = await service.processPlan2TakeProfits(async () => 0.67);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].planId, 'plan13');
    assert.equal(stopped[0].exitStatus, 'stop-loss');
    assert.equal(service.isPlan2TakeProfitEnabled('plan13'), false);
    assert.equal(service.isPlan2TrailingTakeProfitEnabled('plan13'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plan13 live trigger fires hard SL and ignores trailing / fixed TP', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2TrailingTakeProfitEnabled: true,
      plan2TakeProfitEnabled: true,
      plan2StopLossEnabled: true,
      plan13StopLossEnabled: true
    },
    statePath: 'data/test-polymarket-live-plan13.json'
  });
  const position = {
    planId: 'plan13',
    entryPrice: 0.80,
    limitPrice: 0.80,
    takeProfitPrice: 0.98,
    stopLossPrice: 0.68
  };
  assert.equal(service.evaluateLiveExitTrigger(position, 0.90), null);
  assert.equal(service.evaluateLiveExitTrigger(position, 0.88), null);
  assert.equal(service.evaluateLiveExitTrigger(position, 0.67)?.exitStatus, 'stop-loss');
});

test('plan13 live exits skip expired windows so official settlement can own them', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan2StopLossEnabled: true,
      plan13StopLossEnabled: true
    },
    statePath: 'data/test-polymarket-live-plan13-expired.json'
  });
  service.state.liveOrders = [{
    id: 'p13-expired',
    planId: 'plan13',
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'open',
    timeframe: '5m',
    symbol: 'ETH-USD',
    direction: 'down',
    entryPrice: 0.74,
    stopLossPrice: 0.64,
    targetTimeIso: '2020-01-01T00:00:00.000Z',
    remainingShares: 6
  }];
  let priced = 0;
  const closed = await service.processLivePlan2Exits(async () => {
    priced += 1;
    return 0.10;
  });
  assert.equal(closed.length, 0);
  assert.equal(priced, 0);
  assert.equal(service.state.liveOrders[0].positionStatus, 'open');
});

test('Plan13 live stays off unless LIVE_ENABLED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan13-live-off-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        plan13Enabled: true,
        plan13LiveEnabled: false
      },
      statePath: join(root, 'state.json')
    });
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan1', 'plan13'] }),
      ['plan1']
    );
    await assert.rejects(
      () => service.setLiveAutoPlan('plan13', true),
      /POLYMARKET_PLAN13_LIVE_ENABLED=true/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan13 live can join enabledPlans when LIVE_ENABLED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan13-live-on-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        plan13Enabled: true,
        plan13LiveEnabled: true,
        liveTradingEnabled: true
      },
      statePath: join(root, 'state.json')
    });
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan1', 'plan13'] }),
      ['plan1', 'plan13']
    );
    const started = await service.setLiveAutoPlan('plan13', true, {
      timeframes: ['5m', '15m'],
      symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']
    });
    assert.ok(started.enabledPlans.includes('plan13'));
    assert.deepEqual(started.timeframes, ['5m', '15m']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
