/**
 * The engine: positions, accruals, daily closes, rounds, edge and the clock.
 * See ARCHITECTURE.md section 4 — it is the specification; this file implements it exactly.
 * Pure. Imports: schema, dates, money, book, loans. Must NOT import detect, cards, assess or forecast.
 *
 * Performance: every function may be called several times per render with the same state.
 * Build shared indexes once per (state, nowMs) call chain — e.g. a WeakMap keyed by the state
 * object and invalidated when `state.txs.length`/`state.meta.savedAt` change is NOT safe
 * (the document is mutated in place); instead expose `makeLedger(state, nowMs)` which returns an
 * object holding the indexes and offering every function below as a method. The standalone
 * functions simply create a ledger and call the method. Views use one ledger per render.
 */

import { ACCOUNT_TYPES, CADENCES, CATEGORIES, accountLabel, klassOf } from './schema.js';
import {
  addDays, addMonths, addMonthsYm, daysInMonth, diffDays, dow, gameDay, gameDayFraction, gameDayStartMs, isYmd,
  monthOf, parts, startOfMonth, weekStart,
} from './dates.js';
import { roundCents } from './money.js';
import { BILL_LAPSE_PERIODS, earlyDays, lastOccurrence, nextOccurrence, occurrences, upcoming } from './book.js';
import { dailyInterest, loanValueOn } from './loans.js';

const EPOCH = '1970-01-01';
const HOUR_MS = 3600000;
const DAY_SECONDS = 86400;
/** The largest timestamp a Date can hold. */
const MAX_TIME_MS = 8.64e15;

/** Accrual stops this long after the last successful sync; the data is "aging" up to the second limit (ARCHITECTURE 4.5). */
const ACCRUAL_STOP_MS = 36 * HOUR_MS;
const AGING_LIMIT_MS = 72 * HOUR_MS;

/** Limits of an accrual, in periods of its cadence (ARCHITECTURE 4.3). */
const PAY_CAP_PERIODS = 1.6;
/** A regular stream smaller than this a month (cents) is income, but not pay: it sets no payday. */
const PAY_STREAM_MIN_MONTHLY = 20000;
const BILL_CAP_PERIODS = 1.25;

/** An unmatched provisional move counts on its own day and the seven after it (ARCHITECTURE 3.2). */
const PROVISIONAL_DAYS = 7;

const WEEK_DAYS = 7;
const SWEEP_MINIMUM = 500;
const FORM_ROUNDS = 7;
const BURN_DAYS = 60;
/** With less than a week on record the typical outflow is unknown. */
const BURN_MIN_DAYS = 7;
const TROUBLE_RUNWAY_DAYS = 7;
/** Below this much earned in a month (cents) the kept share is withheld. */
const RATE_MIN_EARNED = 100;
/** Days looked ahead for what is due when no payday is known. */
const DUE_WINDOW_DAYS = 14;
/** Days after a scheduled payday during which the due window stays at today alone (ruling T1): the bank feed runs about a day behind, longer over a weekend. */
export const PAY_GRACE_DAYS = 2;
const TIME_MILESTONES = [['1 day', 1], ['1 week', 7], ['2 weeks', 14], ['1 month', 30], ['3 months', 90]];

/** How far before a requested day an anchor's schedule is projected in one call. */
const PROJECTION_MARGIN_DAYS = 400;
/** A loan whose first entry is older than this (50 years) has a mistyped date: it is valued once, not step by step. */
const MAX_LOAN_AGE_DAYS = 18263;

/*
 * How the specification is read where it leaves a choice (each is implemented where it is named):
 *  - A close has two figures. `bank` is what the accounts hold and nothing else; `smooth` adds pay
 *    earned, takes off bills used and takes off unmatched provisional moves. With smoothing off,
 *    smooth = bank less any provisional move still counting.
 *  - Receivable and payable are each rounded to whole cents inside a close, so earned, bills, spent
 *    and other are whole cents that add up to the result exactly. Only a Position keeps fractions.
 *  - Today's close is the day so far: accruals are read at the present instant, like the live number.
 *  - Accruals hold still after the 36-hour stop and before the first day the bank feed covers.
 *  - bills = change of the payable + every Book charge of the day − principal taken off an amortised
 *    loan. A Book charge is a spend linked to an entry or classed `book`, or an unpaired payment
 *    linked to an entry. So a charge that equals its accrual leaves exactly one day's worth.
 *  - A capitalised purchase steps its manual asset account on the day of the purchase; a later
 *    history entry is a revaluation only for what the purchase does not explain.
 *  - A lapsed Book entry (no charge for 1.5 periods) releases what it had accrued.
 */

/**
 * @typedef {Object} Position  Where things stand at an instant.
 * @property {number} at             the instant (ms)
 * @property {string} day            its game day
 * @property {number} cash           Σ now-balances of cash accounts (signed cents, normally >= 0)
 * @property {number} cards          Σ now-balances of card accounts (signed, normally <= 0)
 * @property {number} liquid         cash + cards
 * @property {number} investments    Σ investment accounts
 * @property {number} slowAssets     Σ other asset accounts (equipment, vehicle, receivable, other)
 * @property {number} loans          Σ loan and other-debt accounts (signed, <= 0)
 * @property {number} assets         Σ of every positive-side group: cash + investments + slowAssets (plus any card in credit)
 * @property {number} liabilities    amount owed in total, as a POSITIVE number
 * @property {number} bank           net worth "at the bank": the plain sum of all signed balances
 * @property {boolean} smoothing     true when pay and bills are being accrued
 * @property {number} receivable     pay earned and not yet received at `at` (cents, may be fractional)
 * @property {number} payable        bills used and not yet charged at `at` (cents, may be fractional)
 * @property {number} smooth         bank + receivable − payable. It does NOT include moves tapped in and not yet at the bank;
 *                                  `live` does (and so does every DayClose.smooth). Show `live` wherever one net worth is shown.
 * @property {number} provisional    Σ unmatched provisional spends still counting (a POSITIVE number of cents)
 * @property {number} live           smooth − provisional: the hero number, tapped-in moves included (may be fractional)
 * @property {number} rate           cents per SECOND the live number is rising (0 when not accruing or data is too old):
 *                                  a day's accrual over the real length of today's game day (86,400 s; 82,800 or 90,000 when the clocks change)
 * @property {number|null} dataAt    oldest balance timestamp among everyday bank accounts (ms), null when there are none
 * @property {number|null} syncedAt  state.sync.lastOk
 * @property {'fresh'|'aging'|'old'|'none'} freshness   fresh: synced within 36 h; aging: within 72 h; old: older; none: never
 * @property {{ id: string, name: string, amount: number, since: string, daily: number }[]} receivables  one per accruing stream
 * @property {{ id: string, name: string, amount: number, since: string, daily: number }[]} payables     one per accruing Book entry
 * @property {{ id: string, name: string, since: string }[]} lapsedPay   scheduled streams, counted day by day or on arrival (ruling T4), with no deposit for more than 1.6 pay
 *                                  periods: their receivable is released and they no longer supply a payday; `since` is the last deposit's day
 */

/**
 * @typedef {Object} DayClose  One game day.
 * @property {string} day
 * @property {'work'|'off'} type
 * @property {number} bank           net worth at the bank at the end of the day (rounded cents)
 * @property {number} smooth         smoothed net worth at the end of the day (rounded cents)
 * @property {number} result         smooth(day) − smooth(day−1) − reval
 * @property {number} earned         accrued pay + other income received + pay variance (>= 0 normally)
 * @property {number} bills          accrued bills + variance on charge days; actual Book charges when smoothing is off (>= 0)
 * @property {number} spent          non-Book spends net of refunds and of capitalised value (>= 0 normally)
 * @property {number} conv           game-class part of `spent`
 * @property {number} other          result − (earned − bills − spent): transfers to unlinked accounts, loan principal steps…
 * @property {number} reval          change caused by owner revaluations of manual accounts entered for this day
 * @property {boolean} partial       true for today (the day is not over) and for days the bank has not fully reported
 */

/**
 * @typedef {Object} Round  A day played against Habit.
 * @property {string} day
 * @property {number} n              round number = day of month
 * @property {'work'|'off'} type     work is played with Black, off with White
 * @property {'prematch'|'future'|'live'|'awaiting'|'provisional'|'final'} status
 * @property {number} habit          cents Habit "plays" on this kind of day (0 when no segment exists yet)
 * @property {number} winLine        spend this or less to win, cents
 * @property {number} lossLine       spend more than this to lose, cents
 * @property {number} conv           convenience spending so far / on the day, cents
 * @property {number} kept           habit − conv (may be negative)
 * @property {1|0.5|0|null} result   null unless status is provisional or final (prematch rounds carry an exhibition result)
 * @property {boolean} bye
 * @property {boolean} clean         conv is 0 on a provisional or final round
 * @property {number} stops          game-class spends in stop categories that day
 * @property {object[]} moves        every transaction of the day (Tx objects, including declines and non-game moves),
 *                                   ordered by `at` when known, else by loggedAt
 * @property {{ ready: { label: string, yes: boolean }[], stops: number|null }|null} plan
 */

/**
 * @typedef {Object} MonthTable
 * @property {string} ym
 * @property {Round[]} rounds        one per day of the month
 * @property {number} score          Σ results of rounds that have one (prematch excluded)
 * @property {number} played         rounds that have a result (prematch excluded)
 * @property {{ score: number, played: number }} black   workdays
 * @property {{ score: number, played: number }} white   days off
 * @property {number} kept           Σ kept over the rounds counted in `played`
 * @property {number} finals         how many of those are final (bank-complete)
 * @property {number} cleanSheets
 * @property {number} perfect        Σ habit over every day of the month: what a perfect month is worth
 * @property {{ rounds: Round[], score: number, played: number }[]} weeks   rounds in chunks of seven by day of month (1-7, 8-14, …)
 */

/**
 * @typedef {Object} Edge  Kept versus Habit.
 * @property {number} kept           Σ kept over final and provisional rounds since the match began
 * @property {number} verified       the part from final rounds
 * @property {number} moved          Σ recorded sweeps
 * @property {number} unmoved        max(0, kept − moved)
 * @property {{ weekOf: string, amount: number, target: 'card'|'reserve' }|null} sweep   the open suggestion, if any
 * @property {number} unbeaten       current run of rounds without a loss (byes neither extend nor end it)
 * @property {number} bestUnbeaten
 * @property {(1|0.5|0)[]} form      results of the last seven rounds that have one, oldest first
 */

/**
 * @typedef {Object} Clock
 * @property {number} cash           cash on hand now, cents
 * @property {number|null} asOf      oldest balance timestamp among cash bank accounts
 * @property {string|null} nextPayday  the next day a pay stream (payStreams) pays; today on the scheduled payday until its deposit
 *                                  lands, and while a scheduled payday has passed with no deposit seen (expected any day); null when
 *                                  no pay stream is left (none, lapsed or ended)
 * @property {string|null} payAwaited  the scheduled payday BEFORE today whose deposit is not on the record, 'YYYY-MM-DD'; otherwise
 *                                  null. On the scheduled payday itself pay is not late: null (ruling T1)
 * @property {string} dueUntil       the last day of the due window, always set and never before today: the day before nextPayday;
 *                                  today alone on the payday itself and for the PAY_GRACE_DAYS (2) days after a scheduled payday whose
 *                                  deposit is not on the record; from the third day the next scheduled payday after today; today + 13
 *                                  when no payday is known
 * @property {{ id: string, name: string, day: string, amount: number, overdue?: boolean }[]} due   what is due from today through dueUntil,
 *                                  and every overdue item whatever the window. `overdue: true` marks a Book entry whose day has passed
 *                                  with no linked outflow seen (a charge, or the payment or transfer that settles it); it stays until
 *                                  that posts or the entry lapses (1.5 periods)
 * @property {number} dueTotal
 * @property {number} shortfall      max(0, dueTotal − cash)
 * @property {number} burn           typical outflow per day over the trailing 60 days, cents (0 when unknown)
 * @property {number|null} runwayDays  whole days cash covers at `burn`; null when burn is unknown
 * @property {boolean} trouble       shortfall > 0, or runway under 7 days
 * @property {{ label: string, amount: number, reached: boolean }[]} milestones   1 day, 1 week, 2 weeks, 1 month, 3 months of burn, then the reserve goal
 * @property {number} reserve        Σ now-balances of cash accounts flagged `reserve` (all cash accounts when none is flagged)
 * @property {number} reserveTarget  goals.reserve.target
 */


/* ------------------------------------------------------------------ public */

/**
 * Build the per-render ledger: indexes computed once, every query below as a method
 * (`ledger.position()`, `ledger.closes(from, to)`, `ledger.round(day)` …).
 * Each method answers as the standalone function of the same name does, without `state` and `nowMs`:
 *   today (a property) · dayType(day) · habitFor(day) · convOn(day) · accountValueOn(accountId, day)
 *   position() · closes(fromDay, toDay) · round(day) · monthTable(ym) · edge() · clock()
 *   retention(day) · spendingByCategory(fromDay, toDay)
 * The indexes are built on first use and describe the document as it was then: make a new ledger
 * after the document changes. Results are shared between calls — treat them as read-only.
 * @param {object} state
 * @param {number} nowMs
 * @returns {object}
 */
export function makeLedger(state, nowMs) {
  const core = makeCore(state, nowMs);
  return {
    today: core.today,
    dayType: (day) => typeOfDay(core.days, core.workdays, day),
    habitFor: (day) => habitOn(core, day),
    convOn: (day) => convOf(bucketOn(core, core.cal.num(day))),
    accountValueOn: (accountId, day) => accountValueAt(core, accountId, day),
    position: () => core.position(),
    closes: (fromDay, toDay) => closesBetween(core, fromDay, toDay),
    round: (day) => roundOn(core, day),
    monthTable: (ym) => monthTableOf(core, ym),
    edge: () => edgeOf(core),
    clock: () => clockOf(core),
    payStreams: () => payStreamsOf(core),
    retention: (day) => retentionOf(core, day),
    spendingByCategory: (fromDay, toDay) => spendingBetween(core, fromDay, toDay),
  };
}

/** Today's game day. */
export function todayOf(state, nowMs) {
  return gameDay(timeOf(nowMs), rolloverOf(settingsOf(state)));
}

/** 'work' or 'off' for a day (its own record, else the weekday default). */
export function dayType(state, day) {
  return typeOfDay(daysOf(state), workdaysOf(settingsOf(state)), day);
}

/**
 * Habit, win line and loss line in force on a day.
 * Before the first segment's `from`, the first segment is used (exhibition). With no segment at all
 * everything is 0.
 * @returns {{ habit: number, winLine: number, lossLine: number, segment: object|null }}
 */
export function habitFor(state, day) {
  return habitLines(readSegments(state), dayType(state, day), day);
}

/**
 * Convenience (game-class) spending on a day: spends net of refunds, never below 0, counting live
 * bank rows and unmatched provisional moves no older than 7 days (ARCHITECTURE 4.6).
 * @returns {number} cents
 */
export function convOn(state, day, nowMs) {
  return makeLedger(state, nowMs).convOn(day);
}

/**
 * An account's signed value at the end of a game day (ARCHITECTURE 4.2). For today or later it is the
 * now-balance.
 * @returns {number} cents
 */
export function accountValueOn(state, accountId, day, nowMs) {
  return makeLedger(state, nowMs).accountValueOn(accountId, day);
}

/** @returns {Position} */
export function position(state, nowMs) {
  return makeLedger(state, nowMs).position();
}

/**
 * Daily closes for fromDay..toDay inclusive (toDay is capped at today). The first element's
 * `result` uses the close of the day before fromDay.
 * @returns {DayClose[]}
 */
export function closes(state, fromDay, toDay, nowMs) {
  return makeLedger(state, nowMs).closes(fromDay, toDay);
}

/** @returns {Round} */
export function round(state, day, nowMs) {
  return makeLedger(state, nowMs).round(day);
}

/** @returns {MonthTable} */
export function monthTable(state, ym, nowMs) {
  return makeLedger(state, nowMs).monthTable(ym);
}

/** @returns {Edge} */
export function edge(state, nowMs) {
  return makeLedger(state, nowMs).edge();
}

/** @returns {Clock} */
export function clock(state, nowMs) {
  return makeLedger(state, nowMs).clock();
}

/**
 * Month-to-date retention for the month containing `day` (through `day` or today, whichever is earlier):
 * what was earned, what bills used, what was spent, what was kept.
 * @returns {{ ym: string, days: number, earned: number, bills: number, spent: number, other: number, kept: number, rate: number|null }}
 *   kept = Σ result = earned − bills − spent + other (other: money in or out that is none of the three,
 *   such as a transfer from an account left out); rate = kept / earned (null when under $1.00 was earned)
 */
export function retention(state, day, nowMs) {
  return makeLedger(state, nowMs).retention(day);
}

/**
 * The streams that count as pay (see payStreamsOf): scheduled, not lapsed, and either counted day by
 * day or bringing in at least $200.00 a month.
 * @returns {object[]} Stream records of the document
 */
export function payStreams(state, nowMs) {
  return makeLedger(state, nowMs).payStreams();
}

/**
 * Spending by category for fromDay..toDay inclusive (spends net of refunds; Book charges included
 * under their own categories; transfers, payments and declines excluded).
 * @returns {{ category: string, klass: string, amount: number, count: number }[]} largest first
 */
export function spendingByCategory(state, fromDay, toDay, nowMs) {
  return makeLedger(state, nowMs).spendingByCategory(fromDay, toDay);
}

/* -------------------------------------------------------------------- core */

/**
 * Everything one ledger shares. Days are held as day numbers (whole days since the epoch) so the
 * hot loops do integer arithmetic; `cal` converts at the edges. Each index is built on first use.
 */
function makeCore(state, nowMs) {
  const doc = isObject(state) ? state : {};
  const settings = settingsOf(doc);
  const now = timeOf(nowMs);
  const rollover = rolloverOf(settings);
  const cal = makeCalendar();
  const today = gameDay(now, rollover);
  const todayN = cal.num(today);
  const core = {
    doc, settings, now, rollover, cal, today, todayN,
    days: daysOf(doc),
    workdays: workdaysOf(settings),
    segments: readSegments(doc),
    matchN: cal.num(isObject(doc.meta) ? doc.meta.matchStart : null),
    syncedAt: isObject(doc.sync) && Number.isFinite(doc.sync.lastOk) ? doc.sync.lastOk : null,
    nowPoint: { n: todayN, f: gameDayFraction(now, rollover) },
    rawCloses: new Map(),
    rounds: new Map(),
    series: new Map(),
  };
  core.stopPoint = stopPointOf(core);
  core.accounts = once(() => readAccounts(doc));
  core.data = once(() => readDataAge(core));
  core.knownFrom = once(() => readKnownFrom(core));
  core.index = once(() => buildIndex(core));
  core.bankNow = once(() => sumOf([...core.accounts().values()], (holder) => (holder.bank && !holder.hidden ? bankNowOf(core, holder) : 0)));
  core.manual = once(() => buildManual(core));
  core.accruals = once(() => buildAccruals(core));
  core.position = once(() => buildPosition(core));
  return core;
}

/** Day strings <-> day numbers, validated and remembered. */
function makeCalendar() {
  const numbers = new Map();
  const names = new Map();
  return {
    /** Day number of a Ymd string; null when it is not a real day. */
    num(day) {
      let n = numbers.get(day);
      if (n === undefined) {
        n = isYmd(day) ? diffDays(EPOCH, day) : null;
        numbers.set(day, n);
      }
      return n;
    },
    day(n) {
      let day = names.get(n);
      if (day === undefined) {
        day = addDays(EPOCH, n);
        names.set(n, day);
      }
      return day;
    },
  };
}

/** The instant accrual stopped, as a point on the day axis; null while the bank data is fresh enough. */
function stopPointOf(core) {
  if (core.syncedAt === null) return null;
  const stopMs = core.syncedAt + ACCRUAL_STOP_MS;
  if (core.now <= stopMs) return null;
  const n = core.cal.num(gameDay(stopMs, core.rollover));
  return n === null ? null : { n, f: gameDayFraction(stopMs, core.rollover) };
}

function freshnessOf(core) {
  if (core.syncedAt === null) return 'none';
  const age = core.now - core.syncedAt;
  if (age <= ACCRUAL_STOP_MS) return 'fresh';
  return age <= AGING_LIMIT_MS ? 'aging' : 'old';
}

/* ------------------------------------------------------- day type and habit */

function typeOfDay(days, workdays, day) {
  const record = dayRecord(days, day);
  if (record && (record.type === 'work' || record.type === 'off')) return record.type;
  return isYmd(day) && workdays.includes(dow(day)) ? 'work' : 'off';
}

function dayRecord(days, day) {
  const record = typeof day === 'string' && Object.hasOwn(days, day) ? days[day] : null;
  return isObject(record) ? record : null;
}

/** Usable habit segments, oldest first (the document is not reordered). */
function readSegments(state) {
  return listOf(isObject(state) ? state.habits : null)
    .filter((segment) => isObject(segment) && isYmd(segment.from))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

function habitOn(core, day) {
  return habitLines(core.segments, typeOfDay(core.days, core.workdays, day), day);
}

function habitLines(segments, type, day) {
  let segment = segments.length ? segments[0] : null;
  for (const candidate of segments) if (candidate.from <= day) segment = candidate;
  if (!segment) return { habit: 0, winLine: 0, lossLine: 0, segment: null };
  const work = type === 'work';
  const habit = wholeCents(work ? segment.work : segment.off);
  return {
    habit,
    winLine: wholeCents(work ? segment.winWork : segment.winOff),
    lossLine: Math.ceil(habit / 100) * 100,
    segment,
  };
}

/* ---------------------------------------------------------------- accounts */

/**
 * Every usable account by id: its group, whether its value comes from the bank, and whether it is
 * a manual loan amortised from its terms (ARCHITECTURE 4.2).
 */
function readAccounts(doc) {
  const byId = new Map();
  for (const account of listOf(doc.accounts)) {
    if (!isObject(account) || typeof account.id !== 'string' || !Object.hasOwn(ACCOUNT_TYPES, account.type)) continue;
    if (byId.has(account.id)) continue;
    const { group } = ACCOUNT_TYPES[account.type];
    const bank = account.source === 'bank';
    byId.set(account.id, {
      id: account.id, account, group, bank,
      hidden: !!account.hidden,
      amortised: !bank && group === 'debt' && hasLoanTerms(account),
    });
  }
  return byId;
}

function hasLoanTerms(account) {
  return isObject(account.loan) && positive(account.loan.payment) && Number.isFinite(account.apr) && account.apr >= 0;
}

/** True when an account id names a hidden account (left out of everything). */
function heldHidden(core, accountId) {
  const holder = accountId == null ? null : core.accounts().get(accountId);
  return !!holder && holder.hidden;
}

/** Oldest balance timestamp among everyday bank accounts, and its game day (ARCHITECTURE 4.6). */
function readDataAge(core) {
  let at = null;
  for (const holder of core.accounts().values()) {
    const { everyday, asOf } = holder.account;
    if (!holder.bank || holder.hidden || !everyday || !positive(asOf)) continue;
    if (at === null || asOf < at) at = asOf;
  }
  return { at, n: at === null ? null : core.cal.num(gameDay(at, core.rollover)) };
}

/**
 * The first day the bank feed covers (sync.from), as a day number; null when the document does not
 * say. A transaction dated earlier moves it back: what the feed delivered, it covers.
 */
function readKnownFrom(core) {
  const from = core.cal.num(isObject(core.doc.sync) ? core.doc.sync.from : null);
  const { order } = core.index();
  return from === null || !order.length ? from : Math.min(from, order[0]);
}

/** A bank account's balance now: what the bank reported plus its counted pending rows. */
function bankNowOf(core, holder) {
  return wholeSigned(holder.account.balance) + (core.index().pendingNow.get(holder.id) || 0);
}

function nowValueOf(core, holder) {
  return holder.bank ? bankNowOf(core, holder) : valueAt(seriesOf(core, holder), core.todayN);
}

function accountValueAt(core, accountId, day) {
  const holder = core.accounts().get(accountId);
  if (!holder) return 0;
  const n = core.cal.num(day);
  if (n === null || n >= core.todayN) return nowValueOf(core, holder);
  if (!holder.bank) return valueAt(seriesOf(core, holder), n);
  let later = 0;
  for (const [m, effect] of core.index().effects.get(holder.id) || []) if (m > n && m <= core.todayN) later += effect;
  return bankNowOf(core, holder) - later;
}

/* ------------------------------------------------------- transaction index */

/**
 * One pass over the transactions. Per day: the moves that count and what they add up to. Per bank
 * account: the effect of each day, for running balances backward. Per stream and Book entry: the
 * days their deposits and charges landed, which is where accruals reset.
 */
function buildIndex(core) {
  const index = {
    buckets: new Map(),       // day number -> bucket
    effects: new Map(),       // bank account id -> Map(day number -> signed cents), hidden accounts too
    pendingNow: new Map(),    // bank account id -> signed cents of its counted pending rows
    payDays: new Map(),       // stream id -> day numbers of its deposits
    charges: new Map(),       // Book entry id -> day numbers of its charges
    settled: new Map(),       // Book entry id -> day numbers of every outflow linked to it: its charges, and the
                              // payments or transfers between the owner's accounts that settle it (the clock's test)
    neutralLinks: new Set(),  // Book entry ids linked to moves between the owner's own accounts
    capital: new Map(),       // manual account id -> [{ n, value }] capitalised purchases
    loanPayments: new Map(),  // amortised loan id -> [{ day, amount }] payments seen in the feed
    loanOfEntry: loansByEntry(core),
    countPending: isOn(core.settings.countPending),
  };
  for (const tx of listOf(core.doc.txs)) indexRow(core, index, tx);
  index.order = [...index.buckets.keys()].sort(ascending);
  index.effectRunning = runningTotals(index, 'effect');
  index.provisionalRunning = runningTotals(index, 'provisional');
  index.cashOutRunning = runningTotals(index, 'cashOut');
  return index;
}

function newBucket() {
  return {
    moves: [], sorted: false,
    effect: 0,          // change of the bank balances
    income: 0,          // income received
    spent: 0,           // non-Book spends net of refunds and of capitalised value
    book: 0,            // Book charges
    gameSpend: 0, gameRefund: 0, stops: 0,
    cashOut: 0,         // outflows from cash accounts other than transfers
    provisional: 0,     // unmatched provisional moves still counting
    pending: false,     // the bank has a pending row on this day
    unconfirmed: false, // a provisional move is waiting for its bank row
    loans: null,        // amortised loans paid on this day
  };
}

const EMPTY_BUCKET = Object.freeze({ ...newBucket(), moves: Object.freeze([]), sorted: true });

function bucketFor(index, n) {
  let bucket = index.buckets.get(n);
  if (!bucket) {
    bucket = newBucket();
    index.buckets.set(n, bucket);
  }
  return bucket;
}

function bucketOn(core, n) {
  return (n === null ? null : core.index().buckets.get(n)) || EMPTY_BUCKET;
}

/** Amortised loans by the Book entry that pays them down. */
function loansByEntry(core) {
  const byEntry = new Map();
  for (const entry of listOf(core.doc.recurring)) {
    if (!isObject(entry) || entry.toAccountId == null) continue;
    const loan = core.accounts().get(entry.toAccountId);
    if (loan && loan.amortised && !loan.hidden) byEntry.set(entry.id, loan);
  }
  return byEntry;
}

/**
 * Decide what a row is (ARCHITECTURE 4.2): a decline is shown and never counted; a matched move is
 * superseded; a manual move is provisional; anything else is a bank row on a known bank account.
 */
function indexRow(core, index, tx) {
  if (!isObject(tx) || !Number.isFinite(tx.amount) || tx.amount < 0) return;
  const n = core.cal.num(tx.day);
  if (n === null) return;
  const holder = tx.accountId == null ? null : core.accounts().get(tx.accountId) || null;
  const shown = holder === null || !holder.hidden;
  if (tx.kind === 'decline') {
    if (shown) bucketFor(index, n).moves.push(tx);
    return;
  }
  if (tx.matchId) return;
  if (tx.source === 'manual') {
    if (shown) indexProvisional(core, index, tx, n);
  } else if (holder && holder.bank) {
    indexBankRow(core, index, tx, n, holder);
  }
}

/** A move the owner tapped in: no bank balance holds it yet, so it is carried separately. */
function indexProvisional(core, index, tx, n) {
  if (tx.kind !== 'spend' || tx.flow === 'in' || core.todayN - n > PROVISIONAL_DAYS) return;
  const amount = Math.round(tx.amount);
  const bucket = bucketFor(index, n);
  bucket.provisional += amount;
  bucket.unconfirmed = true;
  bucket.moves.push(tx);
  tallySpend(core, index, bucket, tx, n, amount);
}

function indexBankRow(core, index, tx, n, holder) {
  if (tx.pending) {
    if (!holder.hidden) bucketFor(index, n).pending = true;
    if (!index.countPending) return;
  }
  const amount = Math.round(tx.amount);
  const effect = tx.flow === 'in' ? amount : -amount;
  if (tx.pending) addTo(index.pendingNow, holder.id, effect);
  let effects = index.effects.get(holder.id);
  if (!effects) index.effects.set(holder.id, effects = new Map());
  addTo(effects, n, effect);
  if (holder.hidden) return;

  const bucket = bucketFor(index, n);
  bucket.effect += effect;
  bucket.moves.push(tx);
  if (effect < 0 && holder.group === 'cash' && tx.kind !== 'transfer') bucket.cashOut += amount;
  if (tx.kind === 'income') {
    bucket.income += effect;
    if (effect > 0 && tx.streamId != null) pushTo(index.payDays, tx.streamId, n);
  } else if (tx.kind === 'spend' || tx.kind === 'refund') {
    tallySpend(core, index, bucket, tx, n, -effect);
  } else if ((tx.kind === 'payment' || tx.kind === 'transfer') && effect < 0 && tx.recurringId != null) {
    tallyBookPayment(index, bucket, tx, n, amount);
  }
}

/** A spend (outflow > 0) or a refund (outflow < 0): Book charge or spending, and the daily game. */
function tallySpend(core, index, bucket, tx, n, outflow) {
  const game = tx.klass === 'game';
  const charge = tx.kind === 'spend' && outflow > 0;
  const net = outflow - (charge ? capitalised(core, index, tx, n, outflow) : 0);
  if (!game && (tx.recurringId != null || tx.klass === 'book')) bucket.book += net;
  else bucket.spent += net;
  if (game) {
    if (outflow > 0) bucket.gameSpend += outflow;
    else bucket.gameRefund -= outflow;
    if (charge && isStop(tx.category)) bucket.stops += 1;
  }
  if (charge && tx.recurringId != null && tx.source !== 'manual') linkCharge(index, bucket, tx, n, outflow);
}

/**
 * A Book entry paid by a payment or transfer. When the other leg is one of the owner's linked
 * accounts nothing left the books; otherwise it is a charge like any other (a loan payment).
 */
function tallyBookPayment(index, bucket, tx, n, amount) {
  if (tx.pairId != null) {
    index.neutralLinks.add(tx.recurringId);
    pushTo(index.settled, tx.recurringId, n);
    return;
  }
  bucket.book += amount;
  linkCharge(index, bucket, tx, n, amount);
}

function linkCharge(index, bucket, tx, n, amount) {
  pushTo(index.charges, tx.recurringId, n);
  pushTo(index.settled, tx.recurringId, n);
  const loan = index.loanOfEntry.get(tx.recurringId);
  if (!loan) return;
  pushTo(index.loanPayments, loan.id, { day: tx.day, amount });
  if (!bucket.loans) bucket.loans = new Set();
  bucket.loans.add(loan.id);
}

/**
 * The part of a purchase that became an asset rather than an expense. It is also remembered against
 * the manual account that holds it, whose value steps up on the day of the purchase.
 */
function capitalised(core, index, tx, n, outflow) {
  const capital = tx.capital;
  if (!isObject(capital) || !positive(capital.value)) return 0;
  const value = Math.round(capital.value);
  const target = capital.accountId == null ? null : core.accounts().get(capital.accountId);
  if (target && !target.bank && !target.amortised && !target.hidden) pushTo(index.capital, target.id, { n, value });
  return Math.min(value, outflow);
}

function isStop(category) {
  return Object.hasOwn(CATEGORIES, category) && !!CATEGORIES[category].stop;
}

function convOf(bucket) {
  return Math.max(0, bucket.gameSpend - bucket.gameRefund);
}

/** Running totals of one bucket field, in day order. */
function runningTotals(index, field) {
  let total = 0;
  return index.order.map((n) => (total += index.buckets.get(n)[field]));
}

/** The sum of a bucket field over every day up to and including `n`. */
function totalThrough(index, running, n) {
  const i = lastAtOrBelow(index.order, n);
  return i < 0 ? 0 : running[i];
}

function provisionalThrough(core, n) {
  const index = core.index();
  return totalThrough(index, index.provisionalRunning, n);
}

/* ---------------------------------------------------------- manual accounts */

/**
 * A manual account's value through time as steps: `initial` before the first step, then
 * `values[i]` from day `nums[i]` on. `reval` holds the part of a step that is the owner's own
 * revaluation (a later history entry), by day.
 */
function seriesOf(core, holder) {
  let series = core.series.get(holder.id);
  if (!series) {
    series = holder.amortised ? loanSeries(core, holder) : historySeries(core, holder);
    core.series.set(holder.id, series);
  }
  return series;
}

function valueAt(series, n) {
  const i = lastAtOrBelow(series.nums, n);
  return i < 0 ? series.initial : series.values[i];
}

function newSeries(initial) {
  return { initial, nums: [], values: [], reval: new Map() };
}

function addStep(series, n, value) {
  series.nums.push(n);
  series.values.push(value);
}

/** The visible manual accounts' series and their revaluations summed by day. */
function buildManual(core) {
  const series = [];
  const reval = new Map();
  for (const holder of core.accounts().values()) {
    if (holder.bank || holder.hidden) continue;
    const own = seriesOf(core, holder);
    series.push(own);
    for (const [n, change] of own.reval) addTo(reval, n, change);
  }
  return { series, reval };
}

function manualOn(core, n) {
  let total = 0;
  for (const series of core.manual().series) total += valueAt(series, n);
  return total;
}

/**
 * History entries as { n, balance }, oldest first, one per day (the later entry of a day wins).
 * An account with no history is taken as one entry: its balance on the day it was entered.
 */
function historyEntries(core, account) {
  const entries = [];
  for (const entry of listOf(account.history)) {
    const n = isObject(entry) && Number.isFinite(entry.balance) ? core.cal.num(entry.day) : null;
    if (n !== null) entries.push({ n, balance: Math.round(entry.balance) });
  }
  if (!entries.length && positive(account.asOf)) {
    const n = core.cal.num(gameDay(account.asOf, core.rollover));
    if (n !== null) entries.push({ n, balance: wholeSigned(account.balance) });
  }
  entries.sort((a, b) => a.n - b.n);
  return entries.filter((entry, i) => i === entries.length - 1 || entries[i + 1].n !== entry.n);
}

/**
 * ARCHITECTURE 4.2: the value is the latest entry on or before the day, and the first entry also
 * covers earlier days. A capitalised purchase steps the value on its own day: it adds to the entry
 * before it, and is taken off the first entry for the days before it was bought. An entry on the
 * day of a purchase already includes it.
 */
function historySeries(core, holder) {
  const entries = historyEntries(core, holder.account);
  if (!entries.length) return newSeries(wholeSigned(holder.account.balance));
  const bought = capitalByDay(core, holder.id);
  let value = entries[0].balance;
  for (const purchase of bought) if (purchase.n <= entries[0].n) value -= purchase.value;
  const series = newSeries(value);
  let b = 0;
  const stepPurchasesBefore = (limit) => {
    for (; b < bought.length && bought[b].n < limit; b++) {
      value += bought[b].value;
      addStep(series, bought[b].n, value);
    }
  };
  stepPurchasesBefore(entries[0].n);
  entries.forEach((entry, i) => {
    const boughtThatDay = b < bought.length && bought[b].n === entry.n ? bought[b++].value : 0;
    if (i > 0) noteReval(series, entry.n, entry.balance - value - boughtThatDay);
    value = entry.balance;
    addStep(series, entry.n, value);
    stepPurchasesBefore(i + 1 < entries.length ? entries[i + 1].n : Infinity);
  });
  return series;
}

/** Capitalised purchases of one account as { n, value }, one per day, oldest first. */
function capitalByDay(core, accountId) {
  const byDay = new Map();
  for (const { n, value } of core.index().capital.get(accountId) || []) addTo(byDay, n, value);
  return [...byDay].map(([n, value]) => ({ n, value })).sort((a, b) => a.n - b.n);
}

function noteReval(series, n, change) {
  if (change !== 0) series.reval.set(n, change);
}

/**
 * An amortised loan (loans.js) moves only on the days of its history entries, of the payments seen
 * in the feed and of its due days, so it is valued once on each of those. A history entry after the
 * first is the owner's revaluation.
 */
function loanSeries(core, holder) {
  const { account } = holder;
  const payments = core.index().loanPayments.get(holder.id) || [];
  const valueOn = (n) => loanValueOn(account, core.cal.day(n), payments);
  const entryNums = historyEntries(core, account).map((entry) => entry.n);
  const eventNums = [...entryNums, ...payments.map((payment) => core.cal.num(payment.day)), ...dueNums(core, account, entryNums)];
  const nums = uniqueSorted(eventNums).filter((n) => n <= core.todayN);
  if (!nums.length || core.todayN - nums[0] > MAX_LOAN_AGE_DAYS) return newSeries(valueOn(core.todayN));

  const series = newSeries(valueOn(nums[0] - 1));
  const revaluations = new Set(entryNums.slice(1));
  let value = series.initial;
  let settledUntil = -Infinity;
  for (const n of nums) {
    if (n < settledUntil) continue; // paid off: nothing moves until the owner enters a balance again
    const next = valueOn(n);
    if (revaluations.has(n)) noteReval(series, n, next - value);
    addStep(series, n, next);
    value = next;
    if (next === 0) settledUntil = entryNums.find((entry) => entry > n) ?? Infinity;
  }
  return series;
}

/** The loan's due day in every month from its first entry to today, when payments are assumed. */
function dueNums(core, account, entryNums) {
  if (!entryNums.length || !account.loan.assumeScheduled || !isDayOfMonth(account.dueDay)) return [];
  if (core.todayN - entryNums[0] > MAX_LOAN_AGE_DAYS) return [];
  const nums = [];
  const lastMonth = monthOf(core.today);
  for (let ym = monthOf(core.cal.day(entryNums[0])); ym <= lastMonth; ym = addMonthsYm(ym, 1)) {
    nums.push(core.cal.num(addMonths(startOfMonth(ym), 0, account.dueDay)));
  }
  return nums;
}

/* ---------------------------------------------------------------- accruals */

/**
 * What accrues (ARCHITECTURE 4.3): pay for every accruing stream and bills for every active Book
 * entry — but only while smoothing is switched on and some stream accrues; otherwise nothing does.
 * Each item: { id, name, capDays, lapseDays, lastReset(n), dailyOn(n) }.
 */
function buildAccruals(core) {
  const off = { on: false, pay: [], bills: [] };
  if (!isOn(core.settings.smoothing)) return off;
  const index = core.index();
  const pay = listOf(core.doc.streams)
    .filter((stream) => isScheduled(core, stream) && stream.accrue)
    .map((stream) => payItem(core, index, stream));
  if (!pay.length) return off;
  const bills = [];
  for (const entry of listOf(core.doc.recurring)) {
    const item = billItem(core, index, entry);
    if (item) bills.push(item);
  }
  return { on: true, pay, bills };
}

/** An active stream with a schedule and an amount, paid into an account that is not hidden. */
function isScheduled(core, stream) {
  return isObject(stream) && !!stream.active && hasCadence(stream) && isYmd(stream.anchor)
    && positive(stream.amount) && !heldHidden(core, stream.accountId);
}

function hasCadence(item) {
  return typeof item.cadence === 'string' && Object.hasOwn(CADENCES, item.cadence);
}

function dailyOf(item) {
  return item.amount / CADENCES[item.cadence].days;
}

function payItem(core, index, stream) {
  const daily = dailyOf(stream);
  return {
    id: stream.id,
    name: nameOf(stream),
    capDays: PAY_CAP_PERIODS * CADENCES[stream.cadence].days,
    // Pay that stops: past the cap with no deposit the receivable is released, not frozen.
    lapseDays: PAY_CAP_PERIODS * CADENCES[stream.cadence].days,
    lastReset: makeResets(core, stream, index.payDays.get(stream.id)),
    dailyOn: () => daily,
  };
}

/**
 * The accrual of one Book entry, or null when it does not accrue:
 *  - it is inactive, has no amount, or is charged to a hidden account;
 *  - it has neither a charge nor an anchor to count from, or its only linked moves are between the
 *    owner's own accounts;
 *  - it pays down a debt the bank reports (that balance already shows principal and interest).
 * A payment on an amortised loan accrues only its interest, at the loan's daily rate.
 */
function billItem(core, index, entry) {
  if (!isObject(entry) || !entry.active || !hasCadence(entry) || !positive(entry.amount)) return null;
  if (heldHidden(core, entry.accountId)) return null;
  const charges = index.charges.get(entry.id);
  if (!charges && (index.neutralLinks.has(entry.id) || !isYmd(entry.anchor))) return null;
  const debt = entry.toAccountId == null ? null : core.accounts().get(entry.toAccountId) || null;
  if (debt && debt.bank) return null;

  const loan = index.loanOfEntry.get(entry.id) || null;
  const daily = dailyOf(entry);
  const cadenceDays = CADENCES[entry.cadence].days;
  return {
    id: entry.id,
    name: nameOf(entry),
    capDays: BILL_CAP_PERIODS * cadenceDays,
    lapseDays: BILL_LAPSE_PERIODS * cadenceDays,
    lastReset: makeResets(core, entry, charges, byHand(entry)),
    dailyOn: loan ? (n) => dailyInterest(-valueAt(seriesOf(core, loan), n), loan.account.apr) : () => daily,
  };
}

/** An entry the owner added by hand: nothing is known of it before its anchor or the day it was added. */
function byHand(entry) {
  return entry.source === 'manual' || isYmd(entry.since);
}

/**
 * Where an accrual starts over (the latest reset on or before a day), or null when nothing accrues yet.
 *  - From the first linked transaction on: the latest day one landed.
 *  - Before the first linked transaction: nothing earlier than one period ahead of it — there is no
 *    pre-history. Inside that one period the accrual runs from the scheduled day that opens it.
 *  - With nothing linked: a stream follows its anchor's schedule (book.lastOccurrence, read from one
 *    projection), and so does a detected Book entry; an entry added by hand (`fromAnchorOnly`) counts
 *    from its anchor alone, so that it lapses like any other when no charge is ever seen, and has
 *    nothing before that anchor.
 *  - An entry added by hand has nothing before its `since` day.
 * @returns {(n: number) => number|null}
 */
function makeResets(core, item, linkedDays, fromAnchorOnly = false) {
  const linked = uniqueSorted(linkedDays || []);
  const firstLinked = linked.length ? linked[0] : Infinity;
  const period = Math.round(CADENCES[item.cadence].days);
  const sinceN = isYmd(item.since) ? core.cal.num(item.since) : null;
  const anchorN = core.cal.num(item.anchor);
  const longestGap = Math.ceil(CADENCES[item.cadence].days) + 2;
  let projected = [];
  let coveredFrom = core.todayN; // `projected` holds the schedule after this day
  let start; // where the one period ahead of the first linked transaction begins

  return (n) => {
    if (n >= firstLinked) return linked[lastAtOrBelow(linked, n)];
    if (sinceN !== null && n < sinceN) return null;
    if (linked.length) {
      if (start === undefined) {
        // the scheduled day just ahead of the first linked transaction; one period ahead when the schedule has none
        const ahead = occurrences(item, core.cal.day(firstLinked - longestGap - 1), core.cal.day(firstLinked - 1));
        start = ahead.length ? core.cal.num(ahead[ahead.length - 1]) : firstLinked - period;
      }
      return n < start ? null : sinceN === null ? start : Math.max(start, sinceN);
    }
    if (fromAnchorOnly) {
      if (anchorN === null || n < anchorN) return null;
      return sinceN === null ? anchorN : Math.max(anchorN, sinceN);
    }
    if (n - longestGap < coveredFrom) {
      const from = n - longestGap - PROJECTION_MARGIN_DAYS;
      const earlier = occurrences(item, core.cal.day(from), core.cal.day(coveredFrom));
      projected = earlier.map((day) => core.cal.num(day)).concat(projected);
      coveredFrom = from;
    }
    const i = lastAtOrBelow(projected, n);
    return i < 0 ? null : projected[i];
  };
}

/**
 * The point on the day axis at which accruals are read for a day: its end, and the present instant
 * for today. Two limits hold it still: nothing accrues after the instant accrual stopped
 * (ARCHITECTURE 4.5), and before the bank feed begins the accruals stand where they stood on the eve
 * of its first day — a schedule projected over days with no transactions would only draw a sawtooth.
 */
function accrualPoint(core, n) {
  const knownFrom = core.knownFrom();
  const eve = knownFrom === null ? n : Math.min(knownFrom, core.todayN) - 1;
  const point = n >= core.todayN ? core.nowPoint : { n: Math.max(n, eve), f: 1 };
  const stop = core.stopPoint;
  return stop && (point.n > stop.n || (point.n === stop.n && point.f > stop.f)) ? stop : point;
}

/** Days an item has accrued at a point, capped; null when it is not accruing there. */
function accruingDays(item, point) {
  const reset = item.lastReset(point.n);
  if (reset === null) return null;
  const elapsed = point.n - reset + point.f;
  return elapsed > item.lapseDays ? null : Math.min(elapsed, item.capDays);
}

function accruedTotal(items, point) {
  let total = 0;
  for (const item of items) {
    const days = accruingDays(item, point);
    if (days !== null) total += item.dailyOn(point.n) * days;
  }
  return total;
}

/** One line per item accruing at a point, for the composition of the live number. */
function accrualLines(core, items, point) {
  const lines = [];
  for (const item of items) {
    const days = accruingDays(item, point);
    if (days === null) continue;
    const daily = item.dailyOn(point.n);
    lines.push({
      id: item.id, name: item.name, amount: daily * days, daily,
      since: core.cal.day(item.lastReset(point.n)),
      rising: days < item.capDays,
    });
  }
  return lines;
}

/* ------------------------------------------------------------------ closes */

/** Net worth at the bank at the end of a day: bank balances run backward plus the manual accounts. */
function bankOn(core, n) {
  const index = core.index();
  const at = Math.min(n, core.todayN);
  // Only rows up to today are run backward: a row dated after today (a posting date ahead of the
  // clock) is not in a past close and moves none of them; it counts on its own day, once that day comes.
  const later = at >= core.todayN ? 0 : totalThrough(index, index.effectRunning, core.todayN) - totalThrough(index, index.effectRunning, at);
  return core.bankNow() - later + manualOn(core, at);
}

/**
 * The figures of a close that later days are compared with. Receivable and payable are rounded on
 * their own, so that every part of a day's result is whole cents and the parts add up exactly.
 */
function rawClose(core, n) {
  let raw = core.rawCloses.get(n);
  if (!raw) {
    const accruals = core.accruals();
    const point = accrualPoint(core, n);
    const bank = bankOn(core, n);
    const receivable = roundCents(accruedTotal(accruals.pay, point));
    const payable = roundCents(accruedTotal(accruals.bills, point));
    raw = { bank, receivable, payable, smooth: bank + receivable - payable - provisionalThrough(core, n) };
    core.rawCloses.set(n, raw);
  }
  return raw;
}

function closesBetween(core, fromDay, toDay) {
  const from = core.cal.num(fromDay);
  const to = core.cal.num(toDay);
  if (from === null || to === null) return [];
  const rows = [];
  for (let n = from; n <= Math.min(to, core.todayN); n++) rows.push(dayClose(core, n));
  return rows;
}

function dayClose(core, n) {
  const raw = rawClose(core, n);
  const before = rawClose(core, n - 1);
  const bucket = bucketOn(core, n);
  const day = core.cal.day(n);
  const reval = core.manual().reval.get(n) || 0;
  const result = raw.smooth - before.smooth - reval;
  const earned = raw.receivable - before.receivable + bucket.income;
  const bills = raw.payable - before.payable + bucket.book - principalPaid(core, bucket, n);
  return {
    day,
    type: typeOfDay(core.days, core.workdays, day),
    bank: raw.bank,
    smooth: raw.smooth,
    result: roundCents(result),
    earned: roundCents(earned),
    bills: roundCents(bills),
    spent: roundCents(bucket.spent),
    conv: convOf(bucket),
    other: roundCents(result - (earned - bills - bucket.spent)),
    reval,
    partial: n >= core.todayN || dataStatusOf(core, n, bucket) !== 'final',
  };
}

/**
 * How much the day's loan payments took off the loans themselves: that part of a payment is not a
 * bill (ARCHITECTURE 4.3) — it is matched by the step in the loan's value.
 */
function principalPaid(core, bucket, n) {
  if (!bucket.loans) return 0;
  let principal = 0;
  for (const loanId of bucket.loans) {
    const series = seriesOf(core, core.accounts().get(loanId));
    principal += valueAt(series, n) - valueAt(series, n - 1) - (series.reval.get(n) || 0);
  }
  return principal;
}

/* ---------------------------------------------------------------- position */

function buildPosition(core) {
  const totals = accountTotals(core);
  const accruals = core.accruals();
  const point = accrualPoint(core, core.todayN);
  const pay = accrualLines(core, accruals.pay, point);
  const bills = accrualLines(core, accruals.bills, point);
  const receivable = sumOf(pay, (line) => line.amount);
  const payable = sumOf(bills, (line) => line.amount);
  const smooth = totals.bank + receivable - payable;
  const provisional = provisionalThrough(core, core.todayN);
  const rising = core.stopPoint === null ? risingDaily(pay) - risingDaily(bills) : 0;
  return {
    at: core.now,
    day: core.today,
    cash: totals.cash,
    cards: totals.cards,
    liquid: totals.cash + totals.cards,
    investments: totals.investments,
    slowAssets: totals.slowAssets,
    loans: totals.loans,
    assets: totals.assets,
    liabilities: totals.liabilities,
    bank: totals.bank,
    smoothing: accruals.on,
    receivable,
    payable,
    smooth,
    provisional,
    live: smooth - provisional,
    rate: rising / daySecondsOf(core),
    dataAt: core.data().at,
    syncedAt: core.syncedAt,
    freshness: freshnessOf(core),
    receivables: pay.map(shownLine),
    payables: bills.map(shownLine),
    lapsedPay: lapsedPayOf(core, accruals.pay, point),
  };
}

/**
 * Seconds in today's game day: 86,400, except on the two days a year the clocks change (82,800 and
 * 90,000). The live number covers one day of accrual over the real length of the day, so the rate
 * is taken over the same length and the figure moves exactly as fast as the rate says.
 */
function daySecondsOf(core) {
  const seconds = (gameDayStartMs(addDays(core.today, 1), core.rollover) - gameDayStartMs(core.today, core.rollover)) / 1000;
  return seconds > 0 ? seconds : DAY_SECONDS;
}

/**
 * Streams whose deposits stopped: past the lapse with no deposit seen (ruling: pay that stops). Every
 * scheduled stream is listed, counted day by day or on arrival (ruling T4); `since` is its last deposit day.
 */
function lapsedPayOf(core, items, point) {
  const lapsed = [];
  const seen = new Set();
  for (const item of items) {
    seen.add(item.id);
    const reset = item.lastReset(point.n);
    if (reset === null || point.n - reset + point.f <= item.lapseDays) continue;
    lapsed.push({ id: item.id, name: item.name, since: core.cal.day(reset) });
  }
  const payDays = core.index().payDays;
  for (const stream of listOf(core.doc.streams)) {
    if (!isScheduled(core, stream) || seen.has(stream.id)) continue;
    // Only a stream that would be pay but for the lapse: a trickle (20 cents of interest) that misses a
    // month is not "pay that stopped".
    if (dailyOf(stream) * 30.4375 < PAY_STREAM_MIN_MONTHLY) continue;
    const deposits = payDays.get(stream.id);
    if (!payLapsed(core, stream, deposits)) continue;
    seen.add(stream.id);
    let latest = -Infinity;
    for (const n of deposits) if (n > latest) latest = n;
    lapsed.push({ id: stream.id, name: nameOf(stream), since: core.cal.day(latest) });
  }
  return lapsed;
}

/** Now-values of the visible accounts by group; what is owned and what is owed, account by account. */
function accountTotals(core) {
  const totals = { cash: 0, cards: 0, investments: 0, slowAssets: 0, loans: 0, assets: 0, liabilities: 0, bank: 0 };
  for (const holder of core.accounts().values()) {
    if (holder.hidden) continue;
    const value = nowValueOf(core, holder);
    totals[totalOf(holder)] += value;
    totals.bank += value;
    if (value > 0) totals.assets += value;
    else if (value < 0) totals.liabilities -= value;
  }
  return totals;
}

function totalOf(holder) {
  if (holder.group === 'cash') return 'cash';
  if (holder.group === 'card') return 'cards';
  if (holder.group === 'debt') return 'loans';
  return holder.account.type === 'investment' ? 'investments' : 'slowAssets';
}

/** What the lines still rising add per day (an accrual at its cap has stopped moving). */
function risingDaily(lines) {
  return sumOf(lines, (line) => (line.rising ? line.daily : 0));
}

function shownLine(line) {
  return { id: line.id, name: line.name, amount: roundCents(line.amount), since: line.since, daily: roundCents(line.daily) };
}

/* ------------------------------------------------------------------ rounds */

/** How completely the bank has reported a past day (ARCHITECTURE 4.6), whatever the match says. */
function dataStatusOf(core, n, bucket) {
  const dataN = core.data().n;
  if (dataN !== null && n > dataN) return 'awaiting';
  const recent = dataN !== null && n >= dataN - 1;
  return recent || bucket.pending || bucket.unconfirmed ? 'provisional' : 'final';
}

function statusOf(core, n, bucket) {
  if (n > core.todayN) return 'future';
  if (core.matchN === null || n < core.matchN) return 'prematch';
  return n === core.todayN ? 'live' : dataStatusOf(core, n, bucket);
}

function roundOn(core, day) {
  const n = core.cal.num(day);
  if (n === null) return unplayedRound(day);
  let played = core.rounds.get(n);
  if (!played) {
    played = buildRound(core, day, n);
    core.rounds.set(n, played);
  }
  return played;
}

function buildRound(core, day, n) {
  const bucket = bucketOn(core, n);
  const type = typeOfDay(core.days, core.workdays, day);
  const lines = habitLines(core.segments, type, day);
  const record = dayRecord(core.days, day);
  const status = statusOf(core, n, bucket);
  const conv = convOf(bucket);
  const bye = !!(record && record.bye);
  // A finished day the bank has reported is scored; before the match that is an exhibition result.
  const knownFrom = core.knownFrom();
  const reported = (knownFrom === null || n >= knownFrom) && dataStatusOf(core, n, bucket) !== 'awaiting';
  const scored = lines.segment !== null && n < core.todayN && reported;
  return {
    day,
    n: parts(day).d,
    type,
    status,
    habit: lines.habit,
    winLine: lines.winLine,
    lossLine: lines.lossLine,
    conv,
    kept: lines.habit - conv,
    result: scored ? resultOf(conv, lines, bye) : null,
    bye,
    clean: conv === 0 && (status === 'provisional' || status === 'final'),
    stops: bucket.stops,
    moves: orderedMoves(bucket),
    plan: planOf(record),
  };
}

function unplayedRound(day) {
  return {
    day, n: 0, type: 'off', status: 'future', habit: 0, winLine: 0, lossLine: 0, conv: 0, kept: 0,
    result: null, bye: false, clean: false, stops: 0, moves: [], plan: null,
  };
}

function resultOf(conv, lines, bye) {
  if (bye) return 0.5;
  if (conv <= lines.winLine) return 1;
  return conv > lines.lossLine ? 0 : 0.5;
}

/** The day's moves in the order played: by `at` when the bank gave a time, else by when the row was stored. */
function orderedMoves(bucket) {
  if (!bucket.sorted) {
    bucket.moves.sort((a, b) => momentOf(a) - momentOf(b));
    bucket.sorted = true;
  }
  return bucket.moves.slice();
}

function momentOf(tx) {
  if (Number.isFinite(tx.at)) return tx.at;
  return Number.isFinite(tx.loggedAt) ? tx.loggedAt : 0;
}

function planOf(record) {
  const plan = record && isObject(record.plan) ? record.plan : null;
  if (!plan) return null;
  const answer = (value) => (typeof value === 'boolean' ? value : null);
  // what was ready that morning: the owner's own lines, kept with the wording they had when they were answered
  const ready = listOf(plan.ready).filter(isObject)
    .map((item) => ({ label: typeof item.label === 'string' ? item.label.trim().slice(0, 60) : '', yes: answer(item.yes) }))
    .filter((item) => item.label && item.yes !== null).slice(0, 4);
  return { ready, stops: Number.isFinite(plan.stops) ? plan.stops : null };
}

/** True for a round that has a result and belongs to the match. */
function isCounted(played) {
  return played.result !== null && played.status !== 'prematch';
}

function monthTableOf(core, ym) {
  const table = {
    ym, rounds: [], score: 0, played: 0,
    black: { score: 0, played: 0 }, white: { score: 0, played: 0 },
    kept: 0, finals: 0, cleanSheets: 0, perfect: 0, weeks: [],
  };
  const first = typeof ym === 'string' && /^\d{4}-\d{2}$/.test(ym) ? core.cal.num(ym + '-01') : null;
  if (first === null) return table;
  for (let i = 0; i < daysInMonth(ym); i++) {
    const played = roundOn(core, core.cal.day(first + i));
    if (i % WEEK_DAYS === 0) table.weeks.push({ rounds: [], score: 0, played: 0 });
    const week = table.weeks[table.weeks.length - 1];
    table.rounds.push(played);
    week.rounds.push(played);
    table.perfect += played.habit;
    if (played.clean) table.cleanSheets += 1;
    if (!isCounted(played)) continue;
    for (const tally of [table, week, played.type === 'work' ? table.black : table.white]) {
      tally.score += played.result;
      tally.played += 1;
    }
    table.kept += played.kept;
    if (played.status === 'final') table.finals += 1;
  }
  return table;
}

/* -------------------------------------------------------------------- edge */

function edgeOf(core) {
  const tally = { kept: 0, verified: 0, moved: movedOf(core), unmoved: 0, sweep: null, unbeaten: 0, bestUnbeaten: 0, form: [] };
  if (core.matchN !== null) {
    const results = [];
    for (let n = core.matchN; n < core.todayN; n++) {
      const played = roundOn(core, core.cal.day(n));
      if (!isCounted(played)) continue;
      tally.kept += played.kept;
      if (played.status === 'final') tally.verified += played.kept;
      results.push(played.result);
      if (played.bye) continue; // a bye neither extends a run nor ends it
      tally.unbeaten = played.result === 0 ? 0 : tally.unbeaten + 1;
      tally.bestUnbeaten = Math.max(tally.bestUnbeaten, tally.unbeaten);
    }
    tally.form = results.slice(-FORM_ROUNDS);
    tally.sweep = sweepOf(core);
  }
  tally.unmoved = Math.max(0, tally.kept - tally.moved);
  return tally;
}

function movedOf(core) {
  return sumOf(listOf(core.doc.sweeps), (sweep) => (isObject(sweep) && positive(sweep.amount) ? Math.round(sweep.amount) : 0));
}

/**
 * ARCHITECTURE 4.8: what the last completed Monday-to-Sunday week kept, in whole dollars, when it is
 * at least $5 and no sweep is recorded for that week.
 */
function sweepOf(core) {
  const weekOf = addDays(weekStart(core.today), -WEEK_DAYS);
  if (listOf(core.doc.sweeps).some((sweep) => isObject(sweep) && sweep.weekOf === weekOf)) return null;
  const monday = core.cal.num(weekOf);
  let kept = 0;
  for (let n = Math.max(monday, core.matchN); n < monday + WEEK_DAYS; n++) {
    const played = roundOn(core, core.cal.day(n));
    if (isCounted(played)) kept += played.kept;
  }
  if (kept < SWEEP_MINIMUM) return null;
  return { weekOf, amount: Math.floor(kept / 100) * 100, target: owesOnCard(core) ? 'card' : 'reserve' };
}

function owesOnCard(core) {
  for (const holder of core.accounts().values()) {
    if (!holder.hidden && holder.group === 'card' && nowValueOf(core, holder) < 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------- clock */

function clockOf(core) {
  const { cash } = core.position();
  const { nextPayday, payAwaited, following } = paydayOf(core);
  // The due window (ruling T1): to the day before the next payday; today alone on the payday itself and
  // for the two grace days after a scheduled payday whose deposit is not on the record; from the third
  // day through the next scheduled payday after today; 14 days with no payday. Never before today.
  let dueUntil = addDays(core.today, DUE_WINDOW_DAYS - 1);
  if (payAwaited !== null) {
    if (diffDays(payAwaited, core.today) <= PAY_GRACE_DAYS) dueUntil = core.today;
    else if (following !== null) dueUntil = following;
  } else if (nextPayday !== null) {
    dueUntil = nextPayday > core.today ? addDays(nextPayday, -1) : core.today;
  }
  const due = dueWithin(core, diffDays(core.today, dueUntil) + 1);
  const dueTotal = sumOf(due, (item) => item.amount);
  const shortfall = Math.max(0, dueTotal - cash);
  const burn = burnOf(core);
  const runwayDays = burn > 0 ? Math.max(0, Math.floor(cash / burn)) : null;
  const reserve = reserveOf(core);
  const reserveTarget = reserveTargetOf(core.doc);
  return {
    cash,
    asOf: cashAsOf(core),
    nextPayday,
    payAwaited,
    dueUntil,
    due,
    dueTotal,
    shortfall,
    burn,
    runwayDays,
    trouble: shortfall > 0 || (runwayDays !== null && runwayDays < TROUBLE_RUNWAY_DAYS),
    milestones: milestonesOf(burn, reserve, reserveTarget),
    reserve,
    reserveTarget,
  };
}

/** Oldest balance timestamp among the cash accounts the bank reports. */
function cashAsOf(core) {
  let oldest = null;
  for (const holder of core.accounts().values()) {
    const { asOf } = holder.account;
    if (!holder.bank || holder.hidden || holder.group !== 'cash' || !positive(asOf)) continue;
    if (oldest === null || asOf < oldest) oldest = asOf;
  }
  return oldest;
}

/**
 * The streams that count as pay: scheduled, not lapsed (ruling: no deposit for more than 1.6 periods),
 * and either counted day by day (`accrue`) or bringing in at least PAY_STREAM_MIN_MONTHLY a month.
 * A trickle that happens to be regular (20 cents of interest a month) is income, but it is never
 * "the payday" and never "take-home pay".
 */
function payStreamsOf(core) {
  const payDays = core.index().payDays;
  return listOf(core.doc.streams).filter((stream) => isScheduled(core, stream)
    && !payLapsed(core, stream, payDays.get(stream.id))
    && (!!stream.accrue || dailyOf(stream) * 30.4375 >= PAY_STREAM_MIN_MONTHLY));
}

/**
 * The payday of the main pay stream: the one that brings in the most per day among payStreamsOf, the
 * streams counted day by day first. No other stream ever supplies a payday, so with no pay stream
 * left (none, lapsed or ended) nextPayday is null and the 14-day window applies.
 *  - nextPayday: the next day it pays. Today counts until its deposit has landed, and a payday
 *    scheduled before today with no deposit seen near it stays at today (expected any day).
 *  - payAwaited: the scheduled day BEFORE today whose deposit is not on the record, otherwise null.
 *    On the scheduled payday itself pay is not late (ruling T1).
 *  - following: the next scheduled payday after today (where the due window ends from the third day of a wait).
 */
function paydayOf(core) {
  const payDays = core.index().payDays;
  const pay = payStreamsOf(core);
  const accruing = pay.filter((stream) => stream.accrue);
  let main = null;
  for (const stream of accruing.length ? accruing : pay) {
    if (!main || dailyOf(stream) > dailyOf(main)) main = stream;
  }
  if (!main) return { nextPayday: null, payAwaited: null, following: null };
  const following = nextOccurrence(main, core.today);
  const deposits = payDays.get(main.id) || [];
  if (!deposits.length) return { nextPayday: nextOccurrence(main, addDays(core.today, -1)), payAwaited: null, following };
  const last = lastOccurrence(main, core.today);
  const lastN = last === null ? null : core.cal.num(last);
  const slack = CADENCES[main.cadence].days / 2;
  if (lastN !== null && !deposits.some((n) => n > lastN - slack)) {
    return { nextPayday: core.today, payAwaited: last < core.today ? last : null, following };
  }
  return { nextPayday: following, payAwaited: null, following };
}

/**
 * A stream with deposits and none for more than the pay cap: it no longer supplies a payday. Read at
 * the same point as the accruals (Position.lapsedPay), so a feed that went quiet does not by itself
 * end a stream: with no news from the bank nobody knows that the deposits stopped.
 */
function payLapsed(core, stream, deposits) {
  if (!deposits || !deposits.length) return false;
  let latest = -Infinity;
  for (const n of deposits) if (n > latest) latest = n;
  const point = accrualPoint(core, core.todayN);
  return point.n - latest + point.f > PAY_CAP_PERIODS * CADENCES[stream.cadence].days;
}

/**
 * What draws on cash in the next `days` days, today included (ARCHITECTURE 4.9): Book occurrences
 * charged to a cash account or to no known account, and card minimums falling due. An occurrence
 * already settled (isCharged) is not due again, and a card whose payment is itself in the Book is not
 * counted twice. Every overdue Book entry is listed as well, whatever the window (ruling R1a).
 */
function dueWithin(core, days) {
  const due = [];
  const debtsInBook = new Set();
  const entries = new Map(listOf(core.doc.recurring).filter(isObject).map((entry) => [entry.id, entry]));
  // What is overdue is always listed, whatever the window.
  for (const row of days >= 1 ? upcoming(core.doc, core.today, days) : []) {
    if (!drawsOnCash(core, row.accountId) || isCharged(core, row, entries.get(row.id))) continue;
    due.push({ id: row.id, name: nameOf(row), day: row.day, amount: Math.round(row.amount) });
    const entry = entries.get(row.id);
    if (entry && entry.toAccountId != null) debtsInBook.add(entry.toAccountId);
  }
  for (const entry of entries.values()) {
    const late = overdueOf(core, entry);
    if (!late) continue;
    due.push(late);
    if (entry.toAccountId != null) debtsInBook.add(entry.toAccountId);
  }
  for (const item of days >= 1 ? cardMinimums(core, days) : []) if (!debtsInBook.has(item.id)) due.push(item);
  return due.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * A Book occurrence drawn on cash whose day has passed with no linked outflow on or after its day
 * minus the early days: still owed, so it stays due — until it posts or the entry lapses, 1.5 periods
 * after its last outflow (or its anchor when none was ever seen). The linked outflow is a charge, or
 * the payment or transfer that settles the entry (a Book transfer to a card), so a card payment in the
 * Book that did not post is overdue exactly like the rent.
 */
function overdueOf(core, entry) {
  if (!entry.active || !hasCadence(entry) || !isYmd(entry.anchor) || !positive(entry.amount)) return null;
  if (!drawsOnCash(core, entry.accountId)) return null;
  const settled = core.index().settled.get(entry.id) || [];
  const day = lastOccurrence(entry, addDays(core.today, -1));
  const n = day === null ? null : core.cal.num(day);
  if (n === null) return null;
  const cadenceDays = CADENCES[entry.cadence].days;
  const early = earlyDays(entry);
  if (settled.some((posted) => posted >= n - early)) return null;
  // An entry never settled is late only when the owner added it by hand, and only for an occurrence
  // after its anchor (a past anchor is the last charge the owner knows of) and after the day it was added.
  if (!settled.length && !byHand(entry)) return null;
  const reset = makeResets(core, entry, settled, true)(core.todayN);
  if (reset === null || core.todayN - reset > BILL_LAPSE_PERIODS * cadenceDays) return null;
  if (!settled.length && n <= reset) return null;
  return { id: entry.id, name: nameOf(entry), day, amount: Math.round(entry.amount), overdue: true };
}

function drawsOnCash(core, accountId) {
  const holder = accountId == null ? null : core.accounts().get(accountId);
  return !holder || (!holder.hidden && holder.group === 'cash');
}

/** The same test as overdueOf, for an occurrence to come: an outflow linked to its entry already posted for it. */
function isCharged(core, row, entry) {
  const settled = core.index().settled.get(row.id) || [];
  const n = core.cal.num(row.day) - (entry ? earlyDays(entry) : 0);
  return settled.some((posted) => posted >= n);
}

function cardMinimums(core, days) {
  const items = [];
  const until = addDays(core.today, days - 1);
  for (const holder of core.accounts().values()) {
    const { minPayment, dueDay } = holder.account;
    if (holder.hidden || holder.group !== 'card' || !positive(minPayment) || !isDayOfMonth(dueDay)) continue;
    const owed = -nowValueOf(core, holder);
    if (owed <= 0) continue;
    for (let ym = monthOf(core.today); ym <= monthOf(until); ym = addMonthsYm(ym, 1)) {
      const day = addMonths(startOfMonth(ym), 0, dueDay);
      if (day < core.today || day > until) continue;
      items.push({ id: holder.id, name: accountLabel(holder.account) + ' minimum', day, amount: Math.min(Math.round(minPayment), owed) });
    }
  }
  return items;
}

/** Outflows from cash accounts other than transfers, per day, over the 60 days before today. */
function burnOf(core) {
  const index = core.index();
  const yesterday = core.todayN - 1;
  if (!index.order.length) return 0;
  // a young record covers fewer days than the window: divide by the days it does cover
  const recorded = Math.min(BURN_DAYS, yesterday - index.order[0] + 1);
  if (recorded < BURN_MIN_DAYS) return 0;
  const spent = totalThrough(index, index.cashOutRunning, yesterday) - totalThrough(index, index.cashOutRunning, yesterday - BURN_DAYS);
  return roundCents(spent / recorded);
}

/** Cash flagged as reserve; all cash when no account is flagged. */
function reserveOf(core) {
  let flagged = 0;
  let any = false;
  let all = 0;
  for (const holder of core.accounts().values()) {
    if (holder.hidden || holder.group !== 'cash') continue;
    const value = nowValueOf(core, holder);
    all += value;
    if (holder.account.reserve) {
      flagged += value;
      any = true;
    }
  }
  return any ? flagged : all;
}

function reserveTargetOf(doc) {
  const reserve = isObject(doc.goals) && isObject(doc.goals.reserve) ? doc.goals.reserve : null;
  return reserve ? wholeCents(reserve.target) : 0;
}

/** Time first — a day, a week … three months of burn — then the goal amount. */
function milestonesOf(burn, reserve, target) {
  const milestones = [];
  if (burn > 0) {
    for (const [label, days] of TIME_MILESTONES) milestones.push({ label, amount: burn * days, reached: reserve >= burn * days });
  }
  if (target > 0) milestones.push({ label: 'Goal', amount: target, reached: reserve >= target });
  return milestones;
}

/* ----------------------------------------------------- retention, spending */

function retentionOf(core, day) {
  const through = isYmd(day) ? day : core.today;
  const ym = monthOf(through);
  const rows = closesBetween(core, startOfMonth(ym), through);
  const totals = { ym, days: rows.length, earned: 0, bills: 0, spent: 0, other: 0, kept: 0, rate: null };
  for (const row of rows) {
    totals.earned += row.earned;
    totals.bills += row.bills;
    totals.spent += row.spent;
    totals.kept += row.result;
    totals.other += row.other;
  }
  // A share of next to nothing earned is not a number worth printing (a hidden pay account leaves cents).
  if (totals.earned >= RATE_MIN_EARNED) totals.rate = totals.kept / totals.earned;
  return totals;
}

function spendingBetween(core, fromDay, toDay) {
  const from = core.cal.num(fromDay);
  const to = core.cal.num(toDay);
  if (from === null || to === null) return [];
  const index = core.index();
  const byCategory = new Map();
  for (let i = lastAtOrBelow(index.order, from - 1) + 1; i < index.order.length && index.order[i] <= to; i++) {
    for (const tx of index.buckets.get(index.order[i]).moves) addSpending(byCategory, tx);
  }
  return [...byCategory.values()]
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount || (a.category < b.category ? -1 : 1));
}

function addSpending(byCategory, tx) {
  if (tx.kind !== 'spend' && tx.kind !== 'refund') return;
  const category = typeof tx.category === 'string' && tx.category ? tx.category : 'other';
  let row = byCategory.get(category);
  if (!row) {
    row = { category, klass: klassOf(category), amount: 0, count: 0 };
    byCategory.set(category, row);
  }
  const amount = Math.round(tx.amount);
  if (tx.flow === 'in') {
    row.amount -= amount;
  } else {
    row.amount += amount;
    if (tx.kind === 'spend') row.count += 1;
  }
}

/* ------------------------------------------------------------ small helpers */

const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5];

function isObject(x) {
  return x !== null && typeof x === 'object';
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}

function positive(x) {
  return Number.isFinite(x) && x > 0;
}

/** Whole cents >= 0 of a stored amount; 0 when it is missing or malformed. */
function wholeCents(x) {
  return positive(x) ? Math.round(x) : 0;
}

/** Whole signed cents of a stored balance; 0 when it is missing or malformed. */
function wholeSigned(x) {
  return Number.isFinite(x) ? roundCents(x) : 0;
}

/** A setting that is on unless it was switched off (both the engine's switches default to on). */
function isOn(setting) {
  return setting === undefined ? true : !!setting;
}

function isDayOfMonth(x) {
  return Number.isInteger(x) && x >= 1 && x <= 31;
}

function nameOf(item) {
  return typeof item.name === 'string' ? item.name : '';
}

function settingsOf(state) {
  return isObject(state) && isObject(state.settings) ? state.settings : {};
}

function daysOf(state) {
  return isObject(state) && isObject(state.days) ? state.days : {};
}

function workdaysOf(settings) {
  return Array.isArray(settings.workdays) ? settings.workdays : DEFAULT_WORKDAYS;
}

/** The rollover hour as dates.gameDay reads it: midnight when it is not set or is not an hour of the day. */
function rolloverOf(settings) {
  const hour = settings.rolloverHour;
  return Number.isFinite(hour) && hour >= 0 && hour < 24 ? hour : 0;
}

/** A timestamp a Date can hold; anything else reads as the epoch (never the real clock). */
function timeOf(nowMs) {
  return Number.isFinite(nowMs) && Math.abs(nowMs) <= MAX_TIME_MS ? nowMs : 0;
}

/** Run `build` on first use and remember what it made. */
function once(build) {
  let built = false;
  let value;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value;
  };
}

function ascending(a, b) {
  return a - b;
}

function uniqueSorted(numbers) {
  return [...new Set(numbers)].sort(ascending);
}

/** Index of the last element <= x in an ascending array, or -1. */
function lastAtOrBelow(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function lastOf(list) {
  return list.length ? list[list.length - 1] : 0;
}

function sumOf(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item);
  return total;
}

function addTo(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

function pushTo(map, key, item) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}
