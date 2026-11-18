/**
 * Money in and out: the figures of the Analysis cell's first face, Imbalances in Chess words and Cash flow in Finance
 * words (ARCHITECTURE 9). Pass 1 of the design: the period and its comparison, in and out, the queue of moves to
 * file (money out), where it went, the leaks and the Book's bills, all read from data the app already has. Nothing
 * new travels: filing a move writes the owner's correction, which travels as `corrections` (3.8) in its own format.
 *
 *   PERIODS, periodOf(value)            30, 90 or 365 days (30 by default)
 *   windowsOf(today, days, firstDay)    the period and the window of the same length just before it
 *   inflow(state, from, to, nowMs)      the one counting rule of money in (DESIGN G.2)
 *   inAndOut(state, nowMs, days)        money out, money in, their changes, paydays like with like, "filed by you"
 *   isCatchAll(tx), isFiled(...)        which moves file one at a time; which the owner filed
 *   moveQueue(state, nowMs)             the moves to file: posted spends and refunds of 90 days the owner has not filed
 *   fileItem(state, item, category, at, nowMs)   one tap: the transaction sheet's own save sequence
 *   whereItWent(state, nowMs, days)     spending by class and category, merchants, top merchants
 *   leaks(state, nowMs, days)           fees and interest, the daily game, small and often, doubled, price rises
 *   bookBills(state, today)             the Book's lines that are not subscriptions, by cost a month
 *
 * Seams for the later passes: the shared floor `flows.since` (pass 2) will bound the queue and every comparison where
 * `firstDay` is read here; deposits join the queue in pass 3 (moveQueue returns money out only); subscriptions, the
 * plan and leak 6 (still charging after a cut) need the `flows` section and are not here.
 *
 * Pure: no clock (every function that needs "now" takes nowMs), no DOM, no storage.
 */

import { ACCOUNT_TYPES, CADENCES, CATEGORIES, FLOW_CATEGORIES, KLASSES, klassOf } from './schema.js';
import { addDays, diffDays, isYmd } from './dates.js';
import { makeLedger } from './ledger.js';
import { confirmMove, correctionReach, learnRule, ruleMarkedReview, ruleOfRow, spendIndex } from './classify.js';
import { accountKeys, noteMove, rowWhere } from './corrections.js';
import { refresh } from './detect.js';
import { annualCost, nextOccurrence } from './book.js';
import { firstTransactionDay } from './cards.js';

/** The periods offered, in days; each is compared with the window of the same length just before it. */
export const PERIODS = Object.freeze([30, 90, 365]);
export const DEFAULT_PERIOD = 30;
/** The queue looks back this many days for money out. */
export const QUEUE_DAYS = 90;
/** Days in a month and in a year, for figures scaled from the period (always estimates). */
const MONTH_DAYS = 365.25 / 12;
const YEAR_DAYS = 365.25;
/** The order of the classes in "Where it went" (Analysis' order); Uncategorized has a group of its own, first. */
export const KLASS_ORDER = Object.freeze(['game', 'want', 'need', 'oneoff', 'book']);
export const UNFILED = 'other';
/** The group of a category that has no class of spending (none today; kept so the groups add up to the total). */
export const STRAY = 'stray';
/** Small and often: at least this many moves per 30 days, at a median of at most this many cents (decision 9). */
const SMALL_VISITS_PER_30 = 4;
const SMALL_MEDIAN_MAX = 2000;
const SMALL_NAMED = 3;
/** Getting to work, the car, health and cash taken out are needs however often they come: never "small and often". */
const NOT_SMALL_LEAKS = new Set(['transit', 'tolls_parking', 'fuel_auto', 'health', 'cash_withdrawal']);
/** The owner's most-filed categories offered as chips after the guess. */
const CHIP_COUNT = 3;
const TOP_MERCHANTS = 3;
const BILL_LINES = 6;

/**
 * Built-in rules whose key hides many sellers or purchases: a move filed by one of them files on its own (section 6,
 * as the review narrowed it). The `shopping` rule names single stores and Zelle names one person: neither is here.
 */
const CATCH_ALL_RULES = new Set(['builtin:amazon', 'builtin:big-box', 'builtin:ebay', 'builtin:marketplace', 'builtin:wallet-payment', 'builtin:cheque-bill-pay']);
/** A processor row's key, once the prefix is stripped, that names no shop: empty, or only the processor. */
const PROCESSOR_NAMES = new Set(['sq', 'square', 'gosq', 'gosq com', 'clover', 'sumup', 'zettle', 'izettle', 'stripe', 'paypal', 'pp', 'wpy', 'bt', 'in']);

/**
 * Families of services that do one job: generic sets of single-service built-in rule ids. A rule that covers many
 * services (apple-services, microsoft, google-subscription, google-play, streaming, music-streaming, news) is in no
 * family, so one Apple charge and one Google One charge are never "doubled".
 */
export const FAMILIES = Object.freeze({
  video: Object.freeze(['netflix', 'hulu', 'disney-plus', 'max', 'prime-video', 'youtube']),
  music: Object.freeze(['spotify']),
  storage: Object.freeze(['dropbox']),
  delivery: Object.freeze(['dashpass', 'uber-one', 'grubhub-plus']),
  news: Object.freeze(['nytimes']),
});
const FAMILY_OF = new Map(Object.entries(FAMILIES).flatMap(([family, ids]) => ids.map((id) => ['builtin:' + id, family])));
/** Built-in rules whose key covers many services or purchases: one such key on two accounts is not one service twice. */
const MULTI_SERVICE_RULES = new Set(['apple-services', 'microsoft', 'google-subscription', 'google-play', 'streaming', 'music-streaming', 'news',
  'games', 'tickets', 'cinema', 'audio-software', 'music-distribution', 'business-software'].map((id) => 'builtin:' + id));
/** The categories of a Book line that is a service, for "one service on two accounts". */
const SERVICE_CATEGORIES = new Set(['subscriptions', 'software', 'entertainment']);

/* ------------------------------------------------------------------- period */

/** A period from anything: 30, 90 or 365, else 30. */
export function periodOf(value) {
  const n = Number(value);
  return PERIODS.includes(n) ? n : DEFAULT_PERIOD;
}

/**
 * The period ending today and the window of the same length just before it. The comparison is made only when the
 * record covers the whole window before (`comparable`); `covered` is the number of the period's days on record, from
 * which figures "a month" and "a year" are scaled.
 * @param {string} today
 * @param {number} days
 * @param {string|null} firstDay  this device's first day on record (the shared floor comes in pass 2)
 */
export function windowsOf(today, days, firstDay) {
  const n = periodOf(days);
  const from = addDays(today, -(n - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -n);
  const first = isYmd(firstDay) ? firstDay : null;
  const covered = first === null || first > today ? 0 : first <= from ? n : diffDays(first, today) + 1;
  return { days: n, from, to: today, prevFrom, prevTo, firstDay: first, covered, comparable: first !== null && first <= prevFrom };
}

/** A figure of the period scaled to a month or a year (an estimate): 0 when no day of it is on record. */
export function perMonth(cents, covered) {
  return covered > 0 ? Math.round(cents * MONTH_DAYS / covered) : 0;
}
export function perYear(cents, covered) {
  return covered > 0 ? Math.round(cents * YEAR_DAYS / covered) : 0;
}

function ledgerOf(state, nowMs, opts) {
  return opts && typeof opts === 'object' && opts.ledger ? opts.ledger : makeLedger(state, nowMs);
}

/**
 * A counted move that has not posted: a pending row, or a move tapped in or reported that the bank has not shown. A
 * figure holding one is an estimate. (A row the bank sent is any row but the owner's own: the sample game's rows are
 * 'demo' rows on bank accounts, as the ledger reads them.)
 */
function isUnposted(tx) {
  return !!tx.pending || tx.source === 'manual';
}

/* ------------------------------------------------------------------ money in */

/**
 * The one counting rule of money in (DESIGN G.2), for every money-in figure on the page: bank deposits that count as
 * money in, plus payments the owner's other apps reported that no bank deposit has matched (in pencil, or cash). A
 * matched payment counts once, as its bank deposit. Refunds, transfers and card or loan payments never count.
 * @returns {{ total: number, bank: number, pencil: number, cash: number, unposted: boolean, rows: { tx: object, how: string }[] }}
 */
export function inflow(state, fromDay, toDay, nowMs, opts) {
  const found = ledgerOf(state, nowMs, opts).moneyIn(fromDay, toDay);
  return { ...found, unposted: found.rows.some(({ tx, how }) => how === 'bank' && tx.pending) };
}

/**
 * The paydays in a window's money in, source by source: for each pay stream, the days with a deposit linked to it and
 * what those deposits bring. Two payers paid on one day are two paydays, one of each.
 * @returns {Map<string, { count: number, cents: number }>}
 */
function paydaysOf(rows, payIds) {
  const byStream = new Map();
  for (const { tx, how } of rows) {
    if (how !== 'bank' || tx.streamId == null || !payIds.has(tx.streamId)) continue;
    const one = byStream.get(tx.streamId) || { days: new Set(), cents: 0 };
    one.days.add(tx.day);
    one.cents += Math.round(tx.amount);
    byStream.set(tx.streamId, one);
  }
  return new Map([...byStream].map(([id, one]) => [id, { count: one.days.size, cents: one.cents }]));
}

function countOf(paydays) {
  let n = 0;
  for (const one of paydays.values()) n += one.count;
  return n;
}

/* --------------------------------------------------------------- money out */

/** Spending in a window as "Where it went" counts it (spendingByCategory), and whether a move in it has not posted. */
function spentIn(ledger, fromDay, toDay) {
  const cents = ledger.spendingByCategory(fromDay, toDay).reduce((sum, row) => sum + row.amount, 0);
  const unposted = ledger.spendRows(fromDay, toDay).some(isUnposted);
  return { cents, unposted };
}

/** The merchant keys that hold a learned rule with a category that files: only their rows can be filed by a rule. */
function learnedKeys(state) {
  const keys = new Set();
  const rules = state && state.settings && Array.isArray(state.settings.rules) ? state.settings.rules : [];
  for (const rule of rules) if (rule && typeof rule.mkey === 'string' && isFileCategory(rule.category)) keys.add(rule.mkey);
  return keys;
}

/** A category that files a move: any but Uncategorized, which is what "Not yet filed" holds. */
function isFileCategory(category) {
  return typeof category === 'string' && category !== UNFILED && (Object.hasOwn(CATEGORIES, category) || Object.hasOwn(FLOW_CATEGORIES, category));
}

/**
 * Whether the owner filed a move: a category locked on it, or a learned rule that gives it its category (classify's
 * ruleOfRow, of its direction). Both travel (3.8); the `review` lock does not, so it decides nothing here. A move at
 * Uncategorized is never filed, whatever holds it there: it stays in the queue and in "Not yet filed", so the two
 * always agree.
 * @param {object} state
 * @param {object} tx
 * @param {Set<string>} [keys]  learnedKeys(state), when the caller asks about many rows
 * @param {Map|Function} [index]  classify's spendIndex(state), or a function that returns it, for the same reason
 */
export function isFiled(state, tx, keys, index) {
  if (!tx || typeof tx !== 'object' || tx.category === UNFILED) return false;
  if (Array.isArray(tx.locks) && tx.locks.includes('category')) return true;
  const learned = keys || learnedKeys(state);
  if (typeof tx.mkey !== 'string' || !learned.has(tx.mkey)) return false;
  const rule = ruleOfRow(state, tx, index);
  return !!rule && isFileCategory(rule.category);
}

/**
 * The share of the period's spending the owner filed, by amount: the bank's spends (refunds aside) that carry a
 * category lock or follow a learned rule, against every spend of the bank in the period. Null with no spend.
 */
function filedShareOf(state, ledger, fromDay, toDay) {
  const keys = learnedKeys(state);
  let all = 0;
  let filed = 0;
  for (const tx of ledger.spendRows(fromDay, toDay)) {
    if (tx.kind !== 'spend' || tx.flow === 'in' || tx.source === 'manual') continue;
    const amount = Math.round(tx.amount);
    all += amount;
    if (isFiled(state, tx, keys)) filed += amount;
  }
  return all > 0 ? filed / all : null;
}

/**
 * In and out for a period: money out (the period's spending) and money in (inflow), each with its change against the
 * window before when the record covers it. Paydays are compared like with like, source by source (DESIGN section 5):
 * when a pay stream has more paydays in the period than in the window before, or fewer, the change of money in leaves
 * that stream's difference out (its extra count times its mean a payday in this window, or in the window before when
 * this one holds none). One payer's extra payday never cancels another's missing one. Until sources exist, a payday is
 * a deposit linked to a detected pay stream.
 * @returns {object}  paydays: { now, before, extra, left, streams: [{ id, name, now, before, extra, left }] }, the
 *   counts summed over the streams, `extra` the sum of their extras, `streams` the ones paid in either window
 */
export function inAndOut(state, nowMs, days, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const w = windowsOf(ledger.today, days, firstTransactionDay(state));
  const out = spentIn(ledger, w.from, w.to);
  const moneyIn = inflow(state, w.from, w.to, nowMs, { ledger });
  const pay = ledger.payStreams();
  const payIds = new Set(pay.map((stream) => stream.id));
  const payNow = paydaysOf(moneyIn.rows, payIds);
  const result = {
    window: w,
    out: { cents: out.cents, est: out.unposted, before: null, change: null },
    in: { cents: moneyIn.total, bank: moneyIn.bank, pencil: moneyIn.pencil, cash: moneyIn.cash, est: moneyIn.unposted || moneyIn.pencil > 0, before: null, change: null },
    paydays: { now: countOf(payNow), before: null, extra: 0, left: 0, streams: [] },
    filed: filedShareOf(state, ledger, w.from, w.to),
  };
  if (!w.comparable) return result;
  const outBefore = spentIn(ledger, w.prevFrom, w.prevTo);
  const inBefore = inflow(state, w.prevFrom, w.prevTo, nowMs, { ledger });
  const payBefore = paydaysOf(inBefore.rows, payIds);
  const none = { count: 0, cents: 0 };
  const streams = [];
  let leftCents = 0;
  for (const stream of pay) {
    const now = payNow.get(stream.id) || none;
    const was = payBefore.get(stream.id) || none;
    if (!now.count && !was.count) continue;
    const extra = now.count - was.count;
    const mean = now.count > 0 ? now.cents / now.count : was.cents / was.count;
    const left = Math.round(extra * mean);
    leftCents += left;
    streams.push({ id: stream.id, name: typeof stream.name === 'string' ? stream.name : '', now: now.count, before: was.count, extra, left });
  }
  result.out.before = outBefore.cents;
  result.out.change = out.cents - outBefore.cents;
  result.in.before = inBefore.total;
  result.in.change = moneyIn.total - inBefore.total - leftCents;
  result.paydays = {
    now: countOf(payNow), before: countOf(payBefore), extra: streams.reduce((n, one) => n + one.extra, 0), left: leftCents, streams,
  };
  return result;
}

/* ------------------------------------------------------------------ the queue */

/** Whether a move files on its own: its key hides many sellers or purchases, or it has no key (section 6, App. D). */
export function isCatchAll(tx) {
  if (!tx || typeof tx.mkey !== 'string' || !tx.mkey) return true;
  if (CATCH_ALL_RULES.has(tx.ruleId)) return true;
  // a processor's row whose key, once the prefix is stripped, names no shop ("SQ *", "PAYPAL *"), whichever rule filed it
  return PROCESSOR_NAMES.has(tx.mkey);
}

/** A row the queue may hold (App. D): a live, posted bank spend or refund on a shown account, not frozen, in the days. */
function queueable(tx, accounts, fromDay, toDay) {
  if (!tx || typeof tx !== 'object' || tx.source === 'manual' || tx.pending || tx.matchId || tx.kind === 'decline') return false;
  if (tx.pairId != null || tx.streamId != null) return false;
  if ((tx.kind !== 'spend' && tx.kind !== 'refund') || !(tx.amount > 0) || !isYmd(tx.day) || tx.day < fromDay || tx.day > toDay) return false;
  const account = accounts.get(tx.accountId);
  return !!account && !account.hidden;
}

/** The queue's order: Uncategorized first, then moves the built-in rule marks for a look, then confident guesses. */
function tierOf(tx) {
  if (tx.category === UNFILED) return 0;
  return ruleMarkedReview(tx.ruleId) ? 1 : 2;
}

/** The owner's most-filed spending categories over the days, for one direction, most first (data that travels). */
function filedRanking(rows, filed) {
  const counts = { out: new Map(), in: new Map() };
  const spent = { out: new Map(), in: new Map() };
  for (const tx of rows) {
    if (!Object.hasOwn(CATEGORIES, tx.category) || tx.category === UNFILED) continue;
    const direction = tx.flow === 'in' ? 'in' : 'out';
    spent[direction].set(tx.category, (spent[direction].get(tx.category) || 0) + 1);
    if (filed.has(tx)) counts[direction].set(tx.category, (counts[direction].get(tx.category) || 0) + 1);
  }
  const ranked = (map) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([category]) => category);
  // the owner's filings first; when they are fewer than three (a new record, the sample game), the categories the
  // moves of the days carry most often fill the rest, so every device still offers the same chips
  const fill = (direction) => {
    const own = ranked(counts[direction]);
    return [...own, ...ranked(spent[direction]).filter((category) => !own.includes(category))];
  };
  return { out: fill('out'), in: fill('in') };
}

/**
 * The moves to file (DESIGN section 6 and Appendix D, money out): every posted spend or refund of the last 90 days on a
 * shown account that the owner has not filed (isFiled: no category lock, no learned rule; Uncategorized always). One
 * item per merchant key and direction; a catch-all move is an item of its own. Membership and order read only rows, the
 * owner's corrections (which travel) and the built-in rules, so two devices that show the same accounts hold the same
 * queue. The Board counts the queue on every render, so each row is asked once whether it is filed, and the live spends
 * by merchant (which tell a refund's rule) are indexed at most once a call, when first needed, never kept between calls
 * (the record is edited in place).
 * @param {object} state
 * @param {number} nowMs
 * @param {{ ledger?: object, spendIndex?: (state: object) => Map }} [opts]  a ledger already made; `spendIndex` the
 *   builder of that index (classify's, by default; a test counts its calls)
 * @returns {{ items: object[], out: number, moves: number, from: string, to: string }}
 *   an item: { key, direction, mkey, merchant, guess, chips, txId, count, amount, last, tier, catchAll, refunds }, `refunds`
 *   the merchant's refunds a one tap on its money-out item files too (they follow its rule, 3.3)
 */
export function moveQueue(state, nowMs, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const to = ledger.today;
  const from = addDays(to, -(QUEUE_DAYS - 1));
  const hidden = new Map((Array.isArray(state.accounts) ? state.accounts : []).filter((a) => a && a.id).map((a) => [a.id, a]));
  const keys = learnedKeys(state);
  const fingerprints = accountKeys(state);
  const build = opts && typeof opts === 'object' && typeof opts.spendIndex === 'function' ? opts.spendIndex : spendIndex;
  let index = null;
  const spends = () => index || (index = build(state));
  const rows = (Array.isArray(state.txs) ? state.txs : []).filter((tx) => queueable(tx, hidden, from, to));
  const filed = new Set(rows.filter((tx) => isFiled(state, tx, keys, spends)));
  const ranking = filedRanking(rows, filed);
  // an item's latest move gives its name, guess and tier. On one day, the move whose place in the bank's record sorts
  // last (rowWhere's key, the same on every device), then the larger amount, then the bank's text: never the row id,
  // which each device draws at random, so every device shows the same guess, tier and order
  const placeOf = (tx) => { const where = rowWhere(tx, fingerprints); return where ? where.key : ''; };
  const laterThan = (a, b) => {
    if (a.day !== b.day) return a.day > b.day;
    const pa = placeOf(a);
    const pb = placeOf(b);
    if (pa !== pb) return pa > pb;
    const ca = Math.round(a.amount);
    const cb = Math.round(b.amount);
    if (ca !== cb) return ca > cb;
    return String(a.raw || '') > String(b.raw || '');
  };
  const byKey = new Map();
  const latest = new Map();
  for (const tx of rows) {
    if (filed.has(tx)) continue;
    const direction = tx.flow === 'in' ? 'in' : 'out';
    const catchAll = isCatchAll(tx);
    const where = catchAll ? rowWhere(tx, fingerprints) : null;
    const key = catchAll ? 'move:' + (where ? where.key : tx.id) : direction + ':' + tx.mkey;
    let item = byKey.get(key);
    if (!item) {
      item = { key, direction, mkey: tx.mkey || '', merchant: '', guess: UNFILED, chips: [], txId: tx.id, count: 0, amount: 0, last: '', tier: 2, catchAll, refunds: 0 };
      byKey.set(key, item);
    }
    item.count += 1;
    item.amount += Math.round(tx.amount);
    const was = latest.get(key);
    if (!was || laterThan(tx, was)) {
      latest.set(key, tx);
      item.last = tx.day;
      item.txId = tx.id;
      item.merchant = typeof tx.merchant === 'string' && tx.merchant ? tx.merchant : tx.mkey || '';
      item.guess = Object.hasOwn(CATEGORIES, tx.category) ? tx.category : UNFILED;
      item.tier = tierOf(tx);
    }
  }
  // a merchant's refunds follow its money-out rule unless it keeps one for money in (3.3): an item for money out that
  // a refund item of the same merchant waits beside says so, and its one tap files those refunds too
  for (const item of byKey.values()) {
    if (item.direction !== 'out' || item.catchAll || !byKey.has('in:' + item.mkey)) continue;
    const reach = correctionReach(state, latest.get(item.key), spends);
    item.refunds = reach.kept ? 0 : reach.refunds;
  }
  const items = [...byKey.values()].sort((a, b) => a.tier - b.tier || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || (a.key < b.key ? -1 : 1));
  for (const item of items) {
    const offered = item.guess !== UNFILED ? [item.guess] : [];
    for (const category of ranking[item.direction]) {
      if (offered.length >= CHIP_COUNT + (item.guess !== UNFILED ? 1 : 0)) break;
      if (!offered.includes(category)) offered.push(category);
    }
    item.chips = offered;
  }
  return { items, out: items.filter((item) => item.direction === 'out').length, moves: items.reduce((n, item) => n + item.count, 0), from, to };
}

/**
 * The class a filing passes with a category the move already has (its guess confirmed): the class the rules gave the
 * move, when it is not the category's own (a parking fine is One-off, though Tolls and parking is Necessary). A category
 * passed alone brings its own class to the move and to every move of the merchant, and the rule would hold it there.
 * Null when the class follows the category anyway, or is not the rules' to pass: a line of the Book, or a class the
 * owner set on this move.
 * @param {object} tx
 * @param {string} category  the category passed
 * @returns {string|null}
 */
export function confirmedKlass(tx, category) {
  if (!tx || category !== tx.category || !Object.hasOwn(CATEGORIES, category) || !Object.hasOwn(KLASSES, tx.klass)) return null;
  if (tx.recurringId != null || (Array.isArray(tx.locks) && tx.locks.includes('klass'))) return null;
  return tx.klass !== klassOf(category) ? tx.klass : null;
}

/**
 * One tap of the queue: the transaction sheet's own save sequence on the item's latest move (learnRule, noteMove,
 * confirmMove, then refresh), the category always passed, so the filing is a correction and the move leaves the queue
 * on every device; a guess confirmed keeps its class (confirmedKlass). A merchant files for the whole merchant in that
 * direction, past and future; a catch-all files this move only. Uncategorized files nothing. Call it inside one
 * undoable store.update.
 * @param {object} state  (mutated)
 * @param {{ txId: string, catchAll: boolean }} item
 * @param {string} category  a spending category
 * @param {number} at  the moment of the tap: the correction's stamp
 * @param {number} nowMs
 * @returns {{ changed: number, ruleId: string|null, filed: boolean }}
 */
export function fileItem(state, item, category, at, nowMs) {
  const tx = item && Array.isArray(state.txs) ? state.txs.find((t) => t && t.id === item.txId) : null;
  if (!tx || !Object.hasOwn(CATEGORIES, category) || category === UNFILED) return { changed: 0, ruleId: null, filed: false };
  const fields = { category };
  const klass = confirmedKlass(tx, category);
  if (klass) fields.klass = klass;
  const result = learnRule(state, tx.id, fields, { onlyThis: !!item.catchAll });
  noteMove(state, tx.id, at);
  confirmMove(state, tx.id);
  refresh(state, nowMs);
  return { ...result, filed: isFiled(state, tx) };
}

/* ------------------------------------------------------------- where it went */

/**
 * Where the money went in a period: by class, then category, each with its share of the period's spending and its
 * change against the window before (when the record covers it); Uncategorized as a group of its own. Each category
 * holds its merchants (ledger.spendingByMerchant, counted as spendingByCategory counts). Categories with a monthly
 * target and no spending keep a row, so the target stays in reach.
 */
export function whereItWent(state, nowMs, days, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const w = windowsOf(ledger.today, days, firstTransactionDay(state));
  const now = ledger.spendingByCategory(w.from, w.to);
  const before = w.comparable ? ledger.spendingByCategory(w.prevFrom, w.prevTo) : [];
  const merchants = ledger.spendingByMerchant(w.from, w.to);
  const unposted = new Set(ledger.spendRows(w.from, w.to).filter(isUnposted).map((tx) => tx.category || UNFILED));
  const total = now.reduce((sum, row) => sum + row.amount, 0);
  const totalBefore = before.reduce((sum, row) => sum + row.amount, 0);
  const rows = new Map();
  const row = (category) => {
    if (!rows.has(category)) {
      rows.set(category, { category, klass: klassOf(category), amount: 0, count: 0, before: w.comparable ? 0 : null, change: null, share: 0, est: unposted.has(category), merchants: [] });
    }
    return rows.get(category);
  };
  for (const one of now) Object.assign(row(one.category), { amount: one.amount, count: one.count });
  for (const one of before) row(one.category).before = one.amount;
  const targets = state.settings && state.settings.targets && typeof state.settings.targets === 'object' ? state.settings.targets : {};
  for (const category of Object.keys(targets)) if (Object.hasOwn(CATEGORIES, category) && Number.isFinite(targets[category])) row(category);
  // merchants only under a category the period counts (spendingByCategory's own rows): a category kept at $0.00, whose
  // refunds outweigh its spends, lists none, so a category's merchants always add up to it
  const counted = new Set(now.map((one) => one.category));
  for (const one of merchants) if (counted.has(one.category) && rows.has(one.category)) rows.get(one.category).merchants.push(one);
  for (const one of rows.values()) {
    one.share = total > 0 && one.amount > 0 ? one.amount / total : 0;
    if (w.comparable) one.change = one.amount - one.before;
  }
  const order = (a, b) => b.amount - a.amount || (a.category < b.category ? -1 : 1);
  // Uncategorized first, then the classes; a category of no class (none today) in a group of its own, last, so the
  // groups always add up to the total
  const inGroup = (klass, one) => (klass === UNFILED ? one.category === UNFILED
    : klass === STRAY ? one.category !== UNFILED && !KLASS_ORDER.includes(one.klass)
      : one.category !== UNFILED && one.klass === klass);
  const groups = [UNFILED, ...KLASS_ORDER, STRAY].map((klass) => {
    const list = [...rows.values()].filter((one) => inGroup(klass, one)).sort(order);
    const amount = list.reduce((sum, one) => sum + one.amount, 0);
    const was = w.comparable ? list.reduce((sum, one) => sum + (one.before || 0), 0) : null;
    return { klass, rows: list, amount, before: was, change: w.comparable ? amount - was : null, est: list.some((one) => one.est) };
  }).filter((group) => group.rows.length);
  // the top merchants of the period, the Book's lines aside (they have a section of their own)
  const byMerchant = new Map();
  for (const one of merchants) {
    if (one.klass === 'book' || !one.mkey || one.amount <= 0) continue;
    const had = byMerchant.get(one.mkey) || { mkey: one.mkey, merchant: one.merchant, amount: 0, count: 0, est: false };
    had.amount += one.amount;
    had.count += one.count;
    // a figure holding a pending row or a move tapped in is an estimate, as its category's is
    if (one.est) had.est = true;
    byMerchant.set(one.mkey, had);
  }
  const top = [...byMerchant.values()].sort((a, b) => b.amount - a.amount || (a.mkey < b.mkey ? -1 : 1)).slice(0, TOP_MERCHANTS);
  const cash = rows.has('cash_withdrawal') ? rows.get('cash_withdrawal').amount : 0;
  return {
    window: w, total, before: w.comparable ? totalBefore : null, change: w.comparable ? total - totalBefore : null,
    est: unposted.size > 0, groups, top, cash,
  };
}

/* ------------------------------------------------------------------- leaks */

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The bank's charges linked to each Book entry, oldest first, as the ledger counts them: never a row on a hidden
 * account, and a pending row only while pending rows count (settings.countPending).
 */
function chargesByEntry(state) {
  const byEntry = new Map();
  const hidden = new Set((Array.isArray(state.accounts) ? state.accounts : []).filter((a) => a && a.hidden).map((a) => a.id));
  const settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
  const countPending = settings.countPending === undefined ? true : !!settings.countPending;
  for (const tx of Array.isArray(state.txs) ? state.txs : []) {
    if (!tx || tx.recurringId == null || tx.kind === 'decline' || tx.matchId || tx.source === 'manual' || tx.flow === 'in' || !isYmd(tx.day) || !(tx.amount > 0)) continue;
    if (hidden.has(tx.accountId) || (tx.pending && !countPending)) continue;
    const list = byEntry.get(tx.recurringId);
    if (list) list.push(tx);
    else byEntry.set(tx.recurringId, [tx]);
  }
  for (const list of byEntry.values()) list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return byEntry;
}

function activeBook(state) {
  return (Array.isArray(state.recurring) ? state.recurring : []).filter((rec) => rec && rec.active && typeof rec.id === 'string'
    && Object.hasOwn(CADENCES, rec.cadence) && Number.isFinite(rec.amount) && rec.amount >= 0);
}

/**
 * The leaks of a period (Appendix B, rules 1 to 5). Each holds the period's figure and ≈ a year; they overlap in
 * places, so they are never added up. Rule 6, still charging after a cut, needs the verdict's day, which travels with
 * the `flows` section of pass 2.
 * @returns {{ window: object, fees: object|null, game: object|null, small: object|null, doubled: object[], rises: object[] }}
 */
export function leaks(state, nowMs, days, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const w = windowsOf(ledger.today, days, firstTransactionDay(state));
  const rows = ledger.spendRows(w.from, w.to);
  const signed = (tx) => (tx.flow === 'in' ? -1 : 1) * Math.round(tx.amount);
  const unposted = isUnposted;
  const year = (cents) => perYear(cents, w.covered);

  // 1. fees and interest, net of reversals, by the rule's merchant label; avoidable penalties carry ??
  const feeRows = rows.filter((tx) => tx.category === 'fees_interest');
  let fees = null;
  if (feeRows.length) {
    const parts = new Map();
    for (const tx of feeRows) {
      // the rule's merchant label; '' for a fee with none (the view names it in its words)
      const label = typeof tx.merchant === 'string' && tx.merchant ? tx.merchant : '';
      const part = parts.get(label) || { label, cents: 0, penalty: false };
      part.cents += signed(tx);
      if (tx.glyph === '??' && tx.flow !== 'in') part.penalty = true;
      parts.set(label, part);
    }
    const cents = feeRows.reduce((sum, tx) => sum + signed(tx), 0);
    const list = [...parts.values()].filter((part) => part.cents !== 0).sort((a, b) => b.cents - a.cents || (a.label < b.label ? -1 : 1));
    if (cents > 0) fees = { cents, year: year(cents), est: feeRows.some(unposted), parts: list, penalty: list.some((part) => part.penalty) };
  }

  // 2. the daily game: the class judged in the daily round, its stops and the mean a stop, and the change
  const gameOf = (list) => list.filter((tx) => tx.klass === 'game');
  const gameRows = gameOf(rows);
  let game = null;
  if (gameRows.length) {
    const cents = gameRows.reduce((sum, tx) => sum + signed(tx), 0);
    const stops = gameRows.filter((tx) => tx.kind === 'spend').length;
    const was = w.comparable ? gameOf(ledger.spendRows(w.prevFrom, w.prevTo)).reduce((sum, tx) => sum + signed(tx), 0) : null;
    if (cents > 0) game = { cents, year: year(cents), stops, mean: stops ? Math.round(cents / stops) : 0, change: was === null ? null : cents - was, est: gameRows.some(unposted) };
  }

  // 3. small and often: merchants outside the daily game, the Book, fees and the needs of NOT_SMALL_LEAKS, at least 4
  // moves per 30 days at a median of $20 or less
  const byMerchant = new Map();
  for (const tx of rows) {
    if (tx.klass === 'game' || klassOf(tx.category) === 'game' || tx.klass === 'book' || klassOf(tx.category) === 'book' || tx.recurringId != null) continue;
    if (tx.category === 'fees_interest' || NOT_SMALL_LEAKS.has(tx.category) || typeof tx.mkey !== 'string' || !tx.mkey) continue;
    const one = byMerchant.get(tx.mkey) || { mkey: tx.mkey, merchant: '', last: '', amounts: [], cents: 0, est: false };
    one.cents += signed(tx);
    if (tx.kind === 'spend') one.amounts.push(Math.round(tx.amount));
    if (tx.day >= one.last) { one.last = tx.day; one.merchant = tx.merchant || tx.mkey; }
    if (unposted(tx)) one.est = true;
    byMerchant.set(tx.mkey, one);
  }
  // 4 a month at the period's rate, and never fewer than 4 however short the record: one visit is not "often"
  const least = Math.max(SMALL_VISITS_PER_30, SMALL_VISITS_PER_30 * w.covered / 30);
  const often = [...byMerchant.values()].filter((one) => one.amounts.length >= least && one.cents > 0 && median(one.amounts) <= SMALL_MEDIAN_MAX)
    .sort((a, b) => b.amounts.length - a.amounts.length || b.cents - a.cents || (a.mkey < b.mkey ? -1 : 1));
  const smallCents = often.reduce((sum, one) => sum + one.cents, 0);
  const small = often.length ? {
    cents: smallCents, year: year(smallCents), est: often.some((one) => one.est),
    named: often.slice(0, SMALL_NAMED).map((one) => ({ merchant: one.merchant, count: one.amounts.length })), count: often.length,
  } : null;

  // 4. doubled: lines of two or more services of one family, or one service active on two accounts; Keep on every line
  // silences it. Only a service counts as one (a subscription, software, entertainment), and never a key a built-in rule
  // of many services files: interest on two cards, or two Apple charges, are not one service twice
  const book = activeBook(state);
  const charges = chargesByEntry(state);
  const inPeriod = (rec) => (charges.get(rec.id) || []).filter((tx) => tx.day >= w.from && tx.day <= w.to);
  const families = new Map();
  const keysOn = new Map();
  for (const rec of book) {
    const list = charges.get(rec.id) || [];
    const latest = list[list.length - 1];
    const family = latest ? FAMILY_OF.get(latest.ruleId) : undefined;
    if (family) families.set(family, [...(families.get(family) || []), rec]);
    const service = SERVICE_CATEGORIES.has(rec.category) && !(latest && MULTI_SERVICE_RULES.has(latest.ruleId));
    if (service && typeof rec.mkey === 'string' && rec.mkey) keysOn.set(rec.mkey, [...(keysOn.get(rec.mkey) || []), rec]);
  }
  // a family doubles only with two services in it; one service on two accounts is told as that, below
  for (const [family, lines] of families) if (new Set(lines.map((rec) => rec.mkey)).size < 2) families.delete(family);
  const doubled = [];
  const group = (kind, name, lines, accounts = 0) => {
    if (lines.length < 2 || lines.every((rec) => rec.verdict === 'keep')) return;
    const cents = lines.reduce((sum, rec) => sum + inPeriod(rec).reduce((n, tx) => n + Math.round(tx.amount), 0), 0);
    const est = lines.some((rec) => inPeriod(rec).some(isUnposted));
    doubled.push({ kind, name, lines: lines.map((rec) => ({ id: rec.id, name: rec.name || rec.mkey })), accounts, cents, est, year: lines.reduce((sum, rec) => sum + annualCost(rec), 0) });
  };
  for (const [family, lines] of [...families].sort((a, b) => (a[0] < b[0] ? -1 : 1))) group('family', family, lines);
  for (const [mkey, lines] of [...keysOn].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const accounts = new Set(lines.map((rec) => rec.accountId).filter((id) => id != null));
    if (accounts.size >= 2) group('accounts', lines[0].name || mkey, lines, accounts.size);
  }

  // 5. price rises: a steady line (its two charges before the latest at one level) whose latest charge is above that
  // level, the change dated inside the period; read from the line's linked charges
  const rises = [];
  for (const rec of book) {
    if (rec.variable) continue;
    const list = charges.get(rec.id) || [];
    if (list.length < 3) continue;
    const latest = list[list.length - 1];
    const before = list[list.length - 2];
    if (Math.round(list[list.length - 3].amount) !== Math.round(before.amount)) continue;
    const step = Math.round(latest.amount) - Math.round(before.amount);
    if (step <= 0 || latest.day < w.from || latest.day > w.to) continue;
    const times = CADENCES[rec.cadence].perYear;
    // a rise read from a charge still pending is an estimate (italic with ≈)
    const est = [list[list.length - 3], before, latest].some((one) => !!one.pending);
    rises.push({ id: rec.id, name: rec.name || rec.mkey, from: Math.round(before.amount), to: Math.round(latest.amount), step, day: latest.day, year: Math.round(step * times), est });
  }
  rises.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || (a.id < b.id ? -1 : 1));

  return { window: w, fees, game, small, doubled, rises };
}

/* ----------------------------------------------------------- the Book's bills */

/** The Book's lines that are no bill here: subscriptions (pass 2), card and loan payments, transfers and interest. */
const NOT_BILLS = new Set(['subscriptions', 'card_payment', 'transfer', 'debt_service', 'fees_interest']);
/** The account groups a payment pays down. */
const DEBT_GROUPS = new Set(['card', 'debt']);

/**
 * The Book's lines that are not subscriptions (those come with the repertoire in pass 2), by cost a month: neither a
 * line filed as Subscriptions nor a card or loan payment, a transfer, a payment to a card or a loan, nor interest
 * (told under Fees and interest). The amount is the bank's last charge (roman) unless it varies or was entered by hand
 * and has not been charged yet (an estimate).
 * @returns {{ perMonth: number, count: number, lines: object[] }}
 */
export function bookBills(state, today) {
  const charges = chargesByEntry(state);
  const debts = new Set((Array.isArray(state.accounts) ? state.accounts : []).filter((a) => a && ACCOUNT_TYPES[a.type] && DEBT_GROUPS.has(ACCOUNT_TYPES[a.type].group)).map((a) => a.id));
  const lines = activeBook(state)
    // a payment to a card or a loan pays for what was already counted or owned: it is no bill; nor is interest, which
    // the leaks tell under Fees and interest
    .filter((rec) => !NOT_BILLS.has(rec.category) && !(rec.toAccountId != null && debts.has(rec.toAccountId)))
    .map((rec) => {
      const list = charges.get(rec.id) || [];
      const last = list.length ? list[list.length - 1].day : null;
      let next = nextOccurrence(rec, addDays(today, -1));
      if (next && last && last >= next) next = nextOccurrence(rec, next);
      return {
        id: rec.id, name: rec.name || rec.mkey || '', amount: Math.round(rec.amount), cadence: rec.cadence, next,
        perMonth: Math.round(annualCost(rec) / 12), est: !!rec.variable || !list.length, variable: !!rec.variable, byHand: rec.byHand === true,
      };
    })
    .sort((a, b) => b.perMonth - a.perMonth || (a.name < b.name ? -1 : 1));
  return { perMonth: lines.reduce((sum, line) => sum + line.perMonth, 0), count: lines.length, lines: lines.slice(0, BILL_LINES) };
}
