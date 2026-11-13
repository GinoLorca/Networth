import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_HISTORY_DAYS, DEMO_MATCH_DAYS, buildDemoState, demoFeed, demoManualAccounts } from '../js/model/demo.js';
import { CATEGORIES, TX_KINDS, checkDoc, defaultState, isLive, migrate, txEffect } from '../js/model/schema.js';
import { addDays, diffDays, dow, endOfMonth, feedDay, feedHasTime, gameDay, gameDayStartMs, monthOf, parts, weekStart } from '../js/model/dates.js';
import { mergeFeed } from '../js/model/merge.js';
import { refresh } from '../js/model/detect.js';
import { makeLedger } from '../js/model/ledger.js';
import { cardMonths } from '../js/model/cards.js';
import { annotateRound } from '../js/model/annotate.js';

/* ------------------------------------------------------------------ fixtures */

const ROLLOVER = 4;

/** A local instant, built from its parts so that no test depends on the machine's time zone. */
function at(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

const TUESDAY = at(2026, 11, 10, 14, 36);

/** The story has to hold whatever day the sample is opened on: one day of each kind. */
const DAYS = [
  ['a Tuesday afternoon', TUESDAY],
  ['a Wednesday, just after the rollover', at(2026, 11, 11, 4, 5)],
  ['a Thursday morning', at(2026, 11, 12, 9, 0)],
  ['a Friday payday', at(2026, 11, 20, 10, 0)],
  ['a Saturday', at(2026, 11, 21, 16, 0)],
  ['a Sunday', at(2026, 11, 15, 12, 0)],
  ['a Monday', at(2026, 11, 16, 8, 0)],
  ['the first of a month', at(2026, 12, 1, 13, 0)],
  ['a day in another year', at(2027, 6, 17, 12, 0)],
];

const documents = new Map();

/** The sample document for an instant, built once. Tests read it; one that changes it takes a copy. */
function documentAt(nowMs) {
  if (!documents.has(nowMs)) documents.set(nowMs, buildDemoState(nowMs));
  return documents.get(nowMs);
}

/** Run a check on every sample day; a failure says which day it was. */
function onEveryDay(check) {
  for (const [label, nowMs] of DAYS) {
    const state = documentAt(nowMs);
    const ledger = makeLedger(state, nowMs);
    try {
      check({ label, nowMs, state, ledger, today: ledger.today });
    } catch (error) {
      error.message = 'On ' + label + ': ' + error.message;
      throw error;
    }
  }
}

function accountOfType(state, type) {
  const found = state.accounts.filter((account) => account.type === type);
  assert.equal(found.length, 1, 'one ' + type + ' account');
  return found[0];
}

/** The rounds of the match that are over, oldest first. */
function matchRounds(ledger) {
  const rounds = [];
  for (let ago = DEMO_MATCH_DAYS; ago >= 1; ago--) rounds.push(ledger.round(addDays(ledger.today, -ago)));
  return rounds;
}

/** The rounds of the Monday-to-Sunday week `weeksAgo` weeks before this one. */
function weekRounds(ledger, weeksAgo) {
  const monday = addDays(weekStart(ledger.today), -7 * weeksAgo);
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => ledger.round(addDays(monday, offset)));
}

function sweepIds(state) {
  return new Set(state.sweeps.map((sweep) => sweep.txId));
}

function glyphsOf(round, state) {
  const annotated = annotateRound(round, { sweepTxIds: sweepIds(state) });
  return { round: annotated.round ? annotated.round.glyph : null, moves: round.moves.map((tx) => (annotated.moves.has(tx.id) ? annotated.moves.get(tx.id).glyph : null)) };
}

function gameStops(round) {
  return round.moves.filter((tx) => tx.kind === 'spend' && tx.klass === 'game' && CATEGORIES[tx.category].stop);
}

/* ------------------------------------------------------------------ the feed */

test('demoFeed: the same day and seed always give the same feed', () => {
  const feed = demoFeed(TUESDAY);
  assert.deepEqual(demoFeed(TUESDAY), feed);
  assert.deepEqual(demoFeed(TUESDAY, { seed: 1, days: 150 }), feed, 'the defaults are seed 1 and 150 days');
  // Every instant of one game day: from the rollover to just before the next one.
  assert.deepEqual(demoFeed(at(2026, 11, 10, 4, 0)), feed);
  assert.deepEqual(demoFeed(at(2026, 11, 10, 23, 59)), feed);
  assert.deepEqual(demoFeed(at(2026, 11, 11, 3, 59)), feed);
  assert.deepEqual(demoFeed(TUESDAY, { seed: 42 }), demoFeed(at(2026, 11, 10, 6, 0), { seed: 42 }));
});

test('demoFeed: another day or another seed gives another feed', () => {
  const feed = demoFeed(TUESDAY);
  assert.notDeepEqual(demoFeed(at(2026, 11, 11, 4, 0)), feed, 'the rollover starts a new day');
  assert.notDeepEqual(demoFeed(at(2026, 11, 10, 3, 59)), feed, 'before the rollover it is still the day before');
  assert.notDeepEqual(demoFeed(TUESDAY, { seed: 2 }), feed);
  const descriptions = (source) => source.accounts[0].txs.map((tx) => tx.description + tx.amount).join('|');
  assert.notEqual(descriptions(demoFeed(TUESDAY, { seed: 2 })), descriptions(feed), 'the seed changes what was bought');
});

test('demoFeed: the shape of a bank feed, as of the start of the game day', () => {
  const feed = demoFeed(TUESDAY);
  assert.deepEqual(Object.keys(feed).sort(), ['accounts', 'errors', 'fetchedAt', 'fromMs', 'src', 'toMs']);
  assert.equal(feed.src, 'demo');
  assert.deepEqual(feed.errors, []);
  assert.equal(feed.fetchedAt, gameDayStartMs('2026-11-10', ROLLOVER));
  assert.equal(feed.toMs, feed.fetchedAt);
  assert.equal(feed.fromMs, gameDayStartMs(addDays('2026-11-10', -150), ROLLOVER));
  assert.ok(feed.fetchedAt <= at(2026, 11, 10, 4, 0), 'never later than any instant of its day');

  assert.deepEqual(feed.accounts.map((account) => account.extId), ['demo-checking', 'demo-savings', 'demo-card']);
  for (const account of feed.accounts) {
    assert.deepEqual(Object.keys(account).sort(), ['asOf', 'available', 'balance', 'connId', 'currency', 'extId', 'institution', 'name', 'txs']);
    assert.equal(account.currency, 'USD');
    assert.equal(account.asOf, feed.fetchedAt);
    assert.ok(account.name && account.institution && account.connId);
    assert.ok(Number.isSafeInteger(account.balance) && Number.isSafeInteger(account.available), account.name + ' is in whole cents');
    assert.ok(account.txs.length > 0);
  }
});

test('demoFeed: a checking account, savings near empty and a card owing about $4,000', () => {
  for (const nowMs of [TUESDAY, at(2026, 12, 1, 13), at(2027, 6, 17)]) {
    const [checking, savings, card] = demoFeed(nowMs).accounts;
    assert.ok(checking.balance > 30000 && checking.balance < 700000, 'checking holds a few hundred to a few thousand dollars');
    assert.ok(checking.available <= checking.balance, 'pending purchases are held against it');
    assert.ok(savings.balance > 10000 && savings.balance < 40000, 'savings are near empty');
    assert.equal(savings.available, savings.balance);
    assert.ok(card.balance < -380000 && card.balance > -420000, 'a debt is reported as a negative balance');
    assert.ok(card.available > 0, 'what is left of the credit line');
  }
});

test('demoFeed: every row is identified once, dated inside the window and worth something', () => {
  const feed = demoFeed(TUESDAY);
  const firstDay = addDays('2026-11-10', -150);
  for (const account of feed.accounts) {
    const ids = new Set(account.txs.map((tx) => tx.extId));
    assert.equal(ids.size, account.txs.length, 'ids are unique within ' + account.name);
    for (const tx of account.txs) {
      assert.deepEqual(Object.keys(tx).sort(), ['amount', 'at', 'description', 'extId', 'mcc', 'memo', 'payee', 'pending', 'posted']);
      assert.ok(Number.isSafeInteger(tx.amount) && tx.amount !== 0, 'signed whole cents');
      assert.match(tx.description, /^[\x20-\x7e]{4,}$/, 'a plain statement line');
      assert.ok(tx.mcc === null || /^\d{4}$/.test(tx.mcc));
      const happened = feedDay(tx.at === null ? tx.posted : tx.at, ROLLOVER);
      assert.ok(happened >= firstDay && happened <= '2026-11-10', tx.description + ' on ' + happened);
      if (!tx.pending) assert.ok(feedDay(tx.posted, ROLLOVER) <= '2026-11-10', 'nothing posts in the future');
    }
  }
});

test('demoFeed: a purchase carries its time and posts the next day; a bill carries a date alone', () => {
  const [checking, , card] = demoFeed(TUESDAY).accounts;
  const timed = checking.txs.filter((tx) => tx.at !== null && !tx.pending);
  assert.ok(timed.length > 200);
  for (const tx of timed) {
    assert.ok(feedHasTime(tx.at) && !feedHasTime(tx.posted));
    assert.ok(tx.amount < 0, 'only purchases have a time of day');
    const lag = diffDays(feedDay(tx.at, ROLLOVER), feedDay(tx.posted, ROLLOVER));
    assert.ok(lag === 1 || lag === 2, tx.description + ' posts a day or two after it was made');
  }
  const rent = checking.txs.filter((tx) => /REALTY/.test(tx.description));
  assert.equal(rent.length, 5, 'rent on the first of each of five months');
  for (const tx of rent) {
    assert.equal(tx.at, null);
    assert.equal(parts(feedDay(tx.posted, ROLLOVER)).d, 1);
  }
  assert.ok(card.txs.some((tx) => tx.at !== null), 'delivery orders on the card are timed too');
});

test('demoFeed: what was bought today is pending, without a time, and nothing else is', () => {
  for (const [label, nowMs] of DAYS) {
    const today = gameDay(nowMs, ROLLOVER);
    const pending = demoFeed(nowMs).accounts.flatMap((account) => account.txs.filter((tx) => tx.pending));
    assert.equal(pending.length, 2, 'two pending rows on ' + label);
    for (const tx of pending) {
      assert.equal(tx.posted, null);
      assert.equal(feedDay(tx.at, ROLLOVER), today);
      assert.equal(feedHasTime(tx.at), false, 'no time of day: the feed is the same at every hour');
      assert.ok(tx.amount < 0);
    }
  }
});

test('demoFeed: the window follows the days option', () => {
  const firstDayOf = (feed) => gameDay(feed.fromMs, ROLLOVER);
  const today = '2026-11-10';
  assert.equal(firstDayOf(demoFeed(TUESDAY)), addDays(today, -150));
  assert.equal(firstDayOf(demoFeed(TUESDAY, { days: 30 })), addDays(today, -30));
  assert.equal(firstDayOf(demoFeed(TUESDAY, { days: 30.9 })), addDays(today, -30));
  assert.equal(firstDayOf(demoFeed(TUESDAY, { days: 0 })), addDays(today, -1), 'at least one day');
  assert.equal(firstDayOf(demoFeed(TUESDAY, { days: -5 })), addDays(today, -1));
  assert.equal(firstDayOf(demoFeed(TUESDAY, { days: 1e9 })), addDays(today, -1500), 'at most 1500 days');
  for (const days of [NaN, Infinity, '30', null, undefined]) {
    assert.equal(firstDayOf(demoFeed(TUESDAY, { days })), addDays(today, -150), 'days ' + String(days) + ' means the default');
  }
  const short = demoFeed(TUESDAY, { days: 30 });
  const long = demoFeed(TUESDAY, { days: 400 });
  assert.ok(short.accounts[0].txs.length < demoFeed(TUESDAY).accounts[0].txs.length);
  assert.ok(long.accounts[0].txs.length > 1200);
  const renewals = (feed) => feed.accounts[0].txs.filter((tx) => /Amazon Prime/.test(tx.description)).length;
  assert.equal(renewals(demoFeed(TUESDAY)), 1, 'a yearly renewal is charged once in 150 days');
  assert.equal(renewals(long), 2, 'and twice in 400');
});

test('demoFeed: odd arguments are read as defaults and never thrown on', () => {
  const fixed = demoFeed(NaN);
  assert.equal(gameDay(fixed.fetchedAt, ROLLOVER), gameDay(Date.UTC(1975, 0, 1), ROLLOVER), 'a time that is not one reads as a fixed day');
  for (const nowMs of [undefined, null, 'tomorrow', -1, 0, Infinity, -Infinity, 8.64e15, 1e21]) {
    assert.deepEqual(demoFeed(nowMs), fixed, 'nowMs ' + String(nowMs));
  }
  for (const opts of [null, 7, 'x', [], { seed: NaN }, { seed: '3' }, { seed: Infinity }]) {
    assert.deepEqual(demoFeed(TUESDAY, opts), demoFeed(TUESDAY), 'opts ' + JSON.stringify(opts));
  }
  assert.deepEqual(demoFeed(TUESDAY, { seed: 7.9 }), demoFeed(TUESDAY, { seed: 7 }), 'a seed is a whole number');
  for (const days of [1, 2, 13, 20, 22, 59, 80]) {
    const feed = demoFeed(TUESDAY, { days, seed: -3 });
    for (const account of feed.accounts) {
      assert.ok(Number.isSafeInteger(account.balance), days + ' days: ' + account.name);
      for (const tx of account.txs) assert.ok(Number.isSafeInteger(tx.amount) && tx.amount !== 0);
    }
  }
});

test('demoFeed: the default feed alone holds the same Book, less the yearly renewal', () => {
  // The plain pipeline, as a first sync would run it: the match then starts today.
  const state = defaultState(TUESDAY);
  state.accounts.push(...demoManualAccounts(TUESDAY));
  const summary = mergeFeed(state, demoFeed(TUESDAY), TUESDAY);
  const report = refresh(state, TUESDAY);
  assert.equal(summary.accountsAdded, 3);
  assert.ok(summary.added > 600 && summary.paired >= 6);
  assert.equal(report.matchStarted, true);
  assert.equal(state.meta.matchStart, '2026-11-10');
  const cadences = state.recurring.filter((entry) => entry.active).map((entry) => entry.cadence);
  assert.equal(cadences.length, 12);
  assert.ok(cadences.every((cadence) => cadence === 'monthly'), 'one charge of a yearly renewal cannot be told from a purchase');
  assert.deepEqual(state.streams.filter((stream) => stream.accrue).map((stream) => stream.cadence), ['biweekly']);
});

/* --------------------------------------------------- what the bank cannot see */

test('demoManualAccounts: equipment worth $18,000 and the loan on it, entered the day the match began', () => {
  const accounts = demoManualAccounts(TUESDAY);
  assert.equal(accounts.length, 2);
  const entered = addDays('2026-11-10', -DEMO_MATCH_DAYS);
  const [equipment, loan] = accounts;

  assert.equal(equipment.type, 'equipment');
  assert.equal(equipment.balance, 1800000);
  assert.equal(equipment.quickSale, 0.5);
  assert.equal(equipment.basis, 'estimate');
  assert.deepEqual(equipment.history.map((entry) => [entry.day, entry.balance]), [[entered, 1800000]]);

  assert.equal(loan.type, 'loan');
  assert.equal(loan.balance, -950000, 'a debt is negative');
  assert.equal(loan.apr, 6.5);
  assert.equal(loan.dueDay, 5);
  assert.deepEqual(loan.loan, { payment: 24000, assumeScheduled: true });
  assert.deepEqual(loan.history.map((entry) => [entry.day, entry.balance]), [[entered, -950000]]);

  for (const account of accounts) {
    assert.equal(account.source, 'manual');
    assert.equal(account.ext, null);
    assert.equal(account.hidden, false);
    assert.equal(gameDay(account.asOf, ROLLOVER), entered);
    assert.equal(typeof account.history[0].note, 'string');
    assert.match(account.id, /^acc_[a-z0-9]{8,}$/);
  }
  assert.deepEqual(demoManualAccounts(at(2026, 11, 11, 2, 0)), accounts, 'the same for every instant of the game day');
  assert.doesNotThrow(() => demoManualAccounts(NaN));
});

/* -------------------------------------------------------------- the document */

test('buildDemoState: the same day and seed give the same document, ids included', () => {
  const state = documentAt(TUESDAY);
  assert.deepEqual(buildDemoState(TUESDAY), state);
  assert.deepEqual(buildDemoState(at(2026, 11, 10, 4, 0)), state, 'from the rollover…');
  assert.deepEqual(buildDemoState(at(2026, 11, 11, 3, 59)), state, '…to just before the next one');
  assert.deepEqual(buildDemoState(TUESDAY, { seed: 1 }), state);

  const other = buildDemoState(TUESDAY, { seed: 2 });
  assert.notDeepEqual(other, state);
  assert.notEqual(other.txs[40].id, state.txs[40].id, 'another seed draws other ids');
  assert.notDeepEqual(documentAt(at(2026, 11, 11, 4, 5)), state, 'another day is another document');
});

test('buildDemoState: ids look like any others, are unique, and every reference leads somewhere', () => {
  onEveryDay(({ state }) => {
    const ids = [...state.accounts, ...state.txs, ...state.recurring, ...state.streams].map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const [list, prefix] of [[state.accounts, 'acc'], [state.txs, 'tx'], [state.recurring, 'rec'], [state.streams, 'str']]) {
      for (const item of list) assert.match(item.id, new RegExp('^' + prefix + '_[a-z0-9]{8,}$'));
    }
    const known = new Set(ids);
    const refers = (id, what) => assert.ok(id === null || known.has(id), what + ' ' + id + ' exists');
    for (const tx of state.txs) {
      assert.ok(known.has(tx.accountId) || tx.kind === 'decline', 'every move the bank sent is on an account');
      for (const field of ['recurringId', 'streamId', 'pairId', 'matchId']) refers(tx[field], field);
      if (tx.fp) assert.ok(tx.fp.startsWith(tx.accountId + '|'), 'a fingerprint begins with the account');
    }
    for (const entry of state.recurring) {
      refers(entry.accountId, 'accountId');
      refers(entry.toAccountId, 'toAccountId');
    }
    for (const stream of state.streams) refers(stream.accountId, 'accountId');
    for (const sweep of state.sweeps) assert.ok(known.has(sweep.txId));
  });
});

test('buildDemoState: a valid document that says it is the sample game', () => {
  onEveryDay(({ state, today, nowMs }) => {
    assert.equal(checkDoc(state), null);
    assert.deepEqual(migrate(structuredClone(state)), state, 'already in the current shape');
    assert.equal(state.meta.origin, 'demo');
    assert.equal(state.meta.matchStart, addDays(today, -DEMO_MATCH_DAYS));
    assert.deepEqual(state.settings.rules, []);
    assert.equal(state.sync.src, 'demo');
    assert.equal(state.sync.status, 'ok');
    assert.equal(state.sync.error, null);
    assert.deepEqual(state.sync.problems, []);
    assert.deepEqual(state.sync.requests, []);
    assert.equal(state.sync.lastOk, gameDayStartMs(today, ROLLOVER));
    assert.ok(state.sync.lastOk <= nowMs && nowMs - state.sync.lastOk < 24 * 3600000, 'synced today');
    assert.equal(state.sync.from, addDays(today, -DEMO_HISTORY_DAYS));
    assert.equal(makeLedger(state, nowMs).position().freshness, 'fresh');
  });
});

test('buildDemoState: three linked accounts and the two things the bank cannot see', () => {
  onEveryDay(({ state, ledger, today }) => {
    assert.deepEqual(state.accounts.map((account) => [account.source, account.type]), [
      ['manual', 'equipment'], ['manual', 'loan'], ['bank', 'checking'], ['bank', 'savings'], ['bank', 'credit_card'],
    ]);
    for (const account of state.accounts.filter((a) => a.source === 'bank')) {
      assert.equal(account.ext.src, 'demo');
      assert.equal(account.basis, 'bank');
      assert.equal(account.flip, false);
      assert.equal(gameDay(account.asOf, ROLLOVER), today);
    }
    const card = accountOfType(state, 'credit_card');
    assert.ok(card.balance < 0 && card.apr > 0 && card.limit > -card.balance, 'the card owes, at a rate, inside its limit');
    assert.ok(accountOfType(state, 'checking').everyday && card.everyday);
    assert.ok(accountOfType(state, 'savings').reserve);
    const position = ledger.position();
    assert.ok(position.cash > 0 && position.cards < 0 && position.loans < 0 && position.slowAssets === 1800000);
  });
});

test('buildDemoState: every row the bank sent was read as what it is', () => {
  onEveryDay(({ state }) => {
    assert.ok(state.txs.length > 1500);
    for (const tx of state.txs) {
      assert.ok(Object.hasOwn(TX_KINDS, tx.kind));
      assert.notEqual(tx.category, 'other', tx.raw + ' was recognised');
      assert.ok(tx.merchant && tx.mkey, tx.raw + ' has a merchant');
      assert.equal(tx.source, tx.kind === 'decline' ? 'manual' : 'demo');
      assert.ok(Number.isSafeInteger(tx.amount) && tx.amount > 0);
    }
    const kinds = new Set(state.txs.map((tx) => tx.kind));
    assert.deepEqual([...kinds].sort(), ['decline', 'income', 'payment', 'refund', 'spend', 'transfer']);
    const categories = new Set(state.txs.map((tx) => tx.category));
    for (const category of ['cafe', 'eating_out', 'convenience', 'delivery', 'groceries', 'transit', 'shopping', 'gear', 'fees_interest', 'housing', 'utilities']) {
      assert.ok(categories.has(category), category + ' appears');
    }
  });
});

test('buildDemoState: transfers and card payments are paired, leg for leg, on the same day', () => {
  onEveryDay(({ state }) => {
    const byId = new Map(state.txs.map((tx) => [tx.id, tx]));
    const moves = state.txs.filter((tx) => tx.kind === 'transfer' || tx.kind === 'payment');
    assert.ok(moves.length >= 30);
    for (const tx of moves) {
      const other = byId.get(tx.pairId);
      assert.ok(other, tx.raw + ' has its other leg');
      assert.equal(other.pairId, tx.id);
      assert.equal(other.amount, tx.amount);
      assert.equal(other.day, tx.day);
      assert.notEqual(other.flow, tx.flow);
      assert.notEqual(other.accountId, tx.accountId);
      assert.equal(other.kind, tx.kind);
    }
    assert.ok(moves.some((tx) => tx.kind === 'transfer'), 'savings were drawn on');
    assert.ok(state.txs.every((tx) => tx.pairId === null || tx.kind === 'transfer' || tx.kind === 'payment'));
  });
});

test('buildDemoState: a salary every two weeks, counted as it is earned', () => {
  onEveryDay(({ state, ledger, today }) => {
    const accruing = state.streams.filter((stream) => stream.accrue);
    assert.equal(accruing.length, 1);
    const [salary] = accruing;
    assert.equal(salary.kind, 'salary');
    assert.equal(salary.cadence, 'biweekly');
    assert.equal(salary.source, 'detected');
    assert.equal(salary.active, true);
    assert.ok(Math.abs(salary.amount - 190000) < 5000, 'about $1,900 net');
    assert.equal(dow(salary.anchor), 5, 'paid on a Friday');
    assert.equal(salary.accountId, accountOfType(state, 'checking').id);
    const deposits = state.txs.filter((tx) => tx.streamId === salary.id);
    assert.ok(deposits.length >= 27 && deposits.every((tx) => tx.kind === 'income' && tx.flow === 'in'));

    const position = ledger.position();
    assert.equal(position.smoothing, true);
    assert.deepEqual(position.receivables.map((line) => line.id), [salary.id]);
    assert.ok(position.receivable > 0, 'pay earned since ' + salary.anchor);
    assert.ok(position.receivable <= salary.amount * 1.01);
    assert.ok(position.rate > 0, 'the number ticks up');
    assert.ok(ledger.clock().nextPayday > today || ledger.clock().nextPayday === today);
  });
});

test('buildDemoState: client deposits stay occasional', () => {
  onEveryDay(({ state }) => {
    const lessons = state.streams.filter((stream) => stream.kind === 'lessons');
    assert.equal(lessons.length, 2);
    for (const stream of lessons) {
      assert.equal(stream.accrue, false);
      assert.equal(stream.cadence, null, 'no schedule');
      assert.ok(state.txs.filter((tx) => tx.streamId === stream.id).length >= 2);
    }
    const loose = state.txs.filter((tx) => tx.kind === 'income' && tx.streamId === null);
    assert.equal(loose.length, 1, 'one payer was seen once and is no stream');
  });
});

test('buildDemoState: the Book holds the bills, one of them variable and one annual', () => {
  onEveryDay(({ state, today }) => {
    const book = state.recurring;
    assert.ok(book.length >= 8, 'at least eight entries');
    assert.ok(book.every((entry) => entry.active && entry.source === 'detected' && entry.locks.length === 0));
    assert.ok(book.every((entry) => entry.confidence > 0.5 && entry.amount > 0));
    const named = (mkey) => {
      const found = book.filter((entry) => entry.mkey === mkey);
      assert.equal(found.length, 1, 'one entry for ' + mkey);
      return found[0];
    };
    assert.deepEqual(book.map((entry) => entry.mkey).sort(), [
      'alderline equip finance loan pymt', 'amazon prime', 'apple services', 'con edison', 'foundry row workspace rent',
      'interest charge', 'kestrel realty llc rent', 'lemonade insurance', 'netflix', 'scheduled transfer to northlight visa',
      'spectrum', 'spotify', 'verizon wireless',
    ]);

    const power = named('con edison');
    assert.equal(power.variable, true);
    assert.equal(power.cadence, 'monthly');
    assert.equal(power.essential, true);
    const powerBills = state.txs.filter((tx) => tx.recurringId === power.id).map((tx) => tx.amount);
    assert.ok(new Set(powerBills).size === powerBills.length && powerBills.length >= 12, 'a different amount every month');

    const yearly = named('amazon prime');
    assert.equal(yearly.cadence, 'annual');
    assert.equal(yearly.variable, false);
    const renewals = state.txs.filter((tx) => tx.recurringId === yearly.id).map((tx) => tx.day).sort();
    assert.equal(renewals.length, 2);
    assert.ok([365, 366].includes(diffDays(renewals[0], renewals[1])), 'a year apart');
    assert.equal(yearly.anchor, renewals[1]);
    assert.ok(yearly.anchor > state.meta.matchStart && yearly.anchor < today, 'renewed during the match');

    for (const mkey of ['kestrel realty llc rent', 'foundry row workspace rent']) assert.equal(named(mkey).category, 'housing');
    assert.equal(named('verizon wireless').category, 'phone_internet');
    const loanEntry = named('alderline equip finance loan pymt');
    assert.equal(loanEntry.category, 'debt_service');
    assert.equal(loanEntry.toAccountId, accountOfType(state, 'loan').id, 'the loan payment pays down the loan');
    assert.equal(named('scheduled transfer to northlight visa').toAccountId, accountOfType(state, 'credit_card').id);

    for (const entry of book) {
      const charges = state.txs.filter((tx) => tx.recurringId === entry.id);
      assert.ok(charges.length >= 2, entry.name + ' has charges');
      assert.ok(charges.every((tx) => tx.klass === 'book' || tx.kind === 'payment'));
      assert.ok(charges.every((tx) => tx.klass !== 'game'), 'a stop in the daily game is never a bill');
    }
    assert.ok(state.txs.filter((tx) => tx.klass === 'game').every((tx) => tx.recurringId === null));
  });
});

test('buildDemoState: a subscription whose price went up with its latest charge', () => {
  onEveryDay(({ state }) => {
    const netflix = state.recurring.find((entry) => entry.mkey === 'netflix');
    const charges = state.txs.filter((tx) => tx.recurringId === netflix.id).sort((a, b) => (a.day < b.day ? -1 : 1));
    const latest = charges.pop();
    assert.ok(charges.every((tx) => tx.amount === charges[0].amount));
    assert.ok(latest.amount > charges[0].amount);
    assert.equal(netflix.anchor, latest.day);
  });
});

test('buildDemoState: the loan is amortised from the payments the feed shows', () => {
  onEveryDay(({ state, ledger, today }) => {
    const loan = accountOfType(state, 'loan');
    const entered = loan.history[0].day;
    assert.equal(entered, state.meta.matchStart);
    assert.equal(ledger.accountValueOn(loan.id, entered), -950000);
    const paidSince = state.txs.filter((tx) => /LOAN PYMT/.test(tx.raw) && tx.day > entered);
    const now = ledger.accountValueOn(loan.id, today);
    if (paidSince.length) {
      assert.ok(now > -950000 && now < -950000 + 24000 * paidSince.length, 'a payment took off its principal, not its interest');
    } else {
      assert.equal(now, -950000, 'no payment since it was entered');
    }
    assert.equal(ledger.accountValueOn(accountOfType(state, 'equipment').id, today), 1800000);
  });
});

/* ------------------------------------------------------------------ the match */

test('buildDemoState: the match began three weeks ago against a back-tested habit', () => {
  onEveryDay(({ state, today }) => {
    assert.equal(DEMO_MATCH_DAYS, 21);
    assert.equal(state.habits.length, 1);
    const [habit] = state.habits;
    assert.equal(habit.from, addDays(today, -21));
    assert.equal(habit.basis, 'computed');
    assert.deepEqual([habit.window.from, habit.window.to], [addDays(habit.from, -60), addDays(habit.from, -1)]);
    assert.equal(habit.window.workDays + habit.window.offDays, 60);
    assert.equal(habit.backtest.rounds, 60);
    assert.ok(habit.backtest.score > 12 && habit.backtest.score < 36, 'an opponent that can be beaten and is not already');
    for (const [spend, win] of [[habit.work, habit.winWork], [habit.off, habit.winOff]]) {
      assert.ok(spend > 1000 && spend < 4500, 'ten to forty-five dollars a day of convenience spending');
      assert.equal(win % 100, 0, 'the win line is in whole dollars');
      assert.ok(win >= spend * 0.25 && win <= spend * 0.75);
    }
  });
});

test('buildDemoState: three weeks of rounds, in ink except yesterday', () => {
  onEveryDay(({ ledger, today, state }) => {
    const rounds = matchRounds(ledger);
    assert.equal(rounds.length, 21);
    assert.deepEqual(rounds.map((round) => round.status), [...Array(20).fill('final'), 'provisional']);
    assert.ok(rounds.every((round) => round.result !== null && round.habit > 0));
    const live = ledger.round(today);
    assert.equal(live.status, 'live');
    assert.equal(live.result, null);
    assert.ok(live.conv > 0 && live.conv <= live.winLine, 'one small stop so far today');
    assert.equal(ledger.round(addDays(today, -22)).status, 'prematch');
    assert.equal(ledger.round(addDays(today, 1)).status, 'future');
    assert.equal(Object.keys(state.days).every((day) => day >= state.meta.matchStart && day < today), true);
  });
});

test('buildDemoState: wins, draws, losses and clean sheets, the same story on any day', () => {
  onEveryDay(({ ledger }) => {
    const results = matchRounds(ledger).map((round) => round.result);
    const count = (value) => results.filter((result) => result === value).length;
    assert.ok(count(1) >= 9, 'wins');
    assert.ok(count(0.5) >= 4, 'draws');
    assert.ok(count(0) >= 2, 'losses');
    assert.ok(count(1) + count(0.5) / 2 > 21 / 2, 'the match is being won');
    assert.ok(matchRounds(ledger).filter((round) => round.clean).length >= 5, 'clean sheets');

    // Last week and the week before are always inside the match: Monday to Sunday.
    assert.deepEqual(weekRounds(ledger, 1).map((round) => round.result), [1, 0.5, 1, 0, 1, 0.5, 1]);
    assert.deepEqual(weekRounds(ledger, 1).map((round) => round.clean), [true, false, false, false, true, false, true]);
    assert.deepEqual(weekRounds(ledger, 2).map((round) => round.result), [0.5, 1, 1, 0.5, 0, 1, 1]);
    assert.deepEqual(weekRounds(ledger, 2).map((round) => round.clean), [false, false, true, false, false, true, false]);
  });
});

test('buildDemoState: a result never hangs on where a line falls', () => {
  onEveryDay(({ ledger }) => {
    for (const round of matchRounds(ledger)) {
      if (round.bye) continue;
      if (round.result === 1) assert.ok(round.conv <= round.habit / 4, round.day + ': a win is a clean sheet or one small stop');
      if (round.result === 0.5) assert.ok(round.conv > round.habit * 0.75 && round.conv <= round.habit, round.day + ': a draw sits just under habit');
      if (round.result === 0) assert.ok(round.conv > round.habit + 100, round.day + ': a loss is well over habit');
    }
  });
});

test('buildDemoState: one day holds three stops', () => {
  onEveryDay(({ ledger, state }) => {
    const stacked = matchRounds(ledger).filter((round) => round.stops >= 3);
    assert.equal(stacked.length, 1);
    const [round] = stacked;
    assert.equal(round.day, addDays(weekStart(ledger.today), -4), 'Thursday of last week');
    assert.equal(round.stops, 3);
    assert.equal(round.plan, null);
    assert.equal(round.result, 0);
    const stops = gameStops(round);
    assert.equal(stops.length, 3);
    assert.ok(stops[0].at < stops[1].at && stops[1].at < stops[2].at, 'morning, midday, afternoon');
    const glyphs = glyphsOf(round, state);
    assert.deepEqual(stops.map((tx) => glyphs.moves[round.moves.indexOf(tx)]), [null, '?!', '?']);
  });
});

test('buildDemoState: a bye for a dinner out — half a point, and its dollars still count', () => {
  onEveryDay(({ ledger, state }) => {
    const byes = matchRounds(ledger).filter((round) => round.bye);
    assert.equal(byes.length, 1);
    const [round] = byes;
    assert.equal(round.day, addDays(weekStart(ledger.today), -2), 'Saturday of last week');
    assert.equal(round.result, 0.5);
    assert.ok(round.conv > round.lossLine, 'it would have been a loss');
    assert.ok(round.kept < 0);
    assert.equal(state.days[round.day].bye, true);
    assert.ok(state.days[round.day].note.length > 0);
    assert.equal(Object.values(state.days).filter((record) => record.bye).length, 1);
    assert.ok(state.settings.byesPerMonth >= 1);
  });
});

test('buildDemoState: morning plans — kept, kept to the letter, and once not', () => {
  onEveryDay(({ ledger, state }) => {
    const planned = matchRounds(ledger).filter((round) => round.plan !== null);
    assert.ok(planned.length >= 4);
    for (const round of planned) {
      assert.equal(round.type, 'work', 'plans are made on workdays');
      const record = state.days[round.day].plan;
      assert.equal(gameDay(record.at, ROLLOVER), round.day, 'made that morning');
      assert.equal(new Date(record.at).getHours(), 7);
      assert.equal(record.ready[0].yes, true);
      assert.ok(record.stops === 0 || record.stops === 1);
    }
    const [lastMonday, , lastWednesday] = weekRounds(ledger, 1);
    assert.deepEqual([lastMonday.plan.stops, lastMonday.stops, glyphsOf(lastMonday, state).round], [0, 0, '!!'], 'a clean-sheet workday');
    assert.deepEqual([lastWednesday.plan.stops, lastWednesday.stops, glyphsOf(lastWednesday, state).round], [1, 1, '!'], 'played to the plan');
    assert.deepEqual(glyphsOf(lastWednesday, state).moves.filter(Boolean), [], 'the planned stop prints bare');

    const [, , , thursdayBefore] = weekRounds(ledger, 2);
    assert.deepEqual([thursdayBefore.plan.stops, thursdayBefore.stops], [1, 2]);
    const glyphs = glyphsOf(thursdayBefore, state);
    assert.equal(glyphs.round, null);
    assert.deepEqual(gameStops(thursdayBefore).map((tx) => glyphs.moves[thursdayBefore.moves.indexOf(tx)]), [null, '?!'], 'the second stop was not in the plan');
  });
});

test('buildDemoState: one purchase declined yesterday', () => {
  onEveryDay(({ ledger, state, today }) => {
    const declines = state.txs.filter((tx) => tx.kind === 'decline');
    assert.equal(declines.length, 1);
    const [decline] = declines;
    const yesterday = addDays(today, -1);
    assert.equal(decline.day, yesterday);
    assert.equal(decline.source, 'manual');
    assert.equal(decline.category, 'cafe');
    assert.equal(decline.accountId, null);
    assert.ok(decline.amount > 0);
    assert.ok(state.settings.insteads.includes(decline.instead));
    assert.equal(gameDay(decline.at, ROLLOVER), yesterday);
    assert.equal(isLive(decline), false);
    assert.equal(txEffect(decline), 0);

    const round = ledger.round(yesterday);
    assert.ok(round.moves.includes(decline), 'it is on the scoresheet');
    assert.equal(glyphsOf(round, state).moves[round.moves.indexOf(decline)], '!');
    const spent = round.moves.filter((tx) => tx.kind === 'spend' && tx.klass === 'game').reduce((total, tx) => total + tx.amount, 0);
    assert.equal(round.conv, spent, 'and costs nothing');
  });
});

test('buildDemoState: the three weeks were played better than the habit', () => {
  onEveryDay(({ ledger, state }) => {
    const rounds = matchRounds(ledger);
    const edge = ledger.edge();
    assert.ok(edge.kept > 5000, 'kept ' + edge.kept);
    assert.equal(edge.kept, rounds.reduce((total, round) => total + round.kept, 0));
    assert.ok(edge.verified > 0 && edge.verified <= edge.kept + 5000);
    assert.equal(edge.form.length, 7);
    assert.ok(edge.bestUnbeaten >= 4);

    const [habit] = state.habits;
    const before = [];
    for (let ago = 60; ago >= 1; ago--) before.push(ledger.convOn(addDays(habit.from, -ago)));
    const mean = (list) => list.reduce((total, cents) => total + cents, 0) / list.length;
    assert.ok(mean(rounds.map((round) => round.conv)) < 0.8 * mean(before), 'convenience spending is down by a fifth or more');
    assert.ok(before.filter((cents) => cents === 0).length < rounds.filter((round) => round.clean).length * 3, 'clean sheets are more frequent than before');
  });
});

test('buildDemoState: one kept week was moved to the card by itself; last week is still open', () => {
  onEveryDay(({ ledger, state, today }) => {
    const thisMonday = weekStart(today);
    assert.equal(state.sweeps.length, 1);
    const [sweep] = state.sweeps;
    assert.equal(sweep.weekOf, addDays(thisMonday, -14));
    assert.equal(sweep.via, 'auto');
    assert.equal(sweep.amount % 100, 0);
    assert.ok(sweep.amount >= 500);
    assert.equal(sweep.amount, Math.floor(weekRounds(ledger, 2).reduce((total, round) => total + round.kept, 0) / 100) * 100);

    const payment = state.txs.find((tx) => tx.id === sweep.txId);
    assert.equal(payment.kind, 'payment');
    assert.equal(payment.flow, 'out');
    assert.equal(payment.accountId, accountOfType(state, 'checking').id);
    assert.equal(payment.amount, sweep.amount, 'moved to the dollar');
    assert.equal(payment.recurringId, null, 'not the monthly payment in the Book');
    assert.equal(payment.day, sweep.day);
    assert.equal(sweep.day, addDays(thisMonday, -6), 'on the Tuesday after that week');
    const landed = state.txs.find((tx) => tx.id === payment.pairId);
    assert.equal(landed.accountId, accountOfType(state, 'credit_card').id);
    const round = ledger.round(payment.day);
    assert.equal(glyphsOf(round, state).moves[round.moves.indexOf(payment)], '!');

    const edge = ledger.edge();
    assert.equal(edge.moved, sweep.amount);
    assert.equal(edge.unmoved, edge.kept - edge.moved);
    assert.ok(edge.unmoved > 0);
    assert.ok(edge.sweep, 'a sweep is offered');
    assert.equal(edge.sweep.weekOf, addDays(thisMonday, -7));
    assert.equal(edge.sweep.target, 'card');
    assert.equal(edge.sweep.amount, Math.floor(weekRounds(ledger, 1).reduce((total, round) => total + round.kept, 0) / 100) * 100);
    assert.ok(edge.sweep.amount >= 500);
  });
});

/* ------------------------------------------------------------------- the card */

test('buildDemoState: card months that rose and months that fell, with interest in every one', () => {
  onEveryDay(({ state, nowMs }) => {
    const card = accountOfType(state, 'credit_card');
    const months = cardMonths(state, card.id, 7, nowMs);
    assert.equal(months.length, 7);
    assert.equal(months[6].current, true);
    const complete = months.slice(0, 6);
    assert.ok(complete.every((row) => row.complete && !row.current));
    assert.ok(complete.some((row) => row.change > 5000), 'a month that rose');
    assert.ok(complete.some((row) => row.change < -5000), 'a month that fell');
    assert.ok(complete.slice(-3).some((row) => row.change > 0) && complete.slice(-3).some((row) => row.change < 0), 'both among the last three');
    for (const row of complete) {
      assert.ok(row.interest > 5000 && row.interest < 15000, row.ym + ' interest ' + row.interest);
      assert.equal(row.payments >= 46000, true, 'a payment every month');
      assert.ok(row.start > 300000 && row.end < 500000, 'carrying roughly $4,000');
    }
    const interest = state.txs.filter((tx) => tx.mkey === 'interest charge');
    assert.ok(interest.length >= 13);
    assert.ok(interest.every((tx) => tx.glyph === null && tx.category === 'fees_interest'), 'interest is a bare line');
  });
});

test('buildDemoState: one late fee, before the match, for a payment a day late', () => {
  onEveryDay(({ state, ledger }) => {
    const penalties = state.txs.filter((tx) => tx.glyph === '??');
    assert.equal(penalties.length, 1);
    const [fee] = penalties;
    assert.equal(fee.mkey, 'late fee');
    assert.equal(fee.category, 'fees_interest');
    assert.equal(fee.accountId, accountOfType(state, 'credit_card').id);
    assert.equal(fee.amount, 2900);
    assert.ok(fee.day < state.meta.matchStart && diffDays(fee.day, ledger.today) < 60);
    assert.equal(fee.recurringId, null);

    const payments = state.txs.filter((tx) => tx.mkey === 'scheduled transfer to northlight visa');
    const lateOnes = payments.filter((tx) => parts(tx.day).d !== 14);
    assert.deepEqual(lateOnes.map((tx) => tx.day), [addDays(fee.day, -1)], 'every payment on the 14th but one, the day before the fee');
    const round = ledger.round(fee.day);
    assert.equal(glyphsOf(round, state).moves[round.moves.indexOf(fee)], '??');
  });
});

/* ------------------------------------------------------------ the last details */

test('buildDemoState: pending rows on the last day and nowhere else', () => {
  onEveryDay(({ state, ledger, today }) => {
    const pending = state.txs.filter((tx) => tx.pending);
    assert.equal(pending.length, 2);
    for (const tx of pending) {
      assert.equal(tx.day, today);
      assert.equal(tx.postedDay, null);
      assert.equal(tx.at, null);
      assert.equal(tx.accountId, accountOfType(state, 'checking').id);
    }
    assert.ok(state.txs.every((tx) => tx.pending || tx.kind === 'decline' || tx.postedDay !== null));
    const checking = accountOfType(state, 'checking');
    const held = pending.reduce((total, tx) => total + tx.amount, 0);
    assert.equal(ledger.accountValueOn(checking.id, today), checking.balance - held, 'counted in the balance now');
    assert.equal(checking.available, checking.balance - held);
  });
});

test('buildDemoState: a monthly target for cafes, with spending to hold against it', () => {
  onEveryDay(({ state, ledger, today }) => {
    assert.deepEqual(Object.keys(state.settings.targets), ['cafe']);
    assert.ok(state.settings.targets.cafe >= 5000);
    const lastMonth = monthOf(addDays(monthOf(today) + '-01', -1));
    const spent = ledger.spendingByCategory(lastMonth + '-01', endOfMonth(lastMonth)).find((row) => row.category === 'cafe');
    assert.ok(spent && spent.amount > 2000, 'cafes last month');
  });
});

test('buildDemoState: a purchase after midnight belongs to the evening before', () => {
  onEveryDay(({ state }) => {
    const lateNight = state.txs.filter((tx) => tx.at !== null && new Date(tx.at).getHours() < ROLLOVER);
    assert.ok(lateNight.length >= 3);
    for (const tx of lateNight) {
      const calendar = new Date(tx.at);
      const calendarDay = [calendar.getFullYear(), String(calendar.getMonth() + 1).padStart(2, '0'), String(calendar.getDate()).padStart(2, '0')].join('-');
      assert.equal(tx.day, addDays(calendarDay, -1));
      assert.equal(tx.klass, 'game');
    }
  });
});

test('buildDemoState: no errand passes for a bill', () => {
  // Thirty consecutive days and three seeds: the Book never holds more than what was meant for it.
  for (const seed of [1, 2, 3]) {
    for (let offset = 0; offset < 30; offset += 3) {
      const state = buildDemoState(at(2027, 2, 1 + offset, 12), { seed });
      assert.equal(state.recurring.length, 13, 'seed ' + seed + ', day ' + offset + ': ' + state.recurring.map((entry) => entry.name).join(', '));
      assert.equal(state.streams.length, 4);
      assert.equal(state.sweeps.length, 1);
    }
  }
});

test('buildDemoState: a time that is not one gives the sample for a fixed day', () => {
  const fixed = buildDemoState(NaN);
  assert.equal(checkDoc(fixed), null);
  assert.equal(fixed.recurring.length, 13);
  assert.equal(fixed.habits.length, 1);
  for (const nowMs of [undefined, null, 'x', 0, -5, Infinity, 1e21]) assert.deepEqual(buildDemoState(nowMs), fixed, 'nowMs ' + String(nowMs));
  for (const opts of [null, 3, 'seed', { seed: NaN }, { seed: 'two' }]) assert.deepEqual(buildDemoState(TUESDAY, opts), documentAt(TUESDAY), 'opts ' + JSON.stringify(opts));
});
