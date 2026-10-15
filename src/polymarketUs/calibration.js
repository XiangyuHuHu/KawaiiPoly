import {
  US_BTC_MISPRICE_MODEL_WEIGHT,
  US_DAILY_CAPS,
  US_SECTOR_BRAKE_MS,
  US_SECTOR_BRAKE_TRADES,
  US_SECTOR_BRAKE_WIN_RATE
} from './constants.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendJsonl, readJsonl, writeJsonAtomic } from './ledger.js';
import { normalizeSector } from './shape.js';
import { usPaths } from './signals.js';

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function round4(value) {
  const number = finite(value);
  if (number == null) return null;
  return Math.round(number * 1e4) / 1e4;
}

function isDownSide(side) {
  return ['no', 'n', 'down', 'short', 'below', 'lower'].includes(String(side || '').trim().toLowerCase());
}

/**
 * 该方向的盘口中间价。有买卖价时用中间价；只有卖价时用卖价，收缩会更保守。
 */
export function marketProbability({ side, ask, bid, quote } = {}) {
  const yesBid = finite(quote?.bestBid);
  const yesAsk = finite(quote?.bestAsk);
  if (yesBid != null && yesAsk != null && yesBid > 0 && yesAsk > 0 && yesBid < 1 && yesAsk < 1) {
    const yesMid = (yesBid + yesAsk) / 2;
    const mid = isDownSide(side) ? 1 - yesMid : yesMid;
    if (mid > 0 && mid < 1) return mid;
  }
  const sideAsk = finite(ask);
  const sideBid = finite(bid ?? quote?.bid);
  if (sideAsk != null && sideBid != null && sideAsk > 0 && sideBid > 0 && sideAsk < 1 && sideBid < 1) {
    return (sideAsk + sideBid) / 2;
  }
  if (sideAsk != null && sideAsk > 0 && sideAsk < 1) return sideAsk;
  return null;
}

/**
 * p_used = weight * model + (1 - weight) * market。
 * 缺市场价时不收缩，沿用模型。缺模型时没有可用概率。
 */
export function blendModelToMarket(model, market, weight = US_BTC_MISPRICE_MODEL_WEIGHT) {
  const modelP = finite(model);
  const marketP = finite(market);
  if (modelP == null) return { modelP: null, marketP, pUsed: null };
  if (marketP == null) return { modelP, marketP: null, pUsed: modelP };
  const mix = Number.isFinite(weight) ? weight : US_BTC_MISPRICE_MODEL_WEIGHT;
  return {
    modelP,
    marketP,
    pUsed: mix * modelP + (1 - mix) * marketP
  };
}

export function settledOutcome(order) {
  if (!order || order.dry_run === true || order.paper === true || order.void === true) return null;
  if (order.won === true) return true;
  if (order.won === false) return false;
  const label = String(order.result || order.settlement || '').toLowerCase();
  if (label === 'win') return true;
  if (label === 'loss') return false;
  const pnl = finite(order.pnl_usd ?? order.pnl);
  if (pnl == null) return null;
  return pnl > 0;
}

export function realizedPnl(order, won = settledOutcome(order)) {
  const pnl = finite(order?.pnl_usd ?? order?.pnl);
  if (pnl != null) return pnl;
  if (won == null) return null;
  const usd = finite(order?.size_usd ?? order?.amount_usd ?? order?.usd);
  if (usd == null) return null;
  if (!won) return Math.round(-usd * 100) / 100;
  const shares = finite(order?.shares);
  if (shares != null) return Math.round((shares - usd) * 100) / 100;
  const price = finite(order?.entry ?? order?.limit_price ?? order?.price);
  if (price != null && price > 0 && price < 1) return Math.round(usd * (1 / price - 1) * 100) / 100;
  return null;
}

function settledStamp(order) {
  const candidates = [order?.settled_at, order?.time_utc, order?.time_pt];
  for (const value of candidates) {
    const ms = Date.parse(value || '');
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

export function lastSettledTrades(orders, sector, limit = US_SECTOR_BRAKE_TRADES) {
  const key = normalizeSector(sector);
  return (orders || [])
    .filter((order) => normalizeSector(order?.sector) === key && settledOutcome(order) != null)
    .slice()
    .sort((left, right) => settledStamp(left) - settledStamp(right))
    .slice(-limit);
}

export function sectorBrakeFromTrades(trades, sample = US_SECTOR_BRAKE_TRADES) {
  if (!Array.isArray(trades) || trades.length < sample) return null;
  const recent = trades.slice(-sample);
  const wins = recent.filter((order) => settledOutcome(order) === true).length;
  const losses = recent.length - wins;
  const winRate = wins / recent.length;
  if (!(winRate < US_SECTOR_BRAKE_WIN_RATE)) return null;
  const pnls = recent.map((order) => realizedPnl(order));
  if (pnls.some((value) => value == null)) return null;
  const pnlUsd = Math.round(pnls.reduce((sum, value) => sum + value, 0) * 100) / 100;
  if (!(pnlUsd < 0)) return null;
  return { wins, losses, winRate, pnlUsd, sample: recent.length };
}

export function evaluateSectorBrakes(orders, persisted, now = new Date()) {
  const nowMs = now.getTime();
  const sectors = { ...(persisted?.sectors || {}) };
  const paused = {};
  const events = [];
  for (const sector of Object.keys(US_DAILY_CAPS)) {
    const current = sectors[sector];
    const until = Date.parse(current?.pausedUntil || '');
    if (Number.isFinite(until) && until > nowMs) {
      paused[sector] = current;
      continue;
    }
    const trip = sectorBrakeFromTrades(lastSettledTrades(orders, sector));
    if (trip) {
      const next = {
        pausedUntil: new Date(nowMs + US_SECTOR_BRAKE_MS).toISOString(),
        trippedAt: now.toISOString(),
        wins: trip.wins,
        losses: trip.losses,
        winRate: trip.winRate,
        pnlUsd: trip.pnlUsd,
        sample: trip.sample
      };
      sectors[sector] = next;
      paused[sector] = next;
      events.push({ event: 'pause', sector, ...next });
    } else if (current) {
      delete sectors[sector];
      events.push({ event: 'clear', sector, trippedAt: current.trippedAt || null });
    }
  }
  return { sectors, paused, events };
}

export function sectorBrakeReason(sector, pause) {
  const wins = pause?.wins ?? 0;
  const sample = pause?.sample ?? US_SECTOR_BRAKE_TRADES;
  const rate = sample ? Math.round((wins / sample) * 1000) / 10 : 0;
  const pnl = Number(pause?.pnlUsd);
  const pnlText = Number.isFinite(pnl) ? pnl.toFixed(2) : '未知';
  return `${sector} 最近 ${sample} 笔已结算胜率 ${rate}% 且盈亏 ${pnlText} 美元，暂停新单至 ${pause?.pausedUntil}。`;
}

function brakeFile(ledgerRoot) {
  return join(usPaths(ledgerRoot).status, 'sector-brakes.json');
}

function brakeLog(ledgerRoot) {
  return join(usPaths(ledgerRoot).status, 'sector-brakes.jsonl');
}

async function readBrakeState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { sectors: {} };
  }
}

export async function syncSectorBrakes(ledgerRoot, now = new Date()) {
  if (!ledgerRoot) return { sectors: {}, paused: {}, events: [] };
  const orders = await readJsonl(usPaths(ledgerRoot).realOrders);
  const persisted = await readBrakeState(brakeFile(ledgerRoot));
  const next = evaluateSectorBrakes(orders, persisted, now);
  if (next.events.length) {
    await writeJsonAtomic(brakeFile(ledgerRoot), {
      sectors: next.sectors,
      updatedAt: now.toISOString()
    });
    for (const event of next.events) {
      await appendJsonl(brakeLog(ledgerRoot), { ...event, at: now.toISOString() });
    }
  }
  return next;
}

export function calibrationRecord(order, settledAt = null) {
  const won = settledOutcome(order);
  return {
    order_id: order?.id || null,
    signal_id: order?.signal_id || null,
    sector: normalizeSector(order?.sector) || order?.sector || null,
    slug: order?.slug || null,
    side: order?.side || null,
    model_p: finite(order?.model_p),
    market_p: finite(order?.market_p),
    p_used: finite(order?.p_used),
    entry: finite(order?.entry ?? order?.limit_price ?? order?.price),
    outcome: won === true ? 'win' : won === false ? 'loss' : null,
    pnl_usd: realizedPnl(order, won),
    settled_at: order?.settled_at || settledAt || null
  };
}
