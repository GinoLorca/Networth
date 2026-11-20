/**
 * Money in and out, pass 2: the `flows` section of the shared file (model/flowsection.js, model/share.js; ARCHITECTURE
 * 3.11): its strict reader, the merge laws on random triples (bounds and fixed facts included), the bounds, Undo that
 * travels, older builds that pass the section through, decisions keyed by content, the first run, the size budget and
 * the guard at write time, the 250 removals of payments by hand, the suggestions of subscriptions, still charging after
 * a cut, and the words. Every merchant, person and figure here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CATEGORIES, defaultState, makeAccount, makeRecurring, makeTx } from '../js/model/schema.js';
import { addDays } from '../js/model/dates.js';
import { refresh } from '../js/model/detect.js';
import { merchantOf } from '../js/model/classify.js';
import { payeeKey } from '../js/model/byhand.js';
import {
  FLOWS_CAPS, ADDED_LIVE_MAX, addedKey, addedLineKey, applyFlows, bandCents, bandOf, cellValue, closeNotice, decideLine, decisionsFor, entryOf, exportFlows, floorOf, heldRemovals, joinFlows,
  lineFacts, lineHistory, mergeFlows, noteAdded, noteTarget, pruneFlows, readFlows, readFlowsWhole, restampFlows, seedFlows, storedFlows, takeCells, withoutOldRemovals,
  applyFlows as applyFlowsNow, takeFlows as takeFlowsInto,
} from '../js/model/flowsection.js';
import { GUARD_TEXT, TOMBS_WRITTEN, exportShared, fileText, guardShared, mergeShared, readSharedFile, roundShared, withoutOldTombs } from '../js/model/share.js';
import { inAndOut, leaks, moveQueue, recentMerchants, repertoire, stillCharging, whereItWent, windowsOf } from '../js/model/flows.js';
import { PHRASES, TERMS, phrase, placeholders, term } from '../js/model/words.js';

const at = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();
const NOW = at(2026, 11, 16);
const MIN = 60000;
const DAY_MS = 86400000;
const HEX = (n) => n.toString(16).padStart(13, '0');

/* ------------------------------------------------------------------ devices */

/** A transport that holds one file in memory. */
function memory() {
  const t = { text: null, sha: null, writes: 0 };
  t.read = async () => ({ text: t.text, sha: t.sha });
  t.write = async (body) => { t.writes += 1; t.text = body; t.sha = 's' + t.writes; return {}; };
  return t;
}

/** A device as the app runs it: the store's update with its Undo copies and the `past` path, and the restore hook. */
function deviceOf(state, clock) {
  const undo = [];
  const d = {
    state,
    clock,
    update(fn, opts = {}) {
      if (opts.undo) undo.push(JSON.stringify(d.state));
      if (typeof opts.past === 'function') {
        for (let i = 0; i < undo.length; i++) {
          const copy = JSON.parse(undo[i]);
          opts.past(copy);
          undo[i] = JSON.stringify(copy);
        }
      }
      fn(d.state);
    },
    undo() {
      const json = undo.pop();
      if (!json) return false;
      const before = d.state;
      d.state = JSON.parse(json);
      restampFlows(before, d.state);
      return true;
    },
    round(repo) {
      return roundShared({ state: () => d.state, stale: () => false, update: (now, past) => d.update(now, { past }) }, repo, d.clock);
    },
  };
  return d;
}

let seq = 0;
/** A card account and the monthly charges of invented services, as the bank reports them. */
function charges(state, raw, cents, days, account = 'acc_card') {
  for (const day of days) {
    seq += 1;
    state.txs.push(makeTx({
      id: 'tx_s' + seq, accountId: account, day, postedDay: day, amount: cents, flow: 'out', kind: 'spend', raw,
      fp: account + '|' + day + '|-' + cents + '|' + raw.toLowerCase() + '|0', ext: { id: 'ext-' + raw + '-' + day }, loggedAt: at(2026, 6, 1),
    }));
  }
}

const monthly = (from, n, day = 14) => Array.from({ length: n }, (_, i) => {
  const d = addDays(from, i * 30);
  return d.slice(0, 8) + String(day).padStart(2, '0');
});

/** A record with the bank's charges of two invented services on a card. */
function record(opts = {}) {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1000, basis: 'bank' }));
  state.accounts.push(makeAccount({ id: 'acc_card2', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-2' }, name: 'Card 2', balance: -1000, basis: 'bank' }));
  const months = opts.months || 6;
  const from = opts.from || addDays('2026-11-14', -30 * (months - 1));
  charges(state, 'STREAMLINE VIDEO 800-555', 1599, monthly(from, months, 14));
  if (opts.second !== false) charges(state, 'KITEFIELD CLOUD 888-555', 299, monthly(from, months, 3));
  refresh(state, NOW);
  return state;
}

function lineOf(state, mkey) {
  return state.recurring.find((rec) => rec.mkey === mkey && rec.active !== undefined) || null;
}

/** An owner's decision as the views write it: one undoable update. */
function decide(d, mkey, field, value, opts) {
  d.update((s) => { decideLine(s, lineOf(s, mkey), field, value, d.clock(), opts); }, { undo: 'decided' });
}

async function settle(devices, repo) {
  for (let pass = 0; pass < 2; pass++) for (const d of devices) await d.round(repo);
}

async function assertQuiet(devices, repo, label) {
  const writes = repo.writes;
  for (const d of devices) await d.round(repo);
  assert.equal(repo.writes, writes, (label || '') + ': a further round writes nothing');
}

/* ------------------------------------------------------------------ reading */

const cell = (v, stamp, undo) => (undo ? { v, at: stamp, undo: true } : { v, at: stamp });
const gone = (stamp, undo) => (undo ? { deleted: true, at: stamp, undo: true } : { deleted: true, at: stamp });
const facts = (k = 1) => ({ p: 'p' + HEX(k), cad: 'monthly', amt: 1470, dom: 14 });

function fullSection() {
  return {
    since: '2026-05-01',
    lines: {
      ['l' + HEX(1)]: { ...facts(1), sub: cell(true, 5), verdict: cell('cut', 6), active: gone(7, true) },
      ['l' + HEX(2)]: { ...facts(2), verdict: gone(8) },
      ['l' + HEX(3)]: { ...facts(3), sub: gone(3, true), active: cell(false, 0) },
    },
    added: {
      ['a' + HEX(1)]: cell({ name: 'Larkspur Yoga', amount: 4500, cadence: 'monthly', day: '2026-11-30', category: 'subscriptions', sub: true }, 4),
      ['a' + HEX(2)]: cell({ name: 'Harbor Storage', amount: 12000, cadence: 'annual', day: '2026-12-01', category: 'household', sub: false, p: 'p' + HEX(9) }, 4),
      ['a' + HEX(3)]: gone(9, true),
    },
    targets: { cafe: cell(12000, 3), shopping: gone(4) },
    inlets: {
      ['n' + HEX(1)]: { name: cell('Photo shoots', 1), kind: cell('job', 1), goal: cell({ per: 'month', cents: 100000 }, 2), focus: cell(true, 2), gone: gone(3), removed: cell(false, 3) },
      ['n' + HEX(2)]: { name: gone(5, true), kind: gone(5, true) },
    },
    into: {
      ['p' + HEX(1)]: cell('n' + HEX(1), 2), ['r' + HEX(1)]: cell('-', 2), ['i' + HEX(1)]: { ...cell('?', 2), day: '2026-11-01', fp: 'f' + HEX(1) },
      ['f' + HEX(1)]: { ...gone(3), day: '2026-10-01' }, ['q' + HEX(1)]: { ...cell('n' + HEX(1), 3, true), day: '2026-09-01' },
      ['i' + HEX(2)]: { ...gone(4, true), day: '2026-11-02', fp: 'f' + HEX(2) },
    },
    offers: { ['p' + HEX(1)]: cell(false, 1), ['r' + HEX(2)]: gone(2), ['s' + HEX(3)]: cell(false, 3, true) },
  };
}
// a cut carries its day
fullSection.cut = () => ({ v: 'cut', at: 6, day: '2026-11-10' });

function validSection() {
  const s = fullSection();
  s.lines['l' + HEX(1)].verdict = fullSection.cut();
  return s;
}

test('the reader takes every part, every key pattern and every removal form, as a fresh copy', () => {
  const s = validSection();
  const read = readFlows(s);
  assert.ok(read, 'read');
  assert.deepEqual(JSON.parse(JSON.stringify(read)), JSON.parse(JSON.stringify(readFlows(JSON.parse(JSON.stringify(s))))));
  assert.equal(Object.keys(read.into).length, 6);
  assert.equal(read.lines['l' + HEX(1)].verdict.day, '2026-11-10');
  // the shared file takes it, and a file whose section is refused is refused whole
  const file = { v: 1, app: 'networth', savedAt: 1, byHand: {}, flows: s };
  assert.ok(readSharedFile(JSON.stringify(file)).flows);
  assert.equal(readSharedFile(JSON.stringify({ ...file, flows: { ...s, lines: { bad: {} } } })), null);
  // no key a prototype could be reached through
  assert.equal(readFlows(JSON.parse('{"targets":{"__proto__":{"v":1,"at":1}}}')), null);
});

test('the reader refuses every bad value', () => {
  const bad = [];
  const variant = (label, change) => { const s = validSection(); change(s); bad.push([label, s]); };
  const L1 = 'l' + HEX(1);
  variant('unknown part', (s) => { s.plan = {}; });
  variant('since not a day', (s) => { s.since = '2026-02-30'; });
  variant('line key', (s) => { s.lines['x' + HEX(5)] = { ...facts(), sub: cell(true, 1) }; });
  variant('line key short', (s) => { s.lines.l123 = { ...facts(), sub: cell(true, 1) }; });
  variant('line with no decision', (s) => { s.lines['l' + HEX(7)] = { ...facts() }; });
  variant('payee', (s) => { s.lines[L1].p = 'q' + HEX(1); });
  variant('cadence', (s) => { s.lines[L1].cad = 'daily'; });
  variant('amount 0', (s) => { s.lines[L1].amt = 0; });
  variant('amount fraction', (s) => { s.lines[L1].amt = 14.5; });
  variant('billing day 0', (s) => { s.lines[L1].dom = 0; });
  variant('billing day 367', (s) => { s.lines[L1].dom = 367; });
  variant('extra field on a line', (s) => { s.lines[L1].note = 'x'; });
  variant('sub not a switch', (s) => { s.lines[L1].sub = cell('yes', 1); });
  variant('cut with no day', (s) => { s.lines[L1].verdict = cell('cut', 6); });
  variant('keep with a day', (s) => { s.lines[L1].verdict = { v: 'keep', at: 6, day: '2026-11-10' }; });
  variant('verdict word', (s) => { s.lines[L1].verdict = cell('drop', 6); });
  variant('removal with a value', (s) => { s.lines[L1].active = { deleted: true, at: 1, v: false }; });
  variant('deleted false', (s) => { s.lines[L1].active = { deleted: false, at: 1 }; });
  variant('undo not a switch', (s) => { s.lines[L1].active = { v: true, at: 1, undo: 'yes' }; });
  variant('stamp too large', (s) => { s.lines[L1].active = { v: true, at: 1e15 }; });
  variant('stamp negative', (s) => { s.lines[L1].active = { v: true, at: -1 }; });
  variant('extra key in a cell', (s) => { s.lines[L1].active = { v: true, at: 1, by: 'mac' }; });
  variant('added key', (s) => { s.added['b' + HEX(1)] = s.added['a' + HEX(1)]; });
  variant('added name too long', (s) => { s.added['a' + HEX(1)].v.name = 'x'.repeat(81); });
  variant('added name with a space at an end', (s) => { s.added['a' + HEX(1)].v.name = 'Yoga '; });
  variant('added category', (s) => { s.added['a' + HEX(1)].v.category = 'income'; });
  variant('added cadence', (s) => { s.added['a' + HEX(1)].v.cadence = 'hourly'; });
  variant('added day', (s) => { s.added['a' + HEX(1)].v.day = 'soon'; });
  variant('added extra field', (s) => { s.added['a' + HEX(1)].v.account = 'acc'; });
  variant('added payee', (s) => { s.added['a' + HEX(1)].v.p = 'p12'; });
  variant('added amount', (s) => { s.added['a' + HEX(1)].v.amount = 1e11; });
  variant('target category', (s) => { s.targets.income = cell(100, 1); });
  variant('target 0 cents', (s) => { s.targets.cafe = cell(0, 1); });
  variant('inlet key', (s) => { s.inlets['m' + HEX(1)] = s.inlets['n' + HEX(1)]; });
  variant('inlet kind', (s) => { s.inlets['n' + HEX(1)].kind = cell('salary', 1); });
  variant('inlet goal', (s) => { s.inlets['n' + HEX(1)].goal = cell({ per: 'week', cents: 1 }, 1); });
  variant('inlet name too long', (s) => { s.inlets['n' + HEX(1)].name = cell('x'.repeat(41), 1); });
  variant('inlet empty', (s) => { s.inlets['n' + HEX(3)] = {}; });
  variant('filing value', (s) => { s.into['p' + HEX(1)] = cell('x' + HEX(1), 1); });
  variant('filing key', (s) => { s.into['z' + HEX(1)] = cell('-', 1); });
  variant('one deposit with no fingerprint', (s) => { s.into['i' + HEX(1)] = { ...cell('?', 2), day: '2026-11-01' }; });
  variant('one deposit with no day', (s) => { s.into['f' + HEX(1)] = cell('?', 2); });
  variant('a payer filing with a day', (s) => { s.into['p' + HEX(1)] = { ...cell('-', 2), day: '2026-11-01' }; });
  variant('fingerprint', (s) => { s.into['i' + HEX(1)].fp = 'g' + HEX(1); });
  variant('offer true', (s) => { s.offers['p' + HEX(1)] = cell(true, 1); });
  variant('offer key', (s) => { s.offers['q' + HEX(1)] = cell(false, 1); });
  variant('too many lines', (s) => { for (let k = 10; k < 412; k++) s.lines['l' + HEX(k)] = { ...facts(k), sub: cell(true, 1) }; });
  variant('half a surrogate pair', (s) => { s.added['a' + HEX(1)].v.name = 'Yoga \ud800'; });
  for (const [label, s] of bad) assert.equal(readFlows(s), null, label);
  assert.equal(readFlows([]), null);
  assert.equal(readFlows('flows'), null);
});

/* ------------------------------------------------------------------ merging */

function random(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

/** A random section: few keys so they meet, stamps that tie, Undo marks, removals, and copies of a line's facts. */
function randomSection(rnd, opts = {}) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const n = opts.keys || 6;
  const stamp = () => (opts.wide ? Math.floor(rnd() * 400) : pick([0, 1, 2, 3, 5]));
  const someCell = (value) => (rnd() < 0.25 ? gone(stamp(), rnd() < 0.5) : cell(value, stamp(), rnd() < 0.3));
  const s = { lines: {}, added: {}, targets: {}, inlets: {}, into: {}, offers: {} };
  if (rnd() < 0.7) s.since = addDays('2026-05-01', Math.floor(rnd() * 20));
  const lines = opts.lines || n;
  for (let i = 0; i < lines; i++) {
    const k = Math.floor(rnd() * lines * (opts.spread || 1));
    // below the caps, copies of one key that differ in a fact (a hash two lines share) merge by the smaller; at the
    // caps, a key's facts are what the key reads, as every device writes them
    const entry = opts.sameFacts ? { ...facts(k), amt: 1470 + (k % 3) * 294, dom: 1 + (k % 28) } : { ...facts(k), amt: pick([1470, 1764, 1470]), dom: pick([14, 14, 15]) };
    for (const field of ['sub', 'verdict', 'active']) {
      if (rnd() < 0.5) continue;
      entry[field] = field === 'verdict'
        ? (rnd() < 0.25 ? gone(stamp()) : (() => { const v = pick(['keep', 'review', 'cut']); const c = cell(v, stamp(), rnd() < 0.3); if (v === 'cut') c.day = pick(['2026-11-01', '2026-11-02']); return c; })())
        : someCell(pick([true, false]));
    }
    if (entry.sub || entry.verdict || entry.active) s.lines['l' + HEX(k)] = entry;
  }
  for (let i = 0; i < (opts.added || n); i++) s.added['a' + HEX(Math.floor(rnd() * (opts.added || n) * (opts.spread || 1)))] = someCell({ name: pick(['Yoga', 'Gym']), amount: pick([4000, 4500]), cadence: 'monthly', day: '2026-11-30', category: 'subscriptions', sub: true });
  for (const category of Object.keys(CATEGORIES).slice(0, opts.targets || 4)) if (rnd() < 0.7) s.targets[category] = someCell(pick([5000, 9000]));
  for (let i = 0; i < (opts.inlets || 3); i++) {
    const inlet = {};
    for (const [field, values] of [['name', ['A', 'B']], ['kind', ['job', 'steady']], ['focus', [true, false]], ['removed', [true, false]]]) if (rnd() < 0.6) inlet[field] = someCell(pick(values));
    if (Object.keys(inlet).length) s.inlets['n' + HEX(Math.floor(rnd() * (opts.inlets || 3) * (opts.spread || 1)))] = inlet;
  }
  for (let i = 0; i < (opts.into || n); i++) {
    const kind = pick(['p', 'r', 'i', 'f', 'q']);
    const c = someCell(pick(['-', '?', 'n' + HEX(1)]));
    if (kind !== 'p' && kind !== 'r') c.day = pick(['2026-10-01', '2026-10-02']);
    if (kind === 'i') c.fp = pick(['f' + HEX(1), 'f' + HEX(2)]);
    s.into[kind + HEX(Math.floor(rnd() * (opts.into || n) * (opts.spread || 1)))] = c;
  }
  for (let i = 0; i < (opts.offers || 3); i++) s.offers[pick(['p', 'r', 's']) + HEX(Math.floor(rnd() * (opts.offers || 3) * (opts.spread || 1)))] = rnd() < 0.3 ? gone(stamp()) : cell(false, stamp(), rnd() < 0.3);
  const read = opts.whole ? readFlowsWhole(s) : readFlows(s);
  assert.ok(read, 'a random section reads');
  return read;
}

function laws(a, b, c, label) {
  assert.deepEqual(mergeFlows(a, b), mergeFlows(b, a), 'commutative ' + label);
  assert.deepEqual(mergeFlows(mergeFlows(a, b), c), mergeFlows(a, mergeFlows(b, c)), 'associative ' + label);
  const ab = mergeFlows(a, b);
  assert.deepEqual(mergeFlows(ab, ab), ab, 'idempotent ' + label);
  assert.deepEqual(mergeFlows(ab, a), ab, 'absorbs a side ' + label);
  assert.ok(readFlowsWhole(ab), 'the merge reads back ' + label);
  assert.deepEqual(readFlowsWhole(ab), ab, 'as it is ' + label);
}

test('merging keeps its laws on random triples: commutative, associative and idempotent, ties, Undo marks, removals and fixed facts included', () => {
  const rnd = random(20261118);
  for (let i = 0; i < 400; i++) laws(randomSection(rnd), randomSection(rnd), randomSection(rnd), String(i));
});

/** How many entries of each pool a bounded section holds. */
function poolsOf(section) {
  const live = (map) => Object.values(map || {}).filter((cell) => !cell.deleted).length;
  const dead = (map) => Object.values(map || {}).filter((cell) => cell.deleted).length;
  const inletGone = (inlet) => (inlet.removed && !inlet.removed.deleted && inlet.removed.v === true) || !Object.values(inlet).some((cell) => !cell.deleted);
  const into = Object.keys(section.into || {});
  return {
    lines: Object.values(section.lines || {}).filter((line) => ['sub', 'verdict', 'active'].some((f) => line[f] && !line[f].deleted)).length,
    linesGone: Object.values(section.lines || {}).filter((line) => !['sub', 'verdict', 'active'].some((f) => line[f] && !line[f].deleted)).length,
    added: live(section.added), addedGone: dead(section.added),
    targets: Object.keys(section.targets || {}).length,
    inlets: Object.values(section.inlets || {}).filter((inlet) => !inletGone(inlet)).length,
    inletsGone: Object.values(section.inlets || {}).filter(inletGone).length,
    intoKeys: into.filter((key) => key[0] === 'p' || key[0] === 'r').length, intoRows: into.filter((key) => key[0] !== 'p' && key[0] !== 'r').length,
    offers: live(section.offers), offersGone: dead(section.offers),
  };
}

test('the merge keeps no bound, so its laws hold over the caps too; the bounds are drawn on what is written, the same on every device', () => {
  const rnd = random(77);
  const opts = { wide: true, spread: 3, lines: 140, added: 70, targets: 30, inlets: 36, into: 200, offers: 70, sameFacts: true };
  for (let i = 0; i < 60; i++) {
    const a = randomSection(rnd, opts);
    const b = randomSection(rnd, opts);
    const c = randomSection(rnd, opts);
    laws(a, b, c, 'over the caps ' + i);
    // two devices that merged the same files in other orders write the same bounded section; bounding again changes nothing
    const one = pruneFlows(mergeFlows(mergeFlows(a, b), c));
    assert.deepEqual(pruneFlows(mergeFlows(c, mergeFlows(b, a))), one, 'the same bounds ' + i);
    assert.deepEqual(pruneFlows(one), one, 'idempotent ' + i);
    assert.ok(readFlows(one), 'reads back ' + i);
    const pools = poolsOf(one);
    for (const pool of Object.keys(pools)) assert.ok(pools[pool] <= FLOWS_CAPS[pool], pool + ' ' + pools[pool] + ' ' + i);
  }
  // the bounds bite: a section over every cap keeps each cap
  const big = pruneFlows(randomSection(random(5), { ...opts, lines: 400, added: 200, into: 600, offers: 200, inlets: 80, spread: 1, whole: true }));
  assert.ok(readFlows(big), 'within the reader\'s limits once bounded');
  assert.equal(poolsOf(big).lines, FLOWS_CAPS.lines);
});

test('merging: the later stamp wins; on an equal stamp an edit beats an Undo, then the canonical order; the floor keeps the later day', () => {
  const L = 'l' + HEX(1);
  const m = (p, q) => mergeFlows({ lines: { [L]: { ...facts(), verdict: p } } }, { lines: { [L]: { ...facts(), verdict: q } } }).lines[L].verdict;
  assert.deepEqual(m(cell('keep', 9), cell('review', 8)), cell('keep', 9));
  assert.deepEqual(m(cell('review', 9, true), cell('keep', 9)), cell('keep', 9));
  assert.deepEqual(m(gone(9), cell('keep', 9)), gone(9), 'a removal and a value on one stamp: the canonical order');
  assert.equal(mergeFlows({ since: '2026-05-01' }, { since: '2026-06-01' }).since, '2026-06-01');
  // two copies of one key that differ in a fact keep the smaller (a hash two lines share)
  const merged = mergeFlows({ lines: { [L]: { ...facts(), amt: 1764, sub: cell(true, 1) } } }, { lines: { [L]: { ...facts(), amt: 1470, verdict: cell('keep', 2) } } });
  assert.deepEqual(merged.lines[L], { ...facts(), amt: 1470, sub: cell(true, 1), verdict: cell('keep', 2) });
});

/* ------------------------------------------------------------------ the bounds */

test('the bounds: a live decision is never evicted while a removal remains, and a verdict survives 100 newer dismissals', () => {
  const L = (k) => 'l' + HEX(k);
  const s = { lines: {} };
  s.lines[L(1)] = { ...facts(1), verdict: cell('keep', 1) };
  // 100 newer dismissals ("Not one" and "Not a recurring bill"), and 50 newer lines holding only removals
  for (let k = 2; k < 102; k++) s.lines[L(k)] = { ...facts(k), [k % 2 ? 'sub' : 'active']: cell(false, 100 + k) };
  for (let k = 200; k < 250; k++) s.lines[L(k)] = { ...facts(k), verdict: gone(1000 + k), sub: gone(1000 + k, true) };
  const pruned = pruneFlows(readFlows(s));
  // two pools: 100 live and the newest 30 holding only removals
  assert.equal(Object.keys(pruned.lines).length, FLOWS_CAPS.lines + FLOWS_CAPS.linesGone);
  assert.deepEqual(pruned.lines[L(1)].verdict, cell('keep', 1), 'the verdict stays, older than all of them');
  assert.deepEqual(Object.keys(pruned.lines).filter((key) => key >= L(200)), Array.from({ length: 30 }, (_, i) => L(220 + i)), 'the newest 30 lines of removals stay');
  assert.equal(pruned.lines[L(2)], undefined, 'the oldest dismissal goes, for the 100 live');
  assert.ok(pruned.lines[L(3)] && pruned.lines[L(101)]);
  // with fewer lines than the cap, nothing goes, removals included
  assert.deepEqual(pruneFlows(readFlows({ lines: { [L(1)]: s.lines[L(1)], [L(200)]: s.lines[L(200)] } })).lines[L(200)], s.lines[L(200)]);

  // lines added by hand, dismissed suggestions: 40 live however old, and the newest 20 removals
  const value = (k) => ({ name: 'Line ' + k, amount: 100 + k, cadence: 'monthly', day: '2026-11-01', category: 'other', sub: false });
  const added = { added: {}, offers: {} };
  for (let k = 0; k < 45; k++) added.added['a' + HEX(k)] = cell(value(k), k);
  for (let k = 100; k < 130; k++) added.added['a' + HEX(k)] = gone(1000 + k);
  for (let k = 0; k < 45; k++) added.offers['s' + HEX(k)] = cell(false, k);
  for (let k = 100; k < 130; k++) added.offers['p' + HEX(k)] = gone(1000 + k, true);
  const kept = pruneFlows(readFlows(added));
  const live = (map) => Object.keys(map).filter((key) => !map[key].deleted);
  const dead = (map) => Object.keys(map).filter((key) => map[key].deleted);
  assert.equal(live(kept.added).length, 40);
  assert.ok(!kept.added['a' + HEX(4)] && kept.added['a' + HEX(5)], 'over 40 live, the oldest live went');
  assert.deepEqual(dead(kept.added), Array.from({ length: 20 }, (_, i) => 'a' + HEX(110 + i)), 'the newest 20 removals');
  assert.equal(live(kept.offers).length, 40);
  assert.equal(dead(kept.offers).length, 20);

  // targets: a removal goes before any target
  const targets = { targets: {} };
  for (const category of Object.keys(CATEGORIES)) targets.targets[category] = cell(5000, 1);
  // (one per category: there are fewer categories than the cap of 40, so the cap never bites)
  assert.equal(Object.keys(pruneFlows(readFlows(targets)).targets).length, Object.keys(CATEGORIES).length);
  assert.ok(Object.keys(CATEGORIES).length <= FLOWS_CAPS.targets);

  // sources: 20 live and 10 removed (or with no live cell left), apart
  const inlets = { inlets: {} };
  for (let k = 0; k < 22; k++) inlets.inlets['n' + HEX(k)] = { name: cell('Source ' + k, k), kind: cell('job', k) };
  for (let k = 100; k < 115; k++) inlets.inlets['n' + HEX(k)] = { name: cell('Gone ' + k, 1), removed: cell(true, 1000 + k) };
  inlets.inlets['n' + HEX(200)] = { name: gone(5000, true), kind: gone(5000, true) };
  const sources = pruneFlows(readFlows(inlets)).inlets;
  assert.equal(Object.keys(sources).filter((key) => key < 'n' + HEX(100)).length, 20, '20 live');
  assert.ok(!sources['n' + HEX(0)] && !sources['n' + HEX(1)] && sources['n' + HEX(2)], 'the oldest live went');
  assert.equal(Object.keys(sources).filter((key) => key >= 'n' + HEX(100)).length, 10, '10 gone');
  assert.ok(sources['n' + HEX(200)], 'the newest gone source, an Undo of its making');

  // filings: removals and Leave it go first; one deposit's also by the oldest day, and 400 days behind the newest day
  const into = { into: {} };
  for (let k = 0; k < 150; k++) into.into['p' + HEX(k)] = cell('n' + HEX(1), k);
  for (let k = 150; k < 170; k++) into.into['r' + HEX(k)] = k % 2 ? gone(5000 + k) : cell('?', 5000 + k);
  for (let k = 0; k < 110; k++) into.into['f' + HEX(k)] = { ...cell('n' + HEX(1), k), day: addDays('2026-06-01', k) };
  for (let k = 200; k < 220; k++) into.into['q' + HEX(k)] = { ...cell('?', 9000 + k), day: '2026-11-01' };
  into.into['f' + HEX(999)] = { ...cell('n' + HEX(1), 1), day: '2025-05-01' };
  const filings = pruneFlows(readFlows(into)).into;
  const count = (re) => Object.keys(filings).filter((key) => re.test(key)).length;
  assert.equal(count(/^p/), 150, 'every filing by payer stays');
  assert.equal(count(/^r/), 10, 'the newest of the removals and Leave it make up the 160');
  assert.equal(count(/^f/), 110, 'every filing of one deposit within 400 days stays');
  assert.equal(filings['f' + HEX(999)], undefined, 'more than 400 days behind the newest day');
  assert.equal(count(/^q/), 10, 'Leave it goes first, to make up the 120');
});

test('a removal is written for 400 days by the device clock, outside the merge; a source removed that long ago goes whole', () => {
  const old = NOW - 401 * DAY_MS;
  const s = readFlows({
    lines: { ['l' + HEX(1)]: { ...facts(), verdict: gone(old), sub: cell(true, old) }, ['l' + HEX(2)]: { ...facts(2), active: gone(old) } },
    targets: { cafe: gone(NOW - 10 * DAY_MS), shopping: gone(old) },
    inlets: { ['n' + HEX(1)]: { name: cell('A', 1), removed: cell(true, old) }, ['n' + HEX(2)]: { name: cell('B', 1), removed: cell(false, old) } },
  });
  const out = withoutOldRemovals(s, NOW);
  assert.deepEqual(out.lines, { ['l' + HEX(1)]: { ...facts(), sub: cell(true, old) } }, 'a live decision stays, however old');
  assert.deepEqual(Object.keys(out.targets), ['cafe']);
  assert.deepEqual(Object.keys(out.inlets), ['n' + HEX(2)]);
  // a seed (stamp 0) is never a removal that old
  assert.deepEqual(withoutOldRemovals(readFlows({ targets: { cafe: gone(0) } }), NOW).targets, { cafe: gone(0) });
});

/* ------------------------------------------------------------------ Undo travels */

test('Undo travels: decide, round, Undo, round leaves both devices undecided, for sub, a verdict and active', async () => {
  for (const [field, value] of [['sub', true], ['verdict', 'cut'], ['active', false]]) {
    const a = deviceOf(record(), () => NOW);
    const b = deviceOf(record(), () => NOW + MIN);
    const repo = memory();
    await settle([a, b], repo);
    decide(a, 'streamline video', field, value);
    await settle([a, b], repo);
    const seen = (d) => decisionsFor(storedFlows(d.state), d.state.recurring).byLine.get(lineOf(d.state, 'streamline video').id);
    assert.deepEqual(seen(b)[field].v, value, field + ': B holds the decision');
    if (field === 'verdict') assert.equal(lineOf(b.state, 'streamline video').verdict, 'cut');
    if (field === 'active') assert.equal(lineOf(b.state, 'streamline video').active, false);
    assert.ok(a.undo(), 'A undoes');
    await settle([a, b], repo);
    for (const d of [a, b]) {
      const one = seen(d);
      assert.ok(one[field].deleted, field + ': a removal: no decision');
      const line = lineOf(d.state, 'streamline video');
      assert.equal(line.verdict, null, field + ': no verdict');
      assert.equal(line.active, true, field + ': in the Book');
      assert.ok(!(line.locks || []).includes('active'), field + ': detection decides again');
    }
    await assertQuiet([a, b], repo, field);
  }
});

test('Undo travels for a filing of one deposit (into): file, round, Undo, round leaves both unfiled', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  const key = 'i' + HEX(42);
  a.update((s) => {
    const copy = storedFlows(s);
    s.share.flows = { ...copy, into: { ...(copy.into || {}), [key]: { v: '?', at: NOW, day: '2026-11-02', fp: 'f' + HEX(42) } } };
  }, { undo: 'filed' });
  await settle([a, b], repo);
  assert.equal(storedFlows(b.state).into[key].v, '?');
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) {
    const filing = storedFlows(d.state).into[key];
    assert.ok(filing.deleted && filing.undo, 'a removal, written by the Undo');
    assert.deepEqual([filing.day, filing.fp], ['2026-11-02', 'f' + HEX(42)], 'with its facts');
  }
  await assertQuiet([a, b], repo, 'into');
});

test('an edit on another device after seeing the value beats an Undo made on an equal stamp, on both devices', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW);
  const repo = memory();
  decide(a, 'streamline video', 'verdict', 'keep');
  await settle([a, b], repo);
  a.undo();
  // B decides at the same stamp the Undo wrote
  const undoAt = storedFlows(a.state).lines[Object.keys(storedFlows(a.state).lines)[0]].verdict.at;
  b.clock = () => undoAt;
  decide(b, 'streamline video', 'verdict', 'review');
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(lineOf(d.state, 'streamline video').verdict, 'review');
});

/* ------------------------------------------------------------------ content keys */

test('a decision survives a card change and a price rise, and waits on a device that has no line for it yet', async () => {
  const a = deviceOf(record(), () => NOW);
  const repo = memory();
  decide(a, 'streamline video', 'verdict', 'keep');
  await a.round(repo);
  // B's record: the service moved to the other card and its price rose
  const bState = defaultState(at(2026, 1, 1));
  bState.accounts.push(makeAccount({ id: 'acc_card2', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-2' }, name: 'Card 2', balance: -1, basis: 'bank' }));
  charges(bState, 'STREAMLINE VIDEO 800-555', 1599, monthly('2026-06-14', 3, 14), 'acc_card2');
  charges(bState, 'STREAMLINE VIDEO 800-555', 1899, monthly('2026-09-14', 3, 15), 'acc_card2');
  refresh(bState, NOW);
  const b = deviceOf(bState, () => NOW + MIN);
  await b.round(repo);
  const line = lineOf(b.state, 'streamline video');
  assert.equal(line.amount, 1899);
  assert.equal(line.verdict, 'keep', 'the decision reached the line, on another card at another price');
  // C has no line yet (one charge): the decision waits, then applies once detection finds the line
  const cState = defaultState(at(2026, 1, 1));
  cState.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  charges(cState, 'STREAMLINE VIDEO 800-555', 1599, ['2026-11-14']);
  refresh(cState, NOW);
  const c = deviceOf(cState, () => NOW + 2 * MIN);
  await c.round(repo);
  assert.equal(lineOf(c.state, 'streamline video'), null, 'no line yet');
  assert.equal(decisionsFor(storedFlows(c.state), c.state.recurring).waiting.length, 1, 'the decision waits');
  charges(c.state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-09-14', '2026-10-14']);
  refresh(c.state, NOW);
  assert.equal(lineOf(c.state, 'streamline video').verdict, 'keep', 'then applies');
});

test('series of one payee split by amount keep separate decisions', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  charges(state, 'NIMBUS APPS 800-555', 499, monthly('2026-06-04', 6, 4));
  charges(state, 'NIMBUS APPS 800-555', 2999, monthly('2026-06-20', 6, 20));
  refresh(state, NOW);
  const lines = state.recurring.filter((rec) => rec.mkey === 'nimbus apps').sort((x, y) => x.amount - y.amount);
  assert.equal(lines.length, 2, 'two series');
  decideLine(state, lines[0], 'verdict', 'keep', NOW);
  decideLine(state, lines[1], 'verdict', 'cut', NOW);
  assert.equal(Object.keys(storedFlows(state).lines).length, 2, 'two keys');
  // another device with the same rows applies each to its own line
  const other = JSON.parse(JSON.stringify(state));
  for (const rec of other.recurring) { rec.verdict = null; rec.locks = []; rec.id = rec.id + 'x'; }
  for (const t of other.txs) t.recurringId = null;
  refresh(other, NOW);
  const mine = other.recurring.filter((rec) => rec.mkey === 'nimbus apps').sort((x, y) => x.amount - y.amount);
  assert.deepEqual(mine.map((rec) => rec.verdict), ['keep', 'cut']);
});

test('a line key is the same on every device that sees one line: payee, cadence, band and billing day; the band is exact arithmetic', () => {
  const one = lineFacts({ mkey: 'streamline video', cadence: 'monthly', amount: 1599, anchor: '2026-11-14' });
  const two = lineFacts({ mkey: 'streamline video', cadence: 'monthly', amount: 1620, anchor: '2026-10-14' });
  assert.equal(one.key, two.key, 'two amounts in one band, one key');
  assert.deepEqual([one.facts.amt, two.facts.amt], [1599, 1620], 'each keeps the amount it was decided at (a fixed fact)');
  assert.notEqual(one.key, lineFacts({ mkey: 'streamline video', cadence: 'monthly', amount: 2999, anchor: '2026-11-14' }).key);
  assert.notEqual(one.key, lineFacts({ mkey: 'streamline video', cadence: 'monthly', amount: 1599, anchor: '2026-11-20' }).key);
  for (const cents of [1, 2, 5, 99, 1599, 123456, 1e10]) {
    assert.ok(bandCents(cents) <= cents && bandOf(bandCents(cents)) === bandOf(cents), String(cents));
  }
});

/* ------------------------------------------------------------------ the first run */

test('the first run: verdicts (a cut with the seeding day), dismissals, targets, lines added by hand and the floor, at 0', () => {
  const state = record();
  const line = lineOf(state, 'streamline video');
  line.verdict = 'cut';
  line.locks.push('verdict');
  const other = lineOf(state, 'kitefield cloud');
  other.active = false;
  other.locks.push('active');
  state.settings.targets.cafe = 12000;
  state.recurring.push(makeRecurring({ id: 'rec_hand', name: 'Larkspur Yoga', mkey: 'larkspur yoga', amount: 4500, cadence: 'monthly', anchor: '2026-11-30', source: 'manual', category: 'subscriptions' }));
  assert.ok(seedFlows(state, NOW));
  assert.equal(seedFlows(state, NOW), false, 'once');
  const copy = storedFlows(state);
  const cut = Object.values(copy.lines).find((entry) => entry.verdict);
  assert.deepEqual(cut.verdict, { v: 'cut', at: 0, day: '2026-11-16' });
  assert.deepEqual(Object.values(copy.lines).find((entry) => entry.active).active, { v: false, at: 0 });
  assert.deepEqual(copy.targets, { cafe: { v: 12000, at: 0 } });
  const id = state.recurring.find((rec) => rec.id === 'rec_hand').added;
  assert.equal(id, addedKey({ mkey: 'larkspur yoga', cadence: 'monthly', amount: 4500 }));
  assert.deepEqual(copy.added[id], { v: { name: 'Larkspur Yoga', amount: 4500, cadence: 'monthly', day: '2026-11-30', category: 'subscriptions', sub: true }, at: 0 });
  assert.equal(copy.since, state.txs.map((t) => t.day).sort()[0]);
  assert.equal(floorOf(state), copy.since);
  // a seeded cut never reads "still charging" for the charges before it
  refresh(state, NOW);
  assert.deepEqual(leaks(state, NOW, 30).still, []);
  // a charge three days after the cut's day is not one; four days after is
  charges(state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-11-19']);
  refresh(state, at(2026, 11, 22));
  assert.deepEqual(leaks(state, at(2026, 11, 22), 30).still, []);
  charges(state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-11-20']);
  refresh(state, at(2026, 11, 22));
  const still = leaks(state, at(2026, 11, 22), 30).still;
  assert.deepEqual(still.map((one) => [one.name, one.cut, one.day, one.cents]), [['Streamline Video', '2026-11-16', '2026-11-20', 1599]]);
});

test('rule 6, still charging after a cut: the cut carries its day to every device; a charge more than 3 days after it is claimed there, and an Undo takes the claim back', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + MIN);
  const repo = memory();
  decide(a, 'streamline video', 'verdict', 'cut');
  await settle([a, b], repo);
  const later = at(2026, 11, 22);
  for (const d of [a, b]) {
    assert.equal(lineOf(d.state, 'streamline video').verdict, 'cut');
    // the bank still charges: 3 days after the cut is the charge it came too late for; 4 days after is still charging
    charges(d.state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-11-19']);
    refresh(d.state, later);
    assert.deepEqual(leaks(d.state, later, 30).still, [], '3 days after the cut');
    charges(d.state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-11-20']);
    refresh(d.state, later);
    assert.deepEqual(leaks(d.state, later, 30).still.map((one) => [one.name, one.cut, one.day, one.cents]), [['Streamline Video', '2026-11-16', '2026-11-20', 1599]]);
  }
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) {
    assert.equal(lineOf(d.state, 'streamline video').verdict || null, null, 'Undo of the cut reached both');
    assert.deepEqual(leaks(d.state, later, 30).still, []);
  }
  await assertQuiet([a, b], repo, 'rule 6');
});

test('the first run on two devices: a dismissal wins a tie, one line added by hand makes one entry, and the notice of replaced values shows once', async () => {
  const build = (dismissed, target) => {
    const state = record();
    const line = lineOf(state, 'kitefield cloud');
    line.active = !dismissed;
    line.locks.push('active');
    state.settings.targets.cafe = target;
    state.recurring.push(makeRecurring({ name: 'Larkspur Yoga', mkey: 'larkspur yoga', amount: 4500, cadence: 'monthly', anchor: '2026-11-30', source: 'manual', category: 'subscriptions', since: '2026-11-01' }));
    seedFlows(state, NOW);
    return state;
  };
  const a = deviceOf(build(true, 12000), () => NOW);
  const b = deviceOf(build(false, 15000), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  for (const d of [a, b]) {
    assert.equal(lineOf(d.state, 'kitefield cloud').active, false, 'the dismissal wins the tie');
    assert.equal(d.state.recurring.filter((rec) => rec.mkey === 'larkspur yoga').length, 1, 'one line by hand');
    assert.equal(Object.keys(storedFlows(d.state).added).length, 1, 'one entry');
  }
  assert.equal(a.state.settings.targets.cafe, b.state.settings.targets.cafe, 'one target on both');
  // the device whose seeds lost is told, once; the other has nothing to hear
  const told = [a, b].filter((d) => (d.state.share.flowsNotice || []).length);
  assert.equal(told.length, 1);
  const notice = told[0].state.share.flowsNotice.map((one) => one.kind).sort();
  assert.deepEqual(notice, told[0] === b ? ['active', 'target'] : ['target']);
  closeNotice(told[0].state);
  await settle([a, b], repo);
  assert.deepEqual(told[0].state.share.flowsNotice, [], 'said once');
  await assertQuiet([a, b], repo, 'first run');
});

/* ------------------------------------------------------------------ the Book, targets, lines added by hand */

test('a line added by hand travels with its source kept, an edit follows it, and an Undo of the add takes it off every device', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  a.update((s) => {
    const line = makeRecurring({ name: 'Harbor Storage', mkey: 'harbor storage', amount: 12000, cadence: 'monthly', anchor: '2026-12-01', source: 'manual', category: 'household', since: '2026-11-16', locks: ['name', 'category', 'purpose'] });
    s.recurring.push(line);
    noteAdded(s, line, a.clock());
    refresh(s, NOW);
  }, { undo: 'added' });
  await settle([a, b], repo);
  const there = b.state.recurring.find((rec) => rec.mkey === 'harbor storage');
  assert.ok(there, 'B has the line');
  assert.equal(there.source, 'manual', 'its source stays manual');
  assert.ok(/^a[0-9a-f]{13}$/.test(there.added), 'linked to its entry');
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) {
    if (process.env.PROBE) console.log(JSON.stringify(storedFlows(d.state).added), d.state.recurring.filter((rec) => rec.mkey === 'harbor storage').map((rec) => [rec.id, rec.added, rec.source]));
  }
  for (const d of [a, b]) assert.equal(d.state.recurring.some((rec) => rec.mkey === 'harbor storage'), false);
  await assertQuiet([a, b], repo, 'added');
  assert.equal(ADDED_LIVE_MAX, 40);
});

test('targets travel: set, changed, cleared and undone on one device, the same on the other', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + MIN);
  const repo = memory();
  a.update((s) => { noteTarget(s, 'shopping', 15000, a.clock()); });
  await settle([a, b], repo);
  assert.equal(b.state.settings.targets.shopping, 15000);
  b.clock = () => NOW + 5 * MIN;
  b.update((s) => { noteTarget(s, 'shopping', null, b.clock()); });
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(d.state.settings.targets.shopping, undefined);
  // a first target, then its Undo: no target on either device
  a.clock = () => NOW + 9 * MIN;
  a.update((s) => { noteTarget(s, 'entertainment', 6000, a.clock()); }, { undo: 'target' });
  await settle([a, b], repo);
  assert.equal(b.state.settings.targets.entertainment, 6000);
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(d.state.settings.targets.entertainment, undefined, 'Undo of a first target');
  await assertQuiet([a, b], repo, 'targets');
});

/* ------------------------------------------------------------------ older builds */

test('older builds (dcc6d08 and 8d013da) pass the section through unchanged and refuse nothing', async (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const commit of ['dcc6d08', '8d013da']) {
    let dir = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'networth-old-'));
      const tar = execFileSync('git', ['archive', '--format=tar', commit, 'js'], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      writeFileSync(join(dir, 'old.tar'), tar);
      execFileSync('tar', ['-xf', join(dir, 'old.tar'), '-C', dir]);
    } catch {
      if (dir) rmSync(dir, { recursive: true, force: true });
      t.skip('no git, or a copy without that build');
      return;
    }
    try {
      const old = await import(pathToFileURL(join(dir, 'js', 'model', 'share.js')).href);
      const oldSchema = await import(pathToFileURL(join(dir, 'js', 'model', 'schema.js')).href);
      const section = validSection();
      const file = { v: 1, app: 'networth', savedAt: 5, byHand: {}, flows: section };
      const text = fileText(file);
      const read = old.readSharedFile(text);
      assert.ok(read, commit + ' reads the file');
      assert.deepEqual(read.flows, section, commit + ' keeps the section as it is');
      // a round of the old build after an edit of its own: it writes the section back whole
      const state = oldSchema.defaultState(NOW);
      state.settings.words = 'finance';
      state.settings.wordsAt = NOW;
      const repo = memory();
      repo.text = text;
      repo.sha = 's0';
      const device = { state: () => state, stale: () => false, update: (now) => now(state) };
      await old.roundShared(device, repo, () => NOW);
      const written = JSON.parse(repo.text);
      assert.deepEqual(written.flows, section, commit + ' writes it back unchanged');
      // and this build reads what the old one wrote
      assert.deepEqual(readSharedFile(repo.text).flows, readFlows(section));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ size */

/**
 * The section at its caps with the longest values (G.10's assumptions): 14-digit stamps, `undo` on every cell, names of
 * `"` (JSON writes each as two), the largest amounts, the longest cadence, category and kind, every cell of every entry.
 */
function worstSection() {
  const AT = 99999999999999;
  const MAXC = 1e10;
  const c = (v) => ({ v, at: AT, undo: true });
  const g = () => ({ deleted: true, at: AT, undo: true });
  const longest = Object.keys(CATEGORIES).sort((x, y) => y.length - x.length)[0];
  const s = { since: '2026-11-16', lines: {}, added: {}, targets: {}, inlets: {}, into: {}, offers: {} };
  for (let i = 0; i < FLOWS_CAPS.lines; i++) s.lines['l' + HEX(i)] = { p: 'p' + HEX(i), cad: 'semimonthly', amt: MAXC, dom: 366, sub: c(false), verdict: { ...c('cut'), day: '2026-11-16' }, active: c(false) };
  for (let i = 0; i < FLOWS_CAPS.added; i++) s.added['a' + HEX(i)] = c({ name: '"'.repeat(80), amount: MAXC, cadence: 'semimonthly', day: '2026-11-16', category: longest, sub: false, p: 'p' + HEX(i) });
  for (let i = 0; i < FLOWS_CAPS.addedGone; i++) s.added['a' + HEX(1e6 + i)] = g();
  for (const category of Object.keys(CATEGORIES).slice(0, FLOWS_CAPS.targets)) s.targets[category] = c(MAXC);
  // a removal is 5 characters longer than a value of false (round 3): the tag cleared on every other source, Restore from
  // the archive, an Undo of Remove (a removed source keeps its value)
  const inlet = (removed) => ({ name: c('"'.repeat(40)), kind: c('backend'), goal: c({ per: 'month', cents: MAXC }), focus: g(), gone: g(), removed: removed ? c(true) : g() });
  for (let i = 0; i < FLOWS_CAPS.inlets; i++) s.inlets['n' + HEX(i)] = inlet(false);
  for (let i = 0; i < FLOWS_CAPS.inletsGone; i++) s.inlets['n' + HEX(1e6 + i)] = inlet(true);
  for (let i = 0; i < FLOWS_CAPS.intoKeys; i++) s.into[(i % 2 ? 'p' : 'r') + HEX(i)] = c('n' + HEX(i));
  for (let i = 0; i < FLOWS_CAPS.intoRows; i++) s.into['i' + HEX(1e6 + i)] = { ...c('n' + HEX(i)), day: '2026-11-16', fp: 'f' + HEX(i) };
  for (let i = 0; i < FLOWS_CAPS.offers; i++) s.offers['s' + HEX(i)] = c(false);
  for (let i = 0; i < FLOWS_CAPS.offersGone; i++) s.offers['s' + HEX(1e6 + i)] = g();
  return readFlows(s);
}

test('the size budget: the whole section at its caps, measured with fileText, fits under the stated assumptions of G.10', () => {
  const section = worstSection();
  assert.deepEqual(pruneFlows(section), section, 'at its caps, nothing pruned');
  const base = { v: 1, app: 'networth', savedAt: 99999999999999, byHand: {} };
  const size = fileText({ ...base, flows: section }).length - fileText(base).length;
  // G.10: the file before `flows` is about 1,990,100 at the worst; 250 removals of payments by hand in place of 1,000
  // free 107,250 (143 characters a bare removal, measured below)
  const tombs = (n) => { const b = {}; for (let i = 0; i < n; i++) b['t' + String(i).padStart(79, '0')] = { deleted: true, editedAt: 99999999999999 }; return b; };
  const freed = fileText({ ...base, byHand: tombs(1000) }).length - fileText({ ...base, byHand: tombs(TOMBS_WRITTEN) }).length;
  assert.equal(freed, 107250);
  const worst = 1990100 - freed + size;
  assert.ok(worst < 2000000, 'the worst case is ' + worst + ' characters (the section adds ' + size + ')');
  // measured: the section adds 85,828 characters (written on one line, share.js fileText), a worst case of 1,968,678
  assert.ok(size < 90000, 'the section adds ' + size);
  if (process.env.SIZE) console.log('flows at its caps adds', size, '; worst case', worst, '; margin', 2000000 - worst);
  // written indented, as an older build writes it back, it would add about 35,500 more
  const indented = JSON.stringify({ ...base, flows: section }, null, 1).length - JSON.stringify(base, null, 1).length;
  assert.ok(indented > size + 30000, 'indented ' + indented);
});

test('the guard prunes an oversize merged file in its fixed order, the same way on two devices, and the 250 removals of payments by hand hold', () => {
  const AT = 99999999999999;
  const byHand = {};
  for (let i = 0; i < 1000; i++) {
    const marks = {};
    for (let m = 0; m < 48; m++) marks[addDays('2026-01-01', m)] = { paid: true, at: AT };
    byHand['t' + String(i).padStart(79, '0')] = { deleted: true, editedAt: NOW - i * 1000, marks };
  }
  const flows = worstSection();
  const left = { v: 1, app: 'networth', savedAt: 1, byHand: Object.fromEntries(Object.entries(byHand).slice(0, 600)), flows };
  const right = { v: 1, app: 'networth', savedAt: 2, byHand: Object.fromEntries(Object.entries(byHand).slice(400)) };
  const one = mergeShared(left, right);
  const two = mergeShared(right, left);
  assert.ok(fileText(one).length > GUARD_TEXT, 'over the mark: ' + fileText(one).length);
  const a = guardShared(one);
  const b = guardShared(two);
  assert.ok(a && fileText(a).length <= GUARD_TEXT);
  assert.equal(fileText(a), fileText(b), 'the same on both devices');
  // the oldest removals lost their ticks first; the newest kept them
  assert.ok(a.byHand['t' + String(0).padStart(79, '0')].marks, 'the newest keeps its ticks');
  assert.equal(a.byHand['t' + String(999).padStart(79, '0')].marks, undefined, 'the oldest lost them');
  // before writing, a round keeps the newest 250 removals of payments by hand
  const capped = withoutOldTombs(one, NOW);
  const kept = Object.keys(capped.byHand);
  assert.equal(kept.length, TOMBS_WRITTEN);
  assert.ok(kept.includes('t' + String(0).padStart(79, '0')) && !kept.includes('t' + String(250).padStart(79, '0')));
  assert.ok(readSharedFile(fileText(capped)));
});

/* ------------------------------------------------------------------ suggestions */

test('suggestions are scored as Appendix A says: each point a reason, 3 or more shown, best first', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  // a subscription rule marked for a look (+3) at a steady price (+1)
  charges(state, 'SPOTIFY USA 877-778-1161', 1199, monthly('2026-06-16', 6, 16));
  // a sure one: listed without a tap
  charges(state, 'NETFLIX.COM', 1549, monthly('2026-06-07', 6, 7));
  // two charges a month apart within 10% that detection leaves (two charges make a line only at one price): +2, steady +1
  charges(state, 'QUILLMARK NOTES', 499, ['2026-10-11']);
  charges(state, 'QUILLMARK NOTES', 519, ['2026-11-10']);
  // one charge of a software seller in 13 months (+1): too few points alone
  charges(state, 'WAVES AUDIO LTD', 7999, ['2026-03-03']);
  // with a subscription seller's code (+2): shown, its cadence asked
  state.txs.push(makeTx({ id: 'tx_mcc', accountId: 'acc_card', day: '2026-04-04', postedDay: '2026-04-04', amount: 5900, flow: 'out', kind: 'spend', raw: 'FABFILTER BV', mcc: '5734', fp: 'acc_card|2026-04-04|-5900|fab|0', ext: { id: 'fab' } }));
  // a shop seen often (−3) at two prices a month apart
  charges(state, 'CORNER MART', 450, ['2026-10-16', '2026-11-03', '2026-11-05', '2026-11-08', '2026-11-11', '2026-11-15']);
  // a line of the Book filed as a gym (health) and not essential (+3), at a steady price (+1)
  charges(state, 'HARBOR GYM CLUB', 4500, monthly('2026-06-21', 5, 21));
  refresh(state, NOW);
  const subs = repertoire(state, NOW);
  const byName = (list) => Object.fromEntries(list.map((one) => [one.mkey, one]));
  assert.ok(byName(subs.list).netflix, 'a sure one is on the list');
  const possible = byName(subs.possible);
  assert.deepEqual([possible.spotify.score, possible.spotify.reasons], [4, ['rule', 'steady']]);
  assert.deepEqual([possible['quillmark notes'].score, possible['quillmark notes'].reasons, possible['quillmark notes'].cadence], [3, ['pair', 'steady'], 'monthly']);
  assert.deepEqual([possible.fabfilter.score, possible.fabfilter.reasons, possible.fabfilter.cadence], [3, ['once', 'mcc'], null]);
  assert.equal(possible.waves, undefined, 'one point is not enough');
  assert.equal(possible['corner mart'], undefined, 'a shop');
  const gym = state.recurring.find((rec) => rec.mkey === 'harbor gym club');
  assert.deepEqual([gym.category, gym.source, gym.essential], ['health', 'detected', false]);
  assert.deepEqual([possible['harbor gym club'].score, possible['harbor gym club'].reasons], [4, ['kind', 'steady']]);
  // best first: by score, then the latest charge
  assert.deepEqual(subs.possible.map((one) => one.mkey), ['spotify', 'harbor gym club', 'quillmark notes', 'fabfilter'], 'best first');
});

test('Add and Not one travel: a suggestion added on one device is on the list on the other; Not one is dismissed on both', async () => {
  const build = () => {
    const state = defaultState(at(2026, 1, 1));
    state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
    charges(state, 'SPOTIFY USA 877-778-1161', 1199, monthly('2026-06-16', 6, 16));
    charges(state, 'QUILLMARK NOTES', 499, ['2026-10-11']);
    charges(state, 'QUILLMARK NOTES', 519, ['2026-11-10']);
    state.txs.push(makeTx({ id: 'tx_mcc', accountId: 'acc_card', day: '2026-04-04', postedDay: '2026-04-04', amount: 5900, flow: 'out', kind: 'spend', raw: 'FABFILTER BV', mcc: '5734', fp: 'acc_card|2026-04-04|-5900|fab|0', ext: { id: 'fab' } }));
    refresh(state, NOW);
    return state;
  };
  const a = deviceOf(build(), () => NOW);
  const b = deviceOf(build(), () => NOW + MIN);
  const repo = memory();
  const item = (d, mkey) => {
    const subs = repertoire(d.state, NOW);
    return [...subs.possible, ...subs.list, ...subs.dismissed].find((one) => one.mkey === mkey);
  };
  a.update((s) => { decideLine(s, s.recurring.find((rec) => rec.mkey === 'spotify'), 'sub', true, a.clock()); }, { undo: 'add' });
  a.update((s) => { decideLine(s, item(a, 'quillmark notes').line, 'sub', false, a.clock()); }, { undo: 'not one' });
  a.update((s) => { decideLine(s, item(a, 'fabfilter').line, 'sub', true, a.clock(), { cad: 'annual' }); }, { undo: 'add yearly' });
  await settle([a, b], repo);
  for (const d of [a, b]) {
    const subs = repertoire(d.state, NOW);
    assert.ok(subs.list.some((one) => one.mkey === 'spotify'), 'Add: on the list');
    assert.ok(subs.dismissed.some((one) => one.mkey === 'quillmark notes'), 'Not one: dismissed');
    assert.ok(subs.list.some((one) => one.mkey === 'fabfilter' && one.cadence === 'annual'), 'a yearly one, its line made from the bank row');
  }
  assert.ok(b.state.recurring.some((rec) => rec.mkey === 'fabfilter' && rec.madeFor), 'B made the line from its own bank row');
  a.undo();
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) {
    const subs = repertoire(d.state, NOW);
    assert.ok(subs.possible.some((one) => one.mkey === 'quillmark notes'), 'Undo of Not one: possible again');
    assert.ok(subs.possible.some((one) => one.mkey === 'fabfilter'), 'Undo of Add: possible again');
    assert.equal(subs.list.some((one) => one.mkey === 'fabfilter'), false, 'and off the list');
    assert.equal(d.state.recurring.some((rec) => rec.mkey === 'fabfilter'), false, 'the line made for it is gone');
  }
  await assertQuiet([a, b], repo, 'suggestions');
});

/* ------------------------------------------------------------------ the floor */

test('the shared floor is the later first day of any device; it bounds the queue on both', async () => {
  const a = deviceOf(record({ months: 6 }), () => NOW);
  const b = deviceOf(record({ months: 2 }), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  assert.equal(floorOf(a.state), floorOf(b.state));
  assert.equal(floorOf(a.state), b.state.txs.map((t) => t.day).sort()[0]);
  const q = moveQueue(a.state, NOW);
  assert.ok(q.from >= floorOf(a.state));
  assert.deepEqual(exportFlows(a.state, NOW).since, floorOf(a.state));
});

/* ------------------------------------------------------------------ words */

test('every word of the subscriptions, the notice and rule 6 is in both modes with the same placeholders; the glossary names them as the page does', () => {
  const keys = Object.keys(PHRASES).filter((key) => /^flows\.(subs|verdict|notice|toast\.(sub|verdict)|leak\.still|undo\.(sub|verdict))|^recurring\.(sub|added)\./.test(key));
  assert.ok(keys.length >= 50, keys.length + ' phrases');
  for (const key of keys) {
    assert.ok(PHRASES[key].chess && PHRASES[key].finance, key);
    assert.deepEqual(placeholders(PHRASES[key].finance), placeholders(PHRASES[key].chess), key);
  }
  for (const mode of ['chess', 'finance']) {
    assert.equal(term('repertoire', mode), phrase('flows.subs', mode));
    assert.equal(term('possible', mode), phrase('flows.subs.possible', mode));
  }
  assert.deepEqual([term('repertoire', 'chess'), term('repertoire', 'finance'), term('possible', 'chess'), term('possible', 'finance')],
    ['Repertoire', 'Subscriptions', 'Possible lines', 'Possible']);
  assert.ok(TERMS.some((one) => one.key === 'repertoire') && TERMS.some((one) => one.key === 'possible'));
  // a target travels now: the page no longer says it stays on this device
  assert.doesNotMatch(phrase('flows.went.foot', 'chess'), /this device/);
});

test('the sample game shows all three groups of the repertoire: on the list, possible and added by you', async () => {
  const { buildDemoState } = await import('../js/model/demo.js');
  const now = at(2026, 6, 18, 14);
  const state = buildDemoState(now);
  const subs = repertoire(state, now);
  assert.ok(subs.list.length >= 2, 'on the list');
  assert.ok(subs.possible.length >= 1, 'possible');
  assert.deepEqual(subs.added.map((one) => one.name), ['Larkspur Yoga']);
  assert.equal(subs.added[0].charged, false, 'no charge yet');
  // and its copy is seeded, so a choice in it can be tried
  assert.ok(state.share.flows && state.share.flows.added);
  assert.deepEqual(exportShared(state, now).flows.targets, { cafe: { v: 12000, at: 0 } });
});

test('an older copy of the section in the device: joinFlows of a copy and a merged file keeps every cell the copy made', () => {
  const s = validSection();
  const copy = readFlows(s);
  const other = readFlows({ lines: { ['l' + HEX(9)]: { ...facts(9), sub: cell(true, 50) } } });
  const joined = joinFlows(copy, other);
  assert.equal(Object.keys(joined.lines).length, 4);
  assert.deepEqual(applyFlows({}, 0), false);
});

/* ------------------------------------------------------------------ fixes, round 1 (NOTES-2) */

/** A line added by hand, as the Book's "Add an entry" and "+ Add a subscription" write it: one undoable update. */
function addByHand(d, fields, opts) {
  let made = null;
  d.update((s) => {
    made = makeRecurring({ cadence: 'monthly', anchor: '2026-12-01', source: 'manual', category: 'subscriptions', since: '2026-11-16', locks: ['name', 'category', 'purpose'], ...fields });
    s.recurring.push(made);
    noteAdded(s, made, d.clock(), opts);
    refresh(s, d.clock());
  }, { undo: 'added' });
  return made;
}

const byHandOf = (state, mkey) => state.recurring.filter((rec) => rec.mkey === mkey && rec.source === 'manual' && !rec.byHand);

test('fixes 1: two lines added by hand of one payee and cadence stay two lines on both devices, by the Book and by the first run', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  // two yearly plans of one seller, in one price band, added one after the other
  addByHand(a, { name: 'Orchard Notes', mkey: 'orchard notes', amount: 1499, cadence: 'annual' });
  addByHand(a, { name: 'Orchard Notes', mkey: 'orchard notes', amount: 1699, cadence: 'annual' });
  await settle([a, b], repo);
  for (const d of [a, b]) {
    const mine = byHandOf(d.state, 'orchard notes');
    assert.deepEqual(mine.map((rec) => rec.amount).sort(), [1499, 1699], 'two lines, each its own amount');
    assert.equal(new Set(mine.map((rec) => rec.added)).size, 2, 'two entries');
  }
  // an edit of one leaves the other as it is, on both
  a.update((s) => { const one = byHandOf(s, 'orchard notes').find((rec) => rec.amount === 1699); one.amount = 1799; noteAdded(s, one, a.clock()); }, { undo: 'edit' });
  await settle([a, b], repo);
  for (const d of [a, b]) assert.deepEqual(byHandOf(d.state, 'orchard notes').map((rec) => rec.amount).sort(), [1499, 1799]);
  await assertQuiet([a, b], repo, 'two lines by hand');

  // the first run: the same pair on two devices before this version: ranked by content, so both make the same two entries
  const build = (order) => {
    const state = record();
    for (const amount of order) state.recurring.push(makeRecurring({ name: 'Orchard Notes', mkey: 'orchard notes', amount, cadence: 'annual', anchor: '2026-12-01', source: 'manual', category: 'subscriptions', since: '2026-10-01' }));
    seedFlows(state, NOW);
    return state;
  };
  const c = deviceOf(build([1699, 1499]), () => NOW);
  const e = deviceOf(build([1499, 1699]), () => NOW + MIN);
  const repo2 = memory();
  await settle([c, e], repo2);
  for (const d of [c, e]) {
    assert.deepEqual(byHandOf(d.state, 'orchard notes').map((rec) => rec.amount).sort(), [1499, 1699], 'two lines, not one rewritten');
    assert.equal(Object.keys(storedFlows(d.state).added).length, 2);
  }
  assert.deepEqual(c.state.share.flowsNotice || [], [], 'nothing replaced');
  await assertQuiet([c, e], repo2, 'the first run of two lines');
});

test('fixes 1: the first run of one line added by hand at two prices (two bands) on two devices makes one entry, and the notice names the price replaced', async () => {
  const build = (amount) => {
    const state = record();
    state.recurring.push(makeRecurring({ name: 'Harbor Gym', mkey: 'harbor gym', amount, cadence: 'monthly', anchor: '2026-11-30', source: 'manual', category: 'health', since: '2026-10-01' }));
    seedFlows(state, NOW);
    return state;
  };
  const a = deviceOf(build(4500), () => NOW);
  const b = deviceOf(build(6000), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  const amounts = [a, b].map((d) => byHandOf(d.state, 'harbor gym').map((rec) => rec.amount));
  assert.deepEqual(amounts[0], amounts[1], 'one line, the same on both');
  assert.equal(amounts[0].length, 1, 'counted once');
  assert.equal(Object.keys(storedFlows(a.state).added).length, 1, 'one entry');
  const told = [a, b].filter((d) => (d.state.share.flowsNotice || []).length);
  assert.equal(told.length, 1, 'the device whose price was replaced is told');
  const [item] = told[0].state.share.flowsNotice;
  assert.equal(item.kind, 'added');
  assert.deepEqual([item.was.amount, item.now.amount].sort(), [4500, 6000]);
  assert.equal(item.now.amount, amounts[0][0], 'the amount now is the one kept');
  await assertQuiet([a, b], repo, 'one line at two prices');
});

test('fixes 1: an Undo, a Restore and a cut cleared travel with 100 other live line decisions; removals have a pool of their own', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  // 100 older live decisions on lines neither device holds (each "Not one" is such a decision, and never ages out)
  a.update((s) => {
    const lines = {};
    for (let k = 1; k <= 100; k++) lines['l' + HEX(k)] = { p: 'p' + HEX(k), cad: 'monthly', amt: 1000 + k, dom: 5, sub: cell(false, NOW - DAY_MS - k) };
    s.share.flows = joinFlows(s.share.flows, { lines });
  });
  await settle([a, b], repo);
  const seen = (d) => decisionsFor(storedFlows(d.state), d.state.recurring).byLine.get(lineOf(d.state, 'streamline video').id);
  for (const [field, value] of [['sub', true], ['sub', false], ['verdict', 'cut']]) {
    decide(a, 'streamline video', field, value);
    await settle([a, b], repo);
    assert.deepEqual(seen(b)[field].v, value, field + ': B holds it');
    // Undo of a first decision (for Not one, the Restore the toast offers is the same removal)
    a.undo();
    await settle([a, b], repo);
    for (const d of [a, b]) assert.ok(seen(d)[field].deleted, field + ' ' + value + ': the removal reached both');
    assert.equal(lineOf(b.state, 'streamline video').verdict, null);
  }
  // Cut, then Cut again (a removal on a line that is live elsewhere)
  decide(a, 'streamline video', 'verdict', 'cut');
  await settle([a, b], repo);
  decide(a, 'streamline video', 'verdict', null);
  await settle([a, b], repo);
  assert.equal(lineOf(b.state, 'streamline video').verdict, null, 'Cut again reached B');
  const file = readSharedFile(repo.text);
  const lines = Object.values(file.flows.lines);
  const live = lines.filter((line) => ['sub', 'verdict', 'active'].some((f) => line[f] && !line[f].deleted)).length;
  assert.ok(live <= FLOWS_CAPS.lines && lines.length - live <= FLOWS_CAPS.linesGone, live + ' live, ' + (lines.length - live) + ' removals');
  await assertQuiet([a, b], repo, '100 live decisions');
});

test('fixes 1: the size budget holds with the 30 lines of removals at the longest values of G.10', () => {
  const AT = 99999999999999;
  const section = worstSection();
  const base = { v: 1, app: 'networth', savedAt: AT, byHand: {} };
  const size = fileText({ ...base, flows: section }).length - fileText(base).length;
  const gone = { ...section, lines: { ...section.lines } };
  for (let i = 0; i < FLOWS_CAPS.linesGone; i++) {
    gone.lines['l' + HEX(1e6 + i)] = { p: 'p' + HEX(1e6 + i), cad: 'semimonthly', amt: 1e10, dom: 366, sub: { deleted: true, at: AT, undo: true }, verdict: { deleted: true, at: AT, undo: true }, active: { deleted: true, at: AT, undo: true } };
  }
  const whole = readFlows(gone);
  assert.ok(whole, 'the reader takes them (130 lines, under its 400)');
  assert.deepEqual(pruneFlows(whole), whole, 'at its caps, nothing pruned');
  const more = fileText({ ...base, flows: whole }).length - fileText(base).length - size;
  assert.ok(more <= 30 * 262, '30 lines of removals add ' + more);
  if (process.env.SIZE) console.log('30 lines of removals add', more, '; worst case', 1990100 - 107250 + size + more);
  // G.10's worst case before them had a margin of 30,922 characters (31,322 before round 3 wrote the removals)
  const tombs = (n) => { const b = {}; for (let i = 0; i < n; i++) b['t' + String(i).padStart(79, '0')] = { deleted: true, editedAt: AT }; return b; };
  const freed = fileText({ ...base, byHand: tombs(1000) }).length - fileText({ ...base, byHand: tombs(TOMBS_WRITTEN) }).length;
  const worst = 1990100 - freed + size + more;
  assert.ok(worst < 2000000, 'the worst case is ' + worst);
});

test('fixes 1: a record with no copy (a backup from before this version) seeds its cut at the moment it is read, never at 1970, and no 1970 cut ever claims a charge', async () => {
  const cutRecord = () => {
    const state = record();
    const line = lineOf(state, 'streamline video');
    line.verdict = 'cut';
    line.locks.push('verdict');
    return state;
  };
  // what such a record writes: its cut of today
  const old = cutRecord();
  const written = Object.values(exportFlows(old, NOW).lines).find((line) => line.verdict);
  assert.equal(written.verdict.day, '2026-11-16');
  // read with no copy and no time: the seeds' cut is no day the owner cut on, and claims nothing
  charges(old, 'STREAMLINE VIDEO 800-555', 1599, ['2026-11-20']);
  refresh(old, at(2026, 11, 22));
  assert.deepEqual(leaks(old, at(2026, 11, 22), 30).still, []);
  // two devices: A with no copy, B seeded at its start; both cut the line before this version
  const a = deviceOf(cutRecord(), () => NOW);
  const bState = cutRecord();
  seedFlows(bState, NOW - DAY_MS);
  const b = deviceOf(bState, () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  assert.doesNotMatch(repo.text, /19[67]\d-/, 'no day of 1970 in the file');
  for (const d of [a, b]) {
    const entry = Object.values(storedFlows(d.state).lines).find((line) => line.verdict);
    assert.ok(entry.verdict.day >= '2026-11-15', 'the cut carries a day of the update: ' + entry.verdict.day);
    charges(d.state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-11-17']);
    refresh(d.state, at(2026, 11, 22));
    assert.deepEqual(leaks(d.state, at(2026, 11, 22), 30).still, [], 'a charge made around the update is not claimed');
  }
  // a decision on a record with no copy makes the copy first, at that moment
  const c = cutRecord();
  decideLine(c, lineOf(c, 'kitefield cloud'), 'verdict', 'keep', NOW);
  assert.equal(Object.values(storedFlows(c).lines).find((line) => line.verdict && line.verdict.v === 'cut').verdict.day, '2026-11-16');
  assert.ok(c.share.flowsSeeds, 'its seeds kept apart, for the notice');
});

test('fixes 1: the notice is said once: an Undo of an earlier change does not bring it back', async () => {
  const build = (dismissed) => {
    const state = record();
    const line = lineOf(state, 'kitefield cloud');
    line.active = !dismissed;
    line.locks.push('active');
    seedFlows(state, NOW);
    return state;
  };
  const a = deviceOf(build(true), () => NOW);
  const b = deviceOf(build(false), () => NOW + MIN);
  const repo = memory();
  // B changes something it can undo, before the round that replaces its seed
  b.update((s) => { noteTarget(s, 'cafe', 9000, b.clock()); }, { undo: 'target' });
  await settle([a, b], repo);
  assert.equal((b.state.share.flowsNotice || []).length, 1, 'B is told its seed was replaced');
  b.update((s) => { closeNotice(s); });
  assert.deepEqual(b.state.share.flowsNotice, []);
  assert.ok(b.undo(), 'B undoes the target');
  assert.deepEqual(b.state.share.flowsNotice, [], 'the notice is not said again');
  assert.ok((b.state.share.flowsNoticed || []).length === 1, 'and stays read');
  await settle([a, b], repo);
  assert.deepEqual(b.state.share.flowsNotice, []);
  assert.equal(b.state.settings.targets.cafe, undefined, 'the Undo itself travelled as usual');
});

test('fixes 1: two series of one payee within 35% on one card keep separate verdicts and two keys, from the Book and from the repertoire', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  charges(state, 'NIMBUS APPS 800-555', 699, monthly('2026-06-04', 6, 4));
  charges(state, 'NIMBUS APPS 800-555', 999, monthly('2026-06-20', 6, 20));
  refresh(state, NOW);
  const lines = () => state.recurring.filter((rec) => rec.mkey === 'nimbus apps').sort((x, y) => x.amount - y.amount);
  assert.deepEqual(lines().map((rec) => rec.amount), [699, 999]);
  decideLine(state, lines()[1], 'verdict', 'keep', NOW);
  decideLine(state, lines()[0], 'verdict', 'cut', NOW + MIN);
  assert.deepEqual(lines().map((rec) => rec.verdict), ['cut', 'keep'], 'each its own');
  assert.equal(Object.keys(storedFlows(state).lines).length, 2, 'two keys');
  decideLine(state, lines()[1], 'verdict', 'review', NOW + 2 * MIN);
  assert.deepEqual(lines().map((rec) => rec.verdict), ['cut', 'review'], 'a second decision on one leaves the other');
  assert.equal(Object.keys(storedFlows(state).lines).length, 2);
});

test('fixes 1: after a card change the decision reaches the line still running, whichever id sorts first', () => {
  for (const order of [['rec_a', 'rec_z'], ['rec_z', 'rec_a']]) {
    const state = defaultState(at(2026, 1, 1));
    state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
    state.accounts.push(makeAccount({ id: 'acc_card2', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-2' }, name: 'Card 2', balance: -1, basis: 'bank' }));
    // the old card's line, ended, and the new card's: one payee, cadence, amount and billing day
    state.recurring.push(makeRecurring({ id: order[0], name: 'Streamline Video', mkey: 'streamline video', accountId: 'acc_card', amount: 1599, cadence: 'monthly', anchor: '2026-07-14', source: 'detected', category: 'subscriptions', active: false }));
    state.recurring.push(makeRecurring({ id: order[1], name: 'Streamline Video', mkey: 'streamline video', accountId: 'acc_card2', amount: 1599, cadence: 'monthly', anchor: '2026-11-14', source: 'detected', category: 'subscriptions' }));
    seedFlows(state, NOW);
    const running = state.recurring.find((rec) => rec.id === order[1]);
    decideLine(state, running, 'verdict', 'cut', NOW);
    assert.equal(state.recurring.find((rec) => rec.id === order[1]).verdict, 'cut', order + ': the running line holds the cut');
    assert.equal(state.recurring.find((rec) => rec.id === order[0]).verdict || null, null, order + ': the ended line nothing');
  }
});

test('fixes 1: a device that sees one of two series keeps its line\'s own decision; the other series\' waits', async () => {
  const card = (state) => state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  const aState = defaultState(at(2026, 1, 1));
  card(aState);
  charges(aState, 'NIMBUS APPS 800-555', 999, monthly('2026-06-04', 6, 4));
  charges(aState, 'NIMBUS APPS 800-555', 1299, monthly('2026-06-20', 6, 20));
  refresh(aState, NOW);
  const bState = defaultState(at(2026, 1, 1));
  card(bState);
  charges(bState, 'NIMBUS APPS 800-555', 1299, monthly('2026-06-20', 6, 20));
  refresh(bState, NOW);
  const a = deviceOf(aState, () => NOW);
  const b = deviceOf(bState, () => NOW + MIN);
  const repo = memory();
  const line = (d, cents) => d.state.recurring.find((rec) => rec.mkey === 'nimbus apps' && rec.amount === cents);
  a.update((s) => { decideLine(s, line(a, 1299), 'verdict', 'keep', NOW); }, { undo: 'keep' });
  a.update((s) => { decideLine(s, line(a, 999), 'verdict', 'cut', NOW + 5 * MIN); }, { undo: 'cut' });
  await settle([a, b], repo);
  assert.equal(line(b, 1299).verdict, 'keep', 'B\'s line keeps its own Keep');
  assert.equal(decisionsFor(storedFlows(b.state), b.state.recurring).waiting.length, 1, 'the cut of the other series waits');
  charges(b.state, 'NIMBUS APPS 800-555', 1299, ['2026-11-20']);
  refresh(b.state, at(2026, 11, 26));
  assert.deepEqual(leaks(b.state, at(2026, 11, 26), 30).still, [], 'no claim on the line the owner kept');
  assert.deepEqual([line(a, 999).verdict, line(a, 1299).verdict], ['cut', 'keep']);
});

test('fixes 1: an Undo of "Not a recurring bill" on a line added by hand, whose date is long past, brings it back in the Book on both devices', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  addByHand(a, { name: 'Larkspur Studio', mkey: 'larkspur studio', amount: 8000, anchor: '2026-08-01', category: 'household' });
  await settle([a, b], repo);
  a.update((s) => { decideLine(s, byHandOf(s, 'larkspur studio')[0], 'active', false, a.clock()); }, { undo: 'out' });
  await settle([a, b], repo);
  assert.equal(byHandOf(b.state, 'larkspur studio')[0].active, false);
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(byHandOf(d.state, 'larkspur studio')[0].active, true, 'back in the Book');
  await assertQuiet([a, b], repo, 'active undone');
});

test('fixes 1: a line added by hand renamed before its first charge takes its new key on every device; made elsewhere, it starts on the day it was added', async () => {
  const a = deviceOf(record(), () => NOW);
  const b = deviceOf(record(), () => NOW + 3 * DAY_MS);
  const repo = memory();
  await settle([a, b], repo);
  addByHand(a, { name: 'Yoga Studio', mkey: 'yoga studio', amount: 4500, anchor: '2026-09-20', category: 'health' });
  await settle([a, b], repo);
  const there = b.state.recurring.find((rec) => rec.source === 'manual' && rec.name === 'Yoga Studio');
  assert.equal(there.since, '2026-11-16', 'since: the day it was added, not its typed date');
  // renamed as the bank will print it (the sheet's own rule: the key follows the name while it is not charged)
  a.update((s) => {
    const one = s.recurring.find((rec) => rec.source === 'manual' && rec.name === 'Yoga Studio');
    one.name = 'LARKSPUR YOGA CO';
    one.mkey = merchantOf({ description: one.name }).mkey;
    noteAdded(s, one, a.clock());
  }, { undo: 'rename' });
  await settle([a, b], repo);
  const keys = [a, b].map((d) => d.state.recurring.find((rec) => rec.source === 'manual' && rec.name === 'LARKSPUR YOGA CO').mkey);
  assert.equal(keys[0], keys[1], 'one key on both: ' + keys);
  a.update((s) => { decideLine(s, s.recurring.find((rec) => rec.name === 'LARKSPUR YOGA CO'), 'verdict', 'review', a.clock()); }, { undo: 'review' });
  await settle([a, b], repo);
  assert.equal(b.state.recurring.find((rec) => rec.name === 'LARKSPUR YOGA CO').verdict, 'review', 'a decision keyed by the new name reaches it');
});

test('fixes 1: one charge filed by a subscription rule marked for a look is suggested (+3), its cadence asked; Add on it shows the bank\'s price', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  charges(state, 'APPLE.COM/BILL 866-712-7753', 9999, ['2026-10-02']);
  charges(state, 'LUMEN STUDIO PRO', 7999, ['2026-10-20']);
  state.txs[state.txs.length - 1].mcc = '5734';
  state.txs[state.txs.length - 1].category = 'software';
  refresh(state, NOW);
  seedFlows(state, NOW);
  const subs = repertoire(state, NOW);
  const apple = subs.possible.find((one) => one.reasons.includes('rule'));
  assert.ok(apple, 'suggested: ' + JSON.stringify(subs.possible.map((one) => [one.name, one.reasons])));
  assert.equal(apple.cadence, null, 'its cadence is asked');
  assert.ok(apple.score >= 3);
  // Add on a charge seen once: the line made from the bank's row reads as last charged (roman), with its next day
  for (const one of subs.possible) decideLine(state, one.line, 'sub', true, NOW, { cad: 'monthly' });
  const after = repertoire(state, NOW);
  assert.ok(after.list.length >= 2, 'on the list');
  for (const item of after.list) {
    assert.equal(item.charged, true, item.name + ': charged');
    assert.equal(item.est, false, item.name + ': the bank\'s price');
    assert.ok(item.next > '2026-11-16', item.name + ': a next day');
  }
});

test('fixes 1: the period\'s figures start at the shared floor on every device, whatever the length of its own record', () => {
  const build = (from) => {
    const state = defaultState(at(2026, 1, 1));
    state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
    const days = [];
    for (let d = from; d <= '2026-11-15'; d = addDays(d, 7)) days.push(d);
    for (const day of days) {
      seq += 1;
      state.txs.push(makeTx({ id: 'tx_f' + seq, accountId: 'acc_card', day, postedDay: day, amount: 4500, flow: 'out', kind: 'spend', raw: 'CORNER MARKET 12', fp: 'acc_card|' + day + '|-4500|corner|' + seq, ext: { id: 'ext-f-' + seq } }));
      seq += 1;
      state.txs.push(makeTx({ id: 'tx_f' + seq, accountId: 'acc_card', day, postedDay: day, amount: 300, flow: 'out', kind: 'spend', raw: 'MONTHLY SERVICE FEE', fp: 'acc_card|' + day + '|-300|fee|' + seq, ext: { id: 'ext-f-' + seq } }));
    }
    refresh(state, NOW);
    seedFlows(state, NOW);
    state.share.flows = joinFlows(state.share.flows, { since: '2026-09-01' });
    return state;
  };
  // A's own record starts in June, B's on the floor; the rows from the floor on are the same
  const a = build('2026-06-02');
  const b = build('2026-09-01');
  const first = b.txs.map((tx) => tx.day).sort()[0];
  for (const tx of a.txs) tx.fp = tx.fp.replace(/\|\d+$/, '');
  assert.ok(first >= '2026-09-01');
  for (const days of [30, 90, 365]) {
    const w = windowsOf('2026-11-16', days, '2026-09-01');
    assert.ok(w.from >= '2026-09-01' || days === 30, days + ': the sums start at the floor');
    const [x, y] = [a, b].map((s) => inAndOut(s, NOW, days));
    assert.equal(x.out.total, y.out.total, days + ' days: money out');
    const [p, q] = [a, b].map((s) => whereItWent(s, NOW, days));
    assert.equal(JSON.stringify(p.total), JSON.stringify(q.total), days + ' days: where it went');
    const [f, g] = [a, b].map((s) => leaks(s, NOW, days).fees);
    assert.equal(JSON.stringify(f), JSON.stringify(g), days + ' days: fees and their year');
  }
});

test('fixes 1: "+ Add a subscription" offers the merchants likely to be one first', () => {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  charges(state, 'KEY FOOD 0412', 2310, ['2026-11-15']);
  charges(state, 'UBER TRIP', 1830, ['2026-11-14']);
  charges(state, 'FABFILTER BV', 5900, ['2026-10-04']);
  state.txs[state.txs.length - 1].mcc = '5734';
  refresh(state, NOW);
  const offered = recentMerchants(state, NOW).map((one) => one.mkey);
  assert.equal(offered[0], 'fabfilter', 'the seller of software first: ' + offered);
});

test('fixes 1: applyFlows reads the rows once, however many decisions wait (about 5,000 rows, the section at its caps)', () => {
  const state = record({ months: 13 });
  for (let i = 0; i < 4900; i++) {
    const day = addDays('2025-11-20', i % 360);
    state.txs.push(makeTx({ id: 'tx_p' + i, accountId: 'acc_card', day, postedDay: day, amount: 500 + (i % 700), flow: 'out', kind: 'spend', raw: 'SHOP ' + (i % 900), fp: 'acc_card|' + day + '|' + i, ext: { id: 'ext-p-' + i } }));
  }
  refresh(state, NOW);
  seedFlows(state, NOW);
  const lines = {};
  const added = {};
  for (let k = 1; k <= 100; k++) lines['l' + HEX(k)] = { p: 'p' + HEX(k), cad: 'annual', amt: 1000 + k, dom: 5, sub: cell(true, NOW - k) };
  for (let k = 1; k <= 40; k++) added['a' + HEX(k)] = cell({ name: 'Line ' + k, amount: 100 + k, cadence: 'monthly', day: '2026-11-01', category: 'other', sub: false, p: 'p' + HEX(500 + k) }, NOW - k);
  state.share.flows = joinFlows(state.share.flows, { lines, added });
  applyFlowsNow(state, NOW);
  const start = performance.now();
  for (let i = 0; i < 5; i++) applyFlowsNow(state, NOW);
  const each = (performance.now() - start) / 5;
  assert.ok(each < 60, 'applyFlows takes ' + each.toFixed(1) + ' ms');
});

test('fixes 1: the guard: a round compares the pruned merge with the file, so a device still holding what was pruned writes once; a file the guard cannot bring under its mark is still written while a reader takes it', async () => {
  const a = deviceOf(record(), () => NOW);
  const repo = memory();
  await a.round(repo);
  // A holds payments it sends, ticked every day, and removals of decisions (a line's Undo, lines by hand taken back)
  const pay = (i, n) => {
    const marks = {};
    for (let m = 0; m < n; m++) marks[addDays('2025-01-01', m)] = { paid: true, at: NOW - m };
    return makeRecurring({ id: 'pay_' + i, name: 'Payment ' + i, byHand: true, source: 'manual', amount: 10000 + i, cadence: 'monthly', anchor: '2026-11-01', dueDay: 1, since: '2025-01-01', editedAt: NOW - i, marks, skips: {} });
  };
  // calibrate: the payments alone a little under the mark, so the removals take the file over it
  const sizeWith = (n, extra = 0) => {
    const s = JSON.parse(JSON.stringify(a.state));
    s.recurring.push(...Array.from({ length: 200 }, (_, i) => pay(i, n + (i < extra ? 1 : 0))));
    return fileText(exportShared(s, NOW)).length;
  };
  let lo = 1;
  let hi = 400;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sizeWith(mid) < GUARD_TEXT - 1500) lo = mid; else hi = mid - 1; }
  const n = lo;
  // then one tick more on some of them, to come within 1,500 of the mark (a tick is the same size on each)
  const tick = sizeWith(n, 1) - sizeWith(n);
  const extra = Math.max(0, Math.floor((GUARD_TEXT - 1500 - sizeWith(n)) / tick));
  a.update((s) => {
    s.recurring.push(...Array.from({ length: 200 }, (_, i) => pay(i, n + (i < extra ? 1 : 0))));
    const lines = {};
    const added = {};
    for (let k = 1; k <= 30; k++) lines['l' + HEX(k)] = { p: 'p' + HEX(k), cad: 'monthly', amt: 1000 + k, dom: 5, sub: gone(NOW - k * MIN, true) };
    for (let k = 1; k <= 20; k++) added['a' + HEX(k)] = gone(NOW - k * MIN);
    s.share.flows = joinFlows(s.share.flows, { lines, added });
  });
  assert.ok(fileText(exportShared(a.state, NOW)).length > GUARD_TEXT, 'the removals take it over the mark');
  const first = await a.round(repo);
  assert.ok(first.wrote, 'written once, pruned');
  assert.ok(repo.text.length <= GUARD_TEXT, repo.text.length + ' characters');
  const kept = readSharedFile(repo.text).flows;
  assert.ok(Object.keys((kept && kept.lines) || {}).length < 30, 'the oldest removals of decisions were pruned');
  const writes = repo.writes;
  for (let i = 0; i < 3; i++) await a.round(repo);
  assert.equal(repo.writes, writes, 'quiet rounds write nothing');
  // past the mark with nothing left to prune (payments and their ticks), the file is still written, under 2,000,000
  const big = readSharedFile(repo.text);
  delete big.flows;
  const ids = Object.keys(big.byHand).filter((id) => !big.byHand[id].deleted);
  for (let m = 0; fileText(big).length <= GUARD_TEXT + 1000; m++) big.byHand[ids[m % ids.length]].marks[addDays('2027-06-01', Math.floor(m / ids.length))] = { paid: true, at: NOW };
  const text = fileText(big).length;
  assert.ok(text > GUARD_TEXT && text < 2000000, text + ' characters');
  assert.ok(guardShared(big), 'written as it is');
});

test('fixes 1: a removal of a payment the file holds live is kept, however far down: the device still holding the payment receives it', () => {
  const tombs = {};
  for (let i = 0; i < TOMBS_WRITTEN; i++) tombs['t' + String(i).padStart(4, '0')] = { deleted: true, editedAt: NOW - i * 1000 };
  const merged = { v: 1, app: 'networth', savedAt: 1, byHand: { ...tombs, window: { deleted: true, editedAt: NOW - 10 * DAY_MS } } };
  const read = { v: 1, app: 'networth', savedAt: 1, byHand: { window: { name: 'Window cleaner', amount: 12000, dueDay: 3, since: '2026-01-01', active: true, editedAt: NOW - 20 * DAY_MS, deleted: false, payee: null, payeeAt: 0, marks: {}, skips: {} } } };
  assert.equal(withoutOldTombs(merged, NOW).byHand.window, undefined, 'past the 250, it stops travelling');
  assert.ok(withoutOldTombs(merged, NOW, read).byHand.window, 'unless the file just read holds the payment live');
  // and the 400-day variant
  const older = { ...merged, byHand: { window: { deleted: true, editedAt: NOW - 401 * DAY_MS } } };
  assert.equal(withoutOldTombs(older, NOW).byHand.window, undefined);
  assert.ok(withoutOldTombs(older, NOW, read).byHand.window);
});

test('fixes 1: the subscriptions on the page: Dismissed opens as the other lists do, the head\'s two figures count one scope, the cadence switch is set in words, a yearly line names its year, and the notice leads with a label', () => {
  const helper = fileURLToPath(new URL('./helpers/render-flows.mjs', import.meta.url));
  for (const words of ['chess', 'finance']) {
    const page = JSON.parse(execFileSync(process.execPath, [helper, words, 'dismissed', 'notice'], { encoding: 'utf8' }));
    assert.ok(!page.startsWith('ERROR'), page.slice(0, 400));
    const subs = page.slice(page.indexOf('class="band fl-subs"'), page.indexOf('</section>', page.indexOf('class="band fl-subs"')));
    // the native toggle: no action cancels it and the page sets no `open` of its own
    const gone = subs.slice(subs.indexOf('<details class="fl-s-gone"'));
    assert.match(gone, /^<details class="fl-s-gone">\s*<summary class="btn-link">/, words + ': ' + gone.slice(0, 120));
    assert.doesNotMatch(subs, /flows\.dismissed/);
    assert.match(gone, /data-to="restore"/, 'the Restore rows are in it');
    // one scope: the head says a month and a year of the same lines; the group heads give counts only
    const head = subs.slice(0, subs.indexOf('</div>'));
    assert.match(head, /a month<\/span>|a month ·/);
    assert.match(head, /a year/);
    assert.doesNotMatch(subs.slice(subs.indexOf('fl-grp-head')), /a year<\/span><\/p>/);
    // the cadence switch of a suggestion seen once is set as the face switch is, not in the figures' face
    assert.doesNotMatch(subs, /seg seg-fig/);
    // a yearly line's next day carries its year
    assert.match(subs, /yearly · [^<]*next [A-Z][a-z]{2} \d{1,2}, 2027/);
    // the notice: a short label, then the sentence in the caption's voice; a line by hand named with its amounts
    assert.match(page, /<div class="fl-notice" role="status">\s*<p class="cap"><b class="lab">From your devices<\/b> Your devices compared/);
    assert.match(page, /Harbor Gym, <span class="nowrap" data-fig>\$45\.00<\/span> in place of <span class="nowrap" data-fig>\$60\.00<\/span>/);
  }
});

/* ------------------------------------------------------------------ fixes, round 2 */

/** The decision a device's line shows of one field, read as the app reads it (every key that reaches the line). */
function shown(state, mkey, field, pick) {
  const rec = pick ? pick(state) : lineOf(state, mkey);
  const one = rec && decisionsFor(storedFlows(state), state.recurring, lineHistory(state)).byLine.get(rec.id);
  const v = one && one[field] ? cellValue(one[field]) : undefined;
  return v === undefined ? null : v;
}

function cards(state) {
  state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  state.accounts.push(makeAccount({ id: 'acc_card2', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-2' }, name: 'Card 2', balance: -1, basis: 'bank' }));
  return state;
}

/** An invented app seller's charges, as a software seller's (its merchant category code). */
function quill(state, days, cents) {
  const from = state.txs.length;
  charges(state, 'QUILLPAD APP', cents, days);
  for (const tx of state.txs.slice(from)) tx.mcc = '5734';
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const readCss = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8');

test('fixes 2: one line with two keys (a rise across a band, decided on two devices before they meet) shows the later decision of each field on both', async () => {
  const aState = cards(defaultState(at(2026, 1, 1)));
  charges(aState, 'STREAMLINE VIDEO 800-555', 1599, monthly('2026-06-14', 5, 14));
  refresh(aState, NOW);
  const bState = clone(aState);
  // B sees the rise first: Nov 14 at 18.49, another price band
  charges(bState, 'STREAMLINE VIDEO 800-555', 1849, ['2026-11-14']);
  refresh(bState, NOW);
  assert.equal(lineOf(bState, 'streamline video').amount, 1849);
  assert.notEqual(lineFacts(lineOf(aState, 'streamline video')).key, lineFacts(lineOf(bState, 'streamline video')).key, 'two keys');
  const a = deviceOf(aState, () => NOW + 20 * MIN);
  const b = deviceOf(bState, () => NOW + 21 * MIN);
  const repo = memory();
  const on = (d, field, value, stamp) => d.update((s) => { decideLine(s, lineOf(s, 'streamline video'), field, value, stamp); }, { undo: field });
  on(a, 'sub', true, NOW + MIN);
  on(b, 'verdict', 'keep', NOW + 2 * MIN);
  on(a, 'verdict', 'cut', NOW + 3 * MIN);
  on(b, 'sub', false, NOW + 4 * MIN);
  await settle([a, b], repo);
  // then the bank data agree: A gets the risen charge too
  charges(a.state, 'STREAMLINE VIDEO 800-555', 1849, ['2026-11-14']);
  refresh(a.state, NOW);
  await settle([a, b], repo);
  for (const [name, d] of [['A', a], ['B', b]]) {
    assert.equal(lineOf(d.state, 'streamline video').amount, 1849, name);
    assert.equal(shown(d.state, 'streamline video', 'sub'), false, name + ': Not one, the latest word on sub, made at the new price');
    assert.equal(shown(d.state, 'streamline video', 'verdict'), 'cut', name + ': the cut, the latest verdict, made at the old price');
    assert.equal(lineOf(d.state, 'streamline video').verdict, 'cut', name + ': in the Book too');
  }
  assert.equal(Object.keys(storedFlows(a.state).lines).length, 2, 'both keys reach the one line');
  // a later verdict goes to the key holding the verdict, and its Undo puts the cut back, on both devices
  on(b, 'verdict', 'review', NOW + 6 * MIN);
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(lineOf(d.state, 'streamline video').verdict, 'review');
  b.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(lineOf(d.state, 'streamline video').verdict, 'cut');
  await assertQuiet([a, b], repo, 'two keys');
});

test('fixes 2: a verdict or "not a bill" no decision gives a line any more is released, as a removal would', () => {
  const state = cards(defaultState(at(2026, 1, 1)));
  charges(state, 'STREAMLINE VIDEO 800-555', 1599, monthly('2026-06-14', 6, 14));
  refresh(state, NOW);
  seedFlows(state, NOW);
  const line = lineOf(state, 'streamline video');
  decideLine(state, line, 'verdict', 'cut', NOW);
  decideLine(state, line, 'active', false, NOW + MIN);
  assert.deepEqual([line.verdict, line.active], ['cut', false]);
  // the copy no longer holds either decision (another device's copy, say, from before them): the line is released
  state.share.flows = {};
  applyFlows(state, NOW + 2 * MIN);
  assert.equal(line.verdict, null);
  assert.equal(line.active, true, 'detection\'s own reading: it is charged');
  assert.equal((line.locks || []).includes('active'), false);
});

test('fixes 2: a decision waits on a device that holds the other series of the payee, within 35% but billed days apart (9.99 on the 4th, 12.99 on the 10th)', async () => {
  const aState = cards(defaultState(at(2026, 1, 1)));
  charges(aState, 'NIMBUS APPS 800-555', 999, monthly('2026-06-04', 6, 4), 'acc_card2');
  charges(aState, 'NIMBUS APPS 800-555', 1299, monthly('2026-06-10', 6, 10));
  refresh(aState, NOW);
  // B holds only the 12.99 series (the other is on a card B does not see)
  const bState = cards(defaultState(at(2026, 1, 1)));
  charges(bState, 'NIMBUS APPS 800-555', 1299, monthly('2026-06-10', 6, 10));
  refresh(bState, NOW);
  const a = deviceOf(aState, () => NOW + 10 * MIN);
  const b = deviceOf(bState, () => NOW + 11 * MIN);
  const repo = memory();
  const line = (d, cents) => d.state.recurring.find((rec) => rec.mkey === 'nimbus apps' && rec.amount === cents);
  a.update((s) => { decideLine(s, line(a, 999), 'verdict', 'cut', NOW); }, { undo: 'cut' });
  await settle([a, b], repo);
  assert.equal(line(b, 1299).verdict, null, 'the cut of the other series never reaches B\'s line');
  assert.equal(decisionsFor(storedFlows(b.state), b.state.recurring, lineHistory(b.state)).waiting.length, 1, 'it waits');
  b.update((s) => { decideLine(s, line(b, 1299), 'verdict', 'keep', NOW + MIN); }, { undo: 'keep' });
  await settle([a, b], repo);
  assert.deepEqual([line(a, 999).verdict, line(a, 1299).verdict], ['cut', 'keep'], 'each series keeps its own on A');
  assert.equal(line(b, 1299).verdict, 'keep');
  assert.equal(Object.keys(storedFlows(a.state).lines).length, 2, 'two keys');
  await assertQuiet([a, b], repo, 'two series');
});

test('fixes 2: an Undo travels past 30 newer lines of removals, and past 20 newer removals of lines by hand: a round merges the whole copy', async () => {
  const a = deviceOf(record(), () => NOW + 10 * MIN);
  const b = deviceOf(record(), () => NOW + 11 * MIN);
  const repo = memory();
  a.update((s) => { decideLine(s, lineOf(s, 'streamline video'), 'sub', true, NOW); }, { undo: 'add' });
  a.update((s) => {
    const line = makeRecurring({ name: 'Harbor Gym', mkey: merchantOf({ description: 'Harbor Gym' }).mkey, amount: 4500, cadence: 'monthly', anchor: '2026-12-05', source: 'manual', category: 'health', since: '2026-11-16', locks: ['name', 'category', 'purpose'] });
    s.recurring.push(line);
    noteAdded(s, line, NOW + 1000);
    refresh(s, NOW);
  }, { undo: 'added' });
  await settle([a, b], repo);
  assert.equal(shown(b.state, 'streamline video', 'sub'), true);
  assert.ok(b.state.recurring.some((rec) => rec.name === 'Harbor Gym'));
  a.undo();
  a.undo();
  // before B rounds again, A makes 30 newer lines whose every cell is a removal (suggestions dismissed and restored)
  // and 20 newer removals of lines added by hand
  a.update((s) => {
    const lines = {};
    const added = {};
    for (let k = 1; k <= FLOWS_CAPS.linesGone; k++) lines['l' + HEX(k)] = { p: 'p' + HEX(k), cad: 'monthly', amt: 1000 + k, dom: 5, sub: gone(NOW + 100 + k) };
    for (let k = 1; k <= FLOWS_CAPS.addedGone; k++) added['a' + HEX(k)] = gone(NOW + 200 + k);
    s.share.flows = joinFlows(s.share.flows, { lines, added });
  });
  await settle([a, b], repo);
  for (const [name, d] of [['A', a], ['B', b]]) {
    assert.equal(shown(d.state, 'streamline video', 'sub'), null, name + ': the Undo of Add reached it');
    assert.equal(d.state.recurring.some((rec) => rec.name === 'Harbor Gym'), false, name + ': the Undo of the line by hand too');
  }
  // the file is back within its pools once B has the removals
  const file = readSharedFile(repo.text);
  const goneLines = Object.values(file.flows.lines).filter((line) => !['sub', 'verdict', 'active'].some((f) => line[f] && !line[f].deleted)).length;
  assert.ok(goneLines <= FLOWS_CAPS.linesGone, goneLines + ' lines of removals');
  assert.ok(Object.values(file.flows.added || {}).filter((one) => one.deleted).length <= FLOWS_CAPS.addedGone);
  await assertQuiet([a, b], repo, '30 newer removals');
  // the round restamped the Undo's removal among the newest of its pool (fixes 3), so the caps alone keep it now; the
  // bound keeps a removal past its cap while the file just read holds that entry live
  const merged = storedFlows(a.state);
  const key = Object.keys(merged.lines).find((k) => merged.lines[k].amt === 1599 && merged.lines[k].sub);
  assert.ok(key && merged.lines[key].sub.deleted && merged.lines[key].sub.at > NOW + 100 + FLOWS_CAPS.linesGone, 'the Undo\'s removal, restamped');
  assert.ok(Object.hasOwn(pruneFlows(merged).lines, key), 'within its cap now');
  const old = { ...merged.lines, [key]: { ...merged.lines[key], sub: gone(NOW + 1, true) } };
  assert.equal(Object.hasOwn(pruneFlows({ lines: old }).lines, key), false, 'past the cap, it goes');
  assert.ok(Object.hasOwn(pruneFlows({ lines: old }, { lines: { [key]: { ...merged.lines[key], sub: cell(true, NOW) } } }).lines, key), 'answering a live copy, it stays');
});

test('fixes 2: an introductory price that ends keeps a confirmed subscription on its own line, listed at the new price, on two devices; no second line is made', async () => {
  const aState = cards(defaultState(at(2026, 1, 1)));
  quill(aState, ['2026-07-20', '2026-08-19'], 999);
  refresh(aState, at(2026, 8, 25));
  seedFlows(aState, at(2026, 8, 25));
  const bState = clone(aState);
  for (const rec of bState.recurring) rec.id = rec.id + 'b';
  for (const tx of bState.txs) if (tx.recurringId) tx.recurringId += 'b';
  const item = repertoire(aState, at(2026, 8, 25)).possible.find((one) => one.mkey === 'quillpad app');
  assert.ok(item, 'suggested');
  const a = deviceOf(aState, () => at(2026, 8, 25, 13));
  const b = deviceOf(bState, () => at(2026, 8, 25, 14));
  const repo = memory();
  a.update((s) => { decideLine(s, item.kind === 'line' ? s.recurring.find((rec) => rec.id === item.id) : item.line, 'sub', true, at(2026, 8, 25, 12)); }, { undo: 'add' });
  await settle([a, b], repo);
  for (const [day, now] of [['2026-09-18', at(2026, 9, 25)], ['2026-10-18', at(2026, 10, 25)], ['2026-11-17', at(2026, 11, 18)]]) {
    for (const d of [a, b]) { quill(d.state, [day], 1399); refresh(d.state, now); }
  }
  for (const [name, d] of [['A', a], ['B', b]]) {
    const subs = repertoire(d.state, at(2026, 11, 18));
    assert.deepEqual(subs.list.filter((one) => one.mkey === 'quillpad app').map((one) => [one.amount, one.est]), [[1399, false]], name + ': on the list at the bank\'s new price');
    assert.deepEqual(subs.possible.filter((one) => one.mkey === 'quillpad app'), [], name + ': not under Possible');
    assert.equal(d.state.recurring.filter((rec) => rec.mkey === 'quillpad app').length, 1, name + ': one line, none made');
    assert.equal(subs.perMonth >= 1399, true, name);
  }
});

test('fixes 2: a cut at an introductory price still names the charges once the price rises past 35%', () => {
  const state = cards(defaultState(at(2026, 1, 1)));
  quill(state, ['2026-06-20', '2026-07-20', '2026-08-19'], 999);
  refresh(state, at(2026, 8, 25));
  seedFlows(state, at(2026, 8, 25));
  decideLine(state, lineOf(state, 'quillpad app'), 'verdict', 'cut', at(2026, 8, 25));
  quill(state, ['2026-09-18'], 999);
  refresh(state, at(2026, 9, 25));
  assert.deepEqual(leaks(state, at(2026, 9, 25), 30).still.map((one) => one.day), ['2026-09-18']);
  quill(state, ['2026-10-18', '2026-11-17'], 1399);
  refresh(state, at(2026, 11, 18));
  assert.equal(lineOf(state, 'quillpad app').amount, 1399);
  assert.deepEqual(leaks(state, at(2026, 11, 18), 30).still.map((one) => [one.day, one.cents]), [['2026-11-17', 1399]], 'rule 6 names the latest charge');
});

test('fixes 2: after a card change and a rise on the new card, the cut stays on the charging line, and rule 6 names the risen charge here and on a fresh device', () => {
  const state = cards(defaultState(at(2026, 1, 1)));
  charges(state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-03-14', '2026-04-14', '2026-05-14', '2026-06-14'], 'acc_card');
  charges(state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-07-14', '2026-08-14'], 'acc_card2');
  refresh(state, at(2026, 8, 20));
  seedFlows(state, at(2026, 8, 20));
  const line = (s, account) => s.recurring.find((rec) => rec.mkey === 'streamline video' && rec.accountId === account);
  decideLine(state, line(state, 'acc_card2'), 'verdict', 'cut', at(2026, 8, 20));
  charges(state, 'STREAMLINE VIDEO 800-555', 1599, ['2026-09-14', '2026-10-14'], 'acc_card2');
  charges(state, 'STREAMLINE VIDEO 800-555', 1799, ['2026-11-14'], 'acc_card2');
  refresh(state, NOW);
  assert.equal(line(state, 'acc_card').active, false, 'the old card\'s line, ended, is held');
  assert.deepEqual([line(state, 'acc_card').verdict || null, line(state, 'acc_card2').verdict], [null, 'cut'], 'the cut stays on the charging line');
  assert.deepEqual(leaks(state, NOW, 30).still.map((one) => [one.cut, one.day]), [['2026-08-20', '2026-11-14']]);
  const fresh = cards(defaultState(at(2026, 1, 1)));
  charges(fresh, 'STREAMLINE VIDEO 800-555', 1599, ['2026-07-14', '2026-08-14', '2026-09-14', '2026-10-14'], 'acc_card2');
  charges(fresh, 'STREAMLINE VIDEO 800-555', 1799, ['2026-11-14'], 'acc_card2');
  refresh(fresh, NOW);
  seedFlows(fresh, NOW);
  takeFlowsInto(fresh, clone(state.share.flows), NOW + MIN);
  assert.deepEqual(leaks(fresh, NOW, 30).still.map((one) => [one.cut, one.day]), [['2026-08-20', '2026-11-14']], 'the same on a fresh device');
  // a Keep on the charging line replaces the cut there, and the ended line still has none
  decideLine(state, line(state, 'acc_card2'), 'verdict', 'keep', NOW + MIN);
  assert.deepEqual([line(state, 'acc_card').verdict || null, line(state, 'acc_card2').verdict], [null, 'keep']);
});

test('fixes 2: two lines of one payee, cadence, band and billing day keep a verdict each, by the Book and at the first run, on both devices', async () => {
  for (const [first, second] of [[4500, 5000], [4500, 4500]]) {
    for (const order of [0, 1]) {
      const state = cards(defaultState(at(2026, 1, 1)));
      const days = monthly('2026-06-05', 6, 5);
      charges(state, 'HARBOR GYM 22', first, days, 'acc_card');
      charges(state, 'HARBOR GYM 22', second, days, 'acc_card2');
      refresh(state, NOW);
      const ls = state.recurring.filter((rec) => rec.mkey === 'harbor gym 22');
      assert.equal(ls.length, 2);
      // the ids in either order: nothing may depend on them
      const ids = order ? ['rec_2', 'rec_1'] : ['rec_1', 'rec_2'];
      for (const [i, rec] of ls.sort((x, y) => (x.accountId < y.accountId ? -1 : 1)).entries()) {
        for (const tx of state.txs) if (tx.recurringId === rec.id) tx.recurringId = ids[i];
        rec.id = ids[i];
      }
      const pick = (account) => (s) => s.recurring.find((rec) => rec.mkey === 'harbor gym 22' && rec.accountId === account);
      assert.equal(lineFacts(pick('acc_card')(state)).key, lineFacts(pick('acc_card2')(state)).key, 'one content');
      const label = first + '/' + second + ' order ' + order;
      // by the Book: Cut on card 1, then Keep on card 2, and the other way round
      for (const cardFirst of [true, false]) {
        const both = clone(state);
        seedFlows(both, NOW);
        if (cardFirst) decideLine(both, pick('acc_card')(both), 'verdict', 'cut', NOW);
        decideLine(both, pick('acc_card2')(both), 'verdict', 'keep', NOW + MIN);
        if (!cardFirst) decideLine(both, pick('acc_card')(both), 'verdict', 'cut', NOW + 2 * MIN);
        assert.deepEqual([pick('acc_card')(both).verdict, pick('acc_card2')(both).verdict], ['cut', 'keep'], label + (cardFirst ? '' : ', Keep first'));
        assert.equal(Object.keys(storedFlows(both).lines).length, 2, label + ': two keys');
        // the bank then charges card 2 a little more, in the same band: each key keeps its own line
        charges(both, 'HARBOR GYM 22', second + 100, ['2026-12-05'], 'acc_card2');
        refresh(both, at(2026, 12, 6));
        assert.equal(pick('acc_card2')(both).amount, second + 100);
        assert.deepEqual([pick('acc_card')(both).verdict, pick('acc_card2')(both).verdict], ['cut', 'keep'], label + ': after a reprice');
      }
      const one = clone(state);
      seedFlows(one, NOW);
      decideLine(one, pick('acc_card')(one), 'verdict', 'cut', NOW);
      decideLine(one, pick('acc_card2')(one), 'verdict', 'keep', NOW + MIN);
      // and on a device with the same lines under other ids
      const other = clone(state);
      for (const rec of other.recurring) { for (const tx of other.txs) if (tx.recurringId === rec.id) tx.recurringId = rec.id + 'x'; rec.id += 'x'; }
      seedFlows(other, NOW);
      takeFlowsInto(other, clone(one.share.flows), NOW + 2 * MIN);
      assert.deepEqual([pick('acc_card')(other).verdict, pick('acc_card2')(other).verdict], ['cut', 'keep'], label + ': the other device');
      // the first run: the two verdicts were the record's before this version; both are seeded and both travel
      const seeded = clone(state);
      pick('acc_card')(seeded).verdict = 'cut';
      pick('acc_card2')(seeded).verdict = 'keep';
      seedFlows(seeded, NOW);
      assert.equal(Object.keys(storedFlows(seeded).lines).length, 2, label + ': two seeds');
      const b = clone(state);
      for (const rec of b.recurring) { for (const tx of b.txs) if (tx.recurringId === rec.id) tx.recurringId = rec.id + 'b'; rec.id += 'b'; }
      seedFlows(b, NOW);
      takeFlowsInto(b, clone(seeded.share.flows), NOW + MIN);
      assert.deepEqual([pick('acc_card')(b).verdict, pick('acc_card2')(b).verdict], ['cut', 'keep'], label + ': both seeded verdicts reach B');
      assert.deepEqual([pick('acc_card')(seeded).verdict, pick('acc_card2')(seeded).verdict], ['cut', 'keep'], label + ': and stay on A');
    }
  }
});

test('fixes 2: a line added by hand that the bank charges at another price shows the bank\'s price, as last charged, on both devices; a later edit still travels', async () => {
  const card = (state) => state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
  const aState = defaultState(at(2026, 1, 1));
  card(aState);
  charges(aState, 'HARBOR GYM 22', 4750, ['2026-08-05']);
  refresh(aState, at(2026, 8, 6));
  seedFlows(aState, at(2026, 8, 6));
  const bState = clone(aState);
  const a = deviceOf(aState, () => at(2026, 8, 6, 13));
  const b = deviceOf(bState, () => at(2026, 8, 6, 14));
  const repo = memory();
  const picked = recentMerchants(aState, at(2026, 8, 6)).find((one) => one.mkey === 'harbor gym 22');
  assert.ok(picked);
  a.update((s) => {
    const line = makeRecurring({ name: 'Harbor Gym', mkey: picked.mkey, amount: picked.amount, cadence: 'monthly', anchor: picked.day, source: 'manual', category: 'subscriptions', since: '2026-08-06', locks: ['name', 'category', 'purpose'] });
    s.recurring.push(line);
    noteAdded(s, line, at(2026, 8, 6, 12), { picked: true });
    refresh(s, at(2026, 8, 6));
  }, { undo: 'added' });
  await settle([a, b], repo);
  // the bank charges 47.50 again, then 49.90 (about 5% more) twice
  for (const [day, cents, now] of [['2026-09-05', 4750, at(2026, 9, 6)], ['2026-10-05', 4990, at(2026, 10, 6)], ['2026-11-05', 4990, NOW]]) {
    for (const d of [a, b]) { charges(d.state, 'HARBOR GYM 22', cents, [day]); refresh(d.state, now); }
  }
  for (const [name, d] of [['A', a], ['B', b]]) {
    const rec = d.state.recurring.find((one) => one.name === 'Harbor Gym');
    assert.equal(rec.amount, 4990, name + ': the bank\'s price');
    const item = repertoire(d.state, NOW).added.find((one) => one.id === rec.id);
    assert.deepEqual([item.amount, item.est, item.charged], [4990, false, true], name + ': roman, as last charged');
  }
  // the owner then edits the amount on A (the sheet locks what it changes): B takes it and holds it too
  a.clock = () => NOW + 5 * MIN;
  a.update((s) => {
    const rec = s.recurring.find((one) => one.name === 'Harbor Gym');
    rec.amount = 5200;
    rec.locks.push('amount');
    noteAdded(s, rec, NOW + 4 * MIN);
    refresh(s, NOW);
  }, { undo: 'changed' });
  await settle([a, b], repo);
  const there = b.state.recurring.find((one) => one.name === 'Harbor Gym');
  assert.equal(there.amount, 5200, 'the edit reached B');
  refresh(b.state, NOW + 10 * MIN);
  assert.equal(b.state.recurring.find((one) => one.name === 'Harbor Gym').amount, 5200, 'and holds there');
});

test('fixes 2: a line made for Add with the switch on Year takes the cadence the bank shows once detection finds the series, and does not lapse', () => {
  const state = cards(defaultState(at(2026, 1, 1)));
  quill(state, ['2026-07-20'], 1499);
  refresh(state, at(2026, 7, 25));
  seedFlows(state, at(2026, 7, 25));
  const item = repertoire(state, at(2026, 7, 25)).possible.find((one) => one.mkey === 'quillpad app');
  assert.equal(item.cadence, null, 'its cadence is asked');
  decideLine(state, item.line, 'sub', true, at(2026, 7, 25), { cad: 'annual' });
  const made = () => state.recurring.filter((rec) => rec.mkey === 'quillpad app');
  assert.deepEqual(made().map((rec) => [rec.cadence, typeof rec.madeFor]), [['annual', 'string']]);
  assert.equal(made()[0].locks.includes('cadence'), false, 'its cadence is free');
  for (const [day, now] of [['2026-08-19', at(2026, 8, 25)], ['2026-09-18', at(2026, 9, 25)], ['2026-10-18', at(2026, 10, 25)]]) {
    quill(state, [day], 1499);
    refresh(state, now);
  }
  assert.deepEqual(made().map((rec) => rec.cadence), ['monthly'], 'monthly, as the bank charges it');
  const listed = repertoire(state, at(2026, 10, 25)).list.filter((one) => one.mkey === 'quillpad app');
  assert.deepEqual(listed.map((one) => [one.cadence, one.perMonth]), [['monthly', 1499]]);
  // a line made for Add that the bank stops charging stays, as the owner confirmed it (Not one takes it off)
  const yearly = cards(defaultState(at(2026, 1, 1)));
  quill(yearly, ['2026-03-20'], 9900);
  refresh(yearly, at(2026, 3, 25));
  seedFlows(yearly, at(2026, 3, 25));
  const once = repertoire(yearly, at(2026, 3, 25)).possible.find((one) => one.mkey === 'quillpad app');
  decideLine(yearly, once.line, 'sub', true, at(2026, 3, 25), { cad: 'monthly' });
  refresh(yearly, at(2026, 11, 16));
  assert.deepEqual(yearly.recurring.filter((rec) => rec.mkey === 'quillpad app').map((rec) => rec.active), [true], 'it does not lapse');
});

test('fixes 2: the first run of lines added by hand of one content on two devices that hold different sets ends with the whole set on both', async () => {
  const added = (amount, i) => makeRecurring({ id: 'rec_h' + i, name: 'Harbor Gym', mkey: merchantOf({ description: 'Harbor Gym' }).mkey, amount, cadence: 'monthly', anchor: '2026-12-05', source: 'manual', category: 'health', since: '2026-10-01', locks: ['name', 'category', 'purpose'] });
  for (const [left, right] of [[[6000, 10000], [10000]], [[10000], [6000, 10000]], [[6000, 10000, 15000], [10000, 15000]], [[6000, 10000], [6000]]]) {
    const make = (amounts, tag) => {
      const state = record({ second: false });
      amounts.forEach((amount, i) => state.recurring.push(added(amount, tag + i)));
      return state;
    };
    const a = deviceOf(make(left, 'a'), () => NOW);
    const b = deviceOf(make(right, 'b'), () => NOW + MIN);
    seedFlows(a.state, NOW);
    seedFlows(b.state, NOW);
    const repo = memory();
    await settle([a, b], repo);
    const want = [...new Set([...left, ...right])].sort((x, y) => x - y);
    const label = JSON.stringify([left, right]);
    for (const [name, d] of [['A', a], ['B', b]]) {
      const held = d.state.recurring.filter((rec) => rec.name === 'Harbor Gym').map((rec) => rec.amount).sort((x, y) => x - y);
      assert.deepEqual(held, want, label + ' ' + name + ': every line once');
      assert.deepEqual(d.state.share.flowsNotice || [], [], label + ' ' + name + ': no line was replaced, so no notice');
    }
    await assertQuiet([a, b], repo, label);
  }
  // $45 against $60 is still one bill seeded at two prices: one entry, and the notice names the price replaced
  const a = deviceOf(record({ second: false }), () => NOW);
  const b = deviceOf(record({ second: false }), () => NOW + MIN);
  a.state.recurring.push(added(4500, 'a'));
  b.state.recurring.push(added(6000, 'b'));
  seedFlows(a.state, NOW);
  seedFlows(b.state, NOW);
  const repo = memory();
  await settle([a, b], repo);
  for (const d of [a, b]) assert.deepEqual(d.state.recurring.filter((rec) => rec.name === 'Harbor Gym').map((rec) => rec.amount), [4500]);
  assert.equal((b.state.share.flowsNotice || []).length, 1, 'B is told');
});

test('fixes 2: the guard measures what it frees as the file writes it, so an oversize file lands just under the mark', () => {
  for (const ticks of [27, 40, 48]) {
    const byHand = {};
    for (let i = 0; i < 1000; i++) {
      const marks = {};
      for (let m = 0; m < ticks; m++) marks[addDays('2026-01-01', m)] = { paid: true, at: 99999999999999 };
      byHand['t' + String(i).padStart(79, '0')] = { deleted: true, editedAt: NOW - i * 1000, marks };
    }
    const file = { v: 1, app: 'networth', savedAt: 1, byHand, flows: worstSection() };
    const before = fileText(file).length;
    assert.ok(before > GUARD_TEXT, ticks + ': over the mark');
    const after = fileText(guardShared(file)).length;
    assert.ok(after <= GUARD_TEXT && after >= GUARD_TEXT * 0.99, ticks + ' ticks: ' + before + ' -> ' + after);
  }
});

test('fixes 2: the words: Remove\'s Undo says Removed in Finance, a Keep says it was kept, the reason of a rule for one service claims nothing of its seller, and the caption says "on every device" only when sharing is on', () => {
  assert.equal(phrase('flows.undo.sub.off', 'finance'), 'Removed');
  assert.equal(phrase('flows.undo.sub.off', 'chess'), 'Taken off');
  assert.equal(phrase('flows.toast.verdict.keep', 'chess'), 'Kept: {name}.');
  assert.equal(phrase('flows.toast.verdict.keep', 'finance'), 'Marked to keep: {name}.');
  for (const words of ['chess', 'finance']) {
    assert.doesNotMatch(phrase('flows.subs.why.ruleOne', words), /one-offs|seller/);
    assert.match(phrase('flows.short.own', words), /^Your record on this device starts on \{date\}: /);
    assert.match(phrase('flows.short', words), /on every device/);
  }
  const helper = fileURLToPath(new URL('./helpers/render-flows.mjs', import.meta.url));
  for (const words of ['chess', 'finance']) {
    const alone = JSON.parse(execFileSync(process.execPath, [helper, words, 'year'], { encoding: 'utf8' }));
    assert.match(alone, /Your record on this device starts on [A-Z][a-z]{2} \d{1,2}, \d{4}: too short/, words);
    assert.doesNotMatch(alone, /on every device/);
    const shared = JSON.parse(execFileSync(process.execPath, [helper, words, 'year', 'shared'], { encoding: 'utf8' }));
    assert.match(shared, /Your record starts on [A-Z][a-z]{2} \d{1,2}, \d{4}, on every device: too short/, words);
    // Spotify's rule is one service's: its reason says what was scored; Apple's billing covers many products
    const plain = JSON.parse(execFileSync(process.execPath, [helper, words], { encoding: 'utf8' }));
    const reason = (name) => {
      const at = plain.indexOf('<span class="fl-s-name">' + name);
      assert.ok(at > 0, words + ': ' + name + ' is suggested');
      return plain.slice(plain.indexOf('fl-s-why">', at), plain.indexOf('</p>', plain.indexOf('fl-s-why">', at)));
    };
    assert.match(reason('Spotify'), /a subscription by a rule that asks you to confirm/, words);
    assert.doesNotMatch(reason('Spotify'), /one-offs/, words);
    assert.match(reason('Apple services'), /a seller that also sells one-offs/, words);
    // "+ Dismissed" is drawn by the style sheet, so it turns to "−" when the list opens
    const page = JSON.parse(execFileSync(process.execPath, [helper, words, 'dismissed'], { encoding: 'utf8' }));
    const gone = page.slice(page.indexOf('<details class="fl-s-gone"'));
    assert.match(gone, /^<details class="fl-s-gone">\s*<summary class="btn-link">Dismissed · /, words);
  }
  const css = readCss('css/views/flows.css');
  assert.match(css, /\.fl-s-gone > summary::before \{ content: "\+ "/);
  assert.match(css, /\.fl-s-gone\[open\] > summary::before \{ content: "− "; \}/);
});

test('fixes 2: keys of one content take one line each, even when one line\'s price has left the band', () => {
  const state = cards(defaultState(at(2026, 1, 1)));
  const gym = (id, accountId) => makeRecurring({ id, name: 'Harbor Gym', mkey: 'harbor gym 22', accountId, amount: 4500, cadence: 'monthly', anchor: '2026-11-05', source: 'detected', category: 'health' });
  state.recurring.push(gym('rec_1', 'acc_card'), gym('rec_2', 'acc_card2'));
  seedFlows(state, NOW);
  const [one, two] = state.recurring;
  decideLine(state, one, 'verdict', 'cut', NOW);
  decideLine(state, two, 'verdict', 'keep', NOW + MIN);
  assert.deepEqual([one.verdict, two.verdict], ['cut', 'keep']);
  // the second line's price moves to another band (no charge history holds the old one): the cut's key still has the
  // first line, and the keep's key, whose own price the first line has, takes the second
  two.amount = 5600;
  applyFlows(state, NOW + 2 * MIN);
  assert.deepEqual([one.verdict, two.verdict], ['cut', 'keep']);
  const { byLine } = decisionsFor(storedFlows(state), state.recurring, lineHistory(state));
  assert.deepEqual([byLine.get('rec_1').keys.length, byLine.get('rec_2').keys.length], [1, 1], 'one key each');
});

/* ------------------------------------------------------------------ fixes, round 3 (NOTES-2) */

/** The `sub` cell that reaches a line: 'removal', its value, or 'none'. */
function subCell(state, mkey) {
  const rec = lineOf(state, mkey);
  const one = rec && decisionsFor(storedFlows(state), state.recurring, lineHistory(state)).byLine.get(rec.id);
  return one && one.sub ? (one.sub.deleted ? 'removal' : one.sub.v) : 'none';
}

test('fixes 3: an Undo past its pool\'s cap reaches the other device whatever the order of the rounds, and the rounds then go quiet', async () => {
  for (const order of ['B A A', 'A A B']) {
    for (const pool of ['lines', 'added']) {
      const label = order + ', ' + pool;
      let t = NOW;
      const clock = () => (t += MIN);
      const a = deviceOf(record(), clock);
      const b = deviceOf(record(), clock);
      const repo = memory();
      const hand = (d, name, cents) => d.update((s) => {
        const line = makeRecurring({ name, mkey: merchantOf({ description: name }).mkey, amount: cents, cadence: 'monthly', anchor: '2026-12-05', source: 'manual', category: 'health', since: '2026-11-16', locks: ['name', 'category', 'purpose'] });
        s.recurring.push(line);
        noteAdded(s, line, d.clock());
        refresh(s, NOW);
      }, { undo: 'added' });
      if (pool === 'lines') a.update((s) => { decideLine(s, lineOf(s, 'streamline video'), 'sub', true, a.clock()); }, { undo: 'add' });
      else hand(a, 'Harbor Gym', 4500);
      await settle([a, b], repo);
      // B is away: A takes it back, then makes the pool's cap of newer removals, rounding after each change as the app does
      a.undo();
      refresh(a.state, NOW);
      await a.round(repo);
      const cap = pool === 'lines' ? FLOWS_CAPS.linesGone : FLOWS_CAPS.addedGone;
      for (let i = 0; i < cap; i++) {
        if (pool === 'lines') {
          const c = { id: 'cand_' + i, mkey: 'invented service ' + i, cadence: 'monthly', amount: 700 + 13 * i, anchor: '2026-10-05' };
          a.update((s) => { decideLine(s, c, 'sub', false, a.clock()); decideLine(s, c, 'sub', null, a.clock()); }, { undo: 'restore' });
        } else {
          hand(a, 'Invented class ' + i, 1000 + i);
          await a.round(repo);
          a.undo();
          refresh(a.state, NOW);
        }
        await a.round(repo);
      }
      const devices = order.split(' ').map((who) => (who === 'A' ? a : b));
      for (let cycle = 0; cycle < 2; cycle++) for (const d of devices) await d.round(repo);
      for (const [name, d] of [['A', a], ['B', b]]) {
        if (pool === 'lines') assert.equal(subCell(d.state, 'streamline video'), 'removal', label + ': ' + name + ' holds the Undo');
        else assert.equal(d.state.recurring.filter((rec) => rec.name === 'Harbor Gym').length, 0, label + ': ' + name + ' holds the Undo of the line by hand');
      }
      const writes = repo.writes;
      for (const d of devices) await d.round(repo);
      assert.equal(repo.writes, writes, label + ': a further cycle writes nothing');
    }
  }
  // the restamp: only a removal past its cap that the file just read holds live, 1 above the newest of its pool
  const lines = {};
  for (let k = 1; k <= FLOWS_CAPS.linesGone; k++) lines['l' + HEX(k)] = { ...facts(k), sub: gone(NOW + 100 + k) };
  lines['l' + HEX(99)] = { ...facts(99), sub: gone(NOW + 1, true) };
  const read = { lines: { ['l' + HEX(99)]: { ...facts(99), sub: cell(true, NOW) } } };
  const restamped = heldRemovals({ lines }, NOW + DAY_MS, read);
  assert.deepEqual(restamped, { lines: { ['l' + HEX(99)]: { ...facts(99), sub: { deleted: true, at: NOW + 100 + FLOWS_CAPS.linesGone + 1, undo: true } } } });
  assert.equal(heldRemovals({ lines }, NOW + DAY_MS, {}), null, 'nothing answers a live entry: nothing restamped');
  delete lines['l' + HEX(1)];
  assert.equal(heldRemovals({ lines }, NOW + DAY_MS, read), null, 'within its cap: kept as it is');
});

/** An invented gym picked from the bank's charges and added by hand on A, the rows given to each device as it fetches them. */
function gymPair(rows) {
  const make = () => {
    const state = defaultState(at(2026, 1, 1));
    state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1, basis: 'bank' }));
    return state;
  };
  const fetch = (state, upto, nowMs) => {
    for (const [day, cents] of rows) {
      if (day > upto || state.txs.some((tx) => tx.id === 'tx_g' + day)) continue;
      state.txs.push(makeTx({ id: 'tx_g' + day, accountId: 'acc_card', day, postedDay: day, amount: cents, flow: 'out', kind: 'spend', raw: 'HARBOR GYM 22', fp: 'acc_card|' + day + '|-' + cents + '|harbor', ext: { id: 'g' + day } }));
    }
    refresh(state, nowMs);
  };
  const a = deviceOf(make(), () => at(2026, 8, 6, 13));
  const b = deviceOf(make(), () => at(2026, 8, 6, 14));
  for (const d of [a, b]) { fetch(d.state, '2026-08-05', at(2026, 8, 6)); seedFlows(d.state, at(2026, 8, 6)); }
  a.update((s) => {
    const line = makeRecurring({ name: 'Harbor Gym 22', mkey: 'harbor gym 22', amount: 4750, cadence: 'monthly', anchor: '2026-08-05', category: 'subscriptions', source: 'manual', since: '2026-08-06', locks: ['name', 'category', 'purpose'] });
    s.recurring.push(line);
    noteAdded(s, line, at(2026, 8, 6), { picked: true });
    refresh(s, at(2026, 8, 6));
  }, { undo: 'added' });
  return { a, b, fetch };
}

/** The sheet's save of a line (sheet-recurring.js recurring.save): the fields set and locked, the entry noted, a verdict decided. */
function sheetSave(d, pick, fields, nowMs) {
  d.update((s) => {
    const entry = pick(s);
    const changed = Object.keys(fields);
    for (const key of changed) { entry[key] = fields[key]; if (!entry.locks.includes(key)) entry.locks.push(key); }
    if (changed.includes('name') && entry.source === 'manual' && !s.txs.some((tx) => tx.recurringId === entry.id) && !(entryOf(s, entry) || {}).p) entry.mkey = merchantOf({ description: entry.name }).mkey;
    if (entry.source === 'manual') noteAdded(s, entry, nowMs, { changed });
    if (changed.includes('verdict')) decideLine(s, entry, 'verdict', fields.verdict, nowMs);
    refresh(s, nowMs);
  }, { undo: 'changed' });
}

test('fixes 3: a charged line added by hand keeps the bank\'s price through a rename or a verdict and its Undo, and a device behind the bank keeps following it', async () => {
  const rows = [['2026-08-05', 4750], ['2026-09-05', 4750], ['2026-10-05', 4990], ['2026-11-05', 4990], ['2026-12-05', 5200], ['2027-01-05', 5200]];
  const gym = (state) => state.recurring.find((rec) => rec.source === 'manual');
  const read = (state) => [gym(state).amount, gym(state).locks.includes('amount') ? 'held' : 'free'];
  for (const edit of [{ name: 'Harbor Gym' }, { verdict: 'review' }]) {
    const { a, b, fetch } = gymPair(rows);
    const repo = memory();
    await settle([a, b], repo);
    for (const d of [a, b]) fetch(d.state, '2026-11-05', NOW);
    await settle([a, b], repo);
    assert.deepEqual([read(a.state), read(b.state)], [[4990, 'free'], [4990, 'free']], 'the bank\'s price on both');
    sheetSave(a, gym, edit, NOW + MIN);
    await settle([a, b], repo);
    assert.deepEqual([read(a.state), read(b.state)], [[4990, 'free'], [4990, 'free']], Object.keys(edit)[0] + ': still the bank\'s price');
    a.undo();
    refresh(a.state, NOW + 2 * MIN);
    await settle([a, b], repo);
    assert.deepEqual([read(a.state), read(b.state)], [[4990, 'free'], [4990, 'free']], Object.keys(edit)[0] + ' undone: still the bank\'s price');
    for (const d of [a, b]) fetch(d.state, '2027-01-05', at(2027, 1, 8));
    assert.deepEqual([read(a.state), read(b.state)], [[5200, 'free'], [5200, 'free']], 'and detection still follows the bank');
  }
  // B has not fetched the months at 49.90 when the owner renames the line on A: B keeps following the bank
  const { a, b, fetch } = gymPair(rows);
  const repo = memory();
  await settle([a, b], repo);
  fetch(a.state, '2026-11-05', NOW);
  fetch(b.state, '2026-09-05', at(2026, 10, 1));
  sheetSave(a, gym, { name: 'Harbor Gym' }, NOW + MIN);
  await settle([a, b], repo);
  assert.deepEqual([read(a.state), read(b.state)], [[4990, 'free'], [4750, 'free']], 'B is not held at A\'s reading');
  for (const d of [a, b]) fetch(d.state, '2027-01-05', at(2027, 1, 8));
  assert.deepEqual([read(a.state), read(b.state)], [[5200, 'free'], [5200, 'free']]);
  // a real price edit still travels and is held on both
  sheetSave(a, gym, { amount: 5500 }, at(2027, 1, 8, 13));
  a.clock = () => at(2027, 1, 8, 14);
  b.clock = () => at(2027, 1, 8, 15);
  await settle([a, b], repo);
  assert.deepEqual([read(a.state), read(b.state)], [[5500, 'held'], [5500, 'held']]);
});

test('fixes 3: a verdict on a line added by hand holds on two devices through a rename, a price corrected past 35% and a change of cadence', async () => {
  for (const edit of [{ name: 'LARKSPUR YOGA CO' }, { amount: 6500 }, { cadence: 'annual', amount: 45000 }]) {
    for (const path of ['sheet', 'noted']) {
      const label = JSON.stringify(edit) + ' by ' + path;
      const a = deviceOf(record({ second: false }), () => NOW + MIN);
      const b = deviceOf(record({ second: false }), () => NOW + 2 * MIN);
      const repo = memory();
      addByHand(a, { name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, anchor: '2026-11-20', category: 'health' });
      const yoga = (state) => state.recurring.find((rec) => rec.source === 'manual' && rec.category === 'health');
      a.update((s) => { decideLine(s, yoga(s), 'verdict', 'keep', NOW + 3 * MIN); refresh(s, NOW); }, { undo: 'kept' });
      await settle([a, b], repo);
      assert.deepEqual([yoga(a.state).verdict, yoga(b.state).verdict], ['keep', 'keep'], label + ': kept on both');
      if (path === 'sheet') sheetSave(a, yoga, edit, NOW + 4 * MIN);
      else {
        // a caller that notes the line with no reading of its decisions before: the entry's own facts are the line's before
        a.update((s) => {
          const entry = yoga(s);
          for (const key of Object.keys(edit)) { entry[key] = edit[key]; if (!entry.locks.includes(key)) entry.locks.push(key); }
          if (edit.name) entry.mkey = merchantOf({ description: entry.name }).mkey;
          noteAdded(s, entry, NOW + 4 * MIN);
          refresh(s, NOW + 4 * MIN);
        }, { undo: 'changed' });
      }
      assert.equal(yoga(a.state).verdict, 'keep', label + ': kept on A at once');
      await settle([a, b], repo);
      assert.deepEqual([yoga(a.state).verdict, yoga(b.state).verdict], ['keep', 'keep'], label + ': still kept on both');
      if (path === 'noted') { await assertQuiet([a, b], repo, label); continue; }
      a.undo();
      refresh(a.state, NOW + 5 * MIN);
      await settle([a, b], repo);
      assert.deepEqual([yoga(a.state).verdict, yoga(b.state).verdict], ['keep', 'keep'], label + ': kept after the Undo of the edit');
      await assertQuiet([a, b], repo, label);
    }
  }
  // B marks it to cut before it has the rename made on A: B's line follows the rename and carries B's own cut
  const a = deviceOf(record({ second: false }), () => NOW + MIN);
  const b = deviceOf(record({ second: false }), () => NOW + 2 * MIN);
  const repo = memory();
  addByHand(a, { name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, anchor: '2026-11-20', category: 'health' });
  const yoga = (state) => state.recurring.find((rec) => rec.source === 'manual' && rec.category === 'health');
  a.update((s) => { decideLine(s, yoga(s), 'verdict', 'keep', NOW + 3 * MIN); refresh(s, NOW); }, { undo: 'kept' });
  await settle([a, b], repo);
  b.update((s) => { decideLine(s, yoga(s), 'verdict', 'cut', NOW + 4 * MIN); refresh(s, NOW); }, { undo: 'cut' });
  sheetSave(a, yoga, { name: 'LARKSPUR YOGA CO' }, NOW + 5 * MIN);
  await settle([a, b], repo);
  assert.deepEqual([yoga(a.state).verdict, yoga(b.state).verdict], ['cut', 'cut'], 'the later verdict, on both');
});

test('fixes 3: two lines at one price keep their verdicts when one is repriced, staggered or for good; rule 6 names only the line cut', () => {
  for (const order of ['first', 'second']) {
    const s = cards(defaultState(at(2026, 1, 1)));
    for (const day of ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05']) { charges(s, 'HARBOR GYM', 4500, [day]); charges(s, 'HARBOR GYM', 4500, [day], 'acc_card2'); }
    refresh(s, at(2026, 11, 8));
    const gym = () => s.recurring.filter((rec) => rec.mkey === 'harbor gym').sort((x, y) => (x.accountId < y.accountId ? -1 : 1));
    if (order === 'second') {
      // the other id order: the ranks never read the local ids first
      const [one, two] = gym();
      const map = { [one.id]: 'rec_z', [two.id]: 'rec_a' };
      for (const rec of s.recurring) if (map[rec.id]) rec.id = map[rec.id];
      for (const tx of s.txs) if (tx.recurringId && map[tx.recurringId]) tx.recurringId = map[tx.recurringId];
    }
    seedFlows(s, at(2026, 11, 8));
    decideLine(s, gym()[0], 'verdict', 'keep', at(2026, 11, 8));
    decideLine(s, gym()[1], 'verdict', 'cut', at(2026, 11, 8, 13));
    const verdicts = () => gym().map((rec) => rec.verdict);
    const named = () => stillCharging(s).map((one) => (one.id === gym()[0].id ? 'card 1' : 'card 2'));
    charges(s, 'HARBOR GYM', 4700, ['2026-12-05']);
    refresh(s, at(2026, 12, 5, 20));
    assert.deepEqual([verdicts(), named()], [['keep', 'cut'], []], order + ': card 1 charged 47.00 a day before card 2');
    charges(s, 'HARBOR GYM', 4700, ['2026-12-06'], 'acc_card2');
    refresh(s, at(2026, 12, 6, 20));
    assert.deepEqual([verdicts(), named()], [['keep', 'cut'], ['card 2']], order + ': both at 47.00');
    charges(s, 'HARBOR GYM', 5200, ['2027-01-05']);
    charges(s, 'HARBOR GYM', 4700, ['2027-01-05'], 'acc_card2');
    refresh(s, at(2027, 1, 8));
    assert.deepEqual([verdicts(), named()], [['keep', 'cut'], ['card 2']], order + ': card 1 at 52.00 for good');
  }
});

test('fixes 3: a decision on a line that ended stays with it on the face, never on another series of the payee', () => {
  for (const act of [false, true]) {
    const s = cards(defaultState(at(2026, 1, 1)));
    for (const day of ['2026-05-20', '2026-06-20', '2026-07-20']) { quill(s, [day], 999); charges(s, 'QUILLPAD APP', 1199, [day], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 7, 25));
    seedFlows(s, at(2026, 7, 25));
    const seat = (cents) => s.recurring.find((rec) => rec.mkey === 'quillpad app' && Math.round(rec.amount) === cents);
    const face = (nowMs) => {
      const r = repertoire(s, nowMs);
      const of = (list) => list.filter((item) => item.mkey === 'quillpad app').map((item) => item.amount);
      return { list: of(r.list), possible: of(r.possible), dismissed: of(r.dismissed), perMonth: r.perMonth };
    };
    assert.deepEqual(face(at(2026, 7, 25)).possible, [999, 1199]);
    decideLine(s, seat(999), 'sub', act, at(2026, 7, 25));
    // the 9.99 seat is dropped and ends; the 11.99 seat goes on
    for (const day of ['2026-08-20', '2026-09-20', '2026-10-20', '2026-11-20']) { charges(s, 'QUILLPAD APP', 1199, [day], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 11, 22));
    assert.equal(seat(999).active, false, 'the 9.99 seat ended');
    assert.deepEqual(face(at(2026, 11, 22)), { list: [], possible: [1199], dismissed: [], perMonth: 0 }, (act ? 'Add' : 'Not one') + ' stays on the ended seat');
  }
});

test('fixes 3: an Undo of a price edit another device already took in puts that device back as it was too', async () => {
  const rows = [['2026-08-05', 4750], ['2026-09-05', 4750], ['2026-10-05', 4990], ['2026-11-05', 4990], ['2026-12-05', 5200]];
  const gym = (state) => state.recurring.find((rec) => rec.source === 'manual');
  const read = (state) => [gym(state).amount, gym(state).locks.includes('amount') ? 'held' : 'free'];
  for (const edits of [[5500], [5300, 5500]]) {
    const { a, b, fetch } = gymPair(rows);
    const repo = memory();
    let t = NOW;
    a.clock = () => (t += MIN);
    b.clock = () => (t += MIN);
    await settle([a, b], repo);
    for (const d of [a, b]) fetch(d.state, '2026-11-05', NOW);
    await settle([a, b], repo);
    for (const cents of edits) {
      sheetSave(a, gym, { amount: cents }, (t += MIN));
      // B opens meanwhile and takes the edit in
      await settle([a, b], repo);
      assert.deepEqual([read(a.state), read(b.state)], [[cents, 'held'], [cents, 'held']]);
    }
    a.undo();
    refresh(a.state, (t += MIN));
    await settle([a, b], repo);
    const want = edits.length === 1 ? [4990, 'free'] : [edits[0], 'held'];
    assert.deepEqual([read(a.state), read(b.state)], [want, want], edits.join(' then ') + ', then Undo');
    if (edits.length === 1) {
      for (const d of [a, b]) fetch(d.state, '2026-12-05', at(2026, 12, 8));
      assert.deepEqual([read(a.state), read(b.state)], [[5200, 'free'], [5200, 'free']], 'and both follow the bank again');
    }
    await assertQuiet([a, b], repo, edits.join(' then '));
  }
});

/* ------------------------------------------------------------------ fixes, round 5 (NOTES-2) */

const yogaOf = (state) => state.recurring.find((rec) => rec.source === 'manual' && rec.category === 'health');
const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
const verdictOf = (rec) => (rec && rec.verdict) || null;

test('fixes 5: a line added by hand keeps one key: a save that edits it and changes its verdict ends with that verdict on both devices', async () => {
  for (const edit of [{ name: 'LARKSPUR YOGA CO' }, { amount: 8000 }, { cadence: 'annual', amount: 45000 }]) {
    for (const to of ['review', 'cut', null]) {
      const label = JSON.stringify(edit) + ' and ' + to;
      const a = deviceOf(record({ second: false }), () => NOW + MIN);
      const b = deviceOf(record({ second: false }), () => NOW + 2 * MIN);
      const repo = memory();
      addByHand(a, { name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, anchor: '2026-11-20', category: 'health' });
      a.update((s) => { decideLine(s, yogaOf(s), 'verdict', 'keep', NOW + 3 * MIN); refresh(s, NOW); }, { undo: 'kept' });
      await settle([a, b], repo);
      const key = addedLineKey(yogaOf(a.state).added);
      assert.equal(storedFlows(a.state).lines[key].verdict.v, 'keep', label + ': the verdict is under the line\'s own key');
      // one save, as the sheet makes it: the edit and the verdict together
      sheetSave(a, yogaOf, { ...edit, verdict: to }, NOW + 4 * MIN);
      assert.equal(verdictOf(yogaOf(a.state)), to, label + ': on A at once');
      await settle([a, b], repo);
      assert.deepEqual([verdictOf(yogaOf(a.state)), verdictOf(yogaOf(b.state))], [to, to], label + ': on both');
      for (const d of [a, b]) {
        const one = decisionsFor(storedFlows(d.state), d.state.recurring, lineHistory(d.state)).byLine.get(yogaOf(d.state).id);
        assert.deepEqual(one.keys, [key], label + ': one key reaches the line, its own');
      }
      if (to === 'cut') {
        // the cut keeps its day, so rule 6 names a charge after it
        const s = clone(b.state);
        charges(s, merchantOf({ description: yogaOf(s).name }).mkey.toUpperCase(), yogaOf(s).amount, ['2026-12-20']);
        refresh(s, at(2026, 12, 21));
        assert.deepEqual(stillCharging(s).map((one) => one.day), ['2026-12-20'], label + ': rule 6 names the later charge');
      }
      await assertQuiet([a, b], repo, label);
    }
  }
});

test('fixes 5: a decision made after an edit, or on the other device before it saw the edit, is never overridden by the edit', async () => {
  for (const edit of [{ name: 'LARKSPUR YOGA CO' }, { amount: 8000 }, { cadence: 'annual', amount: 45000 }]) {
    const label = JSON.stringify(edit);
    // A edits and rounds; B is away; A then cuts
    {
      const a = deviceOf(record({ second: false }), () => NOW + MIN);
      const b = deviceOf(record({ second: false }), () => NOW + 2 * MIN);
      const repo = memory();
      addByHand(a, { name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, anchor: '2026-11-20', category: 'health' });
      a.update((s) => { decideLine(s, yogaOf(s), 'verdict', 'keep', NOW + 3 * MIN); refresh(s, NOW); }, { undo: 'kept' });
      await settle([a, b], repo);
      sheetSave(a, yogaOf, edit, NOW + 4 * MIN);
      await a.round(repo);
      a.update((s) => { decideLine(s, yogaOf(s), 'verdict', 'cut', NOW + 5 * MIN); refresh(s, NOW + 5 * MIN); }, { undo: 'cut' });
      await settle([a, b], repo);
      assert.deepEqual([verdictOf(yogaOf(a.state)), verdictOf(yogaOf(b.state))], ['cut', 'cut'], label + ': the cut made after the edit');
    }
    // B reviews before it has A's edit: the later verdict on both
    {
      const a = deviceOf(record({ second: false }), () => NOW + MIN);
      const b = deviceOf(record({ second: false }), () => NOW + 2 * MIN);
      const repo = memory();
      addByHand(a, { name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, anchor: '2026-11-20', category: 'health' });
      a.update((s) => { decideLine(s, yogaOf(s), 'verdict', 'keep', NOW + 3 * MIN); refresh(s, NOW); }, { undo: 'kept' });
      await settle([a, b], repo);
      sheetSave(a, yogaOf, edit, NOW + 4 * MIN);
      b.update((s) => { decideLine(s, yogaOf(s), 'verdict', 'review', NOW + 5 * MIN); refresh(s, NOW + 5 * MIN); }, { undo: 'review' });
      await settle([a, b], repo);
      assert.deepEqual([verdictOf(yogaOf(a.state)), verdictOf(yogaOf(b.state))], ['review', 'review'], label + ': B\'s later Review');
      // and an Undo of A's edit leaves the decision alone
      a.undo();
      refresh(a.state, NOW + 6 * MIN);
      await settle([a, b], repo);
      assert.deepEqual([verdictOf(yogaOf(a.state)), verdictOf(yogaOf(b.state))], ['review', 'review'], label + ': after the Undo of the edit');
      assert.deepEqual([yogaOf(a.state).name, yogaOf(b.state).name], ['Yoga studio', 'Yoga studio'], label + ': the edit undone on both');
      await assertQuiet([a, b], repo, label);
    }
  }
});

/** Two devices with no bank row yet, and a line added by hand on A as the Book adds it (typed, not picked). */
async function yogaPair() {
  const fresh = () => {
    const s = defaultState(at(2026, 1, 1));
    s.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1000, basis: 'bank' }));
    refresh(s, NOW);
    seedFlows(s, NOW);
    return s;
  };
  // one clock for both devices, a minute a step, moved on to the day after each charge the bank brings
  let t = NOW;
  const tick = () => (t += MIN);
  const a = deviceOf(fresh(), tick);
  const b = deviceOf(fresh(), tick);
  const repo = memory();
  addByHand(a, { name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, anchor: '2026-11-20', category: 'health' });
  await settle([a, b], repo);
  // the bank prints the name the owner typed, with its own suffix: the charge links to the line by its merchant key
  const bank = (d, day) => {
    charges(d.state, 'YOGA STUDIO 800-555', 4500, [day]);
    const [y, m, dd] = day.split('-').map(Number);
    t = Math.max(t, at(y, m, dd + 1));
    refresh(d.state, tick());
  };
  const hand = (s) => s.recurring.find((rec) => rec.source === 'manual' && rec.added);
  const read = (d) => {
    const line = hand(d.state);
    const bankKey = merchantOf({ description: 'YOGA STUDIO 800-555' }).mkey;
    return {
      linked: d.state.txs.filter((tx) => tx.recurringId === line.id).length,
      lines: d.state.recurring.filter((rec) => rec.active && rec.byHand !== true && (rec === line || rec.mkey === bankKey)).length,
      verdict: verdictOf(line),
    };
  };
  return { a, b, repo, tick, bank, hand, read, now: () => t };
}

test('fixes 5: a line by hand charged on one device and renamed learns the bank\'s payee key, so the other device links its charges and the decisions land on one line', async () => {
  for (const order of ['A takes the rename first', 'A\'s bank first']) {
    const { a, b, repo, tick, bank, hand, read, now } = await yogaPair();
    bank(b, '2026-11-20');
    await b.round(repo);
    assert.equal(cellValue(own(storedFlows(b.state).added, hand(b.state).added)).p, payeeKey(hand(b.state).mkey), order + ': the entry learned the bank\'s payee key');
    sheetSave(b, hand, { name: 'Fern Pilates' }, tick());
    await b.round(repo);
    if (order.startsWith('A takes')) { await a.round(repo); bank(a, '2026-11-20'); } else { bank(a, '2026-11-20'); await a.round(repo); }
    await settle([a, b], repo);
    b.update((s) => { decideLine(s, hand(s), 'verdict', 'cut', tick()); refresh(s, now()); }, { undo: 'cut' });
    await settle([a, b], repo);
    for (const day of ['2026-12-20', '2027-01-19']) { bank(a, day); bank(b, day); await settle([a, b], repo); }
    assert.deepEqual([read(a), read(b)], [{ linked: 3, lines: 1, verdict: 'cut' }, { linked: 3, lines: 1, verdict: 'cut' }], order);
    assert.deepEqual([hand(a.state).name, hand(b.state).name], ['Fern Pilates', 'Fern Pilates'], order);
    await assertQuiet([a, b], repo, order);
  }
  // the other direction: renamed on A, which has no charge, while B has it; the cut made on A
  const { a, b, repo, tick, bank, hand, read, now } = await yogaPair();
  bank(b, '2026-11-20');
  await settle([a, b], repo);
  sheetSave(a, hand, { name: 'Fern Pilates' }, tick());
  await settle([a, b], repo);
  bank(a, '2026-11-20');
  a.update((s) => { decideLine(s, hand(s), 'verdict', 'cut', tick()); refresh(s, now()); }, { undo: 'cut' });
  await settle([a, b], repo);
  bank(a, '2026-12-20'); bank(b, '2026-12-20');
  await settle([a, b], repo);
  assert.deepEqual([read(a), read(b)], [{ linked: 2, lines: 1, verdict: 'cut' }, { linked: 2, lines: 1, verdict: 'cut' }], 'renamed on the device with no charge');
  await assertQuiet([a, b], repo, 'renamed on the device with no charge');
});

test('fixes 5: the payee key is learned into the cell as it is, so a rename made meanwhile on the other device wins; an Undo keeps the key', async () => {
  const { a, b, repo, tick, bank, hand } = await yogaPair();
  const entryAt = (d) => own(storedFlows(d.state).added, hand(d.state).added);
  const before = entryAt(b).at;
  // B's bank brings the charge: the entry learns the key without a new stamp
  bank(b, '2026-11-20');
  assert.equal(entryAt(b).at, before, 'no new stamp');
  assert.ok(entryAt(b).v.p, 'the key learned');
  // meanwhile A renames (it has not seen the key)
  sheetSave(a, hand, { name: 'Fern Pilates' }, tick());
  await settle([a, b], repo);
  assert.deepEqual([hand(a.state).name, hand(b.state).name], ['Fern Pilates', 'Fern Pilates'], 'the rename wins on both');
  assert.deepEqual([!!entryAt(a).v.p, !!entryAt(b).v.p], [true, true], 'and the key is learned into it again');
  // an Undo of the rename on A puts the name back and keeps the key
  a.undo();
  refresh(a.state, tick());
  await settle([a, b], repo);
  assert.deepEqual([hand(a.state).name, hand(b.state).name], ['Yoga studio', 'Yoga studio'], 'the rename undone on both');
  assert.deepEqual([entryAt(a).v.p, entryAt(b).v.p], [payeeKey(hand(b.state).mkey), payeeKey(hand(b.state).mkey)], 'the key kept through the Undo');
  await assertQuiet([a, b], repo, 'learned key');
});

test('fixes 5: a seed that differs from another device\'s only by the payee key one of them learned is no news', async () => {
  const make = (withCharge) => {
    const s = defaultState(at(2026, 1, 1));
    s.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1000, basis: 'bank' }));
    s.recurring.push(makeRecurring({ name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, cadence: 'monthly', anchor: '2026-10-20', category: 'health', source: 'manual', since: '2026-09-01', locks: ['name', 'category', 'purpose'] }));
    if (withCharge) charges(s, 'YOGA STUDIO 800-555', 4500, ['2026-10-20']);
    refresh(s, NOW);
    seedFlows(s, NOW);
    refresh(s, NOW);
    return s;
  };
  const a = deviceOf(make(true), () => NOW + MIN);
  const b = deviceOf(make(false), () => NOW + 2 * MIN);
  const repo = memory();
  await settle([a, b], repo);
  const entries = (d) => Object.values(storedFlows(d.state).added);
  assert.deepEqual([entries(a).length, entries(b).length, !!entries(b)[0].v.p], [1, 1, true], 'one entry, with the key, on both');
  assert.deepEqual([a.state.share.flowsNotice || [], b.state.share.flowsNotice || []], [[], []], 'nothing to say');
});

test('fixes 5: after a card change that moves the billing day, a cut follows the charging line and an Add stays on the list; two seats side by side keep theirs', () => {
  const dd = (d) => String(d).padStart(2, '0');
  for (const shift of [1, 3, 10]) {
    const s = cards(defaultState(at(2026, 1, 1)));
    for (const m of [3, 4, 5, 6]) charges(s, 'STREAMLINE VIDEO 800-555', 1599, ['2026-' + dd(m) + '-14']);
    refresh(s, at(2026, 6, 20));
    seedFlows(s, at(2026, 6, 20));
    const line = (acct) => s.recurring.find((rec) => rec.accountId === acct && rec.mkey === 'streamline video');
    decideLine(s, line('acc_card'), 'verdict', 'cut', at(2026, 6, 20));
    for (const m of [7, 8, 9, 10, 11]) charges(s, 'STREAMLINE VIDEO 800-555', 1599, ['2026-' + dd(m) + '-' + dd(14 + shift)], 'acc_card2');
    refresh(s, at(2026, 11, 26));
    assert.deepEqual([verdictOf(line('acc_card')), verdictOf(line('acc_card2'))], [null, 'cut'], '+' + shift + ' days: the cut on the charging line');
    assert.deepEqual(stillCharging(s).map((one) => [one.id === line('acc_card2').id, one.day]), [[true, '2026-11-' + dd(14 + shift)]], '+' + shift + ' days: rule 6');
  }
  for (const shift of [1, 3, 10]) {
    const s = cards(defaultState(at(2026, 1, 1)));
    quill(s, ['2026-05-20', '2026-06-20', '2026-07-20'], 999);
    refresh(s, at(2026, 7, 25));
    seedFlows(s, at(2026, 7, 25));
    decideLine(s, s.recurring.find((rec) => rec.mkey === 'quillpad app'), 'sub', true, at(2026, 7, 25));
    for (const m of [8, 9, 10, 11]) { charges(s, 'QUILLPAD APP', 999, ['2026-' + dd(m) + '-' + dd(20 + shift)], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 11, 26));
    const r = repertoire(s, at(2026, 11, 26));
    const of = (list) => list.filter((item) => item.mkey === 'quillpad app').map((item) => item.amount);
    assert.deepEqual({ list: of(r.list), possible: of(r.possible), perMonth: r.perMonth }, { list: [999], possible: [], perMonth: 999 }, 'Add, +' + shift + ' days');
  }
});

test('fixes 5: two memberships of one gym on two cards keep their verdicts through a charge posted a day late and a price that leaves its band, whatever the payee\'s name', () => {
  const NAMES = ['HARBOR GYM', 'BAYSIDE GYM', 'CEDAR GYM', 'DUNE GYM', 'ELM GYM', 'FERN GYM'];
  const scenes = [
    // [label, decisions on (card 1, card 2), December's charges [day, cents] per card]
    ['card 2 a day late', ['keep', 'cut'], [['2026-12-05', 4500], ['2026-12-06', 4500]]],
    ['card 1 a day late, card 2 alone cut', [null, 'cut'], [['2026-12-06', 4500], ['2026-12-05', 4500]]],
    ['card 2 a day late, card 2 alone cut', [null, 'cut'], [['2026-12-05', 4500], ['2026-12-06', 4500]]],
    ['card 1 to 55.00', ['keep', 'cut'], [['2026-12-05', 5500], ['2026-12-05', 4500]]],
    ['both to 55.00', ['keep', 'cut'], [['2026-12-05', 5500], ['2026-12-05', 5500]]],
    ['card 2 to 55.00', ['keep', 'cut'], [['2026-12-05', 4500], ['2026-12-05', 5500]]],
  ];
  for (const [label, want, december] of scenes) {
    for (const name of NAMES) {
      for (const order of ['first', 'second']) {
        const s = cards(defaultState(at(2026, 1, 1)));
        const mk = name.toLowerCase();
        for (const day of ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05']) { charges(s, name, 4500, [day]); charges(s, name, 4500, [day], 'acc_card2'); }
        refresh(s, at(2026, 11, 8));
        const gym = () => s.recurring.filter((rec) => rec.mkey === mk).sort((x, y) => (x.accountId < y.accountId ? -1 : 1));
        if (order === 'second') {
          const [one, two] = gym();
          const map = { [one.id]: 'rec_z', [two.id]: 'rec_a' };
          for (const rec of s.recurring) if (map[rec.id]) rec.id = map[rec.id];
          for (const tx of s.txs) if (tx.recurringId && map[tx.recurringId]) tx.recurringId = map[tx.recurringId];
        }
        seedFlows(s, at(2026, 11, 8));
        if (want[0]) decideLine(s, gym()[0], 'verdict', want[0], at(2026, 11, 8));
        decideLine(s, gym()[1], 'verdict', want[1], at(2026, 11, 8, 13));
        charges(s, name, december[0][1], [december[0][0]]);
        charges(s, name, december[1][1], [december[1][0]], 'acc_card2');
        refresh(s, at(2026, 12, 8));
        const tag = label + ', ' + name + ', ' + order;
        assert.deepEqual(gym().map(verdictOf), want, tag);
        assert.deepEqual(stillCharging(s).map((one) => (one.id === gym()[0].id ? 'card 1' : 'card 2')), ['card 2'], tag + ': rule 6 names card 2');
      }
    }
  }
});

test('fixes 5: a line added by hand under a name with no merchant key ("#") still takes its verdict, on both devices', async () => {
  const a = deviceOf(record({ second: false }), () => NOW + MIN);
  const b = deviceOf(record({ second: false }), () => NOW + 2 * MIN);
  const repo = memory();
  addByHand(a, { name: '#', mkey: merchantOf({ description: '#' }).mkey, amount: 1200, anchor: '2026-11-25', category: 'health' });
  const hash = (state) => state.recurring.find((rec) => rec.source === 'manual' && rec.name === '#');
  a.update((s) => { assert.ok(decideLine(s, hash(s), 'verdict', 'review', NOW + 3 * MIN), 'written'); refresh(s, NOW); }, { undo: 'review' });
  await settle([a, b], repo);
  assert.deepEqual([verdictOf(hash(a.state)), verdictOf(hash(b.state))], ['review', 'review']);
});

/* ------------------------------------------------------------------ fixes, round 6 */

/** Two devices that each hold one account and nothing else, as the first run leaves them. */
function blankPair(raw) {
  const make = () => {
    const state = defaultState(at(2026, 1, 1));
    state.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', ext: { id: 'ext-card-1' }, name: 'Card', balance: -1000, basis: 'bank' }));
    refresh(state, NOW);
    seedFlows(state, NOW);
    return state;
  };
  let t = NOW;
  const clock = () => t;
  const a = deviceOf(make(), clock);
  const b = deviceOf(make(), clock);
  let n = 0;
  const charge = (d, day, cents) => {
    n += 1;
    d.state.txs.push(makeTx({ id: 'tx_r6' + n, accountId: 'acc_card', day, postedDay: day, amount: cents, flow: 'out', kind: 'spend', raw, fp: 'acc_card|' + day + '|-' + cents + '|' + raw.toLowerCase() + '|' + n, ext: { id: 'ext-r6-' + n } }));
  };
  return { a, b, charge, tick: (ms = MIN) => (t += ms), set: (ms) => (t = ms), now: () => t };
}

const handOf = (state) => state.recurring.find((rec) => rec.source === 'manual' && rec.byHand !== true && rec.added);
const heldOf = (rec) => ['amount', 'cadence', 'anchor'].filter((field) => rec.locks.includes(field)).join('+') || 'free';

test('fixes 6: a price or cadence corrected before the first charge is held as the owner\'s on both devices; its Undo leaves both following the bank', async () => {
  for (const [label, fields, undo] of [
    ['45.00 to 49.99', { amount: 4999 }, false],
    ['monthly to annual 540.00', { cadence: 'annual', amount: 54000 }, false],
    ['45.00 to 49.99, then Undo', { amount: 4999 }, true],
    ['the date the 20th to the 22nd', { anchor: '2026-11-22' }, false],
  ]) {
    const pair = blankPair('IRONWOOD GYM 800-555');
    const { a, b } = pair;
    const repo = memory();
    pair.tick();
    a.update((s) => {
      const line = makeRecurring({ name: 'Ironwood Gym', mkey: merchantOf({ description: 'Ironwood Gym' }).mkey, amount: 4500, cadence: 'monthly', anchor: '2026-11-20', category: 'health', source: 'manual', since: '2026-11-16', locks: ['name', 'category', 'purpose'] });
      s.recurring.push(line);
      noteAdded(s, line, pair.now());
      refresh(s, pair.now());
    }, { undo: 'added' });
    await a.round(repo); pair.tick(); await b.round(repo);
    pair.tick();
    sheetSave(a, handOf, fields, pair.now());
    await a.round(repo); pair.tick(); await b.round(repo);
    if (undo) {
      pair.tick();
      assert.ok(a.undo(), label + ': undone');
      refresh(a.state, pair.now());
      await a.round(repo); pair.tick(); await b.round(repo);
      for (const d of [a, b]) assert.deepEqual([handOf(d.state).amount, heldOf(handOf(d.state))], [4500, 'free'], label + ': back as typed, free, before any charge');
    }
    for (const day of ['2026-11-20', '2026-12-20', '2027-01-19']) {
      pair.set(at(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)), 18));
      for (const d of [a, b]) { pair.charge(d, day, 5324); refresh(d.state, pair.now()); }
      pair.tick(); await a.round(repo); pair.tick(); await b.round(repo);
    }
    const view = (state) => { const line = handOf(state); return [line.amount, line.cadence, heldOf(line), state.txs.filter((tx) => tx.recurringId === line.id).length, line.anchor]; };
    const want = undo ? [5324, 'monthly', 'free', 3, '2027-01-19'] : fields.cadence ? [54000, 'annual', 'amount+cadence', 3, '2027-01-19']
      : fields.anchor ? [5324, 'monthly', 'anchor', 3, '2026-11-22'] : [4999, 'monthly', 'amount', 3, '2027-01-19'];
    const sorted = (v) => [v[0], v[1], v[2].split('+').sort().join('+'), v[3], v[4]];
    assert.deepEqual(sorted(view(a.state)), want, label + ': device A');
    assert.deepEqual(sorted(view(b.state)), want, label + ': device B, which took the edit in before the first charge');
    await assertQuiet([a, b], repo, label);
  }
});

test('fixes 6: a line by hand renamed while the bank\'s rows came takes them over from the line detection made, once the payee key arrives', async () => {
  const pair = blankPair('YOGA STUDIO 800-555');
  const { a, b } = pair;
  const repo = memory();
  pair.tick();
  a.update((s) => {
    const line = makeRecurring({ name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, cadence: 'monthly', anchor: '2026-11-20', category: 'health', source: 'manual', since: '2026-11-16', locks: ['name', 'category', 'purpose'] });
    s.recurring.push(line);
    noteAdded(s, line, pair.now());
    refresh(s, pair.now());
  }, { undo: 'added' });
  await a.round(repo); pair.tick(); await b.round(repo);
  // B is charged first and learns the bank's payee key; A renames its line, not charged there, twice
  pair.set(at(2026, 11, 20, 18));
  pair.charge(b, '2026-11-20', 4500);
  refresh(b.state, pair.now());
  assert.ok(entryOf(b.state, handOf(b.state)).p, 'B learned the payee key');
  pair.tick(); sheetSave(a, handOf, { name: 'Fern Pilates' }, pair.now());
  pair.tick(); sheetSave(a, handOf, { name: 'Larkspur Yoga' }, pair.now());
  // A's bank brings three charges before the key reaches it: detection makes a line of them
  for (const day of ['2026-11-20', '2026-12-20', '2027-01-19']) pair.charge(a, day, 4500);
  pair.set(at(2027, 1, 20, 9));
  refresh(a.state, pair.now());
  const bank = merchantOf({ description: 'YOGA STUDIO 800-555' }).mkey;
  assert.ok(a.state.recurring.some((rec) => rec.source === 'detected' && rec.mkey === bank), 'detection made a line of the rows on A');
  for (const day of ['2026-12-20', '2027-01-19']) pair.charge(b, day, 4500);
  refresh(b.state, pair.now());
  // B cuts it, then the rounds
  pair.tick();
  b.update((s) => { decideLine(s, handOf(s), 'verdict', 'cut', pair.now()); refresh(s, pair.now()); }, { undo: 'cut' });
  for (let k = 0; k < 3; k++) { pair.tick(); await a.round(repo); pair.tick(); await b.round(repo); }
  for (const [name, d] of [['A', a], ['B', b]]) {
    const lines = d.state.recurring.filter((rec) => rec.active !== false && rec.byHand !== true && (rec === handOf(d.state) || rec.mkey === bank));
    assert.equal(lines.length, 1, name + ': one line for the bill');
    assert.equal(lines[0], handOf(d.state), name + ': the line by hand');
    assert.equal(d.state.txs.filter((tx) => tx.recurringId === lines[0].id).length, 3, name + ': it holds the bank\'s three charges');
    assert.equal(verdictOf(lines[0]), 'cut', name + ': the cut');
  }
  assert.deepEqual(stillCharging(a.state).length, stillCharging(b.state).length, 'rule 6 the same on both');
  await assertQuiet([a, b], repo, 'taken over');

  // the same when the line is made here from its entry: A undid the add, detection made a line of A's rows, and a later
  // edit on B (charged, the entry holding the key) brought the entry back
  const two = blankPair('YOGA STUDIO 800-555');
  const repo2 = memory();
  two.tick();
  two.a.update((s) => {
    const line = makeRecurring({ name: 'Yoga studio', mkey: merchantOf({ description: 'Yoga studio' }).mkey, amount: 4500, cadence: 'monthly', anchor: '2026-11-20', category: 'health', source: 'manual', since: '2026-11-16', locks: ['name', 'category', 'purpose'] });
    s.recurring.push(line);
    noteAdded(s, line, two.now());
    refresh(s, two.now());
  }, { undo: 'added' });
  await two.a.round(repo2); two.tick(); await two.b.round(repo2);
  two.tick();
  assert.ok(two.a.undo(), 'the add undone on A');
  refresh(two.a.state, two.now());
  for (const day of ['2026-11-20', '2026-12-20', '2027-01-19']) { two.charge(two.a, day, 4500); two.charge(two.b, day, 4500); }
  two.set(at(2027, 1, 20, 9));
  refresh(two.a.state, two.now());
  refresh(two.b.state, two.now());
  assert.ok(two.a.state.recurring.some((rec) => rec.source === 'detected' && rec.mkey === bank), 'detection made a line of the rows on A');
  two.tick(); sheetSave(two.b, handOf, { name: 'Fern Pilates' }, two.now());
  for (let k = 0; k < 3; k++) { two.tick(); await two.a.round(repo2); two.tick(); await two.b.round(repo2); }
  for (const [name, d] of [['A', two.a], ['B', two.b]]) {
    const lines = d.state.recurring.filter((rec) => rec.active !== false && rec.byHand !== true && (rec === handOf(d.state) || rec.mkey === bank));
    assert.deepEqual(lines.map((rec) => [rec.source, rec.name, d.state.txs.filter((tx) => tx.recurringId === rec.id).length]), [['manual', 'Fern Pilates', 3]], name + ': one line, by hand, holding the three charges');
  }
});

test('fixes 6: an Undo of an edit that the other device took in, then was charged once on, puts its line back at the typed price, free, as on the device that undid it', async () => {
  const pair = blankPair('IRONWOOD GYM 800-555');
  const { a, b } = pair;
  const repo = memory();
  pair.tick();
  a.update((s) => {
    const line = makeRecurring({ name: 'Ironwood Gym', mkey: merchantOf({ description: 'Ironwood Gym' }).mkey, amount: 4500, cadence: 'monthly', anchor: '2026-11-20', category: 'health', source: 'manual', since: '2026-11-16', locks: ['name', 'category', 'purpose'] });
    s.recurring.push(line);
    noteAdded(s, line, pair.now());
    refresh(s, pair.now());
  }, { undo: 'added' });
  await a.round(repo); pair.tick(); await b.round(repo);
  pair.tick();
  sheetSave(a, handOf, { amount: 4700 }, pair.now());
  await a.round(repo); pair.tick(); await b.round(repo);
  assert.deepEqual([handOf(b.state).amount, heldOf(handOf(b.state))], [4700, 'amount'], 'B took the edit in, held');
  // B's bank charges the edited price once (a line by hand takes no price from one charge)
  pair.set(at(2026, 11, 20, 18));
  pair.charge(b, '2026-11-20', 4700);
  refresh(b.state, pair.now());
  pair.tick();
  assert.ok(a.undo(), 'undone');
  refresh(a.state, pair.now());
  await a.round(repo); pair.tick(); await b.round(repo);
  pair.charge(a, '2026-11-20', 4700);
  refresh(a.state, pair.now());
  for (let k = 0; k < 2; k++) { pair.tick(); await a.round(repo); pair.tick(); await b.round(repo); }
  for (const [name, d] of [['A', a], ['B', b]]) assert.deepEqual([handOf(d.state).amount, heldOf(handOf(d.state))], [4500, 'free'], name + ': back at the typed price, free');
  await assertQuiet([a, b], repo, 'undo after one charge');
});

/** Three cards, the third's bank id given; the first two's ids swapped when `card2First`. */
function threeCards(ext3, card2First) {
  const s = cards(defaultState(at(2026, 1, 1)));
  if (card2First) { s.accounts[0].ext.id = 'ext-card-9'; s.accounts[1].ext.id = 'ext-card-0'; }
  s.accounts.push(makeAccount({ id: 'acc_card3', source: 'bank', type: 'credit_card', ext: { id: ext3 }, name: 'Card 3', balance: -1, basis: 'bank' }));
  return s;
}
const dd = (d) => String(d).padStart(2, '0');
const rename = (rec, name) => { rec.name = name; if (!rec.locks.includes('name')) rec.locks.push('name'); };

test('fixes 6: after a card change, a decision follows the charging line though the owner renamed the old one or it was made for an Add', () => {
  for (const card2First of [false, true]) {
    for (const shift of [0, 1, 5]) {
      const s = threeCards('ext-card-3', card2First);
      for (const m of [3, 4, 5, 6]) charges(s, 'STREAMLINE VIDEO 800-555', 1599, ['2026-' + dd(m) + '-14']);
      refresh(s, at(2026, 6, 20));
      seedFlows(s, at(2026, 6, 20));
      const line = (acct) => s.recurring.find((rec) => rec.accountId === acct && rec.mkey === 'streamline video');
      rename(line('acc_card'), 'Streamline');
      refresh(s, at(2026, 6, 20));
      decideLine(s, line('acc_card'), 'verdict', 'cut', at(2026, 6, 20));
      for (const m of [7, 8, 9, 10, 11]) charges(s, 'STREAMLINE VIDEO 800-555', 1599, ['2026-' + dd(m) + '-' + dd(14 + shift)], 'acc_card2');
      refresh(s, at(2026, 11, 26));
      const tag = (card2First ? 'card 2 id first' : 'card 1 id first') + ', +' + shift;
      assert.deepEqual([verdictOf(line('acc_card')), verdictOf(line('acc_card2'))], [null, 'cut'], tag + ': the cut on the charging line');
      assert.deepEqual(stillCharging(s).map((one) => [one.id === line('acc_card2').id, one.day]), [[true, '2026-11-' + dd(14 + shift)]], tag + ': rule 6 names it');
    }
    for (const shift of [0, 5]) {
      // a renamed seat added, then charged on card 2
      const s = threeCards('ext-card-3', card2First);
      quill(s, ['2026-05-20', '2026-06-20', '2026-07-20'], 999);
      refresh(s, at(2026, 7, 25));
      seedFlows(s, at(2026, 7, 25));
      const seat = (acct) => s.recurring.find((rec) => rec.mkey === 'quillpad app' && rec.accountId === acct);
      rename(seat('acc_card'), 'Quillpad');
      refresh(s, at(2026, 7, 25));
      decideLine(s, seat('acc_card'), 'sub', true, at(2026, 7, 25));
      for (const m of [8, 9, 10, 11]) { charges(s, 'QUILLPAD APP', 999, ['2026-' + dd(m) + '-' + dd(20 + shift)], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
      refresh(s, at(2026, 11, 26));
      const r = repertoire(s, at(2026, 11, 26));
      const of = (list) => list.filter((item) => item.mkey === 'quillpad app').map((item) => item.amount + (item.id === seat('acc_card2').id ? ' new' : ' old'));
      assert.deepEqual({ list: of(r.list), possible: of(r.possible), perMonth: r.perMonth }, { list: ['999 new'], possible: [], perMonth: 999 }, 'renamed Add, +' + shift);
    }
  }
  for (const shift of [0, 5]) {
    // Add on an app charged once makes a line for it; card 2 is charged from then on
    const s = threeCards('ext-card-3', false);
    quill(s, ['2026-07-20'], 999);
    refresh(s, at(2026, 7, 25));
    seedFlows(s, at(2026, 7, 25));
    const cand = repertoire(s, at(2026, 7, 25)).possible.find((item) => item.mkey === 'quillpad app');
    decideLine(s, cand.line, 'sub', true, at(2026, 7, 25), { cad: 'monthly' });
    refresh(s, at(2026, 7, 25, 13));
    assert.ok(s.recurring.some((rec) => typeof rec.madeFor === 'string'), 'a line made for the Add');
    for (const m of [8, 9, 10, 11]) { charges(s, 'QUILLPAD APP', 999, ['2026-' + dd(m) + '-' + dd(20 + shift)], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 11, 26));
    const r = repertoire(s, at(2026, 11, 26));
    const of = (list) => list.filter((item) => item.mkey === 'quillpad app').map((item) => s.recurring.find((rec) => rec.id === item.id).accountId + ' ' + item.amount);
    assert.deepEqual({ list: of(r.list), possible: of(r.possible), perMonth: r.perMonth }, { list: ['acc_card2 999'], possible: [], perMonth: 999 }, 'made line, +' + shift);
    assert.deepEqual(s.recurring.filter((rec) => rec.mkey === 'quillpad app' && rec.active !== false).map((rec) => rec.accountId), ['acc_card2'], 'made line, +' + shift + ': the line made for the Add goes from the Book');
  }
});

test('fixes 6: a card change of one of two memberships keeps each decision on its seat, wherever the new card\'s bank id sorts', () => {
  for (const [mover, ext3, shift] of [['card 2', 'ext-card-0', 0], ['card 2', 'ext-card-0', 1], ['card 2', 'ext-card-0', 5], ['card 1', 'ext-card-15', 0], ['card 2', 'ext-card-15', 0]]) {
    for (const name of ['HARBOR GYM', 'ELM GYM']) {
      const s = threeCards(ext3, false);
      const mk = name.toLowerCase();
      for (const day of ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05']) { charges(s, name, 4500, [day]); charges(s, name, 4500, [day], 'acc_card2'); }
      refresh(s, at(2026, 11, 8));
      const on = (acct) => s.recurring.find((rec) => rec.mkey === mk && rec.accountId === acct);
      seedFlows(s, at(2026, 11, 8));
      const [first, second] = mover === 'card 2' ? ['cut', 'keep'] : ['keep', 'review'];
      decideLine(s, on('acc_card'), 'verdict', first, at(2026, 11, 8));
      decideLine(s, on('acc_card2'), 'verdict', second, at(2026, 11, 8, 13));
      const stays = mover === 'card 2' ? 'acc_card' : 'acc_card2';
      for (const [y, m] of [[2026, 12], [2027, 1], [2027, 2], [2027, 3]]) {
        charges(s, name, 4500, [y + '-' + dd(m) + '-05'], stays);
        charges(s, name, 4500, [y + '-' + dd(m) + '-' + dd(5 + shift)], 'acc_card3');
      }
      refresh(s, at(2027, 3, 20));
      const tag = mover + ' moves, card 3 id ' + ext3 + ', +' + shift + ', ' + name;
      const want = mover === 'card 2' ? ['cut', null, 'keep'] : [null, 'review', 'keep'];
      assert.deepEqual(['acc_card', 'acc_card2', 'acc_card3'].map((acct) => verdictOf(on(acct))), want, tag);
      const r6 = stillCharging(s).map((one) => s.recurring.find((rec) => rec.id === one.id).accountId);
      assert.deepEqual(r6, mover === 'card 2' ? ['acc_card'] : [], tag + ': rule 6');
    }
  }
  // two seats of an app: Not one on card 1's, Add on card 2's; card 2's seat moves to card 3, whose id sorts first
  for (const shift of [0, 4]) {
    const s = threeCards('ext-card-0', false);
    for (const m of [5, 6, 7]) { quill(s, ['2026-' + dd(m) + '-20'], 999); charges(s, 'QUILLPAD APP', 999, ['2026-' + dd(m) + '-20'], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 7, 25));
    seedFlows(s, at(2026, 7, 25));
    const seat = (acct) => s.recurring.find((rec) => rec.mkey === 'quillpad app' && rec.accountId === acct);
    decideLine(s, seat('acc_card'), 'sub', false, at(2026, 7, 25));
    decideLine(s, seat('acc_card2'), 'sub', true, at(2026, 7, 25, 13));
    for (const m of [8, 9, 10, 11]) { quill(s, ['2026-' + dd(m) + '-20'], 999); charges(s, 'QUILLPAD APP', 999, ['2026-' + dd(m) + '-' + dd(20 + shift)], 'acc_card3'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 11, 26));
    const r = repertoire(s, at(2026, 11, 26));
    const of = (list) => list.filter((item) => item.mkey === 'quillpad app').map((item) => s.recurring.find((rec) => rec.id === item.id).accountId);
    assert.deepEqual({ list: of(r.list), dismissed: of(r.dismissed), possible: of(r.possible) }, { list: ['acc_card3'], dismissed: ['acc_card'], possible: [] }, 'two seats, +' + shift);
  }
});

test('fixes 6: rivals are mutual: a band crossed on one membership and a billing day moved on the other keep both verdicts, and one Keep tap loses no cut', () => {
  for (const card2First of [false, true]) {
    for (const [label, december] of [
      ['card 1 to 55.00, card 2 4 days late', [['2026-12-05', 5500], ['2026-12-09', 4500]]],
      ['card 2 to 55.00, card 1 6 days late', [['2026-12-11', 4500], ['2026-12-05', 5500]]],
      ['card 1 to 55.00 and 6 days late', [['2026-12-11', 5500], ['2026-12-05', 4500]]],
    ]) {
      const s = cards(defaultState(at(2026, 1, 1)));
      if (card2First) { s.accounts[0].ext.id = 'ext-card-9'; s.accounts[1].ext.id = 'ext-card-0'; }
      for (const day of ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05']) { charges(s, 'HARBOR GYM', 4500, [day]); charges(s, 'HARBOR GYM', 4500, [day], 'acc_card2'); }
      refresh(s, at(2026, 11, 8));
      const gym = () => s.recurring.filter((rec) => rec.mkey === 'harbor gym').sort((x, y) => (x.accountId < y.accountId ? -1 : 1));
      seedFlows(s, at(2026, 11, 8));
      decideLine(s, gym()[0], 'verdict', 'keep', at(2026, 11, 8));
      decideLine(s, gym()[1], 'verdict', 'cut', at(2026, 11, 8, 13));
      charges(s, 'HARBOR GYM', december[0][1], [december[0][0]]);
      charges(s, 'HARBOR GYM', december[1][1], [december[1][0]], 'acc_card2');
      refresh(s, at(2026, 12, 14));
      const tag = (card2First ? 'card 2 id first, ' : 'card 1 id first, ') + label;
      assert.deepEqual(gym().map(verdictOf), ['keep', 'cut'], tag);
      assert.deepEqual(stillCharging(s).map((one) => (one.id === gym()[0].id ? 'card 1' : 'card 2')), ['card 2'], tag + ': rule 6 names card 2');
    }
    // a lasting move: card 1 at 55.00 and card 2 on the 9th from December, then a Keep tap on card 1
    const s = cards(defaultState(at(2026, 1, 1)));
    if (card2First) { s.accounts[0].ext.id = 'ext-card-9'; s.accounts[1].ext.id = 'ext-card-0'; }
    for (const day of ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05']) { charges(s, 'CEDAR GYM', 4500, [day]); charges(s, 'CEDAR GYM', 4500, [day], 'acc_card2'); }
    refresh(s, at(2026, 11, 8));
    const gym = () => s.recurring.filter((rec) => rec.mkey === 'cedar gym').sort((x, y) => (x.accountId < y.accountId ? -1 : 1));
    seedFlows(s, at(2026, 11, 8));
    decideLine(s, gym()[0], 'verdict', 'keep', at(2026, 11, 8));
    decideLine(s, gym()[1], 'verdict', 'cut', at(2026, 11, 8, 13));
    for (const [y, m] of [[2026, 12], [2027, 1], [2027, 2], [2027, 3]]) {
      charges(s, 'CEDAR GYM', 5500, [y + '-' + dd(m) + '-05']);
      charges(s, 'CEDAR GYM', 4500, [y + '-' + dd(m) + '-09'], 'acc_card2');
      refresh(s, at(y, m, 12));
      assert.deepEqual(gym().map(verdictOf), ['keep', 'cut'], (card2First ? 'card 2 id first' : 'card 1 id first') + ', lasting move, ' + y + '-' + m);
    }
    decideLine(s, gym()[0], 'verdict', 'keep', at(2027, 3, 13));
    refresh(s, at(2027, 3, 13, 13));
    assert.deepEqual(gym().map(verdictOf), ['keep', 'cut'], 'a Keep tap on card 1 loses no cut');
  }
  // two seats: card 2's at 13.99 when its intro price ends, card 1's on the 24th; card 2's bank id first
  for (const card2First of [false, true]) {
    const s = threeCards('ext-card-3', card2First);
    for (const m of [5, 6, 7]) { quill(s, ['2026-' + dd(m) + '-20'], 999); charges(s, 'QUILLPAD APP', 999, ['2026-' + dd(m) + '-20'], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 7, 25));
    seedFlows(s, at(2026, 7, 25));
    const seat = (acct) => s.recurring.find((rec) => rec.mkey === 'quillpad app' && rec.accountId === acct);
    decideLine(s, seat('acc_card'), 'sub', false, at(2026, 7, 25));
    decideLine(s, seat('acc_card2'), 'sub', true, at(2026, 7, 25, 13));
    for (const m of [8, 9, 10, 11]) { quill(s, ['2026-' + dd(m) + '-24'], 999); charges(s, 'QUILLPAD APP', 1399, ['2026-' + dd(m) + '-20'], 'acc_card2'); s.txs[s.txs.length - 1].mcc = '5734'; }
    refresh(s, at(2026, 11, 26));
    const r = repertoire(s, at(2026, 11, 26));
    const of = (list) => list.filter((item) => item.mkey === 'quillpad app').map((item) => item.amount);
    assert.deepEqual({ list: of(r.list), dismissed: of(r.dismissed), perMonth: r.perMonth }, { list: [1399], dismissed: [999], perMonth: 1399 }, (card2First ? 'card 2 id first' : 'card 1 id first') + ': the seat at 13.99 listed');
  }
});
