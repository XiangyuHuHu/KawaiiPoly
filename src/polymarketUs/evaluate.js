import { blendModelToMarket, marketProbability, round4 as roundProb } from './calibration.js';
import { eventUrl } from './gateway.js';
import {
  bboIsFresh,
  cleanerEdgeFloor,
  exploratoryDistanceKind,
  exploratoryOrderKind,
  US_RULES,
  US_SPEC_VERSION
} from './rules.js';
import { US_EXPLORATORY_SIZE_USD } from './constants.js';
import { normalizeSector } from './shape.js';

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function sidePolarity(side) {
  const text = String(side || '').trim().toLowerCase();
  if (['up', 'yes', 'higher', 'above'].includes(text)) return 'up';
  if (['down', 'no', 'lower', 'below'].includes(text)) return 'down';
  return null;
}

export function displaySide(side, timeframe) {
  const polarity = sidePolarity(side);
  if (timeframe === '15m' || timeframe === '1h') {
    if (polarity === 'up') return 'Up';
    if (polarity === 'down') return 'Down';
  }
  if (polarity === 'up') return /^yes$/i.test(String(side)) ? 'Yes' : (side === 'Up' ? 'Up' : 'Yes');
  if (polarity === 'down') return /^no$/i.test(String(side)) ? 'No' : (side === 'Down' ? 'Down' : 'No');
  return String(side || '');
}

export function sizeForRecord({ wins = 0, losses = 0, lossStreak = 0 } = {}, rules = US_RULES) {
  const samples = wins + losses;
  const winRate = samples ? wins / samples : null;
  const weak = (winRate != null && winRate < rules.size.weakWinRate) || lossStreak >= rules.size.lossStreak;
  let usd = rules.size.defaultUsd;
  let tier = 'default';
  if (winRate != null && winRate + 1e-12 >= rules.size.tier80MinWinRate && samples >= rules.size.tier80MinSamples) {
    usd = rules.size.tier80Usd;
    tier = '80';
  } else if (winRate != null && winRate + 1e-12 >= rules.size.tier70MinWinRate && samples >= rules.size.tier70MinSamples) {
    usd = rules.size.tier70Usd;
    tier = '70';
  }
  if (weak) {
    usd = rules.size.defaultUsd;
    tier = 'weak';
  }
  return { usd, tier, weak, winRate, samples };
}

export function minEdgeFor(sector, { liveKind = null, weak = false } = {}, rules = US_RULES) {
  if (sector === 'momentum') return null;
  if (sector === 'live' && liveKind === 'endgame') return null;
  let edge = sector === 'live'
    ? rules.edge.liveInGame
    : sector === 'btc-misprice'
      ? rules.edge.btcMisprice
      : rules.edge.nonBtcNonLive;
  return cleanerEdgeFloor(edge, weak, rules);
}

function rulesSector(value, rules = US_RULES) {
  const canonical = normalizeSector(value);
  if (!canonical) return null;
  if (rules.dailyCaps[canonical]) return canonical;
  if (canonical === 'btc_misprice' && rules.dailyCaps['btc-misprice']) return 'btc-misprice';
  return null;
}

export function intlOnlyReason(input = {}, rules = US_RULES) {
  const text = [input.title, input.question, input.slug, input.category, input.city]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const btc = /\bbtc\b|\bbitcoin\b/.test(text);
  if (!btc && /\bethereum\b|\beth-usd\b|\beth\b/.test(text)) return 'eth';
  if (/treasury|t-bill|美债/.test(text)) return 'treasury';
  const city = String(input.city || '').trim();
  if ((input.sector === 'weather' || input.category === 'weather') && city) {
    const allowed = rules.weatherCities.some((name) => name.toLowerCase() === city.toLowerCase());
    if (!allowed) return 'weather-city';
  }
  if (/london|tokyo|paris|shanghai|beijing|柏林|东京|伦敦|巴黎/.test(text)
    && /temp|weather|温度|最高/.test(text)) {
    return 'weather-city';
  }
  return null;
}

export function btcResolutionRisk(market) {
  const terms = market?.assetPriceTerms || null;
  const description = String(market?.description || '');
  const brti = terms?.indexSymbol === 'BRTI' || /\bBRTI\b/.test(description);
  const upDown = terms?.marketType === 'ASSET_PRICE_MARKET_TYPE_UP_DOWN' || /settle to Up/i.test(description);
  const touch = /\btouch\b/i.test(description);
  if (!brti || !upDown || touch) return 'High';
  if (/simple average of these prices/i.test(description) || terms?.priceDecimals === 2) return 'Low';
  return 'Med';
}

export function rankConfidenceScore(value, rules = US_RULES) {
  if (value === 'High' || value === 'Med' || value === 'Low') return value;
  const score = finite(value);
  if (score == null) return null;
  if (score + 1e-12 >= rules.confidence.highMin) return 'High';
  if (score + 1e-12 >= rules.confidence.medMin) return 'Med';
  return 'Low';
}

function confidenceRank(value, modelProb, rules) {
  if (value === 'High' || value === 'Med' || value === 'Low') return value;
  const scored = rankConfidenceScore(value, rules);
  if (scored === 'Low') return 'Low';
  const prob = finite(modelProb);
  if (prob == null) return scored || 'Low';
  const conviction = Math.max(prob, 1 - prob);
  if (conviction + 1e-12 >= rules.confidence.highMin) return 'High';
  if (conviction + 1e-12 >= rules.confidence.medMin) return 'Med';
  return 'Low';
}

function reject(reason) {
  return { ok: false, reason, signal: null };
}

/**
 * Decide whether a US quote is a pending order. Does not place the order.
 */
export function evaluateUsSignal(input, rules = US_RULES) {
  const writtenSector = normalizeSector(input?.sector);
  const sector = rulesSector(input?.sector, rules);
  if (!writtenSector || !sector || !rules.dailyCaps[sector]) return reject('unknown-sector');
  const polarity = sidePolarity(input.side);
  if (!polarity) return reject('side');
  const ask = finite(input.ask);
  const bid = finite(input.bid);
  if (ask == null || !(ask > 0 && ask < 1)) return reject('missing-ask');
  const spreadCents = finite(input.spreadCents) ?? (bid == null ? null : round4((ask - bid) * 100));
  if (spreadCents == null) return reject('missing-spread');
  if (spreadCents - rules.edge.maxSpreadCents > 1e-9) return reject('spread');
  const liquidityUsd = finite(input.liquidityUsd);
  if (intlOnlyReason(input, rules)) return reject('intl-only');
  if (input.alreadyPicked === true) return reject('already-picked');
  const resolutionRisk = input.resolutionRisk || 'High';
  if (resolutionRisk === 'High') return reject('resolution-risk');
  const rawModel = finite(input.modelProb);
  if (rawModel == null || !(rawModel > 0 && rawModel < 1)) return reject('model');
  const liveKind = input.liveKind || input.live_kind || null;
  const capModel = !(sector === 'live' && liveKind === 'endgame');
  const modelProb = capModel ? Math.min(rawModel, rules.edge.modelProbCap) : Math.min(rawModel, 0.99);
  const confidence = confidenceRank(input.confidence, modelProb, rules);
  if (confidence === 'Low') return reject('confidence');

  const sizing = sizeForRecord(input.record || {}, rules);
  const depthUsd = finite(input.depthUsd);
  if (depthUsd == null || depthUsd <= 0) return reject('depth');

  const marketP = marketProbability({ side: input.side, ask, bid });
  if ((sector === 'btc-misprice' || sector === 'momentum') && rules.edge.btcMispriceRequiresFreshBbo) {
    const cdnAge = finite(input.bboAgeMs);
    const sampled = Date.parse(input.bboSampledAt || '');
    const nowMs = input.now ? new Date(input.now).getTime() : Date.now();
    const ageMs = cdnAge != null ? cdnAge : (Number.isFinite(sampled) ? nowMs - sampled : null);
    // 扫描只有这一份报价，参照价就是当前卖价。小幅或零波动在 5 分钟内不算过期。
    const fresh = bboIsFresh({
      ageMs,
      referenceAsk: ask,
      currentAsk: ask,
      referenceMid: marketP,
      currentMid: marketP,
      maxAgeMs: rules.edge.bboMaxAgeMs,
      absurdAgeMs: rules.edge.bboAbsurdAgeMs,
      quietMove: rules.edge.bboQuietMove,
      futureToleranceMs: rules.edge.bboFutureToleranceMs
    });
    if (!fresh.ok) return reject('stale-bbo');
  }

  let pUsed = modelProb;
  let pricedEdge = round4(modelProb - ask);
  let orderKind = 'normal';
  if (sector === 'btc-misprice') {
    const minPx = rules.edge.btcMispriceMinPrice;
    const maxPx = rules.edge.btcMispriceMaxPrice;
    if (ask + 1e-12 < minPx || ask - 1e-12 > maxPx) return reject('price-band');
    pUsed = blendModelToMarket(modelProb, marketP, rules.edge.btcMispriceModelWeight).pUsed;
    pricedEdge = round4(pUsed - ask);
    const fullMinEdge = minEdgeFor(sector, { weak: sizing.weak }, rules);
    orderKind = exploratoryOrderKind({ edge: pricedEdge, fullMinEdge, eligible: true });
    if (orderKind === 'skip') return reject('edge');
  } else if (sector === 'momentum') {
    if (ask - rules.edge.momentumPriceCap > 1e-9) return reject('momentum-price-cap');
    const distance = finite(input.distanceBps);
    const needed = sizing.weak ? rules.edge.momentumOriginalDistanceBps : rules.edge.momentumDistanceBps;
    orderKind = exploratoryDistanceKind({ distance, needed, eligible: true });
    if (orderKind === 'skip') return reject('momentum-distance');
    if (rules.edge.momentumRequiresSameWay && input.sameWay !== true) return reject('momentum-same-way');
    const mos = round4(modelProb - ask);
    const mosFloor = sizing.weak ? rules.edge.nonBtcNonLive : 0;
    if (rules.edge.momentumRequiresMos && !(mos > mosFloor)) return reject('momentum-mos');
  } else if (sector === 'live' && liveKind === 'endgame') {
    if (modelProb + 1e-12 < rules.edge.liveEndgameMinModel) return reject('live-endgame-model');
    if (ask - rules.edge.liveEndgameMaxPrice > 1e-9) return reject('live-endgame-price');
  } else if (sector === 'live') {
    if (ask + 1e-12 < rules.edge.liveInGameMinPrice || ask - rules.edge.liveInGameMaxPrice > 1e-9) {
      return reject('live-in-game-price');
    }
    const fullMinEdge = minEdgeFor(sector, { liveKind, weak: sizing.weak }, rules);
    orderKind = exploratoryOrderKind({
      edge: round4(modelProb - ask),
      fullMinEdge,
      eligible: true
    });
    if (orderKind === 'skip') return reject('edge');
  } else {
    if (ask + 1e-12 < rules.edge.standardMinPrice || ask - rules.edge.standardMaxPrice > 1e-9) {
      return reject('price-band');
    }
    if (round4(modelProb - ask) + 1e-12 < minEdgeFor(sector, { weak: sizing.weak }, rules)) {
      return reject('edge');
    }
  }

  const windowId = input.windowId || null;
  if (windowId && rules.oneSided.appliesTo.includes(sector)) {
    const conflict = (input.openWindows || []).some((row) => (
      row
      && row.windowId === windowId
      && row.status !== 'expired'
      && row.status !== 'skipped'
      && sidePolarity(row.side) !== polarity
    ));
    if (conflict) return reject('one-sided');
  }

  const used = (finite(input.dailyFilled) || 0) + (finite(input.dailyPending) || 0);
  if (used >= rules.dailyCaps[sector]) return reject('daily-cap');

  const sizeUsd = orderKind === 'exploratory' ? US_EXPLORATORY_SIZE_USD : sizing.usd;
  if (depthUsd + 1e-9 < sizeUsd) return reject('depth');

  const buyingPower = finite(input.buyingPower);
  if (buyingPower != null && buyingPower - sizeUsd + 1e-9 < rules.size.cashReserveUsd) return reject('cash-reserve');

  const slug = String(input.slug || '');
  if (!slug) return reject('slug');
  const side = displaySide(input.side, input.timeframe);
  const edge = sector === 'btc-misprice' ? pricedEdge : round4(modelProb - ask);
  const id = `${writtenSector}:${slug}:${polarity}`;
  const signal = {
    spec_version: US_SPEC_VERSION,
    id,
    sector: writtenSector,
    live_kind: sector === 'live' ? liveKind : null,
    live_phase: sector === 'live' ? liveKind : null,
    endgame: sector === 'live' && liveKind === 'endgame',
    slug,
    side,
    limit_price: round4(ask),
    size_usd: sizeUsd,
    order_kind: orderKind,
    edge,
    model_prob: round4(modelProb),
    model_p: roundProb(modelProb),
    market_p: roundProb(marketP),
    p_used: roundProb(sector === 'btc-misprice' ? pUsed : modelProb),
    ask: round4(ask),
    expires_at: input.expiresAt,
    basis: input.basis || '',
    confidence,
    resolution_risk: resolutionRisk,
    status: 'pending',
    event_url: eventUrl(slug),
    venue: 'polymarket.us',
    window_id: windowId,
    timeframe: input.timeframe || null,
    pt_date: input.ptDate || null,
    auto_order: {
      authorized: rules.standingAutoOrder.authorized,
      per_trade_confirm: rules.standingAutoOrder.perTradeConfirm,
      scanner_places_orders: false,
      executor: rules.standingAutoOrder.executor,
      note: rules.standingAutoOrder.note
    },
    gates: {
      same_way: input.sameWay === true,
      mos: round4(modelProb - ask),
      distance_bps: finite(input.distanceBps),
      spread_cents: spreadCents,
      liquidity_usd: liquidityUsd,
      depth_usd: depthUsd,
      size_tier: sizing.tier,
      order_kind: orderKind,
      cash_reserve_checked: buyingPower != null
    }
  };
  return { ok: true, reason: null, signal };
}
