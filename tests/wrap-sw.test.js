/**
 * sw.js's push and notificationclick listeners (ARCHITECTURE 3.10), run in a fake service-worker scope: a push always
 * shows a notification (the Declarative Web Push message as title, body, tag and the day to open, or a fixed fallback);
 * a click closes it, then focuses an open window and takes it to the day, or else opens one. Invented addresses only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://owner.example/app/';
const DAY = SCOPE + '#/board?sheet=day&s.day=2026-11-16';

function worker({ windows = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {},
    location: new URL(SCOPE + 'sw.js'),
    registration: { scope: SCOPE, showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); return null; },
    },
  };
  vm.runInNewContext(SOURCE, { self, URL, caches: {}, fetch: () => Promise.reject(new Error('no network')), console });
  return { handlers, shown, opened };
}

/** A push event as the browser gives it; `waited` holds what the listener asked to wait for. */
function pushEvent(payload) {
  const waited = [];
  const data = payload === undefined ? null : { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload), text: () => String(payload) };
  return { data, waitUntil: (p) => waited.push(p), waited };
}

test('sw.js: a Declarative Web Push message is shown as its title, body, tag and the day it opens', async () => {
  const w = worker();
  const ev = pushEvent({ web_push: 8030, notification: { title: 'Round 16 · cash ≈+$28.20 so far', body: 'In ≈$75.00 · out ≈$46.80.', navigate: DAY, lang: 'en-US', tag: 'wrap-2026-11-16' } });
  w.handlers.push(ev);
  await Promise.all(ev.waited);
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, 'Round 16 · cash ≈+$28.20 so far');
  assert.equal(w.shown[0].options.body, 'In ≈$75.00 · out ≈$46.80.');
  assert.equal(w.shown[0].options.tag, 'wrap-2026-11-16');
  assert.equal(w.shown[0].options.lang, 'en-US');
  assert.deepEqual({ ...w.shown[0].options.data }, { navigate: DAY });
});

test('sw.js: anything else still shows a notification (a fixed line that opens the app), never nothing', async () => {
  for (const payload of [undefined, 'not json', { web_push: 1 }, { web_push: 8030 }, { web_push: 8030, notification: { title: '' } }, [1, 2]]) {
    const w = worker();
    const ev = pushEvent(payload);
    w.handlers.push(ev);
    await Promise.all(ev.waited);
    assert.equal(w.shown.length, 1, JSON.stringify(payload));
    assert.equal(w.shown[0].title, 'Networth');
    assert.ok(w.shown[0].options.body.length > 0);
    assert.equal(w.shown[0].options.data.navigate, SCOPE);
  }
  // a day to open on another site is not followed: the app itself opens
  const w = worker();
  const ev = pushEvent({ web_push: 8030, notification: { title: 'Day 16 · tonight’s wrap', navigate: 'https://elsewhere.example/#/board' } });
  w.handlers.push(ev);
  await Promise.all(ev.waited);
  assert.equal(w.shown[0].title, 'Day 16 · tonight’s wrap');
  assert.equal(w.shown[0].options.data.navigate, SCOPE);
});

test('sw.js: a click closes the notification, focuses an open window and takes it to the day', async () => {
  const calls = [];
  const win = { url: SCOPE + '#/board', focus: async () => { calls.push('focus'); return win; }, navigate: async (url) => { calls.push('navigate ' + url); return win; } };
  const w = worker({ windows: [win] });
  const waited = [];
  let closed = false;
  w.handlers.notificationclick({ notification: { data: { navigate: DAY }, close: () => { closed = true; } }, waitUntil: (p) => waited.push(p) });
  assert.equal(closed, true, 'closed at once');
  await Promise.all(waited);
  assert.deepEqual(calls, ['focus', 'navigate ' + DAY]);
  assert.deepEqual(w.opened, []);
});

test('sw.js: a click with no window open opens one on the day', async () => {
  const w = worker({ windows: [{ url: 'https://elsewhere.example/', focus: async () => {}, navigate: async () => {} }] });
  const waited = [];
  w.handlers.notificationclick({ notification: { data: { navigate: DAY }, close: () => {} }, waitUntil: (p) => waited.push(p) });
  await Promise.all(waited);
  assert.deepEqual(w.opened, [DAY]);
  // a window that cannot be taken there (not controlled by this worker) is focused and a window opens on the day
  const stuck = { url: SCOPE, focus: async () => stuck, navigate: async () => { throw new TypeError('not controlled'); } };
  const w2 = worker({ windows: [stuck] });
  const waited2 = [];
  w2.handlers.notificationclick({ notification: { data: null, close: () => {} }, waitUntil: (p) => waited2.push(p) });
  await Promise.all(waited2);
  assert.deepEqual(w2.opened, [SCOPE], 'no day: the app itself');
});

test('sw.js keeps its name, cache and fetch listener', () => {
  const w = worker();
  assert.equal(typeof w.handlers.fetch, 'function');
  assert.equal(typeof w.handlers.install, 'function');
  assert.equal(typeof w.handlers.activate, 'function');
  assert.match(SOURCE, /const CACHE = 'networth-shell-v1';/);
});
