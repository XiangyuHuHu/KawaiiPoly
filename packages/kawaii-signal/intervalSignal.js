import { ema, rsi } from './strategy.js';

const SLOT_MINUTES = 15;

export function getIntervalSchedule(now = new Date()) {
  const current = new Date(now);
  current.setSeconds(0, 0);
  const minute = current.getMinutes();
  const slotMinute = Math.floor(minute / SLOT_MINUTES) * SLOT_MINUTES;

  const slot = new Date(current);
  slot.setMinutes(slotMinute, 0, 0);

  const next = new Date(slot);
  next.setMinutes(slot.getMinutes() + SLOT_MINUTES, 0, 0);

  return {
    slotMinutes: SLOT_MINUTES,
    currentSlotIso: slot.toISOString(),
    nextSlotIso: next.toISOString(),
    secondsToNext: Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000)),
    isDecisionMinute: minute % SLOT_MINUTES === 0
  };
}

export function buildIntervalSignal({ symbol, candles, currentPrice, currentQuoteTime, now = new Date() }) {
  const schedule = getIntervalSchedule(now);
  const slotTime = Date.parse(schedule.currentSlotIso);
  const closedCandles = (candles || [])
    .filter((candle) => Number(candle.time) * 1000 < slotTime)
    .filter((candle) => Number.isFinite(Number(candle.close)) && Number(candle.close) > 0);

  if (closedCandles.length < 35) {
    return {
      symbol,
      direction: 'wait',
      label: '\u7b49\u5f85',
      confidence: 0,
      reason: `Need at least 35 closed 15m candles; received ${closedCandles.length}.`,
      schedule
    };
  }

  const livePrice = Number(currentPrice);
  const hasLivePrice = Number.isFinite(livePrice) && livePrice > 0;
  const closes = closedCandles.map((candle) => Number(candle.close));
  if (hasLivePrice) closes.push(livePrice);

  const last = closes.at(-1);
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  const lastFast = fast.at(-1);
  const prevFast = fast.at(-2);
  const lastSlow = slow.at(-1);
  const prevSlow = slow.at(-2);
  const rsiValue = rsi(closes, 14);
  const returns3 = last / closes.at(-4) - 1;
  const returns6 = last / closes.at(-7) - 1;
  const sigma = returnStdev(closes, Math.min(32, closes.length - 1));
  const latestClosedCandle = closedCandles.at(-1);
  const slotStartPrice = Number(latestClosedCandle.close);
  const previousClosedCandleMovePct = Number(latestClosedCandle.close) / Number(latestClosedCandle.open) - 1;
  const recentClosedCandleMovesPct = closedCandles.slice(-6).map((candle) => (
    Number(candle.close) / Number(candle.open) - 1
  ));
  const bodyPct = hasLivePrice
    ? (livePrice - slotStartPrice) / slotStartPrice
    : (Number(latestClosedCandle.close) - Number(latestClosedCandle.open)) / Number(latestClosedCandle.open);
  const elapsedPct = Math.min(1, Math.max(0, 1 - schedule.secondsToNext / (SLOT_MINUTES * 60)));

  const trendScore = (lastFast - lastSlow) / lastSlow;
  const slopeScore = (lastFast - prevFast) / prevFast - (lastSlow - prevSlow) / prevSlow;
  const rsiScore = (rsiValue - 50) / 100;
  const rawScore = trendScore * 8 + slopeScore * 18 + returns3 * 2.4 + returns6 * 1.2 + bodyPct * 1.8 + rsiScore * 0.45;
  const predictedMovePct = estimateNextMovePct({
    trendScore,
    slopeScore,
    returns3,
    returns6,
    bodyPct,
    rsiValue,
    sigma
  });

  const remainingScale = Math.sqrt(Math.max(0.08, 1 - elapsedPct));
  const estimatedClose = last * (1 + predictedMovePct * remainingScale);
  const rangePct = Math.max(sigma * 0.8 * remainingScale, 0.0005);
  const estimatedMovePctToTarget = estimatedClose / slotStartPrice - 1;
  const probabilities = estimateDirectionProbabilities(estimatedMovePctToTarget, rangePct);
  const direction = probabilities.up >= probabilities.down ? 'up' : 'down';
  const confidence = Math.max(probabilities.up, probabilities.down);

  return buildIntervalSignalResult({
    symbol,
    direction,
    confidence,
    probabilities,
    rawScore,
    estimatedMovePctToTarget,
    estimatedClose,
    rangePct,
    slotStartPrice,
    schedule,
    trendScore,
    returns3,
    rsiValue,
    indicators: {
      lastClose: last,
      currentPrice: hasLivePrice ? livePrice : null,
      currentQuoteTimeIso: currentQuoteTime || null,
      elapsedInCurrentSlotPct: elapsedPct,
      ema8: lastFast,
      ema21: lastSlow,
      rsi14: rsiValue,
      return3Pct: returns3,
      return6Pct: returns6,
      volatility15mPct: sigma,
      lastCandleBodyPct: bodyPct,
      previousClosedCandleMovePct,
      recentClosedCandleMovesPct,
      slotStartPrice,
      lastClosedCandleIso: new Date(Number(latestClosedCandle.time) * 1000).toISOString()
    }
  });
}

export function blendWithPolymarketSentiment(signal, sentiment) {
  if (!sentiment?.available || signal.direction === 'wait') {
    return {
      ...signal,
      polymarket: sentiment || { available: false }
    };
  }

  const polyUp = Number(sentiment.upProbability ?? sentiment.upPrice);
  const polyDown = Number(sentiment.downProbability ?? sentiment.downPrice ?? (Number.isFinite(polyUp) ? 1 - polyUp : 0.5));
  const techDirection = signal.direction;
  const technicalUpProbability = Number(signal.probabilities?.up ?? signal.prediction?.upProbability ?? 0.5);
  const technicalDownProbability = Number(signal.probabilities?.down ?? signal.prediction?.downProbability ?? 0.5);
  const polyDirection = polyUp >= polyDown ? 'up' : 'down';
  const aligned = techDirection === polyDirection;
  const orderbookAligned = sentiment.orderbookBias === techDirection || sentiment.orderbookBias === 'neutral';
  const strongConflict =
    !aligned &&
    ((techDirection === 'up' && sentiment.sentiment === 'bearish' && Number(sentiment.upPriceChange5m) <= -0.02) ||
      (techDirection === 'down' && sentiment.sentiment === 'bullish' && Number(sentiment.upPriceChange5m) >= 0.02));

  let direction = techDirection;
  let label = signal.label;
  let up = Number(signal.probabilities?.up ?? signal.prediction?.upProbability ?? 0.5);
  let down = Number(signal.probabilities?.down ?? signal.prediction?.downProbability ?? 0.5);
  let confidenceBoost = 0;
  let reasonSuffix = buildPolymarketReasonSuffix(sentiment);

  const qualityScore = clamp(Number(sentiment.qualityScore), 0.15, 1, 0.6);
  const timeframe = signal.timeframe || (signal.prediction?.horizonMinutes === 5 ? '5m' : '15m');
  const baseTechWeight = timeframe === '5m' ? 0.32 : 0.46;
  const techWeight = clamp(baseTechWeight + (1 - qualityScore) * 0.35, 0.2, 0.78, baseTechWeight);
  const polyWeight = 1 - techWeight;
  up = clamp(up * techWeight + polyUp * polyWeight, 0.05, 0.95, 0.5);
  down = clamp(down * techWeight + polyDown * polyWeight, 0.05, 0.95, 0.5);
  const sum = Math.max(up + down, 0.000001);
  up /= sum;
  down /= sum;
  direction = up >= down ? 'up' : 'down';
  label = direction === 'up' ? '\u4e0a\u6da8' : '\u4e0b\u8dcc';

  if (strongConflict && !orderbookAligned) {
    up = 0.5;
    down = 0.5;
    direction = 'wait';
    label = '\u7b49\u5f85';
    reasonSuffix += ' \u6280\u672f\u9762\u4e0e Polymarket \u5f3a\u51b2\u7a81\uff0c\u964d\u7ea7\u4e3a\u89c2\u671b\u3002';
  } else if (aligned) {
    confidenceBoost = Math.min(0.08, Number(sentiment.confidenceBoost) || 0);
    const floorConfidence = Math.min(0.92, Number(signal.confidence) + confidenceBoost);
    if (Math.max(up, down) < floorConfidence) {
      if (techDirection === 'up') {
        up = floorConfidence;
        down = 1 - up;
      } else {
        down = floorConfidence;
        up = 1 - down;
      }
      direction = techDirection;
      label = direction === 'up' ? '\u4e0a\u6da8' : '\u4e0b\u8dcc';
    }
    reasonSuffix += ` \u6280\u672f\u9762\u4e0e Polymarket \u540c\u5411\uff0c\u6309\u52a0\u6743\u7efc\u5408\u3002`;
  } else {
    reasonSuffix += ` \u6280\u672f\u9762\u4e0e Polymarket \u4e0d\u540c\u5411\uff0c\u6309\u52a0\u6743\u7efc\u5408\u3002`;
  }

  const confidence = direction === 'wait' ? 0 : Math.max(up, down);
  const polymarketTargetPrice = Number(sentiment.targetPrice);
  const usePolymarketTarget = Number.isFinite(polymarketTargetPrice) && polymarketTargetPrice > 0;
  const spotPrice = Number(signal?.indicators?.currentPrice);
  const fallbackTargetPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  const spotTargetPrice = usePolymarketTarget ? polymarketTargetPrice : fallbackTargetPrice;
  const spotDirection = Number.isFinite(spotPrice) && Number.isFinite(spotTargetPrice) && spotTargetPrice > 0
    ? (spotPrice >= spotTargetPrice ? 'up' : 'down')
    : null;
  const adjustedPrediction = signal.prediction && usePolymarketTarget
    ? {
        ...signal.prediction,
        comparisonBasePrice: round8(polymarketTargetPrice),
        comparisonBasePriceSource: 'polymarket_target',
        technicalComparisonBasePrice: signal.prediction.comparisonBasePrice,
        estimatedMovePct: round6(Number(signal.prediction.estimatedClose) / polymarketTargetPrice - 1),
        upProbability: round4(up),
        downProbability: round4(down)
      }
    : signal.prediction
      ? {
          ...signal.prediction,
          upProbability: round4(up),
          downProbability: round4(down)
        }
    : signal.prediction;
  const targetSourceLabel = sentiment.targetPriceSource === 'chainlink_slot_start_cache'
    ? 'Chainlink 窗口锁定价'
    : sentiment.targetPriceSource === 'polymarket_rtds_chainlink_slot_start_cache'
      ? 'Polymarket RTDS Chainlink 锁定价'
    : 'Polymarket Target';
  const targetReason = usePolymarketTarget
    ? ` ${targetSourceLabel} $${polymarketTargetPrice.toFixed(2)} 已作为本轮开始计算价。`
    : '';

  return {
    ...signal,
    // Preserve independent inputs. Downstream execution must not use the
    // PM-blended direction as evidence that confirms the PM direction.
    technicalDirection: techDirection,
    technicalConfidence: round4(Number(signal.confidence) || 0),
    technicalProbabilities: {
      up: round4(technicalUpProbability),
      down: round4(technicalDownProbability)
    },
    compositeDirection: direction,
    compositeConfidence: round4(confidence),
    compositeProbabilities: {
      up: round4(up),
      down: round4(down)
    },
    spotDirection,
    direction,
    label: direction === 'wait' ? '\u7b49\u5f85' : direction === 'up' ? '\u4e0a\u6da8' : '\u4e0b\u8dcc',
    confidence: round4(confidence),
    probabilities: {
      up: round4(up),
      down: round4(down)
    },
    reason: `${signal.reason}${reasonSuffix}${targetReason}`,
    prediction: adjustedPrediction,
    polymarket: {
      ...sentiment,
      appliedConfidenceBoost: round4(confidenceBoost),
      aligned,
      strongConflict
    }
  };
}

function buildIntervalSignalResult({
  symbol,
  direction,
  confidence,
  probabilities,
  rawScore,
  estimatedMovePctToTarget,
  estimatedClose,
  rangePct,
  slotStartPrice,
  schedule,
  trendScore,
  returns3,
  rsiValue,
  indicators
}) {
  return {
    symbol,
    direction,
    label: direction === 'up' ? '\u4e0a\u6da8' : '\u4e0b\u8dcc',
    confidence: round4(confidence),
    probabilities: {
      up: round4(probabilities.up),
      down: round4(probabilities.down)
    },
    score: round6(estimatedMovePctToTarget),
    modelScore: round6(rawScore),
    reason: buildReason({
      direction,
      comparisonBasePrice: slotStartPrice,
      estimatedClose,
      estimatedMovePct: estimatedMovePctToTarget,
      targetTimeIso: schedule.nextSlotIso,
      rangePct,
      trendScore,
      returns3,
      rsiValue
    }),
    schedule,
    prediction: {
      horizonMinutes: SLOT_MINUTES,
      targetTimeIso: schedule.nextSlotIso,
      comparisonBasePrice: round8(slotStartPrice),
      estimatedClose: round8(estimatedClose),
      estimatedMovePct: round6(estimatedMovePctToTarget),
      upProbability: round4(probabilities.up),
      downProbability: round4(probabilities.down),
      lowEstimate: round8(estimatedClose * (1 - rangePct)),
      highEstimate: round8(estimatedClose * (1 + rangePct)),
      rangePct: round6(rangePct)
    },
    indicators: {
      lastClose: round8(indicators.lastClose),
      currentPrice: indicators.currentPrice != null ? round8(indicators.currentPrice) : null,
      currentQuoteTimeIso: indicators.currentQuoteTimeIso || null,
      elapsedInCurrentSlotPct: round4(indicators.elapsedInCurrentSlotPct),
      ema8: round8(indicators.ema8),
      ema21: round8(indicators.ema21),
      rsi14: round4(indicators.rsi14),
      return3Pct: round6(indicators.return3Pct),
      return6Pct: round6(indicators.return6Pct),
      volatility15mPct: round6(indicators.volatility15mPct),
      lastCandleBodyPct: round6(indicators.lastCandleBodyPct),
      previousClosedCandleMovePct: round6(indicators.previousClosedCandleMovePct),
      recentClosedCandleMovesPct: Array.isArray(indicators.recentClosedCandleMovesPct)
        ? indicators.recentClosedCandleMovesPct.map((value) => round6(value))
        : [],
      slotStartPrice: round8(indicators.slotStartPrice),
      lastClosedCandleIso: indicators.lastClosedCandleIso
    }
  };
}

function buildPolymarketReasonSuffix(sentiment) {
  const upPct = (Number(sentiment.upProbability ?? sentiment.upPrice) * 100).toFixed(0);
  const changePct = (Number(sentiment.upPriceChange5m) * 100).toFixed(1);
  const changeSign = Number(sentiment.upPriceChange5m) >= 0 ? '+' : '';
  const sentimentLabel =
    sentiment.sentiment === 'bullish' ? '\u504f\u591a' : sentiment.sentiment === 'bearish' ? '\u504f\u7a7a' : '\u4e2d\u6027';
  return ` Polymarket UP ${upPct}% (${changeSign}${changePct}pp/5m), \u60c5\u7eea${sentimentLabel}, \u76d8\u53e3\u504f${sentiment.orderbookBias}.`;
}

function estimateDirectionProbabilities(estimatedMovePct, rangePct) {
  const signedSignalToRange = estimatedMovePct / Math.max(rangePct, 0.0001);
  const up = Math.max(0.1, Math.min(0.9, 0.5 + signedSignalToRange * 0.28));
  return {
    up,
    down: 1 - up
  };
}

function estimateNextMovePct({ trendScore, slopeScore, returns3, returns6, bodyPct, rsiValue, sigma }) {
  const meanReversionPenalty = rsiValue > 72 ? -0.18 * sigma : rsiValue < 28 ? 0.18 * sigma : 0;
  const estimate =
    trendScore * 0.28 +
    slopeScore * 0.55 +
    returns3 * 0.34 +
    returns6 * 0.14 +
    bodyPct * 0.22 +
    meanReversionPenalty;
  const cap = Math.max(sigma * 1.35, 0.0012);
  return Math.max(-cap, Math.min(cap, estimate));
}

function returnStdev(closes, lookback) {
  const returns = [];
  const start = Math.max(1, closes.length - lookback);
  for (let index = start; index < closes.length; index += 1) {
    returns.push(Math.log(closes[index] / closes[index - 1]));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

function clamp(value, min, max, fallback = min) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function buildReason({ direction, comparisonBasePrice, estimatedClose, estimatedMovePct, targetTimeIso, rangePct, trendScore, returns3, rsiValue }) {
  const trendText = trendScore >= 0 ? 'EMA8 above EMA21' : 'EMA8 below EMA21';
  const momentumText = returns3 >= 0 ? 'recent 3-candle momentum is positive' : 'recent 3-candle momentum is negative';
  const rsiText = `RSI14 ${rsiValue.toFixed(1)}`;
  const targetTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(targetTimeIso));
  return `${direction === 'up' ? '\u9884\u8ba1\u4e0a\u6da8' : '\u9884\u8ba1\u4e0b\u8dcc'}: ` +
    `\u76ee\u6807\u662f ${targetTime} \u622a\u6b62\u4ef7\u76f8\u5bf9\u672c\u8f6e\u5f00\u59cb\u4ef7 ${comparisonBasePrice.toFixed(2)} \u7684\u53d8\u5316\u3002` +
    `\u9884\u4f30\u622a\u6b62\u4ef7 ${estimatedClose.toFixed(2)} (${(estimatedMovePct * 100).toFixed(2)}%), ` +
    `\u9884\u4f30\u566a\u58f0\u533a\u95f4\u7ea6 +/-${(rangePct * 100).toFixed(2)}%\u3002` +
    `\u53c2\u8003\u6307\u6807: ${trendText}, ${momentumText}, ${rsiText}.`;
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function round8(value) {
  return Math.round(value * 1e8) / 1e8;
}
