// node tests/helpers/wrap-flow.mjs <chess|finance> <newkey|offdead>
// Runs one flow of Settings → Nightly wrap under node with the app's own modules (settings.js actions, wrap.js, share.js,
// github.js), against an in-memory GitHub repository and a fake push manager, in a process of its own: the few globals
// a browser has are stubbed here. Prints what each step rendered and did as JSON. Every owner, key and id is invented.
//   newkey   a night key exists (and GitHub holds another): Make a new night key → its warning → the new key, shown once
//   offdead  the push service turned this device off: Turn back on, then Turn off (the owner's own choice)
import { createECDH } from 'node:crypto';

const [words = 'chess', which = 'newkey'] = process.argv.slice(2);
const noop = () => {};
const el = () => ({ setAttribute: noop, getAttribute: () => null, addEventListener: noop, removeEventListener: noop, appendChild: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {} });
const kept = new Map();
globalThis.BroadcastChannel = undefined;
globalThis.window = { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '', search: '' } };
globalThis.document = { addEventListener: noop, removeEventListener: noop, documentElement: el(), body: el(), createElement: el,
  querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', getElementById: () => null };
globalThis.addEventListener = noop;
globalThis.localStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
globalThis.location = { origin: 'http://localhost:8000', pathname: '/', search: '?share=example-owner&standalone=1', hostname: 'localhost', hash: '' };

// the push manager: one subscription at a time
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
let current = null;
let unsubscribed = false;
const subscription = (n) => {
  const json = { endpoint: 'https://web.push.apple.com/QX-' + n, keys: { p256dh: 'B' + 'Q'.repeat(86), auth: 'A'.repeat(22) } };
  const sub = { toJSON: () => json, unsubscribe: async () => { if (current === sub) current = null; unsubscribed = true; return true; } };
  return sub;
};
let made = 0;
// what the tap does, in order: Safari counts a tap once, so the subscription must be its first and only request
const tapCalls = [];
const reg = { pushManager: { getSubscription: async () => current, subscribe: (opts) => { tapCalls.push('subscribe'); return Promise.resolve().then(() => { current = subscription(++made); return current; }); } } };
Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { getRegistration: async () => reg, ready: Promise.resolve(reg) }, clipboard: null }, configurable: true });
globalThis.PushManager = function PushManager() {};
globalThis.Notification = { permission: 'default', requestPermission: async () => { tapCalls.push('requestPermission'); return 'granted'; } };

// the private repository, as GitHub's contents API answers for it
const repo = new Map();
const requests = [];
let sha = 0;
const API = 'https://api.github.com/repos/example-owner/networth-data/contents/';
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });
globalThis.fetch = async (url, init = {}) => {
  requests.push(String(url) + ' ' + (init.method || 'GET') + ' ' + (init.body || ''));
  if (!String(url).startsWith(API)) return answer(404, { message: 'Not Found' });
  const path = String(url).slice(API.length);
  const method = init.method || 'GET';
  if (method === 'GET') {
    const file = repo.get(path);
    return file ? answer(200, { encoding: 'base64', content: Buffer.from(file.text).toString('base64'), sha: file.sha }) : answer(404, { message: 'Not Found' });
  }
  if (method === 'PUT') {
    const body = JSON.parse(init.body);
    const file = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: (++sha).toString(16).padStart(40, '0') };
    repo.set(path, file);
    return answer(201, { content: { sha: file.sha } });
  }
  if (method === 'DELETE') {
    repo.delete(path);
    return answer(200, {});
  }
  return answer(405, {});
};

const js = new URL('../../js/', import.meta.url);
const dates = await import(new URL('model/dates.js', js));
const now = new Date('2026-06-18T21:00:00').getTime();
dates.setNow(now);
const { buildDemoState } = await import(new URL('model/demo.js', js));
const { makeDerived } = await import(new URL('derive.js', js));
const { store } = await import(new URL('store.js', js));
const runtime = await import(new URL('runtime.js', js));
const db = await import(new URL('db.js', js));
const share = await import(new URL('share.js', js));
const wrap = await import(new URL('wrap.js', js));
const settings = await import(new URL('views/settings.js', js));

const DEVICE = 'devflowexample01';
const OLD = (() => { const e = createECDH('prime256v1'); e.generateKeys(); return b64url(e.getPublicKey()); })();
const iso = (ms) => new Date(ms).toISOString();
kept.set('networth.device', DEVICE);
const out = {};
const settle = async () => { for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 5)); if (!wrap.wrapInfo().busy && !wrap.wrapInfo().reading) return; } };
function render() {
  const ctx = {
    state: store.state, ui: store.ui, now, words, wordsForced: false, today: dates.gameDay(now, store.state.settings.rolloverHour),
    route: { view: 'settings', segs: [], params: {}, sheet: null }, d: makeDerived(store.state, now, { words }), demo: false,
    sync: { state: 'off' }, share: share.shareInfo(), inbox: {}, income: {}, wrap: wrap.wrapInfo(), wide: true,
  };
  if (runtime.setContext) runtime.setContext(ctx);
  const html = String(settings.render(ctx));
  const at = html.indexOf('aria-label="Nightly wrap"');
  return html.slice(at - 60, html.indexOf('aria-label="What the wrap holds"', at));
}

try {
  const state = buildDemoState(now);
  state.meta.origin = 'bank';
  state.settings.words = words;
  store.load(state, { readonly: false });
  await db.saveShareKey('github_pat_' + 'x'.repeat(40));
  await share.initShare(globalThis.location);
  repo.set('push/vapid.json', { text: JSON.stringify({ format: 'vapid/1', publicKey: OLD, madeAt: iso(now - 5 * 86400000) }), sha: 'a'.repeat(40) });
  const lastAt = now - 2 * 3600000;
  const sub = subscription(0);
  current = sub;
  kept.set('networth.wrapSub', JSON.stringify({ ...sub.toJSON(), serverKey: OLD, at: now - 86400000 }));
  wrap.initWrap();
  if (which === 'newkey') {
    // GitHub holds a key that is not the published one
    repo.set('wrap/sent.json', { text: JSON.stringify({ format: 'sent/1', days: {}, last: { at: iso(lastAt), day: '2026-06-17', sent: 0, dead: [], problems: [{ device: null, status: 'key' }], devices: {} } }), sha: 'b'.repeat(40) });
    await wrap.readWrapFiles(0);
    await settle();
    out.oldKey = OLD;
    settings.actions['settings.ask']({ data: { what: 'wrap-key' }, el: { dataset: { what: 'wrap-key' } } });
    out.asked = store.ui.settingsConfirm;
    out.confirm = render();
    settings.actions['settings.wrap-key']({ data: {}, el: { dataset: {} } });
    await settle();
    out.closed = store.ui.settingsConfirm;
    const vapid = JSON.parse(repo.get('push/vapid.json').text);
    out.publicKey = vapid.publicKey;
    out.vapidFields = Object.keys(vapid).sort();
    out.privateKey = wrap.madeKey();
    // the private scalar signs for the published point
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    const jwk = { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)), d: out.privateKey };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const verifyKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const data = new TextEncoder().encode('night');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
    out.signs = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, signature, data);
    out.made = render();
    out.unsubscribed = unsubscribed && current === null;
    settings.actions['settings.wrap-done']({ data: {}, el: { dataset: {} } });
    out.done = render();
    out.stored = [...kept.values()].some((v) => v.includes(out.privateKey));
    out.requests = requests;
  } else {
    // the night job found this device gone (410) two hours ago
    repo.set('wrap/sent.json', { text: JSON.stringify({ format: 'sent/1', days: {}, last: { at: iso(lastAt), day: '2026-06-17', sent: 0, dead: [DEVICE], problems: [], devices: { [DEVICE]: 410 } } }), sha: 'b'.repeat(40) });
    repo.set('push/vapid.json', { text: JSON.stringify({ format: 'vapid/1', publicKey: OLD, madeAt: iso(now - 5 * 86400000) }), sha: 'a'.repeat(40) });
    await wrap.readWrapFiles(0);
    await settle();
    out.dead = render();
    tapCalls.length = 0;
    settings.actions['settings.wrap-on']({ data: {}, el: { dataset: {} } });
    out.tapSync = [...tapCalls]; // what the tap itself called, before anything was awaited
    await settle();
    out.tapCalls = [...tapCalls];
    out.on = render();
    settings.actions['settings.wrap-off']({ data: {}, el: { dataset: {} } });
    await settle();
    out.off = render();
    out.pushFile = repo.has('push/' + DEVICE + '.json');
  }
} catch (e) {
  out.error = String(e && e.stack ? e.stack : e);
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
