/**
 * Shared partials: the pieces that appear on more than one screen, so that a round, a move
 * and a figure look and read the same everywhere. Views import these instead of re-drawing them.
 * All functions are pure and return safe markup (html`` results) or plain strings.
 *
 *   money(cents, opts)            a figure: <span class="fig …">$2,417.86</span>, italic with ≈ when estimated
 *   inlineMoney(cents, opts)      an amount inside a sentence: <span data-fig>$2,417.86</span> (covered in cover mode)
 *   figured(text)                 an engine sentence with every amount in it wrapped in data-fig, so cover mode hides them
 *   tone(cents)                   'gain' | 'loss' | '' — the tint class for a RESULT delta (and nothing else)
 *   fmtScore(x) / scoreOf(s, n)   6.5 -> "6½"; (6.5, 10) -> "6½/10"
 *   plainSigned(cents)            "+16.20" / "−6.40" — scoresheet notation, no currency sign
 *   resultText(round)             what a round's result cell prints: 1 · ½ · 0 · * · – · · · bye
 *   keptLine(round)               "+$16.20 kept" / "−$6.40" — the dollar margin of a round, in words
 *   statusLine(round)             one plain sentence about how final a round is
 *   roundTitle(round)             "Round 9 · Tue, Jun 9"
 *   colourOf(round)               "Black" (a workday) or "White" (a day off)
 *   crosstable(month, opts)       the month's crosstable with its score block
 *   spentUnposted(round)          true when a round's Spent holds a move not yet posted (then an estimate)
 *   movesList(round, ann, opts)   a round's moves as the design system's moves list
 *   worstGlyph(annotations)       the annotation to hang on a round in the crosstable
 */

import { html, cx } from '../ui/dom.js';
import { fmt, fmtSigned, fmtPlain, MINUS, toneOf } from '../model/money.js';
import { addDays, fmtDate, fmtMonth, dow, parts as ymdParts, monthOf, ymd } from '../model/dates.js';
import { moveGlyph } from '../ui/glyphs.js';
import { categoryLabel, accountLabel, accountShort } from '../model/schema.js';

const DOW_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const HALF = '½';
const NEGATIVE_ORDER = ['??', '?', '?!'];

/* ----------------------------------------------------------------- figures */

/**
 * A money figure in the design system's type.
 * @param {number|null} cents
 * @param {{ est?: boolean, signed?: boolean, size?: 's'|'m'|'l'|'xl', tint?: boolean, rim?: boolean, decimals?: 0|2, cls?: string }} [opts]
 *   est = computed or not yet final (italic, with the approximately sign); signed = show + on positive;
 *   tint = colour it as a result delta (gain / loss); rim = with tint, the rim light passes over it now and then
 *   (.rim; the Board's two result deltas only); size adds .fig-s … .fig-xl.
 */
export function money(cents, opts = {}) {
  const text = opts.signed ? fmtSigned(cents, { decimals: opts.decimals ?? 2 }) : fmt(cents, { decimals: opts.decimals ?? 2 });
  const cls = cx('fig', opts.size && 'fig-' + opts.size, opts.est && 'est', opts.tint && tone(cents), opts.tint && opts.rim && 'rim', opts.cls);
  return html`<span class="${cls}">${opts.est ? html`<span class="approx">≈</span>` : ''}${text}</span>`;
}

/**
 * An amount inside a sentence. It carries data-fig so that cover mode redacts it and it never
 * breaks between its sign and its digits.
 * @param {number|null} cents
 * @param {{ est?: boolean, signed?: boolean, decimals?: 0|2 }} [opts]
 */
export function inlineMoney(cents, opts = {}) {
  const text = opts.signed ? fmtSigned(cents, { decimals: opts.decimals ?? 2 }) : fmt(cents, { decimals: opts.decimals ?? 2 });
  return html`<span data-fig class="${opts.est ? 'est' : ''}">${opts.est ? '\u2248' : ''}${text}</span>`;
}

const AMOUNT_IN_TEXT = /(\u2248\s?)?[+\u2212-]?\$\d[\d,]*(?:\.\d+)?[KM]?/g;

/**
 * A sentence written by the engine (an assessment, a coach's note, an annotation's reason) with every
 * dollar amount in it wrapped in <span data-fig>, so cover mode hides the amounts and leaves the words.
 * The text is escaped; only the wrappers are markup.
 * @param {string} text
 */
export function figured(text) {
  const str = String(text == null ? '' : text);
  const out = [];
  let last = 0;
  for (const m of str.matchAll(AMOUNT_IN_TEXT)) {
    if (m.index > last) out.push(str.slice(last, m.index));
    out.push(html`<span data-fig>${m[0]}</span>`);
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push(str.slice(last));
  return html`${out}`;
}

/** The tint class for a result delta: 'gain' above zero, 'loss' below, '' at zero or unknown. */
export function tone(cents) {
  if (!Number.isFinite(cents) || Math.round(cents) === 0) return '';
  return cents > 0 ? 'gain' : 'loss';
}

/** A chess score: 6.5 -> "6½", 0.5 -> "½", 7 -> "7". */
export function fmtScore(x) {
  if (!Number.isFinite(x)) return '—';
  const whole = Math.floor(x);
  const half = x - whole >= 0.5;
  return (whole === 0 && half ? '' : String(whole)) + (half ? HALF : '');
}

/** "6½/10" */
export function scoreOf(score, played) {
  return fmtScore(score) + '/' + played;
}

/** Scoresheet notation for a signed amount: "+16.20", "−6.40", "0.00". */
export function plainSigned(cents) {
  if (!Number.isFinite(cents)) return '';
  const rounded = Math.round(cents);
  return (rounded > 0 ? '+' : rounded < 0 ? MINUS : '') + fmtPlain(Math.abs(rounded));
}

/* ------------------------------------------------------------------ rounds */

/** What the result cell of a round prints. */
export function resultText(round) {
  if (round.status === 'live') return '*';
  if (round.status === 'awaiting') return '–';
  if (round.status === 'future') return '·';
  if (round.result == null) return '·';
  if (round.bye) return 'bye';
  return round.result === 0.5 ? HALF : String(round.result);
}

/** The dollar margin of a round in words: "+$16.20 kept", or "−$6.40" when habit was exceeded. */
export function keptLine(round) {
  return round.kept >= 0 ? fmtSigned(round.kept) + ' kept' : fmtSigned(round.kept);
}

/**
 * True when a round's convenience spending holds a move that has not posted at the bank yet: a
 * pending row or a tapped-in move with no bank row matched to it. Spent is then an estimate.
 */
export function spentUnposted(round) {
  return (round.moves || []).some((tx) => tx && !tx.matchId && tx.kind !== 'decline' && (tx.pending || tx.source === 'manual'));
}

/** One plain sentence about how final a round is. */
export function statusLine(round) {
  switch (round.status) {
    case 'final': return 'Final: the bank has reported the whole day.';
    case 'provisional': return 'In pencil until the bank finishes reporting the day.';
    case 'live': return 'In progress. The bank reports today’s moves as they post.';
    case 'awaiting': return 'The bank has not reported this day yet.';
    case 'prematch': return 'Before the match began: shown for reference, not counted.';
    default: return 'Not yet played.';
  }
}

/** "Round 9 · Tue, Jun 9" */
export function roundTitle(round) {
  return 'Round ' + round.n + ' · ' + fmtDate(round.day, 'dowshort');
}

/** A workday is played with Black, a day off with White. */
export function colourOf(round) {
  return round.type === 'work' ? 'Black' : 'White';
}

/**
 * The annotation to hang on a round in the crosstable: the round's own ('!!' or '!'),
 * else the most serious negative symbol among its moves, else none.
 * @param {{ moves: Map<string, { glyph: string }>, round: { glyph: string }|null }|null} annotations
 * @returns {string|null}
 */
export function worstGlyph(annotations) {
  if (!annotations) return null;
  if (annotations.round) return annotations.round.glyph;
  const seen = new Set();
  for (const a of annotations.moves.values()) seen.add(a.glyph);
  for (const g of NEGATIVE_ORDER) if (seen.has(g)) return g;
  return null;
}

/* -------------------------------------------------------------- crosstable */

function cellClass(round, today) {
  return cx('x', {
    'is-off': round.type === 'off',
    'is-today': round.day === today,
    'is-live': round.status === 'live',
    'is-provisional': round.status === 'provisional',
    'is-awaiting': round.status === 'awaiting',
    'is-future': round.status === 'future',
    'is-prematch': round.status === 'prematch',
    'is-bye': round.bye && round.result != null && round.status !== 'live',
  });
}

function hasCountedResult(round) {
  return round.result != null && (round.status === 'final' || round.status === 'provisional');
}

/** A counted round whose figure is not final yet: in pencil (provisional) or in progress (live). */
function inPencil(round) {
  return round.status === 'provisional' || round.status === 'live';
}

function weekCell(index, rounds, cover) {
  const counted = rounds.filter(hasCountedResult);
  const score = counted.reduce((n, r) => n + r.result, 0);
  const kept = counted.reduce((n, r) => n + r.kept, 0);
  const est = counted.some(inPencil);
  const label = 'Week ' + index + ': ' + (counted.length ? fmtScore(score) + ' of ' + counted.length + (cover ? '' : ', kept ' + (est ? 'approximately ' : '') + fmtSigned(kept)) : 'not yet played');
  return html`<li class="x x-week" data-key="${'week-' + index}" aria-label="${label}">
    <span class="x-rd">Wk</span><span class="x-day">${index}</span>
    <span class="x-res">${counted.length ? fmtScore(score) || '0' : '·'}</span>
    <span class="${cx('x-edge', est && 'est')}">${counted.length ? html`${est ? html`<span class="approx">≈</span>` : ''}${plainSigned(kept)}` : ''}</span>
  </li>`;
}

/**
 * The month's crosstable with its score block (design system: section 9).
 * @param {import('../model/ledger.js').MonthTable} month
 * @param {{ today: string, title?: string, glyphOf?: (day: string) => string|null, link?: boolean, note?: any, scale?: boolean, cover?: boolean }} opts
 *   glyphOf  returns the annotation to hang on a round (use worstGlyph(ctx.d.annotations(day)));
 *   link     true (default) makes every played round a link to its day on the Scoresheet;
 *   note     a caption under the grid; scale adds "A perfect {month} is worth {perfect}." to it;
 *   cover    pass ctx.state.settings.cover: amounts are then left out of what a screen reader is told.
 */
export function crosstable(month, opts) {
  const today = opts.today;
  const rounds = month.rounds;
  const link = opts.link !== false;
  const cells = [];
  const leadingPads = rounds.length ? (dow(rounds[0].day) + 6) % 7 : 0;
  for (let i = 0; i < leadingPads; i++) cells.push(html`<li class="x is-pad" data-key="${'pad-' + i}" aria-hidden="true"></li>`);

  let running = 0;
  let week = [];
  let weekIndex = 1;
  rounds.forEach((round, i) => {
    const counted = hasCountedResult(round);
    if (counted) running += round.result;
    const glyph = opts.glyphOf && counted ? opts.glyphOf(round.day) : null;
    const reachable = link && round.day <= today && round.status !== 'prematch';
    const label = 'Round ' + round.n + ', ' + fmtDate(round.day, 'dowshort') + (counted ? ': ' + (round.bye ? 'bye' : round.result === 1 ? 'win' : round.result === 0 ? 'loss' : 'draw') + (round.status === 'provisional' ? ', provisional' : '') : round.status === 'live' ? ': in progress' : '');
    cells.push(html`<li class="${cellClass(round, today)}" data-key="${round.day}">
      <span class="x-rd">${round.n}</span><span class="x-day">${DOW_LETTER[dow(round.day)]}</span>
      <span class="x-res">${resultText(round)}${glyph ? html`<sup>${glyph}</sup>` : ''}</span>
      <span class="x-edge">${counted || round.status === 'live' ? plainSigned(round.kept) : ''}</span>
      <span class="x-cum">${counted ? fmtScore(running) || '0' : round.status === 'live' ? '·' : ''}</span>
      ${reachable ? html`<a class="x-a" href="${'#/scoresheet/' + monthOf(round.day) + '?day=' + round.day}"><span class="vh">${label}</span></a>` : ''}
    </li>`);
    week.push(round);
    if (dow(round.day) === 0 || i === rounds.length - 1) {
      cells.push(weekCell(weekIndex++, week, !!opts.cover));
      week = [];
    }
  });

  const title = opts.title || 'Crosstable';
  const noteParts = [];
  if (opts.note) noteParts.push(opts.note);
  if (opts.scale && month.perfect > 0) noteParts.push(html`A perfect ${fmtMonth(month.ym, 'name')} is worth <span data-fig>${fmt(month.perfect)}</span>.`);
  return html`<section class="xt">
    <div class="xt-head">
      <div class="sec-head"><h2 class="lab"><b>${title}</b><i class="sep"></i>${fmtMonth(month.ym)}<i class="sep"></i>You v. Habit</h2></div>
      <p class="xt-score">
        <span class="xt-score-item"><span class="lab">Score</span><span class="fig fig-xl" data-cover-keep>${month.played ? scoreOf(month.score, month.played) : '—'}</span></span>
        <span class="xt-score-item"><span class="lab">With Black</span><span class="fig" data-cover-keep>${month.black.played ? scoreOf(month.black.score, month.black.played) : '—'}</span></span>
        <span class="xt-score-item"><span class="lab">With White</span><span class="fig" data-cover-keep>${month.white.played ? scoreOf(month.white.score, month.white.played) : '—'}</span></span>
        <span class="xt-score-item"><span class="lab">Kept</span>${month.played ? money(month.kept, { est: month.rounds.some((r) => hasCountedResult(r) && inPencil(r)), signed: true }) : html`<span class="fig">—</span>`}</span>
      </p>
    </div>
    <ol class="xt-grid has-weeks" style="${'--days:' + rounds.length}" aria-label="${fmtMonth(month.ym) + ', round by round'}">
      <li class="x x-legend" data-key="legend" aria-hidden="true"><span class="x-rd">Rd</span><span class="x-day">Day</span><span class="x-res">Result</span><span class="x-edge">± $</span><span class="x-cum">Score</span></li>
      ${cells}
    </ol>
    ${noteParts.length ? html`<p class="cap xt-note">${noteParts.map((n, i) => html`${i ? ' ' : ''}${n}`)}</p>` : ''}
  </section>`;
}

/* ------------------------------------------------------------------- moves */

function moveState(tx) {
  if (tx.kind === 'decline') return 'is-declined';
  if (tx.source === 'manual' && !tx.matchId) return 'is-provisional';
  if (tx.pending) return 'is-pending';
  return '';
}

function moveAmount(tx) {
  const plain = fmtPlain(tx.amount);
  if (tx.kind === 'decline') return plain; // the stylesheet sets the parentheses
  if (tx.kind === 'income' || tx.kind === 'refund') return '+' + plain;
  return plain;
}

/** A note as a closed sentence, so that the next note or tag never runs into it. */
function sentence(text) {
  const t = String(text).trim();
  return /[.!?\u2026:]$/.test(t) ? t : t + '.';
}

function moveName(tx) {
  if (tx.kind === 'decline') return 'Declined: ' + (tx.merchant || 'a purchase');
  return tx.merchant || categoryLabel(tx.category);
}

/**
 * A round's moves as the design system's moves list (section 8).
 * @param {object[]} moves            Tx objects, in the order to print (usually round.moves, filtered)
 * @param {Map<string, { glyph: string, why: string }>|null} annotations   from ctx.d.annotations(day).moves
 * @param {{ accounts?: (id: string) => object|null, open?: boolean, blank?: boolean, plain?: boolean,
 *           label?: string, detail?: 'why'|'full', startAt?: number, cover?: boolean }} [opts]
 *   accounts  lookup used to name the account in the quiet second line (detail 'full');
 *   open      true (default): each row is a button that opens the move's sheet;
 *   blank     true: add the empty next-move row; plain: drop the top rule (.moves-plain);
 *   detail    'why' (default) prints the annotation's reason or the decline's "instead"; 'full' also category and account;
 *   cover     pass ctx.state.settings.cover: amounts inside reasons are redacted by the stylesheet either way, and
 *             the symbol's tooltip (which would repeat the reason) is then left out.
 */
export function movesList(moves, annotations, opts = {}) {
  const open = opts.open !== false;
  const start = opts.startAt || 1;
  const rows = moves.map((tx, i) => {
    const ann = annotations ? annotations.get(tx.id) : null;
    const state = moveState(tx);
    const notes = [];
    if (ann && ann.why) notes.push(sentence(ann.why));
    else if (tx.kind === 'decline' && tx.instead) notes.push(sentence('Instead: ' + tx.instead));
    if (opts.detail === 'full') {
      const bits = [categoryLabel(tx.category)];
      const account = opts.accounts && tx.accountId ? opts.accounts(tx.accountId) : null;
      if (account) bits.push(accountLabel(account));
      notes.push(bits.join(' · '));
    }
    if (tx.note) notes.push(sentence(tx.note));
    const tags = [];
    if (tx.pending) tags.push('Pending');
    if (state === 'is-provisional') tags.push('Tapped in');
    if (tx.planned) tags.push('Planned');
    const inner = html`<span class="move-n">${start + i}.</span>
      <span class="move-m">${moveName(tx)}${notes.length || tags.length || tx.review ? html` <em class="move-note">${notes.length ? html`<span class="move-why">${figured(notes.join(' '))}</span> ` : ''}${tags.map((t) => html`<span class="move-tag">${t}</span>`)}${tx.review ? html`<span class="move-tag">Needs a look</span>` : ''}</em>` : ''}</span>
      <span class="move-a">${moveAmount(tx)}</span>
      <span class="move-s">${ann ? (opts.cover ? moveGlyph(ann.glyph) : moveGlyph(ann.glyph, { title: ann.why })) : ''}</span>`;
    return open
      ? html`<li data-key="${tx.id}"><button class="${cx('move', state)}" type="button" data-action="app.sheet" data-sheet="tx" data-id="${tx.id}">${inner}</button></li>`
      : html`<li class="${cx('move', state)}" data-key="${tx.id}">${inner}</li>`;
  });
  if (opts.blank) rows.push(html`<li class="move is-blank" data-key="blank" aria-hidden="true"><span class="move-n">${Number.isInteger(opts.blankAt) && opts.blankAt > 0 ? opts.blankAt : start + moves.length}.</span><span class="move-m"></span><span class="move-a"></span><span class="move-s"></span></li>`);
  return html`<ol class="${cx('moves', opts.plain && 'moves-plain')}" aria-label="${opts.label || 'Moves'}">${rows}</ol>`;
}

/** Moves worth showing on the Board for a round: game-class spends, declines, and anything annotated. */
export function notableMoves(round, annotations) {
  return round.moves.filter((tx) => !tx.matchId && (tx.kind === 'decline' || (tx.kind === 'spend' && tx.klass === 'game') || (annotations && annotations.has(tx.id))));
}

/* ------------------------------------------------- the owner's colour scale */

/** The --tone custom property that puts a figure on the owner's scale (joined to its `style`); see money.toneOf. */
export function toneStyle(cents) {
  return '--tone:' + toneOf(cents).toFixed(3);
}

/* ------------------------------------------------------- text under cover */

/** A number in a sentence, with a currency mark or code on either side of it: "$1,234.56", "USD 40", "40 USD", "€1.234,56", "2,000 dollars". */
const NUMBER_IN_TEXT = /(?:[$€£¥]\s?|\b[A-Z]{3}\s?)?[-−]?\d(?:[\d.,]*\d)?(?:\s?(?:[A-Z]{3}\b|[Dd]ollars?\b|[Cc]ents?\b|[$€£¥%]))?/g;

/**
 * A text that is not the app's own (a provider's message) as it may be shown: with cover on, every number in it
 * is replaced by a dash together with the currency mark or code next to it, so no amount shows in any wording.
 * @param {object} ctx
 * @param {string} text
 * @returns {string} still plain text: interpolate it through the html template like any bank text
 */
export function coverText(ctx, text) {
  const said = typeof text === 'string' ? text : '';
  const cover = !!(ctx && ctx.state && ctx.state.settings && ctx.state.settings.cover);
  return cover ? said.replace(NUMBER_IN_TEXT, '—') : said;
}

/* --------------------------------------------------- recent transactions */

/**
 * "Today" · "Tomorrow" (a row the bank post-dated) · "Yesterday" · "Tue, Nov 10". Between midnight and the
 * day change the day after the game day is the calendar date of now: that is not tomorrow to the owner, so
 * the date is printed.
 */
function recentDay(ctx, day) {
  if (day === ctx.today) return 'Today';
  if (day === addDays(ctx.today, 1) && day > ymd()) return 'Tomorrow';
  if (day === addDays(ctx.today, -1)) return 'Yesterday';
  return fmtDate(day, 'dowshort');
}

/**
 * Transactions as a ruled list, newest first as given: the name with its account under it, the day,
 * the amount. Each row is a button that opens the move's own sheet. A pending or tapped-in amount is
 * not final, so it is set as an estimate; money coming in carries its sign.
 * @param {object} ctx
 * @param {{ tx: object, account: object|null, isNew: boolean, provisional: boolean }[]} rows  from recent.recentTransactions
 * @param {{ label?: string, account?: boolean, cls?: string }} [opts]
 *   account false leaves the account's name out (the list is one account's own); cls adds a class to the list
 */
export function recentList(ctx, rows, opts = {}) {
  return html`<ol class="${cx('board-recent', opts.cls)}" aria-label="${opts.label || 'Transactions, newest first'}">
    ${rows.map(({ tx, account, isNew, provisional }) => {
      const unsettled = !!tx.pending || provisional;
      const incoming = tx.flow === 'in';
      const notes = [];
      if (opts.account !== false && account) notes.push(accountShort(account));
      if (tx.pending) notes.push('Pending');
      if (provisional) notes.push('Tapped in');
      return html`<li data-key="${tx.id}"><button class="recent-row" type="button" data-action="app.sheet" data-sheet="tx" data-id="${tx.id}">
        <span class="recent-name">${tx.merchant || categoryLabel(tx.category)}${isNew ? html` <span class="recent-new">New</span>` : ''}${notes.length
          ? html`<em class="recent-note">${notes.join(' · ')}</em>` : ''}</span>
        <span class="lab">${recentDay(ctx, tx.day)}</span>
        ${money(tx.amount, { est: unsettled, signed: incoming, tint: incoming })}
      </button></li>`;
    })}
  </ol>`;
}
