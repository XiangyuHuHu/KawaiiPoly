import { readFileSync, existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

function sh(iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(iso)).replace(' ', 'T');
}

const live = JSON.parse(readFileSync('data/polymarket/live-state.json', 'utf8'));
console.log('orders total', (live.orders || []).length);
const byPlan = {};
for (const o of live.orders || []) {
  const p = String(o.planId || o.plan?.id || 'unknown');
  byPlan[p] = (byPlan[p] || 0) + 1;
}
console.log('orders by planId', byPlan);
console.log('liveAuto', JSON.stringify(live.liveAuto || {}, null, 2).slice(0, 2000));
console.log('plans keys', Object.keys(live.plans || {}));
for (const id of ['plan4', 'plan6']) {
  const b = live.plans?.[id];
  if (!b) {
    console.log(id, 'MISSING bucket');
    continue;
  }
  console.log(id, 'auto', JSON.stringify({
    enabled: b.auto?.enabled,
    lastError: b.auto?.lastError,
    lastTickAt: b.auto?.lastTickAt,
    lastOrderAt: b.auto?.lastOrderAt,
    lastSkipReason: b.auto?.lastSkipReason || b.lastSkipReason,
    status: b.auto?.statusText || b.statusText,
    stoppedAtIso: b.auto?.stoppedAtIso
  }, null, 2));
}

const db = new DatabaseSync('data/polymarket-stats.db');
const counts = db.prepare(`
  SELECT source, count(*) AS n,
         min(settled_at_iso) AS a,
         max(settled_at_iso) AS b
  FROM settled_orders
  WHERE plan_id = 'plan4'
  GROUP BY source
`).all();
console.log('statsDb plan4 counts', counts);

const rows = db.prepare(`
  SELECT source, symbol, timeframe, direction, usd, won, pnl, settled_at_iso, slot_iso, entry_type
  FROM settled_orders
  WHERE plan_id = 'plan4'
  ORDER BY COALESCE(settled_at_iso, slot_iso)
`).all();

function analyze(list, label) {
  const sorted = [...list].sort((a, b) =>
    String(a.settled_at_iso || a.slot_iso).localeCompare(String(b.settled_at_iso || b.slot_iso))
  );
  if (!sorted.length) {
    console.log(label, 'empty');
    return;
  }
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = new Date(sorted[i - 1].settled_at_iso || sorted[i - 1].slot_iso).getTime();
    const b = new Date(sorted[i].settled_at_iso || sorted[i].slot_iso).getTime();
    const mins = (b - a) / 60000;
    if (mins >= 15) {
      gaps.push({
        from: sh(sorted[i - 1].settled_at_iso || sorted[i - 1].slot_iso),
        to: sh(sorted[i].settled_at_iso || sorted[i].slot_iso),
        mins: Math.round(mins)
      });
    }
  }
  console.log(label, {
    n: sorted.length,
    first: sh(sorted[0].settled_at_iso || sorted[0].slot_iso),
    last: sh(sorted.at(-1).settled_at_iso || sorted.at(-1).slot_iso),
    gaps15mPlus: gaps.length
  });
  console.log(label, 'gaps:', gaps);

  const byHour = {};
  for (const o of sorted) {
    const t = sh(o.settled_at_iso || o.slot_iso);
    if (!t) continue;
    const key = t.slice(0, 13);
    byHour[key] = (byHour[key] || 0) + 1;
  }
  console.log(label, 'by hour:');
  for (const k of Object.keys(byHour).sort()) console.log(' ', k, byHour[k]);
}

analyze(rows, 'plan4 all');
analyze(rows.filter((r) => r.source === 'live'), 'plan4 live');
analyze(rows.filter((r) => r.source === 'paper'), 'plan4 paper');

// Also check live-state orders with wallet_follow entry or plan4 in planKey
const followish = (live.orders || []).filter((o) => {
  const id = String(o.planId || o.plan?.id || '').toLowerCase();
  const et = String(o.entryType || o.plan?.entryType || '').toLowerCase();
  const key = String(o.planKey || o.plan?.key || '');
  return id === 'plan4' || id === 'plan6' || et.includes('wallet_follow') || key.startsWith('plan4_') || key.startsWith('plan6_');
});
console.log('live followish orders', followish.length);
const byId = {};
for (const o of followish) {
  const id = String(o.planId || o.plan?.id || 'unk');
  byId[id] = (byId[id] || 0) + 1;
}
console.log('followish by plan', byId);

const p4live = followish
  .filter((o) => String(o.planId || o.plan?.id || '').toLowerCase() === 'plan4')
  .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
console.log('live-state plan4 open/settled', p4live.length);
if (p4live.length) {
  console.log('first', sh(p4live[0].createdAt), p4live[0].status, p4live[0].symbol);
  console.log('last', sh(p4live.at(-1).createdAt), p4live.at(-1).status, p4live.at(-1).symbol);
  const gaps = [];
  for (let i = 1; i < p4live.length; i++) {
    const a = new Date(p4live[i - 1].createdAt).getTime();
    const b = new Date(p4live[i].createdAt).getTime();
    const mins = (b - a) / 60000;
    if (mins >= 15) gaps.push({ from: sh(p4live[i - 1].createdAt), to: sh(p4live[i].createdAt), mins: Math.round(mins) });
  }
  console.log('live-state plan4 gaps>=15m', gaps);
}

// paper plan4 state orders
const p4state = existsSync('data/polymarket/plan4-state.json')
  ? JSON.parse(readFileSync('data/polymarket/plan4-state.json', 'utf8'))
  : null;
if (p4state) {
  const paper = p4state.paperOrders || [];
  console.log('plan4-state paperOrders', paper.length, 'auto.enabled', p4state.auto?.enabled);
  const sorted = [...paper].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  if (sorted.length) {
    console.log('paper first', sh(sorted[0].createdAt), 'last', sh(sorted.at(-1).createdAt));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = new Date(sorted[i - 1].createdAt).getTime();
      const b = new Date(sorted[i].createdAt).getTime();
      const mins = (b - a) / 60000;
      if (mins >= 15) gaps.push({ from: sh(sorted[i - 1].createdAt), to: sh(sorted[i].createdAt), mins: Math.round(mins) });
    }
    console.log('paper gaps>=15m count', gaps.length);
    console.log(gaps.slice(0, 40));
  }
}
