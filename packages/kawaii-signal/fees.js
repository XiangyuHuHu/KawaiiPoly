// Robinhood Crypto smart exchange routing 费率阶梯(按过去 30 天合格交易量)。
// 来源:Robinhood "Your crypto fee tier" 页面。
export const FEE_TIERS = [
  { minVolume: 0, maxVolume: 50_000, feeRate: 0.0095, label: 'Less than $50K' },
  { minVolume: 50_000, maxVolume: 250_000, feeRate: 0.0025, label: '$50K up to $250K' },
  { minVolume: 250_000, maxVolume: 500_000, feeRate: 0.0015, label: '$250K up to $500K' },
  { minVolume: 500_000, maxVolume: 1_000_000, feeRate: 0.00125, label: '$500K up to $1M' },
  { minVolume: 1_000_000, maxVolume: 5_000_000, feeRate: 0.001, label: '$1M up to $5M' },
  { minVolume: 5_000_000, maxVolume: 10_000_000, feeRate: 0.0004, label: '$5M up to $10M' },
  { minVolume: 10_000_000, maxVolume: Infinity, feeRate: 0.0003, label: '$10M+' }
];

export function getFeeTier(volume30d = 0) {
  const volume = Math.max(0, Number(volume30d) || 0);
  return FEE_TIERS.find((tier) => volume >= tier.minVolume && volume < tier.maxVolume) || FEE_TIERS[0];
}

/**
 * 单次「买入 + 卖出」往返的总交易成本(百分比, 0.01 = 1%)。
 *
 * 成本 = 买入手续费 + 卖出手续费 + 全程买卖价差。
 * Robinhood 报价里 bid/ask 已含 spread,实际成交按 ask 买、bid 卖,
 * 所以 spread 是真实成本的一部分,必须计入保本点。
 */
export function estimateRoundTripCost({ feeRate, spreadPct = 0.001 }) {
  const fee = Number(feeRate) || 0;
  const spread = Math.max(0, Number(spreadPct) || 0);
  const buyFeePct = fee;
  const sellFeePct = fee;
  const totalPct = buyFeePct + sellFeePct + spread;
  return {
    feeRate: fee,
    buyFeePct,
    sellFeePct,
    spreadPct: spread,
    totalPct
  };
}

/**
 * 保本所需的价格涨幅(百分比)。
 * 买入实际成本 = price × (1 + fee),卖出实际到手 = price × (1 - fee),
 * 再叠加 spread,解出 P_sell / P_buy - 1。
 */
export function breakevenMovePct(feeRate, spreadPct = 0.001) {
  const fee = Number(feeRate) || 0;
  const spread = Math.max(0, Number(spreadPct) || 0);
  return (1 + fee) / (1 - fee) * (1 + spread) - 1;
}

/**
 * 基于风险的仓位计算:
 * - 单笔最多亏损 equity × riskPerTradePct(止损触发时,含双边手续费);
 * - 同时仓位上限 maxPositionPct,避免小止损放大杠杆;
 * - 不足最小下单金额时返回 0。
 */
export function positionSize({
  equityUsd,
  riskPerTradePct = 0.01,
  stopLossPct,
  roundTripCostPct,
  maxPositionPct = 0.3,
  minNotionalUsd = 1
}) {
  const equity = Math.max(0, Number(equityUsd) || 0);
  const stop = Math.max(0.0001, Number(stopLossPct) || 0);
  const cost = Math.max(0, Number(roundTripCostPct) || 0);
  const riskBudgetUsd = equity * riskPerTradePct;
  // 止损出场的总损失率 = 止损幅度 + 往返成本
  const lossPctIfStopped = stop + cost;
  const rawNotional = lossPctIfStopped > 0 ? riskBudgetUsd / lossPctIfStopped : 0;
  const cappedNotional = Math.min(rawNotional, equity * maxPositionPct);
  const notionalUsd = cappedNotional >= minNotionalUsd ? round2(cappedNotional) : 0;

  return {
    notionalUsd,
    riskBudgetUsd: round2(riskBudgetUsd),
    lossPctIfStopped,
    cappedByMaxPosition: rawNotional > equity * maxPositionPct,
    estimatedFeesUsd: round2(notionalUsd * cost)
  };
}

/**
 * 费用拖累测算:给定每月往返次数与平均仓位,
 * 估算一年要交多少手续费、占本金的比例,以及由此需要的最低毛收益。
 */
export function feeDragProjection({ equityUsd, roundTripsPerMonth, avgPositionPct = 0.25, roundTripCostPct }) {
  const equity = Math.max(0, Number(equityUsd) || 0);
  const trips = Math.max(0, Number(roundTripsPerMonth) || 0);
  const positionUsd = equity * avgPositionPct;
  const monthlyCostUsd = positionUsd * roundTripCostPct * trips;
  const annualCostUsd = monthlyCostUsd * 12;
  // 30 天合格交易量 = 买 + 卖 双边名义金额
  const projectedVolume30d = positionUsd * 2 * trips;
  return {
    monthlyCostUsd: round2(monthlyCostUsd),
    annualCostUsd: round2(annualCostUsd),
    annualCostPctOfEquity: equity > 0 ? annualCostUsd / equity : 0,
    projectedVolume30d: round2(projectedVolume30d),
    projectedTier: getFeeTier(projectedVolume30d)
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
