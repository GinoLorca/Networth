/**
 * Money in and out, pass 1 (model/flows.js, views/flows.js; ARCHITECTURE 9): merchant totals counted as the
 * categories are, the period and its comparison, paydays like with like, the one counting rule of money in, the queue
 * of moves to file on two devices, the leaks, the transaction sheet that always passes the category, the words, and a
 * scan of what this pass added. Every merchant, payer, person and figure here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { defaultState, klassOf, makeAccount, makeRecurring, makeStream, makeTx } from '../js/model/schema.js';
import { makeLedger, spendingByCategory, spendingByMerchant, moneyIn } from '../js/model/ledger.js';
import { mergeFeed } from '../js/model/merge.js';
import { refresh } from '../js/model/detect.js';
import { learnRule, ruleMarkedReview, ruleOfRow, spendIndex } from '../js/model/classify.js';
import { exportCorrections, noteMove, readCorrections, restampCorrections } from '../js/model/corrections.js';
import { roundShared } from '../js/model/share.js';
import { ensureCashAccount } from '../js/model/income.js';
import { addDays, diffDays } from '../js/model/dates.js';
import { buildDemoState } from '../js/model/demo.js';
import {
  FAMILIES, PERIODS, bookBills, fileItem, inAndOut, inflow, isCatchAll, isFiled, leaks, moveQueue, periodOf, whereItWent, windowsOf,
} from '../js/model/flows.js';
import { PHRASES, TERMS, phrase, placeholders, term } from '../js/model/words.js';

/** Local time, so the tests read the same in every time zone. */
const at = (y, m, d, hour = 12, minute = 0) => new Date(y, m - 1, d, hour, minute).getTime();
/** Tuesday 16 June 2026 at noon. */
const NOON = at(2026, 6, 16);
const DAY_MS = 86400000;

let sequence = 0;
function tx(day, amount, fields = {}) {
  sequence += 1;
  return makeTx({ id: 'tx_f' + sequence, accountId: 'acc_chk', day, postedDay: day, amount, loggedAt: at(2026, 6, 1) + sequence, ...fields });
}
const spend = (day, amount, category, fields = {}) => tx(day, amount, { category, ...fields });
const refundOf = (day, amount, category, fields = {}) => tx(day, amount, { kind: 'refund', flow: 'in', category, ...fields });
const deposit = (day, amount, fields = {}) => tx(day, amount, { flow: 'in', kind: 'income', category: 'income', ...fields });
const bankAccount = (id, type, fields = {}) =>
  makeAccount({ id, source: 'bank', type, balance: 400000, basis: 'bank', name: id, asOf: at(2026, 6, 16, 9), ...fields });

function emptyState() {
  const state = defaultState(at(2026, 1, 1));
  state.accounts.push(bankAccount('acc_chk', 'checking'));
  state.sync.lastOk = at(2026, 6, 16, 9);
  return state;
}

/* ------------------------------------------------------------ merchant totals */

/** Rows that every counting rule of the ledger touches: a hidden account, a pending row, moves tapped in, a matched one, refunds. */
function shops() {
  const state = emptyState();
  state.accounts.push(bankAccount('acc_old', 'checking', { hidden: true }));
  state.txs.push(
    spend('2026-06-10', 1200, 'cafe', { mkey: 'fernleaf cafe', merchant: 'Fernleaf Cafe' }),
    spend('2026-06-12', 800, 'cafe', { mkey: 'fernleaf cafe', merchant: 'Fernleaf Cafe' }),
    spend('2026-06-12', 450, 'cafe', { mkey: 'brookline beans', merchant: 'Brookline Beans' }),
    refundOf('2026-06-13', 300, 'cafe', { mkey: 'fernleaf cafe', merchant: 'Fernleaf Cafe' }),
    spend('2026-06-11', 5000, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market' }),
    spend('2026-06-11', 9900, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market', accountId: 'acc_old' }), // hidden
    spend('2026-06-15', 700, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market', pending: true, postedDay: null }),
    spend('2026-06-14', 650, 'cafe', { source: 'manual', accountId: null, postedDay: null, mkey: 'fernleaf cafe', merchant: 'Fernleaf Cafe' }), // tapped in, 2 days old
    spend('2026-06-01', 400, 'cafe', { source: 'manual', accountId: null, postedDay: null, mkey: 'fernleaf cafe', merchant: 'Fernleaf Cafe' }), // tapped in, 15 days old
    spend('2026-06-09', 975, 'cafe', { source: 'manual', accountId: null, postedDay: null, mkey: 'fernleaf cafe', matchId: 'tx_elsewhere' }), // matched
    tx('2026-06-12', 20000, { kind: 'transfer', category: 'transfer', mkey: 'to savings' }),
    spend('2026-06-12', 2500, 'shopping', { mkey: 'lantern books', merchant: 'Lantern Books' }),
    refundOf('2026-06-14', 2500, 'shopping', { mkey: 'lantern books', merchant: 'Lantern Books' }), // returned in full
  );
  return state;
}

function byCategory(rows) {
  const out = {};
  for (const row of rows) out[row.category] = (out[row.category] || 0) + row.amount;
  return out;
}

test('spendingByMerchant counts exactly as spendingByCategory: hidden accounts, pending rows, moves tapped in, matched moves, refunds', () => {
  for (const countPending of [true, false]) {
    const state = shops();
    state.settings.countPending = countPending;
    const categories = spendingByCategory(state, '2026-06-01', '2026-06-16', NOON);
    const merchants = spendingByMerchant(state, '2026-06-01', '2026-06-16', NOON);
    const summed = byCategory(merchants);
    for (const row of categories) assert.equal(summed[row.category], row.amount, row.category + (countPending ? '' : ' (pending left out)'));
    const of = (mkey) => merchants.find((row) => row.mkey === mkey) || null;
    // Fernleaf: 1200 + 800 + 650 tapped in (within 7 days) − 300 refunded; the 15-day-old move and the matched one are gone
    assert.deepEqual([of('fernleaf cafe').amount, of('fernleaf cafe').count, of('fernleaf cafe').merchant], [2350, 3, 'Fernleaf Cafe']);
    assert.equal(of('brookline beans').amount, 450);
    // the hidden account's row never counts; the pending row only while pending rows count
    assert.equal(of('quarry market').amount, countPending ? 5700 : 5000);
    // a purchase returned in full nets to nothing and is left out, as its category is
    assert.equal(of('lantern books'), null);
    assert.equal(of('to savings'), null, 'a transfer is not spending');
  }
});

test('spendingByMerchant: one row per merchant and category, largest first; the ledger method answers the same', () => {
  const state = shops();
  state.txs.push(spend('2026-06-13', 3000, 'household', { mkey: 'quarry market', merchant: 'Quarry Market' }));
  const rows = spendingByMerchant(state, '2026-06-01', '2026-06-16', NOON);
  assert.deepEqual(rows.filter((row) => row.mkey === 'quarry market').map((row) => row.category).sort(), ['groceries', 'household']);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].amount >= rows[i].amount, 'largest first');
  assert.deepEqual(makeLedger(state, NOON).spendingByMerchant('2026-06-01', '2026-06-16'), rows);
  assert.deepEqual(spendingByMerchant(state, 'x', 'y', NOON), []);
});

/* ------------------------------------------------------------------ windows */

test('the period: 30, 90 or 365 days, each against the window of the same length just before it', () => {
  assert.deepEqual([...PERIODS], [30, 90, 365]);
  assert.equal(periodOf('90'), 90);
  assert.equal(periodOf(12), 30);
  assert.equal(periodOf(undefined), 30);
  const w = windowsOf('2026-06-16', 30, '2025-12-01');
  assert.deepEqual([w.from, w.to, w.prevFrom, w.prevTo, w.comparable, w.covered], ['2026-05-18', '2026-06-16', '2026-04-18', '2026-05-17', true, 30]);
  assert.equal(diffDays(w.prevFrom, w.prevTo) + 1, 30);
  const year = windowsOf('2026-06-16', 365, '2025-12-01');
  assert.equal(year.comparable, false, 'the record does not cover the year before');
  assert.equal(year.covered, diffDays('2025-12-01', '2026-06-16') + 1, 'the days on record in the year');
});

test('a short record: the comparison is left out and the first day on record is given', () => {
  const state = emptyState();
  state.txs.push(spend('2026-05-30', 2000, 'groceries', { mkey: 'quarry market' }), deposit('2026-06-05', 90000, { mkey: 'harbor works payroll' }));
  const io = inAndOut(state, NOON, 30);
  assert.equal(io.window.comparable, false);
  assert.equal(io.window.firstDay, '2026-05-30');
  assert.equal(io.window.covered, 18);
  assert.deepEqual([io.out.cents, io.out.before, io.out.change], [2000, null, null]);
  assert.deepEqual([io.in.cents, io.in.before, io.in.change], [90000, null, null]);
  const went = whereItWent(state, NOON, 30);
  assert.equal(went.change, null);
  assert.ok(went.groups.every((group) => group.change === null));
});

/** A payer paid every second Friday, 1,400.00 each time, and a client now and then (not pay). */
function twoWeekly(lastPayday, today) {
  const state = emptyState();
  state.streams.push(makeStream({ id: 'str_pay', name: 'Harbor Works', kind: 'salary', accountId: 'acc_chk', mkey: 'harbor works payroll',
    cadence: 'biweekly', anchor: lastPayday, amount: 140000, accrue: true }));
  for (let day = lastPayday; day >= addDays(today, -120); day = addDays(day, -14)) {
    state.txs.push(deposit(day, 140000, { streamId: 'str_pay', mkey: 'harbor works payroll' }));
  }
  state.txs.push(deposit(addDays(today, -3), 25000, { mkey: 'zelle from ivy marsh' }));
  state.txs.push(spend(addDays(today, -100), 1000, 'groceries', { mkey: 'quarry market' }));
  return state;
}

test('paydays like with like: a two-weekly payer whose payday falls on the period’s first day', () => {
  // today Tuesday 16 June; the 30 days run from Monday 18 May; paydays on 18 May, 1 Jun and 15 Jun: three in the period,
  // two (4 May, 20 Apr) in the 30 before
  const state = twoWeekly('2026-06-15', '2026-06-16');
  const io = inAndOut(state, NOON, 30);
  assert.equal(io.window.from, '2026-05-18');
  assert.deepEqual([io.paydays.now, io.paydays.before, io.paydays.extra, io.paydays.left], [3, 2, 1, 140000]);
  assert.equal(io.in.cents, 3 * 140000 + 25000);
  assert.equal(io.in.before, 2 * 140000);
  assert.equal(io.in.change, 25000, 'the extra payday is left out: the change is the client alone');
});

test('paydays like with like: the payday falls on the last day of the window before', () => {
  // paydays on 17 May (the day before the period), 31 May and 14 Jun: two in the period, three in the 30 before
  const state = twoWeekly('2026-06-14', '2026-06-16');
  const io = inAndOut(state, NOON, 30);
  assert.equal(io.window.prevTo, '2026-05-17');
  assert.deepEqual([io.paydays.now, io.paydays.before, io.paydays.extra], [2, 3, -1]);
  assert.equal(io.in.change, 25000, 'the window before’s extra payday is left out too');
  // the same rule for 90 days
  const longer = inAndOut(state, NOON, 90);
  assert.equal(longer.window.comparable, false, 'a record of 120 days cannot compare 90 with 90');
});

/* ----------------------------------------------------------------- money in */

test('inflow: bank deposits plus reported payments no bank deposit has matched, a matched payment once, pencil and cash named', () => {
  const state = emptyState();
  state.accounts.push(bankAccount('acc_old', 'checking', { hidden: true }));
  const cash = ensureCashAccount(state);
  const bank = deposit('2026-06-10', 9000, { mkey: 'session payout' });
  state.txs.push(
    deposit('2026-06-05', 150000, { mkey: 'harbor works payroll' }),
    bank,
    // reported by the owner's other app: met by the bank row above (counted once, as the bank row), in pencil, in cash
    tx('2026-06-09', 9000, { source: 'manual', via: 'income', kind: 'income', flow: 'in', category: 'income', accountId: null, postedDay: null, matchId: bank.id }),
    tx('2026-06-12', 7000, { source: 'manual', via: 'income', kind: 'income', flow: 'in', category: 'income', accountId: null, postedDay: null }),
    tx('2026-06-13', 5000, { source: 'manual', via: 'income', kind: 'income', flow: 'in', category: 'income', accountId: cash.id, postedDay: null }),
    // never money in: a refund, a transfer in, a deposit on a hidden account
    refundOf('2026-06-11', 2500, 'shopping'),
    tx('2026-06-11', 30000, { kind: 'transfer', flow: 'in', category: 'transfer' }),
    deposit('2026-06-11', 40000, { accountId: 'acc_old' }),
    deposit('2026-06-16', 1100, { pending: true, postedDay: null }),
  );
  const got = inflow(state, '2026-06-01', '2026-06-16', NOON);
  assert.deepEqual([got.bank, got.pencil, got.cash, got.total], [150000 + 9000 + 1100, 7000, 5000, 150000 + 9000 + 1100 + 7000 + 5000]);
  assert.equal(got.unposted, true, 'a pending deposit makes the figure an estimate');
  assert.deepEqual(moneyIn(state, '2026-06-01', '2026-06-16', NOON).total, got.total);
  state.settings.countPending = false;
  assert.equal(inflow(state, '2026-06-01', '2026-06-16', NOON).bank, 159000, 'pending deposits only while pending counts');
  // money in on the face is this rule: an estimate while any of it is in pencil
  const io = inAndOut(state, NOON, 30);
  assert.equal(io.in.pencil, 7000);
  assert.equal(io.in.est, true);
});

/* ------------------------------------------------------------------ the queue */

function dateOnly(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

function row(extId, amount, day, description, pending = false) {
  return { extId, amount, posted: pending ? null : dateOnly(day), at: pending ? dateOnly(day) : null, pending, description, payee: '', memo: '', mcc: null };
}

const ROWS = [
  row('C1', -1250, '2026-06-02', 'FERNLEAF CAFE 0042'),
  row('C2', -980, '2026-06-09', 'FERNLEAF CAFE 0042'),
  row('A1', -2399, '2026-06-03', 'AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA'),
  row('A2', -4150, '2026-06-08', 'AMZN Mktp US*7Q2RT88W1 Amzn.com/bill WA'),
  row('Z1', -6000, '2026-06-04', 'Zelle payment to TOBIAS REED 1234567'),
  row('Z2', -4000, '2026-06-11', 'Zelle payment to TOBIAS REED 1234598'),
  row('Z3', -2500, '2026-06-06', 'Zelle payment to MARA OKAFOR 7654321'),
  row('L1', -3300, '2026-06-07', 'LINDEN AND OAK TRADING'),
  row('P1', -1800, '2026-06-15', 'FERNLEAF CAFE 0042', true),
  row('OLD', -900, '2026-02-02', 'FERNLEAF CAFE 0042'),
];

function feed(rows, nowMs = NOON) {
  return {
    src: 'simplefin', fetchedAt: nowMs, fromMs: nowMs - 200 * DAY_MS, toMs: nowMs, errors: [],
    accounts: [{ extId: 'ACT-CHK-9', connId: 'CON-1', institution: 'Example Bank', name: 'Main Checking', currency: 'USD',
      balance: 812345, available: 812345, asOf: nowMs - 3600000, txs: rows }],
  };
}

/** One shared file in memory, written only with the sha just read (as on GitHub). */
function repoOf() {
  const repo = { text: null, sha: null, n: 0 };
  repo.transport = {
    read: async () => ({ text: repo.text, sha: repo.sha }),
    write: async (text, sha) => {
      if (sha !== repo.sha) throw Object.assign(new Error('conflict'), { code: 'conflict' });
      repo.text = text;
      repo.sha = 'sha' + (++repo.n);
      return {};
    },
  };
  return repo;
}

/** A device that read the same bank: its record, the copies Undo keeps, and a sharing round. */
function device(repo) {
  const d = { state: defaultState(NOON - 200 * DAY_MS), kept: [] };
  mergeFeed(d.state, feed(ROWS), NOON);
  refresh(d.state, NOON);
  const api = {
    state: () => d.state,
    update: (now, past) => {
      now(d.state);
      d.kept = d.kept.map((json) => { const copy = JSON.parse(json); past(copy); return JSON.stringify(copy); });
    },
  };
  d.change = (fn) => { d.kept.push(JSON.stringify(d.state)); fn(d.state); };
  d.undo = () => {
    const before = d.state;
    d.state = JSON.parse(d.kept.pop());
    restampCorrections(before, d.state);
  };
  d.round = (nowMs) => roundShared(api, repo.transport, () => nowMs);
  d.queue = () => moveQueue(d.state, NOON);
  d.keys = () => d.queue().items.map((item) => item.key);
  d.item = (pred) => d.queue().items.find(pred) || null;
  d.file = (item, category, stamp) => d.change((s) => fileItem(s, item, category, stamp, NOON));
  return d;
}

async function rounds(devices, nowMs) {
  for (let i = 0; i < 2; i++) for (const d of devices) await d.round(nowMs + i);
}

test('the queue: posted spends of 90 days not filed by the owner, one item per merchant and direction, catch-alls one at a time', () => {
  const d = device(repoOf());
  const q = d.queue();
  const names = q.items.map((item) => item.merchant + ' ' + item.count);
  // the pending row and the row of February are not queued; the two cafe moves are one item, each Amazon order its own
  assert.ok(names.includes('Fernleaf Cafe 2'), names.join(', '));
  assert.equal(q.items.filter((item) => item.mkey === 'amazon').length, 2);
  assert.ok(q.items.filter((item) => item.mkey === 'amazon').every((item) => item.catchAll && item.count === 1 && item.key.startsWith('move:i')));
  // Zelle files the whole person: one item per person, never one per move
  const zelle = q.items.filter((item) => item.mkey.startsWith('zelle to '));
  assert.deepEqual(zelle.map((item) => [item.mkey, item.count, item.catchAll]).sort(), [['zelle to mara okafor', 1, false], ['zelle to tobias reed', 2, false]]);
  assert.equal(q.moves, 2 + 2 + 2 + 1 + 1);
  assert.equal(q.out, q.items.length, 'money out only in this pass');
});

test('the queue’s order: Uncategorized first, then moves the built-in rule marks for a look, then confident guesses', () => {
  const d = device(repoOf());
  const tiers = d.queue().items.map((item) => [item.tier, item.guess, item.mkey]);
  assert.deepEqual(tiers.map(([tier]) => tier), [...tiers.map(([tier]) => tier)].sort((a, b) => a - b), 'tiers in order');
  assert.equal(tiers[0][1], 'other');
  const amazon = tiers.find(([, , mkey]) => mkey === 'amazon');
  const cafe = tiers.find(([, , mkey]) => mkey === 'fernleaf cafe');
  assert.deepEqual([amazon[0], cafe[0]], [1, 2]);
  assert.equal(ruleMarkedReview('builtin:amazon'), true, 'read from the rule, which travels with the build');
  assert.equal(ruleMarkedReview('builtin:cafe'), false);
  assert.equal(ruleMarkedReview(null), false);
  // a row's own review flag is cleared per device and does not travel: it orders nothing
  const other = device(repoOf());
  for (const t of other.state.txs) t.review = false;
  assert.deepEqual(other.queue().items.map((item) => item.key), d.queue().items.map((item) => item.key));
});

test('the queue’s chips: the guess first, then the owner’s most-filed categories for that direction, filled from the days’ own', () => {
  const d = device(repoOf());
  const cafe = d.item((item) => item.mkey === 'fernleaf cafe');
  assert.equal(cafe.chips[0], 'cafe', 'the guess first');
  assert.ok(cafe.chips.length <= 4 && new Set(cafe.chips).size === cafe.chips.length);
  const zelle = d.item((item) => item.mkey === 'zelle to tobias reed');
  assert.ok(!zelle.chips.includes('other'), 'Uncategorized is never offered as a chip');
  // once the owner files gifts twice, gifts leads the chips after the guess
  d.file(zelle, 'gifts', NOON + 1000);
  const amazon = d.item((item) => item.mkey === 'amazon');
  assert.equal(amazon.chips[0], 'shopping');
  assert.equal(amazon.chips[1], 'gifts');
});

test('one tap files a merchant back and forward through the sheet’s own save sequence; the category is always passed', () => {
  const d = device(repoOf());
  const cafe = d.item((item) => item.mkey === 'fernleaf cafe');
  let result = null;
  d.change((s) => { result = fileItem(s, cafe, cafe.guess, NOON + 1000, NOON); });
  assert.equal(result.filed, true);
  const rows = d.state.txs.filter((t) => t.mkey === 'fernleaf cafe');
  const latest = d.state.txs.find((t) => t.id === cafe.txId);
  assert.ok(latest.locks.includes('category') && latest.locks.includes('review'), 'locked and confirmed, as the sheet does');
  assert.ok(d.state.settings.rules.some((rule) => rule.mkey === 'fernleaf cafe' && rule.flow === 'out' && rule.category === 'cafe'), 'a rule for all money out');
  assert.ok(rows.every((t) => isFiled(d.state, t)), 'every move of the merchant is filed now, the pending one included');
  assert.equal(d.item((item) => item.mkey === 'fernleaf cafe'), null);
  // the correction is written in the format the corrections already use: a row entry with its category, and the rule
  const copy = exportCorrections(d.state);
  assert.notEqual(readCorrections(copy), null);
  const entries = Object.values(copy.moves);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['category', 'day', 'fp']);
  assert.equal(entries[0].category.v, 'cafe');
  assert.ok(Object.keys(copy.rules).some((key) => key.endsWith(':out')));
  // Undo takes the filing back: the merchant is in the queue again
  d.undo();
  assert.notEqual(d.item((item) => item.mkey === 'fernleaf cafe'), null);
});

test('two devices that show the same accounts hold the same queue after the corrections merge; a guess confirmed as it is leaves both', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  // B holds the same rows under its own ids
  for (const t of b.state.txs) t.id = t.id.replace('tx_', 'tx_b');
  await rounds([a, b], NOON + 100);
  assert.deepEqual(a.keys(), b.keys(), 'the same membership and order before any filing');
  // on A: the cafe confirmed at its guess, one Amazon order filed on its own, a Zelle payee filed as gifts
  const cafe = a.item((item) => item.mkey === 'fernleaf cafe');
  a.file(cafe, cafe.guess, NOON + 1000);
  const order = a.item((item) => item.mkey === 'amazon');
  a.file(order, 'household', NOON + 2000);
  a.file(a.item((item) => item.mkey === 'zelle to tobias reed'), 'gifts', NOON + 3000);
  await rounds([a, b], NOON + 5000);
  assert.deepEqual(a.keys(), b.keys(), 'the same queue on both devices after the merge');
  for (const d of [a, b]) {
    assert.equal(d.item((item) => item.mkey === 'fernleaf cafe'), null, 'the confirmed guess left the queue');
    assert.equal(d.item((item) => item.key === order.key), null, 'the Amazon order filed');
    assert.equal(d.queue().items.filter((item) => item.mkey === 'amazon').length, 1, 'the other Amazon order still waits: one at a time');
    assert.ok(!d.state.settings.rules.some((rule) => rule.mkey === 'amazon'), 'a catch-all teaches no rule');
    assert.equal(d.item((item) => item.mkey === 'zelle to tobias reed'), null, 'both payments to the person are filed');
    assert.notEqual(d.item((item) => item.mkey === 'zelle to mara okafor'), null, 'another person still waits');
  }
  // A takes the Zelle filing back: it is back in the queue on both devices
  a.undo();
  await rounds([a, b], NOON + 9000);
  assert.deepEqual(a.keys(), b.keys());
  assert.notEqual(b.item((item) => item.mkey === 'zelle to tobias reed'), null);
});

test('a hidden account’s moves are queued only on the devices that show it', () => {
  const d = device(repoOf());
  const before = d.queue().items.length;
  d.state.accounts.find((account) => account.source === 'bank').hidden = true;
  assert.ok(before > 0);
  assert.equal(d.queue().items.length, 0);
});

test('catch-alls: Amazon, big stores, marketplaces, payment apps, cheques, a processor that names no shop, a move with no key', () => {
  const of = (ruleId, mkey) => isCatchAll({ ruleId, mkey });
  for (const id of ['amazon', 'big-box', 'ebay', 'marketplace', 'wallet-payment', 'cheque-bill-pay']) assert.equal(of('builtin:' + id, 'some key'), true, id);
  assert.equal(of('builtin:processor', 'sq'), true);
  assert.equal(of('builtin:shopping', 'paypal'), true, 'a key that only names the processor, whatever the rule');
  assert.equal(of('builtin:processor', 'holloway prints'), false, 'a shop paid through a processor files once');
  assert.equal(of('builtin:shopping', 'lantern books'), false, 'the shopping rule names single stores');
  assert.equal(of('builtin:zelle', 'zelle to tobias reed'), false, 'Zelle names one person');
  assert.equal(of(null, ''), true);
});

/* ------------------------------------------------------------------- leaks */

/** A Book line with its monthly charges, each filed by a built-in rule. */
function line(state, id, name, mkey, ruleId, amounts, fields = {}) {
  const days = amounts.map((_, i) => addDays('2026-06-12', -30 * (amounts.length - 1 - i)));
  state.recurring.push(makeRecurring({ id, name, mkey, accountId: 'acc_chk', cadence: 'monthly', anchor: days[days.length - 1], amount: amounts[amounts.length - 1], category: 'subscriptions', ...fields }));
  amounts.forEach((amount, i) => state.txs.push(spend(days[i], amount, fields.category || 'subscriptions', { mkey, merchant: name, ruleId, recurringId: id, klass: 'book' })));
}

function leaky() {
  const state = emptyState();
  state.txs.push(
    spend('2026-06-01', 9000, 'fees_interest', { mkey: 'interest charge', merchant: 'Interest charge', ruleId: 'builtin:interest-charge' }),
    spend('2026-06-03', 2900, 'fees_interest', { mkey: 'late fee', merchant: 'Late fee', ruleId: 'builtin:late-fee', glyph: '??' }),
    refundOf('2026-06-06', 2900, 'fees_interest', { mkey: 'fee reversal', merchant: 'Fee reversal', ruleId: 'builtin:fee-reversal' }),
  );
  for (let i = 0; i < 6; i++) state.txs.push(spend(addDays('2026-05-20', 4 * i), 290, 'shopping', { mkey: 'pocket press', merchant: 'Pocket Press' }));
  for (let i = 0; i < 10; i++) state.txs.push(spend(addDays('2026-05-20', 2 * i), 450, 'cafe', { mkey: 'fernleaf cafe', merchant: 'Fernleaf Cafe', klass: 'game' }));
  for (let i = 0; i < 5; i++) state.txs.push(spend(addDays('2026-05-21', 5 * i), 4500, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market' }));
  line(state, 'rec_nf', 'Netflix', 'netflix', 'builtin:netflix', [1549, 1549, 1549, 1799]);
  line(state, 'rec_hu', 'Hulu', 'hulu', 'builtin:hulu', [999, 999, 999]);
  line(state, 'rec_ap', 'Apple services', 'apple services', 'builtin:apple-services', [299, 299, 299]);
  line(state, 'rec_go', 'Google One', 'google subscription', 'builtin:google-subscription', [199, 199, 199]);
  line(state, 'rec_pw', 'Gridline Power', 'gridline power', 'builtin:utility', [9100, 8200, 9900], { variable: true, category: 'utilities' });
  return state;
}

test('leak 1, fees and interest: net of reversals, broken down by the rule’s label, ?? on an avoidable penalty', () => {
  const { fees } = leaks(leaky(), NOON, 30);
  assert.equal(fees.cents, 9000, 'the late fee and its reversal cancel');
  assert.equal(fees.penalty, true);
  assert.deepEqual(fees.parts.map((part) => [part.label, part.cents, part.penalty]), [['Interest charge', 9000, false], ['Late fee', 2900, true], ['Fee reversal', -2900, false]]);
  assert.equal(fees.year, Math.round(9000 * 365.25 / 30), '≈ a year, scaled from the period');
});

test('leak 2, the daily game: its total, its stops, the mean a stop and the change', () => {
  const { game } = leaks(leaky(), NOON, 30);
  assert.deepEqual([game.cents, game.stops, game.mean], [4500, 10, 450]);
  assert.equal(game.change, 4500, 'nothing in the 30 before');
});

test('leak 3, small and often: 4 or more moves per 30 days at a median of $20 or less, outside the daily game, the Book and fees', () => {
  const { small } = leaks(leaky(), NOON, 30);
  assert.deepEqual(small.named.map((one) => [one.merchant, one.count]), [['Pocket Press', 6]]);
  assert.equal(small.cents, 6 * 290);
  // the cafe (the daily game) and the grocer (a median of $45) are not here; nor any line of the Book
  const state = leaky();
  state.txs.splice(state.txs.findIndex((t) => t.mkey === 'pocket press'), 3);
  assert.equal(leaks(state, NOON, 30).small, null, 'three moves in 30 days are not often enough');
});

test('small and often never fires on a visit or two, however short the record', () => {
  const state = emptyState();
  const fare = (day) => spend(day, 300, 'shopping', { mkey: 'pocket press', merchant: 'Pocket Press' });
  state.txs.push(fare('2026-06-14'), fare('2026-06-15'));
  const l = leaks(state, NOON, 30);
  assert.equal(l.window.covered, 3, 'a record of three days');
  assert.equal(l.small, null, 'two visits are not often, whatever the rate');
  state.txs.push(fare('2026-06-16'), fare('2026-06-16'));
  assert.equal(leaks(state, NOON, 30).small.named[0].count, 4);
});

test('the Book’s bills: no subscription and no card payment; an amount is roman only as the last charge the bank reported', () => {
  const state = leaky();
  line(state, 'rec_rent', 'Kestrel Rent', 'kestrel rent', null, [150000, 150000], { category: 'housing' });
  state.recurring.push(makeRecurring({ id: 'rec_gym', name: 'Gym by hand', mkey: 'gym', accountId: 'acc_chk', cadence: 'monthly', anchor: '2026-06-20', amount: 4000, category: 'health', source: 'manual' }));
  const bills = bookBills(state, '2026-06-16');
  assert.deepEqual(bills.lines.map((one) => [one.name, one.est, one.variable]), [['Kestrel Rent', false, false], ['Gridline Power', true, true], ['Gym by hand', true, false]]);
  assert.equal(bills.perMonth, bills.lines.reduce((sum, one) => sum + one.perMonth, 0));
  assert.ok(!bills.lines.some((one) => ['Netflix', 'Hulu', 'Apple services', 'Google One'].includes(one.name)), 'subscriptions wait for their own list');
});

test('small and often never names a need, however often: transit, the car, health and cash taken out', () => {
  const state = emptyState();
  const needs = [['transit', 'metro farecard', 290], ['tolls_parking', 'bridge toll', 690], ['fuel_auto', 'corner fuel', 1500], ['health', 'canal pharmacy', 900], ['cash_withdrawal', 'atm withdrawal', 2000]];
  for (const [category, mkey, cents] of needs) {
    for (let i = 0; i < 12; i++) state.txs.push(spend(addDays('2026-05-21', 2 * i), cents, category, { mkey, merchant: mkey }));
  }
  assert.equal(leaks(state, NOON, 30).small, null, 'twelve visits each, and still needs');
  for (let i = 0; i < 4; i++) state.txs.push(spend(addDays('2026-06-01', 3 * i), 450, 'shopping', { mkey: 'pocket press', merchant: 'Pocket Press' }));
  assert.deepEqual(leaks(state, NOON, 30).small.named.map((one) => one.merchant), ['Pocket Press']);
});

test('leak 4, doubled: two single-service lines of one family; an Apple charge and a Google One charge never; Keep on every line silences it', () => {
  const state = leaky();
  const { doubled } = leaks(state, NOON, 30);
  assert.deepEqual(doubled.map((d) => [d.kind, d.name, d.lines.map((l) => l.name).sort()]), [['family', 'video', ['Hulu', 'Netflix']]]);
  assert.equal(doubled[0].cents, 1799 + 999, 'the charges of the period');
  assert.ok(FAMILIES.video.includes('netflix') && !Object.values(FAMILIES).flat().some((id) => ['apple-services', 'google-subscription', 'google-play', 'microsoft', 'streaming'].includes(id)));
  state.recurring.find((rec) => rec.id === 'rec_nf').verdict = 'keep';
  assert.equal(leaks(state, NOON, 30).doubled.length, 1, 'Keep on one line of two leaves it');
  state.recurring.find((rec) => rec.id === 'rec_hu').verdict = 'keep';
  assert.equal(leaks(state, NOON, 30).doubled.length, 0, 'Keep on every line silences it');
  // one service active on two accounts: told once, as that, and not as a family of one service
  const two = leaky();
  two.accounts.push(bankAccount('acc_crd', 'credit_card'));
  line(two, 'rec_sp1', 'Spotify', 'spotify', 'builtin:spotify', [1199, 1199]);
  line(two, 'rec_sp2', 'Spotify', 'spotify', 'builtin:spotify', [1199, 1199], { accountId: 'acc_crd' });
  assert.deepEqual(leaks(two, NOON, 30).doubled.map((d) => [d.kind, d.name, d.accounts]).sort(), [['accounts', 'Spotify', 2], ['family', 'video', 0]]);
  // never a key of many services on two accounts (two Apple charges, two Google One charges), nor interest on two cards
  const many = leaky();
  many.accounts.push(bankAccount('acc_crd', 'credit_card'), bankAccount('acc_crd2', 'credit_card'));
  line(many, 'rec_ap2', 'Apple services', 'apple services', 'builtin:apple-services', [999, 999], { accountId: 'acc_crd' });
  line(many, 'rec_go2', 'Google One', 'google subscription', 'builtin:google-subscription', [199, 199], { accountId: 'acc_crd' });
  line(many, 'rec_in1', 'Interest charge', 'interest charge', 'builtin:interest-charge', [4100, 3900], { accountId: 'acc_crd', category: 'fees_interest' });
  line(many, 'rec_in2', 'Interest charge', 'interest charge', 'builtin:interest-charge', [2100, 2300], { accountId: 'acc_crd2', category: 'fees_interest' });
  assert.deepEqual(leaks(many, NOON, 30).doubled.map((d) => [d.kind, d.name]), [['family', 'video']]);
});

test('leak 5, price rise: a steady line whose latest charge stepped above its level, inside the period; a variable line never', () => {
  const { rises } = leaks(leaky(), NOON, 30);
  assert.deepEqual(rises.map((r) => [r.name, r.from, r.to, r.step, r.day, r.year]), [['Netflix', 1549, 1799, 250, '2026-06-12', 3000]]);
  const state = leaky();
  assert.equal(leaks(state, at(2026, 8, 20), 30).rises.length, 0, 'a rise dated before the period is not one of its leaks');
});

test('the leaks are never added up, and the sample game shows every one of them', () => {
  const nowMs = at(2026, 6, 18, 14, 30);
  const state = buildDemoState(nowMs);
  const l = leaks(state, nowMs, 30);
  assert.ok(l.fees && l.fees.penalty, 'a fee with a ?? penalty');
  assert.ok(l.game && l.small, 'the daily game, and something small and often');
  assert.ok(l.doubled.some((d) => d.name === 'video'), 'two services of one family');
  assert.ok(l.rises.some((r) => r.name === 'Netflix'), 'a price rise on a Book line');
  assert.equal('total' in l, false);
  const bills = bookBills(state, '2026-06-18');
  assert.ok(bills.count > 0 && bills.lines.every((one) => one.perMonth >= 0));
  assert.ok(!bills.lines.some((one) => /northlight visa/i.test(one.name)), 'a payment to a card is no bill');
  assert.ok(!state.recurring.filter((rec) => rec.category === 'subscriptions').some((rec) => bills.lines.some((one) => one.id === rec.id)), 'subscriptions wait for their own list');
  const q = moveQueue(state, nowMs);
  assert.ok(q.items.length > 0, 'the sample game has moves to file');
  const went = whereItWent(state, nowMs, 30);
  assert.equal(went.total, makeLedger(state, nowMs).spendingByCategory(went.window.from, went.window.to).reduce((n, r) => n + r.amount, 0));
  assert.ok(went.groups.every((group) => group.rows.every((one) => one.merchants.reduce((n, m) => n + m.amount, 0) === one.amount)), 'a category’s merchants add up to it');
  assert.equal(went.groups.reduce((n, group) => n + group.amount, 0), went.total, 'the groups add up to all spending');
  // a spend filed under a category of no class still counts, in a group of its own
  const odd = emptyState();
  odd.txs.push(spend('2026-06-10', 1500, 'groceries', { mkey: 'quarry market' }), spend('2026-06-11', 700, 'income', { mkey: 'odd row' }));
  const oddWent = whereItWent(odd, NOON, 30);
  assert.equal(oddWent.groups.reduce((n, group) => n + group.amount, 0), oddWent.total);
});

/* ------------------------------------------------------- the sheet passes the category */

test('the transaction sheet always passes the category, so saving a guess as it stands files it (Appendix D)', async () => {
  const sheet = await readFile(new URL('../js/views/sheet-tx.js', import.meta.url), 'utf8');
  // an unchanged category is passed on a spend or refund not filed yet, and left out on one already filed (round 1,
  // finding 1), on Uncategorized and on other money in (round 2, findings 1 and 3); a guess confirmed keeps its class
  assert.match(sheet, /const confirms = categoryGiven && !categoryChanged && isSpendish\(tx\) && values\.category !== UNFILED && !isFiled\(ctx\.state, tx\);/);
  assert.match(sheet, /if \(categoryChanged \|\| confirms\) fields\.category = values\.category;/);
  assert.match(sheet, /const keptKlass = confirms && !fields\.klass \? confirmedKlass\(tx, values\.category\) : null;/);
  assert.doesNotMatch(sheet, /values\.category !== tx\.category\) fields\.category/, 'an unchanged category is not simply skipped');
  // what the sheet then does with an unchanged guess: the row is locked and a correction is written, for all money out
  const d = device(repoOf());
  const row = d.state.txs.find((t) => t.mkey === 'fernleaf cafe' && t.ext && t.ext.id === 'C2');
  assert.equal(row.category, 'cafe');
  d.change((s) => { learnRule(s, row.id, { category: row.category }, { onlyThis: false }); noteMove(s, row.id, NOON + 500); });
  assert.ok(d.state.txs.find((t) => t.id === row.id).locks.includes('category'));
  assert.equal(Object.values(exportCorrections(d.state).moves).length, 1);
  assert.equal(d.item((item) => item.mkey === 'fernleaf cafe'), null);
  // Uncategorized is no filing, even locked: such a move still waits in the queue, as in "Not yet filed" (round 2)
  const linden = d.state.txs.find((t) => t.mkey === 'linden and oak trading');
  d.change((s) => { learnRule(s, linden.id, { category: 'other' }, { onlyThis: true }); });
  assert.ok(d.state.txs.find((t) => t.id === linden.id).locks.includes('category'));
  assert.ok(d.item((item) => item.mkey === 'linden and oak trading'));
  // a catch-all's sheet defaults to this move only, so a plain Save teaches no rule for the whole of Amazon
  assert.match(sheet, /isSpendish\(tx\) && isCatchAll\(tx\)/);
});

test('the sheet’s own Save and the queue’s own one tap, run through the store: filed, undoable, and no amount in a toast under cover', () => {
  const helper = fileURLToPath(new URL('./helpers/flows-save.mjs', import.meta.url));
  for (const cover of [false, true]) {
    const out = JSON.parse(execFileSync(process.execPath, [helper, ...(cover ? ['cover'] : [])], { encoding: 'utf8' }));
    assert.deepEqual(out.before, ['amazon (one)', 'amazon (one)', 'quarry market', 'fernleaf cafe']);
    // the sheet saved with its guess as it stands: the category is passed, locked, written as a correction with a rule
    // for all money out, and the merchant leaves the queue
    assert.deepEqual([out.sheet.locked, out.sheet.category, out.sheet.moves, out.sheet.rules], [true, out.cafeGuess, [out.cafeGuess], 1]);
    assert.deepEqual(out.sheet.queue, ['amazon (one)', 'amazon (one)', 'quarry market']);
    assert.deepEqual(out.sheet.toast, { message: 'Filed: Fernleaf Cafe as Coffee & cafes.', action: 'Undo' });
    // one tap files the whole merchant in one undoable update, and its Undo puts it back
    assert.equal(out.tap.toast.message, 'Filed: Quarry Market as Groceries, 2 moves on record and every later one.');
    assert.deepEqual(out.tap.queue, ['amazon (one)', 'amazon (one)']);
    assert.equal(out.tap.undoLabel, 'Move filed');
    assert.deepEqual(out.undone, ['amazon (one)', 'amazon (one)', 'quarry market']);
    // a catch-all files this move only and teaches no rule
    assert.equal(out.order.toast.message, 'Filed: this move at Amazon as Household.');
    assert.deepEqual(out.order.queue, ['amazon (one)', 'quarry market']);
    assert.equal(out.order.amazonRule, false);
    // a note alone, saved on a move filed "this move only" at a store that follows a learned rule: the form posts the
    // move's category and "All money out", and still the rule, the other moves and what travels stay as they were
    assert.deepEqual(out.note.before, { rule: ['groceries'], categories: ['groceries', 'household', 'groceries'] });
    assert.deepEqual([out.note.rule, out.note.categories, out.note.travels], [['groceries'], ['groceries', 'household', 'groceries'], ['groceries']]);
    assert.equal(out.note.note, 'paper towels');
    assert.equal(out.note.toast.message, 'Move updated.');
    // a store's refund waiting beside its money-out item: the item says its tap files the refunds, and the toast names them
    assert.deepEqual(out.refund.before, ['in:quarry market', 'out:quarry market']);
    assert.equal(out.refund.refunds, 1);
    assert.equal(out.refund.toast.message, 'Filed: Quarry Market as Groceries, 2 moves and 1 refund on record and every later one.');
    assert.deepEqual([out.refund.after, out.refund.refundCategory], [[], 'groceries']);
    // Uncategorized files nothing by a save (round 2, finding 1): a note alone, then Save as it stands, on a Zelle
    // payment to one person leave no rule and no lock, so the payments stay in the queue and in "Not yet filed" alike,
    // and the toasts are the starting build's
    assert.deepEqual(out.zelle.before, { queued: 2, unfiled: 6500 });
    for (const one of [out.zelle.note, out.zelle.asIs]) {
      assert.deepEqual([one.rules, one.travels, one.queued, one.unfiled], [0, { rules: 0, moves: 0 }, 2, 6500]);
      assert.deepEqual(one.rows.map(([category, , locks, ruleId]) => [category, locks, ruleId]), [['other', '-', 'builtin:zelle'], ['other', '-', 'builtin:zelle']]);
    }
    assert.equal(out.zelle.note.note, 'shared dinner');
    assert.equal(out.zelle.note.toast.message, 'Move updated.');
    assert.match(out.zelle.asIs.toast.message, /^Confirmed as read: Zelle To Robin Vale, /);
    // the same note on one payment-app move (this move only by default): no lock, and both moves still wait
    assert.deepEqual([out.venmo.before, out.venmo.after, out.venmo.travels], [2, 2, { rules: 0, moves: 0 }]);
    assert.deepEqual(out.venmo.rows.map(([, , locks]) => locks), ['-', '-']);
    assert.equal(out.venmo.toast.message, 'Move updated.');
    // money in that is no refund keeps its own filing for later (round 2, finding 3): a note on a check deposit learns nothing
    assert.deepEqual(out.cheque.rows.map(([category, , locks, ruleId]) => [category, locks, ruleId]), [['income', '-', 'builtin:deposit'], ['income', '-', 'builtin:deposit']]);
    assert.deepEqual([out.cheque.note, out.cheque.rules, out.cheque.travels, out.cheque.toast.message], ['birthday check', 0, { rules: 0, moves: 0 }, 'Move updated.']);
    // a guess confirmed keeps its class (round 2, finding 2): a note on one parking fine files the merchant at Tolls and
    // parking as One-off, every fine stays One-off, and Save as it stands on another fine says it is filed
    assert.deepEqual(out.fines.before.map(([category, klass]) => [category, klass]), Array(3).fill(['tolls_parking', 'oneoff']));
    assert.deepEqual(out.fines.note.rows.map(([category, klass]) => [category, klass]), Array(3).fill(['tolls_parking', 'oneoff']));
    assert.deepEqual(out.fines.note.rule, [['tolls_parking', 'oneoff']]);
    assert.deepEqual(out.fines.asIs.rows.map(([, klass]) => klass), ['oneoff', 'oneoff']);
    assert.deepEqual([out.fines.asIs.toast.message, out.fines.asIs.queued], ['Filed: NYC parking or camera fine as Tolls & parking.', 0]);
    // the toasts name what was filed and offer Undo; none carries an amount, cover or not
    for (const one of [out.sheet.toast, out.tap.toast, out.order.toast, out.note.toast, out.refund.toast, out.zelle.note.toast, out.venmo.toast, out.cheque.toast, out.fines.note.toast, out.fines.asIs.toast]) {
      assert.doesNotMatch(one.message, /\$\s?\d/);
    }
  }
});

/* ------------------------------------------------------------------- words */

test('every word of the new face is in the vocabulary in both modes, with the same placeholders', async () => {
  const keys = new Set();
  for (const file of ['views/flows.js', 'views/board.js', 'views/sheet-tx.js']) {
    const text = await readFile(new URL('../js/' + file, import.meta.url), 'utf8');
    for (const m of text.matchAll(/\b(?:say|sayHtml|phrase)\('((?:flows|page|board|tx)\.[A-Za-z.]+)'/g)) keys.add(m[1]);
  }
  for (const key of keys) {
    if (key.endsWith('.')) continue;
    assert.ok(Object.hasOwn(PHRASES, key), key + ' is in the vocabulary');
    assert.deepEqual(placeholders(PHRASES[key].finance), placeholders(PHRASES[key].chess), key);
  }
  for (const family of Object.keys(FAMILIES)) assert.ok(phrase('flows.family.' + family, 'finance'), family);
  assert.ok(keys.has('flows.queue.lead') && keys.has('board.file'));
});

test('the glossary names the new face, the leaks, the queue and doubled services as the page does, in both modes', () => {
  const pairs = { flows: ['Imbalances', 'Cash flow'], leaks: ['Hanging pieces', 'Leaks'], unfiled: ['Unfiled moves', 'To categorize'], doubled: ['Doubled', 'Overlapping services'] };
  for (const [key, [chess, finance]] of Object.entries(pairs)) {
    assert.equal(term(key, 'chess'), chess);
    assert.equal(term(key, 'finance'), finance);
  }
  // each row's name is the word the page uses for it
  for (const mode of ['chess', 'finance']) {
    assert.equal(term('flows', mode), phrase('page.flows', mode));
    assert.equal(term('leaks', mode), phrase('flows.leaks', mode));
    assert.equal(term('unfiled', mode), phrase('flows.queue', mode));
    assert.equal(term('doubled', mode), phrase('flows.leak.doubled', mode));
    assert.equal(term('analysis', mode), phrase('page.analysis', mode));
  }
  // the Analysis row says what stays on that page; Where it went is not among it any more
  const analysis = TERMS.find((one) => one.key === 'analysis').meaning;
  assert.match(analysis, /emergency fund/);
  assert.doesNotMatch(analysis, /where|spending by/i);
  assert.match(TERMS.find((one) => one.key === 'flows').meaning, /where it went/);
});

/* ------------------------------------------------------------------- privacy */

test('no public file this pass made or changed holds the words the owner’s own work would give away, beyond the stored names', async () => {
  const L = 'les' + 'son';
  const S = 'stu' + 'dent';
  const banned = new RegExp([L, 'plan' + 'ner', S].join('|'), 'i');
  const root = new URL('..', import.meta.url);
  // the files this pass made hold none of them at all
  const fresh = ['js/model/flows.js', 'js/views/flows.js', 'css/views/flows.css', 'tests/flows.test.js', 'tests/helpers/flows-save.mjs'];
  for (const file of fresh) {
    const text = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(text, banned, file);
  }
  // a file it changed is read whole. What the starting build already holds and this pass cannot rename on its own is
  // allowed as it stands, and nothing else: the stored stream kind (renaming it needs a migration), two built-in rules
  // and the loan keyword (with their comment and a loan type's note), and the built page's copies of them
  const allowed = [
    `${L}s: { label: '${L}s & clients' }`, // schema.js, the stored stream kind
    `kind === '${L}s'`, // demo.test.js, the sample's streams of that kind
    `return '${L}s';`, // detect.js, the kind a coaching stream takes
    `// each ${L} changes who could want which row`, // byhand.js, in the sense of something learned
    `id: '${L}-marketplace'`, `${L}face|wyzant|outschool|take${L}s|thumbtack`, // rules-data.js, a built-in income rule
    `id: '${S}-loan'`, `|${S}aid|`, // rules-data.js, a built-in loan rule
    `\\bauto\\b|${S}|\\bvehicle\\b`, // rules-data.js, the loan keyword of an account's name
    `loan: loan, mortgage, auto, ${S}, line of credit`, // classify.js, that keyword's comment
    `'a ${S}, car or equipment loan.`, // sheet-account.js, the loan type's note
  ].map((one) => one.toLowerCase());
  const leftover = (text) => text.split('\n').flatMap((line, i) => {
    let rest = line.toLowerCase();
    for (const one of allowed) rest = rest.split(one).join(' ');
    return banned.test(rest) ? [(i + 1) + ': ' + line.trim().slice(0, 100)] : [];
  });
  // the allowlist itself is exact: each entry is found where it is said to be
  const said = { 'js/model/schema.js': 0, 'js/model/detect.js': 2, 'js/model/byhand.js': 3, 'js/model/rules-data.js': 4, 'js/model/classify.js': 9, 'js/views/sheet-account.js': 10 };
  for (const [file, at] of Object.entries(said)) {
    const text = (await readFile(new URL(file, root), 'utf8')).toLowerCase();
    assert.ok(text.includes(allowed[at]), file + ' holds allowlist entry ' + at);
  }
  // when git can say: every file changed since the build this pass started from (the built page in docs/ included), and
  // every file the repository does not hold yet, whole
  const git = (args) => execFileSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let changed = null;
  let untracked = [];
  try {
    changed = git(['diff', '--name-only', 'dcc6d08', '--', '.']).split('\n').filter(Boolean);
    untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  } catch { changed = null; }
  if (changed === null) return; // no git here, or a copy without that build: the files this pass made alone are scanned
  assert.ok(changed.includes('docs/index.html') && changed.includes('js/model/demo.js'), 'the changed files are read');
  for (const file of changed) {
    const text = await readFile(new URL(file, root), 'utf8');
    assert.deepEqual(leftover(text), [], file);
  }
  for (const file of untracked) {
    const text = await readFile(new URL(file, root), 'utf8');
    assert.doesNotMatch(text, banned, file);
  }
});

/* ------------------------------------------------------------ fixes, round 1 */

test('paydays like with like, source by source: one payer’s extra payday never cancels another’s missing one', () => {
  const twoPayers = (lastA, lastB) => {
    const state = emptyState();
    const payer = (id, name, mkey, last, amount) => {
      state.streams.push(makeStream({ id, name, kind: 'salary', accountId: 'acc_chk', mkey, cadence: 'biweekly', anchor: last, amount, accrue: true }));
      for (let day = last; day >= addDays('2026-06-16', -120); day = addDays(day, -14)) state.txs.push(deposit(day, amount, { streamId: id, mkey }));
    };
    payer('str_a', 'Harbor Works', 'harbor works payroll', lastA, 140000);
    payer('str_b', 'Cobalt Yard', 'cobalt yard payroll', lastB, 50000);
    return state;
  };
  // A: 3 paydays now, 2 before; B: 2 now, 3 before. Pooled they read 5 and 5; payer by payer the change is nothing
  const io = inAndOut(twoPayers('2026-06-15', '2026-06-14'), NOON, 30);
  assert.deepEqual(io.paydays.streams.map((one) => [one.id, one.now, one.before, one.extra, one.left]), [['str_a', 3, 2, 1, 140000], ['str_b', 2, 3, -1, -50000]]);
  assert.deepEqual([io.paydays.now, io.paydays.before, io.paydays.left], [5, 5, 90000]);
  assert.equal(io.in.change, 0, 'each payer’s timing is left out on its own');
  // two payers paid on the same days: two paydays a day, one of each
  const same = inAndOut(twoPayers('2026-06-15', '2026-06-15'), NOON, 30);
  assert.deepEqual([same.paydays.now, same.paydays.before, same.paydays.left], [6, 4, 190000]);
  assert.equal(same.in.change, 0);
  // the single payer of the earlier tests reads as before
  const one = inAndOut(twoWeekly('2026-06-15', '2026-06-16'), NOON, 30);
  assert.deepEqual(one.paydays.streams.map((s) => [s.now, s.before, s.extra]), [[3, 2, 1]]);
});

test('where it went: a category kept at $0.00 lists no merchants, so a category’s merchants always add up to it', () => {
  const state = emptyState();
  state.txs.push(
    spend('2026-03-01', 1000, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market' }), // the record starts early
    spend('2026-05-01', 30000, 'gear', { mkey: 'volt depot', merchant: 'Volt Depot' }), // the window before
    spend('2026-06-02', 4000, 'gear', { mkey: 'pixel barn', merchant: 'Pixel Barn' }),
    refundOf('2026-06-05', 30000, 'gear', { mkey: 'volt depot', merchant: 'Volt Depot' }), // returned in this period
    spend('2026-06-08', 2500, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market' }),
  );
  const went = whereItWent(state, NOON, 30);
  const rows = went.groups.flatMap((group) => group.rows);
  const gear = rows.find((one) => one.category === 'gear');
  assert.deepEqual([gear.amount, gear.before, gear.merchants], [0, 30000, []], 'kept for its drop, with no merchants');
  for (const one of rows) if (one.merchants.length) assert.equal(one.merchants.reduce((sum, m) => sum + m.amount, 0), one.amount, one.category);
});

test('a merchant’s figure holding a pending row or a move tapped in is an estimate, in its category and among the top merchants', () => {
  const went = whereItWent(shops(), NOON, 30);
  const rows = went.groups.flatMap((group) => group.rows);
  const cafe = rows.find((one) => one.category === 'cafe');
  assert.equal(cafe.est, true);
  const of = (list, mkey) => list.find((m) => m.mkey === mkey);
  assert.equal(of(cafe.merchants, 'fernleaf cafe').est, true, 'a move tapped in 2 days ago');
  assert.equal(of(cafe.merchants, 'brookline beans').est, false, 'bank rows alone are roman');
  assert.equal(of(rows.find((one) => one.category === 'groceries').merchants, 'quarry market').est, true, 'a pending row');
  assert.equal(of(went.top, 'fernleaf cafe').est, true);
  const state = shops();
  state.settings.countPending = false;
  assert.equal(of(whereItWent(state, NOON, 30).top, 'quarry market').est, false, 'a pending row that does not count makes no estimate');
});

test('price rises and doubled read the charges the ledger counts: never a hidden account, a pending one only while pending counts', () => {
  const pendingRise = () => {
    const state = leaky();
    const latest = state.txs.find((t) => t.recurringId === 'rec_nf' && t.amount === 1799);
    latest.pending = true;
    latest.postedDay = null;
    return state;
  };
  const counted = leaks(pendingRise(), NOON, 30).rises;
  assert.deepEqual(counted.map((r) => [r.name, r.step, r.est]), [['Netflix', 250, true]], 'a rise read from a pending charge is an estimate');
  assert.equal(leaks(leaky(), NOON, 30).rises[0].est, false, 'posted charges are roman');
  const off = pendingRise();
  off.settings.countPending = false;
  assert.deepEqual(leaks(off, NOON, 30).rises, [], 'the pending charge does not count');
  const hidden = leaky();
  hidden.accounts.push(bankAccount('acc_old', 'checking', { hidden: true }));
  for (const t of hidden.txs) if (t.recurringId === 'rec_nf') t.accountId = 'acc_old';
  const l = leaks(hidden, NOON, 30);
  assert.deepEqual(l.rises, [], 'a hidden account’s charges are left out');
  assert.deepEqual(l.doubled, [], 'and Netflix no longer doubles Hulu');
});

test('two devices with the same bank rows under different ids show the same first chip, tier and order for a store with two moves on one day', () => {
  const queueOf = (reversed) => {
    const state = defaultState(NOON - 200 * DAY_MS);
    mergeFeed(state, feed([row('K1', -1500, '2026-06-10', 'CORNER DEPOT 77'), row('K2', -900, '2026-06-10', 'CORNER DEPOT 77'), row('F1', -1250, '2026-06-09', 'FERNLEAF CAFE 0042')]), NOON);
    refresh(state, NOON);
    const k1 = state.txs.find((t) => t.ext && t.ext.id === 'K1');
    const k2 = state.txs.find((t) => t.ext && t.ext.id === 'K2');
    k1.category = 'groceries';
    k2.category = 'other';
    k1.id = reversed ? 'tx_z' : 'tx_a';
    k2.id = reversed ? 'tx_a' : 'tx_z';
    return moveQueue(state, NOON).items.map((item) => [item.key, item.guess, item.tier, item.chips[0], item.count]);
  };
  const a = queueOf(false);
  assert.ok(a.some(([key]) => key.startsWith('out:corner depot')), JSON.stringify(a));
  assert.deepEqual(queueOf(true), a);
});

test('the Book’s bills leave out loan payments, payments to a loan and interest, as card payments and subscriptions', () => {
  const state = leaky();
  state.accounts.push(makeAccount({ id: 'acc_loan', source: 'manual', type: 'loan', name: 'Equipment loan', balance: -900000, basis: 'estimate', asOf: NOON }));
  line(state, 'rec_rent', 'Kestrel Rent', 'kestrel rent', null, [150000, 150000], { category: 'housing' });
  line(state, 'rec_loan', 'Alder Equip Finance Loan Pymt', 'alder equip finance', null, [24000, 24000], { category: 'debt_service' });
  line(state, 'rec_pay', 'Equipment loan payment', 'equipment loan payment', null, [24000, 24000], { category: 'household', toAccountId: 'acc_loan' });
  line(state, 'rec_int', 'Interest charge', 'interest charge', 'builtin:interest-charge', [9026, 8800], { category: 'fees_interest' });
  const names = bookBills(state, '2026-06-16').lines.map((one) => one.name);
  assert.deepEqual(names, ['Kestrel Rent', 'Gridline Power']);
});

/* ------------------------------------------------------------------ round 2 */

test('a one tap on the guess keeps the class the rules gave: parking fines and car rentals stay One-off on every move, read again or not', () => {
  const record = () => {
    const state = defaultState(NOON - 200 * DAY_MS);
    mergeFeed(state, feed([row('N1', -6500, '2026-06-03', 'NYC FINANCE PARKING 0193'), row('N2', -6500, '2026-06-11', 'NYC FINANCE PARKING 0571'),
      row('R1', -8900, '2026-06-05', 'ZIPCAR TRIP 7731'), row('R2', -12400, '2026-06-12', 'ZIPCAR TRIP 7790')]), NOON);
    refresh(state, NOON);
    return state;
  };
  const state = record();
  const classes = (s) => s.txs.map((t) => [t.mkey, t.category, t.klass]).sort();
  const before = classes(state);
  assert.deepEqual(before.map(([, , klass]) => klass), ['oneoff', 'oneoff', 'oneoff', 'oneoff'], JSON.stringify(before));
  const items = moveQueue(state, NOON).items;
  assert.deepEqual(items.map((item) => item.mkey).sort(), ['nyc parking or camera fine', 'zipcar trip']);
  for (const item of items) {
    assert.equal(item.chips[0], item.guess);
    const result = fileItem(state, item, item.guess, NOON, NOON);
    assert.equal(result.filed, true);
    assert.equal(result.changed, 1, 'only the move tapped changes, by its locks: no other move is corrected');
  }
  assert.deepEqual(classes(state), before, 'every move keeps its category and its class');
  assert.deepEqual(state.settings.rules.map((rule) => [rule.mkey, rule.category, rule.klass]).sort(),
    [['nyc parking or camera fine', 'tolls_parking', 'oneoff'], ['zipcar trip', 'fuel_auto', 'oneoff']], 'the rule holds the class, so later moves take it');
  refresh(state, NOON + 1000);
  assert.deepEqual(classes(state), before, 'and the rules read again keep it');
  assert.equal(moveQueue(state, NOON).items.length, 0);
  // another chip than the guess brings that category's own class, as a new category always did
  const other = record();
  const fine = moveQueue(other, NOON).items.find((item) => item.mkey === 'nyc parking or camera fine');
  fileItem(other, fine, 'shopping', NOON, NOON);
  assert.deepEqual(other.txs.filter((t) => t.mkey === fine.mkey).map((t) => [t.category, t.klass]), [['shopping', klassOf('shopping')], ['shopping', klassOf('shopping')]]);
});

test('Uncategorized is never filed: held there by a lock or by a learned rule, a move stays in the queue as in “Not yet filed”, and a tap on it files nothing', () => {
  const state = emptyState();
  state.txs.push(
    spend('2026-06-10', 4000, 'other', { mkey: 'qx trading', merchant: 'Qx Trading', ruleId: 'learned:r1' }),
    spend('2026-06-12', 2500, 'other', { mkey: 'qx trading', merchant: 'Qx Trading', ruleId: 'learned:r1' }),
    spend('2026-06-11', 1800, 'other', { mkey: 'pike hardware', merchant: 'Pike Hardware', locks: ['category', 'review'] }),
    spend('2026-06-11', 5000, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market', locks: ['category'] }),
  );
  state.settings.rules = [{ id: 'learned:r1', mkey: 'qx trading', flow: 'out', category: 'other' }];
  assert.deepEqual(state.txs.map((t) => isFiled(state, t)), [false, false, false, true]);
  const q = moveQueue(state, NOON);
  assert.deepEqual(q.items.map((item) => [item.mkey, item.count, item.tier]).sort(), [['pike hardware', 1, 0], ['qx trading', 2, 0]]);
  // the queue and "Not yet filed" hold the same moves, so its "File" link opens a queue that lists them
  const went = whereItWent(state, NOON, 30);
  assert.equal(went.groups.find((group) => group.klass === 'other').amount, q.items.reduce((n, item) => n + item.amount, 0));
  assert.equal(inAndOut(state, NOON, 30).filed, 5000 / (4000 + 2500 + 1800 + 5000), 'filed by you counts none of them');
  // a tap on Uncategorized (never offered as a chip) changes nothing and reports nothing filed
  const before = JSON.stringify(state);
  assert.deepEqual(fileItem(state, q.items[0], 'other', NOON, NOON), { changed: 0, ruleId: null, filed: false });
  assert.equal(JSON.stringify(state), before);
});

test('the queue reads the record once: 5,000 rows, nearly every store filed, a refund every three days; one spend index a call, built only when a refund needs it', () => {
  const first = ['AMBER', 'BIRCH', 'CEDAR', 'DUNMORE', 'EMBERLY', 'FARROW', 'GILDEN', 'HAZELBY', 'IVORY', 'JUNIPER'];
  const second = ['GOODS', 'SUPPLY', 'TRADING', 'HOUSE', 'STUDIO', 'WORKS', 'OUTFITTERS', 'EMPORIUM', 'COMPANY', 'GALLERY', 'PANTRY', 'LOFT', 'ATELIER', 'MERCANTILE', 'COLLECTIVE'];
  const stores = second.flatMap((b) => first.map((a) => a + ' ' + b));
  const rows = [];
  let n = 0;
  for (let d = 0; d < 365; d++) {
    const day = addDays('2026-06-16', -d);
    for (let k = 0; k < 13; k++) rows.push(row('S' + (n++), -(500 + (((d * 13 + k) * 37) % 6000)), day, stores[(d * 13 + k) % stores.length]));
    if (d % 3 === 0) rows.push(row('R' + (n++), 300 + (d % 7) * 50, day, stores[(d * 13 + 1) % stores.length]));
  }
  assert.ok(rows.length > 4800, String(rows.length));
  const state = defaultState(NOON - 400 * DAY_MS);
  mergeFeed(state, { ...feed(rows), fromMs: NOON - 400 * DAY_MS }, NOON);
  refresh(state, NOON);
  const merchants = [...new Set(state.txs.filter((t) => t.kind === 'spend').map((t) => t.mkey))];
  assert.ok(merchants.length >= 100, 'stores of their own: ' + merchants.length);
  // the owner files every store but ten, for the whole merchant, as a one tap does
  for (const mkey of merchants.slice(10)) {
    const one = state.txs.find((t) => t.mkey === mkey && t.kind === 'spend');
    learnRule(state, one.id, { category: one.category === 'other' ? 'shopping' : one.category }, { onlyThis: false });
  }
  refresh(state, NOON);
  const refunds = state.txs.filter((t) => t.kind === 'refund' && t.day >= addDays('2026-06-16', -89));
  assert.ok(refunds.length >= 25, 'refunds in the queue’s days: ' + refunds.length);
  let built = 0;
  const counted = (s) => { built += 1; return spendIndex(s); };
  const q = moveQueue(state, NOON, { spendIndex: counted });
  assert.equal(built, 1, 'one index for the whole call');
  assert.deepEqual(q, moveQueue(state, NOON), 'the same queue as without it');
  assert.ok(q.items.some((item) => item.direction === 'out' && item.refunds > 0), 'a store left to file whose refunds wait beside it');
  assert.ok(refunds.some((t) => isFiled(state, t)), 'refunds of filed stores follow their rule');
  moveQueue(state, NOON, { spendIndex: counted });
  assert.equal(built, 2, 'never kept from one call to the next: the record is edited in place');
  // the index a caller gives is the one read: with no spends in it, a refund mirrors nothing and follows no rule
  const filedRefund = refunds.find((t) => isFiled(state, t));
  assert.ok(ruleOfRow(state, filedRefund, spendIndex(state)));
  assert.equal(ruleOfRow(state, filedRefund, new Map()), null);
  // with no money in to read, no index is built
  const quiet = emptyState();
  quiet.txs.push(spend('2026-06-10', 4000, 'groceries', { mkey: 'quarry market', merchant: 'Quarry Market' }));
  quiet.settings.rules = [{ id: 'learned:r2', mkey: 'quarry market', flow: 'out', category: 'groceries' }];
  built = 0;
  moveQueue(quiet, NOON, { spendIndex: counted });
  assert.equal(built, 0);
});
