/**
 * Income reported by another app (ARCHITECTURE 3.7), the fifth round: prepaid sessions, the counts (the words and
 * their stamps), the size of the shared file, time passing, and the words of the screens. Every payer, amount,
 * label and account here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INCOME_FORMAT, MAX_COUNTS, MAX_ITEM_ANSWERS, MAX_PAYER_ANSWERS, answerItems, answerPayer, applyIncomeReading, askAgain,
  cashAccountOf, countCash, incomeMoveId, incomeOf, incomeQuestions, liveCounts, mergeIncomeShared, rebuildIncome, removeCount,
} from '../js/model/income.js';
import { defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { makeLedger } from '../js/model/ledger.js';
import { exportShared, readSharedFile } from '../js/model/share.js';
import { addDays, gameDay } from '../js/model/dates.js';
import {
  againWords, beforeCountWords, cashNoteWords, confirmWords, itemWords, payerWords, rowLineLead,
} from '../js/views/income-words.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MIN_MS = 60000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const TODAY = gameDay(NOW, 4);
const iso = (ms) => new Date(ms).toISOString();
const PAYERS = [{ id: 'p-avery', name: 'Avery' }, { id: 'p-rowan', name: 'Rowan' }, { id: 'p-ivy', name: 'Ivy' }];

function fileText(items, what = 'Session') {
  return JSON.stringify({ format: INCOME_FORMAT, what, writtenAt: iso(NOW), payers: PAYERS, items });
}
function item(id, payer, cents, atMs, day) {
  return { id, payer, cents, day: day || gameDay(atMs, 4), at: iso(atMs) };
}
function longState(at = NOW) {
  const s = defaultState(at);
  s.meta.origin = 'bank';
  s.sync.lastOk = at;
  s.sync.from = addDays(gameDay(at, 4), -200);
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: at, basis: 'bank', ext: { src: 'simplefin', id: 'x1', conn: 'c1' } }));
  s.income = { sources: {}, firstReadAt: null, shared: { since: at - 60 * DAY_MS, payers: {}, items: {}, counts: [] } };
  return s;
}
function read(state, items, nowMs = NOW, sha = 'sha1') {
  return applyIncomeReading(state, { listed: [{ source: 'work', sha }], files: { work: { sha, text: fileText(items) } } }, nowMs);
}
function addRow(state, id, cents, day, at) {
  state.txs.push(makeTx({ id, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', kind: 'income', category: 'income', raw: 'ZELLE FROM SOMEONE', merchant: 'Zelle', mkey: 'zelle from', fp: 'acc_chk|' + day + '|' + id }));
  state.accounts.find((a) => a.id === 'acc_chk').balance += cents;
  rebuildIncome(state, at);
}
const moveOf = (s, id) => s.txs.find((tx) => tx.id === incomeMoveId('work', id));
const live = (s, at) => makeLedger(s, at).position().live;
const cashOf = (s) => { const a = cashAccountOf(s); return a ? Math.round(Number(a.balance) || 0) : 0; };

/* ------------------------------------------------------------ 1. prepaid sessions */

/** Payments marked one day (T0 - 2 hours) for sessions `offsets` days after it, paid by one deposit the next day. */
function prepaid(offsets, payerHow) {
  const T0 = new Date(2026, 10, 2, 15, 0).getTime();
  const s = longState(T0);
  const at = T0 - 2 * HOUR_MS;
  read(s, offsets.map((off, i) => item('p' + i, 'p-avery', 5000, at + i * MIN_MS, addDays(gameDay(at, 4), off))), T0);
  if (payerHow) answerPayer(s, 'work', 'p-avery', payerHow, T0);
  const now = T0 + 1.2 * DAY_MS;
  addRow(s, 'R', 5000 * offsets.length, gameDay(T0 + DAY_MS, 4), now);
  return { s, now, T0 };
}

test('1: one payment for a session 7 days ahead takes its deposit of the next day: it counts once, and no late question', () => {
  for (const how of [null, 'bank']) {
    const { s, now } = prepaid([7], how);
    assert.equal(moveOf(s, 'p0').matchId, 'R', 'the deposit lies after the marked day - 3 (payer ' + how + ')');
    assert.equal(live(s, now), 505000);
    assert.deepEqual(incomeQuestions(s, now + 4 * DAY_MS).late, []);
  }
});

test('1: two prepaid sessions (+7 and +14 days) paid by one deposit', () => {
  const { s, now } = prepaid([7, 14]);
  assert.deepEqual([moveOf(s, 'p0').matchId, moveOf(s, 'p1').matchId], ['R', 'R']);
  assert.equal(live(s, now), 510000);
});

test('1: four sessions (0, +7, +14 and +21 days) paid by one deposit', () => {
  const { s, now } = prepaid([0, 7, 14, 21]);
  assert.deepEqual(['p0', 'p1', 'p2', 'p3'].map((id) => moveOf(s, id).matchId), ['R', 'R', 'R', 'R']);
  assert.equal(live(s, now), 520000);
});

test('1: a prepaid session takes no deposit from before its marked day - 10 (FIXES6: as far back as a past session)', () => {
  const T0 = new Date(2026, 10, 10, 15, 0).getTime();
  const s = longState(T0);
  read(s, [item('p0', 'p-avery', 5000, T0 - HOUR_MS, addDays(gameDay(T0, 4), 7))], T0);
  addRow(s, 'R11', 5000, addDays(gameDay(T0, 4), -11), T0);
  assert.equal(moveOf(s, 'p0').matchId, null);
  addRow(s, 'R10', 5000, addDays(gameDay(T0, 4), -10), T0);
  assert.equal(moveOf(s, 'p0').matchId, 'R10');
});

/* ------------------------------------------------------------------- 2. counts */

/** Rowan pays in cash; $200.00 counted; then a $25.00 payment marked after the count. */
function countedThenPaid() {
  const s = longState();
  answerPayer(s, 'work', 'p-rowan', 'cash', NOW - 3 * HOUR_MS);
  read(s, [item('r1', 'p-rowan', 8500, NOW - DAY_MS)]);
  countCash(s, 20000, NOW - HOUR_MS);
  read(s, [item('r1', 'p-rowan', 8500, NOW - DAY_MS), item('r2', 'p-rowan', 2500, NOW - 59 * MIN_MS)], NOW, 'sha2');
  return s;
}

test('2: Material\'s note keeps the count and the cash payments marked since apart; "counted by you" only for an exact count', () => {
  const s = countedThenPaid();
  assert.equal(cashOf(s), 22500);
  assert.equal(cashNoteWords(s, 22500), '$225.00 of it from your count of $200.00 and payments marked as cash since');
  const t = longState();
  countCash(t, 20000, NOW - HOUR_MS);
  assert.equal(cashNoteWords(t, 20000), '$200.00 of it counted by you');
  assert.equal(cashNoteWords(longState(), 3000), '$30.00 of it from payments marked as cash');
});

test('2: "stays as counted" only when Cash in hand is the latest count; otherwise the words name the figure', () => {
  // a payment marked before the count, asked again while a later cash payment keeps Cash in hand above the count
  const s = countedThenPaid();
  answerItems(s, 'work', ['r1'], 'gone', NOW);
  askAgain(s, 'work', 'r1', NOW + MIN_MS);
  assert.equal(cashOf(s), 22500);
  assert.equal(againWords(s, 'work/r1', NOW + MIN_MS, 'none'), 'Session · Rowan: it was marked before today’s count, so Cash in hand stays $225.00.');
  s.settings.cover = true;
  assert.equal(againWords(s, 'work/r1', NOW + MIN_MS, 'none'), 'Session · Rowan: it was marked before today’s count, so Cash in hand does not change.');
  // the same with Cash in hand at the count
  const t = longState();
  answerPayer(t, 'work', 'p-rowan', 'cash', NOW - 3 * HOUR_MS);
  read(t, [item('r1', 'p-rowan', 8500, NOW - DAY_MS)]);
  countCash(t, 20000, NOW - HOUR_MS);
  answerItems(t, 'work', ['r1'], 'gone', NOW);
  askAgain(t, 'work', 'r1', NOW + MIN_MS);
  t.settings.cover = true;
  assert.equal(againWords(t, 'work/r1', NOW + MIN_MS, 'none'), 'Session · Rowan: it was marked before today’s count, so Cash in hand stays as counted.');
  // a payer's answer under cover, with Cash in hand above the count
  const u = countedThenPaid();
  read(u, [item('r1', 'p-rowan', 8500, NOW - DAY_MS), item('r2', 'p-rowan', 2500, NOW - 59 * MIN_MS), item('a1', 'p-avery', 4000, NOW - 2 * DAY_MS)], NOW, 'sha3');
  const had = new Set(u.txs.filter((tx) => tx.via === 'income' && tx.accountId === cashAccountOf(u).id).map((tx) => tx.income.key));
  answerPayer(u, 'work', 'p-avery', 'cash', NOW);
  const value = cashOf(u);
  assert.equal(value, 22500, 'Avery\'s payment was marked before the count');
  assert.equal(payerWords('Avery', 'cash', beforeCountWords(u, had, value, TODAY, true, 'payer'), null, true),
    'Avery pays in cash. Their payment was marked before today’s count, so Cash in hand does not change. Change it in Settings.');
  assert.equal(payerWords('Avery', 'cash', beforeCountWords(u, had, value, TODAY, false, 'payer'), null, false),
    'Avery pays in cash. Their $40.00 was marked before today’s count, so Cash in hand stays $225.00. Change it in Settings.');
});

test('2: a new count\'s editedAt is above every count the device knows; its at is the real time (skew4 S2, FIXES6)', () => {
  // A runs 5 minutes ahead and counts $100; B receives it and counts $80 two minutes later in real time
  const A = longState();
  const B = longState();
  countCash(A, 10000, NOW + 6 * MIN_MS);
  B.income.shared = mergeIncomeShared(incomeOf(B).shared, incomeOf(A).shared);
  rebuildIncome(B, NOW + 2 * MIN_MS);
  countCash(B, 8000, NOW + 3 * MIN_MS);
  A.income.shared = mergeIncomeShared(incomeOf(A).shared, incomeOf(B).shared);
  rebuildIncome(A, NOW + 9 * MIN_MS);
  for (const s of [A, B]) {
    const counts = liveCounts(incomeOf(s).shared);
    assert.equal(counts[counts.length - 1].cents, 8000);
    assert.equal(cashOf(s), 8000);
  }
  const [first, second] = liveCounts(incomeOf(B).shared);
  assert.equal(second.at, NOW + 3 * MIN_MS, 'the real time (FIXES6 undoes the bump of at)');
  assert.ok(second.editedAt > first.editedAt, 'on one game day the count edited last rules');
  // one device whose clock is set back between two counts
  const C = longState();
  countCash(C, 10000, NOW + 10 * MIN_MS);
  countCash(C, 8000, NOW + 7 * MIN_MS);
  assert.equal(cashOf(C), 8000);
  // a removal stamped ahead: the next count's editedAt is above it too
  const D = longState();
  countCash(D, 10000, NOW + 10 * MIN_MS);
  countCash(D, 9000, NOW + 11 * MIN_MS);
  const latest = liveCounts(incomeOf(D).shared)[1];
  removeCount(D, latest.id, NOW + 20 * MIN_MS);
  countCash(D, 7000, NOW);
  const top = Math.max(...incomeOf(D).shared.counts.filter((c) => c.id !== liveCounts(incomeOf(D).shared).at(-1).id).map((c) => c.editedAt));
  const made = liveCounts(incomeOf(D).shared).at(-1);
  assert.equal(made.cents, 7000);
  assert.ok(made.editedAt > top && made.at === NOW);
  assert.equal(cashOf(D), 7000);
});

/* ------------------------------------------------------------- 4. the file's size */

test('4: the income section at every cap, with the longest keys, and 200 payments by hand with 13 ticks each: the shared file stays under 950,000 bytes', () => {
  assert.deepEqual([MAX_ITEM_ANSWERS, MAX_PAYER_ANSWERS, MAX_COUNTS], [1000, 300, 200]);
  const big = 99999999999999; // the largest stamp, every digit written
  const key = (p, k) => 's'.repeat(80) + '/' + p + String(k).padStart(79, '0');
  const payers = {};
  const items = {};
  const counts = [];
  for (let k = 0; k < MAX_PAYER_ANSWERS; k++) payers[key('p', k)] = { how: 'bank', at: big - k };
  for (let k = 0; k < MAX_ITEM_ANSWERS; k++) items[key('i', k)] = { how: 'wait', at: big - k, until: big - k };
  for (let k = 0; k < MAX_COUNTS; k++) {
    const id = 'c' + 'x'.repeat(79 - String(k).length) + k;
    counts.push(k % 2 ? { id, deleted: true, editedAt: big - k } : { id, cents: 10000000000, at: big - k, editedAt: big - k });
  }
  // payments by hand at their caps: 200 payments with the longest names and ids, each ticked every month for a year
  // and a month, and 1,000 removals
  const recurring = [];
  for (let k = 0; k < 200; k++) {
    const marks = {};
    for (let m = 0; m < 13; m++) marks[addDays('2025-10-28', 30 * m)] = { paid: true, at: big - m };
    recurring.push({ id: 'r' + String(k).padStart(79, '0'), byHand: true, name: 'N'.repeat(60), amount: 10000000000, dueDay: 31, since: '2026-11-14', active: true,
      editedAt: big - k, payee: 'p0123456789abc', payeeAt: big - k, marks, skips: {} });
  }
  const tombs = {};
  for (let k = 0; k < 1000; k++) tombs['t' + String(k).padStart(79, '0')] = NOW - k;
  const state = { recurring, share: { tombs }, income: { sources: {}, firstReadAt: NOW, shared: { since: big, payers, items, counts } } };
  const file = exportShared(state, NOW);
  const text = JSON.stringify({ ...file, savedAt: big }, null, 1); // as roundShared writes it
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes < 950000, bytes + ' bytes');
  assert.ok(readSharedFile(text), 'and it is read back');
});

/* ------------------------------------------------------------------ 5. time passing */

test('5: when only time passes, a rebuild on the new game day brings what it stores up to the ledger\'s figure', () => {
  const s = longState();
  answerPayer(s, 'work', 'p-rowan', 'cash', NOW - 3 * HOUR_MS);
  countCash(s, 35000, NOW - 2 * HOUR_MS);
  read(s, [item('q2', 'p-rowan', 3000, NOW + 20 * HOUR_MS)]); // marked ahead of this device's clock: tomorrow's game day
  assert.equal(cashOf(s), 35000);
  const later = NOW + 25 * HOUR_MS;
  const account = cashAccountOf(s);
  assert.equal(makeLedger(s, later).accountValueOn(account.id, gameDay(later, 4)), 38000, 'the figure shown was already right');
  rebuildIncome(s, later); // what income.js does once the game day changes
  assert.equal(cashOf(s), 38000);
});

/* --------------------------------------------------------------------- 6. words */

test('6: Ask again toasts name their subject', () => {
  const s = longState();
  answerPayer(s, 'work', 'p-avery', 'bank', NOW - 3 * DAY_MS);
  read(s, [item('a1', 'p-avery', 7000, NOW - 5 * DAY_MS)]);
  answerItems(s, 'work', ['a1'], 'gone', NOW);
  askAgain(s, 'work', 'a1', NOW + MIN_MS);
  assert.equal(againWords(s, 'work/a1', NOW + MIN_MS, null), 'Session · Avery: it counts in pencil again; Networth asks about it on the board.');
});

test('6: cash answers made before the count keep who and what was answered', () => {
  const s = longState();
  read(s, [item('k1', 'p-avery', 12345, NOW - 5 * DAY_MS), item('v1', 'p-ivy', 4000, NOW - 2 * DAY_MS), item('v2', 'p-ivy', 4000, NOW - 2 * DAY_MS + MIN_MS)]);
  countCash(s, 15000, NOW - HOUR_MS);
  const had = new Set();
  answerItems(s, 'work', ['k1'], 'cash', NOW);
  const one = beforeCountWords(s, had, cashOf(s), TODAY, false);
  assert.equal(itemWords('Session · Avery', 'cash', one, NOW, 4),
    'Session · Avery was cash. The $123.45 was marked before today’s count, so Cash in hand stays $150.00. Ask again from the payment.');
  const had2 = new Set(['work/k1']);
  answerItems(s, 'work', ['v1', 'v2'], 'cash', NOW + MIN_MS);
  const two = beforeCountWords(s, had2, cashOf(s), TODAY, false);
  assert.equal(confirmWords('Session · Ivy', 2, 'cash', two),
    'Session · Ivy: 2 payments were cash. They were marked before today’s count, so Cash in hand stays $150.00. Ask again from each payment.');
  assert.equal(confirmWords('Session · Ivy', 1, 'cash', { stays: true, text: 'It was marked before today’s count, so Cash in hand stays as counted.' }),
    'Session · Ivy was cash. It was marked before today’s count, so Cash in hand stays as counted. Ask again from the payment.');
});

test('6: the bank row sheet says "Confirms" only with no question open for the row', () => {
  assert.equal(rowLineLead(false), 'Confirms ');
  assert.equal(rowLineLead(true), 'The board asks whether this is ');
});

/* ------------------------------------------------------- the views (by their source) */

test('3, 5 and 6 in the views: Show all, focus after Ask again and after a removal, the rebuild on a new game day, the sheet words', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = async (path) => readFile(new URL('../js/' + path, import.meta.url), 'utf8');
  const settings = await src('views/settings.js');
  assert.match(settings, /data-action="settings\.income-gone-all"/, 'the "in the bank" list opens in full');
  assert.match(settings, /'settings\.income-gone-all':/);
  assert.match(settings, /focusAfterAgain\(/, 'focus after Ask again in Settings');
  assert.match(settings, /id="set-income-head" tabindex="-1"/, 'the section heading takes focus when no Ask again is left');
  assert.match(settings, /payerWords\(/, 'a payer switch in Settings says what it did, as on the Board');
  const account = await src('views/sheet-account.js');
  const uncount = account.slice(account.indexOf("'account.uncount':"), account.indexOf("'account.remove':"));
  assert.match(uncount, /focusCountField\(\)/, 'focus moves to the count field after Remove the latest count');
  const tx = await src('views/sheet-tx.js');
  assert.match(tx, /rowLineLead\(/, 'the bank row sheet uses the one lead');
  const reader = await src('income.js');
  assert.match(reader, /rebuildIncome\(/, 'income is rebuilt when the game day changes');
});

test('2: the label of a count made today stays inside the chart at phone widths', async () => {
  const { chartSvg } = await import('../js/ui/charts.js');
  const days = [];
  for (let k = 30; k >= 0; k--) days.push({ day: addDays(TODAY, -k), smooth: 500000 + (30 - k) * 1000 });
  for (const W of [288, 320, 358, 1200]) {
    for (const rising of [true, false]) {
      const list = rising ? days : days.map((d, i) => ({ ...d, smooth: 600000 - i * 1000 }));
      const svg = chartSvg('worth', { days: list, events: [{ day: TODAY, label: 'revalued' }] }, W, 220);
      const m = svg.match(/<text class="nwc-i" x="([\d.]+)" y="[\d.]+"(?: text-anchor="(\w+)")?>revalued<\/text>/);
      assert.ok(m, 'the label is drawn at ' + W);
      const x = Number(m[1]);
      const w = 'revalued'.length * 12 * 0.46;
      const right = m[2] === 'end' ? x : m[2] === 'middle' ? x + w / 2 : x + w;
      assert.ok(right <= W, 'at ' + W + ' px the label ends at ' + right);
    }
  }
});
