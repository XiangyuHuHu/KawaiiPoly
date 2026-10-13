import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDailyUpDownSlugCandidates,
  getDailyNoonEtSlotSchedule,
  getHourlyEtSlotSchedule,
  getSlotSchedule
} from '../src/polymarketSchedule.js';

test('getSlotSchedule keeps 5m UTC windows', () => {
  const schedule = getSlotSchedule(new Date('2026-06-29T10:07:30.000Z'), 5);
  assert.equal(schedule.currentSlotIso, '2026-06-29T10:05:00.000Z');
  assert.equal(schedule.nextSlotIso, '2026-06-29T10:10:00.000Z');
});

test('hourly schedule uses Eastern Time clock hours', () => {
  // 2026-07-21 15:30 UTC = 11:30 AM EDT
  const schedule = getHourlyEtSlotSchedule(new Date('2026-07-21T15:30:00.000Z'));
  assert.equal(schedule.currentSlotIso, '2026-07-21T15:00:00.000Z');
  assert.equal(schedule.nextSlotIso, '2026-07-21T16:00:00.000Z');
  assert.equal(schedule.secondsToNext, 30 * 60);
});

test('daily schedule uses noon ET to noon ET windows', () => {
  // 2026-07-21 14:00 UTC = 10:00 AM EDT → settles today noon ET (16:00 UTC in July)
  const morning = getDailyNoonEtSlotSchedule(new Date('2026-07-21T14:00:00.000Z'));
  assert.equal(morning.nextSlotIso, '2026-07-21T16:00:00.000Z');
  assert.equal(morning.settlementEtDate.year, 2026);
  assert.equal(morning.settlementEtDate.month, 7);
  assert.equal(morning.settlementEtDate.day, 21);

  // 2026-07-21 17:00 UTC = 1:00 PM EDT → settles tomorrow noon ET
  const afternoon = getDailyNoonEtSlotSchedule(new Date('2026-07-21T17:00:00.000Z'));
  assert.equal(afternoon.nextSlotIso, '2026-07-22T16:00:00.000Z');
  assert.equal(afternoon.settlementEtDate.day, 22);
});

test('daily slug candidates follow Polymarket human-readable format', () => {
  const slugs = buildDailyUpDownSlugCandidates('bitcoin', { year: 2026, month: 7, day: 14 });
  assert.deepEqual(slugs, [
    'bitcoin-up-or-down-on-july-14-2026',
    'bitcoin-up-or-down-on-july-14'
  ]);
});
