import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { settlementFromUsMarket } from './brti.js';
import { calibrationRecord } from './calibration.js';
import { appendJsonl } from './ledger.js';
import { readJsonl, usPaths } from './signals.js';
import { formatPtLabel, ptDateKey, ptParts } from './time.js';

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isUsRealOrder(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.paper === true || row.venue === 'paper' || row.venue === 'intl' || row.source === 'gamma' || row.source === 'intl') {
    return false;
  }
  const url = String(row.event_url || row.url || '');
  if (/gamma-api\.polymarket\.com|clob\.polymarket\.com|polymarket\.com\/event\//.test(url) && !url.includes('polymarket.us')) {
    return false;
  }
  return row.venue === 'polymarket.us' || url.includes('polymarket.us') || row.line === 'us';
}

export function applyOfficialSettlement(order, official) {
  if (!official) return order;
  const polarity = official.direction;
  const side = String(order.side || '').toLowerCase();
  const won = polarity === 'up'
    ? ['up', 'yes'].includes(side)
    : polarity === 'down'
      ? ['down', 'no'].includes(side)
      : null;
  if (won == null) return order;
  const usd = finite(order.size_usd ?? order.usd);
  const shares = finite(order.shares);
  const price = finite(order.limit_price ?? order.price);
  let pnl = finite(order.pnl_usd);
  if (pnl == null && usd != null) {
    if (won) pnl = shares != null ? round2(shares - usd) : (price > 0 && price < 1 ? round2(usd * (1 / price - 1)) : null);
    else pnl = round2(-usd);
  }
  return {
    ...order,
    won,
    pnl_usd: pnl,
    official_outcome: official.officialOutcome,
    settlement_source: official.source,
    status: 'filled'
  };
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function percent(wins, decisive) {
  if (!decisive) return null;
  const rounded = Math.round((wins / decisive) * 1000) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function money(value) {
  const rounded = round2(value);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${sign}${Math.abs(rounded).toFixed(2)}美元`;
}

export function summarizeUsSettlements(orders, { now = new Date(), previousLine = '' } = {}) {
  const us = (orders || []).filter(isUsRealOrder);
  const settled = us.filter((row) => row.won === true || row.won === false || row.void === true);
  const today = ptDateKey(now);
  const freshRows = settled.filter((row) => (row.settled_pt_date || row.pt_date) === today && row.settlement_counted !== false);
  const count = (rows) => ({
    count: rows.length,
    wins: rows.filter((row) => row.won === true).length,
    losses: rows.filter((row) => row.won === false).length,
    voids: rows.filter((row) => row.void === true).length
  });
  const fresh = count(freshRows);
  const cumulative = count(settled);
  const pnlValues = freshRows.map((row) => finite(row.pnl_usd)).filter((value) => value != null);
  fresh.pnl = pnlValues.length === freshRows.length && freshRows.length ? round2(pnlValues.reduce((sum, value) => sum + value, 0)) : null;
  const decisive = cumulative.wins + cumulative.losses;
  const parts = ptParts(now);
  const head = `${formatPtLabel(now)}结算：`;
  const cum = decisive
    ? `累计${decisive}笔，胜率${percent(cumulative.wins, decisive)}`
    : cumulative.count
      ? `累计${cumulative.count}笔，尚无胜负`
      : '累计尚无已结算订单';
  let line;
  if (!fresh.count) line = `${head}无新结算；${cum}。`;
  else {
    let mid = `新增${fresh.count}笔，胜${fresh.wins}负${fresh.losses}`;
    if (fresh.voids) mid += `作废${fresh.voids}`;
    if (fresh.pnl != null) mid += `，当日盈亏${money(fresh.pnl)}`;
    line = `${head}${mid}；${cum}。`;
  }
  return {
    line,
    changed: line !== previousLine,
    ptDate: today,
    month: parts.month,
    day: parts.day,
    fresh,
    cumulative: { ...cumulative, decisive }
  };
}

export async function runUsDigest({
  ledgerRoot,
  now = new Date(),
  lookup
} = {}) {
  const paths = usPaths(ledgerRoot);
  const orders = await readJsonl(paths.realOrders);
  const resolved = [];
  let dirty = false;
  for (const order of orders) {
    if (!isUsRealOrder(order) || order.won === true || order.won === false || order.void === true) {
      resolved.push(order);
      continue;
    }
    let official = null;
    if (lookup && order.slug) {
      try {
        official = settlementFromUsMarket(await lookup(order.slug));
      } catch {
        official = null;
      }
    }
    const next = official ? applyOfficialSettlement(order, official) : order;
    if (next.won !== true && next.won !== false) {
      resolved.push(order);
      continue;
    }
    next.settled_pt_date = ptDateKey(now);
    next.settled_at = next.settled_at || now.toISOString();
    dirty = true;
    resolved.push(next);
  }
  const calibrationRows = [];
  for (const order of resolved) {
    if (!isUsRealOrder(order) || order.calibration_logged === true) continue;
    if (order.won !== true && order.won !== false) continue;
    order.settled_at = order.settled_at || now.toISOString();
    calibrationRows.push(calibrationRecord(order, order.settled_at));
    order.calibration_logged = true;
    dirty = true;
  }
  if (calibrationRows.length) {
    for (const row of calibrationRows) await appendJsonl(paths.calibration, row);
  }
  if (dirty) {
    await mkdir(dirname(paths.realOrders), { recursive: true });
    await writeFile(paths.realOrders, `${resolved.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }
  let previous = '';
  const nightlyPath = join(paths.digests, 'nightly.txt');
  try {
    previous = (await readFile(nightlyPath, 'utf8')).trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const summary = summarizeUsSettlements(resolved, { now, previousLine: previous });
  await mkdir(paths.digests, { recursive: true });
  const settlementPath = join(ledgerRoot, `nightly-settlement-${summary.ptDate}.json`);
  await writeFile(settlementPath, `${JSON.stringify({
    venue: 'polymarket.us',
    source: 'gateway.polymarket.us + real-orders.jsonl',
    spec_version: '3.5',
    ...summary
  }, null, 2)}\n`);
  if (summary.changed) await writeFile(nightlyPath, `${summary.line}\n`);
  await writeFile(join(paths.digests, 'nightly.meta.json'), `${JSON.stringify({
    changed: summary.changed,
    line: summary.line,
    generatedAt: now.toISOString()
  }, null, 2)}\n`);
  return { ...summary, nightlyPath, settlementPath };
}
