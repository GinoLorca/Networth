/**
 * Imbalances (Chess words) / Cash flow (Finance words): money in and out, the first face of the Analysis cell.
 * The second face is today's Analysis (views/analysis.js); a two-option switch at the top of both moves between them.
 *
 * Sections, top to bottom (one column; from 1100px two, the queue and where it went beside the leaks and the bills):
 *   the face switch · the head and the period (30, 90 or 365 days, each against the window of the same length before)
 *   in and out      the split bar, money out and money in with their changes, paydays like with like, "Filed by you"
 *   the queue       the moves to file (model/flows.js moveQueue): one line that opens in place under 720px; from
 *                   720px three items and "+ All n". One tap files (the transaction sheet's own save sequence).
 *   where it went   by class, then category, each with its share and change; a category opens its merchants and its
 *                   monthly target (settings.targets, as Analysis kept it); top merchants; the cash caption
 *   leaks           fees and interest, the daily game, small and often, doubled, price rises; never added up
 *   the Book's bills  the lines that are not subscriptions, by cost a month, and "Open the Book"
 *
 * Honesty: a bank sum is roman; any figure holding a move not yet posted, a reported payment, or a figure scaled to a
 * month or a year is italic with ≈. Cover mode covers every amount (.fig, .row-value, data-fig); counts and shares
 * carry data-cover-keep. The route is #/flows; the period is its view parameter `p` (#/flows?p=90).
 *
 * Actions: flows.period · flows.queue (open the queue in place) · flows.queue-all · flows.file (one tap)
 */

import { html, cx } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { navigate, setParams } from '../router.js';
import { fmt, fmtSigned, fmtPct, fmtPlain } from '../model/money.js';
import { fmtDate, nowMs } from '../model/dates.js';
import { CADENCES, CATEGORIES, categoryLabel, klassLabel } from '../model/schema.js';
import { correctionReach } from '../model/classify.js';
import { PERIODS, STRAY, UNFILED, bookBills, fileItem, inAndOut, leaks, moveQueue, periodOf, whereItWent } from '../model/flows.js';
import { moveGlyph } from '../ui/glyphs.js';
import { money } from './parts.js';
import { sayHtml } from '../ui/say.js';
import { phrase, say } from '../model/words.js';

/** Items of the queue shown before "+ All n" (from 720px; under it, once opened). */
const QUEUE_FIRST = 3;

/* ----------------------------------------------------------------- helpers */

/** An amount inside a sentence, covered by cover mode; italic with ≈ when it is an estimate. */
function amt(cents, opts = {}) {
  const text = opts.signed ? fmtSigned(cents, { decimals: opts.decimals ?? 2 }) : fmt(cents, { decimals: opts.decimals ?? 2 });
  return html`<span class="${cx('nowrap', opts.est && 'est')}" data-fig>${opts.est ? '≈' : ''}${text}</span>`;
}

/** A count or a share that cover mode leaves readable. */
function keep(text) {
  return html`<span data-cover-keep>${text}</span>`;
}

/** A share in whole percent; a share too small to print says so. */
function pct(fraction, words) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  if (fraction > 0 && fraction < 0.005) return phrase('flows.pct.under', words);
  return fmtPct(fraction, 0);
}

function periodOfCtx(ctx) {
  return periodOf(ctx.route.params && ctx.route.params.p);
}

/** The change against the window before, in words: "+$212.00 on the 30 before"; "as in the 30 before" at zero. */
function changeWords(ctx, cents, days, est) {
  if (cents == null) return '';
  if (Math.round(cents) === 0) return say('flows.change.same', ctx.words, { days });
  return sayHtml('flows.change', ctx.words, { change: amt(cents, { signed: true, est }), days });
}

/** The face switch at the top of both faces: Imbalances / Cash flow, and Analysis. */
export function faceSwitch(current, words) {
  const opt = (id, href, label) => html`<a class="seg-opt" href="${href}" ${current === id ? html`aria-current="page"` : ''}>${label}</a>`;
  return html`<nav class="seg seg-block fl-faces" aria-label="${say('flows.faces', words)}">
    ${opt('flows', '#/flows', phrase('page.flows', words))}${opt('analysis', '#/analysis', phrase('page.analysis', words))}
  </nav>`;
}

/* -------------------------------------------------------------- the head */

function head(ctx, days, w) {
  return html`<section class="band fl-top" aria-labelledby="fl-h">
    <div class="sec-head sec-head-wrap">
      <h1 class="lab" id="fl-h"><b>${sayHtml('page.flows', ctx.words)}</b><i class="sep"></i>${sayHtml('flows.note', ctx.words)}</h1>
      <span class="lab">${say('flows.to', ctx.words, { date: fmtDate(ctx.today, 'short') })}</span>
    </div>
    <div class="fl-period">
      <span class="lab" id="fl-period-lab">${sayHtml('flows.period', ctx.words)}</span>
      <div class="seg seg-fig" role="radiogroup" aria-label="${say('flows.period.aria', ctx.words)}" data-change="flows.period">
        ${PERIODS.map((n) => html`<label class="seg-opt"><input type="radio" name="fl-period" value="${n}" ${n === days ? html`checked` : ''}><span>${n}</span></label>`)}
      </div>
      <span class="cap">${sayHtml('flows.period.days', ctx.words)}</span>
    </div>
    ${w.comparable ? '' : html`<p class="cap fl-short">${w.firstDay
      ? html`${say('flows.short', ctx.words, { date: fmtDate(w.firstDay, 'medium'), days })}${w.covered < days ? ' ' + say('flows.short.part', ctx.words, { days, covered: w.covered }) : ''}`
      : say('flows.short.none', ctx.words)}</p>`}
  </section>`;
}

/* ------------------------------------------------------------- in and out */

function inOutSection(ctx, io, days) {
  const out = io.out;
  const inn = io.in;
  const cover = !!ctx.state.settings.cover;
  const label = cover ? say('flows.io.split.cover', ctx.words) : say('flows.io.split', ctx.words, { out: fmt(out.cents), in: fmt(inn.cents) });
  const inNotes = [];
  const change = changeWords(ctx, inn.change, days, inn.est);
  if (change) inNotes.push(change);
  if (inn.pencil > 0) inNotes.push(sayHtml('flows.in.pencil', ctx.words, { amount: amt(inn.pencil, { est: true }) }));
  if (inn.cash > 0) inNotes.push(sayHtml('flows.in.cash', ctx.words, { amount: amt(inn.cash) }));
  // paydays like with like, source by source: a caption for each pay stream whose count differs, named when there are
  // several; "n paydays in each" only when every stream has as many as in the window before
  const p = io.paydays;
  const differ = p.before != null ? p.streams.filter((one) => one.extra !== 0) : [];
  if (p.before != null && p.now > 0 && !differ.length) inNotes.push(say('flows.paydays.same', ctx.words, { n: p.now }));
  const several = p.streams.length > 1;
  const paydayNotes = differ.map((one) => {
    const text = say(Math.abs(one.extra) === 1 ? 'flows.paydays.differ.one' : 'flows.paydays.differ.many', ctx.words, { now: one.now, before: one.before, days, extra: Math.abs(one.extra) });
    return several && one.name ? one.name + ': ' + text : text;
  });
  const join = (parts) => parts.map((part, i) => html`${i ? ' · ' : ''}${part}`);
  return html`<section class="band fl-io" aria-labelledby="fl-io-h">
    <div class="sec-head">
      <h2 class="lab" id="fl-io-h"><b>${sayHtml('flows.io', ctx.words)}</b><i class="sep"></i>${sayHtml('flows.io.last', ctx.words, { days })}</h2>
    </div>
    <figure class="split fl-split">
      <figcaption class="split-labs">
        <span><span class="lab"><b>${sayHtml('flows.io.outShort', ctx.words)}</b></span>${money(out.cents, { est: out.est })}</span>
        <span>${money(inn.cents, { est: inn.est })}<span class="lab"><b>${sayHtml('flows.io.inShort', ctx.words)}</b></span></span>
      </figcaption>
      <nw-split data-island mark="centre" a="${Math.max(0, Math.round(out.cents))}" b="${Math.max(0, Math.round(inn.cents))}" label="${label}"></nw-split>
    </figure>
    <ul class="rows rows-plain fl-io-rows">
      <li class="row">
        <span class="row-label">${sayHtml('flows.io.out', ctx.words)}${out.change != null ? html`<em class="row-note">${changeWords(ctx, out.change, days, out.est)}</em>` : ''}</span>
        <span class="${cx('row-value fig', out.est && 'est')}">${out.est ? html`<span class="approx">≈</span>` : ''}${fmt(out.cents)}</span>
      </li>
      <li class="row">
        <span class="row-label">${sayHtml('flows.io.in', ctx.words)}${inNotes.length ? html`<em class="row-note">${join(inNotes)}</em>` : ''}${paydayNotes.map((note) => html`<em class="row-note">${note}</em>`)}</span>
        <span class="${cx('row-value fig', inn.est && 'est')}">${inn.est ? html`<span class="approx">≈</span>` : ''}${fmt(inn.cents)}</span>
      </li>
      <li class="row">
        <span class="row-label">${sayHtml('flows.filed', ctx.words)}<em class="row-note">${sayHtml('flows.filed.note', ctx.words)}</em></span>
        <span class="row-value fl-pct" data-cover-keep>${io.filed == null ? say('flows.filed.none', ctx.words) : say('flows.filed.share', ctx.words, { pct: pct(io.filed, ctx.words) })}</span>
      </li>
    </ul>
    ${inn.pencil > 0 ? html`<p class="cap fl-note">${sayHtml('flows.in.pencilNote', ctx.words)}</p>` : ''}
  </section>`;
}

/* ---------------------------------------------------------------- the queue */

function queueItem(ctx, item) {
  const label = categoryLabel(item.guess);
  const why = item.guess === UNFILED
    ? say('flows.queue.uncat', ctx.words)
    : item.tier === 1 ? say('flows.queue.look', ctx.words, { category: label }) : say('flows.queue.guess', ctx.words, { category: label });
  // a money-out item whose refunds wait beside it says that its one tap files them too (they follow its rule, 3.3)
  const scope = item.catchAll ? say('flows.queue.one', ctx.words) : item.direction === 'in' ? say('flows.queue.refunds', ctx.words)
    : item.refunds > 0 ? say('flows.queue.all.refunds', ctx.words) : say('flows.queue.all', ctx.words);
  // the count and its sum stay together: when the line wraps, they wrap as one under the name
  return html`<li class="fl-q-item" data-key="${item.key}">
    <p class="fl-q-line">
      <span class="fl-q-name">${item.merchant || say('flows.queue.uncat', ctx.words)}</span>
      <span class="fl-q-fig"><span class="fl-q-n" data-cover-keep>${item.count}×</span><span class="fig fl-q-amt">${fmt(item.amount)}</span></span>
    </p>
    <p class="cap fl-q-why">${why} · ${scope} · ${say('flows.queue.last', ctx.words, { date: fmtDate(item.last, 'short') })}</p>
    <div class="chips fl-q-chips" role="group" aria-label="${item.merchant || say('flows.queue.uncat', ctx.words)}">
      ${item.chips.map((category, i) => html`<button class="${cx('chip', i === 0 && category === item.guess && 'fl-q-guess')}" type="button" data-action="flows.file" data-key="${item.key}" data-cat="${category}"
        aria-label="${say('flows.queue.chip.aria', ctx.words, { merchant: item.merchant, category: categoryLabel(category) })}">${i === 0 && category === item.guess ? '✓ ' : ''}${categoryLabel(category)}</button>`)}
      <button class="chip" type="button" data-action="app.sheet" data-sheet="tx" data-id="${item.txId}" aria-label="${say('flows.queue.more.aria', ctx.words, { merchant: item.merchant })}">${sayHtml('flows.queue.more', ctx.words)}</button>
    </div>
  </li>`;
}

function queueSection(ctx, q) {
  const ui = ctx.ui.flQueue || {};
  const open = !!ui.open;
  const all = !!ui.all;
  const n = q.items.length;
  const moves = q.moves === 1 ? phrase('flows.queue.moves.one', ctx.words) : say('flows.queue.moves.many', ctx.words, { n: q.moves });
  const items = n === 1 ? phrase('flows.queue.items.one', ctx.words) : say('flows.queue.items.many', ctx.words, { n });
  return html`<section class="${cx('band fl-q', open && 'is-open', all && 'is-all', !n && 'is-empty')}" id="fl-q" aria-labelledby="fl-q-h">
    <div class="sec-head fl-q-head">
      <h2 class="lab" id="fl-q-h"><b>${sayHtml('flows.queue', ctx.words)}</b><i class="sep"></i>${keep(say('flows.queue.count', ctx.words, { n }))}</h2>
      ${n ? html`<button class="btn-link fl-q-toggle" type="button" data-action="flows.queue" aria-expanded="${open ? 'true' : 'false'}" aria-controls="fl-q-body">${open ? sayHtml('flows.queue.close', ctx.words) : html`${sayHtml('flows.queue.open', ctx.words)} ›`}</button>` : ''}
    </div>
    ${n ? html`<div class="fl-q-body" id="fl-q-body">
      <p class="cap fl-q-lead">${sayHtml('flows.queue.lead', ctx.words, { moves: keep(moves), items: keep(items) })}</p>
      <ol class="fl-q-list">${q.items.map((item) => queueItem(ctx, item))}</ol>
      ${n > QUEUE_FIRST ? html`<p class="fl-q-more"><button class="btn-link" type="button" data-action="flows.queue-all" aria-expanded="${all ? 'true' : 'false'}" aria-controls="fl-q-body">${all ? say('flows.queue.fewer', ctx.words) : say('flows.queue.allN', ctx.words, { n })}</button></p>` : ''}
    </div>` : html`<p class="cap fl-q-none">${sayHtml('flows.queue.none', ctx.words)}</p>`}
  </section>`;
}

/* ----------------------------------------------------------- where it went */

/** The monthly target field, as Analysis had it: the same settings.targets and the same action (analysis.target). */
function targetField(ctx, category, target) {
  const value = Number.isFinite(target) ? fmtPlain(target, { decimals: target % 100 === 0 ? 0 : 2 }) : '';
  const width = Math.max(3, value.length) + 0.5;
  return html`<label class="an-set fl-target">
    <span class="lab">${sayHtml('flows.went.target', ctx.words)}</span>
    <span class="an-in" style="${'--w:' + width + ';--min:3'}">
      <span class="an-in-fix" aria-hidden="true">$</span>
      <input type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${value}" placeholder="—"
        aria-label="${say('flows.went.target.aria', ctx.words, { category: categoryLabel(category) })}" data-change="analysis.target" data-cat="${category}" ${value ? html`data-fig` : ''}>
    </span>
  </label>`;
}

function categoryRow(ctx, row, days, targets) {
  const target = Number.isFinite(targets[row.category]) ? targets[row.category] : null;
  // as Analysis read it: 30 days of spending against the month's target (a longer period is taken 30 days at a time)
  const ofTarget = target && row.amount > 0 ? pct(row.amount * 30 / days / target, ctx.words) : '';
  const cash = row.category === 'cash_withdrawal' && row.amount > 0;
  return html`<details class="fl-cat" data-key="${row.category}">
    <summary class="fl-cat-sum">
      <span class="fl-cat-name">${categoryLabel(row.category)}${cash ? html`<em class="row-note">${sayHtml('flows.went.cashRow', ctx.words)}</em>` : ''}${ofTarget && target ? html`<em class="row-note">${sayHtml('flows.went.target.of', ctx.words, { pct: keep(ofTarget) })}</em>` : ''}</span>
      <span class="${cx('fig fl-cat-amt', row.est && 'est')}">${row.est ? html`<span class="approx">≈</span>` : ''}${fmt(row.amount)}</span>
      <span class="fl-chg">${row.change != null ? amt(row.change, { signed: true, est: row.est }) : ''}</span>
      <span class="fl-share" style="${'--p:' + (Math.min(1, Math.max(0, row.share)) * 100).toFixed(1) + '%'}" aria-hidden="true"><i></i></span>
    </summary>
    <div class="fl-cat-body">
      ${row.merchants.length ? html`<ul class="fl-merchants" aria-label="${say('flows.went.merchants', ctx.words)}">
        ${row.merchants.map((m) => html`<li data-key="${m.mkey}"><span class="fl-m-name">${m.merchant || say('flows.queue.uncat', ctx.words)}</span><span class="fl-q-n" data-cover-keep>${m.count}×</span><span class="${cx('fig', m.est && 'est')}">${m.est ? html`<span class="approx">≈</span>` : ''}${fmt(m.amount)}</span></li>`)}
      </ul>` : ''}
      ${row.category !== UNFILED && CATEGORIES[row.category] ? targetField(ctx, row.category, target) : ''}
    </div>
  </details>`;
}

function wentSection(ctx, went, days) {
  const targets = ctx.state.settings.targets || {};
  const head = html`<div class="sec-head">
      <h2 class="lab" id="fl-went-h"><b>${sayHtml('flows.went', ctx.words)}</b><i class="sep"></i>${sayHtml('flows.went.note', ctx.words)}</h2>
      <span class="lab">${say('flows.io.last', ctx.words, { days })}</span>
    </div>`;
  if (!went.groups.length) {
    return html`<section class="band fl-went" aria-labelledby="fl-went-h">${head}<p class="cap">${sayHtml('flows.went.none', ctx.words, { days })}</p></section>`;
  }
  return html`<section class="band fl-went" aria-labelledby="fl-went-h">${head}
    <div class="fl-groups">
      ${went.groups.map((group) => html`<div class="fl-grp" data-key="${group.klass}">
        <p class="fl-grp-head">
          <span class="lab"><b>${group.klass === UNFILED ? sayHtml('flows.went.unfiled', ctx.words) : group.klass === STRAY ? sayHtml('flows.went.other', ctx.words) : klassLabel(group.klass, ctx.words)}</b></span>
          <span class="${cx('fig fl-cat-amt', group.est && 'est')}">${group.est ? html`<span class="approx">≈</span>` : ''}${fmt(group.amount)}</span>
          <span class="fl-chg">${group.klass === UNFILED
            ? html`<button class="btn-link" type="button" data-action="flows.queue" data-open="1">${sayHtml('flows.went.file', ctx.words)} ↑</button>`
            : group.change != null ? amt(group.change, { signed: true, est: group.est }) : ''}</span>
        </p>
        ${group.rows.map((row) => categoryRow(ctx, row, days, targets))}
      </div>`)}
    </div>
    <p class="fl-total">
      <span class="lab"><b>${sayHtml('flows.went.all', ctx.words)}</b></span>
      <span class="${cx('fig fl-cat-amt', went.est && 'est')}">${went.est ? html`<span class="approx">≈</span>` : ''}${fmt(went.total)}</span>
      <span class="fl-chg">${went.change != null ? amt(went.change, { signed: true, est: went.est }) : ''}</span>
    </p>
    ${went.top.length ? html`<p class="cap fl-top-m"><b class="lab">${sayHtml('flows.went.top', ctx.words)}</b> ${went.top.map((m, i) => html`${i ? ' · ' : ''}<span class="nowrap">${m.merchant}</span> ${keep(m.count + '×')} ${amt(m.amount, { est: m.est })}`)}</p>` : ''}
    ${went.cash > 0 ? html`<p class="cap fl-note">${sayHtml('flows.went.cash', ctx.words)}</p>` : ''}
    <p class="cap fl-note">${sayHtml('flows.went.foot', ctx.words)}</p>
  </section>`;
}

/* ------------------------------------------------------------------- leaks */

function leakRow(key, label, detail, figure, year) {
  return html`<li class="row fl-leak" data-key="${key}">
    <span class="row-label">${label}${detail ? html`<em class="row-note">${detail}</em>` : ''}</span>
    <span class="fl-leak-figs">${figure}${year}</span>
  </li>`;
}

function leakFig(cents, est) {
  return html`<span class="${cx('fig fl-leak-fig', est && 'est')}">${est ? html`<span class="approx">≈</span>` : ''}${fmt(cents, { decimals: 0 })}</span>`;
}

function yearFig(cents) {
  return html`<span class="fig est fl-leak-year"><span class="approx">≈</span>${fmt(cents, { decimals: 0 })}</span>`;
}

function leaksSection(ctx, l, days) {
  const rows = [];
  if (l.fees) {
    const glyph = l.fees.penalty ? html`${moveGlyph('??', { words: ctx.words })} ` : '';
    const parts = l.fees.parts.map((part, i) => html`${i ? ' · ' : ''}${part.label || say('flows.leak.fees.unnamed', ctx.words)} <span class="nowrap">${amt(part.cents)}${part.penalty ? html` ${moveGlyph('??', { words: ctx.words })}` : ''}</span>`);
    rows.push(leakRow('fees', html`${glyph}${sayHtml('flows.leak.fees', ctx.words)}`, parts, leakFig(l.fees.cents, l.fees.est), yearFig(l.fees.year)));
  }
  if (l.game) {
    const detail = html`${sayHtml('flows.leak.game.stops', ctx.words, { n: keep(String(l.game.stops)), mean: amt(l.game.mean, { decimals: 0 }) })}${l.game.change != null && Math.round(l.game.change) !== 0 ? html` · ${changeWords(ctx, l.game.change, days, l.game.est)}` : ''} · <a class="btn-link fl-inline-link" href="#/analysis">${sayHtml('flows.leak.game.link', ctx.words)}</a>`;
    rows.push(leakRow('game', sayHtml('flows.leak.game', ctx.words), detail, leakFig(l.game.cents, l.game.est), yearFig(l.game.year)));
  }
  if (l.small) {
    const detail = l.small.named.map((one, i) => html`${i ? ' · ' : ''}<span class="nowrap">${one.merchant} ${keep(one.count + '×')}</span>`);
    rows.push(leakRow('small', sayHtml('flows.leak.small', ctx.words), detail, leakFig(l.small.cents, l.small.est), yearFig(l.small.year)));
  }
  for (const d of l.doubled) {
    const name = d.kind === 'family' ? say('flows.family.' + d.name, ctx.words) : d.name;
    const detail = html`${d.lines.map((line, i) => html`${i ? ' · ' : ''}<span class="nowrap">${line.name}</span>`)}${d.kind === 'accounts' ? html` · ${say('flows.leak.doubled.accounts', ctx.words, { n: d.accounts })}` : ''}`;
    rows.push(leakRow('doubled:' + d.kind + ':' + d.name, html`${sayHtml('flows.leak.doubled', ctx.words)} · ${name}`, detail, leakFig(d.cents, d.est), yearFig(d.year)));
  }
  for (const r of l.rises) {
    // a rise read from a charge still pending is italic with ≈, as every figure holding an unposted move is
    const detail = sayHtml('flows.leak.rise.detail', ctx.words, { from: amt(r.from), to: amt(r.to, { est: r.est }), date: fmtDate(r.day, 'short') });
    const step = html`<span class="${cx('fig fl-leak-fig', r.est && 'est')}">${r.est ? html`<span class="approx">≈</span>` : ''}+${fmt(r.step)}</span>`;
    rows.push(leakRow('rise:' + r.id, html`${sayHtml('flows.leak.rise', ctx.words)} · ${r.name}`, detail, step, yearFig(r.year)));
  }
  return html`<section class="band fl-leaks" aria-labelledby="fl-leaks-h">
    <div class="sec-head">
      <h2 class="lab" id="fl-leaks-h"><b>${sayHtml('flows.leaks', ctx.words)}</b><i class="sep"></i>${sayHtml('flows.leaks.note', ctx.words)}</h2>
      <span class="lab fl-leak-cols"><span>${say('flows.io.last', ctx.words, { days })}</span><span>${say('flows.leaks.year', ctx.words)}</span></span>
    </div>
    ${rows.length ? html`<ul class="rows rows-plain fl-leak-rows">${rows}</ul>
      <p class="cap fl-note">${sayHtml('flows.leaks.overlap', ctx.words)}${l.doubled.length ? html` ${sayHtml('flows.leaks.use', ctx.words)}` : ''}</p>`
      : html`<p class="cap">${sayHtml('flows.leaks.none', ctx.words, { days })}</p>`}
  </section>`;
}

/* ------------------------------------------------------------- the bills */

/**
 * A bill's cadence, how its amount is known and its next day, as the Book says them: an amount is roman only where it is
 * labelled as the last one the bank reported ("as last charged"); a price that varies, or a line by hand not charged yet,
 * is an estimate (ARCHITECTURE 10 c).
 */
function billNote(ctx, line) {
  const cadence = CADENCES[line.cadence] ? CADENCES[line.cadence].label.toLowerCase() : '';
  const known = line.variable ? say('flows.bills.varies', ctx.words) : line.est ? say('flows.bills.expected', ctx.words) : say('flows.bills.last', ctx.words);
  const next = line.next ? say('flows.bills.next', ctx.words, { date: fmtDate(line.next, 'short') }) : '';
  return [cadence, known, next].filter(Boolean).join(' · ');
}

function billsSection(ctx, bills) {
  const head = html`<div class="sec-head">
      <h2 class="lab" id="fl-bills-h"><b>${sayHtml('flows.bills', ctx.words)}</b></h2>
      ${bills.count ? html`<span class="lab">${sayHtml('flows.bills.month', ctx.words, { amount: amt(bills.perMonth, { est: true, decimals: 0 }) })}</span>` : ''}
    </div>`;
  const more = bills.count - bills.lines.length;
  return html`<section class="band fl-bills" aria-labelledby="fl-bills-h">${head}
    ${bills.count ? html`<ul class="rows rows-plain">
      ${bills.lines.map((line) => html`<li class="row" data-key="${line.id}">
        <span class="row-label">${line.name}<em class="row-note">${billNote(ctx, line)}</em></span>
        <span class="${cx('row-value fig', line.est && 'est')}">${line.est ? html`<span class="approx">≈</span>` : ''}${fmt(line.amount)}</span>
      </li>`)}
    </ul>` : html`<p class="cap">${sayHtml('flows.bills.none', ctx.words)}</p>`}
    <p class="cap fl-note">${more > 0 ? html`${say('flows.bills.more', ctx.words, { n: more })}. ` : ''}${sayHtml('flows.bills.subs', ctx.words)} <a class="btn-link fl-inline-link" href="#/book">${sayHtml('flows.bills.open', ctx.words)}</a></p>
  </section>`;
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const days = periodOfCtx(ctx);
  const opts = { ledger: ctx.d.ledger };
  const io = inAndOut(ctx.state, ctx.now, days, opts);
  const q = moveQueue(ctx.state, ctx.now, opts);
  const went = whereItWent(ctx.state, ctx.now, days, opts);
  const l = leaks(ctx.state, ctx.now, days, opts);
  const bills = bookBills(ctx.state, ctx.today);
  return html`<div class="fl">
    ${faceSwitch('flows', ctx.words)}
    ${head(ctx, days, io.window)}
    <div class="cols fl-cols">
      <div class="col col-7">${inOutSection(ctx, io, days)}${queueSection(ctx, q)}${wentSection(ctx, went, days)}</div>
      <div class="col col-5">${leaksSection(ctx, l, days)}${billsSection(ctx, bills)}</div>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- actions */

function undoLast() {
  const label = store.undo();
  if (label) toast(say('flows.undone', (context() || {}).words, { what: String(label).replace(/[.]+$/, '') }));
}

export const actions = {
  /** The period: 30, 90 or 365 days, kept in the address (#/flows?p=90). */
  'flows.period': ({ ev }) => {
    const value = ev && ev.target ? ev.target.value : null;
    const days = periodOf(value);
    setParams({ p: days === 30 ? null : String(days) });
  },
  /** Under 720px the queue is one line that opens in place; "File ↑" in Where it went opens it too. */
  'flows.queue': ({ data }) => {
    const ui = store.ui.flQueue || {};
    const open = data && data.open === '1' ? true : !ui.open;
    store.setUi({ flQueue: { ...ui, open } });
    // the Board's line leads here (data-go) and opens the queue in place
    if (data && data.go) navigate(data.go);
    if (open && data && data.open === '1' && typeof document !== 'undefined') {
      const go = () => { const el = document.getElementById('fl-q'); if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' }); };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(go)); else go();
    }
  },
  /** "+ All n": every item of the queue, or back to three. */
  'flows.queue-all': () => {
    const ui = store.ui.flQueue || {};
    store.setUi({ flQueue: { ...ui, open: true, all: !ui.all } });
  },
  /** One tap: file the item to the category, through the transaction sheet's own save sequence, in one undoable update. */
  'flows.file': ({ data }) => {
    const ctx = context();
    if (!ctx || !data || !data.key || !CATEGORIES[data.cat]) return;
    const item = moveQueue(ctx.state, ctx.now, { ledger: ctx.d.ledger }).items.find((one) => one.key === data.key);
    if (!item) return;
    const tx = ctx.state.txs.find((one) => one.id === item.txId);
    const reach = tx ? correctionReach(ctx.state, tx) : { count: item.count };
    const words = phrase('flows.undo.filed', ctx.words);
    const at = nowMs();
    let done = false;
    store.update((s) => { done = fileItem(s, item, data.cat, at, ctx.now).filed; }, { undo: words });
    if (!done) { if (store.undoLabel === words) store.undo(); return; }
    const vars = { merchant: item.merchant, category: categoryLabel(data.cat) };
    const counted = reach.count === 1 ? phrase('flows.queue.moves.one', ctx.words) : say('flows.queue.moves.many', ctx.words, { n: reach.count });
    // the refunds that followed the money-out rule are named apart, as the transaction sheet's toast names them (3.3)
    const refunds = !item.catchAll && item.direction !== 'in' && !reach.kept ? reach.refunds || 0 : 0;
    const message = item.catchAll
      ? say('flows.toast.one', ctx.words, vars)
      : refunds > 0
        ? say('flows.toast.all.outRefunds', ctx.words, {
          ...vars, count: counted,
          refunds: refunds === 1 ? phrase('tx.toast.refundCount.one', ctx.words) : say('tx.toast.refundCount.many', ctx.words, { count: refunds }),
        })
        : say('flows.toast.all.' + (item.direction === 'in' ? 'in' : 'out'), ctx.words, { ...vars, count: counted });
    toast(message, { action: phrase('flows.undo', ctx.words), onAction: undoLast });
  },
};
