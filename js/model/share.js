/**
 * What travels between the owner's devices: the payments they send themselves, their ticks, and the
 * fingerprints that let every device recognise a payment the same way; the answers about the
 * income another app of theirs reports (`income`, ARCHITECTURE 3.7); and the owner's corrections
 * (`corrections`, 3.8: merchant rules, a row's locked fields, a stream's locked settings); the owner's
 * choices that reach every device (`prefs`, 11: the words of the interface); and the daily game (`game`, 3.9: its
 * settings, each day's type, exempt day, note and plan, the baseline's segments and the owner's weekly transfers).
 * See ARCHITECTURE.md section 3.5.
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
const KNOWN = new Set(['v', 'app', 'savedAt', 'byHand', 'income', 'corrections', 'flowRules', 'prefs', 'game']);
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

function fileOf(raw) {
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
 * @param {object} state
 * @param {number} nowMs
 * @returns {object}
 */
export function exportShared(state, nowMs) {
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
  const x = fileOf(a) || blank();
  const y = fileOf(b) || blank();
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
    ensureIncome(state).shared = mergeIncomeShared(fileOf(merged).income, null);
    rebuildIncome(state, nowMs);
  }
  const corrected = ops.some((one) => one.op === 'corrections');
  if (corrected) {
    // the owner's corrections: the merged ones become this device's copy, and the record follows them through the
    // owner's own paths (3.8); the caller's run of detection then re-reads the rows
    const before = exportCorrections(state);
    storeCorrections(state, mergeCorrections(fileOf(merged).corrections, null));
    applyCorrections(state, nowMs, before);
  }
  // the owner's choices: the merged ones become the device's (the later stamp has already won in the merge)
  // (a value this version does not know is carried in the file, never applied: its stamp is noted, so that the device's
  // next choice is stamped above it and travels)
  if (ops.some((one) => one.op === 'prefs')) {
    applyPrefs(state, fileOf(merged).prefs);
    noteSeenPrefs(state, fileOf(merged).prefs);
  }
  // the daily game: the copy takes the cells that win, and the record follows them as the owner's actions write it (3.9)
  if (ops.some((one) => one.op === 'game')) applyGame(state, fileOf(merged).game);
  if (!Array.isArray(state.recurring)) state.recurring = [];
  if (!isObject(state.share)) state.share = { tombs: {} };
  if (!isObject(state.share.tombs)) state.share.tombs = {};
  const tombs = state.share.tombs;
  for (const { op, id, want } of ops) {
    if (op === 'income' || op === 'corrections' || op === 'prefs' || op === 'game') continue;
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
  const file = fileOf(merged);
  if (!file || !isObject(state)) return [];
  const list = listOf(state.recurring);
  const tombs = isObject(state.share) && isObject(state.share.tombs) ? state.share.tombs : {};
  const ops = [];
  const income = mergeIncomeShared(file.income, null);
  if (JSON.stringify(sortedCopy(incomeOf(state).shared)) !== JSON.stringify(sortedCopy(income))) ops.push({ op: 'income' });
  if (canon(storedCorrections(state)) !== canon(mergeCorrections(file.corrections, null))) ops.push({ op: 'corrections' });
  if (prefsDiffer(state, file.prefs) || prefsUnseen(state, file.prefs)) ops.push({ op: 'prefs' });
  if (gameDiffers(state, file.game)) ops.push({ op: 'game' });
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
    const local = exportShared(device.state(), now);
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
      const all = merged;
      device.update(
        (s) => { if (applyShared(s, all, now).changed) refresh(s, now); },
        (s) => { if (applyShared(s, mergeShared(exportShared(s, now), arrived), now).corrected) refresh(s, now); },
      );
      changed = true;
      merged = mergeShared(exportShared(device.state(), now), merged); // a payee that run of detection learned
    }
    merged = withoutOldTombs(merged, now);
    const count = Object.keys(merged.byHand).filter((id) => !merged.byHand[id].deleted).length;
    const none = got.text == null;
    if (none ? isBlank(merged) : sameShared(merged, file)) return { ok: true, changed, wrote: false, file: !none, count };
    const text = fileText({ ...merged, savedAt: now });
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
  return JSON.stringify(out, null, 1);
}

/** The file without the row corrections 400 days older than its newest one (by their days alone, never a clock: 3.8). */
function withoutOldCorrections(file) {
  if (!file.corrections) return file;
  const out = { ...file };
  const corrections = pruneCorrections(file.corrections);
  if (isBlankCorrections(corrections)) delete out.corrections; else out.corrections = corrections;
  return out;
}

/** The file without the removals older than 400 days (the device has already applied them). */
function withoutOldTombs(file, nowMs) {
  const byHand = {};
  for (const id of Object.keys(file.byHand)) {
    const entry = file.byHand[id];
    if (!(entry.deleted && nowMs - entry.editedAt > TOMB_KEEP_MS)) byHand[id] = entry;
  }
  return { ...file, byHand };
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
    && !file.game;
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
