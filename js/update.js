/**
 * New versions reaching the installed apps (ARCHITECTURE 2 and 9). The built page carries its build id in
 * <meta name="networth-build">, and version.json beside it says which build is deployed (tools/build.mjs).
 * The two are compared when the page becomes visible (at most once every 5 minutes), every 30 minutes while
 * it is visible, and in every refresh. A newer build reloads the page when nothing is going on (the record is
 * saved first), and otherwise offers one quiet line with a "Reload" link.
 *
 * The unbundled development page has no build id: every check answers "unknown" and does nothing. A check
 * that fails (offline, a 404) says nothing. A reload is never attempted twice toward the same deployed build
 * within 30 minutes (GitHub's CDN may still hand out the old page for up to 10 minutes after a deploy).
 *
 * The pure parts (compareBuild, mayReload, parseVersion) are tested in tests/update.test.js.
 */

export const VISIBLE_GAP_MS = 5 * 60 * 1000;
export const CHECK_EVERY_MS = 30 * 60 * 1000;
export const LOOP_GUARD_MS = 30 * 60 * 1000;
const ATTEMPT_KEY = 'networth.reload-attempt';
const AFTER_KEY = 'networth.refresh-after-reload';

/**
 * @param {string} running   the id this page was built with ('' in development)
 * @param {string} deployed  the id version.json names ('' when it could not be read)
 * @returns {'unknown'|'same'|'newer'}
 */
export function compareBuild(running, deployed) {
  if (!running || !deployed) return 'unknown';
  return running === deployed ? 'same' : 'newer';
}

/** The id in a version.json answer, or '' for anything else. */
export function parseVersion(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v.build === 'string' && /^[0-9a-f]{6,64}$/.test(v.build) ? v.build : '';
  } catch {
    return '';
  }
}

/**
 * May the page reload toward `deployed` now? Not when the last attempt went toward the same build less than
 * 30 minutes ago (the reload then brought the old page back, and would again).
 * @param {{ build: string, at: number }|null} last
 */
export function mayReload(last, deployed, now) {
  if (!deployed) return false;
  if (!last || last.build !== deployed || !Number.isFinite(last.at)) return true;
  return now - last.at >= LOOP_GUARD_MS || now < last.at;
}

/* ------------------------------------------------------------- browser */

const live = { pending: '', lastCheck: 0, timer: null, checking: null, isIdle: () => false, save: async () => {}, poke: () => {} };

function session(get, key, value) {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    if (get) return sessionStorage.getItem(key);
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { /* a private window may refuse; the guard is then only this page's memory */ }
  return null;
}

let memoryAttempt = null;
function lastAttempt() {
  const raw = session(true, ATTEMPT_KEY);
  if (raw) {
    try { const v = JSON.parse(raw); if (v && typeof v.build === 'string') return v; } catch { /* ignored */ }
  }
  return memoryAttempt;
}

/** The id this page was built with; '' in development. */
export function runningBuild() {
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="networth-build"]');
  return meta ? String(meta.getAttribute('content') || '') : '';
}

/** Ask which build is deployed. Never throws: anything that goes wrong answers ''. */
async function deployedBuild() {
  if (typeof fetch !== 'function') return '';
  try {
    const url = new URL('version.json', location.href);
    url.search = '?t=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const res = await fetch(url.href, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return '';
    return parseVersion(await res.text());
  } catch {
    return '';
  }
}

/**
 * Compare the running build with the deployed one.
 * @returns {Promise<{ status: 'unknown'|'same'|'newer', build: string }>}
 */
export function checkVersion() {
  if (live.checking) return live.checking;
  const running = runningBuild();
  if (!running) return Promise.resolve({ status: 'unknown', build: '' });
  live.lastCheck = Date.now();
  const run = deployedBuild().then((build) => {
    const status = compareBuild(running, build);
    live.pending = status === 'newer' ? build : '';
    live.poke();
    return { status, build };
  }).finally(() => { live.checking = null; });
  live.checking = run;
  return run;
}

/**
 * Save the record and reload toward `build`, unless the loop guard says no.
 * @param {{ afterwards?: boolean }} [opts]  afterwards = the page goes on with the refresh after the reload
 * @returns {Promise<boolean>} true when the page is reloading
 */
export async function reloadTo(build, opts = {}) {
  if (!mayReload(lastAttempt(), build, Date.now())) return false;
  const attempt = { build, at: Date.now() };
  memoryAttempt = attempt;
  session(false, ATTEMPT_KEY, JSON.stringify(attempt));
  if (opts.afterwards) session(false, AFTER_KEY, '1');
  try { await live.save(); } catch { /* the mirror copy was written first; a reload never waits on a failed save */ }
  location.reload();
  return true;
}

/** A newer build waits for a reload that was not made (the app was busy, or the guard held it). */
export function pendingBuild() {
  return live.pending;
}

/** True once after a reload that a refresh asked for: the refresh goes on with the bank and the other devices. */
export function takeRefreshFlag() {
  const was = session(true, AFTER_KEY) === '1';
  if (was) session(false, AFTER_KEY, null);
  return was;
}

/** Did the last reload bring the build it went for? (A CDN copy of the old page may come back instead.) */
export function reachedAttempt() {
  const last = lastAttempt();
  return !!last && !!runningBuild() && last.build === runningBuild();
}

/** The "Reload" link: reload now, whatever the app is doing (the owner asked). */
export async function reloadNow() {
  const build = live.pending;
  memoryAttempt = null;
  session(false, ATTEMPT_KEY, null);
  if (build) await reloadTo(build);
  else location.reload();
}

/** A check, and the reload when the app is idle. */
async function checkAndApply() {
  const { status, build } = await checkVersion();
  if (status === 'newer' && live.isIdle()) await reloadTo(build);
}

function visibleCheck() {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - live.lastCheck < VISIBLE_GAP_MS) return;
  checkAndApply().catch(() => {});
}

/**
 * Start the checks.
 * @param {{ isIdle: () => boolean, save: () => Promise<void>, poke: () => void }} hooks
 */
export function initUpdate(hooks) {
  live.isIdle = hooks.isIdle;
  live.save = hooks.save;
  live.poke = hooks.poke;
  if (!runningBuild() || live.timer) return;
  document.addEventListener('visibilitychange', visibleCheck);
  live.timer = setInterval(() => { if (document.visibilityState === 'visible') checkAndApply().catch(() => {}); }, CHECK_EVERY_MS);
  // a page that came from the cache (offline at its load, or a CDN copy) is checked at once
  visibleCheck();
}
