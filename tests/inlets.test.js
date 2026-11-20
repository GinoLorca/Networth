/**
 * Money in and out, pass 3: money in by source (model/inlets.js; DESIGN Appendix G; ARCHITECTURE 3.11). The counting
 * rule, paydays like with like, the filing precedence, the deposits to file, travel between two devices, suggested
 * sources, the pay fix, "It was money in", and older builds reading every cell this pass writes. Every payer, name and
 * figure here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { addDays, fmtDate, fmtMonth, gameDay } from '../js/model/dates.js';
import { say } from '../js/model/words.js';
import { INCOME_FORMAT, answerPayer, applyIncomeReading } from '../js/model/income.js';
import { inflow, inAndOut, moveQueue } from '../js/model/flows.js';
import { makeLedger } from '../js/model/ledger.js';
import { merchantKeyOf, restampCorrections } from '../js/model/corrections.js';
import { exportFlows, noteInlet, noteOffer, ownFirstDay, readFlows, restampFlows, storedFlows } from '../js/model/flowsection.js';
import { fileText, readSharedFile, roundShared } from '../js/model/share.js';
import {
  INLET_KINDS, LEAVE, WINDFALL, acceptOffer, appKey, appNameOf, attribute, canUnfile, depositQueue, dismissOffer, editInlet, figOne, fileDeposit, fileQueueItem, fileToNew,
  filingOf, goalCents, inletName, inletsOf, isWalletRefund, leftEarlier, lookOf, makeInlet, moneyInBySource, moneyInMove, payEnded, payEndedStreams, paymentKey, restoreOffer,
  suggestions,
} from '../js/model/inlets.js';
import {
  CHEQUE, INTEREST, MIN, NOW, PAYROLL, TODAY, ZELLE_A, ZELLE_B, bankRecord, deviceOf, every, item, memory, refresh, reportIn, row, settle,
} from './helpers/inlets-fixture.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
let ids = 0;
const nid = () => 'n' + (0x1000000000000 + (ids += 1)).toString(16).slice(-13);

/** The record most tests start from: biweekly pay, a Zelle client, two cheques, savings interest. */
function base(opts = {}) {
  const s = bankRecord();
  // paid every second week, the latest yesterday: two records of different depth hold the same paydays
  const from = opts.from || addDays(TODAY, -180);
  for (let d = addDays(TODAY, -1); d >= from; d = addDays(d, -14)) row(s, d, 210000, PAYROLL);
  row(s, addDays(TODAY, -50), 12000, ZELLE_A);
  row(s, addDays(TODAY, -20), 15000, ZELLE_A);
  row(s, addDays(TODAY, -40), 30000, CHEQUE);
  row(s, addDays(TODAY, -10), 40000, CHEQUE);
  row(s, addDays(TODAY, -15), 12, INTEREST, { account: 'acc_sav' });
  refresh(s, NOW);
  return s;
}

const txOf = (s, raw, day) => s.txs.find((tx) => tx.raw === raw && (!day || tx.day === day));
const filed = (s, tx) => filingOf(lookOf(s), s.txs.find((one) => one.id === tx.id) || tx);
const queueKeys = (s, now = NOW) => depositQueue(s, now).items.map((one) => one.key + ':' + one.count + ':' + one.amount).sort();
const update = (d, fn, label = 'money in') => d.update((s) => fn(s), { undo: label });
/** A dismissal written at a given stamp (another suggestion's Not now, in the same millisecond). */
const noteOfferAt = (s, key, at) => assert.ok(noteOffer(s, key, false, at, at));

/* ------------------------------------------------------------------ counting */

test('counting: a bank deposit, a cash payment and a pencil payment count; a matched payment counts once, filed by its reported key', () => {
  const s = base();
  // Lark pays by transfer (the bank shows it a day after the sitting), Rook in cash, and Lark's latest is not at the bank yet;
  // Lark is a regular of the app (round 9, F2: an earlier deposit pairs too, so the app files Lark's deposits)
  row(s, addDays(TODAY, -5), 9000, 'Zelle payment from LARK FENN 5512');
  row(s, addDays(TODAY, -40), 9000, 'Zelle payment from LARK FENN 5512');
  refresh(s, NOW);
  reportIn(s, [item('a0', 'p-lark', 9000, addDays(TODAY, -41)), item('a1', 'p-lark', 9000, addDays(TODAY, -6)), item('a2', 'p-rook', 7000, addDays(TODAY, -4)), item('a3', 'p-lark', 6000, addDays(TODAY, -1))]);
  answerPayer(s, 'sessions', 'p-rook', 'cash', NOW);
  refresh(s, NOW);
  const found = inflow(s, addDays(TODAY, -29), TODAY, NOW);
  const lark = found.rows.filter(({ tx }) => tx.amount === 9000);
  assert.equal(lark.length, 1, 'the matched payment counts once');
  assert.equal(lark[0].how, 'bank', 'as its bank deposit');
  assert.ok(found.rows.some(({ tx, how }) => tx.amount === 7000 && how === 'cash'), 'the cash payment');
  assert.ok(found.rows.some(({ tx, how }) => tx.amount === 6000 && how === 'pencil'), 'the pencil payment');
  // the payer of the bank deposit is filed to one source, the reporting app to another: the reported key wins
  const s1 = makeInlet(s, { name: 'Portraits', kind: 'job' }, NOW, nid());
  const s2 = makeInlet(s, { name: 'Zelle clients', kind: 'job' }, NOW, nid());
  const bank = lark[0].tx;
  fileDeposit(s, bank.id, s2, 'all', NOW + MIN); // all from this payer: here, the app (the row carries reported payments)
  const look = lookOf(s);
  assert.equal(filingOf(look, bank).to, s2);
  assert.equal(filingOf(look, bank).how, 'app', 'a deposit paired with reported payments files by its app');
  const section = moneyInBySource(s, NOW, 30);
  const portraits = section.rows.find((one) => one.id === s2);
  assert.equal(portraits.cents, 9000 + 7000 + 6000);
  assert.equal(portraits.cash, 7000);
  assert.equal(portraits.pencil, 6000);
  assert.ok(portraits.est, 'pencil money makes it an estimate');
  assert.deepEqual(portraits.sessions, { n: 3, per: Math.round(22000 / 3) }, 'money per session, as reported');
  assert.equal(section.rows.find((one) => one.id === s1), undefined, 'a source with no money on record is a prospect');
  assert.ok(section.prospects.some((one) => one.id === s1));
});

test('counting: a refund, a transfer and a card credit are never money in; Windfalls sit outside the shares', () => {
  const s = base();
  row(s, addDays(TODAY, -30), -5000, 'VENMO PAYMENT 1234');
  row(s, addDays(TODAY, -29), 5000, 'VENMO PAYMENT 1235');
  row(s, addDays(TODAY, -12), 30000, 'TRANSFER FROM SAVINGS XXXX1');
  row(s, addDays(TODAY, -12), 2500, 'CASH BACK REWARD CREDIT', { account: 'acc_card' });
  row(s, addDays(TODAY, -14), -2500, 'GREENLEAF GROCER #12', { account: 'acc_card' });
  row(s, addDays(TODAY, -13), 2500, 'GREENLEAF GROCER #12 RETURN', { account: 'acc_card' });
  refresh(s, NOW);
  const found = inflow(s, addDays(TODAY, -29), TODAY, NOW);
  for (const raw of ['VENMO PAYMENT 1235', 'TRANSFER FROM SAVINGS XXXX1', 'CASH BACK REWARD CREDIT', 'GREENLEAF GROCER #12 RETURN']) {
    assert.ok(!found.rows.some(({ tx }) => tx.raw === raw), raw + ' is no money in');
  }
  const section = moneyInBySource(s, NOW, 30);
  assert.equal(section.windfalls.cents, 12, 'interest is a Windfall by itself');
  assert.deepEqual(section.windfalls.what, ['interest']);
  const shares = section.rows.reduce((n, one) => n + one.share, section.unfiled.share);
  assert.ok(Math.abs(shares - 1) < 1e-9, 'the shares add up to what was earned, Windfalls outside');
  assert.equal(section.earned.cents, found.total - 12);
});

/* ------------------------------------------------------------------ paydays */

test('paydays like with like at 30, 90 and 365 days, with paydays on the windows\' edges', () => {
  for (const days of [30, 90, 365]) {
    // a payday on the period's first day, and (a day later) a payday on the last day of the window before
    for (const shift of [0, 1]) {
      const s = bankRecord();
      const first = addDays(TODAY, -(days - 1) - shift);
      const paydays = [];
      for (let d = first; d <= TODAY; d = addDays(d, 14)) paydays.push(d);
      for (let d = addDays(first, -14); d >= addDays(TODAY, -(2 * days + 20)); d = addDays(d, -14)) paydays.unshift(d);
      for (const d of paydays) row(s, d, 210000, PAYROLL);
      refresh(s, NOW);
      const pay = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
      fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, pay, NOW + MIN);
      const section = moneyInBySource(s, NOW, days);
      const one = section.rows.find((r) => r.id === pay);
      const from = addDays(TODAY, -(days - 1));
      const now = paydays.filter((d) => d >= from).length;
      const before = paydays.filter((d) => d < from && d >= addDays(from, -days)).length;
      assert.ok(section.window.comparable, days + ' days comparable');
      assert.equal(one.paydays.now, now, days + '/' + shift + ' paydays now');
      assert.equal(one.paydays.before, before, days + '/' + shift + ' paydays before');
      assert.equal(one.change, 0, days + '/' + shift + ': the extra payday is left out');
      assert.equal(section.earned.change, 0);
      // In and out leaves it out the same way, by the pay stream (it reads no filing: PAYDAYS (c))
      const io = inAndOut(s, NOW, days);
      assert.equal(io.in.change, 0, days + '/' + shift + ' in and out');
      const stream = txOf(s, PAYROLL).streamId;
      if (now !== before) assert.ok(io.paydays.streams.some((st) => st.id === stream && st.extra === now - before));
      // unfiled, the pay stream's paydays are compared the same way, in All earned and in In and out
      const t = bankRecord();
      for (const d of paydays) row(t, d, 210000, PAYROLL);
      refresh(t, NOW);
      assert.equal(moneyInBySource(t, NOW, days).earned.change, 0, days + '/' + shift + ' unfiled: All earned');
      assert.equal(inAndOut(t, NOW, days).in.change, 0, days + '/' + shift + ' unfiled: In and out');
    }
  }
});

/* ------------------------------------------------------------------ filing */

test('filing: the precedence of G.3, Leave it last, a removed source decides nothing', () => {
  const s = base();
  row(s, addDays(TODAY, -5), 9000, 'Zelle payment from LARK FENN 5512');
  row(s, addDays(TODAY, -40), 9000, 'Zelle payment from LARK FENN 5512'); // a regular of the app (round 9, F2)
  refresh(s, NOW);
  reportIn(s, [item('a0', 'p-lark', 9000, addDays(TODAY, -41)), item('a1', 'p-lark', 9000, addDays(TODAY, -6))]);
  refresh(s, NOW);
  const dep = txOf(s, 'Zelle payment from LARK FENN 5512');
  const [x, y, z, w] = [nid(), nid(), nid(), nid()];
  for (const [id, name] of [[x, 'X'], [y, 'Y'], [z, 'Z'], [w, 'W']]) makeInlet(s, { name, kind: 'job' }, NOW, id);
  assert.equal(filed(s, dep).to, null, 'nothing files it');
  // 5. Leave it on the deposit
  fileDeposit(s, dep.id, LEAVE, 'one', NOW + 1 * MIN);
  assert.deepEqual([filed(s, dep).to, filed(s, dep).left], [null, true]);
  // 3. its payer beats Leave it
  const look0 = lookOf(s);
  const keys = filingOf(look0, dep).keys;
  fileQueueItem(s, { intoKey: keys.payer }, x, NOW + 2 * MIN);
  assert.deepEqual([filed(s, dep).to, filed(s, dep).how], [x, 'payer']);
  // 2. its reporting app beats its payer
  fileQueueItem(s, { intoKey: appKey('sessions') }, y, NOW + 3 * MIN);
  assert.deepEqual([filed(s, dep).to, filed(s, dep).how], [y, 'app']);
  // 1. the reported payment's own key beats the app; the deposit's own key, later, beats that
  const reported = s.txs.find((tx) => tx.via === 'income' && tx.matchId === dep.id);
  fileDeposit(s, reported.id, z, 'one', NOW + 4 * MIN);
  assert.deepEqual([filed(s, dep).to, filed(s, dep).how], [z, 'deposit']);
  fileDeposit(s, dep.id, w, 'one', NOW + 5 * MIN);
  assert.equal(filed(s, dep).to, w, 'the later stamp among the deposit\'s own keys');
  fileDeposit(s, reported.id, x, 'one', NOW + 6 * MIN);
  assert.equal(filed(s, dep).to, x, 'and back, in the other order');
  // a filing to a removed source decides nothing: the next rank speaks
  editInlet(s, x, { removed: true }, NOW + 7 * MIN);
  assert.equal(filed(s, dep).to, w);
  // 4. a built-in Windfalls rule, below a payer filing
  const interest = txOf(s, INTEREST);
  assert.deepEqual([filed(s, interest).to, filed(s, interest).how], [WINDFALL, 'rule']);
  fileQueueItem(s, { intoKey: filingOf(lookOf(s), interest).keys.payer }, y, NOW + 8 * MIN);
  assert.deepEqual([filed(s, interest).to, filed(s, interest).how], [y, 'payer']);
});

test('filing: Leave it, then a payer filing, on both devices: the deposits that were left are filed', async () => {
  const a = deviceOf(base(), () => NOW);
  const b = deviceOf(base(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  const zelle = depositQueue(a.state, NOW).items.find((one) => one.zelle);
  update(a, (s) => fileQueueItem(s, zelle, LEAVE, a.clock()), 'left');
  const cells = storedFlows(a.state).into;
  // round 9 (F1): one mark on the payer's key, read up to the day of its stamp; round 2 wrote one per deposit
  assert.equal(Object.keys(cells).filter((k) => k[0] === 'i' && cells[k].v === LEAVE).length, 0, 'no mark under a deposit\'s own key');
  assert.equal(cells[zelle.intoKey].v, LEAVE, 'one mark on the payer\'s key');
  await settle([a, b], repo);
  for (const d of [a, b]) {
    assert.ok(!depositQueue(d.state, NOW).items.some((one) => one.key === zelle.key), 'out of the queue on both');
    assert.deepEqual([filed(d.state, txOf(d.state, ZELLE_A)).to, filed(d.state, txOf(d.state, ZELLE_A)).left], [null, true], 'still Not yet filed');
  }
  // a later deposit from the sender is asked about (the mark reaches the days up to its own)
  for (const d of [a, b]) {
    const later = deviceOf(clone(d.state), d.clock);
    row(later.state, addDays(TODAY, 1), 13000, ZELLE_A);
    refresh(later.state, NOW + 2 * 86400000);
    const item0 = depositQueue(later.state, NOW + 2 * 86400000).items.find((one) => one.key === zelle.key);
    assert.deepEqual(item0 && [item0.count, item0.amount], [1, 13000], 'only the deposit dated after the tap');
  }
  // B files the payer from a deposit's sheet ("All from this payer"): it reaches the deposits that were left
  b.clock = () => NOW + 2 * MIN;
  const id = nid();
  update(b, (s) => makeInlet(s, { name: 'Photo shoots', kind: 'job' }, b.clock(), id), 'made');
  update(b, (s) => fileDeposit(s, txOf(s, ZELLE_A).id, id, 'all', b.clock()), 'payer');
  await settle([a, b], repo);
  for (const d of [a, b]) {
    for (const tx of d.state.txs.filter((one) => one.raw === ZELLE_A)) assert.equal(filed(d.state, tx).to, id, 'filed on both');
  }
});

test('filing: catch-alls one deposit at a time; Zelle files the sender, later deposits too; the first chip after 2', () => {
  const s = base();
  const q0 = depositQueue(s, NOW);
  const cheques = q0.items.filter((one) => one.kind === 'one');
  assert.equal(cheques.length, 2, 'each cheque is an item of its own');
  const zelle = q0.items.find((one) => one.key === 'payer:' + merchantKeyOf(txOf(s, ZELLE_A).mkey));
  assert.equal(zelle.count, 2, 'one item for the sender');
  assert.ok(zelle.zelle);
  const photo = makeInlet(s, { name: 'Photo shoots', kind: 'job' }, NOW, nid());
  const other = makeInlet(s, { name: 'Print sales', kind: 'backend' }, NOW, nid());
  fileQueueItem(s, zelle, photo, NOW + MIN);
  row(s, addDays(TODAY, -2), 11000, ZELLE_A);
  refresh(s, NOW);
  assert.equal(filed(s, txOf(s, ZELLE_A, addDays(TODAY, -2))).to, photo, 'a later deposit of the sender is filed');
  // the cheques: the first to Photo shoots; the second offers no guess yet (one filed)
  fileQueueItem(s, cheques.find((one) => one.last === addDays(TODAY, -40)), photo, NOW + 2 * MIN);
  const q1 = depositQueue(s, NOW);
  assert.equal(q1.items.filter((one) => one.kind === 'one').length, 1, 'filing one cheque leaves the other');
  assert.equal(q1.items.find((one) => one.kind === 'one').guess, null, 'one filed cheque is no guess');
  fileQueueItem(s, q1.items.find((one) => one.kind === 'one'), photo, NOW + 3 * MIN);
  row(s, addDays(TODAY, -1), 25000, CHEQUE);
  refresh(s, NOW);
  const q2 = depositQueue(s, NOW);
  const third = q2.items.find((one) => one.kind === 'one');
  assert.equal(third.guess, photo, 'the last 2 cheques went to one source: the first chip is a guess');
  assert.equal(third.sources[0], photo);
  // the last two to two sources: no guess
  fileDeposit(s, txOf(s, CHEQUE, addDays(TODAY, -10)).id, other, 'one', NOW + 4 * MIN);
  assert.equal(depositQueue(s, NOW).items.find((one) => one.kind === 'one').guess, null);
});

test('filing: the reporting app files its later payments and their matched deposits', () => {
  const s = base();
  reportIn(s, [item('a1', 'p-rook', 7000, addDays(TODAY, -5))]);
  answerPayer(s, 'sessions', 'p-rook', 'cash', NOW);
  refresh(s, NOW);
  const id = makeInlet(s, { name: 'Sittings', kind: 'job' }, NOW, nid());
  fileQueueItem(s, { intoKey: appKey('sessions') }, id, NOW + MIN);
  // later: a payment by transfer, and its bank deposit, from a regular of the app (round 9, F2: an earlier one pairs too)
  row(s, addDays(TODAY, -3), 8000, 'Zelle payment from LARK FENN 5513');
  row(s, addDays(TODAY, -120), 8000, 'Zelle payment from LARK FENN 5513');
  reportIn(s, [item('a0', 'p-lark', 8000, addDays(TODAY, -121)), item('a1', 'p-rook', 7000, addDays(TODAY, -5)), item('a2', 'p-lark', 8000, addDays(TODAY, -4))]);
  refresh(s, NOW);
  const bank = txOf(s, 'Zelle payment from LARK FENN 5513');
  assert.ok(s.txs.some((tx) => tx.via === 'income' && tx.matchId === bank.id), 'the payment met its deposit');
  assert.equal(filed(s, bank).to, id, 'the matched deposit is filed by the app');
  const section = moneyInBySource(s, NOW, 90);
  assert.equal(section.rows.find((one) => one.id === id).cents, 15000);
  assert.ok(!depositQueue(s, NOW).items.some((one) => one.key === 'app:' + appKey('sessions')), 'nothing of the app waits');
});

test('filing: stream deposits keep kind, category, purpose and link; filing writes nothing to a row', () => {
  const s = base();
  const fields = (st) => st.txs.filter((tx) => tx.raw === PAYROLL).map((tx) => [tx.id, tx.kind, tx.category, tx.klass, tx.purpose, tx.streamId, tx.locks.join('+')]);
  const before = fields(s);
  assert.ok(before.every((one) => one[5]), 'pay is linked to its stream');
  const pay = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  const q = depositQueue(s, NOW).items.find((one) => one.merchant && one.key.startsWith('payer:') && one.count > 5);
  fileQueueItem(s, q, pay, NOW + MIN);
  assert.deepEqual(fields(s), before);
  // and filed to a source of another kind: the rows still keep theirs (the stream's own reading changes: the pay fix)
  editInlet(s, pay, { kind: 'job' }, NOW + 2 * MIN);
  refresh(s, NOW);
  assert.deepEqual(fields(s), before);
});

test('filing: a deposit whose id the bank re-issued keeps its filing, and a new filing goes to the key that reaches it', () => {
  const s = base();
  const cheque = txOf(s, CHEQUE, addDays(TODAY, -10));
  const id = makeInlet(s, { name: 'Print sales', kind: 'oneoff' }, NOW, nid());
  const item0 = depositQueue(s, NOW).items.find((one) => one.kind === 'one' && one.txId === cheque.id);
  fileQueueItem(s, item0, id, NOW + MIN);
  const key = item0.intoKey;
  assert.ok(key.startsWith('i'));
  cheque.ext = { id: 'ext-reissued-1' };
  refresh(s, NOW);
  assert.equal(filed(s, cheque).to, id, 'found by its fingerprint');
  assert.notEqual(filingOf(lookOf(s), cheque).keys.where.key, key, 'under a new key');
  const id2 = makeInlet(s, { name: 'Prizes', kind: 'oneoff' }, NOW, nid());
  fileDeposit(s, cheque.id, id2, 'one', NOW + 2 * MIN);
  assert.equal(filed(s, cheque).to, id2);
  assert.equal(storedFlows(s).into[key].v, id2, 'the cell that reached it, so an Undo puts it back');
});

/* ------------------------------------------------------------------ travel */

test('travel: two devices with records of different depth file, leave and undo alike', async () => {
  const a = deviceOf(base({ from: addDays(TODAY, -180) }), () => NOW);
  const b = deviceOf(base({ from: addDays(TODAY, -100) }), () => NOW + MIN);
  // B's record is shorter: its first deposits are later. A shows its older ones until the shared floor arrives
  const repo = memory();
  await settle([a, b], repo);
  assert.deepEqual(queueKeys(a.state), queueKeys(b.state), 'one queue on both, the floor shared');
  const photo = nid();
  a.clock = () => NOW + 2 * MIN;
  update(a, (s) => makeInlet(s, { name: 'Photo shoots', kind: 'job' }, a.clock(), photo), 'made');
  const zelle = depositQueue(a.state, NOW).items.find((one) => one.zelle);
  update(a, (s) => fileQueueItem(s, zelle, photo, a.clock()), 'filed');
  b.clock = () => NOW + 3 * MIN;
  const cheque = depositQueue(b.state, NOW).items.find((one) => one.kind === 'one');
  update(b, (s) => fileQueueItem(s, cheque, LEAVE, b.clock()), 'left');
  await settle([a, b], repo);
  assert.deepEqual(queueKeys(a.state), queueKeys(b.state), 'a filing and Leave it, on both');
  assert.ok(!queueKeys(a.state).some((k) => k.startsWith(zelle.key)));
  assert.ok(!queueKeys(a.state).some((k) => k.startsWith(cheque.key)));
  a.clock = () => NOW + 4 * MIN;
  a.undo();
  await settle([a, b], repo);
  assert.deepEqual(queueKeys(a.state), queueKeys(b.state), 'and an Undo');
  assert.ok(queueKeys(b.state).some((k) => k.startsWith(zelle.key)), 'the sender is back in the queue on both');
});

test('travel: file, round, Undo, round leaves both unfiled', async () => {
  const a = deviceOf(base(), () => NOW);
  const b = deviceOf(base(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  const id = nid();
  update(a, (s) => makeInlet(s, { name: 'Day job', kind: 'steady' }, a.clock(), id), 'made');
  a.clock = () => NOW + 2 * MIN;
  const pay = depositQueue(a.state, NOW).items.find((one) => one.count > 5);
  update(a, (s) => fileQueueItem(s, pay, id, a.clock()), 'filed');
  await settle([a, b], repo);
  const payTx = (s) => s.txs.find((tx) => tx.raw === PAYROLL);
  assert.equal(filed(b.state, payTx(b.state)).to, id, 'B has the filing');
  a.clock = () => NOW + 3 * MIN;
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) {
    assert.equal(filed(d.state, payTx(d.state)).to, null, 'unfiled on both');
    assert.ok(storedFlows(d.state).into[pay.intoKey].deleted, 'an undone first filing is a removal');
  }
});

test('travel: a source removed on one device while renamed or filed on the other stays removed, its money Not yet filed', async () => {
  for (const other of ['rename', 'file']) {
    const a = deviceOf(base(), () => NOW);
    const b = deviceOf(base(), () => NOW + MIN);
    const repo = memory();
    const id = nid();
    update(a, (s) => makeInlet(s, { name: 'Photo shoots', kind: 'job' }, a.clock(), id), 'made');
    const zelle = depositQueue(a.state, NOW).items.find((one) => one.zelle);
    update(a, (s) => fileQueueItem(s, zelle, id, a.clock()), 'filed');
    await settle([a, b], repo);
    a.clock = () => NOW + 5 * MIN;
    update(a, (s) => editInlet(s, id, { removed: true }, a.clock()), 'removed');
    b.clock = () => NOW + 6 * MIN;
    if (other === 'rename') update(b, (s) => editInlet(s, id, { name: 'Shoots' }, b.clock()), 'renamed');
    else update(b, (s) => fileQueueItem(s, depositQueue(s, NOW).items.find((one) => one.kind === 'one'), id, b.clock()), 'filed');
    await settle([a, b], repo);
    for (const d of [a, b]) {
      const inlet = inletsOf(d.state).get(id);
      assert.ok(inlet.removed, other + ': stays removed');
      const section = moneyInBySource(d.state, NOW, 90);
      assert.ok(!section.rows.some((one) => one.id === id), other + ': no row');
      assert.equal(filed(d.state, txOf(d.state, ZELLE_A)).to, null, other + ': reads as Not yet filed');
    }
    assert.deepEqual(queueKeys(a.state), queueKeys(b.state));
  }
});

/* ------------------------------------------------------------------ suggestions */

test('suggestions: each shows only while its key is unfiled and not dismissed; Add makes the source and files it in one Undo', async () => {
  const s = base();
  reportIn(s, [item('a1', 'p-rook', 7000, addDays(TODAY, -5))]);
  answerPayer(s, 'sessions', 'p-rook', 'cash', NOW);
  row(s, addDays(TODAY, -60), 31000, 'FERNHOLLOW IMAGES CONTRIBUTOR PAY');
  row(s, addDays(TODAY, -150), 27000, 'FERNHOLLOW IMAGES CONTRIBUTOR PAY');
  refresh(s, NOW);
  // the built-in royalties rule names real payers only; here it is said to have filed these invented ones
  for (const tx of s.txs) if (tx.raw.startsWith('FERNHOLLOW')) tx.ruleId = 'builtin:royalties';
  const got = suggestions(s, NOW);
  const kinds = Object.fromEntries(got.shown.map((one) => [one.key[0], one]));
  assert.deepEqual(Object.keys(kinds).sort(), ['p', 'r', 's']);
  assert.equal(kinds.s.kind, 'steady');
  assert.equal(kinds.s.name, 'Northwind Tooling Payroll');
  assert.equal(kinds.r.kind, 'job');
  assert.equal(kinds.r.name, 'Sitting');
  assert.equal(kinds.p.kind, 'backend');
  // Add: one update makes the source with that name and kind and files its key
  const d = deviceOf(s, () => NOW + MIN);
  const id = nid();
  update(d, (st) => acceptOffer(st, kinds.r, d.clock(), id), 'added');
  assert.equal(inletsOf(d.state).get(id).name, 'Sitting');
  assert.equal(storedFlows(d.state).into[appKey('sessions')].v, id);
  for (const tx of d.state.txs) if (tx.raw.startsWith('FERNHOLLOW')) tx.ruleId = 'builtin:royalties';
  assert.ok(!suggestions(d.state, NOW).shown.some((one) => one.key === kinds.r.key), 'filed: no longer suggested');
  // Undo takes both back
  d.clock = () => NOW + 2 * MIN;
  d.undo();
  for (const tx of d.state.txs) if (tx.raw.startsWith('FERNHOLLOW')) tx.ruleId = 'builtin:royalties';
  assert.equal(inletsOf(d.state).get(id), undefined, 'the source is undone');
  assert.ok(storedFlows(d.state).into[appKey('sessions')].deleted, 'its filing is a removal');
  assert.ok(suggestions(d.state, NOW).shown.some((one) => one.key === kinds.r.key), 'suggested again');
  // filed by hand to Windfalls: not suggested either
  fileQueueItem(d.state, { intoKey: kinds.p.intoKey }, WINDFALL, NOW + 3 * MIN);
  for (const tx of d.state.txs) if (tx.raw.startsWith('FERNHOLLOW')) tx.ruleId = 'builtin:royalties';
  assert.ok(!suggestions(d.state, NOW).shown.some((one) => one.key === kinds.p.key));
});

test('suggestions: Not now and Restore travel', async () => {
  const a = deviceOf(base(), () => NOW);
  const b = deviceOf(base(), () => NOW + MIN);
  const repo = memory();
  const offer = suggestions(a.state, NOW).shown.find((one) => one.key[0] === 's');
  update(a, (s) => dismissOffer(s, offer.key, a.clock()), 'not now');
  await settle([a, b], repo);
  for (const d of [a, b]) {
    const got = suggestions(d.state, NOW);
    assert.ok(!got.shown.some((one) => one.key === offer.key));
    assert.ok(got.dismissed.some((one) => one.key === offer.key));
  }
  b.clock = () => NOW + 2 * MIN;
  update(b, (s) => restoreOffer(s, offer.key, b.clock()), 'restored');
  await settle([a, b], repo);
  for (const d of [a, b]) assert.ok(suggestions(d.state, NOW).shown.some((one) => one.key === offer.key), 'shown again on both');
  // and an Undo of Not now on its own device
  a.clock = () => NOW + 3 * MIN;
  update(a, (s) => dismissOffer(s, offer.key, a.clock()), 'not now');
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) assert.ok(suggestions(d.state, NOW).shown.some((one) => one.key === offer.key));
});

test('a source: name 1 to 40 characters, four kinds, a goal, the tag, archive and Remove; the queue names a new one in the same Undo', () => {
  const s = base();
  assert.equal(inletName('  a  name\u0007 with  spaces '), 'a name with spaces');
  assert.equal(inletName('x'.repeat(60)).length, 40);
  assert.equal(inletName('😀'.repeat(30)).length, 40, 'never splits a pair');
  assert.equal(makeInlet(s, { name: '   ', kind: 'job' }, NOW), null);
  assert.equal(makeInlet(s, { name: 'Day job', kind: 'salary' }, NOW), null);
  const id = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  for (const kind of INLET_KINDS) assert.ok(editInlet(s, id, { kind }, NOW + MIN));
  assert.ok(editInlet(s, id, { goal: { per: 'year', cents: 400000 }, focus: true }, NOW + 2 * MIN));
  assert.deepEqual(inletsOf(s).get(id).goal, { per: 'year', cents: 400000 });
  assert.ok(inletsOf(s).get(id).focus);
  assert.ok(editInlet(s, id, { goal: null, focus: false }, NOW + 3 * MIN));
  assert.equal(inletsOf(s).get(id).goal, null);
  assert.ok(storedFlows(s).inlets[id].goal.deleted, 'a cleared goal is a removal');
  editInlet(s, id, { gone: true }, NOW + 4 * MIN);
  assert.ok(inletsOf(s).get(id).gone);
  editInlet(s, id, { gone: false }, NOW + 5 * MIN);
  assert.ok(!inletsOf(s).get(id).gone, 'restored from the archive');
  // the queue names a new source and files to it in one update
  const d = deviceOf(s, () => NOW + 6 * MIN);
  const zelle = depositQueue(s, NOW).items.find((one) => one.zelle);
  const made = nid();
  update(d, (st) => fileToNew(st, zelle, { name: 'Photo shoots', kind: 'job' }, d.clock(), made), 'new');
  assert.equal(filed(d.state, txOf(d.state, ZELLE_A)).to, made);
  d.undo();
  assert.equal(inletsOf(d.state).get(made), undefined);
  assert.equal(filed(d.state, txOf(d.state, ZELLE_A)).to, null);
});

/* ------------------------------------------------------------------ the pay fix */

test('the pay fix: a regular $150 payer filed to By the job does not accrue and gives no payday; set by hand, it does', () => {
  const s = bankRecord();
  for (const d of every(addDays(TODAY, -120), TODAY, 14)) row(s, d, 15000, ZELLE_B);
  refresh(s, NOW);
  const stream = s.streams.find((one) => one.mkey === txOf(s, ZELLE_B).mkey);
  assert.ok(stream.accrue, 'read as pay by detection');
  assert.ok(makeLedger(s, NOW).payStreams().some((one) => one.id === stream.id));
  const id = makeInlet(s, { name: 'Coaching sessions', kind: 'job' }, NOW, nid());
  fileQueueItem(s, { intoKey: merchantKeyOf(stream.mkey) }, id, NOW + MIN);
  const after = s.streams.find((one) => one.id === stream.id);
  assert.equal(after.accrue, false, 'no accrual');
  assert.ok(!makeLedger(s, NOW).payStreams().some((one) => one.id === stream.id), 'no payday');
  assert.equal(makeLedger(s, NOW).clock().nextPayday, null, 'no payday on the Board');
  // Steady pay: pay again
  editInlet(s, id, { kind: 'steady' }, NOW + 2 * MIN);
  refresh(s, NOW);
  assert.ok(s.streams.find((one) => one.id === stream.id).accrue, 'steady pay accrues');
  // set by hand in the stream sheet: it wins
  editInlet(s, id, { kind: 'job' }, NOW + 3 * MIN);
  const own = s.streams.find((one) => one.id === stream.id);
  own.accrue = true;
  own.locks = [...(own.locks || []), 'accrue'];
  refresh(s, NOW);
  assert.ok(s.streams.find((one) => one.id === stream.id).accrue, 'the owner\'s setting holds');
  assert.ok(makeLedger(s, NOW).payStreams().some((one) => one.id === stream.id));
});

/* ------------------------------------------------------------------ It was money in */

test('"It was money in": a wallet refund filed as income travels, counts on the other device and joins its queue', async () => {
  const make = () => {
    const s = base();
    row(s, addDays(TODAY, -30), -5000, 'VENMO PAYMENT 1234');
    row(s, addDays(TODAY, -6), 5000, 'VENMO PAYMENT 1235');
    refresh(s, NOW);
    return s;
  };
  const a = deviceOf(make(), () => NOW);
  const b = deviceOf(make(), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  const refund = txOf(a.state, 'VENMO PAYMENT 1235');
  assert.ok(isWalletRefund(refund, a.state));
  assert.ok(moveQueue(a.state, NOW).items.some((one) => one.txId === refund.id || one.key.includes('venmo')), 'in the spending queue');
  a.clock = () => NOW + 2 * MIN;
  let ok = false;
  update(a, (s) => { ok = moneyInMove(s, refund.id, a.clock()); }, 'money in');
  assert.ok(ok);
  await settle([a, b], repo);
  for (const d of [a, b]) {
    const tx = txOf(d.state, 'VENMO PAYMENT 1235');
    assert.equal(tx.kind, 'income');
    assert.ok(inflow(d.state, addDays(TODAY, -29), TODAY, NOW).rows.some((one) => one.tx.id === tx.id), 'counts as money in');
    assert.ok(depositQueue(d.state, NOW).items.some((one) => one.txId === tx.id), 'joins the money-in queue');
  }
});

/* ------------------------------------------------------------------ fixes, round 1 */

test('paydays: a Steady pay source whose payer stopped reads the drop, as its pay stream does unfiled', () => {
  for (const [stoppedAgo, days, drop] of [[20, 30, 0], [40, 30, -420000], [45, 90, -420000]]) {
    const back = days === 90 ? 200 : 170;
    const make = () => {
      const s = bankRecord();
      for (let d = addDays(TODAY, -stoppedAgo); d >= addDays(TODAY, -back); d = addDays(d, -14)) row(s, d, 210000, PAYROLL);
      for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -back); d = addDays(d, -30)) row(s, d, 15000, ZELLE_A);
      refresh(s, NOW);
      return s;
    };
    const unfiled = make();
    const s = make();
    const id = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
    assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, id, NOW + MIN));
    const before = inAndOut(unfiled, NOW, days);
    const after = inAndOut(s, NOW, days);
    const sec = moneyInBySource(s, NOW, days);
    const one = sec.rows.find((r) => r.id === id);
    const what = 'stopped ' + stoppedAgo + ' days ago, ' + days + ' days';
    assert.equal(before.in.change, drop, what + ': unfiled');
    assert.equal(after.in.change, before.in.change, what + ': filing the payer leaves In and out\'s change as it was');
    assert.equal(one.change, drop, what + ': the source');
    assert.equal(sec.earned.change, drop, what + ': All earned');
  }
});

test('In and out: a pay stream a built-in rule files to Windfalls is still compared payday for payday', () => {
  const s = bankRecord();
  const first = addDays(TODAY, -29);
  for (let d = first; d <= TODAY; d = addDays(d, 14)) row(s, d, 90000, 'NYS DOL UI DD 0042');
  for (let d = addDays(first, -14); d >= addDays(TODAY, -170); d = addDays(d, -14)) row(s, d, 90000, 'NYS DOL UI DD 0042');
  refresh(s, NOW);
  const tx = txOf(s, 'NYS DOL UI DD 0042');
  assert.equal(filed(s, tx).how, 'rule');
  const io = inAndOut(s, NOW, 30);
  const pay = io.paydays.streams;
  assert.equal(pay.length, 1);
  assert.deepEqual([pay[0].now, pay[0].before, pay[0].left], [3, 2, 90000], 'three paydays against two, the extra one left out');
  assert.equal(io.in.change, 0, 'as main reads it');
});

test('filing: a payment app\'s deposits are queued and filed one at a time; a later one from anyone is asked about', () => {
  const s = bankRecord();
  for (let d = addDays(TODAY, -1); d >= addDays(TODAY, -170); d = addDays(d, -14)) row(s, d, 210000, PAYROLL);
  // two people paid back through the wallet, each "It was money in"
  row(s, addDays(TODAY, -40), -5000, 'VENMO PAYMENT 1001');
  row(s, addDays(TODAY, -30), 5000, 'VENMO PAYMENT 1002');
  row(s, addDays(TODAY, -35), -8000, 'VENMO PAYMENT 2001');
  row(s, addDays(TODAY, -25), 8000, 'VENMO PAYMENT 2002');
  refresh(s, NOW);
  for (const [raw, k] of [['VENMO PAYMENT 1002', 1], ['VENMO PAYMENT 2002', 2]]) {
    const tx = txOf(s, raw);
    assert.ok(isWalletRefund(tx, s), raw);
    assert.ok(moneyInMove(s, tx.id, NOW + k * MIN), raw);
  }
  const items = depositQueue(s, NOW).items.filter((one) => /venmo/i.test(one.merchant || ''));
  assert.deepEqual(items.map((one) => [one.kind, one.count]), [['one', 1], ['one', 1]], 'this move only: each on its own');
  const id = makeInlet(s, { name: 'Photo shoots', kind: 'job' }, NOW, nid());
  assert.ok(fileQueueItem(s, items[0], id, NOW + 3 * MIN));
  // later, a wallet deposit read as income by itself (no payment out before it)
  row(s, addDays(TODAY, -3), 45000, 'VENMO PAYMENT 3001');
  refresh(s, NOW);
  assert.notEqual(filed(s, txOf(s, 'VENMO PAYMENT 3001')).to, id, 'not filed by the one tap');
  assert.notEqual(filed(s, s.txs.find((one) => one.id === items[1].txId)).to, id, 'nor the other refund');
  assert.equal(moneyInBySource(s, NOW, 30).rows.find((r) => r.id === id).cents, items[0].amount);
  assert.ok(depositQueue(s, NOW).items.some((one) => one.kind === 'one' && one.txId === txOf(s, 'VENMO PAYMENT 3001').id), 'asked about');
});

test('"It was money in": never on a card\'s credit (a deposit on a card is never money in)', () => {
  const s = base();
  row(s, addDays(TODAY, -20), -4000, 'CASH APP*PAYMENT 5511', { account: 'acc_card' });
  row(s, addDays(TODAY, -12), 4000, 'CASH APP*PAYMENT 5512', { account: 'acc_card' });
  refresh(s, NOW);
  const credit = txOf(s, 'CASH APP*PAYMENT 5512');
  assert.equal(credit.kind, 'refund');
  assert.equal(credit.ruleId, 'builtin:wallet-payment');
  assert.equal(isWalletRefund(credit, s), false, 'no chip');
  assert.equal(moneyInMove(s, credit.id, NOW + MIN), false, 'the move is refused');
  assert.equal(txOf(s, 'CASH APP*PAYMENT 5512').kind, 'refund');
  assert.ok(!inflow(s, addDays(TODAY, -29), TODAY, NOW).rows.some((one) => one.tx.id === credit.id), 'not money in');
  assert.ok(!depositQueue(s, NOW).items.some((one) => one.txId === credit.id), 'not in the money-in queue');
});

test('filing: the first chip reads the deposits filed to Windfalls among the key\'s latest', () => {
  const s = base();
  const id = makeInlet(s, { name: 'Print sales', kind: 'oneoff' }, NOW, nid());
  for (const [ago, cents] of [[60, 30100], [45, 31000], [30, 32000], [5, 33000]]) row(s, addDays(TODAY, -ago), cents, CHEQUE);
  refresh(s, NOW);
  const one = (ago) => depositQueue(s, NOW).items.find((it) => it.kind === 'one' && it.last === addDays(TODAY, -ago));
  assert.ok(fileQueueItem(s, one(60), id, NOW + MIN));
  assert.ok(fileQueueItem(s, one(45), id, NOW + 2 * MIN));
  assert.equal(one(30).guess, id, 'the last 2 went to Print sales');
  assert.ok(fileQueueItem(s, one(30), WINDFALL, NOW + 3 * MIN));
  assert.equal(one(5).guess, null, 'the latest went to Windfalls: no guess');
});

test('the pay fix: a kind changed or a source removed on its sheet changes pay on that device at once, as on the other', async () => {
  const make = () => { const s = base(); s.settings.smoothing = true; return s; };
  let t = NOW;
  const a = deviceOf(make(), () => t);
  const b = deviceOf(make(), () => t);
  const repo = memory();
  await settle([a, b], repo);
  const id = 'n' + 'c'.repeat(13);
  t += MIN;
  update(a, (s) => { makeInlet(s, { name: 'Day job', kind: 'steady' }, t, id); fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, id, t); });
  await settle([a, b], repo);
  const accrues = (d) => d.state.streams.some((st) => st.accrue && st.mkey === txOf(d.state, PAYROLL).mkey);
  const live = (d) => makeLedger(d.state, t).position().live;
  assert.ok(accrues(a) && accrues(b), 'Steady pay accrues');
  // the sheet's Save writes the kind with editInlet alone, in one update
  t += MIN;
  update(a, (s) => { editInlet(s, id, { kind: 'job' }, t); }, 'source edited');
  assert.equal(accrues(a), false, 'at once on the device that made the edit');
  await settle([a, b], repo);
  assert.equal(accrues(b), false);
  assert.equal(live(a), live(b));
  // Remove: pay again, on both
  t += MIN;
  update(a, (s) => { editInlet(s, id, { removed: true }, t); }, 'source removed');
  assert.ok(accrues(a), 'removed: the payer is pay again, at once');
  await settle([a, b], repo);
  assert.ok(accrues(b));
  assert.equal(live(a), live(b));
});

test('the pay fix: a stream whose accrual was set off by hand gives no payday once filed to By the job', () => {
  const s = bankRecord();
  for (const d of every(addDays(TODAY, -120), TODAY, 14)) row(s, d, 150000, ZELLE_B);
  refresh(s, NOW);
  const stream = s.streams.find((one) => one.mkey === txOf(s, ZELLE_B).mkey);
  stream.accrue = false;
  stream.locks = [...(stream.locks || []), 'accrue'];
  refresh(s, NOW);
  assert.ok(makeLedger(s, NOW).payStreams().some((one) => one.id === stream.id), 'pay: over $200 a month');
  assert.ok(makeLedger(s, NOW).clock().nextPayday, 'a payday');
  const id = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(stream.mkey) }, id, NOW + MIN));
  assert.ok(!makeLedger(s, NOW).payStreams().some((one) => one.id === stream.id), 'no pay stream');
  assert.equal(makeLedger(s, NOW).clock().nextPayday, null, 'no payday');
});

test('travel: an Undo after another device filed a payer keeps that pay fix (the earlier copies run detection)', async () => {
  const make = () => { const s = base(); s.settings.smoothing = true; return s; };
  let t = NOW;
  const a = deviceOf(make(), () => t);
  const b = deviceOf(make(), () => t);
  const repo = memory();
  await settle([a, b], repo);
  const job = 'n' + 'd'.repeat(13);
  const odd = 'n' + 'e'.repeat(13);
  t += MIN;
  update(a, (s) => { makeInlet(s, { name: 'Side work', kind: 'job' }, t, odd); makeInlet(s, { name: 'Contract work', kind: 'job' }, t, job); });
  await settle([a, b], repo);
  t += MIN;
  update(a, (s) => { editInlet(s, odd, { name: 'Odd jobs' }, t); }, 'renamed');
  t += MIN;
  update(b, (s) => { fileQueueItem(s, depositQueue(s, t).items.find((one) => one.kind === 'payer' && one.count > 3), job, t); });
  await settle([a, b], repo);
  const accrues = (d) => d.state.streams.some((st) => st.accrue);
  assert.equal(accrues(a), false);
  assert.equal(accrues(b), false);
  t += MIN;
  assert.ok(a.undo(), 'A undoes its rename');
  await settle([a, b], repo);
  assert.equal(inletsOf(a.state).get(odd).name, 'Side work');
  assert.equal(accrues(a), false, 'the payroll filed to By the job does not accrue again');
  assert.equal(makeLedger(a.state, t).position().live, makeLedger(b.state, t).position().live);
});

test('the deposit\'s sheet: Not yet filed is written only where it takes effect', () => {
  const s = base();
  const id = makeInlet(s, { name: 'Photo shoots', kind: 'job' }, NOW, nid());
  const zelle = txOf(s, ZELLE_A, addDays(TODAY, -20));
  assert.ok(fileDeposit(s, zelle.id, id, 'all', NOW + MIN), 'the payer filed');
  assert.equal(canUnfile(s, zelle.id, 'one'), false);
  assert.equal(fileDeposit(s, zelle.id, null, 'one', NOW + 2 * MIN), false, 'a removal under its payer\'s filing decides nothing');
  assert.equal(filed(s, zelle).to, id);
  assert.ok(canUnfile(s, zelle.id, 'all'));
  // one deposit filed on its own: All from this payer cannot unfile it, This deposit only can
  const other = makeInlet(s, { name: 'Print sales', kind: 'oneoff' }, NOW, nid());
  assert.ok(fileDeposit(s, zelle.id, other, 'one', NOW + 3 * MIN));
  assert.equal(filed(s, zelle).how, 'deposit');
  assert.equal(canUnfile(s, zelle.id, 'all'), false);
  assert.ok(canUnfile(s, zelle.id, 'one'));
  assert.ok(fileDeposit(s, zelle.id, null, 'one', NOW + 4 * MIN));
  assert.equal(filed(s, zelle).to, id, 'back to its payer\'s source');
  // a deposit a built-in rule files to Windfalls
  const interest = txOf(s, INTEREST);
  assert.equal(filed(s, interest).how, 'rule');
  assert.equal(canUnfile(s, interest.id, 'one'), false);
  assert.equal(fileDeposit(s, interest.id, null, 'all', NOW + 5 * MIN), false);
});

/* ------------------------------------------------------------------ Fig. 1 data */

test('Fig. 1 data: one row per source by total, Not yet filed last, months before the record blank', () => {
  const s = base({ from: addDays(TODAY, -150) });
  const pay = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  editInlet(s, pay, { goal: { per: 'month', cents: 400000 } }, NOW);
  fileQueueItem(s, depositQueue(s, NOW).items.find((one) => one.count > 5), pay, NOW + MIN);
  const fig = figOne(s, NOW);
  assert.equal(fig.months.length, 12);
  assert.equal(fig.rows[0].id, pay);
  assert.equal(fig.rows[0].goal, 400000);
  assert.ok(fig.rows[fig.rows.length - 1].unfiled, 'Not yet filed last');
  const blank = fig.rows[0].cells.filter((cell) => cell.blank).length;
  assert.equal(blank, 12 - fig.rows[0].onRecord);
  assert.ok(fig.rows[0].onRecord >= 5 && fig.rows[0].onRecord <= 7);
  assert.equal(fig.rows[0].paid, fig.rows[0].onRecord);
});

/* ------------------------------------------------------------------ older builds */

/** 8d013da and f414276 read a `flows` section and write it back unchanged; f414276's strict reader takes every cell. */
async function oldBuildsTake(t, section) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const commit of ['8d013da', 'f414276']) {
    let dir = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'networth-old-'));
      const tar = execFileSync('git', ['archive', '--format=tar', commit, 'js'], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      writeFileSync(join(dir, 'old.tar'), tar);
      execFileSync('tar', ['-xf', join(dir, 'old.tar'), '-C', dir]);
    } catch {
      if (dir) rmSync(dir, { recursive: true, force: true });
      t.skip('no git, or a copy without that build');
      return false;
    }
    try {
      const old = await import(pathToFileURL(join(dir, 'js', 'model', 'share.js')).href);
      const oldSchema = await import(pathToFileURL(join(dir, 'js', 'model', 'schema.js')).href);
      const file = { v: 1, app: 'networth', savedAt: 5, byHand: {}, flows: section };
      const text = fileText(file);
      const read = old.readSharedFile(text);
      assert.ok(read, commit + ' reads the file');
      assert.deepEqual(read.flows, section, commit + ' keeps the section as it is');
      if (commit === 'f414276') {
        const oldFlows = await import(pathToFileURL(join(dir, 'js', 'model', 'flowsection.js')).href);
        assert.deepEqual(oldFlows.readFlows(section), section, 'f414276\'s strict reader takes every cell');
      }
      const state = oldSchema.defaultState(NOW);
      state.settings.words = 'finance';
      state.settings.wordsAt = NOW;
      const repo = memory();
      repo.text = text;
      repo.sha = 's0';
      const device = { state: () => state, stale: () => false, update: (now) => now(state) };
      await old.roundShared(device, repo, () => NOW);
      const written = JSON.parse(repo.text);
      assert.deepEqual(readFlows(written.flows), section, commit + ' writes it back unchanged');
      assert.deepEqual(readSharedFile(repo.text).flows.inlets, readFlows(section).inlets, 'this build reads what the old one wrote');
      assert.deepEqual(readSharedFile(repo.text).flows.into, readFlows(section).into);
      assert.deepEqual(readSharedFile(repo.text).flows.offers, readFlows(section).offers);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return true;
}

test('older builds (8d013da and f414276) read every cell this pass writes and write it back unchanged', async (t) => {
  // every action of the pass, then an Undo, on one device
  const s = base();
  reportIn(s, [item('a1', 'p-rook', 7000, addDays(TODAY, -5))]);
  answerPayer(s, 'sessions', 'p-rook', 'cash', NOW);
  refresh(s, NOW);
  const d = deviceOf(s, () => NOW);
  const name = 'Ünïcode “quotes” & a name of 40 characters';
  const id = nid();
  update(d, (st) => makeInlet(st, { name, kind: 'backend' }, d.clock(), id));
  update(d, (st) => editInlet(st, id, { goal: { per: 'month', cents: 125000 }, focus: true, gone: true }, d.clock() + 1));
  update(d, (st) => editInlet(st, id, { gone: false, focus: false, goal: null }, d.clock() + 2));
  const q = depositQueue(d.state, NOW).items;
  update(d, (st) => fileQueueItem(st, q.find((one) => one.zelle), id, d.clock() + 3));
  update(d, (st) => fileQueueItem(st, q.find((one) => one.kind === 'one'), LEAVE, d.clock() + 4));
  update(d, (st) => fileQueueItem(st, { intoKey: appKey('sessions') }, WINDFALL, d.clock() + 5));
  update(d, (st) => fileDeposit(st, st.txs.find((tx) => tx.via === 'income').id, id, 'one', d.clock() + 6));
  const offer = suggestions(d.state, NOW).shown[0];
  update(d, (st) => dismissOffer(st, offer.key, d.clock() + 7));
  update(d, (st) => restoreOffer(st, offer.key, d.clock() + 8));
  update(d, (st) => acceptOffer(st, offer, d.clock() + 9, nid()));
  d.clock = () => NOW + 20;
  d.undo();
  update(d, (st) => editInlet(st, id, { removed: true }, NOW + 30));
  const section = exportFlows(d.state, NOW + 40);
  assert.ok(section.inlets && section.into && section.offers, 'the three maps');
  assert.ok(Object.keys(section.into).some((k) => k[0] === 'i'), 'a filing of one deposit, with its fingerprint');
  assert.ok(Object.keys(section.into).some((k) => k[0] === 'q'), 'a reported payment');
  assert.ok(Object.values(section.into).some((cell) => cell.undo && cell.deleted), 'an Undo\'s removal');
  assert.deepEqual(readFlows(section), section, 'this build reads it');
  await oldBuildsTake(t, section);
});

test('the keys: an app, a payment, a payer; a deposit\'s own key needs its day and fingerprint', () => {
  assert.match(appKey('sessions'), /^r[0-9a-f]{13}$/);
  assert.match(paymentKey('sessions/a1'), /^q[0-9a-f]{13}$/);
  const s = base();
  const cheque = txOf(s, CHEQUE, addDays(TODAY, -10));
  const keys = filingOf(lookOf(s), cheque).keys;
  assert.match(keys.where.key, /^i[0-9a-f]{13}$/);
  assert.match(keys.where.fp, /^f[0-9a-f]{13}$/);
  assert.match(keys.payer, /^p[0-9a-f]{13}$/);
  const id = makeInlet(s, { name: 'Prizes', kind: 'oneoff' }, NOW, nid());
  fileDeposit(s, cheque.id, id, 'one', NOW + MIN);
  const cell = storedFlows(s).into[keys.where.key];
  assert.deepEqual(Object.keys(cell).sort(), ['at', 'day', 'fp', 'v']);
  assert.equal(cell.day, cheque.day);
  // a pending row is never filed on its own
  const pending = row(s, TODAY, 5000, CHEQUE, { pending: true });
  refresh(s, NOW);
  assert.equal(fileDeposit(s, pending.id, id, 'one', NOW + 2 * MIN), false);
  assert.ok(!depositQueue(s, NOW).items.some((one) => one.txId === pending.id), 'pending rows wait until posted');
  void clone;
  void readSharedFile;
});

/* ------------------------------------------------------------------ fixes, round 2 */

test('suggestions: a pay stream on a catch-all key (a cheque by phone, a cash-out, a payout) is never suggested; a later deposit on the key is asked about', () => {
  for (const [raw, step, cents] of [[CHEQUE, 14, 182500], ['VENMO CASHOUT PPD ID: 5264681992', 7, 40000], ['STRIPE TRANSFER ST-K2L8 PAYOUT', 7, 40500]]) {
    const s = bankRecord();
    for (const d of every(addDays(TODAY, -160), addDays(TODAY, -3), step)) row(s, d, cents, raw);
    refresh(s, NOW);
    const dep = txOf(s, raw);
    assert.ok(makeLedger(s, NOW).payStreams().some((one) => one.id === dep.streamId), raw + ': detection reads it as pay');
    const offers = suggestions(s, NOW);
    assert.ok(![...offers.shown, ...offers.dismissed].some((one) => one.key[0] === 's'), raw + ': not suggested as Steady pay');
    // so nothing files the key: a small deposit from someone else, made the same way, is asked about on its own
    const later = row(s, addDays(TODAY, -1), 5000, raw, { ext: 'ext-later-' + step + '-' + cents });
    refresh(s, NOW);
    assert.equal(filed(s, later).to, null, raw);
    assert.ok(depositQueue(s, NOW).items.some((one) => one.kind === 'one' && one.txId === later.id), raw + ': in the queue');
  }
});

test('suggestions: a payer paid through the reporting app is not suggested as Steady pay, before or after the app is filed', () => {
  const LARK = 'Zelle payment from LARK FENN 9001';
  const s = bankRecord();
  const items = [];
  let k = 0;
  for (let d = addDays(TODAY, -160); d <= addDays(TODAY, -2); d = addDays(d, 7)) {
    items.push(item('w' + (k += 1), 'p-lark', 7500, d));
    row(s, addDays(d, 1), 7500, LARK);
  }
  refresh(s, NOW);
  reportIn(s, [items[0]], NOW - 170 * 86400000);
  reportIn(s, items);
  refresh(s, NOW);
  const dep = txOf(s, LARK);
  assert.ok(makeLedger(s, NOW).payStreams().some((one) => one.id === dep.streamId), 'detection reads it as pay');
  assert.ok(filingOf(lookOf(s), dep).keys.apps.length, 'its deposits are paired with the app\'s payments');
  const before = suggestions(s, NOW).shown;
  assert.deepEqual(before.map((one) => one.key[0] + ':' + one.kind), ['r:job'], 'only the app is suggested');
  assert.ok(acceptOffer(s, before[0], NOW + MIN, nid()));
  assert.deepEqual(suggestions(s, NOW + MIN).shown, [], 'nothing once the app is filed');
});

test('suggestions: a pay stream whose latest deposit is filed on its own is no longer suggested', () => {
  const s = bankRecord();
  for (const d of every(addDays(TODAY, -120), TODAY, 14)) row(s, d, 15000, ZELLE_B);
  refresh(s, NOW);
  assert.ok(suggestions(s, NOW).shown.some((one) => one.key[0] === 's'), 'suggested while nothing files it');
  const id = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
  const last = s.txs.filter((tx) => tx.raw === ZELLE_B).sort((a, b) => (a.day < b.day ? 1 : -1))[0];
  assert.ok(fileDeposit(s, last.id, id, 'one', NOW + MIN));
  assert.ok(!suggestions(s, NOW + MIN).shown.some((one) => one.key[0] === 's'), 'filed by its own key: not suggested');
});

test('paydays: a bonus filed to a Steady pay source, or a second payer that stopped, leaves In and out\'s change as it reads unfiled', () => {
  const BONUS = 'NORTHWIND TOOLING BONUS 2026 ID: 9911';
  {
    const make = () => {
      const s = bankRecord();
      for (const d of every(addDays(TODAY, -165), addDays(TODAY, -11), 14)) row(s, d, 210000, PAYROLL);
      row(s, addDays(TODAY, -6), 500000, BONUS);
      refresh(s, NOW);
      return s;
    };
    const unfiled = make();
    const s = make();
    const id = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
    assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, id, NOW + MIN));
    assert.ok(fileDeposit(s, txOf(s, BONUS).id, id, 'one', NOW + 2 * MIN));
    const was = inAndOut(unfiled, NOW, 30).in.change;
    assert.equal(was, 500000, 'unfiled: the bonus is the change');
    assert.equal(inAndOut(s, NOW, 30).in.change, was, 'the bonus filed: no extra payday');
    const sec = moneyInBySource(s, NOW, 30);
    const one = sec.rows.find((r) => r.id === id);
    assert.deepEqual([one.paydays.now, one.paydays.before, one.paydays.left], [2, 2, 0], 'its paydays are the payroll\'s');
    assert.equal(one.change, was);
    assert.equal(sec.earned.change, was);
  }
  {
    const OTHER = 'HARBOR LIGHT CAFE PAYROLL PPD ID: 7781';
    const make = () => {
      const s = bankRecord();
      for (let d = addDays(TODAY, -50); d >= addDays(TODAY, -180); d = addDays(d, -14)) row(s, d, 200000, PAYROLL);
      for (let d = addDays(TODAY, -4); d >= addDays(TODAY, -180); d = addDays(d, -14)) row(s, d, 50000, OTHER);
      refresh(s, NOW);
      return s;
    };
    const unfiled = make();
    const s = make();
    const id = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
    for (const raw of [PAYROLL, OTHER]) assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, raw).mkey) }, id, NOW + MIN));
    const was = inAndOut(unfiled, NOW, 30).in.change;
    assert.equal(was, -200000, 'unfiled: the stopped payer is a drop');
    assert.equal(inAndOut(s, NOW, 30).in.change, was, 'both filed to one Steady pay source: the same change');
    const sec = moneyInBySource(s, NOW, 30);
    assert.equal(sec.rows.find((r) => r.id === id).change, was);
    assert.equal(sec.earned.change, was);
  }
});

test('filing: a deposit left with Leave it ends the first chip\'s guess, as Windfalls does', () => {
  const s = base();
  const id = makeInlet(s, { name: 'Print sales', kind: 'oneoff' }, NOW, nid());
  for (const [ago, cents] of [[60, 30100], [45, 31000], [30, 32000], [5, 33000]]) row(s, addDays(TODAY, -ago), cents, CHEQUE);
  refresh(s, NOW);
  const one = (ago) => depositQueue(s, NOW).items.find((it) => it.kind === 'one' && it.last === addDays(TODAY, -ago));
  assert.ok(fileQueueItem(s, one(60), id, NOW + MIN));
  assert.ok(fileQueueItem(s, one(45), id, NOW + 2 * MIN));
  assert.equal(one(30).guess, id, 'the last 2 went to Print sales');
  assert.ok(fileQueueItem(s, one(30), LEAVE, NOW + 3 * MIN));
  assert.equal(one(5).guess, null, 'the latest was left: no guess');
});

test('the pay fix: a source whose kind cell is a removal reads as By the job, and a payer filed to it is no pay', () => {
  const s = bankRecord();
  for (const d of every(addDays(TODAY, -120), TODAY, 14)) row(s, d, 15000, ZELLE_B);
  refresh(s, NOW);
  const stream = s.streams.find((one) => one.mkey === txOf(s, ZELLE_B).mkey);
  assert.ok(stream.accrue);
  const id = makeInlet(s, { name: 'Shop floor', kind: 'steady' }, NOW, nid());
  // as an Undo of its making leaves it after another device renamed it: a name, and a removal for its kind
  assert.ok(noteInlet(s, id, { kind: null }, NOW + MIN));
  assert.equal(inletsOf(s).get(id).kind, 'job', 'the page reads By the job');
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(stream.mkey) }, id, NOW + 2 * MIN));
  assert.equal(s.streams.find((one) => one.id === stream.id).accrue, false, 'no accrual, as By the job');
  assert.ok(!makeLedger(s, NOW).payStreams().some((one) => one.id === stream.id), 'no payday');
});

test('a source: the tag is on one source at a time', () => {
  const s = base();
  const a = makeInlet(s, { name: 'Stock photos', kind: 'backend' }, NOW, nid());
  const b = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  assert.ok(editInlet(s, a, { focus: true }, NOW + MIN));
  assert.ok(editInlet(s, b, { focus: true }, NOW + 2 * MIN));
  assert.deepEqual([inletsOf(s).get(a).focus, inletsOf(s).get(b).focus], [false, true], 'set on Day job, it leaves Stock photos');
  assert.ok(editInlet(s, b, { focus: false }, NOW + 3 * MIN));
  assert.deepEqual([inletsOf(s).get(a).focus, inletsOf(s).get(b).focus], [false, false]);
});

/* ------------------------------------------------------------------ round 3 */

/** A payer of the reporting app paid by transfer every week (Lark Fenn), each deposit the day after the session. */
function appPayer(opts = {}) {
  const LARK = 'Zelle payment from LARK FENN 9001';
  const s = bankRecord();
  if (opts.payroll) for (const d of every(addDays(TODAY, -173), addDays(TODAY, -5), 14)) row(s, d, 210000, PAYROLL);
  const items = [];
  let k = 0;
  for (let d = addDays(TODAY, -160); d <= addDays(TODAY, -2); d = addDays(d, 7)) {
    items.push(item('w' + (k += 1), 'p-lark', opts.cents || 7500, d));
    row(s, addDays(d, 1), opts.cents || 7500, LARK);
  }
  refresh(s, NOW);
  reportIn(s, [items[0]], NOW - 170 * 86400000);
  // the latest session is not marked paid yet: its deposit is at the bank, unpaired (3.7 pairs it once marked)
  reportIn(s, opts.markLast ? items : items.slice(0, -1));
  refresh(s, NOW);
  return { s, LARK };
}

test('suggestions: a payer of the reporting app whose latest deposit waits for its mark is not suggested as Steady pay, before or after the app is filed', () => {
  const { s, LARK } = appPayer();
  const deps = s.txs.filter((tx) => tx.raw === LARK).sort((a, b) => (a.day < b.day ? -1 : 1));
  const look = lookOf(s);
  assert.equal((look.paired.get(deps[deps.length - 1].id) || []).length, 0, 'the latest deposit is not paired yet');
  assert.ok((look.paired.get(deps[deps.length - 2].id) || []).length, 'the earlier ones are');
  const before = suggestions(s, NOW).shown;
  assert.deepEqual(before.map((one) => one.key[0] + ':' + one.kind), ['r:job'], 'only the app is suggested');
  const job = acceptOffer(s, before[0], NOW + MIN, nid());
  assert.ok(job);
  assert.deepEqual(suggestions(s, NOW + MIN).shown, [], 'nothing once the app is filed');
  // the waiting deposit is asked about under its payer; the payer's deposits filed through the app make the guess
  const it = depositQueue(s, NOW + MIN).items.find((one) => one.kind === 'payer');
  assert.ok(it && it.count === 1, 'one deposit waits');
  assert.equal(it.guess, job, 'the first chip is the app\'s source');
});

test('In and out: a payer of the reporting app filed to By the job is no pay, so a deposit waiting for its mark changes nothing', () => {
  const read = (markLast) => {
    const { s, LARK } = appPayer({ payroll: true, cents: 9500, markLast });
    const app = suggestions(s, NOW).shown.find((one) => one.key[0] === 'r');
    assert.ok(acceptOffer(s, app, NOW + MIN, nid()));
    const stream = s.streams.find((one) => one.mkey === txOf(s, LARK).mkey);
    return { s, stream };
  };
  const waiting = read(false);
  const marked = read(true);
  for (const days of [30, 90]) {
    const a = inAndOut(waiting.s, NOW + 2 * MIN, days);
    const b = inAndOut(marked.s, NOW + 2 * MIN, days);
    assert.equal(a.in.cents, b.in.cents, days + ' days: the same money');
    assert.equal(a.in.change, b.in.change, days + ' days: the same change, waiting or marked');
    const sa = moneyInBySource(waiting.s, NOW + 2 * MIN, days);
    assert.equal(sa.earned.change, moneyInBySource(marked.s, NOW + 2 * MIN, days).earned.change, days + ' days: All earned');
    assert.equal(sa.earned.change, a.in.change, days + ' days: All earned reads In and out\'s change (no Windfalls here)');
  }
  for (const { s, stream } of [waiting, marked]) {
    assert.ok(stream, 'detection found the payer');
    assert.ok(!makeLedger(s, NOW + 2 * MIN).payStreams().some((one) => one.id === stream.id), 'no pay once its app is filed to By the job');
    assert.ok(makeLedger(s, NOW + 2 * MIN).payStreams().some((one) => /Northwind/.test(one.name)), 'the payroll is still pay');
  }
});

test('paydays: two live pay streams in one Steady pay source are compared payer by payer, as unfiled', () => {
  const OTHER = 'HARBOR LIGHT CAFE PAYROLL PPD ID: 7781';
  const STIPEND = 'NORTHWIND TOOLING STIPEND PPD ID: 4456';
  const make = (kind, shift) => {
    const s = bankRecord();
    const start = addDays(TODAY, -500 + shift);
    for (const d of every(start, TODAY, 14)) row(s, d, 210000, PAYROLL);
    if (kind === 'two') for (const d of every(addDays(start, 7), TODAY, 14)) row(s, d, 60000, OTHER);
    else for (let k = 0; k < 17; k++) { const d = addDays(TODAY, -(k * 30) - 3 - (shift % 30)); if (d >= start) row(s, d, 15000, STIPEND); }
    refresh(s, NOW);
    return s;
  };
  for (const [kind, days, shift] of [['two', 30, 0], ['two', 30, 2], ['two', 90, 0], ['two', 90, 4], ['two', 90, 6], ['stipend', 30, 7], ['stipend', 90, 5]]) {
    const unfiled = make(kind, shift);
    const s = make(kind, shift);
    const id = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
    let t = NOW;
    for (const raw of [PAYROLL, kind === 'two' ? OTHER : STIPEND]) assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, raw).mkey) }, id, (t += MIN)));
    const label = kind + ', ' + days + ' days, shift ' + shift;
    const was = inAndOut(unfiled, NOW + 10 * MIN, days);
    assert.equal(was.in.change, 0, label + ': unfiled, every amount the same: no change');
    const io = inAndOut(s, NOW + 10 * MIN, days);
    assert.equal(io.in.change, was.in.change, label + ': In and out reads one change, filed or not');
    const sec = moneyInBySource(s, NOW + 10 * MIN, days);
    assert.equal(sec.rows.find((r) => r.id === id).change, was.in.change, label + ': the source');
    assert.equal(sec.earned.change, was.in.change, label + ': All earned');
    if (kind === 'two' && days === 90 && shift === 0) {
      assert.deepEqual(io.paydays.streams.filter((one) => one.extra).map((one) => one.extra).sort(), [-1, 1], 'each payer\'s caption, never netted');
      assert.equal(sec.rows.find((r) => r.id === id).paydays.mixed, true, 'the source\'s row says its payers differ');
    }
  }
});

test('suggestions: a monthly royalty payer is suggested once, as Back-end; money a built-in rule files to Windfalls is not suggested as Steady pay', () => {
  const ROYALTY = 'FERNHOLLOW IMAGES CONTRIBUTOR PAY';
  for (const [raw, step, cents] of [[ROYALTY, 30, (k) => 18000 + (k % 3) * 4000], ['STATE UNEMPLOYMENT INS BENEFIT', 7, () => 41000], ['NORTHWIND TOOLING EXPENSE REIMB', 30, () => 15000]]) {
    const s = bankRecord();
    let k = 0;
    for (const d of every(addDays(TODAY, -170), addDays(TODAY, -2), step)) row(s, d, cents(k++), raw);
    refresh(s, NOW);
    // the built-in royalties rule names real payers only; here it is said to have filed this invented one
    if (raw === ROYALTY) for (const tx of s.txs) tx.ruleId = 'builtin:royalties';
    const tx = txOf(s, raw);
    assert.ok(makeLedger(s, NOW).payStreams().some((one) => one.id === tx.streamId), raw + ': detection reads it as pay');
    const shown = suggestions(s, NOW).shown.map((one) => one.key[0] + ':' + one.kind);
    if (raw === ROYALTY) assert.deepEqual(shown, ['p:backend'], 'one suggestion, as Back-end');
    else {
      assert.equal(filed(s, tx).how, 'rule', raw + ': Windfalls by a built-in rule');
      assert.deepEqual(shown, [], raw + ': not suggested as Steady pay');
    }
  }
});

test('suggestions: a payroll paid into two accounts is suggested once; Not now and Restore take both', () => {
  const s = bankRecord();
  for (const d of every(addDays(TODAY, -165), addDays(TODAY, -3), 14)) { row(s, d, 180000, PAYROLL); row(s, d, 30000, PAYROLL, { account: 'acc_sav' }); }
  refresh(s, NOW);
  assert.equal(makeLedger(s, NOW).payStreams().length, 2, 'two pay streams, one an account');
  const shown = suggestions(s, NOW).shown;
  assert.equal(shown.length, 1, 'one payer, one suggestion');
  assert.ok(dismissOffer(s, shown[0].keys, NOW + MIN), 'Not now');
  const after = suggestions(s, NOW + MIN);
  assert.deepEqual([after.shown.length, after.dismissed.length], [0, 1], 'Not now leaves no suggestion of it');
  assert.ok(restoreOffer(s, after.dismissed[0].keys, NOW + 2 * MIN), 'Restore');
  assert.deepEqual(suggestions(s, NOW + 2 * MIN).shown.map((one) => one.key), [shown[0].key], 'shown again, once');
  // a dismissal of either key (one device that held only one account's stream) keeps it dismissed
  const one = bankRecord();
  for (const d of every(addDays(TODAY, -165), addDays(TODAY, -3), 14)) { row(one, d, 180000, PAYROLL); row(one, d, 30000, PAYROLL, { account: 'acc_sav' }); }
  refresh(one, NOW);
  const keys = suggestions(one, NOW).shown[0].keys;
  assert.equal(keys.length, 2);
  assert.ok(dismissOffer(one, keys[1], NOW + MIN));
  assert.deepEqual([suggestions(one, NOW + MIN).shown.length, suggestions(one, NOW + MIN).dismissed.length], [0, 1]);
});

test('the deposit\'s sheet names the app its All from this app files: a paired deposit\'s, a reported payment\'s; none for one not paired', () => {
  const { s, LARK } = appPayer();
  const deps = s.txs.filter((tx) => tx.raw === LARK).sort((a, b) => (a.day < b.day ? -1 : 1));
  assert.equal(appNameOf(s, deps[deps.length - 2]), 'Sitting', 'a deposit paired with the app\'s payments');
  assert.equal(appNameOf(s, deps[deps.length - 1]), '', 'the deposit that waits for its mark');
  const reported = base();
  reportIn(reported, [item('c1', 'p-rook', 7000, addDays(TODAY, -5))]);
  answerPayer(reported, 'sessions', 'p-rook', 'cash', NOW);
  refresh(reported, NOW);
  const cash = reported.txs.find((tx) => tx.source === 'manual' && tx.via === 'income');
  assert.ok(cash, 'a payment in cash');
  assert.equal(appNameOf(reported, cash), 'Sitting');
});

/* ------------------------------------------------------------------ fixes, round 4 */

test('round 4: a new source named from the payroll\'s queue item opens on Steady pay, so Save leaves pay, the live number and In and out as they were', () => {
  const make = () => {
    const s = bankRecord();
    s.settings.smoothing = true;
    // a payroll every 14 days, the latest 9 days ago: 9 days of pay earned and not yet paid; a client who is no pay
    for (let d = addDays(TODAY, -9); d >= addDays(TODAY, -261); d = addDays(d, -14)) row(s, d, 214327, PAYROLL);
    row(s, addDays(TODAY, -20), 15000, ZELLE_A);
    refresh(s, NOW);
    return s;
  };
  const read = (s) => {
    const ledger = makeLedger(s, NOW);
    return { live: ledger.position().live, next: ledger.clock().nextPayday, pay: ledger.payStreams().map((one) => one.id),
      in30: inAndOut(s, NOW, 30).in.change, in90: inAndOut(s, NOW, 90).in.change };
  };
  const s = make();
  const before = read(s);
  assert.ok(before.next && before.pay.length === 1, 'the payroll is pay, with a payday');
  const payKey = merchantKeyOf(txOf(s, PAYROLL).mkey);
  const items = depositQueue(s, NOW).items;
  const payroll = items.find((one) => one.intoKey === payKey);
  assert.equal(payroll.newKind, 'steady', 'the payroll\'s form opens on Steady pay');
  assert.equal(items.find((one) => one.intoKey === merchantKeyOf(txOf(s, ZELLE_A).mkey)).newKind, 'job', 'a client who is no pay: By the job');
  // the pay before the decision, as a snapshot (round 5: the update changes the record in place, its accrual included)
  const pay = clone(makeLedger(s, NOW).payStreams());
  assert.ok(fileToNew(s, payroll, { name: inletName(payroll.merchant), kind: payroll.newKind }, NOW + MIN, nid()), 'Save with the form as it opens');
  assert.deepEqual(read(s), before, 'pay, the live number, the payday and In and out\'s change at 30 and 90 days unchanged');
  assert.deepEqual(payEnded(pay, s, NOW), [], 'no pay ended: the toast adds nothing');
  // By the job instead ends the payroll's pay (the pay fix), and the toast names it, by its Undo
  const t = make();
  const pay2 = clone(makeLedger(t, NOW).payStreams());
  const item2 = depositQueue(t, NOW).items.find((one) => one.intoKey === payKey);
  assert.ok(fileToNew(t, item2, { name: 'Northwind', kind: 'job' }, NOW + MIN, nid()));
  assert.equal(makeLedger(t, NOW).clock().nextPayday, null);
  assert.notEqual(makeLedger(t, NOW).position().live, before.live, 'the pay earned since the payday leaves the live number');
  assert.deepEqual(payEnded(pay2, t, NOW), [pay2[0].name], 'the pay it ended, by name');
  // a royalty payer's form opens on Back-end, as its suggestion
  const r = bankRecord();
  for (const d of every(addDays(TODAY, -200), addDays(TODAY, -2), 30)) row(r, d, 18000, 'FERNHOLLOW IMAGES CONTRIBUTOR PAY');
  refresh(r, NOW);
  // the built-in royalties rule names real payers only; here it is said to have filed this invented one
  for (const tx of r.txs) tx.ruleId = 'builtin:royalties';
  assert.equal(depositQueue(r, NOW).items.find((one) => one.kind === 'payer').newKind, 'backend');
  // a client of the reporting app that detection reads as pay, its latest deposit waiting for its mark: By the job, as its
  // app (it is never suggested as Steady pay)
  const { s: app, LARK } = appPayer();
  assert.ok(makeLedger(app, NOW).payStreams().some((one) => one.mkey === txOf(app, LARK).mkey), 'a pay stream');
  assert.deepEqual(depositQueue(app, NOW).items.map((one) => one.kind + ':' + one.newKind).sort(), ['app:job', 'payer:job']);
});

test('round 4: a payment your other app reported, filed on its own before its deposit reached the bank, can be put back to Not yet filed from the deposit\'s sheet', () => {
  const s = bankRecord();
  const LARK = 'Zelle payment from LARK FENN 9001';
  for (let k = 1; k <= 4; k++) row(s, addDays(TODAY, -40 + 7 * k + 1), 9000, LARK);
  refresh(s, NOW);
  const items = [];
  for (let k = 1; k <= 4; k++) items.push(item('e' + k, 'p-lark', 9000, addDays(TODAY, -40 + 7 * k)));
  items.push(item('late', 'p-lark', 12000, addDays(TODAY, -3)));
  const early = NOW - 2 * 86400000;
  reportIn(s, items, early);
  refresh(s, early);
  const x = makeInlet(s, { name: 'Workshops', kind: 'oneoff' }, early, nid());
  const y = makeInlet(s, { name: 'Classes', kind: 'job' }, early, nid());
  const pay = s.txs.find((tx) => tx.source === 'manual' && tx.via === 'income' && tx.amount === 12000);
  assert.ok(fileDeposit(s, pay.id, x, 'one', early + MIN), 'filed on its own sheet, in pencil');
  // its Zelle reaches the bank and pairs with it: the payment's key files the deposit (G.3 rank 1)
  const dep = row(s, addDays(TODAY, -1), 12000, LARK);
  refresh(s, NOW);
  reportIn(s, items, NOW);
  refresh(s, NOW);
  const f = filed(s, dep);
  assert.deepEqual([f.to, f.how, f.key[0]], [x, 'deposit', 'q']);
  assert.ok(canUnfile(s, dep.id, 'one'), 'This deposit only offers Not yet filed');
  assert.ok(fileDeposit(s, dep.id, null, 'one', NOW + MIN), 'and it takes effect');
  assert.equal(filed(s, dep).to, null, 'Not yet filed');
  assert.ok(storedFlows(s).into[f.key].deleted, 'the payment\'s cell is the one removed');
  // a filing from the deposit's sheet still goes to the deposit's own key, the later stamp deciding
  assert.ok(fileDeposit(s, dep.id, y, 'one', NOW + 2 * MIN));
  assert.deepEqual([filed(s, dep).to, filed(s, dep).key[0]], [y, 'i']);
});

test('round 4: Restore on a device that holds one of a payroll\'s two streams shows the suggestion on the device that holds both', async () => {
  // a payroll into checking every 14 days and into savings every 28: B's 45 days hold too few savings deposits for a stream
  const record = (days) => {
    const s = bankRecord();
    for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -days); d = addDays(d, -14)) row(s, d, 180000, PAYROLL);
    for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -days); d = addDays(d, -28)) row(s, d, 30000, PAYROLL, { account: 'acc_sav' });
    refresh(s, NOW);
    return s;
  };
  let t = NOW;
  const a = deviceOf(record(300), () => t);
  const b = deviceOf(record(45), () => t);
  const repo = memory();
  await settle([a, b], repo);
  const offerOf = (d) => [...suggestions(d.state, NOW).shown, ...suggestions(d.state, NOW).dismissed].find((one) => one.kind === 'steady');
  const state = (d) => (suggestions(d.state, NOW).shown.some((one) => one.kind === 'steady') ? 'shown' : 'dismissed');
  assert.deepEqual([offerOf(a).keys.length, offerOf(b).keys.length], [2, 1], 'A holds both streams, B one');
  t += MIN;
  update(a, (s) => dismissOffer(s, offerOf(a).keys, t), 'not now');
  await settle([a, b], repo);
  assert.deepEqual([state(a), state(b)], ['dismissed', 'dismissed'], 'Not now on A');
  t += MIN;
  update(b, (s) => restoreOffer(s, offerOf(b).keys, t), 'restore');
  await settle([a, b], repo);
  assert.deepEqual([state(a), state(b)], ['shown', 'shown'], 'Restore on B shows it on both');
  // B's Not now of its one key reads as dismissed on A too (round 3)
  t += MIN;
  update(b, (s) => dismissOffer(s, offerOf(b).keys, t), 'not now');
  await settle([a, b], repo);
  assert.deepEqual([state(a), state(b)], ['dismissed', 'dismissed'], 'Not now on B');
  // and A's Restore of both
  t += MIN;
  update(a, (s) => restoreOffer(s, offerOf(a).keys, t), 'restore');
  await settle([a, b], repo);
  assert.deepEqual([state(a), state(b)], ['shown', 'shown'], 'Restore on A');
});

test('round 4: one older payroll deposit filed on its own leaves the payroll suggested; its latest deposit filed so still ends it', () => {
  for (const to of [WINDFALL, 'steady', 'job']) {
    const s = bankRecord();
    for (let d = addDays(TODAY, -1); d >= addDays(TODAY, -180); d = addDays(d, -14)) row(s, d, 210000, PAYROLL);
    refresh(s, NOW);
    assert.ok(suggestions(s, NOW).shown.some((one) => one.key[0] === 's'), to + ': suggested');
    const deps = s.txs.filter((tx) => tx.raw === PAYROLL).sort((p, q) => (p.day < q.day ? -1 : 1));
    const target = to === WINDFALL ? WINDFALL : makeInlet(s, { name: 'One paycheck', kind: to }, NOW, nid());
    assert.ok(fileDeposit(s, deps[3].id, target, 'one', NOW + MIN), to + ': an older deposit on its own');
    assert.ok(suggestions(s, NOW + MIN).shown.some((one) => one.key[0] === 's'), to + ': still suggested, its payer filed nowhere');
    assert.ok(fileDeposit(s, deps[deps.length - 1].id, target, 'one', NOW + 2 * MIN), to + ': the latest on its own');
    assert.ok(!suggestions(s, NOW + 2 * MIN).shown.some((one) => one.key[0] === 's'), to + ': no longer suggested (round 2)');
  }
});

test('round 4: a goal that is not an amount has its own message; 0 or nothing clears it', () => {
  assert.equal(goalCents(''), null);
  assert.equal(goalCents('0'), null, '0 clears a goal');
  assert.equal(goalCents('0.00'), null);
  assert.equal(goalCents('1,500'), 150000);
  assert.equal(goalCents('$45.50'), 4550);
  for (const bad of ['abc', '-5', '12.345', '1k']) assert.ok(Number.isNaN(goalCents(bad)), bad + ' is no amount');
});

test('round 4: older builds (8d013da and f414276) read every cell the round-4 actions write and write it back unchanged', async (t) => {
  // a payment's filing put back to Not yet filed from its deposit's sheet, then Undone; a source named from the queue as
  // Steady pay; a goal cleared with 0; Not now on a payroll's two keys, and Restore on one
  const s = bankRecord();
  const LARK = 'Zelle payment from LARK FENN 9001';
  for (let k = 1; k <= 4; k++) row(s, addDays(TODAY, -40 + 7 * k + 1), 9000, LARK);
  for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -300); d = addDays(d, -14)) row(s, d, 180000, PAYROLL);
  for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -300); d = addDays(d, -28)) row(s, d, 30000, PAYROLL, { account: 'acc_sav' });
  refresh(s, NOW);
  const items = [];
  for (let k = 1; k <= 4; k++) items.push(item('e' + k, 'p-lark', 9000, addDays(TODAY, -40 + 7 * k)));
  items.push(item('late', 'p-lark', 12000, addDays(TODAY, -3)));
  const early = NOW - 2 * 86400000;
  reportIn(s, items, early);
  refresh(s, early);
  const x = makeInlet(s, { name: 'Workshops', kind: 'oneoff' }, early, nid());
  assert.ok(fileDeposit(s, s.txs.find((tx) => tx.source === 'manual' && tx.via === 'income' && tx.amount === 12000).id, x, 'one', early + MIN));
  const dep = row(s, addDays(TODAY, -1), 12000, LARK);
  refresh(s, NOW);
  reportIn(s, items, NOW);
  refresh(s, NOW);
  const d = deviceOf(s, () => NOW);
  update(d, (st) => fileDeposit(st, dep.id, null, 'one', NOW + MIN));
  d.clock = () => NOW + 2 * MIN;
  d.undo();
  update(d, (st) => fileDeposit(st, dep.id, null, 'one', NOW + 3 * MIN));
  const payroll = depositQueue(d.state, NOW).items.find((one) => one.newKind === 'steady');
  assert.ok(payroll, 'the payroll\'s item opens on Steady pay');
  const offer = suggestions(d.state, NOW).shown.find((one) => one.kind === 'steady');
  assert.equal(offer.keys.length, 2);
  update(d, (st) => dismissOffer(st, offer.keys, NOW + 4 * MIN));
  update(d, (st) => restoreOffer(st, offer.keys[0], NOW + 5 * MIN));
  const id = nid();
  update(d, (st) => fileToNew(st, payroll, { name: 'Day job', kind: payroll.newKind }, NOW + 6 * MIN, id));
  update(d, (st) => editInlet(st, id, { goal: { per: 'month', cents: 400000 } }, NOW + 7 * MIN));
  update(d, (st) => editInlet(st, id, { goal: goalCents('0') }, NOW + 8 * MIN));
  const section = exportFlows(d.state, NOW + 40 * MIN);
  const q = Object.entries(section.into).filter(([key]) => key[0] === 'q');
  assert.ok(q.some(([, cell]) => cell.deleted && typeof cell.day === 'string'), 'a payment\'s cell removed from its deposit\'s sheet, with its day');
  assert.equal(section.inlets[id].kind.v, 'steady');
  assert.ok(section.inlets[id].goal.deleted, 'a goal cleared with 0 is a removal');
  assert.deepEqual(readFlows(section), section, 'this build reads it');
  await oldBuildsTake(t, section);
});

/* ------------------------------------------------------------------ round 5 */

test('round 5, as round 7 reads it: a cash-out or cheque read as pay stops being pay at the second of its deposits filed away; a Zelle client at Steady pay stays pay', () => {
  // In and out's Money in change and All earned's change, at 30 and 90 days
  const read = (s) => Object.fromEntries([30, 90].map((days) => [days, { io: inAndOut(s, NOW, days).in.change, earned: moneyInBySource(s, NOW, days).earned.change }]));
  const payIds = (s) => makeLedger(s, NOW).payStreams().map((one) => one.id);
  // In and out once a stream is no pay: the unfiled reading plus what its like with like left out (PAYDAYS (c))
  const withoutStream = (s, stream) => Object.fromEntries([30, 90].map((days) => {
    const io = inAndOut(s, NOW, days);
    const one = io.paydays.streams.find((x) => x.id === stream);
    return [days, io.in.change + (one ? one.left : 0)];
  }));
  // a weekly cash-out (a catch-all key, filed one deposit at a time) that detection reads as pay: the queue's 4 newest
  // filed to a By the job source, the rest left
  {
    const CASHOUT = 'VENMO CASHOUT PPD ID: 5264681992';
    const s = bankRecord();
    for (let d = addDays(TODAY, -6); d >= addDays(TODAY, -250); d = addDays(d, -14)) row(s, d, 214327, PAYROLL);
    for (let d = addDays(TODAY, -1); d >= addDays(TODAY, -250); d = addDays(d, -7)) row(s, d, 30000, CASHOUT);
    refresh(s, NOW);
    const stream = txOf(s, CASHOUT).streamId;
    const payroll = txOf(s, PAYROLL).streamId;
    assert.ok(payIds(s).includes(stream), 'the cash-out is read as pay');
    const unfiled = read(s);
    const ended = withoutStream(s, stream);
    for (const days of [30, 90]) assert.equal(unfiled[days].earned, unfiled[days].io, days + ': unfiled, All earned reads In and out');
    const job = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    let n = 0;
    for (const one of depositQueue(s, NOW).items.filter((x) => x.kind === 'one')) {
      const before = clone(makeLedger(s, NOW).payStreams());
      const main = makeLedger(s, NOW).payMain();
      assert.ok(fileQueueItem(s, one, n < 4 ? job : LEAVE, NOW + (n + 1) * MIN));
      n += 1;
      if (n === 1) {
        assert.ok(payIds(s).includes(stream), 'one filed away: still pay (one deposit cannot tell a cash-out from a payroll\'s odd one)');
        assert.deepEqual(read(s), unfiled, 'one filed: In and out and All earned as unfiled');
        assert.deepEqual(payEnded(before, s, NOW, main), [], 'no pay ended');
      }
      if (n === 2) {
        assert.ok(!payIds(s).includes(stream), 'the second filed away ends its pay');
        assert.deepEqual(payEnded(before, s, NOW, main), [before.find((x) => x.id === stream).name], 'the toast names it');
        assert.equal(s.streams.find((x) => x.id === stream).accrue, false, 'it no longer accrues');
        assert.equal(makeLedger(s, NOW).payMain(), payroll, 'the payroll sets the payday');
      }
    }
    assert.ok(n > 4);
    assert.ok(!payIds(s).includes(stream), 'Leave it on the rest changes nothing: no pay');
    const after = read(s);
    for (const days of [30, 90]) {
      assert.equal(after[days].io, ended[days], days + ': In and out reads the cash-out as money');
      assert.equal(after[days].earned, after[days].io, days + ': All earned = In and out, no Windfalls');
    }
    assert.ok(!inAndOut(s, NOW, 30).paydays.streams.some((one) => one.id === stream), 'no payday of it in the caption');
    // one filed to Windfalls on its own: still pay, In and out as unfiled
    const t = bankRecord();
    for (let d = addDays(TODAY, -6); d >= addDays(TODAY, -250); d = addDays(d, -14)) row(t, d, 214327, PAYROLL);
    for (let d = addDays(TODAY, -1); d >= addDays(TODAY, -250); d = addDays(d, -7)) row(t, d, 30000, CASHOUT);
    refresh(t, NOW);
    assert.ok(fileDeposit(t, txOf(t, CASHOUT, addDays(TODAY, -8)).id, WINDFALL, 'one', NOW + 99 * MIN));
    assert.ok(payIds(t).includes(txOf(t, CASHOUT).streamId), 'one cash-out to Windfalls: still pay');
    assert.equal(inAndOut(t, NOW, 30).in.change, unfiled[30].io, 'one filed to Windfalls: In and out as unfiled');
  }
  // a cheque every 14 days (a catch-all), filed one at a time from the queue to By the job, newest first; then the same
  // record with 4 filed to One-off and the rest left
  {
    const make = () => {
      const s = bankRecord();
      for (let d = addDays(TODAY, -6); d >= addDays(TODAY, -250); d = addDays(d, -14)) row(s, d, 214327, PAYROLL);
      for (let d = addDays(TODAY, -2); d >= addDays(TODAY, -250); d = addDays(d, -14)) row(s, d, 40000, CHEQUE);
      refresh(s, NOW);
      return s;
    };
    const s = make();
    const stream = txOf(s, CHEQUE).streamId;
    assert.ok(payIds(s).includes(stream), 'the cheque is read as pay');
    const unfiled = read(s);
    const ended = withoutStream(s, stream);
    const job = makeInlet(s, { name: 'Tutoring', kind: 'job' }, NOW, nid());
    for (let k = 0; k < 8; k++) {
      const one = depositQueue(s, NOW).items.filter((x) => x.kind === 'one').sort((a, b) => (a.last < b.last ? 1 : -1))[0];
      assert.ok(fileQueueItem(s, one, job, NOW + (k + 1) * MIN));
      if (k === 0) assert.deepEqual(read(s), unfiled, '1 filed: as unfiled');
      else assert.deepEqual(Object.fromEntries(Object.entries(read(s)).map(([days, r]) => [days, r.io])), ended, (k + 1) + ' filed: the cheque reads as money');
    }
    const t = make();
    const job2 = makeInlet(t, { name: 'Tutoring', kind: 'oneoff' }, NOW, nid());
    depositQueue(t, NOW).items.filter((x) => x.kind === 'one').forEach((one, k) => assert.ok(fileQueueItem(t, one, k < 4 ? job2 : LEAVE, NOW + (k + 1) * MIN)));
    assert.ok(!payIds(t).includes(stream), '4 filed to One-off, the rest left: no pay');
    assert.deepEqual(Object.fromEntries(Object.entries(read(t)).map(([days, r]) => [days, r.io])), ended, '4 to One-off: the cheque reads as money');
  }
  // a weekly Zelle client the owner names Steady pay, two of its deposits then filed on their own to a By the job source
  // (This deposit only, for a sender who pays toward two sources): its named key and its payer's filing keep it pay; In
  // and out reads as unfiled; the source they left compares its own paydays and counts the one of this window in other
  // rows, and the one they went to takes the money
  {
    const CLIENT = 'Zelle payment from TAMSIN OKORO 55120';
    const s = bankRecord();
    for (let d = addDays(TODAY, -9); d >= addDays(TODAY, -261); d = addDays(d, -14)) row(s, d, 214327, PAYROLL);
    for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -200); d = addDays(d, -7)) row(s, d, 15000, CLIENT);
    refresh(s, NOW);
    assert.ok(payIds(s).includes(txOf(s, CLIENT).streamId), 'the client is read as pay');
    const unfiled = read(s);
    const coaching = makeInlet(s, { name: 'Coaching', kind: 'steady' }, NOW, nid());
    assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, CLIENT).mkey) }, coaching, NOW + MIN));
    assert.deepEqual(read(s), unfiled, 'the payer filed to Steady pay: as unfiled');
    const repairs = makeInlet(s, { name: 'Repairs', kind: 'job' }, NOW + 2 * MIN, nid());
    const two = s.txs.filter((tx) => tx.raw === CLIENT).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(1, 3);
    two.forEach((tx, k) => assert.ok(fileDeposit(s, tx.id, repairs, 'one', NOW + (3 + k) * MIN)));
    assert.ok(payIds(s).includes(txOf(s, CLIENT).streamId), 'still pay: a named key, its payer at Steady pay');
    const io = read(s);
    for (const days of [30, 90]) assert.equal(io[days].io, unfiled[days].io, days + ': In and out as unfiled');
    for (const days of [30, 90]) {
      const sec = moneyInBySource(s, NOW, days);
      const row1 = (id) => sec.rows.find((one) => one.id === id);
      assert.equal(row1(repairs).change, 30000, days + ': Repairs takes the money');
      // its own paydays: the two moved deposits fall in the period (10 and 17 days ago), so it reads two paydays fewer
      assert.equal(row1(coaching).paydays.elsewhere, 2, days + ': Coaching counts the two in other rows');
      assert.equal(sec.earned.change, io[days].earned, days + ': All earned unchanged by the move');
      assert.equal(sec.earned.change, sec.window.comparable ? inAndOut(s, NOW, days).in.change - sec.windfalls.change : null, days + ': All earned = In and out - Windfalls');
    }
  }
});

test('round 5: a regular Zelle client read as pay opens on By the job, in the queue and as a suggestion; Add ends that read, and the payroll stays Steady pay', () => {
  const CLIENT = 'Zelle payment from TAMSIN OKORO 55120';
  const s = bankRecord();
  for (let d = addDays(TODAY, -9); d >= addDays(TODAY, -261); d = addDays(d, -14)) row(s, d, 214327, PAYROLL);
  for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -200); d = addDays(d, -7)) row(s, d, 15000, CLIENT);
  refresh(s, NOW);
  const client = txOf(s, CLIENT).streamId;
  const pay = clone(makeLedger(s, NOW).payStreams());
  assert.ok(pay.some((one) => one.id === client && one.accrue), 'detection reads the client as accruing pay (G.7.2\'s wrong read)');
  const items = depositQueue(s, NOW).items;
  assert.equal(items.find((one) => one.intoKey === merchantKeyOf(txOf(s, CLIENT).mkey)).newKind, 'job', 'a Zelle sender: By the job');
  assert.equal(items.find((one) => one.intoKey === merchantKeyOf(txOf(s, PAYROLL).mkey)).newKind, 'steady', 'the payroll: Steady pay');
  const shown = suggestions(s, NOW).shown;
  const offer = shown.find((one) => one.intoKey === merchantKeyOf(txOf(s, CLIENT).mkey));
  assert.deepEqual([offer.kind, offer.why], ['job', 'client'], 'suggested as By the job, worded as a sender');
  assert.deepEqual(shown.find((one) => one.intoKey === merchantKeyOf(txOf(s, PAYROLL).mkey)).kind, 'steady');
  const main = makeLedger(s, NOW).payMain();
  assert.ok(acceptOffer(s, offer, NOW + MIN, nid()));
  const after = makeLedger(s, NOW).payStreams().map((one) => one.id);
  assert.ok(!after.includes(client), 'Add ends the client\'s read as pay');
  assert.ok(after.includes(txOf(s, PAYROLL).streamId), 'the payroll is still pay');
  assert.deepEqual(payEnded(pay, s, NOW, main), [pay.find((one) => one.id === client).name], 'the toast names it, by its Undo');
});

test('round 5: the toast names only the pay that accrued or set the payday: a reporting app\'s payer read as pay is not named when the app is filed', () => {
  const { s, LARK } = appPayer({ payroll: true, markLast: true });
  const ledger = makeLedger(s, NOW);
  const pay = clone(ledger.payStreams());
  const main = ledger.payMain();
  const next = ledger.clock().nextPayday;
  const lark = pay.find((one) => one.mkey === txOf(s, LARK).mkey);
  const payroll = pay.find((one) => one.mkey === txOf(s, PAYROLL).mkey);
  assert.ok(lark && !lark.accrue, 'the payer is a pay stream that never accrued (its payments claim its deposits)');
  assert.ok(payroll && payroll.accrue && main === payroll.id, 'the payroll accrues and sets the payday');
  const offer = suggestions(s, NOW).shown.find((one) => one.key[0] === 'r');
  assert.ok(acceptOffer(s, offer, NOW + MIN, nid()));
  assert.ok(!makeLedger(s, NOW).payStreams().some((one) => one.id === lark.id), 'filing the app ends the payer\'s read as pay (round 3)');
  assert.equal(makeLedger(s, NOW).clock().nextPayday, next, 'the payday does not move');
  assert.deepEqual(payEnded(pay, s, NOW, main), [], 'no note: it never set the payday nor counted as earned');
  assert.deepEqual(payEndedStreams(pay, s, NOW, main), []);
  // before round 5 every pay stream that ended was named
  assert.deepEqual(payEndedStreams(pay.map((one) => ({ ...one, accrue: true })), s, NOW, main).map((one) => one.id), [lark.id]);
  // with no accruing payroll, the payer set the payday: the note is true of it, and names it
  const { s: t, LARK: L2 } = appPayer({ markLast: true });
  const l2 = makeLedger(t, NOW);
  const pay2 = clone(l2.payStreams());
  const main2 = l2.payMain();
  const only = pay2.find((one) => one.mkey === txOf(t, L2).mkey);
  assert.equal(main2, only.id, 'the payday is the payer\'s');
  assert.ok(acceptOffer(t, suggestions(t, NOW).shown.find((one) => one.key[0] === 'r'), NOW + MIN, nid()));
  assert.deepEqual(payEnded(pay2, t, NOW, main2), [only.name]);
});

test('round 5: the Remove confirm\'s count: a source\'s bank deposits apart from the payments your other app reported, cash and pencil', () => {
  const s = base();
  row(s, addDays(TODAY, -5), 9000, 'Zelle payment from LARK FENN 5512');
  row(s, addDays(TODAY, -370), 9000, 'Zelle payment from LARK FENN 5512'); // a regular of the app (round 9, F2), before the 12 months
  refresh(s, NOW);
  reportIn(s, [item('a0', 'p-lark', 9000, addDays(TODAY, -371)), item('a1', 'p-lark', 9000, addDays(TODAY, -6)), item('a2', 'p-rook', 7000, addDays(TODAY, -4)), item('a3', 'p-lark', 6000, addDays(TODAY, -1))]);
  answerPayer(s, 'sessions', 'p-rook', 'cash', NOW);
  refresh(s, NOW);
  const id = makeInlet(s, { name: 'Portraits', kind: 'job' }, NOW, nid());
  assert.ok(fileDeposit(s, txOf(s, 'Zelle payment from LARK FENN 5512').id, id, 'all', NOW + MIN), 'the app, through its paired deposit');
  const one = moneyInBySource(s, NOW, 30).rows.find((r) => r.id === id);
  assert.equal(one.cash, 7000);
  assert.equal(one.pencil, 6000);
  assert.deepEqual([one.year.deposits, one.year.payments], [1, 2], 'one bank deposit; a cash payment and a pencil payment');
});

test('round 5: a suggestion restored on a device that reads fewer of its payer\'s streams stays restored after 400 days, on a device that joins then', async (t0) => {
  // a payroll into checking every 14 days and into savings every 28: B's 45 days hold too few savings deposits for a stream
  const record = (days) => {
    const s = bankRecord();
    for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -days); d = addDays(d, -14)) row(s, d, 180000, PAYROLL);
    for (let d = addDays(TODAY, -3); d >= addDays(TODAY, -days); d = addDays(d, -28)) row(s, d, 30000, PAYROLL, { account: 'acc_sav' });
    refresh(s, NOW);
    return s;
  };
  const DAY = 86400000;
  let t = NOW;
  const a = deviceOf(record(300), () => t);
  const b = deviceOf(record(45), () => t);
  const repo = memory();
  await settle([a, b], repo);
  const offerOf = (d) => [...suggestions(d.state, NOW).shown, ...suggestions(d.state, NOW).dismissed].find((one) => one.kind === 'steady');
  const state = (d) => (suggestions(d.state, NOW).shown.some((one) => one.kind === 'steady') ? 'shown' : 'dismissed');
  const [k1, k2] = offerOf(a).keys;
  assert.deepEqual(offerOf(b).keys, [k1], 'A holds both streams, B one');
  // Not now on A and Restore on B, 399 days ago
  const past = NOW - 399 * DAY;
  update(a, (s) => dismissOffer(s, offerOf(a).keys, past), 'not now');
  await settle([a, b], repo);
  const offers = storedFlows(a.state).offers;
  assert.equal(offers[k1].at, offers[k2].at, 'Not now writes both keys at one stamp');
  update(b, (s) => restoreOffer(s, offerOf(b).keys, past + MIN), 'restore');
  await settle([a, b], repo);
  assert.deepEqual([state(a), state(b)], ['shown', 'shown']);
  assert.ok(storedFlows(b.state).offers[k2].deleted, 'B\'s Restore removes the dismissal its Not now wrote under the key B does not read');
  // pass 2's cell shapes: 8d013da and f414276 read and write back the section of both taps
  const section = exportFlows(b.state, NOW);
  assert.deepEqual(readFlows(section), section, 'this build reads it');
  await oldBuildsTake(t0, section);
  // 401 days after the taps: the removals no longer travel; a fresh deep device joins
  t = NOW + 2 * DAY;
  await settle([a, b], repo);
  t += MIN;
  update(a, (s) => makeInlet(s, { name: 'Photo shoots', kind: 'job' }, t, nid()), 'make');
  await settle([a, b], repo);
  const file = readSharedFile(repo.text);
  assert.ok(!Object.values((file.flows && file.flows.offers) || {}).some((cell) => !cell.deleted), 'no dismissal travels');
  const c = deviceOf(record(300), () => t);
  await settle([c, a, b], repo);
  assert.deepEqual([state(a), state(b), state(c)], ['shown', 'shown', 'shown'], 'all three show it');
  // a key of another suggestion this device makes, dismissed at the same stamp, is left as it is
  const s = record(300);
  const one = offerOf({ state: s });
  assert.ok(dismissOffer(s, one.keys, NOW));
  noteOfferAt(s, 'r0123456789abc', storedFlows(s).offers[k1].at);
  assert.ok(restoreOffer(s, [k1], NOW + MIN, [k1, 'r0123456789abc']));
  assert.ok(storedFlows(s).offers[k2].deleted && !storedFlows(s).offers.r0123456789abc.deleted, 'only the keys no suggestion here makes');
});

/* ------------------------------------------------------------------ round 6 */

test('round 6, as step 3 reads it (PAYDAYS section 9): a bonus or a correction worded as the payroll is a payday of In and out, as on f414276, filed or not, and none of Day job\'s when filed elsewhere; a paycheck filed on its own to Windfalls is a payday fewer in its source, and All earned and Windfalls show its money', () => {
  const read = (s, days) => {
    const sec = moneyInBySource(s, NOW, days);
    const io = inAndOut(s, NOW, days);
    return { sec, io: io.in.change, paydays: io.paydays, earned: sec.earned.change, wind: sec.windfalls.change, row: (id) => sec.rows.find((one) => one.id === id) };
  };
  // a payroll of $2,100 every 14 days, the latest 6 days ago, filed to Day job (Steady pay) from the queue
  const make = (extra, file = true) => {
    const s = bankRecord();
    for (let d = addDays(TODAY, -6); d >= addDays(TODAY, -300); d = addDays(d, -14)) row(s, d, 210000, PAYROLL);
    if (extra) row(s, addDays(TODAY, -10), extra, PAYROLL);
    refresh(s, NOW);
    const job = file ? makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid()) : null;
    if (file) assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, job, NOW + MIN));
    return { s, job };
  };
  const pay = (s) => makeLedger(s, NOW).payStreams().map((one) => one.id);
  // B: a $5,000 bonus worded as the payroll, 10 days ago: a payday of In and out, filed or not (f414276's +$1,933.33 /
  // +$2,900, PAYDAYS section 4 item 1, step 3b's); filed elsewhere it is no payday of Day job, which reads ±$0 and counts
  // it in another row; kept in Day job, Day job reads In and out's figure
  for (const kind of ['oneoff', 'job', null]) {
    const { s, job } = make(500000);
    const bonus = txOf(s, PAYROLL, addDays(TODAY, -10));
    assert.ok(pay(s).includes(bonus.streamId), 'detection links the bonus to the payroll, which stays pay');
    const other = kind ? makeInlet(s, { name: 'Bonus', kind }, NOW + 2 * MIN, nid()) : null;
    if (kind) assert.ok(fileDeposit(s, bonus.id, other, 'one', NOW + 3 * MIN));
    for (const days of [30, 90]) {
      const r = read(s, days);
      const label = (kind || 'kept in Day job') + ' ' + days;
      assert.equal(r.io, days === 30 ? 193333 : 290000, label + ': In and out f414276\'s +$1,933.33 / +$2,900');
      assert.deepEqual([r.paydays.now, r.paydays.before], days === 30 ? [3, 2] : [7, 7], label + ': the bonus is a payday of In and out');
      assert.equal(r.earned, r.io, label + ': All earned the same');
      assert.equal(r.row(job).paydays.now, days === 30 ? (kind ? 2 : 3) : (kind ? 6 : 7), label + ': Day job\'s own paydays');
      assert.equal(r.row(job).change, kind ? 0 : r.io, label + ': Day job ±$0 with its paychecks alike, or In and out\'s figure holding the bonus');
      if (kind === 'job') assert.equal(r.row(other).change, 500000, label + ': By the job takes it, deposit for deposit');
      assert.equal(r.row(job).paydays.elsewhere, kind ? 1 : 0, label + ': the bonus filed elsewhere is a payday in another row');
    }
  }
  // the payroll left unfiled: In and out the same
  {
    const { s } = make(500000, false);
    for (const days of [30, 90]) assert.equal(read(s, days).io, days === 30 ? 193333 : 290000, days + ': payroll unfiled, In and out the same');
  }
  // C: a $150 correction worded as the payroll, filed on its own to Windfalls: In and out f414276's -$1,300 / -$1,950,
  // Windfalls +$150, All earned -$1,450 / -$2,100, Day job ±$0 with the correction in another row
  {
    const { s, job } = make(15000);
    assert.ok(fileDeposit(s, txOf(s, PAYROLL, addDays(TODAY, -10)).id, WINDFALL, 'one', NOW + 2 * MIN));
    for (const days of [30, 90]) {
      const r = read(s, days);
      assert.equal(r.io, days === 30 ? -130000 : -195000, days + ': In and out -$1,300 / -$1,950');
      assert.equal(r.wind, 15000, days + ': Windfalls +$150');
      assert.equal(r.earned, days === 30 ? -145000 : -210000, days + ': All earned -$1,450 / -$2,100');
      assert.equal(r.row(job).change, 0, days + ': Day job ±$0');
      assert.equal(r.paydays.now, r.row(job).paydays.now + r.row(job).paydays.elsewhere, days + ': In and out\'s paydays are Day job\'s and the one in another row');
    }
  }
  // A: a regular paycheck, 20 days ago, filed This deposit only to Windfalls: In and out ±$0; Windfalls +$2,100 and All
  // earned -$2,100; Day job ±$0 with a payday fewer, the paycheck counted in another row (I6's exception)
  {
    const { s, job } = make();
    assert.ok(fileDeposit(s, txOf(s, PAYROLL, addDays(TODAY, -20)).id, WINDFALL, 'one', NOW + 2 * MIN));
    for (const days of [30, 90]) {
      const r = read(s, days);
      assert.equal(r.io, 0, days + ': In and out ±$0');
      assert.equal(r.wind, 210000, days + ': Windfalls +$2,100');
      assert.equal(r.earned, -210000, days + ': All earned -$2,100');
      assert.equal(r.row(job).change, 0, days + ': Day job ±$0');
      assert.deepEqual([r.row(job).paydays.now, r.row(job).paydays.before], days === 30 ? [1, 2] : [5, 7], days + ': a payday fewer in Day job');
      assert.equal(r.row(job).paydays.elsewhere, 1, days + ': 1 more in another row');
    }
  }
  // the queue's own Windfalls chip: a weekly $300 cash-out read as pay, the 2 newest to Windfalls, the next 2 to By the
  // job, the rest left: 4 of its 4 own filings away end its pay, and In and out reads it as money
  {
    const CASHOUT = 'VENMO CASHOUT PPD ID: 5264681992';
    const s = bankRecord();
    for (let d = addDays(TODAY, -6); d >= addDays(TODAY, -300); d = addDays(d, -14)) row(s, d, 214327, PAYROLL);
    for (let d = addDays(TODAY, -1); d >= addDays(TODAY, -300); d = addDays(d, -7)) row(s, d, 30000, CASHOUT);
    refresh(s, NOW);
    const stream = txOf(s, CASHOUT).streamId;
    assert.ok(pay(s).includes(stream), 'the cash-out is read as pay');
    const left = Object.fromEntries([30, 90].map((days) => { const io = inAndOut(s, NOW, days); return [days, io.in.change + io.paydays.streams.find((one) => one.id === stream).left]; }));
    const job = makeInlet(s, { name: 'Coaching', kind: 'job' }, NOW, nid());
    const items = depositQueue(s, NOW).items.filter((x) => x.kind === 'one').sort((a, b) => (a.last < b.last ? 1 : -1));
    items.forEach((one, k) => assert.ok(fileQueueItem(s, one, k < 2 ? WINDFALL : k < 4 ? job : LEAVE, NOW + (k + 1) * MIN)));
    assert.ok(!pay(s).includes(stream), 'no pay');
    for (const days of [30, 90]) {
      const r = read(s, days);
      assert.equal(r.io, left[days], days + ': In and out as unfiled plus the cash-out\'s left-out');
      assert.equal(r.wind, 60000, days + ': Windfalls +$600');
      assert.equal(r.earned, r.io - r.wind, days + ': All earned is In and out less Windfalls\' change');
    }
  }
});

test('round 6: a source paid only before the 12 months keeps a quiet row with the day it was last paid; only a source with no money on record is a prospect', () => {
  const s = bankRecord();
  for (let d = addDays(TODAY, -6); d >= addDays(TODAY, -800); d = addDays(d, -14)) row(s, d, 210000, PAYROLL);
  const GIG = 'Zelle payment from WEDDING PARTY 5';
  const PRIZE = 'Zelle payment from GALLERY ANNUAL 7';
  const OLD = 'Zelle payment from OLD STUDIO 9';
  const gig = row(s, addDays(TODAY, -400), 90000, GIG);
  row(s, addDays(TODAY, -736), 250000, PRIZE);
  const prize = row(s, addDays(TODAY, -371), 260000, PRIZE);
  row(s, addDays(TODAY, -500), 40000, OLD);
  refresh(s, NOW);
  const wedding = makeInlet(s, { name: 'Wedding gig', kind: 'oneoff' }, NOW, nid());
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, GIG).mkey) }, wedding, NOW + MIN));
  const gallery = makeInlet(s, { name: 'Gallery prize', kind: 'backend' }, NOW + 2 * MIN, nid());
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PRIZE).mkey) }, gallery, NOW + 3 * MIN));
  const studio = makeInlet(s, { name: 'Old studio', kind: 'job' }, NOW + 4 * MIN, nid());
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, OLD).mkey) }, studio, NOW + 5 * MIN));
  assert.ok(editInlet(s, studio, { gone: true }, NOW + 6 * MIN), 'archived');
  const apps = makeInlet(s, { name: 'App builds', kind: 'job' }, NOW + 7 * MIN, nid());
  for (const days of [30, 90, 365]) {
    const sec = moneyInBySource(s, NOW, days);
    const rowOf = (id) => sec.rows.find((one) => one.id === id);
    assert.deepEqual(sec.prospects.map((one) => one.id), [apps], days + ': only the source with no money on record is a prospect');
    assert.equal(rowOf(wedding).last, gig.day, days + ': Wedding gig keeps a quiet row, last paid 400 days ago');
    assert.equal(rowOf(gallery).last, prize.day, days + ': Gallery prize keeps a quiet row, last paid 371 days ago');
    assert.deepEqual([rowOf(wedding).cents, rowOf(wedding).year.cents, rowOf(wedding).share], [0, 0, 0], days + ': nothing in the period or the 12 months');
    assert.deepEqual(sec.archived.map((one) => one.id), [studio], days + ': an archived source with older money stays in the archive');
    // the row says when it was last paid, in both modes, and never "yet"
    for (const words of ['chess', 'finance']) {
      const helper = fileURLToPath(new URL('./helpers/inlets-words.mjs', import.meta.url));
      const [section, dev] = JSON.parse(execFileSync(process.execPath, [helper, JSON.stringify([
        ['inflows', 'inSection', { words }, sec, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0],
        ['inflows', 'devSection', { words }, sec],
      ])], { encoding: 'utf8' }));
      const li = (html, id) => (html.match(new RegExp('<li class="fl-in-row" data-key="' + id + '">[\\s\\S]*?</li>')) || [''])[0];
      const month = fmtMonth(sec.frame.months[0], 'short');
      assert.ok(li(section, wedding).includes(say('inlets.quiet', words, { m: 12, month, date: fmtDate(gig.day, 'medium') })), words + ' ' + days + ': Wedding gig, last paid');
      assert.ok(li(section, gallery).includes(say('inlets.quiet', words, { m: 12, month, date: fmtDate(prize.day, 'medium') })), words + ' ' + days + ': Gallery prize, last paid');
      assert.ok(!dev.includes('Wedding gig') && !dev.includes('Gallery prize') && dev.includes('App builds'), words + ' ' + days + ': Development lists App builds only');
    }
  }
  // a first deposit filed to a prospect moves it up
  row(s, addDays(TODAY, -3), 70000, 'Zelle payment from APP CLIENT 3');
  refresh(s, NOW);
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, 'Zelle payment from APP CLIENT 3').mkey) }, apps, NOW + 8 * MIN));
  assert.deepEqual(moneyInBySource(s, NOW, 30).prospects, [], 'App builds moves up');
});

test('round 6: a deposit\'s sheet offers the sources in the queue\'s order, by the year\'s money then name, whatever their ids', () => {
  const s = base();
  // three sources whose hidden ids run against their money
  const back = makeInlet(s, { name: 'Back catalogue', kind: 'job' }, NOW, 'n0000000000001');
  const client = makeInlet(s, { name: 'Client work', kind: 'job' }, NOW, 'n0000000000002');
  const day = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, 'n0000000000003');
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, day, NOW + MIN));
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, ZELLE_A).mkey) }, client, NOW + 2 * MIN));
  assert.ok(fileDeposit(s, txOf(s, CHEQUE, addDays(TODAY, -10)).id, back, 'one', NOW + 3 * MIN));
  const item1 = depositQueue(s, NOW).items.find((one) => one.txId === txOf(s, CHEQUE, addDays(TODAY, -40)).id);
  assert.ok(item1 && !item1.guess, 'the other cheque waits, with no guess');
  assert.deepEqual(item1.sources, [day, back, client], 'the queue: by the year\'s money');
  // the sheet of the cheque that waits, and of the payroll's latest deposit
  for (const tx of [txOf(s, CHEQUE, addDays(TODAY, -40)), txOf(s, PAYROLL, addDays(TODAY, -1))]) {
    const helper = fileURLToPath(new URL('./helpers/inlets-words.mjs', import.meta.url));
    const [block] = JSON.parse(execFileSync(process.execPath, [helper, JSON.stringify([
      ['inflows', 'txSourceBlock', { state: s, words: 'chess', ui: {}, now: NOW }, tx],
    ])], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    assert.ok(!block.startsWith('ERROR'), block.slice(0, 400));
    const order = [...block.matchAll(/data-action="inlets\.file-tx"[^>]*data-to="(n[0-9a-f]{13})"/g)].map((m) => m[1]);
    assert.deepEqual(order, [day, back, client], 'the sheet offers them as the queue does');
  }
});

test('round 6: the Remove confirm takes the pinned action bar while it asks, focus goes to its Cancel, and it is cleared when the sheet closes', async () => {
  const s = base();
  const day = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, day, NOW + MIN));
  const helper = fileURLToPath(new URL('./helpers/inlets-words.mjs', import.meta.url));
  for (const words of ['chess', 'finance']) {
    const [asking, plain] = JSON.parse(execFileSync(process.execPath, [helper, JSON.stringify([
      ['sheet-inlet', 'render', { state: s, words, ui: { inletRemove: day }, now: NOW, d: {} }, { id: day }],
      ['sheet-inlet', 'render', { state: s, words, ui: {}, now: NOW, d: {} }, { id: day }],
    ])], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    assert.ok(!asking.startsWith('ERROR') && !plain.startsWith('ERROR'), asking.slice(0, 400));
    const bars = (page) => [...page.matchAll(/<div class="sheet-actions[^"]*"[\s\S]*?<\/div>/g)].map((m) => m[0]);
    // asking: the one pinned bar is the question with Cancel and Remove it, in place of Remove, Archive and Save
    assert.equal(bars(asking).length, 1, words + ': one pinned bar');
    const bar = bars(asking)[0];
    assert.match(bar, /role="alertdialog"/, words + ': the bar is the confirm');
    assert.ok(bar.includes(say('inlet.remove.confirm', words, { name: 'Day job', count: '' }).split(' ')[0]), words + ': its question');
    assert.ok(bar.includes('data-action="inlet.remove-cancel"') && bar.includes('data-action="inlet.remove"'), words + ': Cancel and Remove it');
    assert.ok(!bar.includes('data-action="inlet.remove-ask"') && !bar.includes('type="submit"'), words + ': not Remove, Archive and Save');
    // not asking: Remove, Archive and Save
    assert.equal(bars(plain).length, 1);
    assert.ok(bars(plain)[0].includes('data-action="inlet.remove-ask"') && bars(plain)[0].includes('type="submit"') && !plain.includes('alertdialog'), words + ': the usual bar');
  }
  const sheet = await (await import('node:fs/promises')).readFile(new URL('../js/views/sheet-inlet.js', import.meta.url), 'utf8');
  assert.match(sheet, /'inlet\.remove-ask': \(\{ data \}\) => \{[^\n]*focusIn\('\.inlet-confirm \[data-action="inlet\.remove-cancel"\]'\)/, 'Remove moves the focus to the confirm\'s Cancel');
  assert.match(sheet, /onRoute\(\(route\) => \{[^\n]*inletRemove: null/, 'a confirm left open is cleared when the sheet closes');
  const css = await (await import('node:fs/promises')).readFile(new URL('../css/views/flows.css', import.meta.url), 'utf8');
  assert.match(css, /\.sheet-actions\.inlet-confirm[^{]*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'the question over the two buttons');
});

test('round 7: In and out reads no filing: with the pay set as it was, a filing leaves it byte for byte; the page passes the In and out it shows to the section', async () => {
  const s = base();
  const plain = Object.fromEntries([30, 90, 365].map((days) => [days, JSON.stringify(inAndOut(s, NOW, days))]));
  const pay = JSON.stringify(makeLedger(s, NOW).payStreams().map((one) => one.id));
  const day = makeInlet(s, { name: 'Day job', kind: 'steady' }, NOW, nid());
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, PAYROLL).mkey) }, day, NOW + MIN));
  const other = makeInlet(s, { name: 'Clients', kind: 'job' }, NOW + 2 * MIN, nid());
  assert.ok(fileDeposit(s, txOf(s, PAYROLL, addDays(TODAY, -15)).id, other, 'one', NOW + 3 * MIN));
  assert.ok(fileDeposit(s, txOf(s, CHEQUE).id, WINDFALL, 'one', NOW + 4 * MIN));
  assert.equal(JSON.stringify(makeLedger(s, NOW).payStreams().map((one) => one.id)), pay, 'the pay set as it was');
  for (const days of [30, 90, 365]) {
    assert.equal(JSON.stringify(inAndOut(s, NOW, days)), plain[days], days + ': In and out byte for byte');
    const io = inAndOut(s, NOW, days);
    const sec = moneyInBySource(s, NOW, days, { io });
    assert.equal(sec.earned.change, io.in.change == null ? null : io.in.change - sec.windfalls.change, days + ': All earned = In and out - Windfalls');
  }
  const view = await (await import('node:fs/promises')).readFile(new URL('../js/views/flows.js', import.meta.url), 'utf8');
  assert.match(view, /const io = inAndOut\(ctx\.state, ctx\.now, days, opts\);/, 'the page reads In and out with no look');
  assert.match(view, /moneyInBySource\(ctx\.state, ctx\.now, days, \{ \.\.\.inOpts, io \}\)/, 'and passes it to the section');
});

/* ------------------------------------------------------------------ round 9: the triage's fixes */

test('round 9 (F1): Leave it is one mark on the item\'s key: 8 payers of 20 weekly deposits left in one round, one queue on A, B and a fresh C; a later deposit asked about; a payer filing after it reaches every deposit; the Undo travels; older builds take it', async (t) => {
  // round 1's probe g-row-cap-fresh-device: one mark per deposit (160) passed the 120 filings of one deposit that travel,
  // and B and a fresh C asked about each payer's 5 oldest deposits again
  const PAYERS = [...Array(8).keys()].map((p) => 'Zelle payment from TESTPAYER ' + String.fromCharCode(65 + p) + ' 4' + p);
  const record = () => {
    const s = base();
    PAYERS.forEach((raw, p) => { for (let w = 0; w < 20; w++) row(s, addDays(TODAY, -3 - 7 * w - p), 5000 + p * 100 + w, raw); });
    refresh(s, NOW);
    return s;
  };
  let clock = NOW;
  const a = deviceOf(record(), () => clock);
  const b = deviceOf(record(), () => clock);
  const repo = memory();
  await settle([a, b], repo);
  const before = Date.now();
  for (const raw of PAYERS) {
    clock += MIN;
    const one = depositQueue(a.state, NOW).items.find((x) => x.key === 'payer:' + merchantKeyOf(txOf(a.state, raw).mkey));
    assert.equal(one.count, 20, raw + ': 20 deposits');
    update(a, (s) => fileQueueItem(s, one, LEAVE, clock), 'left');
  }
  const took = Date.now() - before;
  const cells = storedFlows(a.state).into;
  const marks = Object.keys(cells).filter((k) => cells[k].v === LEAVE);
  assert.equal(marks.length, 8, 'one mark a payer, not one a deposit (160)');
  assert.ok(marks.every((k) => k[0] === 'p'), 'each on the payer\'s key');
  assert.ok(took < 2000, 'eight taps, eight writes: ' + took + ' ms');
  await settle([a, b], repo);
  const file = JSON.parse(repo.text).flows.into;
  assert.equal(Object.keys(file).filter((k) => file[k].v === LEAVE).length, 8, 'the file carries all 8');
  clock += MIN;
  const c = deviceOf(record(), () => clock);
  await settle([a, b, c], repo);
  const qa = queueKeys(a.state);
  for (const d of [b, c]) assert.deepEqual(queueKeys(d.state), qa, 'one queue on A, B and a fresh C');
  for (const raw of PAYERS) assert.ok(!qa.some((k) => k.startsWith('payer:' + merchantKeyOf(txOf(a.state, raw).mkey))), raw + ': left on every device');
  // a deposit dated after the tap's day is asked about on all three
  const LATER = NOW + 2 * 86400000;
  for (const d of [a, b, c]) {
    row(d.state, addDays(TODAY, 1), 7700, PAYERS[0]);
    refresh(d.state, LATER);
    const one = depositQueue(d.state, LATER).items.find((x) => x.key === 'payer:' + merchantKeyOf(txOf(d.state, PAYERS[0]).mkey));
    assert.deepEqual(one && [one.count, one.amount], [1, 7700], 'only the later deposit');
    assert.equal(filed(d.state, txOf(d.state, PAYERS[0], addDays(TODAY, -3))).left, true, 'an older one stays left');
  }
  // B files the payer from that item: every deposit of the payer, the left ones included, on every device
  clock = LATER + MIN;
  const id = nid();
  update(b, (s) => makeInlet(s, { name: 'Weekly clients', kind: 'job' }, clock, id), 'made');
  const item0 = depositQueue(b.state, LATER).items.find((x) => x.key === 'payer:' + merchantKeyOf(txOf(b.state, PAYERS[0]).mkey));
  update(b, (s) => fileQueueItem(s, item0, id, clock), 'filed');
  await settle([a, b, c], repo);
  for (const d of [a, b, c]) {
    const all = d.state.txs.filter((tx) => tx.raw === PAYERS[0]);
    assert.equal(all.length, 21);
    assert.ok(all.every((tx) => filed(d.state, tx).to === id), 'the payer filing reaches every deposit');
  }
  // its Undo travels. The mark cannot come back on its own day (the filing came two days after it, and a stamp only
  // grows): stamped above the filing it would reach the filing's day and leave the later deposit too (round 7's known
  // limit), so the Undo writes a removal (round 12): on every device every deposit of the payer is Not yet filed and asked
  // about again
  clock += MIN;
  b.undo();
  await settle([a, b, c], repo);
  for (const d of [a, b, c]) {
    const all = d.state.txs.filter((tx) => tx.raw === PAYERS[0]);
    assert.ok(all.every((tx) => filed(d.state, tx).to === null && !filed(d.state, tx).left), 'the Undo, on every device: Not yet filed, asked about');
    assert.ok(storedFlows(d.state).into[merchantKeyOf(all[0].mkey)].deleted, 'the payer\'s mark is a removal');
    const one = depositQueue(d.state, LATER).items.find((x) => x.key === 'payer:' + merchantKeyOf(all[0].mkey));
    assert.ok(one && one.count > 1, 'the later deposit and the older ones asked about');
  }
  assert.deepEqual(queueKeys(b.state, LATER), queueKeys(a.state, LATER));
  assert.deepEqual(queueKeys(c.state, LATER), queueKeys(a.state, LATER));
  // the Undo of a Leave it travels: the last payer A left is asked about again on every device, all 20 deposits
  clock += MIN;
  a.undo();
  await settle([a, b, c], repo);
  for (const d of [a, b, c]) {
    const one = depositQueue(d.state, LATER).items.find((x) => x.key === 'payer:' + merchantKeyOf(txOf(d.state, PAYERS[7]).mkey));
    assert.equal(one && one.count, 20, 'Leave it undone, on every device');
  }
  // a mark on a payer's or an app's key is a cell f414276's strict reader and 8d013da take
  const section = exportFlows(a.state, clock);
  assert.ok(Object.keys(section.into).some((k) => k[0] === 'p' && section.into[k].v === LEAVE));
  await oldBuildsTake(t, section);
});

test('round 9 (F1): Leave it on your other app\'s item is one mark on the app\'s key, read up to its day; the app\'s Add after it files them all', () => {
  const s = base();
  const items = [];
  // a regular payer of the app every week for 40 weeks: 40 paired deposits in one item
  for (let w = 0; w < 40; w++) {
    const day = addDays(TODAY, -4 - 7 * w);
    row(s, addDays(day, 1), 9000, 'Zelle payment from LARK FENN 5512');
    items.push(item('w' + w, 'p-lark', 9000, day));
  }
  refresh(s, NOW);
  reportIn(s, items);
  refresh(s, NOW);
  const app = depositQueue(s, NOW).items.find((one) => one.kind === 'app');
  assert.equal(app.count, 40);
  assert.ok(fileQueueItem(s, app, LEAVE, NOW + MIN));
  const cells = storedFlows(s).into;
  assert.deepEqual(Object.keys(cells).filter((k) => cells[k].v === LEAVE), [appKey('sessions')], 'one mark, on the app\'s key');
  assert.ok(!depositQueue(s, NOW).items.some((one) => one.kind === 'app'), 'the item is left');
  // a later payment and its deposit are asked about
  row(s, addDays(TODAY, 2), 9000, 'Zelle payment from LARK FENN 5512');
  reportIn(s, [...items, item('w-next', 'p-lark', 9000, addDays(TODAY, 1))], NOW + 3 * 86400000);
  refresh(s, NOW + 3 * 86400000);
  const next = depositQueue(s, NOW + 3 * 86400000).items.find((one) => one.kind === 'app');
  assert.deepEqual(next && next.count, 1, 'the later deposit is asked about');
  // Add on the app's suggestion files every one of them, the left ones included
  const offer = suggestions(s, NOW + 3 * 86400000).shown.find((one) => one.intoKey === appKey('sessions'));
  const job = acceptOffer(s, offer, NOW + 3 * 86400000 + MIN, nid());
  assert.ok(s.txs.filter((tx) => tx.raw === 'Zelle payment from LARK FENN 5512').every((tx) => filed(s, tx).to === job));
});

test('round 10, as round 11 makes it: a second Leave it on a payer or your other app\'s item, after newer deposits, stamps its one mark again; its Undo takes the mark away, so every deposit of the item is asked about again on every device (never nothing, round 8\'s sync major); older builds take the files', async (t) => {
  // a Zelle sender of $85 every week (no income: a friend paying back) on two devices of different depth
  const FRIEND = 'Zelle payment from PIP HOLLOWAY 66211';
  const record = (weeks) => {
    const s = base();
    for (let w = 0; w < weeks; w++) row(s, addDays(TODAY, -2 - 7 * w), 8500, FRIEND);
    refresh(s, NOW);
    return s;
  };
  let clock = NOW;
  const a = deviceOf(record(40), () => clock);
  const b = deviceOf(record(17), () => clock);
  const repo = memory();
  await settle([a, b], repo);
  const key = 'payer:' + merchantKeyOf(txOf(a.state, FRIEND).mkey);
  const countOf = (d, at) => { const one = depositQueue(d.state, at).items.find((x) => x.key === key); return one ? one.count : 0; };
  clock += MIN;
  update(a, (s) => fileQueueItem(s, depositQueue(s, NOW).items.find((x) => x.key === key), LEAVE, clock), 'left');
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(countOf(d, NOW), 0, 'left on both');
  // two newer deposits, dated after the tap's day, reach both devices
  const LATER = NOW + 3 * 86400000;
  for (const d of [a, b]) {
    row(d.state, addDays(TODAY, 1), 8500, FRIEND);
    row(d.state, addDays(TODAY, 2), 9000, FRIEND);
    refresh(d.state, LATER);
  }
  for (const d of [a, b]) assert.equal(countOf(d, LATER), 2, 'the two newer deposits asked about');
  // Leave it again, then its Undo: the payer's one mark, stamped again, travels; its Undo cannot put the older day back,
  // so it takes the mark away: on both devices every deposit of the payer is asked about again, and the view says so
  clock = LATER + MIN;
  const again = depositQueue(a.state, LATER).items.find((x) => x.key === key);
  assert.equal(again.leftBefore, true, 'the item knows it was left before (its Undo label says what the Undo does)');
  update(a, (s) => fileQueueItem(s, again, LEAVE, clock), 'left');
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(countOf(d, LATER), 0, 'left again on both');
  const cells = storedFlows(a.state).into;
  assert.equal(Object.keys(cells).filter((k) => cells[k].v === LEAVE).length, 1, 'one mark, the payer\'s, stamped again: nothing on the deposits\' own keys');
  clock += MIN;
  a.undo();
  await settle([a, b], repo);
  for (const d of [a, b]) {
    // each device asks about every deposit of the payer its own record holds in the queue's reach (B's is shorter)
    assert.ok(countOf(d, LATER) > 2, 'the Undo asks about every deposit of the payer again: ' + countOf(d, LATER));
    assert.ok(d.state.txs.filter((tx) => tx.raw === FRIEND).every((tx) => !filed(d.state, tx).left), 'none of them is left, on every device');
    const mark = storedFlows(d.state).into[merchantKeyOf(txOf(d.state, FRIEND).mkey)];
    assert.ok(mark && mark.deleted, 'the payer\'s mark is a removal');
  }
  // a later Leave it leaves them all again, one mark
  clock += MIN;
  update(b, (s) => fileQueueItem(s, depositQueue(s, LATER).items.find((x) => x.key === key), LEAVE, clock), 'left');
  await settle([a, b], repo);
  for (const d of [a, b]) assert.equal(countOf(d, LATER), 0, 'left on both again');
  // the same on your other app's item: 12 weekly sessions, Leave it, two more, Leave it again, Undo
  const s = base();
  const items = [];
  for (let w = 0; w < 12; w++) {
    const day = addDays(TODAY, -4 - 7 * w);
    row(s, addDays(day, 1), 9000, 'Zelle payment from LARK FENN 5512');
    items.push(item('w' + w, 'p-lark', 9000, day));
  }
  refresh(s, NOW);
  reportIn(s, items);
  refresh(s, NOW);
  const appCount = (at) => { const one = depositQueue(s, at).items.find((x) => x.kind === 'app'); return one ? one.count : 0; };
  assert.ok(fileQueueItem(s, depositQueue(s, NOW).items.find((x) => x.kind === 'app'), LEAVE, NOW + MIN));
  const more = [...items, item('w-a', 'p-lark', 9000, addDays(TODAY, 1)), item('w-b', 'p-lark', 9000, addDays(TODAY, 2))];
  row(s, addDays(TODAY, 2), 9000, 'Zelle payment from LARK FENN 5512');
  row(s, addDays(TODAY, 3), 9000, 'Zelle payment from LARK FENN 5512');
  const LATE = NOW + 4 * 86400000;
  reportIn(s, more, LATE);
  refresh(s, LATE);
  assert.equal(appCount(LATE), 2, 'the app\'s two newer deposits asked about');
  const d = deviceOf(s, () => LATE + 2 * MIN);
  update(d, (st) => fileQueueItem(st, depositQueue(st, LATE).items.find((x) => x.kind === 'app'), LEAVE, LATE + 2 * MIN), 'left');
  assert.ok(!depositQueue(d.state, LATE).items.some((x) => x.kind === 'app'), 'left again');
  const marks = storedFlows(d.state).into;
  assert.equal(Object.keys(marks).filter((k) => marks[k].v === LEAVE).length, 1, 'the app\'s one mark');
  d.undo();
  assert.ok(depositQueue(d.state, LATE).items.find((x) => x.kind === 'app').count > 2, 'its Undo asks about every deposit of the app again');
  assert.ok(d.state.txs.filter((tx) => tx.raw === 'Zelle payment from LARK FENN 5512' && tx.day <= TODAY).every((tx) => !filed(d.state, tx).left), 'the older ones too');
  // the cells are ones f414276's strict reader and 8d013da take
  await oldBuildsTake(t, exportFlows(a.state, clock));
});

test('round 11 (round 9\'s sync M1): Leave it again and again on a payer is its one mark, which travels beside 130 one-at-a-time filings: a device that missed the taps and one that joins later ask about none of the deposits left; older builds take the file', async (t) => {
  // a sender who is no income, paid every week for 30 weeks and left each week (Leave it again on its item), and a cash-out
  // every 3 days filed one at a time to a By the job source: 130 filings of one deposit, past the file's 120. Round 10 wrote
  // a `?` on each newer deposit's own key, which the 120 evicted first, so they stopped travelling
  const FRIEND = 'Zelle payment from PIP HOLLOWAY 66211';
  const OUT = 'VENMO CASHOUT PPD ID: 5264681992';
  const record = () => {
    const s = base({ from: addDays(TODAY, -393) });
    for (let k = 0; k < 130; k++) row(s, addDays(TODAY, -3 * k - 1), 20000 + 100 * (k % 7), OUT);
    for (let w = 0; w < 30; w++) row(s, addDays(TODAY, -7 * w), 8500, FRIEND);
    refresh(s, NOW);
    return s;
  };
  const DAY = 86400000;
  let clock = NOW - 30 * 7 * DAY;
  const a = deviceOf(record(), () => clock);
  const b = deviceOf(record(), () => clock);
  const repo = memory();
  await settle([a, b], repo);
  const key = 'payer:' + merchantKeyOf(txOf(a.state, FRIEND).mkey);
  // A leaves the sender each week, at noon of the day its deposit came; B is away
  for (let w = 29; w >= 0; w--) {
    clock = NOW - 7 * w * DAY;
    const one = depositQueue(a.state, clock).items.find((x) => x.key === key);
    assert.ok(one, 'week ' + w + ': the sender is asked about');
    update(a, (s) => fileQueueItem(s, one, LEAVE, clock), 'left');
  }
  clock = NOW + MIN;
  const job = makeInlet(a.state, { name: 'Coaching', kind: 'job' }, clock, nid());
  for (const tx of a.state.txs.filter((x) => x.raw === OUT)) assert.ok(fileDeposit(a.state, tx.id, job, 'one', (clock += 1)));
  const cells = storedFlows(a.state).into;
  assert.equal(Object.keys(cells).filter((k) => cells[k].v === LEAVE).length, 1, 'one mark, however often the sender was left');
  clock += MIN;
  const c = deviceOf(record(), () => clock);
  await settle([a, b, c], repo);
  for (const [name, d] of [['A', a], ['B, away for the taps', b], ['C, joined later', c]]) {
    assert.ok(!depositQueue(d.state, NOW + MIN).items.some((x) => x.key === key), name + ': none of the sender\'s deposits is asked about');
    assert.equal(moneyInBySource(d.state, NOW + MIN, 30).unfiled.cents, moneyInBySource(a.state, NOW + MIN, 30).unfiled.cents, name + ': Not yet filed the same');
  }
  await oldBuildsTake(t, exportFlows(a.state, clock));
});

/**
 * Round 12's worlds: a Zelle sender who is no income (three deposits, 70, 50 and 20 days back) left with Leave it 15 days
 * ago on device A, shared with B; then two newer deposits (10 and 5 days back) reach both banks and are asked about, the
 * item "left before". A source of A's to file to. Every name and figure is invented.
 */
const FRIEND12 = 'Zelle payment from PIP HOLLOWAY 66211';
const DAY12 = 86400000;
function record12(from) {
  const s = base({ from });
  for (const back of [70, 50, 20]) row(s, addDays(TODAY, -back), 8500, FRIEND12, { id: 'tx_friend_' + back });
  refresh(s, NOW);
  return s;
}
/** The two newer deposits, as a bank sync brings them (the same ids on every device and in every Undo copy). */
function newer12(s, nowMs) {
  row(s, addDays(TODAY, -10), 9000, FRIEND12, { id: 'tx_friend_10' });
  row(s, addDays(TODAY, -5), 9500, FRIEND12, { id: 'tx_friend_5' });
  refresh(s, nowMs);
}
async function world12() {
  const w = { clock: NOW - 15 * DAY12, repo: memory(), id: nid() };
  w.a = deviceOf(record12(addDays(TODAY, -300)), () => w.clock);
  w.b = deviceOf(record12(addDays(TODAY, -120)), () => w.clock);
  await settle([w.a, w.b], w.repo);
  w.key = 'payer:' + merchantKeyOf(txOf(w.a.state, FRIEND12).mkey);
  w.mkey = merchantKeyOf(txOf(w.a.state, FRIEND12).mkey);
  w.count = (d) => { const one = depositQueue(d.state, w.clock).items.find((x) => x.key === w.key); return one ? one.count : 0; };
  w.item = (d, key = w.key) => depositQueue(d.state, w.clock).items.find((x) => x.key === key);
  update(w.a, (s) => makeInlet(s, { name: 'Coaching', kind: 'job' }, w.clock, w.id), 'made');
  update(w.a, (s) => fileQueueItem(s, w.item({ state: s }), LEAVE, w.clock), 'left');
  await settle([w.a, w.b], w.repo);
  for (const d of [w.a, w.b]) assert.equal(w.count(d), 0, 'left on both');
  w.clock = NOW;
  for (const d of [w.a, w.b]) d.update((s) => newer12(s, w.clock), { past: (s) => newer12(s, w.clock) });
  await settle([w.a, w.b], w.repo);
  for (const d of [w.a, w.b]) {
    assert.equal(w.count(d), 2, 'the two newer deposits asked about');
    assert.equal(w.item(d).leftBefore, true, 'the item was left before');
  }
  return w;
}

test('round 12 (round 10\'s sync major): an Undo never moves Leave it on a payer to a later day: after the Undo of a Leave it made again, a further Undo of an earlier tap keeps every deposit of the payer asked about, on A, B and a device that joins later; the rounds settle; older builds take the files', async (t) => {
  const w = await world12();
  const { a, b } = w;
  // an earlier tap: A files another sender's item to Coaching
  w.clock += MIN;
  const robin = 'payer:' + merchantKeyOf(txOf(a.state, ZELLE_A).mkey);
  update(a, (s) => fileQueueItem(s, w.item({ state: s }, robin), w.id, w.clock), 'filed');
  await settle([a, b], w.repo);
  // Leave it again on the sender (its one mark, stamped today), then its Undo: a removal, all 5 asked about (round 11)
  w.clock += MIN;
  update(a, (s) => fileQueueItem(s, w.item({ state: s }), LEAVE, w.clock), 'left');
  await settle([a, b], w.repo);
  for (const d of [a, b]) assert.equal(w.count(d), 0, 'left again on both');
  w.clock += MIN;
  a.undo();
  await settle([a, b], w.repo);
  for (const d of [a, b]) assert.equal(w.count(d), 5, 'the Undo of Leave it made again asks about all 5');
  // the further Undo, of the earlier tap, puts the first mark back in A's copy: stamped now it would reach today and leave
  // all 5 (round 10's major); it stays a removal, so all 5 are still asked about, on every device
  w.clock += MIN;
  a.undo();
  await settle([a, b], w.repo);
  const writes = w.repo.writes;
  for (let n = 0; n < 3; n++) await settle([a, b], w.repo);
  assert.equal(w.repo.writes, writes, 'three more rounds write nothing');
  w.clock += MIN;
  const c = deviceOf(record12(addDays(TODAY, -200)), () => w.clock);
  newer12(c.state, w.clock);
  await settle([a, b, c], w.repo);
  for (const [name, d] of [['A', a], ['B', b], ['C, joined later', c]]) {
    assert.equal(w.count(d), 5, name + ': every deposit of the sender asked about');
    assert.ok(d.state.txs.filter((tx) => tx.raw === FRIEND12).every((tx) => !filed(d.state, tx).left), name + ': none of them left');
    const mark = storedFlows(d.state).into[w.mkey];
    assert.ok(mark && mark.deleted, name + ': the sender\'s mark is a removal');
    assert.ok(d.state.txs.filter((tx) => tx.raw === ZELLE_A).every((tx) => filed(d.state, tx).to === null), name + ': the earlier tap is undone');
  }
  await oldBuildsTake(t, exportFlows(a.state, w.clock));
});

test('round 12 (round 10\'s logic m1): the Undo of a filing of a payer or your other app left on an earlier day never leaves their newer deposits: the queue\'s filing, All from this payer, a new source named from the item and Not yet filed, each undone, ask about every deposit again on both devices; on the Leave it\'s own day the Undo puts the mark back as it was', async () => {
  const cases = {
    'the queue\'s filing': (w, s) => fileQueueItem(s, w.item({ state: s }), w.id, w.clock),
    'All from this payer on the deposit\'s sheet': (w, s) => fileDeposit(s, 'tx_friend_10', w.id, 'all', w.clock),
    'a new source named from the item': (w, s) => !!fileToNew(s, w.item({ state: s }), { name: 'Tutoring', kind: 'job' }, w.clock, nid()),
    // on a deposit the mark leaves (Not yet filed is written only where it takes effect)
    'Not yet filed on the deposit\'s sheet, All from this payer': (w, s) => fileDeposit(s, 'tx_friend_20', null, 'all', w.clock),
    'Windfalls from the queue': (w, s) => fileQueueItem(s, w.item({ state: s }), WINDFALL, w.clock),
  };
  for (const [name, tap] of Object.entries(cases)) {
    const w = await world12();
    w.clock += MIN;
    let done = false;
    update(w.a, (s) => { done = tap(w, s); }, 'tap');
    assert.ok(done, name + ': the tap takes effect');
    await settle([w.a, w.b], w.repo);
    w.clock += MIN;
    w.a.undo();
    await settle([w.a, w.b], w.repo);
    for (const [who, d] of [['A', w.a], ['B', w.b]]) {
      assert.equal(w.count(d), 5, name + ', ' + who + ': its Undo asks about every deposit of the sender again (round 10 left the 2 newer ones)');
      assert.ok(storedFlows(d.state).into[w.mkey].deleted, name + ', ' + who + ': the mark is a removal');
      assert.ok(d.state.txs.filter((tx) => tx.raw === FRIEND12).every((tx) => filed(d.state, tx).to === null), name + ', ' + who + ': nothing of the tap is left');
    }
  }
  // on the Leave it's own day an Undo puts the mark back as it was: the older deposits left, nothing newer
  {
    let clock = NOW;
    const s = record12(addDays(TODAY, -300));
    const d = deviceOf(s, () => clock);
    const key = 'payer:' + merchantKeyOf(txOf(d.state, FRIEND12).mkey);
    const id = nid();
    update(d, (st) => makeInlet(st, { name: 'Coaching', kind: 'job' }, clock, id), 'made');
    update(d, (st) => fileQueueItem(st, depositQueue(st, clock).items.find((x) => x.key === key), LEAVE, clock), 'left');
    clock += MIN;
    update(d, (st) => fileDeposit(st, 'tx_friend_20', id, 'all', clock), 'filed');
    clock += MIN;
    d.undo();
    const mark = storedFlows(d.state).into[merchantKeyOf(txOf(d.state, FRIEND12).mkey)];
    assert.equal(mark.v, LEAVE, 'the same day: the mark is back');
    assert.ok(d.state.txs.filter((tx) => tx.raw === FRIEND12).every((tx) => filed(d.state, tx).left), 'its deposits left, as before the filing');
    assert.ok(!depositQueue(d.state, clock).items.some((x) => x.key === key));
    // the item reads "left before" (the Undo labels say every deposit is asked about again) only from the next game day
    const look = lookOf(d.state);
    const mkey = merchantKeyOf(txOf(d.state, FRIEND12).mkey);
    assert.equal(leftEarlier(look, mkey, TODAY), false, 'not on the Leave it\'s own day');
    assert.equal(leftEarlier(look, mkey, addDays(TODAY, 1)), true, 'from the next day');
    assert.equal(leftEarlier(look, merchantKeyOf(txOf(d.state, ZELLE_A).mkey), addDays(TODAY, 1)), false, 'never on a key not left');
  }
  // your other app's item: left, two newer sessions asked about, the app filed to a source on a later day, then Undo
  {
    const s = base();
    const items = [];
    for (let k = 0; k < 6; k++) {
      const day = addDays(TODAY, -4 - 7 * k);
      row(s, addDays(day, 1), 9000, 'Zelle payment from LARK FENN 5512');
      items.push(item('w' + k, 'p-lark', 9000, day));
    }
    refresh(s, NOW);
    reportIn(s, items);
    refresh(s, NOW);
    assert.ok(fileQueueItem(s, depositQueue(s, NOW).items.find((x) => x.kind === 'app'), LEAVE, NOW + MIN));
    row(s, addDays(TODAY, 2), 9000, 'Zelle payment from LARK FENN 5512');
    row(s, addDays(TODAY, 3), 9000, 'Zelle payment from LARK FENN 5512');
    const LATE = NOW + 4 * DAY12;
    reportIn(s, [...items, item('w-a', 'p-lark', 9000, addDays(TODAY, 1)), item('w-b', 'p-lark', 9000, addDays(TODAY, 2))], LATE);
    refresh(s, LATE);
    const appCount = (st) => { const one = depositQueue(st, LATE).items.find((x) => x.kind === 'app'); return one ? one.count : 0; };
    assert.equal(appCount(s), 2, 'the app\'s two newer deposits asked about');
    const d = deviceOf(s, () => LATE + 2 * MIN);
    const id = nid();
    update(d, (st) => makeInlet(st, { name: 'Sittings', kind: 'job' }, LATE + MIN, id), 'made');
    update(d, (st) => fileQueueItem(st, depositQueue(st, LATE).items.find((x) => x.kind === 'app'), id, LATE + MIN), 'filed');
    assert.equal(appCount(d.state), 0, 'the app filed');
    d.undo();
    assert.ok(appCount(d.state) > 2, 'its Undo asks about every deposit of the app again: ' + appCount(d.state));
    assert.ok(d.state.txs.filter((tx) => tx.raw === 'Zelle payment from LARK FENN 5512').every((tx) => !filed(d.state, tx).left), 'none of them left');
  }
});

test('round 12: random taps on three payers over 60 days, with Undo: an Undo never hides a deposit the copy it puts back asked about, and A, B and a device that joins later ask about the same deposits', async () => {
  // senders who are no income, each with three older deposits; on A, days pass and deposits arrive on both banks, and A
  // taps Leave it, a source, Windfalls, Not yet filed or All from this payer, or Undo; B shares. The split's rule hid
  // deposits in 5 of 40 runs (round 10's sync major and logic m1)
  const PAYERS = ['Zelle payment from PIP HOLLOWAY 66211', 'Zelle payment from WREN ASHBY 55120', 'Zelle payment from TOBY QUILL 44019'];
  const DAY = 86400000;
  const device = (state, clock) => {
    const stack = [];
    const d = { state, clock, stack,
      update(fn, opts = {}) {
        if (opts.undo) stack.push(JSON.stringify(d.state));
        if (typeof opts.past === 'function') for (let i = 0; i < stack.length; i++) { const c = JSON.parse(stack[i]); opts.past(c); stack[i] = JSON.stringify(c); }
        fn(d.state);
      },
      undo() {
        const before = d.state;
        d.state = JSON.parse(stack.pop());
        restampCorrections(before, d.state);
        restampFlows(before, d.state, d.clock());
      },
      round: (repo) => roundShared({ state: () => d.state, stale: () => false, update: (now, past) => d.update(now, { past }) }, repo, d.clock),
    };
    return d;
  };
  const record = (from) => {
    const s = bankRecord();
    for (let day = addDays(TODAY, -1); day >= from; day = addDays(day, -14)) row(s, day, 210000, PAYROLL, { id: 'pay_' + day });
    PAYERS.forEach((raw, p) => { for (const back of [80, 60, 45]) row(s, addDays(TODAY, -back - p), 7000 + 100 * p, raw, { id: 'old_' + p + '_' + back }); });
    refresh(s, NOW - 60 * DAY);
    return s;
  };
  const asked = (s) => { const look = lookOf(s); return s.txs.filter((tx) => PAYERS.includes(tx.raw)).filter((tx) => { const f = filingOf(look, tx); return f.to === null && !f.left; }).map((tx) => tx.id).sort(); };
  const count = { undos: 0, more: 0 };
  for (let seed = 1; seed <= 24; seed++) {
    let a32 = seed * 7919;
    const rnd = () => { a32 = (a32 + 0x6D2B79F5) | 0; let x = Math.imul(a32 ^ (a32 >>> 15), 1 | a32); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    let t = NOW - 60 * DAY;
    const clock = () => t;
    const a = device(record(addDays(TODAY, -300)), clock);
    const b = device(record(addDays(TODAY, -150)), clock);
    const repo = memory();
    await settle([a, b], repo);
    const id = makeInlet(a.state, { name: 'Coaching', kind: 'job' }, t, 'n00000000000' + String(seed).padStart(2, '0'));
    let arrivals = 0;
    for (let step = 0; step < 30; step++) {
      const r = rnd();
      if (r < 0.15) {
        t += Math.floor(1 + rnd() * 6) * DAY;
        const day = gameDay(t, 4);
        const p = Math.floor(rnd() * PAYERS.length);
        const n = ++arrivals;
        const arrive = (s) => { if (!s.txs.some((x) => x.id === 'new_' + n)) row(s, day, 8000 + p * 100 + n, PAYERS[p], { id: 'new_' + n }); refresh(s, t); };
        for (const d of [a, b]) d.update(arrive, { past: arrive });
      } else if (r < 0.35 && a.stack.length) {
        t += MIN;
        const want = asked(JSON.parse(a.stack[a.stack.length - 1]));
        a.undo();
        const got = asked(a.state);
        assert.deepEqual(want.filter((x) => !got.includes(x)), [], 'seed ' + seed + ', step ' + step + ': the Undo hides none of the deposits its copy asked about');
        count.undos++;
        if (got.length > want.length) count.more++;
      } else {
        t += MIN;
        const raw = PAYERS[Math.floor(rnd() * PAYERS.length)];
        const key = 'payer:' + merchantKeyOf(a.state.txs.find((x) => x.raw === raw).mkey);
        const one = depositQueue(a.state, t).items.find((x) => x.key === key);
        const kind = rnd();
        const txs = a.state.txs.filter((x) => x.raw === raw);
        const tx = txs[Math.floor(rnd() * txs.length)];
        if (kind < 0.4 && one) a.update((s) => fileQueueItem(s, one, LEAVE, t), { undo: 'left' });
        else if (kind < 0.6 && one) a.update((s) => fileQueueItem(s, one, id, t), { undo: 'filed' });
        else if (kind < 0.7 && one) a.update((s) => fileQueueItem(s, one, WINDFALL, t), { undo: 'windfalls' });
        else if (kind < 0.85) { if (canUnfile(a.state, tx.id, 'all')) a.update((s) => fileDeposit(s, tx.id, null, 'all', t), { undo: 'unfiled' }); }
        else a.update((s) => fileDeposit(s, tx.id, id, 'all', t), { undo: 'filed' });
      }
      if (rnd() < 0.5) await settle([a, b], repo);
    }
    await settle([a, b], repo);
    const c = device(record(addDays(TODAY, -200)), clock);
    for (let n = 1; n <= arrivals; n++) { const src = a.state.txs.find((x) => x.id === 'new_' + n); row(c.state, src.day, src.amount, src.raw, { id: 'new_' + n }); }
    refresh(c.state, t);
    await settle([a, b, c], repo);
    assert.deepEqual(asked(b.state), asked(a.state), 'seed ' + seed + ': B asks about what A asks about');
    assert.deepEqual(asked(c.state), asked(a.state), 'seed ' + seed + ': a device that joins later too');
  }
  assert.ok(count.undos >= 100 && count.more >= 8, 'Undos, and Undos that ask about more than their copy (a Leave it of an earlier day taken away): ' + count.undos + ', ' + count.more);
});

test('round 9 (F2): a sender\'s only deposit paired with the app is queued under the sender, the pairing named, not filed with the app; a regular\'s deposit paired with another payer\'s session still is; a new sender asks once, then files; two devices agree; the totals hold', async () => {
  // the triage's probe (oneoff-single): two weekly payers at $95, Zelle 3 days after the session; a one-off $95 from a new
  // sender (3.7 pairs it with another payer's session of exactly its cents) and a one-off $300 that 3.7 pairs with a
  // group of 3 sessions of a third payer the bank never shows (round 3's owner m1)
  const TAMSIN = 'Zelle payment from TAMSIN OKORO 55120';
  const ORLA = 'Zelle payment from ORLA PIKE 55121';
  const payers = [{ id: 'p-ava', name: 'Ava Lund' }, { id: 'p-max', name: 'Max Rowe' }, { id: 'p-cy', name: 'Cy Dunn' }, { id: 'p-tam', name: 'Tamsin Okoro' }];
  const sessions = [];
  const read = (s, list, at, sha) => {
    const text = JSON.stringify({ format: INCOME_FORMAT, what: 'Sitting', writtenAt: new Date(at).toISOString(), payers, items: list });
    applyIncomeReading(s, { listed: [{ source: 'sessions', sha }], files: { sessions: { sha, text } } }, at);
    refresh(s, at);
  };
  const record = (from) => {
    const s = bankRecord();
    for (const d of every(from, addDays(TODAY, -5), 14)) row(s, d, 210000, PAYROLL);
    sessions.length = 0;
    for (const [pid, who, off] of [['p-ava', 'AVA LUND 11', 0], ['p-max', 'MAX ROWE 12', 3]]) {
      for (const [k, d] of every(addDays(TODAY, -90 + off), addDays(TODAY, -9), 7).entries()) {
        row(s, addDays(d, 3), 9500, 'Zelle payment from ' + who);
        sessions.push({ id: pid + k, payer: pid, cents: 9500, day: d, at: new Date(addDays(d, 2) + 'T22:00:00Z').toISOString() });
      }
    }
    for (const [k, d] of [addDays(TODAY, -30), addDays(TODAY, -23), addDays(TODAY, -16)].entries()) sessions.push({ id: 'p-cy' + k, payer: 'p-cy', cents: 10000, day: d, at: new Date(d + 'T22:00:00Z').toISOString() });
    row(s, addDays(TODAY, -40), 9500, TAMSIN);
    row(s, addDays(TODAY, -12), 30000, ORLA);
    refresh(s, NOW);
    read(s, [], NOW - 120 * 86400000, 'a');
    read(s, sessions.slice(), NOW, 'b');
    return s;
  };
  const s = record(addDays(TODAY, -173));
  const look = lookOf(s);
  const tamsin = txOf(s, TAMSIN);
  const orla = txOf(s, ORLA);
  for (const [tx, who] of [[tamsin, 'Ava Lund'], [orla, 'Cy Dunn']]) {
    assert.ok(Object.values(s.income.pairs).includes(tx.id), tx.raw + ': 3.7 pairs it, and the pairing stays (it counts once)');
    assert.ok(look.aside.has(tx.id), tx.raw + ': set aside');
    assert.deepEqual(filingOf(look, tx).keys.apps, [], tx.raw + ': no app files it');
    const one = depositQueue(s, NOW).items.find((x) => x.key === 'payer:' + merchantKeyOf(tx.mkey));
    assert.deepEqual(one && [one.kind, one.count, one.paired.what, one.paired.payer], ['payer', 1, 'Sitting', who], tx.raw + ': queued under its sender, the pairing named');
  }
  const total = (st) => { const sec = moneyInBySource(st, NOW, 90); return sec.earned.cents + sec.windfalls.cents; };
  const before = total(s);
  assert.equal(before, inflow(s, addDays(TODAY, -89), TODAY, NOW).total, 'every deposit counted once');
  // the app's Add files the regulars' paired deposits, a deposit paired with the other payer's session included
  const job = acceptOffer(s, suggestions(s, NOW).shown.find((o) => o.intoKey === appKey('sessions')), NOW + MIN, nid());
  const look1 = lookOf(s);
  const regular = s.txs.filter((tx) => /AVA LUND|MAX ROWE/.test(tx.raw || '') && look1.paired.has(tx.id));
  assert.ok(regular.length > 15);
  const crossed = regular.filter((tx) => look1.paired.get(tx.id).some((key) => !key.includes(tx.raw.includes('AVA') ? 'p-ava' : 'p-max')));
  assert.ok(crossed.length > 0, 'a regular\'s deposit paired with the other payer\'s session');
  for (const tx of regular) assert.deepEqual([filingOf(look1, tx).to, filingOf(look1, tx).how], [job, 'app'], tx.raw + ' ' + tx.day + ': filed with the app');
  for (const tx of [tamsin, orla]) assert.equal(filingOf(look1, tx).to, null, tx.raw + ': not filed with the app');
  const row90 = moneyInBySource(s, NOW + MIN, 90).rows.find((one) => one.id === job);
  const inside = regular.filter((tx) => tx.day >= addDays(TODAY, -89));
  assert.equal(row90.cents, inside.reduce((n, tx) => n + tx.amount, 0), 'the app\'s source holds only the regulars\' deposits');
  assert.equal(row90.sessions.n, inside.reduce((n, tx) => n + look1.paired.get(tx.id).length, 0), 'and counts only their sessions');
  assert.equal(total(s), before, 'the totals hold');
  assert.deepEqual(depositQueue(s, NOW + MIN).items.filter((x) => x.paired).map((x) => x.merchant).sort(), ['Zelle From Orla Pike', 'Zelle From Tamsin Okoro']);
  // a new sender asks once: once a second deposit of theirs pairs with the app, both file with it
  row(s, addDays(TODAY, -2), 9500, TAMSIN);
  read(s, [...sessions, { id: 'p-tam0', payer: 'p-tam', cents: 9500, day: addDays(TODAY, -3), at: new Date(addDays(TODAY, -3) + 'T22:00:00Z').toISOString() }], NOW + 2 * MIN, 'c');
  const look2 = lookOf(s);
  const both = s.txs.filter((tx) => tx.raw === TAMSIN);
  assert.equal(both.length, 2);
  assert.ok(both.every((tx) => look2.paired.has(tx.id) && filingOf(look2, tx).to === job), 'both file with the app');
  assert.ok(!depositQueue(s, NOW + 2 * MIN).items.some((x) => x.key === 'payer:' + merchantKeyOf(tamsin.mkey)), 'nothing of the sender waits');
  // two devices of different depth set aside the same deposits and hold one queue
  const a = deviceOf(record(addDays(TODAY, -173)), () => NOW);
  const b = deviceOf(record(addDays(TODAY, -100)), () => NOW + MIN);
  const repo = memory();
  await settle([a, b], repo);
  const asideKeys = (st) => { const lk = lookOf(st); return [...lk.aside.keys()].map((id) => filingOf(lk, st.txs.find((tx) => tx.id === id)).keys.where.key).sort(); };
  assert.deepEqual(asideKeys(a.state), asideKeys(b.state));
  assert.equal(asideKeys(a.state).length, 2);
  assert.deepEqual(queueKeys(a.state), queueKeys(b.state), 'one queue');
});

test('round 9 (F4): the yearly and quiet lines name the first month they count; at 365 days a Back-end or One-off source with nothing in the 12 months reads the quiet line beside its money (round 7 owner\'s sliver7)', () => {
  // today 2026-11-16: the queue and the 365-day period from 2025-11-17, the 12 months from 2025-12-01; a record of 400 days
  const s = bankRecord();
  for (let d = addDays(TODAY, -1); d >= addDays(TODAY, -400); d = addDays(d, -14)) row(s, d, 210000, PAYROLL);
  const ODD = 'Zelle payment from ODD JOBS CLIENT 4';
  const ROY = 'Zelle payment from BACK CATALOGUE CO 8';
  const odd = row(s, '2025-11-24', 46300, ODD);
  for (const d of ['2025-11-24', '2026-02-24', '2026-05-24', '2026-08-24']) row(s, d, 41000, ROY);
  refresh(s, NOW);
  assert.equal(depositQueue(s, NOW).from, '2025-11-17');
  const oddJobs = makeInlet(s, { name: 'Odd jobs', kind: 'oneoff' }, NOW, nid());
  assert.ok(fileQueueItem(s, depositQueue(s, NOW).items.find((x) => x.key === 'payer:' + merchantKeyOf(odd.mkey)), oddJobs, NOW + MIN), 'filed from the queue');
  const back = makeInlet(s, { name: 'Back catalogue', kind: 'backend' }, NOW + 2 * MIN, nid());
  assert.ok(fileQueueItem(s, { intoKey: merchantKeyOf(txOf(s, ROY).mkey) }, back, NOW + 3 * MIN));
  const helper = fileURLToPath(new URL('./helpers/inlets-words.mjs', import.meta.url));
  const li = (html, id) => (html.match(new RegExp('<li class="fl-in-row" data-key="' + id + '">[\\s\\S]*?</li>')) || [''])[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  for (const days of [30, 90, 365]) {
    const sec = moneyInBySource(s, NOW, days);
    const o = sec.rows.find((one) => one.id === oddJobs);
    assert.ok(o, days + ': Odd jobs keeps a row');
    assert.deepEqual([o.last, o.year.since, o.cents], ['2025-11-24', '2025-12', days === 365 ? 46300 : 0], days + ': quiet, last paid Nov 24, 2025, its money in the 365 days');
    const b = sec.rows.find((one) => one.id === back);
    assert.deepEqual([b.last, b.year.cents, b.year.paid], [null, 123000, 3], days + ': Back catalogue, 3 payouts in the 12 months');
    for (const words of ['chess', 'finance']) {
      const [section] = JSON.parse(execFileSync(process.execPath, [helper, JSON.stringify([['inflows', 'inSection', { words }, sec, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0]])], { encoding: 'utf8' }));
      const quiet = say('inlets.quiet', words, { m: 12, month: 'Dec 2025', date: 'Nov 24, 2025' });
      assert.ok(li(section, oddJobs).includes(quiet), words + ' ' + days + ': ' + li(section, oddJobs));
      assert.ok(!li(section, oddJobs).includes('on record'), words + ' ' + days + ': never "$0 on record" beside its money');
      if (days === 365) {
        assert.match(li(section, oddJobs), /\$463/, words + ': its money in the period');
        assert.match(li(section, back), /\$1,640 .*\$1,230 on record since Dec 2025 · paid in 3 of 12 months/, words + ': the period above "on record", the months named');
      }
    }
  }
});

test('round 9 (K18): the record\'s first day (the shared floor, read about ten times a render) passes over a later row before any other test, with the same day as before', () => {
  // round 8's rule, as written before round 9: every row's day pattern read
  const before = (rows) => {
    let first = null;
    for (const tx of rows) {
      if (!tx || typeof tx !== 'object' || !Number.isFinite(tx.amount) || tx.amount < 0 || typeof tx.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(tx.day)) continue;
      if (tx.kind === 'decline' || tx.matchId || tx.source === 'manual') continue;
      if (first === null || tx.day < first) first = tx.day;
    }
    return first;
  };
  // the same day on records of every shape: declines, matched and manual rows, negative or missing amounts, bad days
  let seed = 7;
  const draw = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let run = 0; run < 300; run++) {
    const rows = [];
    for (let k = Math.floor(draw() * 40); k > 0; k--) {
      const day = draw() < 0.05 ? (draw() < 0.5 ? '2026-1-5' : 20260105) : addDays('2024-01-01', Math.floor(draw() * 900));
      rows.push({ day, amount: draw() < 0.05 ? -100 : draw() < 0.03 ? NaN : 100, kind: draw() < 0.1 ? 'decline' : 'income',
        matchId: draw() < 0.1 ? 'm' : null, source: draw() < 0.1 ? 'manual' : 'bank' });
    }
    assert.equal(ownFirstDay({ txs: rows }), before(rows), 'run ' + run);
  }
  // the cost: 10,000 rows, oldest first, read past their day only while one could be the first (round 8 read each in full)
  let reads = 0;
  const rows = [];
  for (let k = 0; k < 10000; k++) {
    const row0 = { day: addDays('2023-06-01', Math.floor(k / 10)), kind: 'income', matchId: null, source: 'bank' };
    Object.defineProperty(row0, 'amount', { get: () => { reads += 1; return 100; }, enumerable: true });
    rows.push(row0);
  }
  assert.equal(ownFirstDay({ txs: rows }), '2023-06-01');
  assert.ok(reads <= 10, reads + ' rows read in full of 10,000');
});
