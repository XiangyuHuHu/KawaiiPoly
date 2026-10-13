import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2] || 'data/polymarket-stats.db';
const db = new DatabaseSync(DB_PATH, { readOnly: true });

function round(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function summarize(rows) {
  const usable = rows.filter((row) => Number(row.usd) > 0 && Number.isFinite(Number(row.pnl)));
  const returns = usable.map((row) => Number(row.pnl) / Number(row.usd));
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1)
    : 0;
  const standardError = returns.length ? Math.sqrt(variance / returns.length) : null;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of usable) {
    equity += Number(row.pnl);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    n: usable.length,
    wins: usable.filter((row) => Number(row.won) === 1).length,
    winRatePct: usable.length
      ? round(100 * usable.filter((row) => Number(row.won) === 1).length / usable.length, 2)
      : null,
    pnlUsd: round(usable.reduce((sum, row) => sum + Number(row.pnl), 0), 2),
    notionalUsd: round(usable.reduce((sum, row) => sum + Number(row.usd), 0), 2),
    meanRoiPct: round(mean * 100, 3),
    lower95RoiPct: standardError == null ? null : round((mean - (1.96 * standardError)) * 100, 3),
    upper95RoiPct: standardError == null ? null : round((mean + (1.96 * standardError)) * 100, 3),
    maxDrawdownUsd: round(maxDrawdown, 2),
    first: usable[0]?.settled_at_iso || null,
    last: usable.at(-1)?.settled_at_iso || null,
  };
}

const rows = db.prepare(`
  SELECT plan_id, source, timeframe, symbol, direction, entry_type, strategy_version,
         usd, pnl, won, settled_at_iso
  FROM settled_orders
  WHERE settled_at_iso IS NOT NULL
  ORDER BY settled_at_iso, id
`).all();

const lastIso = rows.at(-1)?.settled_at_iso || new Date().toISOString();
const lastMs = Date.parse(lastIso);
const cutoffs = {
  all: null,
  last30d: new Date(lastMs - (30 * 86_400_000)).toISOString(),
  last14d: new Date(lastMs - (14 * 86_400_000)).toISOString(),
  last7d: new Date(lastMs - (7 * 86_400_000)).toISOString(),
};

const keys = [...new Set(rows.map((row) => `${row.plan_id}|${row.source}`))].sort();
const plans = [];
for (const key of keys) {
  const [planId, source] = key.split('|');
  const matching = rows.filter((row) => row.plan_id === planId && row.source === source);
  plans.push({
    planId,
    source,
    periods: Object.fromEntries(Object.entries(cutoffs).map(([name, value]) => [
      name,
      summarize(value ? matching.filter((row) => row.settled_at_iso >= value) : matching),
    ])),
  });
}

const liveRows = rows.filter((row) => row.source === 'live');
const liveSegments = db.prepare(`
  SELECT plan_id, timeframe, symbol, direction, COALESCE(entry_type, '(null)') AS entry_type,
         COALESCE(strategy_version, '(null)') AS strategy_version,
         COUNT(*) AS n,
         ROUND(SUM(pnl), 2) AS pnl_usd,
         ROUND(100.0 * AVG(CASE WHEN usd > 0 THEN pnl / usd END), 3) AS mean_roi_pct,
         ROUND(100.0 * AVG(won), 2) AS win_rate_pct
  FROM settled_orders
  WHERE source = 'live' AND pnl IS NOT NULL AND usd > 0
  GROUP BY plan_id, timeframe, symbol, direction, entry_type, strategy_version
  HAVING COUNT(*) >= 20
  ORDER BY pnl_usd ASC
`).all();

console.log(JSON.stringify({
  dbPath: DB_PATH,
  generatedAtIso: new Date().toISOString(),
  dataLastSettledAtIso: lastIso,
  cutoffs,
  plans,
  liveOverall: summarize(liveRows),
  liveSegments,
}, null, 2));

db.close();
