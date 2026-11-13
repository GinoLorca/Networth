/**
 * The whole pipeline, end to end: the sample feed is merged, detected and read by every model
 * module, and the things that must be true of any document are checked at several instants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_HISTORY_DAYS, DEMO_MATCH_DAYS, buildDemoState, demoFeed } from '../js/model/demo.js';
import { ACCOUNT_TYPES, checkDoc, txEffect } from '../js/model/schema.js';
import { addDays, addMonths, addMonthsYm, daysInMonth, diffDays, dow, endOfMonth, gameDayStartMs, monthOf, parts } from '../js/model/dates.js';
import { mergeFeed } from '../js/model/merge.js';
import { computeHabit, refresh } from '../js/model/detect.js';
import { makeLedger } from '../js/model/ledger.js';
import { ALL_CARDS, allCardsMonths, cardMonths, cardsNow, largestCharges } from '../js/model/cards.js';
import { bookTotals, nextOccurrence, renewals, upcoming } from '../js/model/book.js';
import { annotateRound, previewMove, reviewRounds } from '../js/model/annotate.js';
import { SYMBOLS, SYMBOL_LABELS, assess, coachNotes, monthReview } from '../js/model/assess.js';
import { cardPayoff, incomeLadder, pace, projectNetWorth, purchaseImpact, reserveGoal } from '../js/model/forecast.js';
import { topMerchants } from '../js/model/classify.js';
import { addByHand, byHandMonth, editByHand, payeeKey, tickByHand } from '../js/model/byhand.js';

/* ------------------------------------------------------------------ fixtures */

const ROLLOVER = 4;
const HOUR_MS = 3600000;

/** A local instant, built from its parts so that no test depends on the machine's time zone. */
function at(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/** The instants every invariant is checked at: [label, nowMs, the game day it must fall on]. */
const INSTANTS = [
  ['in the morning', at(2026, 11, 10, 9, 15), '2026-11-10'],
  ['in the evening', at(2026, 11, 10, 21, 40), '2026-11-10'],
  ['just after the 4 a.m. rollover', at(2026, 11, 11, 4, 5), '2026-11-11'],
  ['on the first day of a month', at(2026, 12, 1, 13, 0), '2026-12-01'],
  ['after midnight, before the rollover', at(2026, 11, 15, 3, 30), '2026-11-14'],
  ['on a payday', at(2026, 11, 20, 10, 0), '2026-11-20'],
];

const documents = new Map();

/** The sample document of an instant, built once. A test that changes the document takes a copy. */
function sceneAt(nowMs) {
  if (!documents.has(nowMs)) {
    const state = buildDemoState(nowMs);
    const ledger = makeLedger(state, nowMs);
    documents.set(nowMs, { nowMs, state, ledger, today: ledger.today, firstDay: state.sync.from });
  }
  return documents.get(nowMs);
}

/** Register one invariant at every instant. */
function everywhere(title, check) {
  for (const [label, nowMs] of INSTANTS) test(title + ' — ' + label, () => check(sceneAt(nowMs)));
}

function sum(list, pick = (x) => x) {
  return list.reduce((total, item) => total + pick(item), 0);
}

function eachDayFrom(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

function accountOfType(state, type) {
  return state.accounts.find((account) => account.type === type);
}

function withSettings(state, changes) {
  return { ...state, settings: { ...state.settings, ...changes } };
}

/** A sentence a person can be shown: nothing that leaked out of a calculation. */
function assertSentence(text, what) {
  assert.equal(typeof text, 'string', what);
  assert.ok(text.length > 0 && text.trim() === text, what + ': "' + text + '"');
  assert.doesNotMatch(text, /NaN|undefined|null|Infinity|\[object|function/, what);
}

/** Every number anywhere inside a value is finite and every string is presentable. */
function assertClean(value, path) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), path + ' is ' + value);
  else if (typeof value === 'string') assert.doesNotMatch(value, /NaN|undefined|Infinity|\[object/, path);
  else if (Array.isArray(value)) value.forEach((item, i) => assertClean(item, path + '[' + i + ']'));
  else if (value && typeof value === 'object') for (const key of Object.keys(value)) assertClean(value[key], path + '.' + key);
  else assert.notEqual(value, undefined, path + ' is undefined');
}

/* ------------------------------------------------------------- the instants */

test('the instants fall on the game days they were chosen for', () => {
  for (const [label, nowMs, day] of INSTANTS) {
    const scene = sceneAt(nowMs);
    assert.equal(scene.today, day, label);
    assert.equal(scene.state.meta.matchStart, addDays(day, -DEMO_MATCH_DAYS));
    assert.equal(scene.firstDay, addDays(day, -DEMO_HISTORY_DAYS));
    assert.equal(checkDoc(scene.state), null);
  }
  const morning = sceneAt(INSTANTS[0][1]);
  const evening = sceneAt(INSTANTS[1][1]);
  assert.deepEqual(evening.state, morning.state, 'one game day, one document: only the clock differs');
});

/* ------------------------------------------------------------------ position */

everywhere('net worth at the bank is the sum of the balances', ({ state, ledger, today }) => {
  const position = ledger.position();
  const values = new Map(state.accounts.map((account) => [account.id, ledger.accountValueOn(account.id, today)]));
  assert.equal(position.bank, sum([...values.values()]));
  for (const account of state.accounts.filter((a) => a.source === 'bank')) {
    const pending = sum(state.txs.filter((tx) => tx.accountId === account.id && tx.pending), txEffect);
    assert.equal(values.get(account.id), account.balance + pending, account.name + ': the reported balance and what is pending');
  }
  const ofGroup = (group) => sum(state.accounts.filter((a) => ACCOUNT_TYPES[a.type].group === group), (a) => values.get(a.id));
  assert.equal(position.cash, ofGroup('cash'));
  assert.equal(position.cards, ofGroup('card'));
  assert.equal(position.loans, ofGroup('debt'));
  assert.equal(position.investments + position.slowAssets, ofGroup('asset'));
  assert.equal(position.liquid, position.cash + position.cards);
  assert.equal(position.day, today);

  // …and so it was at the end of every earlier day.
  for (const ago of [1, 2, 3, 7, 20, 21, 22, 45, 90, 200, 399]) {
    const day = addDays(today, -ago);
    const [close] = ledger.closes(day, day);
    assert.equal(close.bank, sum(state.accounts, (account) => ledger.accountValueOn(account.id, day)), 'at the end of ' + day);
  }
});

everywhere('what is owned less what is owed is the net worth', ({ ledger }) => {
  const position = ledger.position();
  assert.equal(position.assets - position.liabilities, position.bank);
  assert.ok(position.assets > 0 && position.liabilities > 0);
  assert.equal(position.assets, position.cash + position.investments + position.slowAssets);
  assert.equal(position.liabilities, -(position.cards + position.loans));
});

everywhere('the live number is the bank, plus pay earned, less bills used', ({ state, ledger, today }) => {
  const position = ledger.position();
  assert.equal(position.smoothing, true);
  assert.equal(position.provisional, 0);
  assert.ok(Math.abs(position.smooth - (position.bank + position.receivable - position.payable)) < 1e-6);
  assert.equal(position.live, position.smooth - position.provisional);
  assert.ok(position.receivable >= 0 && position.payable > 0);
  assert.ok(Math.abs(sum(position.receivables, (line) => line.amount) - position.receivable) <= position.receivables.length);
  assert.ok(Math.abs(sum(position.payables, (line) => line.amount) - position.payable) <= position.payables.length);

  const salary = state.streams.find((stream) => stream.accrue);
  assert.deepEqual(position.receivables.map((line) => [line.id, line.since]), [[salary.id, salary.anchor]]);
  const book = new Map(state.recurring.map((entry) => [entry.id, entry]));
  assert.ok(position.payables.length >= 10);
  for (const line of position.payables) {
    const entry = book.get(line.id);
    assert.ok(entry && entry.active, line.name + ' is in the Book');
    assert.equal(line.since, entry.anchor, 'accruing since its last charge');
    assert.ok(line.since <= today && line.amount >= 0);
    assert.ok(line.amount <= entry.amount * 1.25 + 1, line.name + ' never accrues past its cap');
    assert.notEqual(accountOfType(state, 'credit_card').id, entry.toAccountId, 'a payment to a linked card is not a bill');
  }
  assert.ok(position.rate > 0 && position.rate < 1, 'cents per second');
  assert.equal(position.freshness, 'fresh');
  assert.equal(position.syncedAt, state.sync.lastOk);
  assert.equal(position.dataAt, state.sync.lastOk);
});

everywhere('the last close is the position, to the cent', ({ state, ledger, today, nowMs }) => {
  const position = ledger.position();
  const [last] = ledger.closes(today, today);
  assert.equal(last.day, today);
  assert.equal(last.partial, true);
  assert.equal(last.bank, position.bank);
  assert.ok(Math.abs(last.smooth - position.live) <= 1, 'smooth ' + last.smooth + ' against live ' + position.live);
  assert.deepEqual(ledger.closes(today, addDays(today, 30)), [last], 'no close lies in the future');

  // Later the same game day only today's accruals have moved, at the rate the position gives.
  const laterMs = Math.min(nowMs + 2 * HOUR_MS, gameDayStartMs(addDays(today, 1), ROLLOVER) - 60000);
  const later = makeLedger(state, laterMs);
  const seconds = (laterMs - nowMs) / 1000;
  assert.equal(later.today, today);
  assert.equal(later.position().bank, position.bank);
  assert.ok(Math.abs(later.position().live - position.live - position.rate * seconds) < 0.01, 'the number rose at its rate');
  assert.ok(later.position().live > position.live);
  const [lastLater] = later.closes(today, today);
  assert.ok(Math.abs(lastLater.smooth - later.position().live) <= 1);
  assert.deepEqual(later.closes(addDays(today, -60), addDays(today, -1)), ledger.closes(addDays(today, -60), addDays(today, -1)), 'the days that are over do not move');
});

/* -------------------------------------------------------------------- closes */

everywhere('consecutive closes differ by their result plus revaluations', ({ ledger, today, firstDay }) => {
  const closes = ledger.closes(addDays(firstDay, -3), today);
  assert.equal(closes.length, DEMO_HISTORY_DAYS + 4);
  for (let i = 1; i < closes.length; i++) {
    const close = closes[i];
    assert.equal(close.day, addDays(closes[i - 1].day, 1));
    assert.equal(close.smooth - closes[i - 1].smooth, close.result + close.reval, close.day);
    assert.equal(close.reval, 0, 'the owner entered each value once');
  }
  const [first] = closes;
  const [eve] = ledger.closes(addDays(first.day, -1), addDays(first.day, -1));
  assert.equal(first.smooth - eve.smooth, first.result + first.reval, 'the first close is measured from the day before it');
});

everywhere('earned less bills less spent, plus other, is the result on every day', ({ state, ledger, today, firstDay }) => {
  const closes = ledger.closes(firstDay, today);
  for (const close of closes) {
    for (const key of ['bank', 'smooth', 'result', 'earned', 'bills', 'spent', 'conv', 'other', 'reval']) {
      assert.ok(Number.isSafeInteger(close[key]), close.day + ' ' + key + ' is whole cents: ' + close[key]);
    }
    assert.equal(close.earned - close.bills - close.spent + close.other, close.result, close.day);
    assert.equal(close.type, dow(close.day) >= 1 && dow(close.day) <= 5 ? 'work' : 'off');
    assert.equal(close.conv, ledger.convOn(close.day));
    assert.ok(close.conv >= 0 && close.earned >= 0);
  }
  assert.deepEqual(closes.filter((close) => close.partial).map((close) => close.day), [addDays(today, -1), today], 'only yesterday and today are still open');

  // Since the loan was entered, nothing moves net worth but earning, bills and spending.
  const sinceMatch = closes.filter((close) => close.day > state.meta.matchStart);
  assert.ok(sinceMatch.every((close) => close.other === 0), 'no unexplained change during the match');
  // Before it, the only unexplained days are none at all: transfers pair off and pay arrives as income.
  assert.ok(closes.every((close) => close.other === 0));
});

everywhere('smoothing on and off tell the same sixty days, a pay period apart at most', ({ state, ledger, today, nowMs }) => {
  const plain = makeLedger(withSettings(state, { smoothing: false }), nowMs);
  const from = addDays(today, -59);
  const smoothed = ledger.closes(from, today);
  const unsmoothed = plain.closes(from, today);
  assert.equal(smoothed.length, 60);
  assert.deepEqual(unsmoothed.map((close) => close.bank), smoothed.map((close) => close.bank), 'the bank is the bank either way');
  assert.ok(unsmoothed.every((close) => close.smooth === close.bank), 'without smoothing nothing accrues');
  assert.equal(plain.position().smoothing, false);
  assert.equal(plain.position().receivable, 0);
  assert.equal(plain.position().rate, 0);

  const total = (closes) => sum(closes, (close) => close.result);
  const gap = total(smoothed) - total(unsmoothed);
  const salary = state.streams.find((stream) => stream.accrue);
  assert.ok(Math.abs(gap) <= salary.amount, 'they differ by ' + gap + ' cents');
  // Exactly: by what had accrued at each end of the sixty days.
  const eve = addDays(from, -1);
  const accrued = (day) => ledger.closes(day, day)[0].smooth - plain.closes(day, day)[0].smooth;
  assert.equal(gap, accrued(today) - accrued(eve));
  // Smoothing is what keeps payday and rent day from looking like events.
  const swing = (closes) => Math.max(...closes.map((close) => Math.abs(close.result)));
  assert.ok(swing(smoothed) < swing(unsmoothed) / 2);
});

everywhere('pending rows and smoothing can be switched off without breaking a sum', ({ state, today, nowMs, firstDay }) => {
  for (const changes of [{ countPending: false }, { smoothing: false }, { countPending: false, smoothing: false }]) {
    const label = JSON.stringify(changes);
    const variant = withSettings(state, changes);
    const ledger = makeLedger(variant, nowMs);
    const position = ledger.position();
    assert.equal(position.bank, sum(variant.accounts, (account) => ledger.accountValueOn(account.id, today)), label);
    assert.equal(position.assets - position.liabilities, position.bank, label);
    if (changes.countPending === false) {
      for (const account of variant.accounts.filter((a) => a.source === 'bank')) {
        assert.equal(ledger.accountValueOn(account.id, today), account.balance, label + ': the reported balance alone');
      }
      assert.equal(ledger.round(today).conv, 0, 'a pending stop is not counted');
    }
    const closes = ledger.closes(firstDay, today);
    assert.equal(closes[closes.length - 1].bank, position.bank, label);
    assert.ok(Math.abs(closes[closes.length - 1].smooth - position.live) <= 1, label);
    for (let i = 1; i < closes.length; i++) {
      assert.equal(closes[i].smooth - closes[i - 1].smooth, closes[i].result + closes[i].reval, label + ' ' + closes[i].day);
      assert.equal(closes[i].earned - closes[i].bills - closes[i].spent + closes[i].other, closes[i].result, label + ' ' + closes[i].day);
    }
  }
});

everywhere('a transfer or a card payment between linked accounts never changes a day', ({ state, ledger, today, nowMs, firstDay }) => {
  const paired = state.txs.filter((tx) => tx.pairId !== null);
  const transfers = paired.filter((tx) => tx.kind === 'transfer');
  const payments = paired.filter((tx) => tx.kind === 'payment');
  assert.ok(transfers.length >= 6 && payments.length >= 26, 'the sample holds both');
  assert.equal(transfers.length + payments.length, paired.length);

  const figures = (doc) => makeLedger(doc, nowMs).closes(firstDay, today)
    .map(({ day, bank, smooth, result, earned, bills, spent, other }) => ({ day, bank, smooth, result, earned, bills, spent, other }));
  const without = (legs) => {
    const ids = new Set(legs.flatMap((tx) => [tx.id, tx.pairId]));
    return { ...state, txs: state.txs.filter((tx) => !ids.has(tx.id)) };
  };
  const asPlayed = figures(state);
  assert.deepEqual(figures(without(paired)), asPlayed, 'with every pair taken out');
  const sweep = state.txs.find((tx) => tx.id === state.sweeps[0].txId);
  const inBook = payments.find((tx) => tx.recurringId !== null && tx.day > state.meta.matchStart) || payments.find((tx) => tx.recurringId !== null);
  for (const leg of [transfers[0], sweep, inBook, payments[0]]) {
    assert.deepEqual(figures(without([leg])), asPlayed, 'without the ' + leg.kind + ' of ' + leg.day);
  }
  // On its own day a pair adds nothing to what was earned or spent.
  for (const leg of [transfers[0], sweep]) {
    const [close] = ledger.closes(leg.day, leg.day);
    const others = state.txs.filter((tx) => tx.day === leg.day && tx.pairId === null && tx.kind !== 'decline');
    // a loan the app works down steps by the principal of that day's payment, before its first entry too
    const eve = addDays(leg.day, -1);
    const worked = sum(state.accounts.filter((account) => account.source === 'manual' && !account.hidden),
      (account) => ledger.accountValueOn(account.id, leg.day) - ledger.accountValueOn(account.id, eve));
    assert.equal(close.bank - ledger.closes(eve, eve)[0].bank - worked, sum(others, txEffect), 'the bank moved by the other rows alone on ' + leg.day);
  }
});

/* --------------------------------------------------------- merge and detection */

everywhere('merging the same feed again changes nothing', ({ state, nowMs }) => {
  const copy = structuredClone(state);
  const feed = demoFeed(nowMs, { days: DEMO_HISTORY_DAYS });
  const nothing = { accountsAdded: 0, added: 0, updated: 0, removed: 0, matched: 0, paired: 0, newTxIds: [] };
  assert.deepEqual(mergeFeed(copy, feed, nowMs), nothing);
  assert.deepEqual(copy, state);
  assert.deepEqual(mergeFeed(copy, structuredClone(feed), nowMs + 60000), nothing, 'nor a minute later');
  refresh(copy, nowMs);
  assert.deepEqual(copy, state, 'nor with detection run after it');
});

everywhere('detect.refresh is idempotent', ({ state, nowMs, today }) => {
  const copy = structuredClone(state);
  const quiet = { reclassified: 0, recurring: { added: [], repriced: [], lapsed: [] }, streams: { added: [], updated: [] }, matchStarted: false, sweeps: 0 };
  assert.deepEqual(refresh(copy, nowMs), quiet);
  assert.deepEqual(copy, state);
  assert.deepEqual(refresh(copy, nowMs), quiet, 'a third time');
  const endOfDay = gameDayStartMs(addDays(today, 1), ROLLOVER) - 1000;
  assert.deepEqual(refresh(copy, endOfDay), quiet, 'at the last second of the game day');
  assert.deepEqual(copy, state);
});

everywhere('the habit in force is the one detection computes from the document', ({ state }) => {
  const [stored] = state.habits;
  const from = state.meta.matchStart;
  assert.deepEqual({ from, ...computeHabit(state, addDays(from, -60), addDays(from, -1)) }, stored);
});

everywhere('the document is plain data and holds no bank credential', ({ state }) => {
  const text = JSON.stringify(state);
  assert.deepEqual(JSON.parse(text), state, 'it survives being stored and loaded');
  assert.doesNotMatch(text, /simplefin/i, 'not the provider');
  assert.doesNotMatch(text, /https?:|:\/\/|@/i, 'no address of any kind, with or without a user and password in it');
  assert.doesNotMatch(text, /\bBasic\s+[A-Za-z0-9+/=]{4,}|Bearer|Authorization/i, 'no authorization header');
  const keys = new Set();
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        keys.add(key);
        collect(value[key]);
      }
    }
  };
  collect(state);
  for (const key of keys) assert.doesNotMatch(key, /access|auth|token|secret|password|credential|claim|setup/i, 'key ' + key);
  assert.deepEqual(Object.keys(state.sync).sort(), ['completed', 'error', 'from', 'lastOk', 'lastTry', 'problems', 'requests', 'src', 'status']);
  for (const account of state.accounts) assert.ok(account.ext === null || Object.keys(account.ext).sort().join() === 'conn,id,src');
});

/* -------------------------------------------------------------------- rounds */

everywhere('every round has a status the game allows, and a result only where one is allowed', ({ state, ledger, today, firstDay }) => {
  const statuses = ['prematch', 'future', 'live', 'awaiting', 'provisional', 'final'];
  const seen = new Set();
  for (const day of eachDayFrom(addDays(firstDay, -5), addDays(today, 5))) {
    const round = ledger.round(day);
    seen.add(round.status);
    assert.equal(round.day, day);
    assert.equal(round.n, parts(day).d);
    assert.ok(statuses.includes(round.status), day + ': ' + round.status);
    assert.ok(round.type === 'work' || round.type === 'off');
    assert.equal(round.status, day > today ? 'future' : day === today ? 'live' : day < state.meta.matchStart ? 'prematch' : round.status, day);
    if (round.status === 'provisional' || round.status === 'final') assert.ok([1, 0.5, 0].includes(round.result), day + ' has a result');
    else if (round.status === 'prematch') assert.ok([1, 0.5, 0, null].includes(round.result), day + ' may carry an exhibition result');
    else assert.equal(round.result, null, day + ' (' + round.status + ') has no result');

    assert.equal(round.kept, round.habit - round.conv);
    assert.equal(round.lossLine, Math.ceil(round.habit / 100) * 100);
    assert.ok(round.winLine <= round.habit && round.winLine % 100 === 0);
    assert.equal(round.clean, round.conv === 0 && (round.status === 'provisional' || round.status === 'final'));
    if (round.result !== null) {
      const expected = round.bye ? 0.5 : round.conv <= round.winLine ? 1 : round.conv > round.lossLine ? 0 : 0.5;
      assert.equal(round.result, expected, day);
    }
    assert.ok(round.moves.every((tx) => tx.day === day));
    const moments = round.moves.map((tx) => (tx.at === null ? tx.loggedAt : tx.at));
    assert.deepEqual(moments, [...moments].sort((a, b) => a - b), 'moves in the order played');
    assert.ok(round.stops <= round.moves.length);
    assertClean(annotateRound(round, {}), 'annotations of ' + day);
  }
  assert.deepEqual([...seen].sort(), ['final', 'future', 'live', 'prematch', 'provisional']);
});

everywhere('the edge is the sum of its rounds', ({ state, ledger, today }) => {
  const edge = ledger.edge();
  const counted = eachDayFrom(state.meta.matchStart, addDays(today, -1)).map((day) => ledger.round(day));
  assert.equal(counted.length, DEMO_MATCH_DAYS);
  assert.equal(edge.kept, sum(counted, (round) => round.kept));
  assert.equal(edge.verified, sum(counted.filter((round) => round.status === 'final'), (round) => round.kept));
  assert.equal(edge.moved, sum(state.sweeps, (sweep) => sweep.amount));
  assert.equal(edge.unmoved, Math.max(0, edge.kept - edge.moved));
  assert.deepEqual(edge.form, counted.slice(-7).map((round) => round.result));
  let run = 0;
  let best = 0;
  for (const round of counted) {
    if (round.bye) continue;
    run = round.result === 0 ? 0 : run + 1;
    best = Math.max(best, run);
  }
  assert.deepEqual([edge.unbeaten, edge.bestUnbeaten], [run, best]);
});

everywhere('month tables agree with their rounds', ({ ledger, today }) => {
  for (const ym of [monthOf(today), addMonthsYm(monthOf(today), -1), addMonthsYm(monthOf(today), -2), addMonthsYm(monthOf(today), 1)]) {
    const table = ledger.monthTable(ym);
    const rounds = eachDayFrom(ym + '-01', endOfMonth(ym)).map((day) => ledger.round(day));
    assert.equal(table.ym, ym);
    assert.equal(table.rounds.length, daysInMonth(ym));
    assert.deepEqual(table.rounds, rounds);
    const counted = rounds.filter((round) => round.result !== null && round.status !== 'prematch');
    const tally = (list) => ({ score: sum(list, (round) => round.result), played: list.length });
    assert.deepEqual({ score: table.score, played: table.played }, tally(counted), ym);
    assert.deepEqual(table.black, tally(counted.filter((round) => round.type === 'work')));
    assert.deepEqual(table.white, tally(counted.filter((round) => round.type === 'off')));
    assert.equal(table.black.played + table.white.played, table.played);
    assert.equal(table.kept, sum(counted, (round) => round.kept));
    assert.equal(table.finals, counted.filter((round) => round.status === 'final').length);
    assert.equal(table.cleanSheets, rounds.filter((round) => round.clean).length);
    assert.equal(table.perfect, sum(rounds, (round) => round.habit));
    assert.equal(table.weeks.length, Math.ceil(rounds.length / 7));
    table.weeks.forEach((week, i) => {
      const chunk = rounds.slice(7 * i, 7 * i + 7);
      assert.deepEqual(week.rounds, chunk);
      assert.deepEqual({ score: week.score, played: week.played }, tally(chunk.filter((round) => counted.includes(round))));
    });
    assertClean(reviewRounds(table.rounds, {}), 'review of ' + ym);
  }
  const months = [monthOf(today), addMonthsYm(monthOf(today), -1)].map((ym) => ledger.monthTable(ym));
  assert.equal(sum(months, (table) => table.played), DEMO_MATCH_DAYS, 'the match so far lies in this month and the last');
});

/* --------------------------------------------------------------------- cards */

everywhere('card months agree with the balances the ledger runs', ({ state, ledger, today, nowMs }) => {
  const card = accountOfType(state, 'credit_card');
  const owedOn = (day) => Math.max(0, -ledger.accountValueOn(card.id, day));
  const months = cardMonths(state, card.id, 14, nowMs);
  assert.equal(months.length, 14);
  months.forEach((row, i) => {
    assert.equal(row.accountId, card.id);
    assert.equal(row.ym, addMonthsYm(monthOf(today), i - 13));
    assert.equal(row.start, owedOn(endOfMonth(addMonthsYm(row.ym, -1))), row.ym + ' starts where the month before ended');
    assert.equal(row.end, row.current ? owedOn(today) : owedOn(endOfMonth(row.ym)), row.ym);
    assert.equal(row.change, row.end - row.start);
    assert.equal(row.change, row.charges - row.payments - row.refunds, row.ym + ': what moved the balance');
    assert.equal(row.current, i === 13);
    assert.ok(row.interest <= row.charges);
    if (i > 0) assert.equal(row.start, months[i - 1].end);

    const rows = state.txs.filter((tx) => tx.accountId === card.id && monthOf(tx.day) === row.ym);
    assert.equal(row.charges, sum(rows.filter((tx) => tx.flow === 'out'), (tx) => tx.amount));
    assert.equal(row.payments, sum(rows.filter((tx) => tx.kind === 'payment'), (tx) => tx.amount));
    assert.equal(row.interest, sum(rows.filter((tx) => tx.category === 'fees_interest'), (tx) => tx.amount));
  });
  const current = months[13];
  assert.equal(current.daysElapsed, parts(today).d);
  // no pace is read before day 7 of the month: both are null together
  if (current.projected === null) assert.equal(current.pace, null);
  else assert.equal(current.pace, current.projected - current.start);
  assert.ok(months.slice(0, 13).every((row) => row.projected === null && row.pace === null));

  assert.deepEqual(allCardsMonths(state, 14, nowMs), months.map((row) => ({ ...row, accountId: ALL_CARDS })), 'one card is all the cards');
  const now = cardsNow(state, nowMs);
  assert.equal(now.owed, current.end);
  assert.equal(now.owed, -ledger.position().cards);
  assert.equal(now.limit, card.limit);
  assert.ok(Math.abs(now.utilisation - now.owed / card.limit) < 1e-12);
  assert.ok(Math.abs(now.interestPerDay - (now.owed * card.apr) / 36500) < 1e-6);
  const largest = largestCharges(state, addMonthsYm(monthOf(today), -1), nowMs);
  assert.equal(largest.length, 3);
  assert.ok(largest[0].amount >= largest[1].amount && largest[1].amount >= largest[2].amount);
});

/* --------------------------------------------------------------------- clock */

everywhere('the clock reads cash, what is due before payday, and the runway', ({ state, ledger, today }) => {
  const clock = ledger.clock();
  const salary = state.streams.find((stream) => stream.accrue);
  assert.equal(clock.cash, ledger.position().cash);
  assert.equal(dow(clock.nextPayday), 5);
  assert.equal(diffDays(salary.anchor, clock.nextPayday), 14, 'two weeks after the last deposit');
  assert.ok(clock.nextPayday > today);
  assert.equal(clock.dueTotal, sum(clock.due, (item) => item.amount));
  assert.equal(clock.shortfall, Math.max(0, clock.dueTotal - clock.cash));
  const cash = new Set(state.accounts.filter((a) => ACCOUNT_TYPES[a.type].group === 'cash').map((a) => a.id));
  for (const item of clock.due) {
    assert.ok(item.day >= today && item.day < clock.nextPayday, item.name + ' falls before payday');
    const entry = state.recurring.find((candidate) => candidate.id === item.id);
    assert.ok(entry && cash.has(entry.accountId), item.name + ' is charged to cash');
    assert.equal(item.amount, entry.amount);
  }
  assert.deepEqual(clock.due.map((item) => item.day), clock.due.map((item) => item.day).sort());
  assert.ok(clock.burn > 5000 && clock.burn < 30000, 'outflow of $' + clock.burn / 100 + ' a day');
  assert.equal(clock.runwayDays, Math.floor(clock.cash / clock.burn));
  assert.equal(clock.trouble, clock.shortfall > 0 || clock.runwayDays < 7);
  assert.equal(clock.reserve, ledger.accountValueOn(accountOfType(state, 'savings').id, today));
  assert.equal(clock.reserveTarget, state.goals.reserve.target);
  assert.deepEqual(clock.milestones.map((milestone) => milestone.label), ['1 day', '1 week', '2 weeks', '1 month', '3 months', 'Goal']);
  assert.ok(clock.milestones.every((milestone) => milestone.reached === clock.reserve >= milestone.amount));
});

everywhere('month-to-date retention is the sum of its closes', ({ ledger, today }) => {
  const month = ledger.retention(today);
  const closes = ledger.closes(monthOf(today) + '-01', today);
  assert.equal(month.ym, monthOf(today));
  assert.equal(month.days, closes.length);
  assert.equal(month.earned, sum(closes, (close) => close.earned));
  assert.equal(month.bills, sum(closes, (close) => close.bills));
  assert.equal(month.spent, sum(closes, (close) => close.spent));
  assert.equal(month.kept, sum(closes, (close) => close.result));
  assert.ok(month.earned > 0);
  assert.ok(Math.abs(month.rate - month.kept / month.earned) < 1e-12);
});

everywhere('spending by category adds up to the purchases the bank reported', ({ state, ledger, today }) => {
  const from = addDays(today, -89);
  const rows = ledger.spendingByCategory(from, today);
  const inRange = state.txs.filter((tx) => tx.day >= from && tx.day <= today && (tx.kind === 'spend' || tx.kind === 'refund'));
  assert.equal(sum(rows, (row) => row.amount), sum(inRange, (tx) => -txEffect(tx)));
  assert.equal(sum(rows, (row) => row.count), inRange.filter((tx) => tx.kind === 'spend').length);
  assert.deepEqual(rows.map((row) => row.amount), rows.map((row) => row.amount).sort((a, b) => b - a), 'largest first');
  assert.equal(rows[0].category, 'housing');
  for (const row of rows) {
    assert.equal(row.amount, sum(inRange.filter((tx) => tx.category === row.category), (tx) => -txEffect(tx)), row.category);
  }
});

/* ------------------------------------------------------ assessment and notes */

everywhere('the assessment speaks in whole sentences', ({ state, ledger, nowMs }) => {
  const assessment = assess(state, nowMs);
  for (const key of ['material', 'time', 'structure', 'initiative']) {
    const factor = assessment[key];
    assert.equal(factor.key, key);
    assert.ok(SYMBOLS.includes(factor.symbol), key + ': ' + factor.symbol);
    assert.equal(factor.label, SYMBOL_LABELS[factor.symbol]);
    assertSentence(factor.sentence, key);
    assert.match(factor.sentence, /\d/, key + ' carries a number or a date');
    assert.match(factor.sentence, /\.$/);
  }
  assert.ok(SYMBOLS.includes(assessment.symbol) && assessment.symbol !== 'unclear');
  assert.equal(assessment.label, SYMBOL_LABELS[assessment.symbol]);
  assertSentence(assessment.sentence, 'verdict');
  assert.ok(assessment.sentence.startsWith(assessment.label + ' — '));
  assert.equal(assessment.time.timeTrouble, ledger.clock().trouble);
  assert.notEqual(assessment.material.symbol, 'unclear');
  assert.notEqual(assessment.structure.symbol, 'unclear');
  assert.deepEqual(assess(state, nowMs), assessment, 'the same answer when asked again');
});

everywhere('the coach’s notes are short, carry a number, and say nothing broken', ({ state, nowMs, today }) => {
  const shown = coachNotes(state, nowMs);
  assert.ok(shown.length >= 1 && shown.length <= 3, 'one to three at a time');
  const all = coachNotes(state, nowMs, { limit: 50 });
  assert.deepEqual(all.slice(0, shown.length), shown);
  assert.equal(new Set(all.map((note) => note.key)).size, all.length, 'no note twice');
  assert.deepEqual(all.map((note) => note.priority), all.map((note) => note.priority).sort((a, b) => b - a), 'most pressing first');
  for (const note of all) {
    assertSentence(note.text, note.key);
    assert.ok(note.text.length < 110, note.key + ' is ' + note.text.length + ' characters');
    assert.match(note.text, /\d/, note.key + ' carries a number or a date');
    assert.ok(note.cta === null || (typeof note.cta.label === 'string' && (typeof note.cta.href === 'string' || typeof note.cta.action === 'string')));
    assertClean(note, note.key);
  }
  const keys = all.map((note) => note.key.split(':')[0]);
  assert.equal(keys[0], 'sweep', 'the open sweep leads');
  for (const expected of ['interest', 'scale', 'review']) assert.ok(keys.includes(expected), 'a note about ' + expected);
  assert.ok(!keys.some((key) => ['relink', 'sync-error', 'bank-problem', 'stale', 'no-pay'].includes(key)), 'nothing is wrong with the link');

  // A note that has had its three days rests; the caller's record of it is all that changes.
  const seen = structuredClone(state);
  seen.meta.notesSeen[all[0].key] = addDays(today, -5);
  assert.ok(!coachNotes(seen, nowMs, { limit: 50 }).some((note) => note.key === all[0].key));
});

everywhere('every other reading of the document is finite and presentable', ({ state, ledger, today, nowMs }) => {
  const readings = {
    position: ledger.position(),
    clock: ledger.clock(),
    edge: ledger.edge(),
    retention: ledger.retention(today),
    spending: ledger.spendingByCategory(addDays(today, -30), today),
    thisMonth: monthReview(state, monthOf(today), nowMs),
    lastMonth: monthReview(state, addMonthsYm(monthOf(today), -1), nowMs),
    bookTotals: bookTotals(state),
    upcoming: upcoming(state, today, 45),
    renewals: renewals(state, today, 400),
    cardsNow: cardsNow(state, nowMs),
    pace: pace(state, nowMs),
    projection: projectNetWorth(state, nowMs),
    reserve: reserveGoal(state, nowMs),
    ladder: incomeLadder(state, nowMs),
    payoff: cardPayoff(state, nowMs),
    onCard: purchaseImpact(state, nowMs, { amount: 45000, on: 'card' }),
    fromCash: purchaseImpact(state, nowMs, { amount: 45000, on: 'cash' }),
    preview: previewMove(ledger.round(today), { amount: 1450, category: 'eating_out' }),
    chips: topMerchants(state, { sinceDay: addDays(today, -90) }),
  };
  assertClean(readings, 'readings');

  for (const review of [readings.thisMonth, readings.lastMonth]) {
    for (const sentence of [review.cash.sentence, review.netWorth.sentence, review.card.sentence, review.scale]) assertSentence(sentence, review.ym);
  }
  assertSentence(readings.onCard.sentence, 'purchase on the card');
  assertSentence(readings.fromCash.sentence, 'purchase from cash');
  assertSentence(readings.preview.why, 'candidate move');

  assert.equal(readings.bookTotals.count, state.recurring.length);
  assert.ok(readings.upcoming.length >= 12 && readings.upcoming.every((row) => row.day >= today));
  assert.equal(readings.renewals.length, 1, 'the yearly renewal comes round once in 400 days');
  assert.ok(readings.pace.days === 30 && readings.projection.lines.length === 3);
  // the live figure is floored to the cent it has reached, never rounded up (ruling R5)
  assert.equal(readings.projection.start, Math.floor(ledger.position().live));
  assert.equal(readings.payoff.owed, readings.cardsNow.owed);
  assert.equal(readings.payoff.never, false);
  assert.ok(readings.ladder.byStream[0].kind === 'salary' && readings.ladder.received > 4000000, 'a year of pay');
  assert.equal(readings.chips.length, 6);
  assert.equal(readings.onCard.netWorth, -45000);
});

/* ------------------------------------------------------------ failure states */

/**
 * The same sample, damaged the way real documents are: a stream that stopped, a bill the bank has not
 * reported, an account left out, a line added by hand, a row dated ahead, a move tapped in.
 */
const DAMAGED_AT = [INSTANTS[0], INSTANTS[5]];

function damaged(title, check) {
  for (const [label, nowMs] of DAMAGED_AT) {
    test(title + ' — ' + label, () => {
      const scene = sceneAt(nowMs);
      check({ ...scene, state: structuredClone(scene.state), healthy: scene.state });
    });
  }
}

/** Every close reconciles: close to close is result + reval, and result is earned − bills − spent + other. */
function assertReconciles(ledger, fromDay, toDay, what) {
  const rows = ledger.closes(addDays(fromDay, -1), toDay);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    assert.equal(row.smooth - rows[i - 1].smooth, row.result + row.reval, what + ': close to close on ' + row.day);
    assert.equal(row.earned - row.bills - row.spent + row.other, row.result, what + ': the parts of ' + row.day);
  }
  return rows.slice(1);
}

function mainStream(state) {
  return state.streams.find((stream) => stream.active && stream.accrue);
}

function depositsOf(state, stream) {
  return state.txs.filter((tx) => tx.streamId === stream.id && tx.kind === 'income').map((tx) => tx.day).sort();
}

damaged('a stream that stopped releases its receivable, is named as lapsed and supplies no payday', ({ state, nowMs, today, firstDay }) => {
  const stream = mainStream(state);
  for (const quietDays of [45, 90, 200]) {
    const cutoff = addDays(today, -quietDays);
    const doc = { ...state, txs: state.txs.filter((tx) => !(tx.streamId === stream.id && tx.day > cutoff)) };
    const last = depositsOf(doc, stream).pop();
    const ledger = makeLedger(doc, nowMs);
    const position = ledger.position();
    assert.equal(position.receivables.some((line) => line.id === stream.id), false, quietDays + ' days quiet');
    assert.deepEqual(position.lapsedPay.filter((line) => line.id === stream.id), [{ id: stream.id, name: stream.name, since: last }]);
    assert.equal(position.live, position.smooth - position.provisional);
    const payday = ledger.clock().nextPayday;
    if (payday !== null) {
      const others = doc.streams.filter((other) => other.id !== stream.id && other.active).map((other) => nextOccurrence(other, addDays(today, -1)));
      assert.ok(payday === today || others.includes(payday), 'the next payday ' + payday + ' is not the stopped stream\'s');
    }
    const rows = assertReconciles(ledger, addDays(today, -Math.min(quietDays + 30, diffDays(firstDay, today) - 1)), today, 'stopped ' + quietDays);
    // once it has lapsed, nothing more is earned from it: what is earned is what arrived
    for (const row of rows.filter((each) => each.day > addDays(last, 24) && each.day < today)) {
      const arrived = sum(doc.txs.filter((tx) => tx.day === row.day && tx.kind === 'income' && !tx.pending), txEffect);
      assert.equal(row.earned, arrived, 'earned on ' + row.day);
    }
  }
});

damaged('before a stream\'s first deposit nothing is earned from it beyond the one period ahead', ({ state, nowMs, today, firstDay }) => {
  const stream = mainStream(state);
  const started = addDays(today, -40);
  const doc = { ...state, txs: state.txs.filter((tx) => !(tx.streamId === stream.id && tx.day < started)) };
  const first = depositsOf(doc, stream)[0];
  const ledger = makeLedger(doc, nowMs);
  const rows = assertReconciles(ledger, addDays(firstDay, 2), today, 'a new job');
  const early = rows.filter((row) => row.day < addDays(first, -17));
  assert.ok(early.length > 100);
  for (const row of early) {
    const arrived = sum(doc.txs.filter((tx) => tx.day === row.day && tx.kind === 'income' && !tx.pending), txEffect);
    assert.equal(row.earned, arrived, 'earned on ' + row.day);
  }
});

damaged('a bill whose day passed unseen stays due, marked overdue; the healthy sample has none', ({ state, healthy, nowMs, today }) => {
  assert.equal(makeLedger(healthy, nowMs).clock().due.some((item) => item.overdue), false);
  const cash = new Set(state.accounts.filter((account) => ['checking', 'savings'].includes(account.type) && !account.hidden).map((account) => account.id));
  const latest = (entry) => state.txs.filter((tx) => tx.recurringId === entry.id && tx.pairId === null).map((tx) => tx.day).sort().pop();
  const late = state.recurring.filter((entry) => entry.active && entry.cadence === 'monthly' && cash.has(entry.accountId)
    && latest(entry) < today && latest(entry) >= addDays(today, -12));
  assert.ok(late.length >= 1, 'the sample has a monthly bill charged in the last 12 days');
  for (const entry of late) {
    const day = latest(entry);
    const doc = { ...state, txs: state.txs.filter((tx) => !(tx.recurringId === entry.id && tx.day === day)) };
    const clock = makeLedger(doc, nowMs).clock();
    const item = clock.due.find((each) => each.id === entry.id && each.overdue);
    assert.ok(item, entry.name + ' of ' + day + ' is still due');
    assert.ok(item.day < today && diffDays(item.day, day) <= 5 && diffDays(day, item.day) <= 5, 'on its scheduled day, ' + item.day);
    assert.equal(item.amount, entry.amount);
    assert.equal(clock.dueTotal, sum(clock.due, (each) => each.amount));
    assert.equal(clock.shortfall, Math.max(0, clock.dueTotal - clock.cash));
  }
});

/* The combinations: the clock in the states the single damages create together. */

function clockAt(doc, nowMs) {
  const ledger = makeLedger(doc, nowMs);
  const clock = ledger.clock();
  assert.equal(clock.dueTotal, sum(clock.due, (each) => each.amount));
  assert.equal(clock.shortfall, Math.max(0, clock.dueTotal - clock.cash));
  assert.match(clock.dueUntil, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(clock.dueUntil >= ledger.today, 'the due window never ends before today');
  // ruling T1: pay is awaited only for a scheduled day before today; the payday itself is not late
  if (clock.payAwaited !== null) assert.ok(clock.payAwaited < ledger.today && clock.nextPayday === ledger.today, 'pay awaited: ' + clock.payAwaited);
  if (clock.nextPayday === null) assert.equal(clock.dueUntil, addDays(ledger.today, 13));
  else if (clock.payAwaited === null) assert.equal(clock.dueUntil, clock.nextPayday > ledger.today ? addDays(clock.nextPayday, -1) : ledger.today);
  else if (diffDays(clock.payAwaited, ledger.today) <= 2) assert.equal(clock.dueUntil, ledger.today, 'the two grace days: today alone');
  else assert.ok(clock.dueUntil > ledger.today, 'from the third day the window runs on');
  for (const item of clock.due) assert.ok(item.overdue ? item.day < ledger.today : item.day >= ledger.today && item.day <= clock.dueUntil, item.name + ' on ' + item.day);
  return clock;
}

const keyOf = (item) => item.id + ' ' + item.day + ' ' + item.amount + (item.overdue ? ' overdue' : '');

/** The cash-paid Book entries with a linked outflow in the last 12 days, with that day. */
function recentlySettled(state, today, pick) {
  const cash = new Set(state.accounts.filter((account) => ['checking', 'savings'].includes(account.type) && !account.hidden).map((account) => account.id));
  const rows = [];
  for (const entry of state.recurring) {
    if (!entry.active || entry.cadence !== 'monthly' || !cash.has(entry.accountId) || !pick(entry)) continue;
    const day = state.txs.filter((tx) => tx.recurringId === entry.id && tx.flow === 'out' && !tx.pending).map((tx) => tx.day).sort().pop();
    if (day && day < today && day >= addDays(today, -12)) rows.push({ entry, day });
  }
  return rows;
}

/** The document without the outflow of `day` linked to the entry, and without the other leg of a transfer. */
function withoutOutflow(state, entry, day) {
  const gone = state.txs.filter((tx) => tx.recurringId === entry.id && tx.day === day);
  const ids = new Set(gone.map((tx) => tx.id));
  const pairs = new Set(gone.map((tx) => tx.pairId).filter((id) => id != null));
  return { ...state, txs: state.txs.filter((tx) => !ids.has(tx.id) && !pairs.has(tx.id) && !(tx.pairId != null && (ids.has(tx.pairId) || pairs.has(tx.pairId)))) };
}

test('with the latest paycheck removed: today alone for two days, then nothing leaves the due list and the window runs through the following payday', () => {
  let awaited = 0;
  let grace = 0;
  for (const [month, day, hour] of [[11, 7, 9], [11, 10, 9], [11, 13, 21], [11, 20, 10], [11, 22, 9], [11, 26, 14], [12, 1, 13]]) {
    const nowMs = at(2026, month, day, hour, 0);
    const { state, today } = sceneAt(nowMs);
    const stream = mainStream(state);
    const latest = depositsOf(state, stream).pop();
    const paid = clockAt(state, nowMs);
    // an overdue bill as well, so that both lists are tested with something late in them
    const bills = recentlySettled(state, today, (entry) => entry.toAccountId == null);
    const docs = [state].concat(bills.map(({ entry, day: charged }) => withoutOutflow(state, entry, charged)));
    for (const doc of docs) {
      const before = clockAt(doc, nowMs);
      const late = clockAt({ ...doc, txs: doc.txs.filter((tx) => !(tx.streamId === stream.id && tx.day === latest)) }, nowMs);
      const listed = new Set(late.due.map(keyOf));
      // ruling T1: on the payday itself and for two days after it the window is today alone; what is overdue is still listed
      if (late.dueUntil === today && late.nextPayday === today) {
        grace += 1;
        for (const item of before.due) if (item.overdue || item.day === today) assert.ok(listed.has(keyOf(item)), today + ': ' + item.name + ' of ' + item.day + ' is still listed');
        assert.ok(late.payAwaited === null || diffDays(late.payAwaited, today) <= 2);
        continue;
      }
      for (const item of before.due) assert.ok(listed.has(keyOf(item)), today + ': ' + item.name + ' of ' + item.day + ' is still due while pay is late');
      assert.ok(late.dueTotal >= before.dueTotal);
      if (late.payAwaited === null) continue;
      awaited += 1;
      assert.ok(diffDays(late.payAwaited, today) > 2, 'late from the third day');
      assert.equal(late.nextPayday, today);
      assert.ok(late.payAwaited <= today && Math.abs(diffDays(latest, late.payAwaited)) <= 3, 'the scheduled day of the missing deposit, ' + late.payAwaited);
      assert.equal(late.dueUntil, nextOccurrence(stream, today), 'through the next scheduled payday after today');
      assert.ok(late.dueUntil > today);
    }
    assert.equal(paid.due.some((item) => item.overdue), false);
  }
  assert.ok(awaited >= 1 && grace >= 1, 'pay was late at ' + awaited + ' of the instants, in the grace days at ' + grace);
});

test('a Book payment to a card or a loan that did not post is overdue, exactly like the rent', () => {
  let transfers = 0;
  let others = 0;
  for (const [month, day] of [[11, 8], [11, 17], [11, 20]]) {
    const nowMs = at(2026, month, day, 20, 0);
    const { state, today } = sceneAt(nowMs);
    for (const { entry, day: posted } of recentlySettled(state, today, () => true)) {
      const paired = state.txs.some((tx) => tx.recurringId === entry.id && tx.day === posted && tx.pairId != null);
      if (paired) transfers += 1;
      else others += 1;
      assert.equal(clockAt(state, nowMs).due.some((each) => each.id === entry.id && each.overdue), false, entry.name + ' posted');
      const clock = clockAt(withoutOutflow(state, entry, posted), nowMs);
      const item = clock.due.find((each) => each.id === entry.id && each.overdue);
      assert.ok(item, today + ': ' + entry.name + ' of ' + posted + ' did not post and is still due');
      assert.equal(item.amount, entry.amount);
      assert.ok(item.day < today && Math.abs(diffDays(item.day, posted)) <= 5, 'on its scheduled day, ' + item.day);
      // a card whose payment is in the Book is not counted a second time as a minimum
      if (entry.toAccountId != null) assert.equal(clock.due.filter((each) => each.id === entry.toAccountId).length, 0);
    }
  }
  assert.ok(transfers >= 1, 'the sample has a Book transfer to a card');
  assert.ok(others >= 2, 'and bills charged to cash');
});

test('an outflow posted two days early settles its occurrence, with the date set by the owner or not', () => {
  let checked = 0;
  for (const [month, day] of [[11, 10], [11, 13], [11, 28]]) {
    const nowMs = at(2026, month, day, 9, 0);
    const scene = sceneAt(nowMs);
    const today = scene.today;
    for (const locked of [false, true]) {
      const ids = scene.state.recurring.filter((entry) => entry.active && entry.cadence === 'monthly').map((entry) => entry.id);
      for (const id of ids) {
        const state = structuredClone(scene.state);
        const entry = state.recurring.find((each) => each.id === id);
        const linked = state.txs.filter((tx) => tx.recurringId === id && tx.flow === 'out' && !tx.pending).sort((a, b) => (a.day < b.day ? -1 : 1));
        const last = linked[linked.length - 1];
        const next = nextOccurrence(entry, today);
        // the occurrence falls in two days and the one before it was paid
        if (!last || next !== addDays(today, 2) || diffDays(last.day, today) < 20) continue;
        if (!clockAt(state, nowMs).due.some((item) => item.id === id && item.day === next)) continue;
        if (locked) entry.locks = ['anchor'];
        const before = clockAt(state, nowMs);
        const legs = state.txs.filter((tx) => tx.id === last.id || (last.pairId != null && (tx.id === last.pairId || tx.pairId === last.id)));
        legs.forEach((tx, i) => state.txs.push({ ...tx, id: 'tx_early_' + i, ext: { src: 'demo', id: 'early-' + i }, fp: 'early-' + i, day: today, postedDay: today }));
        if (locked) {
          refresh(state, nowMs);
          assert.equal(state.recurring.find((each) => each.id === id).anchor, entry.anchor, 'the date the owner set stays');
        }
        const after = clockAt(state, nowMs);
        assert.equal(after.due.some((item) => item.id === id), false, today + ': ' + entry.name + ' paid two days early is not due again' + (locked ? ' (date set)' : ''));
        if (!locked) assert.equal(after.dueTotal, before.dueTotal - last.amount);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 2, 'entries checked: ' + checked);
});

test('once the salary has lapsed a trickle of interest is not the payday: no payday, and the 14-day window', () => {
  for (const [month, day] of [[11, 10], [11, 20], [12, 1]]) {
    const nowMs = at(2026, month, day, 9, 0);
    const { state, today } = sceneAt(nowMs);
    const stream = mainStream(state);
    const cutoff = addDays(today, -45);
    const txs = state.txs.filter((tx) => !(tx.streamId === stream.id && tx.day > cutoff));
    // the other streams that are pay end too; what is left is under $200.00 a month
    const small = (other) => makeLedger(state, nowMs).payStreams().every((pay) => pay.id !== other.id);
    const trickle = state.streams.filter((other) => other.id !== stream.id && other.active && small(other));
    assert.ok(trickle.length >= 1, 'the sample has a small regular stream');
    const doc = { ...state, txs, streams: state.streams.map((other) => (other.id === stream.id || trickle.includes(other) ? other : { ...other, active: false })) };
    const ledger = makeLedger(doc, nowMs);
    assert.deepEqual(ledger.payStreams(), []);
    const clock = clockAt(doc, nowMs);
    assert.equal(clock.nextPayday, null);
    assert.equal(clock.payAwaited, null);
    assert.equal(clock.dueUntil, addDays(today, 13));
    // and in every document the payday is a pay stream's day, never another stream's
    for (const each of [state, { ...state, txs }]) {
      const days = makeLedger(each, nowMs).payStreams().map((pay) => nextOccurrence(pay, today));
      const payday = clockAt(each, nowMs).nextPayday;
      assert.ok(payday === null || payday === today || days.includes(payday), 'the payday ' + payday);
      if (!days.length) assert.equal(payday, null);
    }
  }
});

function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, out));
  else if (value && typeof value === 'object') Object.keys(value).forEach((key) => stringsIn(value[key], out));
  return out;
}

test('with pay late, lapsed or ended every sentence stays presentable: no payday that is today, no percentage over 999', () => {
  let late = 0;
  let none = 0;
  for (const [month, day, hour] of [[11, 10, 9], [11, 13, 21], [11, 20, 10], [12, 1, 13]]) {
    const nowMs = at(2026, month, day, hour, 0);
    const { state, today } = sceneAt(nowMs);
    const stream = mainStream(state);
    const latest = depositsOf(state, stream).pop();
    const without = (cutoff) => ({ ...state, txs: state.txs.filter((tx) => !(tx.streamId === stream.id && tx.day > cutoff)) });
    const ended = structuredClone(without(addDays(today, -90)));
    refresh(ended, nowMs); // detection ends a stream that stopped
    for (const doc of [without(addDays(latest, -1)), without(addDays(today, -45)), without(addDays(today, -90)), ended]) {
      const clock = clockAt(doc, nowMs);
      const assessment = assess(doc, nowMs);
      const notes = coachNotes(doc, nowMs, { limit: 50 });
      const buys = [purchaseImpact(doc, nowMs, { amount: 20000, on: 'cash' }), purchaseImpact(doc, nowMs, { amount: 20000, on: 'card' })];
      assertClean({ assessment, notes, buys }, 'readings');
      assertSentence(assessment.sentence, 'assessment');
      for (const note of notes) assertSentence(note.text, note.key);
      for (const buy of buys) assertSentence(buy.sentence, 'purchase');
      for (const text of stringsIn({ assessment, notes, buys })) {
        assert.doesNotMatch(text, /\d[\d,]{3,}(\.\d+)?%/, 'a percentage over 999: ' + text);
        assert.doesNotMatch(text, /\d[\d,]{3,} days of pay/, 'days of pay: ' + text);
        if (clock.nextPayday === null) assert.doesNotMatch(text, /days of pay|take-home pay|next payday/, 'no pay, yet: ' + text);
        if (clock.payAwaited !== null) assert.doesNotMatch(text, /next payday is|before payday/, 'today is not the next payday: ' + text);
      }
      if (clock.payAwaited !== null) late += 1;
      if (clock.nextPayday === null) none += 1;
    }
  }
  assert.ok(late >= 2 && none >= 8, late + ' documents with pay awaited, ' + none + ' with no payday');
});

damaged('an account left out is left out of everything, and every sum still holds', ({ state, nowMs, today, firstDay }) => {
  for (const type of ['checking', 'credit']) {
    const doc = structuredClone(state);
    const account = accountOfType(doc, type);
    if (!account) continue;
    account.hidden = true;
    const ledger = makeLedger(doc, nowMs);
    const position = ledger.position();
    assert.equal(position.bank, sum(doc.accounts.filter((each) => !each.hidden), (each) => ledger.accountValueOn(each.id, today)), type + ' left out');
    assertReconciles(ledger, addDays(firstDay, 2), today, type + ' left out');
    for (const day of [today, addDays(today, -diffDays(monthOf(today) + '-01', today) - 1)]) {
      const month = ledger.retention(day);
      assert.equal(month.kept, month.earned - month.bills - month.spent + month.other, 'retention of ' + month.ym);
      assert.ok(month.rate === null || (month.earned >= 100 && Number.isFinite(month.rate)), 'no share of next to nothing: ' + month.rate);
    }
    const clock = ledger.clock();
    const entries = new Map(doc.recurring.map((entry) => [entry.id, entry]));
    for (const item of clock.due) {
      const entry = entries.get(item.id);
      assert.ok(item.id !== account.id && !(entry && entry.accountId === account.id), item.name + ' draws on the account left out');
    }
    assert.ok(!position.receivables.concat(position.payables).some((line) => {
      const source = doc.streams.find((stream) => stream.id === line.id) || entries.get(line.id);
      return source && source.accountId === account.id;
    }), 'nothing accrues into or out of it');
    assertClean(position, 'position');
    assertClean(clock, 'clock');
  }
});

damaged('a line added by hand with nothing charged changes nothing before its anchor, and lapses', ({ state, healthy, nowMs, today }) => {
  const before = makeLedger(healthy, nowMs).position();
  const checking = accountOfType(state, 'checking');
  const line = (anchor, since = today) => ({ ...state.recurring[0], id: 'rec_by_hand', name: 'By hand', mkey: 'by hand', accountId: checking.id, toAccountId: null,
    cadence: 'monthly', anchor, amount: 100000, variable: false, active: true, source: 'manual', since, locks: [] });
  // a first charge next week, one next month, and a line added a year ago that was never charged (lapsed)
  for (const [anchor, since] of [[addDays(today, 7), today], [addDays(today, 40), today], [addDays(today, -365), addDays(today, -365)]]) {
    const doc = { ...state, recurring: [...state.recurring, line(anchor, since)] };
    const ledger = makeLedger(doc, nowMs);
    const position = ledger.position();
    assert.equal(position.payable, before.payable, 'anchor ' + anchor);
    assert.equal(position.live, before.live);
    const next = upcoming(doc, today, 400).find((row) => row.id === 'rec_by_hand');
    assert.ok(next.day >= today && (anchor < today || next.day === anchor), 'first expected on ' + next.day);
    assert.equal(ledger.clock().due.some((item) => item.id === 'rec_by_hand' && (item.overdue || item.day < anchor)), false);
  }
  // added today with its last charge 10 days ago: used from today on, never from before
  const recent = { ...state, recurring: [...state.recurring, line(addDays(today, -10))] };
  const row = makeLedger(recent, nowMs).position().payables.find((each) => each.id === 'rec_by_hand');
  assert.equal(row.since, today);
});

damaged('a row dated after today moves no close, and a move tapped in is in the live figure and today\'s close', ({ state, healthy, nowMs, today, firstDay }) => {
  const checking = accountOfType(state, 'checking');
  const template = healthy.txs.find((tx) => tx.accountId === checking.id && tx.kind === 'spend' && tx.recurringId === null && !tx.pending && tx.pairId === null);
  const asPlayed = makeLedger(healthy, nowMs);
  const ahead = { ...state, txs: [...state.txs, { ...template, id: 'tx_ahead', ext: 'ahead', fp: 'ahead', day: addDays(today, 2), amount: 5000 }] };
  const ledger = makeLedger(ahead, nowMs);
  assert.deepEqual(ledger.closes(firstDay, today), asPlayed.closes(firstDay, today));
  assert.equal(ledger.position().live, asPlayed.position().live);

  const tapped = { ...state, txs: [...state.txs, { ...template, id: 'tx_tapped', ext: null, fp: 'tapped', source: 'manual', accountId: null, day: today, amount: 7777, matchId: null }] };
  const withTap = makeLedger(tapped, nowMs);
  const position = withTap.position();
  assert.equal(position.provisional, asPlayed.position().provisional + 7777);
  assert.equal(position.live, position.smooth - position.provisional, 'live holds the tapped-in move; smooth does not');
  assert.equal(position.live, asPlayed.position().live - 7777);
  const [close] = withTap.closes(today, today);
  assert.ok(Math.abs(close.smooth - position.live) <= 1.5, 'today\'s close is the live figure: ' + close.smooth + ' against ' + position.live);
  assertReconciles(withTap, addDays(today, -10), today, 'tapped in');
});

damaged('a feed that went quiet keeps every sum: 37 hours and 10 days after the last sync', ({ state, today, firstDay }) => {
  for (const hours of [37, 240]) {
    const nowMs = state.sync.lastOk + hours * HOUR_MS;
    const ledger = makeLedger(state, nowMs);
    const position = ledger.position();
    assert.equal(position.rate, 0, hours + ' hours');
    assert.equal(position.live, position.smooth - position.provisional);
    assert.equal(position.smooth, position.bank + position.receivable - position.payable);
    assert.deepEqual(position.lapsedPay, [], 'a quiet feed does not end a stream');
    assertReconciles(ledger, addDays(today, -30), ledger.today, hours + ' hours quiet');
    assertClean(ledger.clock(), 'clock');
  }
});

/* ------------------------------------------- a payment the owner sends, from the feed to the checklist */

/** The sample feed with an invented Zelle of $250.00 sent from checking 66, 35 and 5 days before today. */
function feedWithZelle(nowMs, today) {
  const feed = demoFeed(nowMs);
  const checking = feed.accounts.find((account) => account.name === 'Everyday Checking');
  const days = [addDays(today, -66), addDays(today, -35), addDays(today, -5)];
  days.forEach((day, i) => checking.txs.push({
    extId: 'chk-zelle-' + i, amount: -25000, description: 'Zelle payment to R Lindqvist', payee: '', memo: '', mcc: null,
    posted: Math.floor(gameDayStartMs(day, ROLLOVER) / 1000) + 9 * 3600, at: null, pending: false,
  }));
  return { feed, days };
}

damaged('a monthly Zelle in the feed: made a payment the owner sends, it is one line, paid at the bank, and no day after its first charge moves', ({ state, nowMs, today, firstDay }) => {
  const { feed, days } = feedWithZelle(nowMs, today);
  mergeFeed(state, feed, nowMs);
  refresh(state, nowMs);
  const rows = state.txs.filter((tx) => tx.mkey === 'zelle to r lindqvist').sort((a, b) => (a.day < b.day ? -1 : 1));
  assert.deepEqual(rows.map((tx) => [tx.day, tx.kind, tx.ruleId, tx.amount]), days.map((day) => [day, 'spend', 'builtin:zelle', 25000]));
  const detected = state.recurring.find((entry) => entry.mkey === 'zelle to r lindqvist');
  assert.deepEqual([detected.source, detected.amount, detected.active], ['detected', 25000, true]);
  for (const row of rows) assert.equal(row.recurringId, detected.id);
  const totals = bookTotals(state);
  const figures = makeLedger(state, nowMs).closes(addDays(days[0], 1), today);
  const levels = makeLedger(state, nowMs).closes(days[0], days[0])[0];

  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: parts(days[2]).d }, today, nowMs);
  refresh(state, nowMs);
  assert.equal(checkDoc(state), null);
  assert.equal(state.recurring.includes(detected), false);
  assert.equal(entry.payee, payeeKey('zelle to r lindqvist'));
  for (const row of rows) assert.deepEqual([row.recurringId, row.klass, row.review], [entry.id, 'book', false]);
  assert.deepEqual([bookTotals(state).count, bookTotals(state).perMonth, bookTotals(state).perYear], [totals.count, totals.perMonth, totals.perYear]);
  const ledger = makeLedger(state, nowMs);
  assert.deepEqual(ledger.closes(addDays(days[0], 1), today), figures);
  const first = ledger.closes(days[0], days[0])[0];
  assert.deepEqual([first.bank, first.smooth], [levels.bank, levels.smooth]);
  assertReconciles(ledger, firstDay, today, 'with a payment the owner sends');

  // the checklist: this month's payment is paid at the bank, nothing is still to send, nothing is overdue
  const month = byHandMonth(state, today, nowMs);
  assert.deepEqual(month.rows.map((row) => [row.entry.id, row.day, row.status, row.paidDay, row.txId, row.amount]), [[entry.id, days[2], 'bank', days[2], rows[2].id, 25000]]);
  assert.deepEqual([month.ym, month.paid, month.count, month.unpaid, month.transit], [monthOf(today), 1, 1, 0, 0]);
  assert.equal(ledger.clock().due.some((item) => item.id === entry.id && (item.overdue || item.day <= today)), false);
  assertClean(month.rows.map((row) => ({ ...row, entry: row.entry.id })), 'byHandMonth.rows');

  // a second one, not yet sent: still to send, taken into account, and ticked it is on its way
  const parking = addByHand(state, { name: 'Parking', amount: 8500, dueDay: 31 }, today, nowMs);
  refresh(state, nowMs);
  const cash = makeLedger(state, nowMs).position().cash;
  let list = byHandMonth(state, today, nowMs);
  assert.deepEqual([list.count, list.paid, list.unpaid, list.transit], [2, 1, 8500, 0]);
  assert.deepEqual(list.rows.map((row) => row.status), ['bank', 'due']);
  assert.equal(upcoming(state, today, 31).some((row) => row.id === parking.id && row.day === endOfMonth(monthOf(today))), true);
  assert.equal(tickByHand(state, parking.id, endOfMonth(monthOf(today)), true, nowMs), true);
  list = byHandMonth(state, today, nowMs);
  assert.deepEqual([list.paid, list.unpaid, list.transit, list.rows[1].status], [2, 0, 8500, 'hand']);
  assert.equal(upcoming(state, today, 31).some((row) => row.id === parking.id && row.day === endOfMonth(monthOf(today))), false);
  assert.equal(makeLedger(state, nowMs).position().cash, cash, 'a tick moves no money');

  // the next sync brings the same rows again: the same links, the same lines
  const frozen = JSON.stringify([state.recurring, state.txs.map((tx) => [tx.id, tx.recurringId, tx.klass])]);
  mergeFeed(state, feedWithZelle(nowMs, today).feed, nowMs + 60000);
  refresh(state, nowMs + 60000);
  assert.equal(JSON.stringify([state.recurring, state.txs.map((tx) => [tx.id, tx.recurringId, tx.klass])]), frozen);
  assert.equal(checkDoc(state), null);
});

damaged('this month\'s Zelle is still pending when the owner makes it a payment they send: counted once, and no figure of today moves', ({ state, nowMs, today }) => {
  state.settings.countPending = true;
  const { feed, days } = feedWithZelle(nowMs, today);
  feed.accounts.find((account) => account.name === 'Everyday Checking').txs.find((tx) => tx.extId === 'chk-zelle-2').pending = true;
  mergeFeed(state, feed, nowMs);
  refresh(state, nowMs);
  const waiting = state.txs.find((tx) => tx.mkey === 'zelle to r lindqvist' && tx.pending);
  assert.ok(waiting, 'the feed holds the pending row');
  const read = () => {
    const ledger = makeLedger(state, nowMs);
    const clock = ledger.clock();
    return { cash: clock.cash, dueTotal: clock.dueTotal, shortfall: clock.shortfall, live: ledger.position().live, closes: ledger.closes(addDays(days[0], 1), today) };
  };
  const before = read();

  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: parts(days[2]).d }, today, nowMs);
  refresh(state, nowMs);
  assert.equal(checkDoc(state), null);
  assert.equal(waiting.recurringId, entry.id, 'a pending row is linked like a posted one');
  // the ledger has taken the money off cash, so the payment does not also stand as still to send
  assert.deepEqual(read(), before);
  assert.equal(makeLedger(state, nowMs).clock().due.some((item) => item.id === entry.id && item.day <= today), false);
  const month = byHandMonth(state, today, nowMs);
  const row = month.rows.find((one) => one.day === days[2]);
  assert.deepEqual([row.status, row.paidDay, row.txId, row.pendingDay, month.unpaid], ['pending', waiting.day, waiting.id, null, 0]);

  // pending rows not counted: the money is still in cash, and the payment is still to send; the row is only reported
  state.settings.countPending = false;
  refresh(state, nowMs);
  const off = byHandMonth(state, today, nowMs);
  const owed = off.rows.find((one) => one.day === days[2]);
  assert.deepEqual([owed.status, owed.pendingDay, owed.pendingTxId, off.unpaid], ['overdue', waiting.day, waiting.id, 25000]);
  const clock = makeLedger(state, nowMs).clock();
  assert.ok(clock.cash >= before.cash + 25000, 'the pending payment is back in cash (with any other pending row of the feed)');
  assert.equal(clock.due.some((item) => item.id === entry.id && item.day === days[2] && item.overdue), true);

  // a tick on it moves no figure of the ledger, and settles it
  const untouched = { live: makeLedger(state, nowMs).position().live, closes: makeLedger(state, nowMs).closes(addDays(days[0], 1), today) };
  assert.equal(tickByHand(state, entry.id, days[2], true, nowMs), true);
  const ticked = makeLedger(state, nowMs);
  assert.deepEqual({ live: ticked.position().live, closes: ticked.closes(addDays(days[0], 1), today) }, untouched);
  assert.equal(ticked.clock().due.some((item) => item.id === entry.id && item.day === days[2]), false);
});

/* ------------- E9 F1: a detected line of the payee of a payment the owner sends is that payment, or keeps its line */

/** The sample feed with invented rows sent from checking 66: [day, cents, description]. */
function feedWithRows(nowMs, rows) {
  const feed = demoFeed(nowMs);
  const checking = feed.accounts.find((account) => account.name === 'Everyday Checking');
  rows.forEach(([day, cents, description], i) => checking.txs.push({
    extId: 'chk-f1-' + i, amount: -cents, description, payee: '', memo: '', mcc: null,
    posted: Math.floor(gameDayStartMs(day, ROLLOVER) / 1000) + 9 * 3600, at: null, pending: false,
  }));
  return feed;
}

/** What five more refreshes must leave alone. */
function frozenOf(state) {
  return JSON.stringify([state.recurring, state.txs.map((tx) => [tx.id, tx.recurringId, tx.klass])]);
}

function assertSteady(state, nowMs) {
  const frozen = frozenOf(state);
  for (let i = 1; i <= 5; i++) {
    refresh(state, nowMs + i * 60000);
    assert.equal(frozenOf(state), frozen, 'refresh ' + i + ' changes nothing');
  }
}

/** The Book's perMonth of the sample alone, given the same sync again. */
function bookBase(state, nowMs) {
  const plain = structuredClone(state);
  mergeFeed(plain, demoFeed(nowMs), nowMs);
  refresh(plain, nowMs);
  return bookTotals(plain);
}

damaged('F1: a payee detected before the owner lists the payment at an older amount: the line goes, the other amount is offered, and changed it is paid once', ({ state, nowMs, today }) => {
  const paidDay = addDays(today, -2);
  const d = parts(paidDay).d;
  const rows = [[addMonths(paidDay, -2, d), 4000], [addMonths(paidDay, -1, d), 4000], [paidDay, 4500]];
  mergeFeed(state, feedWithRows(nowMs, rows.map(([day, cents]) => [day, cents, 'Zelle To M Sato'])), nowMs);
  refresh(state, nowMs);
  const mkey = state.txs.find((tx) => tx.day === paidDay && tx.amount === 4500).mkey;
  const lines = () => state.recurring.filter((entry) => entry.source === 'detected' && entry.mkey === mkey);
  assert.equal(lines().length, 1, 'the bank rows made a line first');
  const count = bookTotals(state).count;

  const entry = addByHand(state, { name: 'Gym split', amount: 4000, dueDay: d }, today, nowMs);
  refresh(state, nowMs);
  assert.equal(checkDoc(state), null);
  assert.deepEqual(lines(), [], 'the detected line is this payment and goes');
  let row = byHandMonth(state, today, nowMs).rows.find((one) => one.entry.id === entry.id && one.day === paidDay);
  assert.deepEqual([row.status, row.otherDay, row.otherAmount], ['overdue', paidDay, 4500]);
  assert.equal(bookTotals(state).count, count, 'one line for one payment');
  assertSteady(state, nowMs);

  // "Change the amount to $45.00"
  assert.ok(editByHand(state, entry.id, { amount: 4500 }, today, nowMs));
  refresh(state, nowMs);
  assert.equal(checkDoc(state), null);
  row = byHandMonth(state, today, nowMs).rows.find((one) => one.entry.id === entry.id && one.day === paidDay);
  assert.deepEqual([row.status, row.paidDay, row.amount], ['bank', paidDay, 4500]);
  assert.deepEqual(lines(), []);
  assert.equal(bookTotals(state).count, count);
  assert.equal(makeLedger(state, nowMs).clock().due.some((item) => item.id === entry.id && item.overdue), false);
  assertSteady(state, nowMs);
});

for (const paid of [true, false]) {
  damaged('F1: rent raised and listed at the new amount, with a second regular payment on another day to the same payee (this month ' + (paid ? 'paid' : 'not yet paid') + '): one rent line, the second line kept and due as before, the same Book on both devices', ({ state, nowMs, today }) => {
    const L = 'Zelle payment to R Lindqvist';
    const rows = [];
    for (let n = 4; n >= 1; n--) rows.push([addMonths(today, -n, 5), 25000, L], [addMonths(today, -n, 22), 6000, L]);
    if (paid) rows.push([addMonths(today, 0, 5), 30000, L]);
    const base = bookBase(state, nowMs).perMonth;
    mergeFeed(state, feedWithRows(nowMs, rows), nowMs);
    refresh(state, nowMs);
    const mkey = 'zelle to r lindqvist';
    const sixty = state.recurring.find((entry) => entry.source === 'detected' && entry.mkey === mkey && entry.amount === 6000);
    assert.ok(sixty, 'the $60 line is detected');
    const sixtyDue = upcoming(state, today, 31).filter((one) => one.id === sixty.id).map((one) => [one.day, one.amount]);
    const ofPayee = (doc) => doc.recurring.filter((entry) => entry.active && (entry.mkey === mkey || entry.payee === payeeKey(mkey))).map((entry) => entry.amount).sort((a, b) => a - b);

    const deviceB = structuredClone(state);
    // device A: added at the old amount, then changed in the same sitting
    const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, today, nowMs);
    refresh(state, nowMs);
    assert.ok(editByHand(state, entry.id, { amount: 30000 }, today, nowMs + 1000));
    refresh(state, nowMs + 1000);
    // device B: receives the entry as it now is
    deviceB.recurring.push(structuredClone(entry));
    refresh(deviceB, nowMs + 1000);
    for (const doc of [state, deviceB]) {
      assert.equal(checkDoc(doc), null);
      assert.deepEqual(ofPayee(doc), [6000, 30000], 'the rent once, the second payment once');
      assert.equal(bookTotals(doc).perMonth, base + 36000);
      const kept = doc.recurring.find((one) => one.id === sixty.id);
      assert.deepEqual([kept && kept.active, kept && kept.amount], [true, 6000], 'the $60 line keeps its own line');
      assert.deepEqual(upcoming(doc, today, 31).filter((one) => one.id === sixty.id).map((one) => [one.day, one.amount]), sixtyDue, 'and stays due as before');
      const month = byHandMonth(doc, today, nowMs).rows.find((one) => one.entry.id === entry.id);
      assert.equal(month.status, paid ? 'bank' : 'overdue');
      assertSteady(doc, nowMs + 1000);
    }
  });
}

damaged('F1: a second payment of another amount on the same day as the rent keeps its line once the rent is at the bank', ({ state, nowMs, today }) => {
  const L = 'Zelle payment to R Lindqvist';
  const rows = [];
  for (let n = 4; n >= 0; n--) rows.push([addMonths(today, -n, 5), 25000, L], [addMonths(today, -n, 5), 6000, L]);
  const base = bookBase(state, nowMs).perMonth;
  mergeFeed(state, feedWithRows(nowMs, rows), nowMs);
  refresh(state, nowMs);
  const mkey = 'zelle to r lindqvist';
  const sixty = state.recurring.find((entry) => entry.source === 'detected' && entry.mkey === mkey && entry.amount === 6000);
  assert.ok(sixty, 'the $60 line is detected');
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, today, nowMs);
  refresh(state, nowMs);
  assert.equal(checkDoc(state), null);
  assert.equal(state.recurring.find((one) => one.id === sixty.id)?.active, true, 'the $60 line stays');
  assert.equal(state.recurring.some((one) => one.source === 'detected' && one.mkey === mkey && one.amount === 25000), false);
  assert.equal(bookTotals(state).perMonth, base + 31000);
  assert.equal(byHandMonth(state, today, nowMs).rows.find((one) => one.entry.id === entry.id).status, 'bank');
  assertSteady(state, nowMs);
});

damaged('F1: a rise the owner ticks each month instead of entering stays one line', ({ state, nowMs, today }) => {
  const L = 'Zelle payment to R Lindqvist';
  const rows = [];
  for (let n = 4; n >= 1; n--) rows.push([addMonths(today, -n, 5), 25000, L]);
  rows.push([addMonths(today, 0, 5), 30000, L]);
  mergeFeed(state, feedWithRows(nowMs, rows), nowMs);
  refresh(state, nowMs);
  const mkey = 'zelle to r lindqvist';
  const count = bookTotals(state).count;
  const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, today, nowMs);
  refresh(state, nowMs);
  assert.ok(tickByHand(state, entry.id, addMonths(today, 0, 5), true, nowMs));
  refresh(state, nowMs);
  assert.equal(checkDoc(state), null);
  assert.equal(state.recurring.some((one) => one.source === 'detected' && one.mkey === mkey), false, 'no line of the bank rows');
  assert.equal(bookTotals(state).count, count);
  assertSteady(state, nowMs);
  // a month later the bank shows $300 again and the owner ticks again
  const next = nowMs + 31 * 86400000;
  const nextToday = makeLedger(state, next).today;
  mergeFeed(state, feedWithRows(next, rows.concat([[addMonths(nextToday, 0, 5), 30000, L]])), next);
  refresh(state, next);
  assert.ok(tickByHand(state, entry.id, addMonths(nextToday, 0, 5), true, next));
  refresh(state, next);
  assert.equal(state.recurring.some((one) => one.source === 'detected' && one.mkey === mkey && one.active), false, 'still one line');
  assertSteady(state, next);
});

for (const second of [10, 5]) {
  test('F1: a second regular payment to the payee (on the ' + second + 'th) arrives while the rent is unpaid: its own line takes the row, it is not due, and the rent is offered no other amount', () => {
    const L = 'Zelle payment to R Lindqvist';
    const mkey = 'zelle to r lindqvist';
    const rows = [];
    for (const m of ['06', '07', '08', '09', '10']) rows.push([`2026-${m}-05`, 25000, L], [`2026-${m}-${String(second).padStart(2, '0')}`, 6000, L]);
    const nowA = at(2026, 10, 25, 12, 0);
    const state = buildDemoState(nowA);
    mergeFeed(state, feedWithRows(nowA, rows), nowA);
    refresh(state, nowA);
    const entry = addByHand(state, { name: 'Flat share', amount: 25000, dueDay: 5 }, makeLedger(state, nowA).today, nowA);
    refresh(state, nowA);
    assert.equal(entry.payee, payeeKey(mkey));
    const sixty = state.recurring.find((one) => one.source === 'detected' && one.mkey === mkey && one.amount === 6000);
    assert.ok(sixty, 'the $60 line stays beside the rent');
    const ofPayee = () => state.recurring.filter((one) => one.active && (one.mkey === mkey || one.payee === payeeKey(mkey))).map((one) => one.amount).sort((a, b) => a - b);
    assert.deepEqual(ofPayee(), [6000, 25000]);

    // Nov 12: the bank shows the $60 of the month; November's rent is not yet paid
    const nowB = at(2026, 11, 12, 12, 0);
    const sixtyDay = `2026-11-${String(second).padStart(2, '0')}`;
    mergeFeed(state, feedWithRows(nowB, rows.concat([[sixtyDay, 6000, L]])), nowB);
    refresh(state, nowB);
    assert.equal(checkDoc(state), null);
    const today = makeLedger(state, nowB).today;
    const row = state.txs.find((tx) => tx.mkey === mkey && tx.day === sixtyDay && tx.amount === 6000);
    assert.equal(row.recurringId, sixty.id, 'the $60 line takes its row');
    assert.equal(state.recurring.find((one) => one.id === sixty.id)?.active, true);
    assert.equal(makeLedger(state, nowB).clock().due.some((item) => item.id === sixty.id && item.day <= today), false, 'the $60 is paid, not due');
    const rent = byHandMonth(state, today, nowB).rows.find((one) => one.entry.id === entry.id && one.day === '2026-11-05');
    assert.deepEqual([rent.status, rent.otherAmount ?? null], ['overdue', null]);
    assert.deepEqual(ofPayee(), [6000, 25000], 'the rent once, the second payment once');
    assertSteady(state, nowB);
  });
}
