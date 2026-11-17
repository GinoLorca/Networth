/**
 * Settings: the bank link, the few things the bank cannot see, appearance, the owner's own rules,
 * the record, and what Networth is. Every control saves the moment it changes; nothing is required.
 *
 * Actions
 *   settings.workday       (change) a weekday chip: adds the day to settings.workdays or takes it out
 *   settings.rollover      (change) the hour the game day rolls over, 0–6
 *   settings.toggle        (change) a switch; data-field = smoothing | countPending | cover
 *   settings.byes          (change) half-point byes allowed per month, 0–4
 *   settings.words         (change) chess | finance: the words of the interface (model/words.js), at once, with no
 *                          reload; stamped for the shared file (model/prefs.js chooseWords). "See every term" opens
 *                          the glossary sheet (sheet=words)
 *   settings.theme         (change) auto | paper | night: saves it, sets data-theme on <html> at once and
 *                          writes localStorage['networth.theme'] (not in the sample game, which keeps nothing)
 *   settings.line          (change) one line of the principles or of the "instead" choices (data-list, data-i):
 *                          edits it, removes it when cleared (with Undo), or adds it from the last, empty line
 *   settings.purpose       (change) renames a purpose tag (data-purpose); cleared = its default name
 *   settings.link          (submit) links the bank again with a new setup token (the field is cleared at once)
 *   settings.ask           (click)  first step of a dangerous action: shows its confirmation in place
 *                          (data-what = unlink | unlink-erase | erase)
 *   settings.cancel        (click)  closes any open confirmation, and forgets a picked backup file
 *   settings.unlink        (click)  confirmed: forgets the bank key on this device, keeps the record
 *   settings.erase         (click)  confirmed: forgets the bank key and erases the record and its daily snapshots
 *   settings.export        (click)  "Save a copy": downloads the document as JSON (it never holds the bank key)
 *   settings.restore-pick  (change) "Restore a copy": reads the chosen file, checks and migrates it, then asks once
 *   settings.restore       (click)  confirmed: replaces the document with the checked copy
 *   settings.income-payer  (change) how a payer pays (3.7); the toast says what it did, as on the Board
 *   settings.income-again  (click)  Ask again about a payment answered "in the bank"; focus goes to the next Ask again
 *   settings.income-gone-all (click) "Show all": a source's list of payments answered "in the bank", in full
 * The shell's own: app.refresh, app.sheet (an account opens its sheet), app.leave-demo.
 *
 * Ephemeral state (store.ui): settingsConfirm, settingsRestore { name, accounts, moves, savedAt },
 * settingsRestoreError, settingsLinkError, settingsGoneAll (the sources whose "in the bank" list is shown in full).
 */

import { html, cx, attrs } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { navigate, openSheet } from '../router.js';
import { linkBank, unlinkBank } from '../sync.js';
import { startShare, shareNow, forgetShare, shareInfo } from '../share.js';
import { wipeStorage, listSnapshots } from '../db.js';
import { ACCOUNT_TYPES, CADENCES, PURPOSES, SCHEMA_VERSION, accountLabel, accountTypeLabel, checkDoc, migrate, defaultState } from '../model/schema.js';
import { fmt } from '../model/money.js';
import { gameDay, diffDays, fmtDate, fmtTime, nowMs } from '../model/dates.js';
import { emptiedStreams, position } from '../model/ledger.js';
import { makeDerived } from '../derive.js';
import { coverText, inlineMoney } from './parts.js';
import { alertStatus } from '../model/alerts.js';
import { chooseWords } from '../model/prefs.js';
import { WORDS, phrase, say, shareToast, wordsMode, wordsOf } from '../model/words.js';
import { sayHtml } from '../ui/say.js';
import { answerPayer, askAgain, cashAccountOf, isIdleCash, ensureCashAccount, incomeLabel, incomeOf, incomePayments, incomeQuestions, payerAnswer } from '../model/income.js';
import { againWords, beforeCountWords, countedWords, isCountedCash, listedPayers, payerWords, paymentState } from './income-words.js';
import { forgetMadeKey, madeKey, makeNightKey, setWrapLock, turnOffWrap, turnOnWrap } from '../wrap.js';
import { shareMessage } from '../github.js';

const APP_VERSION = '1.0.0';
const BRIDGE_URL = 'https://bridge.simplefin.org';
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const THEME_KEY = 'networth.theme';
const DAY_MS = 24 * 3600 * 1000;
const READINGS_PER_DAY = 20;

/** Weeks run Monday to Sunday, as in the crosstable. */
const WEEK = [[1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'], [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [0, 'Sun', 'Sunday']];
const HOURS = ['12:00 AM', '1:00 AM', '2:00 AM', '3:00 AM', '4:00 AM', '5:00 AM', '6:00 AM'];
const BYES = [0, 1, 2, 3, 4];
const THEMES = [['auto', 'Device'], ['paper', 'Paper'], ['night', 'Night']];
const TOGGLES = ['smoothing', 'countPending', 'cover'];
const LISTS = {
  principles: { one: 'Principle', max: 8, length: 90, add: 'Add a principle' },
  insteads: { one: 'Choice', max: 6, length: 40, add: 'Add a choice' },
};
const PURPOSE_LENGTH = 24;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** A checked, migrated backup waiting for its one confirmation (too large for the interface state). */
let pendingRestore = null;

/* ----------------------------------------------------------------- helpers */

const listOf = (x) => (Array.isArray(x) ? x : []);
const plural = (n, one, many) => Number(n).toLocaleString('en-US') + ' ' + (n === 1 ? one : many);

function waitText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return minutes >= 90 ? Math.round(minutes / 60) + ' h' : minutes + ' min';
}

/** "today at 6:12 AM" · "yesterday at 9:40 PM" · "Jun 3 at 6:12 AM" */
function whenText(ms, ctx) {
  const day = gameDay(ms, ctx.state.settings.rolloverHour);
  const age = diffDays(day, ctx.today);
  const lead = age <= 0 ? 'today' : age === 1 ? 'yesterday' : fmtDate(day, 'short');
  return lead + ' at ' + fmtTime(ms);
}

function applyTheme(choice, remember) {
  try {
    const root = document.documentElement;
    if (choice === 'paper') root.setAttribute('data-theme', 'light');
    else if (choice === 'night') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  } catch { /* no document: nothing to paint */ }
  if (!remember) return;
  try {
    if (choice === 'paper' || choice === 'night') localStorage.setItem(THEME_KEY, choice);
    else localStorage.removeItem(THEME_KEY);
  } catch { /* storage is blocked: the choice still lives in the document */ }
}

/** The in-place confirmation of a dangerous action: the first button stays, a second one appears under it. */
function dangerous(ctx, what, { ask, sentence, go, action }) {
  const open = ctx.ui.settingsConfirm === what;
  return html`<div class="set-danger">
    <button class="btn-link" type="button" data-action="settings.ask" data-what="${what}" aria-expanded="${open ? 'true' : 'false'}">${ask}</button>
    ${open ? html`<div class="set-confirm" role="group" aria-label="${ask}: confirm">
      <p class="cap">${sentence}</p>
      <div class="btn-row">
        <button class="btn btn-solid" type="button" data-action="${action}">${go}</button>
        <button class="btn" type="button" data-action="settings.cancel">Cancel</button>
      </div>
    </div>` : ''}
  </div>`;
}

/* ---------------------------------------------------------------- the bank */

function accountTag(a, words) {
  const type = ACCOUNT_TYPES[a.type] ? accountTypeLabel(a.type, words) : 'Account';
  const more = a.hidden ? 'left out' : a.everyday ? 'everyday' : a.reserve ? phrase('settings.reserve', words) : '';
  return html`<b>${type}</b>${more ? html`<i class="sep"></i>${more}` : ''}`;
}

function accountRows(ctx, accounts) {
  if (!accounts.length) {
    return html`<p class="cap set-none">No account has arrived from the bank yet. They appear here after the first reading, each with its type.</p>`;
  }
  return html`<section class="rows-group">
    <h3 class="rows-title lab"><b>${ctx.demo ? 'Sample accounts' : 'Accounts found'}</b> <span class="rows-title-note" data-cover-keep>${accounts.length}</span></h3>
    <ul class="rows">
      ${accounts.map((a) => html`<li data-key="${a.id}">
        <button class="row set-acct" type="button" data-action="app.sheet" data-sheet="account" data-id="${a.id}">
          <span class="row-label">${accountLabel(a, ctx.words)}${a.institution ? html`<em class="row-note">${a.institution}</em>` : ''}</span>
          <span class="lab set-acct-tag">${accountTag(a, ctx.words)}</span>
        </button>
      </li>`)}
    </ul>
    <p class="cap set-after">Open one to correct its type, rename it, or leave it out. ${
      accounts.some((a) => a.everyday) ? phrase('settings.everyday', ctx.words) : ''}</p>
  </section>`;
}

function linkForm(ctx, label) {
  const busy = ctx.sync.busy;
  const error = ctx.ui.settingsLinkError;
  return html`<form class="set-link" data-submit="settings.link" autocomplete="off">
    <label class="field">
      <span class="field-label lab">New setup token</span>
      <textarea class="tokenbox" name="token" rows="3" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        placeholder="Paste the setup token here" ${busy ? html`disabled` : ''}></textarea>
      <span class="field-help cap">In SimpleFIN Bridge, add a new app connection and copy its setup token. It works once, and this box is cleared as soon as it is used.</span>
    </label>
    <div class="set-link-status" role="status" aria-live="polite">${
      busy ? html`<p class="sync" data-state="syncing"><i class="sync-mark"></i><span class="sync-text"><b>${ctx.sync.step || 'Linking'}</b>…</span></p>`
      : error ? html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Not linked</b>${error}</span></p>` : ''}</div>
    <p class="cluster cluster-center set-link-go">
      <button class="btn btn-solid" type="submit" ${busy ? html`disabled` : ''}>${label}</button>
      <a class="btn-link" href="${BRIDGE_URL}" target="_blank" rel="noopener noreferrer">Open the Bridge</a>
    </p>
  </form>`;
}

function bankFacts(ctx) {
  const s = ctx.sync;
  const rollover = ctx.state.settings.rolloverHour;
  const dataAt = ctx.d.position.dataAt;
  const age = dataAt ? diffDays(gameDay(dataAt, rollover), ctx.today) : null;
  const used = listOf(ctx.state.sync.requests).filter((t) => Number.isFinite(t) && ctx.now - t < DAY_MS && t <= ctx.now).length;
  return html`<ul class="rows set-facts">
    <li class="row">
      <span class="row-label">Last reading</span>
      <span class="row-value" data-cover-keep>${s.lastOk ? whenText(s.lastOk, ctx) : 'not yet'}</span>
    </li>
    <li class="row">
      <span class="row-label">Balances as of <em class="row-note">the oldest among the everyday accounts</em></span>
      <span class="row-value" data-cover-keep>${dataAt ? html`${whenText(dataAt, ctx)}${
        age >= 1 ? html` <span class="${cx('age', age >= 2 && 'is-stale')}">${age === 1 ? '1 day old' : age + ' days old'}</span>` : ''}` : 'no everyday account yet'}</span>
    </li>
    <li class="row">
      <span class="row-label">Readings in the last 24 hours <em class="row-note">the feed allows ${READINGS_PER_DAY}; it updates about once a day</em></span>
      <span class="row-value" data-cover-keep>${used} of ${READINGS_PER_DAY}</span>
    </li>
  </ul>`;
}

function refreshRow(ctx) {
  const s = ctx.sync;
  if (s.busy) {
    return html`<p class="sync set-busy" data-state="syncing" role="status"><i class="sync-mark"></i><span class="sync-text"><b>${s.step || 'Checking the bank'}</b>…</span></p>`;
  }
  const note = s.canRefresh ? 'Networth also reads by itself when it is opened, at most every 3 hours.'
    : s.waitMs > 0 ? 'Ready again in ' + waitText(s.waitMs) + '. Networth also reads by itself when it is opened.'
    : 'Networth reads by itself when it is opened.';
  return html`<p class="cluster cluster-center set-refresh">
    <button class="btn btn-s" type="button" data-action="app.refresh" ${s.canRefresh ? '' : html`disabled`}>Refresh</button>
    <span class="cap grow">${note}</span>
  </p>`;
}

function problems(ctx) {
  const s = ctx.sync;
  const rows = listOf(s.problems).filter((p) => p && typeof p === 'object');
  const out = [];
  if (s.status === 'error' && s.error) {
    out.push(html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Last reading</b>${s.error}</span></p>`);
  }
  for (const p of rows) {
    out.push(html`<p class="notice is-error"><i class="notice-mark"></i><span><b>${p.name || 'A connection'}</b>${coverText(ctx, p.message) || 'The Bridge reports a problem with this connection.'}</span>
      <a class="btn-link" href="${BRIDGE_URL}" target="_blank" rel="noopener noreferrer">Open the Bridge</a></p>`);
  }
  return out.length ? html`<div class="set-problems">${out}</div>` : '';
}

function bankSection(ctx) {
  const s = ctx.sync;
  const accounts = ctx.state.accounts.filter((a) => a && a.source === 'bank');
  const head = (state, mark) => html`<div class="sec-head">
    <h2 class="lab"><b>The bank</b><i class="sep"></i>a read-only link</h2>
    <span class="lab">${mark}${state}</span>
  </div>`;

  if (ctx.demo) {
    return html`<section class="col col-7 set-sec" aria-label="The bank">
      ${head(phrase('settings.sample', ctx.words), html`<i class="hatch-mark"></i>`)}
      <p class="title set-state">${sayHtml('settings.sample.bank', ctx.words)}</p>
      <p class="set-lede">These ${accounts.length === 1 ? 'account is' : accounts.length + ' accounts are'} invented. Your own arrive with one setup token from SimpleFIN Bridge;
        nothing is typed in or imported, ever.</p>
      <p><button class="btn btn-solid btn-fill" type="button" data-action="app.leave-demo">Link your bank</button></p>
      ${accountRows(ctx, accounts)}
    </section>`;
  }

  if (!s.linked) {
    return html`<section class="col col-7 set-sec" aria-label="The bank">
      ${head('Not linked', '')}
      <p class="title set-state">${phrase('settings.unlinked', ctx.words)}</p>
      <p class="set-lede">Nothing new arrives until this device is linked again${s.lastOk ? html`; the last reading was ${whenText(s.lastOk, ctx)}` : ''}.
        Linking again adds to the record already here.</p>
      ${linkForm(ctx, 'Link my bank')}
      ${accountRows(ctx, accounts)}
    </section>`;
  }

  if (s.status === 'relink') {
    return html`<section class="col col-7 set-sec" aria-label="The bank">
      ${head('Link again', '')}
      <p class="title set-state">The link was revoked or has expired.</p>
      <p class="set-lede">The record is intact${s.lastOk ? html`; the last reading was ${whenText(s.lastOk, ctx)}` : ''}. A new setup token from
        SimpleFIN Bridge brings it up to date.</p>
      ${linkForm(ctx, 'Link again')}
      ${accountRows(ctx, accounts)}
      <div class="set-dangers">
        ${dangerous(ctx, 'unlink', { ask: 'Unlink, keep the record', action: 'settings.unlink', go: 'Unlink — the record stays',
          sentence: phrase('settings.unlink', ctx.words) })}
      </div>
    </section>`;
  }

  return html`<section class="col col-7 set-sec" aria-label="The bank">
    ${head('Linked', html`<i class="bank-mark"></i>`)}
    <p class="title set-state">Linked through SimpleFIN Bridge.</p>
    ${problems(ctx)}
    ${bankFacts(ctx)}
    ${refreshRow(ctx)}
    ${accountRows(ctx, accounts)}
    <div class="set-dangers">
      ${dangerous(ctx, 'unlink', { ask: 'Unlink, keep the record', action: 'settings.unlink', go: 'Unlink — the record stays',
        sentence: phrase('settings.unlink', ctx.words) })}
      ${dangerous(ctx, 'unlink-erase', { ask: 'Unlink and erase everything', action: 'settings.erase', go: 'Erase — this cannot be undone',
        sentence: phrase('settings.erase', ctx.words) })}
    </div>
  </section>`;
}

/* ------------------------------------------------- sharing between devices */
/** What the shared file holds, and the owner's corrections that travel in it (ARCHITECTURE 3.8), in the render's words. */
const sharedWhat = (ctx) => phrase('settings.shared.what', ctx.words);
const sharedCorrections = (ctx) => phrase('settings.shared.corrections', ctx.words);


function shareForm(ctx) {
  const busy = ctx.share.busy;
  const error = ctx.ui.settingsShareError;
  return html`<form class="set-link set-share-form" data-submit="settings.share-start" autocomplete="off">
    <label class="field">
      <span class="field-label lab">The key</span>
      <input class="input set-share-key" type="password" name="key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        placeholder="Paste the key here" ${busy ? html`disabled` : ''}>
      <span class="field-help cap">${phrase('settings.share.keyHelp', ctx.words)}</span>
    </label>
    <div class="set-link-status" role="status" aria-live="polite">${
      error ? html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Not started</b>${error}</span></p>` : ''}</div>
    <p class="cluster cluster-center set-link-go">
      <button class="btn btn-solid" type="submit" ${busy ? html`disabled` : ''}>Start sharing</button>
    </p>
  </form>`;
}

function shareSteps() {
  return html`<ol class="set-share-steps">
    <li>Open <a class="btn-link" href="${TOKEN_URL}" target="_blank" rel="noopener noreferrer">GitHub’s page for a fine-grained token</a>; it opens in a new tab.</li>
    <li>Name it, choose the longest expiry, and under “Only select repositories” pick <b>networth-data</b>. Under Repository permissions set <b>Contents</b> to <b>Read and write</b>; nothing else.</li>
    <li>Create it, copy it, and paste it here.</li>
  </ol>`;
}

function shareFacts(ctx) {
  const sh = ctx.share;
  return html`<ul class="rows set-facts">
    <li class="row">
      <span class="row-label">Last agreed <em class="row-note">${phrase('settings.share.agreed', ctx.words)}</em></span>
      <span class="row-value" data-cover-keep>${sh.agreedAt ? whenText(sh.agreedAt, ctx) : 'not yet'}</span>
    </li>
    <li class="row">
      <span class="row-label">Payments you send <em class="row-note">${phrase(sh.file ? 'settings.share.payments' : 'settings.share.noFile', ctx.words)}</em></span>
      <span class="row-value" data-cover-keep>${sh.agreedAt ? sh.count : '—'}</span>
    </li>
    <li class="row">
      <span class="row-label">${phrase('settings.share.keptIn', ctx.words)} <em class="row-note">a private repository of your own</em></span>
      <span class="row-value set-share-where" data-cover-keep>${sh.owner}/networth-data</span>
    </li>
  </ul>`;
}

function shareNowRow(ctx) {
  const sh = ctx.share;
  if (sh.busy) {
    return html`<p class="sync set-busy" data-state="syncing" role="status"><i class="sync-mark"></i><span class="sync-text"><b>${phrase('settings.share.comparing', ctx.words)}</b>…</span></p>`;
  }
  const note = sh.retryAt ? 'GitHub asked for a pause. Ready again at ' + fmtTime(sh.retryAt) + '.'
    : sh.code === 'key' ? 'Nothing is shared by itself until a new key is pasted or Share now is tapped.'
    : 'Networth also shares by itself: 2 seconds after a change here, and each time it is opened.';
  return html`<p class="cluster cluster-center set-refresh">
    <button class="btn btn-s" type="button" data-action="settings.share-now" ${sh.canShare ? '' : html`disabled`}>Share now</button>
    <span class="cap grow">${note}</span>
  </p>`;
}

function shareForget(ctx) {
  return html`<div class="set-dangers">
    ${dangerous(ctx, 'share-forget', { ask: 'Forget the key on this device', action: 'settings.share-forget', go: phrase('settings.share.forgetGo', ctx.words),
      sentence: phrase('settings.share.forget', ctx.words) })}
  </div>`;
}

function shareSection(ctx) {
  const sh = ctx.share;
  if (!sh || !sh.available) return '';
  const head = (state) => html`<div class="sec-head">
    <h2 class="lab"><b>Share between devices</b><i class="sep"></i>${phrase('settings.share.head', ctx.words)}</h2>
    <span class="lab">${state}</span>
  </div>`;
  const what = html`<section class="col col-5 set-sec" aria-label="What is shared">
    <div class="sec-head"><h3 class="lab"><b>What is shared</b><i class="sep"></i>1 private file</h3></div>
    <p class="set-lede">${say('settings.share.onLede', ctx.words, { owner: sh.owner })}</p>
    <p class="cap set-help">${sharedCorrections(ctx)}</p>
    <p class="cap set-help">${sharedWhat(ctx)}</p>
  </section>`;

  if (ctx.demo) {
    return html`<div class="cols">
      <section class="col col-7 set-sec" aria-label="Share between devices">
        ${head(phrase('settings.sample', ctx.words))}
        <p class="title set-state">${sayHtml('settings.sample.share', ctx.words)}</p>
        <p class="set-lede">${phrase('settings.share.sampleLede', ctx.words)}</p>
      </section>
      ${what}
    </div>`;
  }

  if (!sh.on) {
    return html`<div class="cols">
      <section class="col col-7 set-sec" aria-label="Share between devices">
        ${head('Off')}
        <p class="title set-state">Not sharing. 1 paste on each device starts it.</p>
        <p class="set-lede">${say('settings.share.offLede', ctx.words, { owner: sh.owner })}
          ${phrase('settings.share.offLedeMore', ctx.words)}</p>
        <p class="cap set-help">${sharedCorrections(ctx)}</p>
        <p class="cap set-help">${sharedWhat(ctx)}</p>
      </section>
      <section class="col col-5 set-sec" aria-label="The key">
        <div class="sec-head"><h3 class="lab"><b>The key</b><i class="sep"></i>3 steps, once per device</h3></div>
        ${shareSteps()}
        ${shareForm(ctx)}
      </section>
    </div>`;
  }

  if (sh.code === 'key' && !sh.busy) {
    return html`<div class="cols">
      <section class="col col-7 set-sec" aria-label="Share between devices">
        ${head('Refused')}
        <p class="title set-state">GitHub refused the key.</p>
        <p class="notice is-error"><i class="notice-mark"></i><span><b>Not shared</b>${sh.message}${sh.failedAt ? ' Tried ' + whenText(sh.failedAt, ctx) + '.' : ''}</span></p>
        <p class="set-lede">${phrase('settings.share.refusedLede', ctx.words)}</p>
        ${shareForm(ctx)}
        ${shareNowRow(ctx)}
        ${shareForget(ctx)}
      </section>
      <section class="col col-5 set-sec" aria-label="The key">
        <div class="sec-head"><h3 class="lab"><b>A new key</b><i class="sep"></i>3 steps</h3></div>
        ${shareSteps()}
        <p class="cap set-help">${sharedCorrections(ctx)}</p>
        <p class="cap set-help">${sharedWhat(ctx)}</p>
      </section>
    </div>`;
  }

  return html`<div class="cols">
    <section class="col col-7 set-sec" aria-label="Share between devices">
      ${head(sh.busy ? 'Working' : sh.code ? 'Not shared' : 'On')}
      <p class="title set-state">${sh.code ? phrase('settings.share.failed', ctx.words) : sh.agreedAt ? 'Sharing through your own GitHub.' : phrase('settings.share.first', ctx.words)}</p>
      ${sh.code && !sh.busy ? html`<div class="set-problems"><p class="notice is-error"><i class="notice-mark"></i><span><b>Not shared</b>${sh.message}${
        sh.failedAt ? ' Tried ' + whenText(sh.failedAt, ctx) + '; nothing on this device was changed.' : ''}</span></p></div>` : ''}
      ${shareFacts(ctx)}
      ${shareNowRow(ctx)}
      ${shareForget(ctx)}
    </section>
    ${what}
  </div>`;
}

/* ------------------------------------------------- card purchases within minutes */

/** The address the phone writes each alert to: a new file in the inbox folder of the owner's private repository. */
function inboxAddress(owner) {
  return 'https://api.github.com/repos/' + owner + '/networth-data/contents/inbox/';
}

/** Where the reading of the inbox stands, in a few words: paused (and why or until when), reading, or waiting for the key. */
function alertPause(ctx) {
  const sh = ctx.share;
  const inbox = ctx.inbox || {};
  if (sh.code === 'key' || inbox.code === 'key') return 'Paused: GitHub refused the key';
  if (sh.retryAt) return 'Paused until ' + fmtTime(sh.retryAt);
  return sh.on ? 'Reading every minute' : 'Needs the key';
}

function alertLine(ctx) {
  const sh = ctx.share;
  const { last, waiting } = alertStatus(ctx.state, ctx.today);
  const inbox = ctx.inbox || {};
  const pause = alertPause(ctx);
  const paused = pause.startsWith('Paused') ? ' ' + pause + '.' : '';
  const read = inbox.readAt ? 'Inbox read ' + whenText(inbox.readAt, ctx) + '.' : sh.on ? 'The inbox has not been read yet on this device.' : '';
  const status = last
    ? html`Last alert ${whenText(last.at, ctx)}: <span data-cover-keep>${last.merchant}</span>, ${inlineMoney(last.amount, { est: true })}; ${waiting} not yet in the bank’s figures.`
    : 'No alert has arrived yet.';
  const n = Number.isInteger(inbox.refused) ? inbox.refused : 0;
  // a count only: what such a text said is never kept or shown
  const refused = n === 1 ? ' 1 text from the phone was not a purchase and was deleted.'
    : n > 1 ? ' ' + n + ' texts from the phone were not purchases and were deleted.' : '';
  return html`<p class="cap set-alert-status" role="status">${status} ${read}${refused}${paused}${inbox.code && inbox.code !== 'key' && inbox.code !== 'rate'
    ? ' The last reading did not go through; it is tried again within a minute.' : ''}</p>`;
}

/** The words a shortcut stops at: a text holding one is never sent (a code, a sign-in, an approval). */
const SHORTCUT_STOP_WORDS = 'code|passcode|\\bPIN\\b|verif|approv|confirm|one-time|\\bOTP\\b|security|sign in|log in|new device';

function alertSection(ctx) {
  const sh = ctx.share;
  if (!sh || !sh.available || ctx.demo) return '';
  const c = (text) => html`<code class="set-code">${text}</code>`;
  const block = (text) => html`<code class="set-code set-code-block">${text}</code>`;
  return html`<div class="cols">
    <section class="col col-7 set-sec" aria-label="Card purchases within minutes">
      <div class="sec-head">
        <h2 class="lab"><b>Card purchases within minutes</b><i class="sep"></i>from your card’s text alerts</h2>
        <span class="lab">${alertPause(ctx)}</span>
      </div>
      <p class="set-lede">${phrase('settings.alerts.lede', ctx.words)}
        It takes 1 setup on the iPhone. Each alert’s text is written to your private repository. The app deletes the file once the bank’s record replaces the purchase, or once the card’s balance has taken it in, but the repository’s history keeps every file ever written.
        ${phrase('settings.alerts.only', ctx.words)}</p>
      ${alertLine(ctx)}
    </section>
    <section class="col col-5 set-sec" aria-label="Setting up the iPhone">
      <div class="sec-head"><h3 class="lab"><b>The iPhone</b><i class="sep"></i>10 steps, once</h3></div>
      <ol class="set-share-steps">
        <li>In your card’s bank’s app, turn on a text alert for every card purchase, of any amount. Save the number those texts come from as a contact.</li>
        <li>In Shortcuts, Automation, tap <b>+</b> and choose <b>Message</b>. Set <b>Sender</b> to that contact (or <b>Message Contains</b> to a word every purchase alert holds), choose <b>Run Immediately</b>, then <b>New Blank Automation</b>.</li>
        <li>Add <b>Match Text</b>: text <b>Shortcut Input</b>, Case Sensitive off, pattern ${block(SHORTCUT_STOP_WORDS)} Add <b>If</b>: <b>Matches</b> <b>has any value</b>; inside it, <b>Stop This Shortcut</b>.</li>
        <li>Add a second <b>Match Text</b>: text <b>Shortcut Input</b>, pattern ${c('\\$[0-9]')}. Add <b>If</b>: <b>Matches</b> <b>does not have any value</b>; inside it, <b>Stop This Shortcut</b>.</li>
        <li>Add <b>Base64 Encode</b>: <b>Shortcut Input</b>, <b>Line Breaks: None</b>.</li>
        <li>Add <b>Current Date</b>, then <b>Format Date</b>: <b>Date Format: Custom</b>, format ${c('yyyyMMdd-HHmmss-SSS')}.</li>
        <li>Add <b>Text</b>: <code class="set-code set-code-block" data-cover-keep>${inboxAddress(sh.owner)}</code> then the <b>Formatted Date</b>, then ${c('.txt')}, with no spaces.</li>
        <li>Add <b>Get Contents of URL</b> with that <b>Text</b>. <b>Method</b>: PUT. <b>Headers</b>: ${c('Authorization')} = the word ${c('Bearer')}, then one space, then your key (${phrase('settings.alerts.sameKey', ctx.words)}), and ${c('Accept')} = ${block('application/vnd.github+json')} <b>Request Body</b>: JSON, two Text fields: ${c('message')} = ${c('alert')} and ${c('content')} = the <b>Base64 Encoded</b> result.</li>
        <li>The first time it runs, Shortcuts asks to allow it to connect to api.github.com: choose <b>Always Allow</b>.</li>
        <li>To test it, send yourself nothing: wait for the first real purchase alert, then look at the line under “Card purchases within minutes” here.</li>
      </ol>
    </section>
  </div>`;
}

/* ------------------------------------------------- the nightly wrap (ARCHITECTURE 3.10) */

const WRAP_LOCKS = [['cover', 'Follow cover'], ['show', 'Show'], ['hide', 'Hide']];
const WRAP_SECRET = 'VAPID_PRIVATE_KEY';

/**
 * The night key just made: its private half, shown once, with Copy, GitHub's secret page and what to do there: a first
 * key adds the secret; a key that replaces one updates the secret GitHub already holds.
 */
function wrapMade(ctx, wr) {
  const c = (text) => html`<code class="set-code">${text}</code>`;
  // the first key goes to GitHub's form for a new secret; a replacement, or a key whose secret no run has checked yet,
  // to the list of secrets, where the existing one is updated
  const url = wr.replacing === false ? wr.secretUrl : wr.secretsUrl;
  return html`<p class="title set-state">The night key is made. Its private half is shown this once.</p>
    <ol class="set-share-steps set-wrap-steps">
      <li><button class="btn btn-s" type="button" data-action="settings.wrap-copy">Copy private key</button>
        <code class="set-code set-code-block set-wrap-secret">${wr.made}</code></li>
      <li>Open <a class="btn-link" href="${url}" target="_blank" rel="noopener noreferrer">GitHub’s secret page</a>; it opens in a new tab.</li>
      ${wr.replacing === null
        ? html`<li>If ${c(WRAP_SECRET)} is listed, click its pencil, paste into <b>Value</b>, then <b>Update secret</b>. If it is not, click <b>New repository secret</b>, type ${c(WRAP_SECRET)} as <b>Name</b>, paste into <b>Secret</b>, then <b>Add secret</b>.</li>`
        : wr.replacing
          ? html`<li>Click ${c(WRAP_SECRET)}’s pencil, paste into <b>Value</b>, then <b>Update secret</b>.</li>`
          : html`<li>Click <b>Name</b> and type ${c(WRAP_SECRET)}. Click <b>Secret</b>, paste, then <b>Add secret</b>.</li>`}
    </ol>
    <p class="cap set-help">Networth keeps no copy of it: once you tap Done, or close the app, it is gone from this device. Should it be lost, make a new key.</p>
    <p class="cluster set-wrap-go"><button class="btn btn-solid" type="button" data-action="settings.wrap-done">Done</button></p>`;
}

/** This device: Turn on (installed app only), Turn off, the lock screen. */
function wrapDevice(ctx, wr) {
  const busy = !!wr.busy;
  if (!wr.standalone) {
    return html`<p class="cap set-help">Turn it on in the installed app: on the iPhone and iPad from the Home Screen, on the Mac from the Dock. Only the installed app receives it.</p>`;
  }
  if (!wr.pushable) return html`<p class="cap set-help">This app cannot receive notifications here.</p>`;
  if (wr.subscribed && !wr.status.dead && !wr.status.refused) {
    return html`<p class="cluster cluster-center set-refresh">
        <span class="cap grow">On for this device.</span>
        <button class="btn btn-s" type="button" data-action="settings.wrap-off" ${busy ? html`disabled` : ''}>Turn off</button>
      </p>
      <fieldset class="field set-wrap-lock">
        <legend class="field-label lab">Amounts on the lock screen</legend>
        <div class="seg seg-block" role="radiogroup" aria-label="Amounts on the lock screen">
          ${WRAP_LOCKS.map(([value, label]) => html`<label class="seg-opt"><input type="radio" name="wrapLock" value="${value}" data-change="settings.wrap-lock" ${
            wr.lock === value ? html`checked` : ''}><span>${label}</span></label>`)}
        </div>
        <p class="cap field-help">Follow cover hides them while this device’s cover is on.</p>
      </fieldset>`;
  }
  const again = wr.gone || wr.status.dead || wr.status.refused;
  // turned off, or refused, by the push service: the notice above says so, so the line beside the button only says the tap
  const said = !again ? '1 tap here, then Allow.' : wr.status.dead || wr.status.refused ? '1 tap turns it back on.' : 'It was turned off on this device. 1 tap turns it back on.';
  return html`<p class="cluster cluster-center set-wrap-go">
    <button class="btn btn-solid" type="button" data-action="settings.wrap-on" ${busy ? html`disabled` : ''}>${again ? 'Turn back on' : 'Turn on the nightly wrap'}</button>
    <span class="cap grow">${said}</span>
  </p>`;
}

/** A status the night job recorded for this device, in words: never a raw token. */
function wrapProblem(problem) {
  if (problem === 0) return 'its push service did not answer';
  if (Number.isInteger(problem)) return 'its push service answered ' + problem;
  return '';
}

/** What the night job last did for this device (wrap/sent.json). */
function wrapStatusLines(ctx, wr) {
  const st = wr.status;
  const lines = [];
  // a key problem of a run before this night key was made is about the key it replaced: it is not said
  const stale = !!(wr.vapid && Number.isFinite(wr.vapid.madeAt) && Number.isFinite(st.lastAt) && wr.vapid.madeAt > st.lastAt);
  if (st.noKey && !stale) {
    const page = wr.secretsUrl || '';
    // the backup schedule runs a full run when the first one sent nothing: tonight's, if that was tonight's first run
    const next = st.nextRun === 'backup' && st.lastDay === ctx.today ? '10:13 PM' : '9:33 PM';
    lines.push(html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Not sent</b>The last run found no secret named ${WRAP_SECRET} on GitHub, so it sent nothing. On ${page
      ? html`<a class="btn-link" href="${page}" target="_blank" rel="noopener noreferrer">GitHub’s secret page</a>` : 'GitHub’s secret page'}, check that its name is exactly ${WRAP_SECRET}. If the private key is no longer at hand, make a new night key below and paste it there. The next run checks again at ${next}.</span></p>`);
  } else if (st.keyProblem && !stale) {
    lines.push(html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Not sent</b>The night key GitHub holds (${WRAP_SECRET}) is not the one your repository publishes, so the last run sent nothing. Make a new night key below, and paste it into GitHub.</span></p>`);
  }
  if (st.dead) {
    lines.push(html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Turned off</b>This device was turned off by the push service${st.lastAt ? ' on ' + fmtDate(gameDay(st.lastAt, ctx.state.settings.rolloverHour), 'short') : ''}.</span></p>`);
  } else if (st.got && st.lastDay) {
    lines.push(html`<p class="cap set-wrap-last" role="status">Last wrap: ${say('board.today.round', ctx.words, { n: String(Number(st.lastDay.slice(8))) })}, sent ${whenText(st.lastAt, ctx)}.</p>`);
  } else if (st.refused) {
    lines.push(html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Not reaching</b>The wrap cannot reach this device: its push service refused the last one (${String(st.problem)}).</span></p>`);
  } else if (st.problem === 'file' || st.problem === 'subscription' || st.problem === 'endpoint') {
    lines.push(html`<p class="cap set-wrap-last" role="status">The last wrap did not reach this device: this device’s push file could not be used. To fix it, turn the wrap off and on again here.</p>`);
  } else if (st.problem !== null) {
    const why = wrapProblem(st.problem);
    const next = !Number.isInteger(st.problem) || !(st.problem === 0 || st.problem === 429 || (st.problem >= 500 && st.problem <= 599)) ? ''
      // the backup run is promised only while it is still to come: tonight's, after tonight's first run
      : st.retry && st.lastDay === ctx.today ? ' The backup run tries again.' : ' The next wrap tries again.';
    lines.push(html`<p class="cap set-wrap-last" role="status">The last wrap did not reach this device${why ? ': ' + why : ''}.${next}</p>`);
  }
  return lines;
}

function wrapSection(ctx) {
  const sh = ctx.share;
  const wr = ctx.wrap;
  if (!sh || !sh.available || ctx.demo || !wr) return '';
  const state = !sh.on ? 'Needs the key' : wr.subscribed ? 'On' : wr.status.dead || wr.status.refused || wr.gone ? 'Turned off' : 'Off';
  let body;
  if (!sh.on) {
    body = html`<p class="title set-state">Start sharing between devices first: the wrap uses the same key.</p>`;
  } else if (wr.made) {
    body = wrapMade(ctx, wr);
  } else if (wr.vapid === undefined) {
    body = wr.code
      ? html`<p class="notice is-error"><i class="notice-mark"></i><span><b>Not read</b>The night key could not be read. ${shareMessage(wr.code)}</span></p>`
      : html`<p class="sync set-busy" data-state="syncing" role="status"><i class="sync-mark"></i><span class="sync-text"><b>Reading the night key</b>…</span></p>`;
  } else if (wr.vapid === null) {
    body = html`<p class="title set-state">No night key yet.</p>
      <p class="cluster cluster-center set-wrap-go">
        <button class="btn btn-solid" type="button" data-action="settings.wrap-key" ${wr.busy ? html`disabled` : ''}>Make the night key</button>
        <span class="cap grow">Once, on 1 device.</span>
      </p>
      <p class="cap set-help">It is made in this browser. Its public half goes to push/vapid.json in your repository; its private half is shown once, for you to paste into GitHub as the secret <code class="set-code">${WRAP_SECRET}</code>. Networth keeps no copy.</p>`;
  } else {
    body = html`<p class="title set-state">Night key made${wr.vapid.madeAt ? ' ' + whenText(wr.vapid.madeAt, ctx) : ''}.</p>
      ${wrapStatusLines(ctx, wr)}
      ${wrapDevice(ctx, wr)}
      <div class="set-dangers">
        ${dangerous(ctx, 'wrap-key', { ask: 'Make a new night key', action: 'settings.wrap-key', go: 'Make a new key',
          sentence: 'The new key replaces this one: paste it into GitHub again, and every device must then turn the wrap on again (1 tap each).' })}
      </div>`;
  }
  return html`<div class="cols">
    <section class="col col-7 set-sec" aria-label="Nightly wrap">
      <div class="sec-head">
        <h2 class="lab"><b>Nightly wrap</b><i class="sep"></i>money in and out, each night</h2>
        <span class="lab">${state}</span>
      </div>
      <p class="set-lede">${phrase('wrap.set.lede', ctx.words)}</p>
      ${body}
    </section>
    <section class="col col-5 set-sec" aria-label="What the wrap holds">
      <div class="sec-head"><h3 class="lab"><b>What it holds</b><i class="sep"></i>no names</h3></div>
      <p class="cap set-help">${phrase('wrap.set.files', ctx.words)}</p>
      <p class="cap set-help">Each device may hide the amounts on its lock screen. Apple carries the message encrypted.</p>
    </section>
  </div>`;
}

/* ------------------------------------------------- income your other apps report */

/**
 * One source of income/ in a line: its label, when the other app last wrote it (from the file, read leniently:
 * nothing when it does not say; a writer that stopped shows here, and a quiet week is normal, so no alarm),
 * when it was read, how many payments count, and any problem.
 */
/** How many payments answered "in the bank" a source lists before "Show all" (every answer keeps a reachable Ask again). */
const GONE_SHOWN = 10;

function incomeSourceLine(ctx, id, src, payments, since, index) {
  const n = payments.filter((p) => p.source === id && (p.how === 'bank' || p.how === 'ask' || p.how === 'cash')).length;
  const what = src.what ? html`<b data-cover-keep>${src.what}</b>` : html`<b>${id}.json</b>`;
  const good = Number.isFinite(src.readAt);
  const written = Number.isFinite(src.writtenAt) && src.writtenAt > 0 ? 'written ' + whenText(src.writtenAt, ctx) + ', ' : '';
  // a file read and refused says so in one line: "{file}: read {when}, not used. {problem}"
  if (!good && src.problem) {
    const checked = Number.isFinite(src.checkedAt) ? 'read ' + whenText(src.checkedAt, ctx) + ', not used' : 'not used';
    return html`<li><b>${id}.json</b>: ${checked}. <span class="set-income-problem">${src.problem}</span></li>`;
  }
  const read = written + (good ? 'read ' + whenText(src.readAt, ctx) : 'not read yet');
  const goneList = payments.filter((p) => p.source === id && p.how === 'gone');
  const gone = goneList.length;
  const counted = since === null || !good ? '' : html`; ${n === 1 ? '1 payment counts' : n + ' payments count'} since ${fmtDate(gameDay(since, ctx.state.settings.rolloverHour), 'short')}${gone
    ? html`, and ${gone === 1 ? '1 is' : gone + ' are'} in the bank by your answer` : ''}`;
  const refused = src.problem ? html` <span class="set-income-problem">The latest file${Number.isFinite(src.checkedAt) ? ', read ' + whenText(src.checkedAt, ctx) + ',' : ''} could not be used: ${lowerFirst(src.problem)}${src.sha ? ' The last good copy is kept.' : ''}</span>` : '';
  // the payments answered "in the bank", latest first, each with Ask again: the 10 latest, and "Show all" for the rest
  const all = !!(ctx.ui.settingsGoneAll && ctx.ui.settingsGoneAll[id] === true);
  const sorted = goneList.slice().sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const shown = all ? sorted : sorted.slice(0, GONE_SHOWN);
  const more = gone - shown.length;
  const list = shown.length ? html`<ul class="set-income-gone">${shown.map((p, k) => html`<li><span id="inc-gone-${index}-${k + 1}"><span data-cover-keep>${incomeLabel(p)}</span>, ${inlineMoney(p.cents)}, marked ${fmtDate(p.marked, 'short')}: in the bank.</span>
      <button class="btn-link" type="button" data-action="settings.income-again" aria-describedby="inc-gone-${index}-${k + 1}" data-source="${p.source}" data-item="${p.id}">Ask again</button></li>`)}${more > 0
    ? html`<li class="cap">and ${more === 1 ? '1 more' : more + ' more'} · <button class="btn-link" type="button" data-action="settings.income-gone-all" data-source="${id}" data-from="${shown.length}" aria-label="Show all ${gone} in-the-bank payments of ${src.what || id + '.json'}">Show all ${gone}</button></li>` : ''}</ul>` : '';
  return html`<li>${what}: ${read}${counted}.${refused}${list}</li>`;
}

/** "The file is not…" read after a colon: "the file is not…". */
function lowerFirst(text) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * Per payer, how they pay: Zelle or transfer | Cash. Payments without their own answer follow it. `called`: the name
 * the payer goes by here ("Avery · Group class" when another source has an Avery too).
 */
function incomePayerRow(p, answer, index, called) {
  const name = 'inc-payer-' + index; // from an index: two payers never share one radio group
  return html`<div class="set-income-payer">
    <span class="set-income-name" data-cover-keep>${called}</span>
    <div class="seg" role="radiogroup" aria-label="How ${called} pays" data-change="settings.income-payer" data-source="${p.source}" data-payer="${p.payer}">
      <label class="seg-opt"><input type="radio" name="${name}" value="bank" ${attrs({ checked: answer === 'bank' })}><span>Zelle or transfer</span></label>
      <label class="seg-opt"><input type="radio" name="${name}" value="cash" ${attrs({ checked: answer === 'cash' })}><span>Cash</span></label>
    </div>
  </div>`;
}

function incomeSection(ctx) {
  const sh = ctx.share;
  if (!sh || !sh.available || ctx.demo) return '';
  const { sources, shared } = incomeOf(ctx.state);
  const payments = incomePayments(ctx.state, ctx.state.settings.rolloverHour);
  const labelOf = (id) => (sources[id] && sources[id].what) || id + '.json';
  const ids = Object.keys(sources).sort((a, b) => labelOf(a).localeCompare(labelOf(b)) || (a < b ? -1 : a > b ? 1 : 0));
  const info = ctx.income || {};
  const { payers, names } = listedPayers(ctx.state);
  const cash = cashAccountOf(ctx.state);
  // the head label and the status line come from the same branches
  const readonly = !!(store.status && store.status.readonly);
  const [head, status] = !sh.on ? ['Needs the key', 'The income needs the same key as sharing: paste it above, and this device reads income/ by itself.']
    : sh.code === 'key' || info.code === 'key' ? ['Paused', 'Paused: GitHub refused the key. A new key above starts it again.']
      : sh.retryAt ? ['Paused', 'Paused until ' + fmtTime(sh.retryAt) + '.']
        : readonly ? ['Read-only', 'This record is open read-only here, so this device does not read income/.']
          : ['Reading every minute', (info.folder === 'none' ? 'No file in income/.'
            : info.folder === 'unseen' ? 'Could not see income/: nothing has arrived yet, or the key cannot reach it, so nothing is dropped.'
              : info.readAt ? 'income/ read ' + whenText(info.readAt, ctx) + '.' : 'income/ has not been read yet on this device.')
            + (info.code && info.code !== 'rate' ? ' The last reading did not go through; it is tried again within a minute.' : '')];
  return html`<div class="cols">
    <section class="col col-7 set-sec" aria-label="Income your other apps report">
      <div class="sec-head">
        <h2 class="lab" id="set-income-head" tabindex="-1"><b>Income your other apps report</b><i class="sep"></i>counted the moment it is marked</h2>
        <span class="lab">${head}</span>
      </div>
      <p class="set-lede">Another app of yours writes the payments it records into <code class="set-code">income/</code> in your private repository, and this device reads them with its sharing key. There is nothing to set up here: the other app holds its own key.
        ${sayHtml('settings.income.pencil', ctx.words)}</p>
      <p class="cap" role="status">${status}</p>
      ${ids.length ? html`<ul class="set-income-sources">${ids.map((id, i) => incomeSourceLine(ctx, id, sources[id], payments, shared.since, i + 1))}</ul>`
        : html`<p class="cap">Nothing has arrived yet.</p>`}
    </section>
    <section class="col col-5 set-sec" aria-label="Payers and cash">
      <div class="sec-head"><h3 class="lab"><b>How each payer pays</b><i class="sep"></i>asked once, on every device</h3></div>
      ${payers.length ? html`<div class="set-income-payers">${payers.map((p, i) => incomePayerRow(p, payerAnswer(shared, p.payerKey), i + 1, names.get(p.payerKey)))}</div>`
        : html`<p class="cap">No payer yet.</p>`}
      <p><button class="btn-link" type="button" data-action="settings.income-cash">Count your cash</button>${cash && !isIdleCash(ctx.state, cash)
        ? html` <span class="cap">${phrase('settings.income.cash', ctx.words)} ${inlineMoney(ctx.d.valueOf(cash), { est: !isCountedCash(ctx.state, ctx.d.valueOf(cash)) })}, ${countedWords(ctx.state, ctx.today).words}.</span>` : ''}</p>
    </section>
  </div>`;
}

/* ----------------------------------------------------------------- the day */

function payLine(ctx) {
  // a stream that holds no deposit while its payer's are on record gives no pay (ledger emptiedStreams): not regular pay
  const emptied = emptiedStreams(ctx.state);
  const stream = listOf(ctx.state.streams).find((x) => x && x.active && x.accrue && !emptied.has(x.id));
  const on = !!ctx.state.settings.smoothing;
  if (!stream) {
    return html`No regular pay has been found in the feed yet, so nothing accrues. It starts by itself once a salary shows its rhythm, usually after 2 or 3 paydays.`;
  }
  const cadence = CADENCES[stream.cadence] ? CADENCES[stream.cadence].label.toLowerCase() : 'regularly';
  return html`Regular pay found: ${stream.name}, <span class="est" data-fig><span class="approx">≈</span>${fmt(stream.amount)}</span> ${cadence}. ${
    on ? 'Net worth rises a little every day instead of jumping on payday, and bills count as they are used.'
      : phrase('settings.payOff', ctx.words)}`;
}

function switchRow(field, on, text, help) {
  return html`<div class="set-opt">
    <label class="switch switch-block">
      <span class="switch-text">${text}</span>
      <input type="checkbox" role="switch" data-change="settings.toggle" data-field="${field}" ${on ? html`checked` : ''}>
      <span class="switch-track" aria-hidden="true"></span>
    </label>
    <p class="cap set-help">${help}</p>
  </div>`;
}

function daySection(ctx) {
  const st = ctx.state.settings;
  const workdays = listOf(st.workdays);
  const hour = Number.isInteger(st.rolloverHour) && st.rolloverHour >= 0 && st.rolloverHour <= 6 ? st.rolloverHour : 4;
  const byes = Number.isInteger(st.byesPerMonth) ? st.byesPerMonth : 2;
  const count = WEEK.filter(([d]) => workdays.includes(d)).length;
  return html`<section class="col col-5 set-sec" aria-label="The day">
    <div class="sec-head">
      <h2 class="lab"><b>The day</b><i class="sep"></i>${sayHtml('settings.day.note', ctx.words)}</h2>
      <span class="lab" data-cover-keep>${sayHtml('settings.day.count', ctx.words, { work: count, sep: html`<i class="sep"></i>`, off: 7 - count })}</span>
    </div>
    <fieldset class="field">
      <legend class="field-label lab">Workdays</legend>
      <div class="chips set-week" role="group" aria-label="Workdays">
        ${WEEK.map(([d, short, long]) => html`<label class="chip"><input type="checkbox" name="workday" value="${d}" aria-label="${long}"
          data-change="settings.workday" data-day="${d}" ${workdays.includes(d) ? html`checked` : ''}><span>${short}</span></label>`)}
      </div>
      <p class="cap field-help">${sayHtml('settings.day.workday', ctx.words)}${
        ctx.state.meta.matchStart ? '' : say('settings.day.notBegun', ctx.words, { day: ctx.d.matchFromDay, days: Number.isFinite(ctx.d.historyDays) ? ctx.d.historyDays : 0 })}</p>
    </fieldset>
    <label class="field set-hour">
      <span class="field-label lab">The day rolls over at</span>
      <span class="select"><select name="rollover" data-change="settings.rollover">
        ${HOURS.map((label, h) => html`<option value="${h}" ${h === hour ? html`selected` : ''}>${label}</option>`)}
      </select></span>
      <span class="cap field-help">${sayHtml('settings.rollover', ctx.words)}</span>
    </label>
    ${switchRow('smoothing', !!st.smoothing, 'Count pay as it is earned', payLine(ctx))}
    ${switchRow('countPending', !!st.countPending, 'Count pending transactions',
      phrase('settings.pending', ctx.words))}
    <fieldset class="field">
      <legend class="field-label lab">${sayHtml('settings.byes', ctx.words)}</legend>
      <div class="seg seg-fig set-byes" role="radiogroup" aria-label="${say('settings.byes', ctx.words)}">
        ${BYES.map((n) => html`<label class="seg-opt"><input type="radio" name="byes" value="${n}" data-change="settings.byes" ${n === byes ? html`checked` : ''}><span>${n}</span></label>`)}
      </div>
      <p class="cap field-help">${sayHtml('settings.byes.help', ctx.words)}</p>
    </fieldset>
  </section>`;
}

/* -------------------------------------------------------------- appearance */

function appearanceSection(ctx) {
  const st = ctx.state.settings;
  const theme = st.theme === 'paper' || st.theme === 'night' ? st.theme : 'auto';
  return html`<section class="col col-4 set-sec" aria-label="Appearance">
    <div class="sec-head">
      <h2 class="lab"><b>Appearance</b><i class="sep"></i>paper and night</h2>
    </div>
    <fieldset class="field">
      <legend class="field-label lab">Theme</legend>
      <div class="seg seg-block" role="radiogroup" aria-label="Theme">
        ${THEMES.map(([value, label]) => html`<label class="seg-opt"><input type="radio" name="theme" value="${value}" data-change="settings.theme" ${
          value === theme ? html`checked` : ''}><span>${label}</span></label>`)}
      </div>
      <p class="cap field-help">Device follows the light or dark setting of this ${ctx.wide ? 'computer' : 'phone'}; paper and night hold still.</p>
    </fieldset>
    ${wordsField(ctx)}
    ${switchRow('cover', !!st.cover, 'Cover figures',
      phrase('settings.cover', ctx.words))}
  </section>`;
}

/**
 * Words: Chess | Finance, and the way to the glossary. The checked option is the record's own choice (wordsOf), which
 * is what the switch sets. Without ?words= that is also the words in force; when the address sets the words for the
 * visit, one line names both: the words this visit shows and the words later visits use. Every render recomputes both,
 * so a click updates the radio and the line at once while the page keeps the address's words.
 */
function wordsField(ctx) {
  const words = wordsOf(ctx.state);
  const legend = phrase('words.legend', ctx.words);
  return html`<fieldset class="field">
      <legend class="field-label lab">${legend}</legend>
      <div class="seg seg-block" role="radiogroup" aria-label="${legend}">
        ${WORDS.map((value) => html`<label class="seg-opt"><input type="radio" name="words" value="${value}" data-change="settings.words" ${
          value === words ? html`checked` : ''}><span>${phrase('words.option.' + value, ctx.words)}</span></label>`)}
      </div>
      ${ctx.wordsForced ? html`<p class="cap field-help" data-key="words-forced">${ctx.demo
        // the sample keeps nothing, so a choice made in it holds for no later visit
        ? say('words.forced.sample', ctx.words, { mode: phrase('words.option.' + wordsMode(ctx.words), ctx.words) })
        : say('words.forced', ctx.words, {
          mode: phrase('words.option.' + wordsMode(ctx.words), ctx.words), saved: phrase('words.option.' + words, ctx.words) })}</p>` : ''}
      <p class="cap field-help">${phrase('words.help', ctx.words)} <button class="btn-link" type="button" data-action="app.sheet" data-sheet="words">${
        phrase('words.open', ctx.words)}</button></p>
    </fieldset>`;
}

/* -------------------------------------------------------------- your rules */

function lineList(ctx, key, title, note) {
  const spec = key === 'principles' ? { ...LISTS[key], one: phrase('settings.principle.one', ctx.words), add: phrase('settings.principle.add', ctx.words) } : LISTS[key];
  const lines = listOf(ctx.state.settings[key]).filter((x) => typeof x === 'string');
  const room = lines.length < spec.max;
  return html`<fieldset class="set-list">
    <legend class="field-label lab">${title}</legend>
    <ol class="set-lines">
      ${lines.map((text, i) => html`<li class="set-line" data-key="${key}-${i}">
        <b class="set-line-n" aria-hidden="true">${i + 1}</b>
        <input class="input" type="text" name="${key}-${i}" value="${text}" maxlength="${spec.length}" autocomplete="off"
          aria-label="${spec.one} ${i + 1}" data-change="settings.line" data-list="${key}" data-i="${i}">
      </li>`)}
      ${room ? html`<li class="set-line is-new" data-key="${key}-new">
        <b class="set-line-n" aria-hidden="true">+</b>
        <input class="input" type="text" name="${key}-new" value="" maxlength="${spec.length}" autocomplete="off" placeholder="${spec.add}"
          aria-label="${spec.add}" data-change="settings.line" data-list="${key}" data-i="${lines.length}">
      </li>` : ''}
    </ol>
    <p class="cap field-help">${note}</p>
  </fieldset>`;
}

function rulesSection(ctx) {
  const purposes = ctx.state.settings.purposes && typeof ctx.state.settings.purposes === 'object' ? ctx.state.settings.purposes : {};
  return html`<section class="col col-8 set-sec" aria-label="Your rules">
    <div class="sec-head">
      <h2 class="lab"><b>Your rules</b><i class="sep"></i>in your own words</h2>
    </div>
    <div class="set-rules">
      ${lineList(ctx, 'principles', phrase('settings.principles', ctx.words), phrase('settings.principles.help', ctx.words))}
      ${lineList(ctx, 'insteads', 'Instead', phrase('settings.insteads.help', ctx.words))}
      <fieldset class="set-list">
        <legend class="field-label lab">Purpose tags</legend>
        <ul class="set-lines">
          ${PURPOSES.map((key, i) => html`<li class="set-line">
            <b class="set-line-n" aria-hidden="true">${i + 1}</b>
            <input class="input" type="text" name="purpose-${key}" value="${typeof purposes[key] === 'string' ? purposes[key] : ''}" maxlength="${PURPOSE_LENGTH}"
              autocomplete="off" aria-label="Name of purpose tag ${i + 1}" data-change="settings.purpose" data-purpose="${key}">
          </li>`)}
        </ul>
        <p class="cap field-help">${sayHtml('settings.purposes.help', ctx.words)}</p>
      </fieldset>
    </div>
  </section>`;
}

/* -------------------------------------------------------------- the record */

function storageLine(ctx) {
  if (ctx.demo) return sayHtml('settings.sample.kept', ctx.words);
  const status = store.status;
  if (status.mode === 'memory') {
    return html`<span class="spot">This window cannot store anything.</span> The record lasts until the tab is closed; open Networth in a normal (not private) window, or save a copy.`;
  }
  const where = status.mode === 'localstorage' ? 'in this browser’s local storage' : 'in this browser’s own database, with one snapshot a day, up to 14 days back';
  return html`${phrase('settings.storage.kept', ctx.words)} ${where}. ${status.error ? html`<span class="spot">The last save did not go through: ${status.error}.</span>`
    : status.savedAt ? html`Last saved at ${fmtTime(status.savedAt)}.` : 'Nothing has needed saving yet.'}${mirrorLine(status.mirror)}`;
}

/** Why the backup copy in this browser was not written (T12); '' when it was. */
function mirrorLine(mirror) {
  if (mirror === 'too large') return ' The backup copy in this browser was not written: the record is larger than the browser keeps. The main copy is unaffected.';
  if (mirror === 'blocked') return ' The backup copy in this browser could not be written.';
  return '';
}

/** The checked copy waiting for its one confirmation, or why a file was turned away. Also shown on the first-run page. */
export function restoreBlock(ctx) {
  const r = ctx.ui.settingsRestore;
  const error = ctx.ui.settingsRestoreError;
  if (error) {
    return html`<p class="notice is-error set-restore-note"><i class="notice-mark"></i><span><b>Not restored</b>${error} Nothing on this device was changed.</span></p>`;
  }
  if (!r) return '';
  return html`<div class="set-confirm" role="group" aria-label="Restore a copy: confirm">
    <p class="cap"><i>${r.name}</i> holds <span data-cover-keep>${plural(r.accounts, 'account', 'accounts')} and ${plural(r.moves, phrase('settings.move.one', ctx.words), phrase('settings.move.many', ctx.words))}</span>${
      r.savedAt ? html`, saved ${fmtDate(gameDay(r.savedAt, 0), 'medium')}` : ''}. It replaces everything now on this device; the bank link itself is not changed.</p>
    <div class="btn-row">
      <button class="btn btn-solid" type="button" data-action="settings.restore">Replace — this cannot be undone</button>
      <button class="btn" type="button" data-action="settings.cancel">Cancel</button>
    </div>
  </div>`;
}

function recordSection(ctx) {
  const st = ctx.state;
  const sample = ctx.demo;
  return html`<section class="col col-7 set-sec" aria-label="The record">
    <div class="sec-head">
      <h2 class="lab"><b>The record</b><i class="sep"></i>this device only</h2>
      <span class="lab" data-cover-keep>${plural(listOf(st.accounts).length, 'account', 'accounts')}<i class="sep"></i>${plural(listOf(st.txs).length, phrase('settings.move.one', ctx.words), phrase('settings.move.many', ctx.words))}</span>
    </div>
    <p class="set-lede">${storageLine(ctx)}</p>
    <div class="set-copy">
      <div class="set-copy-item">
        <button class="btn btn-fill" type="button" data-action="settings.export" ${sample ? html`disabled` : ''}>Save a copy</button>
        <p class="cap">One JSON file of the whole record, into this device’s downloads. It never contains the bank key, so a copy cannot read the bank.</p>
      </div>
      <div class="set-copy-item">
        <label class="${cx('btn btn-fill set-file', sample && 'is-off')}" ${sample ? html`aria-disabled="true"` : ''}>Restore a copy
          <input class="vh" type="file" name="backup" accept="application/json,.json" data-change="settings.restore-pick" ${sample ? html`disabled` : ''}></label>
        <p class="cap">Choose a file saved here earlier. It is checked first, and asked about once, before anything is replaced.</p>
      </div>
    </div>
    ${sample ? html`<p class="cap">${sayHtml('settings.sample.nothing', ctx.words)}</p>` : html`
      <div class="set-restore" role="status" aria-live="polite">${restoreBlock(ctx)}</div>
      <p class="cap">These are conveniences. Nothing here is ever required: the record keeps itself.</p>
      <div class="set-dangers">
        ${dangerous(ctx, 'erase', { ask: 'Erase everything on this device', action: 'settings.erase', go: 'Erase — this cannot be undone',
          sentence: phrase('settings.erase', ctx.words) })}
      </div>`}
  </section>`;
}

/* ------------------------------------------------------------------- about */

function aboutSection(ctx) {
  return html`<section class="col col-5 set-sec" aria-label="About">
    <div class="sec-head">
      <h2 class="lab"><b>About</b><i class="sep"></i>Networth</h2>
      <span class="lab" data-cover-keep>Version ${APP_VERSION}<i class="sep"></i>record format ${SCHEMA_VERSION}</span>
    </div>
    <div class="set-about">
      <div>
        <h3 class="lab"><b>It does</b></h3>
        <ul class="set-points">
          <li>Read balances and transactions through a read-only feed, about once a day.</li>
          <li>${sayHtml('settings.does', ctx.words)}</li>
          <li>Keep all of it on this device, in 1 record.</li>
        </ul>
      </div>
      <div>
        <h3 class="lab"><b>It does not</b></h3>
        <ul class="set-points">
          <li>${sayHtml('settings.doesNot', ctx.words)}</li>
          <li>Have a server, an account or tracking. 0 requests go anywhere but the bank feed.</li>
          <li>Present an estimate as the bank’s figure: italic figures marked <span class="approx">≈</span> are computed.</li>
        </ul>
      </div>
    </div>
    <p class="cap set-bridge"><a class="btn-link" href="${BRIDGE_URL}" target="_blank" rel="noopener noreferrer">SimpleFIN Bridge</a> carries the feed. Its subscription is paid to them, never to Networth.</p>
  </section>`;
}

/* ------------------------------------------------------------------ render */

export function render(ctx) {
  const shared = !!(ctx.share && ctx.share.available);
  return html`<div class="set">
    <section class="band set-top">
      <div class="sec-head">
        <p class="lab"><b>Settings</b><i class="sep"></i>the few things the bank cannot see</p>
        <span class="lab">${ctx.demo ? 'Changes last until this page is closed' : 'Saved as it changes'}</span>
      </div>
      <div class="set-top-row">
        <h1 class="title title-l set-title">Settings</h1>
        <p class="cap set-top-note">The bank link, ${shared ? (ctx.demo ? 'sharing between devices, ' : 'sharing between devices, card purchases within minutes, income your other apps report, the nightly wrap, ') : ''}how a day is counted, appearance, your own rules and the record. ${ctx.demo
          ? phrase('settings.top.sample', ctx.words)
          : 'Every control saves the moment it changes'}${sayHtml('settings.top.complete', ctx.words, { n: shared ? (ctx.demo ? 7 : 10) : 6 })}</p>
      </div>
    </section>
    <div class="cols">
      ${bankSection(ctx)}
      ${daySection(ctx)}
    </div>
    ${shareSection(ctx)}
    ${alertSection(ctx)}
    ${incomeSection(ctx)}
    ${wrapSection(ctx)}
    <div class="cols">
      ${appearanceSection(ctx)}
      ${rulesSection(ctx)}
    </div>
    <div class="cols">
      ${recordSection(ctx)}
      ${aboutSection(ctx)}
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- actions */

function setWorkday({ el, data }) {
  const day = Number(data.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return;
  const on = !!el.checked;
  store.update((s) => {
    const days = new Set(listOf(s.settings.workdays).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
    if (on) days.add(day); else days.delete(day);
    s.settings.workdays = [...days].sort((a, b) => a - b);
  });
}

function setRollover({ el }) {
  const hour = Number(el.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 6) return;
  store.update((s) => { s.settings.rolloverHour = hour; });
}

function setToggle({ el, data }) {
  const field = data.field;
  if (!TOGGLES.includes(field)) return;
  const on = !!el.checked;
  store.update((s) => { s.settings[field] = on; });
}

function setByes({ el }) {
  const n = Number(el.value);
  if (!BYES.includes(n)) return;
  store.update((s) => { s.settings.byesPerMonth = n; });
}

function setWords({ el }) {
  const choice = wordsMode(el.value);
  store.update((s) => { chooseWords(s, choice, nowMs()); });
}

function setTheme({ el }) {
  const choice = el.value === 'paper' || el.value === 'night' ? el.value : 'auto';
  store.update((s) => { s.settings.theme = choice; });
  applyTheme(choice, !store.status.readonly);
}

function setLine({ el, data }) {
  const key = data.list === 'insteads' ? 'insteads' : 'principles';
  const spec = LISTS[key];
  const i = Number(data.i);
  const text = String(el.value || '').replace(/\s+/g, ' ').trim().slice(0, spec.length);
  const lines = listOf(store.state.settings[key]).filter((x) => typeof x === 'string');
  if (!Number.isInteger(i) || i < 0) return;
  if (i >= lines.length) {
    if (!text || lines.length >= spec.max) return;
    store.update((s) => { s.settings[key] = [...lines, text]; });
    el.value = ''; // the line now stands above; the box is ready for the next one
    return;
  }
  if (text === lines[i]) { el.value = text; return; }
  if (text) {
    store.update((s) => { s.settings[key] = lines.map((line, j) => (j === i ? text : line)); });
    return;
  }
  const label = spec.one + ' ' + (i + 1) + ' removed';
  store.update((s) => { s.settings[key] = lines.filter((_, j) => j !== i); }, { undo: label });
  toast(label + '.', {
    action: 'Undo',
    onAction: () => { if (store.undoLabel === label) store.undo(); },
  });
}

function setPurpose({ el, data }) {
  const key = data.purpose;
  if (!PURPOSES.includes(key)) return;
  const text = String(el.value || '').replace(/\s+/g, ' ').trim().slice(0, PURPOSE_LENGTH) || defaultState(0).settings.purposes[key];
  el.value = text;
  store.update((s) => {
    if (!s.settings.purposes || typeof s.settings.purposes !== 'object') s.settings.purposes = {};
    s.settings.purposes[key] = text;
  });
}

async function link({ el, values }) {
  const ctx = context();
  if (ctx && (ctx.sync.busy || ctx.demo)) return;
  const token = values && typeof values.token === 'string' ? values.token : '';
  const field = el && el.querySelector ? el.querySelector('textarea[name="token"]') : null;
  if (field) field.value = ''; // the token leaves the page at once, whatever happens next
  store.setUi({ settingsLinkError: null, settingsConfirm: null });
  let res;
  try {
    res = await linkBank(token);
  } catch {
    res = { ok: false, message: 'The bank link could not be completed. Try again in a moment.' };
  }
  if (res && res.ok) {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') navigator.storage.persist().catch(() => {});
    } catch { /* the answer does not matter */ }
    const n = store.state.accounts.filter((a) => a.source === 'bank').length;
    const words = (context() || {}).words;
    toast(say('settings.toast.linked', words, { accounts: plural(n, 'account', 'accounts') }) + (res.added ? ', ' + plural(res.added, phrase('settings.toast.newMoves.one', words), phrase('settings.toast.newMoves.many', words)) : '') + '.');
    return;
  }
  store.setUi({ settingsLinkError: (res && res.message) || 'The bank was not linked. Try again in a moment.' });
}

function ask({ data }) {
  const what = data.what;
  if (what !== 'unlink' && what !== 'unlink-erase' && what !== 'erase' && what !== 'share-forget' && what !== 'wrap-key') return;
  store.setUi({ settingsConfirm: store.ui.settingsConfirm === what ? null : what });
}

function cancel() {
  pendingRestore = null;
  store.setUi({ settingsConfirm: null, settingsRestore: null, settingsRestoreError: null });
}

/** "on Jun 10 at 2:36 PM", read from the app's clock, for a toast that confirms an action (T11). */
function whenSaid() {
  const ctx = context();
  const ms = ctx && Number.isFinite(ctx.now) ? ctx.now : Date.now();
  return 'on ' + fmtDate(gameDay(ms), 'short') + ' at ' + fmtTime(ms);
}

async function unlink() {
  if (store.status.readonly || store.ui.settingsConfirm !== 'unlink') return;
  store.setUi({ settingsConfirm: null });
  try {
    await unlinkBank({ erase: false });
    toast('Unlinked ' + whenSaid() + '. The record stays on this device; nothing new arrives.');
  } catch {
    toast('The bank key could not be removed. Try again.');
  }
}

async function erase() {
  const asked = store.ui.settingsConfirm;
  if (store.status.readonly || (asked !== 'erase' && asked !== 'unlink-erase')) return;
  pendingRestore = null;
  store.setUi({ settingsConfirm: null, settingsRestore: null, settingsRestoreError: null, settingsLinkError: null, settingsShareError: null });
  try {
    await forgetShare(); // the key of the shared file goes first: nothing of the erasing is sent to the other devices
    await unlinkBank({ erase: true }); // forgets the key and installs an empty record
    await store.flush(); // a save still on its way finishes first, so it cannot land after the wipe
    await wipeStorage({ all: true }); // the daily snapshots too: "everything" means everything
    if ((await listSnapshots()).length) await wipeStorage({ all: true }); // a snapshot that was being written meanwhile
  } catch {
    toast('Not everything could be erased. Try again.');
    return;
  }
  applyTheme('auto', true);
  navigate('#/connect', { replace: true });
  toast('Erased ' + whenSaid() + '. Nothing of yours is left on this device.');
}

/* ------------------------------------------------- sharing between devices */

async function shareStart({ el, values }) {
  const ctx = context();
  if (store.status.readonly || (ctx && ctx.share && ctx.share.busy)) return;
  const key = values && typeof values.key === 'string' ? values.key : '';
  const field = el && el.querySelector ? el.querySelector('input[name="key"]') : null;
  if (field) field.value = ''; // the key leaves the page at once, whatever happens next
  store.setUi({ settingsShareError: null, settingsConfirm: null });
  let res;
  try {
    res = await startShare(key);
  } catch {
    res = { ok: false, message: 'Sharing could not be started. Try again in a moment.' };
  }
  const info = shareInfo();
  if (res && res.ok) {
    toast(shareToast('settings.share.since', (context() || {}).words, fmtTime(info.agreedAt || Date.now()), info.count));
    return;
  }
  // once the key is kept, the section itself says what the round met
  if (!info.on) store.setUi({ settingsShareError: (res && res.message) || 'Sharing was not started. Try again in a moment.' });
}

async function shareRound() {
  if (store.status.readonly) return;
  let info;
  try { info = await shareNow(); } catch { info = shareInfo(); }
  if (info.busy) return;
  if (info.code) toast(info.message);
  else if (info.agreedAt) toast(shareToast('settings.share.agreedAt', (context() || {}).words, fmtTime(info.agreedAt), info.count));
}

async function shareForgetKey() {
  if (store.status.readonly || store.ui.settingsConfirm !== 'share-forget') return;
  store.setUi({ settingsConfirm: null, settingsShareError: null });
  try {
    await forgetShare();
    toast(say('settings.share.forgotten', (context() || {}).words, { when: whenSaid() }));
  } catch {
    toast('The key could not be removed. Try again.');
  }
}

function exportCopy() {
  const ctx = context();
  if (!store.state || store.status.readonly) return;
  const name = 'networth-' + (ctx ? ctx.today : 'copy') + '.json';
  try {
    const blob = new Blob([JSON.stringify(store.state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    toast('Saved a copy: ' + name + '.');
  } catch {
    toast('The copy could not be written on this device.');
  }
}

function restorePick({ el }) {
  const file = el.files && el.files[0];
  if (!file || store.status.readonly) return;
  const fail = (message) => {
    pendingRestore = null;
    store.setUi({ settingsRestore: null, settingsRestoreError: message, settingsConfirm: null });
  };
  const name = String(file.name || 'The file').slice(0, 80);
  try { el.value = ''; } catch { /* the same file can then be chosen again */ }
  if (file.size > MAX_BACKUP_BYTES) { fail('That file is too large to be a Networth copy.'); return; }
  const reader = new FileReader();
  reader.onerror = () => fail('That file could not be read.');
  reader.onload = () => {
    let doc;
    try {
      doc = JSON.parse(String(reader.result));
    } catch {
      fail('That file is not a Networth copy.');
      return;
    }
    const problem = checkDoc(doc, { words: (context() || {}).words });
    if (problem) { fail(problem); return; }
    const now = context() ? context().now : 0;
    try {
      doc = migrate(doc);
      position(doc, now); // a copy the engine cannot read is turned away before it replaces anything
      const derived = makeDerived(doc, now); // and so is one the screens could not work from
      for (const key of Object.keys(derived)) void derived[key]; // reading each one works it out
    } catch {
      fail('This copy could not be read by this version of Networth.');
      return;
    }
    pendingRestore = doc;
    store.setUi({
      settingsRestore: { name, accounts: doc.accounts.length, moves: doc.txs.length, savedAt: Number.isFinite(doc.meta.savedAt) && doc.meta.savedAt > 0 ? doc.meta.savedAt : null },
      settingsRestoreError: null,
      settingsConfirm: null,
    });
  };
  reader.readAsText(file);
}

async function restore() {
  const doc = pendingRestore;
  if (!doc || !store.ui.settingsRestore || store.status.readonly) return;
  const summary = store.ui.settingsRestore;
  pendingRestore = null;
  store.setUi({ settingsRestore: null, settingsRestoreError: null, settingsConfirm: null });
  await store.flush(); // what is on this device now is fully saved before anything replaces it
  const previous = store.state;
  // Reversible: the copy is shown first and only saved over the previous record once a screen has drawn from it.
  store.load(doc, { save: false });
  applyTheme(doc.settings.theme, true);
  setTimeout(() => {
    if (store.state !== doc) return; // erased or replaced meanwhile
    let drawn = true;
    try { drawn = !document.querySelector('.shell-error'); } catch { /* no page: nothing to judge by */ }
    if (!drawn) {
      store.load(previous, { save: false });
      applyTheme(previous.settings.theme, true);
      store.setUi({ settingsRestoreError: 'This copy could not be drawn by this version of Networth.' });
      return;
    }
    store.update(() => {}, { silent: true }); // now it is saved
    toast('Restored: ' + plural(summary.accounts, 'account', 'accounts') + ', ' + plural(summary.moves, phrase('settings.move.one', (context() || {}).words), phrase('settings.move.many', (context() || {}).words)) + '.');
  }, 250);
}

/** The keys of the reported payments in Cash in hand now. */
function inCash(state) {
  const account = cashAccountOf(state);
  return new Set(account ? state.txs.filter((tx) => tx && tx.via === 'income' && tx.accountId === account.id && tx.income).map((tx) => tx.income.key) : []);
}

/** The place of an Ask again button among those of Settings (0 for the first), or 0. */
function againIndex(el) {
  const all = typeof document !== 'undefined' ? [...document.querySelectorAll('[data-action="settings.income-again"]')] : [];
  const at = el ? all.indexOf(el.closest ? el.closest('button') || el : el) : -1;
  return at < 0 ? 0 : at;
}

/**
 * After Ask again in Settings (its line goes): the Ask again that now stands where it stood (the next one), else
 * the section's heading. `selector` instead names the button to go to (the first one "Show all" brought in).
 */
function focusAfterAgain(index, selector) {
  const go = () => {
    const all = [...document.querySelectorAll('[data-action="settings.income-again"]')];
    const target = (selector && document.querySelector(selector)) || all[index] || document.getElementById('set-income-head');
    if (target) target.focus({ preventScroll: false });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(go)); else setTimeout(go, 0);
}

export const actions = {
  /**
   * How a payer pays (3.7), from the two-way choice: shared with every device through the share round. The toast
   * says what it did, as the Board's answer does, and a confirmation question it raised on the board.
   */
  'settings.income-payer': ({ ev, data }) => {
    const how = ev && ev.target && ev.target.value === 'cash' ? 'cash' : 'bank';
    const ctx = context();
    if (!ctx || ctx.demo) return;
    const at = nowMs(); // the moment of the answer, not the time of the last render
    const payer = incomePayments(store.state, ctx.state.settings.rolloverHour).find((p) => p.source === data.source && p.payer === data.payer);
    const before = inCash(store.state);
    const asked = new Set(incomeQuestions(store.state, at).confirm.map((c) => c.key));
    let done = false;
    const change = (s) => answerPayer(s, data.source, data.payer, how, at);
    store.update((s) => { done = change(s); }, { past: change });
    if (!done) return;
    const raised = incomeQuestions(store.state, at).confirm.find((c) => !asked.has(c.key)) || null;
    const moved = [...inCash(store.state)].filter((key) => !before.has(key)).length;
    const account = cashAccountOf(store.state);
    const cover = !!store.state.settings.cover;
    const cash = how === 'cash' && account ? beforeCountWords(store.state, before, Math.round(Number(account.balance) || 0), ctx.today, cover, 'payer', ctx.words) : null;
    const called = payer ? listedPayers(store.state).names.get(payer.payerKey) || payer.payerName : 'The payer';
    toast(payerWords(called, how, cash, raised ? raised.bank : null, cover, moved, 'settings'));
  },
  /** Ask again about a payment answered "in the bank": its own answer is taken back on every device (3.7); the toast says what it does now. */
  'settings.income-again': ({ el, data }) => {
    const ctx = context();
    if (!ctx || ctx.demo || store.status.readonly) return;
    let done = false;
    const at = nowMs(); // the moment of the action
    const key = data.source + '/' + data.item;
    const before = paymentState(store.state, key);
    const index = againIndex(el);
    const change = (s) => askAgain(s, data.source, data.item, at);
    store.update((s) => { done = change(s); }, { past: change });
    if (!done) return;
    toast(againWords(store.state, key, at, before));
    focusAfterAgain(index);
  },
  /** "Show all": the source's whole list of payments answered "in the bank"; focus goes to the first one it brought in. */
  'settings.income-gone-all': ({ el, data }) => {
    const all = { ...(store.ui.settingsGoneAll || {}), [data.source]: true };
    const list = el && el.closest ? el.closest('.set-income-gone') : null;
    const from = Number(data.from) || 0;
    const index = list ? [...document.querySelectorAll('[data-action="settings.income-again"]')].indexOf(list.querySelectorAll('[data-action="settings.income-again"]')[from - 1]) + 1 : 0;
    store.setUi({ settingsGoneAll: all });
    focusAfterAgain(index);
  },
  /** Count your cash: the Cash in hand sheet (the account is made when it is missing). */
  'settings.income-cash': () => {
    const ctx = context();
    if (!ctx || ctx.demo) return;
    let id = cashAccountOf(ctx.state) ? cashAccountOf(ctx.state).id : null;
    if (!id) store.update((s) => { id = ensureCashAccount(s).id; }, { undo: phrase('settings.undo.cash', (context() || {}).words) });
    if (id) openSheet('account', { id });
  },
  'settings.workday': setWorkday,
  'settings.rollover': setRollover,
  'settings.toggle': setToggle,
  'settings.byes': setByes,
  'settings.theme': setTheme,
  'settings.words': setWords,
  'settings.line': setLine,
  'settings.purpose': setPurpose,
  'settings.link': link,
  'settings.ask': ask,
  'settings.cancel': cancel,
  'settings.unlink': unlink,
  'settings.erase': erase,
  'settings.share-start': shareStart,
  'settings.wrap-key': () => {
    store.setUi({ settingsConfirm: null });
    makeNightKey().then((r) => { if (!r.ok && r.code !== 'busy') toast('The night key was not made. ' + shareMessage(r.code)); });
  },
  'settings.wrap-copy': () => {
    const key = madeKey();
    if (!key || !navigator.clipboard) return;
    navigator.clipboard.writeText(key).then(() => toast('Private key copied. Paste it into GitHub’s secret page.'), () => toast('It could not be copied: select it and copy it.'));
  },
  'settings.wrap-done': () => forgetMadeKey(),
  // straight from the tap: the permission request and the subscription start before anything is awaited
  'settings.wrap-on': () => {
    turnOnWrap().then((r) => {
      if (r.ok || r.code === 'busy') return;
      toast(r.code === 'push' ? 'The wrap was not turned on: notifications were not allowed.'
        : r.code === 'worker' ? 'The app is still starting. Try again in a moment.' : 'The wrap was not turned on. ' + shareMessage(r.code));
    });
  },
  'settings.wrap-off': () => {
    turnOffWrap().then((r) => { if (!r.ok && r.code !== 'busy') toast('The wrap was turned off here, but its file could not be removed. ' + shareMessage(r.code)); });
  },
  'settings.wrap-lock': ({ el }) => setWrapLock(el.value),
  'settings.share-now': shareRound,
  'settings.share-forget': shareForgetKey,
  'settings.export': exportCopy,
  'settings.restore-pick': restorePick,
  'settings.restore': restore,
};
