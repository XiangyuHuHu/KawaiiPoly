import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  resolvePolymarketWindowPrices,
  slotIsoFromTargetTime
} from '../src/chainlinkPrice.js';

const cachePath = join(process.cwd(), 'test', 'fixtures', 'chainlink-targets.json');

test('slotIsoFromTargetTime derives 5m slot start from window close', () => {
  assert.equal(
    slotIsoFromTargetTime('2026-07-07T09:10:00.000Z', '5m'),
    '2026-07-07T09:05:00.000Z'
  );
});

test('resolvePolymarketWindowPrices uses cached Chainlink slot boundaries', async () => {
  const outcome = await resolvePolymarketWindowPrices({
    symbol: 'BTC-USD',
    timeframe: '5m',
    slotIso: '2026-07-07T09:05:00.000Z',
    targetTimeIso: '2026-07-07T09:10:00.000Z',
    cachePath
  });

  assert.equal(outcome.priceSource, 'chainlink');
  assert.equal(outcome.startPrice, 63105.8);
  assert.equal(outcome.actualClose, 63111.28);
  assert.equal(outcome.actualDirection, 'up');
});
