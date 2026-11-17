// Networth service worker: lets the app open with no connection.
// Network first (so a new version arrives the moment there is one), falling back to the last
// copy that loaded. It only ever handles this site's own files — never the bank feed.
const CACHE = 'networth-shell-v1';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // which build is deployed is asked of the network alone (js/update.js): never answered from, or kept in, the cache
  if (url.pathname.endsWith('/version.json')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});

// The nightly wrap (ARCHITECTURE 3.10). The night job sends Declarative Web Push ({ web_push: 8030, notification: {
// title, body, navigate, tag, lang } }), which the system shows by itself where it can; where it hands the message to
// this worker instead, it is shown here as it is. A push is always shown (a browser takes back the permission of a site
// that receives one and shows nothing), so anything else shows a fixed line that opens the app.
const DECLARATIVE = 8030;
const FALLBACK_TITLE = 'Networth';
const FALLBACK_BODY = 'Tonight’s wrap is ready. Tap to see money in and out.';

/** The app's own address (the worker's scope): where a notification without a day of its own opens. */
function appHome() {
  return self.registration.scope;
}

/** An address of this app only: a day to open on another site is not followed. */
function ownPage(url) {
  try {
    return typeof url === 'string' && new URL(url).origin === self.location.origin && url.startsWith(appHome()) ? url : null;
  } catch {
    return null;
  }
}

function wrapMessage(data) {
  let raw = null;
  try { raw = data ? data.json() : null; } catch { raw = null; }
  const n = raw && typeof raw === 'object' && raw.web_push === DECLARATIVE && raw.notification && typeof raw.notification === 'object' ? raw.notification : null;
  const text = (value, max) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);
  if (!n || !text(n.title, 200)) return { title: FALLBACK_TITLE, options: { body: FALLBACK_BODY, tag: 'wrap', data: { navigate: appHome() } } };
  const options = { data: { navigate: ownPage(n.navigate) || appHome() } };
  if (text(n.body, 1000)) options.body = n.body;
  if (text(n.tag, 100)) options.tag = n.tag;
  if (text(n.lang, 35)) options.lang = n.lang;
  return { title: n.title, options };
}

self.addEventListener('push', (event) => {
  const { title, options } = wrapMessage(event.data);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = (data && ownPage(data.navigate)) || appHome();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = open.find((client) => ownPage(client.url));
    if (win) {
      try {
        await win.focus();
        await win.navigate(target);
        return;
      } catch { /* a window this worker does not control cannot be taken there: one opens on the day */ }
    }
    await self.clients.openWindow(target);
  })());
});
