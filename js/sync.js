/**
 * The bank link: connecting once, then keeping the document in step with the feed.
 * See ARCHITECTURE.md section 3.1.
 *
 * The access credential is read from and written to device storage (db.js secrets) and
 * handed to the feed adapter; it is never put in the document, the interface state, a log
 * line or an error message.
 */

import { store } from './store.js';
import { loadSecret, saveSecret, wipeSecret, wipeStorage } from './db.js';
import { nowMs } from './model/dates.js';
import { defaultState } from './model/schema.js';
import {
  parseSetupToken, claimAccess, fetchSimplefin, syncWindows, quotaAllows, historyAllowed, historyRequests, historyStep, isFirstReading,
  recordHistory, FeedError,
} from './model/feed.js';
import { mergeFeed } from './model/merge.js';
import { refresh } from './model/detect.js';

const DAY_MS = 24 * 3600 * 1000;
/** After a failed check, automatic syncs wait this long before trying again. */
const RETRY_AFTER_MS = 30 * 60 * 1000;

const live = {
  linked: false,
  busy: false,
  /** short description of what is happening, for the interface: 'Linking', 'Reading the latest days'… */
  step: '',
};

let inFlight = null;
/**
 * Counts every unlink and erase. A sync or a link that started under an older generation is abandoned:
 * it writes nothing to the document, the device storage or the interface state once the number has moved on.
 */
let generation = 0;

function doFetch(url, init) {
  return fetch(url, init);
}

function poke() {
  store.setUi({ syncTick: (store.ui.syncTick || 0) + 1 });
}

function noteRequest() {
  const t = nowMs();
  store.update((s) => {
    s.sync.requests = s.sync.requests.filter((x) => t - x < DAY_MS);
    s.sync.requests.push(t);
    s.sync.lastTry = t;
  }, { silent: true });
  return t;
}

/** A request that never left this device (no connection) is not one of the day's requests. */
function forgetRequest(t) {
  store.update((s) => {
    const i = s.sync.requests.lastIndexOf(t);
    if (i >= 0) s.sync.requests.splice(i, 1);
  }, { silent: true });
}

/** Read whether this device is linked. Call once at boot, after the document is loaded. */
export async function initSync() {
  const secret = await loadSecret();
  live.linked = !!secret;
  return live.linked;
}

/**
 * The state of the bank link for the interface.
 * @returns {{ linked: boolean, busy: boolean, step: string, status: string|null, lastOk: number|null,
 *             error: string|null, problems: object[], canRefresh: boolean, waitMs: number }}
 */
export function syncInfo() {
  const s = store.state ? store.state.sync : null;
  const allow = s && live.linked && !store.status.readonly
    ? quotaAllows(s.requests, s.lastOk, nowMs(), { manual: true, needed: 1 })
    : { ok: false, waitMs: 0 };
  return {
    linked: live.linked,
    busy: live.busy,
    step: live.step,
    status: s ? s.status : null,
    lastOk: s ? s.lastOk : null,
    error: s ? s.error : null,
    problems: s ? s.problems : [],
    canRefresh: !live.busy && allow.ok,
    waitMs: allow.waitMs || 0,
  };
}

function failure(err) {
  const code = err instanceof FeedError ? err.code : 'error';
  const message = err instanceof FeedError ? err.message : 'Something went wrong while reading the bank feed.';
  store.update((s) => {
    s.sync.status = code === 'relink' ? 'relink' : 'error';
    s.sync.error = message;
  });
  return { ok: false, code, message };
}

/**
 * Link this device to the bank feed with a SimpleFIN setup token, then run the first sync.
 * @param {string} token  the setup token the owner pasted
 * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
 */
export async function linkBank(token) {
  if (live.busy) return { ok: false, code: 'busy', message: 'A sync is already running.' };
  live.busy = true;
  live.step = 'Linking';
  poke();
  const gen = generation;
  try {
    const { claimUrl } = parseSetupToken(token);
    const access = await claimAccess(claimUrl, doFetch);
    if (gen !== generation) return { ok: false, skipped: true }; // erased or unlinked meanwhile: store nothing
    const stored = await saveSecret(access);
    if (!stored) throw new FeedError('server', 'This browser would not store the bank link. Open Networth in a normal (not private) window and try again.');
    live.linked = true;
    if (!store.state || store.status.readonly || store.state.meta.origin === 'demo') {
      store.load(defaultState(nowMs()), { save: true });
    }
    store.update((s) => {
      s.meta.origin = 'bank';
      s.sync.src = 'simplefin';
      s.sync.status = 'ok';
      s.sync.error = null;
    });
  } catch (err) {
    live.busy = false;
    live.step = '';
    poke();
    if (err instanceof FeedError) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: 'error', message: 'The bank link could not be completed. Try again in a moment.' };
  }
  live.step = 'Reading your accounts'; // stay busy across the hand-over to the first sync
  try {
    return await syncNow({ manual: true, first: true });
  } finally {
    live.busy = false;
    live.step = '';
    poke();
  }
}

/**
 * Bring the document up to date with the feed.
 * @param {{ manual?: boolean, first?: boolean }} [opts]  manual = the owner asked for it (shorter cool-down)
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, skipped?: boolean, added?: number }>}
 */
export function syncNow(opts = {}) {
  if (inFlight) return inFlight;
  const run = runSync(opts).finally(() => { if (inFlight === run) inFlight = null; });
  inFlight = run;
  return run;
}

/**
 * History for the accounts that need it (ARCHITECTURE 3.1), after the ordinary windows of a reading are merged.
 * What to ask, when, and what an answer means are decided by model/feed.js; this only makes the requests. An
 * account that is begun is followed step after step until it is done, a step is not had, a request fails or the
 * day's budget stops it. A request that fails ends the history part of this reading and nothing else.
 * @param {boolean} first  this is the device's first reading: nothing is asked
 * @returns {Promise<number>} transactions added
 */
async function readHistory(access, reading, stale, first) {
  let added = 0;
  /** @returns {Promise<'had'|'again'|'stop'>} */
  const ask = async (step) => {
    if (stale() || !historyAllowed(store.state, nowMs())) return 'stop';
    live.step = 'Reading earlier history';
    poke();
    const noted = noteRequest();
    let feed = null;
    try {
      feed = await fetchSimplefin(access, { fromMs: step.fromMs, toMs: step.toMs, pending: true, only: step.only }, doFetch, nowMs());
    } catch {
      if (stale()) return 'stop';
      // offline: the request never left this device, so it is neither one of the day's requests nor an attempt
      if (typeof navigator !== 'undefined' && navigator.onLine === false) forgetRequest(noted);
      else store.update((s) => { recordHistory(s, step, nowMs(), null); }, { silent: true });
      return 'stop';
    }
    if (stale()) return 'stop';
    feed.reading = reading;
    let book = null;
    try {
      store.update((s) => {
        added += mergeFeed(s, feed, nowMs()).added;
        book = recordHistory(s, step, nowMs(), feed);
      }, { silent: true });
    } catch {
      // an answer that could not be merged is an attempt like a request that failed: only its time is kept
      store.update((s) => { recordHistory(s, step, nowMs(), null); }, { silent: true });
      return 'stop';
    }
    return book && book.had ? 'had' : 'again';
  };
  for (const begun of historyRequests(store.state, nowMs(), first)) {
    let step = begun;
    let outcome = 'had';
    while (step && outcome === 'had') {
      outcome = await ask(step);
      const account = outcome === 'had' ? store.state.accounts.find((a) => a.id === step.accountId) : null;
      step = account ? historyStep(store.state, account, nowMs()) : null;
    }
    if (outcome === 'stop') break;
  }
  return added;
}

async function runSync(opts) {
  if (!store.state || store.status.readonly) return { ok: false, skipped: true };
  const gen = generation;
  const stale = () => gen !== generation;
  const access = await loadSecret();
  if (stale()) return { ok: false, skipped: true };
  live.linked = !!access;
  if (!access) return { ok: false, skipped: true };

  const windows = syncWindows(store.state, nowMs());
  const sync = store.state.sync;
  // After a failed check the 30-minute retry rule governs the automatic sync, not the 3-hour "fresh" rule:
  // a first reading that stopped halfway has a lastOk from its first window and would otherwise wait 3 hours.
  const lastOk = sync.status === 'error' ? null : sync.lastOk;
  const allow = quotaAllows(sync.requests, lastOk, nowMs(), { manual: !!opts.manual || !!opts.first, needed: windows.length });
  if (!allow.ok && !opts.first) return { ok: false, skipped: true, code: allow.reason };
  if (!opts.manual && !opts.first) {
    if (sync.status === 'relink') return { ok: false, skipped: true, code: 'relink' }; // the key is known to be revoked
    if (sync.status === 'error' && sync.lastTry && nowMs() - sync.lastTry < RETRY_AFTER_MS) return { ok: false, skipped: true, code: 'cooldown' };
  }

  live.busy = true;
  live.step = opts.first ? 'Reading your accounts' : 'Checking the bank';
  poke();
  let added = 0;
  let noted = null;
  const first = isFirstReading(store.state); // asked before any window of this run is merged
  const reading = nowMs(); // every feed of this run carries it: what a reading brought for an account is counted per run
  try {
    for (let i = 0; i < windows.length; i++) {
      if (stale()) return { ok: false, skipped: true };
      if (windows.length > 1) {
        live.step = i === windows.length - 1 ? 'Reading the latest days' : 'Reading earlier history';
        poke();
      }
      noted = noteRequest();
      const feed = await fetchSimplefin(access, { fromMs: windows[i].fromMs, toMs: windows[i].toMs, pending: true }, doFetch, nowMs());
      noted = null;
      if (stale()) return { ok: false, skipped: true }; // erased or unlinked while the bank was answering
      feed.reading = reading;
      store.update((s) => {
        const summary = mergeFeed(s, feed, nowMs());
        added += summary.added;
      }, { silent: true });
    }
    try {
      // the history part can never fail a reading: whatever goes wrong in it, the reading completes without it
      added += await readHistory(access, reading, stale, first);
    } catch {
      // nothing is reported and nothing is logged: the accounts are asked again at a later reading
    }
    if (stale()) return { ok: false, skipped: true };
    live.step = 'Working out the Book and your baseline';
    poke();
    store.update((s) => {
      refresh(s, nowMs());
      s.sync.status = 'ok';
      s.sync.error = null;
      s.sync.completed = true; // only here: a first reading that was interrupted is a first reading again
    });
    return { ok: true, added };
  } catch (err) {
    if (stale()) return { ok: false, skipped: true };
    // offline: the request never reached the Bridge, so it does not count against the day or hold Refresh back
    if (noted != null && typeof navigator !== 'undefined' && navigator.onLine === false) forgetRequest(noted);
    return failure(err); // the data already fetched is kept; a revoked key asks for a new link
  } finally {
    if (!stale()) {
      live.busy = false;
      live.step = '';
      poke();
    }
  }
}

/** Sync if it is due (on open, and whenever the page becomes visible again). Never throws. */
export function autoSync() {
  if (!live.linked || live.busy || !store.state || store.status.readonly) return;
  syncNow({ manual: false }).catch(() => {});
}

/**
 * Forget the bank link on this device. The data already fetched stays unless `erase` is true.
 * @param {{ erase?: boolean }} [opts]
 */
export async function unlinkBank(opts = {}) {
  generation++; // a sync or a link still waiting on the bank is abandoned: it will write nothing
  inFlight = null;
  live.busy = false;
  live.step = '';
  await wipeSecret();
  live.linked = false;
  if (opts.erase) {
    store.load(defaultState(nowMs()), { save: true });
    await store.flush();
    await wipeStorage({ all: true }); // the saved record and every daily snapshot
    await wipeSecret(); // once more, in case a link that was finishing stored the key meanwhile
  } else if (store.state) {
    store.update((s) => { s.sync.status = null; s.sync.error = null; s.sync.problems = []; });
  }
  poke();
}
