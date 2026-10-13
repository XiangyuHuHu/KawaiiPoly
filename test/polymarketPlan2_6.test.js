import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAN2_6_ID,
  evaluatePlan26EntryPolicy,
  applyPlan26EntryPolicy,
  resolvePlan26ProfileOverrides,
  buildPlan26RulesSnapshot
} from '../src/polymarketPlan2_6.js';
import {
  PLAN2_TIGHT_ID,
  isPlan2Family,
  normalizePlan2FamilyId,
  plan2FamilyLabel,
  resolvePlan2ProfileConfig
} from '../src/polymarketPlan2Profiles.js';
import { PLAN_IDS, PolymarketTradingService } from '../src/polymarketTrading.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('PLAN_IDS includes plan2_6 after plan2_5', () => {
  assert.ok(PLAN_IDS.includes('plan2_6'));
  assert.equal(PLAN_IDS.indexOf('plan2_6'), PLAN_IDS.indexOf('plan2_5') + 1);
});

test('plan2_6 is part of Plan2 family with its own label', () => {
  assert.equal(isPlan2Family('plan2_6'), true);
  assert.equal(normalizePlan2FamilyId('plan2_6'), PLAN2_TIGHT_ID);
  assert.equal(plan2FamilyLabel('plan2_6'), 'Plan2.6');
  assert.equal(PLAN2_TIGHT_ID, PLAN2_6_ID);
});

test('plan2_6 profile inherits Plan2.5 gates and applies tight entry overrides', () => {
  const cfg = resolvePlan2ProfileConfig({
    historyWinRateGateEnabled: true,
    lossReasonGateEnabled: true,
    symbolWrSizingEnabled: true,
    plan2PaperRequireAskFillable: true,
    plan2LiveSyncPaperEntryEnabled: false,
    plan2LiveSyncPaperExitEnabled: true,
    plan2SettlementCapture90Enabled: true,
    plan2UltraLateCaptureEnabled: true,
    plan2CrossFollowEnabled: true,
    plan2ProbeEnabled: true,
    plan2LateCaptureMinPrice: 0.82,
    plan2EntryMaxPrice: 0.62,
    plan2PaperEntryMaxPrice: 0.82,
    plan2_6LateCaptureMinPrice: 0.90,
    plan2_6EntryHardMaxPrice: 0.92,
    plan2_6EntryMaxPrice: 0.90
  }, 'plan2_6');
  assert.equal(cfg._plan2Profile, 'plan2_6');
  assert.equal(cfg._plan26PolicyEnabled, true);
  assert.equal(cfg.historyWinRateGateEnabled, true);
  assert.equal(cfg.lossReasonGateEnabled, true);
  // Plan2.6 defaults to paper/live entry parity; exit sync OFF so live hard SL stays on.
  assert.equal(cfg.plan2LiveSyncPaperEntryEnabled, true);
  assert.equal(cfg.plan2LiveSyncPaperExitEnabled, false);
  assert.equal(cfg.plan2SettlementCapture90Enabled, false);
  assert.equal(cfg.plan2UltraLateCaptureEnabled, false);
  assert.equal(cfg.plan2CrossFollowEnabled, false);
  assert.equal(cfg.plan2ProbeEnabled, false);
  assert.equal(cfg.plan2LateCaptureMinPrice, 0.90);
  assert.equal(cfg.plan2_6EntryHardMaxPrice, 0.92);
  // Must not keep legacy Plan2 0.62 — live safe band ~0.70–0.90.
  assert.equal(cfg.plan2EntryMaxPrice, 0.90);
  assert.equal(cfg.plan2PaperEntryMaxPrice, 0.90);
  assert.equal(cfg.plan2SustainedMomentumMaxPrice15m, 0.90);
  assert.equal(cfg.plan2PaperSustainedMomentumMaxPrice15m, 0.90);

  // Plan2.5 live entry-max ON by default (not legacy 0.62).
  const plan25 = resolvePlan2ProfileConfig({ plan2EntryMaxPrice: 0.62 }, 'plan2_5');
  assert.equal(plan25.plan2_5LiveEntryMaxEnabled, true);
  assert.equal(plan25.plan2EntryMaxPrice, 0.88);

  const plan25Capped = resolvePlan2ProfileConfig({
    plan2EntryMaxPrice: 0.62,
    plan2_5LiveEntryMaxEnabled: true,
    plan2_5EntryMaxPrice: 0.85,
    plan2_5EntryHardMaxPrice: 0.97
  }, 'plan2_5');
  assert.equal(plan25Capped.plan2_5LiveEntryMaxEnabled, true);
  assert.equal(plan25Capped.plan2EntryMaxPrice, 0.85);
});

test('Plan2.6 policy allows sustained_momentum', () => {
  const decision = evaluatePlan26EntryPolicy({
    entryType: 'sustained_momentum',
    entryPrice: 0.72,
    config: resolvePlan26ProfileOverrides({})
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.lane, 'primary');
});

test('Plan2.6 policy rejects standard / cross_follow / settlement_capture_90 / ultra_late', () => {
  const config = resolvePlan26ProfileOverrides({});
  for (const entryType of ['standard', 'cross_follow', 'settlement_capture_90', 'ultra_late_capture', 'probe', 'main']) {
    const decision = evaluatePlan26EntryPolicy({ entryType, entryPrice: 0.70, config });
    assert.equal(decision.allowed, false, entryType);
    assert.match(decision.reason, /hard-skip|not in Plan2\.6/);
  }
});

test('Plan2.6 late_capture below 0.90 is hard-skipped by default', () => {
  const config = resolvePlan26ProfileOverrides({});
  const decision = evaluatePlan26EntryPolicy({
    entryType: 'late_capture',
    entryPrice: 0.88,
    config
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.lane, 'weak_late_rejected');
});

test('Plan2.6 late_capture ≥ 0.90 is allowed', () => {
  const config = resolvePlan26ProfileOverrides({});
  const decision = evaluatePlan26EntryPolicy({
    entryType: 'late_capture',
    entryPrice: 0.91,
    config
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.lane, 'strict_late');
});

test('Plan2.6 soft late sizes down instead of killing when enabled', () => {
  const config = resolvePlan26ProfileOverrides({
    plan2_6LateCaptureSoftMode: true,
    plan2_6LateCaptureSoftSizeScale: 0.35
  });
  const decision = evaluatePlan26EntryPolicy({
    entryType: 'late_capture',
    entryPrice: 0.86,
    config
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.lane, 'soft_late');
  assert.equal(decision.sizeScale, 0.35);
  const action = applyPlan26EntryPolicy({
    shouldTrade: true,
    entryType: 'late_capture',
    limitPrice: 0.86,
    usd: 10,
    sizeMultiplier: 0.2
  }, config);
  assert.equal(action.shouldTrade, true);
  assert.equal(action.usd, 3.5);
});

test('Plan2.6 hard-caps entries above 0.97', () => {
  const config = resolvePlan26ProfileOverrides({ plan2_6EntryHardMaxPrice: 0.97 });
  const decision = evaluatePlan26EntryPolicy({
    entryType: 'late_capture',
    entryPrice: 0.99,
    config
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /hard max|99/);
});

test('Plan2.6 applyPolicy converts rejected trades to skip', () => {
  const action = applyPlan26EntryPolicy({
    shouldTrade: true,
    entryType: 'standard',
    limitPrice: 0.65,
    usd: 8
  }, resolvePlan26ProfileOverrides({}));
  assert.equal(action.shouldTrade, false);
  assert.match(action.reason, /收紧过滤/);
});

test('Plan2.6 live stays off unless LIVE_ENABLED; paper rules snapshot documents thresholds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan26-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        plan2_6Enabled: true,
        plan2_6LiveEnabled: false,
        plan2_6LateCaptureMinPrice: 0.90,
        plan2_6EntryHardMaxPrice: 0.92
      },
      statePath: join(root, 'state.json')
    });
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan2_5', 'plan2_6'] }),
      ['plan2_5']
    );
    await assert.rejects(
      () => service.setLiveAutoPlan('plan2_6', true),
      /POLYMARKET_PLAN2_6_LIVE_ENABLED=true/
    );
    const rules = buildPlan26RulesSnapshot(service.config);
    assert.equal(rules.liveEnabled, false);
    assert.equal(rules.lateCaptureMinPrice, 0.90);
    assert.equal(rules.entryHardMaxPrice, 0.92);
    assert.deepEqual(rules.liveTimeframes, ['5m', '15m']);
    assert.ok(rules.hardSkipEntryTypes.includes('standard'));
    assert.ok(rules.hardSkipEntryTypes.includes('settlement_capture_90'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan2.6 live can join enabledPlans when LIVE_ENABLED; keeps paper entry sync + filter parity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan26-live-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        plan2_6Enabled: true,
        plan2_6LiveEnabled: true,
        plan2_6LateCaptureMinPrice: 0.90,
        plan2_6EntryHardMaxPrice: 0.92,
        plan2_6EntryMaxPrice: 0.90,
        plan26LiveSyncPaperEntryEnabled: true
      },
      statePath: join(root, 'state.json')
    });
    assert.deepEqual(
      service.resolveLiveAutoEnabledPlans({ enabledPlans: ['plan2_5', 'plan2_6'] }),
      ['plan2_5', 'plan2_6']
    );
    const started = await service.setLiveAutoPlan('plan2_6', true, {
      timeframes: ['5m', '15m'],
      symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']
    });
    assert.ok(started.enabledPlans.includes('plan2_6'));
    assert.deepEqual(started.timeframes, ['5m', '15m']);
    assert.deepEqual(started.symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
    assert.equal(service.isPlan2EntrySyncedToPaperFor('plan2_6'), true);

    const profile = resolvePlan2ProfileConfig(service.config, 'plan2_6');
    assert.equal(profile.plan2LiveSyncPaperEntryEnabled, true);
    assert.equal(profile.plan2LiveSyncPaperExitEnabled, false);
    assert.equal(profile.plan2EntryMaxPrice, 0.90);
    assert.equal(profile.plan2PaperEntryMaxPrice, 0.90);

    // Same shared builder: live/paper both hard-skip standard and allow momentum.
    const skip = evaluatePlan26EntryPolicy({
      entryType: 'standard',
      entryPrice: 0.70,
      config: profile
    });
    const allow = evaluatePlan26EntryPolicy({
      entryType: 'sustained_momentum',
      entryPrice: 0.88,
      config: profile
    });
    assert.equal(skip.allowed, false);
    assert.equal(allow.allowed, true);

    const rules = buildPlan26RulesSnapshot(service.config);
    assert.equal(rules.liveEnabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Plan2.6 can opt out of live paper-entry sync via plan26 flag', () => {
  const cfg = resolvePlan2ProfileConfig({
    plan26LiveSyncPaperEntryEnabled: false,
    plan2LiveSyncPaperEntryEnabled: true,
    plan25LiveSyncPaperEntryEnabled: true
  }, 'plan2_6');
  assert.equal(cfg.plan2LiveSyncPaperEntryEnabled, false);
});

test('plan2_5 / plan2_6 delayed-entry keys stay plan-scoped and distinct', async () => {
  const { buildPlan2DelayedEntryKey } = await import('../src/polymarketPlan2.js');
  const slotIso = '2026-07-24T04:00:00.000Z';
  const key25 = buildPlan2DelayedEntryKey(slotIso, '15m', 'BTC-USD', 'plan2_5');
  const key26 = buildPlan2DelayedEntryKey(slotIso, '15m', 'BTC-USD', 'plan2_6');
  assert.match(key25, /_plan2_5$/);
  assert.match(key26, /_plan2_6$/);
  assert.notEqual(key25, key26);
});
