/**
 * Income reported by another app (ARCHITECTURE 3.7), the third round: answers and counts are changed directly and
 * never undone, a deposit is evidence (no pinning; a member's role never takes it off its row), `wait` means still
 * coming by transfer, and every device decides the same way (no pruning from local knowledge, the floor, a missing
 * listing is not a removal). Every payer, amount, label and account here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INCOME_FORMAT, MAX_ITEM_ANSWERS, WAIT_MS, answerItem, answerItems, answerPayer, applyIncomeReading, askAgain, cashAccountOf,
  countCash, incomeMoveId, incomeQuestions, liveCounts, rebuildIncome, removeCount, roundIncome,
} from '../js/model/income.js';
import { restampByHand } from '../js/model/byhand.js';
import { checkDoc, defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { makeLedger } from '../js/model/ledger.js';
import { exportShared, roundShared } from '../js/model/share.js';
import { addDays, fmtDate, gameDay } from '../js/model/dates.js';
import { againWords, beforeCountWords, countWords, countedWords, itemWords, payerWords, removedWords } from '../js/views/income-words.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MIN_MS = 60000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const TODAY = gameDay(NOW, 4);
const iso = (ms) => new Date(ms).toISOString();

function fileText({ what = 'Session', payers = [{ id: 'p-avery', name: 'Avery' }, { id: 'p-rowan', name: 'Rowan' }], items = [], from, writtenAt = iso(NOW) } = {}) {
  const doc = { format: INCOME_FORMAT, what, payers, items };
  if (writtenAt !== null) doc.writtenAt = writtenAt; // null: left out
  if (from !== undefined) doc.from = from;
  return JSON.stringify(doc);
}
function item(id, payer, cents, atMs, day) {
  return { id, payer, cents, day: day || gameDay(atMs, 4), at: iso(atMs) };
}
function baseState() {
  const s = defaultState(NOW);
  s.meta.origin = 'bank';
  s.sync.lastOk = NOW;
  s.sync.from = addDays(TODAY, -200);
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'x1', conn: 'c1' } }));
  return s;
}
function bankIn(id, cents, day) {
  return makeTx({ id, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', kind: 'income', category: 'income', raw: 'ZELLE FROM SOMEONE', merchant: 'Zelle', mkey: 'zelle from', fp: 'acc_chk|' + day + '|' + id });
}
function read(state, items, nowMs = NOW, sha = 'sha1', extra = {}) {
  return applyIncomeReading(state, { listed: [{ source: 'work', sha }], files: { work: { sha, text: fileText({ items, ...extra }) } } }, nowMs);
}
/** A record whose `since` lies 30 days back, so that every payment below counts. */
function longState() {
  const s = baseState();
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 30 * DAY_MS, payers: {}, items: {}, counts: [] } };
  return s;
}
const moveOf = (s, id) => s.txs.find((tx) => tx.id === incomeMoveId('work', id));
const rowOf = (s, id) => s.txs.find((tx) => tx.id === id);
const live = (s, at = NOW) => makeLedger(s, at).position().live;
const cashIn = (s, at = NOW) => { const a = cashAccountOf(s); return a ? makeLedger(s, at).accountValueOn(a.id, gameDay(at, 4)) : 0; };

/** One shared file in memory, written only over the sha it was read with; it counts its writes. */
function sharedRepo() {
  const repo = { text: null, sha: null, n: 0 };
  repo.transport = {
    read: async () => ({ text: repo.text, sha: repo.sha }),
    write: async (text, sha) => {
      if (sha !== repo.sha) { const e = new Error('conflict'); e.code = 'conflict'; throw e; }
      repo.text = text;
      repo.sha = (++repo.n).toString(16).padStart(40, '0');
      return { sha: repo.sha };
    },
  };
  return repo;
}

/**
 * A device as the store keeps it: an edit leaves a copy that Undo puts back; an answer or a count is made like a
 * change from outside (`store.update(change, { past: change })`), so it is made in every copy too; the restore hook
 * of app.js restamps the payments by hand only.
 */
function device(repo, state) {
  const d = { state, kept: [] };
  const api = {
    state: () => d.state,
    update: (now, past) => {
      now(d.state);
      if (past) d.kept = d.kept.map((json) => { const copy = JSON.parse(json); past(copy); return JSON.stringify(copy); });
    },
  };
  d.edit = (fn) => { d.kept.push(JSON.stringify(d.state)); fn(d.state); };
  d.answer = (fn) => api.update(fn, fn);
  d.undo = (nowMs) => {
    const before = d.state;
    d.state = JSON.parse(d.kept.pop());
    restampByHand(before, d.state, nowMs);
  };
  d.round = async (nowMs) => {
    const r = await roundShared(api, repo.transport, () => nowMs);
    assert.equal(checkDoc(d.state), null);
    return r;
  };
  return d;
}

/* ------------------------------------------------- 1. changed directly, not undone */

test('1: an answer is made like a change from outside: Undo of another edit, before or after it, leaves it standing, here and after rounds', async () => {
  const repo = sharedRepo();
  const items = [item('i1', 'p-avery', 7000, NOW - 2 * HOUR_MS), item('i2', 'p-rowan', 6000, NOW - 2 * HOUR_MS)];
  const [a, b] = [longState(), longState()].map((s) => { read(s, items); return device(repo, s); });
  let t = NOW;
  a.edit((s) => { s.settings.cover = true; });
  a.answer((s) => answerPayer(s, 'work', 'p-avery', 'cash', (t += MIN_MS)));
  a.edit((s) => { s.settings.cover = false; });
  a.undo((t += MIN_MS));
  assert.equal(moveOf(a.state, 'i1').income.how, 'cash', 'the Undo of a later edit leaves the answer');
  a.undo((t += MIN_MS));
  assert.equal(a.state.settings.cover, false, 'the earlier edit is undone');
  assert.equal(moveOf(a.state, 'i1').income.how, 'cash', 'the Undo of an earlier edit leaves the answer');
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  for (const d of [a, b]) {
    assert.equal(moveOf(d.state, 'i1').income.how, 'cash');
    assert.equal(moveOf(d.state, 'i2').income.how, 'ask');
  }
  // the same after an answer that arrived through a round: B's later edit, undone, never takes it back
  b.edit((s) => { s.settings.cover = true; });
  b.undo((t += MIN_MS));
  await b.round((t += MIN_MS));
  assert.equal(moveOf(b.state, 'i1').income.how, 'cash');
});

test('1: Ask again works through the rounds, and so does an answer to a late payment', async () => {
  const repo = sharedRepo();
  const items = [item('i1', 'p-avery', 7000, NOW - 5 * DAY_MS)];
  const [a, b] = [longState(), longState()].map((s) => {
    s.income.shared.payers['work/p-avery'] = { how: 'bank', at: NOW - 6 * DAY_MS };
    read(s, items);
    return device(repo, s);
  });
  let t = NOW;
  const late = (d) => incomeQuestions(d.state, t).late.map((l) => l.id);
  assert.deepEqual(late(b), ['i1']);
  a.answer((s) => answerItem(s, 'work', 'i1', 'gone', (t += MIN_MS)));
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  assert.equal(moveOf(b.state, 'i1'), undefined, 'in the bank on the other device');
  assert.deepEqual(late(b), []);
  a.edit((s) => { s.settings.cover = true; });
  b.answer((s) => askAgain(s, 'work', 'i1', (t += MIN_MS)));
  for (let k = 0; k < 2; k++) { await b.round((t += MIN_MS)); await a.round((t += MIN_MS)); }
  a.undo((t += MIN_MS));
  for (const d of [a, b]) {
    assert.equal(d.state.income.shared.items['work/i1'].how, 'none');
    assert.equal(moveOf(d.state, 'i1').income.how, 'bank', 'it counts in pencil again');
    assert.deepEqual(late(d), ['i1'], 'and its late question is back');
  }
});

/** Cash in hand as each close and the figure now show it. */
function cashView(d, from) {
  const L = makeLedger(d.state, NOW);
  const acc = cashAccountOf(d.state);
  const c = L.closes(from, TODAY);
  return { now: L.accountValueOn(acc.id, TODAY), balance: acc.balance, values: c.map((x) => L.accountValueOn(acc.id, x.day)), revals: c.map((x) => x.reval) };
}

test('1: Remove the latest count works through the rounds, and the earlier count rules again from its day', async () => {
  const repo = sharedRepo();
  const d5 = NOW - 5 * DAY_MS;
  const d3 = NOW - 3 * DAY_MS;
  const d1 = NOW - DAY_MS;
  const [a, b] = [longState(), longState()].map((s) => {
    s.income.shared.payers['work/p-rowan'] = { how: 'cash', at: NOW - 20 * DAY_MS };
    read(s, [item('a', 'p-rowan', 4000, d5), item('b', 'p-rowan', 6000, d3), item('c', 'p-rowan', 2500, d1)]);
    return device(repo, s);
  });
  const first = gameDay(d5, 4);
  let t = NOW;
  a.answer((s) => countCash(s, 9000, d3 + HOUR_MS));
  await a.round((t += MIN_MS));
  await b.round((t += MIN_MS));
  const one = cashView(b, first);
  assert.equal(one.now, 11500);
  a.answer((s) => countCash(s, 5000, d1 + HOUR_MS));
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  assert.equal(cashView(b, first).now, 5000);
  // B removes the latest count; an Undo of an earlier edit on A never brings it back
  a.edit((s) => { s.settings.cover = true; });
  const latest = liveCounts(b.state.income.shared).pop();
  b.answer((s) => removeCount(s, latest.id, (t += MIN_MS)));
  assert.deepEqual(b.state.income.shared.counts.find((c) => c.id === latest.id), { id: latest.id, deleted: true, editedAt: t });
  assert.deepEqual(cashView(b, first), one, 'the earlier count rules again from its day');
  for (let k = 0; k < 2; k++) { await b.round((t += MIN_MS)); await a.round((t += MIN_MS)); }
  a.undo((t += MIN_MS));
  await a.round((t += MIN_MS));
  assert.deepEqual(cashView(a, first), one);
  assert.deepEqual(cashView(b, first), one);
  // and the first one too: no count, every cash payment adds up
  a.answer((s) => removeCount(s, liveCounts(s.income.shared).pop().id, (t += MIN_MS)));
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  for (const d of [a, b]) assert.equal(cashView(d, first).now, 12500);
  assert.equal(removeCount(a.state, 'c-none', t), false, 'nothing to remove');
});

/* ----------------------------------------------- 2. no pinning; a deposit is evidence */

test('2: G1 and G2, a payer\'s cash answer from a device without the row keeps a matched group on its row, with one question; Ask again brings it back', async () => {
  const repo = sharedRepo();
  const items = [item('i1', 'p-avery', 7000, NOW - 3 * DAY_MS), item('i2', 'p-avery', 7000, NOW - 2 * DAY_MS)];
  const sa = longState();
  sa.txs.push(bankIn('b1', 14000, addDays(TODAY, -1)));
  read(sa, items);
  const sb = longState();
  read(sb, items);
  const [a, b] = [device(repo, sa), device(repo, sb)];
  assert.equal(moveOf(sa, 'i1').matchId, 'b1');
  assert.equal(moveOf(sa, 'i2').matchId, 'b1');
  const liveA = live(sa);
  let t = NOW;
  b.answer((s) => answerPayer(s, 'work', 'p-avery', 'cash', (t += MIN_MS)));
  assert.deepEqual(b.state.income.shared.items, {}, 'a payer answer writes that answer and nothing else');
  await b.round((t += MIN_MS));
  await a.round((t += MIN_MS));
  for (const id of ['i1', 'i2']) assert.equal(moveOf(a.state, id).matchId, 'b1', id + ' stays on its row');
  assert.equal(live(a.state), liveA, 'each counted once');
  assert.equal(cashIn(a.state), 0);
  assert.equal(rowOf(a.state, 'b1').reportedAs, 'Session · Avery');
  let q = incomeQuestions(a.state, t).confirm;
  assert.equal(q.length, 1, 'one question for the row');
  assert.deepEqual(q[0].ids, ['i1', 'i2']);
  assert.equal(q[0].cents, 14000);
  assert.equal(q[0].label, 'Session · Avery');
  assert.deepEqual(q[0].bank, { cents: 14000, day: addDays(TODAY, -1) });
  // It came by Zelle, for every member
  a.answer((s) => answerItems(s, 'work', q[0].ids, 'bank', (t += MIN_MS)));
  assert.deepEqual(incomeQuestions(a.state, t).confirm, []);
  assert.equal(live(a.state), liveA);
  // G2: Ask again on one member clears its own answer: it follows its payer again, the pair holds, the question returns
  a.answer((s) => askAgain(s, 'work', 'i1', (t += MIN_MS)));
  assert.equal(moveOf(a.state, 'i1').matchId, 'b1');
  assert.equal(moveOf(a.state, 'i2').matchId, 'b1');
  assert.equal(live(a.state), liveA, 'never counted twice');
  assert.equal(cashIn(a.state), 0);
  q = incomeQuestions(a.state, t).confirm;
  assert.deepEqual(q.map((x) => [x.ids, x.n, x.cents, x.others.n]), [[['i1'], 2, 14000, 1]], 'the buttons answer only i1; the question names both');
  // the rounds: the device without the row counts both as cash and asks nothing
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  assert.equal(moveOf(a.state, 'i1').matchId, 'b1');
  assert.equal(live(a.state), liveA);
  assert.equal(cashIn(b.state), 7000, 'on B, i1 follows its payer; i2 came by Zelle');
  assert.deepEqual(incomeQuestions(b.state, t).confirm, []);
});

test('2: a group of one payer that follows its payer\'s cash answer is matched; It was cash writes it for every member', () => {
  const s = longState();
  s.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 10 * DAY_MS };
  read(s, [item('i1', 'p-avery', 7000, NOW - 3 * DAY_MS), item('i2', 'p-avery', 7000, NOW - 2 * DAY_MS), item('r1', 'p-rowan', 9000, NOW - 2 * DAY_MS)]);
  assert.equal(cashIn(s), 14000);
  s.txs.push(bankIn('b1', 14000, addDays(TODAY, -1)));
  s.accounts[0].balance += 14000;
  rebuildIncome(s, NOW);
  const counted = live(s);
  assert.equal(moveOf(s, 'i1').matchId, 'b1');
  assert.equal(moveOf(s, 'i2').matchId, 'b1');
  assert.equal(cashIn(s), 0, 'counted once, as the row, while the question is open');
  const q = incomeQuestions(s, NOW).confirm;
  assert.equal(q.length, 1);
  assert.deepEqual(q[0].ids, ['i1', 'i2']);
  const z = structuredClone(s);
  answerItems(z, 'work', q[0].ids, 'bank', NOW + MIN_MS);
  assert.deepEqual([z.income.shared.items['work/i1'].how, z.income.shared.items['work/i2'].how], ['bank', 'bank']);
  assert.equal(live(z), counted);
  assert.deepEqual(incomeQuestions(z, NOW).confirm, []);
  const c = structuredClone(s);
  answerItems(c, 'work', q[0].ids, 'cash', NOW + MIN_MS);
  assert.equal(moveOf(c, 'i1').matchId, null);
  assert.equal(moveOf(c, 'i2').matchId, null);
  assert.equal(rowOf(c, 'b1').reportedAs, undefined);
  assert.equal(cashIn(c), 14000);
  assert.equal(live(c), counted + 14000, 'the owner said cash: the row is money of its own');
  assert.deepEqual(incomeQuestions(c, NOW).confirm, []);
  // a single payment that follows its payer's cash answer still matches a row of its exact cents first
  const one = longState();
  one.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 10 * DAY_MS };
  read(one, [item('i1', 'p-avery', 7000, NOW - 3 * DAY_MS), item('i2', 'p-avery', 7000, NOW - 2 * DAY_MS)]);
  one.txs.push(bankIn('b2', 7000, addDays(TODAY, -1)));
  rebuildIncome(one, NOW);
  assert.deepEqual(incomeQuestions(one, NOW).confirm.map((x) => x.ids), [['i2']]);
  assert.equal(checkDoc(s), null);
});

/* --------------------------------------------------- 3. wait: still coming by transfer */

for (const counted of [false, true]) {
  test('3: Still coming keeps a payment coming by transfer, never its payer\'s cash' + (counted ? ', with a count after it' : ', with no count'), () => {
    const s = longState();
    s.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 10 * DAY_MS };
    read(s, [item('i1', 'p-avery', 7000, NOW - 6 * DAY_MS)]);
    s.txs.push(bankIn('b1', 7000, addDays(TODAY, -5)));
    rebuildIncome(s, NOW);
    assert.equal(moveOf(s, 'i1').matchId, 'b1');
    answerItem(s, 'work', 'i1', 'bank', NOW); // It came by Zelle
    if (counted) countCash(s, 20000, NOW + MIN_MS);
    s.txs = s.txs.filter((tx) => tx.id !== 'b1'); // the row no longer counts (a pending row the bank dropped)
    rebuildIncome(s, NOW + 2 * MIN_MS);
    assert.deepEqual(incomeQuestions(s, NOW + 2 * MIN_MS).late.map((l) => l.id), ['i1']);
    const at = NOW + 3 * MIN_MS;
    answerItem(s, 'work', 'i1', 'wait', at);
    assert.equal(moveOf(s, 'i1').income.how, 'bank', 'still coming by transfer');
    assert.equal(cashIn(s), counted ? 20000 : 0, 'never in Cash in hand');
    assert.equal(live(s), 500000 + 7000 + (counted ? 20000 : 0), 'counted in pencil');
    assert.deepEqual(incomeQuestions(s, at + WAIT_MS - 1).late, []);
    assert.deepEqual(incomeQuestions(s, at + WAIT_MS).late.map((l) => l.id), ['i1'], 'its late question returns at until');
  });
}

/* ------------------------------------------------ 4. every device decides the same way */

test('4: a later file forgets what lies below its floor, and a file that lists a payment below its own floor is refused', () => {
  const s = baseState();
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 600 * DAY_MS, payers: { 'work/p-avery': { how: 'cash', at: 1 } }, items: {}, counts: [] } };
  const old = item('old', 'p-avery', 5000, NOW - 500 * DAY_MS);
  const mid = item('mid', 'p-avery', 6000, NOW - 300 * DAY_MS);
  const now = item('new', 'p-avery', 7000, NOW - HOUR_MS);
  read(s, [old, mid, now]);
  assert.equal(cashIn(s), 18000);
  const from = iso(NOW - 400 * DAY_MS);
  read(s, [old, now], NOW, 'sha2', { from });
  assert.match(s.income.sources.work.problem, /before the time the list starts from/);
  assert.equal(cashIn(s), 18000, 'refused: the last good copy is kept');
  // no carry-over: the file no longer lists them, so the device forgets them
  read(s, [now], NOW, 'sha3', { from });
  assert.deepEqual(s.income.sources.work.items.map((i) => i.id), ['new']);
  assert.equal(moveOf(s, 'old'), undefined);
  assert.equal(moveOf(s, 'mid'), undefined, 'absent after the floor: un-marked');
  assert.equal(cashIn(s), 7000, 'uncounted cash below the floor leaves Cash in hand');
  assert.deepEqual(incomeQuestions(s, NOW).payers, []);
  assert.equal(checkDoc(s), null);
});

test('4: a device that has read for 600 days and one that joins today show the same figures', async () => {
  const repo = sharedRepo();
  const payments = [];
  for (let k = 600; k >= 0; k -= 5) payments.push(item('a' + k, k % 2 ? 'p-avery' : 'p-rowan', 1000 + k, NOW - k * DAY_MS - HOUR_MS));
  const fileAt = (t) => fileText({ items: payments.filter((p) => Date.parse(p.at) <= t && Date.parse(p.at) >= t - 400 * DAY_MS), from: iso(t - 400 * DAY_MS), writtenAt: iso(t) });
  const readAt = (s, t, n) => applyIncomeReading(s, { listed: [{ source: 'work', sha: 'sha' + n }], files: { work: { sha: 'sha' + n, text: fileAt(t) } } }, t);
  const old = baseState();
  const a = device(repo, old);
  let n = 0;
  for (let t = NOW - 600 * DAY_MS; t <= NOW; t += 30 * DAY_MS) {
    a.answer((s) => readAt(s, t, ++n));
    if (n === 1) a.answer((s) => answerPayer(s, 'work', 'p-avery', 'cash', t + MIN_MS));
    if (n === 2) a.answer((s) => answerItem(s, 'work', 'a580', 'gone', t + MIN_MS));
  }
  a.answer((s) => readAt(s, NOW, ++n));
  const b = device(repo, baseState());
  b.answer((s) => readAt(s, NOW, n));
  let t = NOW;
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  const view = (d) => {
    const L = makeLedger(d.state, t);
    return { live: L.position().live, cash: cashIn(d.state, t), closes: L.closes(addDays(TODAY, -60), TODAY).map((c) => c.smooth), asked: incomeQuestions(d.state, t) };
  };
  assert.ok(view(a).cash > 0);
  assert.deepEqual(view(b), view(a));
});

test('4: the caps alone bound the answers, by stamp and then key; an old answer of a payment no source lists stays', () => {
  const s = longState();
  read(s, [item('listed', 'p-avery', 7000, NOW - HOUR_MS)]);
  const shared = s.income.shared;
  shared.items['work/listed'] = { how: 'gone', at: 1 };
  shared.items['work/unlisted-old'] = { how: 'gone', at: NOW - 500 * DAY_MS };
  for (let k = 0; k < MAX_ITEM_ANSWERS - 2; k++) shared.items['work/n' + k] = { how: 'cash', at: NOW - 400 * DAY_MS + k };
  assert.ok(Object.hasOwn(exportShared(s, NOW).income.items, 'work/unlisted-old'), 'never pruned by what a device lists');
  answerItem(s, 'work', 'fresh', 'cash', NOW);
  assert.equal(Object.keys(s.income.shared.items).length, MAX_ITEM_ANSWERS);
  assert.equal(Object.hasOwn(s.income.shared.items, 'work/listed'), false, 'at the cap the oldest stamp goes, whatever it is');
  assert.ok(Object.hasOwn(s.income.shared.items, 'work/unlisted-old'));
});

test('4: two devices that know different payments write the shared file at most once (ping-pong)', async () => {
  const repo = sharedRepo();
  const listed = [item('i1', 'p-avery', 7000, NOW - HOUR_MS)];
  const sa = longState();
  sa.income.shared.since = NOW - 600 * DAY_MS;
  sa.income.shared.items['work/long-ago'] = { how: 'gone', at: NOW - 500 * DAY_MS };
  read(sa, listed, NOW, 'sha1', { from: iso(NOW - 400 * DAY_MS) });
  const sb = baseState();
  read(sb, listed, NOW, 'sha1', { from: iso(NOW - 400 * DAY_MS) });
  const [a, b] = [device(repo, sa), device(repo, sb)];
  let t = NOW;
  for (let k = 0; k < 6; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  assert.equal(repo.n, 1, 'one write');
  assert.ok(b.state.income.shared.items['work/long-ago']);
});

test('4: a missing listing is not a removal: a 404 drops nothing, and a source absent from a listing goes after 24 hours', async () => {
  const s = longState();
  const text = fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS)] });
  const entry = { name: 'work.json', sha: 'a'.repeat(40), size: text.length };
  let listing = [entry];
  let updates = 0;
  const transport = { list: async () => listing, read: async () => text };
  const dev = { state: () => s, stale: () => false, update: (change) => { updates++; change(s); } };
  await roundIncome(dev, transport, NOW);
  assert.ok(moveOf(s, 'i1'));
  listing = null; // the folder answered 404: the key may have lost access
  await roundIncome(dev, transport, NOW + MIN_MS);
  assert.ok(moveOf(s, 'i1'), 'a 404 drops nothing');
  listing = [];
  await roundIncome(dev, transport, NOW + 2 * MIN_MS);
  assert.ok(moveOf(s, 'i1'), 'missed for less than 24 hours: kept');
  assert.equal(s.income.sources.work.missedAt, NOW + 2 * MIN_MS);
  const was = updates;
  await roundIncome(dev, transport, NOW + 3 * MIN_MS);
  assert.equal(updates, was, 'nothing to store while it is missed');
  listing = [entry];
  await roundIncome(dev, transport, NOW + 4 * MIN_MS);
  assert.ok(moveOf(s, 'i1'));
  assert.equal(Object.hasOwn(s.income.sources.work, 'missedAt'), false, 'listed again: kept whole');
  listing = [];
  await roundIncome(dev, transport, NOW + 5 * MIN_MS);
  await roundIncome(dev, transport, NOW + 5 * MIN_MS + DAY_MS - 1);
  assert.ok(moveOf(s, 'i1'));
  await roundIncome(dev, transport, NOW + 5 * MIN_MS + DAY_MS);
  assert.equal(moveOf(s, 'i1'), undefined, 'dropped once it has been missed for 24 hours');
  assert.deepEqual(Object.keys(s.income.sources), []);
});

/* --------------------------------------------------- 5. marking can lower the figure once */

test('5: marking a payment that completes a group with an older one still in pencil lowers the figure: it was counted twice', () => {
  const s = longState();
  const d = NOW - 6 * DAY_MS;
  read(s, [item('i1', 'p-rowan', 3000, d)]);
  s.txs.push(bankIn('r', 7000, gameDay(d + DAY_MS, 4)));
  s.accounts[0].balance += 7000;
  rebuildIncome(s, NOW);
  assert.equal(moveOf(s, 'i1').matchId, null, 'no match yet: the row counts as income of its own');
  const before = live(s);
  read(s, [item('i1', 'p-rowan', 3000, d), item('i3', 'p-rowan', 4000, d + 2 * DAY_MS)], NOW, 'sha2');
  assert.equal(moveOf(s, 'i1').matchId, 'r');
  assert.equal(moveOf(s, 'i3').matchId, 'r');
  assert.equal(live(s), before - 3000, 'i1 was counted in pencil and inside the row until the deposit could be explained');
});

test('5: the same when the older payment counted in Cash in hand, following its payer\'s cash answer; the row then asks', () => {
  const s = longState();
  s.income.shared.payers['work/p-rowan'] = { how: 'cash', at: NOW - 20 * DAY_MS };
  const d = NOW - 6 * DAY_MS;
  read(s, [item('i1', 'p-rowan', 3000, d)]);
  s.txs.push(bankIn('r', 7000, gameDay(d + DAY_MS, 4)));
  s.accounts[0].balance += 7000;
  rebuildIncome(s, NOW);
  assert.equal(moveOf(s, 'i1').matchId, null);
  assert.equal(cashIn(s), 3000);
  const before = live(s);
  read(s, [item('i1', 'p-rowan', 3000, d), item('i3', 'p-rowan', 4000, d + 2 * DAY_MS)], NOW, 'sha2');
  assert.deepEqual([moveOf(s, 'i1').matchId, moveOf(s, 'i3').matchId], ['r', 'r']);
  assert.equal(cashIn(s), 0);
  assert.equal(live(s), before - 3000, 'i1 was counted in Cash in hand and inside the row');
  assert.deepEqual(incomeQuestions(s, NOW).confirm.map((q) => q.ids), [['i1', 'i3']]);
});

/* ------------------------------------------------------------- 6. the words */

test('6: the toasts say how to change an answer, and under cover none names an amount', () => {
  const s = longState();
  s.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 10 * DAY_MS };
  read(s, [item('i1', 'p-avery', 3300, NOW - 2 * HOUR_MS)]);
  countCash(s, 0, NOW - HOUR_MS);
  const had = new Set();
  for (const cover of [false, true]) {
    const early = beforeCountWords(s, had, 0, TODAY, cover);
    const words = [
      early.text, payerWords('Avery', 'cash', beforeCountWords(s, had, 0, TODAY, cover, 'payer')), payerWords('Avery', 'bank', null),
      itemWords('Session · Avery', 'cash', early, NOW, 4), itemWords('Session · Avery', 'gone', null, NOW, 4),
      itemWords('Session · Avery', 'wait', null, NOW, 4), countWords(12000, cover), removedWords(5000, cover),
    ];
    if (cover) for (const w of words) assert.doesNotMatch(w, /\$/, w);
    else assert.equal(early.text, 'The $33.00 was marked before today’s count, so Cash in hand stays $0.00.');
    if (cover) assert.equal(early.text, 'It was marked before today’s count, so Cash in hand stays as counted.');
    assert.match(words[3], /^Session · Avery was cash\. /, 'the toast keeps who and what was answered');
    assert.match(words[1], /Change it in Settings\.$/);
    assert.match(words[3], /Ask again from the payment\.$/);
    assert.match(words[6], /Count again to correct it\.$/);
  }
  assert.match(beforeCountWords(s, had, 0, addDays(TODAY, 1), false).text, /yesterday’s count/);
});

test('6: the Ask again toast is built from the rebuilt payment', () => {
  const s = longState();
  s.income.shared.payers['work/p-avery'] = { how: 'bank', at: NOW - 10 * DAY_MS };
  s.income.shared.payers['work/p-rowan'] = { how: 'cash', at: NOW - 10 * DAY_MS };
  read(s, [item('i1', 'p-avery', 7000, NOW - 28 * HOUR_MS), item('i2', 'p-rowan', 5000, NOW - 2 * DAY_MS), item('i3', 'p-avery', 6000, NOW - 9 * DAY_MS)]);
  s.txs.push(bankIn('b1', 5000, addDays(TODAY, -1)));
  rebuildIncome(s, NOW);
  const pencil = againWords(s, 'work/i1', NOW);
  assert.match(pencil, /^Session · Avery: it counts in pencil again; Networth asks on .+ if the bank has not shown it\.$/);
  assert.equal(againWords(s, 'work/i3', NOW), 'Session · Avery: it counts in pencil again; Networth asks about it on the board.');
  assert.equal(againWords(s, 'work/i2', NOW), 'Session · Rowan: Networth asks about it on the board.');
  s.txs = s.txs.filter((tx) => tx.id !== 'b1');
  rebuildIncome(s, NOW);
  assert.equal(againWords(s, 'work/i2', NOW), 'Session · Rowan: it counts in Cash in hand now.', 'not in Cash in hand before: no "again"');
});

test('1: in the views every answer and count is made like a change from outside (past), never with Undo', async () => {
  const { readFile } = await import('node:fs/promises');
  let made = 0;
  for (const file of ['board.js', 'settings.js', 'sheet-account.js', 'sheet-tx.js']) {
    const text = await readFile(new URL('../js/views/' + file, import.meta.url), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/const change = \(s\) => \{? ?(answerPayer|answerItems|askAgain|countCash|removeCount)\(s,/.test(line)) return;
      made++;
      assert.match(lines[i + 1], /store\.update\(.*\{ past: change \}\);$/, file + ': ' + lines[i + 1].trim());
    });
    assert.doesNotMatch(text, /\b(answerPayer|answerItems?|askAgain|countCash|removeCount)\(s,[^\n]*undo:/, file);
  }
  assert.equal(made, 8, 'the payer, a payment, a row, the switch, Ask again twice, a count, a removal');
});

test('6: when the cash was last counted: never, today, yesterday, or its day', () => {
  const s = longState();
  assert.equal(countedWords(s, TODAY).words, 'never counted');
  countCash(s, 1000, NOW - 3 * DAY_MS);
  assert.equal(countedWords(s, TODAY).words, 'counted ' + fmtDate(gameDay(NOW - 3 * DAY_MS, 4), 'short'));
  countCash(s, 1000, NOW - DAY_MS);
  assert.equal(countedWords(s, TODAY).words, 'counted yesterday');
  countCash(s, 2000, NOW);
  assert.deepEqual([countedWords(s, TODAY).words, countedWords(s, TODAY).count.cents], ['counted today', 2000]);
});
