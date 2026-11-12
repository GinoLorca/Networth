import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CARDS, PACE_FROM_DAY, allCardsMonths, cardMonth, cardMonths, cardsNow, firstTransactionDay, largestCharges } from '../js/model/cards.js';
import { makeLedger } from '../js/model/ledger.js';
import { defaultState, makeAccount, makeRecurring, makeTx } from '../js/model/schema.js';

/* Every figure below is invented. June 2026 has 30 days and no clock change anywhere near it. */

/** Local time, so the tests read the same in every time zone. */
const at = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();

/** Wednesday 10 June 2026 at noon: the 10th day of a 30-day month. */
const NOW = at(2026, 6, 10);

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

const charge = (accountId, day, amount, category = 'shopping', fields = {}) => tx(accountId, day, amount, { category, ...fields });
const interest = (accountId, day, amount) => tx(accountId, day, amount, { category: 'fees_interest' });
const payment = (accountId, day, amount) => tx(accountId, day, amount, { flow: 'in', kind: 'payment', category: 'card_payment' });
const refund = (accountId, day, amount) => tx(accountId, day, amount, { flow: 'in', kind: 'refund', category: 'shopping' });

const bankAccount = (id, type, balance, fields = {}) =>
  makeAccount({ id, source: 'bank', type, balance, basis: 'bank', name: id, asOf: at(2026, 6, 10, 9), ...fields });

/**
 * A fictional owner with one card, "acc_card", owing $3,000.00 now.
 *
 *   March  one purchase of $109.00 on the 20th                      owed 3,000.00 -> 3,109.00
 *   April  $150.00 bought, $40.00 refunded, $600.00 paid            owed 3,109.00 -> 2,619.00  (fell)
 *   May    $600.00 bought, $61.00 interest, $200.00 paid            owed 2,619.00 -> 3,080.00  (rose)
 *   June   $200.00 bought, $250.00 paid, $30.00 refunded so far     owed 3,080.00 -> 3,000.00  (now)
 *
 * The checking account's first row is on 5 March, which is where the document's history begins.
 */
function oneCard() {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(
    bankAccount('acc_chk', 'checking', 180000),
    bankAccount('acc_card', 'credit_card', -300000, { apr: 36.5, limit: 500000 }),
  );
  state.txs.push(
    charge('acc_chk', '2026-03-05', 4200, 'groceries'),
    charge('acc_card', '2026-03-20', 10900),
    charge('acc_card', '2026-04-10', 15000),
    refund('acc_card', '2026-04-12', 4000),
    payment('acc_card', '2026-04-18', 60000),
    charge('acc_card', '2026-05-03', 50000),
    interest('acc_card', '2026-05-15', 6100),
    payment('acc_card', '2026-05-20', 20000),
    charge('acc_card', '2026-05-25', 10000),
    charge('acc_card', '2026-06-02', 12000, 'groceries'),
    charge('acc_card', '2026-06-05', 8000),
    payment('acc_card', '2026-06-08', 25000),
    tx('acc_chk', '2026-06-08', 25000, { kind: 'payment', category: 'card_payment' }),
    refund('acc_card', '2026-06-09', 3000),
  );
  state.sync.lastOk = at(2026, 6, 10, 9);
  return state;
}

/**
 * The same owner with a second card, "acc_store", owing $500.00 now, with no rate and no limit on file.
 *   May   $200.00 bought, $100.00 paid     owed 350.00 -> 450.00
 *   June  $50.00 bought                    owed 450.00 -> 500.00 (now)
 */
function twoCards() {
  const state = oneCard();
  state.accounts.push(bankAccount('acc_store', 'credit_card', -50000));
  state.txs.push(
    charge('acc_store', '2026-05-10', 20000),
    payment('acc_store', '2026-05-28', 10000),
    charge('acc_store', '2026-06-03', 5000),
  );
  return state;
}

const emptyMonth = (accountId, ym, fields = {}) => ({
  accountId, ym, start: 0, charges: 0, payments: 0, refunds: 0, interest: 0, end: 0, change: 0,
  current: false, complete: false, scheduled: 0, bookCharges: 0, credit: 0, projected: null, pace: null, daysElapsed: 0, daysInMonth: 0, ...fields,
});

/* --------------------------------------------------------------- cardMonth */

test('cardMonth: a month in which the balance fell', () => {
  assert.deepEqual(cardMonth(oneCard(), 'acc_card', '2026-04', NOW), {
    accountId: 'acc_card', ym: '2026-04',
    start: 310900, charges: 15000, payments: 60000, refunds: 4000, interest: 0, end: 261900, change: -49000,
    current: false, complete: true, scheduled: 0, bookCharges: 0, credit: 0, projected: null, pace: null, daysElapsed: 30, daysInMonth: 30,
  });
});

test('cardMonth: a month in which the balance rose, with interest inside the charges', () => {
  assert.deepEqual(cardMonth(oneCard(), 'acc_card', '2026-05', NOW), {
    accountId: 'acc_card', ym: '2026-05',
    start: 261900, charges: 66100, payments: 20000, refunds: 0, interest: 6100, end: 308000, change: 46100,
    current: false, complete: true, scheduled: 0, bookCharges: 0, credit: 0, projected: null, pace: null, daysElapsed: 31, daysInMonth: 31,
  });
});

test('cardMonth: a refund lowers the balance without being a payment', () => {
  const april = cardMonth(oneCard(), 'acc_card', '2026-04', NOW);
  assert.equal(april.refunds, 4000);
  assert.equal(april.payments, 60000);
  assert.equal(april.end - april.start, april.charges - april.payments - april.refunds);
});

test('cardMonth: fees and interest are charges and are also reported on their own', () => {
  const state = oneCard();
  state.txs.push(interest('acc_card', '2026-04-28', 3900));
  const april = cardMonth(state, 'acc_card', '2026-04', NOW);
  assert.equal(april.interest, 3900);
  assert.equal(april.charges, 18900);
  // The balance now is fixed by the bank, so an extra April charge means April began lower.
  assert.equal(april.start, 307000);
  assert.equal(april.end, 261900);
});

test('cardMonth: the current month on the 10th of a 30-day month carries a projection and a pace', () => {
  // $200.00 of charges in 10 days is $20.00 a day; 20 days remain: 3,000.00 + 400.00 = 3,400.00.
  assert.deepEqual(cardMonth(oneCard(), 'acc_card', '2026-06', NOW), {
    accountId: 'acc_card', ym: '2026-06',
    start: 308000, charges: 20000, payments: 25000, refunds: 3000, interest: 0, end: 300000, change: -8000,
    current: true, complete: true, scheduled: 0, bookCharges: 0, credit: 0, projected: 340000, pace: 32000, daysElapsed: 10, daysInMonth: 30,
  });
});

test('cardMonth: a month on pace to end lower has a negative pace', () => {
  const state = oneCard();
  state.txs.push(payment('acc_card', '2026-06-04', 50000));
  const june = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(june.start, 358000);
  assert.equal(june.projected, 340000);
  assert.equal(june.pace, -18000);
});

test('cardMonth: the projection is rounded to whole cents', () => {
  const state = oneCard();
  state.txs.push(charge('acc_card', '2026-06-06', 1));
  const june = cardMonth(state, 'acc_card', '2026-06', NOW);
  // 20,001 cents / 10 days × 20 days = 40,002 cents exactly; a third of a cent never appears.
  assert.equal(june.projected, 340002);
  const odd = oneCard();
  odd.txs.push(charge('acc_card', '2026-06-06', 3));
  // On the 9th: 20,003 / 9 × 21 = 46,673.67 -> 46,674.
  assert.equal(cardMonth(odd, 'acc_card', '2026-06', at(2026, 6, 9)).projected, 346674);
});

test('cardMonth: on the last day of the month nothing remains to project', () => {
  const june = cardMonth(oneCard(), 'acc_card', '2026-06', at(2026, 6, 30));
  assert.equal(june.daysElapsed, 30);
  assert.equal(june.projected, june.end);
  assert.equal(june.pace, june.change);
});

test('cardMonth: the month follows the game day, not the calendar', () => {
  // 2 a.m. on 1 June is still the game day of 31 May (rollover at 4 a.m.).
  const lateNight = at(2026, 6, 1, 2);
  const may = cardMonth(oneCard(), 'acc_card', '2026-05', lateNight);
  assert.equal(may.current, true);
  assert.equal(may.daysElapsed, 31);
  assert.equal(may.end, 300000);
  assert.equal(may.projected, 300000);
  const june = cardMonth(oneCard(), 'acc_card', '2026-06', lateNight);
  assert.equal(june.current, false);
  assert.equal(june.daysElapsed, 0);
  assert.equal(june.projected, null);
});

test('cardMonth: complete is false when the month begins before the earliest transaction in the document', () => {
  const march = cardMonth(oneCard(), 'acc_card', '2026-03', NOW);
  assert.deepEqual(march, {
    accountId: 'acc_card', ym: '2026-03',
    start: 300000, charges: 10900, payments: 0, refunds: 0, interest: 0, end: 310900, change: 10900,
    current: false, complete: false, scheduled: 0, bookCharges: 0, credit: 0, projected: null, pace: null, daysElapsed: 31, daysInMonth: 31,
  });
  assert.equal(cardMonth(oneCard(), 'acc_card', '2026-02', NOW).complete, false);
  assert.equal(cardMonth(oneCard(), 'acc_card', '2026-04', NOW).complete, true);
});

test('cardMonth: a month whose first day is the first day of history is complete', () => {
  const state = oneCard();
  state.txs.push(charge('acc_chk', '2026-03-01', 500, 'cafe'));
  assert.equal(cardMonth(state, 'acc_card', '2026-03', NOW).complete, true);
  assert.equal(cardMonth(state, 'acc_card', '2026-02', NOW).complete, false);
});

test('cardMonth: nothing is complete in a document without transactions', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_card', 'credit_card', -120000));
  const june = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(june.complete, false);
  assert.equal(june.start, 120000);
  assert.equal(june.end, 120000);
  assert.equal(june.projected, 120000);
  assert.equal(june.pace, 0);
});

test('cardMonth: a card in credit owes nothing', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_card', 'credit_card', 2500));
  state.txs.push(
    charge('acc_card', '2026-05-20', 10000),
    payment('acc_card', '2026-06-03', 12500),
  );
  // End of May: 25.00 − 125.00 = −100.00, so $100.00 owed; now the card is $25.00 in credit.
  const june = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(june.start, 10000);
  assert.equal(june.end, 0);
  assert.equal(june.change, -10000);
  assert.equal(june.projected, 0);
  assert.equal(june.pace, -10000);
});

test('cardMonth: pending rows count only while the owner counts them', () => {
  const state = oneCard();
  state.txs.push(charge('acc_card', '2026-06-10', 4000, 'cafe', { pending: true, postedDay: null }));
  const counted = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(counted.charges, 24000);
  assert.equal(counted.end, 304000);
  assert.equal(counted.start, 308000);
  assert.equal(counted.projected, 304000 + 48000);

  state.settings.countPending = false;
  const ignored = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(ignored.charges, 20000);
  assert.equal(ignored.end, 300000);
  assert.equal(ignored.start, 308000);
});

test('cardMonth: declines, provisional moves and superseded moves are not card activity', () => {
  const state = oneCard();
  const before = cardMonth(state, 'acc_card', '2026-06', NOW);
  state.txs.push(
    tx('acc_card', '2026-06-04', 900, { kind: 'decline', source: 'manual', category: 'cafe' }),
    tx('acc_card', '2026-06-09', 700, { source: 'manual', category: 'cafe', postedDay: null }),
    tx('acc_card', '2026-06-05', 8000, { source: 'manual', category: 'shopping', matchId: 'tx_1' }),
  );
  assert.deepEqual(cardMonth(state, 'acc_card', '2026-06', NOW), before);
});

test('cardMonth: the other leg of a card payment is not counted on the card', () => {
  const june = cardMonth(oneCard(), 'acc_card', '2026-06', NOW);
  assert.equal(june.payments, 25000);
  assert.equal(june.charges, 20000);
});

test('cardMonth: a transfer onto the card is a payment; a statement credit is a refund', () => {
  const state = oneCard();
  state.txs.push(
    tx('acc_card', '2026-04-20', 7000, { flow: 'in', kind: 'transfer', category: 'transfer' }),
    tx('acc_card', '2026-04-21', 1200, { flow: 'in', kind: 'income', category: 'income' }),
  );
  const april = cardMonth(state, 'acc_card', '2026-04', NOW);
  assert.equal(april.payments, 67000);
  assert.equal(april.refunds, 5200);
  assert.equal(april.end - april.start, april.charges - april.payments - april.refunds);
});

test('cardMonth: a future month stands at the balance now and is not current', () => {
  assert.deepEqual(cardMonth(oneCard(), 'acc_card', '2026-07', NOW), {
    accountId: 'acc_card', ym: '2026-07',
    start: 300000, charges: 0, payments: 0, refunds: 0, interest: 0, end: 300000, change: 0,
    current: false, complete: true, scheduled: 0, bookCharges: 0, credit: 0, projected: null, pace: null, daysElapsed: 0, daysInMonth: 31,
  });
});

test('cardMonth: an unknown, hidden or non-card account, or a bad month, is a row of zeros', () => {
  const state = oneCard();
  assert.deepEqual(cardMonth(state, 'acc_missing', '2026-05', NOW), emptyMonth('acc_missing', '2026-05', { complete: true, daysElapsed: 31, daysInMonth: 31 }));
  assert.deepEqual(cardMonth(state, 'acc_chk', '2026-05', NOW), emptyMonth('acc_chk', '2026-05', { complete: true, daysElapsed: 31, daysInMonth: 31 }));
  assert.deepEqual(cardMonth(state, 'acc_card', 'May 2026', NOW), emptyMonth('acc_card', 'May 2026'));
  assert.deepEqual(cardMonth(state, 'acc_card', '2026-13', NOW), emptyMonth('acc_card', '2026-13'));
  assert.deepEqual(cardMonth(state, 'acc_card', undefined, NOW), emptyMonth('acc_card', undefined));

  state.accounts[1].hidden = true;
  const hidden = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(hidden.start, 0);
  assert.equal(hidden.charges, 0);
  assert.equal(hidden.end, 0);
  assert.equal(hidden.projected, 0);
});

/* -------------------------------------------------------------- cardMonths */

test('cardMonths: oldest first, the current month last', () => {
  const rows = cardMonths(oneCard(), 'acc_card', 3, NOW);
  assert.deepEqual(rows.map((row) => row.ym), ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(rows.map((row) => row.current), [false, false, true]);
  assert.deepEqual(rows.map((row) => row.change), [-49000, 46100, -8000]);
  // Each month begins where the one before it ended.
  assert.equal(rows[1].start, rows[0].end);
  assert.equal(rows[2].start, rows[1].end);
  assert.deepEqual(rows[1], cardMonth(oneCard(), 'acc_card', '2026-05', NOW));
});

test('cardMonths: history is limited to the months transactions reach', () => {
  const rows = cardMonths(oneCard(), 'acc_card', 12, NOW);
  assert.deepEqual(rows.map((row) => row.ym), ['2026-03', '2026-04', '2026-05', '2026-06']);
  assert.deepEqual(rows.map((row) => row.complete), [false, true, true, true]);
});

test('cardMonths: with no transactions only the current month is shown', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_card', 'credit_card', -120000));
  const rows = cardMonths(state, 'acc_card', 6, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ym, '2026-06');
  assert.equal(rows[0].end, 120000);
});

test('cardMonths: the count defaults to six and a count below one gives nothing', () => {
  const state = oneCard();
  state.txs.push(charge('acc_chk', '2025-01-15', 900, 'cafe'));
  assert.deepEqual(cardMonths(state, 'acc_card', undefined, NOW).map((row) => row.ym),
    ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.deepEqual(cardMonths(state, 'acc_card', 2.9, NOW).map((row) => row.ym), ['2026-05', '2026-06']);
  assert.deepEqual(cardMonths(state, 'acc_card', 0, NOW), []);
  assert.deepEqual(cardMonths(state, 'acc_card', -3, NOW), []);
});

test('cardMonths: a month with no activity keeps its balance', () => {
  const state = oneCard();
  state.txs.push(charge('acc_chk', '2026-01-15', 900, 'cafe'));
  const february = cardMonths(state, 'acc_card', 6, NOW)[1];
  assert.equal(february.ym, '2026-02');
  assert.equal(february.start, 300000);
  assert.equal(february.end, 300000);
  assert.equal(february.change, 0);
  assert.equal(february.charges, 0);
  assert.equal(february.complete, true);
});

test('cardMonths: history crosses a year boundary', () => {
  const state = oneCard();
  state.txs.push(charge('acc_card', '2025-12-28', 2000));
  const rows = cardMonths(state, 'acc_card', 8, NOW);
  assert.deepEqual(rows.map((row) => row.ym),
    ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.equal(rows[0].start, 298000);
  assert.equal(rows[0].end, 300000);
  assert.equal(rows[0].complete, false);
});

/* ---------------------------------------------------------- allCardsMonths */

test('allCardsMonths: every field is the sum over the cards', () => {
  const rows = allCardsMonths(twoCards(), 2, NOW);
  assert.deepEqual(rows, [
    {
      accountId: 'all', ym: '2026-05',
      start: 296900, charges: 86100, payments: 30000, refunds: 0, interest: 6100, end: 353000, change: 56100,
      current: false, complete: true, scheduled: 0, bookCharges: 0, credit: 0, projected: null, pace: null, daysElapsed: 31, daysInMonth: 31,
    },
    {
      // 3,500.00 owed now; $250.00 of charges in 10 days, 20 to go: 3,500.00 + 500.00.
      accountId: 'all', ym: '2026-06',
      start: 353000, charges: 25000, payments: 25000, refunds: 3000, interest: 0, end: 350000, change: -3000,
      current: true, complete: true, scheduled: 0, bookCharges: 0, credit: 0, projected: 400000, pace: 47000, daysElapsed: 10, daysInMonth: 30,
    },
  ]);
  assert.equal(ALL_CARDS, 'all');
});

test('allCardsMonths: agrees with the cards taken one by one', () => {
  const state = twoCards();
  const all = allCardsMonths(state, 4, NOW);
  const main = cardMonths(state, 'acc_card', 4, NOW);
  const store = cardMonths(state, 'acc_store', 4, NOW);
  assert.equal(all.length, 4);
  all.forEach((row, i) => {
    for (const key of ['start', 'charges', 'payments', 'refunds', 'interest', 'end', 'change']) {
      assert.equal(row[key], main[i][key] + store[i][key], row.ym + ' ' + key);
    }
    assert.equal(row.complete, main[i].complete);
  });
});

test('allCardsMonths: a hidden card and a card in credit add nothing owed', () => {
  const state = twoCards();
  state.accounts.push(
    bankAccount('acc_old', 'credit_card', -99900, { hidden: true }),
    bankAccount('acc_credit', 'credit_card', 1500),
  );
  state.txs.push(charge('acc_old', '2026-06-02', 7700));
  const june = allCardsMonths(state, 1, NOW)[0];
  assert.equal(june.end, 350000);
  assert.equal(june.charges, 25000);
});

test('allCardsMonths: with no card every figure is zero and the current month is still there', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_chk', 'checking', 180000));
  state.txs.push(charge('acc_chk', '2026-05-05', 4200, 'groceries'));
  assert.deepEqual(allCardsMonths(state, 6, NOW), [
    emptyMonth('all', '2026-05', { daysElapsed: 31, daysInMonth: 31 }),
    emptyMonth('all', '2026-06', { current: true, complete: true, projected: 0, pace: 0, daysElapsed: 10, daysInMonth: 30 }),
  ]);
});

/* ---------------------------------------------------------------- cardsNow */

test('cardsNow: what is owed, against the limits that are known', () => {
  const now = cardsNow(twoCards(), NOW);
  assert.equal(now.owed, 350000);
  assert.equal(now.limit, 500000);
  // Only the first card has a limit: 3,000.00 of its 5,000.00.
  assert.equal(now.utilisation, 0.6);
  assert.equal(now.interestPerDay, null);
  assert.deepEqual(now.cards, [
    { id: 'acc_card', label: 'acc_card', owed: 300000, apr: 36.5, limit: 500000 },
    { id: 'acc_store', label: 'acc_store', owed: 50000, apr: null, limit: null },
  ]);
});

test('cardsNow: interest per day needs a rate on every card that is owed on', () => {
  const state = twoCards();
  state.accounts[2].apr = 18.25;
  // 3,000.00 × 36.5% / 365 = 3.00 a day; 500.00 × 18.25% / 365 = 0.25 a day.
  near(cardsNow(state, NOW).interestPerDay, 325);

  const paidOff = twoCards();
  paidOff.accounts[2].balance = 0;
  near(cardsNow(paidOff, NOW).interestPerDay, 300);
});

test('cardsNow: labels use the nickname, and limits add up', () => {
  const state = twoCards();
  state.accounts[1].nick = 'Everyday card';
  state.accounts[2].limit = 100000;
  const now = cardsNow(state, NOW);
  assert.equal(now.cards[0].label, 'Everyday card');
  assert.equal(now.limit, 600000);
  near(now.utilisation, 350000 / 600000);
});

test('cardsNow: utilisation is not capped when a card is over its limit', () => {
  const state = oneCard();
  state.accounts[1].limit = 200000;
  assert.equal(cardsNow(state, NOW).utilisation, 1.5);
});

test('cardsNow: no cards, hidden cards and cards in credit', () => {
  const none = cardsNow(defaultState(at(2026, 1, 1)), NOW);
  assert.deepEqual(none, { owed: 0, limit: null, utilisation: null, interestPerDay: 0, cards: [] });

  const state = oneCard();
  state.accounts[1].hidden = true;
  state.accounts.push(bankAccount('acc_credit', 'credit_card', 1500, { limit: 100000 }));
  assert.deepEqual(cardsNow(state, NOW), {
    owed: 0, limit: 100000, utilisation: 0, interestPerDay: 0,
    cards: [{ id: 'acc_credit', label: 'acc_credit', owed: 0, apr: null, limit: 100000 }],
  });
});

test('cardsNow: counted pending charges are owed now', () => {
  const state = oneCard();
  state.txs.push(charge('acc_card', '2026-06-10', 4000, 'cafe', { pending: true, postedDay: null }));
  assert.equal(cardsNow(state, NOW).owed, 304000);
  state.settings.countPending = false;
  assert.equal(cardsNow(state, NOW).owed, 300000);
});

/* ---------------------------------------------------------- largestCharges */

test('largestCharges: the three largest charges of the month across the cards', () => {
  const state = twoCards();
  assert.deepEqual(largestCharges(state, '2026-06', NOW).map((row) => [row.accountId, row.amount]),
    [['acc_card', 12000], ['acc_card', 8000], ['acc_store', 5000]]);
  assert.deepEqual(largestCharges(state, '2026-05', NOW).map((row) => row.amount), [50000, 20000, 10000]);
  assert.deepEqual(largestCharges(state, '2026-05', NOW, 5).map((row) => row.amount), [50000, 20000, 10000, 6100]);
  assert.deepEqual(largestCharges(state, '2026-05', NOW, 1).map((row) => row.amount), [50000]);
});

test('largestCharges: hands back the document\'s own rows, never payments, refunds or cash spending', () => {
  const state = twoCards();
  const rows = largestCharges(state, '2026-04', NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0], state.txs.find((row) => row.day === '2026-04-10'));
  assert.deepEqual(largestCharges(state, '2026-02', NOW), []);
});

test('largestCharges: equal amounts are ordered by day', () => {
  const state = oneCard();
  state.txs.push(charge('acc_card', '2026-06-01', 12000), charge('acc_card', '2026-06-07', 12000));
  assert.deepEqual(largestCharges(state, '2026-06', NOW).map((row) => row.day), ['2026-06-01', '2026-06-02', '2026-06-07']);
});

test('largestCharges: a bad month or count gives nothing', () => {
  const state = oneCard();
  assert.deepEqual(largestCharges(state, 'June', NOW), []);
  assert.deepEqual(largestCharges(state, null, NOW), []);
  assert.deepEqual(largestCharges(state, '2026-06', NOW, 0), []);
});

/* ------------------------------------------------------ firstTransactionDay */

test('firstTransactionDay: the earliest counted row on any account', () => {
  assert.equal(firstTransactionDay(oneCard()), '2026-03-05');
  assert.equal(firstTransactionDay(defaultState(at(2026, 1, 1))), null);
  assert.equal(firstTransactionDay(null), null);

  const state = oneCard();
  state.txs.push(
    tx('acc_chk', '2026-01-02', 500, { kind: 'decline', source: 'manual' }),
    tx('acc_chk', '2026-01-03', 500, { source: 'manual' }),
    tx('acc_chk', 'not a day', 500),
    tx('acc_chk', '2026-01-04', NaN),
  );
  assert.equal(firstTransactionDay(state), '2026-03-05');
});

/* -------------------------------------------------------------- robustness */

test('malformed rows and missing fields never throw or produce NaN', () => {
  const state = oneCard();
  const clean = cardMonths(state, 'acc_card', 6, NOW);
  state.txs.push(
    null, undefined, 42, 'row', {},
    tx('acc_card', '2026-06-03', NaN),
    tx('acc_card', '2026-06-03', -500),
    tx('acc_card', '2026-06-03', Infinity),
    tx('acc_card', '2026-06-31', 900),
    tx('acc_card', null, 900),
    { accountId: 'acc_card', day: '2026-06-03' },
  );
  state.accounts.push(null, {}, { id: 'acc_x' }, { id: 7, type: 'credit_card' }, { id: 'acc_y', type: 'nonsense', balance: -5 });
  assert.deepEqual(cardMonths(state, 'acc_card', 6, NOW), clean);
  for (const result of [
    cardMonth(state, 'acc_card', '2026-06', NOW),
    allCardsMonths(state, 6, NOW),
    cardsNow(state, NOW),
    largestCharges(state, '2026-06', NOW),
  ]) assertNoNaN(result);
});

test('a card with a malformed balance, rate or limit is read as nothing owed and nothing known', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_card', 'credit_card', NaN, { apr: 'high', limit: -5 }));
  const now = cardsNow(state, NOW);
  assert.deepEqual(now, {
    owed: 0, limit: null, utilisation: null, interestPerDay: 0,
    cards: [{ id: 'acc_card', label: 'acc_card', owed: 0, apr: null, limit: null }],
  });
});

test('an empty, partial or missing document is answered with zeros', () => {
  for (const state of [null, undefined, {}, { accounts: 'none', txs: 7 }, defaultState(0)]) {
    const row = cardMonth(state, 'acc_card', '2026-06', NOW);
    assert.equal(row.end, 0);
    assert.equal(row.current, true);
    assertNoNaN(row);
    assert.equal(cardMonths(state, 'acc_card', 3, NOW).length, 1);
    assert.equal(allCardsMonths(state, 3, NOW).length, 1);
    assert.equal(cardsNow(state, NOW).owed, 0);
    assert.deepEqual(largestCharges(state, '2026-06', NOW), []);
  }
});

test('a missing or impossible clock does not throw', () => {
  for (const now of [undefined, NaN, Infinity, 'noon']) {
    const state = oneCard();
    assertNoNaN(cardMonth(state, 'acc_card', '2026-06', now));
    assertNoNaN(cardMonths(state, 'acc_card', 3, now));
    assertNoNaN(allCardsMonths(state, 3, now));
    assertNoNaN(cardsNow(state, now));
  }
});

test('the document is never changed', () => {
  const state = twoCards();
  const before = JSON.stringify(state);
  cardMonth(state, 'acc_card', '2026-06', NOW);
  cardMonths(state, 'acc_card', 6, NOW);
  allCardsMonths(state, 6, NOW);
  cardsNow(state, NOW);
  largestCharges(state, '2026-06', NOW);
  assert.equal(JSON.stringify(state), before);
});

/* ------------------------------------------------ pace with the Book (ruling 5) */

test('cardMonth: the projection takes off a Book payment to the card still scheduled this month', () => {
  const state = oneCard();
  const before = cardMonth(state, 'acc_card', '2026-06', NOW);
  state.recurring = [makeRecurring({ id: 'rec_pay', name: 'Card payment', accountId: 'acc_chk', toAccountId: 'acc_card', amount: 46000, cadence: 'monthly', anchor: '2026-05-15', active: true })];
  const row = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(row.scheduled, 46000);
  assert.equal(row.projected, before.projected - 46000);
  assert.equal(row.pace, before.pace - 46000);
  // ruling T3: a row linked to the entry meets the occurrence of the 15th from 5 days before it (the 10th), as on the clock
  state.txs.push(tx('acc_chk', '2026-06-09', 46000, { recurringId: 'rec_pay', kind: 'payment', category: 'card_payment' }));
  assert.equal(cardMonth(state, 'acc_card', '2026-06', NOW).scheduled, 46000, 'six days early: last month\'s payment, posted late');
  state.txs.pop();
  state.txs.push(tx('acc_chk', '2026-06-10', 46000, { recurringId: 'rec_pay', kind: 'payment', category: 'card_payment' }));
  assert.equal(cardMonth(state, 'acc_card', '2026-06', NOW).scheduled, 0);
  // one row meets one occurrence at most: a weekly entry with one row this week still has the later weeks ahead
  const weekly = oneCard();
  weekly.recurring = [makeRecurring({ id: 'rec_wk', name: 'Card payment', accountId: 'acc_chk', toAccountId: 'acc_card', amount: 5000, cadence: 'weekly', anchor: '2026-06-01', active: true })];
  // as on the clock, only the last occurrence before today is still awaited (Jun 8); the skipped Jun 1 is forgotten
  const planned = cardMonth(weekly, 'acc_card', '2026-06', NOW).scheduled;
  assert.equal(planned, 20000, 'Jun 8 (open), 15, 22 and 29');
  weekly.txs.push(tx('acc_chk', '2026-06-01', 5000, { recurringId: 'rec_wk', kind: 'payment', category: 'card_payment' }));
  assert.equal(cardMonth(weekly, 'acc_card', '2026-06', NOW).scheduled, planned, 'a row on Jun 1 meets Jun 1, not Jun 8');
  weekly.txs.push(tx('acc_chk', '2026-06-08', 5000, { recurringId: 'rec_wk', kind: 'payment', category: 'card_payment' }));
  assert.equal(cardMonth(weekly, 'acc_card', '2026-06', NOW).scheduled, planned - 5000, 'Jun 8 is met; three weeks are ahead');
  // an occurrence that passed is no longer awaited once the entry has lapsed (1.5 cadences with no linked row), as on the clock
  const stale = oneCard();
  stale.recurring = [makeRecurring({ id: 'rec_old', name: 'Card payment', accountId: 'acc_chk', toAccountId: 'acc_card', amount: 46000, cadence: 'monthly', anchor: '2026-05-15', active: true })];
  assert.equal(cardMonth(stale, 'acc_card', '2026-06', at(2026, 6, 20)).scheduled, 46000, 'five days late: still awaited');
  assert.equal(cardMonth(stale, 'acc_card', '2026-06', at(2026, 6, 30)).scheduled, 0, '46 days after its anchor with no row: lapsed');
  // an ended entry schedules nothing
  state.txs.pop();
  state.recurring[0].active = false;
  assert.equal(cardMonth(state, 'acc_card', '2026-06', NOW).scheduled, 0);
  assertNoNaN(row);
});

test('cardMonth: a card in credit absorbs its charges; nothing is projected as owed', () => {
  const state = oneCard();
  const card = state.accounts.find((account) => account.id === 'acc_card');
  card.balance = 200000;
  const row = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(row.credit, 200000);
  assert.equal(row.start, 0);
  assert.equal(row.end, 0);
  assert.equal(row.projected, 0, 'the credit absorbs the charges at pace');
  assert.equal(row.pace, 0);
  assertNoNaN(row);
});

/* ---- round two, ruling R3: the card month pace ---- */

test('R3a: no pace is read before day 7 of the month', () => {
  const state = oneCard();
  const early = cardMonth(state, 'acc_card', '2026-06', at(2026, 6, 6));
  assert.equal(early.current, true);
  assert.equal(early.projected, null);
  assert.equal(early.pace, null);
  const all = allCardsMonths(state, 1, at(2026, 6, 6));
  assert.equal(all[all.length - 1].projected, null);
  assert.equal(all[all.length - 1].pace, null);
  const seventh = cardMonth(state, 'acc_card', '2026-06', at(2026, 6, 7));
  assert.equal(typeof seventh.projected, 'number');
  assert.equal(seventh.pace, seventh.projected - seventh.start);
  assert.equal(PACE_FROM_DAY, 7);
  assertNoNaN(early);
});

test('R3b: interest and Book-linked charges are not paced; Book charges still to come are added once', () => {
  const state = oneCard();
  const before = cardMonth(state, 'acc_card', '2026-06', NOW);
  // $81.34 of interest and a $17.99 Book charge posted this month: both are in `charges`, neither is multiplied.
  state.txs.push(interest('acc_card', '2026-06-08', 8134));
  state.txs.push(charge('acc_card', '2026-06-03', 1799, 'subscriptions', { recurringId: 'rec_film' }));
  state.recurring = [
    makeRecurring({ id: 'rec_film', name: 'Film club', accountId: 'acc_card', amount: 1799, cadence: 'monthly', anchor: '2026-06-03', active: true }),
    makeRecurring({ id: 'rec_gym', name: 'Climbing hall', accountId: 'acc_card', amount: 4500, cadence: 'monthly', anchor: '2026-05-22', active: true }),
  ];
  const row = cardMonth(state, 'acc_card', '2026-06', NOW);
  assert.equal(row.charges, before.charges + 8134 + 1799);
  assert.equal(row.bookCharges, 4500, 'the Jun 22 occurrence is still to come; the Jun 3 one has posted');
  // The bank balance is unchanged in this fixture, so only the Book charge to come moves the projection.
  assert.equal(row.projected, before.projected + 4500);
  // The month began $99.33 lower (the two new charges are rolled back from the balance now).
  assert.equal(row.start, before.start - 8134 - 1799);
  assert.equal(row.pace, row.projected - row.start);
  assertNoNaN(row);
});

test('R3c: a hypothetical purchase goes inside the sum, so a credit absorbs it first', () => {
  const state = oneCard();
  const before = cardMonth(state, 'acc_card', '2026-06', NOW);
  const withBuy = cardMonth(state, 'acc_card', '2026-06', NOW, { extraCharge: 10000 });
  assert.equal(withBuy.projected, before.projected + 10000);
  assert.equal(allCardsMonths(state, 1, NOW, { extraCharge: 10000 }).pop().pace, allCardsMonths(state, 1, NOW).pop().pace + 10000);
  state.accounts.find((account) => account.id === 'acc_card').balance = 50000;
  const inCredit = allCardsMonths(state, 1, NOW, { extraCharge: 10000 }).pop();
  assert.equal(inCredit.projected, 0);
  assert.equal(inCredit.pace, 0, '$100.00 on a card $500.00 in credit ends the month where it began');
});

test('a ledger handed in through opts is used and gives the same answers', () => {
  const state = oneCard();
  const ledger = makeLedger(state, NOW);
  assert.deepEqual(cardsNow(state, NOW, { ledger }), cardsNow(state, NOW));
  assert.deepEqual(allCardsMonths(state, 3, NOW, { ledger }), allCardsMonths(state, 3, NOW));
  assert.deepEqual(cardMonths(state, 'acc_card', 3, NOW, { ledger }), cardMonths(state, 'acc_card', 3, NOW));
  let asked = 0;
  const counting = { ...ledger, accountValueOn: (id, day) => { asked += 1; return ledger.accountValueOn(id, day); } };
  cardsNow(state, NOW, { ledger: counting });
  assert.ok(asked > 0, 'the balances were read from the ledger that was handed in');
});
