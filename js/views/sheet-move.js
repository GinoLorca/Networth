/**
 * The candidate-move sheet — "Look before you play it." Opened before buying; the one moment the
 * app can change a decision, so it works one-handed: chips first, one large amount, the consequence
 * as a read-out that follows every keystroke, and three actions.
 *
 * Ephemeral state (store.ui — never saved):
 *   ui.move     the draft { amount: string as typed, merchant: string, mkey: string, category: string|null,
 *               at: ms of the last edit, error: 'amount'|null }
 *               — or, after Decline, { stage: 'instead', declineId, amount: cents|null, merchant, at }.
 *               A draft that has not been touched for 15 minutes reads as blank.
 *   ui.adjourn  a sealed move { until: ms, at: ms, day, amount, merchant, mkey, category } — the ten-minute
 *               adjournment. While it exists the sheet shows the countdown and two choices; it survives
 *               closing and reopening the sheet (not a reload). It lapses, unrecorded, when its game day ends.
 * render() is a pure function of ctx: the read-out is recomputed from the draft and today's round.
 *
 * Actions
 *   move.chip      one of the usual stops: fills amount, place and category
 *   move.input     amount or place typed (data-input): keeps the draft, so the read-out follows
 *   move.category  one of the four stop categories, or "something else"
 *   move.play      record a tapped-in move (merge.addProvisional), close, "Recorded." with Undo
 *   move.adjourn   seal the move for ten minutes
 *   move.decline   record a declined purchase (merge.addDecline), then ask "Instead:"
 *   move.instead   one of settings.insteads: saved on the decline, close, "Recorded." with Undo
 *   move.done      close with the "Instead:" question unanswered
 *   move.unseal    set a sealed move aside without recording anything
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast, rerender } from '../runtime.js';
import { closeSheet, onRoute } from '../router.js';
import { toCents, fmt, fmtPlain } from '../model/money.js';
import { nowMs, fmtDate, fmtTime, fmtMonth, monthOf } from '../model/dates.js';
import { CATEGORIES, categoryLabel } from '../model/schema.js';
import { classify } from '../model/classify.js';
import { addProvisional, addDecline, removeManual } from '../model/merge.js';
import { previewMove, reviewRounds } from '../model/annotate.js';
import { purchaseImpact } from '../model/forecast.js';
import { money, spentUnposted } from './parts.js';

export const label = 'Candidate move';

const SHEET = 'move';
const ADJOURN_MS = 10 * 60 * 1000;
const DRAFT_KEEP_MS = 15 * 60 * 1000;
const LARGE_CENTS = 10000;
const ELSE = 'else';
const FALLBACK_STOP = 'cafe';
/** The four stop categories as chips, in the order they are met in a day. */
const STOP_CHIPS = [['cafe', 'Cafe'], ['eating_out', 'Meal out'], ['convenience', 'Snack'], ['delivery', 'Delivery']];
const BLANK = { amount: '', merchant: '', mkey: '', category: null, at: 0, error: null };

/* ---------------------------------------------------------------- reading */

function isStop(category) {
  return Object.hasOwn(CATEGORIES, category) && !!CATEGORIES[category].stop;
}

/** The draft as it stands; a stale one reads as blank (the "Instead:" step never goes stale by time). */
function draftOf(ui, now) {
  const draft = ui.move;
  if (!draft) return BLANK;
  if (draft.stage === 'instead') return draft;
  return now - draft.at > DRAFT_KEEP_MS ? BLANK : draft;
}

/** The sealed move, while its day lasts: one sealed in another round reads as none. */
function sealedOf(ui, today) {
  const sealed = ui.adjourn;
  return sealed && sealed.day === today ? sealed : null;
}

/** The category the classifier gives a place name, when it knows one that is a kind of spending. */
function guessCategory(state, merchant) {
  if (!merchant) return null;
  const found = classify({ description: merchant, amount: 0, flow: 'out', accountType: 'checking' }, { rules: state.settings.rules });
  if (!found || found.kind !== 'spend') return null;
  return Object.hasOwn(CATEGORIES, found.category) && found.category !== 'other' ? found.category : null;
}

/**
 * What a draft (or a sealed move) says: the amount in cents (null until it is a price above zero),
 * the place, and the category — the owner's pick, else the place's usual one, else the usual stop
 * (a price of $100 or more at a place the classifier does not know is read as "something else").
 */
function reading(state, source, usual) {
  const cents = toCents(source.amount);
  const merchant = String(source.merchant || '').trim();
  const guess = guessCategory(state, merchant);
  let category;
  if (source.category && source.category !== ELSE && isStop(source.category)) category = source.category;
  else if (source.category === ELSE) category = guess && !isStop(guess) ? guess : 'other';
  else if (guess) category = guess;
  else if (cents != null && cents >= LARGE_CENTS) category = 'other';
  else category = usual.length && isStop(usual[0].category) ? usual[0].category : FALLBACK_STOP;
  return { amount: cents != null && cents > 0 ? cents : null, merchant, mkey: source.mkey || '', category };
}

function inMatch(ctx, round) {
  return !!ctx.state.meta.matchStart && round.status !== 'prematch';
}

function ordinal(n) {
  const teens = n % 100 >= 11 && n % 100 <= 13;
  return n + (teens ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
}

function countOf(n, noun) {
  return n + ' ' + noun + (n === 1 ? '' : 's');
}

/** An amount inside a sentence, where cover mode can reach it. */
function fig(cents) {
  return html`<span data-fig>${fmt(cents)}</span>`;
}

/** An estimate inside a sentence (an amount not yet posted, or a projection): the sign sits directly before it. */
function estFig(cents) {
  return html`<span data-fig class="est">≈${fmt(cents)}</span>`;
}

/* ------------------------------------------------------------ the read-out */

/** Where the day would stand against the line that decides it, in the annotator's words. */
function resultLine(round, preview) {
  if (round.bye) return html`A bye scores a draw whatever is played; the ${fig(round.habit - preview.keptAfter)} still counts.`;
  const conv = round.habit - preview.keptAfter;
  const same = preview.resultBefore === preview.resultAfter;
  if (preview.resultAfter === 1) return html`${same ? 'Still a win' : 'A win'}: ${fig(round.winLine - conv)} inside the win line.`;
  if (preview.resultAfter === 0.5) return html`${same ? 'Still a draw' : 'A draw'}: ${fig(round.lossLine - conv)} inside the loss line.`;
  return html`${same ? 'The round was already lost' : 'The round is lost'} — the margin still counts: ${fig(conv - round.lossLine)} past the loss line.`;
}

function keptLine(before, after) {
  return html`<p class="mv-kept"><span class="lab">Kept today</span>
    <span class="mv-kept-figs">${money(before, { est: true, size: 'm' })}<span class="mv-arrow" aria-hidden="true">→</span><span class="vh">becomes</span>${money(after, { est: true, size: 'm' })}</span></p>`;
}

/** A purchase judged in today's round. */
function roundConsequence(ctx, round, move) {
  const preview = previewMove(round, { amount: move.amount, category: move.category });
  if (preview.stopNumber === null) {
    const name = move.category === 'other' ? 'Not a convenience stop' : categoryLabel(move.category);
    return html`<div class="conseq mv-conseq" aria-live="polite">
      <div>
        <strong>Outside the daily game.</strong>
        <p class="mv-line">${name}: ${fig(move.amount)} is recorded and is not played against Habit. Today’s round stays at ${fig(preview.keptBefore)} kept.</p>
      </div>
    </div>`;
  }
  const planned = preview.glyph === null && preview.stopNumber <= (round.plan && Number.isFinite(round.plan.stops) ? round.plan.stops : 0);
  const stacked = preview.glyph !== null;
  let pattern = '';
  if (stacked) {
    const review = reviewRounds(ctx.d.thisMonth.rounds, { sweepTxIds: ctx.d.sweepTxIds });
    const month = fmtMonth(monthOf(ctx.today), 'name');
    pattern = review.stackedDays
      ? html`<p class="mv-line">Days with stacked stops in ${month}: <span data-cover-keep>${review.stackedDays}</span>, costing ${fig(review.stackedCost)}.</p>`
      : html`<p class="mv-line">Days with stacked stops in ${month} so far: 0.</p>`;
  }
  return html`<div class="conseq mv-conseq" aria-live="polite">
    ${stacked ? html`<b class="conseq-sym">${preview.glyph}</b>` : ''}
    <div>
      <strong>${ordinal(preview.stopNumber)} stop of the day${planned ? ', in the plan' : stacked ? ', unplanned' : ''}.</strong>
      ${keptLine(preview.keptBefore, preview.keptAfter)}
      <p class="mv-line">${resultLine(round, preview)}</p>
      ${pattern}
    </div>
  </div>`;
}

/** Before the match has begun there is no round to judge against: say so, with what is known. */
function prematchConsequence(ctx, round, move) {
  const days = ctx.d.historyDays;
  const stop = isStop(move.category);
  return html`<div class="conseq mv-conseq" aria-live="polite">
    <div>
      <strong>The match has not begun.</strong>
      <p class="mv-line">Habit is measured over ${ctx.d.matchFromDay - 1} full days of bank history: the match begins on day ${ctx.d.matchFromDay} on record; <span data-cover-keep>${days}</span> so far. Until then a move or a declined purchase is recorded as played, with no round to weigh it against.</p>
      ${stop
        ? html`<p class="mv-line">Convenience stops today: ${fig(round.conv)} in ${round.stops}. With this one: ${fig(round.conv + move.amount)} in ${round.stops + 1}.</p>`
        : html`<p class="mv-line">${move.category === 'other' ? 'Not a convenience stop' : categoryLabel(move.category)}: ${fig(move.amount)}, recorded on ${fmtDate(ctx.today, 'dowshort')}.</p>`}
    </div>
  </div>`;
}

/** $100 or more: what it does to the clock and to the card — never a balance, never a verdict. */
function largeConsequence(ctx, move) {
  const clock = ctx.d.clock;
  const shared = { ledger: ctx.d.ledger };
  const fromCash = purchaseImpact(ctx.state, ctx.now, { amount: move.amount, on: 'cash' }, shared);
  const hasCard = ctx.d.accounts('card').length > 0;
  const onCard = hasCard ? purchaseImpact(ctx.state, ctx.now, { amount: move.amount, on: 'card' }, shared) : null;
  // T1: on the payday itself, and in the first days after an awaited one, the window is today alone;
  // past the grace days an awaited paycheck's window runs through dueUntil; today is never called the payday
  const todayOnly = clock.dueUntil ? clock.dueUntil <= ctx.today : clock.nextPayday === ctx.today;
  const until = todayOnly ? 'today (' + fmtDate(ctx.today, 'dowshort') + ')'
    : clock.payAwaited && clock.dueUntil ? 'through ' + fmtDate(clock.dueUntil, 'dowshort')
    : clock.nextPayday ? 'before payday, ' + fmtDate(clock.nextPayday, 'dowshort') : 'in the next 14 days';
  let cashLine;
  if (clock.dueTotal <= 0) cashLine = html`nothing in the Book falls due ${until}.`;
  else if (fromCash.shortfallAfter > 0) cashLine = html`${estFig(fromCash.shortfallAfter)} short of the ${estFig(clock.dueTotal)} due ${until}.`;
  else cashLine = html`the ${estFig(clock.dueTotal)} due ${until} stays covered.`;
  let cardLine = '';
  if (onCard && onCard.cardMonthChange !== null) {
    const change = onCard.cardMonthChange;
    const month = fmtMonth(monthOf(ctx.today), 'name');
    cardLine = html`<p class="mv-line"><span class="lab">On the card</span> ${month} would be on pace to end ${change === 0 ? 'where it began' : html`${estFig(Math.abs(change))} ${change > 0 ? 'higher' : 'lower'} than it began`}.</p>`;
  }
  // The engine's own words for the size of it ("about 1.8 days of pay"): a measure of the price, so it is covered with it.
  const tail = fromCash.daysOfPay === null ? '' : String(fromCash.sentence).split(' — ')[1] || '';
  const pay = tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : '';
  return html`<div class="conseq mv-conseq mv-large" aria-live="polite">
    <div>
      <strong>${fig(move.amount)}: a larger move.</strong>
      <p class="lab mv-scenario"><i class="hatch-mark"></i>Scenario<i class="sep"></i>if played today</p>
      <p class="mv-line"><span class="lab">From cash</span> ${cashLine}</p>
      ${cardLine}
      ${pay ? html`<p class="mv-line"><span data-fig>${pay}</span></p>` : ''}
    </div>
  </div>`;
}

function consequence(ctx, round, move) {
  if (move.amount >= LARGE_CENTS) return largeConsequence(ctx, move);
  if (!inMatch(ctx, round)) return prematchConsequence(ctx, round, move);
  return roundConsequence(ctx, round, move);
}

/** Nothing typed yet: where the round stands, and the owner's own rules. */
function standing(ctx, round) {
  const principles = ctx.state.settings.principles || [];
  let line;
  if (!inMatch(ctx, round)) {
    const days = ctx.d.historyDays;
    line = html`The match has not begun: it begins on day ${ctx.d.matchFromDay} on record; ${days} so far. A move or a declined purchase is recorded all the same.`;
  } else if (round.bye) {
    line = html`Round ${round.n} is a bye: it scores a draw whatever is played. So far ${spentUnposted(round) ? estFig(round.conv) : fig(round.conv)} in ${countOf(round.stops, 'stop')}.`;
  } else {
    line = html`Round ${round.n}: Habit plays ${fig(round.habit)}. So far ${spentUnposted(round) ? estFig(round.conv) : fig(round.conv)} in ${countOf(round.stops, 'stop')}, ${round.status !== 'final' ? estFig(round.kept) : fig(round.kept)} kept. Win at ${fig(round.winLine)} or less; loss above ${fig(round.lossLine)}.`;
  }
  return html`<div class="mv-standing">
    <p class="cap">${line}</p>
    ${principles.length ? html`<div class="mv-rules">
      <p class="lab">Your own rules</p>
      <ol class="principles">${principles.map((text, i) => html`<li data-key="${'p' + i}"><b>${i + 1}</b><span>${text}</span></li>`)}</ol>
    </div>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ views */

function headLine(ctx, round, note) {
  const where = inMatch(ctx, round)
    ? 'Round ' + round.n + ', move ' + (round.moves.filter((tx) => !tx.matchId).length + 1)
    : fmtDate(ctx.today, 'dowshort');
  return html`<p class="sheet-head lab"><b>Candidate move</b><i class="sep"></i>${note || where}</p>`;
}

function editView(ctx, draft) {
  const round = ctx.d.todayRound;
  const usual = ctx.d.chips;
  const move = reading(ctx.state, draft, usual);
  const pressed = isStop(move.category) ? move.category : ELSE;
  const cover = !!ctx.state.settings.cover;
  return html`<div class="sheet-body mv"${attrs({ 'data-cover': cover })}>
    ${headLine(ctx, round)}
    <h2 class="sheet-title">Look before you play it.</h2>
    ${usual.length ? html`<div class="chips mv-usual" role="group" aria-label="Your usual stops">
      ${usual.map((chip) => html`<button class="chip" type="button" data-key="${chip.mkey}" data-action="move.chip" data-mkey="${chip.mkey}"
        aria-pressed="${draft.mkey === chip.mkey && move.amount === chip.typical ? 'true' : 'false'}">${chip.merchant}&nbsp;<span data-fig>${fmtPlain(chip.typical)}</span></button>`)}
    </div>` : html`<p class="cap">Your usual stops appear here as one-tap chips once the bank has reported a few.</p>`}
    <div class="${cx('field', draft.error === 'amount' && 'is-invalid')}">
      <label class="money">
        <span class="vh">Amount in dollars</span>
        <span class="money-cur" aria-hidden="true">$</span>
        <input class="money-input" type="text" name="amount" inputmode="decimal" placeholder="0.00" autocomplete="off" enterkeyhint="done"
          value="${draft.amount}" data-input="move.input"${attrs({ autofocus: ctx.wide && !draft.amount, 'aria-invalid': draft.error === 'amount' ? 'true' : null })}>
      </label>
      ${draft.error === 'amount' ? html`<p class="field-error" role="alert">Enter the price first: a move is recorded with its amount.</p>` : ''}
    </div>
    <label class="field">
      <span class="field-label lab">Place</span>
      <input class="input" type="text" name="merchant" placeholder="Where — optional" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done"
        maxlength="60" value="${draft.merchant}" data-input="move.input">
    </label>
    <div class="chips mv-cats" role="group" aria-label="Counts as">
      ${STOP_CHIPS.map(([key, text]) => html`<button class="chip" type="button" data-key="${key}" data-action="move.category" data-category="${key}" aria-pressed="${pressed === key ? 'true' : 'false'}">${text}</button>`)}
      <button class="chip" type="button" data-key="else" data-action="move.category" data-category="${ELSE}" aria-pressed="${pressed === ELSE ? 'true' : 'false'}">Something else</button>
    </div>
    ${move.amount === null ? standing(ctx, round) : consequence(ctx, round, move)}
    <div class="sheet-actions">
      <button class="btn" type="button" data-action="move.play">Play it</button>
      <button class="btn" type="button" data-action="move.adjourn">Adjourn 10:00</button>
      <button class="btn btn-solid" type="button" data-action="move.decline">Decline</button>
    </div>
  </div>`;
}

function clockText(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function sealedView(ctx, sealed) {
  const round = ctx.d.todayRound;
  const move = reading(ctx.state, sealed, ctx.d.chips);
  const wait = sealed.until - ctx.now;
  const open = wait <= 0;
  const cover = !!ctx.state.settings.cover;
  return html`<div class="sheet-body mv"${attrs({ 'data-cover': cover })}>
    ${headLine(ctx, round, 'adjourned')}
    <h2 class="sheet-title">${open ? html`The ten minutes are up.` : html`Sealed until ${fmtTime(sealed.until)}.`}</h2>
    <p class="mv-count">
      <span class="fig fig-xl" role="timer" data-cover-keep><span class="vh">${open ? 'Time is up: ' : 'Time until play resumes: '}</span>${clockText(wait)}</span>
      <span class="cap">${open ? html`Sealed at ${fmtTime(sealed.at)}. The move is open: play it or decline it.` : html`until play resumes. Sealed at ${fmtTime(sealed.at)}; nothing is recorded yet.`}</span>
    </p>
    <ul class="rows">
      <li class="row" data-key="sealed">
        <span class="row-label">${move.merchant || categoryLabel(move.category)} <em class="row-note">${move.merchant ? categoryLabel(move.category) + ' · ' : ''}the sealed move</em></span>
        <span class="row-value">${money(move.amount, { est: true })}</span>
      </li>
    </ul>
    ${move.amount === null ? '' : consequence(ctx, round, move)}
    <p class="mv-aside"><button class="btn-link" type="button" data-action="move.unseal">Set it aside</button><span class="cap">Clears the sealed move without recording it.</span></p>
    <div class="sheet-actions">
      <button class="btn" type="button" data-action="move.play">Play it</button>
      <button class="btn btn-solid" type="button" data-action="move.decline">Decline</button>
    </div>
  </div>`;
}

function insteadView(ctx, draft) {
  const round = ctx.d.todayRound;
  const insteads = (ctx.state.settings.insteads || []).filter((text) => typeof text === 'string' && text.trim());
  const mark = ctx.d.annotations(ctx.today).moves.get(draft.declineId) || null;
  const cover = !!ctx.state.settings.cover;
  const priced = Number.isFinite(draft.amount) && draft.amount > 0;
  return html`<div class="sheet-body mv"${attrs({ 'data-cover': cover })}>
    ${headLine(ctx, round, 'declined ' + fmtTime(draft.at))}
    <h2 class="sheet-title">Not played.</h2>
    <div class="conseq mv-conseq">
      ${mark ? html`<b class="conseq-sym">${mark.glyph}</b>` : ''}
      <div>
        <strong>Declined${draft.merchant ? html`: ${draft.merchant}` : ''}.</strong>
        <p class="mv-line">${priced ? html`The ${fig(draft.amount)} stays on your side of the board.` : html`Recorded at ${fmtTime(draft.at)} without a price.`}${inMatch(ctx, round) ? html` Kept today holds at ${fig(round.kept)}.` : ''}</p>
      </div>
    </div>
    ${insteads.length ? html`<fieldset class="field mv-instead">
      <legend class="field-label lab">Instead</legend>
      <div class="chips">
        ${insteads.map((text, i) => html`<button class="chip" type="button" data-key="${'i' + i}" data-action="move.instead" data-instead="${text}">${text}</button>`)}
      </div>
      <span class="field-help cap">One tap adds it to the move and closes. Answering is optional.</span>
    </fieldset>` : html`<p class="cap">The declined purchase is on today’s scoresheet, recorded at ${fmtTime(draft.at)}.</p>`}
    <div class="sheet-actions">
      <button class="btn" type="button" data-action="move.done">Done</button>
    </div>
  </div>`;
}

export function render(ctx, params) {
  const draft = draftOf(ctx.ui, ctx.now);
  if (draft.stage === 'instead') return insteadView(ctx, draft);
  const sealed = sealedOf(ctx.ui, ctx.today);
  if (sealed) return sealedView(ctx, sealed);
  return editView(ctx, draft);
}

/* ---------------------------------------------------------------- actions */

let afterClose = null;
let ticker = 0;

/**
 * Close the sheet, then run `fn` once it has gone — so what the action records never redraws the
 * sheet on its way out. (The router answers on its next event; the timer is only a safety net.)
 */
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
  // Closed by Close, Escape or the backdrop while "Instead:" was showing: the decline is recorded; start clean.
  else if (store.ui.move && store.ui.move.stage === 'instead') store.setUi({ move: null });
});

/** One re-render a second while a sealed move is counting down and the sheet is showing it. */
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const ctx = context();
    const sealed = store.ui.adjourn;
    if (!sealed || !ctx || ctx.now >= sealed.until) {
      clearInterval(ticker);
      ticker = 0;
      return;
    }
    if (ctx.route.sheet && ctx.route.sheet.name === SHEET) rerender();
  }, 1000);
}

/** The move the buttons act on: the sealed one while there is one, else the draft. */
function current(ctx) {
  const sealed = sealedOf(ctx.ui, ctx.today);
  const source = sealed || draftOf(ctx.ui, ctx.now);
  return { source, sealed: !!sealed, move: reading(ctx.state, source, ctx.d.chips) };
}

function patchDraft(patch) {
  const ctx = context();
  const draft = draftOf(ctx.ui, ctx.now);
  store.setUi({ move: { ...BLANK, ...(draft.stage ? {} : draft), ...patch, at: nowMs() } });
}

function askForAmount(el) {
  patchDraft({ error: 'amount' });
  const body = el.closest('.sheet-body');
  const input = body ? body.querySelector('input[name="amount"]') : null;
  if (input) input.focus();
}

/** The Decline button is gone once the result is drawn: the focus moves to the result's first control, inside the sheet. */
function focusResult() {
  const place = () => {
    const host = document.getElementById('sheet-host') || document;
    const target = host.querySelector('[data-action="move.instead"], [data-action="move.done"]');
    if (target) { target.focus(); return true; }
    return false;
  };
  if (!place()) requestAnimationFrame(place);
}

/**
 * What the toast says about a recorded move, with its figure (left out while cover is on) and its round:
 * "Recorded: Dunkin' $3.65, round 10." / "Declined: Blank Street Coffee, $5.25 not spent."
 */
function recordedText(ctx, tx) {
  const cover = !!ctx.state.settings.cover;
  const name = tx.merchant || categoryLabel(tx.category);
  if (tx.kind === 'decline') {
    return 'Declined: ' + name + (cover || !(tx.amount > 0) ? '.' : ', ' + fmt(tx.amount) + ' not spent.');
  }
  const round = ctx.d.round(tx.day);
  const rd = round && round.n > 0 && round.status !== 'prematch' ? ', round ' + round.n : ', ' + fmtDate(tx.day, 'short');
  return 'Recorded: ' + name + (cover ? '' : ' ' + fmt(tx.amount)) + rd + '.';
}

function recorded(txId) {
  const ctx = context();
  const tx = ctx.state.txs.find((t) => t && t.id === txId);
  const name = tx ? tx.merchant || categoryLabel(tx.category) : 'the move';
  const removedText = tx && !ctx.state.settings.cover && tx.amount > 0 ? 'Removed: ' + name + ' ' + fmt(tx.amount) + '.' : 'Removed: ' + name + '.';
  toast(tx ? recordedText(ctx, tx) : 'Recorded on ' + fmtDate(ctx.today, 'short') + '.', {
    action: 'Undo',
    onAction: () => {
      let removed = false;
      store.update((s) => { removed = removeManual(s, txId); });
      toast(removed ? removedText : 'Already confirmed by the bank: nothing to remove.');
    },
  });
}

export const actions = {
  'move.chip': ({ data }) => {
    const ctx = context();
    const chip = ctx.d.chips.find((c) => c.mkey === data.mkey);
    if (!chip) return;
    patchDraft({ amount: fmtPlain(chip.typical), merchant: chip.merchant, mkey: chip.mkey, category: isStop(chip.category) ? chip.category : ELSE, error: null });
  },

  'move.input': ({ el }) => {
    if (el.name === 'amount') patchDraft({ amount: el.value, error: null });
    else if (el.name === 'merchant') patchDraft({ merchant: el.value, mkey: '' });
  },

  'move.category': ({ data }) => {
    if (data.category === ELSE || isStop(data.category)) patchDraft({ category: data.category });
  },

  'move.play': ({ el }) => {
    const ctx = context();
    const { move, sealed } = current(ctx);
    if (move.amount === null) {
      if (!sealed) askForAmount(el);
      return;
    }
    const day = ctx.today;
    closeThen(() => {
      let tx = null;
      store.update((s) => {
        tx = addProvisional(s, { amount: move.amount, merchant: move.merchant, mkey: move.mkey || undefined, category: move.category, day }, nowMs());
      });
      store.setUi({ move: null, adjourn: null });
      if (tx) recorded(tx.id);
    });
  },

  'move.adjourn': ({ el }) => {
    const ctx = context();
    const { source, move, sealed } = current(ctx);
    if (sealed) return;
    if (move.amount === null) { askForAmount(el); return; }
    const at = nowMs();
    store.setUi({
      move: null,
      adjourn: { at, until: at + ADJOURN_MS, day: ctx.today, amount: source.amount, merchant: move.merchant, mkey: move.mkey, category: source.category || move.category },
    });
    startTicker();
  },

  'move.decline': () => {
    const ctx = context();
    const { move } = current(ctx);
    const at = nowMs();
    let tx = null;
    store.update((s) => {
      tx = addDecline(s, { amount: move.amount, merchant: move.merchant, mkey: move.mkey || undefined, category: move.category, day: ctx.today }, at);
    });
    if (!tx) return;
    store.setUi({ adjourn: null, move: { stage: 'instead', declineId: tx.id, amount: move.amount, merchant: move.merchant, at } });
    focusResult();
  },

  'move.instead': ({ data }) => {
    const draft = store.ui.move;
    if (!draft || draft.stage !== 'instead') return;
    const text = String(data.instead || '').trim();
    const id = draft.declineId;
    closeThen(() => {
      store.update((s) => {
        const tx = s.txs.find((t) => t.id === id && t.kind === 'decline');
        if (tx && text) tx.instead = text;
      });
      store.setUi({ move: null });
      recorded(id);
    });
  },

  'move.done': () => {
    const draft = store.ui.move;
    const id = draft && draft.stage === 'instead' ? draft.declineId : null;
    closeThen(() => {
      store.setUi({ move: null });
      if (id) recorded(id);
    });
  },

  'move.unseal': () => {
    store.setUi({ adjourn: null, move: null });
  },
};
