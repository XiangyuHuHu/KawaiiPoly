import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicMarketDataClient } from '../src/publicMarketData.js';

test('PublicMarketDataClient maps XRP-USD to XRPUSDT', () => {
  const client = new PublicMarketDataClient();
  assert.equal(client.toBinancePair('XRP-USD'), 'XRPUSDT');
  assert.equal(client.toBinancePair('BTC-USD'), 'BTCUSDT');
  assert.equal(client.toBinancePair('ETH-USD'), 'ETHUSDT');
  assert.equal(client.toBinancePair('SOL-USD'), 'SOLUSDT');
});

test('PublicMarketDataClient rejects unknown symbols', () => {
  const client = new PublicMarketDataClient();
  assert.throws(() => client.toBinancePair('ADA-USD'), /Unsupported symbol/);
});

test('PublicMarketDataClient isolates restricted cooldown per mirror', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).startsWith('https://two.example')) {
      return new Response(JSON.stringify([[1, '1', '2', '0.5', '1.5']]), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      code: 0,
      msg: "Service unavailable from a restricted location according to 'b. Eligibility'"
    }), { status: 451, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new PublicMarketDataClient({
    baseUrls: ['https://one.example', 'https://two.example'],
    restrictedCooldownMs: 60_000
  });
  const first = await client.getCandles('BTC-USD', '5m', 2);
  const second = await client.getCandles('ETH-USD', '5m', 2);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  // First request tries both mirrors; the second request skips only the
  // restricted mirror and continues using the healthy one.
  assert.equal(calls, 3);
});
