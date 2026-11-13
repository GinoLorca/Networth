/**
 * The four-factor position assessment and the coach's notes. See ARCHITECTURE.md section 8.
 * Pure. Imports: schema, dates, money, ledger, cards, book, annotate.
 */

import { ACCOUNT_TYPES, CADENCES, categoryLabel } from './schema.js';
import { addDays, addMonthsYm, diffDays, endOfMonth, fmtDate, fmtMonth, gameDay, isYmd, minYmd, monthOf, parts, startOfMonth } from './dates.js';
import { MINUS, fmt, fmtSigned, roundCents } from './money.js';
import { makeLedger } from './ledger.js';
import { PACE_FROM_DAY, allCardsMonths, cardsNow, firstTransactionDay, historyDays as daysOnRecord } from './cards.js';
import { annualCost, bookTotals, renewals } from './book.js';
import { reviewRounds } from './annotate.js';

/** Evaluation symbols, best to worst, plus 'unclear'. The UI draws each as an SVG glyph. */
export const SYMBOLS = ['winning', 'clear_plus', 'slight_plus', 'equal', 'slight_minus', 'clear_minus', 'losing', 'unclear'];

/** Plain names for the symbols. */
export const SYMBOL_LABELS = {
  winning: 'Winning', clear_plus: 'Clear advantage', slight_plus: 'Slight advantage', equal: 'Equal',
  slight_minus: 'Slightly worse', clear_minus: 'Clearly worse', losing: 'Losing', unclear: 'Unclear',
};

const UNCLEAR = 'unclear';
const EQUAL_INDEX = SYMBOLS.indexOf('equal');
const WORST_INDEX = SYMBOLS.indexOf('losing');

const TITLES = { material: 'Material', time: 'Time', structure: 'Structure', initiative: 'Initiative' };
/** The order factors are named in; it also settles which of two equally distant factors is named. */
const FACTOR_ORDER = ['material', 'time', 'structure', 'initiative'];
const WEIGHTS = { time: 35, structure: 25, material: 20, initiative: 20 };
const STANDING = {
  material: ['ahead on material', 'level on material', 'behind on material'],
  time: ['ahead on time', 'level on time', 'short on time'],
  structure: ['sound on structure', 'level on structure', 'weak on structure'],
  initiative: ['ahead on initiative', 'level on initiative', 'behind on initiative'],
};

const MATERIAL_DAYS = 30;
const MIN_HISTORY_DAYS = 14;
/** The approximately sign an estimated amount carries directly before it in a sentence. */
const APPROX = '≈';
/** A percentage whose magnitude is over this is never printed. */
const MAX_PERCENT = 999;
/** Material steps: percent of a month of take-home pay, and cents when no pay is detected. */
const MATERIAL_SHARES = [30, 15, 4];
const MATERIAL_AMOUNTS = [120000, 60000, 15000];
/** Runway in days below which each symbol applies; at 180 days and beyond the time factor is winning. */
const RUNWAY_STEPS = [[7, 'clear_minus'], [14, 'slight_minus'], [30, 'equal'], [90, 'slight_plus'], [180, 'clear_plus']];
/** Two falling months that cut the card balance by this percent together are a clear advantage. */
const DEEP_CUT_PERCENT = 10;
/** A month on pace to end higher by more than this percent of where it began costs one step. */
const PACE_PERCENT = 2;
/** Retention steps, percent of what was earned (pay and other income — never the money kept against habit). */
const RETENTION_STEPS = [[20, 'clear_plus'], [8, 'slight_plus'], [0, 'equal'], [-10, 'slight_minus']];
const MIN_MONTH_DAYS = 3;

const NOTE_LIMIT = 110;
const DEFAULT_NOTES = 3;
/** A note is shown for this many days from its first, then rests until NOTE_REST_DAYS after that first day. */
const NOTE_RUN_DAYS = 3;
const NOTE_REST_DAYS = 14;
/** The bank-link and old-data notes, which never rest. */
const PINNED_KEYS = new Set(['relink', 'sync-error', 'bank-problem', 'stale']);
/** Something that happened this recently is news. */
const NEWS_DAYS = 14;
const RENEWAL_DAYS = 21;
const REVIEW_DAYS = 90;
const FIRST_WEEK = 7;
const DUE_WINDOW_DAYS = 14;
const BILL_LAPSE_PERIODS = 1.5;
const MAX_NAME = 24;
const HOUR_MS = 3600000;
const BRIDGE_URL = 'https://bridge.simplefin.org/';

/*
 * How the specification is read where it leaves a choice:
 *  - Material: history begins on the day of the earliest bank transaction (cards.firstTransactionDay);
 *    the change is the plain difference of smoothed net worth over 30 days, revaluations included,
 *    against a month of pay from every active stream that has a cadence.
 *  - Structure: with one complete month, lower is a slight advantage, higher slightly worse, level
 *    equal. A month that ended where it began counts with the net of the two. "The balance" the
 *    current pace is measured against is what the cards owed when the month began.
 *  - The verdict is the weighted mean rounded to the nearest whole step (a half rounds away from equal).
 *  - The document keeps no record of when a Book entry was added, repriced or ended, so those notes
 *    are read from the charges: new = an untouched detected entry whose series was completed by a
 *    charge in the last 14 days and began inside the history; price change = a charge in the last 14
 *    days that differs from two equal charges before it; ended = an inactive detected entry that
 *    passed 1.5 periods without a charge in the last 14 days.
 *  - A reserve milestone is news when the reserve was below it 14 days ago.
 *  - In the first 7 days of a month the card note is last month's verdict; after that, this month's pace.
 */

/**
 * @typedef {Object} Factor
 * @property {'material'|'time'|'structure'|'initiative'} key
 * @property {string} title        'Material' | 'Time' | 'Structure' | 'Initiative'
 * @property {string} symbol       one of SYMBOLS
 * @property {string} label        SYMBOL_LABELS[symbol]
 * @property {string} sentence     one plain sentence with at least one number or date; money formatted with money.fmt
 * @property {boolean} [timeTrouble]  on the time factor only
 */

/**
 * @typedef {Object} Assessment
 * @property {Factor} material     30-day change of smoothed net worth against a month of take-home pay:
 *                                 >= +30% winning (only when liquid > 0), >= +15% clear_plus, >= +4% slight_plus,
 *                                 > −4% equal, > −15% slight_minus, else clear_minus; unclear with under 14 days of
 *                                 history; when no pay is detected use absolute thresholds of $1,200 / $600 / $150.
 * @property {Factor} time         shortfall before payday -> losing; runway < 7 days -> clear_minus; < 14 slight_minus;
 *                                 < 30 equal; < 90 slight_plus; < 180 clear_plus; else winning; unclear when burn is
 *                                 unknown. timeTrouble = clock.trouble.
 * @property {Factor} structure    no card debt -> clear_plus. Else from the last two COMPLETE months of all cards:
 *                                 both ended lower -> slight_plus (clear_plus when the two together cut the balance by
 *                                 10% or more); one lower, one higher -> equal when the net is lower, slight_minus when
 *                                 the net is higher; both higher -> clear_minus. Then one step worse when the current
 *                                 month is on pace to end higher by more than 2% of the balance. unclear with no
 *                                 complete month.
 * @property {Factor} initiative   month-to-date retention (kept / earned): >= 20% clear_plus, >= 8% slight_plus,
 *                                 >= 0 equal, >= −10% slight_minus, else clear_minus; unclear when nothing was earned
 *                                 this month or the month is under 3 days old.
 * @property {string} symbol       the overall verdict: weighted mean of the four (winning +3 … losing −3; unclear factors
 *                                 are left out and the weights renormalised; time 35%, structure 25%, material 20%,
 *                                 initiative 20%) mapped back to a symbol; 'unclear' when every factor is unclear.
 * @property {string} label
 * @property {string} sentence     e.g. "Slightly worse — level on material, short on time." Built from the overall label
 *                                 and the two factors furthest from equal (or "level on …" when they are equal).
 */

/**
 * @param {object} state
 * @param {number} nowMs
 * @param {{ ledger?: object }} [opts]  ledger: one made by makeLedger for the same document and time, used instead of building another
 * @returns {Assessment}
 */
export function assess(state, nowMs, opts) {
  const view = openView(state, nowMs, opts);
  const factors = {
    material: materialFactor(view),
    time: timeFactor(view),
    structure: structureFactor(view),
    initiative: initiativeFactor(view),
  };
  const symbol = verdictSymbol(factors);
  return { ...factors, symbol, label: SYMBOL_LABELS[symbol], sentence: verdictSentence(symbol, factors) };
}

/**
 * @typedef {Object} Note
 * @property {string} key       stable identity for de-duplication (e.g. 'relink', 'due:rec_ab12:2026-06-01', 'target:cafe:2026-06')
 * @property {number} priority  higher shows first
 * @property {string} text      under 110 characters; a number or a date in every one; annotates the move, never the player
 * @property {{ label: string, href?: string, action?: string, data?: Object<string, string> }|null} cta
 *           optional call to action: a hash link (href, e.g. '#/settings') or a registered action name with data
 */

/**
 * Candidate coach's notes, highest priority first, at most `limit` (default 3).
 * Repetition rule: meta.notesSeen[key] is the game day a note was FIRST shown in its current run (the
 * CALLER records it once when it displays a note, and drops entries older than 14 days — this function
 * never mutates state). A note stays eligible on the day it was first shown and the two days after it
 * (so it does not vanish while the owner is reading), and is then suppressed until 14 days after that
 * first day. The bank-link and old-data notes are never suppressed.
 * Candidates, roughly in priority order:
 *  - the bank link needs attention (sync.status 'relink' or 'error', or sync.problems) — never suppressed
 *  - bank data is old (position freshness 'aging' / 'old') — never suppressed
 *  - a shortfall before payday: "$212.40 on the clock, ≈$640.00 due before Fri Jun 12." (what has not posted carries ≈, ruling T2)
 *  - a Book charge past its day that has not posted (clock.due[].overdue)
 *  - pay that stopped: "No deposit from {name} since {date}." (position.lapsedPay; streams counted on arrival too, ruling T4)
 *  - a sweep is open: "Last week you kept $47 against habit. Move it to the card."
 *  - a business purchase's return check is due
 *  - new in the Book / a price change / an entry that seems to have ended
 *  - a renewal within 21 days (quarterly or longer)
 *  - card pace this month; last month's card verdict in the first week of a month
 *  - interest and fees charged last month
 *  - a category target: "Cafes: $38.60 in June against a $150 target. May finished at $212.80."
 *  - repeat stops this month
 *  - a reserve milestone reached
 *  - the scale of the game: "A perfect month in the daily game is worth $410. Cards took $2,300 in new charges last month."
 *  - moves waiting for a purpose (review queue)
 *  - no regular pay detected yet (smoothing is off and the document holds no regular stream at all; when the
 *    owner counts pay on arrival nothing is said: pay is counted when it arrives, by their own setting)
 * @param {object} state
 * @param {number} nowMs
 * @param {{ limit?: number, ledger?: object }} [opts]
 * @returns {Note[]}
 */
export function coachNotes(state, nowMs, opts) {
  const view = openView(state, nowMs, opts);
  const asked = isObject(opts) ? opts.limit : undefined;
  const limit = Number.isFinite(asked) ? Math.max(0, Math.floor(asked)) : DEFAULT_NOTES;
  const seen = isObject(view.doc.meta) && isObject(view.doc.meta.notesSeen) ? view.doc.meta.notesSeen : {};
  const link = linkNote(view);
  const candidates = [
    link,
    link && link.key !== 'bank-problem' ? null : staleNote(view),
    shortfallNote(view),
    overdueNote(view),
    ...lapsedPayNotes(view),
    sweepNote(view),
    paybackNote(view),
    ...bookNotes(view),
    renewalNote(view),
    cardNote(view),
    interestNote(view),
    targetNote(view),
    stackedNote(view),
    reserveNote(view),
    scaleNote(view),
    reviewNote(view),
    noPayNote(view),
  ];
  return candidates
    .filter((candidate) => candidate && !isResting(candidate.key, seen, view.today))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

/**
 * The month-end summary for a completed (or current) month, in this fixed order of importance:
 * card verdict, cash change, score, annotation counts, best move, costliest move.
 * @param {object} state
 * @param {string} ym
 * @param {number} nowMs
 * @param {{ ledger?: object }} [opts]
 * @returns {{ ym: string, complete: boolean,
 *             card: { change: number, start: number, end: number, sentence: string }|null,
 *             cash: { change: number, sentence: string },
 *             netWorth: { change: number, sentence: string },
 *             score: { score: number, played: number, black: { score: number, played: number }, white: { score: number, played: number }, kept: number, perfect: number, estimated: boolean },
 *             // estimated: a counted round of the month is in pencil (provisional) or in progress (live), so `kept` is shown as ≈
 *             review: object,   // annotate.reviewRounds(...)
 *             scale: string }}  // the scale sentence
 */
export function monthReview(state, ym, nowMs, opts) {
  const view = openView(state, nowMs, opts);
  const table = view.ledger.monthTable(ym);
  const known = isYm(ym);
  return {
    ym,
    complete: known && ym < view.month,
    card: known ? cardReview(view, ym) : null,
    cash: known ? cashReview(view, ym) : { change: 0, sentence: '' },
    netWorth: known ? netWorthReview(view, ym) : { change: 0, sentence: '' },
    score: {
      score: table.score, played: table.played,
      black: { ...table.black }, white: { ...table.white },
      kept: table.kept, perfect: table.perfect,
      estimated: listOf(table.rounds).some((round) => isObject(round) && (round.status === 'live'
        || (round.status === 'provisional' && round.result !== null))),
    },
    review: reviewRounds(table.rounds, { sweepTxIds: sweepIdsOf(view.doc) }),
    scale: known ? scaleSentences(view, ym, ym, monthSpan(view, ym)).join(' ') : '',
  };
}

/* -------------------------------------------------------------------- view */

/** What one query needs, read once: the document, its ledger, today, and the card figures on first use. */
function openView(state, nowMs, opts) {
  const doc = isObject(state) ? state : {};
  const ledger = isObject(opts) && isObject(opts.ledger) ? opts.ledger : makeLedger(doc, nowMs);
  const shared = { ledger };
  return {
    doc,
    ledger,
    now: Number.isFinite(nowMs) ? nowMs : 0,
    today: ledger.today,
    month: monthOf(ledger.today),
    firstDay: firstTransactionDay(doc),
    cards: once(() => cardsNow(doc, nowMs, shared)),
    cardMonths: (months) => allCardsMonths(doc, months, nowMs, shared),
    recentCardMonths: once(() => allCardsMonths(doc, 3, nowMs, shared)),
  };
}

/** Days on record: from the first transaction's day through today, both included; 0 when there is none. */
function historyDays(view) {
  return daysOnRecord(view.doc, view.today);
}

/** "≈" when the smoothed net worth holds an estimate (pay or bills counted day by day, or a move not yet at the bank). */
function approxOf(view) {
  const position = view.ledger.position();
  return position.smoothing || position.provisional > 0 ? APPROX : '';
}

function factor(key, symbol, sentence) {
  return { key, title: TITLES[key], symbol, label: SYMBOL_LABELS[symbol], sentence };
}

/* ---------------------------------------------------------------- material */

function materialFactor(view) {
  // The rule needs MIN_HISTORY_DAYS completed days, so it is met from day MIN_HISTORY_DAYS + 1 on record.
  const history = historyDays(view);
  if (history <= MIN_HISTORY_DAYS) {
    return factor('material', UNCLEAR, countOf(history, 'day') + ' on record so far; the 30-day change in net worth is read from day '
      + (MIN_HISTORY_DAYS + 1) + ' on record.');
  }
  const rows = view.ledger.closes(addDays(view.today, -MATERIAL_DAYS), view.today);
  const change = rows.length ? rows[rows.length - 1].smooth - rows[0].smooth : 0;
  const pay = monthlyPay(view);
  const span = history <= MATERIAL_DAYS ? 'in the ' + history + ' days on record' : 'in the last ' + MATERIAL_DAYS + ' days';
  // A difference of two smoothed closes is computed, not reported: it carries the sign when an estimate is in it.
  const moved = 'Net worth moved ' + approxOf(view) + fmtSigned(change) + ' ' + span;
  const position = view.ledger.position();
  const { liquid } = position;
  if (pay > 0) {
    const symbol = materialSymbol(change * 100, MATERIAL_SHARES.map((share) => share * pay), liquid);
    // A share over 999% says nothing about a month of pay: the clause is dropped.
    const share = percentOf(change, pay);
    return factor('material', symbol, moved + (share === null ? '.' : ', about ' + share + ' of a month of take-home pay.'));
  }
  const onArrival = hasRegularPay(view.doc) && !listOf(position.lapsedPay).length;
  return factor('material', materialSymbol(change, MATERIAL_AMOUNTS, liquid),
    moved + (onArrival ? '; pay is counted when it arrives.' : '; no regular pay is detected to measure it against.'));
}

function materialSymbol(value, [high, middle, low], liquid) {
  if (value >= high) return liquid > 0 ? 'winning' : 'clear_plus';
  if (value >= middle) return 'clear_plus';
  if (value >= low) return 'slight_plus';
  if (value > -low) return 'equal';
  return value > -middle ? 'slight_minus' : 'clear_minus';
}

/**
 * A month of take-home pay, in whole cents: what the pay streams bring in (ledger.payStreams():
 * scheduled, not lapsed, and counted day by day or worth $200.00 a month). A stream whose deposits
 * stopped, or 20 cents of monthly interest, is never "a month of take-home pay"; with none this is 0.
 */
function monthlyPay(view) {
  const hidden = hiddenAccountIds(view.doc);
  const streams = typeof view.ledger.payStreams === 'function' ? listOf(view.ledger.payStreams()) : [];
  let perYear = 0;
  for (const stream of streams) {
    if (!isObject(stream) || !stream.active || !hasCadence(stream) || !positive(stream.amount) || hidden.has(stream.accountId)) continue;
    perYear += stream.amount * CADENCES[stream.cadence].perYear;
  }
  return roundCents(perYear / 12);
}

/** True when the document holds a salary-like stream: one that accrues, or one the owner set to count on arrival. */
function hasRegularPay(doc) {
  return listOf(doc.streams).some((stream) => isObject(stream) && stream.active && hasCadence(stream)
    && (stream.accrue || (Array.isArray(stream.locks) && stream.locks.includes('accrue'))));
}

/* -------------------------------------------------------------------- time */

function timeFactor(view) {
  const clock = view.ledger.clock();
  return { ...factor('time', timeSymbol(clock), timeSentence(clock)), timeTrouble: !!clock.trouble };
}

function timeSymbol(clock) {
  if (clock.shortfall > 0) return 'losing';
  if (clock.runwayDays === null) return UNCLEAR;
  const step = RUNWAY_STEPS.find(([days]) => clock.runwayDays < days);
  return step ? step[1] : 'winning';
}

function timeSentence(clock) {
  if (clock.shortfall > 0) {
    // With nothing due, a shortfall is cash below zero: say that nothing is due, not an estimated zero.
    if (!(clock.dueTotal > 0)) {
      const tail = isYmd(clock.payAwaited) ? ' ' + payAwaitedSentence(clock)
        : clock.nextPayday !== null && clock.nextPayday === clock.dueUntil ? ' Payday is today.' : '';
      return 'Cash on hand is ' + fmt(clock.cash) + '; nothing is due ' + dueWindow(clock) + '.' + tail;
    }
    return 'Cash on hand is ' + fmt(clock.cash) + '; ' + APPROX + fmt(clock.dueTotal) + ' is due ' + dueWindow(clock) + ', '
      + APPROX + fmt(clock.shortfall) + ' more than the cash.';
  }
  if (clock.runwayDays === null) return 'Cash on hand is ' + fmt(clock.cash) + '; the daily outflow is not known yet.';
  const runway = 'Cash of ' + fmt(clock.cash) + ' covers ' + runwayWords(clock.runwayDays) + ' at ' + fmt(clock.burn) + ' a day';
  // Ruling T1: a paycheck awaited is named in its own sentence, and today is never called the next payday.
  if (isYmd(clock.payAwaited)) return runway + '. ' + payAwaitedSentence(clock);
  if (clock.nextPayday === null) return runway + '.';
  if (clock.nextPayday === clock.dueUntil) return runway + '. Payday is today.';
  return runway + '; the next payday is ' + fmtDate(clock.nextPayday, 'dowshort') + '.';
}

/** "Pay expected Fri, Jun 19 is not on the bank’s record yet." (ruling T1; never "has not arrived"). */
function payAwaitedSentence(clock) {
  return 'Pay expected ' + fmtDate(clock.payAwaited, 'dowshort') + " is not on the bank’s record yet.";
}

/**
 * The due window in words (ruling T1): "today" when the window is today alone (the payday itself and
 * the two grace days), "through {dueUntil}" from the third day of a wait, "before {nextPayday}" otherwise.
 */
function dueWindow(clock) {
  if (isYmd(clock.dueUntil) && (clock.nextPayday === clock.dueUntil || (isYmd(clock.payAwaited) && clock.dueUntil <= clock.nextPayday))) return 'today';
  if (isYmd(clock.payAwaited) && isYmd(clock.dueUntil)) return 'through ' + fmtDate(clock.dueUntil, 'dowshort');
  return clock.nextPayday === null ? 'in the next ' + DUE_WINDOW_DAYS + ' days' : 'before ' + fmtDate(clock.nextPayday, 'dowshort');
}

function runwayWords(days) {
  return days < 1 ? 'under 1 day' : 'about ' + countOf(days, 'day');
}

/* --------------------------------------------------------------- structure */

function structureFactor(view) {
  const { owed } = view.cards();
  if (!(owed > 0)) return factor('structure', 'clear_plus', 'No card balance is carried as of ' + fmtDate(view.today, 'short') + '.');
  const months = view.recentCardMonths();
  const current = months.find((row) => row.current) || null;
  const complete = months.filter((row) => !row.current && row.complete).slice(-2);
  if (!complete.length) {
    return factor('structure', UNCLEAR, 'Card balance is ' + fmt(owed) + ' as of ' + fmtDate(view.today, 'short')
      + '; its direction is read after 1 complete month of history.');
  }
  // No pace is read before day 7 of the month (cards.js): the sentence says so and the symbol rests on the complete months.
  const read = current !== null && current.pace !== null;
  const rising = read && current.pace * 100 > PACE_PERCENT * current.start;
  const direction = cardDirection(complete);
  const ended = complete.map((row) => fmtMonth(row.ym, 'name') + ' ' + changeWords(row.change)).join(' and ');
  const pace = current === null ? ''
    : !read ? '; a pace for ' + fmtMonth(current.ym, 'name') + ' is read from day ' + PACE_FROM_DAY + ' of the month'
    : '; ' + fmtMonth(current.ym, 'name') + ' is on pace to end ' + paceWords(current.pace) + afterScheduled(current);
  return factor('structure', rising ? oneStepWorse(direction) : direction, 'Card balance ended ' + ended + pace + '.');
}

/** Where one or two complete months, oldest first, say the card balance is heading. */
function cardDirection(complete) {
  const changes = complete.map((row) => row.change);
  const net = changes.reduce((total, change) => total + change, 0);
  if (changes.length === 1) return net < 0 ? 'slight_plus' : net > 0 ? 'slight_minus' : 'equal';
  if (changes.every((change) => change < 0)) {
    return -net * 100 >= DEEP_CUT_PERCENT * complete[0].start ? 'clear_plus' : 'slight_plus';
  }
  if (changes.every((change) => change > 0)) return 'clear_minus';
  return net > 0 ? 'slight_minus' : 'equal';
}

function oneStepWorse(symbol) {
  return SYMBOLS[Math.min(SYMBOLS.indexOf(symbol) + 1, WORST_INDEX)];
}

/** "$45.00 higher" / "$45.00 lower" / "where it began". */
function changeWords(change) {
  if (change === 0) return 'where it began';
  return fmt(Math.abs(change)) + (change > 0 ? ' higher' : ' lower');
}

/** A pace is a projection: "≈$45.00 higher" / "≈$45.00 lower" / "where it began". */
function paceWords(change) {
  return change === 0 ? changeWords(change) : APPROX + changeWords(change);
}

/** The same, against the start of the month: "≈$45.00 higher than it began". */
function paceAgainstStart(change) {
  return change === 0 ? changeWords(change) : paceWords(change) + ' than it began';
}

/** ", after $460.00 in payments the Book still schedules" when the projection takes some off; else "". */
function afterScheduled(row) {
  return positive(row.scheduled) ? ', after ' + APPROX + fmt(row.scheduled) + ' in payments the Book still schedules' : '';
}

/** The same, against the start of the month: "$45.00 higher than it began". */
function againstStart(change) {
  return change === 0 ? changeWords(change) : changeWords(change) + ' than it began';
}

/* -------------------------------------------------------------- initiative */

function initiativeFactor(view) {
  const month = view.ledger.retention(view.today);
  const name = fmtMonth(month.ym, 'name');
  if (month.days < MIN_MONTH_DAYS) {
    return factor('initiative', UNCLEAR, name + ' is ' + countOf(month.days, 'day') + ' old; the share kept of what was earned is read from day '
      + MIN_MONTH_DAYS + '.');
  }
  if (!(month.earned > 0)) {
    return factor('initiative', UNCLEAR, 'Nothing was earned in ' + name + ' as of ' + fmtDate(view.today, 'short') + ', so there is no share kept to read.');
  }
  const step = RETENTION_STEPS.find(([percent]) => month.kept * 100 >= percent * month.earned);
  const share = percentOf(month.kept, month.earned, true);
  // With pay and bills counted day by day both sums are accruals, and a tapped-in move not yet at the
  // bank makes "kept" one too: an estimate is marked as one in prose as well (ARCHITECTURE 10).
  const position = view.ledger.position();
  const accrued = !!position.smoothing;
  const pencil = accrued || position.provisional > 0;
  return factor('initiative', step ? step[1] : 'clear_minus',
    name + ' to date: ' + (accrued ? '≈' : '') + fmt(month.earned) + ' earned, ' + (pencil ? '≈' : '') + fmtSigned(month.kept) + ' kept'
      + (share === null ? '' : ', ' + share) + '.');
}

/* ----------------------------------------------------------------- verdict */

function scoreOf(symbol) {
  return EQUAL_INDEX - SYMBOLS.indexOf(symbol);
}

function verdictSymbol(factors) {
  let total = 0;
  let weight = 0;
  for (const key of FACTOR_ORDER) {
    if (factors[key].symbol === UNCLEAR) continue;
    total += WEIGHTS[key] * scoreOf(factors[key].symbol);
    weight += WEIGHTS[key];
  }
  if (!weight) return UNCLEAR;
  const mean = total / weight;
  return SYMBOLS[EQUAL_INDEX - Math.sign(mean) * Math.floor(Math.abs(mean) + 0.5)];
}

function verdictSentence(symbol, factors) {
  const read = FACTOR_ORDER.filter((key) => factors[key].symbol !== UNCLEAR);
  if (!read.length) return SYMBOL_LABELS[symbol] + ' — no factor can be read yet.';
  const furthest = read
    .slice()
    .sort((a, b) => Math.abs(scoreOf(factors[b].symbol)) - Math.abs(scoreOf(factors[a].symbol)))
    .slice(0, 2);
  const named = FACTOR_ORDER.filter((key) => furthest.includes(key)).map((key) => {
    const score = scoreOf(factors[key].symbol);
    return STANDING[key][score > 0 ? 0 : score === 0 ? 1 : 2];
  });
  return SYMBOL_LABELS[symbol] + ' — ' + named.join(', ') + '.';
}

/* ------------------------------------------------------------ coach's notes */

/**
 * A note from its sentences. Sentences are dropped from the end until the text is under the limit;
 * a first sentence still too long (an unusually large figure) is cut.
 */
function note(key, priority, sentences, cta) {
  const kept = sentences.filter(Boolean);
  while (kept.length > 1 && kept.join(' ').length >= NOTE_LIMIT) kept.pop();
  const text = kept.join(' ');
  return { key, priority, text: text.length < NOTE_LIMIT ? text : text.slice(0, NOTE_LIMIT - 2).trimEnd() + '…', cta: cta || null };
}

/** True while a note that has had its run waits out the rest of its 14 days. */
function isResting(key, seen, today) {
  if (PINNED_KEYS.has(key) || !Object.hasOwn(seen, key) || !isYmd(seen[key])) return false;
  const age = diffDays(seen[key], today);
  return age >= NOTE_RUN_DAYS && age < NOTE_REST_DAYS;
}

function go(label, href) {
  return { label, href };
}

function openSheet(label, sheet, id) {
  return { label, action: 'app.sheet', data: id === undefined ? { sheet } : { sheet, id } };
}

/** The bank link: revoked, failing, or a connection the provider reports as broken — the first that applies. */
function linkNote(view) {
  const sync = isObject(view.doc.sync) ? view.doc.sync : {};
  const asOf = Number.isFinite(sync.lastOk) ? fmtDate(dayOfTime(view, sync.lastOk), 'dowshort') : null;
  if (sync.status === 'relink') {
    const first = asOf ? 'The bank link was revoked; figures are as of ' + asOf + '.' : 'The bank link was revoked before a 1st sync completed.';
    return note('relink', 100, [first, 'Link again to resume.'], go('Link again', '#/settings'));
  }
  if (sync.status === 'error') {
    const first = asOf ? 'The last bank sync did not complete; figures are as of ' + asOf + '.' : 'The 1st bank sync did not complete.';
    return note('sync-error', 100, [first, 'The next open tries again.'], go('Bank link', '#/settings'));
  }
  const problems = listOf(sync.problems).filter(isObject).length;
  if (!problems) return null;
  const first = problems === 1 ? '1 bank connection reports a problem at SimpleFIN Bridge.' : problems + ' bank connections report a problem at SimpleFIN Bridge.';
  return note('bank-problem', 100, [first, 'It is fixed there, not here.'], go('Open SimpleFIN Bridge', BRIDGE_URL));
}

function staleNote(view) {
  const position = view.ledger.position();
  if (position.freshness !== 'aging' && position.freshness !== 'old') return null;
  const hours = Math.floor((view.now - position.syncedAt) / HOUR_MS);
  const age = hours < 48 ? hours + ' hours' : Math.round(hours / 24) + ' days';
  return note('stale', 95, [
    'Bank data is as of ' + fmtDate(dayOfTime(view, position.syncedAt), 'dowshort') + ', about ' + age + ' old.',
    'Net worth holds still until the next sync.',
  ], { label: 'Check the bank', action: 'app.refresh' });
}

function shortfallNote(view) {
  const clock = view.ledger.clock();
  if (!(clock.shortfall > 0)) return null;
  return note('shortfall:' + (clock.nextPayday || 'next-' + DUE_WINDOW_DAYS + '-days'), 90, [
    'Cash: ' + fmt(clock.cash) + ' on the clock, ' + (clock.dueTotal > 0 ? APPROX + fmt(clock.dueTotal) + ' due ' : 'nothing due ') + dueWindow(clock) + '.',
  ], go('What is due', '#/book'));
}

/** Book charges whose day has passed with no charge seen: still owed, and still counted in what is due. */
function overdueNote(view) {
  const late = listOf(view.ledger.clock().due).filter((item) => isObject(item) && item.overdue === true && isYmd(item.day) && positive(item.amount));
  if (!late.length) return null;
  const oldest = late.reduce((first, item) => (item.day < first.day ? item : first), late[0]);
  const cta = go('What is due', '#/book');
  if (late.length === 1) {
    return note('overdue:' + oldest.id + ':' + oldest.day, 88, [
      oldest.name + ': ' + APPROX + fmt(oldest.amount) + ' was due ' + fmtDate(oldest.day, 'dowshort') + ' and has not posted.',
      'It stays in what is due, ' + countOf(Math.max(0, diffDays(oldest.day, view.today)), 'day') + ' on.',
    ], cta);
  }
  const total = late.reduce((sum, item) => sum + Math.round(item.amount), 0);
  return note('overdue:' + oldest.id + ':' + oldest.day, 88, [
    late.length + ' Book charges are past their day with no charge posted, ' + APPROX + fmt(total) + ' in all, the oldest from '
      + fmtDate(oldest.day, 'short') + '.',
  ], cta);
}

/** Pay that stopped: a scheduled stream (counted day by day or on arrival, ruling T4) with no deposit for more than 1.6 pay periods is no longer counted. */
function lapsedPayNotes(view) {
  const lapsed = listOf(view.ledger.position().lapsedPay).filter((item) => isObject(item) && isYmd(item.since));
  // A stream counted on arrival has no pay counted day by day: what stops for it is the payday (ruling T4).
  const onArrival = new Set(listOf(view.doc.streams).filter((stream) => isObject(stream) && !stream.accrue).map((stream) => stream.id));
  return lapsed.map((item) => note('pay-lapsed:' + item.id, 85, [
    'No deposit from ' + item.name + ' since ' + fmtDate(item.since, 'short') + '.',
    countOf(Math.max(0, diffDays(item.since, view.today)), 'day') + ' on, '
      + (onArrival.has(item.id) ? 'its payday is no longer expected.' : 'its pay is no longer counted.'),
  ], go('The Book', '#/book')));
}

function sweepNote(view) {
  const { sweep } = view.ledger.edge();
  if (!sweep) return null;
  return note('sweep:' + sweep.weekOf, 80, [
    'Last week you kept ' + fmt(sweep.amount, { decimals: 0 }) + ' against habit.',
    sweep.target === 'card' ? 'Move it to the card.' : 'Move it to the reserve.',
  ], openSheet('Move it', 'sweep'));
}

/** The business purchase whose return check has been due the longest. */
function paybackNote(view) {
  const hidden = hiddenAccountIds(view.doc);
  let due = null;
  for (const tx of listOf(view.doc.txs)) {
    if (!isObject(tx) || tx.kind !== 'spend' || tx.matchId || hidden.has(tx.accountId)) continue;
    if (!isObject(tx.payback) || (tx.payback.outcome != null && tx.payback.outcome !== 'notyet')) continue;
    if (!isYmd(tx.payback.by) || tx.payback.by > view.today || !isYmd(tx.day) || !positive(tx.amount)) continue;
    if (!due || tx.payback.by < due.payback.by) due = tx;
  }
  if (!due) return null;
  return note('payback:' + due.id, 70, [
    'The ' + fmt(due.amount) + ' business purchase of ' + fmtDate(due.day, 'short') + ' was to pay back by ' + fmtDate(due.payback.by, 'short') + '.',
    'Its return check is open.',
  ], openSheet('Answer', 'tx', String(due.id)));
}

/* ---------------------------------------------------------- notes: the Book */

/** At most one note each for an entry that is new, one whose price changed and one that seems to have ended. */
function bookNotes(view) {
  const charges = chargesByEntry(view.doc);
  const entries = listOf(view.doc.recurring).filter((entry) => isObject(entry) && typeof entry.id === 'string' && hasCadence(entry));
  const newest = (found) => found.filter(Boolean).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))[0];
  const added = newest(entries.map((entry) => newEntry(view, entry, charges.get(entry.id) || [])));
  const repriced = newest(entries.map((entry) => priceChange(view, entry, charges.get(entry.id) || [])));
  const ended = newest(entries.map((entry) => endedEntry(view, entry)));
  return [added, repriced, ended].filter(Boolean).map((found) => found.note);
}

/** The bank's charges linked to each Book entry, oldest first. */
function chargesByEntry(doc) {
  const byEntry = new Map();
  for (const tx of listOf(doc.txs)) {
    if (!isObject(tx) || tx.recurringId == null || tx.kind === 'decline' || tx.matchId || tx.source === 'manual') continue;
    if (tx.flow === 'in' || !isYmd(tx.day) || !positive(tx.amount)) continue;
    const list = byEntry.get(tx.recurringId);
    if (list) list.push(tx);
    else byEntry.set(tx.recurringId, [tx]);
  }
  for (const list of byEntry.values()) list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return byEntry;
}

function isNews(view, day) {
  const age = diffDays(day, view.today);
  return age >= 0 && age < NEWS_DAYS;
}

/** How many charges it takes to detect an entry of this cadence (ARCHITECTURE 6). */
function chargesToDetect(entry, charges) {
  if (CADENCES[entry.cadence].perYear > 12) return 4;
  if (entry.cadence !== 'monthly') return 2;
  return charges.length > 1 && charges[0].amount === charges[1].amount ? 2 : 3;
}

function newEntry(view, entry, charges) {
  const untouched = entry.active && entry.source === 'detected' && entry.verdict == null && !listOf(entry.locks).length;
  if (!untouched || !positive(entry.amount) || view.firstDay === null || charges.length !== chargesToDetect(entry, charges)) return null;
  const first = charges[0].day;
  const latest = charges[charges.length - 1].day;
  const beganInView = diffDays(view.firstDay, first) >= Math.ceil(CADENCES[entry.cadence].days);
  if (!beganInView || !isNews(view, latest)) return null;
  return {
    day: latest,
    note: note('book:new:' + entry.id, 62, [
      'New in the Book: ' + shortName(entry.name) + ', ' + fmt(entry.amount) + ' ' + cadenceWords(entry) + ' since ' + fmtDate(first, 'short') + '.',
      fmt(annualCost(entry), { decimals: 0 }) + ' a year.',
    ], openSheet('Open', 'recurring', entry.id)),
  };
}

/** A steady price that stepped: the latest charge differs from two equal charges before it. */
function priceChange(view, entry, charges) {
  if (!entry.active || entry.variable || charges.length < 3) return null;
  const [before, last, latest] = charges.slice(-3);
  if (before.amount !== last.amount || latest.amount === last.amount || !isNews(view, latest.day)) return null;
  const perYear = roundCents((latest.amount - last.amount) * CADENCES[entry.cadence].perYear);
  return {
    day: latest.day,
    note: note('book:price:' + entry.id + ':' + latest.day, 60, [
      shortName(entry.name) + ' went from ' + fmt(last.amount) + ' to ' + fmt(latest.amount) + ' on ' + fmtDate(latest.day, 'short') + '.',
      fmtSigned(perYear, { decimals: 0 }) + ' a year.',
    ], openSheet('Open', 'recurring', entry.id)),
  };
}

function endedEntry(view, entry) {
  if (entry.active || entry.source !== 'detected' || listOf(entry.locks).includes('active') || !isYmd(entry.anchor)) return null;
  const lapsedOn = addDays(entry.anchor, Math.floor(BILL_LAPSE_PERIODS * CADENCES[entry.cadence].days) + 1);
  if (!isNews(view, lapsedOn)) return null;
  return {
    day: lapsedOn,
    note: note('book:ended:' + entry.id, 58, [
      shortName(entry.name) + ' was last charged ' + fmtDate(entry.anchor, 'short') + ' and seems to have ended.',
      positive(entry.amount) ? fmt(entry.amount) + ' ' + cadenceWords(entry) + ' is out of the Book.' : '',
    ], openSheet('Open', 'recurring', entry.id)),
  };
}

function renewalNote(view) {
  // The window opens today (day 0), so 22 days reach the renewal that is 21 days away.
  const next = renewals(view.doc, view.today, RENEWAL_DAYS + 1)[0];
  if (!next) return null;
  const when = next.inDays === 0 ? 'today' : fmtDate(next.day, 'dowshort') + ', in ' + countOf(next.inDays, 'day') + ',';
  return note('renewal:' + next.id + ':' + next.day, 50, [
    shortName(next.name) + ' renews ' + when + ' at ' + APPROX + fmt(next.amount) + '.',
    next.setAside > 0 ? 'About ' + fmt(next.setAside) + ' of it has accrued.' : '',
  ], openSheet('Open', 'recurring', String(next.id)));
}

/* ------------------------------------------------------------ notes: cards */

function cardMonthBefore(view) {
  const previous = addMonthsYm(view.month, -1);
  return view.recentCardMonths().find((row) => row.ym === previous) || null;
}

/** Last month's verdict during the first week of a month; this month's pace after it. */
function cardNote(view) {
  const cta = go('Card cycle', '#/material');
  if (parts(view.today).d <= FIRST_WEEK) {
    const last = cardMonthBefore(view);
    if (!last || !last.complete || !(last.start > 0 || last.end > 0)) return null;
    return note('card-month:' + last.ym, 45, [
      'Card balance ended ' + fmtMonth(last.ym, 'name') + ' ' + againstStart(last.change) + ', at ' + fmt(last.end) + '.',
    ], cta);
  }
  const current = view.recentCardMonths().find((row) => row.current) || null;
  if (!current || current.pace === null || !(current.start > 0 || current.end > 0)) return null;
  return note('card-pace:' + current.ym, 45, [
    positive(current.scheduled)
      ? 'Cards are on pace to end ' + fmtMonth(current.ym, 'name') + ' ' + paceWords(current.pace) + ', at ' + APPROX + fmt(current.projected)
        + ', after ' + APPROX + fmt(current.scheduled) + ' still scheduled.'
      : 'Card balance is on pace to end ' + fmtMonth(current.ym, 'name') + ' ' + paceAgainstStart(current.pace) + ', at ' + APPROX + fmt(current.projected) + '.',
  ], cta);
}

function interestNote(view) {
  const last = cardMonthBefore(view);
  if (!last || !(last.interest > 0)) return null;
  const { interestPerDay } = view.cards();
  return note('interest:' + last.ym, 40, [
    'Cards charged ' + fmt(last.interest) + ' in interest and fees in ' + fmtMonth(last.ym, 'name') + '.',
    positive(interestPerDay) ? 'About ' + fmt(interestPerDay) + ' a day at the balance now.' : '',
  ], go('Card cycle', '#/material'));
}

/* --------------------------------------------------------- notes: the game */

/** The category target furthest along this month. */
function targetNote(view) {
  const settings = isObject(view.doc.settings) ? view.doc.settings : {};
  const targets = Object.entries(isObject(settings.targets) ? settings.targets : {}).filter(([, target]) => positive(target));
  if (!targets.length) return null;
  const spentIn = (from, to) => new Map(view.ledger.spendingByCategory(from, to).map((row) => [row.category, row.amount]));
  const lastMonth = addMonthsYm(view.month, -1);
  const now = spentIn(startOfMonth(view.month), view.today);
  let best = null;
  for (const [category, target] of targets) {
    const spent = now.get(category) || 0;
    if (spent > 0 && (!best || spent * best.target > best.spent * target)) best = { category, target, spent };
  }
  if (!best) return null;
  const before = spentIn(startOfMonth(lastMonth), endOfMonth(lastMonth)).get(best.category) || 0;
  return note('target:' + best.category + ':' + view.month, 35, [
    categoryLabel(best.category) + ': ' + fmt(best.spent) + ' in ' + fmtMonth(view.month, 'name') + ' against a '
      + fmt(best.target, { decimals: best.target % 100 === 0 ? 0 : 2 }) + ' target.',
    before > 0 ? fmtMonth(lastMonth, 'name') + ' finished at ' + fmt(before) + '.' : '',
  ], go('Scoresheet', '#/scoresheet'));
}

function stackedNote(view) {
  const { stackedDays, stackedCost } = reviewRounds(view.ledger.monthTable(view.month).rounds);
  if (!stackedDays) return null;
  return note('stacked:' + view.month, 30, [
    'A 2nd or later stop on ' + countOf(stackedDays, 'day') + ' in ' + fmtMonth(view.month, 'name') + ': those stops came to ' + fmt(stackedCost) + '.',
  ], go('Scoresheet', '#/scoresheet'));
}

/** The furthest reserve milestone reached, when the reserve was still short of it 14 days ago. */
function reserveNote(view) {
  const clock = view.ledger.clock();
  const reached = clock.milestones.filter((milestone) => milestone.reached);
  const top = reached[reached.length - 1];
  if (!top || reserveOn(view, addDays(view.today, -NEWS_DAYS)) >= top.amount) return null;
  const next = clock.milestones.find((milestone) => !milestone.reached && milestone.amount > top.amount) || null;
  const first = top.label === 'Goal'
    ? 'The reserve reached its goal of ' + fmt(top.amount) + ': ' + fmt(clock.reserve) + ' as of ' + fmtDate(view.today, 'short') + '.'
    : 'The reserve of ' + fmt(clock.reserve) + ' now covers ' + top.label + ' of outflow at ' + fmt(clock.burn) + ' a day.';
  return note('reserve:' + top.label, 25, [
    first,
    next ? 'Next: ' + (next.label === 'Goal' ? 'the goal' : next.label) + ', ' + fmt(next.amount) + '.' : '',
  ], go('Analysis', '#/analysis'));
}

/** The reserve at the end of a day: cash accounts flagged as reserve, or all cash when none is. */
function reserveOn(view, day) {
  const cash = cashAccounts(view.doc);
  const flagged = cash.filter((account) => account.reserve);
  return sumOf(flagged.length ? flagged : cash, (account) => view.ledger.accountValueOn(account.id, day));
}

/**
 * The scale of the daily game against the cards: what a perfect month of `gameYm` is worth, and what
 * the cards took in new charges in `chargesYm` (`when` names that month). Without card charges the
 * Book stands in.
 */
function scaleSentences(view, gameYm, chargesYm, when) {
  const { perfect } = view.ledger.monthTable(gameYm);
  if (!(perfect > 0)) return [];
  const first = 'A perfect month in the daily game is worth ' + fmt(perfect, { decimals: 0 }) + '.';
  const row = cardRow(view, chargesYm);
  if (row && row.charges > 0) return [first, 'Cards took ' + fmt(row.charges, { decimals: 0 }) + ' in new charges ' + when + '.'];
  const { perMonth } = bookTotals(view.doc);
  return perMonth > 0 ? [first, 'The Book takes ' + fmt(perMonth, { decimals: 0 }) + ' a month.'] : [first];
}

function scaleNote(view) {
  const sentences = scaleSentences(view, view.month, addMonthsYm(view.month, -1), 'last month');
  if (sentences.length < 2) return null;
  return note('scale:' + view.month, 20, sentences, go('Analysis', '#/analysis'));
}

function reviewNote(view) {
  const since = addDays(view.today, -REVIEW_DAYS);
  let count = 0;
  let oldest = null;
  for (const tx of listOf(view.doc.txs)) {
    if (!isObject(tx) || !tx.review || tx.matchId || tx.kind === 'decline' || !isYmd(tx.day) || tx.day < since || tx.day > view.today) continue;
    count += 1;
    if (oldest === null || tx.day < oldest) oldest = tx.day;
  }
  if (!count) return null;
  return note('review', 15, [
    countOf(count, 'move') + (count === 1 ? ' is' : ' are') + ' waiting for a purpose, the oldest from ' + fmtDate(oldest, 'short') + '.',
  ], go('Review', '#/scoresheet?filter=review'));
}

/**
 * Smoothing is wanted and nothing accrues: no stream has been found that pays on a schedule. A stream
 * the owner set to count on arrival, or one whose deposits stopped, is regular pay that was found:
 * neither is reported as missing (pay is counted when it arrives; a stopped stream has its own note).
 */
function noPayNote(view) {
  const settings = isObject(view.doc.settings) ? view.doc.settings : {};
  const wanted = settings.smoothing === undefined || !!settings.smoothing;
  const position = view.ledger.position();
  if (!wanted || view.firstDay === null || position.smoothing) return null;
  if (hasRegularPay(view.doc) || listOf(position.lapsedPay).length) return null;
  return note('no-pay', 10, [
    'No regular pay is detected in ' + countOf(historyDays(view), 'day') + ' on record.',
    'Until one is, net worth steps up on each payday.',
  ], go('Income', '#/settings'));
}

/* ------------------------------------------------------------ month review */

/** The all-cards row of a month, or null when it is ahead of today or behind the transaction history. */
function cardRow(view, ym) {
  if (ym > view.month) return null;
  const back = monthsApart(ym, view.month);
  return (back < 3 ? view.recentCardMonths() : view.cardMonths(back + 1)).find((row) => row.ym === ym) || null;
}

function cardReview(view, ym) {
  const row = cardRow(view, ym);
  if (!row || !(row.start > 0 || row.end > 0 || row.charges > 0)) return null;
  const name = fmtMonth(ym, 'name');
  const early = row.current && row.pace === null;
  // Ruling T5: before day 7 no pace is read (projected is null) and a card in credit is still said to be in credit.
  const inCredit = row.current && positive(row.credit) && row.end === 0 && (row.projected === 0 || row.projected == null);
  const sentence = inCredit && early
    ? 'Cards are ' + fmt(row.credit) + ' in credit as of ' + fmtDate(view.today, 'short') + ': nothing is owed. A pace is read from day ' + PACE_FROM_DAY + ' of the month.'
    : inCredit
    ? 'Cards are ' + fmt(row.credit) + ' in credit as of ' + fmtDate(view.today, 'short') + ': nothing is owed, and ' + name + ' is on pace to end that way.'
    : early
    ? 'Card balance is ' + fmt(row.end) + ' as of ' + fmtDate(view.today, 'short') + '. A pace is read from day ' + PACE_FROM_DAY + ' of the month.'
    : row.current
    ? 'Card balance is on pace to end ' + name + ' ' + paceAgainstStart(row.pace) + ', at ' + APPROX + fmt(row.projected) + afterScheduled(row) + '.'
    : 'Card balance ended ' + name + ' ' + againstStart(row.change) + ': ' + fmt(row.start) + ' to ' + fmt(row.end) + '.';
  return { change: row.change, start: row.start, end: row.end, sentence };
}

function cashReview(view, ym) {
  const cashOn = (day) => sumOf(cashAccounts(view.doc), (account) => view.ledger.accountValueOn(account.id, day));
  const end = cashOn(endOfMonth(ym));
  const change = end - cashOn(endOfMonth(addMonthsYm(ym, -1)));
  return { change, sentence: 'Cash moved ' + fmtSigned(change) + ' ' + monthSpan(view, ym) + ', to ' + fmt(end) + '.' };
}

function netWorthReview(view, ym) {
  const eve = endOfMonth(addMonthsYm(ym, -1));
  const rows = view.ledger.closes(minYmd(eve, view.today), endOfMonth(ym));
  const end = rows.length ? rows[rows.length - 1].smooth : 0;
  const change = rows.length ? end - rows[0].smooth : 0;
  return { change, sentence: 'Net worth moved ' + fmtSigned(change) + ' ' + monthSpan(view, ym) + ', to ' + fmt(end) + '.' };
}

function monthSpan(view, ym) {
  return (ym === view.month ? 'so far in ' : 'in ') + fmtMonth(ym, 'name');
}

/* ------------------------------------------------------------ small helpers */

function isObject(x) {
  return x !== null && typeof x === 'object';
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}

function positive(x) {
  return Number.isFinite(x) && x > 0;
}

function isYm(ym) {
  return typeof ym === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(ym);
}

function hasCadence(item) {
  return typeof item.cadence === 'string' && Object.hasOwn(CADENCES, item.cadence);
}

function sumOf(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item);
  return total;
}

function countOf(n, noun) {
  return n + ' ' + noun + (n === 1 ? '' : 's');
}

/**
 * "14%" — a share of a whole, rounded; signed with the true minus when `signed`. Null when the
 * magnitude is over MAX_PERCENT: such a share is never printed, the caller drops its clause.
 */
function percentOf(part, whole, signed) {
  const percent = Math.round(Math.abs(part) / whole * 100);
  if (!(percent <= MAX_PERCENT)) return null;
  return (signed && part < 0 && percent > 0 ? MINUS : '') + percent + '%';
}

/** Whole calendar months from one 'YYYY-MM' to a later one. */
function monthsApart(from, to) {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

/** The game day of a timestamp, under the document's rollover hour. */
function dayOfTime(view, ms) {
  const settings = isObject(view.doc.settings) ? view.doc.settings : {};
  const hour = settings.rolloverHour;
  return gameDay(ms, Number.isFinite(hour) && hour >= 0 && hour < 24 ? hour : 0);
}

function hiddenAccountIds(doc) {
  return new Set(listOf(doc.accounts).filter((account) => isObject(account) && account.hidden).map((account) => account.id));
}

/** The visible cash accounts, each id once. */
function cashAccounts(doc) {
  const seen = new Set();
  return listOf(doc.accounts).filter((account) => {
    if (!isObject(account) || typeof account.id !== 'string' || seen.has(account.id) || account.hidden) return false;
    seen.add(account.id);
    return Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type].group === 'cash';
  });
}

function sweepIdsOf(doc) {
  return new Set(listOf(doc.sweeps).filter(isObject).map((sweep) => sweep.txId).filter((id) => id != null));
}

/** "monthly", "every 2 weeks", "yearly" — a cadence as it reads after an amount. */
function cadenceWords(entry) {
  return CADENCES[entry.cadence].label.toLowerCase();
}

/** A name fit for a note: one line, at most 24 characters. Bank text stays text; the view escapes it. */
function shortName(name) {
  const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!clean) return 'A Book entry';
  return clean.length > MAX_NAME ? clean.slice(0, MAX_NAME - 1).trimEnd() + '…' : clean;
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
