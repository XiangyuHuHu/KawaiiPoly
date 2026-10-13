import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/polymarket-stats.db');
const rows = db.prepare(`
  SELECT symbol, timeframe, direction, entry_price, usd, won, pnl, loss_reason, settled_at_iso, slot_iso
  FROM settled_orders
  WHERE plan_id = 'plan5' AND source = 'live' AND won IS NOT NULL
  ORDER BY COALESCE(settled_at_iso, slot_iso)
`).all();

function hour(iso) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      hour12: false
    })
      .formatToParts(new Date(iso))
      .find((p) => p.type === 'hour').value
  );
}

const sorted = rows.map((r) => ({
  ...r,
  hour: hour(r.settled_at_iso || r.slot_iso),
  won: !!r.won,
  pnl: Number(r.pnl || 0),
  entry: Number(r.entry_price || 0),
  symbol: String(r.symbol || '').toUpperCase()
}));

function wr(a) {
  return a.length ? a.filter((x) => x.won).length / a.length : null;
}
function pnl(a) {
  return a.reduce((s, x) => s + x.pnl, 0);
}

function simPauseAfterLoss(Npause, Ltrigger) {
  let lossS = 0;
  let pause = 0;
  const taken = [];
  const skipped = [];
  for (const r of sorted) {
    if (pause > 0) {
      skipped.push(r);
      pause -= 1;
      continue;
    }
    taken.push(r);
    if (r.won) lossS = 0;
    else {
      lossS += 1;
      if (lossS >= Ltrigger) pause = Npause;
    }
  }
  return {
    take: taken.length,
    takeWR: wr(taken),
    takePnL: pnl(taken),
    skip: skipped.length,
    skipWR: wr(skipped),
    skipPnL: pnl(skipped)
  };
}

function simPauseAfterWin(Npause, Wtrigger) {
  let winS = 0;
  let pause = 0;
  const taken = [];
  const skipped = [];
  for (const r of sorted) {
    if (pause > 0) {
      skipped.push(r);
      pause -= 1;
      continue;
    }
    taken.push(r);
    if (r.won) {
      winS += 1;
      if (winS >= Wtrigger) {
        pause = Npause;
        winS = 0;
      }
    } else winS = 0;
  }
  return {
    take: taken.length,
    takeWR: wr(taken),
    takePnL: pnl(taken),
    skip: skipped.length,
    skipWR: wr(skipped),
    skipPnL: pnl(skipped)
  };
}

function fmt(s) {
  return {
    ...s,
    takeWR: s.takeWR == null ? 'n/a' : `${(s.takeWR * 100).toFixed(1)}%`,
    skipWR: s.skipWR == null ? 'n/a' : `${(s.skipWR * 100).toFixed(1)}%`,
    takePnL: s.takePnL.toFixed(1),
    skipPnL: s.skipPnL.toFixed(1)
  };
}

console.log('pause after losses:');
for (const L of [2, 3]) {
  for (const N of [1, 2, 3, 5]) {
    console.log(`loss>=${L} pause${N}`, fmt(simPauseAfterLoss(N, L)));
  }
}
console.log('pause after wins:');
for (const W of [2, 3, 4]) {
  for (const N of [1, 2, 3]) {
    console.log(`win>=${W} pause${N}`, fmt(simPauseAfterWin(N, W)));
  }
}

function bands(list) {
  const b = {};
  for (const r of list) {
    const k = r.entry < 0.55 ? '<0.55' : r.entry < 0.7 ? '0.55-0.7' : '>=0.7';
    b[k] = b[k] || { n: 0, w: 0, pnl: 0 };
    b[k].n += 1;
    if (r.won) b[k].w += 1;
    b[k].pnl += r.pnl;
  }
  for (const [k, v] of Object.entries(b)) {
    v.wr = `${((v.w / v.n) * 100).toFixed(1)}%`;
    v.pnl = v.pnl.toFixed(1);
  }
  return b;
}

const h10 = sorted.filter((r) => r.hour === 10);
const h11 = sorted.filter((r) => r.hour === 11);
console.log('hour10', { n: h10.length, wr: `${(wr(h10) * 100).toFixed(1)}%`, pnl: pnl(h10).toFixed(1), bands: bands(h10) });
console.log('hour11', { n: h11.length, wr: `${(wr(h11) * 100).toFixed(1)}%`, pnl: pnl(h11).toFixed(1), bands: bands(h11) });
console.log('hour11 by symbol');
for (const sym of ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']) {
  const a = h11.filter((r) => r.symbol === sym);
  if (!a.length) continue;
  console.log(sym, { n: a.length, wr: `${(wr(a) * 100).toFixed(1)}%`, pnl: pnl(a).toFixed(1) });
}

console.log('bad hours by tf');
for (const h of [11, 15, 17, 20]) {
  for (const tf of ['5m', '15m']) {
    const a = sorted.filter((r) => r.hour === h && r.timeframe === tf);
    if (a.length < 3) continue;
    console.log(`h${h} ${tf}`, { n: a.length, wr: `${(wr(a) * 100).toFixed(1)}%`, pnl: pnl(a).toFixed(1) });
  }
}

// After a completed win-run of length>=2, what is WR of the FOLLOWING loss-run length / first trade after?
const runs = [];
let cur = null;
for (const r of sorted) {
  if (!cur || cur.won !== r.won) {
    if (cur) runs.push(cur);
    cur = { won: r.won, len: 1, items: [r] };
  } else {
    cur.len += 1;
    cur.items.push(r);
  }
}
if (cur) runs.push(cur);

let firstAfterWin2 = [];
let lossRunLenAfterWin2 = [];
for (let i = 0; i < runs.length - 1; i++) {
  if (runs[i].won && runs[i].len >= 2) {
    const next = runs[i + 1];
    // by construction next must be opposite if runs alternate — yes
    firstAfterWin2.push(next.items[0]);
    if (!next.won) lossRunLenAfterWin2.push(next.len);
  }
}
console.log('first trade after win-run>=2', {
  n: firstAfterWin2.length,
  wr: firstAfterWin2.length ? `${(wr(firstAfterWin2) * 100).toFixed(1)}%` : 'n/a',
  // should be ~0% if next run is always loss run start
});
console.log('loss-run lengths after win-run>=2', lossRunLenAfterWin2);
console.log(
  'avg loss-run len after win>=2',
  lossRunLenAfterWin2.length
    ? (lossRunLenAfterWin2.reduce((a, b) => a + b, 0) / lossRunLenAfterWin2.length).toFixed(2)
    : 'n/a'
);
const allLossLens = runs.filter((r) => !r.won).map((r) => r.len);
console.log(
  'avg loss-run len overall',
  (allLossLens.reduce((a, b) => a + b, 0) / allLossLens.length).toFixed(2)
);
