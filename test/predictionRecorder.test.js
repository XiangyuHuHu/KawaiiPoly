import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasExplicitPmLockMetadata,
  isExplicitPmLockRecord,
  renderFifteenMinuteLockStrengthStatRows,
  resolveLockedPolymarketDirection,
  renderFiveMinuteLockStrengthStatRows,
  withFiveMinuteLockFallbacks
} from '../src/predictionRecorder.js';

test('PredictionRecorder tracks PM direction when composite direction is wait', async () => {
  const { PredictionRecorder } = await import('../src/predictionRecorder.js');
  const recorder = new PredictionRecorder({
    recordDir: 'unused-test-records',
    fetchQuotes: async () => [],
    enabled: true,
    symbols: ['BTC-USD']
  });
  const targetTimeIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  recorder.track([{
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'wait',
    confidence: 0.5,
    prediction: {
      targetTimeIso,
      horizonMinutes: 5,
      comparisonBasePrice: 60000,
      estimatedClose: 60000,
      estimatedMovePct: 0
    },
    indicators: { elapsedInCurrentSlotPct: 0.1 },
    polymarket: {
      available: true,
      upProbability: 0.62,
      downProbability: 0.38,
      qualityScore: 0.7,
      spread: 0.02
    }
  }], new Date().toISOString());

  assert.equal(recorder.pending.size, 1);
  assert.equal([...recorder.pending.values()][0].polymarketPredictedDirection, 'up');
  for (const timer of recorder.timers.values()) clearTimeout(timer);
});

test('PredictionRecorder writes throttled intra-window price snapshots', async () => {
  const { PredictionRecorder } = await import('../src/predictionRecorder.js');
  const snapshots = [];
  const recorder = new PredictionRecorder({
    recordDir: 'unused-test-records',
    fetchQuotes: async () => [],
    enabled: true,
    symbols: ['BTC-USD'],
    statsDb: { recordWindowSnapshot: (s) => snapshots.push(s) },
    windowSnapshotIntervalMs: 15000
  });
  const nowMs = Date.parse('2099-01-01T00:02:00.000Z');
  const signal = {
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'up',
    prediction: { targetTimeIso: '2099-01-01T00:05:00.000Z', horizonMinutes: 5, comparisonBasePrice: 60000 },
    indicators: { currentPrice: 60010, slotStartPrice: 60000 },
    polymarket: { available: true, upProbability: 0.6, downProbability: 0.4, upPrice: 0.6, downPrice: 0.4, upBestAsk: 0.61, downBestAsk: 0.41 }
  };
  recorder.track([signal], new Date(nowMs).toISOString());
  recorder.track([signal], new Date(nowMs + 5000).toISOString());
  recorder.track([signal], new Date(nowMs + 15000).toISOString());
  for (const timer of recorder.timers.values()) clearTimeout(timer);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].elapsedPct, 0.4);
  assert.equal(snapshots[0].upAsk, 0.61);
  assert.equal(snapshots[0].slotOpenPrice, 60000);
});

test('resolveLockedPolymarketDirection prefers locked PM direction over later updates', () => {
  assert.equal(
    resolveLockedPolymarketDirection({
      decisionLocked: true,
      lockedPolymarketPredictedDirection: 'down',
      polymarketPredictedDirection: 'up'
    }),
    'down'
  );
});

test('resolveLockedPolymarketDirection ignores unlocked trailing PM direction', () => {
  assert.equal(
    resolveLockedPolymarketDirection({
      decisionLocked: false,
      polymarketPredictedDirection: 'up'
    }),
    null
  );
});

test('legacy 5m MD rows backfill locked PM direction for win-rate stats', () => {
  const record = {
    id: '5m_2026-07-06T00:05:00.000Z_BTC-USD',
    polymarketPredictedDirection: 'down',
    polymarketUpProbability: 0.39,
    polymarketDownProbability: 0.61,
    polymarketCorrect: null,
    actualDirection: 'up'
  };
  assert.equal(resolveLockedPolymarketDirection(record), null);
  const [backfilled] = withFiveMinuteLockFallbacks([record]);
  assert.equal(backfilled.lockedPolymarketPredictedDirection, 'down');
  assert.equal(resolveLockedPolymarketDirection(backfilled), 'down');
  assert.equal(backfilled.polymarketCorrect, false);
  assert.equal(isExplicitPmLockRecord(backfilled), true);
});

test('15m rows without lock metadata and below display threshold stay unlocked', () => {
  const record = {
    id: '15m_2026-07-06T09:45:00.000Z_BTC-USD',
    predictedAtIso: '2026-07-06T09:32:15.000Z',
    polymarketPredictedDirection: 'up',
    polymarketUpProbability: 0.72,
    polymarketDownProbability: 0.28,
    polymarketQualityScore: 0.55,
    polymarketCorrect: null,
    actualDirection: 'down'
  };
  assert.equal(hasExplicitPmLockMetadata(record), false);
  assert.equal(resolveLockedPolymarketDirection(record), null);
  const [backfilled] = withFiveMinuteLockFallbacks([record]);
  assert.equal(backfilled.lockedPolymarketPredictedDirection, undefined);
  assert.equal(backfilled.decisionLocked, undefined);
  assert.equal(backfilled.polymarketCorrect, null);
  assert.equal(isExplicitPmLockRecord(backfilled), false);
});

test('15m rows meeting display threshold backfill lock metadata and wrong outcomes', () => {
  const record = {
    id: '15m_2026-07-06T09:45:00.000Z_BTC-USD',
    predictedAtIso: '2026-07-06T09:32:15.000Z',
    polymarketPredictedDirection: 'up',
    polymarketUpProbability: 0.72,
    polymarketDownProbability: 0.28,
    polymarketQualityScore: 0.55,
    lastElapsedInCurrentSlotPct: 0.15,
    polymarketCorrect: null,
    actualDirection: 'down'
  };
  const [backfilled] = withFiveMinuteLockFallbacks([record]);
  assert.equal(backfilled.decisionLocked, true);
  assert.equal(backfilled.lockedPolymarketPredictedDirection, 'up');
  assert.equal(backfilled.lockStrength, 'normal');
  assert.equal(backfilled.polymarketCorrect, false);
  assert.equal(isExplicitPmLockRecord(backfilled), true);
});

test('15m rows infer elapsed from final prediction time for display lock backfill', () => {
  const record = {
    id: '15m_2026-07-06T14:30:00.000Z_BTC-USD',
    timeframe: '15m',
    predictedAtIso: '2026-07-06T14:44:59.000Z',
    targetTimeIso: '2026-07-06T14:45:00.000Z',
    polymarketPredictedDirection: 'up',
    polymarketUpProbability: 0.72,
    polymarketDownProbability: 0.28,
    polymarketQualityScore: 0.55,
    decisionLocked: false,
    skipReason: 'unstable_direction',
    polymarketCorrect: null,
    actualDirection: 'down'
  };
  const [backfilled] = withFiveMinuteLockFallbacks([record]);
  assert.equal(backfilled.decisionLocked, true);
  assert.equal(backfilled.lockedPolymarketPredictedDirection, 'up');
  assert.equal(backfilled.polymarketCorrect, false);
  assert.equal(isExplicitPmLockRecord(backfilled), true);
});

test('legacy 15m rows without new lock metadata stay out of display lock backfill', () => {
  const record = {
    id: '2026-06-29T14:30:00.000Z_BTC-USD',
    predictedAtIso: '2026-06-29T14:44:59.000Z',
    targetTimeIso: '2026-06-29T14:45:00.000Z',
    polymarketPredictedDirection: 'up',
    polymarketUpProbability: 0.62,
    polymarketDownProbability: 0.38,
    skipReason: 'legacy_no_pm_lock',
    polymarketCorrect: null,
    actualDirection: 'down'
  };
  const [backfilled] = withFiveMinuteLockFallbacks([record]);
  assert.equal(backfilled.lockedPolymarketPredictedDirection, undefined);
  assert.equal(isExplicitPmLockRecord(backfilled), false);
});

test('isExplicitPmLockRecord requires explicit lock metadata and settled PM outcome', () => {
  assert.equal(
    isExplicitPmLockRecord({
      id: '15m_2026-07-06T09:45:00.000Z_BTC-USD',
      decisionLocked: true,
      lockedPolymarketPredictedDirection: 'down',
      lockStrength: 'normal',
      polymarketCorrect: true
    }),
    true
  );
  assert.equal(
    isExplicitPmLockRecord({
      id: '15m_2026-07-06T09:45:00.000Z_BTC-USD',
      lockedPolymarketPredictedDirection: 'down',
      lockStrength: 'normal',
      polymarketCorrect: true
    }),
    true
  );
  assert.equal(
    isExplicitPmLockRecord({
      id: '15m_2026-07-06T09:45:00.000Z_BTC-USD',
      polymarketPredictedDirection: 'down',
      polymarketCorrect: true
    }),
    false
  );
  assert.equal(
    isExplicitPmLockRecord({
      id: '15m_2026-07-06T09:45:00.000Z_BTC-USD',
      decisionLocked: false,
      lockedPolymarketPredictedDirection: 'down',
      lockStrength: 'normal',
      polymarketCorrect: true
    }),
    false
  );
});

test('hasExplicitPmLockMetadata treats decisionLocked true or locked direction with strength/gap as explicit', () => {
  assert.equal(hasExplicitPmLockMetadata({ decisionLocked: true }), true);
  assert.equal(
    hasExplicitPmLockMetadata({
      lockedPolymarketPredictedDirection: 'up',
      lockStrength: 'weak'
    }),
    true
  );
  assert.equal(
    hasExplicitPmLockMetadata({
      lockedPolymarketPredictedDirection: 'up',
      lockedPmGap: 0.08
    }),
    true
  );
  assert.equal(
    hasExplicitPmLockMetadata({
      lockedPolymarketPredictedDirection: 'up'
    }),
    false
  );
  assert.equal(hasExplicitPmLockMetadata({ decisionLocked: false }), false);
});

test('legacy timestamp IDs normalize to 15m_ prefix when parsing daily MD rows', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { PredictionRecorder } = await import('../src/predictionRecorder.js');

  const dir = await mkdtemp(join(tmpdir(), 'prediction-recorder-'));
  try {
    const row = [
      '| 2026-06-27T14:45:00.000Z_BTC-USD',
      '2026-06-27 22:44:59',
      '2026-06-27 22:44:59',
      '2026-06-27 22:45:00',
      'BTC-USD',
      '$60640.00',
      '上涨',
      '72.23%',
      '27.77%',
      '错误',
      '上涨',
      '72.23%',
      '27.77%',
      '错误',
      '--',
      '0.00%',
      '0.00%',
      '--',
      '--',
      '0.00%',
      '0.00%',
      '--',
      '0-5m:上涨:错误:72.23%',
      '--',
      '--',
      '0',
      '1',
      '$60650.00',
      '$60620.00',
      '下跌',
      '0.02%',
      '-0.03%',
      '72.23%',
      '--',
      '--',
      '--'
    ].join(' | ') + ' |';
    await writeFile(join(dir, '2026-06-27.md'), `# test\n\n## 记录\n\n${row}\n`, 'utf8');
    const recorder = new PredictionRecorder({ recordDir: dir, fetchQuotes: async () => [], enabled: true });
    const records = await recorder.readRecordsInLookback(14);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, '15m_2026-06-27T14:45:00.000Z_BTC-USD');
    assert.equal(records[0].timeframe, '15m');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderFiveMinuteLockStrengthStatRows writes per-strength win rates for daily MD', () => {
  const md = renderFiveMinuteLockStrengthStatRows({
    buckets: {
      strength: {
        strong: { total: 3, correct: 3, wrong: 0, accuracy: 1 },
        normal: { total: 16, correct: 15, wrong: 1, accuracy: 15 / 16 },
        weak: { total: 35, correct: 21, wrong: 14, accuracy: 21 / 35 }
      }
    }
  });
  assert.match(md, /5m PM 强锁定胜率.*100\.00%.*3\/3/);
  assert.match(md, /5m PM 普通锁定胜率.*93\.75%.*15\/16/);
  assert.match(md, /5m PM 弱锁定胜率.*60\.00%.*21\/35/);
});

test('lock strength stat rows keep empty buckets for stable daily MD', () => {
  const fiveMinute = renderFiveMinuteLockStrengthStatRows({ buckets: { strength: {} } });
  assert.match(fiveMinute, /5m PM .*--.*暂无数据/);
  assert.match(fiveMinute, /强锁定胜率/);
  assert.match(fiveMinute, /普通锁定胜率/);
  assert.match(fiveMinute, /弱锁定胜率/);

  const fifteenMinute = renderFifteenMinuteLockStrengthStatRows({ buckets: { strength: {} } });
  assert.match(fifteenMinute, /15m PM .*--.*暂无数据/);
  assert.match(fifteenMinute, /强锁定胜率/);
  assert.match(fifteenMinute, /普通锁定胜率/);
  assert.match(fifteenMinute, /弱锁定胜率/);
});

test('renderIntervalPmExtraCell persists 15m lock metadata for daily MD', async () => {
  const { renderIntervalPmExtraCell, parseIntervalPmExtraCell } = await import('../src/fiveMinuteDecision.js');
  const extra = renderIntervalPmExtraCell({
    id: '15m_2026-07-06T09:45:00.000Z_BTC-USD',
    timeframe: '15m',
    decisionLocked: true,
    lockedPolymarketPredictedDirection: 'down',
    lockStrength: 'normal',
    lockedPmGap: 0.576,
    decisionLockedAtIso: '2026-07-06T09:32:10.000Z',
    polymarketCorrect: true,
    techCorrect: false,
    compositeCorrect: true
  });
  assert.match(extra, /^tf=15m;/);
  assert.match(extra, /locked=down/);
  assert.match(extra, /strength=normal/);
  const parsed = parseIntervalPmExtraCell(extra);
  assert.equal(parsed.timeframe, '15m');
  assert.equal(parsed.lockedPolymarketPredictedDirection, 'down');
  assert.equal(parsed.lockStrength, 'normal');
  assert.equal(parsed.decisionLocked, true);

  // 截断/缺失 locked 键的 extra cell 不应被误判成已锁定。
  const truncated = parseIntervalPmExtraCell('tf=15m;strength=normal;gap=5.0%');
  assert.equal(truncated.decisionLocked, false);
  assert.equal(truncated.lockedPolymarketPredictedDirection, null);

  const unlocked = parseIntervalPmExtraCell('tf=5m;locked=none;strength=--;gap=--');
  assert.equal(unlocked.decisionLocked, false);
});

test('PredictionRecorder emits next-slot prediction only after late lock and keeps first direction', async () => {
  const { PredictionRecorder } = await import('../src/predictionRecorder.js');
  const { createStatsDb } = await import('../src/statsDb.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'nsp-recorder-'));
  const db = createStatsDb({ path: join(dir, 'stats.db') });
  const recorder = new PredictionRecorder({
    recordDir: dir,
    enabled: true,
    symbols: ['BTC-USD'],
    statsDb: db,
    fetchQuotes: async () => []
  });
  recorder.nextSlotPredictionLockConfig5m = {
    timeframe: '5m',
    minElapsedPct: 0.5,
    minPmGap: 0.06,
    allowWeak: true,
    weakMinElapsedPct: 0.6,
    minStrength: 'normal'
  };

  const lockedRecord = {
    decisionLocked: true,
    timeframe: '5m',
    symbol: 'BTC-USD',
    targetTimeIso: '2026-07-09T03:05:00.000Z',
    decisionLockedAtIso: '2026-07-09T03:01:00.000Z',
    lockedPolymarketPredictedDirection: 'up',
    lockStrength: 'normal',
    lockedPmGap: 0.1,
    lockReason: 'mid_stable',
    lockElapsedPct: 0.15,
    lastElapsedInCurrentSlotPct: 0.2
  };

  assert.equal(recorder.maybeEmitNextSlotPrediction(lockedRecord), null);
  assert.equal(db.getNextSlotPrediction('nsp_5m_2026-07-09T03:00:00.000Z_BTC-USD'), null);

  const first = recorder.maybeEmitNextSlotPrediction({
    ...lockedRecord,
    lastElapsedInCurrentSlotPct: 0.55
  });
  assert.ok(first);
  assert.equal(first.predictedDirection, 'up');

  const flipped = recorder.maybeEmitNextSlotPrediction({
    ...lockedRecord,
    lastElapsedInCurrentSlotPct: 0.7,
    lockedPolymarketPredictedDirection: 'down',
    lockStrength: 'strong',
    lockedPmGap: 0.2
  });
  assert.equal(flipped.predictedDirection, 'up');
  assert.equal(
    db.getNextSlotPrediction('nsp_5m_2026-07-09T03:00:00.000Z_BTC-USD').predictedDirection,
    'up'
  );
  assert.equal(
    recorder.getActiveNextSlotPrediction({
      currentSlotIso: '2026-07-09T03:00:00.000Z',
      timeframe: '5m',
      symbol: 'BTC-USD'
    })?.predictedDirection,
    'up'
  );

  db.close();
});

test('PredictionRecorder hard-deadline and settlement force next-slot lock', async () => {
  const { PredictionRecorder } = await import('../src/predictionRecorder.js');
  const { createStatsDb } = await import('../src/statsDb.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'nsp-hard-'));
  const db = createStatsDb({ path: join(dir, 'stats.db') });
  const recorder = new PredictionRecorder({
    recordDir: dir,
    enabled: true,
    symbols: ['BTC-USD'],
    statsDb: db,
    fetchQuotes: async () => []
  });
  recorder.nextSlotPredictionLockConfig5m = {
    timeframe: '5m',
    minElapsedPct: 0.5,
    minPmGap: 0.06,
    allowWeak: true,
    weakMinElapsedPct: 0.6,
    minStrength: 'normal',
    hardMinElapsedPct: 0.9,
    hardMaxRemainingSec: 30
  };

  // Weak lock with gap below soft min — mid window still waits
  const weakRecord = {
    decisionLocked: true,
    timeframe: '5m',
    symbol: 'BTC-USD',
    targetTimeIso: '2026-07-09T04:05:00.000Z',
    decisionLockedAtIso: '2026-07-09T04:01:00.000Z',
    lockedPolymarketPredictedDirection: 'down',
    lockStrength: 'weak',
    lockedPmGap: 0.04,
    lockReason: 'display_threshold',
    lockElapsedPct: 0.15,
    lastElapsedInCurrentSlotPct: 0.7
  };
  assert.equal(recorder.maybeEmitNextSlotPrediction(weakRecord), null);

  // Near end: hard deadline writes even with small gap
  const hard = recorder.maybeEmitNextSlotPrediction({
    ...weakRecord,
    lastElapsedInCurrentSlotPct: 0.92
  });
  assert.ok(hard);
  assert.equal(hard.predictedDirection, 'down');
  assert.equal(hard.lockMode, 'hard');

  // First write wins — settlement force must not flip
  const settledFlip = recorder.maybeEmitNextSlotPrediction({
    ...weakRecord,
    lastElapsedInCurrentSlotPct: 0.99,
    lockedPolymarketPredictedDirection: 'up',
    lockStrength: 'strong',
    lockedPmGap: 0.2
  }, { forceSettlement: true });
  assert.equal(settledFlip.predictedDirection, 'down');

  // Fresh source window: settlement force alone is enough
  const settleOnly = {
    decisionLocked: true,
    timeframe: '5m',
    symbol: 'BTC-USD',
    targetTimeIso: '2026-07-09T04:10:00.000Z',
    decisionLockedAtIso: '2026-07-09T04:06:00.000Z',
    lockedPolymarketPredictedDirection: 'up',
    lockStrength: 'weak',
    lockedPmGap: 0.035,
    lockReason: 'display_threshold',
    lockElapsedPct: 0.2,
    lastElapsedInCurrentSlotPct: 0.55
  };
  assert.equal(recorder.maybeEmitNextSlotPrediction(settleOnly), null);
  const forced = recorder.maybeEmitNextSlotPrediction(settleOnly, { forceSettlement: true });
  assert.ok(forced);
  assert.equal(forced.predictedDirection, 'up');
  assert.equal(forced.lockMode, 'hard');

  db.close();
});
