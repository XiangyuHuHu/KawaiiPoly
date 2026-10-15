import { readJsonl, usPaths } from './signals.js';
import { fetchJson, safeError } from './models/http.js';
import { PREGAME_LEAGUES, pinnacleMoneylines, pregameRowsFromBooks } from './models/pregame.js';
import { parseWeatherContract, weatherRowsFromForecasts, WEATHER_CITIES } from './models/weather.js';
import { macroRowsFromBooks, upperFromEffrPayload } from './models/macro.js';
import { cryptoRowsFromChain } from './models/crypto.js';
import { masterRowsFromMarkets } from './models/master.js';

const GATEWAY = 'https://gateway.polymarket.us/v1';
const SECTORS = ['pregame', 'weather', 'macro', 'crypto', 'master'];

export function formatModelCounts(counts = {}) {
  return SECTORS.map((sector) => `${sector}=${counts[sector] || 0}`).join(' ');
}

function countRows(rows) {
  const counts = Object.fromEntries(SECTORS.map((sector) => [sector, 0]));
  for (const row of rows) {
    if (counts[row?.sector] != null) counts[row.sector] += 1;
  }
  return counts;
}

function dedupe(rows) {
  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    if (!row?.sector || !row?.slug || !row?.side) continue;
    const key = `${row.sector}|${row.slug}|${row.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

async function catalogMarkets(fetchImpl, pages) {
  const markets = [];
  for (let start = 0; start < pages; start += 5) {
    const batch = [];
    for (let page = start; page < Math.min(pages, start + 5); page += 1) {
      const url = `${GATEWAY}/markets?limit=100&closed=false&offset=${page * 100}`;
      batch.push(fetchJson(url, { fetchImpl })
        .then((data) => ({ rows: data?.markets || [], ok: true }))
        .catch(() => ({ rows: [], ok: false })));
    }
    const chunks = await Promise.all(batch);
    let empty = false;
    for (const chunk of chunks) {
      if (chunk.ok && !chunk.rows.length) empty = true;
      markets.push(...chunk.rows);
    }
    if (empty) break;
  }
  return markets;
}

async function leagueEvents(fetchImpl, league, now, horizonMs) {
  const start = now.toISOString();
  const end = new Date(now.getTime() + horizonMs).toISOString();
  const url = `${GATEWAY}/events?limit=20&series_id=${league.seriesId}&closed=false&startTimeMin=${encodeURIComponent(start)}&startTimeMax=${encodeURIComponent(end)}`;
  const data = await fetchJson(url, { fetchImpl });
  return data?.events || [];
}

async function pinnacleLines(fetchImpl, league) {
  const headers = { Referer: 'https://www.pinnacle.com/' };
  const root = `https://guest.api.arcadia.pinnacle.com/0.1/leagues/${league.pinnacleLeagueId}`;
  const [matchups, markets] = await Promise.all([
    fetchJson(`${root}/matchups?brandId=0`, { fetchImpl, headers }),
    fetchJson(`${root}/markets/straight`, { fetchImpl, headers })
  ]);
  return pinnacleMoneylines(matchups, markets);
}

async function producePregame({ fetchImpl, now, horizonMs }) {
  const events = [];
  const lines = [];
  const errors = [];
  await Promise.all(PREGAME_LEAGUES.map(async (league) => {
    try {
      events.push(...await leagueEvents(fetchImpl, league, now, horizonMs));
    } catch (error) {
      errors.push(`pregame:${league.sport}:events:${safeError(error)}`);
    }
    try {
      lines.push(...await pinnacleLines(fetchImpl, league));
    } catch (error) {
      errors.push(`pregame:${league.sport}:pinnacle:${safeError(error)}`);
    }
  }));
  const rows = pregameRowsFromBooks({ events, lines, now, horizonMs })
    .sort((left, right) => String(left.expires_at).localeCompare(String(right.expires_at)))
    .slice(0, 24);
  return { rows, errors };
}

async function cityForecast(fetchImpl, city) {
  const query = `latitude=${city.latitude}&longitude=${city.longitude}&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=5`;
  const [ensemble, point, nwsPoint] = await Promise.all([
    fetchJson(`https://ensemble-api.open-meteo.com/v1/ensemble?${query}&models=gfs_seamless`, { fetchImpl }).catch(() => null),
    fetchJson(`https://api.open-meteo.com/v1/forecast?${query}`, { fetchImpl }).catch(() => null),
    fetchJson(`https://api.weather.gov/points/${city.latitude},${city.longitude}`, { fetchImpl }).catch(() => null)
  ]);
  const points = {};
  const daily = point?.daily || {};
  (daily.time || []).forEach((date, index) => {
    points[date] = {
      max: Number(daily.temperature_2m_max?.[index]),
      min: Number(daily.temperature_2m_min?.[index])
    };
  });
  const forecastUrl = nwsPoint?.properties?.forecast;
  if (forecastUrl) {
    try {
      const forecast = await fetchJson(forecastUrl, { fetchImpl });
      for (const period of forecast?.properties?.periods || []) {
        const date = String(period.startTime || '').slice(0, 10);
        if (!date) continue;
        const temperature = Number(period.temperature);
        if (!Number.isFinite(temperature)) continue;
        const slot = points[date] || {};
        if (period.isDaytime === true) slot.max = temperature;
        else slot.min = temperature;
        points[date] = slot;
      }
    } catch {
      // NWS 时段失败时仍保留 Open-Meteo。
    }
  }
  return { ensemble: ensemble?.daily || null, points };
}

async function produceWeather({ fetchImpl, markets }) {
  const needed = new Set();
  for (const market of markets) {
    const contract = parseWeatherContract(market);
    if (contract) needed.add(contract.city.name);
  }
  const forecasts = new Map();
  await Promise.all([...needed].map(async (name) => {
    const city = WEATHER_CITIES.find((row) => row.name === name);
    if (!city) return;
    forecasts.set(name, await cityForecast(fetchImpl, city));
  }));
  return { rows: weatherRowsFromForecasts({ markets, forecasts }).slice(0, 12), errors: [] };
}

async function kalshiMarkets(fetchImpl, eventTicker) {
  const data = await fetchJson(
    `https://api.elections.kalshi.com/trade-api/v2/markets?limit=40&status=open&event_ticker=${encodeURIComponent(eventTicker)}`,
    { fetchImpl }
  );
  return data?.markets || [];
}

function partyBook(markets) {
  const book = {};
  for (const market of markets || []) {
    const ticker = String(market.ticker || '');
    if (ticker.endsWith('-D')) book.d = market;
    if (ticker.endsWith('-R')) book.r = market;
  }
  return book;
}

async function produceMacro({ fetchImpl, markets }) {
  const errors = [];
  const [effr, fedEvents, houseMarkets, senateMarkets, fedWatch] = await Promise.all([
    fetchJson('https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json', { fetchImpl }).catch((error) => {
      errors.push(`macro:effr:${safeError(error)}`);
      return null;
    }),
    fetchJson('https://api.elections.kalshi.com/trade-api/v2/events?limit=12&status=open&series_ticker=KXFED', { fetchImpl }).catch((error) => {
      errors.push(`macro:fed-events:${safeError(error)}`);
      return null;
    }),
    kalshiMarkets(fetchImpl, 'CONTROLH-2026').catch((error) => {
      errors.push(`macro:house:${safeError(error)}`);
      return [];
    }),
    kalshiMarkets(fetchImpl, 'CONTROLS-2026').catch((error) => {
      errors.push(`macro:senate:${safeError(error)}`);
      return [];
    }),
    fetchJson('https://www.cmegroup.com/CmeWS/mvc/FedWatchTool/data/fedWatch.json', { fetchImpl, timeoutMs: 4000 }).catch(() => null)
  ]);
  const currentUpper = upperFromEffrPayload(effr);
  const events = (fedEvents?.events || [])
    .filter((event) => Date.parse(event.strike_date || '') > Date.now() - 24 * 60 * 60 * 1000)
    .slice(0, 6);
  const fedMeetings = [];
  await Promise.all(events.map(async (event) => {
    try {
      fedMeetings.push({
        eventTicker: event.event_ticker,
        strikeDate: event.strike_date,
        markets: await kalshiMarkets(fetchImpl, event.event_ticker)
      });
    } catch (error) {
      errors.push(`macro:${event.event_ticker}:${safeError(error)}`);
    }
  }));
  const rows = macroRowsFromBooks({
    markets,
    currentUpper,
    fedMeetings,
    fedWatch,
    house: partyBook(houseMarkets),
    senate: partyBook(senateMarkets)
  }).slice(0, 16);
  return { rows, errors };
}

async function produceCrypto({ fetchImpl, markets, now }) {
  const summaries = await fetchJson(
    'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
    { fetchImpl }
  );
  return {
    rows: cryptoRowsFromChain({ markets, summaries: summaries?.result || [], now }),
    errors: []
  };
}

async function manualRows(ledgerRoot) {
  if (!ledgerRoot) return [];
  const rows = await readJsonl(usPaths(ledgerRoot).modelInput);
  return rows.filter((row) => row && typeof row === 'object');
}

export async function loadPublicModelReport({
  now = new Date(),
  fetchImpl = globalThis.fetch,
  ledgerRoot = null,
  maxCatalogPages = 30,
  horizonMs = 72 * 60 * 60 * 1000
} = {}) {
  const errors = [];
  const markets = await catalogMarkets(fetchImpl, maxCatalogPages).catch((error) => {
    errors.push(`catalog:${safeError(error)}`);
    return [];
  });
  const jobs = await Promise.all([
    producePregame({ fetchImpl, now, horizonMs }).catch((error) => ({ rows: [], errors: [`pregame:${safeError(error)}`] })),
    produceWeather({ fetchImpl, markets }).catch((error) => ({ rows: [], errors: [`weather:${safeError(error)}`] })),
    produceMacro({ fetchImpl, markets }).catch((error) => ({ rows: [], errors: [`macro:${safeError(error)}`] })),
    produceCrypto({ fetchImpl, markets, now }).catch((error) => ({ rows: [], errors: [`crypto:${safeError(error)}`] })),
    Promise.resolve({ rows: masterRowsFromMarkets(markets), errors: [] }),
    manualRows(ledgerRoot).catch((error) => {
      errors.push(`manual:${safeError(error)}`);
      return [];
    })
  ]);
  const [pregame, weather, macro, crypto, master, manual] = jobs;
  for (const job of [pregame, weather, macro, crypto, master]) errors.push(...(job.errors || []));
  const rows = dedupe([
    ...pregame.rows,
    ...weather.rows,
    ...macro.rows,
    ...crypto.rows,
    ...master.rows,
    ...manual
  ]);
  return { rows, counts: countRows(rows), errors, catalog: markets.length };
}

/** runUsScan 的 loadModels：只返回模型行。单个数据源失败不拖垮整轮。 */
export async function loadPublicModels(options = {}) {
  const report = await loadPublicModelReport(options);
  return report.rows;
}
