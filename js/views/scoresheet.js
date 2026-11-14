/**
 * The Scoresheet: one month of rounds and moves.
 *
 *   #/scoresheet                 this month
 *   #/scoresheet/2026-05         another month (only months that have transactions are offered)
 *   ?filter=game|want|need|book|income|review   (absent = all)
 *   ?purpose=work                one purpose only
 *   ?account=acc_…               one account only (kept when stepping to another month)
 *   ?q=deli                      merchant search
 *   ?day=2026-06-09              the round to bring into view (once) and mark
 *
 * On screen, top to bottom: the month head with its crosstable, the month review (a margin column on
 * wide screens), the filters, then the rounds, newest first. A round's rubric opens the day sheet;
 * a move opens the tx sheet (both through app.sheet).
 *
 * Actions: scoresheet.filter · scoresheet.look · scoresheet.purpose · scoresheet.search · scoresheet.clear
 */

import { html, cx, define, prefersReducedMotion } from '../ui/dom.js';
import { fmt, fmtSigned } from '../model/money.js';
import { fmtDate, fmtMonth, addDays, monthOf, daysInMonth, parts as ymdParts } from '../model/dates.js';
import { PURPOSES, accountShort } from '../model/schema.js';
import { moveGlyph, resultMark } from '../ui/glyphs.js';
import { icon } from '../ui/icons.js';
import { setParams } from '../router.js';
import { crosstable, movesList, worstGlyph, scoreOf, statusLine, colourOf, inlineMoney, flowLookups } from './parts.js';

const FILTERS = [['all', 'All'], ['game', 'Convenience'], ['want', 'Extras'], ['need', 'Necessary'], ['book', 'Book'], ['income', 'Income']];
const FILTER_KEYS = new Set(['game', 'want', 'need', 'book', 'income', 'review']);
const FILTER_WORDS = { game: 'Convenience', want: 'Extras', need: 'Necessary', book: 'Book', income: 'Income', review: 'Needs a look' };
/** The words of the key to symbols, in the order the review counts them. */
const GLYPH_WORDS = [['!!', 'clean sheet'], ['!', 'good'], ['!?', 'judged by its return'], ['?!', 'dubious'], ['?', 'mistake'], ['??', 'penalty'], ['□', 'only move']];
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

/** An annotation's reason with its amounts taken out (cover mode: the reason is printed by a shared partial). */
function withoutAmounts(why) {
  let s = String(why).replace(/ of [+−-]?\$\d[\d,]*(?:\.\d+)?/g, '');
  const colon = s.indexOf(': ');
  if (colon >= 0 && s.slice(colon).includes('$')) s = s.slice(0, colon);
  return s.replace(MONEY, '—');
}

/**
 * The annotations of a round's moves as the moves list wants them: each reason closed with a full stop
 * (the list sets the category after it), and without amounts while figures are covered.
 */
function notesFor(annotations, covered) {
  const out = new Map();
  for (const [id, a] of annotations) {
    const why = covered ? withoutAmounts(a.why) : String(a.why);
    out.set(id, { ...a, why: /[.!?]$/.test(why) ? why : why + '.' });
  }
  return out;
}

/**
 * The annotations of a round as the sheet prints them. Before the match began nothing was played against
 * Habit, so the marks of the daily game (stacked stops, declined purchases, the round's own) are left out;
 * what does not depend on the match still prints: a penalty, an only move, a business purchase, the owner's own mark.
 */
function marksOf(ctx, round) {
  const ann = ctx.d.annotations(round.day);
  if (round.status !== 'prematch') return ann;
  const byId = new Map(round.moves.map((tx) => [tx.id, tx]));
  const moves = new Map();
  for (const [id, a] of ann.moves) {
    const tx = byId.get(id);
    if (a.manual || (tx && tx.klass !== 'game')) moves.set(id, a);
  }
  return { moves, round: null };
}

function validMonth(seg) {
  return typeof seg === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(seg);
}

function validDay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Months that have at least one transaction, oldest first. */
function monthsOnRecord(state) {
  const seen = new Set();
  for (const tx of state.txs) if (typeof tx.day === 'string' && tx.day.length >= 7) seen.add(tx.day.slice(0, 7));
  return [...seen].sort();
}

function isQuiet(tx) {
  return tx.kind === 'transfer' || tx.kind === 'payment';
}

function inFilter(tx, filter) {
  switch (filter) {
    case 'all': return true;
    case 'review': return !!tx.review && tx.kind !== 'decline';
    case 'income': return tx.kind === 'income';
    case 'game': return tx.klass === 'game' && (tx.kind === 'spend' || tx.kind === 'refund' || tx.kind === 'decline');
    default: return tx.klass === filter && (tx.kind === 'spend' || tx.kind === 'refund');
  }
}

function matchesQuery(tx, needle) {
  if (!needle) return true;
  return [tx.merchant, tx.raw, tx.note, tx.reportedAs].some((s) => typeof s === 'string' && s.toLowerCase().includes(needle));
}

function href(ym, params) {
  let out = '#/scoresheet/' + ym;
  const q = [];
  for (const k in params || {}) if (params[k]) q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  return q.length ? out + '?' + q.join('&') : out;
}

/** What the page reads from the route, cleaned. */
function readRoute(ctx) {
  const thisMonth = monthOf(ctx.today);
  const seg = ctx.route.segs[0];
  const p = ctx.route.params || {};
  const purposes = ctx.state.settings.purposes || {};
  return {
    thisMonth,
    ym: validMonth(seg) ? seg : thisMonth,
    filter: FILTER_KEYS.has(p.filter) ? p.filter : 'all',
    purpose: PURPOSES.includes(p.purpose) && purposes[p.purpose] ? p.purpose : '',
    q: typeof p.q === 'string' ? p.q : '',
    account: typeof p.account === 'string' && ctx.state.accounts.some((a) => a && a.id === p.account && !a.hidden) ? p.account : '',
    day: validDay(p.day) ? p.day : '',
  };
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const view = readRoute(ctx);
  const { ym, thisMonth } = view;
  const month = ctx.d.month(ym);
  const onRecord = monthsOnRecord(ctx.state);
  const matchStart = ctx.state.meta.matchStart;
  const shown = month.rounds.filter((r) => r.day <= ctx.today).reverse();
  const needle = view.q.trim().toLowerCase();
  const active = view.filter !== 'all' || !!view.purpose || !!needle || !!view.account;

  // every move of the month that can appear on the sheet, by round
  const all = shown.map((round) => ({ round, moves: round.moves.filter((tx) => !tx.matchId) }));
  const lookCount = all.reduce((n, r) => n + r.moves.filter((tx) => inFilter(tx, 'review')).length, 0);
  const listed = all.map(({ round, moves }) => ({
    round,
    moves: moves.filter((tx) => inFilter(tx, view.filter) && (!view.purpose || tx.purpose === view.purpose) && (!view.account || tx.accountId === view.account) && matchesQuery(tx, needle)),
  }));
  // a filter hides the days it empties; a past month with no move at all prints one sentence instead of its blank days
  const blank = ym !== thisMonth && !all.some((r) => r.moves.length);
  const visible = active ? listed.filter((r) => r.moves.length) : blank ? [] : listed;
  const target = view.day && visible.some((r) => r.round.day === view.day) ? view.day : '';

  return html`<article class="ss">
    ${monthHead(ctx, view, month, onRecord, matchStart)}
    <div class="ss-body">
      ${reviewBlock(ctx, view, month, matchStart, onRecord)}
      <section class="ss-main" aria-labelledby="ss-rounds-h">
        <div class="sec-head">
          <h2 class="lab" id="ss-rounds-h"><b>Rounds</b><i class="sep"></i>${fmtMonth(ym)}</h2>
          <span class="lab">Newest first</span>
        </div>
        ${filterBar(ctx, view, lookCount)}
        ${active ? summaryLine(ctx, view, visible) : ''}
        ${!active && ym === thisMonth ? nextRound(ctx) : ''}
        ${visible.length
          ? html`<div class="ss-rounds">${visible.map((r) => roundBlock(ctx, r.round, r.moves, r.round.day === target))}</div>`
          : emptyRounds(ctx, view, active, onRecord)}
      </section>
    </div>
    ${target ? html`<nw-goto data-island target="${'rd-' + target}" hidden></nw-goto>` : ''}
  </article>`;
}

/* -------------------------------------------------------------- month head */

function monthHead(ctx, view, month, onRecord, matchStart) {
  const { ym, thisMonth } = view;
  const prev = onRecord.filter((m) => m < ym).pop() || null;
  const next = onRecord.find((m) => m > ym && m <= thisMonth) || (ym < thisMonth ? thisMonth : null);
  const glyphOf = (day) => worstGlyph(ctx.d.annotations(day));
  return html`<header class="band ss-head">
    <div class="sec-head">
      <p class="lab"><b>Scoresheet</b><span class="not-phone"><i class="sep"></i>rounds and moves</span></p>
      <nav class="ss-months" aria-label="Months">
        ${prev ? html`<a class="btn-link" href="${href(prev, { account: view.account })}">${icon('chevron-left')}${fmtMonth(prev, 'short')}</a>` : onRecord[0] === ym ? html`<span class="lab ss-months-end not-phone">First month on record</span>` : ''}
        ${next ? html`<a class="btn-link" href="${href(next, { account: view.account })}">${fmtMonth(next, 'short')}${icon('chevron-right')}</a>` : ''}
        ${ym !== thisMonth && next !== thisMonth ? html`<a class="btn-link" href="#/scoresheet">This month</a>` : ''}
      </nav>
    </div>
    <h1 class="title title-l ss-title">${fmtMonth(ym)}</h1>
    <p class="cap ss-lede">${headLine(ctx, view, month, matchStart, onRecord)}</p>
    ${crosstable(month, { today: ctx.today, glyphOf, note: tableNote(ctx, view, month, matchStart), cover: !!ctx.state.settings.cover })}
  </header>`;
}

function headLine(ctx, view, month, matchStart, onRecord) {
  const { ym, thisMonth } = view;
  const days = daysInMonth(ym);
  if (ym > thisMonth) return fmtMonth(ym) + ' has not begun.';
  if (onRecord.length && ym < onRecord[0]) return 'The bank feed begins in ' + fmtMonth(onRecord[0]) + ': no move is on record for ' + fmtMonth(ym) + '.';
  if (!matchStart) return 'The match has not begun: it begins on day ' + ctx.d.matchFromDay + ' on record; ' + ctx.d.historyDays + ' so far. Until then the days are listed without a result.';
  if (monthOf(matchStart) > ym) return 'Before the match began on ' + fmtDate(matchStart, 'full') + ': the results of ' + fmtMonth(ym, 'name') + ' are an exhibition and are not counted.';
  const scored = month.played === 1 ? '1 round scored' : month.played + ' rounds scored';
  const began = monthOf(matchStart) === ym ? ' The match began on ' + fmtDate(matchStart, 'short') + '.' : '';
  if (ym === thisMonth) return 'Round ' + ymdParts(ctx.today).d + ' of ' + days + ' is in progress; ' + scored + ', ' + month.finals + ' of them final.' + began;
  return days + ' days, ' + scored + ', ' + month.finals + ' of them final.' + began;
}

function tableNote(ctx, view, month, matchStart) {
  const bits = [];
  const pencil = month.rounds.filter((r) => r.status === 'provisional').map((r) => r.n);
  if (pencil.length === 1) bits.push('Round ' + pencil[0] + ' is in pencil until the bank finishes reporting the day.');
  else if (pencil.length > 1) bits.push('Rounds ' + pencil.slice(0, -1).join(', ') + ' and ' + pencil[pencil.length - 1] + ' are in pencil until the bank finishes reporting them.');
  if (matchStart && monthOf(matchStart) === view.ym && ymdParts(matchStart).d > 1) bits.push('Rounds before ' + fmtDate(matchStart, 'short') + ' are set back: an exhibition, not counted.');
  bits.push('Shaded rounds are days off, played with White.');
  return bits.join(' ');
}

/* ------------------------------------------------------------ month review */

function reviewItem(key, label, body) {
  return html`<div class="ss-rv" data-key="${key}"><dt class="lab"><b>${label}</b></dt><dd>${body}</dd></div>`;
}

function dayLink(ym, day) {
  return html`<a href="${href(ym, { day })}">${fmtDate(day, 'dowshort')}</a>`;
}

const AMOUNT_IN_SENTENCE = /(\u2248\s?)?[+\u2212-]?\$\d[\d,]*(?:\.\d+)?[KM]?/g;

/**
 * The net-worth line of the review. Its figures are the smoothed ones (pay earned and bills used day
 * by day, accounts kept by hand at the owner's estimate), so they are set as estimates; and for the
 * month in progress the closing figure is the live one, floored to the cent it has reached, exactly
 * as the Board's hero prints it.
 */
function worthLine(ctx, review, ym) {
  const text = String(review.netWorth && review.netWorth.sentence ? review.netWorth.sentence : '');
  const pos = ctx.d.position;
  const current = ym === monthOf(ctx.today);
  const byHand = ctx.state.accounts.some((account) => account && !account.hidden && account.source === 'manual');
  // R4b: a month in progress made only of posted rows and reported balances is roman, as the Board's "This month" is
  const est = (!current && !review.complete) || !!pos.smoothing || pos.provisional > 0 || pos.provisionalIn > 0 || byHand;
  if (!est) return figured(text);
  const found = [...text.matchAll(AMOUNT_IN_SENTENCE)];
  const live = current && found.length > 1 && Number.isFinite(pos.live) ? fmt(Math.floor(pos.live)) : null;
  const out = [];
  let last = 0;
  found.forEach((m, i) => {
    if (m.index > last) out.push(text.slice(last, m.index));
    const shown = i === found.length - 1 && live ? live : m[0].replace(/^\u2248\s?/, '');
    out.push(html`<span data-fig class="est">\u2248${shown}</span>`);
    last = m.index + m[0].length;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function reviewBlock(ctx, view, month, matchStart, onRecord) {
  const { ym, thisMonth } = view;
  const name = fmtMonth(ym, 'name');
  // a month the bank feed does not cover has nothing to review: one sentence, no figures carried over from elsewhere
  const outside = ym > thisMonth ? fmtMonth(ym) + ' has not begun; its review prints from the first day of the month.'
    : !onRecord.length ? 'The review prints once the bank has reported the first moves.'
      : ym < onRecord[0] ? 'The bank feed begins in ' + fmtMonth(onRecord[0]) + '; nothing is on record for ' + fmtMonth(ym) + '.'
        : '';
  if (outside) {
    return html`<aside class="ss-side" aria-labelledby="ss-review-h">
      <div class="sec-head">
        <h2 class="lab" id="ss-review-h"><b>Month review</b><i class="sep"></i>${name}</h2>
        <span class="lab">${ym > thisMonth ? 'not begun' : 'not on record'}</span>
      </div>
      <p class="cap ss-review-none">${outside}</p>
    </aside>`;
  }
  const review = ctx.d.review(ym);
  const sc = review.score;
  const rv = review.review;
  const cardHigher = !!review.card && review.card.change > 0;
  const items = [];

  // 1. the card verdict
  items.push(reviewItem('card', 'Card', review.card
    ? figured(review.card.sentence)
    : 'No card balance is on record for ' + name + '.'));
  // 2. cash, 3. net worth
  items.push(reviewItem('cash', 'Cash', figured(review.cash.sentence)));
  items.push(reviewItem('worth', 'Net worth', worthLine(ctx, review, ym)));

  // 4. the score
  if (sc.played > 0) {
    const split = html`With Black <span class="fig" data-cover-keep>${sc.black.played ? scoreOf(sc.black.score, sc.black.played) : '—'}</span>,
      with White <span class="fig" data-cover-keep>${sc.white.played ? scoreOf(sc.white.score, sc.white.played) : '—'}</span>;
      ${inlineMoney(sc.kept, { signed: true, est: month.rounds.some((r) => r.result != null && (r.status === 'provisional' || r.status === 'live')) })} kept against habit.`;
    items.push(reviewItem('score', 'Score', html`${cardHigher
      ? html`<span class="ss-rv-plain">Score <span class="fig" data-cover-keep>${scoreOf(sc.score, sc.played)}</span>.</span> `
      : html`<span class="fig fig-xl ss-rv-score" data-cover-keep>${scoreOf(sc.score, sc.played)}</span>`}
      <span class="ss-rv-line">${split}</span>
      ${review.scale ? html`<span class="cap ss-rv-line">${figured(review.scale)}</span>` : ''}`));
  } else {
    items.push(reviewItem('score', 'Score', noScoreLine(ctx, view, matchStart)));
  }

  if (sc.played > 0) {
    // 5. annotation counts
    const counted = GLYPH_WORDS.filter(([g]) => rv.counts[g] > 0);
    items.push(reviewItem('symbols', 'Annotations', counted.length
      ? html`<span class="ss-counts">${counted.map(([g, word]) => html`<span class="ss-count">${moveGlyph(g)}<span class="fig" data-cover-keep>${rv.counts[g]}</span> ${word}</span>`)}</span>`
      : 'No move or round of ' + name + ' carries a symbol.'));
    // 6. the best move, 7. the costliest move
    items.push(reviewItem('best', 'Best move', rv.best
      ? html`${figured(rv.best.text)}, ${dayLink(ym, rv.best.day)}.`
      : 'No round of ' + name + ' has a result yet.'));
    items.push(reviewItem('costliest', 'Costliest move', rv.costliest
      ? html`${rv.costliest.text}, <span data-fig>${fmt(rv.costliest.amount)}</span>, ${dayLink(ym, rv.costliest.day)}.`
      : 'No convenience purchase is on the sheet for ' + name + '.'));
    // 8. prepared against unprepared
    items.push(reviewItem('prepared', 'Preparation', rv.prepared.rounds
      ? html`With a morning plan: <span class="fig" data-cover-keep>${scoreOf(rv.prepared.score, rv.prepared.rounds)}</span>.
          Without one: <span class="fig" data-cover-keep>${rv.unprepared.rounds ? scoreOf(rv.unprepared.score, rv.unprepared.rounds) : '—'}</span>.`
      : html`No round of ${name} had a morning plan; unprepared rounds scored <span class="fig" data-cover-keep>${scoreOf(rv.unprepared.score, rv.unprepared.rounds)}</span>.`));
    // 9. stacked stops
    items.push(reviewItem('stacked', 'Stacked stops', rv.stackedDays
      ? html`${rv.stackedDays === 1 ? '1 day' : rv.stackedDays + ' days'} with a second or later unplanned stop; those stops cost <span data-fig>${fmt(rv.stackedCost)}</span>.`
      : 'No day of ' + name + ' had a second unplanned stop.'));
  }

  const state = review.complete ? 'the month, complete' : 'so far';
  return html`<aside class="ss-side" aria-labelledby="ss-review-h">
    <div class="sec-head">
      <h2 class="lab" id="ss-review-h"><b>Month review</b><i class="sep"></i>${name}</h2>
      <span class="lab">${state}</span>
    </div>
    <dl class="ss-review">${items}</dl>
    ${cardHigher && sc.played > 0 ? html`<p class="cap ss-review-note">The card ended ${name} higher than it began, so the score is printed plainly.</p>` : ''}
  </aside>`;
}

function noScoreLine(ctx, view, matchStart) {
  const name = fmtMonth(view.ym, 'name');
  if (!matchStart) {
    return 'Not scored yet: the match begins on day ' + ctx.d.matchFromDay + ' on record; ' + ctx.d.historyDays + ' so far. '
      + 'The score, the symbols and the best and costliest moves print here from then.';
  }
  if (monthOf(matchStart) > view.ym) return name + ' was played before the match began on ' + fmtDate(matchStart, 'full') + ': no score is kept for it.';
  return 'No round of ' + name + ' has a result yet; the first prints once the bank has reported a whole day.';
}

/* ----------------------------------------------------------------- filters */

function filterBar(ctx, view, lookCount) {
  const purposes = ctx.state.settings.purposes || {};
  // the accounts the bank reports (and any kept by hand that hold moves): one chip each, to see one account alone
  const withMoves = new Set(ctx.state.txs.map((tx) => tx.accountId));
  const accounts = ctx.state.accounts.filter((account) => account && !account.hidden && withMoves.has(account.id));
  return html`<div class="ss-filters">
    <div class="seg ss-seg" role="radiogroup" aria-label="Class of move">
      ${FILTERS.map(([key, label]) => html`<label class="seg-opt"><input type="radio" name="ss-filter" value="${key}" data-change="scoresheet.filter" ${view.filter === key ? html`checked` : ''}><span>${label}</span></label>`)}
    </div>
    <label class="field ss-search">
      <span class="vh">Search by merchant</span>
      <input class="input" type="search" name="q" value="${view.q}" placeholder="Search a merchant" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" data-input="scoresheet.search">
    </label>
    <div class="chips ss-chips" role="group" aria-label="Purpose and review">
      ${PURPOSES.filter((p) => purposes[p]).map((p) => html`<button class="chip" type="button" data-action="scoresheet.purpose" data-purpose="${p}" aria-pressed="${view.purpose === p ? 'true' : 'false'}">${purposes[p]}</button>`)}
      <button class="chip ss-look" type="button" data-action="scoresheet.look" aria-pressed="${view.filter === 'review' ? 'true' : 'false'}">Needs a look (${lookCount})</button>
    </div>
    ${accounts.length > 1 ? html`<div class="chips ss-chips ss-accounts" role="group" aria-label="Account">
      ${accounts.map((account) => html`<button class="chip" type="button" data-action="scoresheet.account" data-account="${account.id}" aria-pressed="${view.account === account.id ? 'true' : 'false'}">${accountShort(account)}</button>`)}
    </div>` : ''}
  </div>`;
}

function summaryLine(ctx, view, visible) {
  let count = 0;
  let out = 0;
  let inn = 0;
  for (const { moves } of visible) {
    for (const tx of moves) {
      count++;
      if (tx.kind === 'spend') out += tx.amount;
      else if (tx.kind === 'refund') out -= tx.amount;
      else if (tx.kind === 'income') inn += tx.amount;
    }
  }
  const words = [];
  if (view.filter !== 'all') words.push(FILTER_WORDS[view.filter]);
  if (view.purpose) words.push((ctx.state.settings.purposes || {})[view.purpose] || view.purpose);
  if (view.account) { const account = ctx.d.account(view.account); if (account) words.push(accountShort(account)); }
  if (view.q.trim()) words.push('“' + view.q.trim() + '”');
  return html`<p class="ss-summary" aria-live="polite">
    <span class="cap">${words.join(' · ')}: <i data-cover-keep>${count}</i> ${count === 1 ? 'move' : 'moves'}${count ? ' on ' + visible.length + (visible.length === 1 ? ' day' : ' days') + ' of ' : ' in '}${fmtMonth(view.ym, 'name')}${out
      ? html`, <i data-fig>${fmt(out)}</i> spent` : ''}${inn ? html`, <i data-fig>${fmt(inn)}</i> received` : ''}.</span>
    <button class="btn-link" type="button" data-action="scoresheet.clear">Show all</button>
  </p>`;
}

function emptyRounds(ctx, view, active, onRecord) {
  const name = fmtMonth(view.ym);
  if (active) {
    return html`<div class="empty empty-plain ss-empty">
      <p class="empty-title">No move of ${fmtMonth(view.ym, 'name')} matches.</p>
      <p class="cap">The filter is the only thing hiding the ${view.ym === view.thisMonth ? 'rounds so far' : 'rounds'}; the sheet itself is unchanged.</p>
    </div>`;
  }
  const latest = onRecord.length ? onRecord[onRecord.length - 1] : null;
  return html`<div class="empty empty-plain ss-empty">
    <p class="empty-title">Nothing is on the sheet for ${name}.</p>
    <p class="cap">${view.ym > view.thisMonth
      ? 'Rounds print here from the first day of the month.'
      : latest ? html`The bank feed reaches back to ${fmtMonth(onRecord[0])}; the latest moves are in <a href="${href(latest)}">${fmtMonth(latest)}</a>.`
        : 'Moves print here once the bank reports them.'}</p>
  </div>`;
}

/* ------------------------------------------------------------------ rounds */

/** The empty next row of the scoresheet: tomorrow's round, where a bye can be declared ahead. */
function nextRound(ctx) {
  if (!ctx.state.meta.matchStart) return '';
  const day = addDays(ctx.today, 1);
  const round = ctx.d.round(day);
  return html`<button class="ss-next" type="button" data-action="app.sheet" data-sheet="day" data-day="${day}">
    <span class="lab"><b>Round ${round.n}</b><i class="sep"></i>${fmtDate(day, 'dowshort')}<i class="sep"></i>${colourOf(round)}</span>
    <span class="cap">${round.bye ? 'A half-point bye is declared.' : 'Not yet played. The day type or a bye can be set ahead.'}</span>
  </button>`;
}

function marginOf(round) {
  const s = round.status;
  if (s === 'awaiting' || s === 'future') return '';
  const pencil = s !== 'final';
  const figure = html`<span class="${cx('fig', pencil && 'est')}">${pencil && s !== 'prematch' ? html`<span class="approx">≈</span>` : ''}${fmtSigned(round.kept)}</span>`;
  if (s === 'prematch') {
    if (round.habit) return html`<span class="ss-rd-margin is-set-back">${figure} against habit</span>`;
    // no habit in force yet: the day's convenience spending as the bank reported it, with no result
    return round.conv > 0 ? html`<span class="ss-rd-margin is-set-back"><span class="fig">${fmt(round.conv)}</span> convenience</span>` : '';
  }
  if (s === 'live') return html`<span class="ss-rd-margin">${figure} so far</span>`;
  return html`<span class="ss-rd-margin">${figure}${round.kept >= 0 ? ' kept' : ''}</span>`;
}

function roundBlock(ctx, round, moves, isTarget) {
  const day = round.day;
  const record = ctx.state.days[day] || null;
  const prematch = round.status === 'prematch';
  const ann = marksOf(ctx, round);
  const notes = notesFor(ann.moves, !!ctx.state.settings.cover);
  const main = moves.filter((tx) => !isQuiet(tx));
  const quiet = moves.filter(isQuiet);

  const lines = [];
  if (ann.round) lines.push(html`<span class="ss-rd-line" data-key="ann">${moveGlyph(ann.round.glyph)} ${figured(ann.round.why)}.</span>`);
  if (round.bye) lines.push(html`<span class="ss-rd-line" data-key="bye">A half-point bye, declared ahead; the dollars still count.</span>`);
  // a day before the match says so once, in the month head; its rubric stays bare
  if (round.status !== 'final' && !prematch) lines.push(html`<span class="ss-rd-line" data-key="status">${statusLine(round)}</span>`);
  if (record && record.note) lines.push(html`<span class="ss-rd-line ss-rd-own" data-key="note">${record.note}</span>`);

  const label = prematch
    ? html`<b>${fmtDate(day, 'dowshort')}</b><i class="sep"></i>${colourOf(round)}`
    : html`<b>Round ${round.n}</b><i class="sep"></i>${fmtDate(day, 'dowshort')}<i class="sep"></i>${colourOf(round)}`;
  const opts = { detail: 'full', accounts: ctx.d.account, pairs: flowLookups(ctx).pairOf, plain: true };
  const dayWords = fmtDate(day, 'dowshort');

  return html`<section class="${cx('ss-round', 'is-' + round.status, round.type === 'off' && 'is-off', day === ctx.today && 'is-today', isTarget && 'is-target')}" id="${'rd-' + day}">
    <h3 class="ss-rd-h"><button class="ss-rd" type="button" data-action="app.sheet" data-sheet="day" data-day="${day}">
      <span class="lab ss-rd-lab">${label}</span>
      <span class="ss-rd-res">
        ${prematch && round.result == null ? '' : html`<span class="ss-rd-mark">${resultMark(round.result, round.status, { glyph: ann.round ? ann.round.glyph : null })}${round.bye && round.result != null ? html`<span class="ss-rd-bye">bye</span>` : ''}</span>`}
        ${marginOf(round)}
      </span>
      ${lines.length ? html`<span class="cap ss-rd-notes">${lines}</span>` : ''}
    </button></h3>
    <div class="ss-rd-moves">
      ${main.length ? movesList(main, notes, { ...opts, label: 'Moves of ' + dayWords }) : ''}
      ${quiet.length ? html`<div class="ss-quiet">${movesList(quiet, notes, { ...opts, startAt: main.length + 1, label: 'Transfers and card payments of ' + dayWords })}</div>` : ''}
      ${!main.length && !quiet.length ? html`<p class="cap ss-rd-none">${round.status === 'awaiting' ? 'The bank has not reported ' + dayWords + ' yet.'
        : round.status === 'live' ? 'No move so far on ' + dayWords + '. The bank reports them as they post.'
          : 'No move on ' + dayWords + ': nothing left any account.'}</p>` : ''}
    </div>
  </section>`;
}

/* ----------------------------------------------------------------- actions */

export const actions = {
  /** The segmented control: one class of move, or all. */
  'scoresheet.filter': ({ el }) => setParams({ filter: el.value === 'all' ? null : el.value }),
  /** The "Needs a look" chip: moves whose classification is uncertain; tap again to leave. */
  'scoresheet.look': ({ el }) => setParams({ filter: el.getAttribute('aria-pressed') === 'true' ? null : 'review' }),
  /** A purpose chip: one purpose only; tap again to leave. */
  'scoresheet.purpose': ({ el, data }) => setParams({ purpose: el.getAttribute('aria-pressed') === 'true' ? null : data.purpose }),
  /** The search box, as it is typed. */
  'scoresheet.search': ({ el }) => setParams({ q: el.value || null }),
  /** Drop every filter and the search. */
  /** An account chip: that account's moves only; tap again to leave. */
  'scoresheet.account': ({ el, data }) => setParams({ account: el.getAttribute('aria-pressed') === 'true' ? null : data.account }),
  'scoresheet.clear': () => setParams({ filter: null, purpose: null, q: null, account: null }),
};

/* ------------------------------------------------------ the scroll-to mark */

/**
 * <nw-goto data-island target="rd-2026-06-09" hidden> — brings the element with that id into view when it
 * appears on the page and whenever `target` changes; a re-render with the same target does nothing.
 * A click on a link to the day already shown (the same round in the crosstable, a second time) changes
 * nothing in the markup, so the element also listens for it and goes there again.
 * The Scoresheet writes it for ?day=…, so render itself never touches the page.
 */
if (typeof HTMLElement !== 'undefined' && typeof customElements !== 'undefined') {
  define('nw-goto', class extends HTMLElement {
    static get observedAttributes() { return ['target']; }
    connectedCallback() {
      this.onLink = (ev) => {
        const id = this.getAttribute('target');
        const link = ev.target instanceof Element ? ev.target.closest('a[href*="day="]') : null;
        // after the route's own re-render, which comes one frame after the click
        if (id && link && link.getAttribute('href').includes('day=' + id.slice(3))) requestAnimationFrame(() => this.go());
      };
      document.addEventListener('click', this.onLink);
      this.go();
    }
    disconnectedCallback() { document.removeEventListener('click', this.onLink); }
    attributeChangedCallback(name, before, after) { if (this.isConnected && before !== after) this.go(); }
    go() {
      const id = this.getAttribute('target');
      if (!id || this.pending === id) return;
      this.pending = id;
      requestAnimationFrame(() => {
        this.pending = null;
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      });
    }
  });
}
