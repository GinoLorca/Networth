/**
 * Detection: the Book, income streams, the habit baseline, automatic sweeps and refresh.
 * Every history here is invented. Timestamps are built from local calendar parts at noon, well
 * away from daylight-saving changes, so the tests read the same in any time zone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultState, makeAccount, makeRecurring, makeStream, makeTx } from '../js/model/schema.js';
import { addDays, addMonths } from '../js/model/dates.js';
import { edge, round } from '../js/model/ledger.js';
import { computeHabit, detectRecurring, detectStreams, detectSweeps, refresh, startMatch } from '../js/model/detect.js';
import { bookTotals } from '../js/model/book.js';
import { addByHand, makeByHand, payeeKey, removeByHand } from '../js/model/byhand.js';

/* ------------------------------------------------------------------ fixtures */

const HOUR_MS = 3600000;
const CHECKING = 'acc_checking';
const CARD = 'acc_card';
const SAVINGS = 'acc_savings';

/** Local noon (or the given hour) on a calendar day. */
function at(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour).getTime();
}

/** Wednesday 17 June 2026, noon. */
const NOW = at(2026, 6, 17);
const TODAY = '2026-06-17';

let sequence = 0;

/** A linked checking account, a card that is owed on and a savings account (the reserve). */
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

function addRow(state, fields) {
  sequence += 1;
  const tx = makeTx({ id: 'tx_' + sequence, postedDay: fields.day, ...fields });
  state.txs.push(tx);
  return tx;
}

/** A purchase: on the card and filed under subscriptions unless told otherwise. */
function charge(state, day, amount, merchant, extra = {}) {
  return addRow(state, {
    accountId: CARD, day, amount, flow: 'out', kind: 'spend',
    merchant, mkey: merchant.toLowerCase(), category: 'subscriptions', ...extra,
  });
}

/** Money arriving in checking from outside. */
function deposit(state, day, amount, payer, extra = {}) {
  return addRow(state, {
    accountId: CHECKING, day, amount, flow: 'in', kind: 'income',
    merchant: payer, mkey: payer.toLowerCase(), category: 'income', ...extra,
  });
}

/** A stop in the daily game. */
function coffee(state, day, amount, extra = {}) {
  return charge(state, day, amount, 'Bean Scene', { category: 'cafe', ...extra });
}

/** A move between two linked accounts: both legs, paired as merge leaves them. */
function movePair(state, day, amount, { from = CHECKING, to = CARD, kind = 'payment', extra = {} } = {}) {
  const category = kind === 'payment' ? 'card_payment' : 'transfer';
  const out = addRow(state, { accountId: from, day, amount, flow: 'out', kind, category, merchant: 'Card payment', mkey: 'card payment', ...extra });
  const arriving = addRow(state, { accountId: to, day, amount, flow: 'in', kind, category, merchant: 'Payment received', mkey: 'payment received', ...extra });
  out.pairId = arriving.id;
  arriving.pairId = out.id;
  return { out, arriving };
}

function everyDays(firstDay, step, count) {
  return Array.from({ length: count }, (unused, i) => addDays(firstDay, i * step));
}

function monthly(firstDay, count) {
  return Array.from({ length: count }, (unused, i) => addMonths(firstDay, i));
}

function rowsOf(state, mkey) {
  return state.txs.filter((tx) => tx.mkey === mkey);
}

function snapshot(state) {
  return structuredClone(state);
}

/** True when nothing anywhere in a value is NaN or infinite. */
function isFiniteThroughout(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value !== 'object') return true;
  return Object.values(value).every(isFiniteThroughout);
}

const NOTHING_RECURRING = { added: [], repriced: [], lapsed: [] };
const NOTHING_STREAMS = { added: [], updated: [] };

/* ------------------------------------------------------------ the Book: cadences */

test('a monthly subscription becomes a Book entry named after the merchant', () => {
  const state = newState();
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly');

  const report = detectRecurring(state, NOW);

  assert.equal(state.recurring.length, 1);
  const [entry] = state.recurring;
  assert.deepEqual(report, { added: [entry.id], repriced: [], lapsed: [] });
  assert.equal(entry.name, 'Streamly');
  assert.equal(entry.mkey, 'streamly');
  assert.equal(entry.accountId, CARD);
  assert.equal(entry.amount, 1549);
  assert.equal(entry.variable, false);
  assert.equal(entry.cadence, 'monthly');
  assert.equal(entry.anchor, '2026-06-12');
  assert.equal(entry.category, 'subscriptions');
  assert.equal(entry.purpose, 'personal');
  assert.equal(entry.essential, false);
  assert.equal(entry.active, true);
  assert.equal(entry.source, 'detected');
  assert.equal(entry.toAccountId, null);
  assert.deepEqual(entry.locks, []);
  assert.ok(entry.confidence > 0 && entry.confidence <= 1);
  for (const tx of state.txs) {
    assert.equal(tx.recurringId, entry.id);
    assert.equal(tx.klass, 'book');
  }
});

test('the entry falls back to the merchant key when the bank gave no display name', () => {
  const state = newState();
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly', { merchant: '' });
  detectRecurring(state, NOW);
  assert.equal(state.recurring[0].name, 'streamly');
});

test('two monthly charges are enough only when their amounts are equal', () => {
  const equal = newState();
  for (const day of monthly('2026-05-12', 2)) charge(equal, day, 1549, 'Streamly');
  detectRecurring(equal, NOW);
  assert.equal(equal.recurring.length, 1);
  assert.equal(equal.recurring[0].cadence, 'monthly');

  const unequal = newState();
  charge(unequal, '2026-05-12', 1549, 'Streamly');
  charge(unequal, '2026-06-12', 1599, 'Streamly');
  assert.deepEqual(detectRecurring(unequal, NOW), NOTHING_RECURRING);
  assert.equal(unequal.recurring.length, 0);
  assert.ok(unequal.txs.every((tx) => tx.recurringId === null));
});

test('a single charge and an irregular merchant are not recurring', () => {
  const state = newState();
  charge(state, '2026-06-02', 4999, 'Gadget Barn', { category: 'shopping' });
  for (const day of ['2026-02-03', '2026-02-19', '2026-04-27', '2026-05-02', '2026-06-11']) {
    charge(state, day, 2500, 'Corner Hardware', { category: 'household' });
  }
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 0);
});

test('a utility whose amount moves within 35% is a variable bill at the median of its last three', () => {
  const state = newState();
  const bills = [['2026-02-03', 8420], ['2026-03-04', 10110], ['2026-04-02', 9230], ['2026-05-05', 7680], ['2026-06-03', 11890]];
  for (const [day, amount] of bills) charge(state, day, amount, 'City Power', { accountId: CHECKING, category: 'utilities' });

  const report = detectRecurring(state, NOW);

  const [entry] = state.recurring;
  assert.deepEqual(report.added, [entry.id]);
  assert.equal(entry.variable, true);
  assert.equal(entry.cadence, 'monthly');
  assert.equal(entry.amount, 9230);
  assert.equal(entry.anchor, '2026-06-03');
  assert.equal(entry.accountId, CHECKING);
  assert.equal(entry.category, 'utilities');
  assert.equal(entry.essential, true);
});

test('monthly charges whose amounts are further apart than 35% are not a bill', () => {
  const state = newState();
  const visits = [['2026-03-06', 2100], ['2026-04-05', 9400], ['2026-05-06', 31000], ['2026-06-05', 4800]];
  for (const [day, amount] of visits) charge(state, day, amount, 'Outfitters Row', { category: 'shopping' });
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('an annual renewal seen twice is in the Book', () => {
  const state = newState();
  charge(state, '2025-05-20', 9900, 'Domain Depot', { category: 'software' });
  charge(state, '2026-05-20', 10500, 'Domain Depot', { category: 'software' });

  detectRecurring(state, NOW);

  const [entry] = state.recurring;
  assert.equal(state.recurring.length, 1);
  assert.equal(entry.cadence, 'annual');
  assert.equal(entry.anchor, '2026-05-20');
  assert.equal(entry.amount, 10500, 'a fixed price is the most recent charge');
  assert.equal(entry.variable, false);
  assert.equal(entry.active, true);
});

test('an annual renewal seen once is not', () => {
  const state = newState();
  charge(state, '2026-05-20', 9900, 'Domain Depot', { category: 'software' });
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('quarterly and twice-yearly charges need two occurrences', () => {
  const state = newState();
  charge(state, '2026-03-10', 21000, 'Harbor Mutual', { category: 'insurance' });
  charge(state, '2026-06-09', 21000, 'Harbor Mutual', { category: 'insurance' });
  charge(state, '2025-12-01', 4500, 'Vault Storage', { category: 'household' });
  charge(state, '2026-06-01', 4500, 'Vault Storage', { category: 'household' });

  detectRecurring(state, NOW);

  const insurance = state.recurring.find((entry) => entry.mkey === 'harbor mutual');
  const storage = state.recurring.find((entry) => entry.mkey === 'vault storage');
  assert.equal(insurance.cadence, 'quarterly');
  assert.equal(insurance.essential, true);
  assert.equal(storage.cadence, 'semiannual');
});

test('weekly and fortnightly charges need four occurrences and a steady amount', () => {
  const state = newState();
  for (const day of everyDays('2026-05-18', 7, 5)) charge(state, day, 3400, 'Metro Weekly Pass', { category: 'transit' });
  for (const day of everyDays('2026-06-01', 7, 3)) charge(state, day, 1200, 'Laundry Locker', { category: 'household' });
  for (const day of everyDays('2026-04-30', 14, 4)) charge(state, day, 2600, 'Garden Box', { category: 'groceries' });

  detectRecurring(state, NOW);

  assert.deepEqual(state.recurring.map((entry) => [entry.mkey, entry.cadence]).sort(), [
    ['garden box', 'biweekly'],
    ['metro weekly pass', 'weekly'],
  ]);
  assert.ok(rowsOf(state, 'laundry locker').every((tx) => tx.recurringId === null));
});

test('weekly coffee never becomes a bill, however regular it is', () => {
  const state = newState();
  for (const day of everyDays('2026-04-06', 7, 11)) coffee(state, day, 475);

  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 0);
  for (const tx of state.txs) {
    assert.equal(tx.recurringId, null);
    assert.equal(tx.klass, 'game');
  }
});

test('a game-class stop stays out of the Book in every stop category', () => {
  const state = newState();
  for (const day of monthly('2026-02-10', 5)) charge(state, day, 1800, 'Noodle Nook', { category: 'eating_out' });
  for (const day of monthly('2026-02-11', 5)) charge(state, day, 2400, 'Dash Dinners', { category: 'delivery' });
  for (const day of monthly('2026-02-12', 5)) charge(state, day, 350, 'Corner Kiosk', { category: 'convenience' });
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('a weekly shop whose amount moves is shopping, not a bill', () => {
  const state = newState();
  const amounts = [6230, 8110, 5480, 7390, 9020, 6650];
  everyDays('2026-05-09', 7, 6).forEach((day, i) => charge(state, day, amounts[i], 'Green Grocer', { category: 'groceries' }));
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('charges are grouped by account as well as by merchant', () => {
  const state = newState();
  for (const day of monthly('2026-03-05', 4)) charge(state, day, 999, 'Cloud Locker');
  for (const day of monthly('2026-02-19', 4)) charge(state, day, 999, 'Cloud Locker', { accountId: CHECKING });

  detectRecurring(state, NOW);

  const anchors = Object.fromEntries(state.recurring.map((entry) => [entry.accountId, entry.anchor]));
  assert.deepEqual(anchors, { [CARD]: '2026-06-05', [CHECKING]: '2026-05-19' });
  for (const tx of state.txs) assert.equal(tx.recurringId, state.recurring.find((entry) => entry.accountId === tx.accountId).id);
});

test('a charge dated after today is not read yet', () => {
  const state = newState();
  for (const day of monthly('2026-03-19', 4)) charge(state, day, 999, 'Cloud Locker');
  detectRecurring(state, NOW);
  assert.equal(state.recurring[0].anchor, '2026-05-19');
  assert.equal(rowsOf(state, 'cloud locker')[3].recurringId, null);
});

test('two subscriptions billed under one merchant name are two entries', () => {
  const state = newState();
  for (const day of monthly('2026-03-03', 4)) charge(state, day, 299, 'Orchard Digital');
  for (const day of monthly('2026-02-20', 4)) charge(state, day, 1499, 'Orchard Digital');

  detectRecurring(state, NOW);

  assert.deepEqual(state.recurring.map((entry) => entry.amount).sort((a, b) => a - b), [299, 1499]);
  const small = state.recurring.find((entry) => entry.amount === 299);
  assert.ok(rowsOf(state, 'orchard digital').filter((tx) => tx.amount === 299).every((tx) => tx.recurringId === small.id));
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 2);
});

test('like amounts some months apart among a merchant\'s other charges are not split off as a renewal', () => {
  const state = newState();
  for (const day of ['2025-12-12', '2026-03-13', '2026-06-12']) charge(state, day, 2000, 'Everything Store', { category: 'shopping' });
  const others = [['2026-01-04', 6150], ['2026-01-29', 899], ['2026-02-17', 13400], ['2026-04-02', 4725], ['2026-04-30', 31000], ['2026-05-21', 1150]];
  for (const [day, amount] of others) charge(state, day, amount, 'Everything Store', { category: 'shopping' });

  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 0);
});

test('a subscription is still found among a merchant\'s other charges', () => {
  const state = newState();
  const membership = monthly('2026-02-08', 5).map((day) => charge(state, day, 1499, 'Everything Store', { category: 'shopping' }));
  const others = [['2026-02-17', 13400], ['2026-03-02', 4725], ['2026-04-27', 31000], ['2026-05-21', 6150], ['2026-06-03', 899]];
  const orders = others.map(([day, amount]) => charge(state, day, amount, 'Everything Store', { category: 'shopping' }));

  detectRecurring(state, NOW);

  assert.equal(state.recurring.length, 1);
  const [entry] = state.recurring;
  assert.deepEqual([entry.cadence, entry.amount, entry.anchor, entry.variable], ['monthly', 1499, '2026-06-08', false]);
  assert.ok(membership.every((tx) => tx.recurringId === entry.id && tx.klass === 'book'));
  assert.ok(orders.every((tx) => tx.recurringId === null && tx.klass === 'want'));
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('a late or skipped charge does not end a long-running entry', () => {
  const state = newState();
  const days = monthly('2025-07-08', 12).filter((day) => day !== '2026-01-08');
  for (const day of days) charge(state, day, 4500, 'Fit Factory', { category: 'health' });

  detectRecurring(state, NOW);

  assert.equal(state.recurring.length, 1);
  assert.equal(state.recurring[0].cadence, 'monthly');
  assert.equal(state.recurring[0].anchor, '2026-06-08');
});

test('confidence grows with occurrences and stays between 0 and 1', () => {
  const young = newState();
  for (const day of monthly('2026-04-12', 3)) charge(young, day, 1549, 'Streamly');
  detectRecurring(young, NOW);

  const old = newState();
  for (const day of monthly('2025-07-12', 12)) charge(old, day, 1549, 'Streamly');
  detectRecurring(old, NOW);

  const moving = newState();
  const bills = [['2026-04-03', 8420], ['2026-05-05', 11110], ['2026-06-03', 9230]];
  for (const [day, amount] of bills) charge(moving, day, amount, 'City Power', { category: 'utilities' });
  detectRecurring(moving, NOW);

  const confidences = [young, old, moving].map((state) => state.recurring[0].confidence);
  for (const confidence of confidences) assert.ok(confidence > 0 && confidence <= 1, String(confidence));
  assert.ok(confidences[1] > confidences[0]);
  assert.ok(confidences[0] > confidences[2]);
});

/* ---------------------------------------------- the Book: what counts as a charge */

test('rows the bank did not report, hidden accounts and future days are left out', () => {
  const state = newState();
  state.accounts.push(makeAccount({ id: 'acc_closed', source: 'bank', type: 'checking', name: 'Old Checking', hidden: true }));
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly', { accountId: 'acc_closed' });
  for (const day of monthly('2026-03-14', 4)) charge(state, day, 800, 'Tapped In', { source: 'manual' });
  for (const day of monthly('2026-03-15', 4)) charge(state, day, 900, 'Thought Better', { kind: 'decline' });
  for (const day of monthly('2026-03-16', 4)) charge(state, day, 700, 'Confirmed Twice', { matchId: 'tx_other' });
  for (const day of monthly('2026-07-01', 4)) charge(state, day, 600, 'Not Yet');
  for (const day of monthly('2026-03-18', 4)) charge(state, day, 500, 'No Such Account', { accountId: 'acc_missing' });

  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 0);
});

test('refunds, deposits and transfers between accounts are not charges', () => {
  const state = newState();
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly', { flow: 'in', kind: 'refund' });
  for (const day of monthly('2026-03-01', 4)) movePair(state, day, 20000, { to: SAVINGS, kind: 'transfer' });
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('a standing card payment from checking is a Book entry that pays the card down', () => {
  const state = newState();
  const legs = monthly('2026-03-02', 4).map((day) => movePair(state, day, 15000));

  detectRecurring(state, NOW);

  assert.equal(state.recurring.length, 1);
  const [entry] = state.recurring;
  assert.equal(entry.accountId, CHECKING);
  assert.equal(entry.toAccountId, CARD);
  assert.equal(entry.category, 'debt_service');
  assert.equal(entry.cadence, 'monthly');
  for (const { out, arriving } of legs) {
    assert.equal(out.recurringId, entry.id);
    assert.equal(out.kind, 'payment');
    assert.equal(arriving.recurringId, null);
  }
});

/* --------------------------------------------------------- the Book: loan payments */

function addLoan(state, fields = {}) {
  const loan = makeAccount({
    id: 'acc_loan', type: 'loan', name: 'Equipment loan', balance: -950000, apr: 6.5,
    loan: { payment: 24000, assumeScheduled: true },
    history: [{ day: '2026-01-05', balance: -950000, note: '' }],
    ...fields,
  });
  state.accounts.push(loan);
  return loan;
}

function loanPayments(state, amount = 24000, merchant = 'Tidewater Lending') {
  for (const day of monthly('2026-03-05', 4)) charge(state, day, amount, merchant, { accountId: CHECKING, category: 'debt_service' });
}

test('a loan payment is tied to the loan the owner has', () => {
  const state = newState();
  addLoan(state);
  loanPayments(state);

  detectRecurring(state, NOW);

  const [entry] = state.recurring;
  assert.equal(entry.toAccountId, 'acc_loan');
  assert.equal(entry.category, 'debt_service');
  assert.equal(entry.essential, true);
});

test('with no loan on file a loan payment pays nothing down', () => {
  const state = newState();
  loanPayments(state);
  detectRecurring(state, NOW);
  assert.equal(state.recurring.length, 1);
  assert.equal(state.recurring[0].toAccountId, null);
});

test('of two loans the one whose payment matches is chosen, then the one named like the merchant', () => {
  const byAmount = newState();
  addLoan(byAmount);
  addLoan(byAmount, { id: 'acc_car', name: 'Car loan', loan: { payment: 31500, assumeScheduled: false } });
  loanPayments(byAmount, 31500);
  detectRecurring(byAmount, NOW);
  assert.equal(byAmount.recurring[0].toAccountId, 'acc_car');

  const byName = newState();
  addLoan(byName, { loan: null });
  addLoan(byName, { id: 'acc_car', name: 'Car loan', institution: 'Tidewater Lending', loan: null });
  loanPayments(byName);
  detectRecurring(byName, NOW);
  assert.equal(byName.recurring[0].toAccountId, 'acc_car');

  const unclear = newState();
  addLoan(unclear, { loan: null });
  addLoan(unclear, { id: 'acc_car', name: 'Car loan', loan: null });
  loanPayments(unclear);
  detectRecurring(unclear, NOW);
  assert.equal(unclear.recurring[0].toAccountId, null);
});

test('an ordinary subscription is never tied to a loan', () => {
  const state = newState();
  addLoan(state);
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 24000, 'Studio Share', { category: 'housing' });
  detectRecurring(state, NOW);
  assert.equal(state.recurring[0].toAccountId, null);
});

/* ------------------------------------------- the Book: keeping entries in step */

test('a price change at a fixed price takes effect with its first charge and is reported once', () => {
  const state = newState();
  for (const day of monthly('2026-01-12', 4)) charge(state, day, 1549, 'Streamly');
  const early = at(2026, 4, 17);
  detectRecurring(state, early);
  const [entry] = state.recurring;

  charge(state, '2026-05-12', 1799, 'Streamly');
  const report = detectRecurring(state, at(2026, 5, 17));
  assert.deepEqual(report, { added: [], repriced: [{ id: entry.id, from: 1549, to: 1799 }], lapsed: [] });
  assert.equal(entry.amount, 1799);
  assert.equal(entry.anchor, '2026-05-12');

  charge(state, '2026-06-12', 1799, 'Streamly');
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
  assert.equal(entry.amount, 1799);
  assert.equal(entry.variable, false);
  assert.ok(state.txs.every((tx) => tx.recurringId === entry.id));
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('a variable bill moving is not a price change', () => {
  const state = newState();
  const bills = [['2026-01-03', 8420], ['2026-02-04', 10110], ['2026-03-05', 9230], ['2026-04-05', 7680]];
  for (const [day, amount] of bills) charge(state, day, amount, 'City Power', { category: 'utilities' });
  detectRecurring(state, at(2026, 4, 17));
  assert.equal(state.recurring[0].amount, 9230);

  charge(state, '2026-05-04', 9890, 'City Power', { category: 'utilities' });
  charge(state, '2026-06-03', 12400, 'City Power', { category: 'utilities' });
  const report = detectRecurring(state, NOW);

  assert.deepEqual(report, NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
  assert.equal(state.recurring[0].amount, 9890);
  assert.equal(state.recurring[0].variable, true);
});

test('a utility that swings with the seasons stays one bill all year and never lapses', () => {
  const state = newState();
  const amounts = [6200, 6900, 8300, 10400, 13100, 16800, 17400, 14200, 11000, 8600, 7100, 6400, 6000, 6700];
  const days = monthly('2025-05-04', 14);
  const seen = new Set();
  days.forEach((day, i) => {
    charge(state, day, amounts[i], 'City Power', { accountId: CHECKING, category: 'utilities' });
    const report = detectRecurring(state, at(...addDays(day, 5).split('-').map(Number)));
    assert.deepEqual(report.lapsed, [], day);
    for (const id of report.added) seen.add(id);
  });

  assert.equal(state.recurring.length, 1);
  assert.equal(seen.size, 1);
  const [entry] = state.recurring;
  assert.equal(entry.variable, true);
  assert.equal(entry.active, true);
  assert.equal(entry.anchor, '2026-06-04');
  assert.equal(entry.amount, 6400);
  assert.ok(state.txs.every((tx) => tx.recurringId === entry.id));
});

test('two like amounts a quarter apart among irregular visits are not split off as a bill', () => {
  const state = newState();
  const visits = [['2026-01-03', 8420], ['2026-02-14', 10110], ['2026-03-02', 9230], ['2026-04-05', 7680], ['2026-05-27', 15100]];
  for (const [day, amount] of visits) charge(state, day, amount, 'Tool Library', { category: 'household' });
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 0);
});

test('an entry not charged for a period and a half lapses, once', () => {
  const state = newState();
  for (const day of monthly('2026-01-12', 3)) charge(state, day, 1299, 'Paper Trail');
  assert.equal(detectRecurring(state, at(2026, 3, 20)).added.length, 1);
  const [entry] = state.recurring;
  assert.equal(entry.active, true);

  // 45 days after the last charge it is still within a period and a half; 46 days after it is not.
  assert.deepEqual(detectRecurring(state, at(2026, 4, 26)), NOTHING_RECURRING);
  assert.equal(entry.active, true);
  assert.deepEqual(detectRecurring(state, at(2026, 4, 27)), { added: [], repriced: [], lapsed: [entry.id] });
  assert.equal(entry.active, false);
  assert.ok(state.txs.every((tx) => tx.recurringId === entry.id));

  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(entry.active, false);
  assert.equal(state.recurring.length, 1);
});

test('a lapsed entry returns when it is charged again', () => {
  const state = newState();
  for (const day of monthly('2026-01-12', 3)) charge(state, day, 1299, 'Paper Trail');
  detectRecurring(state, at(2026, 3, 20));
  detectRecurring(state, at(2026, 5, 20));
  const [entry] = state.recurring;
  assert.equal(entry.active, false);

  const resumed = charge(state, '2026-06-14', 1299, 'Paper Trail');
  const report = detectRecurring(state, NOW);

  assert.deepEqual(report, { added: [entry.id], repriced: [], lapsed: [] });
  assert.equal(entry.active, true);
  assert.equal(entry.anchor, '2026-06-14');
  assert.equal(resumed.recurringId, entry.id);
  assert.equal(resumed.klass, 'book');
  assert.equal(state.recurring.length, 1);
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('a pattern that had already ended when first seen is recorded as ended, without a note', () => {
  const state = newState();
  for (const day of monthly('2025-09-12', 4)) charge(state, day, 1299, 'Paper Trail');

  const report = detectRecurring(state, NOW);

  assert.deepEqual(report, NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
  assert.equal(state.recurring[0].active, false);
  assert.equal(state.recurring[0].anchor, '2025-12-12');
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
});

test('fields the owner locked survive, and the rest keep following the feed', () => {
  const state = newState();
  for (const day of monthly('2026-02-12', 4)) charge(state, day, 1549, 'Streamly');
  detectRecurring(state, at(2026, 5, 17));
  const [entry] = state.recurring;
  Object.assign(entry, {
    name: 'Film night', amount: 2000, category: 'entertainment', purpose: 'studio', cadence: 'quarterly',
    essential: true, verdict: 'keep', note: 'shared with the flat',
    locks: ['name', 'amount', 'category', 'purpose', 'cadence'],
  });

  const latest = charge(state, '2026-06-12', 1799, 'Streamly');
  const report = detectRecurring(state, NOW);

  assert.deepEqual(report, NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
  assert.equal(entry.name, 'Film night');
  assert.equal(entry.amount, 2000);
  assert.equal(entry.category, 'entertainment');
  assert.equal(entry.purpose, 'studio');
  assert.equal(entry.cadence, 'quarterly');
  assert.equal(entry.essential, true);
  assert.equal(entry.verdict, 'keep');
  assert.equal(entry.note, 'shared with the flat');
  assert.deepEqual(entry.locks, ['name', 'amount', 'category', 'purpose', 'cadence']);
  assert.equal(entry.anchor, '2026-06-12');
  assert.equal(latest.recurringId, entry.id);
});

test('a locked anchor, variable flag and debt are left alone too', () => {
  const state = newState();
  addLoan(state);
  loanPayments(state);
  detectRecurring(state, NOW);
  const [entry] = state.recurring;
  Object.assign(entry, { anchor: '2026-06-01', variable: true, toAccountId: null, locks: ['anchor', 'variable', 'toAccountId'] });

  detectRecurring(state, NOW);

  assert.equal(entry.anchor, '2026-06-01');
  assert.equal(entry.variable, true);
  assert.equal(entry.toAccountId, null);
});

test('a class the owner set on a charge survives its linking', () => {
  const state = newState();
  const rows = monthly('2026-03-12', 4).map((day) => charge(state, day, 1549, 'Streamly'));
  Object.assign(rows[1], { klass: 'want', locks: ['klass'] });

  detectRecurring(state, NOW);

  assert.equal(rows[1].recurringId, state.recurring[0].id);
  assert.equal(rows[1].klass, 'want');
  assert.equal(rows[0].klass, 'book');
});

test('an entry the owner dismissed stays dismissed and is not created again', () => {
  const state = newState();
  for (const day of monthly('2026-02-12', 4)) charge(state, day, 2900, 'Pixel Forge', { category: 'software' });
  detectRecurring(state, at(2026, 5, 17));
  const [entry] = state.recurring;
  assert.ok(state.txs.every((tx) => tx.klass === 'book'));
  Object.assign(entry, { active: false, locks: ['active'] });
  const dismissed = snapshot(entry);

  charge(state, '2026-06-12', 2900, 'Pixel Forge', { category: 'software' });
  const report = detectRecurring(state, NOW);

  assert.deepEqual(report, NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
  assert.deepEqual(entry, dismissed);
  for (const tx of state.txs) {
    assert.equal(tx.recurringId, null);
    assert.equal(tx.klass, 'oneoff');
  }
  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
});

test('an entry the owner pinned as active never lapses', () => {
  const state = newState();
  for (const day of monthly('2025-09-12', 4)) charge(state, day, 1299, 'Paper Trail');
  state.recurring.push(makeRecurring({
    id: 'rec_pinned', name: 'Paper Trail', mkey: 'paper trail', accountId: CARD, amount: 1299,
    cadence: 'monthly', anchor: '2025-12-12', active: true, locks: ['active'],
  }));

  assert.deepEqual(detectRecurring(state, NOW), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
  assert.equal(state.recurring[0].active, true);
});

test('an entry the owner made by hand takes the charges near its amount', () => {
  const state = newState();
  state.recurring.push(makeRecurring({
    id: 'rec_rent', name: 'Workspace rent', mkey: 'blue heron', accountId: null, amount: 120000,
    cadence: 'monthly', anchor: '2026-05-01', category: 'housing', source: 'manual', confidence: 0,
  }));
  const rent = charge(state, '2026-06-01', 120000, 'Blue Heron', { accountId: CHECKING, category: 'housing' });
  const sundry = charge(state, '2026-06-09', 2500, 'Blue Heron', { accountId: CHECKING, category: 'housing' });

  const report = detectRecurring(state, NOW);

  assert.deepEqual(report, NOTHING_RECURRING);
  assert.equal(state.recurring.length, 1);
  const [entry] = state.recurring;
  assert.equal(rent.recurringId, 'rec_rent');
  assert.equal(rent.klass, 'book');
  assert.equal(sundry.recurringId, null);
  assert.equal(entry.anchor, '2026-06-01');
  assert.equal(entry.amount, 120000);
  assert.equal(entry.source, 'manual');
  assert.equal(entry.confidence, 0);
  assert.equal(entry.active, true);
});

test('a charge that no longer belongs to an entry is unlinked and takes its own class back', () => {
  const state = newState();
  const rows = monthly('2026-03-12', 4).map((day) => charge(state, day, 3900, 'Pixel Forge', { category: 'software' }));
  detectRecurring(state, NOW);
  const [entry] = state.recurring;

  // The owner corrects one row: it was a different merchant all along.
  Object.assign(rows[0], { mkey: 'pixel foundry', merchant: 'Pixel Foundry' });
  detectRecurring(state, NOW);

  assert.equal(rows[0].recurringId, null);
  assert.equal(rows[0].klass, 'oneoff');
  assert.equal(rows[3].recurringId, entry.id);
  assert.equal(state.recurring.length, 1);
});

/* ---------------------------------------------------------------- income streams */

test('a paycheck every two weeks is a salary stream that accrues', () => {
  const state = newState();
  const amounts = [189500, 190000, 191200, 190000, 188700, 190400];
  const rows = everyDays('2026-04-03', 14, 6).map((day, i) => deposit(state, day, amounts[i], 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' }));

  const report = detectStreams(state, NOW);

  assert.equal(state.streams.length, 1);
  const [stream] = state.streams;
  assert.deepEqual(report, { added: [stream.id], updated: [] });
  assert.equal(stream.name, 'Northwind Logistics');
  assert.equal(stream.mkey, 'northwind logistics');
  assert.equal(stream.kind, 'salary');
  assert.equal(stream.accountId, CHECKING);
  assert.equal(stream.cadence, 'biweekly');
  assert.equal(stream.anchor, '2026-06-12');
  assert.equal(stream.amount, 190000);
  assert.equal(stream.accrue, true);
  assert.equal(stream.active, true);
  assert.equal(stream.source, 'detected');
  assert.ok(stream.confidence > 0 && stream.confidence <= 1);
  assert.ok(rows.every((tx) => tx.streamId === stream.id));
});

test('a paycheck on the 15th and the last day of the month is twice-monthly, not fortnightly', () => {
  const state = newState();
  const days = ['2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15', '2026-04-30', '2026-05-15', '2026-05-31', '2026-06-15'];
  for (const day of days) deposit(state, day, 242500, 'Lantern Press', { raw: 'LANTERN PRESS DIRECT DEP' });

  detectStreams(state, NOW);

  const [stream] = state.streams;
  assert.equal(stream.cadence, 'semimonthly');
  assert.equal(stream.kind, 'salary');
  assert.equal(stream.accrue, true);
  assert.equal(stream.anchor, '2026-06-15');
  assert.equal(stream.amount, 242500);
});

test('a paycheck on the 1st and the 15th is twice-monthly as well', () => {
  const state = newState();
  const days = ['2026-03-01', '2026-03-15', '2026-04-01', '2026-04-15', '2026-05-01', '2026-05-15', '2026-06-01', '2026-06-15'];
  for (const day of days) deposit(state, day, 242500, 'Lantern Press', { raw: 'LANTERN PRESS SALARY' });
  detectStreams(state, NOW);
  assert.equal(state.streams[0].cadence, 'semimonthly');
  assert.equal(state.streams[0].accrue, true);
});

test('weekly and monthly pay are recognised from three deposits', () => {
  const state = newState();
  for (const day of everyDays('2026-05-29', 7, 3)) deposit(state, day, 64000, 'Dockside Cafe', { raw: 'DOCKSIDE CAFE PAYROLL' });
  for (const day of monthly('2026-04-01', 3)) deposit(state, day, 310000, 'Quarry Works', { raw: 'ACH CREDIT QUARRY WORKS' });

  detectStreams(state, NOW);

  const weekly = state.streams.find((stream) => stream.mkey === 'dockside cafe');
  const monthlyPay = state.streams.find((stream) => stream.mkey === 'quarry works');
  assert.equal(weekly.cadence, 'weekly');
  assert.equal(weekly.accrue, true);
  assert.equal(monthlyPay.cadence, 'monthly');
  assert.equal(monthlyPay.kind, 'salary');
  assert.equal(monthlyPay.accrue, true);
});

test('two regular deposits are not yet a salary', () => {
  const state = newState();
  for (const day of everyDays('2026-05-29', 14, 2)) deposit(state, day, 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });

  detectStreams(state, NOW);

  const [stream] = state.streams;
  assert.equal(stream.accrue, false);
  assert.equal(stream.cadence, null);
  assert.equal(stream.kind, 'salary');
});

test('a bonus among steady paychecks does not stop the stream accruing or move its amount', () => {
  const state = newState();
  const amounts = [190000, 190000, 190000, 190000, 440000, 190000, 190000, 190000];
  everyDays('2026-03-06', 14, 8).forEach((day, i) => deposit(state, day, amounts[i], 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' }));

  detectStreams(state, NOW);

  assert.equal(state.streams[0].accrue, true);
  assert.equal(state.streams[0].amount, 190000);
});

test('regular deposits whose amounts swing do not accrue', () => {
  const state = newState();
  const amounts = [52000, 131000, 78000, 204000, 96000, 160000];
  everyDays('2026-04-03', 14, 6).forEach((day, i) => deposit(state, day, amounts[i], 'Gig Harbor', { raw: 'GIG HARBOR PAYOUT' }));

  detectStreams(state, NOW);

  const [stream] = state.streams;
  assert.equal(stream.accrue, false);
  assert.equal(stream.cadence, 'biweekly');
  assert.equal(stream.kind, 'other');
});

test('other payers seen twice are streams that count when they arrive; a single deposit stays unlinked', () => {
  const state = newState();
  const client = [deposit(state, '2026-04-22', 8000, 'Marlow Pike', { purpose: 'coaching' }), deposit(state, '2026-06-02', 12000, 'Marlow Pike', { purpose: 'coaching' })];
  const shop = [deposit(state, '2026-03-09', 4100, 'Print Counter', { purpose: 'studio' }), deposit(state, '2026-05-30', 6600, 'Print Counter', { purpose: 'studio' })];
  const gift = deposit(state, '2026-05-11', 5000, 'Aunt Odile');

  const report = detectStreams(state, NOW);

  assert.equal(state.streams.length, 2);
  assert.equal(report.added.length, 2);
  const lessons = state.streams.find((stream) => stream.mkey === 'marlow pike');
  const studio = state.streams.find((stream) => stream.mkey === 'print counter');
  assert.equal(lessons.accrue, false);
  assert.equal(lessons.cadence, null);
  assert.equal(lessons.kind, 'lessons');
  assert.equal(lessons.anchor, '2026-06-02');
  assert.equal(lessons.amount, 10000);
  assert.equal(studio.kind, 'creative');
  assert.ok(client.every((tx) => tx.streamId === lessons.id));
  assert.ok(shop.every((tx) => tx.streamId === studio.id));
  assert.equal(gift.streamId, null);
});

test('small regular credits such as interest are a stream but never accrue as pay', () => {
  const state = newState();
  const amounts = [310, 312, 309, 311];
  monthly('2026-02-28', 4).forEach((day, i) => deposit(state, day, amounts[i], 'Interest earned', { accountId: SAVINGS, raw: 'INTEREST PAID' }));

  detectStreams(state, NOW);

  const [stream] = state.streams;
  assert.equal(stream.accrue, false);
  assert.equal(stream.kind, 'other');
  assert.equal(stream.cadence, 'monthly');
});

test('refunds, transfers and paired legs are not deposits', () => {
  const state = newState();
  for (const day of everyDays('2026-04-03', 14, 6)) movePair(state, day, 50000, { from: SAVINGS, to: CHECKING, kind: 'transfer' });
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly', { flow: 'in', kind: 'refund' });
  for (const day of everyDays('2026-04-03', 14, 6)) deposit(state, day, 50000, 'Own Savings', { pairId: 'tx_other_leg' });

  assert.deepEqual(detectStreams(state, NOW), NOTHING_STREAMS);
  assert.equal(state.streams.length, 0);
  assert.ok(state.txs.every((tx) => tx.streamId === null));
});

test('a stream follows new deposits and reports that it changed', () => {
  const state = newState();
  for (const day of everyDays('2026-04-03', 14, 5)) deposit(state, day, 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  detectStreams(state, at(2026, 6, 3));
  const [stream] = state.streams;
  assert.equal(stream.anchor, '2026-05-29');
  assert.deepEqual(detectStreams(state, at(2026, 6, 3)), NOTHING_STREAMS);

  const latest = deposit(state, '2026-06-12', 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  const report = detectStreams(state, NOW);

  assert.deepEqual(report, { added: [], updated: [stream.id] });
  assert.equal(state.streams.length, 1);
  assert.equal(stream.anchor, '2026-06-12');
  assert.equal(latest.streamId, stream.id);
});

test('locked stream fields survive: a salary the owner switched to count on arrival stays that way', () => {
  const state = newState();
  for (const day of everyDays('2026-04-03', 14, 5)) deposit(state, day, 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  detectStreams(state, at(2026, 6, 3));
  const [stream] = state.streams;
  Object.assign(stream, { accrue: false, name: 'Day job', amount: 200000, kind: 'other', locks: ['accrue', 'name', 'amount', 'kind'] });

  deposit(state, '2026-06-12', 191000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  detectStreams(state, NOW);

  assert.equal(stream.accrue, false);
  assert.equal(stream.name, 'Day job');
  assert.equal(stream.amount, 200000);
  assert.equal(stream.kind, 'other');
  assert.equal(stream.anchor, '2026-06-12');
  assert.equal(state.streams.length, 1);
});

test('a dismissed stream stays dismissed and takes no deposits', () => {
  const state = newState();
  for (const day of everyDays('2026-04-03', 14, 5)) deposit(state, day, 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  detectStreams(state, at(2026, 6, 3));
  const [stream] = state.streams;
  Object.assign(stream, { active: false, locks: ['active'] });
  const dismissed = snapshot(stream);

  deposit(state, '2026-06-12', 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  const report = detectStreams(state, NOW);

  assert.deepEqual(report, NOTHING_STREAMS);
  assert.equal(state.streams.length, 1);
  assert.deepEqual(stream, dismissed);
  assert.ok(state.txs.every((tx) => tx.streamId === null));
});

test('pay that stops is taken as ended after two missed periods, and returns with the next deposit', () => {
  const state = newState();
  for (const day of everyDays('2026-02-06', 14, 5)) deposit(state, day, 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  detectStreams(state, at(2026, 4, 8));
  const [stream] = state.streams;
  assert.equal(stream.active, true);

  // The last deposit was 3 April: 28 days on it is late, 29 days on it has ended.
  assert.deepEqual(detectStreams(state, at(2026, 5, 1)), NOTHING_STREAMS);
  assert.deepEqual(detectStreams(state, at(2026, 5, 2)), { added: [], updated: [stream.id] });
  assert.equal(stream.active, false);
  assert.deepEqual(detectStreams(state, at(2026, 5, 20)), NOTHING_STREAMS);

  deposit(state, '2026-06-12', 190000, 'Northwind Logistics', { raw: 'NORTHWIND LOGISTICS PAYROLL' });
  assert.deepEqual(detectStreams(state, NOW), { added: [], updated: [stream.id] });
  assert.equal(stream.active, true);
  assert.equal(state.streams.length, 1);
});

test('a stream the owner made by hand is fed by its deposits and never switched off', () => {
  const state = newState();
  state.streams.push(makeStream({
    id: 'str_own', name: 'Workshop fees', mkey: 'lantern hall', kind: 'lessons', cadence: 'monthly', anchor: '2026-01-10',
    amount: 45000, accrue: false, source: 'manual', locks: ['name', 'kind', 'cadence', 'amount', 'accrue'],
  }));
  const fees = [deposit(state, '2026-01-10', 45000, 'Lantern Hall'), deposit(state, '2026-02-10', 45000, 'Lantern Hall')];

  const report = detectStreams(state, NOW);

  assert.deepEqual(report, { added: [], updated: ['str_own'] });
  assert.equal(state.streams.length, 1);
  const [stream] = state.streams;
  assert.equal(stream.active, true);
  assert.equal(stream.anchor, '2026-02-10');
  assert.equal(stream.accountId, null);
  assert.equal(stream.confidence, 0);
  assert.equal(stream.source, 'manual');
  assert.ok(fees.every((tx) => tx.streamId === 'str_own'));
  assert.deepEqual(detectStreams(state, NOW), NOTHING_STREAMS);
});

test('a linked deposit leaves the review queue', () => {
  const state = newState();
  const rows = everyDays('2026-04-03', 14, 6).map((day) => deposit(state, day, 190000, 'Harborview Studios', { review: true }));
  detectStreams(state, NOW);
  assert.equal(state.streams[0].accrue, true);
  assert.ok(rows.every((tx) => tx.review === false));
});

/* ------------------------------------------------------------------------- habit */

/** Four weeks from Monday 1 June 2026: a cheap coffee most workdays, a blow-out every Friday, brunch at weekends. */
function skewedHistory() {
  const state = newState(at(2026, 7, 1));
  for (const day of everyDays('2026-06-01', 1, 28)) {
    const weekday = new Date(at(...day.split('-').map(Number))).getDay();
    if (weekday === 0 || weekday === 6) coffee(state, day, 1200, { category: 'eating_out' });
    else if (weekday === 5) coffee(state, day, 3400, { category: 'delivery' });
    else coffee(state, day, 400);
  }
  return state;
}

test('habit is the mean per kind of day, and a skewed history pulls the win line off half', () => {
  const state = skewedHistory();

  const segment = computeHabit(state, '2026-06-01', '2026-06-28');

  // Workdays: sixteen at $4 and four at $34 average $10. A $5 line would win sixteen rounds in twenty
  // (80%); at $3 the same sixteen are draws, which scores 8/20 = 40% exactly.
  assert.deepEqual(segment, {
    work: 1000,
    off: 1200,
    winWork: 300,
    winOff: 600,
    basis: 'computed',
    window: { from: '2026-06-01', to: '2026-06-28', workDays: 20, offDays: 8 },
    backtest: { score: 12, rounds: 28 },
  });
});

test('the recorded backtest is what the ledger scores those days under the segment', () => {
  const state = skewedHistory();
  const segment = computeHabit(state, '2026-06-01', '2026-06-28');
  state.habits.push({ from: '2026-06-01', ...segment });
  state.meta.matchStart = '2026-06-01';

  const played = everyDays('2026-06-01', 1, 28).map((day) => round(state, day, at(2026, 7, 1)));

  // Twelve points from twenty-eight rounds: sixteen workday draws, eight weekend draws, four losses.
  assert.equal(played.reduce((score, one) => score + one.result, 0), segment.backtest.score);
  assert.equal(played.filter((one) => one.result === 0).length, 4);
  assert.equal(played.reduce((kept, one) => kept + one.kept, 0), 0);
});

test('refunds and several stops in a day are netted before averaging', () => {
  const state = skewedHistory();
  coffee(state, '2026-06-02', 600);
  coffee(state, '2026-06-02', 200, { flow: 'in', kind: 'refund' });
  charge(state, '2026-06-02', 5000, 'Green Grocer', { category: 'groceries' });

  const segment = computeHabit(state, '2026-06-01', '2026-06-28');

  // Tuesday 2 June now holds $4 + $6 − $2 = $8 of stops; groceries are not part of the game.
  assert.equal(segment.work, 1020);
});

test('the win line moves up when half of habit would already be lost', () => {
  const state = newState(at(2026, 7, 1));
  const workdays = everyDays('2026-06-01', 1, 14).filter((day, i) => i % 7 < 5);
  workdays.forEach((day, i) => coffee(state, day, i < 4 ? 700 : 1100));

  const segment = computeHabit(state, '2026-06-01', '2026-06-14');

  // Habit $9.40, loss line $10. At $5 nothing wins and four draw (20%); at $7 four win (40%).
  assert.equal(segment.work, 940);
  assert.equal(segment.winWork, 700);
  assert.equal(segment.off, 0);
  assert.equal(segment.winOff, 0);
  assert.deepEqual(segment.backtest, { score: 8, rounds: 14 });
  assert.deepEqual(segment.window, { from: '2026-06-01', to: '2026-06-14', workDays: 10, offDays: 4 });
});

test('the win line stays within 25% to 75% of habit, in whole dollars', () => {
  const always = newState(at(2026, 7, 1));
  for (const day of everyDays('2026-06-01', 1, 28)) coffee(always, day, 2000);
  const steady = computeHabit(always, '2026-06-01', '2026-06-28');
  // Every day is the same $20: no line can win a round, every round is a draw, so the line stays at half.
  assert.equal(steady.work, 2000);
  assert.equal(steady.winWork, 1000);
  assert.equal(steady.winOff, 1000);
  assert.deepEqual(steady.backtest, { score: 14, rounds: 28 });

  const rare = newState(at(2026, 7, 1));
  coffee(rare, '2026-06-01', 100);
  coffee(rare, '2026-06-10', 9000);
  const lumpy = computeHabit(rare, '2026-06-01', '2026-06-28');
  // Almost every workday is free: the score is far above 40% at any line, so the line goes as low as it may.
  assert.equal(lumpy.work, 455);
  assert.equal(lumpy.winWork, 200);
  assert.ok(lumpy.winWork >= 0.25 * lumpy.work && lumpy.winWork <= 0.75 * lumpy.work);
  assert.equal(lumpy.winWork % 100, 0);
});

test('a day the owner marked and a declared bye are read as the ledger reads them', () => {
  const state = skewedHistory();
  state.days['2026-06-06'] = { type: 'work' };
  state.days['2026-06-05'] = { bye: true };

  const segment = computeHabit(state, '2026-06-01', '2026-06-28');

  // Saturday 6 June ($12) joins the workdays: (16 × 4 + 4 × 34 + 12) / 21 = $10.10.
  assert.equal(segment.window.workDays, 21);
  assert.equal(segment.window.offDays, 7);
  assert.equal(segment.work, 1010);
  assert.equal(segment.off, 1200);
  assert.equal(segment.winWork, 300);
  // Friday 5 June was a loss; as a bye it scores a half, which makes up for the weekend draw that left.
  assert.deepEqual(segment.backtest, { score: 12, rounds: 28 });
});

test('the window is limited to the history there is, and under 14 days gives nothing', () => {
  const state = skewedHistory();
  assert.deepEqual(computeHabit(state, '2026-04-01', '2026-06-28').window, { from: '2026-06-01', to: '2026-06-28', workDays: 20, offDays: 8 });
  assert.equal(computeHabit(state, '2026-06-01', '2026-06-13'), null);
  assert.notEqual(computeHabit(state, '2026-06-01', '2026-06-14'), null);
  assert.equal(computeHabit(state, '2026-06-20', '2026-06-28'), null);
  assert.equal(computeHabit(state, '2026-06-28', '2026-06-01'), null);
  assert.equal(computeHabit(newState(), '2026-04-01', '2026-06-16'), null);
});

test('history with no stops at all gives a habit of nothing rather than an error', () => {
  const state = newState();
  charge(state, '2026-05-01', 5000, 'Green Grocer', { category: 'groceries' });

  const segment = computeHabit(state, '2026-05-01', '2026-06-16');

  assert.equal(segment.work, 0);
  assert.equal(segment.off, 0);
  assert.equal(segment.winWork, 0);
  assert.equal(segment.winOff, 0);
  assert.equal(segment.backtest.rounds, 47);
  assert.equal(segment.backtest.score, 47);
});

test('moves the owner tapped in are not bank history', () => {
  const state = newState();
  for (const day of everyDays('2026-05-01', 1, 30)) coffee(state, day, 500, { source: 'manual' });
  assert.equal(computeHabit(state, '2026-05-01', '2026-06-16'), null);
});

/* ------------------------------------------------------------------- startMatch */

test('the match starts today with a first segment from the days before it', () => {
  const state = newState();
  for (const day of everyDays('2026-05-01', 1, 47)) coffee(state, day, 600);

  assert.equal(startMatch(state, NOW), true);

  assert.equal(state.meta.matchStart, TODAY);
  assert.equal(state.habits.length, 1);
  const [segment] = state.habits;
  assert.equal(segment.from, TODAY);
  assert.equal(segment.basis, 'computed');
  assert.equal(segment.work, 600);
  assert.equal(segment.off, 600);
  assert.equal(segment.winWork, 300);
  assert.deepEqual(segment.window, { from: '2026-05-01', to: '2026-06-16', workDays: 33, offDays: 14 });
  assert.equal(segment.backtest.rounds, 47);

  assert.equal(startMatch(state, NOW), false);
  assert.equal(state.habits.length, 1);
});

test('the first segment looks back 60 days at most', () => {
  const state = newState();
  for (const day of everyDays('2026-01-05', 1, 163)) coffee(state, day, 600);
  startMatch(state, NOW);
  assert.deepEqual(state.habits[0].window, { from: '2026-04-18', to: '2026-06-16', workDays: 42, offDays: 18 });
});

test('with too little history the match waits', () => {
  const state = newState();
  for (const day of everyDays('2026-06-04', 1, 13)) coffee(state, day, 600);

  assert.equal(startMatch(state, NOW), false);
  assert.equal(state.meta.matchStart, null);
  assert.deepEqual(state.habits, []);

  // One more day of history and it starts.
  assert.equal(startMatch(state, at(2026, 6, 18)), true);
  assert.equal(state.meta.matchStart, '2026-06-18');
});

test('before the rollover hour the match starts on the game day still being played', () => {
  const state = newState();
  for (const day of everyDays('2026-05-01', 1, 47)) coffee(state, day, 600);
  startMatch(state, at(2026, 6, 18, 2));
  assert.equal(state.meta.matchStart, TODAY);
});

test('a match that has started is never restarted', () => {
  const state = newState();
  for (const day of everyDays('2026-05-01', 1, 47)) coffee(state, day, 600);
  state.meta.matchStart = '2026-06-01';
  assert.equal(startMatch(state, NOW), false);
  assert.equal(state.meta.matchStart, '2026-06-01');
  assert.deepEqual(state.habits, []);
});

/* ----------------------------------------------------------------------- sweeps */

/**
 * A match begun on Monday 1 June against a $10 workday / $12 day-off habit. In the week of 8 June
 * the only stop is a $4 coffee, so the week kept $6 + 4 × $10 + 2 × $12 = $70.
 */
function sweepState(nowMs = NOW) {
  const state = newState(nowMs);
  state.meta.matchStart = '2026-06-01';
  state.habits.push({ from: '2026-06-01', work: 1000, off: 1200, winWork: 500, winOff: 600, basis: 'manual', window: null, backtest: null });
  coffee(state, '2026-06-08', 400);
  return state;
}

test('the fixture offers a $70 sweep to the card', () => {
  assert.deepEqual(edge(sweepState(), NOW).sweep, { weekOf: '2026-06-08', amount: 7000, target: 'card' });
});

test('a card payment in the week after is recorded as the sweep, by itself', () => {
  const state = sweepState();
  const { out } = movePair(state, '2026-06-16', 7000);

  assert.equal(detectSweeps(state, NOW), 1);

  assert.deepEqual(state.sweeps, [{ weekOf: '2026-06-08', amount: 7000, day: '2026-06-16', txId: out.id, via: 'auto' }]);
  assert.equal(edge(state, NOW).sweep, null);
  assert.equal(edge(state, NOW).moved, 7000);
  assert.equal(detectSweeps(state, NOW), 0);
  assert.equal(state.sweeps.length, 1);
});

test('90% of the offer is enough; less is not', () => {
  const enough = sweepState();
  movePair(enough, '2026-06-15', 6300);
  assert.equal(detectSweeps(enough, NOW), 1);
  assert.equal(enough.sweeps[0].amount, 7000);
  assert.equal(enough.sweeps[0].day, '2026-06-15');

  const short = sweepState();
  movePair(short, '2026-06-15', 6299);
  assert.equal(detectSweeps(short, NOW), 0);
  assert.deepEqual(short.sweeps, []);
});

test('a transfer into the reserve counts; one out of it, or between everyday accounts, does not', () => {
  const saved = sweepState();
  const { out } = movePair(saved, '2026-06-16', 7000, { to: SAVINGS, kind: 'transfer' });
  assert.equal(detectSweeps(saved, NOW), 1);
  assert.equal(saved.sweeps[0].txId, out.id);

  const withdrawn = sweepState();
  movePair(withdrawn, '2026-06-16', 7000, { from: SAVINGS, to: CHECKING, kind: 'transfer' });
  assert.equal(detectSweeps(withdrawn, NOW), 0);

  const sideways = sweepState();
  sideways.accounts.push(makeAccount({ id: 'acc_second', source: 'bank', type: 'checking', name: 'Bills Checking', asOf: NOW - HOUR_MS }));
  movePair(sideways, '2026-06-16', 7000, { to: 'acc_second', kind: 'transfer' });
  assert.equal(detectSweeps(sideways, NOW), 0);
});

test('a payment seen only on the card side still counts', () => {
  const state = sweepState();
  const received = addRow(state, { accountId: CARD, day: '2026-06-16', amount: 7500, flow: 'in', kind: 'payment', category: 'card_payment', merchant: 'Payment received', mkey: 'payment received' });
  assert.equal(detectSweeps(state, NOW), 1);
  assert.equal(state.sweeps[0].txId, received.id);
});

test('moves outside the 7 days, pending moves, Book payments, purchases and refunds are not sweeps', () => {
  // Sunday the 14th is still inside the week being rewarded (and no earlier week was played).
  const during = sweepState();
  during.meta.matchStart = '2026-06-08';
  movePair(during, '2026-06-14', 7000);
  assert.equal(detectSweeps(during, NOW), 0);

  const pending = sweepState();
  movePair(pending, '2026-06-16', 7000, { extra: { pending: true, postedDay: null } });
  assert.equal(detectSweeps(pending, NOW), 0);

  const standing = sweepState();
  standing.recurring.push(makeRecurring({ id: 'rec_autopay', name: 'Card autopay', mkey: 'card payment', accountId: CHECKING, amount: 7000, anchor: '2026-06-16' }));
  movePair(standing, '2026-06-16', 7000).out.recurringId = 'rec_autopay';
  assert.equal(detectSweeps(standing, NOW), 0);

  const purchases = sweepState();
  charge(purchases, '2026-06-16', 7000, 'Gadget Barn', { category: 'shopping' });
  charge(purchases, '2026-06-16', 7000, 'Gadget Barn', { category: 'shopping', flow: 'in', kind: 'refund' });
  deposit(purchases, '2026-06-16', 7000, 'Marlow Pike');
  assert.equal(detectSweeps(purchases, NOW), 0);
});

test('a week already swept by a tap, a week under $5 and a match not yet begun record nothing', () => {
  const tapped = sweepState();
  tapped.sweeps.push({ weekOf: '2026-06-08', amount: 7000, day: '2026-06-15', txId: null, via: 'tap' });
  movePair(tapped, '2026-06-16', 7000);
  assert.equal(detectSweeps(tapped, NOW), 0);
  assert.equal(tapped.sweeps.length, 1);

  const lean = sweepState();
  for (const day of everyDays('2026-06-08', 1, 7)) coffee(lean, day, 1100);
  movePair(lean, '2026-06-16', 7000);
  assert.equal(edge(lean, NOW).sweep, null);
  assert.equal(detectSweeps(lean, NOW), 0);

  const unstarted = sweepState();
  unstarted.meta.matchStart = null;
  movePair(unstarted, '2026-06-16', 7000);
  assert.equal(detectSweeps(unstarted, NOW), 0);
});

test('one move settles one week, and a week missed while the app was closed is still found', () => {
  const later = at(2026, 6, 24);
  const state = sweepState(later);
  const first = movePair(state, '2026-06-16', 7000).out;
  // The week of 15 June kept 5 × $10 + 2 × $12 = $74; the payment of the 23rd covers it.
  const second = movePair(state, '2026-06-23', 7400).out;

  assert.equal(detectSweeps(state, later), 2);

  assert.deepEqual(state.sweeps, [
    { weekOf: '2026-06-08', amount: 7000, day: '2026-06-16', txId: first.id, via: 'auto' },
    { weekOf: '2026-06-15', amount: 7400, day: '2026-06-23', txId: second.id, via: 'auto' },
  ]);
  assert.equal(detectSweeps(state, later), 0);
});

test('a sweep made up to a sync window ago is still found; further back is left alone', () => {
  const state = sweepState(at(2026, 9, 9));
  const paid = movePair(state, '2026-06-16', 7000).out;

  // Wednesday 9 September: the week of 8 June is the thirteenth completed week back.
  assert.equal(detectSweeps(state, at(2026, 9, 9)), 1);
  assert.deepEqual(state.sweeps, [{ weekOf: '2026-06-08', amount: 7000, day: '2026-06-16', txId: paid.id, via: 'auto' }]);

  const older = sweepState(at(2026, 9, 16));
  movePair(older, '2026-06-16', 7000);
  assert.equal(detectSweeps(older, at(2026, 9, 16)), 0);
});

test('the earliest qualifying move wins, and its other leg is never counted again', () => {
  const state = sweepState();
  const early = movePair(state, '2026-06-15', 6500);
  movePair(state, '2026-06-16', 7000);

  assert.equal(detectSweeps(state, NOW), 1);

  assert.equal(state.sweeps[0].txId, early.out.id);
  assert.equal(detectSweeps(state, NOW), 0);
});

test('a recorded sweep is never taken for a recurring charge', () => {
  const state = sweepState(at(2026, 7, 8));
  for (const weekOf of ['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29']) coffee(state, weekOf, 400);
  const payments = ['2026-06-16', '2026-06-23', '2026-06-30', '2026-07-07'].map((day) => movePair(state, day, 7000).out);
  state.sweeps.push(
    { weekOf: '2026-06-08', amount: 7000, day: '2026-06-16', txId: payments[0].id, via: 'auto' },
    { weekOf: '2026-06-15', amount: 7000, day: '2026-06-23', txId: payments[1].id, via: 'auto' },
    { weekOf: '2026-06-22', amount: 7000, day: '2026-06-30', txId: payments[2].id, via: 'auto' },
  );

  assert.deepEqual(detectRecurring(state, at(2026, 7, 8)), NOTHING_RECURRING);
  assert.equal(detectSweeps(state, at(2026, 7, 8)), 1);
  assert.equal(state.sweeps[3].txId, payments[3].id);
  assert.deepEqual(detectRecurring(state, at(2026, 7, 8)), NOTHING_RECURRING);
  assert.equal(state.recurring.length, 0);
});

/* ---------------------------------------------------------------------- refresh */

/** Five months of an invented feed as merge leaves it: bank text on every row, classification still to do. */
function feedState() {
  const state = newState();
  const bank = (accountId, day, amount, flow, raw) => addRow(state, { accountId, day, amount, flow, raw, kind: flow === 'in' ? 'income' : 'spend' });

  for (const day of monthly('2026-01-09', 6)) bank(CARD, day, 1549, 'out', 'NETFLIX.COM 866-579-7172 CA');
  const power = [8420, 10110, 9230, 7680, 11890];
  monthly('2026-02-03', 5).forEach((day, i) => bank(CHECKING, day, power[i], 'out', 'CON ED OF NY CECONY'));
  for (const day of monthly('2026-02-01', 5)) bank(CHECKING, day, 120000, 'out', 'BLUE HERON RENT');
  bank(CARD, '2025-06-02', 9900, 'out', 'QUILLFEATHER HOSTING');
  bank(CARD, '2026-06-02', 9900, 'out', 'QUILLFEATHER HOSTING');
  for (const day of everyDays('2026-01-23', 14, 11)) bank(CHECKING, day, 190000, 'in', 'NORTHWIND LOGISTICS PAYROLL PPD ID: 9111111101');
  bank(CHECKING, '2026-04-22', 8000, 'in', 'ZELLE PAYMENT FROM MARLOW PIKE');
  bank(CHECKING, '2026-06-02', 12000, 'in', 'ZELLE PAYMENT FROM MARLOW PIKE');
  for (const day of everyDays('2026-04-01', 1, 77)) {
    const weekday = new Date(at(...day.split('-').map(Number))).getDay();
    if (weekday !== 0 && weekday !== 6) bank(CARD, day, weekday === 5 ? 1450 : 475, 'out', 'DUNKIN #345123 NEW YORK NY');
  }
  for (const day of everyDays('2026-04-04', 7, 11)) bank(CARD, day, 6000 + (Number(day.slice(8)) % 5) * 700, 'out', 'GREEN GROCER MARKET');
  return state;
}

test('refresh classifies, builds the Book and the streams, and starts the match', () => {
  const state = feedState();

  const report = refresh(state, NOW);

  assert.ok(report.reclassified > 0);
  assert.equal(report.matchStarted, true);
  assert.equal(report.sweeps, 0);
  assert.deepEqual(report.recurring.repriced, []);
  assert.deepEqual(report.recurring.lapsed, []);

  const book = Object.fromEntries(state.recurring.map((entry) => [entry.mkey, entry]));
  assert.deepEqual(Object.keys(book).sort(), ['blue heron rent', 'con edison', 'netflix', 'quillfeather hosting']);
  assert.equal(report.recurring.added.length, 4);
  assert.equal(book.netflix.name, 'Netflix');
  assert.equal(book.netflix.cadence, 'monthly');
  assert.equal(book.netflix.amount, 1549);
  assert.equal(book['con edison'].variable, true);
  assert.equal(book['con edison'].essential, true);
  assert.equal(book['blue heron rent'].category, 'housing');
  assert.equal(book['quillfeather hosting'].cadence, 'annual');

  assert.equal(state.streams.length, 2);
  const salary = state.streams.find((stream) => stream.accrue);
  assert.equal(salary.kind, 'salary');
  assert.equal(salary.cadence, 'biweekly');
  assert.equal(salary.amount, 190000);
  assert.equal(salary.anchor, '2026-06-12');
  const client = state.streams.find((stream) => !stream.accrue);
  assert.equal(client.kind, 'lessons');

  for (const tx of state.txs) {
    if (tx.mkey === 'netflix') assert.equal(tx.recurringId, book.netflix.id);
    if (tx.mkey === 'dunkin') assert.deepEqual([tx.recurringId, tx.klass], [null, 'game']);
    if (tx.mkey === 'quillfeather hosting') assert.equal(tx.klass, 'book');
    if (tx.kind === 'income' && tx.amount === 190000) assert.equal(tx.streamId, salary.id);
  }

  assert.equal(state.meta.matchStart, TODAY);
  assert.equal(state.habits.length, 1);
  assert.equal(state.habits[0].from, TODAY);
  assert.deepEqual(state.habits[0].window, { from: '2026-04-18', to: '2026-06-16', workDays: 42, offDays: 18 });
  assert.ok(state.habits[0].work > 475 && state.habits[0].work < 1450);
  assert.equal(state.habits[0].off, 0);
  assert.ok(isFiniteThroughout(state));
});

test('refresh is idempotent: a second call changes nothing', () => {
  const state = feedState();
  refresh(state, NOW);
  const after = snapshot(state);

  const again = refresh(state, NOW);

  assert.deepEqual(again, { reclassified: 0, recurring: NOTHING_RECURRING, streams: NOTHING_STREAMS, matchStarted: false, sweeps: 0 });
  assert.deepEqual(state, after);
  refresh(state, NOW);
  assert.deepEqual(state, after);
});

test('refresh records a sweep once and is idempotent afterwards', () => {
  const state = sweepState();
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly');
  for (const day of everyDays('2026-04-03', 14, 6)) deposit(state, day, 190000, 'Northwind Logistics', { raw: '' });
  const { out } = movePair(state, '2026-06-16', 7000);

  const first = refresh(state, NOW);

  assert.equal(first.sweeps, 1);
  assert.equal(first.matchStarted, false);
  assert.equal(state.sweeps[0].txId, out.id);
  assert.equal(state.recurring.length, 1);
  assert.equal(state.streams.length, 1);
  const after = snapshot(state);

  const second = refresh(state, NOW);

  assert.deepEqual(second, { reclassified: 0, recurring: NOTHING_RECURRING, streams: NOTHING_STREAMS, matchStarted: false, sweeps: 0 });
  assert.deepEqual(state, after);
});

test('a later sync adds to what refresh found without disturbing it', () => {
  const state = feedState();
  refresh(state, NOW);
  const ids = { book: state.recurring.map((entry) => entry.id), streams: state.streams.map((stream) => stream.id), segment: snapshot(state.habits[0]) };

  const later = at(2026, 6, 27);
  addRow(state, { accountId: CHECKING, day: '2026-06-26', amount: 190000, flow: 'in', kind: 'income', raw: 'NORTHWIND LOGISTICS PAYROLL PPD ID: 9111111101' });
  addRow(state, { accountId: CARD, day: '2026-06-22', amount: 1899, flow: 'out', kind: 'spend', raw: 'TUNEBOX MUSIC' });
  const report = refresh(state, later);

  assert.deepEqual(state.recurring.map((entry) => entry.id), ids.book);
  assert.deepEqual(state.streams.map((stream) => stream.id), ids.streams);
  assert.deepEqual(report.recurring, NOTHING_RECURRING);
  assert.equal(report.streams.updated.length, 1);
  assert.equal(report.matchStarted, false);
  assert.equal(state.meta.matchStart, TODAY);
  assert.deepEqual(state.habits, [ids.segment]);
  assert.equal(state.streams.find((stream) => stream.accrue).anchor, '2026-06-26');
});

/* ------------------------------------------------------------------- robustness */

test('nothing throws and nothing is NaN on an empty or missing document', () => {
  for (const broken of [null, undefined, 7, 'state', []]) {
    assert.deepEqual(detectRecurring(broken, NOW), NOTHING_RECURRING);
    assert.deepEqual(detectStreams(broken, NOW), NOTHING_STREAMS);
    assert.equal(computeHabit(broken, '2026-05-01', '2026-06-16'), null);
    assert.equal(startMatch(broken, NOW), false);
    assert.equal(detectSweeps(broken, NOW), 0);
    assert.deepEqual(refresh(broken, NOW), { reclassified: 0, recurring: NOTHING_RECURRING, streams: NOTHING_STREAMS, matchStarted: false, sweeps: 0 });
  }
  const empty = defaultState(NOW);
  assert.deepEqual(refresh(empty, NOW), { reclassified: 0, recurring: NOTHING_RECURRING, streams: NOTHING_STREAMS, matchStarted: false, sweeps: 0 });
  assert.deepEqual(refresh({}, NOW), { reclassified: 0, recurring: NOTHING_RECURRING, streams: NOTHING_STREAMS, matchStarted: false, sweeps: 0 });
  assert.deepEqual(refresh(empty, Number.NaN).recurring, NOTHING_RECURRING);
});

test('malformed rows, entries and accounts are skipped, and the good ones still detected', () => {
  const state = feedState();
  state.txs.push(
    null, 5, 'row', [], {},
    { id: 'tx_no_day', accountId: CARD, amount: 1549, flow: 'out', kind: 'spend', mkey: 'netflix' },
    makeTx({ id: 'tx_bad_day', accountId: CARD, day: '2026-13-45', amount: 1549, mkey: 'netflix' }),
    makeTx({ id: 'tx_nan', accountId: CARD, day: '2026-06-10', amount: Number.NaN, mkey: 'netflix' }),
    makeTx({ id: 'tx_negative', accountId: CARD, day: '2026-06-10', amount: -1549, mkey: 'netflix' }),
    makeTx({ id: 'tx_text', accountId: CARD, day: '2026-06-10', amount: '1549', mkey: 'netflix' }),
    makeTx({ id: 'tx_no_key', accountId: CARD, day: '2026-06-10', amount: 1549, mkey: null }),
    makeTx({ id: 42, accountId: CARD, day: '2026-06-10', amount: 1549, mkey: 'netflix' }),
    makeTx({ id: 'tx_locks', accountId: CHECKING, day: '2026-06-10', amount: 500, flow: 'in', kind: 'income', mkey: 'odd', locks: 'klass' }),
  );
  state.accounts.push(null, 'account', { id: 'acc_typeless' }, { id: 7, type: 'checking' }, makeAccount({ id: 'acc_odd', type: 'spaceship' }));
  state.recurring.push(null, 'entry', {}, { id: 'rec_no_key' }, { id: 'rec_odd', mkey: 'netflix', amount: 'lots', cadence: 'sometimes', anchor: 12, locks: 'all', active: 'yes' });
  state.streams.push(null, 3, {}, { id: 'str_odd', mkey: 'northwind logistics payroll', cadence: 'whenever', anchor: null, amount: Number.NaN, locks: null });
  state.sweeps.push(null, 'sweep', { weekOf: 12 });
  state.habits.push(null, { from: 'yesterday' });
  state.days = { '2026-06-10': null, junk: 5 };

  let report;
  assert.doesNotThrow(() => { report = refresh(state, NOW); });

  assert.ok(isFiniteThroughout(report));
  assert.ok(state.recurring.some((entry) => entry && entry.mkey === 'con edison' && entry.active === true));
  assert.ok(state.streams.some((stream) => stream && stream.accrue === true && stream.amount === 190000));
  for (const list of [state.recurring, state.streams]) {
    for (const item of list) {
      if (!item || typeof item !== 'object' || item.source !== 'detected') continue;
      assert.ok(Number.isFinite(item.amount), JSON.stringify(item));
      assert.ok(Number.isFinite(item.confidence), JSON.stringify(item));
    }
  }
  assert.doesNotThrow(() => refresh(state, NOW));
});

test('a document missing its lists gets them rather than an error', () => {
  const state = { meta: { matchStart: null }, settings: {}, accounts: [makeAccount({ id: CARD, source: 'bank', type: 'credit_card' })], txs: [] };
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly');
  for (const day of everyDays('2026-05-01', 1, 30)) coffee(state, day, 500);

  const report = refresh(state, NOW);

  assert.equal(report.recurring.added.length, 1);
  assert.equal(report.matchStarted, true);
  assert.equal(state.recurring.length, 1);
  assert.deepEqual(state.streams, []);
  assert.equal(state.habits.length, 1);
  assert.deepEqual(state.sweeps, []);
});

test('bank text is only ever data: hostile strings change nothing but names', () => {
  const state = newState();
  const hostile = '<img src=x onerror=alert(1)>${process.exit(1)}__proto__';
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, hostile, { mkey: '__proto__' });
  for (const day of everyDays('2026-04-03', 14, 6)) deposit(state, day, 190000, hostile, { mkey: 'constructor', raw: hostile.repeat(20000) });

  detectRecurring(state, NOW);
  detectStreams(state, NOW);

  assert.equal(state.recurring.length, 1);
  assert.equal(state.recurring[0].name, hostile);
  assert.equal(state.recurring[0].mkey, '__proto__');
  assert.equal(state.streams.length, 1);
  assert.equal(state.streams[0].mkey, 'constructor');
  assert.equal({}.polluted, undefined);
});

test('a stream built from the fixtures passes through makeStream defaults', () => {
  const state = newState();
  for (const day of everyDays('2026-04-03', 14, 6)) deposit(state, day, 190000, 'Northwind Logistics');
  detectStreams(state, NOW);
  assert.deepEqual(Object.keys(state.streams[0]).sort(), Object.keys(makeStream()).sort());
  for (const day of monthly('2026-03-12', 4)) charge(state, day, 1549, 'Streamly');
  detectRecurring(state, NOW);
  assert.deepEqual(Object.keys(state.recurring[0]).sort(), Object.keys(makeRecurring()).sort());
});

/* ----------------------------------------------- the owner's terms (ruling 6) */

test('an amount the owner locked is not repriced by a new charge', () => {
  const state = newState();
  for (const day of monthly('2026-01-12', 4)) charge(state, day, 1549, 'Streamly');
  detectRecurring(state, at(2026, 4, 17));
  const [entry] = state.recurring;
  entry.amount = 1600;
  entry.locks = ['amount'];
  charge(state, '2026-05-12', 1799, 'Streamly');
  const report = detectRecurring(state, at(2026, 5, 17));
  assert.deepEqual(report.repriced, []);
  assert.equal(entry.amount, 1600);
});

test('an entry whose cadence the owner changed to a shorter one is not ended by detection', () => {
  const state = newState();
  for (const day of monthly('2026-01-16', 5)) charge(state, day, 1199, 'Tunebox');
  detectRecurring(state, at(2026, 5, 20));
  const [entry] = state.recurring;
  assert.equal(entry.cadence, 'monthly');
  entry.cadence = 'weekly';
  entry.locks = ['cadence'];
  const report = detectRecurring(state, NOW);
  assert.deepEqual(report.lapsed, []);
  assert.equal(entry.active, true);
  assert.equal(entry.cadence, 'weekly');

  // without the owner's lock the same entry lapses once 1.5 of its periods pass with no charge
  entry.locks = [];
  entry.cadence = 'monthly';
  assert.deepEqual(detectRecurring(state, at(2026, 9, 1)).lapsed, [entry.id]);
});

/* ------------------------------------------------ a payment the owner sends, and the line detection made of it */

const ZELLE = 'Zelle payment to R Lindqvist';
const ZELLE_MKEY = 'zelle to r lindqvist';

/** Money leaving checking, as the bank words it: the classifier (refresh) decides what it is. */
function sentOut(state, day, amount, raw, extra = {}) {
  return addRow(state, { accountId: CHECKING, day, amount, flow: 'out', raw, ...extra });
}

function linkedTo(state, id) {
  return state.txs.filter((tx) => tx.recurringId === id).map((tx) => tx.day).sort();
}

test('a monthly Zelle is a detected line; made a payment the owner sends, that line is gone and its rows are the payment\'s', () => {
  const state = newState();
  const rows = ['2026-03-04', '2026-04-05', '2026-05-04', '2026-06-04'].map((day) => sentOut(state, day, 25000, ZELLE));
  refresh(state, NOW);
  assert.deepEqual(rows.map((row) => [row.kind, row.ruleId, row.mkey]), rows.map(() => ['spend', 'builtin:zelle', ZELLE_MKEY]));
  const detected = state.recurring.find((entry) => entry.mkey === ZELLE_MKEY);
  assert.deepEqual([state.recurring.length, detected.source, detected.amount, detected.cadence], [1, 'detected', 25000, 'monthly']);
  const totals = bookTotals(state);

  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  const report = refresh(state, NOW + 1).recurring;
  assert.deepEqual(report, { added: [], repriced: [], lapsed: [] });
  assert.deepEqual(state.recurring.map((line) => line.id), [entry.id]);
  assert.equal(entry.payee, payeeKey(ZELLE_MKEY));
  assert.equal(entry.mkey, '');
  for (const row of rows) assert.deepEqual([row.recurringId, row.klass, row.review], [entry.id, 'book', false]);
  assert.deepEqual([bookTotals(state).count, bookTotals(state).perMonth], [totals.count, totals.perMonth]);

  // five more runs: nothing moves
  const frozen = JSON.stringify([state.recurring, state.txs]);
  for (let i = 2; i <= 6; i++) {
    assert.deepEqual(refresh(state, NOW + i).recurring, { added: [], repriced: [], lapsed: [] });
    assert.equal(JSON.stringify([state.recurring, state.txs]), frozen);
  }

  // removed, its rows are free in the same run and detection finds the line again
  removeByHand(state, entry.id, NOW + 7);
  const again = refresh(state, NOW + 7).recurring;
  assert.equal(again.added.length, 1);
  const line = state.recurring.find((one) => one.id === again.added[0]);
  assert.deepEqual([state.recurring.length, line.source, line.mkey, line.amount], [1, 'detected', ZELLE_MKEY, 25000]);
  assert.deepEqual(linkedTo(state, line.id), rows.map((row) => row.day));
  assert.deepEqual([bookTotals(state).count, bookTotals(state).perMonth], [totals.count, totals.perMonth]);
});

test('a row whose klass the owner set keeps it when a payment the owner sends takes the row', () => {
  const state = newState();
  const rows = ['2026-04-05', '2026-05-04', '2026-06-04'].map((day) => sentOut(state, day, 25000, ZELLE));
  refresh(state, NOW);
  rows[1].klass = 'want';
  rows[1].locks = ['klass'];
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.deepEqual(rows.map((row) => [row.recurringId, row.klass]), [[entry.id, 'book'], [entry.id, 'want'], [entry.id, 'book']]);
});

test('a detected line to the same payee: within 10% of the payment it is that payment; further off it is another line and stays', () => {
  const build = (other) => {
    const state = newState();
    for (const day of ['2026-03-04', '2026-04-05', '2026-05-04', '2026-06-04']) sentOut(state, day, 25000, ZELLE);
    const rows = ['2026-03-18', '2026-04-18', '2026-05-18'].map((day) => sentOut(state, day, other, ZELLE));
    refresh(state, NOW);
    const before = state.recurring.filter((line) => line.mkey === ZELLE_MKEY).map((line) => line.amount).sort((a, b) => a - b);
    const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
    for (let i = 1; i <= 3; i++) refresh(state, NOW + i);
    return { state, rows, entry, before, lines: state.recurring.filter((line) => line.source === 'detected' && line.mkey === ZELLE_MKEY) };
  };
  // $60.00 to the same person every month is something else: its line stays and keeps its rows
  const far = build(6000);
  assert.deepEqual(far.before, [6000, 25000]);
  assert.deepEqual(far.lines.map((line) => line.amount), [6000]);
  for (const row of far.rows) assert.equal(row.recurringId, far.lines[0].id);
  assert.equal(linkedTo(far.state, far.entry.id).length, 4);
  assert.equal(bookTotals(far.state).perMonth, 31000);
  // $275.01 is more than 10% away: another line; $275.00 is within it: no second line of the one payment
  assert.deepEqual(build(27501).lines.map((line) => line.amount), [27501]);
  const near = build(27500);
  assert.deepEqual(near.lines, []);
  for (const row of near.rows) assert.equal(row.recurringId, null); // not its exact amount: they wait, linked to nothing
  assert.equal(bookTotals(near.state).perMonth, 25000);
});

test('a bank transfer is never a line by detection; a payment the owner sends takes it, and keeps it run after run', () => {
  const state = newState();
  const rows = ['2026-04-30', '2026-05-29'].map((day) => sentOut(state, day, 8500, 'Online transfer to Harbor Parking'));
  const own = movePair(state, '2026-05-30', 8500, { from: CHECKING, to: SAVINGS, kind: 'transfer' });
  refresh(state, NOW);
  assert.deepEqual(rows.map((row) => [row.kind, row.recurringId]), [['transfer', null], ['transfer', null]]);
  assert.equal(state.recurring.length, 0);
  const asWorded = rows.map((row) => [row.kind, row.recurringId, row.klass, row.category]);
  state.recurring.push(makeByHand({ id: 'rec_parking', name: 'Parking', amount: 8500, dueDay: 31, since: '2026-05-01', editedAt: NOW }));
  refresh(state, NOW);
  const entry = state.recurring[0];
  assert.equal(entry.payee, payeeKey(rows[0].mkey));
  assert.deepEqual(rows.map((row) => [row.kind, row.recurringId, row.klass, row.review]), rows.map(() => ['transfer', 'rec_parking', 'book', false]));
  assert.deepEqual([own.out.recurringId, own.arriving.recurringId], [null, null]); // a move between the owner's accounts never pays it
  const frozen = JSON.stringify([state.recurring, state.txs]);
  for (let i = 1; i <= 5; i++) {
    refresh(state, NOW + i);
    assert.equal(JSON.stringify([state.recurring, state.txs]), frozen);
  }
  // switched off, the rows go back to what their text says
  entry.active = false;
  refresh(state, NOW + 9);
  assert.deepEqual(rows.map((row) => [row.kind, row.recurringId, row.klass, row.category]), asWorded);
});

test('detection alone never touches a payment the owner sends: not its amount, its anchor or its switch', () => {
  const state = newState();
  const entry = makeByHand({ id: 'rec_flat', name: 'Flat share', amount: 25000, dueDay: 5, since: '2025-06-01', editedAt: 5 });
  state.recurring.push(entry);
  const before = JSON.stringify(entry);
  assert.deepEqual(detectRecurring(state, NOW), { added: [], repriced: [], lapsed: [] }); // a year unpaid: still on
  assert.equal(JSON.stringify(entry), before);
});
