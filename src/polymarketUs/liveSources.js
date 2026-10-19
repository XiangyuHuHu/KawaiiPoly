/**
 * Live 模型来源。失败只记错误，不抛到扫描主路径。
 * Pinnacle：guest API 的滚球 moneyline，美式赔率去水。
 * ESPN：进行中比赛的 summary 胜率（winprobability，否则 predictor）。
 */

import { americanToImplied, devig, round4 } from './models/math.js';
import { fetchJson, safeError } from './models/http.js';

const PINNACLE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const PINNACLE_HEADERS = { Referer: 'https://www.pinnacle.com/' };

/** 有滚球盘口的运动。联赛列表不写死，只拉当前 live 的联赛。 */
export const PINNACLE_LIVE_SPORTS = Object.freeze([
  Object.freeze({ id: 29, sport: 'soccer' }),
  Object.freeze({ id: 4, sport: 'basketball' }),
  Object.freeze({ id: 15, sport: 'football' }),
  Object.freeze({ id: 19, sport: 'hockey' }),
  Object.freeze({ id: 3, sport: 'baseball' }),
  Object.freeze({ id: 33, sport: 'tennis' }),
  Object.freeze({ id: 12, sport: 'esports' }),
  Object.freeze({ id: 8, sport: 'cricket' })
]);

export const ESPN_SCOREBOARDS = Object.freeze([
  Object.freeze({ sport: 'nfl', path: 'football/nfl' }),
  Object.freeze({ sport: 'cfb', path: 'football/college-football' }),
  Object.freeze({ sport: 'nba', path: 'basketball/nba' }),
  Object.freeze({ sport: 'cbb', path: 'basketball/mens-college-basketball' }),
  Object.freeze({ sport: 'nhl', path: 'hockey/nhl' }),
  Object.freeze({ sport: 'mlb', path: 'baseball/mlb' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/eng.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/eng.2' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/esp.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/ita.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/ger.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/fra.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/usa.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/uefa.champions' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/uefa.europa' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/ned.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/por.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/mex.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/tur.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/sco.1' }),
  Object.freeze({ sport: 'soccer', path: 'soccer/bel.1' })
]);

function priceOf(market, designation) {
  const row = (market?.prices || []).find((price) => price?.designation === designation);
  return row ? americanToImplied(row.price) : null;
}

function participants(matchup) {
  const home = (matchup?.participants || []).find((team) => team?.alignment === 'home');
  const away = (matchup?.participants || []).find((team) => team?.alignment === 'away');
  return { home: home?.name || null, away: away?.name || null };
}

/**
 * 把滚球 matchup（含父场 id）和 straight markets 收成去水胜率。
 * 只留全场 moneyline、非替补盘、status 为 open。
 */
export function pinnacleLiveLines(games = [], markets = []) {
  const byId = new Map();
  for (const game of games) {
    if (!game?.id) continue;
    byId.set(game.id, game);
    if (game.childId) byId.set(game.childId, game);
  }
  const lines = [];
  const seen = new Set();
  for (const market of markets) {
    if (market?.type !== 'moneyline' || market.period !== 0 || market.isAlternate) continue;
    if (market.status && market.status !== 'open') continue;
    const game = byId.get(market.matchupId);
    if (!game || seen.has(game.id)) continue;
    const homeRaw = priceOf(market, 'home');
    const awayRaw = priceOf(market, 'away');
    const drawRaw = priceOf(market, 'draw');
    if (homeRaw == null || awayRaw == null || !game.home || !game.away) continue;
    const fair = devig(drawRaw == null ? [homeRaw, awayRaw] : [homeRaw, awayRaw, drawRaw]);
    if (!fair) continue;
    seen.add(game.id);
    lines.push({
      home: game.home,
      away: game.away,
      homeProb: round4(fair[0]),
      awayProb: round4(fair[1]),
      drawProb: drawRaw == null ? 0 : round4(fair[2]),
      sport: game.sport || null,
      league: game.leagueName || null
    });
  }
  return lines;
}

function rememberGame(map, matchup, sport) {
  if (!matchup?.id || matchup.type === 'special') return;
  const names = participants(matchup);
  if (!names.home || !names.away) return;
  const id = matchup.parentId || matchup.id;
  const existing = map.get(id);
  if (existing) {
    if (matchup.id !== id) existing.childId = matchup.id;
    return;
  }
  map.set(id, {
    id,
    childId: matchup.parentId ? matchup.id : null,
    home: names.home,
    away: names.away,
    leagueId: matchup.league?.id || null,
    leagueName: matchup.league?.name || null,
    sport
  });
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  if (workers.length) await Promise.all(workers);
  return out;
}

export async function fetchPinnacleLive({
  fetchImpl,
  timeoutMs = 8000,
  sports = PINNACLE_LIVE_SPORTS
} = {}) {
  const errors = [];
  const games = new Map();
  for (const sport of sports) {
    try {
      const live = await fetchJson(`${PINNACLE}/sports/${sport.id}/matchups/live?brandId=0`, {
        fetchImpl,
        headers: PINNACLE_HEADERS,
        timeoutMs
      });
      for (const matchup of Array.isArray(live) ? live : []) rememberGame(games, matchup, sport.sport);
    } catch (error) {
      errors.push(`pinnacle:${sport.sport}:${safeError(error)}`);
    }
  }
  const leagueIds = [...new Set([...games.values()].map((game) => game.leagueId).filter(Boolean))];
  const markets = [];
  await mapPool(leagueIds, 3, async (leagueId) => {
    try {
      const rows = await fetchJson(`${PINNACLE}/leagues/${leagueId}/markets/straight`, {
        fetchImpl,
        headers: PINNACLE_HEADERS,
        timeoutMs: Math.max(timeoutMs, 12000)
      });
      if (Array.isArray(rows)) markets.push(...rows);
    } catch (error) {
      errors.push(`pinnacle:league:${leagueId}:${safeError(error)}`);
    }
  });
  return { lines: pinnacleLiveLines([...games.values()], markets), errors };
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unitProb(value) {
  const number = num(value);
  if (number == null) return null;
  if (number > 1 && number <= 100) return number / 100;
  if (number > 0 && number < 1) return number;
  return null;
}

/** ESPN summary → 主队/客队/平局胜率。没有胜率就返回 null。 */
export function espnProbFromSummary(summary) {
  const list = summary?.winprobability;
  const last = Array.isArray(list) && list.length ? list[list.length - 1] : null;
  let home = unitProb(last?.homeWinPercentage);
  let tie = unitProb(last?.tiePercentage) ?? 0;
  if (home == null) {
    home = unitProb(summary?.predictor?.homeTeam?.gameProjection);
    tie = 0;
  }
  if (home == null) return null;
  const away = Math.max(0, 1 - home - tie);
  return {
    homeProb: round4(home),
    awayProb: round4(away),
    drawProb: round4(tie)
  };
}

function boardEvent(event, sport) {
  const comp = event?.competitions?.[0] || {};
  const teams = comp.competitors || [];
  const home = teams.find((team) => team?.homeAway === 'home');
  const away = teams.find((team) => team?.homeAway === 'away');
  const homeName = home?.team?.displayName || home?.team?.name || null;
  const awayName = away?.team?.displayName || away?.team?.name || null;
  if (!homeName || !awayName || !event?.id) return null;
  return {
    id: String(event.id),
    sport,
    home: homeName,
    away: awayName,
    state: comp.status?.type?.state || event.status?.type?.state || null
  };
}

export async function fetchEspnWinProb({
  fetchImpl,
  timeoutMs = 8000,
  boards = ESPN_SCOREBOARDS,
  summaryLimit = 20
} = {}) {
  const errors = [];
  const events = [];
  await mapPool(boards, 4, async (board) => {
    try {
      const payload = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${board.path}/scoreboard`, {
        fetchImpl,
        timeoutMs
      });
      for (const event of payload?.events || []) {
        const row = boardEvent(event, board.sport);
        if (row) events.push({ ...row, path: board.path });
      }
    } catch (error) {
      errors.push(`espn:${board.path}:${safeError(error)}`);
    }
  });
  const live = events.filter((event) => event.state === 'in').slice(0, summaryLimit);
  const lines = [];
  await mapPool(live, 4, async (event) => {
    try {
      const summary = await fetchJson(
        `https://site.api.espn.com/apis/site/v2/sports/${event.path}/summary?event=${encodeURIComponent(event.id)}`,
        { fetchImpl, timeoutMs }
      );
      const probs = espnProbFromSummary(summary);
      if (!probs) return;
      lines.push({
        home: event.home,
        away: event.away,
        sport: event.sport,
        ...probs
      });
    } catch (error) {
      errors.push(`espn:summary:${event.id}:${safeError(error)}`);
    }
  });
  return { lines, errors };
}

export async function loadLiveModelSources({ fetchImpl, timeoutMs = 8000 } = {}) {
  const [pinnacle, espn] = await Promise.all([
    fetchPinnacleLive({ fetchImpl, timeoutMs }).catch((error) => ({
      lines: [],
      errors: [`pinnacle:${safeError(error)}`]
    })),
    fetchEspnWinProb({ fetchImpl, timeoutMs }).catch((error) => ({
      lines: [],
      errors: [`espn:${safeError(error)}`]
    }))
  ]);
  return {
    pinnacle: pinnacle.lines || [],
    espn: espn.lines || [],
    errors: [...(pinnacle.errors || []), ...(espn.errors || [])]
  };
}
