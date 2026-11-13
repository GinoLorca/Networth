/**
 * Sharing between the owner's devices: keeping the payments they send, and their ticks, in step with
 * one private file on their own GitHub. See ARCHITECTURE.md section 3.5.
 *
 * The key is read from device storage (db.js) at the start of a round and handed to the transport
 * (github.js); it lives in that round's own variable and nowhere else in this module, and is never put
 * in the document, the interface state, a log line or an error message. What a round does is decided by model/share.js;
 * this file only says when one runs and what the interface is told.
 *
 * Rounds never overlap. Pasting or forgetting a key marks the running round stale and waits for it to
 * end; the round checks that it is not stale before every read and every write, so nothing is sent
 * with a key that has been replaced or forgotten. A key GitHub refused is remembered with the key, in
 * its own slot (db.js), across loads: while it is, no round runs by itself; "Share now" may still try.
 */

import { store } from './store.js';
import { loadShareKey, loadShareRefused, refuseShareKey, saveShareKey, wipeShareKey } from './db.js';
import { nowMs } from './model/dates.js';
import { exportShared, roundShared, sameShared } from './model/share.js';
import { ShareError, isShareKey, readSharedText, shareMessage, shareOwner, writeSharedText } from './github.js';

/** However many changes are made, at most one round starts in any 2 seconds; a change is shared 2 seconds after it. */
const SPACING_MS = 2000;
/** After GitHub asks for a pause, nothing is asked of it for this long. */
const RATE_PAUSE_MS = 10 * 60 * 1000;
const CODES = new Set(['key', 'missing', 'conflict', 'network', 'server', 'rate', 'file']);
const OTHER = 'Sharing stopped on this device before anything was sent. Nothing was changed on GitHub.';

const live = {
  /** whose repository, read from the page's address; null when this page shares with nobody */
  owner: null,
  /** this device holds a key */
  on: false,
  busy: false,
  /** the last round's error code, null after one that agreed */
  code: null,
  failedAt: null,
  /** when this device and the file last agreed, how many payments, and whether GitHub showed a file */
  agreedAt: null,
  count: 0,
  file: true,
  /** no round before this time (GitHub asked for a pause) */
  pauseUntil: 0,
};

/** Counts every key pasted or forgotten. A round that started under an older number tells the interface nothing. */
let generation = 0;
/** the running round, until it has ended */
let current = null;
/** a key is being pasted or forgotten: no round starts meanwhile */
let held = 0;
let timer = null;
let timerAt = 0;
let lastStart = -Infinity;
/** a change was made, or a round was asked for, while one was running */
let again = false;
/** the round itself is changing the document: that change is not the owner's and asks for no round */
let applying = false;
let seenRev = -1;
let seenDoc = null;
let lastExport = null;

function doFetch(url, init) {
  return fetch(url, init);
}

function poke() {
  store.setUi({ shareTick: (store.ui.shareTick || 0) + 1 });
}

function usable() {
  return !!live.owner && live.on && held === 0 && !!store.state && !store.status.readonly;
}

/** The store changed: when what this device would write is no longer what it was, a round is due in 2 seconds. */
function watch() {
  if (store.rev === seenRev && store.state === seenDoc) return;
  seenRev = store.rev;
  seenDoc = store.state;
  if (!usable()) { lastExport = null; return; }
  const now = exportShared(store.state, 0);
  const changed = lastExport !== null && !sameShared(now, lastExport);
  lastExport = now;
  if (changed && !applying) ask(SPACING_MS, false);
}

/** Ask for a round `delay` ms from now, never sooner than 2 seconds after the last one started. */
function ask(delay, manual) {
  if (!usable()) return;
  if (!manual && live.code === 'key') return; // a refused key is not tried again by itself
  if (nowMs() < live.pauseUntil) return;
  if (live.busy) { again = true; return; }
  const at = Math.max(Date.now() + delay, lastStart + SPACING_MS);
  if (timer !== null && timerAt <= at) return;
  if (timer !== null) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => { timer = null; run().catch(() => {}); }, Math.max(0, at - Date.now()));
}

async function run() {
  if (!usable() || nowMs() < live.pauseUntil) return;
  if (live.busy || current) { again = true; return; }
  current = round();
  try { await current; } finally { current = null; }
}

/** Wait until no round is running. */
async function idle() {
  while (current) await current.catch(() => {});
}

async function round() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const gen = generation;
  const stale = () => gen !== generation || !store.state || store.status.readonly;
  live.busy = true;
  lastStart = Date.now();
  again = false;
  poke();
  let result = null;
  let code = null;
  let key = null;
  try {
    try {
      key = await loadShareKey();
      if (stale()) return;
      if (!isShareKey(key)) throw new ShareError('key');
      const owner = live.owner;
      const device = {
        state: () => store.state,
        stale,
        update: (change, past) => {
          applying = true;
          try { store.update(change, { past }); } finally { applying = false; }
        },
      };
      const transport = {
        read: () => readSharedText(owner, key, doFetch),
        write: (text, sha) => writeSharedText(owner, key, text, sha, doFetch),
      };
      result = await roundShared(device, transport, nowMs);
    } catch (err) {
      // only the code is kept: nothing an error says is shown or logged
      code = err && typeof err.code === 'string' && CODES.has(err.code) ? err.code : 'other';
    }
    try {
      // the refusal is kept with the key; a round that agreed takes it away (Share now worked)
      if (gen === generation && code === 'key' && isShareKey(key)) await refuseShareKey(key);
      else if (gen === generation && result && result.ok && await loadShareRefused()) await saveShareKey(key);
    } catch { /* a slot the browser would not write: the refusal then holds for this page only */ }
  } finally {
    live.busy = false;
    if (gen === generation) {
      if (code) {
        live.code = code;
        live.failedAt = nowMs();
        if (code === 'rate') live.pauseUntil = nowMs() + RATE_PAUSE_MS;
      } else if (result && result.ok) {
        live.code = null;
        live.agreedAt = nowMs();
        live.count = result.count || 0;
        live.file = result.file !== false;
      }
      if (store.state && usable()) lastExport = exportShared(store.state, 0);
    }
    poke();
    if (gen === generation && again && !code) ask(0, false); // a change made while the round ran
  }
}

/**
 * Read where this page shares and whether this device holds a key. Call once at boot, after the
 * document is loaded.
 * @param {{ hostname: string, search: string }} where  the page's address
 * @returns {Promise<boolean>} true when this device shares
 */
export async function initShare(where) {
  live.owner = shareOwner(where);
  if (!live.owner) return false;
  live.on = isShareKey(await loadShareKey());
  if (live.on && await loadShareRefused()) live.code = 'key'; // refused at an earlier load: no round by itself
  store.subscribe(watch);
  watch();
  return live.on;
}

/** A round if one may run (when the app has loaded its record, and when the page becomes visible again). Never throws. */
export function autoShare() {
  ask(0, false);
}

/**
 * The state of sharing for the interface.
 * @returns {{ available: boolean, owner: string|null, on: boolean, busy: boolean,
 *             state: 'off'|'working'|'error'|'ok'|'waiting', code: string|null, message: string|null,
 *             failedAt: number|null, agreedAt: number|null, count: number, file: boolean,
 *             retryAt: number|null, canShare: boolean }}
 */
export function shareInfo() {
  const paused = live.pauseUntil > nowMs();
  return {
    available: !!live.owner,
    owner: live.owner,
    on: live.on,
    busy: live.busy,
    state: !live.on ? 'off' : live.busy ? 'working' : live.code ? 'error' : live.agreedAt ? 'ok' : 'waiting',
    code: live.code,
    message: live.code ? (CODES.has(live.code) ? shareMessage(live.code) : OTHER) : null,
    failedAt: live.failedAt,
    agreedAt: live.agreedAt,
    count: live.count,
    file: live.file,
    retryAt: paused ? live.pauseUntil : null,
    canShare: usable() && !live.busy && !paused,
  };
}

/**
 * Keep the key the owner pasted on this device and run the first round with it.
 * @param {string} pasted
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function startShare(pasted) {
  const key = typeof pasted === 'string' ? pasted.trim() : '';
  if (!live.owner || !store.state || store.status.readonly) return { ok: false, message: 'Nothing is shared from this page.' };
  if (!isShareKey(key)) {
    return { ok: false, message: 'That is not a key: a key is 1 line of 20 or more characters without spaces. Nothing was stored.' };
  }
  generation++; // a round still running under the old key stops at its next step and reports nothing
  if (timer !== null) { clearTimeout(timer); timer = null; }
  held += 1;
  let saved = false;
  try {
    await idle();
    saved = await saveShareKey(key); // a key pasted takes the place of a refused one, and of its refusal
  } finally {
    held -= 1;
  }
  if (!saved) {
    return { ok: false, message: 'This browser would not store the key. Open Networth in a normal (not private) window and paste it 1 more time.' };
  }
  again = false;
  live.on = true;
  live.code = null;
  live.failedAt = null;
  seenRev = -1;
  watch();
  await shareNow();
  return live.code ? { ok: false, message: shareInfo().message } : { ok: true };
}

/** The owner asked for a round now. It starts at once, or as soon as 2 seconds have passed since the last one started. */
export async function shareNow() {
  if (current && held === 0) await idle(); // the round already running answers
  if (!usable() || live.busy || nowMs() < live.pauseUntil) return shareInfo();
  const wait = lastStart + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
  await run();
  return shareInfo();
}

/** Forget the key on this device. The list stays on the device and the file stays on GitHub. */
export async function forgetShare() {
  generation++; // a running round stops at its next step: nothing more is sent with this key
  if (timer !== null) { clearTimeout(timer); timer = null; }
  held += 1;
  try {
    await idle();
    await wipeShareKey();
  } finally {
    held -= 1;
  }
  again = false;
  live.on = false;
  live.code = null;
  live.failedAt = null;
  live.agreedAt = null;
  live.count = 0;
  live.file = true;
  lastExport = null;
  poke();
}

/** Counts every key pasted or forgotten: a reading of the card alert inbox (inbox.js) started under another number reports nothing. */
export function shareGeneration() {
  return generation;
}

/**
 * The card alert inbox (inbox.js) met a refused key or a rate answer with the same key: sharing takes
 * the same pause, so nothing more is asked of GitHub by itself until a new key, or for 10 minutes.
 * @param {'key'|'rate'} code
 * @param {string} key  the key the reading used (kept with its refusal, in its own slot)
 * @param {number} gen  the generation the reading started under
 */
export async function noteShareAnswer(code, key, gen) {
  if (gen !== generation || (code !== 'key' && code !== 'rate')) return;
  live.code = code;
  live.failedAt = nowMs();
  if (code === 'rate') live.pauseUntil = nowMs() + RATE_PAUSE_MS;
  else {
    try { if (isShareKey(key)) await refuseShareKey(key); } catch { /* the refusal then holds for this page only */ }
  }
  poke();
}
