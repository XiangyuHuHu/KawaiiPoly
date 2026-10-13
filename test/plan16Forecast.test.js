import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlan16Ensemble, clearPlan16ForecastCache, memberSeries } from '../src/plan16Forecast.js';

const payload = {
  utc_offset_seconds: 28800,
  daily: {
    time: ['2026-10-12'],
    temperature_2m_max_member01: [20], temperature_2m_min_member01: [10]
  }
};
const args = { latitude: 40.0799, longitude: 116.6031, nowMs: 1000 };
const good = () => ({ ok: true, json: async () => payload });

test('forecast retries with exponential backoff and switches model on fallback', async () => {
  clearPlan16ForecastCache();
  const urls = [], waits = [];
  const value = await fetchPlan16Ensemble({
    ...args, unit: 'F', sleepImpl: async (ms) => waits.push(ms),
    fetchImpl: async (url) => {
      urls.push(url);
      return urls.length < 3 ? { ok: false, status: 500 } : good();
    }
  });
  assert.deepEqual(waits, [250, 500]);
  assert.equal(urls[0].searchParams.get('models'), 'gfs_seamless');
  assert.equal(urls[1].searchParams.get('models'), 'gfs_seamless');
  assert.equal(urls[2].searchParams.get('models'), 'ecmwf_ifs025');
  assert.equal(urls[0].searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(urls[0].searchParams.get('timezone'), 'auto');
  assert.deepEqual(value.days['2026-10-12'].max, [20]);
});

test('forecast uses fresh cache, bounded last-good fallback, and never refreshes stale timestamp', async () => {
  clearPlan16ForecastCache();
  const value = await fetchPlan16Ensemble({ ...args, fetchImpl: async () => good() });
  const fail = async () => { throw new Error('offline'); };
  assert.equal(await fetchPlan16Ensemble({ ...args, fetchImpl: fail }), value);
  const retryArgs = { ...args, nowMs: 2000, cacheMs: 100, staleCacheMs: 5000, sleepImpl: async () => {}, fetchImpl: fail };
  assert.equal(await fetchPlan16Ensemble(retryArgs), value);
  await assert.rejects(fetchPlan16Ensemble({ ...retryArgs, nowMs: 6001 }), /offline/);
});

test('empty or null member data cannot replace a good forecast', async () => {
  clearPlan16ForecastCache();
  assert.deepEqual(memberSeries({ temperature_2m_max_member01: [null] }, 'temperature_2m_max', 0), []);
  await assert.rejects(fetchPlan16Ensemble({
    ...args, sleepImpl: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ daily: {} }) })
  }), /missing ensemble members/);
});
