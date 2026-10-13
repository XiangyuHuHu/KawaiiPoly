import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMarketSignalCachePolicy,
  shouldReuseCachedMarketSignal
} from '../src/marketSignalCachePolicy.js';

test('resolveMarketSignalCachePolicy defaults to 4s reuse for Plan1/UI', () => {
  const policy = resolveMarketSignalCachePolicy();
  assert.equal(policy.bypassCache, false);
  assert.equal(policy.maxAgeMs, 4000);
});

test('resolveMarketSignalCachePolicy bypassCache isolates Plan4/Plan9 ticks', () => {
  assert.equal(resolveMarketSignalCachePolicy({ bypassCache: true }).bypassCache, true);
  assert.equal(resolveMarketSignalCachePolicy({ preferFresh: true }).bypassCache, true);
});

test('shouldReuseCachedMarketSignal respects TTL and bypass', () => {
  const entry = { at: 1_000, payload: { ok: true } };
  assert.equal(shouldReuseCachedMarketSignal(entry, {
    nowMs: 3_000,
    maxAgeMs: 4_000,
    bypassCache: false,
    slotMatches: true
  }), true);
  assert.equal(shouldReuseCachedMarketSignal(entry, {
    nowMs: 6_000,
    maxAgeMs: 4_000,
    bypassCache: false,
    slotMatches: true
  }), false);
  assert.equal(shouldReuseCachedMarketSignal(entry, {
    nowMs: 3_000,
    maxAgeMs: 4_000,
    bypassCache: true,
    slotMatches: true
  }), false);
  assert.equal(shouldReuseCachedMarketSignal(entry, {
    nowMs: 3_000,
    maxAgeMs: 4_000,
    bypassCache: false,
    slotMatches: false
  }), false);
});
