/**
 * The owner's corrections, the same on every device (ARCHITECTURE 3.8): the merchant rules they taught
 * ("All money out" / "All money in": a rule covers the direction it was taught on, 3.3; one made before rules had a
 * direction covers both), the fields they set and locked on one bank row, and the settings they locked on an income
 * stream. They travel in the shared file's `corrections` section, merged field by field by stamp; the rules of one
 * direction in the `flowRules` section beside it, which an older version keeps whole and never applies.
 *
 *   corrections: {
 *     rules:   { "<merchant>": { category?: F, klass?: F, purpose?: F, merchant?: F } },   (covering both directions)
 *     moves:   { "<row>": { category?: F, klass?: F, purpose?: F, merchant?: F, day, fp?, from? } },
 *     streams: { "<payer>|<account>": { name?: F, kind?: F, cadence?: F, accrue?: F } },
 *   }
 *   flowRules: { out?: { "<merchant>": rule }, in?: { "<merchant>": rule } }   (a rule of one direction)
 *   This device's copy keeps every rule in one map: a rule of one direction under "<merchant>:out" or "<merchant>:in".
 *   F = { v, at } | { deleted: true, at }   (a field taken back is a removal of that field alone)
 *       an Undo's cells also say so: `undo: true` (content like the rest: the merge keeps it); an edit of a rule's
 *       category names the stamp of the cell it replaced on the device that made it: `over` (see applyCorrections)
 *
 * `from` names the key a row entry continues (a row the bank re-keyed); the device remembers in `share.reached` the
 * key under which an entry first reached each row (never shared).
 *
 * Nothing the bank reported is written in it but a corrected row's day (so that every device finds the same row and
 * prunes alike), only what the owner set and fingerprints every device computes the same way from what it holds
 * (52-bit hashes, byhand.payeeKey's): a merchant or a payer is the fingerprint of its merchant key ('p' and 13 hex digits, the same as a payment's payee); an account is 'a' and the hash of its
 * provider id; a row is 'i' and the hash of the account's and the row's provider ids, or, for a row the bank gave
 * no id, 'f' and the hash of its fingerprint built with the account's provider id (`fp`, kept beside every row
 * entry, so that a row whose id the bank re-issued is still found, as merge.js finds it). A device that holds no
 * row of a merchant keeps its rule until a reading brings one. The document keeps this device's copy in
 * `share.corrections`.
 *
 * Pure: no clock (every stamp is handed in), no DOM, no storage.
 */

import { CADENCES, CATEGORIES, FLOW_CATEGORIES, KLASSES, PURPOSES, STREAM_KINDS } from './schema.js';
import { isYmd } from './dates.js';
import { learnRule, reclassify, ruleCovers, ruleOfRow } from './classify.js';
import { payeeKey } from './byhand.js';

/** At most this many entries of each kind travel, the newest by stamp kept (then by key), the same on every device. */
export const MAX_RULES = 1000;
export const MAX_MOVES = 1000;
export const MAX_STREAM_SETTINGS = 200;
/** A row correction whose row is this much older than the newest corrected row is no longer written: by the days alone. */
export const MOVE_KEEP_DAYS = 400;

const RULE_FIELDS = ['category', 'klass', 'purpose', 'merchant'];
/** The fields the owner locks on a bank row (classify's LOCKABLE). */
const MOVE_FIELDS = RULE_FIELDS;
/** The fields the owner locks on an income stream that travel (the note stays on the device). */
const STREAM_FIELDS = ['name', 'kind', 'cadence', 'accrue'];
const MERCHANT_MAX = 48;
const STREAM_NAME_MAX = 80;
const MAX_STAMP = 1e14;
const DAY_MS = 86400000;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const ROW_KEY = /^[if][0-9a-f]{13}$/;
const FP_KEY = /^f[0-9a-f]{13}$/;
const MERCHANT_KEY = /^p[0-9a-f]{13}$/;
/**
 * A rule's key in this device's copy: its merchant's, and for a rule that covers one direction (3.3) `:out` or `:in`.
 * The file keeps the rules of one direction in a section of their own (`flowRules`, keyed by merchant), which an
 * older version keeps whole and never applies (it would apply a rule of the `corrections` section both ways).
 */
const RULE_KEY = /^p[0-9a-f]{13}(?::(?:out|in))?$/;
const DIRECTIONS = ['out', 'in'];
const STREAM_KEY = /^p[0-9a-f]{13}\|a[0-9a-f]{13}$/;
const LEARNED_SHARED = 'learned:s';

/* ------------------------------------------------------------------ reading */

/**
 * Check the `corrections` section of the shared file. Null when it is not one this version can read.
 * Every field of an entry carries its own stamp: `{ v, at }`, or `{ deleted: true, at }` for a field taken back. An
 * entry in the first build's shape (its fields and one `at`; `{ deleted: true, at }` for a removal) reads as the
 * same fields, each stamped with that `at`.
 * @returns {{ rules: object, moves: object, streams: object }|null}
 */
export function readCorrections(raw) {
  return sectionOf(raw, true);
}

/**
 * The owner's corrections as the shared file holds them: the `corrections` section, whose rules cover both directions
 * (as every version reads them), and the `flowRules` section, `{ out: { <merchant>: rule }, in: { <merchant>: rule } }`,
 * the rules that cover one direction (3.3). Null when either is not one this version can read. The result is this
 * device's form of the section: one map of rules, a rule of one direction keyed `<merchant>:out` or `<merchant>:in`.
 */
export function readSharedCorrections(corrections, flowRules) {
  if (corrections !== undefined && corrections !== null && !isObject(corrections)) return null;
  const joined = isObject(corrections) ? { ...corrections } : {};
  if (isObject(joined.rules)) {
    const keys = Object.keys(joined.rules);
    // (what a round holds in memory keeps the rules of one direction here too: never written so, see sharedSections)
    if (keys.length > MAX_RULES || keys.some((key) => !isRuleKey(key))) return null;
    joined.rules = { ...joined.rules };
  }
  if (flowRules !== undefined) {
    if (!isObject(flowRules)) return null;
    for (const flow of Object.keys(flowRules)) {
      const map = flowRules[flow];
      if (!DIRECTIONS.includes(flow) || !isObject(map) || Object.keys(map).length > MAX_RULES) return null;
      if (joined.rules === undefined || joined.rules === null) joined.rules = {};
      if (!isObject(joined.rules)) return null;
      for (const key of Object.keys(map)) {
        if (!isMerchantKey(key)) return null;
        const at = ruleKeyOf(key, flow);
        if (!Object.hasOwn(joined.rules, at)) { joined.rules[at] = map[key]; continue; }
        // the same rule in both places (no writer puts it so): the two copies merge field by field, the later stamp winning
        const p = ruleOf(joined.rules[at]);
        const q = ruleOf(map[key]);
        if (!p || !q) return null;
        joined.rules[at] = mergeEntry(p, q, RULE_FIELDS, false);
      }
    }
  }
  return readCorrections(joined);
}

/**
 * This device's form of the section as the file writes it: `corrections` (the rules that cover both directions, the
 * rows, the streams) and `flowRules` (the rules of one direction, by direction then merchant); an empty part is null.
 */
export function sharedSections(section) {
  const s = readCorrections(section) || blank();
  const corrections = { rules: {}, moves: s.moves, streams: s.streams };
  const flows = { out: {}, in: {} };
  for (const key of Object.keys(s.rules)) {
    const { merchant, flow } = ruleKeyParts(key);
    if (flow) flows[flow][merchant] = s.rules[key]; else corrections.rules[key] = s.rules[key];
  }
  const flowRules = {};
  for (const flow of DIRECTIONS) if (Object.keys(flows[flow]).length) flowRules[flow] = flows[flow];
  return {
    corrections: Object.keys(corrections.rules).length || Object.keys(corrections.moves).length || Object.keys(corrections.streams).length ? corrections : null,
    flowRules: Object.keys(flowRules).length ? flowRules : null,
  };
}

/** The document's own copy, read leniently: an entry that is not one is left out, the rest kept within the limits. */
function keptCorrections(raw) {
  return sectionOf(raw, false) || blank();
}

function sectionOf(raw, strict) {
  if (raw === undefined || raw === null) return blank();
  if (!isObject(raw)) return strict ? null : blank();
  const out = blank();
  const parts = [['rules', isRuleKey, ruleOf, MAX_RULES], ['moves', isRowKey, moveOf, MAX_MOVES], ['streams', isStreamKey, streamOf, MAX_STREAM_SETTINGS]];
  for (const [name, keyOk, valueOf, max] of parts) {
    const map = raw[name] === undefined ? {} : raw[name];
    if (!isObject(map)) { if (strict) return null; continue; }
    const keys = Object.keys(map);
    if (strict && keys.length > (name === 'rules' ? max * (DIRECTIONS.length + 1) : max)) return null;
    for (const key of keys) {
      const value = keyOk(key) ? valueOf(map[key], key) : null;
      if (!value) { if (strict) return null; continue; }
      out[name][key] = value;
    }
    out[name] = capped(out[name], max);
  }
  return out;
}

function ruleOf(raw) {
  return isObject(raw) ? cellsOf(raw, RULE_FIELDS) : null;
}

function streamOf(raw) {
  return isObject(raw) ? cellsOf(raw, STREAM_FIELDS) : null;
}

function moveOf(raw, key) {
  if (!isObject(raw) || !isYmd(raw.day)) return null;
  if (raw.fp !== undefined && !(typeof raw.fp === 'string' && FP_KEY.test(raw.fp))) return null;
  if (raw.from !== undefined && !(typeof raw.from === 'string' && ROW_KEY.test(raw.from) && raw.from !== key)) return null;
  const cells = cellsOf(raw, MOVE_FIELDS);
  return cells ? { ...cells, ...placeOf(raw) } : null;
}

/** The fields of an entry, each with its stamp, in the fixed order; null when one is not one or none is there. */
function cellsOf(raw, fields) {
  const out = {};
  if (raw.at !== undefined) {
    // the first build's shape: one stamp for the whole entry
    if (!isStamp(raw.at)) return null;
    if (raw.deleted === true) {
      for (const field of fields) out[field] = { deleted: true, at: raw.at };
      return out;
    }
    if (raw.deleted !== undefined && raw.deleted !== false) return null;
    for (const field of fields) {
      if (raw[field] === undefined) continue;
      if (!valueOk(field, raw[field])) return null;
      out[field] = { v: raw[field], at: raw.at };
    }
    return Object.keys(out).length ? out : null;
  }
  for (const field of fields) {
    if (raw[field] === undefined) continue;
    const cell = cellOf(field, raw[field]);
    if (!cell) return null;
    out[field] = cell;
  }
  return Object.keys(out).length ? out : null;
}

/** One field: `{ v, at }`, or `{ deleted: true, at }`, either marked `undo: true` when an Undo wrote it; null when it is not one. */
function cellOf(field, raw) {
  if (!isObject(raw) || !isStamp(raw.at)) return null;
  if (raw.undo !== undefined && typeof raw.undo !== 'boolean') return null;
  if (raw.over !== undefined && !isStamp(raw.over)) return null;
  const mark = { ...(raw.over !== undefined ? { over: raw.over } : {}), ...(raw.undo === true ? { undo: true } : {}) };
  if (raw.deleted === true) return raw.v === undefined ? { deleted: true, at: raw.at, ...mark } : null;
  if (raw.deleted !== undefined && raw.deleted !== false) return null;
  return Object.hasOwn(raw, 'v') && valueOk(field, raw.v) ? { v: raw.v, at: raw.at, ...mark } : null;
}

/** Whether `v` is a value the owner can set for `field`. */
function valueOk(field, v) {
  switch (field) {
    case 'category': return typeof v === 'string' && (Object.hasOwn(CATEGORIES, v) || Object.hasOwn(FLOW_CATEGORIES, v));
    case 'klass': return typeof v === 'string' && Object.hasOwn(KLASSES, v);
    case 'purpose': return PURPOSES.includes(v);
    case 'merchant': return isText(v, MERCHANT_MAX);
    case 'name': return isText(v, STREAM_NAME_MAX);
    case 'kind': return typeof v === 'string' && Object.hasOwn(STREAM_KINDS, v);
    case 'cadence': return v === null || (typeof v === 'string' && Object.hasOwn(CADENCES, v));
    case 'accrue': return typeof v === 'boolean';
    default: return false;
  }
}

/** Where a row entry's row is: its day, its fingerprint, and the key it continues (a row the bank re-keyed). */
function placeOf(entry) {
  const out = { day: entry.day };
  if (entry.fp !== undefined) out.fp = entry.fp;
  if (entry.from !== undefined) out.from = entry.from;
  return out;
}

/** category, klass, purpose and merchant as the owner can set them; null when one present is not one. */
function classFields(raw) {
  const out = {};
  for (const field of RULE_FIELDS) {
    if (raw[field] === undefined) continue;
    if (!valueOk(field, raw[field])) return null;
    out[field] = raw[field];
  }
  return out;
}

/** name, kind, cadence (null is irregular) and accrue of a stream, the fields `has` names; null when one is not one. */
function streamFields(raw, has) {
  const out = {};
  for (const field of STREAM_FIELDS) {
    if (!has(field)) continue;
    if (!valueOk(field, raw[field])) return null;
    out[field] = raw[field];
  }
  return out;
}

/* ------------------------------------------------------------------ merging */

/**
 * Two sections into one, field by field: per field the later `at` wins; on an equal `at` an edit beats an Undo, then
 * the canonical order decides (the smaller cell written as JSON with sorted keys); a field taken back is a cell like
 * any other. A row entry's
 * place (day, fingerprint, the key it continues) is the one of the entry holding the later stamp, then the smaller.
 * Then the limits, by the entry's latest stamp and key. Commutative, associative and idempotent.
 */
export function mergeCorrections(a, b) {
  const x = readCorrections(a) || blank();
  const y = readCorrections(b) || blank();
  return {
    rules: capped(mergeMap(x.rules, y.rules, RULE_FIELDS, false), MAX_RULES),
    moves: capped(mergeMap(x.moves, y.moves, MOVE_FIELDS, true), MAX_MOVES),
    streams: capped(mergeMap(x.streams, y.streams, STREAM_FIELDS, false), MAX_STREAM_SETTINGS),
  };
}

/** True when the section holds nothing. */
export function isBlankCorrections(section) {
  const s = readCorrections(section);
  return !!s && !Object.keys(s.rules).length && !Object.keys(s.moves).length && !Object.keys(s.streams).length;
}

/**
 * The section without the row corrections whose row is more than 400 days older than the newest row it corrects: by
 * the rows' days alone, which every device reads the same from the file, never by a device's own clock (two clocks on
 * either side of midnight would draw the line on different days, and write the file back and forth). The newest row
 * is never pruned, so pruning again, or merging what was pruned, draws the same line.
 */
export function pruneCorrections(section) {
  const s = readCorrections(section) || blank();
  const cutoff = cutoffOf(Object.values(s.moves).map((entry) => entry.day));
  if (cutoff === null) return s;
  const moves = {};
  for (const key of Object.keys(s.moves)) if (s.moves[key].day >= cutoff) moves[key] = s.moves[key];
  return { ...s, moves };
}

/** The first day a row correction is still written on: 400 days before the newest of `days` (UTC); null for none. */
function cutoffOf(days) {
  let newest = null;
  for (const day of days) if (isYmd(day) && (newest === null || day > newest)) newest = day;
  return newest === null ? null : new Date(Date.parse(newest + 'T00:00:00Z') - MOVE_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * What the file brought that this device did not have: per key, the cells of `merged` that differ from this device's
 * own cell for that field (never this device's own cells, so that an Undo of them still takes them back); a key with
 * no such cell is left out. A row keeps its merged place (day, fp, from).
 */
export function arrivedCorrections(local, merged) {
  const x = readCorrections(local) || blank();
  const y = readCorrections(merged) || blank();
  const out = blank();
  for (const name of ['rules', 'moves', 'streams']) {
    for (const key of Object.keys(y[name])) {
      const mine = own(x[name], key);
      const theirs = y[name][key];
      if (canon(mine) === canon(theirs)) continue;
      const cells = {};
      for (const field of [...RULE_FIELDS, ...STREAM_FIELDS]) {
        const cell = own(theirs, field);
        if (cell && canon(cell) !== canon(own(mine, field))) cells[field] = cell;
      }
      if (!Object.keys(cells).length) continue;
      out[name][key] = theirs.day === undefined ? cells : { ...cells, ...placeOf(theirs) };
    }
  }
  return out;
}

function mergeMap(p, q, fields, placed) {
  const out = {};
  for (const key of [...new Set([...Object.keys(p), ...Object.keys(q)])].sort()) out[key] = mergeEntry(own(p, key), own(q, key), fields, placed);
  return out;
}

function mergeEntry(p, q, fields, placed) {
  if (!p) return q;
  if (!q) return p;
  const out = {};
  for (const field of fields) {
    const cell = laterCell(own(p, field), own(q, field));
    if (cell) out[field] = cell;
  }
  if (!placed) return out;
  const sp = entryAt(p);
  const sq = entryAt(q);
  const where = sp !== sq ? (sp > sq ? p : q) : canon(placeOf(p)) <= canon(placeOf(q)) ? p : q;
  return { ...out, ...placeOf(where) };
}

/** The cell that wins: the later stamp; on the same stamp an edit beats an Undo; then the smaller canonical form. */
function laterCell(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p.at !== q.at) return p.at > q.at ? p : q;
  if (!p.undo !== !q.undo) return p.undo ? q : p;
  return canon(p) <= canon(q) ? p : q;
}

/** An entry's latest stamp, over its fields. */
function entryAt(entry) {
  let at = 0;
  for (const field of [...RULE_FIELDS, ...STREAM_FIELDS]) {
    const cell = own(entry, field);
    if (isObject(cell) && cell.at > at) at = cell.at;
  }
  return at;
}

/**
 * At most `max` entries: the newest by their latest stamp, then by key. In the entries kept, a field older than the
 * last entry kept goes too (stamp, then key): a merge in any order drops it, so the merge stays associative at the
 * limit. Below the limit nothing goes.
 */
function capped(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const sorted = keys.sort((a, b) => entryAt(map[b]) - entryAt(map[a]) || (a < b ? -1 : a > b ? 1 : 0));
  const last = sorted[max - 1];
  const edge = entryAt(map[last]);
  const out = {};
  for (const key of sorted.slice(0, max).sort()) {
    const entry = map[key];
    const kept = {};
    for (const field of [...RULE_FIELDS, ...STREAM_FIELDS]) {
      const cell = own(entry, field);
      if (isObject(cell) && (cell.at > edge || (cell.at === edge && key <= last))) kept[field] = cell;
    }
    out[key] = entry.day === undefined ? kept : { ...kept, ...placeOf(entry) };
  }
  return out;
}

/* ------------------------------------------------------------ the document */

/**
 * What this device writes: its copy of the section; before its first round with this version (no copy yet),
 * the learned rules, the locked row corrections and the locked stream fields it holds, every one stamped 0, so
 * that any explicit edit beats them and two devices' old corrections merge the same way everywhere.
 */
export function exportCorrections(state) {
  const doc = isObject(state) ? state : {};
  const held = isObject(doc.share) && isObject(doc.share.corrections) ? doc.share.corrections : null;
  return held ? keptCorrections(held) : seedsOf(doc);
}

/** This device's copy as the document holds it (blank before the first round). */
export function storedCorrections(state) {
  const doc = isObject(state) ? state : {};
  return keptCorrections(isObject(doc.share) ? doc.share.corrections : null);
}

/** Keep `section` as this device's copy. */
export function storeCorrections(state, section) {
  if (!isObject(state)) return;
  if (!isObject(state.share)) state.share = { tombs: {} };
  state.share.corrections = keptCorrections(section);
}

function seedsOf(state) {
  const values = recordValues(state);
  const out = blank();
  for (const name of ['rules', 'moves', 'streams']) {
    for (const key of Object.keys(values[name])) out[name][key] = seedOf(values[name][key]);
  }
  out.rules = capped(out.rules, MAX_RULES);
  out.moves = capped(out.moves, MAX_MOVES);
  out.streams = capped(out.streams, MAX_STREAM_SETTINGS);
  return out;
}

/** What the record holds for a key, every field stamped 0 (a row's place kept beside them). */
function seedOf(value) {
  const out = {};
  for (const field of [...RULE_FIELDS, ...STREAM_FIELDS]) if (Object.hasOwn(value, field)) out[field] = { v: value[field], at: 0 };
  return value.day === undefined ? out : { ...out, ...placeOf(value) };
}

/**
 * Give the document its copy of the section when it has none yet: what it already holds, stamped 0 (the app does
 * this when it loads a record, before the owner can change anything, so an edit is never taken for an old value).
 * @returns {boolean} true when the copy was made now
 */
export function seedCorrections(state) {
  if (!isObject(state)) return false;
  if (isObject(state.share) && isObject(state.share.corrections)) return false;
  if (!isObject(state.share)) state.share = { tombs: {} };
  state.share.corrections = seedsOf(state);
  return true;
}

/**
 * This device's copy, for an edit just made. Made now (no copy yet), it holds the edit already, stamped 0 like
 * what came before it: the keys the edit touched are taken out of it, so that the edit is written with its stamp.
 */
function ensureSection(state, touched) {
  if (seedCorrections(state)) {
    for (const [name, key] of touched) if (key) delete state.share.corrections[name][key];
  }
  state.share.corrections = keptCorrections(state.share.corrections);
  return state.share.corrections;
}

/**
 * What the record itself says, per key: the learned rules, the fields locked on the bank rows it holds, the
 * fields locked on its streams; and which rows and streams it holds at all (`held`).
 */
function recordValues(state) {
  const out = { rules: {}, moves: {}, streams: {}, heldMerchants: new Set(), heldMoves: new Map(), heldStreams: new Set() };
  const settings = isObject(state.settings) ? state.settings : {};
  for (const rule of listOf(settings.rules)) {
    const merchant = isObject(rule) ? merchantKeyOf(rule.mkey) : null;
    const key = merchant ? ruleKeyOf(merchant, rule.flow) : null;
    if (!key || Object.hasOwn(out.rules, key)) continue;
    const fields = pick(rule, RULE_FIELDS, (field) => rule[field] != null && rule[field] !== '');
    if (fields) out.rules[key] = fields;
  }
  const accounts = accountKeys(state);
  for (const tx of listOf(state.txs)) {
    const merchant = isObject(tx) ? merchantKeyOf(tx.mkey) : null;
    if (merchant) out.heldMerchants.add(merchant);
    const where = rowWhere(tx, accounts);
    if (!where) continue;
    out.heldMoves.set(where.key, where.fp);
    const locks = locksOf(tx);
    const fields = pick(tx, MOVE_FIELDS, (field) => locks.has(field));
    if (fields) out.moves[where.key] = where.fp ? { ...fields, day: tx.day, fp: where.fp } : { ...fields, day: tx.day };
  }
  for (const stream of listOf(state.streams)) {
    const key = streamKeyOf(stream, accounts);
    if (!key) continue;
    out.heldStreams.add(key);
    const locks = locksOf(stream);
    const fields = streamFields(stream, (field) => locks.has(field));
    if (fields && Object.keys(fields).length && !Object.hasOwn(out.streams, key)) out.streams[key] = fields;
  }
  return out;
}

/** The fields `has` names, each checked on its own (one that is not usable is left out); null when none is usable. */
function pick(item, fields, has) {
  const out = {};
  for (const field of fields) {
    const one = has(field) ? classFields({ [field]: item[field] }) : null;
    if (one && Object.hasOwn(one, field)) out[field] = one[field];
  }
  return Object.keys(out).length ? out : null;
}

/* ----------------------------------------------------------------- the keys */

/** Account id -> the hash of its provider id, for the bank accounts that have one. Exported for the queue of moves to file (flows.js), which keys a move by the same fingerprint. */
export function accountKeys(state) {
  const out = new Map();
  for (const account of listOf(state.accounts)) {
    if (!isObject(account) || typeof account.id !== 'string' || !isObject(account.ext) || typeof account.ext.id !== 'string' || !account.ext.id) continue;
    out.set(account.id, { ext: account.ext.id, key: 'a' + hash(account.ext.id) });
  }
  return out;
}

/** The keys of each row as last computed, and what they were computed from: a refresh reads every row twice. */
const whereMemo = new WeakMap();

/** Where a bank row is found on every device: its key, and the hash of its fingerprint built with the account's provider id. */
export function rowWhere(tx, accounts) {
  if (!isObject(tx) || tx.source !== 'bank' || !isYmd(tx.day) || typeof tx.accountId !== 'string') return null;
  const account = accounts.get(tx.accountId);
  if (!account) return null;
  const local = tx.accountId + '|';
  const id = isObject(tx.ext) && typeof tx.ext.id === 'string' && tx.ext.id ? tx.ext.id : null;
  const print = typeof tx.fp === 'string' && tx.fp.startsWith(local) ? tx.fp.slice(local.length) : null;
  const from = account.ext + '\n' + id + '\n' + print;
  const memo = whereMemo.get(tx);
  if (memo && memo.from === from) return memo.where;
  const fp = print === null ? null : 'f' + hash(account.ext + '|' + print);
  const where = id ? { key: 'i' + hash(account.ext + '\n' + id), fp } : fp ? { key: fp, fp } : null;
  whereMemo.set(tx, { from, where });
  return where;
}

function streamKeyOf(stream, accounts) {
  const payer = isObject(stream) && typeof stream.accountId === 'string' ? merchantKeyOf(stream.mkey) : null;
  const account = payer ? accounts.get(stream.accountId) : null;
  return account ? payer + '|' + account.key : null;
}

/** The fingerprint of a merchant key, as a payment's payee is kept (byhand.payeeKey); null for none. */
export function merchantKeyOf(mkey) {
  return typeof mkey === 'string' && mkey ? payeeKey(mkey) : null;
}

/** 13 hex digits of a 52-bit hash, the same on every device. */
function hash(text) {
  return payeeKey(text).slice(1);
}

/* ------------------------------------------------------------- the owner's edits */

/**
 * The owner corrected a bank row (classify.learnRule): the fields locked on it, and its merchant's rule, are written
 * into this device's copy, each field that changed stamped above the stamp it replaces: `max(round(now), at + 2)`
 * (an Undo stamps `at + 1`, so a later edit always beats it). A correction only adds: a field the record does not
 * hold (no rule after "This move only") is left as the copy has it; a field is taken back by Undo alone
 * (restampCorrections).
 * @returns {boolean} true when anything was written
 */
export function noteMove(state, txId, nowMs) {
  if (!isObject(state) || !isStamp(nowMs)) return false;
  const tx = listOf(state.txs).find((t) => isObject(t) && t.id === txId);
  const where = tx ? rowWhere(tx, accountKeys(state)) : null;
  const merchant = tx ? merchantKeyOf(tx.mkey) : null;
  if (!where && !merchant) return false;
  // the owner's rule covers the direction of the row corrected (3.3)
  const direction = tx.flow === 'in' ? 'in' : 'out';
  const ruleKey = merchant ? ruleKeyOf(merchant, direction) : null;
  const section = ensureSection(state, [['moves', where && where.key], ['rules', ruleKey]]);
  const values = recordValues(state);
  let wrote = false;
  if (where && values.moves[where.key]) {
    wrote = write(section.moves, where.key, values.moves[where.key], nowMs) || wrote;
    section.moves = capped(section.moves, MAX_MOVES);
    remember(state, tx.id, where.key);
  }
  if (ruleKey && values.rules[ruleKey]) {
    const was = own(own(section.rules, ruleKey), 'category');
    wrote = write(section.rules, ruleKey, values.rules[ruleKey], nowMs, true) || wrote;
    section.rules = capped(section.rules, MAX_RULES);
    const now = own(own(section.rules, ruleKey), 'category');
    if (isObject(now) && !now.deleted && canon(now) !== canon(was)) wrote = keepHeld(state, section, tx.mkey, direction, nowMs) || wrote;
  }
  return wrote;
}

/**
 * The owner changed a rule's category, and rows of that merchant stay at a category the rule does not give them: rows
 * linked to an income stream or paired, whose kind cannot follow (classify's freeze, as learnRule leaves them). What
 * they keep depends on what this device held before, which never travels: another device, which did not hold it, files
 * them by the rule. So the category each keeps becomes the owner's correction of that row: locked on it here, and
 * written with the stamp of the edit, so that every device files it the same way (applyMoves). Only the owner's own
 * edit does this, never what arrives; it is part of the edit, so one Undo takes it back with the rule (3.8).
 * @returns {boolean} true when anything was written
 */
function keepHeld(state, section, mkey, direction, nowMs) {
  if (typeof mkey !== 'string' || !mkey) return false;
  const accounts = accountKeys(state);
  const held = [];
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || tx.mkey !== mkey || (tx.streamId == null && tx.pairId == null) || tx.kind === 'decline') continue;
    // the rows the edited rule files: of its direction (and a refund the money-out rule files, with no rule for money in)
    const rule = ruleOfRow(state, tx);
    if (!rule || rule.flow !== direction) continue;
    const category = rule.category;
    if (locksOf(tx).has('category') || category == null || tx.category === category || kindOf(category, tx.flow) === null || !valueOk('category', tx.category)) continue;
    const where = rowWhere(tx, accounts);
    if (!where) continue;
    tx.locks = [...(Array.isArray(tx.locks) ? tx.locks : []), 'category'];
    held.push([tx, where.key]);
  }
  if (!held.length) return false;
  const values = recordValues(state);
  let wrote = false;
  for (const [tx, key] of held) {
    if (!values.moves[key]) continue;
    wrote = write(section.moves, key, values.moves[key], nowMs) || wrote;
    remember(state, tx.id, key);
  }
  section.moves = capped(section.moves, MAX_MOVES);
  return wrote;
}

/**
 * The owner changed an income stream's settings (its sheet): the fields locked on it that changed are written into
 * this device's copy, stamped above the stamps they replace.
 * @returns {boolean}
 */
export function noteStream(state, streamId, nowMs) {
  if (!isObject(state) || !isStamp(nowMs)) return false;
  const stream = listOf(state.streams).find((s) => isObject(s) && s.id === streamId);
  const key = stream ? streamKeyOf(stream, accountKeys(state)) : null;
  if (!key) return false;
  const section = ensureSection(state, [['streams', key]]);
  const locks = locksOf(stream);
  const fields = streamFields(stream, (field) => locks.has(field));
  if (!fields || !Object.keys(fields).length) return false;
  const wrote = write(section.streams, key, fields, nowMs);
  section.streams = capped(section.streams, MAX_STREAM_SETTINGS);
  return wrote;
}

/**
 * Write the owner's values for a key: each field whose value changed (or that the copy holds taken back) gets the
 * value, stamped above the stamp it replaces; the other fields keep theirs. A row's place follows the row.
 */
function write(map, key, value, nowMs, rule = false) {
  const current = own(map, key);
  const next = current ? { ...current } : {};
  let wrote = false;
  for (const field of [...RULE_FIELDS, ...STREAM_FIELDS]) {
    if (!Object.hasOwn(value, field)) continue;
    const cell = own(current, field);
    if (cell && !cell.deleted && canon(cell.v) === canon(value[field])) continue;
    // a rule's category names the stamp of the cell it replaces here (0 for none, as a seed), so that a device that held
    // another one knows (applyCorrections)
    const over = rule && field === 'category' ? { over: isObject(cell) ? cell.at : 0 } : {};
    next[field] = { v: value[field], at: editStamp(cell, nowMs), ...over };
    wrote = true;
  }
  if (!wrote) return false;
  if (value.day !== undefined) {
    delete next.fp;
    delete next.from;
    Object.assign(next, placeOf({ ...value, from: current ? current.from : undefined }));
  }
  map[key] = order(next);
  return true;
}

/** The stamp of an edit: now, and always 2 above the stamp it replaces (an Undo writes 1 above: a later edit beats it). */
function editStamp(cell, nowMs) {
  return Math.min(MAX_STAMP, Math.max(Math.round(nowMs), isObject(cell) && isStamp(cell.at) ? cell.at + 2 : 0));
}

/** An entry's live values alone: what the owner set and has not taken back. */
function liveOf(entry) {
  const out = {};
  for (const field of [...RULE_FIELDS, ...STREAM_FIELDS]) {
    const cell = own(entry, field);
    if (isObject(cell) && !cell.deleted) out[field] = cell.v;
  }
  return out;
}

/** The fields an entry holds taken back. */
function deadOf(entry) {
  return [...RULE_FIELDS, ...STREAM_FIELDS].filter((field) => { const cell = own(entry, field); return isObject(cell) && cell.deleted === true; });
}

/** An entry with its fields in the fixed order, then its place. */
function order(entry) {
  const out = {};
  for (const field of [...RULE_FIELDS, ...STREAM_FIELDS]) if (Object.hasOwn(entry, field)) out[field] = entry[field];
  return entry.day === undefined ? out : { ...out, ...placeOf(entry) };
}

/* ------------------------------------------------------------------- Undo */

/**
 * After Undo (store.onRestore): the copy put back carries what the copy before the Undo held (the two merged, so the
 * stamps and removals of an earlier Undo are never lost), and every field whose value differs between the record
 * before the Undo and the record put back is given the restored value, or is taken back when the restored record
 * holds none, stamped 1 above the highest stamp either copy holds for it and marked `undo: true`, so the other devices
 * take the Undo (and know it for one: see applyRules) and a later edit on another device (2 above, and an edit beats an
 * Undo on the same stamp) still wins. A row, a stream or a merchant's rows that only one of the two
 * records holds are left alone (a reading of the bank may have brought them meanwhile, and with them a rule that was
 * waiting for them).
 * @returns {boolean} true when any field was restamped
 */
export function restampCorrections(before, after) {
  if (!isObject(before) || !isObject(after)) return false;
  const was = recordValues(before);
  const now = recordValues(after);
  const hadCopy = isObject(after.share) && isObject(after.share.corrections);
  const kept = exportCorrections(after);
  const section = mergeCorrections(exportCorrections(before), kept);
  let wrote = false;
  // `from`/`to`: the keys the row is held under before the Undo and in the record put back, when they differ
  const restamp = (name, key, where, from = key, to = key) => {
    const value = own(now[name], to) || {};
    const prior = own(was[name], from) || {};
    const entry = own(section[name], key);
    const next = entry ? { ...entry } : {};
    let touched = false;
    for (const field of name === 'streams' ? STREAM_FIELDS : RULE_FIELDS) {
      const has = Object.hasOwn(value, field);
      if (has === Object.hasOwn(prior, field) && (!has || canon(value[field]) === canon(prior[field]))) continue;
      const cell = own(entry, field);
      const at = Math.min(MAX_STAMP, (isObject(cell) ? cell.at : 0) + 1);
      next[field] = has ? { v: value[field], at, undo: true } : { deleted: true, at, undo: true };
      touched = true;
    }
    if (!touched) return;
    if (name === 'moves' && next.day === undefined) Object.assign(next, where(Object.keys(value).length ? value : prior));
    section[name][key] = order(next);
    wrote = true;
  };
  for (const key of union(was.rules, now.rules)) {
    const { merchant } = ruleKeyParts(key);
    if (!was.heldMerchants.has(merchant) || !now.heldMerchants.has(merchant)) continue;
    restamp('rules', key);
  }
  for (const key of union(was.moves, now.moves)) {
    if (!was.heldMoves.has(key) || !now.heldMoves.has(key)) continue;
    restamp('moves', key, (one) => placeOf(one));
  }
  // a row both records hold under different keys (this device's own reading posted a pending row, or the bank gave it
  // a new id, after the change undone): compared as one row, and the Undo written under both keys
  const keysBefore = rowKeysById(before);
  for (const [id, key] of rowKeysById(after)) {
    const from = keysBefore.get(id);
    if (from === undefined || from === key) continue;
    restamp('moves', from, (one) => placeOf(one), from, key);
    restamp('moves', key, (one) => placeOf(one), from, key);
  }
  for (const key of union(was.streams, now.streams)) {
    if (!was.heldStreams.has(key) || !now.heldStreams.has(key)) continue;
    restamp('streams', key);
  }
  const out = { rules: capped(section.rules, MAX_RULES), moves: capped(section.moves, MAX_MOVES), streams: capped(section.streams, MAX_STREAM_SETTINGS) };
  if (wrote || !hadCopy || canon(out) !== canon(kept)) storeCorrections(after, out);
  return wrote;
}

/** Row id -> the key of that bank row, for the rows a record holds. */
function rowKeysById(state) {
  const accounts = accountKeys(state);
  const out = new Map();
  for (const tx of listOf(state.txs)) {
    const where = rowWhere(tx, accounts);
    if (where && typeof tx.id === 'string') out.set(tx.id, where.key);
  }
  return out;
}

/* ----------------------------------------------------------------- applying */

/**
 * Make the record follow this device's copy, through the owner's own paths: a rule's fields go into
 * `settings.rules` (and the rows of that merchant follow it when `detect.refresh` re-reads them, unless a field is
 * locked on them); a row's fields are set and locked on its row (classify.learnRule, "this move only"); a stream's
 * settings are set and locked on that stream. Exactly the fields an entry holds are set and locked; a field taken back
 * lets that field alone go back to what classification and detection decide (a rule with no field left goes). A row
 * this device does not hold yet waits for the reading that brings it. Idempotent: run again, it changes nothing.
 * A rule's category that arrives over another one than this device held (`before`, the copy before a share round
 * merged the file in: two devices changed it, neither seeing the other's) files the rule's rows again, as an Undo's
 * does (refile), so that this device does not keep what its own value had filed and the others never held.
 * @param {object} state  (mutated)
 * @param {number} [nowMs]  when given, a corrected row or stream whose key changed is written under its new key
 * @param {object} [before]  this device's copy before the round merged the file in (exportCorrections of it)
 * @returns {{ changed: boolean }}
 */
export function applyCorrections(state, nowMs, before) {
  if (!isObject(state) || !isObject(state.share) || !isObject(state.share.corrections)) return { changed: false };
  const section = keptCorrections(state.share.corrections);
  const carried = isStamp(nowMs) && carryStreams(state, section);
  const rules = applyRules(state, section.rules, concurrentRules(before, section.rules));
  const moves = applyMoves(state, section.moves);
  const streams = applyStreams(state, section.streams);
  const rekeyed = isStamp(nowMs) && rekey(state, section, nowMs);
  return { changed: carried || rules || moves || streams || rekeyed };
}

/**
 * A stream whose key changed on this device (the bank gave its account a new id): the cells of the entry under the key
 * it had are carried into the entry under its new key, field by field with their stamps, so that an edit another
 * device made under the old key, before it read the new id, reaches the stream wherever it is held now. This device
 * remembers the key it last held each stream under (`share.streamKeys`, stream id -> key; never shared).
 */
function carryStreams(state, section) {
  const accounts = accountKeys(state);
  if (!isObject(state.share.streamKeys)) state.share.streamKeys = {};
  const held = state.share.streamKeys;
  const ids = new Set();
  let wrote = false;
  for (const stream of listOf(state.streams)) {
    const key = streamKeyOf(stream, accounts);
    if (!key || typeof stream.id !== 'string' || UNSAFE.has(stream.id)) continue;
    ids.add(stream.id);
    const old = own(held, stream.id);
    if (typeof old === 'string' && old !== key && Object.hasOwn(section.streams, old)) {
      const next = mergeEntry(own(section.streams, key), section.streams[old], STREAM_FIELDS, false);
      if (canon(next) !== canon(own(section.streams, key))) {
        section.streams[key] = order(next);
        wrote = true;
      }
    }
    held[stream.id] = key;
  }
  for (const id of Object.keys(held)) if (!ids.has(id)) delete held[id]; // streams this device no longer holds
  if (wrote) storeCorrections(state, { ...section, streams: capped(section.streams, MAX_STREAM_SETTINGS) });
  return wrote;
}

/**
 * A corrected row or stream whose key changed on this device and that no entry reaches any more: its locked fields
 * are written under its new key, stamped 0 like a seed, so the other devices, which may only ever see it as it is
 * now, find it. A row is a pending row that posted under the bank's new id and day, or a row of an account the bank
 * gave a new id; the entry names the key it continues (`from`: the entry that reached the row before), so that an
 * Undo written under that key reaches it too. A stream is one of an account the bank gave a new id. Stamped 0, it
 * never overrides an entry, and any edit beats it. Not an edit of the owner: nothing else is written. A row the
 * 400-day line leaves out (pruneCorrections' line, these rows counted in) is not written (it would be pruned again),
 * nor any once the limit is reached, so that nothing is written again and again.
 */
function rekey(state, section, nowMs) {
  const accounts = accountKeys(state);
  const covered = new Set(Object.keys(section.moves));
  const fps = new Set(Object.values(section.moves).map((entry) => entry.fp).filter(Boolean));
  const reached = reachedOf(state);
  const ids = new Set(listOf(state.txs).map((tx) => isObject(tx) && tx.id));
  for (const id of Object.keys(reached)) if (!ids.has(id)) delete reached[id]; // rows this device no longer holds
  const rows = [];
  for (const tx of listOf(state.txs)) {
    const where = rowWhere(tx, accounts);
    if (!where || covered.has(where.key) || (where.fp && fps.has(where.fp))) continue;
    const locks = locksOf(tx);
    const fields = pick(tx, MOVE_FIELDS, (field) => locks.has(field));
    if (fields) rows.push({ tx, where, fields });
  }
  // the 400-day line as the file draws it (pruneCorrections), these rows in it
  const cutoff = cutoffOf([...Object.values(section.moves).map((entry) => entry.day), ...rows.map((one) => one.tx.day)]);
  let wrote = false;
  for (const { tx, where, fields } of rows) {
    if (covered.size >= MAX_MOVES) break;
    if (covered.has(where.key) || (cutoff !== null && tx.day < cutoff)) continue;
    const from = typeof reached[tx.id] === 'string' && ROW_KEY.test(reached[tx.id]) && reached[tx.id] !== where.key ? reached[tx.id] : undefined;
    section.moves[where.key] = order({ ...seedOf(fields), ...placeOf({ day: tx.day, fp: where.fp || undefined, from }) });
    covered.add(where.key);
    wrote = true;
  }
  const streamKeys = new Set(Object.keys(section.streams));
  for (const stream of listOf(state.streams)) {
    if (streamKeys.size >= MAX_STREAM_SETTINGS) break;
    const key = streamKeyOf(stream, accounts);
    if (!key || streamKeys.has(key)) continue;
    const locks = locksOf(stream);
    const fields = streamFields(stream, (field) => locks.has(field));
    if (!fields || !Object.keys(fields).length) continue;
    section.streams[key] = seedOf(fields);
    streamKeys.add(key);
    wrote = true;
  }
  if (wrote) storeCorrections(state, { ...section, moves: capped(section.moves, MAX_MOVES), streams: capped(section.streams, MAX_STREAM_SETTINGS) });
  return wrote;
}

/** The rules whose category cell arrived over another cell than the one `before` holds for it (see applyCorrections). */
function concurrentRules(before, rules) {
  const out = new Set();
  const was = readCorrections(before);
  if (!was) return out;
  for (const key of Object.keys(rules)) {
    const cell = own(rules[key], 'category');
    const held = own(own(was.rules, key), 'category');
    if (!isObject(cell) || cell.over === undefined || !isObject(held) || canon(cell) === canon(held)) continue;
    if (held.at !== cell.over) out.add(key);
  }
  return out;
}

function applyRules(state, entries, concurrent = new Set()) {
  const keys = Object.keys(entries);
  if (!keys.length) return false;
  if (!isObject(state.settings)) state.settings = {};
  if (!Array.isArray(state.settings.rules)) state.settings.rules = [];
  const list = state.settings.rules;
  // the merchant keys this device holds, by their fingerprint: its rules', its rows' and its streams'
  const mkeys = new Map();
  const seen = new Set();
  for (const item of [...list, ...listOf(state.txs), ...listOf(state.streams)]) {
    if (!isObject(item) || typeof item.mkey !== 'string' || seen.has(item.mkey)) continue;
    seen.add(item.mkey);
    const key = merchantKeyOf(item.mkey);
    if (key && !mkeys.has(key)) mkeys.set(key, item.mkey);
  }
  let changed = false;
  for (const key of keys) {
    const { merchant, flow } = ruleKeyParts(key);
    const mkey = mkeys.get(merchant);
    if (mkey === undefined) continue; // no row of this merchant yet: the rule waits for the reading that brings one
    const live = liveOf(entries[key]);
    const dead = deadOf(entries[key]);
    const undone = own(own(entries[key], 'category'), 'undo') === true;
    // the rule of that merchant and direction (a rule made before rules had a direction has none)
    const same = (one) => isObject(one) && one.mkey === mkey && (flow ? one.flow === flow : one.flow !== 'out' && one.flow !== 'in');
    const at = list.findIndex(same);
    const rule = at >= 0 ? list[at] : null;
    if (!rule) {
      if (!Object.keys(live).length) continue;
      list.push({ id: LEARNED_SHARED + merchant.slice(1) + (flow ? '.' + flow : ''), mkey, ...(flow ? { flow } : {}), ...live });
      changed = true;
      continue;
    }
    const next = { ...rule };
    for (const field of RULE_FIELDS) {
      if (Object.hasOwn(live, field)) next[field] = live[field];
      else if (dead.includes(field)) delete next[field];
    }
    if (RULE_FIELDS.every((field) => (next[field] ?? null) === (rule[field] ?? null))) continue;
    // a category taken back lets go of what the rule had filed; one put back by an Undo, or one that arrived over
    // another value than this device held (two devices changed it, neither seeing the other's), files the rule's rows
    // again as a device that never held the value replaced does (refile). An ordinary changed value does what
    // learnRule does on the device that made it, where a deposit linked to a stream keeps its kind.
    if (rule.category != null && next.category == null) release(state, mkey, rule);
    else if (rule.category != null && (undone || concurrent.has(key)) && next.category !== rule.category) refile(state, mkey, rule);
    if (RULE_FIELDS.every((field) => next[field] == null)) {
      for (let i = list.length - 1; i >= 0; i--) if (same(list[i])) list.splice(i, 1);
    } else {
      for (const field of RULE_FIELDS) {
        if (next[field] == null) delete rule[field];
        else rule[field] = next[field];
      }
    }
    changed = true;
  }
  return changed;
}

/**
 * This device's memory of the key an entry first reached a row under (`share.reached`, row id -> key; never shared):
 * when the bank re-keys the row, the entry written under its new key names that key (`from`).
 */
function reachedOf(state) {
  if (!isObject(state.share)) state.share = { tombs: {} };
  if (!isObject(state.share.reached)) state.share.reached = {};
  return state.share.reached;
}

function remember(state, txId, key) {
  const reached = reachedOf(state);
  if (typeof txId === 'string' && !Object.hasOwn(reached, txId) && !UNSAFE.has(txId)) reached[txId] = key;
}

/**
 * A rule's category taken back (or the rule): the deposits it had filed into an income stream are let go of the
 * stream, so that classification reads them again (a linked deposit keeps its kind); detection links them again if
 * they still belong. The rows a rule filed name it (`ruleId`), money in that read as income only because the rule
 * filed the purchase it would mirror as other than a spend included (classify's attribution, 3.3); a deposit linked
 * before the rule names another and is left as it is.
 */
function release(state, mkey, rule) {
  const id = typeof rule.id === 'string' && rule.id ? (rule.id.startsWith('learned:') ? rule.id : 'learned:' + rule.id) : null;
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || tx.mkey !== mkey || tx.streamId == null || locksOf(tx).has('category')) continue;
    if (id === null || tx.ruleId === id) tx.streamId = null;
  }
}

/**
 * An Undo put back another category for a rule (3.8): the deposits the rule had filed into a stream are filed again
 * the way a device that never held the undone value files them. That device linked what classification files as
 * income without the rule's category (detection ran before the owner taught the rule), and the rule then left those
 * deposits as they were, as learnRule does; so a deposit that classification without the rule's category files as
 * income keeps its link, and the others are let go, so that the rule put back files them. The record an Undo puts back
 * on the device that made it holds the same.
 */
function refile(state, mkey, rule) {
  const id = learnedIdOf(rule);
  refileRows(state, listOf(state.txs).filter((tx) => isObject(tx) && tx.mkey === mkey && tx.streamId != null && !locksOf(tx).has('category')
    && (id === null || tx.ruleId === id)), rule);
}

/**
 * Linked rows read again as a device that never held what is being taken back reads them: as classification files
 * them without the merchant rule's category (`rule`, when there is one), those it files as income keep their link,
 * the others are let go, so that the rule's category (and detection) then files them.
 */
function refileRows(state, rows, rule) {
  if (!rows.length) return;
  const links = new Map(rows.map((tx) => [tx, tx.streamId]));
  const ids = new Map(rows.map((tx) => [tx, tx.ruleId]));
  for (const tx of rows) tx.streamId = null;
  // read without the merchant's learned categories, their other fields kept: the rule's, and those of the other rules
  // of that merchant (a rule of one direction is laid over one made before rules had a direction, 3.3), as a device
  // that held neither reads them
  const mkeys = new Set([...(rule ? [rule.mkey] : []), ...rows.map((tx) => tx.mkey)]);
  const held = listOf(isObject(state.settings) ? state.settings.rules : null).filter((one) => isObject(one) && mkeys.has(one.mkey) && one.category !== undefined);
  const categories = held.map((one) => one.category);
  for (const one of held) delete one.category;
  reclassify(state, rows.map((tx) => tx.id));
  held.forEach((one, i) => { one.category = categories[i]; });
  // a row linked again keeps naming the rule that filed it, while that rule still covers it (as classify's keepsRule
  // keeps it on a frozen row): taking that rule back later (release) then reaches the same rows on every device
  const all = listOf(isObject(state.settings) ? state.settings.rules : null);
  for (const tx of rows) {
    if (tx.kind !== 'income') continue;
    tx.streamId = links.get(tx);
    const id = ids.get(tx);
    if (typeof id === 'string' && all.some((one) => isObject(one) && one.mkey === tx.mkey && learnedIdOf(one) === id && ruleCovers(one, tx.flow))) tx.ruleId = id;
  }
}

/** What `ruleId` holds on the rows a learned rule filed (classify's learnedRuleId); null when it has no id. */
function learnedIdOf(rule) {
  return typeof rule.id === 'string' && rule.id ? (rule.id.startsWith('learned:') ? rule.id : 'learned:' + rule.id) : null;
}

function applyMoves(state, entries) {
  const keys = Object.keys(entries);
  if (!keys.length) return false;
  const accounts = accountKeys(state);
  const byKey = new Map();
  const byFp = new Map();
  for (const tx of listOf(state.txs)) {
    const where = rowWhere(tx, accounts);
    if (!where) continue;
    if (!byKey.has(where.key)) byKey.set(where.key, tx);
    if (where.fp && !byFp.has(where.fp)) byFp.set(where.fp, tx);
  }
  // an entry that continues another (a row the bank re-keyed) reaches the row that one reaches, and back
  const find = (key, want) => byKey.get(key) || (want.fp ? byFp.get(want.fp) : null);
  // one entry per row: when a re-issued id or a re-keyed row put two keys on one row, they merge field by field
  const chosen = new Map();
  const reach = (tx, key, want) => {
    if (!tx) return;
    const had = chosen.get(tx);
    chosen.set(tx, had ? { key: had.key <= key ? had.key : key, want: mergeEntry(had.want, want, MOVE_FIELDS, true) } : { key, want });
  };
  for (const key of keys.sort()) {
    const want = entries[key];
    const tx = find(key, want);
    reach(tx, key, want);
    if (want.from !== undefined && Object.hasOwn(entries, want.from)) {
      // the entry it continues reaches this row too, and this one reaches that entry's row
      const older = entries[want.from];
      reach(tx, want.from, older);
      reach(find(want.from, older), key, want);
    }
  }
  let changed = false;
  for (const [tx, { key, want }] of chosen) {
    remember(state, tx.id, key);
    const locks = Array.isArray(tx.locks) ? tx.locks : [];
    const live = liveOf(want);
    const dead = deadOf(want).filter((field) => locks.includes(field));
    const set = {};
    for (const field of Object.keys(live)) if (!locks.includes(field) || canon(tx[field]) !== canon(live[field])) set[field] = live[field];
    if (dead.length) {
      tx.locks = locks.filter((field) => !dead.includes(field));
      // a deposit whose category goes back to the rules is read again as a device that never held the correction
      // reads it: it keeps its link when classification without the merchant rule's category files it as income
      if (dead.includes('category') && tx.streamId != null) {
        // the rule that files this row's category (of its direction, 3.3)
        const view = ruleOfRow(state, tx);
        const id = view && view.category != null ? learnedIdOf(view) : null;
        const rule = id ? listOf(isObject(state.settings) ? state.settings.rules : null).find((one) => isObject(one) && learnedIdOf(one) === id) : null;
        refileRows(state, [tx], rule || null);
      }
      changed = true;
    }
    // a category the row's frozen kind cannot follow (a deposit linked to a stream, a paired leg): the device that made
    // the correction held the row free, so the link goes first, as for a category taken back, and the row takes it
    if (set.category !== undefined && (tx.streamId != null || tx.pairId != null) && tx.kind !== 'decline' && !locks.includes('kind')) {
      const kind = kindOf(set.category, tx.flow);
      if (kind !== null && kind !== tx.kind) {
        unlink(state, tx);
        changed = true;
      }
    }
    if (Object.keys(set).length && learnRule(state, tx.id, set, { onlyThis: true }).changed) changed = true;
  }
  return changed;
}

/** The kind a category gives a row moving `flow` (classify's own reading); null when it gives none. */
function kindOf(category, flow) {
  if (category === 'transfer') return 'transfer';
  if (category === 'card_payment') return 'payment';
  if (category === 'income') return flow === 'in' ? 'income' : null;
  return Object.hasOwn(CATEGORIES, category) ? (flow === 'in' ? 'refund' : 'spend') : null;
}

/** A row let go of its stream and of the leg it was paired with (the other leg too), as merge does for a row that goes. */
function unlink(state, tx) {
  tx.streamId = null;
  if (tx.pairId == null) return;
  for (const other of listOf(state.txs)) if (isObject(other) && other !== tx && other.pairId === tx.id) other.pairId = null;
  tx.pairId = null;
}

function applyStreams(state, entries) {
  const keys = Object.keys(entries);
  if (!keys.length) return false;
  const accounts = accountKeys(state);
  const byKey = new Map();
  for (const stream of listOf(state.streams)) {
    const key = streamKeyOf(stream, accounts);
    if (!key) continue;
    const have = byKey.get(key);
    if (!have || (have.active === false && stream.active !== false)) byKey.set(key, stream);
  }
  let changed = false;
  for (const key of keys) {
    const stream = byKey.get(key);
    if (!stream) continue;
    const live = liveOf(entries[key]);
    const dead = deadOf(entries[key]);
    if (!Array.isArray(stream.locks)) stream.locks = [];
    for (const field of STREAM_FIELDS) {
      const locked = stream.locks.includes(field);
      if (Object.hasOwn(live, field)) {
        if (stream[field] !== live[field]) { stream[field] = live[field]; changed = true; }
        if (!locked) { stream.locks.push(field); changed = true; }
      } else if (locked && dead.includes(field)) {
        stream.locks = stream.locks.filter((one) => one !== field);
        changed = true;
      }
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ helpers */

function blank() {
  return { rules: {}, moves: {}, streams: {} };
}

function isMerchantKey(key) {
  return MERCHANT_KEY.test(key);
}

function isRuleKey(key) {
  return RULE_KEY.test(key);
}

/** A rule's key in this device's copy: its merchant's, then the direction it covers (none for a rule made before rules had one). */
function ruleKeyOf(merchant, flow) {
  return flow === 'out' || flow === 'in' ? merchant + ':' + flow : merchant;
}

/** The merchant and the direction a rule's key names (direction null: both). */
function ruleKeyParts(key) {
  const at = key.indexOf(':');
  return at < 0 ? { merchant: key, flow: null } : { merchant: key.slice(0, at), flow: key.slice(at + 1) };
}

function isRowKey(key) {
  return ROW_KEY.test(key);
}

function isStreamKey(key) {
  return STREAM_KEY.test(key);
}

function isText(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
    && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value); // no half of a pair: it is written as 6 characters
}

function isStamp(x) {
  return Number.isFinite(x) && x >= 0 && x <= MAX_STAMP;
}

function locksOf(item) {
  return new Set(Array.isArray(item.locks) ? item.locks : []);
}

function own(obj, key) {
  return isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
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

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}
