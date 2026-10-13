const ET_TIME_ZONE = 'America/New_York';
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

export function getSlotSchedule(now = new Date(), slotMinutes = 15) {
  const minutes = Math.max(1, Number(slotMinutes) || 15);
  if (minutes >= 1440) return getDailyNoonEtSlotSchedule(now);
  if (minutes >= 60) return getHourlyEtSlotSchedule(now);

  const current = new Date(now);
  current.setSeconds(0, 0);
  current.setMilliseconds(0);
  const minute = current.getMinutes();
  const slotMinute = Math.floor(minute / minutes) * minutes;

  const slot = new Date(current);
  slot.setMinutes(slotMinute, 0, 0);

  const next = new Date(slot);
  next.setMinutes(slot.getMinutes() + minutes, 0, 0);

  return {
    slotMinutes: minutes,
    currentSlotIso: slot.toISOString(),
    nextSlotIso: next.toISOString(),
    secondsToNext: Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000)),
    isDecisionMinute: minute % minutes === 0
  };
}

export function getTimeframeSlotSchedule(timeframe = '15m', now = new Date()) {
  return getSlotSchedule(now, timeframeToSlotMinutes(timeframe));
}

export function timeframeToSlotMinutes(timeframe = '15m') {
  const normalized = String(timeframe || '15m').toLowerCase();
  if (normalized === '5m') return 5;
  if (normalized === '1h' || normalized === 'hourly') return 60;
  if (normalized === '1d' || normalized === 'daily') return 1440;
  return 15;
}

export function slotIsoFromTargetTime(targetTimeIso, timeframe = '5m') {
  const slotMinutes = timeframe === '5m' ? 5 : 15;
  const targetMs = Date.parse(targetTimeIso);
  if (!Number.isFinite(targetMs)) return null;
  return new Date(targetMs - slotMinutes * 60_000).toISOString();
}

export function timeframeToCandleInterval(timeframe = '15m') {
  const normalized = String(timeframe || '15m').toLowerCase();
  if (normalized === '5m') return '5m';
  if (normalized === '1h' || normalized === 'hourly') return '1h';
  if (normalized === '1d' || normalized === 'daily') return '1d';
  return '15m';
}

/** Polymarket hourly crypto up/down windows are Eastern Time clock hours. */
export function getHourlyEtSlotSchedule(now = new Date()) {
  const et = getEtParts(now);
  const currentStart = zonedEtToUtc({
    year: et.year,
    month: et.month,
    day: et.day,
    hour: et.hour,
    minute: 0,
    second: 0
  });
  const nextStartParts = addEtHours(et, 1);
  const nextStart = zonedEtToUtc({
    year: nextStartParts.year,
    month: nextStartParts.month,
    day: nextStartParts.day,
    hour: nextStartParts.hour,
    minute: 0,
    second: 0
  });
  return {
    slotMinutes: 60,
    currentSlotIso: currentStart.toISOString(),
    nextSlotIso: nextStart.toISOString(),
    secondsToNext: Math.max(0, Math.floor((nextStart.getTime() - now.getTime()) / 1000)),
    isDecisionMinute: et.minute === 0 && et.second === 0
  };
}

/**
 * Polymarket daily crypto up/down windows run noon ET → noon ET.
 * Example: "on March 5" ends at March 5 12:00 ET and started March 4 12:00 ET.
 */
export function getDailyNoonEtSlotSchedule(now = new Date()) {
  const et = getEtParts(now);
  // Before noon ET: settle today noon. At/after noon ET: settle tomorrow noon.
  const endParts = et.hour < 12
    ? { year: et.year, month: et.month, day: et.day }
    : addCivilDays(et, 1);
  const startParts = addCivilDays(endParts, -1);
  const currentSlot = zonedEtToUtc({
    year: startParts.year,
    month: startParts.month,
    day: startParts.day,
    hour: 12,
    minute: 0,
    second: 0
  });
  const nextSlot = zonedEtToUtc({
    year: endParts.year,
    month: endParts.month,
    day: endParts.day,
    hour: 12,
    minute: 0,
    second: 0
  });

  return {
    slotMinutes: 1440,
    currentSlotIso: currentSlot.toISOString(),
    nextSlotIso: nextSlot.toISOString(),
    secondsToNext: Math.max(0, Math.floor((nextSlot.getTime() - now.getTime()) / 1000)),
    isDecisionMinute: et.hour === 12 && et.minute === 0 && et.second === 0,
    settlementEtDate: formatEtDateLabel(endParts)
  };
}

export function getEtDateParts(date = new Date()) {
  return getEtParts(date);
}

export function buildDailyUpDownSlugCandidates(asset = 'bitcoin', settlementEtDate = null, now = new Date()) {
  const fullName = cryptoAssetFullName(asset);
  if (!fullName) return [];
  const parts = settlementEtDate || getEtParts(now);
  const month = MONTH_NAMES[(Number(parts.month) || 1) - 1];
  const day = Number(parts.day);
  const year = Number(parts.year);
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return [];
  return [
    `${fullName}-up-or-down-on-${month}-${day}-${year}`,
    `${fullName}-up-or-down-on-${month}-${day}`
  ];
}

export function buildHourlyUpDownSlugCandidates(asset = 'bitcoin', now = new Date()) {
  const fullName = cryptoAssetFullName(asset);
  if (!fullName) return [];
  const schedule = getHourlyEtSlotSchedule(now);
  // Polymarket names hourly markets by the START hour in ET, e.g. "4AM ET" ends at 5AM ET.
  const startEt = getEtParts(new Date(schedule.currentSlotIso));
  const month = MONTH_NAMES[startEt.month - 1];
  const day = startEt.day;
  const year = startEt.year;
  const hour12 = ((startEt.hour + 11) % 12) + 1;
  const ampm = startEt.hour >= 12 ? 'pm' : 'am';
  return [
    `${fullName}-up-or-down-${month}-${day}-${year}-${hour12}${ampm}-et`,
    `${fullName}-up-or-down-${month}-${day}-${hour12}${ampm}-et`
  ];
}

function cryptoAssetFullName(asset = 'bitcoin') {
  const key = String(asset || '').toLowerCase();
  if (key === 'bitcoin' || key === 'btc') return 'bitcoin';
  if (key === 'ethereum' || key === 'eth' || key === 'ether') return 'ethereum';
  if (key === 'solana' || key === 'sol') return 'solana';
  if (key === 'xrp' || key === 'ripple') return 'xrp';
  return null;
}

function formatEtDateLabel(parts) {
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function getEtParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
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
    ms: 0
  };
}

function addCivilDays(parts, deltaDays) {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day) + (deltaDays * 86_400_000);
  const date = new Date(utc);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function addEtHours(parts, deltaHours) {
  const utc = zonedEtToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: 0,
    second: 0
  });
  utc.setUTCHours(utc.getUTCHours() + deltaHours);
  return getEtParts(utc);
}

function zonedEtToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  // Guess UTC then correct by the ET offset observed at that instant.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const asEt = getEtParts(new Date(utcMs));
    const desiredAsMinutes = (((hour * 60) + minute) * 60) + second;
    const actualAsMinutes = (((asEt.hour * 60) + asEt.minute) * 60) + asEt.second;
    const dayDelta = Date.UTC(year, month - 1, day) - Date.UTC(asEt.year, asEt.month - 1, asEt.day);
    const diffSeconds = (dayDelta / 1000) + (desiredAsMinutes - actualAsMinutes);
    if (Math.abs(diffSeconds) < 0.5) break;
    utcMs += diffSeconds * 1000;
  }
  return new Date(utcMs);
}
