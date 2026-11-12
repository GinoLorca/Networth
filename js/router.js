/**
 * Hash router. Every screen and every open sheet has an address, so the back button
 * closes sheets on phones and any state can be linked to (and screenshotted).
 *
 *   #/board
 *   #/sheet/2026-11?filter=disc            view "sheet", segment "2026-11", view params { filter }
 *   #/board?sheet=move&s.amount=650        the "move" sheet open over the board with params { amount }
 *
 * View params are plain query keys. The open sheet is `sheet=<name>`; its own
 * params are prefixed "s.". Closing a sheet removes `sheet` and every "s." key.
 */

const listeners = new Set();
let memoryHash = null; // used only when the History API / location.hash is unavailable (sandboxed frames)
let lastEmitted = null;

function readHash() {
  if (memoryHash != null) return memoryHash;
  try { return location.hash || ''; } catch { return ''; }
}

/**
 * @param {string} hash
 * @returns {{ view: string, segs: string[], params: Record<string,string>, sheet: null | { name: string, params: Record<string,string> } }}
 */
export function parseHash(hash) {
  const clean = String(hash || '').replace(/^#/, '');
  const [pathPart, queryPart = ''] = clean.split('?');
  const segs = pathPart.split('/').filter(Boolean).map(safeDecode);
  const params = {};
  const sheetParams = {};
  let sheetName = null;
  for (const pair of queryPart.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = safeDecode(i < 0 ? pair : pair.slice(0, i));
    const v = safeDecode(i < 0 ? '' : pair.slice(i + 1));
    if (k === 'sheet') sheetName = v;
    else if (k.startsWith('s.')) sheetParams[k.slice(2)] = v;
    else params[k] = v;
  }
  return {
    view: segs[0] || 'board',
    segs: segs.slice(1),
    params,
    sheet: sheetName ? { name: sheetName, params: sheetParams } : null,
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

/** Build a hash string from route parts (the inverse of parseHash). */
export function buildHash({ view = 'board', segs = [], params = {}, sheet = null }) {
  let out = '#/' + [view, ...segs].map(encodeURIComponent).join('/');
  const q = [];
  for (const k in params) if (params[k] != null && params[k] !== '') q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  if (sheet && sheet.name) {
    q.push('sheet=' + encodeURIComponent(sheet.name));
    for (const k in sheet.params || {}) {
      const v = sheet.params[k];
      if (v != null && v !== '') q.push('s.' + encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
  }
  return q.length ? out + '?' + q.join('&') : out;
}

export function currentRoute() {
  return parseHash(readHash());
}

function emit(force) {
  const h = readHash();
  if (!force && h === lastEmitted) return;
  lastEmitted = h;
  const route = parseHash(h);
  for (const fn of listeners) fn(route);
}

function go(hash, { replace = false, state = null } = {}) {
  try {
    if (replace) history.replaceState(state, '', hash);
    else history.pushState(state, '', hash);
    memoryHash = null;
  } catch {
    try {
      if (replace) location.replace(hash); else location.hash = hash;
      memoryHash = null;
    } catch {
      memoryHash = hash;
    }
  }
  emit();
}

/** Go to a view. `to` is a hash string ('#/book') or route parts. */
export function navigate(to, opts = {}) {
  go(typeof to === 'string' ? to : buildHash(to), opts);
}

/** Change view params (query keys) of the current view without leaving it. null/'' removes a key. */
export function setParams(patch, { replace = true } = {}) {
  const r = currentRoute();
  go(buildHash({ ...r, params: { ...r.params, ...patch } }), { replace });
}

/** Open a sheet over the current view. Pushes a history entry so Back closes it. */
export function openSheet(name, params = {}) {
  const r = currentRoute();
  const replacing = !!r.sheet; // sheet-to-sheet replaces, so one Back still closes
  let state = { nwSheet: true };
  if (replacing) { try { state = history.state; } catch { state = null; } }
  go(buildHash({ ...r, sheet: { name, params } }), { replace: replacing, state });
}

/**
 * Close the open sheet (if any).
 * @returns {Promise<void>} resolved once the route no longer carries the sheet (going Back is asynchronous),
 *   so a caller can change state after the sheet has gone: closeSheet().then(() => store.update(…)).
 */
export function closeSheet() {
  const r = currentRoute();
  if (!r.sheet) return Promise.resolve();
  let viaBack = false;
  try { viaBack = !!(history.state && history.state.nwSheet) && history.length > 1 && memoryHash == null; } catch { viaBack = false; }
  if (viaBack) {
    try {
      const gone = new Promise((resolve) => {
        const stop = onRoute((route) => { if (!route.sheet) { stop(); resolve(); } });
        setTimeout(() => { stop(); resolve(); }, 600);
      });
      history.back();
      return gone;
    } catch { /* fall through */ }
  }
  go(buildHash({ ...r, sheet: null }), { replace: true });
  return Promise.resolve();
}

/** Subscribe to route changes. The callback receives the parsed route. Returns an unsubscribe function. */
export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Start listening to browser navigation. Call once at boot. */
export function startRouter() {
  if (typeof window === 'undefined') return;
  window.addEventListener('hashchange', () => emit());
  window.addEventListener('popstate', () => emit());
  lastEmitted = readHash();
}
