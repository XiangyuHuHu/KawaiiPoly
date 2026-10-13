import {
  findCryptoUpDownMarket,
  extractMarketTargetPrice,
  parseMarketOutcomes,
  pickBestIntervalMarket,
  PolymarketClient
} from './polymarketClient.js';
import { getSlotSchedule, timeframeToSlotMinutes } from './polymarketSchedule.js';
import { recordWindowSnapshot, analyzeWindowTrajectory, analyzeFiveMinutePath } from './polymarketWindowTrack.js';
import { windowElapsedPct } from './polymarketPlan.js';

const SYMBOL_ASSET = {
  'BTC-USD': { asset: 'bitcoin' },
  'ETH-USD': { asset: 'ethereum' },
  'SOL-USD': { asset: 'solana' },
  'XRP-USD': { asset: 'xrp' }
};

const priceHistory = new Map();
const MIN_PRICE_HISTORY_INTERVAL_MS = 1000;
const MAX_PRICE_HISTORY_SAMPLES = 2000;

export async function buildPolymarketSentiment({
  symbol = 'BTC-USD',
  targetTimeIso,
  timeframe = '15m',
  client = new PolymarketClient(),
  now = new Date(),
  btcPrice = null,
  elapsedPct = null,
  recordSnapshot = false,
  lightweight = false
}) {
  const mapping = SYMBOL_ASSET[symbol];
  if (!mapping) {
    return unavailableSentiment(symbol, 'Unsupported symbol for Polymarket sentiment.', timeframe);
  }

  try {
    let market = await findCryptoUpDownMarket(client, targetTimeIso, timeframe, mapping.asset);
    if (!market) {
      const markets = await client.searchCryptoMarkets({ ...mapping, timeframe });
      market = pickBestIntervalMarket(markets, targetTimeIso, timeframe);
    }
    if (!market) {
      return unavailableSentiment(symbol, `No active ${mapping.asset} up/down ${timeframe} market matched the current slot.`, timeframe);
    }

    const parsed = parseMarketOutcomes(market);
    const targetPrice = extractMarketTargetPrice(market);
    if (!parsed.upTokenId || !parsed.downTokenId) {
      return unavailableSentiment(symbol, 'Polymarket market is missing CLOB token IDs.');
    }

    // Plan5 only needs the market's probability pair to form/consume its lock.
    // Pulling both books, both prices, both spreads and recent trades here used to
    // leave dozens of CLOB requests running after the outer deadline. Execution
    // still refreshes the selected token's executable price immediately before buy.
    const [upBook, downBook, upMidPrice, downMidPrice, upSpread, downSpread, trades] = lightweight
      ? [null, null, NaN, NaN, NaN, NaN, []]
      : await Promise.all([
        client.getOrderBook(parsed.upTokenId).catch(() => null),
        client.getOrderBook(parsed.downTokenId).catch(() => null),
        client.getTokenPrice(parsed.upTokenId, 'BUY').catch(() => NaN),
        client.getTokenPrice(parsed.downTokenId, 'BUY').catch(() => NaN),
        client.getTokenSpread(parsed.upTokenId).catch(() => NaN),
        client.getTokenSpread(parsed.downTokenId).catch(() => NaN),
        market.conditionId ? client.getRecentTrades({ conditionId: market.conditionId, limit: 20 }).catch(() => []) : []
      ]);

    const upPrice = pickPrice({
      midpoint: upMidPrice,
      gammaPrice: parsed.upPrice,
      bestBid: Number(market.bestBid),
      lastTradePrice: Number(market.lastTradePrice)
    });
    const downPrice = pickPrice({
      midpoint: downMidPrice,
      gammaPrice: parsed.downPrice,
      bestBid: Number(market.bestAsk ? 1 - market.bestAsk : NaN),
      lastTradePrice: Number.isFinite(upPrice) ? Math.max(0, 1 - upPrice) : parsed.downPrice
    });

    const normalized = normalizeBinaryProbabilities(upPrice, downPrice);
    const historyKey = market.id || market.conditionId || market.slug;
    recordPriceSnapshot(historyKey, normalized.upProbability, normalized.downProbability, now);
    const upPriceChange5m = computePriceChange5m(historyKey, 'up', now);
    const directionFlipCount5m = computeDirectionFlipCount(historyKey, now, 5 * 60 * 1000);

    const upBidDepth = sumSideDepth(upBook?.bids);
    const downBidDepth = sumSideDepth(downBook?.bids);
    const spread = resolvePolymarketSpread({ upSpread, downSpread, upBook, downBook });
    const liquidity = Number(market.liquidity || market.liquidityNum || 0);
    const volume24h = Number(market.volume24hr || market.volume || 0);
    const recentTradeBias = summarizeRecentTrades(trades, parsed);

    let orderbookBias = 'neutral';
    if (upBidDepth > downBidDepth * 1.08) orderbookBias = 'up';
    else if (downBidDepth > upBidDepth * 1.08) orderbookBias = 'down';

    const sentiment = classifySentiment({ upPrice: normalized.upProbability, upPriceChange5m, orderbookBias, recentTradeBias });
    const quality = lightweight
      ? scorePolymarketPriceSnapshotQuality({
        upPrice: normalized.upProbability,
        downPrice: normalized.downProbability,
        liquidity,
        volume24h
      })
      : scorePolymarketQuality({
        upPrice: normalized.upProbability,
        downPrice: normalized.downProbability,
        spread,
        liquidity,
        volume24h,
        upBidDepth,
        downBidDepth,
        recentTradeCount: trades.length
      });
    const confidenceBoost = estimateConfidenceBoost({
      upPrice: normalized.upProbability,
      upPriceChange5m,
      orderbookBias,
      spread,
      liquidity,
      volume24h,
      sentiment
    });

    const schedule = getSlotSchedule(now, timeframeToSlotMinutes(timeframe));
    const resolvedElapsedPct = Number.isFinite(Number(elapsedPct))
      ? Number(elapsedPct)
      : windowElapsedPct(schedule);
    if (recordSnapshot) {
      recordPolymarketWindowSnapshot({
        schedule,
        timeframe,
        symbol,
        marketKey: market.slug || market.conditionId || market.id,
        upPrice: round4(upPrice),
        downPrice: round4(downPrice),
        btcPrice,
        elapsedPct: resolvedElapsedPct,
        now
      });
    }

    return {
      available: true,
      symbol,
      timeframe,
      slotMinutes: timeframeToSlotMinutes(timeframe),
      market: market.question || market.slug,
      marketSlug: market.slug,
      targetPrice: targetPrice ? round2(targetPrice.price) : null,
      targetPriceSource: targetPrice?.source || null,
      conditionId: market.conditionId,
      upTokenId: parsed.upTokenId,
      downTokenId: parsed.downTokenId,
      upPrice: round4(upPrice),
      downPrice: round4(downPrice),
      upBestAsk: round4(bestBookAsk(upBook)),
      downBestAsk: round4(bestBookAsk(downBook)),
      upProbability: round4(normalized.upProbability),
      downProbability: round4(normalized.downProbability),
      probabilitySource: normalized.source,
      upPriceChange5m: round4(upPriceChange5m),
      directionFlipCount5m,
      spread: round4(spread),
      upSpread: round4(upSpread),
      downSpread: round4(downSpread),
      upBookSpread: round4(estimateOrderBookSpread(upBook)),
      downBookSpread: round4(estimateOrderBookSpread(downBook)),
      liquidity: round2(liquidity),
      volume24h: round2(volume24h),
      upBidDepth: round2(upBidDepth),
      downBidDepth: round2(downBidDepth),
      orderbookBias,
      recentTradeBias,
      recentTradeCount: trades.length,
      sentiment,
      qualityScore: round4(quality.score),
      qualityLabel: quality.label,
      qualityReasons: quality.reasons,
      confidenceBoost: round4(confidenceBoost),
      targetTimeIso,
      schedule,
      windowTrack: {
        path: analyzeFiveMinutePath({
          slotIso: schedule.currentSlotIso,
          timeframe,
          symbol,
          config: {}
        }),
        up: analyzeWindowTrajectory({
          slotIso: schedule.currentSlotIso,
          timeframe,
          symbol,
          direction: 'up',
          config: {},
          now
        }),
        down: analyzeWindowTrajectory({
          slotIso: schedule.currentSlotIso,
          timeframe,
          symbol,
          direction: 'down',
          config: {},
          now
        })
      },
      fetchedAtIso: now.toISOString()
    };
  } catch (error) {
    return unavailableSentiment(symbol, error.message, timeframe);
  }
}

export function recordPolymarketWindowSnapshot({
  schedule,
  timeframe,
  symbol = 'BTC-USD',
  marketKey = null,
  upPrice,
  downPrice,
  btcPrice = null,
  elapsedPct,
  now = new Date()
}) {
  if (!schedule?.currentSlotIso) return null;
  return recordWindowSnapshot({
    slotIso: schedule.currentSlotIso,
    timeframe,
    symbol,
    marketKey,
    upPrice,
    downPrice,
    btcPrice,
    elapsedPct,
    now
  });
}

export function classifySentiment({ upPrice, upPriceChange5m, orderbookBias, recentTradeBias }) {
  const bullishSignals =
    Number(upPrice) >= 0.55 ||
    Number(upPriceChange5m) >= 0.03 ||
    (orderbookBias === 'up' && Number(upPriceChange5m) > 0) ||
    recentTradeBias === 'up';

  const bearishSignals =
    Number(upPrice) <= 0.45 ||
    Number(upPriceChange5m) <= -0.03 ||
    (orderbookBias === 'down' && Number(upPriceChange5m) < 0) ||
    recentTradeBias === 'down';

  if (bullishSignals && !bearishSignals) return 'bullish';
  if (bearishSignals && !bullishSignals) return 'bearish';
  return 'neutral';
}

export function estimateConfidenceBoost({ upPrice, upPriceChange5m, orderbookBias, spread, liquidity, volume24h, sentiment }) {
  let boost = 0;
  if (sentiment === 'bullish' || sentiment === 'bearish') boost += 0.08;
  boost += Math.min(0.06, Math.abs(Number(upPriceChange5m)) * 1.5);
  if (Number.isFinite(spread) && spread <= 0.03) boost += 0.04;
  if (liquidity >= 50_000) boost += 0.03;
  if (volume24h >= 250_000) boost += 0.03;
  if (orderbookBias === 'up' && sentiment === 'bullish') boost += 0.02;
  if (orderbookBias === 'down' && sentiment === 'bearish') boost += 0.02;
  return Math.min(0.2, boost);
}

export function scorePolymarketQuality({
  upPrice,
  downPrice,
  spread,
  liquidity,
  volume24h,
  upBidDepth,
  downBidDepth,
  recentTradeCount
}) {
  let score = 1;
  const reasons = [];
  const totalBidDepth = Number(upBidDepth) + Number(downBidDepth);
  const priceEdge = Math.abs(Number(upPrice) - Number(downPrice));

  if (!Number.isFinite(spread) || spread > 0.08) {
    score -= 0.28;
    reasons.push('spread偏大');
  } else if (spread > 0.05) {
    score -= 0.16;
    reasons.push('spread中等');
  }

  if (!Number.isFinite(liquidity) || liquidity < 1_000) {
    score -= 0.24;
    reasons.push('流动性低');
  } else if (liquidity < 5_000) {
    score -= 0.12;
    reasons.push('流动性一般');
  }

  if (!Number.isFinite(volume24h) || volume24h < 2_000) {
    score -= 0.18;
    reasons.push('成交量低');
  } else if (volume24h < 10_000) {
    score -= 0.08;
    reasons.push('成交量一般');
  }

  if (!Number.isFinite(totalBidDepth) || totalBidDepth < 250) {
    score -= 0.18;
    reasons.push('盘口深度低');
  }

  if (Number.isFinite(priceEdge) && priceEdge < 0.04) {
    score -= 0.12;
    reasons.push('接近50/50');
  }

  if (Number(recentTradeCount) < 3) {
    score -= 0.08;
    reasons.push('近期成交少');
  }

  const normalized = Math.max(0.15, Math.min(1, score));
  return {
    score: normalized,
    label: normalized >= 0.75 ? '高' : normalized >= 0.5 ? '中' : '低',
    reasons: reasons.length ? reasons : ['盘口质量正常']
  };
}

function unavailableSentiment(symbol, reason, timeframe = '15m') {
  return {
    available: false,
    symbol,
    timeframe,
    slotMinutes: timeframeToSlotMinutes(timeframe),
    reason,
    sentiment: 'neutral',
    confidenceBoost: 0
  };
}

function recordPriceSnapshot(key, upPrice, downPrice, now = new Date()) {
  const ts = now.getTime();
  const rows = priceHistory.get(key) || [];
  const sample = { ts, upPrice: Number(upPrice), downPrice: Number(downPrice) };
  const previous = rows.at(-1);
  if (previous && ts - previous.ts < MIN_PRICE_HISTORY_INTERVAL_MS) {
    rows[rows.length - 1] = { ...sample, ts: previous.ts };
  } else {
    rows.push(sample);
  }
  const cutoff = ts - 30 * 60 * 1000;
  const retained = rows.filter((row) => row.ts >= cutoff);
  priceHistory.set(key, retained.slice(-MAX_PRICE_HISTORY_SAMPLES));
}

function scorePolymarketPriceSnapshotQuality({ upPrice, downPrice, liquidity, volume24h }) {
  const quoteSum = Number(upPrice) + Number(downPrice);
  const edge = Math.abs(Number(upPrice) - Number(downPrice));
  let score = 0.8;
  const reasons = ['Polymarket 价格快照'];
  if (!Number.isFinite(quoteSum) || quoteSum < 0.95 || quoteSum > 1.08) {
    score -= 0.35;
    reasons.push('报价和异常');
  }
  if (!Number.isFinite(edge) || edge < 0.04) {
    score -= 0.15;
    reasons.push('接近50/50');
  }
  if (Number.isFinite(liquidity) && liquidity > 0 && liquidity < 1_000) {
    score -= 0.1;
    reasons.push('流动性低');
  }
  if (Number.isFinite(volume24h) && volume24h > 0 && volume24h < 2_000) {
    score -= 0.05;
    reasons.push('成交量低');
  }
  const normalized = Math.max(0.15, Math.min(1, score));
  return {
    score: normalized,
    label: normalized >= 0.75 ? '高' : normalized >= 0.5 ? '中' : '低',
    reasons
  };
}

function computePriceChange5m(key, side, now = new Date()) {
  const rows = priceHistory.get(key) || [];
  if (rows.length < 2) return 0;
  const targetTs = now.getTime() - 5 * 60 * 1000;
  const reference = rows.reduce((best, row) =>
    Math.abs(row.ts - targetTs) < Math.abs(best.ts - targetTs) ? row : best, rows[0]);
  const latest = rows.at(-1);
  const field = side === 'up' ? 'upPrice' : 'downPrice';
  return Number(latest[field]) - Number(reference[field]);
}

function computeDirectionFlipCount(key, now = new Date(), lookbackMs = 5 * 60 * 1000) {
  const rows = priceHistory.get(key) || [];
  const cutoff = now.getTime() - lookbackMs;
  const recent = rows
    .filter((row) => row.ts >= cutoff)
    .map((row) => {
      const up = Number(row.upPrice);
      const down = Number(row.downPrice);
      if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
      return up >= down ? 'up' : 'down';
    })
    .filter(Boolean);
  if (recent.length < 2) return 0;
  let flips = 0;
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index] !== recent[index - 1]) flips += 1;
  }
  return flips;
}

function pickPrice({ midpoint, gammaPrice, bestBid, lastTradePrice }) {
  if (Number.isFinite(midpoint) && midpoint > 0 && midpoint < 1) return midpoint;
  if (Number.isFinite(gammaPrice) && gammaPrice > 0 && gammaPrice < 1) return gammaPrice;
  if (Number.isFinite(bestBid) && bestBid > 0 && bestBid < 1) return bestBid;
  if (Number.isFinite(lastTradePrice) && lastTradePrice > 0 && lastTradePrice < 1) return lastTradePrice;
  return 0.5;
}

function normalizeBinaryProbabilities(upPrice, downPrice) {
  const up = Number(upPrice);
  const down = Number(downPrice);
  if (Number.isFinite(up) && Number.isFinite(down) && up > 0 && down > 0) {
    const sum = up + down;
    if (sum > 0) {
      return {
        upProbability: up / sum,
        downProbability: down / sum,
        source: Math.abs(sum - 1) > 0.03 ? 'normalized_price_pair' : 'price_pair'
      };
    }
  }
  if (Number.isFinite(up) && up > 0 && up < 1) {
    return {
      upProbability: up,
      downProbability: 1 - up,
      source: 'up_price_inverse'
    };
  }
  return {
    upProbability: 0.5,
    downProbability: 0.5,
    source: 'fallback'
  };
}

function sumSideDepth(levels = []) {
  return levels.reduce((sum, level) => {
    const size = Array.isArray(level) ? Number(level[1]) : Number(level?.size);
    return sum + (Number.isFinite(size) ? size : 0);
  }, 0);
}

function levelPrice(level) {
  return Number(Array.isArray(level) ? level[0] : level?.price);
}

export function estimateOrderBookSpread(book) {
  const bids = (book?.bids || []).map(levelPrice).filter(Number.isFinite);
  const asks = (book?.asks || []).map(levelPrice).filter(Number.isFinite);
  const bestBid = bids.length ? Math.max(...bids) : NaN;
  const bestAsk = asks.length ? Math.min(...asks) : NaN;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return NaN;
  return Math.max(0, bestAsk - bestBid);
}

function bestBookAsk(book) {
  const asks = (book?.asks || []).map(levelPrice).filter(Number.isFinite);
  return asks.length ? Math.min(...asks) : NaN;
}

export function resolvePolymarketSpread({ upSpread, downSpread, upBook, downBook } = {}) {
  const apiSpread = averageFinite([Number(upSpread), Number(downSpread)]);
  if (Number.isFinite(apiSpread)) return apiSpread;
  return averageFinite([
    estimateOrderBookSpread(upBook),
    estimateOrderBookSpread(downBook)
  ]);
}

function summarizeRecentTrades(trades, parsed) {
  if (!Array.isArray(trades) || !trades.length) return 'neutral';
  let upVolume = 0;
  let downVolume = 0;
  for (const trade of trades) {
    const size = Number(trade.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    const outcome = String(trade.outcome || '').toLowerCase();
    if (/up|yes|higher/.test(outcome)) upVolume += size;
    else if (/down|no|lower/.test(outcome)) downVolume += size;
    else if (trade.asset === parsed.upTokenId) upVolume += size;
    else if (trade.asset === parsed.downTokenId) downVolume += size;
  }
  if (upVolume > downVolume * 1.15) return 'up';
  if (downVolume > upVolume * 1.15) return 'down';
  return 'neutral';
}

function averageFinite(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return NaN;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

export function __resetPriceHistoryForTests() {
  priceHistory.clear();
}
