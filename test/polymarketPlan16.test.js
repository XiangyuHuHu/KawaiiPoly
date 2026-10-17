import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberSeries, normalizeEnsemble } from '../src/plan16Forecast.js';
import { stationFromDescription } from '../src/plan16Stations.js';
import {
  ensembleYesProbability,
  evaluatePlan16Row,
  parsePlan16Question,
  plan16PaperMinAsk,
  selectPlan16Buys,
  temperatureInBucket,
  PLAN16_CONTROL_MIN_ASK
} from '../src/polymarketPlan16.js';

const NOW = Date.parse('2026-10-10T00:30:00Z');

function members(center, count = 30, spread = 0) {
  return Array.from({ length: count }, (_, index) => center + (index % 3 - 1) * spread);
}

function forecastFor(date, highs, { offsetSeconds = 46800, lows = null } = {}) {
  return {
    offsetSeconds,
    days: {
      [date]: { max: highs, min: lows || highs.map((value) => value - 8) }
    }
  };
}

function market({
  question = 'Will the highest temperature in Wellington be 19°C on October 10?',
  description = 'NOAA at the Wellington Intl Airport Station. https://www.weather.gov/wrh/timeseries?site=nzwn',
  yes = 0.4,
  endDate = '2026-10-10T12:00:00Z'
} = {}) {
  return {
    question,
    description,
    slug: 'wellington-19',
    conditionId: '0xabc',
    endDate,
    active: true,
    closed: false,
    outcomes: '["Yes","No"]',
    clobTokenIds: '["yes-token","no-token"]',
    outcomePrices: `["${yes}","${1 - yes}"]`
  };
}

function book(bid, ask) {
  return { bestBid: bid, bestAsk: ask };
}

test('parses exact, tail and fahrenheit range buckets', () => {
  const exact = parsePlan16Question('Will the highest temperature in Wellington be 19°C on October 10?', 2026);
  assert.equal(exact.date, '2026-10-10');
  assert.equal(exact.bucket.kind, 'exact');
  assert.equal(exact.bucket.low, 19);
  const below = parsePlan16Question('Will the highest temperature in Seoul (Incheon) be 19°C or below on October 10?', 2026);
  assert.equal(below.bucket.kind, 'below');
  assert.equal(below.place, 'Seoul (Incheon)');
  const above = parsePlan16Question('Will the highest temperature in Helsinki be 13°C or higher on October 10?', 2026);
  assert.equal(above.bucket.kind, 'above');
  const range = parsePlan16Question('Will the highest temperature in Chicago be between 62-63°F on October 9?', 2026);
  assert.deepEqual(range.bucket, { kind: 'between', low: 62, high: 63, unit: 'F' });
  const low = parsePlan16Question('Will the lowest temperature in Hong Kong be 21°C on October 10?', 2026);
  assert.equal(low.kind, 'low');
  assert.equal(parsePlan16Question('Will Chicago face tornado risk on October 9?', 2026), null);
});

test('rounds ensemble temperatures into the integer bucket', () => {
  const bucket = { kind: 'exact', low: 19, high: 19 };
  assert.equal(temperatureInBucket(18.6, bucket), true);
  assert.equal(temperatureInBucket(19.5, bucket), false);
  assert.equal(ensembleYesProbability([18.6, 19.2, 20.1, 17], bucket), 0.5);
  assert.equal(temperatureInBucket(18, { kind: 'below', low: 19 }), true);
  assert.equal(temperatureInBucket(64, { kind: 'between', low: 62, high: 63 }), false);
});

test('buys yes only when the ensemble clears the fee-inclusive ask', () => {
  const bought = evaluatePlan16Row({
    market: market(),
    forecast: forecastFor('2026-10-10', members(19, 30, 0)),
    yesBook: book(0.30, 0.34),
    noBook: book(0.64, 0.68),
    nowMs: NOW
  });
  assert.equal(bought.ok, true, bought.reason);
  assert.equal(bought.outcome, 'Yes');
  assert.equal(bought.city, 'Wellington');
  assert.ok(bought.edge >= 0.08);
  assert.equal(bought.members, 30);
  const mixed = [...members(19, 15, 0), ...members(20, 15, 0)];
  const tight = evaluatePlan16Row({
    market: market({ yes: 0.5 }),
    forecast: forecastFor('2026-10-10', mixed),
    yesBook: book(0.42, 0.46),
    noBook: book(0.50, 0.54),
    nowMs: NOW
  });
  assert.equal(tight.ok, false);
  assert.equal(tight.reason, 'edge_below_threshold');
});

test('hard-filters asks at or below 30c and still samples the mid band', () => {
  assert.equal(PLAN16_CONTROL_MIN_ASK, 0.08);
  assert.ok(plan16PaperMinAsk({ minAsk: 0.08 }) > 0.30);
  assert.equal(plan16PaperMinAsk({ minAsk: 0.08, blockLowTail: false }), 0.08);
  const tail = evaluatePlan16Row({
    market: market(),
    forecast: forecastFor('2026-10-10', members(19, 30, 0)),
    yesBook: book(0.28, 0.30),
    noBook: book(0.18, 0.22),
    nowMs: NOW
  });
  assert.equal(tail.reason, 'low_tail');
  const mid = evaluatePlan16Row({
    market: market(),
    forecast: forecastFor('2026-10-10', members(19, 30, 0)),
    yesBook: book(0.32, 0.34),
    noBook: book(0.64, 0.68),
    nowMs: NOW
  });
  assert.equal(mid.ok, true, mid.reason);
  assert.equal(mid.ask, 0.34);
});

test('skips unknown stations, late local afternoons and wide books', () => {
  assert.equal(stationFromDescription('site=NZWN').icao, 'nzwn');
  assert.equal(stationFromDescription('recorded by the Hong Kong Observatory').icao, 'hko');
  assert.equal(evaluatePlan16Row({
    market: market({ description: 'some other weather source' }),
    forecast: forecastFor('2026-10-10', members(19)),
    yesBook: book(0.3, 0.34),
    noBook: book(0.64, 0.68),
    nowMs: NOW
  }).reason, 'unknown_station');
  const afternoon = Date.parse('2026-10-10T06:00:00Z');
  assert.equal(evaluatePlan16Row({
    market: market(),
    forecast: forecastFor('2026-10-10', members(19), { offsetSeconds: 13 * 3600 }),
    yesBook: book(0.3, 0.34),
    noBook: book(0.64, 0.68),
    nowMs: afternoon
  }).reason, 'observation_started');
  assert.equal(evaluatePlan16Row({
    market: market(),
    forecast: forecastFor('2026-10-10', members(19)),
    yesBook: book(0.20, 0.40),
    noBook: book(0.55, 0.70),
    nowMs: NOW
  }).reason, 'edge_below_threshold');
});

test('one city-day keeps only the bucket with the larger edge', () => {
  const highs = members(19, 30, 0);
  const rows = [19, 20].map((degree) => ({
    market: market({
      question: `Will the highest temperature in Wellington be ${degree}°C on October 10?`,
      yes: degree === 19 ? 0.35 : 0.2
    }),
    forecast: forecastFor('2026-10-10', highs),
    yesBook: book(degree === 19 ? 0.3 : 0.16, degree === 19 ? 0.34 : 0.2),
    noBook: book(0.6, 0.66)
  }));
  rows[1].market.slug = 'wellington-20';
  const buys = selectPlan16Buys({ rows, nowMs: NOW, openGroupKeys: new Set() });
  assert.equal(buys.length, 1);
  assert.equal(buys[0].bucket.low, 19);
  const blocked = selectPlan16Buys({
    rows,
    nowMs: NOW,
    openGroupKeys: new Set(['nzwn|2026-10-10|high'])
  });
  assert.equal(blocked.length, 0);
});

test('ensemble payload uses member series and ignores the mean', () => {
  const daily = {
    time: ['2026-10-10'],
    temperature_2m_max: [99],
    temperature_2m_max_member01: [19.2],
    temperature_2m_max_member02: [18.4]
  };
  assert.deepEqual(memberSeries(daily, 'temperature_2m_max', 0), [19.2, 18.4]);
  const normalized = normalizeEnsemble({ utc_offset_seconds: 3600, daily });
  assert.equal(normalized.offsetSeconds, 3600);
  assert.deepEqual(normalized.days['2026-10-10'].max, [19.2, 18.4]);
});
