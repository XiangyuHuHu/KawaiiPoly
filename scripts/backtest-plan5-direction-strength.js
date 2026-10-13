import { DatabaseSync } from 'node:sqlite';

const DB_PATH = new URL('../data/polymarket-stats.db', import.meta.url);
const SYMBOLS = {
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'SOL-USD': 'SOLUSDT',
  'XRP-USD': 'XRPUSDT'
};
const INTERVAL_MS = 5 * 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

async function fetchKlines(symbol, interval, intervalMs, startMs, endMs) {
  const rows = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = new URL('https://data-api.binance.vision/api/v3/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endMs));
    url.searchParams.set('limit', '1000');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} kline request failed: ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page) || !page.length) break;
    for (const item of page) {
      rows.push({
        openTime: Number(item[0]),
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4])
      });
    }
    cursor = Number(page.at(-1)[0]) + intervalMs;
    if (page.length < 1000) break;
  }
  return rows;
}

function signedStreak(moves, index) {
  const latest = moves[index - 1];
  if (!Number.isFinite(latest) || latest === 0) return 0;
  const sign = Math.sign(latest);
  let count = 0;
  for (let offset = 1; offset <= 8 && index - offset >= 0; offset += 1) {
    if (Math.sign(moves[index - offset]) !== sign) break;
    count += 1;
  }
  return sign * count;
}

function vectorFor(row, candles, candleIndex, currentPrice) {
  const candle = candles[candleIndex];
  const moves = candles.map((item) => (item.close / item.open - 1) * 10_000);
  const previous = (offset) => Number(moves[candleIndex - offset]) || 0;
  const prev = [previous(1), previous(2), previous(3), previous(4), previous(5), previous(6)];
  const streak = signedStreak(moves, candleIndex);
  const streakCount = Math.abs(streak);
  let streakMove = 0;
  for (let offset = 1; offset <= streakCount; offset += 1) streakMove += previous(offset);
  const priorSameMoves = [];
  const streakSign = Math.sign(streak);
  for (let offset = 2; offset <= Math.min(8, Math.abs(streak)); offset += 1) {
    const value = previous(offset);
    if (Math.sign(value) === streakSign) priorSameMoves.push(Math.abs(value));
  }
  const priorSameAverage = priorSameMoves.length
    ? priorSameMoves.reduce((sum, value) => sum + value, 0) / priorSameMoves.length
    : Math.abs(prev[0]);
  const exhaustion = streakSign * Math.max(0, Math.abs(streak) - 1)
    * clamp(1 - Math.abs(prev[0]) / Math.max(0.5, priorSameAverage), -1.5, 1.5);
  const predictedMs = Date.parse(row.predicted_at_iso);
  const elapsed = clamp((predictedMs - candle.openTime) / INTERVAL_MS, 0.02, 1);
  const currentMove = (Number(currentPrice) / candle.open - 1) * 10_000;
  const pmDirection = row.predicted_direction === 'down' ? -1 : 1;
  const averageAbs6 = prev.reduce((sum, value) => sum + Math.abs(value), 0) / 6;
  const overextension = Math.sign(streak)
    * Math.max(0, streakCount - 1)
    * Math.min(2, Math.abs(streakMove) / Math.max(6, averageAbs6 * 1.5));
  return [
    1,
    pmDirection,
    clamp(currentMove / 10, -4, 4),
    clamp(currentMove / Math.sqrt(elapsed) / 10, -5, 5),
    clamp(prev[0] / 10, -4, 4),
    clamp(prev[1] / 10, -4, 4),
    clamp(prev[2] / 10, -4, 4),
    clamp((prev[0] + prev[1] + prev[2]) / 20, -4, 4),
    clamp(prev.reduce((sum, value) => sum + value, 0) / 30, -4, 4),
    clamp(streak / 4, -2, 2),
    clamp(exhaustion / 4, -3, 3),
    clamp(averageAbs6 / 10, 0, 4),
    elapsed,
    row.symbol === 'ETH-USD' ? 1 : 0,
    row.symbol === 'SOL-USD' ? 1 : 0,
    row.symbol === 'XRP-USD' ? 1 : 0,
    clamp(overextension / 2, -3, 3)
  ];
}

function standardize(train, test) {
  const width = train[0].x.length;
  const means = Array(width).fill(0);
  const scales = Array(width).fill(1);
  for (let column = 1; column < width; column += 1) {
    means[column] = train.reduce((sum, row) => sum + row.x[column], 0) / train.length;
    const variance = train.reduce((sum, row) => sum + (row.x[column] - means[column]) ** 2, 0) / train.length;
    scales[column] = Math.max(0.05, Math.sqrt(variance));
  }
  const transform = (row) => ({
    ...row,
    x: row.x.map((value, column) => column === 0 ? value : (value - means[column]) / scales[column])
  });
  return { train: train.map(transform), test: test.map(transform) };
}

function fitLogistic(rows, { iterations = 260, learningRate = 0.08, l2 = 0.015 } = {}) {
  const weights = Array(rows[0].x.length).fill(0);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Array(weights.length).fill(0);
    for (const row of rows) {
      const score = row.x.reduce((sum, value, index) => sum + value * weights[index], 0);
      const error = sigmoid(score) - row.y;
      for (let index = 0; index < weights.length; index += 1) gradient[index] += error * row.x[index];
    }
    const step = learningRate / Math.sqrt(1 + iteration / 30);
    for (let index = 0; index < weights.length; index += 1) {
      const penalty = index === 0 ? 0 : l2 * weights[index];
      weights[index] -= step * (gradient[index] / rows.length + penalty);
    }
  }
  return weights;
}

function modelProbability(row, weights) {
  return sigmoid(row.x.reduce((sum, value, index) => sum + value * weights[index], 0));
}

function tradePnl(direction, actualDirection, price, usd = 5) {
  if (direction !== actualDirection) return -usd;
  return usd * (1 / clamp(price, 0.05, 0.95) - 1);
}

function evaluate(rows, probabilityFor) {
  const stats = { n: 0, wins: 0, pnl: 0, rawPnl: 0, spotPnl: 0 };
  for (const row of rows) {
    const probability = clamp(probabilityFor(row), 0.01, 0.99);
    const upPrice = clamp(row.upPrice, 0.05, 0.95);
    const downPrice = clamp(row.downPrice, 0.05, 0.95);
    // 判断模型只决定方向；价格和 EV 留给 Plan5 仓位模块，不以跳过交易改善结果。
    const direction = probability >= 0.5 ? 'up' : 'down';
    const price = direction === 'up' ? upPrice : downPrice;
    const rawDirection = row.rawDirection;
    const spotDirection = row.currentMove >= 0 ? 'up' : 'down';
    stats.n += 1;
    stats.wins += direction === row.actualDirection ? 1 : 0;
    stats.pnl += tradePnl(direction, row.actualDirection, price);
    stats.rawPnl += tradePnl(rawDirection, row.actualDirection, rawDirection === 'up' ? upPrice : downPrice);
    stats.spotPnl += tradePnl(spotDirection, row.actualDirection, spotDirection === 'up' ? upPrice : downPrice);
  }
  return {
    n: stats.n,
    hit: Number((stats.wins / Math.max(1, stats.n) * 100).toFixed(1)),
    pnl: Number(stats.pnl.toFixed(2)),
    rawPnl: Number(stats.rawPnl.toFixed(2)),
    spotPnl: Number(stats.spotPnl.toFixed(2))
  };
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rawRows = db.prepare(`
  SELECT * FROM direction_judgments
  WHERE timeframe = '5m'
    AND predicted_at_iso >= '2026-07-10T00:00:00.000Z'
  ORDER BY predicted_at_iso
`).all();
const paperOrders = db.prepare(`
  SELECT symbol, target_time_iso, direction, entry_price
  FROM settled_orders
  WHERE source = 'paper'
    AND lower(plan_id) = 'plan5'
    AND timeframe = '5m'
    AND entry_price > 0 AND entry_price < 1
  ORDER BY target_time_iso
`).all();
const paperByWindow = new Map(paperOrders.map((row) => [`${row.symbol}|${row.target_time_iso}`, row]));
const startMs = Date.parse(rawRows[0].slot_iso) - 8 * INTERVAL_MS;
const endMs = Date.parse(rawRows.at(-1).target_time_iso) + INTERVAL_MS;
const candlesBySymbol = new Map();
const minutesBySymbol = new Map();
for (const [symbol, exchangeSymbol] of Object.entries(SYMBOLS)) {
  const candles = await fetchKlines(exchangeSymbol, '5m', INTERVAL_MS, startMs, endMs);
  const minutes = await fetchKlines(exchangeSymbol, '1m', 60_000, startMs, endMs);
  candlesBySymbol.set(symbol, candles);
  minutesBySymbol.set(symbol, new Map(minutes.map((item) => [item.openTime, item])));
  console.error(`${symbol}: ${candles.length} 5m candles, ${minutes.length} 1m candles`);
}

const joined = [];
const directionOnly = [];
for (const row of rawRows) {
  const candles = candlesBySymbol.get(row.symbol);
  if (!candles) continue;
  const slotMs = Date.parse(row.slot_iso);
  const candleIndex = candles.findIndex((item) => item.openTime === slotMs);
  if (candleIndex < 6) continue;
  const candle = candles[candleIndex];
  const predictedMs = Date.parse(row.predicted_at_iso);
  const minuteOpenMs = Math.floor(predictedMs / 60_000) * 60_000;
  const minute = minutesBySymbol.get(row.symbol)?.get(minuteOpenMs);
  if (!minute?.open) continue;
  // 当分钟 open 在锁定时刻已经可知；不用该分钟 close，避免偷看后续几十秒。
  const x = vectorFor(row, candles, candleIndex, minute.open);
  const actualDirection = candle.close >= candle.open ? 'up' : 'down';
  const directionRow = {
    x,
    y: actualDirection === 'up' ? 1 : 0,
    symbol: row.symbol,
    targetMs: Date.parse(row.target_time_iso),
    day: new Date(row.target_time_iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    actualDirection,
    currentMove: x[2] * 10,
    rawDirection: row.predicted_direction
  };
  directionOnly.push(directionRow);
  const paper = paperByWindow.get(`${row.symbol}|${row.target_time_iso}`);
  if (!paper) continue;
  const paperPrice = clamp(paper.entry_price, 0.05, 0.95);
  // 另一边没有历史 ask，按互补价再加 2¢ 模拟价差，避免反向收益过于乐观。
  const oppositePrice = clamp(1 - paperPrice + 0.02, 0.05, 0.95);
  const upPrice = paper.direction === 'up' ? paperPrice : oppositePrice;
  const downPrice = paper.direction === 'down' ? paperPrice : oppositePrice;
  joined.push({
    x,
    y: actualDirection === 'up' ? 1 : 0,
    symbol: row.symbol,
    targetMs: Date.parse(row.target_time_iso),
    day: new Date(row.target_time_iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    actualDirection,
    currentMove: x[2] * 10,
    rawDirection: paper.direction,
    upPrice,
    downPrice
  });
}

const days = [...new Set(joined.map((row) => row.day))].sort().filter((day) => day >= '2026-07-15');
const results = [];
for (const day of days) {
  const dayStart = Date.parse(`${day}T00:00:00+08:00`);
  const trainRaw = joined.filter((row) => row.targetMs < dayStart && row.targetMs >= dayStart - 7 * 86400000);
  const testRaw = joined.filter((row) => row.day === day);
  if (trainRaw.length < 500 || !testRaw.length) continue;
  const normalized = standardize(trainRaw, testRaw);
  const weights = fitLogistic(normalized.train);
  results.push({ day, train: trainRaw.length, ...evaluate(normalized.test, (row) => modelProbability(row, weights)) });
}
function directionAccuracy(rows, weights) {
  const byDay = {};
  let correct = 0;
  for (const row of rows) {
    const score = weights.pm * row.x[1]
      + weights.current * row.x[2]
      + weights.pace * row.x[3]
      + weights.previous * row.x[4]
      + weights.sum3 * row.x[7]
      + weights.sum6 * row.x[8]
      + weights.streak * row.x[9]
      + weights.exhaustion * row.x[10]
      + weights.overextension * row.x[16];
    const predicted = score >= 0 ? 'up' : 'down';
    const hit = predicted === row.actualDirection;
    correct += hit ? 1 : 0;
    byDay[row.day] ||= { n: 0, correct: 0 };
    byDay[row.day].n += 1;
    byDay[row.day].correct += hit ? 1 : 0;
  }
  const daily = Object.fromEntries(Object.entries(byDay).map(([day, value]) => [day, Number((value.correct / value.n * 100).toFixed(1))]));
  return {
    n: rows.length,
    hit: Number((correct / Math.max(1, rows.length) * 100).toFixed(2)),
    minDay: Math.min(...Object.values(daily)),
    daily
  };
}

function ruleProbability(row, weights) {
  const score = weights.pm * row.x[1]
    + weights.current * row.x[2]
    + weights.pace * row.x[3]
    + weights.previous * row.x[4]
    + weights.sum3 * row.x[7]
    + weights.sum6 * row.x[8]
    + weights.streak * row.x[9]
    + weights.exhaustion * row.x[10]
    + weights.overextension * row.x[16];
  return score >= 0 ? 0.51 : 0.49;
}

const candidates = [];
for (const pm of [0.5, 1])
for (const current of [0.5, 1, 2])
for (const pace of [0, 0.25])
for (const previous of [0.25, 0.5, 1, 2])
for (const sum3 of [-0.5, -0.25, 0, 0.25])
for (const overextension of [-1, -0.5, -0.25, 0]) {
  candidates.push({ pm, current, pace, previous, sum3, sum6: 0, streak: 0, exhaustion: 0, overextension });
}
const cutoff = Math.max(...directionOnly.map((row) => row.targetMs)) - 24 * 60 * 60 * 1000;
const trainDirection = directionOnly.filter((row) => row.targetMs < cutoff && row.day >= '2026-07-15');
const holdoutDirection = directionOnly.filter((row) => row.targetMs >= cutoff);
const ranked = candidates.map((weights) => ({ weights, train: directionAccuracy(trainDirection, weights) }))
  .sort((a, b) => (b.train.hit + b.train.minDay * 0.25) - (a.train.hit + a.train.minDay * 0.25))
  .slice(0, 12)
  .map((item) => ({ ...item, holdout: directionAccuracy(holdoutDirection, item.weights) }));
const zeroes = { current: 0, pace: 0, previous: 0, sum3: 0, sum6: 0, streak: 0, exhaustion: 0, overextension: 0 };
const selectedWeights = { pm: 1, current: 2, pace: 0.25, previous: 0.25, sum3: -0.25, sum6: 0, streak: 0, exhaustion: 0, overextension: 0 };
const paperCutoff = Math.max(...joined.map((row) => row.targetMs)) - 24 * 60 * 60 * 1000;
const paperTrain = joined.filter((row) => row.targetMs < paperCutoff);
const paperHoldout = joined.filter((row) => row.targetMs >= paperCutoff);
const profitRules = candidates
  .map((weights) => ({ weights, train: evaluate(paperTrain, (row) => ruleProbability(row, weights)) }))
  .sort((a, b) => b.train.pnl - a.train.pnl)
  .slice(0, 12)
  .map((item) => ({ ...item, holdout: evaluate(paperHoldout, (row) => ruleProbability(row, item.weights)) }));
console.log(JSON.stringify({
  rows: joined.length,
  directionRows: directionOnly.length,
  baselines: {
    trainRawPm: directionAccuracy(trainDirection, { pm: 1, ...zeroes }),
    holdoutRawPm: directionAccuracy(holdoutDirection, { pm: 1, ...zeroes }),
    trainCurrentMove: directionAccuracy(trainDirection, { pm: 0, ...zeroes, current: 1 }),
    holdoutCurrentMove: directionAccuracy(holdoutDirection, { pm: 0, ...zeroes, current: 1 })
  },
  selected: {
    weights: selectedWeights,
    train: directionAccuracy(trainDirection, selectedWeights),
    holdout: directionAccuracy(holdoutDirection, selectedWeights),
    paperAll: evaluate(joined, (row) => ruleProbability(row, selectedWeights)),
    paperHoldout: evaluate(paperHoldout, (row) => ruleProbability(row, selectedWeights))
  },
  byDay: results,
  strengthRules: ranked,
  profitRules
}, null, 2));
