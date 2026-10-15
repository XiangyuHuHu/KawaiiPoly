import {
  US_BBO_MAX_AGE_MS,
  US_COUNTED_FILL_STATUSES,
  US_DAILY_CAPS,
  US_EDGE_BTC_MISPRICE,
  US_EDGE_LIVE_INPLAY,
  US_EDGE_STANDARD,
  US_LIVE_ENDGAME_MAX_PRICE,
  US_LIVE_ENDGAME_MIN_MODEL,
  US_LOSS_STREAK,
  US_MAX_SPREAD,
  US_MODEL_PROB_CAP,
  US_MOMENTUM_MAX_PRICE,
  US_MONDAY_LONG_WINDOW,
  US_PRICE_MAX,
  US_PRICE_MIN,
  US_LIVE_INPLAY_MAX_PRICE,
  US_SIZE_DEFAULT_USD,
  US_SIZE_WINRATE_70_USD,
  US_SIZE_WINRATE_80_USD,
  US_SPEC_VERSION,
  US_WEEKDAY_WINDOWS,
  US_WINRATE_70,
  US_WINRATE_80,
  US_WINRATE_FLOOR,
  US_WINRATE_SAMPLES_70,
  US_WINRATE_SAMPLES_80
} from './constants.js';
import {
  eventUrlForSignal,
  isInternationalEventUrl,
  isKnownSector,
  normalizeOutcomeSide,
  normalizeSector,
  readNumber,
  signalIdentity,
  tradingSlug,
  windowKey
} from './shape.js';
import { quoteForSide } from './gateway.js';
import { cleanerEdgeFloor, US_RULES } from './rules.js';
import { describeSession } from './time.js';
import { sizeUsLimitBuy } from './trading.js';

export function pacificParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const weekday = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    weekday,
    isWeekend: weekday === 'Sat' || weekday === 'Sun',
    isMonday: weekday === 'Mon',
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute,
    second: get('second'),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: hour * 60 + minute
  };
}

export function formatPacificTimestamp(date) {
  const parts = pacificParts(date);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.dateKey}T${pad(parts.hour)}:${pad(parts.minute)}:${parts.second} PT`;
}

function inWindow(minutesOfDay, window, spanMinutes) {
  const start = window.hour * 60 + window.minute;
  return minutesOfDay >= start && minutesOfDay < start + spanMinutes;
}

export function isLongHorizonSignal(signal) {
  return signal?.long_horizon === true
    || signal?.horizon === 'long'
    || normalizeSector(signal?.sector) === 'master';
}

function isBtcShortSector(signal) {
  const sector = normalizeSector(signal?.sector);
  return sector === 'btc_misprice' || sector === 'momentum';
}

/**
 * 周末全开。工作日 8:37 / 12:37 / 18:37 全板块可下单。
 * 工作日 BTC 短周期密集窗为 24/7（用户 2026-10-15），只放 BTC 错价和动量，其它板块仍等三个窗口。
 * 周一 8:50 额外允许偏长期（master / long_horizon）。
 */
export function evaluateUsSchedule(now, signal, windowMinutes) {
  const parts = pacificParts(now);
  if (parts.isWeekend) {
    return { open: true, code: 'weekend', windowId: 'weekend', parts };
  }
  const span = Number(windowMinutes) || 15;
  const general = US_WEEKDAY_WINDOWS.find((window) => inWindow(parts.minutesOfDay, window, span));
  if (general) {
    return { open: true, code: 'weekday', windowId: general.id, parts };
  }
  if (parts.isMonday && isLongHorizonSignal(signal) && inWindow(parts.minutesOfDay, US_MONDAY_LONG_WINDOW, span)) {
    return { open: true, code: 'monday_long', windowId: US_MONDAY_LONG_WINDOW.id, parts };
  }
  if (isBtcShortSector(signal) && describeSession(now, US_RULES).btcShortDense) {
    return { open: true, code: 'weekday_btc_dense', windowId: 'wd-btc-dense', parts };
  }
  return { open: false, code: 'outside_schedule', windowId: null, parts };
}

export function settlementResult(order) {
  const label = String(order?.result || order?.settlement || '').toLowerCase();
  if (label === 'win') return true;
  if (label === 'loss') return false;
  const pnl = readNumber(order?.pnl_usd, order?.pnl);
  if (pnl == null) return null;
  return pnl > 0;
}

export function summarizeSectorStats(orders = []) {
  const stats = Object.fromEntries(Object.keys(US_DAILY_CAPS).map((sector) => [sector, {
    wins: 0,
    losses: 0,
    samples: 0,
    winRate: null,
    streakLosses: 0
  }]));
  const settled = orders
    .filter((order) => !order?.dry_run && settlementResult(order) != null)
    .slice()
    .sort((a, b) => String(a.time_utc || a.time_pt || '').localeCompare(String(b.time_utc || b.time_pt || '')));
  for (const order of settled) {
    const sector = normalizeSector(order.sector);
    if (!stats[sector]) continue;
    if (settlementResult(order)) stats[sector].wins += 1;
    else stats[sector].losses += 1;
    stats[sector].samples += 1;
  }
  for (const [sector, bucket] of Object.entries(stats)) {
    bucket.winRate = bucket.samples ? bucket.wins / bucket.samples : null;
    const rows = settled.filter((order) => normalizeSector(order.sector) === sector);
    let streak = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (settlementResult(rows[index]) === false) streak += 1;
      else break;
    }
    bucket.streakLosses = streak;
  }
  return stats;
}

export function resolveUsSizeUsd(sector, stats, requestedUsd) {
  const bucket = stats?.[sector] || { samples: 0, winRate: null, streakLosses: 0 };
  const cold = (bucket.winRate != null && bucket.winRate < US_WINRATE_FLOOR) || bucket.streakLosses >= US_LOSS_STREAK;
  let tier = US_SIZE_DEFAULT_USD;
  if (!cold && bucket.samples >= US_WINRATE_SAMPLES_80 && bucket.winRate >= US_WINRATE_80) {
    tier = US_SIZE_WINRATE_80_USD;
  } else if (!cold && bucket.samples >= US_WINRATE_SAMPLES_70 && bucket.winRate >= US_WINRATE_70) {
    tier = US_SIZE_WINRATE_70_USD;
  }
  const asked = Number(requestedUsd);
  const sizeUsd = Math.min(tier, Number.isFinite(asked) && asked > 0 ? asked : tier);
  return { sizeUsd, tier, cold, winRate: bucket.winRate, samples: bucket.samples };
}

export function countSectorFills(orders, dateKey) {
  const counts = Object.fromEntries(Object.keys(US_DAILY_CAPS).map((sector) => [sector, 0]));
  for (const order of orders) {
    if (order?.dry_run) continue;
    if (!US_COUNTED_FILL_STATUSES.includes(order?.fill_status)) continue;
    if (!String(order?.time_pt || '').startsWith(dateKey)) continue;
    const sector = normalizeSector(order.sector);
    if (sector) counts[sector] += 1;
  }
  return counts;
}

function readSpread(signal, quote) {
  if (quote && Number.isFinite(quote.spread)) return quote.spread;
  const spread = readNumber(signal?.spread);
  if (spread != null && spread >= 0 && spread <= 1) return spread;
  const cents = readNumber(signal?.spread_cents, signal?.spreadCents, signal?.gates?.spread_cents);
  if (cents != null) return cents / 100;
  return null;
}

function readDepthUsd(signal, quote, price) {
  if (quote && Number.isFinite(quote.depthUsd)) return quote.depthUsd;
  if (quote && Number.isFinite(quote.askShares) && price > 0) return quote.askShares * price;
  return readNumber(
    signal?.liquidity_usd,
    signal?.liquidityUsd,
    signal?.depth_usd,
    signal?.gates?.liquidity_usd,
    signal?.gates?.depth_usd
  );
}

function momentumGatesOpen(signal) {
  const gates = signal?.gates || signal?.momentum || {};
  const mos = signal?.mos ?? gates.mos;
  const sameWay = signal?.same_way ?? signal?.sameWay ?? gates.same_way ?? gates.sameWay;
  return Boolean(mos) && Boolean(sameWay);
}

function momentumDistanceBps(signal) {
  const gates = signal?.gates || signal?.momentum || {};
  return readNumber(signal?.distance_bps, signal?.distanceBps, gates.distance_bps, gates.distanceBps);
}

export function isLiveEndgame(signal) {
  const kind = signal?.live_kind ?? signal?.liveKind;
  if (kind === 'endgame') return true;
  return signal?.live_phase === 'endgame' || signal?.phase === 'endgame' || signal?.endgame === true;
}

function decision(action, code, reason, extra = {}) {
  const row = { action, code, reason, spec: US_SPEC_VERSION, ...extra };
  if (!Object.prototype.hasOwnProperty.call(extra, 'updateStatus')) {
    row.updateStatus = row.status === 'skipped' || row.status === 'expired' || row.status === 'filled';
  }
  return row;
}

function terminalStatus(signal) {
  const status = String(signal?.status || 'pending').toLowerCase();
  if (['filled', 'skipped', 'expired', 'dry_run'].includes(status)) return status;
  return null;
}

function oppositeOpen(signal, side, openWindows) {
  const keys = new Set([windowKey(signal), tradingSlug(signal.slug)].filter(Boolean));
  return (openWindows || []).find((row) => {
    const rowKeys = [row.windowId, row.slug, row.window_id].filter(Boolean);
    return row.side && row.side !== side && rowKeys.some((key) => keys.has(key));
  });
}

/**
 * 对一条 SIGNAL 做 v3.2 门控。不访问网络。
 * action: place | skip | defer
 */
export function evaluateUsSignal(signal, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  const id = signalIdentity(signal);
  const sector = normalizeSector(signal?.sector);
  const side = normalizeOutcomeSide(signal?.side);
  const base = { signal_id: id, sector, side, slug: tradingSlug(signal?.slug) };

  if (!base.slug || !side) {
    return decision('skip', 'invalid_signal', 'SIGNAL 缺少 slug 或方向。', { ...base, status: 'skipped' });
  }
  if (!isKnownSector(sector)) {
    return decision('skip', 'unknown_sector', `未知板块 ${signal?.sector}，不占用日帽。`, { ...base, status: 'skipped' });
  }
  const eventUrl = signal?.event_url || signal?.url;
  if (isInternationalEventUrl(eventUrl)) {
    return decision('skip', 'intl_market', '这是国际盘链接，美国版不下单。', { ...base, status: 'skipped' });
  }
  const ended = terminalStatus(signal);
  if (ended) {
    return decision('skip', 'already_handled', `SIGNAL 状态已是 ${ended}。`, { ...base, status: ended, updateStatus: false });
  }
  if (String(signal?.action || '') === '跳过') {
    return decision('skip', 'scanner_skip', '扫描器标记为跳过。', { ...base, status: 'skipped' });
  }
  if (signal?.expires_at && Date.parse(signal.expires_at) <= now.getTime()) {
    return decision('skip', 'expired', 'SIGNAL 已过期。', { ...base, status: 'expired' });
  }
  const risk = String(signal?.resolution_risk || signal?.resolutionRisk || 'Low');
  if (risk.toLowerCase() === 'high') {
    return decision('skip', 'resolution_risk', 'resolution_risk 为 High。', { ...base, status: 'skipped' });
  }
  const confidence = String(signal?.confidence || 'Med');
  if (confidence.toLowerCase() === 'low') {
    return decision('skip', 'low_confidence', 'confidence 为 Low。', { ...base, status: 'skipped' });
  }

  const endgame = sector === 'live' && isLiveEndgame(signal);
  const model = readNumber(signal?.model_prob, signal?.modelProb);
  if (!endgame && model != null && model > US_MODEL_PROB_CAP + 1e-9) {
    return decision('skip', 'model_cap', `model_prob ${model} 超过封顶 ${US_MODEL_PROB_CAP}。`, { ...base, status: 'skipped' });
  }
  if (sector === 'momentum' && !momentumGatesOpen(signal)) {
    return decision('skip', 'momentum_gates', 'BTC 动量需要 mos 与 same_way 门控。', { ...base, status: 'skipped' });
  }

  const quote = context.quote || null;
  const quotedAsk = quote ? quoteForSide(quote, side) : null;
  const signalAsk = readNumber(signal?.ask, signal?.market_price, signal?.marketPrice);
  const limit = readNumber(signal?.limit_price, signal?.limitPrice, quotedAsk, signalAsk);
  const ask = quotedAsk ?? signalAsk ?? limit;
  if (quotedAsk != null && limit != null && quotedAsk > limit + 1e-9) {
    return decision('skip', 'price_ran_away', `卖价 ${quotedAsk} 已高于限价 ${limit}，不追价。`, { ...base, status: 'skipped' });
  }
  const executionPrice = quotedAsk != null && limit != null ? Math.min(limit, quotedAsk) : limit;
  if (!(executionPrice > 0)) {
    return decision('skip', 'missing_price', '没有可用限价。', { ...base, status: 'skipped' });
  }

  const bboAt = Date.parse(quote?.observedAt || signal?.bbo_at || signal?.bboAt || '');
  const bboAge = Number.isFinite(bboAt) ? now.getTime() - bboAt : null;
  // 与 US_BBO_MAX_AGE_MS / rules.edge.bboMaxAgeMs 同一常量（SCAN_SPEC v3.2：15 秒）。
  const bboFresh = bboAge != null && bboAge >= 0 && bboAge <= (context.bboMaxAgeMs ?? US_BBO_MAX_AGE_MS);
  if (sector === 'btc_misprice' && !bboFresh) {
    return decision('skip', 'stale_bbo', 'BTC 错价需要新鲜 BBO。', { ...base, status: 'skipped' });
  }

  const edge = model != null ? model - executionPrice : readNumber(signal?.edge);
  const sizing = resolveUsSizeUsd(sector, context.stats, signal?.size_usd ?? signal?.sizeUsd);

  let minEdge = null;
  let minPrice = US_PRICE_MIN;
  let maxPrice = US_PRICE_MAX;
  if (sector === 'live' && endgame) {
    // 尾盘没有 edge 门槛。冷板块 ×1.5 不加在 0.88 模型地板上（与扫描一致）。
    const minModel = US_LIVE_ENDGAME_MIN_MODEL;
    maxPrice = US_LIVE_ENDGAME_MAX_PRICE;
    minPrice = 0;
    if (model == null || model + 1e-9 < minModel) {
      return decision('skip', 'endgame_model', `尾盘模型 ${model} 低于 ${minModel}。`, { ...base, status: 'skipped' });
    }
  } else if (sector === 'live') {
    minEdge = cleanerEdgeFloor(US_EDGE_LIVE_INPLAY, sizing.cold);
    maxPrice = US_LIVE_INPLAY_MAX_PRICE;
  } else if (sector === 'btc_misprice') {
    minEdge = cleanerEdgeFloor(US_EDGE_BTC_MISPRICE, sizing.cold);
  } else if (sector === 'momentum') {
    maxPrice = US_MOMENTUM_MAX_PRICE;
    minPrice = US_PRICE_MIN;
  } else {
    minEdge = cleanerEdgeFloor(US_EDGE_STANDARD, sizing.cold);
  }

  if (executionPrice + 1e-9 < minPrice || executionPrice - 1e-9 > maxPrice) {
    return decision('skip', 'price_band', `价格 ${executionPrice} 不在 ${minPrice}–${maxPrice}。`, { ...base, status: 'skipped' });
  }
  if (sector === 'momentum') {
    // SCAN_SPEC v3.2：动量距离 4 bps；冷板块退回 Plan2 原阈值 8 bps。手写 SIGNAL 也重检。
    const distance = momentumDistanceBps(signal);
    const needed = sizing.cold
      ? US_RULES.edge.momentumOriginalDistanceBps
      : US_RULES.edge.momentumDistanceBps;
    if (distance == null || distance + 1e-9 < needed) {
      return decision('skip', 'momentum_distance', `BTC 动量距离 ${distance ?? '缺失'} bps 低于 ${needed}。`, {
        ...base,
        status: 'skipped'
      });
    }
  }
  if (minEdge != null && !(edge >= minEdge - 1e-9)) {
    return decision('skip', 'edge', `edge ${edge} 低于门槛 ${minEdge}。`, { ...base, status: 'skipped' });
  }

  const spread = readSpread(signal, quote);
  if (spread == null) {
    return decision('skip', 'spread_unknown', '缺少价差，无法确认能吃下这笔单。', { ...base, status: 'skipped' });
  }
  if (spread - 1e-9 > US_MAX_SPREAD) {
    return decision('skip', 'spread', `价差 ${spread} 大于 ${US_MAX_SPREAD}。`, { ...base, status: 'skipped' });
  }
  const depthUsd = readDepthUsd(signal, quote, executionPrice);
  if (depthUsd == null || depthUsd + 1e-9 < sizing.sizeUsd) {
    return decision('skip', 'depth', `深度 ${depthUsd} 不够 $${sizing.sizeUsd}。`, { ...base, status: 'skipped' });
  }

  const schedule = evaluateUsSchedule(now, signal, context.scheduleWindowMinutes);
  if (!schedule.open) {
    return decision('defer', 'outside_schedule', '工作日窗口未开，SIGNAL 保持 pending。', {
      ...base,
      status: 'pending',
      updateStatus: false,
      schedule
    });
  }

  if ((context.realIds || []).includes(id)) {
    return decision('skip', 'duplicate', '同一 SIGNAL 已经真实下过。', { ...base, status: 'skipped' });
  }
  const conflict = oppositeOpen(signal, side, context.openWindows);
  if (conflict) {
    return decision('skip', 'one_sided', `窗口 ${windowKey(signal)} 已有相反方向，美国版单边不能对敲。`, {
      ...base,
      status: 'skipped'
    });
  }
  const used = context.dailyCounts?.[sector] || 0;
  const cap = US_DAILY_CAPS[sector];
  if (used >= cap) {
    return decision('skip', 'daily_cap', `${sector} 今日已下 ${used} 笔，日帽 ${cap}。`, { ...base, status: 'skipped' });
  }
  const buyingPower = context.buyingPower;
  const reserve = context.cashReserveUsd ?? 15;
  if (buyingPower != null) {
    if (buyingPower + 1e-9 < sizing.sizeUsd) {
      return decision('skip', 'insufficient_cash', `可用资金 ${buyingPower} 不够 $${sizing.sizeUsd}。`, { ...base, status: 'skipped' });
    }
    if (buyingPower - sizing.sizeUsd + 1e-9 < reserve) {
      return decision('skip', 'cash_reserve', `下单后现金将低于 $${reserve} 保留额。`, { ...base, status: 'skipped' });
    }
  }
  if (context.dryRun && (context.dryIds || []).includes(id)) {
    return decision('skip', 'already_dry_run', '这条 SIGNAL 今天已经 dry-run 过，仍保持 pending。', {
      ...base,
      status: 'pending',
      updateStatus: false
    });
  }

  const order = sizeUsLimitBuy({
    slug: base.slug,
    side,
    limitPrice: executionPrice,
    sizeUsd: sizing.sizeUsd
  });
  return decision('place', 'pass', '通过 v3.2 门控。', {
    ...base,
    status: context.dryRun ? 'pending' : 'filled',
    updateStatus: !context.dryRun,
    sizeUsd: sizing.sizeUsd,
    tier: sizing.tier,
    cold: sizing.cold,
    edge,
    model_prob: model,
    limitPrice: executionPrice,
    quantity: order.quantity,
    order,
    event_url: eventUrlForSignal(signal),
    schedule,
    basis: signal?.basis || null
  });
}
