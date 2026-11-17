/**
 * The nightly wrap on the device (ARCHITECTURE 3.10): the transport of one file by path (github.js), the device's wrap
 * file and when it is written (js/wrap.js), and the push file. Every owner, key, device and amount here is invented.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ShareError, deleteRepoFile, putRepoFile, readRepoFile, repoFileUrl, toBase64, writeRepoFile } from '../js/github.js';

// the few globals a browser has, before js/wrap.js (which reads the store) is loaded; this file runs in a process of its own
const noop = () => {};
const el = () => ({ setAttribute: noop, getAttribute: () => null, addEventListener: noop, removeEventListener: noop, appendChild: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {} });
globalThis.BroadcastChannel = undefined;
globalThis.window = { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '', search: '' } };
globalThis.document = { addEventListener: noop, removeEventListener: noop, documentElement: el(), body: el(), createElement: el,
  querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
const { makeExporter, newDeviceId, pushFileOf, sameContent, lockOf, wrapStatus } = await import('../js/wrap.js');

const OWNER = 'example-owner';
const KEY = 'example_key_0123456789abcdefghij';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

/** A fake GitHub holding files by path; `answers` can make a request fail first. */
function fakeGitHub(files = {}, answers = []) {
  const calls = [];
  let n = 0;
  const doFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const forced = answers.shift();
    const reply = (status, body) => ({ status, headers: { get: () => null }, json: async () => body });
    if (forced) return reply(forced, { message: 'no' });
    const path = decodeURIComponent(url.replace('https://api.github.com/repos/' + OWNER + '/networth-data/contents/', ''));
    const have = files[path];
    if (init.method === 'GET') return have ? reply(200, { sha: have.sha, encoding: 'base64', content: toBase64(have.text) }) : reply(404, {});
    const body = JSON.parse(init.body);
    if (init.method === 'PUT') {
      if ((have && body.sha !== have.sha) || (!have && body.sha)) return reply(409, {});
      n += 1;
      files[path] = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: String(n).padStart(40, 'c') };
      return reply(have ? 200 : 201, { content: { sha: files[path].sha } });
    }
    if (init.method === 'DELETE') {
      if (!have) return reply(404, {});
      if (body.sha !== have.sha) return reply(409, {});
      delete files[path];
      return reply(200, {});
    }
    return reply(500, {});
  };
  return { files, calls, doFetch };
}

/* ------------------------------------------------------------------------------------------- the transport */

test('github: one file of push/ or wrap/ by path, nothing else', () => {
  assert.equal(repoFileUrl(OWNER, 'wrap/d1.json'), 'https://api.github.com/repos/example-owner/networth-data/contents/wrap/d1.json');
  assert.equal(repoFileUrl(OWNER, 'push/vapid.json'), 'https://api.github.com/repos/example-owner/networth-data/contents/push/vapid.json');
  for (const bad of ['networth-shared.json', 'wrap/../x.json', 'inbox/1.txt', 'wrap/a/b.json', 'push/.json', 'wrap/x.txt', '', null]) {
    assert.throws(() => repoFileUrl(OWNER, bad), ShareError, String(bad));
  }
  assert.throws(() => repoFileUrl('not an owner', 'wrap/d1.json'), ShareError);
});

test('github: read and write one file with its sha; no file is text null', async () => {
  const gh = fakeGitHub({ 'wrap/sent.json': { text: '{"format":"sent/1"}', sha: SHA1 } });
  assert.deepEqual(await readRepoFile(OWNER, KEY, 'wrap/sent.json', gh.doFetch), { text: '{"format":"sent/1"}', sha: SHA1 });
  assert.deepEqual(await readRepoFile(OWNER, KEY, 'push/vapid.json', gh.doFetch), { text: null, sha: null });
  const wrote = await writeRepoFile(OWNER, KEY, 'push/vapid.json', '{"a":1}', null, gh.doFetch);
  assert.match(wrote.sha, /^c+1$/);
  assert.equal(gh.files['push/vapid.json'].text, '{"a":1}');
  const put = gh.calls.at(-1);
  assert.equal(put.method, 'PUT');
  assert.equal(put.body.message, 'Networth: nightly wrap');
  assert.equal(put.body.sha, undefined);
  assert.deepEqual(Object.keys(put.headers).sort(), ['Accept', 'Authorization']);
  await assert.rejects(writeRepoFile(OWNER, KEY, 'push/vapid.json', '{}', SHA2, gh.doFetch), (e) => e instanceof ShareError && e.code === 'conflict');
});

test('github: putRepoFile reads, writes with the sha, and starts again on a conflict at most 3 more times', async () => {
  const gh = fakeGitHub({ 'wrap/d1.json': { text: 'old', sha: SHA1 } }, [undefined, 409, undefined, 409]);
  const seen = [];
  const out = await putRepoFile(OWNER, KEY, 'wrap/d1.json', (text) => { seen.push(text); return 'new'; }, gh.doFetch);
  assert.equal(out.written, true);
  assert.equal(gh.files['wrap/d1.json'].text, 'new');
  assert.deepEqual(seen, ['old', 'old', 'old'], 'read again after each conflict');
  // nothing to write: make says null, so no PUT is sent
  const quiet = fakeGitHub({ 'wrap/d1.json': { text: 'same', sha: SHA1 } });
  const none = await putRepoFile(OWNER, KEY, 'wrap/d1.json', () => null, quiet.doFetch);
  assert.equal(none.written, false);
  assert.deepEqual(quiet.calls.map((c) => c.method), ['GET']);
  // 4 conflicts in a row give up
  const busy = fakeGitHub({ 'wrap/d1.json': { text: 'x', sha: SHA1 } }, [undefined, 409, undefined, 409, undefined, 409, undefined, 409]);
  await assert.rejects(putRepoFile(OWNER, KEY, 'wrap/d1.json', () => 'y', busy.doFetch), (e) => e.code === 'conflict');
  assert.equal(busy.calls.filter((c) => c.method === 'PUT').length, 4);
});

test('github: deleteRepoFile removes the file by its sha; a file already gone is not an error', async () => {
  const gh = fakeGitHub({ 'push/d1.json': { text: '{}', sha: SHA1 } });
  assert.equal(await deleteRepoFile(OWNER, KEY, 'push/d1.json', gh.doFetch), true);
  assert.equal(gh.files['push/d1.json'], undefined);
  assert.equal(await deleteRepoFile(OWNER, KEY, 'push/d1.json', gh.doFetch), false);
  assert.equal(gh.calls.find((c) => c.method === 'DELETE').body.sha, SHA1);
});

/* --------------------------------------------------------------------------------------- the device's files */

test('the device id: random, stable in shape, never from the record', () => {
  const a = newDeviceId(() => 0.5);
  assert.match(a, /^[A-Za-z0-9_-]{16}$/);
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(newDeviceId());
  assert.equal(seen.size, 50);
});

test('the lock screen: follows the cover unless shown or hidden by choice', () => {
  assert.equal(lockOf('cover', { settings: { cover: true } }), 'hide');
  assert.equal(lockOf('cover', { settings: { cover: false } }), 'show');
  assert.equal(lockOf(undefined, { settings: { cover: false } }), 'show');
  assert.equal(lockOf('show', { settings: { cover: true } }), 'show');
  assert.equal(lockOf('hide', { settings: { cover: false } }), 'hide');
});

test('the push file: format push/1 with the subscription, words, lock and the app’s own address', () => {
  const sub = { endpoint: 'https://web.push.apple.com/QX', keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'y'.repeat(22) }, expirationTime: null };
  const file = pushFileOf({ device: 'dev1', appUrl: 'https://owner.example/app/', subscription: sub, words: 'finance', lock: 'hide', nowMs: Date.parse('2026-11-16T12:00:00Z') });
  assert.deepEqual(file, {
    format: 'push/1', device: 'dev1', appUrl: 'https://owner.example/app/',
    subscription: { endpoint: sub.endpoint, keys: sub.keys },
    words: 'finance', lock: 'hide', updatedAt: '2026-11-16T12:00:00.000Z',
  });
  assert.equal(sameContent(file, { ...file, updatedAt: '2026-11-17T00:00:00.000Z' }), true, 'the time it was written is not content');
  assert.equal(sameContent(file, { ...file, lock: 'show' }), false);
  assert.equal(sameContent({ format: 'wrap/1', writtenAt: 'a', days: { x: 1 } }, { format: 'wrap/1', writtenAt: 'b', days: { x: 1 } }), true);
});

/* ---------------------------------------------------------------------------------------------- the exporter */

test('the exporter: one write 2 seconds after a burst of changes, only when the content changed, never two at once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let content = { format: 'wrap/1', device: 'dev1', writtenAt: 't1', days: { '2026-11-16': { in: 100, out: 0 } } };
    let usable = true;
    const writes = [];
    let release = null;
    const ex = makeExporter({
      content: () => (usable ? content : null),
      write: async (file) => { writes.push(file); if (release === 'hold') await new Promise((r) => { release = r; }); },
      spacingMs: 2000,
    });
    for (let i = 0; i < 5; i++) { ex.poke(); mock.timers.tick(300); }
    assert.equal(writes.length, 0, 'not before 2 seconds have passed since the first change');
    mock.timers.tick(800);
    await ex.idle();
    assert.equal(writes.length, 1, 'one write for the burst');
    assert.equal(writes[0].format, 'wrap/1');
    // the same content again (only the time it was written differs): nothing is written
    content = { ...content, writtenAt: 't2' };
    ex.poke(); mock.timers.tick(2000); await ex.idle();
    assert.equal(writes.length, 1);
    // a change: written
    content = { ...content, writtenAt: 't3', days: { '2026-11-16': { in: 100, out: 450 } } };
    ex.poke(); mock.timers.tick(2000); await ex.idle();
    assert.equal(writes.length, 2);
    // not usable (sharing off, no night key, the sample game): nothing is written
    usable = false;
    content = { ...content, days: { '2026-11-16': { in: 1, out: 1 } } };
    ex.poke(); mock.timers.tick(2000); await ex.idle();
    assert.equal(writes.length, 2);
    // a change made while a write runs is written after it, once
    usable = true;
    release = 'hold';
    ex.poke(); mock.timers.tick(2000);
    assert.equal(writes.length, 3);
    content = { ...content, days: { '2026-11-16': { in: 2, out: 2 } } };
    ex.poke(); ex.poke(); mock.timers.tick(2000);
    assert.equal(writes.length, 3, 'no second write while one runs');
    const done = release; release = null; done();
    await ex.idle(); mock.timers.tick(2000); await ex.idle();
    assert.equal(writes.length, 4);
    assert.deepEqual(writes[3].days, { '2026-11-16': { in: 2, out: 2 } });
  } finally {
    mock.timers.reset();
  }
});

test('the exporter: a write that failed is tried again at the next change, and its content is not taken as written', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const content = { format: 'wrap/1', device: 'dev1', writtenAt: 't1', days: {} };
    let fail = true;
    const writes = [];
    const ex = makeExporter({ content: () => content, write: async (file) => { writes.push(file); if (fail) throw new ShareError('network'); }, spacingMs: 2000 });
    ex.poke(); mock.timers.tick(2000); await ex.idle();
    fail = false;
    ex.poke(); mock.timers.tick(2000); await ex.idle();
    assert.equal(writes.length, 2);
    ex.poke(); mock.timers.tick(2000); await ex.idle();
    assert.equal(writes.length, 2, 'written once it went through');
  } finally {
    mock.timers.reset();
  }
});

/* ------------------------------------------------------------------------------------------------- status */

test('the status from wrap/sent.json: the last wrap this device got, turned off by the push service, a key that does not match', () => {
  const sent = {
    format: 'sent/1', days: {},
    last: { at: '2026-11-17T02:33:00.000Z', day: '2026-11-16', sent: 1, dead: ['dGone'], problems: [{ device: 'dBusy', status: 429 }], devices: { dOk: 201, dGone: 410, dBusy: 429 } },
  };
  assert.deepEqual(wrapStatus(sent, 'dOk'), { lastAt: Date.parse('2026-11-17T02:33:00.000Z'), lastDay: '2026-11-16', got: true, dead: false, keyProblem: false, noKey: false, problem: null, retry: false, refused: false, nextRun: 'backup' });
  assert.equal(wrapStatus(sent, 'dGone').dead, true);
  assert.equal(wrapStatus(sent, 'dBusy').problem, 429);
  const key = { format: 'sent/1', days: {}, last: { at: '2026-11-17T02:33:00.000Z', day: '2026-11-16', sent: 0, dead: [], problems: [{ device: null, status: 'key' }], devices: {} } };
  assert.equal(wrapStatus(key, 'dOk').keyProblem, true);
  assert.equal(wrapStatus(key, 'dOk').noKey, false);
  // no secret at all on GitHub (none added, or added under another name)
  const none = { format: 'sent/1', days: {}, last: { at: '2026-11-17T02:33:00.000Z', day: '2026-11-16', sent: 0, dead: [], problems: [{ device: null, status: 'nokey' }], devices: {} } };
  assert.deepEqual([wrapStatus(none, 'dOk').noKey, wrapStatus(none, 'dOk').keyProblem], [true, false]);
  assert.deepEqual(wrapStatus(null, 'dOk'), { lastAt: null, lastDay: null, got: false, dead: false, keyProblem: false, noKey: false, problem: null, retry: false, refused: false, nextRun: 'night' });
  assert.deepEqual(wrapStatus('{not json', 'dOk').got, false);
});

test('the device’s wrap file: only with sharing on and a night key published, in the format the night job reads', async () => {
  const { wrapFileContent } = await import('../js/wrap.js');
  const { buildDemoState } = await import('../js/model/demo.js');
  const { readWrapFile } = await import('../js/model/wrap.js');
  const now = new Date(2026, 5, 18, 21, 0).getTime();
  const state = buildDemoState(now);
  const vapid = { publicKey: 'B' + 'A'.repeat(86), madeAt: now };
  assert.equal(wrapFileContent(state, now, 'dev1', { sharing: false, vapid }), null, 'sharing off');
  assert.equal(wrapFileContent(state, now, 'dev1', { sharing: true, vapid: null }), null, 'no night key');
  assert.equal(wrapFileContent(state, now, 'dev1', { sharing: true, vapid: undefined }), null, 'the night key not read yet');
  const file = wrapFileContent(state, now, 'dev1', { sharing: true, vapid });
  assert.equal(file.format, 'wrap/1');
  assert.equal(file.device, 'dev1');
  assert.equal(Object.keys(file.days).length, 8, 'today and the 7 days before');
  const read = readWrapFile(JSON.stringify(file));
  assert.equal(read.ok, true, read.problem);
  assert.ok(!/merchant|accountId|balance/i.test(JSON.stringify(file)), 'no merchant, account or balance');
});

test('turned off by the push service: only a subscription made before that night’s run counts as off', async () => {
  const { stillDead } = await import('../js/wrap.js');
  const night = Date.parse('2026-11-17T02:33:00.000Z');
  const status = { lastAt: night, lastDay: '2026-11-16', got: false, dead: true, keyProblem: false, problem: null };
  assert.equal(stillDead(status, { endpoint: 'https://web.push.apple.com/Q1', at: night - 3600000 }), true, 'made before the run');
  assert.equal(stillDead(status, { endpoint: 'https://web.push.apple.com/Q2', at: night + 3600000 }), false, 'turned back on after it');
  assert.equal(stillDead(status, null), true, 'no subscription on record');
  assert.equal(stillDead({ ...status, dead: false }, null), false);
  assert.equal(stillDead(status, { endpoint: 'https://web.push.apple.com/Q1' }), true, 'a copy with no time is taken as older');
  // the owner turned it off on this device since that run: off by their own choice, not by the push service
  assert.equal(stillDead(status, null, night + 60000), false, 'turned off by the owner after the run');
  // turned off by the owner, with no subscription since: Off, whatever a later run found (a push file left behind)
  assert.equal(stillDead(status, null, night - 60000), false, 'turned off before the run that found it gone');
  assert.equal(stillDead(status, { endpoint: 'https://web.push.apple.com/Q1', at: night - 3600000 }, night + 60000), true, 'on again since: the copy decides');
});

test('the status: the backup run tries again only a busy push service on the night’s first run; a refusal is said apart', async () => {
  const at = '2026-11-17T02:33:00.000Z';
  const sent = (last) => ({ format: 'sent/1', days: {}, last: { at, day: '2026-11-16', sent: 1, dead: [], problems: [], ...last } });
  const first = sent({ devices: { dBusy: 429, dNo: 403, dFile: 'file', dGone: 410 }, event: 'schedule', scheduled: true, schedules: 1 });
  assert.equal(wrapStatus(first, 'dBusy').retry, true);
  assert.equal(wrapStatus(first, 'dBusy').refused, false);
  assert.equal(wrapStatus(first, 'dNo').retry, false, 'a refusal is never tried again by the backup run');
  assert.equal(wrapStatus(first, 'dNo').refused, true);
  assert.equal(wrapStatus(first, 'dFile').refused, false);
  assert.equal(wrapStatus(first, 'dFile').retry, false);
  assert.equal(wrapStatus(first, 'dGone').refused, false, 'gone is turned off, said apart');
  const backup = sent({ devices: { dBusy: 429 }, event: 'schedule', scheduled: true, schedules: 2 });
  assert.equal(wrapStatus(backup, 'dBusy').retry, false, 'the backup run itself got 429: no run tries again tonight');
  const manual = sent({ devices: { dBusy: 503 }, event: 'manual', scheduled: false, schedules: 0 });
  assert.equal(wrapStatus(manual, 'dBusy').retry, false, 'a manual run is not the night’s first run');
  // the next run that checks the night key: the backup run when only the first scheduled run has run, else 9:33 PM
  assert.equal(wrapStatus(sent({ problems: [{ device: null, status: 'nokey' }], event: 'schedule', schedules: 1 }), 'dBusy').nextRun, 'backup');
  assert.equal(wrapStatus(sent({ problems: [{ device: null, status: 'nokey' }], event: 'schedule', schedules: 2 }), 'dBusy').nextRun, 'night');
});

test('Turn off: a push file whose removal failed is removed again on open and at each change, one try at a time', async () => {
  const { makeRemover } = await import('../js/wrap.js');
  let pending = true;
  let fail = true;
  let tries = 0;
  let done = 0;
  const remover = makeRemover({
    pending: () => pending,
    remove: async () => { tries += 1; await new Promise((r) => setTimeout(r, 5)); if (fail) throw new Error('500'); },
    done: () => { done += 1; pending = false; },
  });
  const one = remover.poke();
  remover.poke(); // while one runs: no second try
  await one;
  assert.deepEqual([tries, done], [1, 0], 'failed: still pending');
  fail = false;
  await remover.poke(); // the next open, or the next change
  assert.deepEqual([tries, done], [2, 1]);
  await remover.poke();
  assert.equal(tries, 2, 'nothing pending: no request');
});
