/**
 * The day sheet: one round as it stands, and the few things the owner may say about the day.
 * Opened with app.sheet (data-sheet="day" data-day="YYYY-MM-DD"); without a day it shows today.
 *
 *   the round        habit, spent, kept, the lines, how final it is, the round's annotation
 *   the day type     "play this day with Black / White" — overrides the weekday default (saved on tap, with undo)
 *   a bye            a half-point bye, declared ahead: only for today before any convenience purchase, or a
 *                    later day; at most settings.byesPerMonth in a month, counted from state.days
 *   the plan         today's morning plan as it stands, with a link to the plan sheet (edited there)
 *   a note           saved with Done
 *   money in and out the nightly wrap's figure for the day (model/wrap.js wrapDay): what counted, what did not and why,
 *                    and for today or a day in pencil what may still be missing (ARCHITECTURE 3.10)
 *
 * Cover mode: the sheet body carries data-cover itself (the sheet host is outside the covered page).
 *
 * Actions: day.type (change) · day.bye · day.note (submit)
 */

import { html, cx, attrs } from '../ui/dom.js';
import { fmt, fmtSigned } from '../model/money.js';
import { fmtDate, fmtMonth, fmtTime, addDays, monthOf, dow, isYmd } from '../model/dates.js';
import { habitFor } from '../model/ledger.js';
import { moveGlyph, resultMark } from '../ui/glyphs.js';
import { icon } from '../ui/icons.js';
import { store } from '../store.js';
import { closeSheet } from '../router.js';
import { context, toast } from '../runtime.js';
import { statusLine, inlineMoney, spentUnposted, txName } from './parts.js';
import { wrapDay } from '../model/wrap.js';
import { sayHtml } from '../ui/say.js';
import { phrase, say } from '../model/words.js';
import { NOTE_MAX as GAME_NOTE_MAX } from '../model/game.js';

/** The longest note: what the shared file carries of a day's note (model/game.js), so the sheet keeps no copy of its own. */
const NOTE_MAX = GAME_NOTE_MAX;
const DAYS_AHEAD = 14;
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
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

function dayOf(ctx, params) {
  return params && isYmd(params.day) ? params.day : ctx.today;
}

function defaultType(state, day) {
  const workdays = Array.isArray(state.settings.workdays) ? state.settings.workdays : [];
  return workdays.includes(dow(day)) ? 'work' : 'off';
}

function firstDayOnRecord(state) {
  let first = null;
  for (const tx of state.txs) if (typeof tx.day === 'string' && tx.day && (first === null || tx.day < first)) first = tx.day;
  return first;
}

/** Convenience purchases already on the day's sheet (bank rows and tapped-in moves that still count). */
function gameMoves(round) {
  return round.moves.filter((tx) => tx.kind === 'spend' && tx.klass === 'game' && !tx.matchId).length;
}

/**
 * Where the month's byes stand for a day, counted from state.days.
 * open = a bye may be declared or withdrawn for this day (today before any convenience purchase, or a later day).
 */
function byeState(ctx, day, round) {
  const allowed = Math.max(0, Math.round(Number(ctx.state.settings.byesPerMonth) || 0));
  const ym = monthOf(day);
  const taken = Object.keys(ctx.state.days).filter((d) => monthOf(d) === ym && ctx.state.days[d] && ctx.state.days[d].bye).sort();
  const declared = taken.includes(day);
  const played = day === ctx.today ? gameMoves(round) : 0;
  const open = !!ctx.state.meta.matchStart && (day > ctx.today || (day === ctx.today && played === 0));
  return { allowed, taken, declared, remaining: Math.max(0, allowed - taken.length), open, played };
}

function undoLast() {
  const label = store.undo();
  if (label) toast('Undone: ' + String(label).replace(/[.]+$/, '') + '.');
}

export function label(ctx, params) {
  return say('day.sheet', ctx.words, { date: fmtDate(dayOf(ctx, params), 'long') });
}

/* ------------------------------------------------------------------ render */

export function render(ctx, params) {
  const day = dayOf(ctx, params);
  const round = ctx.d.round(day);
  const record = ctx.state.days[day] || {};
  const matchOn = !!ctx.state.meta.matchStart;
  const prematch = round.status === 'prematch';
  const first = firstDayOnRecord(ctx.state);
  const prev = first && day > first ? addDays(day, -1) : null;
  const next = day < addDays(ctx.today, DAYS_AHEAD) ? addDays(day, 1) : null;
  const dayLink = (to, before) => html`<button class="btn-link" type="button" data-action="app.sheet" data-sheet="day" data-day="${to}">${before ? icon('chevron-left') : ''}${fmtDate(to, 'dowshort')}${before ? '' : icon('chevron-right')}</button>`;

  return html`<form class="sheet-body dy-form" data-key="${'day-' + day}" data-submit="day.note" data-day="${day}" novalidate ${attrs({ 'data-cover': !!ctx.state.settings.cover })}>
    <p class="sheet-head lab"><b>${prematch || !matchOn ? 'Day' : say('day.round', ctx.words, { n: round.n })}</b><i class="sep"></i>${fmtDate(day, 'long')}</p>
    <h2 class="sheet-title">${titleOf(ctx, round)}</h2>
    <nav class="dy-days" aria-label="Other days">${prev ? dayLink(prev, true) : html`<span></span>`}${next ? dayLink(next, false) : ''}</nav>
    ${standing(ctx, round, matchOn)}
    ${typeField(ctx, day, round)}
    ${byeBlock(ctx, day, round)}
    ${planBlock(ctx, day, round, record)}
    ${wrapBlock(ctx, day)}
    <label class="field">
      <span class="field-label lab">Note</span>
      <textarea class="textarea dy-note" name="note" rows="2" maxlength="${NOTE_MAX}" placeholder="${say('day.note.placeholder', ctx.words)}">${record.note || ''}</textarea>
    </label>
    <div class="sheet-actions"><button class="btn btn-solid" type="submit">Done</button></div>
  </form>`;
}

function titleOf(ctx, round) {
  // a round in pencil or in progress states its margin as an estimate, as the tally below does
  const est = round.status === 'live' || round.status === 'provisional';
  const w = ctx.words;
  const over = sayHtml('day.over', w, { amount: inlineMoney(-round.kept, { est }) });
  const kept = sayHtml('day.kept', w, { amount: inlineMoney(round.kept, { est, signed: true }) });
  switch (round.status) {
    case 'future': return round.bye ? phrase('day.title.byeAhead', w) : phrase('day.title.future', w);
    case 'awaiting': return 'Awaiting the bank.';
    case 'live': return round.bye ? phrase('day.title.byeLive', w) : html`In progress: ${round.kept >= 0 ? kept : over} so far.`;
    case 'prematch': return ctx.state.meta.matchStart ? phrase('day.title.before', w) : phrase('day.title.notBegun', w);
    default: {
      if (round.result == null) return 'No result.';
      const word = phrase(round.bye ? 'day.title.bye' : round.result === 1 ? 'day.title.win' : round.result === 0 ? 'day.title.loss' : 'day.title.draw', w);
      return html`${word}: ${round.kept >= 0 ? kept : over}.`;
    }
  }
}

/* ------------------------------------------------------- the round as it stands */

function standing(ctx, round, matchOn) {
  const s = round.status;
  const dayWord = round.type === 'work' ? 'a workday' : 'a day off';
  if (!round.habit) {
    return html`<div class="dy-standing">
      <p class="cap">${matchOn
        ? phrase('day.noHabit', ctx.words)
        : say('day.notBegun', ctx.words, { day: ctx.d.matchFromDay, days: ctx.d.historyDays })}
        ${s === 'future' ? '' : html`Convenience spending on ${fmtDate(round.day, 'short')}: ${inlineMoney(round.conv, { est: spentUnposted(round) })}.`}</p>
    </div>`;
  }
  const pencil = s !== 'final';
  const ann = s === 'prematch' ? null : ctx.d.annotations(round.day).round;
  const stops = round.stops === 1 ? '1 stop' : round.stops + ' stops';
  const played = s !== 'future' && s !== 'awaiting';
  return html`<div class="dy-standing">
    <div class="tally tally-s">
      <div class="tally-item"><span class="lab">${sayHtml('day.habit', ctx.words)}</span><span class="fig">${fmt(round.habit)}</span><span class="cap">on ${dayWord}</span></div>
      <div class="tally-item"><span class="lab">Spent</span><span class="${cx('fig', played && spentUnposted(round) && 'est')}">${played ? html`${spentUnposted(round) ? html`<span class="approx">≈</span>` : ''}${fmt(round.conv)}` : '—'}</span><span class="cap">${played ? stops : s === 'awaiting' ? 'not reported' : phrase('day.future', ctx.words)}</span></div>
      <div class="tally-item"><span class="lab">${phrase(s === 'live' ? 'day.standing' : 'day.keptLabel', ctx.words)}</span><span class="${cx('fig', pencil && 'est')}">${played ? html`${pencil ? html`<span class="approx">≈</span>` : ''}${fmtSigned(round.kept)}` : '—'}</span><span class="cap">${s === 'live' ? 'so far' : s === 'final' ? 'final' : s === 'provisional' ? phrase('day.inPencil', ctx.words) : s === 'prematch' ? 'not counted' : ''}</span></div>
    </div>
    ${played ? html`<figure class="split dy-split">
      <figcaption class="split-labs"><span class="lab"><b>${sayHtml('day.keptLabel', ctx.words)}</b></span><span class="lab"><b>Spent</b></span></figcaption>
      <nw-split data-island slim a="${Math.max(0, round.kept)}" b="${round.conv}"></nw-split>
    </figure>` : ''}
    <p class="dy-lines">
      <span class="dy-mark">${resultMark(round.result, s, { glyph: ann ? ann.glyph : null, words: ctx.words })}</span>
      <span class="cap">${sayHtml('day.lines', ctx.words, { win: html`<span data-fig>${fmt(round.winLine)}</span>`, loss: html`<span data-fig>${fmt(round.lossLine)}</span>` })} ${statusLine(round, ctx.words)}</span>
    </p>
    ${ann ? html`<p class="cap dy-ann">${moveGlyph(ann.glyph, { words: ctx.words })} ${figured(ann.why)}.</p>` : ''}
  </div>`;
}

/* ------------------------------------------------------------ the day type */

function typeField(ctx, day, round) {
  const lines = habitFor(ctx.state, day);
  const seg = lines.segment;
  const def = defaultType(ctx.state, day);
  const usual = WEEKDAYS[dow(day)] + ' are ' + (def === 'work' ? 'workdays' : 'days off') + ' by default.';
  return html`<fieldset class="field">
    <legend class="field-label lab">${sayHtml('day.playWith', ctx.words)}</legend>
    <div class="seg seg-block" role="radiogroup" aria-label="${say('day.playWith', ctx.words)}">
      <label class="seg-opt"><input type="radio" name="type" value="work" data-change="day.type" ${round.type === 'work' ? html`checked` : ''}><span>${sayHtml('day.black', ctx.words)}</span></label>
      <label class="seg-opt"><input type="radio" name="type" value="off" data-change="day.type" ${round.type === 'off' ? html`checked` : ''}><span>${sayHtml('day.white', ctx.words)}</span></label>
    </div>
    <p class="field-help cap">${seg
      ? html`${sayHtml('day.habitPlays', ctx.words, { work: html`<span data-fig>${fmt(seg.work)}</span>`, off: html`<span data-fig>${fmt(seg.off)}</span>` })} ${usual}`
      : usual}${round.type !== def ? ' This day is set by hand.' : ''}</p>
  </fieldset>`;
}

/* ------------------------------------------------------------------ a bye */

function byeBlock(ctx, day, round) {
  const bye = byeState(ctx, day, round);
  const month = fmtMonth(monthOf(day), 'name');
  const count = html`<i data-cover-keep>${bye.remaining}</i> of ${bye.allowed} ${phrase(bye.allowed === 1 ? 'day.byes.remain.one' : 'day.byes.remain.many', ctx.words)} in ${month}`;
  let line;
  let button = '';
  if (!ctx.state.meta.matchStart) {
    line = say('day.byes.begin', ctx.words, { n: bye.allowed });
  } else if (bye.declared) {
    if (bye.open) {
      line = sayHtml('day.bye.declared', ctx.words, { count });
      button = html`<button class="btn btn-s" type="button" data-action="day.bye" data-day="${day}" data-set="off">${sayHtml('day.bye.withdraw', ctx.words)}</button>`;
    } else {
      line = sayHtml('day.bye.played', ctx.words, { count });
    }
  } else if (bye.open && bye.remaining > 0) {
    line = sayHtml('day.bye.scores', ctx.words, { count });
    button = html`<button class="btn btn-s" type="button" data-action="day.bye" data-day="${day}" data-set="on">${sayHtml('day.bye.take', ctx.words)}</button>`;
  } else if (bye.open) {
    line = say(bye.allowed === 1 ? 'day.bye.used.one' : 'day.bye.used.many', ctx.words, { n: bye.allowed, month, taken: bye.taken.length ? ' (' + bye.taken.map((d) => fmtDate(d, 'short')).join(', ') + ')' : '' });
  } else if (day === ctx.today) {
    line = sayHtml('day.bye.before', ctx.words, { already: bye.played === 1 ? 'one is' : bye.played + ' are', count });
  } else {
    line = sayHtml('day.bye.ahead', ctx.words, { count });
  }
  return html`<div class="dy-block">
    <p class="lab"><b>${sayHtml('day.bye.title', ctx.words)}</b></p>
    <p class="cap">${line}</p>
    ${button ? html`<p class="dy-block-action">${button}</p>` : ''}
  </div>`;
}

/* ---------------------------------------------------------------- the plan */

function planWords(plan) {
  const bits = [];
  if (plan.container != null) bits.push(plan.container ? 'container filled' : 'no container');
  if (plan.breakfast != null) bits.push(plan.breakfast ? 'breakfast sorted' : 'no breakfast');
  if (plan.stops != null) bits.push(plan.stops === 0 ? 'no planned stop' : plan.stops === 1 ? '1 planned stop' : plan.stops + ' planned stops');
  return bits.join(' · ');
}

function planBlock(ctx, day, round, record) {
  const isToday = day === ctx.today;
  if (!isToday && !round.plan) return '';
  const at = record.plan && Number.isFinite(record.plan.at) ? record.plan.at : null;
  const words = round.plan ? planWords(round.plan) : '';
  return html`<div class="dy-block">
    <p class="lab"><b>Morning plan</b></p>
    <p class="cap">${round.plan
      ? html`${words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Set'}${at ? ', set at ' + fmtTime(at) : ''}.${sayHtml('day.plan.bookMove', ctx.words)}`
      : html`No plan is set for ${fmtDate(day, 'short')}. Three taps: container, breakfast, planned stops.`}</p>
    ${isToday ? html`<p class="dy-block-action"><button class="btn-link" type="button" data-action="app.sheet" data-sheet="plan">${round.plan ? 'Change the plan' : phrase('day.plan.open', ctx.words)}</button></p>` : ''}
  </div>`;
}

/* ------------------------------------------------------------ money in and out */

/** The nightly wrap's figure for the day: in, out and net, each move that counted and each that did not, with why. */
function wrapBlock(ctx, day) {
  const fig = wrapDay(ctx.state, ctx.now, day);
  if (fig.status === 'future') return '';
  const w = ctx.words;
  const est = fig.status !== 'final';
  const kind = (c) => phrase(c.way === 'in' ? 'wrap.day.kind.in' : c.way === 'back' ? 'wrap.day.kind.back' : c.sent ? 'wrap.day.kind.sent' : 'wrap.day.kind.out', w);
  const signed = (c) => (c.way === 'out' ? -c.amount : c.amount);
  const missing = fig.status === 'live' ? 'wrap.day.missing.live' : fig.status === 'provisional' || fig.status === 'awaiting' ? 'wrap.day.missing.pencil' : null;
  return html`<div class="dy-block dy-wrap">
    <p class="lab"><b>Money in and out</b></p>
    <p class="cap">${phrase('wrap.day.lede', w)}</p>
    <div class="tally tally-s">
      <div class="tally-item"><span class="lab">In</span><span class="${cx('fig', est && 'est')}" data-fig>${est ? html`<span class="approx">≈</span>` : ''}${fmt(fig.in)}</span></div>
      <div class="tally-item"><span class="lab">Out</span><span class="${cx('fig', est && 'est')}" data-fig>${est ? html`<span class="approx">≈</span>` : ''}${fmt(fig.out)}</span></div>
      <div class="tally-item"><span class="lab">Net</span><span class="${cx('fig', est && 'est')}" data-fig>${est ? html`<span class="approx">≈</span>` : ''}${fmtSigned(fig.in - fig.out)}</span></div>
    </div>
    ${fig.counted.length ? html`<p class="lab dy-wrap-sub">${phrase('wrap.day.counted', w)}</p>
    <ul class="rows dy-wrap-rows">${fig.counted.map((c) => html`<li class="row">
      <span class="row-label">${txName(c.tx)} <em class="row-note">${kind(c)}</em></span>
      <span class="row-value">${inlineMoney(signed(c), { signed: true })}</span>
    </li>`)}</ul>` : html`<p class="cap">${phrase('wrap.day.none', w)}</p>`}
    ${fig.left.length ? html`<p class="lab dy-wrap-sub">${phrase('wrap.day.left', w)}</p>
    <ul class="rows dy-wrap-rows">${fig.left.map((l) => html`<li class="row">
      <span class="row-label">${txName(l.tx)} <em class="row-note">${phrase(l.why === 'payment' ? 'wrap.day.why.payment' : 'wrap.day.why.own', w)}</em></span>
      <span class="row-value">${inlineMoney(l.amount)}</span>
    </li>`)}</ul>` : ''}
    ${missing ? html`<p class="cap dy-wrap-missing">${phrase(missing, w)}</p>` : ''}
  </div>`;
}

/* ----------------------------------------------------------------- actions */

/** Write into a day's record and drop the record when nothing is left in it. */
function editDay(state, day, edit) {
  const record = state.days[day] || (state.days[day] = {});
  edit(record);
  if (!Object.keys(record).length) delete state.days[day];
}

export const actions = {
  /** Play the day with Black (a workday) or White (a day off); the weekday default is stored as no override. */
  'day.type': ({ el }) => {
    const ctx = context();
    const form = el.form;
    const day = form && isYmd(form.dataset.day) ? form.dataset.day : null;
    const type = el.value === 'off' ? 'off' : 'work';
    if (!ctx || !day || ctx.d.round(day).type === type) return;
    store.update((s) => {
      editDay(s, day, (record) => {
        if (type === defaultType(s, day)) delete record.type;
        else record.type = type;
      });
    }, { undo: 'Day type changed' });
    toast(say(type === 'work' ? 'day.toast.type.work' : 'day.toast.type.off', ctx.words, { day: fmtDate(day, 'dowshort') }), { action: 'Undo', onAction: undoLast });
  },
  /** Declare or withdraw a half-point bye, within the rules (checked again here, not trusted from the markup). */
  'day.bye': ({ data }) => {
    const ctx = context();
    const day = isYmd(data.day) ? data.day : null;
    if (!ctx || !day) return;
    const bye = byeState(ctx, day, ctx.d.round(day));
    const on = data.set === 'on';
    if (!bye.open || on === bye.declared || (on && bye.remaining < 1)) return;
    store.update((s) => {
      editDay(s, day, (record) => {
        if (on) record.bye = true;
        else delete record.bye;
      });
    }, { undo: phrase(on ? 'day.undo.byeOn' : 'day.undo.byeOff', ctx.words) });
    toast(say(on ? 'day.toast.byeOn' : 'day.toast.byeOff', ctx.words, { day: fmtDate(day, 'dowshort') }), { action: 'Undo', onAction: undoLast });
  },
  /** Done: save the note when it changed, then close. */
  'day.note': ({ values, data }) => {
    const ctx = context();
    const day = isYmd(data.day) ? data.day : null;
    if (ctx && day && values) {
      const note = String(values.note || '').trim().slice(0, NOTE_MAX);
      const before = (ctx.state.days[day] && ctx.state.days[day].note) || '';
      if (note !== before) {
        store.update((s) => {
          editDay(s, day, (record) => {
            if (note) record.note = note;
            else delete record.note;
          });
        }, { undo: 'Note changed' });
      }
    }
    closeSheet();
  },
};
