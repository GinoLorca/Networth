/**
 * The habit sheet — "the opponent".
 *
 * Shows the habit segment in force (what Habit plays on a workday and on a day off, the win and
 * loss lines, the window it was computed from and its back-test), the earlier segments, and one
 * plain offer: seat a new opponent computed from the last 60 days, starting today. Nothing here is
 * ever started automatically, and the kept total is never reset: a new segment only sets the
 * lines from its first day on.
 *
 * The sheet host sits outside the page element that carries data-cover, so the sheet body carries
 * the attribute itself while figures are covered.
 *
 * Actions
 *   habit.stronger   push a new segment from detect.computeHabit over the 60 days before today (undoable)
 *   habit.unseat     remove a segment that was seated today, restoring the one before it (undoable)
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { fmt, fmtSigned } from '../model/money.js';
import { addDays, fmtDate } from '../model/dates.js';
import { computeHabit } from '../model/detect.js';
import { money, scoreOf } from './parts.js';

const WINDOW_DAYS = 60;
const UNDO_SEAT = 'New opponent seated';
const UNDO_UNSEAT = 'Today’s opponent removed';

export const label = 'The opponent';

/* ----------------------------------------------------------------- helpers */

function sorted(habits) {
  return (habits || []).slice().sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** The segment in force today and the ones before it (newest first). */
function segments(state, today) {
  const all = sorted(state.habits);
  let index = -1;
  all.forEach((segment, i) => { if (segment.from <= today) index = i; });
  if (index < 0 && all.length) index = 0;
  return { current: index >= 0 ? all[index] : null, earlier: index > 0 ? all.slice(0, index).reverse() : [], all, index };
}

function candidateFor(state, today) {
  return computeHabit(state, addDays(today, -WINDOW_DAYS), addDays(today, -1));
}

/** Habit rounded up to a whole dollar: spend more than this and the round is lost. */
function lossLine(habit) {
  return Math.ceil(habit / 100) * 100;
}

function amt(cents, opts = {}) {
  const text = opts.signed ? fmtSigned(cents, { decimals: opts.decimals ?? 2 }) : fmt(cents, { decimals: opts.decimals ?? 2 });
  return html`<span class="nowrap" data-fig>${opts.est ? '≈' : ''}${text}</span>`;
}

function span(from, to) {
  return fmtDate(from, 'short') + ' – ' + fmtDate(to, 'medium');
}

function backtestLine(segment) {
  if (!segment.backtest || !segment.backtest.rounds) return null;
  const { score, rounds } = segment.backtest;
  return { score: scoreOf(score, rounds), pct: Math.round((score / rounds) * 100) };
}

/** The lines of one segment as a small table. `est` sets the figures in pencil (a segment not in force). */
function linesTable(segment, est) {
  const cell = (cents, whole) => html`<td class="${cx('num', est && 'est')}">${est ? html`<span class="approx">≈</span>` : ''}${fmt(cents, { decimals: whole ? 0 : 2 })}</td>`;
  return html`<table class="table table-s hb-lines">
    <thead><tr><th scope="col"><span class="vh">Line</span></th><th scope="col" class="num">Workday<span class="not-phone"> · Black</span></th><th scope="col" class="num">Day off<span class="not-phone"> · White</span></th></tr></thead>
    <tbody>
      <tr><th scope="row">Habit plays</th>${cell(segment.work)}${cell(segment.off)}</tr>
      <tr><th scope="row">A win at or under</th>${cell(segment.winWork, true)}${cell(segment.winOff, true)}</tr>
      <tr><th scope="row">A loss over</th>${cell(lossLine(segment.work), true)}${cell(lossLine(segment.off), true)}</tr>
    </tbody>
  </table>`;
}

function difference(now, then, what) {
  const delta = now - then;
  if (delta === 0) return html`${what} unchanged`;
  return html`${what} ${delta < 0 ? 'lower' : 'higher'} by ${amt(Math.abs(delta), { est: true })}`;
}

/* ------------------------------------------------------------------ render */

function noOpponent(ctx) {
  const days = ctx.d.historyDays;
  const from = ctx.d.matchFromDay;
  return html`<div class="sheet-body hb"${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>The opponent</b><i class="sep"></i>Habit</p>
    <h2 class="sheet-title">No opponent is seated yet.</h2>
    <p class="hb-text">Habit is your own average convenience spending — cafes, delis, delivery, snacks — over the ${WINDOW_DAYS} days before the match, taken apart for workdays and days off.</p>
    <ul class="rows hb-rows">
      <li class="row"><span class="row-label">Bank history needed</span><span class="row-value fig" data-cover-keep>${from - 1} full days</span></li>
      <li class="row"><span class="row-label">On record as of ${fmtDate(ctx.today, 'short')}</span><span class="row-value fig" data-cover-keep>${days} ${days === 1 ? 'day' : 'days'}</span></li>
    </ul>
    <p class="cap">Nothing needs doing. The match begins by itself on day ${from} on record; ${days} so far. Rounds are scored from that day on.</p>
    <div class="sheet-actions"><button class="btn" type="button" data-action="app.sheet-close">Close</button></div>
  </div>`;
}

function isStronger(candidate, current) {
  return candidate.work < current.work || candidate.off < current.off || candidate.winWork < current.winWork || candidate.winOff < current.winOff;
}

function offer(ctx, current, candidate) {
  const today = ctx.today;
  if (current.from === today && segments(ctx.state, today).earlier.length) {
    return html`<section class="hb-offer" aria-labelledby="hb-offer-h">
      <h3 class="lab hb-sub" id="hb-offer-h"><b>Seated today</b></h3>
      <p class="cap">This opponent was seated today, ${fmtDate(today, 'short')}. It can be removed until the day is over; the one before it then plays again.</p>
      <p class="hb-inline"><button class="btn-link" type="button" data-action="habit.unseat">Remove today’s opponent</button></p>
    </section>`;
  }
  if (!candidate) {
    return html`<section class="hb-offer" aria-labelledby="hb-offer-h">
      <h3 class="lab hb-sub" id="hb-offer-h"><b>A stronger opponent</b></h3>
      <p class="cap">A new opponent is computed from the last ${WINDOW_DAYS} days and needs ${ctx.d.matchFromDay - 1} full days of bank history in that window. There is not enough as of ${fmtDate(today, 'short')}.</p>
    </section>`;
  }
  const bt = backtestLine(candidate);
  const stronger = isStronger(candidate, current);
  return html`<section class="hb-offer" aria-labelledby="hb-offer-h">
    <h3 class="lab hb-sub" id="hb-offer-h"><i class="hatch-mark"></i><b>${stronger ? 'A stronger opponent' : 'A new opponent'}</b><i class="sep"></i>from the last ${WINDOW_DAYS} days</h3>
    ${linesTable(candidate, true)}
    <p class="cap hb-note">Computed from ${span(candidate.window.from, candidate.window.to)}: ${difference(candidate.work, current.work, 'workday habit')}, ${difference(candidate.off, current.off, 'day off')}${bt ? html`; that window would have scored <span data-cover-keep>${bt.score}</span>` : ''}.
      ${stronger ? '' : html`On these figures it would be no stronger than the one in force.`}</p>
    <p class="cap hb-note">Seating it starts a new segment today, ${fmtDate(today, 'short')}. The kept total is never reset: every earlier round keeps its result, and only the lines change from today on.</p>
  </section>`;
}

export function render(ctx, params) {
  const { current, earlier } = segments(ctx.state, ctx.today);
  if (!current) return noOpponent(ctx);

  const matchStart = ctx.state.meta.matchStart;
  const edge = ctx.d.edge;
  const bt = backtestLine(current);
  const candidate = matchStart ? candidateFor(ctx.state, ctx.today) : null;
  const canSeat = !!candidate && !!matchStart && current.from !== ctx.today;

  return html`<div class="sheet-body hb"${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>The opponent</b><i class="sep"></i>since ${fmtDate(current.from, 'short')}</p>
    <h2 class="sheet-title">Habit, your own frozen baseline.</h2>
    ${linesTable(current, false)}
    <ul class="rows rows-plain hb-rows">
      <li class="row">
        <span class="row-label">Computed from <em class="row-note">${current.window
          ? html`${current.window.workDays} workdays and ${current.window.offDays} days off of convenience spending.`
          : current.basis === 'manual' ? 'Set by hand.' : 'The window was not recorded.'}</em></span>
        <span class="row-value fig" data-cover-keep>${current.window ? span(current.window.from, current.window.to) : '—'}</span>
      </li>
      <li class="row">
        <span class="row-label">Back-test <em class="row-note">${bt
          ? html`Under these lines that window would have scored ${bt.pct}%. The win line is set where the score comes nearest 40%.`
          : 'No back-test was recorded for this segment.'}</em></span>
        <span class="row-value fig" data-cover-keep>${bt ? bt.score : '—'}</span>
      </li>
      <li class="row">
        <span class="row-label">Kept v. Habit <em class="row-note">${matchStart
          ? html`Since ${fmtDate(matchStart, 'medium')}, over every opponent. A counterfactual: never reset, never cash.`
          : 'No round has been scored yet.'}</em></span>
        <span class="row-value">${matchStart ? money(edge.kept, { est: true, signed: true }) : html`<span class="fig est" data-cover-keep>—</span>`}</span>
      </li>
    </ul>

    <section class="hb-earlier" aria-labelledby="hb-earlier-h">
      <h3 class="lab hb-sub" id="hb-earlier-h"><b>Earlier opponents</b></h3>
      ${earlier.length ? html`<ul class="rows rows-plain hb-rows">
        ${earlier.map((segment, i) => {
    const until = addDays(i === 0 ? current.from : earlier[i - 1].from, -1);
    return html`<li class="row" data-key="${segment.from}">
          <span class="row-label">${span(segment.from, until)} <em class="row-note">Habit played ${amt(segment.work)} on a workday and ${amt(segment.off)} on a day off; a win at ${amt(segment.winWork, { decimals: 0 })} and ${amt(segment.winOff, { decimals: 0 })} or less.</em></span>
        </li>`;
  })}
      </ul>` : html`<p class="cap">None: this is the first, seated ${fmtDate(current.from, 'medium')}. Habit never changes by itself.</p>`}
    </section>

    ${offer(ctx, current, candidate)}

    <div class="sheet-actions">
      ${canSeat
    ? html`<button class="btn" type="button" data-action="habit.stronger">${isStronger(candidate, current) ? 'Play a stronger opponent' : 'Play this opponent from today'}</button>`
    : html`<button class="btn" type="button" data-action="app.sheet-close">Close</button>`}
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- actions */

function undoIf(expected) {
  if (store.undoLabel !== expected) return;
  const undone = store.undo();
  if (undone) toast('Undone on ' + fmtDate(context().today, 'short') + ': ' + String(undone).replace(/[.]+$/, '') + '.');
}

export const actions = {
  /** Seat a new opponent computed from the 60 days before today. The old edge is kept. */
  'habit.stronger': () => {
    const ctx = context();
    const today = ctx.today;
    if (!ctx.state.meta.matchStart || (ctx.state.habits || []).some((segment) => segment.from === today)) return;
    const candidate = candidateFor(ctx.state, today);
    if (!candidate) {
      toast('A new opponent needs ' + (ctx.d.matchFromDay - 1) + ' full days of bank history in the last ' + WINDOW_DAYS + '.');
      return;
    }
    store.update((s) => {
      s.habits.push({ from: today, ...candidate });
      s.habits.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    }, { undo: UNDO_SEAT });
    toast('A new opponent plays from ' + fmtDate(today, 'short') + '. The kept total carries over.', { action: 'Undo', onAction: () => undoIf(UNDO_SEAT) });
  },

  /** Remove a segment seated today; the one before it is in force again. */
  'habit.unseat': () => {
    const ctx = context();
    const today = ctx.today;
    const habits = ctx.state.habits || [];
    if (habits.length < 2 || !habits.some((segment) => segment.from === today)) return;
    const before = habits.filter((segment) => segment.from < today).map((segment) => segment.from).sort().pop();
    store.update((s) => { s.habits = s.habits.filter((segment) => segment.from !== today); }, { undo: UNDO_UNSEAT });
    toast('Removed: the opponent seated ' + fmtDate(today, 'short') + '; the one from ' + (before ? fmtDate(before, 'short') : 'the start of the match') + ' plays again.', { action: 'Undo', onAction: () => undoIf(UNDO_UNSEAT) });
  },
};
