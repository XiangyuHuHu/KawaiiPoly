import { americanToImplied, devig, round4, teamsMatch } from './math.js';

/** 美国站 series_id → Pinnacle guest league。拿不到的联赛跳过，不挡住其它板块。 */
export const PREGAME_LEAGUES = Object.freeze([
  Object.freeze({ sport: 'nba', seriesId: '4', pinnacleLeagueId: 487 }),
  Object.freeze({ sport: 'nhl', seriesId: '6', pinnacleLeagueId: 1456 }),
  Object.freeze({ sport: 'nfl', seriesId: '2', pinnacleLeagueId: 889 }),
  Object.freeze({ sport: 'mlb', seriesId: '15', pinnacleLeagueId: 246 }),
  Object.freeze({ sport: 'epl', seriesId: '11', pinnacleLeagueId: 1980 })
]);

function priceOf(market, designation) {
  const row = (market?.prices || []).find((price) => price?.designation === designation);
  return row ? americanToImplied(row.price) : null;
}

export function pinnacleMoneylines(matchups = [], markets = []) {
  const games = new Map();
  for (const matchup of matchups) {
    if (!matchup?.id || matchup.parentId || matchup.type === 'special' || matchup.isLive) continue;
    games.set(matchup.id, matchup);
  }
  const lines = [];
  for (const market of markets) {
    if (market?.type !== 'moneyline' || market.period !== 0 || market.isAlternate) continue;
    if (market.status && market.status !== 'open') continue;
    const game = games.get(market.matchupId);
    if (!game) continue;
    const home = (game.participants || []).find((team) => team.alignment === 'home');
    const away = (game.participants || []).find((team) => team.alignment === 'away');
    const homeRaw = priceOf(market, 'home');
    const awayRaw = priceOf(market, 'away');
    const drawRaw = priceOf(market, 'draw');
    if (homeRaw == null || awayRaw == null || !home?.name || !away?.name) continue;
    const bag = drawRaw == null ? [homeRaw, awayRaw] : [homeRaw, awayRaw, drawRaw];
    const fair = devig(bag);
    if (!fair) continue;
    lines.push({
      home: home.name,
      away: away.name,
      homeProb: fair[0],
      awayProb: fair[1],
      drawProb: drawRaw == null ? 0 : fair[2],
      startTime: game.startTime || null
    });
  }
  return lines;
}

function moneylineMarket(event) {
  return (event?.markets || []).find((market) => (
    market?.marketType === 'moneyline'
    || /winner|moneyline/i.test(String(market?.sportsMarketType || ''))
  ));
}

function longTeamName(market, event) {
  const side = (market?.marketSides || []).find((row) => row?.long === true);
  const team = side?.team || {};
  return team.name || team.alias || team.safeName || event?.teams?.[0]?.name || null;
}

function sharpProb(line, teamName) {
  if (teamsMatch(teamName, line.home)) return line.homeProb;
  if (teamsMatch(teamName, line.away)) return line.awayProb;
  return null;
}

function findLine(lines, event) {
  const names = (event?.teams || []).map((team) => team?.name || team?.alias).filter(Boolean);
  if (names.length < 2) return null;
  return lines.find((line) => {
    const homeHit = names.some((name) => teamsMatch(name, line.home));
    const awayHit = names.some((name) => teamsMatch(name, line.away));
    return homeHit && awayHit;
  }) || null;
}

export function pregameRowsFromBooks({ events = [], lines = [], now = new Date(), horizonMs = 72 * 60 * 60 * 1000 } = {}) {
  const rows = [];
  const start = now.getTime();
  for (const event of events) {
    if (event?.closed === true || event?.active === false) continue;
    const market = moneylineMarket(event);
    if (!market?.slug) continue;
    const when = Date.parse(market.gameStartTime || event.startTime || '');
    if (!Number.isFinite(when) || when <= start + 5 * 60 * 1000 || when > start + horizonMs) continue;
    const line = findLine(lines, event);
    const team = longTeamName(market, event);
    if (!line || !team) continue;
    const prob = sharpProb(line, team);
    if (!(prob > 0.02 && prob < 0.98)) continue;
    const basis = `赛前 Pinnacle 去水：${team} ${(prob * 100).toFixed(1)}%（${line.away} @ ${line.home}）。`;
    const shared = {
      sector: 'pregame',
      slug: market.slug,
      title: event.title || market.question || '',
      question: market.question || event.title || '',
      category: 'sports',
      resolution_risk: 'Low',
      confidence: 'High',
      basis,
      expires_at: market.endDate || event.endDate || new Date(when + 6 * 60 * 60 * 1000).toISOString(),
      window_id: market.slug
    };
    rows.push({ ...shared, side: 'Yes', model_prob: round4(prob) });
    rows.push({ ...shared, side: 'No', model_prob: round4(1 - prob), basis: `${basis} 买 No 表示 ${team} 不赢。` });
  }
  return rows;
}
