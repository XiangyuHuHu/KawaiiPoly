/**
 * Plan5 streak / hour-of-day analysis from live-state + statsDb.
 * Run: node scripts/analyze-plan5-streaks.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const livePath = join(root, 'data/polymarket/live-state.json');
const dbPath = join(root, 'data/polymarket-stats.db');

function shanghaiHour(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    hour12: false
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'hour')?.value);
}

function shanghaiWeekday(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short'
  }).format(d);
}

function loadLivePlan5() {
  if (!existsSync(livePath)) return [];
  const state = JSON.parse(readFileSync(livePath, 'utf8'));
  const orders = Array.isArray(state.orders) ? state.orders : [];
  return orders.filter((o) => {
    const plan = String(o.planId || o.plan?.id || '').toLowerCase();
    const side = String(o.side || '').toUpperCase();
    const settled = o.settled === true || o.status === 'settled' || o.exitStatus;
    return plan === 'plan5' && side === 'BUY' && settled && typeof o.won === 'boolean';
  });
}

function loadDbPlan5() {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`
      SELECT id, plan_id, source, symbol, timeframe, direction, entry_price, usd,
             won, pnl, loss_reason, settled_at_iso, slot_iso, entry_type, exit_status
      FROM settled_orders
      WHERE plan_id = 'plan5' AND won IS NOT NULL
      ORDER BY COALESCE(settled_at_iso, slot_iso)
    `).all();
  } finally {
    db.close();
  }
}

function normalize(rows, sourceHint) {
  return rows.map((o) => {
    const won = o.won === true || o.won === 1;
    const iso = o.settled_at_iso || o.settledAt || o.created_at_iso || o.createdAt || o.filledAt;
    return {
      id: o.id,
      source: o.source || sourceHint,
      symbol: String(o.symbol || 'BTC-USD').toUpperCase(),
      timeframe: o.timeframe || o.tf || '5m',
      direction: o.direction || o.sideDirection,
      entryPrice: Number(o.entry_price ?? o.entryPrice ?? o.limitPrice ?? 0),
      orderUsd: Number(o.order_usd ?? o.orderUsd ?? o.usd ?? 0),
      won,
      pnl: Number(o.pnl ?? 0),
      lossReason: o.loss_reason || o.lossReason || null,
      iso,
      hour: shanghaiHour(iso),
      weekday: shanghaiWeekday(iso),
      entryType: o.entry_type || o.entryType || null
    };
  }).filter((o) => o.iso && o.hour != null);
}

function wrStats(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.won).length;
  const losses = n - wins;
  const pnl = rows.reduce((s, r) => s + (Number.isFinite(r.pnl) ? r.pnl : 0), 0);
  return {
    n,
    wins,
    losses,
    wr: n ? wins / n : null,
    pnl: Math.round(pnl * 100) / 100
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function printGroup(title, map, minN = 5) {
  console.log(`\n=== ${title} ===`);
  const rows = [...map.entries()]
    .map(([k, list]) => ({ key: k, ...wrStats(list) }))
    .filter((r) => r.n >= minN)
    .sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
  for (const r of rows) {
    const wrPct = r.wr == null ? 'n/a' : `${(r.wr * 100).toFixed(1)}%`;
    console.log(`${String(r.key).padEnd(14)} n=${String(r.n).padStart(3)}  WR=${wrPct.padStart(6)}  W/L=${r.wins}/${r.losses}  PnL=${r.pnl}`);
  }
  return rows;
}

/** Streak runs: consecutive wins/losses in time order (global, then per-symbol). */
function streakRuns(rows) {
  const sorted = [...rows].sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
  const runs = [];
  let cur = null;
  for (const r of sorted) {
    if (!cur || cur.won !== r.won) {
      if (cur) runs.push(cur);
      cur = { won: r.won, len: 1, start: r.iso, end: r.iso, items: [r] };
    } else {
      cur.len += 1;
      cur.end = r.iso;
      cur.items.push(r);
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

function streakLengthDist(runs) {
  const win = {};
  const loss = {};
  for (const r of runs) {
    const bag = r.won ? win : loss;
    bag[r.len] = (bag[r.len] || 0) + 1;
  }
  return { win, loss };
}

/**
 * After a win streak of length L ends (next is loss), what's P(next also loss)?
 * More useful: conditional WR of trade t given last k results.
 */
function conditionalAfterStreak(rows) {
  const sorted = [...rows].sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
  const out = {
    afterWinStreak: {}, // key: streakLen before this trade (wins), value: {n,wins}
    afterLossStreak: {},
    afterNWinsThen: {}, // P(win | exactly N consecutive wins just before)
    afterNLossesThen: {},
    // specifically: after a win streak of >=K, next trade WR
    afterWinGe: {},
    afterLossGe: {}
  };

  for (let i = 0; i < sorted.length; i++) {
    // count trailing streak before i
    if (i === 0) continue;
    let streak = 0;
    const prevWon = sorted[i - 1].won;
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].won === prevWon) streak += 1;
      else break;
    }
    const bag = prevWon ? out.afterWinStreak : out.afterLossStreak;
    const key = String(Math.min(streak, 8));
    if (!bag[key]) bag[key] = { n: 0, wins: 0 };
    bag[key].n += 1;
    if (sorted[i].won) bag[key].wins += 1;

    const named = prevWon ? out.afterNWinsThen : out.afterNLossesThen;
    if (!named[key]) named[key] = { n: 0, wins: 0 };
    named[key].n += 1;
    if (sorted[i].won) named[key].wins += 1;
  }

  for (const K of [1, 2, 3, 4, 5]) {
    out.afterWinGe[K] = { n: 0, wins: 0 };
    out.afterLossGe[K] = { n: 0, wins: 0 };
  }
  for (let i = 1; i < sorted.length; i++) {
    let streak = 0;
    const prevWon = sorted[i - 1].won;
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].won === prevWon) streak += 1;
      else break;
    }
    for (const K of [1, 2, 3, 4, 5]) {
      if (streak < K) continue;
      const bag = prevWon ? out.afterWinGe[K] : out.afterLossGe[K];
      bag.n += 1;
      if (sorted[i].won) bag.wins += 1;
    }
  }
  return { sorted, ...out };
}

function printCond(title, bag) {
  console.log(`\n=== ${title} ===`);
  for (const k of Object.keys(bag).sort((a, b) => Number(a) - Number(b))) {
    const { n, wins } = bag[k];
    if (n < 5) continue;
    const wr = ((wins / n) * 100).toFixed(1);
    console.log(`streak=${k}  next n=${n}  nextWR=${wr}%  (${wins}W/${n - wins}L)`);
  }
}

/** Simulate skip rules on chronological series (equal weight, ignore sizing). */
function simulateSkips(rows) {
  const sorted = [...rows].sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
  const baseline = wrStats(sorted);

  function run(predicate, name) {
    const taken = [];
    const skipped = [];
    let winStreak = 0;
    let lossStreak = 0;
    for (const r of sorted) {
      const skip = predicate({ r, winStreak, lossStreak, hour: r.hour });
      if (skip) skipped.push(r);
      else taken.push(r);
      if (r.won) {
        winStreak += 1;
        lossStreak = 0;
      } else {
        lossStreak += 1;
        winStreak = 0;
      }
      // note: streak updates even if skipped — "market reality"; for skip-after-win we update only if taken?
      // Use wall-clock streak of *taken outcomes only* for trading skip, but for analysis of "after win streak" use all settled.
    }
    // Recompute with streak only on taken trades (realistic bot state)
    const taken2 = [];
    const skipped2 = [];
    winStreak = 0;
    lossStreak = 0;
    for (const r of sorted) {
      const skip = predicate({ r, winStreak, lossStreak, hour: r.hour });
      if (skip) {
        skipped2.push(r);
        continue;
      }
      taken2.push(r);
      if (r.won) {
        winStreak += 1;
        lossStreak = 0;
      } else {
        lossStreak += 1;
        winStreak = 0;
      }
    }
    const t = wrStats(taken2);
    const s = wrStats(skipped2);
    console.log(
      `${name.padEnd(42)} take n=${String(t.n).padStart(3)} WR=${t.wr == null ? 'n/a' : `${(t.wr * 100).toFixed(1)}%`.padStart(6)} PnL=${String(t.pnl).padStart(8)} | skip n=${s.n} skipWR=${s.wr == null ? 'n/a' : `${(s.wr * 100).toFixed(1)}%`} skipPnL=${s.pnl}`
    );
    return { name, taken: t, skipped: s };
  }

  console.log(`\n=== Skip simulations (equal-weight chronological) ===`);
  console.log(`baseline n=${baseline.n} WR=${(baseline.wr * 100).toFixed(1)}% PnL=${baseline.pnl}`);

  run(() => false, 'no_skip');
  run(({ winStreak }) => winStreak >= 2, 'skip_after_2_wins');
  run(({ winStreak }) => winStreak >= 3, 'skip_after_3_wins');
  run(({ lossStreak }) => lossStreak >= 2, 'skip_after_2_losses');
  run(({ lossStreak }) => lossStreak >= 3, 'skip_after_3_losses');
  run(({ winStreak }) => winStreak >= 2, 'skip_next_only_after_2_wins_BUG'); // same as after 2 wins while streak held

  // skip exactly 1 trade after win streak >=2
  {
    const taken2 = [];
    const skipped2 = [];
    let winStreak = 0;
    let lossStreak = 0;
    let skipRemaining = 0;
    for (const r of sorted) {
      if (skipRemaining > 0) {
        skipped2.push(r);
        skipRemaining -= 1;
        // do not update streak from skipped? use market outcome anyway for honesty
        if (r.won) {
          winStreak += 1;
          lossStreak = 0;
        } else {
          lossStreak += 1;
          winStreak = 0;
        }
        continue;
      }
      taken2.push(r);
      if (r.won) {
        winStreak += 1;
        lossStreak = 0;
        if (winStreak >= 2) skipRemaining = 1;
      } else {
        lossStreak += 1;
        winStreak = 0;
      }
    }
    const t = wrStats(taken2);
    const s = wrStats(skipped2);
    console.log(
      `${'skip_1_trade_after_2wins'.padEnd(42)} take n=${String(t.n).padStart(3)} WR=${`${(t.wr * 100).toFixed(1)}%`.padStart(6)} PnL=${String(t.pnl).padStart(8)} | skip n=${s.n} skipWR=${`${(s.wr * 100).toFixed(1)}%`} skipPnL=${s.pnl}`
    );
  }

  // skip 1 after 3 wins
  {
    const taken2 = [];
    const skipped2 = [];
    let winStreak = 0;
    let skipRemaining = 0;
    for (const r of sorted) {
      if (skipRemaining > 0) {
        skipped2.push(r);
        skipRemaining -= 1;
        if (r.won) winStreak += 1;
        else winStreak = 0;
        continue;
      }
      taken2.push(r);
      if (r.won) {
        winStreak += 1;
        if (winStreak >= 3) skipRemaining = 1;
      } else winStreak = 0;
    }
    const t = wrStats(taken2);
    const s = wrStats(skipped2);
    console.log(
      `${'skip_1_trade_after_3wins'.padEnd(42)} take n=${String(t.n).padStart(3)} WR=${t.n ? `${(t.wr * 100).toFixed(1)}%`.padStart(6) : 'n/a'} PnL=${String(t.pnl).padStart(8)} | skip n=${s.n} skipWR=${s.n ? `${(s.wr * 100).toFixed(1)}%` : 'n/a'} skipPnL=${s.pnl}`
    );
  }

  // hour blacklist: hours with WR < 45% and n>=8
  const byHour = groupBy(sorted, (r) => r.hour);
  const badHours = new Set();
  for (const [h, list] of byHour) {
    const s = wrStats(list);
    if (s.n >= 8 && s.wr < 0.45) badHours.add(h);
  }
  run(({ hour }) => badHours.has(hour), `skip_bad_hours_${[...badHours].sort((a, b) => a - b).join(',') || 'none'}`);

  // hour whitelist: only hours WR>=55% n>=8
  const goodHours = new Set();
  for (const [h, list] of byHour) {
    const s = wrStats(list);
    if (s.n >= 8 && s.wr >= 0.55) goodHours.add(h);
  }
  run(({ hour }) => goodHours.size > 0 && !goodHours.has(hour), `only_good_hours_${[...goodHours].sort((a, b) => a - b).join(',') || 'none'}`);
}

function markovFlip(rows) {
  const sorted = [...rows].sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
  let ww = 0;
  let wl = 0;
  let lw = 0;
  let ll = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1].won;
    const b = sorted[i].won;
    if (a && b) ww += 1;
    else if (a && !b) wl += 1;
    else if (!a && b) lw += 1;
    else ll += 1;
  }
  const afterW = ww + wl;
  const afterL = lw + ll;
  console.log('\n=== Markov P(next|prev) ===');
  console.log(`P(W|W)=${afterW ? (ww / afterW * 100).toFixed(1) : 'n/a'}%  P(L|W)=${afterW ? (wl / afterW * 100).toFixed(1) : 'n/a'}%  (n=${afterW})`);
  console.log(`P(W|L)=${afterL ? (lw / afterL * 100).toFixed(1) : 'n/a'}%  P(L|L)=${afterL ? (ll / afterL * 100).toFixed(1) : 'n/a'}%  (n=${afterL})`);
  console.log(`baseline WR=${(wrStats(sorted).wr * 100).toFixed(1)}%`);
  // If independent, P(L|W) ≈ 1-WR. Compare.
  const base = wrStats(sorted).wr;
  if (afterW) {
    const pLw = wl / afterW;
    console.log(`independence check: P(L|W)- (1-WR) = ${(pLw - (1 - base)).toFixed(3)}  (>0 means more likely to lose after win than base)`);
  }
  if (afterL) {
    const pLl = ll / afterL;
    console.log(`independence check: P(L|L)- (1-WR) = ${(pLl - (1 - base)).toFixed(3)}  (>0 means loss streaks cluster)`);
  }
}

function sameSlotMulti(rows) {
  // group by slot roughly: floor time to 5m
  const sorted = [...rows].sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
  const slots = new Map();
  for (const r of sorted) {
    const t = new Date(r.iso).getTime();
    const slot = Math.floor(t / (5 * 60 * 1000));
    const key = `${slot}|${r.timeframe}|${r.direction}`;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(r);
  }
  let multi = 0;
  let multiAllLose = 0;
  let multiAllWin = 0;
  let multiMixed = 0;
  for (const list of slots.values()) {
    if (list.length < 2) continue;
    multi += 1;
    const wins = list.filter((x) => x.won).length;
    if (wins === 0) multiAllLose += 1;
    else if (wins === list.length) multiAllWin += 1;
    else multiMixed += 1;
  }
  console.log('\n=== Same ~5m bucket multi-symbol (same direction) ===');
  console.log(`multi buckets=${multi}  allWin=${multiAllWin}  allLose=${multiAllLose}  mixed=${multiMixed}`);
  if (multi) {
    console.log(`allLose rate=${((multiAllLose / multi) * 100).toFixed(1)}%  (correlated dump risk)`);
  }
}

// --- main ---
const live = normalize(loadLivePlan5(), 'live');
const dbAll = normalize(loadDbPlan5(), 'db');
const dbLive = dbAll.filter((r) => r.source === 'live');
const dbPaper = dbAll.filter((r) => r.source === 'paper');

console.log('Plan5 sample sizes:');
console.log(`  live-state settled: ${live.length}`);
console.log(`  statsDb plan5: ${dbAll.length} (live=${dbLive.length}, paper=${dbPaper.length})`);

const primary = dbLive.length >= 20 ? dbLive : (live.length >= 10 ? live : dbAll);
const label = dbLive.length >= 20 ? 'statsDb live' : (live.length >= 10 ? 'live-state' : 'statsDb all');
console.log(`\nUsing primary sample: ${label} n=${primary.length}`);
console.log('overall', wrStats(primary));

printGroup('WR by Shanghai hour', groupBy(primary, (r) => `${String(r.hour).padStart(2, '0')}:00`), 3);
printGroup('WR by weekday', groupBy(primary, (r) => r.weekday), 3);
printGroup('WR by symbol', groupBy(primary, (r) => r.symbol), 3);
printGroup('WR by timeframe', groupBy(primary, (r) => r.timeframe), 3);
printGroup('WR by entry price band', groupBy(primary, (r) => {
  const p = r.entryPrice;
  if (p < 0.55) return '<0.55';
  if (p < 0.60) return '0.55-0.60';
  if (p < 0.70) return '0.60-0.70';
  if (p < 0.80) return '0.70-0.80';
  if (p < 0.90) return '0.80-0.90';
  return '>=0.90';
}), 3);

const runs = streakRuns(primary);
const dist = streakLengthDist(runs);
console.log('\n=== Streak length distribution (runs) ===');
console.log('win runs', dist.win);
console.log('loss runs', dist.loss);
const longWin = runs.filter((r) => r.won && r.len >= 3);
const longLoss = runs.filter((r) => !r.won && r.len >= 3);
console.log(`runs with win streak>=3: ${longWin.length}; loss streak>=3: ${longLoss.length}`);

// After long win run, what is the next run?
let afterLongWinNextLossRun = 0;
let afterLongWinNextWinRun = 0;
for (let i = 0; i < runs.length - 1; i++) {
  if (runs[i].won && runs[i].len >= 2) {
    if (runs[i + 1].won) afterLongWinNextWinRun += 1;
    else afterLongWinNextLossRun += 1;
  }
}
console.log(`after win-run>=2, next run is LOSS: ${afterLongWinNextLossRun}, WIN: ${afterLongWinNextWinRun}`);

const cond = conditionalAfterStreak(primary);
printCond('Next trade WR after N consecutive WINS', cond.afterNWinsThen);
printCond('Next trade WR after N consecutive LOSSES', cond.afterNLossesThen);
console.log('\n=== Next WR after win streak >= K ===');
for (const [k, v] of Object.entries(cond.afterWinGe)) {
  if (v.n < 5) continue;
  console.log(`K>=${k}  n=${v.n}  WR=${((v.wins / v.n) * 100).toFixed(1)}%`);
}
console.log('\n=== Next WR after loss streak >= K ===');
for (const [k, v] of Object.entries(cond.afterLossGe)) {
  if (v.n < 5) continue;
  console.log(`K>=${k}  n=${v.n}  WR=${((v.wins / v.n) * 100).toFixed(1)}%`);
}

markovFlip(primary);
sameSlotMulti(primary);
simulateSkips(primary);

// Also paper for comparison if enough
if (dbPaper.length >= 30) {
  console.log('\n\n######## PAPER comparison ########');
  console.log('paper overall', wrStats(dbPaper));
  markovFlip(dbPaper);
  printGroup('PAPER WR by hour', groupBy(dbPaper, (r) => `${String(r.hour).padStart(2, '0')}:00`), 5);
  simulateSkips(dbPaper);
}
