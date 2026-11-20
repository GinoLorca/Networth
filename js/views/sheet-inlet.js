/**
 * The source's sheet (params.id; none for a new source): its name (1 to 40 characters) and kind (four chips), an
 * optional goal (an amount a month or a year) and the Passed pawn / Focus tag; Archive (`gone`) and Restore from the
 * archive; Remove, after a confirm that counts what is filed to it (`removed`: its filings then read as Not yet filed).
 * Each edit is one store.update, travels in the `flows` section (model/inlets.js, flowsection.noteInlet) and can be
 * undone. The plan's use of goals and the tag comes in pass 4.
 *
 * Actions: inlet.save (the form; a new source too) · inlet.archive · inlet.restore · inlet.remove-ask ·
 *          inlet.remove (the confirm) · inlet.remove-cancel
 */

import { html, attrs, cx } from '../ui/dom.js';
import { store } from '../store.js';
import { closeSheet, onRoute } from '../router.js';
import { context, toast } from '../runtime.js';
import { sayHtml } from '../ui/say.js';
import { phrase, say } from '../model/words.js';
import { fmt, fmtPlain } from '../model/money.js';
import { nowMs } from '../model/dates.js';
import { INLETS_LIVE_MAX } from '../model/flowsection.js';
import { INLET_KINDS, canMakeInlet, editInlet, filingsTo, goalCents, inletName, inletsOf, makeInlet, moneyInBySource } from '../model/inlets.js';
import { kindLabel, payBefore, payNote } from './inflows.js';

export const label = (ctx, params) => {
  const inlet = params && params.id ? inletsOf(ctx.state).get(params.id) : null;
  return inlet ? phrase('inlet.sheet', ctx.words) + ': ' + (inlet.name || '') : phrase('inlet.sheet.new', ctx.words);
};

function undoLast() {
  const label = store.undo();
  if (label) toast(say('flows.undone', (context() || {}).words, { what: String(label).replace(/[.]+$/, '') }));
}

/**
 * What the Remove confirm says a source's filings reach in the 12 months (pure): "13 deposits in the 12 months", and the
 * payments your other app reported named apart, cash and pencil ones included ("75 deposits and 6 payments your other app
 * reported in the 12 months", round 5); '' for none.
 * @param {{ deposits?: number, payments?: number }|null} year  a source row's `year` (inlets.moneyInBySource)
 */
export function removeReach(words, year) {
  const deposits = year && year.deposits > 0 ? year.deposits : 0;
  const payments = year && year.payments > 0 ? year.payments : 0;
  if (!payments) return deposits === 1 ? phrase('inlet.remove.reachOne', words) : deposits ? say('inlet.remove.reach', words, { n: deposits }) : '';
  const parts = [];
  if (deposits) parts.push(deposits === 1 ? phrase('inlet.remove.depositsOne', words) : say('inlet.remove.deposits', words, { n: deposits }));
  parts.push(payments === 1 ? phrase('inlet.remove.paymentsOne', words) : say('inlet.remove.payments', words, { n: payments }));
  return say('inlet.remove.reachAll', words, { what: parts.join(' ' + phrase('inlet.remove.and', words) + ' ') });
}

export function render(ctx, params) {
  const id = params && params.id ? params.id : null;
  const inlet = id ? inletsOf(ctx.state).get(id) : null;
  if (id && (!inlet || inlet.removed)) {
    return html`<div class="sheet-body">
      <p class="sheet-head lab"><b>${sayHtml('inlet.sheet', ctx.words)}</b></p>
      <h2 class="sheet-title">${sayHtml('inlet.sheet.gone', ctx.words)}</h2>
      <div class="sheet-actions"><button class="btn" type="button" data-action="app.sheet-close">${sayHtml('inlet.cancel', ctx.words)}</button></div>
    </div>`;
  }
  const kind = inlet ? inlet.kind : 'job';
  const goal = inlet && inlet.goal ? inlet.goal : null;
  const goalText = goal ? fmtPlain(goal.cents, { decimals: goal.cents % 100 === 0 ? 0 : 2 }) : '';
  const asking = !!(ctx.ui.inletRemove && ctx.ui.inletRemove === id);
  let year = null;
  let filings = 0;
  if (inlet) {
    const sec = moneyInBySource(ctx.state, ctx.now, 30, { ledger: ctx.d.ledger });
    const row = sec.rows.find((one) => one.id === id);
    year = row ? row.year : null;
    filings = filingsTo(ctx.state, id);
  }
  // the confirm counts what was filed (a payer or an app once) and the deposits it reaches in the 12 months, the payments
  // your other app reported apart (round 5)
  const reach = removeReach(ctx.words, year);
  const count = (filings === 1 ? phrase('inlet.remove.one', ctx.words) : say('inlet.remove.many', ctx.words, { n: filings })) + (reach ? ', ' + reach + ',' : '');
  return html`<form class="sheet-body inlet-form" data-submit="inlet.save" ${attrs({ 'data-id': id || '' })} novalidate ${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>${sayHtml('inlet.sheet', ctx.words)}</b>${inlet ? html`<i class="sep"></i>${kindLabel(kind, ctx.words)}` : ''}${inlet && inlet.gone ? html`<i class="sep"></i>${say('inlets.archived', ctx.words)}` : ''}</p>
    <h2 class="sheet-title">${inlet ? inlet.name : sayHtml('inlet.sheet.new', ctx.words)}</h2>
    ${inlet ? html`<ul class="rows bks-facts">
      <li class="row"><span class="row-label">${sayHtml('inlet.money', ctx.words)}</span><span class="${cx('row-value fig', year && year.est && 'est')}">${year ? html`${year.est ? html`<span class="approx">≈</span>` : ''}${fmt(year.cents)}` : '—'}</span></li>
      <li class="row"><span class="row-label">${sayHtml('inlet.filings', ctx.words)}</span><span class="row-value" data-cover-keep>${filings === 1 ? phrase('inlet.filings.countOne', ctx.words) : say('inlet.filings.count', ctx.words, { n: filings })}</span></li>
    </ul>` : ''}

    <label class="field">
      <span class="field-label lab">${sayHtml('inlet.name', ctx.words)}</span>
      <input class="input" type="text" name="name" value="${inlet ? inlet.name : ''}" maxlength="40" autocomplete="off" required>
      <span class="cap">${sayHtml('inlet.name.note', ctx.words)}</span>
    </label>

    <fieldset class="field">
      <legend class="field-label lab">${sayHtml('inlet.kind', ctx.words)}</legend>
      <div class="chips inlet-kinds">
        ${INLET_KINDS.map((k) => html`<label class="chip"><input type="radio" name="kind" value="${k}" ${attrs({ checked: k === kind })}><span>${kindLabel(k, ctx.words)}</span></label>`)}
      </div>
      <p class="cap">${INLET_KINDS.map((k) => html`<b>${kindLabel(k, ctx.words)}</b>: ${say('inlets.kind.' + k + '.note', ctx.words)}. `)}</p>
    </fieldset>

    <fieldset class="field inlet-goal">
      <legend class="field-label lab">${sayHtml('inlet.goal', ctx.words)}</legend>
      <span class="inlet-goal-row">
        <span class="an-in" style="${'--w:' + (Math.max(4, goalText.length) + 0.5) + ';--min:4'}">
          <span class="an-in-fix" aria-hidden="true">$</span>
          <input type="text" inputmode="decimal" name="goal" autocomplete="off" value="${goalText}" placeholder="—" aria-label="${say('inlet.goal.aria', ctx.words, { name: inlet ? inlet.name : '' })}" ${goalText ? html`data-fig` : ''}>
        </span>
        <span class="seg" role="radiogroup" aria-label="${say('inlet.goal', ctx.words)}">
          <label class="seg-opt"><input type="radio" name="per" value="month" ${attrs({ checked: !goal || goal.per === 'month' })}><span>${sayHtml('inlet.goal.month', ctx.words)}</span></label>
          <label class="seg-opt"><input type="radio" name="per" value="year" ${attrs({ checked: !!goal && goal.per === 'year' })}><span>${sayHtml('inlet.goal.year', ctx.words)}</span></label>
        </span>
      </span>
      <p class="cap">${sayHtml('inlet.goal.note', ctx.words)}</p>
    </fieldset>

    <label class="switch switch-block bks-switch">
      <span class="switch-text">${sayHtml('inlet.focus.switch', ctx.words)}</span>
      <input type="checkbox" role="switch" name="focus" ${attrs({ checked: !!(inlet && inlet.focus) })}>
      <span class="switch-track" aria-hidden="true"></span>
    </label>

    ${inlet ? html`<p class="cap">${sayHtml('inlet.archive.note', ctx.words)}</p>` : ''}
    ${asking ? html`<div class="sheet-actions inlet-confirm" role="alertdialog" aria-labelledby="inlet-confirm-q">
      <p class="cap inlet-confirm-q" id="inlet-confirm-q">${filings ? say('inlet.remove.confirm', ctx.words, { name: inlet.name, count }) : say('inlet.remove.confirmNone', ctx.words, { name: inlet.name })}</p>
      <button class="btn" type="button" data-action="inlet.remove-cancel">${sayHtml('inlet.cancel', ctx.words)}</button>
      <button class="btn btn-solid" type="button" data-action="inlet.remove" data-id="${id}">${sayHtml('inlet.remove.yes', ctx.words)}</button>
    </div>` : html`<div class="sheet-actions">
      ${inlet ? html`<button class="btn" type="button" data-action="inlet.remove-ask" data-id="${id}">${sayHtml('inlet.remove', ctx.words)}</button>
        <button class="btn" type="button" data-action="${inlet.gone ? 'inlet.restore' : 'inlet.archive'}" data-id="${id}">${sayHtml(inlet.gone ? 'inlet.restore' : 'inlet.archive', ctx.words)}</button>` : ''}
      <button class="btn btn-solid" type="submit">${sayHtml(inlet ? 'inlet.save' : 'inlet.add', ctx.words)}</button>
    </div>`}
  </form>`;
}

/**
 * The Remove confirm takes the pinned action bar while it asks (round 6), where Remove was tapped, so a phone shows it at
 * once: the focus goes to its Cancel (the alert dialog is then read out), and back to Remove when it is cancelled.
 * Round 9 (K20): a window under 481 px tall (a phone on its side) keeps the bar static at the sheet's end (css/ui.css), and
 * the confirm, taller than the bar, opened with its buttons half below the edge: it is scrolled into view, the least
 * distance that shows it whole.
 */
function focusIn(selector) {
  const go = () => {
    const host = document.getElementById('sheet-host') || document;
    const target = host.querySelector(selector);
    if (!target) return;
    target.focus();
    const confirm = typeof target.closest === 'function' ? target.closest('.inlet-confirm') : null;
    if (confirm && typeof confirm.scrollIntoView === 'function') confirm.scrollIntoView({ block: 'nearest' });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(go)); else setTimeout(go, 0);
}

// a confirm left open is cleared when the sheet closes, so the sheet opens on its form next time (round 6)
onRoute((route) => { if (!(route && route.sheet && route.sheet.name === 'inlet') && store.ui.inletRemove) store.setUi({ inletRemove: null }); });

/** One edit of a source, one undoable update, and its toast with Undo. */
function edit(id, fields, toastKey) {
  const ctx = context();
  if (!ctx) return false;
  const words = phrase('inlet.undo', ctx.words);
  const at = nowMs();
  // the pay before the edit, read before the update changes the record (round 5)
  const before = payBefore(ctx);
  let done = false;
  store.update((s) => { done = editInlet(s, id, fields, at); }, { undo: words });
  if (!done) { if (store.undoLabel === words) store.undo(); return false; }
  const inlet = inletsOf(store.state).get(id);
  // a kind that is not Steady pay ends its payers' pay (G.7.2): the toast says so, by the Undo (round 4)
  toast(say(toastKey, ctx.words, { name: inlet ? inlet.name : '' }) + payNote(ctx, before), { action: phrase('flows.undo', ctx.words), onAction: undoLast });
  return true;
}

export const actions = {
  'inlet.save': ({ values, data }) => {
    const ctx = context();
    if (!ctx) return;
    const v = values || {};
    const name = inletName(v.name);
    const kind = INLET_KINDS.includes(v.kind) ? v.kind : null;
    const cents = goalCents(v.goal);
    if (!name || !kind) { toast(say('inlet.toast.bad', ctx.words)); return; }
    // a goal that is not an amount has its own message (round 4); 0 or nothing clears it
    if (Number.isNaN(cents)) { toast(say('inlet.toast.badGoal', ctx.words)); return; }
    const goal = cents ? { per: v.per === 'year' ? 'year' : 'month', cents } : null;
    const focus = v.focus === 'on';
    const id = data && data.id ? data.id : null;
    const at = nowMs();
    if (!id) {
      if (!canMakeInlet(ctx.state)) { toast(say('inlets.toast.full', ctx.words, { n: INLETS_LIVE_MAX })); return; }
      const words = phrase('inlets.undo.add', ctx.words);
      let made = null;
      store.update((s) => {
        made = makeInlet(s, { name, kind }, at);
        if (made && (goal || focus)) editInlet(s, made, { ...(goal ? { goal } : {}), ...(focus ? { focus: true } : {}) }, at);
      }, { undo: words });
      if (!made) { if (store.undoLabel === words) store.undo(); return; }
      closeSheet();
      toast(say('inlet.toast.made', ctx.words, { name }), { action: phrase('flows.undo', ctx.words), onAction: undoLast });
      return;
    }
    const inlet = inletsOf(ctx.state).get(id);
    if (!inlet) { closeSheet(); return; }
    // only what changed is written: each field its own cell
    const fields = {};
    if (name !== inlet.name) fields.name = name;
    if (kind !== inlet.kind) fields.kind = kind;
    const had = inlet.goal ? inlet.goal.per + ':' + inlet.goal.cents : '';
    const want = goal ? goal.per + ':' + goal.cents : '';
    if (had !== want) fields.goal = goal;
    if (focus !== inlet.focus) fields.focus = focus;
    closeSheet();
    if (!Object.keys(fields).length) return;
    edit(id, fields, 'inlet.toast.saved');
  },
  'inlet.archive': ({ data }) => { if (data && data.id && edit(data.id, { gone: true }, 'inlet.toast.archived')) closeSheet(); },
  'inlet.restore': ({ data }) => { if (data && data.id && edit(data.id, { gone: false }, 'inlet.toast.restored')) closeSheet(); },
  'inlet.remove-ask': ({ data }) => { if (data && data.id) { store.setUi({ inletRemove: data.id }); focusIn('.inlet-confirm [data-action="inlet.remove-cancel"]'); } },
  'inlet.remove-cancel': () => { store.setUi({ inletRemove: null }); focusIn('[data-action="inlet.remove-ask"]'); },
  'inlet.remove': ({ data }) => {
    if (!data || !data.id) return;
    store.setUi({ inletRemove: null });
    if (edit(data.id, { removed: true }, 'inlet.toast.removed')) closeSheet();
  },
};
