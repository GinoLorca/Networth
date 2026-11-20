/**
 * Money in on the first face of the Analysis cell (pass 3; DESIGN sections 4 to 6, Appendix G): the deposits of the
 * queue ("In"), Reinforcements / Money in with Fig. 1, Development / Prospects, the suggested sources, and the source
 * block of a deposit's sheet. Model: model/inlets.js. Every decision is one undoable store.update and travels in the
 * `flows` section (`inlets`, `into`, `offers`).
 *
 * Honesty: bank sums roman; pencil money (reported, not yet at the bank) and estimates italic with ≈; cash named. Cover
 * mode covers every amount (.fig, data-fig, the chart's figures); counts and shares carry data-cover-keep.
 *
 * Actions: inlets.file (a chip of the queue: a source, Windfalls or Leave it) · inlets.new / inlets.new-save /
 *          inlets.new-cancel (a new source named from the queue, made and filed in one Undo) · inlets.offer (Add,
 *          Not now, Restore) · inlets.file-tx and inlets.scope (the deposit's sheet) · flows.money-in ("It was money in")
 */

import { html, cx } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { fmt, fmtSigned, fmtPct } from '../model/money.js';
import { fmtDate, fmtMonth, nowMs } from '../model/dates.js';
import { sayHtml } from '../ui/say.js';
import { phrase, say } from '../model/words.js';
import { INLETS_LIVE_MAX } from '../model/flowsection.js';
import {
  INLET_KINDS, LEAVE, WINDFALL, YEAR_KINDS, acceptOffer, canMakeInlet, canUnfile, depositQueue, dismissOffer, fileDeposit, fileQueueItem, fileToNew,
  appNameOf, chipOrder, filingOf, inletName, inletsOf, isCatchAllIn, keysOf, leftEarlier, lookOf, moneyInMove, payEndedStreams, restoreOffer, suggestions,
} from '../model/inlets.js';
import { merchantKeyOf } from '../model/corrections.js';

/* ----------------------------------------------------------------- helpers */

function amt(cents, opts = {}) {
  const text = opts.signed ? fmtSigned(cents, { decimals: opts.decimals ?? 2 }) : fmt(cents, { decimals: opts.decimals ?? 2 });
  return html`<span class="${cx('nowrap', opts.est && 'est')}" data-fig>${opts.est ? '≈' : ''}${text}</span>`;
}

function keep(text) {
  return html`<span data-cover-keep>${text}</span>`;
}

function pct(fraction, words) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  if (fraction > 0 && fraction < 0.005) return phrase('flows.pct.under', words);
  return fmtPct(fraction, 0);
}

/**
 * The shares of one column as the page shows them (round 6): whole percents by largest remainders, so the column adds up
 * to 100% as the shares do; a share under half a percent reads "under 1%" and takes no part, and no share reads '—'.
 * Round 9 (LIMITS-TRIAGE F3): every part of half a percent or more reads at least 1% (round 6 let one between ½% and 1%
 * read "0%" when the rows above took the spare points); what that floor takes over the column's total comes back, a point
 * each, from the parts above 1% with the smallest remainders (ties: the later share). Spare points go by the largest
 * remainders, ties to the earlier share (the rows' order). Pure.
 * @param {(number|null)[]} fractions
 * @returns {string[]}
 */
export function shareTexts(fractions, words) {
  const list = Array.isArray(fractions) ? fractions : [];
  const out = list.map((fraction) => pct(fraction, words));
  const parts = [];
  list.forEach((fraction, i) => {
    if (fraction == null || !Number.isFinite(fraction) || fraction < 0.005) return;
    const exact = fraction * 100;
    // the floor of 1: a part of half a percent or more never reads 0%
    const whole = Math.max(1, Math.floor(exact + 1e-9));
    parts.push({ i, whole, rest: exact - whole, exact });
  });
  if (!parts.length) return out;
  const target = Math.round(parts.reduce((n, one) => n + one.exact, 0));
  let spare = target - parts.reduce((n, one) => n + one.whole, 0);
  for (const one of [...parts].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (spare <= 0) break;
    one.whole += 1;
    spare -= 1;
  }
  // the floor took more than the column holds: a point back from each part above 1%, the smallest remainder first
  while (spare < 0) {
    const above = parts.filter((one) => one.whole > 1).sort((a, b) => a.rest - b.rest || b.i - a.i);
    if (!above.length) break;
    for (const one of above) {
      if (spare >= 0) break;
      one.whole -= 1;
      one.rest += 1;
      spare += 1;
    }
  }
  for (const one of parts) out[one.i] = fmtPct(one.whole / 100, 0);
  return out;
}

/** A source's kind in the words of the interface: Fortress / Steady pay … */
export function kindLabel(kind, words) {
  return phrase('inlets.kind.' + (INLET_KINDS.includes(kind) ? kind : 'job'), words);
}

/** A source's name as the page shows it (the owner's own words). */
function nameOf(inlet) {
  return inlet && inlet.name ? inlet.name : '—';
}

function undoLast() {
  const label = store.undo();
  if (label) toast(say('flows.undone', (context() || {}).words, { what: String(label).replace(/[.]+$/, '') }));
}

/**
 * The pay before a decision (round 5), read from the context's ledger before its update, since the update changes the
 * record in place: each pay stream's id, name, payer and whether it accrued, and the one that set the payday.
 * @returns {{ streams: object[], main: string|null }}
 */
export function payBefore(ctx) {
  const ledger = ctx && ctx.d && ctx.d.ledger;
  const streams = ledger && typeof ledger.payStreams === 'function'
    ? ledger.payStreams().map((one) => ({ id: one.id, name: one.name, mkey: one.mkey, accrue: !!one.accrue })) : [];
  return { streams, main: ledger && typeof ledger.payMain === 'function' ? ledger.payMain() : null };
}

/**
 * The toast's note when a decision ended pay (the pay fix, G.7.2; round 4): " {names} no longer sets the payday or counts
 * as earned.", or '' when it ended none. `before` is payBefore(ctx) read before the update; the store holds the state
 * after, read at the same clock. Only a stream that accrued or set the payday is named (inlets.payEndedStreams, round 5).
 * `payer`: the payer key the toast has just named; when the pay ended is that payer's alone, the note says "It" (round 5:
 * the toast names it once).
 */
export function payNote(ctx, before, payer = null) {
  const b = before || { streams: [], main: null };
  return payNoteOf(ctx.words, payEndedStreams(b.streams, store.state, ctx.now, b.main), payer);
}

/** payNote's words for the streams it ended (pure: the words, the streams, the payer key the toast named). */
export function payNoteOf(words, ended, payer = null) {
  if (!ended.length) return '';
  if (payer && ended.every((stream) => merchantKeyOf(stream.mkey) === payer)) return ' ' + say('inlets.toast.payEndsIt', words);
  const names = [];
  for (const stream of ended) {
    const name = typeof stream.name === 'string' ? stream.name.trim() : '';
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return ' ' + say(names.length === 1 ? 'inlets.toast.payEnds' : 'inlets.toast.payEndsMany', words, { names: list });
}

/**
 * The toast of a queue item's filing (round 5): your other app's item says what its tap files, every payment it reports
 * and their deposits, as the queue's lead does; a new source that carries the item's own name is not named twice.
 * @param {object} item  a depositQueue item
 * @param {string} name  the source's name (or Windfalls)
 * @param {boolean} [made]  a new source named from the queue
 */
export function queueToast(words, item, name, made = false) {
  const merchant = item.merchant || name;
  const same = made && inletName(merchant) === name;
  const key = item.kind === 'one' ? 'inlets.toast.filedOne' : item.kind === 'app' ? 'inlets.toast.filedApp' : 'inlets.toast.filed';
  return say(same ? key + 'New' : key, words, { merchant, app: merchant, name });
}

/* ------------------------------------------------------------- the queue: In */

/** One deposit item: the payer, the reporting app or one deposit; chips of the sources, Windfalls and Leave it. */
function inItem(ctx, item, inlets) {
  const ui = ctx.ui.flNewIn || null;
  const scope = item.kind === 'one' ? say('inlets.q.one', ctx.words) : item.kind === 'app' ? say('inlets.q.app', ctx.words)
    : item.zelle ? say('inlets.q.zelle', ctx.words) : say('inlets.q.payer', ctx.words);
  const count = item.count === 1 ? say('inlets.q.countOne', ctx.words) : say('inlets.q.count', ctx.words, { n: item.count });
  const guess = item.guess ? inlets.get(item.guess) : null;
  const notes = [keep(count), scope, say('flows.queue.last', ctx.words, { date: fmtDate(item.last, 'short') })];
  if (guess) notes.push(say('inlets.q.guess', ctx.words, { name: nameOf(guess) }));
  // a sender's first deposit that your other app's matching paired with a payment (round 9, F2): asked about here, named
  if (item.paired) {
    const date = item.paired.day ? fmtDate(item.paired.day, 'short') : '';
    // round 10: it names the deposit it paired, on an item that holds others too
    const deposit = item.paired.deposit ? fmtDate(item.paired.deposit, 'short') : '';
    notes.push(item.paired.payer ? say('inlets.q.paired', ctx.words, { deposit, payer: item.paired.payer, what: item.paired.what, date })
      : say('inlets.q.paired.bare', ctx.words, { deposit, what: item.paired.what, date }));
  }
  const name = item.merchant || say('inlets.unfiled', ctx.words);
  const chip = (id, label, first) => html`<button class="${cx('chip', first && 'fl-q-guess')}" type="button" data-action="inlets.file" data-key="${item.key}" data-to="${id}"
    aria-label="${say('inlets.q.chip.aria', ctx.words, { merchant: name, name: label })}">${first ? '✓ ' : ''}${label}</button>`;
  const open = ui === item.key;
  return html`<li class="fl-q-item fl-q-in" data-key="${item.key}">
    <p class="fl-q-line">
      <span class="fl-q-name">${name}</span>
      <span class="fl-q-fig"><span class="fig fl-q-amt">+${fmt(item.amount)}</span></span>
    </p>
    <p class="cap fl-q-why">${notes.map((part, i) => html`${i ? ' · ' : ''}${part}`)}</p>
    <div class="chips fl-q-chips" role="group" aria-label="${name}">
      ${item.sources.map((id, i) => chip(id, nameOf(inlets.get(id)), i === 0 && id === item.guess))}
      ${chip(WINDFALL, phrase('inlets.windfalls', ctx.words), false)}
      <button class="chip" type="button" data-action="inlets.new" data-key="${item.key}" aria-expanded="${open ? 'true' : 'false'}">${sayHtml('inlets.q.new', ctx.words)}</button>
      <button class="chip" type="button" data-action="app.sheet" data-sheet="tx" data-id="${item.txId}" aria-label="${say('inlets.q.more.aria', ctx.words, { merchant: name })}">${sayHtml('flows.queue.more', ctx.words)}</button>
    </div>
    ${open ? newForm(ctx, item) : ''}
    <p class="fl-q-leave"><button class="btn-link" type="button" data-action="inlets.file" data-key="${item.key}" data-to="${LEAVE}" aria-label="${say(item.kind === 'one' ? 'inlets.q.leave.aria' : 'inlets.q.leave.aria.sofar', ctx.words, { merchant: name })}">${sayHtml('inlets.q.leave', ctx.words)}</button></p>
  </li>`;
}

/**
 * A new source named from the queue: a name and a kind; made and filed within the same Undo. The kind opens on the item's
 * (round 4: Steady pay for a payer that is pay, so Save never ends the owner's own pay; Back-end for a royalty payer).
 */
function newForm(ctx, item) {
  const value = inletName(item.merchant || '');
  const chosen = INLET_KINDS.includes(item.newKind) ? item.newKind : 'job';
  return html`<form class="fl-new" data-submit="inlets.new-save" data-key="${item.key}" novalidate>
    <label class="field">
      <span class="field-label lab">${sayHtml('inlets.new.name', ctx.words)}</span>
      <input class="input" type="text" name="name" value="${value}" maxlength="40" autocomplete="off" required>
    </label>
    <fieldset class="field">
      <legend class="field-label lab">${sayHtml('inlets.new.kind', ctx.words)}</legend>
      <div class="chips">${INLET_KINDS.map((kind) => html`<label class="chip"><input type="radio" name="kind" value="${kind}" ${kind === chosen ? html`checked` : ''}><span>${kindLabel(kind, ctx.words)}</span></label>`)}</div>
    </fieldset>
    <div class="fl-new-acts">
      <button class="btn btn-solid" type="submit">${sayHtml('inlets.new.save', ctx.words)}</button>
      <button class="btn" type="button" data-action="inlets.new-cancel">${sayHtml('inlets.new.cancel', ctx.words)}</button>
    </div>
  </form>`;
}

/** The In part of the queue: its own label, the lead, and the items (three, from 720px, until "+ All n"). */
export function inList(ctx, q) {
  if (!q.items.length) return '';
  const inlets = inletsOf(ctx.state);
  const deposits = q.items.reduce((n, one) => n + one.count, 0);
  const depositsWords = deposits === 1 ? phrase('inlets.q.deposits.one', ctx.words) : say('inlets.q.deposits.many', ctx.words, { n: deposits });
  // your other app's item is counted as an app, and the lead says what its one tap files (round 4)
  const app = q.items.some((one) => one.kind === 'app');
  const items = q.items.length === 1 ? phrase(app ? 'inlets.q.itemsApp.one' : 'inlets.q.items.one', ctx.words)
    : say(app ? 'inlets.q.itemsApp.many' : 'inlets.q.items.many', ctx.words, { n: q.items.length });
  return html`<div class="fl-q-side" data-side="in">
    <p class="fl-grp-head fl-q-side-head"><span class="lab"><b>${sayHtml('flows.queue.in', ctx.words)}</b> · ${keep(String(q.items.length))}</span></p>
    <p class="cap fl-q-lead">${sayHtml(deposits === 1 ? 'flows.queue.leadInOne' : 'flows.queue.leadIn', ctx.words, { deposits: keep(depositsWords), date: fmtDate(q.from, 'medium'), items: keep(items) })}${app ? html` ${sayHtml('flows.queue.leadInApp', ctx.words)}` : ''}</p>
    <ol class="fl-q-list">${q.items.map((item) => inItem(ctx, item, inlets))}</ol>
  </div>`;
}

/* ------------------------------------------------------------- Reinforcements */

/** A change that reads $0 in whole dollars (round 10): it reads ±$0, never an unsigned "$0" (a few cents of interest). */
const noChange = (cents) => Math.round(cents / 100) === 0;

/**
 * All earned's or Windfalls' change: ±$0 under a dollar, and "—" beyond the queue when what it would compare was filed one
 * at a time (round 11, D6: the year before was never asked about), its caption saying so.
 */
function totalChange(one) {
  if (one.change == null) return one.oneAtATime ? html`<span class="nowrap" data-fig>—</span>` : '';
  if (noChange(one.change)) return html`<span class="nowrap" data-fig>±$0</span>`;
  return amt(one.change, { signed: true, est: one.est, decimals: 0 });
}

export function changeOf(ctx, row, days) {
  // beyond the queue, a source holding only deposits filed one at a time has nothing to compare (PAYDAYS (e))
  if (row.change == null) return row.oneAtATime ? html`<span class="fl-chg"><span class="nowrap" data-fig>—</span></span>` : '';
  if (noChange(row.change)) return html`<span class="fl-chg"><span class="nowrap" data-fig>±$0</span></span>`;
  return html`<span class="fl-chg">${amt(row.change, { signed: true, est: row.est, decimals: 0 })}</span>`;
}

/** The line under a source: paydays, money per session, or its 12 months on record. */
export function whyOf(ctx, row, days) {
  const parts = [];
  // a quiet row (round 6): paid only before the 12 months, the day it was last paid
  // round 9 (F4): both lines name the first month they count, which the 365-day period and the queue start before
  const since = row.year && typeof row.year.since === 'string' && /^\d{4}-\d{2}$/.test(row.year.since) ? fmtMonth(row.year.since, 'short') : '';
  if (row.last) {
    parts.push(say('inlets.quiet', ctx.words, { m: row.year.months, month: since, date: fmtDate(row.last, 'medium') }));
  } else if (YEAR_KINDS.includes(row.kind)) {
    parts.push(sayHtml('inlets.year', ctx.words, { amount: amt(row.year.cents, { est: row.year.est, decimals: 0 }), n: keep(row.year.paid), m: keep(row.year.months), month: keep(since) }));
  } else if (row.paydays) {
    // its own paydays, as In and out compares them (PAYDAYS (e)); its paydays of the period that sit only in other rows are
    // counted apart (a paycheck filed elsewhere is a payday fewer here)
    // round 10: the row's own phrases, "1 payday" for one, a missing payday named so, and no sentence's end before " · "
    const p = row.paydays;
    const paydays = p.now === 1 ? say('inlets.paydays.one', ctx.words) : say('inlets.paydays.now', ctx.words, { n: p.now });
    if (p.before == null) { if (p.now) parts.push(paydays); }
    else if (p.mixed) parts.push(say('inlets.paydays.mixed', ctx.words, { paydays, before: p.before, days }));
    else if (!p.extra) { if (p.now || p.before) parts.push(say('inlets.paydays.same', ctx.words, { paydays, days })); }
    else parts.push(say('inlets.paydays.' + (p.extra > 0 ? 'more' : 'fewer') + (Math.abs(p.extra) === 1 ? '.one' : '.many'), ctx.words, { paydays, before: p.before, days, extra: Math.abs(p.extra) }));
    if (p.elsewhere) parts.push(say(p.elsewhere === 1 ? 'inlets.paydays.elsewhere.one' : 'inlets.paydays.elsewhere.many', ctx.words, { n: p.elsewhere }));
  }
  if (row.oneAtATime) parts.push(say('inlets.oneAtATime', ctx.words));
  else if (row.leftOneAtATime && row.change != null) parts.push(say('inlets.oneAtATime.part', ctx.words));
  if (row.sessions) {
    parts.push(row.sessions.n === 1
      ? sayHtml('inlets.sessions.one', ctx.words, { amount: amt(row.sessions.per, { est: true, decimals: 0 }) })
      : sayHtml('inlets.sessions', ctx.words, { n: keep(row.sessions.n), amount: amt(row.sessions.per, { est: true, decimals: 0 }) }));
  }
  if (row.cash > 0) parts.push(sayHtml('inlets.cash', ctx.words, { amount: amt(row.cash, { decimals: 0 }) }));
  if (row.gone) parts.push(say('inlets.archived', ctx.words));
  return parts.length ? html`<p class="cap fl-in-why">${parts.map((part, i) => html`${i ? ' · ' : ''}${part}`)}</p>` : '';
}

function sourceRow(ctx, row, days, share = pct(row.share, ctx.words)) {
  return html`<li class="fl-in-row" data-key="${row.id}">
    <p class="fl-in-line">
      <span class="fl-in-name"><button class="btn-link fl-in-open" type="button" data-action="app.sheet" data-sheet="inlet" data-id="${row.id}">${nameOf(row)}</button>
        <span class="bk-tag fl-in-kind">${kindLabel(row.kind, ctx.words)}</span>${row.focus ? html` <span class="bk-tag fl-in-focus">${sayHtml('inlets.focus', ctx.words)}</span>` : ''}</span>
      <span class="fl-in-figs">
        <span class="${cx('fig fl-in-amt', row.est && 'est')}">${row.cents ? html`${row.est ? html`<span class="approx">≈</span>` : ''}${fmt(row.cents, { decimals: 0 })}` : '—'}</span>
        <span class="fl-in-share" data-cover-keep>${share}</span>
        ${changeOf(ctx, row, days) || html`<span class="fl-chg"></span>`}
      </span>
    </p>
    ${whyOf(ctx, row, days)}
  </li>`;
}

function offersPart(ctx, offers) {
  if (!offers.shown.length && !offers.dismissed.length) return '';
  const full = !canMakeInlet(ctx.state);
  return html`<div class="fl-in-offers">
    ${offers.shown.length ? html`<p class="fl-grp-head"><span class="lab"><b>${sayHtml('inlets.offers', ctx.words)}</b> · ${keep(String(offers.shown.length))}</span></p>
    <ul class="fl-s-list">${offers.shown.map((one) => html`<li class="fl-s-item" data-key="${one.key}" aria-label="${say('inlets.offer.aria', ctx.words, { name: one.name, kind: kindLabel(one.kind, ctx.words) })}">
      <p class="fl-s-line"><span class="fl-s-name">${one.name}? <span class="bk-tag fl-in-kind">${kindLabel(one.kind, ctx.words)}</span></span></p>
      <p class="cap fl-s-why">${say('inlets.offer.why.' + (one.why || one.kind), ctx.words)}${one.cents ? html` · ${sayHtml('inlets.offer.year', ctx.words, { amount: amt(one.cents, { est: one.est, decimals: 0 }) })}` : ''}${one.cash > 0 ? html` · ${sayHtml('inlets.cash', ctx.words, { amount: amt(one.cash, { decimals: 0 }) })}` : ''}</p>
      <div class="fl-s-acts"><span class="chips">
        <button class="chip" type="button" data-action="inlets.offer" data-key="${one.key}" data-to="add" ${full ? html`disabled` : ''}>${sayHtml('inlets.offer.add', ctx.words)}</button>
        <button class="chip" type="button" data-action="inlets.offer" data-key="${one.key}" data-to="not">${sayHtml('inlets.offer.not', ctx.words)}</button>
      </span></div>
    </li>`)}</ul>` : ''}
    ${offers.dismissed.length ? html`<details class="fl-s-gone">
      <summary class="btn-link">${sayHtml('inlets.offer.dismissed', ctx.words)} · ${keep(String(offers.dismissed.length))}</summary>
      <ul class="rows rows-plain">${offers.dismissed.map((one) => html`<li class="row" data-key="${one.key}">
        <span class="row-label">${one.name} <span class="bk-tag fl-in-kind">${kindLabel(one.kind, ctx.words)}</span></span>
        <button class="btn-link" type="button" data-action="inlets.offer" data-key="${one.key}" data-to="restore">${sayHtml('inlets.offer.restore', ctx.words)}</button>
      </li>`)}</ul>
    </details>` : ''}
  </div>`;
}

/** Fig. 1's data for the chart, its text alternative in the words of the interface. */
function figData(ctx, fig) {
  const months = fig.months;
  const firstShown = fig.first && fig.first > months[0] ? fig.first : months[0];
  const list = fig.rows.map((row) => say('inlets.fig.summaryRow', ctx.words, {
    name: row.unfiled ? phrase('inlets.unfiled', ctx.words) : row.name, amount: (row.est ? '≈' : '') + fmt(row.total, { decimals: 0 }), n: row.paid, m: row.onRecord,
  })).join('; ');
  const summary = say('inlets.fig.summary', ctx.words, {
    from: fmtMonth(firstShown, 'short'), to: fmtMonth(months[months.length - 1], 'short'),
    short: fig.first && fig.first > months[0] ? phrase('inlets.fig.summaryShort', ctx.words) : '', list,
  });
  return {
    summary,
    first: fig.first,
    today: fig.today,
    months,
    paid: phrase('inlets.fig.paid', ctx.words),
    unfiled: phrase('inlets.unfiled', ctx.words),
    rows: fig.rows.map((row) => ({ name: row.unfiled ? '' : row.name, unfiled: !!row.unfiled, total: row.total, est: row.est, paid: row.paid, onRecord: row.onRecord,
      goal: row.goal, cells: row.cells.map((cell) => ({ ym: cell.ym, bank: cell.bank, pencil: cell.pencil, blank: cell.blank })) })),
  };
}

function figTable(ctx, fig) {
  const rows = fig.rows;
  return html`<details class="fl-fig-table">
    <summary class="btn-link">+ ${sayHtml('inlets.fig.table', ctx.words)}</summary>
    <div class="table-scroll"><table class="table table-s">
      <thead><tr><th scope="col">${sayHtml('inlets.fig.month', ctx.words)}</th>${rows.map((row) => html`<th scope="col">${row.unfiled ? phrase('inlets.unfiled', ctx.words) : row.name}</th>`)}</tr></thead>
      <tbody>${fig.months.map((ym, i) => html`<tr>
        <th scope="row">${fmtMonth(ym, 'short')}</th>
        ${rows.map((row) => {
          const cell = row.cells[i];
          if (cell.blank) return html`<td class="cap">${say('inlets.fig.before', ctx.words)}</td>`;
          const total = cell.bank + cell.pencil;
          return html`<td class="${cx('fig', cell.pencil > 0 && 'est')}">${cell.pencil > 0 ? html`<span class="approx">≈</span>` : ''}${fmt(total, { decimals: 0 })}</td>`;
        })}
      </tr>`)}</tbody>
    </table></div>
  </details>`;
}

function figOnePart(ctx, fig) {
  if (!fig.rows.length) return '';
  const data = figData(ctx, fig);
  const months = fig.months;
  const goal = fig.rows.some((row) => row.goal);
  return html`<figure class="fl-fig" aria-labelledby="fl-fig-h">
    <figcaption class="sec-head fl-fig-head" id="fl-fig-h">
      <span class="lab"><b>${sayHtml('inlets.fig', ctx.words)}</b><i class="sep"></i>${sayHtml('inlets.fig.title', ctx.words)}</span>
      <span class="lab">${fmtMonth(months[0], 'short')} – ${fmtMonth(months[months.length - 1], 'short')}</span>
    </figcaption>
    <nw-chart data-island kind="inlets" class="fl-fig-chart" data="${JSON.stringify(data)}"></nw-chart>
    <p class="cap fl-note">${fig.first && fig.first > months[0] ? say('inlets.fig.record', ctx.words, { date: fmtDate(fig.firstDay || fig.first + '-01', 'medium') }) : say('inlets.fig.full', ctx.words)}${goal ? ' · ' + say('inlets.fig.goal', ctx.words) : ''}</p>
    ${figTable(ctx, fig)}
  </figure>`;
}

/**
 * The note under Not yet filed when the queue holds none of it (round 4), worded from what it holds (round 5): your other
 * app's payments while that app is suggested ("add {app} below"), a deposit that has not posted ("joins the queue once it
 * posts"), else the sheets (a payment your other app reported, a deposit you left). Pure. While the queue holds a deposit
 * (`queued`, round 6), beside "file ↑": only the first two, which the queue never asks about, or '' when it holds neither.
 * @param {{ cents: number, pending?: number, apps?: object }} unfiled  moneyInBySource's `unfiled`
 * @param {object[]} shown  the suggestions shown (suggestions().shown)
 * @param {number} [queued]  the items of the queue's In
 */
export function unfiledNote(words, unfiled, shown, queued = 0) {
  const apps = unfiled && unfiled.apps && typeof unfiled.apps === 'object' ? unfiled.apps : {};
  const pending = unfiled && unfiled.pending > 0 ? unfiled.pending : 0;
  const offer = (shown || []).find((one) => one && one.key && one.key[0] === 'r' && apps[one.intoKey] > 0) || null;
  const rest = (unfiled ? unfiled.cents : 0) - pending - (offer ? apps[offer.intoKey] : 0);
  const parts = [];
  if (offer) parts.push(say('inlets.unfiled.offerPart', words, { app: offer.name }));
  if (pending) parts.push(phrase('inlets.unfiled.pendingPart', words));
  if (queued > 0) return parts.join('; ');
  if (rest > 0 && parts.length) parts.push(phrase('inlets.unfiled.sheetsPart', words));
  return parts.length ? say('inlets.unfiled.lead', words, { what: parts.join('; ') }) : say('inlets.unfiled.sheets', words);
}

/**
 * Reinforcements / Money in: each source with money on record (name, kind, the tag, money, share, change), Not yet
 * filed with "file ↑", All earned, Windfalls apart, the suggestions, Fig. 1 and the captions. `queued`: the items of the
 * queue's In; "file ↑" shows only while there is one (round 4), and Not yet filed with money but none queued (cash or a
 * payment your other app reported, a deposit you left) says where it is filed instead.
 */
export function inSection(ctx, sec, offers, fig, queued = 1) {
  const days = sec.window.days;
  const head = html`<div class="sec-head">
      <h2 class="lab" id="fl-in-h"><b>${sayHtml('inlets.h', ctx.words)}</b><i class="sep"></i>${sayHtml('inlets.note', ctx.words)}</h2>
      <span class="lab">${say('flows.io.last', ctx.words, { days })}</span>
    </div>`;
  // Windfalls shows while it holds money, or its change does not read ±$0 (money there only in the window before), so All
  // earned's change and Windfalls' add up to In and out's on the page (PAYDAYS (d))
  const windShown = sec.windfalls.cents > 0 || (sec.windfalls.change != null && !noChange(sec.windfalls.change)) || !!sec.windfalls.oneAtATime;
  const any = sec.rows.length || sec.unfiled.cents || windShown;
  const hasPencil = sec.rows.some((row) => row.pencil > 0) || sec.unfiled.est;
  const hasBackend = sec.rows.some((row) => YEAR_KINDS.includes(row.kind)) || sec.prospects.some((one) => YEAR_KINDS.includes(one.kind));
  // cash is named wherever it is counted (round 2): a source's row, Not yet filed and Windfalls
  const hasCash = sec.rows.some((row) => row.cash > 0 || row.year.cash > 0) || sec.unfiled.cash > 0 || sec.windfalls.cash > 0;
  const short = sec.frame.firstOnRecord && sec.frame.onRecord < 12;
  const whatWords = sec.windfalls.what.map((what) => say('inlets.what.' + what, ctx.words)).join(', ');
  // where Not yet filed's money is filed: with none queued, every way (round 4); beside "file ↑", the ways the queue never
  // offers (a suggested app's payments, a pending deposit: round 6)
  const unfiledSays = sec.unfiled.cents > 0 ? unfiledNote(ctx.words, sec.unfiled, offers.shown, queued) : '';
  // the column of shares adds up to 100% (round 6): the source rows, then Not yet filed
  const shares = shareTexts([...sec.rows.map((row) => row.share), sec.unfiled.share], ctx.words);
  return html`<section class="band fl-in" id="fl-in" aria-labelledby="fl-in-h">${head}
    ${!sec.rows.length && !sec.prospects.length && !sec.archived.length ? html`<p class="cap">${sayHtml(offers.shown.length ? 'inlets.empty' : 'inlets.emptyBare', ctx.words)}</p>` : ''}
    ${any ? html`<ul class="fl-in-list">
      ${sec.rows.map((row, i) => sourceRow(ctx, row, days, shares[i]))}
      <li class="fl-in-row fl-in-unfiled" data-key="unfiled">
        <p class="fl-in-line">
          <span class="fl-in-name">${sayHtml('inlets.unfiled', ctx.words)}</span>
          <span class="fl-in-figs">
            <span class="${cx('fig fl-in-amt', sec.unfiled.est && 'est')}">${sec.unfiled.est ? html`<span class="approx">≈</span>` : ''}${fmt(sec.unfiled.cents, { decimals: 0 })}</span>
            <span class="fl-in-share" data-cover-keep>${shares[sec.rows.length]}</span>
            <span class="fl-chg">${queued > 0 ? html`<button class="btn-link fl-in-file" type="button" data-action="flows.queue" data-open="1" aria-label="${say('inlets.file.aria', ctx.words)}">${sayHtml('inlets.file', ctx.words)} ↑</button>` : ''}</span>
          </span>
        </p>
        ${sec.unfiled.cash > 0 || unfiledSays ? html`<p class="cap fl-in-why">${[
          sec.unfiled.cash > 0 ? sayHtml('inlets.cash', ctx.words, { amount: amt(sec.unfiled.cash, { decimals: 0 }) }) : '',
          unfiledSays,
        ].filter(Boolean).map((part, i) => html`${i ? ' · ' : ''}${part}`)}</p>` : ''}
      </li>
    </ul>
    <p class="fl-in-total">
      <span class="lab"><b>${sayHtml('inlets.earned', ctx.words)}</b></span>
      <span class="${cx('fig fl-in-amt', sec.earned.est && 'est')}">${sec.earned.est ? html`<span class="approx">≈</span>` : ''}${fmt(sec.earned.cents, { decimals: 0 })}</span>
      <span class="fl-chg">${totalChange(sec.earned)}</span>
    </p>
    ${sec.earned.oneAtATime ? html`<p class="cap fl-in-why">${say('inlets.earned.oneAtATime', ctx.words)}</p>` : ''}
    ${windShown ? html`<p class="fl-in-wind">
      <span class="fl-in-name">${sayHtml('inlets.windfalls', ctx.words)}<em class="row-note">${sayHtml('inlets.windfalls.note', ctx.words)}${whatWords ? ' · ' + whatWords : ''}${sec.windfalls.cash > 0 ? html` · ${sayHtml('inlets.cash', ctx.words, { amount: amt(sec.windfalls.cash, { decimals: 0 }) })}` : ''}</em></span>
      <span class="${cx('fig fl-in-amt', sec.windfalls.est && 'est')}">${sec.windfalls.est ? html`<span class="approx">≈</span>` : ''}${fmt(sec.windfalls.cents, { decimals: sec.windfalls.cents < 1000 ? 2 : 0 })}</span>
      <span class="fl-chg">${totalChange(sec.windfalls)}</span>
    </p>
    ${sec.windfalls.oneAtATime || (sec.windfalls.leftOneAtATime && sec.windfalls.change != null)
      ? html`<p class="cap fl-in-why">${say(sec.windfalls.oneAtATime ? 'inlets.oneAtATime' : 'inlets.oneAtATime.part', ctx.words)}</p>` : ''}` : ''}` : html`<p class="cap">${sayHtml('inlets.none', ctx.words, { days })}</p>`}
    ${offersPart(ctx, offers)}
    ${figOnePart(ctx, fig)}
    <p class="cap fl-note">${[
      short ? say('inlets.cap.short', ctx.words, { date: fmtDate(sec.window.firstDay || sec.frame.from, 'medium') }) : '',
      hasPencil ? phrase('flows.in.pencilNote', ctx.words) : '',
      hasCash ? phrase('inlets.cap.cash', ctx.words) : '',
      hasBackend ? phrase('inlets.cap.backend', ctx.words) : '',
      phrase('inlets.cap.unlinked', ctx.words),
    ].filter(Boolean).join(' ')}</p>
  </section>`;
}

/** Development / Prospects: sources with no money on record; "+ Add a source"; the archive, collapsed. */
export function devSection(ctx, sec) {
  return html`<section class="band fl-dev" aria-labelledby="fl-dev-h">
    <div class="sec-head">
      <h2 class="lab" id="fl-dev-h"><b>${sayHtml('inlets.dev', ctx.words)}</b><i class="sep"></i>${sayHtml('inlets.dev.note', ctx.words)}</h2>
    </div>
    ${sec.prospects.length ? html`<ul class="rows rows-plain fl-dev-list">${sec.prospects.map((one) => html`<li class="row" data-key="${one.id}">
      <span class="row-label"><button class="btn-link fl-in-open" type="button" data-action="app.sheet" data-sheet="inlet" data-id="${one.id}">${nameOf(one)}</button>
        <span class="bk-tag fl-in-kind">${kindLabel(one.kind, ctx.words)}</span>${one.focus ? html` <span class="bk-tag fl-in-focus">${sayHtml('inlets.focus', ctx.words)}</span>` : ''}<em class="row-note">${say('inlets.dev.row', ctx.words)}</em></span>
    </li>`)}</ul>` : html`<p class="cap">${sayHtml(sec.rows.length ? 'inlets.dev.none' : 'inlets.dev.empty', ctx.words)}</p>`}
    <p class="fl-s-new"><button class="btn-link" type="button" data-action="app.sheet" data-sheet="inlet">+ ${sayHtml('inlets.dev.add', ctx.words)}</button></p>
    ${sec.archived.length ? html`<details class="fl-s-gone">
      <summary class="btn-link">${sayHtml('inlets.dev.archived', ctx.words)} · ${keep(String(sec.archived.length))}</summary>
      <ul class="rows rows-plain">${sec.archived.map((one) => html`<li class="row" data-key="${one.id}">
        <span class="row-label"><button class="btn-link fl-in-open" type="button" data-action="app.sheet" data-sheet="inlet" data-id="${one.id}">${nameOf(one)}</button> <span class="bk-tag fl-in-kind">${kindLabel(one.kind, ctx.words)}</span></span>
      </li>`)}</ul>
    </details>` : ''}
  </section>`;
}

/* ------------------------------------------------------------- the deposit's sheet */

/** Whether a move is money in that a source can hold: a posted bank deposit counted as income, or a reported payment. */
export function isMoneyInMove(tx) {
  if (!tx || tx.kind !== 'income' || tx.flow !== 'in') return false;
  if (tx.source === 'manual') return tx.via === 'income' && !!tx.income && !tx.matchId;
  return tx.source !== 'manual';
}

/** The source block of a deposit's sheet: where it is filed and how, and chips to change it, this one or all of its payer. */
export function txSourceBlock(ctx, tx) {
  if (!isMoneyInMove(tx)) return '';
  const look = lookOf(ctx.state);
  const filing = filingOf(look, tx);
  const inlets = look.inlets;
  const now = filing.to === WINDFALL ? phrase('inlets.windfalls', ctx.words) : filing.to ? nameOf(inlets.get(filing.to)) : phrase('inlets.unfiled', ctx.words);
  const how = filing.to ? say('inlets.tx.how.' + filing.how, ctx.words) : filing.left ? say('inlets.tx.left', ctx.words) : '';
  if (tx.pending) {
    return html`<div class="tx-in" data-key="source"><p class="row"><span class="row-label">${sayHtml('inlets.tx.source', ctx.words)}</span><span class="tx-v">${now}</span></p>
      <p class="cap">${sayHtml('inlets.tx.pending', ctx.words)}</p></div>`;
  }
  const keys = filing.keys;
  const allKind = keys.apps.length ? 'app' : keys.payer ? 'payer' : null;
  // one deposit is filed by its own key: a reported payment's, or a bank row's (a row the bank gave no fingerprint for,
  // as the sample's rows, can only be filed with its payer)
  const canOne = tx.source === 'manual' || !!keys.where;
  if (!canOne && !allKind) return html`<div class="tx-in" data-key="source"><p class="row"><span class="row-label">${sayHtml('inlets.tx.source', ctx.words)}${how ? html`<em class="row-note">${how}</em>` : ''}</span><span class="tx-v">${now}</span></p></div>`;
  // a catch-all bank deposit opens on This deposit only; a payment another app reported opens on All from this app (G.3:
  // its cash never reaches the bank, so never the queue)
  const catchAll = tx.source === 'manual' ? !keys.apps.length : isCatchAllIn(tx);
  const chosen = (ctx.ui.inScope && ctx.ui.inScope.id === tx.id) ? ctx.ui.inScope.scope : (catchAll || !allKind ? 'one' : 'all');
  const scope = !canOne ? 'all' : allKind ? chosen : 'one';
  // the queue's order, by the year's money then name (round 6), not the order of the sources' hidden ids
  const sources = chipOrder(ctx.state, ctx.now, { ledger: ctx.d && ctx.d.ledger, look });
  // Not yet filed only where it takes effect (G.3): a removal under a payer's, an app's or a rule's filing decides nothing
  const unfile = !filing.to || canUnfile(ctx.state, tx.id, scope);
  // a payer's filing on a deposit another app's payment pairs with: this sheet offers the app, not the payer (round 3)
  const keepWhy = filing.how === 'rule' ? 'rule' : scope === 'all' && filing.how === 'deposit' ? 'deposit'
    : filing.how === 'payer' && keys.apps.length ? 'payerApp' : filing.how || 'payer';
  const chip = (to, label, pressed) => html`<button class="chip" type="button" data-action="inlets.file-tx" data-id="${tx.id}" data-to="${to}" data-scope="${scope}" aria-pressed="${pressed ? 'true' : 'false'}">${label}</button>`;
  return html`<div class="tx-in" data-key="source">
    <p class="row"><span class="row-label">${sayHtml('inlets.tx.source', ctx.words)}${how ? html`<em class="row-note">${how}</em>` : ''}</span><span class="tx-v">${now}</span></p>
    ${allKind && canOne ? html`<div class="seg" role="radiogroup" aria-label="${say('inlets.tx.scope.aria', ctx.words)}" data-change="inlets.scope" data-id="${tx.id}">
      <label class="seg-opt"><input type="radio" name="in-scope" value="one" ${scope === 'one' ? html`checked` : ''}><span>${sayHtml('inlets.tx.scope.one', ctx.words)}</span></label>
      <label class="seg-opt"><input type="radio" name="in-scope" value="all" ${scope === 'all' ? html`checked` : ''}><span>${sayHtml(allKind === 'app' ? 'inlets.tx.scope.app' : 'inlets.tx.scope.payer', ctx.words)}</span></label>
    </div>` : ''}
    <div class="chips tx-in-chips" role="group" aria-label="${say('inlets.tx.source', ctx.words)}">
      ${sources.map((one) => chip(one.id, nameOf(one), filing.to === one.id))}
      ${chip(WINDFALL, phrase('inlets.windfalls', ctx.words), filing.to === WINDFALL)}
      ${unfile ? chip('none', phrase('inlets.unfiled', ctx.words), !filing.to) : ''}
    </div>
    ${unfile ? '' : html`<p class="cap tx-in-keep">${sayHtml('inlets.tx.keep.' + keepWhy, ctx.words)}</p>`}
  </div>`;
}

/* ------------------------------------------------------------------ actions */

function queueItem(ctx, key) {
  return depositQueue(ctx.state, ctx.now, { ledger: ctx.d.ledger }).items.find((one) => one.key === key) || null;
}

export const actions = {
  /** One tap on a deposit item: a source, Windfalls or Leave it, in one undoable update. */
  'inlets.file': ({ data }) => {
    const ctx = context();
    if (!ctx || !data || !data.key || !data.to) return;
    const item = queueItem(ctx, data.key);
    if (!item) return;
    const inlets = inletsOf(ctx.state);
    const to = data.to === WINDFALL || data.to === LEAVE ? data.to : inlets.has(data.to) ? data.to : null;
    if (!to) return;
    // a tap on a payer or an app left on an earlier day (round 11's Leave it again, round 12's filing): its Undo asks
    // again about every deposit of the item, and says so
    const words = phrase(to === LEAVE ? (item.leftBefore ? 'inlets.undo.leftAgain' : 'inlets.undo.left') : item.leftBefore ? 'inlets.undo.filedAgain' : 'inlets.undo.filed', ctx.words);
    const at = nowMs();
    const before = payBefore(ctx);
    let done = false;
    store.update((s) => { done = fileQueueItem(s, item, to, at); }, { undo: words });
    if (!done) { if (store.undoLabel === words) store.undo(); return; }
    store.setUi({ flNewIn: null });
    const name = to === WINDFALL ? phrase('inlets.windfalls', ctx.words) : to === LEAVE ? '' : nameOf(inlets.get(to));
    const merchant = item.merchant || phrase('inlets.unfiled', ctx.words);
    // round 11: Leave it on a payer or an app covers its deposits so far; a later one is asked about
    const message = to === LEAVE ? say(item.kind === 'one' ? 'inlets.toast.left' : 'inlets.toast.leftSoFar', ctx.words, { merchant }) : queueToast(ctx.words, { ...item, merchant }, name);
    toast(message + payNote(ctx, before, item.kind === 'payer' ? item.intoKey : null), { action: phrase('flows.undo', ctx.words), onAction: undoLast });
  },
  /** "New source…": the form under the item. */
  'inlets.new': ({ data }) => {
    if (!data || !data.key) return;
    store.setUi({ flNewIn: store.ui.flNewIn === data.key ? null : data.key });
  },
  'inlets.new-cancel': () => store.setUi({ flNewIn: null }),
  /** A new source named from the queue: made and filed within the same Undo. */
  'inlets.new-save': ({ data, values }) => {
    const ctx = context();
    if (!ctx || !data || !data.key) return;
    const item = queueItem(ctx, data.key);
    if (!item) return;
    const name = inletName(values && values.name);
    const kind = values && INLET_KINDS.includes(values.kind) ? values.kind : null;
    if (!name || !kind) { toast(say('inlet.toast.bad', ctx.words)); return; }
    if (!canMakeInlet(ctx.state)) { toast(say('inlets.toast.full', ctx.words, { n: INLETS_LIVE_MAX })); return; }
    const words = phrase(item.leftBefore ? 'inlets.undo.addAgain' : 'inlets.undo.add', ctx.words);
    const at = nowMs();
    const before = payBefore(ctx);
    let made = null;
    store.update((s) => { made = fileToNew(s, item, { name, kind }, at); }, { undo: words });
    if (!made) { if (store.undoLabel === words) store.undo(); return; }
    store.setUi({ flNewIn: null });
    toast(queueToast(ctx.words, item, name, true) + payNote(ctx, before, item.kind === 'payer' ? item.intoKey : null), { action: phrase('flows.undo', ctx.words), onAction: undoLast });
  },
  /** Add, Not now or Restore a suggested source. */
  'inlets.offer': ({ data }) => {
    const ctx = context();
    if (!ctx || !data || !data.key) return;
    const offers = suggestions(ctx.state, ctx.now, { ledger: ctx.d.ledger });
    const one = [...offers.shown, ...offers.dismissed].find((o) => o.key === data.key);
    if (!one) return;
    const act = data.to === 'add' ? 'add' : data.to === 'restore' ? 'restore' : 'not';
    if (act === 'add' && !canMakeInlet(ctx.state)) { toast(say('inlets.toast.full', ctx.words, { n: INLETS_LIVE_MAX })); return; }
    // Add on a payer or an app left on an earlier day: its Undo asks again about every deposit from them (round 12)
    const again = act === 'add' && leftEarlier(lookOf(ctx.state), one.intoKey, ctx.d && ctx.d.ledger ? ctx.d.ledger.today : null);
    const words = phrase(again ? 'inlets.undo.addAgain' : 'inlets.undo.' + act, ctx.words);
    const at = nowMs();
    const before = payBefore(ctx);
    let done = false;
    store.update((s) => {
      // Not now and Restore take every key of the suggestion (one payer's streams on two accounts, round 3)
      done = act === 'add' ? !!acceptOffer(s, one, at) : act === 'restore' ? restoreOffer(s, one.keys || one.key, at, [...offers.shown, ...offers.dismissed].flatMap((o) => o.keys || [o.key]))
        : dismissOffer(s, one.keys || one.key, at);
    }, { undo: words });
    if (!done) { if (store.undoLabel === words) store.undo(); return; }
    toast(say('inlets.toast.' + act, ctx.words, { name: one.name, kind: kindLabel(one.kind, ctx.words) }) + (act === 'add' ? payNote(ctx, before, one.intoKey) : ''), { action: phrase('flows.undo', ctx.words), onAction: undoLast });
  },
  /** The deposit's sheet: this deposit only, or all from its payer or app. */
  'inlets.scope': ({ ev, data }) => {
    const value = ev && ev.target ? ev.target.value : null;
    if (!data || !data.id || (value !== 'one' && value !== 'all')) return;
    store.setUi({ inScope: { id: data.id, scope: value } });
  },
  'inlets.file-tx': ({ data }) => {
    const ctx = context();
    if (!ctx || !data || !data.id || !data.to) return;
    const inlets = inletsOf(ctx.state);
    const to = data.to === 'none' ? null : data.to === WINDFALL ? WINDFALL : inlets.has(data.to) ? data.to : undefined;
    if (to === undefined) return;
    // unfiling is worded as such (round 2), never as a filing to Not yet filed; All from a payer or an app left on an
    // earlier day: its Undo asks again about every deposit from them (round 12), and says so
    const look = data.scope === 'all' ? lookOf(ctx.state) : null;
    const was = look ? ctx.state.txs.find((one) => one.id === data.id) : null;
    const keys = was ? keysOf(look, was) : null;
    const again = !!keys && leftEarlier(look, keys.apps[0] || keys.payer, ctx.d && ctx.d.ledger ? ctx.d.ledger.today : null);
    const words = phrase(to === null ? (again ? 'inlets.undo.unfiledAgain' : 'inlets.undo.unfiled') : again ? 'inlets.undo.filedAgain' : 'inlets.undo.filed', ctx.words);
    const at = nowMs();
    const before = payBefore(ctx);
    let done = false;
    store.update((s) => { done = fileDeposit(s, data.id, to, data.scope === 'all' ? 'all' : 'one', at); }, { undo: words });
    if (!done) { if (store.undoLabel === words) store.undo(); return; }
    // Not yet filed names where the deposit reads now: a built-in rule may still send it to Windfalls
    const after = to === null ? filingOf(lookOf(store.state), store.state.txs.find((one) => one.id === data.id) || {}) : null;
    const now = after ? after.to : to;
    const name = now === null || now === undefined ? phrase('inlets.unfiled', ctx.words) : now === WINDFALL ? phrase('inlets.windfalls', ctx.words) : nameOf(inletsOf(store.state).get(now));
    const tx = ctx.state.txs.find((one) => one.id === data.id);
    const merchant = (tx && (tx.merchant || tx.mkey)) || name;
    // under All from this app, the whole app was filed: the toast names it, never the payer (round 3)
    const app = data.scope === 'all' ? appNameOf(ctx.state, tx) : '';
    const key = to === null ? (data.scope === 'all' ? (app ? 'inlets.toast.unfiledApp' : 'inlets.toast.unfiled') : 'inlets.toast.unfiledOne')
      : data.scope === 'all' ? (app ? 'inlets.toast.filedApp' : 'inlets.toast.filed') : 'inlets.toast.filedOne';
    // under All from this payer the toast has named the payer: the pay it ends is "it" (round 5)
    const payer = data.scope === 'all' && !app && tx ? keysOf(lookOf(ctx.state), tx).payer : null;
    toast(say(key, ctx.words, { merchant, name, app }) + payNote(ctx, before, payer), { action: phrase('flows.undo', ctx.words), onAction: undoLast });
  },
  /** "It was money in": a wallet refund, this move only, as a correction that travels. */
  'flows.money-in': ({ data }) => {
    const ctx = context();
    if (!ctx || !data || !data.id) return;
    const tx = ctx.state.txs.find((one) => one.id === data.id);
    if (!tx) return;
    const words = phrase('flows.undo.moneyIn', ctx.words);
    const at = nowMs();
    let done = false;
    store.update((s) => { done = moneyInMove(s, data.id, at); }, { undo: words });
    if (!done) { if (store.undoLabel === words) store.undo(); return; }
    toast(say('flows.toast.moneyIn', ctx.words, { merchant: tx.merchant || tx.mkey || '' }), { action: phrase('flows.undo', ctx.words), onAction: undoLast });
  },
};
