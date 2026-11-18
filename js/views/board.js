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
 * The payments the owner sends themselves ("Payments to make", ctx.d.byHand) are a checklist of their own:
 * under the reserve in the clock's column on a wide screen, a band between cash on hand and today's
 * round on a phone. Nothing of it is drawn while the Book holds no such payment.
 *
 * render(ctx) is pure. The actions of this screen are `board.hero` and the checklist's own
 * (`board.pay-tick`, `board.pay-skip`, `board.pay-amount`, `board.pay-add`); everything else opens a
 * sheet or another screen through the app-level actions (app.sheet, app.move) or a plain link.
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { openSheet } from '../router.js';
import { context, toast } from '../runtime.js';
import { fmt, fmtPct, ratio, toneBand } from '../model/money.js';
import { addDays, diffDays, fmtDate, fmtMonth, fmtTime, gameDay, isYmd, monthOf, nowMs, ymd } from '../model/dates.js';
import { firstTransactionDay } from '../model/cards.js';
import { nextOccurrence, runsByHand } from '../model/book.js';
import { emptiedStreams } from '../model/ledger.js';
import { editByHand, skipRow, tickByHand } from '../model/byhand.js';
import { refresh } from '../model/detect.js';
import { answerItems, answerPayer, cashAccountOf, incomeQuestions, isIdleCash } from '../model/income.js';
import { evalGlyph, timeTroubleGlyph, moveGlyph, resultMark } from '../ui/glyphs.js';
import { bankWhere, beforeCountWords, confirmWords, isCountedCash, itemWords, listedPayers, othersWords, payerWords } from './income-words.js';
import { paydayMark, paydayWords } from './clock-words.js';
import { evalName, glyphName, lowerFirst, phrase, say } from '../model/words.js';
import { moveQueue } from '../model/flows.js';
import { sayHtml } from '../ui/say.js';
import { money, inlineMoney, keptLine, statusLine, roundTitle, colourOf, crosstable, movesList, notableMoves, worstGlyph, spentUnposted, recentList, toneStyle, flowLookups, payFlowClass, unbankedWords, rungNumber } from './parts.js';

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
 * or '' when there is none. A stream that holds no deposit while its payer's are on record is not one
 * (ledger emptiedStreams: it gives no pay).
 */
function payOnArrival(ctx) {
  const streams = Array.isArray(ctx.state.streams) ? ctx.state.streams : [];
  const emptied = emptiedStreams(ctx.state);
  const held = streams.find((s) => s && s.active !== false && s.accrue === false && Array.isArray(s.locks) && s.locks.includes('accrue') && !emptied.has(s.id));
  return held ? held.name || 'regular pay' : '';
}

/**
 * Everything the sections share, read once.
 * `estimated` is true when the live figure is not simply the bank's (pay or bills accrue, or a move is tapped in).
 */
function model(ctx) {
  const pos = ctx.d.position;
  const estimated = pos.smoothing || pos.provisional > 0 || pos.provisionalIn > 0;
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
    manualCount: ctx.state.accounts.filter((account) => !account.hidden && account.source === 'manual' && !isIdleCash(ctx.state, account)).length,
    // the figure at the bank still holds the owner's own estimates (equipment, a loan worked down)
    bankEst: ctx.state.accounts.some((account) => ownEstimate(ctx, account)),
    lapsed: (Array.isArray(pos.lapsedPay) ? pos.lapsedPay : []).filter((item) => item && typeof item === 'object'),
    streams: Array.isArray(ctx.state.streams) ? ctx.state.streams : [],
    payOnArrival: payOnArrival(ctx),
    pay: payModel(ctx),
  };
}

/**
 * The checklist of payments the owner sends (derive: byHand), or null when the Book holds none that runs:
 * then nothing of it is drawn anywhere on the Board.
 */
function payModel(ctx) {
  const bh = ctx.d.byHand;
  if (!bh || !Array.isArray(bh.rows)) return null;
  const entries = (Array.isArray(ctx.state.recurring) ? ctx.state.recurring : []).filter((rec) => rec && runsByHand(rec));
  if (!entries.length) return null;
  const cents = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  return { ym: bh.ym, rows: bh.rows, paid: bh.paid || 0, count: bh.count || 0, unpaid: cents(bh.unpaid), transit: cents(bh.transit), entries };
}

/* ------------------------------------------------------------ A. net worth */

function heroMain(ctx, v) {
  const { pos, estimated, showLive } = v;
  // the figure at the bank holds Cash in hand when it is shown, and says so (the caption lists it apart, as the clock does)
  const bankName = handAccount(ctx) ? 'At the bank and in hand' : 'At the bank';
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
    label: showLive ? 'Net worth, live estimate:' : 'Net worth ' + bankName.toLowerCase() + (v.bankEst ? ', with your own estimates:' : ':'),
  })}></nw-ticker>`;
  const shown = showLive ? pos.live : pos.bank;
  const size = '--hero-ems:' + ems.toFixed(2) + ';' + toneStyle(shown);
  const tone = toneBand(shown);

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-nw"><b>Net worth</b><i class="sep"></i>${showLive ? html`<span class="spot">Live</span>` : bankName}</h2>
      ${estimated ? html`<button class="btn-link" type="button" data-action="board.hero">${showLive ? bankName : 'Live'}</button>` : ''}
    </div>
    ${estimated
      ? html`<button class="hero-fig" type="button" data-action="board.hero" data-tone="${tone}" style="${size}">${ticker}<span class="vh">${showLive ? 'Show the figure ' + bankName.toLowerCase() : 'Show the live figure'}</span></button>`
      : html`<p class="hero-fig" data-tone="${tone}" style="${size}">${ticker}</p>`}
    ${heroCaption(ctx, v)}
    ${heroMeta(ctx, v)}`;
}

/** One line under the figure: what the live figure is made of, or when the bank reported its own. */
function heroCaption(ctx, v) {
  const { pos, estimated, showLive } = v;
  const reported = whenText(ctx, pos.dataAt ?? pos.syncedAt, true);
  if (!showLive) {
    const byHand = v.manualCount ? sayHtml('board.byHand', ctx.words, { accounts: plural(v.manualCount, 'account', 'accounts') }) : '';
    const on = v.historyDays > 0 ? 'in the ' + plural(v.historyDays, 'day', 'days') + ' on record' : 'yet';
    // "not found" is only for a record with no regular pay at all; pay the owner counts on arrival is said as that
    const plain = estimated ? '' : !ctx.state.settings.smoothing
      ? sayHtml('board.plain.off', ctx.words)
      : v.payOnArrival
        ? sayHtml('board.plain.arrives', ctx.words, { name: v.payOnArrival })
        : v.lapsed.length
          ? html` Pay and bills count on the day they post.`
          : html` No regular pay is detected ${on}, so pay and bills count on the day they post.`;
    return html`<p class="cap board-compo">As the bank reported it ${reported}${byHand}.${plain}</p>${lapsedLines(v, ctx.words)}`;
  }
  const main = pos.receivables.slice().sort((a, b) => b.daily - a.daily)[0];
  const held = pos.smoothing && pos.rate === 0 && pos.freshness !== 'fresh';
  // Cash in hand is part of the sum but not at the bank: listed apart whenever it is shown, as the clock says (3.7)
  const hand = inHand(ctx);
  const bits = [html`<span class="nowrap">At the bank ${money(pos.bank - hand)}</span>`];
  if (handAccount(ctx)) bits.push(html`<span class="nowrap">in hand ${money(hand, { est: !isCountedCash(ctx.state, hand) })}</span>`);
  // one live figure: the parts add up to the floored hero, so bills used takes the remainder (as Material)
  const bankC = Math.round(pos.bank);
  const recvC = Math.round(pos.receivable);
  const provC = Math.round(pos.provisional || 0);
  const provInC = Math.round(pos.provisionalIn || 0);
  const liveC = Number.isFinite(pos.live) ? Math.floor(pos.live) : null;
  const payC = liveC != null ? bankC + recvC - provC + provInC - liveC : Math.round(pos.payable);
  if (pos.smoothing) {
    bits.push(html`<span class="nowrap">${sayHtml('board.payEarned', ctx.words, { since: main ? ' since ' + fmtDate(main.since, 'short') : '', amount: money(recvC, { est: true, signed: true }) })}</span>`);
    bits.push(html`<span class="nowrap">${sayHtml('board.billsUsed', ctx.words, { amount: money(-payC, { est: true, signed: true }) })}</span>`);
  }
  if (provC > 0) {
    bits.push(html`<span class="nowrap">${unbankedWords(ctx.state)}, not yet at the bank ${money(-provC, { est: true, signed: true })}</span>`);
  }
  if (provInC > 0) {
    bits.push(html`<span class="nowrap">payments marked, not yet at the bank ${money(provInC, { est: true, signed: true })}</span>`);
  }
  return html`<p class="cap board-compo">${bits.map((bit, i) => html`${i ? DOT : ''}${bit}`)}${held
    ? html`<span class="board-held">The figure holds still: the bank last reported ${reported}.</span>` : ''}</p>${lapsedLines(v, ctx.words)}`;
}

/** The Cash in hand account when it is part of the figures: not left out, and not idle. */
function handAccount(ctx) {
  const account = cashAccountOf(ctx.state);
  return account && !account.hidden && !isIdleCash(ctx.state, account) ? account : null;
}

/** Cash in hand is part of the figures and is not exactly the owner's latest count: the sums holding it are estimates. */
function handEst(ctx) {
  return !!handAccount(ctx) && !isCountedCash(ctx.state, inHand(ctx));
}

/** What Cash in hand holds now when it is part of the figures (0 when there is none or it is left out). */
function inHand(ctx) {
  const account = handAccount(ctx);
  if (!account) return 0;
  return Math.round(ctx.d.valueOf(account) || 0);
}

/** A pay stream whose deposits stopped (ledger: lapsedPay): one line each, under the composition. */
/** Whether a stream is counted day by day (accrue): only then does a stop end "pay counted as earned". */
function countedDayByDay(v, id) {
  const stream = (v.streams || []).find((s) => s && s.id === id);
  return !stream || stream.accrue !== false;
}

function lapsedLines(v, words) {
  return v.lapsed.map((item) => html`<p class="cap board-lapsed" data-key="${'lapsed-' + item.id}">No deposit from ${item.name || 'a regular payer'} since ${isYmd(item.since) ? fmtDate(item.since, 'short') : 'a day not on record'}; ${countedDayByDay(v, item.id) ? say('board.lapsed.earned', words) : 'its payday is no longer expected'}.</p>`);
}

/** What yesterday's change was made of: earned · bills · spent. */
function yesterdayParts(y, smoothing, words) {
  // earned and bills are accruals while pay and bills are counted day by day; a day in pencil is not final at all
  const accrued = !!smoothing || !!y.partial;
  return sayHtml('board.yesterday.parts', words, { earned: inlineMoney(y.earned, { est: accrued }), dot: DOT, bills: inlineMoney(y.bills, { est: accrued }), spent: inlineMoney(y.spent, { est: !!y.partial }) });
}

/** Yesterday · this month · since last look. */
function heroMeta(ctx, v) {
  const { pos } = v;
  const y = ctx.d.yesterday;
  const ret = ctx.d.retention();
  const items = [];
  items.push(html`<div class="tally-item">
    <span class="lab">Yesterday</span>
    ${y ? money(y.result, { est: y.partial || pos.smoothing, signed: true, tint: true, rim: true }) : html`<span class="fig">—</span>`}
    <span class="cap">${y
      ? (ctx.wide ? yesterdayParts(y, pos.smoothing, ctx.words) : html`${fmtDate(y.day, 'dowshort')}${y.partial ? say('board.inPencil', ctx.words) : ''}`)
      : html`no record of ${fmtDate(addDays(ctx.today, -1), 'short')}`}</span>
  </div>`);
  items.push(html`<div class="tally-item">
    <span class="lab">This month</span>
    ${money(ret.kept, { est: !!pos.smoothing || pos.provisional > 0 || pos.provisionalIn > 0, signed: true, tint: true, rim: true })}
    <span class="cap">${ret.rate == null
      ? say('board.month.none', ctx.words)
      : ret.kept >= 0
        ? sayHtml('board.month.kept', ctx.words, { earned: inlineMoney(ret.earned, { est: pos.smoothing || pos.provisionalIn > 0 }) })
        : sayHtml('board.month.over', ctx.words, { earned: inlineMoney(ret.earned, { est: pos.smoothing || pos.provisionalIn > 0 }) })}</span>
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
    note = sayHtml('board.slow', ctx.words, { pct: fmtPct(slow, 0) });
  } else if (v.manualCount) {
    note = sayHtml('board.slow.none', ctx.words);
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
    ${liquidAfter(v)}
    ${y ? html`<p class="cap board-yesterday">Yesterday, ${fmtDate(y.day, 'short')}: ${yesterdayParts(y, pos.smoothing)}.</p>` : ''}`;
}

/**
 * Under the liquid figure: what is left of it once the payments still to send have gone, and those ticked
 * in the last days that the bank's balance still holds. An estimate, and printed only while there is one.
 */
function liquidAfter(v) {
  const pay = v.pay;
  if (!pay || !(pay.unpaid + pay.transit > 0)) return '';
  const left = v.pos.liquid - pay.unpaid - pay.transit;
  const sent = pay.transit > 0 ? html`${pay.unpaid > 0 ? ' and ' : ''}${inlineMoney(pay.transit, { est: true })} sent, not yet at the bank` : '';
  return html`<p class="cap board-liquid-after">After ${pay.unpaid > 0 ? html`${inlineMoney(pay.unpaid, { est: true })} still to send` : ''}${sent}: <span class="nowrap">${inlineMoney(left, { est: true })}</span></p>`;
}

/* ----------------------------------------------------- B. cash on hand */

function clockMain(ctx, v) {
  const c = ctx.d.clock;
  const days = c.runwayDays;
  const on = days == null ? 0 : Math.min(RUNWAY_SEGMENTS, Math.max(0, Math.floor(days)));
  const runwayLabel = days == null ? 'Runway: not yet known' : days >= RUNWAY_SEGMENTS ? 'Runway: 7 days or more' : 'Runway: ' + plural(on, 'day', 'days') + ' of 7';
  const segments = [];
  for (let i = 0; i < RUNWAY_SEGMENTS; i++) segments.push(html`<i${attrs({ class: i < on ? 'is-on' : null })}></i>`);
  // the next payday: a countdown beside the days on the clock, and a mark on the runway when it falls within it
  const payday = paydayWords(ctx.today, c);
  const mark = paydayMark(ctx.today, c, RUNWAY_SEGMENTS);
  // The engine averages outflows over 60 days whatever the record holds; say so while the record is shorter.
  const short = v.firstDay && v.historyDays < BURN_DAYS;

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-clock"><b>Cash on hand</b><i class="sep"></i>${sayHtml('board.clock', ctx.words)}</h2>
      ${c.trouble ? html`<span class="tt lab">${timeTroubleGlyph({ decorative: true, words: ctx.words })}${sayHtml('glyph.timeTrouble', ctx.words)}</span>` : ''}
    </div>
    <div class="clock-body">
      <div>
        <p class="${cx('clock-cash', Math.abs(c.cash) >= LONG_CASH && 'is-long', Math.abs(c.cash) >= HUGE_CASH && 'is-huge', handEst(ctx) && 'est')}">${handEst(ctx) ? html`<span class="approx">≈</span>` : ''}${fmt(c.cash)}</p>
        <p class="cap"><i class="bank-mark"></i>${handAccount(ctx) ? 'at the bank and in hand' : 'at the bank'} · from ${whenText(ctx, c.asOf)}</p>
      </div>
      <div class="clock-run">
        ${days == null
          ? html`<span class="fig est">— <small>${sayHtml('board.onClock', ctx.words)}</small></span>
            <p class="cap">${sayHtml('board.runway.later', ctx.words)}</p>`
          : html`<span class="fig est" data-cover-keep><span class="approx">≈</span>${days < 1 ? 'under 1 day' : plural(days, 'day', 'days')} <small>${sayHtml('board.onClock', ctx.words)}</small></span>
            <p class="cap">at about <span data-fig>${fmt(c.burn)}</span> a day${short
              ? (ctx.wide ? html`, a ${BURN_DAYS}-day average with ${plural(v.historyDays, 'day', 'days')} on record` : html` <span class="board-runnote">${v.historyDays} of ${BURN_DAYS} days on record</span>`)
              : ''}</p>`}
        ${payday ? html`<p class="cap clock-payday">${payday}</p>` : ''}
      </div>
    </div>
    <div class="runway" role="img" aria-label="${runwayLabel + (mark !== null ? '. ' + payday.replace(' · ', ', ') + '.' : '')}">${segments}${mark !== null
      ? html`<b class="runway-payday" style="${'--at:' + mark.toFixed(4)}"></b>` : ''}</div>
    <div class="runway-labs"><span class="lab">${sayHtml('board.flag', ctx.words)}</span><span class="lab">${sayHtml('board.runway.end', ctx.words)}</span></div>
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
            <span class="lab"><span class="spot">${timeTroubleGlyph({ decorative: true, words: ctx.words })}</span> ${phrase('board.short', ctx.words)}</span>
            ${money(c.shortfall, { est: true })}
            <span class="cap">cash does not cover it</span>
          </div>`
        : html`<div class="tally-item">
            <span class="lab">${phrase('board.spare', ctx.words)}</span>
            ${money(spare, { est: c.dueTotal > 0 })}
            <span class="cap">covered</span>
          </div>`}
    </div>
    ${shown.length ? html`<ul class="board-due" aria-label="What is due">
      ${shown.map((item) => html`<li data-key="${item.id + item.day}">
        <span class="board-due-name">${item.name}${item.byHand ? html` <span class="board-tag">You send it</span>` : ''}</span>
        <span class="${cx('lab', 'lab-s', item.overdue && 'board-overdue')}">${item.overdue ? 'overdue since ' + fmtDate(item.day, 'short') : fmtDate(item.day, 'dowshort')}</span>
        ${money(item.amount, { est: true })}
      </li>`)}
      ${more > 0 ? html`<li class="board-due-more" data-key="more"><a class="cap" href="#/book">${sayHtml('board.due.more', ctx.words, { more, until })}</a></li>` : ''}
    </ul>` : ''}`;
}

/** The reserve against its target, and its milestones measured in time. */
function reserveBlock(ctx) {
  const c = ctx.d.clock;
  const next = c.milestones.findIndex((m) => !m.reached);
  return html`
    <p class="clock-reserve-row">
      <span class="lab">${sayHtml('board.reserve', ctx.words)}</span>${money(c.reserve)}
      <span class="cap">${c.reserveTarget > 0 ? html`${fmtPct(ratio(c.reserve, c.reserveTarget), 1)} of <span data-fig>${fmt(c.reserveTarget, { decimals: 0 })}</span>` : 'no goal is set'}</span>
    </p>
    <ol class="ticks" aria-label="${say('board.reserve.aria', ctx.words)}">
      ${c.milestones.map((m, i) => html`<li${attrs({ class: m.reached ? 'is-done' : i === next ? 'is-next' : null })}>${m.label}${m.reached ? html`<span class="vh">, reached</span>` : i === next ? html`<span class="vh">, next</span>` : ''}</li>`)}
    </ol>`;
}

/* ------------------------------------------------- payments to make */

const PAID = { bank: true, pending: true, hand: true };

function dueWords(n) {
  return n <= 0 ? 'due today' : n === 1 ? 'due tomorrow' : 'due in ' + n + ' days';
}

/** The line under a payment's name: where it stands, in words with a date. */
function payNote(row, earlier) {
  const short = (day) => (isYmd(day) ? fmtDate(day, 'short') : 'a day not on record');
  const lead = earlier ? fmtMonth(monthOf(row.day), 'name') + '’s payment' + DOT : '';
  if (row.status === 'bank') return html`<i class="bank-mark"></i>At the bank ${short(row.paidDay)}${row.merchant ? html`${DOT}${row.merchant}` : ''}`;
  if (row.status === 'pending') return html`Pending at the bank since ${short(row.paidDay)}${row.merchant ? html`${DOT}${row.merchant}` : ''}`;
  if (row.status === 'hand') {
    return row.pendingDay
      ? html`Ticked ${short(row.paidDay)}; pending at the bank since ${short(row.pendingDay)}.`
      : html`Ticked ${short(row.paidDay)}; the bank has not shown it.`;
  }
  if (row.pendingDay) return html`${lead}pending at the bank since ${short(row.pendingDay)}`;
  if (row.status === 'overdue') return html`${lead}<span class="board-overdue">overdue since ${short(row.day)}</span>`;
  return html`${lead}${dueWords(Number.isFinite(row.daysTo) ? row.daysTo : 0)}`;
}

/** What movesList needs to colour a move's amount by its cash flow: the accounts, and a pair's other leg. */
function flowOpts(ctx) {
  const { accountOf, pairOf } = flowLookups(ctx);
  return { accounts: accountOf, pairs: pairOf, words: ctx.words };
}

/** One payment of the checklist: the box, the name with its day and standing, the amount, and what may be said about it. */
function payRow(ctx, v, row) {
  const rec = row.entry || {};
  const name = rec.name || 'Unnamed payment';
  const when = fmtDate(row.day, 'dowshort');
  const atBank = row.status === 'bank' || row.status === 'pending';
  const ticked = !!PAID[row.status];
  const earlier = monthOf(row.day) < v.pay.ym;
  const say = name + ', ' + when;
  const box = atBank
    ? html`<span class="pay-box" role="img" aria-label="${say + (row.status === 'bank' ? ': paid at the bank' : ': pending at the bank')}"><span class="check-box is-on is-bank" aria-hidden="true"></span></span>`
    : html`<button class="pay-box" type="button" data-action="board.pay-tick" data-id="${rec.id}" data-day="${row.day}" aria-pressed="${ticked ? 'true' : 'false'}" aria-label="${say + (ticked ? ': ticked as paid' : ': not paid yet')}"><span class="${cx('check-box', ticked && 'is-on')}" aria-hidden="true"></span></button>`;
  const text = html`<span class="pay-name">${name}</span> <span class="lab lab-s pay-when">${when}</span>
      <em class="pay-note">${payNote(row, earlier)}</em>`;
  const main = atBank && row.txId
    ? html`<button class="pay-main" type="button" data-action="app.sheet" data-sheet="tx" data-id="${row.txId}">${text}</button>`
    : html`<button class="pay-main" type="button" data-action="app.sheet" data-sheet="recurring" data-id="${rec.id}">${text}</button>`;
  const other = !ticked && Number.isFinite(row.otherAmount) && row.otherAmount > 0;
  return html`<li class="${cx('pay-row', ticked && 'is-paid')}" data-key="${rec.id + ':' + row.day}">
    ${box}
    ${main}
    ${money(row.amount, { est: row.status !== 'bank', cls: payFlowClass(row.status) })}
    ${atBank && row.txId ? html`<p class="cap pay-more"><button class="btn-link" type="button" data-action="board.pay-skip" data-id="${rec.id}" data-tx="${row.txId}">Not this payment</button></p>` : ''}
    ${other ? html`<p class="cap pay-more"><span>${v.cover
        ? html`The bank shows another amount to this payee on ${fmtDate(row.otherDay, 'short')}.`
        : html`The bank shows ${inlineMoney(row.otherAmount)} to this payee on ${fmtDate(row.otherDay, 'short')}.`}</span>
      <button class="btn-link" type="button" data-action="board.pay-amount" data-id="${rec.id}" data-day="${row.day}">${v.cover ? 'Change the amount' : 'Change the amount to ' + fmt(row.otherAmount)}</button></p>` : ''}
  </li>`;
}

/** "Payments to make": the month's checklist of what the owner sends. Returns '' when there is none to make. */
function payBlock(ctx, v) {
  const pay = v.pay;
  if (!pay) return '';
  const month = fmtMonth(pay.ym, 'name');
  let none = '';
  if (!pay.rows.length) {
    // every payment's schedule starts in a later month: say which comes first, and when
    const next = pay.entries.map((rec) => ({ rec, day: nextOccurrence(rec, addDays(ctx.today, -1)) })).filter((x) => isYmd(x.day)).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))[0];
    none = html`<p class="cap board-quiet">0 payments are left to make in ${month}.${next ? html` The next is ${next.rec.name || 'an unnamed payment'}, ${inlineMoney(next.rec.amount, { est: true })} on ${fmtDate(next.day, 'dowshort')}.` : ''}</p>`;
  }
  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-pay"><b>Payments to make</b><i class="sep"></i>${month}</h2>
      <span class="lab">${pay.paid} of ${pay.count} paid</span>
    </div>
    ${none}
    ${pay.rows.length ? html`<ul class="board-pay" aria-label="${'Payments to make, ' + month}">${pay.rows.map((row) => payRow(ctx, v, row))}</ul>` : ''}
    <p class="cap board-line pay-foot">${pay.unpaid > 0 ? html`<span>${inlineMoney(pay.unpaid, { est: true })} still to send.</span> ` : ''}<button class="btn-link" type="button" data-action="board.pay-add">Add a payment</button></p>`;
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
  if (plan.container != null) bits.push(plan.container ? 'container filled' : 'no container');
  if (plan.breakfast != null) bits.push(plan.breakfast ? 'breakfast sorted' : 'breakfast not sorted');
  if (plan.stops != null) bits.push(plan.stops === 0 ? '0 planned stops' : plural(plan.stops, 'planned stop', 'planned stops'));
  const record = ctx.state.days[ctx.today];
  const at = record && record.plan && Number.isFinite(record.plan.at) ? record.plan.at : null;
  return phrase('board.plan', ctx.words) + (at ? ', ' + fmtTime(at) : '') + ': ' + (bits.length ? bits.join(', ') : 'recorded for ' + fmtDate(ctx.today, 'short')) + '.';
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
  const label = v.cover ? say('board.split.cover', ctx.words) : say('board.split', ctx.words, { kept: fmt(Math.max(0, r.kept)), spent: fmt(r.conv) });
  // The premise of the round. Under the title on wide screens; under the bar on phones, where the
  // standing itself has to reach the first screenful.
  const premise = html`${sayHtml('board.premise.habit', ctx.words, { habit: html`<span data-fig>${fmt(r.habit)}</span>`, kind: workday ? 'workday' : 'day off' })}
    ${sayHtml('board.premise.lines', ctx.words, { win: html`<span data-fig>${fmt(r.winLine)}</span>`, dot: DOT, loss: html`<span data-fig>${fmt(r.lossLine)}</span>` })}${
    r.bye ? say('board.premise.bye', ctx.words) : ''}`;

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-today"><b>Today</b><i class="sep"></i>${sayHtml('board.today.round', ctx.words, { n: r.n })}</h2>
      <span class="lab">${fmtDate(r.day, 'dowshort')}<i class="sep"></i>${colourOf(r, ctx.words)}</span>
    </div>
    <h3 class="title board-vs">${sayHtml('board.vs', ctx.words)}</h3>
    ${ctx.wide ? html`<p class="cap board-premise">${premise}</p>` : ''}
    <div class="tally board-standing">
      <div class="tally-item"><span class="lab">${sayHtml('board.habit', ctx.words)}</span>${money(r.habit)}</div>
      <div class="tally-item"><span class="lab">Spent</span>${money(r.conv, { est: spentUnposted(r) })}</div>
      <div class="tally-item"><span class="lab"><b>${sayHtml('board.standing', ctx.words)}</b></span><span class="fig est"><span class="approx">≈</span>${fmt(r.kept, { sign: 'always' })} <small>so far</small></span></div>
    </div>
    <figure class="split board-kept">
      <figcaption class="split-labs"><span class="lab"><b>${sayHtml('board.kept', ctx.words)}</b></span><span class="lab"><b>Spent</b></span></figcaption>
      <nw-split data-island slim${attrs({ a: Math.max(0, r.kept), b: Math.max(0, r.conv), label })}></nw-split>
      ${ctx.wide ? '' : html`<p class="cap split-note">${premise}</p>`}
    </figure>
    ${movesList(notable, reasons(ann.moves, v.cover), { ...flowOpts(ctx), blank: true, blankAt: notable.length + Math.max(0, others) + 1, label: say('board.today.moves', ctx.words) })}
    ${notable.length || others > 0
      ? (others > 0 ? html`<p class="cap board-more"><a href="${scoresheetDay(r.day)}">${notable.length
          ? say('board.more.others', ctx.words, { others: plural(others, phrase('board.more.other.one', ctx.words), phrase('board.more.other.many', ctx.words)) })
          : plural(others, phrase('board.more.move.one', ctx.words), phrase('board.more.move.many', ctx.words)) + ' so far today'}</a>${notable.length ? '' : say('board.more.outside', ctx.words)}</p>` : '')
      : html`<p class="cap board-quiet">${sayHtml('board.today.none', ctx.words, { day: fmtDate(r.day, 'dowshort') })}</p>`}
    <div class="btn-row board-actions">
      <button class="btn" type="button" data-action="app.move"><span class="plus">+</span> ${sayHtml('board.candidate', ctx.words)}</button>
      ${workday && !r.plan ? html`<button class="btn" type="button" data-action="app.sheet" data-sheet="plan">Plan the morning</button>` : ''}
    </div>
    ${r.plan ? html`<p class="cap board-line">${planSummary(ctx, r.plan)}
      <button class="btn-link" type="button" data-action="app.sheet" data-sheet="plan">Change</button></p>` : ''}
    ${!r.bye && !played && byesLeft > 0 ? html`<p class="cap board-line">${sayHtml('board.byes', ctx.words, { left: byesLeft, byes: plural(per, phrase('board.bye.one', ctx.words), phrase('board.bye.many', ctx.words)), month })}
      <button class="btn-link" type="button" data-action="app.sheet" data-sheet="day" data-day="${r.day}">${sayHtml('board.bye.take', ctx.words)}</button></p>` : ''}`;
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
        <p class="cap board-quiet">${sayHtml('board.last.began', ctx.words, { date: fmtDate(ctx.state.meta.matchStart, 'dowshort'), n: ctx.d.todayRound.n })}</p>`;
    }
    return html`
      <div class="sec-head"><h2 class="lab" id="b-last"><b>Last result</b><i class="sep"></i>${roundTitle(awaited, ctx.words)}</h2></div>
      <p class="cap board-quiet">The bank has not reported ${fmtDate(yesterday, 'dowshort')} yet. Its result is entered when it does.</p>`;
  }
  const ann = ctx.d.annotations(r.day);
  const notable = notableMoves(r, ann.moves);
  const others = r.moves.filter((tx) => !tx.matchId).length - notable.length;
  const provisional = r.status === 'provisional';
  const why = ann.round && ann.round.why ? String(ann.round.why) : '';

  return html`
    <div class="sec-head">
      <h2 class="lab" id="b-last"><b>Last result</b><i class="sep"></i>${roundTitle(r, ctx.words)}</h2>
      <span class="lab">${colourOf(r, ctx.words)}</span>
    </div>
    <p class="board-result">
      <span class="board-result-mark">${resultMark(r.result, r.status, { glyph: ann.round ? ann.round.glyph : null, words: ctx.words })}</span>
      <span class="${cx('fig', 'fig-l', provisional && 'est')}">${provisional ? html`<span class="approx">≈</span>` : ''}${keptLine(r, ctx.words)}</span>
      <span class="cap">${r.bye ? say('board.last.bye', ctx.words) : ''}${statusLine(r, ctx.words)}</span>
    </p>
    ${ann.round ? html`<p class="cap board-ann"><b class="sym">${ann.round.glyph}</b>${figText(why || say('board.last.annotated', ctx.words))}${!why || /[.?…]$/.test(why) ? '' : '.'}</p>` : ''}
    ${r.day !== yesterday ? html`<p class="cap board-ann">${sayHtml('board.last.late', ctx.words, { day: fmtDate(yesterday, 'dowshort'), n: r.n })}</p>` : ''}
    ${notable.length ? movesList(notable, reasons(ann.moves, v.cover), { ...flowOpts(ctx), label: say('board.last.moves', ctx.words, { n: r.n }) }) : ''}
    ${others > 0 || !notable.length ? html`<p class="cap board-more"><a href="${scoresheetDay(r.day)}">${
      notable.length ? 'and ' + plural(others, phrase('board.more.other.one', ctx.words), phrase('board.more.other.many', ctx.words))
        : others > 0 ? plural(others, phrase('board.more.move.one', ctx.words), phrase('board.more.move.many', ctx.words)) + ' on ' + fmtDate(r.day, 'short')
          : say('board.last.onSheet', ctx.words, { n: r.n })}</a>${
      notable.length ? '' : others > 0 ? say('board.more.outside', ctx.words) : sayHtml('board.last.none', ctx.words, { date: fmtDate(r.day, 'short') })}</p>` : ''}`;
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
      <h2 class="lab" id="b-today"><b>Today</b><i class="sep"></i>${sayHtml('board.prematch', ctx.words)}</h2>
      <span class="lab">${fmtDate(r.day, 'dowshort')}</span>
    </div>
    <h3 class="title board-vs">${sayHtml('board.vs', ctx.words)}</h3>
    <p class="board-lede">${have < from
      ? sayHtml('board.prematch.begins', ctx.words, { from, have, begins: begins ? sayHtml('board.prematch.first', ctx.words, { date: fmtDate(begins, 'dowshort') }) : '' })
      : sayHtml('board.prematch.next', ctx.words, { have, days: from - 1 })}</p>
    <p class="cap board-line">${sayHtml('board.prematch.habit', ctx.words, { days: ctx.d.matchFromDay - 1 })}</p>
    ${notable.length ? html`
      <div class="board-sofar">
        <p class="lab">${sayHtml('board.prematch.sofar', ctx.words)}<i class="sep"></i><span data-fig>${fmt(r.conv)}</span></p>
        ${movesList(notable, reasons(ann.moves, v.cover), { ...flowOpts(ctx), label: say('board.prematch.label', ctx.words), plain: true })}
      </div>` : html`<p class="cap board-quiet">${sayHtml('board.prematch.none', ctx.words, { day: fmtDate(r.day, 'dowshort') })}</p>`}
    <div class="btn-row board-actions">
      <button class="btn" type="button" data-action="app.move"><span class="plus">+</span> ${sayHtml('board.candidate', ctx.words)}</button>
    </div>`;
}

/* ------------------------------------------------------ D. the crosstable */

function crosstableBlock(ctx, v) {
  const month = ctx.d.thisMonth;
  const pencil = month.rounds.filter((r) => r.status === 'provisional').map((r) => r.n);
  const off = month.rounds.find((r) => r.type === 'off' && r.habit > 0);
  const notes = [];
  if (!v.matchOn) notes.push(say('board.xt.none', ctx.words, { month: fmtMonth(month.ym, 'name') }));
  // rounds of this month before the match began print their results in grey: say on the caption that they do not count
  const start = ctx.state.meta.matchStart;
  if (v.matchOn && isYmd(start) && month.rounds.some((r) => r.status === 'prematch')) notes.push(say('board.xt.prematch', ctx.words, { date: fmtDate(start, 'short') }));
  if (pencil.length) notes.push(say(pencil.length === 1 ? 'board.xt.pencil.one' : 'board.xt.pencil.many', ctx.words, { n: pencil.join(', ') }));
  const note = html`${notes.join(' ')}${off ? sayHtml('board.xt.off', ctx.words, { amount: html`<span data-fig>${fmt(off.habit)}</span>` }) : ''}`;
  return crosstable(month, {
    today: ctx.today,
    glyphOf: (day) => worstGlyph(ctx.d.annotations(day)),
    scale: true,
    note,
    cover: !!ctx.state.settings.cover,
    words: ctx.words,
  });
}

/* ------------------------------------------------------- E. the position */

function positionBlock(ctx) {
  const a = ctx.d.assessment;
  const factors = [a.material, a.time, a.structure, a.initiative];
  return html`
    <div class="sec-head"><h2 class="lab" id="b-pos"><b>${sayHtml('board.position', ctx.words)}</b><i class="sep"></i>assessment</h2></div>
    <div class="verdict">${evalGlyph(a.symbol, { words: ctx.words })}<p>${figText(a.sentence)}</p></div>
    <dl class="factors">
      ${factors.map((f) => html`<div class="factor" data-key="${f.key}">
        <span class="factor-sym">${evalGlyph(f.symbol, { decorative: true, words: ctx.words })}${f.timeTrouble ? html`<span class="spot">${timeTroubleGlyph({ decorative: true, words: ctx.words })}</span>` : ''}</span>
        <dt class="factor-title lab"><b>${f.title}</b> <i>${String(f.label).toLowerCase()}${f.timeTrouble ? say('board.factor.tt', ctx.words) : ''}</i></dt>
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

/**
 * What the income another app reported asks (ARCHITECTURE 3.7): how a payer pays, once per payer; and a
 * payment sent by transfer that has not reached the bank 4 days after it was marked. One line each, with
 * text buttons. None in the sample game.
 */
function incomeRows(ctx) {
  if (ctx.demo) return [];
  const q = incomeQuestions(ctx.state, ctx.now);
  const rows = [];
  // one format for every line: "{what} · {payer}, {amount}, marked {day}", then what is asked
  const head = (label, cents, marked) => html`${label}, ${inlineMoney(cents)}, marked ${fmtDate(marked, 'short')}`;
  for (const c of q.confirm) {
    const shows = html`the bank shows ${inlineMoney(c.bank.cents)} on ${fmtDate(c.bank.day, 'short')}`;
    // the payments asked about, then the row's other members (history ones, or ones already answered)
    const one = c.asked.n === 1;
    const asked = one ? head(c.label, c.asked.cents, c.marked) : html`${c.label}, ${c.asked.n} payments, ${inlineMoney(c.asked.cents)}`;
    const others = c.others ? html`, ${figText(othersWords(c.others, !!ctx.state.settings.cover))}` : '';
    rows.push({ key: 'income-confirm-' + c.key, text: html`${asked}${others}: ${shows}. ${one ? 'Did this one come by Zelle?' : 'Did these come by Zelle?'}`,
    buttons: [['It came by Zelle', 'board.income-confirm', { source: c.source, items: c.ids.join(' '), how: 'bank', row: c.row }],
      ['It was cash', 'board.income-confirm', { source: c.source, items: c.ids.join(' '), how: 'cash', row: c.row }]] });
  }
  for (const p of q.payers) {
    const bank = !p.bank ? ''
      : p.bank.same ? html` The bank shows ${inlineMoney(p.bank.cents)} on ${fmtDate(p.bank.day, 'short')}.`
        : html` An earlier one reached the bank: ${inlineMoney(p.bank.cents)} on ${fmtDate(p.bank.day, 'short')}.`;
    rows.push({ key: 'income-payer-' + p.key, text: html`${head(p.what + ' · ' + p.name, p.cents, p.marked)}. How do they pay?${bank}`,
      buttons: [['Zelle or transfer', 'board.income-payer', { source: p.source, payer: p.payer, how: 'bank' }],
        ['Cash', 'board.income-payer', { source: p.source, payer: p.payer, how: 'cash' }]] });
  }
  for (const l of q.late) {
    rows.push({ key: 'income-late-' + l.key, text: html`${head(l.label, l.cents, l.marked)}: it has not reached the bank.`,
      buttons: [['It was cash', 'board.income-item', { source: l.source, item: l.id, how: 'cash' }],
        ['It’s in the bank', 'board.income-item', { source: l.source, item: l.id, how: 'gone' }],
        ['Still coming', 'board.income-item', { source: l.source, item: l.id, how: 'wait' }]] });
  }
  return rows;
}

/**
 * The questions about reported income, in a small band of their own directly above Recent transactions
 * (both layouts), which the owner checks often: shown only when there is a question.
 */
function askBand(ctx) {
  const asked = incomeRows(ctx);
  if (!asked.length) return '';
  return html`<section class="band board-ask" aria-labelledby="b-ask">
    <div class="sec-head"><h2 class="lab" id="b-ask"><b>To answer</b><i class="sep"></i>reported income</h2><span class="lab">${plural(asked.length, 'question', 'questions')}</span></div>
    <ol class="notes">${asked.map((q, i) => html`<li class="note" data-key="${q.key}">
      <b class="note-n">${i + 1}</b><span class="note-text" id="b-ask-${i + 1}">${q.text}</span>
      <span class="note-actions">${q.buttons.map(([label, action, data]) => html`<button class="btn-link" type="button" data-action="${action}" aria-describedby="b-ask-${i + 1}"${dataAttrs(data)}>${label}</button>`)}</span>
    </li>`)}</ol>
  </section>`;
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
      <span class="note-text">${sayHtml('board.sweep.open', ctx.words, { date: fmtDate(sweep.weekOf, 'short'), amount: html`<i data-fig>${fmt(sweep.amount, { decimals: 0 })}</i>`, target: sweep.target === 'card' ? 'card' : phrase('board.sweep.reserve', ctx.words) })}</span>
      <button class="note-action btn-link" type="button" data-action="app.sheet" data-sheet="sweep">${sayHtml('assess.cta.sweep', ctx.words)}</button>
    </li>`);
  }
  return html`
    <div class="sec-head"><h2 class="lab" id="b-notes"><b>${sayHtml('assess.notes', ctx.words)}</b></h2><span class="lab">${fmtDate(ctx.today, 'short')}</span></div>
    ${rows.length ? html`<ol class="notes">${rows}</ol>` : html`<p class="cap board-quiet">${sayHtml('board.notes.none', ctx.words, { day: fmtDate(ctx.today, 'dowshort') })}</p>`}`;
}

function principlesBlock(ctx) {
  const list = (ctx.state.settings.principles || []).filter((p) => typeof p === 'string' && p.trim());
  return html`
    <div class="sec-head"><h2 class="lab" id="b-princ"><b>${sayHtml('board.principles', ctx.words)}</b></h2><span class="lab">Your own rules</span></div>
    ${list.length
      ? html`<ol class="principles">${list.map((p, i) => html`<li data-key="${'p' + i}"><b>${i + 1}</b><span>${p}</span></li>`)}</ol>`
      : html`<p class="cap board-quiet">${sayHtml('board.principles.none', ctx.words, { settings: html`<a href="#/settings">Settings</a>` })}</p>`}`;
}

/* ------------------------------------------------------------ G. figures */

function worthData(ctx, v) {
  const closes = ctx.d.recent(WORTH_DAYS).filter((c) => !v.firstDay || c.day >= v.firstDay);
  const cash = cashAccountOf(ctx.state);
  const countDays = new Set((cash && Array.isArray(cash.counts) ? cash.counts : [])
    .filter((c) => c && Number.isFinite(c.at)).map((c) => gameDay(c.at, ctx.state.settings.rolloverHour)));
  const data = {
    days: closes.map((c) => ({ day: c.day, smooth: c.smooth, bank: c.bank, partial: c.partial })),
    // a day on which the owner counted Cash in hand says "counted", as the sheet and the toasts do
    events: closes.filter((c) => c.reval !== 0).map((c) => ({ day: c.day, label: countDays.has(c.day) ? 'counted' : 'revalued' })),
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
            ? html`${sayHtml('board.worth.lead', ctx.words, { days: plural(worth.count, 'day', 'days') })} Dotted: ${bankWhere(!!handAccount(ctx))}.${sayHtml('board.worth.tail', ctx.words)}`
            : html`Net worth ${bankWhere(!!handAccount(ctx))}, the last ${plural(worth.count, 'day', 'days')}${worth.count < WORTH_DAYS ? html`: the record begins ${fmtDate(worth.from, 'short')}` : ''}.${sayHtml('board.worth.tail', ctx.words)}`}
        </figcaption>
      </figure>
      <figure class="${cx('board-fig', !edge.from && 'is-empty')}">
        <nw-chart data-island kind="edge" data="${JSON.stringify(edge.data)}"></nw-chart>
        <figcaption class="cap"><span class="lab"><b>Fig. 2</b></span>
          ${edge.from
            ? html`${sayHtml('board.edge', ctx.words, { span: edge.windowed ? sayHtml('board.edge.windowed', ctx.words, { n: EDGE_ROUNDS_SHOWN, date: fmtDate(ctx.state.meta.matchStart, 'medium') }) : sayHtml('board.edge.since', ctx.words, { date: fmtDate(edge.from, 'short') }) })}
              ${sayHtml('board.edge.parts', ctx.words, { kept: html`<span data-fig>${fmt(e.kept, { sign: 'always' })}</span>`, moved: html`<span data-fig>${fmt(e.moved)}</span>` })}`
            : sayHtml('board.edge.later', ctx.words, { when: begins ? html`, around ${fmtDate(begins, 'short')}` : html`, on day ${ctx.d.matchFromDay} on record` })}
        </figcaption>
      </figure>
    </div>`;
}

/* ------------------------------------------------- recent transactions */

const RECENT_WIDE = 12;
const RECENT_NARROW = 8;

/**
 * Every account's latest transactions, newest first: the plain answer to "did anything go through?".
 * A row opens the move's own sheet. Amounts are the bank's; a pending or tapped-in one is not final,
 * so it is set as an estimate.
 */
function recentBlock(ctx, v) {
  const r = ctx.d.latest(ctx.wide ? RECENT_WIDE : RECENT_NARROW, v.seen ? v.seen.at : null);
  const sample = ctx.state.meta.origin === 'demo';
  const read = Number.isFinite(ctx.state.sync.lastOk) ? ctx.state.sync.lastOk : null;
  const head = html`<div class="sec-head">
    <h2 class="lab" id="b-recent" tabindex="-1"><b>Recent transactions</b><i class="sep"></i>every account</h2>
    <a class="btn-link" href="#/scoresheet">All, by day</a>
  </div>`;
  const source = sample ? 'Sample transactions.'
    : read === null ? 'The bank has not been read yet.'
      : 'The bank was read ' + whenText(ctx, read, true) + '. Its feed updates about once a day, so a purchase can take until the next day to appear.';
  if (!r.rows.length) {
    return html`${head}<p class="cap board-quiet">0 transactions are on the record. ${source}</p>`;
  }
  const t = r.today;
  const todayLine = t.count
    ? html`Today: ${plural(t.count, 'transaction', 'transactions')}${t.out ? html`, ${inlineMoney(t.out, { est: t.unsettledOut })} out` : ''}${t.in ? html`, ${inlineMoney(t.in, { est: t.unsettledIn })} in` : ''}.`
    : 'Today: 0 transactions on the record.';
  return html`${head}
    <p class="board-recent-today">${todayLine}${r.fresh ? html` <span class="recent-new">${r.fresh} new</span> since the last look.` : ''}</p>
    ${recentList(ctx, r.rows, { label: 'Recent transactions, newest first' })}
    <p class="cap board-line">${r.total > r.rows.length ? html`The latest ${r.rows.length} of ${r.total.toLocaleString('en-US')}. ` : ''}${source}</p>`;
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
      ? html`<p class="cap board-line">${sayHtml('board.card.scheduled', ctx.words, { amount: inlineMoney(m.scheduled, { est: true }) })}</p>` : ''}
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
    return html`${head}<p class="cap board-quiet">${sayHtml('board.ladder.none', ctx.words, { amount: html`<span data-fig>${fmt(l.received)}</span>`, days: plural(l.days, 'day', 'days') })}</p>`;
  }
  return html`${head}
    <ol class="ladder board-ladder">
      ${rungs.map((rung, i) => {
        const next = rung.target === nextTarget;
        const reached = rung.reached && !thin;
        const caption = next ? say('board.ladder.next', ctx.words, { pct: fmtPct(rung.fraction, 1) })
          : reached ? 'reached'
            : i === 0 && isYmd(l.final.by) ? 'by ' + fmtMonth(monthOf(l.final.by)) : '';
        return html`<li class="${cx('rung', next && 'is-next', reached && 'is-done', !next && !reached && 'is-later')}" data-key="${'rung' + rung.target}">
          <span class="rung-title">${ctx.words !== 'finance'
            ? (i < NORM_TITLES.length ? NORM_TITLES[i] : say('board.ladder.target', ctx.words, { n: rungs.length - i }))
            : rungNumber(i) ? say('board.ladder.target', ctx.words, { n: rungNumber(i) }) : ''}</span>
          <span class="fig">${fmt(rung.target, { decimals: 0 })}</span>
          <span class="cap">${caption}</span>
        </li>`;
      })}
      <li class="rung is-you" data-key="you">
        <span class="bar rung-bar" style="${'--p:' + (fraction * 100).toFixed(1) + '%'}" aria-hidden="true"><i></i></span>
        <span class="rung-title">You</span>
        ${thin ? html`<span class="fig est" data-cover-keep>—</span>` : money(l.grossApprox, { est: true, decimals: 0 })}
        <span class="cap">${thin ? 'a year’s figure is read from day 60' : l.next ? 'gross, about, a year' : say('board.ladder.all', ctx.words)}</span>
        <span class="cap rung-note">${thin
          ? html`<span data-fig>${fmt(l.received)}</span> received in ${plural(l.days, 'day', 'days')} on record: too short a stretch to scale to a year.`
          : l.partial
            ? html`<span data-fig>${fmt(l.received)}</span> received in ${plural(l.days, 'day', 'days')} on record, scaled to a year: rough until more history is in.`
            : html`<span data-fig>${fmt(l.received)}</span> received in the last 12 months, grossed up for what is withheld.`}${sayHtml('board.ladder.apart', ctx.words)}</span>
      </li>
    </ol>`;
}

/* ---------------------------------------------------------------- J. key */

function keyBlock(words) {
  const sign = (symbol) => html`<span>${evalGlyph(symbol, { decorative: true, words })}${lowerFirst(evalName(symbol, words))}</span>`;
  const mark = (glyph, text) => html`<span><b class="sym" aria-hidden="true">${glyph}</b>${text}</span>`;
  return html`<p class="key">
    <span class="lab">Key to symbols</span>
    ${sign('winning')}${sign('clear_plus')}${sign('slight_plus')}${sign('equal')}
    ${sign('slight_minus')}${sign('clear_minus')}${sign('losing')}${sign('unclear')}
    <span>${timeTroubleGlyph({ decorative: true, words })}${lowerFirst(phrase('glyph.timeTrouble', words))}</span>
    <span class="board-key-box">${moveGlyph('□', { title: glyphName('□', words), words })}${sayHtml('board.key.only', words)}</span>
    ${mark('!!', phrase('board.key.clean', words))}${mark('!', phrase('board.key.good', words))}${mark('!?', 'judged by its return')}
    ${mark('?!', 'unplanned 2nd stop')}${mark('?', 'unplanned 3rd stop')}${mark('??', 'avoidable penalty')}
    <button class="btn-link" type="button" data-action="app.sheet" data-sheet="words">${phrase('words.open', words)}</button>
  </p>`;
}

/* ----------------------------------------------------------------- render */

function wideBoard(ctx, v) {
  const last = v.matchOn ? lastBlock(ctx, v) : '';
  const card = cardBlock(ctx, v);
  return html`<div class="board">
    <h1 class="vh">${sayHtml('board.title', ctx.words, { date: fmtDate(ctx.today, 'long') })}</h1>
    <div class="cols">
      <section class="col col-8 hero" aria-labelledby="b-nw">${heroMain(ctx, v)}${heroMore(ctx, v)}</section>
      <section class="col col-4 clock" aria-labelledby="b-clock">${clockMain(ctx, v)}<div class="clock-reserve">${reserveBlock(ctx)}</div>${v.pay ? html`<section class="board-pay-col" aria-labelledby="b-pay">${payBlock(ctx, v)}</section>` : ''}</section>
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
    ${askBand(ctx)}
    <section class="band" aria-labelledby="b-recent">${recentBlock(ctx, v)}${fileLine(ctx)}</section>
    <div class="band">${crosstableBlock(ctx, v)}</div>
    <div class="cols">
      <section class="col col-8" aria-labelledby="b-figs">${figuresBlock(ctx, v)}</section>
      <div class="col col-4">
        ${card ? html`<section class="band" aria-labelledby="b-card">${card}</section>` : ''}
        <section class="band" aria-labelledby="b-ladder">${ladderBlock(ctx)}</section>
      </div>
    </div>
    <section class="band pb-0" aria-label="Key to symbols">${keyBlock(ctx.words)}</section>
  </div>`;
}

function narrowBoard(ctx, v) {
  const last = v.matchOn ? lastBlock(ctx, v) : '';
  const card = cardBlock(ctx, v);
  return html`<div class="board board-narrow">
    <h1 class="vh">${sayHtml('board.title', ctx.words, { date: fmtDate(ctx.today, 'long') })}</h1>
    <section class="band hero board-top" aria-labelledby="b-nw">${heroMain(ctx, v)}</section>
    <section class="band clock board-top" aria-labelledby="b-clock">${clockMain(ctx, v)}</section>
    ${v.pay ? html`<section class="band board-pay-band" aria-labelledby="b-pay">${payBlock(ctx, v)}</section>` : ''}
    <section class="band" aria-labelledby="b-today">${v.matchOn ? todayBlock(ctx, v) : prematchBlock(ctx, v)}</section>
    ${askBand(ctx)}
    <section class="band" aria-labelledby="b-recent">${recentBlock(ctx, v)}${fileLine(ctx)}</section>
    ${last ? html`<section class="band" aria-labelledby="b-last">${last}</section>` : ''}
    <section class="band" aria-labelledby="b-material">
      <div class="sec-head"><h2 class="lab" id="b-material"><b>Net worth</b><i class="sep"></i>what it is made of</h2></div>
      ${heroMore(ctx, v)}
    </section>
    <section class="band clock" aria-labelledby="b-reserve">
      <div class="sec-head"><h2 class="lab" id="b-reserve"><b>Cash on hand</b><i class="sep"></i>${sayHtml('board.reserve.head', ctx.words)}</h2><span class="lab">${sayHtml('board.reserve.note', ctx.words)}</span></div>
      <div class="board-reserve">${reserveBlock(ctx)}</div>
    </section>
    <section class="band" aria-labelledby="b-pos">${positionBlock(ctx)}</section>
    <section class="band" aria-labelledby="b-notes">${notesBlock(ctx)}</section>
    <section class="band" aria-labelledby="b-princ">${principlesBlock(ctx)}</section>
    <div class="band">${crosstableBlock(ctx, v)}</div>
    <section class="band" aria-labelledby="b-figs">${figuresBlock(ctx, v)}</section>
    ${card ? html`<section class="band" aria-labelledby="b-card">${card}</section>` : ''}
    <section class="band" aria-labelledby="b-ladder">${ladderBlock(ctx)}</section>
    <section class="band pb-0" aria-label="Key to symbols">${keyBlock(ctx.words)}</section>
  </div>`;
}

/**
 * One quiet line when moves wait to be filed (DESIGN decision 11): how many items the queue holds, and the way to it
 * (the queue of money in and out, opened in place). No badge on the bar; nothing when every move is filed.
 */
function fileLine(ctx) {
  let n = 0;
  try { n = moveQueue(ctx.state, ctx.now, { ledger: ctx.d.ledger }).items.length; } catch { n = 0; }
  if (!n) return '';
  const items = n === 1 ? phrase('flows.queue.items.one', ctx.words) : say('flows.queue.items.many', ctx.words, { n });
  return html`<p class="cap board-file">${sayHtml('board.file', ctx.words, { items: html`<span data-cover-keep>${items}</span>` })}
    <a class="btn-link" href="#/flows" data-action="flows.queue" data-open="1" data-go="#/flows">${sayHtml('flows.queue.open', ctx.words)} ›</a></p>`;
}

export function render(ctx) {
  const v = model(ctx);
  return ctx.wide ? wideBoard(ctx, v) : narrowBoard(ctx, v);
}

/** The keys of the reported payments in Cash in hand now. */
function inCash(state) {
  const account = cashAccountOf(state);
  return new Set(account ? state.txs.filter((tx) => tx && tx.via === 'income' && tx.accountId === account.id && tx.income).map((tx) => tx.income.key) : []);
}

/**
 * What a cash answer did to Cash in hand (income-words: beforeCountWords), read after the answer: the figure is the
 * one the rebuild stored, not the last render's.
 */
function cashAfter(ctx, had, kind) {
  const account = cashAccountOf(store.state);
  return account ? beforeCountWords(store.state, had, Math.round(Number(account.balance) || 0), ctx.today, !!store.state.settings.cover, kind, ctx.words) : null;
}

/** The place of the question a button belongs to (0 for the first), or 0. */
function questionIndex(el) {
  const li = el && typeof el.closest === 'function' ? el.closest('.board-ask .note') : null;
  return li && li.parentNode ? [...li.parentNode.children].indexOf(li) : 0;
}

/**
 * After an answer: the first button of the question it raised (`key`, the line's data-key), else of the next
 * question (the one that now stands where the answered one stood), or else the Recent transactions heading.
 */
function focusAfterAnswer(index, key) {
  const go = () => {
    const notes = [...document.querySelectorAll('.board-ask .note')];
    const raised = key ? notes.find((li) => li.getAttribute('data-key') === key) : null;
    const at = raised || notes[index];
    const next = at ? at.querySelector('.note-actions button') : null;
    const target = next || document.getElementById('b-recent');
    if (target) target.focus({ preventScroll: !next });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(go)); else setTimeout(go, 0);
}

/** A toast with Undo that only undoes the change it announces. */
function offerUndo(message, label, undone) {
  toast(message, {
    action: 'Undo',
    onAction: () => {
      if (store.undoLabel === label && store.undo()) toast(undone);
    },
  });
}

/** The checklist's row of this payment and day, as the engine has it now. */
function payRowOf(ctx, id, day) {
  const bh = ctx.d.byHand;
  const rows = bh && Array.isArray(bh.rows) ? bh.rows : [];
  return rows.find((row) => row.entry && row.entry.id === id && (!day || row.day === day)) || null;
}

export const actions = {
  /** The hero is a button: one tap switches between the live figure and the bank's own. */
  'board.hero': () => {
    store.setUi({ heroMode: store.ui.heroMode === 'bank' ? 'live' : 'bank' });
  },

  /** The box of a payment: a tap ticks it as paid, a second tap takes the tick back. The bank's own tick is not a button. */
  'board.pay-tick': ({ data }) => {
    const ctx = context();
    const row = payRowOf(ctx, data.id, data.day);
    if (!row || row.status === 'bank' || row.status === 'pending') return;
    const paid = row.status !== 'hand';
    const name = row.entry.name || 'The payment';
    const when = fmtDate(row.day, 'dowshort');
    const undoLabel = paid ? 'Payment ticked' : 'Payment unticked';
    let done = false;
    store.update((s) => { done = tickByHand(s, data.id, data.day, paid, ctx.now); }, { undo: undoLabel });
    if (!done) return;
    const amount = ctx.state.settings.cover ? '' : ', ' + fmt(row.amount);
    offerUndo(paid ? 'Ticked: ' + name + amount + ', ' + when + '.' : 'Unticked: ' + name + ', ' + when + '.',
      undoLabel, paid ? name + ', ' + when + ', is unticked again.' : name + ', ' + when + ', is ticked again.');
  },

  /** "Not this payment": the bank's row is taken off the payment, and never offered to it again. */
  'board.pay-skip': ({ data }) => {
    const ctx = context();
    const row = payRowOf(ctx, data.id, null);
    const tx = ctx.state.txs.find((one) => one && one.id === data.tx);
    if (!row || !tx) return;
    const name = row.entry.name || 'the payment';
    const undoLabel = 'Row taken off the payment';
    let done = false;
    store.update((s) => {
      done = skipRow(s, data.id, data.tx, ctx.now);
      if (done) refresh(s, ctx.now);
    }, { undo: undoLabel });
    if (!done) return;
    offerUndo('The bank’s row of ' + fmtDate(tx.day, 'short') + ' no longer pays ' + name + '.', undoLabel, 'The row of ' + fmtDate(tx.day, 'short') + ' pays ' + name + ' again.');
  },

  /** The bank shows another amount to this payee: the payment takes that amount from here on. */
  'board.pay-amount': ({ data }) => {
    const ctx = context();
    const row = payRowOf(ctx, data.id, data.day);
    if (!row || !(row.otherAmount > 0)) return;
    const name = row.entry.name || 'The payment';
    const amount = row.otherAmount;
    const undoLabel = 'Amount of the payment changed';
    let done = false;
    store.update((s) => {
      done = editByHand(s, data.id, { amount }, ctx.today, ctx.now);
      if (done) refresh(s, ctx.now);
    }, { undo: undoLabel });
    if (!done) return;
    const after = payRowOf(context(), data.id, null);
    offerUndo(name + (ctx.state.settings.cover ? ' takes the bank’s amount' : ' is now ' + fmt(amount)) + (after ? ', from ' + fmtMonth(monthOf(after.day), 'name') + '.' : '.'),
      undoLabel, name + ' is at its earlier amount again.');
  },

  /**
   * How a payer pays (3.7): payments without their own answer follow it, on every device. Like every answer it is
   * made as a change from outside, so no Undo takes it back; the payer switch in Settings changes it.
   */
  'board.income-payer': ({ el, data }) => {
    const index = questionIndex(el);
    const ctx = context();
    const q = incomeQuestions(ctx.state, ctx.now).payers.find((p) => p.source === data.source && p.payer === data.payer);
    // the name Settings lists the payer by ("Avery · Group class" when another source has an Avery too)
    const name = q ? listedPayers(ctx.state).names.get(data.source + '/' + data.payer) || q.name : 'The payer';
    let done = false;
    const at = nowMs(); // the moment of the answer, not the time of the last render
    const before = inCash(ctx.state);
    const asked = new Set(incomeQuestions(store.state, at).confirm.map((c) => c.key));
    const change = (s) => answerPayer(s, data.source, data.payer, data.how, at);
    store.update((s) => { done = change(s); }, { past: change });
    if (!done) return;
    // a payment of theirs that a bank row holds now asks to be confirmed: say so, and go to that question
    const raised = incomeQuestions(store.state, at).confirm.find((c) => !asked.has(c.key)) || null;
    const moved = [...inCash(store.state)].filter((key) => !before.has(key)).length;
    toast(payerWords(name, data.how, data.how === 'cash' ? cashAfter(ctx, before, 'payer') : null, raised ? raised.bank : null, !!store.state.settings.cover, moved, undefined, ctx.words));
    focusAfterAnswer(index, raised ? 'income-confirm-' + raised.key : null);
  },

  /** A payment that has not reached the bank: it was cash, it is in the bank, or it is still coming (3.7). Ask again changes it. */
  'board.income-item': ({ el, data }) => {
    const index = questionIndex(el);
    const ctx = context();
    const q = incomeQuestions(ctx.state, ctx.now).late.find((l) => l.source === data.source && l.id === data.item);
    const label = q ? q.label : 'The payment';
    const had = inCash(ctx.state);
    let done = false;
    const at = nowMs(); // the moment of the answer, not the time of the last render
    const change = (s) => answerItems(s, data.source, [data.item], data.how, at);
    store.update((s) => { done = change(s); }, { past: change });
    if (!done) return;
    toast(itemWords(label, data.how, data.how === 'cash' ? cashAfter(ctx, had) : null, at, ctx.state.settings.rolloverHour, ctx.words));
    focusAfterAnswer(index);
  },

  /** A bank row counted for payments that follow their payer's cash answer: it came by Zelle, or it was cash, for every one (3.7). */
  'board.income-confirm': ({ el, data }) => {
    const index = questionIndex(el);
    const ctx = context();
    const ids = String(data.items || '').split(' ').filter(Boolean);
    const q = incomeQuestions(ctx.state, ctx.now).confirm.find((c) => c.row === data.row);
    const label = q ? q.label : 'The payment';
    const had = inCash(ctx.state);
    let done = false;
    const at = nowMs(); // the moment of the answer, not the time of the last render
    const change = (s) => answerItems(s, data.source, ids, data.how, at);
    store.update((s) => { done = change(s); }, { past: change });
    if (!done) return;
    toast(confirmWords(label, ids.length, data.how, data.how === 'cash' ? cashAfter(ctx, had) : null, ctx.words));
    focusAfterAnswer(index);
  },

  /** Open the entry sheet empty, for a payment the owner sends. */
  'board.pay-add': () => {
    if (store.ui.payForm) store.setUi({ payForm: null });
    openSheet('recurring', { pay: 'new' });
  },
};
