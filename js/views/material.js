/**
 * Material — what the owner owns and owes, set like a statement in a printed report.
 *
 *   head         net worth at the bank and smoothed, side by side, over the assets | liabilities split bar
 *   statement    assets by how fast they turn into money (now · in days · slow) beside liabilities
 *                (cards · loans · other · bills used, not yet charged); every row opens the account sheet
 *   reckoning    how the two net-worth figures are reached, the quick-sale figure, "add what the bank cannot see"
 *   card cycle   the months chart, the table of months, interest per day, the largest charges this month
 *   the record   net worth over the whole record, the owner's revaluations marked
 *
 * The typographic law holds throughout: a figure the bank reported is roman with its age; a figure the
 * owner estimated or Networth computed (an amortised loan, accrued pay, accrued bills) is italic with ≈.
 * Balances are signed in the owner's favour in the document; what is owed prints as a positive amount
 * under Liabilities. This view has no actions of its own: rows and buttons use app.sheet.
 */

import { html, cx } from '../ui/dom.js';
import { fmt, fmtSigned, fmtPct, toneBand } from '../model/money.js';
import { fmtDate, fmtMonth, fmtTime, gameDay, diffDays, isYmd, monthOf, parts as ymdParts } from '../model/dates.js';
import { ACCOUNT_TYPES, accountLabel } from '../model/schema.js';
import { largestCharges, firstTransactionDay } from '../model/cards.js';
import { money, movesList, inlineMoney, toneStyle, flowLookups } from './parts.js';

const CARD_MONTHS = 6;
const LARGEST = 3;
const STALE_DAYS = 3;
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

/* ----------------------------------------------------------------- helpers */

function tierOf(account) {
  return ACCOUNT_TYPES[account.type].tier || 'slow';
}

function groupOf(account) {
  return ACCOUNT_TYPES[account.type].group;
}

/** A manual debt that Networth works down from its terms between statements (ledger: hasLoanTerms). */
function isAmortised(account) {
  return account.source !== 'bank' && groupOf(account) === 'debt' && !!account.loan && account.loan.payment > 0
    && Number.isFinite(account.apr) && account.apr >= 0;
}

/** Whether an account's figure is an estimate (italic, ≈) rather than a reported fact. */
function isEstimate(ctx, account) {
  if (account.source === 'bank') return false;
  return account.basis !== 'statement' || isWorkedDown(ctx, account);
}

/**
 * Whether an amortised loan's figure has moved off its statement. A balance typed today from a statement
 * is still the statement's figure (roman); from the next day on Networth works it down (italic).
 */
function isWorkedDown(ctx, account) {
  if (!isAmortised(account)) return false;
  if (account.basis !== 'statement') return true;
  let latest = null;
  for (const entry of account.history || []) {
    if (entry && entry.day <= ctx.today && (latest === null || entry.day >= latest.day)) latest = entry;
  }
  return !(latest && latest.day === ctx.today && ctx.d.valueOf(account) === latest.balance);
}

/** 'on' when pay accrues; 'off' when regular pay exists but is counted when it arrives; 'none' when no regular pay is known. */
function payCounting(ctx) {
  if (ctx.d.position.smoothing) return 'on';
  return ctx.state.streams.some((s) => s.active !== false && !!s.cadence && (s.kind === 'salary' || s.accrue || (s.locks || []).includes('accrue'))) ? 'off' : 'none';
}

/** How old a bank figure is, in words: "from 6:12 AM", "from yesterday, 9:40 PM", "3 days old". */
function ageOf(ctx, at) {
  if (!at) return null;
  const age = diffDays(gameDay(at, ctx.state.settings.rolloverHour), ctx.today);
  const time = fmtTime(at).replace(/ /g, '\u00a0'); // "4:00 AM" never breaks before AM
  if (age <= 0) return { text: 'from ' + time, stale: false };
  if (age === 1) return { text: 'from yesterday, ' + time, stale: false };
  return { text: age + ' days old', stale: age >= STALE_DAYS };
}

function ageNote(ctx, at) {
  const age = ageOf(ctx, at);
  if (!age) return null;
  return age.stale ? html`<span class="age is-stale">${age.text}</span>` : age.text;
}

/** The day the latest figure of a manual account was entered. */
function valuedOn(ctx, account) {
  let latest = null;
  for (const entry of account.history || []) {
    if (entry && entry.day <= ctx.today && (latest === null || entry.day >= latest)) latest = entry.day;
  }
  if (latest) return latest;
  return account.asOf ? gameDay(account.asOf, ctx.state.settings.rolloverHour) : null;
}

function shortDay(ctx, day) {
  if (!day) return '';
  return ymdParts(day).y === ymdParts(ctx.today).y ? fmtDate(day, 'short') : fmtDate(day, 'medium');
}

/** Pieces of a quiet second line, separated by middle dots. Empty pieces are dropped. */
function dotted(pieces) {
  return pieces.filter(Boolean).map((piece, i) => html`${i ? ' · ' : ''}${piece}`);
}

function count(n, one, many) {
  return (n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n)) + ' ' + (n === 1 ? one : many);
}

function countLower(n, one, many) {
  const text = count(n, one, many);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function figcap(n, text) {
  return html`<figcaption class="cap mat-figcap"><span class="lab"><b>Fig. ${n}</b></span> ${text}</figcaption>`;
}

/* ------------------------------------------------------------------- model */

function read(ctx) {
  const d = ctx.d;
  const position = d.position;
  const assets = d.accounts('asset');
  const debts = d.accounts('debt');
  const slow = assets.filter((a) => tierOf(a) === 'slow');
  let haircut = 0;
  const shared = [];
  for (const account of slow) {
    const value = d.valueOf(account);
    if (value > 0 && Number.isFinite(account.quickSale) && account.quickSale >= 0 && account.quickSale < 1) {
      haircut += Math.round(value * (1 - account.quickSale));
      shared.push(account);
    }
  }
  const cards = d.accounts('card');
  const cash = d.accounts('cash');
  const receivable = Math.round(position.receivable);
  const provisionalCents = Math.round(position.provisional || 0);
  // one live figure on every screen: floored to the cent it has reached, as the Board's ticking hero shows it
  const liveCents = Number.isFinite(position.live) ? Math.floor(position.live) : null;
  // the statement has to add up to that cent, so what is used and not yet charged takes the remainder
  const payable = position.smoothing && liveCents != null
    ? Math.round(position.bank) + receivable - provisionalCents - liveCents
    : Math.round(position.payable);
  const months = cards.length ? d.cardMonths(CARD_MONTHS) : [];
  const provisional = provisionalCents;
  const smooth = position.smoothing ? Math.round(position.bank) + receivable - payable : Math.round(position.bank);
  return {
    position,
    cash,
    days: assets.filter((a) => tierOf(a) === 'days'),
    slow,
    cards,
    loans: debts.filter((a) => a.type === 'loan'),
    otherDebts: debts.filter((a) => a.type !== 'loan'),
    // an account standing on the other side of zero is listed where its figure counts, so each column adds up
    credits: cards.concat(debts).filter((a) => d.valueOf(a) > 0),
    overdrawn: cash.concat(assets).filter((a) => d.valueOf(a) < 0),
    hidden: ctx.state.accounts.filter((a) => a.hidden),
    manualCount: ctx.state.accounts.filter((a) => a.source !== 'bank').length,
    haircut,
    shared,
    quickNet: position.bank - haircut,
    months,
    receivable,
    payable,
    provisional,
    estAssets: cash.concat(assets, cards, debts).some((a) => d.valueOf(a) > 0 && isEstimate(ctx, a)),
    estDebts: cash.concat(assets, cards, debts).some((a) => d.valueOf(a) < 0 && isEstimate(ctx, a)),
    // the engine carries fractions of a cent; a statement has to add up, so the smoothed figure printed
    // here is the bank figure plus and minus the two accruals as printed
    smooth,
    // the Board's live figure: the smoothed one less what was tapped in and is not yet at the bank
    live: smooth - provisional,
  };
}

/* -------------------------------------------------------------------- head */

function head(ctx, m) {
  const p = m.position;
  const covered = ctx.state.settings.cover;
  const age = ageNote(ctx, p.dataAt);
  const pay = payCounting(ctx);
  // ledger: an accruing stream with no deposit for more than 1.6 periods has lapsed and is no longer counted
  const lapsed = (Array.isArray(p.lapsedPay) ? p.lapsedPay : []).filter((item) => item && typeof item === 'object');
  const bankEst = m.estAssets || m.estDebts;
  const liveEst = bankEst || p.smoothing || m.provisional > 0;
  const tapped = m.provisional > 0 ? html`<span data-fig>${fmtSigned(-m.provisional)}</span> tapped in, not yet at the bank` : null;
  const same = tapped ? html`this is the bank figure with ${tapped}.` : 'this equals the bank figure.';
  const smoothNote = p.smoothing
    ? html`the bank figure, with pay earned ${inlineMoney(m.receivable, { est: true, signed: true })}${tapped ? ',' : ' and'} bills used ${inlineMoney(-m.payable, { est: true, signed: true })}${tapped ? html` and ${tapped}` : ''}`
    : lapsed.length
      // T4: a stream whose deposits stopped is named below; "counted when it arrives" is said only when none has
      ? html`Nothing accrues, so ${same}`
      : pay === 'off'
      ? html`Pay is counted when it arrives, so nothing accrues and ${same}`
      : html`No regular pay has been found yet, so nothing accrues and ${same}`;
  const figure = (cents, est) => {
    const text = fmt(cents);
    return html`<span class="${est ? 'fig est mat-worth-fig' : 'fig mat-worth-fig'}" data-tone="${toneBand(cents)}" style="${'--n:' + (text.length + (est ? 1 : 0)) + ';' + toneStyle(cents)}">${est ? html`<span class="approx">≈</span>` : ''}${text}</span>`;
  };
  const slowTotal = m.slow.reduce((n, a) => n + Math.max(0, ctx.d.valueOf(a)), 0);
  const slowShare = p.assets > 0 ? slowTotal / p.assets : 0;
  const splitNote = p.assets === 0 && p.liabilities === 0
    ? 'Nothing is on the record yet: the bar stands level until the bank reports a balance.'
    : html`${p.bank >= 0 ? 'Net worth is the white past the center mark.' : 'The black runs past the center mark: more is owed than owned.'}${
      slowTotal > 0 ? html` ${fmtPct(slowShare, 0)} of the assets is slow to sell, at your own estimate.` : ' None of the assets is slow to sell.'}`;
  return html`<div class="cols mat-head">
    <section class="col col-7">
      <div class="sec-head">
        <h2 class="lab"><b>Net worth</b><i class="sep"></i>two ways</h2>
        <span class="lab">${fmtDate(ctx.today, 'full')}</span>
      </div>
      <div class="mat-worth">
        <p class="mat-worth-item">
          <span class="lab"><i class="bank-mark"></i><b>At the bank</b></span>
          ${figure(p.bank, bankEst)}
          <span class="cap">the plain sum of every balance${m.manualCount ? ', ' + countLower(m.manualCount, 'figure', 'figures') + ' entered by hand included' : ''}${age ? html` · bank data ${age}` : ''}</span>
        </p>
        <p class="mat-worth-item">
          <span class="lab"><b>Smoothed</b></span>
          ${figure(m.live, liveEst)}
          <span class="cap">${smoothNote}${p.smoothing && lapsed.length ? '.' : ''}${lapsed.map((item) => html` No deposit from ${item.name || 'a regular payer'} since ${isYmd(item.since) ? shortDay(ctx, item.since) : 'a day not on record'}.`)}</span>
        </p>
      </div>
    </section>
    <section class="col col-5">
      <div class="sec-head">
        <h2 class="lab"><b>Material</b><i class="sep"></i>owned against owed</h2>
      </div>
      <figure class="split mat-split">
        <figcaption class="split-labs">
          <span><span class="lab"><b>Assets</b></span>${money(p.assets, { est: m.estAssets })}</span>
          <span>${money(p.liabilities, { est: m.estDebts })}<span class="lab"><b>Liabilities</b></span></span>
        </figcaption>
        <nw-split data-island a="${p.assets}" b="${p.liabilities}" mark="centre"
          label="${covered ? 'Assets against liabilities' : 'Assets ' + fmt(p.assets) + ' against liabilities ' + fmt(p.liabilities)}"></nw-split>
        <p class="cap split-note">${splitNote}</p>
      </figure>
    </section>
  </div>`;
}

/* --------------------------------------------------------------- statement */

/** One account as a row that opens its sheet. `owed` prints the amount owed as a positive figure. */
function accountRow(ctx, account, opts = {}) {
  const value = ctx.d.valueOf(account);
  const est = isEstimate(ctx, account);
  const shown = Math.max(0, opts.owed ? -value : value);
  const label = accountLabel(account);
  return html`<li data-key="${account.id}">
    <button class="row" type="button" data-action="app.sheet" data-sheet="account" data-id="${account.id}">
      <span class="row-label">${label} <em class="row-note">${dotted(opts.notes || [])}</em></span>
      ${money(shown, { est, cls: 'row-value' })}
    </button>
  </li>`;
}

/** The provenance pieces every row starts with: who holds it and how old or how sure the figure is. */
function provenance(ctx, account) {
  if (account.source === 'bank') return [account.institution, ageNote(ctx, account.asOf)];
  const day = shortDay(ctx, valuedOn(ctx, account));
  if (isWorkedDown(ctx, account)) {
    return [account.institution, html`worked down from the ${day} ${account.basis === 'statement' ? 'statement' : 'figure'} at ${trimPct(account.apr)}%`];
  }
  return [account.institution, (account.basis === 'statement' ? 'from a statement, ' : 'your estimate, ') + day];
}

function trimPct(apr) {
  return String(Math.round(apr * 100) / 100);
}

function cashRow(ctx, account) {
  const value = ctx.d.valueOf(account);
  const notes = provenance(ctx, account);
  if (account.source === 'bank' && value !== account.balance) notes.push('pending moves counted');
  if (account.reserve) notes.push('reserve');
  if (value < 0) notes.push('overdrawn: listed with liabilities');
  return accountRow(ctx, account, { notes });
}

function assetRow(ctx, account) {
  const value = ctx.d.valueOf(account);
  const notes = provenance(ctx, account);
  if (value < 0) notes.push('below zero: listed with liabilities');
  if (tierOf(account) === 'slow') {
    if (Number.isFinite(account.quickSale) && value > 0) {
      notes.push(html`a quick sale at ${fmtPct(account.quickSale, 0)}: <span data-fig>≈ ${fmt(Math.round(value * account.quickSale))}</span>`);
    } else if (value > 0) {
      notes.push('no quick-sale share set');
    }
  }
  return accountRow(ctx, account, { notes });
}

function cardRow(ctx, account) {
  const value = ctx.d.valueOf(account);
  const owed = Math.max(0, -value);
  const notes = provenance(ctx, account);
  if (Number.isFinite(account.apr)) notes.push(trimPct(account.apr) + '% APR');
  if (account.limit > 0) notes.push(html`${fmtPct(owed / account.limit, 0)} of the <span data-fig>${fmt(account.limit, { decimals: 0 })}</span> limit`);
  if (value > 0) notes.push('in credit: listed with assets');
  return accountRow(ctx, account, { notes, owed: true });
}

function debtRow(ctx, account) {
  const notes = provenance(ctx, account);
  if (!isWorkedDown(ctx, account) && Number.isFinite(account.apr)) notes.push(trimPct(account.apr) + '% APR');
  if (ctx.d.valueOf(account) > 0) notes.push('in credit: listed with assets');
  return accountRow(ctx, account, { notes, owed: true });
}

/** A card or loan the lender owes money back on: its credit balance, on the assets side. */
function creditRow(ctx, account) {
  const notes = provenance(ctx, account);
  notes.push(groupOf(account) === 'card' ? 'a credit balance on the card' : 'a credit balance with the lender');
  return accountRow(ctx, account, { notes });
}

/** A cash or asset account below zero: what it is short by, on the liabilities side. */
function overdrawnRow(ctx, account) {
  const notes = provenance(ctx, account);
  notes.push(groupOf(account) === 'cash' ? 'overdrawn' : 'below zero');
  return accountRow(ctx, account, { notes, owed: true });
}

/** An accrual line: pay earned (opens the stream) or a bill used (opens the Book entry). Always an estimate. */
function accrualRow(ctx, line, sheet, lead) {
  return html`<li data-key="${sheet + '-' + line.id}">
    <button class="row" type="button" data-action="app.sheet" data-sheet="${sheet}" data-id="${line.id}">
      <span class="row-label">${lead ? html`<span class="est">${lead}</span>` : line.name} <em class="row-note">${dotted([lead ? line.name : null, 'since ' + shortDay(ctx, line.since), html`<span data-fig>${fmt(line.daily)}</span> a day`, lead ? 'in the smoothed figure only' : null])}</em></span>
      ${money(line.amount, { est: true, cls: 'row-value' })}
    </button>
  </li>`;
}

function group(title, note, rows, total, empty) {
  return html`<section class="rows-group mat-group">
    <h3 class="rows-title lab"><b>${title}</b> <span class="rows-title-note">${note}</span></h3>
    ${rows.length ? html`<ul class="rows">${rows}</ul>` : html`<p class="cap mat-none">${empty}</p>`}
    ${total || ''}
  </section>`;
}

/** A group's subtotal, shown only when the group has more than one account; italic when any part of it is an estimate. */
function subtotal(ctx, label, cents, accounts) {
  if (accounts.length < 2) return '';
  return html`<p class="row row-total mat-sub"><span class="row-label lab"><b>${label}</b></span>${money(cents, { est: accounts.some((a) => isEstimate(ctx, a)), cls: 'row-value' })}</p>`;
}

/** The part of a side's total that is not the bank's own figure, as a disclosure under the total. */
function byHandNote(ctx, accounts, owed) {
  const part = accounts.filter((a) => isEstimate(ctx, a)).reduce((n, a) => n + Math.max(0, owed ? -ctx.d.valueOf(a) : ctx.d.valueOf(a)), 0);
  if (!part) return 'every figure from the bank or a statement';
  if (!owed) return html`<span data-fig>${fmt(part)}</span> of it at your own estimate`;
  const worked = accounts.filter((a) => isWorkedDown(ctx, a)).length;
  const guessed = accounts.filter((a) => isEstimate(ctx, a) && !isWorkedDown(ctx, a)).length;
  return html`<span data-fig>${fmt(part)}</span> of it ${worked && guessed ? 'worked down by Networth or at your estimate' : worked ? 'worked down by Networth' : 'at your own estimate'}`;
}

function grand(label, cents, note, est) {
  return html`<p class="row mat-grand"><span class="row-label lab"><b>${label}</b>${note ? html` <span class="rows-title-note">${note}</span>` : ''}</span>${money(cents, { est, cls: 'row-value' })}</p>`;
}

function assetsColumn(ctx, m) {
  const p = m.position;
  const sum = (list) => list.reduce((n, a) => n + Math.max(0, ctx.d.valueOf(a)), 0);
  const inDays = m.days.concat(m.credits);
  const dayRows = m.days.map((a) => assetRow(ctx, a))
    .concat(m.credits.map((a) => creditRow(ctx, a)))
    .concat(p.receivables.map((line) => accrualRow(ctx, line, 'stream', 'Pay earned, not yet received')));
  return html`<section class="col col-6 mat-side">
    <div class="sec-head">
      <h2 class="lab"><b>Assets</b><i class="sep"></i>by how fast they turn into money</h2>
    </div>
    <div class="mat-groups">
      ${group('Now', 'cash · ' + countLower(m.cash.length, 'account', 'accounts'), m.cash.map((a) => cashRow(ctx, a)),
        subtotal(ctx, 'Cash', sum(m.cash), m.cash),
        'The bank has reported no cash account yet. Cash appears here as soon as it does.')}
      ${group('In days', 'investments, money owed to you, pay on its way', dayRows,
        subtotal(ctx, 'In days, on the record', sum(inDays), inDays),
        p.smoothing
          ? 'No investments and nothing owed to you is on the record.'
          : payCounting(ctx) === 'off'
            ? 'Nothing here yet. Investments the bank reports appear by themselves. Pay is counted when it arrives, so no pay earned is listed.'
            : 'Nothing here yet. Investments the bank reports appear by themselves; pay is counted day by day once a regular deposit has been seen 3 times.')}
      ${group('Slow', 'equipment and the like', m.slow.map((a) => assetRow(ctx, a)),
        subtotal(ctx, 'Slow', sum(m.slow), m.slow),
        'The bank cannot see equipment or a vehicle. Added by hand, each is counted here at your own figure.')}
    </div>
    ${grand('Total assets', p.assets, byHandNote(ctx, m.cash.concat(inDays, m.slow), false), m.estAssets)}
  </section>`;
}

function liabilitiesColumn(ctx, m) {
  const p = m.position;
  const owedSum = (list) => list.reduce((n, a) => n + Math.max(0, -ctx.d.valueOf(a)), 0);
  const cardsNow = m.cards.length ? ctx.d.cardsNow : null;
  const used = cardsNow && cardsNow.utilisation != null
    ? html` · ${fmtPct(cardsNow.utilisation, 0)} of the limits used`
    : '';
  const bills = p.payables;
  const others = m.otherDebts.concat(m.overdrawn);
  const otherRows = m.otherDebts.map((a) => debtRow(ctx, a)).concat(m.overdrawn.map((a) => overdrawnRow(ctx, a)));
  return html`<section class="col col-6 mat-side">
    <div class="sec-head">
      <h2 class="lab"><b>Liabilities</b><i class="sep"></i>what is owed</h2>
    </div>
    <div class="mat-groups">
      ${group('Cards', html`revolving${used}`, m.cards.map((a) => cardRow(ctx, a)),
        subtotal(ctx, 'Cards', owedSum(m.cards), m.cards),
        'No card is on the record.')}
      ${group('Loans', 'italic when worked down by Networth', m.loans.map((a) => debtRow(ctx, a)),
        subtotal(ctx, 'Loans', owedSum(m.loans), m.loans),
        'No loan is on the record. One the bank feed does not carry can be added by hand, with its terms.')}
      ${others.length ? group('Other', 'owed elsewhere', otherRows, subtotal(ctx, 'Other', owedSum(others), others), '') : ''}
      <section class="rows-group mat-group">
        <h3 class="rows-title lab"><b>Not yet charged</b> <span class="rows-title-note">in the smoothed figure only</span></h3>
        ${bills.length ? html`<details class="mat-more">
          <summary class="row">
            <span class="row-label"><span class="est">Bills used, not yet charged</span> <em class="row-note">${countLower(bills.length, 'bill', 'bills')}, counted day by day since each was last charged</em></span>
            ${money(m.payable, { est: true, cls: 'row-value' })}
          </summary>
          <ul class="rows rows-plain mat-more-rows">${bills.map((line) => accrualRow(ctx, line, 'recurring', ''))}</ul>
        </details>` : html`<p class="cap mat-none">${p.smoothing
          ? 'No bill is accruing today.'
          : payCounting(ctx) === 'off'
            ? 'Nothing accrues: pay is counted when it arrives, and each bill on the day it is charged.'
            : 'Nothing accrues yet. Bills are counted day by day once the Book and a regular pay day have been found.'}</p>`}
      </section>
    </div>
    ${grand('Total liabilities', p.liabilities, byHandNote(ctx, m.cards.concat(m.loans, others), true), m.estDebts)}
  </section>`;
}

/* --------------------------------------------------------------- reckoning */

function reckoning(ctx, m) {
  const p = m.position;
  const bankEst = m.estAssets || m.estDebts;
  const tappedRow = m.provisional > 0
    ? html`<li class="row"><span class="row-label"><span class="est">Tapped in, not yet at the bank</span></span>${money(-m.provisional, { est: true, signed: true, cls: 'row-value' })}</li>`
    : '';
  const names = m.shared.map((a) => accountLabel(a) + ' at ' + fmtPct(a.quickSale, 0)).join(', ');
  const unshared = m.slow.filter((a) => !m.shared.includes(a) && ctx.d.valueOf(a) > 0);
  let quick;
  if (!m.slow.length) {
    quick = html`<p class="cap">Nothing slow to sell is on the record, so a fast sale would change nothing: ${money(p.bank, { est: bankEst })}.</p>`;
  } else if (!m.shared.length) {
    quick = html`<p class="cap">No quick-sale share is set on ${unshared.map((a) => accountLabel(a)).join(', ') || 'the slow assets'}, so a fast sale is counted at full value: ${money(p.bank, { est: bankEst })}. A share can be set on each asset.</p>`;
  } else {
    quick = html`<p class="mat-quick"><span class="fig est mat-quick-fig"><span class="approx">≈</span>${fmt(m.quickNet)}</span></p>
      <p class="cap">Net worth at the bank, less <span data-fig>${fmt(m.haircut)}</span> that a fast sale would not raise: ${names}.${
        unshared.length ? ' ' + unshared.map((a) => accountLabel(a)).join(', ') + ' has no share set and is counted in full.' : ''}</p>`;
  }
  return html`<div class="cols mat-reckon">
    <section class="col col-7">
      <div class="sec-head">
        <h2 class="lab"><b>The reckoning</b><i class="sep"></i>how the two figures are reached</h2>
      </div>
      <ul class="rows rows-plain mat-sum">
        <li class="row"><span class="row-label">Assets</span>${money(p.assets, { est: m.estAssets, cls: 'row-value' })}</li>
        <li class="row"><span class="row-label">Liabilities</span>${money(-p.liabilities, { est: m.estDebts, cls: 'row-value' })}</li>
      </ul>
      <p class="row row-total"><span class="row-label lab"><i class="bank-mark"></i><b>Net worth at the bank</b></span>${money(p.bank, { est: bankEst, cls: 'row-value' })}</p>
      ${p.smoothing ? html`<ul class="rows rows-plain mat-sum">
        <li class="row"><span class="row-label"><span class="est">Pay earned, not yet received</span></span>${money(m.receivable, { est: true, signed: true, cls: 'row-value' })}</li>
        <li class="row"><span class="row-label"><span class="est">Bills used, not yet charged</span></span>${money(-m.payable, { est: true, signed: true, cls: 'row-value' })}</li>
        ${tappedRow}
      </ul>
      <p class="row row-total"><span class="row-label lab"><b>Smoothed net worth</b></span>${money(m.live, { est: true, cls: 'row-value' })}</p>` : html`${m.provisional > 0 ? html`<ul class="rows rows-plain mat-sum">${tappedRow}</ul>
      <p class="row row-total"><span class="row-label lab"><b>Net worth, tapped-in moves counted</b></span>${money(m.live, { est: true, cls: 'row-value' })}</p>` : ''}
      <p class="cap mat-none">${
        payCounting(ctx) === 'off'
          ? html`Pay is counted when it arrives, so nothing accrues${m.provisional > 0 ? '' : html` and the smoothed figure is the same, ${money(m.live, { est: bankEst })}`}. Day-by-day counting is switched in Settings or on a stream’s own sheet.`
          : html`The smoothed figure is the same for now${m.provisional > 0 ? ' but for what was tapped in' : html`, ${money(m.live, { est: bankEst })}`}: pay is counted as it is earned once a regular deposit has been seen 3 times.`}</p>`}
    </section>
    <section class="col col-5">
      <div class="sec-head">
        <h2 class="lab"><b>Sold fast</b><i class="sep"></i>if everything slow had to go</h2>
      </div>
      ${quick}
      <div class="mat-add">
        <p class="cap">${m.manualCount
          ? countPhrase(m.manualCount) + ' entered by hand. Equipment, a vehicle, money owed to you, a loan: each is counted at the figure you give.'
          : 'Equipment, a vehicle, money owed to you, a loan the feed does not carry: each can be counted at the figure you give. Nothing here needs it.'}</p>
        <p><button class="btn btn-fill" type="button" data-action="app.sheet" data-sheet="account"><span class="plus">+</span> Add what the bank cannot see</button></p>
      </div>
      ${m.hidden.length ? html`<p class="cap mat-left">Left out of everything: ${m.hidden.map((a, i) => html`${i ? ', ' : ''}<button class="mat-inline" type="button" data-action="app.sheet" data-sheet="account" data-id="${a.id}">${accountLabel(a)}</button>`)}.</p>` : ''}
    </section>
  </div>`;
}

function countPhrase(n) {
  return n === 1 ? 'One item is' : count(n, 'item', 'items') + ' are';
}

/* -------------------------------------------------------------- card cycle */

function monthName(ym, first) {
  const name = fmtMonth(ym, 'short');
  const year = name.slice(-4);
  const showYear = first || ym.slice(5, 7) === '01';
  return html`${name.slice(0, -5)}${showYear ? html`<span class="not-phone"> ${year}</span>` : ''}`;
}

function cycleTable(ctx, months) {
  const first = months[0];
  const last = months[months.length - 1];
  const total = (pick) => months.reduce((n, mo) => n + pick(mo), 0);
  const refunds = total((mo) => mo.refunds);
  const rows = months.map((mo, i) => html`<tr data-key="${mo.ym}" class="${cx(mo.current && 'is-current')}">
      <th scope="row">${monthName(mo.ym, i === 0)}${mo.current ? html` <em class="mat-sofar">so far</em>` : ''}</th>
      <td class="num not-phone">${mo.complete ? fmt(mo.start) : '—'}</td>
      <td class="num">${fmt(mo.charges)}</td>
      <td class="num">${fmt(mo.payments)}</td>
      <td class="num not-phone">${fmt(mo.interest)}</td>
      <td class="num">${fmt(mo.end)}</td>
      <td class="num">${mo.complete ? fmtSigned(mo.change) : '—'}</td>
    </tr>`);
  return html`<div class="mat-cycle-wrap" role="region" aria-label="Card months" tabindex="0"><table class="table mat-cycle">
    <caption class="vh">Card months: what was owed at the start, charges, payments, interest and fees, what was owed at the end, and the change</caption>
    <thead><tr>
      <th scope="col">Month</th>
      <th scope="col" class="num not-phone">Began</th>
      <th scope="col" class="num">Charges</th>
      <th scope="col" class="num">Payments</th>
      <th scope="col" class="num not-phone">Interest <span class="mat-amp">&amp;</span> fees</th>
      <th scope="col" class="num">Ended</th>
      <th scope="col" class="num">Change</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    ${months.length > 1 ? html`<tfoot><tr>
      <th scope="row"><span class="only-phone">Total</span><span class="not-phone">${count(months.length, 'month', 'months')}</span></th>
      <td class="num not-phone">${first.complete ? fmt(first.start) : '—'}</td>
      <td class="num">${fmt(total((mo) => mo.charges))}</td>
      <td class="num">${fmt(total((mo) => mo.payments))}</td>
      <td class="num not-phone">${fmt(total((mo) => mo.interest))}</td>
      <td class="num">${fmt(last.end)}</td>
      <td class="num">${first.complete ? fmtSigned(last.end - first.start) : '—'}</td>
    </tr></tfoot>` : ''}
  </table></div>
  <p class="cap mat-cycle-note">Interest and fees are part of the charges: <span data-fig>${fmt(total((mo) => mo.interest))}</span> over ${countLower(months.length, 'month', 'months')}.${
    refunds > 0 ? html` Refunds of <span data-fig>${fmt(refunds)}</span> also lowered what is owed.` : ''}${
    months.length < CARD_MONTHS ? ' Earlier months appear as the bank feed reaches further back.' : ''}</p>`;
}

function paceLine(current) {
  if (!current) return '';
  const month = fmtMonth(current.ym, 'name');
  // a card in credit owes nothing: the credit is the bank's own figure, and there is no pace to read
  if (current.credit > 0 && current.end === 0) {
    return html`<p class="mat-pace">In credit by <span class="fig" data-fig>${fmt(current.credit)}</span>: nothing is owed on a card.</p>
    <p class="cap">${month} has no pace to read while nothing is owed. A month is judged when it ends, never move by move.</p>`;
  }
  // no pace is read before day 7 of the month (R3a): the model leaves pace and projected null until then
  if (current.pace == null) {
    return html`<p class="cap">A pace is read from day 7 of the month.${current.daysElapsed ? html` ${month} is at day ${current.daysElapsed} of ${current.daysInMonth}.` : ''}</p>`;
  }
  const pace = Math.round(current.pace);
  // the pace already takes off the Book's payments to the card that are still to come this month
  const after = current.scheduled > 0 ? html`, after <span class="fig est" data-fig><span class="approx">≈</span>${fmt(current.scheduled)}</span> of payments still scheduled in the Book` : '';
  if (pace === 0) return html`<p class="mat-pace"><span class="est">On pace to end ${month} level with where it began${after}.</span></p>`;
  return html`<p class="mat-pace"><span class="est">On pace to end ${month} <span class="fig est"><span class="approx">≈</span>${fmt(Math.abs(pace))}</span> ${pace < 0 ? 'lower' : 'higher'} than it began${after}.</span></p>
    <p class="cap">Day ${current.daysElapsed} of ${current.daysInMonth}: it began at <span data-fig>${fmt(current.start)}</span> and stands at <span data-fig>${fmt(current.end)}</span>. A month is judged when it ends, never move by move.</p>`;
}

function interestLine(ctx, cardsNow) {
  const owing = cardsNow.cards.filter((card) => card.owed > 0);
  if (!owing.length) return html`<p class="cap">Nothing is owed on a card today, so no interest is running.</p>`;
  if (cardsNow.interestPerDay == null) {
    const missing = owing.filter((card) => card.apr == null);
    return html`<p class="cap">Interest per day is not shown: ${missing.map((card, i) => html`${i ? ', ' : ''}<button class="mat-inline" type="button" data-action="app.sheet" data-sheet="account" data-id="${card.id}">${card.label}</button>`)} ${missing.length === 1 ? 'has' : 'have'} no APR on file. The bank feed never carries it; it takes one number on the card’s sheet.</p>`;
  }
  const perDay = Math.round(cardsNow.interestPerDay);
  return html`<p class="mat-interest"><span class="lab">Interest</span> <span class="fig est"><span class="approx">≈</span>${fmt(perDay)}</span> <span class="cap">a day at today’s balance, about <span data-fig>${fmt(Math.round(cardsNow.interestPerDay * 30), { decimals: 0 })}</span> in thirty days</span></p>`;
}

function cardCycle(ctx, m, figNo) {
  if (!m.cards.length) {
    return html`<section class="band mat-cards">
      <div class="sec-head"><h2 class="lab"><b>Card cycle</b></h2></div>
      <p class="cap mat-none">No card is on the record, so there is no cycle to show. A card the bank reports appears here month by month.</p>
    </section>`;
  }
  const months = m.months;
  const current = months.find((mo) => mo.current) || months[months.length - 1];
  const ym = monthOf(ctx.today);
  const largest = largestCharges(ctx.state, ym, ctx.now, LARGEST);
  const cardsNow = ctx.d.cardsNow;
  const chart = months.map((mo) => ({ ym: mo.ym, start: mo.start, end: mo.end, charges: mo.charges, payments: mo.payments, change: mo.change, current: mo.current }));
  const names = m.cards.length === 1 ? accountLabel(m.cards[0]) : countLower(m.cards.length, 'card', 'cards') + ' together';
  return html`<div class="cols mat-cards">
    <section class="col col-5">
      <div class="sec-head">
        <h2 class="lab"><b>Card cycle</b><i class="sep"></i>month by month</h2>
        <span class="lab">${names}</span>
      </div>
      <figure class="mat-fig">
        <nw-chart data-island kind="months" data="${JSON.stringify({ months: chart })}"></nw-chart>
        ${figcap(figNo, html`Each month: payments, white, against new charges, black, and the change in what is owed.${months.length === 1 ? ' One month is on the record so far.' : ''}`)}
      </figure>
      <div class="mat-now">
        ${paceLine(current)}
        ${interestLine(ctx, cardsNow)}
        <p><a class="btn-link" href="#/analysis">The payoff scenario, in Analysis</a></p>
      </div>
    </section>
    <section class="col col-7">
      <div class="sec-head">
        <h2 class="lab"><b>The months</b><i class="sep"></i>what was owed, in and out</h2>
      </div>
      ${cycleTable(ctx, months)}
      <div class="mat-largest">
        <h3 class="rows-title lab"><b>Largest charges</b> <span class="rows-title-note">${fmtMonth(ym)}</span></h3>
        ${largest.length
          ? movesList(largest, null, { accounts: ctx.d.account, pairs: flowLookups(ctx).pairOf, detail: 'full', label: 'Largest card charges in ' + fmtMonth(ym) })
          : html`<p class="cap mat-none">No charge has reached a card in ${fmtMonth(ym, 'name')} so far.</p>`}
      </div>
    </section>
  </div>`;
}

/* -------------------------------------------------------------- the record */

/** Days on which the owner entered a new figure for a manual account, labelled with the account's name (never an amount). */
function revaluations(ctx, days) {
  const names = new Map();
  for (const account of ctx.state.accounts) {
    if (account.source === 'bank' || account.hidden) continue;
    (account.history || []).forEach((entry, i) => {
      if (i === 0 || !entry) return;
      const list = names.get(entry.day) || [];
      list.push(accountLabel(account));
      names.set(entry.day, list);
    });
  }
  const events = [];
  for (const close of days) {
    if (!close.reval) continue;
    const list = names.get(close.day);
    events.push({ day: close.day, label: list && list.length ? list.join(', ') + ' revalued' : 'Revalued' });
  }
  return events;
}

function record(ctx, m, figNo) {
  const first = firstTransactionDay(ctx.state);
  const from = first && first < ctx.today ? first : ctx.today;
  const days = ctx.d.closes(from, ctx.today);
  const events = revaluations(ctx, days);
  const data = {
    days: days.map((c) => ({ day: c.day, smooth: c.smooth, bank: c.bank, partial: c.partial })),
    events,
    live: m.position.smoothing ? m.live : undefined,
    // the end label is an estimate only when the figure holds one (R4): roman for a record of bank rows alone
    est: Boolean(m.estAssets || m.estDebts || m.position.smoothing || m.provisional > 0),
  };
  const span = days.length;
  // one count of history (R6): the first transaction's day through today, both included
  const onRecord = Number.isFinite(ctx.d.historyDays) ? ctx.d.historyDays : span;
  const caption = span < 2
    ? 'One day is on the record. The line grows a day at a time from here.'
    : html`${m.position.smoothing ? 'Solid: smoothed net worth. Dotted: at the bank, rising on payday and falling when rent is charged.' : 'Net worth at the bank, day by day.'} ${
      events.length ? count(events.length, 'open square marks', 'open squares mark') + ' a figure you revalued.' : 'An open square will mark any figure you revalue.'} ${
      onRecord < 30 ? count(onRecord, 'day is', 'days are') + ' on record so far, ' + fmtDate(from, 'short') + ' through ' + fmtDate(ctx.today, 'short') + '.' : ''}`;
  return html`<section class="band mat-record">
    <div class="sec-head">
      <h2 class="lab"><b>Net worth</b><i class="sep"></i>the whole record</h2>
      <span class="lab">${fmtDate(from, 'medium')} – ${fmtDate(ctx.today, 'medium')}</span>
    </div>
    <figure class="mat-fig">
      <nw-chart data-island kind="worth" data="${JSON.stringify(data)}"></nw-chart>
      ${figcap(figNo, caption)}
    </figure>
  </section>`;
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const m = read(ctx);
  return html`<div class="mat">
    ${head(ctx, m)}
    <div class="cols mat-statement">
      ${assetsColumn(ctx, m)}
      ${liabilitiesColumn(ctx, m)}
    </div>
    ${reckoning(ctx, m)}
    ${cardCycle(ctx, m, 1)}
    ${record(ctx, m, m.cards.length ? 2 : 1)}
  </div>`;
}

export const actions = {};
