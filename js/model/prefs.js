/**
 * The owner's choices that reach every device: for now the words of the interface (ARCHITECTURE.md section 11).
 * They travel in the shared file's known section `prefs: { words: { v, at } }`: every field holds its value and its
 * own stamp, and two copies merge field by field: the later stamp wins, an equal stamp goes to the smaller cell
 * written as JSON with sorted keys (the canonical order), so the merge is commutative, associative and idempotent.
 *
 * On the device the value is `settings.words` (what every view reads, through words.wordsOf) and its stamp is
 * `settings.wordsAt` (0: never chosen on any device this record heard of). A record whose stamp is 0 writes no
 * field. Without a sharing key nothing leaves the device: the choice is then the device's own. A value a later
 * version wrote is carried, never applied; the device notes its stamp (`settings.wordsSeenAt`, absent until one is
 * seen) so that its next choice is stamped above it.
 *
 * Pure: no clock (every stamp is handed in), no DOM, no storage. Imports: words.
 */

import { WORDS, wordsMode } from './words.js';

const MAX_STAMP = 1e14;
/** At most this many fields travel; a field a newer version adds is carried as it is, checked for shape only. */
const MAX_FIELDS = 20;
const MAX_VALUE = 64;
const FIELD = /^[a-z][A-Za-z0-9]{0,31}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** The fields this version knows: what a value may be, and where the device keeps the value and its stamp. */
const KNOWN = {
  words: { ok: (v) => WORDS.includes(v), value: 'words', stamp: 'wordsAt', seen: 'wordsSeenAt' },
};

/**
 * The section of a shared file, checked (untrusted input). An object of fields `{ v, at }` with nothing else in a
 * cell; every value a short string, a finite number or a boolean; stamps from 0 to 10^14; at most 20 fields.
 * Anything else is null, and refuses the file. A known field holding a value this version does not know (a mode a
 * later version adds) is read and carried like any field; it is never applied (applyPrefs), so the device keeps its own.
 * @param {*} raw
 * @returns {object|null} a fresh copy
 */
export function readPrefs(raw) {
  if (!isObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > MAX_FIELDS) return null;
  const out = {};
  for (const key of keys) {
    if (UNSAFE.has(key) || !FIELD.test(key)) return null;
    const cell = raw[key];
    if (!isObject(cell) || Object.keys(cell).some((name) => name !== 'v' && name !== 'at') || !isStamp(cell.at)) return null;
    if (!isValue(cell.v)) return null;
    out[key] = { v: cell.v, at: cell.at };
  }
  return out;
}

/**
 * Two sections into one, field by field: the later stamp wins; on an equal stamp the smaller canonical cell.
 * Either side may be absent or unreadable (read as empty).
 * @returns {object}
 */
export function mergePrefs(a, b) {
  const x = readPrefs(a === undefined ? {} : a) || {};
  const y = readPrefs(b === undefined ? {} : b) || {};
  const out = {};
  for (const key of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
    const p = Object.hasOwn(x, key) ? x[key] : null;
    const q = Object.hasOwn(y, key) ? y[key] : null;
    out[key] = laterCell(p, q);
  }
  return out;
}

/** True when a section holds no field. */
export function isBlankPrefs(section) {
  return !isObject(section) || Object.keys(section).length === 0;
}

/**
 * This device's section, as it writes it: each known field that has been chosen (its stamp above 0).
 * @param {object} state
 * @returns {object}
 */
export function exportPrefs(state) {
  const settings = settingsOf(state);
  const out = {};
  for (const key of Object.keys(KNOWN)) {
    const spec = KNOWN[key];
    const at = settings[spec.stamp];
    if (isStamp(at) && at > 0 && spec.ok(settings[spec.value])) out[key] = { v: settings[spec.value], at };
  }
  return out;
}

/**
 * Whether bringing the device to `section` would change it: a known field the section holds, with a value this
 * version knows, that differs from the device's value or stamp. A value it does not know changes nothing here.
 * @returns {boolean}
 */
export function prefsDiffer(state, section) {
  const settings = settingsOf(state);
  const merged = mergePrefs(section, undefined);
  return Object.keys(KNOWN).some((key) => applicable(merged, key)
    && (settings[KNOWN[key].value] !== merged[key].v || settings[KNOWN[key].stamp] !== merged[key].at));
}

/**
 * Bring the device to `section` (a merged one): each known field it holds becomes the device's value and stamp.
 * @param {object} state  (mutated)
 * @param {object} section
 * @returns {boolean} true when anything changed
 */
export function applyPrefs(state, section) {
  if (!isObject(state)) return false;
  if (!prefsDiffer(state, section)) return false;
  if (!isObject(state.settings)) state.settings = {};
  const merged = mergePrefs(section, undefined);
  for (const key of Object.keys(KNOWN)) {
    if (!applicable(merged, key)) continue;
    state.settings[KNOWN[key].value] = merged[key].v;
    state.settings[KNOWN[key].stamp] = merged[key].at;
  }
  return true;
}

/**
 * Whether the section holds a known field with a value this version does not know (carried, never applied), stamped
 * above the highest such stamp the device has noted (`settings.wordsSeenAt`).
 * @returns {boolean}
 */
export function prefsUnseen(state, section) {
  const settings = settingsOf(state);
  const merged = mergePrefs(section, undefined);
  return Object.keys(KNOWN).some((key) => Object.hasOwn(merged, key) && !applicable(merged, key)
    && merged[key].at > seenOf(settings, key));
}

/**
 * Note the stamp of each value the section carries that this version does not apply, keeping the highest seen
 * (`settings.wordsSeenAt`), so that the device's next choice is stamped above it and wins the field back (chooseWords).
 * The device's own value and stamp are untouched. Set where a round merges the section (share.js applyShared).
 * @param {object} state  (mutated)
 * @param {object} section
 * @returns {boolean} true when a stamp was noted
 */
export function noteSeenPrefs(state, section) {
  if (!isObject(state) || !prefsUnseen(state, section)) return false;
  if (!isObject(state.settings)) state.settings = {};
  const merged = mergePrefs(section, undefined);
  for (const key of Object.keys(KNOWN)) {
    if (!Object.hasOwn(merged, key) || applicable(merged, key)) continue;
    if (merged[key].at > seenOf(state.settings, key)) state.settings[KNOWN[key].seen] = merged[key].at;
  }
  return true;
}

/**
 * The owner chooses the words on this device: the value, stamped with the moment of the choice and always 2 above
 * the stamp it replaces, or above the stamp of a value from a later version it has seen and carried
 * (`max(round(now), max(wordsAt, wordsSeenAt) + 2)`, as corrections are stamped: 3.8), so a choice made after
 * seeing another device's wins even when this device's clock runs behind. Choosing what is already set changes
 * nothing and stamps nothing.
 * @param {object} state  (mutated)
 * @param {'chess'|'finance'} mode
 * @param {number} nowMs
 * @returns {boolean} true when the choice changed
 */
export function chooseWords(state, mode, nowMs) {
  if (!isObject(state)) return false;
  if (!isObject(state.settings)) state.settings = {};
  const settings = state.settings;
  const next = wordsMode(mode);
  if (settings.words === next) return false;
  const before = Math.max(isStamp(settings.wordsAt) ? settings.wordsAt : 0, seenOf(settings, 'words'));
  settings.words = next;
  settings.wordsAt = Math.min(MAX_STAMP, Math.max(Math.round(Number.isFinite(nowMs) ? nowMs : 0), before + 2));
  return true;
}

/* ------------------------------------------------------------------ helpers */

/** A known field that a section holds with a value this version knows (one it does not know is carried, not applied). */
function applicable(section, key) {
  return Object.hasOwn(section, key) && KNOWN[key].ok(section[key].v);
}

/** The cell that wins: the later stamp; on the same stamp the smaller canonical form. */
function laterCell(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p.at !== q.at) return p.at > q.at ? p : q;
  return canon(p) <= canon(q) ? p : q;
}

/** The highest stamp the device has noted for a field's value it does not apply (0: none). */
function seenOf(settings, key) {
  const at = settings[KNOWN[key].seen];
  return isStamp(at) ? at : 0;
}

function settingsOf(state) {
  return isObject(state) && isObject(state.settings) ? state.settings : {};
}

function isValue(v) {
  return typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_VALUE);
}

function isStamp(x) {
  return Number.isFinite(x) && x >= 0 && x <= MAX_STAMP;
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function canon(x) {
  if (isObject(x)) return '{' + Object.keys(x).sort().map((key) => JSON.stringify(key) + ':' + canon(x[key])).join(',') + '}';
  return JSON.stringify(x);
}
