import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

export const PLAN3_6_ID = 'plan3_6';
export const PLAN3_6_VERSION = 'plan3_6_v6_favorite_confirmed';

export const PLAN3_6_LANES = {
  PRIMARY: 'primary_5m_favorite_confirmed',
  SHADOW_15M: 'shadow_15m_favorite_confirmed',
  PAPER_1H: 'paper_1h_favorite_confirmed',
  PAPER_1D: 'paper_1d_favorite_confirmed',
  REJECTED: 'rejected'
};

/** Paper-executable longer windows; live keeps these observe-only. */
export const PLAN3_6_PAPER_ONLY_LANES = new Set([
  PLAN3_6_LANES.SHADOW_15M,
  PLAN3_6_LANES.PAPER_1H,
  PLAN3_6_LANES.PAPER_1D
]);

export const PLAN3_6_PAPER_TIMEFRAMES = ['5m', '15m', '1h', '1d'];
/** Live only executes PRIMARY 5m; longer windows stay observe-only. */
export const PLAN3_6_LIVE_TIMEFRAMES = ['5m'];

export function buildPlan36SlotKey(slotIso, timeframe, direction = null, symbol = null) {
  const coin = symbol ? `_${String(symbol).toUpperCase().replace(/-USD$/, '')}` : '';
  const base = `${slotIso || 'unknown'}${coin}_${timeframe}_plan3_6`;
  return direction ? `${base}_${direction}` : base;
}

export function resolvePlan36SecondsWindow(timeframe = '5m', config = {}) {
  const tf = String(timeframe || '5m').toLowerCase();
  const minSeconds = Number(config.plan3_6MinSecondsRemaining ?? 3);
  if (tf === '5m') {
    return { minSeconds, maxSeconds: Number(config.plan3_6MaxSecondsRemaining5m ?? 300) };
  }
  if (tf === '1h' || tf === 'hourly' || tf === '60m') {
    return { minSeconds, maxSeconds: Number(config.plan3_6MaxSecondsRemaining1h ?? 3600) };
  }
  if (tf === '1d' || tf === 'daily' || tf === '24h') {
    return {
      minSeconds: Number(config.plan3_6MinSecondsRemaining1d ?? Math.max(minSeconds, 900)),
      maxSeconds: Number(config.plan3_6MaxSecondsRemaining1d ?? 86400)
    };
  }
  // 15m and unknown short windows
  return { minSeconds, maxSeconds: Number(config.plan3_6MaxSecondsRemaining15m ?? 900) };
}

export function isInPlan36TimeWindow(timeframe, secondsRemaining, config = {}) {
  const seconds = Number(secondsRemaining);
  const { minSeconds, maxSeconds } = resolvePlan36SecondsWindow(timeframe, config);
  return Number.isFinite(seconds) && seconds >= minSeconds && seconds <= maxSeconds;
}

export function choosePlan36Side({ upPrice, downPrice, maxPrice = 0.20, minPrice = 0.05 } = {}) {
  const max = Number(maxPrice);
  const min = Number(minPrice);
  const up = Number(upPrice);
  const down = Number(downPrice);
  const inBand = (price) => Number.isFinite(price)
    && price > 0
    && Number.isFinite(max)
    && price <= max
    && (!Number.isFinite(min) || min <= 0 || price >= min);
  const upOk = inBand(up);
  const downOk = inBand(down);
  if (!upOk && !downOk) return null;
  if (upOk && downOk) return up <= down
    ? { direction: 'up', tokenPrice: up }
    : { direction: 'down', tokenPrice: down };
  return upOk
    ? { direction: 'up', tokenPrice: up }
    : { direction: 'down', tokenPrice: down };
}

export function resolvePlan36ExperimentLane({ timeframe = '5m', tokenPrice, config = {} } = {}) {
  const price = Number(tokenPrice);
  if (!Number.isFinite(price)) return PLAN3_6_LANES.REJECTED;
  const min = Number(config.plan3_6FavoriteMinPrice ?? 0.75);
  const max = Number(config.plan3_6FavoriteMaxPrice ?? 0.85);
  if (price < min || price > max) return PLAN3_6_LANES.REJECTED;
  const tf = String(timeframe || '5m').toLowerCase();
  if (tf === '5m') return PLAN3_6_LANES.PRIMARY;
  if (tf === '15m') return PLAN3_6_LANES.SHADOW_15M;
  if (tf === '1h' || tf === 'hourly' || tf === '60m') return PLAN3_6_LANES.PAPER_1H;
  if (tf === '1d' || tf === 'daily' || tf === '24h') return PLAN3_6_LANES.PAPER_1D;
  return PLAN3_6_LANES.REJECTED;
}

// Kept for historical records and existing callers. V6 execution uses fixed $5 sizing.
export function resolvePlan36SizeBand(tokenPrice, config = {}) {
  const price = Number(tokenPrice);
  const minPrice = Number(config.plan3_6MinPrice ?? 0.05);
  const maxPrice = Number(config.plan3_6MaxPrice ?? 0.20);
  const fullBandPrice = Number(config.plan3_6FullBandMinPrice ?? 0.10);
  const halfScale = Number(config.plan3_6HalfBandSizeScale ?? 0.5);
  if (!Number.isFinite(price) || price <= 0) return { band: 'invalid', sizeScale: 0, fullBandPrice, halfScale };
  if (Number.isFinite(maxPrice) && price > maxPrice) return { band: 'above_max', sizeScale: 0, fullBandPrice, halfScale };
  if (Number.isFinite(minPrice) && minPrice > 0 && price < minPrice) return { band: 'below_min', sizeScale: 0, fullBandPrice, halfScale };
  if (Number.isFinite(fullBandPrice) && price < fullBandPrice) {
    const sizeScale = Number.isFinite(halfScale) && halfScale > 0 ? halfScale : 0.5;
    return { band: 'half', sizeScale, fullBandPrice, halfScale: sizeScale };
  }
  return { band: 'full', sizeScale: 1, fullBandPrice, halfScale };
}

export function calculatePlan36OrderUsd({ cash, tokenPrice = null, config = {} } = {}) {
  const baseUsd = round2(Number(config.plan3_6OrderUsd ?? 5));
  if (!(baseUsd > 0)) return 0;
  const band = resolvePlan36SizeBand(tokenPrice ?? config.plan3_6FullBandMinPrice ?? 0.10, config);
  if (!(band.sizeScale > 0)) return 0;
  const orderUsd = round2(baseUsd * band.sizeScale);
  if (!(orderUsd > 0)) return 0;
  if (Number.isFinite(Number(cash)) && Number(cash) < orderUsd) return 0;
  return orderUsd;
}

/** Live hard floor for favorite buys (never buy cheap/junk side). */
export function resolvePlan36LiveFavoriteFloor(config = {}) {
  const favoriteMin = Number(config.plan3_6FavoriteMinPrice ?? 0.75);
  const liveMin = Number(config.plan3_6LiveMinPrice ?? favoriteMin);
  const floor = Math.max(
    Number.isFinite(favoriteMin) ? favoriteMin : 0.75,
    Number.isFinite(liveMin) ? liveMin : 0
  );
  return Math.min(0.95, Math.max(0.50, floor));
}

export function resolvePlan36LiveFavoriteCeiling(config = {}) {
  const favoriteMax = Number(config.plan3_6FavoriteMaxPrice ?? 0.85);
  return Math.min(0.99, Math.max(resolvePlan36LiveFavoriteFloor(config), Number.isFinite(favoriteMax) ? favoriteMax : 0.85));
}

/**
 * Guard against late-window favorite collapse: intended 82¢ but book ask
 * dumps to 2–20¢. FAK limit is a ceiling, so a high limit still fills junk.
 */
export function assertPlan36LiveExecutablePrice(freshPrice, draft = {}, config = {}, now = new Date()) {
  const price = Number(freshPrice);
  const floor = resolvePlan36LiveFavoriteFloor(config);
  const ceiling = resolvePlan36LiveFavoriteCeiling(config);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('Plan3.6 下单前最新对手价不可交易。');
  }
  if (price + 1e-9 < floor) {
    throw new Error(
      `Plan3.6 拒绝廉价侧/崩价票：最新可成交价 ${(price * 100).toFixed(2)}¢ 低于热门侧硬下限 ${(floor * 100).toFixed(0)}¢。`
    );
  }
  if (price > ceiling + 1e-9) {
    throw new Error(
      `Plan3.6 热门侧已高于上限：最新可成交价 ${(price * 100).toFixed(2)}¢ > ${(ceiling * 100).toFixed(0)}¢。`
    );
  }
  const intended = Number(draft?.intendedLimitPrice ?? draft?.limitPrice);
  const maxDropAbs = Number(config.plan3_6LiveMaxAdversePriceDropAbs);
  const dropLimit = Number.isFinite(maxDropAbs) ? Math.max(0.02, maxDropAbs) : 0.08;
  if (Number.isFinite(intended) && intended >= floor && (intended - price) > dropLimit + 1e-9) {
    throw new Error(
      `Plan3.6 决策价 ${(intended * 100).toFixed(1)}¢ 已崩至 ${(price * 100).toFixed(1)}¢（回撤 > ${(dropLimit * 100).toFixed(0)}¢），放弃追崩价票。`
    );
  }
  const targetMs = Date.parse(String(draft?.targetTimeIso || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const minRemain = Math.max(
    3,
    Number(config.plan3_6LiveMinSecondsRemaining ?? config.plan3_6MinSecondsRemaining ?? 8)
  );
  if (Number.isFinite(targetMs) && Number.isFinite(nowMs)) {
    const remaining = (targetMs - nowMs) / 1000;
    if (remaining < minRemain) {
      throw new Error(
        `Plan3.6 距窗口截止仅剩 ${Math.max(0, remaining).toFixed(1)} 秒（下限 ${minRemain}s），拒绝尾盘崩价单。`
      );
    }
  }
  return round4(price);
}

export function repricePlan36LiveDraft(draft, freshPrice, config = {}) {
  const price = assertPlan36LiveExecutablePrice(freshPrice, draft, config);
  const lane = resolvePlan36ExperimentLane({
    symbol: draft?.symbol,
    timeframe: draft?.timeframe,
    tokenPrice: price,
    config
  });
  if (lane !== PLAN3_6_LANES.PRIMARY) {
    throw new Error(`Plan3.6 v6 live only permits the 5m confirmed-favorite lane; executable price is ${(price * 100).toFixed(2)}c.`);
  }
  const usd = round2(Number(config.plan3_6OrderUsd ?? 5));
  if (!(usd > 0)) throw new Error('Plan3.6 v6 order amount is invalid.');
  const intended = draft.intendedLimitPrice ?? draft.limitPrice ?? null;
  return {
    ...draft,
    intendedLimitPrice: intended,
    intendedUsd: draft.intendedUsd ?? draft.usd ?? null,
    executionPreflightPrice: price,
    limitPrice: price,
    // Cap FAK bumps inside the favorite band (never the legacy cheap-side 20¢ max).
    maxLivePrice: resolvePlan36LiveFavoriteCeiling(config),
    minLivePrice: resolvePlan36LiveFavoriteFloor(config),
    usd,
    shares: round4(usd / price),
    requestedUsd: usd,
    entryType: 'plan3_6_v6_favorite',
    experimentLane: lane,
    shadowOnly: false,
    sizeBand: 'fixed',
    sizeScale: 1
  };
}

function skip(reason, meta = {}) {
  return { shouldTrade: false, observeOnly: true, skipReason: reason, ...meta };
}

function buildShell({
  symbol = 'BTC-USD',
  timeframe,
  slotIso = null,
  targetTimeIso = null,
  secondsRemaining = null,
  direction = null,
  tokenPrice = null,
  limitPrice = null,
  orderUsd = null,
  experimentLane = null,
  observation = null,
  now,
  action
}) {
  return {
    symbol,
    key: action?.executionKey || buildPlan36SlotKey(slotIso, timeframe, direction, symbol),
    planId: PLAN3_6_ID,
    algorithm: PLAN3_6_ID,
    strategyVersion: PLAN3_6_VERSION,
    timeframe,
    slotIso,
    targetTimeIso,
    generatedAtIso: now.toISOString(),
    secondsRemaining,
    direction,
    tokenPrice,
    limitPrice,
    orderUsd,
    experimentLane,
    observation,
    exitRule: { mode: 'settlement_redeem', takeProfitPrice: null, stopLossPrice: null },
    action
  };
}

function finitePrice(...values) {
  for (const value of values) {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0 && price < 1) return price;
  }
  return NaN;
}

export function buildPolymarketPaperPlan3_6({
  signal,
  recommendation = null,
  sentiment,
  config = {},
  portfolio = null,
  timeframe = '5m',
  paperMode = true,
  now = new Date()
} = {}) {
  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';
  const shell = (args) => buildShell({ symbol, ...args });
  if (config.plan3_6Enabled === false) return shell({ timeframe, now, action: skip('plan3_6_disabled') });

  const isPaper = paperMode !== false;
  if (!isPaper && config.plan3_6LiveEnabled !== true) {
    return shell({ timeframe, now, action: skip('live_disabled') });
  }

  const schedule = signal?.schedule || getSlotSchedule(now, timeframeToSlotMinutes(timeframe));
  const secondsRemaining = Number(schedule.secondsToNext);
  const slotIso = schedule.currentSlotIso || null;
  const targetTimeIso = schedule.nextSlotIso || null;
  const base = { timeframe, slotIso, targetTimeIso, secondsRemaining, now };
  if (!sentiment?.available) return shell({ ...base, action: skip('market_not_open') });
  // Live: keep a wider buffer before expiry so FAK cannot fill a collapsed junk ask.
  const liveWindowConfig = !isPaper
    ? {
        ...config,
        plan3_6MinSecondsRemaining: Math.max(
          Number(config.plan3_6MinSecondsRemaining ?? 3),
          Number(config.plan3_6LiveMinSecondsRemaining ?? 8)
        )
      }
    : config;
  if (!isInPlan36TimeWindow(timeframe, secondsRemaining, liveWindowConfig)) {
    return shell({ ...base, action: skip('not_in_time_window', { secondsRemaining }) });
  }

  const tick = Number(config.plan3_6PaperTickSize ?? 0.01);
  const slipTicks = isPaper ? Math.max(0, Number(config.plan3_6PaperSlippageTicks ?? 1)) : 0;
  const upAsk = finitePrice(sentiment.upBestAsk, sentiment.upPrice);
  const downAsk = finitePrice(sentiment.downBestAsk, sentiment.downPrice);
  const upExecutable = round4(upAsk + slipTicks * tick);
  const downExecutable = round4(downAsk + slipTicks * tick);
  const cheapMin = Number(config.plan3_6CheapMinPrice ?? 0.10);
  const cheapMax = Number(config.plan3_6CheapMaxPrice ?? 0.20);
  const cheapSide = choosePlan36Side({
    upPrice: upExecutable,
    downPrice: downExecutable,
    minPrice: cheapMin,
    maxPrice: cheapMax
  });
  if (!cheapSide) {
    return shell({
      ...base,
      action: skip('cheap_side_out_of_band', {
        minPrice: cheapMin,
        maxPrice: cheapMax,
        upPrice: Number.isFinite(upExecutable) ? upExecutable : null,
        downPrice: Number.isFinite(downExecutable) ? downExecutable : null
      })
    });
  }

  const modelDirection = ['up', 'down'].includes(recommendation?.direction)
    ? recommendation.direction
    : (['up', 'down'].includes(signal?.direction) ? signal.direction : null);
  const modelConfidence = Number.isFinite(Number(recommendation?.confidence))
    ? Number(recommendation.confidence)
    : Number(signal?.confidence);
  const favoriteDirection = cheapSide.direction === 'up' ? 'down' : 'up';
  const favoriteRawAsk = favoriteDirection === 'up' ? upAsk : downAsk;
  const tokenPrice = round4(favoriteDirection === 'up' ? upExecutable : downExecutable);
  const marketOverround = round4(upExecutable + downExecutable);
  const lane = resolvePlan36ExperimentLane({ symbol, timeframe, tokenPrice, config });
  const executionKey = buildPlan36SlotKey(slotIso, timeframe, favoriteDirection, symbol);
  const confidenceFloor = Number(config.plan3_6MinSignalConfidence ?? 0.65);
  const minModelEdge = Number(config.plan3_6MinModelEdge ?? 0.05);
  const maxOverround = Number(config.plan3_6MaxOverround ?? 1.04);
  const observation = {
    candidate: true,
    key: executionKey,
    planId: PLAN3_6_ID,
    strategyVersion: PLAN3_6_VERSION,
    symbol,
    timeframe,
    slotIso,
    targetTimeIso,
    market: sentiment.market || null,
    marketSlug: sentiment.marketSlug || null,
    direction: favoriteDirection,
    tokenPrice,
    rawBestAsk: round4(favoriteRawAsk),
    paperSlippageTicks: slipTicks,
    experimentLane: lane,
    cheapDirection: cheapSide.direction,
    cheapPrice: round4(cheapSide.tokenPrice),
    marketOverround,
    modelDirection,
    modelConfidence: Number.isFinite(modelConfidence) ? round4(modelConfidence) : null,
    modelEdge: Number.isFinite(modelConfidence) ? round4(modelConfidence - tokenPrice) : null,
    modelAligned: modelDirection ? modelDirection === favoriteDirection : null,
    secondsRemaining
  };

  if (!Number.isFinite(tokenPrice) || tokenPrice <= 0 || tokenPrice >= 1) {
    return shell({ ...base, observation, action: skip('favorite_price_unavailable', { observationCandidate: true }) });
  }

  if (lane === PLAN3_6_LANES.REJECTED) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('favorite_price_out_of_band', {
        direction: favoriteDirection,
        tokenPrice,
        experimentLane: lane,
        observationCandidate: true,
        modelDirection,
        modelConfidence: observation.modelConfidence
      })
    });
  }

  if (!modelDirection) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('model_direction_unavailable', { experimentLane: lane, observationCandidate: true })
    });
  }

  if (!(Number.isFinite(modelConfidence) && modelConfidence >= confidenceFloor)) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('model_confidence_below_floor', {
        experimentLane: lane,
        modelConfidence: observation.modelConfidence,
        confidenceFloor,
        observationCandidate: true
      })
    });
  }

  if (modelDirection !== favoriteDirection) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('model_not_aligned_with_favorite', { experimentLane: lane, observationCandidate: true })
    });
  }

  if (!(Number.isFinite(observation.modelEdge) && observation.modelEdge >= minModelEdge)) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('model_edge_below_floor', {
        experimentLane: lane,
        modelEdge: observation.modelEdge,
        minModelEdge,
        observationCandidate: true
      })
    });
  }

  if (!(marketOverround > 0 && marketOverround <= maxOverround)) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('market_overround_too_high', {
        experimentLane: lane,
        marketOverround,
        maxOverround,
        observationCandidate: true
      })
    });
  }

  observation.qualified = true;

  // Live: only 5m PRIMARY may trade. Paper: 15m/1h/1d reuse the same favorite-confirmed rules.
  if (!isPaper && PLAN3_6_PAPER_ONLY_LANES.has(lane)) {
    const skipReason = lane === PLAN3_6_LANES.SHADOW_15M
      ? 'shadow_15m_observe_only'
      : 'shadow_lane_live_observe_only';
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip(skipReason, { experimentLane: lane, observationCandidate: true })
    });
  }

  if (!isPaper && lane !== PLAN3_6_LANES.PRIMARY) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('shadow_lane_paper_only', { experimentLane: lane, direction: favoriteDirection, tokenPrice })
    });
  }

  const orderUsd = round2(Number(config.plan3_6OrderUsd ?? 5));
  const cash = Number(portfolio?.cash);
  if (!(orderUsd > 0) || (Number.isFinite(cash) && cash < orderUsd)) {
    return shell({
      ...base,
      direction: favoriteDirection,
      tokenPrice,
      limitPrice: tokenPrice,
      experimentLane: lane,
      observation,
      action: skip('order_too_small_or_no_cash', { cash, experimentLane: lane })
    });
  }

  const favoriteFloor = resolvePlan36LiveFavoriteFloor(config);
  const favoriteCeiling = resolvePlan36LiveFavoriteCeiling(config);

  return shell({
    ...base,
    direction: favoriteDirection,
    tokenPrice,
    limitPrice: tokenPrice,
    orderUsd,
    experimentLane: lane,
    observation,
    action: {
      shouldTrade: true,
      observeOnly: false,
      entryType: 'plan3_6_v6_favorite',
      strategy: PLAN3_6_VERSION,
      strategyVersion: PLAN3_6_VERSION,
      experimentLane: lane,
      shadowOnly: false,
      direction: favoriteDirection,
      label: `Plan3.6 confirmed favorite ${favoriteDirection.toUpperCase()}`,
      limitPrice: tokenPrice,
      tokenPrice,
      // Keep FAK bumps inside the favorite band; never inherit cheap-side 20¢ max.
      maxLivePrice: favoriteCeiling,
      minLivePrice: favoriteFloor,
      usd: orderUsd,
      shares: round4(orderUsd / tokenPrice),
      secondsRemaining,
      takeProfitPrice: null,
      stopLossPrice: null,
      executionKey,
      pmUpPrice: Number(sentiment.upPrice) || null,
      pmDownPrice: Number(sentiment.downPrice) || null,
      upBestAsk: Number.isFinite(upAsk) ? round4(upAsk) : null,
      downBestAsk: Number.isFinite(downAsk) ? round4(downAsk) : null,
      fixedOrderUsd: orderUsd,
      sizeBand: 'fixed',
      sizeScale: 1,
      paperMode: isPaper,
      liveMode: !isPaper,
      modelDirection,
      modelConfidence: observation.modelConfidence,
      modelAligned: observation.modelAligned,
      cheapDirection: cheapSide.direction,
      cheapPrice: observation.cheapPrice,
      marketOverround,
      reason: `Plan3.6 v6 ${lane}: model-confirmed ${favoriteDirection.toUpperCase()} ${(tokenPrice * 100).toFixed(1)}c, overround ${marketOverround.toFixed(3)}, $${orderUsd.toFixed(2)}, hold to settlement.`
    }
  });
}
