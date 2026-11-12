import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occurrences, nextOccurrence, lastOccurrence, annualCost, dailyCost, upcoming, bookTotals, renewals,
} from '../js/model/book.js';
import { defaultState, makeRecurring, makeStream } from '../js/model/schema.js';
import { addDays, daysInMonth, diffDays, eachDay, monthOf, parts } from '../js/model/dates.js';

const item = (cadence, anchor) => ({ cadence, anchor });

/* An independent reference: walk every day of the range and ask "is this day on the schedule?". */

const MONTH_STEP = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
const DAY_STEP = { weekly: 7, biweekly: 14 };

function isOnSchedule({ cadence, anchor }, day) {
  if (DAY_STEP[cadence]) {
    const step = DAY_STEP[cadence];
    return ((diffDays(anchor, day) % step) + step) % step === 0;
  }
  const a = parts(anchor), d = parts(day);
  const step = MONTH_STEP[cadence];
  const months = (d.y - a.y) * 12 + (d.m - a.m);
  return ((months % step) + step) % step === 0 && d.d === Math.min(a.d, daysInMonth(monthOf(day)));
}

function dayByDay(schedule, afterDay, untilDay) {
  return eachDay(addDays(afterDay, 1), untilDay).filter((day) => isOnSchedule(schedule, day));
}

/* ------------------------------------------------------------- weekly, biweekly */

test('weekly: strictly after one day, up to and including another', () => {
  const weekly = item('weekly', '2026-11-03');
  assert.deepEqual(occurrences(weekly, '2026-11-03', '2026-11-24'), ['2026-11-10', '2026-11-17', '2026-11-24']);
  assert.deepEqual(occurrences(weekly, '2026-11-02', '2026-11-03'), ['2026-11-03']);
  assert.deepEqual(occurrences(weekly, '2026-11-03', '2026-11-09'), []);
  assert.deepEqual(occurrences(weekly, '2026-11-10', '2026-11-17'), ['2026-11-17']);
});

test('weekly: through a leap day and a year end', () => {
  assert.deepEqual(occurrences(item('weekly', '2028-02-22'), '2028-02-22', '2028-03-07'), ['2028-02-29', '2028-03-07']);
  assert.deepEqual(occurrences(item('weekly', '2026-12-24'), '2026-12-24', '2027-01-08'), ['2026-12-31', '2027-01-07']);
});

test('biweekly: an anchor in the past and one in the future give the same schedule', () => {
  const expected = ['2026-11-13', '2026-11-27', '2026-12-11', '2026-12-25'];
  // 2 Oct + 14 = 16 Oct, 30 Oct, 13 Nov, 27 Nov, 11 Dec, 25 Dec, 8 Jan
  assert.deepEqual(occurrences(item('biweekly', '2026-10-02'), '2026-11-11', '2026-12-31'), expected);
  assert.deepEqual(occurrences(item('biweekly', '2027-01-08'), '2026-11-11', '2026-12-31'), expected);
  assert.deepEqual(occurrences(item('biweekly', '2026-11-27'), '2026-11-11', '2026-12-31'), expected);
});

test('biweekly: the anchor itself is an occurrence, and the off weeks are not', () => {
  const pay = item('biweekly', '2026-11-13');
  assert.deepEqual(occurrences(pay, '2026-11-12', '2026-11-13'), ['2026-11-13']);
  assert.deepEqual(occurrences(pay, '2026-11-13', '2026-11-26'), []);
  assert.deepEqual(occurrences(pay, '2026-10-29', '2026-11-12'), ['2026-10-30']);
});

/* --------------------------------------------------------------- monthly family */

test('monthly: an anchor on the 31st stays month-end', () => {
  assert.deepEqual(occurrences(item('monthly', '2026-01-31'), '2026-01-31', '2026-06-30'),
    ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  // through a leap February
  assert.deepEqual(occurrences(item('monthly', '2027-12-31'), '2028-01-31', '2028-03-31'), ['2028-02-29', '2028-03-31']);
});

test('monthly: anchors on the 29th and 30th clamp in February only', () => {
  assert.deepEqual(occurrences(item('monthly', '2026-11-30'), '2026-12-31', '2027-03-31'),
    ['2027-01-30', '2027-02-28', '2027-03-30']);
  assert.deepEqual(occurrences(item('monthly', '2026-10-29'), '2027-01-29', '2027-03-29'), ['2027-02-28', '2027-03-29']);
  assert.deepEqual(occurrences(item('monthly', '2026-10-29'), '2028-01-29', '2028-03-29'), ['2028-02-29', '2028-03-29']);
  assert.deepEqual(occurrences(item('monthly', '2026-10-30'), '2028-01-30', '2028-03-30'), ['2028-02-29', '2028-03-30']);
});

test('monthly: an anchor on 28 February keeps the 28th', () => {
  assert.deepEqual(occurrences(item('monthly', '2027-02-28'), '2027-02-28', '2027-04-30'), ['2027-03-28', '2027-04-28']);
});

test('monthly: a future anchor is projected backward', () => {
  assert.deepEqual(occurrences(item('monthly', '2027-03-31'), '2026-11-11', '2027-01-31'),
    ['2026-11-30', '2026-12-31', '2027-01-31']);
  assert.deepEqual(occurrences(item('monthly', '2027-03-15'), '2026-11-15', '2026-12-15'), ['2026-12-15']);
});

test('monthly: boundaries are exclusive after and inclusive until', () => {
  const rent = item('monthly', '2026-11-01');
  assert.deepEqual(occurrences(rent, '2026-11-01', '2026-12-01'), ['2026-12-01']);
  assert.deepEqual(occurrences(rent, '2026-10-31', '2026-11-30'), ['2026-11-01']);
  assert.deepEqual(occurrences(rent, '2026-11-01', '2026-11-30'), []);
  assert.deepEqual(occurrences(rent, '2026-12-01', '2026-12-01'), []);
  assert.deepEqual(occurrences(rent, '2026-12-31', '2026-12-01'), []);
});

test('quarterly, semiannual and annual keep the day of month, clamped', () => {
  assert.deepEqual(occurrences(item('quarterly', '2026-11-30'), '2026-05-29', '2027-05-30'),
    ['2026-05-30', '2026-08-30', '2026-11-30', '2027-02-28', '2027-05-30']);
  assert.deepEqual(occurrences(item('semiannual', '2026-08-31'), '2026-08-31', '2028-02-29'),
    ['2027-02-28', '2027-08-31', '2028-02-29']);
  assert.deepEqual(occurrences(item('annual', '2024-02-29'), '2024-02-29', '2028-02-29'),
    ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  assert.deepEqual(occurrences(item('annual', '2026-11-20'), '2023-01-01', '2026-11-20'),
    ['2023-11-20', '2024-11-20', '2025-11-20', '2026-11-20']);
});

test('fixed-step and monthly schedules match a day-by-day reference over four years', () => {
  const schedules = [
    item('weekly', '2026-11-03'), item('weekly', '2029-06-15'), item('biweekly', '2026-10-02'), item('biweekly', '2024-01-05'),
    item('monthly', '2026-01-31'), item('monthly', '2026-04-30'), item('monthly', '2028-02-29'), item('monthly', '2026-11-11'),
    item('quarterly', '2026-11-30'), item('quarterly', '2030-01-31'), item('semiannual', '2026-08-31'),
    item('annual', '2024-02-29'), item('annual', '2027-06-01'),
  ];
  for (const schedule of schedules) {
    assert.deepEqual(occurrences(schedule, '2025-06-17', '2029-06-17'), dayByDay(schedule, '2025-06-17', '2029-06-17'),
      schedule.cadence + ' from ' + schedule.anchor);
  }
});

/* ------------------------------------------------------------------ semimonthly */

test('semimonthly: the 1st pairs with the 16th, whichever of the two is the anchor', () => {
  const expected = ['2026-11-16', '2026-12-01', '2026-12-16'];
  assert.deepEqual(occurrences(item('semimonthly', '2026-11-01'), '2026-11-01', '2026-12-31'), expected);
  assert.deepEqual(occurrences(item('semimonthly', '2026-11-16'), '2026-11-01', '2026-12-31'), expected);
});

test('semimonthly: the 5th pairs with the 20th', () => {
  const expected = ['2026-11-20', '2026-12-05', '2026-12-20', '2027-01-05'];
  assert.deepEqual(occurrences(item('semimonthly', '2026-11-05'), '2026-11-05', '2027-01-05'), expected);
  assert.deepEqual(occurrences(item('semimonthly', '2026-10-20'), '2026-11-05', '2027-01-05'), expected);
});

test('semimonthly: the 15th pairs with the 30th, clamped in February', () => {
  assert.deepEqual(occurrences(item('semimonthly', '2026-11-15'), '2027-01-15', '2027-03-30'),
    ['2027-01-30', '2027-02-15', '2027-02-28', '2027-03-15', '2027-03-30']);
  assert.deepEqual(occurrences(item('semimonthly', '2026-11-15'), '2028-02-15', '2028-03-01'), ['2028-02-29']);
  // the 30th of a 31-day month is not month-end: it keeps the 30th
  assert.deepEqual(occurrences(item('semimonthly', '2026-10-30'), '2026-10-30', '2026-12-31'),
    ['2026-11-15', '2026-11-30', '2026-12-15', '2026-12-30']);
});

test('semimonthly: a last-day-of-month anchor stays the last day, with the 15th', () => {
  const expected = ['2026-12-15', '2026-12-31', '2027-01-15', '2027-01-31', '2027-02-15', '2027-02-28'];
  assert.deepEqual(occurrences(item('semimonthly', '2026-11-30'), '2026-11-30', '2027-02-28'), expected);
  assert.deepEqual(occurrences(item('semimonthly', '2026-10-31'), '2026-11-30', '2027-02-28'), expected);
  assert.deepEqual(occurrences(item('semimonthly', '2027-02-28'), '2026-11-30', '2027-02-28'), expected);
  assert.deepEqual(occurrences(item('semimonthly', '2028-02-29'), '2028-02-15', '2028-03-31'),
    ['2028-02-29', '2028-03-15', '2028-03-31']);
});

test('semimonthly: twice in every month, 13 to 16 days apart, and the anchor is on the schedule', () => {
  const anchors = ['2026-11-01', '2026-11-07', '2026-11-15', '2026-11-16', '2026-11-22', '2026-11-29', '2026-11-30', '2026-12-31', '2028-02-29'];
  for (const anchor of anchors) {
    const days = occurrences(item('semimonthly', anchor), '2025-12-31', '2028-12-31');
    assert.equal(days.length, 72, anchor + ': 24 a year for three years');
    assert.ok(days.includes(anchor), anchor + ' is an occurrence');
    for (let i = 1; i < days.length; i++) {
      const gap = diffDays(days[i - 1], days[i]);
      assert.ok(gap >= 13 && gap <= 16, anchor + ': gap of ' + gap + ' before ' + days[i]);
    }
  }
});

/* ------------------------------------------------------- next and last occurrence */

test('nextOccurrence is strictly after the day', () => {
  const rent = item('monthly', '2026-11-01');
  assert.equal(nextOccurrence(rent, '2026-11-01'), '2026-12-01');
  assert.equal(nextOccurrence(rent, '2026-10-31'), '2026-11-01');
  assert.equal(nextOccurrence(rent, '2026-11-30'), '2026-12-01');
  assert.equal(nextOccurrence(item('weekly', '2026-11-03'), '2026-11-11'), '2026-11-17');
  assert.equal(nextOccurrence(item('biweekly', '2026-10-02'), '2026-11-13'), '2026-11-27');
  assert.equal(nextOccurrence(item('semimonthly', '2026-11-15'), '2027-02-15'), '2027-02-28');
  assert.equal(nextOccurrence(item('quarterly', '2026-11-30'), '2026-11-30'), '2027-02-28');
  assert.equal(nextOccurrence(item('semiannual', '2026-07-31'), '2026-07-31'), '2027-01-31');
  assert.equal(nextOccurrence(item('annual', '2024-02-29'), '2026-11-11'), '2027-02-28');
  assert.equal(nextOccurrence(item('annual', '2023-03-01'), '2027-03-01'), '2028-03-01'); // 366 days on
});

test('nextOccurrence with an anchor in the future finds the nearest day, not the anchor', () => {
  assert.equal(nextOccurrence(item('biweekly', '2027-01-08'), '2026-11-11'), '2026-11-13');
  assert.equal(nextOccurrence(item('monthly', '2027-06-20'), '2026-11-11'), '2026-11-20');
  assert.equal(nextOccurrence(item('annual', '2030-12-05'), '2026-11-11'), '2026-12-05');
});

test('lastOccurrence counts the anchor itself and the day itself', () => {
  const pay = item('biweekly', '2026-11-13');
  assert.equal(lastOccurrence(pay, '2026-11-13'), '2026-11-13');
  assert.equal(lastOccurrence(pay, '2026-11-14'), '2026-11-13');
  assert.equal(lastOccurrence(pay, '2026-11-26'), '2026-11-13');
  assert.equal(lastOccurrence(pay, '2026-11-27'), '2026-11-27');
  assert.equal(lastOccurrence(item('monthly', '2026-01-31'), '2026-03-30'), '2026-02-28');
  assert.equal(lastOccurrence(item('monthly', '2026-01-31'), '2026-03-31'), '2026-03-31');
  assert.equal(lastOccurrence(item('semimonthly', '2026-11-30'), '2027-02-27'), '2027-02-15');
  assert.equal(lastOccurrence(item('annual', '2024-02-29'), '2026-11-11'), '2026-02-28');
  assert.equal(lastOccurrence(item('annual', '2024-02-29'), '2028-02-28'), '2027-02-28');
  assert.equal(lastOccurrence(item('semiannual', '2026-07-31'), '2027-01-30'), '2026-07-31');
});

test('lastOccurrence before the anchor is projected backward', () => {
  assert.equal(lastOccurrence(item('biweekly', '2026-11-13'), '2026-11-12'), '2026-10-30');
  assert.equal(lastOccurrence(item('monthly', '2027-03-31'), '2026-11-11'), '2026-10-31');
  assert.equal(lastOccurrence(item('quarterly', '2027-02-28'), '2026-11-11'), '2026-08-28');
});

test('last and next bracket every day with nothing in between', () => {
  const schedules = [
    item('weekly', '2026-11-03'), item('biweekly', '2027-01-08'), item('semimonthly', '2026-11-30'), item('semimonthly', '2026-11-05'),
    item('monthly', '2026-01-31'), item('quarterly', '2026-11-30'), item('semiannual', '2026-08-31'), item('annual', '2024-02-29'),
  ];
  for (const schedule of schedules) {
    const label = schedule.cadence + ' from ' + schedule.anchor;
    for (const day of eachDay('2027-01-01', '2028-03-31')) {
      const last = lastOccurrence(schedule, day);
      const next = nextOccurrence(schedule, day);
      assert.ok(last <= day && day < next, label + ' on ' + day);
      assert.deepEqual(occurrences(schedule, addDays(last, -1), next), [last, next], label + ' on ' + day);
    }
  }
});

/* ------------------------------------------------------------------ robustness */

test('a malformed schedule has no occurrences and never throws', () => {
  const broken = [
    null, undefined, {}, item('monthly', ''), item('monthly', null), item('monthly', '2026-02-30'), item('monthly', '2026-2-3'),
    item(null, '2026-11-01'), item('fortnightly', '2026-11-01'), item('constructor', '2026-11-01'), item('toString', '2026-11-01'),
  ];
  for (const schedule of broken) {
    assert.deepEqual(occurrences(schedule, '2026-11-01', '2027-11-01'), []);
    assert.equal(nextOccurrence(schedule, '2026-11-01'), null);
    assert.equal(lastOccurrence(schedule, '2026-11-01'), null);
  }
  const rent = item('monthly', '2026-11-01');
  assert.deepEqual(occurrences(rent, null, '2026-12-31'), []);
  assert.deepEqual(occurrences(rent, '2026-11-01', 'soon'), []);
  assert.deepEqual(occurrences(rent, undefined, undefined), []);
  assert.equal(nextOccurrence(rent, 'yesterday'), null);
  assert.equal(lastOccurrence(rent, 20261101), null);
});

test('a stream with no cadence has no paydays; one with a cadence does', () => {
  assert.deepEqual(occurrences(makeStream({ cadence: null, anchor: '2026-11-06' }), '2026-11-01', '2026-12-31'), []);
  assert.equal(nextOccurrence(makeStream({ cadence: null, anchor: null }), '2026-11-11'), null);
  assert.equal(nextOccurrence(makeStream({ cadence: 'biweekly', anchor: '2026-11-06' }), '2026-11-11'), '2026-11-20');
});

/* ----------------------------------------------------------------------- costs */

test('annualCost multiplies by the occurrences in a year', () => {
  assert.equal(annualCost({ amount: 1000, cadence: 'weekly' }), 52000);
  assert.equal(annualCost({ amount: 5000, cadence: 'biweekly' }), 130000);
  assert.equal(annualCost({ amount: 2500, cadence: 'semimonthly' }), 60000);
  assert.equal(annualCost({ amount: 1599, cadence: 'monthly' }), 19188);
  assert.equal(annualCost({ amount: 4500, cadence: 'quarterly' }), 18000);
  assert.equal(annualCost({ amount: 60000, cadence: 'semiannual' }), 120000);
  assert.equal(annualCost({ amount: 24000, cadence: 'annual' }), 24000);
});

test('dailyCost divides by the days in a cadence', () => {
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' vs ' + expected);
  close(dailyCost({ amount: 700, cadence: 'weekly' }), 100);
  close(dailyCost({ amount: 1400, cadence: 'biweekly' }), 100);
  close(dailyCost({ amount: 36525, cadence: 'annual' }), 100);            // 365.25 days
  close(dailyCost({ amount: 182625, cadence: 'semiannual' }), 1000);      // 182.625 days
  close(dailyCost({ amount: 91312.5, cadence: 'quarterly' }), 1000);      // 91.3125 days
  close(dailyCost({ amount: 304375, cadence: 'monthly' }), 10000);        // 30.4375 days
  close(dailyCost({ amount: 1521875, cadence: 'semimonthly' }), 100000);  // 15.21875 days
});

test('costs of a malformed entry are zero, never NaN', () => {
  for (const rec of [null, undefined, {}, { amount: 100 }, { amount: 100, cadence: 'hourly' }, { amount: NaN, cadence: 'monthly' },
    { amount: '12', cadence: 'monthly' }, { amount: Infinity, cadence: 'weekly' }, { amount: -500, cadence: 'monthly' },
    { amount: 100, cadence: 'constructor' }]) {
    assert.equal(annualCost(rec), 0);
    assert.equal(dailyCost(rec), 0);
  }
});

/* -------------------------------------------------------------------- upcoming */

function bookState(entries) {
  const state = defaultState(new Date(2026, 10, 11, 9).getTime());
  state.recurring = entries;
  return state;
}

const rent = makeRecurring({ id: 'rec_rent', name: 'Rent', amount: 180000, cadence: 'monthly', anchor: '2026-11-01', accountId: 'acc_chk', category: 'housing', essential: true, verdict: 'keep' });
const streamly = makeRecurring({ id: 'rec_streamly', name: 'Streamly', amount: 1599, cadence: 'monthly', anchor: '2026-10-11', accountId: 'acc_card', verdict: 'cut' });
const laundry = makeRecurring({ id: 'rec_laundry', name: 'Washhouse', amount: 1000, cadence: 'weekly', anchor: '2026-11-05', category: 'household' });
const power = makeRecurring({ id: 'rec_power', name: 'Gridline Power', amount: 8400, cadence: 'monthly', anchor: '2026-11-10', accountId: 'acc_chk', category: 'utilities', variable: true, essential: true });
const paper = makeRecurring({ id: 'rec_paper', name: 'The Daily Sheet', amount: 900, cadence: 'monthly', anchor: '2026-11-11', accountId: 'acc_card' });
const studio = makeRecurring({ id: 'rec_studio', name: 'Looplab', amount: 24000, cadence: 'annual', anchor: '2025-12-01', purpose: 'studio', verdict: 'review' });
const insurance = makeRecurring({ id: 'rec_ins', name: 'Harbour Mutual', amount: 60000, cadence: 'semiannual', anchor: '2026-07-05', purpose: 'work', category: 'insurance', verdict: 'review' });
const water = makeRecurring({ id: 'rec_water', name: 'Town Water', amount: 4500, cadence: 'quarterly', anchor: '2026-08-20', category: 'utilities' });
const ended = makeRecurring({ id: 'rec_old', name: 'Old Gym', amount: 4000, cadence: 'monthly', anchor: '2026-11-02', active: false, verdict: 'cut' });
const malformed = [
  null, undefined, 'rent',
  makeRecurring({ id: 'rec_bad1', amount: 500, cadence: 'sometimes', anchor: '2026-11-12' }),
  makeRecurring({ id: 'rec_bad2', amount: NaN, cadence: 'monthly', anchor: '2026-11-12' }),
];
const anchorless = makeRecurring({ id: 'rec_bad3', amount: 500, cadence: 'quarterly', anchor: '' });

test('upcoming: one row per occurrence from fromDay inclusive for `days` days, soonest first', () => {
  const state = bookState([rent, streamly, ended, laundry, power, paper, anchorless, ...malformed]);
  const rows = upcoming(state, '2026-11-11', 30); // 11 Nov .. 10 Dec
  assert.deepEqual(rows.map((r) => r.day + ' ' + r.id), [
    '2026-11-11 rec_streamly', // an occurrence on fromDay itself
    '2026-11-11 rec_paper',    // its own anchor day; same day keeps Book order
    '2026-11-12 rec_laundry',
    '2026-11-19 rec_laundry',
    '2026-11-26 rec_laundry',
    '2026-12-01 rec_rent',
    '2026-12-03 rec_laundry',
    '2026-12-10 rec_laundry',  // the last day of the window is included
    '2026-12-10 rec_power',
  ]);
  assert.deepEqual(rows[5], {
    id: 'rec_rent', name: 'Rent', day: '2026-12-01', amount: 180000, accountId: 'acc_chk', category: 'housing',
    purpose: 'personal', variable: false, essential: true,
  });
  assert.deepEqual(rows[8], {
    id: 'rec_power', name: 'Gridline Power', day: '2026-12-10', amount: 8400, accountId: 'acc_chk', category: 'utilities',
    purpose: 'personal', variable: true, essential: true,
  });
  assert.equal(rows[2].accountId, null);
});

test('upcoming: the window length is exact', () => {
  const state = bookState([streamly, paper, laundry]);
  assert.deepEqual(upcoming(state, '2026-11-11', 1).map((r) => r.id), ['rec_streamly', 'rec_paper']);
  assert.deepEqual(upcoming(state, '2026-11-11', 2).map((r) => r.id), ['rec_streamly', 'rec_paper', 'rec_laundry']);
  assert.deepEqual(upcoming(state, '2026-11-12', 1).map((r) => r.id), ['rec_laundry']);
  assert.deepEqual(upcoming(state, '2026-11-13', 6), []); // 13..18 Nov: nothing until the 19th
  assert.deepEqual(upcoming(state, '2026-11-11', 0), []);
  assert.deepEqual(upcoming(state, '2026-11-11', -5), []);
});

test('upcoming: an empty or broken document gives no rows', () => {
  assert.deepEqual(upcoming(defaultState(0), '2026-11-11', 30), []);
  assert.deepEqual(upcoming({}, '2026-11-11', 30), []);
  assert.deepEqual(upcoming(null, '2026-11-11', 30), []);
  assert.deepEqual(upcoming(bookState([anchorless, ...malformed]), '2026-11-11', 60), []);
  assert.deepEqual(upcoming(bookState([rent]), 'today', 30), []);
  assert.deepEqual(upcoming(bookState([rent]), '2026-11-11', NaN), []);
  assert.deepEqual(upcoming(bookState([rent]), '2026-11-11', undefined), []);
});

/* ---------------------------------------------------------------------- totals */

test('bookTotals: the active Book per month, year and day, with breakdowns that add up', () => {
  const totals = bookTotals(bookState([rent, streamly, studio, laundry, insurance, ended, ...malformed]));
  // per month: rent 180000, Streamly 1599, Looplab 24000/12 = 2000, Washhouse 52000/12 = 4333.33 -> 4333,
  //            Harbour Mutual 120000/12 = 10000
  assert.equal(totals.count, 5);
  assert.equal(totals.perMonth, 197932);
  assert.equal(totals.perYear, 2160000 + 19188 + 24000 + 52000 + 120000);
  // per day: 180000/30.4375 + 1599/30.4375 + 24000/365.25 + 1000/7 + 60000/182.625 = 6503.399...
  assert.equal(totals.perDay, 6503);
  assert.deepEqual(totals.byPurpose, [
    { purpose: 'personal', perMonth: 185932 },
    { purpose: 'work', perMonth: 10000 },
    { purpose: 'studio', perMonth: 2000 },
  ]);
  assert.deepEqual(totals.byCategory, [
    { category: 'housing', perMonth: 180000 },
    { category: 'insurance', perMonth: 10000 },
    { category: 'household', perMonth: 4333 },
    { category: 'subscriptions', perMonth: 3599 },
  ]);
  assert.equal(totals.review, 12000);
  assert.equal(totals.cut, 1599); // the ended gym is not counted
});

test('bookTotals: an empty or broken document totals zero', () => {
  const empty = { count: 0, perMonth: 0, perYear: 0, perDay: 0, byPurpose: [], byCategory: [], review: 0, cut: 0 };
  assert.deepEqual(bookTotals(defaultState(0)), empty);
  assert.deepEqual(bookTotals({}), empty);
  assert.deepEqual(bookTotals(null), empty);
  assert.deepEqual(bookTotals(bookState([ended, null, makeRecurring({ amount: NaN })])), empty);
});

test('bookTotals: an entry without a usable anchor still costs money', () => {
  const totals = bookTotals(bookState([makeRecurring({ amount: 1200, cadence: 'monthly', anchor: '', purpose: '', category: '' })]));
  assert.equal(totals.count, 1);
  assert.equal(totals.perMonth, 1200);
  assert.deepEqual(totals.byPurpose, [{ purpose: 'personal', perMonth: 1200 }]);
  assert.deepEqual(totals.byCategory, [{ category: 'other', perMonth: 1200 }]);
});

/* -------------------------------------------------------------------- renewals */

test('renewals: quarterly and longer only, soonest first, with what has accrued', () => {
  const state = bookState([rent, laundry, studio, insurance, water, ended, anchorless, ...malformed]);
  assert.deepEqual(renewals(state, '2026-11-11', 60), [ // 11 Nov .. 9 Jan
    // previous 20 Aug: 83 days ago; 4500 × 83 / 91.3125 = 4090.35
    { id: 'rec_water', name: 'Town Water', day: '2026-11-20', amount: 4500, inDays: 9, setAside: 4090 },
    // previous 1 Dec 2025: 345 days ago; 24000 × 345 / 365.25 = 22669.40
    { id: 'rec_studio', name: 'Looplab', day: '2026-12-01', amount: 24000, inDays: 20, setAside: 22669 },
    // previous 5 Jul: 129 days ago; 60000 × 129 / 182.625 = 42381.93
    { id: 'rec_ins', name: 'Harbour Mutual', day: '2027-01-05', amount: 60000, inDays: 55, setAside: 42382 },
  ]);
});

test('renewals: the window is fromDay inclusive for `days` days', () => {
  const state = bookState([water]);
  assert.deepEqual(renewals(state, '2026-11-11', 9), []);                                  // ends 19 Nov
  assert.deepEqual(renewals(state, '2026-11-11', 10).map((r) => r.day), ['2026-11-20']);
  const dueToday = renewals(state, '2026-11-20', 1);
  assert.equal(dueToday.length, 1);
  assert.equal(dueToday[0].inDays, 0);
  // previous 20 Aug: 92 days ago, longer than the 91.3125-day cadence: capped at the amount
  assert.equal(dueToday[0].setAside, 4500);
});

test('renewals: set-aside is capped at the amount across a leap year', () => {
  const yearly = makeRecurring({ id: 'rec_domain', name: 'Namehold', amount: 2000, cadence: 'annual', anchor: '2024-02-10' });
  // 10 Feb 2024 -> 10 Feb 2025 is 366 days; 366 / 365.25 > 1
  assert.deepEqual(renewals(bookState([yearly]), '2025-02-10', 30), [
    { id: 'rec_domain', name: 'Namehold', day: '2025-02-10', amount: 2000, inDays: 0, setAside: 2000 },
  ]);
  // the day after the renewal the next one is a year off and nothing is due in the window
  assert.deepEqual(renewals(bookState([yearly]), '2025-02-11', 30), []);
});

test('renewals: a second renewal in the window has nothing set aside yet', () => {
  const rows = renewals(bookState([water]), '2026-11-11', 120); // 11 Nov .. 10 Mar
  assert.deepEqual(rows, [
    { id: 'rec_water', name: 'Town Water', day: '2026-11-20', amount: 4500, inDays: 9, setAside: 4090 },
    { id: 'rec_water', name: 'Town Water', day: '2027-02-20', amount: 4500, inDays: 101, setAside: 0 },
  ]);
});

test('renewals: accrual restarts at each occurrence', () => {
  const box = makeRecurring({ id: 'rec_q', name: 'Quarterly Box', amount: 9000, cadence: 'quarterly', anchor: '2026-11-11' });
  // the day after a renewal: 1 day accrued toward 11 Feb; 9000 × 1 / 91.3125 = 98.56
  assert.deepEqual(renewals(bookState([box]), '2026-11-12', 95), [
    { id: 'rec_q', name: 'Quarterly Box', day: '2027-02-11', amount: 9000, inDays: 91, setAside: 99 },
  ]);
  // half-way: 26 Dec is 45 days after 11 Nov; 9000 × 45 / 91.3125 = 4435.32
  assert.equal(renewals(bookState([box]), '2026-12-26', 60)[0].setAside, 4435);
});

test('renewals: broken input gives no rows', () => {
  assert.deepEqual(renewals(null, '2026-11-11', 60), []);
  assert.deepEqual(renewals({}, '2026-11-11', 60), []);
  assert.deepEqual(renewals(bookState([anchorless, ...malformed]), '2026-11-11', 400), []);
  assert.deepEqual(renewals(bookState([water]), 'soon', 60), []);
  assert.deepEqual(renewals(bookState([water]), '2026-11-11', NaN), []);
  assert.deepEqual(renewals(bookState([water]), '2026-11-11', 0), []);
});

test('the Book is not mutated by any query', () => {
  const state = bookState([rent, streamly, studio, laundry, insurance, water]);
  const before = JSON.stringify(state);
  upcoming(state, '2026-11-11', 90);
  bookTotals(state);
  renewals(state, '2026-11-11', 365);
  assert.equal(JSON.stringify(state), before);
});

test('upcoming: an occurrence that has already been charged is not upcoming', () => {
  const state = {
    recurring: [{ id: 'rec_net', name: 'Streaming', amount: 1799, cadence: 'monthly', anchor: '2026-06-10', active: true, category: 'subscriptions', purpose: 'personal' }],
    txs: [{ id: 't1', recurringId: 'rec_net', day: '2026-06-10', kind: 'spend', amount: 1799 }],
  };
  assert.deepEqual(upcoming(state, '2026-06-10', 40).map((r) => r.day), ['2026-07-10'], 'the charge dated today has posted');
  state.txs = [];
  assert.deepEqual(upcoming(state, '2026-06-10', 40).map((r) => r.day), ['2026-06-10', '2026-07-10'], 'not yet posted: still due today');
});

test('renewals: nothing has accrued toward a hand-entered line whose first charge is still ahead', () => {
  const line = { id: 'rec_ins', name: 'Policy', amount: 12000, cadence: 'semiannual', anchor: '2026-07-02', active: true, source: 'manual' };
  const ahead = renewals({ recurring: [line], txs: [] }, '2026-06-10', 120);
  assert.deepEqual(ahead.map((r) => [r.day, r.setAside]), [['2026-07-02', 0]]);
  const past = renewals({ recurring: [{ ...line, anchor: '2026-01-02' }], txs: [] }, '2026-06-10', 120);
  assert.equal(past[0].day, '2026-07-02');
  assert.ok(past[0].setAside > 10000, 'an anchor in the past is a real charge to count from');
});

test('a line added by hand has no occurrence before its anchor, or before the day it was added', () => {
  const ahead = { cadence: 'monthly', anchor: '2026-07-20', source: 'manual' };
  assert.equal(nextOccurrence(ahead, '2026-06-09'), '2026-07-20', 'a first charge on Jul 20 is not also expected on Jun 20');
  assert.equal(lastOccurrence(ahead, '2026-07-19'), null);
  assert.deepEqual(occurrences(ahead, '2026-05-01', '2026-09-01'), ['2026-07-20', '2026-08-20']);
  assert.equal(nextOccurrence({ ...ahead, source: 'detected' }, '2026-06-09'), '2026-06-20', 'a detected schedule still runs both ways');

  const added = { cadence: 'monthly', anchor: '2026-05-20', source: 'manual', since: '2026-06-10' };
  assert.deepEqual(occurrences(added, '2026-04-01', '2026-07-31'), ['2026-06-20', '2026-07-20']);
  assert.equal(lastOccurrence(added, '2026-06-15'), null);

  const state = defaultState(0);
  state.recurring.push(makeRecurring({ id: 'rec_gym', name: 'Harbor Gym', cadence: 'monthly', anchor: '2026-07-20', amount: 4500, source: 'manual', since: '2026-06-10' }));
  assert.deepEqual(upcoming(state, '2026-06-10', 75).map((row) => row.day), ['2026-07-20', '2026-08-20']);
});
