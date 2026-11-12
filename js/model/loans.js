/**
 * Loan and card arithmetic with no dependency on the ledger (so the ledger can use it).
 * Pure. Imports: dates, money only.
 */

import { addMonths, addMonthsYm, diffDays, isYmd, monthOf, startOfMonth } from './dates.js';
import { roundCents } from './money.js';

/** Daily interest uses apr / 365 (ARCHITECTURE 4.2); payoff uses a monthly rate of apr / 12 (section 5). */
const INTEREST_DAYS_PER_YEAR = 365;
const MONTHS_PER_YEAR = 12;
/** Length of a year when a span of days is turned into fractional years. */
const DAYS_PER_YEAR = 365.25;
const DEFAULT_MAX_MONTHS = 360;
/** A payment equal to the monthly interest must read as "never" even when apr / 12 is not exact in binary. */
const RATE_TOLERANCE = 1e-12;

/**
 * Value of an amortising loan at the end of `day` (ARCHITECTURE 4.2), as a SIGNED balance (<= 0).
 * Start from the latest `history` entry with day <= `day`. From that entry's day,
 * interest accrues daily at apr/365 on the outstanding amount; each payment reduces the amount owed by
 * (payment − interest accrued since the previous event), never below zero.
 * Payments are `payments` (days and cents, from the feed) when any exist after the entry; otherwise,
 * when `assumeScheduled` and a due day is known, one payment of `payment` on each due day.
 * With no apr, interest is 0; with no payment information the entry's balance is returned unchanged.
 * Before the first entry the loan is worked backward from it over the feed payments made up to the
 * entry's day (their principal is put back), so a payment is part interest, part principal on every day.
 * The value moves only on payment days: interest decides how much of a payment is principal and is
 * not added to the value between payments (the ledger accrues it as a bill, ARCHITECTURE 4.3).
 * @param {{ history: { day: string, balance: number }[], apr: number|null, dueDay: number|null,
 *           loan: { payment: number, assumeScheduled: boolean }|null }} account
 * @param {string} day
 * @param {{ day: string, amount: number }[]} payments   payments seen in the feed, any order
 * @returns {number} signed cents (<= 0)
 */
export function loanValueOn(account, day, payments) {
  const entries = historyEntries(account);
  if (!entries.length) return signedOwed(owedFrom(account ? account.balance : null));
  if (!isYmd(day)) return signedOwed(owedFrom(entries[entries.length - 1].balance));

  if (day < entries[0].day) return signedOwed(owedBefore(account, entries[0], day, payments));
  const entry = entries.findLast((e) => e.day <= day);
  let owed = owedFrom(entry.balance);
  let since = entry.day;
  for (const payment of paymentEvents(account, entry.day, day, payments)) {
    if (owed === 0) break;
    owed -= splitPayment(owed, account.apr, payment.amount, diffDays(since, payment.day)).principal;
    since = payment.day;
  }
  return signedOwed(owed);
}

/**
 * What was owed at the end of a day before the first entry: the entry's balance with the principal of
 * every feed payment made after that day, up to and including the entry's day, put back. Each payment
 * is undone with the split it had: owed before = (owed after + payment) / (1 + rate × days since the
 * payment before it), a month when the feed holds no earlier payment. With no such payments the
 * entry's balance is all that is known.
 */
function owedBefore(account, entry, day, payments) {
  const seen = (Array.isArray(payments) ? payments : [])
    .filter((p) => p && isYmd(p.day) && p.day <= entry.day && positive(p.amount) > 0)
    .sort(byDay);
  let owed = owedFrom(entry.balance);
  for (let i = seen.length - 1; i >= 0 && seen[i].day > day; i--) {
    const days = i > 0 ? diffDays(seen[i - 1].day, seen[i].day) : DAYS_PER_YEAR / MONTHS_PER_YEAR;
    const growth = 1 + annualRate(account.apr) * days / INTEREST_DAYS_PER_YEAR;
    owed = roundCents(Math.max(owed, (owed + positive(seen[i].amount)) / growth));
  }
  return owed;
}

/**
 * Interest that accrues on a debt in one day at an annual percentage rate.
 * @param {number} owed  cents owed (positive)
 * @param {number|null} apr  e.g. 24.99
 * @returns {number} cents (fractional)
 */
export function dailyInterest(owed, apr) {
  return positive(owed) * annualRate(apr) / INTEREST_DAYS_PER_YEAR;
}

/**
 * Split a loan payment into interest and principal for a balance and a number of days since the last payment.
 * `interest` is everything that accrued; `principal` is what the payment takes off the debt, so it is
 * negative when the payment does not cover the interest (the debt grows by the unpaid part).
 * @returns {{ interest: number, principal: number }} integer cents; principal never exceeds the amount owed
 */
export function splitPayment(owed, apr, payment, days) {
  const due = positive(owed);
  const interest = roundCents(dailyInterest(due, apr) * positive(days));
  const principal = roundCents(Math.min(due, positive(payment) - interest));
  return { interest, principal };
}

/**
 * Months to pay off a balance with a fixed monthly payment at an APR (ARCHITECTURE section 5).
 * @param {{ owed: number, apr: number|null, payment: number }} input  cents
 * @returns {{ months: number|null, interest: number|null, never: boolean }}
 *   never = the payment does not exceed the monthly interest; months is a whole number (last payment may be smaller);
 *   with apr null or 0: months = ceil(owed / payment), interest 0.
 */
export function payoff(input) {
  const { owed, payment, rate } = payoffTerms(input);
  if (owed === 0) return { months: 0, interest: 0, never: false };
  if (payment <= owed * rate * (1 + RATE_TOLERANCE)) return { months: null, interest: null, never: true };
  if (rate === 0) return { months: Math.ceil(owed / payment), interest: 0, never: false };

  const exactMonths = -Math.log1p(-rate * owed / payment) / Math.log1p(rate);
  const fullPayments = Math.floor(exactMonths);
  // The prorated last payment, in whole cents. One that rounds to nothing is not a month: this also
  // keeps a balance that clears in exactly n payments at n when the logarithms land a hair above it.
  const lastPayment = roundCents((exactMonths - fullPayments) * payment);
  return {
    months: fullPayments + (lastPayment > 0 ? 1 : 0),
    interest: fullPayments * payment + lastPayment - owed,
    never: false,
  };
}

/**
 * Month-by-month payoff schedule, for charts.
 * Agrees with `payoff` to the cent: as many rows as its months, interest adding up to its interest, and
 * a last payment prorated the same way. Every row balances: owed before + interest − paid = owed after.
 * @param {{ owed: number, apr: number|null, payment: number, maxMonths?: number }} input
 * @returns {{ month: number, owed: number, interest: number, paid: number }[]}  owed after each month; stops at zero or maxMonths (default 360)
 */
export function payoffSchedule(input) {
  const { owed, payment, rate } = payoffTerms(input);
  const plan = payoff(input);
  const lastMonth = Math.min(plan.never ? Infinity : plan.months, maxMonthsOf(input));
  const rows = [];
  let balance = owed;       // unrounded, so rounding never drifts from the closed form
  let accrued = 0;          // unrounded interest to date
  let interestSoFar = 0;    // whole cents already given to earlier rows
  let paidSoFar = 0;
  for (let month = 1; month <= lastMonth; month++) {
    accrued += balance * rate;
    balance = balance * (1 + rate) - payment;
    if (!Number.isFinite(accrued)) break; // an absurd rate that never pays off outgrows what a number can hold
    const closing = month === plan.months;
    const interestToDate = closing ? plan.interest : roundCents(accrued);
    const paidToDate = closing ? owed + plan.interest : month * payment;
    rows.push({
      month,
      owed: owed + interestToDate - paidToDate,
      interest: interestToDate - interestSoFar,
      paid: paidToDate - paidSoFar,
    });
    interestSoFar = interestToDate;
    paidSoFar = paidToDate;
  }
  return rows;
}

/**
 * Compound annual growth rate needed to go from `current` to `target` between two days.
 * @returns {number|null} e.g. 1.217 for 121.7% a year; null when current <= 0 or the span is not positive
 */
export function requiredGrowth(current, target, fromDay, toDay) {
  if (!(current > 0) || !Number.isFinite(current) || !(target >= 0) || !Number.isFinite(target)) return null;
  if (!isYmd(fromDay) || !isYmd(toDay) || toDay <= fromDay) return null;
  const years = diffDays(fromDay, toDay) / DAYS_PER_YEAR;
  const rate = Math.pow(target / current, 1 / years) - 1;
  return Number.isFinite(rate) ? rate : null;
}

/* ------------------------------------------------------------------- helpers */

/** A finite number above zero, else 0. */
function positive(x) {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** An APR such as 24.99 as a yearly fraction; 0 when there is none. */
function annualRate(apr) {
  return positive(apr) / 100;
}

/** Whole cents owed for a signed balance; a balance in the owner's favour owes nothing. */
function owedFrom(balance) {
  return Math.round(positive(-balance));
}

function signedOwed(owed) {
  return roundCents(-owed);
}

/** Usable history entries, oldest first; of two entries for one day the later one in the list wins. */
function historyEntries(account) {
  const history = account && Array.isArray(account.history) ? account.history : [];
  return history
    .filter((e) => e && isYmd(e.day) && Number.isFinite(e.balance))
    .sort(byDay);
}

/**
 * The payments that move the loan after `entryDay`, up to `untilDay`, oldest first.
 * Which source applies is decided on everything after the entry (not only up to `untilDay`), so
 * every day is valued on the same timeline.
 */
function paymentEvents(account, entryDay, untilDay, payments) {
  const seen = (Array.isArray(payments) ? payments : [])
    .filter((p) => p && isYmd(p.day) && p.day > entryDay && positive(p.amount) > 0)
    .sort(byDay);
  const events = seen.length ? seen : scheduledPayments(account, entryDay, untilDay);
  return events.filter((p) => p.day <= untilDay);
}

/** One assumed payment on each due day after `afterDay` (a due day past the month's end falls on its last day). */
function scheduledPayments(account, afterDay, untilDay) {
  const { loan, dueDay } = account;
  const amount = loan && loan.assumeScheduled ? positive(loan.payment) : 0;
  if (!amount || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return [];
  const out = [];
  const lastMonth = monthOf(untilDay);
  for (let ym = monthOf(afterDay); ym <= lastMonth; ym = addMonthsYm(ym, 1)) {
    const day = addMonths(startOfMonth(ym), 0, dueDay);
    if (day > afterDay) out.push({ day, amount });
  }
  return out;
}

/** Whole-cent balance and payment, and the monthly rate, of a payoff question. */
function payoffTerms(input) {
  const { owed, apr, payment } = input || {};
  return {
    owed: Math.round(positive(owed)),
    payment: Math.round(positive(payment)),
    rate: annualRate(apr) / MONTHS_PER_YEAR,
  };
}

function maxMonthsOf(input) {
  const max = input ? input.maxMonths : undefined;
  return Number.isFinite(max) && max >= 0 ? Math.floor(max) : DEFAULT_MAX_MONTHS;
}

function byDay(a, b) {
  return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
}
