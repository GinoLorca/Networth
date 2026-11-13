/**
 * Card purchases within minutes: the text alert the owner's card bank sends for a charge, put by the
 * owner's phone as one file in the inbox folder of their private repository, becomes a provisional move
 * on the card. See ARCHITECTURE.md section 3.6.
 *
 * Pure: it never reads the clock (the time is passed in) and makes no request (the transport is passed
 * in). The text of an alert is read, parsed and dropped: only the amount, the merchant and the day are
 * kept. It is never stored, logged or shown.
 */

import { ACCOUNT_TYPES } from './schema.js';
import { diffDays, gameDay, isYmd, makeYmd } from './dates.js';
import { addProvisional, confirmStored, pruneRemovedAlerts } from './merge.js';

/** An inbox file older than this many days is deleted by any device that sees it. */
export const ALERT_KEEP_DAYS = 14;
/** At most this many files are read in one round; the rest wait for the next. */
export const ALERT_READS_PER_ROUND = 20;
/** A file larger than this is not an alert: it is deleted unread. */
export const ALERT_MAX_BYTES = 2000;
const MAX_CENTS = 10000000;
const MAX_MERCHANT = 60;
const DEFAULT_ROLLOVER_HOUR = 4;
const FILE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.txt$/;
const AMOUNT = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,])/g;
/** Words of a text that is not a purchase or a charge. When one is there, the text is refused. */
const REFUSE = new RegExp([
  '\\bcodes?\\b', 'passcode', 'pass code', 'one[- ]time', '\\botp\\b', '\\bpin\\b', 'verif', 'security', 'password',
  'sign(?:ed)?[- ]?in', 'log(?:ged)?[- ]?in', 'new device', 'new phone', 'browser',
  'payment (?:was |has been )?(?:received|posted|scheduled|processed|due)', 'thank you for (?:your )?payment', 'received your payment',
  '\\bcredit(?:ed|s)?\\b(?!\\s*card)', 'deposit', 'refund', 'returned', '\\breturn\\b', 'revers', 'cash ?back', 'reward',
  'declin', 'denied', 'not approved', 'blocked', 'unsuccessful', 'failed',
  'balance', 'due date', 'is due', 'minimum', 'statement', 'remind', 'autopay', 'past due', '\\blimit\\b',
  'fraud', 'suspicious', 'unusual', 'did you', 'reply', 'dispute', 'transfer', 'zelle', 'withdraw', '\\batm\\b',
  // approval or confirmation codes in any wording, and anything not yet, no longer or never a charge
  '\\bapprov(?:e|al)\\b', '\\bconfirm', '\\benter\\b', 'token', 'access key', 'authori[sz]ation (?:number|code)',
  '\\bvoid', 'cancel', 'not authori', 'unauthori', 'reject', 'could not', 'flagged', 'stopped', '\\bhold\\b', '\\bheld\\b',
  'upcoming', 'schedul', 'renew', 'tomorrow', 'received', 'is this you', '\\btext (?:y|n|yes|no|\\d)\\b',
  '\\binterest\\b', '\\bfees?\\b', '\\bfare\\b', 'temporar', 'may appear', 'javascript:',
  // not completed, not yet charged, or the card stopped
  'not (?:be )?completed', 'did(?: not|n.t) go through', '\\battempt', 'will (?:be )?(?:charged|post)', '\\bexpir',
  'frozen', '\\blocked\\b', 'needs your',
].join('|'), 'i');
/** Words of a purchase or a charge: one of them must be there. */
const CHARGE = /\b(?:purchases?|purchased|transactions?|charged?|charges|spent|spend|used|authori[sz](?:ed|ation))\b/i;
/** Or: the card's digits and "$8.47 at MERCHANT". */
const CARD_AT = /\$\s?[\d,]+\.\d{2}\s+at\s+[a-z0-9]/i;
/** The card's digits: "ending in 4321" or "card ...4321" (some banks give 5). */
const ENDING = /\b(?:ending(?:\s+in)?\s*[:#-]?\s*|card\s*(?:\.{2,3}|\*{2,4}|x{1,4})\s*)(\d{4,5})\b/i;
/** The rest of a sentence: up to a full stop, question or exclamation mark that is not a decimal point. */
const TO_END = '(?:[^.!?]|\\.(?=\\d))*[.!?]?';
/**
 * Boilerplate a card alert may carry: cut before anything is refused, so an ordinary purchase alert holding
 * one is read (opt-out and help lines, rates, fraud report lines, available credit, the owner's alert
 * threshold, safety tips).
 */
const BOILERPLATE = new RegExp([
  '\\b(?:reply|txt|text)\\s+(?:stop|help)\\b' + TO_END,
  '\\bmsg\\s*(?:&|and)\\s*data\\b' + TO_END,
  '\\bto (?:stop|end|opt out of) (?:these |this |all )?(?:alerts?|texts?|messages?)\\b' + TO_END,
  '\\bnot you\\?\\s*' + TO_END,
  '\\b(?:to )?report fraud\\b' + TO_END,
  '\\bavailable credit:?\\s*(?:is\\s*)?\\$\\s?[\\d,]+\\.\\d{2}' + TO_END,
  '\\b(?:(?:exceed(?:ed|s)?|is (?:more|greater|higher|over) than|above|over)\\s+)?(?:your |the )?(?:\\$\\s?[\\d,]+\\.\\d{2}\\s+)?(?:alert (?:limit|threshold|amount)|amount you set)\\b' + TO_END,
  '\\bsecurity tip:' + TO_END,
  '\\bview your balance\\b' + TO_END,
].join('|'), 'gi');
/** Phone numbers, dates and clock times: their digits are no code. */
const NOT_CODES = new RegExp([
  '(?:\\+?1[-. ]?)?\\(?\\d{3}\\)?[-. ]\\d{3}[-. ]\\d{4}',
  '\\b\\d{4}-\\d{2}-\\d{2}\\b', '\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b',
  '\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b',
  '\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?,?\\s+\\d{4}\\b',
  '\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b',
].join('|'), 'gi');
/** A bare run of 4 to 8 digits: what a code is. */
const CODE_DIGITS = /(?<![\d,.$])\d{4,8}(?![\d,]|\.\d)/;

/** Control, invisible and direction characters: each becomes a space. Built from code points so the source holds none. */
const INVISIBLE = new RegExp('[' + [[0x0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]]
  .map(([a, b]) => String.fromCharCode(92) + 'u' + a.toString(16).padStart(4, '0') + '-' + String.fromCharCode(92) + 'u' + b.toString(16).padStart(4, '0')).join('') + ']+', 'g');
/** Typographic double quotes, built the same way. */
const QUOTES = new RegExp('["$' + String.fromCharCode(0x201c, 0x201d) + ']', 'g');

function clean(text) {
  return text.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

/** A merchant's name from the text after "at" or "with": quotes gone, no trailing "was approved", "has been ..." or "is ...", at most 60 characters. */
function nameOf(rest) {
  const end = rest.search(/\s+on\s|\.(?:\s|$)|,|\s+(?:with|using)\s+(?:your\s+)?card\b/i);
  const name = clean((end < 0 ? rest : rest.slice(0, end)).replace(QUOTES, ' ')).replace(/[.\s]+$/, '')
    .replace(/\s+(?:was (?:approved|made|authori[sz]ed)|has been\b.*|is\b.*)$/i, '').trim();
  return name.length > MAX_MERCHANT ? name.slice(0, MAX_MERCHANT).trim() : name;
}

function merchantIn(text) {
  const at = /\bat\s+/gi;
  let m;
  while ((m = at.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    if (/^\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?(?:\s|$|[.,])/i.test(rest)) continue; // "at 3:45 PM" is a time
    const name = nameOf(rest);
    if (name) return name;
  }
  // no merchant after " at ": "a $12.34 transaction with CORNER DELI"
  const by = /\bwith\s+(?!(?:your|the|a|an|card|credit|debit)\b)/i.exec(text);
  const name = by ? nameOf(text.slice(by.index + by[0].length)) : '';
  return name || 'Card purchase';
}

/**
 * Read a card bank's text alert.
 * @param {string} text  the message as it arrived (never kept)
 * @returns {{ amount: number, merchant: string, last4: string|null }|null}  amount in cents; null for
 *          anything that is not plainly a purchase or a charge (codes, sign-ins, payments, credits,
 *          refunds, declines, reminders, markup, no amount or two, an amount under 1 cent or over $100,000)
 */
export function parseAlert(text) {
  if (typeof text !== 'string' || text.length > ALERT_MAX_BYTES) return null;
  // the boilerplate is cut first; the refusals and the one-figure test apply to what is left
  const plain = clean(clean(text).replace(BOILERPLATE, ' '));
  if (!plain || !plain.includes('$')) return null;
  if (/<\s*\/?\s*[a-z!?]|&[a-z#0-9]+;|\{|\}/i.test(plain)) return null; // markup is no alert
  if (/-\s*\$|\$\s*-|\(\s*\$/.test(plain)) return null;           // a negative figure: money back
  const last = ENDING.exec(plain);
  if (REFUSE.test(plain) || !(CHARGE.test(plain) || (last && CARD_AT.test(plain)))) return null;
  // a bare run of 4 to 8 digits that is not the card's, the amount, a phone number, a date or a time: a code
  if (CODE_DIGITS.test(plain.replace(ENDING, ' ').replace(AMOUNT, ' ').replace(NOT_CODES, ' '))) return null;
  const figures = new Set();
  for (const m of plain.matchAll(AMOUNT)) figures.add(m[1]);
  if (figures.size !== 1) return null;
  const amount = Math.round(Number([...figures][0].replace(/,/g, '')) * 100);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CENTS) return null;
  return { amount, merchant: merchantIn(plain), last4: last ? last[1].slice(-4) : null };
}

/**
 * The name of an inbox file, read: the phone's local time it was written at.
 * @param {string} name  "yyyyMMdd-HHmmss-SSS.txt"
 * @returns {{ stem: string, ms: number, id: string }|null}
 */
export function alertFile(name) {
  const m = typeof name === 'string' ? FILE.exec(name) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number);
  if (!isYmd(makeYmd(y, mo, d)) || h > 23 || mi > 59 || s > 59) return null;
  const local = new Date(y, mo - 1, d, h, mi, s, ms);
  if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) return null;
  const stem = name.slice(0, -4);
  return { stem, ms: local.getTime(), id: 'alert_' + stem };
}

function rolloverOf(state) {
  const hour = state && state.settings ? state.settings.rolloverHour : null;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_ROLLOVER_HOUR;
}

/** The game day an inbox file belongs to (never after today). */
export function alertDay(state, file, today) {
  const day = gameDay(file.ms, rolloverOf(state));
  return isYmd(today) && day > today ? today : day;
}

/**
 * The account a card alert belongs to: the shown bank card whose name holds the last 4 digits; else,
 * when exactly one bank card is shown, that one; else none.
 */
export function cardFor(state, last4) {
  const cards = (state && Array.isArray(state.accounts) ? state.accounts : []).filter((a) => a && !a.hidden
    && a.source === 'bank' && ACCOUNT_TYPES[a.type] && ACCOUNT_TYPES[a.type].group === 'card');
  if (last4) {
    const named = cards.find((a) => [a.name, a.nick, a.institution].some((n) => typeof n === 'string' && n.includes(last4)));
    if (named) return named;
  }
  return cards.length === 1 ? cards[0] : null;
}

/** The move an inbox file became on this device, if it did. */
export function alertMove(state, file) {
  return state && Array.isArray(state.txs) ? state.txs.find((tx) => tx && tx.id === file.id) || null : null;
}

/**
 * Put a parsed alert in the record as a provisional move on the card (`via: 'alert'`, id from the file
 * name). A bank row the record already holds for it confirms it at once.
 * @returns {object|null} the move; null when the record already holds it or the amount is not one
 */
export function addAlertMove(state, alert, file, nowMs) {
  if (!state || !alert || !file || alertMove(state, file) || removedAlert(state, file)) return null;
  const today = gameDay(nowMs, rolloverOf(state));
  const card = cardFor(state, alert.last4);
  const tx = addProvisional(state, {
    amount: alert.amount, merchant: alert.merchant, day: alertDay(state, file, today), accountId: card ? card.id : null,
  }, nowMs);
  if (!tx) return null;
  tx.id = file.id;
  tx.via = 'alert';
  tx.at = file.ms;
  if (card && Number.isFinite(card.balance) && Number.isFinite(card.asOf)) {
    // the amount owed and its date as the record held them when the purchase arrived (ARCHITECTURE 3.2, merge.takeIntoBalance)
    tx.seenOwed = -card.balance;
    tx.seenAsOf = card.asOf;
  }
  confirmStored(state, tx);
  return tx;
}

/** Whether the owner removed the move an inbox file became (state.alertsRemoved). */
export function removedAlert(state, file) {
  return !!state && Array.isArray(state.alertsRemoved) && state.alertsRemoved.some((entry) => entry && entry.id === file.id);
}

/**
 * Whether an inbox file is done with: its move was confirmed by the bank's row or taken in by the balance,
 * the owner removed its move, or it is too old.
 */
export function alertDone(state, file, today) {
  const move = alertMove(state, file);
  if (move && (move.matchId || move.inBalance === true)) return true;
  if (removedAlert(state, file)) return true;
  const day = gameDay(file.ms, rolloverOf(state));
  return isYmd(today) && diffDays(day, today) > ALERT_KEEP_DAYS;
}

/**
 * One reading of the inbox.
 * device: { state(), stale(), update(change), seen: Set<string> }
 * transport: { list() -> [{ name, sha, size }], read(name) -> string|null, remove(name, sha) }
 * Every file not seen before is read once: one that parses becomes a move, one that does not is deleted
 * at once; a file whose move the bank confirmed, or older than 14 days, is deleted. A file this device
 * read whose move is gone from the record (the owner removed it) is not read again, and the file of a move
 * the owner removed (state.alertsRemoved) is deleted. `refused` counts the files read that were not purchases.
 * @returns {Promise<{ ok: boolean, added: number, deleted: number, refused: number }>}
 */
export async function roundAlerts(device, transport, nowMs) {
  const result = { ok: false, added: 0, deleted: 0, refused: 0 };
  if (device.stale()) return result;
  const remembered = device.state();
  if (remembered && Array.isArray(remembered.alertsRemoved)
    && pruneRemovedAlerts({ alertsRemoved: remembered.alertsRemoved }, nowMs).length !== remembered.alertsRemoved.length) {
    device.update((s) => { pruneRemovedAlerts(s, nowMs); });
  }
  const listed = await transport.list();
  const files = [];
  for (const entry of Array.isArray(listed) ? listed : []) {
    const file = entry && alertFile(entry.name);
    if (file && typeof entry.sha === 'string') files.push({ ...file, name: entry.name, sha: entry.sha, size: entry.size });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  let reads = 0;
  for (const file of files) {
    if (device.stale()) return result;
    const state = device.state();
    const today = gameDay(nowMs, rolloverOf(state));
    let drop = alertDone(state, file, today) || !(file.size >= 0 && file.size <= ALERT_MAX_BYTES);
    if (!drop && !alertMove(state, file) && !device.seen.has(file.name)) {
      if (reads >= ALERT_READS_PER_ROUND) continue;
      reads += 1;
      const text = await transport.read(file.name);
      if (device.stale()) return result;
      const alert = parseAlert(text);
      device.seen.add(file.name);
      if (!alert) { drop = true; result.refused += 1; }
      else {
        let made = null;
        device.update((s) => { made = addAlertMove(s, alert, file, nowMs); });
        if (made) result.added += 1;
        if (made && made.matchId) drop = true;
      }
    }
    if (drop) {
      if (device.stale()) return result;
      await transport.remove(file.name, file.sha);
      result.deleted += 1;
    }
  }
  result.ok = true;
  return result;
}

/**
 * What the Settings line says: the latest move that came from an alert, and how many still wait for the
 * bank's own row.
 * @returns {{ last: { at: number, merchant: string, amount: number }|null, waiting: number }}
 */
export function alertStatus(state, today) {
  let last = null;
  let waiting = 0;
  for (const tx of state && Array.isArray(state.txs) ? state.txs : []) {
    if (!tx || tx.via !== 'alert' || tx.source !== 'manual') continue;
    if (!tx.matchId && tx.inBalance !== true && !(isYmd(today) && isYmd(tx.day) && diffDays(tx.day, today) > 7)) waiting += 1;
    const at = Number.isFinite(tx.at) ? tx.at : tx.loggedAt;
    if (!last || at > last.at) last = { at, merchant: tx.merchant, amount: tx.amount };
  }
  return { last, waiting };
}
