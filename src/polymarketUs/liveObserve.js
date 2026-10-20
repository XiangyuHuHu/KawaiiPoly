/**
 * Live moneyline 观察日志。
 * 每个正在进行的美国站胜负盘，Yes 和 No 各写一行，不管过不过规则。
 * 同一分钟同一市场同一方向不重复写。数据源失败只记错误，不抛出。
 * 这里不下单。足球热门只在 rule_pass.would_signal_paper 标 true。
 * model_prob ≥ 0.60 时 rule_pass.observe_band 为 true；低于此值或没有模型仍写日志。
 * BBO 只拉有模型的市场，串行大约每秒一个；429 之后本轮不再拉观察行情。
 */

import { open, stat } from 'node:fs/promises';
import { US_GATEWAY_OBSERVE_GAP_MS } from './constants.js';
import { appendJsonl, readJsonl } from './ledger.js';
import { isObservePaused, isRateLimitError, noteGatewayRateLimit } from './gatewayLimit.js';
import { publishLiveEndgameV2 } from './liveEndgameV2.js';
import { endgameDivergenceGate, endgameV2Rule, resolveScoreAgeMs, soccerFavoritePaper } from './liveGate.js';
import { classifyLivePhase, sportFromEvent } from './livePhase.js';
import { loadLiveModelSources } from './liveSources.js';
import { teamsMatch } from './models/math.js';
import { US_RULES } from './rules.js';
import { readJsonl as readSignals, usPaths, writeStatus } from './signals.js';

const LIVE_PAGE_LIMIT = 100;
const LIVE_MAX_PAGES = 5;
const TAIL_BYTES = 256 * 1024;

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round4(value) {
  const number = finite(value);
  return number == null ? null : Math.round(number * 1e4) / 1e4;
}

function minuteKey(ts) {
  const text = typeof ts === 'string' ? ts : new Date(ts).toISOString();
  return text.slice(0, 16);
}

export function isSportsMoneyline(market) {
  if (!market || market.closed === true) return false;
  const type = String(market.marketType || '');
  const smt = String(market.sportsMarketType || '');
  if (/spread|total|prop|player|points|assists|rebounds|corners|btts|cards/i.test(smt)) return false;
  if (type === 'moneyline') return /winner|moneyline|^$/i.test(smt) || /winner|moneyline/i.test(smt) || smt === '';
  if (type === 'drawable_outcome') return /winner|moneyline/i.test(smt);
  return false;
}

export function isLiveSportsEvent(event) {
  if (!event || event.ended === true) return false;
  const live = event.live === true || event.eventState?.live === true;
  if (!live) return false;
  const series = String(event.seriesSlug || '');
  if (/updown|strike|range/i.test(series)) return false;
  if (event.category && event.category !== 'sports') return false;
  return (event.markets || []).some(isSportsMoneyline);
}

function eventTeams(event) {
  return (event?.teams || []).map((team) => team?.name || team?.alias).filter(Boolean);
}

export function observationQuoteSlugs(events = [], pinnacleLines = [], espnLines = []) {
  const slugs = [];
  for (const event of events) {
    if (!isLiveSportsEvent(event)) continue;
    const names = eventTeams(event);
    const line = findProbLine(pinnacleLines, names) || findProbLine(espnLines, names);
    if (!line) continue;
    for (const market of event.markets || []) {
      if (!isSportsMoneyline(market) || !market.slug) continue;
      const yes = outcomeProb(line, yesOutcome(market));
      if (sideProb(yes, 'Yes') == null && sideProb(yes, 'No') == null) continue;
      slugs.push(market.slug);
    }
  }
  return [...new Set(slugs)];
}

export function findProbLine(lines, teamNames) {
  const names = (teamNames || []).filter(Boolean);
  if (names.length < 2) return null;
  return (lines || []).find((line) => {
    const homeHit = names.some((name) => teamsMatch(name, line.home));
    const awayHit = names.some((name) => teamsMatch(name, line.away));
    return homeHit && awayHit;
  }) || null;
}

export function yesOutcome(market) {
  const long = (market?.marketSides || []).find((side) => side?.long === true) || null;
  const team = long?.team?.name || null;
  const slug = String(market?.slug || '');
  const blob = `${slug} ${market?.question || ''} ${long?.description || ''}`;
  if (/-draw$/i.test(slug) || (!team && /\bdraw\b/i.test(blob))) {
    return { kind: 'draw', name: 'draw' };
  }
  return { kind: 'team', name: team };
}

export function outcomeProb(line, outcome) {
  if (!line || !outcome) return null;
  if (outcome.kind === 'draw') return finite(line.drawProb);
  if (!outcome.name) return null;
  if (teamsMatch(outcome.name, line.home)) return finite(line.homeProb);
  if (teamsMatch(outcome.name, line.away)) return finite(line.awayProb);
  return null;
}

function sideProb(yesProb, side) {
  const base = finite(yesProb);
  if (base == null) return null;
  const value = side === 'No' ? 1 - base : base;
  if (!(value > 0 && value < 1)) return null;
  return round4(value);
}

export function quoteForObservation(bbo, side) {
  if (!bbo) return { ask: null, bid: null, ask_depth: null };
  if (side === 'Yes') {
    const ask = finite(bbo.longAsk ?? bbo.yesAsk ?? bbo.bestAsk);
    const bid = finite(bbo.bestBid);
    const shares = finite(bbo.askShares);
    return {
      ask: round4(ask),
      bid: round4(bid),
      ask_depth: ask != null && shares != null ? round4(ask * shares) : null
    };
  }
  const yesAsk = finite(bbo.longAsk ?? bbo.yesAsk ?? bbo.bestAsk);
  const yesBid = finite(bbo.bestBid);
  const ask = finite(bbo.shortAsk ?? bbo.noAsk ?? (yesBid == null ? null : 1 - yesBid));
  const bid = yesAsk == null ? null : round4(1 - yesAsk);
  const shares = finite(bbo.bidShares);
  return {
    ask: round4(ask),
    bid,
    ask_depth: ask != null && shares != null ? round4(ask * shares) : null
  };
}

function clockOf(event) {
  const state = event?.eventState || event?.metadata?.gameState || {};
  const elapsed = state.elapsed ?? event?.elapsed ?? null;
  if (elapsed == null || elapsed === '') return null;
  return String(elapsed);
}

function periodOf(event) {
  const state = event?.eventState || event?.metadata?.gameState || {};
  const period = state.period ?? event?.period ?? null;
  if (period == null || period === '') return null;
  return String(period);
}

function scoreOf(event) {
  const state = event?.eventState || event?.metadata?.gameState || {};
  const score = state.score ?? event?.score ?? null;
  if (score == null || score === '') return null;
  return String(score);
}

function sampledAt(event) {
  const state = event?.eventState || event?.metadata?.gameState || {};
  return state.updatedAt || event?.updatedAt || null;
}

export function rulePassForSide({
  sport,
  phase,
  modelProb,
  ask,
  espnProb,
  pinnacleProb,
  scoreAgeMs,
  now,
  rules = US_RULES
} = {}) {
  const paper = soccerFavoritePaper({ sport, phase, pinnacleProb, ask, rules });
  const minModel = rules.edge.liveEndgameMinModel;
  const maxPrice = rules.edge.liveEndgameMaxPrice;
  let endgame;
  if (phase !== 'endgame') {
    endgame = { pass: false, action: 'not_endgame', reason: 'not_endgame', divergence: null };
  } else if (modelProb == null) {
    endgame = { pass: false, action: 'skip', reason: 'no_model', divergence: null };
  } else if (!(ask > 0) || ask - maxPrice > 1e-9) {
    endgame = { pass: false, action: 'skip', reason: 'price', divergence: null };
  } else if (modelProb + 1e-12 < minModel) {
    endgame = { pass: false, action: 'skip', reason: 'model_floor', divergence: round4(modelProb - ask) };
  } else {
    const gate = endgameDivergenceGate({
      modelProb,
      ask,
      espnProb,
      pinnacleProb,
      scoreAgeMs,
      now,
      rules
    });
    endgame = {
      pass: gate.action !== 'skip',
      action: gate.action,
      reason: gate.reason,
      divergence: gate.divergence
    };
  }
  const endgameV2 = endgameV2Rule({
    phase,
    modelProb,
    ask,
    espnProb,
    pinnacleProb,
    scoreAgeMs,
    now,
    rules
  });
  const observeMin = rules.edge.liveObserveMinModel ?? 0.60;
  const observeBand = modelProb != null && modelProb + 1e-12 >= observeMin;
  const inGameEdge = rules.edge.liveInGame;
  let inGameReason = 'not_in_game';
  let inGamePass = false;
  if (phase === 'endgame' || phase === 'pregame') inGameReason = phase;
  else if (modelProb == null || ask == null) inGameReason = 'no_model';
  else if (ask + 1e-12 < rules.edge.liveInGameMinPrice || ask - rules.edge.liveInGameMaxPrice > 1e-9) {
    inGameReason = 'price';
  } else if (round4(modelProb - ask) + 1e-12 < inGameEdge) inGameReason = 'edge';
  else {
    inGamePass = true;
    inGameReason = 'edge';
  }
  return {
    would_signal: endgame.pass === true,
    would_signal_paper: paper.would_signal_paper === true,
    would_signal_v2: endgameV2.pass === true,
    observe_band: observeBand,
    endgame,
    endgame_v2: endgameV2,
    in_game: { pass: inGamePass, reason: inGameReason },
    soccer_favorite_paper: paper
  };
}

function polarity(side) {
  const text = String(side || '').trim().toLowerCase();
  if (['up', 'yes', 'higher', 'above'].includes(text)) return 'yes';
  if (['down', 'no', 'lower', 'below'].includes(text)) return 'no';
  return null;
}

function signalIdFor(pending, marketSlug, eventSlug, side) {
  const want = polarity(side);
  for (const row of pending || []) {
    if (polarity(row?.side) !== want) continue;
    const slug = String(row?.slug || '');
    if (!slug) continue;
    if (slug === marketSlug || slug === eventSlug) return row.id || null;
  }
  return null;
}

export function buildLiveObservationRows({
  events = [],
  quotesBySlug = {},
  pinnacleLines = [],
  espnLines = [],
  pending = [],
  now = new Date(),
  rules = US_RULES
} = {}) {
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const rows = [];
  for (const event of events) {
    if (!isLiveSportsEvent(event)) continue;
    const names = eventTeams(event);
    const pinnacle = findProbLine(pinnacleLines, names);
    const espn = findProbLine(espnLines, names);
    const period = periodOf(event);
    const clock = clockOf(event);
    const score = scoreOf(event);
    const scoreSampledAt = sampledAt(event);
    const scoreAge = resolveScoreAgeMs({ scoreSampledAt, now });
    for (const market of event.markets || []) {
      if (!isSportsMoneyline(market) || !market.slug) continue;
      const sport = sportFromEvent(event, market);
      const phase = classifyLivePhase({
        sport,
        period,
        clock,
        live: event.live === true || event.eventState?.live === true
      });
      const outcome = yesOutcome(market);
      const pinYes = outcomeProb(pinnacle, outcome);
      const espnYes = outcomeProb(espn, outcome);
      const quote = quotesBySlug[market.slug] || null;
      for (const side of ['Yes', 'No']) {
        const pinnacleProb = sideProb(pinYes, side);
        const espnProb = sideProb(espnYes, side);
        let modelProb = null;
        let modelSrc = 'none';
        if (pinnacleProb != null) {
          modelProb = pinnacleProb;
          modelSrc = 'pinnacle_devig';
        } else if (espnProb != null) {
          modelProb = espnProb;
          modelSrc = 'espn_wp';
        }
        const prices = quoteForObservation(quote, side);
        const rule = rulePassForSide({
          sport,
          phase,
          modelProb,
          ask: prices.ask,
          espnProb,
          pinnacleProb,
          scoreAgeMs: scoreAge,
          now,
          rules
        });
        rows.push({
          ts_utc: ts,
          market_slug: market.slug,
          event_slug: event.slug || null,
          sport,
          league: event.seriesSlug || null,
          side,
          model_prob: modelProb,
          model_src: modelSrc,
          ask: prices.ask,
          bid: prices.bid,
          ask_depth: prices.ask_depth,
          period,
          clock,
          score,
          phase,
          rule_pass: rule,
          signal_id: signalIdFor(pending, market.slug, event.slug, side),
          pinnacle_prob: pinnacleProb,
          espn_prob: espnProb,
          score_sampled_at: scoreSampledAt,
          score_age_ms: scoreAge,
          spec_version: '3.5'
        });
      }
    }
  }
  return rows;
}

async function readTail(file, bytes = TAIL_BYTES) {
  try {
    const info = await stat(file);
    const handle = await open(file, 'r');
    try {
      const start = Math.max(0, info.size - bytes);
      const length = info.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const text = buffer.toString('utf8');
      const cut = start > 0 ? text.indexOf('\n') : -1;
      return cut >= 0 ? text.slice(cut + 1) : text;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function existingMinuteKeys(file, minute) {
  const text = await readTail(file);
  const keys = new Set();
  for (const line of text.split('\n')) {
    if (!line.includes(minute)) continue;
    try {
      const row = JSON.parse(line);
      if (minuteKey(row.ts_utc) !== minute) continue;
      if (row.market_slug && row.side) keys.add(`${row.market_slug}|${row.side}|${minute}`);
    } catch {
      // 半行或坏行跳过，不挡住这次追加。
    }
  }
  return keys;
}

export async function appendLiveObservations(file, rows) {
  const grouped = new Map();
  for (const row of rows) {
    const minute = minuteKey(row.ts_utc);
    if (!grouped.has(minute)) grouped.set(minute, []);
    grouped.get(minute).push(row);
  }
  let appended = 0;
  let skippedDup = 0;
  for (const [minute, batch] of grouped) {
    const seen = await existingMinuteKeys(file, minute);
    for (const row of batch) {
      const key = `${row.market_slug}|${row.side}|${minute}`;
      if (seen.has(key)) {
        skippedDup += 1;
        continue;
      }
      seen.add(key);
      await appendJsonl(file, row);
      appended += 1;
    }
  }
  return { appended, skippedDup };
}

async function listAllLive(listEvents) {
  const events = [];
  for (let page = 0; page < LIVE_MAX_PAGES; page += 1) {
    const batch = await listEvents({
      live: 'true',
      closed: 'false',
      limit: LIVE_PAGE_LIMIT,
      offset: page * LIVE_PAGE_LIMIT
    });
    const rows = Array.isArray(batch) ? batch : [];
    events.push(...rows);
    if (rows.length < LIVE_PAGE_LIMIT) break;
  }
  return events;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function delay(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reusedQuoteMap(quoteCache, gateway) {
  const quotes = {};
  const entries = quoteCache instanceof Map ? quoteCache.entries() : Object.entries(quoteCache || {});
  for (const [slug, quote] of entries) {
    if (slug && quote) quotes[slug] = quote;
  }
  if (gateway?.bboBySlug instanceof Map) {
    for (const [slug, quote] of gateway.bboBySlug) {
      if (slug && quote) quotes[slug] = quote;
    }
  }
  return quotes;
}

/**
 * 观察行情串行，大约每秒一个。已经有扫描缓存的 slug 不再请求。
 * 第一次 429 之后，本轮剩下的观察行情直接停。
 */
export async function quoteMap(slugs, getBbo, { reused = {}, gapMs = US_GATEWAY_OBSERVE_GAP_MS } = {}) {
  const quotes = { ...reused };
  const errors = [];
  let stopped = isObservePaused();
  let previous = 0;
  for (const slug of slugs) {
    if (quotes[slug]) continue;
    if (stopped || isObservePaused()) {
      stopped = true;
      quotes[slug] = null;
      errors.push(`bbo:${slug}:rate-limit-paused`);
      continue;
    }
    const wait = gapMs - (Date.now() - previous);
    if (previous && wait > 0) await delay(wait);
    previous = Date.now();
    try {
      quotes[slug] = await withTimeout(Promise.resolve().then(() => getBbo(slug)), 8000);
    } catch (error) {
      quotes[slug] = null;
      if (isRateLimitError(error)) {
        noteGatewayRateLimit();
        stopped = true;
        errors.push(`bbo:${slug}:429`);
      } else {
        errors.push(`bbo:${slug}:${String(error?.message || error).slice(0, 120)}`);
      }
    }
  }
  return { quotes, errors, rateLimited: stopped };
}

export async function runLiveObservations({
  now = new Date(),
  ledgerRoot,
  gateway = null,
  fetchImpl,
  listEvents = null,
  getBbo = null,
  loadSources = null,
  quoteCache = null,
  quoteGapMs = US_GATEWAY_OBSERVE_GAP_MS,
  workspaceRoot,
  publishSignals = true,
  rules = US_RULES
} = {}) {
  try {
    const paths = usPaths(ledgerRoot);
    const list = listEvents || (gateway ? (query) => gateway.listEvents(query) : null);
    const bbo = getBbo || (gateway ? (slug, options) => gateway.getBbo(slug, options) : null);
    if (!list || !bbo) {
      return { appended: 0, skippedDup: 0, markets: 0, errors: ['missing-gateway'], path: paths.liveObservations };
    }
    const errors = [];
    let events = [];
    try {
      events = await listAllLive(list);
    } catch (error) {
      errors.push(`events:${String(error?.message || error).slice(0, 160)}`);
    }
    const live = events.filter(isLiveSportsEvent);
    const slugs = [];
    for (const event of live) {
      for (const market of event.markets || []) {
        if (isSportsMoneyline(market) && market.slug) slugs.push(market.slug);
      }
    }
    const uniqueSlugs = [...new Set(slugs)];
    let sources = { pinnacle: [], espn: [], errors: [] };
    try {
      sources = loadSources
        ? await loadSources({ fetchImpl, now })
        : await loadLiveModelSources({ fetchImpl });
    } catch (error) {
      errors.push(`sources:${String(error?.message || error).slice(0, 160)}`);
    }
    errors.push(...(sources.errors || []));
    const modeled = observationQuoteSlugs(live, sources.pinnacle || [], sources.espn || []);
    const reused = reusedQuoteMap(quoteCache, gateway);
    // gateway.getBbo 走共享队列，间隔在 limiter 里。注入的 getBbo 由 quoteMap 自己按 quoteGapMs 串行。
    const pacedByLimiter = Boolean(gateway) && getBbo == null;
    const quoted = await quoteMap(modeled, (slug) => bbo(slug, { lane: 'observe' }), {
      reused,
      gapMs: pacedByLimiter ? 0 : quoteGapMs
    });
    errors.push(...quoted.errors);
    let pending = [];
    try {
      pending = await readSignals(paths.pending);
    } catch {
      pending = [];
    }
    const rows = buildLiveObservationRows({
      events: live,
      quotesBySlug: quoted.quotes,
      pinnacleLines: sources.pinnacle || [],
      espnLines: sources.espn || [],
      pending,
      now,
      rules
    });
    let signals = { published: 0, ids: [], signals: [], skipped: [] };
    if (publishSignals) {
      try {
        signals = await publishLiveEndgameV2({
          rows,
          quotesBySlug: quoted.quotes,
          ledgerRoot,
          workspaceRoot,
          now,
          rules
        });
        for (const item of signals.signals || []) {
          const match = rows.find((row) => row.market_slug === item.slug && row.side === item.side && !row.signal_id);
          if (match) match.signal_id = item.id;
        }
      } catch (error) {
        errors.push(`signals:${String(error?.message || error).slice(0, 160)}`);
      }
    }
    const written = await appendLiveObservations(paths.liveObservations, rows);
    const summary = {
      appended: written.appended,
      skippedDup: written.skippedDup,
      markets: uniqueSlugs.length,
      quoted: modeled.filter((slug) => !reused[slug]).length,
      events: live.length,
      signals,
      errors,
      path: paths.liveObservations
    };
    try {
      await writeStatus(ledgerRoot, 'last-live-observe.json', summary);
    } catch {
      // 状态文件失败不影响日志本身。
    }
    return summary;
  } catch (error) {
    return {
      appended: 0,
      skippedDup: 0,
      markets: 0,
      errors: [String(error?.message || error).slice(0, 160)],
      error: String(error?.message || error).slice(0, 160)
    };
  }
}

export function outcomeFromUsMarket(market) {
  if (!market || market.closed !== true) return null;
  const long = (market.marketSides || []).find((side) => side?.long === true);
  const raw = long?.price ?? market.long_px ?? null;
  const price = finite(raw);
  if (price == null) return { closed: true, yes_won: null, void: true, long_px: raw == null ? null : String(raw) };
  if (price >= 0.995) return { closed: true, yes_won: true, void: false, long_px: String(raw) };
  if (price <= 0.005) return { closed: true, yes_won: false, void: false, long_px: String(raw) };
  return { closed: true, yes_won: null, void: true, long_px: String(raw) };
}

export async function settleLiveObservations({
  ledgerRoot,
  lookup,
  now = new Date()
} = {}) {
  const paths = usPaths(ledgerRoot);
  const observations = await readJsonl(paths.liveObservations);
  const existing = await readJsonl(paths.liveObservationsSettled);
  const done = new Set(existing.map((row) => row.market_slug).filter(Boolean));
  const slugs = [...new Set(observations.map((row) => row.market_slug).filter(Boolean))];
  const fresh = [];
  const errors = [];
  let cursor = 0;
  const pending = slugs.filter((slug) => !done.has(slug));
  const worker = async () => {
    while (cursor < pending.length) {
      const slug = pending[cursor];
      cursor += 1;
      try {
        const market = lookup ? await lookup(slug) : null;
        const outcome = outcomeFromUsMarket(market);
        if (!outcome) continue;
        fresh.push({
          market_slug: slug,
          settled_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
          source: 'us-gateway',
          ...outcome
        });
      } catch (error) {
        errors.push(`${slug}:${String(error?.message || error).slice(0, 120)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
  for (const row of fresh) await appendJsonl(paths.liveObservationsSettled, row);
  return {
    settled: fresh.length,
    pending: pending.length - fresh.length,
    errors,
    path: paths.liveObservationsSettled
  };
}
