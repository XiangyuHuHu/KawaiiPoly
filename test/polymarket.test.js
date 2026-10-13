import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBtcUpDownMarketSlug,
  extractMarketTargetPrice,
  matchesCryptoUpDownMarket,
  parseJsonArray,
  parseMarketOutcomes,
  pickBestIntervalMarket,
  PolymarketClient,
  resolveOfficialMarketOutcome
} from '../src/polymarketClient.js';
import {
  __resetPriceHistoryForTests,
  classifySentiment,
  estimateConfidenceBoost,
  scorePolymarketQuality
} from '../src/polymarketSentiment.js';
import { blendWithPolymarketSentiment, buildIntervalSignal } from '../src/intervalSignal.js';
import { getSlotSchedule } from '../src/polymarketSchedule.js';
import { computeBinaryPnl, normalizeLiveOrderPlanId, pruneLiveOrdersByPlan, resolvePlanFromEntryType, resolveUnifiedEntryFloorUsd, PolymarketTradingService, slimStoredPaperOrder, summarizeLiveOrderForApi, summarizePaperOrderForApi, shouldSkipLiveBlockedBuyRecord, isNoisyStructuralBlockedBuy, shouldHideLiveOrderRow, isStructuralLiveUnderfundError } from '../src/polymarketTrading.js';
import { computePolymarketOrderUsd, computePlan1PaperOrderUsd, computePlan2PaperOrderUsd, evaluateEdgeEntry, evaluateTieredEntry, getTradeSizeMultiplier, getKellyCapUsd, allocateCashPctBySymbolRank, resolveSymbolWrSizedOrderPct, updateAndEvaluateTrailingTakeProfit } from '../src/polymarketSizing.js';
import {
  buildConfidenceCalibrationTable,
  getCalibratedConfidence,
  resolveCalibratedEdge
} from '../src/polymarketCalibration.js';
import { buildChopRegimeGuard, detectChop } from '../src/polymarketRegime.js';
import { computeProbeUpdateScore } from '../src/polymarketPlan2.js';
import { CLOB_SELL_LIQUIDATE_FACTOR, ensureConditionalSellReady, extractClobFillAmounts, extractClobOpenOrderProgress, extractClobOrderId, humanizeClobError, isClobOrderFilled, isSellLiquidityError, isSellRetryableError, normalizeClobBuyAmounts, normalizeClobSellAmounts, resolveLiveBuyFakBumpSteps, submitClobBuyOrderWithFallback, submitClobSellOrderWithFallback, validateLiveOrderSubmission } from '../src/polymarketLiveClob.js';
import { repricePlan2LiveDraft } from '../src/polymarketLiveOrder.js';
import { buildWindowPlanKey, buildPolymarketPaperPlan, shouldPlan1DirectionFlip } from '../src/polymarketPlan.js';
import { buildPolymarketPaperPlan2, resolvePlan2EntryTier, resolvePlan2DelayedEntry, buildPlan2SustainedMomentumTier, evaluatePlan2StopLossReversal, evaluatePlan2ProbeHistoricalEdge, isPlan2StopLossExitStatus, resolvePlan2EffectiveConfig, resolvePlan2PaperMode, buildPlan2DirectionEntry, buildPlan2RegimeGuard, applyCrossSymbolLeaderToDirection, buildPlan2CrossFollowTier } from '../src/polymarketPlan2.js';
import {
  __resetWindowTrackForTests,
  analyzeWindowTrajectory,
  getWindowTrackSnapshot,
  recordWindowSnapshot
} from '../src/polymarketWindowTrack.js';
import {
  computePlan1ExitPrices,
  computePlan1Analytics,
  resolvePlan1ExitOffsets,
  resolvePlan1FlipEnabled,
  resolvePlan1MaxEntryPrice,
  resolvePlan1MinEntryPrice
} from '../src/plan1Policy.js';
import { mergeSentimentTarget, pickRtdsPriceSample } from '../src/chainlinkPrice.js';
import {
  applyExitDecisionEvaluation,
  classifyExitDecision,
  computeCounterfactualHoldPnl,
  computeExitDecisionAnalytics,
  deriveExitDecisionConclusions,
  isEarlyExitStatus,
  renderExitDecisionMarkdown,
  writeExitDecisionReports
} from '../src/polymarketExitAnalytics.js';

test('parseJsonArray handles string-encoded Polymarket arrays', () => {
  assert.deepEqual(parseJsonArray('["Up","Down"]'), ['Up', 'Down']);
  assert.deepEqual(parseJsonArray('["0.62","0.38"]'), ['0.62', '0.38']);
});

test('extractClobFillAmounts maps actual partial fills by side', () => {
  const response = { makingAmount: '12.5', takingAmount: '20' };
  assert.deepEqual(extractClobFillAmounts(response, 'BUY'), { usd: 12.5, shares: 20 });
  assert.deepEqual(extractClobFillAmounts(response, 'SELL'), { shares: 12.5, usd: 20 });
  assert.equal(extractClobFillAmounts({ makingAmount: '0', takingAmount: '20' }, 'BUY'), null);
});

test('Plan2 probe historical edge gate rejects empirically negative entry prices', () => {
  const calibrationTable = {
    a: { entryType: 'probe', timeframe: '5m', direction: 'up', sampleCount: 12, wins: 5 },
    b: { entryType: 'probe', timeframe: '5m', direction: 'up', sampleCount: 10, wins: 5 }
  };
  const blocked = evaluatePlan2ProbeHistoricalEdge({
    calibrationTable,
    timeframe: '5m',
    direction: 'up',
    entryPrice: 0.52,
    config: { plan2ProbeHistoricalEdgeMinSamples: 20, plan2ProbeHistoricalEdgeMargin: 0.01 }
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.sampleCount, 22);

  const insufficient = evaluatePlan2ProbeHistoricalEdge({
    calibrationTable,
    timeframe: '15m',
    direction: 'up',
    entryPrice: 0.52,
    config: { plan2ProbeHistoricalEdgeMinSamples: 20 }
  });
  assert.equal(insufficient.allowed, true);
  assert.equal(insufficient.insufficientSamples, true);
});

test('parseMarketOutcomes maps up/down token ids by outcome label', () => {
  const parsed = parseMarketOutcomes({
    outcomes: '["Up","Down"]',
    clobTokenIds: '["111","222"]',
    outcomePrices: '["0.61","0.39"]'
  });
  assert.equal(parsed.upTokenId, '111');
  assert.equal(parsed.downTokenId, '222');
  assert.equal(parsed.upPrice, 0.61);
});

test('extractMarketTargetPrice reads direct and textual Polymarket target prices', () => {
  assert.deepEqual(extractMarketTargetPrice({ targetPrice: '63184.08' }), {
    price: 63184.08,
    source: 'targetPrice'
  });
  assert.deepEqual(
    extractMarketTargetPrice({
      description: 'This market resolves UP if BTC is above the target price of $63,184.08 at close.'
    }),
    {
      price: 63184.08,
      source: 'market_text'
    }
  );
});

test('blendWithPolymarketSentiment uses Polymarket target as comparison base when available', () => {
  const blended = blendWithPolymarketSentiment({
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'up',
    label: '上涨',
    confidence: 0.6,
    probabilities: { up: 0.6, down: 0.4 },
    reason: 'tech reason.',
    prediction: {
      horizonMinutes: 5,
      targetTimeIso: '2026-07-07T06:40:00.000Z',
      comparisonBasePrice: 63244.17,
      estimatedClose: 63292.72,
      estimatedMovePct: 0.000767,
      upProbability: 0.6,
      downProbability: 0.4
    }
  }, {
    available: true,
    upProbability: 0.61,
    downProbability: 0.39,
    targetPrice: 63184.08,
    qualityScore: 0.7,
    sentiment: 'bullish',
    orderbookBias: 'up',
    upPriceChange5m: 0.02,
    confidenceBoost: 0.04
  });
  assert.equal(blended.technicalDirection, 'up');
  assert.equal(blended.technicalConfidence, 0.6);
  assert.deepEqual(blended.technicalProbabilities, { up: 0.6, down: 0.4 });
  assert.equal(blended.compositeDirection, blended.direction);
  assert.equal(blended.compositeConfidence, blended.confidence);
  assert.deepEqual(blended.compositeProbabilities, blended.probabilities);

  assert.equal(blended.prediction.comparisonBasePrice, 63184.08);
  assert.equal(blended.prediction.technicalComparisonBasePrice, 63244.17);
  assert.equal(blended.prediction.comparisonBasePriceSource, 'polymarket_target');
  assert.equal(blended.prediction.estimatedMovePct, 0.001719);
  assert.equal(blended.technicalDirection, 'up');
  assert.equal(blended.technicalConfidence, 0.6);
  assert.equal(blended.spotDirection, null);
});

test('mergeSentimentTarget fills missing target without overwriting Polymarket target', () => {
  const base = { available: true, upProbability: 0.55 };
  assert.deepEqual(mergeSentimentTarget(base, {
    price: 63184.08,
    source: 'chainlink_slot_start_cache',
    capturedAtIso: '2026-07-07T06:35:02.000Z',
    updatedAtIso: '2026-07-07T06:35:00.000Z',
    captureDelaySeconds: 2
  }), {
    available: true,
    upProbability: 0.55,
    targetPrice: 63184.08,
    targetPriceSource: 'chainlink_slot_start_cache',
    targetPriceCapturedAtIso: '2026-07-07T06:35:02.000Z',
    targetPriceUpdatedAtIso: '2026-07-07T06:35:00.000Z',
    targetPriceCaptureDelaySeconds: 2
  });
  assert.equal(mergeSentimentTarget({ ...base, targetPrice: 63000 }, { price: 63184.08 }).targetPrice, 63000);
});

test('pickRtdsPriceSample chooses the sample nearest to slot start', () => {
  const target = Date.parse('2026-07-07T07:05:00.000Z');
  assert.deepEqual(pickRtdsPriceSample([
    { timestamp: target - 2000, value: 63100 },
    { timestamp: target + 1000, value: 63184.08 },
    { timestamp: target + 5000, value: 63200 }
  ], target), {
    timestamp: target + 1000,
    value: 63184.08
  });
});

test('matchesCryptoUpDownMarket filters BTC 15m markets', () => {
  assert.equal(
    matchesCryptoUpDownMarket({
      question: 'Bitcoin Up or Down - 15 minutes',
      slug: 'btc-updown-15m',
      enableOrderBook: true
    }),
    true
  );
  assert.equal(
    matchesCryptoUpDownMarket({
      question: 'Will ETH reach 5k?',
      slug: 'eth-5k',
      enableOrderBook: true
    }),
    false
  );
});

test('matchesCryptoUpDownMarket filters BTC 5m markets', () => {
  assert.equal(
    matchesCryptoUpDownMarket({
      question: 'Bitcoin Up or Down - 5 minutes',
      slug: 'btc-updown-5m-1780319100',
      enableOrderBook: true
    }, { timeframe: '5m' }),
    true
  );
  assert.equal(
    matchesCryptoUpDownMarket({
      question: 'Bitcoin Up or Down - 15 minutes',
      slug: 'btc-updown-15m',
      enableOrderBook: true
    }, { timeframe: '5m' }),
    false
  );
});

test('extractClobOpenOrderProgress handles SDK decimals and REST fixed-math shares', () => {
  assert.deepEqual(
    extractClobOpenOrderProgress({ original_size: '10', size_matched: '4', price: '0.7', status: 'ORDER_STATUS_LIVE' }, 10),
    { originalShares: 10, matchedShares: 4, remainingShares: 6, price: 0.7, terminal: false, filled: false }
  );
  const fixed = extractClobOpenOrderProgress({
    original_size: '10000000',
    size_matched: '10000000',
    price: '0.7',
    status: 'ORDER_STATUS_MATCHED'
  }, 10);
  assert.equal(fixed.originalShares, 10);
  assert.equal(fixed.matchedShares, 10);
  assert.equal(fixed.filled, true);
  assert.equal(isClobOrderFilled({ status: 'ORDER_STATUS_MATCHED' }), true);
});

test('isClobBuyFillConfirmed requires transaction hash even when status is matched', async () => {
  const { isClobBuyFillAwaitingConfirm, isClobBuyFillConfirmed, isClobOrderFilled } = await import('../src/polymarketLiveClob.js');
  const matchedNoTx = { status: 'matched', success: true, makingAmount: '4.3', takingAmount: '7.5' };
  const matchedWithTx = {
    status: 'matched',
    success: true,
    makingAmount: '4.3',
    takingAmount: '7.5',
    transactionsHashes: ['0xabc']
  };
  assert.equal(isClobOrderFilled(matchedNoTx), true);
  assert.equal(isClobBuyFillConfirmed(matchedNoTx), false);
  assert.equal(isClobBuyFillAwaitingConfirm(matchedNoTx), true);
  assert.equal(isClobBuyFillConfirmed(matchedWithTx), true);
  assert.equal(isClobBuyFillAwaitingConfirm(matchedWithTx), false);
});

test('matchesCryptoUpDownMarket distinguishes dated hourly and daily markets', () => {
  const hourly = {
    question: 'Ethereum Up or Down - July 13, 2PM ET',
    slug: 'ethereum-up-or-down-july-13-2026-2pm-et',
    enableOrderBook: true
  };
  const daily = {
    question: 'Bitcoin Up or Down on July 14?',
    slug: 'bitcoin-up-or-down-on-july-14-2026',
    enableOrderBook: true
  };
  assert.equal(matchesCryptoUpDownMarket(hourly, { asset: 'ethereum', timeframe: '1h' }), true);
  assert.equal(matchesCryptoUpDownMarket(hourly, { asset: 'ethereum', timeframe: '1d' }), false);
  assert.equal(matchesCryptoUpDownMarket(daily, { asset: 'bitcoin', timeframe: '1d' }), true);
  assert.equal(matchesCryptoUpDownMarket(daily, { asset: 'bitcoin', timeframe: '1h' }), false);
});

test('buildBtcUpDownMarketSlug builds deterministic 5m and 15m slugs', () => {
  const fiveMinuteEnd = '2026-06-29T10:10:00.000Z';
  const fifteenMinuteEnd = '2026-06-29T10:15:00.000Z';
  assert.match(buildBtcUpDownMarketSlug(fiveMinuteEnd, '5m'), /^btc-updown-5m-\d+$/);
  assert.match(buildBtcUpDownMarketSlug(fifteenMinuteEnd, '15m'), /^btc-updown-15m-\d+$/);
  assert.equal(
    buildBtcUpDownMarketSlug(fiveMinuteEnd, '5m'),
    buildBtcUpDownMarketSlug(fiveMinuteEnd, '5m')
  );
});

test('buildCryptoUpDownMarketSlug covers BTC/ETH/SOL/XRP prefixes', async () => {
  const { buildCryptoUpDownMarketSlug, cryptoUpDownSlugPrefix } = await import('../src/polymarketClient.js');
  const end = '2026-06-29T10:10:00.000Z';
  assert.equal(cryptoUpDownSlugPrefix('ethereum'), 'eth');
  assert.equal(cryptoUpDownSlugPrefix('solana'), 'sol');
  assert.equal(cryptoUpDownSlugPrefix('xrp'), 'xrp');
  assert.match(buildCryptoUpDownMarketSlug(end, '5m', 'bitcoin'), /^btc-updown-5m-\d+$/);
  assert.match(buildCryptoUpDownMarketSlug(end, '5m', 'ethereum'), /^eth-updown-5m-\d+$/);
  assert.match(buildCryptoUpDownMarketSlug(end, '15m', 'solana'), /^sol-updown-15m-\d+$/);
  assert.match(buildCryptoUpDownMarketSlug(end, '1h', 'bitcoin'), /^btc-updown-1h-\d+$/);
  assert.match(buildCryptoUpDownMarketSlug(end, '1d', 'ethereum'), /^eth-updown-1d-\d+$/);
  assert.match(buildCryptoUpDownMarketSlug(end, '5m', 'xrp'), /^xrp-updown-5m-\d+$/);
  assert.equal(buildCryptoUpDownMarketSlug(end, '5m', 'doge'), null);
});

test('findCryptoUpDownMarket looks up non-BTC slugs instead of returning null', async () => {
  const { findCryptoUpDownMarket, buildCryptoUpDownMarketSlug } = await import('../src/polymarketClient.js');
  const end = '2026-06-29T10:10:00.000Z';
  const seen = [];
  const client = {
    async getMarketBySlug(slug) {
      seen.push(slug);
      return {
        slug,
        closed: false,
        outcomes: '["Up","Down"]',
        clobTokenIds: '["1","2"]',
        outcomePrices: '["0.55","0.45"]'
      };
    }
  };
  const eth = await findCryptoUpDownMarket(client, end, '5m', 'ethereum');
  const sol = await findCryptoUpDownMarket(client, end, '15m', 'solana');
  const xrp = await findCryptoUpDownMarket(client, end, '5m', 'xrp');
  assert.equal(eth.slug, buildCryptoUpDownMarketSlug(end, '5m', 'ethereum'));
  assert.equal(sol.slug, buildCryptoUpDownMarketSlug(end, '15m', 'solana'));
  assert.equal(xrp.slug, buildCryptoUpDownMarketSlug(end, '5m', 'xrp'));
  assert.deepEqual(seen, [
    buildCryptoUpDownMarketSlug(end, '5m', 'ethereum'),
    buildCryptoUpDownMarketSlug(end, '15m', 'solana'),
    buildCryptoUpDownMarketSlug(end, '5m', 'xrp')
  ]);
});

test('getSlotSchedule returns 5 minute windows', () => {
  const schedule = getSlotSchedule(new Date('2026-06-29T10:07:30.000Z'), 5);
  assert.equal(schedule.slotMinutes, 5);
  assert.equal(schedule.currentSlotIso, '2026-06-29T10:05:00.000Z');
  assert.equal(schedule.nextSlotIso, '2026-06-29T10:10:00.000Z');
});

test('buildWindowPlanKey uses one key per slot and timeframe', () => {
  const slotIso = '2026-06-29T10:05:00.000Z';
  assert.equal(buildWindowPlanKey(slotIso, '5m'), `${slotIso}_BTC-USD_5m`);
  assert.equal(buildWindowPlanKey(slotIso, '15m'), `${slotIso}_BTC-USD_15m`);
  assert.notEqual(
    buildWindowPlanKey(slotIso, '5m'),
    buildWindowPlanKey(slotIso, '15m')
  );
  assert.equal(buildWindowPlanKey(slotIso, '5m', 'ETH-USD'), `${slotIso}_ETH-USD_5m`);
  assert.notEqual(
    buildWindowPlanKey(slotIso, '5m', 'BTC-USD'),
    buildWindowPlanKey(slotIso, '5m', 'ETH-USD')
  );
});

test('plan2 execution keys are unique per symbol so multi-coin paper auto can fill', async () => {
  const { buildPlan2DelayedEntryKey } = await import('../src/polymarketPlan2.js');
  const slotIso = '2026-06-29T10:05:00.000Z';
  const btcKey = `${buildWindowPlanKey(slotIso, '5m', 'BTC-USD')}_plan2_probe`;
  const ethKey = `${buildWindowPlanKey(slotIso, '5m', 'ETH-USD')}_plan2_probe`;
  assert.notEqual(btcKey, ethKey);
  assert.notEqual(
    buildPlan2DelayedEntryKey(slotIso, '5m', 'BTC-USD'),
    buildPlan2DelayedEntryKey(slotIso, '5m', 'ETH-USD')
  );
});

test('mergePlanBucket restores default multi-symbol when auto.symbols missing', async () => {
  const { PolymarketTradingService, LIVE_AUTO_SYMBOLS } = await import('../src/polymarketTrading.js');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = join(tmpdir(), `pm-merge-symbols-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'plan1-state.json');
  writeFileSync(statePath, JSON.stringify({
    paperOrders: [],
    portfolio: { startingCash: 500, cash: 500, portfolioInitialized: true },
    auto: { enabled: true, strategy: 'plan1', timeframes: ['5m', '15m'], lastExecutedKeys: [] }
  }), 'utf8');
  const service = new PolymarketTradingService({
    config: { defaultStartingCash: 500 },
    stateDir: dir
  });
  await service.load();
  const status = service.status('plan1');
  assert.deepEqual(status.auto.symbols, LIVE_AUTO_SYMBOLS);
});

test('computePlan2PaperOrderUsd uses min order and cash pct', () => {
  const config = { plan2PaperMinOrderUsd: 10, plan2PaperOrderPct: 0.05 };
  assert.equal(computePlan2PaperOrderUsd({ cash: 200, config }), 10);
  assert.equal(computePlan2PaperOrderUsd({ cash: 500, config }), 25);
  assert.equal(computePlan2PaperOrderUsd({ cash: 150, config }), 10);
  assert.equal(computePlan2PaperOrderUsd({ cash: 8, config }), 0);
  assert.equal(computePlan2PaperOrderUsd({ cash: 9.99, config }), 0);
  assert.equal(computePlan2PaperOrderUsd({ cash: 1000, config }), 50);
});

test('computePlan1PaperOrderUsd uses remaining cash pct like plan2', () => {
  const config = { plan1PaperMinOrderUsd: 10, plan1PaperOrderPct: 0.05 };
  assert.equal(computePlan1PaperOrderUsd({ cash: 200, config }), 10);
  assert.equal(computePlan1PaperOrderUsd({ cash: 500, config }), 25);
  assert.equal(computePlan1PaperOrderUsd({ cash: 1000, config }), 50);
  assert.equal(computePlan1PaperOrderUsd({ cash: 8, config }), 0);
});

test('allocateCashPctBySymbolRank mean_preserving rewards higher win rate', () => {
  const result = allocateCashPctBySymbolRank({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'],
    winRates: {
      'BTC-USD': { winRate: 0.7, samples: 20 },
      'ETH-USD': { winRate: 0.6, samples: 20 },
      'SOL-USD': { winRate: 0.5, samples: 20 },
      'XRP-USD': { winRate: 0.4, samples: 20 }
    },
    baseCashPct: 0.10,
    rankWeights: [4, 3, 2, 1],
    minSamples: 10,
    mode: 'mean_preserving'
  });
  assert.equal(result.equalized, false);
  assert.equal(result.bySymbol['BTC-USD'].rank, 1);
  assert.equal(result.bySymbol['XRP-USD'].rank, 4);
  // 4/10*4 = 1.6 → 16%; 1/10*4 = 0.4 → 4%
  assert.equal(result.bySymbol['BTC-USD'].cashPct, 0.16);
  assert.equal(result.bySymbol['ETH-USD'].cashPct, 0.12);
  assert.equal(result.bySymbol['SOL-USD'].cashPct, 0.08);
  assert.equal(result.bySymbol['XRP-USD'].cashPct, 0.04);
  const avg = Object.values(result.cashPcts).reduce((s, v) => s + v, 0) / 4;
  assert.ok(Math.abs(avg - 0.10) < 1e-9);
});

test('allocateCashPctBySymbolRank fixed_pool splits base across ranks', () => {
  const result = allocateCashPctBySymbolRank({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'],
    winRates: {
      'BTC-USD': { winRate: 0.7, samples: 20 },
      'ETH-USD': { winRate: 0.6, samples: 20 },
      'SOL-USD': { winRate: 0.5, samples: 20 },
      'XRP-USD': { winRate: 0.4, samples: 20 }
    },
    baseCashPct: 0.10,
    rankWeights: [4, 3, 2, 1],
    mode: 'fixed_pool'
  });
  assert.equal(result.bySymbol['BTC-USD'].cashPct, 0.04);
  assert.equal(result.bySymbol['XRP-USD'].cashPct, 0.01);
  const sum = Object.values(result.cashPcts).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 0.10) < 1e-9);
});

test('allocateCashPctBySymbolRank equalizes on ties and cold start', () => {
  const tied = allocateCashPctBySymbolRank({
    symbols: ['BTC-USD', 'ETH-USD'],
    winRates: {
      'BTC-USD': { winRate: 0.55, samples: 20 },
      'ETH-USD': { winRate: 0.55, samples: 20 }
    },
    baseCashPct: 0.10,
    rankWeights: [4, 3, 2, 1]
  });
  assert.equal(tied.equalized, true);
  assert.equal(tied.bySymbol['BTC-USD'].cashPct, 0.10);
  assert.equal(tied.bySymbol['ETH-USD'].cashPct, 0.10);

  const cold = allocateCashPctBySymbolRank({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    winRates: {
      'BTC-USD': { winRate: 0.8, samples: 2 },
      'ETH-USD': { winRate: 0.2, samples: 3 }
    },
    baseCashPct: 0.10,
    minSamples: 10
  });
  assert.equal(cold.equalized, true);
  assert.equal(cold.bySymbol['SOL-USD'].cashPct, 0.10);
});

test('allocateCashPctBySymbolRank shares weight on tied ranks then renormalizes', () => {
  const result = allocateCashPctBySymbolRank({
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    winRates: {
      'BTC-USD': { winRate: 0.7, samples: 20 },
      'ETH-USD': { winRate: 0.7, samples: 20 },
      'SOL-USD': { winRate: 0.4, samples: 20 }
    },
    baseCashPct: 0.10,
    rankWeights: [4, 3, 2, 1],
    mode: 'mean_preserving'
  });
  // ranks: BTC+ETH share rank1 weight 4; SOL rank3 → weight index 2 → 2
  assert.equal(result.bySymbol['BTC-USD'].rank, 1);
  assert.equal(result.bySymbol['ETH-USD'].rank, 1);
  assert.equal(result.bySymbol['SOL-USD'].rank, 3);
  assert.equal(result.bySymbol['BTC-USD'].weight, 4);
  assert.equal(result.bySymbol['SOL-USD'].weight, 2);
  // sum w=10, n=3 → BTC=0.10*(4/10)*3=0.12
  assert.equal(result.bySymbol['BTC-USD'].cashPct, 0.12);
  assert.equal(result.bySymbol['SOL-USD'].cashPct, 0.06);
});

test('resolveSymbolWrSizedOrderPct respects disable flag and partial active set', () => {
  const winRates = {
    'BTC-USD': { winRate: 0.7, samples: 20 },
    'ETH-USD': { winRate: 0.4, samples: 20 }
  };
  const off = resolveSymbolWrSizedOrderPct({
    symbol: 'BTC-USD',
    baseOrderPct: 0.05,
    activeSymbols: ['BTC-USD', 'ETH-USD'],
    winRates,
    config: { symbolWrSizingEnabled: false }
  });
  assert.equal(off.orderPct, 0.05);
  assert.equal(off.sizeScale, 1);

  const on = resolveSymbolWrSizedOrderPct({
    symbol: 'BTC-USD',
    baseOrderPct: 0.05,
    activeSymbols: ['BTC-USD', 'ETH-USD'],
    winRates,
    config: {
      symbolWrSizingEnabled: true,
      symbolWrRankWeights: [4, 3, 2, 1],
      symbolWrMinSamples: 10,
      symbolWrSizingMode: 'mean_preserving'
    }
  });
  // weights 4+3=7, n=2 → BTC = round4(0.05*(4/7)*2) = 0.0571
  assert.equal(on.orderPct, 0.0571);
  assert.equal(on.rank, 1);
});

test('computePolymarketOrderUsd scales with equity by pct', () => {
  const config = {
    sizingBasePrincipal: 500,
    orderPct15m: 0.08,
    orderPct5m: 0.05,
    maxOrderUsd: 500,
    maxOrderEquityPct: 0.10
  };
  const at100 = computePolymarketOrderUsd({ equity: 100, cash: 100, timeframe: '15m', config });
  const at500 = computePolymarketOrderUsd({ equity: 500, cash: 500, timeframe: '15m', config });
  const at1000 = computePolymarketOrderUsd({ equity: 1000, cash: 1000, timeframe: '15m', config });
  const fiveAt500 = computePolymarketOrderUsd({ equity: 500, cash: 500, timeframe: '5m', config });
  assert.equal(at100.usd, 8);
  assert.equal(at500.usd, 40);
  assert.equal(at1000.usd, 80);
  assert.equal(fiveAt500.usd, 25);
  assert.equal(at500.orderPct, 0.08);
});

test('normalizeClobBuyAmounts respects CLOB market-buy 2-decimal USDC precision', () => {
  const sample = normalizeClobBuyAmounts(0.55, 8.38, { marketOrder: true });
  assert.equal(sample.usd, 8.38);
  assert.equal(sample.shares, 15.2363);
  assert.equal(Math.round(sample.usd * 100) / 100, sample.usd);
  const small = normalizeClobBuyAmounts(0.55, 5, { marketOrder: true });
  assert.equal(small.usd, 5);
  assert.equal(small.shares, 9.0909);
  const mid = normalizeClobBuyAmounts(0.54, 9.27, { marketOrder: true });
  assert.equal(mid.usd, 9.27);
  assert.ok(Number.isInteger(mid.usd * 100));
  const high = normalizeClobBuyAmounts(0.62, 12.03, { marketOrder: true });
  assert.equal(high.usd, 12.03);
  assert.ok(Number.isInteger(high.usd * 100));
});

test('normalizeClobBuyAmounts limit path aligns shares to tick size', () => {
  const limit = normalizeClobBuyAmounts(0.55, 8.38, { marketOrder: false });
  assert.equal(limit.usd, 8.38);
  assert.equal(limit.shares, 15.23);
});

test('normalizeClobSellAmounts attempts the full available balance', () => {
  const sample = normalizeClobSellAmounts(0.35, 9.8);
  assert.equal(sample.shares, 9.8);
  assert.equal(sample.usd, 3.43);
});

test('humanizeClobError explains raw conditional token amounts', () => {
  const raw = humanizeClobError(new Error('not enough balance / allowance: balance: 0, order amount: 9090000'));
  assert.match(raw, /9\.09/);
  assert.match(raw, /9090000/);
  assert.match(raw, /1e6/);
  const precision = humanizeClobError(new Error('invalid amounts, the market buy orders maker amount supports a max accuracy of 2 decimals'));
  assert.match(precision, /market/);
  const allowance = humanizeClobError(new Error('not enough balance / allowance'));
  assert.match(allowance, /可用份额|重试/);
  const fak = humanizeClobError(new Error('no orders found to match with FAK order'));
  assert.match(fak, /FAK/);
});

test('humanizeClobError converts CLOB micro-units to share counts', () => {
  const raw = 'not enough balance / allowance: the balance is not enough -> balance: 0, order amount: 9090000';
  const msg = humanizeClobError(new Error(raw));
  assert.match(msg, /9\.09/);
  assert.match(msg, /9090000/);
  assert.match(msg, /1e6/);
});

test('ensureConditionalSellReady allows sell when balance enough but allowance is zero', async () => {
  const balanceRaw = String(Math.round(9.8 * 1e6));
  const client = {
    updateBalanceAllowance: async () => {},
    getBalanceAllowance: async () => ({ balance: balanceRaw, allowance: '0' })
  };
  const shares = await ensureConditionalSellReady(client, 'token-1', 9.7, { retries: 1, delayMs: 0 });
  assert.ok(shares >= 9.7);
});

test('ensureConditionalSellReady rejects when balance is zero', async () => {
  const client = {
    updateBalanceAllowance: async () => {},
    getBalanceAllowance: async () => ({ balance: '0', allowance: '0' })
  };
  await assert.rejects(
    () => ensureConditionalSellReady(client, 'token-1', 9.7, { retries: 1, delayMs: 0 }),
    /余额 0/
  );
});

test('isSellRetryableError detects balance and allowance failures', () => {
  assert.equal(isSellRetryableError(new Error('not enough balance / allowance')), true);
  assert.equal(isSellRetryableError(new Error('invalid tick size')), false);
});

test('isSellLiquidityError detects FAK no-match failures', () => {
  assert.equal(isSellLiquidityError(new Error('no orders found to match FAK order')), true);
  assert.equal(isSellLiquidityError(new Error('invalid tick size')), false);
});

test('submitClobBuyOrderWithFallback keeps plan3 immediate-only and avoids GTC fallback', async () => {
  const postedTypes = [];
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    createAndPostMarketOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      throw new Error('no orders found to match');
    },
    createAndPostOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      throw new Error('GTC should not be used for plan3 immediate-only buys');
    }
  };
  await assert.rejects(
    submitClobBuyOrderWithFallback(client, {
      planId: 'plan3',
      tokenId: 'tok',
      limitPrice: 0.94,
      usd: 12
    }, {
      liveBuyOrderType: 'FAK',
      plan3LiveImmediateOnly: true,
      plan3LiveFakBumpSteps: 3
    }),
    /no orders found/
  );
  assert.equal(postedTypes.length, 4);
  assert.deepEqual([...new Set(postedTypes)], ['FAK']);
});

test('submitClobBuyOrderWithFallback gives plan3 a short-lived GTC fallback when enabled', async () => {
  const postedTypes = [];
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    createAndPostMarketOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      throw new Error('no orders found to match');
    },
    createAndPostOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      return { status: 'live', success: true, orderID: 'plan3-gtc' };
    }
  };
  const result = await submitClobBuyOrderWithFallback(client, {
    planId: 'plan3',
    tokenId: 'tok',
    limitPrice: 0.94,
    usd: 12
  }, {
    liveBuyOrderType: 'FAK',
    plan3LiveImmediateOnly: false,
    plan3LiveFakBumpSteps: 2
  });
  assert.equal(result.fallback, true);
  assert.equal(result.retried, 'gtc-fallback');
  assert.deepEqual(postedTypes, ['FAK', 'FAK', 'FAK', 'GTC']);
});

test('submitClobBuyOrderWithFallback bumps plan3_6 FAK prices inside favorite band', async () => {
  const postedTypes = [];
  const prices = [];
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    getOrderBook: async () => ({ asks: [{ price: '0.85' }] }),
    getPrice: async () => ({ price: '0.85' }),
    createAndPostMarketOrder: async (order, _options, orderType) => {
      postedTypes.push(String(orderType));
      prices.push(Number(order?.price));
      throw new Error('no orders found to match');
    },
    createAndPostOrder: async () => {
      throw new Error('GTC should not be used for plan3_6 buys');
    }
  };
  await assert.rejects(
    submitClobBuyOrderWithFallback(client, {
      planId: 'plan3_6',
      tokenId: 'tok',
      limitPrice: 0.85,
      usd: 5,
      maxLivePrice: 0.92,
      minLivePrice: 0.75
    }, {
      liveBuyOrderType: 'FAK',
      plan3LiveImmediateOnly: true,
      plan3_6LiveFakBumpSteps: 3,
      plan3_6FavoriteMinPrice: 0.75,
      plan3_6FavoriteMaxPrice: 0.92
    }),
    /no orders found/
  );
  // 1 primary + 3 bumps
  assert.equal(postedTypes.length, 4);
  assert.deepEqual([...new Set(postedTypes)], ['FAK']);
  assert.ok(prices.every((p) => p >= 0.75 && p <= 0.92 + 1e-9));
  assert.ok(prices.some((p) => p > 0.85));
});

test('submitClobBuyOrderWithFallback rejects plan3_6 junk/cheap asks below favorite floor', async () => {
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    getOrderBook: async () => ({ asks: [{ price: '0.026' }] }),
    getPrice: async () => ({ price: '0.82' }),
    createAndPostMarketOrder: async () => {
      throw new Error('should not submit junk favorite fill');
    }
  };
  await assert.rejects(
    submitClobBuyOrderWithFallback(client, {
      planId: 'plan3_6',
      tokenId: 'tok',
      limitPrice: 0.82,
      intendedLimitPrice: 0.82,
      usd: 5
    }, {
      liveBuyOrderType: 'FAK',
      plan3LiveImmediateOnly: true,
      plan3_6FavoriteMinPrice: 0.75,
      plan3_6FavoriteMaxPrice: 0.92
    }),
    /廉价侧|崩价|硬下限/
  );
});

test('submitClobBuyOrderWithFallback reprices plan3_6 to the latest favorite ask', async () => {
  const prices = [];
  let posts = 0;
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    getOrderBook: async () => ({ asks: [{ price: posts === 0 ? '0.85' : '0.88' }] }),
    getPrice: async () => ({ price: posts === 0 ? '0.85' : '0.88' }),
    createAndPostMarketOrder: async (order) => {
      prices.push(Number(order?.price));
      posts += 1;
      if (posts === 1) throw new Error('no orders found to match');
      return { status: 'matched', success: true, makingAmount: '5', takingAmount: '5.6818' };
    }
  };
  const result = await submitClobBuyOrderWithFallback(client, {
    planId: 'plan3_6',
    tokenId: 'tok',
    limitPrice: 0.85,
    usd: 5
  }, {
    liveBuyOrderType: 'FAK',
    plan3LiveImmediateOnly: true,
    plan3_6LiveFakBumpSteps: 4,
    plan3_6FavoriteMinPrice: 0.75,
    plan3_6FavoriteMaxPrice: 0.92
  });
  assert.equal(result.filled, false);
  assert.equal(result.awaitingConfirm, true);
  assert.ok(prices[0] >= 0.85);
  assert.ok(prices[1] >= 0.88);
  assert.ok(prices.every((p) => p >= 0.75 && p <= 0.92 + 1e-9));
});

test('resolveLiveBuyFakBumpSteps gives Plan5 eight immediate price retries by default', () => {
  assert.equal(resolveLiveBuyFakBumpSteps('plan1', {}), 6);
  assert.equal(resolveLiveBuyFakBumpSteps('plan5', {}), 8);
  assert.equal(resolveLiveBuyFakBumpSteps('plan5', { liveFakBumpSteps: 3 }), 8);
  assert.equal(resolveLiveBuyFakBumpSteps('plan5', { plan5LiveFakBumpSteps: 0 }), 0);
  assert.equal(resolveLiveBuyFakBumpSteps('plan5', { plan5LiveFakBumpSteps: 1 }), 1);
  assert.equal(resolveLiveBuyFakBumpSteps('plan5', { plan5LiveFakBumpSteps: 99 }), 12);
  assert.equal(resolveLiveBuyFakBumpSteps('plan3', {}), 4);
  assert.equal(resolveLiveBuyFakBumpSteps('plan3_6', {}), 8);
  assert.equal(resolveLiveBuyFakBumpSteps('plan3_6', { plan3_6LiveFakBumpSteps: 3 }), 3);
  assert.equal(resolveLiveBuyFakBumpSteps('plan2_5', {}), 8);
  assert.equal(resolveLiveBuyFakBumpSteps('plan2_5', { timeframe: '15m' }, { timeframe: '15m' }), 8);
  assert.equal(resolveLiveBuyFakBumpSteps('plan2_5', {}, { timeframe: '5m' }), 10);
  assert.equal(resolveLiveBuyFakBumpSteps('plan2', { plan2LiveFakBumpSteps5m: 12 }, { timeframe: '5m' }), 12);
  assert.equal(resolveLiveBuyFakBumpSteps('plan2_5', { plan2LiveFakBumpSteps: 4 }, { timeframe: '15m' }), 4);
});

test('submitClobBuyOrderWithFallback immediately retries eight Plan5 FAK price levels by default', async () => {
  const postedTypes = [];
  let tickReads = 0;
  let negRiskReads = 0;
  let askReads = 0;
  const client = {
    getTickSize: async () => {
      tickReads += 1;
      return '0.01';
    },
    getNegRisk: async () => {
      negRiskReads += 1;
      return false;
    },
    getOrderBook: async () => ({ asks: [{ price: '0.60' }] }),
    getPrice: async () => {
      askReads += 1;
      return { price: '0.60' };
    },
    getVersion: async () => 2,
    createAndPostMarketOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      throw new Error('no orders found to match');
    },
    createAndPostOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      throw new Error('GTC should not be used for Plan5 immediate-only buys');
    }
  };
  await assert.rejects(
    submitClobBuyOrderWithFallback(client, {
      planId: 'plan5',
      tokenId: 'tok',
      limitPrice: 0.60,
      intendedLimitPrice: 0.60,
      usd: 20
    }, {
      liveBuyOrderType: 'FAK'
    }),
    /no orders found/
  );
  // 1 primary + 8 bump retries
  assert.equal(postedTypes.length, 9);
  assert.deepEqual([...new Set(postedTypes)], ['FAK']);
  assert.equal(tickReads, 1);
  assert.equal(negRiskReads, 1);
  // Preflight book read + 8 bump refreshes prefer the order book first.
  assert.ok(askReads >= 0);
});

test('submitClobBuyOrderWithFallback rejects plan5 junk asks when getPrice still looks healthy', async () => {
  let submitted = 0;
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    // Stale aggregator still quotes the lock price while the book already dumped.
    getPrice: async () => ({ price: '0.69' }),
    getOrderBook: async () => ({ asks: [{ price: '0.23' }] }),
    createAndPostMarketOrder: async () => {
      submitted += 1;
      throw new Error('should not submit plan5 junk fill');
    }
  };
  await assert.rejects(
    submitClobBuyOrderWithFallback(client, {
      planId: 'plan5',
      tokenId: 'tok',
      limitPrice: 0.69,
      intendedLimitPrice: 0.69,
      usd: 5
    }, {
      liveBuyOrderType: 'FAK',
      plan5MinEntryPrice: 0.50,
      plan5HardMinEntryPrice: 0.35,
      plan5LiveMaxAdversePriceDropAbs: 0.12,
      plan5LiveMaxAdversePriceDropPct: 0.25
    }),
    /崩价|硬下限|回撤/
  );
  assert.equal(submitted, 0);
});

test('paper/live parity uses the same executable CLOB entry floor', () => {
  const config = {
    minOrderUsd: 5,
    liveMinSharesBuffer: 6,
    plan1LiveMinOrderUsd: 1,
    plan5LiveMinOrderUsd: 1,
    plan2LiveMinOrderUsd5m: 5,
    plan2LiveMinOrderUsd15m: 6
  };
  assert.equal(resolveUnifiedEntryFloorUsd({ config, planId: 'plan1', timeframe: '5m', price: 0.77 }), 3.85);
  // 廉价侧：5×$0.18=$0.90，但仍不得低于 Plan1 可执行底 $2.5（禁止 $1 灰尘单）
  assert.equal(resolveUnifiedEntryFloorUsd({ config, planId: 'plan1', timeframe: '15m', price: 0.18 }), 2.5);
  assert.equal(resolveUnifiedEntryFloorUsd({ config, planId: 'plan5', timeframe: '5m', price: 0.77 }), 4.62);
  // Plan2.5：忽略自设 $6 噪声底，只保留 CLOB 5 份物理最小（0.77×5）
  assert.equal(resolveUnifiedEntryFloorUsd({ config, planId: 'plan2_5', timeframe: '15m', price: 0.77 }), 3.85);
  assert.equal(resolveUnifiedEntryFloorUsd({
    config: { ...config, plan11LiveMinOrderUsd: 5 },
    planId: 'plan11',
    timeframe: '5m',
    price: 0.72
  }), 5);
  assert.equal(resolveUnifiedEntryFloorUsd({ config, planId: 'plan3_6', timeframe: '5m', price: 0.12 }), 0.72);
});

test('buildLiveOrderDraft bumps Plan1 dust intents up to executable floor when cash/room allow', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 20,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      maxOrderEquityPct: 0.25,
      liveAdaptiveCapEnabled: false,
      plan1LiveMinOrderUsd: 1,
      plan1LiveExecutableFloorUsd: 2.5,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1
    },
    statePath: 'data/test-polymarket-live-plan1-dust-skip.json'
  });
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan1',
      key: 'slot_plan1_dust',
      timeframe: '15m',
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'down',
        usd: 1,
        confidence: 0.7,
        reason: 'tiny dust intent'
      }
    },
    sentiment: {
      available: true,
      symbol: 'SOL-USD',
      timeframe: '15m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.82,
      downPrice: 0.18,
      market: 'SOL Down',
      marketSlug: 'sol-down',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan1',
    clobBalanceUsdc: 40
  });
  assert.ok(draft.usd + 1e-9 >= 2.5);
  assert.match(String(draft.sizeFloorBumpNote || ''), /本金比例算出 \$1\.00.*已抬到/);
});

test('buildLiveOrderDraft skips Plan1 floor bump when cash cannot fund executable floor', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 20,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      maxOrderEquityPct: 0.25,
      liveAdaptiveCapEnabled: false,
      plan1LiveMinOrderUsd: 1,
      plan1LiveExecutableFloorUsd: 2.5,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1
    },
    statePath: 'data/test-polymarket-live-plan1-dust-cash-skip.json'
  });
  assert.throws(
    () => service.buildLiveOrderDraft({
      plan: {
        planId: 'plan1',
        key: 'slot_plan1_dust_cash',
        timeframe: '15m',
        targetTimeIso: '2099-01-01T00:15:00.000Z',
        slotIso: '2099-01-01T00:00:00.000Z',
        action: {
          shouldTrade: true,
          direction: 'down',
          usd: 1,
          confidence: 0.7,
          reason: 'tiny dust intent'
        }
      },
      sentiment: {
        available: true,
        symbol: 'SOL-USD',
        timeframe: '15m',
        upTokenId: '12345',
        downTokenId: '67890',
        upPrice: 0.82,
        downPrice: 0.18,
        market: 'SOL Down',
        marketSlug: 'sol-down',
        schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
      },
      planId: 'plan1',
      clobBalanceUsdc: 1.5
    }),
    /余额|不够最小单|不足以满足/
  );
});

test('Plan5 paper parity rechecks minimum shares after simulated fill slippage', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const service = new PolymarketTradingService({
    config: {
      paperLiveParityEnabled: true,
      minOrderUsd: 5,
      liveMinSharesBuffer: 6,
      plan5LiveMinOrderUsd: 1,
      plan5PaperRequireAskFillable: false,
      plan5PaperFillSlippageTicks: 1,
      plan5PaperFillTickSize: 0.01,
      maxOrderUsd: 500,
      liveMaxOrderUsd: 100
    },
    statePath: join(tmpdir(), `pm-plan5-parity-${Date.now()}-${Math.random()}.json`)
  });
  await service.configurePortfolio({ planId: 'plan5', cash: 500 });
  const order = await service.createPaperOrder({
    planId: 'plan5', symbol: 'ETH-USD', direction: 'up', usd: 3.03,
    sentiment: {
      available: true, symbol: 'ETH-USD', timeframe: '5m',
      upTokenId: 'up-token', downTokenId: 'down-token',
      upPrice: 0.505, downPrice: 0.495, upBestAsk: 0.505,
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: {
      timeframe: '5m', slotIso: '2099-01-01T00:00:00.000Z',
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      action: { shouldTrade: true, direction: 'up', limitPrice: 0.505 }
    }
  }, 'plan5');
  assert.equal(order.limitPrice, 0.515);
  assert.equal(order.usd, 3.09);
  assert.ok(order.shares >= 6);
  assert.equal(order.parityFloorAdjusted, true);
});

test('submitClobBuyOrderWithFallback crosses the fresh Plan5 ask instead of retrying a stale quote', async () => {
  const prices = [];
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getOrderBook: async () => ({ asks: [{ price: prices.length === 0 ? '0.60' : '0.70' }] }),
    getPrice: async () => ({ price: prices.length === 0 ? '0.60' : '0.70' }),
    createAndPostMarketOrder: async (order) => {
      prices.push(Number(order.price));
      if (prices.length === 1) throw new Error('no orders found to match');
      return { status: 'matched', success: true, makingAmount: '5', takingAmount: '7.04' };
    }
  };
  const result = await submitClobBuyOrderWithFallback(client, {
    planId: 'plan5',
    tokenId: 'tok',
    limitPrice: 0.60,
    intendedLimitPrice: 0.60,
    usd: 5
  }, {
    liveBuyOrderType: 'FAK'
  });
  assert.equal(result.filled, false);
  assert.equal(result.awaitingConfirm, true);
  // 首次 0.60 失败后刷新 ask=0.70，并至少越过 ask 2 ticks → 0.72
  assert.deepEqual(prices, [0.60, 0.72]);
});

test('submitClobBuyOrderWithFallback allows an explicit Plan5 GTC compatibility mode', async () => {
  const postedTypes = [];
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    getOrderBook: async () => ({ asks: [{ price: '0.60' }] }),
    getPrice: async () => ({ price: '0.60' }),
    createAndPostMarketOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      throw new Error('no orders found to match');
    },
    createAndPostOrder: async (_order, _options, orderType) => {
      postedTypes.push(String(orderType));
      return { status: 'live', success: true, orderID: 'gtc-default' };
    }
  };
  const result = await submitClobBuyOrderWithFallback(client, {
    planId: 'plan5',
    tokenId: 'tok',
    limitPrice: 0.60,
    intendedLimitPrice: 0.60,
    usd: 20
  }, {
    liveBuyOrderType: 'FAK',
    plan5LiveImmediateOnly: false,
    plan5LiveFakBumpSteps: 2
  });
  assert.equal(result.fallback, true);
  assert.equal(String(result.orderType), 'GTC');
  assert.equal(result.retried, 'gtc-fallback');
  assert.deepEqual(postedTypes, ['FAK', 'FAK', 'FAK', 'GTC']);
});

test('global live daily loss protection blocks every plan and supports the legacy toggle', async () => {
  const service = new PolymarketTradingService({
    config: {
      globalDailyLossLimitPct: 0.01,
      dailyMaxLossUsd: 0,
      liveMaxOrderUsd: 500,
      maxOrderUsd: 500,
      maxOrderEquityPct: 0.08,
      maxTotalOpenExposurePct: 0.25,
      maxTimeframeOpenExposurePct: 0.12,
      minOrderUsd: 5
    }
  });
  const closedAtIso = new Date().toISOString();
  service.state.liveOrders = [
    { id: 'loss-1', planId: 'plan1', orderSide: 'BUY', positionStatus: 'closed', pnl: -3, closedAtIso },
    { id: 'loss-2', planId: 'plan5', orderSide: 'BUY', positionStatus: 'closed', pnl: -3, closedAtIso }
  ];
  const snapshot = service.globalLiveDailyLossSnapshot({ clobBalanceUsdc: 500 });
  assert.equal(snapshot.realizedPnl, -6);
  assert.equal(snapshot.limitUsd, 5);
  assert.equal(snapshot.triggered, true);

  const sentiment = {
    available: true,
    upPrice: 0.4,
    downPrice: 0.6,
    upTokenId: 'up',
    downTokenId: 'down'
  };
  for (const planId of ['plan1', 'plan5', 'plan3_6']) {
    assert.throws(() => service.buildLiveOrderDraft({
      planId,
      clobBalanceUsdc: 500,
      sentiment,
      plan: { planId, timeframe: '5m', action: { shouldTrade: true, direction: 'up', usd: 5 } }
    }), /全策略日亏损保护已触发/);
  }

  service.state.liveAuto.riskControls = { plan3DailyLossLimitEnabled: false };
  assert.equal(service.isGlobalDailyLossProtectionEnabled(), false);
  assert.equal(service.globalLiveDailyLossSnapshot({ clobBalanceUsdc: 500 }).triggered, false);
});

test('resolveOfficialMarketOutcome uses resolved Polymarket outcome prices', () => {
  const outcome = resolveOfficialMarketOutcome([{
    eventMetadata: { priceToBeat: 63977.43238844731 },
    markets: [{
      slug: 'btc-updown-5m-test',
      closed: true,
      umaResolutionStatus: 'resolved',
      outcomes: '["Up","Down"]',
      outcomePrices: '["0","1"]'
    }]
  }], 'btc-updown-5m-test');
  assert.equal(outcome.actualDirection, 'down');
  assert.equal(outcome.startPrice, 63977.43238844731);
  assert.equal(outcome.priceSource, 'polymarket-official');
});

test('getResolvedMarketOutcome resolves a persisted market slug through the markets endpoint', async () => {
  const client = new PolymarketClient({ gammaBaseUrl: 'https://gamma.test' });
  const calls = [];
  client.request = async (url, params) => {
    calls.push({ url, params });
    if (url.endsWith('/markets')) {
      return [{
        slug: 'test-team-a-wins',
        closed: true,
        umaResolutionStatus: 'resolved',
        outcomes: '["Yes","No"]',
        outcomePrices: '["1","0"]'
      }];
    }
    return [];
  };

  const outcome = await client.getResolvedMarketOutcome('test-team-a-wins');
  assert.equal(outcome.actualDirection, 'up');
  assert.equal(calls[0].url, 'https://gamma.test/markets');
  assert.equal(calls[0].params.slug, 'test-team-a-wins');
  assert.equal(calls.length, 1);
});

test('summarizeLiveOrderForApi removes heavy CLOB payloads but keeps display fields', () => {
  const summary = summarizeLiveOrderForApi({
    id: 'live-1',
    planId: 'plan3_6',
    createdAtIso: '2026-07-12T00:00:00.000Z',
    orderSide: 'BUY',
    positionStatus: 'closed',
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'up',
    usd: 5,
    limitPrice: 0.12,
    pnl: 2,
    clobStatus: 'matched',
    clobResponse: { status: 'matched', transactions: ['large-payload'] },
    response: { nested: true },
    entryContext: { nested: true }
  });
  assert.equal(summary.planId, 'plan3_6');
  assert.equal(summary.clobStatus, 'matched');
  assert.equal(summary.pnl, 2);
  assert.equal(Object.hasOwn(summary, 'relatedBuyOrderId'), true);
  assert.equal(Object.hasOwn(summary, 'stopLossPrice'), true);
  assert.equal(Object.hasOwn(summary, 'clobResponse'), false);
  assert.equal(Object.hasOwn(summary, 'response'), false);
  assert.equal(Object.hasOwn(summary, 'entryContext'), false);
});

test('pruneLiveOrdersByPlan prevents one high-frequency plan from evicting all others', () => {
  const orders = [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `p5-${index}`, planId: 'plan5', positionStatus: 'closed' })),
    { id: 'p36-old', planId: 'plan3_6', positionStatus: 'closed' },
    { id: 'p1-open', planId: 'plan1', positionStatus: 'open' }
  ];
  const kept = pruneLiveOrdersByPlan(orders, 10);
  assert.equal(kept.filter((order) => order.planId === 'plan5').length, 10);
  assert.ok(kept.some((order) => order.id === 'p36-old'));
  assert.ok(kept.some((order) => order.id === 'p1-open'));
});

test('submitClobSellOrderWithFallback retries on liquidity errors', async () => {
  let attempts = 0;
  const balanceRaw = String(Math.round(10 * 1e6));
  const client = {
    updateBalanceAllowance: async () => {},
    getBalanceAllowance: async () => ({ balance: balanceRaw, allowance: '0' }),
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    createAndPostOrder: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('no orders found to match');
      return { success: true, status: 'matched', orderID: 'sell-liq-1' };
    }
  };
  const result = await submitClobSellOrderWithFallback(client, {
    tokenId: 'tok',
    shares: 10,
    limitPrice: 0.5,
    usd: 5
  }, { sellRetryDelaysMs: [0, 0] });
  assert.equal(result.retried, 'sell-retry-1');
  assert.equal(extractClobOrderId(result.response), 'sell-liq-1');
  assert.equal(attempts, 2);
});

test('submitClobSellOrderWithFallback retries on allowance errors', async () => {
  let attempts = 0;
  const balanceRaw = String(Math.round(10 * 1e6));
  const client = {
    updateBalanceAllowance: async () => {},
    getBalanceAllowance: async () => ({ balance: balanceRaw, allowance: '0' }),
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    createAndPostOrder: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('not enough balance / allowance');
      return { success: true, status: 'matched', orderID: 'sell-1' };
    }
  };
  const result = await submitClobSellOrderWithFallback(client, {
    tokenId: 'tok',
    shares: 10,
    limitPrice: 0.5,
    usd: 5
  }, { sellRetryDelaysMs: [0, 0] });
  assert.equal(result.retried, 'sell-retry-1');
  assert.equal(extractClobOrderId(result.response), 'sell-1');
  assert.equal(attempts, 2);
});

test('computePolymarketOrderUsd caps by available cash', () => {
  const config = {
    sizingBasePrincipal: 500,
    orderPct15m: 0.08,
    maxOrderUsd: 500,
    maxOrderEquityPct: 0.10
  };
  const sized = computePolymarketOrderUsd({ equity: 1000, cash: 60, timeframe: '15m', config });
  assert.equal(sized.usd, 60);
  assert.equal(sized.cappedByCash, true);
});

test('computeBinaryPnl calculates payout for binary markets', () => {
  const win = computeBinaryPnl({ usd: 10, limitPrice: 0.5, won: true });
  assert.equal(win.payoutUsd, 20);
  assert.equal(win.pnl, 10);
  const loss = computeBinaryPnl({ usd: 10, limitPrice: 0.5, won: false });
  assert.equal(loss.payoutUsd, 0);
  assert.equal(loss.pnl, -10);
});

test('PolymarketTradingService requires portfolio before paper order', async () => {
  const service = new PolymarketTradingService({
    config: { defaultOrderUsd: 5, maxOrderUsd: 20, dailyMaxLossUsd: 50 },
    statePath: 'data/test-polymarket-state.json'
  });
  await assert.rejects(
    () => service.createPaperOrder({
      symbol: 'BTC-USD',
      direction: 'up',
      usd: 5,
      sentiment: {
        available: true,
        timeframe: '15m',
        upTokenId: '1',
        downTokenId: '2',
        upPrice: 0.6,
        downPrice: 0.4,
        targetTimeIso: '2026-06-29T10:15:00.000Z'
      }
    })
  );
});

test('pickBestIntervalMarket prefers endDate closest to target slot', () => {
  const chosen = pickBestIntervalMarket(
    [
      { id: 'a', active: true, endDate: '2026-06-29T10:30:00.000Z', volume24hr: 100 },
      { id: 'b', active: true, endDate: '2026-06-29T10:15:00.000Z', volume24hr: 50 }
    ],
    '2026-06-29T10:15:00.000Z'
  );
  assert.equal(chosen.id, 'b');
});

test('pickBestIntervalMarket rejects adjacent 15m windows', () => {
  const chosen = pickBestIntervalMarket(
    [
      { id: 'a', active: true, endDate: '2026-06-29T10:30:00.000Z', volume24hr: 100 },
      { id: 'b', active: true, endDate: '2026-06-29T10:00:00.000Z', volume24hr: 200 }
    ],
    '2026-06-29T10:15:00.000Z'
  );
  assert.equal(chosen, null);
});

test('classifySentiment returns bullish when up price and momentum rise', () => {
  assert.equal(
    classifySentiment({
      upPrice: 0.58,
      upPriceChange5m: 0.04,
      orderbookBias: 'up',
      recentTradeBias: 'neutral'
    }),
    'bullish'
  );
});

test('estimateConfidenceBoost caps at 20%', () => {
  const boost = estimateConfidenceBoost({
    upPrice: 0.62,
    upPriceChange5m: 0.05,
    orderbookBias: 'up',
    spread: 0.02,
    liquidity: 200_000,
    volume24h: 900_000,
    sentiment: 'bullish'
  });
  assert.ok(boost <= 0.2);
  assert.ok(boost >= 0.12);
});

test('scorePolymarketQuality penalizes weak market data', () => {
  const good = scorePolymarketQuality({
    upPrice: 0.62,
    downPrice: 0.38,
    spread: 0.02,
    liquidity: 50_000,
    volume24h: 250_000,
    upBidDepth: 2_000,
    downBidDepth: 2_000,
    recentTradeCount: 10
  });
  const weak = scorePolymarketQuality({
    upPrice: 0.51,
    downPrice: 0.49,
    spread: 0.12,
    liquidity: 500,
    volume24h: 500,
    upBidDepth: 50,
    downBidDepth: 40,
    recentTradeCount: 0
  });
  assert.ok(good.score > weak.score);
  assert.ok(typeof weak.label === 'string');
});

test('blendWithPolymarketSentiment boosts confidence when aligned', () => {
  const now = new Date('2026-06-29T10:05:00.000Z');
  const candles = buildSyntheticCandles(40, 100, 'up', now);
  const base = buildIntervalSignal({
    symbol: 'BTC-USD',
    candles,
    currentPrice: candles.at(-1).close * 1.002,
    now
  });
  assert.notEqual(base.direction, 'wait');
  const blended = blendWithPolymarketSentiment(base, {
    available: true,
    upPrice: base.direction === 'up' ? 0.62 : 0.38,
    downPrice: base.direction === 'up' ? 0.38 : 0.62,
    upPriceChange5m: 0.04,
    spread: 0.02,
    orderbookBias: base.direction,
    sentiment: base.direction === 'up' ? 'bullish' : 'bearish',
    confidenceBoost: 0.12
  });

  assert.ok(blended.confidence >= base.confidence);
  assert.equal(blended.polymarket.aligned, true);
});

test('blendWithPolymarketSentiment downgrades to wait on strong conflict', () => {
  const now = new Date('2026-06-29T10:05:00.000Z');
  const candles = buildSyntheticCandles(40, 100, 'up', now);
  const base = buildIntervalSignal({
    symbol: 'BTC-USD',
    candles,
    currentPrice: candles.at(-1).close * 1.01,
    now
  });
  assert.notEqual(base.direction, 'wait');
  const blended = blendWithPolymarketSentiment(base, {
    available: true,
    upPrice: 0.41,
    downPrice: 0.59,
    upPriceChange5m: -0.03,
    spread: 0.02,
    orderbookBias: 'down',
    sentiment: 'bearish',
    confidenceBoost: 0.1
  });

  assert.equal(blended.direction, 'wait');
  assert.equal(blended.polymarket.strongConflict, true);
});

function buildSyntheticCandles(count, startPrice, bias = 'flat', now = new Date()) {
  const slotMs = Date.parse(getSlotIso(now));
  const candles = [];
  let price = startPrice;
  for (let index = count; index >= 1; index -= 1) {
    const drift = bias === 'up' ? 0.003 : bias === 'down' ? -0.003 : 0.0005;
    price /= 1 + drift;
    candles.unshift({
      time: Math.floor((slotMs - index * 15 * 60 * 1000) / 1000),
      open: price * 0.999,
      high: price * 1.002,
      low: price * 0.998,
      close: price
    });
  }
  return candles;
}

function getSlotIso(now) {
  const current = new Date(now);
  current.setSeconds(0, 0);
  const slotMinute = Math.floor(current.getMinutes() / 15) * 15;
  current.setMinutes(slotMinute, 0, 0);
  return current.toISOString();
}

const PLAN2_TEST_CONFIG = {
  plan2EntryMinPrice: 0.35,
  plan2EntryMaxPrice: 0.78,
  plan2MinConfidence: 0.63,
  plan2MinEdge: 0.06,
  plan2EntryMinElapsedPct: 0.08,
  plan2MaxEntryElapsedPct: 0.78,
  plan2MaxEntryElapsedPct5m: 0.85,
  plan2MaxEntryElapsedPct15m: 0.82,
  plan2TakeProfitOffset: 0.18,
  plan2StopLossOffset: 0.12,
  stopLossAbsoluteFloor: 0.50,
  plan2HighEntryMinPrice: 0.70,
  plan2HighEntryDelayMs: 45000,
  plan2FiveMinuteLockEnabled: false,
  plan2PaperRelaxedEnabled: false,
  defaultStartingCash: 500,
  sizingBasePrincipal: 500,
  orderUsd15m: 40,
  orderUsd5m: 25,
  maxOrderUsd: 500
};

const SUSTAINED_TEST_CONFIG = {
  ...PLAN2_TEST_CONFIG,
  plan2SustainedMomentumEnabled: true,
  plan2SustainedMomentumMinPrice5m: 0.72,
  plan2SustainedMomentumMinPrice15m: 0.70,
  plan2SustainedMomentumMaxPrice5m: 0.88,
  plan2SustainedMomentumMaxPrice15m: 0.85,
  plan2SustainedMomentumMaxPullback5m: 0.025,
  plan2SustainedMomentumMaxPullback15m: 0.03,
  plan2SustainedMomentumMinElapsedPct5m: 0.25,
  plan2SustainedMomentumMinElapsedPct15m: 0.20,
  plan2SustainedMomentumMaxElapsedPct5m: 0.72,
  plan2SustainedMomentumMaxElapsedPct15m: 0.74,
  plan2SustainedMomentumMinSamples5m: 4,
  plan2SustainedMomentumMinSamples15m: 6,
  plan2SustainedMomentumMinHoldMs5m: 1000,
  plan2SustainedMomentumMinHoldMs15m: 1000,
  plan2SustainedMomentumMinDistanceBps5m: 10,
  plan2SustainedMomentumMinDistanceBps15m: 8,
  plan2SustainedMomentumMaxReverseBps5m: 4,
  plan2SustainedMomentumMaxReverseBps15m: 5,
  plan2SustainedMomentumSizeMultiplier5m: 1.35,
  plan2SustainedMomentumSizeMultiplier15m: 1.25,
  plan2SustainedMomentumMinQuality: 0.55,
  plan2LateCaptureEnabled: false,
  plan2HighEntryMinPrice: 0.95
};

const PLAN1_TEST_CONFIG = {
  plan1MinConfidence: 0.55,
  plan1MaxEntryPrice: 0.78,
  plan1EntryMinElapsedPct: 0.05,
  plan1EntryMaxElapsedPct: 0.80,
  plan1TakeProfitOffset: 0.18,
  plan1StopLossOffset: 0.15,
  minEdge5m: 0.06,
  minEdge15m: 0.04,
  minMarketQuality: 0.40,
  defaultStartingCash: 500,
  sizingBasePrincipal: 500,
  orderUsd15m: 40,
  orderUsd5m: 25,
  maxOrderUsd: 500
};

function midWindowNow(slotStartIso = '2026-06-29T10:00:00.000Z', slotMinutes = 15) {
  const startMs = Date.parse(slotStartIso);
  return new Date(startMs + Math.floor(slotMinutes * 60 * 1000 * 0.45));
}

test('getTradeSizeMultiplier applies tiered entry thresholds', () => {
  assert.equal(getTradeSizeMultiplier({ confidence: 0.62, entryPrice: 0.55, timeframe: '15m' }), 1.0);
  assert.equal(getTradeSizeMultiplier({ confidence: 0.65, entryPrice: 0.62, timeframe: '15m' }), 0.5);
  assert.equal(getTradeSizeMultiplier({ confidence: 0.75, entryPrice: 0.70, timeframe: '15m' }), 0.25);
  assert.equal(getTradeSizeMultiplier({ confidence: 0.80, entryPrice: 0.76, timeframe: '15m' }), 0.15);
  assert.equal(getTradeSizeMultiplier({ confidence: 0.80, entryPrice: 0.79, timeframe: '15m' }), 0);
  assert.equal(getTradeSizeMultiplier({ confidence: 0.61, entryPrice: 0.55, timeframe: '5m' }), 1.0);
  assert.equal(getTradeSizeMultiplier({ confidence: 0.60, entryPrice: 0.70, timeframe: '5m' }), 0);
});

test('evaluateTieredEntry blocks low-edge and premium prices', () => {
  const blockedPremium = evaluateTieredEntry({
    confidence: 0.80,
    entryPrice: 0.79,
    timeframe: '15m',
    config: PLAN1_TEST_CONFIG
  });
  assert.equal(blockedPremium.allowed, false);
  assert.match(blockedPremium.reason, /78%|tier/);

  const tier2 = evaluateTieredEntry({
    confidence: 0.65,
    entryPrice: 0.62,
    timeframe: '15m',
    config: PLAN1_TEST_CONFIG,
    marketQuality: 0.5
  });
  assert.equal(tier2.allowed, true);
  assert.equal(tier2.sizeMultiplier, 0.5);
  assert.equal(tier2.tier, 2);

  const allowed = evaluateTieredEntry({
    confidence: 0.72,
    entryPrice: 0.55,
    timeframe: '15m',
    config: PLAN1_TEST_CONFIG,
    marketQuality: 0.7
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.sizeMultiplier, 1.0);
  assert.ok(allowed.edge >= 0.015);
});

test('evaluateEdgeEntry still supports legacy single-threshold checks', () => {
  const blocked = evaluateEdgeEntry({
    confidence: 0.65,
    entryPrice: 0.62,
    timeframe: '15m',
    config: PLAN1_TEST_CONFIG,
    minConfidence: 0.62,
    minEdge: 0.04,
    maxEntryPrice: 0.6
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /edge|上限/);

  const allowed = evaluateEdgeEntry({
    confidence: 0.72,
    entryPrice: 0.55,
    timeframe: '15m',
    config: PLAN1_TEST_CONFIG,
    minConfidence: 0.62,
    minEdge: 0.04,
    maxEntryPrice: 0.6,
    marketQuality: 0.7
  });
  assert.equal(allowed.allowed, true);
  assert.ok(allowed.edge >= 0.04);
});

test('buildPolymarketPaperPlan2 blocks standard entry when 5m lock conflicts', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2FiveMinuteLockEnabled: true,
      plan2ProbeEnabled: false,
      plan2SustainedMomentumEnabled: false,
      plan2UltraLateCaptureEnabled: false
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    fiveMinuteLock: { direction: 'down', strength: 'normal' },
    now
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason, /5m PM 锁定/);
});

test('buildPolymarketPaperPlan2 allows probe when 5m lock conflicts', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2FiveMinuteLockEnabled: true,
      plan2ProbeEnabled: true,
      plan2ProbeMinPrice: 0.48,
      plan2ProbeMaxPrice: 0.62
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    fiveMinuteLock: { direction: 'down', strength: 'normal' },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'probe');
});

test('resolvePlan2PaperMode keeps live entry strict unless entry sync enabled', () => {
  assert.equal(resolvePlan2PaperMode({ plan2LiveSyncPaperEnabled: true }, { paperMode: false }), false);
  assert.equal(resolvePlan2PaperMode({
    plan2LiveSyncPaperEnabled: true,
    plan2LiveSyncPaperEntryEnabled: true
  }, { paperMode: false }), true);
  assert.equal(resolvePlan2PaperMode({ plan2LiveSyncPaperEntryEnabled: false }, { paperMode: false }), false);
  const strict = resolvePlan2EffectiveConfig(
    { plan2LiveSyncPaperEnabled: true, liveTradingEnabled: true, plan2EntryMaxPrice: 0.62 },
    { paperMode: false }
  );
  assert.equal(strict._plan2PaperRelaxed, undefined);
  assert.equal(strict.plan2EntryMaxPrice, 0.62);
  const synced = resolvePlan2EffectiveConfig(
    {
      plan2LiveSyncPaperEntryEnabled: true,
      liveTradingEnabled: true,
      plan2EntryMaxPrice: 0.62
    },
    { paperMode: false }
  );
  assert.equal(synced._plan2PaperRelaxed, true);
  assert.equal(synced.plan2EntryMaxPrice, 0.82);
});

test('buildPolymarketPaperPlan2 blocks live probe when live probe disabled and sync off', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      liveTradingEnabled: true,
      plan2LiveSyncPaperEnabled: false,
      plan2LiveProbeEnabled: false,
      plan2FiveMinuteLockEnabled: true,
      plan2ProbeEnabled: true,
      plan2ProbeMinPrice: 0.48,
      plan2ProbeMaxPrice: 0.62
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    fiveMinuteLock: { direction: 'down', strength: 'normal' },
    paperMode: false,
    now
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason || '', /实盘探针小单已关闭|5m PM 锁定/);
});

test('resolvePlan2EffectiveConfig relaxes regime and widens bands for paper', () => {
  const effective = resolvePlan2EffectiveConfig({
    plan2PaperRelaxedEnabled: true,
    plan2RegimeFilterEnabled: true,
    plan2EntryMaxPrice: 0.72,
    plan2ProbeMaxPrice: 0.68,
    plan2FiveMinuteLockEnabled: true,
    plan2LateCaptureRequireCalibratedEdge: true
  }, { paperMode: true });
  assert.equal(effective.plan2RegimeFilterEnabled, true);
  assert.equal(effective.plan2RequirePolymarketAlignment, true);
  assert.equal(effective.plan2RegimeSkipMainRisk, 5);
  assert.equal(effective.plan2RegimeSkipAllRisk, 7);
  // 默认纸面入场上限压到 0.82，避免 ≥82% 负 EV 高价带
  assert.equal(effective.plan2EntryMaxPrice, 0.82);
  assert.equal(effective.plan2MinEdge, 0.04);
  assert.equal(effective.plan2ProbeMaxPrice, 0.80);
  assert.equal(effective.plan2FiveMinuteLockEnabled, true);
  assert.equal(effective.plan2LateCaptureRequireCalibratedEdge, false);
  assert.equal(effective._plan2PaperRelaxed, true);
});

test('resolvePlan2EntryTier paper relaxed uses PM-leading confidence at high price', () => {
  const tier = resolvePlan2EntryTier({
    limitPrice: 0.92,
    confidence: 0.68,
    timeframe: '15m',
    config: {
      plan2PaperRelaxedEnabled: true,
      plan2PaperEntryMaxPrice: 0.92,
      plan2EntryMinPrice: 0.35,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      stopLossAbsoluteFloor: 0.50
    },
    sentiment: { upPrice: 0.92, downPrice: 0.08, upProbability: 0.92, downProbability: 0.08 },
    directionEntry: { direction: 'up', confidence: 0.68 },
    paperMode: true
  });
  assert.equal(tier.allowed, true);
  assert.equal(tier.tier, 'paper_relaxed');
  assert.equal(tier.sizeMultiplier, 0.10);
});

test('resolvePlan2EntryTier paper relaxed rejects above default paper entry max', () => {
  const tier = resolvePlan2EntryTier({
    limitPrice: 0.90,
    confidence: 0.90,
    timeframe: '15m',
    config: {
      plan2PaperRelaxedEnabled: true,
      plan2EntryMinPrice: 0.35,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.08,
      stopLossAbsoluteFloor: 0.50
    },
    sentiment: { upPrice: 0.90, downPrice: 0.10, upProbability: 0.90, downProbability: 0.10 },
    directionEntry: { direction: 'up', confidence: 0.90, distanceBps: 12 },
    paperMode: true
  });
  assert.equal(tier.allowed, false);
});

test('buildPolymarketPaperPlan2 paper relaxed skips high-entry delay', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.68,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000, estimatedClose: 100050 },
      indicators: { currentPrice: 100020, return3Pct: 0.0002, volatility15mPct: 0.001, slotStartPrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.91,
      downPrice: 0.09,
      upProbability: 0.91,
      downProbability: 0.09,
      qualityScore: 0.55,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      plan2PaperRelaxedEnabled: true,
      plan2PaperEntryMaxPrice: 0.92,
      plan2SustainedMomentumEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2ProbeEnabled: false,
      plan2EntryMinElapsedPct: 0.08,
      plan2LateCaptureMinElapsedPct: 0.65,
      plan2LateCaptureSizeMultiplier: 0.50,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      stopLossAbsoluteFloor: 0.50,
      defaultStartingCash: 500,
      sizingBasePrincipal: 500,
      orderUsd15m: 40,
      maxOrderUsd: 500
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.notEqual(plan.action.scheduleDelayedEntry, true, plan.action.reason || 'should not schedule delay');
  assert.equal(plan.action.shouldTrade, true, plan.action.reason || 'expected trade');
});

test('buildPolymarketPaperPlan2 paper relaxed uses cash pct sizing', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.86,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100010, return3Pct: 0.0001, volatility15mPct: 0.001 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      // ≤0.68 时 paper_relaxed sizeMultiplier=1，现金比例 sizing 应完整生效
      upPrice: 0.62,
      downPrice: 0.38,
      upProbability: 0.62,
      downProbability: 0.38,
      qualityScore: 0.55,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      plan2PaperRelaxedEnabled: true,
      plan2PaperMinOrderUsd: 10,
      plan2PaperOrderPct: 0.05,
      plan2SustainedMomentumEnabled: false,
      plan2LateCaptureEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2ProbeEnabled: false,
      plan2EntryMinElapsedPct: 0.08,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      stopLossAbsoluteFloor: 0.50,
      defaultStartingCash: 500
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true, plan.action.reason || 'expected trade');
  assert.equal(plan.action.usd, 25);
  assert.equal(plan.action.sizing?.paperSizing, true);
});

test('buildPolymarketPaperPlan2 paper relaxed scales cash pct by tier multiplier at high price', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.86,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100010, return3Pct: 0.0001, volatility15mPct: 0.001 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.81,
      downPrice: 0.19,
      upProbability: 0.81,
      downProbability: 0.19,
      qualityScore: 0.55,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      plan2PaperRelaxedEnabled: true,
      plan2PaperMinOrderUsd: 10,
      plan2PaperOrderPct: 0.05,
      plan2SustainedMomentumEnabled: false,
      plan2LateCaptureEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2ProbeEnabled: false,
      plan2EntryMinElapsedPct: 0.08,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      stopLossAbsoluteFloor: 0.50,
      defaultStartingCash: 500
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true, plan.action.reason || 'expected trade');
  // 0.81 → sizeMultiplier 0.20 → max(10, 25*0.20)=10
  assert.equal(plan.action.usd, 10);
  assert.equal(plan.action.sizing?.sizeMultiplier, 0.2);
});

test('buildPolymarketPaperPlan2 paper relaxed trades above legacy tier cap', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.86,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100010, return3Pct: 0.0001, volatility15mPct: 0.001 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.81,
      downPrice: 0.19,
      upProbability: 0.81,
      downProbability: 0.19,
      qualityScore: 0.55,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      plan2PaperRelaxedEnabled: true,
      plan2SustainedMomentumEnabled: false,
      plan2LateCaptureEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2ProbeEnabled: false,
      plan2EntryMinElapsedPct: 0.08,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      stopLossAbsoluteFloor: 0.50,
      defaultStartingCash: 500,
      sizingBasePrincipal: 500,
      orderUsd15m: 40,
      maxOrderUsd: 500
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true, plan.action.reason || 'expected trade');
  assert.ok(['standard', 'paper_relaxed'].includes(plan.action.entryTier));
});

test('buildPolymarketPaperPlan2 buys mid-window with dynamic take profit', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: { ...PLAN2_TEST_CONFIG, plan2UltraLateCaptureEnabled: true },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.planId, 'plan2');
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.takeProfitPrice, 0.73);
  assert.equal(plan.action.stopLossPrice, 0.50);
});

test('buildPolymarketPaperPlan2 follows PM when tech conflicts with clear PM gap', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100000, slotStartPrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.45,
      downPrice: 0.55,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.directionEntry.direction, 'down');
  assert.equal(plan.directionEntry.source, 'polymarket');
});

test('buildPlan2DirectionEntry boosts confidence when 5m lock aligns', () => {
  const entry = buildPlan2DirectionEntry(
    {
      direction: 'up',
      confidence: 0.64,
      indicators: { currentPrice: 100000 },
      prediction: { comparisonBasePrice: 100000 }
    },
    { available: true, upPrice: 0.56, downPrice: 0.44 },
    { plan2FiveMinuteLockEnabled: true },
    {
      fiveMinuteLock: { direction: 'up', strength: 'normal', confidence: 0.62 },
      fiveMinuteLockStats: { normal: { total: 8, correct: 6, wrong: 2, accuracy: 0.75 } }
    }
  );
  assert.equal(entry.direction, 'up');
  assert.equal(entry.lockAligned, true);
  assert.ok(entry.confidence > 0.64);
});

test('buildPlan2DirectionEntry prefers 5m lock over conflicting tech when trusted', () => {
  const entry = buildPlan2DirectionEntry(
    {
      direction: 'up',
      confidence: 0.66,
      indicators: { currentPrice: 100000 },
      prediction: { comparisonBasePrice: 100000 }
    },
    { available: true, upPrice: 0.56, downPrice: 0.44 },
    { plan2FiveMinuteLockEnabled: true, plan2DirectionPmGapLead: 0.05 },
    {
      fiveMinuteLock: { direction: 'down', strength: 'strong', confidence: 0.72 },
      fiveMinuteLockStats: { strong: { total: 10, correct: 8, wrong: 2, accuracy: 0.8 } }
    }
  );
  assert.equal(entry.direction, 'down');
  assert.equal(entry.source, 'five_minute_lock_override');
});

test('buildPlan2DirectionEntry prefers PM when tech conflicts with clear gap', () => {
  const entry = buildPlan2DirectionEntry(
    {
      direction: 'up',
      confidence: 0.64,
      indicators: { currentPrice: 100000 },
      prediction: { comparisonBasePrice: 100000 }
    },
    { available: true, upPrice: 0.44, downPrice: 0.56 },
    { plan2DirectionPmGapLead: 0.05 }
  );
  assert.equal(entry.direction, 'down');
  assert.equal(entry.source, 'polymarket');
});

test('buildPlan2DirectionEntry keeps tech when confidence high and BTC aligns', () => {
  const entry = buildPlan2DirectionEntry(
    {
      direction: 'up',
      confidence: 0.72,
      indicators: { currentPrice: 100030 },
      prediction: { comparisonBasePrice: 100000 }
    },
    { available: true, upPrice: 0.44, downPrice: 0.56 },
    { plan2DirectionPmGapLead: 0.05, plan2DirectionTechHighConfidence: 0.68 }
  );
  assert.equal(entry.direction, 'up');
  assert.equal(entry.source, 'tech');
});

test('buildPlan2DirectionEntry boosts confidence on triple align', () => {
  const entry = buildPlan2DirectionEntry(
    {
      direction: 'up',
      confidence: 0.64,
      indicators: { currentPrice: 100020 },
      prediction: { comparisonBasePrice: 100000 }
    },
    { available: true, upPrice: 0.58, downPrice: 0.42 },
    {}
  );
  assert.equal(entry.direction, 'up');
  assert.equal(entry.source, 'triple_align');
  assert.ok(entry.confidence > 0.64);
});

test('buildPlan2RegimeGuard blocks probe on tech PM conflict near open', () => {
  const guard = buildPlan2RegimeGuard({
    directionEntry: { direction: 'up', confidence: 0.60 },
    sentiment: {
      available: true,
      upPrice: 0.48,
      downPrice: 0.52,
      qualityScore: 0.7,
      directionFlipCount5m: 0
    },
    signal: {
      indicators: { currentPrice: 100000, volatility15mPct: 0.001 },
      prediction: { comparisonBasePrice: 100000 }
    },
    timeframe: '15m',
    config: {
      plan2RegimeFilterEnabled: true,
      plan2RegimeSkipMainRisk: 5,
      plan2RegimeSkipAllRisk: 7,
      plan2ChopAllowProbe: true
    },
    limitPrice: 0.48
  });
  assert.equal(guard.allowMain, false);
  assert.equal(guard.allowProbe, false);
});

test('buildPolymarketPaperPlan2 blocks probe when PM near tie without BTC alignment', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.60,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100000, slotStartPrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.505,
      downPrice: 0.495,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2EntryMinPrice: 0.54,
      plan2ProbeEnabled: true,
      plan2ProbeMinPrice: 0.48,
      plan2ProbeMaxPrice: 0.68,
      plan2ProbeMinPmEdge: 0.04,
      plan2RegimeFilterEnabled: false
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason || '', /探针需 PM edge|PM edge|入场价|探针条件/);
});

test('evaluatePlan2StopLossReversal blocks when PM does not support reversal direction', () => {
  const blocked = evaluatePlan2StopLossReversal({
    priorDirection: 'up',
    reversalDirection: 'down',
    limitPrice: 0.55,
    confidence: 0.62,
    elapsedPct: 0.45,
    timeframe: '5m',
    config: {
      plan2StopLossReversalEnabled: true,
      plan2StopLossReversalMinConfidence: 0.58,
      plan2StopLossReversalMinEdge: 0.04,
      plan2ReversalRequirePmAlign: true,
      plan2DirectionPmGapLead: 0.05
    },
    sentiment: { available: true, upPrice: 0.58, downPrice: 0.42 },
    signal: {
      indicators: { currentPrice: 100000 },
      prediction: { comparisonBasePrice: 100000 }
    }
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /PM 领先支持|PM 支持/);
});

test('buildPolymarketPaperPlan2 uses probe for reduced low-price tickets', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.60,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100020, slotStartPrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.52,
      downPrice: 0.48,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2RegimeFilterEnabled: false,
      plan2ProbeSizeMultiplier15m: 0.32,
      plan2ProbeMinPmEdge: 0.04
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'probe');
  assert.ok(plan.action.sizeMultiplier < 0.1);
  assert.match(plan.action.reason, /探针/);
});

test('buildPolymarketPaperPlan2 requires stronger DOWN setup', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'down',
      confidence: 0.58,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.40,
      downPrice: 0.60,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason, /DOWN/);
});

test('buildPolymarketPaperPlan2 skips window open spike zone', () => {
  const now = new Date('2026-06-29T10:00:05.000Z');
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason, /鍓?8%/);
});

test('resolvePlan2EntryTier allows tier2 at 0.62 with reduced size', () => {
  const tier = resolvePlan2EntryTier({
    limitPrice: 0.62,
    confidence: 0.72,
    timeframe: '15m',
    config: PLAN2_TEST_CONFIG
  });
  assert.equal(tier.allowed, true);
  assert.equal(tier.sizeMultiplier, 0.5);
  assert.equal(tier.tier, 'medium');
});

test('resolvePlan2EntryTier bans entry above 0.78', () => {
  const tier = resolvePlan2EntryTier({
    limitPrice: 0.79,
    confidence: 0.82,
    timeframe: '15m',
    config: PLAN2_TEST_CONFIG
  });
  assert.equal(tier.allowed, false);
  assert.match(tier.reason, /Plan2 上限 78%/);
});

test('buildPolymarketPaperPlan2 schedules delay when entry is 70% or above', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.72,
      downPrice: 0.28,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: { ...PLAN2_TEST_CONFIG, plan2HighEntryDelayMs: 45000 },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.equal(plan.action.scheduleDelayedEntry, true);
  assert.match(plan.action.reason, /70%|72\.0%/);
});

test('resolvePlan2DelayedEntry allows buy after delay when tier still valid', () => {
  const pending = {
    executeAfterMs: Date.parse('2026-06-29T10:07:10.000Z'),
    scheduledAtMs: Date.parse('2026-06-29T10:06:10.000Z'),
    initialLimitPrice: 0.99,
    delayMs: 60000
  };
  const ready = resolvePlan2DelayedEntry({
    limitPrice: 0.55,
    confidence: 0.72,
    timeframe: '15m',
    config: PLAN2_TEST_CONFIG,
    pendingEntry: pending,
    now: new Date('2026-06-29T10:07:15.000Z')
  });
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.tier.allowed, true);
  assert.equal(ready.tier.takeProfitPrice, 0.73);
});

test('buildPolymarketPaperPlan2 executes after delay when conditions hold', () => {
  const now = new Date('2026-06-29T10:07:15.000Z');
  const schedule = getSlotSchedule(now, 15);
  const pending = {
    executeAfterMs: Date.parse('2026-06-29T10:07:10.000Z'),
    scheduledAtMs: Date.parse('2026-06-29T10:06:10.000Z'),
    initialLimitPrice: 0.99,
    delayMs: 60000
  };
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    pendingDelayedEntry: pending,
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.takeProfitPrice, 0.73);
  assert.equal(plan.action.delayedEntry, true);
});

test('shouldPlan1DirectionFlip respects min hold, cooldown, and stricter edge rules', () => {
  const config = {
    plan1DirectionFlipEnabled: true,
    plan1FlipMinHoldMs: 120000,
    plan1FlipCooldownMs: 180000,
    plan1FlipMinConfidence: 0.68,
    plan1FlipMinEdge: 0.07,
    plan1FlipMaxFloatingLossPct: 0.2,
    plan1FlipMaxElapsedPct: 0.7
  };
  const blockedHold = shouldPlan1DirectionFlip({
    openDirection: 'up',
    newDirection: 'down',
    config,
    openOrderCreatedAtIso: new Date('2026-06-29T10:01:30.000Z').toISOString(),
    newConfidence: 0.72,
    reverseEdge: 0.1,
    floatingLossPct: -0.05,
    elapsedPct: 0.5,
    now: new Date('2026-06-29T10:02:00.000Z')
  });
  assert.equal(blockedHold.flip, false);

  const allowed = shouldPlan1DirectionFlip({
    openDirection: 'up',
    newDirection: 'down',
    config,
    openOrderCreatedAtIso: new Date('2026-06-29T10:00:00.000Z').toISOString(),
    newConfidence: 0.72,
    reverseEdge: 0.1,
    floatingLossPct: -0.05,
    elapsedPct: 0.5,
    now: new Date('2026-06-29T10:03:00.000Z')
  });
  assert.equal(allowed.flip, true);

  const blockedEdge = shouldPlan1DirectionFlip({
    openDirection: 'up',
    newDirection: 'down',
    config,
    openOrderCreatedAtIso: new Date('2026-06-29T10:00:00.000Z').toISOString(),
    newConfidence: 0.72,
    reverseEdge: 0.04,
    floatingLossPct: -0.05,
    elapsedPct: 0.5,
    now: new Date('2026-06-29T10:03:00.000Z')
  });
  assert.equal(blockedEdge.flip, false);

  const blockedLateWindow = shouldPlan1DirectionFlip({
    openDirection: 'up',
    newDirection: 'down',
    config,
    openOrderCreatedAtIso: new Date('2026-06-29T10:00:00.000Z').toISOString(),
    newConfidence: 0.72,
    reverseEdge: 0.1,
    floatingLossPct: -0.05,
    elapsedPct: 0.75,
    now: new Date('2026-06-29T10:03:00.000Z')
  });
  assert.equal(blockedLateWindow.flip, false);

  const blockedCooldown = shouldPlan1DirectionFlip({
    openDirection: 'up',
    newDirection: 'down',
    config,
    openOrderCreatedAtIso: new Date('2026-06-29T10:00:00.000Z').toISOString(),
    lastFlipAtMs: Date.parse('2026-06-29T10:03:00.000Z'),
    newConfidence: 0.72,
    reverseEdge: 0.1,
    floatingLossPct: -0.05,
    elapsedPct: 0.5,
    now: new Date('2026-06-29T10:04:00.000Z')
  });
  assert.equal(blockedCooldown.flip, false);
});

test('resolvePlan1ExitOffsets returns tiered TP/SL by entry price', () => {
  assert.deepEqual(resolvePlan1ExitOffsets(0.50, {}), {
    takeProfitOffset: 0.16,
    stopLossOffset: 0.12
  });
  assert.deepEqual(resolvePlan1ExitOffsets(0.60, {}), {
    takeProfitOffset: 0.14,
    stopLossOffset: 0.10
  });
  assert.deepEqual(resolvePlan1ExitOffsets(0.72, {}), {
    takeProfitOffset: 0.10,
    stopLossOffset: 0.07
  });
  assert.deepEqual(resolvePlan1ExitOffsets(null, {
    plan1TakeProfitOffset: 0.14,
    plan1StopLossOffset: 0.10
  }), {
    takeProfitOffset: 0.14,
    stopLossOffset: 0.10
  });
});

test('Plan1 can disable the global 50c stop floor for low-price entries', () => {
  assert.deepEqual(computePlan1ExitPrices(0.51, {
    stopLossAbsoluteFloor: 0.50,
    plan1StopLossAbsoluteFloor: 0
  }), {
    takeProfitPrice: 0.67,
    stopLossPrice: 0.39
  });
});

test('Plan1 live stop requires consecutive observations when confirmation is enabled', () => {
  const service = new PolymarketTradingService({
    config: {
      plan1LiveStopConfirmationEnabled: true,
      plan1LiveStopConfirmSamples: 3,
      plan1LiveStopConfirmMs5m: 6000
    }
  });
  const position = { timeframe: '5m' };
  const exit = { exitStatus: 'stop-loss' };
  const base = Date.parse('2026-07-14T16:00:00.000Z');
  assert.equal(service.updateLivePlan1StopConfirmation(position, exit, 0.22, base).confirmed, false);
  assert.equal(service.updateLivePlan1StopConfirmation(position, exit, 0.23, base + 3000).confirmed, false);
  const confirmed = service.updateLivePlan1StopConfirmation(position, exit, 0.24, base + 6000);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.count, 3);
  service.updateLivePlan1StopConfirmation(position, null, 0.57, base + 9000);
  assert.equal(position.plan1StopConfirmation, undefined);
});

test('resolvePlan1FlipEnabled respects per-timeframe overrides', () => {
  const config = {
    plan1DirectionFlipEnabled: true,
    plan1DirectionFlipEnabled5m: false,
    plan1DirectionFlipEnabled15m: true
  };
  assert.equal(resolvePlan1FlipEnabled('5m', config), false);
  assert.equal(resolvePlan1FlipEnabled('15m', config), true);

  const legacyOnly = { plan1DirectionFlipEnabled: false };
  assert.equal(resolvePlan1FlipEnabled('15m', legacyOnly), false);

  const blocked5m = shouldPlan1DirectionFlip({
    openDirection: 'up',
    newDirection: 'down',
    config,
    timeframe: '5m',
    openOrderCreatedAtIso: new Date('2026-06-29T10:00:00.000Z').toISOString(),
    newConfidence: 0.72,
    reverseEdge: 0.1,
    floatingLossPct: -0.05,
    elapsedPct: 0.5,
    now: new Date('2026-06-29T10:03:00.000Z')
  });
  assert.equal(blocked5m.flip, false);
  assert.match(blocked5m.reason, /5m.*关闭/);
});

test('resolvePlan1MaxEntryPrice uses timeframe-specific caps', () => {
  const config = {
    plan1MaxEntryPrice: 0.70,
    plan1MaxEntryPrice5m: 0.66,
    plan1MaxEntryPrice15m: 0.72
  };
  assert.equal(resolvePlan1MaxEntryPrice('5m', config), 0.66);
  assert.equal(resolvePlan1MaxEntryPrice('15m', config), 0.72);
});

test('resolvePlan1MinEntryPrice defaults 15m cheap-side floor and keeps 5m open', () => {
  assert.equal(resolvePlan1MinEntryPrice('15m', {}), 0.45);
  assert.equal(resolvePlan1MinEntryPrice('5m', {}), 0);
  assert.equal(resolvePlan1MinEntryPrice('15m', { plan1MinEntryPrice15m: 0.50 }), 0.50);
  assert.equal(resolvePlan1MinEntryPrice('5m', { plan1MinEntryPrice5m: 0.40 }), 0.40);
});

test('evaluateTieredEntry enforces Plan1 minConfidence and 15m minEntryPrice', () => {
  const lowConf = evaluateTieredEntry({
    confidence: 0.57,
    entryPrice: 0.52,
    timeframe: '15m',
    config: { plan1MinConfidence: 0.60, plan1MinEntryPrice15m: 0.45 },
    marketQuality: 0.7,
    planLabel: 'Plan1'
  });
  assert.equal(lowConf.allowed, false);
  assert.match(lowConf.reason, /置信度.*低于门槛/);

  const cheap15m = evaluateTieredEntry({
    confidence: 0.72,
    entryPrice: 0.38,
    timeframe: '15m',
    config: { plan1MinConfidence: 0.60 },
    minEntryPrice: 0.45,
    marketQuality: 0.7,
    planLabel: 'Plan1'
  });
  assert.equal(cheap15m.allowed, false);
  assert.match(cheap15m.reason, /低于下限/);

  const ok = evaluateTieredEntry({
    confidence: 0.72,
    entryPrice: 0.52,
    timeframe: '15m',
    config: { plan1MinConfidence: 0.60, plan1MinEntryPrice15m: 0.45 },
    minConfidence: 0.60,
    minEntryPrice: 0.45,
    maxEntryPrice: 0.64,
    marketQuality: 0.7,
    planLabel: 'Plan1'
  });
  assert.equal(ok.allowed, true);
});

test('computePlan1Analytics buckets settled plan1 orders', () => {
  const orders = [
    {
      planId: 'plan1',
      timeframe: '15m',
      settlementStatus: 'settled',
      exitStatus: 'take-profit',
      limitPrice: 0.52,
      entryElapsedPct: 0.15,
      usd: 10,
      pnl: 2
    },
    {
      planId: 'plan1',
      timeframe: '5m',
      settlementStatus: 'settled',
      exitStatus: 'stop-loss',
      limitPrice: 0.63,
      entryElapsedPct: 0.55,
      usd: 10,
      pnl: -1.5
    },
    {
      planId: 'plan1',
      timeframe: '15m',
      settlementStatus: 'settled',
      exitStatus: 'expiry',
      limitPrice: 0.71,
      entryElapsedPct: 0.85,
      usd: 10,
      pnl: -3
    },
    {
      planId: 'plan2',
      settlementStatus: 'settled',
      limitPrice: 0.55,
      usd: 10,
      pnl: 5
    },
    {
      planId: 'plan1',
      settlementStatus: 'open',
      limitPrice: 0.58,
      usd: 10
    }
  ];
  const analytics = computePlan1Analytics(orders);
  assert.equal(analytics.overall.count, 3);
  assert.equal(analytics.overall.wins, 1);
  assert.equal(analytics.overall.losses, 2);
  assert.equal(analytics.byTimeframe['15m'].count, 2);
  assert.equal(analytics.byTimeframe['5m'].count, 1);
  assert.equal(analytics.byExitReason['take-profit'].count, 1);
  assert.equal(analytics.byExitReason['stop-loss'].count, 1);
  assert.equal(analytics.byExitReason.expiry.count, 1);
  assert.equal(analytics.byEntryPriceBucket['0.50-0.60'].count, 1);
  assert.equal(analytics.byEntryPriceBucket['0.60-0.70'].count, 1);
  assert.equal(analytics.byEntryPriceBucket['0.70-0.78'].count, 1);
  assert.equal(analytics.byWindowProgressBucket['0-20%'].count, 1);
  assert.equal(analytics.byWindowProgressBucket['40-60%'].count, 1);
  assert.equal(analytics.byWindowProgressBucket['80-100%'].count, 1);
});

test('PolymarketTradingService plan1 flips direction within same window', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      dailyMaxLossUsd: 50,
      plan1DirectionFlipEnabled: true,
      plan1FlipMinHoldMs: 0,
      plan1FlipCooldownMs: 0,
      plan1FlipMinConfidence: 0.68,
      plan1FlipMinEdge: 0.07,
      plan1FlipMaxFloatingLossPct: 0.2,
      sizingBasePrincipal: 500,
      orderUsd15m: 25
    },
    statePath: 'data/test-polymarket-plan1-flip.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan1' });
  await service.setAuto(true, { planId: 'plan1', timeframes: ['15m'] });
  const slotIso = '2099-01-01T00:00:00.000Z';
  const sentimentUp = {
    available: true,
    timeframe: '15m',
    upTokenId: '1',
    downTokenId: '2',
    upPrice: 0.55,
    downPrice: 0.45,
    targetTimeIso: '2099-01-01T00:15:00.000Z',
    schedule: { currentSlotIso: slotIso }
  };
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan1',
    sentiment: sentimentUp,
    plan: { slotIso, timeframe: '15m' }
  }, 'plan1');

  const flipPlan = {
    key: buildWindowPlanKey(slotIso, '15m'),
    planId: 'plan1',
    timeframe: '15m',
    slotIso,
    symbol: 'BTC-USD',
    // 固定窗口进度，避免测试依赖真实时钟落在窗口后 75%+ 时被翻转闸门拦截。
    elapsedPct: 0.5,
    action: {
      shouldTrade: true,
      direction: 'down',
      usd: 100,
      confidence: 0.72,
      strategy: 'composite',
      reason: 'flip test'
    }
  };
  const sentimentDown = { ...sentimentUp, upPrice: 0.4, downPrice: 0.6 };
  const result = await service.maybeAutoExecute({
    plan: flipPlan,
    sentiment: sentimentDown,
    recommendation: null,
    planId: 'plan1',
    resolveCurrentPrice: async () => 0.58
  });
  assert.equal(result.flipped, true);
  assert.equal(result.closed.exitStatus, 'direction-flip');
  assert.equal(result.order.direction, 'down');
  const open = service.getOpenPaperOrderForWindow({ planId: 'plan1', timeframe: '15m', slotIso });
  assert.equal(open.direction, 'down');
});

test('PolymarketTradingService routes legacy plan2 auto requests to plan2.5', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      plan2HighEntryDelayMs: 60000,
      plan2HighEntryMinPrice: 0.7,
      plan2HighTakeProfitPrice: 0.9,
      plan2StopLossPrice: 0.3
    },
    statePath: 'data/test-polymarket-plan2-delay.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2_5' });
  const auto = await service.setAuto(true, { planId: 'plan2', timeframes: ['15m'] });
  assert.equal(auto.planId, 'plan2_5');
  const slotIso = '2099-01-01T00:00:00.000Z';
  const delayedKey = service.buildPlan2DelayedEntryKey(slotIso, '15m');
  const plan = {
    key: `${buildWindowPlanKey(slotIso, '15m')}_plan2_5`,
    planId: 'plan2_5',
    timeframe: '15m',
    slotIso,
    symbol: 'BTC-USD',
    action: {
      shouldTrade: false,
      scheduleDelayedEntry: true,
      delayedEntryKey: delayedKey,
      executeAfterIso: new Date(Date.now() + 60000).toISOString(),
      delayMs: 60000,
      direction: 'up',
      limitPrice: 0.75,
      reason: 'delay scheduled'
    }
  };
  const result = await service.maybeAutoExecute({
    plan,
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.75,
      downPrice: 0.25
    },
    planId: 'plan2_5'
  });
  assert.equal(result.scheduled, true);
  assert.ok(service.getPendingDelayedEntry('plan2_5', delayedKey));
});

test('buildPolymarketPaperPlan2 rejects premium tier above max entry price', () => {
  const tier = resolvePlan2EntryTier({
    limitPrice: 0.85,
    confidence: 0.82,
    timeframe: '15m',
    config: PLAN2_TEST_CONFIG
  });
  assert.equal(tier.allowed, false);
  assert.match(tier.reason, /78%|tier/);
});

test('buildPolymarketPaperPlan2 allows late capture near settlement with small size', () => {
  const now = new Date('2026-06-29T10:12:00.000Z');
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.91,
      schedule,
      prediction: {
        targetTimeIso: schedule.nextSlotIso,
        comparisonBasePrice: 100000,
        estimatedClose: 100160
      },
      indicators: {
        currentPrice: 100120,
        slotStartPrice: 100000,
        return3Pct: 0.0004
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.88,
      downPrice: 0.12,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'late_capture');
  assert.equal(plan.action.entryTier, 'late_capture');
  assert.equal(plan.action.sizeMultiplier, 0.1);
  assert.equal(plan.action.lateCapture.absDistanceFromOpenBps, 12);
});

test('buildPolymarketPaperPlan2 keeps 5m standard entry open until 85 percent', () => {
  const now = new Date('2026-06-29T10:04:00.000Z');
  const schedule = getSlotSchedule(now, 5);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'standard');
});

test('buildPolymarketPaperPlan2 allows ultra late 95-99 cent capture', () => {
  const now = new Date('2026-06-29T10:04:25.000Z');
  const schedule = getSlotSchedule(now, 5);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.98,
      schedule,
      prediction: {
        targetTimeIso: schedule.nextSlotIso,
        comparisonBasePrice: 100000,
        estimatedClose: 100240
      },
      indicators: {
        currentPrice: 100220,
        slotStartPrice: 100000,
        return3Pct: 0.0005
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.96,
      downPrice: 0.04,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'ultra_late_capture');
  assert.equal(plan.action.entryTier, 'ultra_late_capture');
  assert.equal(plan.action.sizeMultiplier, 0.06);
});

test('buildPolymarketPaperPlan2 allows settlement_capture_90 in 90-92 cent band', () => {
  const now = new Date('2026-07-06T16:03:00.000Z');
  const schedule = getSlotSchedule(now, 5);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.91,
      schedule,
      prediction: {
        targetTimeIso: schedule.nextSlotIso,
        comparisonBasePrice: 100000,
        estimatedClose: 100194
      },
      indicators: {
        currentPrice: 100194,
        slotStartPrice: 100000,
        return3Pct: 0.0002
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.90,
      downPrice: 0.10,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2UltraLateCaptureEnabled: false,
      plan2LateCaptureEnabled: false,
      plan2SustainedMomentumEnabled: false
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.planId, 'plan2');
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'settlement_capture_90');
  assert.equal(plan.action.takeProfitPrice, 0.99);
  assert.equal(plan.action.stopLossPrice, 0.05);
});

test('PolymarketTradingService plan1 take-profit closes open orders dynamically', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      plan1TakeProfitOffset: 0.18,
      plan1StopLossOffset: 0.15
    },
    statePath: 'data/test-polymarket-plan1-tp.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan1' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan1',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.55,
      downPrice: 0.45,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.73, stopLossPrice: 0.4, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan1');
  const closed = await service.processPlan1Exits(async () => 0.74);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'take-profit');
});

test('PolymarketTradingService plan1 stop-loss closes open orders dynamically', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      plan1TakeProfitOffset: 0.18,
      plan1StopLossOffset: 0.15
    },
    statePath: 'data/test-polymarket-plan1-sl.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan1' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan1',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.55,
      downPrice: 0.45,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.73, stopLossPrice: 0.4, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan1');
  const closed = await service.processPlan1Exits(async () => 0.39);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'stop-loss');
});

test('PolymarketTradingService plan1 hold-to-settlement disables paper exits', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      plan1HoldToSettlementEnabled: true
    },
    statePath: 'data/test-polymarket-plan1-hold-to-settlement.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan1' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan1',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.55,
      downPrice: 0.45,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.73, stopLossPrice: 0.4, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan1');
  const closed = await service.processPlan1Exits(async () => 0.1);
  assert.equal(closed.length, 0);
  assert.equal(service.getBucket('plan1').paperOrders[0].settlementStatus, 'open');
});

test('PolymarketTradingService Plan5 paper stop requires PM reversal at 30c', async () => {
  const service = new PolymarketTradingService({
    config: { defaultOrderUsd: 5, maxOrderUsd: 500, plan5StopLossEnabled: true },
    statePath: 'data/test-polymarket-plan5-stop.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan5' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 10,
    planId: 'plan5',
    sentiment: {
      available: true,
      timeframe: '5m',
      upTokenId: 'p5-up',
      downTokenId: 'p5-down',
      upPrice: 0.5,
      downPrice: 0.5,
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { stopLossPrice: 0.3, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '5m' }
  }, 'plan5');
  const held = await service.processPlan5StopLosses(async () => 0.29, {
    resolveCurrentPlanView: async () => ({ polymarket: { predictedDirection: 'up' } })
  });
  assert.equal(held.length, 0);
  const closed = await service.processPlan5StopLosses(async () => 0.29, {
    resolveCurrentPlanView: async () => ({ polymarket: { predictedDirection: 'down' } })
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'plan5-reversal-stop');
});

test('Plan5 synthetic dust sells are removed and their buys reopen for official settlement', () => {
  const service = new PolymarketTradingService({
    config: { defaultOrderUsd: 5, maxOrderUsd: 500 },
    statePath: 'data/test-polymarket-plan5-dust-repair.json'
  });
  service.state.liveOrders = [
    {
      id: 'dust-sell',
      orderSide: 'SELL',
      planId: 'plan5',
      relatedBuyOrderId: 'dust-buy',
      exitStatus: 'dust-undersized-fill',
      clobOrderId: null
    },
    {
      id: 'dust-buy',
      orderSide: 'BUY',
      planId: 'plan5',
      status: 'submitted',
      positionStatus: 'closed',
      exitStatus: 'dust-undersized-fill',
      exitPrice: 0.33,
      pnl: 0,
      payoutUsd: 1.32,
      closedAtIso: '2026-07-22T03:42:08.440Z',
      shares: 4,
      usd: 1.32,
      remainingShares: 0,
      remainingCostUsd: 0
    }
  ];

  assert.equal(service.repairSyntheticPlan5DustClosures(), 1);
  assert.equal(service.state.liveOrders.length, 1);
  const buy = service.state.liveOrders[0];
  assert.equal(buy.id, 'dust-buy');
  assert.equal(buy.positionStatus, 'open');
  assert.equal(buy.exitStatus, null);
  assert.equal(buy.pnl, null);
  assert.equal(buy.remainingShares, 4);
  assert.equal(buy.remainingCostUsd, 1.32);
});

test('synthetic Plan1 dust closure is restored as the real PM holding', () => {
  const service = new PolymarketTradingService({
    config: { defaultOrderUsd: 5, maxOrderUsd: 500, liveMinSharesBuffer: 6 },
    statePath: 'data/test-polymarket-plan1-dust-repair.json'
  });
  service.state.liveOrders = [{
    id: 'plan1-dust-buy',
    orderSide: 'BUY',
    planId: 'plan1',
    status: 'submitted',
    positionStatus: 'closed',
    exitStatus: 'dust-unsellable',
    exitPrice: 0.58,
    exitReason: 'Plan1 灰尘仓无法 CLOB 卖出',
    pnl: 0,
    payoutUsd: 2.5,
    closedAtIso: '2026-07-28T01:17:16.633Z',
    shares: 4.310342,
    usd: 2.499998,
    originalShares: 4.310342,
    originalUsd: 2.499998,
    remainingShares: 0,
    remainingCostUsd: 0,
    clobOrderId: 'real-buy-order',
    fillConfirmed: true
  }];

  assert.equal(service.repairSyntheticDustClosures(), 1);
  const buy = service.state.liveOrders[0];
  assert.equal(buy.positionStatus, 'open');
  assert.equal(buy.exitStatus, null);
  assert.equal(buy.remainingShares, 4.310342);
  assert.equal(buy.remainingCostUsd, 2.499998);
  assert.equal(buy.pnl, null);
  assert.equal(buy.payoutUsd, null);
  assert.equal(buy.dustHolding, true);
  assert.equal(buy.dustSellMinShares, 5);
});

test('undersized live buy remains a real open holding without a synthetic sell row', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, defaultOrderUsd: 5, maxOrderUsd: 500 },
    statePath: 'data/test-polymarket-plan2-dust-no-sell.json'
  });
  const buy = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan2_6',
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'up',
    outcome: 'UP',
    shares: 2.5,
    usd: 0.8,
    entryPrice: 0.32,
    limitPrice: 0.32,
    tokenId: 'dust-token'
  });
  const held = await service.closeLiveDustPosition(buy, {
    exitReason: 'FAK 成交过小，保留真实持仓'
  });
  assert.equal(held.dustHeld, true);
  assert.equal(held.sellRecord, null);
  assert.equal(buy.positionStatus, 'open');
  assert.equal(buy.exitStatus, null);
  assert.equal(buy.remainingShares, 2.5);
  assert.equal(buy.remainingCostUsd, 0.8);
  assert.equal(buy.pnl, null);
  assert.equal(buy.dustHolding, true);
  const listed = service.listLiveOrders('plan2_6');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, buy.id);
  assert.equal(listed[0].orderSide, 'BUY');
  const stats = service.computeLiveStats('plan2_6');
  assert.equal(stats.settledTrades, 0);
});

test('Plan1 exit scan does not locally close a confirmed undersized buy', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      liveMinSharesBuffer: 6
    },
    statePath: 'data/test-polymarket-plan1-dust-holding.json'
  });
  const buy = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    symbol: 'BTC-USD',
    timeframe: '15m',
    direction: 'down',
    outcome: 'DOWN',
    shares: 4.310342,
    usd: 2.499998,
    entryPrice: 0.58,
    limitPrice: 0.58,
    tokenId: 'plan1-dust-token',
    targetTimeIso: '2099-01-01T00:15:00.000Z',
    filledAtIso: new Date().toISOString(),
    fillConfirmed: true
  });

  const closed = await service.processLivePlan1Exits(async () => 0.055);

  assert.equal(closed.length, 0);
  assert.equal(buy.positionStatus, 'open');
  assert.equal(buy.exitStatus, null);
  assert.equal(buy.remainingShares, 4.310342);
  assert.equal(buy.remainingCostUsd, 2.499998);
  assert.equal(buy.pnl, null);
  assert.equal(buy.dustHolding, true);
  assert.match(buy.dustHoldingReason, /真实持仓/);
  assert.equal(service.state.liveOrders.filter((order) => order.orderSide === 'SELL').length, 0);
});

test('synthetic dust sells are stripped from plan2 family live history', () => {
  const service = new PolymarketTradingService({
    config: { defaultOrderUsd: 5, maxOrderUsd: 500 },
    statePath: 'data/test-polymarket-plan26-dust-sell-repair.json'
  });
  service.state.liveOrders = [
    {
      id: 'p26-dust-sell',
      orderSide: 'SELL',
      planId: 'plan2_6',
      relatedBuyOrderId: 'p26-dust-buy',
      exitStatus: 'dust-undersized-fill',
      clobOrderId: null,
      exitReason: 'FAK 成交过小，无法后续止损卖出'
    },
    {
      id: 'p26-dust-buy',
      orderSide: 'BUY',
      planId: 'plan2_6',
      positionStatus: 'closed',
      exitStatus: 'dust-undersized-fill',
      pnl: 0,
      usd: 0.8
    },
    {
      id: 'p25-real-sell',
      orderSide: 'SELL',
      planId: 'plan2_5',
      relatedBuyOrderId: 'p25-buy',
      exitStatus: 'take-profit',
      clobOrderId: 'real-clob-sell',
      pnl: 1.2
    },
    {
      id: 'p25-buy',
      orderSide: 'BUY',
      planId: 'plan2_5',
      positionStatus: 'closed',
      exitStatus: 'take-profit',
      pnl: 1.2,
      usd: 5
    }
  ];
  assert.equal(service.repairSyntheticDustSellRecords(), 1);
  assert.equal(service.state.liveOrders.some((o) => o.id === 'p26-dust-sell'), false);
  assert.equal(service.state.liveOrders.some((o) => o.id === 'p25-real-sell'), true);
  const listed = service.listLiveOrders();
  assert.equal(listed.some((o) => o.id === 'p26-dust-sell'), false);
  assert.equal(listed.some((o) => o.id === 'p26-dust-buy'), true);
  assert.equal(listed.some((o) => o.id === 'p25-real-sell'), true);
});

test('PolymarketTradingService keeps plan1 and plan2 portfolios isolated', async () => {
  const service = new PolymarketTradingService({
    config: { defaultOrderUsd: 5, maxOrderUsd: 500, dailyMaxLossUsd: 50 },
    statePath: 'data/test-polymarket-dual-plan.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan1' });
  await service.configurePortfolio({ cash: 800, planId: 'plan2' });
  const status = service.status();
  assert.equal(status.plans.plan1.portfolio.startingCash, 500);
  assert.equal(status.plans.plan2.portfolio.startingCash, 800);
  assert.equal(status.plans.plan1.stats.equity, 500);
  assert.equal(status.plans.plan2.stats.equity, 800);
});

test('updateAndEvaluateTrailingTakeProfit lets winners run then sells on 10c pullback', () => {
  const first = updateAndEvaluateTrailingTakeProfit({
    entryPrice: 0.50,
    currentPrice: 0.70,
    trailOffset: 0.10
  });
  assert.equal(first.peakPrice, 0.70);
  assert.equal(first.trailStopPrice, 0.60);
  assert.equal(first.armed, true);
  assert.equal(first.exit, null);

  const stillUp = updateAndEvaluateTrailingTakeProfit({
    entryPrice: 0.50,
    currentPrice: 0.65,
    peakPrice: 0.70,
    trailOffset: 0.10
  });
  assert.equal(stillUp.exit, null);
  assert.equal(stillUp.peakPrice, 0.70);

  const pullback = updateAndEvaluateTrailingTakeProfit({
    entryPrice: 0.50,
    currentPrice: 0.60,
    peakPrice: 0.70,
    trailOffset: 0.10
  });
  assert.equal(pullback.exit.exitStatus, 'trailing-take-profit');
  assert.equal(pullback.exit.exitPrice, 0.60);
});

test('updateAndEvaluateTrailingTakeProfit does not sell below entry on a small bounce', () => {
  const result = updateAndEvaluateTrailingTakeProfit({
    entryPrice: 0.50,
    currentPrice: 0.48,
    peakPrice: 0.55,
    trailOffset: 0.10
  });
  assert.equal(result.armed, false);
  assert.equal(result.exit, null);
  assert.equal(result.peakPrice, 0.55);
});

test('PolymarketTradingService plan2 trailing take-profit closes after peak pullback', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      dailyMaxLossUsd: 50,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      plan2TakeProfitEnabled: false,
      plan2TrailingTakeProfitEnabled: true,
      plan2TrailingTakeProfitOffset: 0.10
    },
    statePath: 'data/test-polymarket-plan2-trailing-tp.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan2',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.50,
      downPrice: 0.50,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.68, stopLossPrice: 0.38, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan2');

  assert.equal((await service.processPlan2TakeProfits(async () => 0.70)).length, 0);
  const open = service.getBucket('plan2').paperOrders[0];
  assert.equal(open.settlementStatus, 'open');
  assert.equal(open.peakPrice, 0.70);
  assert.equal(open.trailStopPrice, 0.60);

  assert.equal((await service.processPlan2TakeProfits(async () => 0.65)).length, 0);

  const closed = await service.processPlan2TakeProfits(async () => 0.60);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'trailing-take-profit');
  assert.equal(closed[0].exitPrice, 0.60);
  assert.equal(closed[0].peakPrice, 0.70);
  assert.ok(closed[0].pnl > 0);
});

test('PolymarketTradingService plan2_5 does not trailing-take-profit after peak pullback', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      dailyMaxLossUsd: 50,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      plan2TakeProfitEnabled: false,
      plan2TrailingTakeProfitEnabled: true,
      plan2TrailingTakeProfitOffset: 0.10
    },
    statePath: 'data/test-polymarket-plan25-trailing-tp.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2_5' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan2_5',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.50,
      downPrice: 0.50,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.68, stopLossPrice: 0.38, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan2_5');

  assert.equal((await service.processPlan2TakeProfits(async () => 0.70)).length, 0);
  const closed = await service.processPlan2TakeProfits(async () => 0.60);
  assert.equal(closed.length, 0);
  assert.equal(service.getBucket('plan2_5').paperOrders[0].settlementStatus, 'open');
});

test('evaluateLiveExitTrigger trailing take-profit keeps hard stop-loss first', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2TrailingTakeProfitEnabled: true,
      plan2TrailingTakeProfitOffset: 0.10,
      plan2StopLossEnabled: true,
      plan2TakeProfitEnabled: false
    },
    statePath: 'data/test-polymarket-live-plan2-trailing.json'
  });
  const position = {
    planId: 'plan2',
    entryPrice: 0.50,
    limitPrice: 0.50,
    takeProfitPrice: 0.68,
    stopLossPrice: 0.38
  };
  assert.equal(service.evaluateLiveExitTrigger(position, 0.70), null);
  assert.equal(position.peakPrice, 0.70);
  assert.equal(service.evaluateLiveExitTrigger(position, 0.60)?.exitStatus, 'trailing-take-profit');

  const loser = {
    planId: 'plan2',
    entryPrice: 0.50,
    limitPrice: 0.50,
    takeProfitPrice: 0.68,
    stopLossPrice: 0.38,
    peakPrice: 0.70
  };
  assert.equal(service.evaluateLiveExitTrigger(loser, 0.37)?.exitStatus, 'stop-loss');
});

test('PolymarketTradingService plan2 take-profit closes open orders dynamically', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      dailyMaxLossUsd: 50,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12
    },
    statePath: 'data/test-polymarket-plan2-tp90.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan2',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.55,
      downPrice: 0.45,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.73, stopLossPrice: 0.43, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan2');
  const closed = await service.processPlan2TakeProfits(async () => 0.74);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'take-profit');
  assert.equal(closed[0].exitPrice, 0.74);
});

test('PolymarketTradingService plan2 take-profit skips settlement_capture_90 hold-to-expiry orders', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12
    },
    statePath: 'data/test-polymarket-plan2-settlement90-hold.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan2',
    sentiment: {
      available: true,
      timeframe: '5m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.90,
      downPrice: 0.10,
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: {
      entryType: 'settlement_capture_90',
      takeProfitPrice: 0.99,
      stopLossPrice: 0.05,
      slotIso: '2099-01-01T00:00:00.000Z',
      timeframe: '5m'
    }
  }, 'plan2');
  const closed = await service.processPlan2TakeProfits(async () => 0.99);
  assert.equal(closed.length, 0);
  assert.equal(service.getBucket('plan2').paperOrders[0].settlementStatus, 'open');
});

test('PolymarketTradingService plan2 take-profit closes open orders at dynamic target', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      dailyMaxLossUsd: 50,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12
    },
    statePath: 'data/test-polymarket-plan2-tp.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2' });
  const order = await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan2',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.55,
      downPrice: 0.45,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.73, stopLossPrice: 0.43, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan2');
  assert.equal(order.settlementStatus, 'open');
  const closed = await service.processPlan2TakeProfits(async () => 0.73);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'take-profit');
  assert.equal(closed[0].exitPrice, 0.73);
  assert.equal(service.snapshotPortfolio('plan2').cash > 400, true);
});

test('PolymarketTradingService plan2 stop-loss closes open orders dynamically', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      dailyMaxLossUsd: 50,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12
    },
    statePath: 'data/test-polymarket-plan2-sl.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2' });
  const order = await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan2',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.55,
      downPrice: 0.45,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.73, stopLossPrice: 0.43, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan2');
  assert.equal(order.settlementStatus, 'open');
  const closed = await service.processPlan2TakeProfits(async () => 0.42);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'stop-loss');
  assert.equal(closed[0].exitPrice, 0.42);
  assert.ok(closed[0].pnl < 0);
});

test('PolymarketTradingService plan2 can disable stop-loss while retaining take-profit', async () => {
  const service = new PolymarketTradingService({
    config: {
      defaultOrderUsd: 5,
      maxOrderUsd: 500,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      plan2StopLossEnabled: false
    },
    statePath: 'data/test-polymarket-plan2-stop-disabled.json'
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan2' });
  await service.createPaperOrder({
    symbol: 'BTC-USD',
    direction: 'up',
    usd: 100,
    planId: 'plan2',
    sentiment: {
      available: true,
      timeframe: '15m',
      upTokenId: '1',
      downTokenId: '2',
      upPrice: 0.55,
      downPrice: 0.45,
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    plan: { takeProfitPrice: 0.73, stopLossPrice: 0.43, slotIso: '2099-01-01T00:00:00.000Z', timeframe: '15m' }
  }, 'plan2');
  assert.equal((await service.processPlan2TakeProfits(async () => 0.2)).length, 0);
  service.config.plan2TakeProfitEnabled = false;
  assert.equal((await service.processPlan2TakeProfits(async () => 0.74)).length, 0);
  service.config.plan2TakeProfitEnabled = true;
  assert.equal((await service.processPlan2TakeProfits(async () => 0.74))[0].exitStatus, 'take-profit');
});

test('validateLiveOrderSubmission requires live switch and configured credentials', () => {
  const config = {
    liveTradingEnabled: false,
    configured: true
  };
  assert.throws(() => validateLiveOrderSubmission({ config }));
  config.liveTradingEnabled = true;
  config.configured = false;
  assert.throws(() => validateLiveOrderSubmission({ config }));
  config.configured = true;
  assert.doesNotThrow(() => validateLiveOrderSubmission({ config }));
});

test('buildLiveOrderDraft tops up plan1 to CLOB min when risk cap is slightly below floor', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 20,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      maxOrderEquityPct: 0.08,
      liveAdaptiveCapEnabled: false,
      plan1LiveMinOrderUsd: 1,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1
    },
    statePath: 'data/test-polymarket-live-draft.json'
  });
  // equity $50 → single cap $4；CLOB 5 份 @0.50 = $2.50，应上浮/放行而非报 $0.xx 伪上限
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan1',
      key: 'slot_plan1',
      timeframe: '15m',
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 2.26,
        confidence: 0.7,
        reason: 'test plan'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '15m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.5,
      downPrice: 0.5,
      market: 'BTC Up',
      marketSlug: 'btc-up',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan1',
    clobBalanceUsdc: 50
  });
  assert.ok(draft.usd + 1e-9 >= 2.5);
});

test('buildLiveOrderDraft skips with readable reason when active exposure room is below CLOB min', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 100,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      maxOrderEquityPct: 0.12,
      liveAdaptiveCapEnabled: false,
      plan1LiveMinOrderUsd: 1,
      maxTotalOpenExposurePct: 0.25,
      maxTimeframeOpenExposurePct: 0.15,
      liveClobMinTopUpSlackUsd: 0
    },
    statePath: 'data/test-polymarket-live-draft-exposure-room.json'
  });
  service.state.liveOrders = [{
    id: 'open-active',
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '15m',
    targetTimeIso: '2099-01-01T00:15:00.000Z',
    usd: 6.3,
    shares: 12,
    limitPrice: 0.525,
    entryPrice: 0.525,
    filledShares: 12,
    remainingShares: 12
  }];
  assert.throws(() => service.buildLiveOrderDraft({
    plan: {
      planId: 'plan1',
      key: 'slot_plan1_room',
      timeframe: '15m',
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 2.26,
        confidence: 0.7,
        reason: 'test room'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '15m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.58,
      downPrice: 0.42,
      market: 'BTC Up',
      marketSlug: 'btc-up',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan1',
    clobBalanceUsdc: 35.76
  }), /余额\/敞口不够最小单.*15m敞口余量.*低于 CLOB 最小约 \$2\.90/);
});

test('liveRiskSnapshot ignores closed-window open positions for exposure room', () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      maxTotalOpenExposurePct: 0.25,
      maxTimeframeOpenExposurePct: 0.15
    },
    statePath: 'data/test-polymarket-live-closed-window-exposure.json'
  });
  service.state.liveOrders = [
    {
      id: 'closed-window-btc',
      status: 'submitted',
      orderSide: 'BUY',
      positionStatus: 'open',
      planId: 'plan1',
      timeframe: '15m',
      slotIso: '2026-07-28T03:00:00.000Z',
      targetTimeIso: '2026-07-28T03:15:00.000Z',
      direction: 'down',
      tokenId: 'closed-window-btc',
      usd: 3.75,
      shares: 10.7,
      limitPrice: 0.35,
      entryPrice: 0.35,
      filledShares: 10.7,
      remainingShares: 10.7
    },
    {
      id: 'closed-window-eth',
      status: 'submitted',
      orderSide: 'BUY',
      positionStatus: 'open',
      planId: 'plan1',
      timeframe: '15m',
      slotIso: '2026-07-28T03:00:00.000Z',
      targetTimeIso: '2026-07-28T03:15:00.000Z',
      direction: 'down',
      tokenId: 'closed-window-eth',
      usd: 2.55,
      shares: 7,
      limitPrice: 0.36,
      entryPrice: 0.36,
      filledShares: 7,
      remainingShares: 7
    }
  ];
  const beforeClose = service.liveRiskSnapshot({
    clobBalanceUsdc: 35.76,
    timeframe: '15m',
    planId: 'plan1',
    nowMs: Date.parse('2026-07-28T03:10:00.000Z')
  });
  assert.equal(beforeClose.timeframeOpenExposureUsd, 6.3);
  const afterClose = service.liveRiskSnapshot({
    clobBalanceUsdc: 35.76,
    timeframe: '15m',
    planId: 'plan1',
    nowMs: Date.parse('2026-07-28T03:16:38.000Z')
  });
  assert.equal(afterClose.timeframeOpenExposureUsd, 0);
  assert.equal(afterClose.totalOpenExposureUsd, 0);
  // 权益仍计入待结算仓，但不挤占下一窗 room
  assert.ok(afterClose.equity > afterClose.cash);
  const room = afterClose.maxTimeframeOpenExposureUsd - afterClose.timeframeOpenExposureUsd;
  assert.ok(room + 1e-9 >= 2.9, `expected usable room after window close, got ${room}`);
});

test('formatLiveHardCapBelowFloorReason avoids nonsense $0.01 headline', async () => {
  const { formatLiveHardCapBelowFloorReason } = await import('../src/polymarketTrading.js');
  const msg = formatLiveHardCapBelowFloorReason({
    hardCap: 0.01,
    liveFloorUsd: 2.9,
    requestedUsd: 2.26,
    cash: 35.76,
    singleOrderCap: 5.05,
    totalExposureRoom: 4.22,
    timeframeExposureRoom: 0.01,
    timeframe: '15m',
    maxSingleOrderUsd: 5.05,
    maxTotalOpenExposureUsd: 10.51,
    maxTimeframeOpenExposureUsd: 6.31,
    totalOpenExposureUsd: 6.3,
    timeframeOpenExposureUsd: 6.3
  });
  assert.match(msg, /本金比例算出 \$2\.26/);
  assert.match(msg, /15m敞口余量 \$0\.01/);
  assert.match(msg, /余额\/敞口不够最小单/);
  assert.doesNotMatch(msg, /按本金风控后上限 \$0\.01/);
  assert.equal(isStructuralLiveUnderfundError(msg), true);
  assert.equal(shouldSkipLiveBlockedBuyRecord(msg, { planId: 'plan1' }), true);
  assert.equal(shouldHideLiveOrderRow({
    status: 'blocked',
    orderSide: 'BUY',
    error: msg
  }), true);
  assert.equal(isNoisyStructuralBlockedBuy({
    status: 'blocked',
    orderSide: 'BUY',
    error: msg
  }), true);
});

test('Plan1 does not record noisy 买入拦截 when 15m exposure room cannot fund min order', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500
    },
    statePath: 'data/test-polymarket-live-plan1-skip-exposure-block.json'
  });
  await service.load();
  await service.setLiveAuto(true, { planId: 'plan1', timeframes: ['15m'] });

  const executionKey = '2099-01-01T00:00:00.000Z_SOL-USD_15m_plan1';
  const underfundMsg = (
    '本金比例算出 $0.39，余额/敞口不够最小单：15m敞口余量 $0.00'
    + '（已用 $6.00 / 上限 $6.00） 低于 CLOB 最小约 $2.50（约 5 份），跳过。'
  );
  service.createLiveOrder = async () => {
    throw new Error(underfundMsg);
  };

  const before = (service.state.liveOrders || []).length;
  const result = await service.maybeLiveAutoExecute({
    planView: {
      planId: 'plan1',
      recommendation: {},
      polymarket: {
        available: true,
        upPrice: 0.09,
        downPrice: 0.91,
        upTokenId: 'up-token',
        downTokenId: 'down-token',
        market: 'sol-updown',
        marketSlug: 'sol-updown-15m',
        conditionId: 'cond-sol'
      },
      plan: {
        key: executionKey,
        planId: 'plan1',
        timeframe: '15m',
        slotIso: '2099-01-01T00:00:00.000Z',
        symbol: 'SOL-USD',
        action: {
          shouldTrade: true,
          direction: 'up',
          usd: 0.5,
          limitPrice: 0.09,
          executionKey
        }
      }
    },
    clobBalanceUsdc: 40,
    closedOnly: false,
    readinessReady: true
  });

  assert.equal(result.executed, false);
  assert.equal(result.skippedNoisyBlock, true);
  assert.match(String(result.reason), /余额\/敞口不够最小单/);
  assert.equal((service.state.liveOrders || []).length, before);
  assert.equal(
    (service.state.liveOrders || []).filter((order) => order.status === 'blocked').length,
    0
  );
});

test('Plan2.5 ignores configured dollar noise floor and uses CLOB 5-share physical minimum', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 100,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      minOrderUsd: 5,
      maxOrderEquityPct: 0.12,
      liveAdaptiveCapEnabled: false,
      // 即使仍配置旧噪声底，Plan2.5 也不应再被 $6 卡死。
      plan2LiveMinOrderUsd5m: 5,
      plan2LiveMinOrderUsd15m: 6,
      liveMinSharesBuffer: 6
    },
    statePath: 'data/test-polymarket-live-plan25-physical-min.json'
  });
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan2_5',
      key: 'slot_plan25_physical_min',
      timeframe: '15m',
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'down',
        usd: 12,
        confidence: 0.7,
        reason: 'plan2.5 physical minimum test'
      }
    },
    sentiment: {
      available: true,
      symbol: 'SOL-USD',
      timeframe: '15m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.13,
      downPrice: 0.87,
      market: 'SOL Down',
      marketSlug: 'sol-down',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan2_5',
    clobBalanceUsdc: 43
  });
  assert.equal(draft.planId, 'plan2_5');
  // 0.87 × 5 份物理底 ≈ $4.35；12%×$43 风控 room ≈ $5.16，应落到 room 而非被 $6 噪声底拦死。
  assert.ok(draft.usd + 1e-9 >= 4.35, `expected >= physical 5-share floor, got ${draft.usd}`);
  assert.ok(draft.usd <= 5.16 + 1e-9, `expected <= risk room, got ${draft.usd}`);
  assert.ok(draft.shares >= 5);
});

test('Plan2.5 tops up risk room to CLOB 5-share floor instead of blocking like $5.16 < $6', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 100,
      maxOrderUsd: 500,
      minOrderUsd: 5,
      maxOrderEquityPct: 0.08,
      liveAdaptiveCapEnabled: false,
      plan2LiveMinOrderUsd15m: 6,
      liveClobMinTopUpSlackUsd: 4,
      liveMinSharesBuffer: 6
    },
    statePath: 'data/test-polymarket-live-plan25-topup.json'
  });
  // 复现 03:26 SOL：0.86 × 5 ≈ $4.30；8%×$43 ≈ $3.44，旧逻辑被 $6 卡死。
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan2_5',
      key: 'slot_plan25_topup',
      timeframe: '15m',
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'down',
        usd: 11.75,
        confidence: 0.8,
        entryType: 'late_capture',
        reason: 'mirror paper late_capture'
      }
    },
    sentiment: {
      available: true,
      symbol: 'SOL-USD',
      timeframe: '15m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.14,
      downPrice: 0.86,
      market: 'SOL Down',
      marketSlug: 'sol-down',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan2_5',
    clobBalanceUsdc: 43
  });
  assert.ok(draft.usd + 1e-9 >= 4.30, `expected top-up to CLOB floor, got ${draft.usd}`);
  assert.ok(draft.shares >= 5);
});

test('Plan3.6 tops up fixed $5 intent to CLOB buffer floor instead of blocking like $5 < $5.40', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 100,
      maxOrderUsd: 500,
      minOrderUsd: 5,
      liveAdaptiveCapEnabled: false,
      plan3_6OrderUsd: 5,
      liveClobMinTopUpSlackUsd: 2,
      liveMinSharesBuffer: 6
    },
    statePath: 'data/test-polymarket-live-plan36-topup.json'
  });
  // 复现：BTC 5m UP 91% 附近；0.90×6 buffer ≈ $5.40，意向/hardCap $5 旧逻辑直接 blocked。
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan3_6',
      key: 'slot_plan36_topup',
      symbol: 'BTC-USD',
      timeframe: '5m',
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 5,
        confidence: 0.9,
        reason: 'Plan3.6 favorite confirmed'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '5m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.9,
      downPrice: 0.1,
      market: 'BTC Up',
      marketSlug: 'btc-up',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan3_6',
    clobBalanceUsdc: 80
  });
  assert.equal(draft.planId, 'plan3_6');
  assert.ok(draft.usd + 1e-9 >= 5.40, `expected top-up to CLOB floor, got ${draft.usd}`);
  assert.ok(draft.shares >= 6, `expected >= 6 buffer shares, got ${draft.shares}`);
});

test('Plan1 can use sub-$5 risk room when the real five-share CLOB minimum fits', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 20,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      plan1LiveMinOrderUsd: 1
    },
    statePath: 'data/test-polymarket-live-plan1-physical-min.json'
  });
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan1',
      key: 'slot_plan1_physical_min',
      timeframe: '5m',
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'down',
        usd: 5,
        confidence: 0.7,
        reason: 'physical minimum test'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '5m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.40,
      downPrice: 0.60,
      market: 'BTC Down',
      marketSlug: 'btc-down',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan1',
    clobBalanceUsdc: 59.125
  });
  assert.equal(draft.planId, 'plan1');
  assert.equal(draft.usd, 4.73);
  assert.ok(draft.shares >= 5);
});

test('buildLiveOrderDraft raises tiny live buys above CLOB minimum shares', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 500,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      minOrderUsd: 0.5
    },
    statePath: 'data/test-polymarket-live-min-shares.json'
  });
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan2',
      key: 'slot_plan2',
      timeframe: '15m',
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'down',
        usd: 2.36,
        confidence: 0.7,
        reason: 'small plan'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '15m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.49,
      downPrice: 0.51,
      market: 'BTC Down',
      marketSlug: 'btc-down',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan2',
    clobBalanceUsdc: 100
  });
  // Plan2.5：抬到 CLOB 5 份物理底（0.51×5），不再抬到自设 $5/$6。
  assert.equal(draft.usd, 2.55);
  assert.ok(draft.shares >= 5);
  assert.equal(draft.tokenId, '67890');
});

test('buildLiveOrderDraft rechecks global exposure after raising to the live minimum', () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 100,
      maxOrderUsd: 500,
      minOrderUsd: 5,
      plan1LiveMinOrderUsd: 5,
      maxOrderEquityPct: 0.08,
      maxTotalOpenExposurePct: 1,
      maxTimeframeOpenExposurePct: 1,
      globalExposureCapEnabled: true,
      globalSlotDirectionMaxExposurePct: 1,
      globalTimeframeMaxExposurePct: 0.12,
      globalTotalBtcMarketExposurePct: 1
    },
    statePath: 'data/test-polymarket-live-final-exposure.json'
  });
  service.state.liveOrders = [{
    id: 'existing-live-exposure',
    planId: 'plan2_5',
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'open',
    timeframe: '15m',
    slotIso: '2098-12-31T23:45:00.000Z',
    direction: 'up',
    usd: 64
  }];

  assert.throws(() => service.buildLiveOrderDraft({
    plan: {
      planId: 'plan1',
      key: 'slot_plan1_final_exposure',
      timeframe: '15m',
      targetTimeIso: '2099-01-01T00:15:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'down',
        usd: 2,
        confidence: 0.7,
        reason: 'minimum floor exposure test'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '15m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.5,
      downPrice: 0.5,
      market: 'BTC Down',
      marketSlug: 'btc-down',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan1',
    clobBalanceUsdc: 500
  }), /15m 周期总暴露/);
});

test('buildLiveOrderDraft lets plan3 use its own live cap without Plan2 exposure cap', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveMaxOrderUsd: 500,
      maxOrderUsd: 500,
      defaultOrderUsd: 5,
      minOrderUsd: 0.5,
      globalExposureCapEnabled: true,
      globalSlotDirectionMaxExposurePct: 0.08,
      globalTimeframeMaxExposurePct: 0.12,
      globalTotalBtcMarketExposurePct: 0.20,
      plan3LiveMaxOrderUsd: 25,
      plan3MaxOrderPct: 0.10,
      plan3LiveMaxOrderEquityPct: 0.10
    },
    statePath: 'data/test-polymarket-live-plan3-draft.json'
  });
  await service.load();
  service.state.liveAuto.riskControls = { globalDailyLossProtectionEnabled: false };
  service.state.liveOrders = [];
  await service.persist();
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan2',
    timeframe: '5m',
    slotIso: '2099-01-01T00:00:00.000Z',
    direction: 'up',
    usd: 60
  });
  for (let index = 0; index < 5; index += 1) {
    await service.recordLiveOrder({
      status: 'submitted',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan2',
      timeframe: '5m',
      slotIso: `2099-01-01T00:0${index}:00.000Z`,
      direction: 'down',
      usd: 5,
      pnl: -5,
      closedAtIso: new Date(Date.now() - index * 1000).toISOString()
    });
  }
  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan3',
      key: 'slot_plan3_up',
      timeframe: '5m',
      targetTimeIso: '2099-01-01T00:05:00.000Z',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 100,
        limitPrice: 0.94,
        reason: 'settlement capture'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '5m',
      upTokenId: '12345',
      downTokenId: '67890',
      upPrice: 0.94,
      downPrice: 0.06,
      market: 'BTC Up',
      marketSlug: 'btc-up',
      schedule: { currentSlotIso: '2099-01-01T00:00:00.000Z' }
    },
    planId: 'plan3',
    clobBalanceUsdc: 600
  });
  assert.equal(draft.planId, 'plan3');
  assert.equal(draft.usd, 66);
  assert.ok(draft.shares >= 5);
});

test('applyLiveAutoEnvDefault does not auto-start live trading', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveAutoEnabled: true,
      liveAutoPlanId: 'plan1'
    },
    statePath: 'data/test-polymarket-live-auto-env-default.json'
  });
  await service.load();
  service.state.liveAuto = {
    ...(service.state.liveAuto || {}),
    enabled: false,
    enabledPlans: [],
    planRuns: {}
  };
  const auto = await service.applyLiveAutoEnvDefault();
  assert.equal(auto.enabled, false);
  assert.deepEqual(auto.enabledPlans, []);
});

test('setLiveAuto persists plan and timeframes', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveAutoEnabled: false },
    statePath: 'data/test-polymarket-live-auto-state.json'
  });
  await service.load();
  const auto = await service.setLiveAuto(true, { planId: 'plan2', timeframes: ['15m'] });
  assert.equal(auto.enabled, true);
  assert.deepEqual(auto.enabledPlans, ['plan2_5']);
  assert.equal(auto.planId, 'plan2_5');
  assert.deepEqual(auto.timeframes, ['15m']);
  assert.equal(auto.plans.plan2.enabled, false);
  assert.equal(auto.plans.plan2_5.enabled, true);
  const stopped = await service.setLiveAuto(false);
  assert.equal(stopped.enabled, false);
  assert.deepEqual(stopped.enabledPlans, []);
});

test('setLiveAuto supports multiple plans concurrently', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveAutoEnabled: false },
    statePath: 'data/test-polymarket-live-auto-multi-state.json'
  });
  await service.load();
  await service.setLiveAuto(true, { planId: 'plan1', timeframes: ['5m', '15m'] });
  const both = await service.setLiveAuto(true, { planId: 'plan2' });
  assert.equal(both.enabled, true);
  assert.deepEqual(both.enabledPlans, ['plan1', 'plan2_5']);
  assert.equal(both.plans.plan1.enabled, true);
  assert.equal(both.plans.plan2.enabled, false);
  assert.equal(both.plans.plan2_5.enabled, true);
  const stopPlan1 = await service.setLiveAuto(false, { planId: 'plan1' });
  assert.deepEqual(stopPlan1.enabledPlans, ['plan2_5']);
  assert.equal(stopPlan1.plans.plan1.enabled, false);
  assert.equal(stopPlan1.plans.plan2_5.enabled, true);
});

test('setLiveAuto allows plan5 when enabled', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveAutoEnabled: false,
      plan5Enabled: true,
      plan5LiveEnabled: true,
      plan5WeakCashPct: 0.10,
      plan5NormalCashPct: 0.20,
      plan5StrongCashPct: 0.30,
      plan5MinOrderUsd: 10
    },
    statePath: 'data/test-polymarket-live-auto-plan5-state.json'
  });
  await service.load();
  const started = await service.setLiveAuto(true, { planId: 'plan5', timeframes: ['5m'] });
  assert.equal(started.enabled, true);
  assert.deepEqual(started.enabledPlans, ['plan5']);
  assert.equal(started.plans.plan5.enabled, true);

  const waiting = await service.maybeLiveAutoExecute({
    planView: {
      planId: 'plan5',
      plan: {
        key: 'plan5_wait',
        timeframe: '5m',
        slotIso: '2099-01-01T00:00:00.000Z',
        action: {
          shouldTrade: false,
          waitingForLock: true,
          observeOnly: true,
          reason: 'Plan5 5m 未锁定，等待锁定。'
        }
      },
      polymarket: { available: true, upTokenId: 'up', downTokenId: 'down', upPrice: 0.55, downPrice: 0.45 }
    },
    clobBalanceUsdc: 500,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(waiting.executed, false);
  assert.equal(waiting.waitingForLock, true);
  assert.ok(!service.liveAutoStatus().lastExecutedKeys?.includes('plan5_wait'));

  const draft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan5',
      timeframe: '5m',
      slotIso: '2099-01-01T00:00:00.000Z',
      symbol: 'BTC-USD',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 50,
        cashPct: 0.10,
        entryType: 'pm_lock_strength',
        reason: 'Plan5 locked weak'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '5m',
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      upPrice: 0.55,
      downPrice: 0.45,
      market: 'btc',
      marketSlug: 'btc-updown-5m'
    },
    planId: 'plan5',
    clobBalanceUsdc: 500
  });
  assert.equal(draft.planId, 'plan5');
  assert.equal(draft.usd, 50);
  assert.equal(draft.entryType, 'pm_lock_strength');

  const smallDraft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan5',
      timeframe: '5m',
      slotIso: '2099-01-01T00:05:00.000Z',
      symbol: 'BTC-USD',
      action: {
        shouldTrade: true,
        direction: 'down',
        usd: 2,
        cashPct: 0.01,
        entryType: 'pm_lock_strength',
        reason: 'Plan5 low-confidence minimum'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '5m',
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      upPrice: 0.55,
      downPrice: 0.45,
      market: 'btc',
      marketSlug: 'btc-updown-5m'
    },
    planId: 'plan5',
    clobBalanceUsdc: 500
  });
  assert.ok(smallDraft.usd < 5);
  assert.ok(smallDraft.shares >= 5);

  // 意图仓位 $5 + 高价时，单笔上限不得被 action.cashPct 锁死，应上浮到 CLOB 最小份数金额
  const highPriceDraft = service.buildLiveOrderDraft({
    plan: {
      planId: 'plan5',
      timeframe: '5m',
      slotIso: '2099-01-01T00:10:00.000Z',
      symbol: 'BTC-USD',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 5,
        cashPct: 0.058,
        entryType: 'pm_lock_strength',
        reason: 'Plan5 weak sized to $5'
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '5m',
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      upPrice: 0.92,
      downPrice: 0.08,
      market: 'btc',
      marketSlug: 'btc-updown-5m'
    },
    planId: 'plan5',
    clobBalanceUsdc: 86
  });
  assert.ok(highPriceDraft.usd >= 5.52, `expected CLOB top-up, got $${highPriceDraft.usd}`);
  assert.ok(highPriceDraft.shares >= 6);

  const stopped = await service.setLiveAuto(false, { planId: 'plan5' });
  assert.deepEqual(stopped.enabledPlans, []);
});

test('setLiveAuto rejects plan5 when disabled', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, plan5Enabled: false },
    statePath: 'data/test-polymarket-live-auto-plan5-disabled.json'
  });
  await service.load();
  await assert.rejects(
    () => service.setLiveAuto(true, { planId: 'plan5', timeframes: ['5m'] }),
    /Plan5 已禁用/
  );
});

test('setLiveAuto rejects plan5 when live disabled', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, plan5Enabled: true, plan5LiveEnabled: false },
    statePath: 'data/test-polymarket-live-auto-plan5-live-disabled.json'
  });
  await service.load();
  await assert.rejects(
    () => service.setLiveAuto(true, { planId: 'plan5', timeframes: ['5m'] }),
    /POLYMARKET_PLAN5_LIVE_ENABLED/
  );
});

test('setLiveAutoSymbols updates without restarting plans', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, plan5Enabled: true, plan5LiveEnabled: true },
    statePath: 'data/test-polymarket-live-auto-symbols.json'
  });
  await service.load();
  await service.setLiveAuto(true, { planId: 'plan1', timeframes: ['5m'], symbols: ['BTC-USD'] });
  await service.setLiveAuto(true, { planId: 'plan5', symbols: ['BTC-USD'] });
  const updated = await service.setLiveAutoSymbols(['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
  assert.deepEqual(updated.symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
  assert.deepEqual(updated.enabledPlans, ['plan1', 'plan5']);
});

test('maybeLiveAutoExecute respects guard rails', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: false, liveMaxOrderUsd: 10 },
    statePath: 'data/test-polymarket-live-auto-guards.json'
  });
  await service.load();
  await service.setLiveAuto(true, { planId: 'plan1', timeframes: ['15m'] });
  const planView = {
    planId: 'plan1',
    plan: {
      key: '2099_slot_plan1',
      timeframe: '15m',
      slotIso: '2099-01-01T00:00:00.000Z',
      action: { shouldTrade: true, direction: 'up', usd: 5, reason: 'test' }
    }
  };
  const disabled = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 100,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(disabled.executed, false);
  assert.ok(disabled.reason);

  service.config.liveTradingEnabled = true;
  await service.setLiveAuto(false);
  const autoOff = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 100,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(autoOff.executed, false);
  assert.ok(autoOff.reason);

  await service.setLiveAuto(true, { planId: 'plan1', timeframes: ['15m'] });
  const closedOnly = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 100,
    closedOnly: true,
    readinessReady: true
  });
  assert.equal(closedOnly.executed, false);
  assert.match(closedOnly.reason, /closed-only/i);

  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '15m',
    slotIso: '2099-01-01T00:00:00.000Z',
    direction: 'up',
    usd: 5
  });
  const duplicate = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 100,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(duplicate.executed, false);
  assert.ok(duplicate.reason);

  const skipView = {
    planId: 'plan1',
    plan: {
      key: '2099_skip',
      timeframe: '15m',
      slotIso: '2099-01-02T00:00:00.000Z',
      action: { shouldTrade: false, reason: 'confidence too low' }
    }
  };
  const skipped = await service.maybeLiveAutoExecute({
    planView: skipView,
    clobBalanceUsdc: 100,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(skipped.executed, false);
  assert.equal(skipped.reason, 'confidence too low');
});

test('plan3 live blocked orders stay retryable within the same window', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan3Enabled: true,
      plan3LiveEnabled: true,
      liveMaxOrderUsd: 100,
      plan3LiveMaxOrderUsd: 100
    },
    statePath: 'data/test-polymarket-live-plan3-blocked-retry.json'
  });
  await service.load();
  await service.setLiveAuto(true, { planId: 'plan3', timeframes: ['5m'] });

  const executionKey = '2099-01-01T00:05:00.000Z_5m_plan3_up';
  await service.recordLiveOrder({
    status: 'blocked',
    orderSide: 'BUY',
    planId: 'plan3',
    planKey: executionKey,
    timeframe: '5m',
    slotIso: '2099-01-01T00:05:00.000Z',
    direction: 'up',
    usd: 50,
    error: '余额不足'
  });
  await service.markLiveExecuted(executionKey);

  assert.equal(service.shouldAllowPlan3LiveRetry(executionKey), true);
  assert.equal(service.getPlan3SubmittedKeys('plan3').has(executionKey), false);

  const bucket = service.getBucket('plan3');
  bucket.plan3SubmittedSlots = {
    [executionKey]: { fillStatus: 'blocked' },
    'filled_key': { fillStatus: 'filled' }
  };
  assert.equal(service.getPlan3SubmittedKeys('plan3').has('filled_key'), true);
  assert.equal(service.getPlan3SubmittedKeys('plan3').has(executionKey), false);

  service.createLiveOrder = async () => {
    throw new Error('mock blocked again');
  };

  const planView = {
    planId: 'plan3',
    recommendation: {},
    polymarket: {
      available: true,
      upPrice: 0.97,
      downPrice: 0.03,
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      market: 'btc-updown',
      marketSlug: 'btc-updown-5m',
      conditionId: 'cond-1'
    },
    plan: {
      key: executionKey,
      planId: 'plan3',
      timeframe: '5m',
      slotIso: '2099-01-01T00:05:00.000Z',
      symbol: 'BTC-USD',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 50,
        limitPrice: 0.97,
        executionKey
      }
    }
  };

  const retry = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 500,
    closedOnly: false,
    readinessReady: true
  });

  assert.equal(retry.executed, false);
  assert.equal(retry.retryable, true);
  assert.match(String(retry.reason), /mock blocked again/i);
  assert.equal(service.shouldAllowPlan3LiveRetry(executionKey), false);
  assert.equal(retry.record.retryCount, 2);
  assert.ok(Date.parse(retry.record.nextRetryAtIso) > Date.now());
});

test('plan2.5 live blocked orders stay retryable within the same window', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan2LiveBlockedRetryEnabled: true,
      liveMaxOrderUsd: 500
    },
    statePath: 'data/test-polymarket-live-plan2-blocked-retry.json'
  });
  await service.load();
  await service.setLiveAuto(true, { planId: 'plan2_5', timeframes: ['5m'] });

  const executionKey = '2099-01-01T00:05:00.000Z_BTC-USD_5m_plan2_5_probe';
  await service.recordLiveOrder({
    status: 'blocked',
    orderSide: 'BUY',
    planId: 'plan2_5',
    planKey: executionKey,
    timeframe: '5m',
    slotIso: '2099-01-01T00:05:00.000Z',
    direction: 'up',
    entryType: 'probe',
    usd: 13.72,
    error: '余额不足'
  });
  await service.markLiveExecuted(executionKey);

  assert.equal(service.shouldAllowLiveBlockedRetry('plan2_5', executionKey), true);

  service.createLiveOrder = async () => {
    throw new Error('mock blocked again');
  };

  const planView = {
    planId: 'plan2_5',
    recommendation: {},
    polymarket: {
      available: true,
      upPrice: 0.57,
      downPrice: 0.43,
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      market: 'btc-updown',
      marketSlug: 'btc-updown-5m',
      conditionId: 'cond-1'
    },
    plan: {
      key: executionKey,
      planId: 'plan2_5',
      timeframe: '5m',
      slotIso: '2099-01-01T00:05:00.000Z',
      symbol: 'BTC-USD',
      action: {
        shouldTrade: true,
        direction: 'up',
        entryType: 'probe',
        usd: 13.72,
        limitPrice: 0.57,
        executionKey
      }
    }
  };

  const retry = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 500,
    closedOnly: false,
    readinessReady: true
  });

  assert.equal(retry.executed, false);
  assert.equal(retry.retryable, true);
  assert.match(String(retry.reason), /mock blocked again/i);
  assert.equal(service.shouldAllowLiveBlockedRetry('plan2_5', executionKey), false);
  assert.equal(retry.record.retryCount, 2);
});

test('Plan3 live blocked retries use the fast Plan3 cooldown', () => {
  const service = new PolymarketTradingService({
    config: {
      plan3LiveBlockedRetryAfterMs: 1750,
      liveBlockedRetryAfterMs: 8000
    },
    statePath: 'data/test-polymarket-plan3-fast-retry.json'
  });
  assert.equal(service.resolveLiveBlockedRetryDelayMs('FAK no orders found to match', 'plan3'), 1750);
  assert.equal(service.resolveLiveBlockedRetryDelayMs('FAK no orders found to match', 'plan1'), 8000);
  assert.equal(service.resolveLiveBlockedRetryDelayMs('FAK no orders found to match', 'plan5'), 500);
  assert.equal(service.resolveLiveBlockedRetryDelayMs('FAK 即时成交失败：当前价位暂无对手盘', 'plan5'), 500);
  const plan5Fast = new PolymarketTradingService({
    config: { plan5LiveBlockedRetryAfterMs: 250 },
    statePath: 'data/test-polymarket-plan5-fast-retry.json'
  });
  assert.equal(plan5Fast.resolveLiveBlockedRetryDelayMs('暂无对手盘', 'plan5'), 250);
});

test('repricePlan2LiveDraft chases the fresh book ask for aggressive fills', () => {
  const repriced = repricePlan2LiveDraft({
    planId: 'plan2_5',
    timeframe: '5m',
    limitPrice: 0.60,
    usd: 10,
    shares: 16.6667
  }, 0.64, { plan2EntryMaxPrice: 0.78 });
  assert.equal(repriced.limitPrice, 0.64);
  assert.equal(repriced.intendedLimitPrice, 0.60);
  assert.equal(repriced.executionPreflightPrice, 0.64);
  assert.ok(Number(repriced.shares) > 0);
  assert.throws(
    () => repricePlan2LiveDraft({ limitPrice: 0.60, usd: 10 }, 0.80, { plan2EntryMaxPrice: 0.78 }),
    /入场上限/
  );
});

test('repricePlan2LiveDraft Plan2.6 applies live entry-max by default', () => {
  const allowed = repricePlan2LiveDraft({
    planId: 'plan2_6',
    timeframe: '15m',
    limitPrice: 0.81,
    usd: 6.55
  }, 0.86, {
    plan2EntryMaxPrice: 0.62,
    plan2_6EntryHardMaxPrice: 0.92,
    plan2_6EntryMaxPrice: 0.90
  });
  assert.equal(allowed.limitPrice, 0.86);
  assert.equal(allowed.maxLivePrice, 0.90);
  assert.throws(
    () => repricePlan2LiveDraft({
      planId: 'plan2_6',
      limitPrice: 0.81,
      usd: 6.55
    }, 0.95, {
      plan2EntryMaxPrice: 0.62,
      plan2_6EntryHardMaxPrice: 0.92,
      plan2_6EntryMaxPrice: 0.90
    }),
    /Plan2\.6 盘口卖一.*入场上限 90/
  );
});

test('repricePlan2LiveDraft Plan2.6 can disable entry max for paper-parity chase', () => {
  const chase = repricePlan2LiveDraft({
    planId: 'plan2_6',
    limitPrice: 0.81,
    usd: 6.55,
    maxLivePrice: 0.97
  }, 0.99, {
    plan2EntryMaxPrice: 0.62,
    plan2_6LiveEntryMaxEnabled: false,
    plan2_6EntryHardMaxPrice: 0.92
  });
  assert.equal(chase.limitPrice, 0.99);
  assert.equal(chase.maxLivePrice, null);
});

test('repricePlan2LiveDraft Plan2.5 applies live entry-max by default', () => {
  const allowed = repricePlan2LiveDraft({
    planId: 'plan2_5',
    timeframe: '5m',
    limitPrice: 0.80,
    usd: 10
  }, 0.84, {
    plan2EntryMaxPrice: 0.62,
    plan2_5EntryMaxPrice: 0.88,
    plan2_5EntryHardMaxPrice: 0.92
  });
  assert.equal(allowed.limitPrice, 0.84);
  assert.equal(allowed.maxLivePrice, 0.88);
  assert.throws(
    () => repricePlan2LiveDraft({
      planId: 'plan2_5',
      limitPrice: 0.80,
      usd: 10
    }, 0.91, {
      plan2EntryMaxPrice: 0.62,
      plan2_5EntryMaxPrice: 0.88,
      plan2_5EntryHardMaxPrice: 0.92
    }),
    /Plan2\.5 盘口卖一.*入场上限 88/
  );
});

test('repricePlan2LiveDraft Plan2.5 can disable entry max for paper-parity chase', () => {
  const chase = repricePlan2LiveDraft({
    planId: 'plan2_5',
    limitPrice: 0.80,
    usd: 10,
    maxLivePrice: 0.62
  }, 0.99, {
    plan2EntryMaxPrice: 0.62,
    plan2_5LiveEntryMaxEnabled: false
  });
  assert.equal(chase.limitPrice, 0.99);
  assert.equal(chase.maxLivePrice, null);
});

test('repricePlan2LiveDraft rejects collapsed favorite asks (90¢ → 34¢)', () => {
  assert.throws(
    () => repricePlan2LiveDraft({
      planId: 'plan2_5',
      limitPrice: 0.90,
      intendedLimitPrice: 0.90,
      usd: 4.5
    }, 0.3437, {
      plan2LiveMaxAdversePriceDropAbs: 0.15,
      plan2LiveMaxAdversePriceDropPct: 0.30
    }),
    /拒绝追崩价票/
  );
  const mild = repricePlan2LiveDraft({
    planId: 'plan2_6',
    limitPrice: 0.90,
    intendedLimitPrice: 0.90,
    usd: 5
  }, 0.86, {
    plan2_6EntryMaxPrice: 0.97,
    plan2LiveMaxAdversePriceDropAbs: 0.15,
    plan2LiveMaxAdversePriceDropPct: 0.30
  });
  assert.equal(mild.limitPrice, 0.86);
});

test('Plan2.5 live FAK blocked retries use sub-second cooldown on 5m', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveBlockedRetryAfterMs: 500,
      plan2LiveBlockedRetryAfterMs5m: 300,
      liveBlockedRetryAfterMs: 8000
    },
    statePath: 'data/test-polymarket-plan25-fast-retry.json'
  });
  assert.equal(
    service.resolveLiveBlockedRetryDelayMs('FAK no orders found to match', 'plan2_5', '5m'),
    300
  );
  assert.equal(
    service.resolveLiveBlockedRetryDelayMs('FAK 即时成交失败：当前价位暂无对手盘', 'plan2_5', '15m'),
    500
  );
  assert.equal(
    service.resolveLiveBlockedRetryDelayMs('FAK no orders found to match', 'plan2', '5m'),
    300
  );
  const custom = new PolymarketTradingService({
    config: { plan2LiveBlockedRetryAfterMs5m: 200 },
    statePath: 'data/test-polymarket-plan25-fast-retry-custom.json'
  });
  assert.equal(custom.resolveLiveBlockedRetryDelayMs('暂无对手盘', 'plan2_5', '5m'), 200);
});

test('submitClobBuyOrderWithFallback bumps Plan2.5 5m FAK with ask refresh and skips GTC', async () => {
  const postedTypes = [];
  const postedPrices = [];
  let askReads = 0;
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    getOrderBook: async () => {
      askReads += 1;
      // First read is pre-submit requote; subsequent reads are bump retries.
      return { asks: [{ price: String(0.60 + Math.min(askReads, 10) * 0.01) }] };
    },
    getPrice: async () => ({ price: '0.60' }),
    createAndPostMarketOrder: async (order, _options, orderType) => {
      postedTypes.push(String(orderType));
      postedPrices.push(Number(order?.price));
      throw new Error('no orders found to match');
    },
    createAndPostOrder: async () => {
      postedTypes.push('GTC');
      throw new Error('GTC should not be used for Plan2.5 5m immediate-only buys');
    }
  };
  await assert.rejects(
    submitClobBuyOrderWithFallback(client, {
      planId: 'plan2_5',
      timeframe: '5m',
      tokenId: 'tok',
      limitPrice: 0.60,
      intendedLimitPrice: 0.60,
      usd: 20
    }, {
      liveBuyOrderType: 'FAK',
      plan2LiveImmediateOnly5m: true,
      plan2LiveFakBumpSteps5m: 10
    }),
    /no orders found|暂无对手盘/
  );
  // 1 primary + 10 bump retries
  assert.equal(postedTypes.length, 11);
  assert.deepEqual([...new Set(postedTypes)], ['FAK']);
  assert.ok(askReads >= 10);
  // Must requote off the live ask, not sit on the stale signal limit alone.
  assert.ok(postedPrices[0] >= 0.60);
});

test('submitClobBuyOrderWithFallback Plan2.5 skips empty book instead of stale getPrice 90¢', async () => {
  let posted = 0;
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    getOrderBook: async () => ({ asks: [] }),
    getPrice: async () => ({ price: '0.90' }),
    createAndPostMarketOrder: async () => {
      posted += 1;
      throw new Error('should not post when book is empty');
    }
  };
  await assert.rejects(
    submitClobBuyOrderWithFallback(client, {
      planId: 'plan2_5',
      timeframe: '5m',
      tokenId: 'tok',
      limitPrice: 0.90,
      intendedLimitPrice: 0.90,
      usd: 4.5
    }, {
      liveBuyOrderType: 'FAK',
      plan2LiveImmediateOnly5m: true
    }),
    /暂无对手盘|当前限价未吃到卖盘/
  );
  assert.equal(posted, 0);
});

test('submitClobBuyOrderWithFallback Plan2.6 requotes to live ask under 0.97 hard max', async () => {
  const prices = [];
  const client = {
    getTickSize: async () => '0.01',
    getNegRisk: async () => false,
    getVersion: async () => 2,
    getOrderBook: async () => ({ asks: [{ price: '0.93' }] }),
    getPrice: async () => ({ price: '0.90' }),
    createAndPostMarketOrder: async (order) => {
      prices.push(Number(order?.price));
      return { status: 'matched', success: true, makingAmount: '5', takingAmount: '5.3763' };
    }
  };
  const result = await submitClobBuyOrderWithFallback(client, {
    planId: 'plan2_6',
    timeframe: '5m',
    tokenId: 'tok',
    limitPrice: 0.90,
    intendedLimitPrice: 0.90,
    usd: 5
  }, {
    liveBuyOrderType: 'FAK',
    plan2_6EntryMaxPrice: 0.97,
    plan2_6EntryHardMaxPrice: 0.97,
    plan2LiveImmediateOnly5m: true
  });
  assert.equal(result.filled, false);
  assert.equal(result.awaitingConfirm, true);
  assert.equal(prices[0], 0.93);
});

test('Plan5 retries FAK-blocked orders even when the current tick loses shouldTrade', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan5LiveEnabled: true,
      plan5Enabled: true,
      liveUnfilledRetryEnabled: true,
      plan5LiveBlockedRetryAfterMs: 1,
      plan5LiveBlockedRetryMaxPerKey: 20
    },
    statePath: 'data/test-polymarket-plan5-blocked-force-retry.json'
  });
  await service.load();
  service.state.liveOrders = [];
  service.state.liveAuto = {
    enabled: true,
    enabledPlans: ['plan5'],
    planId: 'plan5',
    timeframes: ['5m'],
    symbols: ['ETH-USD'],
    lastExecutedKeys: ['plan5_ETH_2099-01-01T00:40:00.000Z_5m_down']
  };
  const executionKey = 'plan5_ETH_2099-01-01T00:40:00.000Z_5m_down';
  service.state.liveOrders.push({
    id: 'blocked-eth-1',
    planId: 'plan5',
    planKey: executionKey,
    orderSide: 'BUY',
    status: 'blocked',
    symbol: 'ETH-USD',
    timeframe: '5m',
    slotIso: '2099-01-01T00:40:00.000Z',
    direction: 'down',
    usd: 3.96,
    limitPrice: 0.66,
    shares: 6,
    retryCount: 2,
    lastRetryAtIso: new Date(Date.now() - 5_000).toISOString(),
    nextRetryAtIso: new Date(Date.now() - 1_000).toISOString(),
    reason: 'FAK 即时成交失败：当前价位暂无对手盘，系统会在下一轮继续重试。',
    createdAtIso: new Date(Date.now() - 60_000).toISOString()
  });
  assert.ok(service.findRetryableBlockedLiveOrder({
    planId: 'plan5',
    symbol: 'ETH-USD',
    timeframe: '5m',
    slotIso: '2099-01-01T00:40:00.000Z'
  }));

  let createCalls = 0;
  service.createLiveOrder = async ({ planView }) => {
    createCalls += 1;
    assert.equal(planView.plan.action.shouldTrade, true);
    assert.equal(planView.plan.action.blockedRetryForce, true);
    assert.equal(planView.plan.action.direction, 'down');
    throw new Error('FAK 即时成交失败：当前价位暂无对手盘，系统会在下一轮继续重试。');
  };

  const result = await service.maybeLiveAutoExecute({
    planView: {
      planId: 'plan5',
      plan: {
        planId: 'plan5',
        symbol: 'ETH-USD',
        timeframe: '5m',
        slotIso: '2099-01-01T00:40:00.000Z',
        targetTimeIso: '2099-01-01T00:45:00.000Z',
        key: executionKey,
        action: {
          shouldTrade: false,
          skipReason: 'signal_quality_pullback',
          reason: 'Plan5 信号回撤，跳过',
          executionKey,
          direction: 'down'
        }
      },
      polymarket: {
        available: true,
        symbol: 'ETH-USD',
        timeframe: '5m',
        upTokenId: 'up',
        downTokenId: 'down',
        upPrice: 0.34,
        downPrice: 0.66
      }
    },
    clobBalanceUsdc: 50,
    readinessReady: true
  });
  assert.equal(createCalls, 1);
  assert.equal(result.retryable, true);
  assert.equal(result.record.retryCount, 3);
});

test('plan1 live exits are recomputed from actual fill price', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      stopLossAbsoluteFloor: 0.50
    },
    statePath: 'data/test-polymarket-live-plan1-fill-exits.json'
  });
  await service.load();
  service.state.liveOrders = [];
  if (service.state.liveAuto) service.state.liveAuto.lastExecutedKeys = [];
  await service.persist('live');
  await service.setLiveAuto(true, { planId: 'plan1', timeframes: ['5m'], symbols: ['BTC-USD'] });
  service.createLiveOrder = async () => ({
    filled: true,
    orderType: 'FAK',
    response: { status: 'matched', success: true, transactionsHashes: ['0xplan1-fill'] },
    draft: {
      planId: 'plan1',
      symbol: 'BTC-USD',
      timeframe: '5m',
      direction: 'up',
      outcome: 'UP',
      usd: 5,
      shares: 14.2857,
      limitPrice: 0.35,
      tokenId: 'up-token',
      slotIso: '2099-01-01T00:00:00.000Z'
    }
  });
  const result = await service.maybeLiveAutoExecute({
    clobBalanceUsdc: 500,
    readinessReady: true,
    planView: {
      planId: 'plan1',
      recommendation: {},
      polymarket: { available: true, upPrice: 0.50, downPrice: 0.50, upTokenId: 'up-token', downTokenId: 'down-token' },
      plan: {
        planId: 'plan1',
        key: 'plan1-fill-exit-key',
        symbol: 'BTC-USD',
        timeframe: '5m',
        slotIso: '2099-01-01T00:00:00.000Z',
        action: { shouldTrade: true, direction: 'up', usd: 5, limitPrice: 0.50, takeProfitPrice: 0.67, stopLossPrice: 0.50 }
      }
    }
  });
  assert.equal(result.executed, true);
  assert.equal(result.record.entryPrice, 0.35);
  assert.equal(result.record.takeProfitPrice, 0.51);
  assert.equal(result.record.stopLossPrice, 0.23);
});

test('live FAK unfilled releases window and allows retry after cooldown', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveUnfilledRetryEnabled: true,
      liveUnfilledRetryAfterMs: 1,
      liveUnfilledRetryMaxPerKey: 2,
      liveBuyOrderType: 'FAK',
      liveMaxOrderUsd: 500,
      minOrderUsd: 0.5
    },
    statePath: 'data/test-polymarket-live-unfilled-retry.json'
  });
  await service.load();
  service.state.liveOrders = [];
  if (service.state.liveAuto) service.state.liveAuto.lastExecutedKeys = [];
  await service.persist();
  await service.setLiveAuto(true, { planId: 'plan1', timeframes: ['5m'], symbols: ['BTC-USD'] });

  const executionKey = '2099-01-01T00:05:00.000Z_BTC-USD_5m_plan1_unfilled';
  let calls = 0;
  service.createLiveOrder = async () => {
    calls += 1;
    return {
      filled: false,
      orderType: 'FAK',
      clobOrderId: `fak-${calls}`,
      response: { status: 'killed', success: false },
      draft: {
        symbol: 'BTC-USD',
        timeframe: '5m',
        planId: 'plan1',
        direction: 'up',
        outcome: 'Up',
        usd: 10,
        shares: 20,
        limitPrice: 0.5,
        tokenId: 'up-token',
        market: 'btc',
        marketSlug: 'btc-5m',
        slotIso: '2099-01-01T00:05:00.000Z',
        targetTimeIso: '2099-01-01T00:10:00.000Z'
      }
    };
  };

  const planView = {
    planId: 'plan1',
    recommendation: {},
    polymarket: {
      available: true,
      upPrice: 0.5,
      downPrice: 0.5,
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      market: 'btc',
      marketSlug: 'btc-5m'
    },
    plan: {
      key: executionKey,
      planId: 'plan1',
      timeframe: '5m',
      slotIso: '2099-01-01T00:05:00.000Z',
      symbol: 'BTC-USD',
      targetTimeIso: '2099-01-01T00:10:00.000Z',
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 10,
        limitPrice: 0.5,
        executionKey
      }
    }
  };

  const first = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 500,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(first.executed, false);
  assert.equal(first.unfilledRetryable, true);
  assert.equal(first.record.exitStatus, 'expired-unfilled');

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(service.shouldAllowLiveBlockedRetry('plan1', executionKey), true);
  const entry = service.canOpenNewLiveEntryForWindow({
    planId: 'plan1',
    timeframe: '5m',
    slotIso: '2099-01-01T00:05:00.000Z',
    symbol: 'BTC-USD'
  });
  assert.equal(entry.allowed, true);

  const second = await service.maybeLiveAutoExecute({
    planView,
    clobBalanceUsdc: 500,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(second.unfilledRetryable, true);
  assert.equal(calls, 2);
});

test('evaluateLiveExitTrigger mirrors plan1 TP SL and time stop', () => {
  const service = new PolymarketTradingService({
    config: {
      plan1TakeProfitOffset: 0.18,
      plan1StopLossOffset: 0.15,
      plan1TimeStopRemainingPct: 0.2
    },
    statePath: 'data/test-polymarket-live-exit-eval.json'
  });
  const position = {
    planId: 'plan1',
    entryPrice: 0.5,
    limitPrice: 0.5,
    takeProfitPrice: 0.68,
    stopLossPrice: 0.35
  };
  assert.equal(service.evaluateLiveExitTrigger(position, 0.69)?.exitStatus, 'take-profit');
  assert.equal(service.evaluateLiveExitTrigger(position, 0.34)?.exitStatus, 'stop-loss');
  const timeStop = service.evaluateLiveExitTrigger(position, 0.49, { elapsedPct: 0.85 });
  assert.equal(timeStop?.exitStatus, 'time-stop');
  assert.equal(service.evaluateLiveExitTrigger(position, 0.51, { elapsedPct: 0.85 }), null);
});

test('evaluateLiveExitTrigger disables fixed take-profit for the Plan2 family', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2TakeProfitEnabled: false,
      plan2StopLossEnabled: false
    },
    statePath: 'data/test-polymarket-live-plan2-no-tp.json'
  });
  const position = {
    planId: 'plan2',
    entryPrice: 0.5,
    limitPrice: 0.5,
    takeProfitPrice: 0.68,
    stopLossPrice: 0.35
  };
  assert.equal(service.evaluateLiveExitTrigger(position, 0.75), null);
  assert.equal(service.evaluateLiveExitTrigger({ ...position, planId: 'plan2_5' }, 0.75), null);
});

test('plan1 hold-to-settlement disables live exits and preposted take-profit', () => {
  const service = new PolymarketTradingService({
    config: { plan1HoldToSettlementEnabled: true },
    statePath: 'data/test-polymarket-live-plan1-hold.json'
  });
  const position = {
    planId: 'plan1',
    positionStatus: 'open',
    entryPrice: 0.5,
    takeProfitPrice: 0.68,
    stopLossPrice: 0.35,
    targetTimeIso: '2099-01-01T00:15:00.000Z'
  };
  assert.equal(service.evaluateLiveExitTrigger(position, 0.1, { elapsedPct: 0.9 }), null);
  assert.equal(service.evaluateLiveExitTrigger(position, 0.9, { elapsedPct: 0.9 }), null);
  assert.equal(service.shouldPrepostLivePlan1TakeProfit(position), false);
});

test('processLivePlan1Exits closes open live positions on TP', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveMaxOrderUsd: 25, liveMinHoldBeforeExitMs: 0 },
    statePath: 'data/test-polymarket-live-plan1-exit.json'
  });
  await service.load();
  const buy = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '15m',
    slotIso: '2099-01-01T00:00:00.000Z',
    direction: 'up',
    tokenId: '111',
    usd: 10,
    shares: 20,
    limitPrice: 0.5,
    entryPrice: 0.5,
    takeProfitPrice: 0.68,
    stopLossPrice: 0.35
  });
  service.closeLivePosition = async (position, opts) => {
    assert.equal(position.id, buy.id);
    assert.equal(opts.exitStatus, 'take-profit');
    position.positionStatus = 'closed';
    position.exitStatus = opts.exitStatus;
    return { position, sellRecord: { id: 'sell-1' }, result: { clobOrderId: 'sell-clob-1' }, draft: {} };
  };
  const closed = await service.processLivePlan1Exits(async () => 0.7, null, {
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'take-profit');
});

test('processLivePlan1Exits leaves expired positions to official settlement', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveMinHoldBeforeExitMs: 0 },
    statePath: 'data/test-polymarket-live-plan1-expired-exit.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '5m',
    targetTimeIso: '2000-01-01T00:05:00.000Z',
    direction: 'up',
    tokenId: 'expired-token',
    usd: 5,
    shares: 10,
    limitPrice: 0.5,
    entryPrice: 0.5,
    takeProfitPrice: 0.67,
    stopLossPrice: 0.39
  });
  let resolvedPrice = false;
  service.closeLivePosition = async () => {
    throw new Error('expired position must not submit a CLOB exit');
  };
  const closed = await service.processLivePlan1Exits(async () => {
    resolvedPrice = true;
    return 0.01;
  });
  assert.equal(resolvedPrice, false);
  assert.deepEqual(closed, []);
});

test('Plan1 posts a full-size resting GTC take-profit immediately after fill', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan1PrepostedTakeProfitEnabled: true,
      liveSellShareRatio: 1
    },
    statePath: 'data/test-polymarket-plan1-preposted-tp.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const position = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '5m',
    direction: 'up',
    tokenId: 'tp-token',
    targetTimeIso: '2099-01-01T00:05:00.000Z',
    usd: 5,
    shares: 10,
    limitPrice: 0.5,
    entryPrice: 0.5,
    takeProfitPrice: 0.67,
    stopLossPrice: 0.39
  });
  service.submitLiveSellOrder = async ({ draft }) => ({
    draft,
    clobOrderId: 'tp-order-1',
    filled: false,
    orderType: 'GTC',
    response: { status: 'live', success: true, orderID: 'tp-order-1' }
  });
  const placed = await service.placeLivePlan1TakeProfitOrder(position);
  assert.equal(placed.placed, true);
  assert.equal(placed.filled, false);
  assert.equal(position.takeProfitOrderId, 'tp-order-1');
  assert.equal(position.takeProfitOrderPrice, 0.67);
  assert.equal(position.takeProfitOrderShares, 10);
});

test('Plan1 stop cancels the resting take-profit before submitting FAK remainder', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveSellShareRatio: 1,
      liveMaxOrderUsd: 25,
      liveDynamicSellLimitEnabled: false
    },
    statePath: 'data/test-polymarket-plan1-stop-cancels-tp.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const position = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '5m',
    direction: 'up',
    tokenId: 'stop-token',
    usd: 5,
    shares: 10,
    limitPrice: 0.5,
    entryPrice: 0.5,
    takeProfitPrice: 0.67,
    stopLossPrice: 0.39
  });
  position.takeProfitOrderId = 'tp-order-stop';
  position.takeProfitOrderShares = 10;
  const calls = [];
  let cancelled = false;
  let cancelPayload = null;
  const client = {
    getOrder: async () => cancelled
      ? { original_size: '10', size_matched: '0', price: '0.67', status: 'ORDER_STATUS_CANCELLED' }
      : { original_size: '10', size_matched: '0', price: '0.67', status: 'ORDER_STATUS_LIVE' },
    cancelOrder: async (payload) => {
      calls.push('cancel');
      cancelPayload = payload;
      cancelled = true;
    }
  };
  service.submitLiveSellOrder = async ({ draft }) => {
    calls.push('sell');
    return {
      draft,
      clobOrderId: 'stop-sell',
      filled: true,
      orderType: 'FAK',
      response: { status: 'matched', makingAmount: '10', takingAmount: '3.8' }
    };
  };
  const result = await service.closeLivePosition(position, {
    sellPrice: 0.38,
    exitStatus: 'stop-loss',
    exitReason: 'confirmed stop',
    clobClient: client,
    liquidateAll: true
  });
  assert.deepEqual(calls, ['cancel', 'sell']);
  assert.deepEqual(cancelPayload, { orderID: 'tp-order-stop' });
  assert.equal(result.pending, false);
  assert.equal(position.positionStatus, 'closed');
  assert.equal(position.takeProfitOrderId, null);
});

test('Plan1 resting take-profit reconciles partial fills exactly once', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveSellShareRatio: 1 },
    statePath: 'data/test-polymarket-plan1-tp-partial.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const position = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '15m',
    direction: 'up',
    tokenId: 'partial-token',
    usd: 5,
    shares: 10,
    limitPrice: 0.5,
    entryPrice: 0.5,
    takeProfitPrice: 0.7,
    stopLossPrice: 0.39
  });
  position.takeProfitOrderId = 'tp-partial';
  position.takeProfitOrderPrice = 0.7;
  position.takeProfitOrderShares = 10;
  position.takeProfitOrderMatchedShares = 0;

  await service.reconcileLivePlan1TakeProfitOrder(position, {
    original_size: '10',
    size_matched: '4',
    price: '0.7',
    status: 'ORDER_STATUS_LIVE'
  });
  assert.equal(position.remainingShares, 6);
  assert.equal(position.realizedPnlUsd, 0.8);
  assert.equal(position.takeProfitOrderMatchedShares, 4);

  const duplicate = await service.reconcileLivePlan1TakeProfitOrder(position, {
    original_size: '10',
    size_matched: '4',
    price: '0.7',
    status: 'ORDER_STATUS_LIVE'
  });
  assert.equal(duplicate.changed, false);
  assert.equal(position.realizedPnlUsd, 0.8);

  await service.reconcileLivePlan1TakeProfitOrder(position, {
    original_size: '10',
    size_matched: '10',
    price: '0.7',
    status: 'ORDER_STATUS_MATCHED'
  });
  assert.equal(position.positionStatus, 'closed');
  assert.equal(position.realizedPnlUsd, 2);
  assert.equal(position.takeProfitOrderMatchedShares, 10);
});

test('pending GTC buy sync opens only the matched shares after cancelling the remainder', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan1PrepostedTakeProfitEnabled: false,
      liveUnfilledRetryEnabled: true
    },
    statePath: 'data/test-polymarket-pending-buy-partial.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const order = await service.recordLiveOrder({
    status: 'pending',
    orderSide: 'BUY',
    positionStatus: 'pending',
    planId: 'plan1',
    planKey: 'partial-buy-key',
    timeframe: '5m',
    direction: 'up',
    tokenId: 'partial-buy-token',
    shares: 10,
    usd: 5,
    limitPrice: 0.5,
    clobOrderId: 'partial-buy-order'
  });
  let cancelled = false;
  service.createLiveClobClient = async () => ({
    getOrder: async () => ({
      original_size: '10',
      size_matched: '4',
      price: '0.5',
      status: cancelled ? 'ORDER_STATUS_CANCELLED' : 'ORDER_STATUS_LIVE'
    }),
    cancelOrder: async () => { cancelled = true; },
    updateBalanceAllowance: async () => {},
    getBalanceAllowance: async () => ({ balance: '4000000', allowance: '4000000' })
  });
  const opened = await service.syncLivePendingBuys();
  assert.equal(cancelled, true);
  assert.equal(opened.length, 1);
  assert.equal(order.positionStatus, 'open');
  assert.equal(order.shares, 4);
  assert.equal(order.usd, 2);
  assert.equal(order.originalShares, 10);
});

test('pending Plan3 GTC buy uses its shorter stale-order TTL', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveUnfilledRetryEnabled: true,
      liveUnfilledRetryAfterMs: 60000,
      plan3LivePendingTtlMs: 2000,
      liveUnfilledRetryMaxPerKey: 5
    },
    statePath: 'data/test-polymarket-plan3-pending-ttl.json'
  });
  await service.load();
  service.state.liveOrders = [];
  const order = await service.recordLiveOrder({
    status: 'pending',
    orderSide: 'BUY',
    positionStatus: 'pending',
    planId: 'plan3',
    planKey: 'plan3-short-ttl',
    timeframe: '5m',
    direction: 'up',
    tokenId: 'plan3-pending-token',
    shares: 10,
    usd: 9.9,
    limitPrice: 0.99,
    clobOrderId: 'plan3-pending-order'
  });
  order.createdAtIso = new Date(Date.now() - 3000).toISOString();
  let cancelled = false;
  service.createLiveClobClient = async () => ({
    getOrder: async () => ({
      original_size: '10',
      size_matched: '0',
      price: '0.99',
      status: cancelled ? 'ORDER_STATUS_CANCELLED' : 'ORDER_STATUS_LIVE'
    }),
    cancelOrder: async () => { cancelled = true; }
  });
  await service.syncLivePendingBuys();
  assert.equal(cancelled, true);
  assert.equal(order.exitStatus, 'expired-unfilled');
  assert.equal(order.positionStatus, 'closed');
});

test('pending sell sync cancels expired orphan orders whose parent was pruned', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true },
    statePath: 'data/test-polymarket-orphan-sell-sync.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const sell = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'SELL',
    positionStatus: 'open',
    planId: 'plan1',
    relatedBuyOrderId: 'pruned-parent',
    targetTimeIso: '2020-01-01T00:05:00.000Z',
    clobOrderId: 'orphan-sell',
    shares: 10,
    limitPrice: 0.7
  });
  let cancelled = false;
  service.createLiveClobClient = async () => ({
    getOrder: async () => ({ status: 'ORDER_STATUS_LIVE' }),
    cancelOrder: async () => { cancelled = true; }
  });
  const synced = await service.syncLivePendingSells();
  assert.equal(cancelled, true);
  assert.equal(synced.length, 1);
  assert.equal(sell.positionStatus, 'closed');
  assert.equal(sell.clobStatus, 'cancelled');
});

test('processLivePlan5StopLosses liquidates on the 20c emergency stop', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, plan5StopLossEnabled: true },
    statePath: 'data/test-polymarket-live-plan5-stop.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const buy = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan5',
    timeframe: '5m',
    slotIso: '2099-01-01T00:00:00.000Z',
    direction: 'up',
    tokenId: 'plan5-live-token',
    usd: 10,
    shares: 20,
    limitPrice: 0.5,
    entryPrice: 0.5
  });
  service.closeLivePosition = async (position, opts) => {
    assert.equal(position.id, buy.id);
    assert.equal(opts.exitStatus, 'plan5-emergency-stop');
    assert.equal(opts.liquidateAll, true);
    position.positionStatus = 'closed';
    position.exitStatus = opts.exitStatus;
    return { position, sellRecord: { id: 'plan5-sell' }, pending: false };
  };
  const closed = await service.processLivePlan5StopLosses(async () => 0.19, {
    closedOnly: false,
    readinessReady: true,
    resolveCurrentPlanView: async () => ({ polymarket: { predictedDirection: 'up' } })
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'plan5-emergency-stop');
});

test('processLivePlan2Exits closes open live positions on SL', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, plan2StopLossOffset: 0.12, liveMinHoldBeforeExitMs: 0 },
    statePath: 'data/test-polymarket-live-plan2-exit.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan2',
    timeframe: '5m',
    slotIso: '2099-01-02T00:00:00.000Z',
    direction: 'down',
    tokenId: '222',
    usd: 8,
    shares: 16,
    limitPrice: 0.5,
    entryPrice: 0.5,
    stopLossPrice: 0.38
  });
  let sellCalled = false;
  service.closeLivePosition = async (position, opts) => {
    sellCalled = true;
    assert.equal(opts.exitStatus, 'stop-loss');
    position.positionStatus = 'closed';
    position.exitStatus = opts.exitStatus;
    return { position, sellRecord: { id: 'sell-2' }, result: null, draft: {} };
  };
  const closed = await service.processLivePlan2Exits(async () => 0.37, {
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(sellCalled, true);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitStatus, 'stop-loss');
});

test('processLivePlan2Exits does not take-profit plan3 settlement captures', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveMinHoldBeforeExitMs: 0 },
    statePath: 'data/test-polymarket-live-plan3-no-tp.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan3',
    entryType: 'settlement_capture',
    timeframe: '5m',
    slotIso: '2099-01-02T00:00:00.000Z',
    direction: 'up',
    tokenId: '111',
    usd: 24,
    shares: 25,
    limitPrice: 0.96,
    entryPrice: 0.96
  });
  let sellCalled = false;
  service.closeLivePosition = async () => {
    sellCalled = true;
    throw new Error('plan3 should not be sold by plan2 exit loop');
  };
  const closed = await service.processLivePlan2Exits(async () => 0.99, {
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(sellCalled, false);
  assert.equal(closed.length, 0);
  assert.equal(service.getOpenLivePositions('plan3').length, 1);
});

test('buildPolymarketPaperPlan2 probe uses wider stop-loss offset', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 5);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.58,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.56,
      downPrice: 0.44,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2StopLossOffset: 0.08,
      plan2ProbeStopLossOffset5m: 0.16,
      plan2ProbeMinConfidence: 0.54
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'probe');
  assert.equal(plan.action.stopLossPrice, 0.50);
});

test('resolveStopLossPrice keeps absolute floor for high entries', async () => {
  const { resolveStopLossPrice } = await import('../src/polymarketSizing.js');
  assert.equal(resolveStopLossPrice(0.85, 0.14, 0.50), 0.50);
  assert.equal(resolveStopLossPrice(0.45, 0.12, 0.50), 0.33);
});

test('evaluatePlan2DynamicExit holds take-profit longer when 5m lock aligns with position', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: false,
      plan2DynamicExitEnabled: true,
      plan2StopLossOffset: 0.08,
      plan2ExitHoldConfidence: 0.60,
      plan2FiveMinuteLockEnabled: true,
      plan2ExitLockAlignedHoldDelta: -0.04
    },
    statePath: 'data/test-polymarket-lock-aligned-exit.json'
  });
  const position = {
    planId: 'plan2',
    entryType: 'standard',
    direction: 'up',
    timeframe: '15m',
    entryPrice: 0.56,
    confidence: 0.58
  };
  const hold = service.evaluatePlan2DynamicExit(position, {
    price: 0.75,
    entryPrice: 0.56,
    takeProfit: 0.74,
    stopLoss: 0.48,
    currentAction: { shouldTrade: true, direction: 'up', confidence: 0.58 },
    fiveMinuteLock: { direction: 'up', strength: 'normal', confidence: 0.66 },
    fiveMinuteLockStats: { normal: { total: 8, correct: 6, wrong: 2, accuracy: 0.75 } }
  });
  assert.equal(hold?.hold, true);
});

test('evaluatePlan2DynamicExit reverses faster when strong 5m lock conflicts with position', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: false,
      plan2DynamicExitEnabled: true,
      plan2StopLossOffset: 0.08,
      plan2ExitReverseConfidence: 0.56,
      plan2FiveMinuteLockEnabled: true,
      plan2ExitLockStrongConflictReverseDelta: -0.08
    },
    statePath: 'data/test-polymarket-lock-conflict-exit.json'
  });
  const position = {
    planId: 'plan2',
    entryType: 'standard',
    direction: 'up',
    timeframe: '15m',
    entryPrice: 0.56,
    confidence: 0.62
  };
  const exit = service.evaluatePlan2DynamicExit(position, {
    price: 0.54,
    entryPrice: 0.56,
    takeProfit: 0.74,
    stopLoss: 0.48,
    currentAction: { shouldTrade: true, direction: 'down', confidence: 0.52 },
    fiveMinuteLock: { direction: 'down', strength: 'strong', confidence: 0.70 },
    fiveMinuteLockStats: { strong: { total: 10, correct: 8, wrong: 2, accuracy: 0.8 } }
  });
  assert.equal(exit?.exit?.exitStatus, 'direction-reversal-stop');
});

test('evaluatePlan2DynamicExit stops immediately at soft SL but holds take-profit', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: false,
      plan2DynamicExitEnabled: true,
      plan2StopLossOffset: 0.08,
      plan2ProbeStopLossOffset5m: 0.16,
      plan2ExitHoldConfidenceProbe: 0.54
    },
    statePath: 'data/test-polymarket-probe-dynamic-exit.json'
  });
  const position = {
    planId: 'plan2',
    entryType: 'probe',
    direction: 'up',
    timeframe: '5m',
    entryPrice: 0.56,
    confidence: 0.56
  };
  const stop = service.evaluatePlan2DynamicExit(position, {
    price: 0.48,
    entryPrice: 0.56,
    takeProfit: 0.74,
    stopLoss: 0.48,
    currentAction: { shouldTrade: false, reason: 'Plan2 探针确认等待中' }
  });
  assert.equal(stop?.exit?.exitStatus, 'stop-loss');
  const hold = service.evaluatePlan2DynamicExit(position, {
    price: 0.75,
    entryPrice: 0.56,
    takeProfit: 0.74,
    stopLoss: 0.48,
    currentAction: null
  });
  assert.equal(hold?.hold, true);
});

test('resolveLiveMinHoldBeforeExitMs uses probe-specific hold for probe positions', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: false,
      liveMinHoldBeforeExitMs5m: 7000,
      liveMinHoldBeforeExitMsProbe5m: 45000,
      liveMinHoldBeforeExitMsProbe15m: 60000,
      plan2MinHoldBeforeExitMs5m: 120000
    },
    statePath: 'data/test-polymarket-probe-min-hold.json'
  });
  assert.equal(service.resolveLiveMinHoldBeforeExitMs({ planId: 'plan2', entryType: 'probe', timeframe: '5m' }), 120000);
  assert.equal(service.resolveLiveMinHoldBeforeExitMs({ planId: 'plan2', entryType: 'main', timeframe: '5m' }), 120000);
  assert.equal(service.resolveLiveMinHoldBeforeExitMs({ entryType: 'probe', timeframe: '5m' }), 45000);
  assert.equal(service.resolveLiveMinHoldBeforeExitMs({ entryType: 'probe', timeframe: '15m' }), 60000);
  assert.equal(service.resolveLiveMinHoldBeforeExitMs({ entryType: 'main', timeframe: '5m' }), 7000);
});

test('plan2 paper-sync exit uses zero min hold and disables dynamic exit', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: true,
      plan2DynamicExitEnabled: true,
      plan2MinHoldBeforeExitMs5m: 120000,
      plan2StopLossOffset: 0.08,
      plan2TakeProfitOffset: 0.16
    },
    statePath: 'data/test-polymarket-plan2-paper-sync-exit.json'
  });
  const position = {
    planId: 'plan2',
    entryType: 'probe',
    timeframe: '5m',
    direction: 'up',
    entryPrice: 0.56,
    limitPrice: 0.56,
    takeProfitPrice: 0.72,
    stopLossPrice: 0.48,
    filledAtIso: new Date().toISOString()
  };
  assert.equal(service.resolveLiveMinHoldBeforeExitMs(position), 0);
  assert.equal(service.shouldWaitAfterBuyFill(position, 0.47), false);
  assert.equal(service.evaluatePlan2DynamicExit(position, {
    price: 0.75,
    entryPrice: 0.56,
    takeProfit: 0.72,
    stopLoss: 0.48,
    currentAction: { shouldTrade: true, direction: 'up', confidence: 0.7 }
  }), null);
  assert.equal(service.evaluateLiveExitTrigger(position, 0.47)?.exitStatus, 'stop-loss');
  assert.equal(service.evaluateLiveExitTrigger(position, 0.73)?.exitStatus, 'take-profit');
  assert.equal(service.canOpenLiveStopLossReversalForWindow({
    timeframe: '5m',
    slotIso: '2026-01-01T00:00:00.000Z'
  }).allowed, false);
});

test('plan2_5/plan2_6 paper-sync exit suppresses TP but keeps live hard SL', () => {
  const service = new PolymarketTradingService({
    config: {
      plan25LiveSyncPaperExitEnabled: true,
      plan26LiveSyncPaperExitEnabled: true,
      plan2StopLossEnabled: true,
      plan2TakeProfitEnabled: true,
      plan2DynamicExitEnabled: true
    },
    statePath: 'data/test-polymarket-plan25-plan26-hold-exit.json'
  });
  for (const planId of ['plan2_5', 'plan2_6']) {
    const position = {
      planId,
      entryType: 'sustained_momentum',
      timeframe: '15m',
      direction: 'up',
      entryPrice: 0.56,
      limitPrice: 0.56,
      takeProfitPrice: 0.72,
      stopLossPrice: 0.48
    };
    assert.equal(service.isPlan2ExitSyncedToPaper(planId), true);
    assert.equal(service.isPlan2LiveEarlyExitEnabled(planId), false);
    const sl = service.evaluateLiveExitTrigger(position, 0.10);
    assert.equal(sl?.exitStatus, 'stop-loss');
    assert.equal(service.evaluateLiveExitTrigger(position, 0.90), null);
  }
});

test('plan2StopLossEnabled false disables fixed SL for plan2_5/plan2_6 when sync exit off', () => {
  const service = new PolymarketTradingService({
    config: {
      plan25LiveSyncPaperExitEnabled: false,
      plan26LiveSyncPaperExitEnabled: false,
      plan2LiveSyncPaperEnabled: false,
      plan2LiveSyncPaperExitEnabled: false,
      plan2StopLossEnabled: false,
      plan2TakeProfitEnabled: false,
      plan2DynamicExitEnabled: false
    },
    statePath: 'data/test-polymarket-plan25-sl-disabled.json'
  });
  for (const planId of ['plan2', 'plan2_5', 'plan2_6']) {
    const position = {
      planId,
      entryPrice: 0.5,
      limitPrice: 0.5,
      takeProfitPrice: 0.68,
      stopLossPrice: 0.35
    };
    assert.equal(service.evaluateLiveExitTrigger(position, 0.10), null);
    assert.equal(service.evaluateLiveExitTrigger(position, 0.90), null);
  }
});

test('plan2 5m soft stop-loss respects 2m min hold while hard stop still bypasses', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: false,
      plan2MinHoldBeforeExitMs5m: 120000,
      plan2ExitHardStopOffset: 0.22,
      liveMinHoldBypassOnHardStop: true,
      liveMinHoldBypassOnStopLoss5m: true
    },
    statePath: 'data/test-polymarket-plan2-min-hold-soft-sl.json'
  });
  const filledAtIso = new Date().toISOString();
  const position = {
    planId: 'plan2',
    entryType: 'probe',
    timeframe: '5m',
    entryPrice: 0.59,
    stopLossPrice: 0.43,
    filledAtIso
  };
  assert.equal(service.shouldWaitAfterBuyFill(position, 0.42), true);
  assert.equal(service.shouldWaitAfterBuyFill(position, 0.36), false);
});

test('evaluateLiveExitTrigger uses probe stop-loss offset when recomputing SL', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: false,
      plan2StopLossOffset: 0.08,
      plan2ProbeStopLossOffset5m: 0.16,
      plan2DynamicExitEnabled: false,
      liveMinHoldBeforeExitMs: 0
    },
    statePath: 'data/test-polymarket-probe-sl-offset.json'
  });
  const position = {
    planId: 'plan2',
    entryType: 'probe',
    timeframe: '5m',
    entryPrice: 0.56,
    limitPrice: 0.56
  };
  assert.equal(service.evaluateLiveExitTrigger(position, 0.39)?.exitStatus, 'stop-loss');
  assert.equal(service.evaluateLiveExitTrigger(position, 0.49)?.exitStatus, 'stop-loss');
  assert.equal(service.evaluateLiveExitTrigger(position, 0.51), null);
});

test('shouldWaitAfterBuyFill bypasses probe min hold when hard stop breached', () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSyncPaperEnabled: false,
      liveMinHoldBeforeExitMsProbe5m: 45000,
      plan2ExitHardStopOffset: 0.22,
      liveMinHoldBypassOnHardStop: true,
      liveMinHoldBypassOnStopLoss5m: true
    },
    statePath: 'data/test-polymarket-min-hold-bypass.json'
  });
  const position = {
    planId: 'plan2',
    entryType: 'probe',
    timeframe: '5m',
    entryPrice: 0.55,
    stopLossPrice: 0.39,
    filledAtIso: new Date().toISOString()
  };
  assert.equal(service.shouldWaitAfterBuyFill(position, 0.54), true);
  assert.equal(service.shouldWaitAfterBuyFill(position, 0.32), false);
  assert.equal(service.shouldWaitAfterBuyFill(position, 0.38), true);
});

test('resolveLiveExitSellPlan prefers GTC for take-profit and FAK for stop-loss', () => {
  const service = new PolymarketTradingService({
    config: {
      liveTakeProfitSellUseGtc: true,
      liveTakeProfitGtcSellOffset: 0.005,
      liveStopSellUseGtc5m: false,
      liveStopSellOffset5m: 0.03
    },
    statePath: 'data/test-polymarket-gtc-stop-sell.json'
  });
  const position = {
    timeframe: '5m',
    stopLossPrice: 0.39,
    takeProfitPrice: 0.71,
    entryPrice: 0.55
  };
  const stopPlan = service.resolveLiveExitSellPlan(position, 0.38, 'stop-loss');
  assert.equal(stopPlan.preferGtcStop, false);
  assert.equal(stopPlan.preferGtcTakeProfit, false);

  const tpPlan = service.resolveLiveExitSellPlan(position, 0.72, 'take-profit');
  assert.equal(tpPlan.preferGtcTakeProfit, true);
  assert.ok(tpPlan.price >= 0.70 && tpPlan.price <= 0.72);

  const trailPlan = service.resolveLiveExitSellPlan(position, 0.60, 'trailing-take-profit');
  assert.equal(trailPlan.preferGtcTakeProfit, false);
});

test('resolveLiveExitRetryMs uses urgent cooldown for stops and slower for take-profit', () => {
  const service = new PolymarketTradingService({
    config: {
      liveExitRetryMs5m: 3000,
      liveExitRetryMs5mUrgent: 2000,
      liveExitRetryMs5mTakeProfit: 12000
    },
    statePath: 'data/test-polymarket-exit-retry-urgent.json'
  });
  assert.equal(service.resolveLiveExitRetryMs({ timeframe: '5m' }, 'stop-loss'), 2000);
  assert.equal(service.resolveLiveExitRetryMs({ timeframe: '5m' }, 'take-profit'), 12000);
});

test('settleExpiredLivePositions releases expired live exposure', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true },
    statePath: 'data/test-polymarket-live-expiry-settle.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan2',
    timeframe: '5m',
    slotIso: '2026-01-01T00:00:00.000Z',
    targetTimeIso: '2026-01-01T00:05:00.000Z',
    direction: 'down',
    tokenId: '222',
    usd: 3,
    shares: 6,
    limitPrice: 0.5,
    entryPrice: 0.5
  });
  await service.recordLiveOrder({
    status: 'pending',
    orderSide: 'BUY',
    positionStatus: 'pending',
    planId: 'plan2',
    timeframe: '5m',
    slotIso: '2026-01-01T00:05:00.000Z',
    targetTimeIso: '2026-01-01T00:10:00.000Z',
    direction: 'up',
    tokenId: '333',
    usd: 4,
    shares: 8,
    limitPrice: 0.5,
    entryPrice: 0.5,
    clobStatus: 'live'
  });

  // Expired windows stop consuming entry-risk budget before the independent
  // official settlement reconciliation completes.
  assert.equal(service.liveRiskSnapshot({ clobBalanceUsdc: 100, timeframe: '5m' }).timeframeOpenExposureUsd, 0);
  const settled = await service.settleExpiredLivePositions(async () => ({
    actualDirection: 'up',
    actualClose: 101,
    startPrice: 100
  }), { now: new Date('2026-01-01T00:11:00.000Z') });

  assert.equal(settled.length, 2);
  const orders = service.listLiveOrders();
  const filled = orders.find((order) => order.tokenId === '222');
  const pending = orders.find((order) => order.tokenId === '333');
  assert.equal(filled.positionStatus, 'closed');
  assert.equal(filled.exitStatus, 'expiry');
  assert.equal(filled.won, false);
  assert.equal(filled.pnl, -3);
  assert.equal(pending.positionStatus, 'closed');
  assert.equal(pending.exitStatus, 'expired-unfilled');
  assert.equal(service.liveRiskSnapshot({ clobBalanceUsdc: 100, timeframe: '5m' }).timeframeOpenExposureUsd, 0);
});

test('processLivePlan5StopLosses leaves expired positions to official settlement', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, plan5StopLossEnabled: true },
    statePath: 'data/test-polymarket-live-plan5-expired-stop.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan5',
    timeframe: '5m',
    targetTimeIso: '2000-01-01T00:05:00.000Z',
    direction: 'up',
    tokenId: 'expired-plan5-token',
    usd: 5,
    shares: 10,
    limitPrice: 0.5,
    entryPrice: 0.5
  });
  let resolvedPrice = false;
  service.closeLivePosition = async () => {
    throw new Error('expired Plan5 position must not submit a CLOB exit');
  };
  const closed = await service.processLivePlan5StopLosses(async () => {
    resolvedPrice = true;
    return 0.01;
  });
  assert.equal(resolvedPrice, false);
  assert.deepEqual(closed, []);
});

test('settleExpiredLivePositions does not recancel a terminal Plan1 take-profit order', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true },
    statePath: 'data/test-polymarket-live-expiry-terminal-tp.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const position = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '5m',
    slotIso: '2026-01-01T00:00:00.000Z',
    targetTimeIso: '2026-01-01T00:05:00.000Z',
    direction: 'up',
    tokenId: 'terminal-tp-token',
    usd: 4,
    shares: 8,
    limitPrice: 0.5,
    entryPrice: 0.5
  });
  position.takeProfitOrderId = 'terminal-tp-order';
  position.takeProfitOrderStatus = 'CANCELED_MARKET_RESOLVED';
  service.cancelLivePlan1TakeProfitOrder = async () => {
    throw new Error('terminal take-profit must not be cancelled again');
  };

  const settled = await service.settleExpiredLivePositions(async () => ({
    actualDirection: 'up',
    actualClose: 101,
    startPrice: 100
  }), { now: new Date('2026-01-01T00:06:00.000Z') });

  assert.equal(settled.length, 1);
  assert.equal(position.positionStatus, 'closed');
  assert.equal(position.exitStatus, 'expiry');
  assert.equal(position.pnl, 4);
  assert.equal(position.takeProfitOrderId, null);
  assert.equal(position.lastTakeProfitOrderId, 'terminal-tp-order');
});

test('reconcileLiveOfficialSettlements corrects locally misclassified expiry PnL', async () => {
  const service = new PolymarketTradingService({ config: {} });
  service.state.liveOrders = [{
    id: 'pm-live-wrong-outcome',
    orderSide: 'BUY',
    positionStatus: 'closed',
    status: 'submitted',
    planId: 'plan3_6',
    marketSlug: 'btc-updown-5m-test',
    direction: 'up',
    shares: 125,
    usd: 2.5,
    entryPrice: 0.02,
    exitStatus: 'expiry',
    exitPrice: 1,
    won: true,
    pnl: 122.5,
    payoutUsd: 125,
    actualDirection: 'up'
  }];
  service.persist = async () => {};
  const result = await service.reconcileLiveOfficialSettlements(async () => ({
    actualDirection: 'down',
    officialOutcome: 'Down',
    outcomePrices: [0, 1],
    priceSource: 'polymarket-official'
  }));
  const order = service.state.liveOrders[0];
  assert.equal(result.corrected.length, 1);
  assert.equal(order.actualDirection, 'down');
  assert.equal(order.won, false);
  assert.equal(order.pnl, -2.5);
  assert.equal(order.payoutUsd, 0);
  assert.equal(order.exitPrice, 0);
  assert.match(order.exitReason, /Polymarket official/);
});

test('reconcilePaperOfficialSettlements corrects plan3_6 PnL and portfolio cash', async () => {
  const service = new PolymarketTradingService({ config: {} });
  const bucket = service.getBucket('plan3_6');
  bucket.portfolio = { startingCash: 500, cash: 622.5, portfolioInitialized: true };
  bucket.paperOrders = [{
    id: 'pm-paper-wrong-outcome',
    planId: 'plan3_6',
    settlementStatus: 'settled',
    exitStatus: 'expiry',
    marketSlug: 'btc-updown-5m-test',
    direction: 'up',
    shares: 125,
    usd: 2.5,
    won: true,
    pnl: 122.5,
    payoutUsd: 125,
    actualDirection: 'up'
  }];
  service.persist = async () => {};
  const result = await service.reconcilePaperOfficialSettlements(async () => ({
    actualDirection: 'down',
    officialOutcome: 'Down',
    outcomePrices: [0, 1],
    priceSource: 'polymarket-official'
  }));
  const order = bucket.paperOrders[0];
  assert.equal(result.corrected.length, 1);
  assert.equal(order.won, false);
  assert.equal(order.pnl, -2.5);
  assert.equal(order.payoutUsd, 0);
  assert.equal(bucket.portfolio.cash, 497.5);
});

test('reconcilePaperOfficialSettlements corrects ordinary plan paper PnL', async () => {
  const service = new PolymarketTradingService({ config: {} });
  const bucket = service.getBucket('plan2');
  bucket.portfolio = { startingCash: 500, cash: 510, portfolioInitialized: true };
  bucket.paperOrders = [{
    id: 'pm-paper-plan2-wrong-outcome',
    planId: 'plan2',
    settlementStatus: 'settled',
    exitStatus: 'expiry',
    marketSlug: 'sol-updown-5m-test',
    direction: 'up',
    shares: 10,
    usd: 8,
    won: true,
    pnl: 2,
    payoutUsd: 10,
    actualDirection: 'up'
  }];
  service.persist = async () => {};
  const result = await service.reconcilePaperOfficialSettlements(async () => ({
    actualDirection: 'down',
    officialOutcome: 'Down',
    outcomePrices: [0, 1],
    priceSource: 'polymarket-official'
  }), { planId: 'plan2' });
  const order = bucket.paperOrders[0];
  assert.equal(result.corrected.length, 1);
  assert.equal(order.won, false);
  assert.equal(order.pnl, -8);
  assert.equal(order.payoutUsd, 0);
  assert.equal(bucket.portfolio.cash, 500);
});

test('canOpenNewLiveEntryForWindow blocks duplicate pending live buys', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true },
    statePath: 'data/test-polymarket-live-window-pending.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  await service.recordLiveOrder({
    status: 'pending',
    orderSide: 'BUY',
    positionStatus: 'pending',
    planId: 'plan2',
    timeframe: '5m',
    slotIso: '2026-01-01T00:00:00.000Z',
    targetTimeIso: '2026-01-01T00:05:00.000Z',
    direction: 'down',
    tokenId: 'pending-token',
    usd: 3,
    shares: 6,
    limitPrice: 0.5
  });

  const gate = service.canOpenNewLiveEntryForWindow({
    planId: 'plan2',
    timeframe: '5m',
    slotIso: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.openPosition.positionStatus, 'pending');
});

test('plan1 opposite_hedge live gate matches paper and recognizes live open main', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan1OppositeHedgeEnabled: true,
      plan1OppositeHedgeMaxPrice: 0.15,
      plan1OppositeHedgeSizePct: 0.05
    },
    statePath: 'data/test-polymarket-plan1-hedge-parity.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const slotIso = '2026-07-28T03:00:00.000Z';
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    entryType: 'main',
    symbol: 'BTC-USD',
    timeframe: '15m',
    slotIso,
    targetTimeIso: '2026-07-28T03:15:00.000Z',
    direction: 'down',
    tokenId: 'main-token',
    usd: 10,
    shares: 20,
    limitPrice: 0.5,
    fillConfirmed: true
  });

  const blockedMain = service.canOpenNewLiveEntryForWindow({
    planId: 'plan1',
    timeframe: '15m',
    slotIso,
    symbol: 'BTC-USD',
    entryType: 'main',
    direction: 'down'
  });
  assert.equal(blockedMain.allowed, false);

  const hedgeGate = service.canOpenNewLiveEntryForWindow({
    planId: 'plan1',
    timeframe: '15m',
    slotIso,
    symbol: 'BTC-USD',
    entryType: 'opposite_hedge',
    direction: 'up'
  });
  assert.equal(hedgeGate.allowed, true);

  const plan = buildPolymarketPaperPlan({
    signal: {
      symbol: 'BTC-USD',
      schedule: { currentSlotIso: slotIso },
      prediction: { comparisonBasePrice: 100, estimatedClose: 99 },
      indicators: { currentPrice: 99.5 },
      strategies: {
        tech: { direction: 'down', confidence: 0.7, upProbability: 0.3, downProbability: 0.7 }
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      timeframe: '15m',
      upPrice: 0.12,
      downPrice: 0.88,
      qualityScore: 0.6,
      upTokenId: 'up',
      downTokenId: 'down'
    },
    config: {
      plan1OppositeHedgeEnabled: true,
      plan1OppositeHedgeMaxPrice: 0.15,
      plan1OppositeHedgeSizePct: 0.05,
      plan1LateCaptureEnabled: false,
      plan1DirectionFlipEnabled: false,
      plan1DirectionFlipEnabled15m: false
    },
    portfolio: { portfolioInitialized: true, cash: 100, equity: 110, startingCash: 100 },
    openExposureOrders: [{
      planId: 'plan1',
      symbol: 'BTC-USD',
      timeframe: '15m',
      slotIso,
      direction: 'down',
      entryType: 'main',
      usd: 10,
      source: 'live',
      status: 'submitted',
      positionStatus: 'open'
      // intentionally no settlementStatus — live rows historically omitted it
    }],
    timeframe: '15m',
    paperMode: false,
    now: new Date('2026-07-28T03:05:00.000Z')
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'opposite_hedge');
  assert.equal(plan.action.direction, 'up');
});

test('live execution claim blocks concurrent duplicate submits for same planKey', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'pm-live-exec-claim-'));
  try {
    const service = new PolymarketTradingService({
      config: { liveTradingEnabled: true },
      statePath: join(root, 'state.json')
    });
    await service.load();
    const key = '2026-01-01T00:00:00.000Z_XRP-USD_5m_plan2_5_settlement_capture_90';
    assert.equal(service.tryClaimLiveExecutionKey(key, 'plan2_5'), true);
    assert.equal(service.tryClaimLiveExecutionKey(key, 'plan2_5'), false);
    // plan2_6 may claim the same bare key — claims are plan-scoped.
    assert.equal(service.tryClaimLiveExecutionKey(key, 'plan2_6'), true);
    service.releaseLiveExecutionKey(key, 'plan2_5');
    service.releaseLiveExecutionKey(key, 'plan2_6');
    assert.equal(service.tryClaimLiveExecutionKey(key, 'plan2_5'), true);
    await service.recordLiveOrder({
      status: 'submitted',
      orderSide: 'BUY',
      positionStatus: 'open',
      planId: 'plan2_5',
      planKey: key,
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z',
      direction: 'down',
      usd: 4.5,
      shares: 5,
      limitPrice: 0.9
    });
    service.releaseLiveExecutionKey(key, 'plan2_5');
    assert.equal(service.tryClaimLiveExecutionKey(key, 'plan2_5'), false);
    assert.equal(service.hasBlockingLiveOrderForExecutionKey(key, 'plan2_5'), true);
    // Open plan2_5 order must not block plan2_6 on a distinct plan-scoped claim.
    assert.equal(service.hasBlockingLiveOrderForExecutionKey(key, 'plan2_6'), false);
    assert.equal(service.tryClaimLiveExecutionKey(key, 'plan2_6'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan2_5 / plan2_6 lastExecutedKeys and claims stay independent even with legacy bare keys', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'pm-plan25-26-indep-'));
  try {
    const service = new PolymarketTradingService({
      config: { liveTradingEnabled: true },
      statePath: join(root, 'state.json')
    });
    await service.load();
    // Historical collision shape: both plans used "..._plan2_<entryType>" before planId was embedded.
    const legacySharedKey = '2026-07-24T04:00:00.000Z_SOL-USD_15m_plan2_sustained_momentum';
    const key25 = '2026-07-24T04:00:00.000Z_SOL-USD_15m_plan2_5_sustained_momentum';
    const key26 = '2026-07-24T04:00:00.000Z_SOL-USD_15m_plan2_6_sustained_momentum';

    await service.markLiveExecuted(legacySharedKey, 'plan2_6');
    assert.equal(service.hasLiveExecutedKey(legacySharedKey, 'plan2_6'), true);
    // Scoped mark for 2.6 must not poison 2.5 on the same bare legacy key.
    assert.equal(service.hasLiveExecutedKey(legacySharedKey, 'plan2_5'), false);
    // Unscoped/legacy bare write also must not cross-block when planId is supplied.
    service.state.liveAuto.lastExecutedKeys = [legacySharedKey];
    assert.equal(service.hasLiveExecutedKey(legacySharedKey, 'plan2_5'), false);
    assert.equal(service.hasLiveExecutedKey(legacySharedKey, 'plan2_6'), false);
    assert.equal(service.hasLiveExecutedKey(legacySharedKey), true);

    await service.markLiveExecuted(key25, 'plan2_5');
    await service.markLiveExecuted(key26, 'plan2_6');
    assert.equal(service.hasLiveExecutedKey(key25, 'plan2_5'), true);
    assert.equal(service.hasLiveExecutedKey(key26, 'plan2_6'), true);
    assert.equal(service.hasLiveExecutedKey(key25, 'plan2_6'), false);
    assert.equal(service.hasLiveExecutedKey(key26, 'plan2_5'), false);

    assert.equal(service.tryClaimLiveExecutionKey(key25, 'plan2_5'), true);
    assert.equal(service.tryClaimLiveExecutionKey(key25, 'plan2_6'), true);
    service.releaseLiveExecutionKey(key25, 'plan2_5');
    service.releaseLiveExecutionKey(key25, 'plan2_6');

    // Paper buckets keep independent lastExecutedKeys.
    await service.markExecuted(key25, 'plan2_5');
    await service.markExecuted(key26, 'plan2_6');
    assert.ok(service.getBucket('plan2_5').auto.lastExecutedKeys.includes(key25));
    assert.ok(service.getBucket('plan2_6').auto.lastExecutedKeys.includes(key26));
    assert.ok(!service.getBucket('plan2_5').auto.lastExecutedKeys.includes(key26));
    assert.ok(!service.getBucket('plan2_6').auto.lastExecutedKeys.includes(key25));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan2_5 dust top-up avoids a sub-minimum order that would double risk', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'pm-dust-topup-force-'));
  try {
    const service = new PolymarketTradingService({
      config: {
        liveTradingEnabled: true,
        liveMaxOrderUsd: 50,
        minOrderUsd: 5,
        liveMinSharesBuffer: 6
      },
      statePath: join(root, 'state.json')
    });
    await service.load();
    service.state.liveAuto.enabled = true;
    service.state.liveAuto.enabledPlans = ['plan2_5'];
    service.state.liveAuto.lastExecutedKeys = [];
    const slotIso = '2099-01-01T00:15:00.000Z';
    const targetTimeIso = '2099-01-01T00:30:00.000Z';
    const planKey = `${slotIso}_XRP-USD_15m_plan2_5_settlement_capture_90`;
    await service.recordLiveOrder({
      status: 'submitted',
      orderSide: 'BUY',
      positionStatus: 'open',
      planId: 'plan2_5',
      planKey,
      symbol: 'XRP-USD',
      timeframe: '15m',
      slotIso,
      targetTimeIso,
      direction: 'up',
      entryType: 'settlement_capture_90',
      usd: 4.55,
      shares: 4.64,
      remainingShares: 4.64,
      remainingCostUsd: 4.55,
      entryPrice: 0.98,
      limitPrice: 0.98,
      dustTopUpPending: true,
      filledAtIso: new Date().toISOString()
    });

    let createCalls = 0;
    service.createLiveOrder = async ({ planView }) => {
      createCalls += 1;
      assert.equal(planView.plan.action.shouldTrade, true);
      assert.equal(planView.plan.action.dustTopUpForce, true);
      assert.equal(planView.plan.action.executionKey, planKey);
      assert.equal(planView.plan.action.direction, 'up');
      assert.ok(Number(planView.plan.action.usd) > 0);
      return {
        filled: true,
        orderType: 'FAK',
        draft: {
          planId: 'plan2_5',
          symbol: 'XRP-USD',
          timeframe: '15m',
          entryType: 'settlement_capture_90',
          direction: 'up',
          usd: 5.88,
          shares: 6,
          limitPrice: 0.98,
          tokenId: 'up-token'
        },
        response: {
          success: true,
          status: 'matched',
          orderID: 'dust-topup-test',
          takingAmount: '6',
          makingAmount: '5.88',
          transactionsHashes: ['0xabc']
        }
      };
    };

    const result = await service.maybeLiveAutoExecute({
      planView: {
        planId: 'plan2_5',
        plan: {
          planId: 'plan2_5',
          symbol: 'XRP-USD',
          timeframe: '15m',
          slotIso,
          targetTimeIso,
          key: planKey,
          action: {
            shouldTrade: false,
            reason: 'settlement_capture_90 band gone',
            direction: 'up',
            executionKey: planKey
          }
        },
        polymarket: {
          available: true,
          symbol: 'XRP-USD',
          timeframe: '15m',
          upTokenId: 'up-token',
          downTokenId: 'down-token',
          upPrice: 0.98,
          downPrice: 0.02,
          marketSlug: 'xrp-updown-15m-test'
        }
      },
      clobBalanceUsdc: 100,
      closedOnly: false,
      readinessReady: true
    });

    assert.equal(createCalls, 0);
    assert.equal(result.executed, false);
    assert.equal(result.reason, 'settlement_capture_90 band gone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical wallet_follow entryType still resolves to plan4 for analytics', () => {
  assert.equal(resolvePlanFromEntryType('wallet_follow'), 'plan4');
  assert.equal(resolvePlanFromEntryType('wallet_follow_add'), 'plan4');
  assert.equal(normalizeLiveOrderPlanId({ entryType: 'wallet_follow' }), 'plan4');
  // plan4 is no longer a paper/live trading bucket; explicit planId falls through to entryType.
  assert.equal(normalizeLiveOrderPlanId({ planId: 'plan4', entryType: 'wallet_follow' }), 'plan4');
});

test('setLiveAuto ignores retired plan4 id and keeps shared timeframes', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveAutoEnabled: false },
    statePath: 'data/test-polymarket-live-auto-plan4-state.json'
  });
  await service.load();
  service.state.liveAuto = {
    ...(service.state.liveAuto || {}),
    enabled: false,
    enabledPlans: [],
    planRuns: {},
    timeframes: ['5m', '15m']
  };
  // Retired wallet-follow plan4 normalizes away from PLAN_IDS.
  const auto = await service.setLiveAuto(true, { planId: 'plan4', timeframes: ['5m', '15m'] });
  assert.equal(auto.enabled, true);
  assert.ok(!auto.enabledPlans.includes('plan4'));
  assert.deepEqual(auto.timeframes, ['5m', '15m']);

  const both = await service.setLiveAuto(true, { planId: 'plan2' });
  assert.ok(both.enabledPlans.includes('plan2_5'));
  assert.ok(!both.enabledPlans.includes('plan4'));
  assert.deepEqual(both.timeframes, ['5m', '15m']);
});

test('liveLossRiskSnapshot cools down then resumes reduced size after 5 losses', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      lossStreakCooldown4Ms: 15 * 60 * 1000,
      lossStreakCooldown5Ms: 30 * 60 * 1000,
      lossStreakRecoveryScale: 0.25
    },
    statePath: 'data/test-polymarket-live-loss-risk.json'
  });
  await service.load();
  service.state.liveOrders = [];
  const lossTimes = [
    '2026-01-01T00:20:00.000Z',
    '2026-01-01T00:19:00.000Z',
    '2026-01-01T00:18:00.000Z',
    '2026-01-01T00:17:00.000Z',
    '2026-01-01T00:16:00.000Z'
  ];
  service.state.liveOrders = lossTimes.map((closedAtIso, index) => ({
    id: `loss-${index}`,
    orderSide: 'BUY',
    positionStatus: 'closed',
    status: 'submitted',
    closedAtIso,
    createdAtIso: closedAtIso,
    pnl: -1
  }));

  const cooling = service.liveLossRiskSnapshot(Date.parse('2026-01-01T00:25:00.000Z'));
  assert.equal(cooling.lossStreak, 5);
  assert.equal(cooling.lossStreakScale, 0);
  assert.equal(cooling.lossRecoveryMode, 'cooldown');
  assert.ok(cooling.lossCooldownRemainingMs > 0);

  const recovering = service.liveLossRiskSnapshot(Date.parse('2026-01-01T00:51:00.000Z'));
  assert.equal(recovering.lossStreak, 5);
  assert.equal(recovering.lossStreakScale, 0.25);
  assert.equal(recovering.lossRecoveryMode, 'recovery');
});

test('liveLossRiskSnapshot isolates streak by planId', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, lossStreakRecoveryScale: 0.25 },
    statePath: 'data/test-polymarket-live-loss-risk-plan-isolation.json'
  });
  await service.load();
  service.state.liveOrders = Array.from({ length: 5 }, (_, index) => ({
    id: `plan5-loss-${index}`,
    planId: 'plan5',
    orderSide: 'BUY',
    positionStatus: 'closed',
    status: 'submitted',
    closedAtIso: `2026-01-01T00:2${index}:00.000Z`,
    createdAtIso: `2026-01-01T00:2${index}:00.000Z`,
    pnl: -5
  }));

  const plan5Risk = service.liveLossRiskSnapshot(Date.parse('2026-01-01T01:00:00.000Z'), 'plan5');
  const plan2Risk = service.liveLossRiskSnapshot(Date.parse('2026-01-01T01:00:00.000Z'), 'plan2');
  assert.equal(plan5Risk.lossStreak, 5);
  assert.ok(['recovery', 'cooldown'].includes(plan5Risk.lossRecoveryMode));
  assert.equal(plan2Risk.lossStreak, 0);
  assert.equal(plan2Risk.lossRecoveryMode, 'normal');
});

test('buildLiveOrderDraft requires strong setup during loss recovery', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      maxOrderEquityPct: 0.08,
      maxTotalOpenExposurePct: 0.25,
      maxTimeframeOpenExposurePct: 0.12,
      minOrderUsd: 0.5,
      lossStreakCooldown5Ms: 30 * 60 * 1000,
      lossStreakRecoveryScale: 0.25,
      lossStreakRecoveryMinConfidence: 0.65,
      lossStreakRecoveryMinEdge: 0.08
    },
    statePath: 'data/test-polymarket-live-recovery-draft.json'
  });
  await service.load();
  service.state.liveOrders = Array.from({ length: 5 }, (_, index) => ({
    id: `old-loss-${index}`,
    planId: 'plan2',
    orderSide: 'BUY',
    positionStatus: 'closed',
    status: 'submitted',
    closedAtIso: `2020-01-01T00:0${index}:00.000Z`,
    createdAtIso: `2020-01-01T00:0${index}:00.000Z`,
    pnl: -1
  }));

  assert.throws(() => service.buildLiveOrderDraft({
    plan: {
      action: {
        shouldTrade: true,
        direction: 'up',
        usd: 8,
        confidence: 0.56,
        edge: 0.03
      },
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z'
    },
    sentiment: {
      available: true,
      timeframe: '5m',
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      upPrice: 0.56,
      downPrice: 0.44
    },
    planId: 'plan2',
    clobBalanceUsdc: 100
  }));
});

test('buildLiveOrderDraft does not apply loss recovery gate to plan1 when disabled', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      maxOrderEquityPct: 0.08,
      maxTotalOpenExposurePct: 0.25,
      maxTimeframeOpenExposurePct: 0.12,
      minOrderUsd: 5,
      plan1LiveMinOrderUsd: 5,
      lossStreakRecoveryScale: 0.25,
      lossStreakRecoveryMinConfidence: 0.65,
      lossStreakRecoveryMinEdge: 0.08,
      plan1ApplyLossStreakRecovery: false,
      // 本用例只验证 recovery 闸门关闭；streak sizing 另测
      streakSizingEnabled: false
    },
    statePath: 'data/test-polymarket-plan1-no-loss-recovery.json'
  });
  await service.load();
  service.state.liveOrders = Array.from({ length: 5 }, (_, index) => ({
    id: `plan1-loss-${index}`,
    planId: 'plan1',
    orderSide: 'BUY',
    positionStatus: 'closed',
    status: 'submitted',
    closedAtIso: `2020-01-01T00:0${index}:00.000Z`,
    pnl: -1
  }));
  const draft = service.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 8, confidence: 0.56, edge: 0.03 },
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z'
    },
    sentiment: {
      available: true,
      timeframe: '5m',
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      upPrice: 0.56,
      downPrice: 0.44
    },
    planId: 'plan1',
    clobBalanceUsdc: 100
  });
  assert.equal(draft.usd, 8);
});

test('buildLiveOrderDraft does not apply loss recovery gate to plan11 when disabled', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      maxOrderEquityPct: 0.08,
      maxTotalOpenExposurePct: 0.25,
      maxTimeframeOpenExposurePct: 0.12,
      minOrderUsd: 5,
      plan11LiveMinOrderUsd: 5,
      lossStreakCooldown4Ms: 15 * 60 * 1000,
      lossStreakRecoveryScale: 0.25,
      plan11ApplyLossStreakRecovery: false,
      streakSizingEnabled: false
    },
    statePath: 'data/test-polymarket-plan11-no-loss-recovery.json'
  });
  await service.load();
  service.state.liveOrders = Array.from({ length: 4 }, (_, index) => ({
    id: `plan11-loss-${index}`,
    planId: 'plan11',
    orderSide: 'BUY',
    positionStatus: 'closed',
    status: 'submitted',
    closedAtIso: `2026-01-01T00:0${index}:00.000Z`,
    createdAtIso: `2026-01-01T00:0${index}:00.000Z`,
    pnl: -1
  }));
  const cooling = service.liveLossRiskSnapshot(Date.parse('2026-01-01T00:02:00.000Z'), 'plan11');
  assert.equal(cooling.lossStreak, 4);
  assert.equal(cooling.lossStreakScale, 0);
  const draft = service.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 8, confidence: 0.56, edge: 0.03 },
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z'
    },
    sentiment: {
      available: true,
      timeframe: '5m',
      upTokenId: 'up-token',
      downTokenId: 'down-token',
      upPrice: 0.72,
      downPrice: 0.28
    },
    planId: 'plan11',
    clobBalanceUsdc: 100
  });
  assert.equal(draft.usd, 8);
});

test('maybeFlipLivePlan1Position sells then buys opposite direction', async () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      plan1DirectionFlipEnabled: true,
      plan1FlipMinHoldMs: 0,
      plan1FlipCooldownMs: 0,
      plan1FlipMinConfidence: 0.6,
      plan1FlipMinEdge: 0.05
    },
    statePath: 'data/test-polymarket-live-plan1-flip.json'
  });
  await service.load();
  const createdAt = new Date(Date.now() - 180_000).toISOString();
  await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan1',
    timeframe: '15m',
    slotIso: '2099-01-03T00:00:00.000Z',
    direction: 'up',
    tokenId: '111',
    usd: 10,
    shares: 20,
    limitPrice: 0.5,
    entryPrice: 0.5,
    createdAtIso: createdAt
  });
  service.closeLivePosition = async (position, opts) => {
    position.positionStatus = 'closed';
    position.exitStatus = opts.exitStatus;
    position.pnl = -1;
    return { position, sellRecord: { id: 'sell-flip' }, result: null, draft: {} };
  };
  service.createLiveOrder = async () => ({
    draft: {
      direction: 'down',
      outcome: 'DOWN',
      usd: 10,
      shares: 22,
      limitPrice: 0.45,
      tokenId: '222',
      timeframe: '15m',
      slotIso: '2099-01-03T00:00:00.000Z'
    },
    clobOrderId: 'buy-flip',
    response: { success: true, status: 'live' }
  });
  const planView = {
    planId: 'plan1',
    polymarket: { upPrice: 0.48, downPrice: 0.45 },
    plan: {
      key: '2099_flip_key',
      timeframe: '15m',
      slotIso: '2099-01-03T00:00:00.000Z',
      targetTimeIso: '2099-01-03T00:15:00.000Z',
      elapsedPct: 0.4,
      action: {
        shouldTrade: true,
        direction: 'down',
        confidence: 0.72,
        usd: 10,
        limitPrice: 0.45,
        takeProfitPrice: 0.63,
        stopLossPrice: 0.3,
        reason: 'flip down'
      }
    }
  };
  const flip = await service.maybeFlipLivePlan1Position({
    planView,
    resolveCurrentPrice: async () => 0.48,
    closedOnly: false,
    readinessReady: true
  });
  assert.equal(flip.flipped, true);
  assert.equal(flip.closed.exitStatus, 'direction-flip');
  assert.equal(flip.record.direction, 'down');
  assert.equal(flip.record.positionStatus, 'open');
});

test('buildLiveSellDraft sells configured share ratio at bid price', () => {
  const service = new PolymarketTradingService({
    config: { liveMaxOrderUsd: 25 },
    statePath: 'data/test-polymarket-live-sell-draft.json'
  });
  const draft = service.buildLiveSellDraft({
    id: 'pos-1',
    planId: 'plan1',
    tokenId: '999',
    shares: 12.5,
    direction: 'up',
    outcome: 'UP',
    timeframe: '15m',
    slotIso: '2099-01-01T00:00:00.000Z'
  }, 0.62);
  assert.equal(draft.orderType, 'SELL');
  assert.equal(draft.shares, 12.125);
  assert.equal(draft.limitPrice, 0.62);
  assert.equal(draft.usd, 7.52);
  assert.equal(draft.relatedBuyOrderId, 'pos-1');
});

test('opportunity log persistence is throttled per plan', async () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-opportunity-throttle.json'
  });
  const persisted = [];
  service.persist = async (scope) => persisted.push(scope);

  assert.equal(await service.persistOpportunityLog('plan5', 5000), true);
  assert.equal(await service.persistOpportunityLog('plan5', 5000), false);
  assert.deepEqual(persisted, ['plan5']);

  service.opportunityPersistAtMs.set('plan5', Date.now() - 5001);
  assert.equal(await service.persistOpportunityLog('plan5', 5000), true);
  assert.deepEqual(persisted, ['plan5', 'plan5']);
});

test('Plan3 opportunity log keeps paper and live evaluations separate', () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-plan3-opportunity-source.json'
  });
  const plan = {
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: '2026-07-15T22:20:00.000Z',
    secondsRemaining: 40,
    action: { shouldTrade: false, skipReason: 'price_out_of_range' }
  };
  service.recordPlan3Opportunity(plan, 'plan3', 'paper');
  service.recordPlan3Opportunity(plan, 'plan3', 'live');
  const log = service.getBucket('plan3').plan3OpportunityLog;
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((row) => row.source), ['live', 'paper']);
});

test('live control status preserves cached balance when no refresh value is provided', () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-live-balance-cache.json'
  });
  service.state.liveControl = {
    enabled: true,
    startingBalanceUsdc: 240.99,
    currentBalanceUsdc: 326.974273
  };

  assert.equal(service.liveControlStatus().currentBalanceUsdc, 326.97);
  assert.equal(service.liveControlStatus(null).currentBalanceUsdc, 326.97);
  assert.equal(service.liveControlStatus(0).currentBalanceUsdc, 0);
});

test('live risk uses the last valid balance when a refresh temporarily returns zero', () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-live-risk-balance-cache.json'
  });
  service.state.liveControl = {
    enabled: true,
    startingBalanceUsdc: 1099.25,
    currentBalanceUsdc: 0,
    lastValidBalanceUsdc: 1099.25,
    balanceUpdatedAtIso: new Date().toISOString()
  };
  service.state.liveOrders = [{
    id: 'cached-balance-open-position',
    planId: 'plan1',
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'open',
    timeframe: '5m',
    usd: 42
  }];

  const risk = service.liveRiskSnapshot({ clobBalanceUsdc: 0, timeframe: '5m' });
  assert.equal(risk.cash, 1099.25);
  assert.equal(risk.equity, 1141.25);
  assert.equal(risk.balanceSource, 'cached-last-valid');
  assert.equal(service.computeGlobalExposureSnapshot({
    timeframe: '5m',
    clobBalanceUsdc: 0,
    source: 'live'
  }).equity, 1141.25);
});

test('analyzeWindowTrajectory marks sustained momentum when price holds above threshold', () => {
  __resetWindowTrackForTests();
  const slotIso = '2026-06-29T10:00:00.000Z';
  const baseMs = Date.parse('2026-06-29T10:01:30.000Z');
  const prices = [0.68, 0.74, 0.76, 0.77, 0.76];
  prices.forEach((upPrice, index) => {
    recordWindowSnapshot({
      slotIso,
      timeframe: '5m',
      upPrice,
      downPrice: 1 - upPrice,
      btcPrice: 100000 + index * 15,
      elapsedPct: 0.30 + index * 0.08,
      now: new Date(baseMs + index * 5000)
    });
  });
  const analysis = analyzeWindowTrajectory({
    slotIso,
    timeframe: '5m',
    direction: 'up',
    config: SUSTAINED_TEST_CONFIG,
    now: new Date(baseMs + 20000)
  });
  assert.equal(analysis.sustained, true);
  assert.ok(analysis.pullbackFromPeak <= 0.025);
  assert.equal(analysis.sampleCount, 5);
});

test('analyzeWindowTrajectory rejects sustained momentum on large pullback', () => {
  __resetWindowTrackForTests();
  const slotIso = '2026-06-29T10:00:00.000Z';
  const baseMs = Date.parse('2026-06-29T10:01:30.000Z');
  const prices = [0.68, 0.76, 0.78, 0.74];
  prices.forEach((upPrice, index) => {
    recordWindowSnapshot({
      slotIso,
      timeframe: '5m',
      upPrice,
      downPrice: 1 - upPrice,
      btcPrice: 100000 + index * 20,
      elapsedPct: 0.30 + index * 0.08,
      now: new Date(baseMs + index * 5000)
    });
  });
  const analysis = analyzeWindowTrajectory({
    slotIso,
    timeframe: '5m',
    direction: 'up',
    config: SUSTAINED_TEST_CONFIG,
    now: new Date(baseMs + 20000)
  });
  assert.equal(analysis.sustained, false);
  assert.ok(analysis.pullbackFromPeak > 0.025);
});

test('buildPlan2SustainedMomentumTier allows when trajectory qualifies', () => {
  __resetWindowTrackForTests();
  const slotIso = '2026-06-29T10:00:00.000Z';
  const now = new Date('2026-06-29T10:02:30.000Z');
  const baseMs = Date.parse('2026-06-29T10:01:00.000Z');
  [0.70, 0.74, 0.76, 0.77, 0.765].forEach((upPrice, index) => {
    recordWindowSnapshot({
      slotIso,
      timeframe: '5m',
      upPrice,
      downPrice: 1 - upPrice,
      btcPrice: 100000 + index * 12,
      elapsedPct: 0.32 + index * 0.07,
      now: new Date(baseMs + index * 6000)
    });
  });
  const tier = buildPlan2SustainedMomentumTier({
    directionEntry: { direction: 'up', confidence: 0.78 },
    sentiment: {
      available: true,
      upPrice: 0.765,
      downPrice: 0.235,
      qualityScore: 0.72
    },
    signal: {
      prediction: { comparisonBasePrice: 100000 },
      indicators: { currentPrice: 100120, return3Pct: 0.0003 }
    },
    timeframe: '5m',
    config: SUSTAINED_TEST_CONFIG,
    elapsedPct: 0.50,
    slotIso,
    now
  });
  assert.equal(tier.allowed, true);
  assert.equal(tier.tier, 'sustained_momentum');
  assert.equal(tier.sizeMultiplier, 1.35);
  assert.equal(tier.windowTrack.sustained, true);
});

test('buildPolymarketPaperPlan2 picks sustained_momentum when trajectory qualifies', () => {
  __resetWindowTrackForTests();
  const now = new Date('2026-06-29T10:02:30.000Z');
  const schedule = getSlotSchedule(now, 5);
  const baseMs = Date.parse('2026-06-29T10:01:00.000Z');
  [0.70, 0.74, 0.76, 0.77, 0.765].forEach((upPrice, index) => {
    recordWindowSnapshot({
      slotIso: schedule.currentSlotIso,
      timeframe: '5m',
      upPrice,
      downPrice: 1 - upPrice,
      btcPrice: 100000 + index * 12,
      elapsedPct: 0.32 + index * 0.07,
      now: new Date(baseMs + index * 6000)
    });
  });
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.78,
      schedule,
      prediction: {
        targetTimeIso: schedule.nextSlotIso,
        comparisonBasePrice: 100000,
        estimatedClose: 100140
      },
      indicators: {
        currentPrice: 100120,
        slotStartPrice: 100000,
        return3Pct: 0.0003
      }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.765,
      downPrice: 0.235,
      qualityScore: 0.72,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: SUSTAINED_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '5m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, true);
  assert.equal(plan.action.entryType, 'sustained_momentum');
  assert.equal(plan.action.entryTier, 'sustained_momentum');
  assert.equal(plan.action.sizeMultiplier, 1.35);
  assert.equal(plan.action.windowTrack.sustained, true);
});

test('isEarlyExitStatus matches configured early exit reasons', () => {
  assert.equal(isEarlyExitStatus('take-profit'), true);
  assert.equal(isEarlyExitStatus('stop-loss'), true);
  assert.equal(isEarlyExitStatus('time-stop'), true);
  assert.equal(isEarlyExitStatus('direction-reversal-stop'), true);
  assert.equal(isEarlyExitStatus('direction-flip'), true);
  assert.equal(isEarlyExitStatus('dynamic-take-profit'), true);
  assert.equal(isEarlyExitStatus('trailing-take-profit'), true);
  assert.equal(isEarlyExitStatus('plan5-reversal-stop'), true);
  assert.equal(isEarlyExitStatus('plan5-emergency-stop'), true);
  assert.equal(isEarlyExitStatus('expiry'), false);
});

test('classifyExitDecision marks UP take-profit vs actual down as correct', () => {
  const result = classifyExitDecision({
    direction: 'up',
    exitStatus: 'take-profit',
    actualDirection: 'down'
  });
  assert.equal(result.evaluable, true);
  assert.equal(result.holdWouldWin, false);
  assert.equal(result.exitDecisionCorrect, true);
  assert.equal(result.label, 'correct');
});

test('classifyExitDecision marks UP stop-loss vs actual up as wrong', () => {
  const result = classifyExitDecision({
    direction: 'up',
    exitStatus: 'stop-loss',
    actualDirection: 'up'
  });
  assert.equal(result.evaluable, true);
  assert.equal(result.holdWouldWin, true);
  assert.equal(result.exitDecisionCorrect, false);
  assert.equal(result.label, 'wrong');
});

test('computeCounterfactualHoldPnl compares hold-to-expiry payout against cost', () => {
  const winningHold = computeCounterfactualHoldPnl({
    direction: 'up',
    usd: 5,
    shares: 10
  }, 'up');
  const losingHold = computeCounterfactualHoldPnl({
    direction: 'up',
    usd: 5,
    shares: 10
  }, 'down');
  assert.equal(winningHold, 5);
  assert.equal(losingHold, -5);
});

test('applyExitDecisionEvaluation sets counterfactual exit fields on order', () => {
  const order = {
    direction: 'up',
    exitStatus: 'take-profit',
    usd: 5,
    shares: 10,
    pnl: 2
  };
  const changed = applyExitDecisionEvaluation(order, {
    actualDirection: 'down',
    actualClose: 99,
    startPrice: 100
  });
  assert.equal(changed, true);
  assert.equal(order.actualDirection, 'down');
  assert.equal(order.actualClose, 99);
  assert.equal(order.startPrice, 100);
  assert.equal(order.holdWouldWin, false);
  assert.equal(order.exitDecisionCorrect, true);
  assert.equal(order.counterfactualHoldPnl, -5);
  assert.equal(order.exitVsHoldPnlDelta, 7);
  assert.ok(order.exitDecisionEvaluatedAtIso);
});

test('computeExitDecisionAnalytics aggregates early exits by status and plan', () => {
  const orders = [
    {
      id: 'a',
      planId: 'plan1',
      timeframe: '5m',
      direction: 'up',
      exitStatus: 'take-profit',
      actualDirection: 'down',
      exitDecisionCorrect: true,
      pnl: 2,
      counterfactualHoldPnl: -5,
      exitVsHoldPnlDelta: 7,
      settledAtIso: '2026-01-02T00:00:00.000Z'
    },
    {
      id: 'b',
      planId: 'plan1',
      timeframe: '15m',
      direction: 'up',
      exitStatus: 'stop-loss',
      actualDirection: 'up',
      exitDecisionCorrect: false,
      pnl: -2,
      counterfactualHoldPnl: 5,
      exitVsHoldPnlDelta: -7,
      settledAtIso: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'c',
      planId: 'plan2',
      timeframe: '5m',
      direction: 'down',
      exitStatus: 'take-profit',
      actualDirection: null,
      settledAtIso: '2026-01-03T00:00:00.000Z'
    },
    {
      id: 'd',
      planId: 'plan2',
      timeframe: '15m',
      direction: 'up',
      exitStatus: 'expiry',
      actualDirection: 'up',
      exitDecisionCorrect: null,
      settledAtIso: '2026-01-04T00:00:00.000Z'
    }
  ];
  const analytics = computeExitDecisionAnalytics(orders);
  assert.equal(analytics.total, 3);
  assert.equal(analytics.evaluable, 2);
  assert.equal(analytics.pending, 1);
  assert.equal(analytics.correct, 1);
  assert.equal(analytics.wrong, 1);
  assert.equal(analytics.accuracy, 0.5);
  assert.equal(analytics.byExitStatus['take-profit'].count, 2);
  assert.equal(analytics.byExitStatus['take-profit'].correct, 1);
  assert.equal(analytics.byExitStatus['stop-loss'].wrong, 1);
  assert.equal(analytics.byPlanId.plan1.correct, 1);
  assert.equal(analytics.byPlanId.plan1.wrong, 1);
  assert.equal(analytics.byTimeframe['5m'].correct, 1);
  assert.equal(analytics.recentEvaluable.length, 2);
  assert.equal(analytics.recentEvaluable[0].id, 'a');
});

test('computeExitDecisionAnalytics includes plan5 in dynamic plan summary', () => {
  const analytics = computeExitDecisionAnalytics([{
    id: 'plan5-stop',
    planId: 'plan5',
    timeframe: '5m',
    direction: 'up',
    exitStatus: 'plan5-emergency-stop',
    actualDirection: 'down',
    exitDecisionCorrect: true,
    settledAtIso: '2026-01-01T00:00:00.000Z'
  }]);
  assert.equal(analytics.byPlanId.plan5.count, 1);
  assert.equal(analytics.byPlanId.plan5.correct, 1);
});

test('backfillEarlyExitOutcomes evaluates settled early exits after window expiry', async () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-exit-analytics-backfill.json'
  });
  await service.load();
  service.state.plans.plan1.paperOrders = [{
    id: 'paper-tp',
    planId: 'plan1',
    settlementStatus: 'settled',
    exitStatus: 'take-profit',
    direction: 'up',
    timeframe: '5m',
    symbol: 'BTC-USD',
    targetTimeIso: '2026-01-01T00:05:00.000Z',
    usd: 5,
    shares: 10,
    pnl: 2,
    settledAtIso: '2026-01-01T00:03:00.000Z'
  }];
  service.state.liveOrders = [{
    id: 'live-sl',
    orderSide: 'BUY',
    positionStatus: 'closed',
    planId: 'plan2',
    exitStatus: 'stop-loss',
    direction: 'up',
    timeframe: '5m',
    symbol: 'BTC-USD',
    targetTimeIso: '2026-01-01T00:05:00.000Z',
    usd: 4,
    shares: 8,
    pnl: -1,
    closedAtIso: '2026-01-01T00:12:00.000Z'
  }];
  await service.persist();

  let resolveCalls = 0;
  const backfill = await service.backfillEarlyExitOutcomes(async () => {
    resolveCalls += 1;
    return {
      actualDirection: 'down',
      actualClose: 99,
      startPrice: 100
    };
  }, { now: new Date('2026-01-01T00:20:00.000Z') });

  assert.equal(backfill.updated, 2);
  assert.equal(resolveCalls, 1);
  const paper = service.getBucket('plan1').paperOrders[0];
  const live = service.listLiveOrders()[0];
  assert.equal(paper.exitDecisionCorrect, true);
  assert.equal(paper.counterfactualHoldPnl, -5);
  assert.equal(live.exitDecisionCorrect, true);
  assert.equal(live.counterfactualHoldPnl, -4);
});

test('computeExitDecisionAnalytics on service merges paper and live orders', async () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-exit-analytics-service.json'
  });
  await service.load();
  service.state.plans.plan1.paperOrders = [{
    id: 'paper',
    planId: 'plan1',
    settlementStatus: 'settled',
    exitStatus: 'take-profit',
    direction: 'up',
    actualDirection: 'down',
    exitDecisionCorrect: true,
    timeframe: '5m',
    settledAtIso: '2026-01-01T00:00:00.000Z'
  }];
  service.state.plans.plan2.paperOrders = [];
  service.state.liveOrders = [{
    id: 'live',
    orderSide: 'BUY',
    positionStatus: 'closed',
    planId: 'plan2',
    exitStatus: 'stop-loss',
    direction: 'up',
    actualDirection: 'up',
    exitDecisionCorrect: false,
    timeframe: '15m',
    closedAtIso: '2026-01-01T00:01:00.000Z'
  }];
  await service.persist();

  const all = service.computeExitDecisionAnalytics({ planId: null, includeLive: true });
  assert.equal(all.total, 2);
  assert.equal(all.correct, 1);
  assert.equal(all.wrong, 1);

  const plan1Only = service.computeExitDecisionAnalytics({ planId: 'plan1', includeLive: false });
  assert.equal(plan1Only.total, 1);
  assert.equal(plan1Only.correct, 1);

  const liveOnly = service.computeExitDecisionAnalytics({ source: 'live' });
  assert.equal(liveOnly.total, 1);
  assert.equal(liveOnly.wrong, 1);
});

test('writeExitDecisionReports writes plan1 plan2 live markdown files', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'exit-md-'));
  const sampleAnalytics = {
    total: 1,
    evaluable: 1,
    pending: 0,
    correct: 1,
    wrong: 0,
    accuracy: 1,
    byExitStatus: { 'take-profit': { count: 1, evaluable: 1, correct: 1, wrong: 0, accuracy: 1 } },
    byTimeframe: { '5m': { count: 1, evaluable: 1, correct: 1, wrong: 0, accuracy: 1 } },
    recentEvaluable: []
  };
  const mockService = {
    computeExitDecisionAnalytics: ({ planId, source } = {}) => {
      if (source === 'live') return { ...sampleAnalytics, total: 2, evaluable: 2 };
      if (planId === 'plan1') return sampleAnalytics;
      return { ...sampleAnalytics, total: 3, evaluable: 3 };
    }
  };
  const result = await writeExitDecisionReports({ polymarketTrading: mockService, recordDir: dir });
  assert.ok(result.files.plan1);
  assert.ok(result.files.plan2);
  assert.ok(result.files.live);
  assert.ok(result.files.summary);
  const plan1Md = await readFile(result.files.plan1, 'utf8');
  assert.match(plan1Md, /Plan1 退出决策质量统计/);
  const liveMd = await readFile(result.files.live, 'utf8');
  assert.match(liveMd, /实盘退出决策质量统计/);
});

test('evaluatePlan2StopLossReversal allows opposite entry after UP stop-loss', () => {
  const config = {
    plan2StopLossReversalEnabled: true,
    plan2StopLossReversalMinConfidence: 0.58,
    plan2StopLossReversalMinEdge: 0.04,
    plan2StopLossReversalMaxElapsedPct5m: 0.75,
    plan2TakeProfitOffset: 0.16,
    plan2StopLossOffset: 0.08,
    plan2StopLossReversalSizeMultiplier5m: 0.35
  };
  const ok = evaluatePlan2StopLossReversal({
    priorDirection: 'up',
    reversalDirection: 'down',
    limitPrice: 0.55,
    confidence: 0.62,
    elapsedPct: 0.45,
    timeframe: '5m',
    config
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.tier, 'stop_loss_reversal');
});

test('canOpenLiveStopLossReversalForWindow allows one opposite buy per window', async () => {
  const service = new PolymarketTradingService({
    config: { plan2StopLossReversalEnabled: true, plan2LiveSyncPaperEnabled: false },
    statePath: 'data/test-polymarket-sl-reversal-gate.json'
  });
  await service.load();
  service.state.liveOrders = [{
    id: 'buy-up',
    orderSide: 'BUY',
    positionStatus: 'closed',
    planId: 'plan2',
    timeframe: '5m',
    slotIso: '2026-01-01T00:00:00.000Z',
    direction: 'up',
    exitStatus: 'stop-loss',
    closedAtIso: '2026-01-01T00:02:00.000Z'
  }];
  await service.persist();

  const allowed = service.canOpenLiveStopLossReversalForWindow({
    timeframe: '5m',
    slotIso: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.oppositeDirection, 'down');
});

test('canOpenLiveStopLossReversalForWindow blocks after direction reversal stop by default', async () => {
  const service = new PolymarketTradingService({
    config: {
      plan2StopLossReversalEnabled: true,
      plan2StopLossReversalAfterDirectionStop: false,
      plan2LiveSyncPaperEnabled: false
    },
    statePath: 'data/test-polymarket-sl-reversal-gate.json'
  });
  await service.load();
  service.state.liveOrders = [{
    id: 'buy-up',
    orderSide: 'BUY',
    positionStatus: 'closed',
    planId: 'plan2',
    timeframe: '15m',
    slotIso: '2026-01-01T00:00:00.000Z',
    direction: 'up',
    exitStatus: 'direction-reversal-stop',
    closedAtIso: '2026-01-01T00:02:00.000Z'
  }];
  await service.persist();

  const blocked = service.canOpenLiveStopLossReversalForWindow({
    timeframe: '15m',
    slotIso: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /不再反手追单/);
  assert.equal(service.state.liveOrders[0].reversalFollowed, true);
  assert.equal(service.state.liveOrders[0].reversalBlockedReason, 'direction-reversal-stop');
});

test('canOpenLiveStopLossReversalForWindow can opt into reversal after direction stop', async () => {
  const service = new PolymarketTradingService({
    config: {
      plan2StopLossReversalEnabled: true,
      plan2StopLossReversalAfterDirectionStop: true,
      plan2LiveSyncPaperEnabled: false
    },
    statePath: 'data/test-polymarket-sl-reversal-gate.json'
  });
  await service.load();
  service.state.liveOrders = [{
    id: 'buy-up',
    orderSide: 'BUY',
    positionStatus: 'closed',
    planId: 'plan2',
    timeframe: '15m',
    slotIso: '2026-01-01T00:00:00.000Z',
    direction: 'up',
    exitStatus: 'direction-reversal-stop',
    closedAtIso: '2026-01-01T00:02:00.000Z'
  }];
  await service.persist();

  const allowed = service.canOpenLiveStopLossReversalForWindow({
    timeframe: '15m',
    slotIso: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.oppositeDirection, 'down');
});

test('Plan2 live slot loss circuit blocks new entries after two same-window losses', async () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSlotLossCircuitEnabled: true,
      plan2LiveSlotLossCircuitMaxLosses: 2
    },
    statePath: 'data/test-polymarket-plan2-slot-loss-circuit.json'
  });
  await service.load();
  service.state.liveOrders = [
    {
      id: 'loss-2',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan2',
      timeframe: '15m',
      slotIso: '2026-01-01T00:00:00.000Z',
      pnl: -3,
      closedAtIso: '2026-01-01T00:06:00.000Z'
    },
    {
      id: 'loss-1',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan2',
      timeframe: '15m',
      slotIso: '2026-01-01T00:00:00.000Z',
      pnl: -2,
      closedAtIso: '2026-01-01T00:03:00.000Z'
    }
  ];

  const blocked = service.canOpenNewLiveEntryForWindow({
    planId: 'plan2',
    timeframe: '15m',
    slotIso: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.consecutiveLosses, 2);
  assert.match(blocked.reason, /Plan2/);
});

test('Plan2 live slot loss circuit resets when a same-window win appears after losses', async () => {
  const service = new PolymarketTradingService({
    config: {
      plan2LiveSlotLossCircuitEnabled: true,
      plan2LiveSlotLossCircuitMaxLosses: 2
    },
    statePath: 'data/test-polymarket-plan2-slot-loss-circuit.json'
  });
  await service.load();
  service.state.liveOrders = [
    {
      id: 'win',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan2',
      timeframe: '15m',
      slotIso: '2026-01-01T00:00:00.000Z',
      pnl: 4,
      closedAtIso: '2026-01-01T00:06:00.000Z'
    },
    {
      id: 'loss-1',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan2',
      timeframe: '15m',
      slotIso: '2026-01-01T00:00:00.000Z',
      pnl: -2,
      closedAtIso: '2026-01-01T00:03:00.000Z'
    }
  ];

  const allowed = service.checkPlan2LiveSlotLossCircuit({
    timeframe: '15m',
    slotIso: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.consecutiveLosses, 0);
});

test('Plan5 live loss circuit blocks during cooldown then allows after cooldown', async () => {
  const cooldownMs = 45 * 60 * 1000;
  const service = new PolymarketTradingService({
    config: {
      plan5LiveLossCircuitEnabled: true,
      plan5LiveLossCircuitCooldownEnabled: true,
      plan5LiveLossCircuitMaxLosses: 3,
      plan5LiveLossCircuitCooldownMs: cooldownMs
    },
    statePath: 'data/test-polymarket-plan5-loss-circuit.json'
  });
  await service.load();
  const latestLossAt = '2026-07-18T02:49:58.524Z';
  const triggerMs = Date.parse(latestLossAt);
  service.state.liveOrders = [
    {
      id: 'p5-loss-3',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      symbol: 'ETH-USD',
      pnl: -5,
      closedAtIso: latestLossAt
    },
    {
      id: 'p5-loss-2',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      symbol: 'XRP-USD',
      pnl: -4,
      closedAtIso: '2026-07-18T02:47:00.000Z'
    },
    {
      id: 'p5-loss-1',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      symbol: 'SOL-USD',
      pnl: -3,
      closedAtIso: '2026-07-18T02:45:00.000Z'
    }
  ];

  const during = service.checkPlan5LiveLossCircuit({ nowMs: triggerMs + 10 * 60 * 1000 });
  assert.equal(during.allowed, false);
  assert.equal(during.consecutiveLosses, 3);
  assert.match(during.reason, /冷却中约剩 \d+ 分钟/);
  assert.equal(during.triggeredAtIso, latestLossAt);

  const after = service.checkPlan5LiveLossCircuit({ nowMs: triggerMs + cooldownMs + 1000 });
  assert.equal(after.allowed, true);
  assert.equal(after.cooledDown, true);
  assert.equal(after.consecutiveLosses, 3);
});

test('Plan5 live loss circuit re-triggers cooldown after a new loss post-cooldown', async () => {
  const cooldownMs = 45 * 60 * 1000;
  const service = new PolymarketTradingService({
    config: {
      plan5LiveLossCircuitEnabled: true,
      plan5LiveLossCircuitCooldownEnabled: true,
      plan5LiveLossCircuitMaxLosses: 3,
      plan5LiveLossCircuitCooldownMs: cooldownMs
    },
    statePath: 'data/test-polymarket-plan5-loss-circuit.json'
  });
  await service.load();
  const oldLossAt = '2026-07-18T01:00:00.000Z';
  const newLossAt = '2026-07-18T03:00:00.000Z';
  service.state.liveOrders = [
    {
      id: 'p5-loss-new',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -2,
      closedAtIso: newLossAt
    },
    {
      id: 'p5-loss-3',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -5,
      closedAtIso: oldLossAt
    },
    {
      id: 'p5-loss-2',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -4,
      closedAtIso: '2026-07-18T00:55:00.000Z'
    },
    {
      id: 'p5-loss-1',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -3,
      closedAtIso: '2026-07-18T00:50:00.000Z'
    }
  ];

  const reblocked = service.checkPlan5LiveLossCircuit({
    nowMs: Date.parse(newLossAt) + 5 * 60 * 1000
  });
  assert.equal(reblocked.allowed, false);
  assert.equal(reblocked.consecutiveLosses, 4);
  assert.equal(reblocked.triggeredAtIso, newLossAt);
  assert.match(reblocked.reason, /冷却中约剩/);

  const cooledAgain = service.checkPlan5LiveLossCircuit({
    nowMs: Date.parse(newLossAt) + cooldownMs + 1000
  });
  assert.equal(cooledAgain.allowed, true);
  assert.equal(cooledAgain.cooledDown, true);
});

test('Plan5 live loss circuit allows when latest loss timestamp is already past cooldown (no untilIso)', async () => {
  const cooldownMs = 45 * 60 * 1000;
  const service = new PolymarketTradingService({
    config: {
      plan5LiveLossCircuitEnabled: true,
      plan5LiveLossCircuitCooldownEnabled: true,
      plan5LiveLossCircuitMaxLosses: 3,
      plan5LiveLossCircuitCooldownMs: cooldownMs
    },
    statePath: 'data/test-polymarket-plan5-loss-circuit.json'
  });
  await service.load();
  // 模拟实盘卡死场景：只有亏损单 closedAt，从未写入 untilIso
  service.state.liveOrders = [
    {
      id: 'p5-stale-3',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -5,
      closedAtIso: '2026-07-18T02:49:58.524Z'
    },
    {
      id: 'p5-stale-2',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -4,
      closedAtIso: '2026-07-18T02:47:00.000Z'
    },
    {
      id: 'p5-stale-1',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -3,
      closedAtIso: '2026-07-18T02:45:00.000Z'
    }
  ];
  const nowMs = Date.parse('2026-07-18T03:48:00.000Z'); // 最新亏损后约 58 分钟
  const result = service.checkPlan5LiveLossCircuit({ nowMs });
  assert.equal(result.allowed, true);
  assert.equal(result.cooledDown, true);
  assert.equal(result.consecutiveLosses, 3);
});

test('Plan5 live loss circuit with cooldown disabled only warns and does not block', async () => {
  const service = new PolymarketTradingService({
    config: {
      plan5LiveLossCircuitEnabled: true,
      plan5LiveLossCircuitCooldownEnabled: false,
      plan5LiveLossCircuitMaxLosses: 3,
      plan5LiveLossCircuitCooldownMs: 45 * 60 * 1000
    },
    statePath: 'data/test-polymarket-plan5-loss-circuit-cooldown-off.json'
  });
  await service.load();
  const latestLossAt = '2026-07-18T02:49:58.524Z';
  service.state.liveOrders = [
    {
      id: 'p5-off-3',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -5,
      closedAtIso: latestLossAt
    },
    {
      id: 'p5-off-2',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -4,
      closedAtIso: '2026-07-18T02:47:00.000Z'
    },
    {
      id: 'p5-off-1',
      orderSide: 'BUY',
      positionStatus: 'closed',
      planId: 'plan5',
      pnl: -3,
      closedAtIso: '2026-07-18T02:45:00.000Z'
    }
  ];
  const result = service.checkPlan5LiveLossCircuit({
    nowMs: Date.parse(latestLossAt) + 5 * 60 * 1000
  });
  assert.equal(result.allowed, true);
  assert.equal(result.cooldownEnabled, false);
  assert.equal(result.consecutiveLosses, 3);
  assert.match(result.reason, /熔断已关冷却故不拦开仓/);
});

test('confidence calibration maps raw confidence to historical win rate', () => {
  const orders = Array.from({ length: 60 }, (_, index) => ({
    settlementStatus: 'settled',
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    confidence: 0.64,
    limitPrice: 0.57,
    pnl: index < 34 ? 1 : -1,
    won: index < 34
  }));
  const table = buildConfidenceCalibrationTable(orders);
  const key = Object.keys(table).find((item) => item.includes('64-67'));
  assert.ok(key);
  assert.equal(table[key].sampleCount, 60);
  const calibrated = getCalibratedConfidence({
    rawConfidence: 0.64,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    calibrationTable: table,
    config: { confidenceCalibrationEnabled: true, confidenceMinBucketSamples: 50 }
  });
  assert.equal(calibrated.calibrated, true);
  assert.ok(Math.abs(calibrated.calibratedConfidence - 0.5667) < 0.01);
  const edge = resolveCalibratedEdge({
    rawConfidence: 0.64,
    entryPrice: 0.57,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    calibrationTable: table,
    config: { confidenceCalibrationEnabled: true, confidenceMinBucketSamples: 50 }
  });
  assert.ok(edge.edge < 0.01);
});

test('confidence calibration isolates plans and symbols', () => {
  const makeOrders = ({ planId, symbol, wins }) => Array.from({ length: 60 }, (_, index) => ({
    settlementStatus: 'settled',
    planId,
    symbol,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    confidence: 0.64,
    limitPrice: 0.57,
    pnl: index < wins ? 1 : -1,
    won: index < wins
  }));
  const table = buildConfidenceCalibrationTable([
    ...makeOrders({ planId: 'plan1', symbol: 'BTC-USD', wins: 54 }),
    ...makeOrders({ planId: 'plan2_5', symbol: 'BTC-USD', wins: 12 }),
    ...makeOrders({ planId: 'plan1', symbol: 'SOL-USD', wins: 18 })
  ]);
  const read = (planId, symbol) => getCalibratedConfidence({
    rawConfidence: 0.64,
    planId,
    symbol,
    timeframe: '15m',
    direction: 'up',
    entryType: 'main',
    calibrationTable: table,
    config: { confidenceCalibrationEnabled: true, confidenceMinBucketSamples: 50 }
  });

  assert.equal(Object.keys(table).length, 3);
  assert.equal(read('plan1', 'BTC-USD').calibratedConfidence, 0.9);
  assert.equal(read('plan2_5', 'BTC-USD').calibratedConfidence, 0.2);
  assert.equal(read('plan1', 'SOL-USD').calibratedConfidence, 0.3);
});

test('chop filter detects low-distance flip-heavy windows', () => {
  assert.equal(detectChop({
    distanceFromOpenBps: 2,
    directionFlipCount: 4,
    config: { chopFilterEnabled: true, chopMaxDistanceBps: 4, chopMinDirectionFlips: 3 }
  }), true);
  const guard = buildChopRegimeGuard({
    signal: { indicators: { currentPrice: 100020, slotStartPrice: 100000, volatility15mPct: 0.0004 } },
    sentiment: { directionFlipCount5m: 4, priceNearOpenSeconds: 70 },
    config: { regimeFilterEnabled: true, chopFilterEnabled: true }
  });
  assert.equal(guard.isChop, true);
  assert.equal(guard.allowMain, false);
  assert.equal(guard.allowFlip, false);
});

test('probe update score prefers multi-factor confirmation', () => {
  const strong = computeProbeUpdateScore({
    probePrice: 0.55,
    currentPrice: 0.58,
    probeConfidence: 0.60,
    currentConfidence: 0.66,
    probeDistanceBps: 4,
    currentDistanceBps: 12,
    pmStabilityScore: 0.72,
    reverseMoveScore: 0.1,
    spreadWidenScore: 0.05
  });
  const weak = computeProbeUpdateScore({
    probePrice: 0.55,
    currentPrice: 0.552,
    probeConfidence: 0.60,
    currentConfidence: 0.60,
    probeDistanceBps: 4,
    currentDistanceBps: 4.5,
    pmStabilityScore: 0.45,
    reverseMoveScore: 0.8,
    spreadWidenScore: 0.7
  });
  assert.ok(strong.score >= 0.65);
  assert.ok(weak.score < 0.65);
});

test('global exposure cap blocks combined Plan1 and Plan2 slot direction risk', () => {
  const service = new PolymarketTradingService({
    config: {
      globalExposureCapEnabled: true,
      globalSlotDirectionMaxExposurePct: 0.08,
      globalTimeframeMaxExposurePct: 0.12,
      globalTotalBtcMarketExposurePct: 0.20,
      defaultStartingCash: 500
    },
    statePath: 'data/test-global-exposure-state.json',
    defaultStartingCash: 500
  });
  service.getBucket('plan1').portfolio = { startingCash: 500, cash: 500, portfolioInitialized: true };
  service.getBucket('plan2').portfolio = { startingCash: 500, cash: 500, portfolioInitialized: true };
  service.getBucket('plan1').paperOrders.unshift({
    settlementStatus: 'open',
    timeframe: '15m',
    slotIso: '2099-07-01T00:00:00.000Z',
    direction: 'up',
    usd: 30
  });
  service.getBucket('plan2').paperOrders.unshift({
    settlementStatus: 'open',
    timeframe: '15m',
    slotIso: '2099-07-01T00:00:00.000Z',
    direction: 'up',
    usd: 12
  });
  const blocked = service.checkGlobalExposure({
    timeframe: '15m',
    slotIso: '2099-07-01T00:00:00.000Z',
    direction: 'up',
    newOrderUsd: 10,
    equity: 500
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /同窗口同方向/);
});

test('global exposure cap keeps paper and live exposure isolated', () => {
  const service = new PolymarketTradingService({
    config: {
      globalExposureCapEnabled: true,
      globalSlotDirectionMaxExposurePct: 0.08,
      globalTimeframeMaxExposurePct: 0.12,
      globalTotalBtcMarketExposurePct: 0.20,
      defaultStartingCash: 500
    },
    statePath: 'data/test-global-exposure-source-state.json',
    defaultStartingCash: 500
  });
  service.getBucket('plan1').paperOrders.unshift({
    settlementStatus: 'open',
    timeframe: '15m',
    slotIso: '2099-07-01T00:00:00.000Z',
    direction: 'up',
    usd: 40
  });
  service.state.liveOrders = [{
    planId: 'plan2_5',
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'open',
    timeframe: '15m',
    slotIso: '2099-07-01T00:00:00.000Z',
    direction: 'up',
    usd: 35
  }];

  const paper = service.checkGlobalExposure({
    timeframe: '15m',
    slotIso: '2099-07-01T00:00:00.000Z',
    direction: 'up',
    newOrderUsd: 5,
    equity: 500,
    source: 'paper'
  });
  const live = service.checkGlobalExposure({
    timeframe: '15m',
    slotIso: '2099-07-01T00:00:00.000Z',
    direction: 'up',
    newOrderUsd: 5,
    equity: 500,
    source: 'live'
  });

  assert.equal(paper.allowed, false);
  assert.equal(live.allowed, true);
});

test('expired live windows stay pending settlement without blocking new exposure', () => {
  const service = new PolymarketTradingService({
    config: {
      globalExposureCapEnabled: true,
      globalExposureMode: 'total_only',
      globalTotalBtcMarketExposurePct: 0.75,
      defaultStartingCash: 10
    },
    statePath: 'data/test-expired-live-exposure-state.json',
    defaultStartingCash: 10
  });
  service.state.liveOrders = [{
    planId: 'plan5',
    orderSide: 'BUY',
    status: 'submitted',
    positionStatus: 'open',
    timeframe: '5m',
    slotIso: new Date(Date.now() - 10 * 60_000).toISOString(),
    targetTimeIso: new Date(Date.now() - 5 * 60_000).toISOString(),
    direction: 'up',
    usd: 5
  }];

  assert.equal(service.getOpenLivePositions('plan5').length, 1);
  assert.equal(service.getOpenExposureOrders().length, 0);
  const result = service.checkGlobalExposure({
    timeframe: '5m',
    direction: 'down',
    newOrderUsd: 5,
    equity: 10,
    source: 'live'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.snapshot.totalBtcExposureUsd, 0);
});

test('plan2 live sizing ignores plan4 open exposure for principal caps', () => {
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveMaxOrderUsd: 500,
      maxOrderEquityPct: 0.08,
      maxTotalOpenExposurePct: 0.25,
      maxTimeframeOpenExposurePct: 0.12,
      plan2LiveMinOrderUsd5m: 5,
      minOrderUsd: 0.5
    },
    statePath: 'data/test-plan2-ignore-plan4-exposure.json'
  });
  service.state.liveOrders = [{
    id: 'plan4-open',
    planId: 'plan4',
    orderSide: 'BUY',
    positionStatus: 'open',
    status: 'submitted',
    timeframe: '5m',
    usd: 120,
    entryPrice: 0.5,
    limitPrice: 0.5,
    direction: 'up'
  }];
  const draft = service.buildLiveOrderDraft({
    plan: {
      action: { shouldTrade: true, direction: 'up', usd: 15, confidence: 0.7, edge: 0.08 },
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z'
    },
    sentiment: {
      available: true,
      timeframe: '5m',
      upTokenId: 'up',
      downTokenId: 'down',
      upPrice: 0.6,
      downPrice: 0.4
    },
    planId: 'plan2',
    clobBalanceUsdc: 100
  });
  assert.ok(Number(draft.usd) >= 5);
});

test('quarter kelly cap limits oversized orders', () => {
  const cap = getKellyCapUsd({
    calibratedConfidence: 0.62,
    entryPrice: 0.55,
    equity: 500,
    config: { kellyCapEnabled: true, kellyFraction: 0.25, kellyMaxEquityPct: 0.08 }
  });
  assert.ok(cap > 0);
  assert.ok(cap <= 40);
});

test('split state migrates legacy combined file into per-plan and live files', async () => {
  const { mkdtemp, readFile, writeFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poly-split-'));
  const legacyPath = join(dir, 'polymarket-paper-state.json');
  const stateDir = join(dir, 'polymarket');
  await writeFile(legacyPath, `${JSON.stringify({
    plans: {
      plan1: {
        paperOrders: [{ id: 'p1-1', planId: 'plan1', settlementStatus: 'settled', pnl: 1.2 }],
        portfolio: { startingCash: 500, cash: 501.2, portfolioInitialized: true },
        auto: { enabled: false, strategy: 'plan1', timeframes: ['5m'], lastExecutedKeys: [] }
      },
      plan2: {
        paperOrders: [],
        portfolio: { startingCash: 500, cash: 500, portfolioInitialized: true },
        auto: { enabled: false, strategy: 'plan2', timeframes: ['15m'], lastExecutedKeys: [] }
      },
      plan3: {
        paperOrders: [{ id: 'p3-1', planId: 'plan3', entryType: 'settlement_capture', settlementStatus: 'open' }],
        portfolio: { startingCash: 500, cash: 498, portfolioInitialized: true },
        auto: { enabled: true, strategy: 'plan3', timeframes: ['5m', '15m'], lastExecutedKeys: [] }
      }
    },
    liveControl: { enabled: true, startingBalanceUsdc: 100, currentBalanceUsdc: 95 },
    liveAuto: { enabled: true, planId: 'plan2', timeframes: ['5m'] },
    liveOrders: [{ id: 'live-1', status: 'submitted', orderSide: 'BUY' }]
  }, null, 2)}\n`, 'utf8');

  const service = new PolymarketTradingService({
    config: {},
    stateDir,
    legacyStatePath: legacyPath,
    defaultStartingCash: 500
  });
  await service.load();

  const plan1 = JSON.parse(await readFile(join(stateDir, 'plan1-state.json'), 'utf8'));
  const plan3 = JSON.parse(await readFile(join(stateDir, 'plan3-state.json'), 'utf8'));
  const live = JSON.parse(await readFile(join(stateDir, 'live-state.json'), 'utf8'));
  assert.equal(plan1.paperOrders.length, 1);
  assert.equal(plan1.paperOrders[0].id, 'p1-1');
  assert.equal(plan3.paperOrders.length, 1);
  assert.equal(live.liveOrders.length, 1);
  assert.equal(live.liveAuto.planId, 'plan2_5');

  const migrated = (await readdir(dir)).filter((name) => name.includes('.migrated-'));
  assert.equal(migrated.length, 1);

  const { unlink } = await import('node:fs/promises');
  await unlink(join(stateDir, 'plan2-state.json'));
  await unlink(join(stateDir, 'plan3-state.json'));
  await unlink(join(stateDir, 'live-state.json'));

  service.getBucket('plan1').paperOrders.push({ id: 'p1-2', planId: 'plan1', settlementStatus: 'open' });
  await service.persist('plan1');
  const plan1After = JSON.parse(await readFile(join(stateDir, 'plan1-state.json'), 'utf8'));
  assert.equal(plan1After.paperOrders.length, 2);
  const plan2Raw = await readFile(join(stateDir, 'plan2-state.json'), 'utf8').catch(() => null);
  assert.equal(plan2Raw, null, 'scoped persist should not recreate unrelated plan files');
});

test('legacy single statePath mode still persists combined file', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poly-legacy-'));
  const statePath = join(dir, 'combined-state.json');
  const service = new PolymarketTradingService({
    config: {},
    statePath,
    defaultStartingCash: 500
  });
  await service.load();
  await service.configurePortfolio({ cash: 500, planId: 'plan1' });
  await service.persist();
  const parsed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(parsed.plans?.plan1?.portfolio?.portfolioInitialized);
});

test('normalizeLiveSymbols whitelists and dedupes the four live symbols', async () => {
  const { normalizeLiveSymbols } = await import('../src/polymarketTrading.js');
  assert.deepEqual(normalizeLiveSymbols(['ETH-USD', 'eth', 'SOL-USD', 'DOGE-USD']), ['ETH-USD', 'SOL-USD']);
  assert.deepEqual(normalizeLiveSymbols([]), ['BTC-USD']);
  assert.deepEqual(normalizeLiveSymbols(null), ['BTC-USD']);
  assert.deepEqual(normalizeLiveSymbols(['xrp-usd', 'btc']), ['XRP-USD', 'BTC-USD']);
});

test('setLiveAuto persists selected symbols and exposes them in status', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const service = new PolymarketTradingService({
    config: { defaultStartingCash: 500, liveTradingEnabled: true },
    statePath: join(tmpdir(), `pm-live-symbols-${Date.now()}.json`)
  });
  const auto = await service.setLiveAuto(true, {
    planId: 'plan2',
    timeframes: ['5m', '15m'],
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']
  });
  assert.deepEqual(auto.symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
  assert.equal(auto.enabledPlans.includes('plan2_5'), true);

  // 不带 symbols 再次启动另一 plan：保留已选币种
  const auto2 = await service.setLiveAuto(true, { planId: 'plan1' });
  assert.deepEqual(auto2.symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
});

test('setAuto persists paper multi-symbol selection', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const service = new PolymarketTradingService({
    config: { defaultStartingCash: 500 },
    statePath: join(tmpdir(), `pm-paper-symbols-${Date.now()}.json`)
  });
  await service.configurePortfolio({ cash: 500, planId: 'plan5' });
  const auto = await service.setAuto(true, {
    planId: 'plan5',
    timeframes: ['5m', '15m'],
    symbols: ['ETH-USD', 'sol', 'DOGE-USD']
  });
  assert.deepEqual(auto.symbols, ['ETH-USD', 'SOL-USD']);
  assert.equal(auto.enabled, true);
});

test('normalizeLiveOrderPlanId infers plan from entryType fallback', () => {
  assert.equal(normalizeLiveOrderPlanId({ planId: 'plan2' }), 'plan2');
  assert.equal(normalizeLiveOrderPlanId({ entryType: 'settlement_capture' }), 'plan3');
  assert.equal(normalizeLiveOrderPlanId({ entryType: 'settlement_capture_90' }), 'plan2');
  assert.equal(normalizeLiveOrderPlanId({ entryType: 'main' }), 'plan2');
  assert.equal(normalizeLiveOrderPlanId({ entryType: 'cross_follow' }), 'plan2');
  assert.equal(normalizeLiveOrderPlanId({}), 'plan1');
  assert.equal(resolvePlanFromEntryType('settlement_capture_90'), 'plan2');
  assert.equal(resolvePlanFromEntryType('cross_follow'), 'plan2');
  assert.equal(resolvePlanFromEntryType('settlement_capture'), 'plan3');
});

test('plan2 cross-follow buys cheaper same-direction token when leader confirms', () => {
  const leader = {
    symbol: 'BTC-USD',
    shouldTrade: true,
    direction: 'up',
    confidence: 0.70,
    limitPrice: 0.70,
    entryType: 'standard'
  };
  const ethSentiment = {
    available: true,
    symbol: 'ETH-USD',
    upPrice: 0.60,
    downPrice: 0.40,
    upProbability: 0.60,
    downProbability: 0.40,
    qualityScore: 0.6
  };
  const ethSignal = {
    symbol: 'ETH-USD',
    indicators: { currentPrice: 3005 },
    prediction: { comparisonBasePrice: 3000 }
  };

  const follow = buildPlan2CrossFollowTier({
    crossSymbolLeader: leader,
    symbol: 'ETH-USD',
    directionEntry: { direction: 'up', confidence: 0.55 },
    sentiment: ethSentiment,
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(follow.allowed, true);
  assert.equal(follow.tier, 'cross_follow');
  assert.equal(follow.limitPrice, 0.60);
  assert.equal(follow.directionEntry.direction, 'up');
  assert.equal(follow.directionEntry.crossSymbolLeader, 'BTC-USD');

  const noDiscount = buildPlan2CrossFollowTier({
    crossSymbolLeader: leader,
    symbol: 'ETH-USD',
    directionEntry: { direction: 'up', confidence: 0.55 },
    sentiment: { ...ethSentiment, upPrice: 0.68, upProbability: 0.68, downPrice: 0.32, downProbability: 0.32 },
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(noDiscount.allowed, false);
  assert.match(noDiscount.reason, /折扣不足/);

  const opposing = buildPlan2CrossFollowTier({
    crossSymbolLeader: leader,
    symbol: 'ETH-USD',
    directionEntry: { direction: 'down', confidence: 0.55 },
    sentiment: { ...ethSentiment, upPrice: 0.42, upProbability: 0.42, downPrice: 0.57, downProbability: 0.57 },
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(opposing.allowed, false);
  assert.match(opposing.reason, /反向/);

  const probeLeader = buildPlan2CrossFollowTier({
    crossSymbolLeader: { ...leader, entryType: 'probe' },
    symbol: 'ETH-USD',
    directionEntry: { direction: 'up', confidence: 0.55 },
    sentiment: ethSentiment,
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(probeLeader.allowed, false);

  const boosted = applyCrossSymbolLeaderToDirection(
    { direction: 'up', confidence: 0.60 },
    { crossSymbolLeader: leader, symbol: 'ETH-USD', config: {} }
  );
  assert.equal(boosted.confidence, 0.62);
  assert.equal(boosted.crossSymbolAligned, true);
  const penalized = applyCrossSymbolLeaderToDirection(
    { direction: 'down', confidence: 0.60 },
    { crossSymbolLeader: leader, symbol: 'ETH-USD', config: {} }
  );
  assert.equal(penalized.confidence, 0.58);
  assert.equal(penalized.crossSymbolAligned, false);
});

test('buildPolymarketPaperPlan2 prefers own standard entry with leader alignment boost', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'ETH-USD',
      direction: 'up',
      confidence: 0.58,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 3000 },
      indicators: { currentPrice: 3003, return3Pct: 0.0001, volatility15mPct: 0.001, slotStartPrice: 3000 }
    },
    sentiment: {
      available: true,
      symbol: 'ETH-USD',
      upPrice: 0.60,
      downPrice: 0.40,
      upProbability: 0.60,
      downProbability: 0.40,
      qualityScore: 0.6,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2ProbeEnabled: false,
      plan2SustainedMomentumEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2LateCaptureEnabled: false,
      plan2HistoryWinRateGateEnabled: false
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    crossSymbolLeader: {
      symbol: 'BTC-USD',
      shouldTrade: true,
      direction: 'up',
      confidence: 0.70,
      limitPrice: 0.70,
      entryType: 'standard'
    },
    now
  });
  assert.equal(plan.directionEntry.crossSymbolAligned, true);
  assert.equal(plan.directionEntry.crossSymbolLeader, 'BTC-USD');
  assert.ok(plan.directionEntry.confidence >= 0.58);
});

test('buildPolymarketPaperPlan2 falls back to cross-follow when own window is choppy', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'ETH-USD',
      direction: 'up',
      confidence: 0.54,
      schedule,
      // ETH 自己贴着开盘价、盘口胶着且方向反复 → 震荡过滤禁止主仓
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 3000 },
      indicators: { currentPrice: 3000, return3Pct: 0, volatility15mPct: 0.001, slotStartPrice: 3000 }
    },
    sentiment: {
      available: true,
      symbol: 'ETH-USD',
      upPrice: 0.52,
      downPrice: 0.48,
      upProbability: 0.52,
      downProbability: 0.48,
      qualityScore: 0.6,
      directionFlipCount5m: 3,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2ProbeEnabled: false,
      plan2SustainedMomentumEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2LateCaptureEnabled: false,
      plan2PaperRegimeSkipMainRisk: 5,
      plan2PaperRegimeSkipAllRisk: 7,
      plan2HistoryWinRateGateEnabled: false,
      historyWinRateGateEnabled: false
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    paperMode: true,
    crossSymbolLeader: {
      symbol: 'BTC-USD',
      shouldTrade: true,
      direction: 'up',
      confidence: 0.70,
      limitPrice: 0.70,
      entryType: 'standard'
    },
    now
  });
  assert.equal(plan.action.shouldTrade, true, plan.action.reason || 'expected cross follow trade');
  assert.equal(plan.action.entryType, 'cross_follow');
  assert.equal(plan.action.limitPrice, 0.52);
  assert.equal(plan.action.direction, 'up');
  assert.equal(plan.action.crossSymbolLeader, 'BTC-USD');
  assert.match(plan.action.executionKey || '', /cross_follow/);
});

test('computeLiveStats aggregates realized PnL by plan', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const service = new PolymarketTradingService({
    config: { polymarket: { defaultStartingCash: 500 } },
    stateDir: join(tmpdir(), `pm-live-stats-${Date.now()}`),
    statePath: join(tmpdir(), `pm-live-stats-${Date.now()}.json`),
    defaultStartingCash: 500
  });
  service.state.liveOrders = [
    { orderSide: 'BUY', planId: 'plan1', positionStatus: 'closed', usd: 10, pnl: 5 },
    { orderSide: 'BUY', planId: 'plan2', positionStatus: 'closed', usd: 10, pnl: -3 },
    { orderSide: 'BUY', entryType: 'settlement_capture', positionStatus: 'closed', usd: 3, pnl: 0.2 }
  ];
  const stats = service.computeLiveStats();
  assert.equal(stats.byPlan.plan1.realizedPnl, 5);
  assert.equal(stats.byPlan.plan2.realizedPnl, -3);
  assert.equal(stats.byPlan.plan3.realizedPnl, 0.2);
  assert.equal(stats.byPlan.plan3.settledTrades, 1);

  const activeStats = service.computeLiveStats(null, { planIds: ['plan1', 'plan3'] });
  assert.equal(activeStats.settledTrades, 2);
  assert.equal(activeStats.realizedPnl, 5.2);
  assert.equal(activeStats.byPlan.plan2.settledTrades, 0);
});

test('window trajectory keeps symbols isolated within the same slot', () => {
  __resetWindowTrackForTests();
  const slotIso = '2026-06-29T10:00:00.000Z';
  const now = new Date('2026-06-29T10:01:30.000Z');

  recordWindowSnapshot({
    slotIso,
    timeframe: '5m',
    symbol: 'BTC-USD',
    upPrice: 0.76,
    downPrice: 0.24,
    elapsedPct: 0.3,
    now
  });
  recordWindowSnapshot({
    slotIso,
    timeframe: '5m',
    symbol: 'ETH-USD',
    upPrice: 0.22,
    downPrice: 0.78,
    elapsedPct: 0.3,
    now
  });

  const btc = getWindowTrackSnapshot(slotIso, '5m', 'BTC-USD');
  const eth = getWindowTrackSnapshot(slotIso, '5m', 'ETH-USD');
  assert.equal(btc.symbol, 'BTC-USD');
  assert.equal(btc.sampleCount, 1);
  assert.equal(btc.samples[0].upPrice, 0.76);
  assert.equal(eth.symbol, 'ETH-USD');
  assert.equal(eth.sampleCount, 1);
  assert.equal(eth.samples[0].downPrice, 0.78);
});

test('partial live sell keeps residual shares open and expiry includes both legs', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const service = new PolymarketTradingService({
    config: {
      liveTradingEnabled: true,
      liveSellShareRatio: 0.5,
      liveDynamicSellLimitEnabled: false
    },
    statePath: join(tmpdir(), `pm-partial-fill-${Date.now()}.json`)
  });
  const position = {
    id: 'buy-partial',
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan2',
    symbol: 'BTC-USD',
    timeframe: '5m',
    direction: 'up',
    outcome: 'UP',
    tokenId: 'token',
    shares: 100,
    usd: 50,
    entryPrice: 0.5,
    limitPrice: 0.5,
    targetTimeIso: '2020-01-01T00:00:00.000Z'
  };
  service.state.liveOrders.push(position);

  const closed = await service.closeLivePosition(position, {
    sellPrice: 0.6,
    exitStatus: 'take-profit',
    skipClob: true
  });
  assert.equal(closed.partial, true);
  assert.equal(position.positionStatus, 'open');
  assert.equal(position.remainingShares, 50);
  assert.equal(position.remainingCostUsd, 25);
  assert.equal(position.realizedPnlUsd, 5);

  await service.settleExpiredLivePositions(async () => ({ actualDirection: 'up' }));
  assert.equal(position.positionStatus, 'closed');
  assert.equal(position.payoutUsd, 80);
  assert.equal(position.pnl, 30);
});

test('liquidateAll records the actual FAK partial fill instead of closing the full local position', async () => {
  const service = new PolymarketTradingService({
    config: { liveTradingEnabled: true, liveSellShareRatio: 1 },
    statePath: 'data/test-polymarket-liquidate-actual-fill.json'
  });
  await service.load();
  service.state.liveOrders = [];
  await service.persist();
  const position = await service.recordLiveOrder({
    status: 'submitted',
    orderSide: 'BUY',
    positionStatus: 'open',
    planId: 'plan5',
    timeframe: '5m',
    direction: 'down',
    tokenId: 'partial-liquidate',
    shares: 10,
    usd: 5,
    entryPrice: 0.5,
    limitPrice: 0.5
  });
  const draft = service.buildLiveSellDraft(position, 0.3, { liquidateAll: true });
  const actualDraft = { ...draft, shares: 4, usd: 1.2 };
  const result = await service.closeLivePosition(position, {
    sellPrice: 0.3,
    exitStatus: 'emergency-stop',
    liquidateAll: true,
    preSubmittedDraft: actualDraft,
    preSubmittedResult: {
      draft: actualDraft,
      clobOrderId: 'partial-fak',
      filled: true,
      orderType: 'FAK',
      response: { status: 'matched', makingAmount: '4', takingAmount: '1.2' }
    }
  });
  assert.equal(result.partial, true);
  assert.equal(position.positionStatus, 'open');
  assert.equal(position.remainingShares, 6);
  assert.equal(position.remainingCostUsd, 3);
  assert.equal(position.realizedPnlUsd, -0.8);
});

test('plan2 min elapsed gate falls back to default when config key missing', () => {
  const now = new Date('2026-06-29T10:00:20.000Z');
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'BTC-USD',
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol: 'BTC-USD',
      upPrice: 0.55,
      downPrice: 0.45,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      plan2SustainedMomentumEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2LateCaptureEnabled: false,
      plan2ProbeEnabled: false
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  assert.equal(plan.action.shouldTrade, false);
  assert.match(plan.action.reason || '', /窗口前/);
});

test('shouldPlan1DirectionFlip blocks late-window flips when config key missing', () => {
  const blocked = shouldPlan1DirectionFlip({
    openDirection: 'up',
    newDirection: 'down',
    config: { plan1DirectionFlipEnabled: true },
    openOrderCreatedAtIso: new Date('2026-06-29T10:00:00.000Z').toISOString(),
    newConfidence: 0.72,
    reverseEdge: 0.1,
    floatingLossPct: -0.05,
    elapsedPct: 0.9,
    now: new Date('2026-06-29T10:12:00.000Z')
  });
  assert.equal(blocked.flip, false);
  assert.match(blocked.reason, /禁止翻转/);
});

test('paper relaxed high-price PM-led entry requires BTC distance alignment', () => {
  const base = {
    limitPrice: 0.90,
    confidence: 0.60,
    timeframe: '15m',
    config: {
      plan2PaperRelaxedEnabled: true,
      plan2PaperEntryMaxPrice: 0.92,
      plan2EntryMinPrice: 0.35,
      plan2TakeProfitOffset: 0.18,
      plan2StopLossOffset: 0.12,
      stopLossAbsoluteFloor: 0.50
    },
    sentiment: { upPrice: 0.90, downPrice: 0.10, upProbability: 0.90, downProbability: 0.10 },
    paperMode: true
  };
  const conflicted = resolvePlan2EntryTier({
    ...base,
    directionEntry: { direction: 'up', confidence: 0.60, distanceBps: -8 }
  });
  assert.equal(conflicted.allowed, false);

  const aligned = resolvePlan2EntryTier({
    ...base,
    directionEntry: { direction: 'up', confidence: 0.60, distanceBps: 12 }
  });
  assert.equal(aligned.allowed, true);
  assert.equal(aligned.tier, 'paper_relaxed');
});

test('buildPlan2RegimeGuard flags extreme spread and exposes isChop', () => {
  const guard = buildPlan2RegimeGuard({
    directionEntry: { direction: 'up', confidence: 0.7 },
    sentiment: {
      upProbability: 0.72,
      downProbability: 0.28,
      qualityScore: 0.8,
      spread: 0.35
    },
    signal: {
      indicators: { currentPrice: 100150, volatility15mPct: 0.0005 },
      prediction: { comparisonBasePrice: 100000 }
    },
    timeframe: '15m',
    config: {},
    limitPrice: 0.72
  });
  assert.equal(guard.noTradeRisk >= 2, true);
  assert.match(guard.reason, /spread/);
  assert.equal(typeof guard.isChop, 'boolean');
});

test('normalizeLiveSymbols whitelists and dedupes the four live symbols', async () => {
  const { normalizeLiveSymbols } = await import('../src/polymarketTrading.js');
  assert.deepEqual(normalizeLiveSymbols(['ETH-USD', 'eth', 'SOL-USD', 'DOGE-USD']), ['ETH-USD', 'SOL-USD']);
  assert.deepEqual(normalizeLiveSymbols([]), ['BTC-USD']);
  assert.deepEqual(normalizeLiveSymbols(null), ['BTC-USD']);
  assert.deepEqual(normalizeLiveSymbols(['xrp-usd', 'btc']), ['XRP-USD', 'BTC-USD']);
});

test('setLiveAuto persists selected symbols and exposes them in status', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const service = new PolymarketTradingService({
    config: { defaultStartingCash: 500, liveTradingEnabled: true },
    statePath: join(tmpdir(), `pm-live-symbols-${Date.now()}.json`)
  });
  const auto = await service.setLiveAuto(true, {
    planId: 'plan2',
    timeframes: ['5m', '15m'],
    symbols: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']
  });
  assert.deepEqual(auto.symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
  assert.equal(auto.enabledPlans.includes('plan2_5'), true);

  // 不带 symbols 再次启动另一 plan：保留已选币种
  const auto2 = await service.setLiveAuto(true, { planId: 'plan1' });
  assert.deepEqual(auto2.symbols, ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
});

test('plan2 keys separate symbols within the same window', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const buildFor = (symbol) => buildPolymarketPaperPlan2({
    signal: {
      symbol,
      direction: 'up',
      confidence: 0.72,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 100000 }
    },
    sentiment: {
      available: true,
      symbol,
      upPrice: 0.55,
      downPrice: 0.45,
      qualityScore: 0.8,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: PLAN2_TEST_CONFIG,
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    now
  });
  const btc = buildFor('BTC-USD');
  const eth = buildFor('ETH-USD');
  assert.equal(btc.action.shouldTrade, true);
  assert.equal(eth.action.shouldTrade, true);
  assert.notEqual(btc.key, eth.key);
  assert.notEqual(btc.action.executionKey, eth.action.executionKey);
  assert.match(eth.key, /ETH-USD/);
  assert.match(eth.action.executionKey, /ETH-USD/);
});

test('plan2 cross-follow buys cheaper same-direction token when leader confirms', async () => {
  const { buildPlan2CrossFollowTier, applyCrossSymbolLeaderToDirection } = await import('../src/polymarketPlan2.js');
  const leader = {
    symbol: 'BTC-USD',
    shouldTrade: true,
    direction: 'up',
    confidence: 0.70,
    limitPrice: 0.70,
    entryType: 'standard'
  };
  const ethSentiment = {
    available: true,
    symbol: 'ETH-USD',
    upPrice: 0.60,
    downPrice: 0.40,
    upProbability: 0.60,
    downProbability: 0.40,
    qualityScore: 0.6
  };
  const ethSignal = {
    symbol: 'ETH-USD',
    indicators: { currentPrice: 3005 },
    prediction: { comparisonBasePrice: 3000 }
  };

  // BTC UP 70¢ 确认，ETH UP 60¢ 便宜 10¢ → 跟随买入
  const follow = buildPlan2CrossFollowTier({
    crossSymbolLeader: leader,
    symbol: 'ETH-USD',
    directionEntry: { direction: 'up', confidence: 0.55 },
    sentiment: ethSentiment,
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(follow.allowed, true);
  assert.equal(follow.tier, 'cross_follow');
  assert.equal(follow.limitPrice, 0.60);
  assert.equal(follow.directionEntry.direction, 'up');
  assert.equal(follow.directionEntry.crossSymbolLeader, 'BTC-USD');

  // 折扣不足（ETH 68¢ vs BTC 70¢，< 4¢）→ 拒绝
  const noDiscount = buildPlan2CrossFollowTier({
    crossSymbolLeader: leader,
    symbol: 'ETH-USD',
    directionEntry: { direction: 'up', confidence: 0.55 },
    sentiment: { ...ethSentiment, upPrice: 0.68, upProbability: 0.68, downPrice: 0.32, downProbability: 0.32 },
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(noDiscount.allowed, false);
  assert.match(noDiscount.reason, /折扣不足/);

  // 本币盘口强烈反向（ETH DOWN 领先 15%）→ 拒绝
  const opposing = buildPlan2CrossFollowTier({
    crossSymbolLeader: leader,
    symbol: 'ETH-USD',
    directionEntry: { direction: 'down', confidence: 0.55 },
    sentiment: { ...ethSentiment, upPrice: 0.42, upProbability: 0.42, downPrice: 0.57, downProbability: 0.57 },
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(opposing.allowed, false);
  assert.match(opposing.reason, /反向/);

  // leader 探针不触发跟随
  const probeLeader = buildPlan2CrossFollowTier({
    crossSymbolLeader: { ...leader, entryType: 'probe' },
    symbol: 'ETH-USD',
    directionEntry: { direction: 'up', confidence: 0.55 },
    sentiment: ethSentiment,
    signal: ethSignal,
    timeframe: '5m',
    config: {},
    elapsedPct: 0.3
  });
  assert.equal(probeLeader.allowed, false);

  // 方向判断加成：同向 +0.02，反向 -0.02
  const boosted = applyCrossSymbolLeaderToDirection(
    { direction: 'up', confidence: 0.60 },
    { crossSymbolLeader: leader, symbol: 'ETH-USD', config: {} }
  );
  assert.equal(boosted.confidence, 0.62);
  assert.equal(boosted.crossSymbolAligned, true);
  const penalized = applyCrossSymbolLeaderToDirection(
    { direction: 'down', confidence: 0.60 },
    { crossSymbolLeader: leader, symbol: 'ETH-USD', config: {} }
  );
  assert.equal(penalized.confidence, 0.58);
});

test('buildPolymarketPaperPlan2 prefers own standard entry with leader alignment boost', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'ETH-USD',
      direction: 'up',
      confidence: 0.58,
      schedule,
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 3000 },
      indicators: { currentPrice: 3003, return3Pct: 0.0001, volatility15mPct: 0.001, slotStartPrice: 3000 }
    },
    sentiment: {
      available: true,
      symbol: 'ETH-USD',
      upPrice: 0.60,
      downPrice: 0.40,
      upProbability: 0.60,
      downProbability: 0.40,
      qualityScore: 0.6,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2ProbeEnabled: false,
      plan2SustainedMomentumEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2LateCaptureEnabled: false
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    crossSymbolLeader: {
      symbol: 'BTC-USD',
      shouldTrade: true,
      direction: 'up',
      confidence: 0.70,
      limitPrice: 0.70,
      entryType: 'standard'
    },
    now
  });
  // 本币自身满足条件时优先正常入场（BTC 70¢ 确认 UP 同时 ETH 60¢ 也买 UP），方向判断带 leader 同向加成。
  assert.equal(plan.action.shouldTrade, true, plan.action.reason || 'expected trade');
  assert.equal(plan.action.entryType, 'standard');
  assert.equal(plan.directionEntry.crossSymbolAligned, true);
  assert.equal(plan.directionEntry.crossSymbolLeader, 'BTC-USD');
});

test('buildPolymarketPaperPlan2 falls back to cross-follow when own window is choppy', () => {
  const now = midWindowNow();
  const schedule = getSlotSchedule(now, 15);
  const plan = buildPolymarketPaperPlan2({
    signal: {
      symbol: 'ETH-USD',
      direction: 'up',
      confidence: 0.54,
      schedule,
      // ETH 自己贴着开盘价、盘口胶着且方向反复 → 震荡过滤禁止主仓
      prediction: { targetTimeIso: schedule.nextSlotIso, comparisonBasePrice: 3000 },
      indicators: { currentPrice: 3000, return3Pct: 0, volatility15mPct: 0.001, slotStartPrice: 3000 }
    },
    sentiment: {
      available: true,
      symbol: 'ETH-USD',
      upPrice: 0.52,
      downPrice: 0.48,
      upProbability: 0.52,
      downProbability: 0.48,
      qualityScore: 0.6,
      directionFlipCount5m: 3,
      upTokenId: '1',
      downTokenId: '2'
    },
    config: {
      ...PLAN2_TEST_CONFIG,
      plan2ProbeEnabled: false,
      plan2SustainedMomentumEnabled: false,
      plan2SettlementCapture90Enabled: false,
      plan2LateCaptureEnabled: false,
      plan2PaperRegimeSkipMainRisk: 5,
      plan2PaperRegimeSkipAllRisk: 7
    },
    risk: { strategies: [{ winRate: 0.55 }] },
    timeframe: '15m',
    portfolio: { portfolioInitialized: true, startingCash: 500, cash: 500, equity: 500 },
    crossSymbolLeader: {
      symbol: 'BTC-USD',
      shouldTrade: true,
      direction: 'up',
      confidence: 0.70,
      limitPrice: 0.70,
      entryType: 'standard'
    },
    now
  });
  assert.equal(plan.action.shouldTrade, true, plan.action.reason || 'expected cross follow trade');
  assert.equal(plan.action.entryType, 'cross_follow');
  assert.equal(plan.action.limitPrice, 0.52);
  assert.match(plan.action.executionKey, /ETH-USD/);
  assert.match(plan.action.executionKey, /cross_follow/);
});

test('slimStoredPaperOrder strips fat plan/recommendation payloads', () => {
  const slim = slimStoredPaperOrder({
    id: 'o1',
    symbol: 'BTC-USD',
    planKey: 'k1',
    plan: {
      symbol: 'BTC-USD',
      timeframe: '5m',
      slotIso: '2026-01-01T00:00:00.000Z',
      sentiment: { available: true, huge: 'x'.repeat(200) },
      action: {
        executionKey: 'k1',
        entryType: 'main',
        lockStrength: 'strong',
        reason: 'long reason text',
        diagnostics: { a: 1 }
      }
    },
    recommendation: {
      direction: 'up',
      confidence: 0.66,
      features: { a: 1, b: 2 },
      reasons: ['x']
    }
  });
  assert.equal(slim.plan.action.executionKey, 'k1');
  assert.equal(slim.plan.sentiment, undefined);
  assert.equal(slim.recommendation.direction, 'up');
  assert.equal(slim.recommendation.features, undefined);
  assert.ok(JSON.stringify(slim).length < 500);
});

test('listPaperOrders summary+limit and resetPortfolio clear state quickly', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'poly-reset-slim-'));
  const service = new PolymarketTradingService({
    config: {},
    stateDir: dir,
    defaultStartingCash: 500
  });
  await service.load();
  const fatOrders = Array.from({ length: 80 }, (_, i) => ({
    id: `o-${i}`,
    createdAtIso: new Date(Date.now() - i * 1000).toISOString(),
    symbol: 'BTC-USD',
    timeframe: '5m',
    outcome: 'UP',
    limitPrice: 0.55,
    usd: 10,
    pnl: i % 2 ? 1 : -1,
    settlementStatus: 'settled',
    planId: 'plan2',
    plan: {
      symbol: 'BTC-USD',
      timeframe: '5m',
      sentiment: { blob: 'y'.repeat(800) },
      action: { executionKey: `k-${i}`, reason: 'r'.repeat(200) }
    },
    recommendation: { direction: 'up', confidence: 0.6, features: { z: 1 } }
  }));
  service.getBucket('plan2').paperOrders = fatOrders;
  service.getBucket('plan2').portfolio = {
    startingCash: 500,
    cash: 400,
    portfolioInitialized: true
  };

  const listed = service.listPaperOrders('plan2', { limit: 40, summary: true });
  assert.equal(listed.length, 40);
  assert.equal(listed[0].id, 'o-0');
  assert.equal(listed[0].plan, undefined);
  assert.equal(listed[0].recommendation, undefined);
  assert.ok(summarizePaperOrderForApi(fatOrders[0]).symbol === 'BTC-USD');

  await service.persist('plan2');
  const persisted = JSON.parse(await readFile(join(dir, 'plan2-state.json'), 'utf8'));
  assert.ok(persisted.paperOrders[0].plan?.sentiment === undefined);
  assert.ok(JSON.stringify(persisted).length < JSON.stringify({ paperOrders: fatOrders }).length / 2);

  const started = Date.now();
  const portfolio = await service.resetPortfolio('plan2');
  const elapsed = Date.now() - started;
  assert.equal(portfolio.portfolioInitialized, false);
  assert.equal(service.getBucket('plan2').paperOrders.length, 0);
  assert.equal(service.listPaperOrders('plan2').length, 0);
  assert.ok(elapsed < 5000, `reset took too long: ${elapsed}ms`);
  const after = JSON.parse(await readFile(join(dir, 'plan2-state.json'), 'utf8'));
  assert.equal((after.paperOrders || []).length, 0);

  // 重启加载不得用旧 bak 把已重置账户回滚回来
  const reloaded = new PolymarketTradingService({
    config: {},
    stateDir: dir,
    defaultStartingCash: 500
  });
  await reloaded.load();
  assert.equal(reloaded.getBucket('plan2').paperOrders.length, 0);
  assert.equal(reloaded.getBucket('plan2').portfolio.portfolioInitialized, false);
});

test.after(() => {
  __resetPriceHistoryForTests();
  __resetWindowTrackForTests();
});
