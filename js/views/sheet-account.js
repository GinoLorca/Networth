/**
 * The account sheet — one account, or a new thing the bank cannot see.
 *
 *   params.id            an existing account: a bank account (corrections the feed never carries) or a
 *                        manual one (its figure, terms and record; remove)
 *   no id                something new: first a choice of what it is, then its form
 *   params.type          the type chosen (new) or being tried (existing) — the form follows the type, so a
 *                        change of the type select re-opens the sheet with it; nothing is saved until Save
 *
 * What the owner may set
 *   bank account    nickname · type (sets typeLocked) · everyday · reserve · hidden ·
 *                   card or loan: APR, limit, minimum payment, due day, and "reported as a positive number"
 *                   (flip + flipLocked; the stored balance is re-signed at once)
 *   manual account  type · name · the figure (owned or owed; a debt is stored negative) · from a statement or
 *                   an estimate · quick-sale share (slow assets) · loan terms (APR, monthly payment, due day,
 *                   assume it is paid on schedule) · a note. A new figure replaces the history entry of the
 *                   same day or adds one. Removing offers undo.
 *
 * Actions
 *   account.type     (change on the type select) re-open the sheet with that type, keeping what was typed
 *   account.touch    (input in the form) clear the messages of the last failed save
 *   account.save     (submit) validate, write the account, close, offer undo; runs detect.refresh when the type, the sign or
 *                    "leave it out" of a bank account changed, or a manual debt was added or edited (the Book
 *                    ties loan payments to the loan)
 *   account.remove   remove a manual account (and references to it), close, offer undo
 *
 * Cover mode: the form carries data-cover itself (the sheet host is outside the covered page), so the figure,
 * the record and every amount field that does not have the focus are redacted.
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { openSheet, closeSheet } from '../router.js';
import { fmt, fmtPlain, toCents } from '../model/money.js';
import { fmtDate, fmtTime, gameDay, diffDays, parts as ymdParts } from '../model/dates.js';
import { ACCOUNT_TYPES, accountLabel, makeAccount } from '../model/schema.js';
import { refresh } from '../model/detect.js';
import { icon } from '../ui/icons.js';
import { money, recentList } from './parts.js';

/** What can be added by hand, in the order offered. */
const KINDS = [
  { type: 'equipment', title: 'Equipment', note: 'Instruments, tools, a computer. Slow to sell; counted at your own estimate.' },
  { type: 'vehicle', title: 'A vehicle', note: 'A car, a van, a motorbike, at what it would sell for.' },
  { type: 'receivable', title: 'Something owed to you', note: 'A deposit due back, an invoice, money lent. Counted as money in days.' },
  { type: 'other_asset', title: 'Another asset', note: 'Anything else of value the bank feed does not carry.' },
  { type: 'loan', title: 'A loan', note: 'A student, car or equipment loan. With its terms, Networth works the balance down between statements.' },
  { type: 'other_debt', title: 'Another debt', note: 'Money owed to a person, a tax bill, a balance held elsewhere.' },
];

/** Types a manual account may take, and those a bank account may be corrected to. */
const MANUAL_TYPES = ['equipment', 'vehicle', 'receivable', 'investment', 'cash', 'other_asset', 'loan', 'other_debt'];
const BANK_TYPES = ['checking', 'savings', 'credit_card', 'investment', 'loan', 'other_asset', 'other_debt'];

const TITLES = {
  equipment: 'Equipment, at your own figure.',
  vehicle: 'A vehicle, at what it would sell for.',
  receivable: 'Something owed to you.',
  investment: 'An investment the feed does not carry.',
  cash: 'Cash in hand.',
  other_asset: 'Another asset.',
  loan: 'A loan, as it stands.',
  other_debt: 'Another debt.',
};

const MESSAGES = {
  value: 'Enter the figure in dollars, such as 1,200.',
  money: 'Enter dollars, such as 35.',
  apr: 'An APR is a number from 0 to 100, such as 24.99.',
  due: 'A due day is a day of the month, 1 to 31.',
  quick: 'A share is a number from 0 to 100, such as 50.',
};

const FIGURE_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/* ----------------------------------------------------------------- helpers */

function groupOf(type) {
  return ACCOUNT_TYPES[type].group;
}

function isDebtSide(type) {
  const group = groupOf(type);
  return group === 'card' || group === 'debt';
}

function isSlow(type) {
  return groupOf(type) === 'asset' && ACCOUNT_TYPES[type].tier === 'slow';
}

function findAccount(state, id) {
  return id ? state.accounts.find((a) => a.id === id) || null : null;
}

function isAmortised(account) {
  return account.source !== 'bank' && groupOf(account.type) === 'debt' && !!account.loan && account.loan.payment > 0
    && Number.isFinite(account.apr) && account.apr >= 0;
}

/** The type the form is showing: the one being tried when it is allowed, else the account's own. */
function shownType(account, params) {
  const allowed = account && account.source === 'bank' ? BANK_TYPES : MANUAL_TYPES;
  if (params && allowed.includes(params.type)) return params.type;
  return account ? account.type : null;
}

function errorKey(account, type) {
  return account ? account.id : 'new:' + type;
}

function errorsFor(ctx, key) {
  const held = ctx.ui.accountErrors;
  return held && held.key === key ? held.fields : {};
}

function ageText(ctx, at) {
  if (!at) return '';
  const age = diffDays(gameDay(at, ctx.state.settings.rolloverHour), ctx.today);
  if (age <= 0) return 'at ' + fmtTime(at);
  if (age === 1) return 'yesterday at ' + fmtTime(at);
  return age + ' days ago';
}

function shortDay(ctx, day) {
  if (!day) return '';
  return ymdParts(day).y === ymdParts(ctx.today).y ? fmtDate(day, 'short') : fmtDate(day, 'medium');
}

function latestEntry(account, today) {
  let latest = null;
  for (const entry of account.history || []) {
    if (entry && entry.day <= today && (latest === null || entry.day >= latest.day)) latest = entry;
  }
  return latest;
}

/** The sheet host sits outside the page element that carries data-cover, so a sheet with figures carries it itself. */
function coverAttr(ctx) {
  return attrs({ 'data-cover': !!ctx.state.settings.cover });
}

function plainAmount(cents) {
  return cents == null ? '' : fmtPlain(Math.abs(cents));
}

function plainNumber(n) {
  return n == null || !Number.isFinite(n) ? '' : String(Math.round(n * 100) / 100);
}

/* --------------------------------------------------------------- form parts */

/** A text field. opts: { value, placeholder, help, error, inputmode, maxlength, unit: '$'|'%', fig, cover, autofocus } */
function field(name, label, opts = {}) {
  const control = html`<input ${attrs({
    class: cx('input', (opts.fig || opts.unit) && 'input-fig'),
    type: 'text', name, value: opts.value || '', placeholder: opts.placeholder,
    inputmode: opts.inputmode, maxlength: opts.maxlength || 80, autocomplete: 'off',
    'aria-invalid': opts.error ? 'true' : null, 'data-fig': opts.cover ? '' : null, autofocus: !!opts.autofocus,
  })}>`;
  return html`<label class="${cx('field', opts.error && 'is-invalid')}">
    <span class="field-label lab">${label}</span>
    ${opts.unit === '$' ? html`<span class="acct-cash"><span aria-hidden="true">$</span>${control}</span>`
      : opts.unit ? html`<span class="acct-unit">${control}<span aria-hidden="true">${opts.unit}</span></span>`
        : control}
    ${opts.error ? html`<span class="field-error">${opts.error}</span>` : ''}
    ${opts.help ? html`<span class="field-help cap">${opts.help}</span>` : ''}
  </label>`;
}

function typeField(types, current, help) {
  return html`<label class="field">
    <span class="field-label lab">Kind</span>
    <span class="select"><select name="type" data-change="account.type">
      ${types.map((type) => html`<option value="${type}" ${attrs({ selected: type === current })}>${ACCOUNT_TYPES[type].label}</option>`)}
    </select></span>
    ${help ? html`<span class="field-help cap">${help}</span>` : ''}
  </label>`;
}

function option(name, label, checked, help) {
  return html`<div class="acct-opt">
    <label class="switch switch-block">
      <span class="switch-text">${label}</span>
      <input type="checkbox" role="switch" name="${name}" ${attrs({ checked: !!checked })}>
      <span class="switch-track" aria-hidden="true"></span>
    </label>
    <p class="cap">${help}</p>
  </div>`;
}

/* ----------------------------------------------------------------- chooser */

function chooser() {
  return html`<div class="sheet-body">
    <p class="sheet-head lab"><b>Material</b><i class="sep"></i>by hand</p>
    <h2 class="sheet-title">Add what the bank cannot see.</h2>
    <p class="cap">Six kinds. Each joins net worth at the figure you give, is marked as yours, and can be removed again.</p>
    <ul class="rows acct-kinds">
      ${KINDS.map((kind) => html`<li data-key="${kind.type}">
        <button class="row" type="button" data-action="app.sheet" data-sheet="account" data-type="${kind.type}">
          <span class="row-label">${kind.title} <em class="row-note">${kind.note}</em></span>
          <span class="row-action">${icon('chevron-right')}</span>
        </button>
      </li>`)}
    </ul>
    <div class="sheet-actions"><button class="btn" type="button" data-action="app.sheet-close">Not now</button></div>
  </div>`;
}

/* ------------------------------------------------------------ manual account */

function historyTable(ctx, account, owed) {
  const rows = (account.history || []).slice().sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  if (!rows.length) return '';
  return html`<div class="acct-set">
    <p class="lab"><b>The record</b><i class="sep"></i>${rows.length === 1 ? 'one figure' : (rows.length < FIGURE_WORDS.length ? FIGURE_WORDS[rows.length] : String(rows.length)) + ' figures'}</p>
    <table class="table table-s acct-history">
      <thead><tr><th scope="col">Entered</th><th scope="col" class="num">${owed ? 'Owed' : 'Worth'}</th><th scope="col">Note</th></tr></thead>
      <tbody>${rows.map((entry) => html`<tr data-key="${entry.day}">
        <th scope="row">${shortDay(ctx, entry.day)}</th>
        <td class="num">${fmt(owed ? -entry.balance : entry.balance)}</td>
        <td class="acct-history-note">${entry.note || ''}</td>
      </tr>`)}</tbody>
    </table>
  </div>`;
}

function manualForm(ctx, account, type) {
  const fresh = !account;
  const debt = groupOf(type) === 'debt';
  const errors = errorsFor(ctx, errorKey(account, type));
  const value = account ? ctx.d.valueOf(account) : null;
  const amortised = account ? isAmortised(account) : false;
  const estimate = account ? account.basis !== 'statement' || amortised : false;
  const latest = account ? latestEntry(account, ctx.today) : null;
  const basis = account ? (account.basis === 'statement' ? 'statement' : 'estimate') : debt ? 'statement' : 'estimate';
  const loan = account && account.loan ? account.loan : null;
  const quick = account ? account.quickSale : type === 'equipment' ? 0.5 : null;
  const typeLabel = ACCOUNT_TYPES[type].label;
  const valueLabel = debt ? 'What is owed' : 'What it is worth';
  const wasType = account && account.type !== type;

  const figure = fresh ? '' : html`<p class="acct-now">
    ${money(debt ? -value : value, { est: estimate })}
    <span class="cap">${debt ? 'owed' : 'counted'} today · ${amortised
      ? html`worked down by Networth from the <span data-fig>${fmt(Math.abs(latest ? latest.balance : account.balance))}</span> entered ${shortDay(ctx, latest ? latest.day : null)}`
      : (account.basis === 'statement' ? 'from a statement, ' : 'your estimate, ') + 'entered ' + shortDay(ctx, latest ? latest.day : gameDay(account.asOf, ctx.state.settings.rolloverHour))}</span>
  </p>`;

  const valueHelp = fresh
    ? (debt ? 'The balance on the latest statement. It is counted against net worth from today.' : 'It joins net worth at this figure from today, ' + fmtDate(ctx.today, 'short') + '.')
    : html`Leave it empty to keep the figure as it is. A new one is recorded for today, ${fmtDate(ctx.today, 'short')}; the record keeps the earlier ones.`;

  return html`<form class="sheet-body" data-submit="account.save" data-input="account.touch" data-id="${account ? account.id : ''}" novalidate autocomplete="off"${coverAttr(ctx)}>
    <p class="sheet-head lab"><b>${fresh ? 'New' : 'By hand'}</b><i class="sep"></i>${typeLabel}</p>
    <h2 class="sheet-title">${fresh ? TITLES[type] : accountLabel(account)}</h2>
    ${figure}

    <div class="acct-set acct-set-first">
      <div class="${cx('field', errors.value && 'is-invalid')}">
        <span class="field-label lab" id="acct-value-label">${fresh ? valueLabel : 'A new figure'}</span>
        <label class="money">
          <span class="vh">${fresh ? valueLabel : 'A new figure'}, in dollars</span>
          <span class="money-cur" aria-hidden="true">$</span>
          <input ${attrs({ class: 'money-input', type: 'text', inputmode: 'decimal', name: 'value', autocomplete: 'off',
            placeholder: '0.00', 'aria-invalid': errors.value ? 'true' : null, autofocus: fresh })}>
        </label>
        ${errors.value ? html`<span class="field-error">${errors.value}</span>` : ''}
        <span class="field-help cap">${valueHelp}</span>
      </div>
      <fieldset class="field">
        <legend class="field-label lab">Where the figure comes from</legend>
        <div class="seg acct-seg" role="radiogroup" aria-label="Where the figure comes from">
          <label class="seg-opt"><input type="radio" name="basis" value="statement" ${attrs({ checked: basis === 'statement' })}><span>A statement</span></label>
          <label class="seg-opt"><input type="radio" name="basis" value="estimate" ${attrs({ checked: basis === 'estimate' })}><span>My estimate</span></label>
        </div>
        <span class="field-help cap">A statement figure prints upright. An estimate prints in italic with the ≈ sign, and is never shown as the bank’s.</span>
      </fieldset>
      ${field('note', 'Note on the figure', { value: fresh || !latest ? '' : latest.note, placeholder: debt ? 'From the March statement' : 'What it would sell for', maxlength: 120,
        help: fresh || !latest || latest.day === ctx.today
          ? 'Optional. Kept beside the figure in the record.'
          : 'Optional. Kept beside the figure in the record. Left as it is, it stays with the ' + shortDay(ctx, latest.day) + ' figure and a new figure starts without one.' })}
    </div>

    <div class="acct-set">
      <p class="lab"><b>On the statement</b></p>
      ${field('name', 'Name', { value: account ? account.name : '', placeholder: typeLabel, maxlength: 60, help: 'Left empty, it is listed as ' + typeLabel + '.' })}
      ${typeField(MANUAL_TYPES, type, wasType
        ? 'Listed as ' + ACCOUNT_TYPES[account.type].label + ' until you save. ' + (groupOf(account.type) !== groupOf(type) ? 'The change moves it to the other side of the statement.' : 'The change moves it within the statement.')
        : 'Decides where it stands on Material: cash now, money in days, slow to sell, or owed.')}
      ${debt || type === 'investment' || type === 'receivable'
        ? field('institution', debt ? 'Lender' : type === 'receivable' ? 'Owed by' : 'Held at', { value: account ? account.institution : '', maxlength: 60, help: 'Optional. Printed under the name.' })
        : ''}
    </div>

    ${isSlow(type) ? html`<div class="acct-set">
      <p class="lab"><b>Sold fast</b></p>
      ${field('quick', 'Quick-sale share', { value: quick == null ? '' : plainNumber(quick * 100), unit: '%', inputmode: 'decimal', maxlength: 6, error: errors.quick,
        help: 'The share of the figure a sale within days would raise. It changes one line only: net worth “if everything slow had to be sold fast”. Empty counts it in full.' })}
    </div>` : ''}

    ${debt ? html`<div class="acct-set">
      <p class="lab"><b>Terms</b><i class="sep"></i>optional</p>
      <div class="acct-pair">
        ${field('apr', 'APR', { value: account ? plainNumber(account.apr) : '', unit: '%', inputmode: 'decimal', maxlength: 6, error: errors.apr })}
        ${field('payment', 'Monthly payment', { value: loan ? plainAmount(loan.payment) : '', unit: '$', inputmode: 'decimal', maxlength: 14, error: errors.payment, cover: true })}
      </div>
      ${field('due', 'Due day of the month', { value: account && account.dueDay ? String(account.dueDay) : '', inputmode: 'numeric', maxlength: 2, fig: true, placeholder: '1 to 31', error: errors.due })}
      <p class="cap">With an APR and a monthly payment, Networth works the balance down between statements: interest runs daily and each payment lowers what is owed. The figure then prints in italic, as an estimate.</p>
      ${option('assume', 'Assume it is paid on schedule', loan ? loan.assumeScheduled : true,
        'On: when the bank feed shows no payment, one is counted on each due day. Off: only payments seen in the feed lower the balance.')}
    </div>` : ''}

    ${fresh ? '' : historyTable(ctx, account, groupOf(account.type) === 'debt')}

    <div class="sheet-actions">
      ${fresh
        ? html`<button class="btn" type="button" data-action="app.sheet" data-sheet="account">Back</button>`
        : html`<button class="btn acct-remove" type="button" data-action="account.remove" data-id="${account.id}">Remove</button>`}
      <button class="btn btn-solid" type="submit">${fresh ? 'Add it' : 'Save'}</button>
    </div>
  </form>`;
}

/* -------------------------------------------------------------- bank account */

/** How many of this account's transactions the sheet lists; the rest are a tap away on the Scoresheet. */
const SHEET_MOVES = 6;

/**
 * This account's own transactions: how many are on the record and since when, the latest few, and
 * the way to all of them. An account the owner left out lists none (nothing of it is shown anywhere).
 */
function movesBlock(ctx, account) {
  if (account.hidden) return '';
  const r = ctx.d.latest(SHEET_MOVES, null, account.id);
  const count = r.total.toLocaleString('en-US') + (r.total === 1 ? ' transaction' : ' transactions');
  return html`<div class="acct-set acct-moves">
    <p class="lab"><b>Transactions</b><i class="sep"></i>${count} on the record${r.oldest ? ', from ' + shortDay(ctx, r.oldest) : ''}</p>
    ${r.rows.length
      ? html`${recentList(ctx, r.rows, { account: false, cls: 'acct-recent', label: 'The latest transactions on this account' })}
        <p class="acct-moves-all"><a class="btn-link" href="${'#/scoresheet?account=' + encodeURIComponent(account.id)}">All of them, by day</a></p>`
      : html`<p class="cap">The bank has sent a balance for this account and no transaction yet. Some banks pass a card’s transactions on a day or more after its balance; they appear here by themselves.</p>`}
  </div>`;
}

function bankForm(ctx, account, type) {
  const errors = errorsFor(ctx, errorKey(account, type));
  const group = groupOf(type);
  const debtSide = isDebtSide(type);
  const value = ctx.d.valueOf(account);
  const owedSide = isDebtSide(account.type);
  const standing = owedSide ? (value > 0 ? 'in credit' : 'owed') : value < 0 ? 'overdrawn' : 'held';
  const pending = value !== account.balance;
  const becameDebt = debtSide && !isDebtSide(account.type);
  const flip = becameDebt ? account.balance > 0 : account.flip;
  const wasType = account.type !== type;
  const label = accountLabel(account);

  return html`<form class="sheet-body" data-submit="account.save" data-input="account.touch" data-id="${account.id}" novalidate autocomplete="off"${coverAttr(ctx)}>
    <p class="sheet-head lab"><b>From the bank</b>${account.institution ? html`<i class="sep"></i>${account.institution}` : ''}</p>
    <h2 class="sheet-title">${label}</h2>
    <p class="acct-now">
      ${money(Math.abs(value))}
      <span class="cap"><i class="bank-mark"></i>${standing}${
        pending
          ? html`, pending moves counted · the bank reported <span data-fig>${fmt(Math.abs(account.balance))}</span> ${ageText(ctx, account.asOf)}`
          : ', as the bank reported it ' + ageText(ctx, account.asOf)}${
        account.hidden ? ' · left out of everything' : ''}</span>
    </p>
    ${movesBlock(ctx, account)}

    <div class="acct-set acct-set-first">
      ${field('nick', 'Your name for it', { value: account.nick, placeholder: account.name, maxlength: 60,
        help: html`Optional. The bank calls it “${account.name || ACCOUNT_TYPES[account.type].label}”; that name stays on file.` })}
      ${typeField(BANK_TYPES, type, wasType
        ? 'Read as ' + ACCOUNT_TYPES[account.type].label + ' until you save. Saving moves it on Material and is never guessed again.'
        : 'Read from the account’s name. Correcting it moves the account between cash, cards, assets and debts, and it is never guessed again.')}
    </div>

    <div class="acct-set">
      <p class="lab"><b>How it counts</b></p>
      <div class="acct-opts">
        ${group === 'cash' || group === 'card' ? option('everyday', 'Everyday spending', account.everyday,
          'The oldest report among everyday accounts decides when a round turns from pencil to ink.') : ''}
        ${group === 'cash' ? option('reserve', 'Counts toward the reserve', account.reserve,
          'Only flagged cash counts toward the reserve goal. With none flagged, all cash does.') : ''}
        ${option('hidden', 'Leave it out', account.hidden,
          'Dropped from net worth, cash, the rounds and the card cycle. The bank feed keeps it up to date in case it returns.')}
      </div>
    </div>

    ${debtSide ? html`<div class="acct-set">
      <p class="lab"><b>${group === 'card' ? 'The card' : 'The loan'}</b><i class="sep"></i>the feed never carries these</p>
      ${group === 'card' ? html`<div class="acct-pair">
        ${field('apr', 'APR', { value: plainNumber(account.apr), unit: '%', inputmode: 'decimal', maxlength: 6, error: errors.apr })}
        ${field('limit', 'Credit limit', { value: plainAmount(account.limit), unit: '$', inputmode: 'decimal', maxlength: 14, error: errors.limit, cover: true })}
      </div>
      <p class="cap">The APR gives interest per day on Material and the payoff scenario in Analysis. The limit gives utilization.</p>
      <div class="acct-pair">
        ${field('min', 'Minimum payment', { value: plainAmount(account.minPayment), unit: '$', inputmode: 'decimal', maxlength: 14, error: errors.min, cover: true })}
        ${field('due', 'Due day', { value: account.dueDay ? String(account.dueDay) : '', inputmode: 'numeric', maxlength: 2, fig: true, placeholder: '1 to 31', error: errors.due })}
      </div>
      <p class="cap">With both, the minimum is counted in what is due before payday whenever its day falls first.</p>`
        : html`<div class="acct-pair">
        ${field('apr', 'APR', { value: plainNumber(account.apr), unit: '%', inputmode: 'decimal', maxlength: 6, error: errors.apr })}
        ${field('due', 'Due day', { value: account.dueDay ? String(account.dueDay) : '', inputmode: 'numeric', maxlength: 2, fig: true, placeholder: '1 to 31', error: errors.due })}
      </div>
      <p class="cap">Kept on file beside the loan. The balance itself is the bank’s own figure, so nothing is worked out from these.</p>`}
      ${option('flip', 'The bank reports what I owe as a positive number', flip,
        'On when a debt shows up as money you have: the balance is read as owed, and that reading is kept through every sync.')}
    </div>` : ''}

    <div class="sheet-actions">
      <button class="btn" type="button" data-action="app.sheet-close">Close</button>
      <button class="btn btn-solid" type="submit">Save</button>
    </div>
  </form>`;
}

/* ------------------------------------------------------------------ render */

function gone() {
  return html`<div class="sheet-body">
    <p class="sheet-head lab"><b>Account</b></p>
    <h2 class="sheet-title">No longer on the record.</h2>
    <p class="cap">This account was removed, or the link is from another device. Material lists every account that is counted today.</p>
    <div class="sheet-actions"><button class="btn" type="button" data-action="app.sheet-close">Close</button></div>
  </div>`;
}

export function label(ctx, params) {
  const account = findAccount(ctx.state, params && params.id);
  if (account) return accountLabel(account);
  return params && params.id ? 'Account' : 'Add what the bank cannot see';
}

export function render(ctx, params = {}) {
  if (params.id) {
    const account = findAccount(ctx.state, params.id);
    if (!account) return gone();
    const type = shownType(account, params);
    return account.source === 'bank' ? bankForm(ctx, account, type) : manualForm(ctx, account, type);
  }
  const type = shownType(null, params);
  return type ? manualForm(ctx, null, type) : chooser();
}

/* ----------------------------------------------------------------- parsing */

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** '' -> null (not given); a valid amount -> cents >= 0; anything else -> undefined (invalid). */
/** The most a hand-entered amount may be: ten billion dollars, far inside what sums of cents hold exactly. */
const MAX_AMOUNT = 1000000000000;

/** A typed amount in cents; null when empty, undefined when it is not an amount from 0 to MAX_AMOUNT (a negative is refused, not flipped). */
function parseAmount(v) {
  const s = text(v);
  if (!s) return null;
  const cents = toCents(s);
  return cents == null || cents < 0 || cents > MAX_AMOUNT ? undefined : cents;
}

function parseNumber(v, max) {
  const s = text(v).replace(/%$/, '').trim();
  if (!s) return null;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 0 && n <= max ? n : undefined;
}

function parseDay(v) {
  const s = text(v);
  if (!s) return null;
  if (!/^\d{1,2}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 31 ? n : undefined;
}

/** Read the named fields with their parsers; collect a message for each that does not parse. */
function readFields(values, spec) {
  const out = {};
  const errors = {};
  for (const name in spec) {
    const [parse, message] = spec[name];
    const parsed = parse(values[name]);
    if (parsed === undefined) errors[name] = message;
    else out[name] = parsed;
  }
  return { out, errors };
}

function fail(key, fields) {
  store.setUi({ accountErrors: { key, fields } });
}

function clearErrors() {
  if (store.ui.accountErrors) store.setUi({ accountErrors: null });
}

/* ------------------------------------------------------------------ saving */

function upsertEntry(account, day, balance, note) {
  const entry = { day, balance, note };
  const at = account.history.findIndex((h) => h.day === day);
  if (at >= 0) account.history[at] = entry;
  else account.history.push(entry);
  account.history.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function saveManual(ctx, account, values) {
  const allowed = MANUAL_TYPES.includes(values.type) ? values.type : account ? account.type : null;
  if (!allowed) return;
  const type = allowed;
  const key = errorKey(account, type);
  const debt = groupOf(type) === 'debt';
  const { out, errors } = readFields(values, {
    value: [parseAmount, MESSAGES.value],
    quick: [(v) => parseNumber(v, 100), MESSAGES.quick],
    apr: [(v) => parseNumber(v, 100), MESSAGES.apr],
    payment: [parseAmount, MESSAGES.money],
    due: [parseDay, MESSAGES.due],
  });
  if (!account && out.value == null && !errors.value) errors.value = MESSAGES.value;
  if (Object.keys(errors).length) { fail(key, errors); return; }

  const sign = debt ? -1 : 1;
  const basis = values.basis === 'statement' ? 'statement' : 'estimate';
  const note = text(values.note).slice(0, 120);
  const name = text(values.name).slice(0, 60);
  const today = ctx.today;
  const now = ctx.now;
  const terms = {
    institution: text(values.institution).slice(0, 60),
    quickSale: isSlow(type) && out.quick != null ? out.quick / 100 : null,
    apr: debt ? out.apr : null,
    dueDay: debt ? out.due : null,
    loan: debt && out.payment ? { payment: out.payment, assumeScheduled: values.assume != null } : null,
  };

  if (!account) {
    const balance = sign * out.value;
    const created = makeAccount({
      source: 'manual', type, name, balance, asOf: now, basis,
      history: [{ day: today, balance, note }], ...terms,
    });
    const shown = accountLabel(created);
    const undoLabel = shown + ' added';
    store.update((s) => {
      s.accounts.push(created);
      if (debt) refresh(s, now); // a loan payment in the Book may now be tied to this loan
    }, { undo: undoLabel });
    clearErrors();
    closeSheet();
    toast(shown + ' added to Material.', { action: 'Undo', onAction: () => undoIf(undoLabel) });
    return;
  }

  const id = account.id;
  const wasDebt = groupOf(account.type) === 'debt';
  const undoLabel = accountLabel(account) + ' edited';
  store.update((s) => {
    const a = findAccount(s, id);
    if (!a) return;
    if (!Array.isArray(a.history)) a.history = [];
    if (groupOf(a.type) !== groupOf(type)) {
      for (const entry of a.history) entry.balance = sign * Math.abs(entry.balance);
      a.balance = sign * Math.abs(a.balance);
    }
    a.type = type;
    a.name = name;
    a.basis = basis;
    Object.assign(a, terms);
    if (out.value != null) {
      // a note left exactly as it stood belongs to the earlier figure: the new one starts without it
      const earlier = latestEntry(a, today);
      const carried = !!earlier && earlier.day !== today && (earlier.note || '') === note;
      upsertEntry(a, today, sign * out.value, carried ? '' : note);
      a.balance = sign * out.value;
      a.asOf = now;
    } else {
      const latest = latestEntry(a, today);
      if (latest) latest.note = note;
    }
    if (debt || wasDebt) refresh(s, now);
  }, { undo: undoLabel });
  clearErrors();
  closeSheet();
  toast(out.value != null ? 'Recorded: ' + accountLabel(account) + ', a new figure for ' + fmtDate(today, 'short') + '.' : 'Saved: ' + accountLabel(account) + ', the note for ' + fmtDate(today, 'short') + '.', { action: 'Undo', onAction: () => undoIf(undoLabel) });
}

function saveBank(ctx, account, values) {
  const type = BANK_TYPES.includes(values.type) ? values.type : account.type;
  const key = errorKey(account, type);
  const group = groupOf(type);
  const debtSide = isDebtSide(type);
  const { out, errors } = readFields(values, {
    apr: [(v) => parseNumber(v, 100), MESSAGES.apr],
    limit: [parseAmount, MESSAGES.money],
    min: [parseAmount, MESSAGES.money],
    due: [parseDay, MESSAGES.due],
  });
  if (Object.keys(errors).length) { fail(key, errors); return; }

  const id = account.id;
  const now = ctx.now;
  const undoLabel = accountLabel(account) + ' edited';
  const flip = debtSide && values.flip != null;
  store.update((s) => {
    const a = findAccount(s, id);
    if (!a) return;
    const typeChanged = a.type !== type;
    const hidden = values.hidden != null;
    const redetect = typeChanged || a.hidden !== hidden || a.flip !== flip;
    a.nick = text(values.nick).slice(0, 60);
    if (typeChanged) { a.type = type; a.typeLocked = true; }
    a.everyday = (group === 'cash' || group === 'card') && values.everyday != null;
    a.reserve = group === 'cash' && values.reserve != null;
    a.hidden = hidden;
    if (a.flip !== flip) {
      // the stored balance carries the old reading: re-sign it now; the next sync keeps the new one
      const mirrored = a.available != null && a.available === a.balance;
      a.balance = -a.balance;
      if (mirrored) a.available = a.balance;
      a.flip = flip;
      a.flipLocked = debtSide;
    }
    a.apr = debtSide ? out.apr : null;
    a.dueDay = debtSide ? out.due : null;
    a.limit = group === 'card' && out.limit ? out.limit : null;
    a.minPayment = group === 'card' && out.min ? out.min : null;
    if (redetect) refresh(s, now);
  }, { undo: undoLabel });
  clearErrors();
  closeSheet();
  toast('Saved: ' + accountLabel(account) + ', settings as of ' + fmtDate(ctx.today, 'short') + '.', { action: 'Undo', onAction: () => undoIf(undoLabel) });
}

function undoIf(label) {
  if (store.undoLabel !== label) { toast('Something else has changed since; nothing was undone.'); return; }
  store.undo();
  toast('Undone: ' + label + '.');
}

/* ----------------------------------------------------------------- actions */

export const actions = {
  'account.type': ({ el }) => {
    const ctx = context();
    const sheet = ctx && ctx.route.sheet;
    const params = sheet && sheet.name === 'account' ? sheet.params : {};
    clearErrors();
    openSheet('account', { ...params, type: el.value });
  },

  'account.touch': () => clearErrors(),

  'account.save': ({ values, data }) => {
    const ctx = context();
    if (!ctx || !values) return;
    // the id rides on the form's data-id: a control named "id" would shadow form.id, which morph() keys on
    const account = findAccount(ctx.state, data.id);
    if (data.id && !account) { closeSheet(); return; }
    if (account && account.source === 'bank') saveBank(ctx, account, values);
    else saveManual(ctx, account, values);
  },

  'account.remove': ({ data }) => {
    const ctx = context();
    const account = ctx ? findAccount(ctx.state, data.id) : null;
    if (!account || account.source === 'bank') return;
    const id = account.id;
    const undoLabel = accountLabel(account) + ' removed';
    const wasDebt = groupOf(account.type) === 'debt';
    const now = ctx.now;
    store.update((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== id);
      for (const entry of s.recurring) if (entry.toAccountId === id) entry.toAccountId = null;
      for (const tx of s.txs) if (tx.capital && tx.capital.accountId === id) tx.capital.accountId = null;
      if (wasDebt) refresh(s, now);
    }, { undo: undoLabel });
    clearErrors();
    closeSheet();
    toast(accountLabel(account) + ' removed from Material.', { action: 'Undo', onAction: () => undoIf(undoLabel) });
  },
};
