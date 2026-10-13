export function resolveMinConfidence(timeframe = '15m', config = {}) {

  if (timeframe === '5m') {

    return Number(config.minConfidence5m) || 0.58;

  }

  return Number(config.minConfidence15m) || 0.56;

}



export function resolveMinEdge(timeframe = '15m', config = {}) {

  if (timeframe === '5m') {

    return Number(config.minEdge5m) ?? 0.06;

  }

  return Number(config.minEdge15m) ?? 0.04;

}



export function resolvePlan1MinConfidence(timeframe = '15m', config = {}) {

  const unified = Number(config.plan1MinConfidence);

  if (Number.isFinite(unified) && unified > 0) return unified;

  return resolveMinConfidence(timeframe, config);

}



export function resolvePlan2MinConfidence(timeframe = '15m', config = {}) {

  const plan2 = Number(config.plan2MinConfidence);

  if (Number.isFinite(plan2) && plan2 > 0) return plan2;

  return resolveMinConfidence(timeframe, config);

}



export function resolveTierMinConfidence(_timeframe = '15m') {

  return 0.55;

}



export function resolveMinMarketQuality(config = {}) {

  const plan1 = Number(config.plan1MinMarketQuality);

  if (Number.isFinite(plan1) && plan1 > 0) return plan1;

  const value = Number(config.minMarketQuality);

  return Number.isFinite(value) && value > 0 ? value : 0.40;

}



export function getTradeSizeMultiplier({ confidence, entryPrice, timeframe = '15m', maxEntryPrice = 0.78 }) {

  const conf = Number(confidence);

  const price = Number(entryPrice);

  const edge = computeTradeEdge(conf, price);

  if (!Number.isFinite(edge)) return 0;



  const maxPrice = Number(maxEntryPrice) || 0.78;

  if (price > maxPrice) return 0;

  if (timeframe === '5m') {

    if (price <= 0.60 && conf >= 0.57 && edge >= 0.008) return 1.0;

    if (price <= 0.68 && conf >= 0.59 && edge >= 0.015) return 0.5;

    if (price <= 0.75 && conf >= 0.62 && edge >= 0.025) return 0.25;

    if (price <= Math.min(0.78, maxPrice) && conf >= 0.65 && edge >= 0.035) return 0.15;

    return 0;

  }



  if (timeframe === '15m') {

    if (price <= 0.60 && conf >= 0.56 && edge >= 0.006) return 1.0;

    if (price <= 0.68 && conf >= 0.58 && edge >= 0.012) return 0.5;

    if (price <= 0.75 && conf >= 0.61 && edge >= 0.020) return 0.25;

    if (price <= Math.min(0.78, maxPrice) && conf >= 0.64 && edge >= 0.030) return 0.15;

    return 0;

  }



  return 0;

}



export function describeEntryTier(sizeMultiplier) {

  if (sizeMultiplier >= 1) {

    return { tier: 1, tierKey: 'strong', tierLabel: '强 tier1 ×1.0' };

  }

  if (sizeMultiplier >= 0.5) {

    return { tier: 2, tierKey: 'medium', tierLabel: '中 tier2 ×0.5' };

  }

  if (sizeMultiplier >= 0.25) {

    return { tier: 3, tierKey: 'weak', tierLabel: '弱 tier3 ×0.25' };

  }

  if (sizeMultiplier >= 0.15) {

    return { tier: 4, tierKey: 'probe', tierLabel: '探 tier4 ×0.15' };

  }

  return { tier: 0, tierKey: 'none', tierLabel: '无' };

}



function buildTierSkipReason({ confidence, entryPrice, edge, timeframe, maxEntryPrice = 0.78, planLabel = 'Plan1' }) {

  const confPct = (Number(confidence) * 100).toFixed(1);

  const pricePct = (Number(entryPrice) * 100).toFixed(1);

  const edgePct = Number.isFinite(edge) ? (edge * 100).toFixed(1) : '--';

  const maxPrice = Number(maxEntryPrice) || 0.78;

  if (Number(entryPrice) > maxPrice) {

    return `限价 ${pricePct}% 超过 ${planLabel} 上限 ${(maxPrice * 100).toFixed(0)}%，禁止入场。`;

  }

  if (timeframe === '5m') {

    return `未达任何 tier（5m 限价 ${pricePct}% 置信 ${confPct}% edge ${edgePct}%）。tier1: ≤60% conf≥57% edge≥0.8%；tier2: ≤68% conf≥59% edge≥1.5%；tier3: ≤75% conf≥62% edge≥2.5%；tier4: ≤78% conf≥65% edge≥3.5%。`;

  }

  return `未达任何 tier（15m 限价 ${pricePct}% 置信 ${confPct}% edge ${edgePct}%）。tier1: ≤60% conf≥56% edge≥0.6%；tier2: ≤68% conf≥58% edge≥1.2%；tier3: ≤75% conf≥61% edge≥2%；tier4: ≤78% conf≥64% edge≥3%。`;

}



export function evaluateTieredEntry({

  confidence,

  entryPrice,

  timeframe = '15m',

  config = {},

  marketQuality = null,

  minMarketQuality = null,

  minConfidence = null,
  minEntryPrice = null,
  maxEntryPrice = null,
  planLabel = 'Plan1'

}) {

  const conf = Number(confidence);

  const price = Number(entryPrice);

  const qualityMin = Number.isFinite(Number(minMarketQuality))

    ? Number(minMarketQuality)

    : (marketQuality != null ? resolveMinMarketQuality(config) : null);

  const quality = Number(marketQuality);

  const edge = computeTradeEdge(conf, price);

  const minPrice = Number.isFinite(Number(minEntryPrice)) ? Number(minEntryPrice) : 0;
  // 注意：Number(null)===0，不能用 Number.isFinite(Number(minConfidence)) 判断「是否传入」。
  const explicitMinConf = minConfidence == null ? null : Number(minConfidence);
  const confFloor = Number.isFinite(explicitMinConf) && explicitMinConf > 0
    ? explicitMinConf
    : (String(planLabel || '').toLowerCase().includes('plan1')
      ? resolvePlan1MinConfidence(timeframe, config)
      : null);



  if (!Number.isFinite(conf) || conf <= 0) {

    return { allowed: false, sizeMultiplier: 0, edge, reason: '置信度无效。' };

  }

  if (Number.isFinite(confFloor) && confFloor > 0 && conf + 1e-9 < confFloor) {
    return {
      allowed: false,
      sizeMultiplier: 0,
      edge,
      reason: `${planLabel} 置信度 ${(conf * 100).toFixed(1)}% 低于门槛 ${(confFloor * 100).toFixed(0)}%。`
    };
  }

  if (!Number.isFinite(price) || price <= 0 || price >= 1) {

    return { allowed: false, sizeMultiplier: 0, edge, reason: '入场限价无效。' };

  }

  if (price < minPrice) {

    return {

      allowed: false,

      sizeMultiplier: 0,

      edge,

      reason: `入场价 ${(price * 100).toFixed(1)}% 低于下限 ${(minPrice * 100).toFixed(0)}%。`

    };

  }

  if (Number.isFinite(quality) && Number.isFinite(qualityMin) && quality < qualityMin) {

    return {

      allowed: false,

      sizeMultiplier: 0,

      edge,

      reason: `市场质量 ${(quality * 100).toFixed(0)}% 低于 ${(qualityMin * 100).toFixed(0)}%。`

    };

  }



  const tierMaxPrice = Number.isFinite(Number(maxEntryPrice)) ? Number(maxEntryPrice) : 0.78;

  const sizeMultiplier = getTradeSizeMultiplier({
    confidence: conf,
    entryPrice: price,
    timeframe,
    maxEntryPrice: tierMaxPrice
  });

  if (sizeMultiplier <= 0) {

    return {

      allowed: false,

      sizeMultiplier: 0,

      edge,

      reason: buildTierSkipReason({
        confidence: conf,
        entryPrice: price,
        edge,
        timeframe,
        maxEntryPrice: tierMaxPrice,
        planLabel
      })

    };

  }



  const tierInfo = describeEntryTier(sizeMultiplier);

  return {

    allowed: true,

    sizeMultiplier,

    edge,

    reason: null,

    ...tierInfo

  };

}



export function computeTradeEdge(confidence, entryPrice) {

  const conf = Number(confidence);

  const price = Number(entryPrice);

  if (!Number.isFinite(conf) || !Number.isFinite(price)) return null;

  return round4(conf - price);

}

export function getKellyCapUsd({ calibratedConfidence, entryPrice, equity, config = {} }) {
  if (config.kellyCapEnabled === false) return Infinity;
  const p = Number(calibratedConfidence);
  const price = Number(entryPrice);
  const eq = Number(equity);
  if (!Number.isFinite(p) || !Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(eq) || eq <= 0) {
    return Infinity;
  }
  const b = (1 - price) / price;
  const fullKelly = (p * b - (1 - p)) / b;
  const fraction = Number(config.kellyFraction) || 0.25;
  const quarterKelly = Math.max(0, fullKelly * fraction);
  const maxPct = Number(config.kellyMaxEquityPct) || 0.08;
  return round2(eq * Math.min(quarterKelly, maxPct));
}

export function applyKellyCapToSizing(sizing, { calibratedConfidence, entryPrice, equity, config = {} }) {
  const cap = getKellyCapUsd({ calibratedConfidence, entryPrice, equity, config });
  const baseUsd = Number(sizing?.usd) || 0;
  if (!Number.isFinite(cap)) return sizing;
  if (cap <= 0) {
    return { ...sizing, usd: 0, kellyCapUsd: cap, cappedByKelly: true };
  }
  const usd = Math.min(baseUsd, cap);
  return {
    ...sizing,
    usd: round2(usd),
    kellyCapUsd: cap,
    cappedByKelly: usd < baseUsd
  };
}



export function evaluateEdgeEntry({

  confidence,

  entryPrice,

  timeframe = '15m',

  config = {},

  minConfidence = null,

  minEdge = null,

  maxEntryPrice = null,

  minEntryPrice = null,

  marketQuality = null,

  minMarketQuality = null

}) {

  const conf = Number(confidence);

  const price = Number(entryPrice);

  const minConf = Number.isFinite(Number(minConfidence))

    ? Number(minConfidence)

    : resolveMinConfidence(timeframe, config);

  const minEdg = Number.isFinite(Number(minEdge))

    ? Number(minEdge)

    : resolveMinEdge(timeframe, config);

  const maxPrice = Number.isFinite(Number(maxEntryPrice))

    ? Number(maxEntryPrice)

    : 1;

  const minPrice = Number.isFinite(Number(minEntryPrice)) ? Number(minEntryPrice) : 0;

  const qualityMin = Number.isFinite(Number(minMarketQuality))

    ? Number(minMarketQuality)

    : resolveMinMarketQuality(config);

  const quality = Number(marketQuality);

  const edge = computeTradeEdge(conf, price);



  if (!Number.isFinite(conf) || conf < minConf) {

    return {

      allowed: false,

      edge,

      reason: `置信度 ${Number.isFinite(conf) ? (conf * 100).toFixed(1) : '--'}% 低于 ${(minConf * 100).toFixed(0)}%。`

    };

  }

  if (!Number.isFinite(price) || price <= 0 || price >= 1) {

    return { allowed: false, edge, reason: '入场限价无效。' };

  }

  if (price > maxPrice) {

    return {

      allowed: false,

      edge,

      reason: `入场价 ${(price * 100).toFixed(1)}% 高于上限 ${(maxPrice * 100).toFixed(0)}%。`

    };

  }

  if (price < minPrice) {

    return {

      allowed: false,

      edge,

      reason: `入场价 ${(price * 100).toFixed(1)}% 低于下限 ${(minPrice * 100).toFixed(0)}%。`

    };

  }

  if (!Number.isFinite(edge) || edge < minEdg) {

    return {

      allowed: false,

      edge,

      reason: `边际 edge ${Number.isFinite(edge) ? (edge * 100).toFixed(1) : '--'}% 低于 ${(minEdg * 100).toFixed(0)}%（置信度 ${(conf * 100).toFixed(1)}% − 入场 ${(price * 100).toFixed(1)}%）。`

    };

  }

  if (Number.isFinite(quality) && quality < qualityMin) {

    return {

      allowed: false,

      edge,

      reason: `市场质量 ${(quality * 100).toFixed(0)}% 低于 ${(qualityMin * 100).toFixed(0)}%。`

    };

  }

  return { allowed: true, edge, reason: null };

}



export function resolveStopLossAbsoluteFloor(config = {}) {
  const raw = config.stopLossAbsoluteFloor;
  if (raw === null || raw === 0 || raw === '0') return null;
  const value = Number(raw ?? 0.50);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveStopLossPrice(entryPrice, stopLossOffset, absoluteStopLossFloor = null) {
  const entry = Number(entryPrice);
  const slOffset = Number(stopLossOffset) || 0.12;
  const offsetStop = round4(Math.max(0.01, entry - slOffset));
  const floor = Number(absoluteStopLossFloor);
  if (Number.isFinite(floor) && floor > 0 && Number.isFinite(entry) && entry >= floor) {
    return round4(floor);
  }
  return offsetStop;
}

export function computeDynamicExitPrices(entryPrice, { takeProfitOffset, stopLossOffset, absoluteStopLossFloor = null } = {}) {

  const entry = Number(entryPrice);

  const tpOffset = Number(takeProfitOffset) || 0.18;

  const slOffset = Number(stopLossOffset) || 0.12;

  if (!Number.isFinite(entry) || entry <= 0 || entry >= 1) {

    return { takeProfitPrice: null, stopLossPrice: null };

  }

  return {

    takeProfitPrice: round4(Math.min(0.99, entry + tpOffset)),

    stopLossPrice: resolveStopLossPrice(entry, slOffset, absoluteStopLossFloor)

  };

}

/**
 * 从持仓最高点回撤止盈（移动止盈）。
 * 例：50 买入，涨到 60/70 不卖；从 70 回落到 60（回撤 10c）才卖。
 * 回撤线低于入场价时不触发，避免把尚未站稳的浮盈打成亏损；硬止损仍由固定 SL 负责。
 */
export function updateAndEvaluateTrailingTakeProfit({
  entryPrice,
  currentPrice,
  peakPrice = null,
  trailOffset = 0.10
} = {}) {
  const entry = Number(entryPrice);
  const price = Number(currentPrice);
  const priorPeak = Number(peakPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(price) || price <= 0) {
    return {
      peakPrice: Number.isFinite(priorPeak) && priorPeak > 0 ? round4(priorPeak) : null,
      trailStopPrice: null,
      armed: false,
      exit: null
    };
  }

  const peak = round4(Math.max(
    entry,
    Number.isFinite(priorPeak) && priorPeak > 0 ? priorPeak : entry,
    price
  ));
  const rawTrail = Number(trailOffset);
  const offset = Number.isFinite(rawTrail) && rawTrail > 0 ? rawTrail : 0.10;
  const trailStop = round4(peak - offset);
  const armed = trailStop + 1e-9 >= entry;

  if (armed && price <= trailStop + 1e-9) {
    const pullback = round4(peak - price);
    return {
      peakPrice: peak,
      trailStopPrice: trailStop,
      armed: true,
      exit: {
        exitPrice: round4(price),
        exitStatus: 'trailing-take-profit',
        exitReason: `回撤止盈：最高 ${(peak * 100).toFixed(1)}% 回落 ${(pullback * 100).toFixed(1)}c 至 ${(price * 100).toFixed(1)}%（阈值 ${(offset * 100).toFixed(0)}c）`
      }
    };
  }

  return {
    peakPrice: peak,
    trailStopPrice: trailStop,
    armed,
    exit: null
  };
}



export function resolveOrderPct(timeframe = '15m', config = {}) {

  const explicit = timeframe === '5m' ? Number(config.orderPct5m) : Number(config.orderPct15m);

  if (Number.isFinite(explicit) && explicit > 0) {

    return explicit;

  }

  const basePrincipal = Number(config.sizingBasePrincipal) || 500;

  let orderUsd;

  if (timeframe === '5m' && Number.isFinite(Number(config.orderUsd5m))) {

    orderUsd = Number(config.orderUsd5m);

  } else if (timeframe === '15m' && Number.isFinite(Number(config.orderUsd15m))) {

    orderUsd = Number(config.orderUsd15m);

  } else {

    orderUsd = Number(config.orderUsdAtBase) || 100;

  }

  return basePrincipal > 0 ? orderUsd / basePrincipal : 0;

}



export function resolveOrderUsdAtBase(timeframe = '15m', config = {}) {

  const basePrincipal = Number(config.sizingBasePrincipal) || 500;

  const pct = resolveOrderPct(timeframe, config);

  if (pct > 0) {

    return round2(basePrincipal * pct);

  }

  if (timeframe === '5m' && Number.isFinite(Number(config.orderUsd5m))) {

    return Number(config.orderUsd5m);

  }

  if (timeframe === '15m' && Number.isFinite(Number(config.orderUsd15m))) {

    return Number(config.orderUsd15m);

  }

  return Number(config.orderUsdAtBase) || 100;

}



/** 模拟盘现金比例下单：每笔 max(最低金额, 剩余现金 × pct)，且不超过可用现金。 */
function computePaperCashPctOrderUsd({ cash, minUsd, orderPct }) {
  const availableCash = Number.isFinite(Number(cash)) && Number(cash) >= 0
    ? Number(cash)
    : 0;
  if (availableCash <= 0) return 0;

  const floorUsd = Number.isFinite(Number(minUsd)) ? Math.max(0, Number(minUsd)) : 0;
  const pct = Number(orderPct) || 0.05;

  let usd = round2(availableCash * pct);
  if (floorUsd > 0 && usd < floorUsd) {
    if (availableCash >= floorUsd) usd = floorUsd;
    else return 0;
  }
  return round2(Math.min(usd, availableCash));
}

/**
 * 解析排名权重，如 "4,3,2,1" → [4,3,2,1]。
 * 非法项忽略；若全部无效则回退默认。
 */
export function parseSymbolWrRankWeights(value, fallback = [4, 3, 2, 1]) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  const parsed = raw
    .map((item) => Number(item))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : [...fallback];
}

function normalizeSizingSymbol(symbol) {
  return String(symbol || 'BTC-USD').trim().toUpperCase() || 'BTC-USD';
}

function readSymbolWinRateEntry(winRates, symbol) {
  const key = normalizeSizingSymbol(symbol);
  const raw = winRates?.[key] ?? winRates?.[symbol] ?? null;
  if (raw == null) return { winRate: null, samples: 0 };
  if (typeof raw === 'number') {
    return {
      winRate: Number.isFinite(raw) ? raw : null,
      samples: Number.isFinite(raw) ? Infinity : 0
    };
  }
  const samples = Number(raw.samples ?? raw.total ?? raw.settledOrders) || 0;
  const winRate = Number(raw.winRate);
  return {
    winRate: Number.isFinite(winRate) ? winRate : null,
    samples
  };
}

/**
 * 按币种胜率排名分配仓位比例（可解释奖赏，非 ML）。
 *
 * 语义（默认 mean_preserving）：
 *   cashPct_i = baseCashPct * (w_i / sum(w)) * n
 *   → 各币平均仍 ≈ baseCashPct；第1名 > base，末名 < base。
 * fixed_pool：
 *   cashPct_i = baseCashPct * (w_i / sum(w))
 *   → 若四币同时满仓，总敞口 ≈ baseCashPct。
 *
 * 并列：竞赛名次（同胜率同名次），同名次共用该档权重，再按权重归一。
 * 冷启动（samples < minSamples）：给「前 n 档权重均值」作为中性权重，避免饿死新币。
 * 全部冷启动 / 无法区分 / 仅 1 币 → 平分（sizeScale=1）。
 */
export function allocateCashPctBySymbolRank({
  symbols = [],
  winRates = {},
  baseCashPct,
  rankWeights = [4, 3, 2, 1],
  minSamples = 10,
  mode = 'mean_preserving'
} = {}) {
  const base = Number(baseCashPct);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
  const weights = parseSymbolWrRankWeights(rankWeights);
  const minN = Math.max(1, Number(minSamples) || 10);
  const poolMode = String(mode || 'mean_preserving').toLowerCase() === 'fixed_pool'
    ? 'fixed_pool'
    : 'mean_preserving';

  const unique = [];
  const seen = new Set();
  for (const raw of symbols || []) {
    const symbol = normalizeSizingSymbol(raw);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }

  const empty = {
    mode: poolMode,
    baseCashPct: safeBase,
    equalized: true,
    bySymbol: {},
    weights: {},
    sizeScales: {},
    cashPcts: {}
  };
  if (!unique.length || safeBase <= 0) return empty;

  const n = unique.length;
  const neutralWeight = weights.slice(0, n).reduce((sum, w) => sum + w, 0) / n;
  const rows = unique.map((symbol) => {
    const { winRate, samples } = readSymbolWinRateEntry(winRates, symbol);
    const coldStart = !(samples >= minN && Number.isFinite(winRate));
    return { symbol, winRate, samples, coldStart };
  });

  const rankedPool = rows.filter((row) => !row.coldStart);
  const allCold = rankedPool.length === 0;
  let equalized = allCold || n === 1;
  if (!equalized && rankedPool.length >= 2) {
    const firstWr = rankedPool[0].winRate;
    equalized = rankedPool.every((row) => Math.abs(row.winRate - firstWr) < 1e-12);
  } else if (!equalized && rankedPool.length === 1 && rows.some((row) => row.coldStart)) {
    // 仅 1 个可排名币 + 冷启动币：可排名者拿最高档，冷启动拿中性档（不整组平分）
    equalized = false;
  }

  const weightBySymbol = {};
  const rankBySymbol = {};

  if (equalized) {
    for (const row of rows) {
      weightBySymbol[row.symbol] = 1;
      rankBySymbol[row.symbol] = 1;
    }
  } else {
    const sorted = [...rankedPool].sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return a.symbol.localeCompare(b.symbol);
    });
    let currentRank = 1;
    for (let i = 0; i < sorted.length; i += 1) {
      if (i > 0 && sorted[i].winRate < sorted[i - 1].winRate - 1e-12) {
        currentRank = i + 1;
      }
      const weightIdx = Math.min(currentRank - 1, weights.length - 1);
      weightBySymbol[sorted[i].symbol] = weights[weightIdx];
      rankBySymbol[sorted[i].symbol] = currentRank;
    }
    for (const row of rows) {
      if (!row.coldStart) continue;
      weightBySymbol[row.symbol] = neutralWeight;
      rankBySymbol[row.symbol] = null;
    }
  }

  const sumWeights = unique.reduce((sum, symbol) => sum + (Number(weightBySymbol[symbol]) || 0), 0);
  const bySymbol = {};
  const sizeScales = {};
  const cashPcts = {};
  for (const row of rows) {
    const w = Number(weightBySymbol[row.symbol]) || 0;
    const share = sumWeights > 0 ? w / sumWeights : 1 / n;
    // mean_preserving: scale = share * n（均值≈1）；fixed_pool: scale = share（总和≈1）
    const sizeScale = equalized
      ? 1
      : round4(poolMode === 'fixed_pool' ? share : share * n);
    const cashPct = equalized
      ? round4(safeBase)
      : round4(safeBase * sizeScale);
    bySymbol[row.symbol] = {
      symbol: row.symbol,
      winRate: row.winRate,
      samples: row.samples,
      coldStart: row.coldStart,
      rank: rankBySymbol[row.symbol],
      weight: round4(w),
      sizeScale,
      cashPct
    };
    sizeScales[row.symbol] = sizeScale;
    cashPcts[row.symbol] = cashPct;
  }

  return {
    mode: poolMode,
    baseCashPct: safeBase,
    equalized,
    minSamples: minN,
    rankWeights: weights,
    bySymbol,
    weights: weightBySymbol,
    sizeScales,
    cashPcts
  };
}

/**
 * 解析某币种经胜率奖赏后的 orderPct / sizeScale。
 * 关闭开关或缺少 activeSymbols 时原样返回 baseOrderPct。
 */
export function resolveSymbolWrSizedOrderPct({
  symbol,
  baseOrderPct,
  activeSymbols = null,
  winRates = null,
  config = {}
} = {}) {
  const base = Number(baseOrderPct);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
  if (config.symbolWrSizingEnabled === false || safeBase <= 0) {
    return {
      enabled: false,
      orderPct: safeBase,
      sizeScale: 1,
      cashPct: safeBase,
      allocation: null
    };
  }

  const symbols = Array.isArray(activeSymbols) && activeSymbols.length
    ? activeSymbols
    : (winRates && typeof winRates === 'object' ? Object.keys(winRates) : []);
  if (!symbols.length) {
    return {
      enabled: true,
      orderPct: safeBase,
      sizeScale: 1,
      cashPct: safeBase,
      allocation: null,
      reason: 'no_active_symbols'
    };
  }

  const allocation = allocateCashPctBySymbolRank({
    symbols,
    winRates: winRates || {},
    baseCashPct: safeBase,
    rankWeights: config.symbolWrRankWeights || [4, 3, 2, 1],
    minSamples: config.symbolWrMinSamples || 10,
    mode: config.symbolWrSizingMode || 'mean_preserving'
  });
  const key = normalizeSizingSymbol(symbol);
  const row = allocation.bySymbol[key];
  if (!row) {
    return {
      enabled: true,
      orderPct: safeBase,
      sizeScale: 1,
      cashPct: safeBase,
      allocation,
      reason: 'symbol_not_in_active_set'
    };
  }
  return {
    enabled: true,
    orderPct: row.cashPct,
    sizeScale: row.sizeScale,
    cashPct: row.cashPct,
    rank: row.rank,
    weight: row.weight,
    coldStart: row.coldStart,
    winRate: row.winRate,
    samples: row.samples,
    allocation
  };
}

/** Plan1 模拟盘专用：每笔 max(最低金额, 剩余现金 × pct)。 */
export function computePlan1PaperOrderUsd({ cash, config = {}, orderPct = null }) {
  return computePaperCashPctOrderUsd({
    cash,
    minUsd: Number.isFinite(Number(config.plan1PaperMinOrderUsd)) ? Number(config.plan1PaperMinOrderUsd) : 1,
    orderPct: Number.isFinite(Number(orderPct))
      ? Number(orderPct)
      : (Number(config.plan1PaperOrderPct) || 0.05)
  });
}

/** Plan2 模拟盘专用：每笔 max(最低金额, 剩余现金 × pct)，且不超过可用现金。 */
export function computePlan2PaperOrderUsd({ cash, config = {}, orderPct = null }) {
  return computePaperCashPctOrderUsd({
    cash,
    minUsd: Number.isFinite(Number(config.plan2PaperMinOrderUsd)) ? Number(config.plan2PaperMinOrderUsd) : 1,
    orderPct: Number.isFinite(Number(orderPct))
      ? Number(orderPct)
      : (Number(config.plan2PaperOrderPct) || 0.05)
  });
}

export function computePolymarketOrderUsd({

  equity,

  cash,

  timeframe = '15m',

  config = {}

}) {

  const basePrincipal = Number(config.sizingBasePrincipal) || 500;

  const orderPct = resolveOrderPct(timeframe, config);

  const orderAtBase = resolveOrderUsdAtBase(timeframe, config);

  const normalizedEquity = Math.max(0, Number(equity) || 0);

  const scale = basePrincipal > 0 ? normalizedEquity / basePrincipal : 0;

  let usd = round2(normalizedEquity * orderPct);

  const availableCash = Number(cash);

  const maxCap = Number(config.maxOrderUsd);

  const maxEquityPct = Number(config.maxOrderEquityPct);



  if (Number.isFinite(maxEquityPct) && maxEquityPct > 0 && normalizedEquity > 0) {

    usd = Math.min(usd, round2(normalizedEquity * maxEquityPct));

  }

  if (Number.isFinite(maxCap) && maxCap > 0) {

    usd = Math.min(usd, maxCap);

  }

  if (Number.isFinite(availableCash) && availableCash >= 0) {

    usd = Math.min(usd, availableCash);

  }

  usd = round2(Math.max(0, usd));



  return {

    usd,

    scale: round4(scale),

    equity: round2(normalizedEquity),

    basePrincipal,

    orderAtBase,

    orderPct: round4(orderPct),

    timeframe,

    ratioAtBase: round4(orderPct),

    cappedByCash: Number.isFinite(availableCash) && usd >= availableCash,

    cappedByMax: Number.isFinite(maxCap) && maxCap > 0 && usd >= maxCap,

    cappedByEquityPct: Number.isFinite(maxEquityPct) && maxEquityPct > 0 && normalizedEquity > 0

      && usd >= round2(normalizedEquity * maxEquityPct)

  };

}



export function scalePolymarketOrderByConfidence({

  sizing,

  confidence,

  qualityScore = 1,

  minConfidence = 0.56,

  sizeMultiplier = 1,

  cash

}) {

  const baseUsd = Number(sizing?.usd) || 0;

  const conf = Number(confidence);

  if (!Number.isFinite(conf) || conf < minConfidence || baseUsd <= 0) {

    return {

      ...sizing,

      usd: 0,

      baseUsd: round2(baseUsd),

      confidenceMultiplier: 0,

      qualityMultiplier: 0,

      scaledByConfidence: true

    };

  }



  const confidenceRange = Math.max(0.0001, 0.9 - minConfidence);

  const confidenceProgress = clamp((conf - minConfidence) / confidenceRange, 0, 1);

  const confidenceMultiplier = 0.45 + confidenceProgress * 0.8;

  const quality = clamp(Number(qualityScore), 0.15, 1);

  const qualityMultiplier = quality < 0.5 ? 0.55 : quality < 0.75 ? 0.8 : 1;

  const tierMultiplier = clamp(Number(sizeMultiplier) || 0, 0, 1);

  let usd = round2(baseUsd * tierMultiplier * confidenceMultiplier * qualityMultiplier);

  const availableCash = Number(cash);

  const maxCap = Number(sizing?.usd);



  if (Number.isFinite(maxCap) && maxCap >= 0) {

    usd = Math.min(usd, maxCap);

  }

  if (Number.isFinite(availableCash) && availableCash >= 0) {

    usd = Math.min(usd, availableCash);

  }



  return {

    ...sizing,

    usd: round2(Math.max(0, usd)),

    baseUsd: round2(baseUsd),

    confidenceMultiplier: round4(confidenceMultiplier),

    qualityMultiplier: round4(qualityMultiplier),

    sizeMultiplier: round4(tierMultiplier),

    scaledByConfidence: true

  };

}



export function describePolymarketSizing(config = {}) {

  const basePrincipal = Number(config.sizingBasePrincipal) || 500;

  const orderPct5m = resolveOrderPct('5m', config);

  const orderPct15m = resolveOrderPct('15m', config);

  const orderUsd5m = resolveOrderUsdAtBase('5m', config);

  const orderUsd15m = resolveOrderUsdAtBase('15m', config);

  return {

    basePrincipal,

    orderPct5m: round4(orderPct5m),

    orderPct15m: round4(orderPct15m),

    orderUsd5m,

    orderUsd15m,

    orderUsdAtBase: Number(config.orderUsdAtBase) || orderUsd15m,

    summary: `15m tier1 = 净值 × ${(orderPct15m * 100).toFixed(0)}%，5m tier1 = 净值 × ${(orderPct5m * 100).toFixed(0)}%（基准本金 $${basePrincipal} 时约 $${orderUsd15m}/$${orderUsd5m}），再乘 tier 与置信度`

  };

}



export function previewTierOrderUsd(equity, timeframe = '15m', config = {}) {

  const base = computePolymarketOrderUsd({ equity, cash: equity, timeframe, config });

  const tiers = [

    { tier: 'tier1', multiplier: 1 },

    { tier: 'tier2', multiplier: 0.5 },

    { tier: 'tier3', multiplier: 0.25 },

    { tier: 'tier4', multiplier: 0.15 }

  ];

  return tiers.map(({ tier, multiplier }) => ({

    tier,

    multiplier,

    usd: round2(base.usd * multiplier)

  }));

}



function round2(value) {

  return Math.round(Number(value) * 100) / 100;

}



function round4(value) {

  return Math.round(Number(value) * 1e4) / 1e4;

}



function clamp(value, min, max) {

  if (!Number.isFinite(value)) return min;

  return Math.max(min, Math.min(max, value));

}


