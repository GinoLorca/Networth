/**
 * What travels between the owner's devices: the payments they send themselves, their ticks, and the
 * fingerprints that let every device recognise a payment the same way; the answers about the
 * income another app of theirs reports (`income`, ARCHITECTURE 3.7); and the owner's corrections
 * (`corrections`, 3.8: merchant rules, a row's locked fields, a stream's locked settings); the owner's
 * choices that reach every device (`prefs`, 11: the words of the interface); the daily game (`game`, 3.9: its
 * settings, each day's type, exempt day, note and plan, the baseline's segments and the owner's weekly transfers); and the
 * owner's decisions on money in and out (`flows`, 3.11: subscriptions, verdicts, lines added by hand, targets, the shared
 * floor, and the sources and filings of a later pass). See ARCHITECTURE.md section 3.5.
 *
 * Pure: no clock, no DOM, no network. A round (`roundShared`) is handed the device and the transport.
 * The shared file is untrusted input: `readSharedFile` checks every field `makeByHand` will be given.
 */

import { makeByHand } from './byhand.js';
import { isYmd } from './dates.js';
import { refresh } from './detect.js';
import { ensureIncome, exportIncomeShared, incomeOf, isBlankIncome, mergeIncomeShared, readIncomeShared, rebuildIncome } from './income.js';
import {
  applyCorrections, arrivedCorrections, exportCorrections, isBlankCorrections, mergeCorrections, pruneCorrections, readSharedCorrections,
  sharedSections, storeCorrections, storedCorrections,
} from './corrections.js';
import { applyPrefs, exportPrefs, isBlankPrefs, mergePrefs, noteSeenPrefs, prefsDiffer, prefsUnseen, readPrefs } from './prefs.js';
import { applyGame, arrivedGame, exportGame, gameDiffers, hearServer, hearsServer, isBlankGame, mergeGame, readGame } from './game.js';
import { arrivedFlows, boundFlows, exportFlows, flowsDiffer, heldRemovals, isBlankFlows, mergeFlows, readFlows, readFlowsWhole, takeCells, takeFlows } from './flowsection.js';

const VERSION = 1;
const APP = 'networth';
/** At most this many payments in a file, and apart from them at most this many removals. */
const MAX_ENTRIES = 200;
const MAX_TOMBS = 1000;
const NAME_MAX = 60;
const AMOUNT_MAX = 1e10;
const LAST_DAY = 31;
const MAX_FLAGS = 400;
const MAX_TEXT = 2000000;
const MAX_STAMP = 1e14;
const MAX_DEPTH = 12;
/** A removal older than this is no longer written: not by the device that made it, and not by a round. */
const TOMB_KEEP_MS = 400 * 86400000;
/** How many times a round starts again when another device wrote the file meanwhile. */
const RESTARTS = 3;
const KNOWN = new Set(['v', 'app', 'savedAt', 'byHand', 'income', 'corrections', 'flowRules', 'prefs', 'game', 'flows']);
/** Removals of payments by hand a written file keeps at most, the newest first (the reader still takes 1,000). */
export const TOMBS_WRITTEN = 250;
/** A round's own export: the decisions on money in and out whole, for the merge (exportShared). */
const WHOLE = Object.freeze({ whole: true });
/** Over this many characters a round prunes the file it is about to write (the reader takes 2,000,000). */
export const GUARD_TEXT = 1990000;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const PAYEE = /^p[0-9a-f]{13}$/;
const SKIP_KEY = /^(\d{4}-\d{2}-\d{2})\|p[0-9a-f]{13}$/;

/* ------------------------------------------------------------------ reading */

/**
 * Parse and check a shared file. Anything that is not a version-1 Networth file of sane size is null.
 * The result is a fresh copy holding only checked values; other top-level sections are kept as plain data.
 * @param {string} text
 * @returns {object|null}
 */
export function readSharedFile(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
  let raw = null;
  try { raw = JSON.parse(text); } catch { return null; }
  return fileOf(raw);
}

/**
 * A file, checked. `whole`: a file this module made (a merge, whose `flows` keeps every cell until its bounds are drawn
 * before writing), so the flows section is checked cell by cell with no limit of length; a file read from the transport
 * is always checked with the reader's limits (readSharedFile).
 */
function fileOf(raw, whole = false) {
  if (!isObject(raw) || raw.v !== VERSION || raw.app !== APP) return null;
  const savedAt = raw.savedAt === undefined ? 0 : raw.savedAt;
  const list = raw.byHand === undefined ? {} : raw.byHand;
  if (!isStamp(savedAt) || !isObject(list)) return null;
  const ids = Object.keys(list);
  if (ids.length > MAX_ENTRIES + MAX_TOMBS) return null;
  const byHand = {};
  let payments = 0;
  let tombs = 0;
  for (const id of ids) {
    const entry = isId(id) ? entryOf(list[id]) : null;
    if (!entry) return null;
    if (entry.deleted) tombs += 1; else payments += 1;
    if (payments > MAX_ENTRIES || tombs > MAX_TOMBS) return null;
    byHand[id] = entry;
  }
  const out = { v: VERSION, app: APP, savedAt, byHand };
  if (raw.income !== undefined) {
    // the answers about reported income (3.7): checked like the rest; an empty section is left out
    const income = readIncomeShared(raw.income);
    if (!income) return null;
    if (!isBlankIncome(income)) out.income = income;
  }
  if (raw.corrections !== undefined || raw.flowRules !== undefined) {
    // the owner's corrections (3.8), and the rules of one direction in a section of their own, which an older version
    // keeps whole and never applies (3.3): checked like the rest, read as one section; an empty section is left out
    const corrections = readSharedCorrections(raw.corrections, raw.flowRules);
    if (!corrections) return null;
    if (!isBlankCorrections(corrections)) out.corrections = corrections;
  }
  if (raw.prefs !== undefined) {
    // the owner's choices that reach every device (11): checked like the rest; an empty section is left out
    const prefs = readPrefs(raw.prefs);
    if (!prefs) return null;
    if (!isBlankPrefs(prefs)) out.prefs = prefs;
  }
  if (raw.game !== undefined) {
    // the daily game (3.9): checked like the rest; an empty section is left out
    const game = readGame(raw.game);
    if (!game) return null;
    if (!isBlankGame(game)) out.game = game;
  }
  if (raw.flows !== undefined) {
    // the owner's decisions on money in and out (3.11): checked like the rest; an empty section is left out
    const flows = whole ? readFlowsWhole(raw.flows) : readFlows(raw.flows);
    if (!flows) return null;
    if (!isBlankFlows(flows)) out.flows = flows;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key) && !UNSAFE.has(key)) out[key] = plain(raw[key], 0);
  }
  return out;
}

/** One entry of the file, checked: a payment, or a removal (which keeps only what still has to travel). */
function entryOf(raw) {
  if (!isObject(raw) || !isStamp(raw.editedAt)) return null;
  const payee = raw.payee == null ? null : raw.payee;
  const payeeAt = raw.payeeAt === undefined ? 0 : raw.payeeAt;
  if (payee !== null && !(typeof payee === 'string' && PAYEE.test(payee))) return null;
  if (!isStamp(payeeAt)) return null;
  const marks = flagsOf(raw.marks, isYmd, 'paid');
  const skips = flagsOf(raw.skips, isSkipKey, 'on');
  if (!marks || !skips) return null;
  if (raw.deleted === true) return tomb(raw.editedAt, payee, payeeAt, marks, skips);
  if (raw.deleted !== false && raw.deleted !== undefined) return null;
  const { name, amount, dueDay, since, active } = raw;
  if (typeof name !== 'string' || name !== name.trim() || name.length < 1 || name.length > NAME_MAX) return null;
  if (!Number.isInteger(amount) || amount < 1 || amount > AMOUNT_MAX) return null;
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > LAST_DAY) return null;
  if (!isYmd(since) || typeof active !== 'boolean') return null;
  return { name, amount, dueDay, since, active, editedAt: raw.editedAt, deleted: false, payee, payeeAt, marks, skips };
}

function tomb(editedAt, payee, payeeAt, marks, skips) {
  const out = { deleted: true, editedAt };
  if (payee !== null || payeeAt > 0) { out.payee = payee; out.payeeAt = payeeAt; }
  if (Object.keys(marks).length) out.marks = marks;
  if (Object.keys(skips).length) out.skips = skips;
  return out;
}

function flagsOf(value, keyOk, flag) {
  if (value === undefined) return {};
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > MAX_FLAGS) return null;
  const out = {};
  for (const key of keys) {
    const item = value[key];
    if (UNSAFE.has(key) || !keyOk(key) || !isObject(item) || typeof item[flag] !== 'boolean' || !isStamp(item.at)) return null;
    out[key] = { [flag]: item[flag], at: item.at };
  }
  return out;
}

/* ------------------------------------------------------------------ writing */

/**
 * The file as this device would write it: every payment the owner sends, and every removal on record
 * (as `deleted: true` and its time, nothing else) that is at most 400 days old.
 * `whole`: the decisions on money in and out without their caps (a round merges the whole copy and draws the caps on
 * the merged file, withoutOldTombs).
 * @param {object} state
 * @param {number} nowMs
 * @param {{ whole?: boolean }} [opts]
 * @returns {object}
 */
export function exportShared(state, nowMs, opts = {}) {
  const byHand = {};
  const doc = isObject(state) ? state : {};
  for (const r of listOf(doc.recurring)) {
    if (!isObject(r) || r.byHand !== true || !isId(r.id)) continue;
    const entry = projected(r);
    if (entry) byHand[r.id] = entry;
  }
  const tombs = isObject(doc.share) && isObject(doc.share.tombs) ? doc.share.tombs : {};
  for (const id of Object.keys(tombs)) {
    const at = tombs[id];
    if (!isId(id) || Object.hasOwn(byHand, id) || !isStamp(at) || nowMs - at > TOMB_KEEP_MS) continue;
    byHand[id] = { deleted: true, editedAt: at };
  }
  const out = { v: VERSION, app: APP, savedAt: isStamp(nowMs) ? nowMs : 0, byHand };
  const income = exportIncomeShared(doc);
  if (!isBlankIncome(income)) out.income = income;
  // the owner's corrections; a row correction older than 400 days is no longer written (3.8)
  const corrections = pruneCorrections(exportCorrections(doc));
  if (!isBlankCorrections(corrections)) out.corrections = corrections;
  // the owner's choices, each that was ever chosen with its stamp (11)
  const prefs = exportPrefs(doc);
  if (!isBlankPrefs(prefs)) out.prefs = prefs;
  // the daily game: this device's copy within its bounds (3.9)
  const game = exportGame(doc);
  if (!isBlankGame(game)) out.game = game;
  // the decisions on money in and out: this device's copy within its bounds, its own first day as the floor (3.11)
  const flows = exportFlows(doc, nowMs, { whole: !!(opts && opts.whole) });
  if (!isBlankFlows(flows)) out.flows = flows;
  return out;
}

/** What the file says of one entry of the document; null when the entry is not fit to travel. */
function projected(r) {
  return entryOf({
    name: r.name, amount: r.amount, dueDay: r.dueDay, since: r.since, active: r.active !== false,
    editedAt: r.editedAt || 0, deleted: false, payee: r.payee || null, payeeAt: r.payeeAt || 0,
    marks: isObject(r.marks) ? r.marks : {}, skips: isObject(r.skips) ? r.skips : {},
  });
}

/* ------------------------------------------------------------------ merging */

/**
 * Two files into one, entry by entry. The definition (name, amount, day, since, active, deleted) comes
 * whole from the side edited last; the payee from the side that set it last; each tick and each skip
 * from the side that made it last. Every tie is settled by the content alone, so the order of the two
 * sides, merging again, and the grouping of three files never change the result. A removal keeps the
 * ticks, skips and payee another side still held, so that a payment put back by Undo loses none.
 * Other top-level sections of either side are kept.
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
export function mergeShared(a, b) {
  const x = fileOf(a, true) || blank();
  const y = fileOf(b, true) || blank();
  const out = { v: VERSION, app: APP, savedAt: Math.max(x.savedAt, y.savedAt), byHand: {} };
  for (const id of union(x.byHand, y.byHand)) {
    const p = own(x.byHand, id);
    const q = own(y.byHand, id);
    out.byHand[id] = !q ? p : !p ? q : mergeEntry(p, q);
  }
  const income = mergeIncomeShared(x.income, y.income);
  if (!isBlankIncome(income)) out.income = income;
  const corrections = mergeCorrections(x.corrections, y.corrections);
  if (!isBlankCorrections(corrections)) out.corrections = corrections;
  const prefs = mergePrefs(x.prefs, y.prefs);
  if (!isBlankPrefs(prefs)) out.prefs = prefs;
  const game = mergeGame(x.game, y.game);
  if (!isBlankGame(game)) out.game = game;
  const flows = mergeFlows(x.flows, y.flows);
  if (!isBlankFlows(flows)) out.flows = flows;
  for (const key of union(x, y)) {
    if (KNOWN.has(key)) continue;
    const p = own(x, key);
    const q = own(y, key);
    out[key] = q === undefined ? p : p === undefined ? q : (canon(p) <= canon(q) ? p : q);
  }
  return out;
}

function mergeEntry(p, q) {
  const d = definitionWins(p, q) ? p : q;
  const pay = payeeWins(p, q) ? p : q;
  const payee = pay.payee == null ? null : pay.payee;
  const payeeAt = pay.payeeAt || 0;
  const marks = mergeFlags(p.marks, q.marks, 'paid');
  const skips = mergeFlags(p.skips, q.skips, 'on');
  if (d.deleted) return tomb(d.editedAt, payee, payeeAt, marks, skips);
  return { name: d.name, amount: d.amount, dueDay: d.dueDay, since: d.since, active: d.active, editedAt: d.editedAt,
    deleted: false, payee, payeeAt, marks, skips };
}

function definition(e) {
  return canon({ name: e.name, amount: e.amount, dueDay: e.dueDay, since: e.since, active: e.active, deleted: !!e.deleted });
}

function definitionWins(p, q) {
  if (p.editedAt !== q.editedAt) return p.editedAt > q.editedAt;
  if (!!p.deleted !== !!q.deleted) return !!p.deleted;
  return definition(p) <= definition(q);
}

function payeeWins(p, q) {
  const pa = p.payeeAt || 0;
  const qa = q.payeeAt || 0;
  if (pa !== qa) return pa > qa;
  const pk = p.payee == null ? null : p.payee;
  const qk = q.payee == null ? null : q.payee;
  if ((pk === null) !== (qk === null)) return pk !== null;
  return pk === null || pk <= qk;
}

function mergeFlags(a, b, flag) {
  const x = a || {};
  const y = b || {};
  const out = {};
  for (const key of union(x, y)) {
    const p = own(x, key);
    const q = own(y, key);
    const first = !q || (p && (p.at !== q.at ? p.at > q.at : p[flag] || !q[flag]));
    const from = first ? p : q;
    out[key] = { [flag]: from[flag], at: from.at };
  }
  return out;
}

/**
 * Equal in content, whatever the order of the keys and the time of saving.
 * @returns {boolean}
 */
export function sameShared(a, b) {
  return canon(unsaved(a)) === canon(unsaved(b));
}

function unsaved(x) {
  return isObject(x) ? { ...x, savedAt: 0 } : x;
}

/* ----------------------------------------------------------------- applying */

/**
 * How many changes `applyShared` would make to the document: 0 when it already agrees with `merged`.
 * @returns {number}
 */
export function sharedChanges(state, merged) {
  return planOf(state, merged).length;
}

/**
 * Make the document's payments the owner sends equal to `merged`: one the device lacks is created
 * with the same id, one that differs is updated, one that is removed is removed and its removal is
 * recorded. An entry that is not such a payment is never touched, and neither is one `merged` does
 * not name. The caller runs detection afterwards (the links follow the list).
 * @param {object} state  (mutated)
 * @param {object} merged
 * @param {number} nowMs
 * @returns {{ changed: boolean }}
 */
export function applyShared(state, merged, nowMs) {
  // every time written here is the file's own, so that the device then agrees with the file
  const ops = planOf(state, merged);
  if (!ops.length) return { changed: false };
  if (ops.some((one) => one.op === 'income')) {
    // the answers about reported income: the merged ones, and the payments' moves follow them (3.7)
    ensureIncome(state).shared = mergeIncomeShared(fileOf(merged, true).income, null);
    rebuildIncome(state, nowMs);
  }
  const corrected = ops.some((one) => one.op === 'corrections');
  if (corrected) {
    // the owner's corrections: the merged ones become this device's copy, and the record follows them through the
    // owner's own paths (3.8); the caller's run of detection then re-reads the rows
    const before = exportCorrections(state);
    storeCorrections(state, mergeCorrections(fileOf(merged, true).corrections, null));
    applyCorrections(state, nowMs, before);
  }
  // the owner's choices: the merged ones become the device's (the later stamp has already won in the merge)
  // (a value this version does not know is carried in the file, never applied: its stamp is noted, so that the device's
  // next choice is stamped above it and travels)
  if (ops.some((one) => one.op === 'prefs')) {
    applyPrefs(state, fileOf(merged, true).prefs);
    noteSeenPrefs(state, fileOf(merged, true).prefs);
  }
  // the daily game: the copy takes the cells that win, and the record follows them as the owner's actions write it (3.9)
  if (ops.some((one) => one.op === 'game')) applyGame(state, fileOf(merged, true).game);
  // the decisions on money in and out: the copy takes the cells that win, and the record follows them (3.11)
  if (ops.some((one) => one.op === 'flows')) takeFlows(state, fileOf(merged, true).flows, nowMs);
  if (!Array.isArray(state.recurring)) state.recurring = [];
  if (!isObject(state.share)) state.share = { tombs: {} };
  if (!isObject(state.share.tombs)) state.share.tombs = {};
  const tombs = state.share.tombs;
  for (const { op, id, want } of ops) {
    if (op === 'income' || op === 'corrections' || op === 'prefs' || op === 'game' || op === 'flows') continue;
    const at = state.recurring.findIndex((r) => isObject(r) && r.id === id);
    if (op === 'remove') {
      if (at >= 0) state.recurring.splice(at, 1);
      tombs[id] = want.editedAt;
    } else if (op === 'tomb') {
      tombs[id] = want.editedAt;
    } else if (op === 'untomb') {
      delete tombs[id];
    } else {
      const fresh = makeByHand({ id, name: want.name, amount: want.amount, dueDay: want.dueDay, since: want.since, active: want.active,
        editedAt: want.editedAt, payee: want.payee, payeeAt: want.payeeAt, marks: want.marks, skips: want.skips });
      if (op === 'create') {
        state.recurring.push(fresh);
      } else {
        const have = state.recurring[at];
        for (const field of ['name', 'amount', 'dueDay', 'since', 'anchor', 'active', 'editedAt', 'payee', 'payeeAt', 'marks', 'skips']) {
          have[field] = fresh[field];
        }
      }
      delete tombs[id];
    }
  }
  return corrected ? { changed: true, corrected } : { changed: true };
}

function planOf(state, merged) {
  const file = fileOf(merged, true);
  if (!file || !isObject(state)) return [];
  const list = listOf(state.recurring);
  const tombs = isObject(state.share) && isObject(state.share.tombs) ? state.share.tombs : {};
  const ops = [];
  const income = mergeIncomeShared(file.income, null);
  if (JSON.stringify(sortedCopy(incomeOf(state).shared)) !== JSON.stringify(sortedCopy(income))) ops.push({ op: 'income' });
  if (canon(storedCorrections(state)) !== canon(mergeCorrections(file.corrections, null))) ops.push({ op: 'corrections' });
  if (prefsDiffer(state, file.prefs) || prefsUnseen(state, file.prefs)) ops.push({ op: 'prefs' });
  if (gameDiffers(state, file.game)) ops.push({ op: 'game' });
  if (flowsDiffer(state, file.flows)) ops.push({ op: 'flows' });
  for (const id of Object.keys(file.byHand)) {
    const want = file.byHand[id];
    const have = list.find((r) => isObject(r) && r.id === id);
    if (have && have.byHand !== true) continue;
    const buried = Object.hasOwn(tombs, id);
    if (want.deleted) {
      if (have) ops.push({ op: 'remove', id, want });
      else if (buried && tombs[id] !== want.editedAt) ops.push({ op: 'tomb', id, want });
    } else if (!have) {
      ops.push({ op: 'create', id, want });
    } else if (canon(projected(have)) !== canon(want)) {
      ops.push({ op: 'update', id, want });
    } else if (buried) {
      ops.push({ op: 'untomb', id, want });
    }
  }
  return ops;
}

/* ------------------------------------------------------------------ a round */

/**
 * One round of sharing: read the file (none yet is an empty one), merge it with this device, bring
 * the device to the merged list (detection runs in the same update), and write the file back when
 * the merged content is not what was read. A removal older than 400 days is left out of what is
 * written. When another device wrote meanwhile the round starts again, at most 3 times. A file that
 * cannot be read is never written over. Before every read and every write the round asks the device
 * whether it is stale (its key replaced or forgotten); a stale round stops at once and sends nothing.
 * The server's time a read or a write answered with (`serverMs`, when the transport has one) is kept in the device's
 * share state when it brings a later day, before this round's export: it moves the daily game's noting limit (3.9).
 * @param {{ state: () => object, update: (now: (s: object) => void, past: (s: object) => void) => void, stale?: () => boolean }} device
 *        update(now, past): `now` changes the document; `past` makes the same arrivals in an earlier copy of it
 * @param {{ read: () => Promise<{ text: string|null, sha: string|null, serverMs?: number }>, write: (text: string, sha: string|null) => Promise<object> }} transport
 * @param {() => number} clock
 * @returns {Promise<{ ok: boolean, skipped?: boolean, changed?: boolean, wrote?: boolean, file?: boolean, count?: number }>}
 *          rejects with an error carrying `code` ('file' here; the transport's own otherwise)
 */
export async function roundShared(device, transport, clock) {
  let changed = false;
  const stale = () => !!(device.stale && device.stale());
  for (let turn = 0; ; turn++) {
    if (stale()) return { ok: false, skipped: true };
    const got = await transport.read();
    const file = got.text == null ? blank() : readSharedFile(got.text);
    if (!file) throw unreadable();
    if (stale()) return { ok: false, skipped: true };
    heard(device, got.serverMs);
    const now = clock();
    // the decisions on money in and out go into the merge whole (the caps are drawn on the merged file, below), so a
    // removal past this device's own caps still answers a file that holds the entry live
    const local = exportShared(device.state(), now, WHOLE);
    let merged = withoutOldCorrections(mergeShared(local, file));
    if (sharedChanges(device.state(), merged)) {
      // What the file brought that this device did not have: an earlier copy of the document (the one
      // Undo puts back) takes in the same entries of the file, merged with its own, so that an Undo
      // takes back the owner's change only and never what another device sent.
      const arrived = { ...file, byHand: {} };
      for (const id of Object.keys(file.byHand)) {
        if (canon(own(local.byHand, id)) !== canon(merged.byHand[id])) arrived.byHand[id] = file.byHand[id];
      }
      // the corrections likewise: only the entries that differ from this device's own (never its own edits, so
      // that an Undo of them still takes them back)
      const fresh = arrivedCorrections(local.corrections, merged.corrections);
      if (isBlankCorrections(fresh)) delete arrived.corrections; else arrived.corrections = fresh;
      // the daily game likewise: the cells that differ from this device's own
      const played = arrivedGame(local.game, merged.game);
      if (isBlankGame(played)) delete arrived.game; else arrived.game = played;
      // and the decisions on money in and out
      const decided = arrivedFlows(local.flows, merged.flows);
      if (isBlankFlows(decided)) delete arrived.flows; else arrived.flows = decided;
      const all = merged;
      device.update(
        (s) => { if (applyShared(s, all, now).changed) refresh(s, now); },
        (s) => { if (applyShared(s, mergeShared(exportShared(s, now, WHOLE), arrived), now).corrected) refresh(s, now); },
      );
      changed = true;
      merged = mergeShared(exportShared(device.state(), now, WHOLE), merged); // a payee that run of detection learned
    }
    // a removal of the decisions on money in and out that is past its pool's cap and answers a live entry of the file
    // just read is restamped in this device's copy (and in the earlier copies Undo keeps), among the newest of its pool:
    // the caps then keep it until every device has taken it, whatever the order of the rounds (flowsection.heldRemovals)
    const restamped = heldRemovals(merged.flows, now, file.flows);
    if (restamped) {
      device.update((s) => { takeCells(s, restamped); }, (s) => { takeCells(s, restamped); });
      merged = mergeShared(exportShared(device.state(), now, WHOLE), merged);
    }
    merged = withoutOldTombs(merged, now, file);
    const count = Object.keys(merged.byHand).filter((id) => !merged.byHand[id].deleted).length;
    const none = got.text == null;
    if (none && isBlank(merged)) return { ok: true, changed, wrote: false, file: false, count };
    // the guard: a file over its mark is pruned in a fixed order, the same on every device, before it is written. It
    // reads the content alone, so what is compared with the file is the pruned merge: a device that still holds what the
    // guard pruned writes nothing once the file is that pruned merge
    const guarded = guardShared({ ...merged, savedAt: now });
    if (!guarded) throw oversize();
    if (!none && sameShared(guarded, file)) return { ok: true, changed, wrote: false, file: true, count };
    const text = fileText(guarded);
    if (!readSharedFile(text)) throw unreadable();
    if (stale()) return { ok: false, skipped: true };
    try {
      const put = await transport.write(text, got.sha);
      heard(device, put && put.serverMs);
      return { ok: true, changed, wrote: true, file: true, count };
    } catch (err) {
      if (!err || err.code !== 'conflict' || turn >= RESTARTS) throw err;
    }
  }
}

/**
 * Keep the server's time a transport answered with, when it brings a later day (game.js hearServer), in the document
 * and in every earlier copy Undo keeps: device state, never written to the file. The store's update hook then notes
 * what the moved limit lets through.
 */
function heard(device, serverMs) {
  if (!hearsServer(device.state(), serverMs)) return;
  device.update((s) => { hearServer(s, serverMs); }, (s) => { hearServer(s, serverMs); });
}

/**
 * A file as it is written: the corrections in their two sections, `corrections` (what every version reads, its rules
 * covering both directions) and `flowRules` (the rules of one direction, 3.3), an empty one left out.
 */
export function fileText(file) {
  const out = { ...file };
  delete out.corrections;
  delete out.flowRules;
  if (file.corrections) {
    const { corrections, flowRules } = sharedSections(file.corrections);
    if (corrections) out.corrections = corrections;
    if (flowRules) out.flowRules = flowRules;
  }
  // the decisions on money in and out (3.11) are written on one line, after the rest: whitespace only, the same JSON,
  // which keeps the section at its caps about 35,000 characters shorter (an older build writes it back indented)
  const flows = out.flows;
  delete out.flows;
  const text = JSON.stringify(out, null, 1);
  if (flows === undefined) return text;
  const body = JSON.stringify(flows);
  return text === '{}' ? '{\n "flows": ' + body + '\n}' : text.slice(0, -2) + ',\n "flows": ' + body + '\n}';
}

/** The file without the row corrections 400 days older than its newest one (by their days alone, never a clock: 3.8). */
function withoutOldCorrections(file) {
  if (!file.corrections) return file;
  const out = { ...file };
  const corrections = pruneCorrections(file.corrections);
  if (isBlankCorrections(corrections)) delete out.corrections; else out.corrections = corrections;
  return out;
}

/**
 * The file as a round writes it: without the removals older than 400 days (the device has already applied them), of
 * payments by hand and of the decisions on money in and out; with at most the newest 250 removals of payments by hand
 * (by their time, then their id: the same on every device; a removal past the 250 stops travelling, and the reader still
 * takes 1,000); and the decisions on money in and out within their caps (flowsection.js pruneFlows).
 * A removal whose payment the file just read (`read`) holds live is kept, however old or far down: it has just won the
 * merge over another device's live copy, and that device must receive it once (the next round drops it as usual),
 * else the two devices would write in turn for ever, one the payment and the other neither.
 */
export function withoutOldTombs(file, nowMs, read) {
  const byHand = {};
  const tombs = [];
  const live = (id) => !!read && isObject(read.byHand) && Object.hasOwn(read.byHand, id) && !read.byHand[id].deleted;
  for (const id of Object.keys(file.byHand)) {
    const entry = file.byHand[id];
    if (!entry.deleted || live(id)) byHand[id] = entry;
    else if (!(nowMs - entry.editedAt > TOMB_KEEP_MS)) tombs.push(id);
  }
  tombs.sort((a, b) => (file.byHand[b].editedAt - file.byHand[a].editedAt) || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of tombs.slice(0, TOMBS_WRITTEN).sort()) byHand[id] = file.byHand[id];
  const out = { ...file, byHand };
  if (file.flows) {
    // and the decisions on money in and out within their bounds (3.11): the merge keeps every cell, the file its caps;
    // a removal past its pool's cap is kept while the file just read holds that entry live, as a payment's removal is
    const flows = boundFlows(file.flows, nowMs, read && read.flows);
    if (isBlankFlows(flows)) delete out.flows; else out.flows = flows;
  }
  return out;
}

/**
 * The guard at write time: a file whose text is over 1,990,000 characters is pruned, in a fixed order read from its
 * content alone (so two devices prune one file the same way), until it is under: first the ticks and skips (and payee)
 * that removals of payments by hand carry, the oldest removal first; then the removals of the decisions on money in and
 * out, the oldest first; then the filings of one deposit or reported payment, the oldest day first. When that is not
 * enough (payments with their ticks, which have no cap, an older build's file), the pruned file is still written while
 * its text is within what a reader takes (2,000,000); null only past that (the round stops and says so).
 * @param {object} file  a merged file
 * @returns {object|null}
 */
export function guardShared(file, limit = GUARD_TEXT) {
  let out = file;
  let size = fileText(out).length;
  if (size <= limit) return out;
  // each step: the items in their order, and how to drop one; items go in batches sized by what they free
  const steps = [
    () => {
      const ids = Object.keys(out.byHand).filter((id) => {
        const e = out.byHand[id];
        return e.deleted && (e.marks || e.skips || e.payee !== undefined || e.payeeAt !== undefined);
      }).sort((a, b) => (out.byHand[a].editedAt - out.byHand[b].editedAt) || (a < b ? -1 : 1));
      // what dropping its ticks frees, measured as the file writes it (indented, two levels down)
      return ids.map((id) => ({
        size: writtenSize(out.byHand[id]) - writtenSize({ deleted: true, editedAt: out.byHand[id].editedAt }),
        drop: (f) => { f.byHand = { ...f.byHand, [id]: { deleted: true, editedAt: f.byHand[id].editedAt } }; },
      }));
    },
    () => removalItems(out.flows),
    () => rowFilingItems(out.flows),
  ];
  for (const step of steps) {
    let items = step();
    while (size > limit && items.length) {
      // drop enough of the oldest to free the excess, as each is written, then measure again (a batch short of it is
      // followed by another, so the file lands just under the mark)
      let freed = 0;
      let n = 0;
      while (n < items.length && freed < (size - limit) + 64) { freed += items[n].size; n += 1; }
      const next = { ...out, byHand: { ...out.byHand }, flows: out.flows ? JSON.parse(JSON.stringify(out.flows)) : undefined };
      if (!next.flows) delete next.flows;
      for (const item of items.slice(0, n)) item.drop(next);
      // a part left empty is left out, as a reader reads it: so the pruned file is the same content once read back
      if (next.flows) {
        const tidied = readFlowsWhole(next.flows);
        if (!tidied || isBlankFlows(tidied)) delete next.flows; else next.flows = tidied;
      }
      out = next;
      size = fileText(out).length;
      items = step();
    }
    if (size <= limit) return out;
  }
  return size <= MAX_TEXT ? out : null;
}

/**
 * The characters an entry of `byHand` takes in the file (fileText): JSON indented one space a level, each of its lines
 * after the first two levels down.
 */
function writtenSize(entry) {
  const text = JSON.stringify(entry, null, 1);
  let lines = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines += 1;
  return text.length + 2 * lines;
}

/** The removals of the flows section, the oldest first (then by where they are), each with how to drop it. */
function removalItems(flows) {
  if (!flows) return [];
  const items = [];
  const push = (at, path, size, drop) => items.push({ at, path, size, drop });
  for (const key of Object.keys(flows.lines || {})) {
    for (const field of ['sub', 'verdict', 'active']) {
      const cell = flows.lines[key][field];
      if (!cell || !cell.deleted) continue;
      push(cell.at, 'lines/' + key + '/' + field, JSON.stringify(cell).length + 12, (f) => {
        const line = { ...f.flows.lines[key] };
        delete line[field];
        if (['sub', 'verdict', 'active'].some((one) => line[one])) f.flows.lines[key] = line; else delete f.flows.lines[key];
      });
    }
  }
  for (const name of ['added', 'targets', 'into', 'offers']) {
    for (const key of Object.keys(flows[name] || {})) {
      const cell = flows[name][key];
      if (!cell.deleted) continue;
      push(cell.at, name + '/' + key, JSON.stringify(cell).length + 20, (f) => { delete f.flows[name][key]; });
    }
  }
  for (const key of Object.keys(flows.inlets || {})) {
    for (const field of Object.keys(flows.inlets[key])) {
      const cell = flows.inlets[key][field];
      if (!cell.deleted) continue;
      push(cell.at, 'inlets/' + key + '/' + field, JSON.stringify(cell).length + 12, (f) => {
        const inlet = { ...f.flows.inlets[key] };
        delete inlet[field];
        if (Object.keys(inlet).length) f.flows.inlets[key] = inlet; else delete f.flows.inlets[key];
      });
    }
  }
  return items.sort((a, b) => (a.at - b.at) || (a.path < b.path ? -1 : 1));
}

/** The filings of one deposit or reported payment, the oldest day first (then by key), each with how to drop it. */
function rowFilingItems(flows) {
  if (!flows || !flows.into) return [];
  return Object.keys(flows.into).filter((key) => key[0] === 'i' || key[0] === 'f' || key[0] === 'q')
    .sort((a, b) => (flows.into[a].day < flows.into[b].day ? -1 : flows.into[a].day > flows.into[b].day ? 1 : a < b ? -1 : 1))
    .map((key) => ({ size: JSON.stringify(flows.into[key]).length + 20, drop: (f) => { delete f.flows.into[key]; } }));
}

function oversize() {
  const err = new Error('The shared file would be larger than this version of Networth can read. It was left as it is.');
  err.code = 'file';
  return err;
}

function unreadable() {
  const err = new Error('The shared file is not one this version of Networth can read.');
  err.code = 'file';
  return err;
}

/* ------------------------------------------------------------------ helpers */

function blank() {
  return { v: VERSION, app: APP, savedAt: 0, byHand: {} };
}

function isBlank(file) {
  return Object.keys(file).every((key) => KNOWN.has(key)) && Object.keys(file.byHand).length === 0 && !file.income && !file.corrections && !file.prefs
    && !file.game && !file.flows;
}

/** A copy with every object's keys in order, so that equal content prints the same. */
function sortedCopy(x) {
  if (Array.isArray(x)) return x.map(sortedCopy);
  if (!isObject(x)) return x;
  const out = {};
  for (const key of Object.keys(x).sort()) out[key] = sortedCopy(x[key]);
  return out;
}

function isId(id) {
  return typeof id === 'string' && ID.test(id) && !UNSAFE.has(id);
}

function isSkipKey(key) {
  const m = SKIP_KEY.exec(key);
  return !!m && isYmd(m[1]);
}

function isStamp(x) {
  return Number.isFinite(x) && x >= 0 && x <= MAX_STAMP;
}

function own(obj, key) {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function union(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

/** JSON with sorted keys: equal content gives equal text. */
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (isObject(x)) return '{' + Object.keys(x).sort().map((key) => JSON.stringify(key) + ':' + canon(x[key])).join(',') + '}';
  return x === undefined ? 'null' : JSON.stringify(x);
}

/** A copy of parsed JSON that holds no key a prototype could be reached through. */
function plain(value, depth) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) {
    if (!UNSAFE.has(key)) out[key] = plain(value[key], depth + 1);
  }
  return out;
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}
