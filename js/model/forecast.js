/**
 * Analysis: scenarios, the reserve goal, the income ladder. Everything here is a SCENARIO or a
 * measurement of the past — never a prediction — and the UI labels it so.
 * Pure. Imports: schema, dates, money, ledger, loans, cards.
 */

import { CADENCES } from './schema.js';
import { addDays, addMonths, diffDays, fmtDate, isYmd, maxYmd } from './dates.js';
import { fmt, ratio, roundCents } from './money.js';
import { makeLedger } from './ledger.js';
import { payoff, payoffSchedule, requiredGrowth } from './loans.js';
import { allCardsMonths, cardsNow, firstTransactionDay } from './cards.js';

/** The average month, in days (365.25 / 12). */
const DAYS_PER_MONTH = 30.4375;
const DAYS_PER_YEAR = 365;
const DEFAULT_PACE_DAYS = 30;
/** A daily income measured over fewer days than this says nothing. */
const MIN_MEASURED_DAYS = 7;
/** A pace is never measured over fewer completed days than this, however short the pay cycle. */
const MIN_PACE_DAYS = 14;
/** The pay cycle taken when no regular pay is known yet: a month, the longest ordinary one. */
const UNKNOWN_CYCLE_DAYS = 30;
/** An income annualised from fewer days than this is marked `thin`: it is not a measure of a year. */
const MIN_ANNUALISED_DAYS = 60;
const DEFAULT_HORIZON_MONTHS = 24;
const MAX_HORIZON_MONTHS = 600;
/** A goal further off than this (100 years) is not reached at that rate in any useful sense. */
const MAX_ETA_DAYS = 36525;
const ROUNDING_SLACK = 1e-9;
const UNLINKED_INCOME = 'Other income';

/*
 * How the specification is read where it leaves a choice:
 *  - History begins on the day of the earliest transaction in the document (cards.firstTransactionDay).
 *    Pace is measured only on days inside it, so a young document is not diluted by empty days.
 *  - The scenario line rises by scenario.monthlyImprove a month from the live number; it does not
 *    add the measured pace.
 *  - "Average kept per day" is the edge divided by the rounds that count in it.
 *  - An ETA is whole months, rounded up (as a payoff is), and the day that many months from today, so
 *    the count and the date printed beside it always agree.
 *  - A pace needs one full pay cycle of completed days (the longest cadence among the pay streams;
 *    a month while none is known), and never fewer than 14: a window holding the rent and no paycheck,
 *    or the reverse, is not a pace. A caller's own shorter window is not asked for more than itself.
 *    pace() and paceMinDays() read that number from one function, so they cannot disagree.
 *  - A purchase on a card goes inside this month's card projection once (cards.js, `extraCharge`):
 *    one purchase is not a habit, so it is not extrapolated, and a card in credit absorbs it first.
 *    Before day 7 of the month no card pace is read, and the sentence says so.
 *  - Daily take-home is what the pay streams bring in per day (ledger.payStreams(): scheduled, not
 *    lapsed, and counted day by day or worth $200.00 a month). With none, a purchase is not
 *    expressed in days of pay: a trickle of interest is income, never pay.
 *  - The live net worth is floored to the cent it has reached, never rounded up, so a projection
 *    starts at the cent the Board's ticking figure shows.
 *  - Every query takes an options object last; `opts.ledger` (a ledger made by makeLedger for the
 *    same document and time) is used instead of building another, and one call builds one at most.
 */

/**
 * The owner's measured pace: the average daily result over the trailing `days` completed game days
 * (default 30; today is excluded), from ledger closes.
 * @returns {{ days: number, perDay: number, perMonth: number, earnedPerDay: number, spentPerDay: number, billsPerDay: number }|null}
 *   cents (perDay may be fractional; perMonth = perDay × 30.4375 rounded); null with less history than
 *   one full pay cycle of completed days, or than 14 days
 */
export function pace(state, nowMs, days, opts) {
  return measuredPace(openView(state, nowMs, opts), days);
}

/**
 * The completed game days pace() needs before it reads a pace over a `days` window (today is never
 * one of them): one full pay cycle, 14 at least, and never more than the window asked for. The
 * interface states its threshold with this number, so that it cannot drift from the rule.
 * In days on record (today included) a pace is therefore read from day paceMinDays + 1.
 * @param {object} state
 * @param {number} nowMs
 * @param {number} [days]  default 30
 * @param {{ ledger?: object }} [opts]
 * @returns {number}
 */
export function paceMinDays(state, nowMs, days, opts) {
  return neededDays(openView(state, nowMs, opts), windowOf(days));
}

/**
 * Project net worth month by month under three lines, all starting from the live number now:
 *  - 'pace'     the measured pace continues (omitted when pace is null)
 *  - 'scenario' net worth improves by scenario.monthlyImprove each month
 *  - 'habit'    the pace the owner would have at Habit: pace minus the average kept per day since the match
 *               began (omitted when the match has not started or pace is null)
 * @param {object} state
 * @param {number} nowMs
 * @param {{ months?: number, ledger?: object }} [opts]  months default: scenario.horizonMonths
 * @returns {{ start: number, months: number, lines: { key: string, label: string, points: number[] }[] }}
 *   points[0] = start = the live figure floored to the cent, points[m] = value after m months
 */
export function projectNetWorth(state, nowMs, opts) {
  const view = openView(state, nowMs, opts);
  const start = Math.floor(finite(view.ledger.position().live));
  const months = horizonOf(view, isObject(opts) ? opts.months : undefined);
  const measured = measuredPace(view, DEFAULT_PACE_DAYS);
  const kept = measured ? keptPerDay(view) : null;
  const line = (key, label, perMonth) => ({
    key, label,
    points: Array.from({ length: months + 1 }, (_, m) => roundCents(start + perMonth * m)),
  });
  const lines = [];
  if (measured) lines.push(line('pace', 'At this pace', measured.perDay * DAYS_PER_MONTH));
  lines.push(line('scenario', 'Scenario', finite(view.scenario.monthlyImprove)));
  if (kept !== null) lines.push(line('habit', 'At habit', (measured.perDay - kept) * DAYS_PER_MONTH));
  return { start, months, lines };
}

/**
 * The cash reserve goal. `months` is whole months, rounded up; `day` is the day that many whole months
 * from today, so the count and the date always agree. A goal already met is 0 months away, today. A rate that needs more than a century is
 * given as null, like no rate at all.
 * @returns {{ target: number, have: number, gap: number, fraction: number,
 *             atPace: { months: number|null, day: string|null },      // months to reach it at the measured pace (null when pace <= 0 or unknown)
 *             atScenario: { months: number|null, day: string|null } }} // at scenario.toSavings per month
 */
export function reserveGoal(state, nowMs, opts) {
  const view = openView(state, nowMs, opts);
  const clock = view.ledger.clock();
  const target = clock.reserveTarget;
  const have = clock.reserve;
  const gap = Math.max(0, target - have);
  const measured = measuredPace(view, DEFAULT_PACE_DAYS);
  return {
    target,
    have,
    gap,
    fraction: target > 0 ? ratio(have, target) : 1,
    atPace: etaOf(view.today, gap, measured ? measured.perDay * DAYS_PER_MONTH : null),
    atScenario: etaOf(view.today, gap, finite(view.scenario.toSavings)),
  };
}

/**
 * The income ladder, from money actually received (never from a forecast).
 * `received` = income transactions over the trailing 365 days (or all history when shorter); when history is
 * shorter than 365 days, `annualised` scales it up (received / daysOfHistory × 365) and `partial` is true.
 * Take-home is turned into an approximate gross with scenario.takeHomeRatio for streams of kind 'salary' only.
 * `byStream` is largest first; income linked to no known stream is one row with id null.
 * `thin` is true when the history is under 60 days: `annualised`, `grossApprox` and the ladder are then
 * a few weeks multiplied up, and the interface says so instead of offering them as a year's income.
 * @returns {{ received: number, days: number, partial: boolean, thin: boolean, annualised: number, grossApprox: number,
 *             byStream: { id: string|null, name: string, kind: string, received: number, share: number }[],
 *             ladder: { target: number, reached: boolean, fraction: number }[],
 *             next: { target: number, gap: number, fraction: number }|null,
 *             final: { target: number, by: string, requiredGrowth: number|null } }}
 *   requiredGrowth = loans.requiredGrowth(grossApprox, final target, today, by)
 */
export function incomeLadder(state, nowMs, opts) {
  const view = openView(state, nowMs, opts);
  const income = measuredIncome(view);
  const scale = income.days > 0 ? DAYS_PER_YEAR / income.days : 0;
  const salary = sumOf(income.byStream, (row) => (row.kind === 'salary' ? row.received : 0));
  const grossApprox = roundCents((salary / takeHomeRatioOf(view) + (income.received - salary)) * scale);
  const targets = ladderTargets(view.doc);
  const ladder = targets.map((target) => ({ target, reached: grossApprox >= target, fraction: ratio(grossApprox, target) }));
  const next = ladder.find((rung) => !rung.reached) || null;
  const finalTarget = targets.length ? targets[targets.length - 1] : 0;
  const by = deadlineOf(view.doc);
  return {
    received: income.received,
    days: income.days,
    partial: income.days < DAYS_PER_YEAR,
    thin: income.days < MIN_ANNUALISED_DAYS,
    annualised: roundCents(income.received * scale),
    grossApprox,
    byStream: income.byStream,
    ladder,
    next: next && { target: next.target, gap: next.target - grossApprox, fraction: next.fraction },
    final: { target: finalTarget, by, requiredGrowth: finalTarget > 0 ? requiredGrowth(grossApprox, finalTarget, view.today, by) : null },
  };
}

/**
 * Card payoff under the scenario payment, for all owed cards together.
 * `schedule` starts with what is owed now (month 0). When the payment never clears the balance it
 * runs for the scenario horizon instead.
 * @returns {{ owed: number, apr: number|null, payment: number, months: number|null, interest: number|null, never: boolean,
 *             schedule: { month: number, owed: number }[] }}
 *   apr = balance-weighted APR of the owed cards, null when any owed card has none (then interest is unknown and
 *   months is computed at 0%, flagged by apr === null)
 */
export function cardPayoff(state, nowMs, opts) {
  const view = openView(state, nowMs, opts);
  const { owed, cards } = cardsNow(view.doc, nowMs, { ledger: view.ledger });
  const owing = cards.filter((card) => card.owed > 0);
  const apr = owing.length && owing.every((card) => card.apr !== null)
    ? sumOf(owing, (card) => card.owed * card.apr) / owed
    : null;
  const payment = wholeCents(view.scenario.cardPayment);
  const plan = payoff({ owed, apr, payment });
  const terms = plan.never ? { owed, apr, payment, maxMonths: horizonOf(view) } : { owed, apr, payment };
  return {
    owed,
    apr,
    payment,
    months: plan.months,
    interest: owed > 0 && apr === null ? null : plan.interest,
    never: plan.never,
    schedule: [{ month: 0, owed }].concat(payoffSchedule(terms).map((row) => ({ month: row.month, owed: row.owed }))),
  };
}

/**
 * What a hypothetical purchase would do, for the "before you buy" tool on larger amounts.
 * @param {object} state
 * @param {number} nowMs
 * @param {{ amount: number, on: 'cash'|'card', accountId?: string }} purchase  accountId: the card it goes on (default: the first card)
 * @param {{ ledger?: object }} [opts]
 * @returns {{ netWorth: number, cashAfter: number, shortfallAfter: number, cardMonthChange: number|null,
 *             daysOfPay: number|null, sentence: string }}
 *   netWorth = −amount; cashAfter / shortfallAfter from the clock when paid from cash; cardMonthChange = this month's
 *   card pace with the amount inside the projection when paid by card (null when paid from cash, and before day 7 of
 *   the month, when no card pace is read); daysOfPay = amount / (daily take-home), null when no pay stream is known
 */
export function purchaseImpact(state, nowMs, purchase, opts) {
  const view = openView(state, nowMs, opts);
  const amount = wholeCents(isObject(purchase) ? purchase.amount : null);
  const onCard = isObject(purchase) && purchase.on === 'card';
  const clock = view.ledger.clock();
  const cashAfter = clock.cash - (onCard ? 0 : amount);
  const daily = dailyTakeHome(view);
  const impact = {
    netWorth: roundCents(-amount),
    cashAfter,
    shortfallAfter: Math.max(0, clock.dueTotal - cashAfter),
    cardMonthChange: onCard ? thisMonthCardPace(view, nowMs, amount, purchase.accountId) : null,
    daysOfPay: daily === null ? null : amount / daily,
  };
  // Ruling T5: before day 7 no pace is read, and a credit on the card absorbs the purchase first.
  const credit = onCard && impact.cardMonthChange === null ? creditOnCard(view, nowMs, purchase.accountId) : 0;
  return { ...impact, sentence: purchaseSentence(amount, impact, clock, onCard, credit) };
}

/* -------------------------------------------------------------------- view */

/** What one query needs, read once: the document, its ledger, today and the scenario inputs. */
function openView(state, nowMs, opts) {
  const doc = isObject(state) ? state : {};
  const ledger = isObject(opts) && isObject(opts.ledger) ? opts.ledger : makeLedger(doc, nowMs);
  return {
    doc,
    ledger,
    today: ledger.today,
    scenario: isObject(doc.scenario) ? doc.scenario : {},
    firstDay: firstTransactionDay(doc),
  };
}

/** A horizon in whole months: the one asked for, else the scenario's, else two years. */
function horizonOf(view, asked) {
  const months = [asked, view.scenario.horizonMonths].find((value) => Number.isFinite(value) && value >= 1);
  return months === undefined ? DEFAULT_HORIZON_MONTHS : Math.min(Math.floor(months), MAX_HORIZON_MONTHS);
}

/* -------------------------------------------------------------------- pace */

function measuredPace(view, days) {
  if (view.firstDay === null) return null;
  const window = windowOf(days);
  const from = maxYmd(addDays(view.today, -window), view.firstDay);
  const rows = view.ledger.closes(from, addDays(view.today, -1));
  if (rows.length < neededDays(view, window)) return null;
  const perDay = sumOf(rows, (row) => row.result) / rows.length;
  return {
    days: rows.length,
    perDay,
    perMonth: roundCents(perDay * DAYS_PER_MONTH),
    earnedPerDay: sumOf(rows, (row) => row.earned) / rows.length,
    spentPerDay: sumOf(rows, (row) => row.spent) / rows.length,
    billsPerDay: sumOf(rows, (row) => row.bills) / rows.length,
  };
}

/** The window a pace is asked over, in whole days: the one given, else 30. */
function windowOf(days) {
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_PACE_DAYS;
}

/**
 * The completed days a pace over `window` days needs: the pay cycle, or the whole window when the
 * caller asked for a shorter one, and 7 at least (so a window under 7 days never reads a pace).
 * The one rule behind pace() and paceMinDays().
 */
function neededDays(view, window) {
  return Math.max(MIN_MEASURED_DAYS, Math.min(window, minPaceDays(view)));
}

/** The completed days a pace needs: one full pay cycle (a month when no pay stream is known), 14 at least. */
function minPaceDays(view) {
  let cycle = 0;
  for (const stream of payStreamsOf(view)) cycle = Math.max(cycle, Math.ceil(CADENCES[stream.cadence].days));
  return Math.max(MIN_PACE_DAYS, Math.min(cycle || UNKNOWN_CYCLE_DAYS, UNKNOWN_CYCLE_DAYS));
}

/** The streams that count as pay, from the ledger (scheduled, not lapsed, counted day by day or $200.00 a month). */
function payStreamsOf(view) {
  const streams = typeof view.ledger.payStreams === 'function' ? view.ledger.payStreams() : [];
  return listOf(streams).filter(isPaying);
}

/** Kept versus Habit per round that counts, since the match began; null before any round counts. */
function keptPerDay(view) {
  const matchStart = isObject(view.doc.meta) ? view.doc.meta.matchStart : null;
  if (!isYmd(matchStart)) return null;
  let rounds = 0;
  for (let day = matchStart; day < view.today; day = addDays(day, 1)) {
    const played = view.ledger.round(day);
    if (played.result !== null && played.status !== 'prematch') rounds += 1;
  }
  return rounds ? view.ledger.edge().kept / rounds : null;
}

/** When a gap closes at a monthly rate: whole months, rounded up, and the day that many months from today. */
function etaOf(today, gap, perMonth) {
  if (gap <= 0) return { months: 0, day: today };
  const months = perMonth > 0 ? gap / perMonth : Infinity;
  if (!(wholeUp(months * DAYS_PER_MONTH) <= MAX_ETA_DAYS)) return { months: null, day: null };
  const whole = wholeUp(months);
  return { months: whole, day: addMonths(today, whole) };
}

/** Round up, without letting a quotient that is a hair above a whole number (10.000000000000002) count as the next. */
function wholeUp(x) {
  return Math.ceil(x - ROUNDING_SLACK);
}

/* ------------------------------------------------------------------ income */

/**
 * Income received over the trailing 365 days (today included), no further back than the history
 * goes, by the stream it belongs to. Only rows the bank reported on accounts that are not hidden.
 */
function measuredIncome(view) {
  const { doc, today, firstDay } = view;
  if (firstDay === null || firstDay > today) return { received: 0, days: 0, byStream: [] };
  const from = maxYmd(addDays(today, -(DAYS_PER_YEAR - 1)), firstDay);
  const visible = visibleAccountIds(doc);
  const streams = new Map(listOf(doc.streams).filter(isObject).map((stream) => [stream.id, stream]));
  const countPending = !isObject(doc.settings) || doc.settings.countPending === undefined || !!doc.settings.countPending;
  const rows = new Map();
  let received = 0;
  for (const tx of listOf(doc.txs)) {
    if (!isIncome(tx) || (tx.pending && !countPending) || !visible.has(tx.accountId)) continue;
    if (tx.day < from || tx.day > today) continue;
    const amount = Math.round(tx.amount);
    const stream = tx.streamId == null ? null : streams.get(tx.streamId) || null;
    const id = stream ? stream.id : null;
    if (!rows.has(id)) rows.set(id, streamRow(stream));
    rows.get(id).received += amount;
    received += amount;
  }
  const byStream = [...rows.values()].sort((a, b) => b.received - a.received || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const row of byStream) row.share = received > 0 ? row.received / received : 0;
  return { received, days: diffDays(from, today) + 1, byStream };
}

/** An empty row of the breakdown for a stream, or for income linked to no known stream. */
function streamRow(stream) {
  if (!stream) return { id: null, name: UNLINKED_INCOME, kind: 'other', received: 0, share: 0 };
  return { id: stream.id, name: textOf(stream.name), kind: textOf(stream.kind), received: 0, share: 0 };
}

function isIncome(tx) {
  return isObject(tx) && tx.kind === 'income' && tx.flow === 'in' && Number.isFinite(tx.amount) && tx.amount > 0
    && isYmd(tx.day) && !tx.matchId && tx.source !== 'manual';
}

function visibleAccountIds(doc) {
  const ids = new Set();
  for (const account of listOf(doc.accounts)) if (isObject(account) && !account.hidden) ids.add(account.id);
  return ids;
}

/** The share of gross pay that is taken home; 1 (no gross-up) when the document gives no usable ratio. */
function takeHomeRatioOf(view) {
  const share = view.scenario.takeHomeRatio;
  return Number.isFinite(share) && share > 0 && share <= 1 ? share : 1;
}

/** The rungs of the ladder in whole cents, lowest first, each once. */
function ladderTargets(doc) {
  const income = incomeGoalOf(doc);
  const targets = listOf(income.ladder).filter((target) => Number.isFinite(target) && target > 0).map(Math.round);
  return [...new Set(targets)].sort((a, b) => a - b);
}

function deadlineOf(doc) {
  const { by } = incomeGoalOf(doc);
  return isYmd(by) ? by : '';   // an unreadable day is no day: nothing downstream prints it
}

function incomeGoalOf(doc) {
  return isObject(doc.goals) && isObject(doc.goals.income) ? doc.goals.income : {};
}

/* ---------------------------------------------------------------- purchase */

/** Take-home pay per day, in cents, from the pay streams; null when there is none (then nothing is put in days of pay). */
function dailyTakeHome(view) {
  const hidden = new Set(listOf(view.doc.accounts).filter((account) => isObject(account) && account.hidden).map((account) => account.id));
  const scheduled = sumOf(payStreamsOf(view), (stream) => (hidden.has(stream.accountId) ? 0 : stream.amount / CADENCES[stream.cadence].days));
  return scheduled > 0 ? scheduled : null;
}

/** An active stream with a cadence and an amount. */
function isPaying(stream) {
  return isObject(stream) && !!stream.active && typeof stream.cadence === 'string' && Object.hasOwn(CADENCES, stream.cadence)
    && Number.isFinite(stream.amount) && stream.amount > 0;
}

/**
 * Where all the cards together are on pace to end this month, against where they began it, with a
 * purchase of `amount` inside the projection. Null before day 7 of the month: no pace is read yet.
 */
function thisMonthCardPace(view, nowMs, amount, accountId) {
  const rows = allCardsMonths(view.doc, 1, nowMs, { ledger: view.ledger, extraCharge: amount, extraAccountId: accountId });
  const pace = rows.length ? rows[rows.length - 1].pace : null;
  return Number.isFinite(pace) ? pace : null;
}

/** What the card a purchase goes on (the one named, else the first visible card) is in credit by now, cents; 0 when it owes. */
function creditOnCard(view, nowMs, accountId) {
  const cards = listOf(cardsNow(view.doc, nowMs, { ledger: view.ledger }).cards);
  const card = cards.find((each) => each.id === accountId) || cards[0] || null;
  const value = card ? view.ledger.accountValueOn(card.id, view.today) : 0;
  return Number.isFinite(value) && value > 0 ? roundCents(value) : 0;
}

function purchaseSentence(amount, impact, clock, onCard, credit = 0) {
  let text;
  if (onCard && impact.cardMonthChange === null) {
    const added = Math.max(0, amount - credit);
    text = fmt(amount) + ' on the card ' + (credit > 0 && added === 0 ? 'is covered by the ' + fmt(credit) + ' credit' : 'adds ' + fmt(added) + ' to what is owed')
      + '; a pace is read from day 7 of the month';
  } else if (impact.cardMonthChange === null) {
    text = fmt(amount) + ' from cash leaves ' + fmt(impact.cashAfter) + ' on the clock';
    // With nothing due, cash below zero is a shortfall too, and the figure on the clock already says it.
    if (impact.shortfallAfter > 0 && clock.dueTotal > 0) {
      text += ', ≈' + fmt(impact.shortfallAfter) + ' short of what is due ' + dueWords(clock);
    }
  } else {
    text = fmt(amount) + ' on the card puts this month on pace to end ' + paceWords(impact.cardMonthChange);
  }
  return text + (impact.daysOfPay === null || amount === 0 ? '' : ' — ' + daysOfPayWords(impact.daysOfPay)) + '.';
}

/** A pace is an estimate: its amount carries the approximately sign directly before it. */
function paceWords(change) {
  if (change === 0) return 'where it began';
  return '≈' + fmt(Math.abs(change)) + (change > 0 ? ' higher' : ' lower') + ' than it began';
}

/** The window the clock's due list covers, in words. While a paycheck is awaited today is never called payday. */
function dueWords(clock) {
  // Ruling T1: the window is today alone on the payday itself and for the two grace days after it.
  if (isYmd(clock.dueUntil) && (clock.nextPayday === clock.dueUntil || (isYmd(clock.payAwaited) && clock.dueUntil <= clock.nextPayday))) return 'today';
  if (isYmd(clock.payAwaited) && isYmd(clock.dueUntil)) return 'through ' + fmtDate(clock.dueUntil, 'dowshort');
  return clock.nextPayday !== null ? 'before payday' : 'in the next two weeks';
}

function daysOfPayWords(days) {
  const shown = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
  if (shown < 0.1) return 'under 0.1 days of pay';
  return 'about ' + shown + (shown === 1 ? ' day' : ' days') + ' of pay';
}

/* ------------------------------------------------------------ small helpers */

function isObject(x) {
  return x !== null && typeof x === 'object';
}

function listOf(x) {
  return Array.isArray(x) ? x : [];
}

function finite(x) {
  return Number.isFinite(x) ? x : 0;
}

/** Whole cents >= 0 of an amount; 0 when it is missing or malformed. */
function wholeCents(x) {
  return Number.isFinite(x) && x > 0 ? Math.round(x) : 0;
}

function textOf(x) {
  return typeof x === 'string' ? x : '';
}

function sumOf(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item);
  return total;
}
