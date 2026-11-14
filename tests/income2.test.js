/**
 * Income reported by another app (ARCHITECTURE 3.7), the second round: matching by the bank's evidence (history
 * payments as claimants, the window from the session's day, the confirmation question), the inputs of
 * the matching, the file's `from` floor, the caps and Ask again. Every payer, amount, label
 * and account here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INCOME_FORMAT, MAX_ITEM_ANSWERS, answerItem, answerPayer, askAgain, isIdleCash, applyIncomeReading, cashAccountOf, countCash, incomeMoveId,
  incomeQuestions, mergeIncomeShared, readIncomeFile, rebuildIncome,
} from '../js/model/income.js';
import { checkDoc, defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { makeLedger } from '../js/model/ledger.js';
import { refresh } from '../js/model/detect.js';
import { roundShared } from '../js/model/share.js';
import { addDays, gameDay } from '../js/model/dates.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MIN_MS = 60000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const TODAY = gameDay(NOW, 4);
const iso = (ms) => new Date(ms).toISOString();

function fileText({ what = 'Session', payers = [{ id: 'p-avery', name: 'Avery' }, { id: 'p-rowan', name: 'Rowan' }], items = [], from, writtenAt = iso(NOW) } = {}) {
  const doc = { format: INCOME_FORMAT, what, writtenAt, payers, items };
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
function bankIn(id, cents, day, extra = {}) {
  return makeTx({ id, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', kind: 'income', category: 'income', raw: 'ZELLE FROM SOMEONE', merchant: 'Zelle', mkey: 'zelle from', fp: 'acc_chk|' + day + '|' + id, ...extra });
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

/* ------------------------------------------------------- A. matching */

test('A: a weekly payer: each payment counts in pencil until its own row arrives, and marking never lowers net worth', () => {
  const s = baseState();
  for (let w = 8; w >= 1; w--) {
    const day = gameDay(NOW - w * 7 * DAY_MS + DAY_MS, 4);
    s.txs.push(bankIn('r' + w, 12000, day, { raw: 'ZELLE FROM AVERY', merchant: 'Zelle Avery', mkey: 'zelle from avery' }));
  }
  refresh(s, NOW);
  assert.deepEqual(s.streams.map((x) => x.accrue), [true]);
  const before = live(s);
  const old = item('old', 'p-avery', 12000, NOW - 8 * DAY_MS);
  const w0 = item('w0', 'p-avery', 12000, NOW - HOUR_MS, TODAY);
  read(s, [old, w0]);
  refresh(s, NOW);
  assert.equal(rowOf(s, 'r1').reportedAs, 'Session · Avery', 'the history payment takes its own row');
  assert.equal(moveOf(s, 'old'), undefined, 'a history payment makes no move');
  assert.equal(moveOf(s, 'w0').matchId, null, 'the new payment is not met by last week\'s row');
  assert.deepEqual(s.streams.map((x) => x.accrue), [false], 'a row a history payment claimed turns the accrual off');
  const p1 = makeLedger(s, NOW).position();
  assert.equal(p1.provisionalIn, 12000);
  assert.ok(p1.live >= before, 'marking never lowers net worth: ' + before + ' -> ' + p1.live);
  // the next day its own row arrives
  const n2 = NOW + DAY_MS;
  s.txs.push(bankIn('r0', 12000, gameDay(n2, 4), { raw: 'ZELLE FROM AVERY', merchant: 'Zelle Avery', mkey: 'zelle from avery' }));
  refresh(s, n2);
  assert.equal(moveOf(s, 'w0').matchId, 'r0');
  assert.equal(rowOf(s, 'r1').reportedAs, 'Session · Avery');
  // a week later the next one is marked: it counts in pencil, it does not take last week's row
  const n3 = NOW + 7 * DAY_MS;
  const liveBefore = live(s, n3);
  read(s, [old, w0, item('w7', 'p-avery', 12000, n3 - HOUR_MS, gameDay(n3, 4))], n3, 'sha2');
  refresh(s, n3);
  assert.equal(moveOf(s, 'w0').matchId, 'r0');
  assert.equal(moveOf(s, 'w7').matchId, null);
  assert.equal(live(s, n3) - liveBefore, 12000);
});

test('A: a weekly payer with an unmarked earlier deposit: the new payment does not take it', () => {
  const s = longState();
  s.txs.push(bankIn('tx_prev', 7000, addDays(TODAY, -7)));
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS, TODAY), item('i2', 'p-rowan', 7000, NOW - HOUR_MS, addDays(TODAY, -2))]);
  assert.equal(moveOf(s, 'i1').matchId, null);
  assert.equal(moveOf(s, 'i2').matchId, null, 'three days before the session at the most');
  assert.equal(rowOf(s, 'tx_prev').reportedAs, undefined);
});

test('A: a payment marked late, after its own deposit, is matched to it', () => {
  const s = longState();
  const session = addDays(TODAY, -6);
  s.txs.push(bankIn('tx_dep', 7000, addDays(session, 1)));
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS, session)]);
  assert.equal(moveOf(s, 'i1').matchId, 'tx_dep');
});

/** A payer answered cash; one of their payments without an answer of its own meets a bank row of its exact cents. */
function guessed() {
  const s = longState();
  s.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW - 10 * DAY_MS };
  read(s, [item('i1', 'p-avery', 7000, NOW - 2 * DAY_MS)]);
  assert.equal(cashIn(s), 7000);
  const liveCash = live(s);
  s.txs.push(bankIn('tx_z', 7000, addDays(TODAY, -1)));
  s.accounts[0].balance += 7000;
  rebuildIncome(s, NOW);
  return { s, liveCash };
}

test('A: a payment that follows its payer\'s cash answer and meets a bank row counts once, as the row, and is asked about', () => {
  const { s, liveCash } = guessed();
  assert.equal(moveOf(s, 'i1').matchId, 'tx_z');
  assert.equal(cashIn(s), 0, 'not in Cash in hand while the question is open');
  assert.equal(live(s), liveCash, 'counted once');
  assert.equal(rowOf(s, 'tx_z').reportedAs, 'Session · Avery');
  const q = incomeQuestions(s, NOW).confirm;
  assert.equal(q.length, 1);
  assert.equal(q[0].label, 'Session · Avery');
  assert.deepEqual(q[0].bank, { cents: 7000, day: addDays(TODAY, -1) });
  // It came by Zelle
  const z = structuredClone(s);
  answerItem(z, 'work', 'i1', 'bank', NOW + MIN_MS);
  assert.equal(moveOf(z, 'i1').matchId, 'tx_z');
  assert.equal(moveOf(z, 'i1').income.how, 'bank');
  assert.deepEqual(incomeQuestions(z, NOW).confirm, []);
  assert.equal(live(z), liveCash);
  // It was cash: never matched again
  const c = structuredClone(s);
  answerItem(c, 'work', 'i1', 'cash', NOW + MIN_MS);
  rebuildIncome(c, NOW + 2 * MIN_MS);
  assert.equal(moveOf(c, 'i1').matchId, null);
  assert.equal(cashIn(c), 7000);
  assert.equal(rowOf(c, 'tx_z').reportedAs, undefined);
  assert.deepEqual(incomeQuestions(c, NOW).confirm, []);
  assert.equal(checkDoc(s), null);
});

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
/** A device that runs share rounds; an answer is made directly. */
function roundDevice(repo, state) {
  const d = { state };
  const api = { state: () => d.state, update: (now) => { now(d.state); } };
  d.change = (fn) => { fn(d.state); };
  d.round = async (nowMs) => {
    const r = await roundShared(api, repo.transport, () => nowMs);
    assert.equal(checkDoc(d.state), null);
    return r;
  };
  return d;
}

test('A: S9, a payer answered cash on a device without the bank row: no device counts a payment twice', async () => {
  const repo = sharedRepo();
  const at = NOW - 2 * DAY_MS;
  const items = [item('i1', 'p-avery', 7000, at), item('i2', 'p-avery', 7000, NOW - HOUR_MS)];
  const sa = longState();
  sa.txs.push(bankIn('b1', 7000, gameDay(at + DAY_MS, 4)));
  read(sa, items);
  const sb = longState();
  read(sb, items);
  const a = roundDevice(repo, sa);
  const b = roundDevice(repo, sb);
  assert.equal(moveOf(a.state, 'i1').matchId, 'b1');
  const liveA = live(a.state);
  let t = NOW;
  b.change((s) => answerPayer(s, 'work', 'p-avery', 'cash', (t += MIN_MS)));
  await b.round((t += MIN_MS));
  await a.round((t += MIN_MS));
  assert.equal(moveOf(a.state, 'i1').matchId, 'b1', 'on A the payment stays with its row');
  assert.equal(live(a.state), liveA, 'A counts it once');
  assert.equal(cashIn(a.state), 7000, 'only i2 follows the cash answer');
  assert.deepEqual(incomeQuestions(a.state, t).confirm.map((q) => q.ids), [['i1']], 'A asks to confirm its guess');
  // B gets the row: it counts it once too, and asks
  b.state.txs.push(bankIn('b1', 7000, gameDay(at + DAY_MS, 4)));
  rebuildIncome(b.state, t);
  for (let k = 0; k < 2; k++) { await a.round((t += MIN_MS)); await b.round((t += MIN_MS)); }
  assert.equal(live(b.state), live(a.state));
  assert.equal(cashIn(b.state), 7000);
  assert.equal(moveOf(b.state, 'i1').matchId, 'b1');
  assert.deepEqual(incomeQuestions(b.state, t).confirm.map((q) => q.ids), [['i1']]);
});

/* ------------------------------------------------ B. the matching's inputs */

test('B: the ledger counts a payment in pencil when its row is a pending row that does not count, hidden, or missing', () => {
  const s = longState();
  read(s, [item('i1', 'p-avery', 7000, NOW - 2 * DAY_MS)]);
  s.txs.push(bankIn('tx1', 7000, addDays(TODAY, -1), { pending: true }));
  rebuildIncome(s, NOW);
  assert.equal(moveOf(s, 'i1').matchId, 'tx1');
  const bank = s.accounts[0].balance;
  assert.equal(live(s), bank + 7000, 'the pending row counts and confirms it');
  // the switch goes off without a rebuild: the payment counts in pencil
  s.settings.countPending = false;
  assert.equal(makeLedger(s, NOW).position().live - makeLedger(s, NOW).position().bank, 7000);
  // and the rebuild agrees
  rebuildIncome(s, NOW);
  assert.equal(moveOf(s, 'i1').matchId, null);
  assert.equal(makeLedger(s, NOW).position().live - bank, 7000);
  // on again: the pending row counts and confirms it
  s.settings.countPending = true;
  rebuildIncome(s, NOW);
  assert.equal(moveOf(s, 'i1').matchId, 'tx1');
  assert.equal(live(s), bank + 7000);
  // the account that holds the row is hidden: the payment counts in pencil, before and after the rebuild
  const t = longState();
  read(t, [item('i1', 'p-avery', 7000, NOW - 2 * DAY_MS)]);
  t.txs.push(bankIn('tx1', 7000, addDays(TODAY, -1)));
  rebuildIncome(t, NOW);
  t.accounts[0].hidden = true;
  assert.equal(makeLedger(t, NOW).position().provisionalIn, 7000);
  rebuildIncome(t, NOW);
  assert.equal(moveOf(t, 'i1').matchId, null);
  // the row is gone
  const u = longState();
  read(u, [item('i1', 'p-avery', 7000, NOW - 2 * DAY_MS)]);
  u.txs.push(bankIn('tx1', 7000, addDays(TODAY, -1)));
  rebuildIncome(u, NOW);
  u.txs = u.txs.filter((tx) => tx.id !== 'tx1');
  assert.equal(makeLedger(u, NOW).position().provisionalIn, 7000);
});

/* --------------------------------------------------------- C. from */

test('C: from is read and checked like at', () => {
  const items = [item('i1', 'p-avery', 7000, NOW - HOUR_MS)];
  assert.equal(readIncomeFile(fileText({ items, from: iso(NOW - 400 * DAY_MS) }), NOW).from, NOW - 400 * DAY_MS);
  assert.equal(readIncomeFile(fileText({ items }), NOW).from, null);
  for (const bad of ['soon', '2026-11-14T01:30:00', iso(NOW + 3 * DAY_MS), 12]) {
    assert.equal(readIncomeFile(fileText({ items, from: bad, writtenAt: iso(NOW + 4 * DAY_MS) }), NOW).ok, false, String(bad));
  }
  // not after writtenAt
  assert.equal(readIncomeFile(fileText({ items, from: iso(NOW + MIN_MS), writtenAt: iso(NOW) }), NOW).ok, false);
});

/* ------------------------------------------------------------ D. caps */

test('D: at the cap an answer that superseded another never lets the older one come back (merge laws)', () => {
  const big = {};
  for (let i = 0; i < MAX_ITEM_ANSWERS - 1; i++) big['w/k' + i] = { how: 'bank', at: 1000 + i };
  const a = { items: { ...big, 'w/x': { how: 'gone', at: 900 } } };
  const b = { items: { 'w/y': { how: 'cash', at: 950 } } };
  const c = { items: { 'w/x': { how: 'cash', at: 100 } } };
  const ab = mergeIncomeShared(mergeIncomeShared(a, b), c);
  const bc = mergeIncomeShared(a, mergeIncomeShared(b, c));
  assert.deepEqual(ab, bc);
  assert.notEqual(ab.items['w/x'] && ab.items['w/x'].how, 'cash', 'the older cash does not come back');
  assert.deepEqual(mergeIncomeShared(ab, ab), ab);
});

/* ------------------------------------------------------- E. smaller items */

test('E1: the stored Cash in hand figure agrees with the ledger: counts in one millisecond', () => {
  const s = longState();
  countCash(s, 13000, NOW);
  countCash(s, 4000, NOW);
  const acc = cashAccountOf(s);
  assert.equal(acc.balance, 4000);
  assert.equal(cashIn(s), 4000);
});

test('E9: Ask again takes back a payment\'s own answer, through the shared answers', () => {
  const s = longState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  answerItem(s, 'work', 'i1', 'gone', NOW);
  assert.equal(moveOf(s, 'i1'), undefined);
  assert.equal(askAgain(s, 'work', 'i1', NOW + MIN_MS), true);
  assert.equal(s.income.shared.items['work/i1'].how, 'none');
  assert.equal(moveOf(s, 'i1').income.how, 'ask', 'it counts again and its payer is asked');
  assert.equal(askAgain(s, 'work', 'i1', NOW + 2 * MIN_MS), false, 'nothing to take back');
});

test('E2: an idle Cash in hand (no count, no cash payment, 0) is hidden the same way on every device, after a switch back too', async () => {
  const repo = sharedRepo();
  const items = [item('i1', 'p-avery', 7000, NOW - 2 * HOUR_MS)];
  const ds = [longState(), longState()].map((s) => { read(s, items); return roundDevice(repo, s); });
  const [a, b] = ds;
  let t = NOW;
  a.change((s) => answerPayer(s, 'work', 'p-avery', 'cash', (t += MIN_MS)));
  await a.round((t += MIN_MS));
  await b.round((t += MIN_MS));
  assert.equal(isIdleCash(b.state, cashAccountOf(b.state)), false, 'a cash payment: shown');
  a.change((s) => answerPayer(s, 'work', 'p-avery', 'bank', (t += MIN_MS)));
  for (let k = 0; k < 2; k++) for (const d of ds) await d.round((t += MIN_MS));
  for (const d of ds) {
    const acc = cashAccountOf(d.state);
    assert.ok(!acc || isIdleCash(d.state, acc), 'no device shows an empty Cash in hand');
  }
  const c = longState();
  countCash(c, 0, NOW);
  assert.equal(isIdleCash(c, cashAccountOf(c)), false, 'a count of 0 is still a count: shown');
});
