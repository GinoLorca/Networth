import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  makeLedger, todayOf, dayType, habitFor, convOn, accountValueOn, position, closes, round, monthTable, edge, clock,
  retention, spendingByCategory,
} from '../js/model/ledger.js';
import { CADENCES, defaultState, makeAccount, makeRecurring, makeStream, makeTx } from '../js/model/schema.js';
import { addDays, diffDays, eachDay, gameDayStartMs, isYmd } from '../js/model/dates.js';
import { lastOccurrence } from '../js/model/book.js';
import { loanValueOn } from '../js/model/loans.js';

/* Every figure below is invented. 1 June 2026 is a Monday; no clock changes anywhere near June. */

/** Local time, so the tests read the same in every time zone. */
const at = (y, m, d, hour = 12, minute = 0) => new Date(y, m - 1, d, hour, minute).getTime();

/** Tuesday 16 June 2026 at noon: with the 4 a.m. rollover exactly one third of the game day has passed. */
const NOON = at(2026, 6, 16);

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);

function assertNoNaN(value, path = 'result') {
  if (typeof value === 'number') assert.ok(!Number.isNaN(value), path + ' is NaN');
  else if (Array.isArray(value)) value.forEach((item, i) => assertNoNaN(item, path + '[' + i + ']'));
  else if (value && typeof value === 'object') {
    // `moves` and `segment` are the document's own objects, handed back untouched
    for (const key of Object.keys(value)) if (key !== 'moves' && key !== 'segment') assertNoNaN(value[key], path + '.' + key);
  }
}

let sequence = 0;

function tx(day, amount, fields = {}) {
  sequence += 1;
  return makeTx({ id: 'tx_' + sequence, accountId: 'acc_chk', day, postedDay: day, amount, loggedAt: at(2026, 6, 1) + sequence, ...fields });
}

const spend = (day, amount, category = 'groceries', fields = {}) => tx(day, amount, { category, ...fields });
const deposit = (day, amount, fields = {}) => tx(day, amount, { flow: 'in', kind: 'income', category: 'income', ...fields });
const provisional = (day, amount, fields = {}) =>
  tx(day, amount, { source: 'manual', accountId: null, postedDay: null, category: 'cafe', ...fields });

const bankAccount = (id, type, balance, fields = {}) =>
  makeAccount({ id, source: 'bank', type, balance, basis: 'bank', name: id, asOf: at(2026, 6, 16, 9), ...fields });

const emptyState = () => defaultState(at(2026, 1, 1));

const byDay = (rows) => Object.fromEntries(rows.map((row) => [row.day, row]));

/**
 * A fictional salaried owner. Pay: $1,400.00 every second Friday, so $100.00 a day. One bill: a $70.00
 * weekly gym charge, so $10.00 a day. Checking holds $5,000.00 now.
 */
function salaried(change = {}) {
  const state = emptyState();
  state.accounts.push(bankAccount('acc_chk', 'checking', 500000));
  state.streams.push(makeStream({
    id: 'str_pay', name: 'Payroll', kind: 'salary', accountId: 'acc_chk',
    cadence: 'biweekly', anchor: '2026-06-12', amount: 140000, accrue: true,
  }));
  state.recurring.push(makeRecurring({ id: 'rec_gym', name: 'Gym', accountId: 'acc_chk', cadence: 'weekly', anchor: '2026-06-10', amount: 7000 }));
  state.txs.push(
    deposit('2026-05-29', 140000, { streamId: 'str_pay' }),
    spend('2026-06-03', 7000, 'subscriptions', { recurringId: 'rec_gym' }),
    spend('2026-06-10', change.charge ?? 7000, 'subscriptions', { recurringId: 'rec_gym' }),
    spend('2026-06-11', 1500, 'cafe'),
    deposit('2026-06-12', change.paycheck ?? 140000, { streamId: 'str_pay' }),
    spend('2026-06-12', 2300, 'groceries'),
  );
  state.sync.lastOk = at(2026, 6, 16, 9);
  return state;
}

/* ------------------------------------------------- game day, day type, habit */

test('todayOf: the game day rolls over at settings.rolloverHour', () => {
  const state = emptyState();
  assert.equal(todayOf(state, at(2026, 6, 16, 3, 59)), '2026-06-15');
  assert.equal(todayOf(state, at(2026, 6, 16, 4, 0)), '2026-06-16');
  assert.equal(todayOf(state, at(2026, 6, 16, 23)), '2026-06-16');
  state.settings.rolloverHour = 0;
  assert.equal(todayOf(state, at(2026, 6, 16, 0, 1)), '2026-06-16');
  assert.equal(makeLedger(emptyState(), at(2027, 1, 1, 2)).today, '2026-12-31');
});

test('dayType: the weekday default, overridden by the day\'s own record', () => {
  const state = emptyState();
  assert.equal(dayType(state, '2026-06-01'), 'work'); // Monday
  assert.equal(dayType(state, '2026-06-05'), 'work'); // Friday
  assert.equal(dayType(state, '2026-06-06'), 'off');  // Saturday
  assert.equal(dayType(state, '2026-06-07'), 'off');  // Sunday
  state.days['2026-06-06'] = { type: 'work' };
  state.days['2026-06-01'] = { type: 'off' };
  state.days['2026-06-02'] = { note: 'no type here' };
  assert.equal(dayType(state, '2026-06-06'), 'work');
  assert.equal(dayType(state, '2026-06-01'), 'off');
  assert.equal(dayType(state, '2026-06-02'), 'work');
  state.settings.workdays = [0, 6];
  assert.equal(dayType(state, '2026-06-07'), 'work');
  assert.equal(dayType(state, '2026-06-03'), 'off');
  assert.equal(dayType(state, 'not a day'), 'off');
  assert.equal(makeLedger(state, NOON).dayType('2026-06-06'), 'work');
});

test('habitFor: the segment in force, by day type, with the loss line rounded up to a dollar', () => {
  const state = emptyState();
  assert.deepEqual(habitFor(state, '2026-06-08'), { habit: 0, winLine: 0, lossLine: 0, segment: null });
  const second = { from: '2026-07-01', work: 901, off: 700, winWork: 500, winOff: 300 };
  const first = { from: '2026-06-01', work: 1250, off: 800, winWork: 600, winOff: 400 };
  state.habits.push(second, first); // out of order on purpose
  assert.deepEqual(habitFor(state, '2026-06-08'), { habit: 1250, winLine: 600, lossLine: 1300, segment: first });
  assert.deepEqual(habitFor(state, '2026-06-06'), { habit: 800, winLine: 400, lossLine: 800, segment: first });
  assert.deepEqual(habitFor(state, '2026-06-30'), { habit: 1250, winLine: 600, lossLine: 1300, segment: first });
  assert.deepEqual(habitFor(state, '2026-07-01'), { habit: 901, winLine: 500, lossLine: 1000, segment: second });
  // before the first segment the first one is used (exhibition)
  assert.deepEqual(habitFor(state, '2026-05-20'), { habit: 1250, winLine: 600, lossLine: 1300, segment: first });
  assert.deepEqual(state.habits, [second, first], 'the document is not reordered');
  assert.deepEqual(makeLedger(state, NOON).habitFor('2026-07-04'), { habit: 700, winLine: 300, lossLine: 700, segment: second });
});

/* --------------------------------------------------------- balances by day */

/** Checking reports $1,000.00; a $25.00 spend, a $500.00 deposit, and a $12.00 spend still pending. */
function withPending(countPending) {
  const state = emptyState();
  state.settings.countPending = countPending;
  state.accounts.push(bankAccount('acc_chk', 'checking', 100000, { asOf: at(2026, 6, 15, 9) }));
  state.txs.push(
    spend('2026-06-10', 2500),
    deposit('2026-06-12', 50000),
    spend('2026-06-14', 1200, 'cafe', { pending: true, postedDay: null }),
  );
  return state;
}

test('balances run backward from the reported balance, pending rows counted', () => {
  const state = withPending(true);
  const now = at(2026, 6, 15);
  const value = (day) => accountValueOn(state, 'acc_chk', day, now);
  assert.equal(value('2026-06-15'), 98800); // now = 1,000.00 reported − 12.00 pending
  assert.equal(value('2026-06-14'), 98800);
  assert.equal(value('2026-06-13'), 100000);
  assert.equal(value('2026-06-12'), 100000);
  assert.equal(value('2026-06-11'), 50000);
  assert.equal(value('2026-06-10'), 50000);
  assert.equal(value('2026-06-09'), 52500);
  assert.equal(value('2025-01-01'), 52500);
  assert.equal(value('2026-07-01'), 98800, 'today or later is the now-balance');
  assert.equal(position(state, now).cash, 98800);
  const rows = byDay(closes(state, '2026-06-09', '2026-06-15', now));
  assert.deepEqual(Object.values(rows).map((row) => row.bank), [52500, 50000, 50000, 100000, 100000, 98800, 98800]);
  assert.equal(rows['2026-06-14'].spent, 1200);
  assert.equal(rows['2026-06-14'].conv, 1200);
  assert.equal(rows['2026-06-14'].result, -1200);
  assert.equal(convOn(state, '2026-06-14', now), 1200);
});

test('balances run backward from the reported balance, pending rows left out', () => {
  const state = withPending(false);
  const now = at(2026, 6, 15);
  const value = (day) => accountValueOn(state, 'acc_chk', day, now);
  assert.equal(value('2026-06-15'), 100000);
  assert.equal(value('2026-06-14'), 100000);
  assert.equal(value('2026-06-13'), 100000);
  assert.equal(value('2026-06-11'), 50000);
  assert.equal(value('2026-06-09'), 52500);
  assert.equal(position(state, now).cash, 100000);
  const rows = byDay(closes(state, '2026-06-13', '2026-06-15', now));
  assert.equal(rows['2026-06-14'].spent, 0);
  assert.equal(rows['2026-06-14'].result, 0);
  assert.equal(convOn(state, '2026-06-14', now), 0);
  assert.deepEqual(round(state, '2026-06-14', now).moves, [], 'a pending row that is not counted is not a move');
  assert.equal(rows['2026-06-14'].partial, true, 'the day is still waiting for the bank');
});

test('a debt is negative: card spending lowers the balance, a payment raises it', () => {
  const state = emptyState();
  state.accounts.push(bankAccount('acc_chk', 'checking', 200000), bankAccount('acc_card', 'credit_card', -42000));
  state.txs.push(
    spend('2026-06-13', 3000, 'shopping', { accountId: 'acc_card' }),
    tx('2026-06-14', 10000, { kind: 'payment', category: 'card_payment', pairId: 'x' }),
    tx('2026-06-14', 10000, { kind: 'payment', category: 'card_payment', flow: 'in', accountId: 'acc_card', pairId: 'y' }),
  );
  assert.equal(accountValueOn(state, 'acc_card', '2026-06-14', NOON), -42000);
  assert.equal(accountValueOn(state, 'acc_card', '2026-06-13', NOON), -52000);
  assert.equal(accountValueOn(state, 'acc_card', '2026-06-12', NOON), -49000);
  assert.equal(accountValueOn(state, 'acc_chk', '2026-06-13', NOON), 210000);
  const rows = byDay(closes(state, '2026-06-13', '2026-06-14', NOON));
  assert.equal(rows['2026-06-13'].result, -3000);
  assert.equal(rows['2026-06-13'].spent, 3000);
  // a card payment between linked accounts is neither spending nor income, and moves nothing
  assert.deepEqual(
    [rows['2026-06-14'].result, rows['2026-06-14'].spent, rows['2026-06-14'].other, rows['2026-06-14'].bank],
    [0, 0, 0, 158000],
  );
  assert.equal(accountValueOn(state, 'acc_nobody', '2026-06-13', NOON), 0);
});

test('declines and superseded manual moves have no monetary effect', () => {
  const state = emptyState();
  state.accounts.push(bankAccount('acc_chk', 'checking', 100000));
  state.txs.push(
    tx('2026-06-13', 650, { source: 'manual', kind: 'decline', accountId: null, category: 'cafe', instead: 'Went without' }),
    provisional('2026-06-13', 480, { matchId: 'tx_bank' }),
  );
  const [row] = closes(state, '2026-06-13', '2026-06-13', NOON);
  assert.deepEqual([row.bank, row.smooth, row.result, row.spent, row.conv], [100000, 100000, 0, 0, 0]);
  assert.equal(position(state, NOON).provisional, 0);
  const played = round(state, '2026-06-13', NOON);
  assert.deepEqual(played.moves.map((move) => move.kind), ['decline'], 'the decline is on the scoresheet, the superseded move is not');
  assert.equal(played.conv, 0);
});

/* ------------------------------------------------------------ smoothed closes */

test('smoothing: a close moves by daily pay − daily bills − the day\'s spending, payday and charge day included', () => {
  const state = salaried();
  const rows = byDay(closes(state, '2026-06-10', '2026-06-15', NOON));
  // 9 June: bank 3,708.00 + pay earned since 29 May (12 days) 1,200.00 − gym used since 3 June (7 days) 70.00 = 4,838.00
  const expected = {
    //            bank    smooth  result earned bills spent conv
    '2026-06-10': [363800, 492800, 9000, 10000, 1000, 0, 0],       // the gym charge equals what had accrued: no jump
    '2026-06-11': [362300, 500300, 7500, 10000, 1000, 1500, 1500], // a $15.00 coffee
    '2026-06-12': [500000, 507000, 6700, 10000, 1000, 2300, 0],    // payday: the $1,400.00 had all been earned already
    '2026-06-13': [500000, 516000, 9000, 10000, 1000, 0, 0],
    '2026-06-14': [500000, 525000, 9000, 10000, 1000, 0, 0],
    '2026-06-15': [500000, 534000, 9000, 10000, 1000, 0, 0],
  };
  for (const [day, figures] of Object.entries(expected)) {
    const row = rows[day];
    assert.deepEqual([row.bank, row.smooth, row.result, row.earned, row.bills, row.spent, row.conv], figures, day);
    assert.equal(row.result, row.earned - row.bills - row.spent, day);
    assert.equal(row.other, 0, day);
    assert.equal(row.reval, 0, day);
  }
  assert.equal(rows['2026-06-10'].type, 'work');
  assert.equal(rows['2026-06-13'].type, 'off');
});

test('smoothing: a paycheck larger than what accrued lands its difference on payday', () => {
  const rows = byDay(closes(salaried({ paycheck: 150000 }), '2026-06-11', '2026-06-13', NOON));
  const payday = rows['2026-06-12'];
  assert.equal(payday.earned, 20000); // 100.00 for the day + 100.00 more than had accrued
  assert.equal(payday.result, 16700); // 200.00 − 10.00 − 23.00
  assert.equal(payday.other, 0);
  assert.equal(rows['2026-06-11'].result, 7500);
  assert.equal(rows['2026-06-13'].result, 9000);
});

test('smoothing: a paycheck smaller than what accrued takes the difference off payday', () => {
  const payday = byDay(closes(salaried({ paycheck: 125000 }), '2026-06-12', '2026-06-12', NOON))['2026-06-12'];
  assert.equal(payday.earned, -5000);
  assert.equal(payday.result, -8300); // −50.00 − 10.00 − 23.00
});

test('smoothing: a charge that differs from what accrued lands its difference on the day it posts', () => {
  const dearer = byDay(closes(salaried({ charge: 7500 }), '2026-06-10', '2026-06-11', NOON));
  assert.equal(dearer['2026-06-10'].bills, 1500); // 10.00 for the day + 5.00 more than had accrued
  assert.equal(dearer['2026-06-10'].result, 8500);
  assert.equal(dearer['2026-06-11'].bills, 1000);
  const cheaper = byDay(closes(salaried({ charge: 6400 }), '2026-06-10', '2026-06-10', NOON));
  assert.equal(cheaper['2026-06-10'].bills, 400);
  assert.equal(cheaper['2026-06-10'].result, 9600);
});

test('smoothing: a monthly bill accrues amount / 30.4375 a day and settles on the charge', () => {
  const state = salaried();
  // $608.75 a month is exactly $20.00 a day; May has 31 days, so $620.00 accrued against a $608.75 charge
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace', accountId: 'acc_chk', cadence: 'monthly', anchor: '2026-06-01', amount: 60875, category: 'housing' }));
  state.txs.push(
    spend('2026-05-01', 60875, 'housing', { recurringId: 'rec_rent' }),
    spend('2026-06-01', 60875, 'housing', { recurringId: 'rec_rent' }),
  );
  const rows = byDay(closes(state, '2026-05-31', '2026-06-02', NOON));
  assert.equal(rows['2026-05-31'].bills, 3000);  // gym 10.00 + rent 20.00
  assert.equal(rows['2026-06-01'].bills, 1875);  // 30.00 for the day − 11.25 over-accrued
  assert.equal(rows['2026-06-01'].result, 10000 - 1875);
  assert.equal(rows['2026-06-02'].bills, 3000);
});

test('smoothing: fractional daily pay never drifts — a pay period adds up to the paycheck exactly', () => {
  const state = emptyState();
  state.accounts.push(bankAccount('acc_chk', 'checking', 400000));
  state.streams.push(makeStream({ id: 'str_pay', cadence: 'biweekly', anchor: '2026-06-12', amount: 190000, accrue: true, accountId: 'acc_chk' }));
  state.txs.push(deposit('2026-05-29', 190000, { streamId: 'str_pay' }), deposit('2026-06-12', 190000, { streamId: 'str_pay' }));
  const rows = closes(state, '2026-05-30', '2026-06-12', NOON); // the 14 days ending on payday
  assert.equal(rows.length, 14);
  for (const row of rows) {
    assert.ok(row.earned === 13571 || row.earned === 13572, row.day + ' earned ' + row.earned); // 190000 / 14 = 13571.43
    assert.ok(Number.isInteger(row.smooth) && Number.isInteger(row.result));
    assert.equal(row.result, row.earned);
    assert.equal(row.other, 0);
  }
  assert.equal(rows.reduce((total, row) => total + row.earned, 0), 190000);
});

test('smoothing is off unless the setting is on and a scheduled stream accrues: then smooth = bank', () => {
  const variants = {
    'setting off': (state) => { state.settings.smoothing = false; },
    'stream does not accrue': (state) => { state.streams[0].accrue = false; },
    'stream inactive': (state) => { state.streams[0].active = false; },
    'stream has no anchor': (state) => { state.streams[0].anchor = null; },
    'stream has no cadence': (state) => { state.streams[0].cadence = null; },
    'no stream': (state) => { state.streams.length = 0; },
  };
  for (const [name, change] of Object.entries(variants)) {
    const state = salaried();
    change(state);
    const now = position(state, NOON);
    assert.equal(now.smoothing, false, name);
    assert.deepEqual([now.receivable, now.payable, now.smooth, now.live, now.rate], [0, 0, 500000, 500000, 0], name);
    assert.deepEqual([now.receivables, now.payables], [[], []], name);
    const rows = byDay(closes(state, '2026-06-01', '2026-06-16', NOON));
    for (const row of Object.values(rows)) assert.equal(row.smooth, row.bank, name + ' ' + row.day);
    // the day's bills are the actual Book charges, and pay counts when it arrives
    assert.deepEqual([rows['2026-06-10'].bills, rows['2026-06-10'].result], [7000, -7000], name);
    assert.deepEqual([rows['2026-06-09'].bills, rows['2026-06-09'].earned, rows['2026-06-09'].result], [0, 0, 0], name);
    assert.deepEqual([rows['2026-06-12'].earned, rows['2026-06-12'].spent, rows['2026-06-12'].result], [140000, 2300, 137700], name);
    assert.equal(rows['2026-06-12'].other, 0, name);
  }
  assert.equal(position(salaried(), NOON).smoothing, true);
});

test('a stream that does not accrue counts when it arrives, beside one that does', () => {
  const state = salaried();
  state.streams.push(makeStream({ id: 'str_gigs', name: 'Clients', cadence: null, anchor: null, amount: 30000, accrue: false }));
  state.txs.push(deposit('2026-06-13', 30000, { streamId: 'str_gigs' }), deposit('2026-06-14', 4500));
  const rows = byDay(closes(state, '2026-06-13', '2026-06-14', NOON));
  assert.deepEqual([rows['2026-06-13'].earned, rows['2026-06-13'].result], [40000, 39000]);
  assert.deepEqual([rows['2026-06-14'].earned, rows['2026-06-14'].result], [14500, 13500]);
  assert.deepEqual(position(state, NOON).receivables.map((line) => line.id), ['str_pay']);
});

test('before the first linked deposit only the one period ahead of it accrues: there is no pre-history', () => {
  const state = salaried();
  state.txs = state.txs.filter((move) => move.day !== '2026-05-29'); // the first known deposit is now 12 June
  const rows = byDay(closes(state, '2026-05-28', '2026-06-12', NOON));
  // the schedule from the anchor: 12 June − 14 = 29 May, − 14 = 15 May
  assert.equal(lastOccurrence(state.streams[0], '2026-06-05'), '2026-05-29');
  assert.equal(rows['2026-05-28'].earned, 0, 'nothing is earned from this stream before the period that led to its first deposit');
  assert.equal(rows['2026-05-29'].earned, 10000, 'the count starts here; no phantom payday is made up');
  assert.equal(position(state, at(2026, 5, 20)).receivable, 0);
  for (const day of eachDay('2026-05-30', '2026-06-12')) assert.equal(rows[day].earned, 10000, day);
  // 5 June at noon: 7 whole days since 29 May, plus a third of today
  const early = position(state, at(2026, 6, 5));
  assert.equal(early.receivables[0].since, '2026-05-29');
  near(early.receivable, 10000 * (7 + 1 / 3));
});

test('before the bank feed begins nothing accrues: the accruals stand where its first day found them', () => {
  const state = salaried();
  state.txs = state.txs.filter((move) => move.day !== '2026-05-29'); // the first transaction is now the 3 June gym charge
  state.sync.from = '2026-05-25';
  const rows = byDay(closes(state, '2026-05-10', '2026-05-30', NOON));
  // 24 May, the eve of the feed: more than one period ahead of the first deposit (12 June) and of the
  // first gym charge (3 June), so nothing has accrued; checking stood at 3,778.00
  for (const day of eachDay('2026-05-10', '2026-05-24')) {
    assert.deepEqual([rows[day].bank, rows[day].smooth, rows[day].earned, rows[day].bills, rows[day].result], [377800, 377800, 0, 0, 0], day);
  }
  // inside the feed only the one period ahead of each first linked move counts: the gym from 27 May, pay from 29 May
  const inside = {
    '2026-05-25': [0, 0, 0], '2026-05-26': [0, 0, 0], '2026-05-27': [0, 1000, -1000],
    '2026-05-28': [0, 1000, -1000], '2026-05-29': [10000, 1000, 9000],
  };
  for (const [day, figures] of Object.entries(inside)) {
    assert.deepEqual([rows[day].earned, rows[day].bills, rows[day].result], figures, day);
  }
  assert.equal(rows['2026-05-28'].smooth, 377800 - 1000 - 1000);
  // no exhibition result is made up for a day the feed does not cover
  state.habits.push({ from: '2026-07-01', work: 1250, off: 800, winWork: 600, winOff: 400 });
  assert.deepEqual([round(state, '2026-05-24', NOON).status, round(state, '2026-05-24', NOON).result], ['prematch', null]);
  assert.deepEqual([round(state, '2026-05-25', NOON).status, round(state, '2026-05-25', NOON).result], ['prematch', 1]);

  // the feed covers whatever it delivered: a transaction before sync.from moves the first day back
  state.sync.from = '2026-06-10';
  const earlier = byDay(closes(state, '2026-06-01', '2026-06-04', NOON));
  assert.deepEqual([earlier['2026-06-01'].earned, earlier['2026-06-02'].earned], [0, 0]);
  assert.deepEqual([earlier['2026-06-03'].earned, earlier['2026-06-03'].bills, earlier['2026-06-04'].result], [10000, 1000, 9000]);
  assert.equal(round(state, '2026-06-02', NOON).result, null);
  assert.equal(round(state, '2026-06-03', NOON).result, 1);
});

test('charge days: the linked charges, or the anchor\'s schedule when none is linked', () => {
  const linked = salaried();
  assert.equal(position(linked, NOON).payables[0].since, '2026-06-10');
  // after the last linked charge nothing is projected: on 9 June the count still runs from 3 June
  const before = position(linked, at(2026, 6, 9));
  assert.equal(before.payables[0].since, '2026-06-03');
  near(before.payable, 1000 * (6 + 1 / 3));

  const manual = salaried();
  manual.txs = manual.txs.filter((move) => move.recurringId !== 'rec_gym');
  manual.recurring[0].anchor = '2026-06-03';
  const now = position(manual, NOON);
  assert.equal(now.payables[0].since, lastOccurrence(manual.recurring[0], '2026-06-16'));
  assert.equal(now.payables[0].since, '2026-06-10');
  near(now.payable, 1000 * (6 + 1 / 3));
});

test('the projected schedule is book.lastOccurrence for every cadence and every day', () => {
  for (const cadence of Object.keys(CADENCES)) {
    const state = emptyState();
    state.accounts.push(bankAccount('acc_chk', 'checking', 100000));
    state.streams.push(makeStream({ id: 'str_pay', accountId: 'acc_chk', cadence, anchor: '2026-03-31', amount: 100000, accrue: true }));
    state.recurring.push(makeRecurring({ id: 'rec_bill', accountId: 'acc_chk', cadence, anchor: '2026-01-31', amount: 5000 }));
    for (const day of eachDay('2026-02-20', '2026-06-16')) {
      const now = position(state, gameDayStartMs(day, 12)); // noon of that day
      assert.equal(now.receivables[0].since, lastOccurrence(state.streams[0], day), cadence + ' pay on ' + day);
      assert.equal(now.payables[0].since, lastOccurrence(state.recurring[0], day), cadence + ' bill on ' + day);
    }
    // one ledger asked about many days reads the same schedule: a day's pay is earned, or the count starts again
    const daily = 100000 / CADENCES[cadence].days;
    const starts = new Set(eachDay('2026-02-20', '2026-06-15').filter((day) => lastOccurrence(state.streams[0], day) === day));
    for (const row of closes(state, '2026-02-20', '2026-06-15', NOON)) {
      if (!starts.has(row.day)) assert.ok(Math.abs(row.earned - daily) <= 1, cadence + ' ' + row.day + ' earned ' + row.earned);
      else assert.ok(row.earned < 0, cadence + ' ' + row.day + ' starts again');
    }
  }
});

test('bills stop at 1.25 × amount and lapse after 1.5 periods; pay lapses after 1.6 periods', () => {
  const state = salaried();
  state.sync.lastOk = null; // never stale, however late the clock in this test runs
  state.txs = state.txs.filter((move) => move.day < '2026-06-10'); // last gym charge 3 June, last deposit 29 May
  const lines = (day) => position(state, at(2026, 6, day));
  near(lines(10).payable, 1000 * (7 + 1 / 3));
  near(lines(11).payable, 1000 * (8 + 1 / 3));
  near(lines(12).payable, 8750);            // 9.33 days > 8.75: capped at 1.25 × 70.00
  near(lines(13).payable, 8750);            // 10.33 days <= 10.5: still held
  assert.equal(lines(14).payable, 0);       // 11.33 days > 10.5: lapsed
  assert.deepEqual(lines(14).payables, []);
  near(lines(11).rate, (10000 - 1000) / 86400, 1e-12);
  near(lines(12).rate, 10000 / 86400, 1e-12); // a capped bill no longer moves the number

  const rows = byDay(closes(state, '2026-06-10', '2026-06-14', at(2026, 6, 25)));
  assert.equal(rows['2026-06-10'].bills, 1000);   // day 8
  assert.equal(rows['2026-06-11'].bills, 750);    // day 9 would be 90.00: capped at 87.50
  assert.equal(rows['2026-06-12'].bills, 0);
  assert.equal(rows['2026-06-13'].bills, -8750);  // day 11 > 10.5: the bill never came, the accrual is released
  assert.equal(rows['2026-06-14'].bills, 0);

  near(lines(19).receivable, 10000 * (21 + 1 / 3));
  near(lines(20).receivable, 10000 * (22 + 1 / 3)); // 22.33 days < 22.4: still rising
  assert.deepEqual(lines(20).lapsedPay, []);
  assert.equal(lines(21).receivable, 0);    // 23.33 days > 22.4: pay that stops is released, not held
  assert.equal(lines(30).receivable, 0);
  assert.deepEqual(lines(21).receivables, []);
  assert.deepEqual(lines(21).lapsedPay, [{ id: 'str_pay', name: lines(20).receivables[0].name, since: '2026-05-29' }]);
  assert.equal(clock(state, at(2026, 6, 21)).nextPayday, null, 'a lapsed stream supplies no payday');
  assert.equal(position(state, at(2026, 6, 21)).rate, 0);
  const late = byDay(closes(state, '2026-06-19', '2026-06-22', at(2026, 6, 25)));
  assert.deepEqual(['2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22'].map((day) => late[day].earned), [10000, -220000, 0, 0]);
});

/* ------------------------------------------------------------ the live number */

test('position: the live number uses the fraction of the game day elapsed', () => {
  const state = salaried();
  const noon = position(state, NOON);
  assert.equal(noon.day, '2026-06-16');
  assert.equal(noon.at, NOON);
  near(noon.receivable, 10000 * (4 + 1 / 3)); // paid 12 June: four whole days and a third
  near(noon.payable, 1000 * (6 + 1 / 3));     // charged 10 June
  near(noon.smooth, 537000);
  near(noon.live, 537000);
  near(noon.rate, 9000 / 86400, 1e-12);       // $90.00 a day
  assert.deepEqual(noon.receivables, [{ id: 'str_pay', name: 'Payroll', amount: 43333, since: '2026-06-12', daily: 10000 }]);
  assert.deepEqual(noon.payables, [{ id: 'rec_gym', name: 'Gym', amount: 6333, since: '2026-06-10', daily: 1000 }]);

  const evening = position(state, at(2026, 6, 16, 22)); // 18 of 24 hours
  near(evening.receivable, 47500);
  near(evening.payable, 6750);
  near(evening.live, 540750);

  const small = position(state, at(2026, 6, 17, 3)); // 3 a.m. still belongs to the 16th: 23 of 24 hours
  assert.equal(small.day, '2026-06-16');
  near(small.receivable, 10000 * (4 + 23 / 24));

  const rolled = position(state, at(2026, 6, 17, 4)); // the 17th has just begun
  assert.equal(rolled.day, '2026-06-17');
  near(rolled.receivable, 50000);
  near(rolled.live, 500000 + 50000 - 7000);
});

test('today\'s close is the day so far and agrees with the live number', () => {
  const state = salaried();
  const [yesterday, today] = closes(state, '2026-06-15', '2026-06-20', NOON); // capped at today
  assert.equal(today.day, '2026-06-16');
  assert.deepEqual([today.smooth, today.result, today.earned, today.bills, today.other], [537000, 3000, 3333, 333, 0]);
  assert.equal(today.partial, true);
  assert.equal(yesterday.smooth, 534000);
  near(position(state, NOON).live, today.smooth, 1);
  assert.equal(today.bank, position(state, NOON).bank);
  assert.deepEqual(closes(state, '2026-06-17', '2026-06-20', NOON), []);
  assert.deepEqual(closes(state, '2026-06-16', '2026-06-10', NOON), []);
});

test('accrual stops 36 hours after the last successful sync', () => {
  const state = salaried();
  state.sync.lastOk = at(2026, 6, 14); // noon on the 14th: accrual stops at midnight ending the 15th's evening
  // the stop instant (16 June 00:00) is 20 of 24 hours into game day 15 June

  const fresh = position(state, at(2026, 6, 15)); // 24 hours on
  assert.equal(fresh.freshness, 'fresh');
  near(fresh.receivable, 10000 * (3 + 1 / 3));
  near(fresh.rate, 9000 / 86400, 1e-12);

  const edge36 = position(state, at(2026, 6, 16, 0)); // exactly 36 hours on
  assert.equal(edge36.freshness, 'fresh');
  near(edge36.receivable, 10000 * (3 + 20 / 24));
  assert.ok(edge36.rate > 0);

  const aging = position(state, at(2026, 6, 16)); // 48 hours on
  assert.equal(aging.freshness, 'aging');
  near(aging.receivable, 10000 * (3 + 20 / 24));
  near(aging.payable, 1000 * (5 + 20 / 24));
  assert.equal(aging.rate, 0);

  const old = position(state, at(2026, 6, 18)); // 96 hours on
  assert.equal(old.freshness, 'old');
  assert.equal(old.syncedAt, at(2026, 6, 14));
  near(old.receivable, 10000 * (3 + 20 / 24));
  near(old.live, 500000 + 38333.333333 - 5833.333333);
  assert.equal(old.rate, 0);
  assert.equal(old.smoothing, true);

  const rows = byDay(closes(state, '2026-06-14', '2026-06-18', at(2026, 6, 18)));
  assert.deepEqual([rows['2026-06-14'].earned, rows['2026-06-14'].bills], [10000, 1000]);
  assert.deepEqual([rows['2026-06-15'].earned, rows['2026-06-15'].bills], [8333, 833]); // 20 hours of the day
  for (const day of ['2026-06-16', '2026-06-17', '2026-06-18']) {
    assert.deepEqual([rows[day].earned, rows[day].bills, rows[day].result], [0, 0, 0], day);
  }
  assert.equal(rows['2026-06-18'].smooth, 500000 + 38333 - 5833);
});

test('freshness: never synced is "none", and nothing stops the accrual', () => {
  const state = salaried();
  state.sync.lastOk = null;
  const now = position(state, at(2026, 6, 18));
  assert.equal(now.freshness, 'none');
  assert.equal(now.syncedAt, null);
  near(now.receivable, 10000 * (6 + 1 / 3));
  assert.ok(now.rate > 0);
  state.sync.lastOk = at(2026, 6, 15, 10);
  assert.equal(position(state, at(2026, 6, 18, 10)).freshness, 'aging'); // exactly 72 hours
  assert.equal(position(state, at(2026, 6, 18, 11)).freshness, 'old');
});

/* --------------------------------------------------------- provisional moves */

test('an unmatched provisional move lowers closes from its day on, and the live number', () => {
  const state = salaried();
  state.txs.push(provisional('2026-06-14', 900));
  const now = position(state, NOON);
  assert.equal(now.provisional, 900);
  assert.equal(now.bank, 500000, 'no bank balance holds it yet');
  near(now.smooth, 537000);
  near(now.live, 536100);
  const rows = byDay(closes(state, '2026-06-13', '2026-06-16', NOON));
  assert.deepEqual([rows['2026-06-13'].smooth, rows['2026-06-13'].result], [516000, 9000]);
  assert.deepEqual([rows['2026-06-14'].smooth, rows['2026-06-14'].result, rows['2026-06-14'].spent, rows['2026-06-14'].conv], [524100, 8100, 900, 900]);
  assert.deepEqual([rows['2026-06-15'].smooth, rows['2026-06-15'].result], [533100, 9000]);
  assert.equal(rows['2026-06-16'].smooth, 536100);
  for (const row of Object.values(rows)) {
    assert.equal(row.bank, 500000);
    assert.equal(row.other, 0);
  }
  assert.equal(convOn(state, '2026-06-14', NOON), 900);
  assert.equal(rows['2026-06-14'].partial, true, 'in pencil until the bank confirms it');
});

test('a provisional move stops counting after 7 days, or as soon as a bank row matches it', () => {
  const state = salaried();
  const move = provisional('2026-06-14', 900);
  state.txs.push(move);
  const seventh = at(2026, 6, 21);
  assert.equal(position(state, seventh).provisional, 900);
  assert.equal(convOn(state, '2026-06-14', seventh), 900);
  const eighth = at(2026, 6, 22);
  assert.equal(position(state, eighth).provisional, 0);
  assert.equal(convOn(state, '2026-06-14', eighth), 0);
  assert.equal(closes(state, '2026-06-14', '2026-06-14', eighth)[0].smooth, 525000);
  assert.deepEqual(round(state, '2026-06-14', eighth).moves, []);

  move.matchId = 'tx_bank_row';
  assert.equal(position(state, NOON).provisional, 0);
  assert.equal(closes(state, '2026-06-14', '2026-06-14', NOON)[0].smooth, 525000);
});

/* ------------------------------------------------------------------ loans */

/**
 * A fictional equipment loan: $10,000.00 owed on 1 May 2026 at 7.3% — exactly $2.00 of interest a day —
 * with $300.00 due on the 1st. The 1 June payment follows 31 days: $62.00 interest, $238.00 principal.
 */
function withLoan({ seen = true, assumeScheduled = false } = {}) {
  const state = emptyState();
  state.accounts.push(
    bankAccount('acc_chk', 'checking', 300000),
    makeAccount({
      id: 'acc_loan', type: 'loan', name: 'Equipment loan', balance: -1000000, apr: 7.3, dueDay: 1,
      loan: { payment: 30000, assumeScheduled }, history: [{ day: '2026-05-01', balance: -1000000, note: '' }],
    }),
  );
  state.streams.push(makeStream({ id: 'str_pay', name: 'Payroll', accountId: 'acc_chk', cadence: 'biweekly', anchor: '2026-06-12', amount: 140000, accrue: true }));
  state.txs.push(deposit('2026-05-29', 140000, { streamId: 'str_pay' }), deposit('2026-06-12', 140000, { streamId: 'str_pay' }));
  if (seen) {
    state.recurring.push(makeRecurring({
      id: 'rec_loan', name: 'Loan payment', accountId: 'acc_chk', toAccountId: 'acc_loan',
      cadence: 'monthly', anchor: '2026-06-01', amount: 30000, category: 'debt_service',
    }));
    state.txs.push(spend('2026-06-01', 30000, 'debt_service', { recurringId: 'rec_loan' }));
  }
  return state;
}

test('a loan payment: the loan steps on the payment day and only the interest is a bill', () => {
  const state = withLoan();
  assert.equal(accountValueOn(state, 'acc_loan', '2026-05-31', NOON), -1000000);
  assert.equal(accountValueOn(state, 'acc_loan', '2026-06-01', NOON), -976200);
  assert.equal(accountValueOn(state, 'acc_loan', '2026-06-16', NOON), -976200);
  assert.equal(accountValueOn(state, 'acc_loan', '2026-01-01', NOON), -1000000, 'the first entry covers earlier days');

  const rows = byDay(closes(state, '2026-05-31', '2026-06-02', NOON));
  // 31 May: checking 1,900.00 − loan 10,000.00; pay earned 300.00; interest accrued 31 × 2.00 = 62.00
  assert.deepEqual([rows['2026-05-31'].bank, rows['2026-05-31'].smooth], [-810000, -786200]);
  assert.deepEqual([rows['2026-05-31'].earned, rows['2026-05-31'].bills, rows['2026-05-31'].result], [10000, 200, 9800]);
  // 1 June: 300.00 leaves checking, 238.00 comes off the loan; the 62.00 of interest had already accrued.
  // Interest starts again on 9,762.00: 9762 × 0.073 / 365 = 1.9524 a day
  const paid = rows['2026-06-01'];
  assert.equal(paid.bank, -816200);
  assert.equal(paid.smooth, -816200 + 40000 - 195);
  assert.deepEqual([paid.earned, paid.bills, paid.spent, paid.other, paid.result], [10000, 195, 0, 0, 9805]);
  assert.deepEqual([rows['2026-06-02'].bills, rows['2026-06-02'].result], [195, 9805]);

  const now = position(state, NOON);
  assert.equal(now.loans, -976200);
  near(now.payable, 195.24 * (15 + 1 / 3), 1e-6);
  assert.deepEqual(now.payables, [{ id: 'rec_loan', name: 'Loan payment', amount: 2994, since: '2026-06-01', daily: 195 }]);
});

test('a loan payment the bank feed calls a payment is treated like any other Book charge', () => {
  const state = withLoan();
  const row = state.txs[state.txs.length - 1];
  Object.assign(row, { kind: 'payment', category: 'card_payment', klass: 'need' }); // unpaired: the lender is not linked
  assert.equal(accountValueOn(state, 'acc_loan', '2026-06-01', NOON), -976200);
  const [paid] = closes(state, '2026-06-01', '2026-06-01', NOON);
  assert.deepEqual([paid.earned, paid.bills, paid.spent, paid.other, paid.result], [10000, 195, 0, 0, 9805]);
});

test('a loan with no payment in the feed steps on its due day when payments are assumed', () => {
  const state = withLoan({ seen: false, assumeScheduled: true });
  assert.equal(accountValueOn(state, 'acc_loan', '2026-05-31', NOON), -1000000);
  assert.equal(accountValueOn(state, 'acc_loan', '2026-06-01', NOON), -976200);
  const [paid] = closes(state, '2026-06-01', '2026-06-01', NOON);
  // no cash was seen leaving: the principal step is not earned, billed or spent
  assert.deepEqual([paid.earned, paid.bills, paid.spent, paid.other, paid.result], [10000, 0, 0, 23800, 33800]);

  const still = withLoan({ seen: false, assumeScheduled: false });
  assert.equal(accountValueOn(still, 'acc_loan', '2026-06-16', NOON), -1000000);
});

test('the loan\'s value by day is loans.loanValueOn on every day', () => {
  const scheduled = makeAccount({
    id: 'acc_loan', type: 'loan', balance: -1000000, apr: 7.3, dueDay: 31,
    loan: { payment: 30000, assumeScheduled: true },
    history: [{ day: '2026-01-10', balance: -1000000, note: '' }, { day: '2026-04-02', balance: -900000, note: 'statement' }],
  });
  const state = emptyState();
  state.accounts.push(scheduled);
  const ledger = makeLedger(state, NOON);
  for (const day of eachDay('2025-12-20', '2026-06-16')) {
    assert.equal(ledger.accountValueOn('acc_loan', day), loanValueOn(scheduled, day, []), day);
  }

  const seen = withLoan();
  seen.txs.push(spend('2026-05-15', 30000, 'debt_service', { recurringId: 'rec_loan' }));
  const payments = [{ day: '2026-05-15', amount: 30000 }, { day: '2026-06-01', amount: 30000 }];
  const paid = makeLedger(seen, NOON);
  for (const day of eachDay('2026-04-20', '2026-06-16')) {
    assert.equal(paid.accountValueOn('acc_loan', day), loanValueOn(seen.accounts[1], day, payments), day);
  }
});

test('a loan that is paid off stays at zero, and a mistyped year does not stall the ledger', () => {
  const nearlyDone = makeAccount({
    id: 'acc_loan', type: 'loan', balance: -50000, apr: 7.3, dueDay: 5, loan: { payment: 30000, assumeScheduled: true },
    history: [{ day: '2026-01-10', balance: -50000, note: '' }, { day: '2026-05-20', balance: -40000, note: 'borrowed again' }],
  });
  const state = emptyState();
  state.accounts.push(nearlyDone);
  const ledger = makeLedger(state, NOON);
  for (const day of eachDay('2025-12-20', '2026-06-16')) {
    assert.equal(ledger.accountValueOn('acc_loan', day), loanValueOn(nearlyDone, day, []), day);
  }
  assert.equal(ledger.accountValueOn('acc_loan', '2026-03-05'), 0);
  assert.equal(ledger.accountValueOn('acc_loan', '2026-05-19'), 0);
  assert.equal(ledger.accountValueOn('acc_loan', '2026-05-20'), -40000);
  const [borrowed] = ledger.closes('2026-05-20', '2026-05-20');
  assert.deepEqual([borrowed.reval, borrowed.result], [-40000, 0]);

  const mistyped = emptyState();
  mistyped.accounts.push(makeAccount({
    id: 'acc_loan', type: 'loan', balance: -1000000, apr: 7.3, dueDay: 5, loan: { payment: 30000, assumeScheduled: true },
    history: [{ day: '1026-06-01', balance: -1000000, note: '' }], // the year 1026, not 2026
  }));
  const started = performance.now();
  assert.equal(position(mistyped, NOON).loans, 0);
  assert.equal(closes(mistyped, '2026-06-01', '2026-06-16', NOON).length, 16);
  assert.ok(performance.now() - started < 2000, 'a thousand years of due days are not each valued');
});

test('a loan re-entered from a statement is a revaluation, not a result', () => {
  const state = withLoan();
  state.accounts[1].history.push({ day: '2026-06-10', balance: -950000, note: 'statement' });
  const rows = byDay(closes(state, '2026-06-09', '2026-06-11', NOON));
  assert.equal(rows['2026-06-10'].reval, 26200); // −9,500.00 against the amortised −9,762.00
  assert.equal(rows['2026-06-10'].bank - rows['2026-06-09'].bank, 26200);
  assert.equal(rows['2026-06-10'].other, 0);
  // interest runs on at 9500 × 0.073 / 365 = 1.90 a day
  assert.equal(rows['2026-06-11'].bills, 190);
  assert.equal(rows['2026-06-11'].result, 10000 - 190);
});

test('a Book entry toward a debt: full amount for a loan without terms, nothing for a debt the bank reports', () => {
  const plain = withLoan();
  plain.accounts[1].apr = null; // not amortised: valued from its history only
  const [paid] = closes(plain, '2026-06-01', '2026-06-01', NOON);
  assert.equal(accountValueOn(plain, 'acc_loan', '2026-06-01', NOON), -1000000);
  near(position(plain, NOON).payables[0].daily, Math.round(30000 / 30.4375), 0);
  // projected from the anchor: 31 days accrued against the $300.00 payment
  assert.equal(paid.bills, Math.round(30000 / 30.4375) - Math.round(31 * 30000 / 30.4375) + 30000);

  const linked = withLoan();
  linked.accounts[1] = bankAccount('acc_loan', 'loan', -976200);
  assert.deepEqual(position(linked, NOON).payables, []);
  const [bankPaid] = closes(linked, '2026-06-01', '2026-06-01', NOON);
  assert.equal(bankPaid.bills, 30000, 'an unpaired charge is still a Book charge on its day');
});

/* --------------------------------------------- manual accounts, revaluations */

function withEquipment(history) {
  const state = emptyState();
  state.accounts.push(
    bankAccount('acc_chk', 'checking', 500000),
    makeAccount({ id: 'acc_eq', type: 'equipment', name: 'Cameras', balance: history[history.length - 1].balance, history }),
  );
  return state;
}

test('a manual account is its latest history entry; the first entry also covers earlier days', () => {
  const state = withEquipment([{ day: '2026-05-01', balance: 1800000, note: '' }, { day: '2026-06-10', balance: 1700000, note: '' }]);
  const value = (day) => accountValueOn(state, 'acc_eq', day, NOON);
  assert.equal(value('2026-01-01'), 1800000);
  assert.equal(value('2026-05-01'), 1800000);
  assert.equal(value('2026-06-09'), 1800000);
  assert.equal(value('2026-06-10'), 1700000);
  assert.equal(value('2026-06-16'), 1700000);
  const rows = byDay(closes(state, '2026-06-09', '2026-06-11', NOON));
  assert.deepEqual([rows['2026-06-09'].bank, rows['2026-06-10'].bank], [2300000, 2200000]);
  // the owner's revaluation moves net worth but is not the day's result
  assert.deepEqual([rows['2026-06-10'].reval, rows['2026-06-10'].result, rows['2026-06-10'].other], [-100000, 0, 0]);
  assert.equal(rows['2026-06-11'].reval, 0);
  const now = position(state, NOON);
  assert.deepEqual([now.slowAssets, now.cash, now.bank, now.assets, now.liabilities], [1700000, 500000, 2200000, 2200000, 0]);
});

test('a capitalised purchase: only the part that did not become an asset is spent', () => {
  const purchase = () => spend('2026-06-05', 200000, 'gear', { capital: { value: 150000, accountId: 'acc_eq' } });

  // the asset account existed before the purchase: its value steps up on the day
  const existing = withEquipment([{ day: '2026-05-01', balance: 1800000, note: '' }, { day: '2026-06-10', balance: 1700000, note: '' }]);
  existing.txs.push(purchase());
  assert.equal(accountValueOn(existing, 'acc_eq', '2026-06-04', NOON), 1800000);
  assert.equal(accountValueOn(existing, 'acc_eq', '2026-06-05', NOON), 1950000);
  let rows = byDay(closes(existing, '2026-06-05', '2026-06-10', NOON));
  assert.deepEqual([rows['2026-06-05'].result, rows['2026-06-05'].spent, rows['2026-06-05'].other, rows['2026-06-05'].reval], [-50000, 50000, 0, 0]);
  assert.deepEqual([rows['2026-06-10'].reval, rows['2026-06-10'].result], [-250000, 0]);

  // the account was created afterwards: before the purchase the asset was not owned
  const created = withEquipment([{ day: '2026-06-08', balance: 150000, note: '' }]);
  created.txs.push(purchase());
  assert.equal(accountValueOn(created, 'acc_eq', '2026-06-04', NOON), 0);
  assert.equal(accountValueOn(created, 'acc_eq', '2026-06-05', NOON), 150000);
  assert.equal(accountValueOn(created, 'acc_eq', '2026-06-08', NOON), 150000);
  rows = byDay(closes(created, '2026-06-05', '2026-06-08', NOON));
  assert.deepEqual([rows['2026-06-05'].result, rows['2026-06-05'].spent, rows['2026-06-05'].other], [-50000, 50000, 0]);
  assert.deepEqual([rows['2026-06-08'].result, rows['2026-06-08'].reval], [0, 0]);

  // an entry made on the day of the purchase already includes it
  const sameDay = withEquipment([{ day: '2026-05-01', balance: 1800000, note: '' }, { day: '2026-06-05', balance: 1950000, note: '' }]);
  sameDay.txs.push(purchase());
  rows = byDay(closes(sameDay, '2026-06-05', '2026-06-05', NOON));
  assert.deepEqual([rows['2026-06-05'].result, rows['2026-06-05'].reval, rows['2026-06-05'].other], [-50000, 0, 0]);
  assert.equal(accountValueOn(sameDay, 'acc_eq', '2026-06-05', NOON), 1950000);

  // no asset account holds it: the value left the books and shows as "other"
  const nowhere = withEquipment([{ day: '2026-05-01', balance: 1800000, note: '' }]);
  nowhere.txs.push(spend('2026-06-05', 200000, 'gear', { capital: { value: 150000, accountId: null } }));
  rows = byDay(closes(nowhere, '2026-06-05', '2026-06-05', NOON));
  assert.deepEqual([rows['2026-06-05'].result, rows['2026-06-05'].spent, rows['2026-06-05'].other], [-200000, 50000, -150000]);
});

test('position: groups, assets and liabilities, hidden accounts left out', () => {
  const state = emptyState();
  state.accounts.push(
    bankAccount('acc_chk', 'checking', 120000, { asOf: at(2026, 6, 16, 8) }),
    bankAccount('acc_sav', 'savings', 30000, { asOf: at(2026, 6, 15, 20), everyday: false }),
    bankAccount('acc_card', 'credit_card', -420000, { asOf: at(2026, 6, 15, 6) }),
    bankAccount('acc_card2', 'credit_card', 500, { asOf: at(2026, 6, 16, 7) }), // in credit
    bankAccount('acc_inv', 'investment', 250000, { asOf: at(2026, 6, 1) }),
    makeAccount({ id: 'acc_eq', type: 'equipment', balance: 1800000, history: [{ day: '2026-05-01', balance: 1800000, note: '' }] }),
    makeAccount({ id: 'acc_owed', type: 'receivable', balance: 40000, history: [{ day: '2026-05-01', balance: 40000, note: '' }] }),
    makeAccount({ id: 'acc_loan', type: 'loan', balance: -950000, history: [{ day: '2026-05-01', balance: -950000, note: '' }] }),
    makeAccount({ id: 'acc_iou', type: 'other_debt', balance: -5000, history: [{ day: '2026-05-01', balance: -5000, note: '' }] }),
    bankAccount('acc_old', 'checking', 999999, { hidden: true, asOf: at(2026, 1, 1) }),
  );
  const now = position(state, NOON);
  assert.equal(now.cash, 150000);
  assert.equal(now.cards, -419500);
  assert.equal(now.liquid, -269500);
  assert.equal(now.investments, 250000);
  assert.equal(now.slowAssets, 1840000);
  assert.equal(now.loans, -955000);
  assert.equal(now.assets, 120000 + 30000 + 500 + 250000 + 1800000 + 40000);
  assert.equal(now.liabilities, 420000 + 950000 + 5000);
  assert.equal(now.bank, now.assets - now.liabilities);
  assert.equal(now.bank, now.cash + now.cards + now.investments + now.slowAssets + now.loans);
  assert.deepEqual([now.smooth, now.live, now.provisional, now.smoothing], [now.bank, now.bank, 0, false]);
  assert.equal(now.dataAt, at(2026, 6, 15, 6), 'the oldest everyday bank balance');
  assert.equal(accountValueOn(state, 'acc_old', '2026-06-16', NOON), 999999, 'a hidden account still has a value of its own');
});

test('a hidden account is left out of everything', () => {
  const state = salaried();
  state.accounts.push(bankAccount('acc_old', 'checking', 70000, { hidden: true }));
  state.txs.push(
    spend('2026-06-13', 900, 'cafe', { accountId: 'acc_old' }),
    deposit('2026-06-13', 5000, { accountId: 'acc_old' }),
  );
  const [row] = closes(state, '2026-06-13', '2026-06-13', NOON);
  assert.deepEqual([row.bank, row.result, row.spent, row.conv, row.earned], [500000, 9000, 0, 0, 10000]);
  assert.equal(round(state, '2026-06-13', NOON).moves.length, 0);
  assert.equal(position(state, NOON).cash, 500000);
  assert.equal(accountValueOn(state, 'acc_old', '2026-06-12', NOON), 70000 - 5000 + 900);
  assert.deepEqual(spendingByCategory(state, '2026-06-13', '2026-06-13', NOON), []);

  state.streams[0].accountId = 'acc_old';
  assert.equal(position(state, NOON).smoothing, false, 'pay into a hidden account does not accrue');
});

test('money that is neither earned nor spent shows as "other"; paired transfers cancel', () => {
  const state = salaried();
  state.accounts.push(bankAccount('acc_sav', 'savings', 80000));
  state.txs.push(
    tx('2026-06-13', 20000, { kind: 'transfer', category: 'transfer', pairId: 'a' }),
    tx('2026-06-13', 20000, { kind: 'transfer', category: 'transfer', flow: 'in', accountId: 'acc_sav', pairId: 'b' }),
    tx('2026-06-14', 2500, { kind: 'transfer', category: 'transfer' }), // to an account that is not linked
  );
  const rows = byDay(closes(state, '2026-06-13', '2026-06-14', NOON));
  assert.deepEqual([rows['2026-06-13'].result, rows['2026-06-13'].other, rows['2026-06-13'].bank], [9000, 0, 582500]);
  assert.deepEqual([rows['2026-06-14'].result, rows['2026-06-14'].other, rows['2026-06-14'].spent], [6500, -2500, 0]);
});

test('Book charges outside an accruing entry are bills on the day they post', () => {
  const state = salaried();
  state.recurring.push(makeRecurring({ id: 'rec_old', name: 'Cancelled', accountId: 'acc_chk', cadence: 'monthly', anchor: '2026-06-13', amount: 1500, active: false }));
  state.txs.push(
    spend('2026-06-13', 1500, 'subscriptions', { recurringId: 'rec_old' }),      // its entry is inactive
    spend('2026-06-14', 9900, 'insurance'),                                      // book class, not linked to any entry
    tx('2026-06-15', 900, { kind: 'refund', flow: 'in', category: 'insurance' }), // a Book refund
    tx('2026-06-15', 400, { kind: 'refund', flow: 'in', category: 'groceries' }),
  );
  const rows = byDay(closes(state, '2026-06-13', '2026-06-15', NOON));
  assert.deepEqual([rows['2026-06-13'].bills, rows['2026-06-13'].spent, rows['2026-06-13'].result], [2500, 0, 7500]);
  assert.deepEqual([rows['2026-06-14'].bills, rows['2026-06-14'].spent, rows['2026-06-14'].result], [10900, 0, -900]);
  assert.deepEqual([rows['2026-06-15'].bills, rows['2026-06-15'].spent, rows['2026-06-15'].result], [100, -400, 10300]);
  assert.deepEqual(position(state, NOON).payables.map((line) => line.id), ['rec_gym']);
});

test('a Book entry whose only linked moves are between the owner\'s accounts does not accrue', () => {
  const state = salaried();
  state.accounts.push(bankAccount('acc_card', 'credit_card', -90000));
  state.recurring.push(makeRecurring({ id: 'rec_autopay', name: 'Card autopay', accountId: 'acc_chk', cadence: 'monthly', anchor: '2026-06-05', amount: 20000 }));
  state.txs.push(
    tx('2026-06-05', 20000, { kind: 'payment', category: 'card_payment', recurringId: 'rec_autopay', pairId: 'a' }),
    tx('2026-06-05', 20000, { kind: 'payment', category: 'card_payment', flow: 'in', accountId: 'acc_card', pairId: 'b' }),
  );
  assert.deepEqual(position(state, NOON).payables.map((line) => line.id), ['rec_gym']);
  const [row] = closes(state, '2026-06-05', '2026-06-05', NOON);
  assert.deepEqual([row.bills, row.other, row.result], [1000, 0, 9000]);
});

/* ------------------------------------------------------------------ rounds */

/** A match begun on Monday 1 June against a habit of $12.50 on workdays and $8.00 on days off. */
function match({ asOf = at(2026, 6, 15) } = {}) {
  const state = emptyState();
  state.meta.matchStart = '2026-06-01';
  state.habits.push({ from: '2026-06-01', work: 1250, off: 800, winWork: 600, winOff: 400, basis: 'computed', window: null, backtest: null });
  state.accounts.push(bankAccount('acc_chk', 'checking', 500000, { asOf }));
  state.sync.lastOk = asOf;
  return state;
}

/** The second week of the match: one coffee, a clean sheet, a lost day, a draw, a clean sheet, then the weekend. */
function playedFortnight(options) {
  const state = match(options);
  state.txs.push(
    spend('2026-06-08', 500, 'cafe'),        // Mon: 5.00 <= 6.00, a win; kept 7.50
    spend('2026-06-10', 1400, 'eating_out'), // Wed: 14.00 > 13.00, a loss; kept −1.50
    spend('2026-06-11', 900, 'cafe'),        // Thu: a draw; kept 3.50
    spend('2026-06-13', 300, 'convenience'), // Sat (off): 3.00 <= 4.00, a win; kept 5.00
    spend('2026-06-14', 900, 'delivery'),    // Sun (off): 9.00 > 8.00, a loss; kept −1.00
  );
  return state;
}

test('round status follows the oldest everyday bank balance (dataDay)', () => {
  const status = (state, day) => round(state, day, NOON).status;
  const current = match(); // dataDay 15 June, today 16 June
  assert.equal(status(current, '2026-05-31'), 'prematch');
  assert.equal(status(current, '2026-06-01'), 'final');
  assert.equal(status(current, '2026-06-13'), 'final');
  assert.equal(status(current, '2026-06-14'), 'provisional');
  assert.equal(status(current, '2026-06-15'), 'provisional');
  assert.equal(status(current, '2026-06-16'), 'live');
  assert.equal(status(current, '2026-06-17'), 'future');

  const behind = match({ asOf: at(2026, 6, 13) }); // dataDay 13 June
  assert.equal(status(behind, '2026-06-11'), 'final');
  assert.equal(status(behind, '2026-06-12'), 'provisional');
  assert.equal(status(behind, '2026-06-13'), 'provisional');
  assert.equal(status(behind, '2026-06-14'), 'awaiting');
  assert.equal(status(behind, '2026-06-15'), 'awaiting');
  assert.equal(status(behind, '2026-06-16'), 'live');
  assert.equal(round(behind, '2026-06-14', NOON).result, null);
  assert.equal(round(behind, '2026-06-13', NOON).result, 1);

  // the oldest EVERYDAY bank balance decides; a balance at 2 a.m. belongs to the game day before
  const two = match({ asOf: at(2026, 6, 16, 2) });
  two.accounts.push(bankAccount('acc_sav', 'savings', 1000, { asOf: at(2026, 6, 1), everyday: false }));
  assert.equal(status(two, '2026-06-13'), 'final');
  assert.equal(status(two, '2026-06-14'), 'provisional');
  two.accounts.push(bankAccount('acc_card', 'credit_card', -100, { asOf: at(2026, 6, 12) }));
  assert.equal(status(two, '2026-06-11'), 'provisional');
  assert.equal(status(two, '2026-06-13'), 'awaiting');

  // any day with a pending row is provisional
  const pending = match();
  pending.txs.push(spend('2026-06-09', 450, 'cafe', { pending: true, postedDay: null }));
  assert.equal(status(pending, '2026-06-09'), 'provisional');
  assert.equal(status(pending, '2026-06-08'), 'final');

  // with no everyday bank account there is nothing to wait for
  const noEveryday = match();
  noEveryday.accounts[0].everyday = false;
  assert.equal(position(noEveryday, NOON).dataAt, null);
  assert.deepEqual([status(noEveryday, '2026-06-14'), status(noEveryday, '2026-06-15')], ['final', 'final']);

  const unstarted = match();
  unstarted.meta.matchStart = null;
  assert.equal(status(unstarted, '2026-06-10'), 'prematch');
  assert.equal(status(unstarted, '2026-06-16'), 'prematch');
  assert.equal(status(unstarted, '2026-06-17'), 'future');
});

test('round result: win at or under the win line, loss over the loss line, a draw between', () => {
  const state = match();
  state.txs.push(
    spend('2026-06-01', 600, 'cafe'),         // Mon: on the win line
    spend('2026-06-02', 601, 'cafe'),         // Tue: a cent over
    spend('2026-06-03', 1300, 'eating_out'),  // Wed: on the loss line (12.50 rounded up to 13.00)
    spend('2026-06-04', 1301, 'eating_out'),  // Thu: a cent over
    spend('2026-06-05', 5000, 'groceries'),   // Fri: not convenience spending at all
    spend('2026-06-06', 400, 'convenience'),  // Sat (off): on the win line
    spend('2026-06-07', 800, 'delivery'),     // Sun (off): on the loss line
    spend('2026-06-08', 1000, 'cafe'),        // Mon: 10.00 less a 4.00 refund
    tx('2026-06-08', 400, { kind: 'refund', flow: 'in', category: 'cafe' }),
    spend('2026-06-09', 300, 'cafe'),         // Tue: refunded more than was spent
    tx('2026-06-09', 700, { kind: 'refund', flow: 'in', category: 'cafe' }),
  );
  const expected = {
    '2026-06-01': [600, 1, 650], '2026-06-02': [601, 0.5, 649], '2026-06-03': [1300, 0.5, -50], '2026-06-04': [1301, 0, -51],
    '2026-06-05': [0, 1, 1250], '2026-06-06': [400, 1, 400], '2026-06-07': [800, 0.5, 0], '2026-06-08': [600, 1, 650],
    '2026-06-09': [0, 1, 1250],
  };
  for (const [day, [conv, result, kept]] of Object.entries(expected)) {
    const played = round(state, day, NOON);
    assert.deepEqual([played.conv, played.result, played.kept], [conv, result, kept], day);
    assert.equal(convOn(state, day, NOON), conv, day);
  }
  const monday = round(state, '2026-06-01', NOON);
  assert.deepEqual([monday.n, monday.type, monday.habit, monday.winLine, monday.lossLine], [1, 'work', 1250, 600, 1300]);
  const saturday = round(state, '2026-06-06', NOON);
  assert.deepEqual([saturday.n, saturday.type, saturday.habit, saturday.winLine, saturday.lossLine], [6, 'off', 800, 400, 800]);
  assert.equal(round(state, '2026-06-05', NOON).clean, true);
  assert.equal(round(state, '2026-06-09', NOON).clean, true);
  assert.equal(round(state, '2026-06-01', NOON).clean, false);
});

test('rounds: only provisional and final rounds have a result; prematch rounds carry an exhibition', () => {
  const state = playedFortnight();
  state.txs.push(spend('2026-06-16', 2000, 'cafe'), spend('2026-05-29', 700, 'cafe'));
  const live = round(state, '2026-06-16', NOON);
  assert.deepEqual([live.status, live.result, live.conv, live.kept, live.clean], ['live', null, 2000, -750, false]);
  const future = round(state, '2026-06-17', NOON);
  assert.deepEqual([future.status, future.result, future.conv, future.clean], ['future', null, 0, false]);
  const exhibition = round(state, '2026-05-29', NOON); // a Friday before the match
  assert.deepEqual([exhibition.status, exhibition.result, exhibition.conv], ['prematch', 0.5, 700]);
  const quiet = round(state, '2026-05-28', NOON);
  assert.deepEqual([quiet.status, quiet.result, quiet.clean], ['prematch', 1, false]);
  const pencil = round(state, '2026-06-14', NOON);
  assert.deepEqual([pencil.status, pencil.result], ['provisional', 0]);

  const noHabit = playedFortnight();
  noHabit.habits.length = 0;
  const unscored = round(noHabit, '2026-06-10', NOON);
  assert.deepEqual([unscored.status, unscored.habit, unscored.result], ['final', 0, null]);
});

test('a declared bye scores a half and its dollars still count', () => {
  const state = playedFortnight();
  state.days['2026-06-10'] = { bye: true };
  state.days['2026-06-09'] = { bye: true };
  const lost = round(state, '2026-06-10', NOON);
  assert.deepEqual([lost.bye, lost.result, lost.conv, lost.kept], [true, 0.5, 1400, -150]);
  const clean = round(state, '2026-06-09', NOON);
  assert.deepEqual([clean.bye, clean.result, clean.kept, clean.clean], [true, 0.5, 1250, true]);
  assert.equal(round(state, '2026-06-08', NOON).bye, false);
  state.days['2026-06-16'] = { bye: true };
  assert.equal(round(state, '2026-06-16', NOON).result, null, 'today is not over');
});

test('rounds: stops, the plan and the moves in the order played', () => {
  const state = match();
  const lunch = spend('2026-06-10', 900, 'eating_out', { at: at(2026, 6, 10, 13) });
  const coffee = spend('2026-06-10', 300, 'cafe', { at: at(2026, 6, 10, 8) });
  const groceries = spend('2026-06-10', 4200, 'groceries', { at: null, loggedAt: at(2026, 6, 10, 18) });
  const declined = tx('2026-06-10', 650, { source: 'manual', kind: 'decline', accountId: null, category: 'cafe', at: at(2026, 6, 10, 15) });
  const refund = tx('2026-06-10', 100, { kind: 'refund', flow: 'in', category: 'cafe', at: at(2026, 6, 10, 20) });
  const late = spend('2026-06-10', 250, 'convenience', { at: at(2026, 6, 11, 1) }); // 1 a.m. belongs to the evening before
  state.txs.push(lunch, coffee, groceries, declined, refund, late);
  state.days['2026-06-10'] = { plan: { ready: [{ label: 'Bag packed', yes: true }, { label: 'List written', yes: null }], stops: 1, at: at(2026, 6, 10, 7) } };
  const played = round(state, '2026-06-10', NOON);
  assert.deepEqual(played.moves.map((move) => move.id), [coffee, lunch, declined, groceries, refund, late].map((move) => move.id));
  assert.equal(played.stops, 3);
  assert.equal(played.conv, 300 + 900 + 250 - 100);
  assert.deepEqual(played.plan, { ready: [{ label: 'Bag packed', yes: true }], stops: 1 });
  assert.equal(round(state, '2026-06-09', NOON).plan, null);
  assert.deepEqual(round(state, '2026-06-09', NOON).moves, []);
});

test('monthTable: score, colours, kept, finals, clean sheets, the perfect month and the weeks', () => {
  const table = monthTable(playedFortnight(), '2026-06', NOON);
  assert.equal(table.ym, '2026-06');
  assert.equal(table.rounds.length, 30);
  assert.deepEqual(table.rounds.slice(0, 16).map((played) => played.result), [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0.5, 1, 1, 0, 1, null]);
  assert.deepEqual([table.score, table.played], [12.5, 15]);
  assert.deepEqual(table.black, { score: 9.5, played: 11 });
  assert.deepEqual(table.white, { score: 3, played: 4 });
  assert.equal(table.kept, 12950);       // 78.50 + 38.50 + 12.50
  assert.equal(table.finals, 13);        // the 14th and 15th are still in pencil
  assert.equal(table.cleanSheets, 10);
  assert.equal(table.perfect, 22 * 1250 + 8 * 800);
  assert.deepEqual(table.weeks.map((week) => week.rounds.length), [7, 7, 7, 7, 2]);
  assert.deepEqual(table.weeks.map((week) => [week.score, week.played]), [[7, 7], [4.5, 7], [1, 1], [0, 0], [0, 0]]);
  assert.equal(table.weeks[1].rounds[0].day, '2026-06-08');

  // the month before the match: exhibition results are not scored
  const may = monthTable(playedFortnight(), '2026-05', NOON);
  assert.equal(may.rounds.length, 31);
  assert.ok(may.rounds.every((played) => played.status === 'prematch' && played.result !== null));
  assert.deepEqual([may.score, may.played, may.kept, may.finals, may.cleanSheets], [0, 0, 0, 0, 0]);
  assert.equal(may.perfect, 21 * 1250 + 10 * 800);

  const july = monthTable(playedFortnight(), '2026-07', NOON);
  assert.ok(july.rounds.every((played) => played.status === 'future' && played.result === null));
  assert.deepEqual(monthTable(playedFortnight(), 'June', NOON).rounds, []);
});

/* -------------------------------------------------------------------- edge */

test('edge: kept against habit, the verified part, what was moved', () => {
  const state = playedFortnight();
  state.sweeps.push({ weekOf: '2026-06-01', amount: 7800, day: '2026-06-08', txId: null, via: 'tap' });
  const result = edge(state, NOON);
  assert.equal(result.kept, 12950);
  assert.equal(result.verified, 11800); // without the 14th (−1.00) and the 15th (12.50), still in pencil
  assert.equal(result.moved, 7800);
  assert.equal(result.unmoved, 5150);
  assert.deepEqual(result.form, [1, 0, 0.5, 1, 1, 0, 1]);
  assert.equal(result.unbeaten, 1);
  assert.equal(result.bestUnbeaten, 9);

  state.sweeps.push({ weekOf: '2026-06-08', amount: 9000, day: '2026-06-15', txId: 'tx_x', via: 'auto' });
  const overMoved = edge(state, NOON);
  assert.deepEqual([overMoved.moved, overMoved.unmoved, overMoved.sweep], [16800, 0, null]);
});

test('edge: the sweep is last Monday-to-Sunday week\'s kept in whole dollars, toward the card when one is owed', () => {
  const state = playedFortnight();
  // 8–14 June: 7.50 + 12.50 − 1.50 + 3.50 + 12.50 + 5.00 − 1.00 = 38.50
  assert.deepEqual(edge(state, NOON).sweep, { weekOf: '2026-06-08', amount: 3800, target: 'reserve' });
  state.accounts.push(bankAccount('acc_card', 'credit_card', -42000));
  assert.deepEqual(edge(state, NOON).sweep, { weekOf: '2026-06-08', amount: 3800, target: 'card' });
  state.accounts[1].balance = 0;
  assert.equal(edge(state, NOON).sweep.target, 'reserve');

  // on the Sunday the last completed week is still 1–7 June: 5 × 12.50 + 2 × 8.00 = 78.50
  const sunday = playedFortnight({ asOf: at(2026, 6, 14, 9) });
  assert.deepEqual(edge(sunday, at(2026, 6, 14)).sweep, { weekOf: '2026-06-01', amount: 7800, target: 'reserve' });
  // on the Monday it becomes 8–14 June; Sunday is only just reported
  const monday = playedFortnight({ asOf: at(2026, 6, 15, 9) });
  assert.deepEqual(edge(monday, at(2026, 6, 15)).sweep, { weekOf: '2026-06-08', amount: 3800, target: 'reserve' });

  // a match that began on Wednesday the 10th counts only its own days of that week: −1.50 + 3.50 + 12.50 + 5.00 − 1.00
  const midweek = playedFortnight();
  midweek.meta.matchStart = '2026-06-10';
  assert.deepEqual(edge(midweek, NOON).sweep, { weekOf: '2026-06-08', amount: 1800, target: 'reserve' });
  assert.equal(edge(midweek, NOON).kept, 1850 + 1250);

  state.sweeps.push({ weekOf: '2026-06-08', amount: 3800, day: '2026-06-16', txId: null, via: 'tap' });
  assert.equal(edge(state, NOON).sweep, null, 'already moved');

  const thin = playedFortnight();
  thin.txs.push(spend('2026-06-09', 3360, 'eating_out')); // the week now keeps 4.90
  assert.equal(edge(thin, NOON).sweep, null, 'under $5');
  thin.txs.push(tx('2026-06-09', 10, { kind: 'refund', flow: 'in', category: 'eating_out' })); // exactly 5.00
  assert.deepEqual(edge(thin, NOON).sweep, { weekOf: '2026-06-08', amount: 500, target: 'reserve' });
});

test('edge: unbeaten runs ignore byes', () => {
  const state = playedFortnight();
  state.days['2026-06-14'] = { bye: true }; // the lost Sunday becomes a bye
  const result = edge(state, NOON);
  // 11th draw, 12th win, 13th win, [14th bye], 15th win
  assert.equal(result.unbeaten, 4);
  assert.equal(result.bestUnbeaten, 9);
  assert.deepEqual(result.form, [1, 0, 0.5, 1, 1, 0.5, 1]);
  assert.equal(result.kept, 12950, 'the bye\'s dollars still count');

  state.days['2026-06-15'] = { bye: true };
  assert.equal(edge(state, NOON).unbeaten, 3, 'a bye does not extend the run');
});

test('edge: nothing before the match begins', () => {
  const state = playedFortnight();
  state.meta.matchStart = null;
  assert.deepEqual(edge(state, NOON), { kept: 0, verified: 0, moved: 0, unmoved: 0, sweep: null, unbeaten: 0, bestUnbeaten: 0, form: [] });
  state.meta.matchStart = '2026-06-16'; // begins today: no finished round yet
  assert.deepEqual(edge(state, NOON).form, []);
  assert.equal(edge(state, NOON).sweep, null);
});

/* ------------------------------------------------------------------- clock */

/**
 * Cash $1,000.00 (checking 800.00, savings 200.00), a card owing $1,500.00 with $35.00 due on the 20th,
 * pay every second Friday (next: 26 June), and $1,500.00 of outflow from cash over the last 60 days.
 */
function household({ checking = 80000, savings = 20000 } = {}) {
  const state = emptyState();
  state.accounts.push(
    bankAccount('acc_chk', 'checking', checking, { asOf: at(2026, 6, 16, 8) }),
    bankAccount('acc_sav', 'savings', savings, { asOf: at(2026, 6, 15, 22) }),
    bankAccount('acc_card', 'credit_card', -150000, { minPayment: 3500, dueDay: 20 }),
  );
  state.streams.push(makeStream({ id: 'str_pay', name: 'Payroll', accountId: 'acc_chk', cadence: 'biweekly', anchor: '2026-06-12', amount: 140000, accrue: true }));
  const entry = (id, cadence, anchor, amount, accountId, fields = {}) =>
    makeRecurring({ id, name: id, cadence, anchor, amount, accountId, ...fields });
  state.recurring.push(
    entry('rec_rent', 'monthly', '2026-06-01', 120000, 'acc_chk'),       // next 1 July: after payday
    entry('rec_phone', 'monthly', '2026-05-20', 6000, 'acc_chk'),        // 20 June
    entry('rec_stream', 'monthly', '2026-05-18', 1500, 'acc_card'),      // 18 June, but on the card
    entry('rec_gym', 'monthly', '2026-05-22', 4000, null),               // 22 June, account unknown
    entry('rec_storage', 'monthly', '2026-05-26', 9000, 'acc_chk'),      // 26 June: payday itself
    entry('rec_paper', 'weekly', '2026-06-09', 1000, 'acc_chk'),         // 16 June (today) and 23 June
    entry('rec_gone', 'monthly', '2026-05-19', 7700, 'acc_chk', { active: false }),
  );
  state.txs.push(
    spend('2026-04-16', 99900),                                           // 61 days ago: outside the window
    spend('2026-04-17', 1000),                                            // 60 days ago: inside
    spend('2026-05-01', 60000),
    spend('2026-05-20', 30000),
    tx('2026-06-05', 30000, { kind: 'payment', category: 'card_payment', pairId: 'card_leg' }),
    tx('2026-06-05', 30000, { kind: 'payment', category: 'card_payment', flow: 'in', accountId: 'acc_card', pairId: 'cash_leg' }),
    tx('2026-06-06', 10000, { kind: 'transfer', category: 'transfer', pairId: 'sav_leg' }),
    tx('2026-06-06', 10000, { kind: 'transfer', category: 'transfer', flow: 'in', accountId: 'acc_sav', pairId: 'chk_leg' }),
    spend('2026-06-07', 5000, 'shopping', { accountId: 'acc_card' }),     // on the card: not a cash outflow
    spend('2026-06-10', 29000),
    spend('2026-06-16', 7700),                                            // today: not in the trailing window
  );
  return state;
}

test('clock: cash, next payday, what is due before it, burn, runway and milestones', () => {
  const state = household();
  state.goals.reserve.target = 800000;
  const result = clock(state, NOON);
  assert.equal(result.cash, 100000);
  assert.equal(result.asOf, at(2026, 6, 15, 22));
  assert.equal(result.nextPayday, '2026-06-26');
  assert.deepEqual(result.due, [
    { id: 'rec_paper', name: 'rec_paper', day: '2026-06-16', amount: 1000 },
    { id: 'rec_phone', name: 'rec_phone', day: '2026-06-20', amount: 6000 },
    { id: 'acc_card', name: 'acc_card minimum', day: '2026-06-20', amount: 3500 },
    { id: 'rec_gym', name: 'rec_gym', day: '2026-06-22', amount: 4000 },
    { id: 'rec_paper', name: 'rec_paper', day: '2026-06-23', amount: 1000 },
  ]);
  assert.equal(result.dueTotal, 15500);
  assert.equal(result.shortfall, 0);
  assert.equal(result.burn, 2500);       // (10 + 600 + 300 + 300 + 290) / 60 dollars a day
  assert.equal(result.runwayDays, 40);
  assert.equal(result.trouble, false);
  assert.equal(result.reserve, 20000);
  assert.equal(result.reserveTarget, 800000);
  assert.deepEqual(result.milestones, [
    { label: '1 day', amount: 2500, reached: true },
    { label: '1 week', amount: 17500, reached: true },
    { label: '2 weeks', amount: 35000, reached: false },
    { label: '1 month', amount: 75000, reached: false },
    { label: '3 months', amount: 225000, reached: false },
    { label: 'Goal', amount: 800000, reached: false },
  ]);
});

test('clock: a shortfall or a short runway is time trouble', () => {
  const short = clock(household({ checking: 5000, savings: 2000 }), NOON);
  assert.deepEqual([short.cash, short.dueTotal, short.shortfall, short.runwayDays, short.trouble], [7000, 15500, 8500, 2, true]);

  const tight = clock(household({ checking: 10000, savings: 7499 }), NOON); // covers what is due, six days of burn
  assert.deepEqual([tight.shortfall, tight.runwayDays, tight.trouble], [0, 6, true]);
  const week = clock(household({ checking: 10000, savings: 7500 }), NOON);
  assert.deepEqual([week.shortfall, week.runwayDays, week.trouble], [0, 7, false]);

  const under = clock(household({ checking: 2000, savings: 0 }), NOON);
  assert.equal(under.runwayDays, 0, 'under one day');
  const overdrawn = clock(household({ checking: -5000, savings: 0 }), NOON);
  assert.deepEqual([overdrawn.cash, overdrawn.runwayDays, overdrawn.shortfall], [-5000, 0, 20500]);
});

test('clock: reserve is the flagged cash, or all cash when none is flagged', () => {
  const state = household();
  state.accounts[1].reserve = false;
  assert.equal(clock(state, NOON).reserve, 100000);
  state.goals.reserve.target = 90000;
  const result = clock(state, NOON);
  assert.deepEqual(result.milestones.map((milestone) => milestone.reached), [true, true, true, true, false, true]);
  assert.equal(result.reserveTarget, 90000);
});

test('clock: with no payday known the window is the next 14 days, and burn may be unknown', () => {
  const state = household();
  state.streams.length = 0;
  const result = clock(state, NOON);
  assert.equal(result.nextPayday, null);
  assert.deepEqual(result.due.map((item) => [item.id, item.day]), [
    ['rec_paper', '2026-06-16'], ['rec_phone', '2026-06-20'], ['acc_card', '2026-06-20'], ['rec_gym', '2026-06-22'],
    ['rec_paper', '2026-06-23'], ['rec_storage', '2026-06-26'],
  ]);
  assert.equal(result.dueTotal, 24500);

  state.txs.length = 0;
  const quiet = clock(state, NOON);
  assert.deepEqual([quiet.burn, quiet.runwayDays, quiet.trouble], [0, null, false]);
  assert.deepEqual(quiet.milestones.map((milestone) => milestone.label), ['Goal']);
});

test('clock: payday today counts until the deposit lands; the main stream is the one that pays most', () => {
  const state = household();
  state.streams[0].anchor = '2026-06-02'; // every second Tuesday: 16 June is payday
  const waiting = clock(state, NOON);
  assert.equal(waiting.nextPayday, '2026-06-16');
  // ruling T1: on the payday itself pay is not late, and the window is today alone
  assert.deepEqual([waiting.payAwaited, waiting.dueUntil], [null, '2026-06-16']);
  for (const item of waiting.due) assert.ok(item.overdue || item.day === '2026-06-16', item.id + ' on ' + item.day);
  state.txs.push(deposit('2026-06-16', 140000, { streamId: 'str_pay' }));
  const landed = clock(state, NOON);
  assert.deepEqual([landed.nextPayday, landed.payAwaited, landed.dueUntil], ['2026-06-30', null, '2026-06-29']);
  assert.ok(landed.due.length >= 4);
  for (const item of waiting.due) assert.ok(landed.due.some((each) => each.id === item.id && each.day === item.day), item.id + ' is due either way');

  const two = household();
  two.streams.push(
    makeStream({ id: 'str_side', accountId: 'acc_chk', cadence: 'weekly', anchor: '2026-06-15', amount: 20000, accrue: true }),   // 28.57 a day
    makeStream({ id: 'str_big', accountId: 'acc_chk', cadence: 'monthly', anchor: '2026-06-18', amount: 900000, accrue: false }), // does not accrue
  );
  assert.equal(clock(two, NOON).nextPayday, '2026-06-26', 'the accruing stream with the larger daily pay');
  two.streams[0].accrue = false;
  assert.equal(clock(two, NOON).nextPayday, '2026-06-22');
  two.streams[1].accrue = false;
  assert.equal(clock(two, NOON).nextPayday, '2026-06-18', 'no stream accrues: the largest scheduled one');
});

test('clock: while a paycheck is awaited the due window runs through the following payday, and what is overdue is always listed', () => {
  const state = household();
  state.txs.push(deposit('2026-05-15', 140000, { streamId: 'str_pay' }), deposit('2026-05-29', 140000, { streamId: 'str_pay' }));
  // the phone bill of 20 May posted and the rent of May posted on the 3rd; the rent of 1 June did not
  state.txs.push(spend('2026-05-20', 6000, 'utilities', { recurringId: 'rec_phone' }), spend('2026-05-03', 120000, 'housing', { recurringId: 'rec_rent' }));
  const late = clock(state, NOON); // the deposit of 12 June has not been seen, four days on
  assert.deepEqual([late.nextPayday, late.payAwaited, late.dueUntil], ['2026-06-16', '2026-06-12', '2026-06-26']);
  assert.deepEqual(late.due.map((item) => [item.id, item.day, !!item.overdue]), [
    ['rec_rent', '2026-06-01', true],
    ['rec_paper', '2026-06-16', false],
    ['rec_phone', '2026-06-20', false],
    ['acc_card', '2026-06-20', false],
    ['rec_gym', '2026-06-22', false],
    ['rec_paper', '2026-06-23', false],
    ['rec_storage', '2026-06-26', false],
  ]);
  assert.equal(late.dueTotal, 120000 + 1000 + 6000 + 3500 + 4000 + 1000 + 9000);
  assert.equal(late.shortfall, late.dueTotal - late.cash);

  state.txs.push(deposit('2026-06-12', 140000, { streamId: 'str_pay' }));
  const paid = clock(state, NOON);
  assert.deepEqual([paid.nextPayday, paid.payAwaited, paid.dueUntil], ['2026-06-26', null, '2026-06-25']);
  assert.deepEqual(paid.due.map((item) => item.id), ['rec_rent', 'rec_paper', 'rec_phone', 'acc_card', 'rec_gym', 'rec_paper']);
});

test('T1: the payday itself, the two grace days and the third day; weekly and monthly; a stream that lapses during the wait', () => {
  const read = (anchor, deposits, cadence = 'biweekly') => {
    const state = household();
    state.streams[0].anchor = anchor;
    state.streams[0].cadence = cadence;
    // the rent of 1 June did not post: overdue in every state
    state.txs.push(spend('2026-05-03', 120000, 'housing', { recurringId: 'rec_rent' }));
    for (const day of deposits) state.txs.push(deposit(day, 140000, { streamId: 'str_pay' }));
    const now = clock(state, NOON);
    assert.ok(now.due.some((item) => item.id === 'rec_rent' && item.overdue), 'the overdue rent is listed, ' + anchor);
    assert.ok(now.dueUntil >= '2026-06-16');
    return [now.nextPayday, now.payAwaited, now.dueUntil, now.due.filter((item) => !item.overdue).map((item) => item.day).pop() || null];
  };
  // payday is today, 16 June: not late, the window is today alone
  assert.deepEqual(read('2026-06-16', ['2026-05-19', '2026-06-02']), ['2026-06-16', null, '2026-06-16', '2026-06-16']);
  // with the deposit on the record the next payday is 30 June
  assert.deepEqual(read('2026-06-16', ['2026-06-02', '2026-06-16']).slice(0, 3), ['2026-06-30', null, '2026-06-29']);
  // first and second day after the scheduled day: awaited, the window still today alone
  assert.deepEqual(read('2026-06-15', ['2026-05-18', '2026-06-01']), ['2026-06-16', '2026-06-15', '2026-06-16', '2026-06-16']);
  assert.deepEqual(read('2026-06-14', ['2026-05-17', '2026-05-31']), ['2026-06-16', '2026-06-14', '2026-06-16', '2026-06-16']);
  // third day: through the next scheduled payday after today
  assert.deepEqual(read('2026-06-13', ['2026-05-16', '2026-05-30']).slice(0, 3), ['2026-06-16', '2026-06-13', '2026-06-27']);
  // weekly: 12 June missed, four days on; the window runs through 19 June
  assert.deepEqual(read('2026-06-12', ['2026-05-30', '2026-06-06'], 'weekly').slice(0, 3), ['2026-06-16', '2026-06-12', '2026-06-19']);
  assert.deepEqual(read('2026-06-15', ['2026-06-01', '2026-06-08'], 'weekly').slice(0, 3), ['2026-06-16', '2026-06-15', '2026-06-16']);
  // monthly: 12 June missed, four days on; through 12 July. Two days on: today alone
  assert.deepEqual(read('2026-06-12', ['2026-04-12', '2026-05-12'], 'monthly').slice(0, 3), ['2026-06-16', '2026-06-12', '2026-07-12']);
  assert.deepEqual(read('2026-06-14', ['2026-04-14', '2026-05-14'], 'monthly').slice(0, 3), ['2026-06-16', '2026-06-14', '2026-06-16']);
  // the wait ends when the stream lapses (more than 1.6 periods, 22.4 days): no payday, 14 days
  assert.deepEqual(read('2026-06-12', ['2026-05-25']).slice(0, 3), ['2026-06-16', '2026-06-12', '2026-06-26']);
  assert.deepEqual(read('2026-06-12', ['2026-05-24']).slice(0, 3), [null, null, '2026-06-29']);
});

test('T4: a stream counted on arrival whose deposits stopped is listed in lapsedPay', () => {
  const state = household();
  state.streams[0].accrue = false;
  state.txs.push(deposit('2026-05-01', 140000, { streamId: 'str_pay' }));
  const ledger = makeLedger(state, NOON);
  assert.deepEqual(ledger.position().lapsedPay, [{ id: 'str_pay', name: 'Payroll', since: '2026-05-01' }]);
  assert.deepEqual(ledger.position().receivables, []);
  assert.equal(ledger.clock().nextPayday, null);
  state.txs.push(deposit('2026-06-12', 140000, { streamId: 'str_pay' }));
  assert.deepEqual(makeLedger(state, NOON).position().lapsedPay, []);
});

test('clock: only a pay stream supplies the payday; a lapsed salary and a trickle of interest leave none', () => {
  const state = household();
  state.streams.push(makeStream({ id: 'str_interest', name: 'Interest earned', accountId: 'acc_sav', cadence: 'monthly', anchor: '2026-05-30', amount: 20, accrue: false }));
  state.txs.push(deposit('2026-05-01', 140000, { streamId: 'str_pay' }), deposit('2026-05-30', 20, { streamId: 'str_interest', accountId: 'acc_sav' }));
  const lapsed = clock(state, NOON); // 46 days since the last paycheck: more than 1.6 periods
  assert.deepEqual([lapsed.nextPayday, lapsed.payAwaited, lapsed.dueUntil], [null, null, '2026-06-29']);
  assert.deepEqual(makeLedger(state, NOON).payStreams(), []);
  state.streams[0].active = false; // ended by the owner or by detection
  assert.equal(clock(state, NOON).nextPayday, null);
  state.streams[1].amount = 20000; // $200.00 a month is pay
  assert.equal(clock(state, NOON).nextPayday, '2026-06-30');
});

test('clock: an outflow up to the early days before its day settles the occurrence; a Book transfer that did not post is overdue', () => {
  const state = household();
  // the phone bill of 20 June posts on the 16th, four days early: within the 5 days of a monthly line
  state.txs.push(spend('2026-05-20', 6000, 'utilities', { recurringId: 'rec_phone' }), spend('2026-06-16', 6000, 'utilities', { recurringId: 'rec_phone' }));
  const early = clock(state, NOON);
  assert.equal(early.due.some((item) => item.id === 'rec_phone'), false);
  // a weekly line has one early day: the paper of 23 June is not settled by a charge on the 16th
  state.txs.push(spend('2026-06-16', 1000, 'subscriptions', { recurringId: 'rec_paper' }));
  assert.deepEqual(clock(state, NOON).due.filter((item) => item.id === 'rec_paper').map((item) => item.day), ['2026-06-23']);

  // a transfer to the card on the 12th of each month: May posted, June did not
  state.recurring.push(makeRecurring({ id: 'rec_autopay', name: 'Card autopay', accountId: 'acc_chk', toAccountId: 'acc_card', cadence: 'monthly', anchor: '2026-05-12', amount: 5000 }));
  state.txs.push(
    tx('2026-05-12', 5000, { kind: 'payment', category: 'card_payment', pairId: 'auto_card', recurringId: 'rec_autopay' }),
    tx('2026-05-12', 5000, { kind: 'payment', category: 'card_payment', flow: 'in', accountId: 'acc_card', pairId: 'auto_cash' }),
  );
  const missed = clock(state, NOON);
  assert.deepEqual(missed.due.find((item) => item.id === 'rec_autopay'), { id: 'rec_autopay', name: 'Card autopay', day: '2026-06-12', amount: 5000, overdue: true });
  assert.equal(missed.due.some((item) => item.id === 'acc_card'), false, 'the card is not due a second time as a minimum');
  // it posts two days after its day: settled
  state.txs.push(
    tx('2026-06-14', 5000, { kind: 'payment', category: 'card_payment', pairId: 'auto_card2', recurringId: 'rec_autopay' }),
    tx('2026-06-14', 5000, { kind: 'payment', category: 'card_payment', flow: 'in', accountId: 'acc_card', pairId: 'auto_cash2' }),
  );
  assert.equal(clock(state, NOON).due.some((item) => item.id === 'rec_autopay' && item.overdue), false);
});

test('clock: a charge already posted today is not due again; a card paid from the Book is not due twice', () => {
  const state = household();
  state.txs.push(spend('2026-06-16', 1000, 'subscriptions', { recurringId: 'rec_paper' }));
  const result = clock(state, NOON);
  assert.deepEqual(result.due.filter((item) => item.id === 'rec_paper').map((item) => item.day), ['2026-06-23']);
  assert.equal(result.dueTotal, 14500);

  state.recurring.push(makeRecurring({ id: 'rec_autopay', name: 'Card autopay', accountId: 'acc_chk', toAccountId: 'acc_card', cadence: 'monthly', anchor: '2026-05-21', amount: 5000 }));
  const autopay = clock(state, NOON);
  assert.deepEqual(autopay.due.map((item) => item.id), ['rec_phone', 'rec_autopay', 'rec_gym', 'rec_paper']);
  assert.equal(autopay.dueTotal, 16000);
});

test('clock: a card minimum is due only while the card is owed, and never more than is owed', () => {
  const state = household();
  state.accounts[2].balance = -2000;
  assert.deepEqual(clock(state, NOON).due.find((item) => item.id === 'acc_card'), { id: 'acc_card', name: 'acc_card minimum', day: '2026-06-20', amount: 2000 });
  state.accounts[2].balance = 300; // in credit
  assert.equal(clock(state, NOON).due.some((item) => item.id === 'acc_card'), false);
  state.accounts[2].balance = -150000;
  state.accounts[2].dueDay = 28; // after payday
  assert.equal(clock(state, NOON).due.some((item) => item.id === 'acc_card'), false);
});

/* ----------------------------------------------------- retention, spending */

test('retention: the month to date adds up — kept is earned − bills − spent', () => {
  const state = salaried();
  const toDate = retention(state, '2026-06-16', NOON);
  // 15 whole days and a third: pay 1,533.33, gym 153.33; a coffee and groceries 38.00
  assert.deepEqual(toDate, { ym: '2026-06', days: 16, earned: 153333, bills: 15333, spent: 3800, other: 0, kept: 134200, rate: 134200 / 153333 });
  assert.equal(toDate.kept, toDate.earned - toDate.bills - toDate.spent);
  assert.deepEqual(retention(state, '2026-06-10', NOON), { ym: '2026-06', days: 10, earned: 100000, bills: 10000, spent: 0, other: 0, kept: 90000, rate: 0.9 });
  assert.deepEqual(retention(state, '2026-06-30', NOON), toDate, 'capped at today');
  assert.deepEqual(retention(state, '2026-07-15', NOON), { ym: '2026-07', days: 0, earned: 0, bills: 0, spent: 0, other: 0, kept: 0, rate: null });
  assert.deepEqual(makeLedger(state, NOON).retention('2026-06-16'), toDate);
});

test('spendingByCategory: spends net of refunds, Book charges included, largest first', () => {
  const state = salaried();
  state.txs.push(
    tx('2026-06-13', 300, { kind: 'refund', flow: 'in', category: 'groceries' }),
    spend('2026-06-13', 800, 'cafe'),
    spend('2026-06-14', 2500, 'shopping'),
    tx('2026-06-15', 2500, { kind: 'refund', flow: 'in', category: 'shopping' }), // returned in full
    tx('2026-06-14', 9000, { kind: 'transfer', category: 'transfer' }),
    tx('2026-06-14', 650, { source: 'manual', kind: 'decline', accountId: null, category: 'cafe' }),
    provisional('2026-06-15', 450),
  );
  assert.deepEqual(spendingByCategory(state, '2026-06-01', '2026-06-16', NOON), [
    { category: 'subscriptions', klass: 'book', amount: 14000, count: 2 },
    { category: 'cafe', klass: 'game', amount: 2750, count: 3 },
    { category: 'groceries', klass: 'need', amount: 2000, count: 1 },
  ]);
  assert.deepEqual(spendingByCategory(state, '2026-06-11', '2026-06-12', NOON), [
    { category: 'groceries', klass: 'need', amount: 2300, count: 1 },
    { category: 'cafe', klass: 'game', amount: 1500, count: 1 },
  ]);
  assert.deepEqual(spendingByCategory(state, '2026-06-17', '2026-06-30', NOON), []);
  assert.deepEqual(spendingByCategory(state, 'x', 'y', NOON), []);
});

/* ----------------------------------------------------------- the calendar */

/** Pay of $100.00 a day with a deposit every second Friday from `first` to `last`. */
function steadyPay(first, last) {
  const state = emptyState();
  state.accounts.push(bankAccount('acc_chk', 'checking', 900000));
  state.streams.push(makeStream({ id: 'str_pay', accountId: 'acc_chk', cadence: 'biweekly', anchor: first, amount: 140000, accrue: true }));
  for (let day = first; day <= last; day = addDays(day, 14)) state.txs.push(deposit(day, 140000, { streamId: 'str_pay' }));
  return state;
}

test('every calendar day earns one day of pay, across clock changes, month ends and a year end', () => {
  // covers the 2026 clock changes of North America (8 Mar, 1 Nov) and Europe (29 Mar, 25 Oct), whatever zone runs this
  const state = steadyPay('2026-02-13', '2027-01-15');
  const rows = closes(state, '2026-02-14', '2027-01-10', at(2027, 1, 20));
  assert.equal(rows.length, 331);
  assert.equal(rows[0].day, '2026-02-14');
  assert.equal(rows[330].day, '2027-01-10');
  rows.forEach((row, i) => {
    assert.equal(row.day, addDays('2026-02-14', i));
    assert.equal(row.earned, 10000, row.day);
    assert.equal(row.result, 10000, row.day);
  });
  const yearEnd = closes(state, '2026-12-30', '2027-01-02', at(2027, 1, 20));
  assert.deepEqual(yearEnd.map((row) => row.day), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(yearEnd[2].smooth - yearEnd[0].smooth, 20000);
});

function inZone(zone, run) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test('a game day that loses or gains an hour: the live fraction follows the real length of the day', (t) => {
  inZone('America/New_York', () => {
    // 2026: clocks go forward on Sunday 8 March at 2 a.m., back on Sunday 1 November at 2 a.m.
    const shortDay = (gameDayStartMs('2026-03-08', 4) - gameDayStartMs('2026-03-07', 4)) / 3600000;
    const longDay = (gameDayStartMs('2026-11-01', 4) - gameDayStartMs('2026-10-31', 4)) / 3600000;
    if (shortDay !== 23 || longDay !== 25) {
      t.skip('this runtime cannot switch time zones');
      return;
    }
    const state = steadyPay('2026-02-13', '2026-11-06');
    // Saturday 7 March, 4 p.m.: 12 of the game day's 23 hours; last paid 27 February, eight days before
    const spring = position(state, at(2026, 3, 7, 16));
    assert.equal(spring.day, '2026-03-07');
    near(spring.receivable, 10000 * (8 + 12 / 23));
    // the figure moves exactly as fast as the stated rate: a day of accrual over the day's real 23 hours
    const minuteLater = position(state, at(2026, 3, 7, 16, 1));
    near(minuteLater.live - spring.live, spring.rate * 60);
    near(minuteLater.receivable - spring.receivable, 10000 / (23 * 60));
    // 3:30 a.m. on the 8th (the hour after the jump) still belongs to the 7th: 22.5 of 23 hours
    const afterJump = position(state, at(2026, 3, 8, 3, 30));
    assert.equal(afterJump.day, '2026-03-07');
    near(afterJump.receivable, 10000 * (8 + 22.5 / 23));
    assert.equal(todayOf(state, at(2026, 3, 8, 4)), '2026-03-08');
    near(position(state, at(2026, 3, 8, 16)).receivable, 10000 * (9 + 12 / 24));

    // Saturday 31 October, 4 p.m.: 12 of 25 hours; last paid 23 October
    const autumn = position(state, at(2026, 10, 31, 16));
    assert.equal(autumn.day, '2026-10-31');
    near(autumn.receivable, 10000 * (8 + 12 / 25));

    const march = byDay(closes(state, '2026-03-06', '2026-03-09', at(2026, 3, 20)));
    const november = byDay(closes(state, '2026-10-30', '2026-11-02', at(2026, 11, 20)));
    for (const row of [...Object.values(march), ...Object.values(november)]) assert.equal(row.result, 10000, row.day);

    // accrual that stopped on the short day: synced Friday 6 March at 4 p.m., so it stops Sunday 8 March at 4 a.m. EST
    // read as 5 a.m. EDT — one hour into game day 8 March
    const stale = steadyPay('2026-02-13', '2026-02-27');
    stale.sync.lastOk = at(2026, 3, 6, 16);
    near(position(stale, at(2026, 3, 12)).receivable, 10000 * (9 + 1 / 24));
  });
});

test('month tables at month and year boundaries, and in a leap February', () => {
  const state = match();
  const now = at(2028, 3, 15);
  assert.deepEqual(monthTable(state, '2028-02', now).weeks.map((week) => week.rounds.length), [7, 7, 7, 7, 1]);
  assert.deepEqual(monthTable(state, '2027-02', now).weeks.map((week) => week.rounds.length), [7, 7, 7, 7]);
  const december = monthTable(state, '2026-12', now);
  assert.deepEqual(december.weeks.map((week) => week.rounds.length), [7, 7, 7, 7, 3]);
  assert.deepEqual([december.rounds[0].day, december.rounds[30].day, december.rounds[30].n], ['2026-12-01', '2026-12-31', 31]);
  assert.equal(monthTable(state, '2028-02', now).rounds[28].day, '2028-02-29');
  assert.equal(closes(state, '2028-02-28', '2028-03-01', now).length, 3);
  const january = retention(state, '2027-01-02', now);
  assert.deepEqual([january.ym, january.days], ['2027-01', 2]);
  assert.equal(round(state, '2026-12-31', at(2027, 1, 1, 3)).status, 'live', '3 a.m. on New Year\'s Day is still the 31st');
});

/* ------------------------------------------------------ empty and malformed */

test('a document with no transactions and no accounts answers everything with zeros', () => {
  const state = emptyState();
  const ledger = makeLedger(state, NOON);
  const now = ledger.position();
  assert.deepEqual(
    [now.cash, now.cards, now.liquid, now.investments, now.slowAssets, now.loans, now.assets, now.liabilities, now.bank],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual([now.smoothing, now.receivable, now.payable, now.smooth, now.provisional, now.live, now.rate], [false, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([now.dataAt, now.syncedAt, now.freshness], [null, null, 'none']);
  const rows = ledger.closes('2026-06-01', '2026-06-16');
  assert.equal(rows.length, 16);
  for (const row of rows) assert.deepEqual([row.bank, row.smooth, row.result, row.earned, row.bills, row.spent, row.other], [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rows.map((row) => row.partial), [...Array(15).fill(false), true]);
  assert.equal(ledger.round('2026-06-15').status, 'prematch');
  assert.equal(ledger.round('2026-06-15').result, null);
  assert.equal(ledger.monthTable('2026-06').played, 0);
  assert.deepEqual(ledger.edge(), { kept: 0, verified: 0, moved: 0, unmoved: 0, sweep: null, unbeaten: 0, bestUnbeaten: 0, form: [] });
  const time = ledger.clock();
  assert.deepEqual([time.cash, time.asOf, time.nextPayday, time.due, time.burn, time.runwayDays, time.trouble], [0, null, null, [], 0, null, false]);
  assert.deepEqual(ledger.retention('2026-06-16'), { ym: '2026-06', days: 16, earned: 0, bills: 0, spent: 0, other: 0, kept: 0, rate: null });
  assert.deepEqual(ledger.spendingByCategory('2026-01-01', '2026-06-16'), []);
  assert.equal(ledger.convOn('2026-06-10'), 0);
});

test('a document with no bank accounts: manual accounts and provisional moves still count', () => {
  const state = emptyState();
  state.meta.matchStart = '2026-06-01';
  state.habits.push({ from: '2026-06-01', work: 1250, off: 800, winWork: 600, winOff: 400 });
  state.accounts.push(makeAccount({ id: 'acc_eq', type: 'equipment', balance: 1800000, history: [{ day: '2026-05-01', balance: 1800000, note: '' }] }));
  state.txs.push(provisional('2026-06-15', 700));
  const now = position(state, NOON);
  assert.deepEqual([now.bank, now.slowAssets, now.provisional, now.live, now.dataAt], [1800000, 1800000, 700, 1799300, null]);
  const rows = byDay(closes(state, '2026-06-14', '2026-06-16', NOON));
  assert.deepEqual([rows['2026-06-15'].result, rows['2026-06-15'].spent, rows['2026-06-15'].smooth], [-700, 700, 1799300]);
  // with no bank data to wait for, a past day is final unless a move is still unconfirmed
  assert.deepEqual([round(state, '2026-06-12', NOON).status, round(state, '2026-06-15', NOON).status], ['final', 'provisional']);
  assert.equal(round(state, '2026-06-15', NOON).result, 0.5);
  assert.equal(clock(state, NOON).asOf, null);
});

test('malformed rows and missing fields are skipped: nothing throws and nothing is NaN', () => {
  const state = salaried();
  state.meta.matchStart = '2026-06-01';
  state.habits.push(null, { from: 'yesterday', work: 1 }, { from: '2026-06-01', work: 1250, off: NaN, winWork: undefined, winOff: 400 });
  state.accounts.push(
    null, { id: 'acc_weird', type: 'spaceship', balance: 5 }, { type: 'checking' },
    makeAccount({ id: 'acc_nan', source: 'bank', type: 'checking', balance: NaN, asOf: NaN }),
    makeAccount({ id: 'acc_hist', type: 'equipment', balance: undefined, history: [null, { day: '2026-02-30', balance: 5 }, { day: '2026-06-01', balance: 'lots' }] }),
    makeAccount({ id: 'acc_badloan', type: 'loan', balance: -1000, apr: 5, loan: { payment: 100, assumeScheduled: true }, dueDay: 45, history: 'none' }),
  );
  state.txs.push(
    null, undefined, 42, {}, { day: '2026-06-13' },
    tx('2026-06-13', NaN), tx('2026-06-13', -500), tx('2026-06-13', Infinity), tx('2026-02-30', 100), tx('June 13', 100), tx(null, 100),
    tx('2026-06-13', 100, { accountId: 'acc_nobody' }), tx('2026-06-13', 100, { kind: 'mystery' }), tx('2026-06-13', 100, { flow: 'sideways' }),
    tx('2026-06-13', 100, { category: 'no_such_category', klass: 'game' }), tx('2026-06-13', 100, { capital: { value: NaN, accountId: 'acc_hist' } }),
    tx('2026-06-13', 100, { capital: 'yes' }), tx('2026-06-13', 100, { recurringId: 'rec_nobody', streamId: 'str_nobody' }),
    tx('2026-06-13', 100, { accountId: 'acc_nan' }), provisional('2026-06-13', NaN), provisional('2026-06-13', 100, { flow: 'in' }),
  );
  state.streams.push(null, {}, makeStream({ id: 'str_bad', cadence: 'fortnightly', anchor: '2026-06-01', amount: 5, accrue: true }),
    makeStream({ id: 'str_nan', cadence: 'weekly', anchor: '2026-06-01', amount: NaN, accrue: true }));
  state.recurring.push(null, {}, makeRecurring({ id: 'rec_bad', cadence: 'fortnightly', anchor: '2026-06-01', amount: 5 }),
    makeRecurring({ id: 'rec_nan', cadence: 'weekly', anchor: 'soon', amount: NaN }),
    makeRecurring({ id: 'rec_noanchor', cadence: 'weekly', anchor: '', amount: 700 }));
  state.sweeps.push(null, { weekOf: 5 }, { weekOf: '2026-06-01', amount: NaN });
  state.days['2026-06-13'] = 'a note';
  state.days['2026-06-12'] = { plan: 'none', bye: 'yes', type: 'holiday' };
  state.days['2026-06-11'] = { plan: { ready: [{ label: 'Bag packed', yes: 'yes' }, null, 7, { label: '', yes: true }], stops: NaN } };

  const everything = (doc, now) => {
    const ledger = makeLedger(doc, now);
    return [
      ledger.position(), ledger.closes('2026-06-01', '2026-06-16'), ledger.round('2026-06-13'), ledger.round('nonsense'),
      ledger.monthTable('2026-06'), ledger.monthTable('2026-13'), ledger.edge(), ledger.clock(), ledger.retention('2026-06-16'),
      ledger.retention(undefined), ledger.spendingByCategory('2026-06-01', '2026-06-16'), ledger.convOn('2026-06-13'),
      ledger.accountValueOn('acc_hist', '2026-06-13'), ledger.accountValueOn('acc_badloan', '2026-06-13'),
      ledger.accountValueOn('acc_nan', 'never'), ledger.habitFor('2026-06-13'), ledger.dayType(undefined),
      position(doc, now), closes(doc, '2026-06-10', '2026-06-12', now), round(doc, '2026-06-12', now), monthTable(doc, '2026-06', now),
      edge(doc, now), clock(doc, now), retention(doc, '2026-06-12', now), spendingByCategory(doc, '2026-06-01', '2026-06-12', now),
      convOn(doc, '2026-06-12', now), accountValueOn(doc, 'acc_chk', '2026-06-12', now), todayOf(doc, now), dayType(doc, '2026-06-12'),
      habitFor(doc, '2026-06-12'),
    ];
  };
  assertNoNaN(everything(state, NOON));
  // the well-formed part of the document is untouched by the rubbish around it
  const rows = byDay(closes(state, '2026-06-12', '2026-06-13', NOON));
  assert.equal(rows['2026-06-12'].result, 6700);
  assert.equal(rows['2026-06-13'].earned, 10000);
  assert.equal(accountValueOn(state, 'acc_badloan', '2026-06-13', NOON), -1000);
  assert.deepEqual(round(state, '2026-06-11', NOON).plan, { ready: [], stops: null });
  assert.equal(round(state, '2026-06-12', NOON).plan, null);

  // settings that make no sense fall back rather than poison the arithmetic
  for (const rolloverHour of [-1e300, 1e300, NaN, 'four', 24]) {
    state.settings.rolloverHour = rolloverHour;
    assertNoNaN(everything(state, NOON));
    assert.equal(todayOf(state, at(2026, 6, 16, 0, 30)), '2026-06-16', 'read as midnight');
  }
  state.settings.rolloverHour = 4;

  for (const doc of [null, undefined, 7, 'state', {}, { txs: {}, accounts: 'none', settings: null, days: [], habits: {}, sync: 3, meta: null, goals: 1 }]) {
    for (const now of [NOON, NaN, undefined, Infinity, 1e300]) assertNoNaN(everything(doc, now));
  }
  assert.ok(isYmd(todayOf(null, NaN)), 'a clock that cannot be read is the epoch, never the real time');
});

/* ------------------------------------------- against the specification, slowly */

/**
 * ARCHITECTURE 4.2 and 4.3 read literally for the end of one finished day, with no index at all:
 * every figure is recomputed from every transaction. Slow, obvious, and independent of the ledger.
 */
function closeBySpecification(state, day, now) {
  const today = todayOf(state, now);
  const visible = (id) => state.accounts.some((account) => account.id === id && !account.hidden);
  const counted = (move) => move.kind !== 'decline' && !move.matchId && move.source !== 'manual'
    && visible(move.accountId) && (state.settings.countPending || !move.pending);
  const effect = (move) => (move.flow === 'in' ? move.amount : -move.amount);

  let bank = 0;
  for (const account of state.accounts.filter((each) => !each.hidden)) {
    if (account.source === 'bank') {
      const own = state.txs.filter((move) => move.accountId === account.id && counted(move));
      const balanceNow = account.balance + own.filter((move) => move.pending).reduce((total, move) => total + effect(move), 0);
      bank += balanceNow - own.filter((move) => move.day > day).reduce((total, move) => total + effect(move), 0);
    } else {
      const entries = [...account.history].sort((a, b) => (a.day < b.day ? -1 : 1));
      bank += (entries.findLast((entry) => entry.day <= day) || entries[0]).balance;
    }
  }

  const accrued = (item, linkedDays, capPeriods, lapsePeriods) => {
    const cadenceDays = CADENCES[item.cadence].days;
    const earlier = linkedDays.filter((linked) => linked <= day).sort();
    const first = linkedDays.length ? [...linkedDays].sort()[0] : null;
    // no pre-history: before the first linked move only the one scheduled period ahead of it counts
    const reset = earlier.length ? earlier[earlier.length - 1] : lastOccurrence(item, day);
    if (first !== null && !earlier.length && reset !== lastOccurrence(item, addDays(first, -1))) return 0;
    const days = diffDays(reset, day) + 1; // from the reset day through this day, inclusive
    if (days > lapsePeriods * cadenceDays) return 0;
    return item.amount / cadenceDays * Math.min(days, capPeriods * cadenceDays);
  };
  let receivable = 0;
  let payable = 0;
  const accruing = state.streams.filter((stream) => stream.active && stream.accrue && stream.cadence && stream.anchor);
  if (state.settings.smoothing && accruing.length) {
    for (const stream of accruing) {
      const paid = state.txs.filter((move) => counted(move) && move.kind === 'income' && move.streamId === stream.id).map((move) => move.day);
      receivable += accrued(stream, paid, 1.6, 1.6);
    }
    for (const entry of state.recurring.filter((each) => each.active)) {
      const charged = state.txs.filter((move) => counted(move) && move.kind === 'spend' && move.recurringId === entry.id).map((move) => move.day);
      payable += accrued(entry, charged, 1.25, 1.5);
    }
  }

  const unconfirmed = state.txs
    .filter((move) => move.source === 'manual' && move.kind === 'spend' && !move.matchId)
    .filter((move) => move.day <= day && diffDays(move.day, today) <= 7)
    .reduce((total, move) => total + move.amount, 0);
  return { bank, smooth: bank + Math.round(receivable) - Math.round(payable) - unconfirmed };
}

/** A deterministic, invented tangle of everything at once, over the 150 days ending on `now`. */
function tangledDocument(now) {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const state = defaultState(now);
  const today = todayOf(state, now);
  const start = addDays(today, -149);
  state.sync.lastOk = now - 3600000;
  state.accounts.push(
    bankAccount('acc_chk', 'checking', 231907, { asOf: now - 3600000 }),
    bankAccount('acc_sav', 'savings', 88000, { asOf: now - 3600000 }),
    bankAccount('acc_card', 'credit_card', -187455, { asOf: now - 3600000 }),
    bankAccount('acc_old', 'checking', 4411, { hidden: true }),
    makeAccount({ id: 'acc_eq', type: 'equipment', balance: 610000, history: [{ day: addDays(start, 20), balance: 640000, note: '' }, { day: addDays(start, 95), balance: 610000, note: '' }] }),
  );
  state.streams.push(
    makeStream({ id: 'str_pay', accountId: 'acc_chk', cadence: 'biweekly', anchor: addDays(today, -3), amount: 187311, accrue: true }),
    makeStream({ id: 'str_rent', accountId: 'acc_chk', cadence: 'monthly', anchor: addDays(today, -40), amount: 45000, accrue: true }), // nothing linked
    makeStream({ id: 'str_gigs', accountId: 'acc_chk', cadence: null, anchor: null, amount: 20000, accrue: false }),
  );
  for (let day = addDays(today, -3), k = 0; day >= addDays(start, 40); day = addDays(day, -14), k += 1) {
    if (k === 4) continue; // one paycheck went missing
    state.txs.push(deposit(k === 2 ? addDays(day, 1) : day, k === 5 ? 201000 : 187311, { streamId: 'str_pay' }));
  }
  const bills = [
    ['rec_a', 'weekly', 5, 1299, 'acc_card'], ['rec_b', 'biweekly', 9, 4500, 'acc_chk'], ['rec_c', 'monthly', 12, 120000, 'acc_chk'],
    ['rec_d', 'monthly', 2, 1599, 'acc_card'], ['rec_e', 'quarterly', 30, 9900, 'acc_card'], ['rec_f', 'semimonthly', 6, 2500, 'acc_chk'],
  ];
  for (const [id, cadence, ago, amount, accountId] of bills) {
    const anchor = addDays(today, -ago);
    state.recurring.push(makeRecurring({ id, name: id, accountId, cadence, anchor, amount }));
    const step = Math.round(CADENCES[cadence].days);
    for (let day = anchor; day >= addDays(start, 30); day = addDays(day, -step)) {
      state.txs.push(spend(day, amount + Math.floor(random() * 3) * 50, 'subscriptions', { recurringId: id, accountId }));
    }
  }
  state.recurring.push(
    makeRecurring({ id: 'rec_manual', name: 'No charge linked', accountId: 'acc_chk', cadence: 'monthly', anchor: addDays(today, -200), amount: 7000 }),
    makeRecurring({ id: 'rec_lapsed', name: 'Stopped coming', accountId: 'acc_card', cadence: 'weekly', anchor: addDays(today, -60), amount: 900 }),
    makeRecurring({ id: 'rec_off', name: 'Cancelled', accountId: 'acc_chk', cadence: 'monthly', anchor: addDays(today, -50), amount: 3000, active: false }),
  );
  for (let k = 0; k < 4; k++) state.txs.push(spend(addDays(today, -60 - 7 * k), 900, 'subscriptions', { recurringId: 'rec_lapsed', accountId: 'acc_card' }));
  state.txs.push(spend(addDays(today, -50), 3000, 'subscriptions', { recurringId: 'rec_off' }));
  const categories = ['cafe', 'eating_out', 'groceries', 'transit', 'shopping', 'convenience', 'fuel_auto'];
  while (state.txs.length < 1200) {
    const day = addDays(start, Math.floor(random() * 150));
    const accountId = pick(['acc_chk', 'acc_card', 'acc_card', 'acc_old']);
    const roll = random();
    if (roll < 0.9) state.txs.push(spend(day, 100 + Math.floor(random() * 6000), pick(categories), { accountId, pending: day >= addDays(today, -1) && random() < 0.5 }));
    else if (roll < 0.94) state.txs.push(tx(day, 500 + Math.floor(random() * 3000), { kind: 'refund', flow: 'in', category: pick(categories), accountId }));
    else if (roll < 0.97) state.txs.push(deposit(day, 5000 + Math.floor(random() * 20000), { streamId: random() < 0.5 ? 'str_gigs' : null }));
    else state.txs.push(tx(day, 2000 + Math.floor(random() * 9000), { kind: 'transfer', category: 'transfer' }));
  }
  state.txs.push(
    provisional(addDays(today, -2), 725), provisional(today, 410), provisional(addDays(today, -7), 380),
    provisional(addDays(today, -8), 999),                         // stale
    provisional(addDays(today, -1), 640, { matchId: 'tx_1' }),    // confirmed by the bank
    tx(addDays(today, -1), 550, { source: 'manual', kind: 'decline', accountId: null, category: 'cafe' }),
  );
  return state;
}

test('closes agree with the specification recomputed from scratch for every day', () => {
  const now = at(2026, 9, 15, 14);
  for (const countPending of [true, false]) {
    const state = tangledDocument(now);
    state.settings.countPending = countPending;
    const today = todayOf(state, now);
    const from = addDays(today, -190); // 40 days before the first transaction as well
    const rows = closes(state, from, addDays(today, -1), now);
    assert.equal(rows.length, 190);
    let before = closeBySpecification(state, addDays(from, -1), now);
    for (const row of rows) {
      const expected = closeBySpecification(state, row.day, now);
      assert.deepEqual([row.bank, row.smooth], [expected.bank, expected.smooth], row.day + (countPending ? '' : ' (pending left out)'));
      assert.equal(row.result + row.reval, expected.smooth - before.smooth, row.day);
      assert.equal(row.other, row.result - (row.earned - row.bills - row.spent), row.day);
      before = expected;
    }
    assert.equal(rows.reduce((total, row) => total + row.reval, 0), -30000, 'the one revaluation in the window');
  }
});

test('with smoothing off the same document closes at its bank balances less unconfirmed moves', () => {
  const now = at(2026, 9, 15, 14);
  const state = tangledDocument(now);
  state.settings.smoothing = false;
  const today = todayOf(state, now);
  for (const row of closes(state, addDays(today, -160), addDays(today, -1), now)) {
    const expected = closeBySpecification(state, row.day, now);
    assert.deepEqual([row.bank, row.smooth], [expected.bank, expected.smooth], row.day);
    if (row.day < addDays(today, -7)) assert.equal(row.smooth, row.bank, row.day);
  }
});

/* ---------------------------------------------------- the ledger as a whole */

test('the standalone functions answer exactly as the ledger\'s methods do', () => {
  const state = playedFortnight();
  state.streams.push(...salaried().streams);
  state.recurring.push(...salaried().recurring);
  state.txs.push(...salaried().txs, provisional('2026-06-15', 450));
  const ledger = makeLedger(state, NOON);
  assert.equal(ledger.today, todayOf(state, NOON));
  assert.deepEqual(ledger.position(), position(state, NOON));
  assert.deepEqual(ledger.closes('2026-05-20', '2026-06-16'), closes(state, '2026-05-20', '2026-06-16', NOON));
  assert.deepEqual(ledger.round('2026-06-11'), round(state, '2026-06-11', NOON));
  assert.deepEqual(ledger.monthTable('2026-06'), monthTable(state, '2026-06', NOON));
  assert.deepEqual(ledger.edge(), edge(state, NOON));
  assert.deepEqual(ledger.clock(), clock(state, NOON));
  assert.deepEqual(ledger.retention('2026-06-16'), retention(state, '2026-06-16', NOON));
  assert.deepEqual(ledger.spendingByCategory('2026-06-01', '2026-06-16'), spendingByCategory(state, '2026-06-01', '2026-06-16', NOON));
  assert.equal(ledger.convOn('2026-06-11'), convOn(state, '2026-06-11', NOON));
  assert.equal(ledger.accountValueOn('acc_chk', '2026-06-11'), accountValueOn(state, 'acc_chk', '2026-06-11', NOON));
  assert.equal(ledger.dayType('2026-06-11'), dayType(state, '2026-06-11'));
  assert.deepEqual(ledger.habitFor('2026-06-11'), habitFor(state, '2026-06-11'));
  // asking twice, in any order, gives the same answers
  assert.deepEqual(ledger.closes('2026-06-10', '2026-06-12'), closes(state, '2026-06-10', '2026-06-12', NOON));
  assert.equal(ledger.round('2026-06-11'), ledger.round('2026-06-11'));
  assert.equal(ledger.monthTable('2026-06').rounds[10], ledger.round('2026-06-11'));
});

test('a ledger describes the document as it was when first asked; the standalone functions always read it afresh', () => {
  const state = salaried();
  const ledger = makeLedger(state, NOON);
  assert.equal(ledger.position().cash, 500000);
  state.accounts[0].balance += 2500;
  state.txs.push(spend('2026-06-15', 800, 'cafe'));
  assert.equal(ledger.position().cash, 500000);
  assert.equal(ledger.convOn('2026-06-15'), 0);
  assert.equal(position(state, NOON).cash, 502500);
  assert.equal(convOn(state, '2026-06-15', NOON), 800);
  assert.equal(makeLedger(state, NOON).round('2026-06-15').conv, 800);
});

test('every figure of a close, a round, a month, the edge and the clock is whole cents', () => {
  const state = playedFortnight();
  // awkward amounts: $1,234.57 every two weeks, a $9.99 monthly bill, an 18.24% loan
  state.streams.push(makeStream({ id: 'str_pay', accountId: 'acc_chk', cadence: 'biweekly', anchor: '2026-06-12', amount: 123457, accrue: true }));
  state.recurring.push(
    makeRecurring({ id: 'rec_app', accountId: 'acc_chk', cadence: 'monthly', anchor: '2026-06-03', amount: 999 }),
    makeRecurring({ id: 'rec_loan', accountId: 'acc_chk', toAccountId: 'acc_loan', cadence: 'monthly', anchor: '2026-06-02', amount: 21050 }),
  );
  state.accounts.push(makeAccount({
    id: 'acc_loan', type: 'loan', balance: -733319, apr: 18.24, dueDay: 2, loan: { payment: 21050, assumeScheduled: false },
    history: [{ day: '2026-04-11', balance: -733319, note: '' }],
  }));
  state.txs.push(
    deposit('2026-05-29', 123457, { streamId: 'str_pay' }), deposit('2026-06-12', 120001, { streamId: 'str_pay' }),
    spend('2026-06-03', 1049, 'subscriptions', { recurringId: 'rec_app' }),
    spend('2026-05-02', 21050, 'debt_service', { recurringId: 'rec_loan' }), spend('2026-06-02', 21050, 'debt_service', { recurringId: 'rec_loan' }),
    provisional('2026-06-15', 333),
  );
  const ledger = makeLedger(state, at(2026, 6, 16, 17, 23));
  const notMoney = new Set(['moves', 'rounds', 'weeks', 'score', 'result', 'form']); // rows, and scores in half points
  const whole = (value, path) => {
    if (typeof value === 'number') assert.ok(Number.isInteger(value), path + ' = ' + value);
    else if (Array.isArray(value)) value.forEach((item, i) => whole(item, path + '[' + i + ']'));
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) if (!notMoney.has(key)) whole(value[key], path + '.' + key);
    }
  };
  const rows = ledger.closes('2026-04-20', '2026-06-16');
  whole(rows, 'closes');
  for (const row of rows) {
    assert.ok(Number.isInteger(row.result), row.day);
    assert.equal(row.other, row.result - (row.earned - row.bills - row.spent), row.day);
    assert.equal(row.other, 0, row.day + ' has nothing unexplained');
  }
  rows.slice(1).forEach((row, i) => assert.equal(row.smooth - rows[i].smooth, row.result + row.reval, row.day));
  const table = ledger.monthTable('2026-06');
  whole(table, 'month');
  table.rounds.forEach((played) => whole(played, 'round ' + played.day));
  whole(ledger.edge(), 'edge');
  whole(ledger.clock(), 'clock');
  // only the five live figures of a position may carry fractions of a cent
  const now = ledger.position();
  for (const [key, value] of Object.entries(now)) {
    if (typeof value === 'number' && !['receivable', 'payable', 'smooth', 'live', 'rate'].includes(key)) assert.ok(Number.isInteger(value), key);
  }
  for (const line of [...now.receivables, ...now.payables]) assert.ok(Number.isInteger(line.amount) && Number.isInteger(line.daily));
  assert.ok(!Number.isInteger(now.receivable) && !Number.isInteger(now.live));
  near(now.live, rows[rows.length - 1].smooth, 1);
});

/* -------------------------------------------------------------- performance */

/** A deterministic, invented document: `count` transactions over the `days` days ending today. */
function busyDocument(now, count, days) {
  let seed = 20260915;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const state = defaultState(now);
  const today = todayOf(state, now);
  const start = addDays(today, -(days - 1));
  state.meta.matchStart = addDays(today, -300);
  state.habits.push({ from: state.meta.matchStart, work: 1450, off: 900, winWork: 700, winOff: 500 });
  state.accounts.push(
    bankAccount('acc_chk', 'checking', 412345, { asOf: now - 3600000 }),
    bankAccount('acc_sav', 'savings', 150000, { asOf: now - 3600000 }),
    bankAccount('acc_card', 'credit_card', -398765, { asOf: now - 7200000, minPayment: 4000, dueDay: 21 }),
    makeAccount({ id: 'acc_eq', type: 'equipment', balance: 1800000, history: [{ day: start, balance: 1800000, note: '' }] }),
    makeAccount({
      id: 'acc_loan', type: 'loan', balance: -950000, apr: 6.5, dueDay: 5, loan: { payment: 24000, assumeScheduled: true },
      history: [{ day: start, balance: -950000, note: '' }],
    }),
  );
  state.sync.lastOk = now - 3600000;
  state.streams.push(makeStream({ id: 'str_pay', accountId: 'acc_chk', cadence: 'biweekly', anchor: addDays(today, -4), amount: 190000, accrue: true }));
  for (let day = addDays(today, -4); day >= start; day = addDays(day, -14)) state.txs.push(deposit(day, 190000, { streamId: 'str_pay' }));
  for (let i = 0; i < 24; i++) {
    const id = 'rec_' + i;
    const anchor = addDays(today, -(i + 1));
    state.recurring.push(makeRecurring({ id, name: 'Bill ' + i, accountId: i % 3 ? 'acc_card' : 'acc_chk', cadence: 'monthly', anchor, amount: 900 + i * 350 }));
    for (let day = anchor, k = 0; day >= start; k += 1, day = addDays(anchor, -Math.round(k * 30.4375))) {
      state.txs.push(spend(day, 900 + i * 350, 'subscriptions', { recurringId: id, accountId: i % 3 ? 'acc_card' : 'acc_chk' }));
    }
  }
  const categories = ['cafe', 'eating_out', 'groceries', 'transit', 'shopping', 'convenience', 'delivery', 'household'];
  while (state.txs.length < count) {
    const day = addDays(start, Math.floor(random() * days));
    const category = categories[Math.floor(random() * categories.length)];
    state.txs.push(spend(day, 150 + Math.floor(random() * 4000), category, { accountId: random() < 0.6 ? 'acc_card' : 'acc_chk', at: null }));
  }
  return state;
}

test('10,000 transactions: closes over 400 days and a month table in a few milliseconds', (t) => {
  const now = at(2026, 9, 15, 14);
  const state = busyDocument(now, 10000, 400);
  assert.equal(state.txs.length, 10000);
  const today = todayOf(state, now);
  const from = addDays(today, -399);
  makeLedger(busyDocument(now, 2000, 400), now).closes(from, today); // let the runtime warm up on other data

  const built = performance.now();
  const ledger = makeLedger(state, now);
  ledger.position();
  const indexed = performance.now();
  const rows = ledger.closes(from, today);
  const table = ledger.monthTable('2026-09');
  const answered = performance.now();

  assert.equal(rows.length, 400);
  assert.equal(table.rounds.length, 30);
  assertNoNaN(rows);
  for (const row of rows) assert.equal(row.other, row.result - (row.earned - row.bills - row.spent), row.day);
  near(ledger.position().live, rows[399].smooth, 1);
  t.diagnostic('index built in ' + (indexed - built).toFixed(1) + ' ms; 400 closes and a month table in ' + (answered - indexed).toFixed(1) + ' ms');
  assert.ok(answered - indexed < 50, 'closes and month table took ' + (answered - indexed).toFixed(1) + ' ms');
  assert.ok(indexed - built < 150, 'building the indexes took ' + (indexed - built).toFixed(1) + ' ms');

  const again = performance.now();
  ledger.closes(from, today);
  ledger.monthTable('2026-09');
  ledger.edge();
  assert.ok(performance.now() - again < 50);
});

/* ------------------------------------------- late, stopped, hand-added, ahead */

test('clock: a Book charge whose day passed unseen stays due, marked overdue, until it posts or the entry lapses', () => {
  const state = salaried(); // gym: $70.00 weekly, last charged Jun 10; the Jun 17 charge has not been reported
  const gymDue = (now) => clock(state, now).due.filter((item) => item.id === 'rec_gym');
  assert.deepEqual(gymDue(at(2026, 6, 17)), [{ id: 'rec_gym', name: 'Gym', day: '2026-06-17', amount: 7000 }, { id: 'rec_gym', name: 'Gym', day: '2026-06-24', amount: 7000 }]);
  assert.deepEqual(gymDue(at(2026, 6, 18))[0], { id: 'rec_gym', name: 'Gym', day: '2026-06-17', amount: 7000, overdue: true });
  assert.deepEqual(gymDue(at(2026, 6, 20))[0], { id: 'rec_gym', name: 'Gym', day: '2026-06-17', amount: 7000, overdue: true });
  assert.ok(gymDue(at(2026, 6, 21)).every((item) => !item.overdue), '11 days after the last charge is past 1.5 periods: lapsed');
  state.txs.push(spend('2026-06-17', 7000, 'subscriptions', { recurringId: 'rec_gym' }));
  assert.ok(gymDue(at(2026, 6, 18)).every((item) => !item.overdue && item.day > '2026-06-17'), 'posted: not due again');
});

test('clock: a hand-added line is late only after its anchor; the anchor of a line never charged is not itself late', () => {
  const state = salaried();
  state.recurring.push(makeRecurring({ id: 'rec_hand', name: 'Studio', accountId: 'acc_chk', cadence: 'weekly', anchor: '2026-06-09', amount: 3000, source: 'manual' }));
  const handDue = (now) => clock(state, now).due.filter((item) => item.id === 'rec_hand').map((item) => [item.day, !!item.overdue]);
  assert.deepEqual(handDue(at(2026, 6, 15)), [['2026-06-16', false], ['2026-06-23', false]], 'Jun 9 is the last charge the owner knows of');
  assert.deepEqual(handDue(at(2026, 6, 17)), [['2026-06-16', true], ['2026-06-23', false]]);
  assert.ok(handDue(at(2026, 6, 20)).every(([, late]) => !late), 'no charge seen for 1.5 periods after the anchor: lapsed');
});

test('clock: a payday that passed with no deposit stays the next payday, at today, until the stream lapses', () => {
  const state = salaried();
  state.txs = state.txs.filter((row) => !(row.streamId === 'str_pay' && row.day === '2026-06-12'));
  state.sync.lastOk = at(2026, 6, 21, 9);
  assert.equal(clock(state, at(2026, 6, 11)).nextPayday, '2026-06-12');
  assert.equal(clock(state, at(2026, 6, 13)).nextPayday, '2026-06-13', 'expected any day');
  assert.equal(clock(state, at(2026, 6, 20)).nextPayday, '2026-06-20');
  assert.deepEqual(position(state, at(2026, 6, 20)).lapsedPay, []);
  const stopped = at(2026, 6, 21); // 23 days after May 29: past 1.6 periods
  assert.equal(clock(state, stopped).nextPayday, null, 'a lapsed stream supplies no payday');
  assert.equal(position(state, stopped).receivable, 0);
  assert.deepEqual(position(state, stopped).lapsedPay, [{ id: 'str_pay', name: 'Payroll', since: '2026-05-29' }]);
  assert.equal(position(state, stopped).rate <= 0, true, 'its rate no longer counts');
  state.sync.lastOk = at(2026, 6, 16, 9); // the feed went quiet on Jun 16: nobody knows the deposits stopped
  assert.equal(clock(state, stopped).nextPayday, '2026-06-21');
  assert.deepEqual(position(state, stopped).lapsedPay, []);
});

test('a Book line added by hand: nothing before its since day or a future anchor, and it lapses when no charge is seen', () => {
  const state = salaried();
  state.recurring.push(
    makeRecurring({ id: 'rec_next', name: 'Next week', accountId: 'acc_chk', cadence: 'weekly', anchor: '2026-06-23', amount: 7000, source: 'manual', since: '2026-06-16' }),
    makeRecurring({ id: 'rec_past', name: 'Last week', accountId: 'acc_chk', cadence: 'weekly', anchor: '2026-06-09', amount: 7000, source: 'manual', since: '2026-06-14' }),
  );
  state.sync.lastOk = null; // never stale: nothing holds the accruals still
  const line = (id, now) => position(state, now).payables.find((row) => row.id === id);
  assert.equal(line('rec_next', NOON), undefined, 'a bill that starts next week has not been used');
  assert.equal(line('rec_next', at(2026, 6, 22, 23)), undefined);
  assert.equal(line('rec_next', at(2026, 6, 24)).since, '2026-06-23');
  assert.equal(line('rec_past', NOON).since, '2026-06-14', 'never before the day it was added');
  assert.equal(line('rec_past', at(2026, 6, 13)), undefined);
  assert.equal(line('rec_past', at(2026, 6, 25)), undefined, 'no charge for 1.5 periods: lapsed');
  assert.ok(!clock(state, NOON).due.some((item) => item.id === 'rec_next' && item.day < '2026-06-23'));
});

test('a row dated after today moves no earlier close and is in no result until its day arrives', () => {
  const plain = salaried();
  const ahead = salaried();
  ahead.txs.push(spend('2026-06-18', 5000, 'cafe'));
  assert.deepEqual(closes(ahead, '2026-06-01', '2026-06-16', NOON), closes(plain, '2026-06-01', '2026-06-16', NOON));
  assert.equal(accountValueOn(ahead, 'acc_chk', '2026-06-15', NOON), accountValueOn(plain, 'acc_chk', '2026-06-15', NOON));
  const [today] = closes(ahead, '2026-06-16', '2026-06-16', NOON);
  assert.equal(today.other, 0);
  const [arrived] = closes(ahead, '2026-06-18', '2026-06-18', at(2026, 6, 18));
  assert.equal(arrived.spent, 5000);
});

test('a loan payment before the loan\'s first entry is part interest, part principal too', () => {
  const state = withLoan();
  state.txs.push(spend('2026-04-01', 30000, 'debt_service', { recurringId: 'rec_loan' }));
  const before = accountValueOn(state, 'acc_loan', '2026-03-31', NOON);
  assert.equal(accountValueOn(state, 'acc_loan', '2026-04-01', NOON), -1000000);
  const principal = -1000000 - before;
  assert.ok(principal > 23000 && principal < 24500, 'about $62 of the $300 is interest: ' + principal);
  const [day] = closes(state, '2026-04-01', '2026-04-01', NOON);
  assert.ok(day.bills < 30000 - principal + 300, 'the principal is not a bill: ' + day.bills);
  assert.equal(day.other, 0);
});
