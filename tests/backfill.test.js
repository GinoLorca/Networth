import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_WINDOW_DAYS, HISTORY, QUOTA, backfillOf, fetchSimplefin, historyAllowed, historyRequests, historyStep, isFirstReading, lacksHistory,
  quotaAllows, recordHistory, syncWindows,
} from '../js/model/feed.js';
import { mergeFeed } from '../js/model/merge.js';
import { refresh } from '../js/model/detect.js';
import { recentTransactions } from '../js/model/recent.js';
import { checkDoc, defaultState, migrate } from '../js/model/schema.js';
import { coverText } from '../js/views/parts.js';

/*
 * Whole readings, played against a provider that answers from its own table of rows and returns only what
 * falls inside the window asked for. Everything here is invented: no real account, merchant charge or person.
 */

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const NOW = new Date(2026, 10, 11, 15, 30).getTime();
const TODAY = '2026-11-11';
const ACCESS = { base: 'https://beta-bridge.simplefin.org/simplefin', auth: 'Basic ' + btoa('inventeduser:inventedsecret') };

/** Midnight UTC, `daysAgo` days before the day of NOW: a date-only bank timestamp (epoch seconds). */
function dayAgo(daysAgo) {
  return Date.UTC(2026, 10, 11) / 1000 - daysAgo * 86400;
}

/** One row every `every` days, from `fromDaysAgo` back to `toDaysAgo`. */
function rowsEvery(prefix, every, fromDaysAgo, toDaysAgo, amount, description) {
  const rows = [];
  for (let d = fromDaysAgo; d <= toDaysAgo; d += every) {
    rows.push({ id: prefix + '-' + d, posted: dayAgo(d), amount, description: description + ' ' + d });
  }
  return rows;
}

/**
 * A provider that behaves as the real one was measured to. `accounts`: [{ id, name, conn, balance, rows,
 * listedFrom?, rowsFrom?, limitedRowsFrom? }] — an account is listed from `listedFrom` (ms), its rows are handed out
 * from `rowsFrom` (ms), and to a request limited to accounts only from `limitedRowsFrom` (ms); before that its
 * transactions list is empty. It honours start-date (inclusive), end-date (exclusive) and account= (repeatable; an
 * id it does not know answers no accounts and no error), answers a range longer than 45 days in full with the
 * gen.api notice in errlist, and logs every request.
 */
const NOTICE = { code: 'gen.api', msg: 'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.' };
function makeProvider(accounts, opts = {}) {
  const provider = {
    now: NOW,
    log: [],
    errlist: opts.errlist || [],
    failLimited: opts.failLimited || 0,
    failEarlier: opts.failEarlier || 0,
    fetch: async (href) => {
      const url = new URL(href);
      const start = Number(url.searchParams.get('start-date'));
      const end = Number(url.searchParams.get('end-date'));
      const only = url.searchParams.getAll('account');
      const noticed = end - start > 45 * 86400;
      provider.log.push({ at: provider.now, start, end, only, seconds: end - start, days: Math.round((end - start) / 86400), noticed });
      const earlier = end < provider.now / 1000 - 80 * 86400;
      if (only.length && (provider.failLimited || (provider.failEarlier && earlier))) return { status: provider.failLimited || provider.failEarlier, text: async () => '' };
      const listed = accounts.filter((a) => provider.now >= (a.listedFrom || 0) && (!only.length || only.includes(a.id)));
      const hands = (a) => provider.now >= (a.rowsFrom || 0) && (!only.length || provider.now >= (a.limitedRowsFrom || 0));
      const json = {
        errlist: [...provider.errlist, ...(noticed ? [NOTICE] : [])],
        connections: [...new Set(listed.map((a) => a.conn))].map((conn) => ({ conn_id: conn, name: conn === 'CON-BANK' ? 'Example Bank' : 'Sample Card Co' })),
        accounts: listed.map((a) => ({
          id: a.id, name: a.name, conn_id: a.conn, currency: 'USD', balance: a.balance, 'balance-date': Math.floor(provider.now / 1000) - 3600,
          transactions: hands(a)
            ? a.rows.filter((r) => (r.posted || r.transacted_at) >= start && (r.posted || r.transacted_at) < end).map((r) => ({ ...r, amount: r.amount }))
            : [],
        })),
      };
      return { status: 200, text: async () => JSON.stringify(json) };
    },
  };
  return provider;
}

/** One reading, exactly as js/sync.js runs it: the ordinary windows, then the history requests, then detection. */
async function reading(state, provider, now) {
  provider.now = now;
  const request = async (window) => {
    state.sync.requests = state.sync.requests.filter((t) => now - t < DAY_MS);
    state.sync.requests.push(now);
    const feed = await fetchSimplefin(ACCESS, window, provider.fetch, now);
    feed.reading = now;
    mergeFeed(state, feed, now);
    return feed;
  };
  const first = isFirstReading(state);
  for (const w of syncWindows(state, now)) await request({ fromMs: w.fromMs, toMs: w.toMs, pending: true });
  let historyFailed = false;
  const ask = async (step) => {
    if (!historyAllowed(state, now)) return 'stop';
    let feed = null;
    try {
      feed = await request(step);
    } catch {
      historyFailed = true;
      recordHistory(state, step, now, null);
      return 'stop';
    }
    const book = recordHistory(state, step, now, feed);
    return book && book.had ? 'had' : 'again';
  };
  for (const begun of historyRequests(state, now, first)) {
    let step = begun;
    let outcome = 'had';
    while (step && outcome === 'had') {
      outcome = await ask(step);
      const account = outcome === 'had' ? state.accounts.find((a) => a.id === step.accountId) : null;
      step = account ? historyStep(state, account, now) : null;
    }
    if (outcome === 'stop') break;
  }
  refresh(state, now);
  state.sync.status = 'ok';
  state.sync.error = null;
  state.sync.completed = true;
  return { historyFailed };
}

/** A feed as fetchSimplefin returns it, not limited to accounts, asked for the last 30 days. accounts: [{ id, name, conn?, rows }]. */
function plainFeed(accounts, at) {
  return {
    src: 'simplefin', fetchedAt: at, fromMs: at - 30 * DAY_MS, toMs: at, errors: [],
    accounts: accounts.map((a) => ({
      extId: a.id, connId: a.conn || 'CON-CARD', institution: 'Sample Card Co', name: a.name, currency: 'USD', balance: -100, available: null, asOf: at,
      txs: a.rows.map((r) => ({ payee: '', memo: '', mcc: null, ...r })),
    })),
  };
}

function byExt(state, extId) {
  return state.accounts.find((a) => a.ext && a.ext.id === extId);
}

function rowsOf(state, extId) {
  const account = byExt(state, extId);
  return account ? state.txs.filter((t) => t.accountId === account.id) : [];
}

const CHECKING = () => ({ id: 'ACT-CHK', name: 'Everyday Checking', conn: 'CON-BANK', balance: '2140.55', rows: rowsEvery('K', 5, 1, 171, '-18.40', 'CORNER GROCER') });
const CARD_ROWS = () => rowsEvery('C', 3, 2, 170, '-12.25', 'SAMPLE CAFE');

/* --------------------------------------------------------------- played cases */

const OPEN = { need: true, step: 0, done: false, gaveUp: false, tries: 0, at: null };
const DONE = (at, more) => ({ need: true, step: 4, done: true, gaveUp: false, tries: 0, at, ...more });
const CARD = (more) => ({ id: 'ACT-CARD', name: 'Rewards Card', conn: 'CON-CARD', balance: '-412.30', rows: CARD_ROWS(), ...more });
/** A checking account that has been quiet for a week: an ordinary window then reaches back 13 days or more. */
const QUIET = () => ({ id: 'ACT-CHK', name: 'Everyday Checking', conn: 'CON-BANK', balance: '2140.55', rows: rowsEvery('K', 5, 6, 171, '-18.40', 'CORNER GROCER') });
const reachableAt = (rows, at) => rows.filter((r) => r.posted >= Math.floor((at - 176 * DAY_MS) / 1000));
const limited = (provider) => provider.log.filter((r) => r.only.length);
const noRowTwice = (rows) => assert.equal(new Set(rows.map((t) => t.ext.id)).size, rows.length, 'no row twice');
const WINDOW_SECONDS = FEED_WINDOW_DAYS * 86400;

test('no request is ever longer than 44 days, and the provider never sends its notice: a first reading, a week of readings, a return after 100 days, a card added later', async () => {
  assert.equal(FEED_WINDOW_DAYS, 44);
  const everyDay = { id: 'ACT-CHK', name: 'Everyday Checking', conn: 'CON-BANK', balance: '2140.55', rows: rowsEvery('K', 1, -130, 171, '-18.40', 'CORNER GROCER') };
  const provider = makeProvider([everyDay, CARD({ listedFrom: NOW + 108 * DAY_MS, rows: rowsEvery('C', 3, -108, 60, '-12.25', 'SAMPLE CAFE') })]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW + 0.5); // a time that is not a whole second
  assert.deepEqual(provider.log.map((r) => r.seconds), [WINDOW_SECONDS, WINDOW_SECONDS, WINDOW_SECONDS, WINDOW_SECONDS], 'a first reading: four windows of 44 days');
  for (let i = 1; i < 4; i++) assert.equal(provider.log[i].start, provider.log[i - 1].end, 'consecutive, oldest first');
  for (let h = 3; h <= 7 * 24; h += 3) {
    const before = provider.log.length;
    await reading(state, provider, NOW + h * HOUR_MS + 250);
    assert.equal(provider.log.length, before + 1, 'an ordinary reading is one request');
  }
  let before = provider.log.length;
  await reading(state, provider, NOW + 107 * DAY_MS); // back after 100 days away
  const back = provider.log.slice(before);
  assert.equal(back.length, 3, '107 days: three windows');
  assert.equal(back[0].start <= Math.floor((NOW + 0 * DAY_MS) / 1000), true, 'it starts a week before the newest row on the record');
  for (let i = 1; i < back.length; i++) assert.equal(back[i].start, back[i - 1].end);
  const daysHeld = new Set(rowsOf(state, 'ACT-CHK').map((t) => t.day));
  assert.equal(rowsOf(state, 'ACT-CHK').length, daysHeld.size, 'one row a day, none twice');
  assert.equal(rowsOf(state, 'ACT-CHK').length >= 171 + 106, true, 'nothing of the time away is missing');
  before = provider.log.length;
  await reading(state, provider, NOW + 109 * DAY_MS); // the card has appeared
  assert.deepEqual(provider.log.slice(before).map((r) => [r.only.join(), r.only.length ? r.seconds : r.seconds < 15 * 86400]),
    [['', true], ['ACT-CARD', WINDOW_SECONDS], ['ACT-CARD', WINDOW_SECONDS], ['ACT-CARD', WINDOW_SECONDS], ['ACT-CARD', WINDOW_SECONDS]]);
  assert.deepEqual(byExt(state, 'ACT-CARD').backfill, DONE(NOW + 109 * DAY_MS));
  assert.equal(provider.log.length > 60, true);
  for (const r of provider.log) {
    assert.equal(r.seconds <= WINDOW_SECONDS, true, 'a request of ' + r.seconds + ' seconds');
    assert.equal(r.noticed, false);
  }
  assert.deepEqual(state.sync.problems, []);
  assert.equal(checkDoc(state), null);
});

test('the provider of these tests answers as the real one was measured to', async () => {
  const provider = makeProvider([CHECKING()]);
  const ask = async (query) => JSON.parse(await (await provider.fetch('https://provider.example/accounts?version=2&' + query)).text());
  const end = Math.floor(NOW / 1000);
  assert.deepEqual((await ask('start-date=' + (end - 45 * 86400) + '&end-date=' + end)).errlist, [], 'exactly 45 days: no notice');
  const long = await ask('start-date=' + (end - 45 * 86400 - 1) + '&end-date=' + end);
  assert.deepEqual(long.errlist, [NOTICE], '45 days and a second: the notice');
  assert.equal(long.accounts.length, 1, 'and it is answered in full');
  const unknown = await ask('start-date=' + (end - 86400) + '&end-date=' + end + '&account=ACT-NOBODY');
  assert.deepEqual([unknown.accounts, unknown.errlist], [[], []], 'an id it does not know: no accounts, no error');
  assert.equal((await ask('start-date=' + (end - 86400) + '&end-date=' + end + '&account=ACT-NOBODY&account=ACT-CHK')).accounts.length, 1);
});

test('the first reading carries the card with a balance and no rows: nothing is asked then, and the next reading gets all of it', async () => {
  const provider = makeProvider([CHECKING(), CARD({ rowsFrom: NOW + 2 * HOUR_MS })]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  const card = byExt(state, 'ACT-CARD');
  assert.equal(card.balance, -41230);
  assert.equal(rowsOf(state, 'ACT-CARD').length, 0);
  assert.deepEqual(card.backfill, OPEN, 'the need is kept on the account');
  assert.equal(byExt(state, 'ACT-CHK').backfill, null, 'an account that arrives with rows on a first reading has nothing to do');
  assert.deepEqual(provider.log.map((r) => r.only.join()), ['', '', '', ''], 'the four windows have just asked for everything');
  assert.equal(rowsOf(state, 'ACT-CHK').length, CHECKING().rows.length, 'every row of the 176 days');
  assert.equal(lacksHistory(card), true);

  const t1 = NOW + 4 * HOUR_MS;
  await reading(state, provider, t1);
  const got = rowsOf(state, 'ACT-CARD');
  assert.equal(got.length, reachableAt(CARD_ROWS(), t1).length);
  noRowTwice(got);
  assert.deepEqual(card.backfill, DONE(t1));
  assert.deepEqual(limited(provider).map((r) => [r.only.join(), r.seconds, r.end]), [0, 1, 2, 3].map((k) => ['ACT-CARD', WINDOW_SECONDS, Math.ceil(t1 / 1000) - k * WINDOW_SECONDS]),
    'four steps, newest first, each the 44 days that end k times 44 days before now');
  assert.equal(card.feed.rows, got.length, 'the reading carried every row of the card once');
  assert.equal(lacksHistory(card), false);
  assert.equal(checkDoc(state), null);

  await reading(state, provider, t1 + 13 * HOUR_MS);
  assert.equal(limited(provider).length, 4, 'nothing more is asked for this account');
});

test('an empty answer is an answer: a card nobody used for two months has two empty windows before its rows', async () => {
  const idle = CARD({ listedFrom: NOW + HOUR_MS, rows: rowsEvery('C', 3, 95, 170, '-12.25', 'SAMPLE CAFE') });
  const provider = makeProvider([CHECKING(), idle]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  const t = NOW + 3 * HOUR_MS;
  await reading(state, provider, t);
  const card = byExt(state, 'ACT-CARD');
  assert.deepEqual(card.backfill, DONE(t));
  assert.equal(limited(provider).length, 4);
  assert.equal(rowsOf(state, 'ACT-CARD').length, reachableAt(idle.rows, t).length);
  assert.equal(rowsOf(state, 'ACT-CARD').length > 20, true);
});

test('no hole: an empty answer that contradicts the record is not had, and the same step is asked again 12 hours later', async () => {
  // the card appears later with a week of rows through the ordinary window; requests for it alone answer empty for 30 hours
  const provider = makeProvider([CHECKING(), CARD({ listedFrom: NOW + HOUR_MS, limitedRowsFrom: NOW + 30 * HOUR_MS })]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  await reading(state, provider, NOW + 3 * HOUR_MS);
  const card = byExt(state, 'ACT-CARD');
  assert.equal(rowsOf(state, 'ACT-CARD').length > 0, true, 'rows from the ordinary window');
  assert.deepEqual(card.backfill, { ...OPEN, tries: 1, at: NOW + 3 * HOUR_MS }, 'the record holds rows inside the window the answer left empty');
  assert.equal(limited(provider).length, 1, 'the next step is not asked');
  await reading(state, provider, NOW + 6 * HOUR_MS);
  assert.equal(limited(provider).length, 1, 'not before 12 hours');
  await reading(state, provider, NOW + 15 * HOUR_MS);
  await reading(state, provider, NOW + 27 * HOUR_MS);
  assert.deepEqual(card.backfill, { ...OPEN, tries: 3, at: NOW + 27 * HOUR_MS });
  assert.deepEqual(limited(provider).map((r) => Math.round((r.at / 1000 - r.end) / 86400)), [0, 0, 0], 'the same step each time');
  const t = NOW + 39 * HOUR_MS;
  await reading(state, provider, t);
  assert.deepEqual(card.backfill, DONE(t, { tries: 3 }));
  const got = rowsOf(state, 'ACT-CARD');
  noRowTwice(got);
  assert.equal(got.length, reachableAt(CARD_ROWS(), t).length, 'continuous: every row the provider holds in 176 days');
});

test('answers that name the account in their problems are counted: it gives up after 6, and is opened again when its first row arrives', async () => {
  const card = CARD({ rowsFrom: NOW + 30 * DAY_MS });
  const provider = makeProvider([CHECKING(), card]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  provider.errlist = [{ code: 'act.unavailable', msg: 'Transactions unavailable', account_id: 'ACT-CARD' }];
  for (let n = 1; n <= 8; n++) await reading(state, provider, NOW + n * 12 * HOUR_MS + n * 60000);
  const kept = byExt(state, 'ACT-CARD');
  assert.deepEqual(kept.backfill, { need: true, step: 0, done: true, gaveUp: true, tries: HISTORY.maxTries, at: NOW + 6 * 12 * HOUR_MS + 6 * 60000 });
  assert.equal(limited(provider).length, HISTORY.maxTries, 'and nothing is asked after that');
  assert.equal(lacksHistory(kept), false);
  provider.errlist = [];
  const t = NOW + 31 * DAY_MS;
  await reading(state, provider, t);
  assert.deepEqual(kept.backfill, DONE(t), 'opened again from step 0 by its first bank row, and asked in the same reading');
  assert.equal(rowsOf(state, 'ACT-CARD').length, reachableAt(CARD_ROWS(), t).length);
});

test('an account finished with nothing on the record is opened again by its first bank row, and only then', async () => {
  const provider = makeProvider([CHECKING(), CARD({ rowsFrom: NOW + 5 * DAY_MS })]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  const t1 = NOW + 3 * HOUR_MS;
  await reading(state, provider, t1);
  const card = byExt(state, 'ACT-CARD');
  assert.deepEqual(card.backfill, DONE(t1), 'four empty answers: the provider carries nothing for it');
  assert.equal(rowsOf(state, 'ACT-CARD').length, 0);
  await reading(state, provider, NOW + 2 * DAY_MS);
  assert.equal(limited(provider).length, 4, 'a finished account is left alone');
  const t2 = NOW + 6 * DAY_MS;
  await reading(state, provider, t2);
  assert.deepEqual(card.backfill, DONE(t2));
  assert.equal(limited(provider).length, 8);
  assert.equal(rowsOf(state, 'ACT-CARD').length, reachableAt(CARD_ROWS(), t2).length);
  await reading(state, provider, t2 + DAY_MS);
  assert.equal(limited(provider).length, 8, 'rows that follow do not open it again');
});

for (const status of [429, 500]) {
  test('a history request that fails with ' + status + ' does not fail the reading, changes nothing but the time, and is tried again 12 hours later', async () => {
    const provider = makeProvider([CHECKING(), CARD({ listedFrom: NOW + HOUR_MS })], { failLimited: status });
    const state = defaultState(NOW - DAY_MS);
    await reading(state, provider, NOW);
    const t1 = NOW + 3 * HOUR_MS;
    const out = await reading(state, provider, t1);
    assert.equal(out.historyFailed, true);
    assert.equal(state.sync.status, 'ok');
    const card = byExt(state, 'ACT-CARD');
    assert.deepEqual(card.backfill, { ...OPEN, at: t1 });
    await reading(state, provider, t1 + 3 * HOUR_MS);
    assert.equal(limited(provider).length, 1);
    provider.failLimited = 0;
    await reading(state, provider, t1 + 12 * HOUR_MS);
    assert.deepEqual(card.backfill, DONE(t1 + 12 * HOUR_MS));
  });
}

test('when a later step fails, the steps had are kept and that step alone is asked again 12 hours later', async () => {
  const provider = makeProvider([CHECKING(), CARD({ listedFrom: NOW + HOUR_MS })], { failEarlier: 500 });
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  const t1 = NOW + 3 * HOUR_MS;
  await reading(state, provider, t1);
  const card = byExt(state, 'ACT-CARD');
  assert.deepEqual(card.backfill, { ...OPEN, step: 2, at: t1 }, 'steps 0 and 1 were had; step 2 failed');
  assert.equal(historyStep(state, card, t1).step, 2);
  provider.failEarlier = 0;
  const t2 = t1 + 12 * HOUR_MS;
  const before = limited(provider).length;
  await reading(state, provider, t2);
  assert.deepEqual(limited(provider).slice(before).map((r) => Math.round((r.at / 1000 - r.end) / 86400)), [88, 132]);
  assert.deepEqual(card.backfill, DONE(t2));
  noRowTwice(rowsOf(state, 'ACT-CARD'));
});

test('six accounts needing history at once: no ordinary reading is skipped, at most 2 accounts a reading, 8 requests always kept, and all are served', async () => {
  const late = (n) => ({ id: 'ACT-L' + n, name: 'Late Card ' + n, conn: 'CON-CARD', balance: '-10.00', rows: rowsEvery('L' + n, 9, 2, 170, '-3.00', 'SAMPLE CAFE ' + n), listedFrom: NOW + DAY_MS });
  const provider = makeProvider([CHECKING(), late(1), late(2), late(3), late(4), late(5), late(6)]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  let skipped = 0;
  let most = 0;
  const step = 3 * HOUR_MS + 60000;
  for (let now = NOW + 2 * DAY_MS; now < NOW + 8 * DAY_MS; now += step) {
    if (!quotaAllows(state.sync.requests, state.sync.lastOk, now, { manual: false, needed: 1 }).ok) { skipped++; continue; }
    const before = provider.log.length;
    await reading(state, provider, now);
    const asked = new Set(provider.log.slice(before).flatMap((r) => r.only));
    assert.ok(asked.size <= HISTORY.perReading, 'accounts asked in one reading: ' + asked.size);
    most = Math.max(most, state.sync.requests.filter((t) => now - t < DAY_MS).length);
  }
  assert.equal(skipped, 0);
  assert.ok(most <= QUOTA.perDay, 'the most requests in a day: ' + most);
  for (let n = 1; n <= 6; n++) {
    assert.equal(byExt(state, 'ACT-L' + n).backfill.done, true, 'account ' + n);
    assert.equal(byExt(state, 'ACT-L' + n).backfill.step, 4, 'account ' + n);
    assert.equal(rowsOf(state, 'ACT-L' + n).filter((t) => t.day < '2026-08-01').length > 0, true, 'account ' + n + ' has its earlier rows');
  }
  for (const r of provider.log) assert.equal(r.seconds <= WINDOW_SECONDS && !r.noticed, true);
});

test('pacing: nothing in a first reading, 8 requests kept for the ordinary readings, the one waited longest first', () => {
  const state = defaultState(NOW - DAY_MS);
  const bank = (n, backfill) => ({ id: 'a' + n, source: 'bank', ext: { src: 'simplefin', id: 'X' + n, conn: 'C' }, name: 'Account ' + n, hidden: false, backfill });
  state.accounts = [bank(1, { ...OPEN, at: NOW - 13 * HOUR_MS }), bank(2, { ...OPEN, step: 2, at: NOW - 30 * HOUR_MS }), bank(3, { ...OPEN, at: NOW - 2 * HOUR_MS }), bank(4, null), bank(5, { ...OPEN })];
  assert.equal(isFirstReading(state), true);
  assert.deepEqual(historyRequests(state, NOW, isFirstReading(state)), []);
  assert.deepEqual(historyRequests(state, NOW, false).map((s) => s.accountId), ['a5', 'a2']);
  assert.deepEqual(historyRequests(state, NOW, false)[0], { accountId: 'a5', step: 0, fromMs: NOW - 44 * DAY_MS, toMs: NOW, pending: true, only: ['X5'] });
  assert.deepEqual(historyRequests(state, NOW, false)[1], { accountId: 'a2', step: 2, fromMs: NOW - 132 * DAY_MS, toMs: NOW - 88 * DAY_MS, pending: true, only: ['X2'] });
  state.sync.requests = Array.from({ length: QUOTA.perDay - HISTORY.spare }, (_, i) => NOW - (i + 1) * 60000);
  assert.equal(HISTORY.spare, 8);
  assert.equal(historyAllowed(state, NOW), true);
  state.sync.requests.push(NOW - 5);
  assert.equal(historyAllowed(state, NOW), false);
  assert.deepEqual(historyRequests(state, NOW, false), []);
  state.accounts[4].hidden = true;
  assert.equal(historyStep(state, state.accounts[4], NOW), null, 'an account left out is not asked');
  assert.equal(recordHistory(state, { accountId: 'nope', step: 0, fromMs: NOW - DAY_MS, toMs: NOW }, NOW, null), null);
});

test('a first reading that was interrupted is a first reading again; a record linked before the mark existed has completed one', async () => {
  const provider = makeProvider([CHECKING(), CARD({ rowsFrom: NOW + DAY_MS })]);
  const state = defaultState(NOW - DAY_MS);
  // the first of the four windows arrives and is merged, then the reading stops
  const first = syncWindows(state, NOW)[0];
  const feed = await fetchSimplefin(ACCESS, { ...first, pending: true }, provider.fetch, NOW);
  feed.reading = NOW;
  mergeFeed(state, feed, NOW);
  assert.equal(Number.isFinite(state.sync.lastOk), true);
  assert.equal(state.sync.completed, false);
  assert.equal(isFirstReading(state), true);
  const t = NOW + HOUR_MS;
  assert.equal(syncWindows(state, t).length, 4, 'the retry asks the four windows again');
  assert.deepEqual(historyRequests(state, t, isFirstReading(state)), []);
  await reading(state, provider, t);
  assert.equal(limited(provider).length, 0, 'nothing is asked for history during it');
  assert.equal(byExt(state, 'ACT-CHK').backfill, null, 'an account that arrived with rows has nothing to do');
  assert.deepEqual(byExt(state, 'ACT-CARD').backfill, OPEN);
  assert.equal(isFirstReading(state), false);
  // stored and loaded again in the middle of a first reading: still a first reading
  const half = defaultState(NOW - DAY_MS);
  half.sync.lastOk = NOW;
  assert.equal(isFirstReading(migrate(JSON.parse(JSON.stringify(half)))), true);
  // a record of a device linked before the mark existed
  const older = defaultState(NOW - DAY_MS);
  older.sync.lastOk = NOW - DAY_MS;
  delete older.sync.completed;
  assert.equal(checkDoc(older), null);
  assert.equal(isFirstReading(migrate(JSON.parse(JSON.stringify(older)))), false);
  const never = defaultState(NOW - DAY_MS);
  delete never.sync.completed;
  assert.equal(isFirstReading(migrate(never)), true);
});

test('a pending row never makes a reading cost more than one request: older than 44 days it is removed by an ordinary feed, never by one limited to accounts; a younger one waits for a window that holds its day', () => {
  const state = defaultState(NOW - 300 * DAY_MS);
  const pend = (id, d) => ({ extId: id, amount: -700, posted: null, at: dayAgo(d), pending: true, description: 'SAMPLE HOLD ' + id });
  const old = NOW - 170 * DAY_MS;
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [pend('p-old', 172), pend('p-mid', 171), pend('p-edge', 171), pend('p-new', 171)] }], old), reading: old }, old);
  state.sync.completed = true;
  assert.equal(state.txs.length, 4);
  const dayOf = { 'p-old': '2026-08-03', 'p-mid': '2026-09-27', 'p-edge': '2026-09-28', 'p-new': '2026-10-01' }; // 100, 45, 44 and 41 days before Nov 11
  for (const tx of state.txs) tx.day = dayOf[tx.ext.id];
  const oneWindow = [{ fromMs: NOW - 44 * DAY_MS, toMs: NOW }];
  assert.deepEqual(syncWindows(state, NOW), oneWindow, 'a pending row pulls the start back 44 days at most: one request');
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }], NOW), reading: NOW, only: ['A'] }, NOW);
  assert.equal(state.txs.length, 4, 'a feed limited to accounts removes nothing');
  // an ordinary feed whose connection is in trouble judges no row gone, and still removes the ones too old to be pending
  const troubled = { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }], NOW), reading: NOW, errors: [{ code: 'con.auth', message: 'Sample notice', connId: 'CON-CARD', accountId: '' }] };
  mergeFeed(state, troubled, NOW);
  assert.deepEqual(state.txs.map((t) => t.ext.id), ['p-edge', 'p-new'], 'more than 44 days before today: removed; the others wait');
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }], NOW), reading: NOW }, NOW);
  assert.deepEqual(state.txs.map((t) => t.ext.id), ['p-edge', 'p-new'], 'the window asked (30 days) holds the day of neither');
  assert.deepEqual(syncWindows(state, NOW), oneWindow);
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }], NOW), fromMs: NOW - 44 * DAY_MS, reading: NOW + 1 }, NOW);
  assert.deepEqual(state.txs.map((t) => t.ext.id), ['p-edge'], 'a window that holds its day judges the younger one gone; the first day of a window is never judged');
  assert.deepEqual(syncWindows(state, NOW + DAY_MS), [{ fromMs: NOW - 43 * DAY_MS, toMs: NOW + DAY_MS }]);
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }], NOW + DAY_MS), reading: NOW + DAY_MS }, NOW + DAY_MS);
  assert.deepEqual(state.txs, [], 'the next day it is more than 44 days old');
});

test('only the newest posted row reaches further than one window: a device back after 100 days asks three, whatever is pending', () => {
  const state = defaultState(NOW - 300 * DAY_MS);
  const old = NOW - 100 * DAY_MS;
  const rows = [
    { extId: 'k1', amount: -500, posted: dayAgo(101), at: null, pending: false, description: 'SAMPLE GROCER' },
    { extId: 'h1', amount: -700, posted: null, at: dayAgo(150), pending: true, description: 'SAMPLE HOLD' },
  ];
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows }], old), fromMs: old - 44 * DAY_MS, reading: old }, old);
  state.sync.completed = true;
  const windows = syncWindows(state, NOW);
  assert.equal(windows.length, 3, '108 days back from the newest posted row');
  assert.equal(windows[0].fromMs > NOW - 110 * DAY_MS, true, 'the pending row 150 days back does not move the start');
  for (const w of windows) assert.equal(w.toMs - w.fromMs <= 44 * DAY_MS, true);
});

test('no hole on the last day: an empty answer to the window that ends now contradicts a row of the account dated today', async () => {
  // the card appears later; the ordinary window brings its one recent row, dated today; requests for it alone answer empty
  const today = { id: 'C-today', posted: dayAgo(0), amount: '-12.25', description: 'SAMPLE CAFE TODAY' };
  const provider = makeProvider([CHECKING(), CARD({ rows: [today, ...rowsEvery('C', 3, 12, 170, '-12.25', 'SAMPLE CAFE')], listedFrom: NOW + HOUR_MS, limitedRowsFrom: NOW + 300 * HOUR_MS })]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  await reading(state, provider, NOW + 3 * HOUR_MS);
  assert.deepEqual(rowsOf(state, 'ACT-CARD').map((t) => t.day), [TODAY], 'the one row the ordinary window brought');
  assert.deepEqual(byExt(state, 'ACT-CARD').backfill, { ...OPEN, tries: 1, at: NOW + 3 * HOUR_MS }, 'the step is not had');
  assert.equal(limited(provider).length, 1, 'the next step is not asked');
});

test('account.feed: a window that partly overlaps the days the reading already asked adds only the rows outside them', () => {
  const state = defaultState(NOW - DAY_MS);
  const row = (id, d, amount = -500) => ({ extId: id, amount, posted: dayAgo(d), at: null, pending: false, description: 'SAMPLE CAFE ' + id });
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [row('r10', 10), row('r50', 50), row('r60', 60)] }], NOW), fromMs: NOW - 68 * DAY_MS, reading: NOW }, NOW);
  const step = { ...plainFeed([{ id: 'A', name: 'Card', rows: [row('r50', 50), row('r60', 60), row('r68', 68), row('r80', 80), row('z70', 70, 0), row('z85', 85, 0)] }], NOW), fromMs: NOW - 88 * DAY_MS, toMs: NOW - 44 * DAY_MS, reading: NOW, only: ['A'] };
  mergeFeed(state, step, NOW);
  assert.equal(state.txs.length, 5, 'the record holds each row once');
  // r68 is dated on the first day the reading had asked, before the instant it asked from: it is counted, as are
  // r80 and the two $0.00 rows, all before that instant; r50 and r60 lie inside the instants asked
  assert.deepEqual(byExt(state, 'A').feed, { readAt: NOW, rows: 7, first: '2026-08-23', last: '2026-11-01', askedFrom: '2026-08-15', askedTo: TODAY, askedFromMs: NOW - 88 * DAY_MS, askedToMs: NOW });
  // the next window ends where the instants asked begin: all of it is added, the $0.00 row too
  const further = { ...plainFeed([{ id: 'A', name: 'Card', rows: [row('r100', 100), row('z110', 110, 0)] }], NOW), fromMs: NOW - 132 * DAY_MS, toMs: NOW - 88 * DAY_MS, reading: NOW, only: ['A'] };
  mergeFeed(state, further, NOW);
  assert.equal(byExt(state, 'A').feed.rows, 9);
  mergeFeed(state, step, NOW);
  assert.equal(byExt(state, 'A').feed.rows, 9, 'a window wholly inside the instants asked keeps the larger count');
});

test('the history state has one form: null or { need, step, done, gaveUp, tries, at }', () => {
  assert.equal(backfillOf({ backfill: null }), null);
  assert.equal(backfillOf({ backfill: { tries: 2, at: NOW, done: false } }), null, 'anything else is no state');
  assert.deepEqual(backfillOf({ backfill: { ...OPEN, step: 3, tries: 2, at: NOW } }), { ...OPEN, step: 3, tries: 2, at: NOW });
  const state = defaultState(NOW - DAY_MS);
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }], NOW), reading: NOW }, NOW);
  assert.deepEqual(state.accounts[0].backfill, OPEN);
  assert.equal(checkDoc(state), null);
  for (const step of [0, 1, 4]) {
    state.accounts[0].backfill = { ...OPEN, step, done: step === 4, at: NOW };
    assert.equal(checkDoc(state), null);
  }
  for (const bad of [{ tries: 2, at: NOW, done: true }, { ...OPEN, step: 5 }, { ...OPEN, step: -1 }, { ...OPEN, need: false }, { ...OPEN, tries: 1.5 }, { ...OPEN, at: 'then' }, { need: true, recent: true, done: true, gaveUp: false, tries: 0, at: NOW }]) {
    state.accounts[0].backfill = bad;
    assert.notEqual(checkDoc(state), null, JSON.stringify(bad));
  }
});

test('an account whose provider id changed is the same account: its rows, settings and history state are kept, none is doubled', async () => {
  const accounts = [CHECKING(), CARD()];
  const provider = makeProvider(accounts);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  const card = byExt(state, 'ACT-CARD');
  card.note = 'the one with the points';
  card.apr = 0.2199;
  const rowsBefore = rowsOf(state, 'ACT-CARD').length;
  const total = state.txs.length;

  accounts[1] = { ...accounts[1], id: 'ACT-CARD-2', rows: accounts[1].rows.map((r) => ({ ...r, id: 'N' + r.id })) };
  const t1 = NOW + DAY_MS;
  await reading(state, provider, t1);
  assert.equal(state.accounts.filter((a) => a.name === 'Rewards Card').length, 1, 'no second account');
  assert.equal(card.ext.id, 'ACT-CARD-2');
  assert.equal(byExt(state, 'ACT-CARD'), undefined);
  assert.deepEqual([card.note, card.apr, card.backfill], ['the one with the points', 0.2199, null]);
  assert.equal(rowsOf(state, 'ACT-CARD-2').length, rowsBefore, 'the rows the feed carried again are the rows on the record');
  assert.equal(state.txs.length, total);
  assert.equal(limited(provider).length, 0, 'and it is not asked for its history');
  assert.equal(checkDoc(state), null);
});

test('two accounts in one feed with the same connection and name are never merged into one another', () => {
  const state = defaultState(NOW - DAY_MS);
  const row = (id) => ({ extId: id, amount: -500, posted: dayAgo(1), at: null, pending: false, description: 'SAMPLE CAFE' });
  mergeFeed(state, plainFeed([{ id: 'A', name: 'Card', rows: [row('r1')] }], NOW), NOW);
  mergeFeed(state, plainFeed([{ id: 'A', name: 'Card', rows: [row('r1')] }, { id: 'B', name: 'Card', rows: [row('r2')] }], NOW + HOUR_MS), NOW + HOUR_MS);
  assert.deepEqual(state.accounts.map((a) => a.ext.id), ['A', 'B']);
  // nor when two unknown ids could both be the missing one, nor on another connection, nor under another name
  mergeFeed(state, plainFeed([{ id: 'C', name: 'Card', rows: [] }, { id: 'D', name: 'Card', rows: [] }], NOW + 2 * HOUR_MS), NOW + 2 * HOUR_MS);
  mergeFeed(state, plainFeed([{ id: 'E', name: 'Card', conn: 'OTHER', rows: [] }, { id: 'F', name: 'Card Two', rows: [] }], NOW + 3 * HOUR_MS), NOW + 3 * HOUR_MS);
  assert.deepEqual(state.accounts.map((a) => a.ext.id), ['A', 'B', 'C', 'D', 'E', 'F']);
  // a feed limited to accounts adopts nothing
  mergeFeed(state, { ...plainFeed([{ id: 'G', name: 'Card Two', rows: [] }], NOW + 4 * HOUR_MS), only: ['G'] }, NOW + 4 * HOUR_MS);
  assert.equal(state.accounts.find((a) => a.name === 'Card Two').ext.id, 'F');
});

/* ------------------------------------------------- rows without a posting time */

test('rows the bank dates with transacted_at only are posted on that day and survive the next reading', async () => {
  const rows = [100, 120, 150].map((d) => ({ id: 'OLD-' + d, transacted_at: dayAgo(d), amount: '-20.00', description: 'SAMPLE BOOKSHOP ' + d }))
    .concat([{ id: 'ZERO', posted: 0, transacted_at: dayAgo(3), amount: '-7.00', description: 'SAMPLE BAKERY' }]);
  const provider = makeProvider([CHECKING(), CARD({ rows, listedFrom: NOW + DAY_MS })]);
  const state = defaultState(NOW - DAY_MS);
  await reading(state, provider, NOW);
  await reading(state, provider, NOW + 2 * DAY_MS);
  const got = rowsOf(state, 'ACT-CARD');
  assert.equal(got.length, 4);
  assert.deepEqual(got.map((t) => t.pending), [false, false, false, false]);
  assert.deepEqual(got.map((t) => t.postedDay).sort(), ['2026-06-14', '2026-07-14', '2026-08-03', '2026-11-08']);
  assert.equal(byExt(state, 'ACT-CARD').backfill.done, true);
  await reading(state, provider, NOW + 2 * DAY_MS + 4 * HOUR_MS);
  await reading(state, provider, NOW + 3 * DAY_MS);
  assert.equal(rowsOf(state, 'ACT-CARD').length, 4, 'history brought once is not taken away');
});

test('a row is pending when the provider says so, or when it has neither a posting time nor a time it happened', () => {
  const state = defaultState(NOW - DAY_MS);
  const base = { amount: -500, description: 'SAMPLE CAFE' };
  mergeFeed(state, plainFeed([{ id: 'A', name: 'Card', rows: [
    { ...base, extId: 'flagged', posted: dayAgo(1), at: null, pending: true },
    { ...base, extId: 'undated', posted: null, at: null, pending: false },
    { ...base, extId: 'happened', posted: null, at: dayAgo(2), pending: false },
    { ...base, extId: 'zero', posted: 0, at: dayAgo(3), pending: false },
    { ...base, extId: 'flagged-at', posted: 0, at: dayAgo(4), pending: true },
  ] }], NOW), NOW);
  const seen = Object.fromEntries(state.txs.map((t) => [t.ext.id, [t.pending, t.day, t.postedDay]]));
  assert.deepEqual(seen, {
    flagged: [true, '2026-11-10', null],
    undated: [true, TODAY, null],
    happened: [false, '2026-11-09', '2026-11-09'],
    zero: [false, '2026-11-08', '2026-11-08'],
    'flagged-at': [true, '2026-11-07', null],
  });
});

/* -------------------------------------------------------- what the sheet says */

test('account.feed: undated pending rows are in the span on the day they are stored, and a $0.00 row is counted', () => {
  const state = defaultState(NOW - DAY_MS);
  const feed = plainFeed([{ id: 'A', name: 'Card', rows: [
    { extId: 'n1', amount: -450, posted: null, at: null, pending: true, description: 'SAMPLE PENDING CAFE' },
    { extId: 'n3', amount: -900, posted: dayAgo(2), at: null, pending: false, description: 'SAMPLE GROCER' },
    { extId: 'n4', amount: -1200, posted: dayAgo(3), at: null, pending: false, description: 'SAMPLE FUEL' },
    { extId: 'n5', amount: 0, posted: dayAgo(1), at: null, pending: false, description: 'SAMPLE AUTHORISATION' },
  ] }], NOW);
  mergeFeed(state, feed, NOW);
  const account = state.accounts[0];
  assert.equal(state.txs.length, 3, 'a $0.00 row is not a transaction to keep');
  assert.deepEqual([account.feed.rows, account.feed.first, account.feed.last], [4, '2026-11-08', TODAY]);
  // every row undated: the span is the day they were first seen
  const other = defaultState(NOW - DAY_MS);
  mergeFeed(other, plainFeed([{ id: 'B', name: 'Card', rows: [
    { extId: 'u1', amount: -450, posted: null, at: null, pending: true, description: 'SAMPLE CAFE' },
    { extId: 'u2', amount: -650, posted: null, at: null, pending: true, description: 'SAMPLE DINER' },
  ] }], NOW), NOW);
  assert.deepEqual([other.accounts[0].feed.rows, other.accounts[0].feed.first, other.accounts[0].feed.last], [2, TODAY, TODAY]);
  // only $0.00 rows: the feed did carry a transaction, and the record holds none, so the account is to be asked
  const zero = defaultState(NOW - DAY_MS);
  mergeFeed(zero, plainFeed([{ id: 'Z', name: 'Card', rows: [{ extId: 'z1', amount: 0, posted: dayAgo(1), at: null, pending: false, description: 'SAMPLE AUTHORISATION' }] }], NOW), NOW);
  assert.equal(zero.accounts[0].feed.rows, 1);
  assert.deepEqual(zero.accounts[0].backfill, OPEN);
});

test('a row the bank dated tomorrow is listed on the account, and the count on the record agrees with what the reading carried', () => {
  const state = defaultState(NOW - DAY_MS);
  mergeFeed(state, plainFeed([{ id: 'A', name: 'Card', rows: [
    { extId: 'ahead', amount: -450, posted: dayAgo(-1), at: null, pending: false, description: 'SAMPLE CAFE' },
    { extId: 'now', amount: -900, posted: dayAgo(0), at: null, pending: false, description: 'SAMPLE GROCER' },
  ] }], NOW), NOW);
  const account = state.accounts[0];
  const recent = recentTransactions(state, TODAY, { accountId: account.id });
  assert.deepEqual(recent.rows.map((r) => [r.tx.ext.id, r.tx.day]), [['ahead', '2026-11-12'], ['now', TODAY]]);
  assert.equal(recent.total, account.feed.rows);
  assert.equal(recent.today.count, 1, 'today counts only what is dated today');
  assert.deepEqual([account.feed.first, account.feed.last], [TODAY, '2026-11-12']);
});

test('the need is decided once: a later feed neither sets it again nor takes it back', () => {
  const state = defaultState(NOW - DAY_MS);
  const row = (id, d) => ({ extId: id, amount: -500, posted: dayAgo(d), at: null, pending: false, description: 'SAMPLE CAFE ' + id });
  // first reading, two of its windows: the earlier one is empty for the card, the later one brings its rows
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }], NOW), reading: NOW }, NOW);
  assert.deepEqual(state.accounts[0].backfill, OPEN);
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [row('r1', 1)] }], NOW), reading: NOW }, NOW);
  assert.equal(state.accounts[0].backfill, null, 'it arrived with rows on the first reading');
  // a later reading: an account appears (with rows), another is left out, a third has no rows
  state.sync.completed = true;
  const t = NOW + 3 * HOUR_MS;
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [row('r1', 1)] }, { id: 'B', name: 'Late', rows: [row('b1', 40)] }], t), reading: t }, t);
  assert.equal(state.accounts[0].backfill, null);
  assert.deepEqual(state.accounts[1].backfill, OPEN, 'it appeared later: old rows or not');
  state.accounts[1].backfill = { ...OPEN, step: 4, done: true, at: t };
  state.accounts[0].hidden = true;
  state.txs = state.txs.filter((tx) => tx.accountId !== state.accounts[0].id);
  const t2 = t + 3 * HOUR_MS;
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [] }, { id: 'B', name: 'Late', rows: [row('b1', 40), row('b2', 1)] }], t2), reading: t2 }, t2);
  assert.equal(state.accounts[0].backfill, null, 'an account left out is not asked');
  assert.deepEqual(state.accounts[1].backfill, { ...OPEN, step: 4, done: true, at: t }, 'a finished account stays finished');
  // a feed limited to accounts decides nothing
  mergeFeed(state, { ...plainFeed([{ id: 'N', name: 'New', rows: [] }], t2), reading: t2, only: ['N'] }, t2);
  assert.equal(state.accounts[2].backfill, null);
});

test('under cover every number in a provider\'s message is masked, with the currency mark or code next to it', () => {
  const message = 'Card feed paused: $1,234.56, USD 40, 12.50, 40 USD, EUR 99, \u20ac1.234,56, 2,000 dollars, 3 accounts.';
  const covered = coverText({ state: { settings: { cover: true } } }, message);
  assert.equal(covered, 'Card feed paused: \u2014, \u2014, \u2014, \u2014, \u2014, \u2014, \u2014, \u2014 accounts.');
  assert.doesNotMatch(covered, /\d|USD|EUR|dollars|[$\u20ac]/);
  assert.equal(coverText({ state: { settings: { cover: false } } }, message), message);
  assert.equal(coverText(null, 7), '');
});

test('account.feed: on a partial overlap a row is counted by the time the bank gives for it, not by its day or by who stored it', () => {
  const state = defaultState(NOW - DAY_MS);
  const at = (id, ms, extra = {}) => ({ extId: id, amount: -500, posted: Math.floor(ms / 1000), at: null, pending: false, description: 'SAMPLE CAFE ' + id, ...extra });
  // an earlier reading stored a row two hours before the instant the next reading's ordinary window will start, on the same day
  const edge = at('edge', NOW - 50 * DAY_MS - 2 * HOUR_MS);
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [edge] }], NOW - 49 * DAY_MS), fromMs: NOW - 60 * DAY_MS }, NOW - 49 * DAY_MS);
  assert.equal(state.txs.length, 1);
  // the reading: its ordinary window does not carry the edge row...
  const inBoth = at('both', NOW - 46 * DAY_MS);
  const zeroInBoth = at('z47', NOW - 47 * DAY_MS, { amount: 0 });
  mergeFeed(state, { ...plainFeed([{ id: 'A', name: 'Card', rows: [at('r10', NOW - 10 * DAY_MS), inBoth, zeroInBoth] }], NOW), fromMs: NOW - 50 * DAY_MS, reading: NOW }, NOW);
  assert.equal(byExt(state, 'A').feed.rows, 3);
  // ...its history step does: the row was on the record already and is dated on the first day asked, yet it is carried now for the first time
  const step = { ...plainFeed([{ id: 'A', name: 'Card', rows: [
    inBoth, edge, at('r60', NOW - 60 * DAY_MS), at('z61', NOW - 61 * DAY_MS, { amount: 0 }), zeroInBoth,
    { extId: 'p70', amount: -300, posted: null, at: Math.floor((NOW - 70 * DAY_MS) / 1000), pending: true, description: 'SAMPLE INN' },
  ] }], NOW), fromMs: NOW - 88 * DAY_MS, toMs: NOW - 44 * DAY_MS, reading: NOW, only: ['A'] };
  mergeFeed(state, step, NOW);
  const feed = byExt(state, 'A').feed;
  // both and z47 lie inside the instants already asked; edge, r60, z61 and the pending p70 lie before them
  assert.equal(feed.rows, 7);
  assert.deepEqual([feed.askedFromMs, feed.askedToMs], [NOW - 88 * DAY_MS, NOW]);
  assert.equal(checkDoc(state), null);
  mergeFeed(state, step, NOW);
  assert.equal(byExt(state, 'A').feed.rows, 7, 'the same window again adds nothing');
});
