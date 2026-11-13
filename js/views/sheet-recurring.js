/**
 * The "Book entry" sheet: one recurring bill, opened from the Book (params.id), or empty to add a
 * line the feed has not shown yet (no id).
 *
 * Every field the owner changes is added to the entry's `locks`, so detection never overwrites it,
 * and detect.refresh runs in the same store.update. A new entry is made with
 * schema.makeRecurring({ source: 'manual', … }): its anchor is the last or next charge day and its
 * merchant key comes from classify.merchantOf, so the bank's own charges take it over when they arrive.
 *
 * A payment the owner sends themselves each month (an entry with `byHand`, or the sheet opened with
 * params.pay) has a short form of its own under the head "Payment you send": name, amount, day of the
 * month, and for an existing one "Switched on" and Remove. It saves through byhand.js (addByHand,
 * editByHand, removeByHand), with detect.refresh in the same store.update, and offers Undo.
 *
 * Actions: recurring.pay-save · recurring.pay-touch · recurring.pay-remove (the payment's form), and
 *          recurring.save (the form; a field that cannot be read is named under itself and focused),
 *          recurring.touch (typing clears a shown error),
 *          recurring.dismiss ("this is not a recurring bill": active false, locked, with undo),
 *          recurring.restore (an ended or dismissed line recurs again, with undo).
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { closeSheet } from '../router.js';
import { context, toast } from '../runtime.js';
import { fmt, toCents } from '../model/money.js';
import { addDays, addMonthsYm, fmtDate, fmtMonth, isYmd, monthOf, relDay } from '../model/dates.js';
import { ACCOUNT_TYPES, CADENCES, CATEGORIES, KLASSES, PURPOSES, accountLabel, makeRecurring } from '../model/schema.js';
import { annualCost, dailyCost, nextOccurrence } from '../model/book.js';
import { merchantOf } from '../model/classify.js';
import { refresh } from '../model/detect.js';
import { addByHand, byHandMonth, editByHand, removeByHand } from '../model/byhand.js';

const VERDICTS = [['', 'None'], ['keep', 'Keep'], ['review', 'Review'], ['cut', 'Cut']];
const KLASS_ORDER = ['book', 'need', 'want', 'oneoff', 'game'];
const NAME_MAX = 80;
const NOTE_MAX = 500;
/** The limits of a payment the owner sends, as byhand.js checks them. */
const PAY_NAME_MAX = 60;
const PAY_AMOUNT_MAX = 1e10;
/** An amount the owner sends: dollars, with thousands set off by commas or not, and at most two decimals ("$1,250.00", "85", "9.5"). */
const PAY_AMOUNT_TEXT = /^\$?(?:\d{1,3}(?:,\d{3})+|\d+|(?=\.\d))(?:\.\d{0,2})?$/;
const PAY_LAST_DAY = 31;
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
  if (rec ? rec.byHand : params && params.pay) return rec ? 'Payment you send: ' + (rec.name || 'unnamed payment') : 'New payment you send';
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

/* ------------------------------------------------- a payment the owner sends */

function ordinal(n) {
  const tens = n % 100;
  const unit = n % 10;
  return n + (tens >= 11 && tens <= 13 ? 'th' : unit === 1 ? 'st' : unit === 2 ? 'nd' : unit === 3 ? 'rd' : 'th');
}

/** The checklist's rows of one payment (derive: byHand), oldest first. */
function payRows(ctx, id) {
  const bh = ctx.d.byHand;
  return bh && Array.isArray(bh.rows) ? bh.rows.filter((row) => row.entry && row.entry.id === id) : [];
}

/**
 * The month a change of the amount or the day applies from: this month while its payment is not paid
 * (or the payment is switched off), the next once it is. The engine decides the same way (editByHand).
 */
function appliesFrom(ctx, rec) {
  const ym = monthOf(ctx.today);
  const row = payRows(ctx, rec.id).find((one) => monthOf(one.day) === ym);
  const open = !rec.active || (row && (row.status === 'due' || row.status === 'overdue'));
  return open ? ym : addMonthsYm(ym, 1);
}

function payStanding(ctx, rec) {
  const rows = payRows(ctx, rec.id);
  const ym = monthOf(ctx.today);
  const row = rows.find((one) => monthOf(one.day) === ym) || rows[rows.length - 1] || null;
  const short = (day) => (isYmd(day) ? fmtDate(day, 'short') : 'a day not on record');
  let standing = 'switched off: not on the list, not counted as due';
  if (rec.active) {
    const next = nextOccurrence(rec, addDays(ctx.today, -1));
    standing = !row ? (next ? 'first due ' + fmtDate(next, 'dowshort') : 'no day on its schedule yet')
      : row.status === 'bank' ? 'paid at the bank ' + short(row.paidDay)
        : row.status === 'pending' ? 'pending at the bank since ' + short(row.paidDay)
          : row.status === 'hand' ? 'ticked ' + short(row.paidDay)
            : row.status === 'overdue' ? 'overdue since ' + short(row.day)
              : 'due ' + fmtDate(row.day, 'dowshort') + ' · ' + relDay(row.day, ctx.today);
  }
  const { count, last } = chargesOf(ctx.state, rec.id);
  return html`<ul class="rows bks-facts">
    <li class="row"><span class="row-label">${fmtMonth(ym, 'name')}</span><span class="row-value" data-cover-keep>${standing}</span></li>
    <li class="row"><span class="row-label">Seen at the bank</span><span class="row-value" data-cover-keep>${count ? plural(count, 'payment') + ', the last on ' + fmtDate(last, 'medium') : 'none yet'}</span></li>
  </ul>`;
}

function renderPay(ctx, rec) {
  const isNew = !rec;
  const id = rec ? rec.id : '';
  const form = ctx.ui.payForm && ctx.ui.payForm.key === (id || 'new') ? ctx.ui.payForm : null;
  const errors = form ? form.errors : {};
  const day = rec && Number.isInteger(rec.dueDay) ? rec.dueDay : 1;
  const days = [];
  for (let n = 1; n < PAY_LAST_DAY; n++) days.push(n);
  return html`<form class="sheet-body bks-pay" data-submit="recurring.pay-save" data-input="recurring.pay-touch" data-id="${id}" novalidate ${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>Payment you send</b><i class="sep"></i>${isNew ? 'each month' : 'the ' + (day >= PAY_LAST_DAY ? 'last day' : ordinal(day)) + ' of each month'}</p>
    <h2 class="sheet-title">${isNew ? 'A payment to make each month.' : rec.name || 'Unnamed payment'}</h2>
    ${isNew
      ? html`<p class="cap">For a payment you send yourself by Zelle or bank transfer. It is on the Board’s list each month and is ticked when the bank shows it or you tick it; until then it is taken off what is liquid. 3 fields; the bank’s own row ticks it from then on.</p>`
      : payStanding(ctx, rec)}

    <label class="${cx('field', errors.name && 'is-invalid')}">
      <span class="field-label lab">Name</span>
      <input class="input" type="text" name="name" value="${rec ? rec.name : ''}" maxlength="${PAY_NAME_MAX}" autocomplete="off" ${attrs({ 'aria-invalid': errors.name ? 'true' : null, placeholder: isNew ? 'e.g. Flat share' : null })}>
      ${errors.name ? html`<span class="field-error">${errors.name}</span>` : ''}
    </label>

    <div class="field-row field-row-even">
      <label class="${cx('field', errors.amount && 'is-invalid')}">
        <span class="field-label lab">Amount, in dollars</span>
        <input class="input input-fig" type="text" inputmode="decimal" name="amount" data-fig value="${isNew ? '' : dollars(rec.amount)}" autocomplete="off" ${attrs({ 'aria-invalid': errors.amount ? 'true' : null, placeholder: isNew ? '0.00' : null })}>
        ${errors.amount ? html`<span class="field-error">${errors.amount}</span>` : ''}
      </label>
      <label class="${cx('field', errors.dueDay && 'is-invalid')}">
        <span class="field-label lab">Day of the month</span>
        <span class="select"><select name="dueDay" ${attrs({ 'aria-invalid': errors.dueDay ? 'true' : null })}>
          ${days.map((n) => html`<option value="${n}" ${attrs({ selected: n === day })}>${ordinal(n)}</option>`)}
          <option value="${PAY_LAST_DAY}" ${attrs({ selected: day >= PAY_LAST_DAY })}>Last day</option>
        </select></span>
        ${errors.dueDay ? html`<span class="field-error">${errors.dueDay}</span>` : ''}
      </label>
    </div>
    <p class="cap">${isNew
      ? html`The bank ticks it by the exact amount, so enter what you send to the cent. The 30th falls on the last day of a month that has no 30th.`
      : html`A change of the amount or the day applies from ${fmtMonth(appliesFrom(ctx, rec))}. The bank ticks it by the exact amount.`}</p>

    ${isNew ? '' : html`<label class="switch switch-block bks-switch">
      <span class="switch-text">Switched on <em>Off: it leaves the Board’s list and is not counted as due; its ${plural(Object.keys(rec.marks || {}).length, 'tick')} and its name are kept.</em></span>
      <input type="checkbox" role="switch" name="active" ${attrs({ checked: !!rec.active })}>
      <span class="switch-track" aria-hidden="true"></span>
    </label>`}

    <div class="sheet-actions">
      ${isNew ? '' : html`<button class="btn" type="button" data-action="recurring.pay-remove" data-id="${id}">Remove</button>`}
      <button class="btn btn-solid" type="submit">${isNew ? 'Add the payment' : 'Save'}</button>
    </div>
  </form>`;
}

/** Read the payment's form with the limits of byhand.js. Returns { fields } or { errors }. */
function readPay(values, rec) {
  const errors = {};
  const text = (key) => (typeof values[key] === 'string' ? values[key].trim() : '');
  const fields = {};

  const name = text('name');
  if (name && name.length <= PAY_NAME_MAX) fields.name = name;
  else errors.name = name ? 'A name is at most ' + PAY_NAME_MAX + ' characters.' : 'A payment needs a name of your own, 1 to ' + PAY_NAME_MAX + ' characters.';

  // dollars with at most two decimals, as typed: what the bank ticks is the exact amount, so nothing is rounded (E9 F2)
  const amount = PAY_AMOUNT_TEXT.test(text('amount')) ? toCents(text('amount')) : null;
  if (amount != null && Number.isInteger(amount) && amount >= 1 && amount <= PAY_AMOUNT_MAX) fields.amount = amount;
  else errors.amount = amount != null && amount > PAY_AMOUNT_MAX ? 'An amount is at most 100,000,000.00.' : 'An amount looks like 250.00.';

  const dueDay = Number(values.dueDay);
  if (Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= PAY_LAST_DAY) fields.dueDay = dueDay;
  else errors.dueDay = 'A day from the 1st to the 30th, or the last day.';

  if (rec) fields.active = values.active === 'on';
  return Object.keys(errors).length ? { errors } : { fields };
}

export function render(ctx, params) {
  const id = params && params.id ? params.id : '';
  const rec = findEntry(ctx.state, id);
  if (rec ? rec.byHand : params && params.pay) return renderPay(ctx, rec);
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
  /** The form of a payment the owner sends: a new one is added to the list, an existing one changed. */
  'recurring.pay-save': ({ el, values, data }) => {
    const ctx = context();
    const id = data.id || '';
    const rec = findEntry(ctx.state, id);
    if (id && (!rec || !rec.byHand)) { closeSheet(); return; }
    const read = readPay(values || {}, rec);
    if (read.errors) {
      store.setUi({ payForm: { key: id || 'new', errors: read.errors } });
      const first = ['name', 'amount', 'dueDay'].find((key) => read.errors[key]);
      const field = el && typeof el.querySelector === 'function' ? el.querySelector('[name="' + first + '"]') : null;
      if (field) field.focus();
      return;
    }
    const fields = read.fields;
    if (store.ui.payForm) store.setUi({ payForm: null });

    if (!rec) {
      const undoLabel = 'Payment added';
      let added = null;
      store.update((s) => {
        added = addByHand(s, fields, ctx.today, ctx.now);
        if (added) refresh(s, ctx.now);
      }, { undo: undoLabel });
      if (!added) { if (store.undoLabel === undoLabel) store.undo(); return; }
      const addedId = added.id;
      closeSheet();
      // the checklist as the engine has it now (the page's own context is drawn a moment later)
      const row = byHandMonth(store.state, ctx.today, ctx.now).rows.filter((one) => one.entry && one.entry.id === addedId).pop() || null;
      const words = !row ? '.'
        : row.status === 'bank' ? ': the bank shows it paid on ' + fmtDate(row.paidDay, 'short') + '.'
          : row.status === 'pending' ? ': pending at the bank since ' + fmtDate(row.paidDay, 'short') + '.'
            : row.status === 'overdue' ? ', due since ' + fmtDate(row.day, 'dowshort') + '.'
              : ', due ' + fmtDate(row.day, 'dowshort') + '.';
      offerUndo(fields.name + ' is on the list of payments to make' + words, undoLabel, fields.name + ' is taken off the list again.');
      return;
    }

    const changed = Object.keys(fields).filter((key) => (key === 'active' ? !!rec.active : rec[key]) !== fields[key]);
    if (!changed.length) { closeSheet(); return; }
    const terms = changed.includes('amount') || changed.includes('dueDay');
    const from = terms ? fmtMonth(appliesFrom(ctx, rec)) : '';
    const undoLabel = 'Payment changed';
    let done = false;
    store.update((s) => {
      done = editByHand(s, id, fields, ctx.today, ctx.now);
      if (done) refresh(s, ctx.now);
    }, { undo: undoLabel });
    closeSheet();
    if (!done) { if (store.undoLabel === undoLabel) store.undo(); return; }
    const off = changed.includes('active') && !fields.active;
    offerUndo(plural(changed.length, 'field') + ' saved on ' + fields.name + '.'
      + (off ? ' It is off the list of payments to make.' : terms ? ' The change applies from ' + from + '.' : ''),
    undoLabel, fields.name === rec.name ? rec.name + ' is as it was.' : 'The payment is as it was.');
  },

  /** Typing in the payment's form clears an error it was showing. */
  'recurring.pay-touch': () => {
    if (store.ui.payForm) store.setUi({ payForm: null });
  },

  /** Remove a payment the owner sends: off the list on every device, its bank rows ordinary again. */
  'recurring.pay-remove': ({ data }) => {
    const ctx = context();
    const rec = findEntry(ctx.state, data.id);
    if (!rec || !rec.byHand) { closeSheet(); return; }
    const undoLabel = 'Payment removed';
    const name = rec.name || 'The payment';
    const { count } = chargesOf(ctx.state, rec.id);
    let done = false;
    store.update((s) => {
      done = removeByHand(s, data.id, ctx.now);
      if (done) refresh(s, ctx.now);
    }, { undo: undoLabel });
    closeSheet();
    if (!done) { if (store.undoLabel === undoLabel) store.undo(); return; }
    offerUndo(name + ' is removed from the payments to make' + (count ? '; its ' + plural(count, 'bank row') + ' ' + (count === 1 ? 'is' : 'are') + ' ordinary again.' : '.'), undoLabel, name + ' is back on the list.');
  },

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
