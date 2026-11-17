/**
 * The daily game reaches every device (ARCHITECTURE.md section 3.9): every choice of the owner behind the daily
 * budget and its figures travels in the shared file's known section `game`, so that every device plays the same
 * rounds against the same Habit and scores them the same way.
 *
 *   game: { settings?: { <name>: cell },                     workdays, rolloverHour, byesPerMonth, smoothing,
 *                                                            countPending, principles, insteads (each list one cell)
 *           purposes?: { <tag>: cell of its name }           each purpose tag on its own
 *           days?:     { <day>: { type?, bye?, note?, plan? } }   each a cell
 *           start?:    cell of { day, seg }                  the match's first day and its first segment
 *           habits?:   { <from>: cell of a segment }         every later segment (a stronger opponent seated)
 *           sweeps?:   { <weekOf>: cell of { amount, day } } the owner's own weekly transfers (Moved, Not this week)
 *         }
 *   a cell: { v, at } or { deleted: true, at }, with `undo: true` on a cell an Undo wrote.
 *
 * Merging is field by field: the later stamp wins; on an equal stamp an edit beats an Undo, then the smaller cell
 * written as JSON with sorted keys (a total order, so the merge is commutative, associative and idempotent). Then the
 * bounds, by the section's own content, never a clock: each kind of entry keeps up to its cap, the newest written first,
 * then the newest day; a seeded cell (stamp 0) more than 400 days before the newest day or week goes; the two newest
 * keys always stay, and the newest is left out of the line when it is more than 15 days after the next.
 *
 * On the device the record holds the values (`settings`, `days`, `meta.matchStart`, `habits`, `sweeps`) and
 * `share.game` holds the copy: every cell the device has made or taken in (never pruned, so a day the file no longer
 * carries is never noted again). The owner's changes are noted in the store's update hook (`noteGame`): whatever
 * differs between the record and the copy is stamped `max(round(now), at + 2)`; an Undo restamps 1 above
 * (`restampGame`). The match's start is never the owner's: it is stamped 0 wherever it is made, so two devices that
 * started the match apart meet on the earlier day (the canonical order of two cells at 0 reads the day first).
 * Sweeps detected from the bank (`via: 'auto'`) stay with each device, as its own readings made them (detect.js
 * detectSweeps), and can differ between devices (a known limit, 3.9); the owner's own (Moved, Not this week, Reopen)
 * travel and stand in place of one detected for the same week. A day, week or segment more than 30 days after the
 * newest of the bank's last row, the newest balance date the bank reported, the newest day the copy already holds (which
 * another device may have written) and the server's day of the last round (`share.serverAt`) is held back, and noted as
 * soon as the limit reaches it, the noting run again while the limit moves (a clock far ahead cannot write one, nor
 * move it).
 *
 * Pure: no clock (every stamp is handed in), no DOM, no storage. Imports: schema, dates.
 */

import { defaultState } from './schema.js';
import { addDays, feedDay, isYmd } from './dates.js';

const MAX_STAMP = 1e14;
/** A seeded day record or week (stamp 0) more than this many days before the line's day (the newest, an outlier aside) is not written. */
export const GAME_KEEP_DAYS = 400;
/**
 * How many of each the section keeps, the newest written first: what a file of this version holds at most (the two newest
 * days or weeks besides). The fields that change a round's result (its type, a bye) get the room: 60 byes cover 400 days
 * at the most Settings allows (4 a month).
 */
export const GAME_CAPS = { type: 150, bye: 60, plan: 30, note: 20, sweeps: 60, habits: 12 };
/** In the bounds, a newest key more than this many days past the next is left out of the line. */
export const GAME_AHEAD_DAYS = 15;
/**
 * A day, week or segment more than this many days after the noting limit's day (the newest bank row, balance date the bank
 * reported, day the copy holds or server's day of the last round) is held back until the limit reaches it: room for the
 * day sheet's 14 days ahead and a bank that has not posted for two weeks, while a clock far ahead writes nothing.
 */
export const GAME_NOTE_DAYS = 30;
/** What a reader of the file takes at most (a later version may keep more; this one keeps its own caps when it writes). */
const READ_MAX = { days: 500, sweeps: 200, habits: 60 };
/** The device's own copy and the sections this module builds are checked cell by cell, never refused for their length. */
const NO_MAX = { days: Infinity, sweeps: Infinity, habits: Infinity };
/** The longest note the day sheet takes (views/sheet-day.js NOTE_MAX). */
export const NOTE_MAX = 280;
const LINE_MAX = 120;
const LINES_MAX = 12;
const PURPOSE_MAX = 60;
const AMOUNT_MAX = 1e10;
const FIGURE_MAX = 1e12;
const COUNT_MAX = 1e6;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const SECTIONS = new Set(['settings', 'purposes', 'days', 'start', 'habits', 'sweeps']);
const PARTS = ['settings', 'purposes', 'days', 'start', 'habits', 'sweeps'];
export const GAME_SETTINGS = ['workdays', 'rolloverHour', 'byesPerMonth', 'smoothing', 'countPending', 'principles', 'insteads'];
const DAY_FIELDS = ['type', 'bye', 'note', 'plan'];
const DEFAULTS = defaultState(0).settings;
const PURPOSE_KEYS = Object.keys(DEFAULTS.purposes);
/** A value the record holds that cannot travel (left on the device, never noted as a removal). */
const UNFIT = Symbol('unfit');

/* ------------------------------------------------------------------ values */

const SETTING_VALUE = {
  workdays: (v) => (Array.isArray(v) && v.length <= 7 && v.every((d, i) => Number.isInteger(d) && d >= 0 && d <= 6 && (i === 0 || d > v[i - 1]))
    ? v.slice() : null),
  rolloverHour: (v) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : null),
  byesPerMonth: (v) => (Number.isInteger(v) && v >= 0 && v <= 31 ? v : null),
  smoothing: (v) => (typeof v === 'boolean' ? v : null),
  countPending: (v) => (typeof v === 'boolean' ? v : null),
  principles: (v) => linesOf(v),
  insteads: (v) => linesOf(v),
};

/** A purpose tag's name. */
const PURPOSE_VALUE = (v) => (isText(v, PURPOSE_MAX, false) ? v : null);

const DAY_VALUE = {
  type: (v) => (v === 'work' || v === 'off' ? v : null),
  bye: (v) => (v === true ? true : null),
  note: (v) => (isText(v, NOTE_MAX, true) ? v : null),
  plan: (v) => {
    if (!isObject(v) || !sameKeys(v, ['container', 'breakfast', 'stops', 'at'])) return null;
    const yn = (x) => x === true || x === false || x === null;
    if (!yn(v.container) || !yn(v.breakfast) || !isStamp(v.at)) return null;
    if (!(v.stops === null || (Number.isInteger(v.stops) && v.stops >= 0 && v.stops <= 9))) return null;
    return { container: v.container, breakfast: v.breakfast, stops: v.stops, at: v.at };
  },
};

function linesOf(v) {
  if (!Array.isArray(v) || v.length > LINES_MAX || !v.every((line) => isText(line, LINE_MAX, false))) return null;
  return v.slice();
}

/** A segment of Habit without its `from` (the key says it), every field this version knows, filled. */
function segmentOf(v) {
  if (!isObject(v)) return null;
  if (Object.keys(v).some((key) => !['from', 'work', 'off', 'winWork', 'winOff', 'basis', 'window', 'backtest'].includes(key))) return null;
  const figure = (x) => Number.isFinite(x) && x >= 0 && x <= FIGURE_MAX;
  const count = (x) => Number.isInteger(x) && x >= 0 && x <= COUNT_MAX;
  if (!figure(v.work) || !figure(v.off) || !figure(v.winWork) || !figure(v.winOff)) return null;
  const basis = v.basis === undefined ? 'computed' : v.basis;
  if (basis !== 'computed' && basis !== 'manual') return null;
  let window = null;
  if (v.window != null) {
    const w = v.window;
    if (!isObject(w) || !sameKeys(w, ['from', 'to', 'workDays', 'offDays']) || !isYmd(w.from) || !isYmd(w.to) || !count(w.workDays) || !count(w.offDays)) return null;
    window = { from: w.from, to: w.to, workDays: w.workDays, offDays: w.offDays };
  }
  let backtest = null;
  if (v.backtest != null) {
    const b = v.backtest;
    if (!isObject(b) || !sameKeys(b, ['score', 'rounds']) || !(Number.isFinite(b.score) && b.score >= 0 && b.score <= COUNT_MAX) || !count(b.rounds)) return null;
    backtest = { score: b.score, rounds: b.rounds };
  }
  return { work: v.work, off: v.off, winWork: v.winWork, winOff: v.winOff, basis, window, backtest };
}

function startOf(v) {
  if (!isObject(v) || !sameKeys(v, ['day', 'seg']) || !isYmd(v.day)) return null;
  const seg = segmentOf(v.seg);
  return seg ? { day: v.day, seg } : null;
}

function sweepOf(v) {
  if (!isObject(v) || !sameKeys(v, ['amount', 'day']) || !Number.isInteger(v.amount) || v.amount < 0 || v.amount > AMOUNT_MAX || !isYmd(v.day)) return null;
  return { amount: v.amount, day: v.day };
}

/* ------------------------------------------------------------------ reading */

/**
 * The section of a shared file, checked (untrusted input): the five parts above and nothing else, days and weeks
 * that are calendar days, known fields with values of their kind (a note of at most 280 characters, the owner's lines
 * of at most 120, no control character but a line break, no half of a surrogate pair), cells `{ v, at }` or
 * `{ deleted: true, at }` with `undo` true or false when present, stamps from 0 to 10^14, at most 500 days, 200 weeks
 * and 60 segments. Anything else is null and refuses the file. The result is a fresh copy of the checked fields.
 * @param {*} raw
 * @returns {object|null}
 */
export function readGame(raw) {
  return parseGame(raw, READ_MAX);
}

/** A section checked cell by cell, with at most `max` days, weeks and segments (none for what this device holds). */
function parseGame(raw, max) {
  if (!isObject(raw) || Object.keys(raw).some((key) => !SECTIONS.has(key))) return null;
  const out = {};
  if (raw.settings !== undefined) {
    if (!isObject(raw.settings)) return null;
    const settings = {};
    for (const name of Object.keys(raw.settings)) {
      if (!Object.hasOwn(SETTING_VALUE, name)) return null;
      const cell = cellOf(raw.settings[name], SETTING_VALUE[name], false);
      if (!cell) return null;
      settings[name] = cell;
    }
    out.settings = settings;
  }
  if (raw.purposes !== undefined) {
    if (!isObject(raw.purposes)) return null;
    const purposes = {};
    for (const tag of Object.keys(raw.purposes)) {
      if (!PURPOSE_KEYS.includes(tag)) return null;
      const cell = cellOf(raw.purposes[tag], PURPOSE_VALUE, false);
      if (!cell) return null;
      purposes[tag] = cell;
    }
    out.purposes = purposes;
  }
  if (raw.days !== undefined) {
    const days = mapOf(raw.days, max.days, (entry) => {
      if (!isObject(entry) || !Object.keys(entry).length) return null;
      const fields = {};
      for (const field of Object.keys(entry)) {
        if (!Object.hasOwn(DAY_VALUE, field)) return null;
        const cell = cellOf(entry[field], DAY_VALUE[field], true);
        if (!cell) return null;
        fields[field] = cell;
      }
      return fields;
    });
    if (!days) return null;
    out.days = days;
  }
  if (raw.start !== undefined) {
    const start = cellOf(raw.start, startOf, false);
    if (!start) return null;
    out.start = start;
  }
  if (raw.habits !== undefined) {
    const habits = mapOf(raw.habits, max.habits, (cell) => cellOf(cell, segmentOf, true));
    if (!habits) return null;
    out.habits = habits;
  }
  if (raw.sweeps !== undefined) {
    const sweeps = mapOf(raw.sweeps, max.sweeps, (cell) => cellOf(cell, sweepOf, true));
    if (!sweeps) return null;
    out.sweeps = sweeps;
  }
  return tidy(out);
}

function mapOf(raw, max, entryOf) {
  if (!isObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > max) return null;
  const out = {};
  for (const key of keys) {
    if (UNSAFE.has(key) || !isYmd(key)) return null;
    const entry = entryOf(raw[key]);
    if (!entry) return null;
    out[key] = entry;
  }
  return out;
}

/** One cell, checked: `{ v, at }` (v of its kind) or, where a field may be taken back, `{ deleted: true, at }`; `undo` kept when true. */
function cellOf(raw, valueOf, removable) {
  if (!isObject(raw) || !isStamp(raw.at)) return null;
  if (raw.undo !== undefined && typeof raw.undo !== 'boolean') return null;
  const undo = raw.undo === true;
  if (raw.deleted !== undefined) {
    if (raw.deleted !== true || !removable || !sameKeys(raw, ['deleted', 'at', 'undo'])) return null;
    return undo ? { deleted: true, at: raw.at, undo: true } : { deleted: true, at: raw.at };
  }
  if (!sameKeys(raw, ['v', 'at', 'undo']) || !Object.hasOwn(raw, 'v')) return null;
  const v = valueOf(raw.v);
  if (v === null) return null;
  return undo ? { v, at: raw.at, undo: true } : { v, at: raw.at };
}

/** True when a section holds nothing. */
export function isBlankGame(section) {
  return !isObject(section) || Object.keys(tidy(section)).length === 0;
}

/* ------------------------------------------------------------------ merging */

/**
 * Two sections into one: field by field the later cell (`joinGame`), then the bounds (`pruneGame`). Either side may be
 * absent or unreadable (read as empty). Commutative, associative and idempotent, the bounds included.
 * @returns {object}
 */
export function mergeGame(a, b) {
  return pruneGame(joinGame(a, b));
}

/** Two sections into one, field by field, with no bound (the device's own copy is kept whole). */
function joinGame(a, b) {
  const x = sectionOf(a);
  const y = sectionOf(b);
  const out = {};
  out.settings = joinMap(x.settings, y.settings, laterCell);
  out.purposes = joinMap(x.purposes, y.purposes, laterCell);
  out.days = joinMap(x.days, y.days, (p, q) => (!p ? q : !q ? p : joinMap(p, q, laterCell)));
  const start = laterCell(x.start || null, y.start || null);
  if (start) out.start = start;
  out.habits = joinMap(x.habits, y.habits, laterCell);
  out.sweeps = joinMap(x.sweeps, y.sweeps, laterCell);
  return tidy(out);
}

function joinMap(a, b, pick) {
  const x = a || {};
  const y = b || {};
  const out = {};
  for (const key of union(x, y)) out[key] = pick(own(x, key) || null, own(y, key) || null);
  return out;
}

/**
 * The bounds, drawn by the section's own content alone (never a clock), so every device draws the same: each field of
 * the days keeps up to its cap (type 150, bye 60, plan 30, note 20), the weeks 60 and the later segments 12, ranked by the
 * cell's stamp (the newest written first, so a fresh edit of an older day is written), then by the newest day. A seeded
 * cell (stamp 0) of a day or week more than 400 days before the line's day goes. The line's day is the newest day or week,
 * unless it is more than 15 days after the next newest (an outlier: then the next newest). The two newest keys always
 * stay, so the line is drawn again the same way, and pruning again changes nothing. Written cells are bounded by the caps
 * alone: ranked by stamp, a line by day would let a sub-merge keep what the whole merge drops (the merge laws).
 * @param {object} section  (checked)
 * @returns {object} a fresh section
 */
export function pruneGame(section) {
  const game = sectionOf(section);
  const days = game.days || {};
  const sweeps = game.sweeps || {};
  const keys = union(days, sweeps).reverse();
  const anchors = new Set(keys.slice(0, 2));
  const reference = keys.length > 1 && keys[0] > addDays(keys[1], GAME_AHEAD_DAYS) ? keys[1] : keys[0];
  const line = reference ? addDays(reference, -GAME_KEEP_DAYS) : null;
  const out = { ...game };
  const kept = {};
  for (const field of DAY_FIELDS) {
    const holding = Object.keys(days).filter((day) => Object.hasOwn(days[day], field));
    for (const day of capped(holding, (day) => days[day][field], GAME_CAPS[field], line, anchors)) (kept[day] || (kept[day] = {}))[field] = days[day][field];
  }
  out.days = {};
  for (const day of Object.keys(kept).sort()) out.days[day] = ordered(kept[day], DAY_FIELDS);
  out.sweeps = picked(sweeps, capped(Object.keys(sweeps), (key) => sweeps[key], GAME_CAPS.sweeps, line, anchors));
  const habits = game.habits || {};
  out.habits = picked(habits, capped(Object.keys(habits), (key) => habits[key], GAME_CAPS.habits, null, new Set()));
  return tidy(out);
}

/**
 * The keys a cap keeps: of the keys written (stamp above 0) or on or after the line, the newest written first, then the
 * newest key, up to the cap; and the anchors.
 */
function capped(keys, cellAt, cap, line, anchors) {
  const ranked = keys.filter((key) => line === null || key >= line || cellAt(key).at > 0)
    .sort((p, q) => (cellAt(q).at - cellAt(p).at) || (p < q ? 1 : p > q ? -1 : 0));
  const out = new Set(ranked.slice(0, cap));
  for (const key of keys) if (anchors.has(key)) out.add(key);
  return out;
}

function picked(map, keys) {
  const out = {};
  for (const key of [...keys].sort()) out[key] = map[key];
  return out;
}

/** The cell that wins: the later stamp; on the same stamp an edit before an Undo's cell; then the smaller canonical form. */
function laterCell(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p.at !== q.at) return p.at > q.at ? p : q;
  if (!!p.undo !== !!q.undo) return p.undo ? q : p;
  return canon(p) <= canon(q) ? p : q;
}

/* ------------------------------------------------------------------ the device */

/**
 * What the record holds of the game, as the section would say it. A value that cannot travel is UNFIT (left alone).
 * @returns {{ settings: object, days: object, start: object|null, habits: object, sweeps: object, matchStart: string|null }}
 */
function recordValues(state) {
  const doc = isObject(state) ? state : {};
  const settings = {};
  const s = isObject(doc.settings) ? doc.settings : {};
  for (const name of GAME_SETTINGS) {
    if (!Object.hasOwn(s, name)) continue;
    // the weekdays in order and once each, as Settings writes them
    const raw = name === 'workdays' && Array.isArray(s.workdays) ? [...new Set(s.workdays)].sort((a, b) => a - b) : s[name];
    const v = SETTING_VALUE[name](raw);
    settings[name] = v === null ? UNFIT : v;
  }
  // each purpose tag this version knows, its default name when the record has none
  const purposes = {};
  for (const tag of PURPOSE_KEYS) {
    const raw = isObject(s.purposes) && Object.hasOwn(s.purposes, tag) ? s.purposes[tag] : DEFAULTS.purposes[tag];
    const v = PURPOSE_VALUE(raw);
    purposes[tag] = v === null ? UNFIT : v;
  }
  const days = {};
  const recordDays = isObject(doc.days) ? doc.days : {};
  for (const day of Object.keys(recordDays)) {
    const record = recordDays[day];
    if (!isYmd(day) || !isObject(record)) continue;
    const fields = {};
    for (const field of DAY_FIELDS) {
      const raw = record[field];
      if (raw === undefined || raw === null || raw === false || raw === '') continue;
      const v = DAY_VALUE[field](raw);
      fields[field] = v === null ? UNFIT : v;
    }
    if (Object.keys(fields).length) days[day] = fields;
  }
  const meta = isObject(doc.meta) ? doc.meta : {};
  const matchStart = isYmd(meta.matchStart) ? meta.matchStart : null;
  const segments = Array.isArray(doc.habits) ? doc.habits.filter((seg) => isObject(seg) && isYmd(seg.from)) : [];
  let start = null;
  const first = matchStart ? segments.find((seg) => seg.from === matchStart) : null;
  if (first) start = startOf({ day: matchStart, seg: first }) || UNFIT;
  const habits = {};
  for (const seg of segments) {
    if (seg.from === matchStart) continue;
    const v = segmentOf(seg);
    habits[seg.from] = v === null ? UNFIT : v;
  }
  const sweeps = {};
  for (const sweep of Array.isArray(doc.sweeps) ? doc.sweeps : []) {
    if (!isOwnSweep(sweep) || Object.hasOwn(sweeps, sweep.weekOf)) continue;
    const v = sweepOf({ amount: sweep.amount, day: sweep.day });
    sweeps[sweep.weekOf] = v === null ? UNFIT : v;
  }
  return { settings, purposes, days, start, habits, sweeps, matchStart };
}

/**
 * The last day a key may be noted on (null: any day): 30 days after the newest of the record's newest bank row, the newest
 * balance date the bank reported (a bank account's balance dated before the reading that carried it: one the bank gave no
 * date for is dated at the fetch, by the device's clock, and is never one), the newest day `copy` holds (a merged
 * section, which another device may have written) and the server's day (`share.serverAt`, the time GitHub answered the
 * last round with: it keeps moving while the bank link is stale). No device clock is read, so a clock far ahead neither
 * writes a far day nor moves the limit, for itself or the others: what it holds back never reaches a copy.
 * @param {object} state
 * @param {object|null} copy  (checked)
 * @returns {string|null}
 */
function limitOf(state, copy) {
  const doc = isObject(state) ? state : {};
  let newest = '';
  for (const tx of Array.isArray(doc.txs) ? doc.txs : []) if (isObject(tx) && isYmd(tx.day) && tx.source !== 'manual' && tx.day > newest) newest = tx.day;
  const rollover = rolloverOf(doc);
  const served = serverDay(doc, rollover);
  if (served && served > newest) newest = served;
  for (const account of Array.isArray(doc.accounts) ? doc.accounts : []) {
    if (!isObject(account) || account.source !== 'bank' || !isObject(account.feed)) continue;
    const { asOf } = account;
    const readAt = account.feed.readAt;
    if (!Number.isFinite(asOf) || asOf <= 0 || !Number.isFinite(readAt) || asOf >= readAt) continue;
    const day = feedDay(asOf / 1000, rollover);
    if (isYmd(day) && day > newest) newest = day;
  }
  for (const day of Object.keys((copy && copy.days) || {})) if (day > newest) newest = day;
  return newest ? addDays(newest, GAME_NOTE_DAYS) : null;
}

/** The day of the server's time the device last heard (`share.serverAt`), or '' when it has none. */
function serverDay(doc, rollover) {
  const at = isObject(doc.share) ? doc.share.serverAt : null;
  if (!Number.isFinite(at) || at <= 0 || at > MAX_STAMP) return '';
  const day = feedDay(at / 1000, rollover);
  return isYmd(day) ? day : '';
}

/**
 * Keep the server's time a round heard (`share.js` roundShared: the time GitHub answered with), in the device's share
 * state: it is the device's own, never written to the file. Only a later day is kept, so a round on the same day changes
 * nothing and an earlier time never moves it back.
 * @param {object} state  (mutated)
 * @param {number} serverMs
 * @returns {boolean} true when it was kept (the noting limit may have moved)
 */
export function hearServer(state, serverMs) {
  if (!hearsServer(state, serverMs)) return false;
  if (!isObject(state.share)) state.share = { tombs: {} };
  state.share.serverAt = Math.round(serverMs);
  return true;
}

/** Whether `hearServer` would keep this time: a later day than the one held. */
export function hearsServer(state, serverMs) {
  if (!isObject(state) || !Number.isFinite(serverMs) || serverMs <= 0 || serverMs > MAX_STAMP) return false;
  const rollover = rolloverOf(state);
  const day = feedDay(serverMs / 1000, rollover);
  return isYmd(day) && day > serverDay(state, rollover);
}

/** The record's rollover hour (midnight when it is not an hour of the day). */
function rolloverOf(doc) {
  const settings = isObject(doc.settings) ? doc.settings : {};
  return Number.isInteger(settings.rolloverHour) && settings.rolloverHour >= 0 && settings.rolloverHour <= 23 ? settings.rolloverHour : 0;
}

/** The day the device notes up to: the noting limit of its record and its copy (null: any day). */
export function gameLimit(state) {
  return limitOf(state, hasCopy(state) ? sectionOf(state.share.game) : null);
}

/** A key within what may be noted: on or before the limit (any key when there is none). */
function within(limit, key) {
  return limit === null || key <= limit;
}

/** A transfer the owner recorded (Moved or Not this week), as against one detected from the bank (`via: 'auto'`). */
function isOwnSweep(sweep) {
  return isObject(sweep) && sweep.via === 'tap' && isYmd(sweep.weekOf);
}

/**
 * The section seeded from what the record holds, every cell at 0: the settings that differ from the defaults, every day
 * record, the match's start, every later segment and every transfer the owner recorded.
 * @param {object} state
 * @returns {object}
 */
export function seedsOf(state) {
  const values = recordValues(state);
  const limit = limitOf(state, null);
  const out = { settings: {}, purposes: {}, days: {}, habits: {}, sweeps: {} };
  for (const name of Object.keys(values.settings)) {
    const v = values.settings[name];
    if (v !== UNFIT && canon(v) !== canon(DEFAULTS[name])) out.settings[name] = { v, at: 0 };
  }
  // a purpose tag only where its name differs from its default, so a rename on one device is the only cell and wins
  for (const tag of Object.keys(values.purposes)) {
    const v = values.purposes[tag];
    if (v !== UNFIT && v !== DEFAULTS.purposes[tag]) out.purposes[tag] = { v, at: 0 };
  }
  for (const day of Object.keys(values.days)) {
    if (!within(limit, day)) continue;
    const fields = {};
    for (const field of DAY_FIELDS) {
      const v = values.days[day][field];
      if (v !== undefined && v !== UNFIT) fields[field] = { v, at: 0 };
    }
    if (Object.keys(fields).length) out.days[day] = fields;
  }
  if (values.start && values.start !== UNFIT) out.start = { v: values.start, at: 0 };
  for (const [name, map] of [['habits', values.habits], ['sweeps', values.sweeps]]) {
    for (const key of Object.keys(map)) if (map[key] !== UNFIT && within(limit, key)) out[name][key] = { v: map[key], at: 0 };
  }
  return sectionOf(tidy(out));
}

/**
 * When the record has no copy yet (the first load of this version), make it from what the record holds, at 0, before
 * the owner can change anything (app.js, at boot). The copy is saved with the next change. The weeks detected from the
 * bank are left as they are.
 * @param {object} state  (mutated)
 * @returns {boolean} true when a copy was made
 */
export function seedGame(state) {
  if (!isObject(state) || hasCopy(state)) return false;
  storeCopy(state, seedsOf(state));
  return true;
}

/** The device's copy (the seeds when it has none yet). */
export function storedGame(state) {
  return hasCopy(state) ? sectionOf(state.share.game) : seedsOf(state);
}

/**
 * The section as this device writes it: its copy, within the bounds.
 * @param {object} state
 * @returns {object}
 */
export function exportGame(state) {
  return pruneGame(storedGame(state));
}

/**
 * Note what the owner changed (the store's update hook, after every change, in the same step): every field whose value
 * in the record differs from the copy is stamped above the stamp it replaces, `max(round(now), at + 2)`; a field taken
 * back is written as `{ deleted: true, at }`. A setting is compared with the default when no cell holds it. The match's
 * start, which the bank's first reading makes, is stamped 0 (and when the copy already holds an earlier start, the
 * record takes that one). A value that cannot travel is left on the device. Nothing changes when the record agrees.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {boolean} true when anything was noted
 */
export function noteGame(state, nowMs) {
  if (!isObject(state)) return false;
  if (!hasCopy(state)) seedGame(state);
  const values = recordValues(state);
  const now = Math.round(Number.isFinite(nowMs) ? nowMs : 0);
  let copy = sectionOf(state.share.game);
  let noted = false;
  // A key noted can move the limit (the newest day the copy holds), so the pass runs again until the limit stands: a
  // choice within the limit releases the others in the same update. Bounded by the keys, as the limit only moves forward.
  for (let limit = limitOf(state, copy); ;) {
    const pass = notePass(copy, values, limit, now);
    if (!pass) break;
    noted = true;
    copy = pass;
    const next = limitOf(state, copy);
    if (next === limit) break;
    limit = next;
  }
  const start = copy.start || null;
  if (!noted) {
    if (start && canon(start.v) !== canon(values.start)) syncStart(state, start);
    return false;
  }
  storeCopy(state, copy);
  if (start && canon(start.v) !== canon(values.start)) syncStart(state, start);
  return true;
}

/**
 * One noting pass (noteGame): the copy with every field noted whose value in the record differs from it, the keys after
 * `limit` left as they are; null when nothing differs.
 */
function notePass(copy, values, limit, now) {
  const stamp = (cell) => Math.min(MAX_STAMP, Math.max(now, (cell ? cell.at : 0) + 2));
  let noted = false;
  const settings = { ...(copy.settings || {}) };
  for (const name of Object.keys(values.settings)) {
    const v = values.settings[name];
    if (v === UNFIT) continue;
    const cell = own(settings, name);
    if (canon(v) === canon(cell ? cell.v : DEFAULTS[name])) continue;
    settings[name] = { v, at: stamp(cell) };
    noted = true;
  }
  const purposes = { ...(copy.purposes || {}) };
  for (const tag of Object.keys(values.purposes)) {
    const v = values.purposes[tag];
    if (v === UNFIT) continue;
    const cell = own(purposes, tag);
    if (v === (cell ? cell.v : DEFAULTS.purposes[tag])) continue;
    purposes[tag] = { v, at: stamp(cell) };
    noted = true;
  }
  const note = (map, key, v) => {
    // one field of a map: the record's value (undefined: none) against the copy's cell
    if (v === UNFIT) return map;
    const cell = own(map, key);
    const held = cell && !cell.deleted ? cell.v : undefined;
    if (canon(v) === canon(held)) return map;
    if (v === undefined && (!cell || cell.deleted)) return map;
    noted = true;
    return { ...map, [key]: v === undefined ? { deleted: true, at: stamp(cell) } : { v, at: stamp(cell) } };
  };
  const days = { ...(copy.days || {}) };
  for (const day of union(values.days, days)) {
    if (!within(limit, day)) continue;
    let fields = own(days, day) || {};
    for (const field of DAY_FIELDS) fields = note(fields, field, own(values.days[day] || {}, field));
    if (Object.keys(fields).length) days[day] = fields;
  }
  let habits = { ...(copy.habits || {}) };
  const startDay = copy.start ? copy.start.v.day : values.matchStart;
  for (const key of union(values.habits, habits)) {
    if (key === startDay || key === values.matchStart || !within(limit, key)) continue;
    habits = note(habits, key, own(values.habits, key));
  }
  let sweeps = { ...(copy.sweeps || {}) };
  for (const key of union(values.sweeps, sweeps)) if (within(limit, key)) sweeps = note(sweeps, key, own(values.sweeps, key));
  let start = copy.start || null;
  if (values.start && values.start !== UNFIT && (!start || canon(start.v) !== canon(values.start))) {
    const won = laterCell(start, { v: values.start, at: 0 });
    if (won !== start) noted = true;
    start = won;
  }
  return noted ? tidy({ settings, purposes, days, start, habits, sweeps }) : null;
}

/**
 * Undo of the owner's own change (`store.onRestore`, beside restampByHand and restampCorrections): the copy put back is
 * the copy before the Undo joined with the copy of the record put back, so no stamp an earlier Undo wrote is lost; then
 * every field whose value differs between the two records is given the value put back, or taken back when the record
 * put back has none, stamped 1 above the highest stamp either copy holds for it and marked `undo: true`. The match's
 * start is never undone: the record put back takes the start the copy holds.
 * @param {object} before  the record just before the Undo
 * @param {object} after   the record put back (mutated)
 * @returns {boolean} true when a field was restamped
 */
export function restampGame(before, after) {
  if (!isObject(before) || !isObject(after)) return false;
  const was = recordValues(before);
  const now = recordValues(after);
  const section = joinGame(storedGame(before), storedGame(after));
  const bump = (cell) => Math.min(MAX_STAMP, (cell ? cell.at : 0) + 1);
  let wrote = false;
  const restamp = (map, key, prior, value) => {
    if (prior === UNFIT || value === UNFIT) return map;
    if (canon(prior) === canon(value)) return map;
    const cell = own(map, key);
    wrote = true;
    return { ...map, [key]: value === undefined ? { deleted: true, at: bump(cell), undo: true } : { v: value, at: bump(cell), undo: true } };
  };
  let settings = section.settings || {};
  for (const name of GAME_SETTINGS) {
    const prior = own(was.settings, name);
    const value = own(now.settings, name);
    if (prior === undefined || value === undefined) continue;
    settings = restamp(settings, name, prior, value);
  }
  let purposes = section.purposes || {};
  for (const tag of PURPOSE_KEYS) purposes = restamp(purposes, tag, was.purposes[tag], now.purposes[tag]);
  let out = tidy({ ...section, settings, purposes });
  const startDay = section.start ? section.start.v.day : null;
  // A key restamped can move the limit (the newest day the copy holds), so the pass runs again over the keys the moved
  // limit lets through, until it stands (each key once; bounded, as the limit only moves forward).
  let done; // the limit of the passes run so far (undefined: none yet)
  for (let limit = limitOf(after, out); ;) {
    const fresh = (key) => within(limit, key) && (done === undefined || key > done);
    const days = { ...(out.days || {}) };
    for (const day of union(was.days, now.days)) {
      if (!fresh(day)) continue;
      let fields = own(days, day) || {};
      for (const field of DAY_FIELDS) fields = restamp(fields, field, own(was.days[day] || {}, field), own(now.days[day] || {}, field));
      if (Object.keys(fields).length) days[day] = fields;
    }
    let habits = out.habits || {};
    for (const key of union(was.habits, now.habits)) {
      if (key === startDay || key === was.matchStart || key === now.matchStart || !fresh(key)) continue;
      habits = restamp(habits, key, own(was.habits, key), own(now.habits, key));
    }
    let sweeps = out.sweeps || {};
    for (const key of union(was.sweeps, now.sweeps)) if (fresh(key)) sweeps = restamp(sweeps, key, own(was.sweeps, key), own(now.sweeps, key));
    out = tidy({ ...out, days, habits, sweeps });
    const next = limitOf(after, out);
    if (limit === null || next === limit) break;
    done = limit;
    limit = next;
  }
  storeCopy(after, out);
  if (out.start && canon(out.start.v) !== canon(now.start)) syncStart(after, out.start);
  return wrote;
}

/**
 * Whether bringing the device to `section` (a merged one) would change its copy: a cell the copy lacks or loses to.
 * @returns {boolean}
 */
export function gameDiffers(state, section) {
  const copy = storedGame(state);
  return canon(joinGame(copy, section)) !== canon(copy);
}

/**
 * Bring the device to `section` (a merged one): the copy takes every cell that wins over its own, and the record
 * follows the copy exactly as the owner's actions write it: a setting is set; a day's type, exempt day (bye), note and
 * plan are set or taken back, and a day record left empty goes; the match's start and first segment are the start's;
 * a later segment is seated or removed; a week the owner recorded is recorded (in place of one detected from the bank)
 * or opened again. Results and figures then follow by derivation; the weeks detected from the bank stay as this
 * device's readings made them.
 * @param {object} state  (mutated)
 * @param {object} section
 * @returns {boolean} true when anything changed
 */
export function applyGame(state, section) {
  if (!isObject(state)) return false;
  if (!gameDiffers(state, section) && hasCopy(state)) return false;
  const copy = joinGame(storedGame(state), section);
  storeCopy(state, copy);
  syncRecord(state, copy);
  return true;
}

/**
 * The cells of `merged` that differ from this device's own (`local`): what arrived from the other devices, for the
 * earlier copies Undo keeps (the `past` path, 3.4), so that an Undo never takes it back.
 * @returns {object}
 */
export function arrivedGame(local, merged) {
  const x = sectionOf(local);
  const y = sectionOf(merged);
  const out = { settings: {}, purposes: {}, days: {}, habits: {}, sweeps: {} };
  const differs = (p, q) => canon(p || null) !== canon(q || null);
  for (const name of Object.keys(y.settings || {})) if (differs(own(x.settings || {}, name), y.settings[name])) out.settings[name] = y.settings[name];
  for (const tag of Object.keys(y.purposes || {})) if (differs(own(x.purposes || {}, tag), y.purposes[tag])) out.purposes[tag] = y.purposes[tag];
  for (const day of Object.keys(y.days || {})) {
    const mine = own(x.days || {}, day) || {};
    for (const field of Object.keys(y.days[day])) {
      if (differs(own(mine, field), y.days[day][field])) (out.days[day] || (out.days[day] = {}))[field] = y.days[day][field];
    }
  }
  if (y.start && differs(x.start, y.start)) out.start = y.start;
  for (const name of ['habits', 'sweeps']) {
    for (const key of Object.keys(y[name] || {})) if (differs(own(x[name] || {}, key), y[name][key])) out[name][key] = y[name][key];
  }
  return tidy(out);
}

/* ------------------------------------------------------------------ the record follows the copy */

function syncRecord(state, copy) {
  if (!isObject(state.settings)) state.settings = {};
  for (const name of Object.keys(copy.settings || {})) {
    const v = copy.settings[name].v;
    if (canon(state.settings[name]) !== canon(v)) state.settings[name] = clone(v);
  }
  const tags = Object.keys(copy.purposes || {});
  if (tags.length) {
    const names = isObject(state.settings.purposes) ? state.settings.purposes : {};
    if (tags.some((tag) => names[tag] !== copy.purposes[tag].v)) {
      state.settings.purposes = { ...names };
      for (const tag of tags) state.settings.purposes[tag] = copy.purposes[tag].v;
    }
  }
  if (!isObject(state.days)) state.days = {};
  for (const day of Object.keys(copy.days || {})) {
    const cells = copy.days[day];
    const record = isObject(state.days[day]) ? state.days[day] : {};
    for (const field of DAY_FIELDS) {
      const cell = own(cells, field);
      if (!cell) continue;
      if (cell.deleted) delete record[field];
      else if (canon(record[field]) !== canon(cell.v)) record[field] = clone(cell.v);
    }
    if (Object.keys(record).length) state.days[day] = record;
    else delete state.days[day];
  }
  if (copy.start) syncStart(state, copy.start);
  syncHabits(state, copy);
  syncSweeps(state, copy);
}

/** The match's first day and its first segment, as the start says; the segment the record began with goes. */
function syncStart(state, start) {
  if (!isObject(state.meta)) state.meta = {};
  const was = isYmd(state.meta.matchStart) ? state.meta.matchStart : null;
  const day = start.v.day;
  const list = Array.isArray(state.habits) ? state.habits : [];
  const first = list.find((seg) => isObject(seg) && seg.from === day);
  if (was === day && first && canon(segmentOf(first)) === canon(start.v.seg)) return;
  const habits = (Array.isArray(state.habits) ? state.habits : []).filter((seg) => !(isObject(seg) && (seg.from === was || seg.from === day)));
  habits.push({ from: day, ...clone(start.v.seg) });
  state.meta.matchStart = day;
  state.habits = sortedSegments(habits);
}

function syncHabits(state, copy) {
  const cells = copy.habits || {};
  if (!Object.keys(cells).length) return;
  const startDay = isObject(state.meta) && isYmd(state.meta.matchStart) ? state.meta.matchStart : null;
  const byDay = new Map();
  for (const seg of Array.isArray(state.habits) ? state.habits : []) if (isObject(seg)) byDay.set(seg.from, seg);
  for (const key of Object.keys(cells)) {
    if (key === startDay) continue;
    const cell = cells[key];
    if (cell.deleted) byDay.delete(key);
    else if (!byDay.has(key) || canon(segmentOf(byDay.get(key))) !== canon(cell.v)) byDay.set(key, { from: key, ...clone(cell.v) });
  }
  const next = sortedSegments([...byDay.values()]);
  if (canon(next) !== canon(state.habits)) state.habits = next;
}

function syncSweeps(state, copy) {
  const cells = copy.sweeps || {};
  if (!Object.keys(cells).length) return;
  let sweeps = Array.isArray(state.sweeps) ? state.sweeps.slice() : [];
  let changed = false;
  for (const weekOf of Object.keys(cells)) {
    const cell = cells[weekOf];
    const mine = sweeps.find((sweep) => isOwnSweep(sweep) && sweep.weekOf === weekOf);
    if (cell.deleted) {
      // opened again: the owner's entry goes, as sweep.reopen takes it (one detected from the bank stays)
      if (mine) { sweeps = sweeps.filter((sweep) => !(isOwnSweep(sweep) && sweep.weekOf === weekOf)); changed = true; }
      continue;
    }
    const alone = sweeps.filter((sweep) => isObject(sweep) && sweep.weekOf === weekOf).length === 1;
    if (mine && alone && mine.amount === cell.v.amount && mine.day === cell.v.day && mine.txId == null) continue;
    // the owner's word for the week stands in place of whatever this device recorded or detected for it
    sweeps = sweeps.filter((sweep) => !(isObject(sweep) && sweep.weekOf === weekOf));
    sweeps.push({ weekOf, amount: cell.v.amount, day: cell.v.day, txId: null, via: 'tap' });
    changed = true;
  }
  if (changed) state.sweeps = sweeps;
}

function sortedSegments(list) {
  return list.slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/* ------------------------------------------------------------------ helpers */

/** A section this device holds or built, checked cell by cell with no limit of length; absent or unreadable is empty. */
function sectionOf(raw) {
  return parseGame(raw === undefined || raw === null ? {} : raw, NO_MAX) || {};
}

function hasCopy(state) {
  return isObject(state) && isObject(state.share) && isObject(state.share.game);
}

function storeCopy(state, section) {
  if (!isObject(state.share)) state.share = { tombs: {} };
  state.share.game = tidy(section);
}

/** The section without its empty parts, its keys in order. */
function tidy(section) {
  const out = {};
  for (const key of PARTS) {
    const part = section[key];
    if (part === undefined || part === null) continue;
    if (key === 'start') { out.start = part; continue; }
    if (!isObject(part) || !Object.keys(part).length) continue;
    const sorted = {};
    for (const k of Object.keys(part).sort()) sorted[k] = part[k];
    out[key] = sorted;
  }
  return out;
}

function ordered(entry, keys) {
  const out = {};
  for (const key of keys) if (Object.hasOwn(entry, key)) out[key] = entry[key];
  return out;
}

function isText(v, max, lines) {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || v !== v.trim()) return false;
  // no control character (a line break or a tab in a note is one the owner typed), no half of a surrogate pair
  if ((lines ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v)) return false;
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(v);
}

function sameKeys(obj, allowed) {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

function isStamp(x) {
  return Number.isFinite(x) && x >= 0 && x <= MAX_STAMP;
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function own(obj, key) {
  return isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function union(a, b) {
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
}

function clone(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

/** JSON with sorted keys: equal content gives equal text. */
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (isObject(x)) return '{' + Object.keys(x).sort().map((key) => JSON.stringify(key) + ':' + canon(x[key])).join(',') + '}';
  return x === undefined ? 'null' : JSON.stringify(x);
}
