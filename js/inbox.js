/**
 * Card purchases within minutes: reading the inbox of card alerts the owner's phone writes to their
 * private repository. See ARCHITECTURE.md section 3.6.
 *
 * It uses the sharing key (db.js) and follows sharing's pauses (share.js): no reading without a key, in
 * the sample game, in a read-only record, after GitHub refused the key or while it asked for a pause.
 * It reads at load, when the page becomes visible again and every 60 seconds while it is visible; one
 * reading at a time. What a reading does is decided by model/alerts.js; the text of an alert is never
 * kept, logged or shown.
 */

import { store } from './store.js';
import { loadShareKey } from './db.js';
import { nowMs } from './model/dates.js';
import { roundAlerts } from './model/alerts.js';
import { deleteInboxFile, isShareKey, listInbox, readInboxFile } from './github.js';
import { noteShareAnswer, shareGeneration, shareInfo } from './share.js';

/** While the page is visible, the inbox is read this often. */
const EVERY_MS = 60000;

const live = { busy: false, readAt: null, code: null, refused: 0 };
/** files this device has read in this visit: one whose move the owner removed is not read again */
const seen = new Set();
let timer = null;

function doFetch(url, init) {
  return fetch(url, init);
}

function visible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function usable() {
  const sh = shareInfo();
  return sh.available && sh.on && sh.code !== 'key' && !sh.retryAt && !!store.state && !store.status.readonly;
}

async function read() {
  if (live.busy || !visible() || !usable()) return;
  live.busy = true;
  const gen = shareGeneration();
  const owner = shareInfo().owner;
  let key = null;
  try {
    key = await loadShareKey();
    if (!isShareKey(key) || gen !== shareGeneration()) return;
    const device = {
      state: () => store.state,
      stale: () => gen !== shareGeneration() || !store.state || store.status.readonly,
      // what the phone sent is not the owner's change: an Undo does not take it back
      update: (change) => store.update(change, { past: change }),
      seen,
    };
    const transport = {
      list: () => listInbox(owner, key, doFetch),
      read: (name) => readInboxFile(owner, key, name, doFetch),
      remove: (name, sha) => deleteInboxFile(owner, key, name, sha, doFetch),
    };
    const result = await roundAlerts(device, transport, nowMs());
    live.refused += result.refused; // a count per visit: what those texts said is never kept
    if (result.ok) { live.code = null; live.readAt = nowMs(); }
  } catch (err) {
    // only the code is kept: nothing an error says is shown or logged
    live.code = err && typeof err.code === 'string' ? err.code : 'other';
    if (live.code === 'key' || live.code === 'rate') await noteShareAnswer(live.code, key, gen);
  } finally {
    key = null;
    live.busy = false;
  }
}

/** A reading if one may run (at load, and when the page becomes visible again); then one every 60 seconds. Never throws. */
export function autoInbox() {
  if (timer === null && typeof setInterval === 'function') timer = setInterval(() => { read().catch(() => {}); }, EVERY_MS);
  read().catch(() => {});
}

/** The state of the inbox for the interface: when it was last read, the last error's code, and how many texts this visit refused and deleted. */
export function inboxInfo() {
  return { readAt: live.readAt, code: live.code, busy: live.busy, refused: live.refused };
}
