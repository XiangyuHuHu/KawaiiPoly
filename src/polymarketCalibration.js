const CONFIDENCE_BUCKETS = [
  { key: '55-58', min: 0.55, max: 0.58 },
  { key: '58-61', min: 0.58, max: 0.61 },
  { key: '61-64', min: 0.61, max: 0.64 },
  { key: '64-67', min: 0.64, max: 0.67 },
  { key: '67-70', min: 0.67, max: 0.70 },
  { key: '70+', min: 0.70, max: 1.01 }
];

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function bucketConfidence(confidence) {
  const conf = Number(confidence);
  if (!Number.isFinite(conf) || conf <= 0) return null;
  for (const bucket of CONFIDENCE_BUCKETS) {
    if (conf >= bucket.min && conf < bucket.max) return bucket.key;
  }
  if (conf < 0.55) return '<55';
  return '70+';
}

function normalizeEntryType(entryType) {
  const value = String(entryType || 'main').toLowerCase();
  if ([
    'probe',
    'probe_main',
    'main',
    'standard',
    'basket_probe',
    'opposite_hedge',
    'late_capture',
    'ultra_late_capture',
    'settlement_capture_90',
    'sustained_momentum',
    'stop_loss_reversal',
    'cross_follow'
  ].includes(value)) {
    return value;
  }
  return 'main';
}

function normalizePlanId(planId) {
  return String(planId || 'unknown').trim().toLowerCase() || 'unknown';
}

function normalizeSymbol(symbol) {
  return String(symbol || 'unknown').trim().toUpperCase() || 'unknown';
}

function bucketKey({ planId, symbol, timeframe, direction, entryType, confidenceBucket }) {
  return `${normalizePlanId(planId)}|${normalizeSymbol(symbol)}|${timeframe || '15m'}|${direction || 'any'}|${normalizeEntryType(entryType)}|${confidenceBucket || 'unknown'}`;
}

function emptyBucketStats() {
  return {
    sampleCount: 0,
    avgConfidence: 0,
    actualWinRate: 0,
    avgEntryPrice: 0,
    avgPnl: 0,
    profitFactor: 0,
    wins: 0,
    losses: 0
  };
}

function finalizeBucketStats(stats) {
  const count = stats.sampleCount;
  if (!count) return { ...emptyBucketStats(), confidenceBucket: stats.confidenceBucket, bucketKey: stats.bucketKey };
  const winPnls = stats._winPnls || [];
  const lossPnls = stats._lossPnls || [];
  const grossWin = winPnls.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(lossPnls.reduce((sum, value) => sum + value, 0));
  return {
    bucketKey: stats.bucketKey,
    confidenceBucket: stats.confidenceBucket,
    planId: stats.planId,
    symbol: stats.symbol,
    timeframe: stats.timeframe,
    direction: stats.direction,
    entryType: stats.entryType,
    sampleCount: count,
    avgConfidence: round4(stats._confidenceSum / count),
    actualWinRate: round4(stats.wins / count),
    avgEntryPrice: round4(stats._entryPriceSum / count),
    avgPnl: round4(stats._pnlSum / count),
    profitFactor: grossLoss > 0 ? round4(grossWin / grossLoss) : (grossWin > 0 ? 999 : 0),
    wins: stats.wins,
    losses: stats.losses
  };
}

export function buildConfidenceCalibrationTable(orders = []) {
  const buckets = new Map();
  for (const order of orders || []) {
    if (order.settlementStatus !== 'settled' && order.positionStatus !== 'closed') continue;
    const won = order.won === true || Number(order.pnl) > 0;
    const lost = order.won === false || Number(order.pnl) < 0;
    if (!won && !lost) continue;

    const rawConfidence = Number(order.confidence ?? order.plan?.action?.confidence ?? order.plan?.action?.edgeConfidence);
    const entryPrice = Number(order.limitPrice ?? order.entryPrice);
    if (!Number.isFinite(rawConfidence) || !Number.isFinite(entryPrice)) continue;

    const planId = normalizePlanId(order.planId ?? order.algorithm);
    const symbol = normalizeSymbol(order.symbol ?? order.plan?.symbol);
    const timeframe = order.timeframe || '15m';
    const direction = order.direction || 'any';
    const entryType = normalizeEntryType(order.entryType ?? order.plan?.action?.entryType);
    const confidenceBucket = bucketConfidence(rawConfidence);
    const key = bucketKey({ planId, symbol, timeframe, direction, entryType, confidenceBucket });

    if (!buckets.has(key)) {
      buckets.set(key, {
        bucketKey: key,
        confidenceBucket,
        planId,
        symbol,
        timeframe,
        direction,
        entryType,
        sampleCount: 0,
        wins: 0,
        losses: 0,
        _confidenceSum: 0,
        _entryPriceSum: 0,
        _pnlSum: 0,
        _winPnls: [],
        _lossPnls: []
      });
    }

    const bucket = buckets.get(key);
    bucket.sampleCount += 1;
    bucket._confidenceSum += rawConfidence;
    bucket._entryPriceSum += entryPrice;
    bucket._pnlSum += Number(order.pnl) || 0;
    if (won) {
      bucket.wins += 1;
      bucket._winPnls.push(Number(order.pnl) || 0);
    } else {
      bucket.losses += 1;
      bucket._lossPnls.push(Number(order.pnl) || 0);
    }
  }

  const table = {};
  for (const [key, stats] of buckets.entries()) {
    table[key] = finalizeBucketStats(stats);
  }
  return table;
}

function aggregateBuckets(buckets, fallbackKey, hierarchyLevel) {
  if (!buckets.length) return null;
  const sampleCount = buckets.reduce((sum, bucket) => sum + Number(bucket.sampleCount || 0), 0);
  if (!sampleCount) return null;
  const weighted = (field) => buckets.reduce(
    (sum, bucket) => sum + Number(bucket[field] || 0) * Number(bucket.sampleCount || 0),
    0
  ) / sampleCount;
  const wins = buckets.reduce((sum, bucket) => sum + Number(bucket.wins || 0), 0);
  const losses = buckets.reduce((sum, bucket) => sum + Number(bucket.losses || 0), 0);
  return {
    bucketKey: fallbackKey,
    confidenceBucket: buckets.length === 1 ? buckets[0].confidenceBucket : 'hierarchical',
    planId: buckets[0].planId,
    symbol: buckets.every((bucket) => bucket.symbol === buckets[0].symbol) ? buckets[0].symbol : 'ANY',
    timeframe: buckets.every((bucket) => bucket.timeframe === buckets[0].timeframe) ? buckets[0].timeframe : 'any',
    direction: buckets.every((bucket) => bucket.direction === buckets[0].direction) ? buckets[0].direction : 'any',
    entryType: buckets[0].entryType,
    sampleCount,
    avgConfidence: round4(weighted('avgConfidence')),
    actualWinRate: round4(wins / sampleCount),
    avgEntryPrice: round4(weighted('avgEntryPrice')),
    avgPnl: round4(weighted('avgPnl')),
    profitFactor: 0,
    wins,
    losses,
    hierarchical: true,
    hierarchyLevel,
    sourceBucketKeys: buckets.map((bucket) => bucket.bucketKey).filter(Boolean)
  };
}

function lookupBucket(table, {
  planId,
  symbol,
  timeframe,
  direction,
  entryType,
  confidenceBucket,
  minSamples = 0,
  hierarchyEnabled = false
}) {
  const candidates = [
    bucketKey({ planId, symbol, timeframe, direction, entryType, confidenceBucket }),
    bucketKey({ planId, symbol, timeframe, direction: 'any', entryType, confidenceBucket }),
    bucketKey({ planId, symbol, timeframe: 'any', direction, entryType, confidenceBucket }),
    // Backward compatibility for the original pre-plan/symbol calibration keys.
    `${timeframe || '15m'}|${direction || 'any'}|${normalizeEntryType(entryType)}|${confidenceBucket || 'unknown'}`
  ];
  for (const key of candidates) {
    if (table[key]?.sampleCount >= minSamples) return table[key];
  }
  const firstAvailable = candidates.map((key) => table[key]).find((bucket) => bucket?.sampleCount) || null;
  if (!hierarchyEnabled) return firstAvailable;

  const normalizedPlan = normalizePlanId(planId);
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedEntry = normalizeEntryType(entryType);
  const exactBuckets = Object.values(table).filter((bucket) => (
    bucket
    && normalizePlanId(bucket.planId) === normalizedPlan
    && normalizeEntryType(bucket.entryType) === normalizedEntry
    && Number(bucket.sampleCount) > 0
    && bucket.hierarchical !== true
  ));
  const levels = [
    {
      name: 'symbol_timeframe_entry_confidence',
      match: (bucket) => normalizeSymbol(bucket.symbol) === normalizedSymbol
        && bucket.timeframe === timeframe
        && bucket.confidenceBucket === confidenceBucket
    },
    {
      name: 'symbol_timeframe_entry',
      match: (bucket) => normalizeSymbol(bucket.symbol) === normalizedSymbol && bucket.timeframe === timeframe
    },
    {
      name: 'timeframe_entry_confidence',
      match: (bucket) => bucket.timeframe === timeframe && bucket.confidenceBucket === confidenceBucket
    },
    {
      name: 'timeframe_entry',
      match: (bucket) => bucket.timeframe === timeframe
    },
    {
      name: 'plan_entry',
      match: () => true
    }
  ];
  for (const level of levels) {
    const buckets = exactBuckets.filter(level.match);
    const aggregated = aggregateBuckets(
      buckets,
      `hierarchy:${normalizedPlan}:${normalizedEntry}:${level.name}`,
      level.name
    );
    if (aggregated?.sampleCount >= minSamples) return aggregated;
  }
  return null;
}

export function getCalibratedConfidence({
  rawConfidence,
  planId = null,
  symbol = null,
  timeframe = '15m',
  direction = null,
  entryType = 'main',
  calibrationTable = {},
  config = {}
}) {
  const raw = Number(rawConfidence);
  if (!Number.isFinite(raw) || raw <= 0) return { rawConfidence: raw, calibratedConfidence: raw, calibrated: false, bucket: null };

  if (config.confidenceCalibrationEnabled === false) {
    return { rawConfidence: round4(raw), calibratedConfidence: round4(raw), calibrated: false, bucket: null };
  }

  const confidenceBucket = bucketConfidence(raw);
  const minSamples = Number(config.confidenceMinBucketSamples) || 50;
  const bucket = lookupBucket(calibrationTable, {
    planId,
    symbol,
    timeframe,
    direction,
    entryType,
    confidenceBucket,
    minSamples,
    hierarchyEnabled: config.confidenceCalibrationHierarchyEnabled === true
  });
  if (!bucket || bucket.sampleCount < minSamples) {
    return {
      rawConfidence: round4(raw),
      calibratedConfidence: round4(raw),
      calibrated: false,
      bucket: bucket ? { ...bucket, insufficientSamples: true } : null,
      confidenceBucket
    };
  }

  return {
    rawConfidence: round4(raw),
    calibratedConfidence: round4(bucket.actualWinRate),
    calibrated: true,
    bucket,
    confidenceBucket
  };
}

export function resolveCalibratedEdge({
  rawConfidence,
  entryPrice,
  planId = null,
  symbol = null,
  timeframe = '15m',
  direction = null,
  entryType = 'main',
  calibrationTable = {},
  config = {}
}) {
  const calibration = getCalibratedConfidence({
    rawConfidence,
    planId,
    symbol,
    timeframe,
    direction,
    entryType,
    calibrationTable,
    config
  });
  const price = Number(entryPrice);
  const edge = Number.isFinite(price) ? round4(calibration.calibratedConfidence - price) : null;
  return {
    ...calibration,
    entryPrice: Number.isFinite(price) ? round4(price) : null,
    edge
  };
}

export function summarizeCalibrationTable(table = {}) {
  return Object.values(table)
    .sort((a, b) => {
      const tf = String(a.timeframe).localeCompare(String(b.timeframe));
      if (tf !== 0) return tf;
      return String(a.confidenceBucket).localeCompare(String(b.confidenceBucket));
    });
}

export { CONFIDENCE_BUCKETS, bucketConfidence };
