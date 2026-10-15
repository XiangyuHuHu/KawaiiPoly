const PT = 'America/Los_Angeles';

const WEEKDAYS = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

export function ptParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PT,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23'
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] || 0
  };
}

export function ptDateKey(date = new Date()) {
  const parts = ptParts(date);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

export function formatPtTimestamp(date = new Date()) {
  const parts = ptParts(date);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${parts.year}-${month}-${day} ${hour}:${minute} PT`;
}

export function formatPtLabel(date = new Date()) {
  const parts = ptParts(date);
  return `太平洋时间${parts.month}月${parts.day}日`;
}

function parseClock(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

function inClockWindow(minuteOfDay, clock, length) {
  const start = parseClock(clock);
  return minuteOfDay >= start && minuteOfDay < start + length;
}

function inClockRange(minuteOfDay, start, end) {
  const from = parseClock(start);
  const to = parseClock(end);
  return minuteOfDay >= from && minuteOfDay < to;
}

function sessionLabel({ weekend, longDated, weekdaySession, btcShortDense, fullSuite }) {
  if (weekend) return 'weekend-full';
  if (longDated && weekdaySession) return `weekday-${weekdaySession}-plus-longdated`;
  if (weekdaySession) return `weekday-${weekdaySession}-full`;
  if (fullSuite && longDated) return 'weekday-full-plus-longdated';
  if (fullSuite) return 'weekday-full';
  if (btcShortDense && longDated) return 'weekday-btc-dense-plus-longdated';
  if (btcShortDense) return 'weekday-btc-dense';
  if (longDated) return 'monday-longdated';
  return 'closed';
}

/**
 * Full suite (every sector) runs every loop, any day, when schedule.fullSuiteEveryLoop is on.
 * Weekday 08:37/12:37/18:37 PT stay labeled as the original named windows.
 * Weekday BTC 15m/1h misprice and 15m momentum are dense 00:00–24:00 PT.
 * Monday 08:50 still marks long-dated crypto/master.
 */
export function describeSession(now = new Date(), rules) {
  const parts = ptParts(now);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const length = rules.schedule.sessionLengthMinutes;
  const weekend = parts.weekday === 6 || parts.weekday === 7;
  const weekdaySession = weekend
    ? null
    : rules.schedule.weekdaySessions.find((clock) => inClockWindow(minuteOfDay, clock, length)) || null;
  const longDated = parts.weekday === 1 && inClockWindow(minuteOfDay, rules.schedule.mondayLongDated, length);
  const dense = rules.schedule.weekdayBtcDense;
  const btcShortDense = !weekend && dense
    ? inClockRange(minuteOfDay, dense.start, dense.end)
    : false;
  const fullSuiteEveryLoop = rules.schedule.fullSuiteEveryLoop !== false;
  const fullSuite = fullSuiteEveryLoop || weekend || Boolean(weekdaySession);
  return {
    timeZone: rules.schedule.timeZone,
    ptDate: ptDateKey(now),
    weekday: parts.weekday,
    weekend,
    weekdaySession,
    longDated,
    btcShortDense,
    btcShort: fullSuite || btcShortDense,
    fullSuite,
    label: sessionLabel({ weekend, longDated, weekdaySession, btcShortDense, fullSuite })
  };
}

export function alignUtcWindow(now = new Date(), timeframe = '15m') {
  const ms = timeframe === '1h' ? 3_600_000 : 900_000;
  const startMs = Math.floor(now.getTime() / ms) * ms;
  return {
    start: new Date(startMs),
    end: new Date(startMs + ms)
  };
}

export function formatWindowStamp(date) {
  const iso = new Date(date).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

export function formatUsUpdownSlug(timeframe, windowStart) {
  const iso = new Date(windowStart).toISOString();
  const ymd = iso.slice(0, 10);
  const hh = iso.slice(11, 13);
  const mm = iso.slice(14, 16);
  const tf = timeframe === '1h' ? '1h' : '15m';
  return `cpc-btc-updown-${tf}-${ymd}-${hh}${mm}z`;
}
