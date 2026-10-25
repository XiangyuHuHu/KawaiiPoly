/**
 * 现金门。全局保留额仍是 US_CASH_RESERVE_USD（$15）。
 * live_endgame_v2 另有 $14 地板：购买力够付这一笔，且下单后不低于 $14。
 * 下单后落在 [$14, $15) 算一次豁免，最多 1 笔，然后重新要求 $15。
 * 购买力小于下单金额是 insufficient_cash，不是现金保留。
 */

import {
  US_CASH_RESERVE_USD,
  US_COUNTED_FILL_STATUSES,
  US_LIVE_ENDGAME_V2_CASH_BREACH_MAX,
  US_LIVE_ENDGAME_V2_CASH_RESERVE_USD
} from './constants.js';

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isV2Sector(sector) {
  return String(sector || '').replace(/-/g, '_') === 'live_endgame_v2';
}

/**
 * @returns {{
 *   ok: boolean,
 *   code: 'insufficient_cash'|'cash_reserve'|null,
 *   reserve: number,
 *   checked: boolean,
 *   floorBreach: boolean,
 *   reenforce: boolean
 * }}
 */
export function evaluateUsCashReserve({
  buyingPower,
  sizeUsd,
  trial = false,
  globalReserve = US_CASH_RESERVE_USD,
  v2Reserve = US_LIVE_ENDGAME_V2_CASH_RESERVE_USD,
  breachFills = 0,
  maxBreachFills = US_LIVE_ENDGAME_V2_CASH_BREACH_MAX
} = {}) {
  const floor = finite(globalReserve) ?? US_CASH_RESERVE_USD;
  const trialFloor = finite(v2Reserve) ?? US_LIVE_ENDGAME_V2_CASH_RESERVE_USD;
  const size = finite(sizeUsd);
  const bp = finite(buyingPower);
  if (bp == null) {
    return {
      ok: true,
      code: null,
      reserve: trial ? trialFloor : floor,
      checked: false,
      floorBreach: false,
      reenforce: false
    };
  }
  if (size == null || !(size > 0) || bp + 1e-9 < size) {
    return {
      ok: false,
      code: 'insufficient_cash',
      reserve: trial ? trialFloor : floor,
      checked: true,
      floorBreach: false,
      reenforce: false
    };
  }
  const after = bp - size;
  if (!trial || after + 1e-9 >= floor) {
    if (after + 1e-9 < floor) {
      return {
        ok: false,
        code: 'cash_reserve',
        reserve: floor,
        checked: true,
        floorBreach: false,
        reenforce: false
      };
    }
    return {
      ok: true,
      code: null,
      reserve: floor,
      checked: true,
      floorBreach: false,
      reenforce: false
    };
  }
  const used = finite(breachFills) ?? 0;
  const max = finite(maxBreachFills) ?? US_LIVE_ENDGAME_V2_CASH_BREACH_MAX;
  if (used >= max) {
    return {
      ok: false,
      code: 'cash_reserve',
      reserve: floor,
      checked: true,
      floorBreach: false,
      reenforce: true
    };
  }
  if (after + 1e-9 < trialFloor) {
    return {
      ok: false,
      code: 'cash_reserve',
      reserve: trialFloor,
      checked: true,
      floorBreach: false,
      reenforce: false
    };
  }
  return {
    ok: true,
    code: null,
    reserve: trialFloor,
    checked: true,
    floorBreach: true,
    reenforce: false
  };
}

export function cashReserveSkipMessage({ cash, buyingPower, sizeUsd }) {
  if (cash?.code === 'insufficient_cash') return `可用资金 ${buyingPower} 不够 $${sizeUsd}。`;
  if (cash?.reenforce) return `试单现金豁免已用完，下单后现金将低于 $${cash.reserve} 保留额。`;
  return `下单后现金将低于 $${cash?.reserve} 保留额。`;
}

function breachIdentity(row) {
  if (!row || row.v2_cash_floor_breach !== true || row.dry_run === true) return null;
  if (!isV2Sector(row.sector)) return null;
  return String(row.signal_id || row.id || '');
}

/**
 * 已经占用试单现金豁免的笔数。
 * 真实成交（submitted / filled / partial）和仍 pending 的试单都算。
 * 同一 signal id 只算一次。dry-run 不算。
 */
export function countV2CashFloorBreaches(orders = [], pending = []) {
  const seen = new Set();
  let count = 0;
  const add = (row, kind) => {
    const id = breachIdentity(row);
    if (id == null) return;
    if (kind === 'order') {
      const status = row.fill_status || row.status;
      if (!US_COUNTED_FILL_STATUSES.includes(status)) return;
    } else if (String(row.status || 'pending') !== 'pending') {
      return;
    }
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    count += 1;
  };
  for (const order of orders) add(order, 'order');
  for (const row of pending) add(row, 'pending');
  return count;
}

/** 正在评估的这条 pending 自己带的豁免标记不要把自己挡掉。 */
export function v2BreachFillsForSignal(total, signal) {
  const count = finite(total) ?? 0;
  if (signal?.v2_cash_floor_breach === true && String(signal.status || 'pending') === 'pending') {
    return Math.max(0, count - 1);
  }
  return count;
}

const SKIP_BUCKETS = [
  ['insufficient_cash', /insufficient[_-]cash/],
  ['cash_reserve', /cash[_-]reserve/],
  ['stale_bbo', /stale[_-]bbo/],
  ['divergence', /divergence|sources_unavailable|espn_|pinnacle_|score_/],
  ['depth', /(^|:)depth$/],
  ['spread', /spread/],
  ['quote', /quote_unavailable|api_error/],
  ['daily_cap', /daily[_-]cap/],
  ['model', /model/],
  ['price', /price/],
  ['disabled', /disabled/],
  ['market', /one_per_market|duplicate_market|old-endgame|(^|:)market$/]
];

export function bucketV2SkipReason(raw) {
  const text = String(raw || '').trim().toLowerCase();
  const reason = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
  for (const [name, pattern] of SKIP_BUCKETS) {
    if (pattern.test(reason)) return name;
  }
  const cleaned = reason.replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '');
  return cleaned || 'other';
}

/** `cash_reserve:2,stale_bbo:1`。没有跳过或 defer 时是 `none`。可重试的行情失败也计数，但不会把 SIGNAL 标成 skipped。 */
export function formatV2SkipHistogram(reasons = []) {
  const counts = new Map();
  for (const raw of reasons) {
    if (raw == null || raw === '') continue;
    const key = bucketV2SkipReason(raw);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) return 'none';
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${key}:${count}`)
    .join(',');
}
