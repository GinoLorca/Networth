/**
 * The "Income stream" sheet (params.id): one payer the feed has seen at least twice.
 * The owner can rename it, set its kind and cadence, choose whether it is counted as earned day by
 * day (accrue — ARCHITECTURE 4.3) and leave a note. Every field changed is added to the stream's
 * `locks`, and detect.refresh runs in the same store.update.
 *
 * Actions: stream.save (the form; with undo).
 */

import { html, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { closeSheet } from '../router.js';
import { context, toast } from '../runtime.js';
import { fmt } from '../model/money.js';
import { fmtDate, relDay } from '../model/dates.js';
import { CADENCES, STREAM_KINDS, accountLabel } from '../model/schema.js';
import { nextOccurrence } from '../model/book.js';
import { refresh } from '../model/detect.js';

const NAME_MAX = 80;
const NOTE_MAX = 500;
const FED_FIELDS = { name: 'name', kind: 'kind', cadence: 'cadence', accrue: 'how it is counted' };

/* ------------------------------------------------------------------ helpers */

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many || one + 's');
}

function findStream(state, id) {
  return id ? state.streams.find((stream) => stream.id === id) || null : null;
}

function hasLock(item, field) {
  return Array.isArray(item.locks) && item.locks.includes(field);
}

function addLock(item, field) {
  if (!Array.isArray(item.locks)) item.locks = [];
  if (!item.locks.includes(field)) item.locks.push(field);
}

/** Deposits of this stream the bank has reported. */
function depositsOf(state, id) {
  let count = 0;
  for (const tx of state.txs) if (tx.streamId === id && !tx.matchId) count += 1;
  return count;
}

function regular(stream) {
  return typeof stream.cadence === 'string' && Object.hasOwn(CADENCES, stream.cadence);
}

/* ------------------------------------------------------------------- render */

export const label = (ctx, params) => {
  const stream = findStream(ctx.state, params && params.id);
  return stream ? 'Income stream: ' + (stream.name || 'unnamed stream') : 'Income stream';
};

function explanation(ctx, stream) {
  const settingOn = !!ctx.state.settings.smoothing;
  const isRegular = regular(stream);
  const days = isRegular ? CADENCES[stream.cadence].days : 0;
  const daily = isRegular ? Math.round(stream.amount / days) : 0;
  const receivable = ctx.d.position.receivables.find((item) => item.id === stream.id) || null;
  return html`<div class="bks-explain prose">
    <p><b>On.</b> ${isRegular
      ? html`Each day counts one day’s share of a deposit, <span class="est" data-fig><span class="approx">≈</span>${fmt(daily)}</span>, as earned. Net worth rises a little every day and does not jump on payday; what is earned and not yet received is printed in italics.`
      : html`It needs a cadence first: an irregular stream has no share for 1 day, so it is counted when it arrives.`}</p>
    <p><b>Off.</b> The whole deposit is counted on the day it arrives. With no stream counted day by day, net worth is shown exactly as the bank reports it.</p>
    ${receivable ? html`<p class="cap">Now: <span class="est" data-fig><span class="approx">≈</span>${fmt(Math.round(receivable.amount))}</span> earned since ${fmtDate(receivable.since, 'dowshort')} and not yet received.</p>` : ''}
    ${settingOn ? '' : html`<p class="cap">Counting pay as it is earned is switched off in Settings, so this choice waits until that is on. <a class="btn-link" href="#/settings">Settings</a></p>`}
  </div>`;
}

export function render(ctx, params) {
  const stream = findStream(ctx.state, params && params.id);
  if (!stream) {
    return html`<div class="sheet-body">
      <p class="sheet-head lab"><b>Income stream</b></p>
      <h2 class="sheet-title">This stream is not in the document.</h2>
      <p class="cap">Streams are found by the bank feed, after a payer’s second deposit. The Book lists the ${plural(ctx.state.streams.length, 'stream')} there are.</p>
      <div class="sheet-actions"><button class="btn" type="button" data-action="app.sheet-close">Close</button></div>
    </div>`;
  }
  const isRegular = regular(stream);
  const account = stream.accountId ? ctx.d.account(stream.accountId) : null;
  const deposits = depositsOf(ctx.state, stream.id);
  const next = isRegular && stream.anchor && stream.active ? nextOccurrence(stream, ctx.today) : null;
  const fed = Object.keys(FED_FIELDS).filter((field) => hasLock(stream, field));

  return html`<form class="sheet-body" data-submit="stream.save" data-id="${stream.id}" novalidate ${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>Income stream</b><i class="sep"></i>${stream.source === 'manual' ? 'entered by you' : 'found in the bank feed'}</p>
    <h2 class="sheet-title">${stream.name || 'Unnamed stream'}</h2>
    <ul class="rows bks-facts">
      <li class="row"><span class="row-label">Typical deposit</span><span class="row-value fig est"><span class="approx">≈</span>${fmt(stream.amount)}</span></li>
      <li class="row"><span class="row-label">Last deposit</span><span class="row-value" data-cover-keep>${stream.anchor ? fmtDate(stream.anchor, 'dowshort') + ' · ' + relDay(stream.anchor, ctx.today) : 'not known'}</span></li>
      ${next ? html`<li class="row"><span class="row-label">Next expected</span><span class="row-value" data-cover-keep>${fmtDate(next, 'dowshort')} · ${relDay(next, ctx.today)}</span></li>` : ''}
      <li class="row"><span class="row-label">Deposits seen</span><span class="row-value" data-cover-keep>${deposits}${account ? ', into ' + accountLabel(account) : ''}${stream.active ? '' : ' · not seen lately'}</span></li>
    </ul>

    <label class="field">
      <span class="field-label lab">Name</span>
      <input class="input" type="text" name="name" value="${stream.name}" maxlength="${NAME_MAX}" autocomplete="off">
    </label>

    <fieldset class="field">
      <legend class="field-label lab">Kind</legend>
      <div class="chips">
        ${Object.keys(STREAM_KINDS).map((key) => html`<label class="chip"><input type="radio" name="kind" value="${key}" ${attrs({ checked: key === (STREAM_KINDS[stream.kind] ? stream.kind : 'other') })}><span>${STREAM_KINDS[key].label}</span></label>`)}
      </div>
    </fieldset>

    <label class="field">
      <span class="field-label lab">Cadence</span>
      <span class="select"><select name="cadence">
        <option value="" ${attrs({ selected: !isRegular })}>Irregular</option>
        ${Object.keys(CADENCES).map((key) => html`<option value="${key}" ${attrs({ selected: key === stream.cadence })}>${CADENCES[key].label}</option>`)}
      </select></span>
    </label>

    <label class="switch switch-block bks-switch">
      <span class="switch-text">Count it as earned day by day <em>For regular pay, such as a salary.</em></span>
      <input type="checkbox" role="switch" name="accrue" ${attrs({ checked: !!stream.accrue })}>
      <span class="switch-track" aria-hidden="true"></span>
    </label>
    ${explanation(ctx, stream)}

    <label class="field">
      <span class="field-label lab">Note</span>
      <textarea class="textarea" name="note" rows="2" maxlength="${NOTE_MAX}">${stream.note || ''}</textarea>
    </label>

    ${fed.length ? html`<p class="cap">Set by you and no longer updated from the bank: ${fed.map((field) => FED_FIELDS[field]).join(', ')}. The amount and the last deposit still follow the feed.</p>` : ''}

    <div class="sheet-actions">
      <button class="btn btn-solid" type="submit">Save</button>
    </div>
  </form>`;
}

/* ------------------------------------------------------------------ actions */

export const actions = {
  'stream.save': ({ values, data }) => {
    const ctx = context();
    const stream = findStream(ctx.state, data.id);
    if (!stream) { closeSheet(); return; }
    const v = values || {};
    const text = (key) => (typeof v[key] === 'string' ? v[key].trim() : '');
    const cadence = Object.hasOwn(CADENCES, v.cadence) ? v.cadence : null;
    const wantsAccrual = v.accrue === 'on';
    const fields = {
      name: text('name').slice(0, NAME_MAX) || stream.name,
      kind: Object.hasOwn(STREAM_KINDS, v.kind) ? v.kind : stream.kind,
      cadence,
      // Day by day needs a cadence: without one there is no share for a day.
      accrue: wantsAccrual && cadence !== null,
      note: text('note').slice(0, NOTE_MAX),
    };
    const changed = Object.keys(fields).filter((key) => (stream[key] ?? null) !== (fields[key] ?? null));
    const refused = wantsAccrual && cadence === null;
    if (!changed.length) {
      closeSheet();
      if (refused) toast('An irregular stream has no share for 1 day: ' + (fields.name || stream.name || 'this stream') + ' stays counted when it arrives.');
      return;
    }
    const undoLabel = 'Income stream changed';
    store.update((s) => {
      const item = findStream(s, data.id);
      if (!item) return;
      for (const key of changed) {
        item[key] = fields[key];
        addLock(item, key);
      }
      refresh(s, ctx.now);
    }, { undo: undoLabel });
    closeSheet();
    const message = refused
      ? 'Saved: ' + fields.name + ', counted when it arrives. With no cadence it has no share for 1 day.'
      : changed.includes('accrue')
        ? fields.name + (fields.accrue ? ' is now counted as earned day by day.' : ' is now counted on the day it arrives.')
        : plural(changed.length, 'field') + ' saved on ' + fields.name + '.';
    toast(message, {
      action: 'Undo',
      onAction: () => {
        if (store.undoLabel === undoLabel && store.undo()) toast('Undone: ' + stream.name + ' is as it was.');
      },
    });
  },
};
