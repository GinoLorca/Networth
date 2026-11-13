/**
 * Analysis — goals and variations.
 *
 * What looks back is measured (the pace, retention, where the money went, income received) and is
 * set as the rest of the app sets it: roman when it is the bank's figure, italic with the
 * approximately sign when Networth worked it out. What looks forward is a SCENARIO, labelled so and
 * always italic: the reserve dates, the card payoff, the net-worth lines, the purchase tool.
 *
 * Sections: the abstract (three figures) · Reserve · Cards · Retention · Scenario · Income ladder ·
 * Where it went · Before a larger purchase · The opponent (opens the habit sheet).
 *
 * The scenario inputs are small fields set in place. Each saves to the document on change
 * (`analysis.set`, `analysis.pay`, `analysis.target`) and the page re-renders. The purchase tool
 * records nothing: its inputs live in `ui.anBuy` only.
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { fmt, fmtSigned, fmtPlain, fmtPct, toCents } from '../model/money.js';
import { addDays, addMonthsYm, diffDays, endOfMonth, fmtDate, fmtMonth, fmtTime, gameDay, monthOf } from '../model/dates.js';
import { CATEGORIES, KLASSES, STREAM_KINDS, accountLabel, categoryLabel } from '../model/schema.js';
import { retention } from '../model/ledger.js';
import { purchaseImpact } from '../model/forecast.js';
import { payoff } from '../model/loans.js';
import { firstTransactionDay } from '../model/cards.js';
import { money } from './parts.js';

const PACE_DAYS = 30;
const RETENTION_MONTHS_BACK = 3;
const HORIZONS = [12, 24, 36, 60, 120];
const QUICK_PAYMENTS = [10000, 20000, 30000, 50000];
const QUICK_PURCHASES = [25000, 65000, 150000];
const KLASS_ORDER = ['game', 'want', 'need', 'oneoff', 'book'];
const KLASS_NOTES = { game: 'the daily game', want: 'judged by the month', need: '', oneoff: '', book: 'recurring bills' };
const RUNG_TITLES = ['GM', 'IM', 'FM', 'CM'];
/** Limits on what a field accepts; anything outside is put back as it was. */
const MAX_MONEY = 100000000000;
const MAX_HORIZON = 600;

/* ----------------------------------------------------------------- helpers */

/** An amount inside a sentence, where the redaction rule can find it. */
function amt(cents, opts = {}) {
  const text = opts.signed ? fmtSigned(cents, { decimals: opts.decimals ?? 2 }) : fmt(cents, { decimals: opts.decimals ?? 2 });
  return html`<span class="nowrap" data-fig>${opts.est ? '≈' : ''}${text}</span>`;
}

/** A sentence written by the engine: every amount in it is wrapped so that cover mode redacts it. */
function figText(sentence) {
  return String(sentence).split(/([+−-]?\$\d+(?:,\d{3})*(?:\.\d+)?)/).map((part, i) => (i % 2 ? html`<span class="nowrap" data-fig>${part}</span>` : part));
}

/**
 * A count, a date or a word in the figure face that cover mode leaves readable. The approximately
 * sign goes before a number or a date; a word ("never", "unknown") or a dash is italic without it.
 */
function plainFig(text, opts = {}) {
  const sign = opts.est && /\d/.test(String(text));
  return html`<span class="${cx('fig', opts.size && 'fig-' + opts.size, opts.est && 'est', opts.cls)}" data-cover-keep>${sign ? html`<span class="approx">≈</span>` : ''}${text}</span>`;
}

/** The text of a money field: whole dollars without cents, otherwise to the cent. */
function fieldText(cents) {
  if (!Number.isFinite(cents)) return '';
  return fmtPlain(cents, { decimals: cents % 100 === 0 ? 0 : 2 });
}

/** A share in percent with the true minus; a share too small for one decimal says so. */
function pct(fraction, digits = 1) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  if (fraction > 0 && fraction < 0.0005 && digits >= 1) return 'under 0.1%';
  // a share of something close to nothing is not a figure worth printing to a decimal
  // a percentage whose magnitude is over 999 is never printed (R2): '' and the caller drops the clause
  if (Math.abs(fraction) > 9.995) return '';
  // a small negative share that rounds to nothing prints as 0%, never "−0%"
  const text = fmtPct(fraction, digits);
  return /^[-−]0(\.0+)?%$/.test(text) ? text.slice(1) : text.replace(/^-/, '−');
}

function monthsWord(n) {
  return n + (n === 1 ? ' month' : ' months');
}

function daysWord(n) {
  return n + (n === 1 ? ' day' : ' days');
}

/** The month reached `months` after today's: "October 2027". */
function monthAfter(ctx, months, style = 'long') {
  return fmtMonth(addMonthsYm(monthOf(ctx.today), months), style);
}

/** How old a bank figure is, in words: "from 6:12 AM", "from Jun 8". */
function ageWords(ctx, at) {
  if (!at) return '';
  const day = gameDay(at, ctx.state.settings.rolloverHour);
  return day === ctx.today ? 'from ' + fmtTime(at) : 'from ' + fmtDate(day, 'short');
}

/** Whether a total that includes this account holds an estimate: an owner's estimate or a loan worked down by Networth. */
function isEstimated(ctx, account) {
  if (account.hidden || account.source === 'bank') return false;
  if (account.basis !== 'statement') return true;
  if (!(account.loan && account.loan.payment > 0 && Number.isFinite(account.apr) && account.apr >= 0)) return false;
  // a statement balance typed today is still the statement's figure
  const entry = (account.history || []).filter((e) => e && e.day <= ctx.today).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).pop();
  return !(entry && entry.day === ctx.today && ctx.d.valueOf(account) === entry.balance);
}

/** Whether what is due holds an expected figure: anything due has not posted yet, so any due item makes it one (R4a). */
function dueIsEstimate(ctx, clock) {
  return (clock.due || []).length > 0;
}

/** The due window in words (T1): "today" on payday or in the first days pay is awaited, "through Fri, Jun 26" after that, "before payday on Fri, Jun 19", or the 14 days. */
function dueWindow(clock, form, today) {
  const awaited = typeof clock.payAwaited === 'string';
  const until = typeof clock.dueUntil === 'string' ? clock.dueUntil : null;
  if (until && until <= today && (awaited || clock.nextPayday === today)) return form === 'label' ? 'Due today' : 'today';
  if (awaited && until) return (form === 'label' ? 'Due through ' : 'through ') + fmtDate(until, 'dowshort');
  if (clock.nextPayday && clock.nextPayday > today) return (form === 'label' ? 'Due before payday, ' : 'before payday on ') + fmtDate(clock.nextPayday, 'dowshort');
  return form === 'label' ? 'Due in the next 14 days' : 'in the next 14 days';
}

/** The line said under the due window while a paycheck is awaited or on payday itself, or '' (T1). */
function awaitedLine(clock, today) {
  if (typeof clock.payAwaited === 'string') return ' Pay expected ' + fmtDate(clock.payAwaited, 'dowshort') + ' is not on the bank’s record yet.';
  return clock.nextPayday && clock.nextPayday === today ? ' Payday is today.' : '';
}

/** 'on' when pay accrues; 'off' when regular pay exists but is counted when it arrives; 'none' when no regular pay is known. */
function payCounting(ctx) {
  if (ctx.d.position.smoothing) return 'on';
  return ctx.state.streams.some((s) => s.active !== false && !!s.cadence && (s.kind === 'salary' || s.accrue || (s.locks || []).includes('accrue'))) ? 'off' : 'none';
}

/** Days on record, the first transaction's day through today, both included (R6); 0 when there is none. */
/** The day on record the match is played from (T6): the one count, ctx.d.matchFromDay. */
function matchFromDay(ctx) {
  return ctx.d.matchFromDay;
}

function historyDays(ctx) {
  const n = ctx.d.historyDays;
  return Number.isFinite(n) ? n : 0;
}

/** The day on record from which the measured pace is read: one past the completed days it needs (R6). */
function paceFromDay(ctx) {
  return ctx.d.paceMinDays(PACE_DAYS) + 1;
}

/** The SCENARIO label. `wideOnly` keeps the qualifier off a phone, where the heading has no room for it. */
function scenarioTag(text, wideOnly = false) {
  return html`<span class="lab an-scn"><i class="hatch-mark"></i><b>Scenario</b>${text ? html`<span class="${cx(wideOnly && 'not-phone')}"><i class="sep"></i>${text}</span>` : ''}</span>`;
}

/**
 * A small field set in place.
 * `width` is the least number of characters the field keeps room for; it grows with its value.
 * @param {{ field?: string, action?: string, value: string, label: string, width?: number, prefix?: string, suffix?: string,
 *           est?: boolean, mode?: string, money?: boolean, extra?: object, placeholder?: string }} o
 */
function field(o) {
  const least = o.width || 3;
  const length = String(o.value).length;
  const width = Math.max(least, length) + 0.5;
  const min = length ? Math.max(2, Math.min(length, least)) : least;
  return html`<span class="${cx('an-in', o.est && 'est')}" style="${'--w:' + width + ';--min:' + min}">
    ${o.prefix ? html`<span class="an-in-fix" aria-hidden="true">${o.prefix}</span>` : ''}
    <input type="text" inputmode="${o.mode || 'decimal'}" autocomplete="off" enterkeyhint="done" value="${o.value}"
      aria-label="${o.label}" data-change="${o.action || 'analysis.set'}" ${attrs({ 'data-field': o.field, 'data-fig': o.money !== false && String(o.value) !== '', placeholder: o.placeholder, ...(o.extra || {}) })}>
    ${o.suffix ? html`<span class="an-in-fix" aria-hidden="true">${o.suffix}</span>` : ''}
  </span>`;
}

function chart(kind, data) {
  return html`<nw-chart data-island kind="${kind}" data="${JSON.stringify(data)}"></nw-chart>`;
}

/* ------------------------------------------------------------ the abstract */

/** Whether the live figure holds an estimate: accrual, a provisional day or an account kept by hand (R4). */
function heroEst(ctx) {
  const d = ctx.d;
  const pos = d.position;
  return !!(pos.smoothing || pos.provisional > 0 || ctx.state.accounts.some((a) => isEstimated(ctx, a) && d.valueOf(a) !== 0));
}

function abstract(ctx) {
  const d = ctx.d;
  const pos = d.position;
  const pace = d.pace(PACE_DAYS);
  const edge = d.edge;
  const matchStart = ctx.state.meta.matchStart;
  const first = firstTransactionDay(ctx.state);
  // today's point is the floored live figure, as on every screen (T10)
  const trend = first ? d.recent(PACE_DAYS).filter((row) => row.day >= first).map((row) => (row.day === ctx.today ? Math.floor(pos.live) : row.smooth)) : [];
  const est = heroEst(ctx);
  return html`<section class="band an-abstract">
    <div class="sec-head sec-head-wrap">
      <h1 class="lab"><b>Analysis</b><i class="sep"></i>goals and variations</h1>
      <p class="cap">What looks back is measured. What looks forward is a scenario, set in italics and never a prediction.</p>
    </div>
    <div class="tally tally-ruled tally-s an-abstract-tally">
      <div class="tally-item">
        <span class="lab">Net worth now</span>
        ${money(Math.floor(pos.live), { est })}
        <span class="cap">${trend.length > 1 ? html`<nw-chart data-island kind="spark" data="${JSON.stringify(trend)}"></nw-chart> ` : ''}${est ? 'live' : 'at the bank'}${trend.length > 1 ? html`<span class="not-phone">; the last ${daysWord(trend.length)}</span>` : ''}</span>
      </div>
      <div class="tally-item">
        <span class="lab">Measured pace</span>
        ${pace ? money(pace.perMonth, { est: true, signed: true }) : html`<span class="fig est" data-cover-keep>—</span>`}
        <span class="cap">${pace
          ? html`a month<span class="not-phone">, over the last ${daysWord(pace.days)}</span>`
          : html`read from day ${paceFromDay(ctx)} on record; ${historyDays(ctx)} so far`}</span>
      </div>
      <div class="tally-item">
        <span class="lab">Kept v. Habit</span>
        ${matchStart ? money(edge.kept, { est: true, signed: true }) : html`<span class="fig est" data-cover-keep>—</span>`}
        <span class="cap">${matchStart
          ? html`since ${fmtDate(matchStart, 'short')}<span class="not-phone">; a counterfactual, not cash</span>`
          : html`the match begins on day ${matchFromDay(ctx)} on record; ${historyDays(ctx)} so far`}</span>
      </div>
    </div>
  </section>`;
}

/* ----------------------------------------------------------------- reserve */

function reserveAccountsLine(ctx) {
  const cash = ctx.d.accounts('cash');
  const flagged = cash.filter((account) => account.reserve);
  if (!cash.length) return 'No cash account is linked yet.';
  const age = ageWords(ctx, ctx.d.clock.asOf);
  if (!flagged.length) return 'All cash accounts: none is marked as the reserve' + (age ? ' · ' + age : '') + '.';
  return flagged.map(accountLabel).join(', ') + (age ? ' · at the bank ' + age : '');
}

function reserveSection(ctx) {
  const r = ctx.d.reserve;
  const clock = ctx.d.clock;
  const pace = ctx.d.pace(PACE_DAYS);
  const scenario = ctx.state.scenario;
  const pct = Number.isFinite(r.fraction) && Math.abs(r.fraction) <= 9.995 ? fmtPct(r.fraction, r.fraction < 0.1 ? 1 : 0) : '';
  const onRecord = historyDays(ctx);
  const nextIndex = clock.milestones.findIndex((m) => !m.reached);
  const next = nextIndex >= 0 ? clock.milestones[nextIndex] : null;
  const met = r.gap <= 0;

  let paceValue;
  let paceNote;
  if (met) {
    paceValue = plainFig('reached', { est: false });
    paceNote = 'The goal is covered as of today.';
  } else if (!pace) {
    paceValue = plainFig('—', { est: true });
    paceNote = html`A pace is read from day ${paceFromDay(ctx)} on record; ${historyDays(ctx)} so far.`;
  } else if (r.atPace.months == null) {
    paceValue = plainFig('no date', { est: true });
    paceNote = html`The pace is not adding to cash: ${amt(pace.perMonth, { est: true, signed: true })} a month over ${daysWord(pace.days)}.`;
  } else {
    paceValue = plainFig(monthAfterDay(r.atPace.day), { est: true });
    paceNote = html`${amt(pace.perMonth, { est: true, signed: true })} a month, if all of it reached the reserve: ${monthsWord(r.atPace.months)}.`;
  }

  const scnValue = met
    ? plainFig('reached', { est: false })
    : r.atScenario.months == null ? plainFig('no date', { est: true }) : plainFig(monthAfterDay(r.atScenario.day), { est: true });

  return html`<section class="col col-5 an-reserve" aria-labelledby="an-reserve-h">
    <div class="sec-head">
      <h2 class="lab" id="an-reserve-h"><b>Reserve</b><i class="sep"></i>cash set aside</h2>
      ${pct ? html`<span class="lab" data-cover-keep>${pct} of the goal</span>` : ''}
    </div>
    <p class="an-big">${money(r.have, { size: 'xl' })}</p>
    <p class="cap"><i class="bank-mark"></i>${reserveAccountsLine(ctx)}</p>
    <div class="bar an-bar" style="${'--p:' + (r.fraction * 100).toFixed(1) + '%'}" role="img" aria-label="${pct ? pct + ' of the reserve goal' : 'The reserve goal, many times over'}"><i></i></div>
    <div class="an-sets">
      <label class="an-set">
        <span class="lab">Goal</span>
        ${field({ field: 'reserve', value: fieldText(r.target), label: 'Reserve goal, in dollars', prefix: '$', width: 4 })}
      </label>
      <p class="an-set">
        <span class="lab">Gap</span>
        ${money(r.gap, { size: 'm' })}
      </p>
    </div>
    <h3 class="lab an-sub an-sub-bare">Milestones<i class="sep"></i>measured in time</h3>
    <ol class="ticks an-ticks" aria-label="Reserve milestones">
      ${clock.milestones.map((m, i) => html`<li class="${cx(m.reached && 'is-done', i === nextIndex && 'is-next')}" data-key="${m.label}">${m.label}</li>`)}
    </ol>
    <p class="cap an-note">${clock.burn > 0
      ? html`A day is ${amt(clock.burn, { est: true })}, the typical outflow over ${onRecord > 0 && onRecord < 60 ? 'the ' + daysWord(onRecord) + ' on record' : '60 days'}. ${met
        ? ''
        : next
        ? html`Next: ${next.label === 'Goal' ? 'the goal' : next.label}, ${amt(next.amount, { est: next.label !== 'Goal' })}; ${amt(Math.max(0, next.amount - r.have), { est: next.label !== 'Goal' })} to go.`
        : 'Every milestone is reached.'}`
      : 'The milestones are sized once 60 days of outflow can be measured.'}</p>
    <h3 class="lab an-sub">When the gap closes</h3>
    <ul class="rows rows-plain an-eta">
      <li class="row">
        <span class="row-label">At the last ${PACE_DAYS} days’ pace <em class="row-note">${paceNote}</em></span>
        <span class="row-value">${paceValue}</span>
      </li>
      <li class="row">
        <span class="row-label">
          <label class="an-inline">${scenarioTag()}<span class="an-inline-text">at</span>
            ${field({ field: 'toSavings', value: fieldText(scenario.toSavings), label: 'Scenario: dollars moved to the reserve each month', prefix: '$', width: 3, est: true })}
            <span class="an-inline-text">a month</span></label>
          <em class="row-note">${met
            ? 'Nothing more is needed for the goal.'
            : r.atScenario.months == null
              ? 'At this amount the gap does not close within a century.'
              : html`${monthsWord(r.atScenario.months)} of ${amt(scenario.toSavings)} closes ${amt(r.gap)}.`}</em>
        </span>
        <span class="row-value">${scnValue}</span>
      </li>
    </ul>
  </section>`;
}

/** "Sep 2029" for a day. */
function monthAfterDay(day) {
  return fmtMonth(monthOf(day), 'short');
}

/* ------------------------------------------------------------------- cards */

function cardsSection(ctx) {
  const p = ctx.d.payoff;
  const now = ctx.d.cardsNow;
  const owing = now.cards.filter((card) => card.owed > 0);
  const head = html`<div class="sec-head">
      <h2 class="lab" id="an-cards-h"><b>Cards</b><i class="sep"></i>payoff</h2>
      ${p.owed > 0 ? scenarioTag('a fixed payment') : ''}
    </div>`;

  if (!now.cards.length) {
    return html`<section class="col col-7 an-cards" aria-labelledby="an-cards-h">${head}
      <div class="empty empty-plain">
        <p class="empty-title">No card is linked.</p>
        <p class="cap">A payoff scenario is drawn here from the first day the bank reports a card balance. As of ${fmtDate(ctx.today, 'short')} there is none.</p>
      </div>
    </section>`;
  }
  if (p.owed <= 0) {
    return html`<section class="col col-7 an-cards" aria-labelledby="an-cards-h">${head}
      <div class="empty empty-plain">
        <p class="empty-title">Nothing is owed on a card.</p>
        <p class="cap">${now.cards.length === 1 ? now.cards[0].label : now.cards.length + ' cards'}: ${amt(0)} owed as of ${fmtDate(ctx.today, 'short')}. A payoff scenario appears here when a balance is carried.</p>
      </div>
    </section>`;
  }

  const missing = owing.find((card) => card.apr === null) || null;
  const aprText = p.apr === null ? null : fmtPct(p.apr / 100, 2);
  const monthlyInterest = p.apr === null ? null : Math.round(p.owed * p.apr / 1200);

  let monthsFig;
  let monthsCap;
  if (p.payment <= 0) {
    monthsFig = plainFig('—', { est: true });
    monthsCap = 'no payment in the scenario';
  } else if (p.never) {
    monthsFig = plainFig('never', { est: true });
    monthsCap = html`interest alone is ${amt(monthlyInterest, { est: true })} a month`;
  } else {
    monthsFig = plainFig(String(p.months), { est: true });
    monthsCap = html`${monthAfter(ctx, p.months)}${p.apr === null ? ', counted at 0%' : ''}`;
  }

  let interestFig;
  let interestCap;
  if (p.apr === null) {
    interestFig = plainFig('unknown', { est: true });
    interestCap = html`no APR on file for ${missing ? missing.label : 'a card'}`;
  } else if (p.never || p.payment <= 0) {
    interestFig = plainFig('—', { est: true });
    interestCap = html`at ${aprText} the balance grows`;
  } else {
    interestFig = money(p.interest, { est: true });
    interestCap = html`at ${aprText} APR${owing.length > 1 ? ', weighted by balance' : ''}`;
  }

  let caption;
  if (p.payment <= 0) {
    caption = html`With no payment the balance of ${amt(p.owed)} stands${monthlyInterest ? html` and adds ${amt(monthlyInterest, { est: true })} of interest a month` : ''}.`;
  } else if (p.never) {
    caption = html`${amt(p.payment)} a month does not cover the interest on ${amt(p.owed)} at ${aprText}: the balance never clears. Drawn for ${monthsWord(p.schedule.length - 1)}.`;
  } else {
    caption = html`${amt(p.payment)} a month clears ${amt(p.owed)} in ${monthsWord(p.months)}, by ${monthAfter(ctx, p.months)}${p.apr === null ? '; interest is unknown and left out' : html`, with ${amt(p.interest, { est: true })} of interest at ${aprText}`}. New charges are not in the scenario.`;
  }

  return html`<section class="col col-7 an-cards" aria-labelledby="an-cards-h">${head}
    <div class="an-cards-grid">
      <div class="an-cards-side">
        <p class="lab an-over">Owed now</p>
        <p class="an-big">${money(p.owed, { size: 'xl' })}</p>
        <ul class="an-cardlist">
          ${now.cards.map((card) => html`<li data-key="${card.id}">
            <button class="btn-link an-cardlink" type="button" data-action="app.sheet" data-sheet="account" data-id="${card.id}">${card.label}</button>
            <span class="cap">${now.cards.length > 1 ? html`${amt(card.owed)} · ` : ''}${card.apr === null ? 'no APR on file' : fmtPct(card.apr / 100, 2) + ' APR'}</span>
          </li>`)}
        </ul>
        <div class="an-sets">
          <label class="an-set">
            <span class="lab">Payment a month</span>
            ${field({ field: 'payment', value: fieldText(p.payment), label: 'Scenario: card payment each month, in dollars', prefix: '$', width: 3, est: true })}
          </label>
        </div>
        <div class="chips an-quick" role="group" aria-label="Quick payment amounts">
          ${QUICK_PAYMENTS.map((cents) => html`<button class="chip" type="button" data-action="analysis.pay" data-cents="${cents}" aria-pressed="${cents === p.payment ? 'true' : 'false'}"><span data-fig>${fmt(cents, { decimals: 0 })}</span></button>`)}
        </div>
        <div class="tally tally-s an-payoff-tally" aria-live="polite">
          <div class="tally-item"><span class="lab">Months to clear</span>${monthsFig}<span class="cap">${monthsCap}</span></div>
          <div class="tally-item"><span class="lab">Interest paid</span>${interestFig}<span class="cap">${interestCap}</span></div>
        </div>
        ${missing ? html`<p class="cap an-note">Interest is unknown: the bank does not report an APR.
          <button class="btn-link" type="button" data-action="app.sheet" data-sheet="account" data-id="${missing.id}">Add the APR</button></p>` : ''}
      </div>
      <figure class="an-fig">
        ${chart('payoff', { schedule: p.schedule, from: monthOf(ctx.today) })}
        <figcaption class="cap an-figcap"><b>Fig. 1</b><b>Scenario</b> ${caption}</figcaption>
      </figure>
    </div>
  </section>`;
}

/* --------------------------------------------------------------- retention */

function retentionRows(ctx) {
  const first = firstTransactionDay(ctx.state);
  const thisYm = monthOf(ctx.today);
  const rows = [{ ...ctx.d.retention(), current: true }];
  for (let back = 1; back <= RETENTION_MONTHS_BACK; back++) {
    const ym = addMonthsYm(thisYm, -back);
    const last = endOfMonth(ym);
    if (!first || last < first) continue;
    rows.push({ ...retention(ctx.state, last, ctx.now), current: false, partial: first > ym + '-01' });
  }
  return rows;
}

function retentionSection(ctx) {
  const rows = retentionRows(ctx);
  const est = ctx.d.position.smoothing;
  const first = firstTransactionDay(ctx.state);
  return html`<section class="col col-4 an-retention" aria-labelledby="an-ret-h">
    <div class="sec-head">
      <h2 class="lab" id="an-ret-h"><b>Retention</b><i class="sep"></i>by month</h2>
      <span class="lab">kept of earned</span>
    </div>
    <ol class="an-ret">
      ${rows.map((row) => {
    const out = row.bills + row.spent;
    return html`<li class="an-ret-row" data-key="${row.ym}">
        <p class="an-ret-head">
          <span class="lab"><b>${fmtMonth(row.ym, 'name')}</b><i class="sep"></i>${row.current ? 'so far, ' + daysWord(row.days) : row.partial ? 'from ' + fmtDate(first, 'short') : daysWord(row.days)}</span>
          <span class="an-ret-kept"><span class="lab">Kept</span>${money(row.kept, { est, signed: true })}<span class="cap" data-cover-keep>${pct(row.rate, 1)}</span></span>
        </p>
        <nw-split data-island slim a="${Math.max(0, row.kept)}" b="${Math.max(0, out)}"></nw-split>
        <p class="an-ret-parts">
          <span><span class="lab lab-s">Earned</span>${money(row.earned, { est })}</span>
          <span><span class="lab lab-s">Bills</span>${money(row.bills, { est })}</span>
          <span><span class="lab lab-s">Spent</span>${money(row.spent)}</span>
        </p>
        ${row.other ? html`<p class="cap an-ret-other">Also ${amt(row.other, { est, signed: true })} that is neither pay, a bill nor spending, such as money from an account left out. It is in what was kept.</p>` : ''}
      </li>`;
  })}
    </ol>
    <p class="cap an-note">White is what was kept, black is bills and spending. ${est
      ? 'Earned and bills are counted day by day, so they are italic.'
      : payCounting(ctx) === 'off'
        ? 'Pay is counted when it arrives, and each bill on the day it posts.'
        : 'Pay and bills are counted on the day they post: no regular pay has been detected yet.'}${rows.length <= RETENTION_MONTHS_BACK
      ? html` The bank’s record begins ${first ? fmtDate(first, 'short') : 'with the first sync'}; earlier months are not shown.` : ''}</p>
  </section>`;
}

/* ---------------------------------------------------------------- scenario */

function scenarioSection(ctx) {
  const proj = ctx.d.projection;
  const scenario = ctx.state.scenario;
  const pace = ctx.d.pace(PACE_DAYS);
  const months = proj.months;
  const byKey = new Map(proj.lines.map((line) => [line.key, line]));
  const end = (key) => byKey.get(key).points[Math.min(months, byKey.get(key).points.length - 1)];
  const perMonth = (key) => Math.round((end(key) - proj.start) / months);
  const hasHabit = byKey.has('habit');

  const parts = [];
  if (byKey.has('pace')) parts.push(html`Solid: the last ${daysWord(pace.days)}’ pace, ${amt(pace.perMonth, { est: true, signed: true })} a month, carried on.`);
  parts.push(html` Dashed: net worth rising ${amt(scenario.monthlyImprove)} a month.`);
  if (hasHabit) parts.push(html` Dotted: the same pace without what was kept against Habit, ${amt(perMonth('habit'), { est: true, signed: true })} a month.`);
  if (!byKey.has('pace')) parts.push(html` The measured pace joins the figure from day ${paceFromDay(ctx)} on record; ${historyDays(ctx)} so far.`);
  else if (!hasHabit) parts.push(' The line at Habit joins once the match has begun.');

  return html`<section class="col col-8 an-scenario" aria-labelledby="an-scn-h">
    <div class="sec-head">
      <h2 class="lab" id="an-scn-h"><b>Net worth</b><span class="not-phone"><i class="sep"></i>three lines</span></h2>
      ${scenarioTag('not a prediction')}
    </div>
    <div class="an-scn-grid">
      <figure class="an-fig">
        ${chart('lines', { start: proj.start, months, lines: proj.lines, from: monthOf(ctx.today) })}
        <figcaption class="cap an-figcap"><b>Fig. 2</b><b>Scenario</b> ${parts} Every line starts at ${heroEst(ctx) ? html`${amt(proj.start, { est: true })}, the live figure` : html`${amt(proj.start)}, the figure at the bank`}.</figcaption>
      </figure>
      <div class="an-scn-side">
        <div class="an-sets">
          <label class="an-set">
            <span class="lab">Rising by, a month</span>
            ${field({ field: 'improve', value: fieldText(scenario.monthlyImprove), label: 'Scenario: net worth rising by this much each month, in dollars', prefix: '$', width: 3, est: true })}
          </label>
          <div class="an-set an-set-stack">
            <span class="lab" id="an-horizon-lab">Horizon<i class="sep"></i>months</span>
            <div class="seg seg-fig an-horizon" role="radiogroup" aria-labelledby="an-horizon-lab" data-change="analysis.set" data-field="horizon">
              ${HORIZONS.map((n) => html`<label class="seg-opt"><input type="radio" name="an-horizon" value="${n}" ${attrs({ checked: n === months })}><span>${n}</span></label>`)}
            </div>
          </div>
        </div>
        <h3 class="lab an-sub">After ${monthsWord(months)}<i class="sep"></i>${monthAfter(ctx, months, 'short')}</h3>
        <ul class="rows rows-plain an-ends" aria-live="polite">
          ${proj.lines.map((line) => html`<li class="row" data-key="${line.key}">
            <span class="row-label"><i class="${'an-key an-key-' + line.key}" aria-hidden="true"></i>${line.label}</span>
            <span class="row-value fig est"><span class="approx">≈</span>${fmt(end(line.key), { decimals: 0 })}</span>
          </li>`)}
        </ul>
      </div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ ladder */

function ladderSection(ctx) {
  const l = ctx.d.ladder;
  const scenario = ctx.state.scenario;
  const sharePct = Math.round((Number.isFinite(scenario.takeHomeRatio) ? scenario.takeHomeRatio : 1) * 100);
  const rungs = l.ladder.slice().reverse();
  // under 60 days of deposits a year's income is not a measure yet: the received amount and the day
  // count are printed, and no yearly figure, rung or growth rate is offered from them
  const thin = !!l.thin;
  const nextTarget = l.next && !thin ? l.next.target : null;
  const top = l.final.target;
  const has = l.received > 0 && !thin;
  const salary = l.byStream.filter((row) => row.kind === 'salary').reduce((n, row) => n + row.received, 0);

  const head = html`<div class="sec-head">
      <h2 class="lab" id="an-ladder-h"><b>Income ladder</b><span class="not-phone"><i class="sep"></i>annual gross</span></h2>
      <span class="lab">apart from net worth</span>
    </div>`;

  return html`<section class="band an-income" aria-labelledby="an-ladder-h">${head}
    <div class="tally tally-s tally-plain an-income-tally">
      <div class="tally-item">
        <span class="lab">Received<i class="sep"></i>${l.partial ? (l.days > 0 ? daysWord(l.days) : 'no record yet') : '12 months'}</span>
        ${money(l.received)}
        <span class="cap"><i class="bank-mark"></i>bank deposits</span>
      </div>
      ${l.partial ? html`<div class="tally-item">
        <span class="lab">Annualized</span>
        ${has ? money(l.annualised, { est: true, decimals: 0 }) : plainFig('—', { est: true })}
        <span class="cap">${thin ? 'read from day 60 of deposits' : l.days > 0 ? daysWord(l.days) + ' scaled to 365' : 'read from the first deposit'}</span>
      </div>` : ''}
      <div class="tally-item">
        <span class="lab">Approximate gross</span>
        ${has ? money(l.grossApprox, { est: true, decimals: 0 }) : plainFig('—', { est: true })}
        <span class="cap">${thin ? 'a year’s figure, from day 60' : salary > 0 ? 'salary before withholding' : 'no salary detected: as received'}</span>
      </div>
    </div>
    <ol class="ladder an-ladder">
      ${rungs.map((rung, i) => {
    const isTop = rung.target === top;
    const isNext = rung.target === nextTarget;
    const reached = rung.reached && !thin;
    const notes = [];
    if (isNext) notes.push(pct(rung.fraction, 1) ? 'next norm · ' + pct(rung.fraction, 1) + ' there' : 'next norm');
    else if (reached) notes.push('reached');
    if (isTop && l.final.by) notes.push('by ' + fmtDate(l.final.by, 'full'));
    return html`<li class="${cx('rung', isNext && 'is-next', reached && 'is-done', !isNext && !reached && 'is-later')}" data-key="${rung.target}">
          <span class="rung-title">${RUNG_TITLES[i] || 'N' + (rungs.length - i)}</span>
          <span class="fig">${fmt(rung.target, { decimals: 0 })}</span>
          <span class="cap" data-cover-keep>${notes.join(' · ')}</span>
        </li>`;
  })}
      <li class="rung is-you" data-key="you">
        <span class="bar rung-bar" style="${'--p:' + ((thin ? 0 : l.next ? l.next.fraction : 1) * 100).toFixed(1) + '%'}" aria-hidden="true"><i></i></span>
        <span class="rung-title">You</span>
        ${has ? money(l.grossApprox, { est: true, decimals: 0 }) : plainFig('—', { est: true })}
        <span class="cap">${thin
          ? html`A year’s income is read from day 60 of deposits: ${daysWord(l.days)} so far.`
          : l.next ? html`${amt(l.next.gap, { est: true, decimals: 0 })} to the next norm` : 'every norm is reached'}</span>
        ${thin ? '' : html`<span class="cap rung-note">${l.partial && has
          ? html`Annualized from ${daysWord(l.days)} of deposits, so a single payday moves it a long way. `
          : ''}${top > 0 && l.final.requiredGrowth != null && l.grossApprox < top && pct(l.final.requiredGrowth, 0)
          ? html`The final norm, ${amt(top, { decimals: 0 })} by ${fmtDate(l.final.by, 'full')}, would need growth of about ${pct(l.final.requiredGrowth, 0)} a year from here.`
          : top > 0 && l.grossApprox >= top ? 'The final norm is reached.' : top > 0 && l.final.requiredGrowth != null ? '' : html`Growth toward the final norm is read once income has been received.`}</span>`}
      </li>
    </ol>
    <div class="an-sets">
      <label class="an-set">
        <span class="lab">Take-home share of salary</span>
        ${field({ field: 'takeHome', value: String(sharePct), label: 'Share of gross salary that is taken home, in percent', suffix: '%', width: 2, est: true, mode: 'numeric', money: false })}
      </label>
    </div>
    <p class="cap an-note">${salary > 0
      ? html`Used for the approximate gross only: salary of ${amt(salary)} ÷ ${(sharePct / 100).toFixed(2)}; other income counts as received.`
      : 'Used once a salary is detected; until then the gross is the income as received.'}</p>
    <h3 class="lab an-sub">By stream<i class="sep"></i>${l.partial ? (l.days > 0 ? 'last ' + daysWord(l.days) : 'no record yet') : 'last 12 months'}</h3>
    ${l.byStream.length ? html`<ul class="rows rows-plain an-streams">
      ${l.byStream.map((row) => html`<li class="row" data-key="${row.id || 'other'}">
        <span class="row-label">${row.name}<em class="row-note">${(STREAM_KINDS[row.kind] || STREAM_KINDS.other).label} · <span data-cover-keep>${pct(row.share, row.share < 0.1 ? 1 : 0)}</span></em></span>
        <span class="row-value fig">${fmt(row.received)}</span>
      </li>`)}
    </ul>` : html`<p class="cap an-note">${l.days > 0
      ? html`No income has been reported in ${daysWord(l.days)} of bank history.`
      : html`No deposit is on record as of ${fmtDate(ctx.today, 'short')}. Streams are listed from the first one the bank reports.`}</p>`}
  </section>`;
}

/* ----------------------------------------------------------- where it went */

function spendingTable(ctx) {
  const today = ctx.today;
  const s30 = ctx.d.spending(addDays(today, -29), today);
  const s90 = ctx.d.spending(addDays(today, -89), today);
  const targets = ctx.state.settings.targets || {};
  const byCat = new Map();
  const put = (row, key) => {
    if (!byCat.has(row.category)) byCat.set(row.category, { category: row.category, klass: row.klass, a30: 0, a90: 0, n90: 0 });
    const entry = byCat.get(row.category);
    entry[key] = row.amount;
    if (key === 'a90') entry.n90 = row.count;
  };
  s30.forEach((row) => put(row, 'a30'));
  s90.forEach((row) => put(row, 'a90'));
  for (const category in targets) {
    if (!byCat.has(category) && CATEGORIES[category]) byCat.set(category, { category, klass: CATEGORIES[category].klass, a30: 0, a90: 0, n90: 0 });
  }
  const groups = KLASS_ORDER.map((klass) => {
    const rows = [...byCat.values()].filter((row) => row.klass === klass).sort((a, b) => b.a90 - a.a90 || b.a30 - a.a30);
    return { klass, rows, a30: rows.reduce((n, r) => n + r.a30, 0), a90: rows.reduce((n, r) => n + r.a90, 0) };
  }).filter((group) => group.rows.length);
  const stray = [...byCat.values()].filter((row) => !KLASS_ORDER.includes(row.klass));
  if (stray.length) groups.push({ klass: 'other', rows: stray, a30: stray.reduce((n, r) => n + r.a30, 0), a90: stray.reduce((n, r) => n + r.a90, 0) });
  return { groups, total30: groups.reduce((n, g) => n + g.a30, 0), total90: groups.reduce((n, g) => n + g.a90, 0), targets };
}

function spendingSection(ctx) {
  const { groups, total30, total90, targets } = spendingTable(ctx);
  const days = historyDays(ctx);
  const head = html`<div class="sec-head">
      <h2 class="lab" id="an-went-h"><b>Where it went</b><i class="sep"></i>by category</h2>
      <span class="lab">to ${fmtDate(ctx.today, 'short')}</span>
    </div>`;
  if (!groups.length) {
    return html`<section class="col col-7 an-went" aria-labelledby="an-went-h">${head}
      <div class="empty empty-plain">
        <p class="empty-title">No spending on record.</p>
        <p class="cap">The bank has reported no purchases in the 90 days to ${fmtDate(ctx.today, 'short')}. Categories fill in as moves post.</p>
      </div>
    </section>`;
  }
  return html`<section class="col col-7 an-went" aria-labelledby="an-went-h">${head}
    <table class="table table-s an-table">
      <thead><tr>
        <th scope="col">Category</th>
        <th scope="col" class="num">30 days</th>
        <th scope="col" class="num">90 days</th>
        <th scope="col" class="num an-th-target">Target <span class="not-phone">a month</span></th>
      </tr></thead>
      ${groups.map((group) => html`<tbody data-key="${group.klass}">
        <tr class="an-group">
          <th scope="rowgroup"><span class="lab"><b>${(KLASSES[group.klass] || { label: 'Other' }).label}</b>${KLASS_NOTES[group.klass] ? html`<i class="sep not-phone"></i><span class="not-phone">${KLASS_NOTES[group.klass]}</span>` : ''}</span></th>
          <td class="num">${fmt(group.a30)}</td>
          <td class="num">${fmt(group.a90)}</td>
          <td></td>
        </tr>
        ${group.rows.map((row) => {
    const target = Number.isFinite(targets[row.category]) ? targets[row.category] : null;
    return html`<tr data-key="${row.category}">
          <th scope="row">${categoryLabel(row.category)}${target && pct(row.a30 / target, 0) ? html`<em class="row-note"><span data-cover-keep>${pct(row.a30 / target, 0)}</span> of the target</em>` : ''}</th>
          <td class="num">${fmt(row.a30)}</td>
          <td class="num">${fmt(row.a90)}</td>
          <td class="num an-td-target">${field({ action: 'analysis.target', value: target ? fieldText(target) : '', label: 'Monthly target for ' + categoryLabel(row.category) + ', in dollars (optional)', prefix: '$', width: 3, placeholder: '—', extra: { 'data-cat': row.category } })}</td>
        </tr>`;
  })}
      </tbody>`)}
      <tfoot><tr>
        <th scope="row">All spending</th>
        <td class="num">${fmt(total30)}</td>
        <td class="num">${fmt(total90)}</td>
        <td></td>
      </tr></tfoot>
    </table>
    <p class="cap an-note">Purchases net of refunds, as the bank reported them; transfers and card payments are not spending. A target is optional: write one in the last column, or leave the dash. It changes nothing else.${days > 0 && days < 90
      ? html` The record covers ${daysWord(days)}, so ${days < 30 ? 'both columns hold the same moves' : 'the 90-day column is not yet full'}.` : ''}</p>
  </section>`;
}

/* ------------------------------------------------- before a larger purchase */

function buyState(ctx) {
  const ui = ctx.ui.anBuy || {};
  const text = typeof ui.text === 'string' ? ui.text : '';
  const cents = toCents(text);
  const hasCard = ctx.d.cardsNow.cards.length > 0;
  const on = ui.on === 'card' && hasCard ? 'card' : 'cash';
  return { text, on, hasCard, amount: cents != null && cents > 0 && cents <= MAX_MONEY ? cents : 0 };
}

function buyConsequences(ctx, buy) {
  const impact = purchaseImpact(ctx.state, ctx.now, { amount: buy.amount, on: buy.on }, { ledger: ctx.d.ledger });
  const clock = ctx.d.clock;
  const rows = [];
  rows.push({ key: 'nw', label: 'Net worth', note: 'A purchase is spending whichever account pays.', value: money(impact.netWorth, { est: true }) });
  if (buy.on === 'cash') {
    const runAfter = clock.burn > 0 ? Math.max(0, Math.floor(impact.cashAfter / clock.burn)) : null;
    rows.push({
      key: 'cash', label: 'Cash on the clock',
      note: html`From ${amt(clock.cash)}${runAfter != null && clock.runwayDays != null ? html`; about ${daysWord(runAfter)} of typical outflow, from ${clock.runwayDays}` : ''}.`,
      value: money(impact.cashAfter, { est: true }),
    });
    if (clock.dueTotal > 0) {
      rows.push({
        key: 'due', label: dueWindow(clock, 'label', ctx.today),
        note: html`${amt(clock.dueTotal, { est: dueIsEstimate(ctx, clock) })} in ${clock.due.length === 1 ? '1 bill' : clock.due.length + ' bills'}.${awaitedLine(clock, ctx.today)}`,
        value: impact.shortfallAfter > 0 ? html`<span class="fig est"><span class="approx">≈</span>${fmt(impact.shortfallAfter)} <small>short</small></span>` : html`<span class="fig est" data-cover-keep>covered</span>`,
      });
    }
  } else {
    const p = ctx.d.payoff;
    rows.push({ key: 'card', label: 'Card balance', note: html`From ${amt(p.owed)}.`, value: money(p.owed + buy.amount, { est: true }) });
    rows.push({
      key: 'pace', label: 'This month on the card',
      // no pace is read before day 7 of the month (R3a): the change is then null
      note: impact.cardMonthChange == null ? 'A pace is read from day 7 of the month.' : 'Where the month is on pace to end, against where it began.',
      value: impact.cardMonthChange == null
        ? html`<span class="fig est" data-cover-keep>—</span>`
        : html`<span class="fig est"><span class="approx">≈</span>${fmt(Math.abs(impact.cardMonthChange))} <small>${impact.cardMonthChange > 0 ? 'higher' : impact.cardMonthChange < 0 ? 'lower' : 'level'}</small></span>`,
    });
    if (p.payment > 0) {
      const before = payoff({ owed: p.owed, apr: p.apr, payment: p.payment });
      const after = payoff({ owed: p.owed + buy.amount, apr: p.apr, payment: p.payment });
      rows.push({
        key: 'clear', label: html`Months to clear at ${amt(p.payment)}`,
        note: after.never ? 'At that payment the larger balance never clears.'
          : html`From ${before.never || before.months == null ? 'never' : before.months}${p.apr !== null && after.interest != null && before.interest != null ? html`; ${amt(after.interest - before.interest, { est: true })} more interest` : p.apr === null ? '; interest unknown' : ''}.`,
        value: plainFig(after.never ? 'never' : String(after.months), { est: true }),
      });
    }
  }
  if (impact.daysOfPay != null) {
    const shown = impact.daysOfPay >= 10 ? Math.round(impact.daysOfPay) : Math.round(impact.daysOfPay * 10) / 10;
    rows.push({ key: 'pay', label: 'In take-home pay', note: 'At the daily rate of the income on record.', value: html`<span class="fig est"><span class="approx">≈</span>${shown} <small>${shown === 1 ? 'day' : 'days'}</small></span>` });
  }
  return { impact, rows };
}

function purchaseSection(ctx) {
  const buy = buyState(ctx);
  const result = buy.amount > 0 ? buyConsequences(ctx, buy) : null;
  return html`<section class="band an-buy" aria-labelledby="an-buy-h">
    <div class="sec-head">
      <h2 class="lab" id="an-buy-h"><b>Before a larger purchase</b><span class="not-phone"><i class="sep"></i>a candidate move</span></h2>
      ${scenarioTag('nothing is recorded', true)}
    </div>
    <div class="an-buy-grid">
      <div class="an-buy-in">
        <label class="money an-money">
          <span class="vh">Amount of the purchase, in dollars</span>
          <span class="money-cur" aria-hidden="true">$</span>
          <input class="money-input" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off" enterkeyhint="done" value="${buy.text}" data-input="analysis.buy-amount">
        </label>
        <div class="chips an-quick" role="group" aria-label="Example amounts">
          ${QUICK_PURCHASES.map((cents) => html`<button class="chip" type="button" data-action="analysis.buy-quick" data-cents="${cents}" aria-pressed="${cents === buy.amount ? 'true' : 'false'}"><span data-fig>${fmt(cents, { decimals: 0 })}</span></button>`)}
          ${buy.text ? html`<button class="btn-link an-clear" type="button" data-action="analysis.buy-clear">Clear</button>` : ''}
        </div>
        <div class="seg seg-block an-buy-on" role="radiogroup" aria-label="Paid from" data-change="analysis.buy-on">
          <label class="seg-opt"><input type="radio" name="an-buy-on" value="cash" ${attrs({ checked: buy.on === 'cash' })}><span>From cash</span></label>
          <label class="seg-opt"><input type="radio" name="an-buy-on" value="card" ${attrs({ checked: buy.on === 'card', disabled: !buy.hasCard })}><span>On a card</span></label>
        </div>
        ${buy.hasCard ? '' : html`<p class="cap an-note">No card is linked, so the purchase is read from cash.</p>`}
      </div>
      <div class="${cx('an-buy-out', result && 'has-result')}" aria-live="polite">
        ${result ? html`
          <div class="an-buy-lead">
            <p class="an-buy-line">${figText(result.impact.sentence)}</p>
            <p class="cap an-note">Consequences as of ${fmtDate(ctx.today, 'short')}, set out before the move. The choice is the owner’s.</p>
          </div>
          <ul class="rows an-buy-rows">
            ${result.rows.map((row) => html`<li class="row" data-key="${row.key}">
              <span class="row-label">${row.label}<em class="row-note">${row.note}</em></span>
              <span class="row-value">${row.value}</span>
            </li>`)}
          </ul>`
    : html`<div class="an-buy-lead"><p class="an-buy-line an-buy-idle">An amount shows what the move would do to the clock and the card.</p>
          <p class="cap an-note">Cash on hand is ${amt(ctx.d.clock.cash)}${ctx.d.clock.dueTotal > 0 ? html`, with ${amt(ctx.d.clock.dueTotal, { est: dueIsEstimate(ctx, ctx.d.clock) })} due ${dueWindow(ctx.d.clock, 'text', ctx.today)}` : ''}.${awaitedLine(ctx.d.clock, ctx.today)} Typing here is optional and saves nothing.</p></div>`}
      </div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------ the opponent */

function opponentSection(ctx) {
  const habits = ctx.state.habits || [];
  const matchStart = ctx.state.meta.matchStart;
  const segment = habits.filter((h) => h.from <= ctx.today).slice(-1)[0] || habits[0] || null;
  const edge = ctx.d.edge;
  const head = html`<div class="sec-head">
      <h2 class="lab" id="an-opp-h"><b>The opponent</b><i class="sep"></i>Habit</h2>
      <span class="lab">${segment ? 'in force since ' + fmtDate(segment.from, 'short') : 'not yet seated'}</span>
    </div>`;
  if (!segment) {
    const days = historyDays(ctx);
    return html`<section class="band an-opp" aria-labelledby="an-opp-h">${head}
      <p class="title title-s an-opp-title">You <i>v.</i> Habit</p>
      <p class="cap an-note">Habit is the average of your own convenience spending. It needs 14 full days of bank history, so the match begins on day ${matchFromDay(ctx)} on record; ${days} so far, as of ${fmtDate(ctx.today, 'short')}. Until then no round is scored.</p>
      <p class="an-opp-open"><button class="btn btn-s" type="button" data-action="app.sheet" data-sheet="habit">How Habit is set</button></p>
    </section>`;
  }
  return html`<section class="band an-opp" aria-labelledby="an-opp-h">${head}
    <p class="title title-s an-opp-title">You <i>v.</i> Habit</p>
    <p class="cap">Your own frozen baseline of convenience spending${segment.window ? html`, averaged over ${fmtDate(segment.window.from, 'short')} – ${fmtDate(segment.window.to, 'short')}` : ''}.</p>
    <div class="tally tally-s an-opp-tally">
      <div class="tally-item"><span class="lab">Workday</span>${money(segment.work)}<span class="cap">win at ${amt(segment.winWork, { decimals: 0 })} or less</span></div>
      <div class="tally-item"><span class="lab">Day off</span>${money(segment.off)}<span class="cap">win at ${amt(segment.winOff, { decimals: 0 })} or less</span></div>
      <div class="tally-item"><span class="lab">Kept v. Habit</span>${matchStart ? money(edge.kept, { est: true, signed: true }) : plainFig('—', { est: true })}<span class="cap">${matchStart ? 'since ' + fmtDate(matchStart, 'short') : 'no round yet'}</span></div>
    </div>
    <p class="cap an-note">Habit never changes by itself. A new opponent can be seated from the last 60 days; the kept total carries over.</p>
    <p class="an-opp-open"><button class="btn btn-s" type="button" data-action="app.sheet" data-sheet="habit">The opponent’s sheet</button></p>
  </section>`;
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  return html`<div class="an">
    ${abstract(ctx)}
    <div class="cols">${reserveSection(ctx)}${cardsSection(ctx)}</div>
    <div class="cols">${retentionSection(ctx)}${scenarioSection(ctx)}</div>
    <div class="cols">
      <div class="col col-5">${ladderSection(ctx)}${opponentSection(ctx)}</div>
      ${spendingSection(ctx)}
    </div>
    ${purchaseSection(ctx)}
  </div>`;
}

/* ----------------------------------------------------------------- actions */

/** Put a field back to what the document holds (the attribute the last render wrote). */
function restore(el, reason) {
  el.value = el.getAttribute('value') || '';
  if (reason) toast(reason);
}

const RANGE = {
  reserve: 'Not saved: the goal is an amount from $1 to $1,000,000,000.',
  takeHome: 'Not saved: the share is a whole number from 1 to 100.',
  money: 'Not saved: the amount is a number from $0 to $1,000,000,000.',
  target: 'Not saved: a target is an amount from $0.01 to $1,000,000,000.',
};

/** Parse a money field; null when it is not an amount in range. */
function readMoney(el, { min = 0 } = {}) {
  const cents = toCents(el.value);
  return cents == null || cents < min || cents > MAX_MONEY ? null : cents;
}

function setScenario(el, field) {
  if (field === 'horizon') {
    const months = Math.round(Number(el.value));
    if (!Number.isFinite(months) || months < 1 || months > MAX_HORIZON) return;
    store.update((s) => { s.scenario.horizonMonths = months; });
    return;
  }
  if (field === 'takeHome') {
    const pct = Number(String(el.value).replace(/[%\s]/g, ''));
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) { restore(el, RANGE.takeHome); return; }
    const share = Math.round(pct) / 100;
    store.update((s) => { s.scenario.takeHomeRatio = share; });
    el.value = String(Math.round(pct));
    return;
  }
  const cents = readMoney(el, { min: field === 'reserve' ? 100 : 0 });
  if (cents == null) { restore(el, field === 'reserve' ? RANGE.reserve : RANGE.money); return; }
  store.update((s) => {
    if (field === 'reserve') s.goals.reserve.target = cents;
    else if (field === 'toSavings') s.scenario.toSavings = cents;
    else if (field === 'improve') s.scenario.monthlyImprove = cents;
    else if (field === 'payment') s.scenario.cardPayment = cents;
  });
  el.value = fieldText(cents);
}

export const actions = {
  /** A scenario field or the reserve goal changed: save it to the document. data-field names it. */
  'analysis.set': ({ el, ev, data }) => {
    const target = el.matches('input') ? el : ev.target;
    if (!target || !('value' in target)) return;
    setScenario(target, data.field);
  },

  /** A quick amount for the scenario card payment. */
  'analysis.pay': ({ data }) => {
    const cents = Number(data.cents);
    if (!Number.isFinite(cents) || cents < 0) return;
    store.update((s) => { s.scenario.cardPayment = Math.round(cents); });
  },

  /** A category's monthly target changed; an empty field removes the target. */
  'analysis.target': ({ el, data }) => {
    const category = data.cat;
    if (!category || !CATEGORIES[category]) return;
    const text = String(el.value).trim();
    if (!text) {
      const had = context().state.settings.targets[category] != null;
      if (had) store.update((s) => { delete s.settings.targets[category]; });
      el.value = '';
      return;
    }
    const cents = readMoney(el, { min: 1 });
    if (cents == null) { restore(el, RANGE.target); return; }
    store.update((s) => { s.settings.targets[category] = cents; });
    el.value = fieldText(cents);
  },

  /** The purchase tool: the amount as typed (kept in the interface state only). */
  'analysis.buy-amount': ({ el }) => {
    store.setUi({ anBuy: { ...(store.ui.anBuy || {}), text: el.value } });
  },

  /** The purchase tool: an example amount. */
  'analysis.buy-quick': ({ data }) => {
    const cents = Number(data.cents);
    if (!Number.isFinite(cents) || cents <= 0) return;
    store.setUi({ anBuy: { ...(store.ui.anBuy || {}), text: fieldText(cents) } });
  },

  /** The purchase tool: from cash or on a card. */
  'analysis.buy-on': ({ ev }) => {
    const on = ev.target && ev.target.value === 'card' ? 'card' : 'cash';
    store.setUi({ anBuy: { ...(store.ui.anBuy || {}), on } });
  },

  /** The purchase tool: empty the amount. */
  'analysis.buy-clear': () => {
    store.setUi({ anBuy: { ...(store.ui.anBuy || {}), text: '' } });
  },
};
