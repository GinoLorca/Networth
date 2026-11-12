/**
 * Persistence for the single Networth document. Nothing here touches the network.
 *
 * Three layers, so work is never lost silently:
 *   1. IndexedDB     — primary store (async, roomy), plus one automatic snapshot per day (last 14 days).
 *   2. localStorage  — a mirror written whenever the page is hidden or closed, and the fallback
 *                      when IndexedDB is unavailable (some private windows, some file:// contexts).
 *   3. memory        — nothing can be saved. The UI must say so and offer a backup export.
 *
 * On load the newest copy (by meta.savedAt) wins.
 */

const DB_VERSION = 1;
const KV = 'kv';
const SNAPSHOTS = 'snapshots';
const DOC_KEY = 'doc';
const KEEP_SNAPSHOTS = 14;

let namespace = '';
let mode = 'memory'; // 'indexeddb' | 'localstorage' | 'memory'
let dbPromise = null;

function dbName() { return 'networth' + (namespace ? '-' + namespace : ''); }
function lsKey() { return 'networth.doc.v1' + (namespace ? '.' + namespace : ''); }

function openIdb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB is not available');
      req = indexedDB.open(dbName(), DB_VERSION);
    } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB failed to open'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

function withStore(storeName, access, work) {
  return dbPromise.then((db) => new Promise((resolve, reject) => {
    let result;
    const tx = db.transaction(storeName, access);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    const req = work(tx.objectStore(storeName));
    if (req) req.onsuccess = () => { result = req.result; };
  }));
}

function lsAvailable() {
  try {
    const k = '__networth_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

function lsRead() {
  try {
    const text = localStorage.getItem(lsKey());
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

/**
 * Open storage. Call once at boot.
 * @param {{ ns?: string }} [opts] ns isolates a separate document (used by tests).
 * @returns {Promise<{ mode: 'indexeddb'|'localstorage'|'memory' }>}
 */
export async function initStorage(opts = {}) {
  namespace = (opts.ns || '').replace(/[^a-z0-9_-]/gi, '');
  try {
    dbPromise = openIdb();
    await dbPromise;
    mode = 'indexeddb';
  } catch {
    dbPromise = null;
    mode = lsAvailable() ? 'localstorage' : 'memory';
  }
  return { mode };
}

export function storageMode() { return mode; }

/** Load the newest saved document, or null when nothing has been saved yet. */
export async function loadDoc() {
  let fromIdb = null;
  if (mode === 'indexeddb') {
    try { fromIdb = await withStore(KV, 'readonly', (s) => s.get(DOC_KEY)); } catch { fromIdb = null; }
  }
  const fromLs = lsRead();
  const a = fromIdb && fromIdb.meta ? fromIdb.meta.savedAt || 0 : -1;
  const b = fromLs && fromLs.meta ? fromLs.meta.savedAt || 0 : -1;
  if (a < 0 && b < 0) return null;
  return b > a ? fromLs : fromIdb;
}

/**
 * Save the document. Resolves with { ok, mode, error }. Never throws.
 * In 'memory' mode ok is false: the caller must surface "not saved".
 */
export async function saveDoc(doc) {
  if (mode === 'indexeddb') {
    try {
      await withStore(KV, 'readwrite', (s) => s.put(doc, DOC_KEY));
      return { ok: true, mode, error: null };
    } catch (err) {
      const mirrored = mirrorDoc(doc);
      return { ok: mirrored, mode: mirrored ? 'localstorage' : 'memory', error: mirrored ? null : 'Browser storage is full or blocked' };
    }
  }
  if (mode === 'localstorage') {
    const ok = mirrorDoc(doc);
    return { ok, mode, error: ok ? null : 'Browser storage is full or blocked' };
  }
  return { ok: false, mode, error: 'Storage is unavailable in this window' };
}

/**
 * Synchronous best-effort copy to localStorage (safe to call from pagehide). Returns success.
 * With { dropStale: true } (the mirror beside IndexedDB), a copy that cannot be written removes the
 * older copy, so a stale record is never offered at the next load. mirrorProblem() says why it failed.
 * @param {object} doc
 * @param {{ dropStale?: boolean }} [opts]
 */
export function mirrorDoc(doc, opts = {}) {
  try {
    localStorage.setItem(lsKey(), JSON.stringify(doc));
    lastMirrorProblem = null;
    return true;
  } catch (err) {
    const quota = !!err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
    lastMirrorProblem = quota ? 'too large' : 'blocked';
    if (opts.dropStale) { try { localStorage.removeItem(lsKey()); } catch { /* nothing to remove */ } }
    return false;
  }
}

let lastMirrorProblem = null;

/** Why the last localStorage copy was not written: 'too large' | 'blocked', or null when it was. */
export function mirrorProblem() {
  return lastMirrorProblem;
}

/** Keep one automatic snapshot per calendar day (first save of the day), pruning to the last 14. */
export async function snapshotDaily(doc, day) {
  if (mode !== 'indexeddb') return false;
  try {
    const existing = await withStore(SNAPSHOTS, 'readonly', (s) => s.getKey(day));
    if (existing) return false;
    await withStore(SNAPSHOTS, 'readwrite', (s) => s.put({ day, savedAt: Date.now(), doc }, day));
    const keys = await withStore(SNAPSHOTS, 'readonly', (s) => s.getAllKeys());
    const stale = keys.sort().slice(0, Math.max(0, keys.length - KEEP_SNAPSHOTS));
    for (const k of stale) await withStore(SNAPSHOTS, 'readwrite', (s) => s.delete(k));
    return true;
  } catch { return false; }
}

/** @returns {Promise<Array<{ day: string, savedAt: number }>>} newest first */
export async function listSnapshots() {
  if (mode !== 'indexeddb') return [];
  try {
    const all = await withStore(SNAPSHOTS, 'readonly', (s) => s.getAll());
    return all.map((x) => ({ day: x.day, savedAt: x.savedAt })).sort((p, q) => (p.day < q.day ? 1 : -1));
  } catch { return []; }
}

export async function loadSnapshot(day) {
  if (mode !== 'indexeddb') return null;
  try {
    const rec = await withStore(SNAPSHOTS, 'readonly', (s) => s.get(day));
    return rec ? rec.doc : null;
  } catch { return null; }
}

/** Erase the saved document (snapshots are kept unless all is true). */
export async function wipeStorage({ all = false } = {}) {
  try { localStorage.removeItem(lsKey()); } catch { /* ignore */ }
  if (all) { try { localStorage.removeItem('networth.theme'); } catch { /* ignore */ } } // the saved theme is the owner's too
  if (mode === 'indexeddb') {
    try {
      await withStore(KV, 'readwrite', (s) => s.delete(DOC_KEY));
      if (all) await withStore(SNAPSHOTS, 'readwrite', (s) => s.clear());
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ secrets
 * The bank-feed access credential lives here and ONLY here: on this device, outside the
 * document, so it can never end up in a backup, a pairing link or a screenshot.
 */

const SECRET_KEY = 'feed-access';
function lsSecretKey() { return 'networth.secret.v1' + (namespace ? '.' + namespace : ''); }

/** Store the bank-feed credential on this device. Resolves true when it was stored. */
export async function saveSecret(value) {
  if (mode === 'indexeddb') {
    try { await withStore(KV, 'readwrite', (s) => s.put(value, SECRET_KEY)); return true; } catch { /* fall through */ }
  }
  try { localStorage.setItem(lsSecretKey(), JSON.stringify(value)); return true; } catch { return false; }
}

/** Read the bank-feed credential, or null when this device is not linked. */
export async function loadSecret() {
  if (mode === 'indexeddb') {
    try {
      const v = await withStore(KV, 'readonly', (s) => s.get(SECRET_KEY));
      if (v != null) return v;
    } catch { /* fall through */ }
  }
  try {
    const text = localStorage.getItem(lsSecretKey());
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

/** Forget the bank-feed credential on this device. */
export async function wipeSecret() {
  if (mode === 'indexeddb') {
    try { await withStore(KV, 'readwrite', (s) => s.delete(SECRET_KEY)); } catch { /* ignore */ }
  }
  try { localStorage.removeItem(lsSecretKey()); } catch { /* ignore */ }
}
