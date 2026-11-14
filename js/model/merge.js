/**
 * Folds a bank feed into the document. See ARCHITECTURE.md section 3.2.
 * Pure (mutates only the state it is given). Imports: schema, dates, money, classify. Must NOT import detect or ledger.
 *
 * How a feed row is read
 *  - Its text is the bank's description; when the bank sent none, the payee, else the memo. The
 *    document keeps one text per move (`raw`) and classification is always re-run from it, so
 *    nothing else may decide who the merchant is.
 *  - Its day is the game day of `at` when the bank gives one, else of `posted`. A pending row with
 *    no date at all is dated the day it was first fetched and keeps that day from then on.
 *  - It is pending when the provider says so, or when it has neither a posting time nor a time it
 *    happened. A row with no posting time that is not flagged pending and has a time it happened
 *    posted on that day.
 *  - Rows fetched from the sample feed (`src: 'demo'`) are stored with `source: 'demo'`; every rule
 *    here treats them exactly like bank rows. Only `source: 'manual'` rows belong to the owner.
 */

import { ACCOUNT_TYPES, CATEGORIES, klassOf, makeAccount, makeTx } from './schema.js';
import { addDays, diffDays, feedDay, feedHasTime, gameDay, isYmd } from './dates.js';
import { roundCents } from './money.js';
import { classify, inferAccountType, merchantOf, normalizeDescription, reclassify } from './classify.js';
import { rebuildIncome } from './income.js';

/**
 * @typedef {Object} MergeSummary
 * @property {number} accountsAdded
 * @property {number} added        transactions inserted
 * @property {number} updated      transactions updated (pending -> posted, amount or id change)
 * @property {number} removed      stale pending rows removed
 * @property {number} matched      provisional (manual) moves confirmed by a bank row
 * @property {number} paired       transfer / card-payment pairs linked
 * @property {string[]} newTxIds   ids of the inserted transactions
 */

/** An unmatched provisional move counts on its own day and for this many days after it. */
export const PROVISIONAL_STALE_DAYS = 7;

/** A posted row settles a stored pending row of the same merchant within these limits (tips). */
const SETTLE_AMOUNT_TOLERANCE = 0.25;
const SETTLE_DAY_WINDOW = 5;
/** A bank spend confirms a provisional move within these limits. */
const CONFIRM_AMOUNT_TOLERANCE = 0.15;
const CONFIRM_DAY_WINDOW = 3;
/** A bank spend confirms a card alert's move from its amount up to 35% more (a tip raises a charge), dated on its day or up to 5 days after. */
const ALERT_CONFIRM_RISE = 35;
const ALERT_CONFIRM_DAYS = 5;
/** On a card the bank gives no rows of, an alert's move is taken in by a balance dated this many days after it at the latest. */
const BALANCE_ONLY_DAYS = 4;
/** An alert move the owner removed is remembered this many days (state.alertsRemoved). */
export const ALERT_REMOVED_DAYS = 30;
const PAIR_DAY_WINDOW = 3;
/** A debt reported as a positive number is recognised when its balance mirrors its own rows this closely. */
const FLIP_TOLERANCE = 0.1;
const FLIP_TOLERANCE_CENTS = 100;
/** A card first seen "in credit" by more than this is far more likely a debt reported as a positive number. */
const FIRST_SIGHT_CREDIT_CENTS = 5000;
const DEFAULT_ROLLOVER_HOUR = 4;
/** Stands in for the day in the fingerprint of a pending row the bank has not dated. */
const UNDATED = 'pending';
const MAX_NAME = 120;
const MAX_NOTE = 500;
const MAX_RAW = 500;
const MOVE_KINDS = new Set(['transfer', 'payment']);
const PAIRABLE_KINDS = new Set(['spend', 'income', 'refund', 'transfer', 'payment']);

/* ------------------------------------------------------------------- helpers */

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function secondsOf(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function centsOf(value) {
  return Number.isFinite(value) ? roundCents(value) : null;
}

function isFeedRow(tx) {
  return isRecord(tx) && tx.source !== 'manual';
}

function isProvisional(tx) {
  return isRecord(tx) && tx.source === 'manual' && tx.kind === 'spend';
}

function groupOf(account) {
  return account && Object.hasOwn(ACCOUNT_TYPES, account.type) ? ACCOUNT_TYPES[account.type].group : 'cash';
}

function isDebtSide(account) {
  const group = groupOf(account);
  return group === 'card' || group === 'debt';
}

function rolloverOf(state) {
  const hour = isRecord(state.settings) ? state.settings.rolloverHour : null;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_ROLLOVER_HOUR;
}

function rulesOf(state) {
  return isRecord(state.settings) && Array.isArray(state.settings.rules) ? state.settings.rules : [];
}

function hasLock(tx, field) {
  return Array.isArray(tx.locks) && tx.locks.includes(field);
}

function emptySummary() {
  return { accountsAdded: 0, added: 0, updated: 0, removed: 0, matched: 0, paired: 0, newTxIds: [] };
}

function ensureShape(state) {
  if (!Array.isArray(state.accounts)) state.accounts = [];
  if (!Array.isArray(state.txs)) state.txs = [];
  if (!isRecord(state.sync)) state.sync = {};
  if (!Array.isArray(state.sync.problems)) state.sync.problems = [];
}

/**
 * True when an unmatched provisional move no longer counts: more than 7 days have passed since its day.
 * @param {object} tx
 * @param {string} today  today's game day
 */
export function isStaleProvisional(tx, today) {
  return isProvisional(tx) && !tx.matchId && tx.inBalance !== true && isYmd(tx.day) && isYmd(today) && diffDays(tx.day, today) > PROVISIONAL_STALE_DAYS;
}

/**
 * Stable fingerprint of a bank row: `${accountId}|${day}|${signedCents}|${normalisedDescription}#${k}`.
 * @param {string} accountId
 * @param {string} day
 * @param {number} signedCents
 * @param {string} description   raw description (normalised inside)
 * @param {number} k             occurrence index among identical rows in the same batch (0-based)
 * @returns {string}
 */
export function fingerprint(accountId, day, signedCents, description, k) {
  return fingerprintStem(accountId, day, signedCents, description) + k;
}

/** Everything of a fingerprint but the occurrence index: identical rows share it. */
function fingerprintStem(accountId, day, signedCents, description) {
  return [accountId, day, signedCents, normalizeDescription(description)].join('|') + '#';
}

/* ------------------------------------------------------------ reading the feed */

/** Everything about one merge that does not change while it runs. */
function makeContext(state, feed, nowMs) {
  const rollover = rolloverOf(state);
  const fetchedAt = Number.isFinite(feed.fetchedAt) ? feed.fetchedAt : nowMs;
  const fromMs = Number.isFinite(feed.fromMs) ? feed.fromMs : feed.from;
  const toMs = Number.isFinite(feed.toMs) ? feed.toMs : Number.isFinite(feed.to) ? feed.to : fetchedAt;
  const today = gameDay(nowMs, rollover);
  const troubledConns = new Set();
  const troubledAccounts = new Set();
  for (const problem of listOf(feed.errors)) {
    if (!isRecord(problem)) continue;
    if (textOf(problem.connId, MAX_NAME)) troubledConns.add(problem.connId.trim());
    if (textOf(problem.accountId, MAX_NAME)) troubledAccounts.add(problem.accountId.trim());
  }
  const asked = new Set(listOf(feed.only).filter((id) => typeof id === 'string' && id));
  return {
    only: asked.size ? asked : null,
    reading: Number.isFinite(feed.reading) ? feed.reading : fetchedAt,
    src: typeof feed.src === 'string' && feed.src ? feed.src : 'simplefin',
    txSource: feed.src === 'demo' ? 'demo' : 'bank',
    rollover,
    nowMs,
    fetchedAt,
    fetchDay: gameDay(fetchedAt, rollover),
    fromMs: Number.isFinite(fromMs) ? fromMs : null,
    toMs,
    fromDay: Number.isFinite(fromMs) ? gameDay(fromMs, rollover) : null,
    toDay: gameDay(toMs, rollover),
    today,
    rules: rulesOf(state),
    isTroubled: (entry) => troubledConns.has(entry.connId) || troubledAccounts.has(entry.extId),
  };
}

/**
 * The time the bank gives for a feed row, the one a request's window is held against: its posting time; for a
 * pending row the time it happened. Read as `readRow` reads them.
 * @returns {number|null} epoch seconds; null for a row with no time at all
 */
function listedTime(raw) {
  const givenAt = secondsOf(raw.at);
  const postedAt = secondsOf(raw.posted);
  const pending = raw.pending === true || (postedAt == null && givenAt == null);
  return pending ? givenAt || postedAt : postedAt || givenAt;
}

/**
 * One feed row, validated. `day` is null for a pending row the bank has not dated.
 * @returns {object|null} null for a row that cannot be used (not an object, no amount, zero, or an impossible date)
 */
function readRow(raw, ctx) {
  if (!isRecord(raw)) return null;
  const amount = centsOf(raw.amount);
  if (!amount) return null;
  const givenAt = secondsOf(raw.at);
  // pending: the provider says so, or the row has neither a posting time nor a time it happened;
  // a row with no posting time that is not pending posted on the day it happened
  const pending = raw.pending === true || (secondsOf(raw.posted) == null && givenAt == null);
  const postedAt = secondsOf(raw.posted) || (pending ? null : givenAt);
  const happenedAt = givenAt || (pending ? postedAt : null);
  const happenedDay = happenedAt == null ? null : feedDay(happenedAt, ctx.rollover);
  const postedDay = pending ? null : feedDay(postedAt, ctx.rollover);
  const day = happenedDay || postedDay;
  if (day ? !isYmd(day) : !pending) return null;
  if (postedDay && !isYmd(postedDay)) return null;
  const mcc = typeof raw.mcc === 'string' && /^\d{4}$/.test(raw.mcc) ? raw.mcc : null;
  return {
    extId: textOf(raw.extId, MAX_NAME),
    amount,
    pending,
    postedDay,
    happenedDay,
    day,
    at: happenedAt != null && feedHasTime(happenedAt) ? happenedAt * 1000 : null,
    time: listedTime(raw),
    raw: ([raw.description, raw.payee, raw.memo].find((text) => typeof text === 'string' && text.trim()) || '').slice(0, MAX_RAW),
    mcc,
    fp: '',
  };
}

/** Rows of one feed account with their fingerprints (k counts identical rows in feed order). */
function readRows(feedAccount, accountId, ctx) {
  const read = listOf(feedAccount.txs).map((raw) => readRow(raw, ctx)).filter(Boolean);
  // The same provider id twice in one feed is one row: a posted copy wins over a pending one, else the later copy.
  const byId = new Map();
  for (const row of read) {
    if (!row.extId) continue;
    const kept = byId.get(row.extId);
    if (!kept || !(kept.pending === false && row.pending === true)) byId.set(row.extId, row);
  }
  const rows = read.filter((row) => !row.extId || byId.get(row.extId) === row);
  const seen = new Map();
  for (const row of rows) {
    const stem = fingerprintStem(accountId, row.day || UNDATED, row.amount, row.raw);
    const k = seen.get(stem) || 0;
    seen.set(stem, k + 1);
    row.fp = stem + k;
  }
  return rows;
}

/** @returns {object|null} null for an entry with no usable id */
function readAccount(raw, ctx) {
  if (!isRecord(raw)) return null;
  const extId = textOf(raw.extId, MAX_NAME);
  if (!extId) return null;
  return {
    extId,
    connId: textOf(raw.connId, MAX_NAME),
    institution: textOf(raw.institution, MAX_NAME),
    name: textOf(raw.name, MAX_NAME),
    balance: centsOf(raw.balance),
    available: centsOf(raw.available),
    asOf: Number.isFinite(raw.asOf) ? raw.asOf : ctx.fetchedAt,
    txs: raw.txs,
  };
}

/* ------------------------------------------------------------------ accounts */

function indexAccounts(accounts, src) {
  const index = new Map();
  for (const account of accounts) {
    if (!isRecord(account) || account.source !== 'bank' || !isRecord(account.ext) || account.ext.src !== src) continue;
    if (typeof account.ext.id === 'string' && !index.has(account.ext.id)) index.set(account.ext.id, account);
  }
  return index;
}

/**
 * An account whose provider id changed. When a feed that was not limited carries an account under an id the record
 * does not know, and the record holds exactly one bank account of the same connection and the same name whose id
 * is absent from the feed, that account takes the new id: it keeps its rows, its settings and its history state,
 * and no second account is made. Its rows then match by fingerprint, which is built from the record's own account
 * id and so holds across the change. Never when the feed carries two accounts of that connection and name.
 */
function adoptChangedIds(state, index, entries, ctx) {
  const keyOf = (conn, name) => conn + '\u0000' + name;
  const inFeed = new Set(entries.map((entry) => entry.extId));
  const carried = new Map();
  for (const entry of entries) {
    if (entry.connId && entry.name) pushTo(carried, keyOf(entry.connId, entry.name), entry);
  }
  for (const [key, same] of carried) {
    if (same.length !== 1 || index.has(same[0].extId)) continue;
    const entry = same[0];
    const former = state.accounts.filter((account) => isRecord(account) && account.source === 'bank' && isRecord(account.ext)
      && account.ext.src === ctx.src && typeof account.ext.id === 'string' && index.get(account.ext.id) === account
      && !inFeed.has(account.ext.id) && keyOf(account.ext.conn, account.name) === key);
    if (former.length !== 1) continue;
    index.delete(former[0].ext.id);
    former[0].ext.id = entry.extId;
    index.set(entry.extId, former[0]);
  }
  adoptReconnected(state, index, entries, ctx);
}

/**
 * A bank removed and added again at the provider gives each of its accounts a new id and a new connection.
 * An account the feed carries under an id the record does not know is the record's account when exactly
 * one bank account of the record has the same institution name and account name, and its id is absent
 * from the feed, and the feed carries exactly one such new account: the record's account takes the new id
 * and keeps its rows, settings, history state and alert moves (its connection follows in upsertAccount).
 */
function adoptReconnected(state, index, entries, ctx) {
  const keyOf = (institution, name) => (institution && name ? institution + '\u0000' + name : null);
  const inFeed = new Set(entries.map((entry) => entry.extId));
  const fresh = new Map();
  for (const entry of entries) {
    const key = keyOf(entry.institution, entry.name);
    if (key && !index.has(entry.extId)) pushTo(fresh, key, entry);
  }
  for (const [key, same] of fresh) {
    if (same.length !== 1) continue;
    const entry = same[0];
    const former = state.accounts.filter((account) => isRecord(account) && account.source === 'bank' && isRecord(account.ext)
      && account.ext.src === ctx.src && typeof account.ext.id === 'string' && index.get(account.ext.id) === account
      && !inFeed.has(account.ext.id) && keyOf(account.institution, account.name) === key);
    if (former.length !== 1) continue;
    index.delete(former[0].ext.id);
    former[0].ext.id = entry.extId;
    index.set(entry.extId, former[0]);
  }
}

/** A history state with everything still to do (account.backfill; the steps are in feed.js). */
function openBackfill() {
  return { need: true, step: 0, done: false, gaveUp: false, tries: 0, at: null };
}

/** Nothing stays pending at a bank this many days: the length of one request's window (see feed.js). */
const PENDING_KEPT_DAYS = 44;

/**
 * Decide, once, which of the accounts an ordinary feed carried need their history asked for (account.backfill).
 *  - An account with no history state gets one when this feed created it on a device that had already completed
 *    a reading (it appeared later), or when the record holds no bank row of it after the merge (it arrived with
 *    a balance and no transactions). An account left out gets none.
 *  - An account whose history is done or given up, and which had no bank row on the record, is opened again from
 *    step 0 when this feed brought its first bank row: the provider has begun to carry its transactions.
 *  - During a device's first reading, a state nothing has been asked for yet is taken back when a window of that
 *    reading brings the account's rows: an account that arrives with rows on a first reading has nothing to do.
 * Nothing is derived from the age of rows, and a state once kept is not decided again.
 * @param {{ account: object, created: boolean, had: boolean }[]} touched  had = a bank row was on the record before the merge
 * @param {boolean} later  the device had completed a reading before this one began
 */
function noteNeed(state, touched, later) {
  const withRows = new Set(state.txs.filter(isFeedRow).map((tx) => tx.accountId));
  for (const { account, created, had } of touched) {
    if (account.hidden === true) continue;
    const has = withRows.has(account.id);
    const kept = isRecord(account.backfill) ? account.backfill : null;
    if (!kept) {
      if ((created && later) || !has) account.backfill = openBackfill();
    } else if (has && !had && kept.done === true) {
      account.backfill = openBackfill();
    } else if (has && !later && !kept.step && !kept.done && !kept.tries && kept.at == null) {
      account.backfill = null;
    }
  }
}

/**
 * Find or create the account of a feed entry (rule 1).
 * @returns {{ account: object, before: { balance: number, asOf: number }|null }|null}
 *   before = what was stored for an account that already existed; null result when a new account has no readable balance
 */
function upsertAccount(state, index, entry, ctx, summary) {
  const existing = index.get(entry.extId);
  if (existing) {
    const before = { balance: existing.balance, asOf: existing.asOf };
    if (entry.name) existing.name = entry.name;
    if (entry.institution) existing.institution = entry.institution;
    if (entry.connId) existing.ext.conn = entry.connId;
    return { account: existing, before };
  }
  if (entry.balance == null) return null;
  const type = inferAccountType({ name: entry.name, institution: entry.institution, balance: entry.balance });
  const account = makeAccount({
    source: 'bank',
    ext: { src: ctx.src, id: entry.extId, conn: entry.connId },
    type,
    name: entry.name,
    institution: entry.institution,
    balance: entry.balance,
    available: entry.available,
    asOf: entry.asOf,
    basis: 'bank',
  });
  state.accounts.push(account);
  index.set(entry.extId, account);
  summary.accountsAdded++;
  return { account, before: null };
}

/**
 * A card or loan the feed reports as a positive number: between two syncs the reported balance moved
 * by the rows that posted in between, but in the opposite direction (owed went up as money went out).
 * @param {number} postedDelta  signed sum of the rows of this account that posted since the last merge
 */
function reportsDebtAsPositive(account, entry, before, postedDelta) {
  if (!before || !isDebtSide(account) || !postedDelta) return false;
  if (!(entry.balance > 0) || !(before.balance > 0) || !(entry.asOf > before.asOf)) return false;
  const moved = entry.balance - before.balance;
  if (!moved || Math.sign(moved) === Math.sign(postedDelta)) return false;
  return Math.abs(moved + postedDelta) <= Math.max(FLIP_TOLERANCE_CENTS, FLIP_TOLERANCE * Math.abs(postedDelta));
}

/**
 * The opposite evidence, for an account already being negated: the reported figure moved by its rows in
 * the SAME direction, so the feed is signed in the owner's favour after all (the card really was in credit).
 */
function reportsDebtAsSigned(account, entry, before, postedDelta) {
  if (!before || !isDebtSide(account) || !postedDelta) return false;
  const reportedBefore = -before.balance;
  if (!(entry.balance > 0) || !(reportedBefore > 0) || !(entry.asOf > before.asOf)) return false;
  const moved = entry.balance - reportedBefore;
  if (!moved || Math.sign(moved) !== Math.sign(postedDelta)) return false;
  return Math.abs(moved - postedDelta) <= Math.max(FLIP_TOLERANCE_CENTS, FLIP_TOLERANCE * Math.abs(postedDelta));
}

/**
 * Decide whether the feed reports this debt as a positive number.
 * First sight: a loan is never money the owner has, and a card "in credit" by more than a little is
 * far more likely a debt printed without its sign — read both as owed at once, so net worth is never
 * shown with a debt counted as an asset. Later syncs confirm or correct the reading from the feed's own
 * rows. The owner's own choice (`flipLocked`) is never changed.
 */
function decideFlip(account, entry, before, postedDelta) {
  if (!isDebtSide(account)) { account.flip = false; return; }
  if (account.flipLocked) return;
  if (!before) {
    if (entry.balance > 0 && (account.type !== 'credit_card' || entry.balance > FIRST_SIGHT_CREDIT_CENTS)) account.flip = true;
  } else if (!account.flip) {
    if (reportsDebtAsPositive(account, entry, before, postedDelta)) account.flip = true;
  } else if (reportsDebtAsSigned(account, entry, before, postedDelta)) {
    account.flip = false;
  }
}

/** Store the reported balance, signed in the owner's favour. An older snapshot never replaces a newer one. */
function applyBalance(account, entry, before, postedDelta) {
  decideFlip(account, entry, before, postedDelta);
  if (entry.balance == null || (before && Number.isFinite(before.asOf) && entry.asOf < before.asOf)) return;
  const sign = account.flip ? -1 : 1;
  account.balance = roundCents(sign * entry.balance);
  // a card's "available" is often its unused credit, not its balance: only a mirror of the balance is negated
  account.available = entry.available == null ? null : entry.available === entry.balance ? account.balance : entry.available;
  account.asOf = entry.asOf;
  account.basis = 'bank';
}

/* -------------------------------------------------------------- transactions */

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Stored feed rows by account: by provider id, by fingerprint, and the ones still pending. */
function indexStoredRows(txs) {
  const index = new Map();
  for (const tx of txs) {
    if (!isFeedRow(tx) || typeof tx.accountId !== 'string') continue;
    let entry = index.get(tx.accountId);
    if (!entry) {
      entry = { byExt: new Map(), byFp: new Map(), pending: [] };
      index.set(tx.accountId, entry);
    }
    if (isRecord(tx.ext) && typeof tx.ext.id === 'string' && tx.ext.id) pushTo(entry.byExt, tx.ext.id, tx);
    if (typeof tx.fp === 'string' && tx.fp) pushTo(entry.byFp, tx.fp, tx);
    if (tx.pending === true) entry.pending.push(tx);
  }
  return index;
}

function pickUnclaimed(list, claimed, fp) {
  if (!list) return null;
  const free = list.filter((tx) => !claimed.has(tx));
  return free.find((tx) => tx.fp === fp) || free[0] || null;
}

/** May this just-posted feed row be the stored pending row, now settled (possibly with a tip)? */
function settleGap(row, mkey, tx) {
  if (tx.mkey !== mkey || (row.amount < 0) !== (tx.flow === 'out') || !isYmd(tx.day) || !(tx.amount > 0)) return null;
  const gap = Math.abs(Math.abs(row.amount) - tx.amount);
  const days = Math.abs(diffDays(tx.day, row.day));
  const allowed = mkey ? SETTLE_AMOUNT_TOLERANCE * tx.amount : 0;
  return gap <= allowed && days <= SETTLE_DAY_WINDOW ? { gap, days } : null;
}

/**
 * Match feed rows to stored rows (rule 2): by provider id, else by fingerprint, else a just-posted
 * row to a stored pending row of the same merchant. Each stored row is matched at most once.
 * @returns {{ matches: (object|null)[], claimed: Set<object> }}  matches[i] = the stored row for rows[i]
 */
function matchRows(rows, stored) {
  const claimed = new Set();
  const matches = rows.map(() => null);
  const claim = (i, tx) => {
    matches[i] = tx;
    claimed.add(tx);
  };
  rows.forEach((row, i) => {
    const hit = row.extId ? pickUnclaimed(stored.byExt.get(row.extId), claimed, row.fp) : null;
    if (hit) claim(i, hit);
  });
  rows.forEach((row, i) => {
    const hit = matches[i] ? null : pickUnclaimed(stored.byFp.get(row.fp), claimed, row.fp);
    if (hit) claim(i, hit);
  });

  const openPending = stored.pending.filter((tx) => !claimed.has(tx));
  if (!openPending.length) return { matches, claimed };
  const candidates = [];
  rows.forEach((row, i) => {
    if (matches[i] || row.pending) return;
    const { mkey } = merchantOf({ description: row.raw });
    for (const tx of openPending) {
      const fit = settleGap(row, mkey, tx);
      if (fit) candidates.push({ i, tx, ...fit });
    }
  });
  candidates.sort((a, b) => a.gap - b.gap || a.days - b.days || a.i - b.i);
  for (const { i, tx } of candidates) {
    if (!matches[i] && !claimed.has(tx)) claim(i, tx);
  }
  return { matches, claimed };
}

/**
 * The day a stored row keeps or takes. The bank's transaction date wins; without one, a day already
 * stored (the day it was authorised or first seen) is kept as long as it is not after the posting day.
 */
function dayFor(row, tx, ctx) {
  if (row.happenedDay) return row.happenedDay;
  const stored = tx && isYmd(tx.day) ? tx.day : null;
  if (!row.postedDay) return stored || ctx.fetchDay;
  return stored && stored <= row.postedDay ? stored : row.postedDay;
}

function setField(tx, key, value) {
  if (tx[key] === value) return false;
  tx[key] = value;
  return true;
}

/**
 * Bring a stored row up to date with its feed row. Only what the bank reports is written; locks,
 * notes, plans, glyphs and every classification field are left alone (re-reading is `reclassify`'s job).
 * A row that already posted is never taken back to pending.
 * @returns {{ changed: boolean, reread: boolean, repriced: boolean, posted: boolean }}
 */
function updateRow(tx, row, ctx) {
  const result = { changed: false, reread: false, repriced: false, posted: false };
  if (tx.pending !== true && row.pending) return result;
  const flow = row.amount < 0 ? 'out' : 'in';
  result.posted = tx.pending === true && !row.pending;
  result.repriced = setField(tx, 'amount', Math.abs(row.amount));
  result.reread = [
    setField(tx, 'flow', flow),
    row.raw ? setField(tx, 'raw', row.raw) : false,
    row.mcc ? setField(tx, 'mcc', row.mcc) : false,
  ].includes(true);
  const rest = [
    setField(tx, 'fp', row.fp),
    setField(tx, 'day', dayFor(row, tx, ctx)),
    setField(tx, 'postedDay', row.postedDay),
    setField(tx, 'pending', row.pending),
    row.at != null ? setField(tx, 'at', row.at) : false,
  ].includes(true);
  let reissued = false;
  if (row.extId && (!isRecord(tx.ext) || tx.ext.id !== row.extId || tx.ext.src !== ctx.src)) {
    tx.ext = { src: ctx.src, id: row.extId };
    reissued = true;
  }
  result.changed = result.repriced || result.reread || rest || reissued;
  return result;
}

function insertRow(state, account, row, ctx) {
  const flow = row.amount < 0 ? 'out' : 'in';
  const amount = Math.abs(row.amount);
  const cls = classify({ description: row.raw, mcc: row.mcc, amount, flow, accountType: account.type }, { rules: ctx.rules });
  const tx = makeTx({
    source: ctx.txSource,
    ext: row.extId ? { src: ctx.src, id: row.extId } : null,
    fp: row.fp,
    accountId: account.id,
    day: dayFor(row, null, ctx),
    postedDay: row.postedDay,
    at: row.at,
    pending: row.pending,
    amount,
    flow,
    kind: cls.kind,
    raw: row.raw,
    merchant: cls.merchant,
    mkey: cls.mkey,
    mcc: row.mcc,
    category: cls.category,
    klass: cls.klass,
    purpose: cls.purpose,
    review: cls.review,
    ruleId: cls.ruleId,
    glyph: cls.glyph,
    loggedAt: ctx.nowMs,
  });
  state.txs.push(tx);
  return tx;
}

/**
 * Was the day of a stored pending row inside the window this feed asked for? Only then can its absence from the
 * feed mean it is gone: a row dated before the window is never judged by a feed that could not have carried it.
 */
function coversDay(day, ctx) {
  if (!isYmd(day)) return false;
  return ctx.fromDay != null && day > ctx.fromDay && day <= ctx.toDay;
}

/**
 * Fold the rows of one feed account into the document (rule 2).
 * @returns {number} signed sum of the rows that posted since the last merge (for the sign check of rule 1)
 */
function mergeRows(state, account, entry, stored, ctx, work) {
  const rows = readRows(entry, account.id, ctx);
  const { matches, claimed } = matchRows(rows, stored);
  let postedDelta = 0;
  // each carried row: the day it has on the record, the time the bank gives for it, whether this feed put it there
  const days = [];
  // a pending row the removal by age takes out in this same merge (dropOverdue) is never stored
  const oldest = ctx.only ? null : addDays(ctx.today, -PENDING_KEPT_DAYS);
  rows.forEach((row, i) => {
    const tx = matches[i];
    if (!tx) {
      if (oldest && row.pending && isYmd(row.day) && row.day < oldest) {
        days.push({ day: row.day, time: row.time, fresh: false });
        return;
      }
      const added = insertRow(state, account, row, ctx);
      days.push({ day: added.day, time: row.time, fresh: true });
      work.summary.added++;
      work.summary.newTxIds.push(added.id);
      work.rereadIds.push(added.id);
      work.arrivals.push(added);
      if (!row.pending) postedDelta += row.amount;
      return;
    }
    const outcome = updateRow(tx, row, ctx);
    days.push({ day: tx.day, time: row.time, fresh: false });
    if (!outcome.changed) return;
    work.summary.updated++;
    if (outcome.reread) work.rereadIds.push(tx.id);
    if (outcome.repriced) work.arrivals.push(tx);
    if (outcome.posted) postedDelta += row.amount;
  });
  if (!ctx.isTroubled(entry)) {
    for (const tx of stored.pending) {
      if (!claimed.has(tx) && coversDay(tx.day, ctx)) work.removed.add(tx);
    }
  }
  for (const row of rows) {
    if (row.day && (!work.earliestDay || row.day < work.earliestDay)) work.earliestDay = row.day;
  }
  const zero = listOf(entry.txs).filter((raw) => isRecord(raw) && centsOf(raw.amount) === 0);
  for (const raw of zero) days.push({ day: null, time: listedTime(raw), fresh: false });
  noteCarried(account, rows.length, zero.length, days, ctx);
  return postedDelta;
}

/**
 * Keep what the latest reading carried for this account (`account.feed`). The feeds of one reading share
 * `feed.reading`, and their windows join into one stretch: `askedFromMs` and `askedToMs` are its two instants,
 * `askedFrom` and `askedTo` its days (for the sheet's sentence). Windows are compared as the requests were sent,
 * in whole seconds (feed.js: the start rounded down, the end rounded up; a row is carried from the start up to,
 * not including, the end). A window wholly outside the instants already asked (it may begin where they end)
 * adds all it carried, `count` rows and `zero` $0.00 rows. Where one window lies inside the other, the wider
 * carries the rows of the narrower again: the larger of the two counts stands. A window that overlaps the
 * instants already asked in part adds the carried rows, $0.00 rows too, whose time at the bank (its posting
 * time; for a pending row the time it happened) lies outside those instants: the reading cannot have carried
 * those before. A row with no time at all is added only when this feed itself put it on the record.
 * A new reading starts the counts again.
 * @param {{ day: string|null, time: number|null, fresh: boolean }[]} onRecord  each carried row: its day on the
 *   record (null for a $0.00 row, which is not stored), the time the bank gives for it (epoch seconds), and
 *   whether this feed stored it
 */
function noteCarried(account, count, zero, onRecord, ctx) {
  const days = onRecord.map((row) => row.day).filter(isYmd).sort();
  const carried = {
    readAt: ctx.reading,
    rows: count + zero,
    first: days.length ? days[0] : null,
    last: days.length ? days[days.length - 1] : null,
    askedFrom: ctx.fromDay,
    askedTo: ctx.toDay,
    askedFromMs: ctx.fromMs,
    askedToMs: ctx.toMs,
  };
  const kept = isRecord(account.feed) && account.feed.readAt === ctx.reading ? account.feed : null;
  if (kept) {
    const timed = Number.isFinite(kept.askedFromMs) && Number.isFinite(kept.askedToMs) && Number.isFinite(carried.askedFromMs);
    const start = (ms) => Math.floor(ms / 1000);
    const end = (ms) => Math.ceil(ms / 1000);
    const keptFrom = timed ? start(kept.askedFromMs) : 0;
    const keptTo = timed ? end(kept.askedToMs) : 0;
    const from = timed ? start(carried.askedFromMs) : 0;
    const to = timed ? end(carried.askedToMs) : 0;
    const nested = timed && ((from <= keptFrom && to >= keptTo) || (keptFrom <= from && keptTo >= to));
    const apart = !timed || from >= keptTo || to <= keptFrom;
    const earliest = (a, b) => (a != null && b != null ? (a < b ? a : b) : a != null ? a : b);
    const latest = (a, b) => (a != null && b != null ? (a > b ? a : b) : a != null ? a : b);
    const before = Number.isInteger(kept.rows) && kept.rows > 0 ? kept.rows : 0;
    const outside = (row) => (row.time == null ? row.fresh : row.time < keptFrom || row.time >= keptTo);
    if (nested) carried.rows = Math.max(before, carried.rows);
    else if (apart) carried.rows = before + carried.rows;
    else carried.rows = before + onRecord.filter(outside).length;
    carried.first = earliest(carried.first, kept.first);
    carried.last = latest(carried.last, kept.last);
    carried.askedFrom = earliest(carried.askedFrom, kept.askedFrom);
    carried.askedTo = latest(carried.askedTo, kept.askedTo);
    carried.askedFromMs = earliest(carried.askedFromMs, Number.isFinite(kept.askedFromMs) ? kept.askedFromMs : null);
    carried.askedToMs = latest(carried.askedToMs, Number.isFinite(kept.askedToMs) ? kept.askedToMs : null);
  }
  account.feed = carried;
}

/**
 * A stored pending bank row dated more than 44 days before today is removed by a feed that was not limited to
 * accounts, whichever account it belongs to and whatever the feed says of that account: nothing stays pending
 * at a bank that long, and a reading never reaches further back for a pending row. (A pending row that old which
 * such a feed carries and the record does not hold is never stored: see mergeRows.) If the purchase does post
 * later it arrives as a posted row and is stored again.
 */
function dropOverdue(state, ctx, removed) {
  const oldest = addDays(ctx.today, -PENDING_KEPT_DAYS);
  for (const tx of state.txs) {
    if (isFeedRow(tx) && tx.pending === true && isYmd(tx.day) && tx.day < oldest) removed.add(tx);
  }
}

/** Take the vanished pending rows out of the document and undo every link to them. */
function dropRows(state, removed, summary) {
  if (!removed.size) return;
  const ids = new Set([...removed].map((tx) => tx.id));
  let kept = 0;
  for (const tx of state.txs) {
    if (removed.has(tx)) continue;
    if (isRecord(tx)) {
      if (ids.has(tx.pairId)) tx.pairId = null;
      if (ids.has(tx.matchId)) tx.matchId = null;
    }
    state.txs[kept++] = tx;
  }
  state.txs.length = kept;
  summary.removed += removed.size;
}

/* --------------------------------------------------- transfers and card payments */

function isMove(tx) {
  return MOVE_KINDS.has(tx.kind);
}

/** A row that may become one leg of a pair: a feed row on a linked account that the owner has not pinned as spending. */
function isPairable(tx, linked) {
  if (!isFeedRow(tx) || tx.pairId || tx.streamId || !linked.has(tx.accountId)) return false;
  if (!PAIRABLE_KINDS.has(tx.kind) || !(tx.amount > 0) || !isYmd(tx.day)) return false;
  if (tx.flow !== 'in' && tx.flow !== 'out') return false;
  return isMove(tx) || (!hasLock(tx, 'kind') && !hasLock(tx, 'category'));
}

function setLeg(tx, other, kind, category) {
  tx.pairId = other.id;
  if (!hasLock(tx, 'kind')) tx.kind = kind;
  if (!hasLock(tx, 'category')) tx.category = category;
  if (!hasLock(tx, 'klass') && !tx.recurringId) tx.klass = klassOf(category);
  tx.review = false;
}

function linkPair(out, into, linked) {
  const isPayment = groupOf(linked.get(out.accountId)) === 'cash' && isDebtSide(linked.get(into.accountId));
  const kind = isPayment ? 'payment' : 'transfer';
  const category = isPayment ? 'card_payment' : 'transfer';
  setLeg(out, into, kind, category);
  setLeg(into, out, kind, category);
}

/**
 * Pair the two legs of a transfer or card payment between linked accounts (rule 4): equal amounts,
 * opposite flows, different accounts, within 3 days, at least one leg already read as a transfer or
 * payment. Where several fit, two legs that both read as transfers come first, then the closest days.
 */
function pairTransfers(state, summary) {
  const linked = new Map(state.accounts.filter((a) => isRecord(a) && a.source === 'bank').map((a) => [a.id, a]));
  const byAmount = new Map();
  state.txs.forEach((tx, order) => {
    if (isPairable(tx, linked)) pushTo(byAmount, tx.amount, { tx, order });
  });
  for (const legs of byAmount.values()) {
    const outs = legs.filter((leg) => leg.tx.flow === 'out');
    const ins = legs.filter((leg) => leg.tx.flow === 'in');
    const candidates = [];
    for (const out of outs) {
      for (const into of ins) {
        if (out.tx.accountId === into.tx.accountId || !(isMove(out.tx) || isMove(into.tx))) continue;
        const days = Math.abs(diffDays(out.tx.day, into.tx.day));
        if (days <= PAIR_DAY_WINDOW) candidates.push({ out, into, days, oneSided: isMove(out.tx) && isMove(into.tx) ? 0 : 1 });
      }
    }
    candidates.sort((a, b) => a.oneSided - b.oneSided || a.days - b.days || a.out.order - b.out.order || a.into.order - b.into.order);
    for (const { out, into } of candidates) {
      if (out.tx.pairId || into.tx.pairId) continue;
      linkPair(out.tx, into.tx, linked);
      summary.paired++;
    }
  }
}

/* ---------------------------------------------------------- provisional moves */

/** How well a bank spend fits a provisional move, or null when it does not confirm it. */
function confirmGap(move, tx) {
  if (move.accountId && move.accountId !== tx.accountId) return null;
  // a card alert names the merchant its own way: it is matched on the card, the amount and the day
  if (move.mkey && move.via !== 'alert' && move.mkey !== tx.mkey) return null;
  if (move.via === 'alert') {
    // the bank's charge is the alert's amount or more (a tip raises it, never lowers it), on its day or in the 5 after
    const after = diffDays(move.day, tx.day);
    const fits = tx.amount >= move.amount && tx.amount * 100 <= move.amount * (100 + ALERT_CONFIRM_RISE) && after >= 0 && after <= ALERT_CONFIRM_DAYS;
    return fits ? { gap: tx.amount - move.amount, days: after } : null;
  }
  const gap = Math.abs(tx.amount - move.amount);
  const days = Math.abs(diffDays(move.day, tx.day));
  return gap <= CONFIRM_AMOUNT_TOLERANCE * move.amount && days <= CONFIRM_DAY_WINDOW ? { gap, days } : null;
}

/** What the owner said about the move belongs to the bank row that replaces it. */
function inheritOwnerMarks(tx, move) {
  if (move.planned === true) tx.planned = true;
  if (move.note && !tx.note) tx.note = move.note;
  if (move.glyph && !tx.glyph) tx.glyph = move.glyph;
}

/**
 * Confirm provisional moves with the bank spends that arrived in this merge (rule 3). A bank row
 * confirms at most one move; the closest day wins, then the closest amount.
 * @param {object[]} arrivals  bank rows inserted by this merge, or whose amount it changed
 */
function confirmProvisional(state, arrivals, summary) {
  const spends = arrivals.filter((tx) => tx.kind === 'spend' && tx.flow === 'out' && isYmd(tx.day) && !tx.matchId);
  if (!spends.length) return;
  const taken = new Set(state.txs.filter((tx) => isRecord(tx) && tx.matchId).map((tx) => tx.matchId));
  const open = state.txs.filter((tx) => isProvisional(tx) && !tx.matchId && isYmd(tx.day) && tx.amount > 0);
  const candidates = [];
  open.forEach((move, order) => {
    for (const tx of spends) {
      const fit = taken.has(tx.id) ? null : confirmGap(move, tx);
      if (fit) candidates.push({ move, tx, order, ...fit });
    }
  });
  candidates.sort((a, b) => a.days - b.days || a.gap - b.gap || a.order - b.order);
  for (const { move, tx } of candidates) {
    if (move.matchId || taken.has(tx.id)) continue;
    move.matchId = tx.id;
    move.review = false;
    taken.add(tx.id);
    inheritOwnerMarks(tx, move);
    summary.matched++;
  }
}

/**
 * Confirm one provisional move with a bank spend the record already holds (a card alert read after
 * the bank's own row had arrived on this device): a row dated on the move's day or up to 3 days after,
 * that no other move has taken, by the same rule as `confirmProvisional`. The bank row then counts
 * and the move does not, so nothing is counted twice.
 * @returns {boolean} true when a row confirmed the move
 */
export function confirmStored(state, move) {
  if (!isRecord(state) || !Array.isArray(state.txs) || !isProvisional(move) || move.matchId || !isYmd(move.day)) return false;
  const taken = new Set(state.txs.filter((tx) => isRecord(tx) && tx.matchId).map((tx) => tx.matchId));
  let best = null;
  for (const tx of state.txs) {
    if (!isFeedRow(tx) || tx.kind !== 'spend' || tx.flow !== 'out' || tx.matchId || !isYmd(tx.day) || tx.day < move.day || taken.has(tx.id)) continue;
    const fit = confirmGap(move, tx);
    if (fit && (!best || fit.days < best.days || (fit.days === best.days && fit.gap < best.gap))) best = { tx, ...fit };
  }
  if (!best) return false;
  move.matchId = best.tx.id;
  move.review = false;
  inheritOwnerMarks(best.tx, move);
  return true;
}

/**
 * A bank account is balance-only while the record holds no bank row of it: the provider carries its balance
 * and none of its transactions, so no bank row will ever take a card alert's move over. Such a move stops
 * counting (`inBalance`: it is taken in, as if matched) at the first reading of the account where
 *  (a) the amount owed has risen, since the reading the record held when the move was made (`seenOwed`,
 *      `seenAsOf`), by at least this move and every earlier one of the account not yet taken in when the
 *      reading began (1 cent allowed per move); or
 *  (b) the bank's balance is dated 4 days or more after the purchase.
 * A move taken in stays listed as the purchase's only record and no longer lowers any figure.
 * @param {object[]} accounts  the accounts this feed carried
 */
function takeIntoBalance(state, accounts) {
  const withRows = new Set(state.txs.filter(isFeedRow).map((tx) => tx.accountId));
  const rollover = rolloverOf(state);
  for (const account of accounts) {
    if (!isRecord(account) || withRows.has(account.id) || !Number.isFinite(account.balance) || !Number.isFinite(account.asOf)) continue;
    const owed = -account.balance;
    const asOfDay = gameDay(account.asOf, rollover);
    // every alert move of the account the bank has not matched, taken in or not, oldest first
    const moves = state.txs
      .filter((tx) => isProvisional(tx) && tx.via === 'alert' && tx.accountId === account.id && !tx.matchId && isYmd(tx.day))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.at || 0) - (b.at || 0) || (a.id < b.id ? -1 : 1)));
    moves.forEach((move, i) => {
      if (move.inBalance === true) return;
      // The rise since the reading this move saw holds this purchase and every earlier one that had not reached the
      // balance by then: one still waiting, or one taken in by a later reading than the one this move saw.
      let need = move.amount - 1;
      for (let j = 0; j < i; j++) {
        const earlier = moves[j];
        const inBefore = earlier.inBalance === true
          && !(Number.isFinite(earlier.inBalanceAsOf) && Number.isFinite(move.seenAsOf) && earlier.inBalanceAsOf > move.seenAsOf);
        if (!inBefore) need += earlier.amount - 1;
      }
      const seen = Number.isFinite(move.seenOwed) && Number.isFinite(move.seenAsOf) && account.asOf > move.seenAsOf;
      const risen = seen && owed - move.seenOwed >= need;
      const dated = diffDays(move.day, asOfDay) >= BALANCE_ONLY_DAYS;
      if (!risen && !dated) return;
      move.inBalance = true;
      move.inBalanceAsOf = account.asOf;
      move.review = false;
    });
  }
}

function flagStaleProvisional(state, today) {
  for (const tx of state.txs) {
    if (isStaleProvisional(tx, today)) tx.review = true;
  }
}

/* ---------------------------------------------------------------------- sync */

/** Provider problems as the document keeps them: { connId, accountId, name, message }, without repeats. */
function readProblems(state, feed) {
  const names = new Map();
  const remember = (key, name) => {
    if (key && name && !names.has(key)) names.set(key, name);
  };
  for (const account of listOf(feed.accounts)) {
    if (!isRecord(account)) continue;
    const name = textOf(account.institution, MAX_NAME) || textOf(account.name, MAX_NAME);
    remember('conn:' + textOf(account.connId, MAX_NAME), name);
    remember('account:' + textOf(account.extId, MAX_NAME), name);
  }
  for (const account of state.accounts) {
    if (!isRecord(account) || !isRecord(account.ext)) continue;
    const name = textOf(account.institution, MAX_NAME) || textOf(account.name, MAX_NAME);
    remember('conn:' + textOf(account.ext.conn, MAX_NAME), name);
    remember('account:' + textOf(account.ext.id, MAX_NAME), name);
  }
  const problems = [];
  const seen = new Set();
  for (const item of listOf(feed.errors)) {
    if (!isRecord(item)) continue;
    const message = textOf(item.message, MAX_NOTE);
    const connId = textOf(item.connId, MAX_NAME);
    const accountId = textOf(item.accountId, MAX_NAME);
    const key = [connId, accountId, message].join('\u0000');
    if (!message || seen.has(key)) continue;
    seen.add(key);
    const name = names.get('conn:' + connId) || names.get('account:' + accountId) || '';
    problems.push({ connId, accountId, name, message });
  }
  return problems;
}

/**
 * A feed asked for certain accounts says nothing about the link as a whole: it moves neither the time of the
 * last reading nor the first day covered, and it only adds the problems it reports to the ones on file.
 */
function addProblems(state, feed) {
  const key = (p) => [p.connId, p.accountId || '', p.message].join('\u0000');
  const known = new Set(state.sync.problems.filter(isRecord).map(key));
  for (const problem of readProblems(state, feed)) {
    if (!known.has(key(problem))) state.sync.problems.push(problem);
  }
}

function updateSync(state, feed, ctx, earliestDay) {
  if (ctx.only) { addProblems(state, feed); return; }
  const sync = state.sync;
  const from = ctx.fromDay || earliestDay;
  sync.src = ctx.src;
  sync.lastOk = ctx.fetchedAt;
  sync.status = 'ok';
  sync.error = null;
  sync.problems = readProblems(state, feed);
  if (from && (!isYmd(sync.from) || from < sync.from)) sync.from = from;
  else if (!isYmd(sync.from)) sync.from = null;
}

/* ----------------------------------------------------------------- the merge */

/**
 * Fold one feed into the document: upsert accounts, upsert / dedupe transactions, drop
 * vanished pending rows, confirm provisional moves, pair transfers and card payments, and
 * update state.sync (lastOk = feed.fetchedAt, from, problems, src; status 'ok' and no error). It does NOT run
 * detection — the caller follows with detect.refresh(state, nowMs).
 * Never deletes a posted row and never overwrites an owner-locked field.
 * A feed that is not an object with an `accounts` list changes nothing.
 * A feed asked for certain accounts (`feed.only`, provider ids) says nothing about any other account: entries
 * for other accounts are ignored, and state.sync keeps its lastOk, from, status and error (problems are added to).
 * Every account in the feed gets `account.feed`: what the latest reading carried for it.
 * A feed that was not limited also decides, once, whether an account needs its history asked for
 * (`account.backfill`, see noteNeed), and adopts an account whose provider id changed (adoptChangedIds).
 * @param {object} state      the document (mutated)
 * @param {import('./feed.js').Feed} feed
 * @param {number} nowMs
 * @returns {MergeSummary}
 */
export function mergeFeed(state, feed, nowMs) {
  const summary = emptySummary();
  if (!isRecord(state) || !isRecord(feed) || !Array.isArray(feed.accounts)) return summary;
  ensureShape(state);
  const ctx = makeContext(state, feed, Number.isFinite(nowMs) ? nowMs : Number.isFinite(feed.fetchedAt) ? feed.fetchedAt : 0);
  const accounts = indexAccounts(state.accounts, ctx.src);
  const storedRows = indexStoredRows(state.txs);
  const noRows = { byExt: new Map(), byFp: new Map(), pending: [] };
  const work = { summary, removed: new Set(), rereadIds: [], arrivals: [], earliestDay: null };
  const merged = new Set();
  const entries = [];
  for (const raw of feed.accounts) {
    const entry = readAccount(raw, ctx);
    if (!entry || merged.has(entry.extId) || (ctx.only && !ctx.only.has(entry.extId))) continue;
    merged.add(entry.extId);
    entries.push(entry);
  }
  // a reading of this device has completed (state.sync.completed, set where a reading ends well)
  const later = state.sync.completed === true;
  const touched = [];
  if (!ctx.only) adoptChangedIds(state, accounts, entries, ctx);

  for (const entry of entries) {
    const found = upsertAccount(state, accounts, entry, ctx, summary);
    if (!found) continue;
    touched.push({ account: found.account, created: found.before === null, had: storedRows.has(found.account.id) });
    const postedDelta = mergeRows(state, found.account, entry, storedRows.get(found.account.id) || noRows, ctx, work);
    applyBalance(found.account, entry, found.before, postedDelta);
  }

  if (!ctx.only) dropOverdue(state, ctx, work.removed);
  dropRows(state, work.removed, summary);
  if (!ctx.only) noteNeed(state, touched, later);
  if (work.rereadIds.length) reclassify(state, work.rereadIds);
  pairTransfers(state, summary);
  confirmProvisional(state, work.arrivals, summary);
  takeIntoBalance(state, touched.map((t) => t.account));
  flagStaleProvisional(state, ctx.today);
  updateSync(state, feed, ctx, work.earliestDay);
  // a bank row that confirms a payment another app reported takes its place at once (3.7); detection runs it again
  rebuildIncome(state, ctx.nowMs);
  return summary;
}

/* ------------------------------------------------------------ the owner's moves */

/** The fields a move the owner tapped in starts with; the merchant's usual category when none is given. */
function manualFields(state, move, nowMs) {
  const given = isRecord(move) ? move : {};
  const name = textOf(given.merchant, MAX_NAME);
  const amount = centsOf(given.amount);
  const cls = classify({ description: name, amount: amount || 0, flow: 'out', accountType: 'checking' }, { rules: rulesOf(state) });
  const ownCategory = typeof given.category === 'string' && Object.hasOwn(CATEGORIES, given.category) ? given.category : null;
  const guessed = Object.hasOwn(CATEGORIES, cls.category) ? cls.category : 'other';
  const category = ownCategory || guessed;
  const loggedAt = Number.isFinite(nowMs) ? nowMs : 0;
  const today = gameDay(loggedAt, rolloverOf(state));
  const day = isYmd(given.day) ? given.day : today;
  return {
    source: 'manual',
    flow: 'out',
    day,
    at: day === today ? loggedAt : null,
    amount: amount == null ? 0 : Math.abs(amount),
    merchant: name || (cls.mkey ? cls.merchant : ''),
    mkey: textOf(given.mkey, MAX_NAME) || cls.mkey,
    category,
    klass: category === cls.category ? cls.klass : klassOf(category),
    purpose: cls.purpose,
    loggedAt,
  };
}

function accountIdOf(state, accountId) {
  return typeof accountId === 'string' && state.accounts.some((a) => isRecord(a) && a.id === accountId) ? accountId : null;
}

/**
 * Record a move the owner tapped in before the bank reported it ("Play it" on the candidate sheet).
 * Creates a `source: 'manual'`, kind 'spend', flow 'out' transaction on the given day; it counts in
 * the live number and the day's round until a bank row confirms it (or for 7 days).
 * A day that is not a valid day becomes today; an account the document does not hold becomes null;
 * without a category the merchant's usual one is used.
 * @param {object} state
 * @param {{ amount: number, merchant: string, mkey?: string, category?: string, day: string,
 *           accountId?: string|null, planned?: boolean, note?: string }} move
 * @param {number} nowMs
 * @returns {object|null} the created Tx; null (and nothing recorded) when the amount is not a number above zero
 */
export function addProvisional(state, move, nowMs) {
  if (!isRecord(state)) return null;
  ensureShape(state);
  const fields = manualFields(state, move, nowMs);
  if (!(fields.amount > 0)) return null;
  const tx = makeTx({
    ...fields,
    kind: 'spend',
    accountId: accountIdOf(state, move.accountId),
    planned: move.planned === true,
    note: textOf(move.note, MAX_NOTE),
  });
  state.txs.push(tx);
  return tx;
}

/**
 * Record a declined purchase: kind 'decline', no monetary effect anywhere.
 * An amount that is not a number is recorded as 0 (the price was not noted).
 * @param {object} state
 * @param {{ amount: number, merchant: string, mkey?: string, category?: string, day: string, instead?: string|null }} move
 * @param {number} nowMs
 * @returns {object|null} the created Tx; null only when there is no document to record it in
 */
export function addDecline(state, move, nowMs) {
  if (!isRecord(state)) return null;
  ensureShape(state);
  const tx = makeTx({
    ...manualFields(state, move, nowMs),
    kind: 'decline',
    instead: isRecord(move) ? textOf(move.instead, MAX_NOTE) || null : null,
  });
  state.txs.push(tx);
  return tx;
}

/**
 * Remove a manual row (a provisional move or a decline). Bank rows cannot be removed.
 * @returns {boolean} true when something was removed
 */
export function removeManual(state, txId, nowMs) {
  if (!isRecord(state) || !Array.isArray(state.txs) || typeof txId !== 'string' || !txId) return false;
  const index = state.txs.findIndex((tx) => isRecord(tx) && tx.id === txId && tx.source === 'manual');
  if (index < 0) return false;
  const [gone] = state.txs.splice(index, 1);
  // a card alert's move the owner removed does not come back from its inbox file: its id is remembered
  if (gone.via === 'alert') rememberRemovedAlert(state, gone.id, Number.isFinite(nowMs) ? nowMs : 0);
  return true;
}

/**
 * Remember the id of an alert move the owner removed (state.alertsRemoved, a short list of { id, at }),
 * and forget those older than 30 days.
 */
export function rememberRemovedAlert(state, id, nowMs) {
  const kept = pruneRemovedAlerts(state, nowMs).filter((entry) => entry.id !== id);
  kept.push({ id, at: nowMs });
  state.alertsRemoved = kept.slice(-200);
}

/** The remembered removals no older than 30 days (the list in the record is pruned to them). */
export function pruneRemovedAlerts(state, nowMs) {
  const list = Array.isArray(state.alertsRemoved) ? state.alertsRemoved : [];
  const kept = list.filter((entry) => isRecord(entry) && typeof entry.id === 'string' && Number.isFinite(entry.at)
    && !(Number.isFinite(nowMs) && nowMs - entry.at > ALERT_REMOVED_DAYS * 24 * 3600 * 1000));
  if (Array.isArray(state.alertsRemoved) && kept.length !== list.length) state.alertsRemoved = kept;
  return kept;
}
