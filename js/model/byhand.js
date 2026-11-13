/**
 * Payments the owner sends themselves: the lines of the Book that sit on a checklist until the bank
 * shows the payment or the owner ticks it. See ARCHITECTURE.md section 6.
 * Pure: no clock, no DOM. Imports: schema, dates, money, book only (never ledger, detect or classify),
 * so that the ledger and detection may both import it.
 */

import { ACCOUNT_TYPES, makeRecurring } from './schema.js';
import { addDays, addMonths, addMonthsYm, diffDays, endOfMonth, gameDay, isYmd, monthOf, startOfMonth } from './dates.js';
import { sum } from './money.js';
import { BY_HAND_ARREARS, byHandStanding, byHandStandingOf, occurrences, runsByHand } from './book.js';

const NAME_MAX = 60;
const AMOUNT_MAX = 1e10;
const LAST_DAY = 31;
/** A skip covers the rows of that payee within this many days of the row the owner pointed at. */
const SKIP_REACH_DAYS = 3;
/** How far back a payee is looked for among the payments already sent. */
const PAST_DAYS = 100;
/** How far from an occurrence a row may be and still teach the entry its payee. */
const LEARN_REACH_DAYS = 16;
/** Two payees with a history: the one whose rows lie this near the entry's days, on average, and alone in that, is the payee. */
const NEAR_MEAN_DAYS = 5;
/** How far from an occurrence a posted row of another amount is reported on it; and how far past today detection asks what is unpaid. */
const OTHER_REACH_DAYS = 16;
/** How far past today a schedule is read when a row is matched to a day of it. */
const AHEAD_DAYS = 31;
/** A tick this recent is money on its way: the bank's balance still holds it. */
const TRANSIT_MS = 4 * 86400000;
const FIRST_DAY = '1970-01-01';
const LOCKS = ['name', 'amount', 'cadence', 'anchor'];
const SENT_BY_HAND = new Set(['builtin:zelle', 'builtin:wallet-payment']);
const NOT_BY_HAND = new Set(['builtin:own-transfer', 'builtin:institution-transfer']);

/* ------------------------------------------------------------------ the payee */

/**
 * A short one-way fingerprint of a merchant key: 'p' and 13 lowercase hex digits of a 52-bit hash
 * (cyrb53 with its top bit dropped). The same on every device; '' for an empty key. It stands in for
 * the bank's text wherever a payee is kept or shared.
 * @param {string} mkey
 * @returns {string}
 */
export function payeeKey(mkey) {
  if (typeof mkey !== 'string' || mkey === '') return '';
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < mkey.length; i++) {
    const ch = mkey.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (1048575 & h2) + (h1 >>> 0);
  return 'p' + hash.toString(16).padStart(13, '0');
}

/* ------------------------------------------------------------- the entry */

/**
 * The one constructor of a payment the owner sends: the fixed fields of such a line and the anchor
 * worked out from `dueDay` and `since` (its first occurrence on or after `since`). It checks nothing.
 * @param {{ id?: string, name: string, amount: number, dueDay: number, since: string, active?: boolean,
 *           editedAt?: number, payee?: string|null, payeeAt?: number, marks?: object, skips?: object }} fields
 * @returns {object} a Recurring
 */
export function makeByHand(fields) {
  const f = isObject(fields) ? fields : {};
  const entry = makeRecurring({
    name: f.name, amount: f.amount, mkey: '', accountId: null, variable: false,
    cadence: 'monthly', anchor: anchorFor(f.dueDay, f.since), category: 'other', purpose: 'personal',
    essential: true, active: f.active !== false, source: 'manual', confidence: 1,
    locks: LOCKS.slice(), since: f.since,
    byHand: true, dueDay: f.dueDay,
    payee: typeof f.payee === 'string' && f.payee ? f.payee : null,
    payeeAt: Number.isFinite(f.payeeAt) ? f.payeeAt : 0,
    marks: isObject(f.marks) ? copyOf(f.marks) : {},
    skips: isObject(f.skips) ? copyOf(f.skips) : {},
    editedAt: Number.isFinite(f.editedAt) ? f.editedAt : 0,
  });
  if (typeof f.id === 'string' && f.id) entry.id = f.id;
  return entry;
}

/**
 * Add a payment the owner sends. `since` is the first day of the month of `today`, so this month's
 * payment is on the list even when its day has passed.
 * @param {object} state  (mutated)
 * @param {{ name: string, amount: number, dueDay: number }} fields  name 1..60 characters after trimming,
 *        amount whole cents from 1 to 10^10, dueDay a whole number 1..31
 * @param {string} today  the game day
 * @param {number} nowMs
 * @returns {object|null} the entry, or null when a field is not acceptable
 */
export function addByHand(state, fields, today, nowMs) {
  if (!isObject(state) || !isObject(fields) || !isYmd(today)) return null;
  const name = nameOf(fields.name);
  if (name === null || !isAmount(fields.amount) || !isDueDay(fields.dueDay)) return null;
  const entry = makeByHand({
    name, amount: fields.amount, dueDay: fields.dueDay, since: startOfMonth(monthOf(today)), editedAt: stamp(nowMs),
  });
  if (!Array.isArray(state.recurring)) state.recurring = [];
  state.recurring.push(entry);
  return entry;
}

/**
 * Change a payment the owner sends. A change of the amount or of the day starts the schedule again:
 * from the first day of this month when this month's occurrence (under the terms before the change)
 * is not paid, else from the first day of next month. Switching it on again starts it from the first
 * day of this month. A change of the name alone changes nothing else. Sets `editedAt`.
 * @returns {boolean} true when the entry was changed; false for an unknown id, an unacceptable field, or no change
 */
export function editByHand(state, id, changes, today, nowMs) {
  const entry = entryOf(state, id);
  if (!entry || !isObject(changes) || !isYmd(today)) return false;
  const next = { name: entry.name, amount: entry.amount, dueDay: entry.dueDay, active: !!entry.active };
  if (changes.name !== undefined) {
    next.name = nameOf(changes.name);
    if (next.name === null) return false;
  }
  if (changes.amount !== undefined) {
    if (!isAmount(changes.amount)) return false;
    next.amount = changes.amount;
  }
  if (changes.dueDay !== undefined) {
    if (!isDueDay(changes.dueDay)) return false;
    next.dueDay = changes.dueDay;
  }
  if (changes.active !== undefined) {
    if (typeof changes.active !== 'boolean') return false;
    next.active = changes.active;
  }
  const terms = next.amount !== entry.amount || next.dueDay !== entry.dueDay;
  const switchedOn = next.active && !entry.active;
  if (!terms && !switchedOn && next.name === entry.name && next.active === !!entry.active) return false;

  const thisMonth = startOfMonth(monthOf(today));
  let since = entry.since;
  if (terms) since = paidThisMonth(state, entry, today) ? startOfMonth(addMonthsYm(monthOf(today), 1)) : thisMonth;
  if (switchedOn) since = thisMonth;
  entry.name = next.name;
  entry.amount = next.amount;
  entry.dueDay = next.dueDay;
  entry.active = next.active;
  if (terms || switchedOn) {
    entry.since = since;
    entry.anchor = anchorFor(entry.dueDay, since);
  }
  entry.editedAt = stamp(nowMs);
  return true;
}

/**
 * Remove a payment the owner sends, and record the removal so that it reaches the other devices.
 * @returns {boolean}
 */
export function removeByHand(state, id, nowMs) {
  const entry = entryOf(state, id);
  if (!entry) return false;
  state.recurring.splice(state.recurring.indexOf(entry), 1);
  tombsOf(state)[entry.id] = stamp(nowMs);
  return true;
}

/**
 * Tick an occurrence as paid, or take the tick back (an untick is kept, so that it travels).
 * @param {string} day  one of the entry's occurrences
 * @returns {boolean}
 */
export function tickByHand(state, id, day, paid, nowMs) {
  const entry = entryOf(state, id);
  if (!entry || !isYmd(day) || typeof paid !== 'boolean') return false;
  if (!occurrences(entry, addDays(day, -1), day).includes(day)) return false;
  if (!isObject(entry.marks)) entry.marks = {};
  entry.marks[day] = { paid, at: stamp(nowMs) };
  return true;
}

/**
 * "This row is not that payment": the row, and any row of the same payee within 3 days of it, is never
 * taken for this entry again. When no other row of that payee stays with the entry, the entry forgets
 * the payee, and the skip bars it from being learned again.
 * @returns {boolean}
 */
export function skipRow(state, id, txId, nowMs) {
  const entry = entryOf(state, id);
  const tx = entry && typeof txId === 'string' ? listOf(state.txs).find((row) => isObject(row) && row.id === txId) : null;
  if (!tx || !isYmd(tx.day)) return false;
  const key = payeeKey(tx.mkey);
  if (key === '') return false;
  if (!isObject(entry.skips)) entry.skips = {};
  entry.skips[tx.day + '|' + key] = { on: true, at: stamp(nowMs) };
  if (entry.payee === key) {
    const accounts = accountsOf(state);
    const stays = listOf(state.txs).some((row) => row !== tx && isSent(accounts, row, FAR_DAY) && couldBeRowOf(entry, row, payeeKey(row.mkey)));
    if (!stays) {
      entry.payee = null;
      entry.payeeAt = stamp(nowMs);
    }
  }
  return true;
}

/* ------------------------------------------------------------- the bank rows */

/**
 * Which bank rows belong to which payment the owner sends. The sent rows (posted and pending alike)
 * are first shared out among the entries that could want them, by rules that read nothing a device
 * made: a row of exactly the amount of several entries goes to the one with a day nearest the row's
 * (the schedule read both ways without end; then the earlier day, then the smaller id); a row whose
 * payee an entry of that amount holds goes to the holders, unless the entry without a payee has rows
 * of that payee in two calendar months of its own share. An entry without a payee then tries to learn
 * one from the posted rows in its own share, which may set its `payee` and `payeeAt`; and so again
 * until nothing changes. A payee that another entry of the same amount holds is learned from such a
 * history only, never from one row. The rows of an entry with a payee are the rows of that payee, not
 * skipped, that are of its exact amount and in its share, or dated before its `since` and the payment
 * of a day of its schedule before `since` (leadsItsDay). An entry still without a payee takes the one
 * pending row its payee would be learned from, were it posted; nothing is written for it.
 * `recurringId` is never read, and nothing depends on the order of the rows or of the entries, so the
 * same document gives the same links on every device.
 * @param {object} state  (payees may be set)
 * @param {string} today  the game day
 * @param {number} nowMs
 * @returns {Map<string, string>} row id -> entry id
 */
export function claimByHand(state, today, nowMs) {
  if (!isObject(state) || !isYmd(today)) return new Map();
  const entries = activeEntries(state);
  if (!entries.length) return new Map();
  const accounts = accountsOf(state);
  const keys = new Map();
  const keyOf = (tx) => {
    if (!keys.has(tx.mkey)) keys.set(tx.mkey, payeeKey(tx.mkey));
    return keys.get(tx.mkey);
  };
  const sent = listOf(state.txs).filter((tx) => isSent(accounts, tx, today) && keyOf(tx) !== '');
  const until = addDays(today, AHEAD_DAYS);
  const schedules = new Map(entries.map((entry) => [entry, occurrences(entry, FIRST_DAY, until)]));

  // each lesson changes who could want which row, so the rows are shared out again until nothing is learned
  const from = addDays(today, -PAST_DAYS);
  let shared = shareOut(entries, sent, keyOf, from);
  for (let pass = 0; pass < entries.length; pass++) {
    if (!learnPayees(entries, shared.open, keyOf, schedules, from, stamp(nowMs))) break;
    shared = shareOut(entries, sent, keyOf, from);
  }
  // an entry that still has no payee takes the pending row this payment would be learned from, were it
  // posted: the row is linked like any pending row, and nothing is written, so nothing stays if it vanishes
  for (const entry of entries) {
    if (entry.payee) continue;
    const waiting = (shared.open.get(entry) || []).filter((tx) => tx.pending && looksByHand(tx) && !heldByAnother(entries, entry, keyOf(tx)));
    const row = fromThisPayment(entry, waiting, keyOf, schedules.get(entry));
    if (row !== null) shared.claims.set(row.id, entry.id);
  }
  return shared.claims;
}

/**
 * The payees of the payments the owner sends that have an occurrence no bank row settles (unpaid, or
 * ticked with no row: a tick says the payment was made, and a row of another amount to that payee is
 * then that payment), each with the day of the month of every such payment and the days of those
 * occurrences (through 16 days past `today`), read from this run's claims and not from what a row was
 * linked to before. Detection asks it before it keeps or makes a line of rows to such a payee (E9 F1).
 * @param {object} state
 * @param {Map<string, string>} claims  row id -> entry id, as claimByHand returns it
 * @param {string} today  the game day
 * @returns {Map<string, { dueDay: number, days: string[] }[]>} payee fingerprint -> its payments' unpaid occurrence days
 */
export function unpaidByPayee(state, claims, today) {
  const owed = new Map();
  if (!isObject(state) || !isYmd(today) || !(claims instanceof Map)) return owed;
  const counted = countsPending(state);
  const rows = new Map();
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || !claims.has(tx.id) || (tx.pending && !counted)) continue;
    const id = claims.get(tx.id);
    if (!rows.has(id)) rows.set(id, []);
    rows.get(id).push(tx);
  }
  for (const entry of activeEntries(state)) {
    if (!entry.payee || !isDueDay(entry.dueDay)) continue;
    const days = byHandStanding(entry, rows.get(entry.id) || [], addDays(today, OTHER_REACH_DAYS))
      .filter((item) => item.row === null)
      .map((item) => item.day);
    if (!days.length) continue;
    if (!owed.has(entry.payee)) owed.set(entry.payee, []);
    owed.get(entry.payee).push({ dueDay: entry.dueDay, days });
  }
  return owed;
}

/**
 * Share the sent rows out. A row of exactly the amount of one or more entries that could want it (an
 * entry holding the row's payee, or one without a payee that the payee is not barred from) goes to the
 * nearest of them: to its links when it holds the payee, else among the rows it may learn from. Any
 * other row is history: it goes to the nearest of the entries that hold its payee and began after it.
 * @returns {{ claims: Map<string, string>, open: Map<object, object[]> }}
 */
function shareOut(entries, sent, keyOf, from) {
  const claims = new Map();
  const open = new Map();
  const contested = []; // rows that fell to an entry without a payee though an entry of that amount holds their payee
  const barred = new Map(entries.map((entry) => [entry, barredOf(entry)]));
  const byPayee = new Map();
  for (const tx of sent) {
    if (!byPayee.has(keyOf(tx))) byPayee.set(keyOf(tx), []);
    byPayee.get(keyOf(tx)).push(tx);
  }
  for (const tx of sent) {
    const key = keyOf(tx);
    const amount = Math.round(tx.amount);
    const could = entries.filter((entry) => !isSkipped(entry, tx, key) && (entry.payee ? entry.payee === key : !barred.get(entry).has(key)));
    const exact = could.filter((entry) => entry.amount === amount);
    if (exact.length) {
      const winner = nearestEntry(exact, tx.day);
      if (winner.payee) claims.set(tx.id, winner.id);
      else {
        if (open.has(winner)) open.get(winner).push(tx);
        else open.set(winner, [tx]);
        const holders = exact.filter((entry) => entry.payee);
        if (holders.length) contested.push({ tx, key, winner, holders });
      }
      continue;
    }
    const winner = nearestEntry(could.filter((entry) => entry.payee && isYmd(entry.since) && tx.day < entry.since), tx.day);
    if (winner !== null && leadsItsDay(winner, tx, byPayee.get(key), key)) claims.set(tx.id, winner.id);
  }
  // such a row stays with the entry without a payee only when that entry has a history with the payee
  // (posted rows in two calendar months of its own share, E2(a)); otherwise it goes to the holders
  const histories = new Map();
  for (const { tx, key, winner, holders } of contested) {
    if (!histories.has(winner)) histories.set(winner, regularPayees(winner, open.get(winner).filter((row) => !row.pending && looksByHand(row)), keyOf, from));
    if (histories.get(winner).has(key)) continue;
    claims.set(tx.id, nearestEntry(holders, tx.day).id);
  }
  for (const { tx, winner } of contested) {
    if (claims.has(tx.id)) open.set(winner, open.get(winner).filter((row) => row !== tx));
  }
  return { claims, open };
}

/** Whether another entry of the same amount holds this payee: such a payee is learned from a history only (E2(a)). */
function heldByAnother(entries, entry, key) {
  return entries.some((other) => other !== entry && other.payee === key && other.amount === entry.amount);
}

/**
 * Whether a history row of another amount is the payment of its day: its day of the schedule (read
 * both ways) lies before the entry began, and no row of the entry's own amount, and no nearer (or as
 * near and earlier) row of that payee, sits on that same day. A second, different payment to the same payee (another amount, another day
 * of the month) is thereby left to detection, which may have a line of it.
 */
function leadsItsDay(entry, tx, rows, key) {
  const mine = nearestDue(entry.dueDay, tx.day);
  if (mine.day >= entry.since) return false; // nearer the entry's first days than any day before it began
  for (const other of rows) {
    if (other === tx || other.day >= entry.since || isSkipped(entry, other, key)) continue;
    const theirs = nearestDue(entry.dueDay, other.day);
    if (theirs.day !== mine.day) continue;
    if (Math.round(other.amount) === entry.amount) return false;
    if (theirs.gap < mine.gap || (theirs.gap === mine.gap && other.day < tx.day)) return false;
  }
  return true;
}

/** Of several entries, the one with a day nearest `day` (then the earlier such day, then the smaller id), or null. */
function nearestEntry(entries, day) {
  let best = null;
  for (const entry of entries) {
    const near = nearestDue(entry.dueDay, day);
    const candidate = { entry, gap: near.gap, day: near.day };
    if (best === null || closer(candidate, best)) best = candidate;
  }
  return best === null ? null : best.entry;
}

/** The day of a monthly schedule kept on `dueDay` nearest `day` (the earlier on a tie), the schedule read both ways without end. */
function nearestDue(dueDay, day) {
  const first = startOfMonth(monthOf(day));
  let best = null;
  for (const step of [-1, 0, 1]) {
    const occurrence = addMonths(first, step, dueDay);
    const gap = Math.abs(diffDays(occurrence, day));
    if (best === null || gap < best.gap) best = { day: occurrence, gap };
  }
  return best;
}

/**
 * One pass of learning: every entry without a payee reads the rows in its own share.
 * A pending row teaches nothing: the bank often words it otherwise than the posted row, and it may vanish.
 * @returns {boolean} true when a payee was learned
 */
function learnPayees(entries, open, keyOf, schedules, from, at) {
  let learned = false;
  for (const entry of entries) {
    if (entry.payee) continue;
    const rows = (open.get(entry) || []).filter((tx) => !tx.pending && looksByHand(tx));
    // a payee another entry of this amount holds is learned from the past only, never from one row
    const single = fromThisPayment(entry, rows.filter((tx) => !heldByAnother(entries, entry, keyOf(tx))), keyOf, schedules.get(entry));
    const payee = fromThePast(entry, rows, keyOf, from) || (single === null ? null : keyOf(single));
    if (!payee) continue;
    entry.payee = payee;
    entry.payeeAt = at;
    learned = true;
  }
  return learned;
}

/**
 * E2(a): the one payee paid this amount in two different months of the last 100 days; of several, the
 * one whose rows lie within 5 days of the entry's days on average, when no other does.
 */
function fromThePast(entry, rows, keyOf, from) {
  const seen = pastPayees(entry, rows, keyOf, from);
  const regular = [...seen].filter(([, one]) => one.months.size >= 2);
  if (regular.length === 1) return regular[0][0];
  const near = regular.filter(([, one]) => one.gaps <= NEAR_MEAN_DAYS * one.count);
  return near.length === 1 ? near[0][0] : null;
}

/** The payees with rows in two different calendar months of the last 100 days, among the rows given. */
function regularPayees(entry, rows, keyOf, from) {
  return new Set([...pastPayees(entry, rows, keyOf, from)].filter(([, one]) => one.months.size >= 2).map(([key]) => key));
}

/** The rows of the last 100 days by payee: payee -> { months, gaps, count }. */
function pastPayees(entry, rows, keyOf, from) {
  const seen = new Map();
  for (const tx of rows) {
    if (tx.day <= from) continue;
    const key = keyOf(tx);
    if (!seen.has(key)) seen.set(key, { months: new Set(), gaps: 0, count: 0 });
    const one = seen.get(key);
    one.months.add(monthOf(tx.day));
    one.gaps += nearestDue(entry.dueDay, tx.day).gap;
    one.count += 1;
  }
  return seen;
}

/** E2(b): the row nearest one of the entry's days since it began, within 16 days of it (the row itself, or null). */
function fromThisPayment(entry, rows, keyOf, schedule) {
  let best = null;
  for (const tx of rows) {
    if (isYmd(entry.since) && tx.day < entry.since) continue;
    const near = nearest(schedule, tx.day);
    if (near === null || near.gap > LEARN_REACH_DAYS) continue;
    const candidate = { gap: near.gap, day: near.day, rowDay: tx.day, key: keyOf(tx), tx };
    if (best === null || closerRow(candidate, best)) best = candidate;
  }
  return best === null ? null : best.tx;
}

/** Nearer occurrence first, then the earlier occurrence, then the smaller entry id. */
function closer(a, b) {
  if (a.gap !== b.gap) return a.gap < b.gap;
  if (a.day !== b.day) return a.day < b.day;
  return a.entry.id < b.entry.id;
}

/** Among the rows one entry could learn from: the nearest, then the earlier occurrence, the earlier row, the smaller fingerprint, the smaller id. */
function closerRow(a, b) {
  if (a.gap !== b.gap) return a.gap < b.gap;
  if (a.day !== b.day) return a.day < b.day;
  if (a.rowDay !== b.rowDay) return a.rowDay < b.rowDay;
  if (a.key !== b.key) return a.key < b.key;
  return a.tx.id < b.tx.id;
}

/** The day of an ascending schedule nearest `day` (the earlier one on a tie) and how far it is, or null. */
function nearest(schedule, day) {
  let best = null;
  for (const occurrence of schedule || []) {
    const gap = Math.abs(diffDays(occurrence, day));
    if (best === null || gap < best.gap) best = { day: occurrence, gap };
  }
  return best;
}

const FAR_DAY = '9999-12-31';

/**
 * A sent row: the bank reported it (not typed in, not a decline, not superseded), money going out of a
 * shown cash account, not a move between the owner's own accounts, dated on or before `today`;
 * posted or pending.
 */
function isSent(accounts, tx, today) {
  if (!isObject(tx) || typeof tx.id !== 'string' || tx.source === 'manual' || tx.kind === 'decline' || tx.matchId) return false;
  if (tx.flow !== 'out' || tx.pairId != null || !isYmd(tx.day) || tx.day > today) return false;
  if (!Number.isFinite(tx.amount) || !(tx.amount > 0) || typeof tx.mkey !== 'string') return false;
  const account = accounts.get(tx.accountId);
  return !!account && !account.hidden && ACCOUNT_TYPES[account.type].group === 'cash';
}

/** Sent the way the owner sends money to a person: a Zelle, a wallet payment, or a transfer that is not between their own accounts or institutions. */
function looksByHand(tx) {
  if (SENT_BY_HAND.has(tx.ruleId)) return true;
  return tx.kind === 'transfer' && !NOT_BY_HAND.has(tx.ruleId);
}

/** A sent row of the entry's payee that could be the entry's: not skipped, and of its exact amount or dated before it began (skipRow asks it). */
function couldBeRowOf(entry, tx, key) {
  if (entry.payee !== key || isSkipped(entry, tx, key)) return false;
  return Math.round(tx.amount) === entry.amount || (isYmd(entry.since) && tx.day < entry.since);
}

function isSkipped(entry, tx, key) {
  for (const [day, skipped] of skipsOf(entry)) {
    if (skipped === key && Math.abs(diffDays(day, tx.day)) <= SKIP_REACH_DAYS) return true;
  }
  return false;
}

/** The skips of an entry that are on, as [day, payee fingerprint]. */
function skipsOf(entry) {
  const out = [];
  if (!isObject(entry.skips)) return out;
  for (const name of Object.keys(entry.skips)) {
    const skip = entry.skips[name];
    const cut = name.indexOf('|');
    if (!isObject(skip) || skip.on !== true || cut < 0 || !isYmd(name.slice(0, cut))) continue;
    out.push([name.slice(0, cut), name.slice(cut + 1)]);
  }
  return out;
}

/** The payees an entry will never learn again: every one a skip that is on names. */
function barredOf(entry) {
  return new Set(skipsOf(entry).map(([, key]) => key));
}

/* --------------------------------------------------------------- after Undo */

/**
 * Make the by-hand content of `after` (a document Undo has just put back) the newest, so that it wins
 * on the other devices too. Compared with `before`, the document as it was just before the Undo: an
 * entry `before` lacks is stamped and its tomb deleted; an entry whose name, amount, day, `since` or
 * switch differ is stamped; every mark and skip that differs, or that `after` lacks, is written with
 * the present time (a missing one as paid false / on false); a payee that differs is stamped; an entry
 * `after` lacks gets a tomb.
 * @returns {boolean} true when anything was written
 */
export function restampByHand(before, after, nowMs) {
  if (!isObject(after)) return false;
  const at = stamp(nowMs);
  const was = new Map(byHandEntries(before).map((entry) => [entry.id, entry]));
  const now = new Map(byHandEntries(after).map((entry) => [entry.id, entry]));
  let wrote = false;
  for (const entry of now.values()) {
    const old = was.get(entry.id);
    if (!old) {
      entry.editedAt = at;
      if (isObject(after.share) && isObject(after.share.tombs)) delete after.share.tombs[entry.id];
      wrote = true;
      continue;
    }
    if (['name', 'amount', 'dueDay', 'since', 'active'].some((field) => entry[field] !== old[field])) {
      entry.editedAt = at;
      wrote = true;
    }
    if (restampMap(entry, old, 'marks', 'paid', at)) wrote = true;
    if (restampMap(entry, old, 'skips', 'on', at)) wrote = true;
    if ((entry.payee || null) !== (old.payee || null)) {
      entry.payeeAt = at;
      wrote = true;
    }
  }
  for (const id of was.keys()) {
    if (now.has(id)) continue;
    tombsOf(after)[id] = at;
    wrote = true;
  }
  return wrote;
}

function restampMap(entry, old, field, flag, at) {
  const mine = isObject(entry[field]) ? entry[field] : (entry[field] = {});
  const theirs = isObject(old[field]) ? old[field] : {};
  let wrote = false;
  for (const name of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const a = Object.hasOwn(mine, name) && isObject(mine[name]) ? mine[name] : null;
    const b = Object.hasOwn(theirs, name) && isObject(theirs[name]) ? theirs[name] : null;
    if (a !== null && b !== null && a[flag] === b[flag] && a.at === b.at) continue;
    mine[name] = { [flag]: a !== null && a[flag] === true, at };
    wrote = true;
  }
  return wrote;
}

/* ------------------------------------------------------------- the checklist */

/**
 * The checklist of a month: every occurrence of the month of `today`, in day order, and before them
 * every earlier occurrence still unpaid (per payment, at most the 12 newest).
 *  status 'bank'     a posted row settles it: paidDay its day, txId its id, merchant its display name, amount its amount
 *         'pending'  the same with a row the bank has not posted yet (it settles because `countPending` is on)
 *         'hand'     ticked by the owner and no row yet: paidDay the game day of the tick
 *         'due'      unpaid, its day is today or ahead: daysTo the days until it
 *         'overdue'  unpaid, its day has passed: daysTo negative
 * For a row 'due', 'overdue' or 'hand', pendingDay / pendingTxId report a pending row that would
 * settle that very occurrence once it posts (else null): the standing is read with and without the
 * entry's pending rows and the two are compared occurrence by occurrence. For a row 'due' or
 * 'overdue', otherDay / otherTxId / otherAmount report a posted row of the entry's payee of another
 * amount, since the entry began, not skipped, not linked to another line of the Book and not of the
 * amount of another entry of that payee,
 * whose nearest occurrence this is, within 16 days (else null). `paid` and `count` count the rows of
 * this month; `unpaid` is the cents of every row 'due' or 'overdue'; `transit` the cents of the rows
 * 'hand' ticked within the last 4 days (the bank's balance still holds that money), and of any
 * occurrence of an earlier month ticked within those 4 days and not yet at the bank (it is paid, so
 * it has no row). Entries that do not run have no rows.
 * @param {object} state
 * @param {string} today  the game day
 * @param {number} nowMs
 * @returns {{ ym: string, rows: { entry: object, day: string, amount: number, status: string, paidDay: string|null,
 *             txId: string|null, merchant: string|null, pendingDay: string|null, pendingTxId: string|null,
 *             otherDay: string|null, otherTxId: string|null, otherAmount: number|null,
 *             daysTo: number|null }[], paid: number, count: number, unpaid: number, transit: number }}
 */
export function byHandMonth(state, today, nowMs) {
  const month = { ym: isYmd(today) ? monthOf(today) : '', rows: [], paid: 0, count: 0, unpaid: 0, transit: 0 };
  if (!isObject(state) || !isYmd(today)) return month;
  const entries = activeEntries(state);
  if (!entries.length) return month;
  const first = startOfMonth(month.ym);
  const last = endOfMonth(month.ym);
  const accounts = accountsOf(state);
  const byId = new Map();
  for (const tx of listOf(state.txs)) if (isObject(tx) && typeof tx.id === 'string') byId.set(tx.id, tx);
  const rollover = rolloverOf(state);
  const now = stamp(nowMs);
  const earlier = [];
  const current = [];
  // the posted sent rows by payee, read once and only when an unpaid occurrence asks: a row is fingerprinted once, not once per entry
  let posted = null;
  const postedOf = (payee) => {
    if (posted === null) {
      posted = new Map();
      const keys = new Map();
      for (const tx of listOf(state.txs)) {
        if (!isSent(accounts, tx, today) || tx.pending) continue;
        if (!keys.has(tx.mkey)) keys.set(tx.mkey, payeeKey(tx.mkey));
        const key = keys.get(tx.mkey);
        if (posted.has(key)) posted.get(key).push(tx);
        else posted.set(key, [tx]);
      }
    }
    return posted.get(payee) || [];
  };

  for (const entry of entries) {
    const standing = byHandStandingOf(state, entry, last);
    const pending = pendingOf(standing, byHandStandingOf(state, entry, last, true));
    const others = othersOf(postedOf, entries, entry, last);
    const arrears = standing.filter((item) => item.day < first && item.row === null && !(item.tick && item.tick.paid));
    const shown = arrears.slice(Math.max(0, arrears.length - BY_HAND_ARREARS)).concat(standing.filter((item) => item.day >= first));
    // an earlier month's payment ticked in the last days is no longer on the list, and its money is still on its way
    for (const item of standing) {
      if (item.day < first && item.row === null && item.tick && item.tick.paid && now - item.tick.at < TRANSIT_MS) month.transit += entry.amount;
    }
    for (const item of shown) {
      const row = {
        entry, day: item.day, amount: entry.amount, status: 'due', paidDay: null, txId: null, merchant: null,
        pendingDay: null, pendingTxId: null, otherDay: null, otherTxId: null, otherAmount: null, daysTo: null,
      };
      const tx = item.row === null ? null : byId.get(item.row.id) || null;
      if (item.row !== null) {
        row.status = item.row.pending ? 'pending' : 'bank';
        row.paidDay = item.row.day;
        row.txId = item.row.id;
        row.merchant = tx ? (typeof tx.merchant === 'string' && tx.merchant ? tx.merchant : tx.mkey) : null;
        if (tx && Number.isFinite(tx.amount)) row.amount = Math.round(tx.amount);
      } else {
        if (item.tick && item.tick.paid) {
          row.status = 'hand';
          row.paidDay = gameDay(item.tick.at, rollover);
          if (now - item.tick.at < TRANSIT_MS) month.transit += row.amount;
        } else {
          row.daysTo = diffDays(today, item.day);
          row.status = row.daysTo >= 0 ? 'due' : 'overdue';
          month.unpaid += row.amount;
          const other = others.get(item.day);
          if (other) {
            row.otherDay = other.day;
            row.otherTxId = other.id;
            row.otherAmount = other.amount;
          }
        }
        const waiting = pending.get(item.day);
        if (waiting) {
          row.pendingDay = waiting.day;
          row.pendingTxId = waiting.id;
        }
      }
      (item.day < first ? earlier : current).push(row);
    }
  }
  earlier.sort(inDayOrder);
  current.sort(inDayOrder);
  month.rows = earlier.concat(current);
  month.count = current.length;
  month.paid = sum(current, (row) => (row.status === 'bank' || row.status === 'pending' || row.status === 'hand' ? 1 : 0));
  return month;
}

/**
 * The pending rows that would settle an occurrence once they post, by that occurrence: the standing
 * as it is (`without`) against the standing read with the entry's pending rows (`withPending`),
 * occurrence by occurrence. An occurrence that has no row in the first and one in the second is
 * settled by the pending rows: by the pending row now on it, or, when a posted row moved onto it,
 * by the pending row that took that posted row's place (the oldest such first). No row id is compared.
 * @returns {Map<string, { id: string, day: string }>} occurrence day -> pending row
 */
function pendingOf(without, withPending) {
  const out = new Map();
  const had = new Map(without.map((item) => [item.day, item]));
  const displacers = [];
  for (const item of withPending) {
    const before = had.get(item.day);
    if (item.row !== null && item.row.pending && before && before.row !== null) displacers.push(item.row);
  }
  for (const item of withPending) {
    const before = had.get(item.day);
    if (!before || before.row !== null || item.row === null) continue;
    const row = item.row.pending ? item.row : displacers.shift();
    if (row) out.set(item.day, row);
  }
  return out;
}

/**
 * The posted rows of the entry's payee of another amount, by the occurrence each is nearest (within
 * 16 days): the bank shows a payment to this payee that is not the amount the entry holds. A row
 * linked to another line of the Book is that line's charge and is never reported (the links are read
 * as the refresh left them, as the standing is; this decides no link).
 * @param {(payee: string) => object[]} postedOf  the posted sent rows of a payee
 * @returns {Map<string, { id: string, day: string, amount: number }>} occurrence day -> row
 */
function othersOf(postedOf, entries, entry, untilDay) {
  const out = new Map();
  if (!entry.payee) return out;
  const schedule = occurrences(entry, FIRST_DAY, addDays(untilDay, AHEAD_DAYS));
  const gaps = new Map();
  for (const tx of postedOf(entry.payee)) {
    if (isSkipped(entry, tx, entry.payee)) continue;
    if (tx.recurringId != null && tx.recurringId !== entry.id) continue; // the charge of another line of the Book
    const amount = Math.round(tx.amount);
    if (amount === entry.amount || (isYmd(entry.since) && tx.day < entry.since)) continue;
    if (entries.some((other) => other !== entry && other.payee === entry.payee && other.amount === amount)) continue;
    const near = nearest(schedule, tx.day);
    if (near === null || near.gap > OTHER_REACH_DAYS) continue;
    const held = out.get(near.day);
    const gap = gaps.get(near.day);
    if (held && (gap < near.gap || (gap === near.gap && (held.day < tx.day || (held.day === tx.day && held.id <= tx.id))))) continue;
    out.set(near.day, { id: tx.id, day: tx.day, amount });
    gaps.set(near.day, near.gap);
  }
  return out;
}

function inDayOrder(a, b) {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.entry.name !== b.entry.name) return a.entry.name < b.entry.name ? -1 : 1;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

/* ------------------------------------------------------------------ helpers */

/** The first occurrence of a day of the month on or after `since`: in its month, or in the next when that day is already behind it. */
function anchorFor(dueDay, since) {
  if (!isDueDay(dueDay) || !isYmd(since)) return '';
  const inMonth = addMonths(startOfMonth(monthOf(since)), 0, dueDay);
  return inMonth >= since ? inMonth : addMonths(startOfMonth(monthOf(since)), 1, dueDay);
}

/** Whether this month's occurrence is paid: by a row or by a tick. A month without an occurrence (the schedule starts later) has nothing left to pay. */
function paidThisMonth(state, entry, today) {
  const ym = monthOf(today);
  const item = byHandStandingOf(state, entry, endOfMonth(ym)).find((one) => monthOf(one.day) === ym);
  return !item || item.row !== null || !!(item.tick && item.tick.paid);
}

function byHandEntries(state) {
  if (!isObject(state)) return [];
  return listOf(state.recurring).filter((entry) => isObject(entry) && entry.byHand === true && typeof entry.id === 'string' && entry.id !== '');
}

/** The entries that run (book.runsByHand); smallest id first, so that every device reads them in one order. */
function activeEntries(state) {
  return byHandEntries(state)
    .filter(runsByHand)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function entryOf(state, id) {
  if (typeof id !== 'string') return null;
  return byHandEntries(state).find((entry) => entry.id === id) || null;
}

function accountsOf(state) {
  const accounts = new Map();
  for (const account of listOf(state.accounts)) {
    if (!isObject(account) || typeof account.id !== 'string' || !Object.hasOwn(ACCOUNT_TYPES, account.type)) continue;
    if (!accounts.has(account.id)) accounts.set(account.id, account);
  }
  return accounts;
}

/** Whether pending rows count, as the ledger reads the setting: on unless it was switched off. */
function countsPending(state) {
  const settings = isObject(state.settings) ? state.settings : {};
  return settings.countPending === undefined ? true : !!settings.countPending;
}

function tombsOf(state) {
  if (!isObject(state.share)) state.share = { tombs: {} };
  if (!isObject(state.share.tombs)) state.share.tombs = {};
  return state.share.tombs;
}

function rolloverOf(state) {
  const hour = isObject(state.settings) ? state.settings.rolloverHour : null;
  return Number.isFinite(hour) && hour >= 0 && hour < 24 ? hour : 0;
}

function nameOf(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : null;
}

function isAmount(value) {
  return Number.isInteger(value) && value >= 1 && value <= AMOUNT_MAX;
}

function isDueDay(value) {
  return Number.isInteger(value) && value >= 1 && value <= LAST_DAY;
}

function stamp(nowMs) {
  return Number.isFinite(nowMs) ? nowMs : 0;
}

function copyOf(map) {
  const out = {};
  for (const key of Object.keys(map)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !isObject(map[key])) continue;
    out[key] = { ...map[key] };
  }
  return out;
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}
