/**
 * Plan11 — PM 主方向 + Binance 窗口现货确认。
 *
 * 依据 settled live（2026-07）：
 * - 5m window_locks：PM 70% / tech 53% / composite 64% → 5m 不以 EMA/RSI 为主信号
 * - Plan2.5 sustained_momentum：+$280，WR 81.8% @ 0.815
 * - Plan1 5m：+$141；15m −$43；basket_probe −$90
 * - Plan3 96¢ 热门、Plan4 跟单、Plan5 lock_strength、Plan8/9 高价热门：负期望
 *
 * 不做网上那种结算扫盘 / 钱包跟单 / 找漏洞。
 * 只在「估计胜率 − 入场价 − taker fee」为正时买 PM 热门侧。
 * 当前实盘：只 5m、70–78¢、同时 1 币、单笔 $5；默认持有至官方结算。
 */

import { buildWindowPlanKey, windowElapsedPct } from './polymarketPlan.js';
import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';
import { buildChopRegimeGuard } from './polymarketRegime.js';
import { computeDynamicExitPrices, computePlan1PaperOrderUsd } from './polymarketSizing.js';
import { polymarketCryptoTakerFee } from './polymarketMarketUtils.js';

export const PLAN11_ID = 'plan11';
export const PLAN11_VERSION = 'plan11_pm_spot_edge_v1';

export const PLAN11_DEFAULTS = Object.freeze({
  minPrice: 0.70,
  maxPrice: 0.78,
  minGap: 0.28,
  minElapsedPct: 0.12,
  maxElapsedPct5m: 0.55,
  maxElapsedPct15m: 0.50,
  minSpotDistanceBps5m: 3,
  minSpotDistanceBps15m: 5,
  minQuality: 0.42,
  minEdgeAfterFee: 0.012,
  takerFeeRate: 0.07,
  pHatBase: 0.50,
  pHatGapWeight: 0.50,
  pHatSpotBoost: 0.04,
  pHatTechBoost15m: 0.04,
  pHatMin: 0.52,
  pHatMax: 0.88,
  stopLossOffset: 0.10,
  paperOrderPct: 0.05,
  paperMinOrderUsd: 1,
  liveMinOrderUsd: 5,
  liveMaxOrderUsd: 5
});

function finite(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function cfgNum(config, key, fallback) {
  const value = finite(config?.[key], NaN);
  return Number.isFinite(value) ? value : fallback;
}

function skip(reason) {
  return {
    shouldTrade: false,
    strategy: null,
    direction: null,
    label: '跳过',
    confidence: 0,
    usd: 0,
    limitPrice: null,
    reason,
    skipReason: reason
  };
}

function windowLabel(timeframe) {
  return timeframe === '5m' ? '5分钟窗口' : timeframe === '15m' ? '15分钟窗口' : String(timeframe);
}

export function resolvePlan11Spot({ signal } = {}) {
  const start = finite(
    signal?.prediction?.comparisonBasePrice ?? signal?.indicators?.slotStartPrice,
    NaN
  );
  const current = finite(
    signal?.indicators?.currentPrice ?? signal?.prediction?.estimatedClose,
    NaN
  );
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(current) || current <= 0) {
    return { available: false, direction: null, distanceBps: null, startPrice: start, currentPrice: current };
  }
  const distanceBps = ((current - start) / start) * 10000;
  if (!Number.isFinite(distanceBps) || Math.abs(distanceBps) < 1e-9) {
    return { available: false, direction: null, distanceBps: 0, startPrice: start, currentPrice: current };
  }
  return {
    available: true,
    direction: distanceBps >= 0 ? 'up' : 'down',
    distanceBps: round4(distanceBps),
    startPrice: round4(start),
    currentPrice: round4(current)
  };
}

export function resolvePlan11PmFavorite({ sentiment } = {}) {
  if (!sentiment?.available) return null;
  const up = finite(sentiment.upProbability ?? sentiment.upPrice, NaN);
  const down = finite(sentiment.downProbability ?? sentiment.downPrice, NaN);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up <= 0 || down <= 0) return null;
  const direction = up >= down ? 'up' : 'down';
  const price = direction === 'up' ? up : down;
  return {
    direction,
    upPrice: round4(up),
    downPrice: round4(down),
    limitPrice: round4(price),
    gap: round4(Math.abs(up - down)),
    qualityScore: finite(sentiment.qualityScore, null)
  };
}

export function resolvePlan11TechDirection(signal) {
  const direction = String(signal?.technicalDirection ?? signal?.direction ?? '').toLowerCase();
  return direction === 'up' || direction === 'down' ? direction : null;
}

/**
 * 把「PM 锁定强度 + 现货确认」映射成估计胜率。
 * 不是把盘口价当成胜率（那是 0 EV），而是用历史 5m PM≈70%、动量带≈82% 做收缩估计。
 */
export function estimatePlan11WinProbability({
  gap,
  spotAgreed = false,
  techAgreed = false,
  timeframe = '5m',
  config = {}
} = {}) {
  const g = Math.max(0, finite(gap, 0));
  const base = cfgNum(config, 'plan11PHatBase', PLAN11_DEFAULTS.pHatBase);
  const gapWeight = cfgNum(config, 'plan11PHatGapWeight', PLAN11_DEFAULTS.pHatGapWeight);
  const spotBoost = cfgNum(config, 'plan11PHatSpotBoost', PLAN11_DEFAULTS.pHatSpotBoost);
  const techBoost = cfgNum(config, 'plan11PHatTechBoost15m', PLAN11_DEFAULTS.pHatTechBoost15m);
  const min = cfgNum(config, 'plan11PHatMin', PLAN11_DEFAULTS.pHatMin);
  const max = cfgNum(config, 'plan11PHatMax', PLAN11_DEFAULTS.pHatMax);
  let pHat = base + g * gapWeight;
  if (spotAgreed) pHat += spotBoost;
  if (techAgreed && String(timeframe).toLowerCase() === '15m') pHat += techBoost;
  return round4(Math.min(max, Math.max(min, pHat)));
}

export function estimatePlan11TakerFeePerShare(entryPrice, feeRate = PLAN11_DEFAULTS.takerFeeRate) {
  const price = finite(entryPrice, NaN);
  const rate = finite(feeRate, PLAN11_DEFAULTS.takerFeeRate);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  return round4(polymarketCryptoTakerFee(1, price, rate));
}

export function computePlan11EdgeAfterFee({
  pHat,
  entryPrice,
  feeRate = PLAN11_DEFAULTS.takerFeeRate
} = {}) {
  const p = finite(pHat, NaN);
  const price = finite(entryPrice, NaN);
  if (!Number.isFinite(p) || !Number.isFinite(price)) return null;
  const fee = estimatePlan11TakerFeePerShare(price, feeRate);
  return round4(p - price - fee);
}

export function isPlan11StopLossEnabled(config = {}) {
  return config.plan11StopLossEnabled === true;
}

export function computePlan11ExitPrices(entryPrice, config = {}) {
  const slOffset = cfgNum(config, 'plan11StopLossOffset', PLAN11_DEFAULTS.stopLossOffset);
  const rawFloor = config.plan11StopLossAbsoluteFloor;
  const absoluteStopLossFloor = rawFloor === 0 || rawFloor === '0'
    ? null
    : (Number.isFinite(Number(rawFloor)) && Number(rawFloor) > 0 ? Number(rawFloor) : null);
  const exits = computeDynamicExitPrices(entryPrice, {
    takeProfitOffset: 0.99,
    stopLossOffset: slOffset,
    // 不继承全局 STOP_LOSS_ABSOLUTE_FLOOR=0.50，否则 entry≥50¢ 时 10¢ offset 会被盖成 50¢ 绝对线。
    absoluteStopLossFloor
  });
  return {
    takeProfitPrice: null,
    stopLossPrice: isPlan11StopLossEnabled(config) ? exits.stopLossPrice : null,
    stopLossOffset: slOffset
  };
}

export function assertPlan11LiveEntryPriceAllowed(price, config = {}) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0 || px >= 1) {
    throw new Error('Plan11 执行价无效，拒绝提交。');
  }
  const min = cfgNum(config, 'plan11MinPrice', PLAN11_DEFAULTS.minPrice);
  const max = cfgNum(config, 'plan11MaxPrice', PLAN11_DEFAULTS.maxPrice);
  if (px + 1e-9 < min) {
    throw new Error(`Plan11 执行价 ${(px * 100).toFixed(1)}% 低于下限 ${(min * 100).toFixed(0)}%，拒绝提交。`);
  }
  if (px > max + 1e-9) {
    throw new Error(`Plan11 执行价 ${(px * 100).toFixed(1)}% 超过上限 ${(max * 100).toFixed(0)}%，拒绝提交。`);
  }
  return px;
}

export function evaluatePlan11Entry({
  signal,
  sentiment,
  timeframe = '5m',
  config = {},
  elapsedPct = 0
} = {}) {
  const tf = String(timeframe || '5m').toLowerCase();
  const pm = resolvePlan11PmFavorite({ sentiment });
  if (!pm) {
    return { allowed: false, reason: 'Plan11：Polymarket 盘口不可用。' };
  }
  if (tf !== '5m') {
    return {
      allowed: false,
      reason: 'Plan11：只跑 5m（15m 模拟盘为负期望）。',
      pm
    };
  }

  const minElapsed = cfgNum(config, 'plan11MinElapsedPct', PLAN11_DEFAULTS.minElapsedPct);
  const maxElapsed = tf === '15m'
    ? cfgNum(config, 'plan11MaxElapsedPct15m', PLAN11_DEFAULTS.maxElapsedPct15m)
    : cfgNum(config, 'plan11MaxElapsedPct5m', PLAN11_DEFAULTS.maxElapsedPct5m);
  if (elapsedPct + 1e-9 < minElapsed) {
    return {
      allowed: false,
      reason: `Plan11：窗口前 ${(minElapsed * 100).toFixed(0)}% 等待 PM 锁定（当前 ${(elapsedPct * 100).toFixed(0)}%）。`,
      pm
    };
  }
  if (elapsedPct > maxElapsed + 1e-9) {
    return {
      allowed: false,
      reason: `Plan11：窗口后 ${((1 - maxElapsed) * 100).toFixed(0)}% 不再追高价热门（当前 ${(elapsedPct * 100).toFixed(0)}%）。`,
      pm
    };
  }

  const minGap = cfgNum(config, 'plan11MinGap', PLAN11_DEFAULTS.minGap);
  if (pm.gap + 1e-9 < minGap) {
    return {
      allowed: false,
      reason: `Plan11：PM gap ${(pm.gap * 100).toFixed(1)}pp 低于 ${(minGap * 100).toFixed(0)}pp，方向未锁定。`,
      pm
    };
  }

  const minPrice = cfgNum(config, 'plan11MinPrice', PLAN11_DEFAULTS.minPrice);
  const maxPrice = cfgNum(config, 'plan11MaxPrice', PLAN11_DEFAULTS.maxPrice);
  if (pm.limitPrice + 1e-9 < minPrice) {
    return {
      allowed: false,
      reason: `Plan11：拒绝廉价侧 ${(pm.limitPrice * 100).toFixed(0)}c（历史廉价侧盈亏集中在单日，不作为稳定 edge）。`,
      pm
    };
  }
  if (pm.limitPrice > maxPrice + 1e-9) {
    return {
      allowed: false,
      reason: `Plan11：拒绝 ≥${(maxPrice * 100).toFixed(0)}c 热门（Plan3/高价结算扫盘历史负 EV）。`,
      pm
    };
  }

  const minQuality = cfgNum(config, 'plan11MinQuality', PLAN11_DEFAULTS.minQuality);
  if (Number.isFinite(pm.qualityScore) && pm.qualityScore + 1e-9 < minQuality) {
    return {
      allowed: false,
      reason: `Plan11：市场质量 ${(pm.qualityScore * 100).toFixed(0)}% 低于 ${(minQuality * 100).toFixed(0)}%。`,
      pm
    };
  }

  const regimeGuard = buildChopRegimeGuard({ signal, sentiment, config });
  if (regimeGuard.isChop && regimeGuard.allowMain === false) {
    return {
      allowed: false,
      reason: `Plan11 震荡过滤：${regimeGuard.reason || '当前窗口不适合开仓。'}`,
      pm,
      regime: regimeGuard
    };
  }

  const spot = resolvePlan11Spot({ signal });
  const minSpotBps = tf === '15m'
    ? cfgNum(config, 'plan11MinSpotDistanceBps15m', PLAN11_DEFAULTS.minSpotDistanceBps15m)
    : cfgNum(config, 'plan11MinSpotDistanceBps5m', PLAN11_DEFAULTS.minSpotDistanceBps5m);
  if (!spot.available) {
    return { allowed: false, reason: 'Plan11：缺少 Binance 窗口开盘/现价，无法确认 K 线方向。', pm, spot };
  }
  if (Math.abs(spot.distanceBps) + 1e-9 < minSpotBps) {
    return {
      allowed: false,
      reason: `Plan11：现货距开盘仅 ${Math.abs(spot.distanceBps).toFixed(1)}bps，噪声单跳过。`,
      pm,
      spot
    };
  }
  const spotAgreed = spot.direction === pm.direction;
  if (!spotAgreed) {
    return {
      allowed: false,
      reason: `Plan11：PM ${pm.direction.toUpperCase()} 与现货 ${spot.direction.toUpperCase()} 冲突，不开仓。`,
      pm,
      spot
    };
  }

  const techDirection = resolvePlan11TechDirection(signal);
  const techAgreed = techDirection === pm.direction;
  if (tf === '15m' && !techAgreed) {
    return {
      allowed: false,
      reason: `Plan11 15m：技术方向 ${techDirection || '--'} 未确认 PM ${pm.direction.toUpperCase()}（15m tech WR 有用，必须同向）。`,
      pm,
      spot,
      techDirection
    };
  }

  const pHat = estimatePlan11WinProbability({
    gap: pm.gap,
    spotAgreed: true,
    techAgreed,
    timeframe: tf,
    config
  });
  const feeRate = cfgNum(config, 'plan11TakerFeeRate', PLAN11_DEFAULTS.takerFeeRate);
  const edge = computePlan11EdgeAfterFee({ pHat, entryPrice: pm.limitPrice, feeRate });
  const minEdge = cfgNum(config, 'plan11MinEdgeAfterFee', PLAN11_DEFAULTS.minEdgeAfterFee);
  if (!Number.isFinite(edge) || edge + 1e-9 < minEdge) {
    return {
      allowed: false,
      reason: `Plan11：扣费后 edge ${((edge || 0) * 100).toFixed(1)}pp < ${(minEdge * 100).toFixed(1)}pp（p̂ ${(pHat * 100).toFixed(1)}% vs 入场 ${(pm.limitPrice * 100).toFixed(1)}%）。`,
      pm,
      spot,
      techDirection,
      pHat,
      edge
    };
  }

  return {
    allowed: true,
    reason: `Plan11 ${tf} PM ${pm.direction.toUpperCase()} ${(pm.limitPrice * 100).toFixed(0)}c · gap ${(pm.gap * 100).toFixed(0)}pp · 现货同向 ${spot.distanceBps.toFixed(1)}bps · p̂ ${(pHat * 100).toFixed(1)}% · 扣费 edge ${(edge * 100).toFixed(1)}pp`,
    pm,
    spot,
    techDirection,
    techAgreed,
    pHat,
    edge,
    feePerShare: estimatePlan11TakerFeePerShare(pm.limitPrice, feeRate),
    regime: regimeGuard
  };
}

export function buildPlan11RulesSnapshot(config = {}) {
  const stopLossEnabled = isPlan11StopLossEnabled(config);
  return {
    version: PLAN11_VERSION,
    minPrice: cfgNum(config, 'plan11MinPrice', PLAN11_DEFAULTS.minPrice),
    maxPrice: cfgNum(config, 'plan11MaxPrice', PLAN11_DEFAULTS.maxPrice),
    minGap: cfgNum(config, 'plan11MinGap', PLAN11_DEFAULTS.minGap),
    minElapsedPct: cfgNum(config, 'plan11MinElapsedPct', PLAN11_DEFAULTS.minElapsedPct),
    maxElapsedPct5m: cfgNum(config, 'plan11MaxElapsedPct5m', PLAN11_DEFAULTS.maxElapsedPct5m),
    maxElapsedPct15m: cfgNum(config, 'plan11MaxElapsedPct15m', PLAN11_DEFAULTS.maxElapsedPct15m),
    minSpotDistanceBps5m: cfgNum(config, 'plan11MinSpotDistanceBps5m', PLAN11_DEFAULTS.minSpotDistanceBps5m),
    minSpotDistanceBps15m: cfgNum(config, 'plan11MinSpotDistanceBps15m', PLAN11_DEFAULTS.minSpotDistanceBps15m),
    minQuality: cfgNum(config, 'plan11MinQuality', PLAN11_DEFAULTS.minQuality),
    minEdgeAfterFee: cfgNum(config, 'plan11MinEdgeAfterFee', PLAN11_DEFAULTS.minEdgeAfterFee),
    paperHoldToSettlement: !stopLossEnabled,
    liveStopLossOnly: stopLossEnabled,
    stopLossEnabled,
    stopLossOffset: cfgNum(config, 'plan11StopLossOffset', PLAN11_DEFAULTS.stopLossOffset)
  };
}

export function buildPolymarketPaperPlan11({
  signal,
  sentiment,
  config = {},
  timeframe = '5m',
  portfolio = null,
  paperMode = true,
  now = new Date()
} = {}) {
  const slotMinutes = timeframeToSlotMinutes(timeframe);
  const schedule = signal?.schedule || getSlotSchedule(now, slotMinutes);
  const elapsedPct = windowElapsedPct(schedule);
  const window = { key: 'window', label: windowLabel(timeframe) };
  const symbol = signal?.symbol || sentiment?.symbol || 'BTC-USD';
  const targetTimeIso = signal?.prediction?.targetTimeIso || schedule.nextSlotIso || null;
  const slotIso = schedule.currentSlotIso || null;
  const decision = evaluatePlan11Entry({
    signal,
    sentiment,
    timeframe,
    config,
    elapsedPct
  });

  let action = skip(decision.reason);
  if (decision.allowed) {
    if (!portfolio?.portfolioInitialized) {
      action = skip('请先在控制台设置初始本金。');
    } else {
      const limitPrice = decision.pm.limitPrice;
      const paperPct = cfgNum(config, 'plan11PaperOrderPct', PLAN11_DEFAULTS.paperOrderPct);
      const livePct = cfgNum(config, 'plan11LiveOrderPct', paperPct);
      const orderPct = paperMode !== false ? paperPct : livePct;
      let usd;
      if (paperMode !== false) {
        usd = computePlan1PaperOrderUsd({
          cash: portfolio?.cash,
          config: {
            plan1PaperMinOrderUsd: cfgNum(config, 'plan11PaperMinOrderUsd', PLAN11_DEFAULTS.paperMinOrderUsd),
            plan1PaperOrderPct: orderPct
          },
          orderPct
        });
      } else {
        const cash = Math.max(0, finite(portfolio?.cash, 0));
        const liveMin = cfgNum(config, 'plan11LiveMinOrderUsd', PLAN11_DEFAULTS.liveMinOrderUsd);
        const liveMax = cfgNum(config, 'plan11LiveMaxOrderUsd', PLAN11_DEFAULTS.liveMaxOrderUsd);
        usd = round2(Math.max(liveMin, cash * orderPct));
        if (Number.isFinite(liveMax) && liveMax > 0) usd = round2(Math.min(usd, liveMax));
        usd = round2(Math.min(usd, cash));
      }
      if (!Number.isFinite(usd) || usd < 0.5) {
        action = skip('Plan11 买入金额不足 $0.50。');
      } else if (paperMode !== false && usd > Number(portfolio.cash) + 1e-9) {
        action = skip(`Plan11 可用现金 ${Number(portfolio.cash).toFixed(2)} 不足以买入 ${usd.toFixed(2)}。`);
      } else {
        const exits = computePlan11ExitPrices(limitPrice, config);
        const executionKey = `${slotIso || 'unknown'}_${symbol}_${timeframe}_${decision.pm.direction}_plan11`;
        action = {
          shouldTrade: true,
          strategy: 'pm_spot_edge',
          entryType: 'pm_spot_edge',
          direction: decision.pm.direction,
          label: decision.pm.direction === 'up' ? '买 UP / 看涨' : '买 DOWN / 看跌',
          confidence: round4(decision.pHat),
          edgeConfidence: round4(decision.pHat),
          rawEdgeConfidence: round4(decision.pm.limitPrice),
          calibratedConfidence: round4(decision.pHat),
          confidenceCalibrated: true,
          edge: decision.edge,
          pHat: decision.pHat,
          pmGap: decision.pm.gap,
          spotDirection: decision.spot.direction,
          spotDistanceBps: decision.spot.distanceBps,
          techDirection: decision.techDirection,
          executionKey,
          entryTier: 'pm_spot_edge',
          sizeMultiplier: 1,
          entryElapsedPct: round4(elapsedPct),
          usd,
          sizing: {
            usd,
            paperSizing: paperMode !== false,
            orderPct,
            availableCash: Number(portfolio?.cash) || 0
          },
          limitPrice: round4(limitPrice),
          takeProfitPrice: null,
          stopLossPrice: exits.stopLossPrice,
          holdToSettlement: !isPlan11StopLossEnabled(config),
          estimatedClose: Number(signal?.prediction?.estimatedClose) || null,
          startPrice: decision.spot.startPrice,
          reason: `${decision.reason}；计划买入 $${usd.toFixed(2)}。`
        };
      }
    }
  }

  return {
    key: buildWindowPlanKey(slotIso, timeframe, symbol),
    planId: PLAN11_ID,
    algorithm: PLAN11_ID,
    strategyVersion: PLAN11_VERSION,
    symbol,
    timeframe,
    slotMinutes,
    generatedAtIso: now.toISOString(),
    targetTimeIso,
    slotIso,
    window,
    phase: window,
    elapsedPct: round4(elapsedPct),
    exitRule: {
      takeProfitOffset: null,
      stopLossOffset: cfgNum(config, 'plan11StopLossOffset', PLAN11_DEFAULTS.stopLossOffset),
      takeProfitPrice: null,
      stopLossPrice: action.stopLossPrice ?? null,
      holdToSettlement: !isPlan11StopLossEnabled(config),
      liveStopLossOnly: isPlan11StopLossEnabled(config)
    },
    decision,
    action
  };
}
