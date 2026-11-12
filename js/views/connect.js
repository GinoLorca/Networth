/**
 * The first run — the whole page whenever no bank is linked and the sample game is not on.
 * The shell draws no masthead around it, so this view is its own title page: the wordmark,
 * one sentence, three numbered steps, the token box, "Link my bank", "Look around first"
 * and the privacy note.
 *
 * Actions
 *   connect.link   (submit) takes the setup token out of the field, clears the field, links the bank
 *                  (sync.linkBank), asks the browser to keep the storage, and goes to the Board.
 *                  A failure is shown in place, under the token box.
 *   The other controls are the shell's: app.demo (Look around first), app.refresh (read again when
 *   the device is linked but the first reading did not finish).
 *
 * Ephemeral state: ui.connectError { text, rev } — the message of the last attempt that did not go through,
 * and the revision of the document it was made on.
 */

import { html } from '../ui/dom.js';
import { store } from '../store.js';
import { context } from '../runtime.js';
import { navigate } from '../router.js';
import { linkBank } from '../sync.js';
import { restoreBlock } from './settings.js';

const BRIDGE_URL = 'https://bridge.simplefin.org';

/**
 * True when the page runs in Safari on an iPhone or iPad and was not opened from the Home Screen.
 * There the Home Screen app keeps its own storage, so the bank is better linked from the Home Screen.
 * @param {{ userAgent?: string, standalone?: boolean, maxTouchPoints?: number }|null|undefined} nav
 */
export function needsHomeScreen(nav) {
  if (!nav || typeof nav.userAgent !== 'string' || nav.standalone === true) return false;
  const ua = nav.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
  if (!ios || !/Safari\//.test(ua)) return false;
  // other browsers and in-app pages on iOS name themselves next to "Safari"
  return !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|GSA\/|YaBrowser|FBAN|FBAV|Instagram|Line\//.test(ua);
}

// Read once, when the module loads: render() itself stays a function of ctx.
const HOME_SCREEN_HINT = typeof navigator !== 'undefined' && needsHomeScreen(navigator);

function waitText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return minutes >= 90 ? Math.round(minutes / 60) + ' h' : minutes + ' min';
}

/* ------------------------------------------------------------------ parts */

/** The bank accounts already in the record (a manual asset or loan is not one). */
function bankAccounts(ctx) {
  return ctx.state.accounts.filter((a) => a && a.source === 'bank').length;
}

/** The masthead's right ear: what this device holds, said exactly. */
function linkMark(ctx) {
  const s = ctx.sync;
  if (s.busy) return html`<p class="sync" data-state="syncing"><i class="sync-mark"></i><span class="sync-text"><b>${s.step || 'Linking'}</b>…</span></p>`;
  if (s.linked && bankAccounts(ctx)) return html`<p class="sync" data-state="fresh"><i class="sync-mark"></i><span class="sync-text"><b>A bank is linked</b> on this device</span></p>`;
  if (s.linked) return html`<p class="sync" data-state="old"><i class="sync-mark"></i><span class="sync-text"><b>A key is here</b>, no reading yet</span></p>`;
  return html`<p class="sync" data-state="old"><i class="sync-mark"></i><span class="sync-text"><b>No bank linked</b> on this device</span></p>`;
}

function header(ctx) {
  return html`<header class="mast cn-mast">
    <div class="mast-top">
      <p class="mast-ear mast-ear-l">
        <span class="lab"><b>First run</b></span>
        <span class="cap only-wide">once on each device</span>
        <span class="lab only-narrow">Link the bank</span>
      </p>
      <div class="mast-plate">
        <h1 class="wordmark">Networth</h1>
        <span class="lab mast-sub">A private net-worth board<i class="sep"></i><b>Link the bank</b></span>
      </div>
      <div class="rule-double mast-rule" aria-hidden="true"></div>
      <div class="mast-ear mast-ear-r">
        ${linkMark(ctx)}
        <span class="cap only-wide">Read-only: it can look, it can never move money.</span>
      </div>
    </div>
  </header>`;
}

/** What stands under the token box: the step in hand, the last message, or nothing. */
function status(ctx) {
  if (ctx.sync.busy) {
    return html`<p class="sync cn-busy" data-state="syncing"><i class="sync-mark"></i><span class="sync-text"><b>${ctx.sync.step || 'Linking'}</b>…</span></p>`;
  }
  const error = lastError(ctx);
  if (error) {
    return html`<p class="notice is-error cn-error"><i class="notice-mark"></i><span><b>Not linked</b>${error}</span></p>`;
  }
  return '';
}

/** The message of the last attempt, for as long as the document it was made on has not changed (a visit to the sample game clears it). */
function lastError(ctx) {
  const e = ctx.ui.connectError;
  return e && e.rev === ctx.state.meta.rev ? e.text : '';
}

/** The device holds a key but the first reading has not produced an account yet. */
function halfLinked(ctx) {
  const s = ctx.sync;
  if (!s.linked || s.busy || ctx.state.accounts.length) return '';
  if (s.status === 'relink') {
    return html`<div class="cn-half">
      <p class="notice"><i class="notice-mark"></i><span><b>Link again</b>The key on this device was revoked or expired before the first reading finished.
        A new setup token replaces it.</span></p>
    </div>`;
  }
  const wait = !s.canRefresh && s.waitMs > 0;
  return html`<div class="cn-half">
    <p class="notice"><i class="notice-mark"></i><span><b>Linked</b>The key is on this device; the first reading has not finished.${
      s.error && !lastError(ctx) ? html` ${s.error}` : ''}</span></p>
    <p class="cluster cluster-center">
      <button class="btn btn-s" type="button" data-action="app.refresh" ${s.canRefresh ? '' : html`disabled`}>Read the bank now</button>
      ${wait ? html`<span class="cap">Ready again in ${waitText(s.waitMs)}; the feed allows 20 readings a day.</span>` : ''}
    </p>
  </div>`;
}

function steps(ctx) {
  const busy = ctx.sync.busy;
  return html`<ol class="steps cn-steps">
    <li class="step">
      <span class="step-n" aria-hidden="true">1</span>
      <div class="step-body">
        <h3 class="step-title">Open SimpleFIN Bridge</h3>
        <p>Create an account there (<span class="nowrap">$1.50 a month</span> or <span class="nowrap">$15 a year</span>, paid to them) and connect
          your bank. You sign in on the bank’s own page, and the access is read-only.</p>
        <p class="step-action"><a class="btn btn-s" href="${BRIDGE_URL}" target="_blank" rel="noopener noreferrer">Open the Bridge</a>
          <span class="cap cn-url">bridge.simplefin.org, in a new tab</span></p>
      </div>
    </li>
    <li class="step">
      <span class="step-n" aria-hidden="true">2</span>
      <div class="step-body">
        <h3 class="step-title">Copy a setup token</h3>
        <p>In the Bridge, add a new app connection and copy its setup token: one long line of letters that works once.</p>
      </div>
    </li>
    <li class="step is-current">
      <span class="step-n" aria-hidden="true">3</span>
      <form class="step-body cn-form" data-submit="connect.link" autocomplete="off">
        <h3 class="step-title">Paste it here</h3>
        <p>The first reading takes about 6 months of history, in 2 requests. After that the board keeps itself.</p>
        <label class="field cn-field">
          <span class="field-label lab">Setup token</span>
          <textarea class="tokenbox" name="token" rows="4" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
            placeholder="Paste the setup token here" ${busy ? html`disabled` : ''}></textarea>
        </label>
        <div class="cn-status" role="status" aria-live="polite">${status(ctx)}</div>
        ${halfLinked(ctx)}
        <p class="cn-go"><button class="btn btn-solid btn-fill" type="submit" ${busy ? html`disabled` : ''}>Link my bank</button></p>
      </form>
    </li>
  </ol>`;
}

function aside(ctx) {
  return html`<div class="cn-aside">
    <section class="cn-look">
      <h2 class="lab"><b>Look around first</b><i class="sep"></i>a sample game</h2>
      <p class="cn-look-text">A finished example with invented figures: 13 months of history, a match in progress, a Book of bills, a card and a loan. Nothing in it is saved.</p>
      <p><button class="btn btn-fill" type="button" data-action="app.demo">Look around first</button></p>
    </section>
    <section class="cn-restore">
      <p class="cap"><label class="btn-link cn-restore-pick"><span>Restore a copy</span><input class="vh" type="file" name="backup"
        accept="application/json,.json" data-change="settings.restore-pick"></label><i class="sep"></i>a file saved from Settings on any device; 1 file replaces what is here.</p>
      <div class="set-restore" role="status" aria-live="polite">${restoreBlock(ctx)}</div>
    </section>
    <section class="cn-private">
      <h2 class="lab"><i class="bank-mark"></i><b>Private</b><i class="sep"></i>this device only</h2>
      <p class="cap">The token is exchanged once for a read-only key that stays on this device. Networth has no server:
        the bank feed is read straight from this browser, and the record is kept in its own storage.</p>
    </section>
  </div>`;
}

/* ----------------------------------------------------------------- render */

export function render(ctx) {
  const found = bankAccounts(ctx);
  const already = ctx.sync.linked && !ctx.sync.busy && ctx.state.meta.origin === 'bank' && found > 0;
  return html`<div class="cn">
    ${header(ctx)}
    ${HOME_SCREEN_HINT ? html`<p class="notice cn-ios"><i class="notice-mark"></i><span><b>iPhone and iPad</b>Add Networth to the Home Screen first
      (Share → Add to Home Screen) and link the bank from there: the Home Screen app keeps its own storage.</span></p>` : ''}
    ${already ? html`<p class="notice cn-already"><i class="notice-mark"></i><span><b>Linked</b>A bank is already linked on this device, with ${found} ${
      found === 1 ? 'account' : 'accounts'}. A new token would replace the key.</span>
      <a class="btn-link" href="#/board">Open the board</a></p>` : ''}
    <div class="cn-page connect">
      <div class="cn-title">
        <p class="lab"><b>Link the bank</b><i class="sep"></i>three moves</p>
        <p class="connect-title">A net-worth board that reads the bank feed itself. Nothing to import, ever.</p>
      </div>
      <section class="cn-how" aria-label="How to link the bank">
        <h2 class="vh">How to link the bank</h2>
        ${steps(ctx)}
      </section>
      ${aside(ctx)}
    </div>
    <footer class="colophon cn-colophon">
      <p>Networth asks the bank feed for read-only updates and nothing else. No account, no tracking, nothing to type in: balances and
        transactions arrive by themselves, and bills, pay, the daily round and net worth are worked out from them.</p>
    </footer>
  </div>`;
}

/* ---------------------------------------------------------------- actions */

async function link({ el, values }) {
  const ctx = context();
  if (ctx && ctx.sync.busy) return;
  const token = values && typeof values.token === 'string' ? values.token : '';
  // the token leaves the page at once, whatever happens next
  const field = el && el.querySelector ? el.querySelector('textarea[name="token"]') : null;
  if (field) field.value = '';
  store.setUi({ connectError: null });
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
    navigate('#/board', { replace: true });
    return;
  }
  store.setUi({ connectError: { text: (res && res.message) || 'The bank was not linked. Try again in a moment.', rev: store.state.meta.rev } });
}

export const actions = {
  'connect.link': link,
};
