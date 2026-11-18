/**
 * The daily game reaches every device (ARCHITECTURE 3.9): the section `game` of the shared file, its reading, merging
 * (laws, bounds), stamping, Undo, seeding and applying, and rounds between devices that hold the same bank record
 * (the sample game, built twice), checked by what every device shows: the rounds, their results, the edge and the
 * position. Invented names only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultState } from '../js/model/schema.js';
import { addDays, gameDayStartMs } from '../js/model/dates.js';
import { buildDemoState } from '../js/model/demo.js';
import { computeHabit, refresh } from '../js/model/detect.js';
import { makeLedger, todayOf } from '../js/model/ledger.js';
import {
  GAME_AHEAD_DAYS, GAME_CAPS, GAME_NOTE_DAYS, NOTE_MAX, applyGame, arrivedGame, exportGame, isBlankGame, mergeGame, noteGame, pruneGame, readGame, restampGame,
  gameLimit, seedGame, storedGame,
} from '../js/model/game.js';
import { exportShared, fileText, mergeShared, readSharedFile, roundShared } from '../js/model/share.js';

const MIN = 60000;
const DAY_MS = 86400000;
const NOW = new Date(2026, 10, 16, 14, 30).getTime();

/* ------------------------------------------------------------------ devices */

/** A transport that holds one file in memory. */
function memory() {
  const t = { text: null, sha: null, writes: 0 };
  t.read = async () => ({ text: t.text, sha: t.sha });
  t.write = async (body) => { t.writes += 1; t.text = body; t.sha = 's' + t.writes; return {}; };
  return t;
}

/**
 * A device as the app runs it: the store's update (with its Undo copies and the `past` path), the update hook that
 * notes the owner's changes, the restore hook that restamps an Undo, and its own clock.
 */
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
      noteGame(d.state, d.clock());
    },
    undo() {
      const json = undo.pop();
      if (!json) return false;
      const before = d.state;
      d.state = JSON.parse(json);
      restampGame(before, d.state);
      noteGame(d.state, d.clock());
      return true;
    },
    round(repo) {
      return roundShared({ state: () => d.state, stale: () => false, update: (now, past) => d.update(now, { past }) }, repo, d.clock);
    },
  };
  seedGame(d.state);
  return d;
}

/** Two devices (or more) on the same bank record: the sample game, built once and copied. */
function sampleDevices(n, clocks) {
  const base = JSON.stringify(buildDemoState(NOW));
  return Array.from({ length: n }, (_, i) => deviceOf(JSON.parse(base), clocks ? clocks[i] : () => NOW + i * MIN));
}

/** What the owner sees of the game on a device: the settings, every day's record, the segments, the owner's sweeps, every round and the figures. */
function shown(state, nowMs = NOW) {
  const ledger = makeLedger(state, nowMs);
  const rounds = [];
  const from = state.meta.matchStart || addDays(ledger.today, -30);
  for (let day = addDays(from, -3); day <= addDays(ledger.today, 3); day = addDays(day, 1)) rounds.push(ledger.round(day));
  const pick = (s) => ({ workdays: s.workdays, rolloverHour: s.rolloverHour, byesPerMonth: s.byesPerMonth, smoothing: s.smoothing,
    countPending: s.countPending, principles: s.principles, insteads: s.insteads, purposes: s.purposes });
  return JSON.parse(JSON.stringify({
    settings: pick(state.settings), days: sortedKeys(state.days), matchStart: state.meta.matchStart, habits: state.habits,
    sweeps: state.sweeps.filter((s) => s.via === 'tap').sort((a, b) => (a.weekOf < b.weekOf ? -1 : 1)),
    rounds, edge: ledger.edge(), position: ledger.position(),
    // the month's crosstable and its score, this month and the one before
    months: [ledger.today.slice(0, 7), addDays(ledger.today.slice(0, 7) + '-01', -1).slice(0, 7)].map((ym) => ledger.monthTable(ym)),
  }));
}

function sortedKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

async function settle(devices, repo) {
  for (let pass = 0; pass < 2; pass++) for (const d of devices) await d.round(repo);
}

async function assertQuiet(devices, repo, label) {
  const writes = repo.writes;
  const states = devices.map((d) => JSON.stringify(d.state));
  for (const d of devices) await d.round(repo);
  assert.equal(repo.writes, writes, (label || '') + ': a further round writes nothing');
  devices.forEach((d, i) => assert.equal(JSON.stringify(d.state), states[i], (label || '') + ': and changes nothing'));
}

/* ------------------------------------------------------------------ the owner's actions, as the views write them */

function editDay(state, day, edit) {
  const record = state.days[day] || (state.days[day] = {});
  edit(record);
  if (!Object.keys(record).length) delete state.days[day];
}
const act = {
  workday: (d, weekday, on) => d.update((s) => {
    const days = new Set(s.settings.workdays);
    if (on) days.add(weekday); else days.delete(weekday);
    s.settings.workdays = [...days].sort((a, b) => a - b);
  }),
  rollover: (d, hour) => d.update((s) => { s.settings.rolloverHour = hour; }),
  toggle: (d, field, on) => d.update((s) => { s.settings[field] = on; }),
  byes: (d, n) => d.update((s) => { s.settings.byesPerMonth = n; }),
  line: (d, key, i, text) => d.update((s) => { s.settings[key] = s.settings[key].map((line, j) => (j === i ? text : line)); }),
  removeLine: (d, key, i) => d.update((s) => { s.settings[key] = s.settings[key].filter((_, j) => j !== i); }, { undo: 'line removed' }),
  purpose: (d, key, text) => d.update((s) => { s.settings.purposes[key] = text; }),
  type: (d, day, type) => d.update((s) => editDay(s, day, (r) => { r.type = type; }), { undo: 'Day type changed' }),
  bye: (d, day, on) => d.update((s) => editDay(s, day, (r) => { if (on) r.bye = true; else delete r.bye; }), { undo: 'bye' }),
  note: (d, day, note) => d.update((s) => editDay(s, day, (r) => { if (note) r.note = note; else delete r.note; }), { undo: 'Note changed' }),
  plan: (d, day, plan) => d.update((s) => {
    if (plan) { if (!s.days[day]) s.days[day] = {}; s.days[day].plan = plan; return; }
    if (!s.days[day]) return;
    delete s.days[day].plan;
    if (!Object.keys(s.days[day]).length) delete s.days[day];
  }),
  stronger: (d, today, segment) => d.update((s) => {
    s.habits.push({ from: today, ...segment });
    s.habits.sort((a, b) => (a.from < b.from ? -1 : 1));
  }, { undo: 'seat' }),
  unseat: (d, today) => d.update((s) => { s.habits = s.habits.filter((seg) => seg.from !== today); }, { undo: 'unseat' }),
  sweep: (d, weekOf, amount, day) => d.update((s) => {
    if (!s.sweeps.some((x) => x && x.weekOf === weekOf)) s.sweeps.push({ weekOf, amount, day, txId: null, via: 'tap' });
  }),
  reopen: (d, weekOf) => d.update((s) => {
    const i = s.sweeps.findIndex((x) => x && x.weekOf === weekOf && x.via === 'tap' && x.txId == null);
    if (i >= 0) s.sweeps.splice(i, 1);
  }),
};

/* ------------------------------------------------------------------ reading */

const cell = (v, at, undo) => (undo ? { v, at, undo: true } : { v, at });
const gone = (at, undo) => (undo ? { deleted: true, at, undo: true } : { deleted: true, at });

test('reading: a section of known parts and fields is read as a fresh copy; anything else refuses it', () => {
  const good = {
    settings: { workdays: cell([1, 2, 3, 4], 5), smoothing: cell(false, 6) },
    purposes: { work: cell('Clients', 7) },
    days: { '2026-11-06': { type: cell('off', 5), bye: cell(true, 5), note: cell('Line one\nline two', 6), plan: cell({ container: true, breakfast: null, stops: 1, at: 9 }, 9) } },
    start: cell({ day: '2026-10-01', seg: { work: 1800, off: 900, winWork: 900, winOff: 400, basis: 'computed', window: null, backtest: null } }, 0),
    habits: { '2026-11-02': gone(8, true) },
    sweeps: { '2026-11-09': cell({ amount: 1200, day: '2026-11-16' }, 4) },
  };
  assert.deepEqual(readGame(good), good);
  assert.deepEqual(readGame({}), {});
  const refused = [
    { other: {} }, { settings: { cover: cell(true, 1) } }, { settings: { workdays: cell([2, 1], 1) } }, { settings: { workdays: gone(1) } },
    { settings: { rolloverHour: cell(4.5, 1) } }, { settings: { principles: cell(['x'.repeat(121)], 1) } },
    { purposes: { other: cell('x', 1) } }, { purposes: { work: gone(1) } }, { purposes: { work: cell('x'.repeat(61), 1) } },
    { settings: { purposes: cell({ work: 'x' }, 1) } }, { days: { '2026-02-30': { type: cell('off', 1) } } },
    { days: { '2026-11-06': { type: cell('holiday', 1) } } }, { days: { '2026-11-06': { note: cell('x'.repeat(NOTE_MAX + 1), 1) } } },
    { days: { '2026-11-06': { note: cell('bell\u0007', 1) } } }, { days: { '2026-11-06': { note: cell('half \ud83d', 1) } } },
    { days: { '2026-11-06': { note: cell(' padded', 1) } } }, { days: { '2026-11-06': {} } }, { days: { '2026-11-06': { bye: cell(false, 1) } } },
    { days: { '2026-11-06': { type: { v: 'off', at: 1, extra: 1 } } } }, { days: { '2026-11-06': { type: { v: 'off', at: 1e15 } } } },
    { days: { '2026-11-06': { type: { v: 'off', at: 1, undo: 'yes' } } } }, { start: gone(1) },
    { habits: { '2026-11-02': cell({ work: -1, off: 1, winWork: 1, winOff: 1 }, 1) } }, { sweeps: { '2026-11-09': cell({ amount: 1.5, day: '2026-11-16' }, 1) } },
    { days: JSON.parse('{"__proto__": {"type": {"v": "off", "at": 1}}}') },
  ];
  for (const raw of refused) assert.equal(readGame(raw), null, JSON.stringify(raw));
  const many = {};
  for (let i = 0; i < 501; i++) many[addDays('2025-01-01', i)] = { type: cell('off', 1) };
  assert.equal(readGame({ days: many }), null, 'at most 500 days');
  // a file whose section is refused is refused whole; a file without it reads as before
  const file = { v: 1, app: 'networth', savedAt: 1, byHand: {} };
  assert.equal(readSharedFile(JSON.stringify({ ...file, game: { days: { x: {} } } })), null);
  assert.deepEqual(readSharedFile(JSON.stringify(file)), file);
  assert.deepEqual(readSharedFile(JSON.stringify({ ...file, game: good })).game, good);
});

/* ------------------------------------------------------------------ merging */

function random(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/** A random section with few keys and stamps, so that ties, edits against Undos and removals meet often. */
function randomSection(rnd, opts = {}) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const stamp = () => pick([0, 1, 2, 3]);
  const maybeUndo = (c) => (rnd() < 0.3 ? { ...c, undo: true } : c);
  const out = { settings: {}, days: {}, habits: {}, sweeps: {} };
  if (rnd() < 0.6) out.settings.workdays = maybeUndo(cell(pick([[1, 2, 3, 4, 5], [1, 2, 3], [0, 6]]), stamp()));
  if (rnd() < 0.4) out.settings.byesPerMonth = maybeUndo(cell(pick([0, 1, 2, 3]), stamp()));
  for (const tag of ['work', 'studio']) if (rnd() < 0.4) (out.purposes || (out.purposes = {}))[tag] = maybeUndo(cell(pick(['Day job', 'Workshop', 'Clients']), stamp()));
  const span = opts.span || 6;
  const base = opts.base || '2026-11-01';
  for (let i = 0; i < (opts.days || 4); i++) {
    const day = addDays(base, Math.floor(rnd() * span) * (opts.step || 1));
    const fields = out.days[day] || {};
    if (rnd() < 0.6) fields.type = maybeUndo(rnd() < 0.3 ? gone(stamp()) : cell(pick(['work', 'off']), stamp()));
    if (rnd() < 0.5) fields.bye = maybeUndo(rnd() < 0.4 ? gone(stamp()) : cell(true, stamp()));
    if (rnd() < 0.5) fields.note = maybeUndo(rnd() < 0.3 ? gone(stamp()) : cell(pick(['a', 'b', 'Quiet day']), stamp()));
    if (rnd() < 0.3) fields.plan = maybeUndo(cell({ container: pick([true, false, null]), breakfast: true, stops: pick([0, 1, null]), at: 5 }, stamp()));
    if (Object.keys(fields).length) out.days[day] = fields;
  }
  if (rnd() < 0.5) out.start = cell({ day: pick(['2026-10-01', '2026-10-05']), seg: { work: pick([1800, 1900]), off: 900, winWork: 900, winOff: 400, basis: 'computed', window: null, backtest: null } }, 0);
  for (let i = 0; i < 2; i++) {
    const key = addDays(base, Math.floor(rnd() * span));
    if (rnd() < 0.5) out.habits[key] = maybeUndo(rnd() < 0.3 ? gone(stamp()) : cell({ work: pick([1500, 1600]), off: 800, winWork: 700, winOff: 300, basis: 'computed', window: null, backtest: null }, stamp()));
    if (rnd() < 0.5) out.sweeps[key] = maybeUndo(rnd() < 0.3 ? gone(stamp()) : cell({ amount: pick([0, 1200]), day: key }, stamp()));
  }
  return readGame(out);
}

test('merging keeps its laws: commutative, associative and idempotent, ties, Undo marks, removals and the bounds included', () => {
  const rnd = random(20261116);
  for (let i = 0; i < 400; i++) {
    const wide = i % 2 === 0;
    const opts = wide ? { days: 40, span: 700, step: 3, base: '2025-06-01' } : {};
    const [a, b, c] = [randomSection(rnd, opts), randomSection(rnd, opts), randomSection(rnd, opts)];
    assert.deepEqual(mergeGame(a, b), mergeGame(b, a), 'commutative ' + i);
    assert.deepEqual(mergeGame(mergeGame(a, b), c), mergeGame(a, mergeGame(b, c)), 'associative ' + i);
    const ab = mergeGame(a, b);
    assert.deepEqual(mergeGame(ab, ab), ab, 'idempotent ' + i);
    assert.deepEqual(mergeGame(ab, a), ab, 'absorbs a side ' + i);
  }
});

/** A section at the caps: many days and weeks across the 400-day line, stamps from 0 (seeded) up, a far day now and then. */
function cappedSection(rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const stamp = () => (rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 40));
  const out = { days: {}, sweeps: {}, habits: {} };
  const base = addDays('2026-11-16', -Math.floor(rnd() * 30));
  for (let i = 0; i < 70; i++) {
    const day = addDays(base, -Math.floor(rnd() * 900));
    const fields = out.days[day] || {};
    if (rnd() < 0.8) fields.note = rnd() < 0.2 ? gone(stamp()) : cell(pick(['a', 'b', 'c']), stamp());
    if (rnd() < 0.6) fields.plan = cell({ container: pick([true, false]), breakfast: true, stops: 0, at: 5 }, stamp());
    if (rnd() < 0.5) fields.type = cell(pick(['work', 'off']), stamp());
    if (rnd() < 0.4) fields.bye = rnd() < 0.3 ? gone(stamp()) : cell(true, stamp());
    if (Object.keys(fields).length) out.days[day] = fields;
    if (rnd() < 0.9) out.sweeps[addDays(base, -7 * Math.floor(rnd() * 130))] = cell({ amount: pick([0, 500]), day: base }, stamp());
    if (rnd() < 0.2) out.habits[addDays(base, -Math.floor(rnd() * 400))] = cell({ work: pick([1, 2]), off: 1, winWork: 1, winOff: 1, basis: 'computed', window: null, backtest: null }, stamp());
  }
  if (rnd() < 0.3) out.days[addDays(base, 20 + Math.floor(rnd() * 400))] = { plan: gone(stamp()) };
  return readGame(out);
}

test('merging keeps its laws at the caps: ranked by stamp, a seeded line by day and a far day left out of the line', () => {
  const rnd = random(7);
  for (let i = 0; i < 300; i++) {
    const [a, b, c] = [cappedSection(rnd), cappedSection(rnd), cappedSection(rnd)];
    assert.deepEqual(mergeGame(a, b), mergeGame(b, a), 'commutative ' + i);
    assert.deepEqual(mergeGame(mergeGame(a, b), c), mergeGame(a, mergeGame(b, c)), 'associative ' + i);
    const ab = mergeGame(a, b);
    assert.deepEqual(mergeGame(ab, ab), ab, 'idempotent ' + i);
    assert.deepEqual(mergeGame(ab, a), ab, 'absorbs a side ' + i);
  }
  // the case a line by day over cells ranked by stamp would break: an old day written later fills a part's cap, and the
  // newest day, which only the third part holds, moves the line past it
  const day = (n) => addDays('2026-11-10', -n);
  const a = { days: { [day(398)]: { note: cell('written late', 100) } } };
  const b = { days: {} };
  for (let n = 0; n < GAME_CAPS.note; n++) b.days[day(n * 19)] = { note: cell('n' + n, 50) };
  const c = { days: { '2026-11-16': { note: cell('newest', 0) } } };
  assert.deepEqual(mergeGame(mergeGame(a, b), c), mergeGame(a, mergeGame(b, c)));
});

test('merging: the later stamp wins; on an equal stamp an edit beats an Undo, then the canonical order', () => {
  const day = '2026-11-06';
  const m = (p, q) => mergeGame({ days: { [day]: { note: p } } }, { days: { [day]: { note: q } } }).days[day].note;
  assert.deepEqual(m(cell('later', 9), cell('earlier', 8)), cell('later', 9));
  assert.deepEqual(m(cell('undone', 9, true), cell('edit', 9)), cell('edit', 9));
  assert.deepEqual(m(cell('edit', 9), cell('undone', 9, true)), cell('edit', 9));
  // a removal and a value on the same stamp, neither an Undo: the canonical order ("deleted" sorts before "v")
  assert.deepEqual(m(gone(9), cell('b', 9)), gone(9));
  assert.deepEqual(m(cell('b', 9), gone(9)), gone(9));
});

test('two devices that started the match apart meet on the earlier start, whatever the order', () => {
  const seg = (work) => ({ work, off: 900, winWork: 900, winOff: 400, basis: 'computed', window: null, backtest: null });
  const a = { start: cell({ day: '2026-10-05', seg: seg(1800) }, 0) };
  const b = { start: cell({ day: '2026-10-01', seg: seg(2100) }, 0) };
  assert.equal(mergeGame(a, b).start.v.day, '2026-10-01');
  assert.equal(mergeGame(b, a).start.v.day, '2026-10-01');
  const c = { start: cell({ day: '2026-10-01', seg: seg(1700) }, 0) };
  assert.deepEqual(mergeGame(b, c), mergeGame(c, b), 'the same day: the canonical order of the segment');
});

/* ------------------------------------------------------------------ bounds */

test('pruning: a seeded day more than 400 days before the newest goes, by the days alone; each field keeps up to its cap, the newest written first', () => {
  const newest = '2026-11-16';
  const days = { [newest]: { type: cell('off', 0) }, [addDays(newest, -1)]: { note: cell('the day before', 0) },
    [addDays(newest, -400)]: { type: cell('off', 0) }, [addDays(newest, -401)]: { type: cell('off', 0) } };
  const pruned = pruneGame({ days, sweeps: { [addDays(newest, -401)]: cell({ amount: 0, day: newest }, 0) } });
  assert.deepEqual(Object.keys(pruned.days), [addDays(newest, -400), addDays(newest, -1), newest]);
  assert.equal(pruned.sweeps, undefined);
  assert.deepEqual(pruneGame(pruned), pruned, 'idempotent');
  // a cell written after the seeding (stamp above 0) is bounded by its cap alone: ranked by stamp, a line by day would let
  // a part of a merge keep what the whole merge drops
  const written = pruneGame({ days: { ...days, [addDays(newest, -401)]: { type: cell('work', 5) } } });
  assert.deepEqual(Object.keys(written.days), [addDays(newest, -401), addDays(newest, -400), addDays(newest, -1), newest]);
  // the caps: the newest written first, then the newest day; the two newest keys always stay
  const many = { days: {}, sweeps: {}, habits: {} };
  for (let i = 0; i < 150; i++) {
    const day = addDays(newest, -i);
    many.days[day] = { type: cell('off', 1), bye: cell(true, 1), note: cell('n', 1), plan: cell({ container: true, breakfast: true, stops: 0, at: 1 }, 1) };
    many.sweeps[day] = cell({ amount: 100, day }, 1);
    if (i < 50) many.habits[day] = cell({ work: 1, off: 1, winWork: 1, winOff: 1, basis: 'computed', window: null, backtest: null }, 1);
  }
  const capped = pruneGame(many);
  for (const field of ['type', 'bye', 'plan', 'note']) {
    const holding = Object.keys(capped.days).filter((day) => capped.days[day][field]);
    assert.equal(holding.length, GAME_CAPS[field], field);
    assert.equal(holding.sort()[0], addDays(newest, -(GAME_CAPS[field] - 1)), field + ': on equal stamps the newest days are kept');
  }
  assert.equal(Object.keys(capped.sweeps).length, GAME_CAPS.sweeps);
  assert.equal(Object.keys(capped.habits).length, GAME_CAPS.habits);
  // a fresh edit of an older day beyond the cap is written; the oldest of the rest makes room (the newest two stay)
  const old = addDays(newest, -100);
  const edited = pruneGame({ ...many, days: { ...many.days, [old]: { ...many.days[old], note: cell('corrected', 9) } } });
  assert.equal(edited.days[old].note.v, 'corrected');
  const notes = Object.keys(edited.days).filter((day) => edited.days[day].note).sort();
  assert.equal(notes.length, GAME_CAPS.note);
  assert.ok(notes.includes(newest) && notes.includes(addDays(newest, -1)));
  assert.equal(notes.includes(addDays(newest, -(GAME_CAPS.note - 1))), false);
  assert.deepEqual(pruneGame(edited), edited, 'idempotent');
  // a newest key more than 15 days after the next is left out of the line (one clock far ahead cannot move it)
  // (kept, not pruned: whether a key is an outlier changes as keys arrive, so pruning it would break the merge laws)
  const far = pruneGame({ days: { ...days, '2027-12-31': { plan: gone(9) } } });
  assert.deepEqual(Object.keys(far.days), [addDays(newest, -400), addDays(newest, -1), newest, '2027-12-31']);
  assert.deepEqual(pruneGame(far), far, 'idempotent');
  const near = pruneGame({ days: { ...days, [addDays(newest, 15)]: { plan: gone(9) } } });
  assert.deepEqual(Object.keys(near.days), [addDays(newest, -1), newest, addDays(newest, 15)], '15 days after is no outlier: the line follows it');
});

test('the size budget: the section at its caps with the longest values fits beside the other sections at theirs', () => {
  const newest = '2026-11-16';
  const quote = '"'.repeat(NOTE_MAX);
  const big = { settings: {}, days: {}, sweeps: {}, habits: {} };
  const at = 99999999999999;
  big.settings.workdays = cell([0, 1, 2, 3, 4, 5, 6], at, true);
  big.settings.rolloverHour = cell(23, at, true);
  big.settings.byesPerMonth = cell(31, at, true);
  big.settings.smoothing = cell(false, at, true);
  big.settings.countPending = cell(false, at, true);
  big.settings.principles = cell(Array.from({ length: 12 }, () => '"'.repeat(120)), at, true);
  big.settings.insteads = cell(Array.from({ length: 12 }, () => '"'.repeat(120)), at, true);
  big.purposes = Object.fromEntries(Object.keys(defaultState(0).settings.purposes).map((tag) => [tag, cell('"'.repeat(60), at, true)]));
  const seg = { work: 999999999999, off: 999999999999, winWork: 999999999999, winOff: 999999999999, basis: 'computed',
    window: { from: '2026-01-01', to: '2026-03-01', workDays: 999999, offDays: 999999 }, backtest: { score: 999999.5, rounds: 999999 } };
  big.start = cell({ day: '2025-01-01', seg }, at, false);
  for (let i = 0; i < 300; i++) {
    const day = addDays(newest, -i);
    big.days[day] = { type: cell('work', at, true), bye: cell(true, at, true), note: cell(quote, at, true),
      plan: cell({ container: false, breakfast: false, stops: 9, at }, at, true) };
    big.sweeps[day] = cell({ amount: 1e10, day }, at, true);
    if (i < 60) big.habits[day] = cell(seg, at, true);
  }
  // the two newest days written before the rest: they stay besides the caps (the anchors of the line), the most a file holds
  for (const day of [newest, addDays(newest, -1)]) {
    for (const field of Object.keys(big.days[day])) big.days[day][field] = { ...big.days[day][field], at: at - 1 };
    big.sweeps[day] = { ...big.sweeps[day], at: at - 1 };
  }
  const section = pruneGame(big);
  assert.equal(Object.keys(section.days).filter((day) => section.days[day].note).length, GAME_CAPS.note + 2, 'measured at the caps');
  assert.equal(Object.keys(section.days).filter((day) => section.days[day].type).length, GAME_CAPS.type + 2);
  assert.equal(Object.keys(section.sweeps).length, GAME_CAPS.sweeps + 2);
  assert.equal(Object.keys(section.habits).length, GAME_CAPS.habits);
  const text = fileText({ v: 1, app: 'networth', savedAt: at, byHand: {}, game: section });
  const size = text.length - fileText({ v: 1, app: 'networth', savedAt: at, byHand: {} }).length;
  // 3.8: the other sections at their limits, names escaped, write about 1,927,000 characters; the reader takes 2,000,000
  assert.ok(size < 70000, 'the section adds ' + size + ' characters');
  assert.ok(1927000 + size < 2000000);
});

/* ------------------------------------------------------------------ stamping, seeding, Undo */

test('an edit is stamped above the stamp it replaces, so a clock behind still wins; the same value stamps nothing', () => {
  const state = defaultState(NOW);
  seedGame(state);
  state.settings.workdays = [1, 2, 3];
  assert.equal(noteGame(state, NOW), true);
  assert.deepEqual(storedGame(state).settings.workdays, cell([1, 2, 3], NOW));
  state.settings.workdays = [1, 2];
  noteGame(state, NOW - 10 * MIN);
  assert.equal(storedGame(state).settings.workdays.at, NOW + 2, 'a clock put back still stamps above');
  assert.equal(noteGame(state, NOW + MIN), false, 'nothing changed, nothing stamped');
  state.days['2026-11-20'] = { type: 'off' };
  noteGame(state, NOW + MIN);
  delete state.days['2026-11-20'];
  noteGame(state, NOW + MIN);
  assert.deepEqual(storedGame(state).days['2026-11-20'].type, gone(NOW + MIN + 2), 'taken back: a removal stamped above');
});

test('seeding: only settings that differ from the defaults, every day, segment and owner sweep, at 0; the owner\'s workdays on one device win everywhere', async () => {
  const mac = defaultState(NOW);
  mac.settings.workdays = [1, 2, 3, 4];
  mac.days['2026-11-10'] = { note: 'Long day', type: 'off' };
  mac.sweeps.push({ weekOf: '2026-11-02', amount: 1500, day: '2026-11-09', txId: null, via: 'tap' });
  mac.sweeps.push({ weekOf: '2026-10-26', amount: 900, day: '2026-11-02', txId: 'tx1', via: 'auto' });
  seedGame(mac);
  assert.deepEqual(storedGame(mac), {
    settings: { workdays: cell([1, 2, 3, 4], 0) },
    days: { '2026-11-10': { type: cell('off', 0), note: cell('Long day', 0) } },
    sweeps: { '2026-11-02': cell({ amount: 1500, day: '2026-11-09' }, 0) },
  });
  const repo = memory();
  const devices = [deviceOf(mac, () => NOW), deviceOf(defaultState(NOW), () => NOW), deviceOf(defaultState(NOW), () => NOW)];
  await settle(devices, repo);
  for (const d of devices) {
    assert.deepEqual(d.state.settings.workdays, [1, 2, 3, 4]);
    assert.deepEqual(d.state.days['2026-11-10'], { type: 'off', note: 'Long day' });
  }
  await assertQuiet(devices, repo, 'seeds');
  // two devices' different seeds for one field: the canonical order decides, the same everywhere
  const a = defaultState(NOW); a.settings.byesPerMonth = 3; seedGame(a);
  const b = defaultState(NOW); b.settings.byesPerMonth = 1; seedGame(b);
  const repo2 = memory();
  const pair = [deviceOf(a, () => NOW), deviceOf(b, () => NOW)];
  await settle(pair, repo2);
  assert.equal(pair[0].state.settings.byesPerMonth, pair[1].state.settings.byesPerMonth);
  await assertQuiet(pair, repo2, 'different seeds');
});

test('Undo across devices: back where they were; two Undos; an edit on the other device beats an Undo on an equal stamp', async () => {
  const repo = memory();
  // A's clock runs 3 minutes fast
  let t = NOW;
  const [a, b] = sampleDevices(2, [() => t + 3 * MIN, () => t]);
  await settle([a, b], repo);
  const day = addDays(makeLedger(a.state, NOW).today, 2);
  act.note(a, day, 'First');
  act.note(a, day, 'Second');
  await settle([a, b], repo);
  assert.equal(b.state.days[day].note, 'Second');
  a.undo();
  await settle([a, b], repo);
  assert.equal(b.state.days[day].note, 'First', 'one Undo');
  a.undo();
  await settle([a, b], repo);
  assert.equal(b.state.days[day], undefined, 'two Undos: no note, no empty record');
  assert.equal(a.state.days[day], undefined);
  assert.deepEqual(shown(a.state), shown(b.state));
  await assertQuiet([a, b], repo, 'after two Undos');
  // an edit made after seeing the note beats an Undo of it, even with the Undo's clock ahead
  act.note(a, day, 'Third');
  await settle([a, b], repo);
  t += MIN;
  act.note(b, day, 'Fourth');           // stamped 2 above A's edit
  a.undo();                              // stamped 1 above: below B's edit
  await settle([a, b], repo);
  assert.equal(a.state.days[day].note, 'Fourth');
  assert.equal(b.state.days[day].note, 'Fourth');
  await assertQuiet([a, b], repo, 'edit against Undo');
});

test('an edit and an Undo with the same stamp: the edit wins on every device', async () => {
  const at = NOW;
  const edit = { days: { '2026-11-20': { note: cell('Edit', at + 2) } } };
  const undo = { days: { '2026-11-20': { note: gone(at + 2, true) } } };
  assert.deepEqual(mergeGame(edit, undo), edit);
  assert.deepEqual(mergeGame(undo, edit), edit);
});

/* ------------------------------------------------------------------ every action, A to B */

test('every action on A reaches B through the file, with the same rounds, results and figures; the file goes quiet', async () => {
  const repo = memory();
  let t = NOW;
  const [a, b] = sampleDevices(2, [() => t, () => t + 30000]);
  await settle([a, b], repo);
  assert.deepEqual(shown(a.state), shown(b.state), 'the same start');
  const today = makeLedger(a.state, NOW).today;
  const steps = [
    ['workdays', () => act.workday(a, 5, false)],
    ['rollover', () => act.rollover(a, 3)],
    ['byes', () => act.byes(a, 3)],
    ['smoothing', () => act.toggle(a, 'smoothing', false)],
    ['pending', () => act.toggle(a, 'countPending', false)],
    ['principle', () => act.line(a, 'principles', 1, 'Walk past the bakery.')],
    ['instead', () => act.line(a, 'insteads', 0, 'Brought a flask')],
    ['line removed', () => act.removeLine(a, 'principles', 0)],
    ['purpose', () => act.purpose(a, 'studio', 'Workshop')],
    ['type', () => act.type(a, addDays(today, -3), 'off')],
    ['bye ahead', () => act.bye(a, addDays(today, 1), true)],
    ['bye under way', () => act.bye(a, today, true)],
    ['note', () => act.note(a, addDays(today, -1), 'Rainy, stayed in')],
    ['plan', () => act.plan(a, today, { container: true, breakfast: false, stops: 1, at: t })],
    ['plan cleared', () => act.plan(a, today, null)],
    ['stronger', () => act.stronger(a, today, computeHabit(a.state, addDays(today, -60), addDays(today, -1)))],
    ['unseat', () => act.unseat(a, today)],
    ['moved', () => act.sweep(a, addDays(today, -14), 1200, today)],
    ['skipped', () => act.sweep(a, addDays(today, -21), 0, today)],
    ['reopened', () => act.reopen(a, addDays(today, -14))],
  ];
  for (const [name, step] of steps) {
    t += MIN;
    step();
    await a.round(repo);
    await b.round(repo);
    assert.deepEqual(shown(b.state, t), shown(a.state, t), name);
    await assertQuiet([a, b], repo, name);
  }
  // and the other way: B's Undo of A's line removal is not B's to take; B undoes nothing of A's
  assert.equal(b.undo(), false);
});

test('Undo of each owner action on A reaches B (day type, exempt day, note, line removed, a segment seated and removed)', async () => {
  const repo = memory();
  let t = NOW;
  const [a, b] = sampleDevices(2, [() => t, () => t]);
  await settle([a, b], repo);
  const today = makeLedger(a.state, NOW).today;
  const before = shown(a.state);
  const steps = [
    () => act.type(a, addDays(today, -2), 'off'),
    () => act.bye(a, addDays(today, 2), true),
    () => act.note(a, addDays(today, -4), 'Busy'),
    () => act.removeLine(a, 'insteads', 1),
    () => act.stronger(a, today, computeHabit(a.state, addDays(today, -60), addDays(today, -1))),
  ];
  for (const step of steps) {
    t += MIN;
    step();
    await settle([a, b], repo);
    assert.deepEqual(shown(b.state), shown(a.state));
  }
  t += MIN;
  act.unseat(a, today);
  await settle([a, b], repo);
  assert.deepEqual(shown(b.state), shown(a.state), 'unseated');
  for (let i = 0; i < 6; i++) {
    t += MIN;
    assert.equal(a.undo(), true);
    await settle([a, b], repo);
    assert.deepEqual(shown(b.state), shown(a.state), 'Undo ' + (i + 1));
  }
  assert.deepEqual(shown(a.state), before, 'every Undo: back where they started');
  await assertQuiet([a, b], repo, 'after every Undo');
});

test('a week the owner recorded stands in place of one B detected from the bank; reopening it leaves detection to each device', async () => {
  const repo = memory();
  const [a, b] = sampleDevices(2);
  await settle([a, b], repo);
  const today = makeLedger(a.state, NOW).today;
  const weekOf = addDays(today, -28);
  b.update((s) => { s.sweeps = s.sweeps.filter((x) => x.weekOf !== weekOf); s.sweeps.push({ weekOf, amount: 900, day: today, txId: 'b-row', via: 'auto' }); });
  a.update((s) => { s.sweeps = s.sweeps.filter((x) => x.weekOf !== weekOf); });
  act.sweep(a, weekOf, 1500, today);
  await settle([a, b], repo);
  assert.deepEqual(b.state.sweeps.filter((x) => x.weekOf === weekOf), [{ weekOf, amount: 1500, day: today, txId: null, via: 'tap' }]);
  assert.equal(JSON.stringify(exportShared(a.state, NOW)).includes('b-row'), false, 'a detected sweep never travels');
  await assertQuiet([a, b], repo, 'sweeps');
});

/* ------------------------------------------------------------------ the baseline */

test('two devices that computed different first segments converge, and every past round then agrees', async () => {
  const repo = memory();
  const [a, b] = sampleDevices(2);
  // B started the match four days later, from a window that differs
  const later = addDays(b.state.meta.matchStart, 4);
  b.state.habits = [{ from: later, ...computeHabit(b.state, addDays(later, -60), addDays(later, -1)) }];
  b.state.meta.matchStart = later;
  b.state.share.game = undefined;
  delete b.state.share.game;
  seedGame(b.state);
  assert.notDeepEqual(shown(a.state).rounds, shown(b.state).rounds);
  // either order of rounds
  await b.round(repo);
  await a.round(repo);
  await b.round(repo);
  assert.equal(b.state.meta.matchStart, a.state.meta.matchStart, 'the earlier start');
  assert.deepEqual(b.state.habits, a.state.habits);
  assert.deepEqual(shown(b.state), shown(a.state), 'every round, result and figure');
  await assertQuiet([a, b], repo, 'baseline');
  // a device that has no match yet takes it from the file, and its own first reading starts none
  const c = deviceOf(defaultState(NOW), () => NOW);
  await c.round(repo);
  assert.equal(c.state.meta.matchStart, a.state.meta.matchStart);
  assert.deepEqual(c.state.habits, a.state.habits);
});

test('the match\'s start is never undone: an Undo that puts back a record from before the first reading keeps it', () => {
  const [a] = sampleDevices(1);
  const pre = JSON.parse(JSON.stringify(a.state));
  pre.meta.matchStart = null;
  pre.habits = [];
  restampGame(a.state, pre);
  assert.equal(pre.meta.matchStart, a.state.meta.matchStart);
  assert.deepEqual(pre.habits, a.state.habits);
});

/* ------------------------------------------------------------------ prune across midnight UTC */

test('two clocks either side of midnight UTC draw the same line: the day on it stays, the one past it goes, the file goes quiet', async () => {
  const midnight = Date.UTC(2026, 10, 17);
  for (const [ta, tb] of [[midnight - 2 * MIN, midnight + 4 * MIN], [midnight + 4 * MIN, midnight - 2 * MIN]]) {
    const repo = memory();
    const newest = '2026-11-16';
    // the record each device held before this version: seeded at 0, so the line by day decides
    const sa = defaultState(ta);
    sa.days[newest] = { note: 'Newest' };
    sa.days[addDays(newest, -2)] = { note: 'Two days before' };
    sa.days[addDays(newest, -400)] = { note: 'On the line' };
    const sb = defaultState(tb);
    sb.days[addDays(newest, -401)] = { note: 'Past the line' };
    const a = deviceOf(sa, () => ta);
    const b = deviceOf(sb, () => tb);
    await settle([a, b], repo);
    const file = JSON.parse(repo.text).game;
    assert.deepEqual(Object.keys(file.days), [addDays(newest, -400), addDays(newest, -2), newest]);
    assert.equal(b.state.days[addDays(newest, -400)].note, 'On the line');
    assert.equal(b.state.days[addDays(newest, -401)].note, 'Past the line', 'the device keeps its own');
    assert.equal(a.state.days[addDays(newest, -401)], undefined, 'and it reaches no other');
    await assertQuiet([a, b], repo, 'midnight');
  }
});

/* ------------------------------------------------------------------ random sequences go quiet */

test('after any sequence of actions, Undos and rounds on three devices with skewed clocks, all agree and the file goes quiet', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rnd = random(seed * 7919);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    let t = NOW;
    const repo = memory();
    const devices = sampleDevices(3, [() => t, () => t - 7 * MIN, () => t + 11 * MIN]);
    const today = makeLedger(devices[0].state, NOW).today;
    for (let step = 0; step < 14; step++) {
      t += 20000;
      const d = pick(devices);
      const day = addDays(today, Math.floor(rnd() * 9) - 6);
      const r = rnd();
      if (r < 0.12) act.type(d, day, pick(['work', 'off']));
      else if (r < 0.24) act.bye(d, day, rnd() < 0.7);
      else if (r < 0.36) act.note(d, day, pick(['', 'One', 'Two']));
      else if (r < 0.44) act.plan(d, today, rnd() < 0.5 ? null : { container: true, breakfast: rnd() < 0.5, stops: 0, at: t });
      else if (r < 0.52) act.workday(d, pick([1, 5, 6]), rnd() < 0.5);
      else if (r < 0.58) act.byes(d, pick([1, 2, 3]));
      else if (r < 0.64) act.toggle(d, pick(['smoothing', 'countPending']), rnd() < 0.5);
      else if (r < 0.7) act.sweep(d, addDays(today, -7 * (2 + Math.floor(rnd() * 3))), pick([0, 1000]), today);
      else if (r < 0.74) act.reopen(d, addDays(today, -7 * (2 + Math.floor(rnd() * 3))));
      else if (r < 0.86) d.undo();
      else await d.round(repo);
    }
    await settle(devices, repo);
    const first = shown(devices[0].state, t);
    for (const d of devices.slice(1)) assert.deepEqual(shown(d.state, t), first, 'seed ' + seed);
    await assertQuiet(devices, repo, 'seed ' + seed);
  }
});

/* ------------------------------------------------------------------ what arrives, and the section's words */

test('what arrived is only the cells that differ from the device\'s own', () => {
  const local = { days: { '2026-11-06': { note: cell('mine', 5), type: cell('off', 1) } } };
  const merged = { days: { '2026-11-06': { note: cell('mine', 5), type: cell('work', 9) } } };
  assert.deepEqual(arrivedGame(local, merged), { days: { '2026-11-06': { type: cell('work', 9) } } });
  assert.equal(isBlankGame(arrivedGame(merged, merged)), true);
});

test('a record with nothing of the game writes the file of before; the section holds nothing the bank reported', () => {
  const state = defaultState(NOW);
  seedGame(state);
  assert.equal(exportShared(state, NOW).game, undefined);
  const [a] = sampleDevices(1);
  const text = JSON.stringify(exportGame(a.state));
  for (const tx of a.state.txs.slice(0, 50)) {
    assert.equal(text.includes(tx.id), false);
    if (tx.desc) assert.equal(text.includes(tx.desc), false);
  }
  for (const account of a.state.accounts) assert.equal(text.includes(account.id), false);
});

test('a file merged with one that lacks the section keeps it; a merged file is read back the same', () => {
  const section = { days: { '2026-11-06': { type: cell('off', 5) } } };
  const file = { v: 1, app: 'networth', savedAt: 1, byHand: {}, game: section };
  const merged = mergeShared(file, { v: 1, app: 'networth', savedAt: 2, byHand: {} });
  assert.deepEqual(merged.game, section);
  assert.deepEqual(readSharedFile(fileText(merged)).game, section);
  assert.equal(applyGame(defaultState(NOW), section), true);
  assert.equal(gameDayStartMs('2026-11-06', 4) > 0, true);
  assert.equal(DAY_MS, 86400000);
});

test('more exempt days in a month than allowed, declared on two devices before they met: every one stands, on both alike', async () => {
  const repo = memory();
  const [a, b] = sampleDevices(2);
  await settle([a, b], repo);
  const today = makeLedger(a.state, NOW).today;
  act.byes(a, 2);
  await settle([a, b], repo);
  // each device declares two, within the rule as it sees it, before any round
  act.bye(a, addDays(today, 1), true);
  act.bye(a, addDays(today, 2), true);
  act.bye(b, addDays(today, 3), true);
  act.bye(b, addDays(today, 4), true);
  await settle([a, b], repo);
  const byes = (s) => Object.keys(s.days).filter((day) => s.days[day].bye).sort();
  assert.deepEqual(byes(a.state), byes(b.state));
  assert.equal(byes(a.state).filter((day) => day > today).length, 4, 'none is dropped: the rule is checked where a bye is declared');
  assert.deepEqual(shown(a.state), shown(b.state), 'the same rounds and results');
  await assertQuiet([a, b], repo, 'byes beyond the rule');
});

test('a long record: 700 day records and 300 weeks are all seeded and kept on the device; the file holds the newest up to the caps; nothing is noted again', async () => {
  const state = defaultState(NOW);
  const newest = '2026-11-16';
  for (let i = 0; i < 700; i++) state.days[addDays(newest, -i)] = { type: 'off', note: 'Day ' + i };
  for (let i = 0; i < 300; i++) state.sweeps.push({ weekOf: addDays(newest, -7 * i), amount: 100, day: addDays(newest, -7 * i + 7), txId: null, via: 'tap' });
  seedGame(state);
  const copy = storedGame(state);
  assert.equal(Object.keys(copy.days).length, 700, 'the copy keeps every day');
  assert.equal(Object.keys(copy.sweeps).length, 300);
  assert.equal(noteGame(state, NOW), false, 'the record agrees with its copy');
  const out = exportGame(state);
  assert.equal(Object.keys(out.days).length, GAME_CAPS.type);
  assert.equal(Object.keys(out.days).filter((day) => out.days[day].note).length, GAME_CAPS.note);
  assert.equal(Object.keys(out.sweeps).length, Math.min(GAME_CAPS.sweeps, 58));
  assert.ok(readSharedFile(fileText(exportShared(state, NOW))), 'and the file it writes is read back');
  const repo = memory();
  const a = deviceOf(state, () => NOW);
  const b = deviceOf(defaultState(NOW), () => NOW);
  await settle([a, b], repo);
  assert.equal(Object.keys(a.state.days).length, 700, 'a round takes nothing from the device');
  assert.equal(Object.keys(storedGame(a.state).days).length, 700);
  await assertQuiet([a, b], repo, 'long record');
});

/* ------------------------------------------------------------------ the fix round: what every device must agree on */

/** Every sweep a device holds (those detected from the bank included), in order. */
function allSweeps(state) {
  return state.sweeps.map((x) => ({ ...x })).sort((p, q) => (p.weekOf < q.weekOf ? -1 : p.weekOf > q.weekOf ? 1 : p.via < q.via ? -1 : 1));
}

test('caps keep the newest edits: a note edit beyond the note cap and a day type beyond the type cap reach every device', async () => {
  // (a) notes on the 25 days before today, held by both (seeded), then an older one corrected on A, and undone
  {
    const notes = (s) => { for (let i = 1; i <= 25; i++) editDay(s, addDays('2026-11-16', -i), (r) => { r.note = 'Walked to work ' + i; }); };
    const base = buildDemoState(NOW);
    notes(base);
    let t = NOW;
    const json = JSON.stringify(base);
    const a = deviceOf(JSON.parse(json), () => t);
    const b = deviceOf(JSON.parse(json), () => t + MIN);
    const repo = memory();
    await settle([a, b], repo);
    const day = addDays('2026-11-16', -22);
    t += 10 * MIN;
    act.note(a, day, 'Corrected: took the bus');
    await settle([a, b], repo);
    assert.equal(b.state.days[day].note, 'Corrected: took the bus');
    assert.deepEqual(shown(b.state), shown(a.state));
    await assertQuiet([a, b], repo, 'note beyond the cap');
    t += MIN;
    assert.equal(a.undo(), true);
    await settle([a, b], repo);
    assert.equal(b.state.days[day].note, 'Walked to work 22', 'the Undo reaches B too');
    await assertQuiet([a, b], repo, 'its Undo');
  }
  // (b) the match began 2026-05-04 and 160 days carry a type; the third oldest is set back to its weekday on A
  {
    const long = (s) => {
      const first = s.habits[0];
      s.meta.matchStart = '2026-05-04';
      s.habits = [{ ...JSON.parse(JSON.stringify(first)), from: '2026-05-04' }];
      let n = 0;
      for (let day = '2026-05-05'; day < '2026-11-16' && n < 160; day = addDays(day, 1)) {
        const wd = new Date(day + 'T12:00:00Z').getUTCDay();
        if (wd === 0 || wd === 6) { editDay(s, day, (r) => { r.type = 'work'; }); n++; } else if (wd !== 4) { editDay(s, day, (r) => { r.type = 'off'; }); n++; }
      }
    };
    const base = buildDemoState(NOW);
    long(base);
    let t = NOW;
    const json = JSON.stringify(base);
    const a = deviceOf(JSON.parse(json), () => t);
    const b = deviceOf(JSON.parse(json), () => t + MIN);
    const repo = memory();
    await settle([a, b], repo);
    const typed = Object.keys(a.state.days).filter((d) => a.state.days[d].type).sort();
    assert.ok(typed.length > GAME_CAPS.type);
    const day = typed[2];
    t += 10 * MIN;
    a.update((s) => editDay(s, day, (r) => { delete r.type; }), { undo: 'Day type changed' });
    await settle([a, b], repo);
    assert.equal((b.state.days[day] || {}).type, undefined);
    assert.deepEqual(shown(b.state, t), shown(a.state, t));
    await assertQuiet([a, b], repo, 'type beyond the cap');
  }
});

test('a far-future day cannot move the line: one device with its clock a year ahead plans its today, and every day still travels', async () => {
  const base = JSON.stringify(buildDemoState(NOW));
  const a = deviceOf(JSON.parse(base), () => NOW);
  const w = deviceOf(JSON.parse(base), () => NOW + 410 * DAY_MS);
  const repo = memory();
  await settle([a, w], repo);
  const daysInFile = () => Object.keys(JSON.parse(repo.text).game.days || {});
  const before = daysInFile();
  const today = todayOf(w.state, w.clock());
  assert.ok(today > gameLimit(w.state));
  act.plan(w, today, { container: true, breakfast: true, stops: 0, at: w.clock() });
  await settle([a, w], repo);
  assert.deepEqual(daysInFile(), before, 'a day past the noting limit is never noted');
  assert.equal(w.state.days[today].plan.container, true, 'it stays on that device');
  act.plan(w, today, null);
  await settle([a, w], repo);
  assert.deepEqual(daysInFile(), before);
  // a device that joins later takes every day of A's; a bye for today on A reaches B
  const c = deviceOf((() => { const s = JSON.parse(base); s.days = {}; return s; })(), () => NOW);
  const b = deviceOf(JSON.parse(base), () => NOW);
  await settle([a, w, c, b], repo);
  assert.deepEqual(Object.keys(c.state.days).sort(), Object.keys(a.state.days).sort());
  act.bye(a, '2026-11-16', true);
  await settle([a, w, c, b], repo);
  assert.equal(b.state.days['2026-11-16'].bye, true);
  assert.deepEqual(shown(b.state), shown(a.state));
  assert.deepEqual(shown(c.state), shown(a.state));
});

test('each purpose tag has its own cell: renames of different tags on two devices are both kept, at the first run and after', () => {
  // the first run of this version: before it, the Mac renamed studio and the phone coaching
  const mac = buildDemoState(NOW);
  const phone = buildDemoState(NOW);
  for (const s of [mac, phone]) if (s.share) delete s.share.game;
  mac.settings.purposes = { ...mac.settings.purposes, studio: 'Workshop' };
  phone.settings.purposes = { ...phone.settings.purposes, coaching: 'Clients' };
  seedGame(mac);
  seedGame(phone);
  assert.deepEqual(Object.keys(storedGame(mac).purposes), ['studio'], 'only the tag that differs from its default is seeded');
  const file = mergeGame(exportGame(mac), exportGame(phone));
  applyGame(mac, file);
  applyGame(phone, file);
  for (const s of [mac, phone]) {
    assert.equal(s.settings.purposes.studio, 'Workshop');
    assert.equal(s.settings.purposes.coaching, 'Clients');
  }
  // later, before they meet: the Mac renames work, the phone personal
  mac.settings.purposes = { ...mac.settings.purposes, work: 'Day job' };
  noteGame(mac, NOW + MIN);
  phone.settings.purposes = { ...phone.settings.purposes, personal: 'Home' };
  noteGame(phone, NOW + 2 * MIN);
  const later = mergeGame(exportGame(mac), exportGame(phone));
  applyGame(mac, later);
  applyGame(phone, later);
  assert.deepEqual(mac.settings.purposes, phone.settings.purposes);
  assert.deepEqual(mac.settings.purposes, { ...defaultState(0).settings.purposes, studio: 'Workshop', coaching: 'Clients', work: 'Day job', personal: 'Home' });
});

test('a list of lines is one cell: different edits of the principles on two devices before they meet keep one device\'s list, the same on both', () => {
  // a line has no identity of its own (lines move, merge and split), so the later list wins whole, by its stamp
  const mac = buildDemoState(NOW);
  const phone = buildDemoState(NOW);
  seedGame(mac);
  seedGame(phone);
  mac.settings.principles = ['Pack lunch the night before.', ...mac.settings.principles.slice(1)];
  noteGame(mac, NOW + MIN);
  phone.settings.principles = [...phone.settings.principles, 'Walk past the bakery.'];
  noteGame(phone, NOW + 2 * MIN);
  const file = mergeGame(exportGame(mac), exportGame(phone));
  applyGame(mac, file);
  applyGame(phone, file);
  assert.deepEqual(mac.settings.principles, phone.settings.principles);
  assert.equal(mac.settings.principles.at(-1), 'Walk past the bakery.', 'the phone wrote later: its list is kept');
  assert.notEqual(mac.settings.principles[0], 'Pack lunch the night before.', 'and the Mac\'s edit is not');
});

/* ------------------------------------------------------------------ the weeks detected from the bank stay with each device */

// A known limit (3.9): each device works out the weeks detected from the bank (`via: 'auto'`) from its own readings, as
// before the game travelled, and they can differ between devices; the owner's own decisions travel and override them.

/** A bank reading with nothing new: the store's update, then refresh (sync.js). */
const readBank = (d, extra) => d.update((s) => { if (extra) extra(s); refresh(s, d.clock()); });

/** The sample without its 2026-11-10 card payment (and the week detected from it), two devices on it and the reading that brings it. */
function paymentToCome() {
  const TX = 'tx_p0jfmbz5';
  const base = buildDemoState(NOW);
  const row = base.txs.find((tx) => tx.id === TX);
  assert.ok(row, 'the sample holds the payment');
  base.txs = base.txs.filter((tx) => tx.id !== TX);
  base.sweeps = base.sweeps.filter((x) => x.txId !== TX);
  const json = JSON.stringify(base);
  const clock = { t: new Date(2026, 10, 16, 9, 0).getTime() };
  const a = deviceOf(JSON.parse(json), () => clock.t);
  const b = deviceOf(JSON.parse(json), () => clock.t + 2 * MIN);
  const read = (d) => readBank(d, (s) => { if (!s.txs.some((tx) => tx.id === TX)) s.txs.push(JSON.parse(JSON.stringify(row))); });
  return { TX, a, b, clock, read, repo: memory() };
}

test('a week detected from the bank stays with the device that read it, as its reading made it: nothing taken in derives it again', async () => {
  const { TX, a, b, clock, read, repo } = paymentToCome();
  await settle([a, b], repo);
  read(a);
  const first = a.state.sweeps.find((x) => x.txId === TX);
  assert.ok(first && first.via === 'auto', 'A detects the payment');
  await settle([a, b], repo);
  assert.equal(b.state.sweeps.some((x) => x.txId === TX), false, 'the entry never travels');
  assert.equal(repo.text.includes(TX), false, 'nor is it in the file');
  // a day type that changes that week's offer, taken in on A: A's entry stays as its reading made it
  clock.t += 5 * MIN;
  act.type(b, '2026-11-04', 'off');
  await settle([b, a], repo);
  assert.equal(a.state.days['2026-11-04'].type, 'off');
  assert.deepEqual(a.state.sweeps.find((x) => x.txId === TX), first, 'taken in, nothing is derived again');
  // B reads the same row after the change: its own entry, from its own reading, differs (the known limit)
  clock.t += 5 * MIN;
  read(b);
  const own = b.state.sweeps.find((x) => x.txId === TX);
  assert.ok(own && own.via === 'auto', 'B detects the payment');
  assert.notEqual(own.amount, first.amount, 'each device reads the week at its own reading');
  // further readings, rounds and an edit noted on A leave both entries as they were
  clock.t += 5 * MIN;
  read(a);
  act.note(a, '2026-11-04', 'Walked to the shop');
  await settle([a, b], repo);
  assert.deepEqual(a.state.sweeps.find((x) => x.txId === TX), first);
  assert.deepEqual(b.state.sweeps.find((x) => x.txId === TX), own);
  await assertQuiet([a, b], repo, 'entries per device');
});

test('the owner\'s own weeks travel and win over a detected one on every device: Moved, Not this week and Reopen', async () => {
  const { TX, a, b, clock, read, repo } = paymentToCome();
  await settle([a, b], repo);
  read(a);
  const detected = a.state.sweeps.find((x) => x.txId === TX);
  const weekOf = detected.weekOf;
  const today = '2026-11-16';
  // Moved, tapped on B, which detected nothing for the week: the owner's entry replaces A's detected one
  act.sweep(b, weekOf, detected.amount + 1500, today);
  await settle([b, a], repo);
  const moved = { weekOf, amount: detected.amount + 1500, day: today, txId: null, via: 'tap' };
  for (const d of [a, b]) assert.deepEqual(d.state.sweeps.filter((x) => x.weekOf === weekOf), [moved]);
  // and a reading on either device never detects over it
  clock.t += 5 * MIN;
  read(a);
  read(b);
  await settle([a, b], repo);
  for (const d of [a, b]) assert.deepEqual(d.state.sweeps.filter((x) => x.weekOf === weekOf), [moved], 'a reading keeps the owner\'s week');
  assert.deepEqual(allSweeps(b.state), allSweeps(a.state));
  assert.deepEqual(makeLedger(b.state, clock.t).edge(), makeLedger(a.state, clock.t).edge(), 'the same edge');
  // Not this week, on A for the week just ended (amount 0): on both
  const open = addDays(weekOf, 7);
  act.sweep(a, open, 0, today);
  await settle([a, b], repo);
  for (const d of [a, b]) assert.deepEqual(d.state.sweeps.filter((x) => x.weekOf === open), [{ weekOf: open, amount: 0, day: today, txId: null, via: 'tap' }]);
  // Reopen on B: the owner's entry goes on both; each device's own reading then decides the week again
  act.reopen(b, weekOf);
  await settle([b, a], repo);
  for (const d of [a, b]) assert.equal(d.state.sweeps.some((x) => x.weekOf === weekOf && x.via === 'tap'), false, 'reopened everywhere');
  clock.t += 5 * MIN;
  read(a);
  assert.ok(a.state.sweeps.some((x) => x.weekOf === weekOf && x.via === 'auto' && x.txId === TX), 'A detects the week again from its own rows');
  await settle([a, b], repo);
  assert.equal(b.state.sweeps.some((x) => x.weekOf === weekOf && x.via === 'auto' && x.txId === TX && x.amount !== detected.amount), false);
  await assertQuiet([a, b], repo, 'owner weeks');
});

/** What the owner sees of the detected weeks and the Book: the weeks, the edge, the position, the Book and its links by content, 60 days of rounds. */
function weeksAndBook(state, nowMs) {
  const ledger = makeLedger(state, nowMs);
  const line = new Map(state.recurring.map((r) => [r.id, [r.name, r.mkey, r.accountId, r.amount, r.cadence, r.variable, r.active].join(':')]));
  const rounds = [];
  for (let day = addDays(ledger.today, -60); day <= ledger.today; day = addDays(day, 1)) rounds.push(ledger.round(day));
  return JSON.parse(JSON.stringify({
    weeks: allSweeps(state), edge: ledger.edge(), position: ledger.position(),
    book: [...line.values()].sort(), links: state.txs.map((tx) => tx.id + ':' + (tx.recurringId ? line.get(tx.recurringId) : '-') + ':' + tx.klass).sort(),
    rounds,
  }, (key, v) => (key === 'recurringId' ? (v ? line.get(v) || '?' : v) : v)));
}

/**
 * The update on a record an earlier build kept: the first load (app.js seedGame; handed the clock as the build before this
 * one did, it still leaves the detected weeks alone), a round, then a reading.
 */
async function updated(state, nowMs) {
  seedGame(state, nowMs);
  const d = deviceOf(state, () => nowMs);
  await settle([d], memory());
  readBank(d);
  return d.state;
}

function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

test('the update moves no figure: weekly card payments read day by day keep the weeks, Book and edge an earlier build gave them', async () => {
  // fef14dc's figures for these histories, measured on fef14dc (verify-sync-4 update-flip): fixed 9000 every Tuesday,
  // a few set amounts and the week's offer; the rows post 1 to 2 days late and the bank is read every day for 10 weeks
  const FEF14DC = { 'fixed 1': [2, 12600], 'fixed 3': [5, 38200], 'set 2': [6, 52100], 'offer 1': [11, 110200] };
  const DAY = 86400000;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const dayOf = (ms) => { const x = new Date(ms); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const base = buildDemoState(NOW);
  const T = base.txs.find((x) => x.id === 'tx_p0jfmbz5');
  const LG = base.txs.find((x) => x.id === T.pairId);
  // (the second video service, the returned-item fee and the arcade the sample gained for the money in and out page are
  // left out, so the purchases drawn from are those fef14dc's sample held)
  const SPEND = base.txs.filter((x) => x.source !== 'manual' && x.flow === 'out' && x.kind === 'spend' && !x.pending && !/interest|^hulu$|returned payment fee|arcade/.test(x.mkey || '')).slice(-40);
  for (const [label, [weeks, moved]] of Object.entries(FEF14DC)) {
    const [mode, seed] = [label.split(' ')[0], Number(label.split(' ')[1])];
    const r = xorshift(seed * 31 + (mode === 'fixed' ? 1 : mode === 'offer' ? 2 : 3));
    const s = clone(base);
    let n = 0;
    const pend = [];
    for (let t = NOW + DAY; t <= NOW + 70 * DAY; t += DAY) {
      const day = dayOf(t);
      if (r() < 0.7) {
        const src = SPEND[Math.floor(r() * SPEND.length)];
        const id = 'tx_u' + (++n);
        const amount = 300 + Math.floor(r() * 2500);
        pend.push({ at: addDays(day, 1 + Math.floor(r() * 2)), row: { ...clone(src), id, ext: { src: 'demo', id: 'u-' + id }, fp: 'u|' + id, day, postedDay: day, amount, recurringId: null, streamId: null, pairId: null, matchId: null, loggedAt: null } });
      }
      if (new Date(t).getDay() === 2) {
        const offer = makeLedger(s, t).edge().sweep;
        const amount = mode === 'fixed' ? 9000 : mode === 'set' ? [6000, 9000, 12000][Math.floor(r() * 3)] : (offer ? offer.amount : 0);
        if (amount > 0) {
          const id = 'tx_uw' + (++n);
          const leg = id + 'c';
          const lag = 1 + Math.floor(r() * 2);
          pend.push({ at: addDays(day, lag), row: { ...clone(T), id, ext: { src: 'demo', id: 'u-' + id }, fp: 'u|' + id, day, postedDay: day, amount, pairId: leg, recurringId: null, loggedAt: null } });
          pend.push({ at: addDays(day, lag), row: { ...clone(LG), id: leg, ext: { src: 'demo', id: 'u-' + leg }, fp: 'u|' + leg, day, postedDay: day, amount, pairId: id, recurringId: null, loggedAt: null } });
        }
      }
      for (const p of pend.filter((q) => q.at <= day && !q.done)) { s.txs.push(clone(p.row)); p.done = true; }
      for (const account of s.accounts) if (account.source === 'bank' && account.feed) { account.feed.readAt = t; account.asOf = t; }
      refresh(s, t + 9 * 3600000);
    }
    if (s.share) delete s.share.game;
    const end = NOW + 70 * DAY + 10 * 3600000;
    const before = weeksAndBook(s, end);
    assert.equal(before.weeks.filter((x) => x.via === 'auto').length, weeks, label + ': the weeks fef14dc detected');
    assert.equal(before.edge.moved, moved, label + ': what fef14dc counts as moved');
    const after = weeksAndBook(await updated(clone(s), end), end);
    assert.deepEqual(after, before, label + ': nothing moves at the update');
  }
});

test('the update moves no figure: a fixed weekly card payment read once a day, each row a day late, keeps its weeks and Book', async () => {
  // verify-owner-4 upgrade-daily-late: the sample from 2026-09-14, read at 10:00 each day; the owner pays the card 5000
  // every Friday from 2026-10-16. fef14dc detected 4 weeks (moved 13400, unmoved 4036) and holds no weekly card line.
  const END = new Date(2026, 10, 16, 10, 0).getTime();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const full = buildDemoState(END);
  full.meta.matchStart = '2026-09-14';
  const t = full.txs.find((tx) => tx.id === 'tx_p0jfmbz5');
  const leg = full.txs.find((tx) => tx.id === t.pairId);
  const pairs = [];
  for (let i = 4; i >= 1; i--) {
    const day = addDays('2026-11-13', -7 * i);
    const id = 'tx_wk' + i;
    const legId = id + 'c';
    const out = { ...clone(t), id, ext: { src: 'demo', id: 'gen-' + id }, fp: t.accountId + '|' + day + '|-5000|gen' + id, day, postedDay: day, amount: 5000, pairId: legId };
    const inn = { ...clone(leg), id: legId, ext: { src: 'demo', id: 'gen-' + legId }, fp: leg.accountId + '|' + day + '|5000|gen' + legId, day, postedDay: day, amount: 5000, pairId: id };
    for (const x of [out, inn]) { delete x.recurringId; delete x.klass; delete x.streamId; }
    pairs.push(out, inn);
  }
  const all = [...full.txs.map((x) => { const y = clone(x); delete y.recurringId; delete y.klass; return y; }), ...pairs];
  let s = clone(full);
  s.txs = [];
  s.recurring = [];
  s.sweeps = s.sweeps.filter((w) => w.via !== 'auto');
  for (let d = '2026-09-15'; d <= '2026-11-16'; d = addDays(d, 1)) {
    const now = new Date(d + 'T10:00:00').getTime();
    const seen = new Set(s.txs.map((x) => x.id));
    for (const x of all) if (!seen.has(x.id) && x.day <= addDays(d, -1)) s.txs.push(clone(x));
    for (const account of s.accounts) if (account.feed) { account.asOf = now; account.feed.readAt = now; }
    refresh(s, now);
    s = clone(s);
  }
  if (s.share) delete s.share.game;
  const before = weeksAndBook(s, END);
  assert.deepEqual(before.weeks.filter((x) => x.via === 'auto').map((x) => x.weekOf + ':' + x.amount),
    ['2026-10-05:1400', '2026-10-12:3400', '2026-10-26:1400', '2026-11-02:7200'], 'the weeks fef14dc detected');
  assert.deepEqual([before.edge.moved, before.edge.unmoved], [13400, 4036]);
  assert.equal(s.recurring.some((r) => r.active && /Online Transfer/i.test(r.name)), false, 'no card line in the Book');
  const after = weeksAndBook(await updated(clone(s), END), END);
  assert.deepEqual(after, before, 'nothing moves at the update');
});

/* ------------------------------------------------------------------ the noting limit */

/** The sample with no day records of its own, its bank rows cut at `day` (a stale link or a slow bank). */
function lagged(day) {
  const s = buildDemoState(NOW);
  s.days = {};
  s.txs = s.txs.filter((tx) => tx.source === 'manual' || tx.day <= day);
  return s;
}

test('the noting limit: a bye 14 days ahead travels at once while the newest bank row is 3 days old', async () => {
  const today = '2026-11-16';
  const base = JSON.stringify(lagged(addDays(today, -3)));
  const a = deviceOf(JSON.parse(base), () => NOW);
  const b = deviceOf(JSON.parse(base), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  assert.equal(gameLimit(a.state), addDays(today, -3 + GAME_NOTE_DAYS));
  act.bye(a, addDays(today, 14), true);
  act.type(a, addDays(today, 13), 'work');
  await settle([a, b], repo);
  assert.equal(b.state.days[addDays(today, 14)].bye, true);
  assert.equal(b.state.days[addDays(today, 13)].type, 'work');
  assert.deepEqual(shown(b.state), shown(a.state));
  await assertQuiet([a, b], repo, 'a bye 14 days ahead');
});

test('the noting limit: a device whose newest bank row is 19 days old still sends today\'s type, tomorrow\'s bye and yesterday\'s note', async () => {
  const today = '2026-11-16';
  const a = deviceOf(lagged(addDays(today, -19)), () => NOW);
  const b = deviceOf((() => { const s = buildDemoState(NOW); s.days = {}; return s; })(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  act.type(a, today, 'off');
  act.bye(a, addDays(today, 1), true);
  act.note(a, addDays(today, -1), 'Typed on the phone');
  await settle([a, b], repo);
  assert.equal(b.state.days[today].type, 'off');
  assert.equal(b.state.days[addDays(today, 1)].bye, true);
  assert.equal(b.state.days[addDays(today, -1)].note, 'Typed on the phone');
  assert.deepEqual(b.state.days, a.state.days);
  await assertQuiet([a, b], repo, 'a stale bank link');
});

test('the noting limit: a clock 410 days ahead is still held back and moves the limit for no device, itself included', async () => {
  const base = JSON.stringify(buildDemoState(NOW));
  const a = deviceOf(JSON.parse(base), () => NOW);
  const w = deviceOf(JSON.parse(base), () => NOW + 410 * DAY_MS);
  const repo = memory();
  await settle([a, w], repo);
  const limit = gameLimit(a.state);
  assert.equal(gameLimit(w.state), limit, 'the same limit on both: it reads no clock');
  const today = todayOf(w.state, w.clock());
  act.type(w, today, 'off');
  act.bye(w, addDays(today, 1), true);
  act.note(w, addDays(today, -1), 'Typed far ahead');
  act.plan(w, today, { container: true, breakfast: true, stops: 0, at: w.clock() });
  await settle([a, w], repo);
  const fileDays = Object.keys(JSON.parse(repo.text).game.days || {});
  for (const day of [today, addDays(today, 1), addDays(today, -1)]) {
    assert.ok(!fileDays.includes(day), day + ' is never noted');
    assert.equal(a.state.days[day], undefined);
  }
  assert.ok(w.state.days[today].type === 'off' && w.state.days[today].plan.container === true, 'they stay on that device');
  assert.equal(gameLimit(w.state), limit, 'its own edits do not move its limit');
  assert.equal(gameLimit(a.state), limit, 'nor the limit of the others');
  // a day just past the limit is not noted on either device
  act.note(w, addDays(limit, 1), 'Past the limit');
  act.note(a, addDays(limit, 1), 'Past the limit too');
  await settle([a, w], repo);
  assert.ok(!Object.keys(JSON.parse(repo.text).game.days || {}).includes(addDays(limit, 1)));
});

test('the noting limit: a held-back day is noted as soon as the limit allows, by a newer day another device wrote or by a newer bank row', async () => {
  const today = '2026-11-16';
  // (a) a newer day arrives in the shared copy
  {
    const a = deviceOf(lagged(addDays(today, -40)), () => NOW);
    const b = deviceOf((() => { const s = buildDemoState(NOW); s.days = {}; return s; })(), () => NOW + MIN);
    const repo = memory();
    await settle([a, b], repo);
    assert.equal(gameLimit(a.state), addDays(today, -40 + GAME_NOTE_DAYS));
    act.note(a, today, 'Held back');
    await settle([a, b], repo);
    assert.equal(b.state.days[today], undefined, 'held back while the limit is behind it');
    act.bye(b, today, true);
    await settle([b, a], repo);
    assert.equal(gameLimit(a.state), addDays(today, GAME_NOTE_DAYS), 'the newest day in the copy moves the limit');
    assert.equal(b.state.days[today].note, 'Held back', 'noted in the same round, it reaches B');
    assert.deepEqual(b.state.days[today], a.state.days[today]);
    await assertQuiet([a, b], repo, 'held back, then noted');
  }
  // (b) a reading brings a newer row
  {
    const full = buildDemoState(NOW);
    const s = lagged(addDays(today, -40));
    seedGame(s);
    s.days[today] = { note: 'Held back' };
    assert.equal(noteGame(s, NOW), false);
    assert.equal(storedGame(s).days, undefined);
    s.txs = full.txs;
    assert.equal(noteGame(s, NOW + MIN), true);
    assert.equal(storedGame(s).days[today].note.v, 'Held back');
  }
  // (c) a balance date the bank reported counts; a balance dated at the fetch (none reported) does not
  for (const [asOfShift, noted] of [[-DAY_MS, true], [0, false]]) {
    const s = lagged(addDays(today, -40));
    const account = s.accounts.find((x) => x.source === 'bank');
    account.feed = { ...(account.feed || {}), readAt: NOW };
    account.asOf = NOW + asOfShift;
    seedGame(s);
    s.days[today] = { note: 'Held back' };
    assert.equal(noteGame(s, NOW + MIN), noted, 'balance dated ' + (noted ? 'by the bank' : 'at the fetch'));
  }
});

/* ------------------------------------------------------------------ the noting limit, with no recent day */

/** memory(), answering as GitHub does with the server's time (the device keeps it in its share state, never in the file). */
function served(serverMs) {
  const t = memory();
  const read = t.read;
  const write = t.write;
  t.read = async () => ({ ...(await read()), serverMs: serverMs() });
  t.write = async (body, sha) => ({ ...(await write(body, sha)), serverMs: serverMs() });
  return t;
}

/** lagged(), with the last reading's balance dated at the fetch (none reported), so only the rows speak for the bank. */
function staleLink(today, days) {
  const s = lagged(addDays(today, -days));
  for (const account of s.accounts) {
    if (account.source !== 'bank') continue;
    account.feed = { ...(account.feed || {}), readAt: NOW - days * DAY_MS };
    account.asOf = account.feed.readAt;
  }
  return s;
}

test('the noting limit: links stale 17, 20, 25, 31 and 45 days with no recent day: a bye at today + 14 and today\'s type travel in one update', async () => {
  const today = '2026-11-16';
  for (const stale of [17, 20, 25, 31, 45]) {
    for (const server of [false, true]) {
      // with the rows alone a limit 31 or more days stale is before today: the server's day is what lets today through
      if (!server && stale > 25) continue;
      const label = stale + ' days stale, ' + (server ? 'the server\'s day known' : 'the rows alone');
      const base = JSON.stringify(staleLink(today, stale));
      const repo = server ? served(() => NOW + 30 * 1000) : memory();
      const a = deviceOf(JSON.parse(base), () => NOW);
      const b = deviceOf(JSON.parse(base), () => NOW + MIN);
      await settle([a, b], repo);
      assert.equal(gameLimit(a.state), addDays(server ? today : addDays(today, -stale), GAME_NOTE_DAYS), label + ': the limit');
      act.bye(a, addDays(today, 14), true);
      const held = !server; // 30 days after the newest row is before today + 14 for every stale age here
      assert.equal(!!(storedGame(a.state).days || {})[addDays(today, 14)], !held, label + ': the bye ' + (held ? 'waits' : 'is noted at once'));
      act.type(a, today, 'off');
      const copy = storedGame(a.state).days || {};
      assert.equal(copy[today] && copy[today].type.v, 'off', label + ': today\'s type is noted');
      assert.equal(copy[addDays(today, 14)] && copy[addDays(today, 14)].bye.v, true, label + ': and the bye with it, in the same update');
      await settle([a, b], repo);
      assert.equal(b.state.days[addDays(today, 14)].bye, true, label + ': the bye reaches B');
      assert.equal(b.state.days[today].type, 'off', label + ': today\'s type reaches B');
      assert.deepEqual(b.state.days, a.state.days, label);
      await assertQuiet([a, b], repo, label);
      // B plays today too: a note travels back
      act.note(b, today, 'Walked to the shop');
      await settle([b, a], repo);
      assert.equal(a.state.days[today].note, 'Walked to the shop', label + ': B\'s note reaches A');
      assert.equal(JSON.parse(repo.text).game.days[today] !== undefined, true);
      assert.equal(JSON.stringify(JSON.parse(repo.text)).includes('serverAt'), false, label + ': the server\'s time stays on the device');
    }
  }
});

test('the noting limit: with the server\'s day known, a clock 410 days ahead is still held back and moves no limit', async () => {
  const today = '2026-11-16';
  const base = JSON.stringify(staleLink(today, 45));
  const repo = served(() => NOW);
  const a = deviceOf(JSON.parse(base), () => NOW);
  const w = deviceOf(JSON.parse(base), () => NOW + 410 * DAY_MS);
  await settle([a, w], repo);
  const limit = addDays(today, GAME_NOTE_DAYS);
  assert.equal(gameLimit(a.state), limit);
  assert.equal(gameLimit(w.state), limit, 'the server\'s day, not the device\'s clock');
  const far = todayOf(w.state, w.clock());
  act.type(w, far, 'off');
  act.bye(w, addDays(far, 1), true);
  act.note(w, addDays(far, -1), 'Typed far ahead');
  act.type(a, today, 'work');
  await settle([a, w], repo);
  const fileDays = Object.keys(JSON.parse(repo.text).game.days || {});
  for (const day of [far, addDays(far, 1), addDays(far, -1)]) {
    assert.ok(!fileDays.includes(day), day + ' is never noted');
    assert.equal(a.state.days[day], undefined);
  }
  assert.equal(w.state.days[today].type, 'work', 'today\'s type on the right clock reaches the far device');
  assert.equal(gameLimit(w.state), limit, 'its own edits do not move its limit');
  assert.equal(gameLimit(a.state), limit, 'nor the limit of the others');
  // a server time earlier than the one held never moves it back
  const back = served(() => NOW - 60 * DAY_MS);
  back.text = repo.text;
  await a.round(back);
  assert.equal(gameLimit(a.state), limit);
});

test('the noting limit: an Undo that puts back today\'s type and a bye at today + 14 restamps both at once, the link 20 days stale', () => {
  const today = '2026-11-16';
  const before = staleLink(today, 20);
  seedGame(before);
  assert.equal(gameLimit(before), addDays(today, 10));
  const after = JSON.parse(JSON.stringify(before));
  after.days[today] = { type: 'off' };
  after.days[addDays(today, 14)] = { bye: true };
  assert.equal(restampGame(before, after), true);
  const days = storedGame(after).days || {};
  assert.deepEqual(days[today], { type: { v: 'off', at: 1, undo: true } });
  assert.deepEqual(days[addDays(today, 14)], { bye: { v: true, at: 1, undo: true } }, 'the bye, which the moved limit lets through, in the same restamp');
  assert.equal(gameLimit(after), addDays(today, 14 + GAME_NOTE_DAYS));
});
