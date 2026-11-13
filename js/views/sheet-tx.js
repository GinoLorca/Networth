/**
 * The tx sheet: one move — what the bank said, and the few things the owner may say about it.
 * Opened with app.sheet (data-sheet="tx" data-id="<transaction id>").
 *
 * Read-only: merchant, amount, day, account, posted or pending, the bank's own description.
 * Editable (one form, saved together with one undo step):
 *   category · class · purpose, for "all from this merchant" (classify.learnRule) or "this move only";
 *   "it was planned"; the annotation override; a note; and for a business purchase (purpose not
 *   personal, class one-off) the return check and "it is equipment".
 * A tapped-in move or a declined purchase can be removed (with undo). Bank rows cannot.
 *
 * Cover mode: the sheet body carries data-cover itself (the sheet host is outside the covered page).
 *
 * A bank row that pays a payment the owner sends (a Book entry with `byHand`) says so under its account,
 * and can be taken off that payment ("Not this payment": byhand.skipRow, then detect.refresh, with undo).
 *
 * Actions: tx.save (submit) · tx.category (the class follows a new category) · tx.remove · tx.pay-skip
 * The business block is shown by the stylesheet from the form's own state (css/views/scoresheet.css, .tx-biz).
 */

import { html, cx, attrs } from '../ui/dom.js';
import { fmt, fmtPlain, toCents } from '../model/money.js';
import { fmtDate, fmtTime, isYmd } from '../model/dates.js';
import { CATEGORIES, KLASSES, PURPOSES, GLYPHS, ACCOUNT_TYPES, accountLabel, categoryLabel, klassOf, makeAccount } from '../model/schema.js';
import { learnRule, confirmMove } from '../model/classify.js';
import { refresh } from '../model/detect.js';
import { removeManual } from '../model/merge.js';
import { skipRow } from '../model/byhand.js';
import { moveGlyph } from '../ui/glyphs.js';
import { store } from '../store.js';
import { closeSheet } from '../router.js';
import { context, toast } from '../runtime.js';

const KLASS_ORDER = ['game', 'need', 'want', 'oneoff', 'book'];
const GLYPH_ORDER = ['!!', '!', '!?', '?!', '?', '??', '□'];
const OUTCOMES = [['yes', 'Yes'], ['notyet', 'Not yet'], ['no', 'No']];
const KIND_WORDS = { spend: 'Move', income: 'Income', refund: 'Refund', transfer: 'Transfer', payment: 'Payment', decline: 'Declined purchase' };
const NOTE_MAX = 280;
const VIA_MAX = 120;
const NEW_ACCOUNT = 'new';
const MONEY = /[+−-]?\$\d[\d,]*(?:\.\d+)?/g;

/* ----------------------------------------------------------------- helpers */

/** A sentence from the engine with every amount wrapped so that cover mode redacts it. */
function figured(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let last = 0;
  for (const m of s.matchAll(MONEY)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(html`<span data-fig>${m[0]}</span>`);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function findTx(state, id) {
  return typeof id === 'string' && id ? state.txs.find((t) => t && t.id === id) || null : null;
}

function nameOf(tx) {
  return tx.merchant || categoryLabel(tx.category);
}

function isSpendish(tx) {
  return tx.kind === 'spend' || tx.kind === 'refund';
}

/** A paired leg or a stream deposit: its kind is settled by the other leg or the stream, so its category is not offered. */
function isFrozen(tx) {
  return !!tx.pairId || !!tx.streamId;
}

/** Manual asset accounts a capitalised purchase can be counted in. */
function equipmentAccounts(state) {
  return state.accounts.filter((a) => a.source === 'manual' && !a.hidden && ACCOUNT_TYPES[a.type] && ACCOUNT_TYPES[a.type].group === 'asset' && ACCOUNT_TYPES[a.type].tier === 'slow');
}

/** The sheet host sits outside the page element that carries data-cover, so the sheet body carries it itself. */
function coverAttr(ctx) {
  return attrs({ 'data-cover': !!ctx.state.settings.cover });
}

function undoLast() {
  const label = store.undo();
  if (label) toast('Undone: ' + String(label).replace(/[.]+$/, '') + '.');
}

export function label(ctx, params) {
  const tx = findTx(ctx.state, params && params.id);
  return tx ? 'Move: ' + nameOf(tx) : 'Move';
}

/* ------------------------------------------------------------------ render */

export function render(ctx, params) {
  const tx = findTx(ctx.state, params && params.id);
  if (!tx) {
    return html`<div class="sheet-body">
      <p class="sheet-head lab"><b>Move</b></p>
      <h2 class="sheet-title">This move is no longer on the sheet.</h2>
      <p class="cap">A pending row can leave the bank feed before it posts, and a tapped-in move is replaced by the bank’s own row within 7 days.</p>
      <div class="sheet-actions"><button class="btn" type="button" data-action="app.sheet-close">Close</button></div>
    </div>`;
  }
  const round = ctx.d.round(tx.day);
  const prematch = round.status === 'prematch';
  // before the match began the marks of the daily game are not printed (as on the Scoresheet); the rest are
  const found = ctx.d.annotations(tx.day).moves.get(tx.id) || null;
  const ann = found && prematch && tx.klass === 'game' && !found.manual ? null : found;
  const manual = tx.source === 'manual';
  const head = html`<p class="sheet-head lab"><b>${KIND_WORDS[tx.kind] || 'Move'}</b><i class="sep"></i>${prematch ? '' : html`Round ${round.n}<i class="sep"></i>`}${fmtDate(tx.day, 'dowshort')}</p>
    <h2 class="sheet-title">${nameOf(tx)}</h2>`;

  if (manual && tx.matchId) {
    const bank = findTx(ctx.state, tx.matchId);
    return html`<div class="sheet-body" data-key="${'tx-' + tx.id}" ${coverAttr(ctx)}>
      ${head}
      ${facts(ctx, tx)}
      <p class="cap">The bank has reported this move; its own row replaced the one tapped in, which no longer counts.</p>
      <div class="sheet-actions">
        ${bank ? html`<button class="btn" type="button" data-action="app.sheet" data-sheet="tx" data-id="${bank.id}">The bank’s row</button>` : ''}
        <button class="btn btn-solid" type="button" data-action="app.sheet-close">Close</button>
      </div>
    </div>`;
  }

  return html`<form class="sheet-body tx-form" data-key="${'tx-' + tx.id}" data-submit="tx.save" data-id="${tx.id}" novalidate ${coverAttr(ctx)}>
    ${head}
    ${facts(ctx, tx)}
    ${ann ? html`<p class="tx-ann"><span class="tx-ann-sym">${moveGlyph(ann.glyph)}</span><span class="cap">${figured(ann.why)}.${ann.manual ? ' Your own mark.' : ''}</span></p>` : ''}
    ${classification(ctx, tx)}
    ${isSpendish(tx) && CATEGORIES[tx.category] && CATEGORIES[tx.category].stop ? html`<div class="tx-check">
      <label class="check"><input type="checkbox" name="planned" ${tx.planned ? html`checked` : ''}><span class="check-box" aria-hidden="true"></span><span>It was planned</span></label>
      <p class="cap">A stop in the morning plan is a book move: it prints bare, whichever stop of the day it was.</p>
    </div>` : ''}
    ${tx.kind !== 'transfer' ? glyphField(tx) : ''}
    ${tx.kind === 'spend' ? business(ctx, tx) : ''}
    <label class="field">
      <span class="field-label lab">Note</span>
      <textarea class="textarea tx-note" name="note" rows="2" maxlength="${NOTE_MAX}" placeholder="Printed under the move">${tx.note || ''}</textarea>
    </label>
    <div class="sheet-actions">
      ${manual ? html`<button class="btn" type="button" data-action="tx.remove" data-id="${tx.id}">Remove</button>` : ''}
      <button class="btn btn-solid" type="submit">Save</button>
    </div>
  </form>`;
}

/* ------------------------------------------------------------ what is known */

function statusNote(tx) {
  if (tx.kind === 'decline') return 'not paid: a declined purchase moves no money';
  if (tx.source === 'manual') return 'tapped in' + (tx.loggedAt ? ' at ' + fmtTime(tx.loggedAt) : '') + '; the bank has not reported it yet';
  if (tx.pending) return 'pending at the bank: the amount can still change';
  return tx.postedDay ? 'posted ' + fmtDate(tx.postedDay, 'dowshort') : 'posted';
}

/** The payment the owner sends that this bank row pays, or null. */
function paysOf(state, tx) {
  if (!tx || !tx.recurringId || !Array.isArray(state.recurring)) return null;
  return state.recurring.find((rec) => rec && rec.id === tx.recurringId && rec.byHand === true) || null;
}

function facts(ctx, tx) {
  const account = tx.accountId ? ctx.d.account(tx.accountId) : null;
  const pays = paysOf(ctx.state, tx);
  const pencil = tx.pending || tx.source === 'manual';
  const sign = tx.kind === 'income' || tx.kind === 'refund' ? '+' : '';
  const amount = tx.kind === 'decline'
    ? html`<span class="row-value fig tx-declined">${fmt(tx.amount)}</span>`
    : html`<span class="${cx('row-value fig', pencil && 'est')}">${tx.source === 'manual' ? html`<span class="approx">≈</span>` : ''}${sign}${fmt(tx.amount)}</span>`;
  return html`<ul class="rows tx-facts">
    <li class="row" data-key="amount">
      <span class="row-label">${tx.kind === 'decline' ? 'Price' : 'Amount'} <em class="row-note">${statusNote(tx)}</em></span>
      ${amount}
    </li>
    <li class="row" data-key="day">
      <span class="row-label">Day</span>
      <span class="tx-v">${fmtDate(tx.day, 'long')}</span>
    </li>
    ${account ? html`<li class="row" data-key="account">
      <span class="row-label">Account</span>
      <span class="tx-v">${accountLabel(account)}${account.institution ? html` <em class="row-note">${account.institution}</em>` : ''}</span>
    </li>` : ''}
    ${pays ? html`<li class="row tx-pays" data-key="pays">
      <span class="row-label">Pays ${pays.name || 'an unnamed payment'}, a payment you send</span>
      <button class="btn-link" type="button" data-action="tx.pay-skip" data-id="${tx.id}">Not this payment</button>
    </li>` : ''}
    ${tx.raw ? html`<li class="tx-raw" data-key="raw">
      <span class="lab">As the bank wrote it</span>
      <span class="tx-raw-text mono">${tx.raw}</span>
    </li>` : ''}
  </ul>`;
}

/* ---------------------------------------------------------- classification */

function categoryOptions(tx) {
  const option = (key, text) => html`<option value="${key}" ${tx.category === key ? html`selected` : ''}>${text}</option>`;
  const byKlass = (klass) => Object.keys(CATEGORIES).filter((key) => CATEGORIES[key].klass === klass).map((key) => option(key, CATEGORIES[key].label));
  if (tx.kind === 'decline') {
    return KLASS_ORDER.filter((k) => k !== 'book').map((k) => html`<optgroup label="${KLASSES[k].label}">${byKlass(k)}</optgroup>`);
  }
  if (tx.flow === 'in') {
    return html`<optgroup label="Money in">${option('income', 'Income')}</optgroup>
      <optgroup label="Not income">${option('transfer', 'Transfer between my accounts')}${option('card_payment', 'Card or loan payment')}</optgroup>
      <optgroup label="A refund of">${Object.keys(CATEGORIES).map((key) => option(key, CATEGORIES[key].label))}</optgroup>`;
  }
  return html`${KLASS_ORDER.map((k) => html`<optgroup label="${KLASSES[k].label}">${byKlass(k)}</optgroup>`)}
    <optgroup label="Not spending">${option('transfer', 'Transfer between my accounts')}${option('card_payment', 'Card or loan payment')}</optgroup>`;
}

function classification(ctx, tx) {
  const purposes = ctx.state.settings.purposes || {};
  const frozen = isFrozen(tx);
  const decline = tx.kind === 'decline';
  const sameMerchant = tx.mkey ? ctx.state.txs.filter((t) => t.mkey === tx.mkey && !t.matchId).length : 1;
  // a paired leg is a movement between the owner's own accounts: it has no purpose to set and nothing to learn
  const moved = !!tx.pairId || tx.kind === 'transfer' || tx.kind === 'payment';
  const canLearn = !!tx.mkey && !decline && !(moved && frozen);
  const stream = tx.streamId ? ctx.state.streams.find((s) => s.id === tx.streamId) : null;

  return html`<fieldset class="tx-class">
    <legend class="vh">How this move is read</legend>
    ${frozen ? html`<p class="cap tx-frozen">${tx.pairId
      ? 'One leg of a movement between your own accounts, paired with the other: never spending, never income.'
      : 'A deposit of ' + (stream ? stream.name : 'a known income stream') + ', counted as income. The stream itself is edited in the Book.'}</p>`
      : html`<label class="field">
          <span class="field-label lab">Category</span>
          <span class="select"><select name="category" data-change="tx.category">${categoryOptions(tx)}</select></span>
        </label>`}
    ${isSpendish(tx) ? html`<fieldset class="field">
      <legend class="field-label lab">Class</legend>
      <div class="chips" role="radiogroup" aria-label="Class">
        ${KLASS_ORDER.map((k) => html`<label class="chip"><input type="radio" name="klass" value="${k}" ${tx.klass === k ? html`checked` : ''}><span>${KLASSES[k].label}</span></label>`)}
      </div>
      <p class="field-help cap">Only Convenience is played against Habit in the daily round.</p>
    </fieldset>` : ''}
    ${moved && frozen ? '' : html`<fieldset class="field">
      <legend class="field-label lab">Purpose</legend>
      <div class="chips" role="radiogroup" aria-label="Purpose">
        ${PURPOSES.filter((p) => purposes[p] || p === tx.purpose).map((p) => html`<label class="chip"><input type="radio" name="purpose" value="${p}" ${tx.purpose === p ? html`checked` : ''}><span>${purposes[p] || p}</span></label>`)}
      </div>
    </fieldset>`}
    ${canLearn ? html`<fieldset class="field">
      <legend class="field-label lab">A correction applies to</legend>
      <div class="seg seg-block" role="radiogroup" aria-label="A correction applies to">
        <label class="seg-opt"><input type="radio" name="scope" value="all" checked><span>All from this merchant</span></label>
        <label class="seg-opt"><input type="radio" name="scope" value="one"><span>This move only</span></label>
      </div>
      <p class="field-help cap">${sameMerchant > 1
        ? html`All: the <i data-cover-keep>${sameMerchant}</i> moves from ${nameOf(tx)} on record, and every later one, follow. A move corrected on its own keeps its correction.`
        : html`All: later moves from ${nameOf(tx)} follow. This is the only one on record so far.`}</p>
    </fieldset>` : ''}
  </fieldset>`;
}

function glyphField(tx) {
  const own = tx.glyph && GLYPHS[tx.glyph] ? tx.glyph : '';
  return html`<fieldset class="field">
    <legend class="field-label lab">Annotation</legend>
    <div class="chips tx-glyphs" role="radiogroup" aria-label="Annotation">
      <label class="chip"><input type="radio" name="glyph" value="" ${own ? '' : html`checked`}><span>The annotator’s</span></label>
      ${GLYPH_ORDER.map((g) => html`<label class="chip tx-glyph"><input type="radio" name="glyph" value="${g}" ${own === g ? html`checked` : ''}><span>${moveGlyph(g)}</span></label>`)}
    </div>
    <p class="field-help cap">A mark of your own replaces the annotator’s on this move. Most moves carry none.</p>
  </fieldset>`;
}

/* ------------------------------------------------------- business purchase */

function business(ctx, tx) {
  const pb = tx.payback || { by: '', via: '', outcome: null };
  const due = !!tx.payback && isYmd(pb.by) && pb.by <= ctx.today;
  const accounts = equipmentAccounts(ctx.state);
  const cap = tx.capital && tx.capital.value > 0 ? tx.capital : null;
  const half = Math.round(tx.amount / 2);
  const error = ctx.ui.txError && ctx.ui.txError.id === tx.id ? ctx.ui.txError.text : '';
  const chosen = cap && cap.accountId && accounts.some((a) => a.id === cap.accountId) ? cap.accountId : accounts.length ? accounts[0].id : NEW_ACCOUNT;
  return html`<div class="tx-biz" role="group" aria-label="Business purchase: the return check">
    <p class="lab"><b>Business purchase</b><i class="sep"></i>the return check</p>
    <p class="cap">A purchase for work is judged by its return: it prints <b class="sym">!?</b> until the check below is answered.</p>
    <div class="field-row field-row-even">
      <label class="field">
        <span class="field-label lab">Pays for itself by</span>
        <input class="input" type="date" name="payback_by" value="${isYmd(pb.by) ? pb.by : ''}" min="${tx.day}">
      </label>
      <label class="field">
        <span class="field-label lab">Through</span>
        <input class="input" type="text" name="payback_via" value="${pb.via || ''}" maxlength="${VIA_MAX}" placeholder="two sessions a month" autocomplete="off">
      </label>
    </div>
    ${due ? html`<fieldset class="field">
      <legend class="field-label lab">Did it pay back? <span class="tx-due">due ${fmtDate(pb.by, 'short')}</span></legend>
      <div class="seg seg-block" role="radiogroup" aria-label="Did it pay back?">
        ${OUTCOMES.map(([key, text]) => html`<label class="seg-opt"><input type="radio" name="payback_outcome" value="${key}" ${pb.outcome === key ? html`checked` : ''}><span>${text}</span></label>`)}
      </div>
      <p class="field-help cap">Yes prints <b class="sym">!</b>, No prints <b class="sym">?</b>; Not yet leaves it open.</p>
    </fieldset>` : ''}
    <div class="tx-equip">
      <label class="check"><input type="checkbox" name="equip" ${cap ? html`checked` : ''}><span class="check-box" aria-hidden="true"></span><span>It is equipment</span></label>
      <div class="tx-equip-more">
        <div class="field-row field-row-even">
          <label class="${cx('field', error && 'is-invalid')}">
            <span class="field-label lab">Counted as an asset</span>
            <input class="input input-fig" type="text" inputmode="decimal" name="equip_value" value="${fmtPlain(cap ? cap.value : half)}" autocomplete="off" data-fig${attrs({ 'aria-invalid': error ? 'true' : null })}>
            ${error ? html`<span class="field-error">${error}</span>` : ''}
          </label>
          <label class="field">
            <span class="field-label lab">Held in</span>
            <span class="select"><select name="equip_account">
              ${accounts.map((a) => html`<option value="${a.id}" ${chosen === a.id ? html`selected` : ''}>${accountLabel(a)}</option>`)}
              <option value="${NEW_ACCOUNT}" ${chosen === NEW_ACCOUNT ? html`selected` : ''}>A new equipment entry</option>
            </select></span>
          </label>
        </div>
        <p class="field-help cap">That part of the <span data-fig>${fmt(tx.amount)}</span> becomes an asset on Material from ${fmtDate(tx.day, 'short')}; the rest is spending. Half the price is the starting estimate.</p>
      </div>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- actions */

function sameJson(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

const COUNTED = 'Counted from ';

function byDay(a, b) {
  return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
}

/**
 * Take back what counting a purchase as equipment put on Material: an account this sheet made for it
 * is removed when nothing else uses it; an account that existed loses the value it gained.
 */
function releaseCapital(s, row) {
  const cap = row.capital;
  row.capital = null;
  if (!cap || !cap.accountId) return;
  const at = s.accounts.findIndex((a) => a.id === cap.accountId);
  if (at < 0) return;
  const account = s.accounts[at];
  const history = Array.isArray(account.history) ? account.history : [];
  if (Number.isFinite(cap.added) && cap.added > 0) {
    for (const entry of history) if (entry && entry.day >= row.day && Number.isFinite(entry.balance)) entry.balance -= cap.added;
    if (cap.entry) {
      const i = history.findIndex((entry) => entry && entry.day === row.day && String(entry.note || '').startsWith(COUNTED));
      if (i >= 0) history.splice(i, 1);
    }
    account.balance -= cap.added;
    return;
  }
  // an account made by this sheet: one entry, on the day of the purchase, at the counted value
  const own = account.source === 'manual' && (cap.created === true || (account.type === 'equipment' && history.length === 1
    && history[0].day === row.day && history[0].balance === cap.value && String(history[0].note || '').startsWith(COUNTED)));
  const shared = s.txs.some((t) => t && t !== row && t.capital && t.capital.accountId === account.id);
  if (own && !shared) s.accounts.splice(at, 1);
}

/**
 * Count the value into an account that already exists: an entry on the day of the purchase, and
 * every later figure of the owner's (and the present one) raised by the same amount.
 */
function countInto(row, account) {
  const value = row.capital.value;
  if (!Array.isArray(account.history)) account.history = [];
  const history = account.history;
  history.sort(byDay);
  const hasDay = history.some((entry) => entry.day === row.day);
  let base = Number.isFinite(account.balance) ? account.balance : 0;
  if (history.length) {
    base = history[0].balance;
    for (const entry of history) if (entry.day <= row.day) base = entry.balance;
  }
  for (const entry of history) if (entry.day >= row.day && Number.isFinite(entry.balance)) entry.balance += value;
  if (!hasDay) {
    history.push({ day: row.day, balance: base + value, note: COUNTED + nameOf(row) });
    history.sort(byDay);
  }
  account.balance = (Number.isFinite(account.balance) ? account.balance : 0) + value;
  row.capital.added = value;
  row.capital.entry = !hasDay;
}

function save({ values, data }) {
  const ctx = context();
  const tx = ctx ? findTx(ctx.state, data.id) : null;
  if (!tx || !values) { closeSheet(); return; }

  // what the owner changed about how the move is read
  const fields = {};
  if (typeof values.category === 'string' && values.category && values.category !== tx.category) fields.category = values.category;
  if (typeof values.klass === 'string' && KLASSES[values.klass]) {
    const follows = !!fields.category && !!CATEGORIES[fields.category] && !tx.recurringId && !(tx.locks || []).includes('klass');
    if (values.klass !== (follows ? klassOf(fields.category) : tx.klass)) fields.klass = values.klass;
  }
  if (typeof values.purpose === 'string' && PURPOSES.includes(values.purpose) && values.purpose !== tx.purpose) fields.purpose = values.purpose;
  const onlyThis = values.scope !== 'all';

  // the return check and the equipment split exist only for a business purchase, as it is being saved
  const purposeNow = typeof values.purpose === 'string' && PURPOSES.includes(values.purpose) ? values.purpose : tx.purpose;
  const klassNow = typeof values.klass === 'string' && KLASSES[values.klass] ? values.klass : tx.klass;
  const categoryNow = fields.category || tx.category;
  const isBusiness = tx.kind === 'spend' && purposeNow !== 'personal' && klassNow === 'oneoff' && categoryNow !== 'transfer' && categoryNow !== 'card_payment';

  // the rest: only what the form actually carried
  const next = {};
  if (isSpendish(tx) && CATEGORIES[tx.category] && CATEGORIES[tx.category].stop) next.planned = values.planned === 'on';
  if ('glyph' in values) next.glyph = GLYPHS[values.glyph] ? values.glyph : null;
  if ('note' in values) next.note = String(values.note).trim().slice(0, NOTE_MAX);
  let target = null; // an account id, NEW_ACCOUNT, or null when nothing is counted
  if ('payback_by' in values) {
    const by = isYmd(values.payback_by) ? values.payback_by : '';
    const via = String(values.payback_via || '').trim().slice(0, VIA_MAX);
    const answered = OUTCOMES.some(([key]) => key === values.payback_outcome) ? values.payback_outcome : tx.payback ? tx.payback.outcome : null;
    next.payback = isBusiness && (by || via) ? { by, via, outcome: answered } : null;
    if (isBusiness && values.equip === 'on') {
      const typed = toCents(values.equip_value);
      if (typed == null || typed <= 0 || typed > tx.amount) {
        store.setUi({ txError: { id: tx.id, text: 'Not saved: enter an amount from $0.01 up to ' + fmt(tx.amount) + ', the price paid.' } });
        return;
      }
      const known = equipmentAccounts(ctx.state).some((a) => a.id === values.equip_account);
      target = known ? values.equip_account : NEW_ACCOUNT;
      const old = tx.capital;
      // the same value in the same account: nothing to redo
      next.capital = old && old.value === typed && old.accountId && (old.accountId === target) ? old : { value: typed, accountId: known ? values.equip_account : null };
    } else {
      next.capital = null;
    }
  } else if (!isBusiness) {
    if (tx.capital) next.capital = null;
    if (tx.payback) next.payback = null;
  }
  if (store.ui.txError) store.setUi({ txError: null });
  const touched = Object.keys(next).filter((key) => !sameJson(next[key], tx[key]));
  const corrected = Object.keys(fields).length > 0;
  if (!corrected && !touched.length) {
    // saved as it stands: the owner has looked at it, so "needs a look" is answered
    if (tx.review) {
      store.update((s) => {
        confirmMove(s, tx.id);
      }, { undo: 'Move confirmed' });
      closeSheet();
      toast('Confirmed as read: ' + nameOf(tx) + ', ' + fmt(tx.amount) + ' on ' + fmtDate(tx.day, 'short') + '.', { action: 'Undo', onAction: undoLast });
      return;
    }
    closeSheet();
    return;
  }

  let result = { changed: 0 };
  let heldIn = '';
  store.update((s) => {
    const row = findTx(s, tx.id);
    if (!row) return;
    if (corrected) result = learnRule(s, row.id, fields, { onlyThis });
    // a save is the owner's reading of this move: on its own, or with the whole merchant
    confirmMove(s, row.id);
    for (const key of touched) {
      if (key === 'capital') continue;
      row[key] = next[key];
    }
    if (touched.includes('capital')) {
      releaseCapital(s, row);
      if (next.capital) {
        row.capital = { value: next.capital.value, accountId: null };
        const existing = target && target !== NEW_ACCOUNT ? s.accounts.find((a) => a.id === target) : null;
        if (existing) {
          row.capital.accountId = existing.id;
          countInto(row, existing);
          heldIn = accountLabel(existing);
        } else {
          const account = makeAccount({
            type: 'equipment', name: 'Equipment', balance: row.capital.value, asOf: ctx.now, basis: 'estimate',
            history: [{ day: row.day, balance: row.capital.value, note: COUNTED + nameOf(row) }],
          });
          s.accounts.push(account);
          row.capital.accountId = account.id;
          row.capital.created = true;
          heldIn = 'a new entry named ' + accountLabel(account);
        }
      }
    }
    // a correction for the whole merchant can make other purchases personal: their splits go with it
    if (corrected && !onlyThis && row.mkey) {
      for (const other of s.txs) {
        if (other && other !== row && other.mkey === row.mkey && other.capital && other.purpose === 'personal') {
          releaseCapital(s, other);
          other.payback = null;
        }
      }
    }
    refresh(s, ctx.now);
  }, { undo: corrected ? 'Move corrected' : 'Move updated' });

  closeSheet();
  const what = result.changed > 1 ? result.changed + ' moves from ' + nameOf(tx) + ' corrected.' : corrected ? 'Move corrected.' : 'Move updated.';
  let split = '';
  if (touched.includes('capital')) {
    split = next.capital
      ? ' ' + fmt(next.capital.value) + ' of the ' + fmt(tx.amount) + ' is counted as equipment in ' + heldIn + ' from ' + fmtDate(tx.day, 'short') + '.'
      : ' The equipment split is removed: the full ' + fmt(tx.amount) + ' counts as spending on ' + fmtDate(tx.day, 'short') + '.';
  }
  toast(what + split, { action: 'Undo', onAction: undoLast });
}

export const actions = {
  /** Save the form: the correction (through classify.learnRule), then the move's own marks; one undo step. */
  'tx.save': save,
  /** A new category brings its usual class with it (the owner can still choose another before saving). */
  'tx.category': ({ el }) => {
    const def = CATEGORIES[el.value];
    const radio = def && el.form ? el.form.querySelector('input[name="klass"][value="' + def.klass + '"]') : null;
    if (radio) radio.checked = true;
  },
  /** "Not this payment": the row is taken off the payment the owner sends, and never offered to it again. */
  'tx.pay-skip': ({ data }) => {
    const ctx = context();
    const tx = ctx ? findTx(ctx.state, data.id) : null;
    const pays = tx ? paysOf(ctx.state, tx) : null;
    if (!pays) return;
    const words = 'Row taken off the payment';
    let done = false;
    store.update((s) => {
      done = skipRow(s, pays.id, tx.id, ctx.now);
      if (done) refresh(s, ctx.now);
    }, { undo: words });
    if (!done) { if (store.undoLabel === words) store.undo(); return; }
    toast('The bank’s row of ' + fmtDate(tx.day, 'short') + ' no longer pays ' + (pays.name || 'the payment') + '.', {
      action: 'Undo',
      onAction: () => { if (store.undoLabel === words && store.undo()) toast('The row of ' + fmtDate(tx.day, 'short') + ' pays ' + (pays.name || 'the payment') + ' again.'); },
    });
  },
  /** Remove a tapped-in move or a declined purchase (bank rows cannot be removed). */
  'tx.remove': ({ data }) => {
    const ctx = context();
    const tx = ctx ? findTx(ctx.state, data.id) : null;
    if (!tx || tx.source !== 'manual') return;
    const words = tx.kind === 'decline' ? 'Declined purchase removed' : 'Move removed';
    store.update((s) => { removeManual(s, tx.id); }, { undo: words });
    closeSheet();
    toast(words + '.', { action: 'Undo', onAction: undoLast });
  },
};
