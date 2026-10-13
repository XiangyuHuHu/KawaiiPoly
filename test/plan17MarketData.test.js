import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPlan17Dvol } from '../src/plan17MarketData.js';

const NOW = 1791648000000;
const payload = (timestamp = NOW, iv = 45) => ({ result: { data: [[timestamp, 44, 46, 43, iv]] } });
const response = (body) => ({ ok: true, json: async () => body });

test('DVOL fetch validates source timestamps and values for BTC and ETH', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let body = payload();
  t.mock.method(globalThis, 'fetch', async () => response(body));
  for (const coin of ['BTC', 'ETH']) {
    assert.deepEqual(await fetchPlan17Dvol(coin, NOW), { iv: 45, ivTimestampMs: NOW });
    for (const [timestamp, iv, reason] of [
      [NOW - 300001, 45, 'iv_stale'], [undefined, 45, 'iv_timestamp_invalid'],
      [null, 45, 'iv_timestamp_invalid'], [NOW + 1, 45, 'iv_timestamp_invalid'],
      [NOW, 0, 'iv_missing'], [NOW, Infinity, 'iv_missing']
    ]) {
      body = { result: { data: [[timestamp, 44, 46, 43, iv]] } };
      await assert.rejects(fetchPlan17Dvol(coin, NOW), { reason });
    }
    body = payload(NOW - 300000);
    assert.equal((await fetchPlan17Dvol(coin, NOW)).iv, 45);
    await assert.rejects(fetchPlan17Dvol(coin, NOW, { maxIvAgeMs: 1000 }), { reason: 'iv_stale' });
    body = { result: { data: [] } };
    await assert.rejects(fetchPlan17Dvol(coin, NOW), { reason: 'iv_missing' });
    body = payload();
  }
});

test('Deribit retries errors with bounded exponential backoff and never uses previous IV', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let calls = 0;
  let failure = null;
  const delays = [];
  const options = { sleep: async (ms) => delays.push(ms) };
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (failure === 'network') throw new Error('network failed');
    if (failure === 'json') return { ok: true, json: async () => { throw new SyntaxError('bad JSON'); } };
    if (failure === 'rpc') return response({ error: { message: 'unavailable' }, ...payload() });
    if (failure === '503') return { ok: false, status: 503 };
    if (failure === 'recover' && calls < 3) return { ok: false, status: 503 };
    return response(payload());
  });
  await fetchPlan17Dvol('BTC', NOW, options);
  for (failure of ['503', 'network', 'json', 'rpc']) {
    calls = 0; delays.length = 0;
    await assert.rejects(fetchPlan17Dvol('BTC', NOW, options), { reason: 'iv_unavailable' });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [250, 500]);
  }
  failure = 'recover'; calls = 0; delays.length = 0;
  assert.equal((await fetchPlan17Dvol('BTC', NOW, options)).iv, 45);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});
