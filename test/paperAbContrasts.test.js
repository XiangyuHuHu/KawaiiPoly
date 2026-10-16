import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getConfig } from '../src/config.js';
import {
  PAPER_AB_COMPARISON_GUIDE,
  PAPER_AB_CONTRAST_IDS,
  calibratePlan36Confidence,
  contrastPlan14Config,
  contrastPlan16Options,
  contrastPlan26Config,
  contrastPlan36Config,
  paperContrastLiveTradingEnabled
} from '../src/paperAbContrasts.js';
import { blendPlan14Up, evaluatePlan14Entry, resolvePlan14Config } from '../src/polymarketPlan14.js';
import { evaluatePlan16Row } from '../src/polymarketPlan16.js';
import { applyPlan26EntryPolicy, evaluatePlan26EntryPolicy, resolvePlan26ProfileOverrides } from '../src/polymarketPlan2_6.js';
import { buildPolymarketPaperPlan3_6 } from '../src/polymarketPlan3_6.js';
import { ACTIVE_PAPER_PLAN_IDS, buildActivePaperPlansView } from '../src/polymarketPaperPlansView.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

const SLOT_ISO = '2099-01-10T00:00:00.000Z';
const TARGET_ISO = '2099-01-10T00:05:00.000Z';
const NOW = new Date('2099-01-10T00:02:30.000Z');

function plan14Signal() {
  return {
    symbol: 'BTC-USD',
    schedule: { currentSlotIso: SLOT_ISO, nextSlotIso: TARGET_ISO, slotMinutes: 5, secondsToNext: 150 },
    prediction: { targetTimeIso: TARGET_ISO, comparisonBasePrice: 100 },
    indicators: {
      currentPrice: 100.1,
      slotStartPrice: 100,
      volatility15mPct: 0.001,
      currentQuoteTime: new Date(NOW.getTime() - 1000).toISOString()
    }
  };
}

function plan14Book() {
  return {
    up: { bid: 0.49, ask: 0.51, bookTimeMs: NOW.getTime() },
    down: { bid: 0.49, ask: 0.51, bookTimeMs: NOW.getTime() }
  };
}

test('plan14b halves the current 5m spot weight and stays closer to the market', () => {
  assert.equal(resolvePlan14Config({}).modelWeight5m, 0.23);
  const source = { plan14ModelWeight5m: 0.40, marker: 'control' };
  const halved = contrastPlan14Config(source);
  assert.equal(source.plan14ModelWeight5m, 0.40);
  assert.equal(resolvePlan14Config(halved).modelWeight5m, 0.20);
  assert.equal(resolvePlan14Config(contrastPlan14Config({})).modelWeight5m, resolvePlan14Config({}).modelWeight5m * 0.5);

  const marketUp = 0.5;
  const spotUp = 0.92;
  const controlBlend = blendPlan14Up({ marketUp, spotUp, timeframe: '5m' });
  const treatmentBlend = blendPlan14Up({
    marketUp,
    spotUp,
    timeframe: '5m',
    config: contrastPlan14Config({})
  });
  assert.ok(Math.abs(treatmentBlend - marketUp) < Math.abs(controlBlend - marketUp));

  const entry = {
    signal: plan14Signal(),
    sentiment: { available: true, upPrice: 0.5, downPrice: 0.5, upBestAsk: 0.51, downBestAsk: 0.51 },
    book: plan14Book(),
    now: NOW,
    timeframe: '5m'
  };
  const controlEntry = evaluatePlan14Entry(entry);
  const treatmentEntry = evaluatePlan14Entry({ ...entry, config: contrastPlan14Config({}) });
  assert.ok(controlEntry.model?.blendedUp > marketUp);
  assert.ok(Math.abs(treatmentEntry.model.blendedUp - marketUp) < Math.abs(controlEntry.model.blendedUp - marketUp));
});

test('plan16b raises the ask floor to 0.20 and rejects a 12¢ tail the control accepts', () => {
  const row = {
    market: {
      question: 'Will the highest temperature in Wellington be 19°C on October 10?',
      description: 'NOAA at the Wellington Intl Airport Station. https://www.weather.gov/wrh/timeseries?site=nzwn',
      slug: 'wellington-19',
      conditionId: '0xabc',
      endDate: '2026-10-10T12:00:00Z',
      active: true,
      closed: false,
      outcomes: '["Yes","No"]',
      clobTokenIds: '["yes-token","no-token"]',
      outcomePrices: '["0.12","0.88"]'
    },
    forecast: {
      offsetSeconds: 46800,
      days: { '2026-10-10': { max: Array.from({ length: 30 }, () => 19), min: Array.from({ length: 30 }, () => 11) } }
    },
    yesBook: { bestBid: 0.10, bestAsk: 0.12 },
    noBook: { bestBid: 0.86, bestAsk: 0.90 },
    nowMs: Date.parse('2026-10-10T00:30:00Z')
  };
  const control = evaluatePlan16Row(row);
  assert.equal(control.ok, true, control.reason);
  assert.equal(control.ask, 0.12);
  const treatment = evaluatePlan16Row({ ...row, ...contrastPlan16Options({}, { plan16bMinAsk: 0.20 }) });
  assert.equal(treatment.ok, false);
  assert.equal(treatment.reason, 'edge_below_threshold');
  assert.equal(contrastPlan16Options({}, {}).minAsk, 0.20);
});

test('plan2_6b caps chase entries at 0.80 including the hard max', () => {
  const control = resolvePlan26ProfileOverrides({});
  assert.equal(control.plan2_6EntryMaxPrice, 0.90);
  assert.equal(control.plan2_6EntryHardMaxPrice, 0.92);
  const source = { plan2_6EntryMaxPrice: 0.90 };
  const contrastConfig = contrastPlan26Config(source);
  assert.equal(source.plan2_6EntryMaxPrice, 0.90);
  assert.equal(contrastConfig.plan2_6LiveEnabled, false);
  const treatment = resolvePlan26ProfileOverrides(contrastConfig);
  assert.equal(treatment.plan2_6EntryMaxPrice, 0.80);
  assert.equal(treatment.plan2_6EntryHardMaxPrice, 0.80);

  assert.equal(evaluatePlan26EntryPolicy({ entryType: 'sustained_momentum', entryPrice: 0.85, config: {} }).allowed, true);
  assert.equal(evaluatePlan26EntryPolicy({
    entryType: 'sustained_momentum',
    entryPrice: 0.85,
    config: contrastConfig
  }).allowed, false);
  assert.equal(evaluatePlan26EntryPolicy({
    entryType: 'sustained_momentum',
    entryPrice: 0.79,
    config: contrastConfig
  }).allowed, true);
  const blocked = applyPlan26EntryPolicy({
    shouldTrade: true,
    entryType: 'sustained_momentum',
    limitPrice: 0.85,
    usd: 10
  }, contrastConfig);
  assert.equal(blocked.shouldTrade, false);
});

function plan36Inputs(confidence) {
  return {
    signal: {
      symbol: 'ETH-USD',
      schedule: {
        currentSlotIso: '2026-10-16T12:00:00.000Z',
        nextSlotIso: '2026-10-16T12:05:00.000Z',
        secondsToNext: 120,
        slotMinutes: 5
      }
    },
    sentiment: {
      available: true,
      symbol: 'ETH-USD',
      upBestAsk: 0.15,
      downBestAsk: 0.79,
      upPrice: 0.15,
      downPrice: 0.79
    },
    recommendation: { direction: 'down', confidence },
    portfolio: { cash: 100 },
    now: new Date('2026-10-16T12:02:00.000Z')
  };
}

test('plan3_6b calibrates confidence before the edge filter', () => {
  const base = {
    plan3_6Enabled: true,
    plan3_6MinSignalConfidence: 0.55,
    plan3_6MinModelEdge: 0.05,
    plan3_6OrderUsd: 5,
    plan3_6CalibrateConfidence: false
  };
  const control = buildPolymarketPaperPlan3_6({
    ...plan36Inputs(0.90),
    config: base
  });
  assert.equal(control.action.shouldTrade, true);
  assert.equal(control.observation.tokenPrice, 0.80);
  assert.equal(control.observation.modelEdge, 0.10);
  assert.equal(control.observation.modelProbability, null);

  const shrunk = buildPolymarketPaperPlan3_6({
    ...plan36Inputs(0.90),
    config: contrastPlan36Config({ ...base, plan3_6bConfidenceShrink: 0.5 })
  });
  assert.equal(shrunk.observation.calibrationSource, 'shrink_toward_half');
  assert.equal(shrunk.observation.modelProbability, 0.7);
  assert.equal(shrunk.observation.modelEdge, -0.1);
  assert.equal(shrunk.action.shouldTrade, false);
  assert.equal(shrunk.action.skipReason, 'model_edge_below_floor');

  const table = {
    'plan3_6|ETH-USD|5m|down|main|70+': { sampleCount: 80, actualWinRate: 0.90 }
  };
  const rawMiss = buildPolymarketPaperPlan3_6({ ...plan36Inputs(0.82), config: base });
  assert.equal(rawMiss.action.skipReason, 'model_edge_below_floor');
  assert.ok(rawMiss.observation.modelEdge < 0.05);
  const empirical = buildPolymarketPaperPlan3_6({
    ...plan36Inputs(0.82),
    config: contrastPlan36Config(base),
    calibrationTable: table
  });
  assert.equal(empirical.observation.calibrationSource, 'empirical_win_rate');
  assert.equal(empirical.observation.modelProbability, 0.9);
  assert.equal(empirical.action.shouldTrade, true);

  const direct = calibratePlan36Confidence({ rawConfidence: 0.90, entryPrice: 0.80, config: { plan3_6bConfidenceShrink: 0.5 } });
  assert.equal(direct.source, 'shrink_toward_half');
  assert.equal(direct.probability, 0.7);
  assert.equal(direct.edge, -0.1);
});

test('contrast ledgers stay paper-only and the controls remain registered', async () => {
  assert.equal(paperContrastLiveTradingEnabled(), false);
  assert.deepEqual(PAPER_AB_CONTRAST_IDS, ['plan14b', 'plan16b', 'plan2_6b', 'plan3_6b']);
  for (const id of PAPER_AB_CONTRAST_IDS) assert.ok(ACTIVE_PAPER_PLAN_IDS.includes(id));
  assert.ok(ACTIVE_PAPER_PLAN_IDS.includes('plan14'));
  assert.ok(ACTIVE_PAPER_PLAN_IDS.includes('plan16'));
  assert.ok(ACTIVE_PAPER_PLAN_IDS.includes('plan2_6'));
  assert.ok(ACTIVE_PAPER_PLAN_IDS.includes('plan3_6'));
  assert.match(PAPER_AB_COMPARISON_GUIDE, /net ROI/);
  assert.match(PAPER_AB_COMPARISON_GUIDE, /drawdown/);
  assert.match(PAPER_AB_COMPARISON_GUIDE, /ask/);
  assert.match(PAPER_AB_COMPARISON_GUIDE, /Live trading stays off/);

  const config = getConfig();
  assert.equal(config.polymarket.liveTradingEnabled, process.env.POLYMARKET_LIVE_TRADING_ENABLED === 'true');
  assert.equal(config.liveTradingEnabled, process.env.ENABLE_LIVE_TRADING === 'true');
  const view = buildActivePaperPlansView({
    config: { ...config.polymarket, liveTradingEnabled: true },
    statusForPlan: (planId) => ({ planId })
  });
  for (const id of [...PAPER_AB_CONTRAST_IDS, 'plan14', 'plan16', 'plan2_6', 'plan3_6']) {
    assert.equal(view.plans[id].liveTradingEnabled, false);
  }

  const root = await mkdtemp(join(tmpdir(), 'paper-ab-live-'));
  try {
    const service = new PolymarketTradingService({
      config: config.polymarket,
      statePath: join(root, 'state.json')
    });
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({
        enabledPlans: ['plan1', 'plan14b', 'plan16b', 'plan2_6b', 'plan3_6b']
      }),
      ['plan1']
    );
    await assert.rejects(() => service.setLiveAutoPlan('plan14b', true), /禁止实盘/);
    await assert.rejects(() => service.setLiveAutoPlan('plan2_6b', true), /禁止实盘/);
    await assert.rejects(() => service.setLiveAutoPlan('plan3_6b', true), /禁止实盘/);
    await assert.rejects(() => service.setLiveAutoPlan('plan16b', true), /禁止实盘/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
