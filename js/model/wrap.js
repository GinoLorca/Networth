/**
 * The nightly wrap: how much money came in and went out on a game day, sent at night as a push notification.
 * Each device writes the days it knows to its own file of the private repository (wrap/<device>.json) after it reads
 * the bank; a night job adds the card alerts and marked payments that arrived after that reading, without counting
 * anything twice, and sends each device its message.
 *
 *   wrapFlowOf(tx, accountOf, pairOf)      'in' | 'out' | 'back' | null: what a live move does to the day
 *   wrapDays(state, nowMs)                 { today, rollover, countPending, days }: today and the 7 days before
 *   wrapDay(state, nowMs, day)             one day for the day sheet: in, out, what counted and what did not, and why
 *   emptyDay(status)                       a day with nothing in it
 *   exportWrap(state, nowMs, device)       the device file (format wrap/1)
 *   readWrapFile(text)                     { ok: true, file } | { ok: false, problem }: a device file, read strictly
 *   pickDay(files, day)                    the one device file used for a day: the latest bank reading, then writing
 *   addLate(fig, day, late)                { fig, alerts, payments }: the day with the late alerts and payments added
 *   seenInWindow(files, days)              { alerts, income }: what the figure picked for each day has dealt with
 *   nightFigures(files, late)              { figs, alerts, payments }: tonight's figures for today and the 7 days before
 *   revisionOf(today, figs, sent)          the night's one revision clause { day, net, final }, or null
 *   wrapText(fig, revision, words, lock)   { title, body, revised } of the notification
 *   pushPayload(fig, revision, device)     the Declarative Web Push message
 *
 * The rules. In: income on any account (pay, a Zelle received, interest, dividends, a marked payment, cash into Cash
 * in hand). Out: purchases, fees and interest on cash, card and debt accounts or on no known account, on the day they
 * were made, equipment included, less refunds; and a transfer out of cash with no other leg on record (to someone).
 * Never: card and loan payments, transfers between the owner's own accounts, incoming transfers that are not income,
 * declines, investment moves. Which moves are live is the ledger's own rule (`makeLedger(...).round(day).moves`:
 * hidden accounts, pending rows while counted, an alert or a move typed in until its bank row or for 7 days, a marked
 * payment until its deposit). A bank row a provisional move met counts on the earlier of their two days, so a figure
 * already sent never moves to another day.
 *
 * Amounts are integer cents; days are game days. The files hold no merchant, account, payer or balance.
 * Pure: it never reads the clock (now is passed in), makes no request and touches no storage.
 */

import { ACCOUNT_TYPES } from './schema.js';
import { addDays, isYmd, parts } from './dates.js';
import { fmt, fmtSigned } from './money.js';
import { makeLedger } from './ledger.js';
import { ALERT_CONFIRM_DAYS, confirmGap } from './merge.js';
import { ALERT_MAX_BYTES, alertDay, alertFile, parseAlert } from './alerts.js';
import {
  MATCH_BEFORE_DAYS, floorCuts, incomeClaimedRows, incomeOf, incomePayments, isClaimant, isIncomeMove, isMatchableRow, matchIncome,
} from './income.js';
import { say, wordsMode } from './words.js';

export const WRAP_FORMAT = 'wrap/1';
/** A device file covers today and this many days before it. */
export const WRAP_DAYS_BACK = 7;
/** A notification's title is kept to one line of a lock screen, its body to two (see wrapText). */
export const TITLE_MAX = 40;
export const BODY_MAX = 80;
/** The plaintext a push service must accept (RFC 8291: a 4,096-octet body less the header and padding). */
export const PAYLOAD_MAX = 3993;
/** Declarative Web Push: the member that marks a message the system shows by itself. */
export const DECLARATIVE = 8030;

/** A device file larger than this is refused unread. */
const WRAP_MAX_BYTES = 200000;
/** A device file may hold a few more days than it writes (a clock that just passed 4 AM). */
const WRAP_MAX_DAYS = 10;
const LIST_MAX = 500;
const KEY_MAX = 170;
const MAX_CENTS = 1e14;
const DEVICE = /^[A-Za-z0-9_-]{1,40}$/;
const STEM = /^\d{8}-\d{6}-\d{3}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STATUSES = new Set(['live', 'awaiting', 'provisional', 'final']);
const PARTS = ['bank', 'marked', 'cash', 'spent', 'alerts', 'sent', 'back'];
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** A phrase of the notification (words.js `wrap.*`, both modes): `{round}` is "Round 16" / "Day 16", amounts formatted. */
function words(key, mode, vars) {
  return say(key, mode, vars);
}

/* ------------------------------------------------------------------------------------------ the counting rule */

function groupOf(account) {
  return account && Object.hasOwn(ACCOUNT_TYPES, account.type) ? ACCOUNT_TYPES[account.type].group : null;
}

/**
 * What a live move does to the day's money in and out.
 * @param {object} tx
 * @param {(id: string) => object|null} [accountOf]  an account by id (unknown: no known account, treated as cash)
 * @param {(id: string) => object|null} [pairOf]     a transaction by id: a transfer's other leg; without it a paired
 *                                                    transfer is taken to have its other leg on record
 * @returns {'in'|'out'|'back'|null}  'back' is a refund: it comes off what went out
 */
export function wrapFlowOf(tx, accountOf, pairOf) {
  if (!tx || typeof tx !== 'object' || tx.kind === 'decline' || !(tx.amount > 0)) return null;
  const group = tx.accountId == null || typeof accountOf !== 'function' ? null : groupOf(accountOf(tx.accountId));
  const spendable = group === null || group === 'cash' || group === 'card' || group === 'debt';
  switch (tx.kind) {
    case 'income':
      return tx.flow === 'in' ? 'in' : null;
    case 'spend':
      return tx.flow === 'out' && spendable ? 'out' : null;
    case 'refund':
      return tx.flow === 'in' && spendable ? 'back' : null;
    case 'transfer': {
      if (tx.flow !== 'out' || !(group === null || group === 'cash')) return null;
      const otherLeg = tx.pairId != null && (typeof pairOf !== 'function' || !!pairOf(tx.pairId));
      return otherLeg ? null : 'out';
    }
    default:
      return null; // a card or loan payment (both legs), an investment move, anything else
  }
}

/* ------------------------------------------------------------------------------------------- the day figure */

/** A day with nothing in it. */
export function emptyDay(status) {
  return {
    status, in: 0, out: 0,
    parts: { bank: 0, marked: 0, cash: 0, spent: 0, alerts: 0, sent: 0, back: 0 },
    pending: 0,
    seen: { alerts: [], income: [] },
    open: { charges: [], deposits: [] },
  };
}

function rolloverOf(state) {
  const hour = isObject(state) && isObject(state.settings) ? state.settings.rolloverHour : undefined;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 4;
}

/**
 * Today and the 7 days before, each with what came in and went out (wrapFlowOf on the ledger's live moves), how many
 * of its bank rows are pending, what it has dealt with (`seen`: the inbox stems of its card alerts, the keys of its
 * marked payments) and the bank rows a late alert or payment could still meet (`open`: [cents, day]).
 * @returns {{ today: string, rollover: number, countPending: boolean, days: Object<string, object> }}
 */
export function wrapDays(state, nowMs) {
  return daysOf(state, nowMs, makeLedger(state, nowMs));
}

/** The record's rows and accounts as the counting rule reads them, and the day each row counts on. */
function countingOf(state) {
  const txs = listOf(state && state.txs).filter(isObject);
  const accounts = new Map(listOf(state && state.accounts).filter(isObject).map((a) => [a.id, a]));
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  const accountOf = (id) => accounts.get(id) || null;
  const pairOf = (id) => byId.get(id) || null;
  // a bank row a provisional move met counts on the earlier of their two days (owner decision 3)
  const metOn = new Map();
  for (const tx of txs) {
    if (tx.source !== 'manual' || typeof tx.matchId !== 'string' || !isYmd(tx.day)) continue;
    const had = metOn.get(tx.matchId);
    if (!had || tx.day < had) metOn.set(tx.matchId, tx.day);
  }
  const dayOf = (tx) => {
    const met = tx.source === 'bank' ? metOn.get(tx.id) : null;
    return met && met < tx.day ? met : tx.day;
  };
  return { txs, accounts, accountOf, pairOf, dayOf };
}

/**
 * One day's money in and out as the day sheet shows it, by the wrap's own rule (the figure the device writes for the
 * day): what counted (income, purchases and fees less refunds, a transfer to someone) and what did not, with why (a card
 * or loan payment, a transfer between the owner's own accounts).
 * @returns {{ day: string, status: string, in: number, out: number,
 *   counted: { tx: object, way: 'in'|'out'|'back', amount: number, sent: boolean }[],
 *   left: { tx: object, why: 'payment'|'own', amount: number }[] }}
 */
export function wrapDay(state, nowMs, day) {
  const ledger = makeLedger(state, nowMs);
  const today = ledger.today;
  const out = { day, status: day > today ? 'future' : day === today ? 'live' : ledger.dataStatus(day), in: 0, out: 0, counted: [], left: [] };
  if (!isYmd(day) || day > today) return out;
  const { accountOf, pairOf, dayOf } = countingOf(state);
  // the day's live moves, and the later ones counted on it (a bank row dated up to 5 days after the alert it met, a
  // deposit up to 30 days after the payment it met): every round from the day to the 2 days ahead a bank may date a row to
  for (let d = day, last = addDays(today, 2); d <= last; d = addDays(d, 1)) {
    for (const tx of ledger.round(d).moves) {
      if (dayOf(tx) !== day || tx.kind === 'decline') continue;
      const amount = Math.round(tx.amount);
      const way = wrapFlowOf(tx, accountOf, pairOf);
      if (way) {
        out.counted.push({ tx, way, amount, sent: way === 'out' && tx.kind === 'transfer' });
        if (way === 'in') out.in += amount;
        else if (way === 'out') out.out += amount;
        else out.out -= amount;
      } else if (tx.kind === 'payment') {
        out.left.push({ tx, why: 'payment', amount });
      } else if (tx.kind === 'transfer' && tx.pairId != null && pairOf(tx.pairId)) {
        out.left.push({ tx, why: 'own', amount });
      }
    }
  }
  return out;
}

function daysOf(state, nowMs, ledger) {
  const today = ledger.today;
  const rollover = rolloverOf(state);
  const countPending = !(isObject(state) && isObject(state.settings) && state.settings.countPending === false);
  const { txs, accounts, accountOf, pairOf, dayOf } = countingOf(state);
  const first = addDays(today, -WRAP_DAYS_BACK);
  const days = {};
  for (let d = first; d <= today; d = addDays(d, 1)) days[d] = emptyDay(d === today ? 'live' : ledger.dataStatus(d));

  // the live moves of the window, and of the 2 days ahead a bank may date a row to
  for (let d = first, last = addDays(today, 2); d <= last; d = addDays(d, 1)) {
    for (const tx of ledger.round(d).moves) {
      const way = wrapFlowOf(tx, accountOf, pairOf);
      const fig = way ? days[dayOf(tx)] : null;
      if (fig) tally(fig, tx, way, accountOf);
    }
  }
  // pending bank rows, counted or not (countPending says which)
  for (const tx of txs) {
    if (tx.source !== 'bank' || !tx.pending || !shownBank(accountOf(tx.accountId))) continue;
    const fig = wrapFlowOf(tx, accountOf, pairOf) ? days[dayOf(tx)] : null;
    if (fig) fig.pending += 1;
  }

  // seen: the card alerts this device made a move of or removed, by the day of their inbox file
  const stems = new Set();
  for (const tx of txs) if (tx.via === 'alert' && typeof tx.id === 'string' && tx.id.startsWith('alert_')) stems.add(tx.id.slice(6));
  for (const gone of listOf(state && state.alertsRemoved)) if (isObject(gone) && typeof gone.id === 'string' && gone.id.startsWith('alert_')) stems.add(gone.id.slice(6));
  for (const stem of [...stems].sort()) {
    const file = alertFile(stem + '.txt');
    const fig = file ? days[alertDay(state, file, today)] : null;
    if (fig) fig.seen.alerts.push(stem);
  }
  // seen: every payment it knows, whatever became of it, by its marked day
  for (const p of incomePayments(state, rollover)) if (days[p.marked]) days[p.marked].seen.income.push(p.key);
  for (const fig of Object.values(days)) fig.seen.income.sort();

  // open: card charges no alert took, which a late alert of the day could be (merge.confirmGap); a pending one too,
  // counted or not, as the device's own matching meets an alert with it (and the alert then counts no more)
  const taken = new Set(txs.filter((tx) => typeof tx.matchId === 'string').map((tx) => tx.matchId));
  const charges = txs.filter((tx) => tx.source === 'bank' && tx.kind === 'spend' && tx.flow === 'out' && !tx.matchId
    && !taken.has(tx.id) && tx.amount > 0 && isYmd(tx.day)
    && shownBank(accountOf(tx.accountId)) && groupOf(accountOf(tx.accountId)) === 'card')
    .map((tx) => [Math.round(tx.amount), tx.day]).sort(byDayThenCents);
  // open: deposits no payment claimed, which a late payment of the day could be (income.isMatchableRow, matchIncome)
  const claimed = new Set(txs.filter((tx) => tx.matchId && !isIncomeMove(tx)).map((tx) => tx.matchId));
  const byPayments = incomeClaimedRows(state);
  const deposits = txs.filter((tx) => isMatchableRow(tx, accounts, claimed, addDays(today, 2), countPending) && !byPayments.has(tx.id))
    .map((tx) => [Math.round(tx.amount), tx.day]).sort(byDayThenCents);
  for (const [day, fig] of Object.entries(days)) {
    // a late alert meets a charge dated on its day or up to 5 days after; a late payment a deposit from 10 days before
    const until = addDays(day, ALERT_CONFIRM_DAYS);
    const from = addDays(day, -MATCH_BEFORE_DAYS);
    fig.open.charges = charges.filter(([, d]) => d >= day && d <= until).slice(0, LIST_MAX);
    fig.open.deposits = deposits.filter(([, d]) => d >= from).slice(0, LIST_MAX);
  }
  return { today, rollover, countPending, days };
}

function tally(fig, tx, way, accountOf) {
  const amount = Math.round(tx.amount);
  if (way === 'in') {
    fig.in += amount;
    if (tx.source === 'manual' && tx.via === 'income') {
      const account = accountOf(tx.accountId);
      fig.parts[account && account.role === 'cash-in-hand' ? 'cash' : 'marked'] += amount;
    } else {
      fig.parts.bank += amount;
    }
  } else if (way === 'out') {
    fig.out += amount;
    fig.parts[tx.source === 'manual' ? 'alerts' : tx.kind === 'transfer' ? 'sent' : 'spent'] += amount;
  } else {
    fig.out -= amount;
    fig.parts.back += amount;
  }
}

function shownBank(account) {
  return !!account && account.source === 'bank' && !account.hidden;
}

function byDayThenCents(a, b) {
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] - b[0];
}

/* ------------------------------------------------------------------------------------------ the device file */

/**
 * The device file: `{ format, device, writtenAt, readAt, dataAt, rollover, countPending, days }`. `readAt` is the
 * device's last bank reading (sync.lastOk), `dataAt` the oldest balance date of its everyday accounts.
 * @param {object} state
 * @param {number} nowMs
 * @param {string} device  the device's own id
 */
export function exportWrap(state, nowMs, device) {
  const ledger = makeLedger(state, nowMs);
  const { rollover, countPending, days } = daysOf(state, nowMs, ledger);
  const lastOk = isObject(state) && isObject(state.sync) ? state.sync.lastOk : null;
  const dataAt = ledger.position().dataAt;
  return {
    format: WRAP_FORMAT,
    device,
    writtenAt: isoOf(nowMs),
    readAt: Number.isFinite(lastOk) && lastOk > 0 ? isoOf(lastOk) : null,
    dataAt: Number.isFinite(dataAt) && dataAt > 0 ? isoOf(dataAt) : null,
    rollover,
    countPending,
    days,
  };
}

/**
 * A device file as the night job reads it (untrusted): anything odd refuses the whole file.
 * @param {string} text
 * @returns {{ ok: true, file: object } | { ok: false, problem: string }}
 */
export function readWrapFile(text) {
  const no = (problem) => ({ ok: false, problem });
  if (typeof text !== 'string') return no('The file could not be read.');
  if (text.length > WRAP_MAX_BYTES) return no('The file is too large.');
  let raw;
  try { raw = JSON.parse(text); } catch { return no('The file is not JSON.'); }
  if (!isObject(raw) || hasUnsafeKey(raw)) return no('The file is not a wrap file.');
  if (raw.format !== WRAP_FORMAT) return no('The file is not in the format ' + WRAP_FORMAT + '.');
  if (typeof raw.device !== 'string' || !DEVICE.test(raw.device)) return no('The device id is not usable.');
  if (!isIso(raw.writtenAt)) return no('The time it was written is not a time.');
  if (!(raw.readAt === null || isIso(raw.readAt))) return no('The time of the bank reading is not a time.');
  if (!(raw.dataAt === null || isIso(raw.dataAt))) return no('The balance date is not a time.');
  if (!Number.isInteger(raw.rollover) || raw.rollover < 0 || raw.rollover > 23) return no('The hour the day turns is not an hour.');
  if (typeof raw.countPending !== 'boolean') return no('Whether pending rows count is not said.');
  if (!isObject(raw.days)) return no('The file has no days.');
  const keys = Object.keys(raw.days);
  if (keys.length > WRAP_MAX_DAYS) return no('The file holds too many days.');
  const days = {};
  for (const day of keys.sort()) {
    if (!isYmd(day)) return no('A day is not a date.');
    const fig = readDay(raw.days[day]);
    if (!fig) return no('The figures of ' + day + ' are not usable.');
    days[day] = fig;
  }
  return {
    ok: true,
    file: {
      format: WRAP_FORMAT, device: raw.device, writtenAt: raw.writtenAt, readAt: raw.readAt, dataAt: raw.dataAt,
      rollover: raw.rollover, countPending: raw.countPending, days,
    },
  };
}

function readDay(raw) {
  if (!isObject(raw) || !STATUSES.has(raw.status) || !isCents(raw.in) || !isCents(raw.out)) return null;
  if (!isObject(raw.parts) || !Number.isInteger(raw.pending) || raw.pending < 0) return null;
  const partsOut = {};
  for (const name of PARTS) {
    if (!isCents(raw.parts[name]) || raw.parts[name] < 0) return null;
    partsOut[name] = raw.parts[name];
  }
  if (!isObject(raw.seen) || !isObject(raw.open)) return null;
  const alerts = raw.seen.alerts;
  const income = raw.seen.income;
  if (!Array.isArray(alerts) || alerts.length > LIST_MAX || !alerts.every((s) => typeof s === 'string' && STEM.test(s))) return null;
  if (!Array.isArray(income) || income.length > 5000 || !income.every(isIncomeKey)) return null;
  const charges = readPairs(raw.open.charges);
  const deposits = readPairs(raw.open.deposits);
  if (!charges || !deposits) return null;
  return {
    status: raw.status, in: raw.in, out: raw.out, parts: partsOut, pending: raw.pending,
    seen: { alerts: alerts.slice(), income: income.slice() }, open: { charges, deposits },
  };
}

function readPairs(list) {
  if (!Array.isArray(list) || list.length > LIST_MAX) return null;
  const out = [];
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isCents(pair[0]) || pair[0] <= 0 || !isYmd(pair[1])) return null;
    out.push([pair[0], pair[1]]);
  }
  return out;
}

function isIncomeKey(key) {
  if (typeof key !== 'string' || key.length > KEY_MAX) return false;
  const parts2 = key.split('/');
  return parts2.length === 2 && parts2.every((p) => /^[A-Za-z0-9_.:-]{1,80}$/.test(p) && !UNSAFE.has(p));
}

function hasUnsafeKey(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return false;
  for (const key of Object.keys(value)) {
    if (UNSAFE.has(key) || hasUnsafeKey(value[key], depth + 1)) return true;
  }
  return false;
}

/**
 * The one device file used for a day: of the files that hold it, the one with the latest bank reading (`readAt`),
 * ties broken by the latest writing. Its figure and its `seen` lists are used together, never mixed with another's.
 * @param {object[]} files  device files as readWrapFile gives them
 * @returns {object|null}
 */
export function pickDay(files, day) {
  let best = null;
  for (const file of listOf(files)) {
    if (!isObject(file) || !isObject(file.days) || !Object.hasOwn(file.days, day)) continue;
    if (!best || later(file, best)) best = file;
  }
  return best;
}

function later(a, b) {
  const ra = msOf(a.readAt);
  const rb = msOf(b.readAt);
  if (ra !== rb) return ra > rb;
  return msOf(a.writtenAt) > msOf(b.writtenAt);
}

function msOf(text) {
  const ms = typeof text === 'string' ? Date.parse(text) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

/* ------------------------------------------------------------------------------------------------ late items */

/**
 * The day with what arrived after its device file was written: card alerts of the inbox and payments another app
 * reported, each only when the file has not dealt with it (`seen`, by id: never by clock time). A late alert that
 * meets an open charge is already counted as that charge; a late payment that meets an open deposit is already
 * counted as that deposit. Each open row is met at most once: within the day here, or across the night's window when
 * `late.met` says what met the file's rows (nightFigures).
 * @param {object|null} fig  the day of the chosen device file, or null when no device file holds the day
 * @param {string} day
 * @param {{ today: string, rollover: number, inbox: {name: string, size: number, text: string|null}[],
 *           income: { sources: object, shared: object|null }, seen?: { alerts: Iterable<string>, income: Iterable<string> },
 *           met?: { alerts: Set<string>, payments: Set<string> }|null }} late
 *   `income.sources` as the record keeps them ({ [source]: { what, from, payers, items } }, `at` in ms);
 *   `income.shared` the `income` section of the shared file (the answers and `since`);
 *   `seen` what the figures of the other days have dealt with (seenInWindow): an item one of them counted is in that
 *   figure, whatever day this clock or rollover gives it;
 *   `met` the stems of the alerts and the keys of the payments that met an open row of the file (in place of this day's
 *   own matching)
 * @returns {{ fig: object, alerts: number, payments: number }}
 */
export function addLate(fig, day, late) {
  const out = fig ? copyDay(fig) : emptyDay(day === late.today ? 'live' : 'awaiting');
  const result = { fig: out, alerts: 0, payments: 0 };
  // what met an open row of the file across the night's window (nightFigures), else this day's own rows
  const pool = isObject(late.met) ? late.met : null;

  // card alerts
  const alerts = lateAlerts(out, day, late);
  const metAlerts = pool ? pool.alerts : alertsMet(alerts, out.open.charges);
  for (const alert of alerts) {
    if (metAlerts.has(alert.stem)) continue;
    out.out += alert.amount;
    out.parts.alerts += alert.amount;
    result.alerts += 1;
  }

  // marked payments
  const fresh = latePayments(out, day, late);
  const met = pool ? pool.payments : paymentsMet(fresh, out.open.deposits, late);
  for (const p of fresh) {
    if (met.has(p.key) || p.how === 'history') continue;
    if (p.how === 'cash') {
      out.in += p.cents;
      out.parts.cash += p.cents;
    } else if (!floorCuts(p)) {
      out.in += p.cents;
      out.parts.marked += p.cents;
    } else {
      continue;
    }
    result.payments += 1;
  }
  return result;
}

/** The card alerts of the inbox for a day that the day's figure has not dealt with: { stem, amount, day }, oldest first. */
function lateAlerts(fig, day, late) {
  const elsewhere = isObject(late.seen) ? late.seen : {};
  const seenAlerts = new Set([...listOf(fig && fig.seen && fig.seen.alerts), ...iterable(elsewhere.alerts)]);
  const asRecord = { settings: { rolloverHour: late.rollover } };
  const files = listOf(late.inbox).filter((entry) => isObject(entry) && alertFile(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [];
  for (const entry of files) {
    if (!(Number.isFinite(entry.size) && entry.size >= 0 && entry.size <= ALERT_MAX_BYTES)) continue;
    const file = alertFile(entry.name);
    if (alertDay(asRecord, file, late.today) !== day || seenAlerts.has(file.stem)) continue;
    const alert = parseAlert(entry.text);
    if (alert) out.push({ stem: file.stem, amount: alert.amount, day });
  }
  return out;
}

/** The marked payments of a day that the day's figure has not dealt with (and not answered "it's gone"). */
function latePayments(fig, day, late) {
  const elsewhere = isObject(late.seen) ? late.seen : {};
  const record = { income: isObject(late.income) ? late.income : {} };
  const seenIncome = new Set([...listOf(fig && fig.seen && fig.seen.income), ...iterable(elsewhere.income)]);
  return incomePayments(record, late.rollover).filter((p) => p.marked === day && !seenIncome.has(p.key) && p.how !== 'gone');
}

/**
 * Which late alerts meet an open charge ([cents, day]), each charge at most once (merge.confirmGap): the closest day
 * first, then the closest amount, then the oldest alert, so that an alert meets a charge of its own day before one of a
 * later day (on the device the charge then counts on the alert's day either way).
 * @returns {Set<string>} the stems of the alerts met
 */
function alertsMet(alerts, charges) {
  const pool = listOf(charges).map(([amount, d]) => ({ amount, day: d, used: false }));
  const pairs = [];
  for (const alert of alerts) {
    for (const charge of pool) {
      const fit = confirmGap({ via: 'alert', amount: alert.amount, day: alert.day }, charge);
      if (fit) pairs.push({ alert, charge, ...fit });
    }
  }
  pairs.sort((a, b) => a.days - b.days || a.gap - b.gap || (a.alert.stem < b.alert.stem ? -1 : a.alert.stem > b.alert.stem ? 1 : 0));
  const met = new Set();
  for (const { alert, charge } of pairs) {
    if (met.has(alert.stem) || charge.used) continue;
    charge.used = true;
    met.add(alert.stem);
  }
  return met;
}

/** Which late payments an open deposit ([cents, day]) already counts (income.matchIncome, as the device matches). */
function paymentsMet(payments, deposits, late) {
  const { shared } = incomeOf({ income: isObject(late.income) ? late.income : {} });
  const rows = listOf(deposits).map(([amount, d], i) => ({ id: 'open' + i, day: d, amount }));
  return new Set(matchIncome(rows, payments.filter((p) => isClaimant(shared, p))).keys());
}

/**
 * The open rows of one device file across the days it was picked for, each row once: the days' lists are views of the
 * same rows, so a row listed under several days is one row (a pair listed n times under one day is n rows).
 */
function poolOf(lists) {
  const most = new Map();
  for (const list of lists) {
    const count = new Map();
    for (const [amount, d] of listOf(list)) count.set(amount + ' ' + d, (count.get(amount + ' ' + d) || 0) + 1);
    for (const [key, n] of count) if (n > (most.get(key) || 0)) most.set(key, n);
  }
  const out = [];
  for (const [key, n] of most) {
    const [amount, d] = key.split(' ');
    for (let i = 0; i < n; i++) out.push([Number(amount), d]);
  }
  return out.sort(byDayThenCents);
}

/**
 * What the figures of a night have dealt with: for each day, the seen lists of the one file picked for that day, and
 * of that day only. Lists are never merged across devices for one day: a stem here is counted in the figure of the day
 * it is listed under, so no other day adds it again (a device whose clock, zone or rollover put it on another day).
 * @param {object[]} files  device files as readWrapFile gives them
 * @param {string[]} days
 * @returns {{ alerts: Set<string>, income: Set<string> }}
 */
export function seenInWindow(files, days) {
  const alerts = new Set();
  const income = new Set();
  for (const day of listOf(days)) {
    const file = pickDay(files, day);
    const fig = file ? file.days[day] : null;
    if (!isObject(fig) || !isObject(fig.seen)) continue;
    for (const stem of listOf(fig.seen.alerts)) alerts.add(stem);
    for (const key of listOf(fig.seen.income)) income.add(key);
  }
  return { alerts, income };
}

/**
 * Tonight's figures: today and the 7 days before, each from the one device file picked for it (pickDay) with what came
 * after it (addLate), an item any picked figure of the window has dealt with never added again. A file picked for
 * several days lists a row under each day it could match: its open rows are one pool for the whole night, each met by
 * one late alert or payment at most, as on the device.
 * @param {object[]} files  device files as readWrapFile gives them
 * @param {object} late  as addLate takes it (without `seen`)
 * @returns {{ figs: Object<string, object>, alerts: number, payments: number }}
 */
export function nightFigures(files, late) {
  const days = [];
  for (let d = addDays(late.today, -WRAP_DAYS_BACK); d <= late.today; d = addDays(d, 1)) days.push(d);
  const seen = seenInWindow(files, days);
  // a file picked for several days: its open rows are one pool for all of them, each row met by one late item at most
  const picked = new Map();
  for (const day of days) {
    const file = pickDay(files, day);
    if (file) picked.set(file, [...(picked.get(file) || []), day]);
  }
  const pools = new Map();
  for (const [file, its] of picked) {
    const alertsLate = its.flatMap((day) => lateAlerts(file.days[day], day, { ...late, seen }));
    const paymentsLate = its.flatMap((day) => latePayments(file.days[day], day, { ...late, seen }));
    const met = {
      alerts: alertsMet(alertsLate, poolOf(its.map((day) => file.days[day].open && file.days[day].open.charges))),
      payments: paymentsMet(paymentsLate, poolOf(its.map((day) => file.days[day].open && file.days[day].open.deposits)), late),
    };
    for (const day of its) pools.set(day, met);
  }
  const figs = {};
  let alerts = 0;
  let payments = 0;
  for (const day of days) {
    const file = pickDay(files, day);
    const added = addLate(file ? file.days[day] : null, day, { ...late, seen, met: pools.get(day) || null });
    figs[day] = added.fig;
    alerts += added.alerts;
    payments += added.payments;
  }
  return { figs, alerts, payments };
}

function iterable(x) {
  return x instanceof Set || Array.isArray(x) ? x : [];
}

function copyDay(fig) {
  return {
    status: fig.status, in: fig.in, out: fig.out, parts: { ...emptyDay().parts, ...fig.parts }, pending: fig.pending || 0,
    seen: { alerts: listOf(fig.seen && fig.seen.alerts).slice(), income: listOf(fig.seen && fig.seen.income).slice() },
    open: { charges: listOf(fig.open && fig.open.charges).slice(), deposits: listOf(fig.open && fig.open.deposits).slice() },
  };
}

/* ------------------------------------------------------------------------------------- the revision clause */

/**
 * The night's one revision clause, in this order: the day before, when its total (in − out) changed since it was sent;
 * else an earlier day whose total changed since it was last told (a clause that did not fit, or reached no lock screen,
 * is not recorded as told, so it comes on a later night): the latest, or the oldest when tonight is its last night in
 * the window; only when no day changed, the latest day that has turned final since it was sent as not final (an empty
 * one is not news). A changed day that has also turned final says so in the same clause. "Complete" is never said: by
 * the ledger's rule a day turns final two nights later at the earliest.
 * @param {string} today
 * @param {Object<string, {status: string, in: number, out: number}>} figs  the days as tonight knows them
 * @param {{ days: Object<string, {in: number, out: number, status: string}> }|null} sent  what was sent before
 * @returns {{ day: string, net: number, final: boolean }|null}
 */
export function revisionOf(today, figs, sent) {
  const said = isObject(sent) && isObject(sent.days) ? sent.days : null;
  if (!said || !isObject(figs)) return null;
  const yesterday = addDays(today, -1);
  const clause = (day) => ({ day, net: figs[day].in - figs[day].out, final: figs[day].status === 'final' });
  const known = (d) => d < today && isObject(figs[d]) && isObject(said[d]) && Number.isInteger(said[d].in) && Number.isInteger(said[d].out);
  const changed = (d) => known(d) && figs[d].in - figs[d].out !== said[d].in - said[d].out;
  // the day leaving the window tonight has no later night, while yesterday's change can still be told on the next five:
  // so a change to the leaving day comes first, and every change is told by its last night in the window
  const leaving = addDays(today, -WRAP_DAYS_BACK);
  if (changed(leaving)) return clause(leaving);
  if (changed(yesterday)) return clause(yesterday);
  const days = Object.keys(figs).filter((d) => d < yesterday).sort();
  // a changed day outranks one that only turned final, so that a day turning final every night never starves a change
  const moved = days.filter(changed);
  if (moved.length) return clause(moved[moved.length - 1]);
  // an empty day turned final says nothing the night that told it "no money in or out" did not
  const empty = (d) => figs[d].in === 0 && figs[d].out === 0 && said[d].in - said[d].out === 0;
  const turned = Object.keys(figs).filter((d) => known(d) && figs[d].status === 'final' && said[d].status !== 'final' && !empty(d)).sort();
  return turned.length ? clause(turned[turned.length - 1]) : null;
}

/* -------------------------------------------------------------------------------------------- the words */

/**
 * The notification: a title and at most one body, in the device's words. Today, and a day in pencil, carry ≈; a final
 * day is plain. Amounts use the true minus. With amounts hidden (any `lock` but 'show'), no amount and no sign.
 * The limits: a title of at most TITLE_MAX (40) characters, one line of the narrowest lock screen of the three devices;
 * a body of at most BODY_MAX (80), two lines of about 40 (iOS shows up to four, a Mac banner two). The revision clause
 * is left out when it would not fit, and `revised` says whether it is in the body (the night job records the revised
 * day as told only then); amounts too large to fit fall back to the hidden words.
 * @param {{ day: string, in: number, out: number, noBank?: boolean }} fig  `noBank`: no bank figures for the day
 * @param {{ day: string, net: number, final: boolean }|null} revision
 * @param {'chess'|'finance'} wordMode
 * @param {'show'|'hide'} lock
 * @returns {{ title: string, body: string, revised: boolean }}
 */
export function wrapText(fig, revision, wordMode, lock) {
  const mode = wordsMode(wordMode);
  const round = roundOf(fig.day, mode);
  const hidden = { title: words('wrap.title.hidden', mode, { round }), body: words('wrap.body.hidden', mode), revised: false };
  if (lock !== 'show') return hidden;
  const moved = fig.in !== 0 || fig.out !== 0;
  const title = moved ? words('wrap.title', mode, { round, net: '≈' + fmtSigned(fig.in - fig.out) }) : words('wrap.title.still', mode, { round });
  let main = '';
  if (fig.noBank) main = moved ? words('wrap.noBank', mode, { flows: flowsOf(fig, mode) }) : words('wrap.noBank.still', mode);
  else if (moved) main = upperFirst(flowsOf(fig, mode));
  const clause = revision ? revisionWords(revision, mode) : '';
  let body = [main, clause].filter(Boolean).join(' ');
  let revised = !!clause;
  if (body.length > BODY_MAX) {
    body = main;
    revised = false;
  }
  if (body.length > BODY_MAX) body = hidden.body;
  return { title: title.length > TITLE_MAX ? hidden.title : title, body, revised };
}

function roundOf(day, mode) {
  return say('board.today.round', mode, { n: String(parts(day).d) });
}

function flowsOf(fig, mode) {
  const inWords = fig.in === 0 ? words('wrap.in.none', mode) : words('wrap.in', mode, { amount: '≈' + fmt(fig.in) });
  const outWords = fig.out === 0 ? words('wrap.out.none', mode) : words('wrap.out', mode, { amount: '≈' + fmt(fig.out) });
  return words('wrap.flows', mode, { in: inWords, out: outWords });
}

function revisionWords(revision, mode) {
  const round = roundOf(revision.day, mode);
  if (revision.final) return words('wrap.ink', mode, { round, net: fmtSigned(revision.net) });
  return words('wrap.pencil', mode, { round, net: '≈' + fmtSigned(revision.net) });
}

function upperFirst(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/* ------------------------------------------------------------------------------------------- the message */

/**
 * The Declarative Web Push message for one device: shown by the system as it is (no `mutable`), tagged by the day so
 * a later message for the same day replaces it, opening the day's sheet.
 * @param {{ day: string, in: number, out: number, noBank?: boolean }} fig
 * @param {{ day: string, net: number, final: boolean }|null} revision
 * @param {{ appUrl: string, words: string, lock: string }} device
 */
export function pushPayload(fig, revision, device) {
  const { title, body } = wrapText(fig, revision, device.words, device.lock);
  const notification = { title };
  if (body) notification.body = body;
  notification.navigate = dayLink(device.appUrl, fig.day);
  notification.lang = 'en-US';
  notification.tag = 'wrap-' + fig.day;
  return { web_push: DECLARATIVE, notification };
}

/** The app's address of a day's sheet: `<appUrl>#/board?sheet=day&s.day=YYYY-MM-DD` (router.buildHash's format). */
export function dayLink(appUrl, day) {
  const url = new URL(appUrl);
  url.hash = '';
  return url.href.replace(/#$/, '') + '#/board?sheet=day&s.day=' + encodeURIComponent(day);
}

/* ------------------------------------------------------------------------------------------------- helpers */

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}

function isCents(x) {
  return Number.isInteger(x) && Math.abs(x) <= MAX_CENTS;
}

function isIso(text) {
  return typeof text === 'string' && ISO.test(text) && Number.isFinite(Date.parse(text));
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}
