import { breakevenMovePct, estimateRoundTripCost, getFeeTier, positionSize } from './fees.js';

/**
 * 费用感知趋势策略。
 *
 * 核心思想:在 0.95% 单边手续费下,一次往返(买+卖+价差)成本约 2%,
 * 任何预期波动小于「往返成本 × 安全系数」的信号都不值得交易。
 * 因此入场条件 = 趋势信号(EMA 金叉 + RSI 过滤) 且 预期行情幅度足够覆盖费用。
 *
 * 预期行情幅度用波动率扩散估计:sigmaH = 每根K线收益率标准差 × sqrt(持有周期)。
 */
export function calculateStrategySignal({
  prices,
  fastPeriod = 20,
  slowPeriod = 60,
  rsiPeriod = 14,
  equityUsd = 10_000,
  volume30dUsd = 0,
  feeRate,
  spreadPct = 0.001,
  riskPerTradePct = 0.01,
  maxPositionPct = 0.3,
  feeBufferMultiple = 1.5
}) {
  const closes = (prices || []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (closes.length < slowPeriod + 2) {
    return {
      signal: 'wait',
      confidence: 0,
      reason: `Need at least ${slowPeriod + 2} prices; received ${closes.length}.`
    };
  }

  const tier = getFeeTier(volume30dUsd);
  const effectiveFeeRate = Number.isFinite(Number(feeRate)) && feeRate !== undefined ? Number(feeRate) : tier.feeRate;
  const cost = estimateRoundTripCost({ feeRate: effectiveFeeRate, spreadPct });
  const breakeven = breakevenMovePct(effectiveFeeRate, spreadPct);

  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const rsiValue = rsi(closes, rsiPeriod);
  const lastPrice = closes.at(-1);
  const lastFast = fast.at(-1);
  const prevFast = fast.at(-2);
  const lastSlow = slow.at(-1);
  const prevSlow = slow.at(-2);
  const crossedUp = prevFast <= prevSlow && lastFast > lastSlow;
  const crossedDown = prevFast >= prevSlow && lastFast < lastSlow;

  // 波动率估计与预期行情幅度
  const sigmaPerBar = returnStdev(closes, Math.min(closes.length - 1, 30));
  const horizonBars = fastPeriod;
  const expectedMovePct = sigmaPerBar * Math.sqrt(horizonBars);

  const requiredMovePct = cost.totalPct * feeBufferMultiple;
  const netExpectedEdgePct = expectedMovePct - cost.totalPct;

  // 止损给 1 倍波动幅度的空间,止盈 = 保本点 + 1.6 倍波动幅度
  const stopLossPct = Math.max(cost.totalPct * 0.75, sigmaPerBar * Math.sqrt(horizonBars) * 0.8);
  const takeProfitPct = breakeven + expectedMovePct * 1.6;
  const netTakeProfitPct = takeProfitPct - cost.totalPct;
  const netStopLossPct = stopLossPct + cost.totalPct;
  const rewardRiskAfterFees = netStopLossPct > 0 ? netTakeProfitPct / netStopLossPct : 0;

  const sizing = positionSize({
    equityUsd,
    riskPerTradePct,
    stopLossPct,
    roundTripCostPct: cost.totalPct,
    maxPositionPct
  });

  const feeContext = {
    feeTier: tier.label,
    feeRate: effectiveFeeRate,
    spreadPct: cost.spreadPct,
    roundTripCostPct: cost.totalPct,
    breakevenMovePct: breakeven,
    expectedMovePct,
    requiredMovePct,
    netExpectedEdgePct,
    feeBufferMultiple
  };

  const tradePlan = {
    entryPrice: lastPrice,
    stopLossPct,
    stopLossPrice: round8(lastPrice * (1 - stopLossPct)),
    takeProfitPct,
    takeProfitPrice: round8(lastPrice * (1 + takeProfitPct)),
    rewardRiskAfterFees: round4(rewardRiskAfterFees),
    positionNotionalUsd: sizing.notionalUsd,
    positionQuantity: sizing.notionalUsd > 0 ? round8(sizing.notionalUsd / lastPrice) : 0,
    estimatedRoundTripFeesUsd: sizing.estimatedFeesUsd,
    riskBudgetUsd: sizing.riskBudgetUsd,
    cappedByMaxPosition: sizing.cappedByMaxPosition
  };

  if (crossedUp && rsiValue < 70) {
    if (expectedMovePct < requiredMovePct) {
      return {
        signal: 'skip',
        confidence: 0.3,
        reason:
          `EMA${fastPeriod} 金叉 EMA${slowPeriod},但预期波幅 ${pct(expectedMovePct)} < 所需 ${pct(requiredMovePct)}` +
          `(往返成本 ${pct(cost.totalPct)} × ${feeBufferMultiple} 安全系数)。手续费会吃掉预期利润,放弃本次信号。`,
        fees: feeContext,
        tradePlan: null,
        indicators: indicatorSnapshot()
      };
    }

    return {
      signal: 'buy',
      confidence: normalizeConfidence(Math.abs(lastFast - lastSlow) / lastSlow, rsiValue, netExpectedEdgePct, cost.totalPct),
      reason:
        `EMA${fastPeriod} 金叉 EMA${slowPeriod},RSI ${rsiValue.toFixed(1)} 未超买;` +
        `预期波幅 ${pct(expectedMovePct)} ≥ 所需 ${pct(requiredMovePct)},扣费后净期望优势 ${pct(netExpectedEdgePct)}。`,
      fees: feeContext,
      tradePlan,
      indicators: indicatorSnapshot()
    };
  }

  if (crossedDown || rsiValue > 78) {
    return {
      signal: 'sell',
      confidence: crossedDown ? 0.72 : 0.58,
      reason: crossedDown
        ? `EMA${fastPeriod} 死叉 EMA${slowPeriod},趋势走弱,持仓应离场(卖出手续费 ${pct(cost.sellFeePct)} 已是沉没成本)。`
        : `RSI ${rsiValue.toFixed(1)} 严重超买,建议落袋。`,
      fees: feeContext,
      tradePlan: null,
      indicators: indicatorSnapshot()
    };
  }

  return {
    signal: 'hold',
    confidence: 0.45,
    reason:
      `无交叉信号。EMA${fastPeriod}: ${lastFast.toFixed(2)},EMA${slowPeriod}: ${lastSlow.toFixed(2)},RSI: ${rsiValue.toFixed(1)}。` +
      ` 当前费率下每次往返成本 ${pct(cost.totalPct)},频繁进出只会亏手续费。`,
    fees: feeContext,
    tradePlan: null,
    indicators: indicatorSnapshot()
  };

  function indicatorSnapshot() {
    return {
      lastPrice,
      emaFast: round4(lastFast),
      emaSlow: round4(lastSlow),
      rsi: round4(rsiValue),
      sigmaPerBarPct: round6(sigmaPerBar),
      horizonBars
    };
  }
}

export function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const result = [];
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  for (let index = 0; index < values.length; index += 1) {
    if (index < period - 1) {
      result.push(values[index]);
      continue;
    }

    current = index === period - 1 ? current : (values[index] - current) * multiplier + current;
    result.push(current);
  }

  return result;
}

export function rsi(values, period) {
  let gains = 0;
  let losses = 0;

  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

export function returnStdev(closes, lookback = 30) {
  const returns = [];
  const start = Math.max(1, closes.length - lookback);
  for (let index = start; index < closes.length; index += 1) {
    returns.push(Math.log(closes[index] / closes[index - 1]));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

function normalizeConfidence(spreadRatio, rsiValue, netEdgePct, roundTripCostPct) {
  const trendScore = Math.min(0.3, spreadRatio * 40);
  const rsiPenalty = rsiValue > 62 ? 0.12 : 0;
  // 净期望优势相对费用越大,信号越可信
  const edgeScore = Math.min(0.2, Math.max(0, netEdgePct / Math.max(roundTripCostPct, 0.0001)) * 0.05);
  return Math.max(0.1, Math.min(0.9, 0.5 + trendScore + edgeScore - rsiPenalty));
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function round8(value) {
  return Math.round(value * 1e8) / 1e8;
}
