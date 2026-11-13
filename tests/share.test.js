/**
 * Sharing the payments the owner sends between their devices: the file, the merge, the transport and
 * a played scene with three devices and one repository. Every payment, payee, amount and key here is
 * invented, the repository is an in-memory fake, and no request leaves this process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDoc, defaultState, makeAccount, makeRecurring, makeTx } from '../js/model/schema.js';
import { refresh } from '../js/model/detect.js';
import { addByHand, editByHand, payeeKey, removeByHand, restampByHand, tickByHand } from '../js/model/byhand.js';
import { applyShared, exportShared, mergeShared, readSharedFile, roundShared, sameShared, sharedChanges } from '../js/model/share.js';
import {
  ShareError, fromBase64, isShareKey, readSharedText, shareMessage, shareOwner, sharedUrl, toBase64, writeSharedText,
} from '../js/github.js';

/* ------------------------------------------------------------------ fixtures */

const HOUR_MS = 3600000;
const MIN_MS = 60000;

function at(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour).getTime();
}

/** Tuesday 10 November 2026, noon. */
const NOW = at(2026, 11, 10);
const TODAY = '2026-11-10';
const OWNER = 'someone';
const KEY = 'invented_key_for_tests_0123456789';
const ZELLE = 'Zelle payment to R Lindqvist';
const ZELLE_KEY = payeeKey('zelle to r lindqvist');
const P1 = 'p0000000000001';
const P2 = 'p0000000000002';

function newState() {
  const state = defaultState(NOW);
  state.accounts.push(makeAccount({ id: 'acc_checking', type: 'checking', name: 'Everyday Checking', balance: 412300, source: 'bank', basis: 'bank', asOf: NOW - HOUR_MS }));
  return state;
}

function flat(extra = {}) {
  return { name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01', active: true, editedAt: 100, deleted: false,
    payee: null, payeeAt: 0, marks: {}, skips: {}, ...extra };
}

function parking(extra = {}) {
  return { name: 'Parking', amount: 8500, dueDay: 31, since: '2026-11-01', active: true, editedAt: 100, deleted: false,
    payee: null, payeeAt: 0, marks: {}, skips: {}, ...extra };
}

function file(byHand, extra = {}) {
  return { v: 1, app: 'networth', savedAt: 0, byHand, ...extra };
}

function byHandOf(state) {
  return state.recurring.filter((entry) => entry.byHand);
}

function names(state) {
  return byHandOf(state).map((entry) => entry.name).sort();
}

/* ------------------------------------------------------------------ merging */

test('mergeShared: an entry only one side has is kept as it is, and unknown sections of either side stay', () => {
  const a = file({ one: flat() }, { later: { x: 1 } });
  const b = file({ two: parking() }, { other: [1, 2] });
  const m = mergeShared(a, b);
  assert.deepEqual(m.byHand.one, flat());
  assert.deepEqual(m.byHand.two, parking());
  assert.deepEqual(m.later, { x: 1 });
  assert.deepEqual(m.other, [1, 2]);
});

test('mergeShared: the definition comes whole from the side edited last; a tie goes to the removal, then to the smaller text', () => {
  const older = flat({ name: 'Flat share', amount: 25000, dueDay: 5, editedAt: 100 });
  const newer = flat({ name: 'Flat', amount: 26000, dueDay: 6, since: '2026-12-01', active: false, editedAt: 200 });
  for (const m of [mergeShared(file({ x: older }), file({ x: newer })), mergeShared(file({ x: newer }), file({ x: older }))]) {
    assert.deepEqual([m.byHand.x.name, m.byHand.x.amount, m.byHand.x.dueDay, m.byHand.x.since, m.byHand.x.active, m.byHand.x.editedAt],
      ['Flat', 26000, 6, '2026-12-01', false, 200]);
  }
  // clocks that disagree: a device whose clock runs behind loses, whatever it changed, and never half of it
  const tomb = { deleted: true, editedAt: 100 };
  const tie = mergeShared(file({ x: older }), file({ x: tomb }));
  assert.deepEqual(tie.byHand.x, { deleted: true, editedAt: 100 });
  assert.deepEqual(mergeShared(file({ x: tomb }), file({ x: older })).byHand.x, { deleted: true, editedAt: 100 });
  const p = flat({ name: 'Alpha' });
  const q = flat({ name: 'Beta' });
  assert.equal(mergeShared(file({ x: p }), file({ x: q })).byHand.x.name, mergeShared(file({ x: q }), file({ x: p })).byHand.x.name);
  // a removal is beaten by a later edit (an Undo of the removal on the device that made it)
  assert.equal(mergeShared(file({ x: tomb }), file({ x: flat({ editedAt: 300 }) })).byHand.x.deleted, false);
});

test('mergeShared: the payee from the side that set it last; a tie goes to the one that has one, then the smaller', () => {
  const m1 = mergeShared(file({ x: flat({ payee: P1, payeeAt: 50 }) }), file({ x: flat({ payee: null, payeeAt: 60 }) }));
  assert.deepEqual([m1.byHand.x.payee, m1.byHand.x.payeeAt], [null, 60]);
  const m2 = mergeShared(file({ x: flat({ payee: null, payeeAt: 50 }) }), file({ x: flat({ payee: P2, payeeAt: 50 }) }));
  assert.deepEqual([m2.byHand.x.payee, m2.byHand.x.payeeAt], [P2, 50]);
  const m3 = mergeShared(file({ x: flat({ payee: P2, payeeAt: 50 }) }), file({ x: flat({ payee: P1, payeeAt: 50 }) }));
  assert.equal(m3.byHand.x.payee, P1);
  // the payee travels apart from the definition: the older definition's side may hold the newer payee
  const m4 = mergeShared(file({ x: flat({ editedAt: 100, payee: P1, payeeAt: 900 }) }), file({ x: flat({ name: 'Flat', editedAt: 200 }) }));
  assert.deepEqual([m4.byHand.x.name, m4.byHand.x.payee], ['Flat', P1]);
});

test('mergeShared: each tick and each skip from the side that made it last; a tie goes to paid, and to on', () => {
  const a = flat({ marks: { '2026-11-05': { paid: true, at: 10 }, '2026-12-05': { paid: true, at: 30 } },
    skips: { ['2026-11-04|' + P1]: { on: true, at: 10 } } });
  const b = flat({ marks: { '2026-11-05': { paid: false, at: 20 }, '2026-12-05': { paid: false, at: 30 }, '2027-01-05': { paid: true, at: 5 } },
    skips: { ['2026-11-04|' + P1]: { on: false, at: 10 }, ['2026-11-09|' + P2]: { on: false, at: 40 } } });
  for (const m of [mergeShared(file({ x: a }), file({ x: b })), mergeShared(file({ x: b }), file({ x: a }))]) {
    assert.deepEqual(m.byHand.x.marks, { '2026-11-05': { paid: false, at: 20 }, '2026-12-05': { paid: true, at: 30 }, '2027-01-05': { paid: true, at: 5 } });
    assert.deepEqual(m.byHand.x.skips, { ['2026-11-04|' + P1]: { on: true, at: 10 }, ['2026-11-09|' + P2]: { on: false, at: 40 } });
  }
});

test('mergeShared: the same content whichever side is first, merging twice changes nothing, any grouping of three', () => {
  const variants = [
    file({}),
    file({ x: flat() }),
    file({ x: flat({ name: 'Flat', editedAt: 100 }) }),
    file({ x: flat({ amount: 26000, editedAt: 300, payee: P1, payeeAt: 7, marks: { '2026-11-05': { paid: true, at: 9 } } }) }),
    file({ x: { deleted: true, editedAt: 300 }, y: parking() }),
    file({ x: { deleted: true, editedAt: 100 }, y: parking({ active: false, editedAt: 100 }) }),
    file({ x: flat({ payee: P2, payeeAt: 7, marks: { '2026-11-05': { paid: false, at: 9 } }, skips: { ['2026-11-04|' + P1]: { on: true, at: 3 } } }) }, { later: { n: 1 } }),
    file({ y: parking({ editedAt: 50, marks: { '2026-11-30': { paid: true, at: 2 } } }), z: flat({ name: 'Zeta' }) }, { later: { n: 2 } }),
  ];
  for (const a of variants) {
    assert.ok(sameShared(mergeShared(a, a), a), 'merging a file with itself');
    for (const b of variants) {
      const ab = mergeShared(a, b);
      assert.ok(sameShared(ab, mergeShared(b, a)), 'either side first');
      assert.ok(sameShared(mergeShared(ab, b), ab), 'merging again');
      assert.ok(sameShared(mergeShared(a, ab), ab), 'merging again, the other way');
      assert.ok(readSharedFile(JSON.stringify(ab)), 'a merged file is a file');
      for (const c of variants) {
        assert.ok(sameShared(mergeShared(ab, c), mergeShared(a, mergeShared(b, c))), 'any grouping of three');
      }
    }
  }
});

test('mergeShared: a removal keeps the ticks another side made, so a payment put back by Undo has them', () => {
  const ticked = flat({ editedAt: 100, marks: { '2026-11-05': { paid: true, at: 150 } } });
  const m = mergeShared(file({ x: { deleted: true, editedAt: 200 } }), file({ x: ticked }));
  assert.equal(m.byHand.x.deleted, true);
  const back = mergeShared(m, file({ x: flat({ editedAt: 300 }) }));
  assert.deepEqual(back.byHand.x.marks, { '2026-11-05': { paid: true, at: 150 } });
});

test('sameShared: the order of the keys and the time of saving do not count; any content does', () => {
  const a = { v: 1, app: 'networth', savedAt: 5, byHand: { x: flat(), y: parking() } };
  const b = { byHand: { y: parking(), x: { ...flat() } }, savedAt: 99, app: 'networth', v: 1 };
  assert.equal(sameShared(a, b), true);
  assert.equal(sameShared(a, file({ x: flat(), y: parking({ amount: 8501 }) })), false);
  assert.equal(sameShared(a, file({ x: flat() })), false);
});

/* ------------------------------------------------------------------ reading */

test('readSharedFile: a good file is read, and what it returns holds only checked values', () => {
  const text = JSON.stringify(file({ rc_one: flat({ payee: P1, payeeAt: 9, marks: { '2026-11-05': { paid: true, at: 8, more: 'x' } } }) }, { savedAt: 77 }));
  const got = readSharedFile(text);
  assert.deepEqual(got.byHand.rc_one.marks, { '2026-11-05': { paid: true, at: 8 } });
  assert.equal(got.savedAt, 77);
  assert.deepEqual(readSharedFile(JSON.stringify(file({ gone: { deleted: true, editedAt: 5 } }))).byHand.gone, { deleted: true, editedAt: 5 });
});

test('readSharedFile: anything that is not a sane version-1 file is refused', () => {
  const bad = (byHand, extra) => readSharedFile(JSON.stringify(file(byHand, extra)));
  assert.equal(readSharedFile('not json'), null);
  assert.equal(readSharedFile(''), null);
  assert.equal(readSharedFile(null), null);
  assert.equal(readSharedFile('[]'), null);
  assert.equal(readSharedFile('null'), null);
  assert.equal(bad({}, { v: 2 }), null);
  assert.equal(bad({}, { app: 'other' }), null);
  assert.equal(bad([]), null);
  assert.equal(bad({ x: flat({ name: '' }) }), null);
  assert.equal(bad({ x: flat({ name: ' Flat ' }) }), null);
  assert.equal(bad({ x: flat({ name: 'n'.repeat(61) }) }), null);
  assert.equal(bad({ x: flat({ name: 7 }) }), null);
  assert.equal(bad({ x: flat({ amount: 0 }) }), null);
  assert.equal(bad({ x: flat({ amount: 12.5 }) }), null);
  assert.equal(bad({ x: flat({ amount: 1e10 + 1 }) }), null);
  assert.equal(bad({ x: flat({ amount: '25000' }) }), null);
  assert.equal(bad({ x: flat({ dueDay: 0 }) }), null);
  assert.equal(bad({ x: flat({ dueDay: 32 }) }), null);
  assert.equal(bad({ x: flat({ dueDay: 5.5 }) }), null);
  assert.equal(bad({ x: flat({ since: '2026-02-30' }) }), null);
  assert.equal(bad({ x: flat({ since: 'yesterday' }) }), null);
  assert.equal(bad({ x: flat({ active: 'yes' }) }), null);
  assert.equal(bad({ x: flat({ editedAt: -1 }) }), null);
  assert.equal(bad({ x: flat({ editedAt: '5' }) }), null);
  assert.equal(bad({ x: flat({ deleted: 'no' }) }), null);
  assert.equal(bad({ x: flat({ payee: 'Zelle to R Lindqvist' }) }), null);
  assert.equal(bad({ x: flat({ payeeAt: NaN }) }), null);
  assert.equal(bad({ x: flat({ marks: { 'some day': { paid: true, at: 1 } } }) }), null);
  assert.equal(bad({ x: flat({ marks: { '2026-11-05': { paid: 'yes', at: 1 } } }) }), null);
  assert.equal(bad({ x: flat({ marks: [] }) }), null);
  assert.equal(bad({ x: flat({ skips: { '2026-11-05|zelle to r lindqvist': { on: true, at: 1 } } }) }), null);
  assert.equal(bad({ x: flat({ skips: { ['2026-11-05|' + P1]: { on: true } } }) }), null);
  assert.equal(bad({ 'an id with spaces': flat() }), null);
  assert.equal(bad({ x: 'Flat share' }), null);
  const many = {};
  for (let i = 0; i < 201; i++) many['e' + i] = flat();
  assert.equal(bad(many), null);
  const marks = {};
  for (let i = 0; i < 401; i++) marks[new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10)] = { paid: true, at: 1 };
  assert.equal(bad({ x: flat({ marks }) }), null);
  assert.equal(readSharedFile('x'.repeat(2000001)), null);
});

test('readSharedFile: no key a prototype could be reached through is copied', () => {
  assert.equal(readSharedFile('{"v":1,"app":"networth","savedAt":0,"byHand":{"__proto__":{"deleted":true,"editedAt":1}}}'), null);
  assert.equal(readSharedFile('{"v":1,"app":"networth","savedAt":0,"byHand":{"constructor":{"deleted":true,"editedAt":1}}}'), null);
  const entry = JSON.stringify(flat()).replace('"marks":{}', '"marks":{"__proto__":{"paid":true,"at":1}}');
  assert.equal(readSharedFile('{"v":1,"app":"networth","savedAt":0,"byHand":{"x":' + entry + '}}'), null);
  const got = readSharedFile('{"v":1,"app":"networth","savedAt":0,"byHand":{},"__proto__":{"polluted":1},"later":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"kept":2}}');
  assert.deepEqual(Object.keys(got).sort(), ['app', 'byHand', 'later', 'savedAt', 'v']);
  assert.deepEqual(got.later, { kept: 2 });
  assert.equal(({}).polluted, undefined);
  assert.equal(got.polluted, undefined);
  const merged = mergeShared(got, got);
  assert.equal(merged.polluted, undefined);
});

/* ------------------------------------------------------------------ writing */

test('exportShared: what the owner entered, their ticks and a fingerprint; removals as deleted and their time', () => {
  const state = newState();
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  const gone = addByHand(state, { name: 'Parking', amount: 8500, dueDay: 31 }, TODAY, NOW);
  tickByHand(state, entry.id, '2026-11-05', true, NOW + 1);
  removeByHand(state, gone.id, NOW + 2);
  state.share.tombs.old_one = NOW - 401 * 24 * HOUR_MS;
  const out = exportShared(state, NOW + 3);
  assert.deepEqual(out, { v: 1, app: 'networth', savedAt: NOW + 3, byHand: {
    [entry.id]: { name: 'Flat share', amount: 25000, dueDay: 5, since: '2026-11-01', active: true, editedAt: NOW, deleted: false,
      payee: null, payeeAt: 0, marks: { '2026-11-05': { paid: true, at: NOW + 1 } }, skips: {} },
    [gone.id]: { deleted: true, editedAt: NOW + 2 },
  } });
  assert.ok(readSharedFile(JSON.stringify(out)));
  assert.deepEqual(exportShared({}, NOW).byHand, {});
  assert.deepEqual(exportShared(null, NOW).byHand, {});
});

test('exportShared: nothing the bank reported is in the file', () => {
  const state = newState();
  let n = 0;
  for (const day of ['2026-09-04', '2026-10-05', '2026-11-04']) {
    n += 1;
    state.txs.push(makeTx({ id: 'tx_' + n, accountId: 'acc_checking', day, postedDay: day, amount: 25000, flow: 'out', raw: ZELLE }));
  }
  state.txs.push(makeTx({ id: 'tx_9', accountId: 'acc_checking', day: '2026-11-06', postedDay: '2026-11-06', amount: 4310, flow: 'out', raw: 'Corner Grocer 0042' }));
  state.recurring.push(makeRecurring({ name: 'Streamline', amount: 1599, mkey: 'streamline', cadence: 'monthly', anchor: '2026-11-12', source: 'detected' }));
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  refresh(state, NOW);
  assert.equal(entry.payee, ZELLE_KEY, 'the payee was learned from the bank rows');
  const text = JSON.stringify(exportShared(state, NOW)).toLowerCase();
  assert.ok(text.includes(ZELLE_KEY));
  const banked = [];
  for (const tx of state.txs) banked.push(tx.mkey, tx.merchant, tx.raw, tx.id, tx.fp);
  for (const account of state.accounts) banked.push(account.name, account.id, account.institution, String(account.balance));
  for (const r of state.recurring) if (!r.byHand) banked.push(r.name, r.mkey, r.id);
  const words = banked.filter((x) => typeof x === 'string' && x.length > 2).map((x) => x.toLowerCase());
  assert.ok(words.length >= 12);
  for (const word of words) assert.equal(text.includes(word), false, 'the file holds "' + word + '"');
  assert.equal(text.includes('lindqvist'), false);
  assert.deepEqual(Object.keys(exportShared(state, NOW)).sort(), ['app', 'byHand', 'savedAt', 'v']);
  assert.deepEqual(Object.keys(exportShared(state, NOW).byHand), [entry.id], 'an ordinary Book line never travels');
});

/* ----------------------------------------------------------------- applying */

test('applyShared: creates with the same id, updates, removes with its tomb, and touches by-hand entries only', () => {
  const state = newState();
  const ordinary = makeRecurring({ id: 'rc_plain', name: 'Streamline', amount: 1599, mkey: 'streamline', cadence: 'monthly', anchor: '2026-11-12', source: 'detected' });
  state.recurring.push(ordinary);
  const before = JSON.stringify(ordinary);
  const first = file({ rc_flat: flat({ payee: P1, payeeAt: 4, marks: { '2026-11-05': { paid: true, at: 6 } } }), rc_park: parking(), rc_plain: flat({ name: 'Intruder' }) });
  assert.deepEqual(applyShared(state, first, NOW), { changed: true });
  assert.equal(checkDoc(state), null);
  assert.equal(JSON.stringify(state.recurring.find((r) => r.id === 'rc_plain')), before, 'an entry that is not by hand is never touched');
  const made = state.recurring.find((r) => r.id === 'rc_flat');
  assert.deepEqual([made.byHand, made.source, made.cadence, made.mkey, made.anchor, made.since, made.dueDay, made.payee, made.editedAt],
    [true, 'manual', 'monthly', '', '2026-11-05', '2026-11-01', 5, P1, 100]);
  assert.equal(state.recurring.find((r) => r.id === 'rc_park').anchor, '2026-11-30');
  assert.ok(sameShared(exportShared(state, NOW), file({ rc_flat: first.byHand.rc_flat, rc_park: parking() })));
  assert.deepEqual(applyShared(state, first, NOW), { changed: false }, 'applying the same list again changes nothing');
  assert.equal(sharedChanges(state, first), 0);

  const second = file({ rc_flat: flat({ name: 'Flat', amount: 26000, dueDay: 31, since: '2026-12-01', editedAt: 200 }), rc_park: { deleted: true, editedAt: 300 } });
  assert.deepEqual(applyShared(state, second, NOW), { changed: true });
  assert.equal(checkDoc(state), null);
  assert.deepEqual([made.name, made.amount, made.dueDay, made.since, made.anchor, made.payee, made.locks.length], ['Flat', 26000, 31, '2026-12-01', '2026-12-31', null, 4]);
  assert.equal(state.recurring.some((r) => r.id === 'rc_park'), false);
  assert.equal(state.share.tombs.rc_park, 300);
  assert.equal(state.recurring.length, 2);
  // a payment put back elsewhere after its removal comes back, and its tomb goes
  assert.deepEqual(applyShared(state, file({ rc_park: parking({ editedAt: 400 }) }), NOW), { changed: true });
  assert.equal(state.recurring.some((r) => r.id === 'rc_park'), true);
  assert.equal(Object.hasOwn(state.share.tombs, 'rc_park'), false);
  // a list that is not a file changes nothing
  assert.deepEqual(applyShared(state, { v: 1, app: 'networth', byHand: { x: flat({ dueDay: 40 }) } }, NOW), { changed: false });
  assert.deepEqual(applyShared(state, null, NOW), { changed: false });
});

/* ------------------------------------------------------------ the transport */

/** GitHub's contents API for one file, as the contract describes it, in memory. */
function fakeGithub() {
  const repo = { content: null, sha: null, writes: 0, calls: [], fail: null, visible: true, onRead: null };
  const answer = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body });
  const wrap = (b64) => b64.replace(/(.{60})/g, '$1\n');
  repo.fetch = async (url, init = {}) => {
    repo.calls.push({ url, method: init.method, headers: init.headers, cache: init.cache, body: init.body });
    if (repo.fail === 'offline') throw new TypeError('Failed to fetch');
    if (repo.fail === 'never') return new Promise(() => {});
    if (repo.fail === 'server') return answer(503, { message: 'Service unavailable' });
    if (repo.fail === 'rate') return answer(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    if (repo.fail === 'slow-down') return answer(429, { message: 'Too many requests' });
    if (repo.fail === 'html') return { status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (!init.headers || init.headers.Authorization !== 'Bearer ' + KEY) return answer(401, { message: 'Bad credentials' });
    if (!repo.visible || url !== 'https://api.github.com/repos/' + OWNER + '/networth-data/contents/networth-shared.json') return answer(404, { message: 'Not Found' });
    if (init.method === 'GET') {
      if (repo.content === null) return answer(404, { message: 'Not Found' });
      const res = answer(200, { content: wrap(repo.content), sha: repo.sha, encoding: 'base64' });
      if (repo.onRead) { const hook = repo.onRead; repo.onRead = null; hook(); }
      return res;
    }
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      assert.equal(body.message, 'Networth: shared list');
      if (repo.content !== null && !body.sha) return answer(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      if ((body.sha || null) !== repo.sha) return answer(409, { message: 'is at another sha' });
      const created = repo.content === null;
      repo.put(body.content);
      return answer(created ? 201 : 200, { content: { sha: repo.sha } });
    }
    return answer(405, {});
  };
  repo.put = (b64) => { repo.content = b64; repo.writes += 1; repo.sha = repo.writes.toString(16).padStart(40, '0'); };
  repo.seed = (text) => { repo.put(toBase64(text)); repo.writes = 0; };
  repo.text = () => (repo.content === null ? null : fromBase64(repo.content));
  return repo;
}

function transportOf(repo, key = KEY) {
  return {
    read: () => readSharedText(OWNER, key, repo.fetch),
    write: (text, sha) => writeSharedText(OWNER, key, text, sha, repo.fetch),
  };
}

async function codeOf(promise) {
  try { await promise; } catch (err) { assert.ok(err instanceof ShareError); return err.code; }
  return 'no error';
}

test('the transport: the first write on an empty repository, then a read of what was written', async () => {
  const repo = fakeGithub();
  assert.deepEqual(await readSharedText(OWNER, KEY, repo.fetch), { text: null, sha: null });
  const text = JSON.stringify(file({ x: flat({ name: 'Flat share — Zoë’s half, 50 % · 部屋' }) }));
  const wrote = await writeSharedText(OWNER, KEY, text, null, repo.fetch);
  assert.match(wrote.sha, /^[0-9a-f]{40}$/);
  const got = await readSharedText(OWNER, KEY, repo.fetch);
  assert.deepEqual(got, { text, sha: wrote.sha });
  assert.equal(readSharedFile(got.text).byHand.x.name, 'Flat share — Zoë’s half, 50 % · 部屋');
  for (const call of repo.calls) {
    assert.equal(call.url, 'https://api.github.com/repos/someone/networth-data/contents/networth-shared.json');
    assert.deepEqual(call.headers, { Authorization: 'Bearer ' + KEY, Accept: 'application/vnd.github+json' }, 'these two headers only');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.url.includes(KEY), false);
    if (call.body) assert.equal(call.body.includes(KEY), false);
  }
  assert.deepEqual(Object.keys(JSON.parse(repo.calls[1].body)).sort(), ['content', 'message']);
});

test('the transport: base64 through UTF-8, with the line breaks GitHub puts in', () => {
  const text = 'Flat share — Zoë · 部屋 · ' + 'x'.repeat(40000);
  assert.equal(fromBase64(toBase64(text)), text);
  assert.equal(fromBase64(toBase64(text).replace(/(.{60})/g, '$1\n')), text);
  assert.equal(toBase64('é'), 'w6k=');
  assert.equal(fromBase64('not base64 !!'), null);
  assert.equal(fromBase64('/w=='), null, 'bytes that are not UTF-8');
  assert.equal(fromBase64(undefined), null);
});

test('the transport: a stale sha and a missing sha are a conflict; a refused key, a server error, a pause, no answer', async () => {
  const repo = fakeGithub();
  const first = await writeSharedText(OWNER, KEY, '{"a":1}', null, repo.fetch);
  const second = await writeSharedText(OWNER, KEY, '{"a":2}', first.sha, repo.fetch);
  assert.equal(await codeOf(writeSharedText(OWNER, KEY, '{"a":3}', first.sha, repo.fetch)), 'conflict');
  assert.equal(await codeOf(writeSharedText(OWNER, KEY, '{"a":3}', null, repo.fetch)), 'conflict');
  assert.equal(repo.text(), '{"a":2}');
  assert.notEqual(second.sha, first.sha);

  const wrong = 'another_invented_key_9876543210';
  assert.equal(await codeOf(readSharedText(OWNER, wrong, repo.fetch)), 'key');
  assert.equal(await codeOf(writeSharedText(OWNER, wrong, '{}', second.sha, repo.fetch)), 'key');
  let caught = null;
  try { await readSharedText(OWNER, wrong, repo.fetch); } catch (err) { caught = err; }
  assert.equal(caught.message, 'GitHub refused the key: it may have expired. Paste a new one.');
  assert.equal(String(caught.message + caught.stack).includes(wrong), false, 'the key is in no message');

  // a key that is not a key never leaves the device
  const before = repo.calls.length;
  for (const odd of ['', 'short', 'two words that are long enough', 'line\nbreak_in_a_long_enough_key', 'clé_assez_longue_mais_pas_ascii', null, 42]) {
    assert.equal(await codeOf(readSharedText(OWNER, odd, repo.fetch)), 'key');
    assert.equal(isShareKey(odd), false);
  }
  assert.equal(repo.calls.length, before);
  assert.equal(await codeOf(readSharedText('not an owner', KEY, repo.fetch)), 'missing');
  assert.equal(repo.calls.length, before);

  repo.visible = false; // a key that cannot see the repository: GitHub says 404, as for no file
  assert.deepEqual(await readSharedText(OWNER, KEY, repo.fetch), { text: null, sha: null });
  assert.equal(await codeOf(writeSharedText(OWNER, KEY, '{}', null, repo.fetch)), 'missing');
  repo.visible = true;

  for (const [fail, code] of [['server', 'server'], ['rate', 'rate'], ['slow-down', 'rate'], ['offline', 'network'], ['html', 'server']]) {
    repo.fail = fail;
    assert.equal(await codeOf(readSharedText(OWNER, KEY, repo.fetch)), code, fail);
    assert.equal(await codeOf(writeSharedText(OWNER, KEY, '{}', second.sha, repo.fetch)), code, fail);
  }
  repo.fail = null;
  assert.equal(repo.text(), '{"a":2}');
  for (const code of ['key', 'missing', 'conflict', 'network', 'server', 'rate', 'file']) {
    assert.equal(new ShareError(code).message, shareMessage(code));
    assert.equal(shareMessage(code).includes('!'), false);
  }
});

test('the transport: no answer in 20 seconds is a network error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = fakeGithub();
  repo.fail = 'never';
  const pending = codeOf(readSharedText(OWNER, KEY, repo.fetch));
  await Promise.resolve();
  t.mock.timers.tick(19999);
  t.mock.timers.tick(1);
  assert.equal(await pending, 'network');
});

test('the owner of the repository is read from the address of the page', () => {
  assert.equal(shareOwner({ hostname: 'someone.github.io', search: '' }), 'someone');
  assert.equal(shareOwner({ hostname: 'Some-One.github.io', search: '?share=other' }), 'Some-One');
  assert.equal(shareOwner({ hostname: 'localhost', search: '' }), null);
  assert.equal(shareOwner({ hostname: 'localhost', search: '?demo=1&share=someone' }), 'someone');
  assert.equal(shareOwner({ hostname: '127.0.0.1', search: '?share=someone' }), 'someone');
  assert.equal(shareOwner({ hostname: 'localhost', search: '?share=some/one' }), null);
  assert.equal(shareOwner({ hostname: 'localhost', search: '?share=../../x' }), null);
  assert.equal(shareOwner({ hostname: 'example.com', search: '?share=someone' }), null);
  assert.equal(shareOwner({ hostname: 'a.b.github.io', search: '' }), null);
  assert.equal(shareOwner({ hostname: 'github.io', search: '' }), null);
  assert.equal(shareOwner(null), null);
  assert.equal(sharedUrl('someone'), 'https://api.github.com/repos/someone/networth-data/contents/networth-shared.json');
  assert.throws(() => sharedUrl('some/one'), ShareError);
});

/* ---------------------------------------------------------------- the scene */

/** A device: its document, the copies Undo keeps, and the way a round reaches both (what the store does). */
function makeDevice(repo) {
  const d = { state: newState(), kept: [] };
  const api = {
    state: () => d.state,
    update: (now, past) => {
      now(d.state);
      d.kept = d.kept.map((json) => { const copy = JSON.parse(json); past(copy); return JSON.stringify(copy); });
    },
  };
  /** A change the owner makes, with Undo. */
  d.change = (fn) => { d.kept.push(JSON.stringify(d.state)); fn(d.state); };
  d.undo = (nowMs) => {
    const before = d.state;
    d.state = JSON.parse(d.kept.pop());
    restampByHand(before, d.state, nowMs);
  };
  d.round = async (nowMs) => {
    const res = await roundShared(api, transportOf(repo), () => nowMs);
    assert.equal(checkDoc(d.state), null, 'the record is one the app will load again');
    return res;
  };
  d.entry = (name) => byHandOf(d.state).find((entry) => entry.name === name);
  return d;
}

function agree(devices, repo) {
  const first = exportShared(devices[0].state, 0);
  for (const d of devices) assert.ok(sameShared(exportShared(d.state, 0), first), 'every device holds the same list');
  const inFile = readSharedFile(repo.text());
  for (const id of Object.keys(first.byHand)) assert.deepEqual(inFile.byHand[id], first.byHand[id], 'and the file holds it');
}

test('a file that holds three payments before any device has a key: taken in, not written back, merged with a device’s own', async () => {
  const repo = fakeGithub();
  const seed = newState();
  addByHand(seed, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);
  addByHand(seed, { name: 'Parking', amount: 8500, dueDay: 31 }, TODAY, NOW);
  addByHand(seed, { name: 'Zelle to R Lindqvist', amount: 4000, dueDay: 15 }, TODAY, NOW);
  repo.seed(JSON.stringify(exportShared(seed, NOW)));
  const text = repo.text();

  const a = makeDevice(repo);
  const res = await a.round(NOW + MIN_MS);
  assert.deepEqual([res.ok, res.changed, res.wrote, res.file, res.count], [true, true, false, true, 3]);
  assert.deepEqual(names(a.state), ['Flat share', 'Parking', 'Zelle to R Lindqvist']);
  assert.deepEqual(byHandOf(a.state).map((e) => e.id).sort(), byHandOf(seed).map((e) => e.id).sort(), 'the same ids');
  assert.equal(repo.writes, 0, 'nothing is written back when the merged content is what was read');
  assert.equal(repo.text(), text);
  const again = await a.round(NOW + 2 * MIN_MS);
  assert.deepEqual([again.changed, again.wrote, repo.writes], [false, false, 0]);

  const b = makeDevice(repo);
  b.change((s) => { addByHand(s, { name: 'Storage unit', amount: 6000, dueDay: 20 }, TODAY, NOW + 3 * MIN_MS); });
  const merged = await b.round(NOW + 4 * MIN_MS);
  assert.deepEqual([merged.changed, merged.wrote, merged.count, repo.writes], [true, true, 4, 1]);
  assert.deepEqual(names(b.state), ['Flat share', 'Parking', 'Storage unit', 'Zelle to R Lindqvist']);
  await a.round(NOW + 5 * MIN_MS);
  agree([a, b], repo);
  assert.equal(repo.writes, 1);
});

test('three devices and one repository: adds, a tick, a removal, two edits made offline, a tick undone after it was shared', async () => {
  const repo = fakeGithub();
  const [a, b, c] = [makeDevice(repo), makeDevice(repo), makeDevice(repo)];
  let t = NOW;
  const all = async () => { for (const d of [a, b, c, a, b]) { t += MIN_MS; await d.round(t); } };

  // an empty device and no file: nothing is asked for twice, nothing is written
  const empty = await a.round(t);
  assert.deepEqual([empty.ok, empty.wrote, empty.file, empty.count, repo.writes], [true, false, false, 0, 0]);

  // A adds two payments; B and C receive them
  a.change((s) => { addByHand(s, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, t); refresh(s, t); });
  a.change((s) => { addByHand(s, { name: 'Parking', amount: 8500, dueDay: 31 }, TODAY, t); refresh(s, t); });
  await all();
  assert.deepEqual(names(b.state), ['Flat share', 'Parking']);
  assert.deepEqual(names(c.state), ['Flat share', 'Parking']);
  assert.equal(b.entry('Flat share').id, a.entry('Flat share').id);
  agree([a, b, c], repo);
  const settled = repo.writes;
  await all();
  assert.equal(repo.writes, settled, 'devices that agree write nothing');

  // B ticks one; A and C see the tick
  t += MIN_MS;
  b.change((s) => { assert.equal(tickByHand(s, b.entry('Flat share').id, '2026-11-05', true, t), true); });
  await all();
  assert.equal(a.entry('Flat share').marks['2026-11-05'].paid, true);
  assert.equal(c.entry('Flat share').marks['2026-11-05'].paid, true);
  agree([a, b, c], repo);

  // C removes the other; A and B lose it
  t += MIN_MS;
  c.change((s) => { removeByHand(s, c.entry('Parking').id, t); refresh(s, t); });
  await all();
  assert.deepEqual([names(a.state), names(b.state), names(c.state)], [['Flat share'], ['Flat share'], ['Flat share']]);
  assert.equal(Object.keys(a.state.share.tombs).length, 1);
  agree([a, b, c], repo);

  // two devices change the same payment while offline; the later edit wins on all three, whoever shares first
  t += MIN_MS;
  const early = t;
  a.change((s) => { editByHand(s, a.entry('Flat share').id, { amount: 26000 }, TODAY, early); refresh(s, early); });
  t += MIN_MS;
  const late = t;
  b.change((s) => { editByHand(s, b.entry('Flat share').id, { name: 'Flat', amount: 27500 }, TODAY, late); refresh(s, late); });
  t += MIN_MS;
  await b.round(t); // the later edit reaches the file first
  await all();
  for (const d of [a, b, c]) assert.deepEqual([d.entry('Flat').amount, d.entry('Flat').editedAt, names(d.state).length], [27500, late, 1]);
  agree([a, b, c], repo);

  // A ticks, the tick is shared, then A undoes it: the tick is gone on all three
  t += MIN_MS;
  const id = a.entry('Flat').id;
  const day = a.entry('Flat').anchor;
  a.change((s) => { assert.equal(tickByHand(s, id, day, true, t), true); });
  await all();
  for (const d of [a, b, c]) assert.equal(d.entry('Flat').marks[day].paid, true);
  t += MIN_MS;
  a.undo(t);
  await all();
  for (const d of [a, b, c]) assert.deepEqual(d.entry('Flat').marks[day], { paid: false, at: t - 5 * MIN_MS });
  agree([a, b, c], repo);

  // and an undone removal comes back everywhere
  t += MIN_MS;
  b.change((s) => { removeByHand(s, id, t); refresh(s, t); });
  await all();
  for (const d of [a, b, c]) assert.deepEqual(names(d.state), []);
  t += MIN_MS;
  b.undo(t);
  await all();
  for (const d of [a, b, c]) assert.deepEqual(names(d.state), ['Flat']);
  agree([a, b, c], repo);
});

test('an Undo takes back the owner’s change only, never what another device sent meanwhile', async () => {
  const repo = fakeGithub();
  const [a, b] = [makeDevice(repo), makeDevice(repo)];
  let t = NOW;
  a.change((s) => { addByHand(s, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, t); });
  await a.round(t += MIN_MS);
  await b.round(t += MIN_MS);
  const id = a.entry('Flat share').id;
  a.change((s) => { tickByHand(s, id, '2026-11-05', true, t += MIN_MS); });            // A ticks (Undo is offered)
  b.change((s) => { addByHand(s, { name: 'Parking', amount: 8500, dueDay: 31 }, TODAY, t += MIN_MS); });
  b.change((s) => { editByHand(s, id, { name: 'Flat' }, TODAY, t += MIN_MS); });       // B renames the ticked payment
  await b.round(t += MIN_MS);
  await a.round(t += MIN_MS);                                                          // both arrive on A
  assert.deepEqual(names(a.state), ['Flat', 'Parking']);
  a.undo(t += MIN_MS);                                                                 // A takes the tick back
  assert.deepEqual(names(a.state), ['Flat', 'Parking'], 'what B sent stays');
  assert.equal(a.entry('Flat').marks['2026-11-05'].paid, false);
  assert.deepEqual(a.state.share.tombs, {});
  for (const d of [a, b, a]) await d.round(t += MIN_MS);
  assert.deepEqual(names(b.state), ['Flat', 'Parking']);
  assert.equal(b.entry('Flat').marks['2026-11-05'].paid, false);
  agree([a, b], repo);
});

test('a round: another device writes between the read and the write; a file that cannot be read is never written over', async () => {
  const repo = fakeGithub();
  const [a, b] = [makeDevice(repo), makeDevice(repo)];
  let t = NOW;
  a.change((s) => { addByHand(s, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, t); });
  await a.round(t += MIN_MS);
  b.change((s) => { addByHand(s, { name: 'Parking', amount: 8500, dueDay: 31 }, TODAY, t); });
  a.change((s) => { tickByHand(s, a.entry('Flat share').id, '2026-11-05', true, t); });
  // B reads; before B writes, A's round lands
  let landed = null;
  repo.onRead = () => { landed = a.round(t + 1); };
  const calls = repo.calls.length;
  // A's read inside the hook must not re-enter the hook: it was cleared before it ran
  const res = await b.round(t += MIN_MS);
  await landed;
  assert.equal(res.wrote, true);
  assert.ok(repo.calls.length - calls >= 5, 'B read, was refused, read again and wrote');
  assert.deepEqual(names(b.state), ['Flat share', 'Parking']);
  assert.equal(b.entry('Flat share').marks['2026-11-05'].paid, true);
  await a.round(t += MIN_MS);
  agree([a, b], repo);

  // a device that keeps losing gives up after 4 tries and has changed nothing in the file
  const stubborn = fakeGithub();
  const lone = makeDevice(stubborn);
  lone.change((s) => { addByHand(s, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, t); });
  const realFetch = stubborn.fetch;
  let puts = 0;
  stubborn.fetch = async (url, init) => {
    if (init.method === 'PUT') { puts += 1; return { status: 409, headers: { get: () => null }, json: async () => ({}) }; }
    return realFetch(url, init);
  };
  assert.equal(await codeOf(lone.round(t += MIN_MS)), 'conflict');
  assert.equal(puts, 4);
  assert.deepEqual(names(lone.state), ['Flat share']);

  // a file this version cannot read: the round fails, the device and the file stay as they are
  const odd = fakeGithub();
  odd.seed('{"v":2,"app":"networth","byHand":{}}');
  const d = makeDevice(odd);
  d.change((s) => { addByHand(s, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, t); });
  let caught = null;
  try { await d.round(t += MIN_MS); } catch (err) { caught = err; }
  assert.equal(caught.code, 'file');
  assert.equal(odd.writes, 0);
  assert.equal(odd.text(), '{"v":2,"app":"networth","byHand":{}}');
  assert.deepEqual(names(d.state), ['Flat share']);

  // a round that fails changes nothing on the device
  const down = fakeGithub();
  const e = makeDevice(down);
  e.change((s) => { addByHand(s, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, t); });
  const snapshot = JSON.stringify(e.state);
  for (const fail of ['server', 'rate', 'offline']) {
    down.fail = fail;
    assert.notEqual(await codeOf(e.round(t += MIN_MS)), 'no error');
    assert.equal(JSON.stringify(e.state), snapshot);
  }
});

test('a payee the bank taught one device reaches a device whose bank has not shown the payment', async () => {
  const repo = fakeGithub();
  const [a, b] = [makeDevice(repo), makeDevice(repo)];
  let t = NOW;
  let n = 0;
  for (const day of ['2026-09-04', '2026-10-05', '2026-11-04']) {
    n += 1;
    a.state.txs.push(makeTx({ id: 'tx_a' + n, accountId: 'acc_checking', day, postedDay: day, amount: 25000, flow: 'out', raw: ZELLE }));
  }
  b.change((s) => { addByHand(s, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, t); refresh(s, t); });
  await b.round(t += MIN_MS);
  const res = await a.round(t += MIN_MS); // the entry arrives on A, detection runs in the same update and learns the payee
  assert.equal(a.entry('Flat share').payee, ZELLE_KEY);
  assert.equal(res.wrote, true);
  assert.deepEqual(a.state.txs.map((tx) => tx.recurringId), [a.entry('Flat share').id, a.entry('Flat share').id, a.entry('Flat share').id]);
  await b.round(t += MIN_MS);
  assert.equal(b.entry('Flat share').payee, ZELLE_KEY);
  assert.equal(repo.text().toLowerCase().includes('lindqvist'), false);
  agree([a, b], repo);
});

/* ------------------------------------------------------------- final check */

/** A transport that counts what it is asked, holding one file in memory. */
function memoryTransport(text = null) {
  const t = { text, sha: text == null ? null : 's0', reads: 0, writes: 0, onWrite: null };
  t.read = async () => { t.reads += 1; return { text: t.text, sha: t.sha }; };
  t.write = async (body, sha) => {
    t.writes += 1;
    if (t.onWrite) return t.onWrite(body, sha);
    t.text = body;
    t.sha = 's' + t.writes;
    return {};
  };
  return t;
}

function plainDevice(state, isStale) {
  return { state: () => state, stale: isStale, update: (now) => { now(state); } };
}

test('a round checks that it is not stale before every read and every write (E9 F6)', async () => {
  const state = newState();
  addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, NOW);

  // stale before it starts: nothing is read
  const idle = memoryTransport();
  const res = await roundShared(plainDevice(state, () => true), idle, () => NOW);
  assert.deepEqual([res.ok, res.skipped, idle.reads, idle.writes], [false, true, 0, 0]);

  // the key is forgotten while the write is open and the write meets a stale sha: no second read
  let forgotten = false;
  const open = memoryTransport();
  open.onWrite = async () => { forgotten = true; throw new ShareError('conflict'); };
  const again = await roundShared(plainDevice(state, () => forgotten), open, () => NOW);
  assert.deepEqual([again.ok, again.skipped, open.reads, open.writes], [false, true, 1, 1]);

  // made stale between the read and the write: nothing is written
  let late = false;
  const reader = memoryTransport();
  const realRead = reader.read;
  reader.read = async () => { const got = await realRead(); late = true; return got; };
  const third = await roundShared(plainDevice(state, () => late), reader, () => NOW);
  assert.deepEqual([third.skipped, reader.reads, reader.writes], [true, 1, 0]);
});

test('removals leave the file after 400 days, and do not count toward the 200 payments (E9 F7)', async () => {
  const DAY_MS = 86400000;
  const many = (count, entry) => Object.fromEntries(Array.from({ length: count }, (_, i) => ['h_' + i, entry(i)]));
  // 200 payments and 1,000 removals are readable; one more of either is not
  const full = { ...many(200, () => flat()), ...Object.fromEntries(Object.entries(many(1000, () => ({ deleted: true, editedAt: 5 }))).map(([id, e]) => ['t_' + id, e])) };
  assert.ok(readSharedFile(JSON.stringify(file(full))));
  assert.equal(readSharedFile(JSON.stringify(file({ ...full, extra: flat() }))), null);
  assert.equal(readSharedFile(JSON.stringify(file({ ...full, t_extra: { deleted: true, editedAt: 5 } }))), null);

  // a round drops from what it writes every removal older than 400 days, even one only the file held
  const old = NOW - 401 * DAY_MS;
  const recent = NOW - 399 * DAY_MS;
  const repoFile = file({ h_old: { deleted: true, editedAt: old }, h_recent: { deleted: true, editedAt: recent }, h_flat: flat() });
  const t = memoryTransport(JSON.stringify(repoFile));
  const state = newState();
  const res = await roundShared(plainDevice(state, () => false), t, () => NOW);
  assert.equal(res.ok, true);
  assert.equal(t.writes, 1);
  assert.deepEqual(Object.keys(JSON.parse(t.text).byHand).sort(), ['h_flat', 'h_recent']);
  assert.deepEqual(names(state), ['Flat share']);

  // a payment still on a device that missed a removal older than 400 days is removed there, not written back
  const behind = newState();
  addByHand(behind, { name: 'Flat share', amount: 25000, dueDay: 5 }, TODAY, old - DAY_MS);
  const id = byHandOf(behind)[0].id;
  const t2 = memoryTransport(JSON.stringify(file({ [id]: { deleted: true, editedAt: old } })));
  await roundShared(plainDevice(behind, () => false), t2, () => NOW);
  assert.deepEqual(names(behind), []);
  assert.deepEqual(JSON.parse(t2.text).byHand, {});
});
