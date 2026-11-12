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
  if (step.months) return everyMonths(item.anchor, step.months, afterDay, untilDay);
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
    for (const day of occurrencesFrom(rec, fromDay, days)) {
      if (charged.get(rec.id) >= day) continue; // it has already posted (a charge dated today)
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

function everyMonths(anchor, step, afterDay, untilDay) {
  const out = [];
  const anchorDay = parts(anchor).d;
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
