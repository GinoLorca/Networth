/**
 * The Board — the daily glance, composed like the front page of a tournament bulletin.
 *
 * Wide screens (the gallery's "Plate: the Board, rebuilt"):
 *   net worth | cash on hand          two ruled columns
 *   the round | the position | notes  three ruled columns
 *   the crosstable                    full width
 *   figures | card cycle, income      two ruled columns
 *   key to symbols
 *
 * Narrow screens are one column, and the first screenful has to carry the net-worth figure, cash on
 * hand with what is due, and today's standing. So below 900px (ctx.wide false) the markup itself is
 * ordered differently: the slow-moving parts of the first two sections — assets against liabilities
 * with the liquid figure and yesterday's breakdown, and the reserve — are set as bands of their own
 * after the round.
 *
 * render(ctx) is pure. The only action of this screen is `board.hero`; everything else opens a
 * sheet or another screen through the app-level actions (app.sheet, app.move) or a plain link.
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { fmt, fmtPct, ratio } from '../model/money.js';
import { addDays, diffDays, fmtDate, fmtMonth, fmtTime, isYmd, monthOf, ymd } from '../model/dates.js';
import { firstTransactionDay } from '../model/cards.js';
import { evalGlyph, timeTroubleGlyph, moveGlyph, resultMark } from '../ui/glyphs.js';
import { money, inlineMoney, keptLine, statusLine, roundTitle, colourOf, crosstable, movesList, notableMoves, worstGlyph, spentUnposted } from './parts.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const WORTH_DAYS = 90;
const EDGE_ROUNDS_SHOWN = 92;
const DUE_SHOWN = 3;
const RUNWAY_SEGMENTS = 7;
/** The clock's typical outflow is an average over this many days (ledger: burn). */
const BURN_DAYS = 60;
/** The day of the month from which the card's month pace is read (cards.js: no pace before it). */
const PACE_FROM_DAY = 7;
const LONG_CASH = 1000000;
/** From $1,000,000.00 (eight digits and more) the cash figure takes a size that fits its column. */
const HUGE_CASH = 100000000;
const NORM_TITLES = ['GM', 'IM', 'FM', 'CM', 'NM'];
/** Between the parts of a run-in line: the dot stays with the part before it when the line breaks. */
const DOT = '\u00A0· ';

/* ---------------------------------------------------------------- helpers */

const MONEY_IN_TEXT = /[+−-]?\$\d[\d,]*(?:\.\d+)?[KM]?/g;

/**
 * A sentence from the engine with every amount wrapped so that cover mode redacts it.
 * `upright` sets the amounts in <i> (upright inside an italic note) instead of <span>.
 */
function figText(text, upright) {
  const s = text == null ? '' : String(text);
  const out = [];
  let at = 0;
  for (const m of s.matchAll(MONEY_IN_TEXT)) {
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push(upright ? html`<i data-fig>${m[0]}</i>` : html`<span data-fig>${m[0]}</span>`);
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

function hasMoney(text) {
  return typeof text === 'string' && text.search(MONEY_IN_TEXT) >= 0;
}

/**
 * A timestamp as it reads from now: "4:00 AM" · "yesterday, 9:41 PM" · "Jun 3, 9:41 PM".
 * With `sentence`, the same as the end of a sentence: "at 4:00 AM" · "yesterday at 9:41 PM" · "on Jun 3 at 9:41 PM".
 */
function whenText(ctx, ms, sentence) {
  if (!Number.isFinite(ms)) return sentence ? 'at a time not on record' : 'a time not on record';
  const day = ymd(ms);
  const age = diffDays(day, ymd(ctx.now));
  const time = fmtTime(ms);
  if (age <= 0) return sentence ? 'at ' + time : time;
  if (age === 1) return sentence ? 'yesterday at ' + time : 'yesterday, ' + time;
  return sentence ? 'on ' + fmtDate(day, 'short') + ' at ' + time : fmtDate(day, 'short') + ', ' + time;
}

function plural(n, one, many) {
  return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
}

/** True when the two figures over a split bar are too long to share one line with their labels on a phone. */
function longPair(a, b, estimates) {
  return fmt(a).length + fmt(b).length + estimates > 22;
}

/**
 * The width of a hero figure in ems, so the figure fills its column (the hero block sizes the type as
 * column width / --hero-ems). Measured on the ticker's own cells in Didot: a live figure is italic
 * (digit .53, dollar sign .63) and carries the approximately sign and two small digits (.69 together);
 * a figure at the bank is roman and a little wider (digit .567, dollar sign .667). Points and commas
 * are .2, a minus .6.
 */
function figureEms(cents, live) {
  let ems = live ? 0.69 : 0;
  for (const ch of fmt(Math.trunc(cents))) {
    if (ch >= '0' && ch <= '9') ems += live ? 0.53 : 0.567;
    else if (ch === ',' || ch === '.') ems += 0.2;
    else if (ch === '$') ems += live ? 0.63 : 0.667;
    else ems += 0.6;
  }
  return ems;
}

/**
 * True when an account kept by hand carries an estimate: the owner's own valuation, or a loan the app
 * works down from its last figure. A balance typed today from a statement is a statement figure.
 */
function ownEstimate(ctx, account) {
  if (!account || account.hidden || account.source !== 'manual') return false;
  if (account.basis !== 'statement') return true;
  return !!account.loan && !(Number.isFinite(account.asOf) && account.asOf > 0 && ymd(account.asOf) === ctx.today);
}

/** True when an owner-kept (manual) account in one of these groups carries an estimate: the total is then partly an estimate. */
function keptByHand(ctx, groups) {
  const own = (account) => ownEstimate(ctx, ctx.state.accounts.find((a) => a && account && a.id === account.id) || account);
  return groups.some((group) => ctx.d.accounts(group).some(own));
}

function scoresheetDay(day) {
  return '#/scoresheet/' + monthOf(day) + '?day=' + day;
}

/**
 * The name of a regular pay stream the owner chose to count on arrival (accrue off, and locked so),
 * or '' when there is none.
 */
function payOnArrival(ctx) {
  const streams = Array.isArray(ctx.state.streams) ? ctx.state.streams : [];
  const held = streams.find((s) => s && s.active !== false && s.accrue === false && Array.isArray(s.locks) && s.locks.includes('accrue'));
  return held ? held.name || 'regular pay' : '';
}

/**
 * Everything the sections share, read once.
 * `estimated` is true when the live figure is not simply the bank's (pay or bills accrue, or a move is tapped in).
 */
function model(ctx) {
  const pos = ctx.d.position;
  const estimated = pos.smoothing || pos.provisional > 0;
  const seen = ctx.ui.seen && Number.isFinite(ctx.ui.seen.cents) && Number.isFinite(ctx.ui.seen.at) ? ctx.ui.seen : null;
  const firstDay = firstTransactionDay(ctx.state);
  return {
    pos,
    estimated,
    showLive: estimated && ctx.ui.heroMode !== 'bank',
    seen,
    roll: seen !== null && ctx.now - seen.at >= TEN_MINUTES_MS,
    cover: !!ctx.state.settings.cover,
    firstDay,
    // one count of history for every screen: first transaction's day through today, both included
    historyDays: Number.isFinite(ctx.d.historyDays) ? ctx.d.historyDays : 0,
    matchOn: isYmd(ctx.state.meta.matchStart) && ctx.d.todayRound.status !== 'prematch',
    manualCount: ctx.state.accounts.filter((account) => !account.hidden && account.source === 'manual').length,
    // the figure at the bank still holds the owner's own estimates (equipment, a loan worked down)
    bankEst: ctx.state.accounts.some((account) => ownEstimate(ctx, account)),
    lapsed: (Array.isArray(pos.lapsedPay) ? pos.lapsedPay : []).filter((item) => item && typeof item === 'object'),
    streams: Array.isArray(ctx.state.streams) ? ctx.state.streams : [],
    payOnArrival: payOnArrival(ctx),
  };
}

/* ------------------------------------------------------------ A. net worth */

function heroMain(ctx, v) {
  const { pos, estimated, showLive } = v;
  // one size for both readings, so a tap changes the figure and not its scale
  const ems = (estimated ? Math.max(figureEms(pos.live, true), figureEms(pos.bank, v.bankEst)) : figureEms(pos.bank, v.bankEst)) * 1.012;
  // a ticker of its own for each reading: a tap sets the other figure at once, with no roll through
  // values that neither the bank nor the estimate ever showed
  const ticker = html`<nw-ticker data-island data-key="${showLive ? 'hero-live' : 'hero-bank'}"${attrs({
    approx: showLive || v.bankEst,
    value: showLive ? pos.live : pos.bank,
    rate: showLive ? pos.rate : 0,
    t0: pos.at,
    from: showLive && v.roll && !ctx.ui.heroMode ? v.seen.cents : null,
    label: showLive ? 'Net worth, live estimate:' : v.bankEst ? 'Net worth at the bank, with your own estimates:' : 'Net worth at the bank:',
  })}></nw-ticker>`;
  const size = '--hero-ems:' + ems.toFixed(2);

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-nw"><b>Net worth</b><i class="sep"></i>${showLive ? html`<span class="spot">Live</span>` : 'At the bank'}</h2>
      ${estimated ? html`<button class="btn-link" type="button" data-action="board.hero">${showLive ? 'At the bank' : 'Live'}</button>` : ''}
    </div>
    ${estimated
      ? html`<button class="hero-fig" type="button" data-action="board.hero" style="${size}">${ticker}<span class="vh">${showLive ? 'Show the figure at the bank' : 'Show the live figure'}</span></button>`
      : html`<p class="hero-fig" style="${size}">${ticker}</p>`}
    ${heroCaption(ctx, v)}
    ${heroMeta(ctx, v)}`;
}

/** One line under the figure: what the live figure is made of, or when the bank reported its own. */
function heroCaption(ctx, v) {
  const { pos, estimated, showLive } = v;
  const reported = whenText(ctx, pos.dataAt ?? pos.syncedAt, true);
  if (!showLive) {
    const byHand = v.manualCount ? html`, with the ${plural(v.manualCount, 'account', 'accounts')} kept by hand at your own figures` : '';
    const on = v.historyDays > 0 ? 'in the ' + plural(v.historyDays, 'day', 'days') + ' on record' : 'yet';
    // "not found" is only for a record with no regular pay at all; pay the owner counts on arrival is said as that
    const plain = estimated ? '' : !ctx.state.settings.smoothing
      ? html` Pay is counted when it arrives: day-by-day counting is switched off, so pay and bills count on the day they post.`
      : v.payOnArrival
        ? html` Pay is counted when it arrives: ${v.payOnArrival} is not counted day by day, so pay and bills count on the day they post.`
        : v.lapsed.length
          ? html` Pay and bills count on the day they post.`
          : html` No regular pay is detected ${on}, so pay and bills count on the day they post.`;
    return html`<p class="cap board-compo">As the bank reported it ${reported}${byHand}.${plain}</p>${lapsedLines(v)}`;
  }
  const main = pos.receivables.slice().sort((a, b) => b.daily - a.daily)[0];
  const held = pos.smoothing && pos.rate === 0 && pos.freshness !== 'fresh';
  const bits = [html`<span class="nowrap">At the bank ${money(pos.bank)}</span>`];
  // one live figure: the parts add up to the floored hero, so bills used takes the remainder (as Material)
  const bankC = Math.round(pos.bank);
  const recvC = Math.round(pos.receivable);
  const provC = Math.round(pos.provisional || 0);
  const liveC = Number.isFinite(pos.live) ? Math.floor(pos.live) : null;
  const payC = liveC != null ? bankC + recvC - provC - liveC : Math.round(pos.payable);
  if (pos.smoothing) {
    bits.push(html`<span class="nowrap">pay earned${main ? ' since ' + fmtDate(main.since, 'short') : ''} ${money(recvC, { est: true, signed: true })}</span>`);
    bits.push(html`<span class="nowrap">bills used ${money(-payC, { est: true, signed: true })}</span>`);
  }
  if (provC > 0) {
    bits.push(html`<span class="nowrap">tapped in, not yet at the bank ${money(-provC, { est: true, signed: true })}</span>`);
  }
  return html`<p class="cap board-compo">${bits.map((bit, i) => html`${i ? DOT : ''}${bit}`)}${held
    ? html`<span class="board-held">The figure holds still: the bank last reported ${reported}.</span>` : ''}</p>${lapsedLines(v)}`;
}

/** A pay stream whose deposits stopped (ledger: lapsedPay): one line each, under the composition. */
/** Whether a stream is counted day by day (accrue): only then does a stop end "pay counted as earned". */
function countedDayByDay(v, id) {
  const stream = (v.streams || []).find((s) => s && s.id === id);
  return !stream || stream.accrue !== false;
}

function lapsedLines(v) {
  return v.lapsed.map((item) => html`<p class="cap board-lapsed" data-key="${'lapsed-' + item.id}">No deposit from ${item.name || 'a regular payer'} since ${isYmd(item.since) ? fmtDate(item.since, 'short') : 'a day not on record'}; ${countedDayByDay(v, item.id) ? 'pay is no longer counted as earned' : 'its payday is no longer expected'}.</p>`);
}

/** What yesterday's change was made of: earned · bills · spent. */
function yesterdayParts(y, smoothing) {
  // earned and bills are accruals while pay and bills are counted day by day; a day in pencil is not final at all
  const accrued = !!smoothing || !!y.partial;
  return html`earned ${inlineMoney(y.earned, { est: accrued })}${DOT}bills ${inlineMoney(y.bills, { est: accrued })}${DOT}spent ${inlineMoney(y.spent, { est: !!y.partial })}`;
}

/** Yesterday · this month · since last look. */
function heroMeta(ctx, v) {
  const { pos } = v;
  const y = ctx.d.yesterday;
  const ret = ctx.d.retention();
  const items = [];
  items.push(html`<div class="tally-item">
    <span class="lab">Yesterday</span>
    ${y ? money(y.result, { est: y.partial || pos.smoothing, signed: true, tint: true }) : html`<span class="fig">—</span>`}
    <span class="cap">${y
      ? (ctx.wide ? yesterdayParts(y, pos.smoothing) : html`${fmtDate(y.day, 'dowshort')}${y.partial ? ', in pencil' : ''}`)
      : html`no record of ${fmtDate(addDays(ctx.today, -1), 'short')}`}</span>
  </div>`);
  items.push(html`<div class="tally-item">
    <span class="lab">This month</span>
    ${money(ret.kept, { est: !!pos.smoothing || pos.provisional > 0, signed: true, tint: true })}
    <span class="cap">${ret.rate == null
      ? 'nothing counted as earned yet this month'
      : ret.kept >= 0
        ? html`kept of ${inlineMoney(ret.earned, { est: pos.smoothing })} earned`
        : html`more went out than the ${inlineMoney(ret.earned, { est: pos.smoothing })} earned`}</span>
  </div>`);
  if (v.seen) {
    items.push(html`<div class="tally-item">
      <span class="lab">Since last look</span>
      ${money(pos.live - v.seen.cents, { est: v.estimated, signed: true })}
      <span class="cap">${whenText(ctx, v.seen.at)}</span>
    </div>`);
  }
  return html`<div class="tally tally-s tally-ruled board-meta">${items}</div>`;
}

/** Assets against liabilities, the liquid figure, and the one quiet line about what the bank cannot see. */
function heroMore(ctx, v) {
  const { pos, cover } = v;
  const assetsEst = keptByHand(ctx, ['cash', 'asset']);
  const debtsEst = keptByHand(ctx, ['card', 'debt']);
  const liquidEst = keptByHand(ctx, ['cash', 'card']);
  const slow = ratio(pos.slowAssets, pos.assets);
  const label = cover ? 'Assets against liabilities' : 'Assets ' + fmt(pos.assets) + ' against liabilities ' + fmt(pos.liabilities);
  let note = '';
  if (v.manualCount && pos.slowAssets > 0) {
    note = html`${fmtPct(slow, 0)} of the assets is slow to sell: equipment and the like, at your own estimate.`;
  } else if (v.manualCount) {
    note = html`0% of the assets is slow to sell: all of it is cash and accounts.`;
  }
  const y = ctx.wide ? null : ctx.d.yesterday;
  return html`
    <figure class="${cx('split', 'board-split', longPair(pos.assets, pos.liabilities, (assetsEst ? 1 : 0) + (debtsEst ? 1 : 0)) && 'is-long')}">
      <figcaption class="split-labs">
        <span><span class="lab"><b>Assets</b></span>${money(pos.assets, { est: assetsEst })}</span>
        <span>${money(pos.liabilities, { est: debtsEst })}<span class="lab"><b>Liabilities</b></span></span>
      </figcaption>
      <nw-split data-island${attrs({ a: Math.max(0, Math.round(pos.assets)), b: Math.max(0, Math.round(pos.liabilities)), mark: 'centre', label })}></nw-split>
    </figure>
    <div class="board-under">
      ${note ? html`<p class="cap board-under-note">${note}</p>` : ''}
      ${v.manualCount ? '' : html`<p class="cap board-under-note">Equipment, a loan — add what the bank cannot see.
        <button class="btn-link" type="button" data-action="app.sheet" data-sheet="account">Add</button></p>`}
      <p class="board-liquid"><span class="lab"><b>Liquid</b></span>${money(pos.liquid, { est: liquidEst })}<span class="cap">cash minus cards</span></p>
    </div>
    ${y ? html`<p class="cap board-yesterday">Yesterday, ${fmtDate(y.day, 'short')}: ${yesterdayParts(y, pos.smoothing)}.</p>` : ''}`;
}

/* ----------------------------------------------------- B. cash on hand */

function clockMain(ctx, v) {
  const c = ctx.d.clock;
  const days = c.runwayDays;
  const on = days == null ? 0 : Math.min(RUNWAY_SEGMENTS, Math.max(0, Math.floor(days)));
  const runwayLabel = days == null ? 'Runway: not yet known' : days >= RUNWAY_SEGMENTS ? 'Runway: 7 days or more' : 'Runway: ' + plural(on, 'day', 'days') + ' of 7';
  const segments = [];
  for (let i = 0; i < RUNWAY_SEGMENTS; i++) segments.push(html`<i${attrs({ class: i < on ? 'is-on' : null })}></i>`);
  // The engine averages outflows over 60 days whatever the record holds; say so while the record is shorter.
  const short = v.firstDay && v.historyDays < BURN_DAYS;

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-clock"><b>Cash on hand</b><i class="sep"></i>the clock</h2>
      ${c.trouble ? html`<span class="tt lab">${timeTroubleGlyph({ decorative: true })}Time trouble</span>` : ''}
    </div>
    <div class="clock-body">
      <div>
        <p class="${cx('clock-cash', Math.abs(c.cash) >= LONG_CASH && 'is-long', Math.abs(c.cash) >= HUGE_CASH && 'is-huge')}">${fmt(c.cash)}</p>
        <p class="cap"><i class="bank-mark"></i>at the bank · from ${whenText(ctx, c.asOf)}</p>
      </div>
      <div class="clock-run">
        ${days == null
          ? html`<span class="fig est">— <small>on the clock</small></span>
            <p class="cap">Runway is read from 60 days of outflows; too few are on record.</p>`
          : html`<span class="fig est" data-cover-keep><span class="approx">≈</span>${days < 1 ? 'under 1 day' : plural(days, 'day', 'days')} <small>on the clock</small></span>
            <p class="cap">at about <span data-fig>${fmt(c.burn)}</span> a day${short
              ? (ctx.wide ? html`, a ${BURN_DAYS}-day average with ${plural(v.historyDays, 'day', 'days')} on record` : html` <span class="board-runnote">${v.historyDays} of ${BURN_DAYS} days on record</span>`)
              : ''}</p>`}
      </div>
    </div>
    <div class="runway" role="img" aria-label="${runwayLabel}">${segments}</div>
    <div class="runway-labs"><span class="lab">Flag</span><span class="lab">7 days · out of time trouble</span></div>
    ${clockDue(ctx, c)}`;
}

/** What is due before the next payday (or in the next 14 days), whether cash covers it, and up to three of the items. */
function clockDue(ctx, c) {
  if (!c.nextPayday && !c.due.length) {
    return html`<p class="cap clock-note board-nodue">No payday is on record yet and nothing is known to be due in the next 14 days. Both are read from the bank once they repeat.</p>`;
  }
  const spare = c.cash - c.dueTotal;
  const shown = c.due.slice(0, DUE_SHOWN);
  const more = c.due.length - shown.length;
  // a paycheck that is awaited (its scheduled day passed with no deposit): the window runs through
  // dueUntil, and today is never called the payday (ledger: Clock.payAwaited, Clock.dueUntil)
  // T1: on the payday itself, or in the first days after an awaited one, the window is today alone
  const awaited = isYmd(c.payAwaited) ? c.payAwaited : null;
  const todayOnly = isYmd(c.dueUntil) ? c.dueUntil <= ctx.today : c.nextPayday === ctx.today;
  const paydayToday = !awaited && c.nextPayday === ctx.today;
  const heading = todayOnly ? 'Due today'
    : awaited && isYmd(c.dueUntil) ? 'Due through ' + fmtDate(c.dueUntil, 'dowshort')
    : c.nextPayday ? 'Due before ' + fmtDate(c.nextPayday, 'dowshort') : 'Due in the next 14 days';
  const until = todayOnly ? 'due today'
    : awaited && isYmd(c.dueUntil) ? 'through ' + fmtDate(c.dueUntil, 'short')
    : c.nextPayday ? 'before ' + fmtDate(c.nextPayday, 'short') : 'before the 14 days are out';
  const beforePayday = c.nextPayday && !awaited && !todayOnly;
  return html`
    ${awaited ? html`<p class="cap clock-note board-awaited">Pay expected ${fmtDate(awaited, 'dowshort')} is not on the bank’s record yet.</p>` : ''}
    ${paydayToday ? html`<p class="cap clock-note board-payday">Payday is today.</p>` : ''}
    <div class="tally tally-s clock-due">
      <div class="tally-item">
        <span class="lab">${heading}</span>
        ${money(c.dueTotal, { est: c.dueTotal > 0 })}
        <span class="cap">${c.due.length ? plural(c.due.length, 'payment', 'payments') + (beforePayday ? ' before payday' : '') : 'nothing is due'}</span>
      </div>
      ${c.shortfall > 0
        ? html`<div class="tally-item">
            <span class="lab"><span class="spot">${timeTroubleGlyph({ decorative: true })}</span> Short</span>
            ${money(c.shortfall, { est: true })}
            <span class="cap">cash does not cover it</span>
          </div>`
        : html`<div class="tally-item">
            <span class="lab">To spare</span>
            ${money(spare, { est: c.dueTotal > 0 })}
            <span class="cap">covered</span>
          </div>`}
    </div>
    ${shown.length ? html`<ul class="board-due" aria-label="What is due">
      ${shown.map((item) => html`<li data-key="${item.id + item.day}">
        <span class="board-due-name">${item.name}</span>
        <span class="${cx('lab', 'lab-s', item.overdue && 'board-overdue')}">${item.overdue ? 'overdue since ' + fmtDate(item.day, 'short') : fmtDate(item.day, 'dowshort')}</span>
        ${money(item.amount, { est: true })}
      </li>`)}
      ${more > 0 ? html`<li class="board-due-more" data-key="more"><a class="cap" href="#/book">and ${more} more ${until}, in the Book</a></li>` : ''}
    </ul>` : ''}`;
}

/** The reserve against its target, and its milestones measured in time. */
function reserveBlock(ctx) {
  const c = ctx.d.clock;
  const next = c.milestones.findIndex((m) => !m.reached);
  return html`
    <p class="clock-reserve-row">
      <span class="lab">Reserve</span>${money(c.reserve)}
      <span class="cap">${c.reserveTarget > 0 ? html`${fmtPct(ratio(c.reserve, c.reserveTarget), 1)} of <span data-fig>${fmt(c.reserveTarget, { decimals: 0 })}</span>` : 'no goal is set'}</span>
    </p>
    <ol class="ticks" aria-label="Reserve milestones, in days of typical outflow">
      ${c.milestones.map((m, i) => html`<li${attrs({ class: m.reached ? 'is-done' : i === next ? 'is-next' : null })}>${m.label}${m.reached ? html`<span class="vh">, reached</span>` : i === next ? html`<span class="vh">, next</span>` : ''}</li>`)}
    </ol>`;
}

/* ---------------------------------------------------------- C. the round */

/**
 * Annotation reasons as the moves list prints them. Under cover a reason that quotes an amount is
 * withheld (the list sets reasons as plain text, where the redaction cannot reach). Every reason gets a
 * closing space, because the list sets a move's tag ("Pending", "Tapped in") straight after it.
 */
function reasons(annotations, cover) {
  const out = new Map();
  for (const [id, a] of annotations) {
    const why = !a.why || (cover && hasMoney(a.why)) ? '' : a.why + ' ';
    out.set(id, why === a.why ? a : { ...a, why });
  }
  return out;
}

function byesUsed(ctx) {
  const ym = monthOf(ctx.today);
  let n = 0;
  for (const day in ctx.state.days) if (monthOf(day) === ym && ctx.state.days[day] && ctx.state.days[day].bye) n++;
  return n;
}

function planSummary(ctx, plan) {
  const bits = [];
  for (const item of plan.ready || []) bits.push(item.label + (item.yes ? ': yes' : ': no'));
  if (plan.stops != null) bits.push(plan.stops === 0 ? '0 planned stops' : plural(plan.stops, 'planned stop', 'planned stops'));
  const record = ctx.state.days[ctx.today];
  const at = record && record.plan && Number.isFinite(record.plan.at) ? record.plan.at : null;
  return 'Opening preparation' + (at ? ', ' + fmtTime(at) : '') + ': ' + (bits.length ? bits.join(', ') : 'recorded for ' + fmtDate(ctx.today, 'short')) + '.';
}

function todayBlock(ctx, v) {
  const r = ctx.d.todayRound;
  const ann = ctx.d.annotations(r.day);
  const notable = notableMoves(r, ann.moves);
  const others = r.moves.filter((tx) => !tx.matchId).length - notable.length;
  const played = r.moves.some((tx) => !tx.matchId && tx.klass === 'game' && (tx.kind === 'spend' || tx.kind === 'decline'));
  const workday = r.type === 'work';
  const per = ctx.state.settings.byesPerMonth || 0;
  const byesLeft = Math.max(0, per - byesUsed(ctx));
  const month = fmtMonth(monthOf(ctx.today), 'name');
  const label = v.cover ? 'Kept against spent, so far' : 'Kept ' + fmt(Math.max(0, r.kept)) + ' against spent ' + fmt(r.conv) + ', so far';
  // The premise of the round. Under the title on wide screens; under the bar on phones, where the
  // standing itself has to reach the first screenful.
  const premise = html`Habit plays <span data-fig>${fmt(r.habit)}</span> on a ${workday ? 'workday' : 'day off'}.
    Win at <span data-fig>${fmt(r.winLine)}</span> or less${DOT}loss above <span data-fig>${fmt(r.lossLine)}</span>.${
    r.bye ? ' A bye is declared: today scores ½ whatever is spent, and its dollars still count.' : ''}`;

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-today"><b>Today</b><i class="sep"></i>Round ${r.n}</h2>
      <span class="lab">${fmtDate(r.day, 'dowshort')}<i class="sep"></i>${colourOf(r)}</span>
    </div>
    <h3 class="title board-vs">You <i>v.</i> Habit</h3>
    ${ctx.wide ? html`<p class="cap board-premise">${premise}</p>` : ''}
    <div class="tally board-standing">
      <div class="tally-item"><span class="lab">Habit</span>${money(r.habit)}</div>
      <div class="tally-item"><span class="lab">Spent</span>${money(r.conv, { est: spentUnposted(r) })}</div>
      <div class="tally-item"><span class="lab"><b>Standing</b></span><span class="fig est"><span class="approx">≈</span>${fmt(r.kept, { sign: 'always' })} <small>so far</small></span></div>
    </div>
    <figure class="split board-kept">
      <figcaption class="split-labs"><span class="lab"><b>Kept</b></span><span class="lab"><b>Spent</b></span></figcaption>
      <nw-split data-island slim${attrs({ a: Math.max(0, r.kept), b: Math.max(0, r.conv), label })}></nw-split>
      ${ctx.wide ? '' : html`<p class="cap split-note">${premise}</p>`}
    </figure>
    ${movesList(notable, reasons(ann.moves, v.cover), { blank: true, blankAt: notable.length + Math.max(0, others) + 1, label: 'Today’s moves' })}
    ${notable.length || others > 0
      ? (others > 0 ? html`<p class="cap board-more"><a href="${scoresheetDay(r.day)}">${notable.length
          ? 'and ' + plural(others, 'other move', 'other moves') + ' so far today'
          : plural(others, 'move', 'moves') + ' so far today'}</a>${notable.length ? '' : ', outside the game with Habit'}</p>` : '')
      : html`<p class="cap board-quiet">No moves on ${fmtDate(r.day, 'dowshort')} yet. The bank reports them as they post.</p>`}
    <div class="btn-row board-actions">
      <button class="btn" type="button" data-action="app.move"><span class="plus">+</span> Candidate move</button>
      ${workday && !r.plan ? html`<button class="btn" type="button" data-action="app.sheet" data-sheet="plan">Plan the morning</button>` : ''}
    </div>
    ${r.plan ? html`<p class="cap board-line">${planSummary(ctx, r.plan)}
      <button class="btn-link" type="button" data-action="app.sheet" data-sheet="plan">Change</button></p>` : ''}
    ${!r.bye && !played && byesLeft > 0 ? html`<p class="cap board-line">${byesLeft} of ${plural(per, 'bye', 'byes')} for ${month} not yet taken.
      <button class="btn-link" type="button" data-action="app.sheet" data-sheet="day" data-day="${r.day}">Take a bye</button></p>` : ''}`;
}

/** The last round that has a result. Returns '' when there is none to show. */
function lastBlock(ctx, v) {
  const r = ctx.d.lastRound;
  const yesterday = addDays(ctx.today, -1);
  const awaited = ctx.d.round(yesterday);
  if (r.result == null || r.status === 'prematch') {
    if (awaited.status === 'prematch') {
      return html`
        <div class="sec-head"><h2 class="lab" id="b-last"><b>Last result</b></h2></div>
        <p class="cap board-quiet">The match began ${fmtDate(ctx.state.meta.matchStart, 'dowshort')}: round ${ctx.d.todayRound.n} is its first, and no result is on record yet.</p>`;
    }
    return html`
      <div class="sec-head"><h2 class="lab" id="b-last"><b>Last result</b><i class="sep"></i>${roundTitle(awaited)}</h2></div>
      <p class="cap board-quiet">The bank has not reported ${fmtDate(yesterday, 'dowshort')} yet. Its result is entered when it does.</p>`;
  }
  const ann = ctx.d.annotations(r.day);
  const notable = notableMoves(r, ann.moves);
  const others = r.moves.filter((tx) => !tx.matchId).length - notable.length;
  const provisional = r.status === 'provisional';
  const why = ann.round && ann.round.why ? String(ann.round.why) : '';

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-last"><b>Last result</b><i class="sep"></i>${roundTitle(r)}</h2>
      <span class="lab">${colourOf(r)}</span>
    </div>
    <p class="board-result">
      <span class="board-result-mark">${resultMark(r.result, r.status, { glyph: ann.round ? ann.round.glyph : null })}</span>
      <span class="${cx('fig', 'fig-l', provisional && 'est')}">${provisional ? html`<span class="approx">≈</span>` : ''}${keptLine(r)}</span>
      <span class="cap">${r.bye ? 'A declared bye: it scores ½ and its dollars still count. ' : ''}${statusLine(r)}</span>
    </p>
    ${ann.round ? html`<p class="cap board-ann"><b class="sym">${ann.round.glyph}</b>${figText(why || 'The round carries an annotation.')}${!why || /[.?…]$/.test(why) ? '' : '.'}</p>` : ''}
    ${r.day !== yesterday ? html`<p class="cap board-ann">The bank has not reported ${fmtDate(yesterday, 'dowshort')} yet: round ${r.n} is the latest result on record.</p>` : ''}
    ${notable.length ? movesList(notable, reasons(ann.moves, v.cover), { label: 'Moves of round ' + r.n }) : ''}
    ${others > 0 || !notable.length ? html`<p class="cap board-more"><a href="${scoresheetDay(r.day)}">${
      notable.length ? 'and ' + plural(others, 'other move', 'other moves')
        : others > 0 ? plural(others, 'move', 'moves') + ' on ' + fmtDate(r.day, 'short')
          : 'Round ' + r.n + ' on the Scoresheet'}</a>${
      notable.length ? '' : others > 0 ? ', outside the game with Habit' : html`: no move on ${fmtDate(r.day, 'short')}`}</p>` : ''}`;
}

/** Before the match: one sentence, and what today holds so far. */
function prematchBlock(ctx, v) {
  const r = ctx.d.todayRound;
  const ann = ctx.d.annotations(r.day);
  const notable = notableMoves(r, ann.moves);
  const have = v.historyDays;
  const from = ctx.d.matchFromDay;
  // day 1 on record is the first transaction's day, so day {from} falls {from - 1} days after it
  const begins = v.firstDay && have < from ? addDays(v.firstDay, from - 1) : null;
  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-today"><b>Today</b><i class="sep"></i>before the match</h2>
      <span class="lab">${fmtDate(r.day, 'dowshort')}</span>
    </div>
    <h3 class="title board-vs">You <i>v.</i> Habit</h3>
    <p class="board-lede">${have < from
      ? html`The match begins on day ${from} on record; ${have} so far${begins ? html`. Round 1 falls around ${fmtDate(begins, 'dowshort')}` : ''}.`
      : html`The match begins with the next reading of the bank: today is day ${have} on record, and Habit is measured over the ${from - 1} full days of bank history before it.`}</p>
    <p class="cap board-line">Habit is your own usual spending on coffee and food on the go, measured over its first ${ctx.d.matchFromDay - 1} full days of bank history and then frozen. Each day after that is 1 round against it.</p>
    ${notable.length ? html`
      <div class="board-sofar">
        <p class="lab">Convenience moves so far today<i class="sep"></i><span data-fig>${fmt(r.conv)}</span></p>
        ${movesList(notable, reasons(ann.moves, v.cover), { label: 'Today’s convenience moves', plain: true })}
      </div>` : html`<p class="cap board-quiet">No convenience move on ${fmtDate(r.day, 'dowshort')} yet. The bank reports them as they post.</p>`}
    <div class="btn-row board-actions">
      <button class="btn" type="button" data-action="app.move"><span class="plus">+</span> Candidate move</button>
    </div>`;
}

/* ------------------------------------------------------ D. the crosstable */

function crosstableBlock(ctx, v) {
  const month = ctx.d.thisMonth;
  const pencil = month.rounds.filter((r) => r.status === 'provisional').map((r) => r.n);
  const off = month.rounds.find((r) => r.type === 'off' && r.habit > 0);
  const notes = [];
  if (!v.matchOn) notes.push('No round of ' + fmtMonth(month.ym, 'name') + ' is scored yet: scoring starts with round 1 of the match.');
  // rounds of this month before the match began print their results in grey: say on the caption that they do not count
  const start = ctx.state.meta.matchStart;
  if (v.matchOn && isYmd(start) && month.rounds.some((r) => r.status === 'prematch')) notes.push('Rounds before ' + fmtDate(start, 'short') + ' are set back: an exhibition, not counted.');
  if (pencil.length) notes.push((pencil.length === 1 ? 'Round ' + pencil[0] + ' is' : 'Rounds ' + pencil.join(', ') + ' are') + ' in pencil until the bank makes ' + (pencil.length === 1 ? 'it' : 'them') + ' final.');
  const note = html`${notes.join(' ')}${off ? html` Shaded rounds are days off, where Habit plays <span data-fig>${fmt(off.habit)}</span>.` : ''}`;
  return crosstable(month, {
    today: ctx.today,
    glyphOf: (day) => worstGlyph(ctx.d.annotations(day)),
    scale: true,
    note,
    cover: !!ctx.state.settings.cover,
  });
}

/* ------------------------------------------------------- E. the position */

function positionBlock(ctx) {
  const a = ctx.d.assessment;
  const factors = [a.material, a.time, a.structure, a.initiative];
  return html`
    <div class="sec-head"><h2 class="lab" id="b-pos"><b>The position</b><i class="sep"></i>assessment</h2></div>
    <div class="verdict">${evalGlyph(a.symbol)}<p>${figText(a.sentence)}</p></div>
    <dl class="factors">
      ${factors.map((f) => html`<div class="factor" data-key="${f.key}">
        <span class="factor-sym">${evalGlyph(f.symbol, { decorative: true })}${f.timeTrouble ? html`<span class="spot">${timeTroubleGlyph({ decorative: true })}</span>` : ''}</span>
        <dt class="factor-title lab"><b>${f.title}</b> <i>${String(f.label).toLowerCase()}${f.timeTrouble ? ' · time trouble' : ''}</i></dt>
        <dd>${figText(f.sentence)}</dd>
      </div>`)}
    </dl>`;
}

/* ------------------------------------------------------ F. coach's notes */

function dataAttrs(data) {
  const out = {};
  for (const key in data || {}) out['data-' + key.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())] = data[key];
  return attrs(out);
}

function noteAction(cta) {
  if (!cta || !cta.label) return '';
  if (cta.href) return html`<a class="note-action btn-link" href="${cta.href}">${cta.label}</a>`;
  if (cta.action) return html`<button class="note-action btn-link" type="button" data-action="${cta.action}"${dataAttrs(cta.data)}>${cta.label}</button>`;
  return '';
}

function notesBlock(ctx) {
  const notes = ctx.d.notes.filter((n) => n && n.text);
  const sweep = ctx.d.edge.sweep;
  const rows = notes.map((n, i) => html`<li class="note" data-key="${n.key}">
    <b class="note-n">${i + 1}</b><span class="note-text">${figText(n.text, true)}</span>${noteAction(n.cta)}
  </li>`);
  if (sweep && !notes.some((n) => String(n.key).startsWith('sweep'))) {
    rows.push(html`<li class="note" data-key="sweep-open">
      <b class="note-n">${rows.length + 1}</b>
      <span class="note-text">The week of ${fmtDate(sweep.weekOf, 'short')} kept <i data-fig>${fmt(sweep.amount, { decimals: 0 })}</i> against habit. It has not been moved to the ${sweep.target === 'card' ? 'card' : 'reserve'} yet.</span>
      <button class="note-action btn-link" type="button" data-action="app.sheet" data-sheet="sweep">Move it</button>
    </li>`);
  }
  return html`
    <div class="sec-head"><h2 class="lab" id="b-notes"><b>Coach’s notes</b></h2><span class="lab">${fmtDate(ctx.today, 'short')}</span></div>
    ${rows.length ? html`<ol class="notes">${rows}</ol>` : html`<p class="cap board-quiet">No notes for ${fmtDate(ctx.today, 'dowshort')}: nothing on the board asks for attention.</p>`}`;
}

function principlesBlock(ctx) {
  const list = (ctx.state.settings.principles || []).filter((p) => typeof p === 'string' && p.trim());
  return html`
    <div class="sec-head"><h2 class="lab" id="b-princ"><b>Opening principles</b></h2><span class="lab">Your own rules</span></div>
    ${list.length
      ? html`<ol class="principles">${list.map((p, i) => html`<li data-key="${'p' + i}"><b>${i + 1}</b><span>${p}</span></li>`)}</ol>`
      : html`<p class="cap board-quiet">0 principles are written down. They are your own rules, kept in <a href="#/settings">Settings</a>.</p>`}`;
}

/* ------------------------------------------------------------ G. figures */

function worthData(ctx, v) {
  const closes = ctx.d.recent(WORTH_DAYS).filter((c) => !v.firstDay || c.day >= v.firstDay);
  const data = {
    days: closes.map((c) => ({ day: c.day, smooth: c.smooth, bank: c.bank, partial: c.partial })),
    events: closes.filter((c) => c.reval !== 0).map((c) => ({ day: c.day, label: 'revalued' })),
  };
  // the hero shows cents it has reached (floored), so the figure's last point is cut the same way
  if (v.estimated) data.live = Math.floor(v.pos.live);
  // the end label is an estimate exactly when the hero is one; otherwise it is printed roman
  if (v.estimated || v.bankEst) data.est = true;
  return { data, from: closes.length ? closes[0].day : ctx.today, count: closes.length };
}

/** The rounds since the match began (the last 92 when it is older), with their running total. */
function edgeData(ctx) {
  const start = ctx.state.meta.matchStart;
  if (!isYmd(start)) return { data: { rounds: [], moved: 0 }, from: null, windowed: false };
  const windowed = diffDays(start, ctx.today) >= EDGE_ROUNDS_SHOWN;
  const from = windowed ? addDays(ctx.today, -(EDGE_ROUNDS_SHOWN - 1)) : start;
  const counts = (r) => r.status === 'final' || r.status === 'provisional';
  const rounds = [];
  for (let day = from; day <= ctx.today; day = addDays(day, 1)) rounds.push(ctx.d.round(day));
  let run = windowed ? ctx.d.edge.kept - rounds.filter(counts).reduce((n, r) => n + r.kept, 0) : 0;
  const slim = rounds.map((r) => {
    if (counts(r)) run += r.kept;
    return { day: r.day, n: r.n, kept: r.kept, cum: r.status === 'live' ? run + r.kept : run, result: r.result, status: r.status };
  });
  return { data: { rounds: slim, moved: ctx.d.edge.moved }, from, windowed };
}

function figuresBlock(ctx, v) {
  const worth = worthData(ctx, v);
  const edge = edgeData(ctx);
  const e = ctx.d.edge;
  const begins = v.firstDay && v.historyDays < ctx.d.matchFromDay ? addDays(v.firstDay, ctx.d.matchFromDay - 1) : null;
  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-figs"><b>The record</b><i class="sep"></i>${fmtDate(worth.from, 'short')} – ${fmtDate(ctx.today, 'short')}</h2>
      <span class="lab">Figs. 1–2</span>
    </div>
    <div class="board-figs">
      <figure class="board-fig">
        <nw-chart data-island kind="worth" data="${JSON.stringify(worth.data)}"></nw-chart>
        <figcaption class="cap"><span class="lab"><b>Fig. 1</b></span>
          ${v.pos.smoothing
            ? html`Net worth, the last ${plural(worth.count, 'day', 'days')}. Ink: with pay earned and bills used. Dotted: at the bank. The tail in pencil is not final.`
            : html`Net worth at the bank, the last ${plural(worth.count, 'day', 'days')}${worth.count < WORTH_DAYS ? html`: the record begins ${fmtDate(worth.from, 'short')}` : ''}. The tail in pencil is not final.`}
        </figcaption>
      </figure>
      <figure class="${cx('board-fig', !edge.from && 'is-empty')}">
        <nw-chart data-island kind="edge" data="${JSON.stringify(edge.data)}"></nw-chart>
        <figcaption class="cap"><span class="lab"><b>Fig. 2</b></span>
          ${edge.from
            ? html`Kept versus habit ${edge.windowed ? html`over the last ${EDGE_ROUNDS_SHOWN} rounds; the match began ${fmtDate(ctx.state.meta.matchStart, 'medium')}` : html`since the match began, ${fmtDate(edge.from, 'short')}`}.
              Hatched: the edge, <span data-fig>${fmt(e.kept, { sign: 'always' })}</span>. Solid: the part already moved, <span data-fig>${fmt(e.moved)}</span>.`
            : html`Kept versus habit, round by round. It starts with round 1${begins ? html`, around ${fmtDate(begins, 'short')}` : html`, on day ${ctx.d.matchFromDay} on record`}.`}
        </figcaption>
      </figure>
    </div>`;
}

/* --------------------------------------------------------- H. card cycle */

/** Returns '' when there is no card account at all. */
function cardBlock(ctx, v) {
  const now = ctx.d.cardsNow;
  if (!now.cards.length) return '';
  const months = ctx.d.cardMonths(2);
  const m = months[months.length - 1];
  const name = fmtMonth(m.ym, 'name');
  const who = now.cards.length === 1 ? now.cards[0].label : plural(now.cards.length, 'card', 'cards');
  const head = html`<div class="sec-head">
    <h2 class="lab" id="b-card"><b>Card cycle</b><i class="sep"></i>${name}</h2>
    <span class="lab board-clip">${who}</span>
  </div>`;
  if (!(now.owed > 0) && !(m.charges > 0) && !(m.payments > 0)) {
    return html`${head}<p class="cap board-quiet">Nothing is owed on a card as of ${fmtDate(ctx.today, 'dowshort')}, and ${name} has no charge on one.</p>`;
  }
  const pace = m.pace == null ? null : Math.round(m.pace);
  // a card in credit owes nothing, so it has no pace to read: the credit is the bank's own figure
  const inCredit = m.credit > 0 && m.end === 0;
  const label = v.cover ? 'Payments against new charges' : 'Payments ' + fmt(m.payments) + ' against new charges ' + fmt(m.charges);
  return html`${head}
    <figure class="${cx('split', 'board-split', longPair(m.payments, m.charges, 3) && 'is-long')}">
      <figcaption class="split-labs">
        <span><span class="lab"><b>Payments</b></span>${money(m.payments)}</span>
        <span>${money(m.charges)}<span class="lab"><b>New charges</b></span></span>
      </figcaption>
      <nw-split data-island${attrs({ a: Math.max(0, m.payments), b: Math.max(0, m.charges), mark: 'centre', label })}></nw-split>
    </figure>
    <div class="grid-2 bt-hair mt-4 pt-2 board-pace">
      <div class="stack gap-1"><span class="lab"><i class="bank-mark"></i>Began ${name} at</span>${money(m.start, { size: 'm' })}</div>
      ${inCredit
        ? html`<div class="stack gap-1"><span class="lab"><i class="bank-mark"></i>In credit by</span>${money(m.credit, { size: 'm' })}</div>`
        : html`<div class="stack gap-1"><span class="lab">On pace to end</span>${pace == null
          ? html`<span class="fig fig-m">—</span>`
          : html`<span class="fig fig-m est"><span class="approx">≈</span>${pace === 0 ? 'level' : fmt(Math.abs(pace)) + (pace < 0 ? ' lower' : ' higher')}</span>`}</div>`}
    </div>
    ${inCredit ? html`<p class="cap board-line">Nothing is owed on a card, so ${name} has no pace to read.</p>` : ''}
    ${!inCredit && pace == null && m.ym === monthOf(ctx.today) && Number(ctx.today.slice(8, 10)) < PACE_FROM_DAY
      ? html`<p class="cap board-line">A pace is read from day ${PACE_FROM_DAY} of the month.</p>` : ''}
    ${!inCredit && pace != null && m.scheduled > 0
      ? html`<p class="cap board-line">The pace takes off ${inlineMoney(m.scheduled, { est: true })} of payments still scheduled in the Book this month.</p>` : ''}
    ${m.complete ? '' : html`<p class="cap board-line">The bank’s record starts inside ${name}: “began at” is the first balance on record.</p>`}`;
}

/* ------------------------------------------------------ I. income ladder */

function ladderBlock(ctx) {
  const l = ctx.d.ladder;
  const rungs = l.ladder.slice().sort((a, b) => b.target - a.target);
  // under 60 days of deposits a year's income is not a measure yet: no rung is called reached or next
  const thin = !!l.thin;
  const nextTarget = l.next && !thin ? l.next.target : null;
  const fraction = thin ? 0 : l.next ? l.next.fraction : rungs.length ? 1 : 0;
  const head = html`<div class="sec-head">
    <h2 class="lab" id="b-ladder"><b>Income ladder</b><i class="sep"></i>annual gross</h2>
    <a class="btn-link" href="#/analysis">Analysis</a>
  </div>`;
  if (!rungs.length) {
    return html`${head}<p class="cap board-quiet">0 norms are set. <span data-fig>${fmt(l.received)}</span> was received in the last ${plural(l.days, 'day', 'days')}.</p>`;
  }
  return html`${head}
    <ol class="ladder board-ladder">
      ${rungs.map((rung, i) => {
        const next = rung.target === nextTarget;
        const reached = rung.reached && !thin;
        const caption = next ? 'next norm · ' + fmtPct(rung.fraction, 1) + ' there'
          : reached ? 'reached'
            : i === 0 && isYmd(l.final.by) ? 'by ' + fmtMonth(monthOf(l.final.by)) : '';
        return html`<li class="${cx('rung', next && 'is-next', reached && 'is-done', !next && !reached && 'is-later')}" data-key="${'rung' + rung.target}">
          <span class="rung-title">${i < NORM_TITLES.length ? NORM_TITLES[i] : rungs.length - i}</span>
          <span class="fig">${fmt(rung.target, { decimals: 0 })}</span>
          <span class="cap">${caption}</span>
        </li>`;
      })}
      <li class="rung is-you" data-key="you">
        <span class="bar rung-bar" style="${'--p:' + (fraction * 100).toFixed(1) + '%'}" aria-hidden="true"><i></i></span>
        <span class="rung-title">You</span>
        ${thin ? html`<span class="fig est" data-cover-keep>—</span>` : money(l.grossApprox, { est: true, decimals: 0 })}
        <span class="cap">${thin ? 'a year’s figure is read from day 60' : l.next ? 'gross, about, a year' : 'every norm is reached'}</span>
        <span class="cap rung-note">${thin
          ? html`<span data-fig>${fmt(l.received)}</span> received in ${plural(l.days, 'day', 'days')} on record: too short a stretch to scale to a year.`
          : l.partial
            ? html`<span data-fig>${fmt(l.received)}</span> received in ${plural(l.days, 'day', 'days')} on record, scaled to a year: rough until more history is in.`
            : html`<span data-fig>${fmt(l.received)}</span> received in the last 12 months, grossed up for what is withheld.`} Kept apart from net worth.</span>
      </li>
    </ol>`;
}

/* ---------------------------------------------------------------- J. key */

function keyBlock() {
  const sign = (symbol, text) => html`<span>${evalGlyph(symbol, { decorative: true })}${text}</span>`;
  const mark = (glyph, text) => html`<span><b class="sym" aria-hidden="true">${glyph}</b>${text}</span>`;
  return html`<p class="key">
    <span class="lab">Key to symbols</span>
    ${sign('winning', 'winning')}${sign('clear_plus', 'clear advantage')}${sign('slight_plus', 'slight advantage')}${sign('equal', 'equal')}
    ${sign('slight_minus', 'slightly worse')}${sign('clear_minus', 'clearly worse')}${sign('losing', 'losing')}${sign('unclear', 'unclear')}
    <span>${timeTroubleGlyph({ decorative: true })}time trouble</span>
    <span class="board-key-box">${moveGlyph('□', { title: 'Only move' })}only move: rent, a loan payment</span>
    ${mark('!!', 'clean-sheet workday')}${mark('!', 'declined, moved, or played to plan')}${mark('!?', 'judged by its return')}
    ${mark('?!', 'unplanned 2nd stop')}${mark('?', 'unplanned 3rd stop')}${mark('??', 'avoidable penalty')}
  </p>`;
}

/* ----------------------------------------------------------------- render */

function wideBoard(ctx, v) {
  const last = v.matchOn ? lastBlock(ctx, v) : '';
  const card = cardBlock(ctx, v);
  return html`<div class="board">
    <h1 class="vh">The Board, ${fmtDate(ctx.today, 'long')}</h1>
    <div class="cols">
      <section class="col col-8 hero" aria-labelledby="b-nw">${heroMain(ctx, v)}${heroMore(ctx, v)}</section>
      <section class="col col-4 clock" aria-labelledby="b-clock">${clockMain(ctx, v)}<div class="clock-reserve">${reserveBlock(ctx)}</div></section>
    </div>
    <div class="cols">
      <div class="col col-5">
        <section class="band" aria-labelledby="b-today">${v.matchOn ? todayBlock(ctx, v) : prematchBlock(ctx, v)}</section>
        ${last ? html`<section class="band" aria-labelledby="b-last">${last}</section>` : ''}
      </div>
      <section class="col col-4" aria-labelledby="b-pos">${positionBlock(ctx)}</section>
      <div class="col col-3">
        <section class="band" aria-labelledby="b-notes">${notesBlock(ctx)}</section>
        <section class="band" aria-labelledby="b-princ">${principlesBlock(ctx)}</section>
      </div>
    </div>
    <div class="band">${crosstableBlock(ctx, v)}</div>
    <div class="cols">
      <section class="col col-8" aria-labelledby="b-figs">${figuresBlock(ctx, v)}</section>
      <div class="col col-4">
        ${card ? html`<section class="band" aria-labelledby="b-card">${card}</section>` : ''}
        <section class="band" aria-labelledby="b-ladder">${ladderBlock(ctx)}</section>
      </div>
    </div>
    <section class="band pb-0" aria-label="Key to symbols">${keyBlock()}</section>
  </div>`;
}

function narrowBoard(ctx, v) {
  const last = v.matchOn ? lastBlock(ctx, v) : '';
  const card = cardBlock(ctx, v);
  return html`<div class="board board-narrow">
    <h1 class="vh">The Board, ${fmtDate(ctx.today, 'long')}</h1>
    <section class="band hero board-top" aria-labelledby="b-nw">${heroMain(ctx, v)}</section>
    <section class="band clock board-top" aria-labelledby="b-clock">${clockMain(ctx, v)}</section>
    <section class="band" aria-labelledby="b-today">${v.matchOn ? todayBlock(ctx, v) : prematchBlock(ctx, v)}</section>
    ${last ? html`<section class="band" aria-labelledby="b-last">${last}</section>` : ''}
    <section class="band" aria-labelledby="b-material">
      <div class="sec-head"><h2 class="lab" id="b-material"><b>Net worth</b><i class="sep"></i>what it is made of</h2></div>
      ${heroMore(ctx, v)}
    </section>
    <section class="band clock" aria-labelledby="b-reserve">
      <div class="sec-head"><h2 class="lab" id="b-reserve"><b>Cash on hand</b><i class="sep"></i>the reserve</h2><span class="lab">Measured in time</span></div>
      <div class="board-reserve">${reserveBlock(ctx)}</div>
    </section>
    <section class="band" aria-labelledby="b-pos">${positionBlock(ctx)}</section>
    <section class="band" aria-labelledby="b-notes">${notesBlock(ctx)}</section>
    <section class="band" aria-labelledby="b-princ">${principlesBlock(ctx)}</section>
    <div class="band">${crosstableBlock(ctx, v)}</div>
    <section class="band" aria-labelledby="b-figs">${figuresBlock(ctx, v)}</section>
    ${card ? html`<section class="band" aria-labelledby="b-card">${card}</section>` : ''}
    <section class="band" aria-labelledby="b-ladder">${ladderBlock(ctx)}</section>
    <section class="band pb-0" aria-label="Key to symbols">${keyBlock()}</section>
  </div>`;
}

export function render(ctx) {
  const v = model(ctx);
  return ctx.wide ? wideBoard(ctx, v) : narrowBoard(ctx, v);
}

export const actions = {
  /** The hero is a button: one tap switches between the live figure and the bank's own. */
  'board.hero': () => {
    store.setUi({ heroMode: store.ui.heroMode === 'bank' ? 'live' : 'bank' });
  },
};
