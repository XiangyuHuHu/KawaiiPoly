import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const output = resolve(process.argv[2] || 'data/analysis/plan14-backtest-20261004');
const files = [
  'data/plan14-v3-predeploy/plan14-state.json',
  'data/plan14-v4-predeploy-20261003-001116/plan14-state.json',
  'data/plan14-v5-predeploy-20261003-005440/plan14-state.json',
  'data/polymarket/plan14-state.v1-calibrated-ev.json',
  'data/polymarket/plan14-state.json'
];
const db = new DatabaseSync('data/polymarket-stats.db', { readOnly: true });
const orders = new Map();
for (const row of db.prepare("SELECT * FROM settled_orders WHERE plan_id='plan14'").all()) {
  let gate = {};
  try { gate = JSON.parse(row.expected_value_json || '{}'); } catch {}
  const stamp = row.id?.match(/^pm-plan14-(\d+)-/)?.[1];
  orders.set(row.id, { id: row.id, strategyVersion: row.strategy_version,
    timeframe: row.timeframe, symbol: row.symbol, direction: row.direction,
    limitPrice: row.entry_price, usd: row.usd, pnl: row.pnl, won: !!row.won,
    slotIso: row.slot_iso, targetTimeIso: row.target_time_iso,
    createdAtIso: stamp ? new Date(Number(stamp)).toISOString() : null,
    settledAtIso: row.settled_at_iso, settlementStatus: 'settled', exitStatus: row.exit_status,
    expectedValueGate: gate, reconstructionSource: 'stats-db', needsFeeReconstruction: true });
}
let opportunities = [];
const sources = [];
for (const file of files) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const rows = state.paperOrders || [];
    for (const order of rows) orders.set(order.id, { ...orders.get(order.id), ...order,
      reconstructionSource: file, needsFeeReconstruction: !Number.isFinite(order.shares) });
    if (file.endsWith('/polymarket/plan14-state.json')) opportunities = state.plan14OpportunityLog || [];
    sources.push({ file, orders: rows.length });
  } catch (error) { sources.push({ file, error: error.message }); }
}
for (const order of orders.values()) {
  if (!order.marketSlug && order.symbol && order.timeframe && order.slotIso) {
    order.marketSlug = `${order.symbol.split('-')[0].toLowerCase()}-updown-${order.timeframe}-${Date.parse(order.slotIso) / 1000}`;
  }
}
const keys = new Set([...orders.values()].map(o => `${o.symbol}|${o.timeframe}|${o.targetTimeIso}`));
const snapshots = db.prepare("SELECT * FROM window_snapshots WHERE timeframe='5m' ORDER BY observed_at_iso,id").all()
  .filter(row => keys.has(`${row.symbol}|${row.timeframe}|${row.target_time_iso}`));
db.close();
mkdirSync(output, { recursive: true });
const input = { frozenAtIso: new Date().toISOString(), sources, orders: [...orders.values()], opportunities, snapshots,
  limitations: ['window_snapshots have no fresh-book timestamps; diagnostic only',
    'order traces cease on real exits: cannot invent later exit prices',
    'fresh opportunities retained for latest few hours only',
    'fixed historical entries are a selected population, not all potential opportunities'] };
writeFileSync(join(output, 'input.json'), JSON.stringify(input));
console.log(JSON.stringify({ output, sources, orders: input.orders.length, opportunities: opportunities.length,
  diagnosticSnapshots: snapshots.length, reconstructedOrders: input.orders.filter(o => o.needsFeeReconstruction).length }));
