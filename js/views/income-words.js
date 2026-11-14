/**
 * The words about reported income (ARCHITECTURE 3.7): the toasts, the clause of a confirmation that holds other
 * payments, Material's note on Cash in hand, and the one rule for its estimate sign. An answer or a count is never
 * undone: each toast says how to change it instead, and under cover no toast names an amount. Plain strings, no markup.
 */

import { fmt } from '../model/money.js';
import { addDays, fmtDate, gameDay, nowMs } from '../model/dates.js';
import { LATE_MS, WAIT_MS, cashAccountOf, incomeLabel, incomeOf, incomePayments, isIncomeMove, liveCounts, payerAnswer } from '../model/income.js';

const CHANGE_PAYER = ' Change it in Settings.';
const CHANGE_ITEM = ' Ask again from the payment.';
const CHANGE_EACH = ' Ask again from each payment.';
const CHANGE_GONE = ' Ask again in Settings.';
const CHANGE_COUNT = ' Count again to correct it.';

function rolloverOf(state) {
  return state.settings && Number.isInteger(state.settings.rolloverHour) ? state.settings.rolloverHour : 4;
}

/** The count that rules today: the latest game day's, on one day the one edited last (a count stamped ahead waits for its day). */
function latestCount(state) {
  const rollover = rolloverOf(state);
  const today = gameDay(nowMs(), rollover);
  const counts = liveCounts(incomeOf(state).shared, rollover).filter((c) => gameDay(c.at, rollover) <= today);
  return counts.length ? counts[counts.length - 1] : null;
}

/** "today’s count", "yesterday’s count" or "your count of Nov 12": the day words of the Cash in hand sheet. */
function countDayWords(day, today) {
  if (day === today) return 'today’s count';
  if (day === addDays(today, -1)) return 'yesterday’s count';
  return 'your count of ' + fmtDate(day, 'short');
}

/**
 * Cash in hand is exactly the owner's latest count: then it prints in roman, as counted; otherwise (never counted, or
 * cash payments marked since) it is an estimate, italic with ≈. The one rule for the Board, Material and Settings.
 */
export function isCountedCash(state, value) {
  const count = latestCount(state);
  return !!count && Math.round(Number(value) || 0) === Math.round(count.cents);
}

/**
 * Material's note on what Cash in hand adds to a total: '' when it holds nothing. "Counted by you" only when the
 * figure is exactly the latest count; otherwise the count and the cash payments marked since are kept apart.
 */
export function cashNoteWords(state, value) {
  const cents = Math.round(Number(value) || 0);
  if (cents <= 0) return '';
  const count = latestCount(state);
  if (!count) return fmt(cents) + ' of it from payments marked as cash';
  if (isCountedCash(state, cents)) return fmt(cents) + ' of it counted by you';
  return fmt(cents) + ' of it from your count of ' + fmt(count.cents) + ' and payments marked as cash since';
}

/**
 * How Cash in hand stays after an answer that moved nothing in it: the figure itself; under cover (no amount) "as
 * counted" only when the figure is the latest count, else "does not change".
 */
function staysWords(state, value, cover) {
  if (!cover) return 'stays ' + fmt(value);
  return isCountedCash(state, value) ? 'stays as counted' : 'does not change';
}

/**
 * The lead of a line of a bank row's sheet for a payment the row holds: "Confirms " when the row counts for it with
 * no question open, "The board asks whether this is " while the row's confirmation question is open.
 */
export function rowLineLead(asked) {
  return asked ? 'The board asks whether this is ' : 'Confirms ';
}

/**
 * The clause of a confirmation whose row also holds payments it does not ask about (history ones, or ones the owner
 * answered): "with an earlier payment of $40.00", "with 2 other payments, $80.00 in all". No amount under cover.
 */
export function othersWords(others, cover) {
  if (!others || !others.n) return '';
  if (others.n === 1) return 'with ' + (others.earlier ? 'an earlier payment' : 'another payment') + (cover ? '' : ' of ' + fmt(others.cents));
  return 'with ' + others.n + (others.earlier ? ' earlier' : ' other') + ' payments' + (cover ? '' : ', ' + fmt(others.cents) + ' in all');
}

/**
 * What a cash answer did to Cash in hand, read after the answer (`value`: the figure now; `had`: the keys of the
 * payments in Cash in hand before it). Null when the answer put nothing in Cash in hand or there is no count.
 * `stays`: every payment it put there was marked before the latest count, so the figure did not move, and `text`
 * says so in one sentence, to follow the answer itself ("Their …" for a payer's answer, `kind` 'payer'; "The
 * $123.45 was …", "It was …" or "They were …" for a payment's). Otherwise `text` gives the figure now ('' under cover).
 */
export function beforeCountWords(state, had, value, today, cover, kind) {
  const count = latestCount(state);
  const account = cashAccountOf(state);
  if (!count || !account) return null;
  const moved = state.txs.filter((tx) => isIncomeMove(tx) && tx.accountId === account.id && tx.income && !had.has(tx.income.key) && Number.isFinite(tx.at));
  if (!moved.length) return null;
  if (moved.some((tx) => tx.at > count.at)) return { stays: false, text: cover ? '' : 'Cash in hand is now ' + fmt(value) + '.' };
  const one = moved.length === 1;
  const day = countDayWords(gameDay(count.at, rolloverOf(state)), today);
  const stays = staysWords(state, value, cover) + '.';
  if (kind === 'payer') {
    const what = !one ? moved.length + ' payments were' : (cover ? 'payment' : fmt(Math.round(moved[0].amount))) + ' was';
    return { stays: true, text: 'Their ' + what + ' marked before ' + day + ', so Cash in hand ' + stays };
  }
  const who = !one ? 'They were' : cover ? 'It was' : 'The ' + fmt(Math.round(moved[0].amount)) + ' was';
  return { stays: true, text: who + ' marked before ' + day + ', so Cash in hand ' + stays };
}

/**
 * The words of a cash answer: `said` ("{label} was cash: it counts in Cash in hand.") and the figure now; or, when the
 * figure did not move, who and what was answered (`lead`: "{label} was cash.") and the before-count sentence.
 */
function withCash(said, cash, lead) {
  if (!cash) return said;
  if (cash.stays) return lead + ' ' + cash.text;
  return cash.text ? said + ' ' + cash.text : said;
}

/**
 * When the cash was last counted, as a quiet nudge (3.7: after 400 days uncounted cash is taken as spent):
 * { words: 'never counted' | 'counted today' | 'counted yesterday' | 'counted Nov 12', count: the latest count or null }.
 */
export function countedWords(state, today) {
  const count = latestCount(state);
  if (!count) return { words: 'never counted', count: null };
  const day = gameDay(count.at, rolloverOf(state));
  return { words: 'counted ' + (day === today ? 'today' : day === addDays(today, -1) ? 'yesterday' : fmtDate(day, 'short')), count };
}

/**
 * A payer answered: how their payments count now, and how to change it. `cash`: from beforeCountWords; `asks`: the
 * deposit ({ cents, day }) of a confirmation question the answer raised, or null; `moved`: how many payments the
 * answer put in Cash in hand (0: none, so the toast does not say it counts there).
 */
export function payerWords(name, how, cash, asks, cover, moved, where) {
  const said = name + (how === 'cash' ? (moved === 0 ? ' pays in cash.' : ' pays in cash: it counts in Cash in hand.') : ' pays by Zelle or transfer: it counts in pencil until the bank shows it.');
  const words = cash && cash.stays ? name + ' pays in cash. ' + cash.text : withCash(said, cash);
  const ask = asks ? ' Networth asks about the ' + (cover ? 'deposit' : fmt(asks.cents)) + ' of ' + fmtDate(asks.day, 'short') + ' on the board.' : '';
  // in Settings the switch is under the owner's finger: the toast ends at the answer
  return words + ask + (where === 'settings' ? '' : CHANGE_PAYER);
}

/**
 * The name each payer goes by where payers of several sources are listed together: the payer's own name, and
 * "{name} · {source}" when another source has a payer of the same name ("Avery · Group class").
 * @param {{ payerKey: string, payerName: string, sourceLabel: string }[]} payers
 * @returns {Map<string, string>} payer key -> name
 */
export function payerNames(payers) {
  const sources = new Map();
  for (const p of payers) {
    const set = sources.get(p.payerName) || new Set();
    set.add(p.sourceLabel);
    sources.set(p.payerName, set);
  }
  return new Map(payers.map((p) => [p.payerKey, sources.get(p.payerName).size > 1 ? p.payerName + ' · ' + p.sourceLabel : p.payerName]));
}

/**
 * The payers Settings lists (one per payer, the newest payment standing for it; a payer with history payments only and
 * no answer is left out), by name, and the name each goes by (`payerNames`). The Board's payer toast uses the same names.
 * @returns {{ payers: object[], names: Map<string, string> }}
 */
export function listedPayers(state) {
  const { sources, shared } = incomeOf(state);
  const payments = incomePayments(state, rolloverOf(state));
  const payers = [];
  const seen = new Set();
  for (const p of payments.slice().reverse()) {
    if (seen.has(p.payerKey) || (p.how === 'history' && !payerAnswer(shared, p.payerKey))) continue;
    seen.add(p.payerKey);
    payers.push(p);
  }
  payers.sort((a, b) => a.payerName.localeCompare(b.payerName) || (a.payerKey < b.payerKey ? -1 : 1));
  const labelOf = (id) => (sources[id] && sources[id].what) || id + '.json';
  const names = payerNames(payers.map((p) => ({ payerKey: p.payerKey, payerName: p.payerName, sourceLabel: labelOf(p.source) })));
  return { payers, names };
}

/**
 * The record chart's figure is an estimate (≈, italic, "about") exactly when the figure it ends on holds one: a ≈
 * balance, smoothing, a move tapped in or a payment marked and not yet at the bank. Material and the Board decide alike.
 * @param {{ estAssets?: boolean, estDebts?: boolean, smoothing?: boolean, provisional?: number, provisionalIn?: number }} m
 */
export function recordEstimate(m) {
  return Boolean(m.estAssets || m.estDebts || m.smoothing || m.provisional > 0 || m.provisionalIn > 0);
}

/** The first words of the record chart's caption when nothing is smoothed: what the line is, and its pencil part. */
export function recordLead(m) {
  const pencil = m.provisional > 0 || m.provisionalIn > 0;
  const where = bankWhere(m.handCash);
  return 'Net worth ' + where + ', day by day.' + (pencil ? ' The last step, in pencil, counts the moves not yet at the bank; dotted: ' + where + '.' : '');
}

/** What a line of the record holds: 'at the bank', or 'at the bank and in hand' while Cash in hand is part of it. */
export function bankWhere(handCash) {
  return handCash ? 'at the bank and in hand' : 'at the bank';
}

/**
 * Material's line on what Cash in hand is: '' when there is no Cash in hand; "your count of {count} and payments
 * marked as cash since" once counted, else "from payments marked as cash".
 */
export function cashLineWords(state) {
  if (!cashAccountOf(state)) return '';
  const count = latestCount(state);
  return count ? 'Cash in hand: your count of ' + fmt(count.cents) + ' and payments marked as cash since.' : 'Cash in hand: from payments marked as cash.';
}

/** A payment answered (it was cash, it is in the bank, it came by Zelle, it is still coming), and how to change it. */
export function itemWords(label, how, cash, at, rollover) {
  const said = how === 'cash' ? ' was cash: it counts in Cash in hand.' : how === 'gone' ? ' is in the bank: it no longer counts on its own.'
    : how === 'bank' ? ' came by Zelle: the bank’s row counts for it.'
      : ' is still coming: Networth asks again on ' + fmtDate(gameDay(at + WAIT_MS, rollover), 'short') + '.';
  return (how === 'cash' ? withCash(label + said, cash, label + ' was cash.') : label + said) + (how === 'gone' ? CHANGE_GONE : CHANGE_ITEM);
}

/** A bank row's confirmation question answered for the payments it asks about (`n` of them). */
export function confirmWords(label, n, how, cash) {
  const change = n > 1 ? CHANGE_EACH : CHANGE_ITEM;
  if (how === 'cash') {
    return withCash(label + (n > 1 ? ': ' + n + ' payments were cash; they count in Cash in hand.' : ' was cash: it counts in Cash in hand.'), cash,
      label + (n > 1 ? ': ' + n + ' payments were cash.' : ' was cash.')) + change;
  }
  return label + (n > 1 ? ': ' + n + ' payments came by Zelle; the bank’s row counts for them.' : ' came by Zelle: the bank’s row counts for it.') + change;
}

/** A count of Cash in hand. */
export function countWords(cents, cover) {
  return (cover ? 'Cash in hand is counted.' : 'Cash in hand is counted: ' + fmt(cents) + '.') + CHANGE_COUNT;
}

/** The latest count removed: the count before it rules again. */
export function removedWords(value, cover) {
  return (cover ? 'The latest count is removed.' : 'The latest count is removed: Cash in hand is ' + fmt(value) + '.') + CHANGE_COUNT;
}

function moveOf(state, key) {
  return (Array.isArray(state.txs) ? state.txs : []).find((tx) => isIncomeMove(tx) && tx.income && tx.income.key === key) || null;
}

/** Where a payment counts: 'cash' (Cash in hand), 'row' (its bank row), 'pencil', or 'none' (no move: not counted). */
export function paymentState(state, key) {
  const move = moveOf(state, key);
  if (!move) return 'none';
  if (move.matchId) return 'row';
  return move.income.how === 'cash' ? 'cash' : 'pencil';
}

/**
 * After Ask again, what the payment does now, from its rebuilt move (`key`: "{source}/{item}"), led by its subject:
 * "{what} · {payer}: …", since the sheet closes or the line goes. `before`: where it counted before Ask again
 * (paymentState). "again" only for a return to pencil from "in the bank" (asked only of a payment in pencil),
 * "still" when it counts where it did, "now" otherwise. Cash in hand "stays as counted" only when it is the count.
 */
export function againWords(state, key, nowMs, before) {
  const rollover = rolloverOf(state);
  const move = moveOf(state, key);
  const payment = incomePayments(state, rollover).find((p) => p.key === key);
  const subject = payment ? incomeLabel(payment) : move && move.income.what && move.income.payer ? move.income.what + ' · ' + move.income.payer : '';
  const lead = subject ? subject + ': ' : '';
  const says = (text) => lead + (lead ? text : text.charAt(0).toUpperCase() + text.slice(1));
  if (!move) return says('it no longer counts.');
  if (move.income.confirm === true) return says('Networth asks about it on the board.');
  if (move.matchId) return says('the bank’s row counts for it.');
  if (move.income.how === 'cash') {
    const count = latestCount(state);
    if (count && !(move.at > count.at)) {
      const account = cashAccountOf(state);
      const value = account ? Math.round(Number(account.balance) || 0) : 0;
      return says('it was marked before ' + countDayWords(gameDay(count.at, rollover), gameDay(nowMs, rollover)) + ', so Cash in hand '
        + staysWords(state, value, !!(state.settings && state.settings.cover)) + '.');
    }
    return says(before === 'cash' ? 'it still counts in Cash in hand.' : 'it counts in Cash in hand now.');
  }
  const pencil = before === 'pencil' ? 'it still counts in pencil' : !before || before === 'none' ? 'it counts in pencil again' : 'it counts in pencil now';
  const askAt = move.at + LATE_MS;
  if (move.income.how === 'ask' || askAt <= nowMs) return says(pencil + '; Networth asks about it on the board.');
  return says(pencil + '; Networth asks on ' + fmtDate(gameDay(askAt, rollover), 'short') + ' if the bank has not shown it.');
}
