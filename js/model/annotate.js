/**
 * Annotation symbols for moves and rounds. See ARCHITECTURE.md section 7.
 * Pure. Imports: schema, money. It works on a Round (from ledger.round) — it does not compute one.
 */

import { CATEGORIES, GLYPHS, categoryLabel } from './schema.js';
import { fmt } from './money.js';

const BRILLIANT = '!!';
const GOOD = '!';
const OPEN = '!?';
const DUBIOUS = '?!';
const MISTAKE = '?';
const PENALTY = '??';
const BOX = '□';

/** What is given up first when a round carries more annotations than one move in four. */
const DROP_ORDER = [BOX, OPEN, GOOD];
const MOVES_PER_ANNOTATION = 4;
const DECLINES_MARKED = 2;
const BUSINESS_MINIMUM = 5000;
const PENALTY_CATEGORY = 'fees_interest';
const FORCED_CATEGORIES = { housing: 'Housing payment', debt_service: 'Loan payment' };
const PAYBACK_WORDS = { yes: [GOOD, 'paid back'], no: [MISTAKE, 'not paid back'] };
const RESULT_WORDS = { 1: 'a win', 0.5: 'a draw', 0: 'a loss' };

/*
 * How the specification is read where it leaves a choice:
 *  - A '??' on a spend in Interest & fees is the classifier's (not manual); any other valid `glyph`
 *    on a move is the owner's own. A `glyph` that is not a key of schema.GLYPHS is ignored.
 *  - Stops are numbered over the whole day, work stops included, so the count agrees with
 *    Round.stops; a stop with a purpose other than personal never takes '?!' or '?' (rule 8).
 *    Rule 8 guards the stop symbols only: the '?' of a business purchase that did not pay back
 *    (rule 6) is given as rule 6 says.
 *  - A sweep is the one move whose id is recorded (payment or transfer). A payment outside the Book
 *    is marked on the leg that left an account; the receiving leg is marked only when it has no
 *    paired leg on the sheet.
 *  - Over the limit of one move in four, the smallest amount of a symbol goes first, then the later move.
 *  - "Played to the morning plan" needs a plan that states its stops.
 *  - A stacked stop (reviewRounds) is exactly a stop rule 4 marks: unplanned, and the 2nd or later
 *    stop of the day.
 */

/**
 * @typedef {Object} Annotation
 * @property {string} glyph     one of the keys of schema.GLYPHS
 * @property {string} why       a short plain reason ("2nd unplanned stop today"), shown on the move's detail
 * @property {boolean} manual   true when it is the owner's own override
 */

/**
 * Annotate the moves of one round.
 * Rules, in order (ARCHITECTURE section 7):
 *  1. A move's manual `glyph` wins.
 *  2. A classification glyph '??' (avoidable penalty) stays.
 *  3. Declines: the first two of the day get '!'; later ones are bare.
 *  4. Stops (game-class spends in stop categories), in the order played: the first `plan.stops` stops
 *     (or any stop with `planned`) are book moves and bare; of the remaining (unplanned) stops the
 *     2nd stop of the day overall gets '?!' and the 3rd and later get '?'. With no plan, the 1st stop is bare.
 *  5. A payment that is a recorded sweep, or a card payment not linked to the Book, gets '!'.
 *  6. A business purchase (purpose not 'personal', klass 'oneoff', amount >= 5000 cents): '!?' while its
 *     payback outcome is null or 'notyet', '!' when 'yes', '?' when 'no'.
 *  7. Book charges in housing or debt_service get the only-move box.
 *  8. Negative symbols ('?!', '?') are never given to need / want / book / oneoff moves or to non-personal purposes.
 *  9. At most one move in four is annotated (rounded up, minimum 1); when over, drop boxes first, then '!?',
 *     then '!' — never drop manual glyphs, '??', '?!' or '?'.
 * The round itself gets '!!' for a clean-sheet workday (final or provisional), else '!' when it was played to
 * the morning plan (a plan exists, stops <= plan.stops, and the result is a win), else nothing.
 * @param {import('./ledger.js').Round} round
 * @param {{ sweepTxIds?: Set<string> }} [ctx]
 * @returns {{ moves: Map<string, Annotation>, round: Annotation|null }}  moves is keyed by Tx id
 */
export function annotateRound(round, ctx) {
  if (!isObject(round)) return { moves: new Map(), round: null };
  const moves = movesOf(round);
  const marks = { stops: stopMarks(round, moves), declines: declineMarks(moves), sweepIds: sweepIdsOf(ctx) };
  const found = [];
  moves.forEach((tx, order) => {
    const annotation = typeof tx.id === 'string' ? annotationFor(tx, marks) : null;
    if (annotation) found.push({ tx, order, annotation });
  });
  const kept = withinLimit(found, Math.max(1, Math.ceil(moves.length / MOVES_PER_ANNOTATION)));
  return {
    moves: new Map(kept.map((entry) => [entry.tx.id, entry.annotation])),
    round: roundAnnotation(round),
  };
}

/**
 * Counts of each glyph over many rounds (for the monthly review), plus the best and costliest moves.
 * @param {import('./ledger.js').Round[]} rounds
 * @param {{ sweepTxIds?: Set<string> }} [ctx]
 * @returns {{ counts: Object<string, number>, best: { day: string, text: string }|null, costliest: { day: string, text: string, amount: number }|null,
 *             stackedDays: number, stackedCost: number, prepared: { rounds: number, score: number }, unprepared: { rounds: number, score: number } }}
 *   stackedDays = rounds with 2 or more unplanned stops; stackedCost = what the 2nd and later unplanned stops cost;
 *   prepared = rounds that had a morning plan; best = the round with the largest kept (text like "Clean sheet on a workday");
 *   costliest = the single game-class move with the largest amount
 */
export function reviewRounds(rounds, ctx) {
  const review = {
    counts: Object.fromEntries(Object.keys(GLYPHS).map((glyph) => [glyph, 0])),
    best: null, costliest: null, stackedDays: 0, stackedCost: 0,
    prepared: { rounds: 0, score: 0 }, unprepared: { rounds: 0, score: 0 },
  };
  let best = null;
  for (const round of Array.isArray(rounds) ? rounds : []) {
    if (!isObject(round) || round.status === 'prematch' || round.status === 'future') continue;
    const annotated = annotateRound(round, ctx);
    for (const annotation of annotated.moves.values()) review.counts[annotation.glyph] += 1;
    if (annotated.round) review.counts[annotated.round.glyph] += 1;
    tallyStacked(review, round);
    for (const tx of movesOf(round)) {
      if (isGameSpend(tx) && (!review.costliest || tx.amount > review.costliest.amount)) {
        review.costliest = { day: round.day, text: moveName(tx), amount: Math.round(tx.amount) };
      }
    }
    if (!hasResult(round)) continue;
    const side = round.plan ? review.prepared : review.unprepared;
    side.rounds += 1;
    side.score += round.result;
    if (Number.isFinite(round.kept) && (!best || round.kept > best.kept)) best = round;
  }
  if (best) review.best = { day: best.day, text: bestText(best) };
  return review;
}

/**
 * What playing a candidate move would do to today's round — for the candidate-move sheet, before buying.
 * @param {import('./ledger.js').Round} round   today's round as it stands
 * @param {{ amount: number, category: string, planned?: boolean }} move
 * @returns {{ keptBefore: number, keptAfter: number, resultBefore: 1|0.5|0, resultAfter: 1|0.5|0,
 *             stopNumber: number|null, glyph: string|null, why: string }}
 *   results are what the round would score if it ended now / after the move; stopNumber = which stop of the day
 *   this would be (null when the category is not a stop category)
 */
export function previewMove(round, move) {
  const lines = linesOf(round);
  const candidate = isObject(move) ? move : {};
  const amount = wholeCents(candidate.amount);
  const category = Object.hasOwn(CATEGORIES, candidate.category) ? CATEGORIES[candidate.category] : null;
  const inGame = !!category && category.klass === 'game';
  const convAfter = lines.conv + (inGame ? amount : 0);
  const stopNumber = inGame && category.stop ? lines.stops + 1 : null;
  const planned = stopNumber !== null && (candidate.planned === true || stopNumber <= lines.plannedStops);
  const resultBefore = resultAt(lines, lines.conv);
  const resultAfter = resultAt(lines, convAfter);
  return {
    keptBefore: lines.habit - lines.conv,
    keptAfter: lines.habit - convAfter,
    resultBefore,
    resultAfter,
    stopNumber,
    glyph: stopNumber === null || planned ? null : stackedGlyph(stopNumber),
    why: previewWhy({ lines, amount, inGame, label: categoryLabel(candidate.category), stopNumber, planned, convAfter, resultBefore, resultAfter }),
  };
}

/* ------------------------------------------------------------------- moves */

/** The first rule that speaks for a move decides it (rules 1–7, in order). */
function annotationFor(tx, marks) {
  return ownGlyph(tx)
    || marks.declines.get(tx)
    || marks.stops.get(tx)
    || paymentMark(tx, marks.sweepIds)
    || businessMark(tx)
    || forcedMark(tx)
    || null;
}

/** Rules 1 and 2: the glyph stored on the move — the classifier's '??' on a fee, else the owner's own. */
function ownGlyph(tx) {
  if (typeof tx.glyph !== 'string' || !Object.hasOwn(GLYPHS, tx.glyph)) return null;
  if (tx.glyph === PENALTY && tx.kind === 'spend' && tx.category === PENALTY_CATEGORY) {
    return note(PENALTY, 'Fee of ' + fmt(amountOf(tx)) + ': an avoidable penalty');
  }
  return { glyph: tx.glyph, why: 'Annotated by hand: ' + fmt(amountOf(tx)), manual: true };
}

/** Rule 3: the first two declines of the day. */
function declineMarks(moves) {
  const marks = new Map();
  for (const tx of moves) {
    if (tx.kind !== 'decline' || marks.size >= DECLINES_MARKED) continue;
    marks.set(tx, note(GOOD, 'Declined purchase: ' + fmt(amountOf(tx)) + ' not spent'));
  }
  return marks;
}

/** Rules 4 and 8: the stacked stops of the day, by move. */
function stopMarks(round, moves) {
  const marks = new Map();
  for (const stop of readStops(round, moves)) {
    if (!stop.stacked) continue;
    marks.set(stop.tx, note(stackedGlyph(stop.number), ordinal(stop.number) + ' stop of the day, unplanned: ' + fmt(amountOf(stop.tx))));
  }
  return marks;
}

/**
 * The day's stops in the order played. A stop is in the plan when it is one of the first
 * `plan.stops` or is marked `planned`; it is stacked when it is not, is the 2nd or later stop of
 * the day and was a personal purchase.
 */
function readStops(round, moves) {
  const plannedStops = plannedStopsOf(round);
  const stops = [];
  for (const tx of moves) {
    if (!isStop(tx)) continue;
    const number = stops.length + 1;
    const planned = !!tx.planned || number <= plannedStops;
    stops.push({ tx, number, stacked: !planned && number >= 2 && isPersonal(tx) });
  }
  return stops;
}

function stackedGlyph(stopNumber) {
  if (stopNumber < 2) return null;
  return stopNumber === 2 ? DUBIOUS : MISTAKE;
}

/** Rule 5: a recorded sweep, or a payment toward a card or loan that the Book did not expect. */
function paymentMark(tx, sweepIds) {
  if (sweepIds.has(tx.id)) return note(GOOD, 'Sweep of ' + fmt(amountOf(tx)) + ' recorded');
  if (tx.kind !== 'payment' || tx.recurringId != null) return null;
  if (tx.flow === 'in' && tx.pairId != null) return null;
  const what = tx.category === 'card_payment' ? 'Card payment' : 'Debt payment';
  return note(GOOD, what + ' of ' + fmt(amountOf(tx)) + ' outside the Book');
}

/** Rule 6: a business purchase, open until its return check is answered. */
function businessMark(tx) {
  const business = tx.kind === 'spend' && tx.klass === 'oneoff' && typeof tx.purpose === 'string' && tx.purpose !== 'personal';
  if (!business || amountOf(tx) < BUSINESS_MINIMUM) return null;
  const outcome = isObject(tx.payback) ? tx.payback.outcome : null;
  const [glyph, words] = Object.hasOwn(PAYBACK_WORDS, outcome) ? PAYBACK_WORDS[outcome] : [OPEN, 'return check open'];
  return note(glyph, 'Business purchase of ' + fmt(amountOf(tx)) + ': ' + words);
}

/** Rule 7: rent and loan payments in the Book. */
function forcedMark(tx) {
  const charge = (tx.kind === 'spend' || tx.kind === 'payment') && tx.flow !== 'in';
  const inBook = tx.recurringId != null || tx.klass === 'book';
  if (!charge || !inBook || !Object.hasOwn(FORCED_CATEGORIES, tx.category)) return null;
  return note(BOX, FORCED_CATEGORIES[tx.category] + ' of ' + fmt(amountOf(tx)) + ': a forced move');
}

/**
 * Rule 9: no more than `limit` annotations. Boxes go first, then '!?', then '!'; the owner's own
 * glyphs and the symbols that record a cost ('??', '?!', '?') always stay.
 */
function withinLimit(found, limit) {
  const kept = found.slice();
  for (const glyph of DROP_ORDER) {
    const droppable = kept
      .filter((entry) => !entry.annotation.manual && entry.annotation.glyph === glyph)
      .sort((a, b) => amountOf(a.tx) - amountOf(b.tx) || b.order - a.order);
    for (const entry of droppable) {
      if (kept.length <= limit) return kept;
      kept.splice(kept.indexOf(entry), 1);
    }
  }
  return kept;
}

/* ------------------------------------------------------------------ rounds */

function roundAnnotation(round) {
  if (!isScored(round)) return null;
  if (round.clean === true && round.type === 'work') {
    return note(BRILLIANT, 'Clean sheet on a workday: ' + fmt(0) + ' against habit at ' + fmt(wholeCents(round.habit)));
  }
  const planned = isObject(round.plan) && Number.isFinite(round.plan.stops) ? round.plan.stops : null;
  const stops = wholeCount(round.stops);
  if (planned === null || stops > planned || round.result !== 1) return null;
  return note(GOOD, 'Played to the morning plan: ' + countOf(planned, 'stop') + ' planned, ' + stops + ' made');
}

/** Final or provisional: the bank has reported the day (ARCHITECTURE 4.6). */
function isScored(round) {
  return round.status === 'provisional' || round.status === 'final';
}

function hasResult(round) {
  return round.result === 1 || round.result === 0.5 || round.result === 0;
}

function tallyStacked(review, round) {
  const stacked = readStops(round, movesOf(round)).filter((stop) => stop.stacked);
  if (!stacked.length) return;
  review.stackedDays += 1;
  for (const stop of stacked) review.stackedCost += Math.round(amountOf(stop.tx));
}

function bestText(round) {
  const dayKind = round.type === 'work' ? 'a workday' : 'a day off';
  if (round.clean === true) return 'Clean sheet on ' + dayKind;
  if (round.kept > 0) return 'Kept ' + fmt(round.kept) + ' against habit on ' + dayKind;
  if (round.kept === 0) return 'Level with habit at ' + fmt(wholeCents(round.habit)) + ' on ' + dayKind;
  return fmt(-round.kept) + ' over habit on ' + dayKind;
}

/* ----------------------------------------------------------------- preview */

/** The figures of a round a candidate move is weighed against; zeros where the round does not say. */
function linesOf(round) {
  const source = isObject(round) ? round : {};
  return {
    habit: wholeCents(source.habit),
    winLine: wholeCents(source.winLine),
    lossLine: wholeCents(source.lossLine),
    conv: wholeCents(source.conv),
    stops: wholeCount(source.stops),
    plannedStops: plannedStopsOf(source),
    bye: !!source.bye,
  };
}

/** What the round would score if it ended with this much convenience spending (ARCHITECTURE 4.6). */
function resultAt(lines, conv) {
  if (lines.bye) return 0.5;
  if (conv <= lines.winLine) return 1;
  return conv > lines.lossLine ? 0 : 0.5;
}

function previewWhy(view) {
  const { lines, amount, stopNumber } = view;
  if (!view.inGame) {
    return 'Outside the daily game (' + view.label + '): ' + fmt(amount) + ' leaves the round at ' + fmt(lines.conv)
      + ' against habit at ' + fmt(lines.habit) + '.';
  }
  const stop = stopNumber === null ? '' : ordinal(stopNumber) + ' stop of the day' + stopNote(view) + '. ';
  return stop + fmt(amount) + ' ' + resultWords(view) + ', ' + marginWords(lines, view.convAfter) + '.';
}

function stopNote(view) {
  if (view.planned) return ', in the plan';
  return view.stopNumber >= 2 ? ', unplanned' : '';
}

function resultWords(view) {
  if (view.lines.bye) return 'leaves the bye at a draw';
  if (view.resultBefore === view.resultAfter) return 'keeps the round ' + RESULT_WORDS[view.resultAfter];
  return 'takes the round from ' + RESULT_WORDS[view.resultBefore] + ' to ' + RESULT_WORDS[view.resultAfter];
}

/** Where the day's spending would stand against the line that decides its result. */
function marginWords(lines, conv) {
  if (conv <= lines.winLine) return fmt(lines.winLine - conv) + ' inside the win line';
  if (conv <= lines.lossLine) return fmt(lines.lossLine - conv) + ' inside the loss line';
  return fmt(conv - lines.lossLine) + ' past the loss line';
}

/* ------------------------------------------------------------ small helpers */

function note(glyph, why) {
  return { glyph, why, manual: false };
}

function movesOf(round) {
  return (Array.isArray(round.moves) ? round.moves : []).filter(isObject);
}

function sweepIdsOf(ctx) {
  return isObject(ctx) && ctx.sweepTxIds instanceof Set ? ctx.sweepTxIds : new Set();
}

function plannedStopsOf(round) {
  const plan = isObject(round.plan) ? round.plan : null;
  return plan && Number.isFinite(plan.stops) && plan.stops > 0 ? Math.floor(plan.stops) : 0;
}

/** A game-class purchase that counts in the day's convenience spending. */
function isGameSpend(tx) {
  return tx.kind === 'spend' && tx.flow !== 'in' && tx.klass === 'game' && amountOf(tx) > 0;
}

function isStop(tx) {
  return isGameSpend(tx) && Object.hasOwn(CATEGORIES, tx.category) && !!CATEGORIES[tx.category].stop;
}

function isPersonal(tx) {
  return tx.purpose == null || tx.purpose === 'personal';
}

function amountOf(tx) {
  return Number.isFinite(tx.amount) && tx.amount > 0 ? tx.amount : 0;
}

/** The merchant's cleaned name, else what kind of purchase it was. The view escapes it. */
function moveName(tx) {
  return typeof tx.merchant === 'string' && tx.merchant.trim() ? tx.merchant.trim() : categoryLabel(tx.category);
}

function ordinal(n) {
  const teens = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teens ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return n + suffix;
}

function countOf(n, noun) {
  return n + ' ' + noun + (n === 1 ? '' : 's');
}

function wholeCents(x) {
  return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
}

function wholeCount(x) {
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

function isObject(x) {
  return x !== null && typeof x === 'object';
}
