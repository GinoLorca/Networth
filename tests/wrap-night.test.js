/**
 * The whole night job (night/wrap.mjs), run as GitHub Actions runs it (`node night/wrap.mjs <dataDir>` with TZ set),
 * against an invented data folder and a local stub push server: the messages decrypt to the expected JSON, sent.json
 * records what was sent, the backup run sends again only where the push service failed for a while (never to a device
 * that got 201), a 410 marks the device dead and 403, 413 and 429 are
 * problems. Every key, device, amount and name here is invented.
 */

process.env.TZ = 'America/New_York';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';

import { emptyDay } from '../js/model/wrap.js';
import { readPushFile, readSentFile, recordSent, runWrap } from '../night/wrap.mjs';
import { revisionOf as revisionOfJob } from '../js/model/wrap.js';

const JOB = fileURLToPath(new URL('../night/wrap.mjs', import.meta.url));
const NOW = '2026-11-17T02:33:00.000Z'; // 9:33 PM in New York on November 16
const TODAY = '2026-11-16';
const APP = 'https://owner.example/app/';
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/* ------------------------------------------------------------------------------------- the stub push server */

const received = [];
let server;
let origin;
const ANSWERS = { '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403 };

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = ANSWERS[req.url] || 201;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});

after(() => server.close());

/* ----------------------------------------------------------------------------------------- the data folder */

const vapid = createECDH('prime256v1');
vapid.generateKeys();
const VAPID_PRIVATE_KEY = b64url(vapid.getPrivateKey());
const VAPID_PUBLIC_KEY = b64url(vapid.getPublicKey());

function receiver() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, auth: randomBytes(16) };
}

const devices = {
  dA: { path: '/QA-device-a', words: 'chess', lock: 'show', ...receiver() },
  dB: { path: '/QB-device-b', words: 'finance', lock: 'hide', ...receiver() },
  dC: { path: '/QC-gone', words: 'chess', lock: 'show', ...receiver() },
  dD: { path: '/QD-busy', words: 'chess', lock: 'show', ...receiver() },
  dF: { path: '/QF-large', words: 'chess', lock: 'show', ...receiver() },
  dG: { path: '/QG-key', words: 'chess', lock: 'show', ...receiver() },
  dE: { path: '/QE-elsewhere', words: 'chess', lock: 'show', host: 'https://push.example.net', ...receiver() },
};

const day = (status, inCents, outCents, extra = {}) => ({ ...emptyDay(status), in: inCents, out: outCents, ...extra });

function deviceFile(device, readAt, writtenAt, days) {
  return { format: 'wrap/1', device, writtenAt, readAt, dataAt: readAt, rollover: 4, countPending: true, days };
}

function dataFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'wrap-night-'));
  for (const sub of ['wrap', 'push', 'inbox', 'income']) mkdirSync(join(dir, sub));
  const write = (path, value) => writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const week = {};
  for (const d of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) week[d] = day('final', 0, 0);
  // device A read the bank at 8 PM tonight; device B this morning, and has nothing for tonight's late items
  write('wrap/dA.json', deviceFile('dA', '2026-11-17T01:00:00.000Z', '2026-11-17T01:05:00.000Z', {
    ...week,
    '2026-11-14': day('final', 0, 900),
    '2026-11-15': day('provisional', 6000, 48877, { seen: { alerts: [], income: ['club/i-cash'] } }),
    [TODAY]: day('live', 4500, 3180, {
      seen: { alerts: ['20261116-124500-000'], income: ['club/i-zelle'] },
      open: { charges: [[825, TODAY]], deposits: [] },
    }),
  }));
  write('wrap/dB.json', deviceFile('dB', '2026-11-16T14:00:00.000Z', '2026-11-16T14:01:00.000Z', {
    ...week,
    '2026-11-14': day('provisional', 0, 900),
    '2026-11-15': day('provisional', 6000, 40000),
    [TODAY]: day('live', 0, 0),
  }));
  write('wrap/sent.json', {
    format: 'sent/1',
    days: { '2026-11-15': { in: 6000, out: 40000, status: 'live', at: '2026-11-16T02:33:00.000Z' } },
    last: { at: '2026-11-16T02:33:00.000Z', day: '2026-11-15', sent: 2, dead: [], problems: [] },
  });
  write('wrap/notes.json', 'not a wrap file');
  write('push/vapid.json', { format: 'vapid/1', publicKey: VAPID_PUBLIC_KEY, madeAt: '2026-11-10T12:00:00.000Z' });
  for (const [id, d] of Object.entries(devices)) {
    write('push/' + id + '.json', {
      format: 'push/1', device: id, appUrl: APP,
      subscription: { endpoint: (d.host || 'https://web.push.apple.com') + d.path, keys: { p256dh: b64url(d.ecdh.getPublicKey()), auth: b64url(d.auth) } },
      words: d.words, lock: d.lock, updatedAt: '2026-11-10T12:00:00.000Z',
    });
  }
  const alert = (amount, merchant) => 'Northlight: A charge of $' + amount + ' at ' + merchant + ' was made on your card ending in 4321.';
  write('inbox/20261116-124500-000.txt', alert('12.00', 'FERNLEAF CAFE')); // device A counted it
  write('inbox/20261116-203000-000.txt', alert('15.00', 'QUILL BOOKS'));   // after A's reading
  write('inbox/20261116-204500-000.txt', alert('8.25', 'NORTHSIDE HARDWARE')); // its charge is already on A's record
  const at = (text) => new Date(text).toISOString();
  write('income/club.json', {
    format: 'income/1', what: 'Workshop', writtenAt: at('2026-11-17T01:30:00Z'),
    payers: [{ id: 'p-zelle', name: 'Kai' }, { id: 'p-cash', name: 'Robin' }],
    items: [
      { id: 'i-cash', payer: 'p-cash', cents: 6000, day: '2026-11-15', at: at('2026-11-15T19:00:00Z') },
      { id: 'i-zelle', payer: 'p-zelle', cents: 4500, day: TODAY, at: at('2026-11-16T15:00:00Z') },
      { id: 'i-new', payer: 'p-zelle', cents: 3000, day: TODAY, at: at('2026-11-17T01:00:00Z') },
    ],
  });
  const stamp = Date.parse('2026-10-01T12:00:00Z');
  write('networth-shared.json', { v: 1, income: { since: stamp, payers: { 'club/p-zelle': { how: 'bank', at: stamp }, 'club/p-cash': { how: 'cash', at: stamp } }, items: {}, counts: [] } });
  return dir;
}

/* ------------------------------------------------------------------------------------------------ helpers */

function run(dir, env = {}, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [JOB, dir, ...args], {
      env: { PATH: process.env.PATH, TZ: 'America/New_York', VAPID_PRIVATE_KEY, WRAP_PUSH_VIA: origin, WRAP_NOW: NOW, GITHUB_EVENT_NAME: 'schedule', ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function decrypt(body, device) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const secret = device.ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, device.auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8'));
}

function jwtOf(authorization) {
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
  assert.ok(m, authorization);
  const [head, claims, signature] = m[1].split('.');
  const raw = Buffer.from(m[2], 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33)) }, format: 'jwk' });
  return {
    k: m[2],
    claims: JSON.parse(Buffer.from(claims, 'base64url')),
    valid: verify('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
  };
}

/* ------------------------------------------------------------------------------------------------- the runs */

test('the night job: one message per device, encrypted, signed, and recorded', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    const { code, out, err } = await run(dir);
    assert.equal(code, 0, err);
    assert.ok(!/\$|75\.00|46\.80|Kai|Robin|QUILL/.test(out + err), 'no figure or name in the log: ' + out + err);
    const paths = received.map((r) => r.path).sort();
    assert.deepEqual(paths, ['/QA-device-a', '/QB-device-b', '/QC-gone', '/QD-busy', '/QF-large', '/QG-key'], 'nothing to a host that is not a push service');

    const a = received.find((r) => r.path === '/QA-device-a');
    assert.equal(a.headers.ttl, '43200');
    assert.equal(a.headers.urgency, 'high');
    assert.equal(a.headers.topic, 'wrap');
    assert.equal(a.headers['content-encoding'], 'aes128gcm');
    const token = jwtOf(a.headers.authorization);
    assert.equal(token.valid, true, 'the token verifies with the public key');
    assert.equal(token.k, VAPID_PUBLIC_KEY);
    assert.equal(token.claims.aud, 'https://web.push.apple.com');
    assert.equal(token.claims.sub, APP);
    assert.ok(token.claims.exp - Date.parse(NOW) / 1000 < 24 * 3600);
    // A's figure for today, the 15.00 alert that came after it (the 8.25 one is its open charge), the 30.00 payment
    // marked after it; yesterday changed since it was sent, so it gets the one clause
    assert.deepEqual(decrypt(a.body, devices.dA), {
      web_push: 8030,
      notification: {
        title: 'Round 16 · cash ≈+$28.20 so far',
        body: 'In ≈$75.00 · out ≈$46.80. Round 15 now ≈−$428.77, in pencil.',
        navigate: APP + '#/board?sheet=day&s.day=2026-11-16',
        lang: 'en-US',
        tag: 'wrap-2026-11-16',
      },
    });
    const b = received.find((r) => r.path === '/QB-device-b');
    assert.deepEqual(decrypt(b.body, devices.dB).notification, {
      title: 'Day 16 · tonight’s wrap',
      body: 'Tap to see money in and out.',
      navigate: APP + '#/board?sheet=day&s.day=2026-11-16',
      lang: 'en-US',
      tag: 'wrap-2026-11-16',
    });

    const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent, {
      format: 'sent/1',
      days: {
        '2026-11-15': { in: 6000, out: 48877, status: 'provisional', at: NOW },
        [TODAY]: { in: 7500, out: 4680, status: 'live', at: NOW },
      },
      last: {
        at: NOW, day: TODAY, sent: 2, dead: ['dC'],
        problems: [{ device: 'dD', status: 429 }, { device: 'dE', status: 'endpoint' }, { device: 'dF', status: 413 }, { device: 'dG', status: 403 }],
        devices: { dA: 201, dB: 201, dC: 410, dD: 429, dE: 'endpoint', dF: 413, dG: 403 },
        revision: { day: '2026-11-15', net: -42877, final: false, told: true, in: 6000, out: 48877, status: 'provisional' },
        event: 'schedule',
        scheduled: true,
        schedules: 1,
      },
    });
    assert.equal(readSentFile(readFileSync(join(dir, 'wrap/sent.json'), 'utf8')).days[TODAY].out, 4680);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: the backup run sends again only where the push service failed for a while, even late at night', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    assert.equal((await run(dir)).code, 0);
    const first = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(first.last.devices, { dA: 201, dB: 201, dC: 410, dD: 429, dE: 'endpoint', dF: 413, dG: 403 }, 'each device’s status is kept');
    const count = received.length;
    // 11:30 PM in New York: still the same game day there (in UTC it would already be the next one); dD answered 429
    const again = await run(dir, { WRAP_NOW: '2026-11-17T04:30:00.000Z' });
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(received.slice(count).map((r) => r.path), ['/QD-busy'], 'only the device that got 429, never one that got 201');
    const second = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(second.days, first.days, 'nothing new was delivered');
    assert.deepEqual(second.last.devices, first.last.devices);
    assert.equal(second.last.sent, 2);
    assert.deepEqual(second.last.dead, ['dC']);
    // a run by hand (not scheduled) sends again to every device
    const manual = await run(dir, { GITHUB_EVENT_NAME: 'workflow_dispatch' });
    assert.equal(manual.code, 0, manual.err);
    assert.equal(received.length, count * 2 + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: --dry prints the messages and sends and writes nothing', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    const before = readFileSync(join(dir, 'wrap/sent.json'), 'utf8');
    const { code, out, err } = await run(dir, { VAPID_PRIVATE_KEY: '' }, ['--dry']);
    assert.equal(code, 0, err);
    assert.equal(received.length, 0);
    assert.equal(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'), before);
    assert.ok(out.includes('Round 16 · cash ≈+$28.20 so far'), out);
    assert.ok(out.includes('Day 16 · tonight’s wrap'), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: no key, or a key that is not the devices’ key, sends nothing', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    const missing = await run(dir, { VAPID_PRIVATE_KEY: '' });
    assert.notEqual(missing.code, 0);
    assert.equal(received.length, 0);
    const other = createECDH('prime256v1');
    other.generateKeys();
    const wrong = await run(dir, { VAPID_PRIVATE_KEY: b64url(other.getPrivateKey()) });
    assert.equal(wrong.code, 1, 'a key that is not the devices’ key fails the run');
    assert.equal(received.length, 0);
    const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent.last.problems, [{ device: null, status: 'key' }]);
    assert.ok(!sent.days[TODAY], 'not marked as sent: the backup run tries again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: the first night, before any device wrote its file, sends card alerts and marked payments only', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    rmSync(join(dir, 'wrap'), { recursive: true, force: true });
    // a link in the inbox to a text elsewhere on the runner is not read, though it would parse as a purchase
    writeFileSync(join(dir, 'elsewhere.txt'), 'Northlight: A charge of $5.00 at QUILL BOOKS was made on your card ending in 4321.');
    symlinkSync(join(dir, 'elsewhere.txt'), join(dir, 'inbox', '20261116-210000-000.txt'));
    const { code, err } = await run(dir);
    assert.equal(code, 0, err);
    const a = received.find((r) => r.path === '/QA-device-a');
    // every alert of today (12.00 + 15.00 + 8.25, none seen and no charge open) and both payments marked today
    assert.equal(decrypt(a.body, devices.dA).notification.title, 'Round 16 · cash ≈+$39.75 so far');
    assert.equal(decrypt(a.body, devices.dA).notification.body, 'Bank not read today: in ≈$75.00 · out ≈$35.25.');
    const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent.days, { [TODAY]: { in: 7500, out: 3525, status: 'live', at: NOW } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a device’s push file is read strictly', () => {
  const good = {
    format: 'push/1', device: 'dA', appUrl: APP,
    subscription: { endpoint: 'https://web.push.apple.com/QA', keys: { p256dh: b64url(devices.dA.ecdh.getPublicKey()), auth: b64url(devices.dA.auth) } },
    words: 'finance', lock: 'show', updatedAt: '2026-11-10T12:00:00.000Z',
  };
  const read = (change) => {
    const copy = JSON.parse(JSON.stringify(good));
    change(copy);
    return readPushFile(JSON.stringify(copy), 'dA');
  };
  assert.equal(read(() => {}).ok, true);
  assert.equal(read(() => {}).file.words, 'finance');
  assert.equal(read((f) => { f.lock = 'maybe'; }).file.lock, 'hide', 'anything but show hides the amounts');
  assert.equal(read((f) => { f.device = 'dZ'; }).ok, false, 'a file speaks for its own device only');
  assert.equal(read((f) => { f.appUrl = 'http://owner.example/'; }).ok, false);
  assert.equal(read((f) => { f.subscription.endpoint = 'http://web.push.apple.com/QA'; }).ok, false);
  assert.equal(read((f) => { f.subscription.keys.auth = 'short'; }).ok, false);
  assert.equal(read((f) => { f.format = 'push/2'; }).ok, false);
  assert.equal(readPushFile('{', 'dA').ok, false);
  assert.equal(existsSync(JOB), true);
});

/* ------------------------------------------------------------------------- the run in this process, by fixture */

/** A push service in this process: answers by path, and records what it was sent. */
function pushService(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: Buffer.from(init.body) });
    const status = typeof answers[path] === 'function' ? answers[path]() : answers[path] || 201;
    return { status, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { calls, fetchImpl };
}

const runIn = (dir, nowIso, push, more = {}) => runWrap(dir, { scheduled: true, nowMs: Date.parse(nowIso), secret: VAPID_PRIVATE_KEY, fetchImpl: push.fetchImpl, ...more });

function writePush(dir, id, change = (f) => f) {
  const d = devices.dA;
  const file = {
    format: 'push/1', device: id, appUrl: APP,
    subscription: { endpoint: 'https://web.push.apple.com/Q-' + id, keys: { p256dh: b64url(d.ecdh.getPublicKey()), auth: b64url(d.auth) } },
    words: 'chess', lock: 'show', updatedAt: '2026-11-10T12:00:00.000Z',
  };
  writeFileSync(join(dir, 'push', id + '.json'), JSON.stringify(change(file)));
}

test('a push file whose p256dh is not a point on P-256 is refused', () => {
  const dir = dataFolder();
  try {
    writePush(dir, 'dBad', (f) => { f.subscription.keys.p256dh = 'B' + 'A'.repeat(86); return f; });
    const read = readPushFile(readFileSync(join(dir, 'push', 'dBad.json'), 'utf8'), 'dBad');
    assert.deepEqual(read, { ok: false, problem: 'p256dh' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: a bad subscription, sorted first or last, never stops the run', async () => {
  for (const id of ['a0bad', 'zzbad']) {
    const dir = dataFolder();
    try {
      writePush(dir, id, (f) => { f.subscription.keys.p256dh = 'B' + 'A'.repeat(86); return f; });
      // and one that passes the reader but cannot be signed for (its address is not https:// as the token needs)
      writePush(dir, id === 'a0bad' ? 'a1url' : 'zzurl', (f) => { f.appUrl = 'HTTPS://owner.example/app/'; return f; });
      const push = pushService({ '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403 });
      const result = await runIn(dir, NOW, push);
      assert.deepEqual(push.calls.map((c) => c.path).sort(), ['/QA-device-a', '/QB-device-b', '/QC-gone', '/QD-busy', '/QF-large', '/QG-key']);
      assert.equal(result.sent, 2);
      const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
      assert.equal(sent.last.sent, 2, 'sent.json is written');
      const url = id === 'a0bad' ? 'a1url' : 'zzurl';
      assert.ok(sent.last.problems.some((p) => p.device === id && p.status === 'file'), JSON.stringify(sent.last.problems));
      assert.ok(sent.last.problems.some((p) => p.device === url && p.status === 'subscription'), JSON.stringify(sent.last.problems));
      assert.equal(sent.last.devices[url], 'subscription');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the night job: reads and writes regular files only, never through a link', async () => {
  const dir = dataFolder();
  const outside = mkdtempSync(join(tmpdir(), 'wrap-outside-'));
  try {
    // sent.json, the shared file and the published key are links to files outside the data folder
    const target = join(outside, 'target.json');
    const original = JSON.stringify({ format: 'sent/1', days: { [TODAY]: { in: 1, out: 1, status: 'live', at: NOW } }, last: null });
    writeFileSync(target, original);
    unlinkSync(join(dir, 'wrap', 'sent.json'));
    symlinkSync(target, join(dir, 'wrap', 'sent.json'));
    const other = createECDH('prime256v1');
    other.generateKeys();
    writeFileSync(join(outside, 'vapid.json'), JSON.stringify({ format: 'vapid/1', publicKey: b64url(other.getPublicKey()), madeAt: '2026-11-10T12:00:00.000Z' }));
    unlinkSync(join(dir, 'push', 'vapid.json'));
    symlinkSync(join(outside, 'vapid.json'), join(dir, 'push', 'vapid.json'));
    writeFileSync(join(outside, 'shared.json'), JSON.stringify({ v: 1, income: { since: 0, payers: {}, items: {}, counts: [] } }));
    rmSync(join(dir, 'networth-shared.json'));
    symlinkSync(join(outside, 'shared.json'), join(dir, 'networth-shared.json'));
    const push = pushService();
    const result = await runIn(dir, NOW, push);
    // the linked sent.json was taken as missing (a scheduled run went ahead) and the linked key was not read (it would
    // have stopped every message)
    assert.equal(result.status, 'sent');
    assert.equal(push.calls.length, 6);
    assert.equal(readFileSync(target, 'utf8'), original, 'the file outside is untouched');
    assert.equal(lstatSync(join(dir, 'wrap', 'sent.json')).isFile(), true, 'sent.json is now a regular file');
    assert.equal(JSON.parse(readFileSync(join(dir, 'wrap', 'sent.json'), 'utf8')).last.sent, 6);
    // the linked shared file was not read: no answers, so the cash payment of 11-15 does not count as cash
    const a = push.calls.find((c) => c.path === '/QA-device-a');
    assert.ok(decrypt(a.body, devices.dA).notification.title.startsWith('Round 16'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the night job: a backup run retries 0, 429 and 5xx only, and never sends twice to a device that got 201', async () => {
  const dir = dataFolder();
  try {
    writePush(dir, 'dNet');
    writePush(dir, 'dSrv');
    let netUp = false;
    const answers = { '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403, '/Q-dNet': () => (netUp ? 201 : 0), '/Q-dSrv': 503 };
    const push = pushService(answers);
    await runIn(dir, NOW, push);
    const first = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(first.last.devices, { dA: 201, dB: 201, dC: 410, dD: 429, dE: 'endpoint', dF: 413, dG: 403, dNet: 0, dSrv: 503 });
    // the backup run: the network is back for dNet; dD and dSrv still fail
    netUp = true;
    const n = push.calls.length;
    await runIn(dir, '2026-11-17T03:13:00.000Z', push);
    assert.deepEqual(push.calls.slice(n).map((c) => c.path).sort(), ['/Q-dNet', '/QD-busy', '/Q-dSrv'].sort());
    const second = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(second.last.sent, 3);
    assert.equal(second.last.devices.dNet, 201);
    assert.deepEqual(second.last.dead, ['dC']);
    assert.deepEqual(second.last.problems.map((p) => p.device + ':' + p.status), ['dD:429', 'dE:endpoint', 'dF:413', 'dG:403', 'dSrv:503']);
    // a third scheduled run tries only the two still failing; once they get 201 nothing is left to send
    answers['/QD-busy'] = 201;
    answers['/Q-dSrv'] = 201;
    const m = push.calls.length;
    await runIn(dir, '2026-11-17T03:40:00.000Z', push);
    assert.deepEqual(push.calls.slice(m).map((c) => c.path).sort(), ['/Q-dSrv', '/QD-busy']);
    const k = push.calls.length;
    const last = await runIn(dir, '2026-11-17T04:00:00.000Z', push);
    assert.equal(last.status, 'skipped');
    assert.equal(push.calls.length, k);
    const counts = {};
    for (const c of push.calls) counts[c.path] = (counts[c.path] || 0) + 1;
    // each device until its first 201, and never after it
    assert.deepEqual(counts, { '/QA-device-a': 1, '/QB-device-b': 1, '/QC-gone': 1, '/QD-busy': 3, '/QF-large': 1, '/QG-key': 1, '/Q-dNet': 2, '/Q-dSrv': 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: a revision clause that did not fit is not recorded, and is told on a later night', async () => {
  const dir = dataFolder();
  const alert = (amount, merchant) => 'Northlight: A charge of $' + amount + ' at ' + merchant + ' was made on your card ending in 4321.';
  try {
    const push = pushService({ '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403 });
    const textOf = (from) => decrypt(push.calls.slice(from).find((c) => c.path === '/QA-device-a').body, devices.dA).notification;
    await runIn(dir, NOW, push); // night 1: November 16 is told as in 75.00, out 46.80
    // after it, a late alert for November 16; on November 17 no device reads the bank, and a large alert comes in
    writeFileSync(join(dir, 'inbox', '20261116-233000-000.txt'), alert('5.25', 'DINER'));
    writeFileSync(join(dir, 'inbox', '20261117-120000-000.txt'), alert('1,234.56', 'LENS SHOP'));
    let from = push.calls.length;
    await runIn(dir, '2026-11-18T02:33:00.000Z', push); // night 2
    const night2 = textOf(from);
    assert.equal(night2.body, 'Bank not read today: nothing in · out ≈$1,234.56.', 'the clause did not fit');
    let sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent.days[TODAY], { in: 7500, out: 4680, status: 'live', at: NOW }, 'November 16 is still as told');
    assert.equal(sent.days['2026-11-17'].out, 123456);
    from = push.calls.length;
    await runIn(dir, '2026-11-19T02:33:00.000Z', push); // night 3: a quiet day, so the clause fits
    assert.equal(textOf(from).body, 'Bank not read today. Round 16 now ≈+$22.95, in pencil.');
    sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(sent.days[TODAY].out, 5205, 'told, so recorded');
    from = push.calls.length;
    await runIn(dir, '2026-11-20T02:33:00.000Z', push); // night 4: nothing more to tell
    assert.equal(textOf(from).body, 'Bank not read today.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: folders that are links are not read through, and sent.json is written inside the data folder', async () => {
  const dir = dataFolder();
  const outside = mkdtempSync(join(tmpdir(), 'wrap-outside-'));
  try {
    // wrap/ and push/ are links to folders elsewhere on the runner, holding files that would parse
    for (const sub of ['wrap', 'push']) {
      mkdirSync(join(outside, sub));
      for (const name of ['dA.json', 'sent.json']) {
        try { writeFileSync(join(outside, sub, name), readFileSync(join(dir, sub, name))); } catch { /* push has no sent.json */ }
      }
      rmSync(join(dir, sub), { recursive: true });
      symlinkSync(join(outside, sub), join(dir, sub));
    }
    const before = readFileSync(join(outside, 'wrap', 'sent.json'), 'utf8');
    const push = pushService();
    const result = await runIn(dir, NOW, push);
    assert.equal(push.calls.length, 0, 'no push file was read through the link');
    assert.equal(result.sent, 0);
    assert.equal(readFileSync(join(outside, 'wrap', 'sent.json'), 'utf8'), before, 'the folder outside is untouched');
    assert.equal(lstatSync(join(dir, 'wrap')).isDirectory(), true, 'wrap/ is now a folder of the data checkout');
    assert.equal(JSON.parse(readFileSync(join(dir, 'wrap', 'sent.json'), 'utf8')).format, 'sent/1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('sent.json is read leniently: a malformed last run is cleaned, and a later run still records the night', async () => {
  const dir = dataFolder();
  try {
    writeFileSync(join(dir, 'wrap', 'sent.json'), JSON.stringify({
      format: 'sent/1',
      days: { [TODAY]: { in: 1, out: 1, status: 'live', at: NOW } },
      last: { at: NOW, day: TODAY, sent: 'x', dead: [null, 'dC', '../x'], problems: [null, 7, { device: 'dD', status: 429 }, { device: {}, status: 1 }], devices: { dD: 429, '../x': 500, dA: {} } },
    }));
    const read = readSentFile(readFileSync(join(dir, 'wrap', 'sent.json'), 'utf8'));
    assert.deepEqual(read.last, { at: NOW, day: TODAY, sent: 0, dead: ['dC'], problems: [{ device: 'dD', status: 429 }], devices: { dD: 429 }, revision: null, event: 'schedule', scheduled: true, schedules: 1 });
    const push = pushService();
    await runIn(dir, '2026-11-17T03:13:00.000Z', push);
    assert.deepEqual(push.calls.map((c) => c.path), ['/QD-busy'], 'the backup run tries the 429 device only');
    const sent = JSON.parse(readFileSync(join(dir, 'wrap', 'sent.json'), 'utf8'));
    assert.deepEqual(sent.last.devices, { dD: 201 });
    assert.deepEqual(sent.last.dead, ['dC']);
    assert.deepEqual(sent.last.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: a message only a hidden device got does not record the revision as told', async () => {
  const dir = dataFolder();
  try {
    // only dB (amounts hidden) gets 201: the clause reached no lock screen
    const push = pushService({ '/QA-device-a': 500, '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403 });
    await runIn(dir, NOW, push);
    const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent.days['2026-11-15'], { in: 6000, out: 40000, status: 'live', at: '2026-11-16T02:33:00.000Z' }, 'yesterday still as last told');
    assert.equal(sent.days[TODAY].out, 4680);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ part 2: the last fixes of part 1 */

test('the night job: the backup run keeps the night’s figure and sends the retried device the night’s clause', async () => {
  const dir = dataFolder();
  const alert = (amount, merchant) => 'Northlight: A charge of $' + amount + ' at ' + merchant + ' was made on your card ending in 4321.';
  try {
    const answers = { '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403 };
    const push = pushService(answers);
    const textOf = (from, path, device) => decrypt(push.calls.slice(from).find((c) => c.path === path).body, device).notification;
    await runIn(dir, NOW, push); // 21:33: dA gets 201 with the clause about November 15; dD gets 429
    const told = textOf(0, '/QA-device-a', devices.dA);
    assert.equal(told.body, 'In ≈$75.00 · out ≈$46.80. Round 15 now ≈−$428.77, in pencil.');
    const first = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(first.last.revision, { day: '2026-11-15', net: -42877, final: false, told: true, in: 6000, out: 48877, status: 'provisional' }, 'the night’s clause is kept, told, with the figures it was built from');
    // a card alert at 22:00 changes November 16 between the two runs
    writeFileSync(join(dir, 'inbox', '20261116-220000-000.txt'), alert('5.25', 'DINER'));
    answers['/QD-busy'] = 201;
    const from = push.calls.length;
    await runIn(dir, '2026-11-17T03:13:00.000Z', push); // 22:13: the backup tries dD alone
    assert.deepEqual(push.calls.slice(from).map((c) => c.path), ['/QD-busy']);
    const retried = textOf(from, '/QD-busy', devices.dD);
    assert.equal(retried.body, 'In ≈$75.00 · out ≈$52.05. Round 15 now ≈−$428.77, in pencil.', 'the same clause the others got that night');
    const second = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(second.days[TODAY], first.days[TODAY], 'today stays as the first run told it');
    assert.deepEqual(second.days['2026-11-15'], first.days['2026-11-15'], 'the revised day too');
    assert.deepEqual(second.last.revision, first.last.revision);
    // the next night tells dA (told out 46.80 at 21:33) that November 16 changed
    const next = push.calls.length;
    await runIn(dir, '2026-11-18T02:33:00.000Z', push);
    assert.equal(textOf(next, '/QA-device-a', devices.dA).body, 'Bank not read today. Round 16 now ≈+$22.95, in pencil.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: a retried device gets the clause the first run told, and nothing is recorded twice', async () => {
  const dir = dataFolder();
  const alert = (amount, merchant) => 'Northlight: A charge of $' + amount + ' at ' + merchant + ' was made on your card ending in 4321.';
  try {
    const answers = { '/QC-gone': 410, '/QF-large': 413, '/QG-key': 403 };
    const push = pushService(answers);
    const textOf = (from, path, device) => decrypt(push.calls.slice(from).find((c) => c.path === path).body, device).notification;
    await runIn(dir, NOW, push); // night 1: everyone that can gets 201
    writeFileSync(join(dir, 'inbox', '20261116-233000-000.txt'), alert('5.25', 'DINER')); // November 16 changes after it
    answers['/QD-busy'] = 429;
    let from = push.calls.length;
    await runIn(dir, '2026-11-18T02:33:00.000Z', push); // night 2 at 21:33: dA gets the clause, dD (shows amounts) 429
    const a = textOf(from, '/QA-device-a', devices.dA);
    assert.equal(a.body, 'Bank not read today. Round 16 now ≈+$22.95, in pencil.');
    answers['/QD-busy'] = 201;
    from = push.calls.length;
    await runIn(dir, '2026-11-18T03:13:00.000Z', push); // the backup
    assert.equal(textOf(from, '/QD-busy', devices.dD).body, a.body, 'dD hears what dA heard');
    const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(sent.days[TODAY].out, 5205, 'told at 21:33 and kept');
    assert.equal(sent.days['2026-11-17'].at, '2026-11-18T02:33:00.000Z', 'today as the first run recorded it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: a folder at wrap/sent.json, or a wrap that is not a folder, is replaced and the night recorded', async () => {
  for (const shape of ['folder', 'file']) {
    const dir = dataFolder();
    try {
      if (shape === 'folder') {
        rmSync(join(dir, 'wrap', 'sent.json'));
        mkdirSync(join(dir, 'wrap', 'sent.json'));
        writeFileSync(join(dir, 'wrap', 'sent.json', 'x'), 'x');
      } else {
        rmSync(join(dir, 'wrap'), { recursive: true });
        writeFileSync(join(dir, 'wrap'), 'not a folder');
      }
      const push = pushService({ '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403 });
      const result = await runIn(dir, NOW, push);
      assert.ok(result.sent > 0, shape);
      assert.equal(lstatSync(join(dir, 'wrap')).isDirectory(), true, shape);
      assert.equal(lstatSync(join(dir, 'wrap', 'sent.json')).isFile(), true, shape);
      assert.ok(JSON.parse(readFileSync(join(dir, 'wrap', 'sent.json'), 'utf8')).days[TODAY], shape);
      // the backup run finds the night recorded and sends to the 429 device alone
      const n = push.calls.length;
      await runIn(dir, '2026-11-17T03:13:00.000Z', push);
      assert.deepEqual(push.calls.slice(n).map((c) => c.path), ['/QD-busy'], shape);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the night job: a night key that does not parse, or is not the published one, fails the run', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    const bad = await run(dir, { VAPID_PRIVATE_KEY: 'not-a-key' });
    assert.equal(bad.code, 1, bad.out + bad.err);
    assert.equal(received.length, 0);
    assert.ok(!/not-a-key/.test(bad.out + bad.err), 'the secret is never printed');
    let sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent.last.problems, [{ device: null, status: 'key' }], 'the devices can show the problem');
    const other = createECDH('prime256v1');
    other.generateKeys();
    const wrong = await run(dir, { VAPID_PRIVATE_KEY: b64url(other.getPrivateKey()) });
    assert.equal(wrong.code, 1, wrong.out + wrong.err);
    assert.equal(received.length, 0);
    sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent.last.problems, [{ device: null, status: 'key' }]);
    assert.ok(!sent.days[TODAY]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------------------------------- part 2: the fix round */

test('the night job: a clause the backup run first brings to a lock screen that shows amounts counts as told', async () => {
  const dir = dataFolder();
  try {
    // 21:33: only dB (amounts hidden) gets 201; dD (shows amounts) answers 429; dA is refused for good
    const answers = { '/QA-device-a': 403, '/QC-gone': 410, '/QD-busy': 429, '/QF-large': 413, '/QG-key': 403 };
    const push = pushService(answers);
    const textOf = (from, path, device) => decrypt(push.calls.slice(from).find((c) => c.path === path).body, device).notification;
    await runIn(dir, NOW, push);
    const first = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(first.days['2026-11-15'], { in: 6000, out: 40000, status: 'live', at: '2026-11-16T02:33:00.000Z' }, 'not told yet');
    assert.equal(first.last.revision.told, false, 'the first run did not tell it');
    assert.deepEqual([first.last.revision.in, first.last.revision.out, first.last.revision.status], [6000, 48877, 'provisional'], 'the figures it was built from');
    // 22:13: the backup brings dD the clause
    answers['/QD-busy'] = 201;
    let from = push.calls.length;
    await runIn(dir, '2026-11-17T03:13:00.000Z', push);
    assert.deepEqual(push.calls.slice(from).map((c) => c.path), ['/QD-busy']);
    assert.equal(textOf(from, '/QD-busy', devices.dD).body, 'In ≈$75.00 · out ≈$46.80. Round 15 now ≈−$428.77, in pencil.');
    const second = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(second.days['2026-11-15'], { in: 6000, out: 48877, status: 'provisional', at: '2026-11-17T03:13:00.000Z' }, 'now told');
    assert.equal(second.last.revision.told, true);
    assert.deepEqual(second.days[TODAY], first.days[TODAY], 'today stays as the first run told it');
    // the next night: nothing changed, so no clause, and dD does not hear the same one again
    from = push.calls.length;
    await runIn(dir, '2026-11-18T02:33:00.000Z', push);
    const next = textOf(from, '/QD-busy', devices.dD).body;
    assert.ok(!/Round 15/.test(next), next);
    assert.equal(JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8')).last.revision, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: a manual run does not take the place of that night’s scheduled wrap', async () => {
  const dir = dataFolder();
  try {
    const push = pushService({ '/QC-gone': 410, '/QF-large': 413, '/QG-key': 403 });
    const pathsFrom = (n) => push.calls.slice(n).map((c) => c.path).sort();
    // 20:00: the owner's test run (workflow_dispatch)
    const manual = await runIn(dir, '2026-11-17T01:00:00.000Z', push, { scheduled: false });
    assert.equal(manual.status, 'sent');
    const test1 = decrypt(push.calls.find((c) => c.path === '/QA-device-a').body, devices.dA).notification;
    let sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(sent.last.event, 'manual', 'the trigger is recorded');
    // 21:33: the scheduled wrap goes to every device, as on any night, and replaces the test (the same tag)
    let from = push.calls.length;
    const night = await runIn(dir, NOW, push);
    assert.equal(night.status, 'sent');
    assert.equal(night.prior, null, 'not a backup run');
    assert.deepEqual(pathsFrom(from), ['/QA-device-a', '/QB-device-b', '/QC-gone', '/QD-busy', '/QF-large', '/QG-key']);
    const real = decrypt(push.calls.slice(from).find((c) => c.path === '/QA-device-a').body, devices.dA).notification;
    assert.equal(real.tag, test1.tag);
    assert.equal(real.body, test1.body, 'the clause the test told is in the wrap that replaces it');
    sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(sent.last.event, 'schedule');
    assert.equal(sent.days[TODAY].at, new Date(NOW).toISOString(), 'today as the scheduled run told it');
    // 22:13: after a scheduled run, the backup sends again only where the push service failed for a while (none here)
    from = push.calls.length;
    const backup = await runIn(dir, '2026-11-17T03:13:00.000Z', push);
    assert.equal(backup.status, 'skipped');
    assert.equal(push.calls.length, from);
    // a sent.json from before the trigger was recorded is taken as a scheduled run's
    const older = readSentFile(JSON.stringify({ ...sent, last: { ...sent.last, event: undefined } }));
    assert.equal(older.last.event, 'schedule');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: no secret at all is recorded in sent.json for the devices, and still fails the run', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    const missing = await run(dir, { VAPID_PRIVATE_KEY: '' });
    assert.equal(missing.code, 1, missing.out + missing.err);
    assert.match(missing.err, /VAPID_PRIVATE_KEY is not set/);
    assert.equal(received.length, 0, 'nothing sent');
    const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.deepEqual(sent.last.problems, [{ device: null, status: 'nokey' }], 'the devices can show it');
    assert.ok(!sent.days[TODAY], 'not marked as sent');
    assert.deepEqual(readSentFile(JSON.stringify(sent)).last.problems, [{ device: null, status: 'nokey' }]);
    const dry = await run(dir, { VAPID_PRIVATE_KEY: '' }, ['--dry']);
    assert.equal(dry.code, 0, 'a dry run needs no secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: before the night key is made it does nothing and the run stays green', async () => {
  const dir = dataFolder();
  try {
    received.length = 0;
    rmSync(join(dir, 'push', 'vapid.json'));
    rmSync(join(dir, 'wrap', 'sent.json'), { force: true });
    const before = await run(dir, { VAPID_PRIVATE_KEY: '' });
    assert.equal(before.code, 0, before.out + before.err);
    assert.match(before.out, /not set up yet/);
    assert.equal(received.length, 0, 'nothing sent');
    assert.ok(!existsSync(join(dir, 'wrap', 'sent.json')), 'nothing written, so nothing to commit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow saves sent.json on a runner that has no git identity, while a device writes to the repository', () => {
  // GitHub's runner cannot guess an identity ("runner@...(none)"); a device writing during the run makes the pull a
  // rebase, which needs a committer identity of its own, not only the commit: the step must set one for both
  const yml = readFileSync(fileURLToPath(new URL('../night/wrap.yml.txt', import.meta.url)), 'utf8');
  const step = yml.slice(yml.indexOf('- name: Keep what was sent'));
  const script = step.slice(step.indexOf('run: |') + 'run: |'.length).split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'wrap-keep-'));
  const sh = (cmd, cwd, env = {}) => execFileSync('bash', ['-e', '-c', cmd], { cwd, env: { ...process.env, HOME: join(dir, 'home'), GIT_CONFIG_NOSYSTEM: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    mkdirSync(join(dir, 'home'));
    writeFileSync(join(dir, 'home', '.gitconfig'), '[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n'); // no guessing, as on the runner
    const who = '-c user.name=dev -c user.email=dev@example.com';
    sh('git init -q --bare origin.git', dir);
    sh('git clone -q origin.git seed && cd seed && mkdir wrap && echo "{}" > wrap/a.json && git add -A && git ' + who + ' commit -q -m seed && git push -q origin HEAD:main', dir);
    sh('git clone -q origin.git data', dir);
    // a device writes while the job runs
    sh('cd seed && echo "{\\"x\\":1}" > wrap/device.json && git add -A && git ' + who + ' commit -q -m device && git push -q origin HEAD:main', dir);
    writeFileSync(join(dir, 'data', 'wrap', 'sent.json'), '{"format":"sent/1"}\n');
    sh(script, join(dir, 'data'), { GITHUB_REF_NAME: 'main' });
    const saved = sh('git --git-dir=origin.git log main --format="%an|%s" -- wrap/sent.json', dir).trim();
    assert.match(saved, /^github-actions\[bot\]\|Update$/m, 'sent.json reached the repository');
    assert.match(sh('git --git-dir=origin.git log main --format=%s', dir), /device/, 'and the device’s write is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow keeps sent.json whatever the send step did, and the run still shows red', () => {
  const yml = readFileSync(fileURLToPath(new URL('../night/wrap.yml.txt', import.meta.url)), 'utf8');
  const keep = yml.slice(yml.indexOf('- name: Keep what was sent'));
  assert.match(keep.split('\n')[1], /if: \$\{\{ always\(\) \}\}/);
});

test('sent.json: an empty day that turned final is recorded final, though no clause told it', () => {
  const figs = {
    '2026-11-13': { status: 'final', in: 0, out: 0 },
    '2026-11-15': { status: 'provisional', in: 6000, out: 5000 },
    [TODAY]: { status: 'live', in: 0, out: 900 },
  };
  const sent = { days: {
    '2026-11-13': { in: 0, out: 0, status: 'provisional', at: '2026-11-14T02:33:00.000Z' },
    '2026-11-15': { in: 6000, out: 5000, status: 'live', at: '2026-11-16T02:33:00.000Z' },
  }, last: null };
  const out = recordSent(sent, TODAY, figs, null, { sent: 1, dead: [], problems: [], devices: { dA: 201 } }, Date.parse(NOW));
  assert.deepEqual(out.days['2026-11-13'], { in: 0, out: 0, status: 'final', at: '2026-11-14T02:33:00.000Z' });
  assert.deepEqual(out.days['2026-11-15'], sent.days['2026-11-15'], 'a day still in pencil is left as told');
  assert.equal(out.last.event, 'schedule');
});

test('the night job: a day that turns final every night does not starve a change 4 days back (told once, in the window)', () => {
  // money moves every day, so a day turns final every night; on the night of 11-23, 11-19 changes (a tip met an alert)
  const ymd = (d) => '2026-11-' + String(d).padStart(2, '0');
  const figsOf = (night) => {
    const figs = {};
    for (let d = night - 7; d <= night; d++) {
      const status = d === night ? 'live' : d === night - 1 ? 'provisional' : 'final';
      const out = d === 19 && night >= 23 ? 5300 : d === 19 ? 4900 : 1000 + d * 100;
      figs[ymd(d)] = { status, in: 0, out };
    }
    return figs;
  };
  let sent = { format: 'sent/1', days: {}, last: null };
  const told = [];
  for (let night = 12; night <= 28; night++) {
    const today = ymd(night);
    const figs = figsOf(night);
    const revision = revisionOfJob(today, figs, sent);
    if (revision) told.push({ night: today, ...revision });
    const nowMs = Date.parse(today + 'T02:33:00.000Z') + 86400000;
    sent = readSentFile(JSON.stringify(recordSent(sent, today, figs, revision, { sent: 1, dead: [], problems: [], devices: { dA: 201 }, revised: !!revision, event: 'schedule' }, nowMs)));
  }
  const change = told.filter((t) => t.day === '2026-11-19' && t.net === -5300);
  assert.equal(change.length, 1, 'the change is told once: ' + JSON.stringify(told.filter((t) => t.day === '2026-11-19')));
  assert.equal(change[0].night, '2026-11-23', 'on the night it changed, inside the window');
  assert.equal(change[0].final, true, 'the changed day turned final too: said in the same clause');
  assert.ok(told.filter((t) => t.night >= '2026-11-24').every((t) => t.day !== '2026-11-19'), 'never again');
  assert.equal(sent.days['2026-11-19'] ? sent.days['2026-11-19'].out : 5300, 5300);
});

/** Scheduled 21:33 (all delivered), manual 21:50, the 22:13 run: answers per path, else 201. */
function scriptedPush(answers = {}) {
  const calls = [];
  let all = null;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: Buffer.from(init.body) });
    return { status: all !== null ? all : answers[path] || 201, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { calls, fetchImpl, answerAll: (status) => { all = status; } };
}

test('the night job: scheduled, then a manual run, then the 22:13 run: the backup is skipped and the manual run keeps the clause', async () => {
  const dir = dataFolder();
  try {
    const push = scriptedPush({ '/QC-gone': 410, '/QF-large': 413, '/QG-key': 403 });
    const bodyOf = (from, path, device) => decrypt(push.calls.slice(from).find((c) => c.path === path).body, device).notification;
    const night = await runIn(dir, NOW, push); // 21:33
    assert.equal(night.status, 'sent');
    const wrap = bodyOf(0, '/QA-device-a', devices.dA);
    assert.match(wrap.body, /Round 15 now/, 'the night’s clause');
    const first = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(first.last.scheduled, true, 'tonight’s scheduled wrap went out');
    // 21:50: the owner's test, by hand
    let from = push.calls.length;
    const manual = await runIn(dir, '2026-11-17T02:50:00.000Z', push, { scheduled: false });
    assert.equal(manual.status, 'sent');
    const test1 = bodyOf(from, '/QA-device-a', devices.dA);
    assert.equal(test1.tag, wrap.tag);
    assert.equal(test1.body, wrap.body, 'the manual run keeps the clause the night’s wrap told (nothing is newer)');
    const after = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(after.last.event, 'manual');
    assert.equal(after.last.scheduled, true, 'a manual run does not overwrite it');
    assert.deepEqual(after.days['2026-11-15'], first.days['2026-11-15']);
    // 22:13: a backup, whatever ran after the wrap: every device got 201 or is not transient, so nothing is sent
    from = push.calls.length;
    const backup = await runIn(dir, '2026-11-17T03:13:00.000Z', push);
    assert.equal(backup.status, 'skipped');
    assert.equal(push.calls.length, from, 'no device gets the night’s wrap a third time');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the night job: manual, then the 21:33 run reaching no device, then 22:13: the night’s figure is what 22:13 told', async () => {
  const dir = dataFolder();
  const alert = (amount, merchant) => 'Northlight: A charge of $' + amount + ' at ' + merchant + ' was made on your card ending in 4321.';
  try {
    const push = scriptedPush({ '/QC-gone': 410 });
    const manual = await runIn(dir, '2026-11-17T01:00:00.000Z', push, { scheduled: false }); // 20:00, by hand
    assert.equal(manual.status, 'sent');
    let sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.ok(!sent.days[TODAY], 'a manual run is not the night’s figure while no scheduled run has delivered');
    assert.equal(sent.last.scheduled, false);
    writeFileSync(join(dir, 'inbox', '20261116-210000-000.txt'), alert('40.00', 'RIVERSIDE GRILL')); // 21:00
    push.answerAll(429);
    const night = await runIn(dir, NOW, push); // 21:33: every push service busy
    assert.equal(night.sent, 0);
    sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.ok(!sent.days[TODAY]);
    assert.equal(sent.last.scheduled, false, 'the scheduled wrap did not go out');
    push.answerAll(null);
    const from = push.calls.length;
    const late = await runIn(dir, '2026-11-17T03:13:00.000Z', push); // 22:13: a full run, as the first one reached no device
    assert.equal(late.status, 'sent');
    assert.equal(late.prior, null);
    assert.ok(push.calls.length - from >= 6, 'every device');
    sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    const lateBody = decrypt(push.calls.slice(from).find((c) => c.path === '/QA-device-a').body, devices.dA).notification.body;
    const out = sent.days[TODAY].out;
    assert.ok(lateBody.includes('$' + (out / 100).toFixed(2)), 'days[today] is what 22:13 told: ' + lateBody + ' / ' + out);
    assert.equal(sent.last.scheduled, true);
    // the next night tells no clause about a figure every device already got
    const next = push.calls.length;
    await runIn(dir, '2026-11-18T02:33:00.000Z', push);
    const nextBody = decrypt(push.calls.slice(next).find((c) => c.path === '/QA-device-a').body, devices.dA).notification.body;
    assert.ok(!/Round 16/.test(nextBody), nextBody);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sent.json: the night’s runs record whether the scheduled wrap went out, and whether the backup schedule has run', () => {
  const figs = { [TODAY]: { status: 'live', in: 0, out: 900 } };
  const empty = { days: {}, last: null };
  const one = recordSent(empty, TODAY, figs, null, { sent: 1, dead: [], problems: [], devices: { dA: 201, dD: 429 }, event: 'schedule' }, Date.parse(NOW));
  assert.equal(one.last.scheduled, true);
  assert.equal(one.last.schedules, 1);
  const manual = recordSent(readSentFile(JSON.stringify(one)), TODAY, figs, null,
    { sent: 2, dead: [], problems: [], devices: { dA: 201, dD: 429 }, event: 'manual', night: readSentFile(JSON.stringify(one)).last }, Date.parse(NOW) + 600000);
  assert.equal(manual.last.scheduled, true);
  assert.equal(manual.last.schedules, 1, 'a manual run is not a scheduled one');
  const prior = readSentFile(JSON.stringify(manual)).last;
  const backup = recordSent(readSentFile(JSON.stringify(manual)), TODAY, figs, null, { sent: 1, dead: [], problems: [], devices: { dD: 429 }, prior, event: 'schedule' }, Date.parse(NOW) + 2400000);
  assert.equal(backup.last.schedules, 2, 'the backup schedule has run: no run tries again tonight');
  assert.equal(backup.last.event, 'schedule');
  // a sent.json from before these were kept: a scheduled run that delivered went out
  const older = readSentFile(JSON.stringify({ ...one, last: { ...one.last, scheduled: undefined, schedules: undefined } }));
  assert.equal(older.last.scheduled, true);
  assert.equal(older.last.schedules, 1);
});

test('the night job: a manual run after the wrap keeps the night’s clause over one that was only waiting', async () => {
  const dir = dataFolder();
  try {
    // 11-14 was told in pencil and has turned final since: a clause waiting behind yesterday's change
    const sent0 = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    sent0.days['2026-11-14'] = { in: 0, out: 900, status: 'provisional', at: '2026-11-15T02:33:00.000Z' };
    writeFileSync(join(dir, 'wrap/sent.json'), JSON.stringify(sent0));
    const push = scriptedPush({ '/QC-gone': 410, '/QF-large': 413, '/QG-key': 403 });
    const bodyOf = (from, path, device) => decrypt(push.calls.slice(from).find((c) => c.path === path).body, device).notification;
    await runIn(dir, NOW, push); // 21:33: yesterday's change wins the night
    const wrap = bodyOf(0, '/QA-device-a', devices.dA);
    assert.match(wrap.body, /Round 15 now/);
    const from = push.calls.length;
    await runIn(dir, '2026-11-17T02:50:00.000Z', push, { scheduled: false }); // 21:50, by hand
    const test1 = bodyOf(from, '/QA-device-a', devices.dA);
    assert.equal(test1.body, wrap.body, 'the night’s clause stays on the lock screen; the waiting one comes on a later night');
    const sent = JSON.parse(readFileSync(join(dir, 'wrap/sent.json'), 'utf8'));
    assert.equal(sent.days['2026-11-14'].status, 'provisional', 'the waiting clause is not recorded as told');
    assert.equal(sent.last.revision.day, '2026-11-15');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
