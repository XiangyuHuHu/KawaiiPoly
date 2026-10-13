import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2] || 'data/polymarket-stats.db';
const TAKER_FEE_RATE = 0.07;
const SLIPPAGE = 0.01;
const MIN_PRICE = 0.05;
const MAX_PRICE = 0.95;

const db = new DatabaseSync(DB_PATH, { readOnly: true });

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function cutoff(sorted, probability) {
  if (!sorted.length) return null;
  return sorted[Math.floor((sorted.length - 1) * probability)];
}

function contractPrice(row) {
  const price = row.locked_direction === 'up'
    ? Number(row.locked_up_prob)
    : Number(row.locked_down_prob);
  if (!Number.isFinite(price)) return null;
  return Math.min(MAX_PRICE, Math.max(MIN_PRICE, price + SLIPPAGE));
}

function tradeReturn(row) {
  const price = contractPrice(row);
  if (price == null) return null;
  // Return on $1 notional. Polymarket crypto taker fee:
  // shares * feeRate * p * (1-p), where shares = 1/p for $1 notional.
  const fee = TAKER_FEE_RATE * (1 - price);
  return row.actual_direction === row.locked_direction
    ? (1 / price) - 1 - fee
    : -1 - fee;
}

function maxDrawdown(returns) {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, peak - equity);
  }
  return worst;
}

function summarize(rows, selector = () => true) {
  const selected = [];
  const returns = [];
  let wins = 0;
  let entrySum = 0;
  for (const row of rows) {
    if (!selector(row)) continue;
    const value = tradeReturn(row);
    if (!Number.isFinite(value)) continue;
    selected.push(row);
    returns.push(value);
    entrySum += contractPrice(row);
    if (row.actual_direction === row.locked_direction) wins += 1;
  }
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1)
    : 0;
  const days = new Set(selected.map((row) => row.target_time_iso.slice(0, 10))).size;
  return {
    n: returns.length,
    days,
    winRate: returns.length ? wins / returns.length : 0,
    pnlPerDollar: returns.reduce((sum, value) => sum + value, 0),
    expectancy: mean,
    standardError: returns.length ? Math.sqrt(variance / returns.length) : null,
    maxDrawdown: maxDrawdown(returns),
    avgEntry: returns.length ? entrySum / returns.length : null,
  };
}

function printable(summary) {
  return {
    n: summary.n,
    days: summary.days,
    winRatePct: round(summary.winRate * 100, 2),
    avgEntry: round(summary.avgEntry, 4),
    pnlPerDollar: round(summary.pnlPerDollar, 3),
    expectancyPct: round(summary.expectancy * 100, 3),
    lower95Pct: summary.standardError == null
      ? null
      : round((summary.expectancy - (1.96 * summary.standardError)) * 100, 3),
    maxDrawdownPerDollar: round(summary.maxDrawdown, 3),
  };
}

function dailySummary(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    if (!selector(row)) continue;
    const day = row.target_time_iso.slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(row);
  }
  return [...groups.entries()].map(([day, values]) => ({ day, ...printable(summarize(values)) }));
}

const rows = db.prepare(`
  WITH latest_judgment AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY symbol, timeframe, target_time_iso
      ORDER BY predicted_at_iso DESC, id DESC
    ) AS row_number
    FROM direction_judgments
  )
  SELECT
    w.id,
    w.timeframe,
    w.symbol,
    w.target_time_iso,
    w.locked_direction,
    w.lock_strength,
    w.locked_pm_gap,
    w.locked_up_prob,
    w.locked_down_prob,
    w.lock_elapsed_pct,
    w.quality,
    w.actual_direction,
    j.predicted_direction AS technical_direction,
    j.confidence AS technical_confidence,
    j.volatility_bucket,
    j.same_direction_as_prev
  FROM window_locks w
  LEFT JOIN latest_judgment j
    ON j.symbol = w.symbol
    AND j.timeframe = w.timeframe
    AND j.target_time_iso = w.target_time_iso
    AND j.row_number = 1
  WHERE w.decision_locked = 1
    AND w.actual_direction IN ('up', 'down')
    AND w.locked_direction IN ('up', 'down')
    AND w.locked_up_prob IS NOT NULL
    AND w.locked_down_prob IS NOT NULL
  ORDER BY w.target_time_iso, w.symbol, w.timeframe
`).all().map((row) => ({ ...row, agreement: row.technical_direction === row.locked_direction }));

const timestamps = [...new Set(rows.map((row) => row.target_time_iso))].sort();
const trainEnd = cutoff(timestamps, 0.6);
const validateEnd = cutoff(timestamps, 0.8);
const partitions = {
  train: rows.filter((row) => row.target_time_iso <= trainEnd),
  validate: rows.filter((row) => row.target_time_iso > trainEnd && row.target_time_iso <= validateEnd),
  test: rows.filter((row) => row.target_time_iso > validateEnd),
};

const candidates = [];
const timeframes = ['5m', '15m'];
const symbols = ['*', ...new Set(rows.map((row) => row.symbol))];
const directions = ['*', 'up', 'down'];
const agreementModes = ['any', 'agree'];
const minPrices = [0.5, 0.55, 0.6, 0.65];
const maxPrices = [0.7, 0.75, 0.8, 0.85, 0.9];
const minQualities = [0, 0.4, 0.5, 0.6, 0.7];

for (const timeframe of timeframes) {
  for (const symbol of symbols) {
    for (const direction of directions) {
      for (const agreementMode of agreementModes) {
        for (const minPrice of minPrices) {
          for (const maxPrice of maxPrices) {
            if (maxPrice <= minPrice) continue;
            for (const minQuality of minQualities) {
              const selector = (row) => (
                row.timeframe === timeframe
                && (symbol === '*' || row.symbol === symbol)
                && (direction === '*' || row.locked_direction === direction)
                && (agreementMode === 'any' || row.agreement)
                && contractPrice(row) >= minPrice
                && contractPrice(row) <= maxPrice
                && Number(row.quality || 0) >= minQuality
              );
              const train = summarize(partitions.train, selector);
              const validate = summarize(partitions.validate, selector);
              if (train.n < 200 || validate.n < 75) continue;
              if (train.expectancy <= 0 || validate.expectancy <= 0) continue;
              candidates.push({
                rule: { timeframe, symbol, direction, agreementMode, minPrice, maxPrice, minQuality },
                selector,
                train,
                validate,
                score: Math.min(train.expectancy, validate.expectancy),
              });
            }
          }
        }
      }
    }
  }
}

candidates.sort((a, b) => b.score - a.score || b.validate.n - a.validate.n);

const nonOverlapping = [];
const usedSignature = new Set();
for (const candidate of candidates) {
  const signature = [
    candidate.rule.timeframe,
    candidate.rule.symbol,
    candidate.rule.direction,
    candidate.rule.agreementMode,
  ].join('|');
  if (usedSignature.has(signature)) continue;
  usedSignature.add(signature);
  nonOverlapping.push(candidate);
  if (nonOverlapping.length >= 20) break;
}


const policySelectors = {
  incomingPlan11Broad: (row) => {
    const price = contractPrice(row);
    const gap = Math.abs(Number(row.locked_up_prob) - Number(row.locked_down_prob));
    return ['5m', '15m'].includes(row.timeframe)
      && price >= 0.58
      && price <= 0.86
      && gap >= 0.28
      && Number(row.quality || 0) >= 0.42;
  },
  incomingPlan11BroadWithTechnicalAgreement: (row) => {
    const price = contractPrice(row);
    const gap = Math.abs(Number(row.locked_up_prob) - Number(row.locked_down_prob));
    return ['5m', '15m'].includes(row.timeframe)
      && price >= 0.58
      && price <= 0.86
      && gap >= 0.28
      && Number(row.quality || 0) >= 0.42
      && row.agreement;
  },
  validatedXrp5mDownBand: (row) => (
    row.timeframe === '5m'
    && row.symbol === 'XRP-USD'
    && row.locked_direction === 'down'
    && contractPrice(row) >= 0.60
    && contractPrice(row) <= 0.70
  ),
  conservativeXrp5mDownBand: (row) => (
    row.timeframe === '5m'
    && row.symbol === 'XRP-USD'
    && row.locked_direction === 'down'
    && contractPrice(row) >= 0.60
    && contractPrice(row) <= 0.68
  ),
  narrowXrp5mDownBand: (row) => (
    row.timeframe === '5m'
    && row.symbol === 'XRP-USD'
    && row.locked_direction === 'down'
    && contractPrice(row) >= 0.62
    && contractPrice(row) <= 0.68
  ),
};
for (const [minPrice, maxPrice] of [[0.60, 0.62], [0.62, 0.64], [0.64, 0.66], [0.66, 0.68], [0.68, 0.70]]) {
  policySelectors[`xrp5mDown_${minPrice.toFixed(2)}_${maxPrice.toFixed(2)}`] = (row) => (
    row.timeframe === '5m'
    && row.symbol === 'XRP-USD'
    && row.locked_direction === 'down'
    && contractPrice(row) >= minPrice
    && contractPrice(row) < maxPrice + 1e-9
  );
}

console.log(JSON.stringify({
  assumptions: {
    dbPath: DB_PATH,
    takerFeeRate: TAKER_FEE_RATE,
    slippage: SLIPPAGE,
    pnlUnit: 'return for each $1 fixed-notional trade',
  },
  sample: {
    rows: rows.length,
    firstTarget: rows[0]?.target_time_iso || null,
    lastTarget: rows.at(-1)?.target_time_iso || null,
    trainEnd,
    validateEnd,
    partitionSizes: Object.fromEntries(Object.entries(partitions).map(([key, value]) => [key, value.length])),
  },
  baselines: Object.fromEntries(
    Object.entries(partitions).map(([key, value]) => [key, printable(summarize(value))]),
  ),
  policyChecks: Object.fromEntries(Object.entries(policySelectors).map(([name, selector]) => [name, {
    train: printable(summarize(partitions.train, selector)),
    validate: printable(summarize(partitions.validate, selector)),
    test: printable(summarize(partitions.test, selector)),
    all: printable(summarize(rows, selector)),
    daily: dailySummary(rows, selector),
  }])),
  candidates: nonOverlapping.map((candidate) => ({
    rule: candidate.rule,
    train: printable(candidate.train),
    validate: printable(candidate.validate),
    test: printable(summarize(partitions.test, candidate.selector)),
    all: printable(summarize(rows, candidate.selector)),
  })),
}, null, 2));

db.close();
