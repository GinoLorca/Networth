/**
 * The Book: schedules of recurring charges and of paydays. See ARCHITECTURE.md section 6.
 * Pure. Imports: schema, dates, money only. Must NOT import ledger.
 */

import { CADENCES } from './schema.js';
import { addDays, addMonths, addMonthsYm, daysInMonth, diffDays, isYmd, monthOf, parts, startOfMonth } from './dates.js';
import { roundCents, sum } from './money.js';

/** How each cadence steps: a fixed number of days, a number of months, or twice a month. */
const STEPS = {
  weekly: { days: 7 },
  biweekly: { days: 14 },
  semimonthly: { twiceMonthly: true },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  semiannual: { months: 6 },
  annual: { months: 12 },
};

/** Entries charged this many times a year or fewer are renewals worth advance notice (quarterly or longer). */
const RENEWAL_MAX_PER_YEAR = 4;

const LAST_DAY = 31;

/**
 * Days on which something with a cadence occurs, strictly after `afterDay` and up to `untilDay` inclusive.
 *  weekly / biweekly: anchor ± k × 7 / 14 days.
 *  semimonthly: twice a month, 15 or 16 days apart — the anchor's day of month and the day of month
 *    15 days from it (a "last day of month" anchor stays the last day).
 *  monthly / quarterly / semiannual / annual: the anchor's day of month every 1 / 3 / 6 / 12 months,
 *    clamped to the end of shorter months (an anchor on the 31st stays month-end).
 * Works for anchors in the past or the future. A line the owner added by hand (source 'manual', or a
 * `since` day) is the exception: nothing is known of it before the anchor the owner gave or the day
 * it was added, so it has no occurrence before either — a first charge on Jul 20 is not also
 * expected on Jun 20.
 * @param {{ cadence: string, anchor: string, source?: string, since?: string|null }} item
 * @param {string} afterDay
 * @param {string} untilDay
 * @returns {string[]} ascending
 */
export function occurrences(item, afterDay, untilDay) {
  if (!hasSchedule(item) || !isYmd(afterDay) || !isYmd(untilDay)) return [];
  const first = firstDayOf(item);
  if (first !== null && afterDay < first) afterDay = addDays(first, -1);
  if (afterDay >= untilDay) return [];
  const step = STEPS[item.cadence];
  if (step.days) return everyDays(item.anchor, step.days, afterDay, untilDay);
  if (step.months) return everyMonths(item.anchor, step.months, afterDay, untilDay, dayOfMonthOf(item));
  return twiceMonthly(item.anchor, afterDay, untilDay);
}

/** The first occurrence strictly after `afterDay` (searching up to two years ahead), or null. */
export function nextOccurrence(item, afterDay) {
  if (!hasSchedule(item) || !isYmd(afterDay)) return null;
  const first = firstDayOf(item);
  if (first !== null && afterDay < first) afterDay = addDays(first, -1); // a hand-added line starts at its anchor, however far ahead
  // Every cadence recurs within one period, so looking one longest period ahead finds the same day
  // a two-year search would, without listing two years of weekly occurrences.
  const found = occurrences(item, afterDay, addDays(afterDay, longestGap(item.cadence)));
  return found.length ? found[0] : null;
}

/**
 * The latest occurrence on or before `day` (the anchor itself counts), or null when the schedule starts later.
 * A detected schedule runs both ways from its anchor, so a day before the anchor still has an occurrence;
 * a line added by hand has none before its anchor or the day it was added. Null also means the item has
 * no usable cadence or anchor.
 */
export function lastOccurrence(item, day) {
  if (!hasSchedule(item) || !isYmd(day)) return null;
  const found = occurrences(item, addDays(day, -longestGap(item.cadence)), day);
  return found.length ? found[found.length - 1] : null;
}

/** Cost per year of a Book entry, cents. */
export function annualCost(rec) {
  return hasCost(rec) ? roundCents(rec.amount * CADENCES[rec.cadence].perYear) : 0;
}

/** Cost per day of a Book entry, cents (fractional): amount / cadence days. */
export function dailyCost(rec) {
  return hasCost(rec) ? rec.amount / CADENCES[rec.cadence].days : 0;
}

/**
 * Everything the Book expects from `fromDay` (inclusive) for `days` days: one row per occurrence of
 * every active entry, soonest first.
 * @param {object} state
 * @param {string} fromDay
 * @param {number} days
 * @returns {{ id: string, name: string, day: string, amount: number, accountId: string|null, category: string,
 *             purpose: string, variable: boolean, essential: boolean }[]}
 */
export function upcoming(state, fromDay, days) {
  const rows = [];
  const charged = lastChargeDays(state);
  for (const rec of activeEntries(state)) {
    if (rec.byHand === true && !runsByHand(rec)) continue; // a payment the owner sends without a day to send it on: on no list
    const listed = occurrencesFrom(rec, fromDay, days);
    // a payment the owner sends is settled by its own rule: by the row or the tick of that occurrence
    const paid = rec.byHand === true && listed.length ? paidDays(byHandStandingOf(state, rec, listed[listed.length - 1])) : null;
    for (const day of listed) {
      if (paid ? paid.has(day) : charged.get(rec.id) >= day) continue; // it has already posted (a charge dated today)
      rows.push({
        id: rec.id, name: rec.name, day, amount: rec.amount, accountId: rec.accountId ?? null,
        category: categoryOf(rec), purpose: purposeOf(rec), variable: !!rec.variable, essential: !!rec.essential,
      });
    }
  }
  return rows.sort(byDay);
}

/**
 * Totals of the active Book.
 * @param {object} state
 * @returns {{ count: number, perMonth: number, perYear: number, perDay: number,
 *             byPurpose: { purpose: string, perMonth: number }[],
 *             byCategory: { category: string, perMonth: number }[],
 *             review: number, cut: number }}   review / cut = monthly cents carrying those verdicts
 */
export function bookTotals(state) {
  const entries = activeEntries(state);
  return {
    count: entries.length,
    perMonth: sum(entries, monthlyCost),
    perYear: sum(entries, annualCost),
    perDay: roundCents(sum(entries, dailyCost)),
    byPurpose: monthlyBy(entries, 'purpose', purposeOf),
    byCategory: monthlyBy(entries, 'category', categoryOf),
    review: sum(entries.filter((rec) => rec.verdict === 'review'), monthlyCost),
    cut: sum(entries.filter((rec) => rec.verdict === 'cut'), monthlyCost),
  };
}

/**
 * Renewals that deserve advance notice: occurrences in the next `days` days of entries with a cadence
 * of quarterly or longer, soonest first, with how much has accrued toward each.
 * @returns {{ id: string, name: string, day: string, amount: number, inDays: number, setAside: number }[]}
 *   setAside = amount × (days since the previous occurrence / cadence days), capped at amount
 */
export function renewals(state, fromDay, days) {
  const rows = [];
  const charged = lastChargeDays(state);
  for (const rec of activeEntries(state)) {
    const cadence = CADENCES[rec.cadence];
    if (cadence.perYear > RENEWAL_MAX_PER_YEAR) continue;
    for (const day of occurrencesFrom(rec, fromDay, days)) {
      const previous = lastOccurrence(rec, addDays(day, -1));
      // A second renewal inside the window follows one that has not happened yet: nothing accrued.
      const elapsed = previous === null ? 0 : Math.max(0, diffDays(previous, fromDay));
      // a line entered by hand with its NEXT charge as the anchor, and never yet charged, has no earlier occurrence to count from
      const neverCharged = rec.source === 'manual' && !charged.has(rec.id) && rec.anchor > fromDay;
      const setAside = neverCharged ? 0 : roundCents(Math.min(rec.amount, rec.amount * elapsed / cadence.days));
      rows.push({ id: rec.id, name: rec.name, day, amount: rec.amount, inDays: diffDays(fromDay, day), setAside });
    }
  }
  return rows.sort(byDay);
}

/** How far from its day a bank row may be and still settle an occurrence of a payment the owner sends. */
const BY_HAND_REACH_DAYS = 16;
/** How far past the last day asked about the schedule is read, so that next month's payment made early is not taken for this month's. */
const BY_HAND_AHEAD_DAYS = 31;
/** Unpaid occurrences of earlier months that are still shown and still due, per payment: the newest ones. */
export const BY_HAND_ARREARS = 12;

/**
 * Which occurrence of a payment the owner sends each of its bank rows settles: the one rule the clock,
 * the Book and the checklist read.
 *  - A row dated before `entry.since` settles nothing (it is history), except a row within 16 days
 *    before the entry's first occurrence and nearer it than the schedule day before it: that row
 *    settles the first occurrence (rent due the 1st and sent on the 31st is paid).
 *  - A row belongs to the occurrence nearest its day (the earlier one on a tie), the schedule being read
 *    31 days past `untilDay`; to none when the nearest is more than 16 days away.
 *  - Rows are taken oldest first. The first row of an occurrence settles it; a further row of an
 *    occurrence a row already settled settles the oldest earlier occurrence that has neither a row nor
 *    a tick with paid true, and nothing when there is none. An occurrence past `untilDay` takes its
 *    rows in the same way (it is only not returned), so the answer for a day does not depend on
 *    which later day was asked about.
 * An occurrence is paid when it has a row or a tick with paid true.
 * @param {object} entry  a by-hand Recurring
 * @param {{ id: string, day: string }[]} rows  its posted rows
 * @param {string} untilDay
 * @returns {{ day: string, row: { id: string, day: string }|null, tick: { paid: boolean, at: number }|null }[]}
 *   one item per occurrence from the first through `untilDay`, ascending
 */
export function byHandStanding(entry, rows, untilDay) {
  if (!hasSchedule(entry) || !isYmd(untilDay)) return [];
  const schedule = occurrences(entry, FIRST_DAY, addDays(untilDay, BY_HAND_AHEAD_DAYS));
  const marks = entry.marks !== null && typeof entry.marks === 'object' ? entry.marks : {};
  // every day of the schedule that was read takes part, so that a row sent early for an occurrence past
  // `untilDay` is counted for that one whatever day is asked about; only the days through `untilDay` are returned
  const standing = schedule.map((day) => ({ day, row: null, tick: tickOf(marks, day) }));
  const since = isYmd(entry.since) ? entry.since : null;
  // a row before `since` counts only when it was sent early for the first occurrence: within reach of it, and nearer it than the schedule day before
  const first = schedule.length ? schedule[0] : null;
  const before = first === null ? null : addMonths(startOfMonth(monthOf(first)), -1, dayOfMonthOf(entry));
  const forFirst = (day) => first !== null && day < first && diffDays(day, first) <= BY_HAND_REACH_DAYS && diffDays(day, first) < diffDays(before, day);
  const sent = (Array.isArray(rows) ? rows : [])
    .filter((row) => row !== null && typeof row === 'object' && isYmd(row.day) && (since === null || row.day >= since || forFirst(row.day)))
    .map((row) => ({ id: row.id, day: row.day, pending: row.pending === true, at: Number.isFinite(row.at) ? row.at : 0 }))
    .sort(inBankOrder);
  for (const sentRow of sent) {
    const row = { id: sentRow.id, day: sentRow.day, pending: sentRow.pending };
    const i = nearestIndex(schedule, row.day);
    if (i < 0 || Math.abs(diffDays(schedule[i], row.day)) > BY_HAND_REACH_DAYS) continue;
    if (standing[i].row === null) {
      standing[i].row = row;
      continue;
    }
    const owed = standing.slice(0, i).find((item) => !isPaid(item));
    if (owed) owed.row = row;
  }
  return standing.filter((item) => item.day <= untilDay);
}

/**
 * byHandStanding read from the document: the entry's rows are the posted bank rows linked to it.
 * @returns {{ day: string, row: { id: string, day: string }|null, tick: { paid: boolean, at: number }|null }[]}
 */
export function byHandStandingOf(state, entry, untilDay, withPending) {
  const rows = [];
  const txs = state && Array.isArray(state.txs) ? state.txs : [];
  const counted = withPending === undefined ? countsPending(state) : withPending === true;
  if (entry && typeof entry.id === 'string') {
    for (const tx of txs) {
      if (!tx || tx.recurringId !== entry.id || tx.kind === 'decline' || tx.matchId || tx.source === 'manual') continue;
      if (tx.pending && !counted) continue;
      rows.push(tx);
    }
  }
  return byHandStanding(entry, rows, untilDay);
}

/**
 * The one test of a payment the owner sends that runs: the ledger, the Book and the checklist all ask
 * it, so an entry is on all of their lists or on none.
 * @param {object} entry
 * @returns {boolean}
 */
export function runsByHand(entry) {
  return entry !== null && typeof entry === 'object' && entry.byHand === true && !!entry.active && entry.cadence === 'monthly' &&
    Number.isInteger(entry.dueDay) && entry.dueDay >= 1 && entry.dueDay <= LAST_DAY && isYmd(entry.anchor) &&
    Number.isFinite(entry.amount) && entry.amount > 0;
}

/** Whether pending rows count, as the ledger reads the setting: on unless it was switched off. */
function countsPending(state) {
  const settings = state !== null && typeof state === 'object' && state.settings !== null && typeof state.settings === 'object' ? state.settings : {};
  return settings.countPending === undefined ? true : !!settings.countPending;
}

/** Rows oldest first; of one day the posted before the pending, then by the time the bank gave, then by id. */
function inBankOrder(a, b) {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.pending !== b.pending) return a.pending ? 1 : -1;
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/**
 * The unpaid occurrences of a payment the owner sends whose day is before `beforeDay`: every one of
 * the month of `beforeDay`, and of the earlier months the BY_HAND_ARREARS newest. Ascending. The clock
 * and the checklist both read their arrears here, so they name the same ones.
 * @returns {{ day: string, row: null, tick: { paid: boolean, at: number }|null }[]}
 */
export function byHandUnpaid(state, entry, beforeDay) {
  if (!isYmd(beforeDay)) return [];
  const monthStart = startOfMonth(monthOf(beforeDay));
  const unpaid = byHandStandingOf(state, entry, addDays(beforeDay, -1)).filter((item) => !isPaid(item));
  const earlier = unpaid.filter((item) => item.day < monthStart);
  return earlier.slice(Math.max(0, earlier.length - BY_HAND_ARREARS)).concat(unpaid.filter((item) => item.day >= monthStart));
}

const FIRST_DAY = '1970-01-01';

function tickOf(marks, day) {
  const mark = Object.hasOwn(marks, day) ? marks[day] : null;
  if (mark === null || typeof mark !== 'object') return null;
  return { paid: mark.paid === true, at: Number.isFinite(mark.at) ? mark.at : 0 };
}

function isPaid(item) {
  return item.row !== null || (item.tick !== null && item.tick.paid === true);
}

function paidDays(standing) {
  return new Set(standing.filter(isPaid).map((item) => item.day));
}

/** The index of the day of an ascending list nearest `day` (the earlier one on a tie), or -1 for an empty list. */
function nearestIndex(days, day) {
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < days.length; i++) {
    const gap = Math.abs(diffDays(days[i], day));
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/** The day of the latest transaction linked to each Book entry. */
function lastChargeDays(state) {
  const latest = new Map();
  const txs = state && Array.isArray(state.txs) ? state.txs : [];
  for (const tx of txs) {
    if (!tx || !tx.recurringId || !isYmd(tx.day) || tx.kind === 'decline') continue;
    const seen = latest.get(tx.recurringId);
    if (!seen || tx.day > seen) latest.set(tx.recurringId, tx.day);
  }
  return latest;
}

/* ------------------------------------------------------------------ schedules */

/**
 * The earliest day a hand-added line can occur: its anchor, or the day it was added when that is
 * later. Null for everything else (a detected schedule runs both ways from its anchor).
 */
function firstDayOf(item) {
  const since = isYmd(item.since) ? item.since : null;
  if (item.source !== 'manual' && since === null) return null;
  return since !== null && since > item.anchor ? since : item.anchor;
}

/**
 * The day of the month a schedule keeps. A payment the owner sends keeps its `dueDay` (31 is the last
 * day of every month), whatever shorter month its anchor fell in; anything else keeps its anchor's day.
 */
function dayOfMonthOf(item) {
  if (item.byHand === true && Number.isInteger(item.dueDay) && item.dueDay >= 1 && item.dueDay <= LAST_DAY) return item.dueDay;
  return parts(item.anchor).d;
}

function hasSchedule(item) {
  return !!item && Object.hasOwn(STEPS, item.cadence) && isYmd(item.anchor);
}

/** Days no shorter than the longest gap between two occurrences of a cadence (a 31-day month, a leap year). */
function longestGap(cadence) {
  return Math.ceil(CADENCES[cadence].days) + 2;
}

function everyDays(anchor, step, afterDay, untilDay) {
  const out = [];
  const first = Math.floor(diffDays(anchor, afterDay) / step) + 1;
  for (let day = addDays(anchor, first * step); day <= untilDay; day = addDays(day, step)) out.push(day);
  return out;
}

function everyMonths(anchor, step, afterDay, untilDay, anchorDay) {
  const out = [];
  // The occurrence in or just before afterDay's month; everything earlier is certainly not after it.
  for (let k = Math.floor(monthsApart(anchor, afterDay) / step); ; k++) {
    const day = addMonths(anchor, k * step, anchorDay);
    if (day > untilDay) return out;
    if (day > afterDay) out.push(day);
  }
}

function twiceMonthly(anchor, afterDay, untilDay) {
  const out = [];
  const pair = semimonthlyDays(anchor);
  const lastMonth = monthOf(untilDay);
  for (let ym = monthOf(afterDay); ym <= lastMonth; ym = addMonthsYm(ym, 1)) {
    for (const dayOfMonth of pair) {
      const day = addMonths(startOfMonth(ym), 0, dayOfMonth); // clamps to the month's length
      if (day > afterDay && day <= untilDay) out.push(day);
    }
  }
  return out;
}

/** The two days of the month of a semimonthly schedule, earlier first. A month-end anchor pairs the 15th with month-end. */
function semimonthlyDays(anchor) {
  const { d } = parts(anchor);
  if (d === daysInMonth(monthOf(anchor))) return [15, LAST_DAY];
  return d <= 15 ? [d, d + 15] : [d - 15, d];
}

/** Whole calendar months from a's month to b's month. */
function monthsApart(a, b) {
  const from = parts(a), to = parts(b);
  return (to.y - from.y) * 12 + (to.m - from.m);
}

/** Occurrences from `fromDay` inclusive for `days` days. */
function occurrencesFrom(item, fromDay, days) {
  if (!isYmd(fromDay) || !Number.isFinite(days) || days < 1) return [];
  return occurrences(item, addDays(fromDay, -1), addDays(fromDay, Math.floor(days) - 1));
}

/* --------------------------------------------------------------------- costs */

function hasCost(rec) {
  return !!rec && Object.hasOwn(CADENCES, rec.cadence) && Number.isFinite(rec.amount) && rec.amount >= 0;
}

/** Whole cents per month, so that every breakdown adds up to the monthly total exactly. */
function monthlyCost(rec) {
  return roundCents(annualCost(rec) / 12);
}

function activeEntries(state) {
  const list = state && Array.isArray(state.recurring) ? state.recurring : [];
  return list.filter((rec) => rec && rec.active && hasCost(rec));
}

function purposeOf(rec) {
  return rec.purpose || 'personal';
}

function categoryOf(rec) {
  return rec.category || 'other';
}

/** Monthly cents grouped by a key, largest first: [{ [field]: key, perMonth }]. */
function monthlyBy(entries, field, keyOf) {
  const totals = new Map();
  for (const rec of entries) totals.set(keyOf(rec), (totals.get(keyOf(rec)) || 0) + monthlyCost(rec));
  return [...totals]
    .map(([key, perMonth]) => ({ [field]: key, perMonth }))
    .sort((a, b) => b.perMonth - a.perMonth || (a[field] < b[field] ? -1 : 1));
}

function byDay(a, b) {
  return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
}

/** Cadences without a linked row after which a Book entry has lapsed: it stops accruing and is no longer awaited. */
export const BILL_LAPSE_PERIODS = 1.5;

/**
 * Whether an entry has lapsed on `today`: more than BILL_LAPSE_PERIODS cadences have passed since its
 * last linked row (`lastDay`), or since its anchor when no row was ever linked. False without a cadence.
 */
export function entryLapsed(entry, lastDay, today) {
  if (runsByHand(entry)) return false; // a payment the owner sends stays owed until it is paid or switched off
  const cadence = entry && typeof entry.cadence === 'string' && Object.hasOwn(CADENCES, entry.cadence) ? CADENCES[entry.cadence] : null;
  const from = isYmd(lastDay) ? lastDay : entry && isYmd(entry.anchor) ? entry.anchor : null;
  if (!cadence || !Number.isFinite(cadence.days) || from === null || !isYmd(today)) return false;
  return diffDays(from, today) > BILL_LAPSE_PERIODS * cadence.days;
}

/**
 * How many days before its day a linked row may post and still meet an occurrence (rulings R1b and T3):
 * min(5, floor(cadence days / 4)), so a monthly bill may post 5 days early and a weekly one 1. The one
 * rule the clock (ledger.js) and the card pace (cards.js) both read. 0 without a known cadence.
 */
export function earlyDays(entry) {
  const cadence = entry && typeof entry.cadence === 'string' && Object.hasOwn(CADENCES, entry.cadence) ? CADENCES[entry.cadence] : null;
  return cadence && Number.isFinite(cadence.days) ? Math.min(5, Math.floor(cadence.days / 4)) : 0;
}
