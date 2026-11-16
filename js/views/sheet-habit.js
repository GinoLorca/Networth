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
import { sayHtml } from '../ui/say.js';
import { phrase, say } from '../model/words.js';

const WINDOW_DAYS = 60;
const UNDO_SEAT = 'New opponent seated';
const UNDO_UNSEAT = 'Today’s opponent removed';

export function label(ctx) {
  return phrase('habit.label', ctx && ctx.words);
}

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

function backtestLine(segment, words) {
  if (!segment.backtest || !segment.backtest.rounds) return null;
  const { score, rounds } = segment.backtest;
  return { score: scoreOf(score, rounds, words), pct: Math.round((score / rounds) * 100) };
}

/** The lines of one segment as a small table. `est` sets the figures in pencil (a segment not in force). */
function linesTable(segment, est, words) {
  const cell = (cents, whole) => html`<td class="${cx('num', est && 'est')}">${est ? html`<span class="approx">≈</span>` : ''}${fmt(cents, { decimals: whole ? 0 : 2 })}</td>`;
  return html`<table class="table table-s hb-lines">
    <thead><tr><th scope="col"><span class="vh">Line</span></th><th scope="col" class="num">${sayHtml('habit.col.work', words)}</th><th scope="col" class="num">${sayHtml('habit.col.off', words)}</th></tr></thead>
    <tbody>
      <tr><th scope="row">${sayHtml('habit.row.plays', words)}</th>${cell(segment.work)}${cell(segment.off)}</tr>
      <tr><th scope="row">${sayHtml('habit.row.win', words)}</th>${cell(segment.winWork, true)}${cell(segment.winOff, true)}</tr>
      <tr><th scope="row">${sayHtml('habit.row.loss', words)}</th>${cell(lossLine(segment.work), true)}${cell(lossLine(segment.off), true)}</tr>
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
    <p class="sheet-head lab"><b>${sayHtml('habit.label', ctx.words)}</b><i class="sep"></i>${sayHtml('habit.head.note', ctx.words)}</p>
    <h2 class="sheet-title">${sayHtml('habit.none', ctx.words)}</h2>
    <p class="hb-text">${sayHtml('habit.none.text', ctx.words, { days: WINDOW_DAYS })}</p>
    <ul class="rows hb-rows">
      <li class="row"><span class="row-label">Bank history needed</span><span class="row-value fig" data-cover-keep>${from - 1} full days</span></li>
      <li class="row"><span class="row-label">On record as of ${fmtDate(ctx.today, 'short')}</span><span class="row-value fig" data-cover-keep>${days} ${days === 1 ? 'day' : 'days'}</span></li>
    </ul>
    <p class="cap">${sayHtml('habit.none.later', ctx.words, { from, days })}</p>
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
      <h3 class="lab hb-sub" id="hb-offer-h"><b>${sayHtml('habit.today', ctx.words)}</b></h3>
      <p class="cap">${sayHtml('habit.today.text', ctx.words, { date: fmtDate(today, 'short') })}</p>
      <p class="hb-inline"><button class="btn-link" type="button" data-action="habit.unseat">${sayHtml('habit.today.remove', ctx.words)}</button></p>
    </section>`;
  }
  if (!candidate) {
    return html`<section class="hb-offer" aria-labelledby="hb-offer-h">
      <h3 class="lab hb-sub" id="hb-offer-h"><b>${sayHtml('habit.stronger', ctx.words)}</b></h3>
      <p class="cap">${sayHtml('habit.notEnough', ctx.words, { days: WINDOW_DAYS, full: ctx.d.matchFromDay - 1, date: fmtDate(today, 'short') })}</p>
    </section>`;
  }
  const bt = backtestLine(candidate, ctx.words);
  const stronger = isStronger(candidate, current);
  return html`<section class="hb-offer" aria-labelledby="hb-offer-h">
    <h3 class="lab hb-sub" id="hb-offer-h"><i class="hatch-mark"></i><b>${phrase(stronger ? 'habit.stronger' : 'habit.new', ctx.words)}</b><i class="sep"></i>from the last ${WINDOW_DAYS} days</h3>
    ${linesTable(candidate, true, ctx.words)}
    <p class="cap hb-note">Computed from ${span(candidate.window.from, candidate.window.to)}: ${difference(candidate.work, current.work, phrase('habit.workday', ctx.words))}, ${difference(candidate.off, current.off, 'day off')}${bt ? sayHtml('habit.offer.scored', ctx.words, { score: html`<span data-cover-keep>${bt.score}</span>` }) : ''}.
      ${stronger ? '' : sayHtml('habit.noStronger', ctx.words)}</p>
    <p class="cap hb-note">${sayHtml('habit.seating', ctx.words, { date: fmtDate(today, 'short') })}</p>
  </section>`;
}

export function render(ctx, params) {
  const { current, earlier } = segments(ctx.state, ctx.today);
  if (!current) return noOpponent(ctx);

  const matchStart = ctx.state.meta.matchStart;
  const edge = ctx.d.edge;
  const bt = backtestLine(current, ctx.words);
  const candidate = matchStart ? candidateFor(ctx.state, ctx.today) : null;
  const canSeat = !!candidate && !!matchStart && current.from !== ctx.today;

  return html`<div class="sheet-body hb"${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>${sayHtml('habit.label', ctx.words)}</b><i class="sep"></i>since ${fmtDate(current.from, 'short')}</p>
    <h2 class="sheet-title">${sayHtml('habit.title', ctx.words)}</h2>
    ${linesTable(current, false, ctx.words)}
    <ul class="rows rows-plain hb-rows">
      <li class="row">
        <span class="row-label">Computed from <em class="row-note">${current.window
          ? html`${current.window.workDays} workdays and ${current.window.offDays} days off of convenience spending.`
          : current.basis === 'manual' ? 'Set by hand.' : 'The window was not recorded.'}</em></span>
        <span class="row-value fig" data-cover-keep>${current.window ? span(current.window.from, current.window.to) : '—'}</span>
      </li>
      <li class="row">
        <span class="row-label">Back-test <em class="row-note">${bt
          ? sayHtml('habit.backtest', ctx.words, { pct: bt.pct })
          : 'No back-test was recorded for this segment.'}</em></span>
        <span class="row-value fig" data-cover-keep>${bt ? bt.score : '—'}</span>
      </li>
      <li class="row">
        <span class="row-label">${sayHtml('habit.edge', ctx.words)} <em class="row-note">${matchStart
          ? sayHtml('habit.edge.since', ctx.words, { date: fmtDate(matchStart, 'medium') })
          : say('habit.edge.none', ctx.words)}</em></span>
        <span class="row-value">${matchStart ? money(edge.kept, { est: true, signed: true }) : html`<span class="fig est" data-cover-keep>—</span>`}</span>
      </li>
    </ul>

    <section class="hb-earlier" aria-labelledby="hb-earlier-h">
      <h3 class="lab hb-sub" id="hb-earlier-h"><b>${sayHtml('habit.earlier', ctx.words)}</b></h3>
      ${earlier.length ? html`<ul class="rows rows-plain hb-rows">
        ${earlier.map((segment, i) => {
    const until = addDays(i === 0 ? current.from : earlier[i - 1].from, -1);
    return html`<li class="row" data-key="${segment.from}">
          <span class="row-label">${span(segment.from, until)} <em class="row-note">${sayHtml('habit.earlier.row', ctx.words, { work: amt(segment.work), off: amt(segment.off), winWork: amt(segment.winWork, { decimals: 0 }), winOff: amt(segment.winOff, { decimals: 0 }) })}</em></span>
        </li>`;
  })}
      </ul>` : html`<p class="cap">${sayHtml('habit.first', ctx.words, { date: fmtDate(current.from, 'medium') })}</p>`}
    </section>

    ${offer(ctx, current, candidate)}

    <div class="sheet-actions">
      ${canSeat
    ? html`<button class="btn" type="button" data-action="habit.stronger">${phrase(isStronger(candidate, current) ? 'habit.play.stronger' : 'habit.play.this', ctx.words)}</button>`
    : html`<button class="btn" type="button" data-action="app.sheet-close">Close</button>`}
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- actions */

function undoIf(expected) {
  if (store.undoLabel !== expected) return;
  const undone = store.undo();
  const words = (context() || {}).words;
  const shown = undone === UNDO_SEAT ? phrase('habit.undo.seat', words) : undone === UNDO_UNSEAT ? phrase('habit.undo.unseat', words) : undone;
  if (undone) toast('Undone on ' + fmtDate(context().today, 'short') + ': ' + String(shown).replace(/[.]+$/, '') + '.');
}

export const actions = {
  /** Seat a new opponent computed from the 60 days before today. The old edge is kept. */
  'habit.stronger': () => {
    const ctx = context();
    const today = ctx.today;
    if (!ctx.state.meta.matchStart || (ctx.state.habits || []).some((segment) => segment.from === today)) return;
    const candidate = candidateFor(ctx.state, today);
    if (!candidate) {
      toast(say('habit.toast.needs', ctx.words, { full: ctx.d.matchFromDay - 1, days: WINDOW_DAYS }));
      return;
    }
    store.update((s) => {
      s.habits.push({ from: today, ...candidate });
      s.habits.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    }, { undo: UNDO_SEAT });
    toast(say('habit.toast.seated', ctx.words, { date: fmtDate(today, 'short') }), { action: 'Undo', onAction: () => undoIf(UNDO_SEAT) });
  },

  /** Remove a segment seated today; the one before it is in force again. */
  'habit.unseat': () => {
    const ctx = context();
    const today = ctx.today;
    const habits = ctx.state.habits || [];
    if (habits.length < 2 || !habits.some((segment) => segment.from === today)) return;
    const before = habits.filter((segment) => segment.from < today).map((segment) => segment.from).sort().pop();
    store.update((s) => { s.habits = s.habits.filter((segment) => segment.from !== today); }, { undo: UNDO_UNSEAT });
    toast(say('habit.toast.removed', ctx.words, { date: fmtDate(today, 'short'), from: before ? fmtDate(before, 'short') : phrase('habit.matchStart', ctx.words) }), { action: 'Undo', onAction: () => undoIf(UNDO_UNSEAT) });
  },
};
