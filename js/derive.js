/**
 * Derived data for one render: every engine result a view may need, computed lazily and
 * at most once per render. Views read `ctx.d`; they never call the engine with their own clock.
 *
 *   d.today                    today's game day
 *   d.position                 ledger Position: cash, cards, liquid, assets, liabilities, bank, smooth, live, rate, receivables…
 *   d.clock                    ledger Clock: cash, nextPayday, due[], shortfall, runwayDays, milestones…
 *   d.edge                     ledger Edge: kept, moved, unmoved, sweep suggestion, form, unbeaten
 *   d.round(day)               ledger Round for a day          d.todayRound / d.lastRound (latest round with a result, else yesterday)
 *   d.annotations(day)         { moves: Map<txId, Annotation>, round: Annotation|null } for that round
 *   d.month(ym)                ledger MonthTable               d.thisMonth
 *   d.closes(from, to)         ledger DayClose[]               d.yesterday (DayClose of yesterday, or null)
 *   d.recent(days)             DayClose[] for the last `days` days ending today
 *   d.retention(day?)          month-to-date earned / bills / spent / kept
 *   d.spending(from, to)       spending by category
 *   d.assessment               the four factors and the verdict
 *   d.notes                    up to three coach's notes
 *   d.review(ym)               the month review
 *   d.cardsNow                 revolving debt now              d.cardMonths(n) all cards, n months     d.cardMonthsFor(id, n)
 *   d.bookTotals               totals of the Book              d.upcoming(days)    d.renewals(days)
 *   d.pace(days?)              measured pace                   d.projection        d.reserve    d.ladder    d.payoff
 *   d.chips                    the owner's most frequent convenience purchases (for one-tap chips)
 *   d.reviewCount              moves waiting for a decision
 *   d.account(id)              an account by id                d.accounts(group)   non-hidden accounts of a group ('cash'|'card'|'asset'|'debt')
 *   d.valueOf(account)         an account's value now, signed cents (bank: reported + pending; manual: its latest value / amortised)
 *   d.sweepTxIds               Set of transaction ids recorded as sweeps
 */

import { gameDay, addDays, monthOf } from './model/dates.js';
import { ACCOUNT_TYPES } from './model/schema.js';
import { makeLedger } from './model/ledger.js';
import { annotateRound } from './model/annotate.js';
import { assess, coachNotes, monthReview } from './model/assess.js';
import { cardsNow, allCardsMonths, cardMonths, historyDays } from './model/cards.js';
import { bookTotals, upcoming, renewals } from './model/book.js';
import { pace, paceMinDays, projectNetWorth, reserveGoal, incomeLadder, cardPayoff } from './model/forecast.js';
import { topMerchants } from './model/classify.js';
import { recentTransactions } from './model/recent.js';
import { MATCH_FROM_DAY } from './model/detect.js';

const LOOKBACK_FOR_LAST_ROUND = 10;

/**
 * @param {object} state  the document
 * @param {number} now    timestamp of this render
 */
export function makeDerived(state, now) {
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  const today = gameDay(now, state.settings.rolloverHour);
  // One ledger for the whole render: every figure of a pass is read from the same index of the
  // document. (Building it per question made a Board render cost tens of ledgers.)
  const led = () => once('ledger', () => makeLedger(state, now));
  // The model functions that open a ledger of their own accept this one instead.
  const shared = () => ({ ledger: led() });

  const d = {
    today,

    get position() { return once('position', () => led().position()); },
    get clock() { return once('clock', () => led().clock()); },
    get edge() { return once('edge', () => led().edge()); },

    /** Days on record, today included (Jun 1 to Jun 10 is 10): the one count of history every screen prints. */
    get historyDays() { return once('historyDays', () => historyDays(state, today)); },
    /** The day on record from which the match is played (15: Habit needs 14 completed days first). */
    matchFromDay: MATCH_FROM_DAY,
    /** This render's ledger, for a view that calls a model function taking { ledger } itself. */
    get ledger() { return led(); },
    /** The streams that count as pay: scheduled, not lapsed, not a trickle. */
    get payStreams() { return once('payStreams', () => led().payStreams()); },

    round(day) { return once('round:' + day, () => led().round(day)); },
    get todayRound() { return d.round(today); },
    get lastRound() {
      return once('lastRound', () => {
        for (let i = 1; i <= LOOKBACK_FOR_LAST_ROUND; i++) {
          const r = d.round(addDays(today, -i));
          if (r.result != null && r.status !== 'prematch') return r;
        }
        return d.round(addDays(today, -1));
      });
    },
    annotations(day) {
      return once('ann:' + day, () => annotateRound(d.round(day), { sweepTxIds: d.sweepTxIds }));
    },

    month(ym) { return once('month:' + ym, () => led().monthTable(ym)); },
    get thisMonth() { return d.month(monthOf(today)); },

    closes(from, to) { return once('closes:' + from + ':' + to, () => led().closes(from, to)); },
    recent(days) { return d.closes(addDays(today, -(days - 1)), today); },
    get yesterday() {
      return once('yesterday', () => {
        const y = addDays(today, -1);
        const rows = d.closes(y, y);
        return rows.length ? rows[0] : null;
      });
    },

    retention(day = today) { return once('retention:' + day, () => led().retention(day)); },
    spending(from, to) { return once('spending:' + from + ':' + to, () => led().spendingByCategory(from, to)); },

    get assessment() { return once('assessment', () => assess(state, now, shared())); },
    get notes() { return once('notes', () => coachNotes(state, now, { limit: 3, ledger: led() })); },
    review(ym) { return once('review:' + ym, () => monthReview(state, ym, now, shared())); },

    get cardsNow() { return once('cardsNow', () => cardsNow(state, now, shared())); },
    cardMonths(n = 6) { return once('cardMonths:' + n, () => allCardsMonths(state, n, now, shared())); },
    cardMonthsFor(id, n = 6) { return once('cardMonthsFor:' + id + ':' + n, () => cardMonths(state, id, n, now, shared())); },

    get bookTotals() { return once('bookTotals', () => bookTotals(state)); },
    upcoming(days = 30) { return once('upcoming:' + days, () => upcoming(state, today, days)); },
    renewals(days = 120) { return once('renewals:' + days, () => renewals(state, today, days)); },

    pace(days = 30) { return once('pace:' + days, () => pace(state, now, days, shared())); },
    /** Completed days a pace over `days` needs; the interface says "from day N + 1 on record". */
    paceMinDays(days = 30) { return once('paceMin:' + days, () => paceMinDays(state, now, days, shared())); },
    get projection() { return once('projection', () => projectNetWorth(state, now, shared())); },
    get reserve() { return once('reserve', () => reserveGoal(state, now, shared())); },
    get ladder() { return once('ladder', () => incomeLadder(state, now, shared())); },
    get payoff() { return once('payoff', () => cardPayoff(state, now, shared())); },

    get chips() { return once('chips', () => topMerchants(state, { limit: 6, sinceDay: addDays(today, -90) })); },
    get reviewCount() {
      return once('reviewCount', () => {
        const since = addDays(today, -90);
        let n = 0;
        for (const t of state.txs) if (t.review && !t.matchId && t.kind !== 'decline' && t.day >= since) n++;
        return n;
      });
    },

    account(id) { return state.accounts.find((a) => a.id === id) || null; },
    accounts(group) {
      return state.accounts.filter((a) => !a.hidden && ACCOUNT_TYPES[a.type] && ACCOUNT_TYPES[a.type].group === group);
    },
    valueOf(account) { return once('value:' + account.id, () => led().accountValueOn(account.id, today)); },

    /** The latest transactions on every account, newest first; `seenAt` (ms) marks what arrived since the last look. */
    latest(limit = 12, seenAt = null) { return once('latest:' + limit + ':' + seenAt, () => recentTransactions(state, today, { limit, seenAt })); },

    get sweepTxIds() {
      return once('sweepTxIds', () => new Set(state.sweeps.map((s) => s.txId).filter(Boolean)));
    },
  };
  return d;
}
