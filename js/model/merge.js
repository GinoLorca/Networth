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
 *  - Rows fetched from the sample feed (`src: 'demo'`) are stored with `source: 'demo'`; every rule
 *    here treats them exactly like bank rows. Only `source: 'manual'` rows belong to the owner.
 */

import { ACCOUNT_TYPES, CATEGORIES, klassOf, makeAccount, makeTx } from './schema.js';
import { addDays, diffDays, feedDay, feedHasTime, gameDay, isYmd } from './dates.js';
import { roundCents } from './money.js';
import { classify, inferAccountType, merchantOf, normalizeDescription, reclassify } from './classify.js';

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
const PAIR_DAY_WINDOW = 3;
/** No request can reach further back than this, so an older pending row can never be seen again. */
const PENDING_EXPIRY_DAYS = 90;
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
  return isProvisional(tx) && !tx.matchId && isYmd(tx.day) && isYmd(today) && diffDays(tx.day, today) > PROVISIONAL_STALE_DAYS;
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
  return {
    src: typeof feed.src === 'string' && feed.src ? feed.src : 'simplefin',
    txSource: feed.src === 'demo' ? 'demo' : 'bank',
    rollover,
    nowMs,
    fetchedAt,
    fetchDay: gameDay(fetchedAt, rollover),
    fromDay: Number.isFinite(fromMs) ? gameDay(fromMs, rollover) : null,
    toDay: gameDay(toMs, rollover),
    expiredBefore: addDays(today, -PENDING_EXPIRY_DAYS),
    today,
    rules: rulesOf(state),
    isTroubled: (entry) => troubledConns.has(entry.connId) || troubledAccounts.has(entry.extId),
  };
}

/**
 * One feed row, validated. `day` is null for a pending row the bank has not dated.
 * @returns {object|null} null for a row that cannot be used (not an object, no amount, zero, or an impossible date)
 */
function readRow(raw, ctx) {
  if (!isRecord(raw)) return null;
  const amount = centsOf(raw.amount);
  if (!amount) return null;
  const postedAt = secondsOf(raw.posted);
  const pending = raw.pending === true || postedAt == null;
  const happenedAt = secondsOf(raw.at) || (pending ? postedAt : null);
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

/** Was the day of a stored pending row inside what this feed could have reported? */
function coversDay(day, ctx) {
  if (!isYmd(day)) return false;
  if (day < ctx.expiredBefore) return true;
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
  rows.forEach((row, i) => {
    const tx = matches[i];
    if (!tx) {
      const added = insertRow(state, account, row, ctx);
      work.summary.added++;
      work.summary.newTxIds.push(added.id);
      work.rereadIds.push(added.id);
      work.arrivals.push(added);
      if (!row.pending) postedDelta += row.amount;
      return;
    }
    const outcome = updateRow(tx, row, ctx);
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
  return postedDelta;
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
  if (move.mkey && move.mkey !== tx.mkey) return null;
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

function flagStaleProvisional(state, today) {
  for (const tx of state.txs) {
    if (isStaleProvisional(tx, today)) tx.review = true;
  }
}

/* ---------------------------------------------------------------------- sync */

/** Connection problems as the document keeps them: { connId, name, message }, without repeats. */
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
    if (!message || seen.has(connId + '\u0000' + message)) continue;
    seen.add(connId + '\u0000' + message);
    const name = names.get('conn:' + connId) || names.get('account:' + textOf(item.accountId, MAX_NAME)) || '';
    problems.push({ connId, name, message });
  }
  return problems;
}

function updateSync(state, feed, ctx, earliestDay) {
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

  for (const raw of feed.accounts) {
    const entry = readAccount(raw, ctx);
    if (!entry || merged.has(entry.extId)) continue;
    merged.add(entry.extId);
    const found = upsertAccount(state, accounts, entry, ctx, summary);
    if (!found) continue;
    const postedDelta = mergeRows(state, found.account, entry, storedRows.get(found.account.id) || noRows, ctx, work);
    applyBalance(found.account, entry, found.before, postedDelta);
  }

  dropRows(state, work.removed, summary);
  if (work.rereadIds.length) reclassify(state, work.rereadIds);
  pairTransfers(state, summary);
  confirmProvisional(state, work.arrivals, summary);
  flagStaleProvisional(state, ctx.today);
  updateSync(state, feed, ctx, work.earliestDay);
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
export function removeManual(state, txId) {
  if (!isRecord(state) || !Array.isArray(state.txs) || typeof txId !== 'string' || !txId) return false;
  const index = state.txs.findIndex((tx) => isRecord(tx) && tx.id === txId && tx.source === 'manual');
  if (index < 0) return false;
  state.txs.splice(index, 1);
  return true;
}
