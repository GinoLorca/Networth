/**
 * Everything Networth works out for itself from the bank feed: the Book (recurring bills),
 * income streams, the habit baseline, sweeps.
 * See ARCHITECTURE.md sections 3.2 (step 5), 4.7, 4.8 and 6.
 * Pure (mutates only the state it is given). Imports: schema, dates, money, classify, book, ledger.
 */

import { ACCOUNT_TYPES, CADENCES, CATEGORIES, PURPOSES, klassOf, makeRecurring, makeStream } from './schema.js';
import { addDays, addMonths, diffDays, eachDay, gameDayStartMs, isYmd, maxYmd, weekStart } from './dates.js';
import { roundCents } from './money.js';
import { reclassify } from './classify.js';
import { makeLedger, todayOf } from './ledger.js';
import { runsByHand } from './book.js';
import { claimByHand, payeeKey, unpaidByPayee } from './byhand.js';
import { incomeClaimedRows, rebuildIncome } from './income.js';

/*
 * How the specification is read where it leaves a choice (each is implemented where it is named):
 *  - A charge is money out as a spend, or as a payment from a cash account (a loan payment, a standing
 *    card payment). Transfers, game-class stops and rows already recorded as sweeps are never charges.
 *  - Intervals "fit" a cadence when at least three in four of the newest twelve fall in its window, so
 *    one skipped or late charge does not end an entry. Where two cadences fit (every two weeks, twice
 *    a month) the one nearest the usual interval wins.
 *  - An amount is steady when it holds its level within 10% (or $2), allowing a price change now and
 *    then; otherwise the bill is variable when at least three in four of its amounts are within 35% of
 *    the one before, so a utility that swings with the seasons stays one bill. A variable bill must be
 *    monthly or slower: a weekly charge whose amount moves is shopping, not a bill.
 *  - When the charges of one merchant on one account fit no cadence together they are split by amount,
 *    so two subscriptions billed under one name are two entries. A series found that way needs three
 *    charges at a steady amount and a cadence of a month or less: among a merchant's other charges, a
 *    few like amounts some months apart are as likely a coincidence as a renewal.
 *  - An entry that exists keeps the charges near its amount even when the pattern is momentarily lost;
 *    an entry the owner dismissed takes none and blocks a new one.
 *  - A pattern that had already ended when it was first seen becomes an inactive entry and is not
 *    reported as added; an entry whose charges resume is reported as added again.
 */

/* --------------------------------------------------------------- constants */

/** The interval windows of ARCHITECTURE 6 in days, shortest cadence first. */
const CADENCE_WINDOWS = [
  ['weekly', 6, 8],
  ['biweekly', 12, 16],
  ['semimonthly', 13, 17],
  ['monthly', 27, 33],
  ['quarterly', 85, 97],
  ['semiannual', 175, 190],
  ['annual', 350, 380],
];

const BILL_MIN_OCCURRENCES = { weekly: 4, biweekly: 4, semimonthly: 4, monthly: 3, quarterly: 2, semiannual: 2, annual: 2 };
/** Two monthly charges are enough when their amounts are equal to the cent. */
const EQUAL_MONTHLY_OCCURRENCES = 2;
/** The fewest charges that make a series when a merchant's charges had to be split by amount. */
const SPLIT_MIN_OCCURRENCES = 3;
/** Cadences too short for a bill whose amount moves. */
const STEADY_ONLY_CADENCES = new Set(['weekly', 'biweekly', 'semimonthly']);

/** The cadences pay comes at, and the only ones trusted in a series split off by amount. */
const MONTHLY_OR_SHORTER = new Set(['weekly', 'biweekly', 'semimonthly', 'monthly']);
const PAY_MIN_OCCURRENCES = 3;
const STREAM_MIN_DEPOSITS = 2;

/** A pattern is read from the newest occurrences only (a year of monthly charges), so an old habit ages out. */
const FIT_OCCURRENCES = 13;
/**
 * The share that makes a pattern: of intervals inside a cadence's window, of a variable bill's amounts
 * near the one before, of deposits near the usual amount.
 */
const FIT_SHARE = 0.75;
/** An interval longer than this many usual intervals is a break in the pattern, not part of its rhythm. */
const BREAK_FACTOR = 1.5;

const STEADY_SHARE = 0.10;
const STEADY_FLOOR = 200;
const VARIABLE_SHARE = 0.35;
const PAY_SHARE = 0.15;
/** A detected line within this share of a payment the owner sends to the same payee is that payment. */
const SAME_PAYMENT_SHARE = 0.10;
/** A row this near an occurrence of a payment the owner sends is on that payment's day (E9 F1). */
const ON_ITS_DAY_DAYS = 5;
/** The expected amount is the median of this many newest amounts. */
const TYPICAL_COUNT = 3;

const BILL_LAPSE_PERIODS = 1.5;
/** Locks that say the owner edited the entry's terms: detection never ends such an entry. */
const OWNER_HELD = ['cadence', 'amount', 'name', 'anchor'];
/** A pay stream is given a whole missed period plus one before it is taken as ended. */
const PAY_LAPSE_PERIODS = 2;
/** Regular deposits smaller than this accrue only when they are worded as pay (interest and rewards are regular too). */
const MIN_ACCRUING_PAY = 10000;

const ESSENTIAL_CATEGORIES = new Set(['housing', 'utilities', 'insurance', 'phone_internet', 'debt_service']);
const LOAN_CATEGORY = 'debt_service';
const PAYCHECK_RULE = 'builtin:paycheck';
const PAYROLL_WORDS = /payroll|payrll|direct dep|\bdir dep\b|dirdep|salary|net pay|paycheck/i;
/** Longest stretch of bank text searched for pay wording. */
const MAX_TEXT = 300;
/** Words too common in loan names to tell one loan from another. */
const VAGUE_WORDS = new Set(['loan', 'loans', 'payment', 'pymt', 'pmt', 'bank', 'the', 'and', 'inc', 'llc', 'account', 'financial', 'finance']);
const MIN_WORD = 3;

const MIN_HISTORY_DAYS = 14;
/**
 * The day on record (the first transaction's day is day 1, today included) from which the match is
 * played: Habit is measured over at least 14 completed days, so round 1 falls on day 15.
 * The interface states its threshold with this number and keeps no copy of its own.
 */
export const MATCH_FROM_DAY = MIN_HISTORY_DAYS + 1;
const HABIT_WINDOW_DAYS = 60;
const TARGET_SCORE = 0.4;
const WIN_LOWEST = 0.25;
const WIN_HIGHEST = 0.75;
const DOLLAR = 100;

const WEEK_DAYS = 7;
/** Completed weeks looked back over for a sweep the app was not open to see. A reading can reach 176 days back; sweeps are looked for over 13 weeks by choice. */
const SWEEP_LOOKBACK_WEEKS = 13;
const SWEEP_SHARE = 0.9;

/* ------------------------------------------------------------------ public */

/**
 * Detect recurring charges and keep state.recurring in step with them (ARCHITECTURE section 6):
 * add new entries (source 'detected'), refresh amount / anchor / confidence of existing ones without
 * touching locked fields, mark entries not seen for 1.5 periods inactive, and link every matching
 * transaction (`recurringId`; klass 'book' unless klass is locked). Entries the owner dismissed
 * (active false with 'active' in locks) are never re-created.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {{ added: string[], repriced: { id: string, from: number, to: number }[], lapsed: string[] }}  ids
 */
export function detectRecurring(state, nowMs) {
  const report = { added: [], repriced: [], lapsed: [] };
  if (!isObject(state)) return report;
  const entries = listIn(state, 'recurring');
  const ctx = readContext(state, nowMs);
  // The payments the owner sends take their rows first: such a row is never a charge of another line,
  // and a detected line of the same payment gives way, so nothing is counted twice.
  const claims = claimByHand(state, ctx.today, nowMs);
  const sentByOwner = byHandPayees(entries);
  const owedByOwner = unpaidByPayee(state, claims, ctx.today);
  const held = heldRows(state, claims);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isSamePayment(sentByOwner, entries[i]) || isOwnersLine(sentByOwner, owedByOwner, entries[i], held)) entries.splice(i, 1);
  }
  const known = entries.filter(hasKey);
  const anchorsBefore = new Map(known.map((entry) => [entry, entry.anchor]));
  // a row on the day of a payment the owner sends that the bank has not settled is that payment at
  // another amount (E9 F1): it is left free, for the checklist to offer, and joins no line, unless a
  // line of the payee that stays takes it (an amount within 10% of the line's): then it is that line's row
  const groups = groupRows(ctx.rows.filter((tx) => !claims.has(tx.id) && isCharge(ctx, tx) &&
    (!isOnOwedDay(owedByOwner, tx, [tx]) || isLineRow(known, tx))));
  const matched = new Set();

  for (const rows of groups) {
    const open = known.filter((entry) => !matched.has(entry) && serves(entry, rows[0]));
    for (const { series, entry } of pairUp(findSeries(rows), open)) {
      if (entry) {
        matched.add(entry);
        if (isDismissed(entry)) continue;
        refreshEntry(ctx, entry, series, report);
        claim(claims, series.rows, entry.id);
      } else {
        const created = newEntry(ctx, series);
        if (isSamePayment(sentByOwner, created)) continue; // the owner's line of this payment stands; no second one is made
        if (isOnOwedDay(owedByOwner, created, series.rows)) continue; // the owner sends another amount now and has not said so yet
        entries.push(created);
        claim(claims, series.rows, created.id);
        if (created.active) report.added.push(created.id);
      }
    }
  }
  for (const entry of known) {
    if (!matched.has(entry) && !isDismissed(entry)) holdCharges(entry, groups, claims, report);
  }
  for (const entry of known) settleEntry(ctx, entry, anchorsBefore.get(entry), report);
  linkCharges(state, claims);
  return report;
}

/**
 * Detect income streams from deposits (kind 'income') and keep state.streams in step.
 * A group of deposits from one payer (merchant key + account) with a regular cadence (weekly,
 * biweekly, semimonthly, monthly), at least 3 occurrences and amounts within 15% is a `salary`
 * stream with `accrue: true` (unless `accrue` is locked). Other payers seen at least twice become
 * non-accruing streams (kind 'other'); single deposits stay unlinked. Links matching transactions (`streamId`).
 * Read with some give: "within 15%" holds for three deposits in four (a bonus is not a pay cut), a
 * regular credit under $100 accrues only when it is worded as pay (interest is regular too), a payer
 * worded as pay is a 'salary' even before it is regular, and another payer whose deposits are tagged
 * coaching or studio is a 'lessons' or 'creative' stream rather than 'other'.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {{ added: string[], updated: string[] }}
 */
export function detectStreams(state, nowMs) {
  const report = { added: [], updated: [] };
  if (!isObject(state)) return report;
  const streams = listIn(state, 'streams');
  const ctx = readContext(state, nowMs);
  const known = streams.filter(hasKey);
  const taken = new Set();
  const claims = new Map();

  for (const rows of groupRows(ctx.rows.filter((tx) => isDeposit(ctx, tx)))) {
    const stream = payerOf(known, taken, rows[0]);
    if (stream) taken.add(stream);
    if (stream ? isDismissed(stream) : rows.length < STREAM_MIN_DEPOSITS) continue;
    const pay = payProfile(rows, ctx.reported);
    if (stream) {
      if (refreshStream(ctx, stream, pay)) report.updated.push(stream.id);
      claim(claims, rows, stream.id);
    } else {
      const created = makeStream({ ...pay, mkey: rows[0].mkey, accountId: rows[0].accountId, source: 'detected' });
      created.active = !isLapsed(created, ctx.today, PAY_LAPSE_PERIODS);
      streams.push(created);
      claim(claims, rows, created.id);
      report.added.push(created.id);
    }
  }
  linkDeposits(state, claims);
  // the streams now follow the bank rows reported payments claim (followIncome)
  if (isObject(state.income)) delete state.income.restream;
  return report;
}

/**
 * Compute a habit segment from the days fromDay..toDay inclusive (ARCHITECTURE 4.7).
 * Returns null when the window holds fewer than 14 days of transaction history.
 * @param {object} state
 * @param {string} fromDay
 * @param {string} toDay
 * @returns {Omit<import('./schema.js').HabitSegment, 'from'>|null}
 */
export function computeHabit(state, fromDay, toDay) {
  if (!isObject(state) || !isYmd(fromDay) || !isYmd(toDay)) return null;
  const first = firstHistoryDay(state);
  if (first === null) return null;
  const from = maxYmd(fromDay, first);
  if (diffDays(from, toDay) + 1 < MIN_HISTORY_DAYS) return null;

  // Read as on the morning after the window, when every day in it is over.
  const ledger = makeLedger(state, gameDayStartMs(addDays(toDay, 1), rolloverOf(state)));
  const rounds = eachDay(from, toDay).map((day) => ({ type: ledger.dayType(day), conv: ledger.convOn(day), bye: isBye(state, day) }));
  const workRounds = rounds.filter((played) => played.type === 'work');
  const offRounds = rounds.filter((played) => played.type !== 'work');
  const overall = meanConv(rounds);
  const work = workRounds.length ? meanConv(workRounds) : overall;
  const off = offRounds.length ? meanConv(offRounds) : overall;
  const winWork = winLineFor(work, workRounds);
  const winOff = winLineFor(off, offRounds);
  return {
    work,
    off,
    winWork,
    winOff,
    basis: 'computed',
    window: { from, to: toDay, workDays: workRounds.length, offDays: offRounds.length },
    backtest: { score: scoreOf(workRounds, work, winWork) + scoreOf(offRounds, off, winOff), rounds: rounds.length },
  };
}

/**
 * Start the match if it has not started: when at least 14 days of history exist, set
 * meta.matchStart to today's game day and push the first habit segment (window: up to the 60 days
 * before today, limited to the history available).
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {boolean} true when the match was started by this call
 */
export function startMatch(state, nowMs) {
  if (!isObject(state) || !isObject(state.meta) || isYmd(state.meta.matchStart)) return false;
  const today = todayOf(state, nowMs);
  const segment = computeHabit(state, addDays(today, -HABIT_WINDOW_DAYS), addDays(today, -1));
  if (!segment) return false;
  state.meta.matchStart = today;
  const habits = listIn(state, 'habits');
  habits.push({ from: today, ...segment });
  habits.sort((a, b) => (fromOf(a) < fromOf(b) ? -1 : fromOf(a) > fromOf(b) ? 1 : 0));
  return true;
}

/**
 * Record sweeps that happened by themselves (ARCHITECTURE 4.8): for each completed week with a
 * suggestion and no sweep yet, look for a qualifying card payment or transfer to a reserve account
 * in the 7 days after that week and push { weekOf, amount, day, txId, via: 'auto' }.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {number} sweeps recorded
 */
export function detectSweeps(state, nowMs) {
  if (!isObject(state) || !isObject(state.meta) || !isYmd(state.meta.matchStart)) return 0;
  const sweeps = listIn(state, 'sweeps');
  const ctx = readContext(state, nowMs);
  const newestWeek = addDays(weekStart(ctx.today), -WEEK_DAYS);
  let recorded = 0;
  for (let back = SWEEP_LOOKBACK_WEEKS - 1; back >= 0; back--) {
    const weekOf = addDays(newestWeek, -WEEK_DAYS * back);
    if (addDays(weekOf, WEEK_DAYS - 1) < state.meta.matchStart || sweeps.some((sweep) => isObject(sweep) && sweep.weekOf === weekOf)) continue;
    const moves = sweepMovesAfter(ctx, sweeps, weekOf);
    if (!moves.length) continue;
    // The newest week is read as the owner sees it now; an older one as on the Monday it was offered.
    const asOf = back === 0 ? nowMs : gameDayStartMs(addDays(weekOf, WEEK_DAYS), rolloverOf(state));
    const offer = makeLedger(state, asOf).edge().sweep;
    if (!offer || offer.weekOf !== weekOf) continue;
    const move = moveCovering(moves, offer.amount);
    if (!move) continue;
    sweeps.push({ weekOf, amount: offer.amount, day: move.day, txId: move.id, via: 'auto' });
    recorded += 1;
  }
  return recorded;
}

/**
 * The one call to make after every merge (and after the owner changes a rule or a setting that
 * affects detection): reclassify unlocked rows, detectRecurring, detectStreams, startMatch, detectSweeps.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {{ reclassified: number, recurring: object, streams: object, matchStarted: boolean, sweeps: number }}
 */
export function refresh(state, nowMs) {
  const reclassified = isObject(state) ? reclassify(state) : 0;
  // the payments another app reported, matched to the bank rows just classified (ARCHITECTURE 3.7)
  rebuildIncome(state, nowMs);
  return {
    reclassified,
    recurring: detectRecurring(state, nowMs),
    streams: detectStreams(state, nowMs),
    matchStarted: startMatch(state, nowMs),
    sweeps: detectSweeps(state, nowMs),
  };
}

/**
 * What runs after every change of the document (the store's update hook, app.js): rebuild income, and when the bank
 * rows that reported payments claim changed since the streams were last decided (`income.restream`, set by the
 * rebuild), decide the streams again in the same step. A payer whose payments are matched stops accruing at once, and
 * accrues again once none of its rows is claimed (3.7). The reader's update, the answers and the new game day all pass
 * through it.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {{ changed: boolean }}
 */
export function followIncome(state, nowMs) {
  const result = rebuildIncome(state, nowMs);
  if (isObject(state) && isObject(state.income) && state.income.restream === true) detectStreams(state, nowMs);
  return result;
}

/* ------------------------------------------------------------- the document */

/** What every detector reads first: today, the usable accounts, the rows the bank reported and the moves recorded as sweeps. */
function readContext(state, nowMs) {
  const accounts = new Map();
  for (const account of listOf(state.accounts)) {
    if (!isObject(account) || typeof account.id !== 'string' || !Object.hasOwn(ACCOUNT_TYPES, account.type)) continue;
    if (!accounts.has(account.id)) accounts.set(account.id, account);
  }
  const today = todayOf(state, nowMs);
  const rows = listOf(state.txs).filter((tx) => isBankRow(tx) && tx.day <= today && isShown(accounts.get(tx.accountId)));
  const swept = new Set(listOf(state.sweeps).filter(isObject).map((sweep) => sweep.txId).filter((id) => id != null));
  // bank rows a payment another app reported claims (a history one included): their stream is counted on arrival (3.7)
  const reported = incomeClaimedRows(state);
  return { today, accounts, rows, byId: new Map(rows.map((tx) => [tx.id, tx])), swept, reported };
}

/** A row the bank reported that counts: not a move the owner tapped in, not a decline, not superseded. */
function isBankRow(tx) {
  return isObject(tx) && typeof tx.id === 'string' && tx.source !== 'manual' && tx.kind !== 'decline' && !tx.matchId
    && isYmd(tx.day) && Number.isFinite(tx.amount) && tx.amount > 0 && typeof tx.mkey === 'string';
}

function isShown(account) {
  return !!account && !account.hidden;
}

function groupOf(account) {
  return account ? ACCOUNT_TYPES[account.type].group : null;
}

/** Rows that share a merchant key and an account, each group oldest first, in the order first met. */
function groupRows(rows) {
  const groups = new Map();
  for (const tx of rows) {
    const key = tx.accountId + '|' + tx.mkey;
    const group = groups.get(key);
    if (group) group.push(tx);
    else groups.set(key, [tx]);
  }
  return [...groups.values()].map((group) => group.sort(byDay));
}

function byDay(a, b) {
  return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
}

/** An entry or stream that can be matched to rows at all. */
function hasKey(item) {
  return isObject(item) && typeof item.id === 'string' && typeof item.mkey === 'string' && item.mkey !== '';
}

/** True when an entry or stream is the one a row of this merchant and account belongs to. */
function serves(item, row) {
  return item.mkey === row.mkey && (item.accountId == null || item.accountId === row.accountId);
}

function hasLock(item, field) {
  return Array.isArray(item.locks) && item.locks.includes(field);
}

/** Switched off by the owner, not by a lapse: it stays off and nothing takes its place. */
function isDismissed(item) {
  return !item.active && hasLock(item, 'active');
}

/** Set a field the owner has not locked. @returns {boolean} true when the value changed */
function setFree(item, field, value) {
  if (hasLock(item, field) || item[field] === value) return false;
  item[field] = value;
  return true;
}

function claim(claims, rows, id) {
  for (const row of rows) claims.set(row.id, id);
}

function hasCadence(item) {
  return typeof item.cadence === 'string' && Object.hasOwn(CADENCES, item.cadence);
}

/** Not seen for more than `periods` of its own cadence. Without a cadence or an anchor there is no telling. */
function isLapsed(item, today, periods) {
  return hasCadence(item) && isYmd(item.anchor) && diffDays(item.anchor, today) > periods * CADENCES[item.cadence].days;
}

/** The latest row's display name; the merchant key when the bank gave nothing to show. */
function nameOf(row) {
  return typeof row.merchant === 'string' && row.merchant ? row.merchant : row.mkey;
}

function purposeOf(row) {
  return PURPOSES.includes(row.purpose) ? row.purpose : 'personal';
}

/* ---------------------------------------------------------------- patterns */

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The usual interval: the mean of those that are not breaks in the pattern. */
function usualInterval(intervals) {
  const limit = BREAK_FACTOR * median(intervals);
  const usual = intervals.filter((gap) => gap <= limit);
  return usual.reduce((total, gap) => total + gap, 0) / usual.length;
}

/**
 * The cadence the newest occurrences fit, with the share of their intervals inside its window.
 * @param {string[]} days  ascending
 * @param {(cadence: string) => number|null} minimumFor  occurrences a cadence needs; null rules it out
 * @returns {{ cadence: string, regularity: number, minimum: number }|null}
 */
function fitCadence(days, minimumFor) {
  const recent = days.slice(-FIT_OCCURRENCES);
  const intervals = recent.slice(1).map((day, i) => diffDays(recent[i], day));
  if (!intervals.length) return null;
  const usual = usualInterval(intervals);
  let best = null;
  for (const [cadence, shortest, longest] of CADENCE_WINDOWS) {
    const minimum = minimumFor(cadence);
    if (minimum === null || days.length < minimum) continue;
    const regularity = intervals.filter((gap) => gap >= shortest && gap <= longest).length / intervals.length;
    if (regularity < FIT_SHARE) continue;
    const distance = Math.abs(usual - CADENCES[cadence].days);
    if (!best || distance < best.distance) best = { cadence, regularity, minimum, distance };
  }
  return best && { cadence: best.cadence, regularity: best.regularity, minimum: best.minimum };
}

function isNear(amount, reference, share) {
  return Math.abs(amount - reference) <= Math.max(share * reference, STEADY_FLOOR);
}

/**
 * How the amounts of a run of charges behave, oldest first: 'steady' when they hold a level (a price
 * change starts a new level, and at most one charge in three may do so), 'variable' when at least
 * three in four are within 35% of the charge before, else null.
 */
function amountShape(amounts) {
  let level = amounts[0];
  let changes = 0;
  let gentleSteps = 0;
  amounts.forEach((amount, i) => {
    if (i > 0 && isNear(amount, amounts[i - 1], VARIABLE_SHARE)) gentleSteps += 1;
    if (isNear(amount, level, STEADY_SHARE)) return;
    level = amount;
    changes += 1;
  });
  if (changes <= Math.floor(amounts.length / 3)) return 'steady';
  return gentleSteps / (amounts.length - 1) >= FIT_SHARE ? 'variable' : null;
}

/** Between 0 and 1: half from how often it was seen, the rest from how regular and how steady it is. */
function confidenceOf(count, minimum, regularity, steady) {
  const seen = Math.min(1, count / (2 * minimum));
  return Math.round((0.5 * seen + 0.3 * regularity + (steady ? 0.2 : 0.1)) * 100) / 100;
}

function typicalAmount(rows) {
  return roundCents(median(rows.slice(-TYPICAL_COUNT).map((row) => row.amount)));
}

/* ---------------------------------------------------------------- the Book */

/**
 * A stop in the daily game is never a bill (ARCHITECTURE 6). A charge linked earlier carries klass
 * 'book', so it is read by its category unless the owner set the class by hand.
 */
function isGameStop(tx) {
  if (tx.klass === 'game') return true;
  return !hasLock(tx, 'klass') && Object.hasOwn(CATEGORIES, tx.category) && CATEGORIES[tx.category].klass === 'game';
}

function isCharge(ctx, tx) {
  if (tx.flow !== 'out' || !tx.mkey || isSweep(ctx, tx)) return false;
  if (tx.kind === 'spend') return !isGameStop(tx);
  return tx.kind === 'payment' && groupOf(ctx.accounts.get(tx.accountId)) === 'cash';
}

/** A move recorded as a sweep, or the other leg of one. */
function isSweep(ctx, tx) {
  return ctx.swept.has(tx.id) || ctx.swept.has(tx.pairId);
}

/** The recurring series among one merchant's charges on one account: all of them, else amount by amount. */
function findSeries(rows) {
  const whole = seriesOf(rows, false);
  if (whole) return [whole];
  return amountClusters(rows).map((cluster) => seriesOf(cluster, true)).filter(Boolean);
}

/** Charges of like amount (each within 10% or $2 of the smallest in its cluster), where that sets some apart from the rest. */
function amountClusters(rows) {
  const clusters = [];
  let cluster = null;
  for (const row of [...rows].sort((a, b) => a.amount - b.amount)) {
    if (!cluster || !isNear(row.amount, cluster[0].amount, STEADY_SHARE)) clusters.push(cluster = []);
    cluster.push(row);
  }
  return clusters.filter((found) => found.length < rows.length).map((found) => found.sort(byDay));
}

/**
 * What a run of charges amounts to as a Book entry, or null when it is not recurring.
 * @param {object[]} rows   oldest first
 * @param {boolean} split   the rows were picked out of a merchant's charges by their amount
 */
function seriesOf(rows, split) {
  const shape = amountShape(rows.slice(-FIT_OCCURRENCES).map((row) => row.amount));
  if (!shape || (split && shape !== 'steady')) return null;
  const variable = shape === 'variable';
  const equal = rows.every((row) => row.amount === rows[0].amount);
  const fit = fitCadence(rows.map((row) => row.day), (cadence) => {
    if (variable && STEADY_ONLY_CADENCES.has(cadence)) return null;
    if (split) return MONTHLY_OR_SHORTER.has(cadence) ? Math.max(SPLIT_MIN_OCCURRENCES, BILL_MIN_OCCURRENCES[cadence]) : null;
    return cadence === 'monthly' && equal ? EQUAL_MONTHLY_OCCURRENCES : BILL_MIN_OCCURRENCES[cadence];
  });
  if (!fit) return null;
  return {
    rows,
    cadence: fit.cadence,
    variable,
    // A fixed price is whatever the bank charged last (a new price holds from its first charge);
    // a bill that moves is expected at the median of its newest three.
    amount: variable ? typicalAmount(rows) : roundCents(rows[rows.length - 1].amount),
    anchor: rows[rows.length - 1].day,
    confidence: confidenceOf(rows.length, BILL_MIN_OCCURRENCES[fit.cadence], fit.regularity, !variable),
  };
}

/** Give each series the open entry nearest its amount; a series left over is new. */
function pairUp(found, entries) {
  const options = [];
  for (const entry of entries) {
    for (const series of found) {
      const gap = Number.isFinite(entry.amount) ? Math.abs(entry.amount - series.amount) : Number.MAX_VALUE;
      options.push({ entry, series, gap });
    }
  }
  options.sort((a, b) => a.gap - b.gap);
  const entryOf = new Map();
  const taken = new Set();
  for (const { entry, series } of options) {
    if (taken.has(entry) || entryOf.has(series)) continue;
    taken.add(entry);
    entryOf.set(series, entry);
  }
  return found.map((series) => ({ series, entry: entryOf.get(series) || null }));
}

/** What the newest charge says the entry is: its name, category, purpose and the debt it pays down. */
function describe(ctx, series) {
  const latest = series.rows[series.rows.length - 1];
  const category = latest.kind === 'payment' ? LOAN_CATEGORY : Object.hasOwn(CATEGORIES, latest.category) ? latest.category : 'other';
  return { name: nameOf(latest), category, purpose: purposeOf(latest), toAccountId: debtPaidBy(ctx, series, category) };
}

function refreshEntry(ctx, entry, series, report) {
  const before = { amount: entry.amount, variable: !!entry.variable };
  for (const field of ['variable', 'cadence', 'anchor']) setFree(entry, field, series[field]);
  if (entry.source === 'detected') setFree(entry, 'confidence', series.confidence);
  for (const [field, value] of Object.entries(describe(ctx, series))) setFree(entry, field, value);
  const repriced = setFree(entry, 'amount', series.amount);
  if (repriced && !before.variable && !entry.variable && before.amount > 0) {
    report.repriced.push({ id: entry.id, from: before.amount, to: entry.amount });
  }
}

function newEntry(ctx, series) {
  const { rows, ...pattern } = series;
  const described = describe(ctx, series);
  const entry = makeRecurring({
    ...pattern,
    ...described,
    mkey: rows[0].mkey,
    accountId: rows[0].accountId,
    essential: ESSENTIAL_CATEGORIES.has(described.category),
    source: 'detected',
  });
  entry.active = !isLapsed(entry, ctx.today, BILL_LAPSE_PERIODS);
  return entry;
}

/**
 * An entry with no series of its own this time (the owner made it, or noise hides the pattern) keeps
 * the unclaimed charges near its amount, and its anchor follows them. A detected entry at a fixed
 * price takes the newest of them as its amount (a price change holds at once); a variable bill and
 * an entry the owner made keep theirs, so what they hold does not drift from one run to the next.
 */
function holdCharges(entry, groups, claims, report) {
  const held = [];
  for (const rows of groups) {
    if (!serves(entry, rows[0])) continue;
    for (const row of rows) {
      if (!claims.has(row.id) && (!(entry.amount > 0) || isNear(row.amount, entry.amount, VARIABLE_SHARE))) held.push(row);
    }
  }
  if (!held.length) return;
  claim(claims, held, entry.id);
  const latest = held.sort(byDay)[held.length - 1];
  setFree(entry, 'anchor', latest.day);
  if (entry.source !== 'detected' || entry.variable || !(entry.amount > 0)) return;
  const from = entry.amount;
  if (setFree(entry, 'amount', roundCents(latest.amount))) report.repriced.push({ id: entry.id, from, to: entry.amount });
}

/**
 * A detected entry lapses when it has not been charged for 1.5 periods, and returns when a charge
 * later than the one it lapsed on arrives. The owner's own entries and locked ones are left alone:
 * an entry whose cadence, amount, name or anchor the owner set is never ended here.
 */
function settleEntry(ctx, entry, anchorBefore, report) {
  if (entry.source !== 'detected' || hasLock(entry, 'active')) return;
  const lapsed = isLapsed(entry, ctx.today, BILL_LAPSE_PERIODS);
  if (entry.active && lapsed) {
    if (OWNER_HELD.some((field) => hasLock(entry, field))) return;
    entry.active = false;
    report.lapsed.push(entry.id);
  } else if (!entry.active && !lapsed && isYmd(anchorBefore) && isYmd(entry.anchor) && entry.anchor > anchorBefore) {
    entry.active = true;
    report.added.push(entry.id);
  }
}

/** The payees of the payments the owner sends that run (book.runsByHand), each with the amounts sent to it: fingerprint -> cents[]. */
function byHandPayees(entries) {
  const payees = new Map();
  for (const entry of entries) {
    if (!runsByHand(entry) || typeof entry.payee !== 'string' || !entry.payee) continue;
    if (!payees.has(entry.payee)) payees.set(entry.payee, []);
    payees.get(entry.payee).push(entry.amount);
  }
  return payees;
}

/**
 * The rows each line held at the last run that no payment the owner sends has taken in this one:
 * entry id -> rows.
 */
function heldRows(state, claims) {
  const held = new Map();
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || typeof tx.recurringId !== 'string' || claims.has(tx.id)) continue;
    if (!held.has(tx.recurringId)) held.set(tx.recurringId, []);
    held.get(tx.recurringId).push(tx);
  }
  return held;
}

/**
 * E9 F1 (b) and (c) for a detected line that exists (E9 F1 (a) is isSamePayment): a line of the payee
 * of a running payment the owner sends that now holds no row at all (every row it had belongs to that
 * payment), or whose every row is on the payment's day while the payment's occurrence nearest its newest
 * row has no bank row. A line the owner dismissed stays, so that it is never made again.
 */
function isOwnersLine(payees, owed, entry, held) {
  if (!payees.size || !isObject(entry) || entry.source !== 'detected' || runsByHand(entry) || isDismissed(entry)) return false;
  if (typeof entry.mkey !== 'string' || !entry.mkey || !payees.has(payeeKey(entry.mkey))) return false;
  const rows = held.get(entry.id) || [];
  if (rows.length === 0) return true;
  // a row the line took of its own amount on the day of an unpaid occurrence (isLineRow) does not by
  // itself make the line the owner's: (c) is read on the rows it had before, when it has any
  const before = rows.filter((row) => !(isOnOwedDay(owed, entry, [row]) && isLineRow([entry], row)));
  return isOnOwedDay(owed, entry, before.length ? before : rows);
}

/**
 * E9 F1 (c): every row is on the day of one payment the owner sends to the same payee (within 5 days of
 * an occurrence of its schedule read both ways), and that payment's occurrence nearest the newest row
 * has no bank row (unpaid, or ticked with no row). The owner has changed what they send and not yet the
 * entry, and a line of these rows would count the payment twice. A second payment to the payee on
 * another day, or on the same day once the owner's own payment is at the bank, keeps its line.
 */
function isOnOwedDay(owed, entry, rows) {
  if (!owed.size || !isObject(entry) || typeof entry.mkey !== 'string' || !entry.mkey || !rows.length) return false;
  const payments = owed.get(payeeKey(entry.mkey));
  if (!payments) return false;
  let last = '';
  for (const row of rows) {
    if (!isObject(row) || !isYmd(row.day)) return false;
    if (row.day > last) last = row.day;
  }
  return payments.some(({ dueDay, days }) =>
    rows.every((row) => nearestOccurrence(dueDay, row.day).gap <= ON_ITS_DAY_DAYS) && days.includes(nearestOccurrence(dueDay, last).day));
}

/**
 * A row a detected line of its payee that survived the removal step would take: the same payee, and an
 * amount within 10% of the line's. Such a row on the day of a payment the owner sends is not held back.
 */
function isLineRow(lines, tx) {
  if (typeof tx.mkey !== 'string' || !tx.mkey || !Number.isFinite(tx.amount)) return false;
  const payee = payeeKey(tx.mkey);
  return lines.some((entry) => entry.source === 'detected' && !runsByHand(entry) && !isDismissed(entry) &&
    typeof entry.mkey === 'string' && payeeKey(entry.mkey) === payee && Number.isFinite(entry.amount) &&
    Math.abs(tx.amount - entry.amount) <= SAME_PAYMENT_SHARE * entry.amount);
}

/** The day of a monthly schedule on `dueDay` (the last day in a shorter month) nearest `day`, the earlier on a tie, read both ways. */
function nearestOccurrence(dueDay, day) {
  let best = null;
  for (const step of [-1, 0, 1]) {
    const occurrence = addMonths(day.slice(0, 8) + '01', step, dueDay);
    const gap = Math.abs(diffDays(occurrence, day));
    if (best === null || gap < best.gap) best = { day: occurrence, gap };
  }
  return best;
}

/** A detected line that is a payment the owner sends: the same payee, and an amount within 10% of it. */
function isSamePayment(payees, entry) {
  if (!payees.size || !isObject(entry) || entry.source !== 'detected' || runsByHand(entry) || typeof entry.mkey !== 'string' || !entry.mkey) return false;
  const amounts = payees.get(payeeKey(entry.mkey));
  return !!amounts && amounts.some((amount) => Math.abs(entry.amount - amount) <= SAME_PAYMENT_SHARE * amount);
}

/** Write the links: a claimed charge joins the Book, one no longer claimed goes back to what its text says. */
function linkCharges(state, claims) {
  const freed = [];
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || tx.source === 'manual') continue;
    const entryId = claims.get(tx.id);
    if (entryId !== undefined) {
      tx.recurringId = entryId;
      tx.review = false; // recognised as a line of the Book: nothing left to look at
      if (!hasLock(tx, 'klass')) tx.klass = 'book';
    } else if (tx.recurringId != null) {
      tx.recurringId = null;
      if (tx.klass === 'book' && !hasLock(tx, 'klass')) tx.klass = klassOf(tx.category);
      if (typeof tx.id === 'string') freed.push(tx.id);
    }
  }
  if (freed.length) reclassify(state, freed);
}

/* ------------------------------------------------------------ loan payments */

/**
 * The debt a series pays down (ARCHITECTURE 6): the account its paired leg landed on, else — for a
 * loan payment — the owner's loan that it can only be.
 */
function debtPaidBy(ctx, series, category) {
  for (let i = series.rows.length - 1; i >= 0; i--) {
    const leg = series.rows[i].pairId ? ctx.byId.get(series.rows[i].pairId) : null;
    const group = leg ? groupOf(ctx.accounts.get(leg.accountId)) : null;
    if (group === 'card' || group === 'debt') return leg.accountId;
  }
  return category === LOAN_CATEGORY ? loanFor(ctx, series) : null;
}

/** The one loan whose payment is this amount, else the one named like the merchant, else the only loan there is. */
function loanFor(ctx, series) {
  const loans = [...ctx.accounts.values()].filter((account) => isShown(account) && groupOf(account) === 'debt');
  const latest = series.rows[series.rows.length - 1];
  const merchant = wordsOf(latest.mkey + ' ' + nameOf(latest));
  const tests = [
    (loan) => isObject(loan.loan) && loan.loan.payment > 0 && isNear(series.amount, loan.loan.payment, STEADY_SHARE),
    (loan) => wordsOf([loan.name, loan.nick, loan.institution].join(' ')).some((word) => merchant.includes(word)),
    () => true,
  ];
  for (const test of tests) {
    const fitting = loans.filter(test);
    if (fitting.length === 1) return fitting[0].id;
  }
  return null;
}

function wordsOf(text) {
  return String(text).slice(0, MAX_TEXT).toLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD && !VAGUE_WORDS.has(word));
}

/* ----------------------------------------------------------- income streams */

function isDeposit(ctx, tx) {
  return tx.flow === 'in' && tx.kind === 'income' && !!tx.mkey && !tx.pairId;
}

/** The stream a payer's deposits belong to: one for that very account first, else one for any account. */
function payerOf(streams, taken, row) {
  const open = streams.filter((stream) => !taken.has(stream) && serves(stream, row));
  return open.find((stream) => stream.accountId === row.accountId) || open[0] || null;
}

function isPayroll(tx) {
  if (tx.ruleId === PAYCHECK_RULE) return true;
  return [tx.raw, tx.merchant].some((text) => typeof text === 'string' && PAYROLL_WORDS.test(text.slice(0, MAX_TEXT)));
}

function kindFor(purpose) {
  if (purpose === 'coaching') return 'lessons';
  return purpose === 'studio' ? 'creative' : 'other';
}

/**
 * What a payer's deposits amount to as a stream. Regular cadence and stable amounts are what make it
 * accrue; pay wording (or a deposit of $100 or more) is what tells regular pay from regular interest.
 */
function payProfile(rows, reported) {
  const recent = rows.slice(-FIT_OCCURRENCES);
  const amounts = recent.map((row) => row.amount);
  const usual = median(amounts);
  const steady = amounts.filter((amount) => Math.abs(amount - usual) <= PAY_SHARE * usual).length / amounts.length >= FIT_SHARE;
  const fit = fitCadence(rows.map((row) => row.day), (cadence) => (MONTHLY_OR_SHORTER.has(cadence) ? PAY_MIN_OCCURRENCES : null));
  const regular = !!fit && steady;
  const latest = rows[rows.length - 1];
  const payroll = recent.some(isPayroll);
  const amount = regular ? typicalAmount(rows) : roundCents(usual);
  // a deposit that confirms a payment another app reported is counted when it is marked, so its stream
  // is counted on arrival and never day by day (unless the owner locked `accrue` on)
  const confirmed = !!reported && rows.some((row) => reported.has(row.id));
  const accrue = regular && (payroll || amount >= MIN_ACCRUING_PAY) && !confirmed;
  return {
    name: nameOf(latest),
    kind: accrue || payroll ? 'salary' : kindFor(latest.purpose),
    cadence: fit ? fit.cadence : null,
    anchor: latest.day,
    amount,
    accrue,
    confidence: confidenceOf(rows.length, PAY_MIN_OCCURRENCES, fit ? fit.regularity : 0, steady),
  };
}

/**
 * Bring a stream in step with its deposits. Like a Book entry, only a stream detection made is
 * switched off when its pay stops, and on again when a later deposit arrives.
 * @returns {boolean} true when anything about the stream changed
 */
function refreshStream(ctx, stream, pay) {
  const anchorBefore = stream.anchor;
  let changed = false;
  for (const [field, value] of Object.entries(pay)) {
    if (field === 'confidence' && stream.source !== 'detected') continue;
    changed = setFree(stream, field, value) || changed;
  }
  if (stream.source !== 'detected' || hasLock(stream, 'active')) return changed;
  const lapsed = isLapsed(stream, ctx.today, PAY_LAPSE_PERIODS);
  const resumed = !lapsed && isYmd(stream.anchor) && (!isYmd(anchorBefore) || stream.anchor > anchorBefore);
  if (stream.active ? lapsed : resumed) {
    stream.active = !stream.active;
    changed = true;
  }
  return changed;
}

/** Write the links. A linked deposit is settled (classification leaves it alone), so it needs no review. */
function linkDeposits(state, claims) {
  const freed = [];
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || tx.source === 'manual') continue;
    const streamId = claims.get(tx.id);
    if (streamId !== undefined) {
      tx.streamId = streamId;
      tx.review = false;
    } else if (tx.streamId != null) {
      tx.streamId = null;
      if (typeof tx.id === 'string') freed.push(tx.id);
    }
  }
  if (freed.length) reclassify(state, freed);
}

/* ------------------------------------------------------------------- habit */

/** The first day the bank reported anything: history begins there. */
function firstHistoryDay(state) {
  let first = null;
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || tx.source === 'manual' || tx.kind === 'decline' || !isYmd(tx.day)) continue;
    if (first === null || tx.day < first) first = tx.day;
  }
  return first;
}

function isBye(state, day) {
  const days = isObject(state.days) ? state.days : {};
  return Object.hasOwn(days, day) && isObject(days[day]) && !!days[day].bye;
}

function meanConv(rounds) {
  return rounds.length ? roundCents(rounds.reduce((total, played) => total + played.conv, 0) / rounds.length) : 0;
}

/** Points the rounds would have scored against these lines (ARCHITECTURE 4.6). */
function scoreOf(rounds, habit, winLine) {
  const lossLine = Math.ceil(habit / DOLLAR) * DOLLAR;
  let score = 0;
  for (const played of rounds) {
    if (played.bye) score += 0.5;
    else if (played.conv <= winLine) score += 1;
    else if (played.conv <= lossLine) score += 0.5;
  }
  return score;
}

/**
 * The win line (ARCHITECTURE 4.7): among the whole-dollar values from 25% to 75% of habit, the one
 * whose back-tested score is closest to 40%; of equals, the one nearest half of habit, then the lower.
 * A habit too small to hold a whole dollar in that range gets the whole dollar below it.
 */
function winLineFor(habit, rounds) {
  const lowest = Math.ceil(habit * WIN_LOWEST / DOLLAR) * DOLLAR;
  const highest = Math.floor(habit * WIN_HIGHEST / DOLLAR) * DOLLAR;
  if (highest < lowest) return highest;
  const half = Math.min(highest, Math.max(lowest, Math.round(habit / (2 * DOLLAR)) * DOLLAR));
  let best = null;
  for (let line = lowest; line <= highest; line += DOLLAR) {
    const miss = rounds.length ? Math.abs(scoreOf(rounds, habit, line) / rounds.length - TARGET_SCORE) : 0;
    const shift = Math.abs(line - half);
    if (!best || miss < best.miss || (miss === best.miss && shift < best.shift)) best = { line, miss, shift };
  }
  return best.line;
}

function fromOf(segment) {
  return isObject(segment) && typeof segment.from === 'string' ? segment.from : '';
}

/* ------------------------------------------------------------------ sweeps */

/**
 * The moves that could carry out the sweep offered for a week (ARCHITECTURE 4.8): posted in the seven
 * days after it, not part of the Book and not already counted as a sweep. Oldest first.
 */
function sweepMovesAfter(ctx, sweeps, weekOf) {
  const from = addDays(weekOf, WEEK_DAYS);
  const to = addDays(from, WEEK_DAYS - 1);
  const used = new Set(sweeps.filter(isObject).map((sweep) => sweep.txId).filter((id) => id != null));
  return ctx.rows
    .filter((tx) => tx.day >= from && tx.day <= to && !used.has(tx.id) && !used.has(tx.pairId) && isSweepMove(ctx, tx))
    .sort(byDay);
}

/** The earliest move of at least 90% of the offer; of several on that day, the one nearest the offer. */
function moveCovering(moves, amount) {
  let best = null;
  for (const tx of moves) {
    if (tx.amount < SWEEP_SHARE * amount || (best && tx.day > best.day)) continue;
    if (!best || Math.abs(tx.amount - amount) < Math.abs(best.amount - amount)) best = tx;
  }
  return best;
}

/**
 * A posted card payment, or a transfer into a reserve account. Where both legs are linked accounts the
 * leg leaving cash stands for the move; the arriving leg does only when the other side is not linked.
 */
function isSweepMove(ctx, tx) {
  if (tx.pending || tx.recurringId != null) return false;
  const account = ctx.accounts.get(tx.accountId);
  const leg = tx.pairId ? ctx.byId.get(tx.pairId) || null : null;
  const other = leg ? ctx.accounts.get(leg.accountId) : null;
  if (leg && leg.recurringId != null) return false;
  if (tx.flow === 'out') {
    if (groupOf(account) !== 'cash') return false;
    if (tx.kind === 'payment') return leg ? groupOf(other) === 'card' : tx.category === 'card_payment';
    return tx.kind === 'transfer' && isReserve(other) && !isReserve(account);
  }
  if (leg) return false;
  if (tx.kind === 'payment') return groupOf(account) === 'card';
  return tx.kind === 'transfer' && isReserve(account);
}

function isReserve(account) {
  return !!account && groupOf(account) === 'cash' && !!account.reserve;
}

/* ------------------------------------------------------------ small helpers */

function isObject(x) {
  return x !== null && typeof x === 'object';
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}

/** A list of the document, created when it is missing so there is somewhere to write. */
function listIn(state, key) {
  if (!Array.isArray(state[key])) state[key] = [];
  return state[key];
}

/** The rollover hour as the ledger reads it: midnight when it is not set or is not an hour of the day. */
function rolloverOf(state) {
  const hour = isObject(state.settings) ? state.settings.rolloverHour : null;
  return Number.isFinite(hour) && hour >= 0 && hour < 24 ? hour : 0;
}
