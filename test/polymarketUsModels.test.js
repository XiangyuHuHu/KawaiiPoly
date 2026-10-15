import test from 'node:test';
import assert from 'node:assert/strict';
import {
  americanToImplied,
  devig,
  gbmTouchProb,
  lognormalAboveProb,
  normalCdf,
  teamsMatch,
  upperBoundFromEffr,
  yesQuote
} from '../src/polymarketUs/models/math.js';
import { pinnacleMoneylines, pregameRowsFromBooks } from '../src/polymarketUs/models/pregame.js';
import {
  parseWeatherContract,
  probabilityFromSamples,
  weatherRowsFromForecasts
} from '../src/polymarketUs/models/weather.js';
import { fedMoveProb, macroKind, macroRowsFromBooks, selectFedMeeting } from '../src/polymarketUs/models/macro.js';
import { cryptoRowsFromChain, parseUsBtcMarket } from '../src/polymarketUs/models/crypto.js';
import { masterRowsFromMarkets } from '../src/polymarketUs/models/master.js';
import { formatModelCounts, loadPublicModelReport } from '../src/polymarketUs/models.js';

const NOW = new Date('2026-10-15T18:00:00.000Z');

test('devig, team names, and the fed-funds upper bound are stable', () => {
  assert.ok(Math.abs(americanToImplied(-150) - 0.6) < 1e-9);
  assert.ok(Math.abs(americanToImplied(130) - 100 / 230) < 1e-9);
  const fair = devig([0.6, 100 / 230]);
  assert.ok(Math.abs(fair[0] + fair[1] - 1) < 1e-9);
  assert.equal(teamsMatch('Raptors', 'Toronto Raptors'), true);
  assert.equal(teamsMatch('Knicks', 'New York Knicks'), true);
  assert.equal(teamsMatch('Lakers', 'Knicks'), false);
  assert.equal(upperBoundFromEffr(3.88), 4);
  assert.equal(upperBoundFromEffr(3.75), 3.75);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-3);
});

test('touch probability stays above the terminal probability and is ordered', () => {
  const terminal = lognormalAboveProb({ forward: 80000, strike: 100000, sigma: 0.5, years: 0.2 });
  const touch = gbmTouchProb({ spot: 80000, barrier: 100000, sigma: 0.5, years: 0.2 });
  const nearer = gbmTouchProb({ spot: 80000, barrier: 90000, sigma: 0.5, years: 0.2 });
  assert.equal(gbmTouchProb({ spot: 100000, barrier: 90000, sigma: 0.5, years: 0.2 }), 0.99);
  assert.ok(touch > terminal);
  assert.ok(nearer > touch);
  assert.ok(touch < 0.99);
});

test('pregame rows use the Pinnacle devigged probability of the long team', () => {
  const lines = pinnacleMoneylines([
    {
      id: 7,
      type: 'matchup',
      startTime: '2026-10-15T23:30:00Z',
      participants: [
        { alignment: 'home', name: 'New York Knicks' },
        { alignment: 'away', name: 'Toronto Raptors' }
      ]
    }
  ], [
    {
      type: 'moneyline',
      period: 0,
      status: 'open',
      matchupId: 7,
      prices: [
        { designation: 'home', price: -150 },
        { designation: 'away', price: 130 }
      ]
    }
  ]);
  const rows = pregameRowsFromBooks({
    now: NOW,
    lines,
    events: [{
      title: 'TOR Raptors vs. NY Knicks',
      startTime: '2026-10-15T23:30:00Z',
      teams: [{ name: 'Raptors' }, { name: 'Knicks' }],
      markets: [{
        marketType: 'moneyline',
        sportsMarketType: 'basketball_team_full_game_winner',
        slug: 'aec-nba-tor-ny-2026-10-15',
        question: 'Who will win TOR Raptors vs NY Knicks?',
        gameStartTime: '2026-10-15T23:30:00Z',
        endDate: '2026-10-16T03:00:00Z',
        marketSides: [{ long: true, team: { name: 'Raptors' } }, { long: false, team: { name: 'Knicks' } }]
      }]
    }]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sector, 'pregame');
  assert.equal(rows[0].side, 'Yes');
  assert.ok(rows[0].model_prob < 0.5);
  assert.ok(Math.abs(rows[0].model_prob + rows[1].model_prob - 1) < 1e-3);
  assert.match(rows[0].basis, /Pinnacle/);
});

test('weather contract probability comes from the ensemble', () => {
  const market = {
    slug: 'nyc-high-2026-10-16',
    question: 'Will the high temperature in New York be 70°F or higher on October 16, 2026?',
    description: 'Settles on the Central Park temperature.',
    endDate: '2026-10-17T04:00:00Z',
    category: 'weather'
  };
  const contract = parseWeatherContract(market);
  assert.equal(contract.city.name, 'New York');
  assert.equal(contract.date, '2026-10-16');
  assert.equal(contract.kind, 'above');
  assert.equal(contract.threshold, 70);
  const samples = [68, 69, 71, 72, 74, 75, 76, 77, 73, 70, 66, 80, 81, 64, 79, 78, 62, 83, 74, 71];
  const prob = probabilityFromSamples(samples, contract);
  assert.ok(prob > 0.5 && prob < 0.9);
  const rows = weatherRowsFromForecasts({
    markets: [market],
    forecasts: new Map([['New York', {
      ensemble: {
        time: ['2026-10-16'],
        temperature_2m_max_member01: [68],
        temperature_2m_max_member02: [69],
        temperature_2m_max_member03: [71],
        temperature_2m_max_member04: [72],
        temperature_2m_max_member05: [74],
        temperature_2m_max_member06: [75],
        temperature_2m_max_member07: [76],
        temperature_2m_max_member08: [77],
        temperature_2m_max_member09: [73],
        temperature_2m_max_member10: [70],
        temperature_2m_max_member11: [66],
        temperature_2m_max_member12: [80],
        temperature_2m_max_member13: [81],
        temperature_2m_max_member14: [64],
        temperature_2m_max_member15: [79],
        temperature_2m_max_member16: [78],
        temperature_2m_max_member17: [62],
        temperature_2m_max_member18: [83],
        temperature_2m_max_member19: [74],
        temperature_2m_max_member20: [71]
      },
      points: { '2026-10-16': { max: 73 } }
    }]])
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sector, 'weather');
  assert.equal(rows[0].city, 'New York');
  assert.equal(rows[0].confidence, 'High');
  assert.match(rows[0].basis, /Open-Meteo/);
});

test('macro rows price a 2026 cut from Kalshi and a House market from the party book', () => {
  const cut = {
    slug: 'cbpac-usfed-2026-cut',
    question: 'Fed Rate Cut in 2026?',
    description: 'This market settles Yes if the Fed decreases the upper bound by December 31, 2026. Meetings count.',
    endDate: '2027-01-15T04:00:00Z',
    category: 'macro',
    active: true
  };
  const house = {
    slug: 'paccc-usho-midterms-2026-11-03-dem',
    question: 'U.S House Midterm Winner',
    description: 'Democratic Party wins the House.',
    endDate: '2027-02-02T04:59:00Z',
    category: 'politics',
    active: true
  };
  assert.equal(macroKind(cut).kind, 'fed-cut');
  assert.equal(macroKind(house).kind, 'house-d');
  const meeting = {
    eventTicker: 'KXFED-26DEC',
    strikeDate: '2026-12-09T19:00:00Z',
    markets: [{
      ticker: 'KXFED-26DEC-T3.75',
      floor_strike: 3.75,
      yes_bid_dollars: '0.4000',
      yes_ask_dollars: '0.4400'
    }]
  };
  assert.equal(selectFedMeeting([meeting], cut).eventTicker, 'KXFED-26DEC');
  const move = fedMoveProb({ currentUpper: 4, markets: meeting.markets, kind: 'cut' });
  assert.ok(Math.abs(move.prob - 0.58) < 1e-9);
  const rows = macroRowsFromBooks({
    markets: [cut, house],
    currentUpper: 4,
    fedMeetings: [meeting],
    house: {
      d: { ticker: 'CONTROLH-2026-D', yes_bid_dollars: '0.9000', yes_ask_dollars: '0.9100' }
    }
  });
  assert.ok(rows.some((row) => row.slug === cut.slug && row.side === 'Yes' && row.model_prob > 0.5));
  assert.ok(rows.some((row) => row.slug === house.slug && row.model_prob > 0.8));
  assert.ok(rows.every((row) => row.sector === 'macro'));
});

test('long-dated BTC uses the Deribit chain and master flags exclusive mispricing', () => {
  const market = {
    category: 'crypto',
    slug: 'cpc-btc-above-90k-2026',
    question: 'Bitcoin price at the end of 2026?',
    description: 'This market will settle to Yes if the price of Bitcoin is above $89,999.99 at 12:00 AM ET on January 1, 2027. Outcome sourced from CF Benchmarks BRTI.',
    endDate: '2027-01-15T04:00:00Z',
    active: true
  };
  assert.equal(parseUsBtcMarket(market).kind, 'above');
  assert.equal(parseUsBtcMarket(market).strike, 90000);
  const rows = cryptoRowsFromChain({
    now: NOW,
    markets: [market],
    summaries: [
      { instrument_name: 'BTC-25DEC26-80000-C', mark_iv: 55, underlying_price: 82000 },
      { instrument_name: 'BTC-25DEC26-90000-C', mark_iv: 55, underlying_price: 82000 },
      { instrument_name: 'BTC-25DEC26-100000-C', mark_iv: 55, underlying_price: 82000 }
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sector, 'crypto');
  assert.ok(rows[0].model_prob > 0.05 && rows[0].model_prob < 0.9);
  assert.match(rows[0].basis, /Deribit/);

  const shared = {
    question: 'Sample exclusive',
    endDate: '2026-12-31T00:00:00Z',
    description: 'Only one outcome in this market will resolve to Yes.',
    active: true
  };
  const master = masterRowsFromMarkets([
    { ...shared, slug: 'bucket-a', outcomes: '["Yes","No"]', outcomePrices: '["0.20","0.50"]' },
    { ...shared, slug: 'bucket-b', outcomes: '["Yes","No"]', outcomePrices: '["0.20","0.50"]' }
  ]);
  assert.ok(master.length >= 1);
  assert.equal(master[0].sector, 'master');
  assert.ok(master[0].model_prob - 0.2 >= 0.03);
  assert.equal(yesQuote({ outcomes: '["Yes","No"]', outcomePrices: '["0.20","0.50"]' }).mid, 0.2);
});

test('loadPublicModelReport counts a row for every non-BTC sector from public payloads', async () => {
  const bodies = new Map();
  const put = (part, body) => bodies.set(part, body);
  put('/v1/markets?limit=100&closed=false&offset=0', {
    markets: [
      {
        slug: 'nyc-high-2026-10-16',
        question: 'Will the high temperature in New York be 70°F or higher on October 16, 2026?',
        description: 'Central Park temperature.',
        endDate: '2026-10-17T04:00:00Z',
        category: 'weather',
        active: true,
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.40","0.62"]'
      },
      {
        slug: 'cbpac-usfed-2026-cut',
        question: 'Fed Rate Cut in 2026?',
        description: 'Yes if the Fed decreases the upper bound by December 31, 2026. Meetings count.',
        endDate: '2027-01-15T04:00:00Z',
        category: 'macro',
        active: true
      },
      {
        category: 'crypto',
        slug: 'cpc-btc-above-90k-2026',
        question: 'Bitcoin above 90k at year end?',
        description: 'This market will settle to Yes if the price of Bitcoin is above $89,999.99 at 12:00 AM ET on January 1, 2027. Outcome sourced from CF Benchmarks BRTI.',
        endDate: '2027-01-15T04:00:00Z',
        active: true
      },
      {
        question: 'Sample exclusive',
        endDate: '2026-12-31T00:00:00Z',
        description: 'Only one outcome in this market will resolve to Yes.',
        active: true,
        slug: 'bucket-a',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.20","0.50"]'
      },
      {
        question: 'Sample exclusive',
        endDate: '2026-12-31T00:00:00Z',
        description: 'Only one outcome in this market will resolve to Yes.',
        active: true,
        slug: 'bucket-b',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.20","0.50"]'
      }
    ]
  });
  put('series_id=4', {
    events: [{
      title: 'TOR Raptors vs. NY Knicks',
      startTime: '2026-10-15T23:30:00Z',
      active: true,
      teams: [{ name: 'Raptors' }, { name: 'Knicks' }],
      markets: [{
        marketType: 'moneyline',
        sportsMarketType: 'basketball_team_full_game_winner',
        slug: 'aec-nba-tor-ny-2026-10-15',
        question: 'Who will win TOR Raptors vs NY Knicks?',
        gameStartTime: '2026-10-15T23:30:00Z',
        endDate: '2026-10-16T03:00:00Z',
        marketSides: [{ long: true, team: { name: 'Raptors' } }]
      }]
    }]
  });
  put('/leagues/487/matchups', [{
    id: 7,
    type: 'matchup',
    startTime: '2026-10-15T23:30:00Z',
    participants: [
      { alignment: 'home', name: 'New York Knicks' },
      { alignment: 'away', name: 'Toronto Raptors' }
    ]
  }]);
  put('/leagues/487/markets/straight', [{
    type: 'moneyline',
    period: 0,
    status: 'open',
    matchupId: 7,
    prices: [{ designation: 'home', price: -150 }, { designation: 'away', price: 130 }]
  }]);
  put('ensemble-api.open-meteo.com', {
    daily: {
      time: ['2026-10-16'],
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
        `temperature_2m_max_member${String(index + 1).padStart(2, '0')}`,
        [index < 14 ? 74 : 66]
      ]))
    }
  });
  put('api.open-meteo.com/v1/forecast', {
    daily: { time: ['2026-10-16'], temperature_2m_max: [73], temperature_2m_min: [55] }
  });
  put('api.weather.gov/points', { properties: {} });
  put('rates/unsecured/effr', { refRates: [{ type: 'EFFR', percentRate: 3.88 }] });
  put('series_ticker=KXFED', {
    events: [{ event_ticker: 'KXFED-26DEC', strike_date: '2026-12-09T19:00:00Z', title: 'Fed funds rate after Dec 2026 meeting?' }]
  });
  put('event_ticker=KXFED-26DEC', {
    markets: [{ ticker: 'KXFED-26DEC-T3.75', floor_strike: 3.75, yes_bid_dollars: '0.4000', yes_ask_dollars: '0.4400' }]
  });
  put('event_ticker=CONTROLH-2026', { markets: [] });
  put('event_ticker=CONTROLS-2026', { markets: [] });
  put('get_book_summary_by_currency', {
    result: [
      { instrument_name: 'BTC-25DEC26-80000-C', mark_iv: 55, underlying_price: 82000 },
      { instrument_name: 'BTC-25DEC26-90000-C', mark_iv: 55, underlying_price: 82000 }
    ]
  });

  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('arcadia.pinnacle.com') && !text.includes('/leagues/487/')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    const hit = [...bodies.entries()].find(([part]) => text.includes(part));
    if (!hit) return { ok: true, status: 200, json: async () => ({ markets: [], events: [] }) };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
  const report = await loadPublicModelReport({ now: NOW, fetchImpl, maxCatalogPages: 1, ledgerRoot: null });
  for (const sector of ['pregame', 'weather', 'macro', 'crypto', 'master']) {
    assert.ok(report.counts[sector] >= 1, `${sector} should have a row, got ${report.counts[sector]} errors=${report.errors.join('|')}`);
  }
  assert.match(formatModelCounts(report.counts), /pregame=\d+ weather=\d+ macro=\d+ crypto=\d+ master=\d+/);
  assert.equal(report.errors.length, 0);
});
