/**
 * The morning-plan sheet — "Opening preparation." Three taps: container filled (yes / no),
 * breakfast sorted (yes / no), planned stops today (0 / 1 / 2). It saves
 * state.days[today].plan = { container, breakfast, stops, at }. A planned stop is a book move.
 * Optional in every part: an unanswered line is saved as null, and nothing asks twice.
 *
 * The three choices are an ordinary form (morphing keeps what was tapped); nothing is kept in
 * store.ui, so every opening starts from the plan as saved.
 *
 * Actions
 *   plan.save    (data-submit) save today's plan, close, "Plan set …" with Undo
 *   plan.clear   remove today's plan, close, "Plan cleared …" with Undo
 */

import { html, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { closeSheet, onRoute } from '../router.js';
import { fmt } from '../model/money.js';
import { nowMs, fmtDate, fmtTime } from '../model/dates.js';
import { colourOf } from './parts.js';

export const label = 'Opening preparation';

const SHEET = 'plan';
const STOP_CHOICES = [0, 1, 2];

function fig(cents) {
  return html`<span data-fig>${fmt(cents)}</span>`;
}

function savedPlan(state, day) {
  const record = state.days[day];
  return record && record.plan ? record.plan : null;
}

/** One yes / no line. `value` is true, false or null (unanswered). */
function yesNo(name, legend, value) {
  return html`<fieldset class="field">
    <legend class="field-label lab">${legend}</legend>
    <div class="seg seg-block" role="radiogroup" aria-label="${legend}">
      <label class="seg-opt"><input type="radio" name="${name}" value="yes"${attrs({ checked: value === true })}><span>Yes</span></label>
      <label class="seg-opt"><input type="radio" name="${name}" value="no"${attrs({ checked: value === false })}><span>No</span></label>
    </div>
  </fieldset>`;
}

/** One sentence of context: who the day is played against, and what has been played already. */
function contextLine(ctx, round) {
  const made = round.stops > 0 ? html` ${round.stops} ${round.stops === 1 ? 'stop' : 'stops'} made so far today, ${fig(round.conv)}.` : '';
  if (!ctx.state.meta.matchStart || round.status === 'prematch') {
    return html`The match has not begun, so no round is scored on ${fmtDate(ctx.today, 'dowshort')}; the plan is kept with the day all the same.${made}`;
  }
  if (round.bye) return html`Round ${round.n} is a bye and scores a draw; a plan still marks which stops were meant.${made}`;
  return html`Round ${round.n}, with ${colourOf(round)}. Habit plays ${fig(round.habit)} on a ${round.type === 'work' ? 'workday' : 'day off'}; win at ${fig(round.winLine)} or less.${made}`;
}

export function render(ctx, params) {
  const round = ctx.d.todayRound;
  const plan = savedPlan(ctx.state, ctx.today);
  const cover = !!ctx.state.settings.cover;
  const stops = plan && Number.isFinite(plan.stops) ? plan.stops : null;
  return html`<form class="sheet-body pl" data-submit="plan.save"${attrs({ 'data-cover': cover })}>
    <p class="sheet-head lab"><b>Morning plan</b><i class="sep"></i>${fmtDate(ctx.today, 'dowshort')}</p>
    <h2 class="sheet-title">Opening preparation.</h2>
    <p class="cap">${contextLine(ctx, round)}</p>
    ${yesNo('container', 'Container filled', plan ? plan.container : null)}
    ${yesNo('breakfast', 'Breakfast sorted', plan ? plan.breakfast : null)}
    <fieldset class="field">
      <legend class="field-label lab">Planned stops today</legend>
      <div class="seg seg-fig seg-block" role="radiogroup" aria-label="Planned stops today">
        ${STOP_CHOICES.map((n) => html`<label class="seg-opt"><input type="radio" name="stops" value="${n}"${attrs({ checked: stops === n })}><span>${n}</span></label>`)}
      </div>
      <span class="field-help cap">A planned stop is a book move: it prints bare, without ?! or ?. An unanswered line stays blank.</span>
    </fieldset>
    ${plan ? html`<p class="pl-saved"><span class="cap">Set at ${fmtTime(plan.at)} on ${fmtDate(ctx.today, 'short')}.</span><button class="btn-link" type="button" data-action="plan.clear">Clear the plan</button></p>` : ''}
    <div class="sheet-actions">
      <button class="btn btn-solid" type="submit">${plan ? 'Update the plan' : 'Set the plan'}</button>
    </div>
  </form>`;
}

/* ---------------------------------------------------------------- actions */

let afterClose = null;

/** Close the sheet, then run `fn` once it has gone, so the save never redraws the sheet on its way out. */
function closeThen(fn) {
  afterClose = fn;
  closeSheet();
  setTimeout(() => {
    if (afterClose !== fn) return;
    afterClose = null;
    fn();
  }, 600);
}

onRoute((route) => {
  if (route.sheet && route.sheet.name === SHEET) return;
  const run = afterClose;
  afterClose = null;
  if (run) run();
});

function yn(value) {
  return value === 'yes' ? true : value === 'no' ? false : null;
}

/** Put a plan (or none) on a day, removing a day record that holds nothing else. */
function writePlan(state, day, plan) {
  if (plan) {
    if (!state.days[day]) state.days[day] = {};
    state.days[day].plan = plan;
    return;
  }
  const record = state.days[day];
  if (!record) return;
  delete record.plan;
  if (!Object.keys(record).length) delete state.days[day];
}

function offerUndo(message, day, before) {
  toast(message, {
    action: 'Undo',
    onAction: () => {
      store.update((s) => writePlan(s, day, before));
      toast(before ? 'The plan of ' + fmtTime(before.at) + ' is back.' : 'No plan for ' + fmtDate(day, 'dowshort') + '.');
    },
  });
}

export const actions = {
  'plan.save': ({ values }) => {
    const ctx = context();
    const day = ctx.today;
    const picked = values || {};
    const stops = STOP_CHOICES.includes(Number(picked.stops)) && picked.stops !== '' && picked.stops != null ? Number(picked.stops) : null;
    const plan = { container: yn(picked.container), breakfast: yn(picked.breakfast), stops, at: nowMs() };
    if (plan.container === null && plan.breakfast === null && plan.stops === null) {
      toast('Nothing chosen yet: tap any of the 3 lines to set a plan.');
      return;
    }
    const before = savedPlan(ctx.state, day);
    const previous = before ? { ...before } : null;
    closeThen(() => {
      store.update((s) => writePlan(s, day, plan));
      offerUndo('Plan set for ' + fmtDate(day, 'dowshort') + '.', day, previous);
    });
  },

  'plan.clear': () => {
    const ctx = context();
    const day = ctx.today;
    const before = savedPlan(ctx.state, day);
    if (!before) return;
    const previous = { ...before };
    closeThen(() => {
      store.update((s) => writePlan(s, day, null));
      offerUndo('Plan cleared for ' + fmtDate(day, 'dowshort') + '.', day, previous);
    });
  },
};
