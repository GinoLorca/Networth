/**
 * The usual payday (ARCHITECTURE 4.9): a paycheck is expected on the day its deposits usually land, so one that
 * came on a different day than usual does not move every prediction after it. Every figure here is invented.
 * Friday 6 November 2026 is the official payday of the rhythm used below; Thursday is a day early.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { usualSchedule } from '../js/model/book.js';
import { clock, makeLedger } from '../js/model/ledger.js';
import { defaultState, makeAccount, makeStream, makeTx } from '../js/model/schema.js';
import { addDays } from '../js/model/dates.js';

const at = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();
const biweekly = (anchor, fields = {}) => ({ id: 'str_pay', cadence: 'biweekly', anchor, ...fields });

/** Paychecks every 2 weeks back from `latest`: offsets[i] days from the rhythm (−1 a day early), oldest first. */
function paydays(latestOfficial, offsets) {
  return offsets.map((offset, i) => addDays(addDays(latestOfficial, -14 * (offsets.length - 1 - i)), offset));
}

test('mostly a day early, the latest on its official day: expected a day early', () => {
  const days = paydays('2026-11-06', [-1, -1, -1, 0, -1, 0]); // latest Fri Nov 6, on time
  const s = usualSchedule(biweekly('2026-11-06'), days);
  assert.equal(s.anchor, '2026-11-05', 'Thursday');
});

test('mostly a day early, the latest early too: nothing moves', () => {
  const item = biweekly('2026-11-05');
  const days = paydays('2026-11-06', [-1, 0, -1, -1, -1, -1]);
  assert.equal(usualSchedule(item, days), item, 'the same object back');
});

test('mostly on time, the latest a day early: expected on its official day', () => {
  const days = paydays('2026-11-06', [0, 0, 0, -1, 0, -1]); // latest Thu Nov 5
  assert.equal(usualSchedule(biweekly('2026-11-05'), days).anchor, '2026-11-06');
});

test('a tie goes to the later day; a holiday shift is not counted; old deposits are not counted', () => {
  assert.equal(usualSchedule(biweekly('2026-11-06'), paydays('2026-11-06', [-1, 0, -1, 0])).anchor, '2026-11-06', '2 and 2: Friday');
  // a deposit 5 days early is not on the rhythm at all
  assert.equal(usualSchedule(biweekly('2026-11-06'), paydays('2026-11-06', [-1, -5, -1, 0])).anchor, '2026-11-05');
  // deposits more than 6 periods back say nothing about today's rhythm
  const old = paydays('2026-08-14', [-1, -1, -1, -1]);
  const recent = paydays('2026-11-06', [0, 0, 0]);
  assert.equal(usualSchedule(biweekly('2026-11-06'), [...old, ...recent]).anchor, '2026-11-06');
});

test('unchanged with too few deposits, a cadence by the month, or an anchor the owner set', () => {
  const item = biweekly('2026-11-06');
  assert.equal(usualSchedule(item, paydays('2026-11-06', [-1, 0])), item, 'two deposits');
  const monthly = { id: 'm', cadence: 'monthly', anchor: '2026-11-06' };
  assert.equal(usualSchedule(monthly, ['2026-08-05', '2026-09-05', '2026-10-05', '2026-11-06']), monthly);
  const locked = biweekly('2026-11-06', { locks: ['anchor'] });
  assert.equal(usualSchedule(locked, paydays('2026-11-06', [-1, -1, -1, 0])), locked);
  assert.equal(usualSchedule(item, null), item);
});

/** A household paid every 2 weeks into checking, with the given deposit days. */
function household(depositDays, nowMs) {
  const s = defaultState(at(2026, 1, 1));
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 300000, basis: 'bank', asOf: nowMs - 3600e3 }));
  const latest = depositDays[depositDays.length - 1];
  s.streams.push(makeStream({ id: 'str_pay', name: 'Payroll', kind: 'salary', accountId: 'acc_chk', cadence: 'biweekly', anchor: latest, amount: 150000, accrue: false }));
  depositDays.forEach((day, i) => s.txs.push(makeTx({ id: 'dep' + i, accountId: 'acc_chk', day, postedDay: day, amount: 150000, flow: 'in', kind: 'income', category: 'income', streamId: 'str_pay', loggedAt: at(2026, 1, 1) + i })));
  return s;
}

test('the clock and the stream sheet expect the paycheck on its usual day', () => {
  const days = paydays('2026-11-06', [-1, -1, -1, -1, -1, 0]); // latest on time (Fri Nov 6), usually Thursday
  const now = at(2026, 11, 14);
  const s = household(days, now);
  const c = clock(s, now);
  assert.equal(c.nextPayday, '2026-11-19', 'Thursday Nov 19, not Friday Nov 20');
  assert.equal(c.payAwaited, null);
  assert.equal(c.dueUntil, '2026-11-18');
  assert.equal(makeLedger(s, now).nextPayOf('str_pay'), '2026-11-19', 'the sheet\'s "Next expected" agrees');

  // on the usual day it is payday until the deposit lands; the day after, it is awaited, not lost
  const thursday = at(2026, 11, 19);
  assert.equal(clock(s, thursday).nextPayday, '2026-11-19');
  const friday = clock(s, at(2026, 11, 20));
  assert.equal(friday.payAwaited, '2026-11-19');
  // it lands on its official day after all (2 of the last 6 on time, 4 a day early): the next is still expected on Thursday
  s.txs.push(makeTx({ id: 'dep-late', accountId: 'acc_chk', day: '2026-11-20', postedDay: '2026-11-20', amount: 150000, flow: 'in', kind: 'income', category: 'income', streamId: 'str_pay', loggedAt: at(2026, 11, 20) }));
  s.streams[0].anchor = '2026-11-20';
  const after = clock(s, at(2026, 11, 21));
  assert.deepEqual([after.nextPayday, after.payAwaited], ['2026-12-03', null], 'Thursday Dec 3');
});

test('a paycheck that lands before its usual day pays that cycle: the next payday is the following one', () => {
  // usually Friday; the latest came Thursday Nov 5
  const days = ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-08', '2026-10-23', '2026-11-05'];
  const s = household(days, at(2026, 11, 5));
  for (const [when, label] of [[at(2026, 11, 5), 'on the day it landed'], [at(2026, 11, 6), 'on its usual day']]) {
    const c = clock(s, when);
    assert.equal(c.nextPayday, '2026-11-20', label + ': Friday Nov 20, never the day just paid');
    assert.equal(c.payAwaited, null, label);
    assert.equal(c.dueUntil, '2026-11-19', label + ': the due window runs to the day before');
    assert.equal(makeLedger(s, when).nextPayOf('str_pay'), '2026-11-20', label + ': the sheet agrees');
  }
});

test('a holiday deposit two days early is still this cycle\'s pay', () => {
  // usually Thursday; the latest came Tuesday Nov 3 (a holiday on Thursday)
  const days = paydays('2026-11-05', [0, 0, 0, 0, 0, -2]);
  const s = household(days, at(2026, 11, 3));
  assert.equal(clock(s, at(2026, 11, 3)).nextPayday, '2026-11-19');
  assert.equal(clock(s, at(2026, 11, 5)).nextPayday, '2026-11-19', 'on the usual Thursday too');
});

test('a stream that lapsed and resumed on another day follows its new rhythm', () => {
  const days = ['2026-07-10', '2026-07-24', '2026-08-07', '2026-08-21', '2026-09-04', '2026-10-28', '2026-11-11'];
  const s = household(days, at(2026, 11, 11));
  assert.equal(clock(s, at(2026, 11, 11)).nextPayday, '2026-11-25', 'Wednesday, as the run since the lapse says');
});

test('the window counts the last 6 rhythm slots, on either side of the rhythm', () => {
  const item = biweekly('2026-11-05');
  // slots 0-4 hold 3 Thursdays and 2 Fridays; slot 6 holds a Friday that must not vote
  const days = ['2026-08-14', '2026-09-11', '2026-09-24', '2026-10-09', '2026-10-22', '2026-11-05'];
  assert.equal(usualSchedule(item, days), item, 'Thursday stays');
});

test('the sheet shows the clock\'s day for the main paycheck: today on payday, the day it was due while awaited', () => {
  const days = paydays('2026-11-06', [-1, -1, -1, -1, -1, 0]); // usually Thursday
  const s = household(days, at(2026, 11, 19));
  assert.equal(makeLedger(s, at(2026, 11, 19)).nextPayOf('str_pay'), '2026-11-19', 'payday: today');
  assert.equal(makeLedger(s, at(2026, 11, 21)).nextPayOf('str_pay'), '2026-11-19', 'awaited: the day it was due');
  assert.equal(clock(s, at(2026, 11, 21)).payAwaited, '2026-11-19');
});
