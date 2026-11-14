/**
 * Income that the owner's other apps report (ARCHITECTURE 3.7): the file check, how a payment was paid,
 * `since`, matching a transfer to its bank row, the moves in the engine, Cash in hand, the questions,
 * the shared answers and the colours. Every payer, amount, label and account here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INCOME_FORMAT, LATE_MS, MAX_COUNTS, MAX_ITEM_ANSWERS, MAX_PAYER_ANSWERS, SINCE_BACK_MS, WAIT_MS, answerItem, answerPayer,
  applyIncomeReading, cashAccountOf, countCash, howOf, incomeMoveId, incomeQuestions, incomeRowLabels,
  matchIncome, mergeIncomeShared, readIncomeFile, readIncomeShared, rebuildIncome, roundIncome, sourceIdOf,
} from '../js/model/income.js';
import { ShareError, incomeUrl, listIncome, readIncomeText } from '../js/github.js';
import { checkDoc, defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { makeLedger } from '../js/model/ledger.js';
import { refresh } from '../js/model/detect.js';
import { cashFlowOf } from '../js/model/cashflow.js';
import { recentTransactions } from '../js/model/recent.js';
import { exportShared, mergeShared, readSharedFile, applyShared, sharedChanges, roundShared } from '../js/model/share.js';
import { addDays, gameDay } from '../js/model/dates.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const TODAY = gameDay(NOW, 4);
const iso = (ms) => new Date(ms).toISOString();

function fileText({ what = 'Session', payers = [{ id: 'p-avery', name: 'Avery' }, { id: 'p-rowan', name: 'Rowan' }], items = [] } = {}) {
  return JSON.stringify({ format: INCOME_FORMAT, what, writtenAt: iso(NOW), payers, items });
}

function item(id, payer, cents, atMs, day) {
  return { id, payer, cents, day: day || gameDay(atMs, 4), at: iso(atMs) };
}

/** A record with one checking account at the bank, read just now. */
function baseState() {
  const s = defaultState(NOW);
  s.meta.origin = 'bank';
  s.sync.lastOk = NOW;
  s.sync.from = addDays(TODAY, -200);
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'x1', conn: 'c1' } }));
  return s;
}

function bankIn(id, cents, day, extra = {}) {
  return makeTx({ id, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', kind: 'income', category: 'income', raw: 'ZELLE FROM SOMEONE', merchant: 'Zelle', mkey: 'zelle from', fp: 'acc_chk|' + day + '|' + cents + '|zelle#0', ...extra });
}

/** Read one source, `work` (the file income/work.json). */
function read(state, items, nowMs = NOW, sha = 'sha1', extra = {}) {
  return applyIncomeReading(state, { listed: [{ source: 'work', sha }], files: { work: { sha, text: fileText({ items, ...extra }) } } }, nowMs);
}

const movesOf = (s) => s.txs.filter((tx) => tx.via === 'income');

/* ------------------------------------------------------------- the file */

test('a good file is read', () => {
  const r = readIncomeFile(fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS, '2026-11-13')] }), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.what, 'Session');
  assert.deepEqual(r.payers.map((p) => p.name), ['Avery', 'Rowan']);
  assert.deepEqual(r.items[0], { id: 'i1', payer: 'p-avery', cents: 7000, day: '2026-11-13', at: NOW - HOUR_MS });
  assert.equal(sourceIdOf('work.json'), 'work');
  assert.equal(sourceIdOf('work.txt'), null);
  assert.equal(sourceIdOf('../x.json'), null);
  // unknown fields are ignored
  const extra = JSON.parse(fileText({ items: [item('i1', 'p-avery', 7000, NOW)] }));
  extra.colour = 'blue';
  extra.items[0].note = 'x';
  assert.equal(readIncomeFile(JSON.stringify(extra), NOW).ok, true);
});

test('each broken rule refuses the whole file, in plain words', () => {
  const good = () => JSON.parse(fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS)] }));
  const broken = [
    (f) => { f.format = 'income/2'; },
    (f) => { f.what = ''; },
    (f) => { f.what = 'x'.repeat(41); },
    (f) => { f.payers = Array.from({ length: 501 }, (_, i) => ({ id: 'p' + i, name: 'N' })); },
    (f) => { f.payers[0].id = 'bad id'; },
    (f) => { f.payers[1].id = 'p-avery'; },
    (f) => { f.payers[0].name = '   '; },
    (f) => { f.payers[0].name = 'x'.repeat(61); },
    (f) => { f.items = Array.from({ length: 5001 }, (_, i) => ({ ...f.items[0], id: 'i' + i })); },
    (f) => { f.items[0].id = 'x'.repeat(81); },
    (f) => { f.items.push({ ...f.items[0] }); },
    (f) => { f.items[0].payer = 'p-nobody'; },
    (f) => { f.items[0].cents = 0; },
    (f) => { f.items[0].cents = 100000001; },
    (f) => { f.items[0].cents = 70.5; },
    (f) => { f.items[0].day = '2026-13-01'; },
    (f) => { f.items[0].at = 'yesterday'; },
    (f) => { f.items[0].at = '1999-12-31T23:59:59.000Z'; },
    (f) => { f.items[0].at = iso(NOW + 2 * DAY_MS + 1000); },
  ];
  for (const breakIt of broken) {
    const f = good();
    breakIt(f);
    const r = readIncomeFile(JSON.stringify(f), NOW);
    assert.equal(r.ok, false, JSON.stringify(f).slice(0, 120));
    assert.equal(typeof r.problem, 'string');
  }
  assert.equal(readIncomeFile('not json', NOW).ok, false);
  // a time is read the same way everywhere: with its offset, never as local time
  const zoned = good();
  zoned.items[0].at = '2026-11-14T01:30:00.123456+01:00';
  assert.equal(readIncomeFile(JSON.stringify(zoned), NOW).items[0].at, Date.UTC(2026, 10, 14, 0, 30, 0, 123));
  for (const bad of ['2026-11-14T01:30:00', '2026-11-31T01:30:00Z', '2026-11-14T24:00:00Z', '2026-11-14 01:30:00Z']) {
    const f = good();
    f.items[0].at = bad;
    assert.equal(readIncomeFile(JSON.stringify(f), NOW).ok, false, bad);
  }
  assert.equal(readIncomeFile(' '.repeat(1000001), NOW).ok, false);
  // the edges that pass
  const edge = good();
  edge.items[0].at = iso(NOW + 2 * DAY_MS);
  edge.what = 'x'.repeat(40);
  assert.equal(readIncomeFile(JSON.stringify(edge), NOW).ok, true);
});

test('a refused file keeps the last good copy and says why; a source missed by the listing for 24 hours is dropped with its moves', () => {
  const s = baseState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  assert.equal(movesOf(s).length, 1);
  applyIncomeReading(s, { listed: [{ source: 'work', sha: 'sha2' }], files: { work: { sha: 'sha2', text: '{"format":"income/9"}' } } }, NOW);
  assert.equal(s.income.sources.work.sha, 'sha1');
  assert.match(s.income.sources.work.problem, /format/);
  assert.equal(movesOf(s).length, 1);
  applyIncomeReading(s, { listed: [], files: {} }, NOW);
  assert.equal(movesOf(s).length, 1, 'missed once: kept');
  applyIncomeReading(s, { listed: [], files: {} }, NOW + DAY_MS);
  assert.deepEqual(Object.keys(s.income.sources), []);
  assert.equal(movesOf(s).length, 0);
});

/* ------------------------------------------------------------- since, how */

test('since is the first valid reading less 7 days, and the earlier device wins', () => {
  const s = baseState();
  read(s, [item('old', 'p-avery', 5000, NOW - 8 * DAY_MS), item('new', 'p-avery', 7000, NOW - 6 * DAY_MS)]);
  assert.equal(s.income.shared.since, NOW - SINCE_BACK_MS);
  assert.deepEqual(movesOf(s).map((tx) => tx.amount), [7000]);
  // a later reading does not move it
  read(s, [item('old', 'p-avery', 5000, NOW - 8 * DAY_MS)], NOW + 5 * DAY_MS, 'sha9');
  assert.equal(s.income.shared.since, NOW - SINCE_BACK_MS);
  assert.equal(mergeIncomeShared({ since: 50 }, { since: 40 }).since, 40);
  assert.equal(mergeIncomeShared({ since: null }, { since: 40 }).since, 40);
});

test('how: the item\'s own answer (wait: still coming by transfer), then the payer\'s, then ask; history before since', () => {
  const shared = { since: 1000, payers: { 'w/p1': { how: 'cash', at: 1 } }, items: { 'w/a': { how: 'gone', at: 1 }, 'w/b': { how: 'wait', at: 1, until: 9 } } };
  assert.equal(howOf(shared, 1000, 'w', { id: 'a', payer: 'p1', at: 2000 }), 'gone');
  assert.equal(howOf(shared, 1000, 'w', { id: 'b', payer: 'p1', at: 2000 }), 'bank', 'never its payer\'s cash');
  assert.equal(howOf(shared, 1000, 'w', { id: 'c', payer: 'p1', at: 2000 }), 'cash');
  assert.equal(howOf(shared, 1000, 'w', { id: 'c', payer: 'p2', at: 2000 }), 'ask');
  assert.equal(howOf(shared, 1000, 'w', { id: 'a', payer: 'p1', at: 999 }), 'history');
  assert.equal(howOf(shared, null, 'w', { id: 'a', payer: 'p1', at: 999 }), 'history');
});

/* ------------------------------------------------------------- matching */

const pay = (key, payerKey, cents, marked, at) => ({ key, payerKey, cents, marked, at: at === undefined ? Date.parse(marked + 'T12:00:00Z') : at });

test('matching: one payment of the exact amount, nearest marked day first', () => {
  const rows = [{ id: 'r1', day: '2026-11-10', amount: 7000 }];
  const m = matchIncome(rows, [pay('w/a', 'w/p1', 7000, '2026-11-01'), pay('w/b', 'w/p2', 7000, '2026-11-09'), pay('w/c', 'w/p1', 7000, '2026-11-11')]);
  // b and c are both 1 day away: b was marked earlier
  assert.deepEqual([...m], [['w/b', 'r1']]);
});

test('matching: several payments of one payer that add up, within 21 days of each other', () => {
  const rows = [{ id: 'r1', day: '2026-11-20', amount: 21000 }];
  const ps = [pay('w/a', 'w/p1', 7000, '2026-11-01'), pay('w/b', 'w/p1', 7000, '2026-11-08'), pay('w/c', 'w/p1', 7000, '2026-11-15'), pay('w/d', 'w/p2', 7000, '2026-11-15')];
  assert.deepEqual([...matchIncome(rows, ps)].sort(), [['w/a', 'r1'], ['w/b', 'r1'], ['w/c', 'r1']]);
  // never across payers
  assert.equal(matchIncome([{ id: 'r1', day: '2026-11-20', amount: 14000 }], [pay('w/a', 'w/p1', 7000, '2026-11-15'), pay('w/d', 'w/p2', 7000, '2026-11-15')]).size, 0);
  // more than 21 days apart: no group
  assert.equal(matchIncome([{ id: 'r1', day: '2026-11-23', amount: 14000 }], [pay('w/a', 'w/p1', 7000, '2026-11-01'), pay('w/b', 'w/p1', 7000, '2026-11-23')]).size, 0);
  assert.equal(matchIncome([{ id: 'r1', day: '2026-11-22', amount: 14000 }], [pay('w/a', 'w/p1', 7000, '2026-11-01'), pay('w/b', 'w/p1', 7000, '2026-11-22')]).size, 2);
  // the smallest group, and of two the one marked earliest
  const m = matchIncome([{ id: 'r1', day: '2026-11-20', amount: 10000 }],
    [pay('w/a', 'w/p1', 2500, '2026-11-01'), pay('w/b', 'w/p1', 2500, '2026-11-02'), pay('w/c', 'w/p1', 5000, '2026-11-03'), pay('w/d', 'w/p1', 5000, '2026-11-04'), pay('w/e', 'w/p1', 2500, '2026-11-05'), pay('w/f', 'w/p1', 2500, '2026-11-06')]);
  assert.deepEqual([...m.keys()].sort(), ['w/c', 'w/d']);
  // at most 6 in a group
  const seven = Array.from({ length: 7 }, (_, i) => pay('w/' + i, 'w/p1', 1000, '2026-11-0' + (i + 1)));
  assert.equal(matchIncome([{ id: 'r1', day: '2026-11-10', amount: 7000 }], seven).size, 0);
  assert.equal(matchIncome([{ id: 'r1', day: '2026-11-10', amount: 6000 }], seven).size, 6);
});

test('matching: both edges of the window', () => {
  const p = [pay('w/a', 'w/p1', 7000, '2026-11-11')];
  assert.equal(matchIncome([{ id: 'r', day: '2026-11-01', amount: 7000 }], p).size, 1); // 10 days before
  assert.equal(matchIncome([{ id: 'r', day: '2026-10-31', amount: 7000 }], p).size, 0); // 11 days before
  assert.equal(matchIncome([{ id: 'r', day: '2026-12-11', amount: 7000 }], p).size, 1); // 30 days after
  assert.equal(matchIncome([{ id: 'r', day: '2026-12-12', amount: 7000 }], p).size, 0); // 31 days after
});

test('matching: oldest row first, one payment per row, and the order of the inputs does not matter', () => {
  const rows = [{ id: 'r2', day: '2026-11-12', amount: 7000 }, { id: 'r1', day: '2026-11-11', amount: 7000 }];
  const ps = [pay('w/b', 'w/p1', 7000, '2026-11-12'), pay('w/a', 'w/p1', 7000, '2026-11-10')];
  const one = matchIncome(rows, ps);
  const two = matchIncome(rows.slice().reverse(), ps.slice().reverse());
  assert.deepEqual([...one].sort(), [...two].sort());
  assert.equal(one.get('w/a'), 'r1');
  assert.equal(one.get('w/b'), 'r2');
});

test('rebuild: a bank row confirms the payment, a claimed row does not, and un-marking frees the row', () => {
  const s = baseState();
  const marked = NOW - 2 * DAY_MS;
  read(s, [item('i1', 'p-avery', 7000, marked)]);
  s.txs.push(bankIn('tx_row', 7000, TODAY));
  rebuildIncome(s, NOW);
  const move = s.txs.find((tx) => tx.id === incomeMoveId('work', 'i1'));
  assert.equal(move.matchId, 'tx_row');
  assert.equal(incomeRowLabels(s).get('tx_row'), 'Session · Avery');
  assert.equal(s.txs.find((tx) => tx.id === 'tx_row').reportedAs, 'Session · Avery', 'the bank row carries the label');
  // idempotent
  const snap = JSON.stringify(s);
  assert.equal(rebuildIncome(s, NOW).changed, false);
  assert.equal(JSON.stringify(s), snap);
  // a row another move claims is not taken
  const t = baseState();
  read(t, [item('i1', 'p-avery', 7000, marked)]);
  t.txs.push(bankIn('tx_row', 7000, TODAY));
  t.txs.push(makeTx({ id: 'tx_typed', source: 'manual', kind: 'income', flow: 'in', amount: 7000, day: TODAY, matchId: 'tx_row' }));
  rebuildIncome(t, NOW);
  assert.equal(t.txs.find((tx) => tx.id === incomeMoveId('work', 'i1')).matchId, null);
  // un-marking: the payment leaves, its row is free for another
  read(s, [item('i2', 'p-rowan', 7000, marked + HOUR_MS)], NOW, 'sha2');
  assert.equal(s.txs.find((tx) => tx.id === incomeMoveId('work', 'i1')), undefined);
  assert.equal(s.txs.find((tx) => tx.id === incomeMoveId('work', 'i2')).matchId, 'tx_row');
  assert.equal(s.txs.find((tx) => tx.id === 'tx_row').reportedAs, 'Session · Rowan');
  read(s, [], NOW, 'sha3');
  assert.equal('reportedAs' in s.txs.find((tx) => tx.id === 'tx_row'), false, 'unmatched: the label goes');
});

test('rebuild keeps what the owner set on a move and touches nothing else', () => {
  const s = baseState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  const move = movesOf(s)[0];
  move.note = 'paid early';
  move.purpose = 'work';
  move.locks = ['purpose'];
  const other = makeTx({ id: 'tx_other', source: 'bank', accountId: 'acc_chk', day: TODAY, amount: 300, flow: 'out', kind: 'spend' });
  s.txs.push(other);
  const before = JSON.stringify(other);
  rebuildIncome(s, NOW);
  assert.equal(move.note, 'paid early');
  assert.equal(move.purpose, 'work');
  assert.equal(JSON.stringify(other), before);
});

/* ------------------------------------------------------------- the engine */

test('provisional income: in live, in every close from its day, earned in pencil; never expires; gone when matched', () => {
  const s = baseState();
  const before = makeLedger(s, NOW);
  const liveBefore = before.position().live;
  const marked = NOW - 9 * DAY_MS; // older than the 7 days of a typed spend
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 30 * DAY_MS, payers: {}, items: {}, cash: null } };
  read(s, [item('i1', 'p-avery', 7000, marked)]);
  const day = gameDay(marked, 4);
  const L = makeLedger(s, NOW);
  const pos = L.position();
  assert.equal(pos.live, liveBefore + 7000);
  assert.equal(pos.smooth, before.position().smooth); // smooth keeps excluding pencil moves
  const closes = L.closes(addDays(day, -1), TODAY);
  const prior = before.closes(addDays(day, -1), TODAY);
  assert.equal(closes[0].smooth, prior[0].smooth);
  for (let i = 1; i < closes.length; i++) assert.equal(closes[i].smooth, prior[i].smooth + 7000);
  assert.equal(closes[1].result, prior[1].result + 7000);
  assert.equal(closes[1].earned, prior[1].earned + 7000);
  assert.equal(closes[1].partial, true);
  // the bank row arrives: the payment stops counting; the row counts
  s.txs.push(bankIn('tx_row', 7000, TODAY));
  s.accounts[0].balance += 7000;
  rebuildIncome(s, NOW);
  const after = makeLedger(s, NOW);
  assert.equal(after.position().live, liveBefore + 7000);
  assert.equal(after.closes(day, day)[0].smooth, prior[1].smooth);
});

test('an answer of gone stops the count; cash moves it into Cash in hand', () => {
  const s = baseState();
  const marked = NOW - 2 * DAY_MS;
  read(s, [item('i1', 'p-avery', 7000, marked)]);
  const live0 = makeLedger(s, NOW).position().live;
  answerItem(s, 'work', 'i1', 'gone', NOW);
  assert.equal(makeLedger(s, NOW).position().live, live0 - 7000);
  answerItem(s, 'work', 'i1', 'cash', NOW + 1);
  const acc = cashAccountOf(s);
  assert.ok(acc);
  assert.equal(acc.type, 'cash');
  assert.equal(acc.reserve, false);
  assert.equal(makeLedger(s, NOW).position().live, live0);
  assert.equal(makeLedger(s, NOW).accountValueOn(acc.id, TODAY), 7000);
  assert.equal(checkDoc(s), null);
});

test('Cash in hand: the figure, the closes, a count and a payment after it', () => {
  const s = baseState();
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 30 * DAY_MS, payers: { 'work/p-rowan': { how: 'cash', at: NOW - 20 * DAY_MS } }, items: {}, cash: null } };
  const d5 = NOW - 5 * DAY_MS;
  const d3 = NOW - 3 * DAY_MS;
  const d1 = NOW - 1 * DAY_MS;
  read(s, [item('a', 'p-rowan', 4000, d5), item('b', 'p-rowan', 6000, d3), item('c', 'p-rowan', 2500, d1)]);
  const acc = cashAccountOf(s);
  let L = makeLedger(s, NOW);
  assert.equal(L.accountValueOn(acc.id, TODAY), 12500);
  assert.equal(L.accountValueOn(acc.id, gameDay(d5, 4)), 4000);
  assert.equal(L.accountValueOn(acc.id, addDays(gameDay(d5, 4), -1)), 0);
  assert.equal(L.accountValueOn(acc.id, gameDay(d3, 4)), 10000);
  const c5 = L.closes(gameDay(d5, 4), gameDay(d5, 4))[0];
  assert.equal(c5.earned - c5.receivable, c5.earned - c5.receivable); // shape
  assert.equal(L.closes(gameDay(d5, 4), gameDay(d5, 4))[0].result, 4000);
  // a count between b and c: 9000 in hand; c (after it) adds
  countCash(s, 9000, d3 + HOUR_MS);
  rebuildIncome(s, NOW);
  L = makeLedger(s, NOW);
  assert.equal(L.accountValueOn(acc.id, TODAY), 11500);
  assert.equal(acc.balance, 11500);
  const countDay = gameDay(d3 + HOUR_MS, 4);
  const close = L.closes(countDay, countDay)[0];
  // the count's difference is a revaluation: not in the day's result
  assert.equal(close.reval, 9000 - 10000);
  assert.equal(close.result, 6000);
  assert.equal(L.closes(gameDay(d1, 4), gameDay(d1, 4))[0].result, 2500);
  // the cash payments are income, green
  const cashMoves = movesOf(s).filter((tx) => tx.accountId === acc.id);
  assert.equal(cashMoves.length, 3);
  for (const tx of cashMoves) assert.equal(cashFlowOf(tx, (id) => s.accounts.find((a) => a.id === id)), 'in');
  // listed as settled income (not a pencil move); a payment by transfer is listed in pencil
  const listed = recentTransactions(s, TODAY, { limit: 10 }).rows.filter((row) => row.tx.via === 'income');
  assert.ok(listed.length >= 1);
  for (const row of listed) assert.equal(row.provisional, false);
  assert.equal(checkDoc(s), null);
});

test('a provisional payment on the bank is green too', () => {
  const s = baseState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  const tx = movesOf(s)[0];
  assert.equal(tx.accountId, null); // no income rows on record yet: no account
  assert.equal(cashFlowOf(tx, () => null), 'in');
  s.txs.push(bankIn('tx_old', 5000, addDays(TODAY, -40)));
  rebuildIncome(s, NOW);
  assert.equal(movesOf(s)[0].accountId, 'acc_chk');
  assert.equal(cashFlowOf(movesOf(s)[0], (id) => s.accounts.find((a) => a.id === id)), 'in');
});

test('accrual is turned off for a stream with a deposit matched to a reported payment, unless locked on', () => {
  const s = baseState();
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 120 * DAY_MS, payers: {}, items: {}, cash: null } };
  const items = [];
  for (let k = 0; k < 4; k++) {
    const day = addDays(TODAY, -30 * (3 - k) - 1);
    s.txs.push(bankIn('tx_pay' + k, 20000, day, { raw: 'ZELLE FROM A PAYER', merchant: 'A Payer', mkey: 'a payer' }));
    items.push(item('m' + k, 'p-avery', 20000, Date.parse(day + 'T17:00:00Z')));
  }
  refresh(s, NOW);
  const streamOf = () => s.streams.find((st) => st.id === s.txs.find((tx) => tx.id === 'tx_pay0').streamId);
  assert.ok(streamOf());
  assert.equal(streamOf().accrue, true);
  read(s, items);
  refresh(s, NOW);
  assert.equal(movesOf(s).filter((tx) => tx.matchId).length, 4);
  assert.equal(streamOf().accrue, false);
  // locked on: kept
  streamOf().accrue = true;
  streamOf().locks = ['accrue'];
  refresh(s, NOW);
  assert.equal(streamOf().accrue, true);
});

/* ------------------------------------------------------------- questions */

test('questions: one per payer with ask payments; late after 96 h; wait until', () => {
  const s = baseState();
  const marked = NOW - 50 * HOUR_MS;
  read(s, [item('i1', 'p-avery', 7000, marked - DAY_MS), item('i2', 'p-avery', 8000, marked), item('i3', 'p-rowan', 6000, marked)]);
  let q = incomeQuestions(s, NOW);
  assert.deepEqual(q.payers.map((p) => [p.name, p.cents]), [['Avery', 8000], ['Rowan', 6000]]);
  assert.equal(q.late.length, 0);
  answerPayer(s, 'work', 'p-avery', 'bank', NOW);
  q = incomeQuestions(s, NOW);
  assert.deepEqual(q.payers.map((p) => p.name), ['Rowan']);
  // 96 h after `at`, exactly
  assert.deepEqual(incomeQuestions(s, marked - DAY_MS + LATE_MS - 1).late.map((l) => l.id), []);
  assert.deepEqual(incomeQuestions(s, marked - DAY_MS + LATE_MS).late.map((l) => l.id), ['i1']);
  assert.equal(incomeQuestions(s, marked - DAY_MS + LATE_MS).late[0].label, 'Session · Avery');
  // Still coming: asked again 4 days later
  const at = marked + LATE_MS;
  answerItem(s, 'work', 'i2', 'wait', at);
  assert.deepEqual(incomeQuestions(s, at).late.map((l) => l.id), ['i1']);
  assert.deepEqual(incomeQuestions(s, at + WAIT_MS - 1).late.map((l) => l.id), ['i1']);
  assert.deepEqual(incomeQuestions(s, at + WAIT_MS).late.map((l) => l.id), ['i1', 'i2']);
  // a payment the bank met is not late; a matched ask payment still asks its payer, with what the bank shows
  s.txs.push(bankIn('tx_r', 6000, TODAY));
  rebuildIncome(s, NOW);
  q = incomeQuestions(s, NOW);
  assert.deepEqual(q.payers.map((p) => [p.name, p.bank && p.bank.cents]), [['Rowan', 6000]]);
  // no question in the sample game
  s.meta.origin = 'demo';
  assert.deepEqual(incomeQuestions(s, NOW), { payers: [], late: [], confirm: [] });
});

/* ------------------------------------------------------------- shared answers */

const A = { since: 100, payers: { 'w/p1': { how: 'bank', at: 5 } }, items: { 'w/i1': { how: 'cash', at: 3 } }, counts: [{ id: 'c9', cents: 100, at: 9, editedAt: 9 }] };
const B = { since: 90, payers: { 'w/p1': { how: 'cash', at: 5 }, 'w/p2': { how: 'cash', at: 1 } }, items: { 'w/i1': { how: 'gone', at: 4 } }, counts: [{ id: 'c8', cents: 50, at: 8, editedAt: 8 }, { id: 'c9', deleted: true, editedAt: 2 }] };
const C = { since: null, payers: { 'w/p2': { how: 'bank', at: 2 } }, items: { 'w/i2': { how: 'wait', at: 7, until: 99 } }, counts: [] };

test('the income merge is commutative, associative and idempotent; the later answer wins', () => {
  const j = (x) => JSON.stringify(x);
  assert.equal(j(mergeIncomeShared(A, B)), j(mergeIncomeShared(B, A)));
  assert.equal(j(mergeIncomeShared(mergeIncomeShared(A, B), C)), j(mergeIncomeShared(A, mergeIncomeShared(B, C))));
  const ab = mergeIncomeShared(A, B);
  assert.equal(j(mergeIncomeShared(ab, ab)), j(ab));
  assert.equal(j(mergeIncomeShared(ab, A)), j(ab));
  assert.equal(ab.since, 90);
  assert.equal(ab.items['w/i1'].how, 'gone');
  assert.deepEqual(ab.counts.map((c) => c.cents), [50, 100], 'every count kept; the removal made earlier loses');
  assert.equal(ab.payers['w/p1'].how, 'bank'); // equal `at`: the canonical order decides, the same on both sides
  assert.equal(readIncomeShared({ payers: { 'nokey': { how: 'bank', at: 1 } } }), null);
  assert.equal(readIncomeShared({ items: { 'w/i': { how: 'maybe', at: 1 } } }), null);
});

test('the shared file carries income, merges it per answer, and keeps a file of an older version', () => {
  const s = baseState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  answerPayer(s, 'work', 'p-avery', 'cash', NOW);
  const mine = exportShared(s, NOW);
  assert.equal(mine.income.payers['work/p-avery'].how, 'cash');
  // an older version's file: no income section, an unknown section kept
  const older = { v: 1, app: 'networth', savedAt: 5, byHand: {}, later: { anything: 1 } };
  const merged = mergeShared(mine, older);
  assert.deepEqual(merged.later, { anything: 1 });
  assert.equal(merged.income.payers['work/p-avery'].how, 'cash');
  assert.ok(readSharedFile(JSON.stringify(merged)));
  // what an older version made of it: income kept whole as plain data, still readable here
  assert.ok(readSharedFile(JSON.stringify({ ...older, income: mine.income })));
  // another device's answer arrives and applies
  const other = { v: 1, app: 'networth', savedAt: 9, byHand: {}, income: { since: null, payers: { 'work/p-avery': { how: 'bank', at: NOW + 5 } }, items: {}, cash: null } };
  const both = mergeShared(mine, other);
  assert.equal(both.income.payers['work/p-avery'].how, 'bank');
  assert.ok(sharedChanges(s, both) > 0);
  applyShared(s, both, NOW);
  rebuildIncome(s, NOW);
  assert.equal(s.income.shared.payers['work/p-avery'].how, 'bank');
  assert.equal(sharedChanges(s, both), 0);
  // a bad income section refuses the file
  assert.equal(readSharedFile(JSON.stringify({ ...older, income: { payers: { x: 1 } } })), null);
});

/* ------------------------------------------------------------- reading income/ */

const OWNER = 'someone';
const KEY = 'invented_key_for_tests_0123456789';

/** A fake GitHub holding a folder income/ that only the other app writes. */
function fakeRepo() {
  const files = new Map(); // name -> { text, sha }
  const calls = [];
  let n = 0;
  const repo = {
    calls, fail: null,
    put(name, text) { files.set(name, { text, sha: (++n).toString(16).padStart(40, '0') }); },
    drop(name) { files.delete(name); },
    async fetch(url, init) {
      calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
      const answer = (status, body) => ({ status, headers: { get: () => null }, json: async () => body });
      if (repo.fail === 'rate') return answer(429, {});
      if (init.headers.Authorization !== 'Bearer ' + KEY) return answer(401, {});
      if (init.method !== 'GET') return answer(405, {});
      const base = 'https://api.github.com/repos/' + OWNER + '/networth-data/contents/income';
      if (url === base) {
        if (!files.size) return answer(404, {});
        return answer(200, [...files].map(([name, f]) => ({ type: 'file', name, sha: f.sha, size: Buffer.byteLength(f.text) }))
          .concat([{ type: 'dir', name: 'sub', sha: 'f'.repeat(40), size: 0 }]));
      }
      const name = decodeURIComponent(url.slice(base.length + 1));
      const f = files.get(name);
      if (!f) return answer(404, {});
      return answer(200, { encoding: 'base64', sha: f.sha, content: Buffer.from(f.text).toString('base64').replace(/(.{60})/g, '$1\n') });
    },
  };
  return repo;
}

function deviceOf(state) {
  return { state: () => state, stale: () => false, update: (change) => change(state) };
}

test('income/: listed and read at api.github.com with the key in the header only; nothing is ever written', async () => {
  const repo = fakeRepo();
  assert.equal(await listIncome(OWNER, KEY, repo.fetch), null, 'no folder: not a listing (nothing has arrived yet, or the key lost access)');
  repo.put('work.json', fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS)] }));
  repo.put('notes.txt', 'x');
  const listed = await listIncome(OWNER, KEY, repo.fetch);
  assert.deepEqual(listed.map((e) => e.name), ['work.json']);
  assert.match(await readIncomeText(OWNER, KEY, 'work.json', repo.fetch), /income\/1/);
  assert.equal(await readIncomeText(OWNER, KEY, 'gone.json', repo.fetch), null);
  assert.throws(() => incomeUrl(OWNER, '../networth-shared.json'), ShareError);
  for (const call of repo.calls) {
    assert.equal(call.method, 'GET');
    assert.ok(call.url.startsWith('https://api.github.com/repos/someone/networth-data/contents/income'));
    assert.ok(!call.url.includes(KEY));
  }
  repo.fail = 'rate';
  await assert.rejects(listIncome(OWNER, KEY, repo.fetch), (err) => err instanceof ShareError && err.code === 'rate');
});

test('a reading fetches a file only when its sha changed; a source whose file is gone for 24 hours is dropped, a folder that is gone drops nothing', async () => {
  const repo = fakeRepo();
  const transport = { list: () => listIncome(OWNER, KEY, repo.fetch), read: (name) => readIncomeText(OWNER, KEY, name, repo.fetch) };
  const s = baseState();
  repo.put('work.json', fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS)] }));
  let r = await roundIncome(deviceOf(s), transport, NOW);
  assert.equal(r.ok, true);
  assert.equal(movesOf(s).length, 1);
  const reads = () => repo.calls.filter((c) => c.url.endsWith('/work.json')).length;
  assert.equal(reads(), 1);
  r = await roundIncome(deviceOf(s), transport, NOW + 60000);
  assert.equal(reads(), 1, 'same sha: not fetched again');
  assert.equal(r.changed, false);
  repo.put('work.json', fileText({ items: [item('i1', 'p-avery', 7000, NOW - HOUR_MS), item('i2', 'p-rowan', 6000, NOW - HOUR_MS)] }));
  await roundIncome(deviceOf(s), transport, NOW + 120000);
  assert.equal(reads(), 2);
  assert.equal(movesOf(s).length, 2);
  repo.put('big.json', 'x'.repeat(1000001));
  await roundIncome(deviceOf(s), transport, NOW + 180000);
  assert.equal(repo.calls.filter((c) => c.url.endsWith('/big.json')).length, 0, 'a file over 1 MB is not fetched');
  assert.match(s.income.sources.big.problem, /1 MB/);
  repo.drop('work.json');
  await roundIncome(deviceOf(s), transport, NOW + 240000);
  assert.equal(movesOf(s).length, 2, 'missed by one listing: kept');
  await roundIncome(deviceOf(s), transport, NOW + 240000 + DAY_MS);
  assert.equal(movesOf(s).length, 0);
  assert.deepEqual(Object.keys(s.income.sources), ['big']);
  repo.drop('big.json');
  await roundIncome(deviceOf(s), transport, NOW + 240000 + 3 * DAY_MS);
  assert.deepEqual(Object.keys(s.income.sources), ['big'], 'a 404 for the folder drops nothing');
});

test('a bank merge that brings the row confirms the payment at once', async () => {
  const { mergeFeed } = await import('../js/model/merge.js');
  const s = baseState();
  read(s, [item('i1', 'p-avery', 7000, NOW - 2 * DAY_MS)]);
  s.accounts[0].asOf = NOW - 3 * HOUR_MS;
  const live0 = makeLedger(s, NOW).position().live;
  const at = NOW - HOUR_MS;
  mergeFeed(s, { src: 'simplefin', fetchedAt: NOW, fromMs: NOW - 5 * DAY_MS, toMs: NOW, errors: [], accounts: [{
    extId: 'x1', connId: 'c1', institution: 'Sample Bank', name: 'Everyday', currency: 'USD', balance: 507000, available: null, asOf: at,
    txs: [{ extId: 'b1', amount: 7000, posted: Math.floor(at / 1000), at: Math.floor(at / 1000), pending: false, description: 'ZELLE FROM SOMEONE', payee: '', memo: '', mcc: null }],
  }] }, NOW);
  const row = s.txs.find((tx) => tx.source === 'bank' && tx.amount === 7000);
  assert.ok(row);
  assert.equal(row.kind, 'income');
  assert.equal(movesOf(s)[0].matchId, row.id);
  // counted once: the balance rose by the payment and the pencil move stopped counting
  assert.equal(makeLedger(s, NOW).position().live, live0);
});

test('a round writes the answers, takes in another device\'s, and keeps an old answer no source lists', async () => {
  const { roundShared } = await import('../js/model/share.js');
  const s = baseState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  answerPayer(s, 'work', 'p-avery', 'cash', NOW);
  let fileText = JSON.stringify({ v: 1, app: 'networth', savedAt: 1, byHand: {}, income: { since: null, payers: { 'work/p-rowan': { how: 'bank', at: NOW - 5 } },
    items: { 'work/gone-long-ago': { how: 'gone', at: NOW - 500 * DAY_MS } }, counts: [{ id: 'c1', cents: 1200, at: NOW - 7, editedAt: NOW - 7 }] } });
  const device = { state: () => s, update: (now) => now(s) };
  const transport = { read: async () => ({ text: fileText, sha: 'a'.repeat(40) }), write: async (text) => { fileText = text; return { sha: 'b'.repeat(40) }; } };
  const r = await roundShared(device, transport, () => NOW);
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  const written = JSON.parse(fileText).income;
  assert.equal(written.payers['work/p-avery'].how, 'cash');
  assert.equal(written.payers['work/p-rowan'].how, 'bank');
  assert.equal(written.counts[0].cents, 1200);
  assert.equal(written.items['work/gone-long-ago'].how, 'gone', 'never pruned by what one device lists');
  assert.equal(s.income.shared.payers['work/p-rowan'].how, 'bank');
  assert.equal(s.income.shared.counts[0].cents, 1200);
  assert.ok(cashAccountOf(s), 'a count makes Cash in hand');
  // a second round agrees and writes nothing
  const again = await roundShared(device, transport, () => NOW + 1000);
  assert.equal(again.wrote, false);
});

test('one bad answer in the record hides no other, and the answers stay within their limits', () => {
  const s = baseState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  s.income.shared.payers['work/p-avery'] = { how: 'cash', at: NOW };
  s.income.shared.payers['not a key'] = { how: 'cash', at: NOW };
  rebuildIncome(s, NOW);
  assert.equal(movesOf(s)[0].income.how, 'cash');
  for (let k = 0; k < MAX_PAYER_ANSWERS + 5; k++) answerPayer(s, 'work', 'p' + k, 'bank', NOW + k);
  assert.equal(Object.keys(s.income.shared.payers).length, MAX_PAYER_ANSWERS);
  assert.ok(readSharedFile(JSON.stringify(exportShared(s, NOW))), 'what this device writes is a file it can read');
});

/* ------------------------------------------------- the fix round: cash answers, counts, size, refusals */

const MIN_MS = 60000;

/** One shared file in memory, written only over the sha it was read with. */
function sharedRepo() {
  const repo = { text: null, sha: null, n: 0 };
  repo.transport = {
    read: async () => ({ text: repo.text, sha: repo.sha }),
    write: async (text, sha) => {
      if (sha !== repo.sha) { const err = new Error('conflict'); err.code = 'conflict'; throw err; }
      repo.text = text;
      repo.sha = (++repo.n).toString(16).padStart(40, '0');
      return { sha: repo.sha };
    },
  };
  return repo;
}

/** A device that runs share rounds; an answer or a count is made directly. */
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

const howOfItem = (s, id) => movesOf(s).find((tx) => tx.id === incomeMoveId('work', id));

test('a payer answered cash leaves a payment its bank row matched with that row; switching back and forth never moves it', () => {
  const s = baseState();
  const m = NOW - 3 * DAY_MS;
  const o = NOW - DAY_MS;
  read(s, [item('m1', 'p-avery', 7000, m), item('o1', 'p-avery', 5000, o)]);
  s.txs.push(bankIn('tx_row', 7000, gameDay(m + DAY_MS, 4)));
  rebuildIncome(s, NOW);
  assert.equal(howOfItem(s, 'm1').matchId, 'tx_row');
  const first = gameDay(m, 4);
  const L0 = makeLedger(s, NOW);
  const live0 = L0.position().live;
  const closes0 = L0.closes(first, TODAY).map((c) => c.smooth);
  let t = NOW + MIN_MS;
  for (const how of ['cash', 'bank', 'cash', 'bank']) {
    assert.equal(answerPayer(s, 'work', 'p-avery', how, t += MIN_MS), true);
    assert.equal(howOfItem(s, 'm1').matchId, 'tx_row', how + ': the matched payment stays with its row');
    assert.equal(howOfItem(s, 'm1').income.how, 'bank');
    assert.equal(howOfItem(s, 'o1').income.how, how, how + ': the open payment follows its payer');
    const L = makeLedger(s, NOW);
    assert.equal(L.position().live, live0, how + ': counted once');
    assert.deepEqual(L.closes(first, TODAY).map((c) => c.smooth), closes0, how + ': the closes hold');
    const acc = cashAccountOf(s);
    assert.equal(acc ? L.accountValueOn(acc.id, TODAY) : 0, how === 'cash' ? 5000 : 0, how + ': Cash in hand');
  }
  assert.equal(checkDoc(s), null);
});

test('a second count never moves the closes of the days before it, on either device', async () => {
  const repo = sharedRepo();
  const d5 = NOW - 5 * DAY_MS;
  const d3 = NOW - 3 * DAY_MS;
  const d1 = NOW - DAY_MS;
  const states = [baseState(), baseState()];
  for (const s of states) {
    s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 30 * DAY_MS, payers: { 'work/p-rowan': { how: 'cash', at: NOW - 20 * DAY_MS } }, items: {}, counts: [] } };
    read(s, [item('a', 'p-rowan', 4000, d5), item('b', 'p-rowan', 6000, d3), item('c', 'p-rowan', 2500, d1)]);
  }
  const [a, b] = states.map((s) => roundDevice(repo, s));
  const day3 = gameDay(d3, 4);
  const day1 = gameDay(d1, 4);
  const view = (d) => {
    const L = makeLedger(d.state, NOW);
    const acc = cashAccountOf(d.state);
    const c = L.closes(gameDay(d5, 4), TODAY);
    return { now: L.accountValueOn(acc.id, TODAY), balance: acc.balance, values: c.map((x) => L.accountValueOn(acc.id, x.day)), revals: c.map((x) => x.reval), results: c.map((x) => x.result) };
  };
  a.change((s) => countCash(s, 9000, d3 + HOUR_MS));
  await a.round(NOW);
  await b.round(NOW + MIN_MS);
  const one = view(b);
  assert.equal(one.now, 11500);
  a.change((s) => countCash(s, 5000, d1 + HOUR_MS));
  await a.round(NOW + 2 * MIN_MS);
  await b.round(NOW + 3 * MIN_MS);
  for (const d of [a, b]) {
    const two = view(d);
    assert.equal(two.now, 5000);
    assert.equal(two.balance, 5000);
    const k = 5 - 1; // the index of day1 in the closes from d5
    assert.deepEqual(two.values.slice(0, k), one.values.slice(0, k), 'the days before the second count do not move');
    assert.deepEqual(two.revals.slice(0, k), one.revals.slice(0, k));
    assert.equal(two.values[k], 5000);
    assert.equal(two.revals[k], 5000 - 9000 - 2500);
    assert.equal(two.results[k], one.results[k], 'a count is neither income nor spending');
    assert.equal(makeLedger(d.state, NOW).closes(day3, day3)[0].reval, 9000 - 10000);
  }
  assert.equal(day1, addDays(gameDay(d5, 4), 4));
});

test('the counts are a list merged by id, a later editedAt winning; a removal is a tombstone; the merge laws hold', () => {
  const c1 = { id: 'c1', cents: 900, at: 10, editedAt: 10 };
  const c2 = { id: 'c2', cents: 500, at: 20, editedAt: 20 };
  const gone = { id: 'c2', deleted: true, editedAt: 30 };
  const X = { since: 1, payers: {}, items: {}, counts: [c1, c2] };
  const Y = { since: 1, payers: {}, items: {}, counts: [gone] };
  const Z = { since: 1, payers: { 'w/p': { how: 'none', at: 7 } }, items: { 'w/i': { how: 'none', at: 8 } }, counts: [{ id: 'c3', cents: 1, at: 40, editedAt: 40 }] };
  const j = (x) => JSON.stringify(x);
  assert.equal(j(mergeIncomeShared(X, Y)), j(mergeIncomeShared(Y, X)));
  assert.equal(j(mergeIncomeShared(mergeIncomeShared(X, Y), Z)), j(mergeIncomeShared(X, mergeIncomeShared(Y, Z))));
  const xy = mergeIncomeShared(X, Y);
  assert.equal(j(mergeIncomeShared(xy, xy)), j(xy));
  assert.deepEqual(xy.counts, [c1, gone]);
  // a cleared answer is read as no answer
  assert.equal(howOf(Z, 1, 'w', { id: 'i', payer: 'p', at: 5 }), 'ask');
  assert.ok(readIncomeShared(Z));
  assert.equal(readIncomeShared({ counts: [{ id: 'c1', cents: -1, at: 1, editedAt: 1 }] }), null);
  assert.equal(readIncomeShared({ counts: [c1, c1] }), null, 'one id once');
});

test('a shared file at every cap, with the longest keys and 200 payments by hand, stays under 1,500,000 characters and is read', () => {
  const key = (k) => 'S'.repeat(80) + '/' + String(k).padStart(80, 'I');
  const payers = {};
  for (let k = 0; k < MAX_PAYER_ANSWERS; k++) payers[key(k)] = { how: 'bank', at: 1794616212000 + k };
  const items = {};
  for (let k = 0; k < MAX_ITEM_ANSWERS; k++) items[key(k)] = { how: 'wait', at: 1794616212000 + k, until: 1794961812000 + k };
  const counts = [];
  for (let k = 0; k < MAX_COUNTS; k++) counts.push({ id: 'c' + String(k).padStart(79, '0'), cents: 9999999999, at: 1794616212000 + k, editedAt: 1794616212000 + k });
  const byHand = {};
  for (let k = 0; k < 200; k++) {
    const marks = {};
    for (let m = 0; m < 36; m++) marks[addDays('2024-01-15', 31 * m)] = { paid: true, at: 1794616212000 + m };
    byHand['bh_' + String(k).padStart(77, '0')] = { name: 'N'.repeat(60), amount: 9999999999, dueDay: 28, since: '2024-01-01', active: true, editedAt: 1794616212000,
      deleted: false, payee: 'p0123456789abc', payeeAt: 1794616212000, marks, skips: {} };
  }
  const text = JSON.stringify({ v: 1, app: 'networth', savedAt: 1794616212000, byHand, income: { since: 1794000000000, payers, items, counts } }, null, 1);
  assert.ok(text.length < 1500000, 'the file is ' + text.length + ' characters');
  assert.ok(readSharedFile(text));
});

test('a file refused because a payment is ahead of the clock is read again later; another refusal stays cached by its sha', async () => {
  const repo = fakeRepo();
  const transport = { list: () => listIncome(OWNER, KEY, repo.fetch), read: (name) => readIncomeText(OWNER, KEY, name, repo.fetch) };
  const s = baseState();
  repo.put('work.json', fileText({ items: [item('i1', 'p-avery', 7000, NOW + 3 * DAY_MS)] }));
  repo.put('bad.json', '{"format":"income/9"}');
  const reads = (name) => repo.calls.filter((c) => c.url.endsWith('/' + name)).length;
  await roundIncome(deviceOf(s), transport, NOW);
  assert.match(s.income.sources.work.problem, /ahead/);
  assert.deepEqual([reads('work.json'), reads('bad.json')], [1, 1]);
  await roundIncome(deviceOf(s), transport, NOW + 10 * MIN_MS);
  assert.deepEqual([reads('work.json'), reads('bad.json')], [1, 1], 'not again within the hour');
  await roundIncome(deviceOf(s), transport, NOW + DAY_MS + HOUR_MS);
  assert.deepEqual([reads('work.json'), reads('bad.json')], [2, 1], 'the refusal that depends on the time is checked again');
  assert.equal(s.income.sources.work.problem, null);
  assert.equal(movesOf(s).length, 1);
});

test('when the other app last wrote a source is kept, read leniently', () => {
  const good = readIncomeFile(fileText({ items: [] }), NOW);
  assert.equal(good.writtenAt, NOW);
  for (const writtenAt of [undefined, 'soon', 12, '2026-13-01T00:00:00Z']) {
    const f = JSON.parse(fileText({ items: [] }));
    if (writtenAt === undefined) delete f.writtenAt; else f.writtenAt = writtenAt;
    const r = readIncomeFile(JSON.stringify(f), NOW);
    assert.equal(r.ok, true, 'never a reason to refuse the file');
    assert.equal(r.writtenAt, null);
  }
  const s = baseState();
  read(s, []);
  assert.equal(s.income.sources.work.writtenAt, NOW);
});

test('the answers and counts are stamped at the moment of the action, not with the time of the last render', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['board.js', 'settings.js', 'sheet-account.js']) {
    const text = await readFile(new URL('../js/views/' + file, import.meta.url), 'utf8');
    for (const line of text.split('\n').filter((l) => /\b(answerPayer|answerItem|countCash)\(s,/.test(l))) {
      assert.doesNotMatch(line, /ctx\.now/, file + ': ' + line.trim());
    }
  }
});

test('the merge laws hold for every kind of answer and count, cleared ones included (many random sections)', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const section = () => {
    const out = { since: rnd(3) ? 1000 + rnd(50) : null, payers: {}, items: {}, counts: [] };
    for (let k = rnd(5); k > 0; k--) out.payers['w/p' + rnd(4)] = { how: ['bank', 'cash', 'none'][rnd(3)], at: rnd(6) };
    for (let k = rnd(6); k > 0; k--) {
      const how = ['bank', 'cash', 'gone', 'wait', 'none'][rnd(5)];
      out.items['w/i' + rnd(5)] = how === 'wait' ? { how, at: rnd(6), until: 100 + rnd(3) } : { how, at: rnd(6) };
    }
    const ids = new Set();
    for (let k = rnd(4); k > 0; k--) {
      const id = 'c' + rnd(4);
      if (ids.has(id)) continue;
      ids.add(id);
      out.counts.push(rnd(3) ? { id, cents: rnd(3) * 100, at: 10 + rnd(3), editedAt: rnd(6) } : { id, deleted: true, editedAt: rnd(6) });
    }
    return out;
  };
  const j = (x) => JSON.stringify(x);
  for (let n = 0; n < 300; n++) {
    const [a, b, c] = [section(), section(), section()];
    assert.equal(j(mergeIncomeShared(a, b)), j(mergeIncomeShared(b, a)));
    assert.equal(j(mergeIncomeShared(mergeIncomeShared(a, b), c)), j(mergeIncomeShared(a, mergeIncomeShared(b, c))));
    const ab = mergeIncomeShared(a, b);
    assert.equal(j(mergeIncomeShared(ab, ab)), j(ab));
    assert.equal(j(mergeIncomeShared(ab, a)), j(ab));
  }
});
