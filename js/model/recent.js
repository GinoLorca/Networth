/**
 * Recent transactions: the plain list of what happened lately on every account, newest first.
 * The Board prints it so that one glance answers "did anything go through today?" without opening a
 * month. It reads the record only; nothing here is computed money, every amount is the bank's own
 * (or a move the owner tapped in, marked as such).
 *
 * What is listed
 *  - every live row dated today or earlier, and a row the bank has dated up to 2 days ahead (banks post-date;
 *    it is listed, but it is not one of today's): purchases, bills, deposits, refunds, fees, interest,
 *    card payments and transfers; pending rows too, and moves the owner tapped in that the bank has
 *    not confirmed yet;
 *  - not a declined purchase (nothing happened), not a tapped-in move the bank has since confirmed
 *    (the bank's own row stands for it), not a row of an account the owner left out;
 *  - a payment or transfer between two of the owner's accounts is one event, listed once, as the
 *    money leaving; its other leg is skipped when both legs are on the record.
 */

import { isLive } from './schema.js';
import { addDays, isYmd } from './dates.js';

/** Banks post-date: a row dated up to this many days after today is listed too. */
export const AHEAD_DAYS = 2;

const DEFAULT_LIMIT = 12;

/**
 * @param {object} state  the document
 * @param {string} today  game day, 'YYYY-MM-DD'
 * @param {{ limit?: number, seenAt?: number|null, accountId?: string|null }} [opts]
 *   limit   rows to return (default 12)
 *   accountId  only this account's rows (then both legs of a payment count: the one on this account is listed)
 *   seenAt  when the owner last looked (ms); a row first stored after it is `isNew`. null: nothing is new.
 * @returns {{
 *   rows: { tx: object, account: object|null, isNew: boolean, provisional: boolean }[],
 *   today: { count: number, out: number, in: number, unsettled: boolean },
 *   fresh: number, total: number, oldest: string|null }}
 *   rows   newest first: by day, then by time when the bank gives one, then by when the row arrived
 *   today  what is dated today: how many, cents out and in (transfers between own accounts are in neither);
 *          `unsettled` when one of them is pending or tapped in, so the sums are not final
 *   fresh  how many listed-or-not rows are new since `seenAt`
 *   total  how many rows there are to list in all; with accountId, every live row of that account on the record,
 *          those dated more than 2 days ahead included (they are counted, not listed)
 *   oldest the day of the earliest of them, or null
 */
export function recentTransactions(state, today, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const seenAt = Number.isFinite(opts.seenAt) ? opts.seenAt : null;
  const only = typeof opts.accountId === 'string' && opts.accountId ? opts.accountId : null;
  const empty = { rows: [], today: { count: 0, out: 0, in: 0, unsettled: false, unsettledIn: false, unsettledOut: false }, fresh: 0, total: 0, oldest: null };
  if (!state || typeof state !== 'object' || !isYmd(today)) return empty;

  const accounts = new Map();
  for (const account of Array.isArray(state.accounts) ? state.accounts : []) {
    if (account && typeof account === 'object' && account.id != null) accounts.set(account.id, account);
  }
  const latest = addDays(today, AHEAD_DAYS);
  // one account's own count is of every live row it has, whatever its day; only the list stops 2 days ahead
  const listed = (tx) => {
    if (!tx || typeof tx !== 'object' || !isLive(tx) || !isYmd(tx.day) || (only === null && tx.day > latest)) return false;
    if (only !== null && tx.accountId !== only) return false;
    const account = tx.accountId != null ? accounts.get(tx.accountId) : null;
    return !(account && account.hidden);
  };
  const txs = (Array.isArray(state.txs) ? state.txs : []).filter(listed);
  // with one account in view its own leg of a payment is the one to show, so no leg is skipped
  const present = only !== null ? new Set() : new Set(txs.map((tx) => tx.id));

  const rows = [];
  const todayTally = { count: 0, out: 0, in: 0, unsettled: false, unsettledIn: false, unsettledOut: false };
  let fresh = 0;
  let oldest = null;
  let ahead = 0; // rows of the one account in view that are dated further ahead: counted, not listed
  for (const tx of txs) {
    if (tx.day > latest) { ahead += 1; continue; }
    const paired = tx.pairId != null && present.has(tx.pairId);
    if (paired && tx.flow === 'in') continue;   // the same event as its outgoing leg
    // an alert the balance took in is settled, and so is a payment reported as paid in cash (3.7)
    const provisional = tx.source === 'manual' && tx.inBalance !== true && !(tx.via === 'income' && tx.income && tx.income.how === 'cash');
    const isNew = seenAt !== null && Number.isFinite(tx.loggedAt) && tx.loggedAt > seenAt;
    if (isNew) fresh += 1;
    if (tx.day === today) {
      todayTally.count += 1;
      const amount = Number.isFinite(tx.amount) ? Math.round(tx.amount) : 0;
      if (!paired) {
        if (tx.flow === 'in') todayTally.in += amount;
        else todayTally.out += amount;
      }
      if (tx.pending || provisional) {
        // each sum is in pencil only for what is unsettled on its own side (a pencil payment in does not make the out sum pencil)
        todayTally.unsettled = true;
        if (!paired) todayTally[tx.flow === 'in' ? 'unsettledIn' : 'unsettledOut'] = true;
      }
    }
    if (oldest === null || tx.day < oldest) oldest = tx.day;
    rows.push({ tx, account: tx.accountId != null ? accounts.get(tx.accountId) || null : null, isNew, provisional });
  }

  const moment = (tx) => (Number.isFinite(tx.at) ? tx.at : 0);
  const arrived = (tx) => (Number.isFinite(tx.loggedAt) ? tx.loggedAt : 0);
  rows.sort((a, b) => (a.tx.day < b.tx.day ? 1 : a.tx.day > b.tx.day ? -1 : 0)
    || moment(b.tx) - moment(a.tx)
    || arrived(b.tx) - arrived(a.tx)
    || (String(a.tx.id) < String(b.tx.id) ? -1 : String(a.tx.id) > String(b.tx.id) ? 1 : 0));

  return { rows: rows.slice(0, limit), today: todayTally, fresh, total: rows.length + ahead, oldest };
}
