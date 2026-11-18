/**
 * The owner's decisions on money in and out reach every device (ARCHITECTURE.md section 3.11): the shared file's known
 * section `flows`, in the pattern of the daily game's (3.9).
 *
 *   flows: { since?:   'YYYY-MM-DD'                           the shared floor: the latest first day on record of any device
 *            lines?:   { l<13 hex>: { p, cad, amt, dom, sub?, verdict?, active? } }   decisions on a Book line
 *            added?:   { a<13 hex>: cell of { name, amount, cadence, day, category, sub, p? } }   lines added by hand
 *            targets?: { <category>: cell of cents }          monthly targets
 *            inlets?:  { n<13 hex>: { name?, kind?, goal?, focus?, gone?, removed? } }   the owner's sources (pass 3)
 *            into?:    { <p|r|i|f|q><13 hex>: cell of an inlet id, '-' or '?' (with day on i, f and q, and fp on i) }
 *            offers?:  { <p|r|s><13 hex>: cell of false }       a suggested source the owner dismissed (pass 3) }
 *   a cell: { v, at } or a removal { deleted: true, at } ("no decision"); `undo: true` on a cell an Undo wrote; a cut
 *   carries its day (`day`), so a cut seeded by the update never claims a charge made before it.
 *
 * A line added by hand keeps one key for its decisions, 'l' + hash13('a|' + the id of its entry): the id is made once and
 * travels, so the key never changes with a rename, a price edit or a cadence change, and content matching never applies
 * to such a line (its facts carry the fingerprint of the same text in place of a payee's). Its entry learns the bank's
 * payee key (`p`) when a device links a charge to it, so every device links that payee's charges to it whatever its name.
 * Any other line's key is 'l' + 13 hex digits of the hash of its payee key's fingerprint, cadence, price band (floor of
 * log 1.2 of the cents) and billing day, so two devices that decide on one line usually write one key. Its facts (p, cad,
 * amt, dom) are the line's at the moment of the decision; two copies that differ (two amounts in one band) keep the
 * smaller. The second and later lines of one payee and cadence that a decision on one would reach (its rivals: two
 * memberships of one gym) take keys of their own ('|#' + rank), ranked by the account's bank id, then the first charge,
 * then id. A decision applies to the local line of the same payee key, whatever the account, through a price within
 * 35% of the decision's own or $2: the line's amount now (in another price band only on a billing day within 3), or a
 * price the bank charged it at on a billing day within 3 (`lineHistory`); the same cadence first, then the nearest
 * price, then a line still running (so after a card change the decision is the charging line's, whatever its billing
 * day), a billing day within 3, the nearest day, the line of the key's rank, the latest anchor and the line's own key
 * (never the local order). So a decision survives a card change and a price rise, an introductory price ending
 * included, and waits while no line matches; keys of one content take one line each. Each field of a line is the later
 * cell of every key that reaches it.
 *
 * Merging is cell by cell: the later stamp; on an equal stamp an edit before an Undo's cell; then the smaller cell
 * written as JSON with sorted keys (a total order: commutative, associative, idempotent). `since` keeps the later day;
 * fixed facts keep the smaller value (a filing's day the later). The bounds (`pruneFlows`: live entries and removals
 * capped apart, a live decision never evicted for a removal) and the 400 days a removal is kept (by the device's clock,
 * as removals of payments by hand are) are drawn on what a device writes, outside the merge (`boundFlows`).
 *
 * On the device `share.flows` holds the copy (every cell made or taken in). The owner's actions write it in the same
 * store update as the record (`decideLine`, `noteTarget`, `noteAdded`), stamped `max(round(now), at + 2)` above every
 * cell they replace; an Undo restamps (`restampFlows`). `applyFlows` brings the record to the copy after detection.
 * The first load seeds the copy at stamp 0 from the record (`seedFlows`).
 *
 * Pure: no clock (every stamp is handed in), no DOM, no storage. Imports: schema, dates, byhand, classify.
 */

import { CADENCES, CATEGORIES, makeRecurring } from './schema.js';
import { addDays, diffDays, gameDay, isYmd, parts } from './dates.js';
import { payeeKey } from './byhand.js';
import { merchantOf } from './classify.js';

const MAX_STAMP = 1e14;
const DAY_MS = 86400000;
/** Stamps below this (2001) are no time of day: seeds are stamped 0, and an Undo of one 1 above. */
const TIME_FLOOR = 1e12;
/** A removal is written this many days after it was made, and no longer. */
export const FLOWS_KEEP_DAYS = 400;
/**
 * What a written file holds at most (Appendix C, Bounds). Live entries and removals have caps of their own, so a removal
 * never pushes out a live decision:
 * - lines 100 live and 30 whose every cell is a removal, apart (so an Undo, a Restore or a verdict cleared travels however
 *   many live decisions there are); of the live, evicted first those holding only `sub: false` or `active`, then the
 *   rest, the oldest first in each;
 * - lines added by hand 40 live and 20 removals; targets 40 (removals first); sources 20 live and 10 removed (or with
 *   no live cell);
 * - filings by payer or reporting app 160, and of one deposit or reported payment 120: removals and `?` first; the
 *   second also by the oldest day, and never more than 400 days behind its newest day;
 * - dismissed source suggestions 40 live and 20 removals.
 * "Oldest" is the entry's latest stamp, then its key: the same on every device.
 */
export const FLOWS_CAPS = Object.freeze({
  lines: 100, linesGone: 30, added: 40, addedGone: 20, targets: 40, inlets: 20, inletsGone: 10, intoKeys: 160, intoRows: 120,
  offers: 40, offersGone: 20,
});
/** The UI refuses a 41st line added by hand and a 21st source (the live caps above). */
export const ADDED_LIVE_MAX = FLOWS_CAPS.added;
export const INLETS_LIVE_MAX = FLOWS_CAPS.inlets;
/** A filing of one deposit is written while its day is at most this many days behind the newest such filing's day. */
const ROW_KEEP_DAYS = 400;
/** What a reader takes at most (a later version may keep more; this one writes its own caps). */
const READ_MAX = { lines: 400, added: 120, targets: 60, inlets: 200, into: 600, offers: 120 };
const NO_MAX = { lines: Infinity, added: Infinity, targets: Infinity, inlets: Infinity, into: Infinity, offers: Infinity };
const NAME_MAX = 80;
const INLET_NAME_MAX = 40;
const AMOUNT_MAX = 1e10;
const PARTS = ['since', 'lines', 'added', 'targets', 'inlets', 'into', 'offers'];
const LINE_FIELDS = ['sub', 'verdict', 'active'];
const INLET_FIELDS = ['name', 'kind', 'goal', 'focus', 'gone', 'removed'];
const INLET_KINDS = ['steady', 'job', 'backend', 'oneoff'];
const VERDICTS = ['keep', 'review', 'cut'];
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const HEX = '[0-9a-f]{13}';
const LINE_KEY = new RegExp('^l' + HEX + '$');
const ADDED_KEY = new RegExp('^a' + HEX + '$');
const INLET_KEY = new RegExp('^n' + HEX + '$');
const INTO_KEY = new RegExp('^[prifq]' + HEX + '$');
const OFFER_KEY = new RegExp('^[prs]' + HEX + '$');
const PAYEE = new RegExp('^p' + HEX + '$');
const FP = new RegExp('^f' + HEX + '$');
/** Holding charges: a decision reaches a line within 35% of its amount, or $2 (detect.js holdCharges). */
const NEAR_SHARE = 0.35;
const NEAR_CENTS = 200;
const DOM_NEAR = 3;
/** The fields whose lock keeps detection from ending a line it found (detect.js OWNER_HELD). */
const OWNER_HELD = ['cadence', 'amount', 'name', 'anchor'];

/* ------------------------------------------------------------------ keys */

/** 13 hex digits of a 52-bit hash, the same on every device (byhand.payeeKey). */
function hash13(text) {
  return payeeKey(text).slice(1);
}

/** The thresholds of the price bands, by repeated multiplication (exact on every engine, unlike Math.log). */
const BANDS = (() => {
  const out = [1];
  while (out[out.length - 1] <= AMOUNT_MAX * 1.3) out.push(out[out.length - 1] * 1.2);
  return out;
})();

/** The price band of an amount: floor(log 1.2 of the cents), worked out with no logarithm. */
export function bandOf(cents) {
  const c = Math.max(1, Math.round(Number(cents) || 0));
  let lo = 0;
  let hi = BANDS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (BANDS[mid] <= c) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The band's own amount: the smallest whole cents in it (the key reads the band; a line's `amt` is its own amount). */
export function bandCents(cents) {
  return Math.ceil(BANDS[bandOf(cents)]);
}

/**
 * A line's billing day: the weekday of its anchor for a weekly or two-weekly line, the day within the half month for one
 * twice a month, the day of the year for a yearly one, the day of the month otherwise.
 */
export function domOf(cadence, anchor) {
  if (!isYmd(anchor)) return 1;
  const { y, m, d } = parts(anchor);
  if (cadence === 'weekly' || cadence === 'biweekly') {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow === 0 ? 7 : dow;
  }
  if (cadence === 'semimonthly') return ((d - 1) % 15) + 1;
  if (cadence === 'annual') return diffDays(y + '-01-01', anchor) + 1;
  return d;
}

function domSpan(cadence) {
  return cadence === 'weekly' || cadence === 'biweekly' ? 7 : cadence === 'semimonthly' ? 15 : cadence === 'annual' ? 366 : 31;
}

function domGap(cadence, a, b) {
  const span = domSpan(cadence);
  const gap = Math.abs(a - b) % span;
  return Math.min(gap, span - gap);
}

/**
 * What a line says of itself at the moment of a decision: its payee key's fingerprint, cadence, amount and billing day
 * (fixed facts), and its key, from the price band rather than the amount, so a price inside one band keeps one key.
 */
export function lineFacts(line) {
  const mkey = line && typeof line.mkey === 'string' ? line.mkey : '';
  const p = payeeKey(mkey);
  if (!p || !Object.hasOwn(CADENCES, line.cadence)) return null;
  const amount = Math.min(AMOUNT_MAX, Math.max(1, Math.round(Number(line.amount) || 0)));
  const facts = { p, cad: line.cadence, amt: amount, dom: domOf(line.cadence, line.anchor) };
  return { key: 'l' + hash13(facts.p + '|' + facts.cad + '|' + bandOf(amount) + '|' + facts.dom), facts };
}

/**
 * What a line added by hand is, for its key: its payee key's fingerprint (else its name) and cadence. The amount is left
 * out, so two devices that seed one bill at two prices make one entry, and the canonical order keeps one price (the
 * notice names the other).
 */
function addedContent(line) {
  const p = payeeKey(line && typeof line.mkey === 'string' ? line.mkey : '');
  const cadence = line && Object.hasOwn(CADENCES, line.cadence) ? line.cadence : 'monthly';
  return (p || 'name:' + String((line && line.name) || '').trim().toLowerCase()) + '|' + cadence;
}

/**
 * The key of a line added by hand, from its content, so two devices that seed one line make one entry; `rank` 1 and
 * above for the second and later lines of one content on one device, ranked by content (seedKeys).
 */
export function addedKey(line, rank = 0) {
  const content = addedContent(line);
  return 'a' + hash13(rank ? content + '|#' + rank : content);
}

/**
 * The key of the decisions on a line added by hand: 'l' + hash13('a|' + the id of its entry). The id is made once and
 * travels, so the key is the same on every device and never changes with a rename, a price edit or a cadence change;
 * content matching never applies to such a line (matchAll).
 * @param {string} id  the line's `added` link
 */
export function addedLineKey(id) {
  return 'l' + hash13('a|' + id);
}

/**
 * The facts written beside a decision on a line added by hand: its cadence, amount and billing day, and in place of a
 * payee's fingerprint the fingerprint of the key's own text, so the entry names itself as a line by hand's (its key
 * reads 'l' and the same 13 hex digits) and no device reaches a payee's line through it, nor makes a line from its rows.
 */
function addedLineFacts(rec) {
  return {
    p: 'p' + hash13('a|' + rec.added), cad: rec.cadence,
    amt: Math.min(AMOUNT_MAX, Math.max(1, Math.round(Number(rec.amount) || 0))), dom: domOf(rec.cadence, rec.anchor),
  };
}

/** Whether a decision's key is a line by hand's own (addedLineKey): its facts name it. */
function isAddedLineKey(key, entry) {
  return isObject(entry) && typeof entry.p === 'string' && key.slice(1) === entry.p.slice(1);
}

/** A line added by hand linked to its entry: its decisions are its own key's. */
function isLinked(rec) {
  return isAddedLine(rec) && isString(rec.added) && ADDED_KEY.test(rec.added);
}

/**
 * The key each line added by hand of the record travels under: its link (`added`) when it has one; else its content
 * key, the second and later lines of one content ranked by amount, name, anchor and id (the same on two devices that
 * hold the same pair), each taking the next rank no line of the record already holds.
 * @returns {Map<object, string>}
 */
function seedKeys(state) {
  const out = new Map();
  const groups = new Map();
  for (const rec of listOf(state.recurring)) {
    if (!isAddedLine(rec)) continue;
    if (isString(rec.added) && ADDED_KEY.test(rec.added)) { out.set(rec, rec.added); continue; }
    const content = addedContent(rec);
    if (!groups.has(content)) groups.set(content, []);
    groups.get(content).push(rec);
  }
  const taken = new Set(out.values());
  const text = (x) => String(x == null ? '' : x);
  for (const recs of groups.values()) {
    recs.sort((a, b) => ((Number(a.amount) || 0) - (Number(b.amount) || 0))
      || (text(a.name) < text(b.name) ? -1 : text(a.name) > text(b.name) ? 1 : 0)
      || (text(a.anchor) < text(b.anchor) ? -1 : text(a.anchor) > text(b.anchor) ? 1 : 0)
      || (text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0));
    let rank = 0;
    for (const rec of recs) {
      let key = addedKey(rec, rank);
      while (taken.has(key)) { rank += 1; key = addedKey(rec, rank); }
      rank += 1;
      taken.add(key);
      out.set(rec, key);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ values */

const isBool = (v) => (typeof v === 'boolean' ? v : null);

function addedValue(v) {
  if (!isObject(v) || !sameKeys(v, ['name', 'amount', 'cadence', 'day', 'category', 'sub', 'p'])) return null;
  if (!isText(v.name, NAME_MAX) || !isCents(v.amount) || !Object.hasOwn(CADENCES, v.cadence) || !isYmd(v.day)) return null;
  if (!Object.hasOwn(CATEGORIES, v.category) || typeof v.sub !== 'boolean') return null;
  if (v.p !== undefined && !(typeof v.p === 'string' && PAYEE.test(v.p))) return null;
  const out = { name: v.name, amount: v.amount, cadence: v.cadence, day: v.day, category: v.category, sub: v.sub };
  if (v.p !== undefined) out.p = v.p;
  return out;
}

const INLET_VALUE = {
  name: (v) => (isText(v, INLET_NAME_MAX) ? v : null),
  kind: (v) => (INLET_KINDS.includes(v) ? v : null),
  goal: (v) => (isObject(v) && sameKeys(v, ['per', 'cents']) && (v.per === 'month' || v.per === 'year') && isCents(v.cents) ? { per: v.per, cents: v.cents } : null),
  focus: isBool,
  gone: isBool,
  removed: isBool,
};

const intoValue = (v) => (v === '-' || v === '?' || (typeof v === 'string' && INLET_KEY.test(v)) ? v : null);

/* ------------------------------------------------------------------ reading */

/**
 * The section of a shared file, checked (untrusted input): the seven parts above and nothing else, every key of its
 * pattern, known values, cells `{ v, at }` or removals `{ deleted: true, at }` with `undo` true or false when present,
 * stamps from 0 to 10^14, a cut with its day and no other verdict with one, a filing of one deposit with its day (and
 * the row's fingerprint on an `i` key), at most 400 lines, 120 lines added by hand, 60 targets, 200 sources, 600
 * filings and 120 dismissed suggestions. Anything else is null and refuses the whole file. A fresh copy.
 * @param {*} raw
 * @returns {object|null}
 */
export function readFlows(raw) {
  return parseFlows(raw, READ_MAX);
}

/**
 * A section this build made (a merge, before its bounds are drawn): every cell checked as `readFlows` checks it, with no
 * limit of length. A merge keeps every cell, so it may hold more than a file ever does.
 * @param {*} raw
 * @returns {object|null}
 */
export function readFlowsWhole(raw) {
  return parseFlows(raw, NO_MAX);
}

function parseFlows(raw, max) {
  if (!isObject(raw) || Object.keys(raw).some((key) => !PARTS.includes(key))) return null;
  const out = {};
  if (raw.since !== undefined) {
    if (!isYmd(raw.since)) return null;
    out.since = raw.since;
  }
  if (raw.lines !== undefined) {
    const lines = mapOf(raw.lines, max.lines, LINE_KEY, (entry) => {
      if (!isObject(entry) || !sameKeys(entry, ['p', 'cad', 'amt', 'dom', ...LINE_FIELDS])) return null;
      if (!(typeof entry.p === 'string' && PAYEE.test(entry.p)) || !Object.hasOwn(CADENCES, entry.cad) || !isCents(entry.amt)) return null;
      if (!Number.isInteger(entry.dom) || entry.dom < 1 || entry.dom > 366) return null;
      const line = { p: entry.p, cad: entry.cad, amt: entry.amt, dom: entry.dom };
      let fields = 0;
      for (const field of LINE_FIELDS) {
        if (entry[field] === undefined) continue;
        const cell = field === 'verdict' ? verdictCell(entry[field]) : cellOf(entry[field], isBool, []);
        if (!cell) return null;
        line[field] = cell;
        fields += 1;
      }
      return fields ? line : null;
    });
    if (!lines) return null;
    out.lines = lines;
  }
  if (raw.added !== undefined) {
    const added = mapOf(raw.added, max.added, ADDED_KEY, (cell) => cellOf(cell, addedValue, []));
    if (!added) return null;
    out.added = added;
  }
  if (raw.targets !== undefined) {
    if (!isObject(raw.targets) || Object.keys(raw.targets).length > max.targets) return null;
    const targets = {};
    for (const key of Object.keys(raw.targets)) {
      if (UNSAFE.has(key) || !Object.hasOwn(CATEGORIES, key)) return null;
      const cell = cellOf(raw.targets[key], (v) => (isCents(v) ? v : null), []);
      if (!cell) return null;
      targets[key] = cell;
    }
    out.targets = targets;
  }
  if (raw.inlets !== undefined) {
    const inlets = mapOf(raw.inlets, max.inlets, INLET_KEY, (entry) => {
      if (!isObject(entry) || !Object.keys(entry).length || !sameKeys(entry, INLET_FIELDS)) return null;
      const inlet = {};
      for (const field of INLET_FIELDS) {
        if (entry[field] === undefined) continue;
        const cell = cellOf(entry[field], INLET_VALUE[field], []);
        if (!cell) return null;
        inlet[field] = cell;
      }
      return inlet;
    });
    if (!inlets) return null;
    out.inlets = inlets;
  }
  if (raw.into !== undefined) {
    const into = mapOf(raw.into, max.into, INTO_KEY, (cell, key) => cellOf(cell, intoValue, key[0] === 'i' ? ['day', 'fp'] : key[0] === 'f' || key[0] === 'q' ? ['day'] : []));
    if (!into) return null;
    out.into = into;
  }
  if (raw.offers !== undefined) {
    const offers = mapOf(raw.offers, max.offers, OFFER_KEY, (cell) => cellOf(cell, (v) => (v === false ? false : null), []));
    if (!offers) return null;
    out.offers = offers;
  }
  return tidy(out);
}

function mapOf(raw, max, pattern, entryOf) {
  if (!isObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > max) return null;
  const out = {};
  for (const key of keys) {
    if (UNSAFE.has(key) || !pattern.test(key)) return null;
    const entry = entryOf(raw[key], key);
    if (!entry) return null;
    out[key] = entry;
  }
  return out;
}

/**
 * One cell, checked: `{ v, at }` (v of its kind) or a removal `{ deleted: true, at }`, `undo` kept when true, and the
 * facts `facts` names, each required (a day; a row's fingerprint).
 */
function cellOf(raw, valueOf, facts) {
  if (!isObject(raw) || !isStamp(raw.at)) return null;
  if (raw.undo !== undefined && typeof raw.undo !== 'boolean') return null;
  const out = {};
  if (raw.deleted !== undefined) {
    if (raw.deleted !== true || !sameKeys(raw, ['deleted', 'at', 'undo', ...facts])) return null;
    out.deleted = true;
  } else {
    if (!sameKeys(raw, ['v', 'at', 'undo', ...facts]) || !Object.hasOwn(raw, 'v')) return null;
    const v = valueOf(raw.v);
    if (v === null) return null;
    out.v = v;
  }
  out.at = raw.at;
  if (raw.undo === true) out.undo = true;
  for (const fact of facts) {
    const value = raw[fact];
    if (fact === 'day' ? !isYmd(value) : !(typeof value === 'string' && FP.test(value))) return null;
    out[fact] = value;
  }
  return out;
}

/** A verdict: keep, review or cut, a cut with the day it was made (no other verdict has one), or a removal. */
function verdictCell(raw) {
  if (!isObject(raw)) return null;
  if (raw.v === 'cut') {
    const cell = cellOf(raw, (v) => v, ['day']);
    return cell;
  }
  return cellOf(raw, (v) => (VERDICTS.includes(v) && v !== 'cut' ? v : null), []);
}

/** True when a section holds nothing. */
export function isBlankFlows(section) {
  return !isObject(section) || Object.keys(tidy(section)).length === 0;
}

/* ------------------------------------------------------------------ merging */

/**
 * Two sections into one, cell by cell the later (`joinFlows`), with no bound: commutative, associative and idempotent,
 * fixed facts included. The bounds are drawn apart (`boundFlows`), on what a device writes, never inside the merge: a
 * bound that keeps a live decision over any removal cannot keep the merge's laws (a removal that turns live again
 * changes its pool), and every device keeps whole what it took in, as the daily game's copy does.
 * Either side may be absent or unreadable (read as empty).
 * @returns {object}
 */
export function mergeFlows(a, b) {
  return joinFlows(a, b);
}

/** Two sections into one, cell by cell, with no bound. */
export function joinFlows(a, b) {
  const x = sectionOf(a);
  const y = sectionOf(b);
  const out = {};
  const since = [x.since, y.since].filter(isYmd).sort().pop();
  if (since) out.since = since;
  out.lines = joinMap(x.lines, y.lines, (p, q) => {
    if (!p) return q;
    if (!q) return p;
    // the facts the key reads, the same on every copy; two copies that differ (a hash shared by two lines) keep the
    // smaller of each, so the merge keeps its laws
    const line = { p: min(p.p, q.p), cad: min(p.cad, q.cad), amt: Math.min(p.amt, q.amt), dom: Math.min(p.dom, q.dom) };
    for (const field of LINE_FIELDS) {
      const cell = laterCell(p[field] || null, q[field] || null);
      if (cell) line[field] = cell;
    }
    return line;
  });
  out.added = joinMap(x.added, y.added, laterAdded);
  out.targets = joinMap(x.targets, y.targets, laterCell);
  out.inlets = joinMap(x.inlets, y.inlets, (p, q) => (!p ? q : !q ? p : joinMap(p, q, laterCell)));
  out.into = joinMap(x.into, y.into, laterFiling);
  out.offers = joinMap(x.offers, y.offers, laterCell);
  return tidy(out);
}

/**
 * A filing's cell: the later decision (its value or removal, stamp and Undo mark, by laterCell's order), and its fixed
 * facts merged apart: the later day and the smaller fingerprint, so two copies that differ still meet (G.9).
 */
function laterFiling(p, q) {
  if (!p) return q;
  if (!q) return p;
  const won = laterCell(coreOf(p), coreOf(q)) === coreOf(p) ? p : q;
  const out = coreOf(won);
  if (p.day !== undefined || q.day !== undefined) out.day = [p.day, q.day].filter(isYmd).sort().pop();
  if (p.fp !== undefined || q.fp !== undefined) out.fp = [p.fp, q.fp].filter((fp) => typeof fp === 'string').sort()[0];
  return out;
}

/** A cell without its fixed facts (memoised per cell, so laterCell can compare identities). */
const CORES = new WeakMap();
function coreOf(cell) {
  if (CORES.has(cell)) return CORES.get(cell);
  const out = cell.deleted ? { deleted: true, at: cell.at } : { v: cell.v, at: cell.at };
  if (cell.undo) out.undo = true;
  CORES.set(cell, out);
  return out;
}

function joinMap(a, b, pick) {
  const x = a || {};
  const y = b || {};
  const out = {};
  for (const key of union(x, y)) {
    const won = pick(own(x, key) || null, own(y, key) || null);
    if (won) out[key] = won;
  }
  return out;
}

/**
 * A line added by hand: as laterCell, but of two live values of one stamp and one Undo mark the smaller amount first,
 * then the canonical form (a total order: stamp, Undo mark, removal first, amount, canonical form, so the merge keeps
 * its laws). Seeds of one content are ranked by ascending amount (seedKeys), so a device that holds some of another
 * device's lines of one content ends with all of them: rank 0 is the smallest on both, and no line is lost or counted
 * twice.
 */
function laterAdded(p, q) {
  if (p && q && p.at === q.at && !!p.undo === !!q.undo && !p.deleted && !q.deleted && p.v.amount !== q.v.amount) return p.v.amount < q.v.amount ? p : q;
  return laterCell(p, q);
}

/** The cell that wins: the later stamp; on the same stamp an edit before an Undo's cell; then the smaller canonical form. */
export function laterCell(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p.at !== q.at) return p.at > q.at ? p : q;
  if (!!p.undo !== !!q.undo) return p.undo ? q : p;
  return canon(p) <= canon(q) ? p : q;
}

/** An entry's stamp for its rank: the latest stamp of its cells. */
function stampOf(entry, fields) {
  let top = 0;
  for (const field of fields) if (entry[field] && entry[field].at > top) top = entry[field].at;
  return top;
}

/** Keep the first `cap` of `items` ({ key, tier, day?, at }): the higher tier first, then the later day, the later stamp, the smaller key. */
function keepFirst(items, cap) {
  if (items.length <= cap) return items.map((item) => item.key);
  const sorted = items.slice().sort((a, b) => (b.tier - a.tier)
    || (a.day === b.day ? 0 : (a.day || '') < (b.day || '') ? 1 : -1)
    || (b.at - a.at)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sorted.slice(0, cap).map((item) => item.key);
}

/** A line's tier: 0 when every cell is a removal, 1 when it holds only `sub: false` or `active`, else 2. */
function lineTier(line) {
  const live = LINE_FIELDS.filter((field) => line[field] && !line[field].deleted);
  if (!live.length) return 0;
  return live.every((field) => field === 'active' || (field === 'sub' && line.sub.v === false)) ? 1 : 2;
}

/** Whether a source is gone: removed, or with no live cell left (an Undo of its making). */
function inletGone(inlet) {
  if (inlet.removed && !inlet.removed.deleted && inlet.removed.v === true) return true;
  return !INLET_FIELDS.some((field) => inlet[field] && !inlet[field].deleted);
}

/**
 * The bounds of Appendix C (FLOWS_CAPS), drawn by the section's own content (never a clock), the same on every device:
 * per map, live entries and removals in the order above, the oldest (latest stamp, then key) going first. A filing of
 * one deposit more than 400 days behind the newest such filing's day goes too (by the days alone, as row corrections
 * are pruned, corrections.js). Idempotent; applied to what a device writes, never inside the merge.
 * `read` (the section of the file a round just read): a removal the caps would drop is kept when that file holds the
 * same entry live where this one is a removal (a field of a line or a source, a line by hand, a dismissal, a target or
 * a filing). The removal has just won the merge over another device's live copy, and that device must receive it once;
 * the next round, the file no longer holds it live, and the caps drop it (as share.withoutOldTombs keeps a removal of a
 * payment by hand). Without it, a removal past its pool's cap never reaches the device holding the live entry.
 * @param {object} section
 * @param {object} [read]
 * @returns {object} a fresh section
 */
export function pruneFlows(section, read) {
  const s = sectionOf(section);
  const r = read ? sectionOf(read) : {};
  const out = { ...s };
  const isLive = (cell) => !!cell && !cell.deleted;
  const counters = (mine, theirs, fields) => !!theirs && fields.some((field) => mine[field] && mine[field].deleted && isLive(theirs[field]));
  // the keys of `map` that the caps left out and the file just read must receive: kept too
  const withHeld = (map, kept, held) => [...kept, ...Object.keys(map).filter((key) => !kept.includes(key) && held(key))];
  if (s.lines) {
    const items = Object.keys(s.lines).map((key) => ({ key, tier: lineTier(s.lines[key]), at: stampOf(s.lines[key], LINE_FIELDS) }));
    // two pools, as the lines added by hand have: a removal never pushes out a live decision, nor the reverse
    const live = items.filter((item) => item.tier > 0);
    const gone = items.filter((item) => item.tier === 0);
    const kept = [...keepFirst(live, FLOWS_CAPS.lines), ...keepFirst(gone, FLOWS_CAPS.linesGone)];
    out.lines = picked(s.lines, withHeld(s.lines, kept, (key) => counters(s.lines[key], own(r.lines, key), LINE_FIELDS)));
  }
  const pools = (map, liveCap, goneCap, theirs) => {
    const keys = Object.keys(map);
    const live = keys.filter((key) => !map[key].deleted).map((key) => ({ key, tier: 0, at: map[key].at }));
    const gone = keys.filter((key) => map[key].deleted).map((key) => ({ key, tier: 0, at: map[key].at }));
    const kept = [...keepFirst(live, liveCap), ...keepFirst(gone, goneCap)];
    return picked(map, withHeld(map, kept, (key) => map[key].deleted && isLive(own(theirs, key))));
  };
  if (s.added) out.added = pools(s.added, FLOWS_CAPS.added, FLOWS_CAPS.addedGone, r.added);
  if (s.offers) out.offers = pools(s.offers, FLOWS_CAPS.offers, FLOWS_CAPS.offersGone, r.offers);
  if (s.targets) {
    const items = Object.keys(s.targets).map((key) => ({ key, tier: s.targets[key].deleted ? 0 : 1, at: s.targets[key].at }));
    out.targets = picked(s.targets, withHeld(s.targets, keepFirst(items, FLOWS_CAPS.targets), (key) => s.targets[key].deleted && isLive(own(r.targets, key))));
  }
  if (s.inlets) {
    const keys = Object.keys(s.inlets);
    const live = keys.filter((key) => !inletGone(s.inlets[key])).map((key) => ({ key, tier: 0, at: stampOf(s.inlets[key], INLET_FIELDS) }));
    const gone = keys.filter((key) => inletGone(s.inlets[key])).map((key) => ({ key, tier: 0, at: stampOf(s.inlets[key], INLET_FIELDS) }));
    const kept = [...keepFirst(live, FLOWS_CAPS.inlets), ...keepFirst(gone, FLOWS_CAPS.inletsGone)];
    out.inlets = picked(s.inlets, withHeld(s.inlets, kept, (key) => counters(s.inlets[key], own(r.inlets, key), INLET_FIELDS)
      || (inletGone(s.inlets[key]) && !!own(r.inlets, key) && !inletGone(r.inlets[key]))));
  }
  if (s.into) {
    const keys = Object.keys(s.into);
    // a removal or Leave it ('?') goes before a filing
    const tier = (cell) => (cell.deleted || cell.v === '?' ? 0 : 1);
    const byKey = keys.filter((key) => key[0] === 'p' || key[0] === 'r').map((key) => ({ key, tier: tier(s.into[key]), at: s.into[key].at }));
    const rows = keys.filter((key) => key[0] !== 'p' && key[0] !== 'r');
    const newest = rows.map((key) => s.into[key].day).sort().pop();
    const floor = newest ? addDays(newest, -ROW_KEEP_DAYS) : null;
    const byRow = rows.filter((key) => s.into[key].day >= floor).map((key) => ({ key, tier: tier(s.into[key]), day: s.into[key].day, at: s.into[key].at }));
    const kept = [...keepFirst(byKey, FLOWS_CAPS.intoKeys), ...keepFirst(byRow, FLOWS_CAPS.intoRows)];
    out.into = picked(s.into, withHeld(s.into, kept, (key) => s.into[key].deleted && isLive(own(r.into, key))));
  }
  return tidy(out);
}

/**
 * What a device writes of a section: without the removals older than 400 days by its clock, then within the bounds
 * (`read`: the section of the file just read, whose live entries keep the removals that answer them, pruneFlows).
 * @param {object} section
 * @param {number} nowMs
 * @param {object} [read]
 * @returns {object}
 */
export function boundFlows(section, nowMs, read) {
  return pruneFlows(withoutOldRemovals(section, nowMs), read);
}

/**
 * The removals a round restamps (share.roundShared): those past their pool's cap that the file just read (`read`) holds
 * live, which pruneFlows keeps for that file alone (a field of a line, a line by hand, a dismissed suggestion). Each is
 * stamped 1 above the newest stamp of its pool and of the live cell it beat, its Undo mark and the line's facts kept,
 * for the device's copy to take in (takeCells, and the earlier copies Undo keeps). The caps then keep it among the
 * newest of its pool until that many newer removals come, so a device still holding the entry live takes it on its next
 * round whatever the order of the rounds, and no round writes it in turn with that device for ever. A device action,
 * like restampFlows: the merge is unchanged, and it fires only where the removal has already won.
 * @param {object} section  a merged section
 * @param {number} nowMs
 * @param {object} [read]
 * @returns {object|null} a section of the restamped cells, or null when there is none
 */
export function heldRemovals(section, nowMs, read) {
  if (!read || !section) return null;
  const s = withoutOldRemovals(section, nowMs);
  const r = sectionOf(read);
  const capped = pruneFlows(s);
  const kept = pruneFlows(s, r);
  const isLive = (cell) => !!cell && !cell.deleted;
  const out = {};
  const restamp = (cell, beat, newest) => {
    const next = { deleted: true, at: Math.min(MAX_STAMP, Math.max(newest, beat.at, cell.at) + 1) };
    if (cell.undo) next.undo = true;
    return next;
  };
  const heldOf = (name) => Object.keys(kept[name] || {}).filter((key) => !Object.hasOwn(capped[name] || {}, key));
  const lines = heldOf('lines');
  if (lines.length) {
    // the newest stamp of each pool of lines: those holding a live cell, and those whose every cell is a removal
    const newest = [0, 0];
    for (const key of Object.keys(s.lines)) {
      const pool = lineTier(s.lines[key]) === 0 ? 0 : 1;
      newest[pool] = Math.max(newest[pool], stampOf(s.lines[key], LINE_FIELDS));
    }
    for (const key of lines) {
      const line = s.lines[key];
      const theirs = own(r.lines, key) || {};
      const top = newest[lineTier(line) === 0 ? 0 : 1];
      for (const field of LINE_FIELDS) {
        if (!line[field] || !line[field].deleted || !isLive(theirs[field])) continue;
        out.lines = out.lines || {};
        out.lines[key] = { ...(out.lines[key] || { p: line.p, cad: line.cad, amt: line.amt, dom: line.dom }), [field]: restamp(line[field], theirs[field], top) };
      }
    }
  }
  for (const name of ['added', 'offers']) {
    const keys = heldOf(name);
    if (!keys.length) continue;
    const top = Math.max(0, ...Object.values(s[name]).filter((cell) => cell.deleted).map((cell) => cell.at));
    for (const key of keys) {
      const theirs = own(r[name], key);
      if (!s[name][key].deleted || !isLive(theirs)) continue;
      (out[name] || (out[name] = {}))[key] = restamp(s[name][key], theirs, top);
    }
  }
  const section2 = tidy(out);
  return Object.keys(section2).length ? section2 : null;
}

/**
 * The device takes in cells it wrote of itself, outside the owner's action (the removals a round restamped,
 * heldRemovals): into its copy, and into each earlier copy Undo keeps, so an Undo never takes them back. A record with
 * no copy is left as it is.
 * @param {object} state  (mutated)
 * @param {object} cells  a section
 * @returns {boolean} true when the copy changed
 */
export function takeCells(state, cells) {
  if (!hasCopy(state) || !cells) return false;
  const copy = storedFlows(state);
  const next = joinFlows(copy, cells);
  if (canon(next) === canon(copy)) return false;
  storeCopy(state, next);
  return true;
}

function picked(map, keys) {
  const out = {};
  for (const key of [...keys].sort()) out[key] = map[key];
  return out;
}

/**
 * The section without the removals made more than 400 days before `nowMs` (the device's clock, as for removals of
 * payments by hand, share.js): written by no device once that old. A source removed that long ago goes whole.
 * @returns {object} a fresh section
 */
export function withoutOldRemovals(section, nowMs) {
  const s = sectionOf(section);
  if (!Number.isFinite(nowMs)) return s;
  // a stamp before 2001 is no time of day: a seed (0) or an Undo of one, which ages out of nothing
  const old = (cell) => !!cell && cell.at >= TIME_FLOOR && nowMs - cell.at > FLOWS_KEEP_DAYS * DAY_MS;
  const stale = (cell) => !!cell && cell.deleted === true && old(cell);
  const out = { ...s };
  if (s.lines) {
    out.lines = {};
    for (const key of Object.keys(s.lines)) {
      const line = s.lines[key];
      const entry = { p: line.p, cad: line.cad, amt: line.amt, dom: line.dom };
      for (const field of LINE_FIELDS) if (line[field] && !stale(line[field])) entry[field] = line[field];
      if (LINE_FIELDS.some((field) => entry[field])) out.lines[key] = entry;
    }
  }
  for (const name of ['added', 'targets', 'into', 'offers']) {
    if (!s[name]) continue;
    out[name] = {};
    for (const key of Object.keys(s[name])) if (!stale(s[name][key])) out[name][key] = s[name][key];
  }
  if (s.inlets) {
    out.inlets = {};
    for (const key of Object.keys(s.inlets)) {
      const inlet = s.inlets[key];
      if (inlet.removed && !inlet.removed.deleted && inlet.removed.v === true && old(inlet.removed)) continue;
      const entry = {};
      for (const field of INLET_FIELDS) if (inlet[field] && !stale(inlet[field])) entry[field] = inlet[field];
      if (Object.keys(entry).length) out.inlets[key] = entry;
    }
  }
  return tidy(out);
}

/* ------------------------------------------------------------------ the device's copy */

/** A section this device holds or built, checked cell by cell with no limit of length; absent or unreadable is empty. */
function sectionOf(raw) {
  return parseFlows(raw === undefined || raw === null ? {} : raw, NO_MAX) || {};
}

function hasCopy(state) {
  return isObject(state) && isObject(state.share) && isObject(state.share.flows);
}

function storeCopy(state, section) {
  if (!isObject(state.share)) state.share = { tombs: {} };
  state.share.flows = tidy(section);
}

/**
 * The device's copy (the seeds when it has none yet, a cut seeded with the day of `nowMs`). Every path that writes the
 * copy or the file seeds it at a time first (seedFlows, exportFlows); without a time the seeds are only read, and a cut
 * dated before 2001 claims nothing (flows.stillCharging).
 */
export function storedFlows(state, nowMs) {
  return hasCopy(state) ? sectionOf(state.share.flows) : seedsOf(state, Number.isFinite(nowMs) ? nowMs : 0);
}

/** The first day of this device's record: its first counted row (cards.firstTransactionDay's rule), or null. */
export function ownFirstDay(state) {
  let first = null;
  for (const tx of listOf(isObject(state) ? state.txs : null)) {
    if (!isObject(tx) || !Number.isFinite(tx.amount) || tx.amount < 0 || !isYmd(tx.day)) continue;
    if (tx.kind === 'decline' || tx.matchId || tx.source === 'manual') continue;
    if (first === null || tx.day < first) first = tx.day;
  }
  return first;
}

/**
 * The shared floor: the later of the copy's `since` (the latest first day any device wrote) and this device's own first
 * day on record; null when neither is known. It bounds the queue and the period's figures on every device alike.
 */
export function floorOf(state) {
  const copy = storedFlows(state);
  const own = ownFirstDay(state);
  return [copy.since, own].filter(isYmd).sort().pop() || null;
}

/**
 * The section as this device writes it: its copy with its own first day as `since`, within the bounds, without the
 * removals older than 400 days. `whole`: the copy without those removals but with no other bound, for a round to merge
 * (share.roundShared draws the bounds on the merged file, so a removal past this device's own caps still reaches the
 * merge, and the file it answers).
 * @param {object} state
 * @param {number} nowMs
 * @param {{ whole?: boolean }} [opts]
 */
export function exportFlows(state, nowMs, opts = {}) {
  const own = ownFirstDay(state);
  // a record with no copy yet (a backup from before this version) writes its seeds as of now, never of 1970
  const copy = storedFlows(state, nowMs);
  const section = own ? joinFlows(copy, { since: own }) : copy;
  return opts && opts.whole ? withoutOldRemovals(section, nowMs) : boundFlows(section, nowMs);
}

function todayOf(state, nowMs) {
  const settings = isObject(state) && isObject(state.settings) ? state.settings : {};
  const hour = Number.isInteger(settings.rolloverHour) && settings.rolloverHour >= 0 && settings.rolloverHour <= 23 ? settings.rolloverHour : 0;
  return gameDay(Number.isFinite(nowMs) ? nowMs : 0, hour);
}

/** A Book line the owner keeps a decision on: not a payment they send (those travel as payments by hand). */
function isLine(rec) {
  return isObject(rec) && typeof rec.id === 'string' && rec.byHand !== true && typeof rec.mkey === 'string' && rec.mkey !== '' && Object.hasOwn(CADENCES, rec.cadence);
}

function hasLock(rec, field) {
  return Array.isArray(rec.locks) && rec.locks.includes(field);
}

/** A line added by hand that travels as an `added` entry: the owner's own, not a payment by hand. */
function isAddedLine(rec) {
  return isObject(rec) && rec.source === 'manual' && rec.byHand !== true && typeof rec.id === 'string' && Object.hasOwn(CADENCES, rec.cadence);
}

function addedValueOf(rec, p) {
  const name = String(rec.name || '').trim().slice(0, NAME_MAX);
  const value = {
    name: name || 'Unnamed line',
    amount: Math.min(AMOUNT_MAX, Math.max(1, Math.round(Number(rec.amount) || 0))),
    cadence: rec.cadence,
    day: isYmd(rec.anchor) ? rec.anchor : isYmd(rec.since) ? rec.since : '2000-01-01',
    category: Object.hasOwn(CATEGORIES, rec.category) ? rec.category : 'other',
    sub: rec.category === 'subscriptions',
  };
  if (p) value.p = p;
  return addedValue(value);
}

/**
 * The section seeded from what the record holds, every cell at 0: each verdict (a cut with the seeding day), each line
 * the owner took out of the Book (`active: false`) or put back in it (`active: true`; a dismissal wins a tie, as false
 * sorts first), each target, each line added by hand (not a payment by hand) under its content id, and the first day of
 * this device's record.
 * @param {object} state
 * @param {number} nowMs  the seeding moment (only its day is used, for a cut)
 * @returns {object}
 */
export function seedsOf(state, nowMs) {
  const doc = isObject(state) ? state : {};
  const out = { lines: {}, added: {}, targets: {} };
  const today = todayOf(doc, nowMs);
  const keys = seedKeys(doc);
  // a line's rank among its rivals (matchAll): the second and later lines of one payee and cadence that a decision on
  // one would reach seed keys of their own, so each keeps its decision, the same keys on two devices that hold the same
  // lines
  const { ranks } = matchAll({}, listOf(doc.recurring).filter(isLine), lineHistory(doc));
  for (const rec of listOf(doc.recurring)) {
    if (!isObject(rec) || rec.byHand === true) continue;
    if (isAddedLine(rec)) {
      // a line whose key is not its name's (the bank's own, kept while the line was charged) seeds the key's
      // fingerprint, so no device moves the line to its name's key, away from the bank's charges
      const named = merchantOf({ description: String(rec.name || '') }).mkey;
      const value = addedValueOf(rec, typeof rec.mkey === 'string' && rec.mkey && rec.mkey !== named ? payeeKey(rec.mkey) : undefined);
      if (value) out.added[keys.get(rec)] = { v: value, at: 0 };
    }
    if (!isLine(rec) && !isAddedLine(rec)) continue;
    const verdict = VERDICTS.includes(rec.verdict) ? rec.verdict : null;
    // the owner's word on whether the line recurs: taken out of the Book, or put back in it (both locked)
    const said = hasLock(rec, 'active') && typeof rec.active === 'boolean';
    if (!verdict && !said) continue;
    // a line by hand seeds its decisions under its own key, from the id its entry is seeded under (the same on two
    // devices that hold the line); any other line under its content's key of its rank
    let key;
    let facts;
    if (isAddedLine(rec)) {
      const id = keys.get(rec);
      key = addedLineKey(id);
      facts = addedLineFacts({ ...rec, added: id });
    } else {
      const found = lineFacts(rec);
      if (!found) continue;
      key = rankedKey(contentOf(found.facts), ranks.get(String(rec.id)) || 0);
      facts = found.facts;
    }
    const entry = out.lines[key] || { ...facts };
    if (verdict) entry.verdict = laterCell(entry.verdict || null, verdict === 'cut' ? { v: 'cut', at: 0, day: today } : { v: verdict, at: 0 });
    if (said) entry.active = laterCell(entry.active || null, { v: rec.active, at: 0 });
    out.lines[key] = entry;
  }
  const targets = isObject(doc.settings) && isObject(doc.settings.targets) ? doc.settings.targets : {};
  for (const category of Object.keys(targets)) {
    const cents = targets[category];
    if (Object.hasOwn(CATEGORIES, category) && isCents(cents)) out.targets[category] = { v: cents, at: 0 };
  }
  const own = ownFirstDay(doc);
  if (own) out.since = own;
  return sectionOf(tidy(out));
}

/**
 * When the record has no copy yet (the first load of this version), make it from what the record holds, at 0, before
 * the owner can change anything (app.js, at boot), and keep the seeds apart, so that the page can say once which of
 * them another device's replaced. Each line added by hand is linked to its entry (`added`).
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {boolean} true when a copy was made
 */
export function seedFlows(state, nowMs) {
  if (!isObject(state) || hasCopy(state)) return false;
  const seeds = seedsOf(state, nowMs);
  for (const [rec, key] of seedKeys(state)) {
    rec.added = key;
    // the entry this device has seen of the line (applyFlows): its own seed
    const seed = own(seeds.added, key);
    if (seed && !seed.deleted) { rec.addedAmt = seed.v.amount; rec.addedCad = seed.v.cadence; rec.addedDay = seed.v.day; }
  }
  storeCopy(state, seeds);
  state.share.flowsSeeds = tidy({ lines: seeds.lines, added: seeds.added, targets: seeds.targets });
  return true;
}

/* ------------------------------------------------------------------ matching decisions to lines */

/** Within 35% of the reference or $2, as detection holds charges (detect.js isNear). */
function near(amount, reference) {
  return Math.abs(amount - reference) <= Math.max(NEAR_CENTS, NEAR_SHARE * reference);
}

/**
 * What the record says of its lines beyond their own fields, for matching (`matchLines`, `decisionsFor`): the charges each
 * line holds (line id -> each price and day the bank charged it at, once), so a decision reaches a line at a price it was
 * charged at however its price moved since; and each account's bank id (account id -> the bank's), the same on every
 * device, to tell apart two lines of one content. One pass over the rows.
 * @param {object} state
 * @returns {{ charges: Map<string, { amount: number, day: string }[]>, accounts: Map<string, string> }}
 */
export function lineHistory(state) {
  const charges = new Map();
  const seen = new Set();
  for (const tx of listOf(isObject(state) ? state.txs : null)) {
    if (!isObject(tx) || typeof tx.recurringId !== 'string' || tx.source === 'manual' || tx.matchId || tx.flow === 'in' || !isYmd(tx.day)) continue;
    const amount = Math.round(Number(tx.amount) || 0);
    if (!(amount > 0)) continue;
    const mark = tx.recurringId + '|' + amount + '|' + tx.day;
    if (seen.has(mark)) continue;
    seen.add(mark);
    if (!charges.has(tx.recurringId)) charges.set(tx.recurringId, []);
    charges.get(tx.recurringId).push({ amount, day: tx.day });
  }
  const accounts = new Map();
  for (const account of listOf(isObject(state) ? state.accounts : null)) {
    if (!isObject(account) || typeof account.id !== 'string') continue;
    const ext = isObject(account.ext) && typeof account.ext.id === 'string' && account.ext.id ? account.ext.id : account.id;
    accounts.set(account.id, ext);
  }
  return { charges, accounts };
}

/** A key's content: what its hash reads (payee, cadence, price band, billing day). */
function contentOf(facts) {
  return facts.p + '|' + facts.cad + '|' + bandOf(facts.amt) + '|' + facts.dom;
}

/** The key of rank `rank` of a content: the content's own key at 0, then one per further line of that content. */
function rankedKey(content, rank) {
  return 'l' + hash13(rank ? content + '|#' + rank : content);
}

/** The rank a key holds within its content (0 for the content's own key), or 64 when it is none of the first 64. */
function rankOfKey(content, key) {
  for (let rank = 0; rank < 64; rank++) if (rankedKey(content, rank) === key) return rank;
  return 64;
}

/**
 * How near a line comes to a decision: the smallest gap between the decision's amount and a price of the line, with its
 * billing-day gap, or null when no price of the line reaches the decision. Each price must be within 35% of the
 * decision's amount or $2 (as detection holds charges). The line's price now reaches in the decision's own price band
 * whatever its billing day (a line billed every 30 days drifts through the month); in another band only on a billing
 * day within 3 (a price rise keeps the billing day; a second series of the payee seldom shares it). A price the bank
 * charged the line at reaches on a billing day within 3 of the decision's, so a decision stays with its line when the
 * price moves more than 35% (an introductory price ending) and after a card change and a rise.
 */
function reachOf(entry, option) {
  const band = bandOf(entry.amt);
  let best = null;
  const see = (amount, day, now) => {
    if (!near(amount, entry.amt)) return;
    const dayGap = domGap(entry.cad, domOf(entry.cad, day), entry.dom);
    if (!(dayGap <= DOM_NEAR || (now && bandOf(amount) === band))) return;
    const gap = Math.abs(amount - entry.amt);
    if (!best || gap < best.gap || (gap === best.gap && dayGap < best.day)) best = { gap, day: dayGap };
  };
  see(option.amount, option.rec.anchor, true);
  for (const point of option.points) see(point.amount, point.day, false);
  return best;
}

/**
 * Each decision's local line, with how near it comes (`matchLines`), each line's rank among its rivals (by seat), and the
 * lines another took over (`superseded`, counted as ended).
 * A line added by hand takes the decisions of its own key alone (addedLineKey), never one by content, and no line takes
 * its key's. Keys of one content (two lines of one payee, cadence, band and billing day) take one line each, the
 * nearest pair first; keys of different contents may share a line (a decision made at the old price and one at the new).
 */
function matchAll(lines, recs, history) {
  const charges = history && history.charges instanceof Map ? history.charges : new Map();
  const accounts = history && history.accounts instanceof Map ? history.accounts : new Map();
  const byP = new Map();
  const byOwnKey = new Map();
  for (const rec of recs) {
    if (!isObject(rec)) continue;
    // a line added by hand: its decisions are those of its own key
    if (isAddedLine(rec)) {
      if (isLinked(rec)) byOwnKey.set(addedLineKey(rec.added), String(rec.id));
      continue;
    }
    if (typeof rec.mkey !== 'string' || !rec.mkey || !Object.hasOwn(CADENCES, rec.cadence)) continue;
    const p = payeeKey(rec.mkey);
    if (!byP.has(p)) byP.set(p, []);
    // a tie is broken by what the line is, never by its local order or random id first: the latest anchor (after a card
    // change the old card's ended line keeps its charges), then the account's bank id and the line's own key
    const anchor = isYmd(rec.anchor) ? -diffDays('2000-01-01', rec.anchor) : Infinity;
    const found = lineFacts(rec);
    const option = {
      rec, amount: Math.round(Number(rec.amount) || 0), ended: rec.active === false ? 1 : 0, anchor,
      account: String(accounts.get(rec.accountId) || rec.accountId || ''), own: found ? found.key : '', facts: found ? found.facts : null,
      points: charges.get(String(rec.id)) || [], rank: 0,
    };
    byP.get(p).push(option);
  }
  // a line's rank among its rivals, by seat: the lines of its payee and cadence that a decision made on either of two
  // lines would reach (both ways, so a band crossing on one line and a billing day moved on the other never leave one
  // ranking the pair and the other ranking itself alone), so a charge posted a day late or a price that leaves its band
  // keeps both of two memberships of one gym in each other's rivals (their charges still reach). A seat is a line with
  // the lines that took over its charges (succession, below), ranked as its first line: by what neither changes, the
  // account's bank id, then the day and amount of the first charge (a line not charged yet after those that are, by its
  // own amount), then its id (the same on two devices that hold the same pair, unless account and first charge are equal
  // too). So a card change keeps the seat's rank wherever the new card's bank id sorts. Another series of the payee at a
  // price out of reach is no rival, so it moves no rank.
  const ranks = new Map();
  const superseded = new Set();
  const firstOf = (option) => {
    if (option.first) return option.first;
    let first = null;
    for (const point of option.points) if (!first || point.day < first.day || (point.day === first.day && point.amount < first.amount)) first = point;
    option.first = first || { day: '￿', amount: option.amount };
    return option.first;
  };
  const lastOf = (option) => {
    if (option.last !== undefined) return option.last;
    let last = isYmd(option.rec.anchor) && !option.points.length ? option.rec.anchor : '';
    for (const point of option.points) if (point.day > last) last = point.day;
    option.last = last;
    return last;
  };
  const byRank = (a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0)
    || (firstOf(a).day < firstOf(b).day ? -1 : firstOf(a).day > firstOf(b).day ? 1 : 0)
    || (firstOf(a).amount - firstOf(b).amount)
    || (String(a.rec.id) < String(b.rec.id) ? -1 : String(a.rec.id) > String(b.rec.id) ? 1 : 0);
  for (const list of byP.values()) {
    if (list.length < 2) {
      for (const option of list) ranks.set(String(option.rec.id), 0);
      continue;
    }
    // succession: a line whose last charge (its anchor when it holds none) comes before the first charge of a running,
    // charged line of its payee and cadence that a decision on it reaches was superseded (a card change), whatever
    // detection keeps in the Book (a line the owner renamed or made for an Add never lapses): it counts as ended, and
    // its seat goes on in the earliest such line. Read from the bank's rows, the same on every device that holds them
    for (const option of list) {
      const last = lastOf(option);
      if (!option.facts || !last) continue;
      let next = null;
      for (const other of list) {
        if (other === option || other.rec.active === false || other.rec.cadence !== option.rec.cadence || !other.points.length) continue;
        if (!(firstOf(other).day > last) || !reachOf(option.facts, other)) continue;
        if (!next || firstOf(other).day < firstOf(next).day || (firstOf(other).day === firstOf(next).day && byRank(other, next) < 0)) next = other;
      }
      if (!next) continue;
      option.ended = 1;
      superseded.add(String(option.rec.id));
      // of two lines that a third took over, the seat is the one that stopped last
      const held = next.prev;
      if (!held || lastOf(option) > lastOf(held) || (lastOf(option) === lastOf(held) && byRank(option, held) < 0)) next.prev = option;
    }
    const headOf = (option) => {
      let head = option;
      for (let step = 0; head.prev && step < list.length; step++) head = head.prev;
      return head;
    };
    const seats = new Map();
    for (const option of list) {
      const head = headOf(option);
      if (!seats.has(head)) seats.set(head, []);
      seats.get(head).push(option);
    }
    const reaches = (a, b) => a.rec.cadence === b.rec.cadence && !!((a.facts && reachOf(a.facts, b)) || (b.facts && reachOf(b.facts, a)));
    const heads = [...seats.keys()];
    for (const head of heads) {
      const members = seats.get(head);
      const rivals = heads.filter((other) => other === head || seats.get(other).some((one) => members.some((mine) => reaches(mine, one))));
      const rank = rivals.length < 2 ? 0 : rivals.sort(byRank).indexOf(head);
      for (const option of members) {
        option.rank = rank;
        ranks.set(String(option.rec.id), rank);
      }
    }
  }
  const out = new Map();
  const groups = new Map();
  for (const key of Object.keys(lines || {})) {
    if (byOwnKey.has(key)) { out.set(key, { id: byOwnKey.get(key), gap: 0 }); continue; }
    // a line by hand's key that this device holds no line for (its entry not made here yet, or removed): it waits
    if (isAddedLineKey(key, lines[key])) continue;
    const content = contentOf(lines[key]);
    if (!groups.has(content)) groups.set(content, []);
    groups.get(content).push(key);
  }
  for (const [content, keys] of groups) {
    const base = rankedKey(content, 0);
    const pairs = [];
    for (const key of keys) {
      const entry = lines[key];
      // the key's rank, worked out only when a line of its cadence is in reach (up to 64 hashes)
      let keyRank = key === base ? 0 : null;
      for (const option of byP.get(entry.p) || []) {
        const reach = reachOf(entry, option);
        if (!reach) continue;
        // a key goes to the line of its own rank among the rivals, whatever that line's price or billing day now
        const same = option.rec.cadence === entry.cad;
        if (same && keyRank === null) keyRank = rankOfKey(content, key);
        const rankGap = same ? Math.abs(keyRank - option.rank) : 0;
        // the same cadence first, then the nearest price; at an equal price a line still running before an ended one
        // (after a card change, whatever the new card's billing day: the account is ignored), then the billing day
        pairs.push({
          key, option, reach,
          score: [same ? 0 : 1, reach.gap, option.ended, reach.day > DOM_NEAR ? 1 : 0, reach.day, rankGap, option.anchor, option.account, option.own, String(option.rec.id), key],
        });
      }
    }
    pairs.sort((a, b) => (lessThan(a.score, b.score) ? -1 : lessThan(b.score, a.score) ? 1 : 0));
    const taken = new Set();
    for (const { key, option, reach } of pairs) {
      if (out.has(key) || taken.has(option)) continue;
      out.set(key, { id: String(option.rec.id), gap: reach.gap });
      if (keys.length > 1) taken.add(option);
    }
  }
  return { match: out, ranks, superseded };
}

/**
 * Which local line each decision reaches: a line added by hand its own key's alone (addedLineKey); any other, one of the
 * same payee key at a price near the decision's (`reachOf`), the account aside; of those, one of the same cadence
 * first, then the nearest price, then a line still running (not ended, not superseded), then a billing day within 3,
 * then the nearest billing day,
 * then the line of the key's rank among its rivals, the latest anchor, the account's bank id, the line's own key and
 * last its id. Keys of one content take one line each. A decision no line matches waits.
 * @param {object} lines  key -> entry (a section's `lines`)
 * @param {object[]} recs  local lines (or candidates: anything with id, mkey, cadence, amount, anchor)
 * @param {{ charges?: Map, accounts?: Map }} [history]  lineHistory(state)
 * @returns {Map<string, string>} decision key -> line id
 */
export function matchLines(lines, recs, history) {
  const out = new Map();
  for (const [key, one] of matchAll(lines, recs, history).match) out.set(key, one.id);
  return out;
}

function lessThan(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i];
  }
  return false;
}

/**
 * The decisions that reach each local line: per field the later cell of every key that reaches it (`laterCell`, the
 * same on every device), so a decision made at another price is never ignored; a key of another series of the payee is
 * kept from reaching by `reachOf`. `keys` lists every key that reaches the line, the nearest first; `from` names, per
 * field, the key holding the cell given (a new decision on that field is written there, so an Undo puts it back);
 * `key` holds the line's latest cell (else it is the nearest); `rank` is the line's rank among its rivals (matchAll).
 * Decisions that reach no line wait (`waiting`). `superseded` names the lines another took over (a card change: their
 * decisions are that line's; the face lists none of them).
 * @param {object} section  (checked)
 * @param {object[]} recs
 * @param {{ charges?: Map, accounts?: Map }} [history]  lineHistory(state)
 * @returns {{ byLine: Map<string, { key: string, keys: string[], from: object, rank: number, sub: object|null, verdict: object|null, active: object|null }>, waiting: string[], ranks: Map<string, number>, superseded: Set<string> }}
 */
export function decisionsFor(section, recs, history) {
  const lines = (section && section.lines) || {};
  const { match, ranks, superseded } = matchAll(lines, recs, history);
  const reach = new Map();
  for (const [key, one] of match) {
    if (!reach.has(one.id)) reach.set(one.id, []);
    reach.get(one.id).push({ key, gap: one.gap });
  }
  const byLine = new Map();
  const waiting = Object.keys(lines).filter((key) => !match.has(key));
  for (const [id, found] of reach) {
    const keys = found.sort((a, b) => (a.gap - b.gap) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((one) => one.key);
    const one = { key: keys[0], keys, from: {}, rank: ranks.get(id) || 0, sub: null, verdict: null, active: null };
    let latest = null;
    for (const field of LINE_FIELDS) {
      let held = null;
      for (const key of keys) {
        const cell = lines[key][field];
        if (!cell) continue;
        // the later cell by the merge's own order; of two equal cells the nearer key's stays
        if (!held || (laterCell(held.cell, cell) === cell && canon(held.cell) !== canon(cell))) held = { cell, key };
      }
      if (!held) continue;
      one[field] = held.cell;
      one.from[field] = held.key;
      if (!latest || (laterCell(latest.cell, held.cell) === held.cell && canon(latest.cell) !== canon(held.cell))) latest = held;
    }
    if (latest) one.key = latest.key;
    byLine.set(id, one);
  }
  return { byLine, waiting: waiting.sort(), ranks, superseded };
}

/** The live value of a cell, or undefined for none (absent or a removal). */
export function cellValue(cell) {
  return cell && !cell.deleted ? cell.v : undefined;
}

/* ------------------------------------------------------------------ the record follows the copy */

/**
 * Bring the record to the copy (after detection, detect.refresh, and when a round brings cells): each verdict and each
 * "not a recurring bill" reaches its line, locked as the owner's; a removal gives the field back to detection; a line
 * confirmed as a subscription that this device has no line for is made from its newest matching bank row (held by the
 * owner: it does not lapse); each line added by hand is made or brought to its entry, and goes when its entry is a
 * removal; the targets are the copy's. Nothing changes when the record already agrees.
 * @param {object} state  (mutated)
 * @param {number} nowMs
 * @returns {boolean} true when the record changed
 */
export function applyFlows(state, nowMs) {
  if (!isObject(state) || !hasCopy(state)) return false;
  let copy = sectionOf(state.share.flows);
  if (!Array.isArray(state.recurring)) state.recurring = [];
  let changed = false;
  const today = todayOf(state, nowMs);
  // the bank rows by payee fingerprint, made once per call when first needed: each merchant key is hashed once
  let index = null;
  const rows = () => index || (index = rowIndex(state));
  // the entries that learned the bank's payee key here (below)
  let learned = false;
  // lines added by hand: made, brought to their entry, or removed
  for (const id of Object.keys(copy.added || {})) {
    let cell = copy.added[id];
    const at = state.recurring.findIndex((rec) => isObject(rec) && rec.added === id && rec.byHand !== true);
    if (cell.deleted) {
      if (at >= 0) {
        const [gone] = state.recurring.splice(at, 1);
        // its charges are let go, for detection to read again
        for (const tx of listOf(state.txs)) if (isObject(tx) && tx.recurringId === gone.id) tx.recurringId = null;
        changed = true;
      }
      continue;
    }
    let v = cell.v;
    if (at >= 0 && !v.p && charged(state, state.recurring[at].id)) {
      // the bank charged the line here: its entry learns the bank's payee key, so every device links that payee's
      // charges to the line whatever its name (mkeyFor). A device action, written into the cell as it is (its stamp and
      // Undo mark kept), so no edit is outranked; every device that links a charge writes the same value, and of the
      // cell with it and the same cell without, the merge's order keeps the one with it (its "p" sorts before "sub")
      const p = payeeKey(state.recurring[at].mkey);
      if (p) {
        v = { ...v, p };
        cell = { ...cell, v };
        copy.added[id] = cell;
        learned = true;
      }
    }
    const mkey = mkeyFor(state, v, rows());
    if (at < 0) {
      // since: the day it was added, as on the device that added it (the entry's stamp; a seed's is no time: today)
      const added = cell.at >= TIME_FLOOR ? todayOf(state, cell.at) : today;
      const made = makeRecurring({
        name: v.name, mkey, amount: v.amount, cadence: v.cadence, anchor: v.day, category: v.category, source: 'manual',
        since: cell.at >= TIME_FLOOR ? (v.day > added ? v.day : added) : today, locks: ['name', 'category', 'purpose'], added: id,
        addedAmt: v.amount, addedCad: v.cadence, addedDay: v.day,
      });
      if (cell.at >= TIME_FLOOR) made.addedAt = cell.at;
      state.recurring.push(made);
      changed = true;
      continue;
    }
    const rec = state.recurring[at];
    const isCharged = charged(state, rec.id);
    for (const field of ['name', 'category']) if (rec[field] !== v[field]) { rec[field] = v[field]; changed = true; }
    // the amount, cadence and billing day follow the entry while the bank has not charged the line; once it has,
    // detection's reading stands (the same on every device that holds the rows). A newer entry that changes one (the
    // owner edited the price, the cadence or the date, here or on another device) is applied and held as the owner's,
    // charged here or not, as the sheet that made the edit holds it: so after the first charge every device keeps the
    // owner's value, not only the one that made the edit. `addedAt`, `addedAmt`, `addedCad` and `addedDay`, fields of
    // this device only, are the stamp, amount, cadence and day of the entry last applied, so an entry restamped with the
    // same values (an Undo, a rename) moves nothing (a seed, at 0, is no edit: it never moves a charged line, and is not
    // noted)
    const timed = cell.at >= TIME_FLOOR;
    const newer = timed && !(Number.isFinite(rec.addedAt) && rec.addedAt >= cell.at);
    const last = { amount: rec.addedAmt, cadence: rec.addedCad, anchor: rec.addedDay };
    for (const [field, from] of [['amount', 'amount'], ['cadence', 'cadence'], ['anchor', 'day']]) {
      if (!(newer && last[field] !== undefined && last[field] !== v[from])) {
        // no edit: an uncharged line follows the entry, as it was typed
        if (!isCharged && rec[field] !== v[from]) { rec[field] = v[from]; changed = true; }
        continue;
      }
      // `addedPast`, this device's only: per field, the entry's value before each edit applied here and whether the
      // line held it then, so an Undo of an edit (an Undo's cell bringing back such a value) puts the line back as it
      // was before that edit, detection's reading or the owner's, rather than holding the typed price
      const past = isObject(rec.addedPast) ? listOf(rec.addedPast[field]) : [];
      const back = cell.undo ? past.map((one) => one[0]).lastIndexOf(v[from]) : -1;
      const keep = back >= 0 ? past.slice(0, back) : [...past, [last[field], hasLock(rec, field)]].slice(-20);
      rec.addedPast = { ...(isObject(rec.addedPast) ? rec.addedPast : {}), [field]: keep };
      if (back >= 0 && !past[back][1]) {
        // back to a value the line did not hold: unlocked, at the entry's value, as on the device that undid the edit,
        // for detection to read again (a line by hand takes a price from its charges only once it finds their series)
        if (Array.isArray(rec.locks)) rec.locks = rec.locks.filter((one) => one !== field);
        rec[field] = v[from];
      } else {
        rec[field] = v[from];
        addLock(rec, field);
      }
      changed = true;
    }
    if (timed && rec.addedAt !== cell.at) { rec.addedAt = cell.at; changed = true; }
    if (rec.addedAmt !== v.amount) { rec.addedAmt = v.amount; changed = true; }
    if (rec.addedCad !== v.cadence) { rec.addedCad = v.cadence; changed = true; }
    if (rec.addedDay !== v.day) { rec.addedDay = v.day; changed = true; }
    // the key follows the entry while the bank has not charged the line: a name changed as the bank will print it, or a
    // key the bank's rows give this device once it holds one (the entry's `p`), so the bank's own charges take the line
    // over. Its decisions do not move with it: they are its own key's
    if (mkey !== rec.mkey && !isCharged) { rec.mkey = mkey; changed = true; }
  }
  if (learned) {
    storeCopy(state, copy);
    changed = true;
  }
  // a line by hand not charged yet on the bank's key through its entry's `p` (moved to it once `p` arrived, made with it,
  // or picked from the bank's merchants) takes over the bank's charges of that payee that a line detection found holds
  // (renamed here while the bank's rows came, before `p` arrived; or its entry came back after this device's Undo of the
  // add): such a line, running, near its amount, that the owner never touched or decided on goes, and its charges are
  // let go, so detection links them to the line by hand, as on the device that learned `p`
  const toBank = state.recurring.filter((rec) => {
    if (!isLinked(rec) || typeof rec.mkey !== 'string' || !rec.mkey) return false;
    const cell = own(copy.added, rec.added);
    return !!cell && !cell.deleted && !!cell.v.p && payeeKey(rec.mkey) === cell.v.p && !charged(state, rec.id);
  });
  if (toBank.length) changed = dropTakenOver(state, copy, toBank) || changed;
  const history = lineHistory(state);
  // decisions on lines: per field the later cell of the keys that reach each line (a line by hand's own key needs no
  // merchant key: a name such as "#" has none)
  const recs = state.recurring.filter((rec) => isLine(rec) || isLinked(rec));
  const { byLine } = decisionsFor(copy, recs, history);
  for (const rec of recs) {
    const one = byLine.get(String(rec.id));
    if (one && one.verdict) {
      const v = cellValue(one.verdict);
      const want = v === undefined ? null : v;
      if ((rec.verdict || null) !== want) { rec.verdict = want; changed = true; }
      if (want !== null && !hasLock(rec, 'verdict')) { addLock(rec, 'verdict'); changed = true; }
    } else if (hasLock(rec, 'verdict') && rec.verdict != null) {
      // a verdict no decision gives the line any more (its decision now reaches another line, as after a card change):
      // released, as a removal would
      rec.verdict = null;
      changed = true;
    }
    const v = one && one.active ? cellValue(one.active) : undefined;
    if (v === undefined) {
      // no decision (a removal, or none that reaches the line): detection's own reading of the line, unlocked. Detection
      // ends only a line it found whose cadence, amount, name and anchor the owner left alone, and never a line made for
      // a confirmed subscription (detect.js settleEntry): a line the owner made or holds stays in the Book
      if (hasLock(rec, 'active')) {
        rec.locks = rec.locks.filter((field) => field !== 'active');
        rec.active = !(rec.source === 'detected' && typeof rec.madeFor !== 'string' && !OWNER_HELD.some((field) => hasLock(rec, field)) && lapsed(rec, today));
        changed = true;
      }
    } else {
      if (rec.active !== v) { rec.active = v; changed = true; }
      if (!hasLock(rec, 'active')) { addLock(rec, 'active'); changed = true; }
    }
  }
  // a line made for a subscription confirmed elsewhere goes when the confirmation does (an Undo of Add, or Not one), so
  // the record is back to what detection says, and when its decision reaches another running line (detection found the
  // series, as after a card change), so one subscription is never listed twice; its charges are let go, for detection
  // to read again
  const reachedBy = new Map();
  for (const [id, one] of byLine) for (const key of one.keys) reachedBy.set(key, id);
  const running = new Set(state.recurring.filter((rec) => isObject(rec) && rec.active !== false).map((rec) => String(rec.id)));
  for (let i = state.recurring.length - 1; i >= 0; i--) {
    const rec = state.recurring[i];
    if (!isObject(rec) || typeof rec.madeFor !== 'string') continue;
    const one = byLine.get(String(rec.id));
    const mine = own(copy.lines, rec.madeFor);
    const elsewhere = reachedBy.get(rec.madeFor);
    const moved = !!elsewhere && elsewhere !== String(rec.id) && running.has(elsewhere);
    if (one && one.sub ? cellValue(one.sub) === true : !moved && !!mine && cellValue(mine.sub) === true) continue;
    state.recurring.splice(i, 1);
    for (const tx of listOf(state.txs)) if (isObject(tx) && tx.recurringId === rec.id) tx.recurringId = null;
    byLine.delete(String(rec.id));
    changed = true;
  }
  // a subscription confirmed that this device has no line for: made from its newest matching bank row that no line of
  // the record holds, when there is one (`madeFor` naming the decision: it does not lapse, detect.js settleEntry, and
  // its cadence is detection's to correct once it finds the series); with no such row yet, the decision waits
  const matched = new Set([...byLine.values()].flatMap((one) => one.keys));
  const lineIds = new Set(state.recurring.filter(isObject).map((rec) => rec.id));
  for (const key of Object.keys(copy.lines || {})) {
    const entry = copy.lines[key];
    if (matched.has(key) || cellValue(entry.sub) !== true) continue;
    const row = newestRow(entry, rows(), lineIds);
    if (!row) continue;
    state.recurring.push(makeRecurring({
      name: row.merchant || row.mkey, mkey: row.mkey, accountId: row.accountId, amount: Math.round(row.amount), cadence: entry.cad,
      anchor: row.day, category: 'subscriptions', purpose: row.purpose || 'personal', source: 'detected', locks: ['category'],
      madeFor: key,
    }));
    matched.add(key);
    changed = true;
  }
  // the targets are the copy's
  if (copy.targets) {
    if (!isObject(state.settings)) state.settings = {};
    if (!isObject(state.settings.targets)) state.settings.targets = {};
    const targets = state.settings.targets;
    for (const category of Object.keys(copy.targets)) {
      const v = cellValue(copy.targets[category]);
      if (v === undefined) { if (Object.hasOwn(targets, category)) { delete targets[category]; changed = true; } }
      else if (targets[category] !== v) { targets[category] = v; changed = true; }
    }
  }
  return changed;
}

/**
 * The lines detection found on the bank's key of a line by hand not charged yet (applyFlows): each running one of that
 * key, near the line by hand's amount, with no lock, not made for an Add and reached by no decision, goes; its charges
 * are let go, for detection to link to the line by hand.
 * @returns {boolean} true when a line went
 */
function dropTakenOver(state, copy, hands) {
  const keys = new Set(hands.map((hand) => hand.mkey));
  const taken = (rec) => isObject(rec) && rec.source === 'detected' && rec.byHand !== true && rec.active !== false && keys.has(rec.mkey)
    && !(Array.isArray(rec.locks) && rec.locks.length) && typeof rec.madeFor !== 'string';
  if (!state.recurring.some(taken)) return false;
  const recs = state.recurring.filter((rec) => isLine(rec) || isLinked(rec));
  const { byLine } = decisionsFor(copy, recs, lineHistory(state));
  let dropped = false;
  for (const hand of hands) {
    for (let i = state.recurring.length - 1; i >= 0; i--) {
      const rec = state.recurring[i];
      if (rec === hand || !taken(rec) || rec.mkey !== hand.mkey || byLine.has(String(rec.id))) continue;
      if (!near(Math.round(Number(rec.amount) || 0), Math.round(Number(hand.amount) || 0))) continue;
      state.recurring.splice(i, 1);
      for (const tx of listOf(state.txs)) if (isObject(tx) && tx.recurringId === rec.id) tx.recurringId = null;
      dropped = true;
    }
  }
  return dropped;
}

function addLock(rec, field) {
  if (!Array.isArray(rec.locks)) rec.locks = [];
  if (!rec.locks.includes(field)) rec.locks.push(field);
}

function charged(state, id) {
  return listOf(state.txs).some((tx) => isObject(tx) && tx.recurringId === id && tx.source !== 'manual');
}

/** Not charged for a cadence and a half (detection's own rule for a line it found). */
function lapsed(rec, today) {
  if (!isYmd(rec.anchor) || !Object.hasOwn(CADENCES, rec.cadence)) return false;
  return diffDays(rec.anchor, today) > 1.5 * CADENCES[rec.cadence].days;
}

/**
 * The bank rows by payee fingerprint: for each, the first merchant key met with it and its charges (spends out, not the
 * owner's own, not matched). Each distinct merchant key is hashed once (byhand.js does the same), so applyFlows costs
 * one pass over the rows however many entries wait.
 * @returns {Map<string, { mkey: string, spends: object[] }>}
 */
function rowIndex(state) {
  const hashed = new Map();
  const byP = new Map();
  for (const tx of listOf(state.txs)) {
    if (!isObject(tx) || typeof tx.mkey !== 'string' || !tx.mkey) continue;
    let p = hashed.get(tx.mkey);
    if (p === undefined) { p = payeeKey(tx.mkey); hashed.set(tx.mkey, p); }
    let one = byP.get(p);
    if (!one) { one = { mkey: tx.mkey, spends: [] }; byP.set(p, one); }
    if (tx.source !== 'manual' && tx.kind === 'spend' && tx.flow === 'out' && !tx.matchId && isYmd(tx.day)) one.spends.push(tx);
  }
  return byP;
}

/** The merchant key a line added by hand takes: the bank's own, from a row whose key has the entry's fingerprint; else its name's. */
function mkeyFor(state, v, index) {
  if (v.p) {
    const one = index.get(v.p);
    if (one) return one.mkey;
    for (const rec of listOf(state.recurring)) if (isObject(rec) && typeof rec.mkey === 'string' && rec.mkey && payeeKey(rec.mkey) === v.p) return rec.mkey;
  }
  return merchantOf({ description: v.name }).mkey;
}

/**
 * This device's newest bank charge of a decision's payee, within 35% of its amount (or $2), that no line of the record
 * holds (a row a line holds is that line's: the decision reaches it there, by the price it was charged); null when it
 * holds none yet.
 */
function newestRow(entry, index, lineIds) {
  let best = null;
  for (const tx of (index.get(entry.p) || { spends: [] }).spends) {
    if (typeof tx.recurringId === 'string' && lineIds.has(tx.recurringId)) continue;
    const amount = Math.round(Number(tx.amount) || 0);
    if (!near(amount, entry.amt)) continue;
    if (!best || tx.day > best.day || (tx.day === best.day && String(tx.id) > String(best.id))) best = tx;
  }
  return best;
}

/* ------------------------------------------------------------------ the owner's decisions */

function stampAbove(now, ...cells) {
  const top = Math.max(0, ...cells.filter(Boolean).map((cell) => cell.at));
  return Math.min(MAX_STAMP, Math.max(Math.round(Number.isFinite(now) ? now : 0), top + 2));
}

/**
 * The owner decided on a line (Add or Not one, Keep, Review or Cut, Not a recurring bill or back in the Book): the
 * decision is written to a line added by hand's own key (addedLineKey); for any other line, to the entry that already
 * reaches the line (else a new one, keyed by the line's content and its rank among its rivals), stamped above every
 * cell of that field that reaches the line, and the record follows. `value` undefined or null takes the
 * decision back (a removal: no decision). A cut carries the day it was made.
 * @param {object} state  (mutated)
 * @param {object} line   a local line, or a candidate with mkey, cadence, amount and anchor
 * @param {'sub'|'verdict'|'active'} field
 * @param {*} value
 * @param {number} nowMs
 * @param {{ cad?: string }} [opts]  the cadence the owner chose for a suggestion of unknown cadence
 * @returns {string|null} the key written
 */
export function decideLine(state, line, field, value, nowMs, opts = {}) {
  if (!isObject(state) || !LINE_FIELDS.includes(field)) return null;
  const subject = opts.cad && Object.hasOwn(CADENCES, opts.cad) ? { ...line, cadence: opts.cad } : line;
  // a line added by hand (linked to its entry, or linked by the seeding just below): its own key, whatever its facts
  const byHand = isAddedLine(line) && !(opts.cad && opts.cad !== line.cadence);
  const own = byHand ? null : lineFacts(subject);
  if (!byHand && !own) return null;
  seedFlows(state, nowMs);
  const copy = storedFlows(state);
  const lines = copy.lines || {};
  if (byHand) {
    if (!isLinked(line)) return null;
    const key = addedLineKey(line.added);
    const at = stampAbove(nowMs, lines[key] && lines[key][field]);
    const entry = lines[key] ? { ...lines[key] } : addedLineFacts(line);
    entry[field] = cellFor(state, field, value, at, nowMs);
    storeCopy(state, { ...copy, lines: { ...lines, [key]: entry } });
    applyFlows(state, nowMs);
    return key;
  }
  // the entry that already reaches the line, found as applyFlows finds it: with every local line present, so a key that
  // belongs to another series of the payee is never taken for this one
  const recs = listOf(state.recurring).filter(isLine);
  const inRecord = !(opts.cad && opts.cad !== line.cadence) && recs.some((rec) => rec === line || String(rec.id) === String(line.id));
  const probe = { ...subject, id: '\u0000subject' };
  const target = inRecord ? String(line.id) : probe.id;
  const { byLine, ranks } = decisionsFor(copy, inRecord ? recs : [...recs, probe], lineHistory(state));
  const one = byLine.get(target);
  // the key: the one holding the cell of this field the line shows (so an Undo puts that cell back as it was); else the
  // line's own key of its rank among its rivals (the second of two memberships of one gym takes its own), or the first
  // of that content's keys free in the copy
  const reachingKeys = one ? one.keys : [];
  let key = one && one.from[field];
  if (!key) {
    const content = contentOf(own.facts);
    const usable = (k) => !Object.hasOwn(lines, k) || reachingKeys.includes(k);
    const rank = ranks.get(target) || 0;
    key = rankedKey(content, rank);
    for (let r = 0; !usable(key) && r < 64; r++) key = rankedKey(content, r);
  }
  const reaching = reachingKeys.map((k) => lines[k][field]);
  const at = stampAbove(nowMs, lines[key] && lines[key][field], ...reaching);
  const entry = lines[key] ? { ...lines[key] } : { ...own.facts };
  entry[field] = cellFor(state, field, value, at, nowMs);
  storeCopy(state, { ...copy, lines: { ...lines, [key]: entry } });
  applyFlows(state, nowMs);
  return key;
}

/** A decision's cell: a removal for none, a cut with the day it was made, else the value. */
function cellFor(state, field, value, at, nowMs) {
  if (value === undefined || value === null) return { deleted: true, at };
  if (field === 'verdict' && value === 'cut') return { v: 'cut', at, day: todayOf(state, nowMs) };
  return { v: value, at };
}

/**
 * The owner set or cleared a category's monthly target: written to the copy (a removal when cleared) and to the record.
 * @param {object} state  (mutated)
 * @param {string} category
 * @param {number|null} cents
 * @param {number} nowMs
 */
export function noteTarget(state, category, cents, nowMs) {
  if (!isObject(state) || !Object.hasOwn(CATEGORIES, category)) return false;
  seedFlows(state, nowMs);
  const copy = storedFlows(state);
  const targets = { ...(copy.targets || {}) };
  const at = stampAbove(nowMs, targets[category]);
  targets[category] = isCents(cents) ? { v: cents, at } : { deleted: true, at };
  storeCopy(state, { ...copy, targets });
  if (!isObject(state.settings)) state.settings = {};
  if (!isObject(state.settings.targets)) state.settings.targets = {};
  if (isCents(cents)) state.settings.targets[category] = cents; else delete state.settings.targets[category];
  return true;
}

/**
 * The owner added or edited a line by hand (the Book's "Add an entry", or "+ Add a subscription"): its entry is written
 * from the line, under the line's link (`added`), made from its content the first time.
 * @param {object} state  (mutated)
 * @param {object} rec    the line, in the record
 * @param {number} nowMs
 * Its decisions are its own key's (addedLineKey), which no edit moves, so nothing is carried.
 * @param {{ picked?: boolean, changed?: string[] }} [opts]  `picked`: the line's key is a bank merchant's the owner
 *   picked (its fingerprint travels); `changed`: the fields the save changed
 * @returns {string|null} the entry's id
 */
export function noteAdded(state, rec, nowMs, opts = {}) {
  if (!isObject(state) || !isAddedLine(rec)) return null;
  // a record with no copy yet makes it first, at this moment (the line just added among its seeds, linked)
  const seeded = seedFlows(state, nowMs);
  const copy = storedFlows(state);
  const added = { ...(copy.added || {}) };
  let id = isString(rec.added) && ADDED_KEY.test(rec.added) ? rec.added : null;
  if (!id) {
    // a content id makes two devices that add one bill meet on one entry; a second line of the same content on this
    // device (its content id live, or linked to another line) takes an id of its own, so it never rewrites the first
    const content = addedKey(rec);
    const taken = (added[content] && !added[content].deleted)
      || listOf(state.recurring).some((other) => other !== rec && isObject(other) && other.added === content);
    id = taken ? 'a' + hash13(addedContent(rec) + '|' + String(rec.id)) : content;
  }
  // the bank's payee key travels as its fingerprint (`p`): when the owner picked the merchant, or once the bank charged
  // the line (as applyFlows learns it); and every later edit keeps it, a rename included, so every device keeps linking
  // that payee's charges to the line whatever its name
  const entry = added[id] && !added[id].deleted ? added[id].v : null;
  const isCharged = charged(state, rec.id);
  const bank = payeeKey(typeof rec.mkey === 'string' ? rec.mkey : '');
  const p = (opts.picked && bank) || (entry && entry.p) || (isCharged && bank) || undefined;
  const value = addedValueOf(rec, p);
  if (!value) return null;
  // once the bank charges the line, its amount, cadence and date are detection's reading, not the owner's: the entry
  // keeps its own unless the owner set them (the sheet locks what it changes; `changed` names them too), so a rename or a
  // verdict never sends this device's reading as an edit (applyFlows holds an edited value as the owner's)
  if (entry && isCharged) {
    const set = (field) => hasLock(rec, field) || (Array.isArray(opts.changed) && opts.changed.includes(field));
    if (!set('amount')) value.amount = entry.amount;
    if (!set('cadence')) value.cadence = entry.cadence;
    if (!set('anchor')) value.day = entry.day;
  }
  rec.added = id;
  // nothing to write when the copy already holds this entry as it is (a copy made just now writes it at this moment:
  // its seeds read the line just added as one of the record's, at stamp 0)
  if (!seeded && added[id] && !added[id].deleted && canon(added[id].v) === canon(value)) return id;
  added[id] = { v: value, at: stampAbove(nowMs, added[id]) };
  storeCopy(state, { ...copy, added });
  return id;
}

/**
 * The entry of a line added by hand as the copy holds it (live), or null: the sheet reads its `p` (a line whose entry
 * carries the bank's payee key keeps the bank's merchant key through a rename).
 * @param {object} state
 * @param {object} rec
 * @returns {object|null}
 */
export function entryOf(state, rec) {
  if (!isLinked(rec)) return null;
  const cell = own(storedFlows(state).added, rec.added);
  return cell && !cell.deleted ? cell.v : null;
}

/** How many lines added by hand are live in the copy (the UI refuses a 41st). */
export function addedCount(state) {
  const copy = storedFlows(state);
  return Object.keys(copy.added || {}).filter((id) => !copy.added[id].deleted).length;
}

/* ------------------------------------------------------------------ Undo */

/**
 * Undo of the owner's own change (`store.onRestore`, beside restampGame): the copy put back is the copy before the Undo
 * joined with the copy of the record put back; then every cell whose value differs between the two copies is given
 * the value put back, or a removal when the copy put back has none, stamped 1 above the highest stamp either holds and
 * marked `undo: true`. So an Undo travels, an undone first decision included, and an edit made on another device after
 * seeing the value beats it. The floor is never undone.
 * @param {object} before  the record just before the Undo
 * @param {object} after   the record put back (mutated)
 * @param {number} [nowMs]  the moment of the Undo (for a side with no copy, whose seeds a cut dates)
 * @returns {boolean} true when a cell was restamped
 */
export function restampFlows(before, after, nowMs) {
  if (!isObject(before) || !isObject(after)) return false;
  // neither side ever held a copy: nothing of the section to undo
  if (!hasCopy(before) && !hasCopy(after)) return false;
  // a side with no copy (a record put back from before its copy was made) reads as its seeds, made at this moment, or
  // at the latest stamp the other side holds: never at 1970
  const time = Number.isFinite(nowMs) && nowMs >= TIME_FLOOR ? nowMs : latestTime(storedFlows(hasCopy(before) ? before : after));
  const was = storedFlows(before, time);
  const now = storedFlows(after, time);
  const out = joinFlows(was, now);
  let wrote = false;
  const restamp = (prior, put, extra) => {
    if (valueOf(prior) === valueOf(put)) return null;
    wrote = true;
    const at = Math.min(MAX_STAMP, Math.max(prior ? prior.at : 0, put ? put.at : 0) + 1);
    const cell = put && !put.deleted ? { v: put.v, at, undo: true } : { deleted: true, at, undo: true };
    for (const fact of extra) {
      const value = (put && put[fact]) || (prior && prior[fact]);
      if (value !== undefined) cell[fact] = value;
    }
    return cell;
  };
  for (const key of union(was.lines, now.lines)) {
    const p = own(was.lines, key) || {};
    const q = own(now.lines, key) || {};
    for (const field of LINE_FIELDS) {
      const cell = restamp(p[field] || null, q[field] || null, field === 'verdict' && q[field] && !q[field].deleted && q[field].v === 'cut' ? ['day'] : []);
      if (cell) out.lines[key] = { ...out.lines[key], [field]: cell };
    }
  }
  // a line by hand's `p`, the bank's payee key once picked or learned (applyFlows), is a fact of the line, not an edit: an
  // Undo neither takes it back (two entries that differ in it alone are one) nor drops it from the value put back
  for (const key of union(was.added, now.added)) {
    const prior = own(was.added, key) || null;
    const put = own(now.added, key) || null;
    const learned = [put, prior].map((cell) => cell && !cell.deleted && cell.v.p).find(Boolean);
    const cell = restamp(withoutP(prior), withoutP(put), []);
    if (!cell) continue;
    if (!cell.deleted && learned) cell.v = { ...put.v, p: learned };
    out.added = { ...(out.added || {}), [key]: cell };
  }
  for (const name of ['targets', 'offers', 'into']) {
    for (const key of union(was[name], now[name])) {
      const extra = name === 'into' ? (key[0] === 'i' ? ['day', 'fp'] : key[0] === 'f' || key[0] === 'q' ? ['day'] : []) : [];
      const cell = restamp(own(was[name], key) || null, own(now[name], key) || null, extra);
      if (cell) out[name] = { ...(out[name] || {}), [key]: cell };
    }
  }
  for (const key of union(was.inlets, now.inlets)) {
    const p = own(was.inlets, key) || {};
    const q = own(now.inlets, key) || {};
    for (const field of INLET_FIELDS) {
      const cell = restamp(p[field] || null, q[field] || null, []);
      if (cell) out.inlets = { ...(out.inlets || {}), [key]: { ...((out.inlets || {})[key] || {}), [field]: cell } };
    }
  }
  storeCopy(after, out);
  if (isObject(before.share) && Object.hasOwn(before.share, 'flowsSeeds') && isObject(after.share) && !Object.hasOwn(after.share, 'flowsSeeds')) {
    after.share.flowsSeeds = before.share.flowsSeeds;
  }
  // the notice of replaced seeds is this device's own reading, never undone: what was read stays read, and what is
  // still to say is what was still to say before the Undo (so it is said once)
  const share = isObject(before.share) ? before.share : {};
  const noticed = new Set([...listOf(share.flowsNoticed), ...listOf(after.share.flowsNoticed)].filter(isString));
  if (noticed.size) after.share.flowsNoticed = [...noticed].sort();
  if (Object.hasOwn(share, 'flowsNotice') || Object.hasOwn(after.share, 'flowsNotice')) {
    after.share.flowsNotice = listOf(share.flowsNotice).filter((one) => isObject(one) && !noticed.has(one.path));
  }
  return wrote;
}

/** The latest stamp of a section that is a time of day (2001 on), or 0. */
function latestTime(section) {
  let top = 0;
  const see = (cell) => { if (isObject(cell) && Number.isFinite(cell.at) && cell.at >= TIME_FLOOR && cell.at > top) top = cell.at; };
  for (const name of ['added', 'targets', 'into', 'offers']) for (const key of Object.keys(section[name] || {})) see(section[name][key]);
  for (const name of ['lines', 'inlets']) for (const key of Object.keys(section[name] || {})) for (const cell of Object.values(section[name][key])) see(cell);
  return top;
}

/** A line by hand's cell without the bank's payee key, for comparing what the owner set (null stays null). */
function withoutP(cell) {
  if (!cell || cell.deleted || cell.v.p === undefined) return cell;
  const { p, ...v } = cell.v;
  return { ...cell, v };
}

/** What a cell decides, for comparing: its value (a cut with its day), or 'none' for a removal or no cell. */
function valueOf(cell) {
  if (!cell || cell.deleted) return 'none';
  return canon(cell.day ? { v: cell.v, day: cell.day } : { v: cell.v });
}

/* ------------------------------------------------------------------ a round */

/**
 * Whether bringing the device to `section` (a merged one) would change its copy: a cell the copy lacks or loses to.
 * @returns {boolean}
 */
export function flowsDiffer(state, section) {
  // a record with no copy yet (a backup from before this version) takes the round to make it, seeded at that moment
  if (!hasCopy(state)) return true;
  const copy = storedFlows(state);
  return canon(joinFlows(copy, section)) !== canon(copy);
}

/**
 * Bring the device to `section` (a merged one): the copy takes every cell that wins over its own, the record follows
 * (applyFlows), and the seeds another device's replaced are noted for the page to say once.
 * @param {object} state  (mutated)
 * @param {object} section
 * @param {number} nowMs
 * @returns {boolean} true when the copy changed
 */
export function takeFlows(state, section, nowMs) {
  if (!isObject(state)) return false;
  const seeded = seedFlows(state, nowMs);
  if (!flowsDiffer(state, section)) {
    if (seeded) applyFlows(state, nowMs);
    return seeded;
  }
  storeCopy(state, joinFlows(storedFlows(state), section));
  noticeFlows(state);
  applyFlows(state, nowMs);
  return true;
}

/**
 * The cells of `merged` that differ from this device's own (`local`): what arrived from the other devices, for the
 * earlier copies Undo keeps (the `past` path, 3.4), so that an Undo never takes it back.
 * @returns {object}
 */
export function arrivedFlows(local, merged) {
  const x = sectionOf(local);
  const y = sectionOf(merged);
  const out = {};
  const differs = (p, q) => canon(p || null) !== canon(q || null);
  if (y.since && y.since !== x.since) out.since = y.since;
  for (const key of Object.keys(y.lines || {})) {
    const mine = own(x.lines, key) || {};
    const line = y.lines[key];
    const fields = LINE_FIELDS.filter((field) => line[field] && differs(mine[field], line[field]));
    if (fields.length) {
      out.lines = out.lines || {};
      out.lines[key] = { p: line.p, cad: line.cad, amt: line.amt, dom: line.dom };
      for (const field of fields) out.lines[key][field] = line[field];
    }
  }
  // a line by hand's entry that differs from this device's own only by the payee key another device learned into it
  // (applyFlows) is this device's own edit: it stays out of the copies Undo keeps, so an Undo still takes the edit back
  // (restampFlows keeps the key)
  for (const key of Object.keys(y.added || {})) {
    if (differs(withoutP(own(x.added, key)), withoutP(y.added[key]))) (out.added || (out.added = {}))[key] = y.added[key];
  }
  for (const name of ['targets', 'into', 'offers']) {
    for (const key of Object.keys(y[name] || {})) if (differs(own(x[name], key), y[name][key])) (out[name] || (out[name] = {}))[key] = y[name][key];
  }
  for (const key of Object.keys(y.inlets || {})) {
    const mine = own(x.inlets, key) || {};
    for (const field of Object.keys(y.inlets[key])) {
      if (differs(mine[field], y.inlets[key][field])) {
        out.inlets = out.inlets || {};
        (out.inlets[key] || (out.inlets[key] = {}))[field] = y.inlets[key][field];
      }
    }
  }
  return tidy(out);
}

/* ------------------------------------------------------------------ the notice of replaced seeds */

/**
 * The seeds of this device that another device's seed replaced (both at stamp 0, the canonical order deciding): each
 * noted once, in `share.flowsNotice`, for the page to say. A seed replaced by a later edit is no news.
 * @param {object} state  (mutated)
 * @returns {number} how many were noted now
 */
export function noticeFlows(state) {
  if (!isObject(state) || !isObject(state.share) || !isObject(state.share.flowsSeeds)) return 0;
  const seeds = sectionOf(state.share.flowsSeeds);
  const copy = storedFlows(state);
  const seen = new Set(Array.isArray(state.share.flowsNoticed) ? state.share.flowsNoticed : []);
  const notice = Array.isArray(state.share.flowsNotice) ? state.share.flowsNotice.slice() : [];
  let added = 0;
  const note = (path, item) => {
    if (seen.has(path) || notice.some((one) => one.path === path)) return;
    notice.push({ path, ...item });
    added += 1;
  };
  for (const key of Object.keys(seeds.lines || {})) {
    for (const field of ['verdict', 'active']) {
      const seed = seeds.lines[key][field];
      const held = own(copy.lines, key) && copy.lines[key][field];
      // a cut seeded on two days is one cut: only another value is news
      const value = (cell) => (cell.deleted ? null : cell.v);
      if (seed && held && held.at === 0 && value(held) !== value(seed)) {
        note('lines/' + key + '/' + field, { kind: field, key, was: value(seed), now: value(held) });
      }
    }
  }
  for (const key of Object.keys(seeds.targets || {})) {
    const held = own(copy.targets, key);
    if (held && held.at === 0 && canon(held) !== canon(seeds.targets[key])) note('targets/' + key, { kind: 'target', key, was: seeds.targets[key].v, now: held.v });
  }
  // a line added by hand on two devices before this version, seeded at two prices (or names): one was kept. A seed whose
  // value another entry still holds (another device's second line of the content, ranked after it) was not replaced
  // (the bank's payee key one of them learned is no news: compared without it)
  const kept = new Set(Object.values(copy.added || {}).filter((cell) => !cell.deleted).map((cell) => canon(withoutP(cell).v)));
  for (const key of Object.keys(seeds.added || {})) {
    const seed = withoutP(seeds.added[key]);
    const held = withoutP(own(copy.added, key));
    if (!seed.deleted && held && !held.deleted && held.at === 0 && canon(held) !== canon(seed) && !kept.has(canon(seed.v))) {
      note('added/' + key, { kind: 'added', key, was: { name: seed.v.name, amount: seed.v.amount }, now: { name: held.v.name, amount: held.v.amount } });
    }
  }
  if (added) state.share.flowsNotice = notice;
  return added;
}

/** The owner read the notice: its items are not said again. */
export function closeNotice(state) {
  if (!isObject(state) || !isObject(state.share)) return false;
  const notice = Array.isArray(state.share.flowsNotice) ? state.share.flowsNotice : [];
  if (!notice.length) return false;
  const seen = new Set(Array.isArray(state.share.flowsNoticed) ? state.share.flowsNoticed : []);
  for (const one of notice) seen.add(one.path);
  state.share.flowsNoticed = [...seen].sort();
  state.share.flowsNotice = [];
  return true;
}

/* ------------------------------------------------------------------ helpers */

/** The section without its empty parts, its keys in order. */
function tidy(section) {
  const out = {};
  for (const key of PARTS) {
    const part = section[key];
    if (part === undefined || part === null) continue;
    if (key === 'since') { out.since = part; continue; }
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

function isText(v, max) {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || v !== v.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/.test(v);
}

function isCents(v) {
  return Number.isInteger(v) && v >= 1 && v <= AMOUNT_MAX;
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

function isString(x) {
  return typeof x === 'string';
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}

function own(obj, key) {
  return isObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function union(a, b) {
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
}

function min(a, b) {
  return a <= b ? a : b;
}

/** JSON with sorted keys: equal content gives equal text. */
export function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (isObject(x)) return '{' + Object.keys(x).sort().map((key) => JSON.stringify(key) + ':' + canon(x[key])).join(',') + '}';
  return x === undefined ? 'null' : JSON.stringify(x);
}

