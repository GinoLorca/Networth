/**
 * Income reported by another app (ARCHITECTURE 3.7), the sixth round: accrual follows the claimed rows at once,
 * Material's record chart, prepaid sessions marked late, a count's time, the shared file above 1 MB, and the smaller
 * words. Every payer, amount, label and account here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INCOME_FORMAT, answerItems, answerPayer, applyIncomeReading, cashAccountOf, countCash, incomeMoveId, incomeOf, liveCounts,
  mergeIncomeShared, rebuildIncome, roundIncome,
} from '../js/model/income.js';
import { followIncome, refresh } from '../js/model/detect.js';
import { defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { makeLedger } from '../js/model/ledger.js';
import { roundShared } from '../js/model/share.js';
import { addDays, fmtDate, gameDay } from '../js/model/dates.js';
import { ShareError, readSharedText, toBase64, writeSharedText } from '../js/github.js';
import { cashLineWords, payerNames, payerWords, recordEstimate, recordLead } from '../js/views/income-words.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MIN_MS = 60000;
const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const TODAY = gameDay(NOW, 4);
const iso = (ms) => new Date(ms).toISOString();
const PAYERS = [{ id: 'p-avery', name: 'Avery' }, { id: 'p-rowan', name: 'Rowan' }];

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

/* ------------------------------------------------ 1. accrual follows the claimed rows */

/** Twelve weekly Zelle deposits of $150.00 from one payer: detection makes the stream accrue. */
function weeklyPayer() {
  const s = defaultState(NOW - 120 * DAY_MS);
  s.meta.origin = 'bank';
  s.sync.lastOk = NOW;
  s.sync.from = addDays(TODAY, -200);
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'x1', conn: 'c1' } }));
  const items = [];
  for (let w = 12; w >= 1; w--) {
    const day = addDays(TODAY, -7 * w + 1);
    s.txs.push(makeTx({ id: 'z' + w, source: 'bank', accountId: 'acc_chk', day, postedDay: day, amount: 15000, flow: 'in', raw: 'ZELLE FROM AVERY EXAMPLE', merchant: 'Avery Example', mkey: 'zelle from avery example', fp: 'acc_chk|' + day + '|15000|z' + w }));
    items.push({ id: 'i' + w, payer: 'p-avery', cents: 15000, day, at: new Date(Date.parse(day + 'T12:00:00')).toISOString() });
  }
  refresh(s, NOW);
  return { s, items };
}
const streamOf = (s) => s.streams.find((x) => x && /avery/i.test(x.name || ''));

/** The device the reader uses in the app: every change goes through store.update, and so through its update hook. */
function appDevice(s, at) {
  return { state: () => s, stale: () => false, access: () => true, update: (change) => { change(s); followIncome(s, at); } };
}
function folder(text, sha) {
  return { list: async () => [{ name: 'work.json', sha, size: text.length }], read: async () => text };
}

test('1: the file arrives through roundIncome with no refresh: the stream stops accruing in the same update, and live counts the money once', async () => {
  const { s, items } = weeklyPayer();
  assert.equal(streamOf(s).accrue, true, 'a regular payer of $150.00 a week accrues');
  const before = live(s, NOW);
  assert.ok(before > 500000);
  items.push({ id: 'i0', payer: 'p-avery', cents: 15000, day: TODAY, at: iso(NOW - HOUR_MS) });
  const text = JSON.stringify({ format: INCOME_FORMAT, what: 'Session', writtenAt: iso(NOW), payers: PAYERS, items });
  await roundIncome(appDevice(s, NOW), folder(text, 'a'.repeat(40)), NOW);
  assert.equal(Object.keys(s.income.pairs).length, 12, 'every deposit is claimed');
  assert.equal(streamOf(s).accrue, false, 'right after the reading');
  assert.equal(live(s, NOW), 515000, 'the balance and today\'s $150.00 in pencil, with no accrual');
  // the reverse: the file no longer lists the payments, so no row is claimed and the accrual comes back
  const empty = JSON.stringify({ format: INCOME_FORMAT, what: 'Session', writtenAt: iso(NOW), payers: PAYERS, items: [] });
  await roundIncome(appDevice(s, NOW), folder(empty, 'b'.repeat(40)), NOW);
  assert.deepEqual(s.income.pairs, {});
  assert.equal(streamOf(s).accrue, true, 'rows no longer claimed let accrual come back');
  assert.equal(live(s, NOW), before);
});

test('1: the update hook decides the streams again only when the claimed rows changed', () => {
  const { s, items } = weeklyPayer();
  read(s, items);
  assert.equal(streamOf(s).accrue, true, 'a reading alone, with no hook, decides nothing');
  followIncome(s, NOW);
  assert.equal(streamOf(s).accrue, false, 'the hook sees that the claimed rows changed');
  assert.equal(Object.hasOwn(s.income, 'restream'), false, 'and the decision is made once');
  // the owner turns accrual on: a hook with nothing claimed anew (an answer elsewhere, a new game day) leaves it
  streamOf(s).accrue = true;
  followIncome(s, NOW);
  followIncome(s, NOW + DAY_MS);
  assert.equal(streamOf(s).accrue, true, 'no change in the claimed rows, no new decision');
});

test('1: an answer that releases the claimed rows lets accrual come back in the same update', () => {
  const { s, items } = weeklyPayer();
  // every payment counts (none is history), so a cash answer of its own takes it out of the matching
  s.income = { sources: {}, firstReadAt: null, shared: { since: NOW - 120 * DAY_MS, payers: {}, items: {}, counts: [] } };
  const dev = appDevice(s, NOW);
  dev.update((st) => { read(st, items); });
  assert.equal(Object.keys(s.income.pairs).length, 12);
  assert.equal(streamOf(s).accrue, false);
  dev.update((st) => { answerItems(st, 'work', items.map((it) => it.id), 'cash', NOW); });
  assert.deepEqual(s.income.pairs, {});
  assert.equal(streamOf(s).accrue, true, 'the answer passes through the same hook');
});

/* ----------------------------------------------------------- 2. Material's record chart */

test('2: one payment in pencil and nothing else estimated: the record chart is an estimate, and its caption names the pencil part', () => {
  const s = longState();
  read(s, [item('i1', 'p-avery', 7000, NOW - HOUR_MS)]);
  const pos = makeLedger(s, NOW).position();
  assert.equal(pos.smoothing, false);
  assert.equal(pos.provisional, 0);
  assert.equal(pos.provisionalIn, 7000);
  const m = { estAssets: false, estDebts: false, smoothing: pos.smoothing, provisional: pos.provisional, provisionalIn: pos.provisionalIn };
  assert.equal(recordEstimate(m), true, 'the Board says ≈ for the same figure; Material does too');
  assert.equal(recordEstimate({ ...m, provisionalIn: 0 }), false, 'a record of bank rows alone stays roman');
  assert.match(recordLead(m), /^Net worth at the bank, day by day\. .*pencil.*not yet at the bank/);
  assert.equal(recordLead({ ...m, provisionalIn: 0 }), 'Net worth at the bank, day by day.');
});

test('2: Material\'s record() and the Board\'s chart decide the estimate alike, and draw the pencil part', async () => {
  const { readFile } = await import('node:fs/promises');
  const material = await readFile(new URL('../js/views/material.js', import.meta.url), 'utf8');
  const rec = material.slice(material.indexOf('function record('), material.indexOf('/* ------------------------------------------------------------------ render */'));
  assert.match(rec, /est: recordEstimate\(/);
  assert.match(rec, /recordLead\(/);
  assert.match(rec, /provisionalIn > 0/, 'the pencil part is drawn (live passed) while payments are in pencil');
  const { chartSummary, chartSvg } = await import('../js/ui/charts.js');
  const days = [];
  for (let k = 5; k >= 0; k--) days.push({ day: addDays(TODAY, -k), smooth: 500000, bank: 500000 });
  const data = { days, events: [], live: 507000, est: true };
  assert.match(chartSvg('worth', data, 1200, 220), /<text class="nwc-f nwc-money nwc-est"[^>]*><tspan class="nwc-approx">≈<\/tspan> \$5,070\.00</, 'the end label is ≈, in italic');
  assert.match(chartSummary('worth', data), /now about \$5,070\.00/, 'the summary says "about"');
});

/* ------------------------------------------------------ 3. prepaid sessions marked late */

test('3: a session 7 days ahead, marked 6 days after its deposit, is matched', () => {
  const T0 = new Date(2026, 10, 2, 15, 0).getTime();
  const s = longState(T0);
  const deposit = gameDay(T0, 4);
  addRow(s, 'R', 7000, deposit, T0);
  const marked = T0 + 6 * DAY_MS;
  read(s, [item('p0', 'p-avery', 7000, marked, addDays(deposit, 7))], marked);
  assert.equal(moveOf(s, 'p0').matchId, 'R');
  for (const late of [2, 3, 4, 9]) {
    const t = longState(T0);
    addRow(t, 'R', 7000, deposit, T0);
    read(t, [item('p0', 'p-avery', 7000, T0 + late * DAY_MS, addDays(deposit, 7))], T0 + late * DAY_MS);
    // marked 9 days after the deposit, the session (7 days after it) is past: a past session's bound, its day - 3
    assert.equal(moveOf(t, 'p0').matchId, late === 9 ? null : 'R', 'marked ' + late + ' days after the deposit');
  }
  // as far back as a payment for a past session, and no further
  const u = longState(T0);
  addRow(u, 'R', 7000, deposit, T0);
  read(u, [item('p0', 'p-avery', 7000, T0 + 11 * DAY_MS, addDays(deposit, 14))], T0 + 11 * DAY_MS);
  assert.equal(moveOf(u, 'p0').matchId, null, 'marked 11 days after the deposit');
});

/* ------------------------------------------------------------ 4. a count's time is the real time */

test('4: S2: the count keeps the real time, the latest on the day is the one edited last, and a cash payment after it counts', () => {
  const A = longState();
  const B = longState();
  for (const s of [A, B]) answerPayer(s, 'work', 'p-rowan', 'cash', NOW - 3 * HOUR_MS);
  countCash(A, 10000, NOW + 7 * MIN_MS); // A runs 7 minutes fast
  B.income.shared = mergeIncomeShared(incomeOf(B).shared, incomeOf(A).shared);
  rebuildIncome(B, NOW + MIN_MS);
  countCash(B, 8000, NOW + MIN_MS);
  const mine = liveCounts(incomeOf(B).shared).find((c) => c.cents === 8000);
  assert.equal(mine.at, NOW + MIN_MS, 'at is the real time');
  assert.equal(mine.editedAt, NOW + 7 * MIN_MS + 1, 'editedAt is above every count the device knows');
  for (const s of [A, B]) read(s, [item('r1', 'p-rowan', 3000, NOW + 3 * MIN_MS)], NOW + 10 * MIN_MS);
  A.income.shared = mergeIncomeShared(incomeOf(A).shared, incomeOf(B).shared);
  rebuildIncome(A, NOW + 10 * MIN_MS);
  for (const s of [A, B]) {
    assert.equal(cashOf(s), 11000, 'the $80.00 count and the $30.00 marked after it');
    assert.equal(live(s, NOW + 10 * MIN_MS) - 500000, 11000);
  }
});

test('4: S3: a count from a device a day fast stays on its own day; the owner\'s count shows today', () => {
  const A = longState();
  const B = longState();
  countCash(A, 10000, NOW + DAY_MS);
  B.income.shared = mergeIncomeShared(incomeOf(B).shared, incomeOf(A).shared);
  countCash(B, 8000, NOW);
  const mine = liveCounts(incomeOf(B).shared).find((c) => c.cents === 8000);
  assert.equal(gameDay(mine.at, 4), TODAY, 'no count moves to another game day');
  rebuildIncome(B, NOW + MIN_MS);
  assert.equal(cashOf(B), 8000);
});

test('4: S4: a count from a device a few minutes fast across the rollover hour does not hide the owner\'s count', () => {
  const D = new Date(2026, 10, 14, 3, 57).getTime(); // before the 4:00 rollover: still Nov 13's game day
  const A = longState(D - DAY_MS);
  const B = longState(D - DAY_MS);
  countCash(A, 2000, D - 2 * HOUR_MS);
  countCash(A, 10000, D + 6 * MIN_MS); // A runs 6 minutes fast: 4:03, the next game day
  B.income.shared = mergeIncomeShared(incomeOf(B).shared, incomeOf(A).shared);
  countCash(B, 5000, D + MIN_MS); // 3:58
  const mine = liveCounts(incomeOf(B).shared).find((c) => c.cents === 5000);
  assert.equal(mine.at, D + MIN_MS);
  rebuildIncome(B, D + 2 * MIN_MS);
  assert.equal(cashOf(B), 5000, 'B\'s count shows at once');
});

/* ------------------------------------------------------------------ 5. the shared file above 1 MB */

const OWNER = 'someone';
const KEY = 'k'.repeat(40);
const SHA_FILE = 'f'.repeat(40);
const CONTENTS = 'https://api.github.com/repos/' + OWNER + '/networth-data/contents/networth-shared.json';
const BLOB = 'https://api.github.com/repos/' + OWNER + '/networth-data/git/blobs/' + SHA_FILE;

/** GitHub with a shared file over 1 MB: the Contents API gives its sha and no content; the blob API gives the content. */
function largeFile(text, blob) {
  const calls = [];
  const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    if (url === CONTENTS && init.method === 'GET') return answer(200, { type: 'file', encoding: 'none', content: '', sha: SHA_FILE, size: 1500000 });
    if (url === CONTENTS && init.method === 'PUT') return answer(200, { content: { sha: '1'.repeat(40) } });
    if (url === BLOB && init.method === 'GET') {
      if (blob === 'fail') return answer(503, { message: 'Service unavailable' });
      if (blob === 'odd') return answer(200, { sha: SHA_FILE, encoding: 'utf-8', content: 'not base64' });
      return answer(200, { sha: SHA_FILE, size: 1500000, encoding: 'base64', content: toBase64(text).replace(/(.{60})/g, '$1\n') });
    }
    return answer(404, { message: 'Not Found' });
  };
  return { fetch, calls };
}

test('5: a shared file over 1 MB is read by its sha from the blob API', async () => {
  const text = JSON.stringify({ v: 1, app: 'networth', byHand: {} });
  const gh = largeFile(text, 'ok');
  assert.deepEqual(await readSharedText(OWNER, KEY, gh.fetch), { text, sha: SHA_FILE });
  assert.deepEqual(gh.calls.map((c) => c.url), [CONTENTS, BLOB]);
});

test('5: a shared file over 1 MB that cannot be read is never written over: the round stops with a clear problem', async () => {
  for (const blob of ['fail', 'odd']) {
    const gh = largeFile('', blob);
    const state = longState();
    const device = { state: () => state, update: (change) => change(state), stale: () => false };
    const transport = {
      read: () => readSharedText(OWNER, KEY, gh.fetch),
      write: (text, sha) => writeSharedText(OWNER, KEY, text, sha, gh.fetch),
    };
    let caught = null;
    try { await roundShared(device, transport, () => NOW); } catch (err) { caught = err; }
    assert.ok(caught instanceof ShareError, blob);
    assert.equal(caught.code, blob === 'fail' ? 'server' : 'large');
    if (blob === 'odd') assert.match(caught.message, /larger than 1 MB/);
    assert.equal(gh.calls.filter((c) => c.method === 'PUT').length, 0, 'nothing is written over it');
  }
});

/* ---------------------------------------------------------------------- 6. smaller items */

test('6: two payers with the same name in two sources are told apart by their source', () => {
  const names = payerNames([
    { payerKey: 'work/p-avery', payerName: 'Avery', sourceLabel: 'Session' },
    { payerKey: 'group/g-avery', payerName: 'Avery', sourceLabel: 'Group class' },
    { payerKey: 'work/p-rowan', payerName: 'Rowan', sourceLabel: 'Session' },
  ]);
  assert.equal(names.get('work/p-avery'), 'Avery · Session');
  assert.equal(names.get('group/g-avery'), 'Avery · Group class');
  assert.equal(names.get('work/p-rowan'), 'Rowan');
});

test('6: the payer switch\'s toast in Settings ends at the answer; on the Board it still says where to change it', () => {
  const asks = { cents: 4500, day: TODAY };
  const here = payerWords('Avery · Group class', 'cash', null, asks, false, 1, 'settings');
  assert.equal(here, 'Avery · Group class pays in cash: it counts in Cash in hand. Networth asks about the $45.00 of ' + fmtDate(TODAY, 'short') + ' on the board.');
  assert.match(payerWords('Avery', 'cash', null, null, false, 1), /Change it in Settings\.$/);
});

test('6: Material\'s line about Cash in hand says what it is', () => {
  const s = longState();
  answerPayer(s, 'work', 'p-rowan', 'cash', NOW - 3 * HOUR_MS);
  read(s, [item('r1', 'p-rowan', 2500, NOW - 2 * HOUR_MS)]);
  assert.equal(cashLineWords(s), 'Cash in hand: from payments marked as cash.');
  countCash(s, 10000, NOW - HOUR_MS);
  read(s, [item('r1', 'p-rowan', 2500, NOW - 2 * HOUR_MS), item('r2', 'p-rowan', 2500, NOW - 59 * MIN_MS)], NOW, 'sha2');
  assert.equal(cashLineWords(s), 'Cash in hand: your count of $100.00 and payments marked as cash since.');
  assert.equal(cashLineWords(longState()), '');
});

test('6: the views: the record chart says "Counted", "at the bank" names one thing, Show all names its list, Settings names each payer', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = async (path) => readFile(new URL('../js/' + path, import.meta.url), 'utf8');
  const material = await src('views/material.js');
  assert.match(material, /'Counted'/);
  assert.match(material, /' a figure you ' \+ what/);
  assert.match(material, /counted \? 'counted' : 'revalued'/, 'the caption says "a figure you counted"');
  assert.match(material, /cashLineWords\(/);
  assert.match(material, /At the bank and in hand/, 'Material\'s sum holds Cash in hand and says so');
  const board = await src('views/board.js');
  assert.match(board, /'counted'/);
  const settings = await src('views/settings.js');
  assert.match(settings, /aria-label="Show all \$\{gone\} in-the-bank payments of \$\{/);
  assert.match(settings, /listedPayers\(/);
  assert.match(board, /listedPayers\(ctx\.state\)\.names\.get\(/, 'the Board\'s payer toast names the payer as Settings does');
  assert.match(settings, /payerWords\([^;]*'settings'\)/);
});

test('round 7: the record says "at the bank and in hand" while Cash in hand is part of the line', async () => {
  const { bankWhere } = await import('../js/views/income-words.js');
  const m = { provisional: 0, provisionalIn: 6400, handCash: true };
  assert.equal(recordLead(m), 'Net worth at the bank and in hand, day by day. The last step, in pencil, counts the moves not yet at the bank; dotted: at the bank and in hand.');
  assert.equal(recordLead({ ...m, provisionalIn: 0 }), 'Net worth at the bank and in hand, day by day.');
  assert.equal(recordLead({ ...m, handCash: false, provisionalIn: 0 }), 'Net worth at the bank, day by day.');
  assert.equal(bankWhere(true), 'at the bank and in hand');
  assert.equal(bankWhere(false), 'at the bank');
  const { readFileSync } = await import('node:fs');
  const board = readFileSync(new URL('../js/views/board.js', import.meta.url), 'utf8');
  const material = readFileSync(new URL('../js/views/material.js', import.meta.url), 'utf8');
  assert.match(board, /Dotted: \$\{bankWhere\(!!handAccount\(ctx\)\)\}/, 'the Board\'s smoothed caption');
  assert.match(board, /Net worth \$\{bankWhere\(!!handAccount\(ctx\)\)\}, the last/, 'the Board\'s plain caption');
  assert.match(material, /Dotted: ' \+ bankWhere\(m\.handCash\)/, 'Material\'s smoothed caption');
});
