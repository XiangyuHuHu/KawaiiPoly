import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';

const windowTracks = new Map();
const MIN_SAMPLE_INTERVAL_MS = 1000;
const MAX_SAMPLES_PER_WINDOW = 1200;

function normalizeSymbol(symbol = 'BTC-USD') {
  return String(symbol || 'BTC-USD').trim().toUpperCase();
}

function trackKey(slotIso, timeframe, symbol = 'BTC-USD') {
  return `${normalizeSymbol(symbol)}_${slotIso}_${timeframe}`;
}

function getPreviousSlotIso(slotIso, slotMinutes) {
  const d = new Date(slotIso);
  d.setMinutes(d.getMinutes() - slotMinutes, 0, 0);
  return d.toISOString();
}

function pruneWindowsForTimeframe(timeframe, currentSlotIso, symbol = 'BTC-USD') {
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const previous = getPreviousSlotIso(currentSlotIso, slotMinutes);
  const normalizedSymbol = normalizeSymbol(symbol);
  for (const [key, track] of windowTracks.entries()) {
    if (track.timeframe !== timeframe || track.symbol !== normalizedSymbol) continue;
    if (track.slotIso !== currentSlotIso && track.slotIso !== previous) {
      windowTracks.delete(key);
    }
  }
}

function resolveSustainedConfig(timeframe, config = {}) {
  const is5m = timeframe === '5m';
  return {
    minPrice: Number(is5m ? config.plan2SustainedMomentumMinPrice5m : config.plan2SustainedMomentumMinPrice15m) || (is5m ? 0.72 : 0.70),
    maxPrice: Number(is5m ? config.plan2SustainedMomentumMaxPrice5m : config.plan2SustainedMomentumMaxPrice15m) || (is5m ? 0.88 : 0.85),
    maxPullback: Number(is5m ? config.plan2SustainedMomentumMaxPullback5m : config.plan2SustainedMomentumMaxPullback15m) || (is5m ? 0.025 : 0.03),
    minElapsedPct: Number(is5m ? config.plan2SustainedMomentumMinElapsedPct5m : config.plan2SustainedMomentumMinElapsedPct15m) || (is5m ? 0.25 : 0.20),
    maxElapsedPct: Number(is5m ? config.plan2SustainedMomentumMaxElapsedPct5m : config.plan2SustainedMomentumMaxElapsedPct15m) || (is5m ? 0.72 : 0.74),
    minSamples: Number(is5m ? config.plan2SustainedMomentumMinSamples5m : config.plan2SustainedMomentumMinSamples15m) || (is5m ? 4 : 6),
    minHoldMs: Number(is5m ? config.plan2SustainedMomentumMinHoldMs5m : config.plan2SustainedMomentumMinHoldMs15m) || (is5m ? 15000 : 30000),
    minDistanceBps: Number(is5m ? config.plan2SustainedMomentumMinDistanceBps5m : config.plan2SustainedMomentumMinDistanceBps15m) || (is5m ? 10 : 8),
    maxReverseBps: Number(is5m ? config.plan2SustainedMomentumMaxReverseBps5m : config.plan2SustainedMomentumMaxReverseBps15m) || (is5m ? 4 : 5)
  };
}

function computeStdev(values) {
  if (!values.length) return 0;
  if (values.length === 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computeBtcMetrics(samples, direction) {
  const btcSamples = samples
    .map((sample) => Number(sample.btcPrice))
    .filter((price) => Number.isFinite(price) && price > 0);
  if (btcSamples.length < 2) {
    return { btcDistanceBps: null, btcMaxReverseBps: null };
  }

  const firstBtc = btcSamples[0];
  const lastBtc = btcSamples.at(-1);
  const btcDistanceBps = ((lastBtc - firstBtc) / firstBtc) * 10000;

  let extreme = firstBtc;
  let maxReverseBps = 0;
  for (const price of btcSamples) {
    if (direction === 'up') {
      extreme = Math.max(extreme, price);
      const reverseBps = extreme > 0 ? ((extreme - price) / extreme) * 10000 : 0;
      maxReverseBps = Math.max(maxReverseBps, reverseBps);
    } else {
      extreme = Math.min(extreme, price);
      const reverseBps = extreme > 0 ? ((price - extreme) / extreme) * 10000 : 0;
      maxReverseBps = Math.max(maxReverseBps, reverseBps);
    }
  }

  return {
    btcDistanceBps: round4(btcDistanceBps),
    btcMaxReverseBps: round4(maxReverseBps)
  };
}

export function recordWindowSnapshot({
  slotIso,
  timeframe,
  symbol = 'BTC-USD',
  marketKey = null,
  upPrice,
  downPrice,
  btcPrice = null,
  elapsedPct,
  now = new Date()
}) {
  if (!slotIso || !timeframe) return null;

  const normalizedSymbol = normalizeSymbol(symbol);
  pruneWindowsForTimeframe(timeframe, slotIso, normalizedSymbol);
  const key = trackKey(slotIso, timeframe, normalizedSymbol);
  const existing = windowTracks.get(key) || {
    slotIso,
    timeframe,
    symbol: normalizedSymbol,
    marketKey: marketKey || null,
    samples: []
  };

  existing.marketKey = marketKey || existing.marketKey;
  const sample = {
    ts: now.getTime(),
    upPrice: Number(upPrice),
    downPrice: Number(downPrice),
    btcPrice: Number.isFinite(Number(btcPrice)) ? Number(btcPrice) : null,
    elapsedPct: Number(elapsedPct)
  };
  const previous = existing.samples.at(-1);
  if (previous && sample.ts - previous.ts < MIN_SAMPLE_INTERVAL_MS) {
    existing.samples[existing.samples.length - 1] = { ...sample, ts: previous.ts };
  } else {
    existing.samples.push(sample);
    if (existing.samples.length > MAX_SAMPLES_PER_WINDOW) {
      existing.samples.splice(0, existing.samples.length - MAX_SAMPLES_PER_WINDOW);
    }
  }

  windowTracks.set(key, existing);
  return existing;
}

export function analyzeWindowTrajectory({ slotIso, timeframe, symbol = 'BTC-USD', direction, config = {}, now = new Date() }) {
  const key = trackKey(slotIso, timeframe, symbol);
  const track = windowTracks.get(key);
  const empty = {
    sampleCount: 0,
    volatilityRange: null,
    volatilityStdev: null,
    peakPrice: null,
    currentPrice: null,
    pullbackFromPeak: null,
    thresholdCrossedAtElapsedPct: null,
    thresholdCrossedAtMs: null,
    holdMsSinceCross: null,
    sustained: false,
    btcDistanceBps: null,
    btcMaxReverseBps: null
  };

  if (!track?.samples?.length || !['up', 'down'].includes(direction)) {
    return empty;
  }

  const samples = track.samples;
  const priceField = direction === 'up' ? 'upPrice' : 'downPrice';
  const prices = samples
    .map((sample) => Number(sample[priceField]))
    .filter((price) => Number.isFinite(price));

  if (!prices.length) return empty;

  const changes = [];
  for (let index = 1; index < prices.length; index += 1) {
    changes.push(prices[index] - prices[index - 1]);
  }

  const peakPrice = Math.max(...prices);
  const currentPrice = prices.at(-1);
  const pullbackFromPeak = peakPrice - currentPrice;
  const cfg = resolveSustainedConfig(timeframe, config);

  let thresholdCrossedAtElapsedPct = null;
  let thresholdCrossedAtMs = null;
  for (const sample of samples) {
    const price = Number(sample[priceField]);
    if (!Number.isFinite(price) || price < cfg.minPrice) continue;
    thresholdCrossedAtElapsedPct = Number(sample.elapsedPct);
    thresholdCrossedAtMs = Number(sample.ts);
    break;
  }

  const latestElapsedPct = Number(samples.at(-1)?.elapsedPct);
  const holdMsSinceCross = thresholdCrossedAtMs != null ? Math.max(0, now.getTime() - thresholdCrossedAtMs) : null;
  const { btcDistanceBps, btcMaxReverseBps } = computeBtcMetrics(samples, direction);

  const sustained = Boolean(
    thresholdCrossedAtMs != null
    && Number.isFinite(currentPrice)
    && currentPrice >= cfg.minPrice
    && currentPrice <= cfg.maxPrice
    && pullbackFromPeak <= cfg.maxPullback
    && prices.length >= cfg.minSamples
    && holdMsSinceCross >= cfg.minHoldMs
    && Number.isFinite(latestElapsedPct)
    && latestElapsedPct >= cfg.minElapsedPct
    && latestElapsedPct <= cfg.maxElapsedPct
  );

  return {
    sampleCount: prices.length,
    volatilityRange: round4(Math.max(...prices) - Math.min(...prices)),
    volatilityStdev: round4(computeStdev(changes)),
    peakPrice: round4(peakPrice),
    currentPrice: round4(currentPrice),
    pullbackFromPeak: round4(pullbackFromPeak),
    thresholdCrossedAtElapsedPct: Number.isFinite(thresholdCrossedAtElapsedPct) ? round4(thresholdCrossedAtElapsedPct) : null,
    thresholdCrossedAtMs,
    holdMsSinceCross,
    sustained,
    btcDistanceBps,
    btcMaxReverseBps
  };
}

export function classifyFiveMinutePathSamples(samples = [], config = {}) {
  const minSamples = Math.max(6, Number(config.fiveMinutePathMinSamples) || 8);
  const minImpulseBps = Math.max(1, Number(config.fiveMinutePathMinImpulseBps) || 4);
  const maxStartElapsedPct = Number(config.fiveMinutePathMaxStartElapsedPct) || 0.12;
  const maxPlateauRangeBps = Math.max(1, Number(config.fiveMinutePathMaxPlateauRangeBps) || 4);
  const maxPlateauDriftBps = Math.max(1, Number(config.fiveMinutePathMaxPlateauDriftBps) || 3);
  const minRetracementRatio = Math.min(1, Math.max(0.1, Number(config.fiveMinutePathMinRetracementRatio) || 0.45));
  const minReversalBps = Math.max(1, Number(config.fiveMinutePathMinReversalBps) || 4);
  const minLateHoldMs = Math.max(0, Number(config.fiveMinutePathMinLateHoldMs) || 20_000);
  const minPmGap = Math.max(0, Number(config.fiveMinutePathMinPmGap) || 0.04);
  const rows = (samples || [])
    .map((sample) => ({
      ts: Number(sample?.ts),
      elapsedPct: Number(sample?.elapsedPct),
      price: Number(sample?.btcPrice),
      upPrice: Number(sample?.upPrice),
      downPrice: Number(sample?.downPrice)
    }))
    .filter((sample) => Number.isFinite(sample.elapsedPct) && Number.isFinite(sample.price) && sample.price > 0)
    .sort((left, right) => left.elapsedPct - right.elapsedPct);

  const empty = {
    pattern: 'insufficient_data',
    actionable: false,
    impulseDirection: null,
    reversalDirection: null,
    sampleCount: rows.length,
    reason: 'not_enough_full_window_samples'
  };
  if (rows.length < minSamples || rows[0].elapsedPct > maxStartElapsedPct) return empty;

  const early = rows.filter((sample) => sample.elapsedPct <= 0.22);
  const middle = rows.filter((sample) => sample.elapsedPct >= 0.20 && sample.elapsedPct <= 0.58);
  const late = rows.filter((sample) => sample.elapsedPct >= 0.60);
  if (early.length < 2 || middle.length < 2) return empty;

  const first = early[0];
  const earlyLast = early.at(-1);
  const latest = rows.at(-1);
  const toBps = (from, to) => ((to - from) / from) * 10_000;
  const earlyMoveBps = toBps(first.price, earlyLast.price);
  if (Math.abs(earlyMoveBps) < minImpulseBps) {
    return {
      ...empty,
      pattern: 'no_impulse',
      sampleCount: rows.length,
      earlyMoveBps: round4(earlyMoveBps),
      latestElapsedPct: round4(latest.elapsedPct),
      reason: 'early_move_too_small'
    };
  }

  const impulseDirection = earlyMoveBps > 0 ? 'up' : 'down';
  const middlePrices = middle.map((sample) => sample.price);
  const plateauRangeBps = ((Math.max(...middlePrices) - Math.min(...middlePrices)) / first.price) * 10_000;
  const plateauDriftBps = Math.abs(toBps(middle[0].price, middle.at(-1).price));
  const adaptiveRangeLimit = Math.max(maxPlateauRangeBps, Math.abs(earlyMoveBps) * 0.45);
  const adaptiveDriftLimit = Math.max(maxPlateauDriftBps, Math.abs(earlyMoveBps) * 0.35);
  const plateau = plateauRangeBps <= adaptiveRangeLimit && plateauDriftBps <= adaptiveDriftLimit;
  const base = {
    actionable: false,
    impulseDirection,
    reversalDirection: impulseDirection === 'up' ? 'down' : 'up',
    sampleCount: rows.length,
    earlyMoveBps: round4(earlyMoveBps),
    plateauRangeBps: round4(plateauRangeBps),
    plateauDriftBps: round4(plateauDriftBps),
    latestElapsedPct: round4(latest.elapsedPct)
  };

  if (!plateau) {
    return { ...base, pattern: `impulse_${impulseDirection}`, reason: 'middle_not_stable' };
  }
  if (latest.elapsedPct < 0.60 || late.length < 3) {
    return { ...base, pattern: `plateau_after_${impulseDirection}`, reason: 'waiting_late_reversal' };
  }

  const lateHoldMs = Math.max(0, late.at(-1).ts - late[0].ts);
  const pricesBeforeLate = rows.filter((sample) => sample.elapsedPct <= 0.65).map((sample) => sample.price);
  const extreme = impulseDirection === 'up' ? Math.max(...pricesBeforeLate) : Math.min(...pricesBeforeLate);
  const reversalBps = impulseDirection === 'up'
    ? toBps(extreme, latest.price) * -1
    : toBps(extreme, latest.price);
  const retracementRatio = Math.abs(earlyMoveBps) > 0 ? reversalBps / Math.abs(earlyMoveBps) : 0;
  const crossedStart = impulseDirection === 'up' ? latest.price < first.price : latest.price > first.price;
  const pmGap = Number.isFinite(latest.upPrice) && Number.isFinite(latest.downPrice)
    ? Math.abs(latest.upPrice - latest.downPrice)
    : 0;
  const pmDirection = Number.isFinite(latest.upPrice) && Number.isFinite(latest.downPrice) && latest.upPrice !== latest.downPrice
    ? (latest.upPrice > latest.downPrice ? 'up' : 'down')
    : null;
  const reversalDirection = base.reversalDirection;
  const reversalConfirmed = reversalBps >= minReversalBps
    && retracementRatio >= minRetracementRatio
    && crossedStart
    && lateHoldMs >= minLateHoldMs
    && pmDirection === reversalDirection
    && pmGap >= minPmGap;
  const metrics = {
    ...base,
    reversalBps: round4(reversalBps),
    retracementRatio: round4(retracementRatio),
    lateHoldMs,
    crossedStart,
    pmDirection,
    pmGap: round4(pmGap)
  };
  if (reversalConfirmed) {
    return {
      ...metrics,
      pattern: `reversal_${reversalDirection}_confirmed`,
      actionable: true,
      reason: 'spot_and_pm_reversal_confirmed'
    };
  }
  const reversalWarning = reversalBps >= minReversalBps && retracementRatio >= minRetracementRatio;
  return {
    ...metrics,
    pattern: reversalWarning ? `reversal_${reversalDirection}_warning` : `plateau_after_${impulseDirection}`,
    reason: reversalWarning ? 'reversal_not_fully_confirmed' : 'late_reversal_too_small'
  };
}

export function analyzeFiveMinutePath({ slotIso, timeframe, symbol = 'BTC-USD', config = {} }) {
  if (timeframe !== '5m') return null;
  const track = windowTracks.get(trackKey(slotIso, timeframe, symbol));
  return classifyFiveMinutePathSamples(track?.samples || [], config);
}

export function evaluateFiveMinutePathExperiment({ path, direction }) {
  const pattern = String(path?.pattern || 'insufficient_data');
  const impulseDirection = path?.impulseDirection;
  const reversalDirection = path?.reversalDirection;
  if (pattern.startsWith('plateau_after_') && direction === impulseDirection) {
    return { active: true, allowed: false, aligned: false, pattern, reason: 'plateau_blocks_impulse_chase' };
  }
  if (pattern.endsWith('_confirmed')) {
    const aligned = direction === reversalDirection;
    return {
      active: true,
      allowed: aligned,
      aligned,
      pattern,
      reason: aligned ? 'confirmed_reversal_aligned' : 'confirmed_reversal_conflict'
    };
  }
  return { active: false, allowed: true, aligned: null, pattern, reason: path?.reason || 'not_actionable' };
}

export function applyFiveMinutePathExperiment(action, path, { enabled = false } = {}) {
  const evaluation = {
    ...evaluateFiveMinutePathExperiment({ path, direction: action?.direction }),
    enabled: Boolean(enabled),
    applied: false
  };
  if (!enabled || !action?.shouldTrade || !evaluation.active) {
    return { action, evaluation };
  }

  const metadata = {
    trajectoryPattern: path?.pattern || null,
    trajectoryMetrics: path || null,
    trajectoryExperiment: { ...evaluation, applied: true }
  };
  if (evaluation.allowed) {
    return {
      action: { ...action, ...metadata },
      evaluation: metadata.trajectoryExperiment
    };
  }

  const candidateDirection = action.direction || null;
  const reason = evaluation.reason === 'plateau_blocks_impulse_chase'
    ? 'Plan 5m path experiment: early impulse stalled; block chasing the original direction.'
    : 'Plan 5m path experiment: confirmed late reversal conflicts with the candidate direction.';
  return {
    action: {
      ...action,
      ...metadata,
      shouldTrade: false,
      strategy: null,
      direction: null,
      candidateDirection,
      label: 'Skip',
      usd: 0,
      reason
    },
    evaluation: metadata.trajectoryExperiment
  };
}

export function getWindowTrackSnapshot(slotIso, timeframe, symbol = 'BTC-USD') {
  const key = trackKey(slotIso, timeframe, symbol);
  const track = windowTracks.get(key);
  if (!track) return null;
  return {
    slotIso: track.slotIso,
    timeframe: track.timeframe,
    symbol: track.symbol,
    marketKey: track.marketKey,
    sampleCount: track.samples.length,
    firstSampleAtMs: track.samples[0]?.ts ?? null,
    lastSampleAtMs: track.samples.at(-1)?.ts ?? null,
    samples: track.samples.map((sample) => ({
      ...sample,
      iso: new Date(sample.ts).toISOString()
    }))
  };
}

export function listActiveWindowTracks() {
  return [...windowTracks.entries()].map(([key, track]) => ({
    key,
    slotIso: track.slotIso,
    timeframe: track.timeframe,
    symbol: track.symbol,
    marketKey: track.marketKey,
    sampleCount: track.samples.length,
    lastSampleAtMs: track.samples.at(-1)?.ts ?? null
  }));
}

export function buildCurrentWindowTrackAnalysis(config = {}, now = new Date(), symbol = 'BTC-USD') {
  const result = {};
  for (const timeframe of ['5m', '15m']) {
    const slotMinutes = timeframeToSlotMinutes(timeframe);
    const schedule = getSlotSchedule(now, slotMinutes);
    const slotIso = schedule.currentSlotIso;
    result[timeframe] = {
      slotIso,
      path: analyzeFiveMinutePath({ slotIso, timeframe, symbol, config }),
      up: analyzeWindowTrajectory({ slotIso, timeframe, symbol, direction: 'up', config, now }),
      down: analyzeWindowTrajectory({ slotIso, timeframe, symbol, direction: 'down', config, now }),
      snapshot: getWindowTrackSnapshot(slotIso, timeframe, symbol)
    };
  }
  return result;
}

export function __resetWindowTrackForTests() {
  windowTracks.clear();
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}
