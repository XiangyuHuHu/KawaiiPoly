import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { PolymarketUS } from 'polymarket-us';
import { PolymarketClient } from '../src/polymarketClient.js';
import { createUsAuthHeaders } from '../src/polymarketUs/auth.js';
import { buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import { PolymarketUsGateway } from '../src/polymarketUs/gateway.js';
import { createPolymarketUsSdk, createUsTradingClient, polymarketUsSdkOptions } from '../src/polymarketUs/sdk.js';
import { PolymarketUsTradingClient, summarizeUsAccount, windowsFromOpenOrders, windowsFromPositions } from '../src/polymarketUs/trading.js';
import { getConfig } from '../src/config.js';

function secretKey() {
  const seed = new Uint8Array(32).fill(9);
  return {
    secret: Buffer.from(seed).toString('base64'),
    publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey
  };
}

function mockFetch(handler) {
  return async (url, init) => {
    const payload = handler(url, init);
    return new Response(JSON.stringify(payload.body), {
      status: payload.status || 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

test('Ed25519 signature covers timestamp + method + pathname only', () => {
  const keys = secretKey();
  const headers = createUsAuthHeaders({
    accessKey: 'access-key',
    secretKey: keys.secret,
    method: 'post',
    path: '/v1/orders',
    timestamp: 1700000000000
  });
  assert.equal(headers['X-PM-Access-Key'], 'access-key');
  assert.equal(headers['X-PM-Timestamp'], '1700000000000');
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode('1700000000000POST/v1/orders'),
    Buffer.from(headers['X-PM-Signature'], 'base64'),
    keys.publicKey
  );
  assert.equal(ok, true);
});

test('gateway reads markets, bbo, and book without leaving polymarket.us', async () => {
  const calls = [];
  const gateway = new PolymarketUsGateway({
    fetchImpl: mockFetch((url) => {
      calls.push(String(url));
      if (String(url).endsWith('/bbo')) {
        return { body: { bestBid: { value: '0.40', currency: 'USD' }, bestAsk: { value: '0.42', currency: 'USD' }, askShares: '100' } };
      }
      if (String(url).endsWith('/book')) {
        return { body: { bids: [{ px: { value: '0.40' }, qty: '10' }], offers: [{ px: { value: '0.42' }, qty: '12' }] } };
      }
      return { body: { markets: [{ slug: 'nyc-high-72', title: 'NYC high', closed: false }] } };
    })
  });
  const markets = await gateway.listMarkets({ endDateMin: '2026-10-14', limit: 10, closed: false });
  const bbo = await gateway.getBbo('nyc-high-72');
  const book = await gateway.getBook('nyc-high-72');
  assert.equal(markets[0].slug, 'nyc-high-72');
  assert.equal(bbo.bestAsk, 0.42);
  assert.equal(bbo.spread, 0.02);
  assert.equal(book.asks[0].shares, 12);
  assert.ok(calls.every((url) => url.startsWith('https://gateway.polymarket.us/')));
  assert.ok(calls[0].includes('endDateMin=2026-10-14'));
  assert.ok(calls[0].includes('closed=false'));
});

test('create order posts the limit payload to api.polymarket.us and signs the path', async () => {
  const keys = secretKey();
  const calls = [];
  const client = new PolymarketUsTradingClient({
    accessKey: 'access-key',
    secretKey: keys.secret,
    now: () => 1700000000000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'ord-1' }), { status: 200 });
    }
  });
  const body = {
    marketSlug: 'nyc-high-72',
    intent: 'ORDER_INTENT_BUY_LONG',
    type: 'ORDER_TYPE_LIMIT',
    price: { value: '0.40', currency: 'USD' },
    quantity: 5,
    tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
    manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC'
  };
  const created = await client.createOrder(body);
  assert.equal(created.id, 'ord-1');
  assert.equal(calls[0].url, 'https://api.polymarket.us/v1/orders');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
  const headers = calls[0].init.headers;
  assert.equal(headers['X-PM-Access-Key'], 'access-key');
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode('1700000000000POST/v1/orders'),
    Buffer.from(headers['X-PM-Signature'], 'base64'),
    keys.publicKey
  );
  assert.equal(ok, true);

  await client.listOpenOrders({ marketSlug: 'nyc-high-72' });
  const listed = calls[1];
  assert.equal(listed.url, 'https://api.polymarket.us/v1/orders/open?marketSlug=nyc-high-72');
  const listOk = nacl.sign.detached.verify(
    new TextEncoder().encode('1700000000000GET/v1/orders/open'),
    Buffer.from(listed.init.headers['X-PM-Signature'], 'base64'),
    keys.publicKey
  );
  assert.equal(listOk, true);
  assert.ok(calls.every((call) => !String(call.url).includes('clob.polymarket.com')));
  assert.ok(calls.every((call) => !String(call.url).includes('gamma-api.polymarket.com')));
});

test('US client refuses international hosts and the CLOB client refuses the US gateway', async () => {
  const gateway = new PolymarketUsGateway({ gatewayBaseUrl: 'https://gamma-api.polymarket.com' });
  await assert.rejects(() => gateway.listMarkets(), /国际盘/);
  assert.throws(
    () => new PolymarketClient({ gammaBaseUrl: 'https://gateway.polymarket.us' }),
    /美国盘/
  );
});

test('SDK 0.1.1 is constructed with keyId and secretKey from the US env names', () => {
  const ignored = buildPolymarketUsConfig({
    POLYMARKET_API_KEY: 'intl-clob-key',
    POLYMARKET_API_SECRET: 'intl-secret'
  });
  assert.equal(ignored.credentialsConfigured, false);
  assert.equal(ignored.accessKey, '');
  assert.equal(polymarketUsSdkOptions({ apiKey: 'not-the-us-key' }).keyId, '');

  const secret = Buffer.from(new Uint8Array(32).fill(4)).toString('base64');
  const config = buildPolymarketUsConfig({
    POLYMARKET_US_ACCESS_KEY: '11111111-1111-4111-8111-111111111111',
    POLYMARKET_US_SECRET_KEY: secret,
    POLYMARKET_US_LIVE_TRADING_ENABLED: 'true',
    POLYMARKET_US_DRY_RUN: 'false'
  });
  const options = polymarketUsSdkOptions(config);
  assert.equal(options.keyId, '11111111-1111-4111-8111-111111111111');
  assert.equal(options.secretKey, secret);
  assert.equal(Object.hasOwn(options, 'apiKey'), false);

  const sdk = createPolymarketUsSdk(config);
  assert.ok(sdk instanceof PolymarketUS);
  assert.equal(sdk.keyId, options.keyId);
  assert.equal(sdk.apiBaseUrl, 'https://api.polymarket.us');
  assert.equal(sdk.gatewayBaseUrl, 'https://gateway.polymarket.us');

  const live = createUsTradingClient(config);
  assert.equal(live.transport, 'polymarket-us@0.1.1');
  const dry = createUsTradingClient(buildPolymarketUsConfig({
    POLYMARKET_US_ACCESS_KEY: options.keyId,
    POLYMARKET_US_SECRET_KEY: secret
  }));
  assert.equal(dry.transport, undefined);
  assert.equal(dry instanceof PolymarketUsTradingClient, true);
});

test('read-only account shape uses buyingPower and slug-keyed positions', () => {
  const account = summarizeUsAccount(
    { balances: [{ currency: 'USD', buyingPower: 41.91, currentBalance: 65.73 }] },
    { orders: [] },
    { positions: { 'btc-up-15m': { netPosition: '0' }, 'nyc-high-72': { netPosition: '3' } } }
  );
  assert.equal(account.buyingPower, 41.91);
  assert.equal(account.currentBalance, 65.73);
  assert.equal(account.openOrderCount, 0);
  assert.deepEqual(account.positionSlugs, ['btc-up-15m', 'nyc-high-72']);
  assert.deepEqual(windowsFromPositions({ positions: { 'nyc-high-72': { netPosition: '3' } } }), [
    { slug: 'nyc-high-72', windowId: 'nyc-high-72', side: 'yes' }
  ]);
  assert.deepEqual(windowsFromOpenOrders({
    orders: [{ marketSlug: 'btc-down-15m', intent: 'ORDER_INTENT_BUY_SHORT' }]
  }), [
    { slug: 'btc-down-15m', windowId: 'btc-down-15m', side: 'no' }
  ]);
});

test('app config keeps intl CLOB and US gateway on separate lines', () => {
  const config = getConfig();
  assert.equal(config.polymarket.gammaBaseUrl.includes('gamma-api.polymarket.com') || config.polymarket.gammaBaseUrl.includes('polymarket.com'), true);
  assert.equal(config.polymarketUs.line, 'polymarket_us');
  assert.match(config.polymarketUs.gatewayBaseUrl, /gateway\.polymarket\.us|polymarket\.us/);
  assert.match(config.polymarketUs.apiBaseUrl, /api\.polymarket\.us/);
  assert.equal(config.polymarketUs.gatewayBaseUrl.includes('gamma-api'), false);
  assert.equal(config.polymarketUs.apiBaseUrl.includes('clob.polymarket.com'), false);
});
