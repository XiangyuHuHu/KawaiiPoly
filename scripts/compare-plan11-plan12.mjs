import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2] || 'data/polymarket-stats.db';
const feeRate = 0.07;
const assumedSlippage = 0.01;
const db = new DatabaseSync(dbPath, { readOnly: true });

function round(value, digits = 3) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function executionPrice(row) {
  const locked = row.locked_direction === 'up'
    ? Number(row.locked_up_prob)
    : Number(row.locked_down_prob);
  return Number.isFinite(locked) ? Math.min(0.95, Math.max(0.05, locked + assumedSlippage)) : null;
}

function tradeReturn(row) {
  const price = executionPrice(row);
  if (price == null) return null;
  const feePerDollar = feeRate * (1 - price);
  return row.actual_direction === row.locked_direction
    ? (1 / price) - 1 - feePerDollar
    : -1 - feePerDollar;
}

function summarize(rows, selector) {
  const selected = rows.filter(selector);
  const returns = selected.map(tradeReturn).filter(Number.isFinite);
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1)
    : 0;
  const se = returns.length ? Math.sqrt(variance / returns.length) : null;
  const wins = selected.filter((row) => row.actual_direction === row.locked_direction).length;
  return {
    trades: returns.length,
    days: new Set(selected.map((row) => row.target_time_iso.slice(0, 10))).size,
    winRatePct: returns.length ? round((wins / returns.length) * 100, 2) : null,
    expectancyPctPerTrade: round(mean * 100),
    lower95Pct: se == null ? null : round((mean - 1.96 * se) * 100),
    upper95Pct: se == null ? null : round((mean + 1.96 * se) * 100),
    fixedDollarPnl: round(returns.reduce((sum, value) => sum + value, 0), 2)
  };
}

const rows = db.prepare(`
  WITH latest_judgment AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY symbol, timeframe, target_time_iso
      ORDER BY predicted_at_iso DESC, id DESC
    ) AS row_number
    FROM direction_judgments
  )
  SELECT w.*, j.predicted_direction AS technical_direction
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
`).all();

const targets = [...new Set(rows.map((row) => row.target_time_iso))].sort();
const trainEnd = targets[Math.floor((targets.length - 1) * 0.60)];
const validateEnd = targets[Math.floor((targets.length - 1) * 0.80)];
const partitions = {
  train: rows.filter((row) => row.target_time_iso <= trainEnd),
  validation: rows.filter((row) => row.target_time_iso > trainEnd && row.target_time_iso <= validateEnd),
  sealedTest: rows.filter((row) => row.target_time_iso > validateEnd),
  all: rows
};

const plan11Proxy = (row) => {
  const price = executionPrice(row);
  const gap = Math.abs(Number(row.locked_up_prob) - Number(row.locked_down_prob));
  const technicalAgreement = row.technical_direction === row.locked_direction;
  return ['5m', '15m'].includes(row.timeframe)
    && price >= 0.58
    && price <= 0.86
    && gap >= 0.28
    && Number(row.quality || 0) >= 0.42
    && (row.timeframe !== '15m' || technicalAgreement);
};

const plan12 = (row) => {
  const price = executionPrice(row);
  return row.symbol === 'XRP-USD'
    && row.timeframe === '5m'
    && row.locked_direction === 'down'
    && price >= 0.60
    && price <= 0.70;
};

console.log(JSON.stringify({
  generatedAtIso: new Date().toISOString(),
  assumptions: {
    source: dbPath,
    partition: 'chronological 60% train / 20% validation / 20% sealed test by target timestamp',
    sizing: '$1 fixed notional per eligible window',
    takerFee: 'shares * 0.07 * p * (1-p)',
    slippage: '+1 cent to locked contract price',
    plan11Caveat: 'Proxy reconstructs PM price/gap/quality and 15m technical agreement; historical DB does not preserve exact intra-window Binance spot agreement, so this is not an exact Plan11 replay.',
    plan12Caveat: 'The rule was selected from local history. The sealed-test confidence interval still crosses zero; keep paper-only.'
  },
  boundaries: { first: rows[0]?.target_time_iso, trainEnd, validateEnd, last: rows.at(-1)?.target_time_iso },
  rows: rows.length,
  comparison: Object.fromEntries(Object.entries(partitions).map(([name, values]) => [name, {
    plan11Proxy: summarize(values, plan11Proxy),
    plan12: summarize(values, plan12)
  }]))
}, null, 2));

db.close();
