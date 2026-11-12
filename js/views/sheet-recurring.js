/**
 * The "Book entry" sheet: one recurring bill, opened from the Book (params.id), or empty to add a
 * line the feed has not shown yet (no id).
 *
 * Every field the owner changes is added to the entry's `locks`, so detection never overwrites it,
 * and detect.refresh runs in the same store.update. A new entry is made with
 * schema.makeRecurring({ source: 'manual', … }): its anchor is the last or next charge day and its
 * merchant key comes from classify.merchantOf, so the bank's own charges take it over when they arrive.
 *
 * Actions: recurring.save (the form; a field that cannot be read is named under itself and focused),
 *          recurring.touch (typing clears a shown error),
 *          recurring.dismiss ("this is not a recurring bill": active false, locked, with undo),
 *          recurring.restore (an ended or dismissed line recurs again, with undo).
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { closeSheet } from '../router.js';
import { context, toast } from '../runtime.js';
import { fmt, toCents } from '../model/money.js';
import { addDays, fmtDate, isYmd, relDay } from '../model/dates.js';
import { ACCOUNT_TYPES, CADENCES, CATEGORIES, KLASSES, PURPOSES, accountLabel, makeRecurring } from '../model/schema.js';
import { annualCost, dailyCost, nextOccurrence } from '../model/book.js';
import { merchantOf } from '../model/classify.js';
import { refresh } from '../model/detect.js';

const VERDICTS = [['', 'None'], ['keep', 'Keep'], ['review', 'Review'], ['cut', 'Cut']];
const KLASS_ORDER = ['book', 'need', 'want', 'oneoff', 'game'];
const NAME_MAX = 80;
const NOTE_MAX = 500;
/** Fields the bank feed keeps up to date unless the owner has set them. */
const FED_FIELDS = { name: 'name', amount: 'amount', variable: 'whether it varies', cadence: 'cadence', anchor: 'last charge day', category: 'category', purpose: 'purpose', toAccountId: 'what it pays down' };

/* ------------------------------------------------------------------ helpers */

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many || one + 's');
}

function findEntry(state, id) {
  return id ? state.recurring.find((rec) => rec.id === id) || null : null;
}

function groupOf(account) {
  return ACCOUNT_TYPES[account.type] ? ACCOUNT_TYPES[account.type].group : null;
}

/** Accounts a bill can pay down: loans, other debts and cards. */
function debtAccounts(state) {
  return state.accounts.filter((a) => !a.hidden && (groupOf(a) === 'debt' || groupOf(a) === 'card'));
}

/** Accounts a bill can be charged to: cash accounts and cards. */
function payingAccounts(state) {
  return state.accounts.filter((a) => !a.hidden && (groupOf(a) === 'cash' || groupOf(a) === 'card'));
}

/** Charges of this entry the bank has reported: how many, and the day of the latest. */
function chargesOf(state, id) {
  let count = 0;
  let last = null;
  for (const tx of state.txs) {
    if (tx.recurringId !== id || tx.kind === 'decline' || tx.matchId) continue;
    count += 1;
    if (!last || tx.day > last) last = tx.day;
  }
  return { count, last };
}

function hasLock(rec, field) {
  return Array.isArray(rec.locks) && rec.locks.includes(field);
}

function addLock(rec, field) {
  if (!Array.isArray(rec.locks)) rec.locks = [];
  if (!rec.locks.includes(field)) rec.locks.push(field);
}

function dollars(cents) {
  return (Math.round(cents) / 100).toFixed(2);
}

/** A toast with Undo that only undoes the change it announces. */
function offerUndo(message, label, undone) {
  toast(message, {
    action: 'Undo',
    onAction: () => {
      if (store.undoLabel === label && store.undo()) toast(undone);
    },
  });
}

/* ------------------------------------------------------------------- render */

export const label = (ctx, params) => {
  const rec = findEntry(ctx.state, params && params.id);
  return rec ? 'Book entry: ' + (rec.name || 'unnamed line') : 'New Book entry';
};

function facts(ctx, rec) {
  const { count, last } = chargesOf(ctx.state, rec.id);
  let next = rec.active ? nextOccurrence(rec, addDays(ctx.today, -1)) : null;
  if (next && last && last >= next) next = nextOccurrence(rec, next);
  const account = rec.accountId ? ctx.d.account(rec.accountId) : null;
  return html`<ul class="rows bks-facts">
    ${rec.active
      ? html`<li class="row"><span class="row-label">Next expected</span><span class="row-value" data-cover-keep>${next ? fmtDate(next, 'dowshort') + ' · ' + relDay(next, ctx.today) : 'not known'}</span></li>
          <li class="row"><span class="row-label">Committed a year</span><span class="row-value fig est"><span class="approx">≈</span>${fmt(annualCost(rec))} <small>${fmt(Math.round(dailyCost(rec)))} a day</small></span></li>`
      : html`<li class="row"><span class="row-label">Standing</span><span class="row-value" data-cover-keep>${hasLock(rec, 'active') ? 'taken out of the Book by you' : 'ended: not charged for a period and a half'}</span></li>`}
    ${rec.active || count || !rec.anchor
      ? html`<li class="row"><span class="row-label">Charges seen</span><span class="row-value" data-cover-keep>${count ? count + ', the last on ' + fmtDate(last, 'medium') : 'none yet from the bank'}</span></li>`
      : html`<li class="row"><span class="row-label">Last charged</span><span class="row-value" data-cover-keep>${fmtDate(rec.anchor, 'medium')} · ${relDay(rec.anchor, ctx.today)}</span></li>`}
    ${rec.source === 'manual' ? '' : html`<li class="row"><span class="row-label">Charged to</span><span class="row-value" data-cover-keep>${account ? accountLabel(account) : 'not known'}</span></li>`}
  </ul>`;
}

function categoryOptions(selected) {
  return KLASS_ORDER.map((klass) => html`<optgroup label="${KLASSES[klass].label}">
    ${Object.keys(CATEGORIES).filter((key) => CATEGORIES[key].klass === klass).map((key) => html`<option value="${key}" ${attrs({ selected: key === selected })}>${CATEGORIES[key].label}</option>`)}
  </optgroup>`);
}

export function render(ctx, params) {
  const id = params && params.id ? params.id : '';
  const rec = findEntry(ctx.state, id);
  if (id && !rec) {
    return html`<div class="sheet-body">
      <p class="sheet-head lab"><b>Book entry</b></p>
      <h2 class="sheet-title">This line is no longer in the document.</h2>
      <p class="cap">It was removed since this sheet was opened. The Book lists the ${plural(ctx.state.recurring.length, 'line')} there are.</p>
      <div class="sheet-actions"><button class="btn" type="button" data-action="app.sheet-close">Close</button></div>
    </div>`;
  }
  const isNew = !rec;
  const v = rec || makeRecurring({ source: 'manual', anchor: ctx.today });
  const form = ctx.ui.recurringForm && ctx.ui.recurringForm.key === (id || 'new') ? ctx.ui.recurringForm : null;
  const errors = form ? form.errors : {};
  const purposes = ctx.state.settings.purposes || {};
  const debts = debtAccounts(ctx.state);
  const paying = payingAccounts(ctx.state);
  const manual = isNew || v.source === 'manual';
  const fed = isNew ? [] : Object.keys(FED_FIELDS).filter((field) => hasLock(v, field));
  const charges = isNew ? { count: 0, last: null } : chargesOf(ctx.state, v.id);

  return html`<form class="sheet-body" data-submit="recurring.save" data-input="recurring.touch" data-id="${id}" novalidate ${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>Book entry</b><i class="sep"></i>${isNew ? 'added by hand' : v.source === 'manual' ? 'entered by you' : 'found in the bank feed'}</p>
    <h2 class="sheet-title">${isNew ? 'A line for the Book.' : v.name || 'Unnamed line'}</h2>
    ${isNew
      ? html`<p class="cap">For a bill the feed has not shown yet. Give it a name as the bank will print it, an amount and one date; the bank’s own charges take the line over when they arrive.</p>`
      : facts(ctx, v)}

    <label class="${cx('field', errors.name && 'is-invalid')}">
      <span class="field-label lab">Name</span>
      <input class="input" type="text" name="name" value="${v.name}" maxlength="${NAME_MAX}" autocomplete="off" ${attrs({ 'aria-invalid': errors.name ? 'true' : null, placeholder: isNew ? 'e.g. Harbor Gym' : null })}>
      ${errors.name ? html`<span class="field-error">${errors.name}</span>` : ''}
    </label>

    <div class="bks-amount">
      <label class="${cx('field', errors.amount && 'is-invalid')}">
        <span class="field-label lab">Amount, in dollars</span>
        <input class="input input-fig" type="text" inputmode="decimal" name="amount" data-fig value="${isNew ? '' : dollars(v.amount)}" autocomplete="off" ${attrs({ 'aria-invalid': errors.amount ? 'true' : null, placeholder: isNew ? '0.00' : null })}>
        ${errors.amount ? html`<span class="field-error">${errors.amount}</span>` : ''}
      </label>
      <label class="check"><input type="checkbox" name="variable" ${attrs({ checked: !!v.variable })}><span class="check-box" aria-hidden="true"></span><span>The amount varies</span></label>
    </div>

    <div class="field-row field-row-even">
      <label class="field">
        <span class="field-label lab">Cadence</span>
        <span class="select"><select name="cadence">
          ${Object.keys(CADENCES).map((key) => html`<option value="${key}" ${attrs({ selected: key === v.cadence })}>${CADENCES[key].label}</option>`)}
        </select></span>
      </label>
      <label class="${cx('field', errors.anchor && 'is-invalid')}">
        <span class="field-label lab">${isNew ? 'Last charge, or the next if none yet' : 'Last charged on'}</span>
        <input class="input" type="date" name="anchor" value="${v.anchor || ''}" ${attrs({ 'aria-invalid': errors.anchor ? 'true' : null })}>
        ${errors.anchor ? html`<span class="field-error">${errors.anchor}</span>` : ''}
      </label>
    </div>
    <p class="cap">${isNew
      ? html`A day up to ${fmtDate(ctx.today, 'medium')} is the last charge, and the next date is counted from it on the cadence. A later day is the next charge itself: nothing is scheduled before it.`
      : 'The next date is counted from that day on the cadence.'} A varying amount is printed in italics with ≈.</p>

    <label class="field">
      <span class="field-label lab">Category</span>
      <span class="select"><select name="category">${categoryOptions(CATEGORIES[v.category] ? v.category : 'other')}</select></span>
    </label>

    <fieldset class="field">
      <legend class="field-label lab">Purpose</legend>
      <div class="chips">
        ${PURPOSES.map((key) => html`<label class="chip"><input type="radio" name="purpose" value="${key}" ${attrs({ checked: key === (PURPOSES.includes(v.purpose) ? v.purpose : 'personal') })}><span>${purposes[key] || key}</span></label>`)}
      </div>
    </fieldset>

    <label class="switch switch-block bks-switch">
      <span class="switch-text">Essential <em>Rent, a loan payment, insurance: an only move, marked □ in the Book.</em></span>
      <input type="checkbox" role="switch" name="essential" ${attrs({ checked: !!v.essential })}>
      <span class="switch-track" aria-hidden="true"></span>
    </label>

    <fieldset class="field">
      <legend class="field-label lab">Verdict</legend>
      <div class="seg seg-block" role="radiogroup" aria-label="Verdict">
        ${VERDICTS.map(([key, text]) => html`<label class="seg-opt"><input type="radio" name="verdict" value="${key}" ${attrs({ checked: key === (v.verdict || '') })}><span>${text}</span></label>`)}
      </div>
      <span class="field-help cap">A note to yourself. It changes no figure; review and cut are totalled at the top of the Book.</span>
    </fieldset>

    <label class="field">
      <span class="field-label lab">This pays down</span>
      <span class="select"><select name="toAccountId">
        <option value="" ${attrs({ selected: v.toAccountId == null })}>Nothing: it is a cost</option>
        ${debts.map((a) => html`<option value="${a.id}" ${attrs({ selected: a.id === v.toAccountId })}>${accountLabel(a)}</option>`)}
      </select></span>
      <span class="field-help cap">${debts.length
        ? 'A payment toward a debt leaves cash, so it stays in what is committed and in what is due before payday, but it is not a cost: it lowers what is owed.'
        : 'No loan or card is known yet. One added under Material can be chosen here; its payment then counts as committed, not as a cost.'}</span>
    </label>

    ${manual ? html`<label class="field">
      <span class="field-label lab">Charged to</span>
      <span class="select"><select name="accountId">
        <option value="" ${attrs({ selected: v.accountId == null })}>Not known yet</option>
        ${paying.map((a) => html`<option value="${a.id}" ${attrs({ selected: a.id === v.accountId })}>${accountLabel(a)}</option>`)}
      </select></span>
      <span class="field-help cap">A charge to a cash account, or to one not known, counts in what is due before payday.</span>
    </label>` : ''}

    <label class="field">
      <span class="field-label lab">Note</span>
      <textarea class="textarea" name="note" rows="2" maxlength="${NOTE_MAX}">${v.note || ''}</textarea>
    </label>

    ${fed.length ? html`<p class="cap">Set by you and no longer updated from the bank: ${fed.map((field) => FED_FIELDS[field]).join(', ')}. ${plural(Object.keys(FED_FIELDS).length - fed.length, 'other field')} still follow the feed.</p>` : ''}

    ${isNew ? '' : v.active
      ? html`<div class="bks-quiet">
          <button class="btn-link" type="button" data-action="recurring.dismiss" data-id="${v.id}">This is not a recurring bill</button>
          <p class="cap">Takes it out of the Book and keeps it out. ${charges.count ? html`Its ${plural(charges.count, 'charge')} ${charges.count === 1 ? 'goes' : 'go'} back to being ${charges.count === 1 ? 'an ordinary move' : 'ordinary moves'}.` : 'It has 0 charges from the bank to give back.'}</p>
        </div>`
      : html`<div class="bks-quiet">
          <button class="btn-link" type="button" data-action="recurring.restore" data-id="${v.id}">It recurs again</button>
          <p class="cap">Lists it in the Book again${v.anchor ? ', counted from its last charge on ' + fmtDate(v.anchor, 'medium') : ''}, and keeps it there until you take it out.</p>
        </div>`}

    <div class="sheet-actions">
      <button class="btn btn-solid" type="submit">${isNew ? 'Add to the Book' : 'Save'}</button>
    </div>
  </form>`;
}

/* ------------------------------------------------------------------ actions */

/** Read the form. Returns { fields } or { errors }. A blank optional field keeps the stored value. */
function readForm(values, rec, state) {
  const errors = {};
  const text = (key) => (typeof values[key] === 'string' ? values[key].trim() : '');
  const fields = {};

  const name = text('name').slice(0, NAME_MAX);
  if (name) fields.name = name;
  else if (rec) fields.name = rec.name;
  else errors.name = 'A new line needs a name, as the bank will print it.';

  const amountText = text('amount');
  const amount = toCents(amountText);
  if (amount != null && amount > 0) fields.amount = amount;
  else if (rec && !amountText) fields.amount = rec.amount;
  else errors.amount = 'An amount looks like 14.25.';

  fields.variable = values.variable === 'on';
  fields.cadence = Object.hasOwn(CADENCES, values.cadence) ? values.cadence : rec ? rec.cadence : 'monthly';

  const anchor = text('anchor');
  if (isYmd(anchor)) fields.anchor = anchor;
  else if (rec && !anchor) fields.anchor = rec.anchor;
  else errors.anchor = 'One date is needed: the last charge, or the next.';

  fields.category = Object.hasOwn(CATEGORIES, values.category) ? values.category : rec ? rec.category : 'subscriptions';
  fields.purpose = PURPOSES.includes(values.purpose) ? values.purpose : rec ? rec.purpose : 'personal';
  fields.essential = values.essential === 'on';
  fields.verdict = ['keep', 'review', 'cut'].includes(values.verdict) ? values.verdict : null;
  fields.toAccountId = debtAccounts(state).some((a) => a.id === values.toAccountId) ? values.toAccountId : null;
  if (!rec || rec.source === 'manual') {
    fields.accountId = payingAccounts(state).some((a) => a.id === values.accountId) ? values.accountId : null;
  }
  fields.note = text('note').slice(0, NOTE_MAX);

  return Object.keys(errors).length ? { errors } : { fields };
}

export const actions = {
  'recurring.save': ({ el, values, data }) => {
    const ctx = context();
    const id = data.id || '';
    const rec = findEntry(ctx.state, id);
    if (id && !rec) { closeSheet(); return; }
    const read = readForm(values || {}, rec, ctx.state);
    if (read.errors) {
      store.setUi({ recurringForm: { key: id || 'new', errors: read.errors } });
      // Bring the first field that needs attention into view; the messages are printed under each.
      const first = ['name', 'amount', 'anchor'].find((key) => read.errors[key]);
      const field = el && typeof el.querySelector === 'function' ? el.querySelector('[name="' + first + '"]') : null;
      if (field) field.focus();
      return;
    }
    const fields = read.fields;
    if (store.ui.recurringForm) store.setUi({ recurringForm: null });

    if (!rec) {
      const undoLabel = 'Line added to the Book';
      store.update((s) => {
        const locks = ['name', 'category', 'purpose'];
        if (fields.toAccountId) locks.push('toAccountId');
        // since: nothing is scheduled or accrued for a hand-added line before the day it was added
        s.recurring.push(makeRecurring({ ...fields, source: 'manual', since: ctx.today, mkey: merchantOf({ description: fields.name }).mkey, locks }));
        refresh(s, ctx.now);
      }, { undo: undoLabel });
      closeSheet();
      // a date after today is the next charge itself; otherwise the next one on the cadence from today on
      const next = fields.anchor > ctx.today ? fields.anchor : nextOccurrence({ ...fields, since: ctx.today }, addDays(ctx.today, -1));
      offerUndo(fields.name + ' is in the Book' + (next ? ', next expected ' + fmtDate(next, 'medium') + '.' : '.'), undoLabel, fields.name + ' is taken back out of the Book.');
      return;
    }

    const changed = Object.keys(fields).filter((key) => (rec[key] ?? null) !== (fields[key] ?? null));
    if (!changed.length) { closeSheet(); return; }
    const undoLabel = 'Book entry changed';
    store.update((s) => {
      const entry = findEntry(s, id);
      if (!entry) return;
      for (const key of changed) {
        entry[key] = fields[key];
        addLock(entry, key);
      }
      // A line entered by hand and not yet met in the feed is matched by its name: keep the key in step.
      if (changed.includes('name') && entry.source === 'manual' && !chargesOf(s, id).count) {
        entry.mkey = merchantOf({ description: entry.name }).mkey;
      }
      refresh(s, ctx.now);
    }, { undo: undoLabel });
    closeSheet();
    // Say what happened to the line, not only that it was saved: a change of cadence or date can end it.
    const after = findEntry(context().state, id);
    const ended = rec.active && after && !after.active;
    offerUndo(plural(changed.length, 'field') + ' saved on ' + fields.name + '.'
      + (ended ? ' The line is now listed as ended: on this cadence a charge was due after ' + (after.anchor ? fmtDate(after.anchor, 'medium') : 'its last date') + ' and none has posted.' : ''),
    undoLabel, 'The entry is as it was.');
  },

  /** Typing in the form clears an error it was showing. */
  'recurring.touch': () => {
    if (store.ui.recurringForm) store.setUi({ recurringForm: null });
  },

  /** "This is not a recurring bill": off, and locked so detection does not bring it back. */
  'recurring.dismiss': ({ data }) => {
    const ctx = context();
    const rec = findEntry(ctx.state, data.id);
    if (!rec) { closeSheet(); return; }
    const undoLabel = 'Taken out of the Book';
    const name = rec.name || 'The line';
    const { count } = chargesOf(ctx.state, rec.id);
    store.update((s) => {
      const entry = findEntry(s, data.id);
      if (!entry) return;
      entry.active = false;
      addLock(entry, 'active');
      refresh(s, ctx.now);
    }, { undo: undoLabel });
    closeSheet();
    offerUndo(name + ' is out of the Book' + (count ? '; ' + plural(count, 'charge') + ' ordinary again.' : '.'), undoLabel, name + ' is back in the Book.');
  },

  /** An ended or dismissed line recurs again: on, and locked so a lapse does not end it by itself. */
  'recurring.restore': ({ data }) => {
    const ctx = context();
    const rec = findEntry(ctx.state, data.id);
    if (!rec) { closeSheet(); return; }
    const undoLabel = 'Brought back into the Book';
    const name = rec.name || 'The line';
    store.update((s) => {
      const entry = findEntry(s, data.id);
      if (!entry) return;
      entry.active = true;
      addLock(entry, 'active');
      refresh(s, ctx.now);
    }, { undo: undoLabel });
    closeSheet();
    offerUndo(name + ' is back in the Book' + (rec.anchor ? ', last charged ' + fmtDate(rec.anchor, 'short') + '.' : '.'), undoLabel, name + ' is out of the Book again.');
  },
};
