import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRound, previewMove, reviewRounds } from '../js/model/annotate.js';
import { GLYPHS, defaultState, makeAccount, makeTx } from '../js/model/schema.js';
import { round as ledgerRound } from '../js/model/ledger.js';

/* Every figure below is invented. */

const DAY = '2026-06-10'; // a Wednesday
const BOX = '□';
const BANNED = /\b(should|deserve[sd]?|earned|treat|reward|bad|fail(ed|s)?|guilty|only|just|afford|allowance|budget|cheat|streak)\b/i;

let sequence = 0;

/** A move on DAY. `at` follows the order of creation, as the ledger would order the day. */
function move(fields = {}) {
  sequence += 1;
  return makeTx({ id: 'tx_' + sequence, day: DAY, postedDay: DAY, amount: 500, at: sequence, ...fields });
}

const stop = (amount = 500, fields = {}) => move({ amount, category: 'cafe', ...fields });
const filler = (n) => Array.from({ length: n }, () => move({ amount: 2500, category: 'groceries' }));
const decline = (amount = 475, fields = {}) => move({ amount, kind: 'decline', category: 'cafe', source: 'manual', ...fields });
const payment = (amount = 20000, fields = {}) => move({ amount, kind: 'payment', category: 'card_payment', klass: 'need', ...fields });
const business = (amount = 48000, fields = {}) => move({ amount, category: 'gear', purpose: 'studio', ...fields });
const rent = (amount = 120000, fields = {}) => move({ amount, category: 'housing', recurringId: 'rec_rent', ...fields });

/** A Round as ledger.round builds it: habit $16.20, win line $9.00, loss line $18.00. */
function roundOf(moves, fields = {}) {
  const game = moves.filter((tx) => tx.kind === 'spend' && tx.klass === 'game');
  const conv = game.reduce((total, tx) => total + tx.amount, 0);
  const status = fields.status || 'final';
  const scored = status === 'final' || status === 'provisional';
  return {
    day: DAY, n: 10, type: 'work', status,
    habit: 1620, winLine: 900, lossLine: 1800,
    conv, kept: 1620 - conv,
    result: scored ? (conv <= 900 ? 1 : conv > 1800 ? 0 : 0.5) : null,
    bye: false,
    clean: conv === 0 && scored,
    stops: game.length,
    moves,
    plan: null,
    ...fields,
  };
}

const glyphOf = (annotated, tx) => (annotated.moves.has(tx.id) ? annotated.moves.get(tx.id).glyph : null);
const glyphs = (annotated, moves) => moves.map((tx) => glyphOf(annotated, tx));

function assertNoNaN(value, path = 'result') {
  if (typeof value === 'number') assert.ok(!Number.isNaN(value), path + ' is NaN');
  else if (Array.isArray(value)) value.forEach((item, i) => assertNoNaN(item, path + '[' + i + ']'));
  else if (value instanceof Map) for (const [key, item] of value) assertNoNaN(item, path + '.' + key);
  else if (value && typeof value === 'object') for (const key of Object.keys(value)) assertNoNaN(value[key], path + '.' + key);
}

function assertVoice(text) {
  assert.equal(typeof text, 'string');
  assert.match(text, /\d/, 'no number in: ' + text);
  assert.doesNotMatch(text, BANNED, 'banned word in: ' + text);
  assert.ok(!text.includes('!') && !text.includes('?'), 'symbol or exclamation in: ' + text);
}

/* --------------------------------------------------------- shape and basics */

test('most moves carry no annotation', () => {
  const moves = [stop(450), ...filler(3)];
  const annotated = annotateRound(roundOf(moves));
  assert.ok(annotated.moves instanceof Map);
  assert.equal(annotated.moves.size, 0);
  assert.equal(annotated.round, null);
});

test('an annotation is { glyph, why, manual } with a glyph from the schema', () => {
  const second = stop(650);
  const annotated = annotateRound(roundOf([stop(450), second]));
  const annotation = annotated.moves.get(second.id);
  assert.deepEqual(Object.keys(annotation).sort(), ['glyph', 'manual', 'why']);
  assert.ok(Object.hasOwn(GLYPHS, annotation.glyph));
  assert.equal(annotation.manual, false);
  assert.equal(annotation.why, '2nd stop of the day, unplanned: $6.50');
});

/* --------------------------------------------------- rule 1: manual glyphs */

test('rule 1: the owner\'s own glyph wins over every rule', () => {
  const first = stop(450);
  const second = stop(650, { glyph: '!' });
  const groceries = move({ category: 'groceries', glyph: '!?' });
  const annotated = annotateRound(roundOf([first, second, groceries, ...filler(9)]));
  assert.deepEqual(annotated.moves.get(second.id), { glyph: '!', why: 'Annotated by hand: $6.50', manual: true });
  assert.equal(annotated.moves.get(groceries.id).manual, true);
  assert.equal(glyphOf(annotated, groceries), '!?');
});

test('rule 1: a manual negative glyph is kept on a necessary purchase', () => {
  const groceries = move({ category: 'groceries', glyph: '?' });
  const annotated = annotateRound(roundOf([groceries]));
  assert.deepEqual(annotated.moves.get(groceries.id), { glyph: '?', why: 'Annotated by hand: $5.00', manual: true });
});

test('a stored glyph that is not an annotation symbol is ignored', () => {
  const first = stop(450, { glyph: 'x' });
  const second = stop(650, { glyph: '' });
  const annotated = annotateRound(roundOf([first, second]));
  assert.equal(glyphOf(annotated, first), null);
  assert.equal(glyphOf(annotated, second), '?!');
});

/* ------------------------------------------- rule 2: classification glyphs */

test('rule 2: the classifier\'s ?? on a fee stays and is not manual', () => {
  const fee = move({ amount: 3500, category: 'fees_interest', glyph: '??' });
  const annotated = annotateRound(roundOf([fee, ...filler(3)]));
  assert.deepEqual(annotated.moves.get(fee.id), { glyph: '??', why: 'Fee of $35.00: an avoidable penalty', manual: false });
});

test('rule 2: interest is a bare line, and ?? anywhere else is the owner\'s own', () => {
  const interest = move({ amount: 5812, category: 'fees_interest' });
  const marked = move({ amount: 2000, category: 'shopping', glyph: '??' });
  const annotated = annotateRound(roundOf([interest, marked]));
  assert.equal(glyphOf(annotated, interest), null);
  assert.equal(annotated.moves.get(marked.id).manual, true);
});

/* -------------------------------------------------------- rule 3: declines */

test('rule 3: the first two declines of the day get !, later ones are bare', () => {
  const declines = [decline(475), decline(900), decline(650)];
  const annotated = annotateRound(roundOf([...declines, ...filler(5)]));
  assert.deepEqual(glyphs(annotated, declines), ['!', '!', null]);
  assert.equal(annotated.moves.get(declines[0].id).why, 'Declined purchase: $4.75 not spent');
});

/* ----------------------------------------------------------- rule 4: stops */

test('rule 4: with no plan the 1st stop is bare, the 2nd is ?!, the 3rd and later are ?', () => {
  const stops = [stop(450), stop(650), stop(700), stop(300)];
  const annotated = annotateRound(roundOf(stops));
  assert.deepEqual(glyphs(annotated, stops), [null, '?!', '?', '?']);
  assert.equal(annotated.moves.get(stops[2].id).why, '3rd stop of the day, unplanned: $7.00');
  assert.equal(annotated.moves.get(stops[3].id).why, '4th stop of the day, unplanned: $3.00');
});

test('rule 4: stops are numbered in the order played, whatever else happened in between', () => {
  const first = stop(450);
  const groceries = move({ amount: 6000, category: 'groceries' });
  const second = stop(650, { category: 'eating_out' });
  const refund = move({ amount: 450, category: 'cafe', kind: 'refund', flow: 'in' });
  const third = stop(300, { category: 'convenience' });
  const annotated = annotateRound(roundOf([first, groceries, second, refund, third]));
  assert.deepEqual(glyphs(annotated, [first, groceries, second, refund, third]), [null, null, '?!', null, '?']);
});

test('rule 4: the first plan.stops stops are book moves', () => {
  const stops = [stop(450), stop(650), stop(700)];
  const onePlanned = annotateRound(roundOf(stops, { plan: { container: true, breakfast: true, stops: 1 } }));
  assert.deepEqual(glyphs(onePlanned, stops), [null, '?!', '?']);
  const twoPlanned = annotateRound(roundOf(stops, { plan: { container: null, breakfast: null, stops: 2 } }));
  assert.deepEqual(glyphs(twoPlanned, stops), [null, null, '?']);
  const threePlanned = annotateRound(roundOf(stops, { plan: { container: null, breakfast: null, stops: 3 } }));
  assert.deepEqual(glyphs(threePlanned, stops), [null, null, null]);
});

test('rule 4: a plan of no stops still leaves the 1st stop bare', () => {
  const stops = [stop(450), stop(650)];
  const annotated = annotateRound(roundOf(stops, { plan: { container: true, breakfast: true, stops: 0 } }));
  assert.deepEqual(glyphs(annotated, stops), [null, '?!']);
});

test('rule 4: a stop marked planned prints bare and still counts as a stop of the day', () => {
  const stops = [stop(450), stop(650, { planned: true }), stop(700)];
  const annotated = annotateRound(roundOf(stops));
  assert.deepEqual(glyphs(annotated, stops), [null, null, '?']);
});

/* ------------------------------------------- rule 8: who never gets ?! or ? */

test('rule 8: a work stop takes no negative symbol but keeps its place in the count', () => {
  const stops = [stop(450), stop(650, { purpose: 'work' }), stop(700)];
  const annotated = annotateRound(roundOf(stops));
  assert.deepEqual(glyphs(annotated, stops), [null, null, '?']);
});

test('rule 8: purchases outside the daily game never take ?! or ?', () => {
  const moves = [
    stop(450),
    move({ category: 'cafe', klass: 'want' }),
    move({ category: 'groceries' }),
    move({ category: 'subscriptions', recurringId: 'rec_1' }),
    move({ category: 'gear', amount: 2000 }),
    move({ category: 'rideshare' }),
  ];
  const annotated = annotateRound(roundOf(moves));
  assert.equal(annotated.moves.size, 0);
});

/* -------------------------------------------- rule 5: sweeps and payments */

test('rule 5: a recorded sweep gets !, as a payment or as a transfer to the reserve', () => {
  const toCard = payment(4700, { recurringId: 'rec_cardpay' });
  const toReserve = move({ amount: 3100, kind: 'transfer', category: 'transfer', klass: 'need' });
  const plain = move({ amount: 9000, kind: 'transfer', category: 'transfer', klass: 'need' });
  const moves = [toCard, toReserve, plain, ...filler(5)];
  const annotated = annotateRound(roundOf(moves), { sweepTxIds: new Set([toCard.id, toReserve.id]) });
  assert.deepEqual(glyphs(annotated, [toCard, toReserve, plain]), ['!', '!', null]);
  assert.equal(annotated.moves.get(toCard.id).why, 'Sweep of $47.00 recorded');
});

test('rule 5: a card payment outside the Book gets !, one the Book expected does not', () => {
  const extra = payment(20000);
  const standing = payment(15000, { recurringId: 'rec_cardpay' });
  const annotated = annotateRound(roundOf([extra, standing, ...filler(2)]));
  assert.deepEqual(glyphs(annotated, [extra, standing]), ['!', null]);
  assert.equal(annotated.moves.get(extra.id).why, 'Card payment of $200.00 outside the Book');
});

test('rule 5: a payment between linked accounts is marked once, on the leg that left', () => {
  const out = payment(20000, { id: 'tx_out', pairId: 'tx_in' });
  const into = payment(20000, { id: 'tx_in', pairId: 'tx_out', flow: 'in' });
  const alone = payment(8000, { flow: 'in' });
  const annotated = annotateRound(roundOf([out, into, alone, ...filler(5)]));
  assert.deepEqual(glyphs(annotated, [out, into, alone]), ['!', null, '!']);
});

test('rule 5: a loan payment outside the Book is named as a debt payment', () => {
  const loan = payment(24000, { category: 'debt_service' });
  const annotated = annotateRound(roundOf([loan]));
  assert.deepEqual(annotated.moves.get(loan.id), { glyph: '!', why: 'Debt payment of $240.00 outside the Book', manual: false });
});

/* ------------------------------------------------ rule 6: business purchases */

test('rule 6: a business purchase is !? until its return check is answered', () => {
  const open = business(48000);
  const waiting = business(48000, { payback: { by: '2026-08-01', via: 'lessons', outcome: 'notyet' } });
  const unanswered = business(48000, { payback: { by: '2026-08-01', via: 'lessons', outcome: null } });
  const paid = business(48000, { payback: { by: '2026-05-01', via: 'lessons', outcome: 'yes' } });
  const unpaid = business(48000, { payback: { by: '2026-05-01', via: 'lessons', outcome: 'no' } });
  const moves = [open, waiting, unanswered, paid, unpaid, ...filler(15)];
  const annotated = annotateRound(roundOf(moves));
  assert.deepEqual(glyphs(annotated, [open, waiting, unanswered, paid, unpaid]), ['!?', '!?', '!?', '!', '?']);
  assert.equal(annotated.moves.get(open.id).why, 'Business purchase of $480.00: return check open');
  assert.equal(annotated.moves.get(paid.id).why, 'Business purchase of $480.00: paid back');
  assert.equal(annotated.moves.get(unpaid.id).why, 'Business purchase of $480.00: not paid back');
});

test('rule 6: the purchase must be for the business, one-off and $50 or more', () => {
  const atLine = business(5000);
  const under = business(4999);
  const personal = business(48000, { purpose: 'personal' });
  const supplies = business(48000, { category: 'supplies' });
  const annotated = annotateRound(roundOf([atLine, under, personal, supplies]));
  assert.deepEqual(glyphs(annotated, [atLine, under, personal, supplies]), ['!?', null, null, null]);
});

/* ------------------------------------------------------ rule 7: forced moves */

test('rule 7: Book charges for housing and loan payments get the box', () => {
  const housing = rent();
  const loan = payment(24000, { category: 'debt_service', recurringId: 'rec_loan' });
  const classed = move({ amount: 90000, category: 'housing', klass: 'book' });
  const moves = [housing, loan, classed, ...filler(9)];
  const annotated = annotateRound(roundOf(moves));
  assert.deepEqual(glyphs(annotated, [housing, loan, classed]), [BOX, BOX, BOX]);
  assert.equal(annotated.moves.get(housing.id).why, 'Housing payment of $1,200.00: a forced move');
  assert.equal(annotated.moves.get(loan.id).why, 'Loan payment of $240.00: a forced move');
});

test('rule 7: other Book charges, and housing outside the Book, are bare', () => {
  const utilities = move({ amount: 8000, category: 'utilities', recurringId: 'rec_power' });
  const oneOff = move({ amount: 30000, category: 'housing', klass: 'need' });
  const credit = move({ amount: 5000, category: 'housing', recurringId: 'rec_rent', kind: 'refund', flow: 'in' });
  const annotated = annotateRound(roundOf([utilities, oneOff, credit]));
  assert.equal(annotated.moves.size, 0);
});

/* ------------------------------------------------- rule 9: one move in four */

test('rule 9: with four moves there is room for one annotation, and the box goes first', () => {
  const housing = rent();
  const declined = decline();
  const annotated = annotateRound(roundOf([housing, declined, ...filler(2)]));
  assert.deepEqual(glyphs(annotated, [housing, declined]), [null, '!']);
});

test('rule 9: the limit rounds up — five moves leave room for two', () => {
  const housing = rent();
  const declined = decline();
  const annotated = annotateRound(roundOf([housing, declined, ...filler(3)]));
  assert.deepEqual(glyphs(annotated, [housing, declined]), [BOX, '!']);
});

test('rule 9: boxes are dropped first, then !?, then !', () => {
  const housing = rent();
  const purchase = business();
  const extra = payment();
  const declined = decline();
  const moves = [housing, purchase, extra, declined];
  assert.deepEqual(glyphs(annotateRound(roundOf([...moves, ...filler(9)])), moves), [BOX, '!?', '!', '!']);
  assert.deepEqual(glyphs(annotateRound(roundOf([...moves, ...filler(8)])), moves), [null, '!?', '!', '!']);
  assert.deepEqual(glyphs(annotateRound(roundOf([...moves, ...filler(4)])), moves), [null, null, '!', '!']);
  assert.deepEqual(glyphs(annotateRound(roundOf(moves)), moves), [null, null, '!', null]);
});

test('rule 9: of two ! the smaller amount goes first, then the later move', () => {
  const small = decline(300);
  const large = decline(900);
  assert.deepEqual(glyphs(annotateRound(roundOf([small, large])), [small, large]), [null, '!']);
  const earlier = decline(500);
  const later = decline(500);
  assert.deepEqual(glyphs(annotateRound(roundOf([earlier, later])), [earlier, later]), ['!', null]);
});

test('rule 9: manual glyphs, ??, ?! and ? are never dropped', () => {
  const first = stop(450);
  const second = stop(650);
  const third = stop(700);
  const fee = move({ amount: 3500, category: 'fees_interest', glyph: '??' });
  const own = move({ amount: 100, category: 'groceries', glyph: BOX });
  const declined = decline();
  const moves = [first, second, third, fee, own, declined];
  const annotated = annotateRound(roundOf(moves));
  assert.deepEqual(glyphs(annotated, moves), [null, '?!', '?', '??', BOX, null]);
});

test('rule 9: a single move may be annotated', () => {
  const declined = decline();
  assert.equal(glyphOf(annotateRound(roundOf([declined])), declined), '!');
});

/* --------------------------------------------------------- the round itself */

test('a clean-sheet workday is !!, final or provisional', () => {
  const moves = filler(2);
  for (const status of ['final', 'provisional']) {
    const annotated = annotateRound(roundOf(moves, { status }));
    assert.deepEqual(annotated.round, { glyph: '!!', why: 'Clean sheet on a workday: $0.00 against habit at $16.20', manual: false });
  }
});

test('a clean sheet is not !! on a day off, nor before the bank has reported the day', () => {
  assert.equal(annotateRound(roundOf([], { type: 'off' })).round, null);
  for (const status of ['live', 'awaiting', 'future', 'prematch']) {
    assert.equal(annotateRound(roundOf([], { status })).round, null, status);
  }
});

test('a round played to the morning plan is !', () => {
  const plan = { container: true, breakfast: true, stops: 1 };
  const annotated = annotateRound(roundOf([stop(450)], { plan }));
  assert.deepEqual(annotated.round, { glyph: '!', why: 'Played to the morning plan: 1 stop planned, 1 made', manual: false });
  const dayOff = annotateRound(roundOf([], { type: 'off', plan: { container: null, breakfast: null, stops: 2 } }));
  assert.deepEqual(dayOff.round, { glyph: '!', why: 'Played to the morning plan: 2 stops planned, 0 made', manual: false });
});

test('a round is not ! when it went past the plan, was not a win, or the plan names no stops', () => {
  const plan = { container: true, breakfast: true, stops: 1 };
  assert.equal(annotateRound(roundOf([stop(300), stop(300)], { plan })).round, null);
  assert.equal(annotateRound(roundOf([stop(1200)], { plan })).round, null);
  assert.equal(annotateRound(roundOf([stop(450)], { plan: { container: true, breakfast: true, stops: null } })).round, null);
  assert.equal(annotateRound(roundOf([stop(450)])).round, null);
  assert.equal(annotateRound(roundOf([stop(450)], { plan, status: 'live' })).round, null);
});

test('a clean-sheet workday with a plan is !!, not !', () => {
  const annotated = annotateRound(roundOf([], { plan: { container: true, breakfast: true, stops: 0 } }));
  assert.equal(annotated.round.glyph, '!!');
});

/* -------------------------------------------------------------- robustness */

test('malformed rounds and rows never throw', () => {
  for (const broken of [null, undefined, 7, 'round', {}, { moves: 'none' }, { moves: [null, 5, 'x', {}] }]) {
    const annotated = annotateRound(broken);
    assert.equal(annotated.moves.size, 0);
    assert.equal(annotated.round, null);
  }
  const noId = stop(650);
  delete noId.id;
  const odd = [stop(450), noId, { kind: 'spend', klass: 'game', category: 'cafe', amount: NaN, id: 'tx_nan' }, stop(700)];
  const annotated = annotateRound(roundOf(odd, { conv: 1800, stops: 3 }), { sweepTxIds: 'not a set' });
  assertNoNaN(annotated);
  assert.deepEqual([...annotated.moves.keys()], [odd[3].id]);
  assert.equal(annotated.moves.get(odd[3].id).glyph, '?');
});

test('every reason is a short plain phrase with a number and none of the words the voice avoids', () => {
  const moves = [
    stop(450), stop(650), stop(700),
    decline(), payment(), business(), rent(),
    move({ amount: 3500, category: 'fees_interest', glyph: '??' }),
    move({ category: 'groceries', glyph: '!' }),
    ...filler(30),
  ];
  const annotated = annotateRound(roundOf(moves), { sweepTxIds: new Set([moves[4].id]) });
  assert.equal(annotated.moves.size, 8);
  for (const annotation of annotated.moves.values()) {
    assertVoice(annotation.why);
    assert.ok(annotation.why.length <= 60, annotation.why);
  }
  for (const round of [roundOf([]), roundOf([stop(450)], { plan: { container: null, breakfast: null, stops: 1 } })]) {
    assertVoice(annotateRound(round).round.why);
  }
});

test('it annotates a Round built by the ledger', () => {
  const at = (hour) => new Date(2026, 5, 9, hour).getTime();
  const state = defaultState(new Date(2026, 0, 1, 12).getTime());
  state.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', balance: 100000, basis: 'bank', asOf: new Date(2026, 5, 12, 9).getTime() }));
  state.meta.matchStart = '2026-06-01';
  state.habits.push({ from: '2026-06-01', work: 1620, off: 2200, winWork: 900, winOff: 1100, basis: 'computed', window: null, backtest: null });
  const row = (id, hour, fields) => makeTx({ id, accountId: 'acc_chk', day: '2026-06-09', postedDay: '2026-06-09', at: at(hour), ...fields });
  state.txs.push(
    row('tx_c', 16, { amount: 700, category: 'convenience' }),
    row('tx_a', 8, { amount: 450, category: 'cafe' }),
    row('tx_b', 12, { amount: 1200, category: 'eating_out' }),
    row('tx_g', 18, { amount: 6400, category: 'groceries' }),
  );
  state.sync.lastOk = new Date(2026, 5, 12, 9).getTime();
  const played = ledgerRound(state, '2026-06-09', new Date(2026, 5, 12, 12).getTime());
  assert.equal(played.status, 'final');
  assert.equal(played.stops, 3);
  const annotated = annotateRound(played, { sweepTxIds: new Set() });
  assert.deepEqual([...annotated.moves].map(([id, annotation]) => [id, annotation.glyph]), [['tx_b', '?!'], ['tx_c', '?']]);
  assert.equal(annotated.round, null);
});

/* ------------------------------------------------------------ reviewRounds */

function reviewFixture() {
  const day = (d) => '2026-06-' + String(d).padStart(2, '0');
  const clean = roundOf(filler(2), { day: day(1) });
  const oneStop = roundOf([stop(450)], { day: day(2), plan: { container: true, breakfast: true, stops: 1 } });
  const stackedMoves = [stop(450), stop(650), stop(1100), ...filler(1)];
  const stacked = roundOf(stackedMoves, { day: day(3) });
  const plannedTwo = roundOf([stop(500), stop(600), stop(250, { purpose: 'work' }), stop(900)], { day: day(4), plan: { container: null, breakfast: null, stops: 2 } });
  const dayOff = roundOf([stop(2400, { merchant: 'Harbor Diner', category: 'eating_out' })], { day: day(6), type: 'off' });
  const today = roundOf([stop(300), stop(350)], { day: day(10), status: 'live' });
  const before = roundOf([stop(9900), stop(9900)], { day: '2026-05-30', status: 'prematch' });
  const ahead = roundOf([], { day: day(11), status: 'future' });
  return { clean, oneStop, stacked, plannedTwo, dayOff, today, before, ahead };
}

test('reviewRounds counts every glyph over the rounds of the match', () => {
  const rounds = Object.values(reviewFixture());
  const review = reviewRounds(rounds);
  assert.deepEqual(Object.keys(review.counts), Object.keys(GLYPHS));
  assert.deepEqual(review.counts, { '!!': 1, '!': 1, '!?': 0, '?!': 2, '?': 2, '??': 0, [BOX]: 0 });
});

test('reviewRounds counts stacked days and what the stacked stops cost', () => {
  const review = reviewRounds(Object.values(reviewFixture()));
  // 3 June: $6.50 + $11.00. 4 June: the 4th stop, $9.00 (the 3rd was for work). Today: $3.50.
  assert.equal(review.stackedDays, 3);
  assert.equal(review.stackedCost, 650 + 1100 + 900 + 350);
});

test('reviewRounds scores prepared and unprepared rounds apart', () => {
  const review = reviewRounds(Object.values(reviewFixture()));
  // Prepared: 2 June (win) and 4 June ($22.50: a loss). Unprepared: 1 June (win), 3 June ($22.00: a loss), 6 June ($24.00: a loss).
  assert.deepEqual(review.prepared, { rounds: 2, score: 1 });
  assert.deepEqual(review.unprepared, { rounds: 3, score: 1 });
});

test('reviewRounds names the best round and the costliest game move', () => {
  const review = reviewRounds(Object.values(reviewFixture()));
  assert.deepEqual(review.best, { day: '2026-06-01', text: 'Clean sheet on a workday' });
  assert.deepEqual(review.costliest, { day: '2026-06-06', text: 'Harbor Diner', amount: 2400 });
});

test('reviewRounds words the best round by what it kept', () => {
  const kept = reviewRounds([roundOf([stop(450)])]);
  assert.deepEqual(kept.best, { day: DAY, text: 'Kept $11.70 against habit on a workday' });
  const over = reviewRounds([roundOf([stop(2400)], { type: 'off' })]);
  assert.deepEqual(over.best, { day: DAY, text: '$7.80 over habit on a day off' });
  const level = reviewRounds([roundOf([stop(1620)])]);
  assert.deepEqual(level.best, { day: DAY, text: 'Level with habit at $16.20 on a workday' });
  const cleanOff = reviewRounds([roundOf([], { type: 'off' })]);
  assert.deepEqual(cleanOff.best, { day: DAY, text: 'Clean sheet on a day off' });
});

test('reviewRounds falls back to the category when a move has no merchant name', () => {
  const review = reviewRounds([roundOf([stop(800), move({ amount: 99000, category: 'gear' })])]);
  assert.deepEqual(review.costliest, { day: DAY, text: 'Coffee & cafes', amount: 800 });
});

test('reviewRounds passes the sweeps through to the annotations', () => {
  const sweep = move({ amount: 4700, kind: 'transfer', category: 'transfer', klass: 'need' });
  const rounds = [roundOf([sweep, stop(450)])];
  assert.equal(reviewRounds(rounds).counts['!'], 0);
  assert.equal(reviewRounds(rounds, { sweepTxIds: new Set([sweep.id]) }).counts['!'], 1);
});

test('reviewRounds of nothing is all zeros', () => {
  const empty = {
    counts: { '!!': 0, '!': 0, '!?': 0, '?!': 0, '?': 0, '??': 0, [BOX]: 0 },
    best: null, costliest: null, stackedDays: 0, stackedCost: 0,
    prepared: { rounds: 0, score: 0 }, unprepared: { rounds: 0, score: 0 },
  };
  assert.deepEqual(reviewRounds([]), empty);
  assert.deepEqual(reviewRounds(null), empty);
  assert.deepEqual(reviewRounds([null, 4, { status: 'prematch' }, { status: 'future' }]), empty);
  assertNoNaN(reviewRounds([{ status: 'final', moves: [{ kind: 'spend', klass: 'game', category: 'cafe' }], kept: NaN, result: 1 }]));
});

/* ------------------------------------------------------------- previewMove */

test('previewMove: a 1st stop inside the win line keeps the win', () => {
  const preview = previewMove(roundOf([], { status: 'live' }), { amount: 450, category: 'cafe' });
  assert.deepEqual(preview, {
    keptBefore: 1620, keptAfter: 1170, resultBefore: 1, resultAfter: 1, stopNumber: 1, glyph: null,
    why: '1st stop of the day. $4.50 keeps the round a win, $4.50 inside the win line.',
  });
});

test('previewMove: the win line itself is still a win, one cent more is a draw', () => {
  const round = roundOf([stop(450)], { status: 'live' });
  const onLine = previewMove(round, { amount: 450, category: 'cafe' });
  assert.equal(onLine.resultAfter, 1);
  assert.equal(onLine.why, '2nd stop of the day, unplanned. $4.50 keeps the round a win, $0.00 inside the win line.');
  const past = previewMove(round, { amount: 451, category: 'cafe' });
  assert.equal(past.resultBefore, 1);
  assert.equal(past.resultAfter, 0.5);
  assert.equal(past.keptAfter, 719);
  assert.equal(past.why, '2nd stop of the day, unplanned. $4.51 takes the round from a win to a draw, $8.99 inside the loss line.');
});

test('previewMove: the loss line itself is a draw, one cent more is a loss', () => {
  const round = roundOf([stop(1000)], { status: 'live' });
  const onLine = previewMove(round, { amount: 800, category: 'eating_out' });
  assert.equal(onLine.resultBefore, 0.5);
  assert.equal(onLine.resultAfter, 0.5);
  assert.equal(onLine.keptAfter, -180);
  assert.equal(onLine.why, '2nd stop of the day, unplanned. $8.00 keeps the round a draw, $0.00 inside the loss line.');
  const past = previewMove(round, { amount: 801, category: 'eating_out' });
  assert.equal(past.resultAfter, 0);
  assert.equal(past.why, '2nd stop of the day, unplanned. $8.01 takes the round from a draw to a loss, $0.01 past the loss line.');
});

test('previewMove: a move can take the round from a win straight to a loss, and a loss stays a loss', () => {
  const fromWin = previewMove(roundOf([], { status: 'live' }), { amount: 2500, category: 'delivery' });
  assert.equal(fromWin.resultBefore, 1);
  assert.equal(fromWin.resultAfter, 0);
  assert.equal(fromWin.why, '1st stop of the day. $25.00 takes the round from a win to a loss, $7.00 past the loss line.');
  const lost = previewMove(roundOf([stop(2500)], { status: 'live' }), { amount: 500, category: 'cafe' });
  assert.equal(lost.resultBefore, 0);
  assert.equal(lost.resultAfter, 0);
  assert.equal(lost.why, '2nd stop of the day, unplanned. $5.00 keeps the round a loss, $12.00 past the loss line.');
});

test('previewMove: the 1st stop is bare, the 2nd is ?!, the 3rd and later are ?', () => {
  const candidate = { amount: 100, category: 'convenience' };
  const expected = [[0, 1, null], [1, 2, '?!'], [2, 3, '?'], [3, 4, '?']];
  for (const [made, stopNumber, glyph] of expected) {
    const round = roundOf(Array.from({ length: made }, () => stop(100)), { status: 'live' });
    const preview = previewMove(round, candidate);
    assert.equal(preview.stopNumber, stopNumber);
    assert.equal(preview.glyph, glyph);
  }
  const third = previewMove(roundOf([stop(100), stop(100)], { status: 'live' }), candidate);
  assert.match(third.why, /^3rd stop of the day, unplanned\. /);
});

test('previewMove: a stop inside the plan, or marked planned, carries no symbol', () => {
  const round = roundOf([stop(300)], { status: 'live', plan: { container: true, breakfast: true, stops: 2 } });
  const inPlan = previewMove(round, { amount: 300, category: 'cafe' });
  assert.equal(inPlan.stopNumber, 2);
  assert.equal(inPlan.glyph, null);
  assert.equal(inPlan.why, '2nd stop of the day, in the plan. $3.00 keeps the round a win, $3.00 inside the win line.');
  const beyond = previewMove(roundOf([stop(300), stop(300)], { status: 'live', plan: round.plan }), { amount: 300, category: 'cafe' });
  assert.equal(beyond.glyph, '?');
  const marked = previewMove(roundOf([stop(300), stop(300)], { status: 'live' }), { amount: 300, category: 'cafe', planned: true });
  assert.equal(marked.stopNumber, 3);
  assert.equal(marked.glyph, null);
});

test('previewMove: a purchase outside the daily game leaves the round as it stands', () => {
  const round = roundOf([stop(320)], { status: 'live' });
  const preview = previewMove(round, { amount: 6400, category: 'groceries' });
  assert.deepEqual(preview, {
    keptBefore: 1300, keptAfter: 1300, resultBefore: 1, resultAfter: 1, stopNumber: null, glyph: null,
    why: 'Outside the daily game (Groceries): $64.00 leaves the round at $3.20 against habit at $16.20.',
  });
  assert.equal(previewMove(round, { amount: 500, category: 'no such category' }).stopNumber, null);
});

test('previewMove: a bye scores a draw whatever is spent', () => {
  const preview = previewMove(roundOf([], { status: 'live', bye: true }), { amount: 5000, category: 'cafe' });
  assert.equal(preview.resultBefore, 0.5);
  assert.equal(preview.resultAfter, 0.5);
  assert.equal(preview.keptAfter, -3380);
  assert.equal(preview.why, '1st stop of the day. $50.00 leaves the bye at a draw, $32.00 past the loss line.');
});

test('previewMove: every reason carries a number and none of the words the voice avoids', () => {
  const rounds = [roundOf([], { status: 'live' }), roundOf([stop(900)], { status: 'live' }), roundOf([stop(900), stop(900)], { status: 'live' })];
  for (const round of rounds) {
    for (const category of ['cafe', 'eating_out', 'groceries', 'gear']) {
      for (const amount of [1, 450, 2000]) assertVoice(previewMove(round, { amount, category }).why);
    }
  }
});

test('previewMove: malformed input gives zeros, never NaN', () => {
  for (const [round, candidate] of [[null, null], [undefined, {}], [{}, { amount: NaN, category: 'cafe' }], [{ habit: 'x', conv: -5, stops: NaN }, { amount: -300, category: 'cafe' }]]) {
    const preview = previewMove(round, candidate);
    assertNoNaN(preview);
    assert.equal(preview.keptBefore, 0);
    assert.equal(preview.keptAfter, 0);
    assert.equal(preview.resultBefore, 1);
    assert.equal(typeof preview.why, 'string');
  }
  const noHabit = previewMove({}, { amount: 300, category: 'cafe' });
  assert.equal(noHabit.resultAfter, 0);
  assert.equal(noHabit.stopNumber, 1);
});
