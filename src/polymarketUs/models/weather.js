import { US_RULES } from '../rules.js';
import { normalCdf, round4 } from './math.js';

export const WEATHER_CITIES = Object.freeze([
  Object.freeze({ name: 'New York', aliases: ['new york', 'nyc'], latitude: 40.7829, longitude: -73.9654, timeZone: 'America/New_York' }),
  Object.freeze({ name: 'Los Angeles', aliases: ['los angeles', 'la'], latitude: 34.0522, longitude: -118.2437, timeZone: 'America/Los_Angeles' }),
  Object.freeze({ name: 'Chicago', aliases: ['chicago'], latitude: 41.8781, longitude: -87.6298, timeZone: 'America/Chicago' }),
  Object.freeze({ name: 'Miami', aliases: ['miami'], latitude: 25.7617, longitude: -80.1918, timeZone: 'America/New_York' }),
  Object.freeze({ name: 'San Francisco', aliases: ['san francisco', 'sf'], latitude: 37.7749, longitude: -122.4194, timeZone: 'America/Los_Angeles' })
]);

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
};

function numberFrom(text) {
  const value = Number(String(text || '').replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export function matchWeatherCity(text) {
  const hay = String(text || '').toLowerCase();
  return WEATHER_CITIES.find((city) => city.aliases.some((alias) => {
    if (alias.length <= 3) return new RegExp(`\\b${alias}\\b`, 'i').test(hay);
    return hay.includes(alias);
  })) || null;
}

export function parseWeatherContract(market) {
  const text = [market?.question, market?.slug, market?.description].filter(Boolean).join('\n');
  if (!/temperature|°\s*[fc]|degrees/i.test(text)) return null;
  const city = matchWeatherCity(text);
  if (!city) return null;
  if (!US_RULES.weatherCities.some((name) => name.toLowerCase() === city.name.toLowerCase())) return null;
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  let date = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  if (!date) {
    const named = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june|july|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i);
    if (named) {
      const month = String(MONTHS[named[1].toLowerCase().replace('.', '')]).padStart(2, '0');
      const day = String(Number(named[2])).padStart(2, '0');
      const year = named[3] || String(new Date().getUTCFullYear());
      date = `${year}-${month}-${day}`;
    }
  }
  if (!date) return null;
  const between = text.match(/between\s+(-?\d+(?:\.\d+)?)\D{0,16}(-?\d+(?:\.\d+)?)/i);
  if (between) {
    const low = numberFrom(between[1]);
    const high = numberFrom(between[2]);
    if (low == null || high == null) return null;
    return { city, date, kind: 'between', low: Math.min(low, high), high: Math.max(low, high), variable: /low\b|minimum/i.test(text) ? 'min' : 'max' };
  }
  const below = text.match(/(?:below|under|at most|or lower|or below|≤|<=)\s*(-?\d+(?:\.\d+)?)/i)
    || text.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or lower|or below)/i);
  const above = text.match(/(?:above|over|at least|or higher|or above|or more|≥|>=)\s*(-?\d+(?:\.\d+)?)/i)
    || text.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or higher|or above|or more)/i);
  const hit = below || above;
  if (!hit) return null;
  const threshold = numberFrom(hit[1]);
  if (threshold == null) return null;
  return {
    city,
    date,
    kind: below ? 'below' : 'above',
    threshold,
    variable: /low\b|minimum/i.test(text) ? 'min' : 'max'
  };
}

export function memberSeries(daily, variable) {
  const prefix = `${variable}_member`;
  const values = [];
  for (const [key, series] of Object.entries(daily || {})) {
    if (!key.startsWith(prefix) || !Array.isArray(series)) continue;
    values.push(series);
  }
  return values;
}

export function samplesForDay(ensembleDaily, date, variable) {
  const times = ensembleDaily?.time || [];
  const index = times.findIndex((day) => String(day) === date);
  if (index < 0) return [];
  const key = variable === 'min' ? 'temperature_2m_min' : 'temperature_2m_max';
  const rows = memberSeries(ensembleDaily, key);
  return rows.map((series) => Number(series[index])).filter((value) => Number.isFinite(value));
}

export function probabilityFromSamples(samples, contract) {
  if (!samples?.length || !contract) return null;
  const hits = samples.filter((value) => {
    if (contract.kind === 'between') return value >= contract.low && value <= contract.high;
    if (contract.kind === 'below') return value <= contract.threshold;
    return value >= contract.threshold;
  }).length;
  return hits / samples.length;
}

export function normalThresholdProb(mean, sigma, contract) {
  if (!Number.isFinite(mean) || !(sigma > 0) || !contract) return null;
  const cdf = (value) => normalCdf((value - mean) / sigma);
  if (contract.kind === 'between') {
    const high = cdf(contract.high);
    const low = cdf(contract.low);
    if (high == null || low == null) return null;
    return Math.min(1, Math.max(0, high - low));
  }
  const at = cdf(contract.threshold);
  if (at == null) return null;
  if (contract.kind === 'below') return at;
  return 1 - at;
}

export function weatherRowsFromForecasts({ markets = [], forecasts = new Map() } = {}) {
  const rows = [];
  for (const market of markets) {
    const contract = parseWeatherContract(market);
    if (!contract || !market?.slug) continue;
    const forecast = forecasts.get(contract.city.name);
    const variable = contract.variable === 'min' ? 'min' : 'max';
    const samples = samplesForDay(forecast?.ensemble, contract.date, variable);
    let prob = probabilityFromSamples(samples, contract);
    let source = samples.length ? `Open-Meteo ensemble n=${samples.length}` : '';
    const point = forecast?.points?.[contract.date]?.[variable];
    if (prob == null && Number.isFinite(point)) {
      prob = normalThresholdProb(point, 3.5, contract);
      source = 'NWS/Open-Meteo 点预报，σ=3.5°F';
    }
    if (!(prob > 0.02 && prob < 0.98)) continue;
    const nws = forecast?.points?.[contract.date]?.[variable];
    const ensembleMean = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null;
    const agree = Number.isFinite(nws) && Number.isFinite(ensembleMean) ? Math.abs(nws - ensembleMean) <= 4 : false;
    const confidence = samples.length >= 15 && (agree || !Number.isFinite(nws)) ? 'High' : 'Med';
    const label = contract.kind === 'between'
      ? `${contract.low}–${contract.high}°F`
      : `${contract.kind === 'below' ? '≤' : '≥'}${contract.threshold}°F`;
    const basis = `${contract.city.name} ${contract.date} ${variable === 'min' ? '低温' : '高温'} ${label}：${source}，模型 ${(prob * 100).toFixed(1)}%。`;
    rows.push({
      sector: 'weather',
      slug: market.slug,
      side: 'Yes',
      model_prob: round4(prob),
      title: market.question || market.slug,
      question: market.question || '',
      category: 'weather',
      city: contract.city.name,
      resolution_risk: 'Low',
      confidence,
      basis,
      expires_at: market.endDate || null,
      window_id: market.slug
    });
  }
  return rows;
}
