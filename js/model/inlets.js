/**
 * Money in by source (DESIGN Appendix G, pass 3): the owner's sources ("inlets" in the code, Reinforcements / Money in
 * on the page), the filings that send money in to them ("into" entries), the deposits to file, the suggested sources,
 * the figures of the section and of Fig. 1. Everything the owner decides travels in the `flows` section
 * (flowsection.js: `inlets`, `into` and `offers`, ARCHITECTURE 3.11), cell by cell, with Undo.
 *
 *   inletsOf(state)                       the sources the copy holds: live, archived (`gone`) and removed
 *   filingOf(look, tx)                    which filing wins for one deposit or reported payment (G.3's precedence;
 *                                         flowsection.js holds G.3's reader, which the pay fix reads too: re-exported)
 *   lookOf(state)                         what filingOf reads, made once a call
 *   attribute(look, rows)                 money in rows (flows.inflow) by source, Windfalls and Not yet filed
 *   moneyInBySource(state, nowMs, days, { io })   the section: each source's money, share and change (a Steady pay
 *                                         source's paydays like with like, as In and out's), money per session, 12
 *                                         months for Back-end and One-off, Not yet filed, Windfalls and its change,
 *                                         All earned (In and out's change less Windfalls'), prospects, the archive
 *   figOne(state, nowMs)                  Fig. 1: 12 months by source on one scale
 *   depositQueue(state, nowMs)            the deposits to file, one item per payer or reporting app, a catch-all deposit
 *                                         on its own
 *   suggestions(state, nowMs)             suggested sources (s, r and p keys), shown and dismissed
 *   fileQueueItem, fileDeposit, makeInlet, editInlet, acceptOffer, dismissOffer, restoreOffer, moneyInMove
 *                                         the owner's actions, each meant for one undoable store.update
 *
 * Counting is flows.inflow's rule (G.2): bank deposits, plus payments the owner's other apps reported that no bank deposit
 * has matched (pencil, or cash). A matched payment counts once, as its bank deposit, and is filed by its reported key.
 * Refunds, transfers, card and loan payments and deposits on a card are never money in (the ledger's moneyIn).
 *
 * Pure: no clock (every function that needs "now" takes nowMs), no DOM, no storage. The one random draw is a new
 * source's id (`newInletId`), which a caller may pass in.
 */

import { addDays, addMonthsYm, isYmd, monthOf } from './dates.js';
import { makeLedger } from './ledger.js';
import { merchantKeyOf, noteMove, rowWhere } from './corrections.js';
import { learnRule } from './classify.js';
import { payeeKey } from './byhand.js';
import {
  CATCH_ALL_IN, INLETS_LIVE_MAX, LEAVE, WINDFALL, WINDFALL_RULES, appKey, filingAbove, filingOf, floorOf, inletCount, inletsOf, isCatchAllIn,
  isReal, keysOf, latestReal, lookOf, noteInlet, noteInto, noteOffer, offerStamp, paymentKey, storedFlows,
} from './flowsection.js';
import { refresh } from './detect.js';
import { ACCOUNT_TYPES } from './schema.js';
import { inAndOut, windowsOf } from './flows.js';

// G.3's reader lives in flowsection.js (the pay fix reads it there, PAYDAYS section 7); its callers keep this module
export { CATCH_ALL_IN, LEAVE, WINDFALL, appKey, filingAbove, filingOf, inletsOf, isCatchAllIn, isReal, keysOf, latestReal, lookOf, paymentKey };

/** The four kinds of a source (G.1), in the order the sheet offers them. */
export const INLET_KINDS = Object.freeze(['steady', 'job', 'backend', 'oneoff']);
/** Kinds read over 12 months rather than the period (a payer who pays every few months). */
export const YEAR_KINDS = Object.freeze(['backend', 'oneoff']);
/** A source's name: 1 to 40 characters (the reader's limit). */
export const INLET_NAME_MAX = 40;
/** Money in looks back this many days at most, never before the shared floor (decision 13, approved). */
export const IN_DAYS = 365;
/** The months Fig. 1 draws. */
export const FIG_MONTHS = 12;

const ROYALTIES = 'builtin:royalties';
/** A deposit sent by Zelle: its key names the sender (DESIGN 6). */
const ZELLE_IN = 'builtin:zelle-received';
/** The first chip is a guess only when this many latest deposits from the key went to one source. */
const GUESS_DEPOSITS = 2;

/* ------------------------------------------------------------------ keys */

/** 13 hex digits of a 52-bit hash, the same on every device (byhand.payeeKey). */
function hash13(text) {
  return payeeKey(String(text)).slice(1);
}

/** The reporting app of a reported payment's key `{source}/{item}`. */
function sourceOfKey(key) {
  const text = String(key || '');
  const slash = text.indexOf('/');
  return slash > 0 ? text.slice(0, slash) : text;
}

/** A pay stream's suggestion key: 's' and the hash of its key as corrections.streams keys it ('p…|a…'). */
export function streamOfferKey(stream, accounts) {
  const payer = stream && typeof stream.accountId === 'string' ? merchantKeyOf(stream.mkey) : null;
  const account = payer ? accounts.get(stream.accountId) : null;
  return account ? 's' + hash13(payer + '|' + account.key) : null;
}

/** A new source's id: 'n' and 13 random hex digits. */
export function newInletId() {
  const bytes = new Uint8Array(7);
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'n' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 13);
}

/**
 * A name as the reader takes it: trimmed, no control characters, at most 40 UTF-16 units without splitting a pair;
 * '' when nothing is left.
 */
export function inletName(text) {
  const clean = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of clean) {
    if ((out + ch).length > INLET_NAME_MAX) break;
    out += ch;
  }
  // a lone surrogate the source text carried would be refused: drop it
  return out.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1').trim();
}

/**
 * A goal as typed on the source's sheet ("1,000", "$45.50") to whole cents: null for nothing, or for 0 (round 4: 0 clears
 * a goal); NaN for anything that is not an amount of at most 2 decimals, which the sheet refuses with its own message.
 */
export function goalCents(text) {
  const clean = String(text == null ? '' : text).replace(/[$,\s]/g, '');
  if (!clean) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return NaN;
  const cents = Math.round(Number(clean) * 100);
  if (cents === 0) return null;
  return cents >= 1 && cents <= 1e10 ? cents : NaN;
}

/* ------------------------------------------------------------------ attributing money in */

function bucket() {
  return { cents: 0, bank: 0, pencil: 0, cash: 0, est: false, sessions: 0, sessionCents: 0, reported: false, days: new Set(), what: new Set(), rows: [] };
}

function add(one, tx, how, filing) {
  const amount = Math.round(tx.amount);
  one.cents += amount;
  one[how] += amount;
  if (how === 'pencil' || (how === 'bank' && tx.pending)) one.est = true;
  if (how === 'bank') one.days.add(tx.day);
  one.rows.push({ tx, how, filing });
}

/**
 * Money in rows (flows.inflow's `rows`) by where they are filed: `sources` (source id -> bucket), `windfalls` and
 * `unfiled` (left ones included). A bucket counts cents (bank, pencil, cash), its paydays (days with a bank deposit), and
 * its sessions: each reported payment is one, and a bank deposit counts the payments paired with it (G.6).
 */
export function attribute(look, rows) {
  const out = { sources: new Map(), windfalls: bucket(), unfiled: bucket() };
  for (const { tx, how } of rows) {
    const filing = filingOf(look, tx);
    let one;
    if (filing.to === WINDFALL) {
      one = out.windfalls;
      one.what.add(filing.how === 'rule' ? WINDFALL_RULES[tx.ruleId] : 'yours');
    } else if (filing.to) {
      if (!out.sources.has(filing.to)) out.sources.set(filing.to, bucket());
      one = out.sources.get(filing.to);
    } else {
      one = out.unfiled;
    }
    add(one, tx, how, filing);
    // a reported payment is one session; a bank deposit counts the payments paired with it; a move tapped in, none
    const paired = tx.source === 'manual' ? 0 : (look.paired.get(tx.id) || []).length;
    if (tx.source === 'manual' && tx.via === 'income') {
      one.sessions += 1;
      one.sessionCents += Math.round(tx.amount);
      one.reported = true;
    } else if (paired > 0) {
      one.sessions += paired;
      one.sessionCents += Math.round(tx.amount);
      one.reported = true;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the section */

function ledgerOf(state, nowMs, opts) {
  return opts && typeof opts === 'object' && opts.ledger ? opts.ledger : makeLedger(state, nowMs);
}

/** The 12 calendar months that end with today's, and the first of them on record (the shared floor's month). */
export function monthsFrame(today, floor) {
  const last = monthOf(today);
  const months = [];
  for (let k = FIG_MONTHS - 1; k >= 0; k--) months.push(addMonthsYm(last, -k));
  const firstOnRecord = isYmd(floor) ? monthOf(floor) : null;
  return { months, firstOnRecord, from: isYmd(floor) && floor > months[0] + '-01' ? floor : months[0] + '-01', to: today };
}

/** The cents of rows. */
function centsOf(rows) {
  return rows.reduce((n, { tx }) => n + Math.round(tx.amount), 0);
}

/**
 * The paydays in some money-in rows, stream by stream, as f414276's In and out reads them (flows.js, whose own copy is
 * private, PAYDAYS (c)): for each pay stream, the days with a bank deposit linked to it and what those deposits bring.
 * Two payers paid on one day are two paydays, one of each. A Steady pay source reads the rows filed to it (PAYDAYS (e)).
 * @returns {Map<string, { count: number, cents: number, days: Set<string> }>}
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
  return new Map([...byStream].map(([id, one]) => [id, { count: one.days.size, cents: one.cents, days: one.days }]));
}

/**
 * Paydays like with like (DESIGN 5), stream by stream, with f414276's In and out arithmetic: a stream with more paydays
 * than in the window before, or fewer, leaves its difference out of the change (the extra count times its mean a payday
 * in this window, or in the window before when this one holds none).
 * @returns {{ id, now, before, extra, left }[]}  the streams paid in either window, in `ids`' order
 */
function likeWithLike(now, before, ids) {
  const none = { count: 0, cents: 0 };
  const out = [];
  for (const id of ids) {
    const a = now.get(id) || none;
    const b = before.get(id) || none;
    if (!a.count && !b.count) continue;
    const extra = a.count - b.count;
    const mean = a.count > 0 ? a.cents / a.count : b.cents / b.count;
    out.push({ id, now: a.count, before: b.count, extra, left: Math.round(extra * mean) });
  }
  return out;
}

/**
 * Paydays like with like on a row's own rows (PAYDAYS (e)): In and out's arithmetic on the bank deposits the row holds,
 * over In and out's pay set, stream by stream. `now`, `before` and `extra` count the streams the change compares;
 * `mixed` when one stream has more paydays than before and another fewer (the counts alone would read "as before");
 * `days`, by stream, the days of the period that are paydays here (the row's "in other rows" reads them).
 */
function rowPaydays(rows, wasRows, pay) {
  const a = paydaysOf(rows, pay.ids);
  const days = new Map([...a].map(([id, one]) => [id, one.days]));
  if (!wasRows) {
    let n = 0;
    for (const one of a.values()) n += one.count;
    return { streams: [...a.keys()], days, paydays: n ? { now: n, before: null, extra: 0, left: 0, mixed: false } : null, left: 0 };
  }
  const ll = likeWithLike(a, paydaysOf(wasRows, pay.ids), pay.order);
  const out = { now: 0, before: 0, extra: 0, left: 0, mixed: false };
  let more = false;
  let fewer = false;
  for (const one of ll) {
    out.left += one.left;
    out.now += one.now;
    out.before += one.before;
    out.extra += one.extra;
    if (one.extra > 0) more = true;
    if (one.extra < 0) fewer = true;
  }
  out.mixed = more && fewer;
  return { streams: ll.map((one) => one.id), days, paydays: ll.length ? out : null, left: out.left };
}

/**
 * The money-in section for a period (DESIGN 4 and 5, G.1 to G.6; PAYDAYS (d) and (e)): each source with money in the 12
 * months on record, its money in the period, its share of what was earned (Windfalls outside every share), and its
 * change against the window before when the record covers it.
 * - A Steady pay source runs In and out's like with like (f414276's) on the bank deposits filed to it, stream by stream,
 *   over In and out's pay set (a payday of the row is a day with a deposit of a pay stream filed to it), and counts the
 *   paydays of its streams in the period that sit only in other rows (`elsewhere`). By the job: its money's change, deposit for deposit.
 *   Back-end and One-off are read over 12 months instead ("on record, paid in n of m months").
 * - Beyond the queue (the window before begins before queueFrom: always at 365 days), a Steady pay or By the job row
 *   leaves out of its change, in both windows, the deposits filed on their own, which the year before never was asked
 *   about; a row left with nothing has no change (`oneAtATime`), and a row that keeps a change counts what it left out
 *   (`leftOneAtATime`), which its caption names.
 * - Windfalls' change is its money's change less the like with like of the pay deposits a built-in rule files there;
 *   All earned's change is In and out's Money in change (`io`, the In and out the page shows) less Windfalls'.
 * A source paid through the reporting app gives money per session. Not yet filed has its own row. Sources with no money
 * on record (since the shared floor) are prospects; a source paid only before the 12 months keeps a quiet row with the
 * day it was last paid (`last`, round 6); archived sources keep their money (so the rows add up) and are listed apart
 * when they have none.
 * @param {{ io?: object, look?: object, ledger?: object }} [opts]  io: flows.inAndOut on the same ledger and period
 * @returns {object}
 */
export function moneyInBySource(state, nowMs, days, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const look = opts && opts.look ? opts.look : lookOf(state);
  const io = opts && opts.io ? opts.io : inAndOut(state, nowMs, days, { ledger });
  const floor = floorOf(state);
  const w = windowsOf(ledger.today, days, floor);
  const now = attribute(look, ledger.moneyIn(w.from, w.to).rows);
  const before = w.comparable ? attribute(look, ledger.moneyIn(w.prevFrom, w.prevTo).rows) : null;
  const frame = monthsFrame(ledger.today, floor);
  const year = attribute(look, ledger.moneyIn(frame.from, frame.to).rows);
  const onRecord = frame.firstOnRecord ? frame.months.filter((ym) => ym >= frame.firstOnRecord).length : 0;
  const monthsPaid = (one) => new Set(one.rows.map((row) => monthOf(row.tx.day))).size;
  // In and out's pay set, in its order (PAYDAYS (b), (c)): the rows compare their paydays as it does
  const order = ledger.payStreams().map((stream) => stream.id);
  const pay = { order, ids: new Set(order) };
  // the window before lies beyond the queue's reach (always at 365 days): its deposits filed one at a time never were
  const beyond = !!before && w.prevFrom < queueFrom(ledger.today, floor);
  const compared = (rows) => (beyond ? rows.filter((row) => row.filing.how !== 'deposit') : rows);
  // the period's paydays of each pay stream (days with a deposit linked to it, as In and out counts them), by the row
  // that holds them (a source's id, 'unfiled' or 'windfalls'): stream id -> row id -> its days
  const holders = new Map();
  const hold = (id, one) => {
    for (const { tx, how } of one.rows) {
      if (how !== 'bank' || tx.streamId == null || !pay.ids.has(tx.streamId)) continue;
      if (!holders.has(tx.streamId)) holders.set(tx.streamId, new Map());
      const byRow = holders.get(tx.streamId);
      if (!byRow.has(id)) byRow.set(id, new Set());
      byRow.get(id).add(tx.day);
    }
  };
  for (const [id, one] of now.sources) hold(id, one);
  hold('unfiled', now.unfiled);
  hold('windfalls', now.windfalls);
  let earned = now.unfiled.cents;
  for (const one of now.sources.values()) earned += one.cents;
  // a source with nothing in the 12 months nor the period is a prospect only while nothing on record since the shared
  // floor is filed to it (round 6: BUILD-3 item 5, "no money in the record"); one paid before keeps a quiet row and the
  // day it was last paid. Read only when such a source exists
  const lastPaid = new Map();
  // round 9 (F4): a Back-end or One-off source with nothing in the 12 months is quiet even when the 365-day period, which
  // starts up to 30 days before them, holds its money
  const waiting = [...look.inlets.values()].some((inlet) => !inlet.removed && !inlet.gone && !year.sources.has(inlet.id)
    && (YEAR_KINDS.includes(inlet.kind) || !now.sources.has(inlet.id)));
  if (waiting && isYmd(floor) && floor < frame.from) {
    const older = attribute(look, ledger.moneyIn(floor, addDays(frame.from, -1)).rows);
    for (const [id, one] of older.sources) for (const { tx } of one.rows) if (!lastPaid.has(id) || tx.day > lastPaid.get(id)) lastPaid.set(id, tx.day);
  }
  const rows = [];
  const prospects = [];
  const archived = [];
  for (const inlet of look.inlets.values()) {
    if (inlet.removed) continue;
    const here = now.sources.get(inlet.id) || bucket();
    const was = before ? before.sources.get(inlet.id) || bucket() : null;
    const twelve = year.sources.get(inlet.id) || bucket();
    const yearly = YEAR_KINDS.includes(inlet.kind);
    // quiet (round 6): nothing in the 12 months; a source read over 12 months is quiet then whatever the period holds (round
    // 9, F4: at 365 days the period starts before the 12 months, and "$0 on record" beside its money read as a contradiction)
    const quiet = !twelve.rows.length && (yearly || !here.rows.length);
    if (quiet && !here.rows.length && (inlet.gone || !lastPaid.has(inlet.id))) {
      (inlet.gone ? archived : prospects).push({ ...inlet });
      continue;
    }
    const steady = inlet.kind === 'steady';
    const hereRows = was && !yearly ? compared(here.rows) : here.rows;
    const wasRows = was && !yearly ? compared(was.rows) : null;
    const read = steady ? rowPaydays(hereRows, wasRows, pay) : null;
    let paydays = read ? read.paydays : null;
    if (steady) {
      // its streams' paydays of the period that sit only in other rows (a paycheck filed elsewhere is a payday fewer here):
      // the days of each stream's deposits in other rows that are no payday here
      let elsewhere = 0;
      for (const id of read.streams) {
        const mine = read.days.get(id) || new Set();
        const others = new Set();
        for (const [holder, days] of holders.get(id) || []) if (holder !== inlet.id) for (const day of days) if (!mine.has(day)) others.add(day);
        elsewhere += others.size;
      }
      if (elsewhere) paydays = { ...(paydays || { now: 0, before: wasRows ? 0 : null, extra: 0, left: 0, mixed: false }), elsewhere };
      else if (paydays) paydays = { ...paydays, elsewhere: 0 };
    }
    // beyond the queue a row holding only deposits filed one at a time has nothing to compare
    const oneAtATime = !!wasRows && beyond && !hereRows.length && !wasRows.length && (here.rows.length + was.rows.length) > 0;
    // beyond the queue, a row that compares what is left: how many of its deposits filed one at a time the change leaves out
    const leftOneAtATime = wasRows && beyond && !oneAtATime ? here.rows.length - hereRows.length + was.rows.length - wasRows.length : 0;
    rows.push({
      ...inlet,
      cents: here.cents, bank: here.bank, pencil: here.pencil, cash: here.cash, est: here.est,
      share: earned > 0 ? here.cents / earned : null,
      before: was ? was.cents : null,
      change: was && !yearly && !oneAtATime ? centsOf(hereRows) - centsOf(wasRows) - (read ? read.left : 0) : null,
      oneAtATime,
      leftOneAtATime,
      paydays,
      sessions: here.reported && here.sessions > 0 ? { n: here.sessions, per: Math.round(here.sessionCents / here.sessions) } : null,
      // a quiet row (round 6): the day it was last paid, before the 12 months
      last: quiet ? lastPaid.get(inlet.id) : null,
      // the Remove confirm counts the deposits apart from the payments your other app reported (cash and pencil ones
      // included, which never were deposits: round 5)
      // `since`: the first month the 12-month lines count (round 9, F4: the lines name it, as the queue names its first day)
      year: { cents: twelve.cents, est: twelve.est, paid: monthsPaid(twelve), months: onRecord, since: monthOf(frame.from), cash: twelve.cash,
        deposits: twelve.rows.filter((one) => !isReported(one.tx)).length, payments: twelve.rows.filter((one) => isReported(one.tx)).length },
    });
  }
  rows.sort((a, b) => b.cents - a.cents || b.year.cents - a.year.cents || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
  const earnedBefore = before ? [...before.sources.entries()].filter(([id]) => { const inlet = look.inlets.get(id); return inlet && !inlet.removed; })
    .reduce((n, [, one]) => n + one.cents, before.unfiled.cents) : null;
  // Windfalls' change: its money's change, less the like with like of the pay deposits a built-in rule files there
  // (benefits detection reads as salary: In and out compares their paydays); All earned's change is In and out's less it.
  // Beyond the queue (round 10), Windfalls leaves out, in both windows, the deposits filed to it on their own, as a Steady
  // pay or By the job row does: the year before's were never asked about, so the same money filed this year read as new
  // there and as a drop in All earned.
  // Round 11: the like with like of those pay streams reads all their deposits in both windows, wherever they are filed,
  // as In and out reads them, so a benefit moved on its own to a source reads as money moved (Windfalls lower, All
  // earned higher), never as a payday fewer in Windfalls.
  // Round 11 (D6): beyond the queue, when either window of Windfalls holds deposits filed to it on their own, All
  // earned's change has no reading: the year before was never asked about, so whether its deposits of those kinds were
  // earned or not is unknown, and no formula reads both a gift new this year and the same cash-outs filed only this year
  // right. All earned then reads "—", and Windfalls compares what is left (its own "—" when nothing is); In and out
  // keeps its change
  const ruleStreams = new Set();
  for (const one of before ? [now.windfalls, before.windfalls] : [now.windfalls]) {
    for (const row of one.rows) if (row.filing.how === 'rule' && row.how === 'bank' && row.tx.streamId != null && pay.ids.has(row.tx.streamId)) ruleStreams.add(row.tx.streamId);
  }
  const ofRuleStreams = (all) => {
    const out = [];
    for (const one of [...all.sources.values(), all.unfiled, all.windfalls]) for (const row of one.rows) if (row.how === 'bank' && ruleStreams.has(row.tx.streamId)) out.push(row);
    return out;
  };
  const windOne = beyond ? [...now.windfalls.rows, ...before.windfalls.rows].filter((row) => row.filing.how === 'deposit').length : 0;
  const windNow = compared(now.windfalls.rows);
  const windWas = before ? compared(before.windfalls.rows) : null;
  const windNothing = windOne > 0 && !windNow.length && !windWas.length;
  const ruleLeft = before && ruleStreams.size ? rowPaydays(ofRuleStreams(now), ofRuleStreams(before), pay).left : 0;
  const windChange = before && !windNothing ? centsOf(windNow) - centsOf(windWas) - ruleLeft : null;
  const earnedChange = before && !windOne && io && io.in && io.in.change != null ? io.in.change - windChange : null;
  return {
    window: w,
    rows,
    unfiled: { cents: now.unfiled.cents, est: now.unfiled.est, cash: now.unfiled.cash, share: earned > 0 ? now.unfiled.cents / earned : null, before: before ? before.unfiled.cents : null,
      ...unfiledHolds(now.unfiled) },
    earned: { cents: earned, est: now.unfiled.est || rows.some((row) => row.est), before: earnedBefore, change: earnedChange, oneAtATime: windOne > 0 },
    windfalls: { cents: now.windfalls.cents, est: now.windfalls.est, cash: now.windfalls.cash, what: [...now.windfalls.what].sort(),
      before: before ? before.windfalls.cents : null, change: windChange, oneAtATime: windNothing, leftOneAtATime: windNothing ? 0 : windOne },
    prospects: prospects.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)),
    archived: archived.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    frame: { ...frame, onRecord },
  };
}

/**
 * What Not yet filed holds that the queue never asks about (round 5: the note under its row names the way to file it):
 * `pending`, the cents of deposits that have not posted (queued once they post); `apps`, the cents of each reporting
 * app's payments and paired deposits (its key: Add on its suggestion files them in one tap).
 */
function unfiledHolds(one) {
  let pending = 0;
  const apps = {};
  for (const { tx, how, filing } of one.rows) {
    const cents = Math.round(tx.amount);
    if (how === 'bank' && tx.pending) pending += cents;
    else if (filing.keys.apps.length) apps[filing.keys.apps[0]] = (apps[filing.keys.apps[0]] || 0) + cents;
  }
  return { pending, apps };
}

/** A payment another app reported (cash, or pencil until a bank deposit matches it). */
function isReported(tx) {
  return !!tx && tx.source === 'manual' && tx.via === 'income';
}

/* ------------------------------------------------------------------ Fig. 1 */

/**
 * Fig. 1 (G.4): one row per source with money in the 12 months on record, by its 12-month total, Not yet filed last;
 * each month split into bank (and cash) money and pencil money. Months before the record's first month are blank.
 * `goal` is a monthly goal (a yearly one draws nothing in the row).
 * @returns {{ months: string[], first: string|null, today: string, rows: object[] }}
 */
export function figOne(state, nowMs, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const look = opts && opts.look ? opts.look : lookOf(state);
  const floor = floorOf(state);
  const frame = monthsFrame(ledger.today, floor);
  const year = attribute(look, ledger.moneyIn(frame.from, frame.to).rows);
  const rowOf = (id, name, one, goal) => {
    const byMonth = new Map(frame.months.map((ym) => [ym, { ym, bank: 0, pencil: 0 }]));
    for (const { tx, how } of one.rows) {
      const cell = byMonth.get(monthOf(tx.day));
      if (!cell) continue;
      if (how === 'pencil' || (how === 'bank' && tx.pending)) cell.pencil += Math.round(tx.amount);
      else cell.bank += Math.round(tx.amount);
    }
    const cells = frame.months.map((ym) => ({ ...byMonth.get(ym), blank: !frame.firstOnRecord || ym < frame.firstOnRecord }));
    const onRecord = cells.filter((cell) => !cell.blank).length;
    return {
      id, name, total: one.cents, est: one.est || one.pencil > 0, cash: one.cash,
      paid: cells.filter((cell) => !cell.blank && cell.bank + cell.pencil > 0).length, onRecord, goal, cells,
    };
  };
  const rows = [];
  for (const [id, one] of year.sources) {
    const inlet = look.inlets.get(id);
    if (!inlet || inlet.removed || !one.rows.length) continue;
    rows.push(rowOf(id, inlet.name, one, inlet.goal && inlet.goal.per === 'month' ? inlet.goal.cents : null));
  }
  rows.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (year.unfiled.rows.length) rows.push({ ...rowOf('unfiled', '', year.unfiled, null), unfiled: true });
  return { months: frame.months, first: frame.firstOnRecord, firstDay: isYmd(floor) ? floor : null, today: ledger.today, rows };
}

/* ------------------------------------------------------------------ the queue: deposits */

/** The first day money in is queued from: 12 months back, never before the shared floor. */
export function queueFrom(today, floor) {
  const back = addDays(today, -(IN_DAYS - 1));
  return isYmd(floor) && floor > back ? floor : back;
}

/** The sources a chip may offer: live, not archived, by money filed to them in the year (most first), then name. */
function chipSources(look, year) {
  return [...look.inlets.values()].filter((inlet) => !inlet.removed && !inlet.gone)
    .map((inlet) => ({ inlet, cents: (year.sources.get(inlet.id) || { cents: 0 }).cents }))
    .sort((a, b) => b.cents - a.cents || (a.inlet.name < b.inlet.name ? -1 : a.inlet.name > b.inlet.name ? 1 : 0) || (a.inlet.id < b.inlet.id ? -1 : 1))
    .map((one) => one.inlet);
}

/** The queue's deposits (posted bank rows that count as money in, since queueFrom) and their attribution. */
function queueYear(ledger, look, state) {
  const to = ledger.today;
  const from = queueFrom(to, floorOf(state));
  const rows = ledger.moneyIn(from, to).rows.filter(({ tx, how }) => how === 'bank' && !tx.pending && tx.source !== 'manual');
  return { from, to, rows, year: attribute(look, rows) };
}

/**
 * The sources a chip may offer, in the queue's order (by the money filed to them in its year, then name): a deposit's
 * sheet offers them in this order too (round 6), so the two lists a tap apart agree.
 * @returns {object[]}  the sources (inletsOf's entries)
 */
export function chipOrder(state, nowMs, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const look = opts && opts.look ? opts.look : lookOf(state);
  return chipSources(look, queueYear(ledger, look, state).year);
}

/**
 * The deposits to file (section 6, G.3): posted bank deposits that count as money in, on or after the later of 12 months
 * ago and the shared floor, that nothing files (no source, no Windfalls, not left). One item per payer (Zelle files the
 * sender), per reporting app (a deposit paired with its payments: one tap files the app), and a catch-all deposit on its
 * own. A payment only another app reported is queued once the bank shows it (until then it counts in pencil).
 * The first chip is a guess only when the last 2 deposits from the key went to one source.
 * @returns {{ items: object[], from: string, to: string }}
 *   an item: { key, kind: 'payer'|'app'|'one', intoKey, facts, merchant, txId, count, amount, last, guess, sources, zelle,
 *   paired?, newKind } — `paired` (round 9, F2): a sender's only deposit paired with your other app's payments, set
 *   aside, as { what, payer, day } for the item's note (Leave it writes one `?` on `intoKey`, round 9); `newKind`: the
 *   kind a new source named from the item opens on (round 4): Steady pay for a payer that is pay (a pay stream's payer whose
 *   deposits pair with no reporting app's payments, as the 's' suggestion reads it), so naming one never ends the
 *   owner's own pay; Back-end for a payer the royalties rule files; else By the job
 */
export function depositQueue(state, nowMs, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const look = opts && opts.look ? opts.look : lookOf(state);
  const { from, to, rows, year } = queueYear(ledger, look, state);
  const payPayers = new Set(ledger.payStreams().map((stream) => merchantKeyOf(stream.mkey)).filter(Boolean));
  const payMain = ledger.payMain();
  // the latest filed deposits from each payer and each app, for the guess (the same on every device: day, then row key)
  const history = new Map();
  const note = (key, tx, id) => { if (!history.has(key)) history.set(key, []); history.get(key).push({ day: tx.day, at: rowKey(look, tx), id }); };
  // a deposit paired with a reporting app's payments is one of its app's latest and of its payer's (round 3): a payer's
  // deposit that waits for its payment's mark is queued under the payer, and its deposits filed through the app guess
  const groupKeys = (tx, keys) => {
    const out = [];
    if (keys.apps.length) out.push('app:' + keys.apps[0]);
    if (keys.payer) out.push('payer:' + keys.payer);
    return out;
  };
  const byKey = new Map();
  for (const [id, one] of year.sources) {
    for (const row of one.rows) for (const key of groupKeys(row.tx, row.filing.keys)) note(key, row.tx, id);
  }
  // a deposit filed to Windfalls is one of the key's latest too (it is no source, so no guess follows it)
  for (const row of year.windfalls.rows) for (const key of groupKeys(row.tx, row.filing.keys)) note(key, row.tx, WINDFALL);
  // a deposit left with Leave it is one of them as well (round 2): it went to no source, so it ends a guess
  for (const row of year.unfiled.rows) if (row.filing.left) for (const key of groupKeys(row.tx, row.filing.keys)) note(key, row.tx, LEAVE);
  for (const row of year.unfiled.rows) {
    const { tx, filing } = row;
    if (filing.left) continue;
    const keys = filing.keys;
    let item;
    if (keys.apps.length) {
      const key = 'app:' + keys.apps[0];
      item = byKey.get(key) || { key, kind: 'app', intoKey: keys.apps[0], facts: null, history: key, merchant: appName(state, (look.paired.get(tx.id) || [])[0]) };
    } else if (isCatchAllIn(tx) || !keys.payer) {
      const where = keys.where;
      if (!where) continue;
      const key = 'one:' + where.key;
      item = { key, kind: 'one', intoKey: where.key, facts: { day: tx.day, ...(where.key[0] === 'i' && where.fp ? { fp: where.fp } : {}) }, history: keys.payer ? 'payer:' + keys.payer : null,
        stream: tx.streamId, payer: keys.payer };
      if (where.key[0] === 'i' && !where.fp) continue;
    } else {
      const key = 'payer:' + keys.payer;
      item = byKey.get(key) || { key, kind: 'payer', intoKey: keys.payer, facts: null, history: key, zelle: tx.ruleId === ZELLE_IN };
    }
    if (!byKey.has(item.key)) {
      Object.assign(item, { merchant: item.merchant || '', txId: tx.id, count: 0, amount: 0, last: '', lastAt: '' });
      // a payer or an app left on an earlier day, whose later deposits are asked about (round 11): an Undo of a tap on
      // the item cannot put that day back, so it asks again about every deposit of the item (restampFlows, round 12),
      // which the view's Undo label says
      if (item.kind !== 'one' && leftEarlier(look, item.intoKey, ledger.today)) item.leftBefore = true;
      byKey.set(item.key, item);
    }
    item.count += 1;
    item.amount += Math.round(tx.amount);
    if (tx.ruleId === ROYALTIES) item.royalty = true;
    // a sender's only deposit paired with your other app's payments, set aside (round 9, F2): the queue names the pairing
    if (item.kind === 'payer' && look.aside.has(tx.id) && !item.paired) item.paired = { ...asideOf(state, look.aside.get(tx.id)[0]), deposit: tx.day };
    const at = rowKey(look, tx);
    if (tx.day > item.last || (tx.day === item.last && at > item.lastAt)) {
      item.last = tx.day;
      item.lastAt = at;
      item.txId = tx.id;
      if (item.kind !== 'app') item.merchant = typeof tx.merchant === 'string' && tx.merchant ? tx.merchant : tx.mkey || '';
    }
  }
  const sources = chipSources(look, year);
  // a payer whose deposits pair with a reporting app's payments is that app's (as the 's' suggestion reads it, round 3)
  const appPayers = new Set();
  for (const one of [...year.sources.values(), year.windfalls, year.unfiled]) {
    for (const row of one.rows) if (row.filing.keys.apps.length && row.filing.keys.payer) appPayers.add(row.filing.keys.payer);
  }
  const items = [...byKey.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || (a.key < b.key ? -1 : 1));
  for (const item of items) {
    item.guess = guessOf(history.get(item.history) || [], look);
    item.sources = item.guess ? [item.guess, ...sources.map((inlet) => inlet.id).filter((id) => id !== item.guess)] : sources.map((inlet) => inlet.id);
    // the kind a new source named from the item opens on (round 4): a payer item's payer that is pay is Steady pay (a
    // By the job source would end its pay, G.7.2), unless its deposits pair with a reporting app's payments (a client of
    // the app, never suggested as Steady pay); a royalty payer Back-end (as its 'p' suggestion); an app or one deposit By
    // the job (an app as its 'r' suggestion; one deposit filed on its own never changes pay). A Zelle sender is a client
    // (G.7.2: "a regular client paying $100 or more read as salary" is the wrong read), By the job (round 5)
    // Round 11: one deposit whose stream is the pay that sets your payday (a payroll paid by cheque) opens on Steady pay,
    // since filed away a second time it ends that pay (PAYDAYS (b)3); a cash-out or payout beside a payroll stays By the job
    item.newKind = item.kind === 'one' ? (item.stream != null && item.stream === payMain && !appPayers.has(item.payer) ? 'steady' : 'job')
      : item.kind !== 'payer' ? 'job' : item.royalty ? 'backend'
      : !item.zelle && payPayers.has(item.intoKey) && !appPayers.has(item.intoKey) ? 'steady' : 'job';
    delete item.stream;
    delete item.payer;
    delete item.royalty;
    delete item.lastAt;
    delete item.history;
  }
  return { items, from, to };
}

/**
 * The pay a decision ended (the pay fix, G.7.2; round 4): the streams of `before` (ledger.payStreams() read before the
 * decision, at the same clock) that are no pay stream once it is made, and that accrued or set the payday (`main`: the
 * before ledger's payMain()). The toast says so, so the owner can Undo it. A stream that did neither (a payer of the
 * reporting app, whose deposits its payments claim, beside an accruing payroll) only stops being read as pay: no live
 * number or payday moves, so the toast says nothing of it (round 5).
 * @param {object[]} before
 * @param {string|null} [main]
 * @returns {object[]}
 */
export function payEndedStreams(before, state, nowMs, main = null) {
  const list = Array.isArray(before) ? before : [];
  if (!list.length) return [];
  const now = new Set(makeLedger(state, nowMs).payStreams().map((stream) => stream.id));
  return list.filter((stream) => stream && !now.has(stream.id) && (!!stream.accrue || (main != null && stream.id === main)));
}

/** The names of payEndedStreams, each once. @returns {string[]} */
export function payEnded(before, state, nowMs, main = null) {
  const names = [];
  for (const stream of payEndedStreams(before, state, nowMs, main)) {
    const name = typeof stream.name === 'string' ? stream.name.trim() : '';
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The label of a reporting app's payments (its file's `what`), for the payment key `{source}/{item}`. */
function appName(state, paymentKeyText) {
  const source = sourceOfKey(paymentKeyText);
  const sources = state && state.income && state.income.sources && typeof state.income.sources === 'object' ? state.income.sources : {};
  const src = Object.hasOwn(sources, source) ? sources[source] : null;
  return src && typeof src.what === 'string' && src.what ? src.what : source;
}

/**
 * A pairing G.3 set aside (round 9, F2; flowsection's lookOf): the app's label (its file's `what`), the name of the payer
 * whose payment 3.7 paired with the deposit ('' when the file names none), and the day of that payment.
 * @returns {{ what: string, payer: string, day: string|null }}
 */
function asideOf(state, paymentKeyText) {
  const text = String(paymentKeyText || '');
  const source = sourceOfKey(text);
  const sources = state && state.income && state.income.sources && typeof state.income.sources === 'object' ? state.income.sources : {};
  const src = Object.hasOwn(sources, source) ? sources[source] : null;
  const items = src && Array.isArray(src.items) ? src.items : [];
  const one = items.find((x) => x && x.id === text.slice(source.length + 1)) || null;
  const payer = one && src && Array.isArray(src.payers) ? src.payers.find((x) => x && x.id === one.payer) : null;
  return { what: appName(state, text), payer: payer && typeof payer.name === 'string' ? payer.name : '', day: one && isYmd(one.day) ? one.day : null };
}

/**
 * The label of the reporting app a deposit's "All from this app" files (round 3): a reported payment's app, or the app of
 * the payments paired with a bank deposit; '' when none.
 */
export function appNameOf(state, tx) {
  if (!tx) return '';
  if (tx.source === 'manual') return tx.via === 'income' && tx.income && typeof tx.income.key === 'string' ? appName(state, tx.income.key) : '';
  // the pairings that file it (a pairing set aside, round 9's F2, files nothing: lookOf)
  const key = (lookOf(state).paired.get(tx.id) || [])[0];
  return key ? appName(state, key) : '';
}

/** A deposit's place on every device: its row key (the bank's ids), never the local id. */
function rowKey(look, tx) {
  const where = rowWhere(tx, look.accounts);
  return where ? where.key : '';
}

/** The guess: the source the last 2 filed deposits from a key both went to, or null (G.3's one rule). */
function guessOf(list, look) {
  if (list.length < GUESS_DEPOSITS) return null;
  const last = list.slice().sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, GUESS_DEPOSITS);
  const id = last[0].id;
  if (!last.every((one) => one.id === id)) return null;
  const inlet = look.inlets.get(id);
  return inlet && !inlet.removed && !inlet.gone ? id : null;
}

/* ------------------------------------------------------------------ suggestions */

/**
 * Suggested sources (the owner's change to decision 7): from what the app already sees, each added with one tap.
 * - 's' + hash13 of a pay stream's key: a pay stream detection found, as Steady pay (it files the stream's payer);
 * - 'r' + hash13 of a reporting app's id: an app with reported payments, as By the job (it files the app);
 * - 'p' + the payer key: a payer whose deposits the built-in royalties rule files, as Back-end (it files the payer).
 * One shows per key it files, while that key is filed to no source (nor to Windfalls) and none of its offer keys holds a
 * live dismissal; a dismissed one is listed apart, for Restore. Its name is the app's own for the stream, the reporting
 * app or the payer, at most 40.
 * @returns {{ shown: object[], dismissed: object[] }}  each { key, keys, intoKey, name, kind, why, cents, est, cash } (`keys`:
 *   every offer key that files it, `key` the first; `why`: the kind, or 'client' for a Zelle sender's pay stream, suggested
 *   as By the job (round 5); cents: the 12 months on record)
 */
export function suggestions(state, nowMs, opts) {
  const ledger = ledgerOf(state, nowMs, opts);
  const look = opts && opts.look ? opts.look : lookOf(state);
  const offers = look.copy.offers || {};
  const found = new Map();
  // one suggestion per key it files (round 3): `keys` holds every offer key that files it (a payroll paid into two
  // accounts is two pay streams, two 's' keys, one payer), so Not now and Restore take them all
  const byInto = new Map();
  const put = (key, intoKey, name, kind, why = kind) => {
    if (!key || found.has(key)) return;
    const same = intoKey ? byInto.get(intoKey) : null;
    if (same) { if (!same.keys.includes(key)) same.keys.push(key); return; }
    const one = { key, keys: [key], intoKey, name: inletName(name) || inletName(kind), kind, why, cents: 0, est: false, cash: 0 };
    found.set(key, one);
    if (intoKey) byInto.set(intoKey, one);
  };
  const frame = monthsFrame(ledger.today, floorOf(state));
  const rows = ledger.moneyIn(frame.from, frame.to).rows;
  // a payer whose deposits the built-in royalties rule files is suggested as Back-end only, never also as Steady pay
  // (round 3: a monthly payout has a cadence)
  const royalties = new Set();
  for (const { tx } of rows) if (tx.ruleId === ROYALTIES && tx.source !== 'manual' && merchantKeyOf(tx.mkey)) royalties.add(merchantKeyOf(tx.mkey));
  // a pay stream is suggested only while nothing files its deposits (rounds 2 and 3), judged over all its posted deposits
  // since money in starts (queueFrom), not its latest one alone: none on a catch-all key (a cheque, a cash-out, a payout
  // or a payment app files one deposit at a time, G.3: Add would file every later deposit on the key, from anyone), none
  // filed by any key (its own, its app, its payer, or a built-in rule's Windfalls: money the rules call not earned is no
  // Steady pay), and none paired with a payment another app reported (the app's own suggestion and the queue file it
  // through the app; a deposit that waits for its payment's mark is the same payer's). A deposit filed on its own (its
  // own row key, no payment of another app paired with it) stops the suggestion only when it is the stream's latest
  // deposit, as round 2 read it (round 4): one older paycheck filed on its own, such as a correction worded as the
  // payroll and filed to Windfalls, leaves the payroll suggested, since its payer is filed nowhere
  const from = queueFrom(ledger.today, floorOf(state));
  const blocked = new Set();
  const latest = new Map();
  for (const tx of Array.isArray(state.txs) ? state.txs : []) {
    if (!tx || tx.flow !== 'in' || tx.streamId == null || tx.pending || tx.source === 'manual') continue;
    if (typeof tx.day !== 'string' || tx.day < from) continue;
    let own = false;
    if (!blocked.has(tx.streamId)) {
      if (isCatchAllIn(tx)) blocked.add(tx.streamId);
      else {
        const filing = filingOf(look, tx);
        if (filing.keys.apps.length || (filing.to && filing.how !== 'deposit')) blocked.add(tx.streamId);
        else own = !!filing.to;
      }
    }
    // the stream's latest deposit, the same on every device: its day, then its row key
    const at = rowKey(look, tx);
    const was = latest.get(tx.streamId);
    if (!was || tx.day > was.day || (tx.day === was.day && at > was.at)) latest.set(tx.streamId, { day: tx.day, at, own, zelle: tx.ruleId === ZELLE_IN });
  }
  for (const [id, last] of latest) if (last.own) blocked.add(id);
  for (const stream of ledger.payStreams()) {
    if (blocked.has(stream.id)) continue;
    const payer = merchantKeyOf(stream.mkey);
    if (payer && royalties.has(payer)) continue;
    // a pay stream of a Zelle sender is a client read as pay (G.7.2): suggested as By the job, which ends that read (round 5)
    const last = latest.get(stream.id);
    if (last && last.zelle) put(streamOfferKey(stream, look.accounts), payer, stream.name, 'job', 'client');
    else put(streamOfferKey(stream, look.accounts), payer, stream.name, 'steady');
  }
  const income = state.income && typeof state.income === 'object' && state.income.sources && typeof state.income.sources === 'object' ? state.income.sources : {};
  for (const source of Object.keys(income).sort()) {
    const src = income[source];
    if (!src || !Array.isArray(src.items) || !src.items.length) continue;
    const key = appKey(source);
    put(key, key, typeof src.what === 'string' ? src.what : source, 'job');
  }
  for (const { tx } of rows) {
    if (tx.ruleId !== ROYALTIES || tx.source === 'manual') continue;
    const key = merchantKeyOf(tx.mkey);
    put(key, key, tx.merchant || tx.mkey, 'backend');
  }
  // money the 12 months hold for each, to order them and to show (pencil money with ≈, cash named, as a source's row)
  for (const { tx, how } of rows) {
    const keys = keysOf(look, tx);
    for (const one of found.values()) {
      if (one.intoKey !== keys.payer && !keys.apps.includes(one.intoKey)) continue;
      one.cents += Math.round(tx.amount);
      if (how === 'pencil' || (how === 'bank' && tx.pending)) one.est = true;
      if (how === 'cash') one.cash += Math.round(tx.amount);
    }
  }
  const shown = [];
  const dismissed = [];
  for (const one of found.values()) {
    if (!one.intoKey || isReal(look, look.into[one.intoKey])) continue;
    // its state is the latest-stamped cell among its keys, a dismissal or a removal (round 4), so a device that holds one
    // account's stream, and writes that key alone, decides as well as one that holds both: its Not now reads as dismissed
    // everywhere, and its Restore, stamped after every dismissal, shows it again everywhere. On a tie, the dismissal
    let last = null;
    for (const key of one.keys) {
      const offer = offers[key];
      if (offer && (!last || offer.at > last.at || (offer.at === last.at && !offer.deleted))) last = offer;
    }
    (last && !last.deleted ? dismissed : shown).push(one);
  }
  const order = (a, b) => b.cents - a.cents || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.key < b.key ? -1 : 1);
  return { shown: shown.sort(order), dismissed: dismissed.sort(order) };
}

/* ------------------------------------------------------------------ the owner's actions */

/** Whether one more source may be made (the UI refuses a 21st live source). */
export function canMakeInlet(state) {
  return inletCount(state) < INLETS_LIVE_MAX;
}

/**
 * Make a source: a name (1 to 40 characters) and a kind, under a new random id. Null when the name is empty, the kind is
 * not one of the four, or 20 sources are live.
 * @param {object} state  (mutated)
 * @returns {string|null} its id
 */
export function makeInlet(state, fields, nowMs, id = newInletId()) {
  const name = inletName(fields && fields.name);
  const kind = fields && INLET_KINDS.includes(fields.kind) ? fields.kind : null;
  if (!name || !kind || !canMakeInlet(state)) return null;
  return noteInlet(state, id, { name, kind }, nowMs) ? id : null;
}

/**
 * Edit a source: any of name, kind, goal ({ per, cents } or null), focus, gone (archive, Restore), removed. Each edit is
 * one cell, stamped; a cleared goal or tag is a removal.
 * @returns {boolean}
 */
export function editInlet(state, id, fields, nowMs) {
  const out = {};
  if (Object.hasOwn(fields, 'name')) { const name = inletName(fields.name); if (!name) return false; out.name = name; }
  if (Object.hasOwn(fields, 'kind')) { if (!INLET_KINDS.includes(fields.kind)) return false; out.kind = fields.kind; }
  if (Object.hasOwn(fields, 'goal')) out.goal = fields.goal && Number.isInteger(fields.goal.cents) && fields.goal.cents >= 1 ? { per: fields.goal.per === 'year' ? 'year' : 'month', cents: fields.goal.cents } : null;
  if (Object.hasOwn(fields, 'focus')) out.focus = fields.focus ? true : null;
  if (Object.hasOwn(fields, 'gone')) out.gone = fields.gone ? true : null;
  if (Object.hasOwn(fields, 'removed')) out.removed = fields.removed ? true : null;
  if (!Object.keys(out).length) return false;
  if (!noteInlet(state, id, out, nowMs)) return false;
  // the tag marks the one source the owner means to grow (the glossary, G.5): set on one, it leaves any other in the same
  // update (round 2)
  if (out.focus === true) {
    for (const other of inletsOf(state).values()) if (other.id !== id && other.focus && !other.removed) noteInlet(state, other.id, { focus: null }, nowMs);
  }
  // a kind or a removal changes which payers are pay (the pay fix, flowsection.notPayKeys): the record is read again in
  // the same update, as a filing does, so this device agrees with the others at once
  if (Object.hasOwn(out, 'kind') || Object.hasOwn(out, 'removed')) refresh(state, nowMs);
  return true;
}

/** How many filings send money to a source (the confirm before Remove counts them). */
export function filingsTo(state, id) {
  const copy = storedFlows(state);
  return Object.values(copy.into || {}).filter((cell) => !cell.deleted && cell.v === id).length;
}

/**
 * One tap on a queue item: the payer, the reporting app, or the one deposit, to a source, to Windfalls or Leave it
 * ('?'); the record is read again (the pay fix follows a payer's filing). Call it inside one undoable store.update.
 * @returns {boolean}
 */
export function fileQueueItem(state, item, to, nowMs) {
  if (!item || !item.intoKey) return false;
  // Leave it (round 9, LIMITS-TRIAGE F1): one `?` on the item's key, as a filing is. On a payer or an app it leaves the
  // key's deposits up to the game day of its stamp (G.3's reader), so a later deposit is asked about; it ranks below every
  // real filing, so filing the payer or the app later still reaches them. Round 2 wrote one per deposit, which passed the
  // 120 filings of one deposit that travel in a single tap on a large item.
  // A Leave it on an item whose key already holds one (the deposits asked about since) stamps that one mark again
  // (round 11): it travels whatever else the file holds. Round 10 wrote a `?` on each of those deposits' own keys, which
  // share the 120 filings of one deposit and are evicted first, so past that they stopped travelling (round 9's sync M1).
  // Its Undo cannot put the older day back (a stamp only grows), so it takes the mark away (restampFlows): every deposit
  // of the item is asked about again, on every device, and the view's Undo label says so (`leftBefore`)
  if (!noteInto(state, item.intoKey, to, nowMs, item.facts || {})) return false;
  refresh(state, nowMs);
  return true;
}

/**
 * Whether a payer's or an app's key holds Leave it from a game day before `today` (lookOf's `leaveTo`): an Undo of a tap on
 * that key, or of any tap once it holds a removal, cannot put that day back, so it asks about every deposit from them again
 * (flowsection.restampFlows, round 12), as the tap's Undo label says.
 */
export function leftEarlier(look, key, today) {
  const day = key && look && look.leaveTo ? look.leaveTo.get(key) : null;
  return isYmd(day) && isYmd(today) && day < today;
}

/**
 * A new source named from the queue (a name and a kind), made and filed within the same Undo.
 * @returns {string|null} the new source's id
 */
export function fileToNew(state, item, fields, nowMs, id = newInletId()) {
  const made = makeInlet(state, fields, nowMs, id);
  if (!made) return null;
  return fileQueueItem(state, item, made, nowMs) ? made : null;
}

/**
 * The key the deposit's sheet writes for one deposit or reported payment ('one': its own key) or for every one from its
 * payer or reporting app ('all'), with the facts the key needs; null when there is none (a pending row is never filed on
 * its own, nor a bank row with no fingerprint).
 */
function depositKey(look, tx, scope, unfile = false) {
  const keys = keysOf(look, tx);
  if (scope === 'all') {
    const key = keys.apps[0] || keys.payer;
    return key ? { key, facts: {} } : null;
  }
  if (tx.source === 'manual') return keys.own[0] ? { key: keys.own[0], facts: { day: tx.day } } : null;
  if (tx.pending || !keys.where) return null;
  // Not yet filed removes the filing that decides the row on its own keys (round 4): when that is the `q` key of a payment
  // your other app reported, filed on its own sheet before its deposit reached the bank and paired with it (the matched
  // payment has no sheet of its own), it is that cell; a filing to a source still goes to the deposit's own key (G.3: an
  // `i` and a `q` filing on one deposit, the later stamp deciding)
  if (unfile) {
    const deciding = latestReal(look, keys.own);
    if (deciding && deciding.key[0] === 'q') return { key: deciding.key, facts: {} };
  }
  // the filing that already reaches this row by its fingerprint keeps its key, so an Undo puts that cell back
  const reaching = keys.own.find((k) => (k[0] === 'i' || k[0] === 'f') && look.into[k] && !look.into[k].deleted);
  const key = reaching || keys.where.key;
  const facts = { day: tx.day, ...(key[0] === 'i' ? { fp: (look.into[key] && look.into[key].fp) || keys.where.fp } : {}) };
  return key[0] === 'i' && !facts.fp ? null : { key, facts };
}

/**
 * Whether Not yet filed on the deposit's sheet takes effect (G.3): the key it removes holds a filing (or Leave it), and
 * without it the deposit reads elsewhere. It does not on a deposit its payer, its app or a built-in rule files under
 * "This deposit only", nor on one its own key files under "All from this payer".
 */
export function canUnfile(state, txId, scope) {
  const tx = Array.isArray(state.txs) ? state.txs.find((one) => one && one.id === txId) : null;
  if (!tx) return false;
  const look = lookOf(state);
  const at = depositKey(look, tx, scope, true);
  if (!at || !(look.into[at.key] && !look.into[at.key].deleted)) return false;
  const was = filingOf(look, tx);
  const into = { ...look.into };
  delete into[at.key];
  const then = filingOf({ ...look, into }, tx);
  return then.to !== was.to || then.left !== was.left;
}

/**
 * The deposit's sheet: file one deposit or reported payment ('one': its own key) or every one from its payer or
 * reporting app ('all'), to a source, Windfalls, or no decision (null). A pending row is never filed on its own. Not yet
 * filed is written only where it takes effect (canUnfile).
 * @returns {boolean}
 */
export function fileDeposit(state, txId, to, scope, nowMs) {
  const tx = Array.isArray(state.txs) ? state.txs.find((one) => one && one.id === txId) : null;
  if (!tx) return false;
  const look = lookOf(state);
  const unfile = to === null || to === undefined;
  const at = depositKey(look, tx, scope === 'all' ? 'all' : 'one', unfile);
  if (!at) return false;
  if (unfile && !canUnfile(state, txId, scope === 'all' ? 'all' : 'one')) return false;
  if (!noteInto(state, at.key, to, nowMs, at.facts)) return false;
  refresh(state, nowMs);
  return true;
}

/**
 * Add a suggested source: a new source with the app's name for the stream, app or payer and the suggested kind, and its
 * key filed to it, in one update (one Undo).
 * @returns {string|null}
 */
export function acceptOffer(state, offer, nowMs, id = newInletId()) {
  if (!offer || !offer.intoKey) return null;
  const made = makeInlet(state, { name: offer.name, kind: offer.kind }, nowMs, id);
  if (!made) return null;
  if (!noteInto(state, offer.intoKey, made, nowMs, {})) return null;
  refresh(state, nowMs);
  return made;
}

/**
 * Not now: the suggestion is dismissed, on every device; a suggestion's `keys` (one payer's streams) all at once, at one
 * stamp (round 5: the highest any of them needs), which a Restore made where fewer of them are read finds them by.
 */
export function dismissOffer(state, key, nowMs) {
  const keys = Array.isArray(key) ? key : [key];
  if (!keys.length) return false;
  const at = offerStamp(state, keys, nowMs);
  for (const one of keys) if (!noteOffer(state, one, false, nowMs, at)) return false;
  return true;
}

/**
 * Restore a dismissed suggestion (a removal of the dismissal); of a suggestion's `keys`, each that holds a dismissal (no
 * removal is written for a key never dismissed). Round 5: also each offer key of the copy that this record makes no
 * suggestion of (another device's record reads more of the payer's streams), whose live dismissal carries the stamp of
 * one this Restore removes: the same Not now wrote it. Otherwise that dismissal would decide again once this removal
 * stops travelling (400 days), on a device that joins after that.
 * @param {string|string[]} key
 * @param {Iterable<string>} [known]  the offer keys of every suggestion this device makes (suggestions().shown and
 *   .dismissed); read here when not given
 */
export function restoreOffer(state, key, nowMs, known) {
  const keys = Array.isArray(key) ? key : [key];
  const offers = storedFlows(state).offers || {};
  const held = keys.length > 1 ? keys.filter((one) => offers[one] && !offers[one].deleted) : keys;
  if (!held.length) return false;
  const stamps = new Set(held.map((one) => offers[one]).filter((cell) => cell && !cell.deleted && cell.v === false).map((cell) => cell.at));
  let more = [];
  if (stamps.size) {
    const mine = new Set(known || (() => { const all = suggestions(state, nowMs); return [...all.shown, ...all.dismissed].flatMap((one) => one.keys); })());
    more = Object.keys(offers).sort().filter((one) => !keys.includes(one) && !mine.has(one) && !offers[one].deleted && offers[one].v === false && stamps.has(offers[one].at));
  }
  for (const one of [...held, ...more]) if (!noteOffer(state, one, null, nowMs)) return false;
  return true;
}

/**
 * "It was money in" (G.7.3): a refund at a payment-app key read as money in, this move only, as a correction that
 * travels (category income, which classify reads as income on money in). It then joins the money-in queue.
 * @returns {boolean}
 */
export function moneyInMove(state, txId, nowMs) {
  const tx = Array.isArray(state.txs) ? state.txs.find((one) => one && one.id === txId) : null;
  // a deposit on a card or a loan is never money in (G.1, G.2)
  if (!tx || tx.flow !== 'in' || tx.kind !== 'refund' || !onCashAccount(state, tx)) return false;
  learnRule(state, tx.id, { category: 'income' }, { onlyThis: true });
  noteMove(state, tx.id, nowMs);
  refresh(state, nowMs);
  const after = state.txs.find((one) => one && one.id === txId);
  return !!after && after.kind === 'income';
}

/** Whether a move is on a cash account (checking, savings, cash): not a card, a loan or an asset. */
function onCashAccount(state, tx) {
  const account = state && Array.isArray(state.accounts) ? state.accounts.find((one) => one && one.id === tx.accountId) : null;
  return !!account && Object.hasOwn(ACCOUNT_TYPES, account.type) && ACCOUNT_TYPES[account.type].group === 'cash';
}

/** Whether a move is a wallet refund that "It was money in" applies to: on a cash account, never a card's credit. */
export function isWalletRefund(tx, state) {
  return !!tx && tx.kind === 'refund' && tx.flow === 'in' && tx.ruleId === 'builtin:wallet-payment' && onCashAccount(state, tx);
}
