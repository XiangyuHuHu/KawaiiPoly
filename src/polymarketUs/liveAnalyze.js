/**
 * 从 live-observations.jsonl 和结算文件复现「门槛 × 价格帽」ROI 网格。
 * 每个市场×方向只取第一次满足条件的观察，按当时卖价买 $1。赢 (1-ask)/ask，输 -1。
 * 默认门槛从 0.60 起，覆盖研究带；价格帽仍是 0.90 / 0.93 / 0.95 / 0.99。
 */

import { US_LIVE_ANALYZE_CAPS, US_LIVE_ANALYZE_THRESHOLDS } from './constants.js';

export const DEFAULT_OBSERVATION_THRESHOLDS = US_LIVE_ANALYZE_THRESHOLDS;
export const DEFAULT_OBSERVATION_CAPS = US_LIVE_ANALYZE_CAPS;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function indexSettlements(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.market_slug) continue;
    map.set(row.market_slug, row);
  }
  return map;
}

export function selectFirst(rows = [], pred) {
  const ordered = [...rows].sort((left, right) => String(left?.ts_utc || '').localeCompare(String(right?.ts_utc || '')));
  const pick = new Map();
  for (const row of ordered) {
    if (!row?.market_slug || !row?.side || !pred(row)) continue;
    const key = `${row.market_slug}|${row.side}`;
    if (!pick.has(key)) pick.set(key, row);
  }
  return [...pick.values()];
}

export function stakePnl(ask, won) {
  const price = finite(ask);
  if (price == null || !(price > 0.02 && price < 0.995)) return null;
  return won ? (1 - price) / price : -1;
}

export function summarizePicks(picks, settledBySlug) {
  const used = [];
  for (const row of picks) {
    const settled = settledBySlug.get(row.market_slug);
    if (!settled || settled.void === true || settled.yes_won == null) continue;
    const won = row.side === 'No' ? settled.yes_won === false : settled.yes_won === true;
    const pnl = stakePnl(row.ask, won);
    if (pnl == null) continue;
    used.push({ row, won, pnl, ask: Number(row.ask), model: finite(row.model_prob) });
  }
  const n = used.length;
  if (!n) return { n: 0, events: 0, hit: null, pnl: 0, roi: null, avg_px: null, avg_model: null };
  const pnl = used.reduce((sum, row) => sum + row.pnl, 0);
  const wins = used.filter((row) => row.won).length;
  const models = used.map((row) => row.model).filter((value) => value != null);
  return {
    n,
    events: new Set(used.map((row) => row.row.event_slug || row.row.market_slug)).size,
    hit: wins / n,
    pnl,
    roi: pnl / n,
    avg_px: used.reduce((sum, row) => sum + row.ask, 0) / n,
    avg_model: models.length ? models.reduce((sum, value) => sum + value, 0) / models.length : null
  };
}

export function observationGrid(rows, settlements, {
  phase = 'endgame',
  sport = null,
  thresholds = DEFAULT_OBSERVATION_THRESHOLDS,
  caps = DEFAULT_OBSERVATION_CAPS
} = {}) {
  const settledBySlug = settlements instanceof Map ? settlements : indexSettlements(settlements);
  const table = [];
  for (const threshold of thresholds) {
    for (const cap of caps) {
      const picks = selectFirst(rows, (row) => {
        if (phase && row.phase !== phase) return false;
        if (sport && row.sport !== sport) return false;
        const model = finite(row.model_prob);
        const ask = finite(row.ask);
        if (model == null || ask == null) return false;
        return model + 1e-12 >= threshold && ask <= cap + 1e-12;
      });
      table.push({
        phase: phase || 'any',
        sport: sport || 'any',
        threshold,
        cap,
        ...summarizePicks(picks, settledBySlug)
      });
    }
  }
  return table;
}

export function formatGrid(table = []) {
  const lines = ['phase sport T cap n events hit pnl roi avg_px avg_model'];
  for (const row of table) {
    const hit = row.hit == null ? 'n/a' : `${(row.hit * 100).toFixed(1)}%`;
    const roi = row.roi == null ? 'n/a' : `${(row.roi * 100).toFixed(1)}%`;
    const pnl = row.n ? row.pnl.toFixed(2) : '0';
    const px = row.avg_px == null ? 'n/a' : row.avg_px.toFixed(3);
    const model = row.avg_model == null ? 'n/a' : row.avg_model.toFixed(3);
    lines.push(`${row.phase} ${row.sport} ${row.threshold.toFixed(2)} ${row.cap.toFixed(2)} ${row.n} ${row.events} ${hit} ${pnl} ${roi} ${px} ${model}`);
  }
  return lines.join('\n');
}
