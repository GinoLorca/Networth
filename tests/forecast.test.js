import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPayoff, incomeLadder, pace, paceMinDays, projectNetWorth, purchaseImpact, reserveGoal } from '../js/model/forecast.js';
import { makeLedger } from '../js/model/ledger.js';
import { defaultState, makeAccount, makeRecurring, makeStream, makeTx } from '../js/model/schema.js';

/* Every figure below is invented. June 2026 has 30 days and no clock change anywhere near it. */

/** Local time, so the tests read the same in every time zone. */
const at = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();

/** Wednesday 10 June 2026 at noon. The 1st was a Monday. */
const NOW = at(2026, 6, 10);
const TODAY = '2026-06-10';

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);

function assertNoNaN(value, path = 'result') {
  if (typeof value === 'number') assert.ok(!Number.isNaN(value), path + ' is NaN');
  else if (Array.isArray(value)) value.forEach((item, i) => assertNoNaN(item, path + '[' + i + ']'));
  else if (value && typeof value === 'object') for (const key of Object.keys(value)) assertNoNaN(value[key], path + '.' + key);
}

let sequence = 0;

function tx(accountId, day, amount, fields = {}) {
  sequence += 1;
  return makeTx({ id: 'tx_' + sequence, accountId, day, postedDay: day, amount, loggedAt: at(2026, 3, 1) + sequence, ...fields });
}

const spend = (accountId, day, amount, category) => tx(accountId, day, amount, { category });
const income = (day, amount, streamId = null, fields = {}) =>
  tx('acc_chk', day, amount, { flow: 'in', kind: 'income', category: 'income', streamId, ...fields });

const bankAccount = (id, type, balance, fields = {}) =>
  makeAccount({ id, source: 'bank', type, balance, basis: 'bank', name: id, asOf: at(2026, 6, 10, 9), ...fields });

/**
 * A fictional household: $2,000.00 in checking, $4,000.00 in savings (the reserve), $3,000.00 owed on
 * a card at 24%. Net worth at the bank: $3,000.00. Pay is counted when it arrives (nothing accrues),
 * so a day's result is simply what came in less what went out.
 *
 * History begins on 30 March: 73 days up to and including today — a fifth of a year.
 *
 *   salary   $1,500.00 on 3 Apr, 17 Apr, 1 May, 15 May, 29 May      7,500.00
 *   lessons  $400.00 on 20 Apr, $600.00 on 4 May                     1,000.00
 *   unlinked $100.00 on 25 Apr                                         100.00
 *
 * The 30 completed days before today (11 May – 9 June):
 *   earned  1,500.00 + 1,500.00                                      3,000.00
 *   bills   rent on 20 May                                             900.00
 *   spent   70.00 + 50.00 (card) + 10.00 (cafe) + 80.00 (groceries)    210.00
 *   result                                                           1,890.00  = $63.00 a day
 */
function household() {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(
    bankAccount('acc_chk', 'checking', 200000),
    bankAccount('acc_sav', 'savings', 400000),
    bankAccount('acc_card', 'credit_card', -300000, { apr: 24 }),
  );
  state.streams.push(
    makeStream({
      id: 'str_pay', name: 'Northwind Payroll', mkey: 'northwind', kind: 'salary', accountId: 'acc_chk',
      cadence: 'biweekly', anchor: '2026-05-29', amount: 150000,
    }),
    makeStream({ id: 'str_les', name: 'Lessons', mkey: 'lessons', kind: 'lessons', accountId: 'acc_chk' }),
  );
  state.txs.push(
    spend('acc_chk', '2026-03-30', 5000, 'groceries'),
    income('2026-04-03', 150000, 'str_pay'),
    income('2026-04-17', 150000, 'str_pay'),
    income('2026-04-20', 40000, 'str_les'),
    income('2026-04-25', 10000),
    income('2026-05-01', 150000, 'str_pay'),
    income('2026-05-04', 60000, 'str_les'),
    income('2026-05-15', 150000, 'str_pay'),
    spend('acc_chk', '2026-05-20', 90000, 'housing'),
    spend('acc_card', '2026-05-22', 7000, 'shopping'),
    income('2026-05-29', 150000, 'str_pay'),
    spend('acc_card', '2026-06-02', 5000, 'shopping'),
    spend('acc_chk', '2026-06-03', 1000, 'cafe'),
    tx('acc_chk', '2026-06-05', 30000, { kind: 'payment', category: 'card_payment', pairId: 'tx_pair_card' }),
    tx('acc_card', '2026-06-05', 30000, { id: 'tx_pair_card', flow: 'in', kind: 'payment', category: 'card_payment' }),
    spend('acc_chk', '2026-06-08', 8000, 'groceries'),
  );
  state.sync.lastOk = at(2026, 6, 10, 9);
  return state;
}

/**
 * The household with a match in progress since 1 June: Habit plays $15.00 on a workday and $20.00 on
 * a day off. Nine rounds are over (1–9 June: seven workdays, two days off), so Habit played
 * 7 × 15.00 + 2 × 20.00 = 145.00 and the owner's only convenience spend was the $10.00 cafe:
 * kept 135.00, or $15.00 a round.
 */
function householdInMatch() {
  const state = household();
  state.meta.matchStart = '2026-06-01';
  state.habits.push({ from: '2026-06-01', work: 1500, off: 2000, winWork: 700, winOff: 1000, basis: 'computed', window: null, backtest: null });
  return state;
}

/**
 * A salaried owner whose pay accrues: $1,400.00 every two weeks is $100.00 a day, earned whether or
 * not it is payday. One $300.00 grocery run on 20 May. $5,000.00 in checking.
 */
function salaried() {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_chk', 'checking', 500000));
  state.streams.push(makeStream({
    id: 'str_pay', name: 'Northwind Payroll', mkey: 'northwind', kind: 'salary', accountId: 'acc_chk',
    cadence: 'biweekly', anchor: '2026-05-29', amount: 140000, accrue: true,
  }));
  state.txs.push(
    income('2026-05-01', 140000, 'str_pay'),
    income('2026-05-15', 140000, 'str_pay'),
    spend('acc_chk', '2026-05-20', 30000, 'groceries'),
    income('2026-05-29', 140000, 'str_pay'),
  );
  state.sync.lastOk = at(2026, 6, 10, 9);
  return state;
}

/** A document whose history is the last `days` completed days: one cafe stop of $5.00 on each. */
function youngDocument(days) {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_chk', 'checking', 100000));
  for (let d = 10 - days; d <= 9; d++) state.txs.push(spend('acc_chk', '2026-06-0' + d, 500, 'cafe'));
  state.sync.lastOk = at(2026, 6, 10, 9);
  return state;
}

/* -------------------------------------------------------------------- pace */

test('pace: thirty completed days of history, measured from the daily closes', () => {
  assert.deepEqual(pace(household(), NOW), {
    days: 30,
    perDay: 6300,
    // 6,300 × 30.4375 = 191,756.25
    perMonth: 191756,
    earnedPerDay: 10000,
    spentPerDay: 700,
    billsPerDay: 3000,
  });
});

test('pace: five days of history say nothing', () => {
  assert.equal(pace(youngDocument(5), NOW), null);
  assert.equal(pace(youngDocument(6), NOW), null);
});

test('pace: under one full pay cycle, or under 14 days, nothing is extrapolated', () => {
  // no regular pay known: the cycle is taken as a month
  const withDays = (count) => {
    const state = youngDocument(9);
    for (let d = 31; d > 31 - (count - 9); d--) state.txs.push(spend('acc_chk', '2026-05-' + d, 500, 'cafe'));
    return state;
  };
  assert.equal(pace(youngDocument(7), NOW), null);
  assert.equal(pace(withDays(13), NOW), null);
  assert.equal(pace(withDays(29), NOW), null);
  assert.deepEqual(pace(withDays(30), NOW), {
    days: 30, perDay: -500, perMonth: -15219, earnedPerDay: 0, spentPerDay: 500, billsPerDay: 0,
  });
  // a window the caller chose is asked for no more than itself (seven days at least)
  assert.equal(pace(youngDocument(7), NOW, 7).days, 7);
});

test('pace: the window can be chosen, and today is never in it', () => {
  // 21 May – 9 June: one paycheck (1,500.00) less 210.00 spent; the rent of 20 May is outside.
  assert.deepEqual(pace(household(), NOW, 20), {
    days: 20,
    perDay: 6450,
    // 6,450 × 30.4375 = 196,321.875
    perMonth: 196322,
    earnedPerDay: 7500,
    spentPerDay: 1050,
    billsPerDay: 0,
  });

  const state = household();
  state.txs.push(spend('acc_chk', TODAY, 99900, 'shopping'));
  assert.equal(pace(state, NOW).perDay, 6300);
});

test('pace: a window below seven days is null, and a bad window falls back to thirty', () => {
  assert.equal(pace(household(), NOW, 5), null);
  for (const days of [undefined, null, NaN, 0, -4, 'month']) assert.equal(pace(household(), NOW, days).days, 30);
  assert.equal(pace(household(), NOW, 20.9).days, 20);
});

test('pace: a window longer than the history uses the history there is', () => {
  // 30 March – 9 June is 72 days: 8,600.00 in, 900.00 rent, 260.00 spent.
  const measured = pace(household(), NOW, 365);
  assert.equal(measured.days, 72);
  near(measured.perDay, 744000 / 72);
  near(measured.earnedPerDay, 860000 / 72);
  near(measured.billsPerDay, 90000 / 72);
  near(measured.spentPerDay, 26000 / 72);
});

test('pace: pay that accrues is earned every day, payday or not', () => {
  // 30 days × 100.00 earned, 300.00 spent: 2,700.00, or $90.00 a day.
  assert.deepEqual(pace(salaried(), NOW), {
    days: 30,
    perDay: 9000,
    // 9,000 × 30.4375 = 273,937.5
    perMonth: 273938,
    earnedPerDay: 10000,
    spentPerDay: 1000,
    billsPerDay: 0,
  });
});

test('pace: transfers and card payments between the owner\'s accounts do not move it', () => {
  const state = household();
  state.txs.push(
    tx('acc_chk', '2026-06-01', 50000, { kind: 'transfer', category: 'transfer', pairId: 'tx_to_savings' }),
    tx('acc_sav', '2026-06-01', 50000, { id: 'tx_to_savings', flow: 'in', kind: 'transfer', category: 'transfer' }),
  );
  assert.equal(pace(state, NOW).perDay, 6300);
});

test('pace: no transactions, no pace', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_chk', 'checking', 100000));
  assert.equal(pace(state, NOW), null);
});

/* --------------------------------------------------------- projectNetWorth */

test('projectNetWorth: three lines from the live number', () => {
  const state = householdInMatch();
  assert.deepEqual(projectNetWorth(state, NOW, { months: 3 }), {
    start: 300000,
    months: 3,
    lines: [
      // 191,756.25 a month
      { key: 'pace', label: 'At this pace', points: [300000, 491756, 683513, 875269] },
      // scenario.monthlyImprove = 600.00 a month
      { key: 'scenario', label: 'Scenario', points: [300000, 360000, 420000, 480000] },
      // 63.00 − 15.00 kept a day = 48.00 a day = 1,461.00 a month
      { key: 'habit', label: 'At habit', points: [300000, 446100, 592200, 738300] },
    ],
  });
});

test('projectNetWorth: no habit line before a match has begun', () => {
  const projection = projectNetWorth(household(), NOW, { months: 2 });
  assert.deepEqual(projection.lines.map((line) => line.key), ['pace', 'scenario']);

  const notYet = householdInMatch();
  notYet.meta.matchStart = '2026-06-20';
  assert.deepEqual(projectNetWorth(notYet, NOW).lines.map((line) => line.key), ['pace', 'scenario']);

  const firstDay = householdInMatch();
  firstDay.meta.matchStart = TODAY;
  assert.deepEqual(projectNetWorth(firstDay, NOW).lines.map((line) => line.key), ['pace', 'scenario']);
});

test('projectNetWorth: with too little history only the scenario is drawn', () => {
  const state = youngDocument(5);
  state.meta.matchStart = '2026-06-05';
  state.habits.push({ from: '2026-06-05', work: 1500, off: 2000, winWork: 700, winOff: 1000, basis: 'computed', window: null, backtest: null });
  assert.deepEqual(projectNetWorth(state, NOW, { months: 2 }), {
    start: 100000,
    months: 2,
    lines: [{ key: 'scenario', label: 'Scenario', points: [100000, 160000, 220000] }],
  });
});

test('projectNetWorth: the horizon is the one asked for, else the scenario\'s, else two years', () => {
  const state = household();
  const projection = projectNetWorth(state, NOW);
  assert.equal(projection.months, 24);
  for (const line of projection.lines) assert.equal(line.points.length, 25);
  assert.equal(projection.lines[1].points[24], 300000 + 24 * 60000);

  state.scenario.horizonMonths = 6;
  assert.equal(projectNetWorth(state, NOW).months, 6);
  assert.equal(projectNetWorth(state, NOW, { months: 12 }).months, 12);
  assert.equal(projectNetWorth(state, NOW, { months: 0 }).months, 6);
  assert.equal(projectNetWorth(state, NOW, { months: 2.7 }).months, 2);
  assert.equal(projectNetWorth(state, NOW, null).months, 6);

  state.scenario.horizonMonths = 'two years';
  assert.equal(projectNetWorth(state, NOW).months, 24);
  assert.equal(projectNetWorth(state, NOW, { months: 1e9 }).months, 600);
});

test('projectNetWorth: starts from the smoothed live number, in whole cents', () => {
  // 5,000.00 at the bank + pay earned since 29 May: 12 whole days and a third of today at 100.00 a day.
  const projection = projectNetWorth(salaried(), NOW, { months: 1 });
  assert.equal(projection.start, 623333);
  assert.deepEqual(projection.lines[0], { key: 'pace', label: 'At this pace', points: [623333, 623333 + 273938] });
  for (const line of projection.lines) assert.equal(line.points[0], projection.start);
});

test('projectNetWorth: a losing pace is drawn falling, exactly as measured', () => {
  const state = household();
  state.txs = state.txs.filter((row) => row.kind !== 'income');
  // No pay: 900.00 rent + 210.00 spent in 30 days = −37.00 a day = −1,126.1875 a month.
  // Each point is rounded on its own: 187,381.25 · 74,762.5 (a half rounds up) · −37,856.25.
  const [paceLine] = projectNetWorth(state, NOW, { months: 3 }).lines;
  assert.deepEqual(paceLine.points, [300000, 187381, 74763, -37856]);
});

/* ------------------------------------------------------------- reserveGoal */

test('reserveGoal: how far the reserve is and when each rate would close the gap', () => {
  assert.deepEqual(reserveGoal(household(), NOW), {
    target: 1000000,
    have: 400000,
    gap: 600000,
    fraction: 0.4,
    // 6,000.00 at 63.00 a day is 95.2 days, in the 4th month: the date is 4 months from 10 June.
    atPace: { months: 4, day: '2026-10-10' },
    // 6,000.00 at 150.00 a month is 40 months, and the date is 40 months on.
    atScenario: { months: 40, day: '2029-10-10' },
  });
});

test('reserveGoal: a rate that divides the gap exactly is not rounded up a month', () => {
  const state = household();
  state.scenario.toSavings = 200000;
  // 3 months exactly: 91.3125 days, so 92 days on.
  assert.deepEqual(reserveGoal(state, NOW).atScenario, { months: 3, day: '2026-09-10' });
});

test('reserveGoal: a goal already met is today', () => {
  const state = household();
  state.goals.reserve.target = 350000;
  assert.deepEqual(reserveGoal(state, NOW), {
    target: 350000, have: 400000, gap: 0, fraction: 1,
    atPace: { months: 0, day: TODAY },
    atScenario: { months: 0, day: TODAY },
  });
});

test('reserveGoal: no date at a pace that is unknown, flat or falling, or with nothing set aside', () => {
  const unknown = youngDocument(5);
  assert.deepEqual(reserveGoal(unknown, NOW).atPace, { months: null, day: null });
  assert.equal(reserveGoal(unknown, NOW).atScenario.months, 60);

  const falling = household();
  falling.txs = falling.txs.filter((row) => row.kind !== 'income');
  assert.deepEqual(reserveGoal(falling, NOW).atPace, { months: null, day: null });

  for (const toSavings of [0, -500, NaN, undefined, 'some']) {
    const state = household();
    state.scenario.toSavings = toSavings;
    assert.deepEqual(reserveGoal(state, NOW).atScenario, { months: null, day: null });
  }
});

test('reserveGoal: a rate that would take more than a century is no date at all', () => {
  const state = household();
  state.scenario.toSavings = 1;
  assert.deepEqual(reserveGoal(state, NOW).atScenario, { months: null, day: null });
});

test('reserveGoal: without a flagged reserve account all cash counts; without a target the bar is full', () => {
  const state = household();
  state.accounts[1].reserve = false;
  const all = reserveGoal(state, NOW);
  assert.equal(all.have, 600000);
  assert.equal(all.gap, 400000);
  assert.equal(all.fraction, 0.6);

  state.goals.reserve.target = 0;
  const none = reserveGoal(state, NOW);
  assert.equal(none.target, 0);
  assert.equal(none.gap, 0);
  assert.equal(none.fraction, 1);
});

/* ------------------------------------------------------------ incomeLadder */

test('incomeLadder: a partial history is annualised, and salary is grossed up', () => {
  const ladder = incomeLadder(household(), NOW);
  assert.equal(ladder.received, 860000);
  assert.equal(ladder.days, 73);
  assert.equal(ladder.partial, true);
  // 8,600.00 in 73 days × 365 / 73 = 43,000.00 a year.
  assert.equal(ladder.annualised, 4300000);
  // Salary 7,500.00 / 0.75 = 10,000.00 gross; with the other 1,100.00: 11,100.00 × 5 = 55,500.00.
  assert.equal(ladder.grossApprox, 5550000);

  assert.deepEqual(ladder.byStream.map((row) => [row.id, row.name, row.kind, row.received]), [
    ['str_pay', 'Northwind Payroll', 'salary', 750000],
    ['str_les', 'Lessons', 'lessons', 100000],
    [null, 'Other income', 'other', 10000],
  ]);
  near(ladder.byStream[0].share, 750000 / 860000);
  near(ladder.byStream[1].share, 100000 / 860000);
  near(ladder.byStream[2].share, 10000 / 860000);
  near(ladder.byStream.reduce((total, row) => total + row.share, 0), 1);

  assert.deepEqual(ladder.ladder, [
    { target: 10000000, reached: false, fraction: 0.555 },
    { target: 20000000, reached: false, fraction: 0.2775 },
    { target: 50000000, reached: false, fraction: 0.111 },
    { target: 100000000, reached: false, fraction: 0.0555 },
  ]);
  assert.deepEqual(ladder.next, { target: 10000000, gap: 4450000, fraction: 0.555 });

  assert.equal(ladder.final.target, 100000000);
  assert.equal(ladder.final.by, '2029-12-31');
  // 10 June 2026 to 31 December 2029 is 1,300 days.
  near(ladder.final.requiredGrowth, Math.pow(100000000 / 5550000, 365.25 / 1300) - 1, 1e-9);
  assert.ok(ladder.final.requiredGrowth > 1.25 && ladder.final.requiredGrowth < 1.26);
});

test('incomeLadder: only streams of kind salary are grossed up', () => {
  const state = household();
  state.streams[0].kind = 'other';
  const ladder = incomeLadder(state, NOW);
  assert.equal(ladder.annualised, 4300000);
  assert.equal(ladder.grossApprox, 4300000);

  const allSalary = household();
  allSalary.streams[1].kind = 'salary';
  // (8,500.00 / 0.75 + 100.00) × 5
  assert.equal(incomeLadder(allSalary, NOW).grossApprox, Math.round((850000 / 0.75 + 10000) * 5));
});

test('incomeLadder: an unusable take-home ratio leaves take-home as it is', () => {
  for (const share of [0, -0.5, 1.5, NaN, undefined, '0.75']) {
    const state = household();
    state.scenario.takeHomeRatio = share;
    assert.equal(incomeLadder(state, NOW).grossApprox, 4300000);
  }
  const half = household();
  half.scenario.takeHomeRatio = 0.5;
  // (7,500.00 / 0.5 + 1,100.00) × 5
  assert.equal(incomeLadder(half, NOW).grossApprox, 8050000);
});

test('incomeLadder: a full year of history is counted as received, never scaled', () => {
  const state = household();
  state.txs.push(
    spend('acc_chk', '2025-01-15', 900, 'cafe'),
    income('2025-06-10', 500000, 'str_pay'), // 365 days before today: outside the trailing year
    income('2025-06-11', 20000, 'str_les'),  // 364 days before today: its first day
  );
  const ladder = incomeLadder(state, NOW);
  assert.equal(ladder.days, 365);
  assert.equal(ladder.partial, false);
  assert.equal(ladder.received, 880000);
  assert.equal(ladder.annualised, 880000);
  // 7,500.00 / 0.75 + 1,300.00
  assert.equal(ladder.grossApprox, 1130000);
  assert.equal(ladder.byStream[1].received, 120000);
});

test('incomeLadder: rungs reached, the next rung, and a ladder already climbed', () => {
  const state = household();
  state.goals.income.ladder = [10000000, 5000000, 5000000, 5550000];
  const ladder = incomeLadder(state, NOW);
  assert.deepEqual(ladder.ladder, [
    { target: 5000000, reached: true, fraction: 1 },
    { target: 5550000, reached: true, fraction: 1 },
    { target: 10000000, reached: false, fraction: 0.555 },
  ]);
  assert.deepEqual(ladder.next, { target: 10000000, gap: 4450000, fraction: 0.555 });
  assert.equal(ladder.final.target, 10000000);

  state.goals.income.ladder = [2000000, 4000000];
  const climbed = incomeLadder(state, NOW);
  assert.equal(climbed.next, null);
  assert.ok(climbed.ladder.every((rung) => rung.reached));
  // Already above the final rung: the growth still needed is negative.
  assert.ok(climbed.final.requiredGrowth < 0);
});

test('incomeLadder: only income the bank reported on a visible account counts', () => {
  const state = household();
  state.accounts.push(bankAccount('acc_old', 'checking', 0, { hidden: true }));
  state.txs.push(
    tx('acc_chk', '2026-05-10', 7000, { flow: 'in', kind: 'refund', category: 'shopping' }),
    tx('acc_chk', '2026-05-11', 90000, { flow: 'in', kind: 'transfer', category: 'transfer' }),
    tx('acc_old', '2026-05-12', 80000, { flow: 'in', kind: 'income', category: 'income' }),
    income('2026-05-13', 60000, null, { source: 'manual' }),
    income('2026-05-14', 60000, null, { matchId: 'tx_1' }),
    income('2026-06-11', 60000),
    income('not a day', 60000),
    income('2026-05-16', NaN),
    tx('acc_chk', '2026-05-17', 60000, { flow: 'out', kind: 'income', category: 'income' }),
  );
  assert.equal(incomeLadder(state, NOW).received, 860000);
});

test('incomeLadder: pending income counts only while the owner counts pending rows', () => {
  const state = household();
  state.txs.push(income(TODAY, 25000, 'str_les', { pending: true, postedDay: null }));
  assert.equal(incomeLadder(state, NOW).received, 885000);
  state.settings.countPending = false;
  assert.equal(incomeLadder(state, NOW).received, 860000);
});

test('incomeLadder: income of a stream that no longer exists is unlinked income', () => {
  const state = household();
  state.streams.pop();
  const ladder = incomeLadder(state, NOW);
  assert.deepEqual(ladder.byStream.map((row) => [row.id, row.received]), [['str_pay', 750000], [null, 110000]]);
});

test('incomeLadder: no income, no growth rate and nothing divided by zero', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_chk', 'checking', 100000));
  assert.deepEqual(incomeLadder(state, NOW), {
    received: 0, days: 0, partial: true, thin: true, annualised: 0, grossApprox: 0, byStream: [],
    ladder: [10000000, 20000000, 50000000, 100000000].map((target) => ({ target, reached: false, fraction: 0 })),
    next: { target: 10000000, gap: 10000000, fraction: 0 },
    final: { target: 100000000, by: '2029-12-31', requiredGrowth: null },
  });

  const spendingOnly = youngDocument(5);
  const ladder = incomeLadder(spendingOnly, NOW);
  assert.equal(ladder.days, 6);
  assert.equal(ladder.received, 0);
  assert.equal(ladder.final.requiredGrowth, null);
});

test('incomeLadder: a deadline that has passed or is unreadable gives no growth rate', () => {
  for (const by of ['2026-06-10', '2020-01-01', 'soon', null, 20291231]) {
    const state = household();
    state.goals.income.by = by;
    const { final } = incomeLadder(state, NOW);
    assert.equal(final.requiredGrowth, null);
    assert.equal(final.by, typeof by === 'string' ? by : '');
  }
});

/* -------------------------------------------------------------- cardPayoff */

test('cardPayoff: with a rate — months, interest and a schedule that reaches zero', () => {
  // 3,000.00 at 24% (2% a month) paying 300.00: −ln(1 − 0.2) / ln(1.02) = 11.268 months,
  // so 11 full payments and a last one of 80.51. Interest: 11 × 300.00 + 80.51 − 3,000.00.
  const plan = cardPayoff(household(), NOW);
  assert.equal(plan.owed, 300000);
  assert.equal(plan.apr, 24);
  assert.equal(plan.payment, 30000);
  assert.equal(plan.months, 12);
  assert.equal(plan.interest, 38051);
  assert.equal(plan.never, false);
  assert.equal(plan.schedule.length, 13);
  assert.deepEqual(plan.schedule.slice(0, 3), [
    { month: 0, owed: 300000 },
    { month: 1, owed: 276000 },  // + 60.00 interest − 300.00
    { month: 2, owed: 251520 },  // + 55.20 interest − 300.00
  ]);
  assert.deepEqual(plan.schedule[12], { month: 12, owed: 0 });
  plan.schedule.forEach((row, i) => {
    assert.equal(row.month, i);
    if (i > 0) assert.ok(row.owed < plan.schedule[i - 1].owed);
  });
});

test('cardPayoff: without a rate the months are counted at 0% and the interest is unknown', () => {
  const state = household();
  state.accounts[2].apr = null;
  const plan = cardPayoff(state, NOW);
  assert.equal(plan.apr, null);
  assert.equal(plan.months, 10);
  assert.equal(plan.interest, null);
  assert.equal(plan.never, false);
  assert.deepEqual(plan.schedule, Array.from({ length: 11 }, (_, month) => ({ month, owed: 300000 - 30000 * month })));
});

test('cardPayoff: a payment that only covers the interest never clears the balance', () => {
  const state = household();
  state.scenario.cardPayment = 6000;
  state.scenario.horizonMonths = 6;
  const level = cardPayoff(state, NOW);
  assert.equal(level.months, null);
  assert.equal(level.interest, null);
  assert.equal(level.never, true);
  // The schedule runs for the scenario horizon and goes nowhere.
  assert.deepEqual(level.schedule, Array.from({ length: 7 }, (_, month) => ({ month, owed: 300000 })));

  state.scenario.cardPayment = 5000;
  const rising = cardPayoff(state, NOW);
  assert.equal(rising.never, true);
  assert.equal(rising.schedule.length, 7);
  assert.deepEqual(rising.schedule.slice(0, 3), [
    { month: 0, owed: 300000 },
    { month: 1, owed: 301000 },  // + 60.00 interest − 50.00
    { month: 2, owed: 302020 },  // + 60.20 interest − 50.00
  ]);
});

test('cardPayoff: no payment at all is never, with or without a rate', () => {
  for (const payment of [0, -100, NaN, undefined, 'lots']) {
    const state = household();
    state.scenario.cardPayment = payment;
    const plan = cardPayoff(state, NOW);
    assert.equal(plan.payment, 0);
    assert.equal(plan.never, true);
    assert.equal(plan.months, null);
    assert.equal(plan.interest, null);
    assert.equal(plan.schedule.length, 25);
    assertNoNaN(plan);
  }
  const noRate = household();
  noRate.accounts[2].apr = null;
  noRate.scenario.cardPayment = 0;
  assert.equal(cardPayoff(noRate, NOW).never, true);
});

test('cardPayoff: several cards are taken together at their balance-weighted rate', () => {
  const state = household();
  state.accounts.push(bankAccount('acc_store', 'credit_card', -100000, { apr: 12 }));
  const plan = cardPayoff(state, NOW);
  assert.equal(plan.owed, 400000);
  // (3,000.00 × 24 + 1,000.00 × 12) / 4,000.00
  assert.equal(plan.apr, 21);
  assert.equal(plan.never, false);
  // First month: 4,000.00 × 21% / 12 = 70.00 interest − 300.00.
  assert.deepEqual(plan.schedule[1], { month: 1, owed: 377000 });

  state.accounts[3].apr = null;
  const unknown = cardPayoff(state, NOW);
  assert.equal(unknown.apr, null);
  assert.equal(unknown.months, 14); // 4,000.00 / 300.00 = 13.3
  assert.equal(unknown.interest, null);
});

test('cardPayoff: a card that is paid off or in credit does not need a rate', () => {
  const state = household();
  state.accounts.push(
    bankAccount('acc_zero', 'credit_card', 0),
    bankAccount('acc_credit', 'credit_card', 2500),
    bankAccount('acc_hidden', 'credit_card', -70000, { hidden: true }),
  );
  const plan = cardPayoff(state, NOW);
  assert.equal(plan.owed, 300000);
  assert.equal(plan.apr, 24);
  assert.equal(plan.months, 12);
});

test('cardPayoff: nothing owed is paid off now', () => {
  const state = household();
  state.accounts[2].balance = 0;
  assert.deepEqual(cardPayoff(state, NOW), {
    owed: 0, apr: null, payment: 30000, months: 0, interest: 0, never: false, schedule: [{ month: 0, owed: 0 }],
  });
});

/* ---------------------------------------------------------- purchaseImpact */

test('purchaseImpact: paid from cash', () => {
  // Cash on the clock: 2,000.00 + 4,000.00. Pay is 1,500.00 every 14 days, so 1,500.00 is 14 days of it.
  const impact = purchaseImpact(household(), NOW, { amount: 150000, on: 'cash' });
  assert.equal(impact.netWorth, -150000);
  assert.equal(impact.cashAfter, 450000);
  assert.equal(impact.shortfallAfter, 0);
  assert.equal(impact.cardMonthChange, null);
  near(impact.daysOfPay, 14);
  assert.equal(impact.sentence, '$1,500.00 from cash leaves $4,500.00 on the clock — about 14 days of pay.');
});

test('purchaseImpact: paid from cash, leaving less than what is due before payday', () => {
  const state = household();
  // Insurance of 500.00 falls due tomorrow, the day before the next payday (12 June).
  state.recurring.push(makeRecurring({
    id: 'rec_ins', name: 'Insurance', mkey: 'insurance', accountId: 'acc_chk', amount: 50000,
    cadence: 'monthly', anchor: '2026-05-11', category: 'insurance',
  }));
  const fine = purchaseImpact(state, NOW, { amount: 150000, on: 'cash' });
  assert.equal(fine.shortfallAfter, 0);

  const impact = purchaseImpact(state, NOW, { amount: 580000, on: 'cash' });
  assert.equal(impact.netWorth, -580000);
  assert.equal(impact.cashAfter, 20000);
  assert.equal(impact.shortfallAfter, 30000);
  assert.equal(impact.cardMonthChange, null);
  near(impact.daysOfPay, 580000 * 14 / 150000);
  assert.equal(impact.sentence,
    '$5,800.00 from cash leaves $200.00 on the clock, ≈$300.00 short of what is due before payday — about 54 days of pay.');
});

test('purchaseImpact: on a card it moves this month\'s pace and leaves the clock alone', () => {
  // June on the card: began at 3,250.00, 50.00 charged in 10 days, 3,000.00 owed now.
  // On pace to end at 3,000.00 + 50.00 / 10 × 20 = 3,100.00: 150.00 lower than it began.
  const impact = purchaseImpact(household(), NOW, { amount: 150000, on: 'card' });
  assert.equal(impact.netWorth, -150000);
  assert.equal(impact.cashAfter, 600000);
  assert.equal(impact.shortfallAfter, 0);
  assert.equal(impact.cardMonthChange, 135000);
  near(impact.daysOfPay, 14);
  assert.equal(impact.sentence,
    '$1,500.00 on the card puts this month on pace to end ≈$1,350.00 higher than it began — about 14 days of pay.'); // ruling R4d: a pace carries the sign
});

test('purchaseImpact: a card purchase smaller than the month\'s head start still ends lower, or level', () => {
  const lower = purchaseImpact(household(), NOW, { amount: 10000, on: 'card' });
  assert.equal(lower.cardMonthChange, -5000);
  assert.equal(lower.sentence,
    '$100.00 on the card puts this month on pace to end ≈$50.00 lower than it began — about 0.9 days of pay.'); // ruling R4d

  const level = purchaseImpact(household(), NOW, { amount: 15000, on: 'card' });
  assert.equal(level.cardMonthChange, 0);
  assert.equal(level.sentence,
    '$150.00 on the card puts this month on pace to end where it began — about 1.4 days of pay.');
});

test('purchaseImpact: a card purchase keeps the shortfall the clock already has', () => {
  const state = household();
  state.accounts[0].balance = 10000;
  state.accounts[1].balance = 0;
  state.recurring.push(makeRecurring({
    id: 'rec_ins', name: 'Insurance', mkey: 'insurance', accountId: 'acc_chk', amount: 50000,
    cadence: 'monthly', anchor: '2026-05-11', category: 'insurance',
  }));
  const impact = purchaseImpact(state, NOW, { amount: 20000, on: 'card' });
  assert.equal(impact.cashAfter, 10000);
  assert.equal(impact.shortfallAfter, 40000);
});

test('purchaseImpact: with no pay stream a purchase is not put in days of pay (ruling R2)', () => {
  const state = household();
  for (const stream of state.streams) stream.cadence = null;
  // 8,600.00 was received in 73 days of history, but no stream is scheduled: income, not pay.
  const impact = purchaseImpact(state, NOW, { amount: 86000, on: 'cash' });
  assert.equal(impact.daysOfPay, null);
  assert.equal(impact.sentence, '$860.00 from cash leaves $5,140.00 on the clock.');
});

test('purchaseImpact: with no pay known the sentence says nothing about pay, and no payday means two weeks', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_chk', 'checking', 20000));
  state.recurring.push(makeRecurring({
    id: 'rec_ins', name: 'Insurance', mkey: 'insurance', accountId: 'acc_chk', amount: 50000,
    cadence: 'monthly', anchor: '2026-05-15', category: 'insurance',
  }));
  const impact = purchaseImpact(state, NOW, { amount: 4000, on: 'cash' });
  assert.deepEqual(impact, {
    netWorth: -4000,
    cashAfter: 16000,
    shortfallAfter: 34000,
    cardMonthChange: null,
    daysOfPay: null,
    sentence: '$40.00 from cash leaves $160.00 on the clock, ≈$340.00 short of what is due in the next two weeks.',
  });
});

test('purchaseImpact: an inactive stream, or one paid into a hidden account, is not pay', () => {
  const state = household();
  state.txs = state.txs.filter((row) => row.kind !== 'income');
  state.streams[0].active = false;
  assert.equal(purchaseImpact(state, NOW, { amount: 5000, on: 'cash' }).daysOfPay, null);

  const hidden = household();
  hidden.txs = hidden.txs.filter((row) => row.kind !== 'income');
  hidden.accounts.push(bankAccount('acc_old', 'checking', 0, { hidden: true }));
  hidden.streams[0].accountId = 'acc_old';
  assert.equal(purchaseImpact(hidden, NOW, { amount: 5000, on: 'cash' }).daysOfPay, null);
});

test('purchaseImpact: a missing or malformed purchase is a purchase of nothing, from cash', () => {
  for (const purchase of [null, undefined, {}, { amount: NaN, on: 'card' }, { amount: -500 }, { amount: '12' }, 'coffee']) {
    const impact = purchaseImpact(household(), NOW, purchase);
    assert.equal(impact.netWorth, 0);
    assert.ok(Object.is(impact.netWorth, 0));
    assert.equal(impact.cashAfter, 600000);
    assert.equal(impact.shortfallAfter, 0);
    assert.equal(impact.daysOfPay, 0);
    assertNoNaN(impact);
    assert.equal(typeof impact.sentence, 'string');
  }
  assert.equal(purchaseImpact(household(), NOW, { amount: 1999.6, on: 'bank' }).cashAfter, 598000);
});

/* -------------------------------------------------------------- robustness */

test('malformed rows and missing fields never throw or produce NaN', () => {
  const state = householdInMatch();
  const clean = {
    pace: pace(state, NOW),
    projection: projectNetWorth(state, NOW),
    reserve: reserveGoal(state, NOW),
    ladder: incomeLadder(state, NOW),
    payoff: cardPayoff(state, NOW),
    impact: purchaseImpact(state, NOW, { amount: 5000, on: 'card' }),
  };
  state.txs.push(
    null, undefined, 42, 'row', {},
    income('2026-06-03', NaN),
    income('2026-06-03', -500),
    income('2026-06-31', 900),
    income(null, 900),
    { accountId: 'acc_chk', day: '2026-06-03', kind: 'income', flow: 'in' },
  );
  state.accounts.push(null, {}, { id: 'acc_x' }, { id: 7, type: 'credit_card' }, { id: 'acc_y', type: 'nonsense', balance: -5 });
  state.streams.push(null, 7, {}, { id: 'str_x', cadence: 'fortnightly', amount: 5, active: true }, { id: 'str_y', cadence: 'weekly', amount: NaN, active: true });
  state.recurring.push(null, {}, { id: 'rec_x', amount: 'much' });
  state.goals.income.ladder.push(NaN, -5, null, 'a lot');
  assert.deepEqual({
    pace: pace(state, NOW),
    projection: projectNetWorth(state, NOW),
    reserve: reserveGoal(state, NOW),
    ladder: incomeLadder(state, NOW),
    payoff: cardPayoff(state, NOW),
    impact: purchaseImpact(state, NOW, { amount: 5000, on: 'card' }),
  }, clean);
  assertNoNaN(clean);
});

test('an empty, partial or missing document is answered with zeros and nulls', () => {
  for (const state of [null, undefined, 7, {}, { accounts: 'none', txs: 7, streams: {}, goals: 3, scenario: 'x' }]) {
    assert.equal(pace(state, NOW), null);
    assert.deepEqual(projectNetWorth(state, NOW, { months: 2 }), {
      start: 0, months: 2, lines: [{ key: 'scenario', label: 'Scenario', points: [0, 0, 0] }],
    });
    assert.deepEqual(reserveGoal(state, NOW), {
      target: 0, have: 0, gap: 0, fraction: 1,
      atPace: { months: 0, day: TODAY }, atScenario: { months: 0, day: TODAY },
    });
    assert.deepEqual(incomeLadder(state, NOW), {
      received: 0, days: 0, partial: true, thin: true, annualised: 0, grossApprox: 0, byStream: [], ladder: [], next: null,
      final: { target: 0, by: '', requiredGrowth: null },
    });
    assert.deepEqual(cardPayoff(state, NOW), {
      owed: 0, apr: null, payment: 0, months: 0, interest: 0, never: false, schedule: [{ month: 0, owed: 0 }],
    });
    // Nothing is due, but cash below zero is short all the same (the clock's own rule: due − cash).
    assert.deepEqual(purchaseImpact(state, NOW, { amount: 2500, on: 'cash' }), {
      netWorth: -2500, cashAfter: -2500, shortfallAfter: 2500, cardMonthChange: null, daysOfPay: null,
      sentence: '$25.00 from cash leaves −$25.00 on the clock.',
    });
  }
});

test('a fresh default document works before any bank is linked', () => {
  const state = defaultState(at(2026, 1, 1));
  assert.equal(pace(state, NOW), null);
  assert.equal(projectNetWorth(state, NOW).lines.length, 1);
  assert.equal(reserveGoal(state, NOW).gap, 1000000);
  assert.equal(reserveGoal(state, NOW).atScenario.months, 67); // 10,000.00 / 150.00 = 66.7
  assert.equal(incomeLadder(state, NOW).next.target, 10000000);
  assert.equal(cardPayoff(state, NOW).months, 0);
  assert.equal(purchaseImpact(state, NOW, { amount: 100, on: 'card' }).cardMonthChange, 100);
});

test('a missing or impossible clock does not throw', () => {
  for (const now of [undefined, NaN, Infinity, 'noon']) {
    const state = householdInMatch();
    assertNoNaN(pace(state, now));
    assertNoNaN(projectNetWorth(state, now));
    assertNoNaN(reserveGoal(state, now));
    assertNoNaN(incomeLadder(state, now));
    assertNoNaN(cardPayoff(state, now));
    assertNoNaN(purchaseImpact(state, now, { amount: 5000, on: 'card' }));
  }
});

test('the document is never changed', () => {
  const state = householdInMatch();
  const before = JSON.stringify(state);
  pace(state, NOW);
  projectNetWorth(state, NOW);
  reserveGoal(state, NOW);
  incomeLadder(state, NOW);
  cardPayoff(state, NOW);
  purchaseImpact(state, NOW, { amount: 5000, on: 'card' });
  purchaseImpact(state, NOW, { amount: 5000, on: 'cash' });
  assert.equal(JSON.stringify(state), before);
});

test('incomeLadder: under 60 days of history the annualised figures are marked thin', () => {
  const long = incomeLadder(household(), NOW);
  assert.equal(long.days, 73);
  assert.equal(long.thin, false);
  const short = household();
  short.txs = short.txs.filter((tx) => tx.day >= '2026-05-20');
  const ladder = incomeLadder(short, NOW);
  assert.ok(ladder.days > 0 && ladder.days < 60, 'days: ' + ladder.days);
  assert.equal(ladder.partial, true);
  assert.equal(ladder.thin, true);
});

/* ---- round two ---- */

test('paceMinDays and pace never disagree: a pace is read from exactly that many completed days', () => {
  for (const window of [undefined, 30, 20, 10, 8, 7]) {
    for (let days = 1; days <= 9; days++) {
      const state = youngDocument(days);
      const needed = paceMinDays(state, NOW, window);
      assert.equal(pace(state, NOW, window) !== null, days >= needed, days + ' days, window ' + window + ', needs ' + needed);
    }
  }
  // No pay stream: a month, but never more than the window asked for; 14 at least under a full window.
  assert.equal(paceMinDays(youngDocument(9), NOW), 30);
  assert.equal(paceMinDays(youngDocument(9), NOW, 10), 10);
  // Pay every two weeks: 14 completed days, so a pace is read from day 15 on record.
  assert.equal(paceMinDays(salaried(), NOW), 14);
  assert.notEqual(pace(salaried(), NOW), null);
});

test('a 20-cent monthly interest stream is not pay: no days of pay, and no pay cycle (ruling R2)', () => {
  const state = youngDocument(9);
  state.streams.push(makeStream({
    id: 'str_int', name: 'Interest earned', mkey: 'interest', kind: 'interest', accountId: 'acc_chk',
    cadence: 'monthly', anchor: '2026-05-31', amount: 20, accrue: false,
  }));
  state.txs.push(income('2026-05-31', 20, 'str_int'));
  const impact = purchaseImpact(state, NOW, { amount: 20000, on: 'cash' });
  assert.equal(impact.daysOfPay, null);
  assert.ok(!/days? of pay/.test(impact.sentence), impact.sentence);
});

test('projectNetWorth starts from the live figure floored to the cent (ruling R5)', () => {
  const state = salaried();
  const ledger = makeLedger(state, NOW);
  const live = ledger.position().live;
  const fake = { ...ledger, position: () => ({ ...ledger.position(), live: Math.floor(live) + 0.62 }) };
  const projection = projectNetWorth(state, NOW, { ledger: fake });
  assert.equal(projection.start, Math.floor(live));
  assert.equal(projection.lines[0].points[0], Math.floor(live));
  assert.equal(projectNetWorth(state, NOW).start, Math.floor(live));
});

test('purchaseImpact on a card: the price goes inside the projection, so a credit absorbs it (ruling R3c)', () => {
  const state = household();
  state.accounts.find((account) => account.id === 'acc_card').balance = 50000;
  const impact = purchaseImpact(state, NOW, { amount: 10000, on: 'card' });
  assert.equal(impact.cardMonthChange, 0);
  assert.match(impact.sentence, /^\$100\.00 on the card puts this month on pace to end where it began/);
});

test('purchaseImpact on a card before day 7 of the month reads no pace and says so (ruling R3a)', () => {
  const impact = purchaseImpact(household(), at(2026, 6, 4), { amount: 10000, on: 'card' });
  assert.equal(impact.cardMonthChange, null);
  assert.match(impact.sentence, /^\$100\.00 on the card adds \$100\.00 to what is owed; a pace is read from day 7 of the month/);
});

test('T5: before day 7 a credit on the card absorbs a purchase first', () => {
  const state = household();
  const card = state.accounts.find((account) => account.type === 'credit_card');
  card.balance = 50000; // $500.00 in credit
  const covered = purchaseImpact(state, at(2026, 6, 4), { amount: 10000, on: 'card', accountId: card.id });
  assert.equal(covered.cardMonthChange, null);
  assert.match(covered.sentence, /^\$100\.00 on the card is covered by the \$500\.00 credit; a pace is read from day 7 of the month/);
  const over = purchaseImpact(state, at(2026, 6, 4), { amount: 65000, on: 'card', accountId: card.id });
  assert.match(over.sentence, /^\$650\.00 on the card adds \$150\.00 to what is owed; a pace is read from day 7 of the month/);
});

test('a ledger handed in through opts gives the same answers as one built inside', () => {
  const state = household();
  const opts = { ledger: makeLedger(state, NOW) };
  assert.deepEqual(pace(state, NOW, 30, opts), pace(state, NOW, 30));
  assert.deepEqual(projectNetWorth(state, NOW, opts), projectNetWorth(state, NOW));
  assert.deepEqual(reserveGoal(state, NOW, opts), reserveGoal(state, NOW));
  assert.deepEqual(incomeLadder(state, NOW, opts), incomeLadder(state, NOW));
  assert.deepEqual(cardPayoff(state, NOW, opts), cardPayoff(state, NOW));
  assert.deepEqual(purchaseImpact(state, NOW, { amount: 5000, on: 'card' }, opts), purchaseImpact(state, NOW, { amount: 5000, on: 'card' }));
  assert.equal(paceMinDays(state, NOW, 30, opts), paceMinDays(state, NOW, 30));
});
