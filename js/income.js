/**
 * Income the owner's other apps report: reading the folder income/ of their private repository. See
 * ARCHITECTURE.md section 3.7.
 *
 * It uses the sharing key (db.js) and follows sharing's pauses (share.js), like the inbox (inbox.js): no
 * reading without a key, in the sample game, in a read-only record, after GitHub refused the key or while
 * it asked for a pause. It reads at load, when the page becomes visible again, every 60 seconds while it
 * is visible and in every refresh; one reading at a time. What a reading does is decided by
 * model/income.js. Nothing is ever written to or deleted from income/.
 *
 * When the game day changes (seen at the same moments), income is rebuilt once, so that what the rebuild stores (Cash
 * in hand's balance, the moves' receiving account) follows the new day; the figures shown never depended on it.
 */

import { store } from './store.js';
import { loadShareKey } from './db.js';
import { gameDay, nowMs } from './model/dates.js';
import { rebuildIncome, roundIncome } from './model/income.js';
import { isShareKey, listIncome, readIncomeText } from './github.js';
import { noteShareAnswer, shareGeneration, shareInfo, shareSawFile } from './share.js';

/** While the page is visible, income/ is read this often. */
const EVERY_MS = 60000;

/** `folder`: 'listed', 'none' (a 404 while the key reaches the repository: no file in income/) or 'unseen' (a 404 that proves nothing) */
const live = { busy: false, readAt: null, code: null, folder: null };
let timer = null;
/** The game day income was last rebuilt for on this page (null until the first look, which rebuilds too). */
let builtDay = null;

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

/** A new game day: rebuild income once (a change from outside: no Undo takes it back). Cheap, and never throws. */
function followDay() {
  try {
    const state = store.state;
    if (!state || store.status.readonly) return;
    const at = nowMs();
    const day = gameDay(at, state.settings && Number.isInteger(state.settings.rolloverHour) ? state.settings.rolloverHour : 4);
    if (day === builtDay) return;
    builtDay = day; // at the first look too: the record may have been stored on an earlier day
    const inc = state.income;
    const any = inc && ((inc.sources && Object.keys(inc.sources).length) || (inc.shared && Array.isArray(inc.shared.counts) && inc.shared.counts.length));
    if (!any) return;
    const change = (s) => { rebuildIncome(s, at); };
    store.update(change, { past: change });
  } catch { /* the next look tries again */ }
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
      // a 404 for income/ is an empty listing only when the latest share round read the shared file with this key
      access: () => shareSawFile(gen),
      // what the other app reported is not the owner's change: an Undo does not take it back
      update: (change) => store.update(change, { past: change }),
    };
    const transport = {
      list: () => listIncome(owner, key, doFetch),
      read: (name) => readIncomeText(owner, key, name, doFetch),
    };
    const result = await roundIncome(device, transport, nowMs());
    if (result.ok) {
      live.code = null;
      live.folder = result.folder;
      if (result.folder === 'listed') live.readAt = nowMs(); // a 404 is no reading
    }
  } catch (err) {
    // only the code is kept: nothing an error says is shown or logged
    live.code = err && typeof err.code === 'string' ? err.code : 'other';
    if (live.code === 'key' || live.code === 'rate') await noteShareAnswer(live.code, key, gen);
  } finally {
    key = null;
    live.busy = false;
  }
}

/** A reading if one may run (at load, when the page becomes visible again, in a refresh); then one every 60 seconds. Never throws. */
export function autoIncome() {
  if (timer === null && typeof setInterval === 'function') timer = setInterval(() => { followDay(); read().catch(() => {}); }, EVERY_MS);
  followDay();
  return read().catch(() => {});
}

/** The state of the reading for the interface: when income/ was last read, the last error's code, and what the folder answered. */
export function incomeInfo() {
  return { readAt: live.readAt, code: live.code, busy: live.busy, folder: live.folder };
}
