/**
 * Income reported by another app (ARCHITECTURE 3.7), the fourth round: the matching is a pure function of its inputs
 * (no kept pairs, one pass for every claimant, no row before its source's floor), a confirmation per row that names
 * every member, the file protocol (a 404 that proves access, a reading with no text, `from` after now, answer
 * stamps) and the words of the screens. Every payer, amount, label and account here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INCOME_FORMAT, RECHECK_MS, answerItems, answerPayer, applyIncomeReading, askAgain, cashAccountOf, countCash, incomeMoveId,
  incomeOf, incomePayments, incomeQuestions, itemAnswer, readIncomeFile, rebuildIncome, roundIncome, rowPayments,
} from '../js/model/income.js';
import { checkDoc, defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { makeLedger } from '../js/model/ledger.js';
import { roundShared } from '../js/model/share.js';
import { addDays, gameDay } from '../js/model/dates.js';
import { againWords, beforeCountWords, isCountedCash, payerWords, removedWords, cashNoteWords, othersWords, confirmWords } from '../js/views/income-words.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MIN_MS = 60000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const TODAY = gameDay(NOW, 4);
const iso = (ms) => new Date(ms).toISOString();
const PAYERS = [{ id: 'p-avery', name: 'Avery' }, { id: 'p-rowan', name: 'Rowan' }, { id: 'p-quinn', name: 'Quinn' }, { id: 'p-noor', name: 'Noor' }];

function fileText({ what = 'Session', payers = PAYERS, items = [], from, writtenAt = iso(NOW) } = {}) {
  const doc = { format: INCOME_FORMAT, what, payers, items };
  if (writtenAt !== null) doc.writtenAt = writtenAt;
  if (from !== undefined) doc.from = from;
  return JSON.stringify(doc);
}
function item(id, payer, cents, atMs, day) {
  return { id, payer, cents, day: day || gameDay(atMs, 4), at: iso(atMs) };
}
function baseState(at = NOW) {
  const s = defaultState(at);
  s.meta.origin = 'bank';
  s.sync.lastOk = at;
  s.sync.from = addDays(gameDay(at, 4), -200);
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: at, basis: 'bank', ext: { src: 'simplefin', id: 'x1', conn: 'c1' } }));
  return s;
}
function bankIn(id, cents, day) {
  return makeTx({ id, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', kind: 'income', category: 'income', raw: 'ZELLE FROM SOMEONE', merchant: 'Zelle', mkey: 'zelle from', fp: 'acc_chk|' + day + '|' + id });
}
function readText(state, text, nowMs = NOW, sha = 'sha1') {
  return applyIncomeReading(state, { listed: [{ source: 'work', sha }], files: { work: { sha, text } } }, nowMs);
}
function read(state, items, nowMs = NOW, sha = 'sha1', extra = {}) {
  return readText(state, fileText({ items, ...extra }), nowMs, sha);
}
/** A record whose `since` lies 60 days back, so that every payment below counts. */
function longState() {
  const s = baseState();
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 60 * DAY_MS, payers: {}, items: {}, counts: [] } };
  return s;
}
function addRow(state, id, cents, day, at = NOW) {
  state.txs.push(bankIn(id, cents, day));
  state.accounts.find((a) => a.id === 'acc_chk').balance += cents;
  rebuildIncome(state, at);
}
const moveOf = (s, id) => s.txs.find((tx) => tx.id === incomeMoveId('work', id));
const rowOf = (s, id) => s.txs.find((tx) => tx.id === id);
const live = (s, at = NOW) => makeLedger(s, at).position().live;
const cashIn = (s, at = NOW) => { const a = cashAccountOf(s); return a ? makeLedger(s, at).accountValueOn(a.id, gameDay(at, 4)) : 0; };
const pairsOf = (s) => JSON.stringify(s.income.pairs);
const asked = (s, at = NOW) => {
  const q = incomeQuestions(s, at);
  return { payers: q.payers.map((p) => p.key), late: q.late.map((l) => l.key), confirm: q.confirm.map((c) => c.row + ':' + c.ids.join('+')) };
};

/** One shared file in memory, written only over the sha it was read with. */
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
/** A device as the store keeps it: every change is followed by the rebuild (app.js's update hook). */
function device(repo, state) {
  const d = { state };
  const api = { state: () => d.state, update: (now) => { now(d.state); rebuildIncome(d.state, d.at); } };
  d.at = NOW;
  d.do = (fn, at) => { d.at = at; fn(d.state); rebuildIncome(d.state, at); };
  d.round = async (at) => {
    d.at = at;
    await roundShared(api, repo.transport, () => at);
    assert.equal(checkDoc(d.state), null);
  };
  return d;
}
/** Everything two devices must agree on. */
function view(s, at, from) {
  const L = makeLedger(s, at);
  return {
    pairs: pairsOf(s), live: L.position().live, cash: cashIn(s, at), asked: asked(s, at),
    closes: L.closes(from, gameDay(at, 4)).map((c) => c.day + ':' + c.bank + '/' + c.smooth + '/' + c.result + '/' + c.earned),
  };
}

/* ------------------------------------------------ A. matching is a pure function of its inputs */

test('A: K1 and K2, a device that saw the deposit early and one that joins later pair it the same way', async () => {
  const repo = sharedRepo();
  const D = gameDay(NOW - 4 * DAY_MS, 4);
  const p1 = item('i1', 'p-avery', 7000, NOW - 12 * DAY_MS);
  const p2 = item('i2', 'p-avery', 7000, NOW - 3 * DAY_MS);
  const a = device(repo, baseState());
  a.do((s) => read(s, [p1], NOW - 11 * DAY_MS, 's1'), NOW - 11 * DAY_MS);
  a.do((s) => addRow(s, 'r1', 7000, D, NOW - 4 * DAY_MS + HOUR_MS), NOW - 4 * DAY_MS + HOUR_MS);
  assert.equal(moveOf(a.state, 'i1').matchId, 'r1', 'A pairs it with the only payment it knows');
  a.do((s) => read(s, [p1, p2], NOW - 3 * DAY_MS + HOUR_MS, 's2'), NOW - 3 * DAY_MS + HOUR_MS);
  const b = device(repo, baseState());
  b.do((s) => addRow(s, 'r1', 7000, D), NOW);
  b.do((s) => read(s, [p1, p2], NOW, 's2'), NOW);
  let t = NOW + MIN_MS;
  for (let k = 0; k < 3; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  const at = NOW + 2 * DAY_MS;
  for (const d of [a, b]) rebuildIncome(d.state, at);
  assert.deepEqual(view(b.state, at, addDays(D, -10)), view(a.state, at, addDays(D, -10)), 'K1');
  assert.equal(moveOf(a.state, 'i2').matchId, 'r1', 'the payment marked nearest the deposit');
  // K2: the payer answered Zelle on one device; both ask about the same late payment
  a.do((s) => answerPayer(s, 'work', 'p-avery', 'bank', (t += MIN_MS)), t);
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  for (const d of [a, b]) rebuildIncome(d.state, at);
  assert.deepEqual(asked(a.state, at).late, ['work/i1']);
  assert.deepEqual(view(b.state, at, addDays(D, -10)), view(a.state, at, addDays(D, -10)), 'K2');
});

test('A: X1 and X2, a cash payer\'s deposit: both devices ask about the same payment, and one answer settles both', async () => {
  const repo = sharedRepo();
  const D = gameDay(NOW - 4 * DAY_MS, 4);
  const p1 = item('i1', 'p-avery', 7000, NOW - 12 * DAY_MS);
  const p2 = item('i2', 'p-avery', 7000, NOW - 3 * DAY_MS);
  const a = device(repo, baseState());
  a.do((s) => read(s, [p1], NOW - 11 * DAY_MS, 's1'), NOW - 11 * DAY_MS);
  a.do((s) => answerPayer(s, 'work', 'p-avery', 'cash', NOW - 11 * DAY_MS + MIN_MS), NOW - 11 * DAY_MS + MIN_MS);
  await a.round(NOW - 11 * DAY_MS + 2 * MIN_MS);
  a.do((s) => addRow(s, 'r1', 7000, D, NOW - 4 * DAY_MS + HOUR_MS), NOW - 4 * DAY_MS + HOUR_MS);
  a.do((s) => read(s, [p1, p2], NOW - 3 * DAY_MS + HOUR_MS, 's2'), NOW - 3 * DAY_MS + HOUR_MS);
  const b = device(repo, baseState());
  b.do((s) => addRow(s, 'r1', 7000, D), NOW);
  b.do((s) => read(s, [p1, p2], NOW, 's2'), NOW);
  let t = NOW + MIN_MS;
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  assert.deepEqual(view(b.state, t, addDays(D, -10)), view(a.state, t, addDays(D, -10)), 'X1');
  const q = incomeQuestions(a.state, t).confirm;
  assert.deepEqual(q.map((c) => c.ids), [['i2']]);
  a.do((s) => answerItems(s, 'work', q[0].ids, 'bank', (t += MIN_MS)), t);
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  assert.deepEqual(view(b.state, t, addDays(D, -10)), view(a.state, t, addDays(D, -10)), 'X2');
  assert.equal(cashIn(a.state, t), 7000, 'i1 follows its payer into Cash in hand');
  assert.deepEqual(incomeQuestions(a.state, t).confirm, []);
});

test('A: a device that read for 600 days, with deposits a day after marking, and one that joins today agree on everything', async () => {
  const repo = sharedRepo();
  const T0 = NOW - 600 * DAY_MS;
  const amounts = [7000, 5550, 8000, 6400];
  const pays = [];
  for (let k = 0; T0 + k * 3 * DAY_MS < NOW - HOUR_MS; k++) {
    const at = T0 + k * 3 * DAY_MS + 7 * HOUR_MS;
    pays.push({ ...item('b' + k, PAYERS[k % 4].id, amounts[k % 4], at, gameDay(at - DAY_MS, 4)), ms: at, k });
  }
  // Avery's deposits come the next day, Quinn's a day later too but every fifth never comes (paid together)
  const rows = [];
  for (const p of pays) {
    const s = p.k % 4;
    if (s !== 0 && s !== 2) continue;
    if (s === 2 && p.k % 5 === 0) continue;
    const at = p.ms + DAY_MS;
    if (at <= NOW) rows.push({ id: 'r' + p.k, cents: p.cents, day: gameDay(at, 4), at });
  }
  const strip = ({ ms, k, ...rest }) => rest;
  const fileAt = (W) => fileText({ items: pays.filter((p) => p.ms <= W && p.ms >= W - 400 * DAY_MS).map(strip), from: iso(W - 400 * DAY_MS), writtenAt: iso(W) });
  const a = device(repo, baseState(T0));
  let next = 0;
  let n = 0;
  for (let W = T0 + 5 * DAY_MS; ; W = Math.min(NOW, W + 5 * DAY_MS)) {
    while (next < rows.length && rows[next].at <= W) { const r = rows[next++]; a.do((s) => addRow(s, r.id, r.cents, r.day, r.at), r.at); }
    a.do((s) => readText(s, fileAt(W), W, 's' + (n++)), W);
    if (W === T0 + 10 * DAY_MS) {
      a.do((s) => { answerPayer(s, 'work', 'p-rowan', 'cash', W); answerPayer(s, 'work', 'p-avery', 'bank', W); answerPayer(s, 'work', 'p-quinn', 'bank', W); }, W);
    }
    if (Math.abs(W - (T0 + 100 * DAY_MS)) < 3 * DAY_MS) a.do((s) => countCash(s, 20000, W), W);
    if (Math.abs(W - (NOW - 30 * DAY_MS)) < 3 * DAY_MS) a.do((s) => countCash(s, 15000, W), W);
    if (n % 4 === 0) await a.round(W + MIN_MS);
    if (W === NOW) break;
  }
  await a.round(NOW + MIN_MS);
  const b = device(repo, baseState(T0));
  b.do((s) => { for (const r of rows) addRow(s, r.id, r.cents, r.day, NOW); }, NOW);
  b.do((s) => readText(s, fileAt(NOW), NOW, 'sN'), NOW);
  let t = NOW + 2 * MIN_MS;
  for (let k = 0; k < 3; k++) { await b.round((t += MIN_MS)); await a.round((t += MIN_MS)); }
  for (const d of [a, b]) rebuildIncome(d.state, t);
  const floorDay = gameDay(NOW - 400 * DAY_MS, 4);
  const va = view(a.state, t, floorDay);
  assert.ok(Object.keys(a.state.income.pairs).length > 50);
  assert.ok(va.asked.late.length > 0, 'the combined deposits leave late questions');
  assert.deepEqual(view(b.state, t, floorDay), va);
});

test('A: switching a payer back and forth never changes the pairs or the figures (G1, G2 and the switching sequence)', () => {
  const s = longState();
  const d = NOW - 20 * DAY_MS;
  read(s, [item('i1', 'p-rowan', 7000, d), item('i2', 'p-rowan', 7000, d + 2 * DAY_MS), item('i3', 'p-rowan', 5000, NOW - DAY_MS)]);
  addRow(s, 'tx1', 7000, gameDay(d + 15 * DAY_MS, 4));
  addRow(s, 'tx2', 14000, gameDay(d + 2 * DAY_MS, 4));
  const pairs = pairsOf(s);
  assert.deepEqual([moveOf(s, 'i1').matchId, moveOf(s, 'i2').matchId], ['tx2', 'tx2'], 'the older row first, as a group');
  const figures = { live: live(s), closes: makeLedger(s, NOW).closes(addDays(TODAY, -25), TODAY).map((c) => c.smooth) };
  let t = NOW;
  for (const how of ['cash', 'bank', 'cash', 'bank', 'cash']) {
    answerPayer(s, 'work', 'p-rowan', how, (t += MIN_MS));
    assert.equal(pairsOf(s), pairs, how + ': the pairs hold');
    assert.deepEqual({ live: live(s), closes: makeLedger(s, NOW).closes(addDays(TODAY, -25), TODAY).map((c) => c.smooth) }, figures, how + ': counted once');
    assert.equal(cashIn(s), how === 'cash' ? 5000 : 0, how + ': only the open payment moves');
    assert.deepEqual(incomeQuestions(s, NOW).confirm.map((c) => c.ids), how === 'cash' ? [['i1', 'i2']] : []);
  }
  assert.equal(checkDoc(s), null);
});

test('A: a row dated before the game day of its source\'s floor is never matched', () => {
  const s = baseState();
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 60 * DAY_MS, payers: {}, items: {}, counts: [] } };
  const a = item('a', 'p-avery', 7000, NOW - 20 * DAY_MS);
  const b = item('b', 'p-avery', 7000, NOW - 12 * DAY_MS, gameDay(NOW - 19 * DAY_MS, 4));
  read(s, [a, b]);
  addRow(s, 'R', 7000, gameDay(NOW - 19 * DAY_MS, 4));
  assert.equal(moveOf(s, 'a').matchId, 'R');
  assert.equal(moveOf(s, 'b').matchId, null);
  const before = live(s);
  read(s, [b], NOW, 'sha2', { from: iso(NOW - 15 * DAY_MS) });
  assert.equal(rowOf(s, 'R').reportedAs, undefined, 'R lies before the floor: no payment takes it');
  // b was never confirmed and the floor cuts the days its deposit could lie on: it is taken as history (round 7)
  assert.equal(moveOf(s, 'b'), undefined, 'no move for b');
  assert.equal(live(s), before - 7000, 'its pencil leaves');
  assert.deepEqual(incomeQuestions(s, NOW).late, [], 'and nothing asks about it');
  // with no floor, no row is left out for it
  const t = baseState();
  t.income = structuredClone(s.income);
  t.txs.push(bankIn('R', 7000, gameDay(NOW - 19 * DAY_MS, 4)));
  read(t, [b], NOW, 'sha3');
  assert.equal(moveOf(t, 'b').matchId, 'R');
});

test('A: a payment that follows a cash answer may take another payer\'s equal row; it asks, and It was cash gives the row back', () => {
  const s = longState();
  s.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 30 * DAY_MS };
  read(s, [item('r1', 'p-rowan', 7000, NOW - 3 * DAY_MS), item('a1', 'p-avery', 7000, NOW - DAY_MS)]);
  const marked = live(s);
  addRow(s, 'R', 7000, TODAY);
  assert.equal(moveOf(s, 'a1').matchId, 'R', 'the payment marked nearest the row, whatever its payer answered');
  assert.equal(moveOf(s, 'r1').matchId, null);
  assert.equal(live(s), marked, 'the row counts once, for a1; r1 stays in pencil');
  assert.equal(cashIn(s), 0);
  const q = incomeQuestions(s, NOW).confirm;
  assert.deepEqual(q.map((c) => [c.row, c.ids]), [['R', ['a1']]]);
  answerItems(s, 'work', ['a1'], 'cash', NOW + MIN_MS);
  assert.equal(moveOf(s, 'r1').matchId, 'R', 'the row goes to the other payer\'s payment');
  assert.equal(moveOf(s, 'a1').matchId, null);
  assert.equal(cashIn(s), 7000);
  assert.equal(live(s), marked, 'still counted once each');
  assert.deepEqual(incomeQuestions(s, NOW).confirm, []);
});

test('A: the confirmation counts every member of the row, history ones included; its buttons answer only the payments that follow the cash answer', () => {
  const s = baseState();
  read(s, [item('h', 'p-avery', 4000, NOW - 9 * DAY_MS), item('c', 'p-avery', 3000, NOW - 5 * DAY_MS)]);
  assert.equal(incomeOf(s).shared.since, NOW - 7 * DAY_MS, 'h is history');
  addRow(s, 'R', 7000, gameDay(NOW - 4 * DAY_MS, 4));
  assert.deepEqual(s.income.pairs, { 'work/c': 'R', 'work/h': 'R' });
  answerPayer(s, 'work', 'p-avery', 'cash', NOW);
  let [q] = incomeQuestions(s, NOW).confirm;
  assert.deepEqual([q.ids, q.n, q.cents, q.bank.cents], [['c'], 2, 7000, 7000]);
  assert.deepEqual([q.asked.n, q.asked.cents, q.others.n, q.others.cents, q.others.earlier], [1, 3000, 1, 4000, true]);
  assert.equal(othersWords(q.others, false), 'with an earlier payment of $40.00');
  assert.equal(othersWords(q.others, true), 'with an earlier payment');
  // a member with its own Zelle answer is another member: the buttons leave it alone
  const g = longState();
  g.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 30 * DAY_MS };
  read(g, [item('i1', 'p-avery', 7000, NOW - 3 * DAY_MS), item('i2', 'p-avery', 7000, NOW - 2 * DAY_MS)]);
  addRow(g, 'b1', 14000, addDays(TODAY, -1));
  answerItems(g, 'work', ['i1'], 'bank', NOW);
  [q] = incomeQuestions(g, NOW).confirm;
  assert.deepEqual([q.ids, q.n, q.cents, q.others.n, q.others.earlier], [['i2'], 2, 14000, 1, true]);
  askAgain(g, 'work', 'i1', NOW + MIN_MS);
  [q] = incomeQuestions(g, NOW).confirm;
  assert.deepEqual([q.ids, q.others], [['i1', 'i2'], null]);
  assert.equal(othersWords({ n: 2, cents: 8000, earlier: false }, false), 'with 2 other payments, $80.00 in all');
});

/* ----------------------------------------------------------------- B. the file protocol */

test('B: a 404 for income/ is an empty listing only when the share round just read the shared file with the same key', async () => {
  const s = longState();
  const text = fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS)] });
  let listing = [{ name: 'work.json', sha: 'a'.repeat(40), size: text.length }];
  let access = false;
  const transport = { list: async () => listing, read: async () => text };
  const dev = { state: () => s, stale: () => false, access: () => access, update: (change) => change(s) };
  assert.equal((await roundIncome(dev, transport, NOW)).folder, 'listed');
  listing = null;
  let r = await roundIncome(dev, transport, NOW + MIN_MS);
  assert.deepEqual([r.ok, r.folder], [true, 'unseen']);
  assert.ok(moveOf(s, 'i1'), 'without proof of access a 404 drops nothing');
  assert.equal(Object.hasOwn(s.income.sources.work, 'missedAt'), false);
  access = true;
  r = await roundIncome(dev, transport, NOW + 2 * MIN_MS);
  assert.deepEqual([r.ok, r.folder], [true, 'none']);
  assert.equal(s.income.sources.work.missedAt, NOW + 2 * MIN_MS, 'the 24-hour clock starts');
  assert.equal(s.income.sources.work.readAt, NOW, 'a 404 is not a reading of the file');
  await roundIncome(dev, transport, NOW + 2 * MIN_MS + DAY_MS);
  assert.equal(moveOf(s, 'i1'), undefined, 'dropped after 24 hours');
  assert.deepEqual(Object.keys(s.income.sources), []);
});

test('B: a reading that returns no text is read again after RECHECK_MS; a file that does not parse stays refused by its sha', async () => {
  const s = longState();
  const good = fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS)] });
  let reads = 0;
  let give = null;
  const transport = { list: async () => [{ name: 'work.json', sha: 'b'.repeat(40), size: 100 }], read: async () => { reads++; return give; } };
  const dev = { state: () => s, stale: () => false, update: (change) => change(s) };
  await roundIncome(dev, transport, NOW);
  assert.equal(s.income.sources.work.recheckAt, NOW + RECHECK_MS);
  await roundIncome(dev, transport, NOW + RECHECK_MS - 1);
  assert.equal(reads, 1);
  give = good;
  await roundIncome(dev, transport, NOW + RECHECK_MS);
  assert.equal(reads, 2);
  assert.ok(moveOf(s, 'i1'));
  const t = longState();
  give = '{"format":';
  const devT = { state: () => t, stale: () => false, update: (change) => change(t) };
  await roundIncome(devT, transport, NOW);
  assert.equal(t.income.sources.work.recheckAt, null);
  await roundIncome(devT, transport, NOW + 2 * DAY_MS);
  assert.equal(reads, 3, 'a parse failure is cached by its sha');
});

test('B: a from after now is refused whatever writtenAt says, and the refusal is timed; a file that lists a payment before its own from is refused', () => {
  const items = [item('i1', 'p-avery', 7000, NOW - HOUR_MS)];
  const ahead = readIncomeFile(fileText({ items: [], from: iso(NOW + HOUR_MS), writtenAt: iso(NOW + 2 * HOUR_MS) }), NOW);
  assert.deepEqual([ahead.ok, ahead.timed], [false, true]);
  const unread = readIncomeFile(fileText({ items: [], from: iso(NOW + HOUR_MS), writtenAt: null }), NOW);
  assert.deepEqual([unread.ok, unread.timed], [false, true], 'with no time of writing too');
  assert.equal(readIncomeFile(fileText({ items: [], from: iso(NOW + HOUR_MS), writtenAt: iso(NOW + 2 * HOUR_MS) }), NOW + HOUR_MS).ok, true, 'read again later');
  const below = readIncomeFile(fileText({ items, from: iso(NOW - MIN_MS) }), NOW);
  assert.equal(below.ok, false);
  assert.equal(below.timed, undefined);
  assert.match(below.problem, /before the time the list starts from/);
  assert.equal(readIncomeFile(fileText({ items, from: iso(NOW - HOUR_MS) }), NOW).ok, true, 'on the floor itself is fine');
});

test('B: answers are stamped above the answer they replace, so a later switch on the same device always wins', () => {
  const s = longState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  const ahead = NOW + 5 * MIN_MS; // another device's clock runs ahead
  s.income.shared.payers['work/p-avery'] = { how: 'cash', at: ahead };
  s.income.shared.items['work/i1'] = { how: 'gone', at: ahead };
  answerPayer(s, 'work', 'p-avery', 'bank', NOW);
  assert.deepEqual(s.income.shared.payers['work/p-avery'], { how: 'bank', at: ahead + 1 });
  answerItems(s, 'work', ['i1'], 'wait', NOW + 0.4);
  assert.deepEqual(s.income.shared.items['work/i1'], { how: 'wait', at: ahead + 1, until: NOW + 0.4 + 4 * DAY_MS }, 'until keeps its meaning');
  answerItems(s, 'work', ['i9'], 'cash', NOW + 0.4);
  assert.equal(s.income.shared.items['work/i9'].at, NOW, 'rounded, with nothing to stay above');
});

/* -------------------------------------------------------------------- D. the screens */

test('D1: every kind of own answer has a reachable Ask again: cash, gone, wait, and bank from a confirmation', () => {
  const s = longState();
  s.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 30 * DAY_MS };
  s.income.shared.payers['work/p-rowan'] = { how: 'bank', at: NOW - 30 * DAY_MS };
  read(s, [item('c', 'p-rowan', 1000, NOW - 6 * DAY_MS), item('g', 'p-rowan', 2000, NOW - 6 * DAY_MS), item('w', 'p-rowan', 3000, NOW - 6 * DAY_MS),
    item('z', 'p-avery', 4000, NOW - 2 * DAY_MS)]);
  addRow(s, 'R', 4000, addDays(TODAY, -1));
  answerItems(s, 'work', ['c'], 'cash', NOW);
  answerItems(s, 'work', ['g'], 'gone', NOW);
  answerItems(s, 'work', ['w'], 'wait', NOW);
  answerItems(s, 'work', ['z'], 'bank', NOW);
  // where the views offer Ask again: a listed move's sheet (an unmatched move), a bank row's sheet, Settings' "in the bank" list
  const places = (key) => {
    const out = [];
    const shared = incomeOf(s).shared;
    if (!itemAnswer(shared, key)) return out;
    if (s.txs.some((tx) => tx.via === 'income' && !tx.matchId && tx.income.key === key)) out.push('sheet');
    for (const tx of s.txs) if (tx.source === 'bank' && tx.reportedAs && rowPayments(s, tx.id).some((p) => p.key === key && p.own)) out.push('row');
    if (incomePayments(s, 4).some((p) => p.key === key && p.how === 'gone')) out.push('settings');
    return out;
  };
  assert.deepEqual(['c', 'g', 'w', 'z'].map((id) => places('work/' + id)), [['sheet'], ['settings'], ['sheet'], ['row']]);
  const [z] = rowPayments(s, 'R');
  assert.deepEqual([z.key, z.label, z.cents, z.marked, z.own], ['work/z', 'Session · Avery', 4000, gameDay(NOW - 2 * DAY_MS, 4), 'bank']);
});

test('D3: the before-count toast reads the figure after the answer and says "stays" only when nothing came after the count', () => {
  const s = longState();
  read(s, [item('e', 'p-rowan', 125000, NOW - DAY_MS)]);
  countCash(s, 10000, NOW - HOUR_MS);
  const had = new Set();
  answerPayer(s, 'work', 'p-rowan', 'cash', NOW);
  const value = cashAccountOf(s).balance;
  assert.equal(value, 10000);
  assert.equal(payerWords('Rowan', 'cash', beforeCountWords(s, had, value, TODAY, false, 'payer')),
    'Rowan pays in cash. Their $1,250.00 was marked before today’s count, so Cash in hand stays $100.00. Change it in Settings.');
  assert.equal(payerWords('Rowan', 'cash', beforeCountWords(s, had, value, TODAY, true, 'payer')),
    'Rowan pays in cash. Their payment was marked before today’s count, so Cash in hand stays as counted. Change it in Settings.');
  // one payment before the count and one after: the figure moves, so the normal words and the figure now
  const t = longState();
  read(t, [item('e', 'p-rowan', 125000, NOW - DAY_MS), item('f', 'p-rowan', 5000, NOW - 30 * MIN_MS)]);
  countCash(t, 10000, NOW - HOUR_MS);
  answerPayer(t, 'work', 'p-rowan', 'cash', NOW);
  const after = cashAccountOf(t).balance;
  assert.equal(after, 15000);
  assert.equal(payerWords('Rowan', 'cash', beforeCountWords(t, had, after, TODAY, false, 'payer')),
    'Rowan pays in cash: it counts in Cash in hand. Cash in hand is now $150.00. Change it in Settings.');
  assert.equal(payerWords('Rowan', 'cash', beforeCountWords(t, had, after, TODAY, true, 'payer')),
    'Rowan pays in cash: it counts in Cash in hand. Change it in Settings.');
});

test('D4: one rule for the estimate sign: roman only when the figure is the latest count', () => {
  const s = longState();
  assert.equal(isCountedCash(s, 0), false, 'never counted');
  countCash(s, 12000, NOW - HOUR_MS);
  assert.equal(isCountedCash(s, 12000), true);
  assert.equal(isCountedCash(s, 12500), false);
});

test('D5: Material\'s note says where the money in Cash in hand comes from', () => {
  const s = longState();
  assert.equal(cashNoteWords(s, 13000, false), '$130.00 of it from payments marked as cash');
  countCash(s, 12000, NOW - HOUR_MS);
  assert.equal(cashNoteWords(s, 13000, false), '$130.00 of it from your count of $120.00 and payments marked as cash since', 'round 5: not all of it was counted');
  assert.equal(cashNoteWords(s, 12000, false), '$120.00 of it counted by you');
  assert.equal(cashNoteWords(s, 0, false), '');
});

test('D6, D8, D9: the Ask again toast, the group words and the removal toast', () => {
  const s = longState();
  read(s, [item('e', 'p-rowan', 5000, NOW - DAY_MS), item('p', 'p-avery', 7000, NOW - 28 * HOUR_MS)]);
  s.income.shared.payers['work/p-rowan'] = { how: 'cash', at: NOW - DAY_MS };
  s.income.shared.payers['work/p-avery'] = { how: 'bank', at: NOW - DAY_MS };
  s.income.shared.items['work/e'] = { how: 'gone', at: NOW - DAY_MS };
  countCash(s, 10000, NOW - HOUR_MS);
  askAgain(s, 'work', 'e', NOW);
  assert.equal(againWords(s, 'work/e', NOW, null), 'Session · Rowan: it was marked before today’s count, so Cash in hand stays $100.00.');
  s.settings.cover = true;
  assert.equal(againWords(s, 'work/e', NOW, null), 'Session · Rowan: it was marked before today’s count, so Cash in hand stays as counted.', 'it is the count');
  s.settings.cover = false;
  answerItems(s, 'work', ['p'], 'gone', NOW);
  askAgain(s, 'work', 'p', NOW + MIN_MS);
  assert.match(againWords(s, 'work/p', NOW, null), /^Session · Avery: it counts in pencil again; Networth asks on .+ if the bank has not shown it\.$/, 'gone came from pencil');
  assert.match(againWords(s, 'work/p', NOW, 'pencil'), /^Session · Avery: it still counts in pencil; Networth asks on /);
  const t = longState();
  t.income.shared.payers['work/p-rowan'] = { how: 'cash', at: NOW - DAY_MS };
  read(t, [item('f', 'p-rowan', 5000, NOW - 30 * MIN_MS)]);
  answerItems(t, 'work', ['f'], 'gone', NOW);
  askAgain(t, 'work', 'f', NOW + MIN_MS);
  assert.equal(againWords(t, 'work/f', NOW, null), 'Session · Rowan: it counts in Cash in hand now.', 'never in Cash in hand before: no "again"');
  assert.equal(confirmWords('Session · Ivy', 2, 'cash', null), 'Session · Ivy: 2 payments were cash; they count in Cash in hand. Ask again from each payment.');
  assert.equal(confirmWords('Session · Ivy', 2, 'bank', null), 'Session · Ivy: 2 payments came by Zelle; the bank’s row counts for them. Ask again from each payment.');
  assert.equal(removedWords(17500, false), 'The latest count is removed: Cash in hand is $175.00. Count again to correct it.');
  assert.equal(removedWords(17500, true), 'The latest count is removed. Count again to correct it.');
});

test('D7: a payer answer that raises a confirmation question says so', () => {
  assert.equal(payerWords('Avery', 'cash', null, { cents: 7000, day: '2026-11-11' }, false),
    'Avery pays in cash: it counts in Cash in hand. Networth asks about the $70.00 of Nov 11 on the board. Change it in Settings.');
  assert.equal(payerWords('Avery', 'cash', null, { cents: 7000, day: '2026-11-11' }, true),
    'Avery pays in cash: it counts in Cash in hand. Networth asks about the deposit of Nov 11 on the board. Change it in Settings.');
  assert.equal(payerWords('Avery', 'cash', null, { cents: 7000, day: '2026-11-11' }, false, 0),
    'Avery pays in cash. Networth asks about the $70.00 of Nov 11 on the board. Change it in Settings.', 'nothing went into Cash in hand');
});

test('D2, D4, D10 and B1 in the views: one estimate rule, the removal under the figure, the field error named, a 404 is no reading', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = async (path) => readFile(new URL('../js/' + path, import.meta.url), 'utf8');
  for (const file of ['views/board.js', 'views/material.js', 'views/settings.js', 'views/sheet-account.js']) {
    assert.match(await src(file), /isCountedCash\(/, file + ' uses the one rule for the estimate sign');
  }
  const account = await src('views/sheet-account.js');
  const actions = account.slice(account.indexOf('function cashForm'), account.indexOf('/* -------------------------------------------------------------- bank account */'));
  assert.match(actions, /<span class="acct-uncount"><button class="btn-link"[^>]*data-action="account\.uncount"/, 'Remove the latest count is a link under the figure');
  assert.doesNotMatch(actions.slice(actions.indexOf('<div class="sheet-actions">')), /account\.uncount/, 'the actions row keeps Close | Count it');
  assert.match(actions, /'aria-describedby': errors\.value \? 'acct-cash-error' : null/);
  assert.match(actions, /<span class="field-error" id="acct-cash-error">/);
  const tx = await src('views/sheet-tx.js');
  assert.match(tx, /data-action="tx\.income-again" aria-describedby="\$\{id\}"/, 'the sheet\'s Ask again is described by its line');
  const reader = await src('income.js');
  assert.match(reader, /access: \(\) => shareSawFile\(gen\)/);
  assert.match(reader, /if \(result\.folder === 'listed'\) live\.readAt = nowMs\(\);/, 'a 404 sets no readAt');
});

test('round 7: when the floor passes a deposit but not yet its payment, the payment is history, never counted twice', () => {
  for (const lag of [1, 2, 3, 5, 9]) {
    const s = baseState();
    s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 60 * DAY_MS, payers: {}, items: {}, counts: [] } };
    // D arrives 30 days ago; P (a session that day) is marked `lag` days later and matches D
    const dDay = gameDay(NOW - 30 * DAY_MS, 4);
    const P = item('P', 'p-avery', 6400, NOW - (30 - lag) * DAY_MS, dDay);
    read(s, [P]);
    addRow(s, 'D', 6400, dDay);
    assert.equal(moveOf(s, 'P').matchId, 'D', lag + ': matched');
    const counted = live(s);
    // the floor moves to the day after D: D can no longer be matched, P is still listed above the floor
    read(s, [P], NOW, 'sha2', { from: iso(NOW - 29 * DAY_MS) });
    assert.equal(live(s), counted, lag + ': the figure does not move (D still counts, P is history)');
    assert.equal(moveOf(s, 'P'), undefined, lag + ': no move for P');
    const q = incomeQuestions(s, NOW);
    assert.deepEqual([q.payers.length, q.late.length, q.confirm.length], [0, 0, 0], lag + ': nothing asks about it');
  }
});

test('round 7: a payment well above the floor is untouched by it', () => {
  const s = baseState();
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 60 * DAY_MS, payers: {}, items: {}, counts: [] } };
  const P = item('P', 'p-avery', 6400, NOW - 2 * DAY_MS);
  read(s, [P], NOW, 'sha1', { from: iso(NOW - 30 * DAY_MS) });
  assert.ok(moveOf(s, 'P'), 'counted in pencil');
  assert.equal(moveOf(s, 'P').matchId, null);
});
