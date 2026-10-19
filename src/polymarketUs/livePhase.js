/**
 * Live 体育相位。尾盘定义和 2026-10-19 回测一致：
 * 足球 ≥75'；橄榄球/篮球第 4 节或加时；冰球第 3 节或加时；棒球第 7 局起。
 * early / mid / late 是更细的切分，供观察日志使用。late 仍在尾盘之前。
 */

function text(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeLiveSport(value) {
  const blob = text(value);
  if (!blob) return 'other';
  if (/college-football|ncaaf|\bcfb\b/.test(blob)) return 'cfb';
  if (/soccer|epl|premier|la liga|serie a|bundesliga|ligue 1|mls/.test(blob)) return 'soccer';
  if (/college-basket|ncaab|\bcbb\b/.test(blob)) return 'cbb';
  if (/\bnba\b|basketball/.test(blob)) return 'nba';
  if (/\bnfl\b|american football|\bfootball\b/.test(blob)) return 'nfl';
  if (/\bnhl\b|hockey/.test(blob)) return 'nhl';
  if (/\bmlb\b|baseball/.test(blob)) return 'mlb';
  if (/table.?tennis|ping/.test(blob)) return 'table_tennis';
  if (/tennis/.test(blob)) return 'tennis';
  if (/cricket/.test(blob)) return 'cricket';
  if (/esport|cs2|dota|valorant|league of legends/.test(blob)) return 'esports';
  if (/darts/.test(blob)) return 'darts';
  return blob.split(/[^a-z0-9]+/).find(Boolean) || 'other';
}

export function sportFromEvent(event, market) {
  const type = event?.eventState?.type || event?.metadata?.gameState?.type || '';
  const smt = market?.sportsMarketType || '';
  const series = event?.seriesSlug || '';
  const blob = `${type} ${smt} ${series}`;
  if (/college-football|ncaaf|cfb/i.test(blob)) return 'cfb';
  if (/soccer/i.test(smt) || /soccer/i.test(type)) return 'soccer';
  if (/football/i.test(smt) || /football/i.test(type)) {
    return /college|ncaaf|cfb/i.test(series) ? 'cfb' : 'nfl';
  }
  if (/basketball/i.test(smt) || /basketball/i.test(type)) {
    return /college|ncaab|cbb/i.test(`${series} ${smt}`) ? 'cbb' : 'nba';
  }
  if (/hockey/i.test(smt) || /hockey/i.test(type)) return 'nhl';
  if (/baseball/i.test(smt) || /baseball/i.test(type)) return 'mlb';
  if (/table_tennis|table-tennis/i.test(smt)) return 'table_tennis';
  if (/tennis/i.test(smt) || /tennis/i.test(type)) return 'tennis';
  if (/cricket/i.test(smt) || /cricket/i.test(type)) return 'cricket';
  if (/esport/i.test(smt) || /^(cs2|dota|val|lol)/i.test(series)) return 'esports';
  if (/darts/i.test(smt)) return 'darts';
  return normalizeLiveSport(type || series || smt);
}

export function soccerMinute(clock, period) {
  const sources = [clock, period];
  for (const source of sources) {
    const raw = String(source || '').trim();
    if (!raw) continue;
    const stoppage = raw.match(/^(\d+)\s*\+\s*(\d+)/);
    if (stoppage) return Number(stoppage[1]) + Number(stoppage[2]);
    const marked = raw.match(/^(\d+)\s*'/);
    if (marked) return Number(marked[1]);
    if (/^\d+$/.test(raw)) return Number(raw);
    const clocked = raw.match(/^(\d+):(\d{2})$/);
    if (clocked && Number(clocked[1]) <= 130) return Number(clocked[1]);
  }
  return null;
}

function clockRemainingSeconds(clock) {
  const raw = String(clock || '').trim();
  const match = raw.match(/^(\d+):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function notStarted(period) {
  const value = text(period);
  return value === '' || ['ns', 'pre', 'scheduled', 'not_started', 'not started'].includes(value);
}

function quarter(period) {
  const value = text(period);
  if (/ot|overtime/.test(value)) return 5;
  const match = value.match(/q\s*([1-4])|(?:^|[^0-9])([1-4])(?:st|nd|rd|th)\b/);
  if (!match) return null;
  return Number(match[1] || match[2]);
}

function quarterPhase(period) {
  const q = quarter(period);
  if (q == null) return null;
  if (q >= 4) return 'endgame';
  if (q === 3) return 'late';
  if (q === 2) return 'mid';
  return 'early';
}

function halfPhase(period, clock) {
  const value = text(period);
  if (!/half|\b[12]h\b/.test(value)) return null;
  if (/2|second/.test(value)) {
    const remain = clockRemainingSeconds(clock);
    if (remain != null && remain <= 5 * 60) return 'endgame';
    return 'late';
  }
  return 'early';
}

function setPhase(period) {
  const match = text(period).match(/s(?:et)?\s*(\d+)|\b([1-5])(?:st|nd|rd|th)\s*set/);
  if (!match) return null;
  const set = Number(match[1] || match[2]);
  if (set <= 1) return 'early';
  if (set === 2) return 'mid';
  return 'endgame';
}

function mapPhase(period) {
  const match = text(period).match(/map\s*(\d+)/);
  if (!match) return null;
  const map = Number(match[1]);
  if (map <= 1) return 'early';
  if (map === 2) return 'mid';
  return 'endgame';
}

function inning(period) {
  const match = text(period).match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * @returns {'pregame'|'early'|'mid'|'late'|'endgame'}
 */
export function classifyLivePhase({ sport, period, clock, live } = {}) {
  const kind = normalizeLiveSport(sport);
  if (notStarted(period) && live !== true) return 'pregame';
  if (notStarted(period) && live === true && !clock) return 'pregame';
  const value = text(period);

  if (kind === 'soccer') {
    if (/\bht\b|half/.test(value) && !/2/.test(value)) return 'early';
    if (/\bet\b|extra|ft\b|pen/.test(value)) return 'endgame';
    const minute = soccerMinute(clock, period);
    if (minute != null) {
      if (minute >= 75) return 'endgame';
      if (minute >= 60) return 'late';
      if (minute >= 30) return 'mid';
      return 'early';
    }
    if (/\b2h\b|2nd|second/.test(value)) return 'late';
    if (/\b1h\b|1st|first/.test(value)) return 'early';
    if (live === true) return 'mid';
    return 'pregame';
  }

  if (kind === 'nfl' || kind === 'cfb' || kind === 'nba') {
    return quarterPhase(period) || halfPhase(period, clock) || (live === true ? 'mid' : 'pregame');
  }

  if (kind === 'cbb') {
    return halfPhase(period, clock) || quarterPhase(period) || (live === true ? 'mid' : 'pregame');
  }

  if (kind === 'nhl') {
    if (/ot|so|shootout/.test(value)) return 'endgame';
    if (/3|third/.test(value)) return 'endgame';
    if (/2|second/.test(value)) return 'mid';
    if (/1|first/.test(value)) return 'early';
    return live === true ? 'mid' : 'pregame';
  }

  if (kind === 'mlb') {
    const n = inning(period);
    if (n == null) return live === true ? 'mid' : 'pregame';
    if (n >= 7) return 'endgame';
    if (n >= 6) return 'late';
    if (n >= 4) return 'mid';
    return 'early';
  }

  if (kind === 'tennis' || kind === 'table_tennis') {
    return setPhase(period) || (live === true ? 'mid' : 'pregame');
  }

  if (kind === 'esports') {
    return mapPhase(period) || (live === true ? 'mid' : 'pregame');
  }

  if (value === 'sus' || value === 'suspended') return 'mid';
  if (live === true) return 'mid';
  return 'pregame';
}
