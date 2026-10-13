import { ema, rsi } from './strategy.js';
import { getSlotSchedule, timeframeToCandleInterval, timeframeToSlotMinutes } from './polymarketSchedule.js';

export function buildPolymarketIntervalSignal({
  symbol,
  candles,
  currentPrice,
  currentQuoteTime,
  timeframe = '15m',
  now = new Date()
}) {
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const schedule = getSlotSchedule(now, slotMinutes);
  const slotTime = Date.parse(schedule.currentSlotIso);
  const closedCandles = (candles || [])
    .filter((candle) => Number(candle.time) * 1000 < slotTime)
    .filter((candle) => Number.isFinite(Number(candle.close)) && Number(candle.close) > 0);

  const minCandles = timeframe === '5m' ? 30 : timeframe === '1d' ? 20 : 35;
  if (closedCandles.length < minCandles) {
    return unavailableSignal(symbol, schedule, timeframe, `Need at least ${minCandles} closed ${timeframeToCandleInterval(timeframe)} candles; received ${closedCandles.length}.`);
  }

  const livePrice = Number(currentPrice);
  const hasLivePrice = Number.isFinite(livePrice) && livePrice > 0;
  const closes = closedCandles.map((candle) => Number(candle.close));
  if (hasLivePrice) closes.push(livePrice);

  const last = closes.at(-1);
  const fast = ema(closes, timeframe === '5m' ? 6 : 8);
  const slow = ema(closes, timeframe === '5m' ? 14 : 21);
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
  const bodyPct = hasLivePrice
    ? (livePrice - slotStartPrice) / slotStartPrice
    : (Number(latestClosedCandle.close) - Number(latestClosedCandle.open)) / Number(latestClosedCandle.open);
  const elapsedPct = Math.min(1, Math.max(0, 1 - schedule.secondsToNext / (slotMinutes * 60)));

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
  const upProbability = sigmoid(rawScore * (timeframe === '5m' ? 1.15 : 1));
  const downProbability = 1 - upProbability;
  const direction = upProbability >= downProbability ? 'up' : 'down';
  const confidence = Math.max(upProbability, downProbability);

  const remainingScale = Math.sqrt(Math.max(0.08, 1 - elapsedPct));
  const estimatedClose = round4(last * (1 + predictedMovePct * remainingScale));
  const rangePct = Math.max(sigma * 0.8 * remainingScale, 0.0005);
  const estimatedMovePctToTarget = estimatedClose / slotStartPrice - 1;

  return {
    symbol,
    timeframe,
    direction,
    label: direction === 'up' ? '上涨' : '下跌',
    confidence: round4(confidence),
    probabilities: {
      up: round4(upProbability),
      down: round4(downProbability)
    },
    score: round4(rawScore),
    reason: `${timeframe} 技术判断：趋势 ${trendScore >= 0 ? '偏多' : '偏空'}，RSI ${rsiValue.toFixed(1)}。`,
    schedule,
    prediction: {
      horizonMinutes: slotMinutes,
      targetTimeIso: schedule.nextSlotIso,
      comparisonBasePrice: round4(slotStartPrice),
      estimatedClose,
      estimatedMovePct: round4(estimatedMovePctToTarget),
      upProbability: round4(upProbability),
      downProbability: round4(downProbability),
      lowEstimate: round4(estimatedClose * (1 - rangePct)),
      highEstimate: round4(estimatedClose * (1 + rangePct)),
      rangePct: round4(rangePct)
    },
    indicators: {
      currentPrice: hasLivePrice ? round4(livePrice) : round4(last),
      slotStartPrice: round4(slotStartPrice),
      previousClosedCandleMovePct: round4(previousClosedCandleMovePct),
      bodyPct: round4(bodyPct),
      elapsedInCurrentSlotPct: round4(elapsedPct),
      rsi14: round4(rsiValue),
      return3Pct: round4(returns3),
      volatility15mPct: round4(sigma),
      ema8: round4(lastFast),
      ema21: round4(lastSlow),
      currentQuoteTime: currentQuoteTime || null
    }
  };
}

function unavailableSignal(symbol, schedule, timeframe, reason) {
  return {
    symbol,
    timeframe,
    direction: 'wait',
    label: '等待',
    confidence: 0,
    reason,
    schedule,
    prediction: null,
    indicators: null
  };
}

function estimateNextMovePct({ trendScore, slopeScore, returns3, returns6, bodyPct, rsiValue, sigma }) {
  const base = trendScore * 0.45 + slopeScore * 0.35 + returns3 * 0.25 + returns6 * 0.15 + bodyPct * 0.35;
  const rsiBias = (rsiValue - 50) / 500;
  const volScale = Number.isFinite(sigma) && sigma > 0 ? sigma : 0.01;
  return base + rsiBias * volScale;
}

function returnStdev(values, lookback) {
  if (!Array.isArray(values) || values.length < lookback + 1) return 0;
  const returns = [];
  for (let index = values.length - lookback; index < values.length; index += 1) {
    const prev = values[index - 1];
    const current = values[index];
    if (!Number.isFinite(prev) || !Number.isFinite(current) || prev <= 0) continue;
    returns.push(Math.log(current / prev));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}
