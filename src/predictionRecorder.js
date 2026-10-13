import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildFiveMinuteDecisionConfig,
  buildFifteenMinuteDecisionConfig,
  adjustLockWithCrossSymbolMajority,
  computePmGap,
  evaluateFiveMinuteLock,
  evaluateDisplayPmLock,
  inferIntervalLockElapsedPct,
  isBackfillEligibleFifteenMinuteLock,
  FIVE_MINUTE_DECISION_LOCK_ELAPSED_PCT,
  FIFTEEN_MINUTE_DECISION_LOCK_ELAPSED_PCT,
  getLockStrength,
  resolveIntervalPmLockEval,
  parseIntervalPmExtraCell,
  parseFiveMinuteExtraCell,
  renderIntervalPmExtraCell,
  renderFiveMinuteExtraCell,
  resolveFiveMinuteSkipReason,
  summarizeFiveMinuteAlignment,
  summarizeFiveMinuteBuckets,
  summarizeFiveMinuteSkipped,
  summarizeIntervalPmBuckets,
  trackPmDirectionStability,
  hasExplicitPmLockMetadata,
  isExplicitPmLockRecord,
  isRepairableFifteenMinuteLegacyLock,
  resolveLockedPolymarketDirection
} from './fiveMinuteDecision.js';

import {
  buildNextSlotPredictionFromLock,
  buildNextSlotPredictionId,
  buildNextSlotPredictionLockConfig,
  evaluateNextSlotPrediction,
  shouldRecordNextSlotPrediction,
  resolvePredictedSlotIsoFromSettledRecord,
  summarizeNextSlotPredictions,
  annotateSameDirectionAsPrev
} from './nextSlotPrediction.js';
import { buildPlan5DirectionDecision } from './polymarketPlan5Direction.js';

const EVALUATION_DELAY_MS = 3000;
const INTERVAL_MINUTES = 15;
const PHASE_MINUTES = 5;
export { FIVE_MINUTE_DECISION_LOCK_ELAPSED_PCT, FIFTEEN_MINUTE_DECISION_LOCK_ELAPSED_PCT };
const PHASES = [
  { key: 'phase1', label: '0-5m' },
  { key: 'phase2', label: '5-10m' },
  { key: 'phase3', label: '10-15m' }
];
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const SHANGHAI_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});
const COMPOSITE_TECH_WEIGHTS = {
  phase1: 0.05,
  phase2: 0.35,
  phase3: 0.5
};
const PREVIOUS_MOVE_REVERSAL_MIN = 0.003;
const PREVIOUS_MOVE_REVERSAL_MAX = 0.005;
const CROSS_SYMBOL_LOCK_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'];
const PREVIOUS_MOVE_REVERSAL_BOOSTS = {
  phase1: 0.04,
  phase2: 0.03,
  phase3: 0.02
};

const TEXT = {
  title: '\u865a\u62df\u5e01\u731c\u8f93\u8d62\u8bb0\u5f55',
  stats: '\u7edf\u8ba1',
  records: '\u8bb0\u5f55',
  item: '\u9879\u76ee',
  value: '\u6570\u503c',
  total: '\u603b\u5224\u65ad\u6b21\u6570',
  correctCount: '\u6b63\u786e\u6b21\u6570',
  wrongCount: '\u9519\u8bef\u6b21\u6570',
  accuracy: '\u6b63\u786e\u7387',
  firstCorrectCount: '\u521d\u59cb\u5224\u65ad\u6b63\u786e\u6b21\u6570',
  firstWrongCount: '\u521d\u59cb\u5224\u65ad\u9519\u8bef\u6b21\u6570',
  firstAccuracy: '\u521d\u59cb\u5224\u65ad\u6b63\u786e\u7387',
  finalCorrectCount: '\u6700\u7ec8\u5224\u65ad\u6b63\u786e\u6b21\u6570',
  finalWrongCount: '\u6700\u7ec8\u5224\u65ad\u9519\u8bef\u6b21\u6570',
  finalAccuracy: '\u6700\u7ec8\u5224\u65ad\u6b63\u786e\u7387',
  polymarketTotal: 'Polymarket \u5224\u65ad\u6b21\u6570',
  polymarketFirstCorrectCount: 'Polymarket \u521d\u59cb\u5224\u65ad\u6b63\u786e\u6b21\u6570',
  polymarketFirstWrongCount: 'Polymarket \u521d\u59cb\u5224\u65ad\u9519\u8bef\u6b21\u6570',
  polymarketFirstAccuracy: 'Polymarket \u521d\u59cb\u5224\u65ad\u6b63\u786e\u7387',
  polymarketFinalCorrectCount: 'Polymarket \u6700\u7ec8\u5224\u65ad\u6b63\u786e\u6b21\u6570',
  polymarketFinalWrongCount: 'Polymarket \u6700\u7ec8\u5224\u65ad\u9519\u8bef\u6b21\u6570',
  polymarketFinalAccuracy: 'Polymarket \u6700\u7ec8\u5224\u65ad\u6b63\u786e\u7387',
  predictedAt: '\u9884\u6d4b\u65f6\u95f4',
  firstPredictedAt: '\u8d77\u59cb\u9884\u6d4b\u65f6\u95f4',
  finalPredictedAt: '\u6700\u540e\u9884\u6d4b\u65f6\u95f4',
  targetAt: '\u622a\u6b62\u65f6\u95f4',
  symbol: '\u5e01\u79cd',
  startPrice: '\u5f00\u59cb\u8ba1\u7b97\u4ef7',
  estimatedClose: '\u9884\u4f30\u622a\u6b62\u4ef7',
  actualClose: '\u5b9e\u9645\u622a\u6b62\u4ef7',
  prediction: '\u5224\u65ad',
  firstPrediction: '\u521d\u59cb\u5224\u65ad',
  finalPrediction: '\u6700\u7ec8\u5224\u65ad',
  polymarketFirstPrediction: 'Polymarket \u521d\u59cb\u5224\u65ad',
  polymarketFirstUpProbability: 'Polymarket \u521d\u59cb UP \u6982\u7387',
  polymarketFirstDownProbability: 'Polymarket \u521d\u59cb DOWN \u6982\u7387',
  polymarketFirstResult: 'Polymarket \u521d\u59cb\u7ed3\u679c',
  polymarketFinalPrediction: 'Polymarket \u6700\u7ec8\u5224\u65ad',
  polymarketFinalUpProbability: 'Polymarket \u6700\u7ec8 UP \u6982\u7387',
  polymarketFinalDownProbability: 'Polymarket \u6700\u7ec8 DOWN \u6982\u7387',
  polymarketFinalResult: 'Polymarket \u6700\u7ec8\u7ed3\u679c',
  polymarketMarket: 'Polymarket \u5e02\u573a',
  phaseTechResults: '15m\u5185\u9636\u6bb5\u6280\u672f\u7ed3\u679c',
  phasePolymarketResults: '15m\u5185\u9636\u6bb5 Polymarket \u7ed3\u679c',
  phaseCompositeResults: '15m\u5185\u9636\u6bb5\u7efc\u5408\u7ed3\u679c',
  upProbability: '\u4e0a\u6da8\u6982\u7387',
  downProbability: '\u4e0b\u8dcc\u6982\u7387',
  firstUpProbability: '\u521d\u59cb\u4e0a\u6da8\u6982\u7387',
  firstDownProbability: '\u521d\u59cb\u4e0b\u8dcc\u6982\u7387',
  finalUpProbability: '\u6700\u7ec8\u4e0a\u6da8\u6982\u7387',
  finalDownProbability: '\u6700\u7ec8\u4e0b\u8dcc\u6982\u7387',
  directionFlips: '\u65b9\u5411\u7ffb\u8f6c\u6b21\u6570',
  sampleCount: '\u8ba1\u7b97\u6b21\u6570',
  actual: '\u5b9e\u9645',
  recentActualDirections: '\u524d3\u683915m\u5b9e\u9645\u65b9\u5411',
  fiveMinuteExtra: 'PM\u9501\u5b9a\u6269\u5c55',
  result: '\u7ed3\u679c',
  firstResult: '\u521d\u59cb\u7ed3\u679c',
  finalResult: '\u6700\u7ec8\u7ed3\u679c',
  predictedMove: '\u9884\u6d4b\u6da8\u8dcc',
  actualMove: '\u5b9e\u9645\u6da8\u8dcc',
  confidence: '\u7f6e\u4fe1\u5ea6',
  up: '\u4e0a\u6da8',
  down: '\u4e0b\u8dcc',
  correct: '\u6b63\u786e',
  wrong: '\u9519\u8bef'
};

export class PredictionRecorder {
  constructor({
    recordDir,
    fetchQuotes,
    fetchClosePrice = null,
    fetchWindowPrices = null,
    readPolymarketPaperSummary = null,
    enabled = true,
    symbols = ['BTC-USD'],
    fiveMinuteConfig = null,
    fifteenMinuteConfig = null,
    statsDb = null,
    plan5Config = null,
    windowSnapshotIntervalMs = Number(process.env.POLYMARKET_WINDOW_SNAPSHOT_MS ?? 15000)
  }) {
    this.windowSnapshotIntervalMs = Number(windowSnapshotIntervalMs) || 0;
    this.lastSnapshotAt = new Map();
    this.recordDir = recordDir;
    this.fetchQuotes = fetchQuotes;
    this.fetchClosePrice = fetchClosePrice;
    this.fetchWindowPrices = fetchWindowPrices;
    this.readPolymarketPaperSummary = readPolymarketPaperSummary;
    this.fiveMinuteConfig = fiveMinuteConfig || buildFiveMinuteDecisionConfig();
    this.fifteenMinuteConfig = fifteenMinuteConfig || buildFifteenMinuteDecisionConfig();
    this.nextSlotPredictionLockConfig5m = buildNextSlotPredictionLockConfig('5m');
    this.nextSlotPredictionLockConfig15m = buildNextSlotPredictionLockConfig('15m');
    this.statsDb = statsDb;
    this.plan5Config = plan5Config || {};
    this.enabled = enabled && Boolean(recordDir);
    this.symbols = new Set(symbols.map((symbol) => symbol.toUpperCase()));
    this.pending = new Map();
    this.timers = new Map();
    this.completed = new Set();
    this.lockStrengthStatsCache = new Map();
  }

  track(signals, generatedAt = new Date().toISOString()) {
    if (!this.enabled) return;

    for (const signal of signals || []) {
      if (!signal?.prediction) continue;
      if (!this.symbols.has(signal.symbol.toUpperCase())) continue;
      const key = recordKey(signal.symbol, signal.prediction.targetTimeIso, resolveSignalTimeframe(signal));
      if (this.completed.has(key)) continue;
      this.maybeRecordWindowSnapshot(key, signal, generatedAt);
      const update = signalToUpdate(signal, generatedAt);
      const existing = this.pending.get(key);
      const direction = signal.direction;
      const fiveMinuteConfig = this.fiveMinuteConfig;
      const fifteenMinuteConfig = this.fifteenMinuteConfig;
      const lockConfig = resolveSignalTimeframe(signal) === '5m' ? fiveMinuteConfig : fifteenMinuteConfig;

      const pmDirection = update.polymarket?.predictedDirection;
      const shouldTrack = ['up', 'down'].includes(direction)
        || ['up', 'down'].includes(pmDirection);

      if (shouldTrack) {
        const next = existing
          ? updatePendingRecord(existing, update, lockConfig)
          : createPendingRecord(key, update, lockConfig);
        this.pending.set(key, next);
        // 下轮预测：晚于普通锁；达阈值后幂等写入一次，不随 PM 抖动改方向
        this.maybeEmitNextSlotPrediction(next);
        this.schedule(key, signal.prediction.targetTimeIso);
      }
    }
  }

  // Unconditional intra-window price path: calibration from lock-moment rows only
  // describes the recorder's lock population, not arbitrary entry times.
  maybeRecordWindowSnapshot(key, signal, generatedAt) {
    if (!this.statsDb?.recordWindowSnapshot || !(this.windowSnapshotIntervalMs > 0)) return;
    const pm = signal.polymarket;
    if (!pm?.available) return;
    const nowMs = Date.parse(generatedAt) || Date.now();
    const last = this.lastSnapshotAt.get(key) || 0;
    if (nowMs - last < this.windowSnapshotIntervalMs) return;
    const timeframe = resolveSignalTimeframe(signal);
    const slotMs = (timeframe === '5m' ? 5 : 15) * 60_000;
    const targetMs = Date.parse(signal.prediction.targetTimeIso);
    if (!Number.isFinite(targetMs) || nowMs >= targetMs) return;
    const elapsedPct = Math.min(1, Math.max(0, 1 - (targetMs - nowMs) / slotMs));
    this.lastSnapshotAt.set(key, nowMs);
    if (this.lastSnapshotAt.size > 512) {
      for (const [k, at] of this.lastSnapshotAt) if (nowMs - at > 30 * 60_000) this.lastSnapshotAt.delete(k);
    }
    this.statsDb.recordWindowSnapshot({
      timeframe,
      symbol: signal.symbol,
      targetTimeIso: signal.prediction.targetTimeIso,
      observedAtIso: new Date(nowMs).toISOString(),
      elapsedPct,
      upPrice: pm.upPrice,
      downPrice: pm.downPrice,
      upAsk: pm.upBestAsk,
      downAsk: pm.downBestAsk,
      upSpread: pm.upSpread ?? pm.upBookSpread,
      downSpread: pm.downSpread ?? pm.downBookSpread,
      spotPrice: signal.indicators?.currentPrice,
      slotOpenPrice: signal.indicators?.slotStartPrice ?? signal.prediction?.comparisonBasePrice,
      quality: pm.qualityScore
    });
  }

  getLockedFiveMinuteDecision(symbol, targetTimeIso) {
    return this.getLockedIntervalPmDecision(symbol, targetTimeIso, '5m');
  }

  getLockedFifteenMinuteDecision(symbol, targetTimeIso) {
    return this.getLockedIntervalPmDecision(symbol, targetTimeIso, '15m');
  }

  applyCrossSymbolMajority(lock, symbol, targetTimeIso, timeframe) {
    if (this.plan5Config.plan5CrossSymbolMajorityEnabled === false) return lock;
    if (timeframe !== '5m' || !CROSS_SYMBOL_LOCK_SYMBOLS.includes(String(symbol).toUpperCase())) {
      return lock;
    }
    const peerLocks = CROSS_SYMBOL_LOCK_SYMBOLS.flatMap((peerSymbol) => {
      const peer = this.pending.get(recordKey(peerSymbol, targetTimeIso, timeframe));
      // Prefer the direction already shown/consumed by Plan5.  The raw PM lock
      // can differ after magnitude-aware optimization, which is exactly where
      // a displayed 3:1 split must be judged as a group.
      const direction = peer?.optimizedPlan5Lock?.direction
        || resolveLockedPolymarketDirection(peer);
      if (!peer?.decisionLocked || !direction) return [];
      const up = Number(peer.optimizedPlan5Lock?.upProbability
        ?? peer.lockedPolymarketUpProbability
        ?? peer.polymarketUpProbability);
      const down = Number(peer.optimizedPlan5Lock?.downProbability
        ?? peer.lockedPolymarketDownProbability
        ?? peer.polymarketDownProbability);
      return [{
        symbol: peerSymbol,
        direction,
        strength: peer.optimizedPlan5Lock?.lockStrength || peer.lockStrength || 'weak',
        confidence: Math.max(Number.isFinite(up) ? up : 0, Number.isFinite(down) ? down : 0)
      }];
    });
    return adjustLockWithCrossSymbolMajority(lock, peerLocks);
  }

  getLockedIntervalPmDecision(symbol, targetTimeIso, timeframe = '5m') {
    if (!symbol || !targetTimeIso) return null;
    const key = recordKey(symbol, targetTimeIso, timeframe);
    const pending = this.pending.get(key);
    const direction = resolveLockedPolymarketDirection(pending);
    if (!pending?.decisionLocked || !direction) return null;
    const up = Number(pending.lockedPolymarketUpProbability ?? pending.polymarketUpProbability);
    const down = Number(pending.lockedPolymarketDownProbability ?? pending.polymarketDownProbability);
    const currentUp = Number(pending.latestPolymarketUpProbability ?? up);
    const currentDown = Number(pending.latestPolymarketDownProbability ?? down);
    const pmGap = Number.isFinite(Number(pending.lockedPmGap))
      ? Number(pending.lockedPmGap)
      : computePmGap(up, down);
    const strength = pending.lockStrength || 'weak';
    const baseLock = {
      source: pending.lockSource || 'polymarket',
      direction,
      strength,
      pmGap: Number.isFinite(pmGap) ? pmGap : null,
      confidence: Math.max(
        Number.isFinite(up) ? up : 0,
        Number.isFinite(down) ? down : 0
      ),
      upProbability: Number.isFinite(up) ? up : null,
      downProbability: Number.isFinite(down) ? down : null,
      lockedAtIso: pending.decisionLockedAtIso || pending.predictedAtIso,
      lockReason: pending.lockReason || null,
      hourPolicy: pending.lockHourPolicy || null
    };
    if (this.plan5Config.plan5LockDirectionOptimizationEnabled !== true) {
      return this.applyCrossSymbolMajority(baseLock, symbol, targetTimeIso, timeframe);
    }
    if (pending.optimizedPlan5Lock) {
      return this.applyCrossSymbolMajority(
        pending.optimizedPlan5Lock,
        symbol,
        targetTimeIso,
        timeframe
      );
    }

    const lookbackDays = Math.max(1, Number(this.plan5Config.plan5DirectionLookbackDays) || 30);
    const orders = typeof this.statsDb?.getLossReasonOrders === 'function'
      ? this.statsDb.getLossReasonOrders({
        planId: 'plan5',
        lookbackDays,
        source: 'live',
        timeframe
      })
      : [];
    const optimization = buildPlan5DirectionDecision({
      lock: baseLock,
      sentiment: {
        upPrice: Number.isFinite(currentUp) ? currentUp : null,
        downPrice: Number.isFinite(currentDown) ? currentDown : null
      },
      symbol,
      timeframe,
      targetTimeIso,
      statsDb: this.statsDb,
      orders,
      marketState: {
        startPrice: Number(pending.lockedStartPrice ?? pending.startPrice),
        currentPrice: Number(pending.lockedCurrentPrice ?? pending.currentPrice),
        elapsedPct: Number(pending.lockElapsedPct ?? pending.lastElapsedInCurrentSlotPct),
        previousClosedCandleMovePct: Number(
          pending.lockedPreviousClosedCandleMovePct ?? pending.previousClosedCandleMovePct
        ),
        return3Pct: Number(pending.lockedReturn3Pct ?? pending.return3Pct),
        return6Pct: Number(pending.lockedReturn6Pct ?? pending.return6Pct),
        volatilityPct: Number(pending.lockedVolatilityPct ?? pending.volatilityPct),
        recentClosedCandleMovesPct: pending.lockedRecentClosedCandleMovesPct
          ?? pending.recentClosedCandleMovesPct
          ?? []
      },
      config: this.plan5Config,
      now: new Date(pending.decisionLockedAtIso || pending.predictedAtIso || Date.now())
    });
    if (!optimization.allowed) {
      // A raw PM threshold is not a final direction lock until the calibrated
      // probability clears the executable price. Do not cache this result:
      // later quotes in the same window may become eligible.
      return this.applyCrossSymbolMajority({
        ...baseLock,
        eligible: false,
        optimizationBlocked: true,
        optimization
      }, symbol, targetTimeIso, timeframe);
    }
    const optimized = {
      ...baseLock,
      direction: optimization.direction,
      confidence: Number.isFinite(Number(optimization.probability))
        ? Number(optimization.probability)
        : baseLock.confidence,
      upProbability: Number.isFinite(Number(optimization.upProbability))
        ? Number(optimization.upProbability)
        : baseLock.upProbability,
      downProbability: Number.isFinite(Number(optimization.downProbability))
        ? Number(optimization.downProbability)
        : baseLock.downProbability,
      lockReason: `${baseLock.lockReason || 'pm_lock'}+${optimization.directionModel || 'strength_direction'}`,
      optimization
    };
    // Cache one final magnitude-aware direction. Plan5 consumes the lock and
    // remains responsible for order size.
    pending.optimizedPlan5Lock = optimized;
    this.pending.set(key, pending);
    return this.applyCrossSymbolMajority(optimized, symbol, targetTimeIso, timeframe);
  }

  schedule(key, targetTimeIso) {
    if (this.timers.has(key)) return;
    const delay = Math.max(1000, Date.parse(targetTimeIso) - Date.now() + EVALUATION_DELAY_MS);
    const timer = setTimeout(() => {
      this.evaluate(key).catch((error) => {
        console.error(`Prediction record failed for ${key}: ${error.message}`);
      });
    }, delay);
    this.timers.set(key, timer);
  }

  async evaluate(key) {
    if (this.completed.has(key)) return;
    const pending = this.pending.get(key);
    if (!pending) return;

    const existingTimer = this.timers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    this.timers.delete(key);
    try {
      let resolvedPending = pending;
      const lockConfig = resolvedPending.timeframe === '5m'
        ? this.fiveMinuteConfig
        : this.fifteenMinuteConfig;
      if (resolvedPending.timeframe === '5m' && !resolvedPending.decisionLocked) {
        resolvedPending = finalizeFiveMinutePending(resolvedPending, lockConfig);
        if (!resolvedPending) {
          this.pending.delete(key);
          return;
        }
      }
      if (resolvedPending.timeframe === '15m' && !resolvedPending.decisionLocked) {
        resolvedPending = finalizeFifteenMinutePending(resolvedPending, lockConfig);
      }

      let actualPrice;
      let actualMovePct;
      let actualDirection;
      let slotOpenPrice = resolvedPending.slotOpenPrice ?? resolvedPending.startPrice;
      let slotClosePrice = resolvedPending.slotClosePrice ?? null;
      let priceSource = resolvedPending.priceSource || null;

      if (resolvedPending.timeframe === '5m' && this.fetchWindowPrices) {
        try {
          const windowPrices = await this.fetchWindowPrices(resolvedPending.symbol, resolvedPending.targetTimeIso, '5m');
          slotOpenPrice = windowPrices.startPrice;
          slotClosePrice = windowPrices.actualClose;
          actualPrice = windowPrices.actualClose;
          actualMovePct = actualPrice / slotOpenPrice - 1;
          actualDirection = windowPrices.actualDirection || (actualMovePct >= 0 ? 'up' : 'down');
          priceSource = 'binance-5m';
        } catch (error) {
          console.error(`5m window price failed for ${resolvedPending.symbol}: ${error.message}`);
          actualPrice = await this.resolveActualPrice(resolvedPending);
          if (!Number.isFinite(actualPrice) || actualPrice <= 0) {
            throw new Error(`No actual price for ${pending.symbol}`);
          }
          actualMovePct = actualPrice / resolvedPending.startPrice - 1;
          actualDirection = actualMovePct >= 0 ? 'up' : 'down';
          priceSource = 'fallback-quote';
        }
      } else {
        actualPrice = await this.resolveActualPrice(resolvedPending);
        if (!Number.isFinite(actualPrice) || actualPrice <= 0) {
          throw new Error(`No actual price for ${pending.symbol}`);
        }
        actualMovePct = actualPrice / resolvedPending.startPrice - 1;
        actualDirection = actualMovePct >= 0 ? 'up' : 'down';
      }

      const lockedPmDirection = resolveLockedPolymarketDirection(resolvedPending);
      const techDirection = resolvedPending.lockedTechDirection || resolvedPending.lastTechDirection || null;
      const compositeDirection = resolvedPending.lockedCompositeDirection || resolvedPending.lastCompositeDirection || null;
      const firstCorrect = actualDirection === resolvedPending.firstPredictedDirection;
      const correct = actualDirection === resolvedPending.predictedDirection;
      const firstPolymarketCorrect = resolvedPending.firstPolymarketPredictedDirection
        ? actualDirection === resolvedPending.firstPolymarketPredictedDirection
        : null;
      const polymarketCorrect = lockedPmDirection
        ? actualDirection === lockedPmDirection
        : null;
      const techCorrect = techDirection ? actualDirection === techDirection : null;
      const compositeCorrect = compositeDirection ? actualDirection === compositeDirection : null;
      const skipReason = resolvedPending.skipReason
        || (!resolvedPending.decisionLocked ? resolveFiveMinuteSkipReason(resolvedPending, lockConfig) : null);
      const phaseChecks = evaluatePhaseChecks(resolvedPending.phaseChecks, actualDirection);

      await this.writeRecord({
        ...resolvedPending,
        evaluatedAtIso: new Date().toISOString(),
        startPrice: slotOpenPrice,
        slotOpenPrice,
        slotClosePrice: slotClosePrice ?? actualPrice,
        actualPrice,
        actualMovePct,
        actualDirection,
        priceSource,
        firstCorrect,
        correct,
        firstPolymarketCorrect,
        polymarketCorrect,
        techCorrect,
        compositeCorrect,
        skipReason,
        phaseChecks
      });
      this.pending.delete(key);
      this.completed.add(key);
    } catch (error) {
      const timer = setTimeout(() => {
        this.evaluate(key).catch((retryError) => {
          console.error(`Prediction record retry failed for ${key}: ${retryError.message}`);
        });
      }, 10000);
      this.timers.set(key, timer);
      throw error;
    }
  }

  async writeRecord(record) {
    try {
      this.statsDb?.recordWindowLock(record);
    } catch (error) {
      console.error(`Stats DB window lock sync failed for ${record?.id}: ${error.message}`);
    }
    try {
      if (record?.actualDirection && record?.targetTimeIso) {
        this.statsDb?.settleDirectionJudgmentsForTarget({
          targetTimeIso: record.targetTimeIso,
          timeframe: record.timeframe === '15m' ? '15m' : '5m',
          actualDirection: record.actualDirection,
          evaluatedAtIso: record.evaluatedAtIso || new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`Stats DB direction judgment settle failed for ${record?.id}: ${error.message}`);
    }
    try {
      // 结算前硬截止：已有普通 PM 方向则强制写入下轮预测，避免窗口结束仍无预测。
      this.maybeEmitNextSlotPrediction(record, { forceSettlement: true });
      this.evaluateNextSlotPredictionsForSettled(record);
    } catch (error) {
      console.error(`Next-slot prediction sync failed for ${record?.id}: ${error.message}`);
    }
    await mkdir(this.recordDir, { recursive: true });
    const date = formatShanghaiDate(record.targetTimeIso);
    const filePath = join(this.recordDir, `${date}.md`);
    const existing = await readTextIfExists(filePath);
    const parsed = parseRecords(existing);
    const rawRowCount = countPredictionRecordRows(existing);
    if (rawRowCount > parsed.length + 1) {
      console.error(
        `writeRecord ${record.id}: parsed ${parsed.length}/${rawRowCount} prediction rows before merge`
      );
    }
    const records = parsed.filter((item) => item.id !== record.id);
    records.push(record);
    records.sort((a, b) => a.targetTimeIso.localeCompare(b.targetTimeIso) || a.symbol.localeCompare(b.symbol));
    const polymarketPaper = await this.loadPolymarketPaperSummary(date);
    await writeFile(filePath, renderDailyMarkdown(date, withRecentActualDirections(records), { polymarketPaper }), 'utf8');
    await this.writePolymarketDetailMarkdown(date, polymarketPaper);
  }

  async resolveActualPrice(pending) {
    if (this.fetchClosePrice) {
      try {
        return await this.fetchClosePrice(pending.symbol, pending.targetTimeIso);
      } catch (error) {
        console.error(`Closed candle price failed for ${pending.symbol}: ${error.message}`);
      }
    }
    const quotes = await this.fetchQuotes([pending.symbol]);
    const quote = Array.isArray(quotes) ? quotes[0] : null;
    return quotePrice(quote);
  }

  async readDailySummary(date = new Date()) {
    if (!this.enabled) {
      return dailySummary(formatShanghaiDate(date), []);
    }
    const day = formatShanghaiDate(date);
    const filePath = join(this.recordDir, `${day}.md`);
    const records = withPhaseFallbacks(withRecentActualDirections(parseRecords(await readTextIfExists(filePath))));
    const intervalLockSummary = await this.readIntervalPmLockSummary({ preferSqlite: true });
    const nextSlotPredictionSummary = this.getNextSlotPredictionSummary();
    return {
      ...dailySummary(day, records),
      intervalLockSummary,
      nextSlotPredictionSummary,
      polymarketPaper: await this.loadPolymarketPaperSummary(day)
    };
  }

  async readIntervalPmLockSummary({ lookbackDays = 14, preferSqlite = true } = {}) {
    if (!this.enabled) {
      return {
        lookbackDays,
        fiveMinute: summarizeStandaloneTimeframe([]),
        fifteenMinute: summarizeFifteenMinuteLocks([])
      };
    }
    // 胜率页等高频接口：只读 SQLite，避免每次扫 14 天 markdown（可达数 MB）把整站拖死
    if (preferSqlite && this.statsDb?.enabled) {
      const records5m = this.statsDb.getLockRecords({ timeframe: '5m', lookbackDays }) || [];
      const records15m = this.statsDb.getLockRecords({ timeframe: '15m', lookbackDays }) || [];
      return {
        lookbackDays,
        fiveMinute: summarizeStandaloneTimeframe(records5m),
        fifteenMinute: summarizeFifteenMinuteLocks(records15m),
        nextSlotPrediction: this.getNextSlotPredictionSummary({ lookbackDays }),
        source: 'sqlite'
      };
    }
    const records = await this.readRecordsInLookback(lookbackDays);
    const records5m = this.mergeLockRecordsWithStatsDb(
      records.filter((item) => resolveRecordTimeframe(item) === '5m'),
      '5m',
      lookbackDays
    );
    const records15m = this.mergeLockRecordsWithStatsDb(
      records.filter((item) => resolveRecordTimeframe(item) === '15m'),
      '15m',
      lookbackDays
    );
    return {
      lookbackDays,
      fiveMinute: summarizeStandaloneTimeframe(records5m),
      fifteenMinute: summarizeFifteenMinuteLocks(records15m),
      nextSlotPrediction: this.getNextSlotPredictionSummary({ lookbackDays }),
      source: 'markdown+sqlite'
    };
  }

  resolveNextSlotPredictionLockConfig(timeframe = '5m') {
    return timeframe === '15m'
      ? this.nextSlotPredictionLockConfig15m
      : this.nextSlotPredictionLockConfig5m;
  }

  maybeEmitNextSlotPrediction(record, options = {}) {
    if (!record?.decisionLocked) return null;
    const config = this.resolveNextSlotPredictionLockConfig(record.timeframe);
    const forceSettlement = options.forceSettlement === true;
    if (!shouldRecordNextSlotPrediction(record, { config, forceSettlement })) return null;
    return this.emitNextSlotPredictionFromLock(record, {
      predictionLockConfig: config,
      forceSettlement,
      elapsedPct: options.elapsedPct,
      force: options.force === true
    });
  }

  emitNextSlotPredictionFromLock(record, options = {}) {
    try {
      const prediction = buildNextSlotPredictionFromLock(record, new Date().toISOString(), {
        predictionLockConfig: options.predictionLockConfig
          || this.resolveNextSlotPredictionLockConfig(record?.timeframe),
        elapsedPct: options.elapsedPct,
        force: options.force === true,
        forceSettlement: options.forceSettlement === true
      });
      if (!prediction) return null;
      // Idempotent: once a row exists for this source key, never change predictedDirection.
      const existing = this.statsDb?.getNextSlotPrediction?.(prediction.id);
      if (existing?.predictedDirection) {
        if (existing.correct != null) return existing;
        // Already locked pending — keep original direction/strength metadata.
        return existing;
      }
      const annotated = this.annotateNextSlotContinuity(prediction);
      this.statsDb?.recordNextSlotPrediction?.(annotated);
      return annotated;
    } catch (error) {
      console.error(`emitNextSlotPredictionFromLock failed: ${error.message}`);
      return null;
    }
  }

  /**
   * 上一笔 = 预测了本源窗的那条（predicted_slot_iso === source_slot_iso）。
   * 用于标记 sameDirectionAsPrev（连续同向 vs 反向/首单）。
   */
  annotateNextSlotContinuity(prediction) {
    if (!prediction) return prediction;
    if (prediction.sameDirectionAsPrev === true || prediction.sameDirectionAsPrev === false) {
      return {
        ...prediction,
        continuity: prediction.sameDirectionAsPrev ? 'same' : 'flip'
      };
    }
    const previous = this.findPreviousNextSlotPrediction(prediction);
    return annotateSameDirectionAsPrev(prediction, previous);
  }

  findPreviousNextSlotPrediction(prediction) {
    if (!prediction?.sourceSlotIso || !this.statsDb?.enabled) return null;
    try {
      const tf = prediction.sourceTimeframe === '15m' ? '15m' : '5m';
      const symbol = String(prediction.symbol || 'BTC-USD').toUpperCase();
      // Prefer exact: prediction that targeted this source slot.
      const pendingOrDone = this.statsDb.getPendingNextSlotPredictions({
        predictedSlotIso: prediction.sourceSlotIso,
        timeframe: tf
      }) || [];
      const allForSlot = [
        ...pendingOrDone,
        ...(this.statsDb.getNextSlotPredictions({ lookbackDays: 7, timeframe: tf, symbol }) || [])
          .filter((row) => row.predictedSlotIso === prediction.sourceSlotIso)
      ];
      const match = allForSlot.find((row) => String(row.symbol || 'BTC-USD').toUpperCase() === symbol);
      if (match) return match;
      // Fallback: previous adjacent source slot id.
      const prevSourceMs = Date.parse(prediction.sourceSlotIso);
      if (!Number.isFinite(prevSourceMs)) return null;
      const minutes = tf === '15m' ? 15 : 5;
      const prevSourceIso = new Date(prevSourceMs - minutes * 60_000).toISOString();
      return this.getNextSlotPredictionForSource({
        sourceSlotIso: prevSourceIso,
        timeframe: tf,
        symbol
      });
    } catch (error) {
      console.error(`findPreviousNextSlotPrediction failed: ${error.message}`);
      return null;
    }
  }

  /** 预测「下一窗」的活跃记录（当前窗作为 source 写出的那条）。 */
  getActiveNextSlotPrediction({ currentSlotIso, timeframe = '5m', symbol = 'BTC-USD' } = {}) {
    if (!currentSlotIso) return null;
    const tf = timeframe === '15m' ? '15m' : '5m';
    const fromCurrent = this.getNextSlotPredictionForSource({
      sourceSlotIso: currentSlotIso,
      timeframe: tf,
      symbol
    });
    if (fromCurrent?.predictedDirection) return fromCurrent;
    return null;
  }

  /** 预测「当前窗」的记录（上一窗 source 写出、predicted_slot = current）。 */
  getIncomingNextSlotPrediction({ currentSlotIso, timeframe = '5m', symbol = 'BTC-USD' } = {}) {
    if (!currentSlotIso || !this.statsDb?.enabled) return null;
    try {
      const tf = timeframe === '15m' ? '15m' : '5m';
      const normalized = String(symbol || 'BTC-USD').toUpperCase();
      const rows = this.statsDb.getPendingNextSlotPredictions({
        predictedSlotIso: currentSlotIso,
        timeframe: tf
      }) || [];
      const pending = rows.find((row) => String(row.symbol || 'BTC-USD').toUpperCase() === normalized);
      if (pending) return pending;
      const recent = this.statsDb.getNextSlotPredictions({ lookbackDays: 3, timeframe: tf, symbol: normalized }) || [];
      return recent.find((row) => row.predictedSlotIso === currentSlotIso) || null;
    } catch (error) {
      console.error(`getIncomingNextSlotPrediction failed: ${error.message}`);
      return null;
    }
  }

  getNextSlotPredictionSummary({ lookbackDays = 14, symbol = null, timeframe = null } = {}) {
    const empty = {
      lookbackDays,
      ...summarizeNextSlotPredictions([]),
      latestByTimeframe: { '5m': null, '15m': null }
    };
    if (!this.statsDb?.enabled) return empty;
    try {
      const predictions = this.statsDb.getNextSlotPredictions({ lookbackDays, symbol, timeframe }) || [];
      return {
        lookbackDays,
        ...summarizeNextSlotPredictions(predictions),
        latestByTimeframe: {
          '5m': pickLatestNextSlotPrediction(predictions, '5m'),
          '15m': pickLatestNextSlotPrediction(predictions, '15m')
        }
      };
    } catch (error) {
      console.error(`getNextSlotPredictionSummary failed: ${error.message}`);
      return empty;
    }
  }

  evaluateNextSlotPredictionsForSettled(record) {
    if (!record || !['up', 'down'].includes(record.actualDirection)) return [];
    if (!this.statsDb?.enabled) return [];
    try {
      const predictedSlotIso = resolvePredictedSlotIsoFromSettledRecord(record);
      const timeframe = record.timeframe === '15m' ? '15m' : '5m';
      if (!predictedSlotIso) return [];
      const pending = this.statsDb.getPendingNextSlotPredictions({
        predictedSlotIso,
        timeframe
      }) || [];
      const evaluated = [];
      for (const prediction of pending) {
        const next = evaluateNextSlotPrediction(prediction, record.actualDirection, {
          evaluatedAtIso: record.evaluatedAtIso || new Date().toISOString(),
          evaluationSource: 'window_actual'
        });
        if (!next) continue;
        this.statsDb.recordNextSlotPrediction(next);
        evaluated.push(next);
      }
      return evaluated;
    } catch (error) {
      console.error(`evaluateNextSlotPredictionsForSettled failed: ${error.message}`);
      return [];
    }
  }

  getNextSlotPredictionForSource({ sourceSlotIso, timeframe = '5m', symbol = 'BTC-USD' } = {}) {
    if (!sourceSlotIso || !this.statsDb?.enabled) return null;
    try {
      const id = buildNextSlotPredictionId({
        sourceTimeframe: timeframe,
        sourceSlotIso,
        symbol
      });
      return this.statsDb.getNextSlotPrediction(id) || null;
    } catch (error) {
      console.error(`getNextSlotPredictionForSource failed: ${error.message}`);
      return null;
    }
  }

  async getFiveMinuteLockStrengthStats({ lookbackDays = 14, symbol = null, preferSqlite = true } = {}) {
    if (!this.enabled) {
      return {};
    }
    const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
    // 热路径默认只读 SQLite window_locks，避免每次扫 14 天 markdown
    if (preferSqlite && this.statsDb?.enabled) {
      const records5m = (this.statsDb.getLockRecords({
        timeframe: '5m',
        lookbackDays,
        symbol: normalizedSymbol
      }) || []).filter((item) => (
        !normalizedSymbol || String(item.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol
      ));
      return summarizeFiveMinuteBuckets(records5m).strength || {};
    }
    const records = await this.readRecordsInLookback(lookbackDays);
    const records5m = this.mergeLockRecordsWithStatsDb(
      records.filter((item) => (
        resolveRecordTimeframe(item) === '5m'
        && (!normalizedSymbol || String(item.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol)
      )),
      '5m',
      lookbackDays,
      normalizedSymbol
    );
    return summarizeFiveMinuteBuckets(records5m).strength || {};
  }

  /** Plan5 / 仪表盘：按周期返回弱/普/强锁定历史胜率。 */
  async getLockStrengthStats({ timeframe = '5m', lookbackDays = 14, symbol = null, preferSqlite = true } = {}) {
    if (!this.enabled) return {};
    const tf = timeframe === '15m' ? '15m' : '5m';
    const normalizedSymbol = symbol ? String(symbol).toUpperCase() : null;
    const cacheKey = `${tf}|${Math.max(1, Number(lookbackDays) || 14)}|${normalizedSymbol || 'all'}|${preferSqlite}`;
    const cached = this.lockStrengthStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    if (preferSqlite && this.statsDb?.enabled) {
      const filtered = (this.statsDb.getLockRecords({
        timeframe: tf,
        lookbackDays,
        symbol: normalizedSymbol
      }) || []).filter((item) => (
        !normalizedSymbol || String(item.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol
      ));
      if (tf === '15m') {
        const value = summarizeIntervalPmBuckets(filtered, 900).strength || {};
        this.lockStrengthStatsCache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
      const value = summarizeFiveMinuteBuckets(filtered).strength || {};
      this.lockStrengthStatsCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    const records = await this.readRecordsInLookback(lookbackDays);
    const filtered = this.mergeLockRecordsWithStatsDb(
      records.filter((item) => (
        resolveRecordTimeframe(item) === tf
        && (!normalizedSymbol || String(item.symbol || 'BTC-USD').toUpperCase() === normalizedSymbol)
      )),
      tf,
      lookbackDays,
      normalizedSymbol
    );
    if (tf === '15m') {
      const value = summarizeIntervalPmBuckets(filtered, 900).strength || {};
      this.lockStrengthStatsCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    const value = summarizeFiveMinuteBuckets(filtered).strength || {};
    this.lockStrengthStatsCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  /** markdown 解析结果与统计库按 id 合并：markdown 丢行/损坏时由数据库兜底。 */
  mergeLockRecordsWithStatsDb(records, timeframe, lookbackDays, symbol = null) {
    if (!this.statsDb?.enabled) return records;
    try {
      const dbRecords = this.statsDb.getLockRecords({ timeframe, lookbackDays, symbol });
      if (!dbRecords.length) return records;
      const seen = new Set(records.map((item) => item.id));
      return records.concat(dbRecords.filter((item) => item.id && !seen.has(item.id)));
    } catch (error) {
      console.error(`Stats DB lock merge failed: ${error.message}`);
      return records;
    }
  }

  async readRecordsInLookback(lookbackDays = 14) {
    await mkdir(this.recordDir, { recursive: true });
    const files = await readdir(this.recordDir).catch(() => []);
    const dailyFiles = files
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(1, Number(lookbackDays) || 14));
    const records = [];
    for (const file of dailyFiles) {
      records.push(...parseRecords(await readTextIfExists(join(this.recordDir, file))));
    }
    return withPhaseFallbacks(withRecentActualDirections(records));
  }

  async refreshDailyMarkdown(date = new Date()) {
    if (!this.enabled) return;
    const day = formatShanghaiDate(date);
    const filePath = join(this.recordDir, `${day}.md`);
    const existing = await readTextIfExists(filePath);
    const parsed = parseRecords(existing);
    const rawRowCount = countPredictionRecordRows(existing);
    if (rawRowCount > parsed.length + 1) {
      console.error(
        `refreshDailyMarkdown ${day}: parsed ${parsed.length}/${rawRowCount} prediction rows; skip rewrite to avoid data loss`
      );
      return;
    }
    const records = withPhaseFallbacks(withRecentActualDirections(parsed));
    const polymarketPaper = await this.loadPolymarketPaperSummary(day);
    if (!records.length && !polymarketPaper?.orders?.length && !polymarketPaper?.liveOrders?.length) return;
    await mkdir(this.recordDir, { recursive: true });
    await writeFile(filePath, renderDailyMarkdown(day, records, { polymarketPaper }), 'utf8');
    await this.writePolymarketDetailMarkdown(day, polymarketPaper);
  }

  async writePolymarketDetailMarkdown(date, polymarketPaper) {
    if (!polymarketPaper) return;
    await writePolymarketDetailMarkdown(this.recordDir, date, polymarketPaper);
  }

  async loadPolymarketPaperSummary(date) {
    if (typeof this.readPolymarketPaperSummary !== 'function') return null;
    try {
      return await this.readPolymarketPaperSummary(date);
    } catch (error) {
      console.error(`Polymarket paper summary failed: ${error.message}`);
      return null;
    }
  }

  async readStrategyRiskSummary({ preferSqlite = true } = {}) {
    if (!this.enabled) return buildStrategyRiskSummary([]);
    // 热路径：优先返回短缓存，避免每次扫全量 markdown 拖死 live/paper tick
    const nowMs = Date.now();
    if (
      this._strategyRiskCache?.payload
      && (nowMs - Number(this._strategyRiskCache.at || 0)) < 60_000
    ) {
      return this._strategyRiskCache.payload;
    }
    if (this._strategyRiskInflight) return this._strategyRiskInflight;
    this._strategyRiskInflight = (async () => {
      try {
        // phaseChecks 仍主要在 MD；SQLite 不足时用缓存/空摘要，不阻塞 tick
        if (preferSqlite && this.statsDb?.enabled) {
          const locks = [
            ...(this.statsDb.getLockRecords({ timeframe: '15m', lookbackDays: 30 }) || [])
          ];
          // 无 phaseChecks 时返回轻量空策略行，避免扫 MD；完整 MD 仅冷路径/缓存过期后低频重建
          if (!locks.length && this._strategyRiskCache?.payload) {
            return this._strategyRiskCache.payload;
          }
        }
        const records = await this.readAllCompletedRecords();
        const payload = buildStrategyRiskSummary(records);
        this._strategyRiskCache = { at: Date.now(), payload };
        return payload;
      } finally {
        this._strategyRiskInflight = null;
      }
    })();
    return this._strategyRiskInflight;
  }

  async readAllCompletedRecords() {
    await mkdir(this.recordDir, { recursive: true });
    const files = await readdir(this.recordDir).catch(() => []);
    const markdownFiles = files.filter((file) => file.endsWith('.md')).sort();
    const records = [];
    for (const file of markdownFiles) {
      records.push(...parseRecords(await readTextIfExists(join(this.recordDir, file))));
    }
    return withPhaseFallbacks(withRecentActualDirections(records))
      .filter((record) => record.actualDirection && record.correct != null)
      .filter((record) => resolveRecordTimeframe(record) === '15m');
  }

  async rebuildAllDailyMarkdown() {
    if (!this.enabled) return { dates: [], recordCount: 0 };
    await mkdir(this.recordDir, { recursive: true });
    const files = await readdir(this.recordDir).catch(() => []);
    const dailyFiles = files.filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort();
    const dates = [];
    let recordCount = 0;
    for (const file of dailyFiles) {
      const day = file.replace('.md', '');
      const filePath = join(this.recordDir, file);
      const records = withPhaseFallbacks(withRecentActualDirections(parseRecords(await readTextIfExists(filePath))));
      if (!records.length) continue;
      recordCount += records.length;
      dates.push(day);
      const polymarketPaper = await this.loadPolymarketPaperSummary(day);
      await writeFile(filePath, renderDailyMarkdown(day, records, { polymarketPaper }), 'utf8');
      await this.writePolymarketDetailMarkdown(day, polymarketPaper);
    }
    return { dates, recordCount };
  }

  async repairIntervalPmLockRecords() {
    if (!this.enabled) return { repaired: 0, dates: [] };
    await mkdir(this.recordDir, { recursive: true });
    const files = await readdir(this.recordDir).catch(() => []);
    const dailyFiles = files.filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort();
    let repaired = 0;
    const dates = [];
    for (const file of dailyFiles) {
      const day = file.replace('.md', '');
      const filePath = join(this.recordDir, file);
      const records = parseRecords(await readTextIfExists(filePath));
      let dayRepaired = 0;
      const normalized = records.map((record) => {
        if (!isRepairableFifteenMinuteLegacyLock(record)) return record;
        dayRepaired += 1;
        return {
          ...record,
          decisionLocked: false,
          lockedPolymarketPredictedDirection: null,
          lockedPolymarketUpProbability: null,
          lockedPolymarketDownProbability: null,
          lockStrength: null,
          lockedPmGap: null,
          decisionLockedAtIso: null,
          polymarketCorrect: null,
          skipReason: record.skipReason || 'legacy_no_pm_lock'
        };
      });
      if (!dayRepaired) continue;
      repaired += dayRepaired;
      dates.push(day);
      const polymarketPaper = await this.loadPolymarketPaperSummary(day);
      await writeFile(
        filePath,
        renderDailyMarkdown(day, withPhaseFallbacks(withRecentActualDirections(normalized)), { polymarketPaper }),
        'utf8'
      );
      await this.writePolymarketDetailMarkdown(day, polymarketPaper);
    }
    return { repaired, dates };
  }
}

function signalToUpdate(signal, generatedAt) {
  const upProbability = Number(signal.probabilities?.up ?? signal.prediction.upProbability);
  const downProbability = Number(signal.probabilities?.down ?? signal.prediction.downProbability);
  const polymarket = signalToPolymarketUpdate(signal.polymarket);
  const timeframe = resolveSignalTimeframe(signal);
  return {
    symbol: signal.symbol,
    timeframe,
    predictedAtIso: generatedAt,
    targetTimeIso: signal.prediction.targetTimeIso,
    startPrice: Number(signal.prediction.comparisonBasePrice),
    estimatedClose: Number(signal.prediction.estimatedClose),
    predictedDirection: signal.direction,
    predictedMovePct: Number(signal.prediction.estimatedMovePct),
    confidence: Number(signal.confidence),
    upProbability: Number.isFinite(upProbability) ? upProbability : signal.direction === 'up' ? Number(signal.confidence) : 1 - Number(signal.confidence),
    downProbability: Number.isFinite(downProbability) ? downProbability : signal.direction === 'down' ? Number(signal.confidence) : 1 - Number(signal.confidence),
    elapsedInCurrentSlotPct: Number(signal.indicators?.elapsedInCurrentSlotPct),
    previousClosedCandleMovePct: Number(signal.indicators?.previousClosedCandleMovePct),
    currentPrice: Number(signal.indicators?.currentPrice),
    return3Pct: Number(signal.indicators?.return3Pct),
    return6Pct: Number(signal.indicators?.return6Pct),
    volatilityPct: Number(signal.indicators?.volatility15mPct),
    recentClosedCandleMovesPct: Array.isArray(signal.indicators?.recentClosedCandleMovesPct)
      ? signal.indicators.recentClosedCandleMovesPct.map(Number).filter(Number.isFinite)
      : [],
    techDirection: signal.techDirection || null,
    techConfidence: Number.isFinite(Number(signal.techConfidence)) ? Number(signal.techConfidence) : null,
    compositeDirection: signal.compositeDirection || signal.direction || null,
    compositeConfidence: Number.isFinite(Number(signal.compositeConfidence))
      ? Number(signal.compositeConfidence)
      : Number(signal.confidence),
    polymarket
  };
}

function signalToPolymarketUpdate(sentiment) {
  if (!sentiment?.available) return null;
  const upProbability = Number(sentiment.upProbability ?? sentiment.upPrice);
  const downProbability = Number(sentiment.downProbability ?? sentiment.downPrice);
  if (!Number.isFinite(upProbability) || !Number.isFinite(downProbability)) return null;
  return {
    predictedDirection: upProbability >= downProbability ? 'up' : 'down',
    upProbability,
    downProbability,
    qualityScore: Number(sentiment.qualityScore),
    spread: Number(sentiment.spread),
    directionFlipCount: Number(sentiment.directionFlipCount5m),
    market: sentiment.market || sentiment.marketSlug || '',
    fetchedAtIso: sentiment.fetchedAtIso || null
  };
}

function isPmLockTimeframe(timeframe) {
  return timeframe === '5m' || timeframe === '15m';
}

function createPendingRecord(id, update, config = buildFiveMinuteDecisionConfig()) {
  const stability = trackPmDirectionStability({}, update);
  const withStability = { ...update, ...stability };
  const lockEval = isPmLockTimeframe(update.timeframe)
    ? resolveIntervalPmLockEval(update, withStability, config)
    : { shouldLock: false };
  const lockedNow = isPmLockTimeframe(update.timeframe) && lockEval.shouldLock;
  const base = {
    id,
    symbol: update.symbol,
    timeframe: update.timeframe || '15m',
    predictedAtIso: update.predictedAtIso,
    firstPredictedAtIso: update.predictedAtIso,
    targetTimeIso: update.targetTimeIso,
    startPrice: update.startPrice,
    firstEstimatedClose: update.estimatedClose,
    firstPredictedDirection: update.predictedDirection,
    firstPredictedMovePct: update.predictedMovePct,
    firstConfidence: update.confidence,
    firstUpProbability: update.upProbability,
    firstDownProbability: update.downProbability,
    firstPolymarketPredictedDirection: update.polymarket?.predictedDirection || null,
    firstPolymarketUpProbability: update.polymarket?.upProbability ?? null,
    firstPolymarketDownProbability: update.polymarket?.downProbability ?? null,
    firstPolymarketQualityScore: update.polymarket?.qualityScore ?? null,
    firstPolymarketFetchedAtIso: update.polymarket?.fetchedAtIso || null,
    polymarketPredictedDirection: update.polymarket?.predictedDirection || (lockedNow ? lockEval.direction : null) || null,
    polymarketUpProbability: update.polymarket?.upProbability ?? null,
    polymarketDownProbability: update.polymarket?.downProbability ?? null,
    polymarketQualityScore: update.polymarket?.qualityScore ?? null,
    polymarketMarket: update.polymarket?.market || '',
    polymarketFetchedAtIso: update.polymarket?.fetchedAtIso || null,
    latestPolymarketUpProbability: update.polymarket?.upProbability ?? null,
    latestPolymarketDownProbability: update.polymarket?.downProbability ?? null,
    phaseChecks: applyPhaseUpdate(emptyPhaseChecks(), update),
    estimatedClose: update.estimatedClose,
    predictedDirection: update.predictedDirection,
    predictedMovePct: update.predictedMovePct,
    confidence: update.confidence,
    upProbability: update.upProbability,
    downProbability: update.downProbability,
    previousClosedCandleMovePct: update.previousClosedCandleMovePct,
    currentPrice: update.currentPrice,
    return3Pct: update.return3Pct,
    return6Pct: update.return6Pct,
    volatilityPct: update.volatilityPct,
    recentClosedCandleMovesPct: update.recentClosedCandleMovesPct,
    lastTechDirection: update.techDirection || update.predictedDirection || null,
    lastTechConfidence: update.techConfidence ?? update.confidence ?? null,
    lastCompositeDirection: update.compositeDirection || update.predictedDirection || null,
    lastCompositeConfidence: update.compositeConfidence ?? update.confidence ?? null,
    lastElapsedInCurrentSlotPct: update.elapsedInCurrentSlotPct,
    directionFlips: 0,
    sampleCount: 1,
    ...stability,
    decisionLocked: lockedNow,
    decisionLockedAtIso: lockedNow ? update.predictedAtIso : null,
    lockedPolymarketPredictedDirection: lockedNow
      ? (lockEval.direction || update.polymarket?.predictedDirection || null)
      : null,
    lockedPolymarketUpProbability: lockedNow ? (update.polymarket?.upProbability ?? null) : null,
    lockedPolymarketDownProbability: lockedNow ? (update.polymarket?.downProbability ?? null) : null,
    lockedTechDirection: lockedNow && config.recordTechAndComposite ? (update.techDirection || update.predictedDirection || null) : null,
    lockedTechConfidence: lockedNow && config.recordTechAndComposite ? (update.techConfidence ?? update.confidence ?? null) : null,
    lockedCompositeDirection: lockedNow && config.recordTechAndComposite ? (update.compositeDirection || update.predictedDirection || null) : null,
    lockedCompositeConfidence: lockedNow && config.recordTechAndComposite ? (update.compositeConfidence ?? update.confidence ?? null) : null,
    lockedPmGap: lockedNow ? lockEval.pmGap : null,
    lockStrength: lockedNow ? lockEval.lockStrength : null,
    lockReason: lockedNow ? lockEval.reason : null,
    lockSource: lockedNow ? (lockEval.lockSource || 'polymarket') : null,
    lockHourPolicy: lockedNow ? (lockEval.hourPolicy || null) : null,
    lockElapsedPct: lockedNow ? update.elapsedInCurrentSlotPct : null,
    lockedStartPrice: lockedNow ? update.startPrice : null,
    lockedCurrentPrice: lockedNow ? update.currentPrice : null,
    lockedPreviousClosedCandleMovePct: lockedNow ? update.previousClosedCandleMovePct : null,
    lockedReturn3Pct: lockedNow ? update.return3Pct : null,
    lockedReturn6Pct: lockedNow ? update.return6Pct : null,
    lockedVolatilityPct: lockedNow ? update.volatilityPct : null,
    lockedRecentClosedCandleMovesPct: lockedNow ? update.recentClosedCandleMovesPct : null
  };
  return base;
}

function updatePendingRecord(existing, update, config = buildFiveMinuteDecisionConfig()) {
  if (existing.timeframe === '5m' || update.timeframe === '5m') {
    return updatePendingRecord5m(existing, update, config);
  }
  if (existing.decisionLocked) {
    // 普通锁后方向冻结，但仍推进 elapsed，供更晚的下轮预测锁使用
    return {
      ...existing,
      predictedAtIso: update.predictedAtIso,
      estimatedClose: update.estimatedClose,
      predictedDirection: update.predictedDirection,
      predictedMovePct: update.predictedMovePct,
      confidence: update.confidence,
      upProbability: update.upProbability,
      downProbability: update.downProbability,
      lastElapsedInCurrentSlotPct: update.elapsedInCurrentSlotPct,
      latestPolymarketUpProbability: update.polymarket?.upProbability ?? existing.latestPolymarketUpProbability,
      latestPolymarketDownProbability: update.polymarket?.downProbability ?? existing.latestPolymarketDownProbability,
      phaseChecks: applyPhaseUpdate(existing.phaseChecks || emptyPhaseChecks(), update),
      sampleCount: existing.sampleCount + 1
    };
  }

  const stability = trackPmDirectionStability(existing, update);
  const pendingForLock = { ...existing, ...stability };
  const lockEval = resolveIntervalPmLockEval(update, pendingForLock, config);
  if (lockEval.shouldLock) {
    const locked = applyFiveMinuteLockFields({ ...existing, ...stability }, update, lockEval, config);
    return {
      ...locked,
      phaseChecks: applyPhaseUpdate(existing.phaseChecks || emptyPhaseChecks(), update),
      directionFlips: existing.directionFlips + (existing.predictedDirection === update.predictedDirection ? 0 : 1)
    };
  }

  return {
    ...existing,
    ...stability,
    predictedAtIso: update.predictedAtIso,
    estimatedClose: update.estimatedClose,
    predictedDirection: update.predictedDirection,
    predictedMovePct: update.predictedMovePct,
    confidence: update.confidence,
    upProbability: update.upProbability,
    downProbability: update.downProbability,
    previousClosedCandleMovePct: Number.isFinite(update.previousClosedCandleMovePct)
      ? update.previousClosedCandleMovePct
      : existing.previousClosedCandleMovePct,
    currentPrice: Number.isFinite(update.currentPrice) ? update.currentPrice : existing.currentPrice,
    return3Pct: Number.isFinite(update.return3Pct) ? update.return3Pct : existing.return3Pct,
    return6Pct: Number.isFinite(update.return6Pct) ? update.return6Pct : existing.return6Pct,
    volatilityPct: Number.isFinite(update.volatilityPct) ? update.volatilityPct : existing.volatilityPct,
    recentClosedCandleMovesPct: update.recentClosedCandleMovesPct?.length
      ? update.recentClosedCandleMovesPct
      : existing.recentClosedCandleMovesPct,
    lastTechDirection: update.techDirection || update.predictedDirection || existing.lastTechDirection,
    lastTechConfidence: update.techConfidence ?? update.confidence ?? existing.lastTechConfidence,
    lastCompositeDirection: update.compositeDirection || update.predictedDirection || existing.lastCompositeDirection,
    lastCompositeConfidence: update.compositeConfidence ?? update.confidence ?? existing.lastCompositeConfidence,
    lastElapsedInCurrentSlotPct: update.elapsedInCurrentSlotPct,
    ...mergePolymarketFields(existing, update),
    phaseChecks: applyPhaseUpdate(existing.phaseChecks || emptyPhaseChecks(), update),
    directionFlips: existing.directionFlips + (existing.predictedDirection === update.predictedDirection ? 0 : 1),
    sampleCount: existing.sampleCount + 1
  };
}

function applyFiveMinuteLockFields(record, update, lockEval, config = buildFiveMinuteDecisionConfig()) {
  const merged = mergePolymarketFields(record, update);
  const lockedDirection = lockEval.direction
    || update.polymarket?.predictedDirection
    || merged.polymarketPredictedDirection;
  const lockedUp = update.polymarket?.upProbability ?? merged.polymarketUpProbability;
  const lockedDown = update.polymarket?.downProbability ?? merged.polymarketDownProbability;
  return {
    ...record,
    predictedAtIso: update.predictedAtIso,
    estimatedClose: update.estimatedClose,
    predictedDirection: update.predictedDirection,
    predictedMovePct: update.predictedMovePct,
    confidence: update.confidence,
    upProbability: update.upProbability,
    downProbability: update.downProbability,
    previousClosedCandleMovePct: Number.isFinite(update.previousClosedCandleMovePct)
      ? update.previousClosedCandleMovePct
      : record.previousClosedCandleMovePct,
    currentPrice: Number.isFinite(update.currentPrice) ? update.currentPrice : record.currentPrice,
    return3Pct: Number.isFinite(update.return3Pct) ? update.return3Pct : record.return3Pct,
    return6Pct: Number.isFinite(update.return6Pct) ? update.return6Pct : record.return6Pct,
    volatilityPct: Number.isFinite(update.volatilityPct) ? update.volatilityPct : record.volatilityPct,
    recentClosedCandleMovesPct: update.recentClosedCandleMovesPct?.length
      ? update.recentClosedCandleMovesPct
      : record.recentClosedCandleMovesPct,
    lastTechDirection: update.techDirection || update.predictedDirection || record.lastTechDirection,
    lastTechConfidence: update.techConfidence ?? update.confidence ?? record.lastTechConfidence,
    lastCompositeDirection: update.compositeDirection || update.predictedDirection || record.lastCompositeDirection,
    lastCompositeConfidence: update.compositeConfidence ?? update.confidence ?? record.lastCompositeConfidence,
    lastElapsedInCurrentSlotPct: update.elapsedInCurrentSlotPct,
    ...merged,
    polymarketPredictedDirection: lockedDirection,
    polymarketUpProbability: lockedUp,
    polymarketDownProbability: lockedDown,
    lockedPolymarketPredictedDirection: lockedDirection,
    lockedPolymarketUpProbability: lockedUp,
    lockedPolymarketDownProbability: lockedDown,
    lockedTechDirection: config.recordTechAndComposite ? (update.techDirection || update.predictedDirection || null) : null,
    lockedTechConfidence: config.recordTechAndComposite ? (update.techConfidence ?? update.confidence ?? null) : null,
    lockedCompositeDirection: config.recordTechAndComposite ? (update.compositeDirection || update.predictedDirection || null) : null,
    lockedCompositeConfidence: config.recordTechAndComposite ? (update.compositeConfidence ?? update.confidence ?? null) : null,
    lockedPmGap: lockEval.pmGap,
    lockStrength: lockEval.lockStrength,
    lockReason: lockEval.reason,
    lockSource: lockEval.lockSource || 'polymarket',
    lockHourPolicy: lockEval.hourPolicy || null,
    lockElapsedPct: update.elapsedInCurrentSlotPct,
    lockedStartPrice: update.startPrice,
    lockedCurrentPrice: update.currentPrice,
    lockedPreviousClosedCandleMovePct: update.previousClosedCandleMovePct,
    lockedReturn3Pct: update.return3Pct,
    lockedReturn6Pct: update.return6Pct,
    lockedVolatilityPct: update.volatilityPct,
    lockedRecentClosedCandleMovesPct: update.recentClosedCandleMovesPct,
    decisionLocked: true,
    decisionLockedAtIso: update.predictedAtIso,
    skipReason: null,
    firstPredictedDirection: record.firstPredictedDirection || update.predictedDirection,
    directionFlips: record.directionFlips,
    sampleCount: record.sampleCount + 1
  };
}

function updatePendingRecord5m(existing, update, config = buildFiveMinuteDecisionConfig()) {
  if (existing.decisionLocked) {
    // 普通锁后方向冻结，但仍推进 elapsed，供更晚的下轮预测锁使用
    return {
      ...existing,
      predictedAtIso: update.predictedAtIso,
      lastElapsedInCurrentSlotPct: update.elapsedInCurrentSlotPct,
      latestPolymarketUpProbability: update.polymarket?.upProbability ?? existing.latestPolymarketUpProbability,
      latestPolymarketDownProbability: update.polymarket?.downProbability ?? existing.latestPolymarketDownProbability,
      sampleCount: existing.sampleCount + 1
    };
  }

  const stability = trackPmDirectionStability(existing, update);
  const pendingForLock = { ...existing, ...stability };
  const lockEval = evaluateFiveMinuteLock(update, pendingForLock, config);
  if (lockEval.shouldLock) {
    return applyFiveMinuteLockFields({ ...existing, ...stability }, update, lockEval, config);
  }

  return {
    ...existing,
    ...stability,
    predictedAtIso: update.predictedAtIso,
    estimatedClose: update.estimatedClose,
    predictedDirection: update.predictedDirection,
    predictedMovePct: update.predictedMovePct,
    confidence: update.confidence,
    upProbability: update.upProbability,
    downProbability: update.downProbability,
    previousClosedCandleMovePct: Number.isFinite(update.previousClosedCandleMovePct)
      ? update.previousClosedCandleMovePct
      : existing.previousClosedCandleMovePct,
    currentPrice: Number.isFinite(update.currentPrice) ? update.currentPrice : existing.currentPrice,
    return3Pct: Number.isFinite(update.return3Pct) ? update.return3Pct : existing.return3Pct,
    return6Pct: Number.isFinite(update.return6Pct) ? update.return6Pct : existing.return6Pct,
    volatilityPct: Number.isFinite(update.volatilityPct) ? update.volatilityPct : existing.volatilityPct,
    recentClosedCandleMovesPct: update.recentClosedCandleMovesPct?.length
      ? update.recentClosedCandleMovesPct
      : existing.recentClosedCandleMovesPct,
    lastTechDirection: update.techDirection || update.predictedDirection || existing.lastTechDirection,
    lastTechConfidence: update.techConfidence ?? update.confidence ?? existing.lastTechConfidence,
    lastCompositeDirection: update.compositeDirection || update.predictedDirection || existing.lastCompositeDirection,
    lastCompositeConfidence: update.compositeConfidence ?? update.confidence ?? existing.lastCompositeConfidence,
    lastElapsedInCurrentSlotPct: update.elapsedInCurrentSlotPct,
    ...mergePolymarketFields(existing, update),
    directionFlips: existing.directionFlips + (existing.predictedDirection === update.predictedDirection ? 0 : 1),
    sampleCount: existing.sampleCount + 1
  };
}

function finalizeFiveMinutePending(pending, config = buildFiveMinuteDecisionConfig()) {
  if (pending.decisionLocked && resolveLockedPolymarketDirection(pending)) return pending;
  if (!config.recordUnlockedWindows) return null;
  return {
    ...pending,
    decisionLocked: false,
    skipReason: resolveFiveMinuteSkipReason(pending, config)
  };
}

function finalizeFifteenMinutePending(pending, config = buildFifteenMinuteDecisionConfig()) {
  if (pending.decisionLocked && resolveLockedPolymarketDirection(pending)) return pending;
  const displayLock = evaluateDisplayPmLock(pending, config);
  if (displayLock.shouldLock) {
    return applyDisplayPmLockFields(pending, displayLock, config);
  }
  return {
    ...pending,
    decisionLocked: false,
    skipReason: resolveFiveMinuteSkipReason(pending, config)
  };
}

function applyDisplayPmLockFields(record, lockEval, config = buildFifteenMinuteDecisionConfig()) {
  const lockedDirection = record.lastPmDirection || record.polymarketPredictedDirection;
  const lockedUp = record.polymarketUpProbability;
  const lockedDown = record.polymarketDownProbability;
  return {
    ...record,
    polymarketPredictedDirection: lockedDirection,
    polymarketUpProbability: lockedUp,
    polymarketDownProbability: lockedDown,
    lockedPolymarketPredictedDirection: lockedDirection,
    lockedPolymarketUpProbability: lockedUp,
    lockedPolymarketDownProbability: lockedDown,
    lockedTechDirection: config.recordTechAndComposite ? (record.lastTechDirection || null) : null,
    lockedTechConfidence: config.recordTechAndComposite ? (record.lastTechConfidence ?? null) : null,
    lockedCompositeDirection: config.recordTechAndComposite ? (record.lastCompositeDirection || null) : null,
    lockedCompositeConfidence: config.recordTechAndComposite ? (record.lastCompositeConfidence ?? null) : null,
    lockedPmGap: lockEval.pmGap,
    lockStrength: lockEval.lockStrength,
    lockReason: lockEval.reason,
    lockHourPolicy: lockEval.hourPolicy || null,
    lockElapsedPct: record.lastElapsedInCurrentSlotPct ?? record.lockElapsedPct ?? null,
    decisionLocked: true,
    decisionLockedAtIso: record.predictedAtIso,
    skipReason: null
  };
}

function mergePolymarketFields(existing, update) {
  if (existing.decisionLocked) {
    const lockedDirection = resolveLockedPolymarketDirection(existing);
    return {
      firstPolymarketPredictedDirection: existing.firstPolymarketPredictedDirection,
      firstPolymarketUpProbability: existing.firstPolymarketUpProbability,
      firstPolymarketDownProbability: existing.firstPolymarketDownProbability,
      firstPolymarketQualityScore: existing.firstPolymarketQualityScore,
      firstPolymarketFetchedAtIso: existing.firstPolymarketFetchedAtIso,
      polymarketPredictedDirection: lockedDirection,
      polymarketUpProbability: existing.lockedPolymarketUpProbability ?? existing.polymarketUpProbability,
      polymarketDownProbability: existing.lockedPolymarketDownProbability ?? existing.polymarketDownProbability,
      polymarketQualityScore: existing.polymarketQualityScore,
      polymarketMarket: existing.polymarketMarket || '',
      polymarketFetchedAtIso: existing.polymarketFetchedAtIso
    };
  }
  return {
    firstPolymarketPredictedDirection:
      existing.firstPolymarketPredictedDirection || update.polymarket?.predictedDirection || null,
    firstPolymarketUpProbability:
      existing.firstPolymarketUpProbability ?? update.polymarket?.upProbability ?? null,
    firstPolymarketDownProbability:
      existing.firstPolymarketDownProbability ?? update.polymarket?.downProbability ?? null,
    firstPolymarketQualityScore:
      existing.firstPolymarketQualityScore ?? update.polymarket?.qualityScore ?? null,
    firstPolymarketFetchedAtIso:
      existing.firstPolymarketFetchedAtIso || update.polymarket?.fetchedAtIso || null,
    polymarketPredictedDirection: update.polymarket?.predictedDirection || existing.polymarketPredictedDirection || null,
    polymarketUpProbability: update.polymarket?.upProbability ?? existing.polymarketUpProbability ?? null,
    polymarketDownProbability: update.polymarket?.downProbability ?? existing.polymarketDownProbability ?? null,
    polymarketQualityScore: update.polymarket?.qualityScore ?? existing.polymarketQualityScore ?? null,
    polymarketMarket: update.polymarket?.market || existing.polymarketMarket || '',
    polymarketFetchedAtIso: update.polymarket?.fetchedAtIso || existing.polymarketFetchedAtIso || null
  };
}

function renderDailyMarkdown(date, records, { polymarketPaper = null } = {}) {
  records = withRecentActualDirections(records);
  const summary = dailySummary(date, records);

  return `# ${date} ${TEXT.title}

## ${TEXT.stats}

| ${TEXT.item} | ${TEXT.value} |
| --- | ---: |
| ${TEXT.total} | ${summary.total} |
${renderStandaloneTimeframeStatRows(summary.fiveMinute, '5m PM')}
${renderFiveMinuteLockStrengthStatRows(summary.fiveMinute)}
${renderStandaloneTimeframeStatRows(summary.fifteenMinute, '15m PM')}
${renderFifteenMinuteLockStrengthStatRows(summary.fifteenMinute)}
${renderPmLockSkippedStatRows(summary.fiveMinute?.skipped, '5m')}
${renderPmLockSkippedStatRows(summary.fifteenMinute?.skipped, '15m')}
${renderPhaseStatRows(summary.phases.tech, '15m\u5185\u6280\u672f')}
${renderPhaseStatRows(summary.phases.polymarket, '15m\u5185 Polymarket')}
${renderPhaseStatRows(summary.phases.composite, '15m\u5185\u7efc\u5408')}
${renderPolymarketPaperStats(polymarketPaper)}
${renderPolymarketLiveStats(polymarketPaper)}
${renderPmLockRecordsSection(records)}

## ${TEXT.records}

| ID | ${TEXT.firstPredictedAt} | ${TEXT.finalPredictedAt} | ${TEXT.targetAt} | ${TEXT.symbol} | ${TEXT.startPrice} | ${TEXT.firstPrediction} | ${TEXT.firstUpProbability} | ${TEXT.firstDownProbability} | ${TEXT.firstResult} | ${TEXT.finalPrediction} | ${TEXT.finalUpProbability} | ${TEXT.finalDownProbability} | ${TEXT.finalResult} | ${TEXT.polymarketFirstPrediction} | ${TEXT.polymarketFirstUpProbability} | ${TEXT.polymarketFirstDownProbability} | ${TEXT.polymarketFirstResult} | ${TEXT.polymarketFinalPrediction} | ${TEXT.polymarketFinalUpProbability} | ${TEXT.polymarketFinalDownProbability} | ${TEXT.polymarketFinalResult} | ${TEXT.phaseTechResults} | ${TEXT.phasePolymarketResults} | ${TEXT.phaseCompositeResults} | ${TEXT.directionFlips} | ${TEXT.sampleCount} | ${TEXT.estimatedClose} | ${TEXT.actualClose} | ${TEXT.actual} | ${TEXT.predictedMove} | ${TEXT.actualMove} | ${TEXT.confidence} | ${TEXT.polymarketMarket} | ${TEXT.recentActualDirections} | ${TEXT.fiveMinuteExtra} |
| --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: | ---: | --- | --- | ---: | ---: | --- | --- | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | --- |
${records.map(renderRow).join('\n')}
${renderPolymarketPaperOrders(polymarketPaper)}
${renderPolymarketLiveOrders(polymarketPaper)}
`;
}

function dailySummary(date, records) {
  records = withRecentActualDirections(records);
  const records15m = records.filter((item) => resolveRecordTimeframe(item) === '15m');
  const records5m = records.filter((item) => resolveRecordTimeframe(item) === '5m');
  const total = records15m.length;
  const firstCorrect = records15m.filter((item) => item.firstCorrect ?? item.correct).length;
  const finalCorrect = records15m.filter((item) => item.correct).length;
  const polymarketFirstRecords = records15m.filter((item) => item.firstPolymarketPredictedDirection && item.firstPolymarketCorrect != null);
  const polymarketFinalRecords = records15m.filter((item) => item.polymarketPredictedDirection && item.polymarketCorrect != null);
  const polymarketFirstCorrect = polymarketFirstRecords.filter((item) => item.firstPolymarketCorrect).length;
  const polymarketFinalCorrect = polymarketFinalRecords.filter((item) => item.polymarketCorrect).length;
  const phases = {
    tech: phaseSummary(records15m, 'tech'),
    polymarket: phaseSummary(records15m, 'polymarket'),
    composite: phaseSummary(records15m, 'composite')
  };
  const fiveMinute = summarizeStandaloneTimeframe(records5m);
  const fifteenMinute = summarizeFifteenMinuteLocks(records15m);
  return {
    date,
    total,
    fiveMinute,
    fifteenMinute,
    first: {
      correct: firstCorrect,
      wrong: total - firstCorrect,
      accuracy: total ? firstCorrect / total : 0
    },
    final: {
      correct: finalCorrect,
      wrong: total - finalCorrect,
      accuracy: total ? finalCorrect / total : 0
    },
    polymarket: {
      total: polymarketFinalRecords.length,
      first: {
        total: polymarketFirstRecords.length,
        correct: polymarketFirstCorrect,
        wrong: polymarketFirstRecords.length - polymarketFirstCorrect,
        accuracy: polymarketFirstRecords.length ? polymarketFirstCorrect / polymarketFirstRecords.length : 0
      },
      final: {
        total: polymarketFinalRecords.length,
        correct: polymarketFinalCorrect,
        wrong: polymarketFinalRecords.length - polymarketFinalCorrect,
        accuracy: polymarketFinalRecords.length ? polymarketFinalCorrect / polymarketFinalRecords.length : 0
      },
      correct: polymarketFinalCorrect,
      wrong: polymarketFinalRecords.length - polymarketFinalCorrect,
      accuracy: polymarketFinalRecords.length ? polymarketFinalCorrect / polymarketFinalRecords.length : 0
    },
    phases,
    records: records.map((record) => ({
      id: record.id,
      symbol: record.symbol,
      targetTimeIso: record.targetTimeIso,
      firstDirection: record.firstPredictedDirection || record.predictedDirection,
      finalDirection: record.predictedDirection,
      actualDirection: record.actualDirection,
      firstCorrect: Boolean(record.firstCorrect ?? record.correct),
      finalCorrect: Boolean(record.correct),
      polymarketFirstDirection: record.firstPolymarketPredictedDirection || null,
      polymarketFinalDirection: record.polymarketPredictedDirection || null,
      polymarketFirstCorrect: record.firstPolymarketCorrect == null ? null : Boolean(record.firstPolymarketCorrect),
      polymarketFinalCorrect: record.polymarketCorrect == null ? null : Boolean(record.polymarketCorrect),
      polymarketDirection: record.polymarketPredictedDirection || null,
      polymarketCorrect: record.polymarketCorrect == null ? null : Boolean(record.polymarketCorrect),
      phases: record.phaseChecks || emptyPhaseChecks(),
      recentActualDirections: record.recentActualDirections || [],
      directionFlips: record.directionFlips ?? 0,
      sampleCount: record.sampleCount ?? 1
    }))
  };
}

function withRecentActualDirections(records) {
  const sorted = [...records].sort((a, b) => a.targetTimeIso.localeCompare(b.targetTimeIso) || a.symbol.localeCompare(b.symbol));
  for (const record of sorted) {
    record.recentActualDirections = sorted
      .filter((item) => item.symbol === record.symbol && item.targetTimeIso < record.targetTimeIso && item.actualDirection)
      .slice(-3)
      .map((item) => item.actualDirection);
  }
  return sorted;
}

function withPhaseFallbacks(records) {
  return withFiveMinuteLockFallbacks(records.map((record) => {
    const phaseChecks = clonePhaseChecks(record.phaseChecks || emptyPhaseChecks());
    if (!phaseChecks.tech.phase1 && record.firstPredictedDirection && record.firstCorrect != null) {
      phaseChecks.tech.phase1 = {
        direction: record.firstPredictedDirection,
        correct: Boolean(record.firstCorrect),
        upProbability: record.firstUpProbability ?? directionProbability(record, 'up'),
        downProbability: record.firstDownProbability ?? directionProbability(record, 'down'),
        previousClosedCandleMovePct: record.previousClosedCandleMovePct,
        predictedAtIso: record.firstPredictedAtIso || record.predictedAtIso,
        sampled: false
      };
    }
    if (!phaseChecks.tech.phase3 && record.predictedDirection && record.correct != null) {
      phaseChecks.tech.phase3 = {
        direction: record.predictedDirection,
        correct: Boolean(record.correct),
        upProbability: record.upProbability ?? directionProbability(record, 'up'),
        downProbability: record.downProbability ?? directionProbability(record, 'down'),
        confidence: record.confidence,
        previousClosedCandleMovePct: record.previousClosedCandleMovePct,
        predictedAtIso: record.predictedAtIso,
        sampled: false
      };
    }
    if (!phaseChecks.tech.phase2) {
      phaseChecks.tech.phase2 = copyPhaseEntry(phaseChecks.tech.phase3 || phaseChecks.tech.phase1, { sampled: false });
    }
    if (!phaseChecks.polymarket.phase1 && record.firstPolymarketPredictedDirection && record.firstPolymarketCorrect != null) {
      phaseChecks.polymarket.phase1 = {
        direction: record.firstPolymarketPredictedDirection,
        correct: Boolean(record.firstPolymarketCorrect),
        upProbability: record.firstPolymarketUpProbability,
        downProbability: record.firstPolymarketDownProbability,
        qualityScore: record.firstPolymarketQualityScore,
        predictedAtIso: record.firstPolymarketFetchedAtIso || record.firstPredictedAtIso || record.predictedAtIso,
        sampled: false
      };
    }
    if (!phaseChecks.polymarket.phase3 && record.polymarketPredictedDirection && record.polymarketCorrect != null) {
      phaseChecks.polymarket.phase3 = {
        direction: record.polymarketPredictedDirection,
        correct: Boolean(record.polymarketCorrect),
        upProbability: record.polymarketUpProbability,
        downProbability: record.polymarketDownProbability,
        qualityScore: record.polymarketQualityScore,
        predictedAtIso: record.polymarketFetchedAtIso || record.predictedAtIso,
        sampled: false
      };
    }
    if (!phaseChecks.polymarket.phase2) {
      phaseChecks.polymarket.phase2 = copyPhaseEntry(phaseChecks.polymarket.phase3 || phaseChecks.polymarket.phase1, { sampled: false });
    }
    for (const phase of PHASES) {
      const tech = phaseChecks.tech[phase.key];
      const polymarket = phaseChecks.polymarket[phase.key];
      if (tech?.direction && polymarket?.direction) {
        const composite = buildCompositePhaseEntry(tech, polymarket, phase.key);
        composite.correct = composite.direction === record.actualDirection;
        composite.sampled = isSampledPhaseEntry(tech) && isSampledPhaseEntry(polymarket);
        phaseChecks.composite[phase.key] = composite;
      }
    }
    return { ...record, phaseChecks };
  }));
}

function withIntervalLockFallbacks(records) {
  const fifteenMinuteConfig = buildFifteenMinuteDecisionConfig();
  return records.map((record) => {
    const timeframe = resolveRecordTimeframe(record);
    if (!isPmLockTimeframe(timeframe)) return record;
    let next = record;
    if (
      timeframe === '5m'
      && !hasExplicitPmLockMetadata(next)
      && next.lockedPolymarketPredictedDirection !== 'up'
      && next.lockedPolymarketPredictedDirection !== 'down'
      && (next.polymarketPredictedDirection === 'up' || next.polymarketPredictedDirection === 'down')
    ) {
      next = {
        ...next,
        decisionLocked: next.decisionLocked ?? true,
        lockedPolymarketPredictedDirection: next.polymarketPredictedDirection,
        lockedPolymarketUpProbability: next.lockedPolymarketUpProbability ?? next.polymarketUpProbability ?? null,
        lockedPolymarketDownProbability: next.lockedPolymarketDownProbability ?? next.polymarketDownProbability ?? null
      };
    }
    if (
      timeframe === '15m'
      && isBackfillEligibleFifteenMinuteLock(next)
      && !hasExplicitPmLockMetadata(next)
      && next.lockedPolymarketPredictedDirection !== 'up'
      && next.lockedPolymarketPredictedDirection !== 'down'
      && (next.polymarketPredictedDirection === 'up' || next.polymarketPredictedDirection === 'down')
    ) {
      const inferredElapsed = inferIntervalLockElapsedPct(next, fifteenMinuteConfig.slotSeconds);
      const evalSource = Number.isFinite(Number(next.lastElapsedInCurrentSlotPct ?? next.lockElapsedPct))
        ? next
        : inferredElapsed == null
          ? next
          : { ...next, lastElapsedInCurrentSlotPct: inferredElapsed };
      const displayLock = evaluateDisplayPmLock(evalSource, fifteenMinuteConfig);
      if (displayLock.shouldLock) {
        next = applyDisplayPmLockFields(next, displayLock, fifteenMinuteConfig);
      }
    }
    const lockedDirection = resolveLockedPolymarketDirection(next);
    if (
      lockedDirection
      && next.actualDirection
      && next.polymarketCorrect == null
      && hasExplicitPmLockMetadata(next)
    ) {
      next = {
        ...next,
        polymarketCorrect: next.actualDirection === lockedDirection
      };
    }
    if (hasExplicitPmLockMetadata(next) && !next.lockStrength && Number.isFinite(Number(next.lockedPmGap))) {
      const gap = Number(next.lockedPmGap);
      if (gap >= Number(fifteenMinuteConfig.strongPmGap ?? 0.60)) {
        next = { ...next, lockStrength: 'strong' };
      } else if (gap >= Number(fifteenMinuteConfig.normalPmGap ?? 0.30)) {
        next = { ...next, lockStrength: 'normal' };
      }
      else next = { ...next, lockStrength: 'weak' };
    }
    return next;
  });
}

function withFiveMinuteLockFallbacks(records) {
  return withIntervalLockFallbacks(records);
}

function isSampledPhaseEntry(entry) {
  return entry?.sampled === true;
}

function copyPhaseEntry(entry, { sampled = false } = {}) {
  return entry?.direction ? { ...entry, sampled } : null;
}

function emptyPhaseChecks() {
  return {
    tech: Object.fromEntries(PHASES.map((phase) => [phase.key, null])),
    polymarket: Object.fromEntries(PHASES.map((phase) => [phase.key, null])),
    composite: Object.fromEntries(PHASES.map((phase) => [phase.key, null]))
  };
}

function applyPhaseUpdate(existing, update) {
  if (update.timeframe === '5m') return clonePhaseChecks(existing);
  const checks = clonePhaseChecks(existing);
  const phase = phaseForUpdate(update);
  if (['up', 'down'].includes(update.predictedDirection) && !checks.tech[phase.key]) {
    checks.tech[phase.key] = {
      direction: update.predictedDirection,
      upProbability: update.upProbability,
      downProbability: update.downProbability,
      confidence: update.confidence,
      previousClosedCandleMovePct: update.previousClosedCandleMovePct,
      predictedAtIso: update.predictedAtIso,
      sampled: true
    };
  }

  if (!checks.polymarket[phase.key] && update.polymarket?.predictedDirection) {
    checks.polymarket[phase.key] = {
      direction: update.polymarket.predictedDirection,
      upProbability: update.polymarket.upProbability,
      downProbability: update.polymarket.downProbability,
      qualityScore: update.polymarket.qualityScore,
      predictedAtIso: update.polymarket.fetchedAtIso || update.predictedAtIso,
      sampled: true
    };
  }
  if (!checks.composite[phase.key] && checks.tech[phase.key] && checks.polymarket[phase.key]) {
    checks.composite[phase.key] = {
      ...buildCompositePhaseEntry(checks.tech[phase.key], checks.polymarket[phase.key], phase.key),
      sampled: true
    };
  }

  return checks;
}

function clonePhaseChecks(value) {
  const checks = emptyPhaseChecks();
  for (const source of ['tech', 'polymarket', 'composite']) {
    for (const phase of PHASES) {
      checks[source][phase.key] = value?.[source]?.[phase.key] ? { ...value[source][phase.key] } : null;
    }
  }
  return checks;
}

function phaseForUpdate(update) {
  const elapsedPct = Number(update.elapsedInCurrentSlotPct);
  if (Number.isFinite(elapsedPct)) {
    const elapsedMinutes = Math.max(0, Math.min(INTERVAL_MINUTES, elapsedPct * INTERVAL_MINUTES));
    const index = Math.min(PHASES.length - 1, Math.floor(elapsedMinutes / PHASE_MINUTES));
    return PHASES[index];
  }
  const targetMs = Date.parse(update.targetTimeIso);
  const predictedMs = Date.parse(update.predictedAtIso);
  const slotStartMs = targetMs - INTERVAL_MINUTES * 60 * 1000;
  const elapsedMs = Number.isFinite(predictedMs) ? predictedMs - slotStartMs : 0;
  const index = Math.max(0, Math.min(PHASES.length - 1, Math.floor(elapsedMs / (PHASE_MINUTES * 60 * 1000))));
  return PHASES[index];
}

function evaluatePhaseChecks(phaseChecks, actualDirection) {
  const checks = clonePhaseChecks(phaseChecks);
  for (const source of ['tech', 'polymarket', 'composite']) {
    for (const phase of PHASES) {
      const entry = checks[source][phase.key];
      if (entry?.direction) {
        entry.correct = entry.direction === actualDirection;
      }
    }
  }
  return checks;
}

function buildCompositePhaseEntry(tech, polymarket, phaseKey) {
  const techUp = Number(tech.upProbability) || 0;
  const techDown = Number(tech.downProbability) || 0;
  const polyUp = Number(polymarket.upProbability) || 0;
  const polyDown = Number(polymarket.downProbability) || 0;
  const techSum = Math.max(techUp + techDown, 0.000001);
  const polySum = Math.max(polyUp + polyDown, 0.000001);
  const qualityScore = clamp(Number(polymarket.qualityScore), 0.15, 1, 1);
  const baseTechWeight = COMPOSITE_TECH_WEIGHTS[phaseKey] ?? 0.35;
  const techWeight = phaseKey === 'phase1'
    ? baseTechWeight
    : baseTechWeight + (1 - baseTechWeight) * (1 - qualityScore);
  const polyWeight = 1 - techWeight;
  const adjusted = applyPreviousMoveReversalBias({
    upProbability: techUp / techSum * techWeight + polyUp / polySum * polyWeight,
    downProbability: techDown / techSum * techWeight + polyDown / polySum * polyWeight,
    previousMovePct: tech.previousClosedCandleMovePct,
    phaseKey
  });
  const { upProbability, downProbability } = adjusted;
  return {
    direction: upProbability >= downProbability ? 'up' : 'down',
    upProbability,
    downProbability,
    confidence: Math.max(upProbability, downProbability),
    polymarketQualityScore: qualityScore,
    techWeight,
    previousMoveAdjustment: adjusted.adjustment,
    predictedAtIso: tech.predictedAtIso || polymarket.predictedAtIso || null
  };
}

function applyPreviousMoveReversalBias({ upProbability, downProbability, previousMovePct, phaseKey }) {
  const move = Number(previousMovePct);
  if (!Number.isFinite(move)) {
    return { upProbability, downProbability, adjustment: 0 };
  }
  const absMove = Math.abs(move);
  if (absMove < PREVIOUS_MOVE_REVERSAL_MIN || absMove >= PREVIOUS_MOVE_REVERSAL_MAX) {
    return { upProbability, downProbability, adjustment: 0 };
  }
  const boost = PREVIOUS_MOVE_REVERSAL_BOOSTS[phaseKey] ?? 0.02;
  const adjustedUp = move < 0 ? upProbability + boost : upProbability - boost;
  const up = Math.max(0.02, Math.min(0.98, adjustedUp));
  return {
    upProbability: up,
    downProbability: 1 - up,
    adjustment: move < 0 ? boost : -boost
  };
}

function phaseSummary(records, source) {
  return Object.fromEntries(PHASES.map((phase) => {
    const entries = records
      .map((record) => record.phaseChecks?.[source]?.[phase.key])
      .filter((entry) => isSampledPhaseEntry(entry) && entry.correct != null);
    const correct = entries.filter((entry) => entry.correct).length;
    return [phase.key, {
      label: phase.label,
      total: entries.length,
      correct,
      wrong: entries.length - correct,
      accuracy: entries.length ? correct / entries.length : 0
    }];
  }));
}

function buildStrategyRiskSummary(records) {
  const strategies = [
    ['techFinal', '15m\u5185\u6280\u672f10\u5206', phaseOutcome(records, 'tech', 'phase3')],
    ['polymarketFinal', '15m\u5185 PM 10\u5206', phaseOutcome(records, 'polymarket', 'phase3')],
    ['compositeFinal', '15m\u5185\u7efc\u540810\u5206', phaseOutcome(records, 'composite', 'phase3')]
  ];
  const rows = strategies.map(([key, label, outcomes]) => {
    const wins = outcomes.filter(Boolean).length;
    const losses = outcomes.length - wins;
    const winRate = outcomes.length ? wins / outcomes.length : 0;
    const fullKelly = Math.max(0, 2 * winRate - 1);
    const suggestedFraction = Math.min(0.05, fullKelly * 0.5);
    return {
      key,
      label,
      sampleCount: outcomes.length,
      wins,
      losses,
      winRate: round4(winRate),
      fullKelly: round4(fullKelly),
      suggestedFraction: round4(suggestedFraction),
      simulation: simulateBinaryStrategy(outcomes, suggestedFraction)
    };
  });
  const preferred = rows
    .filter((row) => row.sampleCount >= 20)
    .sort((a, b) => b.simulation.medianFinalEquity - a.simulation.medianFinalEquity)[0] || rows[0] || null;
  return {
    generatedAtIso: new Date().toISOString(),
    recordCount: records.length,
    assumptions: {
      payout: 'even-money',
      simulations: 2000,
      horizonTrades: 96,
      maxSuggestedFraction: 0.05,
      sizing: 'half-kelly-capped'
    },
    preferredKey: preferred?.key || null,
    strategies: rows
  };
}

function phaseOutcome(records, source, phaseKey) {
  return records
    .map((record) => record.phaseChecks?.[source]?.[phaseKey])
    .filter((entry) => isSampledPhaseEntry(entry) && entry.correct != null)
    .map((entry) => Boolean(entry.correct));
}

function simulateBinaryStrategy(outcomes, fraction) {
  if (!outcomes.length || !Number.isFinite(fraction) || fraction <= 0) {
    return {
      medianFinalEquity: 1,
      p10FinalEquity: 1,
      p90FinalEquity: 1,
      medianMaxDrawdown: 0,
      p90MaxDrawdown: 0,
      ruinProbability: 0
    };
  }
  const rng = seededRandom(42 + outcomes.length);
  const finals = [];
  const drawdowns = [];
  let ruinCount = 0;
  for (let run = 0; run < 2000; run += 1) {
    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    for (let trade = 0; trade < 96; trade += 1) {
      const win = outcomes[Math.floor(rng() * outcomes.length)];
      equity *= win ? 1 + fraction : 1 - fraction;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak ? 1 - equity / peak : 0);
    }
    if (equity <= 0.7) ruinCount += 1;
    finals.push(equity);
    drawdowns.push(maxDrawdown);
  }
  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  return {
    medianFinalEquity: round4(quantile(finals, 0.5)),
    p10FinalEquity: round4(quantile(finals, 0.1)),
    p90FinalEquity: round4(quantile(finals, 0.9)),
    medianMaxDrawdown: round4(quantile(drawdowns, 0.5)),
    p90MaxDrawdown: round4(quantile(drawdowns, 0.9)),
    ruinProbability: round4(ruinCount / 2000)
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
  return sorted[index];
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

async function writePolymarketDetailMarkdown(recordDir, date, summary) {
  await Promise.all([
    writePolymarketPaperPlanMarkdown(recordDir, date, summary, 'plan1'),
    writePolymarketPaperPlanMarkdown(recordDir, date, summary, 'plan2'),
    writePolymarketPaperPlanMarkdown(recordDir, date, summary, 'plan3'),
    writePolymarketLiveMarkdown(recordDir, date, summary)
  ]);
}

async function writePolymarketPaperPlanMarkdown(recordDir, date, summary, planId) {
  const orders = (summary?.orders || []).filter((order) => order.planId === planId);
  const stats = (summary?.stats || []).filter((row) => row.planId === planId);
  const dir = join(recordDir, planId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.md`), renderPolymarketPaperPlanMarkdown(date, planId, orders, stats), 'utf8');
}

async function writePolymarketLiveMarkdown(recordDir, date, summary) {
  const orders = summary?.liveOrders || [];
  const stats = summary?.liveStats || [];
  const dir = join(recordDir, '实盘');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${date}.md`), renderPolymarketLiveMarkdown(date, orders, stats), 'utf8');
}

function renderPolymarketPaperPlanMarkdown(date, planId, orders, stats) {
  const isPlan3 = planId === 'plan3';
  const orderHeader = isPlan3
    ? '| 订单ID | 截止时间 | 计划 | 周期 | 方向 | 结果 | 金额 | 限价 | 价格档 | PnL | 退出 | 市场 |'
    : '| 订单ID | 截止时间 | 计划 | 周期 | 方向 | 结果 | 金额 | 限价 | PnL | 退出 | 市场 |';
  const orderRows = orders.map((order) => renderPolymarketPaperOrderRow(order, { planId }));
  return `# ${date} Polymarket ${planId.toUpperCase()} 模拟记录

## 统计

| 项目 | 数值 |
| --- | ---: |
${stats.map((row) => `| ${row.label} | ${formatAccuracy(row.accuracy)} · 正确 ${row.wins} / 错误 ${row.losses} / PnL ${formatSignedUsd(row.pnl)} |`).join('\n')}

## 订单

${orderHeader}
| --- | --- | --- | --- | --- | --- | ---: | ---: |${isPlan3 ? ' ---: |' : ''} ---: | --- | --- |
${orderRows.join('\n')}
`;
}

function renderPolymarketLiveMarkdown(date, orders, stats) {
  return `# ${date} Polymarket 实盘操作记录

## 统计

| 项目 | 数值 |
| --- | ---: |
${stats.map((row) => `| ${row.label} | ${formatAccuracy(row.accuracy)} · 赢 ${row.wins} / 输 ${row.losses} / 投入 ${usd(row.investedUsd)} / PnL ${formatSignedUsd(row.pnl)} / 收益率 ${formatAccuracy(row.returnPct)} · 已提交 ${row.submitted} / 待成交 ${row.pending} / 拦截 ${row.blocked} / 未成交过期 ${row.expiredUnfilled} |`).join('\n')}

## 操作

| 操作ID | 时间 | 买卖 | 状态 | 计划 | 周期 | 方向 | 入场类型 | 金额 | 份额 | 限价 | TP | SL | 退出 | PnL | CLOB ID | 市场 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- |
${orders.map(renderPolymarketLiveOrderRow).join('\n')}
`;
}
function renderPhaseStatRows(summary, prefix) {
  return PHASES.map((phase) => {
    const item = summary?.[phase.key] || { correct: 0, wrong: 0, accuracy: 0, total: 0 };
    const total = Number(item.total ?? (item.correct + item.wrong));
    const detail = total ? `\u6b63\u786e ${item.correct} / \u9519\u8bef ${item.wrong}` : '--';
    return `| ${prefix} ${phase.label} \u6b63\u786e\u7387 | ${formatAccuracy(item.accuracy)} \u00b7 ${detail} |`;
  }).join('\n');
}

function renderPolymarketPaperStats(summary) {
  const rows = summary?.stats || [];
  if (!rows.length) return '';
  return rows.map((row) => {
    const hasData = Number(row.total) > 0;
    const detail = hasData
      ? `正确 ${row.wins} / 错误 ${row.losses} / PnL ${formatSignedUsd(row.pnl)}`
      : '暂无数据';
    return `| Polymarket模拟 ${row.label} 正确率 | ${hasData ? formatAccuracy(row.accuracy) : '--'} · ${detail} |`;
  }).join('\n');
}

function renderPolymarketLiveStats(summary) {
  const rows = summary?.liveStats || [];
  if (!rows.length) return '';
  return rows.map((row) => {
    const hasData = Number(row.total) > 0 || Number(row.submitted) > 0 || Number(row.pending) > 0 || Number(row.blocked) > 0 || Number(row.expiredUnfilled) > 0;
    const detail = hasData
      ? `赢 ${row.wins} / 输 ${row.losses} / 投入 ${usd(row.investedUsd)} / PnL ${formatSignedUsd(row.pnl)} / 收益率 ${formatAccuracy(row.returnPct)}`
      : '暂无数据';
    return `| Polymarket实盘 ${row.label} | ${hasData ? formatAccuracy(row.accuracy) : '--'} · ${detail} · 已提交 ${row.submitted || 0} / 待成交 ${row.pending || 0} / 拦截 ${row.blocked || 0} / 未成交过期 ${row.expiredUnfilled || 0} |`;
  }).join('\n');
}
function renderPolymarketPaperOrders(summary) {
  const orders = summary?.orders || [];
  if (!orders.length) return '';
  return `

## Polymarket模拟订单记录

| 订单ID | 截止时间 | 计划 | 周期 | 方向 | 结果 | 金额 | 限价 | PnL | 退出 | 市场 |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
${orders.map((order) => renderPolymarketPaperOrderRow(order, { planId: order.planId })).join('\n')}
`;
}

function renderPolymarketLiveOrders(summary) {
  const orders = summary?.liveOrders || [];
  if (!orders.length) return '';
  return `

## Polymarket实盘操作记录

| 操作ID | 时间 | 买卖 | 状态 | 计划 | 周期 | 方向 | 入场类型 | 金额 | 份额 | 限价 | TP | SL | 退出 | PnL | CLOB ID | 市场 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- |
${orders.map(renderPolymarketLiveOrderRow).join('\n')}
`;
}
function renderPolymarketPaperOrderRow(order, { planId = null } = {}) {
  const cells = [
    order.id,
    formatShanghaiTime(order.targetTimeIso || order.settledAtIso || order.createdAtIso),
    String(order.planId || '').toUpperCase(),
    order.timeframe || '--',
    directionTextOrDash(order.direction),
    resultText(order.won),
    usd(order.usd),
    pctOrDash(order.limitPrice)
  ];
  if (planId === 'plan3' || order.planId === 'plan3') {
    cells.push(order.priceBand || '--');
  }
  cells.push(
    formatSignedUsd(order.pnl),
    order.exitStatus || '--',
    order.market || '--'
  );
  return cells.map(escapeCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function renderPolymarketLiveOrderRow(order) {
  return [
    order.id,
    formatShanghaiTime(order.createdAtIso || order.filledAtIso || order.closedAtIso || order.targetTimeIso),
    order.orderSide || '--',
    liveOrderStatusWithExit(order),
    String(order.planId || '').toUpperCase() || '--',
    order.timeframe || '--',
    directionTextOrDash(order.direction),
    order.entryType || '--',
    usd(order.usd),
    numberOrDash(order.shares, 4),
    pctOrDash(order.limitPrice),
    pctOrDash(order.takeProfitPrice),
    pctOrDash(order.stopLossPrice),
    order.exitStatus || '--',
    Number.isFinite(Number(order.pnl)) ? formatSignedUsd(order.pnl) : '--',
    shortId(order.clobOrderId),
    order.market || '--',
    order.error || order.lastExitError || order.exitReason || order.note || '--'
  ].map(escapeCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}
function renderRow(record) {
  return [
    record.id,
    formatShanghaiTime(record.firstPredictedAtIso || record.predictedAtIso),
    formatShanghaiTime(record.predictedAtIso),
    formatShanghaiTime(record.targetTimeIso),
    record.symbol,
    usd(record.startPrice),
    directionText(record.firstPredictedDirection || record.predictedDirection),
    pct(record.firstUpProbability ?? directionProbability(record, 'up')),
    pct(record.firstDownProbability ?? directionProbability(record, 'down')),
    resultText(record.firstCorrect ?? record.correct),
    directionText(record.predictedDirection),
    pct(record.upProbability ?? directionProbability(record, 'up')),
    pct(record.downProbability ?? directionProbability(record, 'down')),
    resultText(record.correct),
    directionTextOrDash(record.firstPolymarketPredictedDirection),
    pctOrDash(record.firstPolymarketUpProbability),
    pctOrDash(record.firstPolymarketDownProbability),
    resultTextOrDash(record.firstPolymarketCorrect),
    directionTextOrDash(record.polymarketPredictedDirection),
    pctOrDash(record.polymarketUpProbability),
    pctOrDash(record.polymarketDownProbability),
    resultTextOrDash(record.polymarketCorrect),
    renderPhaseCell(record.phaseChecks, 'tech'),
    renderPhaseCell(record.phaseChecks, 'polymarket'),
    renderPhaseCell(record.phaseChecks, 'composite'),
    record.directionFlips ?? 0,
    record.sampleCount ?? 1,
    usd(record.estimatedClose),
    usd(record.actualPrice),
    directionText(record.actualDirection),
    pct(record.predictedMovePct),
    pct(record.actualMovePct),
    pct(record.confidence),
    record.polymarketMarket || '--',
    renderRecentDirections(record.recentActualDirections),
    renderIntervalPmExtraCell(record)
  ].map(escapeCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function renderRecentDirections(directions = []) {
  return directions.length ? directions.map(directionText).join('>') : '--';
}

function parseRecentDirections(value) {
  if (!value || value === '--') return [];
  return String(value)
    .split('>')
    .map((item) => parseDirectionOrNull(item.trim()))
    .filter(Boolean);
}

function renderPhaseCell(phaseChecks, source) {
  const checks = phaseChecks || emptyPhaseChecks();
  return PHASES.map((phase) => {
    const entry = checks?.[source]?.[phase.key];
    if (!entry?.direction) return `${phase.label}:--`;
    return [
      phase.label,
      directionText(entry.direction),
      resultTextOrDash(entry.correct),
      pctOrDash(entry.upProbability),
      pctOrDash(entry.downProbability)
    ].join(':');
  }).join('; ');
}

function parsePhaseCell(value) {
  const result = Object.fromEntries(PHASES.map((phase) => [phase.key, null]));
  if (!value || value === '--') return result;
  for (const part of String(value).split(';')) {
    const cells = part.trim().split(':').map((cell) => cell.trim());
    const phase = PHASES.find((item) => item.label === cells[0]);
    if (!phase || cells[1] === '--') continue;
    result[phase.key] = {
      direction: parseDirectionOrNull(cells[1]),
      correct: parseResultOrNull(cells[2]),
      upProbability: pctFromDisplayOrNull(cells[3]),
      downProbability: pctFromDisplayOrNull(cells[4]),
      sampled: true
    };
  }
  return result;
}

function phaseChecksFromCells(techCell, polymarketCell, compositeCell = '') {
  const checks = {
    tech: parsePhaseCell(techCell),
    polymarket: parsePhaseCell(polymarketCell),
    composite: parsePhaseCell(compositeCell)
  };
  for (const phase of PHASES) {
    const tech = checks.tech[phase.key];
    const polymarket = checks.polymarket[phase.key];
    if (!checks.composite[phase.key] && tech?.direction && polymarket?.direction) {
      const composite = buildCompositePhaseEntry(tech, polymarket, phase.key);
      if (composite.direction === tech.direction && tech.correct != null) {
        composite.correct = tech.correct;
      } else if (composite.direction === polymarket.direction && polymarket.correct != null) {
        composite.correct = polymarket.correct;
      }
      composite.sampled = isSampledPhaseEntry(tech) && isSampledPhaseEntry(polymarket);
      checks.composite[phase.key] = composite;
    }
  }
  return checks;
}

function isFifteenMinutePmLockSkipCandidate(record) {
  if (resolveRecordTimeframe(record) !== '15m') return false;
  if (record.decisionLocked) return false;
  const id = String(record?.id || '');
  if (!id.startsWith('15m_') && !id.startsWith('5m_')) return false;
  return Boolean(record.polymarketPredictedDirection || record.skipReason || record.lastPmDirection);
}

function normalizeRecordId(id) {
  const text = String(id || '').trim();
  if (!text) return text;
  if (text.startsWith('5m_') || text.startsWith('15m_')) return text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return `15m_${text}`;
  return text;
}

function isValidRecordId(id) {
  if (typeof id !== 'string' || id.includes('\u6b63\u786e\u7387')) return false;
  if (/^(5m|15m)_\d{4}-\d{2}-\d{2}T/.test(id)) return true;
  return /^\d{4}-\d{2}-\d{2}T/.test(id) && /_[A-Z0-9-]+$/.test(id);
}

function countPredictionRecordRows(markdown) {
  if (!markdown) return 0;
  return markdown
    .split('\n')
    .filter((line) => /^\|\s*(?:5m_|15m_|\d{4}-\d{2}-\d{2}T)/.test(line.trim()))
    .length;
}

function parseRecords(markdown) {
  if (!markdown) return [];
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.includes('---') && !/\|\s*ID\s*\|/.test(line))
    .map((line) => parseRecordLine(line))
    .filter((cells) => cells.length >= 13 && isValidRecordId(cells[0]))
    .map(parseRecordCells);
}

function parseRecordLine(line) {
  const trimmed = line.trim();
  const idMatch = trimmed.match(/^\|\s*((?:5m|15m)_[^|]+)/);
  if (!idMatch) {
    return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  }
  const extraMarker = '| locked=';
  const extraIdx = trimmed.indexOf(extraMarker);
  if (extraIdx === -1) {
    return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  }
  const prefix = trimmed.slice(1, extraIdx).split('|').map((cell) => cell.trim());
  const extraBody = trimmed.slice(extraIdx + '| locked='.length);
  let extraRaw = extraBody.trim();
  if (extraRaw.endsWith('|')) extraRaw = extraRaw.slice(0, -1).trim();
  // Recover legacy rows where | inside PM锁定扩展 broke the table into extra columns.
  if (/\|\s*\w+=/.test(extraRaw)) {
    extraRaw = extraRaw.split(/\s*\|\s*/).filter(Boolean).join(';');
  }
  return [...prefix, extraRaw];
}

function parseRecordCells(cells) {
  if (cells.length >= 36) {
    const extra = parseIntervalPmExtraCell(cells[35]);
    return {
      id: normalizeRecordId(cells[0]),
      timeframe: extra.timeframe || resolveRecordTimeframe({ id: cells[0] }),
      firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
      predictedAtIso: parseShanghaiDisplay(cells[2]),
      targetTimeIso: parseShanghaiDisplay(cells[3]),
      symbol: cells[4],
      startPrice: numberFromDisplay(cells[5]),
      firstPredictedDirection: cells[6] === TEXT.up ? 'up' : 'down',
      firstUpProbability: pctFromDisplay(cells[7]),
      firstDownProbability: pctFromDisplay(cells[8]),
      firstCorrect: cells[9] === TEXT.correct,
      predictedDirection: cells[10] === TEXT.up ? 'up' : 'down',
      upProbability: pctFromDisplay(cells[11]),
      downProbability: pctFromDisplay(cells[12]),
      correct: cells[13] === TEXT.correct,
      firstPolymarketPredictedDirection: parseDirectionOrNull(cells[14]),
      firstPolymarketUpProbability: pctFromDisplayOrNull(cells[15]),
      firstPolymarketDownProbability: pctFromDisplayOrNull(cells[16]),
      firstPolymarketCorrect: parseResultOrNull(cells[17]),
      polymarketPredictedDirection: parseDirectionOrNull(cells[18]),
      polymarketUpProbability: pctFromDisplayOrNull(cells[19]),
      polymarketDownProbability: pctFromDisplayOrNull(cells[20]),
      polymarketCorrect: parseResultOrNull(cells[21]),
      phaseChecks: phaseChecksFromCells(cells[22], cells[23], cells[24]),
      directionFlips: Number(cells[25]) || 0,
      sampleCount: Number(cells[26]) || 1,
      estimatedClose: numberFromDisplay(cells[27]),
      actualPrice: numberFromDisplay(cells[28]),
      actualDirection: cells[29] === TEXT.up ? 'up' : 'down',
      predictedMovePct: pctFromDisplay(cells[30]),
      actualMovePct: pctFromDisplay(cells[31]),
      confidence: pctFromDisplay(cells[32]),
      polymarketMarket: cells[33] === '--' ? '' : cells[33],
      recentActualDirections: parseRecentDirections(cells[34]),
      ...extra,
      slotClosePrice: extra.slotClosePrice ?? numberFromDisplay(cells[28])
    };
  }

  if (cells.length >= 34) {
    return {
      id: normalizeRecordId(cells[0]),
      timeframe: resolveRecordTimeframe({ id: cells[0] }),
      firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
      predictedAtIso: parseShanghaiDisplay(cells[2]),
      targetTimeIso: parseShanghaiDisplay(cells[3]),
      symbol: cells[4],
      startPrice: numberFromDisplay(cells[5]),
      firstPredictedDirection: cells[6] === TEXT.up ? 'up' : 'down',
      firstUpProbability: pctFromDisplay(cells[7]),
      firstDownProbability: pctFromDisplay(cells[8]),
      firstCorrect: cells[9] === TEXT.correct,
      predictedDirection: cells[10] === TEXT.up ? 'up' : 'down',
      upProbability: pctFromDisplay(cells[11]),
      downProbability: pctFromDisplay(cells[12]),
      correct: cells[13] === TEXT.correct,
      firstPolymarketPredictedDirection: parseDirectionOrNull(cells[14]),
      firstPolymarketUpProbability: pctFromDisplayOrNull(cells[15]),
      firstPolymarketDownProbability: pctFromDisplayOrNull(cells[16]),
      firstPolymarketCorrect: parseResultOrNull(cells[17]),
      polymarketPredictedDirection: parseDirectionOrNull(cells[18]),
      polymarketUpProbability: pctFromDisplayOrNull(cells[19]),
      polymarketDownProbability: pctFromDisplayOrNull(cells[20]),
      polymarketCorrect: parseResultOrNull(cells[21]),
      phaseChecks: phaseChecksFromCells(cells[22], cells[23], cells[24]),
      directionFlips: Number(cells[25]) || 0,
      sampleCount: Number(cells[26]) || 1,
      estimatedClose: numberFromDisplay(cells[27]),
      actualPrice: numberFromDisplay(cells[28]),
      actualDirection: cells[29] === TEXT.up ? 'up' : 'down',
      predictedMovePct: pctFromDisplay(cells[30]),
      actualMovePct: pctFromDisplay(cells[31]),
      confidence: pctFromDisplay(cells[32]),
      polymarketMarket: cells[33] === '--' ? '' : cells[33],
      recentActualDirections: parseRecentDirections(cells[34])
    };
  }

  if (cells.length >= 33) {
    return {
      id: normalizeRecordId(cells[0]),
      timeframe: resolveRecordTimeframe({ id: cells[0] }),
      firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
      predictedAtIso: parseShanghaiDisplay(cells[2]),
      targetTimeIso: parseShanghaiDisplay(cells[3]),
      symbol: cells[4],
      startPrice: numberFromDisplay(cells[5]),
      firstPredictedDirection: cells[6] === TEXT.up ? 'up' : 'down',
      firstUpProbability: pctFromDisplay(cells[7]),
      firstDownProbability: pctFromDisplay(cells[8]),
      firstCorrect: cells[9] === TEXT.correct,
      predictedDirection: cells[10] === TEXT.up ? 'up' : 'down',
      upProbability: pctFromDisplay(cells[11]),
      downProbability: pctFromDisplay(cells[12]),
      correct: cells[13] === TEXT.correct,
      firstPolymarketPredictedDirection: parseDirectionOrNull(cells[14]),
      firstPolymarketUpProbability: pctFromDisplayOrNull(cells[15]),
      firstPolymarketDownProbability: pctFromDisplayOrNull(cells[16]),
      firstPolymarketCorrect: parseResultOrNull(cells[17]),
      polymarketPredictedDirection: parseDirectionOrNull(cells[18]),
      polymarketUpProbability: pctFromDisplayOrNull(cells[19]),
      polymarketDownProbability: pctFromDisplayOrNull(cells[20]),
      polymarketCorrect: parseResultOrNull(cells[21]),
      phaseChecks: phaseChecksFromCells(cells[22], cells[23]),
      directionFlips: Number(cells[24]) || 0,
      sampleCount: Number(cells[25]) || 1,
      estimatedClose: numberFromDisplay(cells[26]),
      actualPrice: numberFromDisplay(cells[27]),
      actualDirection: cells[28] === TEXT.up ? 'up' : 'down',
      predictedMovePct: pctFromDisplay(cells[29]),
      actualMovePct: pctFromDisplay(cells[30]),
      confidence: pctFromDisplay(cells[31]),
      polymarketMarket: cells[32] === '--' ? '' : cells[32]
    };
  }

  if (cells.length >= 31) {
    return {
      id: normalizeRecordId(cells[0]),
      timeframe: resolveRecordTimeframe({ id: cells[0] }),
      firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
      predictedAtIso: parseShanghaiDisplay(cells[2]),
      targetTimeIso: parseShanghaiDisplay(cells[3]),
      symbol: cells[4],
      startPrice: numberFromDisplay(cells[5]),
      firstPredictedDirection: cells[6] === TEXT.up ? 'up' : 'down',
      firstUpProbability: pctFromDisplay(cells[7]),
      firstDownProbability: pctFromDisplay(cells[8]),
      firstCorrect: cells[9] === TEXT.correct,
      predictedDirection: cells[10] === TEXT.up ? 'up' : 'down',
      upProbability: pctFromDisplay(cells[11]),
      downProbability: pctFromDisplay(cells[12]),
      correct: cells[13] === TEXT.correct,
      firstPolymarketPredictedDirection: parseDirectionOrNull(cells[14]),
      firstPolymarketUpProbability: pctFromDisplayOrNull(cells[15]),
      firstPolymarketDownProbability: pctFromDisplayOrNull(cells[16]),
      firstPolymarketCorrect: parseResultOrNull(cells[17]),
      polymarketPredictedDirection: parseDirectionOrNull(cells[18]),
      polymarketUpProbability: pctFromDisplayOrNull(cells[19]),
      polymarketDownProbability: pctFromDisplayOrNull(cells[20]),
      polymarketCorrect: parseResultOrNull(cells[21]),
      directionFlips: Number(cells[22]) || 0,
      sampleCount: Number(cells[23]) || 1,
      estimatedClose: numberFromDisplay(cells[24]),
      actualPrice: numberFromDisplay(cells[25]),
      actualDirection: cells[26] === TEXT.up ? 'up' : 'down',
      predictedMovePct: pctFromDisplay(cells[27]),
      actualMovePct: pctFromDisplay(cells[28]),
      confidence: pctFromDisplay(cells[29]),
      polymarketMarket: cells[30] === '--' ? '' : cells[30]
    };
  }

  if (cells.length >= 27) {
    const polymarketDirection = parseDirectionOrNull(cells[14]);
    const polymarketUpProbability = pctFromDisplayOrNull(cells[15]);
    const polymarketDownProbability = pctFromDisplayOrNull(cells[16]);
    const polymarketCorrect = parseResultOrNull(cells[17]);
    return {
      id: normalizeRecordId(cells[0]),
      timeframe: resolveRecordTimeframe({ id: cells[0] }),
      firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
      predictedAtIso: parseShanghaiDisplay(cells[2]),
      targetTimeIso: parseShanghaiDisplay(cells[3]),
      symbol: cells[4],
      startPrice: numberFromDisplay(cells[5]),
      firstPredictedDirection: cells[6] === TEXT.up ? 'up' : 'down',
      firstUpProbability: pctFromDisplay(cells[7]),
      firstDownProbability: pctFromDisplay(cells[8]),
      firstCorrect: cells[9] === TEXT.correct,
      predictedDirection: cells[10] === TEXT.up ? 'up' : 'down',
      upProbability: pctFromDisplay(cells[11]),
      downProbability: pctFromDisplay(cells[12]),
      correct: cells[13] === TEXT.correct,
      firstPolymarketPredictedDirection: polymarketDirection,
      firstPolymarketUpProbability: polymarketUpProbability,
      firstPolymarketDownProbability: polymarketDownProbability,
      firstPolymarketCorrect: polymarketCorrect,
      polymarketPredictedDirection: polymarketDirection,
      polymarketUpProbability,
      polymarketDownProbability,
      polymarketCorrect,
      directionFlips: Number(cells[18]) || 0,
      sampleCount: Number(cells[19]) || 1,
      estimatedClose: numberFromDisplay(cells[20]),
      actualPrice: numberFromDisplay(cells[21]),
      actualDirection: cells[22] === TEXT.up ? 'up' : 'down',
      predictedMovePct: pctFromDisplay(cells[23]),
      actualMovePct: pctFromDisplay(cells[24]),
      confidence: pctFromDisplay(cells[25]),
      polymarketMarket: cells[26] === '--' ? '' : cells[26]
    };
  }

  if (cells.length >= 22) {
    return {
      id: normalizeRecordId(cells[0]),
      timeframe: resolveRecordTimeframe({ id: cells[0] }),
      firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
      predictedAtIso: parseShanghaiDisplay(cells[2]),
      targetTimeIso: parseShanghaiDisplay(cells[3]),
      symbol: cells[4],
      startPrice: numberFromDisplay(cells[5]),
      firstPredictedDirection: cells[6] === TEXT.up ? 'up' : 'down',
      firstUpProbability: pctFromDisplay(cells[7]),
      firstDownProbability: pctFromDisplay(cells[8]),
      firstCorrect: cells[9] === TEXT.correct,
      predictedDirection: cells[10] === TEXT.up ? 'up' : 'down',
      upProbability: pctFromDisplay(cells[11]),
      downProbability: pctFromDisplay(cells[12]),
      correct: cells[13] === TEXT.correct,
      directionFlips: Number(cells[14]) || 0,
      sampleCount: Number(cells[15]) || 1,
      estimatedClose: numberFromDisplay(cells[16]),
      actualPrice: numberFromDisplay(cells[17]),
      actualDirection: cells[18] === TEXT.up ? 'up' : 'down',
      predictedMovePct: pctFromDisplay(cells[19]),
      actualMovePct: pctFromDisplay(cells[20]),
      confidence: pctFromDisplay(cells[21])
    };
  }

  if (cells.length >= 21) {
    return {
      id: normalizeRecordId(cells[0]),
      timeframe: resolveRecordTimeframe({ id: cells[0] }),
      firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
      predictedAtIso: parseShanghaiDisplay(cells[2]),
      targetTimeIso: parseShanghaiDisplay(cells[3]),
      symbol: cells[4],
      startPrice: numberFromDisplay(cells[5]),
      firstPredictedDirection: cells[6] === TEXT.up ? 'up' : 'down',
      firstUpProbability: pctFromDisplay(cells[7]),
      firstDownProbability: pctFromDisplay(cells[8]),
      predictedDirection: cells[9] === TEXT.up ? 'up' : 'down',
      upProbability: pctFromDisplay(cells[10]),
      downProbability: pctFromDisplay(cells[11]),
      directionFlips: Number(cells[12]) || 0,
      sampleCount: Number(cells[13]) || 1,
      estimatedClose: numberFromDisplay(cells[14]),
      actualPrice: numberFromDisplay(cells[15]),
      actualDirection: cells[16] === TEXT.up ? 'up' : 'down',
      correct: cells[17] === TEXT.correct,
      firstCorrect: (cells[6] === TEXT.up ? 'up' : 'down') === (cells[16] === TEXT.up ? 'up' : 'down'),
      predictedMovePct: pctFromDisplay(cells[18]),
      actualMovePct: pctFromDisplay(cells[19]),
      confidence: pctFromDisplay(cells[20])
    };
  }

  return {
    id: normalizeRecordId(cells[0]),
    predictedAtIso: parseShanghaiDisplay(cells[1]),
    firstPredictedAtIso: parseShanghaiDisplay(cells[1]),
    targetTimeIso: parseShanghaiDisplay(cells[2]),
    symbol: cells[3],
    startPrice: numberFromDisplay(cells[4]),
    estimatedClose: numberFromDisplay(cells[5]),
    actualPrice: numberFromDisplay(cells[6]),
    predictedDirection: cells[7] === TEXT.up ? 'up' : 'down',
    firstPredictedDirection: cells[7] === TEXT.up ? 'up' : 'down',
    actualDirection: cells[8] === TEXT.up ? 'up' : 'down',
    correct: cells[9] === TEXT.correct,
    firstCorrect: cells[9] === TEXT.correct,
    predictedMovePct: pctFromDisplay(cells[10]),
    actualMovePct: pctFromDisplay(cells[11]),
    confidence: pctFromDisplay(cells[12]),
    firstConfidence: pctFromDisplay(cells[12]),
    directionFlips: 0,
    sampleCount: 1
  };
}

function pickLatestNextSlotPrediction(predictions = [], timeframe = '5m') {
  const tf = timeframe === '15m' ? '15m' : '5m';
  const rows = (predictions || []).filter((item) => (
    (item.sourceTimeframe === '15m' ? '15m' : '5m') === tf
    && ['up', 'down'].includes(item.predictedDirection)
  ));
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const aKey = String(a.predictedAtIso || a.predictedSlotIso || '');
    const bKey = String(b.predictedAtIso || b.predictedSlotIso || '');
    return bKey.localeCompare(aKey);
  });
  return rows[0];
}

function recordKey(symbol, targetTimeIso, timeframe = '15m') {
  return `${timeframe}_${targetTimeIso}_${symbol}`;
}

function resolveSignalTimeframe(signal) {
  if (signal?.timeframe === '5m' || Number(signal?.prediction?.horizonMinutes) === 5) return '5m';
  return '15m';
}

function resolveRecordTimeframe(record) {
  if (record?.timeframe === '5m' || record?.timeframe === '15m') return record.timeframe;
  const id = normalizeRecordId(String(record?.id || ''));
  if (id.startsWith('5m_')) return '5m';
  if (id.startsWith('15m_')) return '15m';
  return '15m';
}

function summarizeFifteenMinuteLocks(records) {
  const eligible = records.filter(isCountedFifteenMinuteLockRecord);
  const techEligible = records.filter(
    (record) => resolveRecordTimeframe(record) === '15m' && record.techCorrect != null && (record.lockedTechDirection || record.lastTechDirection)
  );
  const compositeEligible = records.filter(
    (record) => resolveRecordTimeframe(record) === '15m' && record.compositeCorrect != null && (record.lockedCompositeDirection || record.lastCompositeDirection)
  );
  const polymarket = summarizeDirectionOutcomes(
    eligible.filter((record) => record.polymarketCorrect != null),
    (record) => record.polymarketCorrect
  );
  const tech = summarizeDirectionOutcomes(techEligible, (record) => record.techCorrect);
  const composite = summarizeDirectionOutcomes(compositeEligible, (record) => record.compositeCorrect);
  return {
    polymarket,
    tech,
    composite,
    alignment: summarizeFiveMinuteAlignment(records.filter((record) => resolveRecordTimeframe(record) === '15m')),
    buckets: summarizeIntervalPmBuckets(records.filter((record) => resolveRecordTimeframe(record) === '15m'), 900),
    skipped: summarizeFiveMinuteSkipped(records.filter(isFifteenMinutePmLockSkipCandidate))
  };
}

function summarizeStandaloneTimeframe(records) {
  const eligible = records.filter(isCountedFiveMinuteRecord);
  const techEligible = records.filter(
    (record) => resolveRecordTimeframe(record) === '5m' && record.techCorrect != null && (record.lockedTechDirection || record.lastTechDirection)
  );
  const compositeEligible = records.filter(
    (record) => resolveRecordTimeframe(record) === '5m' && record.compositeCorrect != null && (record.lockedCompositeDirection || record.lastCompositeDirection)
  );
  const polymarket = summarizeDirectionOutcomes(
    eligible.filter((record) => record.polymarketCorrect != null),
    (record) => record.polymarketCorrect
  );
  const tech = summarizeDirectionOutcomes(techEligible, (record) => record.techCorrect);
  const composite = summarizeDirectionOutcomes(compositeEligible, (record) => record.compositeCorrect);
  return {
    polymarket,
    tech,
    composite,
    alignment: summarizeFiveMinuteAlignment(records),
    buckets: summarizeFiveMinuteBuckets(records),
    skipped: summarizeFiveMinuteSkipped(records)
  };
}

function isCountedFifteenMinuteLockRecord(record) {
  return resolveRecordTimeframe(record) === '15m' && isExplicitPmLockRecord(record);
}

function isCountedFiveMinuteRecord(record) {
  return resolveRecordTimeframe(record) === '5m' && isExplicitPmLockRecord(record);
}

function summarizeDirectionOutcomes(records, pickCorrect) {
  const total = records.length;
  const correct = records.filter((record) => pickCorrect(record)).length;
  return {
    total,
    correct,
    wrong: total - correct,
    accuracy: total ? correct / total : 0
  };
}

function renderStandaloneTimeframeStatRows(summary, labelPrefix) {
  const rows = [
    ['polymarket', `${labelPrefix} PM`],
    ['tech', `${labelPrefix} Tech`],
    ['composite', `${labelPrefix} Composite`]
  ];
  return rows
    .map(([key, label]) => {
      const stats = summary?.[key] || { total: 0, correct: 0, wrong: 0, accuracy: 0 };
      const detail = stats.total ? `${stats.correct}/${stats.total}` : '\u6682\u65e0\u6570\u636e';
      return `| ${label} \u6b63\u786e\u7387 | ${stats.total ? formatAccuracy(stats.accuracy) : '--'} \u00b7 ${detail} |`;
    })
    .join('\n');
}

export function renderFifteenMinuteLockStrengthStatRows(summary = {}) {
  const strength = summary.buckets?.strength || {};
  const rows = [
    ['strong', '\u5f3a\u9501\u5b9a'],
    ['normal', '\u666e\u901a\u9501\u5b9a'],
    ['weak', '\u5f31\u9501\u5b9a']
  ];
  return rows
    .map(([key, label]) => {
      const stats = strength[key] || { total: 0, correct: 0, wrong: 0, accuracy: 0 };
      const detail = stats.total ? `${stats.correct}/${stats.total}` : '\u6682\u65e0\u6570\u636e';
      return `| 15m PM ${label}\u80dc\u7387 | ${stats.total ? formatAccuracy(stats.accuracy) : '--'} \u00b7 ${detail} |`;
    })
    .join('\n');
}

function renderPmLockSkippedStatRows(skipped = {}, timeframeLabel = '5m') {
  const total = Number(skipped.total) || 0;
  if (!total) return '';
  const reasons = Object.entries(skipped.byReason || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} ${count}`)
    .join(' / ');
  return `| ${timeframeLabel} \u672a\u9501\u5b9a\u7a97\u53e3 | ${total}${reasons ? ` \u00b7 ${reasons}` : ''} |`;
}

function renderPmLockRecordsSection(records = []) {
  const locked = records
    .filter((record) => resolveRecordTimeframe(record) === '5m' || resolveRecordTimeframe(record) === '15m')
    .filter((record) => hasExplicitPmLockMetadata(record) && resolveLockedPolymarketDirection(record))
    .sort((a, b) => a.targetTimeIso.localeCompare(b.targetTimeIso) || resolveRecordTimeframe(a).localeCompare(resolveRecordTimeframe(b)));
  if (!locked.length) return '';
  const rows = locked.map((record) => {
    const timeframe = resolveRecordTimeframe(record);
    const direction = resolveLockedPolymarketDirection(record);
    return [
      timeframe,
      formatShanghaiTime(record.targetTimeIso),
      record.symbol || 'BTC-USD',
      directionText(direction),
      record.lockStrength || '--',
      pctOrDash(record.lockedPmGap),
      formatShanghaiTime(record.decisionLockedAtIso || record.firstPredictedAtIso || record.predictedAtIso),
      resultTextOrDash(record.polymarketCorrect)
    ].map(escapeCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
  }).join('\n');
  return `
## PM \u9501\u5b9a\u8bb0\u5f55

| \u5468\u671f | \u7a97\u53e3\u7ed3\u675f | \u6807\u7684 | \u9501\u5b9a\u65b9\u5411 | \u5f3a\u5f31\u6863 | PM gap | \u9501\u5b9a\u65f6\u523b | \u7ed3\u679c |
| --- | --- | --- | --- | --- | ---: | --- | --- |
${rows}
`;
}

export function renderFiveMinuteLockStrengthStatRows(summary = {}) {
  const strength = summary.buckets?.strength || {};
  const rows = [
    ['strong', '\u5f3a\u9501\u5b9a'],
    ['normal', '\u666e\u901a\u9501\u5b9a'],
    ['weak', '\u5f31\u9501\u5b9a']
  ];
  return rows
    .map(([key, label]) => {
      const stats = strength[key] || { total: 0, correct: 0, wrong: 0, accuracy: 0 };
      const detail = stats.total ? `${stats.correct}/${stats.total}` : '\u6682\u65e0\u6570\u636e';
      return `| 5m PM ${label}\u80dc\u7387 | ${stats.total ? formatAccuracy(stats.accuracy) : '--'} \u00b7 ${detail} |`;
    })
    .join('\n');
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function quotePrice(quote) {
  if (!quote) return null;
  const price = Number(quote.price);
  if (Number.isFinite(price) && price > 0) return price;
  const bid = Number(quote.bid_inclusive_of_sell_spread);
  const ask = Number(quote.ask_inclusive_of_buy_spread);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
  return null;
}

function formatShanghaiDate(value) {
  return SHANGHAI_DATE_FORMATTER.format(new Date(value));
}

function formatShanghaiTime(value) {
  const date = new Date(value);
  const datePart = formatShanghaiDate(date);
  const timePart = SHANGHAI_TIME_FORMATTER.format(date);
  return `${datePart} ${timePart}`;
}

function parseShanghaiDisplay(value) {
  // This is only used to preserve existing rows for sorting; +08:00 matches Asia/Shanghai.
  return `${value.replace(' ', 'T')}+08:00`;
}

function directionText(value) {
  return value === 'up' ? TEXT.up : TEXT.down;
}

function directionTextOrDash(value) {
  return value === 'up' || value === 'down' ? directionText(value) : '--';
}

function resultText(value) {
  return value ? TEXT.correct : TEXT.wrong;
}

function resultTextOrDash(value) {
  return value == null ? '--' : resultText(value);
}

function usd(value) {
  return `$${Number(value).toFixed(Number(value) < 1 ? 6 : 2)}`;
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function pctOrDash(value) {
  return Number.isFinite(Number(value)) ? pct(value) : '--';
}

function formatAccuracy(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function numberOrDash(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : '--';
}

function shortId(value) {
  const text = String(value || '');
  if (!text) return '--';
  return text.length > 14 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function liveOrderStatusWithExit(order) {
  if (order?.positionStatus === 'closed' && order?.orderSide !== 'SELL') {
    const exit = liveExitLabel(order.exitStatus);
    if (Number(order.pnl) > 0) return exit ? `已结算-赢-${exit}` : '已结算-赢';
    if (Number(order.pnl) < 0) return exit ? `已结算-输-${exit}` : '已结算-输';
    return exit ? `已关闭-${exit}` : '已关闭';
  }
  return liveOrderStatusText(order);
}

function liveExitLabel(exitStatus) {
  const status = String(exitStatus || '');
  if (!status) return '';
  if (status === 'dust-undersized-fill') return '灰尘仓（成交过小）';
  if (status === 'dust-topup-merged') return '灰尘加仓已合并';
  if (status === 'dust-unsellable' || status.startsWith('dust-')) return '灰尘仓';
  if (status === 'expiry') return '到期';
  if (status === 'take-profit' || status === 'dynamic-take-profit' || status === 'trailing-take-profit') {
    return status === 'trailing-take-profit' ? '回撤止盈' : '止盈';
  }
  if (status === 'stop-loss' || status === 'dynamic-stop-loss' || status === 'hard-stop-loss') return '止损';
  if (status === 'direction-reversal-stop') return '反转止损';
  if (status === 'time-stop') return '时间止损';
  if (status === 'manual-exit') return '手动';
  return status;
}

function liveOrderStatusText(order) {
  if (order.status === 'blocked') return '拦截';
  if (order.exitStatus === 'expired-unfilled') return '未成交过期';
  if (order.orderSide === 'SELL') return order.exitStatus || '卖出';
  if (order.positionStatus === 'closed') return Number(order.pnl) > 0 ? '已结算-赢' : Number(order.pnl) < 0 ? '已结算-输' : '已关闭';
  if (order.positionStatus === 'open') return '持仓中';
  if (order.status === 'pending') return '待成交';
  return order.status || '--';
}
function formatSignedUsd(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? '+' : '-'}$${Math.abs(number).toFixed(2)}`;
}

function directionProbability(record, direction) {
  if (record.predictedDirection === direction) return Number(record.confidence);
  return 1 - Number(record.confidence);
}

function numberFromDisplay(value) {
  return Number(String(value).replace(/[$,%]/g, ''));
}

function pctFromDisplay(value) {
  return Number(String(value).replace('%', '')) / 100;
}

function pctFromDisplayOrNull(value) {
  if (!value || value === '--') return null;
  const parsed = pctFromDisplay(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max, fallback = min) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function parseDirectionOrNull(value) {
  if (value === TEXT.up) return 'up';
  if (value === TEXT.down) return 'down';
  return null;
}

function parseResultOrNull(value) {
  if (value === TEXT.correct) return true;
  if (value === TEXT.wrong) return false;
  return null;
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|');
}

export {
  hasExplicitPmLockMetadata,
  isExplicitPmLockRecord,
  resolveLockedPolymarketDirection,
  withFiveMinuteLockFallbacks
};
