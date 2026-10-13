const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const CACHE_MS = 20 * 60 * 1000;
const cache = new Map();

export function memberSeries(daily, variable, dayIndex) {
  const prefix = `${variable}_member`;
  const values = [];
  for (const [key, series] of Object.entries(daily || {})) {
    if (!key.startsWith(prefix)) continue;
    if (series?.[dayIndex] == null) continue;
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
  cacheMs = CACHE_MS,
  staleCacheMs = 6 * 60 * 60 * 1000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
  // ICON daily ensembles currently fail with HTTP 500 at these stations.
  // Retry GFS once, then use a separate global ensemble. The ensemble API
  // requires an explicit model (omitting it returns unsupported best_match).
  const models = ['gfs_seamless', 'gfs_seamless', 'ecmwf_ifs025'];
  let lastError;
  for (let attempt = 0; attempt < models.length; attempt += 1) {
    if (attempt) await sleepImpl(250 * 2 ** (attempt - 1));
    url.searchParams.set('models', models[attempt]);
    try {
      const response = await fetchImpl(new URL(url), { signal: AbortSignal.timeout(12000) });
      if (!response?.ok) throw new Error(`open-meteo ${response?.status || 'failed'}`);
      const value = normalizeEnsemble(await response.json());
      if (!Object.values(value.days).some((day) => day.max.length && day.min.length)) {
        throw new Error('open-meteo missing ensemble members');
      }
      cache.set(key, { at: nowMs, value });
      return value;
    } catch (error) {
      lastError = error;
    }
  }
  // Keep original dates and timestamp: old forecasts cannot become today's data.
  if (hit && nowMs - hit.at < staleCacheMs) return hit.value;
  throw lastError;
}

export function clearPlan16ForecastCache() {
  cache.clear();
}
