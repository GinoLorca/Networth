/**
 * The nightly wrap on this device (ARCHITECTURE.md section 3.10): the device's wrap file, its push subscription and the
 * night key. What a day counts is decided by model/wrap.js; this file says when the device writes and what the
 * interface is told.
 *
 *  - wrap/<device>.json (`exportWrap`): written through the sharing transport (github.js) 2 seconds after a change of
 *    the record (a bank reading, an inbox reading that changed a move, an income reading, a correction), only when
 *    sharing is on and push/vapid.json exists, and only when its content changed (the time it was written is not
 *    content). Writes never overlap; at most one starts in any 2 seconds.
 *  - push/<device>.json (format push/1): written when the owner turns the wrap on in the installed app, and again when
 *    its words, its lock screen choice or its subscription change; removed by Turn off (a removal that failed is tried
 *    again on open and at each change, until GitHub answers: networth.wrapRemove).
 *  - push/vapid.json: made in this browser by "Make the night key" (WebCrypto, ECDSA P-256). The private scalar is shown
 *    once, held in memory only until Done or until the app is closed (pagehide; switching to another app keeps it, so
 *    that it can be pasted into GitHub), and never stored: the app keeps no copy.
 *  - wrap/sent.json: read for the status (the last wrap, a device the push service turned off, no night key on GitHub or
 *    one that does not match).
 *  - networth.wrapOffAt: when the owner last turned the wrap off on this device: while it is on record and no
 *    subscription is, the wrap is Off by the owner's choice, whatever a later run found.
 *
 * The device id is a random id kept in this browser's storage, never in the record (so a restored copy on another
 * device does not take it). The sharing key is read from device storage for each request and never kept here.
 */

import { store } from './store.js';
import { loadShareKey } from './db.js';
import { nowMs } from './model/dates.js';
import { exportWrap } from './model/wrap.js';
import { wordsOf } from './model/words.js';
import { ShareError, deleteRepoFile, isShareKey, putRepoFile, readRepoFile } from './github.js';
import { shareGeneration, shareInfo } from './share.js';

/** A change is written 2 seconds after it, and at most one write starts in any 2 seconds (as the shared file). */
const SPACING_MS = 2000;
/** push/vapid.json and wrap/sent.json are read at most this often by themselves (Settings asks at once when opened). */
const READ_EVERY_MS = 5 * 60 * 1000;
const DEVICE_SLOT = 'networth.device';
const LOCK_SLOT = 'networth.wrapLock';
const SUB_SLOT = 'networth.wrapSub';
const OFF_SLOT = 'networth.wrapOffAt';
const REMOVE_SLOT = 'networth.wrapRemove';
const DEVICE = /^[A-Za-z0-9_-]{16}$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PUBLIC_KEY = /^B[A-Za-z0-9_-]{86}$/;
const LOCKS = ['cover', 'show', 'hide'];
const STAMPS = new Set(['writtenAt', 'updatedAt']);
const REPOSITORY = 'networth-data';

/* ------------------------------------------------------------------------------------------- pure helpers */

/** A new random device id: 16 characters of letters, digits, `-` and `_` (96 bits). `random` is for tests. */
export function newDeviceId(random) {
  const bytes = new Uint8Array(16);
  if (typeof random === 'function') for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256) & 255;
  else crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += ALPHABET[b & 63];
  return id;
}

/** What the lock screen shows on this device: the owner's choice, or by default what the cover setting says. */
export function lockOf(choice, state) {
  if (choice === 'show' || choice === 'hide') return choice;
  return state && state.settings && state.settings.cover ? 'hide' : 'show';
}

/** The device's push file (format push/1). */
export function pushFileOf({ device, appUrl, subscription, words, lock, nowMs: at }) {
  const keys = subscription && subscription.keys ? subscription.keys : {};
  return {
    format: 'push/1',
    device,
    appUrl,
    subscription: { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    words: words === 'finance' ? 'finance' : 'chess',
    lock: lock === 'show' ? 'show' : 'hide',
    updatedAt: new Date(at).toISOString(),
  };
}

/** Whether two files say the same thing: the time each was written is not content. */
export function sameContent(a, b) {
  return canonical(a) === canonical(b);
}

function canonical(value, top = true) {
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v, false)).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => !(top && STAMPS.has(k))).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k], false)).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function delivered(status) {
  return status === 200 || status === 201 || status === 202;
}

/** A push service that failed for a while (no answer, 429, 5xx): the night job's backup run tries these again. */
function transient(status) {
  return status === 0 || status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

/**
 * This device's part of wrap/sent.json (the night job's record, read leniently): when the last run was, for which day,
 * whether this device got it, whether the push service turned it off (404, 410), whether the night key did not match
 * (`keyProblem`) or GitHub held none (`noKey`: no secret named VAPID_PRIVATE_KEY), and this device's own problem (another
 * answer of its push service, or a token of the job's). `retry`: the backup run tries this device again tonight (a
 * push service that failed for a while, on the night's first scheduled run); `refused`: its push service refused the
 * wrap (a 4xx other than 404, 410 and 429); `nextRun`: the next run that checks the night key, 'backup' (10:13 PM, the
 * night's first scheduled run having run alone) or 'night' (9:33 PM).
 * @param {object|string|null} sent
 * @param {string} device
 */
export function wrapStatus(sent, device) {
  const none = { lastAt: null, lastDay: null, got: false, dead: false, keyProblem: false, noKey: false, problem: null, retry: false, refused: false, nextRun: 'night' };
  let raw = sent;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return none; }
  }
  const last = raw && typeof raw === 'object' && raw.format === 'sent/1' && raw.last && typeof raw.last === 'object' ? raw.last : null;
  if (!last) return none;
  const at = typeof last.at === 'string' ? Date.parse(last.at) : NaN;
  const devices = last.devices && typeof last.devices === 'object' ? last.devices : {};
  const status = Object.hasOwn(devices, device) ? devices[device] : null;
  const dead = Array.isArray(last.dead) && last.dead.includes(device);
  const problems = Array.isArray(last.problems) ? last.problems : [];
  const event = last.event === 'manual' ? 'manual' : 'schedule';
  const schedules = Number.isInteger(last.schedules) ? last.schedules : event === 'schedule' ? 1 : 0;
  const problem = status === null || delivered(status) || dead || status === 404 || status === 410 ? null : status;
  return {
    lastAt: Number.isFinite(at) ? at : null,
    lastDay: typeof last.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(last.day) ? last.day : null,
    got: delivered(status),
    dead,
    keyProblem: problems.some((p) => p && p.device === null && p.status === 'key'),
    noKey: problems.some((p) => p && p.device === null && p.status === 'nokey'),
    problem,
    retry: problem !== null && transient(problem) && event === 'schedule' && schedules === 1,
    refused: Number.isInteger(problem) && problem >= 400 && problem <= 499 && problem !== 429,
    nextRun: schedules === 1 ? 'backup' : 'night',
  };
}

/**
 * Whether this device is still cut off by the push service: the night job marked it dead (or its push service refused
 * the wrap, `refused`), and the subscription on record here (`kept`, with the time it was made) is not one made after
 * that run (Turn back on clears it). While the owner's turn-off is on record (`offAt`) and no subscription is, the wrap
 * is off by their own choice, whatever a later run found (a push file whose removal failed).
 */
export function stillDead(status, kept, offAt) {
  if (!status || !(status.dead || status.refused)) return false;
  const at = kept && Number.isFinite(kept.at) ? kept.at : null;
  if (at === null && Number.isFinite(offAt)) return false;
  return at === null || !Number.isFinite(status.lastAt) || at < status.lastAt;
}

/**
 * The push file's removal after Turn off: one that failed (`pending`) is tried again when poked (on open and at each
 * change), one try at a time, until GitHub answers (`done`).
 * @param {{ pending: () => boolean, remove: () => Promise<void>, done: () => void }} how
 */
export function makeRemover({ pending, remove, done }) {
  let running = null;
  function poke() {
    if (running) return running;
    let due = false;
    try { due = pending(); } catch { due = false; }
    if (!due) return Promise.resolve();
    running = (async () => {
      try {
        await remove();
        done();
      } catch { /* tried again on open and at the next change */ }
    })().finally(() => { running = null; });
    return running;
  }
  async function idle() {
    while (running) await running;
  }
  return { poke, idle };
}

/** When the owner last turned the wrap off on this device (ms), or null. */
function offAt() {
  const ms = Number(slot(OFF_SLOT));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** The night key's public half as push/vapid.json holds it, read strictly; null when it is not one. */
export function readVapid(text) {
  let raw = null;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || raw.format !== 'vapid/1' || typeof raw.publicKey !== 'string' || !PUBLIC_KEY.test(raw.publicKey)) return null;
  const madeAt = typeof raw.madeAt === 'string' && Number.isFinite(Date.parse(raw.madeAt)) ? Date.parse(raw.madeAt) : null;
  return { publicKey: raw.publicKey, madeAt };
}

/**
 * Writes a file 2 seconds after a change, only when what `content()` gives differs from what was last written (the
 * time of writing aside), one write at a time; a change made during a write is written after it. A write that fails is
 * not taken as written, so the next change tries again.
 * @param {{ content: () => object|null, write: (file: object) => Promise<void>, spacingMs?: number }} how
 *   `content` gives null when nothing may be written (sharing off, no night key, the sample game)
 */
export function makeExporter({ content, write, spacingMs = SPACING_MS }) {
  let timer = null;
  let running = null;
  let again = false;
  let last = null;
  function poke() {
    if (running) { again = true; return; }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      running = run().finally(() => {
        running = null;
        if (again) { again = false; poke(); }
      });
    }, spacingMs);
  }
  async function run() {
    let next = null;
    try { next = content(); } catch { next = null; }
    if (!next || (last && sameContent(last, next))) return;
    try {
      await write(next);
      last = next;
    } catch { /* tried again at the next change */ }
  }
  async function idle() {
    while (running) await running;
  }
  return { poke, idle, forget: () => { last = null; } };
}

/* -------------------------------------------------------------------------------------------- the device */

const live = {
  device: null,
  /** push/vapid.json: undefined until read, null when there is none, else { publicKey, madeAt } */
  vapid: undefined,
  /** wrap/sent.json as read (text), or null */
  sent: null,
  readAt: 0,
  reading: false,
  /** the last failure's code (a ShareError code, or 'push' when the browser refused) */
  code: null,
  /** 'key' | 'on' | 'off' while one of those runs */
  busy: null,
  /** the private key just made, shown once; held in memory only, never stored */
  made: null,
  /** the key just made replaced one: GitHub already holds a secret of that name, to be updated */
  replacing: false,
  /** the service worker registration, kept so that a tap subscribes with no wait */
  reg: null,
  /** this device's subscription as the browser has it: undefined until asked, null when it has none */
  sub: undefined,
  /** a subscription this device had is gone (or was made with a night key since replaced) */
  gone: false,
  lock: 'cover',
};

let seenRev = -1;
let seenDoc = null;

function doFetch(url, init) {
  return fetch(url, init);
}

function poke() {
  store.setUi({ wrapTick: (store.ui.wrapTick || 0) + 1 });
}

function slot(name, value) {
  try {
    if (value === undefined) return localStorage.getItem(name);
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch { /* storage may be unavailable: the value then lasts this visit */ }
  return null;
}

/** This device's id: made once and kept in this browser's storage (never in the record). */
export function deviceId() {
  if (live.device) return live.device;
  const kept = slot(DEVICE_SLOT);
  live.device = typeof kept === 'string' && DEVICE.test(kept) ? kept : newDeviceId();
  if (kept !== live.device) slot(DEVICE_SLOT, live.device);
  return live.device;
}

function storedSub() {
  try {
    const raw = JSON.parse(slot(SUB_SLOT) || 'null');
    return raw && typeof raw.endpoint === 'string' && raw.keys && typeof raw.keys.p256dh === 'string' ? raw : null;
  } catch { return null; }
}

/** The page's own address: origin and path, nothing after them (the job adds the day's sheet). */
function appUrl() {
  return location.origin + location.pathname;
}

function standalone() {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('standalone') === '1') return true;
  if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
  return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
}

function pushable() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined';
}

function usable() {
  const sh = shareInfo();
  return sh.available && sh.on && sh.code !== 'key' && !sh.retryAt && !!store.state && !store.status.readonly;
}

async function keyFor(gen) {
  const key = await loadShareKey();
  if (!isShareKey(key) || gen !== shareGeneration()) throw new ShareError('key');
  return key;
}

/**
 * The device's wrap file as it would be written now, or null when none may be: sharing must be on (`sharing`) and the
 * night key published (`vapid`, push/vapid.json read and present).
 */
export function wrapFileContent(state, at, device, { sharing, vapid }) {
  return sharing && vapid ? exportWrap(state, at, device) : null;
}

const wrapFile = makeExporter({
  content: () => wrapFileContent(store.state, nowMs(), deviceId(), { sharing: usable(), vapid: live.vapid }),
  write: async (file) => {
    const gen = shareGeneration();
    const key = await keyFor(gen);
    const path = 'wrap/' + file.device + '.json';
    await putRepoFile(shareInfo().owner, key, path, (text) => (sameContent(parsed(text), file) ? null : JSON.stringify(file, null, 1) + '\n'), doFetch);
  },
});

const pushFile = makeExporter({
  content: () => {
    const sub = storedSub();
    if (!usable() || !sub || live.gone) return null;
    return pushFileOf({ device: deviceId(), appUrl: appUrl(), subscription: sub, words: wordsOf(store.state), lock: lockOf(live.lock, store.state), nowMs: nowMs() });
  },
  write: async (file) => {
    const gen = shareGeneration();
    const key = await keyFor(gen);
    await putRepoFile(shareInfo().owner, key, 'push/' + file.device + '.json', (text) => (sameContent(parsed(text), file) ? null : JSON.stringify(file, null, 1) + '\n'), doFetch);
  },
});

function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Turn off's removal of push/<device>.json, when it failed: tried again on open and at each change. */
const pushRemoval = makeRemover({
  pending: () => slot(REMOVE_SLOT) === '1' && !storedSub() && !live.busy && usable(),
  remove: async () => {
    const key = await keyFor(shareGeneration());
    if (storedSub() || live.busy) return; // turned on again meanwhile: the file is this device's again
    await deleteRepoFile(shareInfo().owner, key, 'push/' + deviceId() + '.json', doFetch);
  },
  done: () => { if (!storedSub()) slot(REMOVE_SLOT, null); },
});

/** The store changed: the files follow 2 seconds later when what they would say changed. */
function watch() {
  if (store.rev === seenRev && store.state === seenDoc) return;
  seenRev = store.rev;
  seenDoc = store.state;
  wrapFile.poke();
  pushFile.poke();
  pushRemoval.poke();
}

/**
 * Read push/vapid.json and wrap/sent.json, when the last reading is older than `maxAgeMs` (5 minutes by default; Settings
 * asks with 30 seconds as it opens). Never throws.
 */
export async function readWrapFiles(maxAgeMs = READ_EVERY_MS) {
  if (live.reading || !usable() || nowMs() - live.readAt < maxAgeMs) return;
  live.reading = true;
  poke();
  const gen = shareGeneration();
  try {
    const key = await keyFor(gen);
    const owner = shareInfo().owner;
    const [vapid, sent] = await Promise.all([readRepoFile(owner, key, 'push/vapid.json', doFetch), readRepoFile(owner, key, 'wrap/sent.json', doFetch)]);
    if (gen !== shareGeneration()) return;
    live.vapid = vapid.text === null ? null : readVapid(vapid.text);
    live.sent = sent.text;
    live.readAt = nowMs();
    live.code = null;
    wrapFile.poke();
    await checkSubscription();
  } catch (err) {
    live.code = err && typeof err.code === 'string' ? err.code : 'other';
  } finally {
    live.reading = false;
    poke();
  }
}

/**
 * On each open in the installed app: the browser's subscription against the copy this device wrote. A different one is
 * written again; one that is gone, or was made with a night key since replaced, is offered "Turn back on".
 */
async function checkSubscription() {
  if (!standalone() || !pushable()) return;
  try {
    live.reg = live.reg || (await navigator.serviceWorker.getRegistration()) || null;
    if (!live.reg) {
      // the first load registers the worker after this: it is kept when ready, without waiting here (on a page with no
      // worker, ready never comes)
      navigator.serviceWorker.ready.then((reg) => { live.reg = reg; poke(); }, () => {});
      return;
    }
    if (!live.reg.pushManager) return;
    const sub = await live.reg.pushManager.getSubscription();
    const kept = storedSub();
    live.sub = sub;
    if (!sub) {
      live.gone = !!kept;
      return;
    }
    const json = sub.toJSON();
    if (stillDead(wrapStatus(live.sent, deviceId()), kept, offAt())) {
      // the push service dropped it, or refused the wrap: it is ended now, so that Turn back on makes a new one
      // (subscribing again with the same key would give back this one)
      await sub.unsubscribe().catch(() => false);
      live.sub = null;
      live.gone = true;
      return;
    }
    if (live.vapid && kept && kept.serverKey && kept.serverKey !== live.vapid.publicKey) {
      // made with a night key since replaced: the push service would refuse every message to it
      await sub.unsubscribe().catch(() => false);
      live.sub = null;
      live.gone = true;
      return;
    }
    if (!kept || kept.endpoint !== json.endpoint || kept.keys.p256dh !== json.keys.p256dh || kept.keys.auth !== json.keys.auth) {
      slot(SUB_SLOT, JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, serverKey: kept ? kept.serverKey : (live.vapid ? live.vapid.publicKey : null), at: nowMs() }));
      pushFile.poke();
    }
    live.gone = false;
  } catch { /* the browser said nothing: asked again at the next open */ }
}

/** Call once at boot, after sharing (share.js) has read whether this device holds a key. */
export function initWrap() {
  deviceId();
  const lock = slot(LOCK_SLOT);
  live.lock = LOCKS.includes(lock) ? lock : 'cover';
  store.subscribe(watch);
  if (typeof addEventListener === 'function') addEventListener('pagehide', () => { live.made = null; });
}

/** At load and when the page becomes visible again: the files are read when due. Never throws. */
export function autoWrap() {
  readWrapFiles().catch(() => {});
  checkSubscription().catch(() => {});
  pushRemoval.poke();
}

function bytesOf(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Make the night key in this browser: an ECDSA P-256 pair; the public half (65 bytes uncompressed, base64url) is written
 * to push/vapid.json, and the private scalar is held in memory to be shown once (Copy private key). Nothing keeps it.
 * @returns {Promise<{ ok: boolean, code?: string }>}
 */
export async function makeNightKey() {
  if (live.busy || !usable()) return { ok: false, code: 'busy' };
  live.busy = 'key';
  poke();
  const gen = shareGeneration();
  try {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
    const madeAt = nowMs();
    // Whether GitHub holds a secret of that name, to be updated rather than added, is known only once a run after the
    // current key was made has checked: true when it found one (a mismatched key is still a secret), false when it
    // found none or no key existed, null (unknown: both ways are shown) when no run has checked the current key yet
    const status = wrapStatus(live.sent, deviceId());
    const checked = !!live.vapid && Number.isFinite(live.vapid.madeAt) && Number.isFinite(status.lastAt) && status.lastAt > live.vapid.madeAt;
    const replacing = !live.vapid ? false : checked ? !status.noKey : null;
    const key = await keyFor(gen);
    const file = { format: 'vapid/1', publicKey, madeAt: new Date(madeAt).toISOString() };
    await putRepoFile(shareInfo().owner, key, 'push/vapid.json', () => JSON.stringify(file, null, 1) + '\n', doFetch);
    live.vapid = { publicKey, madeAt };
    live.made = privateKey;
    live.replacing = replacing;
    live.code = null;
    // a subscription made with the old key no longer works: this device turns the wrap on again, like the others
    if (storedSub()) live.gone = true;
    if (live.reg && live.reg.pushManager) {
      const sub = await live.reg.pushManager.getSubscription().catch(() => null);
      if (sub) await sub.unsubscribe().catch(() => false);
      live.sub = null;
    }
    wrapFile.poke();
    return { ok: true };
  } catch (err) {
    live.code = err && typeof err.code === 'string' ? err.code : 'other';
    return { ok: false, code: live.code };
  } finally {
    live.busy = null;
    poke();
  }
}

/** The private key just made, for Copy private key; null once Done was tapped or the page was hidden. */
export function madeKey() {
  return live.made;
}

/** Forget the private key just made (Done). */
export function forgetMadeKey() {
  live.made = null;
  poke();
}

/**
 * Turn the wrap on, straight from the tap: the permission request and the subscription start at once, with no request
 * to the network before them (the public key was read when Settings opened). Then push/<device>.json is written.
 * @returns {Promise<{ ok: boolean, code?: string }>}
 */
export function turnOnWrap() {
  const vapid = live.vapid;
  const reg = live.reg;
  if (live.busy) return Promise.resolve({ ok: false, code: 'busy' });
  if (!vapid || !reg || !reg.pushManager) return Promise.resolve({ ok: false, code: 'worker' });
  const asked = typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function'
    ? Promise.resolve(Notification.requestPermission()).catch(() => 'default') : Promise.resolve('default');
  const subscribing = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesOf(vapid.publicKey) });
  return finishOn(asked, subscribing, vapid);
}

async function finishOn(asked, subscribing, vapid) {
  live.busy = 'on';
  poke();
  let subscribed = false;
  try {
    await asked;
    let sub = null;
    try { sub = await subscribing; } catch { throw Object.assign(new Error('push'), { code: 'push' }); }
    const json = sub.toJSON();
    slot(SUB_SLOT, JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, serverKey: vapid.publicKey, at: nowMs() }));
    slot(OFF_SLOT, null);
    slot(REMOVE_SLOT, null);
    live.sub = sub;
    live.gone = false;
    subscribed = true;
    pushFile.forget();
    await pushRemoval.idle(); // a removal left from Turn off never runs after this write
    const file = pushFileOf({ device: deviceId(), appUrl: appUrl(), subscription: json, words: wordsOf(store.state), lock: lockOf(live.lock, store.state), nowMs: nowMs() });
    const key = await keyFor(shareGeneration());
    await putRepoFile(shareInfo().owner, key, 'push/' + file.device + '.json', () => JSON.stringify(file, null, 1) + '\n', doFetch);
    live.code = null;
    wrapFile.poke();
    return { ok: true };
  } catch (err) {
    live.code = err && typeof err.code === 'string' ? err.code : 'other';
    // subscribed, but the push file was not written: it is written again 2 seconds from now, and at each change after
    if (subscribed) pushFile.poke();
    return { ok: false, code: live.code };
  } finally {
    live.busy = null;
    poke();
  }
}

/** Turn the wrap off on this device: the subscription is ended and push/<device>.json removed. */
export async function turnOffWrap() {
  if (live.busy) return { ok: false, code: 'busy' };
  live.busy = 'off';
  poke();
  try {
    const sub = live.reg && live.reg.pushManager ? await live.reg.pushManager.getSubscription().catch(() => null) : null;
    if (sub) await sub.unsubscribe().catch(() => false);
    slot(SUB_SLOT, null);
    // turned off by the owner: not "turned off by the push service", whatever the last run said
    slot(OFF_SLOT, String(nowMs()));
    live.sub = null;
    live.gone = false;
    pushFile.forget();
    // until GitHub answers, the removal is tried again on open and at each change
    slot(REMOVE_SLOT, '1');
    const key = await keyFor(shareGeneration());
    await deleteRepoFile(shareInfo().owner, key, 'push/' + deviceId() + '.json', doFetch);
    slot(REMOVE_SLOT, null);
    live.code = null;
    return { ok: true };
  } catch (err) {
    live.code = err && typeof err.code === 'string' ? err.code : 'other';
    return { ok: false, code: live.code };
  } finally {
    live.busy = null;
    poke();
  }
}

/** Amounts on the lock screen: 'cover' (follow the cover setting), 'show' or 'hide'; written into the push file. */
export function setWrapLock(choice) {
  live.lock = LOCKS.includes(choice) ? choice : 'cover';
  slot(LOCK_SLOT, live.lock === 'cover' ? null : live.lock);
  pushFile.poke();
  poke();
}

/**
 * The nightly wrap for the interface (ctx.wrap).
 */
export function wrapInfo() {
  const sh = shareInfo();
  const sub = storedSub();
  const device = deviceId();
  const status = wrapStatus(live.sent, device);
  // turned off, or refused, by the push service only until this device turns the wrap back on
  const cut = stillDead(status, sub, offAt());
  status.dead = cut && status.dead;
  status.refused = cut && !status.dead && status.refused;
  // a problem of a run before this device's subscription was made, or after the owner turned the wrap off here, is
  // about a subscription that is no more: it is not said
  const newer = sub && Number.isFinite(sub.at) && Number.isFinite(status.lastAt) && sub.at > status.lastAt;
  if (newer || (!sub && offAt() !== null)) Object.assign(status, { problem: null, refused: false, retry: false });
  return {
    available: !!sh.available,
    on: !!sh.on,
    standalone: standalone(),
    pushable: pushable(),
    device,
    owner: sh.owner,
    /** undefined until read, null when there is no night key */
    vapid: live.vapid,
    reading: live.reading,
    busy: live.busy,
    code: live.code,
    made: live.made,
    subscribed: !!sub && !live.gone && !status.dead && !status.refused,
    gone: live.gone,
    lock: live.lock,
    status,
    /** the key just made replaced one: GitHub's secret of that name is updated (secretsUrl), not added (secretUrl) */
    replacing: live.replacing,
    secretUrl: sh.owner ? 'https://github.com/' + sh.owner + '/' + REPOSITORY + '/settings/secrets/actions/new' : null,
    secretsUrl: sh.owner ? 'https://github.com/' + sh.owner + '/' + REPOSITORY + '/settings/secrets/actions' : null,
  };
}
