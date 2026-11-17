/**
 * The nightly wrap (js/model/wrap.js): which moves count as money in and out of a day, the day figure each device
 * writes to wrap/<device>.json, the late card alerts and marked payments the night job adds without counting anything
 * twice, and the words of the notification in both modes.
 * The rows are built the way the app builds them: a SimpleFIN answer, normalised, merged and refreshed; alerts, moves
 * typed in and payments another app reports go through the app's own functions. Everything here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_MAX, PAYLOAD_MAX, TITLE_MAX, WRAP_FORMAT, wrapDay,
  addLate, emptyDay, exportWrap, nightFigures, pickDay, pushPayload, readWrapFile, revisionOf, wrapDays, wrapFlowOf, wrapText,
} from '../js/model/wrap.js';
import { normalizeSimplefin } from '../js/model/feed.js';
import { mergeFeed, addProvisional, addDecline } from '../js/model/merge.js';
import { refresh } from '../js/model/detect.js';
import { defaultState, makeAccount } from '../js/model/schema.js';
import { addAlertMove, alertFile, parseAlert } from '../js/model/alerts.js';
import { answerPayer, applyIncomeReading, rebuildIncome } from '../js/model/income.js';
import { PHRASES, placeholders } from '../js/model/words.js';
import * as wrapModule from '../js/model/wrap.js';
import { buildHash } from '../js/router.js';

const DAY_MS = 24 * 3600 * 1000;
const NOW = new Date(2026, 10, 16, 21, 30).getTime(); // 9:30 PM, the wrap's time
const TODAY = '2026-11-16';
const iso = (ms) => new Date(ms).toISOString();
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

function dateOnly(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

function row(id, amount, day, description, extra = {}) {
  return { id, posted: dateOnly(day), amount, description, payee: '', memo: '', transacted_at: dateOnly(day), ...extra };
}

function account(id, name, balance, transactions) {
  return { id, name, conn_id: 'CON-1', currency: 'USD', balance, 'balance-date': NOW / 1000 - 3600, transactions };
}

/** A household read from the bank: checking, savings, a card and a brokerage account, a week of moves. */
function bankOnly() {
  const answer = {
    errlist: [],
    connections: [{ conn_id: 'CON-1', name: 'Example Bank' }],
    accounts: [
      account('CHK', 'Everyday Checking', '2614.37', [
        row('paycheck', '1712.64', '2026-11-10', 'ACME CORP PAYROLL DIRECT DEP'),
        row('zelle-in', '73.00', '2026-11-11', 'Zelle payment from Sam Example'),
        row('debit', '-11.85', '2026-11-12', 'POS DEBIT CORNER DELI 123'),
        row('refund', '18.75', '2026-11-13', 'REFUND NORTHSIDE HARDWARE'),
        row('card-pay', '-268.00', '2026-11-14', 'DISCOVER E-PAYMENT 4321'),
        row('to-savings', '-185.00', '2026-11-14', 'TRANSFER TO SAVINGS XXXX9876'),
        row('to-someone', '-475.00', '2026-11-15', 'ONLINE TRANSFER TO J EXAMPLE REF 123'),
        row('fee', '-2.50', '2026-11-15', 'ATM FEE'),
        row('pending', '-6.55', TODAY, 'POS DEBIT BLUE BOTTLE', { posted: 0, pending: true }),
      ]),
      account('SAV', 'Rainy Day Savings', '4870.00', [
        row('from-checking', '185.00', '2026-11-14', 'TRANSFER FROM CHECKING XXXX1234'),
        row('interest', '2.10', '2026-11-10', 'MONTHLY INTEREST PAID'),
      ]),
      account('CARD', 'Northlight Rewards Visa 4321', '-900.00', [
        row('card-buy', '-43.10', '2026-11-12', 'NORTHSIDE HARDWARE'),
        row('card-refund', '20.00', '2026-11-13', 'NORTHSIDE HARDWARE REFUND'),
        row('camera', '-899.00', '2026-11-13', 'LENSWORKS CAMERA SUPPLY'),
        // posted with no time of purchase: the bank's day is the posting day, two days after the alert
        row('bistro', '-23.50', '2026-11-13', 'CORNER BISTRO', { transacted_at: undefined }),
        row('card-in', '268.00', '2026-11-14', 'PAYMENT THANK YOU'),
        row('card-interest', '-11.27', '2026-11-15', 'INTEREST CHARGE ON PURCHASES'),
        row('card-pending', '-8.25', TODAY, 'NORTHSIDE HARDWARE', { posted: 0, pending: true }),
      ]),
      account('INV', 'Brokerage Individual', '10000.00', [
        row('buy', '-1000.00', '2026-11-11', 'BUY VTI'),
        row('dividend', '11.40', '2026-11-11', 'DIVIDEND PAID VTI'),
      ]),
    ],
  };
  const state = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(state, normalizeSimplefin(answer, { fetchedAt: NOW, fromMs: NOW - 30 * DAY_MS, toMs: NOW }), NOW);
  refresh(state, NOW);
  // the camera was bought as equipment: it steps a hand-kept asset account
  const gear = makeAccount({ id: 'acc_gear', source: 'manual', type: 'equipment', name: 'Camera gear', balance: 0, asOf: NOW });
  state.accounts.push(gear);
  const camera = byExt(state, 'camera');
  camera.capital = { accountId: gear.id, value: 89900 };
  return state;
}

const ALERT = (amount, merchant) => 'Northlight: A charge of $' + amount + ' at ' + merchant + ' was made on your card ending in 4321.';

/** The household with what arrives faster than the bank: card alerts, a move typed in, a decline, marked payments. */
function household({ countPending = true } = {}) {
  const state = bankOnly();
  state.settings.countPending = countPending;
  addAlertMove(state, parseAlert(ALERT('20.00', 'CORNER BISTRO')), alertFile('20261111-193000-000.txt'), NOW);
  addAlertMove(state, parseAlert(ALERT('12.00', 'FERNLEAF CAFE')), alertFile('20261116-124500-000.txt'), NOW);
  addProvisional(state, { amount: 500, merchant: 'Corner Deli', day: TODAY, accountId: null }, NOW);
  addDecline(state, { amount: 3000, merchant: 'Corner Deli', day: TODAY }, NOW);
  const items = [
    { id: 'i-early', payer: 'p-sam', cents: 7300, day: '2026-11-09', at: iso(at(2026, 11, 9, 18)) },
    { id: 'i-cash', payer: 'p-cash', cents: 6000, day: '2026-11-15', at: iso(at(2026, 11, 15, 14)) },
    { id: 'i-zelle', payer: 'p-zelle', cents: 4500, day: '2026-11-16', at: iso(at(2026, 11, 16, 10)) },
  ];
  const payers = [{ id: 'p-sam', name: 'Sam' }, { id: 'p-cash', name: 'Robin' }, { id: 'p-zelle', name: 'Kai' }];
  const text = JSON.stringify({ format: 'income/1', what: 'Workshop', writtenAt: iso(NOW), payers, items });
  applyIncomeReading(state, { listed: [{ source: 'club', sha: 's1' }], files: { club: { sha: 's1', text } } }, NOW);
  state.income.shared.since = NOW - 30 * DAY_MS;
  state.income.shared.payers['club/p-cash'] = { how: 'cash', at: NOW - 20 * DAY_MS };
  state.income.shared.payers['club/p-zelle'] = { how: 'bank', at: NOW - 20 * DAY_MS };
  rebuildIncome(state, NOW);
  return state;
}

function byExt(state, extId) {
  const tx = state.txs.find((t) => t.ext && t.ext.id === extId);
  assert.ok(tx, 'the row ' + extId + ' is on the record');
  return tx;
}

function lookups(state) {
  return {
    accountOf: (id) => state.accounts.find((a) => a.id === id) || null,
    pairOf: (id) => state.txs.find((t) => t.id === id) || null,
  };
}

function flow(state, tx) {
  const { accountOf, pairOf } = lookups(state);
  return wrapFlowOf(tx, accountOf, pairOf);
}

/* ------------------------------------------------------------------------------------------ the counting rules */

test('wrapFlowOf: money in is income on any account; money out is a purchase, a fee or interest on cash, card or debt', () => {
  const s = household();
  for (const id of ['paycheck', 'zelle-in', 'interest', 'dividend']) assert.equal(flow(s, byExt(s, id)), 'in', id);
  for (const id of ['debit', 'card-buy', 'fee', 'card-interest', 'camera', 'bistro', 'pending', 'card-pending']) {
    assert.equal(flow(s, byExt(s, id)), 'out', id);
  }
  for (const id of ['refund', 'card-refund']) assert.equal(flow(s, byExt(s, id)), 'back', id + ' (less refunds)');
  assert.equal(flow(s, byExt(s, 'to-someone')), 'out', 'a transfer to someone, with no other leg on record');
});

test('wrapFlowOf: card payments, own transfers, investment moves and declines never count', () => {
  const s = household();
  for (const id of ['card-pay', 'card-in']) assert.equal(flow(s, byExt(s, id)), null, id + ': a card payment, both legs');
  for (const id of ['to-savings', 'from-checking']) assert.equal(flow(s, byExt(s, id)), null, id + ': between own accounts');
  assert.equal(flow(s, byExt(s, 'buy')), null, 'a buy inside the brokerage account');
  const decline = s.txs.find((t) => t.kind === 'decline');
  assert.equal(flow(s, decline), null, 'a decline');
  const { accountOf, pairOf } = lookups(s);
  const inv = s.accounts.find((a) => a.type === 'investment');
  assert.equal(wrapFlowOf({ kind: 'spend', flow: 'out', amount: 500, accountId: inv.id }, accountOf, pairOf), null, 'a spend in an asset account');
  assert.equal(wrapFlowOf({ kind: 'refund', flow: 'in', amount: 500, accountId: inv.id }, accountOf, pairOf), null);
  assert.equal(wrapFlowOf({ kind: 'transfer', flow: 'in', amount: 500, accountId: null }, accountOf, pairOf), null, 'an incoming transfer that is not income');
  assert.equal(wrapFlowOf({ kind: 'spend', flow: 'out', amount: 0, accountId: null }, accountOf, pairOf), null, 'nothing moved');
  assert.equal(wrapFlowOf(null), null);
});

test('wrapFlowOf: moves faster than the bank, and a transfer whose other leg is not on record', () => {
  const s = household();
  const { accountOf, pairOf } = lookups(s);
  const alert = s.txs.find((t) => t.via === 'alert' && !t.matchId);
  assert.equal(wrapFlowOf(alert, accountOf, pairOf), 'out', 'a card alert not yet at the bank');
  const typed = s.txs.find((t) => t.source === 'manual' && !t.via && t.kind === 'spend');
  assert.equal(wrapFlowOf(typed, accountOf, pairOf), 'out', 'a move typed in, on no known account');
  for (const tx of s.txs.filter((t) => t.via === 'income')) assert.equal(wrapFlowOf(tx, accountOf, pairOf), 'in', tx.id);
  const out = byExt(s, 'to-savings');
  assert.equal(wrapFlowOf({ ...out, pairId: 'gone' }, accountOf, pairOf), 'out', 'its other leg is not on record: it went to someone');
  assert.equal(wrapFlowOf({ ...out, pairId: 'gone' }, accountOf), null, 'without a lookup a paired transfer stays between own accounts');
});

/* --------------------------------------------------------------------------------------------- the day figure */

const ZERO_PARTS = { bank: 0, marked: 0, cash: 0, spent: 0, alerts: 0, sent: 0, back: 0 };
const partsOf = (p) => ({ ...ZERO_PARTS, ...p });

test('the day figure: today and the 7 days before, every rule applied by the ledger’s own liveness', () => {
  const { today, days } = wrapDays(household(), NOW);
  assert.equal(today, TODAY);
  assert.deepEqual(Object.keys(days), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
  const want = {
    // the payment marked on the 9th met its Zelle of the 11th: the pair counts once, on the earlier day
    '2026-11-09': { in: 7300, out: 0, parts: partsOf({ bank: 7300 }) },
    '2026-11-10': { in: 171474, out: 0, parts: partsOf({ bank: 171474 }) },
    // the alert of the 11th met its charge posted on the 13th (with a tip): the charge counts on the 11th
    '2026-11-11': { in: 1140, out: 2350, parts: partsOf({ bank: 1140, spent: 2350 }) },
    '2026-11-12': { in: 0, out: 5495, parts: partsOf({ spent: 5495 }) },
    // the camera counts in full although it became equipment; two refunds come off
    '2026-11-13': { in: 0, out: 86025, parts: partsOf({ spent: 89900, back: 3875 }) },
    '2026-11-14': { in: 0, out: 0, parts: partsOf({}) },
    '2026-11-15': { in: 6000, out: 48877, parts: partsOf({ cash: 6000, spent: 1377, sent: 47500 }) },
    '2026-11-16': { in: 4500, out: 3180, parts: partsOf({ marked: 4500, spent: 1480, alerts: 1700 }) },
  };
  for (const [day, w] of Object.entries(want)) {
    assert.equal(days[day].in, w.in, day + ' in');
    assert.equal(days[day].out, w.out, day + ' out');
    assert.deepEqual(days[day].parts, w.parts, day + ' parts');
  }
});

test('the day figure: status from the ledger’s data status, today live; the pending rows are named', () => {
  const { days } = wrapDays(household(), NOW);
  assert.equal(days[TODAY].status, 'live');
  assert.equal(days['2026-11-15'].status, 'provisional', 'the day before the bank’s data day is never final');
  for (const day of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']) assert.equal(days[day].status, 'final', day);
  assert.equal(days[TODAY].pending, 2);
  assert.equal(days['2026-11-15'].pending, 0);
});

test('the day figure: pending rows leave the counts when countPending is off, and are still named', () => {
  const on = wrapDays(household(), NOW).days[TODAY];
  const off = wrapDays(household({ countPending: false }), NOW).days[TODAY];
  assert.equal(on.out - off.out, 655 + 825);
  assert.equal(off.parts.spent, 0);
  assert.equal(off.pending, 2, 'how many rows are pending, counted or not');
});

test('the day figure: a hidden account is left out', () => {
  const s = household();
  s.accounts.find((a) => a.type === 'credit_card').hidden = true;
  const { days } = wrapDays(s, NOW);
  assert.equal(days['2026-11-12'].out, 1185, 'the card purchase of the 12th is gone, the debit stays');
});

test('the day figure: what each day has dealt with, and the bank rows a late item could still meet', () => {
  const { days } = wrapDays(household(), NOW);
  assert.deepEqual(days['2026-11-11'].seen.alerts, ['20261111-193000-000']);
  assert.deepEqual(days[TODAY].seen.alerts, ['20261116-124500-000']);
  assert.deepEqual(days['2026-11-09'].seen.income, ['club/i-early']);
  assert.deepEqual(days['2026-11-15'].seen.income, ['club/i-cash']);
  assert.deepEqual(days[TODAY].seen.income, ['club/i-zelle']);
  assert.deepEqual(days[TODAY].open.charges, [[825, TODAY]], 'the card charge no alert took');
  assert.deepEqual(days['2026-11-15'].open.charges, [[1127, '2026-11-15'], [825, TODAY]]);
  assert.ok(!days['2026-11-11'].open.charges.some(([cents]) => cents === 2350), 'the charge the alert took is not open');
  // the Zelle the early payment claimed is not open; the brokerage dividend can confirm no payment
  assert.deepEqual(days[TODAY].open.deposits, [[210, '2026-11-10'], [171264, '2026-11-10']]);
});

/* ------------------------------------------------------------------------------------------ the device file */

test('the device file: wrap/1, today and the 7 days before, cents and days only', () => {
  const state = household();
  state.sync.lastOk = NOW - 3600 * 1000;
  const file = exportWrap(state, NOW, 'd1a2b3c4d5e6');
  assert.equal(file.format, WRAP_FORMAT);
  assert.equal(file.device, 'd1a2b3c4d5e6');
  assert.equal(file.writtenAt, iso(NOW));
  assert.equal(file.readAt, iso(NOW - 3600 * 1000));
  assert.equal(file.dataAt, iso(NOW - 3600 * 1000));
  assert.equal(file.rollover, 4);
  assert.equal(file.countPending, true);
  assert.equal(Object.keys(file.days).length, 8);
  const text = JSON.stringify(file);
  for (const word of ['NORTHSIDE', 'BISTRO', 'Checking', 'Northlight', 'Workshop', 'Robin', 'Example', 'acc_']) {
    assert.ok(!text.includes(word), 'no merchant, account or payer: ' + word);
  }
  const back = readWrapFile(text);
  assert.equal(back.ok, true, back.problem);
  assert.deepEqual(back.file, file);
  assert.ok(text.length < 6000, 'a few KB: ' + text.length);
});

test('the device file is read strictly: anything odd refuses it', () => {
  const good = exportWrap(household(), NOW, 'dev1');
  const bad = (change) => {
    const copy = JSON.parse(JSON.stringify(good));
    change(copy);
    return readWrapFile(JSON.stringify(copy));
  };
  assert.equal(readWrapFile('not json').ok, false);
  assert.equal(readWrapFile('[]').ok, false);
  assert.equal(bad((f) => { f.format = 'wrap/2'; }).ok, false);
  assert.equal(bad((f) => { f.device = '../x'; }).ok, false);
  assert.equal(bad((f) => { f.writtenAt = 'yesterday'; }).ok, false);
  assert.equal(bad((f) => { f.rollover = 25; }).ok, false);
  assert.equal(bad((f) => { f.days['2026-02-30'] = f.days[TODAY]; }).ok, false);
  assert.equal(bad((f) => { f.days[TODAY].in = 1.5; }).ok, false);
  assert.equal(bad((f) => { f.days[TODAY].parts.spent = -1; }).ok, false);
  assert.equal(bad((f) => { f.days[TODAY].status = 'done'; }).ok, false);
  assert.equal(bad((f) => { f.days[TODAY].seen.alerts.push('../../etc'); }).ok, false);
  assert.equal(bad((f) => { f.days[TODAY].open.charges.push([5, 'soon']); }).ok, false);
  assert.equal(bad((f) => { for (let i = 1; i <= 20; i++) f.days['2026-10-' + String(i).padStart(2, '0')] = f.days[TODAY]; }).ok, false);
  assert.equal(readWrapFile('{"__proto__":{"format":"wrap/1"}}').ok, false);
  assert.equal(readWrapFile(' '.repeat(300001)).ok, false, 'too large');
});

test('one device file per day: the latest bank reading, then the latest writing', () => {
  const a = { device: 'a', readAt: iso(NOW - 5 * 3600e3), writtenAt: iso(NOW - 3600e3), days: { [TODAY]: emptyDay('live') } };
  const b = { device: 'b', readAt: iso(NOW - 2 * 3600e3), writtenAt: iso(NOW - 4 * 3600e3), days: { [TODAY]: emptyDay('live') } };
  const c = { device: 'c', readAt: iso(NOW - 2 * 3600e3), writtenAt: iso(NOW - 3 * 3600e3), days: { [TODAY]: emptyDay('live') } };
  const old = { device: 'o', readAt: iso(NOW), writtenAt: iso(NOW), days: { '2026-11-01': emptyDay('final') } };
  assert.equal(pickDay([a, b, c, old], TODAY).device, 'c');
  assert.equal(pickDay([a, { ...b, readAt: null }], TODAY).device, 'a');
  assert.equal(pickDay([old], TODAY), null, 'no file covers the day');
});

/* ------------------------------------------------------------------------------------------------ late items */

const inboxFile = (name, text) => ({ name, size: Buffer.byteLength(text), text });
const NO_INCOME = { sources: {}, shared: null };

function late(inbox, income = NO_INCOME) {
  return { today: TODAY, rollover: 4, inbox, income };
}

test('late alerts: one that meets an open charge counts once; one that meets none counts; each charge is used once', () => {
  const fig = wrapDays(household(), NOW).days[TODAY];
  const inbox = [
    inboxFile('20261116-124500-000.txt', ALERT('12.00', 'FERNLEAF CAFE')),    // seen: already counted
    inboxFile('20261116-200500-000.txt', ALERT('8.00', 'NORTHSIDE HARDWARE')), // its pending charge is open: counted as the charge
    inboxFile('20261116-201000-000.txt', ALERT('8.00', 'NORTHSIDE HARDWARE')), // a second one: the charge is taken
    inboxFile('20261116-203000-000.txt', ALERT('15.00', 'QUILL BOOKS')),       // nothing at the bank yet
    inboxFile('20261116-204000-000.txt', 'Your verification code is 482913'), // not a purchase
    inboxFile('20261115-210000-000.txt', ALERT('9.00', 'QUILL BOOKS')),        // another day
    inboxFile('notes.txt', ALERT('99.00', 'QUILL BOOKS')),                      // not the phone's name
    { name: '20261116-205000-000.txt', size: 2400, text: ALERT('7.00', 'QUILL BOOKS') + ' '.repeat(2300) }, // too large
  ];
  const { fig: after, alerts } = addLate(fig, TODAY, late(inbox));
  assert.equal(alerts, 2);
  assert.equal(after.out, fig.out + 800 + 1500);
  assert.equal(after.parts.alerts, fig.parts.alerts + 2300);
  assert.equal(after.in, fig.in);
  assert.deepEqual(fig.parts.alerts, 1700, 'the figure given is not changed');
});

test('late alerts: a day no device has read has only alerts and marked payments', () => {
  const { fig, alerts } = addLate(null, TODAY, late([inboxFile('20261116-203000-000.txt', ALERT('15.00', 'QUILL BOOKS'))]));
  assert.equal(alerts, 1);
  assert.equal(fig.out, 1500);
  assert.equal(fig.in, 0);
  assert.equal(fig.status, 'live');
});

function incomeOf(items, payers, answers = {}) {
  const sources = {
    club: {
      what: 'Workshop', from: null,
      payers: payers.map(([id, name]) => ({ id, name })),
      items: items.map(([id, payer, cents, ms, day]) => ({ id, payer, cents, at: ms, day: day || '2026-11-16' })),
    },
  };
  return { sources, shared: { since: NOW - 30 * DAY_MS, payers: answers.payers || {}, items: answers.items || {}, counts: [] } };
}

test('late payments: one its deposit already claims counts once; one with no deposit counts; seen ones are not added', () => {
  const fig = { ...wrapDays(household(), NOW).days[TODAY] };
  fig.open = { ...fig.open, deposits: [...fig.open.deposits, [6500, TODAY]] };
  const income = incomeOf([
    ['i-zelle', 'p-zelle', 4500, at(2026, 11, 16, 10)],  // seen: already counted
    ['i-paid', 'p-zelle', 6500, at(2026, 11, 16, 19)],   // the deposit of today is open: counted as the deposit
    ['i-new', 'p-zelle', 3000, at(2026, 11, 16, 20)],    // no deposit: counts in pencil
    ['i-hand', 'p-cash', 2500, at(2026, 11, 16, 20, 30)], // paid in cash
    ['i-gone', 'p-zelle', 1200, at(2026, 11, 16, 20, 45)], // answered "it's in the bank"
    ['i-other', 'p-zelle', 900, at(2026, 11, 15, 20)],    // another day
  ], [['p-zelle', 'Kai'], ['p-cash', 'Robin']], {
    payers: { 'club/p-zelle': { how: 'bank', at: NOW - DAY_MS }, 'club/p-cash': { how: 'cash', at: NOW - DAY_MS } },
    items: { 'club/i-gone': { how: 'gone', at: NOW - 3600e3 } },
  });
  const { fig: after, payments } = addLate(fig, TODAY, late([], income));
  assert.equal(payments, 2);
  assert.equal(after.in, fig.in + 3000 + 2500);
  assert.equal(after.parts.marked, fig.parts.marked + 3000);
  assert.equal(after.parts.cash, fig.parts.cash + 2500);
  assert.equal(after.out, fig.out);
});

test('late items: matched by id, so a device clock that is off cannot double count', () => {
  const base = wrapDays(household(), NOW).days[TODAY];
  // device A read the bank at 3 PM and counted the 8 PM alert; device B, its clock a day fast, says it read "tomorrow"
  // and has not seen that alert. B is chosen as the latest reading, and only B's lists are used with B's figure.
  const alert = inboxFile('20261116-200000-000.txt', ALERT('15.00', 'QUILL BOOKS'));
  const a = { device: 'a', readAt: iso(at(2026, 11, 16, 15)), writtenAt: iso(at(2026, 11, 16, 20, 5)),
    days: { [TODAY]: { ...base, out: base.out + 1500, parts: { ...base.parts, alerts: base.parts.alerts + 1500 }, seen: { ...base.seen, alerts: [...base.seen.alerts, '20261116-200000-000'] } } } };
  const b = { device: 'b', readAt: iso(NOW + DAY_MS), writtenAt: iso(NOW + DAY_MS), days: { [TODAY]: base } };
  const chosen = pickDay([a, b], TODAY);
  assert.equal(chosen.device, 'b');
  const { fig } = addLate(chosen.days[TODAY], TODAY, late([alert]));
  assert.equal(fig.out, base.out + 1500, 'the alert counts once');
  // the other way round: A's clock a day slow, B (right) chosen; A's having seen it changes nothing
  const { fig: again } = addLate(a.days[TODAY], TODAY, late([alert]));
  assert.equal(again.out, base.out + 1500, 'a file that has seen it does not add it again, whatever its times say');
});

/* -------------------------------------------------------------------------------------------- the words */

const night = (inCents, outCents, extra = {}) => ({ day: TODAY, status: 'live', in: inCents, out: outCents, ...extra });

test('the words: the usual night, in Chess and Finance words', () => {
  const revision = { day: '2026-11-15', net: -1240, final: false };
  assert.deepEqual(wrapText(night(18000, 13790), revision, 'chess', 'show'), {
    title: 'Round 16 · cash ≈+$42.10 so far',
    body: 'In ≈$180.00 · out ≈$137.90. Round 15 now ≈−$12.40, in pencil.',
    revised: true,
  });
  assert.deepEqual(wrapText(night(18000, 13790), revision, 'finance', 'show'), {
    title: 'Day 16 · net cash ≈+$42.10 so far',
    body: 'In ≈$180.00 · out ≈$137.90. Day 15 now ≈−$12.40, provisional.',
    revised: true,
  });
});

test('the words: a day turned final is in ink, without the approximately sign', () => {
  const revision = { day: '2026-11-14', net: 310, final: true };
  assert.equal(wrapText(night(18000, 13790), revision, 'chess', 'show').body, 'In ≈$180.00 · out ≈$137.90. Round 14 in ink: +$3.10.');
  assert.equal(wrapText(night(18000, 13790), revision, 'finance', 'show').body, 'In ≈$180.00 · out ≈$137.90. Day 14 final: +$3.10.');
});

test('the words: the bank not read today', () => {
  assert.deepEqual(wrapText(night(0, 2375, { noBank: true }), null, 'chess', 'show'), {
    title: 'Round 16 · cash ≈−$23.75 so far',
    body: 'Bank not read today: nothing in · out ≈$23.75.',
    revised: false,
  });
  assert.deepEqual(wrapText(night(0, 2375, { noBank: true }), null, 'finance', 'show'), {
    title: 'Day 16 · net cash ≈−$23.75 so far',
    body: 'Bank not read today: nothing in · out ≈$23.75.',
    revised: false,
  });
});

test('the words: with the bank not read today, a revision clause still fits, in both modes', () => {
  const revision = { day: '2026-11-15', net: -400, final: false };
  assert.deepEqual(wrapText(night(0, 900, { noBank: true }), revision, 'chess', 'show'), {
    title: 'Round 16 · cash ≈−$9.00 so far',
    body: 'Bank not read today: nothing in · out ≈$9.00. Round 15 now ≈−$4.00, in pencil.',
    revised: true,
  });
  assert.deepEqual(wrapText(night(0, 900, { noBank: true }), revision, 'finance', 'show'), {
    title: 'Day 16 · net cash ≈−$9.00 so far',
    body: 'Bank not read today: nothing in · out ≈$9.00. Day 15 now ≈−$4.00, provisional.',
    revised: true,
  });
  for (const mode of ['chess', 'finance']) {
    const ink = wrapText(night(7500, 3525, { noBank: true }), { day: '2026-11-14', net: -128877, final: true }, mode, 'show');
    assert.ok(ink.revised && ink.body.length <= BODY_MAX, ink.body);
    assert.deepEqual(wrapText(night(0, 0, { noBank: true }), revision, mode, 'show').revised, true);
  }
});

test('the words: nothing moved, never an estimated zero', () => {
  assert.deepEqual(wrapText(night(0, 0), null, 'chess', 'show'), { title: 'Round 16 · no money in or out so far', body: '', revised: false });
  assert.deepEqual(wrapText(night(0, 0), null, 'finance', 'show'), { title: 'Day 16 · no money in or out so far', body: '', revised: false });
  const revision = { day: '2026-11-15', net: -1240, final: false };
  assert.equal(wrapText(night(0, 0), revision, 'chess', 'show').body, 'Round 15 now ≈−$12.40, in pencil.');
  assert.equal(wrapText(night(4500, 0), null, 'chess', 'show').body, 'In ≈$45.00 · nothing out.');
  assert.equal(wrapText(night(0, 0, { noBank: true }), null, 'finance', 'show').body, 'Bank not read today.');
});

test('the words: amounts hidden from the lock screen', () => {
  const revision = { day: '2026-11-15', net: -1240, final: false };
  assert.deepEqual(wrapText(night(18000, 13790), revision, 'chess', 'hide'), { title: 'Round 16 · tonight’s wrap', body: 'Tap to see money in and out.', revised: false });
  assert.deepEqual(wrapText(night(18000, 13790), revision, 'finance', 'hide'), { title: 'Day 16 · tonight’s wrap', body: 'Tap to see money in and out.', revised: false }, 'a hidden message carries no clause');
  assert.equal(wrapText(night(18000, 13790), null, 'chess', undefined).title, 'Round 16 · tonight’s wrap', 'no choice on record hides the amounts');
});

test('the words: every case fits a lock screen (title ' + TITLE_MAX + ', body ' + BODY_MAX + ' characters)', () => {
  const huge = 99999999999;
  const cases = [];
  for (const mode of ['chess', 'finance']) {
    for (const lock of ['show', 'hide']) {
      for (const [i, o] of [[18000, 13790], [0, 0], [huge, 1], [1, huge], [huge, huge], [0, -huge]]) {
        for (const noBank of [false, true]) {
          for (const revision of [null, { day: '2026-11-15', net: -huge, final: false }, { day: '2026-11-14', net: huge, final: true }]) {
            cases.push(wrapText({ day: '2026-11-30', status: 'live', in: i, out: o, noBank }, revision, mode, lock));
          }
        }
      }
    }
  }
  for (const { title, body, revised } of cases) {
    assert.ok(title.length <= TITLE_MAX, title);
    assert.ok(body.length <= BODY_MAX, body);
    assert.ok(!/complete/i.test(title + body), 'never "complete"');
    assert.equal(revised, /(Round|Day) \d+ (now|in ink|final)/.test(body), 'revised says whether the clause is in the body: ' + body);
  }
  // the revision clause goes when it would not fit, and says so
  const long = wrapText({ day: TODAY, in: 1234567, out: 2345678, noBank: true }, { day: '2026-11-15', net: -1240, final: false }, 'finance', 'show');
  assert.equal(long.body, 'Bank not read today: in ≈$12,345.67 · out ≈$23,456.78.');
  assert.equal(long.revised, false);
});

test('the words: in words.js as wrap.* keys, both modes, the same placeholders; wrap.js keeps no copy', () => {
  const keys = Object.keys(PHRASES).filter((key) => key.startsWith('wrap.'));
  for (const key of ['wrap.title', 'wrap.title.still', 'wrap.title.hidden', 'wrap.body.hidden', 'wrap.flows', 'wrap.in', 'wrap.out',
    'wrap.in.none', 'wrap.out.none', 'wrap.noBank', 'wrap.noBank.still', 'wrap.pencil', 'wrap.ink']) assert.ok(keys.includes(key), key);
  for (const key of keys) {
    const phrase = PHRASES[key];
    assert.deepEqual(placeholders(phrase.chess), placeholders(phrase.finance), key);
    assert.ok(phrase.chess && phrase.finance, key);
  }
  assert.equal(wrapModule.WRAP_PHRASES, undefined, 'the words live in words.js only');
  // the notification's words, as words.js has them
  assert.equal(PHRASES['wrap.pencil'].chess, '{round} now {net}, in pencil.');
  assert.equal(PHRASES['wrap.pencil'].finance, '{round} now {net}, provisional.');
  assert.equal(PHRASES['wrap.ink'].finance, '{round} final: {net}.');
});

/* --------------------------------------------------------------------------------------- the revision clause */

test('the revision clause: the day before when its total changed since it was sent', () => {
  const figs = { '2026-11-15': { status: 'provisional', in: 6000, out: 7240 }, '2026-11-14': { status: 'final', in: 310, out: 0 } };
  const sent = { days: { '2026-11-15': { in: 6000, out: 5000, status: 'live' }, '2026-11-14': { in: 310, out: 0, status: 'provisional' } } };
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-15', net: -1240, final: false });
});

test('the revision clause: else a day that has turned final; else none; never twice', () => {
  const figs = {
    '2026-11-15': { status: 'provisional', in: 6000, out: 5000 },
    '2026-11-14': { status: 'final', in: 310, out: 0 },
    '2026-11-13': { status: 'final', in: 0, out: 900 },
  };
  const sent = { days: {
    '2026-11-15': { in: 6000, out: 5000, status: 'live' },
    '2026-11-14': { in: 300, out: 0, status: 'provisional' },
    '2026-11-13': { in: 0, out: 900, status: 'provisional' },
  } };
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-14', net: 310, final: true }, 'the latest day turned final');
  sent.days['2026-11-14'] = { in: 310, out: 0, status: 'final' }; // told: recorded as it was told
  sent.days['2026-11-13'].status = 'final';
  assert.equal(revisionOf(TODAY, figs, sent), null, 'already said');
  assert.equal(revisionOf(TODAY, figs, null), null, 'nothing was sent before');
});

test('the revision clause: an earlier day whose change was never told is told on a later night', () => {
  // 11-14 changed after it was last told (its clause did not fit on an earlier night, so sent.json still has the old
  // total); yesterday is unchanged
  const figs = {
    '2026-11-15': { status: 'awaiting', in: 0, out: 900 },
    '2026-11-14': { status: 'awaiting', in: 0, out: 400 },
    '2026-11-13': { status: 'final', in: 0, out: 100 },
  };
  const sent = { days: {
    '2026-11-15': { in: 0, out: 900, status: 'live' },
    '2026-11-14': { in: 0, out: 0, status: 'live' },
    '2026-11-13': { in: 0, out: 100, status: 'provisional' },
  } };
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-14', net: -400, final: false });
  sent.days['2026-11-14'] = { in: 0, out: 400, status: 'awaiting' }; // told
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-13', net: -100, final: true }, 'then the day turned final');
  sent.days['2026-11-15'].out = 800; // yesterday changed: it comes first
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-15', net: -900, final: false });
});

/* ------------------------------------------------------------------------------------------- the message */

test('the message: Declarative Web Push that opens the day, small enough for any push service', () => {
  const device = { appUrl: 'https://owner.example/app/', words: 'chess', lock: 'show' };
  const message = pushPayload(night(18000, 13790), { day: '2026-11-15', net: -1240, final: false }, device);
  assert.deepEqual(message, {
    web_push: 8030,
    notification: {
      title: 'Round 16 · cash ≈+$42.10 so far',
      body: 'In ≈$180.00 · out ≈$137.90. Round 15 now ≈−$12.40, in pencil.',
      navigate: 'https://owner.example/app/' + buildHash({ view: 'board', sheet: { name: 'day', params: { day: TODAY } } }),
      lang: 'en-US',
      tag: 'wrap-2026-11-16',
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(message)) < PAYLOAD_MAX);
  const quiet = pushPayload(night(0, 0), null, { appUrl: 'https://owner.example/app/index.html#/old', words: 'finance', lock: 'hide' });
  assert.equal(quiet.notification.navigate, 'https://owner.example/app/index.html#/board?sheet=day&s.day=2026-11-16');
  assert.equal(quiet.notification.body, 'Tap to see money in and out.');
  const empty = pushPayload(night(0, 0), null, { appUrl: 'https://owner.example/', words: 'chess', lock: 'show' });
  assert.ok(!('body' in empty.notification), 'no empty body');
});

/* ------------------------------------------------------------------------- the day sheet's Money in and out */

test('the day sheet: one day’s money in and out, what counted and what did not, the same figure the device writes', () => {
  const state = household();
  const days = wrapDays(state, NOW).days;
  for (const [day, fig] of Object.entries(days)) {
    const one = wrapDay(state, NOW, day);
    assert.equal(one.in, fig.in, day + ' in');
    assert.equal(one.out, fig.out, day + ' out');
    assert.equal(one.status, fig.status, day + ' status');
    let sum = 0;
    for (const c of one.counted) sum += c.way === 'in' ? 0 : c.way === 'out' ? c.amount : -c.amount;
    assert.equal(sum, one.out, day + ': the counted moves add up');
  }
  // November 14: a card payment (both legs) and a transfer to savings (both legs): nothing counted, each with its reason
  const quiet = wrapDay(state, NOW, '2026-11-14');
  assert.deepEqual([quiet.in, quiet.out, quiet.counted.length], [0, 0, 0]);
  assert.deepEqual(quiet.left.map((l) => l.why).sort(), ['own', 'own', 'payment', 'payment']);
  // November 15: a transfer to someone, an ATM fee, card interest out; the cash payment in
  const busy = wrapDay(state, NOW, '2026-11-15');
  const sent = busy.counted.find((c) => c.sent);
  assert.equal(sent.amount, 47500);
  assert.equal(sent.way, 'out');
  assert.ok(busy.counted.some((c) => c.way === 'in' && c.amount === 6000), 'the marked cash payment');
  assert.equal(busy.status, 'provisional');
  // today is live, a day ahead counts nothing
  assert.equal(wrapDay(state, NOW, TODAY).status, 'live');
  const ahead = wrapDay(state, NOW, '2026-11-18');
  assert.deepEqual([ahead.status, ahead.in, ahead.out, ahead.counted.length, ahead.left.length], ['future', 0, 0, 0, 0]);
});

/* ----------------------------------------------------------------------------------- part 2: the fix round */

const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

test('the day sheet: a payment whose deposit comes 8 to 30 days after its marked day still counts on its marked day', () => {
  const checking = (now, rows) => normalizeSimplefin({ errlist: [], connections: [{ conn_id: 'C', name: 'Example Bank' }], accounts: [
    { id: 'CHK', name: 'Everyday Checking', conn_id: 'C', currency: 'USD', balance: '1000.00', 'balance-date': now / 1000 - 3600, transactions: rows },
  ] }, { fetchedAt: now, fromMs: now - 40 * DAY_MS, toMs: now });
  const marked = at(2026, 11, 5, 15);
  const text = JSON.stringify({ format: 'income/1', what: 'Workshop', writtenAt: iso(marked), payers: [{ id: 'p1', name: 'Kai' }],
    items: [{ id: 'i1', payer: 'p1', cents: 12000, day: '2026-11-05', at: iso(marked) }] });
  for (const gap of [5, 8, 10, 20, 30]) {
    const state = defaultState(at(2026, 9, 1, 12));
    const t0 = at(2026, 11, 5, 16);
    const older = row('old', '-5.00', '2026-11-01', 'POS DEBIT CORNER DELI');
    mergeFeed(state, checking(t0, [older]), t0);
    refresh(state, t0);
    applyIncomeReading(state, { listed: [{ source: 'club', sha: 'a' }], files: { club: { sha: 'a', text } } }, t0);
    answerPayer(state, 'club', 'p1', 'bank', t0);
    assert.equal(wrapDay(state, at(2026, 11, 5, 21, 30), '2026-11-05').in, 12000, gap + ': in pencil on its day');
    const t1 = at(2026, 11, 5 + gap, 21);
    const depositDay = ymd(t1);
    mergeFeed(state, checking(t1, [older, row('dep', '120.00', depositDay, 'Zelle payment from Kai Example')]), t1);
    refresh(state, t1);
    applyIncomeReading(state, { listed: [{ source: 'club', sha: 'a' }], files: { club: { sha: 'a', text } } }, t1);
    const deposit = byExt(state, 'dep');
    assert.ok(state.txs.some((t) => t.via === 'income' && t.matchId === deposit.id), gap + ': the deposit met the payment');
    const now = at(2026, 11, 5 + gap, 21, 30);
    assert.equal(wrapDay(state, now, '2026-11-05').in, 12000, gap + ' days later: the deposit counts on the marked day');
    assert.equal(wrapDay(state, now, depositDay).in, 0, gap + ' days later: and not on its own day');
  }
});

test('late alerts with pending rows left out: a pending card charge is still open, so an alert that meets it adds nothing', () => {
  const fig = wrapDays(household({ countPending: false }), NOW).days[TODAY];
  assert.deepEqual(fig.open.charges, [[825, TODAY]], 'the pending charge is open, whatever countPending says');
  const alert = inboxFile('20261116-200500-000.txt', ALERT('8.00', 'NORTHSIDE HARDWARE'));
  const { fig: after, alerts } = addLate(fig, TODAY, late([alert]));
  assert.equal(alerts, 0);
  assert.equal(after.out, fig.out);
  // the device that reads the same alert agrees: the alert meets the pending row, which does not count
  const device = household({ countPending: false });
  addAlertMove(device, parseAlert(alert.text), alertFile(alert.name), NOW);
  assert.equal(wrapDays(device, NOW).days[TODAY].out, after.out);
});

test('the night: one open charge meets one late alert across the whole window, never one per day', () => {
  const t = at(2026, 11, 17, 18);
  const state = defaultState(t - 200 * DAY_MS);
  mergeFeed(state, normalizeSimplefin({ errlist: [], connections: [{ conn_id: 'C', name: 'Example Bank' }], accounts: [
    { id: 'CARD', name: 'Northlight Rewards Visa 4321', conn_id: 'C', currency: 'USD', balance: '-300.00', 'balance-date': t / 1000 - 3600, transactions: [
      row('coffee', '-5.00', '2026-11-17', 'BEAN COUNTER', { transacted_at: undefined }), // posted with no time of purchase
    ] },
  ] }, { fetchedAt: t, fromMs: t - 30 * DAY_MS, toMs: t }), t);
  refresh(state, t);
  state.sync = { ...(state.sync || {}), lastOk: t };
  const file = readWrapFile(JSON.stringify(exportWrap(state, t, 'mac'))).file;
  assert.deepEqual(file.days['2026-11-16'].open.charges, [[500, '2026-11-17']], 'the charge is open to the 16th');
  assert.deepEqual(file.days['2026-11-17'].open.charges, [[500, '2026-11-17']], 'and to the 17th');
  const inbox = [inboxFile('20261116-080000-000.txt', ALERT('5.00', 'BEAN COUNTER')), inboxFile('20261117-080000-000.txt', ALERT('5.00', 'BEAN COUNTER'))];
  const { figs, alerts } = nightFigures([file], { today: '2026-11-17', rollover: 4, inbox, income: NO_INCOME });
  assert.equal(alerts, 1, 'one alert met the charge, the other is added');
  const now = at(2026, 11, 17, 21, 33);
  for (const entry of inbox) addAlertMove(state, parseAlert(entry.text), alertFile(entry.name), now);
  for (const day of ['2026-11-16', '2026-11-17']) {
    assert.equal(figs[day].out, 500, day + ': both coffees counted');
    assert.equal(figs[day].out, wrapDay(state, now, day).out, day + ': the night says what the day sheet will');
  }
});

test('the night: one open deposit meets one late payment across the whole window, never one per day', () => {
  const open = { charges: [], deposits: [[6500, '2026-11-15']] };
  const file = { device: 'a', readAt: iso(NOW - 3600e3), writtenAt: iso(NOW - 3600e3), days: {
    '2026-11-15': { ...emptyDay('provisional'), in: 6500, parts: { ...emptyDay().parts, bank: 6500 }, open },
    [TODAY]: { ...emptyDay('live'), open },
  } };
  const income = incomeOf([
    ['i-a', 'p-zelle', 6500, at(2026, 11, 15, 19), '2026-11-15'],
    ['i-b', 'p-zelle', 6500, at(2026, 11, 16, 19), TODAY],
  ], [['p-zelle', 'Kai']], { payers: { 'club/p-zelle': { how: 'bank', at: NOW - 10 * DAY_MS } } });
  const { figs, payments } = nightFigures([file], late([], income));
  assert.equal(payments, 1);
  assert.equal(figs['2026-11-15'].in, 6500, 'the deposit is the 15th’s payment');
  assert.equal(figs[TODAY].in, 6500, 'the 16th’s payment found no deposit left: it counts in pencil');
});

test('the revision clause: an empty day that turned final is not news, and does not take the slot', () => {
  const figs = {
    '2026-11-15': { status: 'provisional', in: 6000, out: 5000 },
    '2026-11-13': { status: 'final', in: 0, out: 0 },
    '2026-11-12': { status: 'final', in: 0, out: 700 },
  };
  const sent = { days: {
    '2026-11-15': { in: 6000, out: 5000, status: 'live' },
    '2026-11-13': { in: 0, out: 0, status: 'provisional' },
    '2026-11-12': { in: 0, out: 700, status: 'provisional' },
  } };
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-12', net: -700, final: true }, 'the day with something in it');
  sent.days['2026-11-12'].status = 'final';
  assert.equal(revisionOf(TODAY, figs, sent), null, 'nothing else to tell');
  // an empty day whose total was told otherwise is still news
  sent.days['2026-11-13'] = { in: 0, out: 300, status: 'provisional' };
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-13', net: 0, final: true });
});

test('the revision clause: a changed day outranks a day that only turned final, and says final in the same clause', () => {
  // 11-12 changed (and turned final since it was told); 11-14 only turned final
  const figs = {
    '2026-11-15': { status: 'provisional', in: 0, out: 1500 },
    '2026-11-14': { status: 'final', in: 0, out: 1400 },
    '2026-11-12': { status: 'final', in: 0, out: 5300 },
  };
  const sent = { days: {
    '2026-11-15': { in: 0, out: 1500, status: 'live' },
    '2026-11-14': { in: 0, out: 1400, status: 'provisional' },
    '2026-11-12': { in: 0, out: 4900, status: 'live' },
  } };
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-12', net: -5300, final: true }, 'the change, in ink');
  sent.days['2026-11-12'] = { in: 0, out: 5300, status: 'final' }; // told
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-14', net: -1400, final: true }, 'only then the day that turned final');
  // yesterday's change comes before any other
  sent.days['2026-11-12'].out = 4000;
  sent.days['2026-11-15'].out = 1000;
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-15', net: -1500, final: false });
});

test('the revision clause: the latest changed day, but the oldest on its last night in the window', () => {
  const figs = {};
  const sent = { days: {} };
  for (let d = '2026-11-09'; d < TODAY; d = addDay(d)) {
    figs[d] = { status: 'final', in: 0, out: 100 };
    sent.days[d] = { in: 0, out: 100, status: 'final' };
  }
  figs[TODAY] = { status: 'live', in: 0, out: 0 };
  figs['2026-11-13'].out = 200; // changed
  figs['2026-11-11'].out = 300; // changed
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-13', net: -200, final: true }, 'the latest changed day');
  figs['2026-11-09'].out = 400; // 7 days back: tonight is its last night in the window
  assert.equal(wrapModule.WRAP_DAYS_BACK, 7);
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-09', net: -400, final: true }, 'the one about to leave');
});

test('the revision clause: the day leaving the window outranks yesterday, whose change comes the next night', () => {
  // 11-09 (7 back) changed and leaves the window after tonight; yesterday (11-15) changed too
  const figs = { '2026-11-09': { status: 'final', in: 0, out: 9261 }, '2026-11-15': { status: 'provisional', in: 0, out: 2200 }, [TODAY]: { status: 'live', in: 0, out: 0 } };
  const sent = { days: { '2026-11-09': { in: 0, out: 10500, status: 'live' }, '2026-11-15': { in: 0, out: 0, status: 'live' } } };
  assert.deepEqual(revisionOf(TODAY, figs, sent), { day: '2026-11-09', net: -9261, final: true }, 'the leaving day, on its last night');
  // the next night 11-09 has left the window; the change of 11-15, now two back, is told
  const next = addDay(TODAY);
  const figs2 = { '2026-11-15': figs['2026-11-15'], [TODAY]: { status: 'provisional', in: 0, out: 0 }, [next]: { status: 'live', in: 0, out: 0 } };
  const sent2 = { days: { '2026-11-15': sent.days['2026-11-15'], [TODAY]: { in: 0, out: 0, status: 'live' } } };
  assert.deepEqual(revisionOf(next, figs2, sent2), { day: '2026-11-15', net: -2200, final: false }, 'yesterday’s change, a night later');
});

function addDay(ymd) {
  const at = new Date(ymd + 'T12:00:00Z');
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
