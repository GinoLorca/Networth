/**
 * The Book — recurring bills as an opening book: what is committed each month, what is on its way,
 * the renewals being prepared for, every line with its verdict, and the income streams.
 *
 * Sections, in reading order:
 *   totals      committed each month (of which toward debts), a year, a day; by category; by purpose; verdicts
 *   upcoming    the next 30 days, with a rule in the margin on what falls before the next payday
 *   payday      what the Book draws from cash and puts on a card before payday, against cash on hand
 *   renewals    quarterly and longer charges in the next 120 days, with what has accrued toward each
 *   income      each stream and how it is counted; one passage on what that does to the net-worth figure
 *   the lines   every active entry, by cost a month, with keep · review · cut saved on tap; ended ones collapsed
 *
 * An amount is roman when it is the bank's last charge; italic with the sign when it varies, or when it
 * was entered by hand and no charge of it has arrived yet.
 *
 * Actions: book.verdict (save a verdict on tap), book.open (open an entry or a stream), book.add (a new entry).
 * The entry and stream sheets live in sheet-recurring.js and sheet-stream.js.
 */

import { html, cx } from '../ui/dom.js';
import { store } from '../store.js';
import { openSheet } from '../router.js';
import { fmt } from '../model/money.js';
import { addDays, diffDays, fmtDate, isYmd, relDay } from '../model/dates.js';
import { ACCOUNT_TYPES, CADENCES, STREAM_KINDS, accountLabel, categoryLabel } from '../model/schema.js';
import { annualCost, dailyCost, nextOccurrence } from '../model/book.js';
import { moveGlyph, timeTroubleGlyph } from '../ui/glyphs.js';
import { money } from './parts.js';

const UPCOMING_DAYS = 30;
const RENEWAL_DAYS = 120;
/** How far ahead the next renewal is looked for when none falls inside the window (a year and a little). */
const RENEWAL_HORIZON_DAYS = 400;
/** The clock looks this far ahead when no payday is known (ARCHITECTURE 4.9). */
const NO_PAYDAY_DAYS = 14;
/** A date further off than this is printed with its year. */
const FAR_DAYS = 180;
const VERDICTS = [['keep', 'Keep'], ['review', 'Review'], ['cut', 'Cut']];

/* ------------------------------------------------------------------ helpers */

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many || one + 's');
}

/** Whole cents a month, the way the model's totals count it. */
function monthlyCost(rec) {
  return Math.round(annualCost(rec) / 12);
}

/** A coming day: "Jul 1", with its year once it is more than half a year off ("Jun 1, 2027"). */
function comingDay(day, today) {
  return fmtDate(day, diffDays(today, day) > FAR_DAYS ? 'medium' : 'short');
}

function cadenceText(key) {
  return CADENCES[key] ? CADENCES[key].label.toLowerCase() : 'no cadence';
}

/** A figure inside a sentence: roman from the bank, italic with the sign when computed; covered by cover mode. */
/** "No deposit from {name} since {date}." for each pay stream that stopped (ledger: lapsedPay); '' when none did. */
function lapsedNote(ctx) {
  const lapsed = Array.isArray(ctx.d.position.lapsedPay) ? ctx.d.position.lapsedPay.filter((item) => item && typeof item === 'object') : [];
  return lapsed.map((item) => 'No deposit from ' + (item.name || 'a regular payer') + ' since ' + (isYmd(item.since) ? fmtDate(item.since, 'short') : 'a day not on record') + '.').join(' ');
}

function inFig(cents, est) {
  return est
    ? html`<span class="est" data-fig><span class="approx">≈</span>${fmt(cents)}</span>`
    : html`<span class="bk-roman" data-fig>${fmt(cents)}</span>`;
}

function purposeLabel(ctx, key) {
  const labels = ctx.state.settings.purposes || {};
  return labels[key] || key;
}

function accountName(ctx, id) {
  const account = id == null ? null : ctx.d.account(id);
  return account ? accountLabel(account) : null;
}

/** True when a charge to this account lowers cash: a cash account, or no known account (ARCHITECTURE 4.9). */
function drawsOnCash(ctx, accountId) {
  const account = accountId == null ? null : ctx.d.account(accountId);
  if (!account) return true;
  const type = ACCOUNT_TYPES[account.type];
  return !account.hidden && !!type && type.group === 'cash';
}

/** The latest day a charge of each entry landed: Map<recurringId, day>. */
function lastCharges(state) {
  const last = new Map();
  for (const tx of state.txs) {
    if (!tx.recurringId || tx.kind === 'decline' || tx.matchId) continue;
    const seen = last.get(tx.recurringId);
    if (!seen || tx.day > seen) last.set(tx.recurringId, tx.day);
  }
  return last;
}

/**
 * True when an entry's amount is not a figure the bank reported as it stands: it varies, or it was
 * entered by hand and no charge of it has arrived yet. Such an amount is set in italics with the sign.
 */
function assumed(charged, rec) {
  return !!rec && (!!rec.variable || (rec.source === 'manual' && !charged.has(rec.id)));
}

/** Days on record: the first transaction's day through today, both included (R6); 0 when there is none. */
function historyDays(ctx) {
  const n = ctx.d.historyDays;
  return Number.isFinite(n) ? n : 0;
}

function historyPhrase(ctx) {
  const days = historyDays(ctx);
  return days ? plural(days, 'day') + ' on record' : 'the record so far';
}

/** Everything the screen prints, read once from the context. */
function bookModel(ctx) {
  const state = ctx.state;
  const today = ctx.today;
  const byId = new Map(state.recurring.map((rec) => [rec.id, rec]));
  const charged = lastCharges(state);
  const active = state.recurring
    .filter((rec) => rec.active)
    .map((rec) => ({ rec, perMonth: monthlyCost(rec) }))
    .sort((a, b) => b.perMonth - a.perMonth || (a.rec.name < b.rec.name ? -1 : 1));
  const inactive = state.recurring.filter((rec) => !rec.active);

  // An occurrence whose charge has already landed is not on its way any more.
  const upcoming = ctx.d.upcoming(UPCOMING_DAYS)
    .filter((row) => !(charged.get(row.id) >= row.day))
    .map((row) => {
      const rec = byId.get(row.id) || null;
      // every amount still to come has not posted, fixed-price or not: an estimate (R4a)
      return { ...row, rec, est: true, cash: drawsOnCash(ctx, row.accountId) };
    });

  const clock = ctx.d.clock;
  // while pay is awaited the clock's payday is today, which no line calls the next payday (R1c)
  const payday = clock.payAwaited ? null : clock.nextPayday;
  const debts = active.filter(({ rec }) => rec.toAccountId != null);
  return {
    today, byId, charged, active, inactive, upcoming, clock, payday,
    totals: ctx.d.bookTotals,
    debtPerMonth: debts.reduce((n, item) => n + item.perMonth, 0),
    debtCount: debts.length,
    byHand: active.filter(({ rec }) => rec.source === 'manual' && !charged.has(rec.id)).length,
  };
}

/** The next day an entry is expected, today included unless today's charge has landed. */
function nextDay(m, rec) {
  let next = nextOccurrence(rec, addDays(m.today, -1));
  if (next && m.charged.get(rec.id) >= next) next = nextOccurrence(rec, next);
  return next;
}

/* ------------------------------------------------------------------- totals */

function totalsBand(ctx, m) {
  const t = m.totals;
  if (!t.count) {
    return html`<section class="band bk-total">
      <div class="sec-head"><h1 class="lab"><b>The Book</b><i class="sep"></i>recurring bills</h1></div>
      <div class="empty empty-plain">
        <p class="empty-title">The Book has no lines yet.</p>
        <p class="cap">${historyPhrase(ctx)[0].toUpperCase() + historyPhrase(ctx).slice(1)} ${historyDays(ctx) === 1 ? 'holds' : 'hold'} no repeating charge so far.
          A monthly bill is entered after its second or third charge, a yearly one after its second; nothing needs typing.</p>
      </div>
    </section>`;
  }
  const costPerMonth = t.perMonth - m.debtPerMonth;
  return html`<div class="cols">
    <section class="col col-5 bk-total">
      <div class="sec-head">
        <h1 class="lab"><b>The Book</b><i class="sep"></i>recurring bills</h1>
        <span class="lab">${plural(t.count, 'line')}</span>
      </div>
      <p class="lab bk-total-lab">Committed each month</p>
      <p class="bk-total-fig">${money(t.perMonth, { est: true, size: 'xl' })}</p>
      <div class="tally tally-s tally-ruled bk-total-tally">
        <div class="tally-item"><span class="lab">Of which toward debts</span>${money(m.debtPerMonth, { est: true })}</div>
        <div class="tally-item"><span class="lab">A year</span>${money(t.perYear, { est: true })}</div>
        <div class="tally-item"><span class="lab">A day</span>${money(t.perDay, { est: true })}</div>
      </div>
      <p class="cap bk-total-note">${m.debtCount
        ? html`${plural(m.debtCount, 'payment')} toward debts ${m.debtCount === 1 ? 'leaves' : 'leave'} cash, so ${m.debtCount === 1 ? 'it is' : 'they are'} committed, but ${m.debtCount === 1 ? 'it is' : 'they are'} not a cost: ${m.debtCount === 1 ? 'it lowers' : 'they lower'} what is owed. Without ${m.debtCount === 1 ? 'it' : 'them'} the Book costs ${inFig(costPerMonth, true)} a month.`
        : html`None of the ${plural(t.count, 'line')} pays down a debt: all ${inFig(t.perMonth, true)} a month is cost.`}
        ${m.byHand === t.count
          ? html`${t.count === 1 ? 'The amount is the figure' : 'Each amount is a figure'} entered by hand, taken to repeat on its cadence.`
          : m.byHand
            ? html`A fixed amount is the bank’s most recent charge; one that varies is the middle of its last 3 charges, in italics; for ${plural(m.byHand, 'line')} it is the figure entered by hand. Each is taken to repeat on its cadence.`
            : html`A fixed amount is the bank’s most recent charge; one that varies is the middle of its last 3 charges, in italics. Each is taken to repeat on its cadence.`}</p>
    </section>
    <section class="col col-4">
      <div class="sec-head"><h2 class="lab"><b>By category</b><i class="sep"></i>a month</h2></div>
      <ul class="rows">
        ${t.byCategory.map((row) => {
          const lines = m.active.filter(({ rec }) => (rec.category || 'other') === row.category).length;
          return html`<li class="row" data-key="${row.category}">
            <span class="row-label">${categoryLabel(row.category)} <em class="row-note">${plural(lines, 'line')}</em></span>
            <span class="row-value">${money(row.perMonth, { est: true })}</span>
          </li>`;
        })}
      </ul>
    </section>
    <section class="col col-3">
      <div class="sec-head"><h2 class="lab"><b>By purpose</b><i class="sep"></i>a month</h2></div>
      <ul class="rows">
        ${t.byPurpose.map((row) => html`<li class="row" data-key="${row.purpose}">
          <span class="row-label">${purposeLabel(ctx, row.purpose)}</span>
          <span class="row-value">${money(row.perMonth, { est: true })}</span>
        </li>`)}
      </ul>
      <div class="sec-head bk-sub"><h2 class="lab"><b>Verdicts</b><i class="sep"></i>a month</h2></div>
      ${t.review || t.cut ? html`<ul class="rows">
        ${t.review ? html`<li class="row" data-key="review">
          <span class="row-label">Under review <em class="row-note">${plural(m.active.filter(({ rec }) => rec.verdict === 'review').length, 'line')}</em></span>
          <span class="row-value">${money(t.review, { est: true })}</span>
        </li>` : ''}
        ${t.cut ? html`<li class="row" data-key="cut">
          <span class="row-label">Marked to cut <em class="row-note">${plural(m.active.filter(({ rec }) => rec.verdict === 'cut').length, 'line')} · ${inFig(t.cut * 12, true)} a year</em></span>
          <span class="row-value">${money(t.cut, { est: true })}</span>
        </li>` : ''}
      </ul>` : html`<p class="cap bk-quiet">None of the ${plural(t.count, 'line')} carries a review or cut verdict. Keep, review or cut is one tap in the list below.</p>`}
    </section>
  </div>`;
}

/* ----------------------------------------------------------------- upcoming */

function entryTags(rec) {
  if (!rec) return '';
  return html`${rec.toAccountId != null ? html` <span class="bk-tag">Toward debt</span>` : ''}`;
}

function upcomingSection(ctx, m) {
  const rows = m.upcoming;
  const until = addDays(m.today, UPCOMING_DAYS - 1);
  const head = html`<div class="sec-head">
    <h2 class="lab"><b>Upcoming</b><i class="sep"></i>the next ${UPCOMING_DAYS} days</h2>
    <span class="lab">through ${fmtDate(until, 'short')}</span>
  </div>`;
  if (!rows.length) {
    return html`<section class="band">${head}
      <p class="cap bk-quiet">${m.totals.count
        ? html`No line of the Book falls between today and ${fmtDate(until, 'short')}.`
        : html`Nothing is expected through ${fmtDate(until, 'short')}: the Book has no lines yet. Charges that repeat appear here ${UPCOMING_DAYS} days ahead.`}</p>
    </section>`;
  }
  const payday = m.payday;
  const before = payday ? rows.filter((row) => row.day < payday) : [];
  const paydayInWindow = payday && payday <= until;
  let paydayPrinted = false;
  const paydayRow = () => {
    paydayPrinted = true;
    return html`<tr class="bk-payday" data-key="payday"><td colspan="3"><span class="lab"><b>Payday</b><i class="sep"></i>${fmtDate(payday, 'dowshort')}<i class="sep"></i>${relDay(payday, m.today)}</span></td></tr>`;
  };
  const body = [];
  for (const row of rows) {
    if (paydayInWindow && !paydayPrinted && row.day >= payday) body.push(paydayRow());
    const due = payday && row.day < payday;
    const account = accountName(ctx, row.accountId);
    body.push(html`<tr class="${cx(due && 'is-due')}" data-key="${row.id + ':' + row.day}">
      <td class="bk-when">${due ? html`<span class="vh">Before payday. </span>` : ''}<span class="not-phone">${fmtDate(row.day, 'dow')}, </span>${fmtDate(row.day, 'short')}<em class="bk-rel"><span class="only-phone">${fmtDate(row.day, 'dow')} · </span>${relDay(row.day, m.today)}</em></td>
      <td><button class="bk-line" type="button" data-action="book.open" data-sheet="recurring" data-id="${row.id}">${row.name}</button>
        <em class="bk-sub-note">${account || 'Account not known'}${entryTags(row.rec)}</em></td>
      <td class="${cx('num', row.est && 'est')}">${row.est ? html`<span class="approx">≈</span>` : ''}${fmt(row.amount)}</td>
    </tr>`);
  }
  if (paydayInWindow && !paydayPrinted) body.push(paydayRow());
  const awaited = typeof m.clock.payAwaited === 'string' ? m.clock.payAwaited : null;
  return html`<section class="band">${head}
    <table class="table bk-upcoming">
      <thead><tr><th>Date</th><th>Line</th><th class="num">Amount</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="cap bk-foot">${payday && payday === m.today
      ? html`Payday is today.`
      : payday
      ? before.length
        ? html`The rule in the margin marks what falls before payday, ${fmtDate(payday, 'dowshort')}: ${plural(before.length, 'charge')}.`
        : html`Nothing in the Book falls before payday, ${fmtDate(payday, 'dowshort')}.`
      : awaited
        ? html`Pay expected ${fmtDate(awaited, 'dowshort')} is not on the bank’s record yet, so nothing is marked as falling before a payday.`
      : lapsedNote(ctx)
        ? html`No payday is expected, so nothing is marked as falling before it. ${lapsedNote(ctx)}`
        : html`No payday is known yet, so nothing is marked as falling before it. A paycheck is recognized after its third deposit.`}
      ${rows.length ? html` An italic amount is the expected charge: none of the ${plural(rows.length, 'charge')} has posted yet.` : ''}</p>
  </section>`;
}

/* ----------------------------------------------------- before payday, renewals */

function paydayBand(ctx, m) {
  const clock = m.clock;
  const payday = m.payday;
  // pay awaited (its day passed with no deposit): the window runs through the clock's last due day (R1c)
  const awaited = typeof clock.payAwaited === 'string' ? clock.payAwaited : null;
  const dueUntil = typeof clock.dueUntil === 'string' ? clock.dueUntil : null;
  // T1: on payday itself, and in the first days pay is awaited, the window is today alone
  const dueToday = !!dueUntil && dueUntil <= m.today && (!!awaited || clock.nextPayday === m.today);
  const windowEnd = dueToday ? addDays(m.today, 1) : awaited && dueUntil ? addDays(dueUntil, 1) : payday || addDays(m.today, NO_PAYDAY_DAYS);
  const fromBook = clock.due.filter((item) => m.byId.has(item.id));
  const beyondBook = clock.due.filter((item) => !m.byId.has(item.id));
  // ledger: a Book charge whose day has passed with none posted stays due, marked overdue
  const overdue = clock.due.filter((item) => item && item.overdue);
  const onCard = m.upcoming.filter((row) => row.day < windowEnd && !row.cash);
  const cardTotal = onCard.reduce((n, row) => n + row.amount, 0);
  // an overdue charge has not posted on its day, so whether and when it lands is not known: italic, like a varying one
  // nothing due has posted yet, so every due amount, its total and what is to spare are estimates (R4a)
  const cashEst = clock.due.length > 0;
  const cardEst = onCard.length > 0;
  const window = dueToday ? html`today`
    : awaited && dueUntil
    ? html`through ${fmtDate(dueUntil, 'short')}`
    : payday ? html`before ${fmtDate(payday, 'short')}` : html`in the next ${NO_PAYDAY_DAYS} days`;
  const spare = clock.cash - clock.dueTotal;

  const awaitedNote = awaited
    ? html`<p class="cap bk-foot">Pay expected ${fmtDate(awaited, 'dowshort')} is not on the bank’s record yet.</p>`
    : html`<p class="cap bk-foot">Payday is today.</p>`;
  const head = dueToday
    ? html`<div class="sec-head"><h2 class="lab"><b>Due today</b><i class="sep"></i>${fmtDate(m.today, 'dowshort')}</h2></div>
      ${awaitedNote}`
    : awaited && dueUntil
    ? html`<div class="sec-head"><h2 class="lab"><b>Due through ${fmtDate(dueUntil, 'dowshort')}</b></h2><span class="lab">${relDay(dueUntil, m.today)}</span></div>
      ${awaitedNote}`
    : payday
    ? html`<div class="sec-head"><h2 class="lab"><b>Before payday</b><i class="sep"></i>${fmtDate(payday, 'dowshort')}</h2><span class="lab">${relDay(payday, m.today)}</span></div>`
    : html`<div class="sec-head"><h2 class="lab"><b>The next ${NO_PAYDAY_DAYS} days</b><i class="sep"></i>no payday known</h2></div>`;

  return html`<section class="band bk-payday-band">${head}
    <div class="tally tally-s bk-due-tally">
      <div class="tally-item"><span class="lab">From cash</span>${money(clock.dueTotal, { est: cashEst })}<span class="cap">${plural(clock.due.length, 'charge')}</span></div>
      <div class="tally-item"><span class="lab">On a card</span>${money(cardTotal, { est: cardEst })}<span class="cap">${plural(onCard.length, 'charge')}</span></div>
      <div class="tally-item"><span class="lab">Cash on hand</span>${money(clock.cash)}<span class="cap">at the bank</span></div>
    </div>
    <p class="bk-due-line">${clock.shortfall > 0
      ? html`<span class="tt lab">${timeTroubleGlyph({ decorative: true })}Time trouble</span> Cash is short ${inFig(clock.shortfall, cashEst)} of what is due ${window}.`
      : clock.dueTotal > 0
        ? html`Cash covers what is due ${window}, with ${inFig(spare, cashEst)} to spare.`
        : html`Nothing draws on cash ${window}.`}</p>
    ${overdue.length ? html`<p class="cap bk-foot">Due and not yet charged, still counted from cash: ${overdue.map((item, i) => html`${i ? '; ' : ''}${item.name} ${inFig(item.amount, true)}, due ${fmtDate(item.day, 'short')}`)}.</p>` : ''}
    ${beyondBook.length ? html`<p class="cap bk-foot">Counted from cash and not in the Book: ${beyondBook.map((item, i) => html`${i ? '; ' : ''}${item.name} ${inFig(item.amount, true)} on ${fmtDate(item.day, 'short')}`)}.</p>` : ''}
    ${clock.nextPayday !== null ? '' : html`<p class="cap bk-foot">No payday is known yet, so the clock counts ${NO_PAYDAY_DAYS} days ahead instead.</p>`}
  </section>`;
}

function renewalsBand(ctx, m) {
  const rows = ctx.d.renewals(RENEWAL_DAYS);
  const until = addDays(m.today, RENEWAL_DAYS - 1);
  const head = html`<div class="sec-head">
    <h2 class="lab"><b>Renewals</b><i class="sep"></i>the next ${RENEWAL_DAYS} days</h2>
    <span class="lab">quarterly and longer</span>
  </div>`;
  if (!rows.length) {
    const later = ctx.d.renewals(RENEWAL_HORIZON_DAYS).find((row) => row.inDays >= RENEWAL_DAYS);
    const slow = m.active.filter(({ rec }) => CADENCES[rec.cadence] && CADENCES[rec.cadence].perYear <= 4).length;
    return html`<section class="band">${head}
      <p class="cap bk-quiet">${later
        ? html`No quarterly or longer charge falls before ${fmtDate(until, 'short')}. The next is <button class="bk-line" type="button" data-action="book.open" data-sheet="recurring" data-id="${later.id}">${later.name}</button>, ${inFig(later.amount, true)} on ${fmtDate(later.day, 'medium')}; ${inFig(later.setAside, true)} of it is set aside by time.`
        : slow
          ? html`No quarterly or longer charge falls before ${fmtDate(until, 'short')}.`
          : html`The Book holds no quarterly, half-yearly or yearly charge so far. One is entered after its second charge, and is announced here ${RENEWAL_DAYS} days ahead.`}</p>
    </section>`;
  }
  return html`<section class="band">${head}
    <ul class="rows bk-renewals">
      ${rows.map((row) => {
        const rec = m.byId.get(row.id);
        const est = true; // a renewal still to come has not posted (R4a)
        const share = row.amount > 0 ? Math.min(100, Math.round((row.setAside / row.amount) * 100)) : 0;
        return html`<li data-key="${row.id + ':' + row.day}">
          <button class="row" type="button" data-action="book.open" data-sheet="recurring" data-id="${row.id}">
            <span class="row-label">${row.name} <em class="row-note">${rec ? cadenceText(rec.cadence) + ' · ' : ''}${fmtDate(row.day, 'dowshort')} · ${relDay(row.day, m.today)}</em></span>
            <span class="${cx('row-value fig', est && 'est')}">${est ? html`<span class="approx">≈</span>` : ''}${fmt(row.amount)}</span>
          </button>
          <div class="bk-aside">
            <div class="bar bar-ink" style="${'--p:' + share + '%'}" role="img" aria-label="${share + '% of it set aside by time'}"><i></i></div>
            <p class="cap">${inFig(row.setAside, true)} of ${inFig(row.amount, est)} set aside by time</p>
          </div>
        </li>`;
      })}
    </ul>
    <p class="cap bk-foot">Set aside by time: the share of each charge that the days since its last one have used up.
      ${ctx.d.position.smoothing ? 'The smoothed net worth already carries it.' : 'Net worth is shown as the bank reports it, so that share is not taken off the figure.'}</p>
  </section>`;
}

/* ---------------------------------------------------------------- the lines */

function verdictChips(rec) {
  return html`<div class="chips bk-verdict" role="group" aria-label="${'Verdict on ' + rec.name}">
    ${VERDICTS.map(([key, label]) => html`<button class="chip" type="button" data-action="book.verdict" data-id="${rec.id}" data-verdict="${key}" aria-pressed="${rec.verdict === key ? 'true' : 'false'}">${label}</button>`)}
  </div>`;
}

/** The name, with the only-move box kept on the line of its last word when the entry is essential. */
function nameWithMark(rec) {
  const name = rec.name || 'Unnamed line';
  if (!rec.essential) return name;
  const cut = name.lastIndexOf(' ') + 1;
  const tail = name.slice(cut);
  const mark = moveGlyph('□', { title: 'Essential: an only move' });
  // a long unbroken last word must stay free to wrap: only a short one is held on the line of the mark
  if (tail.length > 12) return html`${name} ${mark}`;
  return html`${name.slice(0, cut)}<span class="nowrap">${tail} ${mark}</span>`;
}

function entryRow(ctx, m, item) {
  const { rec } = item;
  const next = nextDay(m, rec);
  const account = accountName(ctx, rec.accountId);
  const debt = rec.toAccountId != null;
  const lastReported = !assumed(m.charged, rec) && m.charged.has(rec.id);
  const est = !lastReported;
  return html`<li class="bk-entry" data-key="${rec.id}">
    <button class="bk-open" type="button" data-action="book.open" data-sheet="recurring" data-id="${rec.id}">
      <span class="bk-name">${nameWithMark(rec)}</span>
      <em class="bk-note">${categoryLabel(rec.category)}${account ? ' · ' + account : ''}${debt ? html` · pays down ${accountName(ctx, rec.toAccountId) || 'a debt'} <span class="bk-tag">Toward debt</span>` : ''}${rec.source === 'manual' ? html` <span class="bk-tag">Entered by you</span>` : ''}</em>
    </button>
    <span class="${cx('bk-amt fig', est && 'est')}">${est ? html`<span class="approx">≈</span>` : ''}${fmt(rec.amount)}</span>
    <span class="bk-meta">
      <span class="bk-cad">${cadenceText(rec.cadence)}${rec.variable ? ' · varies' : lastReported ? ' · as last charged' : ' · expected'}</span>
      <span class="bk-next"><span class="bk-n">next </span>${next ? comingDay(next, m.today) : '—'}${next && m.payday && next < m.payday ? html`<em class="bk-flag">before payday</em>` : ''}</span>
      <span class="bk-purpose">${purposeLabel(ctx, rec.purpose)}</span>
    </span>
    <span class="bk-day"><span class="fig est"><span class="approx">≈</span>${fmt(Math.round(dailyCost(rec)))}</span><span class="bk-n"> a day</span></span>
    ${verdictChips(rec)}
  </li>`;
}

function linesBand(ctx, m) {
  const head = html`<div class="sec-head">
    <h2 class="lab"><b>The lines</b><i class="sep"></i>by cost a month</h2>
    <button class="btn-link" type="button" data-action="book.add">Add an entry</button>
  </div>`;
  const ended = m.inactive.length ? html`<details class="bk-ended">
    <summary><span class="btn-link">Ended or dismissed</span> <span class="lab">${plural(m.inactive.length, 'line')}</span></summary>
    <ul class="rows rows-plain">
      ${m.inactive.map((rec) => {
        const dismissed = Array.isArray(rec.locks) && rec.locks.includes('active');
        return html`<li data-key="${rec.id}"><button class="row" type="button" data-action="book.open" data-sheet="recurring" data-id="${rec.id}">
          <span class="row-label">${rec.name || 'Unnamed line'} <em class="row-note">${dismissed ? 'Taken out of the Book by you' : 'Ended'} · ${cadenceText(rec.cadence)}${rec.anchor ? ' · last charged ' + fmtDate(rec.anchor, 'medium') : ''}</em></span>
          <span class="row-value fig">${fmt(rec.amount)}</span>
        </button></li>`;
      })}
    </ul>
  </details>` : '';
  if (!m.active.length) {
    return html`<section class="band">${head}
      <p class="cap bk-quiet">No active line. The feed enters a bill after its second or third charge; one that has not been charged yet can be added by hand, with its amount and its next date.</p>
      ${ended}
    </section>`;
  }
  return html`<section class="band">${head}
    <ol class="bk-list" aria-label="The lines of the Book, by cost a month">
      <li class="bk-entry bk-head" data-key="head" aria-hidden="true">
        <span class="lab">Line</span><span class="lab bk-amt">Amount</span>
        <span class="bk-meta"><span class="lab bk-cad">Cadence</span><span class="lab bk-next">Next</span><span class="lab bk-purpose">Purpose</span></span>
        <span class="lab bk-day">A day</span>
        <span class="lab bk-verdict">Verdict</span>
      </li>
      ${m.active.map((item) => entryRow(ctx, m, item))}
    </ol>
    <p class="cap bk-foot">${moveGlyph('□')} marks an essential line, an only move. A verdict is a note to yourself and changes no figure; tap it again to clear it.
      A line the feed has not shown yet can be added by hand, and the bank’s own charges take it over when they arrive.</p>
    ${ended}
  </section>`;
}

/* ------------------------------------------------------------------- income */

function accrues(stream) {
  return !!stream.accrue && !!stream.active && !!CADENCES[stream.cadence];
}

function streamRow(ctx, m, stream) {
  const kind = STREAM_KINDS[stream.kind] ? STREAM_KINDS[stream.kind].label : 'Other income';
  const regular = !!CADENCES[stream.cadence];
  const account = accountName(ctx, stream.accountId);
  const daily = regular ? Math.round(stream.amount / CADENCES[stream.cadence].days) : 0;
  const counted = ctx.d.position.smoothing && accrues(stream);
  return html`<li data-key="${stream.id}"><button class="row" type="button" data-action="book.open" data-sheet="stream" data-id="${stream.id}">
    <span class="row-label">${stream.name || 'Unnamed stream'}
      <em class="row-note">${kind} · ${regular ? cadenceText(stream.cadence) : 'irregular'}${stream.anchor ? ' · last deposit ' + fmtDate(stream.anchor, 'dowshort') : ''}${account ? ' · ' + account : ''}${stream.active ? '' : ' · not seen lately'}</em>
      <em class="row-note bk-counted">${counted
        ? html`Counted as earned day by day, ${inFig(daily, true)} a day`
        : accrues(stream)
          ? 'Set to count day by day; counted when it arrives while that is switched off in Settings'
          : 'Counted when it arrives'}</em>
    </span>
    <span class="row-value fig est"><span class="approx">≈</span>${fmt(stream.amount)}</span>
  </button></li>`;
}

function countingPassage(ctx, m) {
  const position = ctx.d.position;
  const streams = ctx.state.streams;
  const settingOn = !!ctx.state.settings.smoothing;
  if (position.smoothing && position.receivables.length) {
    const main = position.receivables[0];
    const earliest = position.receivables.reduce((day, item) => (item.since < day ? item.since : day), main.since);
    const payDaily = position.receivables.reduce((n, item) => n + item.daily, 0);
    const billDaily = position.payables.reduce((n, item) => n + item.daily, 0);
    const others = streams.filter((stream) => stream.active && !accrues(stream)).length;
    return html`<p class="title title-s title-i">Pay is counted as it is earned.</p>
      <div class="prose bk-prose">
        <p>${position.receivables.length === 1 ? html`${main.name} is` : html`${plural(position.receivables.length, 'stream')} are`} counted day by day: ${inFig(Math.round(payDaily), true)} is added to net worth each day,
          so the figure rises a little daily and does not jump on payday. ${inFig(Math.round(position.receivable), true)} has been earned since ${position.receivables.length === 1 ? fmtDate(main.since, 'dowshort') : html`each one’s last deposit, the earliest on ${fmtDate(earliest, 'dowshort')},`} and not yet received;
          the live figure carries it in italics until the deposit lands.</p>
        <p>Bills are counted the same way, as they are used: ${inFig(Math.round(billDaily), true)} a day comes off, so rent day is not a fall.
          ${others ? html`The other ${plural(others, 'stream')} ${others === 1 ? 'is' : 'are'} counted on the day ${others === 1 ? 'it arrives' : 'they arrive'}.` : ''}
          Net worth at the bank is never changed by this.</p>
      </div>`;
  }
  if (!settingOn) {
    return html`<p class="title title-s title-i">${streams.some(accrues) ? 'Pay is counted when it arrives.' : 'Shown as the bank reports it.'}</p>
      <div class="prose bk-prose">
        <p>Counting pay as it is earned is switched off, so nothing accrues: net worth is shown exactly as the bank reports it.
          It rises on the day a deposit arrives and falls on the day a bill is charged${streams.some(accrues) ? html`, even for the ${plural(streams.filter(accrues).length, 'stream')} set to count day by day` : ''}.</p>
        <p><a class="btn-link" href="#/settings">Settings</a></p>
      </div>`;
  }
  // regular pay switched off by hand on its own sheet is still regular pay: it is counted when it arrives
  const lockedOff = streams.filter((stream) => !stream.accrue && (stream.locks || []).includes('accrue') && !!CADENCES[stream.cadence]);
  return html`<p class="title title-s title-i">${streams.some((stream) => stream.active && !!CADENCES[stream.cadence]) ? 'Pay is counted when it arrives.' : 'Shown as the bank reports it.'}</p>
    <div class="prose bk-prose">
      <p>${streams.length
        ? html`None of the ${plural(streams.length, 'stream')} is counted day by day, so net worth is shown exactly as the bank reports it: it rises on the day a deposit arrives and falls on the day a bill is charged.`
        : html`No income stream is known yet, so net worth is shown exactly as the bank reports it: it rises on the day a deposit arrives and falls on the day a bill is charged.`}</p>
      <p>${lockedOff.length
        ? html`Day-by-day counting is switched off by hand on ${plural(lockedOff.length, 'stream')}, ${lockedOff.map((stream) => stream.name || 'an unnamed stream').join(', ')}; its own sheet switches it back on.`
        : html`A regular paycheck is counted day by day once it has been seen 3 times${streams.length ? '; any stream can be switched by hand in its own sheet' : ''}.`}</p>
    </div>`;
}

function incomeBands(ctx, m) {
  const streams = ctx.state.streams.slice().sort((a, b) => Number(accrues(b)) - Number(accrues(a)) || Number(b.active) - Number(a.active) || b.amount - a.amount);
  const lapsed = (Array.isArray(ctx.d.position.lapsedPay) ? ctx.d.position.lapsedPay : []).filter((item) => item && typeof item === 'object');
  return html`<section class="band">
      <div class="sec-head">
        <h2 class="lab"><b>Income</b><i class="sep"></i>${streams.length ? plural(streams.length, 'stream') : 'streams'}</h2>
        <span class="lab">typical deposit</span>
      </div>
      ${streams.length
        ? html`<ul class="rows bk-streams">${streams.map((stream) => streamRow(ctx, m, stream))}</ul>
          ${lapsed.map((item) => html`<p class="cap bk-foot" data-key="${'lapsed-' + item.id}">No deposit from ${item.name || 'a regular payer'} since ${isYmd(item.since) ? fmtDate(item.since, 'short') : 'a day not on record'}; ${(streams.find((s) => s && s.id === item.id) || {}).accrue === false ? 'it no longer sets the payday' : 'it no longer sets the payday or counts as earned'}.</p>`)}
          <p class="cap bk-foot">A stream is a payer seen at least twice. Each deposit shown is the typical amount, in italics: not a figure the bank has reported for the next one.</p>`
        : html`<p class="cap bk-quiet">No pay has been found in ${historyPhrase(ctx)}. A payer is listed after its second deposit, and a paycheck is recognized after its third.</p>`}
    </section>
    <section class="band bk-counting">
      <div class="sec-head"><h2 class="lab"><b>How pay is counted</b><i class="sep"></i>smoothing</h2><span class="lab">${ctx.d.position.smoothing ? 'on' : 'off'}</span></div>
      ${countingPassage(ctx, m)}
    </section>`;
}

/* ------------------------------------------------------------------- render */

export function render(ctx) {
  const m = bookModel(ctx);
  // With nothing upcoming the long table is absent, so the page is set in two even columns instead.
  const listed = m.upcoming.length > 0;
  return html`<div class="bk">
    ${totalsBand(ctx, m)}
    <div class="cols">
      <div class="${listed ? 'col col-7' : 'col col-6'}">
        ${upcomingSection(ctx, m)}
        ${listed ? '' : html`${paydayBand(ctx, m)}${renewalsBand(ctx, m)}`}
      </div>
      <div class="${listed ? 'col col-5' : 'col col-6'}">
        ${listed ? html`${paydayBand(ctx, m)}${renewalsBand(ctx, m)}` : ''}
        ${incomeBands(ctx, m)}
      </div>
    </div>
    ${linesBand(ctx, m)}
  </div>`;
}

/* ------------------------------------------------------------------ actions */

function clearFormErrors() {
  if (store.ui.recurringForm) store.setUi({ recurringForm: null });
}

export const actions = {
  /** Keep, review or cut: saved on tap and locked; a second tap on the same choice clears it. */
  'book.verdict': ({ data }) => {
    const { id, verdict } = data;
    if (!VERDICTS.some(([key]) => key === verdict)) return;
    store.update((s) => {
      const rec = s.recurring.find((entry) => entry.id === id);
      if (!rec) return;
      rec.verdict = rec.verdict === verdict ? null : verdict;
      if (!Array.isArray(rec.locks)) rec.locks = [];
      if (!rec.locks.includes('verdict')) rec.locks.push('verdict');
    });
  },
  /** Open the sheet of an entry or a stream. */
  'book.open': ({ data }) => {
    if (!data.id || (data.sheet !== 'recurring' && data.sheet !== 'stream')) return;
    clearFormErrors();
    openSheet(data.sheet, { id: data.id });
  },
  /** Open the entry sheet empty, to add a line the feed has not shown yet. */
  'book.add': () => {
    clearFormErrors();
    openSheet('recurring');
  },
};
