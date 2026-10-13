import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAdaptiveLiveOrderCap } from '../src/polymarketLiveRisk.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

function settlements({ count, wins, entryPrice = 0.5, usd = 10, winPnl = 8, lossPnl = -10, symbol = 'BTC-USD', timeframe = '5m' }) {
  return Array.from({ length: count }, (_, index) => ({
    won: index < wins,
    entryPrice,
    usd,
    pnl: index < wins ? winPnl : lossPnl,
    symbol,
    timeframe,
    entryType: 'standard'
  }));
}

test('adaptive live cap rewards net profitable evidence and cuts net losing evidence', () => {
  const common = {
    equity: 500,
    absoluteMaxUsd: 100,
    baseEquityPct: 0.08,
    floorEquityPct: 0.03,
    maxEquityPct: 0.10,
    minOrderUsd: 5,
    minSamples: 12,
    symbol: 'BTC-USD',
    timeframe: '5m',
    entryType: 'standard',
    entryPrice: 0.5,
    confidence: 0.70,
    edge: 0.10,
    qualityScore: 0.65
  };
  const profitable = computeAdaptiveLiveOrderCap({
    ...common,
    liveOrders: settlements({ count: 30, wins: 21, winPnl: 9 })
  });
  const losing = computeAdaptiveLiveOrderCap({
    ...common,
    liveOrders: settlements({ count: 30, wins: 18, winPnl: 3 })
  });

  assert.ok(profitable.capUsd > losing.capUsd);
  assert.ok(losing.capUsd >= 15);
  assert.ok(profitable.capUsd <= 50);
  assert.ok(profitable.realizedRoi > 0);
  assert.ok(losing.realizedRoi < 0);
});

test('paper evidence is down-weighted and cold start still leaves a tradable cap', () => {
  const result = computeAdaptiveLiveOrderCap({
    equity: 250,
    absoluteMaxUsd: 100,
    baseEquityPct: 0.08,
    floorEquityPct: 0.03,
    maxEquityPct: 0.10,
    minOrderUsd: 5,
    minSamples: 12,
    paperWeight: 0.20,
    paperOrders: settlements({ count: 20, wins: 20 }),
    symbol: 'BTC-USD',
    timeframe: '5m',
    entryPrice: 0.5
  });

  assert.equal(result.liveSamples, 0);
  assert.equal(result.paperSamples, 20);
  assert.ok(Math.abs(result.samples - 4) < 1e-9);
  assert.ok(result.capUsd >= 7.5);
  assert.ok(result.capUsd < 25);
});

test('total-only exposure mode ignores slot caps but blocks extreme total live exposure', () => {
  const service = new PolymarketTradingService({
    config: {
      globalExposureCapEnabled: true,
      globalExposureMode: 'total_only',
      globalSlotDirectionMaxExposurePct: 0.01,
      globalTimeframeMaxExposurePct: 0.01,
      globalTotalBtcMarketExposurePct: 0.75
    },
    statePath: 'data/test-total-only-live-exposure.json'
  });
  service.state.liveOrders = [{
    id: 'open-plan5',
    planId: 'plan5',
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'open',
    timeframe: '5m',
    slotIso: '2099-07-16T12:00:00.000Z',
    direction: 'up',
    usd: 20
  }];
  assert.equal(service.checkGlobalExposure({
    timeframe: '5m',
    slotIso: '2099-07-16T12:00:00.000Z',
    direction: 'up',
    newOrderUsd: 5,
    equity: 100,
    source: 'live'
  }).allowed, true);

  service.state.liveOrders.push({
    id: 'open-plan3',
    planId: 'plan3',
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'open',
    timeframe: '15m',
    slotIso: '2099-07-16T12:00:00.000Z',
    direction: 'down',
    usd: 53
  });
  const blocked = service.checkGlobalExposure({
    timeframe: '5m',
    slotIso: '2099-07-16T12:00:00.000Z',
    direction: 'up',
    newOrderUsd: 5,
    equity: 100,
    source: 'live'
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /全部实盘未结算总暴露/);
});

test('buildLiveOrderDraft applies adaptive cap without suppressing a valid minimum order', () => {
  const losingRows = settlements({ count: 30, wins: 15, winPnl: 2, symbol: 'XRP-USD', timeframe: '5m' });
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 100,
      maxOrderUsd: 500,
      minOrderUsd: 5,
      maxOrderEquityPct: 0.12,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1,
      plan5StrongCashPct: 0.30,
      plan5MinOrderUsd: 5,
      liveAdaptiveCapEnabled: true,
      liveAdaptiveCapBaseEquityPct: 0.08,
      liveAdaptiveCapFloorEquityPct: 0.03,
      liveAdaptiveCapMaxEquityPct: 0.10,
      liveAdaptiveCapMinSamples: 12,
      liveAdaptiveCapLookbackDays: 30,
      liveAdaptiveCapPaperWeight: 0.20
    },
    statePath: 'data/test-adaptive-live-draft.json',
    statsDb: {
      enabled: true,
      getLossReasonOrders: ({ source }) => source === 'live' ? losingRows : []
    }
  });
  const draft = service.buildLiveOrderDraft({
    planId: 'plan5',
    clobBalanceUsdc: 250,
    plan: {
      planId: 'plan5',
      symbol: 'XRP-USD',
      timeframe: '5m',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 75,
        cashPct: 0.30,
        confidence: 0.65,
        edge: 0.05,
        entryType: 'standard'
      }
    },
    sentiment: {
      available: true,
      symbol: 'XRP-USD',
      timeframe: '5m',
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      upPrice: 0.50,
      downPrice: 0.50,
      qualityScore: 0.50
    }
  });

  assert.ok(draft.usd >= 5);
  assert.ok(draft.usd <= 10);
  assert.ok(draft.liveRisk.adaptiveCap);
  assert.equal(draft.liveRisk.adaptiveCap.liveSamples, 30);
  assert.ok(draft.liveRisk.adaptiveCap.realizedRoi < 0);
});
