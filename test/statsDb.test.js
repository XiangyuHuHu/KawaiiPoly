import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createStatsDb } from '../src/statsDb.js';
import { evaluatePlan3BandStatsGate } from '../src/polymarketPlan3.js';

function tempDbPath() {
  return join(tmpdir(), `kawaii-stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test('createStatsDb persists and reads window locks', () => {
  const db = createStatsDb({ path: tempDbPath() });
  assert.equal(db.enabled, true);
  const targetTimeIso = new Date().toISOString();

  const ok = db.recordWindowLock({
    id: '5m_2026-07-08T10:05:00.000Z_BTC-USD',
    timeframe: '5m',
    symbol: 'BTC-USD',
    targetTimeIso,
    decisionLocked: true,
    lockedPolymarketPredictedDirection: 'up',
    lockStrength: 'strong',
    lockedPmGap: 0.12,
    lockedPolymarketUpProbability: 0.56,
    lockedPolymarketDownProbability: 0.44,
    lockElapsedPct: 0.14,
    polymarketQualityScore: 0.7,
    polymarketCorrect: true,
    techCorrect: false,
    compositeCorrect: true,
    actualDirection: 'up',
    evaluatedAtIso: '2026-07-08T10:05:20.000Z'
  });
  assert.equal(ok, true);

  // upsert：重复写同 id 不新增行
  db.recordWindowLock({
    id: '5m_2026-07-08T10:05:00.000Z_BTC-USD',
    timeframe: '5m',
    symbol: 'BTC-USD',
    targetTimeIso,
    decisionLocked: true,
    lockedPolymarketPredictedDirection: 'up',
    lockStrength: 'strong',
    polymarketCorrect: false
  });

  const locks = db.getLockRecords({ timeframe: '5m', lookbackDays: 14 });
  assert.equal(locks.length, 1);
  assert.equal(locks[0].lockStrength, 'strong');
  assert.equal(locks[0].polymarketCorrect, false);
  assert.equal(locks[0].decisionLocked, true);
  db.close();
});

test('createStatsDb aggregates settled orders for calibration and plan3 bands', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const nowIso = new Date().toISOString();
  const written = db.recordSettledOrders([
    {
      order: {
        id: 'o1', planId: 'plan2', timeframe: '5m', direction: 'up', entryType: 'probe',
        limitPrice: 0.55, usd: 10, pnl: 4, won: true, exitStatus: 'take-profit',
        confidence: 0.6, settledAtIso: nowIso
      },
      source: 'paper'
    },
    {
      order: {
        id: 'o2', planId: 'plan3', timeframe: '5m', direction: 'up', entryType: 'settlement_capture',
        limitPrice: 0.995, usd: 100, pnl: 0.5, won: true, exitStatus: 'expiry',
        settledAtIso: nowIso
      },
      source: 'live'
    },
    {
      order: {
        id: 'o3', planId: 'plan3', timeframe: '5m', direction: 'down', entryType: 'settlement_capture',
        limitPrice: 0.992, usd: 100, pnl: -100, won: false, exitStatus: 'expiry',
        settledAtIso: nowIso
      },
      source: 'live'
    }
  ]);
  assert.equal(written, 3);

  const calibration = db.getCalibrationOrders({ lookbackDays: 7 });
  assert.equal(calibration.length, 3);
  assert.equal(calibration.find((o) => o.id === 'o1').settlementStatus, 'settled');

  const bands = db.getPlan3BandStats({ lookbackDays: 7 });
  assert.equal(bands['99+'].total, 2);
  assert.equal(bands['99+'].wins, 1);
  assert.equal(bands['99+'].winRate, 0.5);

  const liveOnly = db.getPlan3BandStats({ lookbackDays: 7, source: 'live' });
  assert.equal(liveOnly['99+'].total, 2);
  const lifetime = db.getLifetimeLiveStats({ planIds: ['plan3'] });
  assert.equal(lifetime.available, true);
  assert.equal(lifetime.historySource, 'stats_db_lifetime');
  assert.equal(lifetime.settledTrades, 2);
  assert.equal(lifetime.wins, 1);
  assert.equal(lifetime.losses, 1);
  assert.equal(lifetime.investedUsd, 200);
  assert.equal(lifetime.realizedPnl, -99.5);
  assert.equal(lifetime.totalReturn, -0.4975);
  assert.equal(lifetime.byPlan.plan3.settledTrades, 2);
  const paperOnly = db.getPlan3BandStats({ lookbackDays: 7, source: 'paper' });
  assert.equal(Object.keys(paperOnly).length, 0);
  db.recordSettledOrders([{
    order: {
      id: 'o35', planId: 'plan3_5', timeframe: '5m', direction: 'up', entryType: 'last_minute_99',
      limitPrice: 0.99, usd: 20, pnl: -20, won: false, exitStatus: 'expiry',
      settledAtIso: nowIso, strategyVersion: 'plan3_5_v1'
    },
    source: 'paper'
  }]);
  const mergedBands = db.getPlan3BandStats({
    lookbackDays: 7,
    source: 'all',
    includeLegacyPlan35: true
  });
  assert.equal(mergedBands['99+'].total, 3);
  assert.equal(mergedBands['99+'].wins, 1);
  assert.equal(mergedBands._meta.legacyPlan35Samples, 1);
  assert.equal(mergedBands._bySymbol['BTC-USD']['99+'].total, 3);
  assert.equal(mergedBands._bySymbolPrice['BTC-USD']['99'].total, 3);
  const liveCal = db.getCalibrationOrders({ lookbackDays: 7, source: 'live' });
  assert.equal(liveCal.length, 2);
  assert.ok(liveCal.every((o) => o.source === 'live'));

  const planStats = db.getPlanEntryStats({ planId: 'plan3', timeframe: '5m', lookbackDays: 7 });
  assert.equal(planStats.total, 2);
  assert.equal(planStats.totalPnl, -99.5);

  const bySymbol = db.getPlanEntryStatsBySymbol({ planId: 'plan2', lookbackDays: 7 });
  assert.ok(bySymbol['BTC-USD'] || Object.keys(bySymbol).length >= 0);
  // o1 has no symbol → defaults BTC-USD
  assert.equal(bySymbol['BTC-USD']?.total, 1);
  assert.equal(bySymbol['BTC-USD']?.wins, 1);
  assert.equal(bySymbol['BTC-USD']?.winRate, 1);

  const lossWritten = db.recordSettledOrders([
    {
      order: {
        id: 'o4', planId: 'plan2', timeframe: '5m', direction: 'up', entryType: 'probe',
        limitPrice: 0.9, usd: 10, pnl: -10, won: false, exitStatus: 'expiry',
        settledAtIso: nowIso, lossReason: 'high_entry_negative_ev',
        lossAnalysis: { lossReason: 'high_entry_negative_ev', detail: { entryPrice: 0.9 } }
      },
      source: 'live'
    }
  ]);
  assert.equal(lossWritten, 1);
  const lossStats = db.getLossReasonStats({ planId: 'plan2', lookbackDays: 7 });
  assert.equal(lossStats.losses >= 1, true);
  assert.ok(lossStats.byReason.high_entry_negative_ev);
  assert.equal(lossStats.byReason.high_entry_negative_ev.count, 1);
  const lossOrders = db.getLossReasonOrders({ planId: 'plan2', lookbackDays: 7 });
  assert.equal(lossOrders.find((o) => o.id === 'o4').lossReason, 'high_entry_negative_ev');
  db.close();
});

test('resetPaperData removes paper research but preserves live history and lock judgments', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const nowIso = new Date().toISOString();
  db.recordWindowLock({
    id: 'keep-lock', timeframe: '5m', symbol: 'BTC-USD', targetTimeIso: nowIso,
    decisionLocked: true, lockedPolymarketPredictedDirection: 'up'
  });
  db.recordSettledOrders([
    { source: 'paper', order: { id: 'drop-paper', planId: 'plan5', timeframe: '5m', limitPrice: 0.6, usd: 5, pnl: 1, won: true, settledAtIso: nowIso } },
    { source: 'live', order: { id: 'keep-live', planId: 'plan5', timeframe: '5m', limitPrice: 0.6, usd: 5, pnl: -5, won: false, settledAtIso: nowIso } }
  ]);

  const reset = db.resetPaperData();
  assert.equal(reset.settledOrders, 1);
  assert.deepEqual(db.listSettledOrderIds(), ['keep-live']);
  assert.equal(db.getLockRecords({ timeframe: '5m', lookbackDays: 14 }).length, 1);
  db.close();
});


test('createStatsDb migrates old settled_orders schema in place', () => {
  const path = tempDbPath();
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE settled_orders (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      timeframe TEXT,
      direction TEXT,
      entry_type TEXT,
      entry_price REAL,
      usd REAL,
      pnl REAL,
      won INTEGER,
      exit_status TEXT,
      confidence REAL,
      slot_iso TEXT,
      target_time_iso TEXT,
      settled_at_iso TEXT
    );
  `);
  raw.prepare(`
    INSERT INTO settled_orders (id, source, plan_id, timeframe, direction, entry_type, entry_price, usd, pnl, won, exit_status, settled_at_iso)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-1', 'live', 'plan3', '5m', 'up', 'probe', 0.55, 10, -5, 0, 'stop_loss', new Date().toISOString());
  raw.close();

  const db = createStatsDb({ path });
  assert.equal(db.enabled, true);

  const written = db.recordSettledOrders([
    {
      order: {
        id: 'legacy-1',
        planId: 'plan3',
        timeframe: '5m',
        direction: 'up',
        entryType: 'probe',
        limitPrice: 0.55,
        usd: 10,
        pnl: -5,
        won: false,
        exitStatus: 'stop_loss',
        settledAtIso: new Date().toISOString(),
        lossReason: 'post_entry_pm_reversal',
        pmReversal: true,
        lossAnalysis: { lossReason: 'post_entry_pm_reversal', pmReversal: { anyLargeReversal: true } }
      },
      source: 'live'
    },
    {
      order: {
        id: 'new-1',
        planId: 'plan3',
        timeframe: '5m',
        direction: 'down',
        entryType: 'settlement_capture',
        limitPrice: 0.99,
        usd: 20,
        pnl: 1,
        won: true,
        exitStatus: 'expiry',
        settledAtIso: new Date().toISOString(),
        lossReason: null,
        pmReversal: false,
        lossAnalysis: null
      },
      source: 'live'
    }
  ]);
  assert.equal(written, 2);

  const verify = new DatabaseSync(path);
  const cols = verify.prepare('PRAGMA table_info(settled_orders)').all().map((r) => r.name);
  assert.ok(cols.includes('loss_reason'));
  assert.ok(cols.includes('pm_reversal'));
  assert.ok(cols.includes('loss_analysis_json'));
  assert.ok(cols.includes('symbol'));
  assert.ok(cols.includes('cross_symbol_aligned'));
  assert.ok(cols.includes('cross_symbol_leader'));
  assert.ok(cols.includes('leader_limit_price'));
  const row = verify.prepare('SELECT loss_reason, pm_reversal, loss_analysis_json FROM settled_orders WHERE id = ?').get('legacy-1');
  assert.equal(row.loss_reason, 'post_entry_pm_reversal');
  assert.equal(row.pm_reversal, 1);
  assert.ok(String(row.loss_analysis_json).includes('post_entry_pm_reversal'));
  const kept = verify.prepare('SELECT COUNT(*) AS n FROM settled_orders').get().n;
  assert.equal(kept, 2);
  verify.close();
  db.close();
});

test('createStatsDb migrates symbol/cross fields and round-trips settled orders', () => {
  const path = tempDbPath();
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE settled_orders (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      timeframe TEXT,
      direction TEXT,
      entry_type TEXT,
      entry_price REAL,
      usd REAL,
      pnl REAL,
      won INTEGER,
      exit_status TEXT,
      confidence REAL,
      slot_iso TEXT,
      target_time_iso TEXT,
      settled_at_iso TEXT
    );
  `);
  raw.close();

  const db = createStatsDb({ path });
  assert.equal(db.enabled, true);

  const written = db.recordSettledOrders([
    {
      order: {
        id: 'eth-cross-1',
        planId: 'plan2',
        symbol: 'ETH-USD',
        timeframe: '5m',
        direction: 'up',
        entryType: 'cross_follow',
        limitPrice: 0.58,
        usd: 12,
        pnl: 2.4,
        won: true,
        exitStatus: 'take_profit',
        confidence: 0.66,
        settledAtIso: new Date().toISOString(),
        crossSymbolAligned: true,
        crossSymbolLeader: 'BTC-USD',
        leaderLimitPrice: 0.70
      },
      source: 'paper'
    }
  ]);
  assert.equal(written, 1);

  const verify = new DatabaseSync(path);
  const cols = verify.prepare('PRAGMA table_info(settled_orders)').all().map((r) => r.name);
  assert.ok(cols.includes('symbol'));
  assert.ok(cols.includes('cross_symbol_aligned'));
  assert.ok(cols.includes('cross_symbol_leader'));
  assert.ok(cols.includes('leader_limit_price'));
  const row = verify.prepare(`
    SELECT symbol, cross_symbol_aligned, cross_symbol_leader, leader_limit_price, entry_type
    FROM settled_orders WHERE id = ?
  `).get('eth-cross-1');
  assert.equal(row.symbol, 'ETH-USD');
  assert.equal(row.cross_symbol_aligned, 1);
  assert.equal(row.cross_symbol_leader, 'BTC-USD');
  assert.equal(row.leader_limit_price, 0.70);
  assert.equal(row.entry_type, 'cross_follow');
  verify.close();

  const mapped = db.getCalibrationOrders({ lookbackDays: 30, source: 'paper' });
  const found = mapped.find((item) => item.id === 'eth-cross-1');
  assert.ok(found);
  assert.equal(found.symbol, 'ETH-USD');
  assert.equal(found.crossSymbolAligned, true);
  assert.equal(found.crossSymbolLeader, 'BTC-USD');
  assert.equal(found.leaderLimitPrice, 0.70);
  db.close();
});

test('createStatsDb disabled mode degrades silently', () => {
  const db = createStatsDb({ enabled: false, path: tempDbPath() });
  assert.equal(db.enabled, false);
  assert.equal(db.recordWindowLock({ id: 'x' }), false);
  assert.deepEqual(db.getLockRecords(), []);
  assert.deepEqual(db.getPlan3BandStats(), {});
});

test('createStatsDb round-trips Plan5 decision diagnostics', () => {
  const path = tempDbPath();
  const db = createStatsDb({ path });
  const written = db.recordSettledOrders([{
    source: 'live',
    order: {
      id: 'plan5-diagnostic-1',
      planId: 'plan5',
      symbol: 'SOL-USD',
      timeframe: '5m',
      direction: 'up',
      entryType: 'pm_lock_strength',
      entryPrice: 0.68,
      usd: 15,
      pnl: -15,
      won: false,
      exitStatus: 'expiry',
      settledAtIso: new Date().toISOString(),
      lockStrength: 'normal',
      lockPmGap: 0.08,
      lockedAtIso: '2026-07-10T04:00:10.000Z',
      signalQuality: { stableMs: 20000, pullbackFromPeak: 0.02, reverseBps: 3 },
      expectedValueGate: { level: 'symbol_timeframe_price', sampleCount: 12, expectedRoi: 0.04 },
      strategyVersion: 'plan5_ev_v2'
    }
  }]);
  assert.equal(written, 1);
  const found = db.getCalibrationOrders({ lookbackDays: 30, source: 'live' })
    .find((item) => item.id === 'plan5-diagnostic-1');
  assert.ok(found);
  assert.equal(found.lockStrength, 'normal');
  assert.equal(found.lockPmGap, 0.08);
  assert.equal(found.signalQuality.stableMs, 20000);
  assert.equal(found.expectedValueGate.sampleCount, 12);
  assert.equal(found.strategyVersion, 'plan5_ev_v2');
  db.close();
});

test('evaluatePlan3BandStatsGate blocks bands below breakeven with enough samples', () => {
  const config = { plan3BandStatsGateEnabled: true, plan3BandStatsMinSamples: 30, plan3BandStatsMargin: 0.005 };

  // 样本不足：放行（冷启动不拦截）
  const coldStart = evaluatePlan3BandStatsGate({
    tokenPrice: 0.995,
    bandStats: { '99+': { total: 10, wins: 9, losses: 1, winRate: 0.9 } },
    config
  });
  assert.equal(coldStart.allowed, true);
  assert.equal(coldStart.insufficientSamples, true);

  // 样本足够且胜率低于买价+margin：拦截
  const blocked = evaluatePlan3BandStatsGate({
    tokenPrice: 0.995,
    bandStats: { '99+': { total: 60, wins: 58, losses: 2, winRate: 58 / 60 } },
    config
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /低于盈亏平衡/);

  // 胜率足够：放行
  const passed = evaluatePlan3BandStatsGate({
    tokenPrice: 0.93,
    bandStats: { '93-95': { total: 60, wins: 58, losses: 2, winRate: 58 / 60 } },
    config
  });
  assert.equal(passed.allowed, true);

  // 关闭开关：放行
  const disabled = evaluatePlan3BandStatsGate({
    tokenPrice: 0.995,
    bandStats: { '99+': { total: 60, wins: 30, losses: 30, winRate: 0.5 } },
    config: { plan3BandStatsGateEnabled: false }
  });
  assert.equal(disabled.allowed, true);
});

test('evaluatePlan3BandStatsGate blocks when fill-adjusted breakeven exceeds win rate', () => {
  const config = { plan3BandStatsGateEnabled: true, plan3BandStatsMinSamples: 30, plan3BandStatsMargin: 0.005 };
  const bandStats = { '93-95': { total: 60, wins: 57, losses: 3, winRate: 57 / 60 } };
  const blocked = evaluatePlan3BandStatsGate({
    tokenPrice: 0.93,
    effectiveFillPrice: 0.965,
    bandStats,
    config
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.requiredWinRate > 0.96);
});

test('evaluatePlan3BandStatsGate prefers exact symbol-price history', () => {
  const config = { plan3BandStatsGateEnabled: true, plan3BandStatsMinSamples: 30, plan3BandStatsMargin: 0.005 };
  const bandStats = {
    '96-98': { total: 200, wins: 180, losses: 20, winRate: 0.9 },
    _bySymbol: {
      'ETH-USD': { '96-98': { total: 100, wins: 94, losses: 6, winRate: 0.94 } }
    },
    _bySymbolPrice: {
      'ETH-USD': { '96': { total: 60, wins: 59, losses: 1, winRate: 59 / 60 } },
      'BTC-USD': { '96': { total: 60, wins: 40, losses: 20, winRate: 40 / 60 } }
    }
  };
  const eth = evaluatePlan3BandStatsGate({
    symbol: 'eth-usd', tokenPrice: 0.96, effectiveFillPrice: 0.96, bandStats, config
  });
  assert.equal(eth.allowed, true);
  assert.equal(eth.statsScope, 'symbol_price');

  const btc = evaluatePlan3BandStatsGate({
    symbol: 'BTC-USD', tokenPrice: 0.96, effectiveFillPrice: 0.96, bandStats, config
  });
  assert.equal(btc.allowed, false);
  assert.equal(btc.statsScope, 'symbol_price');
});

test('createStatsDb persists and evaluates next_slot_predictions', () => {
  const db = createStatsDb({ path: tempDbPath() });
  assert.equal(db.enabled, true);

  const pending = {
    id: 'nsp_5m_2026-07-09T01:00:00.000Z_BTC-USD',
    sourceSlotIso: '2026-07-09T01:00:00.000Z',
    sourceTimeframe: '5m',
    sourceTargetTimeIso: '2026-07-09T01:05:00.000Z',
    predictedSlotIso: '2026-07-09T01:05:00.000Z',
    predictedDirection: 'up',
    predictedAtIso: '2026-07-09T01:01:00.000Z',
    lockStrength: 'strong',
    lockGap: 0.12,
    symbol: 'BTC-USD',
    status: 'pending',
    correct: null
  };
  assert.equal(db.recordNextSlotPrediction(pending), true);

  const loaded = db.getNextSlotPrediction(pending.id);
  assert.equal(loaded.predictedDirection, 'up');
  assert.equal(loaded.status, 'pending');

  const waiting = db.getPendingNextSlotPredictions({
    predictedSlotIso: '2026-07-09T01:05:00.000Z',
    timeframe: '5m'
  });
  assert.equal(waiting.length, 1);

  assert.equal(db.recordNextSlotPrediction({
    ...pending,
    status: 'correct',
    correct: true,
    actualDirection: 'up',
    evaluatedAtIso: '2026-07-09T01:10:05.000Z',
    evaluationSource: 'window_actual'
  }), true);

  const evaluated = db.getNextSlotPrediction(pending.id);
  assert.equal(evaluated.correct, true);
  assert.equal(evaluated.status, 'correct');
  assert.equal(db.getPendingNextSlotPredictions({
    predictedSlotIso: '2026-07-09T01:05:00.000Z',
    timeframe: '5m'
  }).length, 0);

  const list = db.getNextSlotPredictions({ lookbackDays: 36500, timeframe: '5m' });
  assert.equal(list.length, 1);
  assert.ok(db.counts().nextSlotPredictions >= 1);
  db.close();
});


test('createStatsDb next_slot_predictions keeps first predictedDirection on conflict', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const pending = {
    id: 'nsp_5m_2026-07-09T02:00:00.000Z_BTC-USD',
    sourceSlotIso: '2026-07-09T02:00:00.000Z',
    sourceTimeframe: '5m',
    sourceTargetTimeIso: '2026-07-09T02:05:00.000Z',
    predictedSlotIso: '2026-07-09T02:05:00.000Z',
    predictedDirection: 'up',
    predictedAtIso: '2026-07-09T02:02:30.000Z',
    lockStrength: 'normal',
    lockGap: 0.08,
    symbol: 'BTC-USD',
    status: 'pending',
    correct: null
  };
  assert.equal(db.recordNextSlotPrediction(pending), true);
  assert.equal(db.recordNextSlotPrediction({
    ...pending,
    predictedDirection: 'down',
    lockStrength: 'strong',
    lockGap: 0.15,
    predictedAtIso: '2026-07-09T02:04:00.000Z'
  }), true);
  const kept = db.getNextSlotPrediction(pending.id);
  assert.equal(kept.predictedDirection, 'up');
  assert.equal(kept.lockStrength, 'normal');
  assert.equal(kept.lockGap, 0.08);
  assert.equal(kept.status, 'pending');

  assert.equal(db.recordNextSlotPrediction({
    ...pending,
    predictedDirection: 'down',
    status: 'correct',
    correct: true,
    actualDirection: 'up',
    evaluatedAtIso: '2026-07-09T02:10:05.000Z',
    evaluationSource: 'window_actual'
  }), true);
  const evaluated = db.getNextSlotPrediction(pending.id);
  assert.equal(evaluated.predictedDirection, 'up');
  assert.equal(evaluated.correct, true);
  assert.equal(evaluated.actualDirection, 'up');
  assert.equal(evaluated.status, 'correct');
  db.close();
});

test('createStatsDb counts include directionJudgments', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const counts = db.counts();
  assert.equal(typeof counts.directionJudgments, 'number');
  assert.equal(counts.directionJudgments, 0);
  db.close();
});

test('createStatsDb persists Plan7 market samples idempotently', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const sample = {
    id: 'plan7-weather-complete:test:1',
    strategyVersion: 'plan7_locked_taker_v7_adaptive_capital',
    category: 'weather',
    opportunityType: 'complete-set',
    eventSlug: 'weather-test',
    marketSlug: 'weather-test',
    title: 'Highest temperature test',
    observedAtIso: '2026-07-13T18:00:00.000Z',
    shares: 5,
    legCount: 11,
    combinedCost: 1.005,
    feeUsd: 0.02,
    lockedPnl: -0.025,
    eligible: false,
    reason: 'complete_set_all_in_above_cap'
  };
  assert.equal(db.recordPlan7Samples([sample]), 1);
  assert.equal(db.recordPlan7Samples([sample]), 0);
  assert.equal(db.counts().plan7MarketSamples, 1);
  db.close();
});

test('createStatsDb compacts Plan7 profiles to one best event opportunity per hourly bucket', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const base = {
    strategyVersion: 'plan7_compact',
    category: 'weather',
    opportunityType: 'complete-set',
    eventSlug: 'weather-compact',
    observedAtIso: '2026-07-13T18:04:00.000Z',
    eligible: true
  };
  assert.equal(db.recordPlan7Samples([
    { ...base, id: 'raw-1', marketSlug: 'market-a', shares: 5, combinedCost: 0.99, lockedPnl: 0.05 },
    { ...base, id: 'raw-2', marketSlug: 'market-b', shares: 10, combinedCost: 0.97, lockedPnl: 0.3 }
  ]), 1);
  assert.equal(db.recordPlan7Samples([
    { ...base, id: 'raw-3', observedAtIso: '2026-07-13T18:14:59.000Z', combinedCost: 0.96, lockedPnl: 0.4 }
  ]), 1);
  assert.equal(db.recordPlan7Samples([
    { ...base, id: 'raw-4', observedAtIso: '2026-07-13T19:00:00.000Z', combinedCost: 0.96, lockedPnl: 0.4 }
  ]), 1);
  assert.equal(db.counts().plan7MarketSamples, 2);
  db.close();
});

