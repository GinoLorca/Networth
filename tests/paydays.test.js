/**
 * Paydays and pay, after round 7, as step 3 ships them (PAYDAYS.md (a) to (e) without its section 4, NOTES-3 "The split
 * (after round 9)"; ARCHITECTURE 3.11 and 6). A payday is f414276's: a day with a bank deposit linked to a pay stream,
 * and In and out is f414276's own, read on the pay set of PAYDAYS (b): which streams are pay (the app's say by half, the
 * payer's, and a catch-all key's own deposits by a majority of at least two), a Steady pay source's own paydays,
 * Windfalls' change, All earned as In and out less Windfalls, the window before beyond the queue, and a sharing round
 * that refreshes an earlier copy only when its pay changes. The payday band, the level, the stand-ins and new streams
 * are step 3b's (STEP-3B.md). Every payer, name and figure here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, gameDay } from '../js/model/dates.js';
import { defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { inAndOut } from '../js/model/flows.js';
import { makeLedger } from '../js/model/ledger.js';
import { merchantKeyOf } from '../js/model/corrections.js';
import { notPayKeys, seedFlows } from '../js/model/flowsection.js';
import {
  LEAVE, WINDFALL, depositQueue, editInlet, fileDeposit, fileQueueItem, makeInlet, moneyInBySource, payEnded, suggestions, acceptOffer,
} from '../js/model/inlets.js';
import { MIN, NOW, PAYROLL, TODAY, at, bankRecord, deviceOf, item, memory, refresh, reportIn, row, settle } from './helpers/inlets-fixture.mjs';

let ids = 0;
const nid = () => 'n' + (0x2000000000000 + (ids += 1)).toString(16).slice(-13);
const clone = (x) => JSON.parse(JSON.stringify(x));
const CASHOUT = 'VENMO CASHOUT PPD ID: 5264681992';
const BENEFITS = 'NYS DOL UI DD BENEFITS';
const txOf = (s, raw, day, account) => s.txs.find((tx) => tx.raw === raw && (!day || tx.day === day) && (!account || tx.accountId === account));
const payNames = (s, t = NOW) => makeLedger(s, t).payStreams().map((one) => one.name + '|' + one.accountId).sort();
const isPay = (s, tx, t = NOW) => makeLedger(s, t).payStreams().some((one) => one.id === tx.streamId);
const update = (d, fn, label = 'money in') => d.update((s) => fn(s), { undo: label });

/** A payroll of $2,100 every 14 days, the latest `latest` days ago, back `back` days. */
function payroll(s, { latest = 6, back = 300, cents = 210000, raw = PAYROLL, account } = {}) {
  for (let d = addDays(TODAY, -latest); d >= addDays(TODAY, -back); d = addDays(d, -14)) row(s, d, cents, raw, account ? { account } : {});
}

/** A weekly cash-out of $300 (a catch-all key), the latest yesterday. */
function cashouts(s, { back = 250, cents = 30000, account } = {}) {
  for (let d = addDays(TODAY, -1); d >= addDays(TODAY, -back); d = addDays(d, -7)) row(s, d, cents, CASHOUT, account ? { account } : {});
}

/** The queue's one-deposit items of a raw wording, newest first. */
const onesOf = (s, raw) => depositQueue(s, NOW).items.filter((x) => x.kind === 'one' && txOf(s, raw) && s.txs.find((tx) => tx.id === x.txId).raw === raw)
  .sort((a, b) => (a.last < b.last ? 1 : -1));

/* ------------------------------------------------------------------ which streams are pay (PAYDAYS (b)) */

test('pay (b): a catch-all key\'s own deposits end its pay at the second of most filed away, and Undo puts it back; one filing never does', () => {
  const s = bankRecord();
  payroll(s);
  cashouts(s);
  refresh(s, NOW);
  const d = deviceOf(s, () => NOW);
  const cash = () => txOf(d.state, CASHOUT);
  assert.ok(isPay(d.state, cash()), 'the cash-out is read as pay');
  const job = nid();
  update(d, (st) => makeInlet(st, { name: 'Coaching', kind: 'job' }, NOW, job));
  const [first, second] = onesOf(d.state, CASHOUT);
  update(d, (st) => fileQueueItem(st, first, job, NOW + MIN));
  assert.ok(isPay(d.state, cash()), 'one filed away: still pay');
  const before = clone(makeLedger(d.state, NOW).payStreams());
  update(d, (st) => fileQueueItem(st, second, job, NOW + 2 * MIN));
  assert.ok(!isPay(d.state, cash()), 'two agreeing: no pay');
  assert.ok(notPayKeys(d.state).has(merchantKeyOf(cash().mkey) + '|acc_chk'), 'the stream\'s key and account');
  assert.ok(payEnded(before, d.state, NOW).includes(before.find((x) => x.id === cash().streamId).name), 'the toast names it');
  assert.ok(d.undo(), 'Undo');
  assert.ok(isPay(d.state, cash()), 'Undo restores its pay');
});

test('pay (b): filings split over two By the job sources end it; two to Steady pay keep it; Leave it never counts; a filing to Windfalls counts as away', () => {
  const make = () => { const s = bankRecord(); payroll(s); cashouts(s); refresh(s, NOW); return s; };
  {
    const s = make();
    const a = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    const b = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    const [one, two] = onesOf(s, CASHOUT);
    assert.ok(fileQueueItem(s, one, a, NOW + MIN));
    assert.ok(fileQueueItem(s, two, b, NOW + 2 * MIN));
    assert.ok(!isPay(s, txOf(s, CASHOUT)), 'split over two By the job sources: no pay');
  }
  {
    const s = make();
    const a = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
    const [one, two, three] = onesOf(s, CASHOUT);
    assert.ok(fileQueueItem(s, one, a, NOW + MIN));
    assert.ok(fileQueueItem(s, two, a, NOW + 2 * MIN));
    assert.ok(isPay(s, txOf(s, CASHOUT)), 'two to Steady pay: pay');
    assert.ok(fileQueueItem(s, three, WINDFALL, NOW + 3 * MIN));
    assert.ok(isPay(s, txOf(s, CASHOUT)), '1 away of 3: pay');
  }
  {
    const s = make();
    const a = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    const list = onesOf(s, CASHOUT);
    assert.ok(fileQueueItem(s, list[0], a, NOW + MIN));
    for (let k = 1; k < 6; k++) assert.ok(fileQueueItem(s, list[k], LEAVE, NOW + (k + 1) * MIN));
    assert.ok(isPay(s, txOf(s, CASHOUT)), 'one away and five left: still pay');
    assert.ok(fileQueueItem(s, list[6], WINDFALL, NOW + 9 * MIN));
    assert.ok(!isPay(s, txOf(s, CASHOUT)), 'a second away (to Windfalls): no pay');
  }
});

test('pay (b): a payer filed to Steady pay holds its stream whatever its own deposits say; another account\'s stream on the same key keeps its pay; an accrue lock wins', () => {
  {
    const s = bankRecord();
    payroll(s);
    cashouts(s);
    refresh(s, NOW);
    const steady = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
    const job = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    assert.ok(fileDeposit(s, txOf(s, CASHOUT).id, steady, 'all', NOW + MIN), 'All from this payer to Steady pay');
    const three = s.txs.filter((tx) => tx.raw === CASHOUT).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 3);
    three.forEach((tx, k) => assert.ok(fileDeposit(s, tx.id, job, 'one', NOW + (2 + k) * MIN)));
    assert.ok(isPay(s, txOf(s, CASHOUT)), 'the payer\'s say wins: 3 filed away, still pay');
  }
  {
    const s = bankRecord();
    payroll(s);
    cashouts(s);
    cashouts(s, { account: 'acc_sav', cents: 25000 });
    refresh(s, NOW);
    const checking = txOf(s, CASHOUT, null, 'acc_chk');
    const savings = txOf(s, CASHOUT, null, 'acc_sav');
    assert.notEqual(checking.streamId, savings.streamId, 'two streams, one an account');
    assert.ok(isPay(s, checking) && isPay(s, savings));
    const job = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    const two = s.txs.filter((tx) => tx.raw === CASHOUT && tx.accountId === 'acc_chk').sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 2);
    two.forEach((tx, k) => assert.ok(fileDeposit(s, tx.id, job, 'one', NOW + (1 + k) * MIN)));
    assert.ok(!isPay(s, checking), 'checking\'s cash-outs filed away: no pay');
    assert.ok(isPay(s, savings), 'savings\' stream on the same key: still pay');
  }
  {
    const s = bankRecord();
    payroll(s);
    cashouts(s);
    refresh(s, NOW);
    const stream = s.streams.find((one) => one.id === txOf(s, CASHOUT).streamId);
    stream.locks = [...(stream.locks || []), 'accrue'];
    stream.accrue = true;
    const job = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    const [one, two] = onesOf(s, CASHOUT);
    assert.ok(fileQueueItem(s, one, job, NOW + MIN));
    assert.ok(fileQueueItem(s, two, job, NOW + 2 * MIN));
    assert.ok(isPay(s, txOf(s, CASHOUT)), 'accrual locked on by hand: still pay');
  }
});

test('pay (b): own filings on a named payer\'s key never end its pay: a bonus and a correction of an unfiled payroll filed away', () => {
  const s = bankRecord();
  payroll(s);
  // the correction older than the newest 13 deposits: two odd ones among them end the stream on f414276's detection, which
  // step 3 keeps (P9, STEP-3B.md)
  row(s, addDays(TODAY, -10), 500000, PAYROLL);
  row(s, addDays(TODAY, -205), 15000, PAYROLL);
  refresh(s, NOW);
  assert.ok(isPay(s, txOf(s, PAYROLL)), 'pay before any filing');
  const prize = makeInlet(s, { name: 'Bonus', kind: 'oneoff' }, NOW, nid());
  assert.ok(fileDeposit(s, txOf(s, PAYROLL, addDays(TODAY, -10)).id, prize, 'one', NOW + MIN));
  assert.ok(fileDeposit(s, txOf(s, PAYROLL, addDays(TODAY, -205)).id, WINDFALL, 'one', NOW + 2 * MIN));
  assert.ok(isPay(s, txOf(s, PAYROLL)), 'still pay');
  assert.equal(notPayKeys(s).size, 0, 'nothing is no pay');
});

test('pay (b): the reporting app\'s say needs at least half of the payer\'s deposits paired: one payroll deposit paired by chance keeps the payroll pay', () => {
  const s = bankRecord();
  payroll(s, { back: 170 });
  refresh(s, NOW);
  // the app reports one payment of the payroll's very cents on a payday: matching pairs that deposit with it
  const day = addDays(TODAY, -20);
  reportIn(s, [item('one-1', 'p-lark', 210000, day)], NOW);
  refresh(s, NOW);
  const pairs = Object.values(s.income.pairs || {});
  assert.ok(pairs.includes(txOf(s, PAYROLL, day).id), 'one payroll deposit is paired with the app');
  const app = suggestions(s, NOW).shown.find((one) => one.key[0] === 'r');
  assert.ok(app, 'the app is suggested');
  assert.ok(acceptOffer(s, app, NOW + MIN, nid()), 'the app filed to By the job');
  assert.ok(isPay(s, txOf(s, PAYROLL), NOW + 2 * MIN), '1 of 13 paired: the payroll is still pay');
});

test('pay (b): two devices of different depth agree, reading the deposits on or after the shared floor', async () => {
  const make = (back) => { const s = bankRecord(); payroll(s, { back }); cashouts(s, { back }); refresh(s, NOW); return s; };
  const a = deviceOf(make(300), () => NOW);
  const b = deviceOf(make(100), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  const job = nid();
  update(a, (st) => makeInlet(st, { name: 'Coaching', kind: 'job' }, NOW + 2 * MIN, job));
  // one deposit before the shared floor (B's first day), filed from its sheet on A: it is no say
  const old = a.state.txs.filter((tx) => tx.raw === CASHOUT && tx.day < addDays(TODAY, -100)).sort((x, y) => (x.day < y.day ? 1 : -1))[0];
  update(a, (st) => fileDeposit(st, old.id, job, 'one', NOW + 3 * MIN));
  const recent = a.state.txs.filter((tx) => tx.raw === CASHOUT).sort((x, y) => (x.day < y.day ? 1 : -1));
  update(a, (st) => fileDeposit(st, recent[0].id, job, 'one', NOW + 4 * MIN));
  await settle([a, b], repo);
  assert.deepEqual(payNames(a.state), payNames(b.state), 'one before the floor and one after: the same pay on both');
  assert.ok(payNames(a.state).some((x) => /Venmo/i.test(x)), 'still pay: one say since the floor');
  update(a, (st) => fileDeposit(st, recent[1].id, job, 'one', NOW + 5 * MIN));
  await settle([a, b], repo);
  assert.deepEqual(payNames(a.state, NOW + 10 * MIN), payNames(b.state, NOW + 10 * MIN), 'two since the floor: the same pay on both');
  assert.ok(!payNames(b.state, NOW + 10 * MIN).some((x) => /Venmo/i.test(x)), 'no pay on either');
});

/* ------------------------------------------------------------------ the section (PAYDAYS (d), (e)) */

test('the section: Windfalls compares the paydays of benefits a built-in rule files there; All earned is In and out less Windfalls\' change', () => {
  const s = bankRecord();
  payroll(s);
  for (let d = addDays(TODAY, -2); d >= addDays(TODAY, -300); d = addDays(d, -14)) row(s, d, 45000, BENEFITS);
  refresh(s, NOW);
  const ben = txOf(s, BENEFITS);
  assert.ok(isPay(s, ben), 'detection reads the benefits as pay');
  assert.equal(ben.ruleId, 'builtin:benefits', 'a built-in rule files them to Windfalls');
  for (const days of [30, 90]) {
    const io = inAndOut(s, NOW, days);
    const sec = moneyInBySource(s, NOW, days);
    const one = io.paydays.streams.find((x) => x.id === ben.streamId);
    const money = sec.windfalls.cents - sec.windfalls.before;
    assert.equal(sec.windfalls.change, money - one.left, days + ': Windfalls\' change leaves out its paydays\' difference');
    if (days === 30) assert.deepEqual([one.now, one.before, sec.windfalls.change], [2, 3, 0], '30 days: 2 benefits against 3, Windfalls ±$0');
    assert.equal(sec.earned.change, io.in.change - sec.windfalls.change, days + ': All earned = In and out - Windfalls');
  }
});

test('the section: beyond the queue (365 days), a source holding only deposits filed one at a time reads "—", one holding others too compares those and says so; 30 and 90 days compare deposit for deposit', () => {
  // 2.5 years of a payroll and a cash-out every 14 days on a fixed cycle (the same $6,240 each year), the queue's
  // cash-outs filed to Clients (By the job) one tap each, the payroll to Day job (round 7 review's record)
  const START = at(2024, 5, 1, 9);
  const s = defaultState(START);
  s.meta.origin = 'bank';
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'ext-chk-1', conn: 'c1' } }));
  let seq = 0;
  const put = (day, cents, raw) => { seq += 1; s.txs.push(makeTx({ id: 'tx_y' + seq, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', raw, fp: 'acc_chk|' + day + '|' + cents + '|' + raw.toLowerCase() + '|0', ext: { id: 'ext-y' + seq }, loggedAt: START })); };
  const cycle = [18000, 30000, 24000, 21000, 27000, 19500, 28500];
  let k = 0;
  for (let d = addDays(gameDay(START, 4), 3); d <= TODAY; d = addDays(d, 14)) put(d, 245000, PAYROLL);
  for (let d = addDays(gameDay(START, 4), 6); d <= TODAY; d = addDays(d, 14)) put(d, cycle[k++ % cycle.length], 'VENMO CASHOUT');
  refresh(s, NOW);
  seedFlows(s, NOW);
  const pay = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  const clients = makeInlet(s, { name: 'Clients', kind: 'job' }, NOW, nid());
  for (let taps = 0; taps < 100; taps++) { const it = depositQueue(s, NOW).items[0]; if (!it) break; assert.ok(fileQueueItem(s, it, it.kind === 'payer' ? pay : clients, NOW)); }
  // the same record with a Zelle client of $200 every 28 days, filed to Clients with its payer
  const t = clone(s);
  const ZELLE = 'Zelle payment from TAMSIN OKORO 55120';
  for (let d = addDays(gameDay(START, 4), 9); d <= TODAY; d = addDays(d, 28)) { seq += 1; t.txs.push(makeTx({ id: 'tx_z' + seq, source: 'bank', accountId: 'acc_chk', day: d, postedDay: d, amount: 20000, flow: 'in', raw: ZELLE, fp: 'acc_chk|' + d + '|20000|' + ZELLE.toLowerCase() + '|0', ext: { id: 'ext-z' + seq }, loggedAt: START })); }
  refresh(t, NOW);
  assert.ok(fileDeposit(t, txOf(t, ZELLE).id, clients, 'all', NOW + MIN), 'the Zelle client with its payer');
  {
    const sec = moneyInBySource(t, NOW, 365);
    const r = sec.rows.find((x) => x.id === clients);
    const w = sec.window;
    const zelle = (from, to) => t.txs.filter((tx) => tx.raw === ZELLE && tx.day >= from && tx.day <= to).reduce((n, tx) => n + tx.amount, 0);
    assert.equal(r.oneAtATime, false, '365 days: compared');
    assert.equal(r.change, zelle(w.from, w.to) - zelle(w.prevFrom, w.prevTo), '365 days: the Zelle client, year against year');
    assert.ok(r.leftOneAtATime > 0, '365 days: the cash-outs filed one at a time are left out, and counted');
    for (const days of [30, 90]) assert.equal(moneyInBySource(t, NOW, days).rows.find((x) => x.id === clients).leftOneAtATime, 0, days + ': nothing left out');
  }
  assert.ok(!makeLedger(s, NOW).payStreams().some((x) => /venmo/i.test(x.name)), 'the cash-out filed away one at a time is no pay');
  const year = moneyInBySource(s, NOW, 365);
  const row365 = year.rows.find((r) => r.id === clients);
  assert.ok(row365.cents > 0, 'its money in the year');
  assert.equal(row365.change, null, '365 days: no change');
  assert.equal(row365.oneAtATime, true, '365 days: filed one at a time');
  assert.equal(year.rows.find((r) => r.id === pay).change, 0, '365 days: Day job, filed by its payer, compares');
  assert.equal(year.earned.change, inAndOut(s, NOW, 365).in.change - year.windfalls.change, '365 days: All earned keeps its change');
  assert.equal(inAndOut(s, NOW, 365).in.change, 0, '365 days: In and out, the cash-out\'s years alike');
  for (const days of [30, 90]) {
    const sec = moneyInBySource(s, NOW, days);
    const r = sec.rows.find((x) => x.id === clients);
    assert.equal(r.oneAtATime, false, days + ': compared');
    assert.equal(r.leftOneAtATime, 0, days + ': nothing left out');
    assert.equal(r.change, r.cents - r.before, days + ': deposit for deposit');
  }
});

/* ------------------------------------------------------------------ a sharing round (F6) */

test('a sharing round refreshes an earlier copy only when what arrived changes its pay: not for a deposit\'s filing, Leave it, a name or a goal; yes for a payer filed to By the job or a source\'s kind', async () => {
  // a mark detection would rewrite (a detected stream's confidence), set in the copy Undo keeps: still there after the
  // round means no run of detection there
  const round = async (act, extra) => {
    const make = () => { const s = bankRecord(); payroll(s); cashouts(s); if (extra) extra(s); refresh(s, NOW); return s; };
    const a = deviceOf(make(), () => NOW);
    const b = deviceOf(make(), () => NOW + MIN);
    const repo = memory();
    await settle([a, b], repo);
    const shared = nid();
    update(b, (st) => makeInlet(st, { name: 'Coaching', kind: 'job' }, NOW + 2 * MIN, shared));
    await settle([a, b], repo);
    for (const stream of a.state.streams) stream.confidence = 0.01;
    update(a, (st) => { st.settings.rolloverHour = st.settings.rolloverHour; }, 'a copy');
    for (const stream of a.state.streams) stream.confidence = 0.02;
    update(b, (st) => assert.ok(act(st, shared)));
    await b.round(repo);
    await a.round(repo);
    assert.deepEqual(notPayKeys(a.state), notPayKeys(b.state), 'the filing arrived');
    assert.ok(a.undo(), 'back to the copy');
    return a.state.streams.some((stream) => stream.confidence === 0.01);
  };
  const one = (st) => onesOf(st, CASHOUT)[0];
  assert.equal(await round((st, id) => fileQueueItem(st, one(st), id, NOW + 3 * MIN)), true, 'a deposit filed on its own (no pay changes): no run');
  assert.equal(await round((st) => fileQueueItem(st, one(st), LEAVE, NOW + 3 * MIN)), true, 'Leave it: no run');
  assert.equal(await round((st, id) => editInlet(st, id, { name: 'Sitters' }, NOW + 3 * MIN)), true, 'a name: no run');
  assert.equal(await round((st, id) => editInlet(st, id, { goal: { per: 'month', cents: 50000 } }, NOW + 3 * MIN)), true, 'a goal: no run');
  assert.equal(await round((st, id) => fileQueueItem(st, { intoKey: merchantKeyOf(txOf(st, PAYROLL).mkey) }, id, NOW + 3 * MIN)), false, 'the payroll filed to By the job: a run');
  assert.equal(await round((st, id) => {
    assert.ok(fileQueueItem(st, { intoKey: merchantKeyOf(txOf(st, PAYROLL).mkey) }, makeInlet(st, { name: 'Day job', kind: 'steady' }, NOW + 3 * MIN, nid()), NOW + 4 * MIN));
    return true;
  }), true, 'the payroll filed to Steady pay changes no pay: no run');
  assert.equal(await round((st, id) => {
    const [x, y] = onesOf(st, CASHOUT);
    return fileQueueItem(st, x, id, NOW + 3 * MIN) && fileQueueItem(st, y, id, NOW + 4 * MIN);
  }), false, 'two cash-outs filed away end its pay: a run');
  // round 11: a Zelle sender with no cadence (never pay) filed to By the job adds its key, and changes no pay: no run
  const WREN = 'Zelle payment from WREN ATTLEE 66120';
  assert.equal(await round((st, id) => {
    const sender = depositQueue(st, NOW).items.find((x) => x.kind === 'payer' && st.txs.find((tx) => tx.id === x.txId).raw === WREN);
    return !!sender && fileQueueItem(st, sender, id, NOW + 3 * MIN);
  }, (s) => { for (const [ago, cents] of [[3, 12000], [11, 4500], [30, 30000], [52, 8000], [90, 15000]]) row(s, addDays(TODAY, -ago), cents, WREN); }), true, 'a sender who was never pay filed to By the job: no run');
});

/* ------------------------------------------------------------------ round 10: Windfalls beyond the queue */


test('round 10: beyond the queue (365 days), Windfalls leaves out the deposits filed to it one at a time, in both windows, so All earned reads no drop for money that came in both years (round 11: "—")', () => {
  // the round-7 review's year record (2.5 years, a payroll, a $180 to $300 cash-out every 14 days, $6,240 each year), every
  // queued cash-out tapped to Windfalls with the queue's chip, the payroll to Day job
  const START = at(2024, 5, 1, 9);
  const s = defaultState(START);
  s.meta.origin = 'bank';
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'ext-chk-1', conn: 'c1' } }));
  let seq = 0;
  const put = (day, cents, raw) => { seq += 1; s.txs.push(makeTx({ id: 'tx_w' + seq, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', raw, fp: 'acc_chk|' + day + '|' + cents + '|' + raw.toLowerCase() + '|0', ext: { id: 'ext-w' + seq }, loggedAt: START })); };
  const cycle = [18000, 30000, 24000, 21000, 27000, 19500, 28500];
  let k = 0;
  for (let d = addDays(gameDay(START, 4), 3); d <= TODAY; d = addDays(d, 14)) put(d, 245000, PAYROLL);
  for (let d = addDays(gameDay(START, 4), 6); d <= TODAY; d = addDays(d, 14)) put(d, cycle[k++ % cycle.length], 'VENMO CASHOUT');
  refresh(s, NOW);
  seedFlows(s, NOW);
  const pay = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  let taps = 0;
  for (; taps < 100; taps++) { const it = depositQueue(s, NOW).items[0]; if (!it) break; assert.ok(fileQueueItem(s, it, it.kind === 'payer' ? pay : WINDFALL, NOW)); }
  assert.ok(taps > 20, 'the queue\'s cash-outs, one tap each');
  const io = inAndOut(s, NOW, 365);
  const year = moneyInBySource(s, NOW, 365, { io });
  assert.equal(io.in.change, 0, '365 days: In and out, the years alike');
  assert.ok(year.windfalls.cents > 0, '365 days: Windfalls holds the year\'s cash-outs');
  // round 11 (D6): Windfalls holds only deposits filed one at a time ("—"), and All earned has no reading of a year never
  // asked about ("—"), never the drop of round 8 nor the gift of round 9 read as earned growth
  assert.equal(year.windfalls.change, null, '365 days: Windfalls compares nothing filed one at a time: "—"');
  assert.ok(year.windfalls.oneAtATime, '365 days: Windfalls says why');
  assert.equal(year.earned.change, null, '365 days: All earned reads no drop: "—"');
  assert.ok(year.earned.oneAtATime, '365 days: All earned says why');
  // within the queue's reach nothing is left out: Windfalls compares its money, All earned is In and out less it
  for (const days of [30, 90]) {
    const io2 = inAndOut(s, NOW, days);
    const sec = moneyInBySource(s, NOW, days, { io: io2 });
    assert.equal(sec.windfalls.change, sec.windfalls.cents - sec.windfalls.before, days + ': Windfalls, money against money');
    assert.equal(sec.earned.change, io2.in.change - sec.windfalls.change, days + ': All earned');
  }
});

/* ------------------------------------------------------------------ round 11 */


test('round 11 (D6): beyond the queue (365 days), Windfalls holding deposits filed to it one at a time gives All earned no change ("—"): a gift and a refund cheque new this year, and the same cash-outs filed only this year', () => {
  const START = at(2024, 5, 1, 9);
  const s = defaultState(START);
  s.meta.origin = 'bank';
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'ext-chk-1', conn: 'c1' } }));
  let seq = 0;
  const put = (day, cents, raw) => { seq += 1; s.txs.push(makeTx({ id: 'tx_g' + seq, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: cents, flow: 'in', raw, fp: 'acc_chk|' + day + '|' + cents + '|' + raw.toLowerCase() + '|' + seq, ext: { id: 'ext-g' + seq }, loggedAt: START })); };
  for (let d = addDays(gameDay(START, 4), 3); d <= TODAY; d = addDays(d, 14)) put(d, 210000, PAYROLL);
  put(addDays(TODAY, -120), 150000, 'MOBILE CHECK DEPOSIT');
  put(addDays(TODAY, -60), 80000, 'MOBILE CHECK DEPOSIT');
  refresh(s, NOW);
  seedFlows(s, NOW);
  const pay = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  for (let taps = 0; taps < 10; taps++) { const it = depositQueue(s, NOW).items[0]; if (!it) break; assert.ok(fileQueueItem(s, it, it.kind === 'payer' ? pay : WINDFALL, NOW)); }
  const io = inAndOut(s, NOW, 365);
  const year = moneyInBySource(s, NOW, 365, { io });
  assert.equal(io.in.change, 230000, '365 days: In and out keeps its change (+$2,300)');
  assert.equal(year.windfalls.cents, 230000, 'Windfalls holds the two cheques');
  assert.equal(year.windfalls.change, null, 'Windfalls: nothing else to compare, "—"');
  assert.ok(year.windfalls.oneAtATime, 'Windfalls says why');
  assert.equal(year.earned.change, null, 'All earned: no reading of the year before\'s cheques, "—"');
  assert.ok(year.earned.oneAtATime, 'All earned says why');
  // within the queue's reach: compared, All earned ±$0 for its unchanged pay, Windfalls the cheques
  for (const days of [90, 180]) {
    const io2 = inAndOut(s, NOW, days);
    const sec = moneyInBySource(s, NOW, days, { io: io2 });
    if (sec.windfalls.change == null) continue;
    assert.equal(sec.earned.change, io2.in.change - sec.windfalls.change, days + ': All earned = In and out less Windfalls');
    assert.ok(!sec.earned.oneAtATime, days + ': compared');
  }
});

test('round 11: a benefit a built-in rule files to Windfalls, moved on its own to a source, reads as money moved: Windfalls lower, All earned higher, the source its money', () => {
  const s = bankRecord();
  payroll(s);
  for (let d = addDays(TODAY, -2); d >= addDays(TODAY, -300); d = addDays(d, -14)) row(s, d, 45000, BENEFITS);
  refresh(s, NOW);
  const ben = s.txs.filter((tx) => tx.raw === BENEFITS).sort((a, b) => (a.day < b.day ? 1 : -1))[0];
  assert.ok(isPay(s, ben), 'the benefits are read as pay');
  const odd = makeInlet(s, { name: 'Odd jobs', kind: 'job' }, NOW, nid());
  const before = Object.fromEntries([30, 90].map((days) => [days, moneyInBySource(s, NOW, days)]));
  assert.ok(fileDeposit(s, ben.id, odd, 'one', NOW + MIN), 'the newest benefit, This deposit only, to Odd jobs');
  for (const days of [30, 90]) {
    const io = inAndOut(s, NOW + MIN, days);
    const sec = moneyInBySource(s, NOW + MIN, days, { io });
    assert.equal(sec.windfalls.change, before[days].windfalls.change - 45000, days + ': Windfalls $450 lower');
    assert.equal(sec.earned.change, before[days].earned.change + 45000, days + ': All earned $450 higher');
    assert.equal(sec.rows.find((x) => x.id === odd).change, 45000, days + ': Odd jobs its money');
  }
});

test('round 11: a cheque of the pay that sets your payday (a payroll paid by cheque) opens "New source…" on Steady pay; a cash-out beside a payroll stays By the job', () => {
  const s = bankRecord();
  for (let d = addDays(TODAY, -6); d >= addDays(TODAY, -300); d = addDays(d, -14)) row(s, d, 200000, 'MOBILE CHECK DEPOSIT');
  refresh(s, NOW);
  const L = makeLedger(s, NOW);
  assert.equal(L.payMain(), txOf(s, 'MOBILE CHECK DEPOSIT').streamId, 'the cheques set the payday');
  const ones = depositQueue(s, NOW).items.filter((x) => x.kind === 'one');
  assert.ok(ones.length > 2 && ones.every((x) => x.newKind === 'steady'), 'every cheque item opens on Steady pay');
  // the payroll's cash-outs: By the job, as round 5
  const t = bankRecord();
  payroll(t);
  cashouts(t);
  refresh(t, NOW);
  const outs = onesOf(t, CASHOUT);
  assert.ok(outs.length > 2 && outs.every((x) => x.newKind === 'job'), 'cash-outs beside the payroll open on By the job');
});
