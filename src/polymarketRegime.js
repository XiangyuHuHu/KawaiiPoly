function clamp(value, min, max, fallback = min) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function detectChop({
  distanceFromOpenBps,
  directionFlipCount,
  priceNearOpenSeconds = 0,
  recentVolatilityBps,
  config = {}
}) {
  if (config.chopFilterEnabled === false) return false;

  const maxDistanceBps = Number(config.chopMaxDistanceBps) || 4;
  const minDirectionFlips = Number(config.chopMinDirectionFlips) || 3;
  const maxLowVolBps = Number(config.chopMaxLowVolatilityBps) || 6;
  const nearOpenSeconds = Number(config.chopNearOpenSeconds) || 60;

  const absDistance = Math.abs(Number(distanceFromOpenBps));
  const flips = Number(directionFlipCount) || 0;
  const nearOpenSecondsValue = Number(priceNearOpenSeconds) || 0;
  const volBps = Number(recentVolatilityBps);

  if (Number.isFinite(absDistance) && absDistance < maxDistanceBps && flips >= minDirectionFlips) {
    return true;
  }
  if (nearOpenSecondsValue >= nearOpenSeconds && Number.isFinite(volBps) && volBps < maxLowVolBps) {
    return true;
  }
  return false;
}

export function buildChopRegimeGuard({
  signal,
  sentiment,
  config = {}
}) {
  if (config.regimeFilterEnabled === false) {
    return {
      isChop: false,
      regime: 'disabled',
      allowMain: true,
      allowProbe: true,
      allowFlip: true,
      scale: 1,
      reason: ''
    };
  }

  const currentPrice = Number(signal?.indicators?.currentPrice);
  const startPrice = Number(signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice);
  const distanceFromOpenBps = Number.isFinite(currentPrice) && Number.isFinite(startPrice) && startPrice > 0
    ? ((currentPrice - startPrice) / startPrice) * 10000
    : null;
  const directionFlipCount = Number(sentiment?.directionFlipCount5m) || 0;
  const recentVolatilityBps = Number(signal?.indicators?.volatility15mPct) * 10000;
  const priceNearOpenSeconds = Number(sentiment?.priceNearOpenSeconds) || 0;

  const isChop = detectChop({
    distanceFromOpenBps,
    directionFlipCount,
    priceNearOpenSeconds,
    recentVolatilityBps,
    config
  });

  if (!isChop) {
    return {
      isChop: false,
      regime: 'normal',
      allowMain: true,
      allowProbe: true,
      allowFlip: true,
      scale: 1,
      reason: '',
      distanceFromOpenBps
    };
  }

  const mainScale = Number(config.chopMainSizeScale);
  const probeScale = Number(config.chopProbeSizeScale);
  return {
    isChop: true,
    regime: 'chop',
    allowMain: mainScale > 0,
    allowProbe: (Number.isFinite(probeScale) ? probeScale : 0.2) > 0,
    allowFlip: false,
    scale: clamp(Number.isFinite(probeScale) ? probeScale : 0.2, 0, 1, 0.2),
    reason: `震荡过滤：距开盘 ${Number.isFinite(distanceFromOpenBps) ? Math.abs(distanceFromOpenBps).toFixed(1) : '--'} bps，PM 翻转 ${directionFlipCount} 次`,
    distanceFromOpenBps,
    directionFlipCount
  };
}

export function computePmStabilityConfidence(sentiment = {}) {
  const quality = Number(sentiment?.qualityScore);
  const spread = Number(sentiment?.spread);
  const up = Number(sentiment?.upProbability ?? sentiment?.upPrice);
  const down = Number(sentiment?.downProbability ?? sentiment?.downPrice);
  const pmEdge = Number.isFinite(up) && Number.isFinite(down) ? Math.abs(up - down) : null;

  let score = 0.50;
  if (Number.isFinite(quality)) score += (quality - 0.5) * 0.35;
  if (Number.isFinite(pmEdge)) score += Math.min(pmEdge, 0.20) * 0.75;
  if (Number.isFinite(spread)) score -= Math.max(0, spread - 0.04) * 1.5;
  return clamp(score, 0.35, 0.85, 0.50);
}
