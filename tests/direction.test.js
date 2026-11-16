/**
 * A merchant rule covers the direction it was made in (ARCHITECTURE 3.3, 3.8): a rule taught on money out files money
 * out, one taught on money in files money in; a refund with no rule for money in still takes the money-out rule; a rule
 * made before rules had a direction keeps covering both, and keeps money in when its category changes the kind. A rule
 * that arrives lets no link go; a stream that holds no linked deposit gives no pay, on every device. Every merchant,
 * payer, account and figure here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkDoc, defaultState } from '../js/model/schema.js';
import { mergeFeed } from '../js/model/merge.js';
import { followIncome, refresh } from '../js/model/detect.js';
import { classify, confirmMove, correctionReach, learnRule, reclassify } from '../js/model/classify.js';
import { clock, emptiedStreams, makeLedger, payStreams } from '../js/model/ledger.js';
import { restampByHand } from '../js/model/byhand.js';
import { mergeShared, readSharedFile, roundShared } from '../js/model/share.js';
import { applyCorrections, exportCorrections, mergeCorrections, noteMove, noteStream, restampCorrections, seedCorrections } from '../js/model/corrections.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime(); // Saturday 14 November 2026
const PAYER = 'BRAMBLEWOOD WORKS';
/** Paid every other Friday; the four latest deposits come after a purchase from the same firm, so they read as refunds. */
const PAYDAYS = ['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06'];

function dateOnly(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

function row(extId, amount, day, description) {
  return { extId, amount, posted: dateOnly(day), at: null, pending: false, description, payee: '', memo: '', mcc: null };
}

const ROWS = [
  ...PAYDAYS.map((day) => row('DEP-' + day, 150000, day, PAYER)),
  row('BUY-0920', -200000, '2026-09-20', PAYER),
  row('CAFE-1102', -1250, '2026-11-02', 'FERNLEAF CAFE 0042'),
  row('CAFE-1103', 1250, '2026-11-03', 'FERNLEAF CAFE 0042'), // the cafe gives the purchase back: a refund
  row('CAFE-1109', -980, '2026-11-09', 'FERNLEAF CAFE 0042'),
];
/** 61 days after the purchase: no longer read as its refund, so classification files it as income. */
const LATER = NOW + 14 * DAY_MS;
const NEXT = row('DEP-2026-11-20', 150000, '2026-11-20', PAYER);

function feed(rows, at = NOW) {
  return {
    src: 'simplefin', fetchedAt: at, fromMs: at - 200 * DAY_MS, toMs: at, errors: [],
    accounts: [{ extId: 'ACT-CHK-7', connId: 'CON-1', institution: 'Example Bank', name: 'Main Checking', currency: 'USD',
      balance: 812345, available: 812345, asOf: at - HOUR_MS, txs: rows }],
  };
}

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

/** A device: its record read from the bank, the copies Undo keeps, and a round that reaches both (as the store does). */
function device(repo, rows = ROWS, prepare = null, readAt = NOW) {
  const d = { state: defaultState(NOW - 200 * DAY_MS), kept: [] };
  if (prepare) prepare(d.state);
  mergeFeed(d.state, feed(rows, readAt), readAt);
  refresh(d.state, readAt);
  const api = {
    state: () => d.state,
    update: (now, past) => {
      now(d.state);
      d.kept = d.kept.map((json) => { const copy = JSON.parse(json); past(copy); return JSON.stringify(copy); });
    },
  };
  d.change = (fn) => { d.kept.push(JSON.stringify(d.state)); fn(d.state); };
  d.undo = (nowMs) => {
    const before = d.state;
    d.state = JSON.parse(d.kept.pop());
    restampByHand(before, d.state, nowMs);
    restampCorrections(before, d.state);
  };
  d.round = async (nowMs) => {
    const res = await roundShared(api, repo.transport, () => nowMs);
    assert.equal(checkDoc(d.state), null, 'the record is one the app will load again');
    return res;
  };
  d.read = (rows2, at) => { mergeFeed(d.state, feed(rows2, at), at); refresh(d.state, at); };
  d.row = (extId) => d.state.txs.find((tx) => tx.ext && tx.ext.id === extId);
  return d;
}

/** What the move sheet does: the correction through classify.learnRule, written down for the other devices, then detection. */
function correct(d, extId, fields, { onlyThis = false, at = NOW } = {}) {
  let result = null;
  d.change((s) => {
    const tx = s.txs.find((t) => t.ext && t.ext.id === extId);
    result = learnRule(s, tx.id, fields, { onlyThis });
    noteMove(s, tx.id, at);
    refresh(s, at);
  });
  return result; // what the toast counts
}

async function settle(devices, from) {
  let at = from;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const d of devices) {
      const res = await d.round(at++);
      if (res.changed || res.wrote) moved = true;
    }
    if (!moved) return at;
  }
  assert.fail('the devices never settled');
}

/** Round every device until they settle, then one more pass: nothing is applied or written. */
async function settleQuiet(devices, from) {
  const at = await settle(devices, from);
  for (const d of devices) {
    const res = await d.round(at + 1);
    assert.deepEqual([res.changed, res.wrote], [false, false], 'the file is no longer written');
  }
  return at + 2;
}

const deposits = (d) => d.state.txs.filter((tx) => tx.flow === 'in' && tx.mkey === d.row('BUY-0920').mkey);
const kinds = (d) => deposits(d).sort((x, y) => (x.day < y.day ? -1 : 1)).map((tx) => [tx.ext.id, tx.kind, tx.category]);
const incomeTotal = (d) => d.state.txs.filter((tx) => tx.kind === 'income').reduce((sum, tx) => sum + tx.amount, 0);
const linked = (d) => d.state.txs.filter((tx) => tx.streamId != null || tx.pairId != null).map((tx) => tx.ext.id).sort();
const rows = (d) => d.state.txs.map((tx) => [tx.ext.id, tx.kind, tx.category, tx.merchant, (tx.locks || []).filter((f) => f !== 'review').sort().join(',')])
  .sort((x, y) => (x[0] < y[0] ? -1 : 1));
/** What must be the same on every device: the rows, the income, which rows are linked, the payday. */
const outcome = (d, at) => [rows(d), incomeTotal(d), linked(d), clock(d.state, at).nextPayday];
const canon = (x) => (Array.isArray(x) ? '[' + x.map(canon).join(',') + ']'
  : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}' : JSON.stringify(x));

/* ------------------------------------------------------------------ one direction */

test('a purchase rule leaves the deposits of that payer alone: a paycheck stays income, a deposit read as a refund stays one', () => {
  const repo = repoOf();
  const a = device(repo);
  const before = kinds(a);
  assert.equal(before.filter(([, kind]) => kind === 'income').length, 6, 'the six deposits before the purchase read as income');
  correct(a, 'BUY-0920', { category: 'shopping' });
  assert.equal(a.row('BUY-0920').category, 'shopping');
  const after = kinds(a);
  assert.deepEqual(after.map(([id, kind]) => [id, kind]), before.map(([id, kind]) => [id, kind]), 'no deposit changes its kind');
  for (const [id, kind, category] of after) {
    if (kind === 'income') assert.equal(category, 'income', id);
    else assert.equal(category, 'shopping', id + ': a refund takes the category of the money-out rule');
  }
  const rule = a.state.settings.rules.find((r) => r.mkey === a.row('BUY-0920').mkey);
  assert.equal(rule.flow, 'out', 'the rule says which direction it covers');
});

test('the owner’s payer story: a paycheck filed as income for all money in, then a purchase as shopping for all money out; a later paycheck is income, linked, with the next payday', () => {
  const repo = repoOf();
  const a = device(repo);
  correct(a, 'DEP-2026-11-06', { category: 'income' });
  correct(a, 'BUY-0920', { category: 'shopping' });
  assert.deepEqual(deposits(a).map((tx) => tx.kind), Array(10).fill('income'), 'every deposit is income');
  assert.equal(a.row('BUY-0920').category, 'shopping');
  a.read([...ROWS, NEXT], LATER);
  const fresh = a.row('DEP-2026-11-20');
  assert.deepEqual([fresh.kind, fresh.category, fresh.streamId != null], ['income', 'income', true], 'the later paycheck is income and linked');
  assert.equal(clock(a.state, LATER + HOUR_MS).nextPayday, '2026-12-04');
  const flows = a.state.settings.rules.filter((r) => r.mkey === fresh.mkey).map((r) => [r.flow, r.category]).sort();
  assert.deepEqual(flows, [['in', 'income'], ['out', 'shopping']], 'one rule for each direction');
});

test('a money-in rule never files money out: a purchase from the payer keeps what it was', () => {
  const repo = repoOf();
  const a = device(repo);
  const buy = [a.row('BUY-0920').kind, a.row('BUY-0920').category];
  assert.deepEqual([a.row('DEP-2026-11-06').kind, a.row('DEP-2026-11-06').streamId], ['refund', null], 'a deposit read as a refund is not linked');
  correct(a, 'DEP-2026-11-06', { category: 'transfer' });
  assert.deepEqual([a.row('BUY-0920').kind, a.row('BUY-0920').category], buy);
  const free = deposits(a).filter((tx) => tx.streamId == null);
  assert.equal(free.length, 4);
  assert.ok(free.every((tx) => tx.kind === 'transfer'), 'all money in from the payer that can follow, follows');
});

test('a refund from a merchant with a money-out rule takes that category, and classify() says the same for a new row', () => {
  const repo = repoOf();
  const a = device(repo);
  assert.equal(a.row('CAFE-1103').kind, 'refund');
  correct(a, 'CAFE-1109', { category: 'eating_out' });
  assert.deepEqual([a.row('CAFE-1103').kind, a.row('CAFE-1103').category], ['refund', 'eating_out']);
  const rules = a.state.settings.rules;
  const back = classify({ description: 'FERNLEAF CAFE 0042', amount: 980, flow: 'in', accountType: 'checking' },
    { rules, recentSpends: [{ mkey: a.row('CAFE-1109').mkey, amount: 980, category: 'eating_out' }] });
  assert.deepEqual([back.kind, back.category], ['refund', 'eating_out']);
  const pay = classify({ description: 'FERNLEAF CAFE 0042', amount: 50000, flow: 'in', accountType: 'checking' }, { rules });
  assert.equal(pay.kind, 'income', 'a deposit classification files as income stays income');
  const credit = classify({ description: 'FERNLEAF CAFE 0042', amount: 980, flow: 'in', accountType: 'credit_card' }, { rules });
  assert.deepEqual([credit.kind, credit.category], ['refund', 'eating_out'], 'a card credit is a refund, and takes the rule');
});

/* ------------------------------------------------------- rules made before this change */

/** A record with a rule of the previous build: no direction, filed both ways (a purchase filed as shopping for the whole merchant). */
function oldRule(state, category = 'shopping') {
  state.settings.rules.push({ id: 'learned:old1', mkey: 'bramblewood works', category });
}

test('a rule made before rules had a direction still files both ways; an edit for one direction overrides it there only; Undo brings it back', () => {
  const repo = repoOf();
  const a = device(repo, ROWS, oldRule);
  assert.equal(a.row('DEP-2026-11-06').mkey, 'bramblewood works', 'the invented rule names the payer’s merchant key');
  assert.deepEqual(deposits(a).map((tx) => [tx.kind, tx.category]), Array(10).fill(['refund', 'shopping']), 'as before: every deposit a refund of shopping');
  assert.equal(a.row('BUY-0920').category, 'shopping');
  const was = outcome(a, NOW + HOUR_MS);
  correct(a, 'DEP-2026-07-03', { category: 'income' });
  assert.deepEqual(deposits(a).map((tx) => tx.kind), Array(10).fill('income'), 'money in follows the new rule');
  assert.equal(a.row('BUY-0920').category, 'shopping', 'money out keeps the old rule');
  correct(a, 'BUY-0920', { category: 'gifts' });
  assert.equal(a.row('BUY-0920').category, 'gifts');
  assert.deepEqual(deposits(a).map((tx) => tx.kind), Array(10).fill('income'), 'a purchase edit leaves money in alone');
  a.undo(NOW + 1000);
  assert.equal(a.row('BUY-0920').category, 'shopping', 'Undo of the money-out edit: the old rule files money out again');
  a.undo(NOW + 2000);
  assert.deepEqual(outcome(a, NOW + HOUR_MS), was, 'Undo of the money-in edit: the old rule files money in again');
});

test('shipping this moves no figure: a record with old rules reads the same before and after a refresh', () => {
  const repo = repoOf();
  for (const category of ['shopping', 'income', 'transfer']) {
    const a = device(repo, ROWS, (s) => oldRule(s, category));
    const was = [outcome(a, NOW + HOUR_MS), JSON.stringify(a.state.settings.rules)];
    refresh(a.state, NOW + 1000);
    assert.deepEqual([outcome(a, NOW + HOUR_MS), JSON.stringify(a.state.settings.rules)], was, category);
    const expect = category === 'shopping' ? 'refund' : category;
    assert.ok(deposits(a).every((tx) => tx.kind === expect), category + ': every deposit follows the old rule');
  }
});

/* ------------------------------------------------------------------ sharing */

test('an old rule on two devices: a directional edit on one overrides it there in that direction only, and its Undo brings it back on both', async () => {
  const repo = repoOf();
  const a = device(repo, ROWS, oldRule);
  const b = device(repo, ROWS, oldRule);
  await settleQuiet([a, b], NOW + 100);
  const was = outcome(b, NOW + HOUR_MS);
  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 }); // all money in: income, over the old rule
  await settleQuiet([a, b], NOW + 2000);
  for (const d of [a, b]) {
    assert.deepEqual(deposits(d).map((tx) => tx.kind), Array(10).fill('income'), 'money in follows the new rule');
    assert.equal(d.row('BUY-0920').category, 'shopping', 'money out keeps the old rule');
    assert.deepEqual(d.state.settings.rules.map((r) => [r.flow || 'both', r.category]).sort(), [['both', 'shopping'], ['in', 'income']]);
  }
  a.undo(NOW + 3000);
  await settleQuiet([a, b], NOW + 4000);
  for (const d of [a, b]) {
    assert.deepEqual(d.state.settings.rules.map((r) => [r.flow, r.category]), [[undefined, 'shopping']], 'only the old rule is left');
    assert.equal(d.row('BUY-0920').category, 'shopping');
  }
  // the rows, the income, the links and the payday are the same on both (the pay stream detection made on B while the
  // deposits were income holds none of them now, so detection switched it off: no payday from it)
  assert.deepEqual(outcome(a, NOW + HOUR_MS), outcome(b, NOW + HOUR_MS));
  assert.equal(clock(b.state, NOW + HOUR_MS).nextPayday, null);
  assert.deepEqual(outcome(b, NOW + HOUR_MS)[0].filter((r) => r[0].startsWith('DEP-')).map((r) => [r[1], r[2]]),
    was[0].filter((r) => r[0].startsWith('DEP-')).map((r) => [r[1], r[2]]), 'every deposit reads as the old rule files it again');
});

test('a directional rule travels in its own section, which the previous build keeps whole; the other device files the same way', async () => {
  const repo = repoOf();
  const a = device(repo);
  const b = device(repo);
  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 });
  correct(a, 'BUY-0920', { category: 'shopping' }, { at: NOW + 2000 });
  await settleQuiet([a, b], NOW + 3000);
  const file = JSON.parse(repo.text);
  const key = Object.keys(file.flowRules.in)[0];
  assert.match(key, /^p[0-9a-f]{13}$/);
  assert.equal(file.flowRules.in[key].category.v, 'income');
  assert.equal(file.flowRules.out[key].category.v, 'shopping');
  assert.ok(!file.corrections || !file.corrections.rules || !Object.hasOwn(file.corrections.rules, key), 'never in the section the previous build applies both ways');
  for (const name of Object.keys(file.corrections ? file.corrections.rules || {} : {})) assert.match(name, /^p[0-9a-f]{13}$/);
  assert.deepEqual(outcome(b, NOW + HOUR_MS), outcome(a, NOW + HOUR_MS));
  assert.deepEqual(b.state.settings.rules.filter((r) => r.flow).map((r) => [r.flow, r.category]).sort(), [['in', 'income'], ['out', 'shopping']]);
  for (const d of [a, b]) d.read([...ROWS, NEXT], LATER);
  await settleQuiet([a, b], LATER + 1000);
  for (const d of [a, b]) {
    const fresh = d.row('DEP-2026-11-20');
    assert.deepEqual([fresh.kind, fresh.streamId != null], ['income', true]);
  }
  assert.deepEqual(outcome(b, LATER + HOUR_MS), outcome(a, LATER + HOUR_MS));
  assert.equal(clock(a.state, LATER + HOUR_MS).nextPayday, '2026-12-04');
});

test('a file the previous build wrote reads the same, and its rules file both ways', async () => {
  const base = { v: 1, app: 'networth', savedAt: 5, byHand: {} };
  const old = { ...base, corrections: { rules: { p0123456789abc: { category: { v: 'shopping', at: 3, over: 0 } } }, moves: {}, streams: {} } };
  const read = readSharedFile(JSON.stringify(old));
  assert.equal(canon(read.corrections.rules), canon(old.corrections.rules));
  assert.equal(read.flowRules, undefined);
  // the payer's rule as the previous build wrote it files both ways, as there: the purchase and every deposit not linked
  // follow it (a linked paycheck keeps its kind, as on a device of the previous build)
  const repo = repoOf();
  const a = device(repo);
  const key = Object.keys(exportCorrections((() => { const s = JSON.parse(JSON.stringify(a.state)); oldRule(s); return s; })()).rules)[0];
  repo.text = JSON.stringify({ ...base, corrections: { rules: { [key]: { category: { v: 'shopping', at: NOW, over: 0 } } } } });
  repo.sha = 'old';
  await a.round(NOW + 1000);
  assert.deepEqual(a.state.settings.rules.map((r) => [r.flow, r.category]), [[undefined, 'shopping']]);
  assert.equal(a.row('BUY-0920').category, 'shopping');
  assert.deepEqual(kinds(a).map(([, kind, category]) => [kind, category]), [...Array(6).fill(['income', 'income']), ...Array(4).fill(['refund', 'shopping'])]);
});

test('directional rules merge field by field: commutative, associative and idempotent, beside the old rules', () => {
  const k = 'p0123456789abc';
  const x = { rules: { [k]: { category: { v: 'shopping', at: 5, over: 0 } }, [k + ':in']: { category: { v: 'income', at: 7, over: 0 } } } };
  const y = { rules: { [k + ':in']: { category: { v: 'transfer', at: 9, over: 7 }, merchant: { v: 'Bramblewood', at: 2 } }, [k + ':out']: { klass: { v: 'want', at: 4 } } } };
  const z = { rules: { [k + ':out']: { klass: { deleted: true, at: 6, undo: true } }, [k]: { merchant: { v: 'Bramble', at: 1 } } } };
  const m = (p, q) => mergeCorrections(p, q);
  assert.equal(canon(m(x, y)), canon(m(y, x)));
  assert.equal(canon(m(m(x, y), z)), canon(m(x, m(y, z))));
  assert.equal(canon(m(m(x, y), m(x, y))), canon(m(x, y)));
  const all = m(m(x, y), z);
  assert.equal(all.rules[k + ':in'].category.v, 'transfer');
  assert.equal(all.rules[k + ':in'].merchant.v, 'Bramblewood');
  assert.equal(all.rules[k + ':out'].klass.deleted, true);
  assert.equal(all.rules[k].category.v, 'shopping');
  // the file: the same laws through its two sections
  const file = (c) => readSharedFile(JSON.stringify({ v: 1, app: 'networth', savedAt: 1, byHand: {},
    corrections: { rules: Object.fromEntries(Object.entries(c.rules).filter(([key]) => !key.includes(':'))) },
    flowRules: { out: Object.fromEntries(Object.entries(c.rules).filter(([key]) => key.endsWith(':out')).map(([key, v]) => [key.slice(0, 14), v])),
      in: Object.fromEntries(Object.entries(c.rules).filter(([key]) => key.endsWith(':in')).map(([key, v]) => [key.slice(0, 14), v])) } }));
  const [fx, fy, fz] = [x, y, z].map(file);
  assert.ok(fx && fy && fz, 'each file reads');
  assert.equal(canon(mergeShared(fx, fy)), canon(mergeShared(fy, fx)));
  assert.equal(canon(mergeShared(mergeShared(fx, fy), fz)), canon(mergeShared(fx, mergeShared(fy, fz))));
  assert.equal(canon(mergeShared(fx, fx)), canon(fx));
  assert.equal(canon(mergeShared(mergeShared(fx, fy), fz).corrections.rules), canon(all.rules));
});

test('the file is checked: a directional section this version cannot read refuses the whole file', () => {
  const base = { v: 1, app: 'networth', savedAt: 5, byHand: {} };
  const bad = [
    { flowRules: { out: { 'p0123456789abc:out': { category: { v: 'shopping', at: 1 } } } } },
    { flowRules: { sideways: { p0123456789abc: { category: { v: 'shopping', at: 1 } } } } },
    { flowRules: { in: { p0123456789abc: { category: { v: 'not-a-category', at: 1 } } } } },
    { flowRules: 'nope' },
  ];
  for (const one of bad) assert.equal(readSharedFile(JSON.stringify({ ...base, ...one })), null, JSON.stringify(one));
  const good = { ...base, flowRules: { in: { p0123456789abc: { category: { v: 'income', at: 3, over: 0 } } } } };
  const read = readSharedFile(JSON.stringify(good));
  assert.equal(read.corrections.rules['p0123456789abc:in'].category.v, 'income');
});

/* ------------------------------------------------- a rule that arrives lets no link go (3.8) */

/**
 * The owner refiles the payer's deposits from income to Transfer for all money in, on A (through a deposit that is not
 * linked: a linked one cannot take another kind in the sheet), while C has already linked a newer deposit A does not
 * hold. `when` is when C reads that deposit. Where the devices end after the edit is the known limit of 3.8.
 */
async function laterDeposit(when) {
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b, c] = ds;
  await settleQuiet(ds, NOW + 2000);
  const next = [...ROWS, NEXT];
  if (when === 'before') c.read(next, LATER);
  if (when === 'rounds-then-reads') { await c.round(LATER - 10); c.read(next, LATER); }
  assert.equal(a.row('DEP-2026-11-06').streamId, null, 'the deposit read as a refund is not linked');
  correct(a, 'DEP-2026-11-06', { category: 'transfer' }, { at: LATER + 1000 }); // every deposit from the payer is a transfer
  if (when === 'after-edit') c.read(next, LATER + 1500);
  await a.round(LATER + 2000);
  await b.round(LATER + 2100);
  if (when === 'closed') c.read(next, LATER + 2200);
  let at = await settle(ds, LATER + 3000);
  for (const d of ds) d.read(next, LATER + 5000);
  at = await settleQuiet(ds, Math.max(at, LATER + 6000));
  return { ds, at };
}

test('one Undo takes back the whole correction on every device, a newer deposit one device linked included', async () => {
  const { ds, at } = await laterDeposit('before');
  const [a, b, c] = ds;
  a.undo(at + 10);
  let next = await settle([a, b, c], at + 100);
  for (const d of ds) d.read([...ROWS, NEXT], LATER + 9 * HOUR_MS); // the next reading on each (the copy Undo put back on A is older)
  next = await settleQuiet([a, b, c], next + 100);
  for (const d of ds) {
    assert.deepEqual(outcome(d, LATER + 9000), outcome(a, LATER + 9000));
    const fresh = d.row('DEP-2026-11-20');
    assert.deepEqual([fresh.kind, fresh.streamId != null], ['income', true]);
  }
});

test('a seed releases nothing: an older device’s first round brings another value at 0, and the linked deposits stay', async () => {
  const repo = repoOf();
  const b = device(repo, ROWS, (s) => oldRule(s, 'income'));
  seedCorrections(b.state);
  const was = linked(b);
  assert.ok(was.length >= 10, 'the paychecks are linked');
  // another device of the previous build, with a rule of its own for the payer, rounds for the first time: its seed
  const d = device(repo, ROWS, (s) => oldRule(s, 'gifts'));
  seedCorrections(d.state);
  await d.round(NOW + 1000);
  await b.round(NOW + 2000);
  assert.equal(b.state.settings.rules[0].category, 'gifts', 'the canonical order gave the seed of the other device');
  assert.deepEqual(linked(b), was, 'no link was let go for a seed');
});

test('the purchase against the paycheck: nothing changes on any device, a later paycheck included', async () => {
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b, c] = ds;
  correct(a, 'DEP-2026-07-03', { category: 'income' }, { at: NOW + 1000 });
  await settleQuiet(ds, NOW + 2000);
  c.read([...ROWS, NEXT], LATER);
  const before = ds.map((d) => [incomeTotal(d), linked(d)]);
  correct(a, 'BUY-0920', { category: 'shopping' }, { at: LATER + 1000 });
  await settle(ds, LATER + 2000);
  assert.deepEqual(ds.map((d) => [incomeTotal(d), linked(d)]), before, 'the purchase rule touched no deposit on any device');
  for (const d of ds) d.read([...ROWS, NEXT], LATER + 5000);
  await settleQuiet(ds, LATER + 6000);
  for (const d of ds) {
    assert.deepEqual(outcome(d, LATER + 9000), outcome(a, LATER + 9000));
    const fresh = d.row('DEP-2026-11-20');
    assert.deepEqual([fresh.kind, fresh.category, fresh.streamId != null], ['income', 'income', true]);
    assert.equal(clock(d.state, LATER + 9000).nextPayday, '2026-12-04');
    assert.ok(!(d.state.txs.some((tx) => tx.flow === 'in' && (tx.locks || []).includes('category') && tx.ext.id !== 'DEP-2026-07-03')),
      'no deposit was locked by the purchase edit');
  }
  void applyCorrections;
});

/* ------------------------------------------------------------------ the sheet's words */

test('the sheet says which direction a correction covers, in plain words, in both word modes', async () => {
  const { say } = await import('../js/model/words.js');
  const { readFile } = await import('node:fs/promises');
  for (const [direction, plain, other] of [['out', 'money out', 'money in'], ['in', 'money in', 'money out']]) {
    for (const [mode, term, not] of [['chess', /\bmoves?\b/, /\btransactions?\b/], ['finance', /\btransactions?\b/, /\bmoves?\b/]]) {
      const all = say('tx.scope.all.' + direction, mode, { count: 7, merchant: 'Bramblewood' });
      const later = say('tx.scope.later.' + direction, mode, { merchant: 'Bramblewood' });
      for (const text of [all, later]) {
        assert.ok(text.toLowerCase().includes(plain), mode + ' ' + direction + ': ' + text);
        assert.match(text, term, mode + ': its own word for a move');
        assert.doesNotMatch(text, not, mode + ': never the other mode’s word');
        assert.ok(text.includes('Bramblewood'));
      }
      assert.ok(all.includes('7'), 'the count it names');
      assert.ok(all.toLowerCase().includes(other), 'it says the other direction is left alone');
    }
  }
  const sheet = await readFile(new URL('../js/views/sheet-tx.js', import.meta.url), 'utf8');
  assert.match(sheet, /All money out/);
  assert.match(sheet, /All money in/);
  assert.match(sheet, /'tx\.scope\.all\.' \+ direction/);
  assert.match(sheet, /'tx\.scope\.later\.' \+ direction/);
  assert.doesNotMatch(sheet, /All from this merchant/);
});

test('an edit of a rule both ways that arrives lets go only the rows whose category it gives: a paycheck under a money-in rule stays linked', () => {
  const repo = repoOf();
  const b = device(repo, ROWS, oldRule);
  correct(b, 'DEP-2026-11-06', { category: 'income' }, { at: NOW + 1000 }); // all money in: income, over the old rule
  const was = linked(b);
  assert.ok(was.length >= 10, 'the paychecks are linked');
  // the previous build's edit of the old rule both ways, as it arrives (an explicit edit: stamped, naming the cell it replaced)
  const copy = exportCorrections(b.state);
  const key = Object.keys(copy.rules).find((k) => !k.includes(':'));
  const cell = copy.rules[key].category;
  copy.rules[key] = { ...copy.rules[key], category: { v: 'gifts', at: NOW + 2000, over: cell.at } };
  b.state.share.corrections = copy;
  applyCorrections(b.state, NOW + 3000);
  refresh(b.state, NOW + 3000);
  assert.equal(b.state.settings.rules.find((r) => !r.flow).category, 'gifts', 'the old rule took the edit');
  assert.equal(b.row('BUY-0920').category, 'gifts', 'money out follows it');
  assert.deepEqual(linked(b), was, 'the paychecks, filed by the money-in rule, keep their link');
});

/* ------------------------------------------- old rules on every device, then a directional edit and its Undo */

/**
 * The rule the previous build made after detection had linked the early paychecks (a purchase filed as shopping for the
 * whole merchant), held by the device and seeded at 0 as every device seeds what it held before sharing.
 */
function heldOldRule(d, category = 'shopping') {
  d.state.settings.rules.push({ id: 'learned:old2', mkey: 'bramblewood works', category });
  reclassify(d.state, d.state.txs.map((tx) => tx.id));
  refresh(d.state, NOW);
  seedCorrections(d.state);
  return d;
}

const earlyLinked = (d) => deposits(d).filter((tx) => tx.day < '2026-09-20' && tx.kind === 'income' && tx.streamId != null).length;

for (const later of [false, true]) {
  test('an old rule seeded at 0 on three devices, a money-in edit, then its Undo: every device goes back, the early paychecks linked'
    + (later ? ' (a later paycheck read first on one device, its clock ahead)' : ''), async () => {
    const repo = repoOf();
    const ds = [device(repo), device(repo), device(repo)].map((d) => heldOldRule(d));
    const [a, b, c] = ds;
    for (const d of ds) assert.equal(earlyLinked(d), 6, 'the six paychecks before the purchase stay linked under the old rule');
    let at = await settleQuiet(ds, NOW + 100);
    const was = outcome(a, NOW + HOUR_MS);
    assert.equal(was[1], 6 * 150000);
    assert.equal(was[3], null, 'no payday: the stream lapsed when its deposits turned into refunds');
    const rowsNow = later ? [...ROWS, NEXT] : ROWS;
    if (later) b.read(rowsNow, LATER);
    const base = later ? LATER : at;
    correct(c, 'DEP-2026-10-23', { category: 'income' }, { at: base + 10 });
    at = await settle(ds, base + 20);
    if (later) for (const d of [a, c]) d.read(rowsNow, at);
    at = await settleQuiet(ds, at + 10);
    for (const d of ds) assert.equal(incomeTotal(d), (later ? 11 : 10) * 150000, 'every deposit is income after the edit');
    c.undo(at + 10);
    for (const d of ds) d.read(rowsNow, at + 20);
    at = await settleQuiet(ds, at + 30);
    const t = (later ? LATER : NOW) + HOUR_MS;
    for (const d of ds) {
      assert.deepEqual(outcome(d, t), outcome(c, t), 'every device agrees with the one that made the Undo');
      assert.equal(incomeTotal(d), 6 * 150000, 'the early paychecks are income again, and only they');
      assert.equal(earlyLinked(d), 6, 'and linked');
      assert.equal(clock(d.state, t).nextPayday, null, 'no payday, as before the edit');
      assert.deepEqual(d.state.settings.rules.map((r) => [r.flow, r.category]), [[undefined, 'shopping']], 'only the old rule is left');
    }
    if (!later) assert.deepEqual(outcome(a, NOW + HOUR_MS), was, 'the record reads as it did before the edit');
  });
}

/* ------------------------------------------------- a rule that arrives lets go of stream links, never of a pair */

const XFER_OUT = 'ONLINE XFER TO RESERVE 0071';
const XFER_IN = 'ONLINE XFER FROM CHECKING 0042';
const XFERS = ['2026-09-01', '2026-10-01', '2026-11-01'];
/** A checking and a savings account: transfers paired between them, one more transfer out with no leg in, and a later pair. */
function twoAccounts(at, later) {
  const chk = [...XFERS.map((day) => row('XO-' + day, -50000, day, XFER_OUT)), row('XO-2026-08-15', -50000, '2026-08-15', XFER_OUT),
    ...PAYDAYS.slice(0, 6).map((day) => row('DEP-' + day, 150000, day, PAYER))];
  const sav = XFERS.map((day) => row('XI-' + day, 50000, day, XFER_IN));
  if (later) { chk.push(row('XO-2026-11-12', -50000, '2026-11-12', XFER_OUT)); sav.push(row('XI-2026-11-12', 50000, '2026-11-12', XFER_IN)); }
  const account = (extId, name, txs) => ({ extId, connId: 'CON-1', institution: 'Example Bank', name, currency: 'USD', balance: 500000, available: 500000, asOf: at - HOUR_MS, txs });
  return { src: 'simplefin', fetchedAt: at, fromMs: at - 200 * DAY_MS, toMs: at, errors: [], accounts: [account('ACT-CHK-7', 'Main Checking', chk), account('ACT-SAV-3', 'Reserve Savings', sav)] };
}

for (const old of [false, true]) {
  test('a money-out rule that arrives leaves a pair alone: both devices hold the same rows, kinds, class and Book, and no recurring entry'
    + (old ? ' (an old rule of the transfer seeded first)' : ''), async () => {
    const repo = repoOf();
    const ds = [false, true].map((later) => {
      const d = device(repo, []);
      mergeFeed(d.state, twoAccounts(NOW, later), NOW + (later ? HOUR_MS : 0));
      refresh(d.state, NOW + (later ? HOUR_MS : 0));
      if (old) {
        d.state.settings.rules.push({ id: 'learned:old3', mkey: d.row('XO-2026-09-01').mkey, merchant: 'Reserve Transfer' });
        reclassify(d.state, d.state.txs.map((tx) => tx.id));
        refresh(d.state, NOW);
      }
      seedCorrections(d.state);
      return d;
    });
    const [a, b] = ds;
    assert.ok(b.row('XO-2026-11-12').pairId != null, 'the later pair is paired on B');
    correct(a, 'XO-2026-08-15', { category: 'shopping' }, { at: NOW + 1000 });
    let at = await settle(ds, NOW + 2000);
    assert.ok(b.row('XO-2026-11-12').pairId != null && b.row('XI-2026-11-12').pairId != null, 'the arriving rule let go of no pair');
    for (let day = 0; day <= 3; day++) {
      for (const d of ds) { const when = at + day * DAY_MS; mergeFeed(d.state, twoAccounts(when, true), when); refresh(d.state, when); }
      at = await settle(ds, at + day * DAY_MS + 10);
    }
    await settleQuiet(ds, at + 10);
    const book = (d) => [d.state.txs.map((tx) => [tx.ext.id, tx.kind, tx.category, tx.klass, tx.pairId != null, tx.recurringId != null]).sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      (d.state.recurring || []).filter((entry) => entry.active !== false).map((entry) => entry.name)];
    assert.deepEqual(book(b), book(a), 'the same rows, kinds, class and Book on both');
    assert.deepEqual(book(a)[1], [], 'no recurring entry learned from a leg unpaired for a moment');
    assert.equal(a.row('XO-2026-08-15').category, 'shopping');
  });
}

/* ------------------------------------------------------------- a pay stream left with no deposit */

const BUYS = ['2026-06-30', '2026-07-30', '2026-08-29', '2026-09-20', '2026-10-20'].map((day, i) => row('BUY-' + i, -200000, day, PAYER));
for (const [label, rules, buys] of [
  ['an old rule, one purchase', true, false],
  ['an old rule, a purchase each month', true, true],
  ['no rule, a purchase each month: every deposit a refund before the first rule (as the previous build had it)', false, true],
]) {
  test('a pay stream an Undo leaves with no deposit gives no payday on any device, derived and never stored (' + label + ')', async () => {
    const repo = repoOf();
    const list = buys ? [...PAYDAYS.map((day) => row('DEP-' + day, 150000, day, PAYER)), ...BUYS] : ROWS;
    const ds = [device(repo, list, rules ? oldRule : null), device(repo, list, rules ? oldRule : null)];
    const [a, b] = ds;
    for (const d of ds) seedCorrections(d.state);
    let at = await settleQuiet(ds, NOW + 100);
    assert.equal(clock(a.state, NOW + HOUR_MS).nextPayday, null, 'no payday before the edit');
    correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: at + 10 });
    at = await settleQuiet(ds, at + 20);
    for (const d of ds) assert.ok(clock(d.state, NOW + HOUR_MS).nextPayday, 'the edit made a payday');
    a.undo(at + 10);
    at = await settleQuiet(ds, at + 20);
    for (const d of ds) {
      assert.equal(clock(d.state, NOW + HOUR_MS).nextPayday, null, 'no payday from a stream with no deposit');
      assert.deepEqual(payStreams(d.state, NOW + HOUR_MS), [], 'no pay stream: none holds a deposit');
      assert.deepEqual(makeLedger(d.state, NOW + HOUR_MS).position().receivables, [], 'no pay accrued from it');
      assert.deepEqual(outcome(d, NOW + HOUR_MS), outcome(a, NOW + HOUR_MS));
    }
    // the owner makes the edit again: the payday comes back with the deposits, on both
    correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: at + 10 });
    at = await settleQuiet(ds, at + 20);
    for (const d of ds) {
      assert.ok(clock(d.state, NOW + HOUR_MS).nextPayday, 'the payday is back');
      assert.deepEqual(outcome(d, NOW + HOUR_MS), outcome(a, NOW + HOUR_MS));
    }
  });
}

test('a stream that holds no deposit for a while keeps what it is and what the owner set, and gives no pay whatever its settings', () => {
  for (const locks of [[], ['name'], ['active', 'accrue']]) {
    const repo = repoOf();
    const a = device(repo, PAYDAYS.map((day) => row('DEP-' + day, 150000, day, PAYER)));
    a.state.settings.smoothing = true;
    const stream = a.state.streams.find((s) => s.active !== false);
    assert.ok(stream, 'detection made the pay stream');
    stream.accrue = true;
    stream.locks = locks;
    stream.name = 'Day job';
    assert.equal(clock(a.state, NOW + HOUR_MS).nextPayday, '2026-11-20', 'a payday while it holds its deposits');
    const face = (one) => JSON.stringify([one.active, one.name, one.locks, one.cadence]);
    const was = face(stream);
    for (const tx of a.state.txs) if (tx.streamId === stream.id) { tx.streamId = null; tx.kind = 'transfer'; tx.category = 'transfer'; tx.locks = ['category']; }
    refresh(a.state, NOW + 1000);
    assert.equal(face(stream), was, locks.join('+') + ': the stream is left on, as it was (as the previous build left it)');
    const ledger = makeLedger(a.state, NOW + HOUR_MS);
    assert.deepEqual([ledger.clock().nextPayday, ledger.clock().payAwaited], [null, null], 'no payday, no pay awaited');
    assert.deepEqual([ledger.payStreams(), ledger.position().receivables, ledger.nextPayOf(stream.id)], [[], [], null], 'no pay stream, nothing accrued, no next pay');
  }
});

test('a stream the owner named on one device, emptied by an Undo on another: no payday on any device, the name kept and back with the deposits', async () => {
  const repo = repoOf();
  const list = [...PAYDAYS.map((day) => row('DEP-' + day, 150000, day, PAYER)), ...BUYS];
  const ds = [device(repo, list, oldRule), device(repo, list, oldRule), device(repo, list, oldRule)];
  const [a, b, c] = ds;
  for (const d of ds) seedCorrections(d.state);
  let at = await settleQuiet(ds, NOW + 100);
  correct(a, 'DEP-2026-11-06', { category: 'income' }, { at: at + 10 });
  at = await settleQuiet(ds, at + 20);
  for (const d of ds) assert.equal(clock(d.state, NOW + HOUR_MS).nextPayday, '2026-11-20', 'the edit made a payday on every device');
  b.change((s) => {
    const stream = s.streams.find((one) => one.active !== false && s.txs.some((tx) => tx.streamId === one.id));
    stream.name = 'Bramble pay';
    stream.locks = [...(stream.locks || []), 'name'];
    noteStream(s, stream.id, at + 10);
    refresh(s, at + 10);
  });
  at = await settleQuiet(ds, at + 20);
  a.undo(at + 10);
  at = await settleQuiet(ds, at + 20);
  const named = (d) => Object.values(exportCorrections(d.state).streams).some((entry) => entry.name && entry.name.v === 'Bramble pay');
  for (const [step, rows] of [['after the Undo', list], ['after a later deposit and a reading', [...list, NEXT]]]) {
    if (rows !== list) { for (const d of ds) d.read(rows, LATER); at = await settleQuiet(ds, Math.max(at, LATER) + 20); }
    const t = (rows === list ? NOW : LATER) + HOUR_MS;
    for (const d of ds) {
      assert.equal(clock(d.state, t).nextPayday, null, step + ': no payday from a stream with no deposit');
      assert.deepEqual(outcome(d, t), outcome(a, t), step + ': every device the same');
      assert.ok(named(d), step + ': the owner’s name is kept as a setting');
    }
  }
  correct(a, 'DEP-2026-11-20', { category: 'income' }, { at: at + 10 });
  at = await settleQuiet(ds, at + 20);
  for (const d of ds) {
    assert.equal(clock(d.state, LATER + HOUR_MS).nextPayday, '2026-12-04', 'the payday is back with the deposits');
    const stream = d.state.streams.find((one) => one.active !== false && d.state.txs.some((tx) => tx.streamId === one.id));
    assert.equal(stream && stream.name, 'Bramble pay', 'with the owner’s name');
    assert.deepEqual(outcome(d, LATER + HOUR_MS), outcome(a, LATER + HOUR_MS));
  }
  void c;
});

/* ------------------------------------------------- refunds follow a money-out edit made over an old rule */

/** A later refund at the cafe: the second purchase given back. */
const CAFE_LATER = row('CAFE-1121', 980, '2026-11-21', 'FERNLEAF CAFE 0042');

for (const [old, many] of [[true, 1], [true, 2], [false, 2]]) {
  test('a money-out edit of a retailer' + (old ? ' with an old rule (as the previous build made it)' : '') + ': the refund on record follows, a later refund follows, and Undo restores both'
    + (many > 1 ? ' (across devices)' : ''), async () => {
    const repo = repoOf();
    const ds = Array.from({ length: many }, () => device(repo));
    for (const d of ds) {
      if (old) {
        d.state.settings.rules.push({ id: 'learned:r0old5', mkey: d.row('CAFE-1109').mkey, category: 'shopping' });
        reclassify(d.state, d.state.txs.map((tx) => tx.id));
        refresh(d.state, NOW);
      }
      seedCorrections(d.state);
    }
    const [a] = ds;
    let at = many > 1 ? await settleQuiet(ds, NOW + 100) : NOW + 100;
    const cafe = (d, id) => [d.row(id).kind, d.row(id).category];
    if (old) assert.deepEqual(cafe(a, 'CAFE-1103'), ['refund', 'shopping'], 'the old rule files the refund');
    const toast = correct(a, 'CAFE-1109', { category: 'groceries' }, { at: at + 10 });
    assert.deepEqual([toast.changed - toast.refunds, toast.refunds], [2, 1], 'the toast: 2 moves out and 1 refund corrected');
    if (many > 1) at = await settleQuiet(ds, at + 20);
    for (const d of ds) {
      assert.deepEqual(cafe(d, 'CAFE-1102'), ['spend', 'groceries'], 'money out follows the edit');
      assert.deepEqual(cafe(d, 'CAFE-1103'), ['refund', 'groceries'], 'the refund on record follows its purchase');
    }
    for (const d of ds) d.read([...ROWS, CAFE_LATER], LATER);
    if (many > 1) at = await settleQuiet(ds, LATER + 100);
    for (const d of ds) assert.deepEqual(cafe(d, 'CAFE-1121'), ['refund', 'groceries'], 'a later refund follows too');
    for (const d of ds) assert.ok(d.state.txs.filter((tx) => tx.kind === 'income').every((tx) => tx.mkey !== d.row('CAFE-1109').mkey), 'no deposit of the cafe turned into income');
    a.undo(LATER + 200);
    for (const d of ds) d.read([...ROWS, CAFE_LATER], LATER + 300);
    if (many > 1) await settleQuiet(ds, LATER + 400);
    for (const d of ds) {
      if (old) {
        assert.deepEqual(cafe(d, 'CAFE-1102'), ['spend', 'shopping'], 'Undo: the old rule files money out again');
        assert.deepEqual(cafe(d, 'CAFE-1103'), ['refund', 'shopping'], 'Undo: the refund on record goes back');
        assert.deepEqual(cafe(d, 'CAFE-1121'), ['refund', 'shopping'], 'Undo: the later refund goes back');
      } else {
        assert.notEqual(d.row('CAFE-1103').category, 'groceries', 'Undo: the refund on record goes back');
        assert.notEqual(d.row('CAFE-1121').category, 'groceries', 'Undo: the later refund goes back');
      }
      assert.deepEqual(outcome(d, LATER + HOUR_MS), outcome(a, LATER + HOUR_MS));
    }
  });
}

test('a file that holds one rule of one direction in both places reads it merged field by field: the newer stamp wins, either way round', () => {
  for (const [inRules, inFlow, want] of [[['gifts', 9], ['travel', 5], 'gifts'], [['travel', 5], ['gifts', 9], 'gifts'], [['gifts', 4], ['travel', 7], 'travel']]) {
    const file = { v: 1, app: 'networth', savedAt: 1, byHand: {},
      corrections: { rules: { 'p0000000000001:out': { category: { v: inRules[0], at: inRules[1], over: 0 } } } },
      flowRules: { out: { p0000000000001: { category: { v: inFlow[0], at: inFlow[1], over: 0 }, merchant: { v: 'Fernleaf', at: 3 } } } } };
    const read = readSharedFile(JSON.stringify(file));
    assert.ok(read, 'the file is read');
    assert.equal(read.corrections.rules['p0000000000001:out'].category.v, want);
    assert.equal(read.corrections.rules['p0000000000001:out'].merchant.v, 'Fernleaf', 'a field only one copy holds is kept');
  }
});

/* ------------------------------------------------------- the help and the toast say only what will happen */

test('what a correction for the whole merchant reaches: the moves of its direction, the refunds that follow, or money in that keeps its own rule', async () => {
  const { correctionReach } = await import('../js/model/classify.js');
  for (const old of [false, true]) {
    const repo = repoOf();
    const a = device(repo);
    if (old) heldOldRule(a, 'shopping');
    assert.deepEqual(correctionReach(a.state, a.row('CAFE-1109')), { direction: 'out', count: 2, refunds: 1, kept: false }, 'old ' + old);
    assert.deepEqual(correctionReach(a.state, a.row('CAFE-1103')), { direction: 'in', count: 1, refunds: 0, kept: false });
    // a single purchase with its refund: the refund on record is named
    a.read([...ROWS, row('HW-1', -4200, '2026-11-10', 'MOSSWICK HARDWARE 11'), row('HW-R', 4200, '2026-11-12', 'MOSSWICK HARDWARE 11')], NOW);
    assert.deepEqual(correctionReach(a.state, a.row('HW-1')), { direction: 'out', count: 1, refunds: 1, kept: false });
    learnRule(a.state, a.row('HW-R').id, { category: 'gifts' }, { onlyThis: true });
    assert.equal(correctionReach(a.state, a.row('HW-1')).refunds, 0, 'a refund corrected on its own keeps its correction: not counted');
    const result = learnRule(a.state, a.row('CAFE-1109').id, { category: 'groceries' }, {});
    assert.deepEqual([result.changed - result.refunds, result.refunds], [2, 1], 'the moves out and the refunds, counted apart');
    learnRule(a.state, a.row('CAFE-1103').id, { category: 'gifts' }, {});
    assert.deepEqual(correctionReach(a.state, a.row('CAFE-1109')), { direction: 'out', count: 2, refunds: 0, kept: true }, 'money in keeps its own rule');
    const again = learnRule(a.state, a.row('CAFE-1109').id, { category: 'travel' }, {});
    assert.equal(again.refunds, 0, 'no refund follows a money-out edit once money in has its own rule');
    assert.deepEqual([a.row('CAFE-1103').kind, a.row('CAFE-1103').category], ['refund', 'gifts']);
  }
});

test('the new help and toast phrases: money in that keeps its own correction, the refund on record, moves and refunds counted apart, in both word modes', async () => {
  const { say } = await import('../js/model/words.js');
  const { readFile } = await import('node:fs/promises');
  for (const [mode, term, not] of [['chess', /\bmoves?\b/, /\btransactions?\b/], ['finance', /\btransactions?\b/, /\bmoves?\b/]]) {
    const all = say('tx.scope.all.out.kept', mode, { count: 3, merchant: 'Fernleaf' });
    const later = say('tx.scope.later.out.kept', mode, { merchant: 'Fernleaf' });
    for (const text of [all, later]) {
      assert.match(text, /Money in from them keeps its own correction/, mode + ': ' + text);
      assert.doesNotMatch(text, /but for a refund/);
      assert.match(text, term);
      assert.doesNotMatch(text, not);
    }
    const refund = say('tx.scope.later.out.refund', mode, { merchant: 'Fernleaf', refunds: 1 });
    assert.match(refund, /refund/);
    assert.match(refund, /\b1\b/, 'it names the refund on record');
    assert.match(refund, term);
    assert.doesNotMatch(refund, not);
    const moves = say('tx.toast.movesOut.many', mode, { count: 2 });
    const refunds = say('tx.toast.refundCount.many', mode, { count: 4 });
    const toast = say('tx.toast.refunds', mode, { moves, refunds, merchant: 'Fernleaf' });
    assert.equal(toast, mode === 'chess' ? '2 moves out and 4 refunds from Fernleaf corrected.' : '2 transactions out and 4 refunds from Fernleaf corrected.');
    assert.equal(say('tx.toast.movesOut.one', mode, {}), mode === 'chess' ? '1 move out' : '1 transaction out');
    assert.equal(say('tx.toast.refundCount.one', mode, {}), '1 refund');
    for (const direction of ['out', 'in']) {
      const many = say('tx.toast.many.' + direction, mode, { count: 5, merchant: 'Fernleaf' });
      assert.ok(many.includes('5') && many.includes(direction === 'out' ? 'out to' : 'in from'), many);
      assert.match(many, term);
    }
  }
  const sheet = await readFile(new URL('../js/views/sheet-tx.js', import.meta.url), 'utf8');
  assert.match(sheet, /correctionReach\(/);
  assert.match(sheet, /'tx\.toast\.refunds'/);
  assert.doesNotMatch(sheet, /'tx\.toast\.many'/);
});

test('an old rule, then edits for all money in on two devices and both Undos: the paychecks held under the old rule stay income and linked on both', async () => {
  const repo = repoOf();
  const ds = [device(repo), device(repo)].map((d) => heldOldRule(d));
  const [a, b] = ds;
  let at = await settleQuiet(ds, NOW + 100);
  correct(a, 'DEP-2026-11-06', { category: 'eating_out' }, { at: at + 10 }); // the paychecks it would contradict are held
  at = await settleQuiet(ds, at + 20);
  for (const d of ds) assert.equal(earlyLinked(d), 6, 'the edit held the linked paychecks');
  correct(b, 'DEP-2026-09-11', { category: 'income' }, { at: at + 10 });
  at = await settleQuiet(ds, at + 20);
  b.undo(at + 10);
  at = await settleQuiet(ds, at + 20);
  a.undo(at + 10); // takes back the held rows' entries: each is read again without the merchant's learned categories
  at = await settleQuiet(ds, at + 20);
  for (const d of ds) {
    assert.equal(earlyLinked(d), 6, 'the early paychecks are income and linked');
    assert.deepEqual(outcome(d, NOW + HOUR_MS), outcome(a, NOW + HOUR_MS));
  }
});

/* ------------------------------------------ an old rule that gives money in a kind of its own keeps it (3.3) */

test('an old rule filing a payer’s money in as income keeps it: after an edit for all money out, a later purchase and a paycheck in its refund window, the paycheck is income and linked, the payday unchanged, on both devices', async () => {
  const LATE = [...ROWS, row('BUY-1110', -200000, '2026-11-10', PAYER), NEXT];
  const income = (s) => oldRule(s, 'income');
  const repo = repoOf();
  const ds = [device(repo, ROWS, income), device(repo, ROWS, income)];
  const [a] = ds;
  for (const d of ds) seedCorrections(d.state);
  let at = await settleQuiet(ds, NOW + 100);
  assert.deepEqual(deposits(a).map((tx) => tx.kind), Array(10).fill('income'), 'the old rule files every deposit as income');
  const reach = correctionReach(a.state, a.row('BUY-0920'));
  assert.deepEqual([reach.kept, reach.refunds], [true, 0], 'the help says money in keeps its own correction');
  const result = (() => { let r = null; a.change((s) => { r = learnRule(s, s.txs.find((tx) => tx.ext.id === 'BUY-0920').id, { category: 'shopping' }, {}); noteMove(s, s.txs.find((tx) => tx.ext.id === 'BUY-0920').id, at + 10); refresh(s, at + 10); }); return r; })();
  assert.equal(result.refunds, 0, 'no deposit follows the money-out edit');
  at = await settleQuiet(ds, at + 20);
  const control = device(repoOf(), ROWS, income); // the same record with no edit
  for (const d of [...ds, control]) d.read(LATE, LATER);
  await settleQuiet(ds, LATER + 100);
  const want = clock(control.state, LATER + HOUR_MS).nextPayday;
  assert.equal(want, '2026-12-04');
  for (const d of ds) {
    const fresh = d.row('DEP-2026-11-20');
    assert.deepEqual([fresh.kind, fresh.category, fresh.streamId != null], ['income', 'income', true], 'the later paycheck is income and linked');
    assert.equal(clock(d.state, LATER + HOUR_MS).nextPayday, want, 'the payday is unchanged');
    assert.deepEqual([d.row('BUY-0920').category, d.row('BUY-1110').category], ['shopping', 'shopping'], 'money out follows the edit');
    assert.deepEqual(outcome(d, LATER + HOUR_MS), outcome(a, LATER + HOUR_MS));
    assert.equal(incomeTotal(d), incomeTotal(control), 'the income is the same as with no edit');
  }
  // a refund at a retailer with an old spend rule still follows a money-out edit
  const shop = device(repoOf(), ROWS, (s) => s.settings.rules.push({ id: 'learned:old7', mkey: 'fernleaf cafe', category: 'shopping' }));
  assert.equal(shop.row('CAFE-1103').mkey, 'fernleaf cafe');
  assert.equal(correctionReach(shop.state, shop.row('CAFE-1109')).kept, false);
  learnRule(shop.state, shop.row('CAFE-1109').id, { category: 'groceries' }, {});
  assert.deepEqual([shop.row('CAFE-1103').kind, shop.row('CAFE-1103').category], ['refund', 'groceries']);
});

/* ------------------------------------------------------- a refile keeps the rule that filed a row (3.8) */

for (const first of [{ category: 'income' }, { category: 'income', merchant: 'Bramblewood' }]) {
  test('an old rule seeded at 0 on three devices, two edits for all money in on one, then both Undos: every device ends where it started'
    + (first.merchant ? ' (the first edit also renames)' : ''), async () => {
    const repo = repoOf();
    const ds = [device(repo), device(repo), device(repo)].map((d) => heldOldRule(d));
    const [a, , c] = ds;
    let at = await settleQuiet(ds, NOW + 100);
    const was = outcome(a, NOW + HOUR_MS);
    correct(c, 'DEP-2026-09-11', first, { at: at + 10 }); // a paycheck linked under the old rule
    at = await settle(ds, at + 20);
    correct(c, 'DEP-2026-08-28', { category: 'income' }, { at: at + 10 }); // another
    at = await settle(ds, at + 20);
    c.undo(at + 5);
    at = await settle(ds, at + 10);
    c.undo(at + 5);
    at = await settle(ds, at + 10);
    for (const d of ds) d.read(ROWS, NOW + DAY_MS); // a day of readings
    await settleQuiet(ds, at + 10);
    for (const d of ds) {
      assert.deepEqual(outcome(d, NOW + DAY_MS), outcome(c, NOW + DAY_MS), 'every device agrees with the one that made the Undos');
      assert.equal(incomeTotal(d), 6 * 150000, 'the early paychecks are income, and only they');
      assert.equal(earlyLinked(d), 6, 'and linked');
      assert.equal(clock(d.state, NOW + DAY_MS).nextPayday, null);
    }
    assert.deepEqual(outcome(a, NOW + HOUR_MS), was, 'the record reads as it did before the edits');
  });
}

/* ------------------------------------------------------------------ the toast counts real changes */

test('the toast counts only rows that changed: over an old rule whose own row is locked, the move out edited and the refund that followed', () => {
  const a = device(repoOf());
  // the old rule as the previous build's learnRule made it: from CAFE-1102, whose category it locked
  const src = a.row('CAFE-1102');
  a.state.settings.rules.push({ id: 'learned:r0old6', mkey: src.mkey, category: 'shopping' });
  reclassify(a.state, a.state.txs.map((tx) => tx.id));
  src.locks = [...(src.locks || []), 'category'];
  src.ruleId = 'learned:r0old6';
  refresh(a.state, NOW);
  assert.deepEqual([src.category, a.row('CAFE-1103').category, a.row('CAFE-1109').category], ['shopping', 'shopping', 'shopping']);
  const result = learnRule(a.state, a.row('CAFE-1109').id, { category: 'groceries' }, {});
  assert.deepEqual([a.row('CAFE-1102').category, a.row('CAFE-1103').category, a.row('CAFE-1109').category], ['shopping', 'groceries', 'groceries']);
  assert.deepEqual([result.changed - result.refunds, result.refunds], [1, 1], 'one move out and one refund corrected: the locked row is not counted');
});

/* ------------------------------------- a money-out rule that changed how deposits read, taken back (3.8) */

test('a purchase filed as a transfer for all money out lets the payer’s deposits read as income; its Undo puts them back on every device', async () => {
  const repo = repoOf();
  const ds = [device(repo), device(repo), device(repo)];
  const [a, b, c] = ds;
  let at = await settleQuiet(ds, NOW + 100);
  const was = outcome(b, NOW + HOUR_MS);
  assert.equal(deposits(b).filter((tx) => tx.kind === 'refund').length, 4, 'the deposits after the purchase read as its refunds');
  correct(a, 'BUY-0920', { category: 'transfer' }, { at: at + 10 });
  at = await settleQuiet(ds, at + 20);
  for (const d of ds) assert.equal(incomeTotal(d), 10 * 150000, 'with no purchase to mirror, every deposit reads as income');
  a.undo(at + 10);
  at = await settleQuiet(ds, at + 20);
  for (const d of ds) d.read(ROWS, NOW + DAY_MS);
  await settleQuiet(ds, at + 10);
  for (const d of ds) {
    assert.deepEqual(outcome(d, NOW + HOUR_MS), was, 'every device reads the deposits as it did before the edit');
    assert.equal(d.row('BUY-0920').kind, 'spend');
  }
  void c;
});

test('a purchase that posts late, after deposits already linked as income, filed as a transfer for all money out and undone: every device ends where it started, as the previous build does', async () => {
  const repo = repoOf();
  const paid = PAYDAYS.map((day) => row('DEP-' + day, 150000, day, PAYER));
  const late = [...paid, row('BUY-0920', -200000, '2026-09-20', PAYER)];
  const ds = [0, 1, 2].map(() => device(repo, paid, null, NOW - 10 * DAY_MS));
  const [, b] = ds;
  for (const d of ds) seedCorrections(d.state);
  let at = await settleQuiet(ds, NOW - 10 * DAY_MS + 100);
  for (const d of ds) d.read(late, NOW); // the purchase posts late: it would mirror deposits already linked as income
  at = await settleQuiet(ds, NOW + 100);
  const held = ['DEP-2026-09-25', 'DEP-2026-10-09', 'DEP-2026-10-23'];
  const was = outcome(b, NOW + HOUR_MS);
  assert.equal(incomeTotal(b), 9 * 150000, 'nine deposits are income before the edit');
  for (const extId of held) assert.ok(b.row(extId).kind === 'income' && b.row(extId).streamId, extId + ' is income and linked before the edit');
  // what the sheet does on B: the purchase filed as a transfer for all money out
  b.change((s) => {
    const tx = s.txs.find((one) => one.ext && one.ext.id === 'BUY-0920');
    learnRule(s, tx.id, { category: 'transfer' }, {});
    noteMove(s, tx.id, at + 10);
    confirmMove(s, tx.id);
    refresh(s, at + 10);
  });
  at = await settleQuiet(ds, at + 20);
  b.undo(at + 10);
  followIncome(b.state, at + 10);
  at = await settleQuiet(ds, at + 20);
  for (const d of ds) d.read(late, NOW + DAY_MS);
  await settleQuiet(ds, at + DAY_MS);
  for (const d of ds) {
    assert.equal(incomeTotal(d), 9 * 150000, 'every device keeps the 13,500.00 of income it had');
    for (const extId of held) assert.ok(d.row(extId).kind === 'income' && d.row(extId).streamId, extId + ' stays income and linked');
    assert.deepEqual(outcome(d, NOW + HOUR_MS), was, 'every device reads the deposits as it did before the edit');
  }
});

/* --------------------------------------------- what the views say of a stream that holds no deposit (3.8) */

const STREAM_VIEWS = fileURLToPath(new URL('./helpers/render-stream.mjs', import.meta.url));
/** The Book, the stream sheet, Settings and the Board as rendered under node, and the assessment's notes (helpers/render-stream.mjs). */
const views = (kase, words, ...flags) => JSON.parse(execFileSync(process.execPath, [STREAM_VIEWS, kase, words, ...flags], { encoding: 'utf8' }));
const text = (markup) => String(markup || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** The Book's row of the stream paid into the second account, from its name to its typical deposit. */
const bookRow = (page) => { const all = text(page.book); const at = all.indexOf('Quillmere Studios'); return all.slice(at, all.indexOf('≈ $1,820.00', at)).trim(); };
/** The stream sheet's facts, from the typical deposit to the deposits seen. */
const sheetFacts = (page) => { const all = text(page.sheet); return all.slice(all.indexOf('Typical deposit'), all.indexOf('Deposits seen')).trim(); };

test('a paycheck account the owner hid reads as the previous build reads it: its stream is not one that holds no deposit, in the Book and the stream sheet, in both word modes', () => {
  for (const [words, counted] of [['chess', 'Counted as earned day by day, ≈ $130.00 a day'], ['finance', 'Accrued daily, ≈ $130.00 a day']]) {
    const page = views('hidden', words);
    assert.equal(bookRow(page), 'Quillmere Studios Salary · every 2 weeks · last deposit Fri, Nov 13 · Side Checking ' + counted, words + ': the Book row as the previous build shows it');
    assert.equal(sheetFacts(page), 'Typical deposit ≈ $1,820.00 Last deposit Fri, Nov 13 · yesterday Next expected Fri, Nov 27 · in 13 days', words + ': the sheet as the previous build shows it');
    assert.doesNotMatch(text(page.sheet), /Nothing is counted until a deposit is on record/);
  }
});

test('emptiedStreams counts a payer’s deposits on shown accounts only, and leaves a stream on a hidden account alone', () => {
  const PAID = ['2026-07-10', '2026-07-24', '2026-08-07', '2026-08-21', '2026-09-04', '2026-09-18', '2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13'];
  const side = PAID.map((day) => row('QDEP-' + day, 182000, day, 'QUILLMERE STUDIOS'));
  const state = defaultState(NOW - 200 * DAY_MS);
  const account = (extId, name, txs) => ({ extId, connId: 'CON-1', institution: 'Example Bank', name, currency: 'USD', balance: 812345, available: 812345, asOf: NOW - HOUR_MS, txs });
  mergeFeed(state, { src: 'simplefin', fetchedAt: NOW, fromMs: NOW - 200 * DAY_MS, toMs: NOW, errors: [], accounts: [account('ACT-CHK-7', 'Main Checking', []), account('ACT-CHK-9', 'Side Checking', side)] }, NOW);
  refresh(state, NOW);
  const stream = state.streams.find((one) => one.active);
  assert.ok(stream && state.txs.some((tx) => tx.streamId === stream.id), 'detection linked the deposits');
  assert.deepEqual([...emptiedStreams(state)], [], 'a stream that holds its deposits');
  state.accounts.find((one) => one.id === stream.accountId).hidden = true;
  refresh(state, NOW + 1000);
  assert.ok(!state.txs.some((tx) => tx.streamId === stream.id), 'detection lets go of the deposits of a hidden account, as the previous build does');
  assert.deepEqual([...emptiedStreams(state)], [], 'a stream on a hidden account is left alone');
  // its payer's deposits on a hidden account are not on record for another stream of that payer either
  state.streams.push({ ...stream, id: 'str_other01', accountId: state.accounts.find((one) => !one.hidden).id });
  assert.deepEqual([...emptiedStreams(state)], [], 'deposits on a hidden account are not counted');
});

test('no screen calls a stream with no deposit on record regular pay: Settings, the Board and the assessment read it as the ledger does', () => {
  for (const words of ['chess', 'finance']) {
    const emptied = views('emptied', words, 'alone');
    assert.match(text(emptied.settings), /No regular pay has been found in the feed yet/, words + ': Settings finds no regular pay');
    assert.doesNotMatch(text(emptied.settings), /Regular pay found/);
    assert.ok(emptied.notes.includes('no-pay'), words + ': the assessment notes that no regular pay is detected');
    const arrival = views('emptied', words, 'alone', 'arrival');
    assert.doesNotMatch(text(arrival.board), /Quillmere Studios is not (counted day by day|accrued)/, words + ': the Board names no pay counted on arrival');
    assert.match(text(arrival.board), /No regular pay is detected/, words + ': as the ledger reads it');
    assert.ok(arrival.notes.includes('no-pay'), words + ': nor does the assessment');
    // the same stream holding its deposits is regular pay, as before
    const held = views('plain', words, 'alone', 'arrival');
    assert.match(text(held.board), /Quillmere Studios is not (counted day by day|accrued)/, words + ': pay counted on arrival is named');
    assert.ok(!held.notes.includes('no-pay'));
    assert.match(text(views('plain', words, 'alone').settings), /Regular pay found: Quillmere Studios/);
  }
});

test('nor do the Balance sheet, Analysis or the Book’s counting passage: a stream with no deposit on record is no pay counted on arrival', () => {
  const ARRIVES = /Pay is counted when it arrives|Pay is on a cash basis|counted when it arrives, so nothing accrues/;
  const BY_HAND = /switched off by hand on 1 stream/;
  for (const words of ['chess', 'finance']) {
    for (const flags of [['alone'], ['alone', 'arrival']]) {
      const emptied = views('emptied', words, ...flags);
      const label = words + ' ' + flags.join('+') + ': ';
      for (const page of ['material', 'analysis', 'book']) {
        assert.doesNotMatch(emptied[page], /^ERROR/, label + page + ' renders');
        assert.doesNotMatch(text(emptied[page]), ARRIVES, label + page + ' reads no pay counted on arrival');
        assert.doesNotMatch(text(emptied[page]), BY_HAND, label + page + ' names no stream switched off by hand');
      }
    }
    // the same stream holding its deposits, set to count on arrival, is still named so
    const held = views('plain', words, 'alone', 'arrival');
    assert.match(text(held.material) + text(held.analysis), ARRIVES, words + ': pay counted on arrival is still named');
    assert.match(text(held.book), BY_HAND, words + ': the Book still names the stream switched off by hand');
  }
});

test('the stream sheet of a stream that holds no deposit says, under the daily-accrual switch, that nothing is counted until a deposit is on record; the same in both word modes', () => {
  for (const words of ['chess', 'finance']) {
    const sheet = text(views('emptied', words).sheet);
    assert.match(sheet, /For regular pay, such as a salary\. Nothing is counted until a deposit is on record\. On\./, words + ': the line, under the switch');
    assert.doesNotMatch(text(views('plain', words).sheet), /Nothing is counted until a deposit is on record/, words + ': not for a stream that holds its deposits');
  }
});
