/**
 * The store: one persisted document (`store.state`), one ephemeral UI object (`store.ui`).
 *
 *   store.update((s) => { s.txs.push(tx); }, { undo: 'Move added' });   // mutate in place, then save + re-render
 *   store.setUi({ filter: 'disc' });                                     // re-render only, never saved
 *   store.subscribe(() => scheduleRender());
 *
 * Saving is debounced and also forced when the page is hidden. If saving fails,
 * `store.status` says so and the shell shows it — the app never pretends data is safe.
 */

import { saveDoc, mirrorDoc, mirrorProblem, snapshotDaily, storageMode, loadDoc } from './db.js';
import { ymd, fmtTime } from './model/dates.js';
import { checkDoc, migrate } from './model/schema.js';
import { toast } from './runtime.js';

const SAVE_DELAY_MS = 350;
const UNDO_DEPTH = 20;

const subscribers = new Set();
let doc = null;
let ui = {};
let rev = 0;
let saveTimer = null;
let saving = null;
/** epoch ms of the latest change made in this page, for the note when a newer save elsewhere replaces it */
let editedAt = null;
const undoStack = [];
/** Called by undo() with (the document before the Undo, the document put back); see store.onRestore. */
let restoreHook = null;

const status = {
  /** 'indexeddb' | 'localstorage' | 'memory' | 'demo' */
  mode: 'memory',
  /** epoch ms of the last successful save, or null */
  savedAt: null,
  /** message when the last save failed, else null */
  error: null,
  /** true while there are unsaved changes */
  dirty: false,
  /** true in demo mode: nothing is ever written */
  readonly: false,
  /** the last-chance localStorage copy beside IndexedDB: null when written (or not yet tried),
      'too large' when the record no longer fits (the older copy is removed), 'blocked' otherwise */
  mirror: null,
};

function notify() {
  for (const fn of subscribers) {
    try { fn(); } catch (err) { console.error('[store] subscriber failed', err); }
  }
}

async function persist() {
  saveTimer = null;
  if (!doc || status.readonly) { status.dirty = false; return; }
  if (saving) { await saving; }
  doc.meta.savedAt = Date.now();
  const snapshot = doc;
  saving = saveDoc(snapshot).then((res) => {
    saving = null;
    status.mode = res.mode;
    if (res.ok) {
      status.savedAt = snapshot.meta.savedAt;
      status.error = null;
      announce(snapshot.meta.savedAt);
      if (!saveTimer) status.dirty = false;
      notify();
      return snapshotDaily(snapshot, ymd(Date.now()));
    }
    status.error = res.error || 'Could not save';
    notify();
    return false;
  });
  await saving;
}

/*
 * Two open copies of the app (two tabs, or the installed app beside a tab) share one record. Each save is announced;
 * a page that hears of a newer save by another page reads the stored record again instead of later writing its own
 * older copy over it.
 */
const PAGE_ID = Math.random().toString(36).slice(2);
let channel = null;
try { if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel('networth-record'); } catch { channel = null; }

function announce(savedAt) {
  if (!channel) return;
  try { channel.postMessage({ from: PAGE_ID, savedAt }); } catch { /* nothing to tell */ }
}

async function reloadFromStorage(msg) {
  if (!msg || msg.from === PAGE_ID || !doc || status.readonly) return;
  // A change made here that had not been saved yet (a save pending, or one in flight).
  const pending = !!saveTimer || status.dirty;
  const changedAt = editedAt;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saving) await saving;
  const stored = await loadDoc();
  if (!stored || checkDoc(stored) || !(stored.meta.savedAt > (doc.meta.savedAt || 0))) {
    if (pending && status.dirty && !saveTimer) schedulePersist();   // ours is the newer record: keep its save
    return;
  }
  const savedAt = stored.meta.savedAt;
  store.load(migrate(stored), { save: false });
  status.savedAt = savedAt;
  // Ruling T9: no replay of the lost change; the owner is told.
  if (pending && changedAt != null) {
    toast('A change made here at ' + fmtTime(changedAt) + ' was replaced by a newer save in another window.');
  }
}

if (channel) channel.onmessage = (event) => { reloadFromStorage(event && event.data).catch(() => {}); };

function schedulePersist() {
  status.dirty = true;
  if (status.readonly) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, SAVE_DELAY_MS);
}

export const store = {
  /** The persisted document (see model/schema.js). Mutate only inside store.update(). */
  get state() { return doc; },
  /** Ephemeral UI state (filters, drafts, toasts). Change with store.setUi(). */
  get ui() { return ui; },
  /** Increments on every state change; use it as a memo key for derived data. */
  get rev() { return rev; },
  get status() { return status; },

  /**
   * Install a document (at boot, on restore, when entering demo mode).
   * @param {object} newDoc
   * @param {{ readonly?: boolean, save?: boolean }} [opts]
   */
  load(newDoc, opts = {}) {
    doc = newDoc;
    doc.meta.rev = (doc.meta.rev || 0) + 1;
    status.readonly = !!opts.readonly;
    status.mode = status.readonly ? 'demo' : storageMode();
    status.error = null;
    status.dirty = false;
    undoStack.length = 0;
    rev++;
    if (opts.save && !status.readonly) schedulePersist();
    notify();
  },

  /**
   * Change the document. `mutator` receives the document and edits it in place.
   * @param {(state: object) => void} mutator
   * @param {{ undo?: string, silent?: boolean, past?: (state: object) => void }} [opts] undo: label for the undo toast
   *        (stores a pre-image). past: the same arrival made in every pre-image Undo holds, for a change that did not
   *        come from the owner (what another device sent), so that a later Undo does not take it back.
   */
  update(mutator, opts = {}) {
    if (!doc) return;
    if (opts.undo) {
      undoStack.push({ label: opts.undo, json: JSON.stringify(doc) });
      if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    }
    if (typeof opts.past === 'function') {
      for (const entry of undoStack) {
        try {
          const copy = JSON.parse(entry.json);
          opts.past(copy);
          entry.json = JSON.stringify(copy);
        } catch { /* that pre-image stays as it was */ }
      }
    }
    mutator(doc);
    rev++;
    doc.meta.rev = (doc.meta.rev || 0) + 1;
    editedAt = Date.now();
    schedulePersist();
    if (!opts.silent) notify();
  },

  /** Merge a patch into the UI state and re-render. */
  setUi(patch) {
    Object.assign(ui, patch);
    notify();
  },

  /** Label of the most recent undoable change, or null. */
  get undoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : null; },

  /** Revert the most recent undoable change. Returns its label, or null when there is nothing to undo. */
  undo() {
    const entry = undoStack.pop();
    if (!entry) return null;
    const revNow = (doc.meta.rev || 0) + 1;
    const before = doc;
    doc = JSON.parse(entry.json);
    doc.meta.rev = revNow;
    if (restoreHook) {
      try { restoreHook(before, doc); } catch (err) { console.error('[store] restore hook failed', err); }
    }
    rev++;
    editedAt = Date.now();
    schedulePersist();
    notify();
    return entry.label;
  },

  /**
   * Register the one function `undo()` calls with (the document as it was just before the Undo, the
   * document just put back), before subscribers are told. It may change the document put back.
   * @param {((before: object, after: object) => void)|null} fn
   */
  onRestore(fn) {
    restoreHook = typeof fn === 'function' ? fn : null;
  },

  /** Run `fn` on every change (state or ui). Returns an unsubscribe function. */
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },

  /** Save now (used before export, and when the page is being hidden). */
  async flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (status.dirty) await persist();
  },

  /** Synchronous last-chance copy to localStorage; safe inside pagehide. */
  mirror() {
    if (!doc || status.readonly || !status.dirty) return;
    const ok = mirrorDoc(doc, { dropStale: storageMode() === 'indexeddb' });
    status.mirror = ok ? null : mirrorProblem();
  },
};

if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { store.mirror(); store.flush(); }
  });
  window.addEventListener('pagehide', () => store.mirror());
}
