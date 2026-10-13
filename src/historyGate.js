import { resolveCalibratedEdge } from './polymarketCalibration.js';

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

/**
 * Plan1/Plan2 历史胜率门控：样本足够时，用校准后的真实胜率替代“感觉置信度”。
 * 校准胜率 < 入场价 + 安全边际 → 跳过，避免长期负期望交易。
 */
export function evaluateHistoryWinRateGate({
  rawConfidence,
  entryPrice,
  planId = null,
  symbol = null,
  timeframe = '15m',
  direction = null,
  entryType = 'main',
  calibrationTable = {},
  config = {},
  planLabel = 'Plan'
} = {}) {
  if (config.historyWinRateGateEnabled === false) {
    return { allowed: true, calibrated: null, skipped: true };
  }

  const calibrated = resolveCalibratedEdge({
    rawConfidence,
    entryPrice,
    planId,
    symbol,
    timeframe,
    direction,
    entryType,
    calibrationTable: calibrationTable || {},
    config
  });

  const minSamples = Number(config.confidenceMinBucketSamples) || 20;
  const sampleCount = Number(calibrated?.bucket?.sampleCount) || 0;
  if (!calibrated?.calibrated || sampleCount < minSamples) {
    if (config.historyWinRateRequireCalibration === true) {
      return {
        allowed: false,
        calibrated,
        reason: `${planLabel} 历史样本不足（${sampleCount}/${minSamples}），暂缓开仓以等待校准数据。`
      };
    }
    return {
      allowed: true,
      calibrated,
      insufficientSamples: true,
      sampleCount,
      minSamples
    };
  }

  const price = Number(entryPrice);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { allowed: true, calibrated };
  }

  const margin = Number(config.historyWinRateMargin);
  const safetyMargin = Number.isFinite(margin) ? margin : 0.02;
  const requiredWinRate = Math.min(0.99, price + safetyMargin);
  const winRate = Number(calibrated.calibratedConfidence);
  if (!Number.isFinite(winRate) || winRate < requiredWinRate) {
    const deficit = Number.isFinite(winRate) ? (requiredWinRate - winRate) : Infinity;
    const mode = String(config.historyWinRateGateMode || 'hard').toLowerCase();
    const softGapRaw = Number(config.historyWinRateSoftGap);
    const softGap = Number.isFinite(softGapRaw) ? Math.max(0, softGapRaw) : 0.04;
    const softFloorRaw = Number(config.historyWinRateSoftSizeFloor);
    const softFloor = Number.isFinite(softFloorRaw) ? Math.min(1, Math.max(0.1, softFloorRaw)) : 0.35;
    // soft：略低于盈亏平衡时降仓放行，显著负 EV 仍硬拒
    if (mode === 'soft' && Number.isFinite(deficit) && deficit <= softGap + 1e-12) {
      const sizeScale = softGap <= 1e-12
        ? softFloor
        : round4(Math.max(softFloor, 1 - (deficit / softGap) * (1 - softFloor)));
      return {
        allowed: true,
        calibrated,
        requiredWinRate: round4(requiredWinRate),
        sampleCount,
        winRate: round4(winRate),
        softReject: true,
        sizeScale,
        originalReason: `${planLabel} 历史校准胜率 ${(winRate * 100).toFixed(1)}% 略低于盈亏平衡 ${(requiredWinRate * 100).toFixed(1)}%，soft 降仓×${sizeScale.toFixed(2)}`
      };
    }
    return {
      allowed: false,
      calibrated,
      requiredWinRate: round4(requiredWinRate),
      sampleCount,
      reason: `${planLabel} 历史校准胜率 ${(Number.isFinite(winRate) ? winRate * 100 : 0).toFixed(1)}%（${calibrated.bucket?.wins || 0}/${sampleCount}）低于盈亏平衡 ${(requiredWinRate * 100).toFixed(1)}%（入场 ${(price * 100).toFixed(1)}% + 边际 ${(safetyMargin * 100).toFixed(1)}%），跳过负期望单。`
    };
  }

  return {
    allowed: true,
    calibrated,
    requiredWinRate: round4(requiredWinRate),
    sampleCount,
    winRate: round4(winRate)
  };
}
