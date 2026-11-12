/**
 * Revolving card debt: the monthly cycle, its pace and its history. See ARCHITECTURE.md section 5.
 * Pure. Imports: schema, dates, money, ledger (for balances by day), loans (payoff), book (the schedule).
 */

import { ACCOUNT_TYPES, accountLabel } from './schema.js';
import { addDays, addMonthsYm, daysInMonth, diffDays, endOfMonth, isYmd, monthOf, parts, startOfMonth } from './dates.js';
import { roundCents } from './money.js';
import { makeLedger } from './ledger.js';
import { dailyInterest } from './loans.js';
import { earlyDays, entryLapsed, occurrences } from './book.js';

/** `accountId` of a row that adds every card together. */
export const ALL_CARDS = 'all';

const DEFAULT_MONTHS = 6;
const DEFAULT_LARGEST = 3;
const INTEREST_CATEGORY = 'fees_interest';
/** The first day of a month on which its card pace is read: one or two days of charges are not a pace. */
export const PACE_FROM_DAY = 7;

/*
 * How the specification is read where it leaves a choice:
 *  - A month counts the rows the ledger counts in the card's balance (bank rows; no declines, no
 *    superseded or provisional manual moves; pending rows only when settings.countPending), so that
 *    end − start = charges − payments − refunds whenever the card is not in credit.
 *  - Every out-flow is a charge. An in-flow of kind `payment` or `transfer` is a payment; any other
 *    in-flow (a refund, a statement credit) is a refund.
 *  - History begins on the day of the earliest counted transaction in the document, on any account.
 *    `complete` says whether the month's first day is inside that history; it does not say that the
 *    month has ended (`current` does).
 *  - In the current month the days elapsed are the day of the month, today included.
 *  - The projection is made card by card on the signed balance: what stands now, plus the charges at
 *    this month's daily pace for the days that remain, plus the Book's charges to that card still to
 *    come this month, less the payments the Book still schedules to it (for both: the entry's
 *    occurrences in the month that no linked row has met yet, at the entry's amount). What a card is
 *    in credit by absorbs its charges first; a card that ends in credit owes 0.
 *  - The daily pace counts only the charges that can recur day by day: a charge linked to a Book
 *    entry is on the Book's schedule, and interest or a fee posts once a month, so neither is
 *    multiplied over the days that remain.
 *  - No pace is read before day 7 of the month (PACE_FROM_DAY): `projected` and `pace` are null and
 *    the interface says "A pace is read from day 7 of the month."
 *  - A hypothetical purchase (`opts.extraCharge`, "before you buy") goes inside the same sum, on the
 *    card named by `opts.extraAccountId` or else the first visible card, so a credit absorbs it first.
 *  - Every query takes an options object last; `opts.ledger` (a ledger made by makeLedger for the
 *    same document and time) is used instead of building another.
 */

/**
 * @typedef {Object} CardMonth
 * @property {string} accountId
 * @property {string} ym
 * @property {number} start        owed at the end of the last day of the previous month (positive cents; 0 when in credit)
 * @property {number} charges      purchases, fees and interest in the month (out-flows), cents
 * @property {number} payments     payments received in the month, cents
 * @property {number} refunds      refunds in the month, cents
 * @property {number} interest     the part of `charges` that is interest or fees, cents
 * @property {number} end          owed at the end of the month, or now for the current month
 * @property {number} change       end − start (negative = the balance fell)
 * @property {boolean} current     true for the month containing today
 * @property {boolean} complete    false when the month starts before the available transaction history
 * @property {number|null} projected   current month from day 7 only (null before it and for other months):
 *                                     now + paced charges / daysElapsed × daysRemaining + `bookCharges` − `scheduled`, never below 0
 * @property {number|null} pace        projected − start (negative = on pace to end lower); null whenever `projected` is
 * @property {number} scheduled    current month only (else 0): Book payments to the card still to come this month, cents
 * @property {number} bookCharges  current month only (else 0): Book charges to the card still to come this month, cents
 * @property {number} credit       what the card is in credit by at the end of the month (or now), cents; 0 when it owes
 * @property {number} daysElapsed
 * @property {number} daysInMonth
 */

/**
 * The cycle of one card for one calendar month.
 * An unknown, hidden or non-card account, or a month that is not 'YYYY-MM', gives a row of zeros.
 * @param {object} state
 * @param {string} accountId
 * @param {string} ym
 * @param {number} nowMs
 * @returns {CardMonth}
 */
export function cardMonth(state, accountId, ym, nowMs, opts) {
  const book = openBook(state, nowMs, opts);
  return finishMonth(book, accountId, ym, monthFigures(book, accountId, ym));
}

/**
 * The last `months` months (oldest first, current month last) for one card, limited to months for
 * which any transaction history exists. The current month is always there.
 * @returns {CardMonth[]}
 */
export function cardMonths(state, accountId, months, nowMs, opts) {
  const book = openBook(state, nowMs, opts);
  return monthsShown(book, months).map((ym) => finishMonth(book, accountId, ym, monthFigures(book, accountId, ym)));
}

/**
 * All cards together for the current month and the previous `months − 1`: the same fields summed
 * across every non-hidden card account (accountId = 'all'). Like `cardMonths` it reaches no further
 * back than the transaction history; with no card at all every figure is 0.
 * @returns {CardMonth[]}
 */
export function allCardsMonths(state, months, nowMs, opts) {
  const book = openBook(state, nowMs, opts);
  return monthsShown(book, months).map((ym) => {
    const total = emptyFigures();
    for (const card of book.cards) addFigures(total, monthFigures(book, card.id, ym));
    // A hypothetical purchase with no card in the document to go on is still owed at the month's end.
    if (ym === book.thisMonth && !book.cards.length) total.projected += book.extraCharge;
    return finishMonth(book, ALL_CARDS, ym, total);
  });
}

/**
 * A summary of revolving debt now. `cards` lists every non-hidden card in document order.
 * `limit` adds up the limits that are known (null when none is) and `utilisation` is what is owed on
 * those cards against it, so a card without a limit never distorts the figure; it is not capped at 1.
 * @returns {{ owed: number, limit: number|null, utilisation: number|null, interestPerDay: number|null,
 *             cards: { id: string, label: string, owed: number, apr: number|null, limit: number|null }[] }}
 *   interestPerDay (cents, may be fractional) is null unless every owed card has an apr
 */
export function cardsNow(state, nowMs, opts) {
  const book = openBook(state, nowMs, opts);
  const cards = book.cards.map((account) => ({
    id: account.id,
    label: accountLabel(account),
    owed: owedOf(book.ledger.accountValueOn(account.id, book.today)),
    apr: aprOf(account),
    limit: limitOf(account),
  }));
  const limited = cards.filter((card) => card.limit !== null);
  const limit = limited.length ? sumOf(limited, (card) => card.limit) : null;
  const owing = cards.filter((card) => card.owed > 0);
  return {
    owed: sumOf(cards, (card) => card.owed),
    limit,
    utilisation: limit === null ? null : sumOf(limited, (card) => card.owed) / limit,
    interestPerDay: owing.every((card) => card.apr !== null) ? sumOf(owing, (card) => dailyInterest(card.owed, card.apr)) : null,
    cards,
  };
}

/**
 * The three largest charges on cards in a month (for the month-end verdict): out-flows on non-hidden
 * cards, the larger first, then the earlier. `nowMs` does not change the answer; it is taken so every
 * query here has the same shape.
 * @param {object} state
 * @param {string} ym
 * @param {number} nowMs
 * @param {number} [count]  default 3
 * @returns {object[]} Tx objects, largest first
 */
export function largestCharges(state, ym, nowMs, count, opts) {
  const book = openBook(state, nowMs, opts);
  const limit = Number.isFinite(count) ? Math.floor(count) : DEFAULT_LARGEST;
  if (!isYm(ym) || limit < 1) return [];
  const charges = [];
  for (const card of book.cards) {
    for (const tx of book.rows.get(card.id) || []) {
      if (tx.flow !== 'in' && monthOf(tx.day) === ym && Math.round(tx.amount) > 0) charges.push(tx);
    }
  }
  return charges.sort(largerThenEarlier).slice(0, limit);
}

/**
 * The first day of the transaction history: the day of the earliest counted transaction in the
 * document, on any account. Null when there is none.
 * @returns {string|null}
 */
export function firstTransactionDay(state) {
  let first = null;
  for (const tx of listOf(isObject(state) ? state.txs : null)) {
    if (isCounted(tx) && (first === null || tx.day < first)) first = tx.day;
  }
  return first;
}

/**
 * Days on record: from the day of the first counted transaction through `today`, both included
 * (Jun 1 to Jun 10 is 10 days). 0 when there is no transaction on or before today. This is the one
 * count of history the interface shows; a rule that needs M completed days is met from day M + 1.
 * @param {object} state
 * @param {string} today  game day, 'YYYY-MM-DD'
 * @returns {number}
 */
export function historyDays(state, today) {
  const first = firstTransactionDay(state);
  return first === null || !isYmd(today) || first > today ? 0 : diffDays(first, today) + 1;
}

/* -------------------------------------------------------------------- book */

/**
 * What one query needs, read once: the ledger, today, the visible cards and, by account, the rows
 * the ledger runs through its balance (pending rows only when the owner counts them).
 */
function openBook(state, nowMs, opts) {
  const doc = isObject(state) ? state : {};
  const given = isObject(opts) ? opts : {};
  const ledger = isObject(given.ledger) ? given.ledger : makeLedger(doc, nowMs);
  const cards = visibleCards(doc);
  const extra = Number.isFinite(given.extraCharge) && given.extraCharge > 0 ? Math.round(given.extraCharge) : 0;
  const named = cards.find((card) => card.id === given.extraAccountId) || cards[0] || null;
  const countPending = !isObject(doc.settings) || doc.settings.countPending === undefined || !!doc.settings.countPending;
  const rows = new Map();
  for (const tx of listOf(doc.txs)) {
    if (!isCounted(tx) || (tx.pending && !countPending)) continue;
    const list = rows.get(tx.accountId);
    if (list) list.push(tx);
    else rows.set(tx.accountId, [tx]);
  }
  return {
    ledger, today: ledger.today, thisMonth: monthOf(ledger.today),
    cards, rows, firstDay: firstTransactionDay(doc),
    recurring: listOf(doc.recurring), txs: listOf(doc.txs), met: new Map(),
    extraCharge: extra, extraAccountId: named ? named.id : null,
  };
}

/**
 * True for a row the bank reported that moves a balance: a real day and amount, not a decline, and
 * not a move the owner tapped in (provisional, or superseded by its bank row).
 */
function isCounted(tx) {
  if (!isObject(tx) || !Number.isFinite(tx.amount) || tx.amount < 0 || !isYmd(tx.day)) return false;
  return tx.kind !== 'decline' && !tx.matchId && tx.source !== 'manual';
}

/** Non-hidden card accounts, each id once, in document order. */
function visibleCards(doc) {
  const seen = new Set();
  const cards = [];
  for (const account of listOf(doc.accounts)) {
    if (!isObject(account) || typeof account.id !== 'string' || seen.has(account.id)) continue;
    seen.add(account.id);
    if (!account.hidden && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type].group === 'card') cards.push(account);
  }
  return cards;
}

/** The months a history shows, oldest first: the last `months`, no further back than the first transaction. */
function monthsShown(book, months) {
  const count = Number.isFinite(months) ? Math.floor(months) : DEFAULT_MONTHS;
  if (count < 1) return [];
  const requested = addMonthsYm(book.thisMonth, -(count - 1));
  const reached = book.firstDay === null ? book.thisMonth : monthOf(book.firstDay);
  const shown = [];
  for (let ym = requested > reached ? requested : reached; ym <= book.thisMonth; ym = addMonthsYm(ym, 1)) shown.push(ym);
  return shown;
}

/* ------------------------------------------------------------------ months */

function emptyFigures() {
  return { start: 0, charges: 0, payments: 0, refunds: 0, interest: 0, end: 0, scheduled: 0, bookCharges: 0, credit: 0, projected: 0 };
}

/** Add one card's figures to a total. A projection that is not read yet (null) leaves the total's unread too. */
function addFigures(total, figures) {
  for (const key of Object.keys(total)) {
    total[key] = total[key] === null || figures[key] === null ? null : total[key] + figures[key];
  }
}

/** True from day 7 of the current month on: before it the month's charges are too few to be a pace. */
function paceIsRead(book) {
  return parts(book.today).d >= PACE_FROM_DAY;
}

/** What one card owed going into a month and coming out of it, and what moved it in between. */
function monthFigures(book, accountId, ym) {
  const figures = emptyFigures();
  if (!isYm(ym) || !book.cards.some((card) => card.id === accountId)) return figures;
  figures.start = owedOf(book.ledger.accountValueOn(accountId, endOfMonth(addMonthsYm(ym, -1))));
  // The ledger answers with the balance now for today and every later day, which is the current month's end.
  const signedEnd = book.ledger.accountValueOn(accountId, endOfMonth(ym));
  figures.end = owedOf(signedEnd);
  figures.credit = Number.isFinite(signedEnd) && signedEnd > 0 ? roundCents(signedEnd) : 0;
  let paceable = 0;
  for (const tx of book.rows.get(accountId) || []) {
    if (monthOf(tx.day) !== ym) continue;
    const amount = Math.round(tx.amount);
    if (tx.flow === 'in') {
      if (tx.kind === 'payment' || tx.kind === 'transfer') figures.payments += amount;
      else figures.refunds += amount;
    } else {
      figures.charges += amount;
      if (tx.category === INTEREST_CATEGORY) figures.interest += amount;
      else if (tx.recurringId == null) paceable += amount;
    }
  }
  if (ym === book.thisMonth) {
    const elapsed = parts(book.today).d;
    figures.scheduled = scheduledToCome(book, accountId, ym, true);
    figures.bookCharges = scheduledToCome(book, accountId, ym, false);
    if (paceIsRead(book)) {
      const paced = roundCents(paceable / elapsed * (daysInMonth(ym) - elapsed));
      const extra = accountId === book.extraAccountId ? book.extraCharge : 0;
      figures.projected = owedOf((Number.isFinite(signedEnd) ? signedEnd : 0) - paced - figures.bookCharges - extra + figures.scheduled);
    } else {
      figures.projected = null;
    }
  }
  return figures;
}

/**
 * What the Book still schedules on a card this month: for each active entry that pays it down
 * (`payments`) or is charged to it (otherwise), its occurrences in the month that have not happened
 * yet, at the entry's amount. An occurrence has happened when a counted row linked to the entry is
 * dated on or after its day minus the early days (book.js earlyDays, the clock's rule), and one row
 * meets one occurrence at most (ruling T3): the card pace and the clock agree.
 */
function scheduledToCome(book, accountId, ym, payments) {
  let total = 0;
  for (const entry of book.recurring) {
    if (!isObject(entry) || !entry.active || !(entry.amount > 0)) continue;
    if (payments ? entry.toAccountId !== accountId : entry.accountId !== accountId || entry.toAccountId != null) continue;
    let planned = occurrences(entry, endOfMonth(addMonthsYm(ym, -1)), endOfMonth(ym));
    if (!planned.length) continue;
    const early = earlyDays(entry);
    const rows = linkedDays(book).get(entry.id) || [];
    // The clock only ever asks whether the LAST occurrence on or before yesterday has been met
    // (ledger overdueOf): an older one that was skipped is forgotten there, so it is here; and that
    // last one stays open only while the entry has not lapsed. What is still ahead is always counted.
    const yesterday = addDays(book.today, -1);
    const past = planned.filter((day) => day <= yesterday);
    if (past.length) {
      const last = past[past.length - 1];
      const gone = entryLapsed(entry, rows.length ? rows[rows.length - 1] : null, book.today);
      planned = planned.filter((day) => (gone ? day > last : day >= last));
      if (!planned.length) continue;
    }
    let next = 0;
    let open = 0;
    for (const day of planned) {
      const from = addDays(day, -early);
      while (next < rows.length && rows[next] < from) next += 1;
      if (next < rows.length) next += 1;
      else open += 1;
    }
    total += open * Math.round(entry.amount);
  }
  return total;
}

/**
 * The days of the counted rows linked to each Book entry, ascending, by entry id; the two legs of one
 * payment or transfer are one row. Read once and kept on the book, so the schedule of every entry and
 * card costs one pass over the rows.
 */
function linkedDays(book) {
  if (!book.met.has('linked')) {
    const days = new Map();
    const legs = new Set();
    for (const tx of book.txs) {
      if (!isCounted(tx) || tx.recurringId == null || !isYmd(tx.day)) continue;
      if (tx.pairId != null && legs.has(tx.pairId)) continue;
      if (tx.id != null) legs.add(tx.id);
      if (!days.has(tx.recurringId)) days.set(tx.recurringId, []);
      days.get(tx.recurringId).push(tx.day);
    }
    for (const list of days.values()) list.sort();
    book.met.set('linked', days);
  }
  return book.met.get('linked');
}

/** Figures (of one card or of all) as a CardMonth: the change, where the month stands, and the pace. */
function finishMonth(book, accountId, ym, figures) {
  const valid = isYm(ym);
  const current = valid && ym === book.thisMonth;
  const length = valid ? daysInMonth(ym) : 0;
  const daysElapsed = !valid || ym > book.thisMonth ? 0 : current ? parts(book.today).d : length;
  const projected = current && paceIsRead(book) ? figures.projected : null;
  return {
    accountId,
    ym,
    start: figures.start,
    charges: figures.charges,
    payments: figures.payments,
    refunds: figures.refunds,
    interest: figures.interest,
    end: figures.end,
    change: figures.end - figures.start,
    current,
    complete: valid && book.firstDay !== null && startOfMonth(ym) >= book.firstDay,
    projected,
    pace: projected === null ? null : projected - figures.start,
    scheduled: current ? figures.scheduled : 0,
    bookCharges: current ? figures.bookCharges : 0,
    credit: figures.credit,
    daysElapsed,
    daysInMonth: length,
  };
}

/* ------------------------------------------------------------ small helpers */

/** Whole cents owed for a signed balance; a card in credit owes nothing. */
function owedOf(balance) {
  return Number.isFinite(balance) && balance < 0 ? roundCents(-balance) : 0;
}

function aprOf(account) {
  return Number.isFinite(account.apr) && account.apr >= 0 ? account.apr : null;
}

function limitOf(account) {
  return Number.isFinite(account.limit) && account.limit > 0 ? Math.round(account.limit) : null;
}

function largerThenEarlier(a, b) {
  if (a.amount !== b.amount) return b.amount - a.amount;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

function isYm(ym) {
  return typeof ym === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(ym);
}

function isObject(x) {
  return x !== null && typeof x === 'object';
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}

function sumOf(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item);
  return total;
}
