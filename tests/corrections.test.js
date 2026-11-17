/**
 * The owner's corrections travel between their devices (ARCHITECTURE 3.8): merchant rules, the fields locked on one
 * bank row, and the settings locked on an income stream, in the shared file's `corrections` section. Every merchant,
 * payer, account and figure here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDoc, defaultState } from '../js/model/schema.js';
import { mergeFeed } from '../js/model/merge.js';
import { refresh } from '../js/model/detect.js';
import { learnRule } from '../js/model/classify.js';
import { clock } from '../js/model/ledger.js';
import { addByHand, editByHand, payeeKey, restampByHand, skipRow, tickByHand } from '../js/model/byhand.js';
import { addDays } from '../js/model/dates.js';
import { exportShared, mergeShared, readSharedFile, roundShared } from '../js/model/share.js';
import { shareMessage } from '../js/github.js';
import {
  MAX_MOVES, MAX_RULES, MAX_STREAM_SETTINGS, MOVE_KEEP_DAYS, applyCorrections, exportCorrections, mergeCorrections, noteMove,
  noteStream, pruneCorrections, readCorrections, restampCorrections,
} from '../js/model/corrections.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime(); // Saturday 14 November 2026
const PAYER = 'BRAMBLEWOOD WORKS';
/** Paid every other Friday; the four latest deposits come after a purchase from the same firm, so they read as refunds. */
const PAYDAYS = ['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06'];

function dateOnly(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

function row(extId, amount, day, description) {
  return { extId, amount, posted: dateOnly(day), at: null, pending: false, description, payee: '', memo: '', mcc: null };
}

const ROWS = [
  ...PAYDAYS.map((day) => row('DEP-' + day, 150000, day, PAYER)),
  row('BUY-0920', -200000, '2026-09-20', PAYER),
  row('CAFE-1102', -1250, '2026-11-02', 'FERNLEAF CAFE 0042'),
  row('CAFE-1109', -980, '2026-11-09', 'FERNLEAF CAFE 0042'),
];

function feed(rows, at = NOW, account = 'ACT-CHK-7') {
  return {
    src: 'simplefin', fetchedAt: at, fromMs: at - 200 * DAY_MS, toMs: at, errors: [],
    accounts: [{ extId: account, connId: 'CON-1', institution: 'Example Bank', name: 'Main Checking', currency: 'USD',
      balance: 812345, available: 812345, asOf: at - HOUR_MS, txs: rows }],
  };
}

/** One shared file in memory, written only with the sha just read (a stale sha is a conflict, as on GitHub). */
function repoOf() {
  const repo = { text: null, sha: null, n: 0, writes: 0 };
  repo.transport = {
    read: async () => ({ text: repo.text, sha: repo.sha }),
    write: async (text, sha) => {
      if (sha !== repo.sha) throw Object.assign(new Error('conflict'), { code: 'conflict' });
      repo.text = text;
      repo.sha = 'sha' + (++repo.n);
      repo.writes += 1;
      return {};
    },
  };
  return repo;
}

/** A device: its record read from the bank, the copies Undo keeps, and a round that reaches both (as the store does). */
function device(repo, rows = ROWS, account = 'ACT-CHK-7') {
  const d = { state: defaultState(NOW - 200 * DAY_MS), kept: [], account };
  mergeFeed(d.state, feed(rows, NOW, account), NOW);
  refresh(d.state, NOW);
  const api = {
    state: () => d.state,
    update: (now, past) => {
      now(d.state);
      d.kept = d.kept.map((json) => { const copy = JSON.parse(json); past(copy); return JSON.stringify(copy); });
    },
  };
  d.change = (fn) => { d.kept.push(JSON.stringify(d.state)); fn(d.state); };
  d.undo = (nowMs) => {
    const before = d.state;
    d.state = JSON.parse(d.kept.pop());
    restampByHand(before, d.state, nowMs);
    restampCorrections(before, d.state);
  };
  d.round = async (nowMs) => {
    const res = await roundShared(api, repo.transport, () => nowMs);
    assert.equal(checkDoc(d.state), null, 'the record is one the app will load again');
    return res;
  };
  d.read = (rows2, at = NOW) => { mergeFeed(d.state, feed(rows2, at, d.account), at); refresh(d.state, at); };
  d.row = (extId) => d.state.txs.find((tx) => tx.ext && tx.ext.id === extId);
  d.stream = () => d.state.streams.find((s) => s.mkey === d.row('DEP-2026-11-06').mkey);
  return d;
}

/** What the move sheet does: the correction through classify.learnRule, written down for the other devices, then detection. */
function correct(d, extId, fields, { onlyThis = false, at = NOW } = {}) {
  d.change((s) => {
    const tx = s.txs.find((t) => t.ext && t.ext.id === extId);
    learnRule(s, tx.id, fields, { onlyThis });
    noteMove(s, tx.id, at);
    refresh(s, at);
  });
}

/** What the stream sheet does: every field changed is set and locked, written down, then detection. */
function setStream(d, fields, at = NOW) {
  d.change((s) => {
    const item = s.streams.find((one) => one.id === d.stream().id);
    for (const [key, value] of Object.entries(fields)) {
      item[key] = value;
      if (!item.locks.includes(key)) item.locks.push(key);
    }
    noteStream(s, item.id, at);
    refresh(s, at);
  });
}

/** The classification of the rows that matter, and the rules: what "where a device was" means here. */
function picture(d) {
  return {
    // a merchant may hold a rule for each direction (3.3): their order in the list means nothing
    rules: d.state.settings.rules.map((r) => ({ mkey: r.mkey, flow: r.flow, category: r.category, merchant: r.merchant }))
      .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)),
    rows: ROWS.map((r) => d.row(r.extId)).filter(Boolean).map((tx) => [tx.ext.id, tx.kind, tx.category, tx.merchant,
      (tx.locks || []).filter((f) => f !== 'review').sort().join(',')]),
  };
}

/* ------------------------------------------------------------ the paycheck */

test('the paycheck: filed as income for the whole merchant on one device, the other files it as income, links it to its pay stream, and has a payday', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  for (const d of [a, b]) {
    assert.equal(d.row('DEP-2026-11-06').kind, 'refund', 'both devices read the latest deposits as refunds');
    assert.equal(d.row('DEP-2026-09-11').kind, 'income');
  }
  const streamBefore = b.stream();
  assert.ok(streamBefore, 'the older deposits made a pay stream');
  assert.equal(streamBefore.active, false, 'which has lapsed: its latest deposits do not count for it');
  assert.equal(clock(b.state, NOW).nextPayday, null, 'so B has no payday');

  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
  assert.equal(a.row('DEP-2026-11-06').kind, 'income');
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);

  const dep = b.row('DEP-2026-11-06');
  assert.equal(dep.ext.id, 'DEP-2026-11-06', 'the same provider id');
  assert.equal(dep.kind, 'income');
  assert.equal(dep.category, 'income');
  const stream = b.stream();
  assert.equal(dep.streamId, stream.id, 'linked to its pay stream');
  assert.equal(b.row('DEP-2026-10-23').streamId, stream.id, 'and the other deposits of the merchant follow the rule');
  assert.equal(stream.active, true, 'the stream is no longer lapsed');
  assert.match(String(clock(b.state, NOW + 3000).nextPayday), /^\d{4}-\d{2}-\d{2}$/, 'B has a payday');
  assert.equal(b.row('BUY-0920').kind, 'spend', 'the purchase stays a purchase');
  assert.deepEqual(picture(b), picture(a), 'both devices file every row the same way');
});

/* ------------------------------------------------------------------- Undo */

test('Undo of the correction after both rounds: both devices are back where they were, whichever device rounds first', async () => {
  for (const order of ['ab', 'ba']) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    const was = picture(a);
    assert.deepEqual(picture(b), was);
    correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
    await a.round(NOW + 2000);
    await b.round(NOW + 3000);
    assert.equal(b.row('DEP-2026-11-06').kind, 'income');
    a.undo(NOW + 4000);
    const rounds = order === 'ab' ? [a, b, a, b] : [b, a, b, a];
    for (const [i, d] of rounds.entries()) await d.round(NOW + 5000 + i);
    assert.deepEqual(picture(a), was, order + ': A is back');
    assert.deepEqual(picture(b), was, order + ': B is back');
    assert.equal(b.stream().active, false, order + ': and B’s stream has lapsed again');
  }
});

test('Undo before the other device ever saw the correction, and a correction made again afterwards', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  const was = picture(b);
  correct(a, 'CAFE-1109', { merchant: 'Fernleaf', category: 'cafe' }, { at: NOW + 1000 });
  await a.round(NOW + 2000);
  a.undo(NOW + 3000);
  await a.round(NOW + 4000);
  await b.round(NOW + 5000);
  assert.deepEqual(picture(b), was, 'B never shows the correction');
  assert.deepEqual(picture(a), was);
  correct(a, 'CAFE-1109', { merchant: 'Fernleaf Corner' }, { at: NOW + 6000 });
  await a.round(NOW + 7000);
  await b.round(NOW + 8000);
  assert.equal(b.row('CAFE-1109').merchant, 'Fernleaf Corner', 'an edit after the Undo wins');
  assert.equal(b.row('CAFE-1102').merchant, 'Fernleaf Corner', 'for the whole merchant');
});

test('the Undo is stamped just above the entry it undoes, so a later edit on another device still wins', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  correct(a, 'CAFE-1109', { merchant: 'Fernleaf' }, { at: NOW + 1000 });
  const merchant = payeeKey(a.row('CAFE-1109').mkey) + ':out'; // a purchase teaches the merchant's money-out rule (3.3)
  const stamp = exportCorrections(a.state).rules[merchant].merchant.at;
  a.undo(NOW + 50000); // the Undo comes much later, but its stamp is the field's + 1
  assert.deepEqual(exportCorrections(a.state).rules[merchant], { merchant: { deleted: true, at: stamp + 1, undo: true } }, 'the field alone is taken back, marked as an Undo');
  correct(b, 'CAFE-1109', { merchant: 'Fernleaf Kiosk' }, { at: NOW + 20000 }); // on B, after the edit and before the Undo's clock
  await a.round(NOW + 60000);
  await b.round(NOW + 61000);
  await a.round(NOW + 62000);
  assert.equal(a.row('CAFE-1109').merchant, 'Fernleaf Kiosk', 'B’s later edit wins on A');
  assert.equal(b.row('CAFE-1109').merchant, 'Fernleaf Kiosk');
});

test('an Undo of the owner’s other change never takes back a correction that arrived', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  correct(b, 'CAFE-1102', { purpose: 'work' }, { onlyThis: true, at: NOW + 500 }); // B's own change, kept for Undo
  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);
  assert.equal(b.row('DEP-2026-11-06').kind, 'income');
  b.undo(NOW + 4000);
  assert.equal(b.row('CAFE-1102').purpose, 'personal', 'B’s own change is taken back');
  assert.equal(b.row('DEP-2026-11-06').kind, 'income', 'what arrived stays');
  assert.equal(b.state.settings.rules.length, 1);
  await b.round(NOW + 5000);
  await a.round(NOW + 6000);
  assert.equal(a.row('DEP-2026-11-06').kind, 'income', 'and A keeps it');
  assert.deepEqual(picture(a), picture(b));
});

test('a rule for a merchant the device holds no row of waits for the reading that brings one; an Undo meanwhile keeps it', async () => {
  const repo = repoOf();
  const a = device(repo);
  const noCafe = ROWS.filter((r) => !r.extId.startsWith('CAFE'));
  const b = device(repo, noCafe);
  correct(a, 'CAFE-1109', { category: 'groceries', merchant: 'Fernleaf Market' }, { at: NOW + 1000 });
  correct(b, 'BUY-0920', { purpose: 'work' }, { onlyThis: true, at: NOW + 1500 }); // B's own change, kept for Undo
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);
  assert.equal(b.state.settings.rules.length, 0, 'no row of the merchant on B: nothing to file yet');
  b.read(ROWS, NOW + 4000);
  assert.equal(b.state.settings.rules.length, 1, 'the reading brought the rows, and the rule with them');
  for (const id of ['CAFE-1102', 'CAFE-1109']) assert.deepEqual([b.row(id).category, b.row(id).merchant], ['groceries', 'Fernleaf Market'], id);
  b.undo(NOW + 5000); // takes back B's own change; the copy it puts back has no café row yet
  assert.equal(b.row('BUY-0920').purpose, 'personal');
  await b.round(NOW + 6000);
  await a.round(NOW + 7000);
  assert.equal(a.state.settings.rules.length, 1, 'the Undo took nothing back on A');
  b.read(ROWS, NOW + 8000);
  assert.equal(b.row('CAFE-1102').merchant, 'Fernleaf Market', 'nor on B');
});

test('the document keeps its copy across saving and loading', async () => {
  const { migrate } = await import('../js/model/schema.js');
  const a = device(repoOf());
  correct(a, 'CAFE-1109', { merchant: 'Fernleaf' }, { at: NOW + 1000 });
  const copy = migrate(JSON.parse(JSON.stringify(a.state)));
  assert.equal(checkDoc(copy), null);
  assert.deepEqual(exportCorrections(copy), exportCorrections(a.state));
  assert.equal(Object.values(exportCorrections(copy).rules)[0].merchant.at, NOW + 1000);
});

/* ------------------------------------------------------------- one row */

test('“This move only” travels to that row alone, with every field locked on it', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  correct(a, 'CAFE-1102', { merchant: 'Team lunch', purpose: 'work', klass: 'need' }, { onlyThis: true, at: NOW + 1000 });
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);
  const tx = b.row('CAFE-1102');
  assert.deepEqual([tx.merchant, tx.purpose, tx.klass], ['Team lunch', 'work', 'need']);
  assert.deepEqual(tx.locks.filter((f) => f !== 'review').sort(), ['klass', 'merchant', 'purpose']);
  assert.notEqual(b.row('CAFE-1109').merchant, 'Team lunch', 'the other visit is left alone');
  assert.equal(b.state.settings.rules.length, 0, 'and nothing is learned');
  const file = readSharedFile(repo.text);
  assert.equal(Object.keys(file.corrections.moves).length, 1);
  const [key] = Object.keys(file.corrections.moves);
  assert.match(key, /^i[0-9a-f]{13}$/, 'the row is named by a hash of the provider ids, the same on every device');
  assert.equal(file.corrections.moves[key].day, '2026-11-02', 'with its day, so pruning is the same everywhere');
});

test('a correction for a row the device does not hold yet is applied when the bank reading brings it, once', async () => {
  const repo = repoOf();
  const a = device(repo);
  const behind = ROWS.filter((r) => r.extId !== 'CAFE-1109');
  const b = device(repo, behind);
  correct(a, 'CAFE-1109', { merchant: 'Corner table', purpose: 'work' }, { onlyThis: true, at: NOW + 1000 });
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);
  assert.equal(b.row('CAFE-1109'), undefined, 'B’s reading is behind');
  b.read(ROWS, NOW + 4000);
  const tx = b.row('CAFE-1109');
  assert.deepEqual([tx.merchant, tx.purpose], ['Corner table', 'work']);
  const once = JSON.stringify(b.state.txs);
  refresh(b.state, NOW + 5000);
  assert.equal(applyCorrections(b.state).changed, false, 'idempotent');
  assert.equal(JSON.stringify(b.state.txs), once, 'a second run of detection changes no row');
});

test('a bank that re-issued the row’s id: the correction finds the row by its fingerprint, as merge does', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo, ROWS.map((r) => (r.extId === 'CAFE-1109' ? { ...r, extId: 'CAFE-1109-REISSUED' } : r)));
  correct(a, 'CAFE-1109', { merchant: 'Corner table' }, { onlyThis: true, at: NOW + 1000 });
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);
  assert.equal(b.row('CAFE-1109-REISSUED').merchant, 'Corner table');
});

test('a row corrected while pending that posts under a new id and day: the other devices, which only see it posted, get it', async () => {
  const repo = repoOf();
  const pending = { extId: 'PEND-77', amount: -4200, posted: null, at: dateOnly('2026-11-12'), pending: true, description: 'WRENFOLD BISTRO', payee: '', memo: '', mcc: null };
  const posted = { ...row('POST-77', -5040, '2026-11-13', 'WRENFOLD BISTRO') }; // with the tip
  const a = device(repo, [...ROWS, pending]);
  const b = device(repo, [...ROWS, posted]);
  correct(a, 'PEND-77', { merchant: 'Team dinner', purpose: 'work' }, { onlyThis: true, at: NOW + 1000 });
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);
  assert.notEqual(b.row('POST-77').merchant, 'Team dinner', 'B cannot know the pending row');
  a.read([...ROWS, posted], NOW + 4000); // A's bank now reports it posted
  assert.equal(a.row('POST-77').merchant, 'Team dinner', 'on A the row keeps its correction');
  await a.round(NOW + 5000);
  await b.round(NOW + 6000);
  assert.deepEqual([b.row('POST-77').merchant, b.row('POST-77').purpose], ['Team dinner', 'work']);
  const once = JSON.stringify(b.state.share.corrections);
  refresh(b.state, NOW + 7000);
  refresh(a.state, NOW + 7000);
  assert.equal(JSON.stringify(b.state.share.corrections), once, 'written once');
});

/* ------------------------------------------------------------ the streams */

test('a stream’s settings travel by payer and account, never by its id, which differs between devices', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
  await a.round(NOW + 2000);
  await b.round(NOW + 3000);
  assert.notEqual(a.stream().id, b.stream().id, 'each device detected its own stream');
  setStream(a, { name: 'Day job', kind: 'salary', cadence: 'biweekly', accrue: true }, NOW + 4000);
  await a.round(NOW + 5000);
  await b.round(NOW + 6000);
  const s = b.stream();
  assert.deepEqual([s.name, s.kind, s.cadence, s.accrue], ['Day job', 'salary', 'biweekly', true]);
  assert.deepEqual(['accrue', 'cadence', 'kind', 'name'].filter((f) => s.locks.includes(f)), ['accrue', 'cadence', 'kind', 'name']);
  a.undo(NOW + 7000);
  await a.round(NOW + 8000);
  await b.round(NOW + 9000);
  assert.equal(b.stream().locks.includes('name'), false, 'the Undo travels too');
  assert.equal(b.stream().name, a.stream().name);
});

/* ------------------------------------------------------------ the stamps */

test('a later edit on the same device always wins, even when its clock went back', () => {
  const a = device(repoOf());
  correct(a, 'CAFE-1102', { merchant: 'First name' }, { onlyThis: true, at: NOW + 10000 });
  const key = Object.keys(exportCorrections(a.state).moves)[0];
  const first = exportCorrections(a.state).moves[key].merchant.at;
  assert.equal(first, NOW + 10000);
  correct(a, 'CAFE-1102', { merchant: 'Second name' }, { onlyThis: true, at: NOW }); // the clock was put back
  const second = exportCorrections(a.state).moves[key];
  assert.deepEqual(second.merchant, { v: 'Second name', at: first + 2 }, '2 above: an Undo of the first writes 1 above');
  assert.equal(noteMove(a.state, a.row('CAFE-1102').id, NOW + 20000), false, 'noting it again changes nothing');
});

test('seeding: before its first round a device exports what it already holds at 0; an explicit edit beats it; two old values merge by the canonical order', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  // corrections made before this version: the rule and the locks exist, nothing was written down
  for (const [d, name] of [[a, 'Fernleaf Alpha'], [b, 'Fernleaf Beta']]) {
    learnRule(d.state, d.row('CAFE-1102').id, { merchant: name });
    refresh(d.state, NOW);
  }
  const seeds = exportCorrections(a.state);
  assert.deepEqual(Object.values(seeds.rules), [{ merchant: { v: 'Fernleaf Alpha', at: 0 } }]);
  assert.deepEqual(Object.values(seeds.moves).map((m) => m.merchant), [{ v: 'Fernleaf Alpha', at: 0 }]);
  await a.round(NOW + 1000);
  await b.round(NOW + 2000);
  await a.round(NOW + 3000);
  assert.equal(a.row('CAFE-1109').merchant, 'Fernleaf Alpha', 'the smaller entry wins a tie, on both devices');
  assert.equal(b.row('CAFE-1109').merchant, 'Fernleaf Alpha');
  correct(b, 'CAFE-1109', { merchant: 'Fernleaf Gamma' }, { at: NOW + 4000 });
  await b.round(NOW + 5000);
  await a.round(NOW + 6000);
  assert.equal(a.row('CAFE-1109').merchant, 'Fernleaf Gamma', 'an explicit edit beats the seeds');
  assert.equal(a.state.settings.rules[0].merchant, 'Fernleaf Gamma', 'the rule too');
  assert.equal(a.row('CAFE-1102').merchant, 'Fernleaf Alpha', 'a row corrected on its own keeps its own correction');
});

/* ------------------------------------------------------------ the merge */

/** An entry of every shape: one field or several, fields taken back, different stamps per field, and the first build's shape. */
function entry(seed, at) {
  const kinds = [
    { category: { v: 'cafe', at } }, { merchant: { v: 'Name ' + seed, at } }, { purpose: { v: 'work', at }, klass: { v: 'need', at: (at + 1) % 3 } },
    { category: { deleted: true, at }, merchant: { v: 'Name ' + (seed % 2), at: (at + 2) % 3 } }, { klass: { deleted: true, at } },
    { category: 'groceries', at }, { deleted: true, at },
    // an Undo's cells, and an edit of a category naming the cell it replaced: on the same stamp an edit beats an Undo
    { merchant: { v: 'Name ' + (seed % 3), at, undo: true }, category: { v: 'cafe', at, over: (at + 1) % 3 } },
    { category: { deleted: true, at, undo: true }, merchant: { v: 'Name 1', at } }, { category: { v: 'groceries', at, undo: true } },
  ];
  return kinds[seed % kinds.length];
}

/** JSON with sorted keys. */
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x);
}

function section(seed, size) {
  const out = { rules: {}, moves: {}, streams: {} };
  for (let k = 0; k < size; k++) {
    const n = (seed * 7 + k * 3) % 11;
    const at = (seed + k) % 3; // many ties
    out.rules['p' + String(n).padStart(13, '0')] = entry(seed + k, at);
    const m = entry(seed * 3 + k, at);
    out.moves['i' + String(n).padStart(13, '0')] = { ...m, day: '2026-11-0' + (1 + (n % 9)) };
    out.streams['p' + String(n).padStart(13, '0') + '|a' + String(n).padStart(13, 'a')] = (seed + k) % 4 === 3 ? { deleted: true, at }
      : (seed + k) % 4 === 2 ? { name: { v: 'Pay ' + seed, at }, accrue: { deleted: true, at: (at + 1) % 3 } } : { name: { v: 'Pay ' + seed, at: (at + 1) % 3 }, accrue: { v: k % 2 === 0, at } };
  }
  return out;
}

test('the merge is commutative, associative and idempotent, removals and ties included', () => {
  const xs = [section(1, 6), section(2, 7), section(3, 5), section(4, 0)];
  for (const x of xs) assert.ok(readCorrections(x), 'each is a section this version reads');
  const same = (p, q) => assert.equal(canon(p), canon(q));
  for (const x of xs) {
    same(mergeCorrections(x, x), readCorrections(x));
    for (const y of xs) {
      same(mergeCorrections(x, y), mergeCorrections(y, x));
      for (const z of xs) same(mergeCorrections(mergeCorrections(x, y), z), mergeCorrections(x, mergeCorrections(y, z)));
    }
  }
  const cafe = payeeKey('fernleaf cafe');
  const m = mergeCorrections({ rules: { [cafe]: { category: { v: 'cafe', at: 5 }, merchant: { v: 'Fernleaf', at: 9 } } } },
    { rules: { [cafe]: { category: { deleted: true, at: 6 }, klass: { v: 'need', at: 2 } } } });
  assert.deepEqual(m.rules[cafe], { category: { deleted: true, at: 6 }, klass: { v: 'need', at: 2 }, merchant: { v: 'Fernleaf', at: 9 } },
    'field by field: a later removal of one field wins, and the other fields of both sides are kept');
  const old = mergeCorrections({ rules: { [cafe]: { deleted: true, at: 6 } } }, { rules: { [cafe]: { merchant: { v: 'Fernleaf', at: 7 } } } });
  assert.deepEqual(old.rules[cafe], { category: { deleted: true, at: 6 }, klass: { deleted: true, at: 6 }, purpose: { deleted: true, at: 6 }, merchant: { v: 'Fernleaf', at: 7 } },
    'an entry of the first build reads as the same fields, each stamped with its at');
});

test('the limits: the newest by stamp are kept, the same whichever side holds them', () => {
  assert.deepEqual([MAX_RULES, MAX_MOVES, MAX_STREAM_SETTINGS, MOVE_KEEP_DAYS], [1000, 1000, 200, 400]);
  const x = { rules: {}, moves: {}, streams: {} };
  const y = { rules: {}, moves: {}, streams: {} };
  const key = (k) => 'p' + k.toString(16).padStart(13, '0');
  for (let k = 0; k < MAX_RULES + 10; k++) (k % 2 ? x : y).rules[key(k)] = { category: 'cafe', at: k };
  const m = mergeCorrections(x, y);
  assert.equal(Object.keys(m.rules).length, MAX_RULES);
  assert.ok(!m.rules[key(0)] && !m.rules[key(9)] && m.rules[key(10)] && m.rules[key(MAX_RULES + 9)], 'the oldest stamps go');
  assert.equal(JSON.stringify(mergeCorrections(y, x)), JSON.stringify(m));
  assert.equal(JSON.stringify(mergeCorrections(m, x)), JSON.stringify(m));
});

test('the limits keep the merge commutative, associative and idempotent, field by field', () => {
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const hex = (n) => n.toString(16).padStart(13, '0');
  const cell = (v) => (rand(5) ? { v, at: rand(300) } : { deleted: true, at: rand(300) });
  const make = (from) => {
    const out = { rules: {}, moves: {}, streams: {} };
    for (let k = from; k < from + MAX_RULES; k++) {
      out.rules['p' + hex(k)] = rand(2) ? { category: cell('cafe') } : { category: cell('groceries'), merchant: cell('M' + rand(3)) };
      out.moves['i' + hex(k)] = { merchant: cell('M' + rand(3)), ...(rand(2) ? { purpose: cell('work') } : {}), day: '2026-11-0' + (1 + rand(9)) };
    }
    for (let k = from; k < from + MAX_STREAM_SETTINGS; k++) out.streams['p' + hex(k) + '|a' + hex(1)] = { name: cell('P' + rand(3)), accrue: cell(true) };
    return out;
  };
  for (let t = 0; t < 4; t++) {
    const [x, y, z] = [make(0), make(500), make(250)];
    const l = mergeCorrections(mergeCorrections(x, y), z);
    assert.equal(canon(l), canon(mergeCorrections(x, mergeCorrections(y, z))), 'associative');
    assert.equal(canon(l), canon(mergeCorrections(mergeCorrections(z, x), y)), 'in any order');
    assert.equal(canon(mergeCorrections(l, x)), canon(l), 'idempotent');
    assert.deepEqual([Object.keys(l.rules).length, Object.keys(l.moves).length, Object.keys(l.streams).length], [MAX_RULES, MAX_MOVES, MAX_STREAM_SETTINGS]);
  }
});

test('a device with a correction of a row more than 400 days old agrees with the file after one round, and stays so', async () => {
  const repo = repoOf();
  const old = row('OLD-1', -3300, '2025-09-01', 'WRENFOLD BISTRO');
  const a = device(repo, [...ROWS, old]);
  learnRule(a.state, a.row('OLD-1').id, { merchant: 'Old dinner' }, { onlyThis: true }); // before this version
  refresh(a.state, NOW);
  correct(a, 'CAFE-1102', { merchant: 'Fernleaf' }, { onlyThis: true, at: NOW + 500 }); // seeds the copy, the old row in it
  assert.equal((await a.round(NOW + 1000)).wrote, true);
  for (let i = 2; i < 5; i++) {
    const res = await a.round(NOW + i * 1000);
    assert.deepEqual([res.changed, res.wrote], [false, false], 'nothing to apply or write again (' + i + ')');
  }
  assert.equal(Object.keys(readSharedFile(repo.text).corrections.moves).length, 1, 'the old row is not written');
  assert.equal(a.row('OLD-1').merchant, 'Old dinner', 'and keeps its correction on the device');
});

test('a row correction more than 400 days older than the newest corrected row is pruned, by the days alone', () => {
  const s = { rules: {}, moves: {
    i0000000000001: { merchant: 'Old', day: addDays('2026-11-09', -401), at: 5 },
    i0000000000002: { merchant: 'Edge', day: addDays('2026-11-09', -400), at: 5 },
    i0000000000003: { merchant: 'Kept', day: addDays('2026-11-09', -399), at: 5 },
    i0000000000004: { merchant: 'Newest', day: '2026-11-09', at: 1 },
  }, streams: {} };
  const kept = ['i0000000000002', 'i0000000000003', 'i0000000000004'];
  assert.deepEqual(Object.keys(pruneCorrections(s).moves), kept);
  assert.deepEqual(Object.keys(pruneCorrections(s, Date.UTC(2027, 5, 1)).moves), kept, 'no clock is read');
  assert.deepEqual(pruneCorrections(pruneCorrections(s)), pruneCorrections(s), 'pruning again draws the same line');
});

/* ------------------------------------------------------------ the file */

test('the file is checked: a section this version cannot read refuses the whole file; an old file reads unchanged', () => {
  const base = { v: 1, app: 'networth', savedAt: 5, byHand: {} };
  assert.deepEqual(readSharedFile(JSON.stringify(base)), base, 'a file of an older version reads unchanged');
  const bad = [
    { rules: { p0123456789abc: { category: 'not-a-category', at: 1 } } },
    { rules: { p0123456789abc: { at: 1 } } },
    { rules: { 'fernleaf cafe': { category: 'cafe', at: 1 } } }, // a merchant key in the clear: never written
    { moves: { i0000000000001: { merchant: 'X', at: 1 } } }, // no day
    { moves: { nope: { merchant: 'X', day: '2026-11-01', at: 1 } } },
    { streams: { 'p0123456789abc|a0000000000000': { cadence: 'hourly', at: 1 } } },
    JSON.parse('{ "streams": { "__proto__": { "name": "X", "at": 1 } } }'),
    { rules: { p0123456789abc: { category: 'cafe', at: -1 } } },
    { rules: { p0123456789abc: { category: { v: 'not-a-category', at: 1 } } } },
    { rules: { p0123456789abc: { category: { v: 'cafe' } } } }, // no stamp
    { rules: { p0123456789abc: { category: { deleted: true, v: 'cafe', at: 1 } } } },
    { moves: { i0000000000001: { merchant: { v: 'X', at: 1 } } } }, // no day
    { moves: { i0000000000001: { merchant: { v: 'X', at: 1 }, day: '2026-11-01', from: 'i0000000000001' } } }, // continues itself
    { streams: { 'p0123456789abc|a0000000000000': { accrue: { v: 'yes', at: 1 } } } },
    'not a section',
  ];
  for (const corrections of bad) assert.equal(readSharedFile(JSON.stringify({ ...base, corrections })), null, JSON.stringify(corrections));
  const good = { rules: { p0123456789abc: { merchant: { v: 'Fernleaf', at: 3 }, klass: { deleted: true, at: 4 } } },
    moves: { i0000000000001: { purpose: { v: 'work', at: 5 }, day: '2026-11-01', fp: 'f0000000000002', from: 'i0000000000003' } },
    streams: { 'p0123456789abd|a0123456789abc': { cadence: { v: null, at: 2 } } } };
  const read = readSharedFile(JSON.stringify({ ...base, corrections: good })).corrections;
  assert.equal(canon(read), canon(good));
  const first = { rules: { p0123456789abc: { merchant: 'Fernleaf', at: 3 } }, moves: {}, streams: { 'p0123456789abd|a0123456789abc': { cadence: null, at: 2 } } };
  assert.deepEqual(readSharedFile(JSON.stringify({ ...base, corrections: first })).corrections,
    { rules: { p0123456789abc: { merchant: { v: 'Fernleaf', at: 3 } } }, moves: {}, streams: { 'p0123456789abd|a0123456789abc': { cadence: { v: null, at: 2 } } } },
    'a file of the first build reads as the same fields, each stamped with its entry’s at');
  const fresh = defaultState(NOW);
  assert.equal(exportShared(fresh, NOW).corrections, undefined, 'a device with nothing corrected writes no section');
  const merged = mergeShared({ ...base, corrections: good }, base);
  assert.equal(canon(merged.corrections), canon(good));
});

test('worst case: income, payments by hand and corrections at their limits stay well under the reader’s limit', () => {
  const big = 99999999999999;
  const key = (p, k) => 's'.repeat(80) + '/' + p + String(k).padStart(79, '0');
  const payers = {};
  const items = {};
  const counts = [];
  for (let k = 0; k < 300; k++) payers[key('p', k)] = { how: 'bank', at: big - k };
  for (let k = 0; k < 1000; k++) items[key('i', k)] = { how: 'wait', at: big - k, until: big - k };
  for (let k = 0; k < 200; k++) counts.push({ id: 'c' + 'x'.repeat(79 - String(k).length) + k, cents: 10000000000, at: big - k, editedAt: big - k });
  const recurring = [];
  for (let k = 0; k < 200; k++) {
    const marks = {};
    for (let m = 0; m < 13; m++) marks[addDays('2025-10-28', 30 * m)] = { paid: true, at: big - m };
    recurring.push({ id: 'r' + String(k).padStart(79, '0'), byHand: true, name: 'N'.repeat(60), amount: 10000000000, dueDay: 31, since: '2026-11-14', active: true,
      editedAt: big - k, payee: 'p0123456789abc', payeeAt: big - k, marks, skips: {} });
  }
  const tombs = {};
  for (let k = 0; k < 1000; k++) tombs['t' + String(k).padStart(79, '0')] = NOW - k;
  // the corrections at their limits, every field at its longest, each with its own stamp; names of plain characters,
  // then names of characters JSON writes as two ('"'): a half of a surrogate pair, written as six, is refused
  // every cell at its longest: a rule's category an edit naming the cell it replaced (`over`), every other cell an Undo's
  const cells = (fields, at) => Object.fromEntries(Object.entries(fields).map(([field, v]) => [field, { v, at, undo: true }]));
  const ruleCells = (fields, at) => ({ ...cells(fields, at), category: { v: fields.category, at, over: at - 1 } });
  const sizes = [];
  for (const c of ['M', '"']) {
    const rules = {};
    const moves = {};
    const streams = {};
    const longest = { category: 'subscriptions', klass: 'need', purpose: 'personal', merchant: c.repeat(48) };
    for (let k = 0; k < MAX_RULES; k++) rules['p' + k.toString(16).padStart(13, '0')] = ruleCells(longest, big - k);
    for (let k = 0; k < MAX_MOVES; k++) {
      moves['i' + k.toString(16).padStart(13, '0')] = { ...cells(longest, big - k), day: '2026-11-14', fp: 'f' + k.toString(16).padStart(13, '0'), from: 'i' + (k + 1).toString(16).padStart(13, 'f') };
    }
    for (let k = 0; k < MAX_STREAM_SETTINGS; k++) {
      streams['p' + k.toString(16).padStart(13, '0') + '|a' + k.toString(16).padStart(13, '0')] = cells({ name: c.repeat(80), kind: 'salary', cadence: 'semimonthly', accrue: false }, big - k);
    }
    const state = { recurring, share: { tombs, corrections: { rules, moves, streams } },
      income: { sources: {}, firstReadAt: NOW, shared: { since: big, payers, items, counts } } };
    const file = exportShared(state, NOW);
    assert.equal(Object.keys(file.corrections.moves).length, MAX_MOVES);
    const text = JSON.stringify({ ...file, savedAt: big }, null, 1); // as roundShared writes it
    assert.ok(readSharedFile(text), 'it is read back');
    sizes.push(text.length);
  }
  assert.ok(sizes[0] < 1850000, sizes[0] + ' characters with plain names, under the 2,000,000 the reader takes with room to spare');
  assert.ok(sizes[1] < 1950000, sizes[1] + ' characters with names JSON escapes, still under it');
  const half = { rules: { p0123456789abc: { merchant: { v: 'Fern\ud800leaf', at: 1 } } } };
  assert.equal(readCorrections(half), null, 'a half of a surrogate pair is refused');
  assert.ok(readCorrections({ rules: { p0123456789abc: { merchant: { v: 'Fern🌿leaf', at: 1 } } } }), 'a whole pair is a name like any other');
});

test('the words: Settings says, in one plain line, that corrections reach the other devices', async () => {
  // the two sentences are phrases of the vocabulary (model/words.js); in Chess words they are exactly the wording pinned here
  const { phrase, say, shareToast } = await import('../js/model/words.js');
  const corrections = phrase('settings.shared.corrections', 'chess');
  const what = phrase('settings.shared.what', 'chess');
  // grown for the daily game (3.9): what of it travels, and that the owner's notes and lines are in their private file
  assert.equal(corrections, 'Corrections (categories, merchant names, income settings) reach your other devices too, each with an unreadable fingerprint of its merchant or move and, for a corrected move, its bank date, so that every device finds the same move. So does the daily game: its settings, each round’s colour, byes, notes and morning plans, Habit and the weeks you moved or set aside, so that every device scores each round the same way.');
  assert.equal(what, 'Apart from the date of a corrected move, nothing the bank reported goes there: no balance, no transaction, no account. Only what you entered (payments, notes, morning plans, tag names, your principles and what you did instead), your ticks, Habit’s figures and the amount of each week you moved, and an unreadable fingerprint of who each payment goes to, so every device recognises it the same way.');
  // and in Finance words, with the same figures named
  assert.equal(phrase('settings.shared.what', 'finance'), 'Apart from the date of a corrected transaction, nothing the bank reported goes there: no balance, no other transaction, no account. Only what you entered (payments, notes, morning plans, tag names, your spending rules and what you did instead), your ticks, the baseline’s figures and the amount of each week you transferred, and an unreadable fingerprint of who each payment goes to, so every device recognises it the same way.');
  // the heading and the ledes name the main things the file carries, in both word modes
  assert.equal(phrase('settings.share.head', 'chess'), 'payments, corrections and the daily game');
  assert.equal(phrase('settings.share.head', 'finance'), 'payments, corrections and the daily budget');
  // the ledes name everything the file holds: the word mode and how each payer pays as well (3.9)
  assert.equal(say('settings.share.onLede', 'chess', { owner: 'quill' }), 'The payments you send yourself and their ticks, your corrections, your daily game, your choice of Chess or Finance words and how each payer pays, in the file networth-shared.json of quill/networth-data on your own GitHub.');
  assert.equal(say('settings.share.onLede', 'finance', { owner: 'quill' }), 'The payments you send yourself and their ticks, your corrections, your daily budget, your choice of Chess or Finance words and how each payer pays, in the file networth-shared.json of quill/networth-data on your own GitHub.');
  assert.equal(say('settings.share.offLede', 'chess', { owner: 'quill' }), 'The payments you send yourself and their ticks, your corrections, your daily game, your choice of Chess or Finance words and how each payer pays are then kept in a private file on your own GitHub (quill/networth-data):');
  assert.equal(say('settings.share.offLede', 'finance', { owner: 'quill' }), 'The payments you send yourself and their ticks, your corrections, your daily budget, your choice of Chess or Finance words and how each payer pays are then stored in a private file on your own GitHub (quill/networth-data):');
  assert.equal(phrase('settings.share.sampleLede', 'chess'), 'With your own record, 1 paste on each device keeps the payments you send and their ticks, your corrections, your daily game, your choice of words and how each payer pays the same on all of them.');
  assert.equal(phrase('settings.share.sampleLede', 'finance'), 'With your own record, 1 paste on each device keeps the payments you send and their ticks, your corrections, your daily budget, your choice of words and how each payer pays the same on all of them.');
  // forgetting the key keeps everything already here, not only the payments; the facts speak of the whole file
  assert.equal(phrase('settings.share.forgetGo', 'chess'), 'Forget — all stays');
  assert.equal(phrase('settings.share.forgetGo', 'finance'), 'Forget — all stays');
  assert.equal(phrase('settings.share.forget', 'chess'), 'The key is removed from this 1 device and nothing more is shared from it. Everything already here stays (the payments and their ticks, corrections, the daily game, your words and how each payer pays), the file on GitHub stays as it is, and the other devices carry on.');
  assert.equal(phrase('settings.share.forget', 'finance'), 'The key is removed from this 1 device and nothing more is shared from it. Everything already here stays (the payments and their ticks, corrections, the daily budget, your words and how each payer pays), the file on GitHub stays as it is, and the other devices carry on.');
  assert.equal(phrase('settings.share.agreed', 'chess'), 'this device and the shared file held exactly the same');
  assert.equal(phrase('settings.share.agreed', 'finance'), 'this device and the shared file held exactly the same');
  assert.equal(phrase('settings.share.payments', 'chess'), 'in the shared file');
  assert.equal(phrase('settings.share.payments', 'finance'), 'in the shared file');
  assert.equal(phrase('settings.share.comparing', 'chess'), 'Comparing with the shared file');
  assert.equal(phrase('settings.share.comparing', 'finance'), 'Comparing with the shared file');
  // the toasts and the other lines of sharing speak of the shared file too, and agree with "everything already here stays"
  for (const mode of ['chess', 'finance']) {
    assert.equal(say('settings.share.forgotten', mode, { when: 'at 9:41' }), 'Key forgotten at 9:41. Everything already here stays on this device, and the shared file stays on GitHub.');
    assert.equal(say('settings.share.since', mode, { time: '9:41', count: '3 payments' }), 'Sharing since 9:41: 3 payments in the shared file.');
    assert.equal(say('settings.share.agreedAt', mode, { time: '9:41', count: '3 payments' }), 'Agreed with the shared file at 9:41: 3 payments.');
    // the toasts after sharing starts and after Share now leave out a count of none: never "0 payments"
    assert.equal(shareToast('settings.share.since', mode, '9:41', 0), 'Sharing since 9:41: this device and the shared file agree.');
    assert.equal(shareToast('settings.share.agreedAt', mode, '9:41', 0), 'Agreed with the shared file at 9:41.');
    assert.equal(shareToast('settings.share.since', mode, '9:41', 1), 'Sharing since 9:41: 1 payment in the shared file.');
    assert.equal(shareToast('settings.share.agreedAt', mode, '9:41', 3), 'Agreed with the shared file at 9:41: 3 payments.');
    for (const count of [0, null, undefined, NaN, -1]) {
      for (const key of ['settings.share.since', 'settings.share.agreedAt']) assert.doesNotMatch(shareToast(key, mode, '9:41', count), /\b0 payments?\b|payments?\.$|\{|NaN|-1/, key + ' with ' + count);
    }
    assert.equal(phrase('settings.share.refusedLede', mode), 'Everything on this device is intact, and the shared file on GitHub was not changed. A new key takes the same 3 steps.');
    assert.equal(phrase('settings.share.noFile', mode), 'GitHub shows this key no shared file yet; it is written with the first change to share');
    assert.equal(phrase('words.help', mode), 'Chess words is the app’s own way of speaking; Finance words gives each term its standard finance or accounting name. Only words change, never a figure or a rule. With sharing on, your other devices follow through the shared file.');
  }
  for (const mode of ['chess', 'finance']) {
    for (const key of ['settings.share.onLede', 'settings.share.offLede', 'settings.share.sampleLede', 'settings.share.forget', 'settings.share.forgetGo', 'settings.share.agreed', 'settings.share.payments', 'settings.share.comparing',
      'settings.share.forgotten', 'settings.share.since', 'settings.share.sinceNone', 'settings.share.agreedAt', 'settings.share.agreedAtNone', 'settings.share.refusedLede', 'settings.share.noFile', 'words.help']) {
      assert.doesNotMatch(phrase(key, mode), /\blist\b/, key + ' speaks of more than a list');
    }
  }
  // and so does every message of the transport, the commit message it writes included
  for (const code of ['key', 'missing', 'conflict', 'network', 'server', 'rate', 'file', 'large', 'unknown']) assert.doesNotMatch(shareMessage(code), /\blist\b/, code);
  assert.equal(shareMessage('conflict'), 'Another device wrote the shared file at the same moment, 4 times in a row.');
  assert.match(corrections, /^Corrections \(categories, merchant names, income settings\) reach your other devices too/);
  // exactly what travels with them: a fingerprint, and a corrected move's bank date, so every device finds the same move
  assert.match(corrections, /an unreadable fingerprint of its merchant or move and, for a corrected move, its bank date, so that every device finds the same move\. /);
  // and the sentence after it stays true: the bank date is the one thing the bank reported that goes there
  assert.match(what, /^Apart from the date of a corrected move, nothing the bank reported goes there: no balance, no transaction, no account\./);
  // Settings with sharing set up shows that wording in Chess words, in the section whether sharing is on, off or refused
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const helper = fileURLToPath(new URL('./helpers/render-settings.mjs', import.meta.url));
  for (const share of ['on', 'off', 'refused']) {
    const page = JSON.parse(execFileSync(process.execPath, [helper, 'chess', share], { encoding: 'utf8' }));
    assert.equal(page.split(corrections).length - 1, 1, share + ': the corrections sentence, once');
    assert.equal(page.split(what).length - 1, 1, share + ': what is shared, once');
    assert.ok(page.indexOf(corrections) < page.indexOf(what), share + ': the date is named before the sentence that sets it apart');
  }
});

/* ------------------------------------------------- field by field, and Undo */

/** Round the devices in turn until a whole pass changes and writes nothing (at most a few passes). */
async function settle(devices, from) {
  let at = from;
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const d of devices) {
      const res = await d.round(at++);
      if (res.changed || res.wrote) moved = true;
    }
    if (!moved) return at;
  }
  assert.fail('the devices never settled');
}

const incomeRows = (d) => PAYDAYS.filter((day) => d.row('DEP-' + day).kind === 'income').length;

test('two devices correct different fields of one row before a round: both corrections are kept on both', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  correct(b, 'CAFE-1102', { category: 'groceries' }, { onlyThis: true, at: NOW + 1000 });
  correct(a, 'CAFE-1102', { purpose: 'work' }, { onlyThis: true, at: NOW + 2000 });
  await settle([b, a], NOW + 3000);
  for (const d of [a, b]) {
    const tx = d.row('CAFE-1102');
    assert.deepEqual([tx.category, tx.purpose], ['groceries', 'work']);
    assert.deepEqual(tx.locks.filter((f) => f !== 'review').sort(), ['category', 'purpose']);
  }
});

test('an old rule on one device and a newer edit of another field on another: the rule keeps both fields', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  learnRule(a.state, a.row('CAFE-1102').id, { klass: 'want' }); // on A, before this version
  refresh(a.state, NOW);
  correct(b, 'CAFE-1109', { merchant: 'Fernleaf Corner' }, { at: NOW + 1000 });
  await settle([a, b], NOW + 2000);
  for (const d of [a, b]) {
    assert.deepEqual(d.state.settings.rules.map((r) => [r.klass, r.merchant]), [['want', 'Fernleaf Corner']]);
    assert.deepEqual([d.row('CAFE-1109').klass, d.row('CAFE-1109').merchant], ['want', 'Fernleaf Corner']);
  }
});

test('a field taken back on one device never removes the other fields an old correction of another device holds', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  learnRule(b.state, b.row('DEP-2026-11-06').id, { category: 'income' }); // on B, before this version
  refresh(b.state, NOW);
  const was = picture(b);
  correct(a, 'DEP-2026-11-06', { merchant: 'Brambles' }, { at: NOW + 1000 });
  a.undo(NOW + 2000);
  await a.round(NOW + 3000);
  await settle([b, a], NOW + 4000);
  assert.deepEqual(picture(b), was, 'B keeps its income rule');
  assert.deepEqual(picture(a), was, 'and A takes it');
  assert.equal(incomeRows(a), 10);
  assert.match(String(clock(a.state, NOW + 9000).nextPayday), /^\d{4}-\d{2}-\d{2}$/);
});

test('two Undos in a row with no round between: both stick, on every device', async () => {
  for (const variant of ['rule', 'stream']) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    if (variant === 'stream') {
      correct(b, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 100 });
      await settle([b, a], NOW + 200);
    }
    const was = [picture(a), picture(b)];
    const name = (d) => [d.stream().name, d.stream().locks.includes('name')];
    const names = [name(a), name(b)];
    correct(b, 'CAFE-1102', { purpose: 'work' }, { onlyThis: true, at: NOW + 1000 }); // any undoable change
    if (variant === 'rule') correct(b, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 2000 });
    else setStream(b, { name: 'Main pay' }, NOW + 2000);
    await b.round(NOW + 3000);
    await a.round(NOW + 4000);
    b.undo(NOW + 5000);
    b.undo(NOW + 6000);
    await settle([b, a], NOW + 7000);
    assert.deepEqual([picture(a), picture(b)], was, variant + ': both devices are back where they began');
    assert.deepEqual([name(a), name(b)], names, variant + ': and so are the stream names');
  }
});

test('two Undos in a row of a payment by hand: both stick on the other device', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  b.change((s) => { addByHand(s, { name: 'Allotment rent', amount: 4000, dueDay: 3 }, '2026-11-14', NOW + 100); });
  await settle([b, a], NOW + 200);
  const id = b.state.recurring[0].id;
  correct(b, 'CAFE-1102', { purpose: 'work' }, { onlyThis: true, at: NOW + 1000 }); // any undoable change
  b.change((s) => { editByHand(s, id, { name: 'Garden plot' }, '2026-11-14', NOW + 2000); });
  await b.round(NOW + 3000);
  await a.round(NOW + 4000);
  assert.equal(a.state.recurring[0].name, 'Garden plot');
  b.undo(NOW + 5000);
  b.undo(NOW + 6000);
  await settle([b, a], NOW + 7000);
  assert.deepEqual([a.state.recurring[0].name, b.state.recurring[0].name], ['Allotment rent', 'Allotment rent']);
});

test('a changed rule that arrives does what learnRule did on the device that made it: the paychecks and the payday stay', async () => {
  for (const editor of ['a', 'b']) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
    await settle([a, b], NOW + 2000);
    correct(editor === 'a' ? a : b, 'BUY-0920', { category: 'shopping' }, { at: NOW + 4000 });
    await settle([a, b], NOW + 5000);
    assert.deepEqual([incomeRows(a), incomeRows(b)], [10, 10], editor + ' edits: both keep the paychecks');
    assert.deepEqual(picture(a), picture(b));
    const paydays = [clock(a.state, NOW + 9000).nextPayday, clock(b.state, NOW + 9000).nextPayday];
    assert.match(String(paydays[0]), /^\d{4}-\d{2}-\d{2}$/, editor + ' edits: a payday');
    assert.equal(paydays[1], paydays[0], editor + ' edits: the same payday');
  }
});

// An Undo's cells say so (`undo: true`): a device that takes an Undo of a rule's category lets go of the deposits that
// rule had filed, as for a removal, and classification and detection decide again from the rule put back.
test('Undo back to an earlier rule: both devices end the same, and again after a bank reading on each', async () => {
  const later = NOW + 7 * DAY_MS; // the next payday has been paid
  const next = [...ROWS, row('DEP-2026-11-20', 150000, '2026-11-20', PAYER)];
  for (const order of ['ab', 'ba']) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    const ds = order === 'ab' ? [a, b] : [b, a];
    correct(a, 'BUY-0920', { category: 'gifts' }, { at: NOW + 1000 });
    await settle(ds, NOW + 2000);
    const was = [picture(a), incomeRows(a)];
    assert.deepEqual([picture(b), incomeRows(b)], was, order + ': the devices agree before the income rule');
    correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 4000 });
    await settle(ds, NOW + 5000);
    assert.deepEqual([incomeRows(a), incomeRows(b)], [10, 10], order + ': the income rule files every deposit as income');
    a.undo(NOW + 7000);
    assert.deepEqual([picture(a), incomeRows(a)], was, order + ': A is back where it was');
    await settle(ds, NOW + 8000);
    assert.deepEqual([picture(b), incomeRows(b)], [picture(a), incomeRows(a)], order + ': B takes the Undo as A did');
    assert.equal(clock(b.state, NOW + 9000).nextPayday, clock(a.state, NOW + 9000).nextPayday, order + ': the same payday');
    a.read(next, later);
    b.read(next, later);
    await settle(ds, later + 1000);
    const income = (d) => d.state.txs.filter((tx) => tx.kind === 'income').reduce((sum, tx) => sum + tx.amount, 0);
    assert.deepEqual([picture(b), income(b)], [picture(a), income(a)], order + ': and after the next reading on each');
    assert.equal(clock(b.state, later + 9000).nextPayday, clock(a.state, later + 9000).nextPayday, order + ': the same payday then');
  }
});

test('with a clock a few minutes fast, an Undo never beats a later edit on another device', async () => {
  const SKEW = 3 * 60000; // A's clock runs 3 minutes fast
  for (const [first, later, read] of [
    [{ merchant: 'Fernleaf' }, { merchant: 'Fernleaf Kiosk' }, (tx) => tx.merchant],
    [{ purpose: 'work' }, { purpose: 'personal' }, (tx) => tx.purpose + (tx.locks.includes('purpose') ? ' locked' : '')],
  ]) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    correct(a, 'CAFE-1109', first, { at: NOW + SKEW });
    await a.round(NOW + SKEW + 1000);
    await b.round(NOW + 2000);
    correct(b, 'CAFE-1109', later, { at: NOW + 30000 }); // 30 s later, after B saw A's edit
    a.undo(NOW + SKEW + 40000);
    for (const [i, d] of [a, b, a, b].entries()) await d.round(NOW + (d === a ? SKEW : 0) + 50000 + i);
    const want = read({ ...b.row('CAFE-1109'), ...later, locks: Object.keys(later) });
    assert.deepEqual([read(a.row('CAFE-1109')), read(b.row('CAFE-1109'))], [want, want], JSON.stringify(later) + ' wins on both');
  }
});

test('an Undo reaches a row another device re-keyed first (a pending row that posted)', async () => {
  const repo = repoOf();
  const pending = { extId: 'PEND-9', amount: -4200, posted: null, at: dateOnly('2026-11-12'), pending: true, description: 'WRENFOLD BISTRO', payee: '', memo: '', mcc: null };
  const posted = row('POST-9', -5040, '2026-11-13', 'WRENFOLD BISTRO'); // with the tip
  const a = device(repo, [...ROWS, pending]);
  const b = device(repo, [...ROWS, pending]);
  correct(a, 'PEND-9', { purpose: 'work', klass: 'need' }, { onlyThis: true, at: NOW + 1000 });
  await settle([a, b], NOW + 2000);
  assert.equal(b.row('PEND-9').purpose, 'work');
  b.read([...ROWS, posted], NOW + 3000); // B reads the posted row first
  assert.equal(b.row('POST-9').purpose, 'work');
  await b.round(NOW + 4000);
  a.undo(NOW + 5000);
  await settle([a, b], NOW + 6000);
  a.read([...ROWS, posted], NOW + 7000);
  await settle([a, b], NOW + 8000);
  for (const d of [a, b]) {
    const tx = d.row('POST-9');
    assert.notEqual(tx.purpose, 'work', 'the correction is gone');
    assert.deepEqual(tx.locks.filter((f) => f === 'purpose' || f === 'klass'), []);
  }
});

test('a stream’s settings follow an account the bank gave a new id', async () => {
  const repo = repoOf();
  const a = device(repo);
  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
  setStream(a, { name: 'Workshop pay', cadence: 'semimonthly', accrue: false }, NOW + 2000);
  await a.round(NOW + 3000);
  a.account = 'ACT-CHK-7-NEW';
  a.read(ROWS, NOW + 4000); // the bank reconnected: the same account under a new provider id
  assert.equal(a.state.accounts.length, 1, 'still one account');
  await a.round(NOW + 5000);
  const c = device(repo, ROWS, 'ACT-CHK-7-NEW'); // a device that only ever saw the new id
  await settle([c, a], NOW + 6000);
  const s = c.stream();
  assert.deepEqual([s.name, s.cadence, s.accrue], ['Workshop pay', 'semimonthly', false]);
  assert.deepEqual(['accrue', 'cadence', 'name'].filter((f) => s.locks.includes(f)), ['accrue', 'cadence', 'name']);
  assert.equal(clock(c.state, NOW + 9000).nextPayday, clock(a.state, NOW + 9000).nextPayday);
});

/* ------------------------------------------- what arrives, per field; edits and Undos */

test('a round that brings another field of the same merchant before an Undo: the Undo still takes the owner’s field back', async () => {
  for (const order of ['B first', 'A first']) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    const was = a.row('CAFE-1109').merchant;
    correct(a, 'CAFE-1109', { merchant: 'Fernleaf' }, { at: NOW + 1000 });
    correct(b, 'CAFE-1102', { category: 'groceries' }, { at: NOW + 1100 }); // another field of the same rule
    if (order === 'B first') { await b.round(NOW + 1200); await a.round(NOW + 1300); }
    else { await a.round(NOW + 1200); await b.round(NOW + 1300); await a.round(NOW + 1400); }
    a.undo(NOW + 2000);
    assert.equal(a.row('CAFE-1109').merchant, was, order + ': right after the Undo, A shows the name it had');
    assert.equal(a.row('CAFE-1109').category, 'groceries', order + ': and keeps what arrived');
    await settle([a, b], NOW + 3000);
    for (const d of [a, b]) {
      assert.deepEqual([d.row('CAFE-1109').merchant, d.row('CAFE-1102').category, d.row('CAFE-1109').category], [was, 'groceries', 'groceries'], order);
    }
  }
});

test('a third device’s first round brings an old rule of the same merchant before an Undo: the Undo still holds everywhere', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  await settle([a, b], NOW + 500);
  const c = device(repo);
  learnRule(c.state, c.row('CAFE-1102').id, { category: 'groceries' }); // on C, before this version
  refresh(c.state, NOW);
  const was = a.row('CAFE-1109').merchant;
  correct(a, 'CAFE-1109', { merchant: 'Fernleaf' }, { at: NOW + 1000 });
  await c.round(NOW + 1200); // C's first round: its old rule, stamped 0
  await a.round(NOW + 1300);
  a.undo(NOW + 2000);
  assert.equal(a.row('CAFE-1109').merchant, was, 'right after the Undo');
  await settle([a, b, c], NOW + 3000);
  for (const d of [a, b, c]) assert.deepEqual([d.row('CAFE-1109').merchant, d.row('CAFE-1109').category], [was, 'groceries']);
});

test('one row: another device locks another field of it before an Undo; the Undo takes back only the owner’s field', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  const was = a.row('CAFE-1102').purpose;
  correct(a, 'CAFE-1102', { purpose: 'work' }, { onlyThis: true, at: NOW + 1000 });
  correct(b, 'CAFE-1102', { category: 'gifts' }, { onlyThis: true, at: NOW + 1100 });
  await b.round(NOW + 1200);
  await a.round(NOW + 1300);
  a.undo(NOW + 2000);
  assert.deepEqual([a.row('CAFE-1102').purpose, a.row('CAFE-1102').locks.includes('purpose')], [was, false], 'right after the Undo');
  await settle([a, b], NOW + 3000);
  for (const d of [a, b]) {
    const tx = d.row('CAFE-1102');
    assert.deepEqual([tx.purpose, tx.category, tx.locks.filter((f) => f !== 'review').sort()], [was, 'gifts', ['category']]);
  }
});

test('two Undos in a row on a device whose clock runs fast, then an edit on another device with the same stamp: the edit wins', async () => {
  const SKEW = 3 * 60000;
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  const c = device(repo);
  correct(a, 'CAFE-1109', { merchant: 'Fernleaf' }, { at: NOW + SKEW });
  correct(a, 'CAFE-1109', { merchant: 'Fernleaf Kiosk' }, { at: NOW + SKEW + 1000 });
  await a.round(NOW + SKEW + 2000);
  await b.round(NOW + 3000);
  a.undo(NOW + SKEW + 4000);
  a.undo(NOW + SKEW + 5000);
  correct(b, 'CAFE-1109', { merchant: 'Fernleaf Nook' }, { at: NOW + 30000 }); // after both Undos, in real time
  const merchant = payeeKey(a.row('CAFE-1109').mkey) + ':out'; // a purchase teaches the merchant's money-out rule (3.3)
  assert.equal(exportCorrections(b.state).rules[merchant].merchant.at, exportCorrections(a.state).rules[merchant].merchant.at, 'the stamps tie');
  await settle([a, b, c], NOW + SKEW + 6000);
  for (const d of [a, b, c]) assert.equal(d.row('CAFE-1109').merchant, 'Fernleaf Nook');
  const laws = [{ merchant: { v: 'Fernleaf Nook', at: 9 } }, { merchant: { deleted: true, at: 9, undo: true } }, { merchant: { v: 'Fernleaf', at: 9, undo: true } }];
  for (const x of laws) {
    for (const y of laws) {
      const m = mergeCorrections({ rules: { [merchant]: x } }, { rules: { [merchant]: y } });
      assert.equal(canon(m), canon(mergeCorrections({ rules: { [merchant]: y } }, { rules: { [merchant]: x } })), 'commutative');
      if (x === laws[0] || y === laws[0]) assert.deepEqual(m.rules[merchant], laws[0], 'an edit beats an Undo on the same stamp');
    }
  }
});

/* --------------------------------------------- the same payer corrected on two devices */

test('the same payer corrected on two devices before a round: the row correction is never refused, every device ends with the same income', async () => {
  for (const [first, second, order] of [['b', 'c', 'abc'], ['c', 'b', 'cba']]) {
    const repo = repoOf();
    const ds = { a: device(repo), b: device(repo), c: device(repo) };
    correct(ds[first], 'DEP-2026-10-23', { category: 'shopping' }, { at: NOW + 1000 }); // a refund of a purchase, for all
    correct(ds[second], 'DEP-2026-07-03', { category: 'income' }, { at: NOW + 2000 }); // a moment later, before any round
    await settle([...order].map((n) => ds[n]), NOW + 3000);
    const income = (d) => d.state.txs.filter((tx) => tx.kind === 'income').reduce((sum, tx) => sum + tx.amount, 0);
    for (const d of Object.values(ds)) {
      const tx = d.row('DEP-2026-10-23');
      assert.deepEqual([tx.kind, tx.category, tx.locks.includes('category'), tx.streamId == null], ['refund', 'shopping', true, true], order + ': the row keeps its correction');
      assert.equal(d.state.settings.rules[0].category, 'income', order + ': the later rule');
      assert.deepEqual([picture(d), income(d), clock(d.state, NOW + 9000).nextPayday], [picture(ds.a), income(ds.a), clock(ds.a.state, NOW + 9000).nextPayday], order);
    }
  }
});

test('an income rule on one device and a later rule of the same payer on another, before a round: every device ends with the same income', async () => {
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b, c] = ds;
  correct(a, 'DEP-2026-10-09', { category: 'gifts' }, { at: NOW + 1000 });
  await settle(ds, NOW + 2000);
  correct(b, 'DEP-2026-09-11', { category: 'income', merchant: 'Brambles' }, { at: NOW + 3000 });
  correct(c, 'DEP-2026-11-06', { category: 'other' }, { at: NOW + 4000 });
  await settle(ds, NOW + 5000);
  for (const d of ds) refresh(d.state, NOW + 6000); // as the next reading does
  const income = (d) => d.state.txs.filter((tx) => tx.kind === 'income').reduce((sum, tx) => sum + tx.amount, 0);
  for (const d of ds) {
    assert.deepEqual([picture(d), income(d), clock(d.state, NOW + 9000).nextPayday], [picture(a), income(a), clock(a.state, NOW + 9000).nextPayday]);
  }
});

/* ------------------------------------------------------- payments by hand: the stamps */

test('a payment by hand: an edit, a tick and a skip stamp above the stamp they replace, so a later edit wins against a fast clock', async () => {
  const SKEW = 3 * 60000; // A's clock runs 3 minutes fast
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  b.change((s) => { addByHand(s, { name: 'Allotment rent', amount: 4000, dueDay: 3 }, '2026-11-14', NOW + 100); });
  await settle([b, a], NOW + 200);
  const id = b.state.recurring[0].id;
  a.change((s) => { editByHand(s, id, { amount: 4500 }, '2026-11-14', NOW + SKEW); });
  a.change((s) => { tickByHand(s, id, '2026-11-03', true, NOW + SKEW); });
  await settle([a, b], NOW + 1000);
  b.change((s) => { editByHand(s, id, { name: 'Garden plot' }, '2026-11-14', NOW + 30000); }); // 30 s later, in real time
  b.change((s) => { tickByHand(s, id, '2026-11-03', false, NOW + 30000); });
  assert.equal(b.state.recurring[0].editedAt, NOW + SKEW + 1, '1 above the stamp it replaces');
  assert.equal(b.state.recurring[0].marks['2026-11-03'].at, NOW + SKEW + 1);
  await settle([b, a], NOW + 40000);
  for (const d of [a, b]) {
    const entry = d.state.recurring[0];
    assert.deepEqual([entry.name, entry.amount, entry.marks['2026-11-03'].paid], ['Garden plot', 4500, false]);
  }
  // a skip, and the payee it lets go of, likewise
  const s = { txs: [{ id: 't1', day: '2026-11-03', mkey: 'allotment society', amount: -4000, flow: 'out' }], accounts: [],
    recurring: [{ ...b.state.recurring[0], payee: payeeKey('allotment society'), payeeAt: NOW + SKEW, skips: { ['2026-11-03|' + payeeKey('allotment society')]: { on: false, at: NOW + SKEW } } }] };
  assert.equal(skipRow(s, id, 't1', NOW), true);
  assert.equal(s.recurring[0].skips['2026-11-03|' + payeeKey('allotment society')].at, NOW + SKEW + 1);
  assert.equal(s.recurring[0].payeeAt, NOW + SKEW + 1);
});

test('an Undo after this device’s own reading posted the corrected pending row: the correction is gone on every device', async () => {
  const repo = repoOf();
  const pending = { extId: 'PEND-5', amount: -4200, posted: null, at: dateOnly('2026-11-12'), pending: true, description: 'WRENFOLD BISTRO', payee: '', memo: '', mcc: null };
  const posted = row('POST-5', -5040, '2026-11-13', 'WRENFOLD BISTRO'); // with the tip
  const a = device(repo, [...ROWS, pending]);
  const b = device(repo, [...ROWS, pending]);
  const was = [a.row('PEND-5').purpose, a.row('PEND-5').klass];
  correct(a, 'PEND-5', { purpose: 'work', klass: 'need' }, { onlyThis: true, at: NOW + 1000 });
  await settle([a, b], NOW + 2000);
  a.read([...ROWS, posted], NOW + 3000); // A's own reading posts it: A writes it under its new key
  assert.equal(a.row('POST-5').purpose, 'work');
  await settle([a, b], NOW + 4000);
  a.undo(NOW + 5000);
  await settle([a, b], NOW + 6000);
  a.read([...ROWS, posted], NOW + 7000);
  b.read([...ROWS, posted], NOW + 7000);
  await settle([a, b], NOW + 8000);
  for (const d of [a, b]) {
    const tx = d.row('POST-5');
    assert.deepEqual([tx.purpose, tx.klass, tx.locks.filter((f) => f === 'purpose' || f === 'klass')], [...was, []]);
  }
});

test('a stream setting edited under the old account id, on a device that has not read the new id yet, reaches every device', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
  await settle([a, b], NOW + 2000);
  setStream(a, { name: 'Workshop pay', cadence: 'biweekly' }, NOW + 3000);
  await settle([a, b], NOW + 4000);
  a.account = 'ACT-CHK-7-NEW';
  a.read(ROWS, NOW + 5000); // the bank reconnected on A: the same account under a new provider id
  await settle([a, b], NOW + 6000);
  setStream(b, { name: 'Day pay' }, NOW + 60000); // B has not read the bank since
  await settle([a, b], NOW + 61000);
  b.account = 'ACT-CHK-7-NEW';
  b.read(ROWS, NOW + 62000);
  await settle([a, b], NOW + 63000);
  const c = device(repo, ROWS, 'ACT-CHK-7-NEW'); // a device that only ever saw the new id
  await settle([c, a, b], NOW + 64000);
  for (const d of [a, b, c]) {
    assert.deepEqual([d.stream().name, d.stream().cadence, d.stream().locks.includes('name')], ['Day pay', 'biweekly', true]);
  }
});

test('Undo of income for all, filed on a paycheck that was already linked, under another device’s rule: both devices end the same', async () => {
  for (const order of ['ab', 'ba']) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    const ds = order === 'ab' ? [a, b] : [b, a];
    correct(b, 'DEP-2026-10-23', { category: 'gifts' }, { at: NOW + 1000 });
    await settle(ds, NOW + 2000);
    const was = [picture(a), incomeRows(a)];
    assert.equal(a.row('DEP-2026-08-14').streamId != null, true, 'an early paycheck, linked before any rule');
    correct(a, 'DEP-2026-08-14', { category: 'income' }, { at: NOW + 3000 });
    await settle(ds, NOW + 4000);
    a.undo(NOW + 5000);
    await settle(ds, NOW + 6000);
    assert.deepEqual([picture(a), incomeRows(a)], was, order + ': A is back where it was');
    assert.deepEqual([picture(b), incomeRows(b)], was, order + ': and B with it');
  }
});

test('two devices file the same payer for the first time before a round, income on one and a purchase category on the other: the same income everywhere', async () => {
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b] = ds;
  correct(b, 'DEP-2026-09-11', { category: 'income', merchant: 'Brambles' }, { at: NOW + 1000 });
  correct(a, 'BUY-0920', { category: 'shopping' }, { at: NOW + 2000 }); // later, before any round, over no rule
  await settle(ds, NOW + 3000);
  for (const d of ds) refresh(d.state, NOW + 4000);
  const income = (d) => d.state.txs.filter((tx) => tx.kind === 'income').reduce((sum, tx) => sum + tx.amount, 0);
  for (const d of ds) {
    assert.deepEqual([picture(d), income(d), clock(d.state, NOW + 9000).nextPayday], [picture(a), income(a), clock(a.state, NOW + 9000).nextPayday]);
  }
});

/* ------------------------------------- two changes of one payer's rule, with no round between */

const incomeTotal = (d) => d.state.txs.filter((tx) => tx.kind === 'income').reduce((sum, tx) => sum + tx.amount, 0);
const linked = (d) => d.state.txs.filter((tx) => tx.streamId != null).map((tx) => tx.ext.id).sort();
/** What must be the same on every device: the rows and rules, the income, which rows are linked, the payday. */
const outcome = (d, at) => [picture(d), incomeTotal(d), linked(d), clock(d.state, at).nextPayday];

/** Round every device until they settle, then one more pass: nothing is applied or written. */
async function settleQuiet(devices, from) {
  const at = await settle(devices, from);
  for (const d of devices) {
    const res = await d.round(at + 1);
    assert.deepEqual([res.changed, res.wrote], [false, false], 'the file is no longer written');
  }
  return at + 2;
}

test('two changes of one payer’s rule on one device with no round between: every device ends with the same income, links and payday', async () => {
  for (const between of [false, true]) {
    for (const second of ['shopping', 'eating_out']) {
      const label = (between ? 'the editor rounds between' : 'no round between') + ', then ' + second;
      const repo = repoOf();
      const ds = [device(repo), device(repo), device(repo)];
      const [a, b, c] = ds;
      await settle(ds, NOW + 100);
      correct(b, 'DEP-2026-07-03', { category: 'income' }, { at: NOW + 1000 });
      if (between) await b.round(NOW + 1500);
      correct(b, 'BUY-0920', { category: second }, { at: NOW + 2000 }); // the purchase from the same payer, for all
      assert.equal(incomeRows(b), 10, label + ': B keeps the paychecks it had linked');
      let at = await settle([b, a, c], NOW + 3000);
      for (const d of ds) d.read(ROWS, NOW + 4000); // the next reading on each
      at = await settleQuiet(ds, Math.max(at, NOW + 5000));
      for (const d of ds) {
        assert.deepEqual(outcome(d, NOW + 9000), outcome(b, NOW + 9000), label);
        assert.equal(incomeRows(d), 10, label + ': every paycheck is income');
      }
      assert.match(String(clock(a.state, NOW + 9000).nextPayday), /^\d{4}-\d{2}-\d{2}$/, label + ': a payday');
      // each direction holds its own rule (3.3): the purchase taught money out, the paycheck money in
      assert.equal(a.state.settings.rules.find((r) => r.flow === 'out').category, second, label + ': the money-out rule is the later one');
      assert.equal(a.state.settings.rules.find((r) => r.flow === 'in').category, 'income', label + ': the money-in rule stays');
    }
  }
});

test('the payer’s rule changed on a second device after a round, a third device closed throughout: the same income everywhere', async () => {
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b, c] = ds;
  await settle(ds, NOW + 100);
  correct(a, 'DEP-2026-07-03', { category: 'income' }, { at: NOW + 1000 });
  await a.round(NOW + 1100);
  await b.round(NOW + 1200);
  correct(b, 'BUY-0920', { category: 'shopping' }, { at: NOW + 2000 });
  await b.round(NOW + 2100);
  await a.round(NOW + 2200);
  await c.round(NOW + 2300); // C opens for the first time since
  for (const d of ds) d.read(ROWS, NOW + 4000);
  await settleQuiet(ds, NOW + 5000);
  for (const d of ds) {
    assert.deepEqual(outcome(d, NOW + 9000), outcome(b, NOW + 9000));
    assert.equal(incomeRows(d), 10);
  }
});

test('the two changes in the other order (the purchase first, then the paycheck): the same income everywhere', async () => {
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b, c] = ds;
  await settle(ds, NOW + 100);
  correct(b, 'BUY-0920', { category: 'shopping' }, { at: NOW + 1000 });
  correct(b, 'DEP-2026-07-03', { category: 'income' }, { at: NOW + 2000 });
  await settle([b, c, a], NOW + 3000);
  for (const d of ds) d.read(ROWS, NOW + 4000);
  await settleQuiet(ds, NOW + 5000);
  for (const d of ds) {
    assert.deepEqual(outcome(d, NOW + 9000), outcome(b, NOW + 9000));
    assert.equal(incomeRows(d), 10);
  }
});

test('after the two changes, a later paycheck follows the money-in rule on every device: income, linked, the same payday', async () => {
  const later = NOW + 7 * DAY_MS;
  const next = [...ROWS, row('DEP-2026-11-20', 150000, '2026-11-20', PAYER)];
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b, c] = ds;
  await settle(ds, NOW + 100);
  correct(b, 'DEP-2026-07-03', { category: 'income' }, { at: NOW + 1000 });
  correct(b, 'BUY-0920', { category: 'shopping' }, { at: NOW + 2000 });
  await settle([b, a, c], NOW + 3000);
  for (const d of ds) d.read(next, later);
  await settleQuiet(ds, later + 1000);
  const fresh = (d) => { const tx = d.row('DEP-2026-11-20'); return [tx.kind, tx.category, tx.streamId != null]; };
  for (const d of ds) {
    assert.deepEqual([outcome(d, later + 9000), fresh(d)], [outcome(b, later + 9000), fresh(b)]);
  }
  // the purchase rule covers money out only (3.3): the paycheck is income and linked, as the owner filed money in
  assert.deepEqual(fresh(b), ['income', 'income', true], 'the new deposit follows the money-in rule');
});

test('one Undo takes back the whole correction: the rule and the paychecks it kept, on every device', async () => {
  for (const between of [true, false]) {
    const label = between ? 'every device rounds between' : 'no round between';
    const repo = repoOf();
    const ds = [device(repo), device(repo), device(repo)];
    const [a, b, c] = ds;
    await settle(ds, NOW + 100);
    correct(b, 'DEP-2026-07-03', { category: 'income' }, { at: NOW + 1000 });
    if (between) await settle([b, a, c], NOW + 1100);
    const was = outcome(b, NOW + 9000);
    correct(b, 'BUY-0920', { category: 'shopping' }, { at: NOW + 2000 });
    // the purchase rule covers money out only (3.3): it holds no paycheck, so none is locked or written
    const kept = b.state.txs.filter((tx) => tx.mkey === b.row('DEP-2026-07-03').mkey && tx.streamId != null && tx.locks.includes('category'));
    assert.deepEqual(kept.map((tx) => tx.ext.id), ['DEP-2026-07-03'], label + ': only the paycheck the owner corrected is locked');
    await settle([b, a, c], NOW + 3000);
    assert.equal(a.row('DEP-2026-10-23').locks.includes('category'), false, label + ': and no row correction reaches the other devices for the others');
    assert.equal(a.row('BUY-0920').category, 'shopping', label + ': the purchase rule reached them');
    b.undo(NOW + 4000);
    assert.deepEqual(outcome(b, NOW + 9000), was, label + ': B is back where it was');
    await settleQuiet([b, a, c], NOW + 5000);
    for (const d of ds) assert.deepEqual(outcome(d, NOW + 9000), was, label + ': every device is back where B is');
  }
});

/* ---------------------------------------------- the 400-day line, the same whatever the clock */

test('the 400-day line is drawn from the file, never from a device’s clock: two clocks on either side of midnight UTC agree, and the file goes quiet', async () => {
  const beforeMidnight = Date.UTC(2026, 10, 14, 23, 58); // B
  const afterMidnight = Date.UTC(2026, 10, 15, 0, 4); // A, its clock a few minutes fast
  const results = [];
  for (const [clockA, clockB] of [[afterMidnight, beforeMidnight], [beforeMidnight, afterMidnight]]) {
    const repo = repoOf();
    const edge = row('OLD-EDGE', -3300, '2025-10-10', 'WRENFOLD BISTRO'); // 400 days before 14 November, 399 before the 15th... by a clock
    const gone = row('OLD-GONE', -2100, '2025-10-04', 'WRENFOLD BISTRO'); // 401 days before the newest corrected row
    const a = device(repo, [...ROWS, edge, gone]);
    const b = device(repo, [...ROWS, edge, gone]);
    for (const extId of ['OLD-EDGE', 'OLD-GONE']) learnRule(b.state, b.row(extId).id, { merchant: 'Old dinner' }, { onlyThis: true }); // before this version
    refresh(b.state, NOW);
    correct(a, 'CAFE-1109', { merchant: 'Fernleaf' }, { onlyThis: true, at: clockA }); // the newest corrected row: 9 November
    let moved = true;
    for (let pass = 0; pass < 6 && moved; pass++) {
      moved = false;
      for (const [d, at] of [[a, clockA], [b, clockB]]) {
        const res = await d.round(at + pass * 15000);
        if (res.changed || res.wrote) moved = true;
      }
    }
    assert.equal(moved, false, 'the devices settle: neither writes again');
    const days = Object.values(readSharedFile(repo.text).corrections.moves).map((m) => m.day).sort();
    assert.deepEqual(days, ['2025-10-10', '2026-11-09'], 'the row 400 days before the newest corrected row stays, the one 401 days before goes');
    assert.deepEqual(exportCorrections(a.state), exportCorrections(b.state), 'both devices hold the same copy');
    results.push(repo.text && readSharedFile(repo.text).corrections);
  }
  assert.deepEqual(Object.keys(results[0].moves), Object.keys(results[1].moves), 'and which clock is ahead changes nothing');
});

test('a changed rule that arrives locks and releases nothing by itself, an edit’s as a seed’s: only the owner’s own edit makes its held rows explicit', async () => {
  for (const seed of [false, true]) {
    const repo = repoOf();
    const a = device(repo);
    const b = device(repo);
    correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
    await settle([a, b], NOW + 2000);
    const locked = (d) => d.state.txs.filter((tx) => (tx.locks || []).includes('category')).map((tx) => tx.ext.id).sort();
    const before = [locked(b), Object.keys(exportCorrections(b.state).moves).sort()];
    // the rule's category as another device's later edit would bring it, with no row entry beside it; or as a seed (0)
    const copy = exportCorrections(b.state);
    const key = Object.keys(copy.rules)[0];
    const cell = copy.rules[key].category;
    copy.rules[key] = { ...copy.rules[key], category: seed ? { v: 'shopping', at: 0 } : { v: 'shopping', at: cell.at + 2, over: cell.at } };
    b.state.share.corrections = copy;
    applyCorrections(b.state, NOW + 3000);
    refresh(b.state, NOW + 3000);
    assert.equal(b.state.settings.rules[0].category, 'shopping', 'the rule arrived');
    assert.deepEqual([locked(b), Object.keys(exportCorrections(b.state).moves).sort()], before, 'no row was locked or written on arrival');
    // an arriving rule lets no link go (as learnRule leaves a linked deposit on the device that made the edit): what a
    // device that held a newer deposit linked does with it is the known limit of 3.8
    assert.equal(incomeRows(b), 10, (seed ? 'a seed' : 'an edit') + ': the linked paychecks keep their kind, as learnRule leaves them');
  }
});
