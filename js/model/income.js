/**
 * Income that the owner's other apps report (ARCHITECTURE 3.7). Another app of the owner writes the
 * payments it records as JSON files into the folder `income/` of the private repository; every device
 * reads them. This module is pure: the file check, how each payment was paid, which bank row confirms a
 * payment sent by transfer, the moves the payments become, Cash in hand, the questions and the answers.
 *
 *   readIncomeFile(text, nowMs)            { ok, what, payers, items } | { ok: false, problem }
 *   sourceIdOf(fileName)                   'name' for 'name.json', else null
 *   applyIncomeReading(state, reading, nowMs)  stores what a reading of income/ brought, then rebuilds
 *   rebuildIncome(state, nowMs)            the payments' moves, from (sources, shared answers, bank rows)
 *   howOf(shared, since, source, item)     'history' | 'bank' | 'ask' | 'cash' | 'gone'
 *   matchIncome(rows, payments)            Map(payment key -> bank row id), from the inputs alone: one pass for every
 *                                          claimant (open, history, and those that follow a payer's cash answer)
 *   incomeQuestions(state, nowMs)          { payers, late, confirm }
 *   rowPayments(state, rowId)              the payments a bank row confirms, each with its own answer
 *   answerPayer / answerItems / countCash / removeCount   the owner's answers and counts (shared, 3.5); never undone
 *   askAgain(state, source, itemId, nowMs) takes back a payment's own answer (a cleared answer that travels)
 *   readIncomeShared / mergeIncomeShared   the `income` section of the shared file
 *
 * Every example in the tests is invented. Nothing here reads the clock: "now" is passed in.
 */

import { ACCOUNT_TYPES, makeAccount, makeTx } from './schema.js';
import { addDays, gameDay, isYmd } from './dates.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

export const INCOME_FORMAT = 'income/1';
/** A file larger than this (bytes) is refused. */
export const INCOME_MAX_BYTES = 1000000;
const MAX_PAYERS = 500;
const MAX_ITEMS = 5000;
const MAX_CENTS = 100000000;
const WHAT_MAX = 40;
const NAME_MAX = 60;
const EARLIEST_MS = Date.UTC(2000, 0, 1);
const AHEAD_MS = 2 * DAY_MS;
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** `since` is the first valid reading of a device less this. */
export const SINCE_BACK_MS = 7 * DAY_MS;
/** A payment sent by transfer that no bank row has met this long after it was marked is asked about. */
export const LATE_MS = 96 * HOUR_MS;
/** "Still coming" asks again after this. */
export const WAIT_MS = 4 * DAY_MS;

const MATCH_BEFORE_DAYS = 10;
/** A row may lie at most this many days before the session's own day (or the marked day, for a session paid ahead). */
const SESSION_BEFORE_DAYS = 3;
const MATCH_AFTER_DAYS = 30;
const GROUP_SPAN_DAYS = 21;
const GROUP_MIN = 2;
const GROUP_MAX = 6;
/** How much searching one bank row may take when it pays several payments at once. */
const GROUP_STEPS = 20000;
const ACCOUNT_WINDOW_DAYS = 120;

/**
 * Limits of the shared answers, budgeted by size against GitHub's Contents API, which returns a file's content only up
 * to 1 MB (above it the file is read by its sha from the blob API, github.js). The income section with every answer
 * and count at its limit, the longest keys (161 characters) and the largest stamps, is about 350,000 bytes. With 200
 * payments by hand of 13 ticks each and no skips, and 1,000 removals, the longest names and ids, the shared file stays
 * under 950,000 bytes (tests/income5: about 760,000). That assumes the payments by hand: they are not bounded here
 * (each may hold up to 400 ticks and 400 skips), so a record far heavier than that goes over 1 MB.
 * These limits are the only bound on the income section: at a limit the oldest stamps go (then by key), the same on
 * every device.
 */
export const MAX_PAYER_ANSWERS = 300;
export const MAX_ITEM_ANSWERS = 1000;
/** The owner's counts of Cash in hand (removals included): at most 200, the latest edited kept. */
export const MAX_COUNTS = 200;
const MAX_KEY = 170;
/** A source the folder's listing leaves out is dropped once it has been missed this long (a listing can miss it). */
const MISSED_MS = 24 * HOUR_MS;
const MAX_STAMP = 1e14;
const MAX_COUNT = 1e10;
/** The largest count of Cash in hand, in cents ($100,000,000.00). */
export const COUNT_MAX_CENTS = MAX_COUNT;
/** A file refused for a rule that depends on the time (a payment ahead of the clock) is checked again after this. */
export const RECHECK_MS = HOUR_MS;

/** The hand-kept account that holds cash payments (ARCHITECTURE 3.7). */
export const CASH_ROLE = 'cash-in-hand';
export const CASH_NAME = 'Cash in hand';
const CASH_ID = 'acc_cash_in_hand';

/** `none` is a cleared answer (Ask again): every reader treats it as no answer, and it can win the merge. */
const PAYER_HOWS = new Set(['bank', 'cash', 'none']);
const ITEM_HOWS = new Set(['bank', 'cash', 'gone', 'wait', 'none']);

/* --------------------------------------------------------------- the file */

/**
 * Check one file of income/ (untrusted). Any failure refuses the whole file, in plain words.
 * @param {string} text
 * @param {number} nowMs
 * `writtenAt` (when the other app wrote the file) is read leniently: null when it is missing or not a time, never a
 * reason to refuse. A refusal that depends on the time (a payment ahead of the clock) says so with `timed`.
 * @returns {{ ok: true, what: string, writtenAt: number|null, payers: {id: string, name: string}[], items: {id: string, payer: string, cents: number, day: string, at: number}[] } | { ok: false, problem: string, timed?: boolean }}
 */
export function readIncomeFile(text, nowMs) {
  const no = (problem) => ({ ok: false, problem });
  if (typeof text !== 'string') return no('The file could not be read.');
  if (utf8Length(text) > INCOME_MAX_BYTES) return no('The file is larger than 1 MB.');
  let raw;
  try { raw = JSON.parse(text); } catch { return no('The file is not JSON.'); }
  if (!isObject(raw)) return no('The file is not a list of payments.');
  if (raw.format !== INCOME_FORMAT) return no('The file is not in the format ' + INCOME_FORMAT + '.');
  const what = typeof raw.what === 'string' ? raw.what.trim() : '';
  if (what.length < 1 || what.length > WHAT_MAX) return no('The label of a payment is missing or longer than 40 characters.');
  if (!Array.isArray(raw.payers)) return no('The file has no list of payers.');
  if (raw.payers.length > MAX_PAYERS) return no('The file lists more than 500 payers.');
  const payers = [];
  const payerIds = new Set();
  for (const p of raw.payers) {
    if (!isObject(p) || !isId(p.id)) return no('A payer has no usable id.');
    if (payerIds.has(p.id)) return no('Two payers share one id.');
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (name.length < 1 || name.length > NAME_MAX) return no('A payer\'s name is missing or longer than 60 characters.');
    payerIds.add(p.id);
    payers.push({ id: p.id, name });
  }
  if (!Array.isArray(raw.items)) return no('The file has no list of payments.');
  if (raw.items.length > MAX_ITEMS) return no('The file lists more than 5000 payments.');
  const written = isoMs(raw.writtenAt);
  const writtenAt = Number.isFinite(written) && written >= 0 && written <= MAX_STAMP ? written : null;
  // `from` (optional): the other app lists only the payments marked since then; checked like `at`, and never after now
  let from = null;
  if (raw.from !== undefined) {
    from = isoMs(raw.from);
    if (!Number.isFinite(from)) return no('The time the list starts from is not a time.');
    if (from < EARLIEST_MS) return no('The list starts before 2000.');
    if (writtenAt !== null && from > writtenAt) return no('The list starts after the file was written.');
    if (from > nowMs) return { ...no('The list starts after now.'), timed: true };
  }
  const items = [];
  const itemIds = new Set();
  for (const it of raw.items) {
    if (!isObject(it) || !isId(it.id)) return no('A payment has no usable id.');
    if (itemIds.has(it.id)) return no('Two payments share one id.');
    if (typeof it.payer !== 'string' || !payerIds.has(it.payer)) return no('A payment names a payer the file does not list.');
    if (!Number.isInteger(it.cents) || it.cents < 1 || it.cents > MAX_CENTS) return no('A payment\'s amount is not whole cents from $0.01 to $1,000,000.00.');
    if (typeof it.day !== 'string' || !isYmd(it.day)) return no('A payment\'s date is not a date.');
    const at = isoMs(it.at);
    if (!Number.isFinite(at)) return no('A payment\'s time is not a time.');
    if (at < EARLIEST_MS) return no('A payment is marked before 2000.');
    if (at > nowMs + AHEAD_MS) return { ...no('A payment is marked more than 2 days ahead.'), timed: true };
    // a payment below the file's own floor contradicts it
    if (from !== null && at < from) return no('A payment is marked before the time the list starts from.');
    itemIds.add(it.id);
    items.push({ id: it.id, payer: it.payer, cents: it.cents, day: it.day, at });
  }
  return { ok: true, what, writtenAt, from, payers, items };
}

/** The source id of a file of income/: its name without `.json`, when that is a usable id. */
export function sourceIdOf(fileName) {
  if (typeof fileName !== 'string' || !fileName.endsWith('.json')) return null;
  const id = fileName.slice(0, -5);
  return isId(id) ? id : null;
}

/* ------------------------------------------------------------- the record */

function blankShared() {
  return { since: null, payers: {}, items: {}, counts: [] };
}

/** The income part of the document, made when missing. */
export function ensureIncome(state) {
  if (!isObject(state.income)) state.income = {};
  const inc = state.income;
  if (!isObject(inc.sources)) inc.sources = {};
  if (!(inc.firstReadAt === null || Number.isFinite(inc.firstReadAt))) inc.firstReadAt = null;
  if (inc.firstReadAt === undefined) inc.firstReadAt = null;
  if (!isObject(inc.shared)) inc.shared = blankShared();
  const shared = inc.shared;
  if (!(shared.since === null || isStamp(shared.since))) shared.since = null;
  if (!isObject(shared.payers)) shared.payers = {};
  if (!isObject(shared.items)) shared.items = {};
  if (!Array.isArray(shared.counts)) shared.counts = [];
  delete shared.cash;
  return inc;
}

/** Read-only view of the income part, whatever the document holds. */
export function incomeOf(state) {
  const inc = isObject(state) && isObject(state.income) ? state.income : {};
  const shared = readIncomeShared(inc.shared) || keptShared(inc.shared);
  return {
    sources: isObject(inc.sources) ? inc.sources : {},
    firstReadAt: Number.isFinite(inc.firstReadAt) ? inc.firstReadAt : null,
    shared,
  };
}

/**
 * Store what one reading of income/ brought, then rebuild the payments' moves.
 * `reading.listed` is every source the folder holds ({ source, sha }); `reading.files` the files fetched
 * because their sha changed ({ [source]: { sha, text } }). A source the listing leaves out is kept, and
 * when it was first missed is recorded; once it has been missed for 24 hours it is dropped with all it
 * made. A file that fails the check keeps the last good copy and records the problem.
 * @param {object} state  (mutated)
 * @param {{ listed: {source: string, sha: string}[], files: Object<string, {sha: string, text: string}> }} reading
 * @param {number} nowMs
 * @returns {{ changed: boolean }}
 */
export function applyIncomeReading(state, reading, nowMs) {
  const before = canon(state.income === undefined ? null : state.income) + '|' + canon(listOf(state.txs).filter(isIncomeMove));
  const inc = ensureIncome(state);
  const listed = new Map();
  for (const one of listOf(reading && reading.listed)) {
    if (isObject(one) && isId(one.source) && typeof one.sha === 'string') listed.set(one.source, one.sha);
  }
  for (const source of Object.keys(inc.sources)) {
    const one = inc.sources[source];
    if (!isObject(one)) delete inc.sources[source];
    else if (listed.has(source)) delete one.missedAt;
    else if (!Number.isFinite(one.missedAt)) one.missedAt = nowMs;
    else if (nowMs - one.missedAt >= MISSED_MS) delete inc.sources[source];
  }
  const files = isObject(reading && reading.files) ? reading.files : {};
  for (const source of [...listed.keys()].sort()) {
    const got = Object.hasOwn(files, source) ? files[source] : null;
    if (!isObject(got)) continue;
    const sha = listed.get(source);
    // a reading that brought no text says nothing about the file: it is read again later, like a refusal in time
    const checked = got.tooLarge ? { ok: false, problem: 'The file is larger than 1 MB.' }
      : typeof got.text === 'string' ? readIncomeFile(got.text, nowMs) : { ok: false, problem: 'The file could not be read.', timed: true };
    const had = isObject(inc.sources[source]) ? inc.sources[source] : null;
    // a refusal of the file itself is remembered by its sha; one that depends on the time only until `recheckAt`
    const recheckAt = checked.timed ? nowMs + RECHECK_MS : null;
    if (checked.ok) {
      // the file is the whole list: a payment it no longer lists, below its floor or not, is forgotten
      inc.sources[source] = { sha, readAt: nowMs, writtenAt: checked.writtenAt, from: checked.from, what: checked.what, payers: checked.payers, items: checked.items,
        problem: null, badSha: null, recheckAt: null, checkedAt: nowMs };
      if (inc.firstReadAt === null) inc.firstReadAt = nowMs;
    } else if (had) {
      had.problem = checked.problem;
      had.badSha = sha;
      had.recheckAt = recheckAt;
      had.checkedAt = nowMs;
    } else {
      inc.sources[source] = { sha: null, readAt: null, writtenAt: null, what: '', payers: [], items: [], problem: checked.problem, badSha: sha, recheckAt, checkedAt: nowMs };
    }
  }
  if (inc.firstReadAt !== null) {
    const mine = inc.firstReadAt - SINCE_BACK_MS;
    if (inc.shared.since === null || mine < inc.shared.since) inc.shared.since = Math.max(0, mine);
  }
  rebuildIncome(state, nowMs);
  const after = canon(state.income) + '|' + canon(listOf(state.txs).filter(isIncomeMove));
  return { changed: before !== after };
}

/**
 * One reading of income/ (ARCHITECTURE 3.7): list the folder, fetch only the files whose sha changed (a
 * file over 1 MB is not fetched), then store what changed in one update. Nothing is ever written to the
 * folder. A stale device (its key replaced or forgotten) stops at the next step. A folder that is not
 * there (`list` gives null: GitHub's 404, which also answers a key that lost access) is an empty listing only when
 * `device.access()` says the key just read the shared file of the same repository (`folder: 'none'`); otherwise it
 * drops nothing (`folder: 'unseen'`). `folder` is 'listed' when the folder was listed.
 * @param {{ state: () => object, update: (change: (s: object) => void) => void, stale?: () => boolean, access?: () => boolean }} device
 * @param {{ list: () => Promise<{name: string, sha: string, size: number}[]|null>, read: (name: string) => Promise<string|null> }} transport
 * @param {number} nowMs
 * @returns {Promise<{ ok: boolean, skipped?: boolean, changed?: boolean, sources?: number, folder?: 'listed'|'none'|'unseen' }>}
 */
export async function roundIncome(device, transport, nowMs) {
  const stale = () => !!(device.stale && device.stale());
  if (stale()) return { ok: false, skipped: true };
  const listing = await transport.list();
  if (stale()) return { ok: false, skipped: true };
  const held = incomeOf(device.state()).sources;
  const folder = listing !== null ? 'listed' : device.access && device.access() ? 'none' : 'unseen';
  if (folder === 'unseen') return { ok: true, changed: false, sources: Object.keys(held).length, folder };
  const listed = [];
  const files = {};
  for (const entry of listing || []) {
    const source = sourceIdOf(entry.name);
    if (!source) continue;
    listed.push({ source, sha: entry.sha });
    if (holdsSha(held, source, entry.sha, nowMs)) continue;
    if (entry.size > INCOME_MAX_BYTES) {
      files[source] = { sha: entry.sha, text: null, tooLarge: true };
      continue;
    }
    const text = await transport.read(entry.name);
    if (stale()) return { ok: false, skipped: true };
    files[source] = { sha: entry.sha, text };
  }
  // nothing to store: no file fetched, every listed source held and not missed, every held one listed or missed for less than 24 hours
  const named = new Set(listed.map((one) => one.source));
  const missed = (one) => isObject(one) && Number.isFinite(one.missedAt);
  const same = !Object.keys(files).length && listed.every((one) => Object.hasOwn(held, one.source) && !missed(held[one.source]))
    && Object.keys(held).every((source) => named.has(source) || (missed(held[source]) && nowMs - held[source].missedAt < MISSED_MS));
  if (same) return { ok: true, changed: false, sources: listed.length, folder };
  let changed = false;
  device.update((s) => { changed = applyIncomeReading(s, { listed, files }, nowMs).changed || changed; });
  return { ok: true, changed, sources: listed.length, folder };
}

/**
 * The sha this device already holds for a source (good, or refused): a listing with it needs no fetch. A
 * refusal that depends on the time is held only until its `recheckAt`; then the file is checked again.
 */
export function knownSha(state, source, sha, nowMs) {
  return holdsSha(incomeOf(state).sources, source, sha, nowMs);
}

function holdsSha(sources, source, sha, nowMs) {
  const one = Object.hasOwn(sources, source) ? sources[source] : null;
  if (!isObject(one)) return false;
  if (one.sha === sha) return true;
  if (one.badSha !== sha) return false;
  return !(Number.isFinite(one.recheckAt) && !(nowMs < one.recheckAt));
}

/* ------------------------------------------------------- how it was paid */

/**
 * How one payment was paid: history (marked before `since`: never counted or asked), then the item's own answer
 * (`wait` is still coming by transfer: `bank`), then its payer's answer, then `ask`. (A file never lists a payment
 * below its own floor `from`: such a file is refused.)
 */
export function howOf(shared, since, source, item) {
  if (since === null || since === undefined || !(item.at >= since)) return 'history';
  const own = ownOf(shared.items, source + '/' + item.id);
  if (own && own.how === 'wait') return 'bank';
  if (own && own.how !== 'none') return own.how;
  const payer = ownOf(shared.payers, source + '/' + item.payer);
  if (payer && payer.how !== 'none') return payer.how;
  return 'ask';
}

/** The payer's answer ('bank' | 'cash'), or null when there is none (a cleared answer is none). */
export function payerAnswer(shared, payerKey) {
  const a = ownOf(isObject(shared) ? shared.payers : null, payerKey);
  return a && (a.how === 'bank' || a.how === 'cash') ? a.how : null;
}

/**
 * Every payment of every good source with its `how`, oldest first (by time marked, then key). `floor` is the game day
 * of its source's `from` (null without one): no bank row dated before it confirms the payment.
 */
export function incomePayments(state, rollover) {
  const { sources, shared } = incomeOf(state);
  const out = [];
  for (const source of Object.keys(sources).sort()) {
    const src = sources[source];
    if (!isObject(src) || !Array.isArray(src.items)) continue;
    const names = new Map(listOf(src.payers).map((p) => [p.id, p.name]));
    const floor = Number.isFinite(src.from) ? gameDay(src.from, rollover) : null;
    for (const item of src.items) {
      out.push({
        key: source + '/' + item.id, source, id: item.id, payer: item.payer, payerKey: source + '/' + item.payer,
        payerName: names.get(item.payer) || '', what: src.what, cents: item.cents, day: item.day, at: item.at,
        marked: gameDay(item.at, rollover), floor, how: howOf(shared, shared.since, source, item),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at || cmp(a.key, b.key));
}

/** "{what} · {payer}" */
export function incomeLabel(payment) {
  return payment.what + ' · ' + payment.payerName;
}

/* ------------------------------------------------------------- matching */

/**
 * The first day a payment's bank row may lie on (rule 1 of matchIncome), before the floor; `n` is its marked day as a
 * day number. A session paid ahead looks back as far as a past one (the marked day - 10); a past session no further
 * than its day - 3.
 */
function ownLowerBound(p, n) {
  const session = dayNumber(p.day);
  if (session !== null && session > n) return n - MATCH_BEFORE_DAYS;
  return Math.max(session === null ? -Infinity : session - SESSION_BEFORE_DAYS, n - MATCH_BEFORE_DAYS);
}

/**
 * Whether its source's floor cuts into the days a payment's bank row may lie on: its deposit may then lie below the
 * floor, where no row confirms it. Unmatched, such a payment sent by transfer (or not yet answered) is taken as
 * history: no move and no question, so it never counts beside a deposit the floor hid (ARCHITECTURE 3.7). It still
 * takes part in the matching. Only the last days before a payment falls below the floor are concerned.
 */
export function floorCuts(p) {
  const n = dayNumber(p && p.marked);
  const floor = dayNumber(p && p.floor);
  return n !== null && floor !== null && ownLowerBound(p, n) < floor;
}

/**
 * Which bank row confirms which reported payment (ARCHITECTURE 3.7), from the inputs alone: two devices with the same
 * payments, answers and bank rows always pair the same way. A bank deposit is evidence; a payer's answer is only a
 * default, and it never changes who takes part. The claimants (chosen by the caller) are every payment but one whose
 * own answer is cash or gone: open payments, history payments and those that follow their payer's cash answer.
 *  1. A row's day lies from a lower bound to the marked day + 30, for every payment it takes (`day` is the session's
 *     day, `floor` the game day of the source's `from`). The lower bound is the marked day - 10 for a session after
 *     the marked day (paid ahead), else max(the session's day - 3, the marked day - 10); then never before the floor.
 *     A payment for a session ahead looks back as far as one for a past session: at worst a payment skips its pencil
 *     phase, never counts twice.
 *  2. One pass, rows oldest first: one payment of exactly its cents (the one marked nearest its day; ties: marked
 *     earlier, then key), else the smallest group of 2 to 6 of one payer marked within 21 days of each other whose
 *     cents add up to it (ties: the group marked earliest).
 * @param {{ id: string, day: string, amount: number, order?: string }[]} rows
 * @param {{ key: string, payerKey: string, cents: number, at: number, marked: string, day?: string, floor?: string|null }[]} payments
 * @returns {Map<string, string>} payment key -> row id
 */
export function matchIncome(rows, payments) {
  const out = new Map();
  const pool = [];
  for (const p of payments) {
    const n = dayNumber(p.marked);
    if (n === null) continue;
    const floor = dayNumber(p.floor);
    const lo = Math.max(ownLowerBound(p, n), floor === null ? -Infinity : floor);
    const hi = n + MATCH_AFTER_DAYS;
    if (lo <= hi) pool.push({ ...p, n, lo, hi });
  }
  if (!pool.length) return out;
  pool.sort((a, b) => a.n - b.n || a.at - b.at || cmp(a.key, b.key));
  const sortedRows = rows.map((row) => ({ ...row, n: dayNumber(row.day) })).filter((row) => row.n !== null)
    .sort((a, b) => a.n - b.n || a.amount - b.amount || cmp(a.order || '', b.order || '') || cmp(a.id, b.id));
  const byCents = new Map();
  for (const p of pool) {
    const same = byCents.get(p.cents);
    if (same) same.push(p); else byCents.set(p.cents, [p]);
  }
  const days = pool.map((p) => p.n);
  const fits = (p, row) => row.n >= p.lo && row.n <= p.hi;
  for (const row of sortedRows) {
    let best = null;
    for (const p of byCents.get(row.amount) || []) {
      if (out.has(p.key) || !fits(p, row)) continue;
      if (!best || nearer(p, best, row.n)) best = p;
    }
    if (best) {
      out.set(best.key, row.id);
      continue;
    }
    const lo = lowerBound(days, row.n - MATCH_AFTER_DAYS);
    const hi = lowerBound(days, row.n + MATCH_BEFORE_DAYS + 1);
    const fit = pool.slice(lo, hi).filter((p) => !out.has(p.key) && p.cents < row.amount && fits(p, row))
      .sort((a, b) => a.at - b.at || cmp(a.key, b.key));
    if (fit.length < GROUP_MIN) continue;
    const group = bestGroup(fit, row.amount);
    if (!group) continue;
    for (const p of group) out.set(p.key, row.id);
  }
  return out;
}

/** Of two single payments for a row: the one marked nearer its day, then the one marked earlier, then the smaller key. */
function nearer(a, b, n) {
  const da = Math.abs(a.n - n);
  const db = Math.abs(b.n - n);
  if (da !== db) return da < db;
  if (a.at !== b.at) return a.at < b.at;
  return a.key < b.key;
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** A calendar day as a whole number of days (for comparing windows quickly), or null. */
function dayNumber(day) {
  if (!isYmd(day)) return null;
  return Math.round(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS);
}

/** The smallest group of one payer adding up to `target`; ties: marked earliest. */
function bestGroup(fits, target) {
  const byPayer = new Map();
  for (const p of fits) {
    const list = byPayer.get(p.payerKey);
    if (list) list.push(p); else byPayer.set(p.payerKey, [p]);
  }
  for (let size = GROUP_MIN; size <= GROUP_MAX; size++) {
    let best = null;
    for (const payerKey of [...byPayer.keys()].sort()) {
      const found = firstGroup(byPayer.get(payerKey), size, target);
      if (found && (!best || earlier(found, best))) best = found;
    }
    if (best) return best;
  }
  return null;
}

/** The first group of `size` (in order of time marked) adding up to `target` within 21 days. */
function firstGroup(list, size, target) {
  if (list.length < size) return null;
  let steps = 0;
  const pick = [];
  const walk = (from, sum) => {
    if (++steps > GROUP_STEPS) return false;
    if (pick.length === size) return sum === target;
    for (let i = from; i <= list.length - (size - pick.length); i++) {
      const p = list[i];
      if (sum + p.cents > target) continue;
      if (pick.length && p.n - pick[0].n > GROUP_SPAN_DAYS) break;
      pick.push(p);
      if (walk(i + 1, sum + p.cents)) return true;
      pick.pop();
      if (steps > GROUP_STEPS) return false;
    }
    return false;
  };
  return walk(0, 0) ? pick.slice() : null;
}

function earlier(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i].at !== b[i].at) return a[i].at < b[i].at;
    if (a[i].key !== b[i].key) return a[i].key < b[i].key;
  }
  return false;
}

/* ---------------------------------------------------------- the rebuild */

/** A move this module made (one reported payment). */
export function isIncomeMove(tx) {
  return isObject(tx) && tx.source === 'manual' && tx.via === 'income';
}

/** The id of a payment's move: the same on every device. */
export function incomeMoveId(source, itemId) {
  return 'inc_' + source.length + '_' + source + '_' + itemId;
}

/**
 * A Cash in hand account with nothing in it: no count, no cash payment and a 0 balance (after a payer is switched
 * back to Zelle, say). Every device hides it the same way, since all three follow from the shared answers.
 */
export function isIdleCash(state, account) {
  if (!isObject(account) || account.role !== CASH_ROLE || account.source === 'bank') return false;
  if (Math.round(Number(account.balance) || 0) !== 0) return false;
  if (liveCounts(incomeOf(state).shared).length) return false;
  return !listOf(state && state.txs).some((tx) => isIncomeMove(tx) && tx.accountId === account.id);
}

/** The Cash in hand account, or null. */
export function cashAccountOf(state) {
  return listOf(state && state.accounts).find((a) => isObject(a) && a.role === CASH_ROLE) || null;
}

/**
 * Rebuild the payments' moves from (sources, shared answers, bank rows): deterministic and idempotent;
 * a field the owner set on a move is kept; nothing else is touched.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {{ changed: boolean }}
 */
export function rebuildIncome(state, nowMs) {
  if (!isObject(state) || !Array.isArray(state.txs)) return { changed: false };
  const hasIncome = isObject(state.income);
  const already = state.txs.some(isIncomeMove) || !!cashAccountOf(state);
  if (!hasIncome && !already) return { changed: false };
  const rollover = rolloverOf(state);
  const today = gameDay(nowMs, rollover);
  const { shared } = incomeOf(state);
  const every = incomePayments(state, rollover);
  const payments = every.filter((p) => p.how !== 'history');
  let changed = false;

  // matching: the claimants against the incoming income rows nobody else claimed, from scratch every time
  const accounts = new Map(listOf(state.accounts).filter(isObject).map((a) => [a.id, a]));
  const claimed = new Set();
  for (const tx of state.txs) if (isObject(tx) && tx.matchId && !isIncomeMove(tx)) claimed.add(tx.matchId);
  const latest = addDays(today, 2);
  const countPending = !(isObject(state.settings) && state.settings.countPending === false);
  const rows = state.txs.filter((tx) => isMatchableRow(tx, accounts, claimed, latest, countPending))
    .map((tx) => ({ id: tx.id, day: tx.day, amount: Math.round(tx.amount), order: tx.ext && typeof tx.ext.id === 'string' ? tx.ext.id : tx.fp || '' }));
  const claimants = every.filter((p) => isClaimant(shared, p));
  const matched = matchIncome(rows, claimants);
  // the pairs are an output only (the accrual of 3.7 and the questions read them), never an input
  if (isObject(state.income)) {
    const pairs = {};
    for (const key of [...matched.keys()].sort()) pairs[key] = matched.get(key);
    if (canon(state.income.pairs === undefined ? null : state.income.pairs) !== canon(pairs)) {
      // other bank rows are claimed: whether a payer's stream accrues is decided again in the same update
      // (detect.followIncome, the store's update hook), in both directions; until then the flag stays
      if (canon(rowsOf(state.income.pairs)) !== canon(rowsOf(pairs))) state.income.restream = true;
      state.income.pairs = pairs;
      changed = true;
    }
  }
  // counted: by transfer, not answered, or cash; an unmatched one by transfer (or not answered) whose window the floor
  // cuts is taken as history (floorCuts)
  const counted = payments.filter((p) => p.how === 'cash'
    || ((p.how === 'bank' || p.how === 'ask') && (matched.has(p.key) || !floorCuts(p))));
  const into = receivingAccount(state, accounts, today);

  // the Cash in hand account: made the first time a payment counts as cash, or a count arrives (and kept)
  let cashAccount = cashAccountOf(state);
  const counts = liveCounts(shared, rollover);
  if (!cashAccount && (counted.some((p) => p.how === 'cash' && !matched.has(p.key)) || counts.length)) {
    cashAccount = makeCashAccount(state);
    state.accounts.push(cashAccount);
    changed = true;
  }

  // the moves wanted
  const want = new Map();
  for (const p of counted) want.set(incomeMoveId(p.source, p.id), p);
  // remove the moves no longer wanted
  for (let i = state.txs.length - 1; i >= 0; i--) {
    const tx = state.txs[i];
    if (isIncomeMove(tx) && !want.has(tx.id)) {
      state.txs.splice(i, 1);
      changed = true;
    }
  }
  const have = new Map(state.txs.filter(isIncomeMove).map((tx) => [tx.id, tx]));
  for (const [id, p] of [...want.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const row = matched.get(p.key) || null;
    // a payment that follows its payer's cash answer and meets a bank row counts once, as that row, and is asked about
    const guess = p.how === 'cash' && !!row;
    const cash = p.how === 'cash' && !row;
    const income = { key: p.key, how: guess ? 'bank' : p.how, payer: p.payerName, what: p.what, sessionDay: p.day };
    if (guess) income.confirm = true;
    const fields = {
      source: 'manual', via: 'income', kind: 'income', flow: 'in', pending: false, postedDay: null,
      accountId: cash ? (cashAccount ? cashAccount.id : null) : into,
      day: p.marked, at: p.at, amount: p.cents,
      matchId: row,
      income,
    };
    const own = { merchant: incomeLabel(p), category: 'income', klass: 'need', purpose: 'coaching' };
    const tx = have.get(id);
    if (!tx) {
      state.txs.push(makeTx({ id, ...fields, ...own, raw: '', mkey: '', loggedAt: p.at, review: false }));
      changed = true;
      continue;
    }
    for (const [field, value] of Object.entries(fields)) {
      if (canon(tx[field]) !== canon(value)) { tx[field] = value; changed = true; }
    }
    const locks = Array.isArray(tx.locks) ? tx.locks : [];
    for (const [field, value] of Object.entries(own)) {
      if (!locks.includes(field) && tx[field] !== value) { tx[field] = value; changed = true; }
    }
  }

  // a bank row that a reported payment claims (history ones included) carries its label wherever it is listed or opened
  const labels = new Map();
  for (const p of claimants) {
    const rowId = matched.get(p.key);
    if (!rowId) continue;
    const had = labels.get(rowId);
    labels.set(rowId, had ? (had.endsWith(' · ' + p.payerName) || had.includes(', ' + p.payerName) ? had : had + ', ' + p.payerName) : incomeLabel(p));
  }
  for (const tx of state.txs) {
    if (!isObject(tx) || tx.source !== 'bank') continue;
    const label = labels.get(tx.id);
    if (label && tx.reportedAs !== label) { tx.reportedAs = label; changed = true; }
    else if (!label && tx.reportedAs !== undefined) { delete tx.reportedAs; changed = true; }
  }

  // Cash in hand: the owner's counts (each sets it from its own day) and the figure now
  if (cashAccount) {
    // the mirror lists the counts in the order they rule (the ledger keeps that order within a day)
    const mirror = counts.map((c) => ({ cents: c.cents, at: c.at }));
    const ruling = counts.map((c) => ({ id: c.id, cents: c.cents, at: c.at }));
    if (canon(cashAccount.counts === undefined ? null : cashAccount.counts) !== canon(mirror)) { cashAccount.counts = mirror; changed = true; }
    if (Object.hasOwn(cashAccount, 'counted')) { delete cashAccount.counted; changed = true; }
    const figure = cashFigure(state, cashAccount.id, ruling, today, rollover);
    if (cashAccount.balance !== figure.cents) { cashAccount.balance = figure.cents; changed = true; }
    if (cashAccount.asOf !== figure.asOf) { cashAccount.asOf = figure.asOf; changed = true; }
  }
  return { changed };
}

function makeCashAccount(state) {
  const taken = new Set(listOf(state.accounts).filter(isObject).map((a) => a.id));
  let id = CASH_ID;
  for (let k = 2; taken.has(id); k++) id = CASH_ID + '_' + k;
  return makeAccount({
    id, source: 'manual', type: 'cash', name: CASH_NAME, role: CASH_ROLE, basis: 'estimate',
    everyday: false, reserve: false, balance: 0, asOf: 0, counts: [], purpose: 'personal',
  });
}

/**
 * Whether a payment takes part in the matching (3.7): history, open (sent by transfer, still coming, or not answered
 * yet) and following its payer's cash answer all do; one whose own answer is cash or gone never does. A payer's
 * answer therefore never changes who takes part.
 */
function isClaimant(shared, p) {
  if (p.how === 'gone') return false;
  return p.how !== 'cash' || !itemAnswer(shared, p.key);
}

/** The pairs of the last rebuild (payment key -> bank row id), history payments included. */
function pairsOf(state) {
  return isObject(state) && isObject(state.income) && isObject(state.income.pairs) ? state.income.pairs : {};
}

/** The bank rows a set of pairs claims, sorted, once each. */
function rowsOf(pairs) {
  if (!isObject(pairs)) return [];
  return [...new Set(Object.keys(pairs).map((key) => pairs[key]).filter((id) => typeof id === 'string'))].sort();
}

/** Every bank row a reported payment claims (counted or history): their streams are counted on arrival (3.7). */
export function incomeClaimedRows(state) {
  const pairs = pairsOf(state);
  return new Set(Object.keys(pairs).map((key) => pairs[key]).filter((id) => typeof id === 'string'));
}

/** A bank row that can confirm a payment sent by transfer: live (a pending row only while pending rows count). */
function isMatchableRow(tx, accounts, claimed, latest, countPending) {
  if (!isObject(tx) || tx.source !== 'bank' || typeof tx.id !== 'string') return false;
  if (tx.flow !== 'in' || tx.kind !== 'income' || tx.matchId || tx.pairId != null || claimed.has(tx.id)) return false;
  if (tx.pending && !countPending) return false;
  if (!isYmd(tx.day) || tx.day > latest || !(tx.amount > 0)) return false;
  const account = accounts.get(tx.accountId);
  return !!account && account.source === 'bank' && !account.hidden && groupOf(account) === 'cash';
}

/**
 * The cash account of the bank that received the most incoming, unpaired rows classified as income in
 * the last 120 days (ties: the larger balance, then the smaller id); null when none.
 */
function receivingAccount(state, accounts, today) {
  const from = addDays(today, -ACCOUNT_WINDOW_DAYS);
  const counts = new Map();
  for (const tx of state.txs) {
    if (!isObject(tx) || tx.source !== 'bank' || tx.flow !== 'in' || tx.kind !== 'income' || tx.pairId != null || tx.matchId) continue;
    if (!isYmd(tx.day) || tx.day < from || tx.day > today) continue;
    const account = accounts.get(tx.accountId);
    if (!account || account.source !== 'bank' || account.hidden || groupOf(account) !== 'cash') continue;
    counts.set(account.id, (counts.get(account.id) || 0) + 1);
  }
  let best = null;
  for (const [id, n] of counts) {
    const a = accounts.get(id);
    if (!best || n > best.n || (n === best.n && (balanceOf(a) > balanceOf(best.a) || (balanceOf(a) === balanceOf(best.a) && id < best.a.id)))) best = { n, a };
  }
  return best ? best.a.id : null;
}

/**
 * Cash in hand at the end of `throughDay`: the latest count whose day has come (the latest game day; on one day the
 * one edited last) plus every cash payment marked after it; with no count, every cash payment since `since`.
 * @param {{ cents: number, at: number, editedAt?: number, id?: string }[]} counts  the live counts, in the order they rule
 */
export function cashFigure(state, accountId, counts, throughDay, rollover) {
  let cents = 0;
  let asOf = 0;
  let count = null;
  // the counts come in the order they rule (liveCounts): the last whose day has come is the one
  for (const c of listOf(counts)) if (gameDay(c.at, rollover) <= throughDay) count = c;
  const useCount = !!count;
  if (useCount) { cents = count.cents; asOf = count.at; }
  for (const tx of listOf(state.txs)) {
    if (!isIncomeMove(tx) || tx.accountId !== accountId || tx.day > throughDay) continue;
    if (useCount && !(tx.at > count.at)) continue;
    cents += Math.round(tx.amount);
    if (tx.at > asOf) asOf = tx.at;
  }
  return { cents, asOf };
}

/* --------------------------------------------------------- the questions */

/**
 * What the Board asks (ARCHITECTURE 3.7): one payer question per payer with `ask` payments (the newest
 * shown; a payment already met by a bank row may add what the bank shows); one late question per
 * payment sent by transfer that no bank row has met 96 hours after it was marked, unless "Still
 * coming" holds until later; and one confirmation question per bank row that counts for a payment
 * following its payer's cash answer. A confirmation's `n` and `cents` cover every member of the row, history
 * ones included; `ids` (and `asked`) only the members that follow the cash answer, which its buttons answer;
 * `others` the rest ({ n, cents, earlier }), or null. None in the sample game.
 * @returns {{ payers: object[], late: object[], confirm: object[] }}
 */
export function incomeQuestions(state, nowMs) {
  const out = { payers: [], late: [], confirm: [] };
  if (!isObject(state) || (isObject(state.meta) && state.meta.origin === 'demo')) return out;
  const rollover = rolloverOf(state);
  const { shared } = incomeOf(state);
  const moves = new Map(listOf(state.txs).filter(isIncomeMove).map((tx) => [tx.id, tx]));
  const rows = new Map(listOf(state.txs).filter((tx) => isObject(tx) && tx.source === 'bank').map((tx) => [tx.id, tx]));
  const pairs = pairsOf(state);
  const byPayer = new Map();
  const onRow = new Map();
  for (const p of incomePayments(state, rollover)) {
    const move = moves.get(incomeMoveId(p.source, p.id));
    const row = Object.hasOwn(pairs, p.key) ? rows.get(pairs[p.key]) || null : null;
    const guess = !!row && !!move && isObject(move.income) && move.income.confirm === true;
    if (row) {
      const entry = { payment: p, guess };
      const list = onRow.get(row.id);
      if (list) list.push(entry); else onRow.set(row.id, [entry]);
    }
    if (guess) continue; // asked about with its row
    if (!row && (p.how === 'ask' || p.how === 'bank') && floorCuts(p)) continue; // taken as history (floorCuts)
    if (p.how === 'ask') {
      const list = byPayer.get(p.payerKey);
      const entry = { payment: p, row };
      if (list) list.push(entry); else byPayer.set(p.payerKey, [entry]);
    } else if (p.how === 'bank' && move && !move.matchId && nowMs - p.at >= LATE_MS) {
      const own = ownOf(shared.items, p.key);
      if (own && own.how === 'wait' && Number.isFinite(own.until) && own.until > nowMs) continue;
      out.late.push({ key: p.key, source: p.source, id: p.id, label: incomeLabel(p), cents: p.cents, marked: p.marked, at: p.at });
    }
  }
  for (const payerKey of [...byPayer.keys()].sort()) {
    const list = byPayer.get(payerKey);
    const newest = list[list.length - 1].payment;
    const seen = list.filter((e) => e.row).pop();
    out.payers.push({
      key: payerKey, source: newest.source, payer: newest.payer, name: newest.payerName, what: newest.what,
      cents: newest.cents, marked: newest.marked, count: list.length,
      bank: seen ? { cents: Math.round(seen.row.amount), day: seen.row.day, same: seen.payment.key === newest.key } : null,
    });
  }
  // a row counted for payments that follow their payer's cash answer: did they come by Zelle? (one question per row)
  const sum = (list) => list.reduce((n, p) => n + p.cents, 0);
  for (const [rowId, list] of onRow) {
    const asked = list.filter((e) => e.guess).map((e) => e.payment);
    if (!asked.length) continue;
    const others = list.filter((e) => !e.guess).map((e) => e.payment);
    const row = rows.get(rowId);
    const first = asked[0];
    out.confirm.push({ key: 'row/' + rowId, row: rowId, source: first.source, ids: asked.map((p) => p.id), label: incomeLabel(first),
      name: first.payerName, what: first.what, n: list.length, cents: sum(list.map((e) => e.payment)), marked: first.marked, at: first.at,
      asked: { n: asked.length, cents: sum(asked) },
      others: others.length ? { n: others.length, cents: sum(others), earlier: others.every((p) => p.at < first.at) } : null,
      bank: { cents: Math.round(row.amount), day: row.day } });
  }
  out.late.sort((a, b) => a.at - b.at || cmp(a.key, b.key));
  out.confirm.sort((a, b) => a.at - b.at || cmp(a.key, b.key));
  return out;
}

/* ------------------------------------------------------------ answering */

/*
 * The owner's answers and counts are made like a change from outside (store.update(change, { past: change })): Undo
 * never takes them back. Each is changed directly: the payer switch in Settings, Ask again, counting again, or
 * Remove the latest count.
 */

/**
 * The merge stamp of an answer: now, and always above the answer it replaces, so a later answer on the same device
 * wins even against a clock that runs a little ahead. (A count's `at` and a wait's `until` keep their meaning.)
 */
function stampAbove(current, nowMs) {
  return Math.min(MAX_STAMP, Math.max(Math.round(nowMs), isObject(current) && isStamp(current.at) ? current.at + 1 : 0));
}

/** The payer's answer ('bank' | 'cash'): payments without their own answer follow it. It writes that answer and nothing else. */
export function answerPayer(state, source, payerId, how, nowMs) {
  const key = source + '/' + payerId;
  if ((how !== 'bank' && how !== 'cash') || key.length > MAX_KEY || !isId(source) || !isId(payerId) || !isStamp(nowMs)) return false;
  const inc = ensureIncome(state);
  inc.shared.payers[key] = { how, at: stampAbove(ownOf(inc.shared.payers, key), nowMs) };
  inc.shared.payers = capped(inc.shared.payers, MAX_PAYER_ANSWERS);
  rebuildIncome(state, nowMs);
  return true;
}

/** One payment's answer ('bank' | 'cash' | 'gone' | 'wait'); `wait` asks again 4 days later. */
export function answerItem(state, source, itemId, how, nowMs) {
  return answerItems(state, source, [itemId], how, nowMs);
}

/** The same answer for several payments of one source (a bank row's confirmation question answers every payment it holds). */
export function answerItems(state, source, itemIds, how, nowMs) {
  const ids = listOf(itemIds);
  if (!ids.length || !ITEM_HOWS.has(how) || how === 'none' || !isId(source) || !isStamp(nowMs)) return false;
  if (!ids.every((id) => isId(id) && (source + '/' + id).length <= MAX_KEY)) return false;
  const inc = ensureIncome(state);
  for (const id of ids) {
    const key = source + '/' + id;
    const at = stampAbove(ownOf(inc.shared.items, key), nowMs);
    inc.shared.items[key] = how === 'wait' ? { how, at, until: nowMs + WAIT_MS } : { how, at };
  }
  inc.shared.items = capped(inc.shared.items, MAX_ITEM_ANSWERS);
  rebuildIncome(state, nowMs);
  return true;
}

/**
 * "Ask again": takes back a payment's own answer (cash, gone, wait, or bank from the confirmation question). It
 * writes a cleared answer (`none`), which every reader treats as no answer and which travels like any other.
 */
export function askAgain(state, source, itemId, nowMs) {
  const key = source + '/' + itemId;
  if (key.length > MAX_KEY || !isId(source) || !isId(itemId) || !isStamp(nowMs)) return false;
  const inc = ensureIncome(state);
  const own = ownOf(inc.shared.items, key);
  if (!own || own.how === 'none') return false;
  inc.shared.items[key] = { how: 'none', at: stampAbove(own, nowMs) };
  rebuildIncome(state, nowMs);
  return true;
}

/**
 * The payments a bank row confirms (the last rebuild's pairs, history ones included), oldest first, each with its own
 * answer (null when it has none), so that the row's sheet can offer Ask again for each.
 */
export function rowPayments(state, rowId) {
  const pairs = pairsOf(state);
  const { shared } = incomeOf(state);
  return incomePayments(state, rolloverOf(state)).filter((p) => Object.hasOwn(pairs, p.key) && pairs[p.key] === rowId)
    .map((p) => ({ key: p.key, source: p.source, id: p.id, label: incomeLabel(p), cents: p.cents, marked: p.marked, history: p.how === 'history', own: itemAnswer(shared, p.key) }));
}

/** A payment's own answer ('bank' | 'cash' | 'gone' | 'wait'), or null when it has none. */
export function itemAnswer(shared, key) {
  const a = ownOf(isObject(shared) ? shared.items : null, key);
  return a && a.how !== 'none' ? a.how : null;
}

/** The Cash in hand account, made when it is missing (so that the owner can count before a cash payment). */
export function ensureCashAccount(state) {
  if (!Array.isArray(state.accounts)) state.accounts = [];
  let account = cashAccountOf(state);
  if (!account) {
    account = makeCashAccount(state);
    state.accounts.push(account);
  }
  return account;
}

/**
 * "I have {amount} in cash now": the owner's count, shared with every device. Every count is kept (at most 200):
 * each sets Cash in hand from its own day, so a later count never moves the close of a day before it. `at` is when
 * the cash was counted, the real time (it decides the count's game day and which cash payments come after it);
 * `editedAt` is the merge stamp, and above every count's and removal's this device knows. On a game day the count
 * edited last rules (liveCounts), so the owner's latest count rules even when another device's clock ran ahead, and
 * no count moves to another game day.
 */
export function countCash(state, cents, nowMs) {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_COUNT || !isStamp(nowMs)) return false;
  const inc = ensureIncome(state);
  const entries = listOf(inc.shared.counts).filter(isCountEntry);
  const at = Math.min(MAX_STAMP, Math.round(nowMs));
  const editedAt = Math.min(MAX_STAMP, Math.max(at, ...entries.map((c) => c.editedAt + 1)));
  const taken = new Set(listOf(inc.shared.counts).map((c) => isObject(c) ? c.id : null));
  let id = 'c' + at.toString(36);
  for (let k = 2; taken.has(id); k++) id = 'c' + at.toString(36) + '-' + k;
  inc.shared.counts = cappedCounts([...entries, { id, cents, at, editedAt }]);
  ensureCashAccount(state);
  rebuildIncome(state, nowMs);
  return true;
}

/**
 * "Remove the latest count": a removal `{ id, deleted: true, editedAt }`, stamped above the count it removes, merged
 * by id like the counts. The count before it rules again from its own day.
 */
export function removeCount(state, id, nowMs) {
  if (!isStamp(nowMs)) return false;
  const inc = ensureIncome(state);
  const count = listOf(inc.shared.counts).find((c) => isCountEntry(c) && !c.deleted && c.id === id);
  if (!count) return false;
  const editedAt = Math.min(MAX_STAMP, Math.max(Math.round(nowMs), count.editedAt + 1));
  inc.shared.counts = cappedCounts([...inc.shared.counts.filter((c) => isCountEntry(c) && c.id !== id), { id, deleted: true, editedAt }]);
  rebuildIncome(state, nowMs);
  return true;
}

/**
 * The counts that hold (not removed), in the order they rule, the latest last: by the game day of `at`, then on one
 * game day by `editedAt` (the count edited last wins), then by id.
 */
export function liveCounts(shared, rollover = 4) {
  return listOf(shared && shared.counts).filter((c) => isCountEntry(c) && !c.deleted)
    .map((c) => ({ c, day: gameDay(c.at, rollover) }))
    .sort((a, b) => cmp(a.day, b.day) || a.c.editedAt - b.c.editedAt || cmp(a.c.id, b.c.id))
    .map((x) => x.c);
}

/** The label a bank row carries when it confirms reported payments: bank row id -> "{what} · {payer}". */
export function incomeRowLabels(state) {
  const out = new Map();
  for (const tx of listOf(state && state.txs)) {
    if (isObject(tx) && tx.source === 'bank' && typeof tx.reportedAs === 'string' && tx.reportedAs) out.set(tx.id, tx.reportedAs);
  }
  return out;
}

/* ------------------------------------------------- the shared section (3.5) */

/**
 * Check the `income` section of the shared file. Null when it is not one this version can read.
 * `counts` is a list of `{ id, cents, at, editedAt }` and removals `{ id, deleted: true, editedAt }`, one per id.
 * @returns {{ since: number|null, payers: object, items: object, counts: object[] }|null}
 */
export function readIncomeShared(raw) {
  if (raw === undefined || raw === null) return blankShared();
  if (!isObject(raw)) return null;
  const since = raw.since === undefined || raw.since === null ? null : raw.since;
  if (since !== null && !isStamp(since)) return null;
  const payers = raw.payers === undefined ? {} : raw.payers;
  const items = raw.items === undefined ? {} : raw.items;
  if (!isObject(payers) || !isObject(items)) return null;
  const pk = Object.keys(payers);
  const ik = Object.keys(items);
  if (pk.length > MAX_PAYER_ANSWERS || ik.length > MAX_ITEM_ANSWERS) return null;
  const out = { since, payers: {}, items: {}, counts: [] };
  for (const key of pk) {
    const a = payers[key];
    if (!isAnswerKey(key) || !isObject(a) || !PAYER_HOWS.has(a.how) || !isStamp(a.at)) return null;
    out.payers[key] = { how: a.how, at: a.at };
  }
  for (const key of ik) {
    const a = items[key];
    if (!isAnswerKey(key) || !isObject(a) || !ITEM_HOWS.has(a.how) || !isStamp(a.at)) return null;
    if (a.until !== undefined && !isStamp(a.until)) return null;
    out.items[key] = a.until === undefined ? { how: a.how, at: a.at } : { how: a.how, at: a.at, until: a.until };
  }
  const counts = raw.counts === undefined ? [] : raw.counts;
  if (!Array.isArray(counts) || counts.length > MAX_COUNTS) return null;
  const ids = new Set();
  for (const c of counts) {
    if (!isCountEntry(c) || ids.has(c.id)) return null;
    ids.add(c.id);
    out.counts.push(countOf(c));
  }
  out.counts.sort((a, b) => cmp(a.id, b.id));
  return out;
}

/**
 * The answers of the document read leniently: an entry that is not one is left out, and only the latest
 * answers within the limits are kept, so that one bad entry never hides the others.
 */
function keptShared(raw) {
  const out = blankShared();
  if (!isObject(raw)) return out;
  if (isStamp(raw.since)) out.since = raw.since;
  for (const [key, a] of Object.entries(isObject(raw.payers) ? raw.payers : {})) {
    if (isAnswerKey(key) && isObject(a) && PAYER_HOWS.has(a.how) && isStamp(a.at)) out.payers[key] = { how: a.how, at: a.at };
  }
  for (const [key, a] of Object.entries(isObject(raw.items) ? raw.items : {})) {
    if (!isAnswerKey(key) || !isObject(a) || !ITEM_HOWS.has(a.how) || !isStamp(a.at)) continue;
    out.items[key] = isStamp(a.until) ? { how: a.how, at: a.at, until: a.until } : { how: a.how, at: a.at };
  }
  out.payers = capped(out.payers, MAX_PAYER_ANSWERS);
  out.items = capped(out.items, MAX_ITEM_ANSWERS);
  const counts = new Map();
  for (const c of listOf(raw.counts)) if (isCountEntry(c)) counts.set(c.id, later(counts.get(c.id), countOf(c), 'editedAt'));
  out.counts = cappedCounts([...counts.values()]);
  return out;
}

/**
 * Merge two `income` sections: per key the later `at` wins, an equal `at` goes to the canonical order;
 * per count id the later `editedAt` wins; `since` is the smaller one present. Commutative, associative
 * and idempotent, at the limits too: there the newest answers stay (`capped`).
 */
export function mergeIncomeShared(a, b) {
  const x = readIncomeShared(a) || blankShared();
  const y = readIncomeShared(b) || blankShared();
  const since = x.since === null ? y.since : y.since === null ? x.since : Math.min(x.since, y.since);
  const counts = new Map(x.counts.map((c) => [c.id, c]));
  for (const c of y.counts) counts.set(c.id, later(counts.get(c.id), c, 'editedAt'));
  return {
    since,
    payers: capped(mergeMap(x.payers, y.payers), MAX_PAYER_ANSWERS),
    items: capped(mergeMap(x.items, y.items), MAX_ITEM_ANSWERS),
    counts: cappedCounts([...counts.values()]),
  };
}

/** What this device writes: its answers and counts, as they stand (never pruned by what this device lists). */
export function exportIncomeShared(state) {
  return incomeOf(state).shared;
}

/** True when the section says nothing at all. */
export function isBlankIncome(section) {
  const s = readIncomeShared(section);
  return !!s && s.since === null && !Object.keys(s.payers).length && !Object.keys(s.items).length && !s.counts.length;
}

function mergeMap(p, q) {
  const out = {};
  for (const key of [...new Set([...Object.keys(p), ...Object.keys(q)])].sort()) {
    out[key] = later(ownOf(p, key), ownOf(q, key));
  }
  return out;
}

function later(p, q, stamp = 'at') {
  if (!p) return q || null;
  if (!q) return p;
  if (p[stamp] !== q[stamp]) return p[stamp] > q[stamp] ? p : q;
  return canon(p) <= canon(q) ? p : q;
}

/**
 * At most `max` answers in a merge, so every device keeps the same ones: the newest (then by key). Ranked by the
 * merge stamp alone, so an answer that superseded another always ranks above it: an older answer never comes back,
 * and the merge stays commutative, associative and idempotent at the limit. It is the only bound: nothing is
 * pruned by what one device holds or lists.
 */
function capped(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const keep = keys.sort((a, b) => map[b].at - map[a].at || cmp(a, b)).slice(0, max).sort();
  const out = {};
  for (const key of keep) out[key] = map[key];
  return out;
}

/** At most 200 counts, the latest edited kept (then by id), in the order of their ids. */
function cappedCounts(list) {
  const keep = list.length <= MAX_COUNTS ? list.slice()
    : list.slice().sort((a, b) => b.editedAt - a.editedAt || cmp(a.id, b.id)).slice(0, MAX_COUNTS);
  return keep.sort((a, b) => cmp(a.id, b.id));
}

function isCountEntry(c) {
  if (!isObject(c) || !isId(c.id) || !isStamp(c.editedAt)) return false;
  if (c.deleted === true) return true;
  return c.deleted === undefined && Number.isInteger(c.cents) && c.cents >= 0 && c.cents <= MAX_COUNT && isStamp(c.at);
}

function countOf(c) {
  return c.deleted === true ? { id: c.id, deleted: true, editedAt: c.editedAt } : { id: c.id, cents: c.cents, at: c.at, editedAt: c.editedAt };
}

/* -------------------------------------------------------------- helpers */

function isAnswerKey(key) {
  if (typeof key !== 'string' || key.length > MAX_KEY) return false;
  const slash = key.indexOf('/');
  return slash > 0 && isId(key.slice(0, slash)) && isId(key.slice(slash + 1));
}

function isId(id) {
  return typeof id === 'string' && ID.test(id) && !UNSAFE.has(id);
}

function isStamp(x) {
  return Number.isFinite(x) && x >= 0 && x <= MAX_STAMP;
}

function ownOf(obj, key) {
  return isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function rolloverOf(state) {
  const hour = isObject(state.settings) ? state.settings.rolloverHour : undefined;
  return Number.isInteger(hour) && hour >= 0 && hour <= 6 ? hour : 4;
}

function groupOf(account) {
  return Object.hasOwn(ACCOUNT_TYPES, account.type) ? ACCOUNT_TYPES[account.type].group : null;
}

function balanceOf(account) {
  return Number.isFinite(account && account.balance) ? account.balance : 0;
}

/**
 * An ISO time with its offset ("2026-11-14T00:30:12.345Z", "…+01:00") in ms, read the same way on every
 * device (not through Date.parse, whose leniency differs between browsers); NaN when it is not one.
 */
function isoMs(text) {
  const m = typeof text === 'string' ? ISO.exec(text) : null;
  if (!m) return NaN;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number((m[7] + '00').slice(0, 3));
  if (!isYmd(m[1] + '-' + m[2] + '-' + m[3]) || h > 23 || mi > 59 || s > 59) return NaN;
  let offset = 0;
  if (!m[8]) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return NaN;
    offset = (m[9] === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offset;
}

function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with sorted keys: equal content gives equal text. */
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (isObject(x)) return '{' + Object.keys(x).sort().map((key) => JSON.stringify(key) + ':' + canon(x[key])).join(',') + '}';
  return x === undefined ? 'null' : JSON.stringify(x);
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}
