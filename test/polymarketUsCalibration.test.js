import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blendModelToMarket,
  evaluateSectorBrakes,
  marketProbability,
  syncSectorBrakes
} from '../src/polymarketUs/calibration.js';
import { buildPolymarketUsConfig } from '../src/polymarketUs/config.js';
import { runPolymarketUsCycle } from '../src/polymarketUs/runner.js';
import { writeFile, mkdir } from 'node:fs/promises';

const NOW = new Date('2026-10-14T15:37:00.000Z');

function loss(index, sector = 'weather', pnl = -2) {
  return {
    id: `ord-${index}`,
    signal_id: `sig-${index}`,
    sector,
    slug: `mkt-${index}`,
    side: 'Yes',
    dry_run: false,
    won: pnl > 0,
    pnl_usd: pnl,
    size_usd: 2,
    limit_price: 0.4,
    entry: 0.4,
    model_p: 0.55,
    market_p: 0.4,
    p_used: 0.55,
    time_utc: new Date(NOW.getTime() - (30 - index) * 3_600_000).toISOString(),
    settled_at: new Date(NOW.getTime() - (20 - index) * 3_600_000).toISOString(),
    fill_status: 'filled'
  };
}

test('BTC misprice shrinks halfway to the market mid', () => {
  const market = marketProbability({ side: 'Up', ask: 0.4, bid: 0.39 });
  const blend = blendModelToMarket(0.52, market);
  assert.equal(market, 0.395);
  assert.equal(blend.pUsed, 0.4575);
  const down = marketProbability({
    side: 'Down',
    quote: { bestBid: 0.68, bestAsk: 0.69 }
  });
  assert.ok(Math.abs(down - 0.315) < 1e-12);
});

test('sector brake needs 10 settled trades, a sub-35% win rate, and negative P&L', () => {
  const nine = Array.from({ length: 9 }, (_, index) => loss(index));
  assert.equal(evaluateSectorBrakes(nine, { sectors: {} }, NOW).events.length, 0);

  const poor = [
    ...Array.from({ length: 7 }, (_, index) => loss(index, 'btc_misprice', -2)),
    ...Array.from({ length: 3 }, (_, index) => loss(index + 7, 'btc_misprice', 3))
  ];
  const tripped = evaluateSectorBrakes(poor, { sectors: {} }, NOW);
  assert.equal(tripped.paused.btc_misprice.wins, 3);
  assert.equal(tripped.paused.btc_misprice.pnlUsd, -5);
  assert.equal(tripped.events[0].event, 'pause');
  assert.equal(
    tripped.paused.btc_misprice.pausedUntil,
    new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString()
  );

  const held = evaluateSectorBrakes(poor, { sectors: tripped.sectors }, new Date(NOW.getTime() + 60_000));
  assert.equal(held.events.length, 0);
  assert.equal(held.paused.btc_misprice.pausedUntil, tripped.paused.btc_misprice.pausedUntil);

  const fourWins = [
    ...Array.from({ length: 6 }, (_, index) => loss(index, 'macro', -2)),
    ...Array.from({ length: 4 }, (_, index) => loss(index + 6, 'macro', 1))
  ];
  assert.equal(evaluateSectorBrakes(fourWins, { sectors: {} }, NOW).paused.macro, undefined);

  const profitable = Array.from({ length: 10 }, (_, index) => loss(index, 'crypto', index < 7 ? -1 : 5));
  assert.equal(evaluateSectorBrakes(profitable, { sectors: {} }, NOW).paused.crypto, undefined);

  const again = evaluateSectorBrakes(poor, { sectors: tripped.sectors }, new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1));
  assert.equal(again.events[0].event, 'pause');
  assert.notEqual(again.paused.btc_misprice.pausedUntil, tripped.paused.btc_misprice.pausedUntil);
});

test('a tripped sector defers new orders and the signal stays pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'us-brake-'));
  const workspace = await mkdtemp(join(tmpdir(), 'us-brake-ws-'));
  await mkdir(join(dir, 'signals'), { recursive: true });
  const orders = Array.from({ length: 10 }, (_, index) => loss(index));
  await writeFile(join(dir, 'real-orders.jsonl'), `${orders.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(join(dir, 'signals', 'pending.jsonl'), `${JSON.stringify({
    id: 'sig-weather-brake',
    sector: 'weather',
    slug: 'nyc-high-72',
    side: 'Yes',
    limit_price: 0.4,
    model_prob: 0.5,
    ask: 0.4,
    spread_cents: 1,
    liquidity_usd: 80,
    bbo_at: NOW.toISOString(),
    confidence: 'High',
    resolution_risk: 'Low',
    status: 'pending'
  })}\n`);
  const config = buildPolymarketUsConfig({
    POLYMARKET_US_LEDGER_DIR: dir,
    POLYMARKET_US_WORKSPACE_DIR: workspace
  });
  config.ledgerDir = dir;
  config.workspaceDir = workspace;
  const report = await runPolymarketUsCycle({ config, now: NOW, fetchQuotes: false });
  assert.equal(report.results[0].code, 'sector_brake');
  assert.equal(report.placed, 0);
  assert.match(report.results[0].reason, /暂停新单/);
  const pending = JSON.parse((await readFile(join(dir, 'signals', 'pending.jsonl'), 'utf8')).trim());
  assert.equal(pending.status, 'pending');
  const state = JSON.parse(await readFile(join(dir, 'status', 'sector-brakes.json'), 'utf8'));
  assert.equal(state.sectors.weather.wins, 0);
  const log = await readFile(join(dir, 'status', 'sector-brakes.jsonl'), 'utf8');
  assert.match(log, /"event":"pause"/);
  const again = await syncSectorBrakes(dir, new Date(NOW.getTime() + 60_000));
  assert.equal(again.events.length, 0);
  assert.equal(again.paused.weather.pausedUntil, state.sectors.weather.pausedUntil);
});
