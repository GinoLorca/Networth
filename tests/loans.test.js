import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loanValueOn, dailyInterest, splitPayment, payoff, payoffSchedule, requiredGrowth } from '../js/model/loans.js';
import { makeAccount } from '../js/model/schema.js';
import { diffDays } from '../js/model/dates.js';

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' is not within ' + tolerance + ' of ' + expected);

/** A fictional car loan: $10,000.00 owed on 10 January 2026 at 7.3% (exactly $2.00 a day), $300.00 due on the 5th. */
function carLoan(fields = {}) {
  return makeAccount({
    type: 'loan', name: 'Car loan', balance: -1000000, apr: 7.3, dueDay: 5,
    loan: { payment: 30000, assumeScheduled: true },
    history: [{ day: '2026-01-10', balance: -1000000, note: '' }],
    ...fields,
  });
}

/* --------------------------------------------------------------- daily interest */

test('dailyInterest is apr / 365 of what is owed', () => {
  close(dailyInterest(1000000, 7.3), 200);       // 10,000.00 × 0.073 / 365 = 2.00
  close(dailyInterest(36500, 10), 10);
  close(dailyInterest(420000, 24.99), 287.5561643835616, 1e-6); // 420000 × 0.2499 / 365
  close(dailyInterest(365, 100), 1);
});

test('dailyInterest is zero without a rate or a debt', () => {
  assert.equal(dailyInterest(1000000, null), 0);
  assert.equal(dailyInterest(1000000, undefined), 0);
  assert.equal(dailyInterest(1000000, 0), 0);
  assert.equal(dailyInterest(1000000, -5), 0);
  assert.equal(dailyInterest(1000000, NaN), 0);
  assert.equal(dailyInterest(0, 7.3), 0);
  assert.equal(dailyInterest(-50000, 7.3), 0);
  assert.equal(dailyInterest(NaN, 7.3), 0);
  assert.equal(dailyInterest(null, 7.3), 0);
  assert.equal(dailyInterest(Infinity, 7.3), 0);
});

/* ---------------------------------------------------------------- splitPayment */

test('splitPayment: interest for the days elapsed, the rest is principal', () => {
  assert.deepEqual(splitPayment(1000000, 7.3, 30000, 30), { interest: 6000, principal: 24000 });
  assert.deepEqual(splitPayment(1000000, 7.3, 30000, 31), { interest: 6200, principal: 23800 });
  assert.deepEqual(splitPayment(1000000, 7.3, 30000, 0), { interest: 0, principal: 30000 });
  // 250000 × 19.99 × 31 / 36500 = 4244.45
  assert.deepEqual(splitPayment(250000, 19.99, 12000, 31), { interest: 4244, principal: 7756 });
});

test('splitPayment: principal never exceeds what is owed', () => {
  // 10000 × 7.3 / 36500 = 2 a day; 30 days = 60
  assert.deepEqual(splitPayment(10000, 7.3, 50000, 30), { interest: 60, principal: 10000 });
  assert.deepEqual(splitPayment(10000, null, 10001, 30), { interest: 0, principal: 10000 });
  assert.deepEqual(splitPayment(0, 7.3, 30000, 30), { interest: 0, principal: 0 });
});

test('splitPayment: a payment below the interest leaves the debt growing', () => {
  assert.deepEqual(splitPayment(1000000, 7.3, 5000, 30), { interest: 6000, principal: -1000 });
  assert.deepEqual(splitPayment(1000000, 7.3, 6000, 30), { interest: 6000, principal: 0 });
});

test('splitPayment: no apr means no interest', () => {
  assert.deepEqual(splitPayment(1000000, null, 30000, 30), { interest: 0, principal: 30000 });
  assert.deepEqual(splitPayment(1000000, 0, 30000, 365), { interest: 0, principal: 30000 });
});

test('splitPayment: malformed input gives integers, never NaN', () => {
  for (const args of [[NaN, 7.3, 30000, 30], [1000000, NaN, 30000, 30], [1000000, 7.3, NaN, 30], [1000000, 7.3, 30000, NaN],
    [undefined, undefined, undefined, undefined], [1000000, 7.3, 30000, -4], [-1000000, 7.3, 30000, 30], ['a', 'b', 'c', 'd']]) {
    const { interest, principal } = splitPayment(...args);
    assert.ok(Number.isInteger(interest) && Number.isInteger(principal), JSON.stringify(args));
  }
  assert.deepEqual(splitPayment(1000000, 7.3, 30000, -4), { interest: 0, principal: 30000 });
  assert.deepEqual(splitPayment(-1000000, 7.3, 30000, 30), { interest: 0, principal: 0 });
});

/* ----------------------------------------------- loanValueOn: assumed schedule */

test('loanValueOn: assumed scheduled payments step the balance down on each due day', () => {
  const loan = carLoan();
  // 5 Feb: 26 days × 2.00 = 52.00 interest; principal 248.00 -> 9,752.00
  // 5 Mar: 28 days × 975200 × 7.3 / 36500 (1.9504) = 54.61; principal 245.39 -> 9,506.61
  // 5 Apr: 31 days × 950661 × 7.3 / 36500 (1.901322) = 58.94; principal 241.06 -> 9,265.55
  assert.equal(loanValueOn(loan, '2026-01-10', []), -1000000);
  assert.equal(loanValueOn(loan, '2026-02-04', []), -1000000);
  assert.equal(loanValueOn(loan, '2026-02-05', []), -975200);
  assert.equal(loanValueOn(loan, '2026-03-04', []), -975200);
  assert.equal(loanValueOn(loan, '2026-03-05', []), -950661);
  assert.equal(loanValueOn(loan, '2026-04-04', []), -950661);
  assert.equal(loanValueOn(loan, '2026-04-05', []), -926555);
  assert.equal(loanValueOn(loan, '2026-04-30', []), -926555);
});

test('loanValueOn: two years of assumed payments match an independent amortisation', () => {
  const loan = carLoan();
  let owed = 1000000;
  let since = '2026-01-10';
  for (let i = 0; i < 24; i++) { // 5 Feb 2026 .. 5 Jan 2028
    const monthIndex = 1 + i; // 0 = January 2026
    const due = String(2026 + Math.floor(monthIndex / 12)) + '-' + String(monthIndex % 12 + 1).padStart(2, '0') + '-05';
    const interest = Math.round(owed * 0.073 * diffDays(since, due) / 365);
    owed -= 30000 - interest;
    since = due;
    assert.equal(loanValueOn(loan, due, []), -owed, 'on ' + due);
  }
  assert.equal(since, '2028-01-05');
  assert.equal(loanValueOn(loan, '2028-02-04', []), -owed);
  assert.ok(owed > 380000 && owed < 420000, 'about $4,000 left: ' + owed);
});

test('loanValueOn: a due day past the end of the month falls on its last day', () => {
  const loan = carLoan({ apr: null, dueDay: 31, loan: { payment: 10000, assumeScheduled: true }, history: [{ day: '2026-01-15', balance: -1000000, note: '' }] });
  assert.equal(loanValueOn(loan, '2026-01-30', []), -1000000);
  assert.equal(loanValueOn(loan, '2026-01-31', []), -990000);
  assert.equal(loanValueOn(loan, '2026-02-27', []), -990000);
  assert.equal(loanValueOn(loan, '2026-02-28', []), -980000);
  assert.equal(loanValueOn(loan, '2026-03-30', []), -980000);
  assert.equal(loanValueOn(loan, '2026-03-31', []), -970000);
  assert.equal(loanValueOn(loan, '2026-04-29', []), -970000);
  assert.equal(loanValueOn(loan, '2026-04-30', []), -960000);
  const leap = carLoan({ apr: null, dueDay: 31, loan: { payment: 10000, assumeScheduled: true }, history: [{ day: '2028-01-15', balance: -1000000, note: '' }] });
  assert.equal(loanValueOn(leap, '2028-02-28', []), -990000);
  assert.equal(loanValueOn(leap, '2028-02-29', []), -980000);
});

test('loanValueOn: an entry made on the due day already reflects that payment', () => {
  const loan = carLoan({ apr: null, history: [{ day: '2026-02-05', balance: -1000000, note: '' }] });
  assert.equal(loanValueOn(loan, '2026-02-05', []), -1000000);
  assert.equal(loanValueOn(loan, '2026-03-04', []), -1000000);
  assert.equal(loanValueOn(loan, '2026-03-05', []), -970000);
});

test('loanValueOn: apr null — every payment is all principal', () => {
  const loan = carLoan({ apr: null });
  assert.equal(loanValueOn(loan, '2026-02-05', []), -970000);
  assert.equal(loanValueOn(loan, '2026-04-05', []), -910000);
  assert.equal(loanValueOn(loan, '2026-12-31', []), -670000); // 11 payments: Feb .. Dec
});

/* -------------------------------------------------- loanValueOn: feed payments */

test('loanValueOn: payments from the feed replace the assumed schedule', () => {
  const loan = carLoan();
  const payments = [
    { day: '2026-03-06', amount: 45000 }, // any order
    { day: '2026-02-07', amount: 30000 },
    { day: '2026-01-05', amount: 30000 }, // before the entry: already in the entered balance
    { day: '2026-01-10', amount: 30000 }, // on the entry day: likewise
  ];
  // 7 Feb: 28 days × 2.00 = 56.00; principal 244.00 -> 9,756.00
  // 6 Mar: 27 days × 975600 × 7.3 / 36500 (1.9512) = 52.68; principal 397.32 -> 9,358.68
  assert.equal(loanValueOn(loan, '2026-02-05', payments), -1000000); // the 5th is not assumed
  assert.equal(loanValueOn(loan, '2026-02-06', payments), -1000000);
  assert.equal(loanValueOn(loan, '2026-02-07', payments), -975600);
  assert.equal(loanValueOn(loan, '2026-03-05', payments), -975600);
  assert.equal(loanValueOn(loan, '2026-03-06', payments), -935868);
  assert.equal(loanValueOn(loan, '2026-06-30', payments), -935868); // nothing assumed after the last seen payment
  assert.equal(payments[0].day, '2026-03-06', 'the caller\'s list is not reordered');
});

test('loanValueOn: feed payments count without loan terms or an assumed schedule', () => {
  const payments = [{ day: '2026-02-07', amount: 30000 }];
  assert.equal(loanValueOn(carLoan({ loan: null, dueDay: null }), '2026-02-07', payments), -975600);
  assert.equal(loanValueOn(carLoan({ loan: { payment: 30000, assumeScheduled: false } }), '2026-02-07', payments), -975600);
  assert.equal(loanValueOn(carLoan({ loan: null, dueDay: null, apr: null }), '2026-02-07', payments), -970000);
});

test('loanValueOn: when every feed payment predates the entry the schedule is assumed', () => {
  const payments = [{ day: '2025-12-05', amount: 30000 }, { day: '2026-01-05', amount: 30000 }];
  assert.equal(loanValueOn(carLoan(), '2026-02-05', payments), -975200);
});

test('loanValueOn: two payments on one day equal one payment of their sum', () => {
  const split = [{ day: '2026-02-07', amount: 10000 }, { day: '2026-02-07', amount: 20000 }];
  assert.equal(loanValueOn(carLoan(), '2026-02-07', split), -975600);
});

test('loanValueOn: a feed payment below the interest lets the debt grow', () => {
  // 9 Feb: 30 days × 2.00 = 60.00 interest against a 10.00 payment: +50.00
  assert.equal(loanValueOn(carLoan(), '2026-02-09', [{ day: '2026-02-09', amount: 1000 }]), -1005000);
});

/* ------------------------------------------------- loanValueOn: paying it off */

test('loanValueOn: a payment larger than what is owed stops at zero', () => {
  const small = carLoan({ history: [{ day: '2026-01-10', balance: -50000, note: '' }] });
  // 5 Feb: 26 days × 50000 × 7.3 / 36500 (0.10) = 2.60; principal 297.40 -> 202.60
  // 5 Mar: 28 days × 20260 × 7.3 / 36500 = 1.13; 300.00 − 1.13 exceeds 202.60 -> 0
  assert.equal(loanValueOn(small, '2026-02-05', []), -20260);
  const paidOff = loanValueOn(small, '2026-03-05', []);
  assert.ok(Object.is(paidOff, 0), 'zero, not negative zero');
  assert.equal(loanValueOn(small, '2026-04-05', []), 0);
  assert.equal(loanValueOn(small, '2031-01-01', []), 0);
  assert.equal(loanValueOn(carLoan(), '2026-01-20', [{ day: '2026-01-20', amount: 99999999 }]), 0);
  // nothing after the payoff brings the debt back
  assert.equal(loanValueOn(carLoan(), '2026-03-01', [{ day: '2026-01-20', amount: 99999999 }, { day: '2026-02-20', amount: 100 }]), 0);
});

/* ---------------------------------------------------- loanValueOn: the history */

test('loanValueOn: a day before the first entry has the first entry\'s balance', () => {
  assert.equal(loanValueOn(carLoan(), '2026-01-09', []), -1000000);
  assert.equal(loanValueOn(carLoan(), '2025-06-01', []), -1000000);
  assert.equal(loanValueOn(carLoan(), '2025-06-01', [{ day: '2026-02-07', amount: 30000 }]), -1000000);
});

test('loanValueOn: amortises from the latest entry on or before the day', () => {
  const history = [{ day: '2026-01-10', balance: -1000000, note: '' }, { day: '2026-03-01', balance: -900000, note: 'statement' }];
  for (const loan of [carLoan({ history }), carLoan({ history: [history[1], history[0]] })]) {
    assert.equal(loanValueOn(loan, '2026-02-20', []), -975200);
    assert.equal(loanValueOn(loan, '2026-02-28', []), -975200);
    assert.equal(loanValueOn(loan, '2026-03-01', []), -900000);
    assert.equal(loanValueOn(loan, '2026-03-04', []), -900000);
    // 5 Mar: 4 days × 900000 × 7.3 / 36500 (1.80) = 7.20; principal 292.80 -> 8,707.20
    assert.equal(loanValueOn(loan, '2026-03-05', []), -870720);
  }
});

test('loanValueOn: the payment source is chosen for each entry', () => {
  const loan = carLoan({ history: [{ day: '2026-01-10', balance: -1000000, note: '' }, { day: '2026-03-01', balance: -900000, note: '' }] });
  const payments = [{ day: '2026-02-07', amount: 30000 }];
  assert.equal(loanValueOn(loan, '2026-02-20', payments), -975600); // seen in the feed after the first entry
  assert.equal(loanValueOn(loan, '2026-03-05', payments), -870720); // none seen after the second: assumed
});

test('loanValueOn: no payment information leaves the entry unchanged', () => {
  for (const loan of [
    carLoan({ loan: null }),
    carLoan({ loan: { payment: 30000, assumeScheduled: false } }),
    carLoan({ dueDay: null }),
    carLoan({ dueDay: 0 }),
    carLoan({ dueDay: 32 }),
    carLoan({ dueDay: 5.5 }),
    carLoan({ loan: { payment: 0, assumeScheduled: true } }),
    carLoan({ loan: { payment: NaN, assumeScheduled: true } }),
    carLoan({ loan: { assumeScheduled: true } }),
  ]) {
    assert.equal(loanValueOn(loan, '2027-06-30', []), -1000000);
    assert.equal(loanValueOn(loan, '2027-06-30', undefined), -1000000);
    assert.equal(loanValueOn(loan, '2027-06-30', null), -1000000);
  }
});

test('loanValueOn: an empty history falls back to the account balance', () => {
  assert.equal(loanValueOn(carLoan({ history: [] }), '2026-06-30', []), -1000000);
  assert.equal(loanValueOn(carLoan({ history: [] }), '2026-06-30', [{ day: '2026-02-07', amount: 30000 }]), -1000000);
  assert.equal(loanValueOn(carLoan({ history: undefined }), '2026-06-30', []), -1000000);
  assert.equal(loanValueOn({ history: [], apr: 7.3, dueDay: 5, loan: null }, '2026-06-30', []), 0);
  assert.ok(Object.is(loanValueOn({}, '2026-06-30', []), 0));
  assert.equal(loanValueOn(null, '2026-06-30', []), 0);
  assert.equal(loanValueOn(undefined, '2026-06-30', undefined), 0);
});

test('loanValueOn: malformed rows are skipped, never thrown on', () => {
  const junkHistory = [null, 'x', { day: 'soon', balance: -5 }, { day: '2026-01-12', balance: NaN }, { day: '2026-02-30', balance: -7 }, { balance: -9 }];
  const loan = carLoan({ history: [...junkHistory, { day: '2026-01-10', balance: -1000000, note: '' }] });
  const junkPayments = [null, 7, { day: 'x', amount: 5 }, { day: '2026-02-07', amount: NaN }, { day: '2026-02-07', amount: -5 },
    { day: '2026-02-07', amount: 0 }, { day: '2026-02-07' }, { amount: 30000 }, { day: '2026-02-07', amount: '30000' }];
  assert.equal(loanValueOn(loan, '2026-02-05', junkPayments), -975200); // nothing usable in the feed: assumed schedule
  assert.equal(loanValueOn(loan, '2026-02-07', [...junkPayments, { day: '2026-02-07', amount: 30000 }]), -975600);
  assert.equal(loanValueOn(carLoan({ history: junkHistory }), '2026-02-05', []), -1000000); // nothing usable: account balance
  assert.equal(loanValueOn(carLoan({ apr: 'high' }), '2026-02-05', []), -970000);           // unusable apr: no interest
  assert.equal(loanValueOn(carLoan(), '2026-02-05', 'payments'), -975200);
});

test('loanValueOn: an unreadable day gives the latest entry', () => {
  const loan = carLoan({ history: [{ day: '2026-01-10', balance: -1000000, note: '' }, { day: '2026-03-01', balance: -900000, note: '' }] });
  for (const day of [null, undefined, '', 'tomorrow', '2026-13-01', 20260305]) {
    assert.equal(loanValueOn(loan, day, []), -900000);
  }
});

test('loanValueOn: a balance in the owner\'s favour owes nothing', () => {
  assert.equal(loanValueOn(carLoan({ history: [{ day: '2026-01-10', balance: 2500, note: '' }] }), '2026-06-30', []), 0);
  assert.equal(loanValueOn(carLoan({ history: [{ day: '2026-01-10', balance: 0, note: '' }] }), '2026-06-30', []), 0);
});

test('loanValueOn never mutates the account', () => {
  const loan = carLoan({ history: [{ day: '2026-03-01', balance: -900000, note: '' }, { day: '2026-01-10', balance: -1000000, note: '' }] });
  const before = JSON.stringify(loan);
  loanValueOn(loan, '2026-12-31', [{ day: '2026-04-06', amount: 30000 }, { day: '2026-03-06', amount: 30000 }]);
  assert.equal(JSON.stringify(loan), before);
});

/* ---------------------------------------------------------------------- payoff */

/** ARCHITECTURE section 5, written out independently: exact (fractional) months and interest in cents. */
function closedForm(owed, apr, payment) {
  const r = apr / 100 / 12;
  const months = -Math.log(1 - r * owed / payment) / Math.log(1 + r);
  return { months, interest: months * payment - owed };
}

test('payoff: the closed form, months rounded up and the last payment prorated', () => {
  // $1,000 at 12% (1% a month) paying $100: −ln(0.9) / ln(1.01) = 10.58864 months
  // ten payments of $100 and one of 0.58864 × $100 = $58.86: interest $58.86
  assert.deepEqual(payoff({ owed: 100000, apr: 12, payment: 10000 }), { months: 11, interest: 5886, never: false });
  // paying $400: −ln(0.975) / ln(1.01) = 2.54442: two payments and one of $217.77: interest $17.77
  assert.deepEqual(payoff({ owed: 100000, apr: 12, payment: 40000 }), { months: 3, interest: 1777, never: false });
});

test('payoff: agrees with the formula for a typical card', () => {
  const cases = [
    { owed: 420000, apr: 24.99, payment: 30000 },
    { owed: 420000, apr: 24.99, payment: 12000 },
    { owed: 987654, apr: 5.5, payment: 65000 },
    { owed: 1850000, apr: 7.3, payment: 30000 },
    { owed: 12345, apr: 29.99, payment: 2500 },
  ];
  for (const input of cases) {
    const expected = closedForm(input.owed, input.apr, input.payment);
    const result = payoff(input);
    assert.equal(result.never, false);
    assert.equal(result.months, Math.ceil(expected.months), JSON.stringify(input));
    close(result.interest, expected.interest, 0.5);
    assert.ok(Number.isInteger(result.interest));
  }
  // $4,200 at 24.99% paying $300: 16.72 months
  assert.equal(payoff(cases[0]).months, 17);
});

test('payoff: never, when the payment does not exceed the monthly interest', () => {
  const never = { months: null, interest: null, never: true };
  // $10,000 at 24%: $200 of interest a month
  assert.deepEqual(payoff({ owed: 1000000, apr: 24, payment: 20000 }), never);
  assert.deepEqual(payoff({ owed: 1000000, apr: 24, payment: 19999 }), never);
  assert.deepEqual(payoff({ owed: 1000000, apr: 24, payment: 0 }), never);
  assert.deepEqual(payoff({ owed: 1000000, apr: 24, payment: -500 }), never);
  assert.deepEqual(payoff({ owed: 1000000, apr: 24, payment: NaN }), never);
  // $4,200 at 24.99%: 420000 × 0.2499 / 12 = 8746.5 cents a month
  assert.deepEqual(payoff({ owed: 420000, apr: 24.99, payment: 8746 }), never);
  assert.equal(payoff({ owed: 420000, apr: 24.99, payment: 8747 }).never, false);
});

test('payoff: one cent above the interest pays off, eventually', () => {
  // ln(20001) / ln(1.02) = 500.11 months
  const result = payoff({ owed: 1000000, apr: 24, payment: 20001 });
  assert.equal(result.never, false);
  assert.equal(result.months, 501);
  close(result.interest, closedForm(1000000, 24, 20001).interest, 0.5);
  assert.ok(result.interest > 9000000 && result.interest < 9010000);
});

test('payoff: apr 0 or null is a plain division', () => {
  assert.deepEqual(payoff({ owed: 100000, apr: 0, payment: 30000 }), { months: 4, interest: 0, never: false });
  assert.deepEqual(payoff({ owed: 100000, apr: null, payment: 30000 }), { months: 4, interest: 0, never: false });
  assert.deepEqual(payoff({ owed: 90000, apr: null, payment: 30000 }), { months: 3, interest: 0, never: false });
  assert.deepEqual(payoff({ owed: 100000, payment: 250000 }), { months: 1, interest: 0, never: false });
  assert.deepEqual(payoff({ owed: 100000, apr: 0, payment: 0 }), { months: null, interest: null, never: true });
});

test('payoff: nothing owed takes no time', () => {
  const done = { months: 0, interest: 0, never: false };
  assert.deepEqual(payoff({ owed: 0, apr: 24.99, payment: 30000 }), done);
  assert.deepEqual(payoff({ owed: -5000, apr: 24.99, payment: 30000 }), done);
  assert.deepEqual(payoff({ owed: 0, apr: 24.99, payment: 0 }), done);
  assert.deepEqual(payoff({ owed: NaN, apr: 24.99, payment: 30000 }), done);
  assert.deepEqual(payoff({}), done);
  assert.deepEqual(payoff(null), done);
  assert.deepEqual(payoff(undefined), done);
});

test('payoff: a balance that clears in exactly n payments takes n months', () => {
  // $1,000 at 12%: one payment of $1,010 clears it
  assert.deepEqual(payoff({ owed: 100000, apr: 12, payment: 101000 }), { months: 1, interest: 1000, never: false });
  // $20,100 at 12% paying $10,201: 201.00 interest, then 101.00 on the remaining 10,100.00 — exactly two payments
  assert.deepEqual(payoff({ owed: 2010000, apr: 12, payment: 1020100 }), { months: 2, interest: 30200, never: false });
});

test('payoff: a payment larger than balance plus interest still takes one month', () => {
  const result = payoff({ owed: 100000, apr: 12, payment: 500000 });
  assert.equal(result.months, 1);
  // prorated: −ln(1 − 0.002) / ln(1.01) = 0.2012 of a $5,000 payment = $1,006.0: interest about $6
  close(result.interest, closedForm(100000, 12, 500000).interest, 0.5);
  assert.ok(result.interest >= 0 && result.interest <= 1000);
});

/* ------------------------------------------------------------- payoffSchedule */

test('payoffSchedule: month by month, worked by hand', () => {
  // month 1: 1% of 1,000.00 = 10.00, pay 400.00 -> 610.00
  // month 2: 1% of 610.00 = 6.10, pay 400.00 -> 216.10
  // month 3: the prorated last payment 217.77 clears it; interest 17.77 − 16.10 = 1.67
  assert.deepEqual(payoffSchedule({ owed: 100000, apr: 12, payment: 40000 }), [
    { month: 1, owed: 61000, interest: 1000, paid: 40000 },
    { month: 2, owed: 21610, interest: 610, paid: 40000 },
    { month: 3, owed: 0, interest: 167, paid: 21777 },
  ]);
});

test('payoffSchedule: apr 0 pays the remainder last', () => {
  assert.deepEqual(payoffSchedule({ owed: 100000, apr: 0, payment: 30000 }), [
    { month: 1, owed: 70000, interest: 0, paid: 30000 },
    { month: 2, owed: 40000, interest: 0, paid: 30000 },
    { month: 3, owed: 10000, interest: 0, paid: 30000 },
    { month: 4, owed: 0, interest: 0, paid: 10000 },
  ]);
  assert.deepEqual(payoffSchedule({ owed: 60000, apr: null, payment: 30000 }), [
    { month: 1, owed: 30000, interest: 0, paid: 30000 },
    { month: 2, owed: 0, interest: 0, paid: 30000 },
  ]);
});

test('payoffSchedule: stops at maxMonths', () => {
  // 0.5% a month on 10,000.00: 50.00 -> 9,950.00; 49.75 -> 9,899.75; 49.49875 -> 9,849.25
  assert.deepEqual(payoffSchedule({ owed: 1000000, apr: 6, payment: 10000, maxMonths: 3 }), [
    { month: 1, owed: 995000, interest: 5000, paid: 10000 },
    { month: 2, owed: 989975, interest: 4975, paid: 10000 },
    { month: 3, owed: 984925, interest: 4950, paid: 10000 },
  ]);
  assert.deepEqual(payoffSchedule({ owed: 1000000, apr: 6, payment: 10000, maxMonths: 0 }), []);
  assert.equal(payoffSchedule({ owed: 100000, apr: 12, payment: 40000, maxMonths: 2 }).length, 2);
  assert.equal(payoffSchedule({ owed: 100000, apr: 12, payment: 40000, maxMonths: 50 }).length, 3);
  assert.equal(payoffSchedule({ owed: 100000, apr: 12, payment: 40000, maxMonths: NaN }).length, 3);
});

test('payoffSchedule: a balance that never pays off runs to the limit, growing', () => {
  const rows = payoffSchedule({ owed: 1000000, apr: 24, payment: 10000 });
  assert.equal(rows.length, 360);
  assert.deepEqual(rows[0], { month: 1, owed: 1010000, interest: 20000, paid: 10000 });
  assert.deepEqual(rows[1], { month: 2, owed: 1020200, interest: 20200, paid: 10000 });
  assert.ok(rows.every((row, i) => i === 0 || row.owed > rows[i - 1].owed));
  // paying exactly the interest: flat for ever
  const flat = payoffSchedule({ owed: 1000000, apr: 24, payment: 20000, maxMonths: 12 });
  assert.equal(flat.length, 12);
  assert.ok(flat.every((row) => row.owed === 1000000 && row.interest === 20000 && row.paid === 20000));
});

test('payoffSchedule: nothing owed, or nonsense, is an empty schedule without NaN', () => {
  assert.deepEqual(payoffSchedule({ owed: 0, apr: 12, payment: 10000 }), []);
  assert.deepEqual(payoffSchedule({ owed: -100, apr: 12, payment: 10000 }), []);
  assert.deepEqual(payoffSchedule({}), []);
  assert.deepEqual(payoffSchedule(null), []);
  const absurd = payoffSchedule({ owed: 1000000, apr: 1e9, payment: 10000 });
  assert.ok(absurd.length > 0 && absurd.length < 360);
  assert.ok(absurd.every((row) => Number.isFinite(row.owed) && Number.isFinite(row.interest) && Number.isFinite(row.paid)));
});

test('payoffSchedule agrees with payoff, and with an independent month-by-month simulation', () => {
  for (const owed of [12345, 100000, 420000, 987654, 2010000]) {
    for (const apr of [0, 5.5, 12, 24.99, 29.99]) {
      for (const payment of [2500, 10000, 30000, 65000, 1020100]) {
        const label = JSON.stringify({ owed, apr, payment });
        const plan = payoff({ owed, apr, payment });
        const rows = payoffSchedule({ owed, apr, payment, maxMonths: 2000 });
        if (plan.never) {
          assert.equal(rows.length, 2000, label);
          continue;
        }

        // agreement with payoff: same months, same interest, cleared at the end
        assert.equal(rows.length, plan.months, label);
        assert.equal(rows[rows.length - 1].owed, 0, label);
        assert.equal(rows.reduce((total, row) => total + row.interest, 0), plan.interest, label);
        assert.equal(rows.reduce((total, row) => total + row.paid, 0), owed + plan.interest, label);

        // every row balances, in whole cents, and no payment exceeds the fixed payment
        let before = owed;
        rows.forEach((row, i) => {
          assert.equal(row.month, i + 1, label);
          assert.ok(Number.isInteger(row.owed) && Number.isInteger(row.interest) && Number.isInteger(row.paid), label);
          assert.equal(before + row.interest - row.paid, row.owed, label + ' month ' + row.month);
          assert.ok(row.interest >= 0 && row.paid > 0 && row.paid <= payment, label + ' month ' + row.month);
          // a payment a fraction of a cent above the interest can leave the whole-cent balance where it was
          assert.ok(row.owed <= before, label + ' month ' + row.month);
          before = row.owed;
        });

        // independent simulation: interest on the running balance, then the payment
        const r = apr / 1200;
        let balance = owed;
        let simulatedInterest = 0;
        let simulatedMonths = 0;
        while (balance > 0.005) {
          const interest = balance * r;
          simulatedInterest += interest;
          balance = balance + interest - Math.min(payment, balance + interest);
          simulatedMonths++;
          if (balance > 0.005) {
            close(rows[simulatedMonths - 1].owed, balance, 0.5);
            close(rows[simulatedMonths - 1].interest, interest, 1);
          }
        }
        assert.equal(plan.months, simulatedMonths, label);
        // the closed form prorates the last payment; a full last month costs at most one payment's monthly interest more
        assert.ok(simulatedInterest >= plan.interest - 1 && simulatedInterest - plan.interest <= r * payment + 1,
          label + ': ' + plan.interest + ' vs simulated ' + simulatedInterest);
      }
    }
  }
});

/* ------------------------------------------------------------- requiredGrowth */

test('requiredGrowth: the compound annual rate over whole years', () => {
  // 1 Jan 2026 -> 1 Jan 2030 is 1461 days = exactly 4 years of 365.25 days
  close(requiredGrowth(10000000, 20000000, '2026-01-01', '2030-01-01'), 0.189207115002721, 1e-12);  // 2^(1/4) − 1
  close(requiredGrowth(10000000, 160000000, '2026-01-01', '2030-01-01'), 1, 1e-12);                  // doubling every year
  close(requiredGrowth(10000000, 5000000, '2026-01-01', '2030-01-01'), -0.159103584746285, 1e-12);   // 0.5^(1/4) − 1
  close(requiredGrowth(10000000, 10000000, '2026-01-01', '2030-01-01'), 0, 1e-12);
  // 1 Jan 2026 -> 1 Jan 2034 is 2922 days = exactly 8 years
  close(requiredGrowth(500, 1500, '2026-01-01', '2034-01-01'), 0.147202690439877, 1e-12);            // 3^(1/8) − 1
});

test('requiredGrowth: fractional years', () => {
  // 11 Nov 2026 -> 31 Dec 2029 is 1146 days = 3.13758 years; $75,000 -> $1,000,000
  const expected = Math.exp(Math.log(100000000 / 7500000) * 365.25 / 1146) - 1;
  close(requiredGrowth(7500000, 100000000, '2026-11-11', '2029-12-31'), expected, 1e-12);
  close(requiredGrowth(7500000, 100000000, '2026-11-11', '2029-12-31'), 1.2832, 5e-4);
  // half a year (rounded to 183 days): 10% in six months is about 21% a year
  close(requiredGrowth(100000, 110000, '2026-01-01', '2026-07-03'), Math.pow(1.1, 365.25 / 183) - 1, 1e-12);
  close(requiredGrowth(100000, 110000, '2026-01-01', '2026-07-03'), 0.2095, 5e-4);
});

test('requiredGrowth: null when there is nothing to grow from or no time to grow in', () => {
  assert.equal(requiredGrowth(0, 100000000, '2026-11-11', '2029-12-31'), null);
  assert.equal(requiredGrowth(-500, 100000000, '2026-11-11', '2029-12-31'), null);
  assert.equal(requiredGrowth(NaN, 100000000, '2026-11-11', '2029-12-31'), null);
  assert.equal(requiredGrowth(null, 100000000, '2026-11-11', '2029-12-31'), null);
  assert.equal(requiredGrowth(7500000, 100000000, '2026-11-11', '2026-11-11'), null);
  assert.equal(requiredGrowth(7500000, 100000000, '2029-12-31', '2026-11-11'), null);
  assert.equal(requiredGrowth(7500000, 100000000, null, '2029-12-31'), null);
  assert.equal(requiredGrowth(7500000, 100000000, '2026-11-11', 'someday'), null);
  assert.equal(requiredGrowth(7500000, NaN, '2026-11-11', '2029-12-31'), null);
  assert.equal(requiredGrowth(7500000, -1, '2026-11-11', '2029-12-31'), null);
  assert.equal(requiredGrowth(7500000, undefined, '2026-11-11', '2029-12-31'), null);
  // a tenfold rise by tomorrow is not a rate anyone can print
  assert.equal(requiredGrowth(100, 1000, '2026-11-11', '2026-11-12'), null);
});

test('requiredGrowth: a target of zero is a total loss', () => {
  assert.equal(requiredGrowth(7500000, 0, '2026-01-01', '2030-01-01'), -1);
});

test('loanValueOn: before the first entry the feed payments up to it are undone, principal only', () => {
  const account = makeAccount({
    type: 'loan', balance: -1000000, apr: 7.3, dueDay: 1, loan: { payment: 30000, assumeScheduled: false },
    history: [{ day: '2026-05-01', balance: -1000000, note: '' }],
  });
  const payments = [{ day: '2026-03-01', amount: 30000 }, { day: '2026-04-01', amount: 30000 }, { day: '2026-06-01', amount: 30000 }];
  assert.equal(loanValueOn(account, '2026-04-30', payments), -1000000);
  assert.equal(loanValueOn(account, '2026-04-01', payments), -1000000, 'the payment of Apr 1 is in the Apr 1 close');
  // Apr 1 follows Mar 1 by 31 days: owed before = (1,000,000.00 + 300.00) / (1 + 0.073 × 31 / 365) = 1,023,653.49
  const march = loanValueOn(account, '2026-03-31', payments);
  assert.equal(march, -Math.round(1030000 / (1 + 0.073 * 31 / 365)));
  assert.equal(splitPayment(-march, 7.3, 30000, 31).principal, -1000000 - march, 'the same split the payment has going forward');
  const february = loanValueOn(account, '2026-02-28', payments);
  assert.ok(february < march && february > march - 30000, 'the earliest payment is undone with a month of interest');
  assert.equal(loanValueOn(account, '2025-01-01', payments), february, 'nothing is known before the first payment in the feed');
  assert.equal(loanValueOn(account, '2026-03-31', []), -1000000, 'with no payment before the entry its balance is all that is known');
  assert.equal(loanValueOn({ ...account, apr: null }, '2026-03-31', payments), -1030000);
});
