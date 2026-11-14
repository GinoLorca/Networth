/**
 * The app shell: boot, the page frame (masthead, navigation, banner, bottom bar), the render
 * loop, and the wiring between the router, the store, the bank sync and the views.
 *
 * URL switches (before the #), for demos, tests and screenshots:
 *   ?demo=1                 show the sample game (nothing is saved, nothing syncs)
 *   ?demo=thin              a sample with only nine days of history: no match yet, no pay detected, nothing typed in
 *   ?now=2026-06-10T14:36   pretend it is this local time
 *   ?theme=paper|night      force a theme for this visit
 *   ?ns=name                use a separate saved document (tests)
 *   ?share=owner            on a development host: share through that GitHub account's networth-data (off without it)
 *   ?standalone=1           behave as the installed app (pull to refresh, Command-R) in a browser tab (tests)
 */

import { html, morph, bindActions, registerActions } from './ui/dom.js';
import { store } from './store.js';
import { initStorage, loadDoc } from './db.js';
import { defaultState, migrate, checkDoc } from './model/schema.js';
import { nowMs, setNow, gameDay, diffDays, fmtDate, fmtMonth, fmtTime, parts, daysInMonth, monthOf, addDays } from './model/dates.js';
import { startRouter, onRoute, currentRoute, navigate, openSheet, closeSheet } from './router.js';
import { setContext, setServices } from './runtime.js';
import { makeDerived } from './derive.js';
import { initSync, syncInfo, autoSync, syncNow } from './sync.js';
import { initShare, shareInfo, autoShare, shareNow } from './share.js';
import { autoInbox, inboxInfo } from './inbox.js';
import { autoIncome, incomeInfo } from './income.js';
import { restampByHand } from './model/byhand.js';
import { buildDemoState, demoFeed } from './model/demo.js';
import { mergeFeed } from './model/merge.js';
import { followIncome, refresh } from './model/detect.js';
import { mountSheet, showSheet, hideSheet, isSheetOpen } from './ui/sheet.js';
import { installPull } from './ui/pull.js';
import { initUpdate, checkVersion, reloadTo, reloadNow, pendingBuild, takeRefreshFlag, reachedAttempt } from './update.js';
import { QUOTA } from './model/feed.js';
import { toast } from './ui/toast.js';
import './ui/ticker.js';
import './ui/split.js';
import './ui/charts.js';

import { render as boardView, actions as boardActions } from './views/board.js';
import { render as scoresheetView, actions as scoresheetActions } from './views/scoresheet.js';
import { render as materialView, actions as materialActions } from './views/material.js';
import { render as bookView, actions as bookActions } from './views/book.js';
import { render as analysisView, actions as analysisActions } from './views/analysis.js';
import { render as settingsView, actions as settingsActions } from './views/settings.js';
import { render as connectView, actions as connectActions } from './views/connect.js';

import { render as moveSheet, actions as moveActions, label as moveLabel } from './views/sheet-move.js';
import { render as planSheet, actions as planActions, label as planLabel } from './views/sheet-plan.js';
import { render as sweepSheet, actions as sweepActions, label as sweepLabel } from './views/sheet-sweep.js';
import { render as txSheet, actions as txActions, label as txLabel } from './views/sheet-tx.js';
import { render as daySheet, actions as dayActions, label as dayLabel } from './views/sheet-day.js';
import { render as accountSheet, actions as accountActions, label as accountLabelText } from './views/sheet-account.js';
import { render as recurringSheet, actions as recurringActions, label as recurringLabel } from './views/sheet-recurring.js';
import { render as streamSheet, actions as streamActions, label as streamLabel } from './views/sheet-stream.js';
import { render as habitSheet, actions as habitActions, label as habitLabel } from './views/sheet-habit.js';

const VIEWS = {
  board: { title: 'Board', render: boardView },
  scoresheet: { title: 'Scoresheet', render: scoresheetView },
  material: { title: 'Material', render: materialView },
  book: { title: 'Book', render: bookView },
  analysis: { title: 'Analysis', render: analysisView },
  settings: { title: 'Settings', render: settingsView },
  connect: { title: 'Link your bank', render: connectView },
};

const NAV = ['board', 'scoresheet', 'material', 'book', 'analysis'];

const SHEETS = {
  move: { render: moveSheet, label: moveLabel },
  plan: { render: planSheet, label: planLabel },
  sweep: { render: sweepSheet, label: sweepLabel },
  tx: { render: txSheet, label: txLabel },
  day: { render: daySheet, label: dayLabel },
  account: { render: accountSheet, label: accountLabelText },
  recurring: { render: recurringSheet, label: recurringLabel },
  stream: { render: streamSheet, label: streamLabel },
  habit: { render: habitSheet, label: habitLabel },
};

const NOTE_MEMORY_DAYS = 14;
const WIDE = '(min-width: 900px)';

let els = null;
let scheduled = false;
let savedDocBeforeDemo = null;

/* ------------------------------------------------------------------ boot */

async function boot() {
  const search = new URLSearchParams(location.search);
  const pretend = search.get('now');
  if (pretend) {
    const t = Date.parse(pretend);
    if (Number.isFinite(t)) setNow(t);
  }

  const root = document.getElementById('app');
  root.innerHTML = '<div class="page" id="page"><div id="banner"></div><div id="mast"></div><main id="view" tabindex="-1"></main><div id="foot"></div></div><div id="tabs"></div><div id="sheet-host"></div>';
  els = {
    page: root.querySelector('#page'),
    banner: root.querySelector('#banner'),
    mast: root.querySelector('#mast'),
    view: root.querySelector('#view'),
    foot: root.querySelector('#foot'),
    tabs: root.querySelector('#tabs'),
    sheetHost: root.querySelector('#sheet-host'),
  };
  mountSheet(els.sheetHost);
  els.sheetHost.addEventListener('sheet-dismiss', (ev) => { ev.preventDefault(); closeSheet(); });

  await initStorage({ ns: search.get('ns') || '' });
  let doc = await loadDoc();
  if (doc && checkDoc(doc)) doc = null;
  store.load(doc ? migrate(doc) : defaultState(nowMs()));
  if (!search.get('theme')) applyTheme(store.state.settings.theme);
  await initSync();
  // an Undo makes what it put back the newest, so that the other devices take the Undo and do not bring the change back
  store.onRestore((before, after) => { restampByHand(before, after, nowMs()); });
  // whatever a change (or an Undo) touched that the matching of reported payments reads (the pending switch, an account
  // left out or retyped, the rollover hour, a row reclassified, paired or claimed, an answer), the payments follow in the
  // same update (3.7); the rebuild changes nothing when its inputs did not change. When the bank rows reported payments
  // claim changed, a payer's stream is decided again in the same update (accrual off, or back on)
  store.onUpdate((s) => { followIncome(s, nowMs()); });
  await initShare(location);

  registerActions({ ...appActions, ...boardActions, ...scoresheetActions, ...materialActions, ...bookActions, ...analysisActions,
    ...settingsActions, ...connectActions, ...moveActions, ...planActions, ...sweepActions, ...txActions, ...dayActions,
    ...accountActions, ...recurringActions, ...streamActions, ...habitActions });
  bindActions(root);
  setServices({ toast, rerender: schedule });

  const demo = search.get('demo');
  if (demo === '1' || demo === 'thin') enterDemo(demo === 'thin' ? 'thin' : 'full');
  store.setUi({ seen: store.state.meta.lastSeen });

  startRouter();
  onRoute(schedule);
  // a hand-kept account's field errors belong to the sheet they were made on: they go whenever a sheet opens or closes
  onRoute(() => { if (store.ui.accountErrors) store.setUi({ accountErrors: null }); });
  store.subscribe(schedule);
  if (typeof matchMedia === 'function') matchMedia(WIDE).addEventListener('change', schedule);
  setInterval(schedule, 30000);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', rememberSeen);

  render();
  autoSync();
  autoShare();
  autoInbox();
  autoIncome();
  registerWorker();
  initUpdate({ isIdle, save: async () => { store.mirror(); await store.flush(); }, poke: schedule });
  // in a browser tab no touch listener is added at all: the page scrolls and bounces exactly as before
  if (standalone()) installPull({ enabled: () => !isSheetOpen() && !currentRoute().sheet, onRefresh: async () => (await refreshAndSay()).short });
  document.addEventListener('keydown', onRefreshKey);
  // a refresh that reloaded the page for a newer version goes on here with the bank and the other devices
  if (takeRefreshFlag()) refreshAndSay({ afterReload: true });
}

/** The installed app (Home Screen, Dock): no address bar, no reload button, no browser pull-to-refresh. */
function standalone() {
  if (new URLSearchParams(location.search).get('standalone') === '1') return true;
  if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
  return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
}

/** Command-R / Ctrl-R in the installed app runs the app's refresh; in a browser tab the browser's reload is left alone. */
function onRefreshKey(ev) {
  if (ev.shiftKey || ev.altKey || !(ev.metaKey || ev.ctrlKey) || String(ev.key).toLowerCase() !== 'r' || !standalone()) return;
  ev.preventDefault();
  refreshAndSay();
}

/** Nothing the owner is doing would be lost or interrupted by a reload. */
function isIdle() {
  // the sample game is never saved: a reload would end it, so a newer version waits behind the Reload line
  if (store.status.readonly) return false;
  if (refreshing || isSheetOpen() || currentRoute().sheet) return false;
  const a = document.activeElement;
  if (a && a !== document.body && a.matches('input, textarea, select, [contenteditable], [contenteditable] *')) return false;
  return !syncInfo().busy && !shareInfo().busy && !inboxInfo().busy && !incomeInfo().busy;
}

/** Make the page and the next load's bootstrap agree with the theme saved in the record. */
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'paper') root.setAttribute('data-theme', 'light');
  else if (choice === 'night') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  try {
    if (choice === 'paper' || choice === 'night') localStorage.setItem('networth.theme', choice);
    else localStorage.removeItem('networth.theme');
  } catch { /* storage may be unavailable; the attribute is enough for this visit */ }
}

function registerWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    rememberSeen();
  } else {
    const seen = store.state.meta.lastSeen;
    if (seen && nowMs() - seen.at > 10 * 60 * 1000) store.setUi({ seen });
    autoSync();
    autoShare();
    autoInbox();
    autoIncome();
    schedule();
  }
}

/** Remember where the hero number stood, for "since you last looked". */
function rememberSeen() {
  const state = store.state;
  if (!state || (state.meta.origin !== 'bank' && !store.status.readonly) || !state.accounts.length) return;
  try {
    const live = makeDerived(state, nowMs()).position.live;
    if (Number.isFinite(live)) store.update((s) => { s.meta.lastSeen = { at: nowMs(), cents: Math.round(live) }; }, { silent: true });
  } catch { /* never block leaving the page */ }
}

/* ------------------------------------------------------------------ demo */

/** A document a few days after linking: too little history for a match, a salary or a Book. */
function thinDemoState(now) {
  const state = defaultState(now);
  state.meta.origin = 'demo';
  mergeFeed(state, demoFeed(now, { days: 9 }), now);
  refresh(state, now);
  return state;
}

function enterDemo(kind = 'full') {
  if (store.status.readonly) return;
  savedDocBeforeDemo = store.state;
  store.load(kind === 'thin' ? thinDemoState(nowMs()) : buildDemoState(nowMs()), { readonly: true });
  store.setUi({ seen: store.state.meta.lastSeen });
}

function leaveDemo() {
  if (!store.status.readonly) return;
  store.load(savedDocBeforeDemo || defaultState(nowMs()));
  savedDocBeforeDemo = null;
  store.setUi({ seen: store.state.meta.lastSeen });
}

/* --------------------------------------------------------------- actions */

const appActions = {
  'app.move': () => openSheet('move'),
  'app.cover': () => store.update((s) => { s.settings.cover = !s.settings.cover; }),
  'app.refresh': () => { refreshAndSay(); },
  'app.reload': () => { reloadNow(); },
  'app.demo': () => { enterDemo(); navigate('#/board'); },
  'app.leave-demo': () => { leaveDemo(); navigate('#/connect', { replace: true }); },
  'app.undo': () => { const label = store.undo(); if (label) toast('Undone: ' + String(label).replace(/[.]+$/, '') + '.'); },
  'app.sheet': ({ data }) => {
    const { sheet, ...rest } = data;
    const params = {};
    for (const k in rest) if (k !== 'action') params[k] = rest[k];
    if (sheet) openSheet(sheet, params);
  },
  'app.sheet-close': () => closeSheet(),
  'app.go': ({ data }) => { if (data.to) navigate(data.to); },
};

/* --------------------------------------------------------------- refresh */

let refreshing = null;

/**
 * The refresh, one function for every control (the top bar, Settings, the sync mark, the pull, Command-R):
 * (a) a newer version is loaded first (the page reloads and comes back here with `updated`); (b) the bank is
 * read through the manual path, within its 15-minute minimum and the day's budget; (c) a sharing round and
 * an inbox reading and a reading of income/, when sharing is on. Then one toast. Two controls at once share one run.
 * @returns {Promise<{ line: string, short: string }>}
 */
function refreshAndSay(opts = {}) {
  if (!refreshing) {
    refreshing = runRefresh(opts).finally(() => { refreshing = null; });
    refreshing.then((r) => { if (r && r.line) toast(r.line); }, () => {});
  }
  return refreshing;
}

async function runRefresh({ afterReload = false } = {}) {
  // after the reload the page says it is updated only when the reload brought the new build; if it brought the
  // old page back, the version is not asked again (the loop guard) and the "Reload" line stays offered
  let version = afterReload && reachedAttempt() ? 'updated' : 'unknown';
  if (!afterReload) {
    const v = await checkVersion();
    version = v.status;
    // the page is going away; the refresh goes on after the reload
    if (v.status === 'newer' && !store.status.readonly && await reloadTo(v.build, { afterwards: true })) return new Promise(() => {});
  }
  const lead = version === 'updated' ? 'Networth is updated to its newest version.' : '';
  const say = (line, short) => ({ line: (lead ? lead + (line ? ' ' + line : '') : line), short });
  const at = fmtTime(nowMs());
  if (store.status.readonly) {
    if (lead) return say('', 'Updated \u00b7 ' + at);
    return say(version === 'same' ? 'Sample game: Networth is the newest version, checked at ' + at + '.' : 'Sample game: checked at ' + at + '.', 'Sample game \u00b7 ' + at);
  }
  let bank;
  if (!syncInfo().linked) bank = say('Checked at ' + at + '; no bank is linked on this device.', 'Checked \u00b7 ' + at);
  else bank = await readBank();
  const sh = shareInfo();
  if (sh.available && sh.on) {
    autoInbox();
    // the income another app reported is read in every refresh too (3.7)
    await Promise.race([Promise.all([shareNow().catch(() => {}), autoIncome()]), new Promise((r) => { setTimeout(r, 8000); })]);
  }
  return bank;

  async function readBank() {
    const res = await syncNow({ manual: true });
    const info = syncInfo();
    const now = nowMs();
    const t = fmtTime(now);
    if (res.skipped) {
      if (res.code === 'quota' && info.waitMs > 0) {
        return say('The day\u2019s ' + QUOTA.perDay + ' readings are used; the next opens at ' + fmtTime(now + info.waitMs) + '.', 'Next reading ' + fmtTime(now + info.waitMs));
      }
      if (res.code === 'cooldown' && info.waitMs > 0) {
        const reqs = (store.state.sync.requests || []).filter(Number.isFinite);
        const last = reqs.length ? Math.max(...reqs) : info.lastOk;
        const lastAt = Number.isFinite(last) ? last : now;
        return say('Up to date. The bank was read at ' + fmtTime(lastAt) + '; the next reading opens at ' + fmtTime(now + info.waitMs) + '.', 'Up to date \u00b7 ' + fmtTime(lastAt));
      }
      return say('Checked at ' + t + '.', 'Checked \u00b7 ' + t);
    }
    if (!res.ok) return say(res.message ? String(res.message).replace(/\.?$/, '') + ' (' + t + ').' : 'The bank could not be read at ' + t + '.', 'Not read \u00b7 ' + t);
    const n = res.added || 0;
    return say('Read the bank at ' + t + ': ' + (n ? n + (n === 1 ? ' new transaction.' : ' new transactions.') : 'nothing new.'), (n ? n + ' new' : 'Up to date') + ' \u00b7 ' + t);
  }
}

/* ---------------------------------------------------------------- render */

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}

function buildContext() {
  const state = store.state;
  const now = nowMs();
  return {
    state,
    ui: store.ui,
    now,
    today: gameDay(now, state.settings.rolloverHour),
    route: currentRoute(),
    d: makeDerived(state, now),
    demo: store.status.readonly,
    sync: syncInfo(),
    share: shareInfo(),
    inbox: inboxInfo(),
    income: incomeInfo(),
    wide: typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true,
  };
}

function render() {
  if (!els || !store.state) return;
  const ctx = buildContext();
  setContext(ctx);

  const ready = ctx.demo || (ctx.state.meta.origin === 'bank' && ctx.state.accounts.length > 0);
  const viewId = ready ? (VIEWS[ctx.route.view] ? ctx.route.view : 'board') : 'connect';
  const view = VIEWS[viewId];
  const framed = viewId !== 'connect';

  els.page.setAttribute('data-view', viewId);
  for (const el of [els.page, els.sheetHost]) {
    if (ctx.state.settings.cover) el.setAttribute('data-cover', '');
    else el.removeAttribute('data-cover');
  }

  morph(els.banner, html`${updateLine()}${framed ? banner(ctx) : unsavedBanner()}`);
  morph(els.mast, framed ? masthead(ctx, viewId) : '');
  const redrawn = viewChanged(ctx, viewId);
  if (redrawn) morph(els.view, guarded(() => view.render(ctx), view.title));
  morph(els.foot, framed ? footer(ctx) : '');
  morph(els.tabs, framed ? tabbar(viewId) : '');

  const sheet = ctx.route.sheet && SHEETS[ctx.route.sheet.name];
  if (sheet) {
    const label = typeof sheet.label === 'function' ? sheet.label(ctx, ctx.route.sheet.params) : sheet.label;
    showSheet(guarded(() => sheet.render(ctx, ctx.route.sheet.params), label), { label });
  } else {
    hideSheet();
    if (ctx.route.sheet) closeSheet();
  }

  document.title = viewId === 'board' ? 'Networth' : 'Networth — ' + view.title;
  if (viewId === 'board' && redrawn) rememberNotes(ctx);
  // an address that names no screen shows the Board, and the address bar says so (after this render, not inside it)
  if (ready && !VIEWS[ctx.route.view]) queueMicrotask(() => navigate('#/board', { replace: true }));
}

/*
 * Skipping a screen whose output cannot have changed. A screen is drawn from the record, the
 * route without its sheet, the screen-level UI state, the game day, the width, the sync and save
 * status, and (through the live position) the clock. Typing in a sheet changes only sheet state
 * (SHEET_UI) and the 30-second tick changes only the clock, so both leave the key as it was and
 * the screen underneath is not redrawn. The live figure is compared to the cent it has reached
 * (R5), which is all a static label prints of it; the ticking hero animates itself. Settings and
 * the first-run screen are cheap and print times of day, so they are always redrawn.
 */
const SHEET_UI = new Set(['move', 'adjourn', 'txError', 'accountErrors']);
const ALWAYS_DRAWN = new Set(['settings', 'connect']);
let lastView = null;

function viewChanged(ctx, viewId) {
  const ui = {};
  for (const k of Object.keys(ctx.ui)) if (!SHEET_UI.has(k)) ui[k] = ctx.ui[k];
  const sync = { ...ctx.sync, waitMs: Math.ceil((ctx.sync && ctx.sync.waitMs || 0) / 60000) };
  const key = JSON.stringify([viewId, ctx.route.view, ctx.route.segs || [], ctx.route.params || {}, ui, ctx.today, ctx.wide,
    ctx.demo, !!ctx.state.settings.cover, sync, store.status]);
  if (ALWAYS_DRAWN.has(viewId)) { lastView = null; return true; }
  let cent = null;
  try { cent = Math.floor(ctx.d.position.live); } catch { cent = null; }
  const prev = lastView;
  if (prev && prev.state === ctx.state && prev.rev === store.rev && prev.key === key && prev.cent === cent) return false;
  lastView = { state: ctx.state, rev: store.rev, key, cent };
  return true;
}

/** A view that throws shows its error in place instead of blanking the app. */
function guarded(draw, title) {
  try {
    return draw();
  } catch (err) {
    console.error('[view] ' + title + ' failed to render', err);
    return html`<section class="shell-error" role="alert">
      <p class="lab"><b>${title}</b> could not be drawn</p>
      <p class="cap">${String(err && err.message ? err.message : err)}</p>
      <p><a class="btn-link" href="#/settings">Settings</a></p>
    </section>`;
  }
}

/** Record which coach's notes were shown (first day only) so they do not repeat for two weeks. */
function rememberNotes(ctx) {
  let notes;
  try { notes = ctx.d.notes; } catch { return; }
  const seen = ctx.state.meta.notesSeen;
  const fresh = notes.filter((n) => n && n.key && !seen[n.key]);
  const cutoff = addDays(ctx.today, -NOTE_MEMORY_DAYS);
  const stale = Object.keys(seen).filter((k) => seen[k] < cutoff);
  if (!fresh.length && !stale.length) return;
  store.update((s) => {
    for (const k of stale) delete s.meta.notesSeen[k];
    for (const n of fresh) s.meta.notesSeen[n.key] = ctx.today;
  }, { silent: true });
}

/* ----------------------------------------------------------------- frame */

function timePhrase(ms) {
  const h = new Date(ms).getHours();
  const part = h < 5 ? 'at night' : h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : h < 21 ? 'in the evening' : 'at night';
  return fmtTime(ms).replace(/ [AP]M$/, '') + ' ' + part;
}

function roundLine(ctx) {
  if (!ctx.state.meta.matchStart) return '';
  return 'Round ' + parts(ctx.today).d + ' of ' + daysInMonth(monthOf(ctx.today));
}

/** How fresh the bank data is: a state for the masthead's sync mark and one quiet line. */
function syncStatus(ctx) {
  if (ctx.demo) return { state: 'sample', lead: 'Sample game', rest: '' };
  const s = ctx.sync;
  if (s.busy) return { state: 'syncing', lead: (s.step || 'Checking the bank') + '…', rest: '' };
  if (!s.linked || s.status === 'relink') return { state: 'reconnect', lead: 'Reconnect the bank', rest: '' };
  if (!s.lastOk) return { state: 'old', lead: 'Waiting', rest: ' for the first sync' };
  const at = ctx.d.position.dataAt || s.lastOk;
  const age = diffDays(gameDay(at, ctx.state.settings.rolloverHour), ctx.today);
  const failed = s.status === 'error' ? ' · the last check did not go through' : '';
  if (age <= 0) return { state: 'fresh', lead: 'Bank data', rest: ' from ' + fmtTime(at) + failed };
  if (age === 1) return { state: 'aging', lead: 'Bank data', rest: ' from yesterday, ' + fmtTime(at) + failed };
  return { state: 'old', lead: 'Bank data', rest: ' ' + age + ' days old' + failed };
}

function syncMark(ctx) {
  const st = syncStatus(ctx);
  const inner = html`<i class="sync-mark"></i><span class="sync-text"><b>${st.lead}</b>${st.rest}</span>`;
  if (st.state === 'reconnect') return html`<a class="sync" data-state="reconnect" href="#/settings">${inner}</a>`;
  if (st.state === 'sample' || st.state === 'syncing') return html`<p class="sync" data-state="${st.state}">${inner}</p>`;
  return html`<button class="sync" type="button" data-state="${st.state}" data-action="app.refresh" title="Check the bank now">${inner}</button>`;
}

/** A save that did not go through is said on every screen, and goes away when a later save succeeds. */
function unsavedBanner() {
  const status = store.status;
  if (status.readonly || !(status.error || status.mode === 'memory')) return '';
  const reason = String(status.error || 'this window cannot store anything').replace(/\.+$/, '');
  const last = status.savedAt ? html` The last save that went through was at ${fmtTime(status.savedAt)}.` : '';
  return html`<div class="shell-banner is-unsaved" role="alert">
    <span class="lab"><b class="spot">Not saved</b><i class="sep"></i>${reason.charAt(0).toLowerCase() + reason.slice(1)}.${last} Save a copy from Settings.</span>
    <a class="btn-link" href="#/settings">Settings</a>
  </div>`;
}

/** A newer version is deployed but was not loaded (the app was busy, or a reload brought the old page back). */
function updateLine() {
  if (!pendingBuild()) return '';
  return html`<div class="shell-banner" role="status">
    <span class="lab"><b>A newer version of Networth</b><i class="sep"></i>ready to load</span>
    <button class="btn-link" type="button" data-action="app.reload">Reload</button>
  </div>`;
}

function banner(ctx) {
  if (!ctx.demo) return unsavedBanner();
  return html`<div class="shell-banner" role="note">
    <span class="lab"><b>Sample game</b><i class="sep"></i>invented figures<i class="sep"></i>nothing is saved</span>
    <button class="btn-link" type="button" data-action="app.leave-demo">Link your bank</button>
  </div>`;
}

function masthead(ctx, viewId) {
  const rounds = roundLine(ctx);
  const covered = ctx.state.settings.cover;
  const coverButton = html`<button class="btn-link" type="button" data-action="app.cover" aria-pressed="${covered ? 'true' : 'false'}">${covered ? 'Uncover' : 'Cover'}</button>`;
  const refreshButton = html`<button class="btn-link" type="button" data-action="app.refresh" title="Load a newer version, read the bank and share">Refresh</button>`;
  return html`<header class="mast">
    <div class="mast-top">
      <p class="mast-ear mast-ear-l">
        <span class="lab"><b><span class="only-wide">${fmtDate(ctx.today, 'long')}</span><span class="only-narrow">${fmtDate(ctx.today, 'dowshort')} · ${fmtTime(ctx.now)}</span></b></span>
        <span class="cap only-wide">${timePhrase(ctx.now)}</span>
        <span class="lab only-narrow">${rounds}</span>
      </p>
      <div class="mast-plate">
        <a class="wordmark" href="#/board" aria-label="Networth, the board">Networth</a>
        <span class="lab mast-sub">${fmtMonth(monthOf(ctx.today))}${rounds ? html`<i class="sep"></i><b>${rounds}</b>` : ''}</span>
      </div>
      <div class="rule-double mast-rule" aria-hidden="true"></div>
      <div class="mast-ear mast-ear-r">
        ${syncMark(ctx)}
        <span class="cap only-wide">Italic figures marked ≈ are computed.</span>
        <span class="mast-ear-tools only-narrow">${refreshButton}${coverButton}<a class="btn-link" href="#/settings" ${viewId === 'settings' ? html`aria-current="page"` : ''}>Settings</a></span>
      </div>
    </div>
    <div class="mast-nav">
      <nav class="mast-links" aria-label="Sections">
        ${NAV.map((id) => html`<a href="#/${id}" ${id === viewId ? html`aria-current="page"` : ''}>${VIEWS[id].title}</a>`)}
        <a href="#/settings" ${viewId === 'settings' ? html`aria-current="page"` : ''}>Settings</a>
      </nav>
      <div class="mast-tools">
        ${refreshButton}
        ${coverButton}
        <button class="btn btn-solid btn-s" type="button" data-action="app.move"><span class="plus">+</span> Move</button>
      </div>
    </div>
  </header>`;
}

function tabbar(viewId) {
  const link = (id) => html`<a href="#/${id}" ${id === viewId ? html`aria-current="page"` : ''}>${VIEWS[id].title}</a>`;
  return html`<nav class="tabbar" aria-label="Sections">
    ${link('board')}${link('scoresheet')}
    <button class="tabbar-move" type="button" data-action="app.move"><span class="plus">+</span> Move</button>
    ${link('material')}${link('book')}${link('analysis')}
  </nav>`;
}

function footer(ctx) {
  return html`<footer class="colophon">
    <p>Networth is kept on this device only: no server, no account, no tracking. It asks your bank feed for
      read-only updates and nothing else. Roman figures come from the bank; italic figures marked ≈ are estimates and are never presented as verified.${ctx.demo ? ' You are looking at a sample game with invented figures.' : ''}</p>
  </footer>`;
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  const root = document.getElementById('app');
  if (root) root.textContent = 'Networth could not start: ' + (err && err.message ? err.message : err);
});
