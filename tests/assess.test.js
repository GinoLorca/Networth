import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYMBOLS, SYMBOL_LABELS, assess, coachNotes, monthReview } from '../js/model/assess.js';
import { reviewRounds } from '../js/model/annotate.js';
import { makeLedger, monthTable } from '../js/model/ledger.js';
import { defaultState, makeAccount, makeRecurring, makeStream, makeTx } from '../js/model/schema.js';

/* Every figure below is invented. June 2026 has 30 days and no clock change anywhere near it. */

/** Local time, so the tests read the same in every time zone. */
const at = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();

/** Wednesday 10 June 2026 at noon. The 1st was a Monday. */
const NOW = at(2026, 6, 10);
const BANNED = /\b(should|deserve[sd]?|treat|reward|bad|fail(ed|s)?|guilty|only|just|afford|allowance|budget|cheat|streak)\b/i;

let sequence = 0;

function tx(accountId, day, amount, fields = {}) {
  sequence += 1;
  return makeTx({ id: 'tx_' + sequence, accountId, day, postedDay: day, amount, loggedAt: at(2026, 1, 2) + sequence, ...fields });
}

const spend = (accountId, day, amount, category, fields = {}) => tx(accountId, day, amount, { category, ...fields });
const income = (day, amount, fields = {}) => tx('acc_chk', day, amount, { flow: 'in', kind: 'income', category: 'income', ...fields });
/** Money arriving on (+) or leaving (−) an account without being income or spending. */
const moved = (accountId, day, signed, fields = {}) =>
  tx(accountId, day, Math.abs(signed), { flow: signed < 0 ? 'out' : 'in', kind: 'transfer', category: 'transfer', klass: 'need', ...fields });
const cardPayment = (day, amount) => tx('acc_card', day, amount, { flow: 'in', kind: 'payment', category: 'card_payment', klass: 'need' });

const bank = (id, type, balance, fields = {}) =>
  makeAccount({ id, source: 'bank', type, balance, basis: 'bank', name: id, asOf: at(2026, 6, 10, 9), ...fields });

/**
 * The quiet document: $5,000.00 in checking, one grocery run on `firstDay` so there is a history,
 * synced three hours ago, smoothing switched off by the owner. Nothing in it calls for a note.
 */
function quiet({ cash = 500000, firstDay = '2026-03-02', firstOn = 'acc_chk' } = {}) {
  const state = defaultState(at(2026, 1, 1));
  state.settings.smoothing = false;
  state.accounts.push(bank('acc_chk', 'checking', cash));
  if (firstDay) state.txs.push(spend(firstOn, firstDay, 100, 'groceries'));
  state.sync.lastOk = at(2026, 6, 10, 9);
  state.sync.status = 'ok';
  return state;
}

/**
 * A position with one lever per factor. Pay is $3,000.00 a month, counted when it arrives.
 *   burn      cents a day: one household bill of 60 × burn on 20 April (inside the 60 days the clock reads)
 *   invested  signed cents arriving on the investment account on 20 May (inside the last 30 days, outside June)
 *   income    cents received on 2 June          out   cents leaving the investment account on 3 June
 *   card      { now, april, may, june }: owed now, and each month's net (+ a charge, − a payment)
 * So: material = invested + income − out (− a June card charge); runway = cash / burn;
 *     retention = (income − out) / income; structure from the card months.
 */
function board({ cash = 500000, burn = 0, invested = 0, income: received = 0, out = 0, pay = 300000, card = null } = {}) {
  const state = quiet({ cash });
  state.accounts.push(bank('acc_inv', 'investment', 1000000));
  if (pay) {
    state.streams.push(makeStream({
      id: 'str_pay', name: 'Northwind Payroll', mkey: 'northwind', kind: 'salary', accountId: 'acc_chk',
      cadence: 'monthly', anchor: '2026-05-25', amount: pay,
    }));
  }
  if (burn) state.txs.push(spend('acc_chk', '2026-04-20', burn * 60, 'household'));
  if (invested) state.txs.push(moved('acc_inv', '2026-05-20', invested));
  if (received) state.txs.push(income('2026-06-02', received));
  if (out) state.txs.push(moved('acc_inv', '2026-06-03', -out));
  if (card) addCard(state, card);
  return state;
}

function addCard(state, { now, april = 0, may = 0, june = 0, apr = null }) {
  state.accounts.push(bank('acc_card', 'credit_card', -now, { apr }));
  for (const [day, net] of [['2026-04-10', april], ['2026-05-10', may], ['2026-06-05', june]]) {
    if (net > 0) state.txs.push(spend('acc_card', day, net, 'shopping'));
    if (net < 0) state.txs.push(cardPayment(day, -net));
  }
}

function startMatch(state, from = '2026-06-01') {
  state.meta.matchStart = from;
  state.habits.push({ from, work: 1500, off: 2000, winWork: 700, winOff: 1000, basis: 'computed', window: null, backtest: null });
  return state;
}

function assertNoNaN(value, path = 'result') {
  if (typeof value === 'number') assert.ok(!Number.isNaN(value), path + ' is NaN');
  else if (Array.isArray(value)) value.forEach((item, i) => assertNoNaN(item, path + '[' + i + ']'));
  else if (value && typeof value === 'object') for (const key of Object.keys(value)) assertNoNaN(value[key], path + '.' + key);
}

function assertVoice(text) {
  assert.equal(typeof text, 'string');
  assert.match(text, /\d/, 'no number or date in: ' + text);
  assert.doesNotMatch(text, BANNED, 'banned word in: ' + text);
  assert.ok(!text.includes('!') && !text.includes('?'), 'exclamation or question in: ' + text);
  assert.ok(!/NaN|undefined|null|—\$|\$—/.test(text), 'unformatted value in: ' + text);
}

/** A coach's note never says "earned": pay is earned in the factor sentences, kept money never is. */
function assertNoteVoice(text) {
  assertVoice(text);
  assert.doesNotMatch(text, /\bearned\b/i, 'earned in a note: ' + text);
}

const allNotes = (state, now = NOW) => coachNotes(state, now, { limit: 50 });
const noteOf = (state, prefix, now = NOW) => allNotes(state, now).find((note) => note.key === prefix || note.key.startsWith(prefix + ':')) || null;

/* ------------------------------------------------------------ the symbols */

test('the symbols run best to worst and each has a plain name', () => {
  assert.deepEqual(SYMBOLS, ['winning', 'clear_plus', 'slight_plus', 'equal', 'slight_minus', 'clear_minus', 'losing', 'unclear']);
  for (const symbol of SYMBOLS) assert.equal(typeof SYMBOL_LABELS[symbol], 'string');
});

test('assess returns four factors, a verdict, its label and a sentence', () => {
  const result = assess(board({ burn: 10000, income: 100000, out: 100000 }), NOW);
  assert.deepEqual(Object.keys(result), ['material', 'time', 'structure', 'initiative', 'symbol', 'label', 'sentence']);
  const titles = { material: 'Material', time: 'Time', structure: 'Structure', initiative: 'Initiative' };
  for (const key of Object.keys(titles)) {
    const factor = result[key];
    assert.equal(factor.key, key);
    assert.equal(factor.title, titles[key]);
    assert.ok(SYMBOLS.includes(factor.symbol));
    assert.equal(factor.label, SYMBOL_LABELS[factor.symbol]);
    assertVoice(factor.sentence);
    assert.equal('timeTrouble' in factor, key === 'time');
  }
  assert.equal(result.label, SYMBOL_LABELS[result.symbol]);
});

/* ---------------------------------------------------------------- material */

test('material: each step against a month of take-home pay ($3,000.00)', () => {
  const steps = [
    [90000, 'winning'], [89999, 'clear_plus'],
    [45000, 'clear_plus'], [44999, 'slight_plus'],
    [12000, 'slight_plus'], [11999, 'equal'],
    [0, 'equal'], [-11999, 'equal'],
    [-12000, 'slight_minus'], [-44999, 'slight_minus'],
    [-45000, 'clear_minus'], [-900000, 'clear_minus'],
  ];
  for (const [invested, symbol] of steps) {
    assert.equal(assess(board({ invested }), NOW).material.symbol, symbol, String(invested));
  }
});

test('material: winning needs cash and cards together above zero', () => {
  const owing = board({ cash: 100000, invested: 90000, card: { now: 200000 } });
  assert.equal(assess(owing, NOW).material.symbol, 'clear_plus');
  const level = board({ cash: 200000, invested: 90000, card: { now: 200000 } });
  assert.equal(assess(level, NOW).material.symbol, 'clear_plus');
  const ahead = board({ cash: 200001, invested: 90000, card: { now: 200000 } });
  assert.equal(assess(ahead, NOW).material.symbol, 'winning');
});

test('material: with no pay detected the steps are $1,200 / $600 / $150', () => {
  const steps = [
    [120000, 'winning'], [119999, 'clear_plus'],
    [60000, 'clear_plus'], [59999, 'slight_plus'],
    [15000, 'slight_plus'], [14999, 'equal'],
    [-14999, 'equal'], [-15000, 'slight_minus'],
    [-59999, 'slight_minus'], [-60000, 'clear_minus'],
  ];
  for (const [invested, symbol] of steps) {
    assert.equal(assess(board({ invested, pay: 0 }), NOW).material.symbol, symbol, String(invested));
  }
});

test('material: a stream that is inactive, irregular or paid into a hidden account is not pay', () => {
  for (const change of [{ active: false }, { cadence: null }, { amount: 0 }]) {
    const state = board({ invested: 59999 });
    Object.assign(state.streams[0], change);
    assert.equal(assess(state, NOW).material.symbol, 'slight_plus', JSON.stringify(change));
  }
  const hidden = board({ invested: 59999 });
  hidden.accounts.push(bank('acc_old', 'checking', 0, { hidden: true }));
  hidden.streams[0].accountId = 'acc_old';
  assert.equal(assess(hidden, NOW).material.symbol, 'slight_plus');
});

test('material: pay of every cadence is brought to a month', () => {
  // $1,500.00 every two weeks is $3,250.00 a month: 30% of it is $975.00.
  const state = board({ invested: 97500 });
  Object.assign(state.streams[0], { cadence: 'biweekly', amount: 150000, anchor: '2026-05-29' });
  assert.equal(assess(state, NOW).material.symbol, 'winning');
  state.txs.find((row) => row.accountId === 'acc_inv').amount = 97499;
  assert.equal(assess(state, NOW).material.symbol, 'clear_plus');
});

test('material: the sentence gives the change and its share of a month of pay', () => {
  assert.equal(assess(board({ invested: 41230 }), NOW).material.sentence,
    'Net worth moved +$412.30 in the last 30 days, about 14% of a month of take-home pay.');
  assert.equal(assess(board({ invested: -21200 }), NOW).material.sentence,
    'Net worth moved −$212.00 in the last 30 days, about 7% of a month of take-home pay.');
  assert.equal(assess(board(), NOW).material.sentence,
    'Net worth moved $0.00 in the last 30 days, about 0% of a month of take-home pay.');
  assert.equal(assess(board({ invested: 41230, pay: 0 }), NOW).material.sentence,
    'Net worth moved +$412.30 in the last 30 days; no regular pay is detected to measure it against.');
});

test('material: only the last 30 days count', () => {
  const state = board();
  state.txs.push(moved('acc_inv', '2026-05-11', 500000), moved('acc_inv', '2026-05-12', 12000));
  assert.equal(assess(state, NOW).material.sentence,
    'Net worth moved +$120.00 in the last 30 days, about 4% of a month of take-home pay.');
});

test('material: unclear with under 14 days of history', () => {
  const young = assess(quiet({ firstDay: '2026-05-28' }), NOW).material;
  assert.equal(young.symbol, 'unclear');
  assert.equal(young.label, 'Unclear');
  assert.equal(young.sentence, '14 days on record so far; the 30-day change in net worth is read from day 15 on record.' /* ruling R6: today is counted */);
  const none = assess(quiet({ firstDay: null }), NOW).material;
  assert.equal(none.symbol, 'unclear');
  assert.equal(none.sentence, '0 days on record so far; the 30-day change in net worth is read from day 15 on record.');
  const oneDay = assess(quiet({ firstDay: '2026-06-09' }), NOW).material;
  assert.equal(oneDay.sentence, '2 days on record so far; the 30-day change in net worth is read from day 15 on record.');
});

test('material: read from day 14, and a short history is named as such', () => {
  const fortnight = assess(quiet({ firstDay: '2026-05-27' }), NOW).material;
  assert.equal(fortnight.symbol, 'equal');
  assert.equal(fortnight.sentence, 'Net worth moved −$1.00 in the 15 days on record; no regular pay is detected to measure it against.');
  const thirty = assess(quiet({ firstDay: '2026-05-11' }), NOW).material;
  assert.equal(thirty.sentence, 'Net worth moved $0.00 in the last 30 days; no regular pay is detected to measure it against.');
});

/* -------------------------------------------------------------------- time */

test('time: each step of the runway at $100.00 a day', () => {
  const steps = [
    [0, 'clear_minus'], [69999, 'clear_minus'],
    [70000, 'slight_minus'], [139999, 'slight_minus'],
    [140000, 'equal'], [299999, 'equal'],
    [300000, 'slight_plus'], [899999, 'slight_plus'],
    [900000, 'clear_plus'], [1799999, 'clear_plus'],
    [1800000, 'winning'], [9000000, 'winning'],
  ];
  for (const [cash, symbol] of steps) {
    assert.equal(assess(board({ cash, burn: 10000 }), NOW).time.symbol, symbol, String(cash));
  }
});

test('time: trouble is the clock\'s — a runway under 7 days or a shortfall', () => {
  assert.equal(assess(board({ cash: 69999, burn: 10000 }), NOW).time.timeTrouble, true);
  assert.equal(assess(board({ cash: 70000, burn: 10000 }), NOW).time.timeTrouble, false);
  assert.equal(assess(board(), NOW).time.timeTrouble, false);
});

test('time: unclear when the daily outflow is unknown', () => {
  const time = assess(board({ cash: 94800 }), NOW).time;
  assert.equal(time.symbol, 'unclear');
  assert.equal(time.sentence, 'Cash on hand is $948.00; the daily outflow is not known yet.');
});

test('time: a shortfall before payday is losing, whatever the runway', () => {
  const state = board({ cash: 21240 });
  state.streams[0].cadence = 'biweekly';
  state.streams[0].anchor = '2026-05-29';
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 64000, cadence: 'monthly', anchor: '2026-05-11', category: 'housing' }));
  const time = assess(state, NOW).time;
  assert.equal(time.symbol, 'losing');
  assert.equal(time.timeTrouble, true);
  assert.equal(time.sentence, 'Cash on hand is $212.40; ≈$640.00 is due before Fri, Jun 12, ≈$427.60 more than the cash.');
  state.accounts[0].balance = 64000;
  assert.equal(assess(state, NOW).time.symbol, 'unclear');
});

test('time: with no payday known, what is due is counted over the next 14 days', () => {
  const state = board({ cash: 21240, burn: 10000, pay: 0 });
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 64000, cadence: 'monthly', anchor: '2026-05-15', category: 'housing' }));
  const time = assess(state, NOW).time;
  assert.equal(time.symbol, 'losing');
  assert.equal(time.sentence, 'Cash on hand is $212.40; ≈$640.00 is due in the next 14 days, ≈$427.60 more than the cash.');
});

test('time: the sentence gives cash, the days it covers and the next payday', () => {
  assert.equal(assess(board({ cash: 230000, burn: 10000 }), NOW).time.sentence,
    'Cash of $2,300.00 covers about 23 days at $100.00 a day; the next payday is Thu, Jun 25.');
  assert.equal(assess(board({ cash: 10000, burn: 10000, pay: 0 }), NOW).time.sentence,
    'Cash of $100.00 covers about 1 day at $100.00 a day.');
  assert.equal(assess(board({ cash: 9999, burn: 10000, pay: 0 }), NOW).time.sentence,
    'Cash of $99.99 covers under 1 day at $100.00 a day.');
});

/* --------------------------------------------------------------- structure */

const structure = (card, now = NOW) => assess(board({ card }), now).structure;

test('structure: no card debt is a clear advantage', () => {
  const noCard = assess(board(), NOW).structure;
  assert.equal(noCard.symbol, 'clear_plus');
  assert.equal(noCard.sentence, 'No card balance is carried as of Jun 10.');
  assert.equal(structure({ now: 0, april: 5000, may: 5000 }).symbol, 'clear_plus');
  assert.equal(structure({ now: -2500 }).symbol, 'clear_plus');
});

test('structure: two months that both ended lower', () => {
  const both = structure({ now: 300000, april: -10000, may: -10000 });
  assert.equal(both.symbol, 'slight_plus');
  assert.equal(both.sentence, 'Card balance ended April $100.00 lower and May $100.00 lower; June is on pace to end where it began.');
});

test('structure: two lower months that cut the balance by 10% or more are a clear advantage', () => {
  // Owed $3,000.00 going into April; $2,700.00 now.
  assert.equal(structure({ now: 270000, april: -20000, may: -10000 }).symbol, 'clear_plus');
  assert.equal(structure({ now: 270000, april: -20000, may: -9999 }).symbol, 'slight_plus');
  assert.equal(structure({ now: 270000, april: -1, may: -80000 }).symbol, 'clear_plus');
});

test('structure: one month lower and one higher goes by the net', () => {
  const netLower = structure({ now: 300000, april: -20000, may: 5000 });
  assert.equal(netLower.symbol, 'equal');
  assert.equal(netLower.sentence, 'Card balance ended April $200.00 lower and May $50.00 higher; June is on pace to end where it began.');
  assert.equal(structure({ now: 300000, april: 5000, may: -20000 }).symbol, 'equal');
  assert.equal(structure({ now: 300000, april: -5000, may: 20000 }).symbol, 'slight_minus');
  assert.equal(structure({ now: 300000, april: 20000, may: -5000 }).symbol, 'slight_minus');
  assert.equal(structure({ now: 300000, april: 5000, may: -5000 }).symbol, 'equal');
});

test('structure: two months that both ended higher are clearly worse', () => {
  assert.equal(structure({ now: 300000, april: 1, may: 1 }).symbol, 'clear_minus');
});

test('structure: a month that ended where it began counts with the net', () => {
  const flat = structure({ now: 300000 });
  assert.equal(flat.symbol, 'equal');
  assert.equal(flat.sentence, 'Card balance ended April where it began and May where it began; June is on pace to end where it began.');
  assert.equal(structure({ now: 300000, may: -10000 }).symbol, 'equal');
  assert.equal(structure({ now: 300000, april: 10000 }).symbol, 'slight_minus');
});

test('structure: one step worse when this month is on pace to end more than 2% higher', () => {
  // Ten days in, a charge of C puts June on pace to end 3C above its start of $3,000.00 − C.
  const under = structure({ now: 300000, april: -10000, may: -10000, june: 1986 });
  assert.equal(under.symbol, 'slight_plus');
  const over = structure({ now: 300000, april: -10000, may: -10000, june: 1987 });
  assert.equal(over.symbol, 'equal');
  assert.equal(over.sentence, 'Card balance ended April $100.00 lower and May $100.00 lower; June is on pace to end ≈$59.61 higher.');
  assert.equal(structure({ now: 270000, april: -20000, may: -10000, june: 5000 }).symbol, 'slight_plus');
  assert.equal(structure({ now: 300000, april: -5000, may: 20000, june: 5000 }).symbol, 'clear_minus');
  assert.equal(structure({ now: 300000, april: 5000, may: 5000, june: 5000 }).symbol, 'losing');
});

test('structure: a month on pace to end lower changes nothing', () => {
  const paying = structure({ now: 300000, april: 5000, may: 5000, june: -20000 });
  assert.equal(paying.symbol, 'clear_minus');
  assert.equal(paying.sentence, 'Card balance ended April $50.00 higher and May $50.00 higher; June is on pace to end ≈$200.00 lower.');
});

test('structure: unclear with card debt and no complete month', () => {
  for (const firstDay of ['2026-06-02', '2026-05-02']) {
    const state = quiet({ firstDay });
    addCard(state, { now: 412000, june: 3000 });
    const result = assess(state, NOW).structure;
    assert.equal(result.symbol, 'unclear', firstDay);
    assert.equal(result.sentence, 'Card balance is $4,120.00 as of Jun 10; its direction is read after 1 complete month of history.');
  }
});

test('structure: one complete month is read alone', () => {
  const oneMonth = (may, june = 0) => {
    const state = quiet({ firstDay: '2026-05-01' });
    addCard(state, { now: 300000, may, june });
    return assess(state, NOW).structure;
  };
  const lower = oneMonth(-8000);
  assert.equal(lower.symbol, 'slight_plus');
  assert.equal(lower.sentence, 'Card balance ended May $80.00 lower; June is on pace to end where it began.');
  assert.equal(oneMonth(8000).symbol, 'slight_minus');
  assert.equal(oneMonth(0).symbol, 'equal');
  assert.equal(oneMonth(-8000, 5000).symbol, 'equal');
});

/* -------------------------------------------------------------- initiative */

test('initiative: each step of what was kept of $1,000.00 earned this month', () => {
  const steps = [
    [0, 'clear_plus'], [80000, 'clear_plus'], [80001, 'slight_plus'],
    [92000, 'slight_plus'], [92001, 'equal'],
    [100000, 'equal'], [100001, 'slight_minus'],
    [110000, 'slight_minus'], [110001, 'clear_minus'], [500000, 'clear_minus'],
  ];
  for (const [out, symbol] of steps) {
    assert.equal(assess(board({ income: 100000, out }), NOW).initiative.symbol, symbol, String(out));
  }
});

test('initiative: the sentence gives what was earned, what was kept and the share', () => {
  assert.equal(assess(board({ income: 214000, out: 182980 }), NOW).initiative.sentence,
    'June to date: $2,140.00 earned, +$310.20 kept, 14%.');
  assert.equal(assess(board({ income: 214000, out: 226000 }), NOW).initiative.sentence,
    'June to date: $2,140.00 earned, −$120.00 kept, −6%.');
  assert.equal(assess(board({ income: 100000, out: 100000 }), NOW).initiative.sentence,
    'June to date: $1,000.00 earned, $0.00 kept, 0%.');
  assert.equal(assess(board({ income: 100000, out: 100001 }), NOW).initiative.sentence,
    'June to date: $1,000.00 earned, −$0.01 kept, 0%.');
});

test('initiative: unclear when nothing was earned this month', () => {
  const initiative = assess(board({ out: 5000 }), NOW).initiative;
  assert.equal(initiative.symbol, 'unclear');
  assert.equal(initiative.sentence, 'Nothing was earned in June as of Jun 10, so there is no share kept to read.');
});

test('initiative: unclear while the month is under 3 days old', () => {
  const state = board({ income: 100000 });
  const second = assess(state, at(2026, 6, 2)).initiative;
  assert.equal(second.symbol, 'unclear');
  assert.equal(second.sentence, 'June is 2 days old; the share kept of what was earned is read from day 3.');
  const first = assess(state, at(2026, 6, 1)).initiative;
  assert.equal(first.sentence, 'June is 1 day old; the share kept of what was earned is read from day 3.');
  assert.equal(assess(state, at(2026, 6, 3)).initiative.symbol, 'clear_plus');
});

test('initiative: the game day decides how old the month is', () => {
  const state = board({ income: 100000 });
  assert.equal(assess(state, at(2026, 6, 3, 2)).initiative.symbol, 'unclear');
  assert.equal(assess(state, at(2026, 6, 3, 5)).initiative.symbol, 'clear_plus');
});

/* ----------------------------------------------------------------- verdict */

function symbolsOf(result) {
  return [result.material.symbol, result.time.symbol, result.structure.symbol, result.initiative.symbol];
}

test('verdict: time weighs most — the example of the specification', () => {
  const result = assess(board({ cash: 60000, burn: 10000, income: 100000, out: 100000, card: { now: 300000, april: -20000, may: 5000 } }), NOW);
  assert.deepEqual(symbolsOf(result), ['equal', 'clear_minus', 'equal', 'equal']);
  // 35% × −2 = −0.70
  assert.equal(result.symbol, 'slight_minus');
  assert.equal(result.label, 'Slightly worse');
  assert.equal(result.sentence, 'Slightly worse — level on material, short on time.');
});

test('verdict: the four weights are 20 / 35 / 25 / 20', () => {
  const result = assess(board({ cash: 70000, burn: 10000, invested: 45000, income: 100000, out: 100000, card: { now: 300000, april: 5000, may: 5000 } }), NOW);
  assert.deepEqual(symbolsOf(result), ['clear_plus', 'slight_minus', 'clear_minus', 'equal']);
  // 20% × 2 + 35% × −1 + 25% × −2 = −0.45
  assert.equal(result.symbol, 'equal');
  assert.equal(result.sentence, 'Equal — ahead on material, weak on structure.');
});

test('verdict: half a step rounds away from equal, less than half does not', () => {
  const up = assess(board({ cash: 140000, burn: 10000, income: 100000, out: 100000 }), NOW);
  assert.deepEqual(symbolsOf(up), ['equal', 'equal', 'clear_plus', 'equal']);
  assert.equal(up.symbol, 'slight_plus');
  assert.equal(up.sentence, 'Slight advantage — level on material, sound on structure.');

  const down = assess(board({ cash: 140000, burn: 10000, income: 100000, out: 100000, card: { now: 100000, april: 5000, may: 5000 } }), NOW);
  assert.deepEqual(symbolsOf(down), ['equal', 'equal', 'clear_minus', 'equal']);
  assert.equal(down.symbol, 'slight_minus');
  assert.equal(down.sentence, 'Slightly worse — level on material, weak on structure.');

  const under = assess(board({ cash: 300000, burn: 10000, income: 100000, out: 100000, card: { now: 100000 } }), NOW);
  assert.deepEqual(symbolsOf(under), ['equal', 'slight_plus', 'equal', 'equal']);
  assert.equal(under.symbol, 'equal');
  assert.equal(under.sentence, 'Equal — level on material, ahead on time.');
});

test('verdict: every factor at its best is winning', () => {
  const result = assess(board({ cash: 1800000, burn: 10000, income: 100000 }), NOW);
  assert.deepEqual(symbolsOf(result), ['winning', 'winning', 'clear_plus', 'clear_plus']);
  // 0.60 + 1.05 + 0.50 + 0.40 = 2.55
  assert.equal(result.symbol, 'winning');
  assert.equal(result.sentence, 'Winning — ahead on material, ahead on time.');
});

test('verdict: every factor at its worst is losing, and the two furthest from equal are named', () => {
  const state = board({ cash: 1000, burn: 10000, invested: -90000, income: 100000, out: 150000, card: { now: 300000, april: 5000, may: 5000, june: 5000 } });
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 64000, cadence: 'monthly', anchor: '2026-05-15', category: 'housing' }));
  const result = assess(state, NOW);
  assert.deepEqual(symbolsOf(result), ['clear_minus', 'losing', 'losing', 'clear_minus']);
  // −0.40 − 1.05 − 0.75 − 0.40 = −2.60
  assert.equal(result.symbol, 'losing');
  assert.equal(result.sentence, 'Losing — short on time, weak on structure.');
});

test('verdict: unclear factors are left out and the weights renormalised', () => {
  const state = quiet({ cash: 21240, firstDay: '2026-06-01' });
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 64000, cadence: 'monthly', anchor: '2026-05-15', category: 'housing' }));
  const result = assess(state, NOW);
  assert.deepEqual(symbolsOf(result), ['unclear', 'losing', 'clear_plus', 'unclear']);
  // (35 × −3 + 25 × 2) / 60 = −0.92
  assert.equal(result.symbol, 'slight_minus');
  assert.equal(result.sentence, 'Slightly worse — short on time, sound on structure.');
});

test('verdict: one readable factor stands alone', () => {
  const result = assess(quiet({ firstDay: null }), NOW);
  assert.deepEqual(symbolsOf(result), ['unclear', 'unclear', 'clear_plus', 'unclear']);
  assert.equal(result.symbol, 'clear_plus');
  assert.equal(result.sentence, 'Clear advantage — sound on structure.');
});

test('verdict: unclear when every factor is unclear', () => {
  const state = quiet({ firstDay: null });
  addCard(state, { now: 100000 });
  state.txs.push(spend('acc_card', '2026-06-01', 2500, 'shopping'));
  const result = assess(state, NOW);
  assert.deepEqual(symbolsOf(result), ['unclear', 'unclear', 'unclear', 'unclear']);
  assert.equal(result.symbol, 'unclear');
  assert.equal(result.label, 'Unclear');
  assert.equal(result.sentence, 'Unclear — no factor can be read yet.');
});

test('assess does not change the document and survives malformed input', () => {
  const state = board({ cash: 60000, burn: 10000, income: 100000, out: 40000, card: { now: 300000, april: -20000, may: 5000, june: 3000 } });
  const before = JSON.stringify(state);
  assess(state, NOW);
  assert.equal(JSON.stringify(state), before);

  for (const broken of [null, undefined, 5, {}, { accounts: 'x', txs: [null, 7, {}], streams: [null], recurring: [null, {}] }]) {
    assertNoNaN(assess(broken, NOW));
    assertNoNaN(assess(broken, NaN));
  }
  const odd = board({ burn: 10000, income: 100000, card: { now: 300000, april: -1000, may: 2000 } });
  odd.txs.push(null, { id: 'tx_bad', amount: 'lots', day: 'someday' }, makeTx({ id: 'tx_nan', accountId: 'acc_chk', day: '2026-06-04', amount: NaN }));
  odd.accounts.push(null, { id: 'acc_bad' });
  odd.streams.push(null, makeStream({ id: 'str_bad', cadence: 'fortnightly', amount: NaN, active: true }));
  const result = assess(odd, NOW);
  assertNoNaN(result);
  for (const key of ['material', 'time', 'structure', 'initiative']) assertVoice(result[key].sentence);
});

/* ------------------------------------------------------------ coach's notes */

test('notes: a quiet document has none', () => {
  assert.deepEqual(coachNotes(quiet(), NOW), []);
  assert.deepEqual(coachNotes(defaultState(NOW), NOW), []);
});

test('notes: a note is { key, priority, text, cta }', () => {
  const state = quiet();
  state.txs.push(spend('acc_chk', '2026-06-02', 1800, 'other', { review: true }));
  const [note] = coachNotes(state, NOW);
  assert.deepEqual(Object.keys(note), ['key', 'priority', 'text', 'cta']);
  assert.deepEqual(note, {
    key: 'review', priority: 15,
    text: '1 move is waiting for a purpose, the oldest from Jun 2.',
    cta: { label: 'Review', href: '#/scoresheet?filter=review' },
  });
});

test('notes: the bank link was revoked', () => {
  const state = quiet();
  state.sync.status = 'relink';
  const note = noteOf(state, 'relink');
  assert.equal(note.priority, 100);
  assert.equal(note.text, 'The bank link was revoked; figures are as of Wed, Jun 10. Link again to resume.');
  assert.deepEqual(note.cta, { label: 'Link again', href: '#/settings' });
  state.sync.lastOk = null;
  assert.equal(noteOf(state, 'relink').text, 'The bank link was revoked before a 1st sync completed. Link again to resume.');
});

test('notes: the last sync failed', () => {
  const state = quiet();
  state.sync.status = 'error';
  state.sync.error = 'HTTP 500';
  assert.equal(noteOf(state, 'sync-error').text, 'The last bank sync did not complete; figures are as of Wed, Jun 10. The next open tries again.');
  state.sync.lastOk = null;
  assert.equal(noteOf(state, 'sync-error').text, 'The 1st bank sync did not complete. The next open tries again.');
  assert.equal(noteOf(state, 'relink'), null);
});

test('notes: the provider reports a broken connection, with the Bridge link', () => {
  const state = quiet();
  state.sync.problems = [{ connId: 'c1', name: 'Northwind Bank', message: 'Credentials expired' }];
  const note = noteOf(state, 'bank-problem');
  assert.equal(note.text, '1 bank connection reports a problem at SimpleFIN Bridge. It is fixed there, not here.');
  assert.deepEqual(note.cta, { label: 'Open SimpleFIN Bridge', href: 'https://bridge.simplefin.org/' });
  state.sync.problems.push({ connId: 'c2', name: 'Harbor Credit Union', message: 'Timed out' });
  assert.equal(noteOf(state, 'bank-problem').text, '2 bank connections report a problem at SimpleFIN Bridge. It is fixed there, not here.');
});

test('notes: one bank-link note at a time, the gravest first', () => {
  const state = quiet();
  state.sync.status = 'relink';
  state.sync.problems = [{ connId: 'c1', name: 'Northwind Bank', message: 'Credentials expired' }];
  const keys = allNotes(state).map((note) => note.key);
  assert.deepEqual(keys, ['relink']);
});

test('notes: bank data that is aging or old', () => {
  const state = quiet();
  state.sync.lastOk = NOW - 40 * 3600000;
  const aging = noteOf(state, 'stale');
  assert.equal(aging.priority, 95);
  assert.equal(aging.text, 'Bank data is as of Mon, Jun 8, about 40 hours old. Net worth holds still until the next sync.');
  assert.deepEqual(aging.cta, { label: 'Check the bank', action: 'app.refresh' });
  state.sync.lastOk = NOW - 80 * 3600000;
  assert.equal(noteOf(state, 'stale').text, 'Bank data is as of Sun, Jun 7, about 3 days old. Net worth holds still until the next sync.');
});

test('notes: fresh data, or a bank never synced, is not stale', () => {
  const state = quiet();
  state.sync.lastOk = NOW - 36 * 3600000;
  assert.equal(noteOf(state, 'stale'), null);
  state.sync.lastOk = NOW - 36 * 3600000 - 1;
  assert.notEqual(noteOf(state, 'stale'), null);
  state.sync.lastOk = null;
  assert.equal(noteOf(state, 'stale'), null);
});

test('notes: a revoked or failing link already says how old the figures are', () => {
  const state = quiet();
  state.sync.lastOk = NOW - 80 * 3600000;
  state.sync.status = 'relink';
  assert.deepEqual(allNotes(state).map((note) => note.key), ['relink']);
  state.sync.status = 'ok';
  state.sync.problems = [{ connId: 'c1', name: 'Northwind Bank', message: 'Credentials expired' }];
  assert.deepEqual(allNotes(state).map((note) => note.key), ['bank-problem', 'stale']);
});

test('notes: a shortfall before payday', () => {
  const state = board({ cash: 21240 });
  state.streams[0].cadence = 'biweekly';
  state.streams[0].anchor = '2026-05-29';
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 64000, cadence: 'monthly', anchor: '2026-05-11', category: 'housing', source: 'manual', since: '2026-06-01' }));
  const note = noteOf(state, 'shortfall');
  assert.equal(note.key, 'shortfall:2026-06-12');
  assert.equal(note.priority, 90);
  assert.equal(note.text, 'Cash: $212.40 on the clock, ≈$640.00 due before Fri, Jun 12.');
  assert.deepEqual(note.cta, { label: 'What is due', href: '#/book' });
  state.accounts[0].balance = 64000;
  assert.equal(noteOf(state, 'shortfall'), null);
});

test('notes: a shortfall with no payday known', () => {
  const state = quiet({ cash: 21240 });
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 64000, cadence: 'monthly', anchor: '2026-05-15', category: 'housing', source: 'manual', since: '2026-06-01' }));
  const note = noteOf(state, 'shortfall');
  assert.equal(note.key, 'shortfall:next-14-days');
  assert.equal(note.text, 'Cash: $212.40 on the clock, ≈$640.00 due in the next 14 days.');
});

test('notes: an open sweep', () => {
  const state = startMatch(quiet());
  const toReserve = noteOf(state, 'sweep');
  assert.equal(toReserve.key, 'sweep:2026-06-01');
  assert.equal(toReserve.priority, 80);
  assert.equal(toReserve.text, 'Last week you kept $115 against habit. Move it to the reserve.');
  assert.deepEqual(toReserve.cta, { label: 'Move it', action: 'app.sheet', data: { sheet: 'sweep' } });
  addCard(state, { now: 300000 });
  assert.equal(noteOf(state, 'sweep').text, 'Last week you kept $115 against habit. Move it to the card.');
});

test('notes: no sweep before the match, once it is recorded, or under $5', () => {
  assert.equal(noteOf(quiet(), 'sweep'), null);
  const recorded = startMatch(quiet());
  recorded.sweeps.push({ weekOf: '2026-06-01', amount: 11500, day: '2026-06-09', txId: null, via: 'tap' });
  assert.equal(noteOf(recorded, 'sweep'), null);
  const thin = startMatch(quiet());
  thin.txs.push(spend('acc_chk', '2026-06-03', 11100, 'eating_out'));
  assert.equal(noteOf(thin, 'sweep'), null);
});

test('notes: a business purchase whose return check is due', () => {
  const state = quiet();
  const purchase = spend('acc_chk', '2026-03-03', 48000, 'gear', { purpose: 'studio', payback: { by: '2026-06-01', via: 'lessons', outcome: null } });
  state.txs.push(purchase);
  const note = noteOf(state, 'payback');
  assert.equal(note.key, 'payback:' + purchase.id);
  assert.equal(note.priority, 70);
  assert.equal(note.text, 'The $480.00 business purchase of Mar 3 was to pay back by Jun 1. Its return check is open.');
  assert.deepEqual(note.cta, { label: 'Answer', action: 'app.sheet', data: { sheet: 'tx', id: purchase.id } });
  purchase.payback.outcome = 'notyet';
  assert.notEqual(noteOf(state, 'payback'), null);
  purchase.payback.by = '2026-06-10';
  assert.notEqual(noteOf(state, 'payback'), null);
});

test('notes: no return check note once answered, or before it is due', () => {
  for (const payback of [{ by: '2026-06-01', via: '', outcome: 'yes' }, { by: '2026-06-01', via: '', outcome: 'no' }, { by: '2026-06-11', via: '', outcome: null }, { by: '', via: '', outcome: null }, null]) {
    const state = quiet();
    state.txs.push(spend('acc_chk', '2026-03-03', 48000, 'gear', { purpose: 'studio', payback }));
    assert.equal(noteOf(state, 'payback'), null, JSON.stringify(payback));
  }
});

test('notes: the return check due longest comes first', () => {
  const state = quiet();
  const later = spend('acc_chk', '2026-03-03', 48000, 'gear', { purpose: 'studio', payback: { by: '2026-06-01', via: '', outcome: null } });
  const earlier = spend('acc_chk', '2026-03-20', 9000, 'software', { purpose: 'work', payback: { by: '2026-05-01', via: '', outcome: null } });
  state.txs.push(later, earlier);
  assert.equal(noteOf(state, 'payback').key, 'payback:' + earlier.id);
});

/* ---------------------------------------------------------- notes: the Book */

function withEntry(fields, charges) {
  const state = quiet();
  const entry = makeRecurring({ id: 'rec_x', name: 'Streamly', mkey: 'streamly', accountId: 'acc_chk', amount: 1599, cadence: 'monthly', anchor: '2026-06-05', source: 'detected', ...fields });
  state.recurring.push(entry);
  for (const [day, amount] of charges) {
    state.txs.push(spend('acc_chk', day, amount, 'subscriptions', { recurringId: 'rec_x', klass: 'book' }));
  }
  return state;
}

test('notes: new in the Book', () => {
  const state = withEntry({}, [['2026-05-05', 1599], ['2026-06-05', 1599]]);
  const note = noteOf(state, 'book:new');
  assert.equal(note.key, 'book:new:rec_x');
  assert.equal(note.priority, 62);
  assert.equal(note.text, 'New in the Book: Streamly, $15.99 monthly since May 5. $192 a year.');
  assert.deepEqual(note.cta, { label: 'Open', action: 'app.sheet', data: { sheet: 'recurring', id: 'rec_x' } });
});

test('notes: an entry needing three charges is new at its third', () => {
  const state = withEntry({ amount: 6400, variable: true }, [['2026-04-06', 6100], ['2026-05-06', 6900], ['2026-06-05', 6400]]);
  assert.equal(noteOf(state, 'book:new').text, 'New in the Book: Streamly, $64.00 monthly since Apr 6. $768 a year.');
  const weekly = withEntry({ cadence: 'weekly', amount: 1200 }, [['2026-05-15', 1200], ['2026-05-22', 1200], ['2026-05-29', 1200], ['2026-06-05', 1200]]);
  assert.equal(noteOf(weekly, 'book:new').text, 'New in the Book: Streamly, $12.00 weekly since May 15. $624 a year.');
});

test('notes: an entry is not new when it is established, touched, old news or as old as the history', () => {
  const established = withEntry({}, [['2026-04-05', 1599], ['2026-05-05', 1599], ['2026-06-05', 1599]]);
  assert.equal(noteOf(established, 'book:new'), null);
  for (const fields of [{ locks: ['amount'] }, { verdict: 'keep' }, { source: 'manual' }, { active: false }]) {
    assert.equal(noteOf(withEntry(fields, [['2026-05-05', 1599], ['2026-06-05', 1599]]), 'book:new'), null, JSON.stringify(fields));
  }
  const oldNews = withEntry({ anchor: '2026-05-27' }, [['2026-04-27', 1599], ['2026-05-27', 1599]]);
  assert.equal(noteOf(oldNews, 'book:new'), null);
  const stillNews = withEntry({ anchor: '2026-05-28' }, [['2026-04-28', 1599], ['2026-05-28', 1599]]);
  assert.notEqual(noteOf(stillNews, 'book:new'), null);
  const fromTheStart = withEntry({}, [['2026-03-05', 1599], ['2026-06-05', 1599]]);
  assert.equal(noteOf(fromTheStart, 'book:new'), null);
  assert.equal(noteOf(withEntry({}, []), 'book:new'), null);
  assert.equal(noteOf(withEntry({ amount: NaN }, [['2026-05-05', 1599], ['2026-06-05', 1599]]), 'book:new'), null);
});

test('notes: a price change in the Book', () => {
  const state = withEntry({ amount: 1799, anchor: '2026-06-03' }, [['2026-04-03', 1599], ['2026-05-03', 1599], ['2026-06-03', 1799]]);
  const note = noteOf(state, 'book:price');
  assert.equal(note.key, 'book:price:rec_x:2026-06-03');
  assert.equal(note.priority, 60);
  assert.equal(note.text, 'Streamly went from $15.99 to $17.99 on Jun 3. +$24 a year.');
  const cheaper = withEntry({ amount: 1299, anchor: '2026-06-03' }, [['2026-04-03', 1599], ['2026-05-03', 1599], ['2026-06-03', 1299]]);
  assert.equal(noteOf(cheaper, 'book:price').text, 'Streamly went from $15.99 to $12.99 on Jun 3. −$36 a year.');
});

test('notes: no price note for a bill that moves, a steady price, or old news', () => {
  const moving = withEntry({ variable: true }, [['2026-04-03', 1599], ['2026-05-03', 1599], ['2026-06-03', 1799]]);
  assert.equal(noteOf(moving, 'book:price'), null);
  const jitter = withEntry({}, [['2026-04-03', 6512], ['2026-05-03', 6540], ['2026-06-03', 6498]]);
  assert.equal(noteOf(jitter, 'book:price'), null);
  const steady = withEntry({}, [['2026-04-03', 1599], ['2026-05-03', 1599], ['2026-06-03', 1599]]);
  assert.equal(noteOf(steady, 'book:price'), null);
  const oldNews = withEntry({}, [['2026-03-27', 1599], ['2026-04-27', 1599], ['2026-05-27', 1799]]);
  assert.equal(noteOf(oldNews, 'book:price'), null);
  const twoCharges = withEntry({}, [['2026-05-03', 1599], ['2026-06-03', 1799]]);
  assert.equal(noteOf(twoCharges, 'book:price'), null);
});

test('notes: an entry that seems to have ended', () => {
  // Monthly: lapsed on the 46th day after its last charge — 5 June for a charge on 20 April.
  const state = withEntry({ name: 'Gymflex', amount: 3900, anchor: '2026-04-20', active: false }, []);
  const note = noteOf(state, 'book:ended');
  assert.equal(note.key, 'book:ended:rec_x');
  assert.equal(note.priority, 58);
  assert.equal(note.text, 'Gymflex was last charged Apr 20 and seems to have ended. $39.00 monthly is out of the Book.');
});

test('notes: no ended note for an entry the owner dismissed, an active one, or one long gone', () => {
  for (const fields of [{ locks: ['active'] }, { source: 'manual' }, { active: true }, { anchor: '2026-04-11' }, { anchor: '' }]) {
    const state = withEntry({ name: 'Gymflex', amount: 3900, anchor: '2026-04-20', active: false, ...fields }, []);
    assert.equal(noteOf(state, 'book:ended'), null, JSON.stringify(fields));
  }
  const lastDay = withEntry({ name: 'Gymflex', amount: 3900, anchor: '2026-04-12', active: false }, []);
  assert.notEqual(noteOf(lastDay, 'book:ended'), null);
  const today = withEntry({ name: 'Gymflex', amount: 3900, anchor: '2026-04-25', active: false }, []);
  assert.notEqual(noteOf(today, 'book:ended'), null);
});

test('notes: a renewal within 21 days', () => {
  const state = quiet();
  state.recurring.push(makeRecurring({ id: 'rec_dom', name: 'Domain Hosting', accountId: 'acc_chk', amount: 11900, cadence: 'annual', anchor: '2025-06-26', source: 'manual' }));
  const note = noteOf(state, 'renewal');
  assert.equal(note.key, 'renewal:rec_dom:2026-06-26');
  assert.equal(note.priority, 50);
  assert.match(note.text, /^Domain Hosting renews Fri, Jun 26, in 16 days, at ≈\$119\.00\. About \$113\.\d\d of it has accrued\.$/);
  assert.deepEqual(note.cta, { label: 'Open', action: 'app.sheet', data: { sheet: 'recurring', id: 'rec_dom' } });
});

test('notes: the renewal window is today to 21 days out, for entries quarterly or longer', () => {
  const renewalOn = (anchor, cadence = 'annual') => {
    const state = quiet();
    state.recurring.push(makeRecurring({ id: 'rec_dom', name: 'Domain Hosting', accountId: 'acc_chk', amount: 11900, cadence, anchor, source: 'manual' }));
    return noteOf(state, 'renewal');
  };
  assert.equal(renewalOn('2025-06-10').text.slice(0, 45), 'Domain Hosting renews today at ≈$119.00. Abou');
  assert.match(renewalOn('2025-06-11').text, /^Domain Hosting renews Thu, Jun 11, in 1 day, at ≈\$119\.00\./);
  assert.notEqual(renewalOn('2025-07-01'), null);
  assert.equal(renewalOn('2025-07-02'), null);
  assert.equal(renewalOn('2025-06-09'), null);
  assert.notEqual(renewalOn('2026-03-20', 'quarterly'), null);
  assert.equal(renewalOn('2026-05-20', 'monthly'), null);
});

/* ------------------------------------------------------------ notes: cards */

test('notes: this month\'s card pace, after the first week', () => {
  const state = quiet();
  addCard(state, { now: 300000, june: 2000 });
  const note = noteOf(state, 'card-pace');
  assert.equal(note.key, 'card-pace:2026-06');
  assert.equal(note.priority, 45);
  assert.equal(note.text, 'Card balance is on pace to end June ≈$60.00 higher than it began, at ≈$3,040.00.');
  assert.deepEqual(note.cta, { label: 'Card cycle', href: '#/material' });
  assert.equal(noteOf(state, 'card-month'), null);

  const paying = quiet();
  addCard(paying, { now: 300000, june: -25000 });
  assert.equal(noteOf(paying, 'card-pace').text, 'Card balance is on pace to end June ≈$250.00 lower than it began, at ≈$3,000.00.');
  const flat = quiet();
  addCard(flat, { now: 300000 });
  assert.equal(noteOf(flat, 'card-pace').text, 'Card balance is on pace to end June where it began, at ≈$3,000.00.');
});

test('notes: last month\'s card verdict, in the first week of a month', () => {
  const state = quiet();
  addCard(state, { now: 300000, may: -18000 });
  for (const day of [1, 7]) {
    const now = at(2026, 6, day);
    const note = noteOf(state, 'card-month', now);
    assert.equal(note.key, 'card-month:2026-05');
    assert.equal(note.text, 'Card balance ended May $180.00 lower than it began, at $3,000.00.');
    assert.equal(noteOf(state, 'card-pace', now), null);
  }
  assert.equal(noteOf(state, 'card-month', at(2026, 6, 8)), null);
  assert.notEqual(noteOf(state, 'card-pace', at(2026, 6, 8)), null);

  const higher = quiet();
  addCard(higher, { now: 300000, may: 5812 });
  assert.equal(noteOf(higher, 'card-month', at(2026, 6, 5)).text, 'Card balance ended May $58.12 higher than it began, at $3,000.00.');
});

test('notes: no card note without card debt, or for a month the history does not cover', () => {
  assert.equal(noteOf(quiet(), 'card-pace'), null);
  const cleared = quiet();
  addCard(cleared, { now: 0 });
  assert.equal(noteOf(cleared, 'card-pace'), null);
  assert.equal(noteOf(cleared, 'card-month', at(2026, 6, 5)), null);
  const young = quiet({ firstDay: '2026-05-15' });
  addCard(young, { now: 300000 });
  assert.equal(noteOf(young, 'card-month', at(2026, 6, 5)), null);
});

test('notes: interest and fees charged last month', () => {
  const state = quiet();
  addCard(state, { now: 300000, apr: 24 });
  state.txs.push(spend('acc_card', '2026-05-28', 5812, 'fees_interest'));
  const note = noteOf(state, 'interest');
  assert.equal(note.key, 'interest:2026-05');
  assert.equal(note.priority, 40);
  assert.equal(note.text, 'Cards charged $58.12 in interest and fees in May. About $1.97 a day at the balance now.');
  state.accounts.find((account) => account.id === 'acc_card').apr = null;
  assert.equal(noteOf(state, 'interest').text, 'Cards charged $58.12 in interest and fees in May.');
});

test('notes: no interest note when none was charged last month', () => {
  const state = quiet();
  addCard(state, { now: 300000, apr: 24, may: 9000 });
  state.txs.push(spend('acc_card', '2026-04-28', 5812, 'fees_interest'), spend('acc_card', '2026-06-02', 5812, 'fees_interest'));
  assert.equal(noteOf(state, 'interest'), null);
});

/* --------------------------------------------------------- notes: the game */

test('notes: a category target', () => {
  const state = quiet();
  state.settings.targets = { cafe: 15000 };
  state.txs.push(spend('acc_chk', '2026-05-12', 21280, 'cafe'), spend('acc_chk', '2026-06-03', 3860, 'cafe'));
  const note = noteOf(state, 'target');
  assert.equal(note.key, 'target:cafe:2026-06');
  assert.equal(note.priority, 35);
  assert.equal(note.text, 'Coffee & cafes: $38.60 in June against a $150 target. May finished at $212.80.');
  assert.deepEqual(note.cta, { label: 'Scoresheet', href: '#/scoresheet' });
});

test('notes: the target furthest along is the one shown, and a target in cents keeps them', () => {
  const state = quiet();
  state.settings.targets = { cafe: 15000, eating_out: 4050, delivery: 2000, groceries: 0 };
  state.txs.push(spend('acc_chk', '2026-06-03', 3860, 'cafe'), spend('acc_chk', '2026-06-04', 3000, 'eating_out'), spend('acc_chk', '2026-06-04', 9000, 'groceries'));
  const note = noteOf(state, 'target');
  assert.equal(note.key, 'target:eating_out:2026-06');
  assert.equal(note.text, 'Delis & restaurants: $30.00 in June against a $40.50 target.');
});

test('notes: no target note without a target, or with nothing spent against one', () => {
  const state = quiet();
  state.txs.push(spend('acc_chk', '2026-06-03', 3860, 'cafe'));
  assert.equal(noteOf(state, 'target'), null);
  state.settings.targets = { delivery: 5000 };
  assert.equal(noteOf(state, 'target'), null);
  state.settings.targets = 'none';
  assert.equal(noteOf(state, 'target'), null);
});

test('notes: repeat stops this month', () => {
  const state = startMatch(quiet());
  state.txs.push(
    spend('acc_chk', '2026-06-08', 450, 'cafe', { at: at(2026, 6, 8, 8) }),
    spend('acc_chk', '2026-06-08', 650, 'eating_out', { at: at(2026, 6, 8, 13) }),
    spend('acc_chk', '2026-06-09', 500, 'cafe', { at: at(2026, 6, 9, 8) }),
  );
  const note = noteOf(state, 'stacked');
  assert.equal(note.key, 'stacked:2026-06');
  assert.equal(note.priority, 30);
  assert.equal(note.text, 'A 2nd or later stop on 1 day in June: those stops came to $6.50.');
  state.txs.push(spend('acc_chk', '2026-06-09', 900, 'delivery', { at: at(2026, 6, 9, 19) }), spend('acc_chk', '2026-06-09', 300, 'convenience', { at: at(2026, 6, 9, 21) }));
  assert.equal(noteOf(state, 'stacked').text, 'A 2nd or later stop on 2 days in June: those stops came to $18.50.');
});

test('notes: no repeat-stop note for single stops, or before the match', () => {
  const single = startMatch(quiet());
  single.txs.push(spend('acc_chk', '2026-06-08', 450, 'cafe'), spend('acc_chk', '2026-06-09', 650, 'cafe'));
  assert.equal(noteOf(single, 'stacked'), null);
  const before = quiet();
  before.txs.push(spend('acc_chk', '2026-06-08', 450, 'cafe'), spend('acc_chk', '2026-06-08', 650, 'cafe'));
  assert.equal(noteOf(before, 'stacked'), null);
});

function withReserve({ arrived = 30000 } = {}) {
  const state = quiet();
  state.accounts.push(bank('acc_sav', 'savings', 80000));
  state.txs.push(spend('acc_chk', '2026-04-20', 600000, 'household'));
  if (arrived) state.txs.push(moved('acc_sav', '2026-06-05', arrived));
  return state;
}

test('notes: a reserve milestone reached in the last 14 days', () => {
  const note = noteOf(withReserve(), 'reserve');
  assert.equal(note.key, 'reserve:1 week');
  assert.equal(note.priority, 25);
  assert.equal(note.text, 'The reserve of $800.00 now covers 1 week of outflow at $100.00 a day. Next: 2 weeks, $1,400.00.');
  assert.deepEqual(note.cta, { label: 'Analysis', href: '#/analysis' });
});

test('notes: no reserve note for a milestone already held 14 days ago, or none reached', () => {
  assert.equal(noteOf(withReserve({ arrived: 0 }), 'reserve'), null);
  assert.equal(noteOf(withReserve({ arrived: 10000 }), 'reserve'), null);
  const short = withReserve();
  short.accounts.find((account) => account.id === 'acc_sav').balance = 9000;
  assert.equal(noteOf(short, 'reserve'), null);
});

test('notes: the reserve goal reached', () => {
  const state = withReserve();
  state.goals.reserve.target = 75000;
  const note = noteOf(state, 'reserve');
  assert.equal(note.key, 'reserve:Goal');
  assert.equal(note.text, 'The reserve reached its goal of $750.00: $800.00 as of Jun 10. Next: 2 weeks, $1,400.00.');
});

test('notes: the scale of the game', () => {
  const state = startMatch(quiet());
  addCard(state, { now: 300000, may: 230000 });
  const note = noteOf(state, 'scale');
  assert.equal(note.key, 'scale:2026-06');
  assert.equal(note.priority, 20);
  // June 2026: 22 workdays at $15.00 and 8 days off at $20.00.
  assert.equal(note.text, 'A perfect month in the daily game is worth $490. Cards took $2,300 in new charges last month.');
  assert.deepEqual(note.cta, { label: 'Analysis', href: '#/analysis' });
});

test('notes: with no card charges last month the Book gives the scale; with neither there is no note', () => {
  const state = startMatch(quiet());
  assert.equal(noteOf(state, 'scale'), null);
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 184000, cadence: 'monthly', anchor: '2026-06-01', category: 'housing', source: 'manual' }));
  assert.equal(noteOf(state, 'scale').text, 'A perfect month in the daily game is worth $490. The Book takes $1,840 a month.');
  const noHabit = quiet();
  addCard(noHabit, { now: 300000, may: 230000 });
  assert.equal(noteOf(noHabit, 'scale'), null);
});

test('notes: moves waiting for a purpose', () => {
  const state = quiet();
  state.txs.push(
    spend('acc_chk', '2026-06-02', 1800, 'other', { review: true }),
    spend('acc_chk', '2026-05-20', 2600, 'shopping', { review: true }),
    spend('acc_chk', '2026-03-10', 900, 'other', { review: true }),
    spend('acc_chk', '2026-06-03', 700, 'other', { review: true, matchId: 'tx_bank', source: 'manual' }),
    tx('acc_chk', '2026-06-04', 500, { kind: 'decline', review: true }),
  );
  assert.equal(noteOf(state, 'review').text, '2 moves are waiting for a purpose, the oldest from May 20.');
});

test('notes: no regular pay detected yet', () => {
  const state = quiet();
  state.settings.smoothing = true;
  const note = noteOf(state, 'no-pay');
  assert.equal(note.priority, 10);
  assert.equal(note.text, 'No regular pay is detected in 101 days on record. Until one is, net worth steps up on each payday.');
  assert.deepEqual(note.cta, { label: 'Income', href: '#/settings' });
});

test('notes: no pay note once pay accrues, when smoothing is switched off, or with no history', () => {
  const accruing = board();
  accruing.settings.smoothing = true;
  accruing.streams[0].accrue = true;
  assert.equal(noteOf(accruing, 'no-pay'), null);
  assert.equal(noteOf(quiet(), 'no-pay'), null);
  const empty = quiet({ firstDay: null });
  empty.settings.smoothing = true;
  assert.equal(noteOf(empty, 'no-pay'), null);
});

/* ----------------------------------------------- notes: order and repetition */

/** A document in which everything calls for a note at once: no pay detected, a $1,640.00 rent due against $1,012.40 of cash. */
function busy() {
  const state = startMatch(board({ cash: 21240, burn: 10000, income: 100000, pay: 0, card: { now: 300000, april: -5000, may: 230000, june: 2000, apr: 24 } }));
  state.settings.smoothing = true;
  state.settings.targets = { cafe: 15000 };
  state.sync.lastOk = NOW - 50 * 3600000;
  state.sync.problems = [{ connId: 'c1', name: 'Northwind Bank', message: 'Credentials expired' }];
  state.recurring.push(
    makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 164000, cadence: 'monthly', anchor: '2026-05-15', category: 'housing', source: 'manual' }),
    makeRecurring({ id: 'rec_dom', name: 'Domain Hosting', accountId: 'acc_chk', amount: 11900, cadence: 'annual', anchor: '2025-06-26', source: 'manual' }),
    makeRecurring({ id: 'rec_new', name: 'Streamly', accountId: 'acc_card', amount: 1599, cadence: 'monthly', anchor: '2026-06-05', source: 'detected' }),
    makeRecurring({ id: 'rec_price', name: 'Cloud Locker', accountId: 'acc_card', amount: 1299, cadence: 'monthly', anchor: '2026-06-03', source: 'detected' }),
    makeRecurring({ id: 'rec_gym', name: 'Gymflex', accountId: 'acc_card', amount: 3900, cadence: 'monthly', anchor: '2026-04-20', source: 'detected', active: false }),
  );
  const book = (id, day, amount) => spend('acc_card', day, amount, 'subscriptions', { recurringId: id, klass: 'book' });
  state.txs.push(
    book('rec_new', '2026-05-05', 1599), book('rec_new', '2026-06-05', 1599),
    book('rec_price', '2026-04-03', 999), book('rec_price', '2026-05-03', 999), book('rec_price', '2026-06-03', 1299),
    spend('acc_card', '2026-05-28', 5812, 'fees_interest'),
    spend('acc_chk', '2026-03-03', 48000, 'gear', { purpose: 'studio', payback: { by: '2026-06-01', via: 'lessons', outcome: null } }),
    spend('acc_chk', '2026-06-08', 450, 'cafe', { at: at(2026, 6, 8, 8) }),
    spend('acc_chk', '2026-06-08', 650, 'cafe', { at: at(2026, 6, 8, 13), review: true }),
  );
  state.accounts.push(bank('acc_sav', 'savings', 80000));
  state.txs.push(moved('acc_sav', '2026-06-05', 30000));
  return state;
}

const BUSY_KEYS = [
  'bank-problem', 'stale', 'shortfall:next-14-days', 'sweep:2026-06-01', 'payback', 'book:new:rec_new',
  'book:price:rec_price:2026-06-03', 'book:ended:rec_gym', 'renewal:rec_dom:2026-06-26', 'card-pace:2026-06',
  'interest:2026-05', 'target:cafe:2026-06', 'stacked:2026-06', 'reserve:1 week', 'scale:2026-06', 'review', 'no-pay',
];

test('notes: every candidate at once, highest priority first', () => {
  const state = busy();
  const notes = allNotes(state);
  assert.deepEqual(notes.map((note) => note.key.startsWith('payback:') ? 'payback' : note.key), BUSY_KEYS);
  const priorities = notes.map((note) => note.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
  assert.equal(new Set(notes.map((note) => note.key)).size, notes.length);
});

test('notes: every note is under 110 characters, carries a number or a date and keeps the voice', () => {
  const state = busy();
  const texts = allNotes(state).map((note) => note.text);
  const firstWeek = quiet();
  addCard(firstWeek, { now: 300000, may: -18000 });
  texts.push(noteOf(firstWeek, 'card-month', at(2026, 6, 5)).text);
  for (const status of ['relink', 'error']) {
    for (const lastOk of [at(2026, 6, 10, 9), null]) {
      const state2 = quiet();
      Object.assign(state2.sync, { status, lastOk });
      texts.push(allNotes(state2)[0].text);
    }
  }
  const goal = withReserve();
  goal.goals.reserve.target = 75000;
  texts.push(noteOf(goal, 'reserve').text);
  assert.equal(texts.length, 23);
  for (const text of texts) {
    assert.ok(text.length < 110, text.length + ': ' + text);
    assertNoteVoice(text);
  }
});

test('notes: long names and large figures still fit', () => {
  const longName = 'INTERNATIONAL  DOMAIN\n& HOSTING SERVICES OF THE GREATER NORTHWEST REGION LLC #4471';
  const state = quiet({ cash: 1 });
  state.settings.targets = { cafe: 123456789 };
  state.txs.push(spend('acc_chk', '2026-05-12', 987654321, 'cafe'), spend('acc_chk', '2026-06-03', 876543219, 'cafe'));
  state.recurring.push(
    makeRecurring({ id: 'rec_dom', name: longName, accountId: 'acc_chk', amount: 1234567890, cadence: 'annual', anchor: '2025-06-26', source: 'manual' }),
    makeRecurring({ id: 'rec_gym', name: longName, accountId: 'acc_chk', amount: 1234567890, cadence: 'monthly', anchor: '2026-04-20', source: 'detected', active: false }),
    makeRecurring({ id: 'rec_new', name: longName, accountId: 'acc_chk', amount: 1234567890, cadence: 'monthly', anchor: '2026-06-05', source: 'detected' }),
    makeRecurring({ id: 'rec_none', name: 42, accountId: 'acc_chk', amount: 500, cadence: 'annual', anchor: '2025-06-20', source: 'manual' }),
  );
  state.txs.push(
    spend('acc_chk', '2026-05-05', 1234567890, 'subscriptions', { recurringId: 'rec_new', klass: 'book' }),
    spend('acc_chk', '2026-06-05', 1234567890, 'subscriptions', { recurringId: 'rec_new', klass: 'book' }),
  );
  const notes = allNotes(state);
  assert.ok(notes.length >= 5);
  for (const note of notes) {
    assert.ok(note.text.length < 110, note.text.length + ': ' + note.text);
    assert.match(note.text, /\d/);
    assert.ok(!note.text.includes('\n'));
  }
  assert.match(noteOf(state, 'book:new').text, /^New in the Book: INTERNATIONAL DOMAIN &…, \$12,345,678\.90 monthly since May 5\./);
  const unnamed = quiet();
  unnamed.recurring.push(makeRecurring({ id: 'rec_none', name: 42, accountId: 'acc_chk', amount: 500, cadence: 'annual', anchor: '2025-06-20', source: 'manual' }));
  assert.match(noteOf(unnamed, 'renewal').text, /^A Book entry renews Sat, Jun 20, in 10 days, at ≈\$5\.00\./);
});

test('notes: at most three by default, or the limit asked for', () => {
  const state = busy();
  assert.deepEqual(coachNotes(state, NOW).map((note) => note.key), BUSY_KEYS.slice(0, 3));
  assert.deepEqual(coachNotes(state, NOW, {}).map((note) => note.key), BUSY_KEYS.slice(0, 3));
  assert.deepEqual(coachNotes(state, NOW, { limit: 1 }).map((note) => note.key), ['bank-problem']);
  assert.deepEqual(coachNotes(state, NOW, { limit: 0 }), []);
  assert.deepEqual(coachNotes(state, NOW, { limit: -2 }), []);
  assert.equal(coachNotes(state, NOW, { limit: 2.9 }).length, 2);
  assert.equal(coachNotes(state, NOW, { limit: NaN }).length, 3);
});

test('notes: a note runs for three days, then rests until 14 days after it was first shown', () => {
  const shownOn = (day) => {
    const state = quiet();
    state.txs.push(spend('acc_chk', '2026-06-02', 1800, 'other', { review: true }));
    state.meta.notesSeen = { review: day };
    return noteOf(state, 'review') !== null;
  };
  assert.equal(shownOn('2026-06-10'), true);
  assert.equal(shownOn('2026-06-09'), true);
  assert.equal(shownOn('2026-06-08'), true);
  assert.equal(shownOn('2026-06-07'), false);
  assert.equal(shownOn('2026-06-01'), false);
  assert.equal(shownOn('2026-05-28'), false);
  assert.equal(shownOn('2026-05-27'), true);
  assert.equal(shownOn('2026-04-01'), true);
  assert.equal(shownOn('2026-06-12'), true);
  assert.equal(shownOn('not a day'), true);
  assert.equal(shownOn(null), true);
});

test('notes: the rule holds for every kind of note', () => {
  const state = busy();
  const keys = allNotes(state).map((note) => note.key);
  state.meta.notesSeen = Object.fromEntries(keys.map((key) => [key, '2026-06-05']));
  assert.deepEqual(allNotes(state).map((note) => note.key), ['bank-problem', 'stale']);
  state.meta.notesSeen = Object.fromEntries(keys.map((key) => [key, '2026-06-09']));
  assert.equal(allNotes(state).length, keys.length);
});

test('notes: the bank-link and old-data notes never rest', () => {
  for (const [status, key] of [['relink', 'relink'], ['error', 'sync-error']]) {
    const state = quiet();
    state.sync.status = status;
    state.meta.notesSeen = { [key]: '2026-06-05' };
    assert.notEqual(noteOf(state, key), null, key);
  }
  const stale = quiet();
  stale.sync.lastOk = NOW - 80 * 3600000;
  stale.sync.problems = [{ connId: 'c1', name: 'Northwind Bank', message: 'Credentials expired' }];
  stale.meta.notesSeen = { stale: '2026-06-05', 'bank-problem': '2026-06-05' };
  assert.deepEqual(allNotes(stale).map((note) => note.key), ['bank-problem', 'stale']);
});

test('notes: a resting note makes room for the next', () => {
  const state = busy();
  state.meta.notesSeen = { 'shortfall:next-14-days': '2026-06-05', 'sweep:2026-06-01': '2026-06-01' };
  const keys = coachNotes(state, NOW).map((note) => note.key);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys.slice(0, 2), ['bank-problem', 'stale']);
  assert.match(keys[2], /^payback:/);
});

test('notes: coachNotes never changes the document', () => {
  const state = busy();
  state.meta.notesSeen = { review: '2026-06-01', 'old:note': '2026-01-01' };
  const before = JSON.stringify(state);
  coachNotes(state, NOW, { limit: 50 });
  coachNotes(state, NOW);
  assert.equal(JSON.stringify(state), before);
});

test('notes: malformed documents give no notes and never throw', () => {
  for (const broken of [null, undefined, 5, {}, { meta: null, sync: 'x', settings: 7 }, { txs: [null, 3, {}], recurring: [null, {}, { id: 'r', cadence: 'monthly' }], accounts: [null, {}] }]) {
    assert.deepEqual(coachNotes(broken, NOW, { limit: 50 }), []);
    assert.deepEqual(coachNotes(broken, NaN), []);
  }
  const odd = busy();
  odd.txs.push(null, { id: 'tx_bad', amount: 'lots', day: 'someday', review: true, recurringId: 'rec_new' });
  odd.recurring.push(null, { id: 'rec_bad', cadence: 'sometimes', active: true }, makeRecurring({ id: 'rec_nan', amount: NaN, anchor: 'x' }));
  odd.meta.notesSeen = null;
  odd.sync.problems = 'none';
  const notes = allNotes(odd);
  assertNoNaN(notes);
  for (const note of notes) assertNoteVoice(note.text);
});

/* ------------------------------------------------------------ monthReview */

/**
 * May 2026, played from the 1st. Checking: two cafe stops on the 12th ($4.50, $6.50) and a $40.00
 * sweep to savings on the 19th. Card: $50.00 of charges in May after a $200.00 payment in April.
 * In June: $1,000.00 received and $200.00 leaving the investment account.
 */
function mayGame() {
  const state = startMatch(board({ income: 100000, out: 20000, card: { now: 300000, april: -20000, may: 5000 } }), '2026-05-01');
  state.txs.push(
    spend('acc_chk', '2026-05-12', 450, 'cafe', { at: at(2026, 5, 12, 8) }),
    spend('acc_chk', '2026-05-12', 650, 'cafe', { at: at(2026, 5, 12, 13) }),
    moved('acc_chk', '2026-05-19', -4000, { id: 'tx_sweep' }),
  );
  state.sweeps.push({ weekOf: '2026-05-11', amount: 4000, day: '2026-05-19', txId: 'tx_sweep', via: 'tap' });
  state.days['2026-05-13'] = { plan: { ready: [{ label: 'Bag packed', yes: true }], stops: 0, at: at(2026, 5, 13, 7) } };
  return state;
}

test('monthReview: a completed month, in the fixed order', () => {
  const state = mayGame();
  const review = monthReview(state, '2026-05', NOW);
  assert.deepEqual(Object.keys(review), ['ym', 'complete', 'card', 'cash', 'netWorth', 'score', 'review', 'scale']);
  assert.equal(review.ym, '2026-05');
  assert.equal(review.complete, true);
  assert.deepEqual(review.card, {
    change: 5000, start: 295000, end: 300000,
    sentence: 'Card balance ended May $50.00 higher than it began: $2,950.00 to $3,000.00.',
  });
  assert.deepEqual(review.cash, { change: -5100, sentence: 'Cash moved −$51.00 in May, to $4,000.00.' });
  assert.deepEqual(review.netWorth, { change: -10100, sentence: 'Net worth moved −$101.00 in May, to $11,200.00.' });
});

test('monthReview: the score is the month\'s crosstable', () => {
  const state = mayGame();
  const review = monthReview(state, '2026-05', NOW);
  const table = monthTable(state, '2026-05', NOW);
  assert.deepEqual(Object.keys(review.score), ['score', 'played', 'black', 'white', 'kept', 'perfect', 'estimated']);
  assert.deepEqual(review.score, {
    score: table.score, played: table.played, black: table.black, white: table.white, kept: table.kept, perfect: table.perfect,
    estimated: false, // every round of May is final
  });
  // 21 workdays at $15.00 and 10 days off at $20.00. The 12th, at $11.00, is past the $7.00 win line and inside the $15.00 loss line: a draw.
  assert.equal(review.score.played, 31);
  assert.equal(review.score.perfect, 51500);
  assert.equal(review.score.kept, 51500 - 1100);
  assert.equal(review.score.score, 30.5);
  assert.deepEqual(review.score.black, { score: 20.5, played: 21 });
  assert.deepEqual(review.score.white, { score: 10, played: 10 });
});

test('monthReview: annotation counts, the best move and the costliest move', () => {
  const state = mayGame();
  const review = monthReview(state, '2026-05', NOW);
  const table = monthTable(state, '2026-05', NOW);
  assert.deepEqual(review.review, reviewRounds(table.rounds, { sweepTxIds: new Set(['tx_sweep']) }));
  // 20 clean workdays (the planned one among them) are !!; the sweep is !; the 2nd stop of the 12th is ?!.
  assert.equal(review.review.counts['!!'], 20);
  assert.equal(review.review.counts['!'], 1);
  assert.equal(review.review.counts['?!'], 1);
  assert.equal(review.review.stackedDays, 1);
  assert.equal(review.review.stackedCost, 650);
  assert.deepEqual(review.review.prepared, { rounds: 1, score: 1 });
  assert.deepEqual(review.review.best, { day: '2026-05-02', text: 'Clean sheet on a day off' });
  assert.deepEqual(review.review.costliest, { day: '2026-05-12', text: 'Coffee & cafes', amount: 650 });
});

test('monthReview: the scale sentence sets the daily game beside the cards', () => {
  const state = mayGame();
  assert.equal(monthReview(state, '2026-05', NOW).scale, 'A perfect month in the daily game is worth $515. Cards took $50 in new charges in May.');
  assert.equal(monthReview(state, '2026-06', NOW).scale, 'A perfect month in the daily game is worth $490.');
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 184000, cadence: 'monthly', anchor: '2026-06-01', category: 'housing', source: 'manual' }));
  assert.equal(monthReview(state, '2026-06', NOW).scale, 'A perfect month in the daily game is worth $490. The Book takes $1,840 a month.');
  assert.equal(monthReview(board(), '2026-05', NOW).scale, '');
});

test('monthReview: the current month is read so far, and the card by its pace', () => {
  const state = mayGame();
  state.txs.push(spend('acc_card', '2026-06-05', 2000, 'shopping'));
  const review = monthReview(state, '2026-06', NOW);
  assert.equal(review.complete, false);
  assert.deepEqual(review.card, {
    change: 2000, start: 298000, end: 300000,
    sentence: 'Card balance is on pace to end June ≈$60.00 higher than it began, at ≈$3,040.00.',
  });
  assert.deepEqual(review.cash, { change: 100000, sentence: 'Cash moved +$1,000.00 so far in June, to $5,000.00.' });
  assert.deepEqual(review.netWorth, { change: 78000, sentence: 'Net worth moved +$780.00 so far in June, to $12,000.00.' });
  assert.equal(review.score.played, 9);
  assert.equal(review.scale, 'A perfect month in the daily game is worth $490. Cards took $20 in new charges so far in June.');
});

test('monthReview: no card verdict without cards, before the history, or ahead of today', () => {
  assert.equal(monthReview(board(), '2026-05', NOW).card, null);
  const state = mayGame();
  assert.equal(monthReview(state, '2026-02', NOW).card, null);
  assert.equal(monthReview(state, '2025-01', NOW).card, null);
  const ahead = monthReview(state, '2026-07', NOW);
  assert.equal(ahead.card, null);
  assert.equal(ahead.complete, false);
  assert.equal(ahead.cash.change, 0);
  assert.equal(ahead.netWorth.change, 0);
  assert.equal(ahead.score.played, 0);
  const cleared = board({ card: { now: 0 } });
  assert.equal(monthReview(cleared, '2026-05', NOW).card, null);
});

test('monthReview: an older month reaches as far back as the history', () => {
  const state = mayGame();
  const april = monthReview(state, '2026-04', NOW);
  assert.deepEqual(april.card, {
    change: -20000, start: 315000, end: 295000,
    sentence: 'Card balance ended April $200.00 lower than it began: $3,150.00 to $2,950.00.',
  });
  const march = monthReview(state, '2026-03', NOW);
  assert.equal(march.card.sentence, 'Card balance ended March where it began: $3,150.00 to $3,150.00.');
  assert.deepEqual(march.cash, { change: -100, sentence: 'Cash moved −$1.00 in March, to $4,051.00.' });
});

test('monthReview: sentences keep the voice', () => {
  const state = mayGame();
  for (const ym of ['2026-04', '2026-05', '2026-06']) {
    const review = monthReview(state, ym, NOW);
    for (const text of [review.card.sentence, review.cash.sentence, review.netWorth.sentence, review.scale]) assertVoice(text);
  }
});

test('monthReview: malformed input gives an empty review, never a throw or NaN', () => {
  const state = mayGame();
  const before = JSON.stringify(state);
  for (const ym of ['June', '', null, undefined, 202606, '2026-13', '2026-6', '0000-01']) {
    const review = monthReview(state, ym, NOW);
    assertNoNaN(review);
    assert.equal(review.card, null);
    assert.equal(review.score.played, 0);
    assert.equal(review.review.best, null);
  }
  assert.equal(monthReview(state, 'June', NOW).cash.sentence, '');
  assert.equal(JSON.stringify(state), before);
  for (const broken of [null, undefined, 5, {}, { txs: [null], accounts: [null], sweeps: 'x' }]) {
    const review = monthReview(broken, '2026-05', NOW);
    assertNoNaN(review);
    assert.equal(review.card, null);
    assert.equal(review.cash.change, 0);
    assert.equal(review.scale, '');
  }
});

/* ------------------------------------------- notes: overdue, pay that stopped, pay on arrival */

test('notes: a Book charge past its day with no charge posted', () => {
  const state = quiet();
  state.recurring.push(makeRecurring({ id: 'rec_rent', name: 'Workspace rent', accountId: 'acc_chk', amount: 64000, cadence: 'monthly', anchor: '2026-05-05', category: 'housing', source: 'manual' }));
  const note = noteOf(state, 'overdue');
  assert.equal(note.key, 'overdue:rec_rent:2026-06-05');
  assert.equal(note.priority, 88);
  assert.equal(note.text, 'Workspace rent: ≈$640.00 was due Fri, Jun 5 and has not posted. It stays in what is due, 5 days on.');
  assertVoice(note.text);
  assert.deepEqual(note.cta, { label: 'What is due', href: '#/book' });
  state.recurring[0].active = false;
  assert.equal(noteOf(state, 'overdue'), null);
});

test('notes: pay that stopped is named with the day of its last deposit, and is not called missing', () => {
  const state = board();
  state.settings.smoothing = true;
  state.streams[0].accrue = true;
  state.streams[0].anchor = '2026-03-25';
  state.txs.push(income('2026-02-25', 300000), income('2026-03-25', 300000));
  for (const tx of state.txs.slice(-2)) tx.streamId = 'str_pay';
  const note = noteOf(state, 'pay-lapsed');
  assert.equal(note.key, 'pay-lapsed:str_pay');
  assert.equal(note.priority, 85);
  assert.equal(note.text, 'No deposit from Northwind Payroll since Mar 25. 77 days on, its pay is no longer counted.');
  assertVoice(note.text);
  assert.equal(noteOf(state, 'no-pay'), null);
});

test('T4: a stream counted on arrival whose deposits stopped is named, and Material does not say pay is counted when it arrives', () => {
  const state = board();
  state.streams[0].accrue = false;
  state.streams[0].anchor = '2026-03-25';
  state.txs.push(income('2026-02-25', 300000), income('2026-03-25', 300000));
  for (const tx of state.txs.slice(-2)) tx.streamId = 'str_pay';
  const note = noteOf(state, 'pay-lapsed');
  assert.equal(note.key, 'pay-lapsed:str_pay');
  assert.equal(note.text, 'No deposit from Northwind Payroll since Mar 25. 77 days on, its payday is no longer expected.');
  assertVoice(note.text);
  assert.equal(noteOf(state, 'no-pay'), null);
  assert.ok(!assess(state, NOW).material.sentence.includes('counted when it arrives'), assess(state, NOW).material.sentence);
});

test('notes: pay the owner counts on arrival is not reported as missing', () => {
  const state = board();
  state.settings.smoothing = true;
  state.streams[0].accrue = false;
  state.streams[0].locks = ['accrue'];
  assert.equal(noteOf(state, 'no-pay'), null);
  state.streams[0].locks = [];
  assert.notEqual(noteOf(state, 'no-pay'), null);
});

test('notes: card pace takes off the payment the Book still schedules this month, and says so', () => {
  const state = quiet();
  addCard(state, { now: 300000, june: 2000 });
  state.recurring.push(makeRecurring({ id: 'rec_pay', name: 'Card payment', accountId: 'acc_chk', toAccountId: 'acc_card', amount: 25000, cadence: 'monthly', anchor: '2026-05-20', category: 'loan', source: 'manual', since: '2026-05-01' }));
  const note = noteOf(state, 'card-pace');
  assert.equal(note.text, 'Cards are on pace to end June ≈$190.00 lower, at ≈$2,790.00, after ≈$250.00 still scheduled.');
  assertVoice(note.text);
});

test('month review: a card in credit owes nothing and the pace line says so', () => {
  const state = quiet();
  addCard(state, { now: -398701, june: 1799 });
  const review = monthReview(state, '2026-06', NOW);
  assert.equal(review.card.sentence, 'Cards are $3,987.01 in credit as of Jun 10: nothing is owed, and June is on pace to end that way.');
  assertVoice(review.card.sentence);
  assert.equal(noteOf(state, 'card-pace'), null);
  assert.equal(assess(state, NOW).structure.sentence, 'No card balance is carried as of Jun 10.');
});

/* ---- round two ---- */

test('R2: a 20-cent monthly interest stream is not a month of take-home pay', () => {
  const state = board({ pay: 0, out: 420000 });
  state.streams.push(makeStream({
    id: 'str_int', name: 'Interest earned', mkey: 'interest', kind: 'interest', accountId: 'acc_chk',
    cadence: 'monthly', anchor: '2026-05-31', amount: 20,
  }));
  const { sentence } = assess(state, NOW).material;
  assert.ok(!sentence.includes('%'), sentence);
  assert.match(sentence, /no regular pay is detected to measure it against\.$/);
  assertVoice(sentence);
});

test('R2: a share of pay over 999% is never printed; the clause is dropped', () => {
  // $200.00 a month of pay and a move of $4,200.00 out: 2100% of a month of pay.
  const { sentence } = assess(board({ pay: 20000, out: 420000 }), NOW).material;
  assert.ok(!sentence.includes('%'), sentence);
  assert.match(sentence, /^Net worth moved .*\$4,2\d\d\.\d\d in the last 30 days\.$/);
  // Under the limit the clause stays.
  assert.match(assess(board({ pay: 300000, out: 420000 }), NOW).material.sentence, /, about 1\d\d% of a month of take-home pay\.$/);
});

test('R4d: the Material change carries the sign when the smoothed figure holds an estimate, and not otherwise', () => {
  const state = board({ out: 30000 });
  assert.match(assess(state, NOW).material.sentence, /^Net worth moved −\$/, 'nothing accrues here: a fact');
  const ledger = makeLedger(state, NOW);
  const accruing = { ...ledger, position: () => ({ ...ledger.position(), smoothing: true }) };
  assert.match(assess(state, NOW, { ledger: accruing }).material.sentence, /^Net worth moved ≈−\$/);
});

test('R3a: before day 7 the Structure sentence and the card review read no pace and say so', () => {
  const early = at(2026, 6, 5);
  const state = board({ card: { now: 300000, april: -10000, may: -10000, june: 5000 } });
  const { sentence } = assess(state, early).structure;
  assert.match(sentence, /; a pace for June is read from day 7 of the month\.$/);
  assert.ok(!sentence.includes('≈'), sentence);
  const review = monthReview(state, '2026-06', early);
  assert.match(review.card.sentence, /^Card balance is \$[\d,]+\.\d\d as of Jun 5\. A pace is read from day 7 of the month\.$/);
  assert.equal(coachNotes(state, at(2026, 6, 8), { limit: 50 }).some((note) => note.key.startsWith('card-pace:')), true);
});

test('T5: before day 7 the month review keeps saying a card in credit is in credit', () => {
  const state = board({ card: { now: -50000, april: -10000, may: -10000, june: 5000 } }); // $500.00 in credit
  const review = monthReview(state, '2026-06', at(2026, 6, 5));
  assert.equal(review.card.sentence, 'Cards are $500.00 in credit as of Jun 5: nothing is owed. A pace is read from day 7 of the month.');
});

test('R1: while pay is awaited the sentences never call today the next payday', () => {
  const state = board({ burn: 5000 });
  const ledger = makeLedger(state, NOW);
  const awaited = { ...ledger, clock: () => ({ ...ledger.clock(), nextPayday: '2026-06-10', payAwaited: '2026-06-08', dueUntil: '2026-06-25' }) };
  const time = assess(state, NOW, { ledger: awaited }).time;
  assert.match(time.sentence, / a day\. Pay expected Mon, Jun 8 is not on the bank’s record yet\.$/);
  assert.ok(!time.sentence.includes('has not arrived'), time.sentence);
  assert.ok(!time.sentence.includes('next payday'), time.sentence);
  const short = { ...ledger, clock: () => ({ ...awaited.clock(), shortfall: 14000, dueTotal: 514000 }) };
  assert.match(assess(state, NOW, { ledger: short }).time.sentence, /is due through Thu, Jun 25, /);
  const note = coachNotes(state, NOW, { limit: 50, ledger: short }).find((item) => item.key.startsWith('shortfall'));
  assert.match(note.text, /, ≈\$5,140\.00 due through Thu, Jun 25\.$/);
});

test('T1: on the payday itself and in the two grace days the window is today alone, in words too', () => {
  const state = board({ burn: 5000 });
  const ledger = makeLedger(state, NOW);
  const withClock = (fields) => ({ ...ledger, clock: () => ({ ...ledger.clock(), ...fields }) });
  const payday = withClock({ nextPayday: '2026-06-10', payAwaited: null, dueUntil: '2026-06-10' });
  const today = assess(state, NOW, { ledger: payday }).time.sentence;
  assert.match(today, / a day\. Payday is today\.$/);
  assert.ok(!today.includes('next payday'), today);
  const grace = withClock({ nextPayday: '2026-06-10', payAwaited: '2026-06-09', dueUntil: '2026-06-10', shortfall: 14000, dueTotal: 514000 });
  assert.match(assess(state, NOW, { ledger: grace }).time.sentence, /; ≈\$5,140\.00 is due today, ≈\$140\.00 more than the cash\.$/);
  const note = coachNotes(state, NOW, { limit: 50, ledger: grace }).find((item) => item.key.startsWith('shortfall'));
  assert.match(note.text, /, ≈\$5,140\.00 due today\.$/);
  const waiting = withClock({ nextPayday: '2026-06-10', payAwaited: '2026-06-09', dueUntil: '2026-06-10' });
  assert.match(assess(state, NOW, { ledger: waiting }).time.sentence, /Pay expected Tue, Jun 9 is not on the bank’s record yet\.$/);
});

test('R4e: the month review marks what was kept as an estimate while a counted round is in pencil', () => {
  const state = mayGame();
  const ledger = makeLedger(state, NOW);
  const table = ledger.monthTable('2026-05');
  const pencil = { ...ledger, monthTable: () => ({ ...table, rounds: table.rounds.map((round, i) => (i === table.rounds.length - 1 ? { ...round, status: 'provisional' } : round)) }) };
  assert.equal(monthReview(state, '2026-05', NOW, { ledger: pencil }).score.estimated, true);
  assert.equal(monthReview(state, '2026-05', NOW, { ledger }).score.estimated, false);
});

test('a ledger handed in through opts gives the same assessment, notes and review', () => {
  const state = busy();
  const opts = { ledger: makeLedger(state, NOW) };
  assert.deepEqual(assess(state, NOW, opts), assess(state, NOW));
  assert.deepEqual(coachNotes(state, NOW, { limit: 50, ...opts }), coachNotes(state, NOW, { limit: 50 }));
  assert.deepEqual(monthReview(state, '2026-06', NOW, opts), monthReview(state, '2026-06', NOW));
});
