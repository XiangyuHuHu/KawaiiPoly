/**
 * 把过了尾盘试单的观察行写成 SIGNAL。这里不下单。
 * 下单仍走 polymarket:us；5 分钟的 us:live-observe 会接着只下这个板块。
 */

import { readFile } from 'node:fs/promises';
import { countV2CashFloorBreaches } from './cashReserve.js';
import { liveEndgameV2Enabled } from './constants.js';
import { syncSectorBrakes } from './calibration.js';
import { evaluateUsSignal } from './evaluate.js';
import { readJsonl } from './ledger.js';
import { normalizeOutcomeSide, normalizeSector, tradingSlug } from './shape.js';
import { publishUsSignal, usPaths } from './signals.js';
import { ptDateKey } from './time.js';

const FILLS = new Set(['submitted', 'filled', 'partial']);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowDate(row) {
  if (row?.pt_date) return String(row.pt_date);
  const match = String(row?.time_pt || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function isFill(row) {
  return FILLS.has(row?.fill_status) || FILLS.has(row?.status);
}

export async function publishLiveEndgameV2({
  rows = [],
  quotesBySlug = {},
  ledgerRoot,
  workspaceRoot,
  now = new Date(),
  rules
} = {}) {
  if (!liveEndgameV2Enabled()) return { published: 0, ids: [], signals: [], skipped: ['disabled'] };
  const brakes = await syncSectorBrakes(ledgerRoot, now);
  if (brakes.paused?.live_endgame_v2) {
    return { published: 0, ids: [], signals: [], skipped: ['sector-brake'] };
  }
  const paths = usPaths(ledgerRoot, workspaceRoot);
  const pending = await readJsonl(paths.pending);
  const orders = await readJsonl(paths.realOrders);
  const date = ptDateKey(now);
  let buyingPower = null;
  let breachFills = countV2CashFloorBreaches(orders, pending);
  try {
    const account = JSON.parse(await readFile(paths.account, 'utf8'));
    const value = Number(account?.buyingPower ?? account?.buying_power);
    buyingPower = Number.isFinite(value) ? value : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const takenMarkets = new Set();
  const oldSides = new Set();
  const noteTake = (row, fromOrder) => {
    const slug = tradingSlug(row?.slug || row?.market_slug);
    if (!slug) return;
    const sector = normalizeSector(row?.sector);
    const side = normalizeOutcomeSide(row?.side);
    if (sector === 'live_endgame_v2') takenMarkets.add(slug);
    const oldEndgame = sector === 'live' && (row?.endgame === true || row?.live_kind === 'endgame' || row?.live_phase === 'endgame');
    if (oldEndgame && side) oldSides.add(`${slug}|${side}`);
    if (fromOrder && sector === 'live_endgame_v2') takenMarkets.add(slug);
  };
  for (const order of orders) {
    if (order?.dry_run === true || rowDate(order) !== date || !isFill(order)) continue;
    noteTake(order, true);
  }
  for (const row of pending) {
    if (String(row?.status || 'pending') !== 'pending') continue;
    noteTake(row, false);
  }
  const filled = orders.filter((order) => (
    normalizeSector(order.sector) === 'live_endgame_v2'
    && order.dry_run !== true
    && rowDate(order) === date
    && isFill(order)
  )).length;
  let pendingCount = pending.filter((row) => (
    normalizeSector(row.sector) === 'live_endgame_v2' && String(row.status || 'pending') === 'pending'
  )).length;
  const candidates = rows
    .filter((row) => row?.rule_pass?.endgame_v2?.pass === true)
    .sort((left, right) => (Number(right.model_prob) || 0) - (Number(left.model_prob) || 0));
  const signals = [];
  const skipped = [];
  for (const row of candidates) {
    const slug = tradingSlug(row.market_slug);
    const side = normalizeOutcomeSide(row.side);
    if (takenMarkets.has(slug)) {
      skipped.push(`${slug}:market`);
      continue;
    }
    if (oldSides.has(`${slug}|${side}`)) {
      skipped.push(`${slug}:old-endgame`);
      continue;
    }
    const quote = quotesBySlug?.[row.market_slug] || {};
    const ask = finite(row.ask);
    const bid = finite(row.bid);
    const spreadCents = ask != null && bid != null ? Math.round((ask - bid) * 10000) / 100 : null;
    const age = finite(quote.cacheAgeMs);
    const decision = evaluateUsSignal({
      sector: 'live_endgame_v2',
      side: row.side,
      slug,
      ask,
      bid,
      spreadCents,
      modelProb: row.model_prob,
      depthUsd: row.ask_depth,
      liquidityUsd: row.ask_depth,
      resolutionRisk: 'Low',
      confidence: 'High',
      phase: row.phase,
      liveKind: 'endgame',
      espnProb: row.espn_prob,
      pinnacleProb: row.pinnacle_prob,
      scoreSampledAt: row.score_sampled_at,
      scoreAgeMs: row.score_age_ms,
      bboAgeMs: age != null ? age : 0,
      bboSampledAt: quote.sampledAt || quote.observedAt || now.toISOString(),
      now,
      ptDate: date,
      windowId: slug,
      expiresAt: new Date(now.getTime() + 45 * 60 * 1000).toISOString(),
      buyingPower,
      v2CashBreachFills: breachFills,
      dailyFilled: filled,
      dailyPending: pendingCount,
      basis: `Live 尾盘试单 v2：${row.sport || 'sports'} 模型 ${row.model_prob}，卖价 ${ask}。`,
      title: row.event_slug || slug
    }, rules);
    if (!decision.ok) {
      skipped.push(`${slug}:${decision.reason}`);
      continue;
    }
    const result = await publishUsSignal({ ledgerRoot, workspaceRoot, signal: decision.signal, now });
    if (!result.wrote) {
      skipped.push(`${slug}:${result.reason}`);
      continue;
    }
    signals.push({ id: decision.signal.id, slug, side: row.side });
    takenMarkets.add(slug);
    pendingCount += 1;
    if (decision.signal.v2_cash_floor_breach === true) breachFills += 1;
    if (buyingPower != null) buyingPower -= decision.signal.size_usd;
  }
  return { published: signals.length, ids: signals.map((row) => row.id), signals, skipped };
}
