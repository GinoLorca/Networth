/**
 * Settings: the bank link, the few things the bank cannot see, appearance, the owner's own rules,
 * the record, and what Networth is. Every control saves the moment it changes; nothing is required.
 *
 * Actions
 *   settings.workday       (change) a weekday chip: adds the day to settings.workdays or takes it out
 *   settings.rollover      (change) the hour the game day rolls over, 0–6
 *   settings.toggle        (change) a switch; data-field = smoothing | countPending | cover
 *   settings.byes          (change) half-point byes allowed per month, 0–4
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
 * The shell's own: app.refresh, app.sheet (an account opens its sheet), app.leave-demo.
 *
 * Ephemeral state (store.ui): settingsConfirm, settingsRestore { name, accounts, moves, savedAt },
 * settingsRestoreError, settingsLinkError.
 */

import { html, cx } from '../ui/dom.js';
import { store } from '../store.js';
import { context, toast } from '../runtime.js';
import { navigate } from '../router.js';
import { linkBank, unlinkBank } from '../sync.js';
import { startShare, shareNow, forgetShare, shareInfo } from '../share.js';
import { wipeStorage, listSnapshots } from '../db.js';
import { ACCOUNT_TYPES, CADENCES, PURPOSES, SCHEMA_VERSION, accountLabel, checkDoc, migrate, defaultState } from '../model/schema.js';
import { fmt } from '../model/money.js';
import { gameDay, diffDays, fmtDate, fmtTime } from '../model/dates.js';
import { position } from '../model/ledger.js';
import { makeDerived } from '../derive.js';
import { coverText } from './parts.js';

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

function accountTag(a) {
  const type = ACCOUNT_TYPES[a.type] ? ACCOUNT_TYPES[a.type].label : 'Account';
  const more = a.hidden ? 'left out' : a.everyday ? 'everyday' : a.reserve ? 'reserve' : '';
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
          <span class="row-label">${accountLabel(a)}${a.institution ? html`<em class="row-note">${a.institution}</em>` : ''}</span>
          <span class="lab set-acct-tag">${accountTag(a)}</span>
        </button>
      </li>`)}
    </ul>
    <p class="cap set-after">Open one to correct its type, rename it, or leave it out. ${
      accounts.some((a) => a.everyday) ? 'Everyday accounts are the ones the daily round reads.' : ''}</p>
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
      ${head('Sample game', html`<i class="hatch-mark"></i>`)}
      <p class="title set-state">Sample game — nothing is linked.</p>
      <p class="set-lede">These ${accounts.length === 1 ? 'account is' : accounts.length + ' accounts are'} invented. Your own arrive with one setup token from SimpleFIN Bridge;
        nothing is typed in or imported, ever.</p>
      <p><button class="btn btn-solid btn-fill" type="button" data-action="app.leave-demo">Link your bank</button></p>
      ${accountRows(ctx, accounts)}
    </section>`;
  }

  if (!s.linked) {
    return html`<section class="col col-7 set-sec" aria-label="The bank">
      ${head('Not linked', '')}
      <p class="title set-state">Not linked. The record is kept.</p>
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
          sentence: 'The key is forgotten on this device and nothing new arrives. Every account, move and round already here stays.' })}
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
        sentence: 'The key is forgotten on this device and nothing new arrives. Every account, move and round already here stays.' })}
      ${dangerous(ctx, 'unlink-erase', { ask: 'Unlink and erase everything', action: 'settings.erase', go: 'Erase — this cannot be undone',
        sentence: 'The bank key, the key of the shared list if this device has one, every account, move and round, and the daily snapshots (up to 14) are removed from this device. A saved copy is the only way back.' })}
    </div>
  </section>`;
}

/* ------------------------------------------------- sharing between devices */

const SHARED_WHAT = 'Nothing the bank reported goes there: no balance, no transaction, no account. Only what you entered, your ticks, and an unreadable fingerprint of who each payment goes to, so every device recognises it the same way.';

function shareForm(ctx) {
  const busy = ctx.share.busy;
  const error = ctx.ui.settingsShareError;
  return html`<form class="set-link set-share-form" data-submit="settings.share-start" autocomplete="off">
    <label class="field">
      <span class="field-label lab">The key</span>
      <input class="input set-share-key" type="password" name="key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        placeholder="Paste the key here" ${busy ? html`disabled` : ''}>
      <span class="field-help cap">Kept on this device only, outside the record: it is in no saved copy, and this box is cleared the moment it is used. Each device needs 1 paste.</span>
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
      <span class="row-label">Last agreed <em class="row-note">this device and the shared file held the same list</em></span>
      <span class="row-value" data-cover-keep>${sh.agreedAt ? whenText(sh.agreedAt, ctx) : 'not yet'}</span>
    </li>
    <li class="row">
      <span class="row-label">Payments you send <em class="row-note">${sh.file ? 'on the shared list' : 'GitHub shows this key no shared file yet; it is written with the first payment'}</em></span>
      <span class="row-value" data-cover-keep>${sh.agreedAt ? sh.count : '—'}</span>
    </li>
    <li class="row">
      <span class="row-label">Kept in <em class="row-note">a private repository of your own</em></span>
      <span class="row-value set-share-where" data-cover-keep>${sh.owner}/networth-data</span>
    </li>
  </ul>`;
}

function shareNowRow(ctx) {
  const sh = ctx.share;
  if (sh.busy) {
    return html`<p class="sync set-busy" data-state="syncing" role="status"><i class="sync-mark"></i><span class="sync-text"><b>Comparing with the shared list</b>…</span></p>`;
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
    ${dangerous(ctx, 'share-forget', { ask: 'Forget the key on this device', action: 'settings.share-forget', go: 'Forget — the list stays',
      sentence: 'The key is removed from this 1 device and nothing more is shared from it. The payments already here stay, the file on GitHub stays as it is, and the other devices carry on.' })}
  </div>`;
}

function shareSection(ctx) {
  const sh = ctx.share;
  if (!sh || !sh.available) return '';
  const head = (state) => html`<div class="sec-head">
    <h2 class="lab"><b>Share between devices</b><i class="sep"></i>the payments you send</h2>
    <span class="lab">${state}</span>
  </div>`;
  const what = html`<section class="col col-5 set-sec" aria-label="What is shared">
    <div class="sec-head"><h3 class="lab"><b>What is shared</b><i class="sep"></i>1 private file</h3></div>
    <p class="set-lede">The payments you send yourself and their ticks, in the file networth-shared.json of ${sh.owner}/networth-data on your own GitHub.</p>
    <p class="cap set-help">${SHARED_WHAT}</p>
  </section>`;

  if (ctx.demo) {
    return html`<div class="cols">
      <section class="col col-7 set-sec" aria-label="Share between devices">
        ${head('Sample game')}
        <p class="title set-state">Sample game — nothing is shared.</p>
        <p class="set-lede">With your own record, 1 paste on each device keeps the payments you send, and their ticks, the same on all of them.</p>
      </section>
      ${what}
    </div>`;
  }

  if (!sh.on) {
    return html`<div class="cols">
      <section class="col col-7 set-sec" aria-label="Share between devices">
        ${head('Off')}
        <p class="title set-state">Not sharing. 1 paste on each device starts it.</p>
        <p class="set-lede">The payments you send yourself, and their ticks, are then kept in a private file on your own GitHub (${sh.owner}/networth-data):
          what is added or ticked on 1 device shows on the others within seconds of opening them, and nothing is typed twice.</p>
        <p class="cap set-help">${SHARED_WHAT}</p>
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
        <p class="set-lede">The list on this device is intact and nothing was changed on GitHub. A new key takes the same 3 steps.</p>
        ${shareForm(ctx)}
        ${shareNowRow(ctx)}
        ${shareForget(ctx)}
      </section>
      <section class="col col-5 set-sec" aria-label="The key">
        <div class="sec-head"><h3 class="lab"><b>A new key</b><i class="sep"></i>3 steps</h3></div>
        ${shareSteps()}
        <p class="cap set-help">${SHARED_WHAT}</p>
      </section>
    </div>`;
  }

  return html`<div class="cols">
    <section class="col col-7 set-sec" aria-label="Share between devices">
      ${head(sh.busy ? 'Working' : sh.code ? 'Not shared' : 'On')}
      <p class="title set-state">${sh.code ? 'The last round did not go through.' : sh.agreedAt ? 'Sharing through your own GitHub.' : 'Sharing: the first round has not run yet.'}</p>
      ${sh.code && !sh.busy ? html`<div class="set-problems"><p class="notice is-error"><i class="notice-mark"></i><span><b>Not shared</b>${sh.message}${
        sh.failedAt ? ' Tried ' + whenText(sh.failedAt, ctx) + '; nothing on this device was changed.' : ''}</span></p></div>` : ''}
      ${shareFacts(ctx)}
      ${shareNowRow(ctx)}
      ${shareForget(ctx)}
    </section>
    ${what}
  </div>`;
}

/* ----------------------------------------------------------------- the day */

function payLine(ctx) {
  const stream = listOf(ctx.state.streams).find((x) => x && x.active && x.accrue);
  const on = !!ctx.state.settings.smoothing;
  if (!stream) {
    return html`No regular pay has been found in the feed yet, so nothing accrues. It starts by itself once a salary shows its rhythm, usually after 2 or 3 paydays.`;
  }
  const cadence = CADENCES[stream.cadence] ? CADENCES[stream.cadence].label.toLowerCase() : 'regularly';
  return html`Regular pay found: ${stream.name}, <span class="est" data-fig><span class="approx">≈</span>${fmt(stream.amount)}</span> ${cadence}. ${
    on ? 'Net worth rises a little every day instead of jumping on payday, and bills count as they are used.'
      : 'Switched off, net worth moves only on the day money moves.'}`;
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
      <h2 class="lab"><b>The day</b><i class="sep"></i>how a round is counted</h2>
      <span class="lab" data-cover-keep>${count} with Black<i class="sep"></i>${7 - count} with White</span>
    </div>
    <fieldset class="field">
      <legend class="field-label lab">Workdays</legend>
      <div class="chips set-week" role="group" aria-label="Workdays">
        ${WEEK.map(([d, short, long]) => html`<label class="chip"><input type="checkbox" name="workday" value="${d}" aria-label="${long}"
          data-change="settings.workday" data-day="${d}" ${workdays.includes(d) ? html`checked` : ''}><span>${short}</span></label>`)}
      </div>
      <p class="cap field-help">A workday is played with Black against the workday habit; the other days are days off, with White.${
        ctx.state.meta.matchStart ? '' : ' No match is in progress yet: the match begins on day ' + ctx.d.matchFromDay + ' on record; ' + (Number.isFinite(ctx.d.historyDays) ? ctx.d.historyDays : 0) + ' so far. These choices apply from then.'}</p>
    </fieldset>
    <label class="field set-hour">
      <span class="field-label lab">The day rolls over at</span>
      <span class="select"><select name="rollover" data-change="settings.rollover">
        ${HOURS.map((label, h) => html`<option value="${h}" ${h === hour ? html`selected` : ''}>${label}</option>`)}
      </select></span>
      <span class="cap field-help">A purchase at 1:00 AM belongs to the evening before. Applies to moves read from now on.</span>
    </label>
    ${switchRow('smoothing', !!st.smoothing, 'Count pay as it is earned', payLine(ctx))}
    ${switchRow('countPending', !!st.countPending, 'Count pending transactions',
      'Pending charges enter balances and rounds at once. A round stays in pencil until they post, usually within 3 days.')}
    <fieldset class="field">
      <legend class="field-label lab">Byes a month</legend>
      <div class="seg seg-fig set-byes" role="radiogroup" aria-label="Byes a month">
        ${BYES.map((n) => html`<label class="seg-opt"><input type="radio" name="byes" value="${n}" data-change="settings.byes" ${n === byes ? html`checked` : ''}><span>${n}</span></label>`)}
      </div>
      <p class="cap field-help">A bye is a day declared ahead: it scores ½, and its dollars still count.</p>
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
    ${switchRow('cover', !!st.cover, 'Cover figures',
      'Every amount becomes an ink bar, for opening Networth in public. It stays on until switched off; Cover in the masthead does the same.')}
  </section>`;
}

/* -------------------------------------------------------------- your rules */

function lineList(ctx, key, title, note) {
  const spec = LISTS[key];
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
      ${lineList(ctx, 'principles', 'Opening principles', 'Shown on the candidate-move sheet before a purchase. Up to 8; clear a line to remove it.')}
      ${lineList(ctx, 'insteads', 'Instead', 'One tap after a declined purchase records what was done instead. Up to 6; clear a line to remove it.')}
      <fieldset class="set-list">
        <legend class="field-label lab">Purpose tags</legend>
        <ul class="set-lines">
          ${PURPOSES.map((key, i) => html`<li class="set-line">
            <b class="set-line-n" aria-hidden="true">${i + 1}</b>
            <input class="input" type="text" name="purpose-${key}" value="${typeof purposes[key] === 'string' ? purposes[key] : ''}" maxlength="${PURPOSE_LENGTH}"
              autocomplete="off" aria-label="Name of purpose tag ${i + 1}" data-change="settings.purpose" data-purpose="${key}">
          </li>`)}
        </ul>
        <p class="cap field-help">The 4 tags a move or an account can carry. A cleared name returns to its default.</p>
      </fieldset>
    </div>
  </section>`;
}

/* -------------------------------------------------------------- the record */

function storageLine(ctx) {
  if (ctx.demo) return html`The sample game is kept nowhere: it is rebuilt each time, and nothing changed in it is saved.`;
  const status = store.status;
  if (status.mode === 'memory') {
    return html`<span class="spot">This window cannot store anything.</span> The record lasts until the tab is closed; open Networth in a normal (not private) window, or save a copy.`;
  }
  const where = status.mode === 'localstorage' ? 'in this browser’s local storage' : 'in this browser’s own database, with one snapshot a day, up to 14 days back';
  return html`Kept on this device only, ${where}. ${status.error ? html`<span class="spot">The last save did not go through: ${status.error}.</span>`
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
    <p class="cap"><i>${r.name}</i> holds <span data-cover-keep>${plural(r.accounts, 'account', 'accounts')} and ${plural(r.moves, 'move', 'moves')}</span>${
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
      <span class="lab" data-cover-keep>${plural(listOf(st.accounts).length, 'account', 'accounts')}<i class="sep"></i>${plural(listOf(st.txs).length, 'move', 'moves')}</span>
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
    ${sample ? html`<p class="cap">In the sample game there is nothing of yours to save, restore or erase.</p>` : html`
      <div class="set-restore" role="status" aria-live="polite">${restoreBlock(ctx)}</div>
      <p class="cap">These are conveniences. Nothing here is ever required: the record keeps itself.</p>
      <div class="set-dangers">
        ${dangerous(ctx, 'erase', { ask: 'Erase everything on this device', action: 'settings.erase', go: 'Erase — this cannot be undone',
          sentence: 'The bank key, the key of the shared list if this device has one, every account, move and round, and the daily snapshots (up to 14) are removed from this device. A saved copy is the only way back.' })}
      </div>`}
  </section>`;
}

/* ------------------------------------------------------------------- about */

function aboutSection() {
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
          <li>Work out the Book of bills, the pay rhythm, the daily round against Habit, and net worth.</li>
          <li>Keep all of it on this device, in 1 record.</li>
        </ul>
      </div>
      <div>
        <h3 class="lab"><b>It does not</b></h3>
        <ul class="set-points">
          <li>Move money, or see a bank password: you sign in on the bank’s own page.</li>
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
        <p class="cap set-top-note">The bank link, ${shared ? 'sharing between devices, ' : ''}how a day is counted, appearance, your own rules and the record. ${ctx.demo
          ? 'In the sample game a change lasts until this page is closed or reloaded, and none is kept'
          : 'Every control saves the moment it changes'}, and none of the ${shared ? 7 : 6} sections needs a visit: the board is complete as it stands.</p>
      </div>
    </section>
    <div class="cols">
      ${bankSection(ctx)}
      ${daySection(ctx)}
    </div>
    ${shareSection(ctx)}
    <div class="cols">
      ${appearanceSection(ctx)}
      ${rulesSection(ctx)}
    </div>
    <div class="cols">
      ${recordSection(ctx)}
      ${aboutSection()}
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
    toast('Linked. ' + plural(n, 'account', 'accounts') + ' on the board' + (res.added ? ', ' + plural(res.added, 'new move', 'new moves') : '') + '.');
    return;
  }
  store.setUi({ settingsLinkError: (res && res.message) || 'The bank was not linked. Try again in a moment.' });
}

function ask({ data }) {
  const what = data.what;
  if (what !== 'unlink' && what !== 'unlink-erase' && what !== 'erase' && what !== 'share-forget') return;
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
    await forgetShare(); // the key of the shared list goes first: nothing of the erasing is sent to the other devices
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
    toast('Sharing since ' + fmtTime(info.agreedAt || Date.now()) + ': ' + plural(info.count, 'payment', 'payments') + ' on the shared list.');
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
  else if (info.agreedAt) toast('Agreed with the shared list at ' + fmtTime(info.agreedAt) + ': ' + plural(info.count, 'payment', 'payments') + '.');
}

async function shareForgetKey() {
  if (store.status.readonly || store.ui.settingsConfirm !== 'share-forget') return;
  store.setUi({ settingsConfirm: null, settingsShareError: null });
  try {
    await forgetShare();
    toast('Key forgotten ' + whenSaid() + '. The list stays on this device and the file stays on GitHub.');
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
    const problem = checkDoc(doc);
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
    toast('Restored: ' + plural(summary.accounts, 'account', 'accounts') + ', ' + plural(summary.moves, 'move', 'moves') + '.');
  }, 250);
}

export const actions = {
  'settings.workday': setWorkday,
  'settings.rollover': setRollover,
  'settings.toggle': setToggle,
  'settings.byes': setByes,
  'settings.theme': setTheme,
  'settings.line': setLine,
  'settings.purpose': setPurpose,
  'settings.link': link,
  'settings.ask': ask,
  'settings.cancel': cancel,
  'settings.unlink': unlink,
  'settings.erase': erase,
  'settings.share-start': shareStart,
  'settings.share-now': shareRound,
  'settings.share-forget': shareForgetKey,
  'settings.export': exportCopy,
  'settings.restore-pick': restorePick,
  'settings.restore': restore,
};
