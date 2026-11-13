/**
 * Cash flow: a transaction's colour says whether money actually left the owner ('out', red), reached them
 * ('in', green), or neither yet (null, ink). The rows are built the way the app builds them: a SimpleFIN
 * answer, normalised, merged and refreshed; moves typed in through addProvisional and addDecline.
 * Everything here is invented: no real account, merchant charge or person.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cashFlowOf, payFlowOf } from '../js/model/cashflow.js';
import { normalizeSimplefin } from '../js/model/feed.js';
import { mergeFeed, addProvisional, addDecline } from '../js/model/merge.js';
import { refresh } from '../js/model/detect.js';
import { defaultState } from '../js/model/schema.js';

const DAY_MS = 24 * 3600 * 1000;
const NOW = new Date(2026, 10, 11, 15, 30).getTime();
const TODAY = '2026-11-11';

function dateOnly(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

function row(id, amount, day, description, extra = {}) {
  return { id, posted: dateOnly(day), amount, description, payee: '', memo: '', transacted_at: dateOnly(day), ...extra };
}

function account(id, name, balance, transactions) {
  return { id, name, conn_id: 'CON-1', currency: 'USD', balance, 'balance-date': NOW / 1000 - 3600, transactions };
}

/** A household: checking, savings, a card, a loan and a brokerage account, read from the bank as the app reads them. */
function household() {
  const answer = {
    errlist: [],
    connections: [{ conn_id: 'CON-1', name: 'Example Bank' }],
    accounts: [
      account('CHK', 'Everyday Checking', '2614.37', [
        row('debit', '-11.85', '2026-11-09', 'POS DEBIT CORNER DELI 123'),
        row('zelle-out', '-250.00', '2026-11-05', 'Zelle payment to Jordan Example'),
        row('zelle-in', '73.00', '2026-11-06', 'Zelle payment from Sam Example'),
        row('paycheck', '1712.64', '2026-11-01', 'ACME CORP PAYROLL DIRECT DEP'),
        row('card-pay', '-268.00', '2026-11-08', 'DISCOVER E-PAYMENT 4321'),
        row('to-savings', '-185.00', '2026-11-07', 'TRANSFER TO SAVINGS XXXX9876'),
        row('refund', '18.75', '2026-11-04', 'REFUND NORTHSIDE HARDWARE'),
        row('fee', '-2.50', '2026-11-03', 'ATM FEE'),
        row('to-someone', '-475.00', '2026-11-02', 'ONLINE TRANSFER TO J EXAMPLE REF 123'),
        row('loan-pay', '-410.00', '2026-11-03', 'AUTO LOAN PAYMENT'),
        row('pending', '-6.55', TODAY, 'POS DEBIT BLUE BOTTLE', { posted: 0, pending: true }),
      ]),
      account('SAV', 'Rainy Day Savings', '4870.00', [
        row('from-checking', '185.00', '2026-11-07', 'TRANSFER FROM CHECKING XXXX1234'),
        row('interest', '2.10', '2026-10-31', 'MONTHLY INTEREST PAID'),
      ]),
      account('CARD', 'Northlight Rewards Visa', '-900.00', [
        row('card-buy', '-43.10', '2026-11-06', 'NORTHSIDE HARDWARE'),
        row('card-interest', '-11.27', '2026-11-01', 'INTEREST CHARGE ON PURCHASES'),
        row('card-in', '268.00', '2026-11-09', 'PAYMENT THANK YOU'),
        row('card-refund', '20.00', '2026-11-08', 'NORTHSIDE HARDWARE REFUND'),
        row('card-unlinked', '137.00', '2026-11-10', 'ONLINE PAYMENT FROM EXT ACCT'),
        row('card-pending', '-8.25', TODAY, 'NORTHSIDE HARDWARE', { posted: 0, pending: true }),
      ]),
      account('LOAN', 'Auto Loan', '-9000.00', [
        row('loan-in', '410.00', '2026-11-04', 'PAYMENT RECEIVED'),
        row('loan-interest', '-27.40', '2026-11-01', 'INTEREST'),
      ]),
      account('INV', 'Brokerage Individual', '10000.00', [
        row('buy', '-1000.00', '2026-11-05', 'BUY VTI'),
        row('dividend', '11.40', '2026-11-06', 'DIVIDEND PAID VTI'),
      ]),
    ],
  };
  const state = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(state, normalizeSimplefin(answer, { fetchedAt: NOW, fromMs: NOW - 30 * DAY_MS, toMs: NOW }), NOW);
  refresh(state, NOW);
  return state;
}

function lookups(state) {
  const accountOf = (id) => state.accounts.find((a) => a.id === id) || null;
  const pairOf = (id) => state.txs.find((t) => t.id === id) || null;
  return { accountOf, pairOf };
}

function flowOf(state, extId) {
  const tx = state.txs.find((t) => t.ext && t.ext.id === extId);
  assert.ok(tx, 'the row ' + extId + ' is on the record');
  const { accountOf, pairOf } = lookups(state);
  return cashFlowOf(tx, accountOf, pairOf);
}

function accountId(state, extId) {
  return state.accounts.find((a) => a.ext && a.ext.id === extId).id;
}

const state = household();

test('red: money that left a cash account', () => {
  assert.equal(flowOf(state, 'debit'), 'out', 'a debit purchase');
  assert.equal(flowOf(state, 'zelle-out'), 'out', 'a Zelle sent');
  assert.equal(flowOf(state, 'fee'), 'out', 'a fee taken from cash');
  assert.equal(flowOf(state, 'to-someone'), 'out', 'a bank transfer to someone (no other leg on the record)');
});

test('red: a payment to a card or a loan, on both legs', () => {
  const tx = (extId) => state.txs.find((t) => t.ext && t.ext.id === extId);
  assert.ok(tx('card-pay').pairId && tx('card-in').pairId, 'the card payment is paired as the app pairs it');
  assert.equal(flowOf(state, 'card-pay'), 'out', 'from checking');
  assert.equal(flowOf(state, 'card-in'), 'out', 'as it lands on the card');
  assert.equal(flowOf(state, 'loan-pay'), 'out', 'a loan payment from checking');
  assert.equal(flowOf(state, 'loan-in'), 'out', 'as it lands on the loan');
  assert.equal(flowOf(state, 'card-unlinked'), 'out', 'a payment to the card from an account not on the record');
});

test('green: money that arrived from outside', () => {
  assert.equal(flowOf(state, 'paycheck'), 'in', 'a paycheck');
  assert.equal(flowOf(state, 'zelle-in'), 'in', 'a Zelle received');
  assert.equal(flowOf(state, 'interest'), 'in', 'interest earned on savings');
  assert.equal(flowOf(state, 'dividend'), 'in', 'a dividend into the brokerage account');
  assert.equal(flowOf(state, 'refund'), 'in', 'a refund into checking');
});

test('black: no money has moved yet, or it stayed the owner’s', () => {
  assert.equal(flowOf(state, 'card-buy'), null, 'a purchase on the card, not yet paid');
  assert.equal(flowOf(state, 'card-interest'), null, 'card interest');
  assert.equal(flowOf(state, 'loan-interest'), null, 'interest added to the loan');
  assert.equal(flowOf(state, 'card-refund'), null, 'a refund onto the card');
  assert.equal(flowOf(state, 'to-savings'), null, 'checking to savings');
  assert.equal(flowOf(state, 'from-checking'), null, 'savings from checking');
  assert.equal(flowOf(state, 'buy'), null, 'a buy inside the brokerage account');
});

test('a pending row follows the same rule', () => {
  const pending = state.txs.find((t) => t.ext && t.ext.id === 'pending');
  assert.equal(pending.pending, true);
  assert.equal(flowOf(state, 'pending'), 'out', 'a pending debit purchase');
  assert.equal(flowOf(state, 'card-pending'), null, 'a pending card purchase');
});

test('a move typed in: red from cash or from no known account, black on a card; a decline is never coloured', () => {
  const doc = household();
  const { accountOf, pairOf } = lookups(doc);
  const fromCash = addProvisional(doc, { amount: 365, merchant: 'Corner Deli', day: TODAY, accountId: accountId(doc, 'CHK') }, NOW);
  const fromNowhere = addProvisional(doc, { amount: 365, merchant: 'Corner Deli', day: TODAY, accountId: null }, NOW);
  const onCard = addProvisional(doc, { amount: 365, merchant: 'Corner Deli', day: TODAY, accountId: accountId(doc, 'CARD') }, NOW);
  const declined = addDecline(doc, { amount: 525, merchant: 'Corner Deli', day: TODAY }, NOW);
  assert.equal(fromCash.source, 'manual');
  assert.equal(cashFlowOf(fromCash, accountOf, pairOf), 'out');
  assert.equal(cashFlowOf(fromNowhere, accountOf, pairOf), 'out');
  assert.equal(cashFlowOf(onCard, accountOf, pairOf), null);
  assert.equal(declined.kind, 'decline');
  assert.equal(cashFlowOf(declined, accountOf, pairOf), null);
});

test('a pair the owner kept as a transfer is still a payment when one leg is on a card', () => {
  const doc = household();
  const { accountOf, pairOf } = lookups(doc);
  const out = doc.txs.find((t) => t.ext && t.ext.id === 'card-pay');
  const into = pairOf(out.pairId);
  const kept = { ...out, kind: 'transfer', category: 'transfer' };
  const landed = { ...into, kind: 'transfer', category: 'transfer' };
  assert.equal(cashFlowOf(kept, accountOf, pairOf), 'out');
  assert.equal(cashFlowOf(landed, accountOf, pairOf), 'out');
  assert.equal(cashFlowOf(kept, accountOf), null, 'without the other leg nothing says it was a payment');
});

test('nothing to read is never coloured', () => {
  assert.equal(cashFlowOf(null), null);
  assert.equal(cashFlowOf({ kind: 'spend', flow: 'out', amount: 0, accountId: null }), null);
  assert.equal(cashFlowOf({ kind: 'spend', flow: 'out', amount: 500, accountId: 'gone' }), 'out', 'an account no longer on the record is no known account');
  assert.equal(cashFlowOf({ kind: 'transfer', flow: 'in', amount: 500, accountId: null }), null, 'money coming in that is not income or a refund');
});

test('the payments to make: paid, pending or ticked is red; still to pay is black', () => {
  assert.equal(payFlowOf('bank'), 'out');
  assert.equal(payFlowOf('pending'), 'out');
  assert.equal(payFlowOf('hand'), 'out');
  assert.equal(payFlowOf('due'), null);
  assert.equal(payFlowOf('overdue'), null);
  assert.equal(payFlowOf(undefined), null);
});
