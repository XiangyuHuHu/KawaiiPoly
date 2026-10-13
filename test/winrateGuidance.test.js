import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStatsDb } from '../src/statsDb.js';
import {
  applyGuidanceToSignal,
  buildDirectionJudgmentId,
  buildJudgmentGuidance,
  extractJudgmentFromSignal,
  resolveHourBucket,
  resolveVolatilityBucket
} from '../src/winrateGuidance.js';

function tempDbPath() {
  return join(tmpdir(), `kawaii-winrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test('direction_judgments upserts on refresh and settles actual outcome', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const id = buildDirectionJudgmentId({
    timeframe: '5m',
    targetTimeIso: '2026-07-10T06:05:00.000Z',
    symbol: 'BTC-USD'
  });

  assert.equal(db.recordDirectionJudgment({
    id,
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: '2026-07-10T06:00:00.000Z',
    targetTimeIso: '2026-07-10T06:05:00.000Z',
    predictedDirection: 'up',
    predictedAtIso: '2026-07-10T06:01:00.000Z',
    confidence: 0.62,
    upProb: 0.62,
    downProb: 0.38,
    lockStrength: 'normal',
    lockGap: 0.08,
    price: 108000,
    source: 'binance',
    hourBucket: 14,
    volatilityBucket: 'mid',
    sameDirectionAsPrev: true
  }), true);

  assert.equal(db.recordDirectionJudgment({
    id,
    symbol: 'BTC-USD',
    timeframe: '5m',
    targetTimeIso: '2026-07-10T06:05:00.000Z',
    predictedDirection: 'down',
    predictedAtIso: '2026-07-10T06:02:00.000Z',
    confidence: 0.58,
    lockStrength: 'strong',
    hourBucket: 14,
    volatilityBucket: 'mid'
  }), true);

  const pending = db.getDirectionJudgments({
    lookbackDays: 36500,
    timeframe: '5m',
    symbol: 'BTC-USD'
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].predictedDirection, 'down');
  assert.equal(pending[0].refreshCount, 2);
  assert.equal(pending[0].status, 'pending');

  assert.equal(db.settleDirectionJudgmentsForTarget({
    targetTimeIso: '2026-07-10T06:05:00.000Z',
    timeframe: '5m',
    actualDirection: 'down'
  }), 1);

  const settled = db.getDirectionJudgments({
    lookbackDays: 36500,
    timeframe: '5m',
    symbol: 'BTC-USD',
    settledOnly: true
  });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].correct, true);
  assert.equal(settled[0].actualDirection, 'down');
  assert.equal(settled[0].status, 'correct');
  assert.ok(db.counts().directionJudgments >= 1);
  db.close();
});

test('getConditionalWinRates slices by direction / hour / strength', () => {
  const db = createStatsDb({ path: tempDbPath() });
  const base = {
    timeframe: '15m',
    symbol: 'ETH-USD',
    source: 'binance',
    volatilityBucket: 'mid'
  };

  for (let i = 0; i < 10; i += 1) {
    const target = new Date(Date.now() - (i + 1) * 3600_000).toISOString();
    const id = buildDirectionJudgmentId({ timeframe: '15m', targetTimeIso: target, symbol: 'ETH-USD' });
    db.recordDirectionJudgment({
      ...base,
      id,
      targetTimeIso: target,
      predictedDirection: i < 7 ? 'up' : 'down',
      predictedAtIso: target,
      lockStrength: i < 5 ? 'strong' : 'normal',
      hourBucket: i < 6 ? 10 : 22,
      sameDirectionAsPrev: i % 2 === 0
    });
    db.settleDirectionJudgment({
      id,
      actualDirection: i < 7 ? 'up' : 'up'
    });
  }

  const overall = db.getConditionalWinRates({ timeframe: '15m', symbol: 'ETH-USD', lookbackDays: 30 });
  assert.equal(overall.total, 10);
  assert.equal(overall.correct, 7);

  const upOnly = db.getConditionalWinRates({
    timeframe: '15m',
    symbol: 'ETH-USD',
    lookbackDays: 30,
    direction: 'up'
  });
  assert.equal(upOnly.total, 7);
  assert.equal(upOnly.winRate, 1);

  const strong = db.getConditionalWinRates({
    timeframe: '15m',
    symbol: 'ETH-USD',
    lookbackDays: 30,
    direction: 'up',
    lockStrength: 'strong'
  });
  assert.equal(strong.total, 5);
  assert.equal(strong.sampleInsufficient, true);

  db.close();
});

test('buildJudgmentGuidance marks sampleInsufficient and raises weight on edge', () => {
  const db = createStatsDb({ path: tempDbPath() });
  for (let i = 0; i < 12; i += 1) {
    const target = `2026-07-10T${String(i).padStart(2, '0')}:05:00.000Z`;
    const id = buildDirectionJudgmentId({ timeframe: '5m', targetTimeIso: target, symbol: 'SOL-USD' });
    db.recordDirectionJudgment({
      id,
      symbol: 'SOL-USD',
      timeframe: '5m',
      targetTimeIso: target,
      predictedDirection: 'up',
      predictedAtIso: target,
      lockStrength: 'normal',
      hourBucket: 16,
      volatilityBucket: 'mid',
      sameDirectionAsPrev: true
    });
    db.settleDirectionJudgment({ id, actualDirection: i < 9 ? 'up' : 'down' });
  }

  const judgment = {
    symbol: 'SOL-USD',
    timeframe: '5m',
    predictedDirection: 'up',
    lockStrength: 'normal',
    hourBucket: 16,
    volatilityBucket: 'mid',
    sameDirectionAsPrev: true
  };

  const guidance = buildJudgmentGuidance({
    judgment,
    statsDb: db,
    minSamples: 8,
    lookbackDays: 36500
  });
  assert.equal(guidance.sampleInsufficient, false);
  assert.ok(guidance.conditional.total >= 8);
  assert.ok(guidance.suggestedWeight >= 1);
  assert.ok(String(guidance.note).includes('历史同条件胜率'));

  const thin = buildJudgmentGuidance({
    judgment: { ...judgment, symbol: 'XRP-USD' },
    statsDb: db,
    minSamples: 8,
    lookbackDays: 36500
  });
  assert.equal(thin.sampleInsufficient, true);
  assert.ok(String(thin.note).includes('样本不足'));

  const signal = applyGuidanceToSignal({ direction: 'up', confidence: 0.6 }, guidance);
  assert.equal(signal.confidenceBeforeGuidance, 0.6);
  assert.ok(Number(signal.confidence) >= 0.6);
  assert.ok(signal.winrateGuidance);

  db.close();
});

test('extractJudgmentFromSignal prefers locked decision and fills buckets', () => {
  const signal = {
    symbol: 'BTC-USD',
    direction: 'down',
    confidence: 0.55,
    currentPrice: 109000,
    schedule: {
      currentSlotIso: '2026-07-10T06:00:00.000Z',
      nextSlotIso: '2026-07-10T06:05:00.000Z'
    },
    prediction: { targetTimeIso: '2026-07-10T06:05:00.000Z' },
    lockedDecision: {
      direction: 'up',
      strength: 'strong',
      pmGap: 0.12,
      confidence: 0.7,
      upProbability: 0.7,
      downProbability: 0.3
    },
    indicators: { volatility15mPct: 0.004 },
    polymarket: { available: true, upProbability: 0.4, downProbability: 0.6 }
  };

  const judgment = extractJudgmentFromSignal(signal, {
    timeframe: '5m',
    source: 'binance',
    generatedAt: '2026-07-10T06:01:00.000Z'
  });
  assert.equal(judgment.predictedDirection, 'up');
  assert.equal(judgment.lockStrength, 'strong');
  assert.equal(judgment.volatilityBucket, resolveVolatilityBucket(0.004));
  assert.equal(judgment.hourBucket, resolveHourBucket('2026-07-10T06:01:00.000Z'));
  assert.equal(judgment.id, 'dj_5m_2026-07-10T06:05:00.000Z_BTC-USD');
  assert.equal(judgment.source, 'polymarket');

  const unlocked = extractJudgmentFromSignal({
    ...signal,
    lockedDecision: null
  }, { timeframe: '5m', source: 'binance' });
  assert.equal(unlocked, null);
});

test('getDirectionJudgments pushes symbol/timeframe filters to SQL and supports limit', () => {
  const db = createStatsDb({ path: tempDbPath() });
  for (let i = 0; i < 5; i += 1) {
    const target = `2026-07-11T0${i}:05:00.000Z`;
    db.recordDirectionJudgment({
      id: buildDirectionJudgmentId({ timeframe: '5m', targetTimeIso: target, symbol: 'BTC-USD' }),
      symbol: 'BTC-USD',
      timeframe: '5m',
      targetTimeIso: target,
      predictedDirection: 'up',
      predictedAtIso: target,
      lockStrength: 'normal',
      hourBucket: 12
    });
    db.recordDirectionJudgment({
      id: buildDirectionJudgmentId({ timeframe: '15m', targetTimeIso: target, symbol: 'ETH-USD' }),
      symbol: 'ETH-USD',
      timeframe: '15m',
      targetTimeIso: target,
      predictedDirection: 'down',
      predictedAtIso: target,
      lockStrength: 'strong',
      hourBucket: 12
    });
  }

  const btc5 = db.getDirectionJudgments({
    lookbackDays: 36500,
    timeframe: '5m',
    symbol: 'BTC-USD'
  });
  assert.equal(btc5.length, 5);
  assert.ok(btc5.every((row) => row.symbol === 'BTC-USD' && row.timeframe === '5m'));

  const limited = db.getDirectionJudgments({
    lookbackDays: 36500,
    timeframe: '5m',
    symbol: 'BTC-USD',
    limit: 2
  });
  assert.equal(limited.length, 2);

  const ethPending = db.getConditionalWinRates({
    lookbackDays: 36500,
    timeframe: '15m',
    symbol: 'ETH-USD'
  });
  assert.equal(ethPending.total, 0);

  for (const row of db.getDirectionJudgments({
    lookbackDays: 36500,
    timeframe: '15m',
    symbol: 'ETH-USD'
  })) {
    db.settleDirectionJudgment({ id: row.id, actualDirection: 'down' });
  }
  const ethSettled = db.getConditionalWinRates({
    lookbackDays: 36500,
    timeframe: '15m',
    symbol: 'ETH-USD',
    direction: 'down'
  });
  assert.equal(ethSettled.total, 5);
  assert.equal(ethSettled.winRate, 1);

  db.close();
});

test('buildJudgmentGuidance uses a single judgment scan', () => {
  const db = createStatsDb({ path: tempDbPath() });
  let judgmentReads = 0;
  const wrapped = {
    enabled: true,
    getDirectionJudgments(...args) {
      judgmentReads += 1;
      return db.getDirectionJudgments(...args);
    },
    getConditionalWinRates() {
      throw new Error('should not fall back to repeated getConditionalWinRates');
    }
  };

  for (let i = 0; i < 10; i += 1) {
    const target = `2026-07-12T${String(i).padStart(2, '0')}:05:00.000Z`;
    const id = buildDirectionJudgmentId({ timeframe: '5m', targetTimeIso: target, symbol: 'SOL-USD' });
    db.recordDirectionJudgment({
      id,
      symbol: 'SOL-USD',
      timeframe: '5m',
      targetTimeIso: target,
      predictedDirection: 'up',
      predictedAtIso: target,
      lockStrength: 'normal',
      hourBucket: 16,
      volatilityBucket: 'mid',
      sameDirectionAsPrev: true
    });
    db.settleDirectionJudgment({ id, actualDirection: i < 7 ? 'up' : 'down' });
  }

  const guidance = buildJudgmentGuidance({
    judgment: {
      symbol: 'SOL-USD',
      timeframe: '5m',
      predictedDirection: 'up',
      lockStrength: 'normal',
      hourBucket: 16,
      volatilityBucket: 'mid',
      sameDirectionAsPrev: true
    },
    statsDb: wrapped,
    minSamples: 8,
    lookbackDays: 36500
  });
  assert.equal(judgmentReads, 1);
  assert.equal(guidance.sampleInsufficient, false);
  assert.ok(guidance.conditional.total >= 8);
  db.close();
});

test('buildJudgmentGuidance uses the real strength and hour intersection', () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => ({
      predictedDirection: 'up',
      lockStrength: 'normal',
      hourBucket: 13,
      correct: index < 2,
      predictedAtIso: `2026-07-16T05:${String(index).padStart(2, '0')}:00.000Z`
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      predictedDirection: 'up',
      lockStrength: 'normal',
      hourBucket: 12,
      correct: true,
      predictedAtIso: `2026-07-16T04:${String(index).padStart(2, '0')}:00.000Z`
    }))
  ];
  const guidance = buildJudgmentGuidance({
    judgment: {
      symbol: 'BTC-USD',
      timeframe: '5m',
      predictedDirection: 'up',
      lockStrength: 'normal',
      hourBucket: 13,
      predictedAtIso: '2026-07-16T05:30:00.000Z'
    },
    statsDb: {
      enabled: true,
      getDirectionJudgments: () => rows
    },
    minSamples: 8
  });
  assert.equal(guidance.conditional.total, 8);
  assert.equal(guidance.conditional.winRate, 0.25);
  assert.equal(guidance.slices.byStrengthHour.total, 8);
});

test('recent weak hour regime caps weight without permanently banning the hour', () => {
  const oldWins = Array.from({ length: 12 }, (_, index) => ({
    predictedDirection: 'up',
    lockStrength: 'normal',
    hourBucket: 22,
    correct: true,
    predictedAtIso: `2026-07-${String(10 + Math.floor(index / 4)).padStart(2, '0')}T14:${String(index % 4).padStart(2, '0')}:00.000Z`
  }));
  const recent = Array.from({ length: 12 }, (_, index) => ({
    predictedDirection: 'up',
    lockStrength: 'normal',
    hourBucket: 22,
    correct: index < 4,
    predictedAtIso: `2026-07-${String(14 + Math.floor(index / 4)).padStart(2, '0')}T14:${String(index % 4).padStart(2, '0')}:00.000Z`
  }));
  const guidance = buildJudgmentGuidance({
    judgment: {
      symbol: 'ETH-USD',
      timeframe: '5m',
      predictedDirection: 'up',
      lockStrength: 'normal',
      hourBucket: 22,
      predictedAtIso: '2026-07-16T14:30:00.000Z'
    },
    statsDb: {
      enabled: true,
      getDirectionJudgments: () => [...oldWins, ...recent]
    },
    minSamples: 8
  });
  assert.equal(guidance.hourRegime.active, true);
  assert.equal(guidance.hourRegime.weak, true);
  assert.equal(guidance.hourRegime.sampleCount, 12);
  assert.equal(guidance.suggestedWeight, 0.8);
  assert.match(guidance.note, /最近72小时/);
});
