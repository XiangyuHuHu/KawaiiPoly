import { readFile } from 'node:fs/promises';
import { btcResolutionRisk, evaluateUsSignal, sidePolarity } from './evaluate.js';
import { eventSlug } from './gateway.js';
import { US_RULES } from './rules.js';
import {
  publishUsSignal,
  readJsonl,
  usPaths,
  writeStatus
} from './signals.js';
import {
  alignUtcWindow,
  describeSession,
  formatUsUpdownSlug,
  ptDateKey
} from './time.js';
import { buildPolymarketIntervalSignal } from '../polymarketSignal.js';
import { PublicMarketDataClient } from '../../packages/kawaii-signal/publicMarketData.js';

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

async function readAccountCash(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return finite(parsed?.cash_usd ?? parsed?.cashUsd);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function lossStreak(rows) {
  let streak = 0;
  const ordered = [...rows].reverse();
  for (const row of ordered) {
    if (row?.won === true) break;
    if (row?.won === false) streak += 1;
    else break;
  }
  return streak;
}

export async function loadSectorStats(ledgerRoot, sector, now = new Date()) {
  const paths = usPaths(ledgerRoot);
  const [orders, trials, pending, picks, cashUsd] = await Promise.all([
    readJsonl(paths.realOrders),
    readJsonl(paths.momentumTrials),
    readJsonl(paths.pending),
    readJsonl(paths.picks),
    readAccountCash(paths.account)
  ]);
  const ptDate = ptDateKey(now);
  const filled = [...orders, ...trials].filter((row) => isUsFill(row) && row.sector === sector);
  const settled = filled.filter((row) => row.won === true || row.won === false);
  const wins = settled.filter((row) => row.won === true).length;
  const losses = settled.filter((row) => row.won === false).length;
  const dailyFilled = filled.filter((row) => row.status === 'filled' && row.pt_date === ptDate).length;
  const dailyPending = pending.filter((row) => (
    row.sector === sector
    && row.status === 'pending'
    && row.pt_date === ptDate
    && Date.parse(row.expires_at || '') > now.getTime()
  )).length;
  const openWindows = [...pending, ...orders, ...trials]
    .filter((row) => isUsFill(row) && isOpenWindow(row, now))
    .map((row) => ({ windowId: row.window_id, side: row.side, status: row.status || 'filled' }));
  return {
    record: { wins, losses, lossStreak: lossStreak(settled) },
    dailyFilled,
    dailyPending,
    cashUsd,
    openWindows,
    ptDate,
    dailyOrders: countDayOrders([...orders, ...trials, ...pending], ptDate, now),
    picks
  };
}

function rowSlug(row) {
  if (row?.slug) return String(row.slug);
  const url = String(row?.url || row?.event_url || '');
  const match = url.match(/\/event\/([^/?#]+)/);
  return match ? match[1] : '';
}

export function isAlreadyPicked(picks, slug, side) {
  const want = `${eventSlug(slug)}:${sidePolarity(side)}`;
  return (picks || []).some((row) => `${eventSlug(rowSlug(row))}:${sidePolarity(row?.side)}` === want);
}

function countsTowardDailyCap(row, ptDate, now) {
  if (!isUsFill(row) || row.pt_date !== ptDate) return false;
  if (row.status === 'expired' || row.status === 'skipped') return false;
  if (row.status === 'pending') {
    const expires = Date.parse(row.expires_at || '');
    return !Number.isFinite(expires) || expires > now.getTime();
  }
  return row.status === 'filled' || row.won === true || row.won === false;
}

function countDayOrders(rows, ptDate, now) {
  const ids = new Set();
  for (const row of rows) {
    if (!countsTowardDailyCap(row, ptDate, now)) continue;
    ids.add(row.id || `${rowSlug(row)}:${sidePolarity(row.side)}`);
  }
  return ids.size;
}

export function displayedLiquidityUsd(book, bbo) {
  const notional = (levels) => {
    if (!Array.isArray(levels) || !levels.length) return null;
    let total = 0;
    for (const level of levels) {
      const price = finite(level?.price);
      const size = finite(level?.size);
      if (price == null || size == null) continue;
      total += price * size;
    }
    return total;
  };
  const bidBook = notional(book?.bids);
  const askBook = notional(book?.asks);
  if (bidBook != null || askBook != null) return (bidBook || 0) + (askBook || 0);
  let total = 0;
  let any = false;
  const bidPx = finite(bbo?.bestBid);
  const askPx = finite(bbo?.bestAsk) ?? finite(bbo?.longAsk);
  const bidShares = finite(bbo?.bidShares);
  const askShares = finite(bbo?.askShares);
  if (bidPx != null && bidShares != null) {
    total += bidPx * bidShares;
    any = true;
  }
  if (askPx != null && askShares != null) {
    total += askPx * askShares;
    any = true;
  }
  return any ? total : null;
}

function isOpenWindow(row, now) {
  if (!row?.window_id) return false;
  if (row.status === 'expired' || row.status === 'skipped') return false;
  if (row.won === true || row.won === false || row.void === true) return false;
  const expires = Date.parse(row.expires_at || '');
  if (Number.isFinite(expires) && expires <= now.getTime()) return false;
  return row.status === 'pending' || row.status === 'filled';
}

function isUsFill(row) {
  if (!row || row.paper === true || row.venue === 'paper' || row.venue === 'intl') return false;
  if (row.source === 'gamma' || row.source === 'intl') return false;
  const url = String(row.event_url || row.url || '');
  if (url && !url.includes('polymarket.us')) return false;
  return row.venue === 'polymarket.us' || url.includes('polymarket.us') || row.line === 'us';
}

export function quoteForSide(bbo, book, side) {
  const polarity = sidePolarity(side);
  const longAsk = finite(bbo?.longAsk) ?? finite(bbo?.bestAsk);
  const longBid = finite(bbo?.bestBid);
  const shortAsk = finite(bbo?.shortAsk);
  const ask = polarity === 'down' ? shortAsk : longAsk;
  const bid = polarity === 'down'
    ? (longAsk != null ? round4(1 - longAsk) : null)
    : longBid;
  const top = book?.asks?.[0];
  const depthUsd = top && polarity !== 'down'
    ? top.price * top.size
    : (polarity === 'down'
      ? (shortAsk != null && finite(bbo?.bidShares) != null ? shortAsk * bbo.bidShares : null)
      : (ask != null && finite(bbo?.askShares) != null ? ask * bbo.askShares : null));
  const spreadCents = longAsk != null && longBid != null ? round4((longAsk - longBid) * 100) : null;
  return {
    ask,
    bid,
    depthUsd: finite(depthUsd),
    spreadCents,
    liquidityUsd: displayedLiquidityUsd(book, bbo)
  };
}

export function btcCandidatesFromContext({
  market,
  bbo,
  book,
  signal,
  window,
  timeframe,
  now,
  mispriceStats,
  momentumStats
}) {
  const slug = market?.slug;
  const bodyPct = finite(signal?.indicators?.bodyPct);
  const distanceBps = bodyPct == null ? null : Math.abs(bodyPct) * 10_000;
  const upProb = finite(signal?.probabilities?.up);
  const windowId = market?.assetPriceTerms?.windowStart || window.start.toISOString();
  const expiresAt = market?.assetPriceTerms?.windowEnd || window.end.toISOString();
  const resolutionRisk = btcResolutionRisk(market);
  const openWindows = [...(mispriceStats?.openWindows || []), ...(momentumStats?.openWindows || [])];
  if (openWindows.some((row) => row.windowId === windowId)) {
    return { signals: [], skipped: ['window-open'] };
  }
  const picks = mispriceStats?.picks || momentumStats?.picks || [];
  const dailyOrders = mispriceStats?.dailyOrders ?? momentumStats?.dailyOrders ?? null;
  const shared = {
    now,
    slug,
    title: market?.title || market?.question || '',
    question: market?.question || '',
    category: market?.category || 'crypto',
    windowId,
    expiresAt,
    timeframe,
    resolutionRisk,
    bboSampledAt: bbo?.sampledAt || null,
    distanceBps,
    dailyOrders,
    confidence: signal?.confidence >= 0.62 ? 'High' : signal?.confidence >= 0.56 ? 'Med' : 'Low'
  };
  const sectorStats = {
    'btc-misprice': mispriceStats,
    momentum: momentumStats || mispriceStats
  };
  const sides = [
    { side: 'Up', modelProb: upProb, sameWay: bodyPct != null && bodyPct > 0 },
    { side: 'Down', modelProb: upProb == null ? null : 1 - upProb, sameWay: bodyPct != null && bodyPct < 0 }
  ];
  const evaluated = [];
  for (const side of sides) {
    const quote = quoteForSide(bbo, book, side.side);
    const basis = `${timeframe} BRTI ${side.side}：模型 ${side.modelProb == null ? '缺失' : (side.modelProb * 100).toFixed(1)}%，美国站卖价 ${quote.ask == null ? '缺失' : (quote.ask * 100).toFixed(1)}¢，现货偏离 ${distanceBps == null ? '缺失' : distanceBps.toFixed(1)} bps。`;
    const withSector = (sector) => {
      const stats = sectorStats[sector];
      return {
        ...shared,
        sector,
        side: side.side,
        modelProb: side.modelProb,
        sameWay: side.sameWay,
        ...quote,
        ptDate: stats.ptDate,
        record: stats.record,
        dailyFilled: stats.dailyFilled,
        dailyPending: stats.dailyPending,
        cashUsd: stats.cashUsd,
        openWindows,
        dailyOrders,
        alreadyPicked: isAlreadyPicked(picks, slug, side.side)
      };
    };
    evaluated.push({
      side: side.side,
      misprice: evaluateUsSignal({ ...withSector('btc-misprice'), basis }),
      momentum: timeframe === '15m'
        ? evaluateUsSignal({ ...withSector('momentum'), basis: `15m 动量 ${basis}` })
        : { ok: false, reason: 'momentum-15m-only', signal: null }
    });
  }
  const misprice = evaluated.map((row) => row.misprice).filter((row) => row.ok);
  const momentum = evaluated.map((row) => row.momentum).filter((row) => row.ok);
  const chosenMisprice = misprice.sort((left, right) => right.signal.edge - left.signal.edge)[0] || null;
  let chosenMomentum = momentum.sort((left, right) => right.signal.edge - left.signal.edge)[0] || null;
  if (chosenMisprice && chosenMomentum) chosenMomentum = null;
  return {
    signals: [chosenMisprice?.signal, chosenMomentum?.signal].filter(Boolean),
    skipped: evaluated.flatMap((row) => [row.misprice, row.momentum]).filter((row) => !row.ok).map((row) => row.reason)
  };
}

export function normalizeModelRow(row = {}) {
  return {
    sector: row.sector,
    slug: row.slug,
    side: row.side,
    modelProb: row.model_prob ?? row.modelProb,
    ask: row.ask,
    bid: row.bid,
    spreadCents: row.spread_cents ?? row.spreadCents,
    depthUsd: row.depth_usd ?? row.depthUsd,
    liquidityUsd: row.liquidity_usd ?? row.liquidityUsd,
    title: row.title,
    question: row.question,
    category: row.category,
    city: row.city,
    resolutionRisk: row.resolution_risk ?? row.resolutionRisk,
    confidence: row.confidence,
    basis: row.basis,
    expiresAt: row.expires_at ?? row.expiresAt,
    windowId: row.window_id ?? row.windowId ?? row.slug,
    bboSampledAt: row.bbo_sampled_at ?? row.bboSampledAt,
    liveKind: row.live_kind ?? row.liveKind,
    timeframe: row.timeframe || null
  };
}

export async function refreshUsQuote(gateway, model) {
  const market = await gateway.getMarket(model.slug);
  const bbo = await gateway.getBbo(model.slug);
  let book = null;
  try {
    book = await gateway.getBook(model.slug);
  } catch {
    book = null;
  }
  const quote = quoteForSide(bbo, book, model.side);
  return {
    ...quote,
    bboSampledAt: bbo.sampledAt,
    expiresAt: model.expiresAt || market?.endDate || null,
    windowId: model.windowId || market?.assetPriceTerms?.windowStart || model.slug,
    resolutionRisk: model.resolutionRisk || btcResolutionRisk(market)
  };
}

export async function runUsScan({
  now = new Date(),
  ledgerRoot,
  workspaceRoot,
  ignoreWindow = false,
  loadWindow,
  loadModels,
  refreshQuote,
  rules = US_RULES
} = {}) {
  const session = describeSession(now, rules);
  const allowShort = ignoreWindow || session.btcShort;
  const allowLong = ignoreWindow || session.longDated;
  const allowSuite = ignoreWindow || session.fullSuite;
  if (!allowShort && !allowLong && !allowSuite) {
    await writeStatus(ledgerRoot, 'last-scan.json', { signal: false, reason: 'outside-window', session });
    return { published: 0, signals: [], reason: 'outside-window', session };
  }
  const published = [];
  const skipped = [];
  if (allowShort) {
    for (const timeframe of ['15m', '1h']) {
      const window = alignUtcWindow(now, timeframe);
      let context = null;
      try {
        context = await loadWindow({ now, timeframe, window });
      } catch (error) {
        if (error?.code === 'NOT_FOUND' || error?.status === 404) {
          skipped.push(`${timeframe}:missing`);
          continue;
        }
        await writeStatus(ledgerRoot, 'last-scan.json', { signal: false, reason: 'gateway-error', message: error.message });
        throw error;
      }
      if (!context?.market) {
        skipped.push(`${timeframe}:missing`);
        continue;
      }
      const mispriceStats = await loadSectorStats(ledgerRoot, 'btc-misprice', now);
      const momentumStats = await loadSectorStats(ledgerRoot, 'momentum', now);
      const decision = btcCandidatesFromContext({
        ...context,
        window,
        timeframe,
        now,
        mispriceStats,
        momentumStats
      });
      for (const signal of decision.signals) {
        signal.pt_date = signal.pt_date || ptDateKey(now);
        const result = await publishUsSignal({ ledgerRoot, workspaceRoot, signal, now });
        if (result.wrote) published.push(signal);
      }
      skipped.push(...decision.skipped.map((reason) => `${timeframe}:${reason}`));
    }
  }
  if (allowLong || allowSuite) {
    const rawModels = loadModels ? await loadModels({ now, session }) : await readJsonl(usPaths(ledgerRoot).modelInput);
    const freshForum = await freshForumSlugs(ledgerRoot, now);
    for (const raw of rawModels) {
      let model = normalizeModelRow(raw);
      if (!allowSuite && model.sector !== 'crypto' && model.sector !== 'master') continue;
      if (!session.fullSuite && !session.longDated && !ignoreWindow) continue;
      if (refreshQuote) {
        try {
          model = { ...model, ...(await refreshQuote(model)) };
        } catch (error) {
          if (error?.code === 'NOT_FOUND' || error?.status === 404) {
            skipped.push(`${model.sector}:missing-us-price`);
            continue;
          }
          throw error;
        }
      }
      if (model.ask == null) {
        skipped.push(`${model.sector}:missing-us-price`);
        continue;
      }
      const stats = await loadSectorStats(ledgerRoot, model.sector, now);
      const decision = evaluateUsSignal({
        ...model,
        now,
        ptDate: stats.ptDate,
        record: stats.record,
        dailyFilled: stats.dailyFilled,
        dailyPending: stats.dailyPending,
        dailyOrders: stats.dailyOrders,
        cashUsd: stats.cashUsd,
        openWindows: stats.openWindows,
        alreadyPicked: isAlreadyPicked(stats.picks, model.slug, model.side),
        basis: forumBasis(model, freshForum)
      });
      if (!decision.ok) {
        skipped.push(`${model.sector}:${decision.reason}`);
        continue;
      }
      decision.signal.pt_date = stats.ptDate;
      const result = await publishUsSignal({ ledgerRoot, workspaceRoot, signal: decision.signal, now });
      if (result.wrote) published.push(decision.signal);
    }
  }
  await writeStatus(ledgerRoot, 'last-scan.json', {
    signal: published.length > 0,
    published: published.map((signal) => signal.id),
    skipped,
    session
  });
  return {
    published: published.length,
    signals: published,
    reason: published.length ? 'signal' : (skipped[0] || 'no-signal'),
    session
  };
}

async function freshForumSlugs(ledgerRoot, now) {
  const rows = await readJsonl(`${ledgerRoot}/forum-signals.jsonl`);
  const cutoff = now.getTime() - 48 * 3_600_000;
  return new Set(rows.filter((row) => {
    const at = Date.parse(row.at || row.atIso || '');
    return (row.grade === 'A' || row.grade === 'B') && Number.isFinite(at) && at >= cutoff;
  }).map((row) => row.slug).filter(Boolean));
}

function forumBasis(model, slugs) {
  const basis = model.basis || '';
  if (!slugs.has(model.slug)) return basis;
  return `${basis}${basis ? ' ' : ''}论坛 A/B 信号只触发核对，概率来自客观模型。`;
}

export async function defaultLoadWindow({ gateway, marketData, now, timeframe, window }) {
  const slug = formatUsUpdownSlug(timeframe, window.start);
  const market = await gateway.getMarket(slug);
  const bbo = await gateway.getBbo(slug);
  let book = null;
  try {
    book = await gateway.getBook(slug);
  } catch {
    book = null;
  }
  const candles = await marketData.getCandles('BTC-USD', timeframe === '1h' ? '1h' : '15m', 80);
  const quote = await marketData.getQuotes(['BTC-USD']);
  const price = Number(quote?.results?.[0]?.price);
  const signal = buildPolymarketIntervalSignal({
    symbol: 'BTC-USD',
    candles,
    currentPrice: price,
    currentQuoteTime: quote?.results?.[0]?.timestamp || now.toISOString(),
    timeframe: timeframe === '1h' ? '1h' : '15m',
    now
  });
  return { market, bbo, book, signal, window };
}
