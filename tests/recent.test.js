import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { recentTransactions } from '../js/model/recent.js';
import { buildDemoState } from '../js/model/demo.js';

const TODAY = '2026-06-10';
const at = (d, h = 12) => Date.UTC(2026, 5, d, h);

function record() {
  const state = defaultState(at(1));
  state.accounts.push(
    makeAccount({ id: 'acc_chk', type: 'checking', name: 'Everyday Checking' }),
    makeAccount({ id: 'acc_card', type: 'credit_card', name: 'Rewards Visa' }),
    makeAccount({ id: 'acc_old', type: 'savings', name: 'Old Savings', hidden: true }),
  );
  return state;
}

function row(id, day, amount, fields = {}) {
  return makeTx({ id, accountId: 'acc_card', day, postedDay: day, amount, flow: 'out', kind: 'spend', merchant: id, loggedAt: at(1), ...fields });
}

test('recentTransactions: newest first, by day, then time, then arrival', () => {
  const state = record();
  state.txs.push(
    row('older', '2026-06-08', 500),
    row('morning', TODAY, 365, { at: at(10, 8) }),
    row('evening', TODAY, 1240, { at: at(10, 19) }),
    row('untimed', TODAY, 900, { loggedAt: at(10, 20) }),
    row('yesterday', '2026-06-09', 331),
  );
  const { rows, total } = recentTransactions(state, TODAY);
  assert.deepEqual(rows.map((r) => r.tx.id), ['evening', 'morning', 'untimed', 'yesterday', 'older']);
  assert.equal(total, 5);
  assert.equal(rows[0].account.name, 'Rewards Visa');
});

test('recentTransactions: the limit keeps the newest and still counts all', () => {
  const state = record();
  for (let d = 1; d <= 9; d++) state.txs.push(row('t' + d, '2026-06-0' + d, 100 * d));
  const { rows, total } = recentTransactions(state, TODAY, { limit: 3 });
  assert.deepEqual(rows.map((r) => r.tx.id), ['t9', 't8', 't7']);
  assert.equal(total, 9);
});

test('recentTransactions: what is not a transaction to show is left out', () => {
  const state = record();
  state.txs.push(
    row('kept', '2026-06-09', 500),
    row('declined', '2026-06-09', 525, { kind: 'decline', source: 'manual' }),
    row('confirmed-tap', '2026-06-09', 500, { source: 'manual', matchId: 'kept' }),
    row('left-out', '2026-06-09', 700, { accountId: 'acc_old' }),
    row('tomorrow', '2026-06-11', 800),
    row('no-day', '', 800),
  );
  state.txs.push(null, 7, {});
  assert.deepEqual(recentTransactions(state, TODAY).rows.map((r) => r.tx.id), ['kept']);
});

test('recentTransactions: a payment between two of the owner\'s accounts is listed once, as the money leaving', () => {
  const state = record();
  state.txs.push(
    row('pay-out', '2026-06-09', 46000, { accountId: 'acc_chk', kind: 'payment', pairId: 'pay-in' }),
    row('pay-in', '2026-06-09', 46000, { accountId: 'acc_card', kind: 'payment', flow: 'in', pairId: 'pay-out' }),
    // the other leg is on an account that was left out: the leg that is visible stays
    row('lone-in', '2026-06-08', 20000, { accountId: 'acc_chk', kind: 'transfer', flow: 'in', pairId: 'hidden-out' }),
    row('hidden-out', '2026-06-08', 20000, { accountId: 'acc_old', kind: 'transfer', pairId: 'lone-in' }),
  );
  assert.deepEqual(recentTransactions(state, TODAY).rows.map((r) => r.tx.id), ['pay-out', 'lone-in']);
});

test('recentTransactions: today is counted, with what went out and came in; own transfers are in neither sum', () => {
  const state = record();
  state.txs.push(
    row('coffee', TODAY, 365, { pending: true }),
    row('groceries', TODAY, 6410),
    row('refund', TODAY, 1200, { flow: 'in', kind: 'refund' }),
    row('pay-out', TODAY, 46000, { accountId: 'acc_chk', kind: 'payment', pairId: 'pay-in' }),
    row('pay-in', TODAY, 46000, { kind: 'payment', flow: 'in', pairId: 'pay-out' }),
    row('yesterday', '2026-06-09', 999),
  );
  assert.deepEqual(recentTransactions(state, TODAY).today, { count: 4, out: 6775, in: 1200, unsettled: true });
  state.txs = state.txs.filter((tx) => tx.day !== TODAY);
  assert.deepEqual(recentTransactions(state, TODAY).today, { count: 0, out: 0, in: 0, unsettled: false });
});

test('recentTransactions: a row that arrived after the last look is new; nothing is new on a first look', () => {
  const state = record();
  state.txs.push(
    row('before', '2026-06-09', 500, { loggedAt: at(9, 8) }),
    row('after', TODAY, 365, { loggedAt: at(10, 9) }),
    row('tapped', TODAY, 450, { source: 'manual', loggedAt: at(10, 10) }),
  );
  const looked = recentTransactions(state, TODAY, { seenAt: at(9, 20) });
  assert.deepEqual(looked.rows.map((r) => [r.tx.id, r.isNew, r.provisional]), [['tapped', true, true], ['after', true, false], ['before', false, false]]);
  assert.equal(looked.fresh, 2);
  const first = recentTransactions(state, TODAY);
  assert.equal(first.fresh, 0);
  assert.equal(first.rows.some((r) => r.isNew), false);
});

test('recentTransactions: odd input gives an empty list, never an error', () => {
  for (const state of [null, undefined, 7, {}, { txs: 'many', accounts: null }]) {
    assert.deepEqual(recentTransactions(state, TODAY), { rows: [], today: { count: 0, out: 0, in: 0, unsettled: false }, fresh: 0, total: 0 });
  }
  assert.equal(recentTransactions(record(), 'someday').rows.length, 0);
});

test('recentTransactions: the sample game lists its card and its checking account', () => {
  const now = Date.parse('2026-06-10T14:36');
  const state = buildDemoState(now);
  const { rows, total } = recentTransactions(state, TODAY, { limit: 12 });
  assert.equal(rows.length, 12);
  assert.ok(total > 12);
  const kinds = new Set(rows.map((r) => r.account && r.account.type));
  assert.ok(kinds.has('credit_card'), 'card rows are in the latest twelve');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].tx.day >= rows[i].tx.day);
});
