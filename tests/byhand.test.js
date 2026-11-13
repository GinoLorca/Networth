/**
 * Payments the owner sends themselves: the entry, the rows the bank shows for it, the checklist, and
 * what detection, the Book and the clock make of it. Every payment, payee and amount here is invented.
 * Bank rows are given as the bank's text and run through the real classifier (refresh).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDoc, defaultState, makeAccount, makeRecurring, makeTx, migrate } from '../js/model/schema.js';
import { occurrences, bookTotals, upcoming, byHandStandingOf, entryLapsed, runsByHand } from '../js/model/book.js';
import { refresh } from '../js/model/detect.js';
import { clock, closes } from '../js/model/ledger.js';
import {
  addByHand, byHandMonth, claimByHand, editByHand, makeByHand, payeeKey, removeByHand, restampByHand, skipRow, tickByHand,
} from '../js/model/byhand.js';

/* ------------------------------------------------------------------ fixtures */

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const CHECKING = 'acc_checking';
const CARD = 'acc_card';
const SAVINGS = 'acc_savings';

function at(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour).getTime();
}

/** Tuesday 10 November 2026, noon. */
const NOW = at(2026, 11, 10);
const TODAY = '2026-11-10';
const ZELLE = 'Zelle payment to R Lindqvist';
const ZELLE_KEY = payeeKey('zelle to r lindqvist');
const TRANSFER = 'Online transfer to Harbor Parking';

let sequence = 0;

function newState(nowMs = NOW) {
  const state = defaultState(nowMs);
  const reported = { source: 'bank', basis: 'bank', asOf: nowMs - HOUR_MS };
  state.accounts.push(
    makeAccount({ id: CHECKING, type: 'checking', name: 'Everyday Checking', balance: 412300, ...reported }),
    makeAccount({ id: CARD, type: 'credit_card', name: 'Rewards Card', balance: -186400, ...reported }),
    makeAccount({ id: SAVINGS, type: 'savings', name: 'Rainy Day Savings', balance: 90000, ...reported }),
  );
  return state;
}

/** Money leaving an account, as the bank words it; the classifier decides what it is. */
function sent(state, day, amount, raw, extra = {}) {
  sequence += 1;
  const tx = makeTx({ id: 'tx_' + sequence, accountId: CHECKING, day, postedDay: day, amount, flow: 'out', raw, ...extra });
  state.txs.push(tx);
  return tx;
}

/** Pay every other Friday, so that day-by-day counting is on. */
function withPay(state) {
  for (let day = '2026-07-03'; day <= TODAY; day = shift(day, 14)) {
    sequence += 1;
    state.txs.push(makeTx({ id: 'tx_' + sequence, accountId: CHECKING, day, postedDay: day, amount: 180000, flow: 'in', raw: 'Northwind Payroll direct dep' }));
  }
  return state;
}

function shift(day, n) {
  const d = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Three months of the same Zelle, the last one this month. */
function zelleHistory(state) {
  return [sent(state, '2026-09-04', 25000, ZELLE), sent(state, '2026-10-05', 25000, ZELLE), sent(state, '2026-11-04', 25000, ZELLE)];
}

function linksOf(state) {
  return state.txs.filter((tx) => tx.recurringId != null).map((tx) => tx.id + '>' + tx.recurringId).sort();
}

function byHandOf(state) {
  return state.recurring.filter((entry) => entry.byHand);
}

function rowOf(month, name) {
  return month.rows.find((row) => row.entry.name === name);
}

/* --------------------------------------------------------------- the entry */

test('payeeKey: p and 13 hex digits, the same every time, empty for an empty key', () => {
  assert.match(payeeKey('zelle to r lindqvist'), /^p[0-9a-f]{13}$/);
  assert.equal(payeeKey('zelle to r lindqvist'), payeeKey('zelle to r lindqvist'));
  assert.notEqual(payeeKey('zelle to r lindqvist'), payeeKey('zelle to r lindqvisu'));
  assert.equal(payeeKey(''), '');
  assert.equal(payeeKey(null), '');
  assert.equal(payeeKey('zelle to r lindqvist').includes('lindqvist'), false);
});

test('addByHand: the fixed fields, since on the first day of the month, the anchor on its day', () => {
  const state = newState();
  const entry = addByHand(state, { name: '  Flat share ', amount: 25000, dueDay: 5 }, TODAY, NOW);
  assert.equal(state.recurring.length, 1);
  assert.equal(entry.name, 'Flat share');
  assert.deepEqual(
    [entry.source, entry.byHand, entry.cadence, entry.mkey, entry.accountId, entry.variable, entry.category, entry.purpose, entry.essential, entry.active],
    ['manual', true, 'monthly', '', null, false, 'other', 'personal', true, true],
  );
  assert.equal(entry.since, '2026-11-01'); // its day has passed, and this month's payment is still on the list
  assert.equal(entry.anchor, '2026-11-05');
  assert.equal(entry.dueDay, 5);
  assert.deepEqual(entry.locks, ['name', 'amount', 'cadence', 'anchor']);
  assert.deepEqual([entry.payee, entry.payeeAt, entry.marks, entry.skips, entry.editedAt], [null, 0, {}, {}, NOW]);
  assert.equal(checkDoc(state), null);
});

test('addByHand refuses a name, an amount or a day that is not acceptable', () => {
  const state = newState();
  const bad = [
    { name: '', amount: 25000, dueDay: 5 }, { name: '   ', amount: 25000, dueDay: 5 }, { name: 'x'.repeat(61), amount: 25000, dueDay: 5 },
    { name: 'Flat share', amount: 0, dueDay: 5 }, { name: 'Flat share', amount: 250.5, dueDay: 5 }, { name: 'Flat share', amount: 1e10 + 1, dueDay: 5 },
    { name: 'Flat share', amount: 25000, dueDay: 0 }, { name: 'Flat share', amount: 25000, dueDay: 32 }, { name: 'Flat share', amount: 25000, dueDay: 5.5 },
    { name: 7, amount: 25000, dueDay: 5 }, null, undefined, 'Flat share',
  ];
  for (const fields of bad) assert.equal(addByHand(state, fields, TODAY, NOW), null);
  assert.equal(addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, 'yesterday', NOW), null);
  assert.equal(state.recurring.length, 0);
  assert.ok(addByHand(state, { name: 'x'.repeat(60), amount: 1, dueDay: 31 }, TODAY, NOW));
});

test('the last day: 31 falls on the 30th of a 30-day month and on the last of February', () => {
  const state = newState();
  const entry = addByHand(state, { name: 'Parking', amount: 8500, dueDay: 31 }, TODAY, NOW);
  assert.equal(entry.anchor, '2026-11-30');
  assert.deepEqual(occurrences(entry, '2026-10-01', '2027-03-31'), ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']);
  const leap = makeByHand({ name: 'Parking', amount: 8500, dueDay: 30, since: '2028-02-01' });
  assert.equal(leap.anchor, '2028-02-29');
  assert.deepEqual(occurrences(leap, '2028-01-01', '2028-04-30'), ['2028-02-29', '2028-03-30', '2028-04-30']);
});

test('makeByHand keeps the id, the stamps, the payee, the marks and the skips it is given', () => {
  const entry = makeByHand({
    id: 'rec_shared01', name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01', active: false, editedAt: 7,
    payee: ZELLE_KEY, payeeAt: 9, marks: { '2026-11-05': { paid: true, at: 11 } }, skips: { ['2026-11-04|' + ZELLE_KEY]: { on: false, at: 12 } },
  });
  assert.deepEqual([entry.id, entry.active, entry.editedAt, entry.payee, entry.payeeAt], ['rec_shared01', false, 7, ZELLE_KEY, 9]);
  assert.deepEqual(entry.marks, { '2026-11-05': { paid: true, at: 11 } });
  assert.deepEqual(entry.skips, { ['2026-11-04|' + ZELLE_KEY]: { on: false, at: 12 } });
  assert.equal(entry.anchor, '2026-11-05');
});

test('editByHand: the name alone changes nothing else; a bad field changes nothing', () => {
  const state = newState();
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  assert.equal(editByHand(state, entry.id, { name: 'Flat, shared' }, TODAY, NOW + 5), true);
  assert.deepEqual([entry.name, entry.since, entry.anchor, entry.editedAt], ['Flat, shared', '2026-11-01', '2026-11-05', NOW + 5]);
  assert.equal(editByHand(state, entry.id, { amount: -1 }, TODAY, NOW + 6), false);
  assert.equal(editByHand(state, entry.id, { dueDay: 40 }, TODAY, NOW + 6), false);
  assert.equal(editByHand(state, entry.id, { name: 'Flat, shared' }, TODAY, NOW + 6), false); // no change
  assert.equal(editByHand(state, 'rec_nobody', { name: 'x' }, TODAY, NOW + 6), false);
  assert.equal(entry.editedAt, NOW + 5);
});

test('editByHand: a new amount or day starts the schedule this month when unpaid, next month when paid', () => {
  const state = newState();
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  assert.equal(editByHand(state, entry.id, { dueDay: 20 }, TODAY, NOW + 1), true);
  assert.deepEqual([entry.since, entry.anchor, entry.dueDay], ['2026-11-01', '2026-11-20', 20]);
  assert.equal(tickByHand(state, entry.id, '2026-11-20', true, NOW + 2), true);
  assert.equal(editByHand(state, entry.id, { amount: 27500 }, TODAY, NOW + 3), true);
  assert.deepEqual([entry.since, entry.anchor, entry.amount], ['2026-12-01', '2026-12-20', 27500]);
  // and once more in the same month: nothing is left to pay this month, so it stays next month's
  assert.equal(editByHand(state, entry.id, { dueDay: 31 }, TODAY, NOW + 4), true);
  assert.deepEqual([entry.since, entry.anchor], ['2026-12-01', '2026-12-31']);
});

test('editByHand: switching off and on again starts it from the first day of this month', () => {
  const state = newState();
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, '2026-08-20', NOW - 80 * DAY_MS);
  assert.equal(entry.since, '2026-08-01');
  assert.equal(editByHand(state, entry.id, { active: false }, TODAY, NOW), true);
  assert.equal(byHandMonth(state, TODAY, NOW).rows.length, 0);
  assert.equal(clock(state, NOW).due.length, 0);
  assert.equal(editByHand(state, entry.id, { active: true }, TODAY, NOW + 1), true);
  assert.deepEqual([entry.active, entry.since, entry.anchor], [true, '2026-11-01', '2026-11-05']);
});

test('removeByHand removes the entry and records the removal', () => {
  const state = newState();
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  assert.equal(removeByHand(state, 'rec_nobody', NOW), false);
  assert.equal(removeByHand(state, entry.id, NOW + 9), true);
  assert.equal(state.recurring.length, 0);
  assert.deepEqual(state.share.tombs, { [entry.id]: NOW + 9 });
  assert.equal(checkDoc(state), null);
});

test('a tick and an untick: only on an occurrence, and the untick is kept', () => {
  const state = newState();
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 15 }, TODAY, NOW);
  assert.equal(tickByHand(state, entry.id, '2026-11-14', true, NOW), false);
  assert.equal(tickByHand(state, entry.id, '2026-10-15', true, NOW), false); // before it began
  assert.equal(tickByHand(state, entry.id, '2026-11-15', 'yes', NOW), false);
  assert.equal(tickByHand(state, entry.id, '2026-11-15', true, NOW), true);
  let month = byHandMonth(state, TODAY, NOW + HOUR_MS);
  assert.deepEqual([month.rows[0].status, month.rows[0].paidDay, month.paid, month.count, month.unpaid, month.transit], ['hand', TODAY, 1, 1, 0, 25000]);
  assert.equal(byHandMonth(state, '2026-11-15', NOW + 5 * DAY_MS).transit, 0); // four days on, the bank's balance no longer holds it
  assert.equal(tickByHand(state, entry.id, '2026-11-15', false, NOW + 2), true);
  assert.deepEqual(entry.marks, { '2026-11-15': { paid: false, at: NOW + 2 } });
  month = byHandMonth(state, TODAY, NOW + HOUR_MS);
  assert.deepEqual([month.rows[0].status, month.rows[0].daysTo, month.paid, month.unpaid, month.transit], ['due', 5, 0, 25000, 0]);
});

/* ------------------------------------------------- which rows pay an entry */

test('two months of Zelle to one payee: learned at once, every row linked, history settling nothing', () => {
  const state = newState();
  const rows = zelleHistory(state);
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(entry.payee, ZELLE_KEY);
  assert.equal(entry.payeeAt, NOW);
  for (const row of rows) assert.deepEqual([row.recurringId, row.klass, row.review], [entry.id, 'book', false]);
  // the rows of September and October are before `since`: they are its history and settle nothing
  assert.deepEqual(byHandStandingOf(state, entry, '2026-11-30').map((item) => [item.day, item.row && item.row.day]), [['2026-11-05', '2026-11-04']]);
  const month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual(
    [month.ym, month.rows.length, month.rows[0].status, month.rows[0].paidDay, month.rows[0].txId, month.rows[0].merchant, month.rows[0].amount],
    ['2026-11', 1, 'bank', '2026-11-04', rows[2].id, 'Zelle To R Lindqvist', 25000],
  );
  assert.deepEqual([month.paid, month.count, month.unpaid, month.transit], [1, 1, 0, 0]);
  assert.equal(JSON.stringify(state.recurring).includes('lindqvist'), false); // the payee is kept as a fingerprint only
});

test('only the exact amount; only cash accounts; never a move between own accounts; a pending row is linked, and settles only while pending rows count', () => {
  const state = newState();
  sent(state, '2026-09-04', 25000, ZELLE);
  sent(state, '2026-10-05', 25000, ZELLE);
  const other = sent(state, '2026-11-03', 24900, ZELLE);                                   // another amount
  const paired = sent(state, '2026-11-03', 25000, ZELLE, { pairId: 'tx_other_leg' });      // a move between the owner's accounts
  const onCard = sent(state, '2026-11-03', 25000, ZELLE, { accountId: CARD });             // not a cash account
  const waiting = sent(state, '2026-11-09', 25000, ZELLE, { pending: true, postedDay: null });
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  state.settings.countPending = false;
  refresh(state, NOW);
  assert.equal(entry.payee, ZELLE_KEY);
  for (const row of [other, paired, onCard]) assert.notEqual(row.recurringId, entry.id);
  assert.equal(waiting.recurringId, entry.id); // linked like a posted row
  // pending rows do not count: it settles nothing and is only reported; the row of another amount is reported too
  let month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual(
    [month.rows[0].status, month.rows[0].daysTo, month.rows[0].pendingDay, month.rows[0].pendingTxId, month.unpaid, month.paid],
    ['overdue', -5, '2026-11-09', waiting.id, 25000, 0],
  );
  assert.deepEqual([month.rows[0].otherDay, month.rows[0].otherTxId, month.rows[0].otherAmount], ['2026-11-03', other.id, 24900]);
  assert.equal(clock(state, NOW).due.some((item) => item.id === entry.id && item.overdue), true);
  // pending rows count: the ledger has taken the money off cash, and the payment no longer stands as still to send
  const cashBefore = clock(state, NOW).cash;
  state.settings.countPending = true;
  refresh(state, NOW);
  month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual(
    [month.rows[0].status, month.rows[0].paidDay, month.rows[0].txId, month.rows[0].pendingDay, month.unpaid, month.paid],
    ['pending', '2026-11-09', waiting.id, null, 0, 1],
  );
  assert.equal(clock(state, NOW).cash, cashBefore - 25000);
  assert.equal(clock(state, NOW).due.some((item) => item.id === entry.id), false);
  assert.equal(upcoming(state, TODAY, 20).some((row) => row.id === entry.id && row.day === '2026-11-05'), false);
  // the pending row vanishes: unpaid again at the next refresh
  state.txs.splice(state.txs.indexOf(waiting), 1);
  refresh(state, NOW);
  assert.equal(byHandMonth(state, TODAY, NOW).rows[0].status, 'overdue');
  state.txs.push(waiting);
  refresh(state, NOW);
  // the day it posts, it settles
  waiting.pending = false;
  refresh(state, NOW);
  assert.equal(waiting.recurringId, entry.id);
  assert.deepEqual([byHandMonth(state, TODAY, NOW).rows[0].status, byHandMonth(state, TODAY, NOW).rows[0].pendingDay], ['bank', null]);
});

test('two payees of the same amount: the one paid near the entry\'s day is its payee', () => {
  const state = newState();
  sent(state, '2026-08-04', 25000, ZELLE);
  sent(state, '2026-09-04', 25000, ZELLE);
  const others = [sent(state, '2026-08-20', 25000, 'Zelle payment to T Okafor'), sent(state, '2026-09-20', 25000, 'Zelle payment to T Okafor')];
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(entry.payee, ZELLE_KEY);
  for (const row of others) assert.notEqual(row.recurringId, entry.id);
  // the other payee keeps its detected line, and the line of this payment has given way: counted once
  assert.deepEqual(state.recurring.filter((line) => line.source === 'detected').map((line) => line.mkey), ['zelle to t okafor']);
});

test('two payees of the same amount, both paid near the entry\'s day: ambiguous, nothing is learned from the past', () => {
  const state = newState();
  sent(state, '2026-08-04', 25000, ZELLE);
  sent(state, '2026-09-04', 25000, ZELLE);
  sent(state, '2026-08-08', 25000, 'Zelle payment to T Okafor');
  sent(state, '2026-09-08', 25000, 'Zelle payment to T Okafor');
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(entry.payee, null);
  assert.equal(state.txs.some((tx) => tx.recurringId === entry.id), false);
  assert.equal(byHandMonth(state, TODAY, NOW).rows[0].status, 'overdue');
});

test('a card purchase or an ATM withdrawal of the same amount is never learned', () => {
  const state = newState();
  for (const day of ['2026-09-03', '2026-10-03', '2026-11-03']) {
    sent(state, day, 25000, 'ATM withdrawal 0042 Main St');
    sent(state, day, 25000, 'Corner Hardware', { accountId: CARD });
    sent(state, day, 25000, 'Corner Hardware debit purchase');
  }
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(entry.payee, null);
  assert.equal(state.txs.some((tx) => tx.recurringId === entry.id), false);
});

test('learned from this month\'s row, and a transfer row is linked and counted as a Book charge', () => {
  const state = withPay(newState());
  const row = sent(state, '2026-10-30', 8500, TRANSFER);
  refresh(state, NOW);
  assert.deepEqual([row.kind, row.recurringId], ['transfer', null]);
  const before = closes(state, '2026-10-25', TODAY, NOW);
  // added in October, for the last day of the month
  const entry = makeByHand({ name: 'Parking', amount: 8500, dueDay: 31, since: '2026-10-01', editedAt: NOW });
  state.recurring.push(entry);
  refresh(state, NOW);
  assert.equal(entry.payee, payeeKey(row.mkey));
  assert.deepEqual([row.recurringId, row.klass, row.review], [entry.id, 'book', false]);
  const month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual(month.rows.map((item) => [item.day, item.status]), [['2026-11-30', 'due']]); // October is paid: it is not in arrears
  assert.equal(byHandStandingOf(state, entry, TODAY)[0].row.id, row.id);
  // the money had left; it now has a name: the transfer is a Book charge on its day
  const after = closes(state, '2026-10-25', TODAY, NOW);
  const day = (list) => list.find((close) => close.day === '2026-10-30');
  assert.notDeepEqual(day(after), day(before));
  assert.equal(day(after).bank, day(before).bank); // what the bank holds is what it was
});

test('two entries of one amount each take the row nearest its own day', () => {
  const state = newState();
  const early = sent(state, '2026-11-04', 25000, ZELLE);
  const late = sent(state, '2026-11-09', 25000, 'Zelle payment to T Okafor');
  const first = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  const second = addByHand(state, { name: 'Studio share', amount: 25000, dueDay: 10 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(first.payee, payeeKey(early.mkey));
  assert.equal(second.payee, payeeKey(late.mkey));
  assert.deepEqual([early.recurringId, late.recurringId], [first.id, second.id]);
});

test('two entries that want one row: the nearer day takes it and the other learns nothing', () => {
  const state = newState();
  const row = sent(state, '2026-11-09', 25000, ZELLE);
  const far = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  const near = addByHand(state, { name: 'Studio share', amount: 25000, dueDay: 10 }, TODAY, NOW);
  refresh(state, NOW);
  assert.deepEqual([near.payee, far.payee, row.recurringId], [payeeKey(row.mkey), null, near.id]);
});

test('a skipped row is never taken again, and its payee never learned again', () => {
  const state = newState();
  const row = sent(state, '2026-11-04', 25000, ZELLE);
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(row.recurringId, entry.id);
  assert.equal(skipRow(state, entry.id, row.id, NOW + 1), true);
  assert.deepEqual(entry.skips, { ['2026-11-04|' + ZELLE_KEY]: { on: true, at: NOW + 1 } });
  assert.deepEqual([entry.payee, entry.payeeAt], [null, NOW + 1]);
  refresh(state, NOW + 2);
  assert.deepEqual([row.recurringId, entry.payee], [null, null]);
  // the same payee again next week: barred
  const again = sent(state, '2026-11-09', 25000, ZELLE);
  refresh(state, NOW + 3);
  assert.deepEqual([again.recurringId, entry.payee], [null, null]);
  assert.equal(byHandMonth(state, TODAY, NOW + 3).rows[0].status, 'overdue');
  assert.equal(skipRow(state, entry.id, 'tx_nobody', NOW), false);
});

test('a skip keeps the payee while another of its rows stays with the entry', () => {
  const state = newState();
  const rows = zelleHistory(state);
  const extra = sent(state, '2026-11-08', 25000, ZELLE);
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(extra.recurringId, entry.id);
  assert.equal(skipRow(state, entry.id, extra.id, NOW + 1), true);
  assert.equal(entry.payee, ZELLE_KEY);
  refresh(state, NOW + 2);
  assert.deepEqual([extra.recurringId, rows[2].recurringId], [null, entry.id]);
});

test('the same rows in another order, under other ids, reach the same links', () => {
  const build = (order, prefix) => {
    const state = newState();
    const rows = [
      ['2026-09-04', 25000, ZELLE], ['2026-10-05', 25000, ZELLE], ['2026-11-04', 25000, ZELLE],
      ['2026-11-09', 25000, 'Zelle payment to T Okafor'], ['2026-10-30', 8500, TRANSFER], ['2026-09-30', 8500, TRANSFER],
      ['2026-11-03', 6000, 'Zelle payment to R Lindqvist'],
    ];
    for (const i of order) state.txs.push(makeTx({ id: prefix + i, accountId: CHECKING, day: rows[i][0], postedDay: rows[i][0], amount: rows[i][1], flow: 'out', raw: rows[i][2] }));
    for (const [id, name, amount, dueDay] of [['rec_a', 'Flat share', 25000, 5], ['rec_b', 'Studio share', 25000, 10], ['rec_c', 'Parking', 8500, 31]]) {
      state.recurring.push(makeByHand({ id, name, amount, dueDay, since: '2026-11-01' }));
    }
    refresh(state, NOW);
    refresh(state, NOW);
    const links = state.txs.map((tx) => [tx.day, tx.amount, tx.raw, tx.recurringId]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    return { links, payees: byHandOf(state).map((entry) => [entry.id, entry.payee]).sort() };
  };
  const one = build([0, 1, 2, 3, 4, 5, 6], 'tx_m');
  const two = build([6, 3, 5, 0, 4, 2, 1], 'tx_p');
  assert.deepEqual(two, one);
  assert.equal(one.links.filter((link) => link[3] === 'rec_a').length, 3);
  assert.equal(one.links.filter((link) => link[3] === 'rec_b').length, 1);
  assert.equal(one.links.filter((link) => link[3] === 'rec_c').length, 2);
});

/* ------------------------------------------------------- detection gives way */

test('a detected line of the same payment gives way: the Book counts it once, and no figure of a day moves', () => {
  const state = withPay(newState());
  const rows = zelleHistory(state);
  refresh(state, NOW);
  const detected = state.recurring.find((entry) => entry.mkey === 'zelle to r lindqvist');
  assert.deepEqual([detected.source, detected.amount, detected.active], ['detected', 25000, true]);
  const totals = bookTotals(state);
  const figures = closes(state, '2026-09-04', TODAY, NOW);

  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(state.recurring.includes(detected), false);
  assert.equal(state.recurring.some((line) => line.mkey === 'zelle to r lindqvist'), false);
  for (const row of rows) assert.equal(row.recurringId, entry.id);
  assert.deepEqual([bookTotals(state).count, bookTotals(state).perMonth, bookTotals(state).perYear], [totals.count, totals.perMonth, totals.perYear]);
  // every day after the first charge on record: every figure as it was. The day of that first charge
  // stands where it stood (bank and running total); only what the day itself is charged differs, by what
  // the detected line had counted day by day before it (a payment the owner sends counts nothing before
  // its first charge).
  const after = closes(state, '2026-09-04', TODAY, NOW);
  assert.deepEqual(after.slice(1), figures.slice(1));
  assert.deepEqual([after[0].day, after[0].bank, after[0].smooth], [figures[0].day, figures[0].bank, figures[0].smooth]);
  assert.equal(after.length > 60, true);

  // five refreshes in a row: the same links, the same lines
  const links = linksOf(state);
  const lines = state.recurring.map((line) => line.id);
  for (let i = 1; i <= 5; i++) {
    refresh(state, NOW + i);
    assert.deepEqual(linksOf(state), links);
    assert.deepEqual(state.recurring.map((line) => line.id), lines);
  }
  assert.deepEqual(closes(state, '2026-09-05', TODAY, NOW), figures.slice(1));
});

test('a detected line of another amount to the same payee stays', () => {
  const state = newState();
  zelleHistory(state);
  const small = [sent(state, '2026-09-18', 6000, ZELLE), sent(state, '2026-10-18', 6000, ZELLE)];
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  for (let i = 0; i < 3; i++) refresh(state, NOW + i);
  const line = state.recurring.find((one) => one.source === 'detected' && one.mkey === 'zelle to r lindqvist');
  assert.equal(line.amount, 6000);
  for (const row of small) assert.equal(row.recurringId, line.id);
  assert.equal(state.txs.filter((tx) => tx.recurringId === entry.id).length, 3);
  const ids = state.recurring.map((one) => one.id);
  refresh(state, NOW + 9);
  assert.deepEqual(state.recurring.map((one) => one.id), ids);
});

test('removing or switching off the entry lets detection find the line again', () => {
  const state = newState();
  const rows = zelleHistory(state);
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(state.recurring.length, 1);
  editByHand(state, entry.id, { active: false }, TODAY, NOW + 1);
  refresh(state, NOW + 1);
  let line = state.recurring.find((one) => one.source === 'detected');
  assert.equal(line.amount, 25000);
  for (const row of rows) assert.equal(row.recurringId, line.id);
  editByHand(state, entry.id, { active: true }, TODAY, NOW + 2);
  refresh(state, NOW + 2);
  assert.equal(state.recurring.some((one) => one.source === 'detected'), false);
  for (const row of rows) assert.equal(row.recurringId, entry.id);
  removeByHand(state, entry.id, NOW + 3);
  refresh(state, NOW + 3);
  line = state.recurring.find((one) => one.source === 'detected');
  assert.deepEqual([state.recurring.length, line.amount], [1, 25000]);
  for (const row of rows) assert.equal(row.recurringId, line.id);
});

/* ------------------------------------------------- the clock and the Book */

test('unpaid, ticked, paid at the bank: the clock, the Book and the checklist agree', () => {
  const state = withPay(newState());
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  const parking = addByHand(state, { name: 'Parking', amount: 8500, dueDay: 31 }, TODAY, NOW);
  refresh(state, NOW);
  assert.deepEqual([bookTotals(state).count, bookTotals(state).perMonth], [2, 33500]);
  assert.equal(entryLapsed(entry, null, '2027-06-01'), false);

  // unpaid: overdue since the 5th, and taken off what is liquid
  let now = clock(state, NOW);
  const mine = (list) => list.filter((item) => item.id === entry.id);
  assert.deepEqual(mine(now.due), [{ id: entry.id, name: 'Flat share', day: '2026-11-05', amount: 25000, overdue: true, byHand: true }]);
  assert.ok(now.dueTotal >= 25000);
  const dueBefore = now.dueTotal;
  assert.deepEqual(upcoming(state, TODAY, 30).map((row) => [row.name, row.day]), [['Parking', '2026-11-30'], ['Flat share', '2026-12-05']]);
  let month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual(month.rows.map((row) => [row.entry.name, row.day, row.status, row.daysTo]), [['Flat share', '2026-11-05', 'overdue', -5], ['Parking', '2026-11-30', 'due', 20]]);
  assert.deepEqual([month.paid, month.count, month.unpaid, month.transit], [0, 2, 33500, 0]);

  // ticked: not due, not overdue; the money is on its way
  tickByHand(state, entry.id, '2026-11-05', true, NOW);
  now = clock(state, NOW);
  assert.deepEqual(mine(now.due), []);
  assert.equal(now.dueTotal, dueBefore - 25000);
  month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual([rowOf(month, 'Flat share').status, month.paid, month.unpaid, month.transit], ['hand', 1, 8500, 25000]);

  // unticked: owed again
  tickByHand(state, entry.id, '2026-11-05', false, NOW + 1);
  assert.equal(mine(clock(state, NOW).due).length, 1);

  // paid at the bank: settled without a tick
  sent(state, '2026-11-09', 25000, ZELLE);
  refresh(state, NOW);
  assert.deepEqual(mine(clock(state, NOW).due), []);
  month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual([rowOf(month, 'Flat share').status, rowOf(month, 'Flat share').paidDay, month.paid, month.unpaid, month.transit], ['bank', '2026-11-09', 1, 8500, 0]);
  assert.equal(parking.payee, null);
});

test('every unpaid month stays due, the newest twelve of them, and never lapses', () => {
  const state = newState();
  const entry = makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2025-06-01' });
  state.recurring.push(entry);
  refresh(state, NOW);
  const due = clock(state, NOW).due.filter((item) => item.id === entry.id && item.overdue);
  assert.equal(due.length, 13); // twelve earlier months and this month's
  assert.deepEqual([due[0].day, due[12].day], ['2025-11-05', '2026-11-05']);
  const month = byHandMonth(state, TODAY, NOW);
  assert.deepEqual(month.rows.map((row) => row.day), due.map((item) => item.day));
  assert.deepEqual([month.count, month.unpaid], [1, 13 * 25000]);
  assert.equal(clock(state, NOW).shortfall, Math.max(0, clock(state, NOW).dueTotal - clock(state, NOW).cash));
});

test('with day-by-day counting on, a tick moves no figure; four days on with no row the accrual starts again, from that day', () => {
  const state = withPay(newState());
  const entry = makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-10-01' });
  state.recurring.push(entry);
  refresh(state, NOW);
  const owed = closes(state, TODAY, TODAY, NOW)[0];
  tickByHand(state, entry.id, '2026-11-05', true, NOW);
  // the bank still holds the money: nothing of the day moves, and the payment is settled all the same
  assert.deepEqual(closes(state, TODAY, TODAY, NOW)[0], owed);
  assert.equal(clock(state, NOW).due.some((item) => item.id === entry.id && item.day === '2026-11-05'), false);
  // four days later no row has come: paid outside the linked accounts; it counts again from Nov 14, and
  // no day before it is rewritten
  const later = NOW + 5 * DAY_MS;
  const after = closes(state, '2026-11-01', '2026-11-15', later);
  tickByHand(state, entry.id, '2026-11-05', false, NOW + 1);
  const unticked = closes(state, '2026-11-01', '2026-11-15', later);
  assert.deepEqual(after.slice(0, 13), unticked.slice(0, 13));
  assert.ok(after[14].smooth - unticked[14].smooth > 20000, 'the accrual starts over on the fourth day after the tick');
  assert.deepEqual(after.map((day) => day.bank), unticked.map((day) => day.bank)); // a tick moves no money
  assert.deepEqual(closes(state, TODAY, TODAY, NOW)[0], owed);
});

test('the last day of a month, ticked on the first of the next: off the list, and still counted as on its way', () => {
  const state = newState(at(2026, 12, 1));
  const entry = makeByHand({ name: 'Parking', amount: 8500, dueDay: 31, since: '2026-11-01' });
  state.recurring.push(entry);
  const now = at(2026, 12, 1);
  let month = byHandMonth(state, '2026-12-01', now);
  assert.deepEqual(month.rows.map((row) => [row.day, row.status, row.daysTo]), [['2026-11-30', 'overdue', -1], ['2026-12-31', 'due', 30]]);
  assert.deepEqual([month.paid, month.count, month.unpaid, month.transit], [0, 1, 17000, 0]);
  tickByHand(state, entry.id, '2026-11-30', true, now);
  month = byHandMonth(state, '2026-12-01', now + HOUR_MS);
  assert.deepEqual(month.rows.map((row) => [row.day, row.status]), [['2026-12-31', 'due']]);
  assert.deepEqual([month.paid, month.count, month.unpaid, month.transit], [0, 1, 8500, 8500]);
  assert.equal(byHandMonth(state, '2026-12-06', now + 5 * DAY_MS).transit, 0);
  // the bank shows it: nothing is on its way any more
  sent(state, '2026-12-01', 8500, TRANSFER);
  refresh(state, now + HOUR_MS);
  assert.equal(byHandMonth(state, '2026-12-01', now + HOUR_MS).transit, 0);
});

test('a change of the amount after this month was paid at the bank applies from next month, and the row stays this month\'s', () => {
  const state = newState();
  const rows = zelleHistory(state);
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(editByHand(state, entry.id, { amount: 27500 }, TODAY, NOW + 1), true);
  assert.deepEqual([entry.since, entry.anchor, entry.amount], ['2026-12-01', '2026-12-05', 27500]);
  refresh(state, NOW + 2);
  for (const row of rows) assert.equal(row.recurringId, entry.id); // already its rows: they stay, at the old amount
  const month = byHandMonth(state, TODAY, NOW + 2);
  assert.deepEqual(month.rows, []); // nothing left to send this month
  assert.deepEqual(byHandMonth(state, '2026-12-02', NOW + 22 * DAY_MS).rows.map((row) => [row.day, row.status, row.amount]), [['2026-12-05', 'due', 27500]]);
  // December's payment at the new amount is taken
  const next = sent(state, '2026-12-04', 27500, ZELLE);
  refresh(state, NOW + 25 * DAY_MS);
  assert.equal(next.recurringId, entry.id);
});

test('a skip taken back: the row is the payment\'s again', () => {
  const state = newState();
  const rows = zelleHistory(state);
  const extra = sent(state, '2026-11-08', 25000, ZELLE);
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  skipRow(state, entry.id, extra.id, NOW + 1);
  refresh(state, NOW + 2);
  assert.equal(extra.recurringId, null);
  entry.skips['2026-11-08|' + ZELLE_KEY] = { on: false, at: NOW + 3 }; // as an Undo made the newest, or another device, leaves it
  refresh(state, NOW + 4);
  assert.deepEqual([extra.recurringId, rows[2].recurringId], [entry.id, entry.id]);
});

/* ---------------------------------------------------------------- after Undo */

function pair() {
  const before = newState();
  const entry = addByHand(before, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  return { before, entry, copy: () => JSON.parse(JSON.stringify(before)) };
}

test('restampByHand: nothing by hand differs, nothing is written', () => {
  const { before, copy } = pair();
  const after = copy();
  after.settings.rolloverHour = 3;
  const text = JSON.stringify(after);
  assert.equal(restampByHand(before, after, NOW + 50), false);
  assert.equal(JSON.stringify(after), text);
  assert.equal(restampByHand(null, null, NOW), false);
});

test('restampByHand: an undone add leaves a tomb; an undone removal lifts it', () => {
  const { before, entry, copy } = pair();
  const without = copy();
  without.recurring = [];
  assert.equal(restampByHand(before, without, NOW + 50), true); // Undo of the add
  assert.deepEqual(without.share.tombs, { [entry.id]: NOW + 50 });
  const removed = copy();
  removeByHand(removed, entry.id, NOW + 10);
  const back = copy(); // Undo of the removal puts the entry back
  back.share.tombs[entry.id] = NOW + 10;
  assert.equal(restampByHand(removed, back, NOW + 60), true);
  assert.deepEqual([back.recurring[0].editedAt, back.share.tombs], [NOW + 60, {}]);
});

test('restampByHand: an undone edit, tick, untick, skip and payee are made the newest', () => {
  const { before, entry, copy } = pair();
  const after = copy(); // the document as Undo puts it back
  editByHand(before, entry.id, { name: 'Flat, shared', dueDay: 7 }, TODAY, NOW + 1);
  tickByHand(before, entry.id, '2026-11-07', true, NOW + 2);
  before.recurring[0].skips['2026-11-04|' + ZELLE_KEY] = { on: true, at: NOW + 3 };
  before.recurring[0].payee = ZELLE_KEY;
  before.recurring[0].payeeAt = NOW + 4;
  after.recurring[0].marks['2026-11-05'] = { paid: true, at: NOW - 5 }; // a tick `before` no longer has
  assert.equal(restampByHand(before, after, NOW + 90), true);
  const put = after.recurring[0];
  assert.deepEqual([put.name, put.dueDay, put.editedAt, put.payee, put.payeeAt], ['Flat share', 5, NOW + 90, null, NOW + 90]);
  assert.deepEqual(put.marks, { '2026-11-05': { paid: true, at: NOW + 90 }, '2026-11-07': { paid: false, at: NOW + 90 } });
  assert.deepEqual(put.skips, { ['2026-11-04|' + ZELLE_KEY]: { on: false, at: NOW + 90 } });
  assert.equal(restampByHand(after, JSON.parse(JSON.stringify(after)), NOW + 99), false);
});

/* ------------------------------------------------------- records and odd input */

test('a record without the new fields is accepted, filled, and runs', () => {
  const state = newState();
  zelleHistory(state);
  refresh(state, NOW);
  delete state.share;
  for (const entry of state.recurring) for (const field of ['byHand', 'dueDay', 'payee', 'payeeAt', 'marks', 'skips', 'editedAt']) delete entry[field];
  const old = JSON.parse(JSON.stringify(state));
  assert.equal(checkDoc(old), null);
  migrate(old);
  assert.deepEqual(old.share, { tombs: {} });
  assert.deepEqual(
    ['byHand', 'dueDay', 'payee', 'payeeAt', 'marks', 'skips', 'editedAt'].map((field) => old.recurring[0][field]),
    [false, null, null, 0, {}, {}, 0],
  );
  const links = linksOf(old);
  refresh(old, NOW);
  assert.deepEqual(linksOf(old), links);
  assert.deepEqual(byHandMonth(old, TODAY, NOW), { ym: '2026-11', rows: [], paid: 0, count: 0, unpaid: 0, transit: 0 });
  assert.equal(claimByHand(old, TODAY, NOW).size, 0);
});

test('odd input never throws', () => {
  const odd = [null, undefined, 7, 'x', [], {}, { recurring: 'no', txs: 5, accounts: null }, { recurring: [null, 7, { byHand: true }, { byHand: true, id: 'rec_x', active: true, amount: 'much', marks: 4, skips: [] }], txs: [null, 3, {}] }];
  for (const state of odd) {
    assert.doesNotThrow(() => {
      claimByHand(state, TODAY, NOW);
      claimByHand(state, 'someday', NaN);
      byHandMonth(state, TODAY, NOW);
      byHandMonth(state, null, undefined);
      addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, 'someday', NOW);
      editByHand(state, 'rec_x', { name: 'x' }, TODAY, NOW);
      editByHand(state, 'rec_x', null, TODAY, NOW);
      removeByHand(state, 'rec_nobody', NOW);
      tickByHand(state, 'rec_x', '2026-11-05', true, NOW);
      skipRow(state, 'rec_x', 'tx_1', NOW);
      restampByHand(state, state, NOW);
      restampByHand({}, state, NOW);
      makeByHand(state);
    });
  }
  const state = newState();
  state.recurring.push(makeByHand({ id: 'rec_odd', name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01', marks: { nonsense: { paid: true, at: 'x' }, '2026-11-05': 7 }, skips: { nonsense: { on: true, at: 1 }, '2026-11-04|': { on: true } } }));
  state.txs.push({ id: 'tx_odd', day: 'never', amount: 'x', flow: 'out' }, makeTx({ id: 'tx_ok', accountId: 'acc_nowhere', day: TODAY, amount: 25000, raw: ZELLE }));
  assert.doesNotThrow(() => {
    refresh(state, NOW);
    clock(state, NOW);
    byHandMonth(state, TODAY, NOW);
    upcoming(state, TODAY, 40);
  });
});

/* ------------------------------------------------- the second round: what the verifiers found, as ruled */

const linkedDays = (state, id) => state.txs.filter((tx) => tx.recurringId === id).map((tx) => tx.day).sort();

test('two payments of one amount to one payee: each entry learns from the rows nearest its own day, and each is paid by its own', () => {
  const state = newState();
  for (const day of ['2026-09-05', '2026-09-20', '2026-10-05', '2026-10-20', '2026-11-05']) sent(state, day, 25000, ZELLE);
  const first = addByHand(state, { name: 'Flat share first half', amount: 25000, dueDay: 5 }, TODAY, NOW);
  const second = addByHand(state, { name: 'Flat share second half', amount: 25000, dueDay: 20 }, TODAY, NOW);
  refresh(state, NOW);
  assert.deepEqual([first.payee, second.payee], [ZELLE_KEY, ZELLE_KEY]);
  assert.deepEqual(linkedDays(state, first.id), ['2026-09-05', '2026-10-05', '2026-11-05']);
  assert.deepEqual(linkedDays(state, second.id), ['2026-09-20', '2026-10-20']);
  assert.equal(state.recurring.some((line) => line.source === 'detected' && line.mkey === 'zelle to r lindqvist'), false);
  assert.equal(bookTotals(state).perMonth, 50000);
  assert.deepEqual(byHandMonth(state, TODAY, NOW).rows.map((row) => [row.entry.name, row.status]), [['Flat share first half', 'bank'], ['Flat share second half', 'due']]);
  // the second half is sent: it is paid by its own row, not left overdue for ever
  const now = at(2026, 11, 21);
  sent(state, '2026-11-20', 25000, ZELLE);
  refresh(state, now);
  assert.deepEqual(byHandMonth(state, '2026-11-21', now).rows.map((row) => [row.entry.name, row.status, row.paidDay]),
    [['Flat share first half', 'bank', '2026-11-05'], ['Flat share second half', 'bank', '2026-11-20']]);
  assert.equal(clock(state, now).due.some((item) => item.byHand && item.overdue), false);
});

test('one payee with a history and two entries of its amount: the entry whose day the rows are near takes it, whatever the ids', () => {
  for (const ids of [['bh_a', 'bh_z'], ['bh_z', 'bh_a']]) {
    const state = newState();
    sent(state, '2026-10-05', 25000, ZELLE);
    sent(state, '2026-11-04', 25000, ZELLE);
    const flat = makeByHand({ id: ids[0], name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01' });
    const storage = makeByHand({ id: ids[1], name: 'Storage', amount: 25000, dueDay: 20, since: '2026-11-01' });
    state.recurring.push(storage, flat);
    refresh(state, NOW);
    assert.deepEqual([flat.payee, storage.payee], [ZELLE_KEY, null]);
    assert.deepEqual(byHandMonth(state, TODAY, NOW).rows.map((row) => [row.entry.name, row.status]), [['Flat share', 'bank'], ['Storage', 'due']]);
  }
});

test('history is the entry\'s whatever a device had linked: after a change of the amount two devices agree', () => {
  const build = (linkedBefore) => {
    const state = newState();
    const rows = ['2026-09-04', '2026-10-05', '2026-11-04'].map((day) => sent(state, day, 25000, ZELLE));
    if (linkedBefore) {
      const entry = makeByHand({ id: 'bh_flat', name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-09-01' });
      state.recurring.push(entry);
      refresh(state, NOW);
      assert.equal(rows.every((row) => row.recurringId === 'bh_flat'), true);
      assert.equal(editByHand(state, 'bh_flat', { amount: 27500 }, TODAY, NOW), true);
    } else {
      state.recurring.push(makeByHand({ id: 'bh_flat', name: 'Flat share', amount: 27500, dueDay: 5, since: '2026-12-01', payee: ZELLE_KEY }));
    }
    refresh(state, NOW + 1);
    return state;
  };
  const a = build(true);
  const b = build(false);
  assert.equal(a.recurring.find((line) => line.id === 'bh_flat').since, '2026-12-01');
  assert.deepEqual(linkedDays(a, 'bh_flat'), ['2026-09-04', '2026-10-05', '2026-11-04']);
  assert.deepEqual(linkedDays(b, 'bh_flat'), linkedDays(a, 'bh_flat'));
  assert.deepEqual(b.recurring.map((line) => [line.name, line.amount]), a.recurring.map((line) => [line.name, line.amount]));
  // off and on again: the same
  editByHand(a, 'bh_flat', { active: false }, TODAY, NOW + 2);
  refresh(a, NOW + 3);
  editByHand(a, 'bh_flat', { active: true }, TODAY, NOW + 4);
  refresh(a, NOW + 5);
  assert.deepEqual(a.recurring.filter((line) => line.active).map((line) => [line.name, line.amount]), [['Flat share', 27500]]);
});

test('a rise of the amount at the bank: the payment stays unpaid, the checklist reports the row, and detection makes no second line', () => {
  const now = at(2026, 12, 8);
  const state = newState(now);
  sent(state, '2026-09-04', 25000, ZELLE);
  sent(state, '2026-10-05', 25000, ZELLE);
  const risen = [sent(state, '2026-11-05', 30000, ZELLE), sent(state, '2026-12-04', 30000, ZELLE)];
  const entry = makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-09-01', payee: ZELLE_KEY });
  state.recurring.push(entry);
  for (let i = 0; i < 3; i++) refresh(state, now + i);
  assert.deepEqual(state.recurring.map((line) => line.name), ['Flat share']); // one line of the one payment
  assert.equal(bookTotals(state).perMonth, 25000);
  for (const row of risen) assert.equal(row.recurringId, null);
  assert.deepEqual(
    byHandMonth(state, '2026-12-08', now).rows.map((row) => [row.day, row.status, row.otherDay, row.otherTxId, row.otherAmount]),
    [['2026-11-05', 'overdue', '2026-11-05', risen[0].id, 30000], ['2026-12-05', 'overdue', '2026-12-04', risen[1].id, 30000]],
  );
  // the owner changes the amount: the rows are the entry's and nothing is owed
  editByHand(state, entry.id, { amount: 30000 }, '2026-12-08', now + 5);
  refresh(state, now + 6);
  const month = byHandMonth(state, '2026-12-08', now + 6);
  assert.deepEqual(month.rows.map((row) => [row.day, row.status, row.otherAmount]), [['2026-12-05', 'bank', null]]);
  assert.equal(month.unpaid, 0);
});

test('a pending row beside a posted one: it is reported on the occurrence it will settle, the same on every device', () => {
  const seen = new Set();
  for (const prefix of ['a', 'm', 'z']) {
    const state = newState();
    state.settings.countPending = false;
    sent(state, '2026-09-04', 25000, ZELLE);
    const rows = [
      sent(state, '2026-11-04', 25000, ZELLE, { id: prefix + '_posted' }),
      sent(state, '2026-11-03', 25000, ZELLE, { id: (prefix === 'm' ? 'zz' : 'aa') + '_pending', pending: true, postedDay: null }),
    ];
    if (prefix === 'z') state.txs.reverse();
    state.recurring.push(makeByHand({ id: 'bh_flat', name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-09-01', payee: ZELLE_KEY }));
    refresh(state, NOW);
    const month = byHandMonth(state, TODAY, NOW);
    // October was never sent: once the pending row posts, the two rows settle November and October
    assert.deepEqual(month.rows.map((row) => [row.day, row.status, row.paidDay, row.pendingDay, row.pendingTxId]),
      [['2026-10-05', 'overdue', null, '2026-11-03', rows[1].id], ['2026-11-05', 'bank', '2026-11-04', null, null]]);
    seen.add(JSON.stringify(month.rows.map((row) => [row.day, row.status, row.paidDay, row.pendingDay])));
  }
  assert.equal(seen.size, 1);
});

test('a pending and a posted row of one day: the posted one is taken first, whatever their ids', () => {
  for (const ids of [['tx_a', 'tx_z'], ['tx_z', 'tx_a']]) {
    const entry = makeByHand({ id: 'bh_flat', name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-10-01' });
    const state = newState();
    state.recurring.push(entry);
    state.txs.push(
      makeTx({ id: ids[0], accountId: CHECKING, day: '2026-11-04', amount: 25000, flow: 'out', recurringId: entry.id, pending: true, postedDay: null }),
      makeTx({ id: ids[1], accountId: CHECKING, day: '2026-11-04', amount: 25000, flow: 'out', recurringId: entry.id }),
    );
    assert.deepEqual(byHandStandingOf(state, entry, TODAY).map((item) => item.row && [item.row.id, item.row.pending]), [[ids[0], true], [ids[1], false]]);
  }
});

test('one test of a payment that runs: without a day, or with another cadence, it is on no list at all', () => {
  for (const change of [{ dueDay: null }, { cadence: 'weekly' }, { anchor: '' }, { amount: 0 }]) {
    const state = newState();
    const entry = makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-10-01' });
    assert.equal(runsByHand(entry), true);
    Object.assign(entry, change);
    state.recurring.push(entry);
    assert.equal(runsByHand(entry), false);
    assert.equal(clock(state, NOW).due.some((item) => item.id === entry.id), false);
    assert.equal(upcoming(state, TODAY, 60).some((row) => row.id === entry.id), false);
    assert.equal(byHandMonth(state, TODAY, NOW).rows.length, 0);
  }
  assert.equal(runsByHand(makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-10-01', active: false })), false);
});

test('clock.due: two payments the owner sends on one day are listed by name, then id, wherever they sit in the document', () => {
  const lists = [];
  for (const reversed of [false, true]) {
    const state = newState();
    const entries = [
      makeByHand({ id: 'bh_2', name: 'Parking', amount: 8500, dueDay: 15, since: '2026-11-01' }),
      makeByHand({ id: 'bh_1', name: 'Flat share', amount: 25000, dueDay: 15, since: '2026-11-01' }),
      makeByHand({ id: 'bh_0', name: 'Parking', amount: 8500, dueDay: 15, since: '2026-11-01' }),
    ];
    state.recurring.push(...(reversed ? entries.reverse() : entries));
    lists.push(clock(state, NOW).due.filter((item) => item.byHand).map((item) => [item.day, item.name, item.id]));
  }
  assert.deepEqual(lists[0], [['2026-11-15', 'Flat share', 'bh_1'], ['2026-11-15', 'Parking', 'bh_0'], ['2026-11-15', 'Parking', 'bh_2']]);
  assert.deepEqual(lists[1], lists[0]);
});

test('a tick and then the bank: a row dated before the fourth day is the payment itself; a later one rewrites no day already played', () => {
  const later = at(2026, 11, 20);
  const build = (ticked, rowDay) => {
    const state = withPay(newState());
    const entry = makeByHand({ id: 'bh_flat', name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-10-01', payee: ZELLE_KEY });
    state.recurring.push(entry);
    sent(state, '2026-10-05', 25000, ZELLE); // October was paid at the bank
    if (ticked) tickByHand(state, entry.id, '2026-11-05', true, NOW); // ticked on Nov 10: the fourth day after is Nov 14
    if (rowDay) sent(state, rowDay, 25000, ZELLE);
    refresh(state, later);
    // the bills and the result of each day (the bank's level differs by the row itself, which the balance already holds)
    return closes(state, '2026-11-01', '2026-11-20', later).map((day) => [day.day, day.bills, day.result]);
  };
  // the row is dated Nov 12, before the fourth day: the tick changes nothing at all, the accrual starts again from the row
  assert.deepEqual(build(true, '2026-11-12'), build(false, '2026-11-12'));
  // the row is dated Nov 16, after the accrual had started again on Nov 14: the days up to it stay as they were played
  assert.deepEqual(build(true, '2026-11-16').slice(0, 15), build(true, null).slice(0, 15));
  // and no tick, however late, moves a day before its own fourth day
  assert.deepEqual(build(true, null).slice(0, 13), build(false, null).slice(0, 13));
  assert.notDeepEqual(build(true, null)[13], build(false, null)[13]);
});

/* ------------------------------------------------- the third round (E8, R1 to R8) */

test('R7: the first bank row ever linked to a payment rewrites no day played before it', () => {
  const build = (rowDay) => {
    const state = withPay(newState());
    state.recurring.push(makeByHand({ id: 'bh_flat', name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-10-01' }));
    if (rowDay) sent(state, rowDay, 25000, ZELLE);
    refresh(state, NOW);
    if (rowDay) assert.equal(state.txs.filter((tx) => tx.recurringId === 'bh_flat').length, 1);
    return closes(state, '2026-09-25', '2026-11-10', NOW).map((day) => [day.day, day.bills, day.result]);
  };
  const none = build(null);
  // sent on its day: Sep 25 to Oct 4 are as they were played
  assert.deepEqual(build('2026-10-05').slice(0, 10), none.slice(0, 10));
  // October never sent, the first row dated Nov 6: every day through Nov 5 is as it was played
  assert.deepEqual(build('2026-11-06').slice(0, 42), none.slice(0, 42));
});

test('R1: the pending first row of a payment that has no payee yet is linked, settles or is reported, and teaches nothing', () => {
  for (const counted of [true, false]) {
    const state = newState();
    state.settings.countPending = counted;
    const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
    const row = sent(state, '2026-11-09', 25000, ZELLE, { pending: true });
    refresh(state, NOW);
    assert.equal(row.recurringId, entry.id);
    assert.equal(row.klass, 'book');
    assert.deepEqual([entry.payee, entry.payeeAt], [null, 0]);
    const item = byHandMonth(state, TODAY, NOW).rows[0];
    assert.deepEqual([item.status, item.pendingDay, item.txId], counted ? ['pending', null, row.id] : ['overdue', '2026-11-09', null]);
    assert.equal(clock(state, NOW).due.filter((due) => due.byHand).length, counted ? 0 : 1);
    // the pending row vanishes: nothing is left behind
    state.txs.splice(state.txs.indexOf(row), 1);
    refresh(state, NOW + 1);
    assert.equal(entry.payee, null);
    assert.deepEqual(byHandMonth(state, TODAY, NOW + 1).rows.map((one) => [one.status, one.pendingDay]), [['overdue', null]]);
    // and the posted row teaches the payee
    const posted = sent(state, '2026-11-09', 25000, ZELLE);
    refresh(state, NOW + 2);
    assert.equal(entry.payee, ZELLE_KEY);
    assert.equal(posted.recurringId, entry.id);
  }
});

test('R3: a payee another entry of the same amount holds is never learned from one late row', () => {
  const state = newState();
  const flat = makeByHand({ id: 'bh_a', name: 'Flat share', amount: 25000, dueDay: 1, since: '2026-11-01', payee: ZELLE_KEY });
  const storage = makeByHand({ id: 'bh_b', name: 'Storage', amount: 25000, dueDay: 15, since: '2026-11-01' });
  state.recurring.push(storage, flat);
  const late = sent(state, '2026-11-09', 25000, ZELLE); // 8 days after the 1st, 6 days before the 15th
  for (let i = 0; i < 2; i++) refresh(state, NOW + i);
  assert.equal(late.recurringId, flat.id);
  assert.equal(storage.payee, null);
  assert.deepEqual(byHandMonth(state, TODAY, NOW).rows.map((row) => [row.entry.name, row.status]), [['Flat share', 'bank'], ['Storage', 'due']]);
});

test('R2: a second regular payment to the same payee keeps its rows when the entry is added', () => {
  const state = newState();
  for (const day of ['2026-08-05', '2026-09-04', '2026-10-05', '2026-11-05']) sent(state, day, 25000, ZELLE);
  const second = ['2026-07-22', '2026-08-22', '2026-09-22', '2026-10-22'].map((day) => sent(state, day, 6000, ZELLE));
  const entry = makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01', payee: ZELLE_KEY });
  state.recurring.push(entry);
  for (let i = 0; i < 2; i++) refresh(state, NOW + i);
  for (const row of second) assert.notEqual(row.recurringId, entry.id);
});

test('R4: rent due the 1st and sent on the 31st is paid in the month the entry is added', () => {
  const state = newState();
  const rows = ['2026-08-31', '2026-09-30', '2026-10-31'].map((day) => sent(state, day, 120000, ZELLE));
  const entry = addByHand(state, { name: 'Rent', amount: 120000, dueDay: 1 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(entry.payee, ZELLE_KEY);
  assert.deepEqual(byHandMonth(state, TODAY, NOW).rows.map((row) => [row.day, row.status, row.paidDay, row.txId]), [['2026-11-01', 'bank', '2026-10-31', rows[2].id]]);
  assert.equal(clock(state, NOW).due.filter((due) => due.byHand).length, 0);
  // a row two weeks and more before the first day, or nearer the schedule day before it, stays history
  const early = newState();
  sent(early, '2026-10-14', 120000, ZELLE);
  sent(early, '2026-09-14', 120000, ZELLE);
  addByHand(early, { name: 'Rent', amount: 120000, dueDay: 1 }, TODAY, NOW);
  refresh(early, NOW);
  assert.deepEqual(byHandMonth(early, TODAY, NOW).rows.map((row) => [row.day, row.status]), [['2026-11-01', 'overdue']]);
});

test('R6: an entry that does not run takes no detected line away; a tick does not let a second line of the payment in', () => {
  const state = newState();
  zelleHistory(state);
  refresh(state, NOW);
  assert.equal(state.recurring.filter((line) => line.source === 'detected').length, 1);
  state.recurring.push({ ...makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01', payee: ZELLE_KEY }), anchor: '' });
  refresh(state, NOW + 1);
  assert.equal(state.recurring.filter((line) => line.source === 'detected').length, 1);

  const now = at(2026, 12, 8);
  const risen = newState(now);
  sent(risen, '2026-09-04', 25000, ZELLE);
  sent(risen, '2026-10-05', 25000, ZELLE);
  sent(risen, '2026-11-05', 30000, ZELLE);
  sent(risen, '2026-12-04', 30000, ZELLE);
  const entry = makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-09-01', payee: ZELLE_KEY });
  risen.recurring.push(entry);
  refresh(risen, now);
  tickByHand(risen, entry.id, '2026-11-05', true, now + 1);
  tickByHand(risen, entry.id, '2026-12-05', true, now + 1);
  for (let i = 2; i < 5; i++) refresh(risen, now + i);
  assert.deepEqual(risen.recurring.map((line) => line.name), ['Flat share']);
  assert.equal(bookTotals(risen).perMonth, 25000);
});

test('R5: a row that is the charge of another Book line is never reported as the payment in another amount', () => {
  // a second payment to the same payee (60.00 on the 18th) has its own detected line before the entry is added
  const before = at(2026, 11, 2);
  const state = newState(before);
  for (const day of ['2026-08-05', '2026-09-04', '2026-10-05']) sent(state, day, 25000, ZELLE);
  for (const day of ['2026-08-18', '2026-09-18', '2026-10-18']) sent(state, day, 6000, ZELLE);
  refresh(state, before);
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, '2026-11-02', before);
  refresh(state, before);
  // Nov 20: the 250.00 of the 5th not sent, the 60.00 of the 18th posted
  const now = at(2026, 11, 20);
  const other = sent(state, '2026-11-18', 6000, ZELLE);
  for (let i = 0; i < 2; i++) refresh(state, now + i);
  assert.equal(entry.payee, ZELLE_KEY);
  assert.ok(other.recurringId != null && other.recurringId !== entry.id);
  assert.deepEqual(
    byHandMonth(state, '2026-11-20', now).rows.map((row) => [row.day, row.status, row.otherTxId, row.otherAmount]),
    [['2026-11-05', 'overdue', null, null]],
  );
  // the same row with no line of its own is reported: the owner may have changed the amount
  other.recurringId = null;
  assert.deepEqual(
    byHandMonth(state, '2026-11-20', now).rows.map((row) => [row.otherTxId, row.otherAmount]),
    [[other.id, 6000]],
  );
});

test('R8: clock.due lists the ordinary items of a day before the payments the owner sends; checkDoc refuses an anchor that is not a day', () => {
  const state = newState();
  state.recurring.push(
    makeByHand({ id: 'bh_2', name: 'Parking', amount: 8500, dueDay: 15, since: '2026-11-01' }),
    makeRecurring({ id: 'rec_gym', name: 'Gym', amount: 4000, cadence: 'monthly', anchor: '2026-11-15', source: 'manual', accountId: CHECKING, since: '2026-11-01' }),
    makeByHand({ id: 'bh_1', name: 'Flat share', amount: 25000, dueDay: 15, since: '2026-11-01' }),
  );
  assert.deepEqual(clock(state, NOW).due.map((item) => [item.day, item.name]), [['2026-11-15', 'Gym'], ['2026-11-15', 'Flat share'], ['2026-11-15', 'Parking']]);
  const good = newState();
  good.recurring.push(makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01' }));
  const bad = newState();
  bad.recurring.push({ ...makeByHand({ name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01' }), anchor: '' });
  assert.equal(typeof checkDoc(bad), 'string');
  assert.notEqual(typeof checkDoc(good), 'string');
});
