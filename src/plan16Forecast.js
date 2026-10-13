const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const CACHE_MS = 20 * 60 * 1000;
const cache = new Map();

export function memberSeries(daily, variable, dayIndex) {
  const prefix = `${variable}_member`;
  const values = [];
  for (const [key, series] of Object.entries(daily || {})) {
    if (!key.startsWith(prefix)) continue;
    const value = Number(series?.[dayIndex]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

export function normalizeEnsemble(payload) {
  const daily = payload?.daily || {};
  const time = Array.isArray(daily.time) ? daily.time : [];
  const days = {};
  time.forEach((date, index) => {
    days[String(date)] = {
      max: memberSeries(daily, 'temperature_2m_max', index),
      min: memberSeries(daily, 'temperature_2m_min', index)
    };
  });
  return {
    offsetSeconds: Number(payload?.utc_offset_seconds) || 0,
    days
  };
}

export async function fetchPlan16Ensemble({
  latitude,
  longitude,
  unit = 'C',
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  cacheMs = CACHE_MS
} = {}) {
  const key = `${Number(latitude).toFixed(3)}|${Number(longitude).toFixed(3)}|${unit}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < cacheMs) return hit.value;
  const url = new URL(ENSEMBLE_URL);
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
  url.searchParams.set('temperature_unit', unit === 'F' ? 'fahrenheit' : 'celsius');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '3');
  url.searchParams.set('models', 'icon_seamless');
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
  if (!response?.ok) throw new Error(`open-meteo ${response?.status || 'failed'}`);
  const value = normalizeEnsemble(await response.json());
  cache.set(key, { at: nowMs, value });
  return value;
}

export function clearPlan16ForecastCache() {
  cache.clear();
}
