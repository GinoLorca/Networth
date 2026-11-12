/**
 * The sweep sheet — the open suggestion (ctx.d.edge.sweep): what last week kept against habit,
 * in whole dollars, to be moved to the card (or to the reserve when no card is owed).
 * Networth never moves money; the owner does, and says so here — or the bank feed says it for them.
 *
 *   I moved it      records { weekOf, amount, day, txId: null, via: 'tap' } in state.sweeps
 *   Not this week   records the week with amount 0, so it is not offered again
 * With no open suggestion the sheet shows why, and the record of sweeps so far.
 *
 * Actions
 *   sweep.moved    record the sweep as moved, close, "Sweep recorded …" with Undo
 *   sweep.skip     record the week with amount 0, close, "… set aside" with Undo
 *   sweep.reopen   take back a week that was tapped in or set aside here: the suggestion returns
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { closeSheet, onRoute } from '../router.js';
import { fmt } from '../model/money.js';
import { addDays, weekStart, gameDay, relDay, fmtDate, fmtTime } from '../model/dates.js';
import { accountLabel } from '../model/schema.js';
import { money } from './parts.js';

export const label = 'Move what you kept';

const SHEET = 'sweep';
const WEEK_DAYS = 7;
/** A card payment or reserve transfer of this share of the amount is recorded by the feed itself (ARCHITECTURE 4.8). */
const AUTO_SHARE = 0.9;
const MINIMUM_CENTS = 500;
const HISTORY_ROWS = 6;

function fig(cents) {
  return html`<span data-fig>${fmt(cents)}</span>`;
}

/** What a Monday-to-Sunday week kept against habit, to the cent: its rounds that count, since the match began. */
function keptInWeek(ctx, weekOf) {
  const start = ctx.state.meta.matchStart;
  let kept = 0;
  let rounds = 0;
  let pencil = false;
  for (let i = 0; i < WEEK_DAYS; i++) {
    const day = addDays(weekOf, i);
    if (!start || day < start || day >= ctx.today) continue;
    const round = ctx.d.round(day);
    if (round.result === null || round.status === 'prematch') continue;
    kept += round.kept;
    rounds += 1;
    if (round.status === 'provisional' || round.status === 'live') pencil = true;
  }
  // a total of final rounds is the bank's own figure (roman); one with a round in pencil is an estimate
  return { kept, rounds, pencil };
}

/** A week's kept total inside a sentence: with the approximately sign only while a round in it is in pencil. */
function keptFig(cents, est, asFig = false) {
  return html`<span data-fig class="${cx(asFig && 'fig', est && 'est')}">${est ? html`<span class="approx">≈</span>` : ''}${fmt(cents)}</span>`;
}

/** True while a counted round of the last week (the only ones that can still be in pencil) is not final. */
function recentPencil(ctx) {
  const start = ctx.state.meta.matchStart;
  for (let i = 0; i <= WEEK_DAYS; i++) {
    const day = addDays(ctx.today, -i);
    if (!start || day < start) break;
    const round = ctx.d.round(day);
    if (round.result !== null && (round.status === 'provisional' || round.status === 'live')) return true;
  }
  return false;
}

/** How old a bank figure is, in the words of the masthead: "from 6:12 AM", "from yesterday, 9:40 PM", "from Jun 8". */
function ageOf(ctx, at) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const day = gameDay(at, ctx.state.settings.rolloverHour);
  if (day === ctx.today) return 'from ' + fmtTime(at);
  if (relDay(day, ctx.today) === 'yesterday') return 'from yesterday, ' + fmtTime(at);
  return 'from ' + fmtDate(day, 'short');
}

/** Where the sweep goes: the card owed the most, or the reserve account. null when the document has neither. */
function destination(ctx, target) {
  if (target === 'card') {
    const owing = ctx.d.cardsNow.cards.filter((card) => card.owed > 0).sort((a, b) => b.owed - a.owed);
    const account = owing.length ? ctx.d.account(owing[0].id) : null;
    if (account) return { kind: 'card', account, name: owing[0].label, now: owing[0].owed, several: owing.length > 1 };
  }
  const cash = ctx.d.accounts('cash');
  const account = cash.find((a) => a.reserve) || null;
  if (account) return { kind: 'reserve', account, name: accountLabel(account), now: ctx.d.valueOf(account), several: false };
  return null;
}

/* ------------------------------------------------------------------ views */

function ledgerLine(ctx) {
  const edge = ctx.d.edge;
  const start = ctx.state.meta.matchStart;
  return html`<p class="cap sw-ledger">Since the match began on ${fmtDate(start, 'short')}: ${keptFig(edge.kept, recentPencil(ctx), true)} kept against habit, ${fig(edge.moved)} of it moved.</p>`;
}

function openView(ctx, sweep) {
  const cover = !!ctx.state.settings.cover;
  const week = keptInWeek(ctx, sweep.weekOf);
  const dest = destination(ctx, sweep.target);
  const lastDay = addDays(sweep.weekOf, 2 * WEEK_DAYS - 1);
  const where = !dest ? (sweep.target === 'card' ? 'the card' : 'the reserve') : dest.kind === 'card' ? 'the ' + dest.name : dest.name + ', the reserve';
  const after = dest ? (dest.kind === 'card' ? dest.now - sweep.amount : dest.now + sweep.amount) : null;
  return html`<div class="sheet-body sw"${attrs({ 'data-cover': cover })}>
    <p class="sheet-head lab"><b>Sweep</b><i class="sep"></i>week of ${fmtDate(sweep.weekOf, 'short')}</p>
    <h2 class="sheet-title">Last week you kept ${keptFig(week.kept, week.pencil)} against habit.</h2>
    <p class="sw-ask">Move ${money(sweep.amount, { size: 's', decimals: 0 })} to ${where}. Kept money that is not moved gets absorbed.</p>
    ${dest ? html`<ul class="rows">
      <li class="row" data-key="now">
        <span class="row-label">${dest.kind === 'card' ? 'Card balance today' : 'Reserve today'} <em class="row-note">${dest.name}${ageOf(ctx, dest.account.asOf) ? ' · ' + ageOf(ctx, dest.account.asOf) : ''}${dest.several ? ' · the card owed the most' : ''}</em></span>
        <span class="row-value fig">${fmt(dest.now)}</span>
      </li>
      <li class="row" data-key="after">
        <span class="row-label">After the sweep <em class="row-note">once the bank reports it</em></span>
        <span class="row-value">${money(after, { est: true })}</span>
      </li>
    </ul>` : ''}
    <p class="cap">Networth does not move money: make the ${sweep.target === 'card' ? 'payment' : 'transfer'} in the bank’s own app. A ${sweep.target === 'card' ? 'card payment' : 'transfer to the reserve'} of ${fig(Math.ceil(sweep.amount * AUTO_SHARE))} or more that posts by ${fmtDate(lastDay, 'dowshort')} is recorded by itself.</p>
    ${ledgerLine(ctx)}
    <div class="sheet-actions sheet-actions-stack">
      <button class="btn btn-solid" type="button" data-action="sweep.moved">I moved it</button>
      <button class="btn" type="button" data-action="sweep.skip">Not this week</button>
    </div>
  </div>`;
}

/** A week recorded by a tap on this sheet (not by a payment seen in the feed). */
function isTapped(sweep) {
  return !!sweep && sweep.via === 'tap' && sweep.txId == null;
}

function viaWords(sweep) {
  if (!(sweep.amount > 0)) return 'set aside';
  return sweep.via === 'auto' ? 'seen at the bank' : 'tapped in';
}

/** No open suggestion: say why, with the week's own figure, and show the record. */
function restView(ctx) {
  const cover = !!ctx.state.settings.cover;
  const started = !!ctx.state.meta.matchStart;
  const lastWeek = addDays(weekStart(ctx.today), -WEEK_DAYS);
  const nextMonday = addDays(weekStart(ctx.today), WEEK_DAYS);
  const sweeps = ctx.state.sweeps.filter((s) => s && typeof s.weekOf === 'string');
  const mine = sweeps.find((s) => s.weekOf === lastWeek) || null;
  const tapped = !!mine && isTapped(mine);
  let why;
  if (!started) {
    why = html`The match has not begun, so nothing has been kept against habit yet. Once it has, each Monday offers the week before when it kept ${fmt(MINIMUM_CENTS, { decimals: 0 })} or more.`;
  } else if (mine && mine.amount > 0) {
    why = html`The week of ${fmtDate(lastWeek, 'short')} is recorded: ${fig(mine.amount)} moved on ${fmtDate(mine.day, 'short')}, ${viaWords(mine)}. The next week is offered on ${fmtDate(nextMonday, 'dowshort')}.`;
  } else if (mine) {
    why = html`The week of ${fmtDate(lastWeek, 'short')} was set aside on ${fmtDate(mine.day, 'short')}. The next week is offered on ${fmtDate(nextMonday, 'dowshort')}.`;
  } else {
    const week = keptInWeek(ctx, lastWeek);
    why = week.rounds
      ? html`The week of ${fmtDate(lastWeek, 'short')} kept ${keptFig(week.kept, week.pencil)} against habit; a sweep is offered from ${fmt(MINIMUM_CENTS, { decimals: 0 })}. The next week is offered on ${fmtDate(nextMonday, 'dowshort')}.`
      : html`No round of the week of ${fmtDate(lastWeek, 'short')} counts yet. A week is offered on the Monday after it when it kept ${fmt(MINIMUM_CENTS, { decimals: 0 })} or more: next on ${fmtDate(nextMonday, 'dowshort')}.`;
  }
  const history = sweeps.slice().sort((a, b) => (a.weekOf < b.weekOf ? 1 : a.weekOf > b.weekOf ? -1 : 0)).slice(0, HISTORY_ROWS);
  return html`<div class="sheet-body sw"${attrs({ 'data-cover': cover })}>
    <p class="sheet-head lab"><b>Sweep</b><i class="sep"></i>${fmtDate(ctx.today, 'dowshort')}</p>
    <h2 class="sheet-title">Nothing to move this week.</h2>
    <p>${why}</p>
    ${tapped ? html`<p class="sw-aside"><button class="btn-link" type="button" data-action="sweep.reopen">Open the week again</button><span class="cap">Removes the record of ${fmtDate(mine.day, 'short')}; nothing else changes.</span></p>` : ''}
    ${started ? ledgerLine(ctx) : ''}
    ${history.length ? html`<section class="rows-group">
      <h3 class="rows-title lab"><b>Sweeps so far</b> <span class="rows-title-note">${history.length === sweeps.length ? sweeps.length : 'latest ' + history.length + ' of ' + sweeps.length}</span></h3>
      <ul class="rows">
        ${history.map((s) => html`<li class="row" data-key="${s.weekOf}">
          <span class="row-label">Week of ${fmtDate(s.weekOf, 'short')} <em class="row-note">${fmtDate(s.day, 'short')} · ${viaWords(s)}</em></span>
          <span class="row-value fig">${s.amount > 0 ? fmt(s.amount) : '—'}</span>
        </li>`)}
      </ul>
    </section>` : ''}
    <div class="sheet-actions">
      <button class="btn" type="button" data-action="app.sheet-close">Close</button>
    </div>
  </div>`;
}

export function render(ctx, params) {
  const sweep = ctx.d.edge.sweep;
  return sweep ? openView(ctx, sweep) : restView(ctx);
}

/* ---------------------------------------------------------------- actions */

let afterClose = null;

/** Close the sheet, then run `fn` once it has gone, so the record never redraws the sheet on its way out. */
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

function removeTapped(state, weekOf) {
  const i = state.sweeps.findIndex((x) => x && x.weekOf === weekOf && isTapped(x));
  if (i >= 0) state.sweeps.splice(i, 1);
  return i >= 0;
}

/** Record the open week (with its amount, or 0 for "not this week") and offer to take it back. */
function record(amountOf, message) {
  const ctx = context();
  const sweep = ctx.d.edge.sweep;
  if (!sweep) { closeSheet(); return; }
  const entry = { weekOf: sweep.weekOf, amount: amountOf(sweep), day: ctx.today, txId: null, via: 'tap' };
  closeThen(() => {
    store.update((s) => {
      if (!s.sweeps.some((x) => x && x.weekOf === entry.weekOf)) s.sweeps.push(entry);
    });
    toast(message(entry), {
      action: 'Undo',
      onAction: () => {
        store.update((s) => {
          removeTapped(s, entry.weekOf);
        });
        toast('The week of ' + fmtDate(entry.weekOf, 'short') + ' is open again.');
      },
    });
  });
}

export const actions = {
  'sweep.moved': () => record((sweep) => sweep.amount, (entry) => 'Sweep recorded for the week of ' + fmtDate(entry.weekOf, 'short') + '.'),
  'sweep.skip': () => record(() => 0, (entry) => 'The week of ' + fmtDate(entry.weekOf, 'short') + ' is set aside.'),
  'sweep.reopen': () => {
    const ctx = context();
    const weekOf = addDays(weekStart(ctx.today), -WEEK_DAYS);
    store.update((s) => { removeTapped(s, weekOf); });
  },
};
