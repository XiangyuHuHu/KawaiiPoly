import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  US_BTC_MISPRICE_MIN_MODEL,
  US_CASH_RESERVE_USD,
  US_LIVE_ENDGAME_V2_CASH_RESERVE_USD,
  US_LIVE_ENDGAME_V2_MAX_PRICE,
  US_LIVE_ENDGAME_V2_MIN_MODEL,
  US_DAILY_CAPS,
  US_LIVE_ANALYZE_CAPS,
  US_LIVE_ANALYZE_THRESHOLDS,
  US_LIVE_ENDGAME_DIVERGENCE,
  US_LIVE_ENDGAME_MAX_PRICE,
  US_LIVE_ENDGAME_MIN_MODEL,
  US_LIVE_OBSERVE_MIN_MODEL,
  US_SIZE_DEFAULT_USD,
  US_SOCCER_PAPER_MAX_PRICE,
  US_SOCCER_PAPER_MIN_MODEL
} from '../src/polymarketUs/constants.js';
import { endgameDivergenceGate, soccerFavoritePaper } from '../src/polymarketUs/liveGate.js';
import { classifyLivePhase } from '../src/polymarketUs/livePhase.js';
import { espnProbFromSummary, fetchPinnacleLive, PINNACLE_LIVE_SPORTS, pinnacleLiveLines } from '../src/polymarketUs/liveSources.js';
import {
  configureGatewayLimiter,
  isObservePaused,
  resetGatewayLimiter,
  withGatewaySlot
} from '../src/polymarketUs/gatewayLimit.js';
import { formatGrid, observationGrid } from '../src/polymarketUs/liveAnalyze.js';
import {
  appendLiveObservations,
  buildLiveObservationRows,
  outcomeFromUsMarket,
  quoteMap,
  rulePassForSide,
  runLiveObservations,
  settleLiveObservations
} from '../src/polymarketUs/liveObserve.js';
import { runUsScan } from '../src/polymarketUs/scan.js';
import { usPaths } from '../src/polymarketUs/signals.js';
import { US_RULES } from '../src/polymarketUs/rules.js';

const NOW = new Date('2026-10-19T20:10:00.000Z');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('BTC caps, cash reserve, and endgame floors stay put in v3.6', () => {
  assert.equal(US_BTC_MISPRICE_MIN_MODEL, 0.56);
  assert.equal(US_CASH_RESERVE_USD, 15);
  assert.equal(US_LIVE_ENDGAME_V2_MIN_MODEL, 0.70);
  assert.equal(US_LIVE_ENDGAME_V2_MAX_PRICE, 0.90);
  assert.equal(US_LIVE_ENDGAME_V2_CASH_RESERVE_USD, 14);
  assert.equal(US_DAILY_CAPS.btc_misprice, 8);
  assert.equal(US_DAILY_CAPS.live, 10);
  assert.equal(US_SIZE_DEFAULT_USD, 2);
  assert.equal(US_LIVE_ENDGAME_MIN_MODEL, 0.88);
  assert.equal(US_LIVE_ENDGAME_MAX_PRICE, 0.95);
  assert.equal(US_DAILY_CAPS.live_endgame_v2, 6);
  assert.equal(US_LIVE_ENDGAME_DIVERGENCE, 0.10);
  assert.equal(US_RULES.edge.liveEndgameMinModel, 0.88);
  assert.equal(US_RULES.edge.liveEndgameMaxPrice, 0.95);
  assert.equal(US_RULES.size.cashReserveUsd, 15);
  assert.equal(US_RULES.size.liveEndgameV2CashReserveUsd, 14);
  assert.equal(US_LIVE_OBSERVE_MIN_MODEL, 0.60);
  assert.equal(US_RULES.edge.liveObserveMinModel, 0.60);
  assert.equal(US_SOCCER_PAPER_MIN_MODEL, 0.80);
  assert.equal(US_SOCCER_PAPER_MAX_PRICE, 0.93);
  assert.deepEqual([...US_LIVE_ANALYZE_THRESHOLDS], [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.88, 0.90, 0.92, 0.95]);
  assert.deepEqual([...US_LIVE_ANALYZE_CAPS], [0.90, 0.93, 0.95, 0.99]);
});

test('observe_band marks model_prob at or above 0.60 without changing the trade path', () => {
  const at = rulePassForSide({ sport: 'nba', phase: 'mid', modelProb: 0.60, ask: 0.55 });
  assert.equal(at.observe_band, true);
  assert.equal(at.would_signal, false);
  assert.equal(at.would_signal_paper, false);
  const below = rulePassForSide({ sport: 'nba', phase: 'mid', modelProb: 0.599, ask: 0.55 });
  assert.equal(below.observe_band, false);
  const missing = rulePassForSide({ sport: 'nba', phase: 'mid', modelProb: null, ask: 0.55 });
  assert.equal(missing.observe_band, false);
});

test('divergence gate skips a one-sided gap and sizes $1 only when both sources are missing', () => {
  const under = endgameDivergenceGate({ modelProb: 0.96, ask: 0.86 });
  assert.equal(under.action, 'pass');
  assert.equal(under.reason, 'under_divergence');
  const agree = endgameDivergenceGate({
    modelProb: 0.96,
    ask: 0.83,
    espnProb: 0.90,
    pinnacleProb: 0.91,
    scoreAgeMs: 30_000
  });
  assert.equal(agree.action, 'pass');
  assert.equal(agree.reason, 'sources_agree');
  const one = endgameDivergenceGate({
    modelProb: 0.96,
    ask: 0.83,
    pinnacleProb: 0.96,
    scoreAgeMs: 10_000
  });
  assert.equal(one.action, 'skip');
  assert.match(one.reason, /espn_missing/);
  const stale = endgameDivergenceGate({
    modelProb: 0.96,
    ask: 0.83,
    espnProb: 0.94,
    pinnacleProb: 0.95,
    scoreSampledAt: new Date(NOW.getTime() - 120_000).toISOString(),
    now: NOW
  });
  assert.equal(stale.action, 'skip');
  assert.match(stale.reason, /score_stale/);
  const blind = endgameDivergenceGate({ modelProb: 0.96, ask: 0.83 });
  assert.equal(blind.action, 'micro');
  assert.equal(blind.sizeUsd, 1);
  const off = endgameDivergenceGate({
    modelProb: 0.96,
    ask: 0.83,
    rules: { edge: { ...US_RULES.edge, liveEndgameDivergenceEnabled: false } }
  });
  assert.equal(off.action, 'pass');
  assert.equal(off.reason, 'disabled');
});

test('phase buckets match the backtest endgame cuts', () => {
  assert.equal(classifyLivePhase({ sport: 'soccer', period: '2H', clock: '50', live: true }), 'mid');
  assert.equal(classifyLivePhase({ sport: 'soccer', period: 'HT', clock: '45', live: true }), 'early');
  assert.equal(classifyLivePhase({ sport: 'soccer', period: '2H', clock: "90+2'", live: true }), 'endgame');
  assert.equal(classifyLivePhase({ sport: 'soccer', period: '2H', clock: '70', live: true }), 'late');
  assert.equal(classifyLivePhase({ sport: 'nfl', period: 'Q4', clock: '2:10', live: true }), 'endgame');
  assert.equal(classifyLivePhase({ sport: 'cfb', period: '3rd', live: true }), 'late');
  assert.equal(classifyLivePhase({ sport: 'nba', period: 'Q1', live: true }), 'early');
  assert.equal(classifyLivePhase({ sport: 'nhl', period: '3rd', live: true }), 'endgame');
  assert.equal(classifyLivePhase({ sport: 'mlb', period: 'Top 7', live: true }), 'endgame');
  assert.equal(classifyLivePhase({ sport: 'mlb', period: '6th', live: true }), 'late');
  assert.equal(classifyLivePhase({ sport: 'soccer', period: 'NS', live: false }), 'pregame');
});

test('pinnacle de-vig and espn summary parse without a network call', () => {
  const lines = pinnacleLiveLines([
    {
      id: 10,
      childId: 11,
      home: 'Tottenham',
      away: 'Coventry City',
      sport: 'soccer',
      leagueName: 'Premier League'
    }
  ], [
    {
      matchupId: 11,
      type: 'moneyline',
      period: 0,
      status: 'open',
      prices: [
        { designation: 'home', price: -150 },
        { designation: 'away', price: 400 },
        { designation: 'draw', price: 280 }
      ]
    }
  ]);
  assert.equal(lines.length, 1);
  assert.ok(Math.abs(lines[0].homeProb + lines[0].awayProb + lines[0].drawProb - 1) < 1e-9);
  assert.ok(lines[0].homeProb > lines[0].awayProb);
  const fromList = espnProbFromSummary({
    winprobability: [{ homeWinPercentage: 0.4 }, { homeWinPercentage: 0.82, tiePercentage: 0.08 }]
  });
  assert.equal(fromList.homeProb, 0.82);
  assert.equal(fromList.drawProb, 0.08);
  const fromPredictor = espnProbFromSummary({
    predictor: { homeTeam: { gameProjection: '91.0' }, awayTeam: { gameProjection: '9.0' } }
  });
  assert.equal(fromPredictor.homeProb, 0.91);
});

function liveEvent({ minute = '50', marketSlug = 'atc-epl-tot-cov-2026-10-19-tot', team = 'Tottenham Hotspur' } = {}) {
  return {
    slug: 'epl-tot-cov-2026-10-19',
    seriesSlug: 'epl-2025',
    category: 'sports',
    live: true,
    ended: false,
    teams: [{ name: 'Tottenham Hotspur' }, { name: 'Coventry City' }],
    eventState: {
      type: 'soccer',
      period: '2H',
      elapsed: minute,
      score: '1-0',
      live: true,
      updatedAt: new Date(NOW.getTime() - 20_000).toISOString()
    },
    markets: [{
      slug: marketSlug,
      marketType: 'drawable_outcome',
      sportsMarketType: 'soccer_team_full_time_winner',
      marketSides: [{ long: true, description: 'Yes', team: { name: team } }]
    }, {
      slug: 'atc-epl-spread',
      marketType: 'spread',
      sportsMarketType: 'soccer_spread',
      marketSides: []
    }]
  };
}

test('observation rows cover both sides, paper soccer, and a divergent endgame without orders', async () => {
  const quotes = {
    'atc-epl-tot-cov-2026-10-19-tot': {
      bestAsk: 0.7,
      bestBid: 0.68,
      longAsk: 0.7,
      shortAsk: 0.32,
      askShares: 100,
      bidShares: 80
    },
    'aec-nfl-end': {
      bestAsk: 0.83,
      bestBid: 0.81,
      longAsk: 0.83,
      shortAsk: 0.19,
      askShares: 50,
      bidShares: 40
    }
  };
  const nfl = {
    slug: 'nfl-was-sf-2026-10-19',
    seriesSlug: 'nfl-2025',
    category: 'sports',
    live: true,
    teams: [{ name: 'San Francisco 49ers' }, { name: 'Washington Commanders' }],
    eventState: {
      type: 'football',
      period: 'Q4',
      elapsed: '2:10',
      score: '24-17',
      live: true,
      updatedAt: new Date(NOW.getTime() - 15_000).toISOString()
    },
    markets: [{
      slug: 'aec-nfl-end',
      marketType: 'moneyline',
      sportsMarketType: 'football_team_full_game_winner',
      marketSides: [{ long: true, team: { name: 'San Francisco 49ers' } }]
    }]
  };
  const quiet = {
    slug: 'nhl-no-model',
    seriesSlug: 'nhl-2025',
    category: 'sports',
    live: true,
    teams: [{ name: 'Seattle Kraken' }, { name: 'Vegas Golden Knights' }],
    eventState: { type: 'hockey', period: '1st', score: '0-0', live: true, updatedAt: NOW.toISOString() },
    markets: [{
      slug: 'aec-nhl-quiet',
      marketType: 'moneyline',
      sportsMarketType: 'hockey_team_full_game_winner',
      marketSides: [{ long: true, team: { name: 'Seattle Kraken' } }]
    }]
  };
  const rows = buildLiveObservationRows({
    events: [liveEvent(), nfl, quiet, { category: 'crypto', live: true, seriesSlug: 'btc-updown-1h', markets: [] }],
    quotesBySlug: quotes,
    pinnacleLines: [
      { home: 'Tottenham', away: 'Coventry City', homeProb: 0.82, awayProb: 0.1, drawProb: 0.08 },
      { home: 'San Francisco 49ers', away: 'Washington Commanders', homeProb: 0.96, awayProb: 0.04, drawProb: 0 }
    ],
    espnLines: [],
    pending: [{ id: 'live:atc-epl-tot-cov-2026-10-19-tot:yes', slug: 'atc-epl-tot-cov-2026-10-19-tot', side: 'Yes' }],
    now: NOW
  });
  const slugs = new Set(rows.map((row) => row.market_slug));
  assert.equal(slugs.has('atc-epl-spread'), false);
  assert.equal(slugs.has('aec-nhl-quiet'), true);
  const yes = rows.find((row) => row.market_slug.startsWith('atc-epl') && row.side === 'Yes');
  const no = rows.find((row) => row.market_slug.startsWith('atc-epl') && row.side === 'No');
  assert.equal(yes.model_src, 'pinnacle_devig');
  assert.equal(yes.model_prob, 0.82);
  assert.equal(yes.phase, 'mid');
  assert.equal(yes.ask, 0.7);
  assert.equal(yes.ask_depth, 70);
  assert.equal(yes.rule_pass.would_signal_paper, true);
  assert.equal(yes.rule_pass.would_signal, false);
  assert.equal(yes.rule_pass.observe_band, true);
  assert.equal(yes.signal_id, 'live:atc-epl-tot-cov-2026-10-19-tot:yes');
  assert.equal(no.model_prob, 0.18);
  assert.equal(no.rule_pass.observe_band, false);
  assert.equal(no.rule_pass.would_signal_paper, false);
  assert.equal(no.signal_id, null);
  const end = rows.find((row) => row.market_slug === 'aec-nfl-end' && row.side === 'Yes');
  assert.equal(end.phase, 'endgame');
  assert.equal(end.rule_pass.would_signal, false);
  assert.equal(end.rule_pass.observe_band, true);
  assert.equal(end.rule_pass.endgame.reason, 'espn_missing');
  const quietYes = rows.find((row) => row.market_slug === 'aec-nhl-quiet' && row.side === 'Yes');
  assert.equal(quietYes.model_prob, null);
  assert.equal(quietYes.model_src, 'none');
  assert.equal(quietYes.ask, null);
  assert.equal(quietYes.rule_pass.observe_band, false);
  assert.equal(soccerFavoritePaper({ sport: 'soccer', phase: 'endgame', pinnacleProb: 0.9, ask: 0.8 }).would_signal_paper, false);

  const root = await mkdtemp(join(tmpdir(), 'us-live-obs-'));
  try {
    const result = await runLiveObservations({
      now: NOW,
      ledgerRoot: root,
      quoteGapMs: 0,
      listEvents: async () => [liveEvent(), nfl],
      getBbo: async (slug) => quotes[slug] || null,
      loadSources: async () => ({
        pinnacle: [
          { home: 'Tottenham', away: 'Coventry City', homeProb: 0.82, awayProb: 0.1, drawProb: 0.08 }
        ],
        espn: [],
        errors: ['espn:timeout']
      })
    });
    assert.equal(result.appended, 4);
    assert.equal(result.errors.includes('espn:timeout'), true);
    const again = await runLiveObservations({
      now: NOW,
      ledgerRoot: root,
      quoteGapMs: 0,
      listEvents: async () => [liveEvent()],
      getBbo: async (slug) => quotes[slug] || null,
      loadSources: async () => ({ pinnacle: [], espn: [], errors: [] })
    });
    assert.equal(again.appended, 0);
    assert.equal(again.skippedDup, 2);
    const text = await readFile(usPaths(root).liveObservations, 'utf8');
    assert.equal(text.trim().split('\n').length, 4);
    await assert.rejects(readFile(join(root, 'signals', 'pending.jsonl'), 'utf8'));
    const blown = await runLiveObservations({
      now: NOW,
      ledgerRoot: root,
      listEvents: async () => {
        throw new Error('gateway down');
      },
      getBbo: async () => null,
      loadSources: async () => ({ pinnacle: [], espn: [], errors: [] })
    });
    assert.equal(blown.appended, 0);
    assert.match(blown.errors.join(' '), /gateway down/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('settle writes a separate file and the grid uses the first hit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'us-live-settle-'));
  try {
    const file = usPaths(root).liveObservations;
    await appendLiveObservations(file, [
      {
        ts_utc: '2026-10-17T18:00:00.000Z',
        market_slug: 'm-win',
        event_slug: 'g1',
        side: 'Yes',
        phase: 'endgame',
        model_prob: 0.9,
        ask: 0.8,
        sport: 'nfl'
      },
      {
        ts_utc: '2026-10-17T18:05:00.000Z',
        market_slug: 'm-win',
        event_slug: 'g1',
        side: 'Yes',
        phase: 'endgame',
        model_prob: 0.95,
        ask: 0.5,
        sport: 'nfl'
      },
      {
        ts_utc: '2026-10-17T18:00:00.000Z',
        market_slug: 'm-lose',
        event_slug: 'g2',
        side: 'Yes',
        phase: 'endgame',
        model_prob: 0.9,
        ask: 0.7,
        sport: 'soccer'
      }
    ]);
    const open = await settleLiveObservations({
      ledgerRoot: root,
      now: NOW,
      lookup: async () => ({ closed: false, marketSides: [{ long: true, price: '0.6' }] })
    });
    assert.equal(open.settled, 0);
    const closed = await settleLiveObservations({
      ledgerRoot: root,
      now: NOW,
      lookup: async (slug) => ({
        closed: true,
        marketSides: [{ long: true, price: slug === 'm-win' ? '1' : '0' }]
      })
    });
    assert.equal(closed.settled, 2);
    const repeat = await settleLiveObservations({
      ledgerRoot: root,
      now: NOW,
      lookup: async () => {
        throw new Error('should not refetch');
      }
    });
    assert.equal(repeat.settled, 0);
    assert.equal(outcomeFromUsMarket({ closed: true, marketSides: [{ long: true, price: '0.5' }] }).void, true);
    const observations = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const settlements = (await readFile(usPaths(root).liveObservationsSettled, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const grid = observationGrid(observations, settlements, {
      phase: 'endgame',
      thresholds: [0.88],
      caps: [0.95]
    });
    assert.equal(grid.length, 1);
    assert.equal(grid[0].n, 2);
    assert.equal(grid[0].hit, 0.5);
    const winPnl = (1 - 0.8) / 0.8;
    assert.ok(Math.abs(grid[0].pnl - (winPnl - 1)) < 1e-9);
    assert.match(formatGrid(grid), /0\.88 0\.95 2/);
    const defaults = observationGrid([], []);
    assert.deepEqual([...new Set(defaults.map((row) => row.threshold))], [...US_LIVE_ANALYZE_THRESHOLDS]);
    assert.deepEqual([...new Set(defaults.map((row) => row.cap))], [...US_LIVE_ANALYZE_CAPS]);
    const script = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        'scripts/analyze-live-observations.js',
        file,
        usPaths(root).liveObservationsSettled
      ], { cwd: repoRoot });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(script.code, 0);
    assert.match(script.out, /endgame/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failing live observer does not stop the scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'us-live-scan-'));
  try {
    const result = await runUsScan({
      now: NOW,
      ledgerRoot: root,
      workspaceRoot: root,
      loadWindow: async () => ({ market: null }),
      loadModels: async () => [],
      observeLive: async () => {
        throw new Error('pinnacle down');
      }
    });
    assert.equal(result.liveObservations.error, 'pinnacle down');
    assert.equal(result.published, 0);
    const logged = await runUsScan({
      now: new Date('2026-10-19T20:11:00.000Z'),
      ledgerRoot: root,
      workspaceRoot: root,
      loadWindow: async () => ({ market: null }),
      loadModels: async () => [],
      observeLive: async ({ ledgerRoot }) => runLiveObservations({
        now: new Date('2026-10-19T20:11:00.000Z'),
        ledgerRoot,
        listEvents: async () => [liveEvent({ minute: '80' })],
        getBbo: async () => ({ bestAsk: 0.9, bestBid: 0.88, longAsk: 0.9, shortAsk: 0.12, askShares: 10, bidShares: 10 }),
        loadSources: async () => ({ pinnacle: [], espn: [], errors: [] })
      })
    });
    assert.equal(logged.liveObservations.appended, 2);
    assert.equal(logged.published, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pinnacle 401 stays quiet and esports and cricket are not requested', async () => {
  assert.equal(PINNACLE_LIVE_SPORTS.some((sport) => sport.sport === 'esports' || sport.id === 12), false);
  assert.equal(PINNACLE_LIVE_SPORTS.some((sport) => sport.sport === 'cricket' || sport.id === 8), false);
  assert.equal(PINNACLE_LIVE_SPORTS.some((sport) => sport.sport === 'tennis'), true);
  const urls = [];
  const result = await fetchPinnacleLive({
    sports: [
      { id: 33, sport: 'tennis' },
      { id: 29, sport: 'soccer' }
    ],
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/sports/29/')) return { ok: false, status: 401 };
      return { ok: true, status: 200, json: async () => [] };
    }
  });
  assert.equal(result.lines.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(urls.some((url) => url.includes('/sports/12/') || url.includes('/sports/8/')), false);
});

test('429 on a BTC quote skips that market and still runs observation after the trade fetches', async () => {
  resetGatewayLimiter();
  configureGatewayLimiter({ tradeGapMs: 0, observeGapMs: 0, backoffMs: 0 });
  const root = await mkdtemp(join(tmpdir(), 'us-live-429-'));
  const calls = [];
  try {
    const result = await runUsScan({
      now: NOW,
      ledgerRoot: root,
      workspaceRoot: root,
      loadWindow: async ({ timeframe }) => {
        calls.push(timeframe);
        const error = new Error('Polymarket US GET /bbo 429: {"errors":[{"code":1015}]}');
        error.status = 429;
        error.payload = { errors: [{ code: 1015 }] };
        throw error;
      },
      loadModels: async () => [{
        sector: 'pregame',
        slug: 'pregame-soccer',
        side: 'Yes',
        model_prob: 0.7,
        resolution_risk: 'Low',
        confidence: 'High'
      }],
      refreshQuote: async (model) => {
        calls.push(`quote:${model.slug}`);
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      },
      observeLive: async () => {
        calls.push('observe');
        return { appended: 1, errors: [] };
      }
    });
    assert.equal(result.published, 0);
    assert.ok(result.skipped.includes('15m:rate-limit'));
    assert.ok(result.skipped.includes('1h:rate-limit'));
    assert.ok(result.skipped.includes('pregame:rate-limit'));
    assert.equal(calls.at(-1), 'observe');
    assert.ok(calls.indexOf('15m') < calls.indexOf('observe'));
    assert.equal(result.liveObservations.appended, 1);
    await assert.rejects(runUsScan({
      now: NOW,
      ledgerRoot: root,
      workspaceRoot: root,
      loadWindow: async () => {
        const error = new Error('boom');
        error.status = 500;
        throw error;
      },
      loadModels: async () => []
    }), /boom/);
  } finally {
    resetGatewayLimiter();
    await rm(root, { recursive: true, force: true });
  }
});

test('observation quotes reuse cached BBO, skip model none, and stop after 429', async () => {
  resetGatewayLimiter();
  configureGatewayLimiter({ backoffMs: 0, observeGapMs: 0, tradeGapMs: 0 });
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const mapped = await quoteMap(['cached', 'hot', 'later'], async (slug) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(slug);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    if (slug === 'hot') {
      const error = new Error('HTTP 429');
      error.status = 429;
      throw error;
    }
    return { bestAsk: 0.5 };
  }, { gapMs: 0, reused: { cached: { bestAsk: 0.42, longAsk: 0.42 } } });
  assert.deepEqual(calls, ['hot']);
  assert.equal(maxActive, 1);
  assert.equal(mapped.quotes.cached.bestAsk, 0.42);
  assert.equal(mapped.quotes.later, null);
  assert.equal(mapped.rateLimited, true);
  assert.equal(isObservePaused(), true);
  resetGatewayLimiter();

  const root = await mkdtemp(join(tmpdir(), 'us-live-quotes-'));
  try {
    const seen = [];
    const summary = await runLiveObservations({
      now: new Date('2026-10-19T21:12:00.000Z'),
      ledgerRoot: root,
      quoteGapMs: 0,
      quoteCache: {
        'atc-epl-tot-cov-2026-10-19-tot': {
          bestAsk: 0.7,
          bestBid: 0.68,
          longAsk: 0.7,
          shortAsk: 0.32,
          askShares: 100,
          bidShares: 80
        }
      },
      listEvents: async () => [
        liveEvent(),
        {
          slug: 'nfl-was-sf-2026-10-19',
          seriesSlug: 'nfl-2025',
          category: 'sports',
          live: true,
          teams: [{ name: 'San Francisco 49ers' }, { name: 'Washington Commanders' }],
          eventState: { type: 'football', period: 'Q4', elapsed: '2:10', score: '24-17', live: true, updatedAt: NOW.toISOString() },
          markets: [{
            slug: 'aec-nfl-end',
            marketType: 'moneyline',
            sportsMarketType: 'football_team_full_game_winner',
            marketSides: [{ long: true, team: { name: 'San Francisco 49ers' } }]
          }]
        },
        {
          slug: 'nhl-no-model',
          seriesSlug: 'nhl-2025',
          category: 'sports',
          live: true,
          teams: [{ name: 'Seattle Kraken' }, { name: 'Vegas Golden Knights' }],
          eventState: { type: 'hockey', period: '1st', score: '0-0', live: true, updatedAt: NOW.toISOString() },
          markets: [{
            slug: 'aec-nhl-quiet',
            marketType: 'moneyline',
            sportsMarketType: 'hockey_team_full_game_winner',
            marketSides: [{ long: true, team: { name: 'Seattle Kraken' } }]
          }]
        }
      ],
      getBbo: async (slug) => {
        seen.push(slug);
        const error = new Error('429');
        error.status = 429;
        throw error;
      },
      loadSources: async () => ({
        pinnacle: [
          { home: 'Tottenham', away: 'Coventry City', homeProb: 0.82, awayProb: 0.1, drawProb: 0.08 },
          { home: 'San Francisco 49ers', away: 'Washington Commanders', homeProb: 0.96, awayProb: 0.04, drawProb: 0 }
        ],
        espn: [],
        errors: []
      })
    });
    assert.deepEqual(seen, ['aec-nfl-end']);
    assert.equal(summary.appended, 6);
    const lines = (await readFile(usPaths(root).liveObservations, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const soccer = lines.find((row) => row.market_slug.startsWith('atc-epl') && row.side === 'Yes');
    const quiet = lines.find((row) => row.market_slug === 'aec-nhl-quiet' && row.side === 'Yes');
    assert.equal(soccer.ask, 0.7);
    assert.equal(soccer.model_src, 'pinnacle_devig');
    assert.equal(quiet.model_src, 'none');
    assert.equal(quiet.ask, null);
    assert.equal(quiet.rule_pass.observe_band, false);
  } finally {
    resetGatewayLimiter();
    await rm(root, { recursive: true, force: true });
  }
});

test('trade quotes keep priority and observation quotes do not fire after a 429', async () => {
  resetGatewayLimiter();
  configureGatewayLimiter({ tradeGapMs: 0, observeGapMs: 0, backoffMs: 0 });
  try {
    const order = [];
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = withGatewaySlot(async () => {
      order.push('first');
      await hold;
    }, { lane: 'trade' });
    const observe = withGatewaySlot(async () => {
      order.push('observe');
    }, { lane: 'observe' });
    const trade = withGatewaySlot(async () => {
      order.push('trade');
    }, { lane: 'trade' });
    release();
    await Promise.all([first, observe, trade]);
    assert.deepEqual(order, ['first', 'trade', 'observe']);

    let calls = 0;
    await assert.rejects(withGatewaySlot(async () => {
      calls += 1;
      const error = new Error('429');
      error.status = 429;
      throw error;
    }, { lane: 'trade' }));
    await assert.rejects(withGatewaySlot(async () => {
      calls += 1;
      return 'should-not-run';
    }, { lane: 'observe' }), (error) => error.code === 'RATE_LIMITED' && calls === 1);
    const traded = await withGatewaySlot(async () => {
      calls += 1;
      return 'ok';
    }, { lane: 'trade' });
    assert.equal(traded, 'ok');
    assert.equal(calls, 2);
  } finally {
    resetGatewayLimiter();
  }
});

test('endgame v2 marks rule_pass and publishes a one-dollar signal without placing', async () => {
  const at = rulePassForSide({
    sport: 'nfl',
    phase: 'endgame',
    modelProb: 0.70,
    ask: 0.90,
    pinnacleProb: 0.70,
    espnProb: 0.70,
    scoreAgeMs: 1000
  });
  assert.equal(at.endgame_v2.pass, true);
  assert.equal(at.would_signal, false);
  const below = rulePassForSide({ sport: 'nfl', phase: 'endgame', modelProb: 0.699, ask: 0.8, pinnacleProb: 0.699 });
  assert.equal(below.endgame_v2.pass, false);
  assert.equal(below.endgame_v2.reason, 'model_floor');
  const early = rulePassForSide({ sport: 'soccer', phase: 'mid', modelProb: 0.82, ask: 0.7, pinnacleProb: 0.82 });
  assert.equal(early.endgame_v2.reason, 'not_endgame');
  const gap = rulePassForSide({
    sport: 'nfl',
    phase: 'endgame',
    modelProb: 0.96,
    ask: 0.83,
    pinnacleProb: 0.96,
    scoreAgeMs: 1000
  });
  assert.equal(gap.endgame_v2.pass, false);
  assert.equal(gap.would_signal, false);

  const root = await mkdtemp(join(tmpdir(), 'us-live-v2-'));
  try {
    const summary = await runLiveObservations({
      now: new Date('2026-10-19T21:40:00.000Z'),
      ledgerRoot: root,
      quoteGapMs: 0,
      listEvents: async () => [liveEvent({ minute: '80' })],
      getBbo: async () => ({
        bestAsk: 0.8,
        bestBid: 0.78,
        longAsk: 0.8,
        shortAsk: 0.22,
        askShares: 20,
        bidShares: 20,
        cacheAgeMs: 0
      }),
      loadSources: async () => ({
        pinnacle: [{ home: 'Tottenham', away: 'Coventry City', homeProb: 0.78, awayProb: 0.12, drawProb: 0.1 }],
        espn: [],
        errors: []
      })
    });
    assert.equal(summary.signals.published, 1);
    const pending = (await readFile(usPaths(root).pending, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sector, 'live_endgame_v2');
    assert.equal(pending[0].size_usd, 1);
    assert.equal(pending[0].side, 'Yes');
    assert.equal(pending[0].model_prob, 0.78);
    assert.equal(pending[0].auto_order.scanner_places_orders, false);
    const logged = JSON.parse((await readFile(usPaths(root).liveObservations, 'utf8')).trim().split('\n')[0]);
    assert.equal(logged.rule_pass.endgame_v2.pass, true);
    assert.equal(logged.rule_pass.would_signal, false);
    assert.equal(logged.signal_id, pending[0].id);
    await assert.rejects(readFile(usPaths(root).realOrders, 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
