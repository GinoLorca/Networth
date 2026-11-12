import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVISIONAL_STALE_DAYS, addDecline, addProvisional, fingerprint, isStaleProvisional, mergeFeed, removeManual,
} from '../js/model/merge.js';
import { normalizeSimplefin } from '../js/model/feed.js';
import { checkDoc, defaultState, isLive, txEffect } from '../js/model/schema.js';

/* Everything here is invented: no real account, merchant charge or person. */

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const NOW = new Date(2026, 10, 11, 15, 30).getTime();
const TODAY = '2026-11-11';

/** A date-only bank timestamp (midnight UTC): read as that calendar date in every time zone. */
function dateOnly(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

/** A real instant in local time. Minute 17 keeps it off every whole-hour UTC offset, so it is never read as date-only. */
function localAt(day, hour) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, 17).getTime() / 1000;
}

function posted(extId, amount, day, description, extra = {}) {
  return { extId, amount, posted: dateOnly(day), at: null, pending: false, description, payee: '', memo: '', mcc: null, ...extra };
}

function pendingRow(extId, amount, day, description, extra = {}) {
  return { extId, amount, posted: null, at: dateOnly(day), pending: true, description, payee: '', memo: '', mcc: null, ...extra };
}

function feedAccount(extId, name, balance, txs = [], extra = {}) {
  return { extId, connId: 'CON-1', institution: 'Example Bank', name, currency: 'USD', balance, available: balance, asOf: NOW - HOUR_MS, txs, ...extra };
}

function feedOf(accounts, extra = {}) {
  return { src: 'simplefin', fetchedAt: NOW, fromMs: NOW - 30 * DAY_MS, toMs: NOW, accounts, errors: [], ...extra };
}

/** The same feed fetched `days` later (balances as of then). */
function later(days, accounts, extra = {}) {
  const at = NOW + days * DAY_MS;
  return feedOf(accounts.map((a) => ({ ...a, asOf: at - HOUR_MS })), { fetchedAt: at, fromMs: at - 30 * DAY_MS, toMs: at, ...extra });
}

function newState() {
  return defaultState(NOW - 200 * DAY_MS);
}

function accountBy(state, extId) {
  return state.accounts.find((a) => a.ext && a.ext.id === extId);
}

function txBy(state, extId) {
  return state.txs.find((t) => t.ext && t.ext.id === extId);
}

function snapshot(state) {
  return JSON.parse(JSON.stringify(state));
}

function assertSound(state) {
  assert.equal(checkDoc(state), null);
  for (const a of state.accounts) {
    assert.ok(Number.isSafeInteger(a.balance), 'balance is integer cents');
    assert.ok(a.available === null || Number.isSafeInteger(a.available));
    assert.ok(Number.isFinite(a.asOf));
  }
  for (const t of state.txs) {
    assert.ok(Number.isSafeInteger(t.amount) && t.amount >= 0, 'amount is integer cents');
    assert.match(t.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(t.postedDay === null || /^\d{4}-\d{2}-\d{2}$/.test(t.postedDay));
    assert.ok(t.flow === 'in' || t.flow === 'out');
    assert.ok(Number.isFinite(txEffect(t)));
  }
  assert.equal(new Set(state.txs.map((t) => t.id)).size, state.txs.length, 'ids are unique');
}

const CHECKING_ROWS = [
  posted('c1', -475, '2026-11-03', 'DUNKIN #345123 NEW YORK NY', { mcc: '5814' }),
  posted('c2', -8412, '2026-11-04', 'WHOLE FOODS MARKET #101'),
  posted('c3', 190000, '2026-11-05', 'ACME PAYROLL DIRECT DEP'),
  posted('c4', -1250, '2026-11-06', 'PIZZERIA ROMA'),
];

function household() {
  return feedOf([
    feedAccount('ACT-CHK', '360 Checking', 241991, CHECKING_ROWS),
    feedAccount('ACT-SAV', 'Performance Savings', 50000),
    feedAccount('ACT-CARD', 'Quicksilver Rewards', -125000, [posted('k1', -2300, '2026-11-04', 'NORTHSIDE HARDWARE')]),
  ]);
}

/* ------------------------------------------------------------------ fingerprint */

test('fingerprint: account | day | signed cents | normalised description # occurrence', () => {
  assert.equal(fingerprint('acc_1', '2026-11-03', -475, 'DUNKIN #345123 NEW YORK NY', 0), 'acc_1|2026-11-03|-475|dunkin#0');
  assert.equal(fingerprint('acc_1', '2026-11-03', -475, 'Dunkin #999 Brooklyn NY', 1), 'acc_1|2026-11-03|-475|dunkin#1');
  assert.notEqual(fingerprint('acc_1', '2026-11-03', -475, 'DUNKIN', 0), fingerprint('acc_1', '2026-11-03', 475, 'DUNKIN', 0));
  assert.notEqual(fingerprint('acc_1', '2026-11-03', -475, 'DUNKIN', 0), fingerprint('acc_2', '2026-11-03', -475, 'DUNKIN', 0));
  assert.notEqual(fingerprint('acc_1', '2026-11-03', -475, 'DUNKIN', 0), fingerprint('acc_1', '2026-11-04', -475, 'DUNKIN', 0));
  assert.equal(fingerprint('acc_1', '2026-11-03', -475, null, 0), 'acc_1|2026-11-03|-475|#0');
});

/* --------------------------------------------------------------- first merge */

test('first merge: accounts are created from the feed with inferred types', () => {
  const state = newState();
  const summary = mergeFeed(state, feedOf([
    feedAccount('ACT-CHK', '360 Checking', 241991),
    feedAccount('ACT-SAV', 'Performance Savings', 50000, [], { available: 49000 }),
    feedAccount('ACT-CARD', 'Quicksilver Rewards', -125000),
    feedAccount('ACT-LOAN', 'Auto Loan', -900000, [], { available: null }),
    feedAccount('ACT-INV', 'Brokerage', 1500000),
    feedAccount('ACT-ODD', 'Everyday', -3100),
    feedAccount('ACT-PLAIN', 'Everyday', 3100),
  ]), NOW);

  assert.equal(summary.accountsAdded, 7);
  assert.deepEqual(state.accounts.map((a) => a.type), ['checking', 'savings', 'credit_card', 'loan', 'investment', 'credit_card', 'checking']);
  const checking = accountBy(state, 'ACT-CHK');
  assert.match(checking.id, /^acc_/);
  assert.equal(checking.source, 'bank');
  assert.deepEqual(checking.ext, { src: 'simplefin', id: 'ACT-CHK', conn: 'CON-1' });
  assert.equal(checking.name, '360 Checking');
  assert.equal(checking.institution, 'Example Bank');
  assert.equal(checking.balance, 241991);
  assert.equal(checking.available, 241991);
  assert.equal(checking.asOf, NOW - HOUR_MS);
  assert.equal(checking.basis, 'bank');
  assert.equal(checking.typeLocked, false);
  assert.equal(checking.flip, false);
  assert.deepEqual([checking.everyday, checking.reserve], [true, false]);
  assert.deepEqual([accountBy(state, 'ACT-SAV').everyday, accountBy(state, 'ACT-SAV').reserve], [false, true]);
  assert.equal(accountBy(state, 'ACT-SAV').available, 49000);
  assert.equal(accountBy(state, 'ACT-CARD').balance, -125000, 'a debt is stored negative');
  assert.equal(accountBy(state, 'ACT-LOAN').available, null);
  assertSound(state);
});

test('first merge: rows are inserted, dated and classified', () => {
  const state = newState();
  const summary = mergeFeed(state, household(), NOW);
  assert.deepEqual({ ...summary, newTxIds: summary.newTxIds.length }, { accountsAdded: 3, added: 5, updated: 0, removed: 0, matched: 0, paired: 0, newTxIds: 5 });
  assert.deepEqual(summary.newTxIds, state.txs.map((t) => t.id));

  const checking = accountBy(state, 'ACT-CHK');
  const coffee = txBy(state, 'c1');
  assert.match(coffee.id, /^tx_/);
  assert.deepEqual({
    source: coffee.source, ext: coffee.ext, accountId: coffee.accountId, day: coffee.day, postedDay: coffee.postedDay, at: coffee.at,
    pending: coffee.pending, amount: coffee.amount, flow: coffee.flow, kind: coffee.kind, raw: coffee.raw, merchant: coffee.merchant,
    mkey: coffee.mkey, mcc: coffee.mcc, category: coffee.category, klass: coffee.klass, loggedAt: coffee.loggedAt,
  }, {
    source: 'bank', ext: { src: 'simplefin', id: 'c1' }, accountId: checking.id, day: '2026-11-03', postedDay: '2026-11-03', at: null,
    pending: false, amount: 475, flow: 'out', kind: 'spend', raw: 'DUNKIN #345123 NEW YORK NY', merchant: "Dunkin'",
    mkey: 'dunkin', mcc: '5814', category: 'cafe', klass: 'game', loggedAt: NOW,
  });
  assert.equal(coffee.fp, fingerprint(checking.id, '2026-11-03', -475, 'DUNKIN #345123 NEW YORK NY', 0));

  const pay = txBy(state, 'c3');
  assert.deepEqual([pay.flow, pay.amount, pay.kind, pay.category], ['in', 190000, 'income', 'income']);
  assert.deepEqual([txBy(state, 'c2').kind, txBy(state, 'c2').category], ['spend', 'groceries']);
  assert.equal(txBy(state, 'c4').review, true, 'an unknown merchant is offered for review');
  assert.equal(txBy(state, 'k1').accountId, accountBy(state, 'ACT-CARD').id);
  assertSound(state);
});

test('first merge: the real demo answer flows through, and ids repeated across accounts do not collide', () => {
  const answer = {
    errlist: [],
    accounts: [
      {
        id: 'Demo Savings', name: 'SimpleFIN Savings', currency: 'USD', balance: '113985.51', 'available-balance': '113985.51', 'balance-date': 1794441600,
        transactions: [
          { id: '1794384000', posted: 1794384000, amount: '-55.50', description: 'Fishing bait', payee: "John's Fishin Shack", memo: 'JOHNS FISHIN SHACK BAIT', transacted_at: 1794384000, mcc: '5812' },
          { id: '1794412800', posted: 1794412800, amount: '-85.50', description: 'Grocery store', payee: 'Grocery store', memo: 'LOCAL GROCER STORE #1133', transacted_at: 1794412800, mcc: '5411' },
        ],
        conn_id: 'CON-SIMPLEFIN-DEMO',
      },
      {
        id: 'Demo Checking', name: 'SimpleFIN Checking', currency: 'USD', balance: '24119.91', 'available-balance': '24119.91', 'balance-date': 1794441600,
        transactions: [
          { id: '1794384000', posted: 1794384000, amount: '-72.20', description: 'Fishing bait', payee: "John's Fishin Shack", memo: 'JOHNS FISHIN SHACK BAIT', transacted_at: 1794384000, mcc: '5812' },
          { id: '1794412800', posted: 1794412800, amount: '-111.12', description: 'Grocery store', payee: 'Grocery store', memo: 'LOCAL GROCER STORE #1133', transacted_at: 1794412800, mcc: '5411' },
        ],
        conn_id: 'CON-SIMPLEFIN-DEMO',
      },
      { id: 'Demo Empty Account', name: 'SimpleFIN Empty Account', currency: 'USD', balance: '0.00', 'available-balance': '0.00', 'balance-date': 1794441600, transactions: [], conn_id: 'CON-SIMPLEFIN-DEMO' },
    ],
    connections: [{ conn_id: 'CON-SIMPLEFIN-DEMO', name: 'SimpleFIN Demo', org_id: 'simplefin.demoorg', org_name: 'SimpleFIN Bridge' }],
  };
  const fetchedAt = 1794441600 * 1000 + HOUR_MS;
  const feed = normalizeSimplefin(answer, { fetchedAt, fromMs: fetchedAt - 30 * DAY_MS, toMs: fetchedAt });
  const state = newState();
  const summary = mergeFeed(state, feed, fetchedAt);
  assert.deepEqual([summary.accountsAdded, summary.added], [3, 4]);
  assert.deepEqual(state.accounts.map((a) => [a.name, a.type, a.balance, a.institution]), [
    ['SimpleFIN Savings', 'savings', 11398551, 'SimpleFIN Demo'],
    ['SimpleFIN Checking', 'checking', 2411991, 'SimpleFIN Demo'],
    ['SimpleFIN Empty Account', 'checking', 0, 'SimpleFIN Demo'],
  ]);
  assert.deepEqual(state.txs.map((t) => t.amount).sort((a, b) => a - b), [5550, 7220, 8550, 11112]);
  assert.equal(state.txs.find((t) => t.amount === 5550).day, '2026-11-11', 'an 08:00 UTC stamp is a bare date');
  assert.equal(state.txs.find((t) => t.amount === 5550).mcc, '5812');
  assertSound(state);

  const before = snapshot(state);
  assert.deepEqual({ ...mergeFeed(state, feed, fetchedAt), newTxIds: [] }, { accountsAdded: 0, added: 0, updated: 0, removed: 0, matched: 0, paired: 0, newTxIds: [] });
  assert.deepEqual(snapshot(state), before);
});

test('rows from the sample feed are marked as sample data', () => {
  const state = newState();
  mergeFeed(state, { ...household(), src: 'demo' }, NOW);
  assert.ok(state.txs.every((t) => t.source === 'demo'));
  assert.ok(state.accounts.every((a) => a.source === 'bank' && a.ext.src === 'demo'));
  assert.equal(state.sync.src, 'demo');
  const before = snapshot(state);
  assert.equal(mergeFeed(state, { ...household(), src: 'demo' }, NOW).added, 0);
  assert.deepEqual(snapshot(state), before);
});

/* ------------------------------------------------------------------- the day */

test('day: the transaction time decides, with the game-day rollover; else the posting date', () => {
  const state = newState();
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, [
    { ...posted('late', -900, '2026-11-10', 'PIZZERIA ROMA'), at: localAt('2026-11-10', 1) },
    { ...posted('noon', -800, '2026-11-10', 'PIZZERIA ROMA'), at: localAt('2026-11-08', 13) },
    { ...posted('dated', -700, '2026-11-10', 'PIZZERIA ROMA'), at: dateOnly('2026-11-07') },
    posted('plain', -600, '2026-11-10', 'PIZZERIA ROMA'),
  ])]), NOW);
  const late = txBy(state, 'late');
  assert.equal(late.day, '2026-11-09', 'a 1 a.m. purchase belongs to the evening before');
  assert.equal(late.postedDay, '2026-11-10');
  assert.equal(late.at, localAt('2026-11-10', 1) * 1000);
  assert.deepEqual([txBy(state, 'noon').day, txBy(state, 'noon').at], ['2026-11-08', localAt('2026-11-08', 13) * 1000]);
  assert.deepEqual([txBy(state, 'dated').day, txBy(state, 'dated').at], ['2026-11-07', null], 'a bare date carries no time of day');
  assert.deepEqual([txBy(state, 'plain').day, txBy(state, 'plain').postedDay, txBy(state, 'plain').at], ['2026-11-10', '2026-11-10', null]);
});

test('day: the rollover hour comes from the settings', () => {
  const state = newState();
  state.settings.rolloverHour = 0;
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, [{ ...posted('late', -900, '2026-11-10', 'PIZZERIA ROMA'), at: localAt('2026-11-10', 1) }])]), NOW);
  assert.equal(txBy(state, 'late').day, '2026-11-10');
});

test('day: a pending row the bank has not dated is dated when first seen, and keeps that day', () => {
  const state = newState();
  const undated = { extId: 'u1', amount: -1500, posted: null, at: null, pending: true, description: 'PIZZERIA ROMA', payee: '', memo: '', mcc: null };
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, [undated])]), NOW);
  const row = txBy(state, 'u1');
  assert.deepEqual([row.day, row.postedDay, row.pending], [TODAY, null, true]);

  mergeFeed(state, later(1, [feedAccount('ACT-CHK', '360 Checking', 1000, [undated])]), NOW + DAY_MS);
  assert.equal(row.day, TODAY, 'still pending a day later: the day does not drift');
  assert.equal(state.txs.length, 1);

  mergeFeed(state, later(2, [feedAccount('ACT-CHK', '360 Checking', 1000, [posted('u1', -1500, '2026-11-13', 'PIZZERIA ROMA')])]), NOW + 2 * DAY_MS);
  assert.deepEqual([row.day, row.postedDay, row.pending], [TODAY, '2026-11-13', false], 'posting does not move the purchase');
  assert.equal(state.txs.length, 1);
});

/* --------------------------------------------------------------- idempotence */

test('merging the same feed twice changes nothing', () => {
  const state = newState();
  const feed = feedOf([
    feedAccount('ACT-CHK', '360 Checking', 241991, [
      ...CHECKING_ROWS,
      posted('c5', -50000, '2026-11-07', 'ONLINE TRANSFER TO SAVINGS XXXX1234'),
      posted('c6', -30000, '2026-11-08', 'CAPITAL ONE CRCARDPMT'),
      pendingRow('c7', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'),
      { extId: 'c8', amount: -990, posted: null, at: null, pending: true, description: 'PIZZERIA ROMA', payee: '', memo: '', mcc: null },
      posted('', -333, '2026-11-09', 'NO PROVIDER ID'),
    ]),
    feedAccount('ACT-SAV', 'Performance Savings', 100000, [posted('s1', 50000, '2026-11-07', 'ONLINE TRANSFER FROM CHECKING XXXX9876')]),
    feedAccount('ACT-CARD', 'Quicksilver Rewards', -95000, [posted('k1', 30000, '2026-11-09', 'PAYMENT THANK YOU')]),
  ], { errors: [{ code: 'con.auth', message: 'Sign in again', connId: 'CON-9', accountId: '' }] });

  addProvisional(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', category: 'cafe', day: '2026-11-10' }, NOW - HOUR_MS);
  addProvisional(state, { amount: 2000, merchant: 'Old Deli', day: '2026-11-01' }, NOW - HOUR_MS);
  const first = mergeFeed(state, feed, NOW);
  assert.deepEqual([first.accountsAdded, first.added, first.matched, first.paired], [3, 11, 1, 2]);

  const before = snapshot(state);
  const second = mergeFeed(state, feed, NOW);
  assert.deepEqual(second, { accountsAdded: 0, added: 0, updated: 0, removed: 0, matched: 0, paired: 0, newTxIds: [] });
  assert.deepEqual(snapshot(state), before);
  mergeFeed(state, snapshot(feed), NOW);
  assert.deepEqual(snapshot(state), before);
  assertSound(state);
});

/* ------------------------------------------------------------- re-issued ids */

test('a row whose provider id was re-issued does not duplicate', () => {
  const state = newState();
  mergeFeed(state, household(), NOW);
  const ids = state.txs.map((t) => t.id);
  const coffee = txBy(state, 'c1');
  coffee.note = 'with the new student';

  const reissued = household();
  reissued.accounts[0].txs = CHECKING_ROWS.map((row, i) => ({ ...row, extId: 'new-' + i }));
  const summary = mergeFeed(state, reissued, NOW);

  assert.deepEqual([summary.added, summary.updated, summary.removed], [0, 4, 0]);
  assert.deepEqual(state.txs.map((t) => t.id), ids);
  assert.deepEqual(coffee.ext, { src: 'simplefin', id: 'new-0' });
  assert.equal(coffee.note, 'with the new student');
  assert.equal(txBy(state, 'c1'), undefined);

  assert.equal(mergeFeed(state, reissued, NOW).updated, 0, 'and the new ids now match directly');
});

test('identical rows on one day are told apart by their occurrence index', () => {
  const state = newState();
  const twoCoffees = [
    posted('a', -475, '2026-11-03', 'DUNKIN #345123 NEW YORK NY'),
    posted('b', -475, '2026-11-03', 'DUNKIN #345123 NEW YORK NY'),
  ];
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, twoCoffees)]), NOW);
  assert.equal(state.txs.length, 2);
  assert.deepEqual(state.txs.map((t) => t.fp.slice(-2)), ['#0', '#1']);

  const reissued = twoCoffees.map((row, i) => ({ ...row, extId: 'z' + i }));
  assert.equal(mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, reissued)]), NOW).added, 0);
  assert.equal(state.txs.length, 2);

  const third = [...reissued, posted('z2', -475, '2026-11-03', 'DUNKIN #345123 NEW YORK NY')];
  const summary = mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, third)]), NOW);
  assert.equal(summary.added, 1, 'a third identical purchase is a new row');
  assert.equal(state.txs.length, 3);
  assert.equal(state.txs[2].fp.slice(-2), '#2');
});

test('rows without a provider id are matched by fingerprint', () => {
  const state = newState();
  const rows = [posted('', -1250, '2026-11-06', 'PIZZERIA ROMA'), posted('', -8412, '2026-11-04', 'WHOLE FOODS MARKET #101')];
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, rows)]), NOW);
  assert.deepEqual(state.txs.map((t) => t.ext), [null, null]);
  const again = mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, [...rows].reverse())]), NOW);
  assert.deepEqual([again.added, again.updated], [0, 0]);
  assert.equal(state.txs.length, 2);
});

test('the same provider id on two accounts names two different rows', () => {
  const state = newState();
  const feed = feedOf([
    feedAccount('ACT-CHK', '360 Checking', 1000, [posted('same', -1000, '2026-11-06', 'PIZZERIA ROMA')]),
    feedAccount('ACT-CARD', 'Quicksilver Rewards', -1000, [posted('same', -2000, '2026-11-06', 'NORTHSIDE HARDWARE')]),
  ]);
  mergeFeed(state, feed, NOW);
  assert.equal(state.txs.length, 2);
  assert.equal(mergeFeed(state, feed, NOW).updated, 0);
  assert.deepEqual(state.txs.map((t) => t.amount), [1000, 2000]);
});

test('an id match updates what the bank changed and nothing else', () => {
  const state = newState();
  mergeFeed(state, household(), NOW);
  const pizza = txBy(state, 'c4');
  pizza.category = 'eating_out';
  pizza.klass = 'game';
  pizza.locks = ['category', 'klass'];
  const corrected = household();
  corrected.accounts[0].txs = CHECKING_ROWS.map((row) => (row.extId === 'c4' ? { ...row, amount: -1375, mcc: '5812' } : row));
  const summary = mergeFeed(state, corrected, NOW);
  assert.deepEqual([summary.added, summary.updated], [0, 1]);
  assert.deepEqual([pizza.amount, pizza.mcc, pizza.category, pizza.klass, pizza.locks], [1375, '5812', 'eating_out', 'game', ['category', 'klass']]);
});

/* ---------------------------------------------------------- pending to posted */

function cardWith(rows, balance = -20000) {
  return feedOf([feedAccount('ACT-CARD', 'Quicksilver Rewards', balance, rows)]);
}

test('pending to posted with a tip: the same move, and the owner\'s notes and locks survive', () => {
  const state = newState();
  mergeFeed(state, cardWith([pendingRow('hold-1', -4000, '2026-11-08', 'TST* MARIAS KITCHEN')]), NOW);
  const lunch = state.txs[0];
  assert.deepEqual([lunch.pending, lunch.postedDay, lunch.day, lunch.amount], [true, null, '2026-11-08', 4000]);
  const id = lunch.id;
  Object.assign(lunch, { note: 'client lunch', category: 'supplies', purpose: 'work', locks: ['category', 'purpose'], planned: true, glyph: '!' });

  const summary = mergeFeed(state, cardWith([posted('settled-77', -4800, '2026-11-10', 'MARIAS KITCHEN BROOKLYN NY')], -24800), NOW);
  assert.deepEqual([summary.added, summary.updated, summary.removed], [0, 1, 0]);
  assert.equal(state.txs.length, 1);
  assert.equal(state.txs[0], lunch);
  assert.deepEqual({
    id: lunch.id, pending: lunch.pending, postedDay: lunch.postedDay, day: lunch.day, amount: lunch.amount, ext: lunch.ext, raw: lunch.raw,
    note: lunch.note, category: lunch.category, purpose: lunch.purpose, locks: lunch.locks, planned: lunch.planned, glyph: lunch.glyph, kind: lunch.kind,
  }, {
    id, pending: false, postedDay: '2026-11-10', day: '2026-11-08', amount: 4800, ext: { src: 'simplefin', id: 'settled-77' }, raw: 'MARIAS KITCHEN BROOKLYN NY',
    note: 'client lunch', category: 'supplies', purpose: 'work', locks: ['category', 'purpose'], planned: true, glyph: '!', kind: 'spend',
  });
  assert.equal(lunch.fp, fingerprint(lunch.accountId, '2026-11-10', -4800, 'MARIAS KITCHEN BROOKLYN NY', 0));
  assert.equal(mergeFeed(state, cardWith([posted('settled-77', -4800, '2026-11-10', 'MARIAS KITCHEN BROOKLYN NY')], -24800), NOW).updated, 0);
});

test('pending to posted under the same provider id, with a changed amount', () => {
  const state = newState();
  mergeFeed(state, cardWith([pendingRow('same-id', -4000, '2026-11-08', 'TST* MARIAS KITCHEN')]), NOW);
  state.txs[0].note = 'kept';
  const summary = mergeFeed(state, cardWith([posted('same-id', -9900, '2026-11-09', 'TST* MARIAS KITCHEN')]), NOW);
  assert.deepEqual([summary.added, summary.updated, summary.removed, state.txs.length], [0, 1, 0, 1]);
  assert.deepEqual([state.txs[0].amount, state.txs[0].pending, state.txs[0].postedDay, state.txs[0].note], [9900, false, '2026-11-09', 'kept']);
});

test('pending to posted: the closest pending row of the merchant is the one that settles', () => {
  const state = newState();
  mergeFeed(state, cardWith([
    pendingRow('h1', -4000, '2026-11-07', 'TST* MARIAS KITCHEN'),
    pendingRow('h2', -4600, '2026-11-08', 'TST* MARIAS KITCHEN'),
  ]), NOW);
  const [first, second] = state.txs;
  const summary = mergeFeed(state, cardWith([
    posted('p9', -4700, '2026-11-09', 'MARIAS KITCHEN BROOKLYN NY'),
    pendingRow('h1', -4000, '2026-11-07', 'TST* MARIAS KITCHEN'),
  ]), NOW);
  assert.deepEqual([summary.added, summary.updated, summary.removed], [0, 1, 0]);
  assert.deepEqual([first.pending, first.amount], [true, 4000]);
  assert.deepEqual([second.pending, second.amount, second.ext.id], [false, 4700, 'p9']);
});

test('pending to posted: another merchant, a far larger amount or a far later day is a different purchase', () => {
  const cases = [
    posted('x', -4800, '2026-11-10', 'PIZZERIA ROMA'),
    posted('x', -5100, '2026-11-10', 'MARIAS KITCHEN BROOKLYN NY'),
    posted('x', -4000, '2026-11-14', 'MARIAS KITCHEN BROOKLYN NY'),
    posted('x', 4000, '2026-11-09', 'MARIAS KITCHEN BROOKLYN NY'),
  ];
  for (const row of cases) {
    const state = newState();
    mergeFeed(state, cardWith([pendingRow('hold-1', -4000, '2026-11-08', 'TST* MARIAS KITCHEN')]), NOW);
    const pendingId = state.txs[0].id;
    const summary = mergeFeed(state, later(3, [feedAccount('ACT-CARD', 'Quicksilver Rewards', -20000, [row])]), NOW + 3 * DAY_MS);
    assert.deepEqual([summary.added, summary.updated, summary.removed], [1, 0, 1], row.description + ' ' + row.amount);
    assert.equal(state.txs.length, 1);
    assert.notEqual(state.txs[0].id, pendingId);
    assert.equal(state.txs[0].pending, false);
  }
  const state = newState();
  mergeFeed(state, cardWith([pendingRow('hold-1', -4000, '2026-11-08', 'TST* MARIAS KITCHEN')]), NOW);
  const id = state.txs[0].id;
  mergeFeed(state, cardWith([posted('x', -5000, '2026-11-13', 'MARIAS KITCHEN BROOKLYN NY')]), NOW);
  assert.equal(state.txs[0].id, id, 'exactly 25% more, five days later, still settles');
});

test('a row that has posted is never taken back to pending', () => {
  const state = newState();
  mergeFeed(state, cardWith([posted('r1', -4000, '2026-11-08', 'TST* MARIAS KITCHEN')]), NOW);
  const before = snapshot(state.txs);
  const summary = mergeFeed(state, cardWith([pendingRow('r1', -4000, '2026-11-08', 'TST* MARIAS KITCHEN')]), NOW);
  assert.deepEqual([summary.added, summary.updated, summary.removed], [0, 0, 0]);
  assert.deepEqual(snapshot(state.txs), before);
});

/* ------------------------------------------------------------ vanished pending */

test('a vanished pending row is removed; posted rows are never deleted', () => {
  const state = newState();
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 100000, [
    ...CHECKING_ROWS,
    pendingRow('hold-gas', -100, '2026-11-09', 'CORNER FUEL STOP'),
    pendingRow('hold-cafe', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'),
  ])]), NOW);
  assert.equal(state.txs.length, 6);

  const summary = mergeFeed(state, later(1, [feedAccount('ACT-CHK', '360 Checking', 99000, [
    posted('c1', -475, '2026-11-03', 'DUNKIN #345123 NEW YORK NY', { mcc: '5814' }),
    pendingRow('hold-cafe', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'),
  ])]), NOW + DAY_MS);

  assert.deepEqual([summary.removed, summary.added, summary.updated], [1, 0, 0]);
  assert.equal(txBy(state, 'hold-gas'), undefined, 'the dropped hold is gone');
  assert.ok(txBy(state, 'hold-cafe'), 'the hold still reported stays');
  for (const id of ['c1', 'c2', 'c3', 'c4']) assert.ok(txBy(state, id), 'posted row ' + id + ' is kept although the feed no longer lists it');
  assertSound(state);
});

test('a pending row is kept when the feed did not cover its day, its account, or its connection', () => {
  const start = () => {
    const state = newState();
    mergeFeed(state, feedOf([
      feedAccount('ACT-CHK', '360 Checking', 100000, [pendingRow('hold', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY')]),
      feedAccount('ACT-SAV', 'Performance Savings', 50000),
    ]), NOW);
    return state;
  };
  const emptyChecking = feedAccount('ACT-CHK', '360 Checking', 100000, []);

  const olderWindow = start();
  assert.equal(mergeFeed(olderWindow, feedOf([emptyChecking], { fromMs: NOW - 180 * DAY_MS, toMs: NOW - 90 * DAY_MS }), NOW).removed, 0);
  assert.ok(txBy(olderWindow, 'hold'));

  const windowStartsThatDay = start();
  assert.equal(mergeFeed(windowStartsThatDay, feedOf([emptyChecking], { fromMs: new Date(2026, 10, 10, 12).getTime() }), NOW).removed, 0, 'a day only partly inside the window is not covered');

  const accountMissing = start();
  assert.equal(mergeFeed(accountMissing, feedOf([feedAccount('ACT-SAV', 'Performance Savings', 50000)]), NOW).removed, 0);

  const connectionDown = start();
  assert.equal(mergeFeed(connectionDown, feedOf([emptyChecking], { errors: [{ code: 'con.auth', message: 'Sign in again', connId: 'CON-1', accountId: '' }] }), NOW).removed, 0);
  const accountDown = start();
  assert.equal(mergeFeed(accountDown, feedOf([emptyChecking], { errors: [{ code: 'act.data', message: 'No data', connId: '', accountId: 'ACT-CHK' }] }), NOW).removed, 0);
  const otherConnectionDown = start();
  assert.equal(mergeFeed(otherConnectionDown, feedOf([emptyChecking], { errors: [{ code: 'con.auth', message: 'Sign in again', connId: 'CON-2', accountId: '' }] }), NOW).removed, 1);

  const covered = start();
  assert.equal(mergeFeed(covered, feedOf([emptyChecking]), NOW).removed, 1);
  assert.equal(covered.txs.length, 0);
});

test('a pending row too old for any window to reach is cleared', () => {
  const state = newState();
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 100000, [pendingRow('ancient', -475, '2026-11-10', 'DUNKIN')])]), NOW);
  const muchLater = NOW + 120 * DAY_MS;
  const feed = feedOf([feedAccount('ACT-CHK', '360 Checking', 100000, [], { asOf: muchLater })], { fetchedAt: muchLater, fromMs: muchLater - 7 * DAY_MS, toMs: muchLater });
  assert.equal(mergeFeed(state, feed, muchLater).removed, 1);
  assert.equal(state.txs.length, 0);
});

test('removing a pending row undoes the links that pointed at it', () => {
  const state = newState();
  mergeFeed(state, feedOf([
    feedAccount('ACT-CHK', '360 Checking', 100000, [pendingRow('out', -50000, '2026-11-10', 'ONLINE TRANSFER TO SAVINGS XXXX1234')]),
    feedAccount('ACT-SAV', 'Performance Savings', 50000, [posted('in', 50000, '2026-11-10', 'ONLINE TRANSFER FROM CHECKING XXXX9876')]),
  ]), NOW);
  const savingsLeg = txBy(state, 'in');
  assert.equal(savingsLeg.pairId, txBy(state, 'out').id);

  const move = addProvisional(state, { amount: 700, merchant: 'Corner Deli', day: '2026-11-10' }, NOW);
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 100000, [
    pendingRow('out', -50000, '2026-11-10', 'ONLINE TRANSFER TO SAVINGS XXXX1234'),
    pendingRow('deli', -700, '2026-11-10', 'CORNER DELI'),
  ])]), NOW);
  assert.equal(move.matchId, txBy(state, 'deli').id);

  const summary = mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 100000, [])]), NOW);
  assert.equal(summary.removed, 2);
  assert.equal(savingsLeg.pairId, null);
  assert.equal(move.matchId, null, 'the provisional move counts again');
  assert.equal(isLive(move), true);
});

/* ---------------------------------------------------------- provisional moves */

function linkedState() {
  const state = newState();
  mergeFeed(state, household(), NOW);
  return state;
}

function nextDay(rows) {
  return later(1, [feedAccount('ACT-CHK', '360 Checking', 240000, [...CHECKING_ROWS, ...rows])]);
}

test('a provisional move is confirmed by the bank row that arrives for it', () => {
  const state = linkedState();
  const move = addProvisional(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', category: 'cafe', day: '2026-11-10', planned: true, note: 'before class' }, NOW);
  assert.equal(isLive(move), true);

  const summary = mergeFeed(state, nextDay([pendingRow('c9', -495, '2026-11-11', 'DUNKIN #345123 NEW YORK NY')]), NOW + DAY_MS);
  const bank = txBy(state, 'c9');
  assert.deepEqual([summary.matched, summary.added], [1, 1]);
  assert.equal(move.matchId, bank.id);
  assert.equal(isLive(move), false, 'the tapped-in move stops counting');
  assert.equal(isLive(bank), true);
  assert.deepEqual([bank.planned, bank.note, bank.matchId], [true, 'before class', null], 'what the owner said about it moves to the bank row');
  assert.equal(state.txs.includes(move), true, 'the manual row is kept, hidden behind its match');

  assert.equal(mergeFeed(state, nextDay([pendingRow('c9', -495, '2026-11-11', 'DUNKIN #345123 NEW YORK NY')]), NOW + DAY_MS).matched, 0);
});

test('a provisional move is not confirmed by another merchant, amount, day or account', () => {
  const tries = [
    [{ amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-10' }, pendingRow('n', -475, '2026-11-10', 'PIZZERIA ROMA'), 'another merchant'],
    [{ amount: 1000, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-10' }, pendingRow('n', -1151, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'), 'more than 15% away'],
    [{ amount: 1000, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-10' }, pendingRow('n', -849, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'), 'more than 15% below'],
    [{ amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-06' }, pendingRow('n', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'), 'four days apart'],
    [{ amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-10' }, pendingRow('n', 475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'), 'money coming in'],
  ];
  for (const [fields, row, why] of tries) {
    const state = linkedState();
    const move = addProvisional(state, fields, NOW);
    const summary = mergeFeed(state, nextDay([row]), NOW + DAY_MS);
    assert.deepEqual([summary.matched, move.matchId], [0, null], why);
    assert.equal(isLive(move), true, why);
  }

  const state = linkedState();
  const move = addProvisional(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-10', accountId: accountBy(state, 'ACT-CARD').id }, NOW);
  mergeFeed(state, nextDay([pendingRow('n', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY')]), NOW + DAY_MS);
  assert.equal(move.matchId, null, 'a move tapped in for the card is not confirmed by a checking row');
});

test('the limits of a confirmation: 15% and three days, inclusive', () => {
  const state = linkedState();
  const high = addProvisional(state, { amount: 1000, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-07' }, NOW);
  const low = addProvisional(state, { amount: 2000, merchant: 'Pizzeria Roma', day: '2026-11-13' }, NOW);
  const summary = mergeFeed(state, nextDay([
    pendingRow('n1', -1150, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'),
    pendingRow('n2', -1700, '2026-11-10', 'PIZZERIA ROMA 0423'),
  ]), NOW + DAY_MS);
  assert.equal(summary.matched, 2);
  assert.equal(high.matchId, txBy(state, 'n1').id);
  assert.equal(low.matchId, txBy(state, 'n2').id);
});

test('a provisional move with no merchant is confirmed by amount and day alone', () => {
  const state = linkedState();
  const move = addProvisional(state, { amount: 1299, merchant: '', day: '2026-11-10' }, NOW);
  assert.deepEqual([move.mkey, move.merchant], ['', ''], 'no place typed: no merchant name is invented');
  mergeFeed(state, nextDay([pendingRow('n', -1299, '2026-11-11', 'SQ *BLUE DOOR CAFE')]), NOW + DAY_MS);
  assert.equal(move.matchId, txBy(state, 'n').id);
});

test('one bank row confirms one move; the closest day wins', () => {
  const state = linkedState();
  const monday = addProvisional(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-09' }, NOW);
  const tuesday = addProvisional(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-10' }, NOW);
  const first = mergeFeed(state, nextDay([pendingRow('tue', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY')]), NOW + DAY_MS);
  assert.equal(first.matched, 1);
  assert.deepEqual([monday.matchId, tuesday.matchId], [null, txBy(state, 'tue').id]);

  const second = mergeFeed(state, later(2, [feedAccount('ACT-CHK', '360 Checking', 239000, [
    ...CHECKING_ROWS,
    pendingRow('tue', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY'),
    pendingRow('mon', -475, '2026-11-09', 'DUNKIN #345123 NEW YORK NY'),
  ])]), NOW + 2 * DAY_MS);
  assert.equal(second.matched, 1);
  assert.equal(monday.matchId, txBy(state, 'mon').id);
});

test('a bank row that was already there does not confirm a move tapped in afterwards', () => {
  const state = linkedState();
  mergeFeed(state, nextDay([pendingRow('first-coffee', -475, '2026-11-11', 'DUNKIN #345123 NEW YORK NY')]), NOW + DAY_MS);
  const second = addProvisional(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-11' }, NOW + DAY_MS + HOUR_MS);
  const posting = later(2, [feedAccount('ACT-CHK', '360 Checking', 239000, [...CHECKING_ROWS, posted('first-coffee', -475, '2026-11-12', 'DUNKIN #345123 NEW YORK NY', { at: dateOnly('2026-11-11') })])]);
  const summary = mergeFeed(state, posting, NOW + 2 * DAY_MS);
  assert.deepEqual([summary.matched, second.matchId], [0, null], 'the earlier coffee posting is not news about the second one');
});

test('a bank row whose amount changes on posting can confirm a move it did not fit before', () => {
  const state = linkedState();
  const dinner = addProvisional(state, { amount: 4800, merchant: 'Marias Kitchen', day: '2026-11-11' }, NOW + DAY_MS);
  assert.equal(dinner.mkey, 'marias kitchen');
  assert.equal(mergeFeed(state, nextDay([pendingRow('hold', -4000, '2026-11-11', 'TST* MARIAS KITCHEN')]), NOW + DAY_MS).matched, 0, 'the hold is before the tip');
  const settled = later(3, [feedAccount('ACT-CHK', '360 Checking', 235000, [...CHECKING_ROWS, posted('hold', -4800, '2026-11-13', 'TST* MARIAS KITCHEN')])]);
  const summary = mergeFeed(state, settled, NOW + 3 * DAY_MS);
  assert.deepEqual([summary.matched, summary.updated], [1, 1]);
  assert.equal(dinner.matchId, txBy(state, 'hold').id);
});

test('an unmatched provisional move goes stale after 7 days and is flagged for review', () => {
  const state = linkedState();
  const old = addProvisional(state, { amount: 900, merchant: 'Corner Deli', day: '2026-11-03' }, NOW - 8 * DAY_MS);
  const edge = addProvisional(state, { amount: 900, merchant: 'Corner Deli', day: '2026-11-04' }, NOW - 7 * DAY_MS);
  const decline = addDecline(state, { amount: 900, merchant: 'Corner Deli', day: '2026-11-01' }, NOW - 10 * DAY_MS);
  assert.equal(PROVISIONAL_STALE_DAYS, 7);
  assert.deepEqual([isStaleProvisional(old, TODAY), isStaleProvisional(edge, TODAY), isStaleProvisional(decline, TODAY)], [true, false, false]);

  mergeFeed(state, household(), NOW);
  assert.deepEqual([old.review, old.matchId], [true, null]);
  assert.equal(edge.review, false, 'seven days old still counts');
  assert.equal(decline.review, false);

  mergeFeed(state, later(1, household().accounts), NOW + DAY_MS);
  assert.equal(edge.review, true, 'and on the eighth day it no longer does');
  assert.equal(state.txs.includes(old), true, 'a stale move is flagged, never deleted');
});

test('a stale move is still confirmed, and its flag cleared, when its bank row finally arrives', () => {
  const state = linkedState();
  const move = addProvisional(state, { amount: 900, merchant: 'Corner Deli', day: '2026-11-03' }, NOW - 8 * DAY_MS);
  mergeFeed(state, household(), NOW);
  assert.equal(move.review, true);
  mergeFeed(state, nextDay([posted('late', -900, '2026-11-05', 'CORNER DELI')]), NOW + DAY_MS);
  assert.deepEqual([move.matchId, move.review], [txBy(state, 'late').id, false]);
  assert.equal(isStaleProvisional(move, '2026-11-12'), false);
});

/* ------------------------------------------------- transfers and card payments */

function threeAccounts(checkingRows, savingsRows, cardRows) {
  return feedOf([
    feedAccount('ACT-CHK', '360 Checking', 500000, checkingRows),
    feedAccount('ACT-SAV', 'Performance Savings', 100000, savingsRows),
    feedAccount('ACT-CARD', 'Quicksilver Rewards', -95000, cardRows),
  ]);
}

test('a transfer and a card payment are paired across linked accounts', () => {
  const state = newState();
  const summary = mergeFeed(state, threeAccounts(
    [posted('c-out', -50000, '2026-11-05', 'ONLINE TRANSFER TO SAVINGS XXXX1234'), posted('c-pay', -30000, '2026-11-07', 'CAPITAL ONE CRCARDPMT')],
    [posted('s-in', 50000, '2026-11-06', 'ONLINE TRANSFER FROM CHECKING XXXX9876')],
    [posted('k-in', 30000, '2026-11-09', 'PAYMENT THANK YOU')],
  ), NOW);
  assert.equal(summary.paired, 2);

  const [out, pay, into, received] = ['c-out', 'c-pay', 's-in', 'k-in'].map((id) => txBy(state, id));
  assert.deepEqual([out.pairId, into.pairId], [into.id, out.id]);
  assert.deepEqual([out.kind, out.category, into.kind, into.category], ['transfer', 'transfer', 'transfer', 'transfer']);
  assert.deepEqual([pay.pairId, received.pairId], [received.id, pay.id]);
  assert.deepEqual([pay.kind, pay.category, received.kind, received.category], ['payment', 'card_payment', 'payment', 'card_payment'], 'the cash leg of a card payment is a payment');
  for (const leg of [out, pay, into, received]) assert.equal(leg.review, false);

  assert.equal(mergeFeed(state, threeAccounts(
    [posted('c-out', -50000, '2026-11-05', 'ONLINE TRANSFER TO SAVINGS XXXX1234'), posted('c-pay', -30000, '2026-11-07', 'CAPITAL ONE CRCARDPMT')],
    [posted('s-in', 50000, '2026-11-06', 'ONLINE TRANSFER FROM CHECKING XXXX9876')],
    [posted('k-in', 30000, '2026-11-09', 'PAYMENT THANK YOU')],
  ), NOW).paired, 0);
});

test('one leg read as a transfer is enough: the other leg stops being spending or income', () => {
  const state = newState();
  mergeFeed(state, threeAccounts(
    [posted('c-out', -12000, '2026-11-05', 'WITHDRAWAL'), posted('c-in', 8000, '2026-11-08', 'DEPOSIT')],
    [posted('s-in', 12000, '2026-11-06', 'ONLINE TRANSFER FROM CHECKING XXXX9876'), posted('s-out', -8000, '2026-11-08', 'ONLINE TRANSFER TO CHECKING XXXX1234')],
    [],
  ), NOW);
  assert.deepEqual([txBy(state, 'c-out').kind, txBy(state, 'c-out').category, txBy(state, 'c-out').pairId], ['transfer', 'transfer', txBy(state, 's-in').id]);
  assert.deepEqual([txBy(state, 'c-in').kind, txBy(state, 'c-in').category, txBy(state, 'c-in').pairId], ['transfer', 'transfer', txBy(state, 's-out').id]);
});

test('a payment to a linked loan is a payment; money from a card to cash is a transfer', () => {
  const state = newState();
  mergeFeed(state, feedOf([
    feedAccount('ACT-CHK', '360 Checking', 500000, [posted('c-loan', -24000, '2026-11-05', 'EXAMPLE AUTO FINANCE PYMT'), posted('c-adv', 20000, '2026-11-06', 'ONLINE TRANSFER FROM CARD')]),
    feedAccount('ACT-LOAN', 'Auto Loan', -900000, [posted('l-in', 24000, '2026-11-05', 'PAYMENT RECEIVED')]),
    feedAccount('ACT-CARD', 'Quicksilver Rewards', -95000, [posted('k-adv', -20000, '2026-11-06', 'CASH ADVANCE')]),
  ]), NOW);
  assert.equal(txBy(state, 'l-in').kind, 'payment');
  assert.deepEqual([txBy(state, 'c-loan').kind, txBy(state, 'c-loan').category, txBy(state, 'c-loan').pairId], ['payment', 'card_payment', txBy(state, 'l-in').id]);
  assert.deepEqual([txBy(state, 'c-adv').kind, txBy(state, 'k-adv').kind, txBy(state, 'k-adv').pairId], ['transfer', 'transfer', txBy(state, 'c-adv').id]);
});

test('no pair without equal amounts, opposite flows, two accounts, three days and a transfer-like leg', () => {
  const state = newState();
  const summary = mergeFeed(state, threeAccounts(
    [
      posted('far', -7700, '2026-11-01', 'ONLINE TRANSFER TO SAVINGS XXXX1234'),
      posted('unequal', -6000, '2026-11-05', 'ONLINE TRANSFER TO SAVINGS XXXX1234'),
      posted('same-way', -5000, '2026-11-05', 'ONLINE TRANSFER TO SAVINGS XXXX1234'),
      posted('spend', -2500, '2026-11-05', 'PIZZERIA ROMA'),
      posted('self-out', -4400, '2026-11-05', 'ONLINE TRANSFER TO SAVINGS XXXX1234'),
      posted('self-in', 4400, '2026-11-05', 'ONLINE TRANSFER FROM SAVINGS XXXX1234'),
    ],
    [
      posted('far-in', 7700, '2026-11-05', 'ONLINE TRANSFER FROM CHECKING XXXX9876'),
      posted('unequal-in', 6001, '2026-11-05', 'ONLINE TRANSFER FROM CHECKING XXXX9876'),
      posted('same-way-2', -5000, '2026-11-05', 'ONLINE TRANSFER TO CHECKING XXXX9876'),
    ],
    [posted('refund', 2500, '2026-11-06', 'NORTHSIDE HARDWARE')],
  ), NOW);
  assert.equal(summary.paired, 0);
  assert.ok(state.txs.every((t) => t.pairId === null));
  assert.equal(txBy(state, 'spend').kind, 'spend');
  assert.equal(txBy(state, 'refund').kind, 'refund');
});

test('pairing prefers two transfer-like legs, then the closest day, and uses each leg once', () => {
  const state = newState();
  const summary = mergeFeed(state, threeAccounts(
    [posted('out-a', -10000, '2026-11-05', 'ONLINE TRANSFER TO SAVINGS XXXX1234'), posted('out-b', -10000, '2026-11-07', 'WITHDRAWAL')],
    [posted('in-far', 10000, '2026-11-08', 'ONLINE TRANSFER FROM CHECKING XXXX9876'), posted('in-near', 10000, '2026-11-05', 'ONLINE TRANSFER FROM CHECKING XXXX9876')],
    [],
  ), NOW);
  assert.equal(summary.paired, 2);
  assert.equal(txBy(state, 'out-a').pairId, txBy(state, 'in-near').id);
  assert.equal(txBy(state, 'out-b').pairId, txBy(state, 'in-far').id);
});

test('a leg the owner has pinned as spending is not turned into a transfer; a locked field of a transfer is kept', () => {
  const state = newState();
  const feed = threeAccounts(
    [posted('c-out', -12000, '2026-11-05', 'WITHDRAWAL')],
    [posted('s-in', 12000, '2026-11-06', 'ONLINE TRANSFER FROM CHECKING XXXX9876')],
    [],
  );
  feed.accounts[0].txs.push(pendingRow('placeholder', -100, '2026-11-10', 'PIZZERIA ROMA'));
  mergeFeed(state, { ...feed, accounts: [feed.accounts[0]] }, NOW);
  Object.assign(txBy(state, 'c-out'), { category: 'gifts', klass: 'want', locks: ['category'] });
  assert.equal(mergeFeed(state, feed, NOW).paired, 0);
  assert.deepEqual([txBy(state, 'c-out').kind, txBy(state, 'c-out').category, txBy(state, 'c-out').pairId], ['spend', 'gifts', null]);

  const other = newState();
  mergeFeed(other, { ...feed, accounts: [feed.accounts[0]] }, NOW);
  Object.assign(txBy(other, 'c-out'), { kind: 'transfer', category: 'transfer', klass: 'want', locks: ['kind', 'klass'] });
  assert.equal(mergeFeed(other, feed, NOW).paired, 1);
  assert.deepEqual([txBy(other, 'c-out').kind, txBy(other, 'c-out').klass, txBy(other, 'c-out').locks], ['transfer', 'want', ['kind', 'klass']]);
});

test('manual moves, declines and stream deposits are never paired', () => {
  const state = newState();
  mergeFeed(state, threeAccounts([posted('pay', 190000, '2026-11-05', 'ACME PAYROLL DIRECT DEP')], [], []), NOW);
  txBy(state, 'pay').streamId = 'str_salary';
  addProvisional(state, { amount: 12000, merchant: 'Transfer', day: '2026-11-06' }, NOW);
  addDecline(state, { amount: 12000, merchant: 'Corner Deli', day: '2026-11-06' }, NOW);
  const summary = mergeFeed(state, threeAccounts(
    [posted('pay', 190000, '2026-11-05', 'ACME PAYROLL DIRECT DEP')],
    [posted('s-in', 12000, '2026-11-06', 'ONLINE TRANSFER FROM CHECKING XXXX9876'), posted('s-out', -190000, '2026-11-05', 'ONLINE TRANSFER TO CHECKING XXXX1234')],
    [],
  ), NOW);
  assert.equal(summary.paired, 0);
  assert.equal(txBy(state, 'pay').kind, 'income');
});

/* ------------------------------------------------------------- the sign flip */

function cardFeed(days, name, balance, rows, extra = {}) {
  return later(days, [feedAccount('ACT-CARD', name, balance, rows, extra)]);
}

test('a card reported as a positive number is read as owed from first sight, and stays so while its balance moves against its rows', () => {
  const state = newState();
  const base = [posted('k1', -2300, '2026-11-04', 'NORTHSIDE HARDWARE')];
  mergeFeed(state, cardFeed(0, 'Rewards Visa', 125000, base), NOW);
  const card = accountBy(state, 'ACT-CARD');
  assert.deepEqual([card.type, card.flip, card.balance], ['credit_card', true, -125000], 'a card "in credit" by $1,250 is read as owed at first sight');

  const second = [...base, posted('k2', -4000, '2026-11-11', 'WHOLE FOODS MARKET #101')];
  mergeFeed(state, cardFeed(1, 'Rewards Visa', 129000, second, { available: 371000 }), NOW + DAY_MS);
  assert.deepEqual([card.flip, card.balance], [true, -129000], 'money went out and the reported figure went up: it is what is owed');
  assert.equal(card.available, 371000, 'unused credit is not a balance and is left as reported');
  assert.deepEqual([txBy(state, 'k2').flow, txBy(state, 'k2').kind], ['out', 'spend'], 'the rows themselves were right all along');

  const third = [...second, posted('k3', 30000, '2026-11-12', 'PAYMENT THANK YOU')];
  mergeFeed(state, cardFeed(2, 'Rewards Visa', 99000, third), NOW + 2 * DAY_MS);
  assert.deepEqual([card.flip, card.balance, card.available], [true, -99000, -99000]);

  mergeFeed(state, cardFeed(3, 'Rewards Visa', 99000, third), NOW + 3 * DAY_MS);
  assert.deepEqual([card.flip, card.balance], [true, -99000]);
});

test('a loan reported positive is owed from first sight', () => {
  const state = newState();
  mergeFeed(state, later(0, [feedAccount('ACT-LOAN', 'Auto Loan', 900000, [])]), NOW);
  const loan = accountBy(state, 'ACT-LOAN');
  assert.deepEqual([loan.type, loan.balance, loan.flip], ['loan', -900000, true]);
  mergeFeed(state, later(1, [feedAccount('ACT-LOAN', 'Auto Loan', 876000, [posted('l1', 24000, '2026-11-11', 'PAYMENT RECEIVED')])]), NOW + DAY_MS);
  assert.deepEqual([loan.flip, loan.balance], [true, -876000]);
});

test('the reading of a debt follows the evidence', () => {
  const run = (name, firstBalance, secondBalance, newRows) => {
    const state = newState();
    mergeFeed(state, cardFeed(0, name, firstBalance, []), NOW);
    mergeFeed(state, cardFeed(1, name, secondBalance, newRows), NOW + DAY_MS);
    return accountBy(state, 'ACT-CARD');
  };
  const purchase = [posted('k2', -4000, '2026-11-11', 'WHOLE FOODS MARKET #101')];

  const normal = run('Rewards Visa', -125000, -129000, purchase);
  assert.deepEqual([normal.flip, normal.balance], [false, -129000], 'a card reported the usual way');

  const inCredit = run('Rewards Visa', 5000, 1000, purchase);
  assert.deepEqual([inCredit.flip, inCredit.balance], [false, 1000], 'a card truly in credit moves with its rows');

  const quiet = run('Rewards Visa', 125000, 125000, []);
  assert.deepEqual([quiet.flip, quiet.balance], [true, -125000], 'no rows, no evidence: the first reading stands');

  const unrelated = run('Rewards Visa', 125000, 190000, purchase);
  assert.deepEqual([unrelated.flip, unrelated.balance], [true, -190000], 'a change that is not explained by the rows proves nothing');

  const pendingOnly = run('Rewards Visa', 125000, 129000, [pendingRow('k2', -4000, '2026-11-11', 'WHOLE FOODS MARKET #101')]);
  assert.equal(pendingOnly.flip, true, 'pending rows have not moved the balance: the first reading stands');

  const cash = run('360 Checking', 125000, 129000, purchase);
  assert.deepEqual([cash.type, cash.flip, cash.balance], ['checking', false, 129000], 'only cards and loans can be flipped');

  const state = newState();
  mergeFeed(state, cardFeed(0, 'Rewards Visa', 125000, []), NOW);
  mergeFeed(state, feedOf([feedAccount('ACT-CARD', 'Rewards Visa', 129000, purchase)]), NOW);
  assert.equal(accountBy(state, 'ACT-CARD').flip, true, 'the same snapshot time is not a second observation');

  const smallCredit = run('Rewards Visa', 4000, 4000, []);
  assert.deepEqual([smallCredit.flip, smallCredit.balance], [false, 4000], 'a small credit on a card is taken at its word');

  const largeCredit = run('Rewards Visa', 20000, 16000, purchase);
  assert.deepEqual([largeCredit.flip, largeCredit.balance], [false, 16000], 'a large credit read as owed is corrected once the figure moves with its rows');

  const locked = newState();
  mergeFeed(locked, cardFeed(0, 'Rewards Visa', 125000, []), NOW);
  Object.assign(accountBy(locked, 'ACT-CARD'), { flip: false, flipLocked: true });
  mergeFeed(locked, cardFeed(1, 'Rewards Visa', 129000, purchase), NOW + DAY_MS);
  assert.deepEqual([accountBy(locked, 'ACT-CARD').flip, accountBy(locked, 'ACT-CARD').balance], [false, 129000], "the owner's own choice is never changed");
});

test('a flipped account the owner re-types as cash is no longer negated', () => {
  const state = newState();
  mergeFeed(state, cardFeed(0, 'Rewards Visa', 125000, []), NOW);
  mergeFeed(state, cardFeed(1, 'Rewards Visa', 129000, [posted('k2', -4000, '2026-11-11', 'WHOLE FOODS MARKET #101')]), NOW + DAY_MS);
  const account = accountBy(state, 'ACT-CARD');
  assert.equal(account.flip, true);
  Object.assign(account, { type: 'checking', typeLocked: true });
  mergeFeed(state, cardFeed(2, 'Rewards Visa', 129000, []), NOW + 2 * DAY_MS);
  assert.deepEqual([account.flip, account.balance, account.type], [false, 129000, 'checking']);
});

/* ------------------------------------------------------------ account updates */

test('an existing account takes the new balance and name but keeps what the owner set', () => {
  const state = newState();
  mergeFeed(state, household(), NOW);
  const checking = accountBy(state, 'ACT-CHK');
  const id = checking.id;
  Object.assign(checking, { nick: 'Daily', type: 'savings', typeLocked: true, everyday: false, reserve: true, hidden: true, note: 'mine', apr: 4.1 });

  const summary = mergeFeed(state, later(1, [feedAccount('ACT-CHK', 'Everyday Checking', 250000, CHECKING_ROWS, { available: 249000, institution: 'Example Bank NA', connId: 'CON-7' })]), NOW + DAY_MS);
  assert.equal(summary.accountsAdded, 0);
  assert.equal(state.accounts.length, 3);
  assert.deepEqual({ ...checking }, {
    ...checking, id, name: 'Everyday Checking', institution: 'Example Bank NA', balance: 250000, available: 249000, asOf: NOW + DAY_MS - HOUR_MS, basis: 'bank',
    nick: 'Daily', type: 'savings', typeLocked: true, everyday: false, reserve: true, hidden: true, note: 'mine', apr: 4.1,
    ext: { src: 'simplefin', id: 'ACT-CHK', conn: 'CON-7' },
  });
  assert.equal(accountBy(state, 'ACT-SAV').balance, 50000, 'an account missing from a feed keeps its last balance');
});

test('the type is inferred once: a card paid down to nothing stays a card', () => {
  const state = newState();
  mergeFeed(state, feedOf([feedAccount('ACT-ODD', 'Everyday', -3100)]), NOW);
  assert.equal(accountBy(state, 'ACT-ODD').type, 'credit_card');
  mergeFeed(state, later(1, [feedAccount('ACT-ODD', 'Everyday', 0)]), NOW + DAY_MS);
  assert.deepEqual([accountBy(state, 'ACT-ODD').type, accountBy(state, 'ACT-ODD').balance], ['credit_card', 0]);
});

test('an older balance snapshot never replaces a newer one', () => {
  const state = newState();
  mergeFeed(state, household(), NOW);
  const stale = feedOf([feedAccount('ACT-CHK', '360 Checking', 1, CHECKING_ROWS, { asOf: NOW - 5 * DAY_MS })]);
  mergeFeed(state, stale, NOW);
  assert.deepEqual([accountBy(state, 'ACT-CHK').balance, accountBy(state, 'ACT-CHK').asOf], [241991, NOW - HOUR_MS]);
});

test('accounts are matched within their own provider; a manual account is never taken over', () => {
  const state = newState();
  state.accounts.push({ ...defaultAccountLike(), id: 'acc_manual', source: 'manual', ext: null, name: '360 Checking', balance: 777 });
  mergeFeed(state, { ...household(), src: 'demo' }, NOW);
  mergeFeed(state, household(), NOW);
  assert.equal(state.accounts.length, 7);
  assert.equal(state.accounts[0].balance, 777);
  assert.deepEqual(state.accounts.slice(1).map((a) => a.ext.src), ['demo', 'demo', 'demo', 'simplefin', 'simplefin', 'simplefin']);
});

function defaultAccountLike() {
  return {
    type: 'checking', typeLocked: false, flip: false, nick: '', institution: '', available: null, asOf: 0, basis: 'estimate',
    everyday: true, reserve: false, hidden: false, apr: null, limit: null, minPayment: null, dueDay: null, quickSale: null,
    loan: null, history: [], purpose: 'personal', note: '',
  };
}

/* ------------------------------------------------------------- classification */

test('a deposit that mirrors a recent spend at the same merchant is read as its refund', () => {
  const state = newState();
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, [
    posted('buy', -2500, '2026-11-05', 'PIZZERIA ROMA'),
    posted('back', 2500, '2026-11-08', 'PIZZERIA ROMA'),
    posted('other', 2500, '2026-11-08', 'SOMEBODY ELSE ENTIRELY'),
  ])]), NOW);
  assert.equal(txBy(state, 'back').kind, 'refund');
  assert.equal(txBy(state, 'other').kind, 'income');
});

test('the owner\'s learned rules apply to rows as they arrive', () => {
  const state = newState();
  state.settings.rules = [{ id: 'learned:r1', mkey: 'pizzeria roma', category: 'eating_out', merchant: 'Roma' }];
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, [posted('buy', -2500, '2026-11-05', 'PIZZERIA ROMA')])]), NOW);
  const row = txBy(state, 'buy');
  assert.deepEqual([row.category, row.klass, row.merchant, row.mkey, row.review, row.ruleId], ['eating_out', 'game', 'Roma', 'pizzeria roma', false, 'learned:r1']);
});

test('a changed description is re-read, but never over a lock', () => {
  const state = newState();
  mergeFeed(state, cardWith([posted('r1', -2500, '2026-11-05', 'PIZZERIA ROMA'), posted('r2', -2500, '2026-11-06', 'PIZZERIA ROMA')]), NOW);
  Object.assign(txBy(state, 'r2'), { merchant: 'My pizza place', category: 'eating_out', locks: ['merchant', 'category'] });
  const summary = mergeFeed(state, cardWith([posted('r1', -2500, '2026-11-05', 'DUNKIN #345123 NEW YORK NY'), posted('r2', -2500, '2026-11-06', 'DUNKIN #345123 NEW YORK NY')]), NOW);
  assert.equal(summary.updated, 2);
  assert.deepEqual([txBy(state, 'r1').merchant, txBy(state, 'r1').category, txBy(state, 'r1').mkey], ["Dunkin'", 'cafe', 'dunkin']);
  assert.deepEqual([txBy(state, 'r2').merchant, txBy(state, 'r2').category, txBy(state, 'r2').raw], ['My pizza place', 'eating_out', 'DUNKIN #345123 NEW YORK NY']);
});

test('with no description the payee, then the memo, is the text of the row', () => {
  const state = newState();
  mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, [
    posted('a', -475, '2026-11-05', '', { payee: 'DUNKIN #345123 NEW YORK NY', memo: 'ignored' }),
    posted('b', -475, '2026-11-06', '   ', { payee: '', memo: 'WHOLE FOODS MARKET #101' }),
    posted('c', -475, '2026-11-07', 'PIZZERIA ROMA', { payee: 'DUNKIN', memo: 'DUNKIN' }),
    posted('d', -475, '2026-11-08', '', {}),
  ])]), NOW);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => [txBy(state, id).raw, txBy(state, id).mkey]), [
    ['DUNKIN #345123 NEW YORK NY', 'dunkin'], ['WHOLE FOODS MARKET #101', 'whole foods'], ['PIZZERIA ROMA', 'pizzeria roma'], ['', ''],
  ]);
  assert.deepEqual([txBy(state, 'd').merchant, txBy(state, 'd').kind, txBy(state, 'd').review], ['Unknown', 'spend', true]);
});

/* ----------------------------------------------------------------- state.sync */

test('state.sync records the provider, the time, the earliest day fetched and the provider\'s problems', () => {
  const state = newState();
  state.sync.requests = [NOW - 5000];
  state.sync.lastTry = NOW - 5000;
  state.sync.status = 'relink';
  state.sync.error = 'An older failure';
  const feed = feedOf(household().accounts, {
    errors: [
      { code: 'con.auth', message: 'Sign in to Example Bank again', connId: 'CON-1', accountId: '' },
      { code: 'con.auth', message: 'Sign in to Example Bank again', connId: 'CON-1', accountId: '' },
      { code: 'act.data', message: 'Transactions unavailable', connId: '', accountId: 'ACT-SAV' },
      { code: 'gen', message: 'Something general', connId: 'CON-404', accountId: '' },
      { code: 'empty', message: '', connId: 'CON-1', accountId: '' },
      null, 'text',
    ],
  });
  mergeFeed(state, feed, NOW + 1234);
  assert.deepEqual(state.sync, {
    src: 'simplefin',
    lastTry: NOW - 5000,
    lastOk: NOW,
    error: null,
    status: 'ok',
    problems: [
      { connId: 'CON-1', name: 'Example Bank', message: 'Sign in to Example Bank again' },
      { connId: '', name: 'Example Bank', message: 'Transactions unavailable' },
      { connId: 'CON-404', name: '', message: 'Something general' },
    ],
    from: '2026-10-12',
    requests: [NOW - 5000],
  });
});

test('state.sync.from only ever moves earlier, and problems are replaced by each merge', () => {
  const state = newState();
  mergeFeed(state, feedOf(household().accounts, { errors: [{ code: 'x', message: 'Trouble', connId: 'CON-1', accountId: '' }] }), NOW);
  assert.equal(state.sync.from, '2026-10-12');
  assert.equal(state.sync.problems.length, 1);

  mergeFeed(state, feedOf(household().accounts, { fromMs: NOW - 7 * DAY_MS }), NOW + HOUR_MS);
  assert.equal(state.sync.from, '2026-10-12');
  assert.deepEqual(state.sync.problems, []);

  const older = feedOf(household().accounts, { fromMs: NOW - 180 * DAY_MS, toMs: NOW - 90 * DAY_MS, fetchedAt: NOW + 2 * HOUR_MS });
  mergeFeed(state, older, NOW + 2 * HOUR_MS);
  assert.equal(state.sync.from, '2026-05-15');
  assert.equal(state.sync.lastOk, NOW + 2 * HOUR_MS);
});

test('a feed that names its window `from` / `to`, or not at all, is still merged', () => {
  const named = newState();
  const feed = household();
  delete feed.fromMs;
  delete feed.toMs;
  mergeFeed(named, { ...feed, from: NOW - 30 * DAY_MS, to: NOW }, NOW);
  assert.equal(named.sync.from, '2026-10-12');

  const bare = newState();
  mergeFeed(bare, feed, NOW);
  assert.equal(bare.sync.from, '2026-11-03', 'without a window, the earliest row fetched');
  assert.equal(bare.txs.length, 5);
});

/* ------------------------------------------------------------------ robustness */

test('a feed with malformed accounts and rows never throws and never stores NaN', () => {
  const state = newState();
  const feed = feedOf([
    null, 'account', 42, [],
    {},
    { extId: '', name: 'No id', balance: 100, txs: [] },
    { extId: 'NO-BALANCE', name: 'Checking', txs: [posted('lost', -100, '2026-11-05', 'PIZZERIA ROMA')] },
    { extId: 'NAN', name: 'Checking', balance: NaN, txs: [] },
    {
      extId: 'ACT-OK', name: 'Checking', balance: 5000.4, available: 'lots', asOf: 'now', connId: 7, institution: null,
      txs: [
        null, 'row', 17, [], {},
        { extId: 'no-amount', posted: dateOnly('2026-11-05'), description: 'X' },
        { extId: 'nan', amount: NaN, posted: dateOnly('2026-11-05'), description: 'X' },
        { extId: 'text', amount: '12.00', posted: dateOnly('2026-11-05'), description: 'X' },
        { extId: 'zero', amount: 0, posted: dateOnly('2026-11-05'), description: 'X' },
        { extId: 'inf', amount: -Infinity, posted: dateOnly('2026-11-05'), description: 'X' },
        { extId: 'far', amount: -100, posted: 9e15, description: 'X' },
        { extId: 'bad-posted', amount: -200, posted: 'yesterday', at: dateOnly('2026-11-06'), pending: false, description: 'KEPT AS PENDING' },
        { extId: 'fraction', amount: -300.6, posted: dateOnly('2026-11-07'), description: 42, payee: null, memo: ['x'], mcc: 5812 },
        { amount: -400, posted: dateOnly('2026-11-08') },
        posted('good', -500, '2026-11-09', 'PIZZERIA ROMA'),
      ],
    },
    { extId: 'ACT-OK', name: 'Duplicate', balance: 1, txs: [posted('dup', -1, '2026-11-09', 'X')] },
    { extId: 'ACT-NOLIST', name: 'Savings', balance: 10, txs: 'none' },
  ], { errors: 'none' });

  let summary;
  assert.doesNotThrow(() => { summary = mergeFeed(state, feed, NOW); });
  assert.deepEqual(state.accounts.map((a) => a.ext.id), ['ACT-OK', 'ACT-NOLIST']);
  const ok = accountBy(state, 'ACT-OK');
  assert.deepEqual([ok.balance, ok.available, ok.asOf, ok.ext.conn, ok.institution], [5000, null, NOW, '', '']);
  assert.equal(summary.added, 4);
  assert.deepEqual(state.txs.map((t) => [t.ext && t.ext.id, t.amount, t.day, t.pending]), [
    ['bad-posted', 200, '2026-11-06', true],
    ['fraction', 301, '2026-11-07', false],
    [null, 400, '2026-11-08', false],
    ['good', 500, '2026-11-09', false],
  ]);
  assert.deepEqual([txBy(state, 'fraction').raw, txBy(state, 'fraction').mcc], ['', null]);
  assert.deepEqual(state.sync.problems, []);
  assertSound(state);
  assert.equal(JSON.stringify(state).includes('NaN'), false);

  const before = snapshot(state);
  assert.equal(mergeFeed(state, feed, NOW).added, 0);
  assert.deepEqual(snapshot(state), before);
});

test('an existing account whose balance is unreadable keeps its balance and still takes its rows', () => {
  const state = newState();
  mergeFeed(state, household(), NOW);
  const summary = mergeFeed(state, later(1, [{ extId: 'ACT-CHK', name: '360 Checking', balance: undefined, txs: [...CHECKING_ROWS, posted('c9', -100, '2026-11-11', 'PIZZERIA ROMA')] }]), NOW + DAY_MS);
  assert.equal(summary.added, 1);
  assert.equal(accountBy(state, 'ACT-CHK').balance, 241991);
});

test('what is not a feed, or not a document, changes nothing', () => {
  const state = newState();
  mergeFeed(state, household(), NOW);
  const before = snapshot(state);
  const empty = { accountsAdded: 0, added: 0, updated: 0, removed: 0, matched: 0, paired: 0, newTxIds: [] };
  for (const feed of [null, undefined, 'feed', 7, [], {}, { accounts: null }, { accounts: 'many' }]) {
    assert.deepEqual(mergeFeed(state, feed, NOW), empty);
  }
  assert.deepEqual(snapshot(state), before);
  for (const doc of [null, undefined, 'doc', 5, []]) assert.deepEqual(mergeFeed(doc, household(), NOW), empty);
});

test('a damaged document is repaired enough to merge into', () => {
  const state = { settings: null, accounts: null, txs: [null, 'junk', { id: 'tx_odd' }, { id: 'tx_m', source: 'manual', kind: 'spend', day: 'never', amount: 'x' }], sync: null };
  let summary;
  assert.doesNotThrow(() => { summary = mergeFeed(state, household(), NaN); });
  assert.deepEqual([summary.accountsAdded, summary.added], [3, 5]);
  assert.equal(state.accounts.length, 3);
  assert.equal(state.txs.length, 9);
  assert.equal(state.sync.lastOk, NOW);
  assert.equal(state.sync.status, 'ok');
  assert.doesNotThrow(() => mergeFeed(state, household(), NOW));
  assert.equal(state.txs.length, 9);
});

test('bank text is stored as data and nothing more', () => {
  const state = newState();
  const hostile = '<script>alert(1)</script> ${process.exit()} __proto__ constructor';
  mergeFeed(state, feedOf([feedAccount('__proto__', hostile, 1000, [posted('constructor', -100, '2026-11-05', hostile)])]), NOW);
  assert.equal(state.accounts[0].name, hostile);
  assert.equal(state.txs[0].raw, hostile);
  assert.equal({}.polluted, undefined);
  assert.equal(mergeFeed(state, feedOf([feedAccount('__proto__', hostile, 1000, [posted('constructor', -100, '2026-11-05', hostile)])]), NOW).added, 0);
});

/* ------------------------------------------------------------ the owner's moves */

test('addProvisional: a manual spend that counts until the bank confirms it', () => {
  const state = linkedState();
  const count = state.txs.length;
  const checking = accountBy(state, 'ACT-CHK');
  const move = addProvisional(state, {
    amount: 475, merchant: "Dunkin'", mkey: 'dunkin', category: 'cafe', day: TODAY, accountId: checking.id, planned: true, note: '  before class ',
  }, NOW);
  assert.equal(state.txs.length, count + 1);
  assert.equal(state.txs[count], move);
  assert.match(move.id, /^tx_/);
  assert.deepEqual({ ...move }, {
    ...move, source: 'manual', kind: 'spend', flow: 'out', amount: 475, merchant: "Dunkin'", mkey: 'dunkin', category: 'cafe', klass: 'game',
    day: TODAY, postedDay: null, pending: false, accountId: checking.id, planned: true, note: 'before class', at: NOW, loggedAt: NOW,
    ext: null, raw: '', matchId: null, pairId: null, review: false, locks: [], purpose: 'personal',
  });
  assert.equal(isLive(move), true);
  assert.equal(txEffect(move), -475);
  assertSound(state);
});

test('addProvisional: the merchant\'s usual category and key are filled in when not given', () => {
  const state = linkedState();
  const coffee = addProvisional(state, { amount: 500, merchant: 'dunkin', day: '2026-11-10' }, NOW);
  assert.deepEqual([coffee.merchant, coffee.mkey, coffee.category, coffee.klass, coffee.at], ['dunkin', 'dunkin', 'cafe', 'game', null]);
  const unknown = addProvisional(state, { amount: 500, merchant: 'Some Stall', category: 'nonsense', day: '2026-11-10' }, NOW);
  assert.deepEqual([unknown.mkey, unknown.category, unknown.klass], ['some stall', 'other', 'need']);
  const chosen = addProvisional(state, { amount: 500, merchant: 'Some Stall', category: 'eating_out', day: '2026-11-10' }, NOW);
  assert.deepEqual([chosen.category, chosen.klass], ['eating_out', 'game']);
  const notSpending = addProvisional(state, { amount: 500, merchant: 'Online transfer to savings', day: '2026-11-10' }, NOW);
  assert.deepEqual([notSpending.kind, notSpending.category], ['spend', 'other'], 'a tapped-in move is always a spend');

  state.settings.rules = [{ id: 'learned:r1', mkey: 'some stall', category: 'convenience' }];
  assert.equal(addProvisional(state, { amount: 500, merchant: 'Some Stall', day: '2026-11-10' }, NOW).category, 'convenience');
});

test('addProvisional: odd input is repaired or refused, never thrown on', () => {
  const state = linkedState();
  const count = state.txs.length;
  for (const move of [null, undefined, 'move', {}, { amount: 0, merchant: 'X' }, { amount: NaN, merchant: 'X' }, { amount: '475', merchant: 'X' }]) {
    assert.equal(addProvisional(state, move, NOW), null);
  }
  assert.equal(state.txs.length, count, 'nothing is recorded without an amount');
  assert.equal(addProvisional(null, { amount: 475, merchant: 'X' }, NOW), null);

  const repaired = addProvisional(state, { amount: -475.4, merchant: 42, day: 'tomorrow', accountId: 'acc_nowhere', planned: 'yes', note: 9 }, NOW);
  assert.deepEqual([repaired.amount, repaired.merchant, repaired.day, repaired.accountId, repaired.planned, repaired.note], [475, '', TODAY, null, false, '']);

  const early = addProvisional(state, { amount: 300, merchant: 'Night Deli' }, new Date(2026, 10, 12, 1, 30).getTime());
  assert.equal(early.day, TODAY, 'at 1:30 a.m. it is still yesterday\'s game day');
  assertSound(state);
});

test('addDecline: recorded, and without any monetary effect', () => {
  const state = linkedState();
  const balances = state.accounts.map((a) => a.balance);
  const decline = addDecline(state, { amount: 650, merchant: 'Blue Door Cafe', category: 'cafe', day: TODAY, instead: 'Refilled my own' }, NOW);
  assert.deepEqual({ ...decline }, {
    ...decline, source: 'manual', kind: 'decline', flow: 'out', amount: 650, merchant: 'Blue Door Cafe', mkey: 'blue door cafe', category: 'cafe', klass: 'game',
    day: TODAY, instead: 'Refilled my own', accountId: null, matchId: null, loggedAt: NOW,
  });
  assert.equal(txEffect(decline), 0);
  assert.equal(isLive(decline), false);
  assert.deepEqual(state.accounts.map((a) => a.balance), balances);

  const bare = addDecline(state, { merchant: 'Corner Deli', day: TODAY }, NOW);
  assert.deepEqual([bare.amount, bare.instead, bare.kind], [0, null, 'decline']);
  assert.doesNotThrow(() => addDecline(state, null, NOW));
  assert.equal(addDecline(undefined, {}, NOW), null);
  assertSound(state);
});

test('a decline is never matched, paired, flagged or removed by a merge', () => {
  const state = linkedState();
  const decline = addDecline(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', category: 'cafe', day: '2026-11-01' }, NOW - 10 * DAY_MS);
  const before = snapshot(decline);
  const summary = mergeFeed(state, nextDay([pendingRow('n', -475, '2026-11-02', 'DUNKIN #345123 NEW YORK NY')]), NOW + DAY_MS);
  assert.equal(summary.matched, 0);
  assert.deepEqual(snapshot(decline), before);
});

test('removeManual: removes the owner\'s own rows and nothing else', () => {
  const state = linkedState();
  const move = addProvisional(state, { amount: 475, merchant: "Dunkin'", day: TODAY }, NOW);
  const decline = addDecline(state, { amount: 650, merchant: 'Blue Door Cafe', day: TODAY }, NOW);
  const bank = txBy(state, 'c1');
  const count = state.txs.length;

  assert.equal(removeManual(state, bank.id), false, 'a bank row cannot be removed');
  assert.equal(removeManual(state, 'tx_nowhere'), false);
  for (const id of [null, undefined, '', 5, {}]) assert.equal(removeManual(state, id), false);
  assert.equal(removeManual(null, move.id), false);
  assert.equal(removeManual({}, move.id), false);
  assert.equal(state.txs.length, count);

  assert.equal(removeManual(state, move.id), true);
  assert.equal(removeManual(state, move.id), false, 'it is gone');
  assert.equal(removeManual(state, decline.id), true);
  assert.equal(state.txs.length, count - 2);
  assert.ok(state.txs.includes(bank));
});

test('removing a confirmed move leaves the bank row that replaced it', () => {
  const state = linkedState();
  const move = addProvisional(state, { amount: 475, merchant: "Dunkin'", mkey: 'dunkin', day: '2026-11-10' }, NOW);
  mergeFeed(state, nextDay([pendingRow('c9', -475, '2026-11-10', 'DUNKIN #345123 NEW YORK NY')]), NOW + DAY_MS);
  assert.equal(move.matchId, txBy(state, 'c9').id);
  assert.equal(removeManual(state, move.id), true);
  assert.ok(txBy(state, 'c9'));
  assert.equal(isLive(txBy(state, 'c9')), true);
});

test('the same provider id twice in one feed is one row', () => {
  const state = newState();
  const twice = [
    posted('dup', -475, '2026-11-03', 'DUNKIN #345123 NEW YORK NY'),
    posted('dup', -475, '2026-11-03', 'DUNKIN #345123 NEW YORK NY'),
  ];
  const summary = mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, twice)]), NOW);
  assert.equal(summary.added, 1);
  assert.equal(state.txs.length, 1);
  assert.equal(mergeFeed(state, feedOf([feedAccount('ACT-CHK', '360 Checking', 1000, twice)]), NOW).added, 0, 'and again on the next sync');
});
