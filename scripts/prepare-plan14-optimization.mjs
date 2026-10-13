import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const folder = resolve(process.argv[2] || 'data/analysis/plan14-optimize-20261005');
if (existsSync(join(folder, 'input.json'))) throw new Error('Frozen input already exists; choose another folder.');
const previous = JSON.parse(readFileSync('data/analysis/plan14-backtest-20261004/input.json'));
const state = JSON.parse(readFileSync('data/polymarket/plan14-state.json'));
const orders = new Map(previous.orders.map(o => [o.id, o]));
const opportunities = new Map();
const key = q => `${q.symbol}|${q.observedAtIso}`;
for (const q of previous.opportunities) opportunities.set(key(q), q);
const archiveDir = 'data/polymarket/plan14-research';
let partialLines = 0;
for (const name of readdirSync(archiveDir).filter(n => /-(opportunities|settlements)\.jsonl$/.test(n)).sort()) {
  const lines = readFileSync(join(archiveDir, name), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let row;
    try { row = JSON.parse(lines[i]); }
    catch (e) { if (i === lines.length - 1) { partialLines++; continue; } throw e; }
    if (name.endsWith('-settlements.jsonl')) orders.set(row.order.id, { ...orders.get(row.order.id), ...row.order });
    else opportunities.set(key(row), row);
  }
}
for (const o of state.paperOrders) orders.set(o.id, { ...orders.get(o.id), ...o });
for (const q of state.plan14OpportunityLog || []) opportunities.set(key(q), q);
mkdirSync(folder, { recursive: true });
const input = { frozenAtIso: new Date().toISOString(), orders: [...orders.values()],
  opportunities: [...opportunities.values()], partialLines,
  limitations: ['Only already captured fresh opportunities, not the whole market.',
    'Old order population is selected by previous versions.', 'Prior reports already examined part of the data; forward splits are not pristine blind data.'] };
writeFileSync(join(folder, 'input.json'), JSON.stringify(input));
writeFileSync(join(folder, 'official-outcomes.json'), readFileSync('data/analysis/plan14-backtest-20261004/official-outcomes.json'));
console.log(JSON.stringify({ folder, frozenAtIso: input.frozenAtIso, orders: orders.size, quotes: opportunities.size, partialLines }));
