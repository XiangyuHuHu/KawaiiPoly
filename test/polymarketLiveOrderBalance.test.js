import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertClobBuyBalanceSufficient,
  resolveEffectiveClobBuyBalance
} from '../src/polymarketLiveOrder.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';

test('resolveEffectiveClobBuyBalance prefers fresh positive CLOB balance', () => {
  const info = resolveEffectiveClobBuyBalance({
    readiness: { clob: { ok: true, collateral: { balanceUsdc: 68.2 }, openOrdersCount: 0 } },
    knownClobBalanceUsdc: 12,
    tradingService: {
      resolveLiveCashBalance: () => ({ cash: 99, source: 'cached-last-valid' })
    }
  });
  assert.equal(info.balanceUsdc, 68.2);
  assert.equal(info.source, 'fresh');
});

test('resolveEffectiveClobBuyBalance falls back to known when fresh is zero', () => {
  const info = resolveEffectiveClobBuyBalance({
    readiness: { clob: { ok: true, collateral: { balanceUsdc: 0 }, openOrdersCount: 0 } },
    knownClobBalanceUsdc: 80.5
  });
  assert.equal(info.balanceUsdc, 80.5);
  assert.equal(info.source, 'known');
  assert.equal(info.freshZero, true);
});

test('resolveEffectiveClobBuyBalance falls back to lastValid via tradingService', () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-live-order-balance.json'
  });
  service.state.liveControl = {
    enabled: true,
    currentBalanceUsdc: 0,
    lastValidBalanceUsdc: 79.12
  };
  const info = resolveEffectiveClobBuyBalance({
    readiness: { clob: { ok: true, collateral: { balanceUsdc: 0 }, openOrdersCount: 0 } },
    knownClobBalanceUsdc: 0,
    tradingService: service
  });
  assert.equal(info.balanceUsdc, 79.12);
  assert.equal(info.source, 'cached-last-valid');
});

test('assertClobBuyBalanceSufficient allows buy when fallback covers request', () => {
  assert.doesNotThrow(() => assertClobBuyBalanceSufficient(5.6, {
    balanceUsdc: 68,
    source: 'known',
    freshZero: true,
    openOrdersCount: 0
  }));
});

test('assertClobBuyBalanceSufficient reports unknown instead of hard $0 account', () => {
  assert.throws(
    () => assertClobBuyBalanceSufficient(5.6, {
      balanceUsdc: 0,
      source: 'fresh-zero',
      openOrdersCount: 0
    }),
    /余额未知/
  );
});

test('assertClobBuyBalanceSufficient reports open-order lock when available is zero', () => {
  assert.throws(
    () => assertClobBuyBalanceSufficient(5.6, {
      balanceUsdc: 0,
      source: 'fresh-zero',
      openOrdersCount: 3
    }),
    /未成交挂单占用/
  );
});

test('updateLiveControlBalance ignores transient zero and keeps last good balance', async () => {
  const service = new PolymarketTradingService({
    config: {},
    statePath: 'data/test-polymarket-live-control-zero-guard.json'
  });
  service.state.liveControl = {
    enabled: true,
    currentBalanceUsdc: 68.21,
    lastValidBalanceUsdc: 68.21,
    balanceUpdatedAtIso: new Date().toISOString()
  };
  const status = await service.updateLiveControlBalance(0);
  assert.equal(status.currentBalanceUsdc, 68.21);
  assert.equal(service.state.liveControl.currentBalanceUsdc, 68.21);
  assert.equal(service.state.liveControl.lastValidBalanceUsdc, 68.21);
});
