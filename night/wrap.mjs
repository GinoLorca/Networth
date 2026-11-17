/**
 * The night job of the nightly wrap: `node night/wrap.mjs <dataDir> [--dry]`, run by GitHub Actions in the private
 * data repository (night/wrap.yml.txt), with the public repository checked out beside it for this code.
 *
 *  1. A scheduled run once tonight's scheduled wrap went out (a scheduled run of tonight delivered to a device, as
 *     sent.json's `last.scheduled` says, whatever ran after it) is the backup: it goes ahead only for the devices whose
 *     push service failed for a while last time (no answer, 429 or 5xx), and sends to them alone; with none, it exits.
 *     A device that got 201 is never sent the night's wrap twice by a scheduled run. A manual run (the owner's test)
 *     never stands for the night: the scheduled wrap after it goes to every device as a notification of its own (a test
 *     is tagged nightly-test-<day>, the wrap nightly-<day>: a notification that replaces one with its tag arrives
 *     silently, so the wrap must never replace a test); its
 *     figures become the night's only once the scheduled wrap went out, and it keeps the clause the night told unless
 *     there is newer news.
 *  2. It reads push/*.json, wrap/*.json, inbox/, income/*.json, the answers of networth-shared.json and sent.json.
 *     Every file was written by a device or another app: each is read strictly, and one that is not right is skipped.
 *     Only regular files are read, and sent.json is never written through a link.
 *  3. For each of today and the 7 days before, it takes one device file (the latest bank reading, then the latest
 *     writing) and adds the card alerts and marked payments no picked figure has dealt with (wrap.nightFigures).
 *  4. It decides the night's one revision clause against sent.json, and builds each device's message in its own words
 *     and with amounts shown or hidden as that device chose (Declarative Web Push, tag wrap-YYYY-MM-DD).
 *  5. It encrypts each message for its subscription (RFC 8291) and signs a VAPID token (RFC 8292, `sub` the app's
 *     address from the device's file), and POSTs it with TTL 43200, Urgency high and Topic wrap, only to Apple's push
 *     service (or FCM). 201 is sent; 404 and 410 mark the device dead; anything else (403, 413, 429 …) is a problem.
 *     Each device is tried on its own: one that fails (a key that is not a point, an address it cannot sign for) is a
 *     problem, and the others are still sent.
 *  6. It writes wrap/sent.json, whatever happened to the devices, the night key included (none set, or not the
 *     published one: the devices say so): the days it told (14 kept; a revised day only when a lock screen that shows
 *     amounts got the clause, in the first run or the backup) and what the night's runs did, with each device's status,
 *     what started the run, whether the scheduled wrap went out and how many scheduled runs ran. It prints counts, no
 *     figure.
 *
 * Environment: VAPID_PRIVATE_KEY (the 32-byte private scalar, base64url; not needed with --dry); TZ, the owner's zone
 * (the game day reads local time); GITHUB_EVENT_NAME, 'schedule' for a scheduled run (or --scheduled). For tests:
 * WRAP_PUSH_VIA, an http origin every message is sent to instead of its push service (a local stub), and WRAP_NOW,
 * an ISO time to use as now.
 */

import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nightFigures, pickDay, pushPayload, readWrapFile, revisionOf, wrapText } from '../js/model/wrap.js';
import { ALERT_MAX_BYTES } from '../js/model/alerts.js';
import { readIncomeFile, sourceIdOf } from '../js/model/income.js';
import { addDays, gameDay, gameDayStartMs, isYmd } from '../js/model/dates.js';
import { wordsMode } from '../js/model/words.js';
import { encrypt, send, vapidAuthorization, vapidJwt, vapidKeys } from './push.mjs';

export const SENT_FORMAT = 'sent/1';
export const PUSH_FORMAT = 'push/1';
export const VAPID_FORMAT = 'vapid/1';
/** sent.json keeps this many days. */
export const SENT_DAYS = 14;
/** The push services a message may go to: Apple's, and Google's should the Mac app be a Chrome install. */
const PUSH_HOSTS = [/^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com$/, /^fcm\.googleapis\.com$/];
const DEVICE = /^[A-Za-z0-9_-]{1,40}$/;
const INBOX_NAME = /^\d{8}-\d{6}-\d{3}\.txt$/;
const FILE_MAX_BYTES = 1000000;
const SENT_STATUSES = new Set(['live', 'awaiting', 'provisional', 'final']);

/* --------------------------------------------------------------------------------------------- the files */

/**
 * A device's push file (untrusted): `{ format: 'push/1', device, appUrl, subscription: { endpoint, keys: { p256dh,
 * auth } }, words, lock, updatedAt }`. The device must be the file's own name. `lock` other than 'show' hides amounts.
 * @returns {{ ok: true, file: { device, appUrl, endpoint, p256dh, auth, words, lock } } | { ok: false, problem: string }}
 */
export function readPushFile(text, stem) {
  const no = (problem) => ({ ok: false, problem });
  let raw;
  try { raw = JSON.parse(text); } catch { return no('not JSON'); }
  if (!isObject(raw) || raw.format !== PUSH_FORMAT) return no('not a push file');
  if (typeof raw.device !== 'string' || !DEVICE.test(raw.device) || raw.device !== stem) return no('device');
  if (!isHttps(raw.appUrl, 400)) return no('appUrl');
  const sub = raw.subscription;
  if (!isObject(sub) || !isHttps(sub.endpoint, 2000) || !isObject(sub.keys)) return no('subscription');
  const { p256dh, auth } = sub.keys;
  if (typeof p256dh !== 'string' || !/^B[A-Za-z0-9_-]{86}$/.test(p256dh) || !isP256Point(p256dh)) return no('p256dh');
  if (typeof auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return no('auth');
  return {
    ok: true,
    file: { device: raw.device, appUrl: raw.appUrl, endpoint: sub.endpoint, p256dh, auth, words: wordsMode(raw.words), lock: raw.lock === 'show' ? 'show' : 'hide' },
  };
}

/** Whether 65 uncompressed octets (base64url) are a point on P-256: one that is not cannot be encrypted for. */
function isP256Point(text) {
  const raw = Buffer.from(text, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) return false;
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

/** sent.json, read leniently: what is not right is left out (missing, it is empty). */
export function readSentFile(text) {
  const sent = { format: SENT_FORMAT, days: {}, last: null };
  let raw;
  try { raw = JSON.parse(text); } catch { return sent; }
  if (!isObject(raw) || raw.format !== SENT_FORMAT || !isObject(raw.days)) return sent;
  for (const day of Object.keys(raw.days).sort()) {
    const v = raw.days[day];
    if (isYmd(day) && isObject(v) && Number.isInteger(v.in) && Number.isInteger(v.out) && SENT_STATUSES.has(v.status) && typeof v.at === 'string') {
      sent.days[day] = { in: v.in, out: v.out, status: v.status, at: v.at };
    }
  }
  if (isObject(raw.last)) {
    // the night's earlier run, as a later run merges with it: only well-formed entries are kept
    const last = raw.last;
    const isStatus = (status) => Number.isInteger(status) || (typeof status === 'string' && status.length <= 40);
    const devices = {};
    if (isObject(last.devices)) {
      for (const [device, status] of Object.entries(last.devices)) if (DEVICE.test(device) && isStatus(status)) devices[device] = status;
    }
    sent.last = {
      at: typeof last.at === 'string' ? last.at : null,
      day: isYmd(last.day) ? last.day : null,
      sent: Number.isInteger(last.sent) && last.sent >= 0 ? last.sent : 0,
      dead: Array.isArray(last.dead) ? [...new Set(last.dead.filter((d) => typeof d === 'string' && DEVICE.test(d)))] : [],
      problems: Array.isArray(last.problems)
        ? last.problems.filter((p) => isObject(p) && (p.device === null || (typeof p.device === 'string' && DEVICE.test(p.device))) && isStatus(p.status))
          .map((p) => ({ device: p.device, status: p.status }))
        : [],
      devices,
      revision: readRevision(last.revision),
      // what started the run: a sent.json from before this was kept is taken as a scheduled run's
      event: last.event === 'manual' ? 'manual' : 'schedule',
    };
    // whether a scheduled run of that night delivered to a device (the next scheduled run is then the backup), and how
    // many scheduled runs ran that night (after 2, none tries again); an older record is read from its last run
    const one = sent.last.event === 'schedule';
    sent.last.scheduled = typeof last.scheduled === 'boolean' ? last.scheduled : one && !!sent.last.day && !!sent.days[sent.last.day];
    sent.last.schedules = Number.isInteger(last.schedules) && last.schedules >= 0 && last.schedules <= 9 ? last.schedules : one ? 1 : 0;
  }
  return sent;
}

/**
 * The night's revision clause as sent.json keeps it, or null when it is not one: `{ day, net, final, told, in, out,
 * status }`, `told` whether a lock screen that shows amounts has had it tonight (one kept without it is taken as told),
 * and the day's figures it was built from (absent from an older record).
 */
function readRevision(raw) {
  if (!isObject(raw) || !isYmd(raw.day) || !Number.isInteger(raw.net) || Math.abs(raw.net) > 1e14 || typeof raw.final !== 'boolean') return null;
  const out = { day: raw.day, net: raw.net, final: raw.final, told: raw.told !== false };
  if (isCents(raw.in) && isCents(raw.out) && SENT_STATUSES.has(raw.status)) Object.assign(out, { in: raw.in, out: raw.out, status: raw.status });
  return out;
}

function isCents(x) {
  return Number.isInteger(x) && Math.abs(x) <= 1e14;
}

/** A push service that failed for a while: no answer (0), 429, or a 5xx. The backup run tries these again. */
export function transient(status) {
  return status === 0 || status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function delivered(status) {
  return status === 200 || status === 201 || status === 202;
}

/**
 * sent.json after a run: today's figure only when at least one device was sent the message, so that the backup run
 * tries again otherwise (a manual run's only once tonight's scheduled wrap went out: the owner's test is not the
 * night's figure); the revised day's only when a device that shows amounts got a body carrying the clause
 * (`outcome.revised`), so that a later night tells it otherwise; 14 days kept. `last` is the night so far, with the
 * night's revision clause (`last.revision`, which a backup run sends the devices it tries again: whether it was told,
 * and the figures it was built from) and what started the run (`last.event`, 'schedule' or 'manual'): on a run that
 * tried some devices again (`outcome.prior`, the night's earlier `last`), their new statuses over the earlier ones, and
 * today is added only when absent: it stays as the first run told it, so that a change made between the two runs is
 * told on the next night to the devices served first. The revised day is the same, but for a clause the first run told
 * no lock screen that shows amounts: once the backup run tells one, it is recorded from the figures it was built from.
 * An empty day that turned final is recorded final, though no clause tells it (it is not news). `last.scheduled` says
 * whether a scheduled run of tonight delivered to a device, and `last.schedules` how many scheduled runs ran tonight:
 * a manual run keeps both (`outcome.night`, the night's `last` before this run), so that it never disturbs the
 * scheduled wrap.
 * @param {{ sent: number, dead: string[], problems: object[], devices: Object<string, number|string>, revised?: boolean,
 *   prior?: object|null, night?: object|null, event?: 'schedule'|'manual' }} outcome
 */
export function recordSent(sent, today, figs, revision, outcome, nowMs) {
  const at = new Date(nowMs).toISOString();
  const from = addDays(today, -(SENT_DAYS - 1));
  const days = {};
  for (const [day, v] of Object.entries(sent.days)) if (day >= from && day <= today) days[day] = v;
  const prior = isObject(outcome.prior) ? outcome.prior : null;
  const kept = prior ? readRevision(prior.revision) : null;
  const manual = outcome.event === 'manual';
  // the night so far, before this run (a backup run's prior is the same)
  const night = prior || (isObject(outcome.night) && outcome.night.day === today ? outcome.night : null);
  const wentOut = !!night && night.scheduled === true;
  if (outcome.sent > 0) {
    const note = (day) => {
      if (prior && days[day]) return; // a backup run never rewrites what the night's first run told
      days[day] = { in: figs[day].in, out: figs[day].out, status: figs[day].status, at };
    };
    // the owner's test is the night's figure only once the scheduled wrap went out (its message then replaced it)
    if (!manual || wentOut) note(today);
    // (a clause the night already told, carried by a later run, was recorded when it was first told)
    if (!prior && outcome.revised && revision && revision.told !== true && figs[revision.day]) note(revision.day);
    // the backup run told a clause the first run told no lock screen that shows amounts: as it was built that night
    if (kept && !kept.told && outcome.revised && Number.isInteger(kept.in)) days[kept.day] = { in: kept.in, out: kept.out, status: kept.status, at };
    if (!prior) {
      for (const day of Object.keys(days)) {
        const fig = figs[day];
        const was = days[day];
        if (day < today && isObject(fig) && fig.status === 'final' && was.status !== 'final' && fig.in === 0 && fig.out === 0 && was.in - was.out === 0) {
          days[day] = { ...was, status: 'final' };
        }
      }
    }
  }
  const ordered = {};
  for (const day of Object.keys(days).sort()) ordered[day] = days[day];
  const tried = new Set(Object.keys(outcome.devices || {}));
  const devices = { ...(prior && isObject(prior.devices) ? prior.devices : {}), ...(outcome.devices || {}) };
  const dead = [...new Set([...(prior && Array.isArray(prior.dead) ? prior.dead.filter((d) => !tried.has(d)) : []), ...outcome.dead])].sort();
  const problems = [...(prior && Array.isArray(prior.problems) ? prior.problems.filter((p) => !(isObject(p) && tried.has(p.device))) : []), ...outcome.problems]
    .sort((a, b) => (String(a.device ?? '') < String(b.device ?? '') ? -1 : String(a.device ?? '') > String(b.device ?? '') ? 1 : 0));
  const count = prior ? Object.values(devices).filter(delivered).length : outcome.sent;
  let told = null;
  if (kept) told = { ...kept, told: kept.told || !!outcome.revised };
  else if (!prior && revision) {
    const fig = figs[revision.day];
    // a clause the night already told (carried by a later run) stays told
    const again = revision.told === true;
    told = readRevision({ day: revision.day, net: revision.net, final: revision.final, told: again || !!outcome.revised, ...(isObject(fig) ? { in: fig.in, out: fig.out, status: fig.status } : {}) });
  }
  const event = manual ? 'manual' : 'schedule';
  const scheduled = wentOut || (!manual && outcome.sent > 0);
  const schedules = (night && Number.isInteger(night.schedules) ? night.schedules : 0) + (manual ? 0 : 1);
  return { format: SENT_FORMAT, days: ordered, last: { at, day: today, sent: count, dead, problems, devices, revision: told, event, scheduled, schedules } };
}

/** Whether a subscription's endpoint is a push service a message may go to. */
export function allowedEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

function lstatOf(path) {
  try { return lstatSync(path); } catch { return null; }
}

/** A folder of the data checkout, itself and not a link to one elsewhere on the runner. */
function isRealDir(path) {
  const stat = lstatOf(path);
  return !!stat && stat.isDirectory();
}

/** A regular file's text (not a link, a folder or anything else; not too large), or null as if it were missing. */
function readRegular(path) {
  const stat = lstatOf(path);
  if (!stat || !stat.isFile() || stat.size > FILE_MAX_BYTES) return null;
  return readText(path);
}

/** Write sent.json as a regular file: a link, a folder or anything else in its place is removed first, never followed. */
function writeSent(dataDir, value) {
  const dir = join(dataDir, 'wrap');
  // a link, a file or anything else that is not a folder is removed itself (never what a link points to)
  const folder = lstatOf(dir);
  if (folder && !folder.isDirectory()) rmSync(dir, { recursive: true, force: true });
  if (!folder || !folder.isDirectory()) mkdirSync(dir);
  const path = join(dir, 'sent.json');
  const stat = lstatOf(path);
  if (stat && !stat.isFile()) rmSync(path, { recursive: true, force: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o644);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + '\n');
  } finally {
    closeSync(fd);
  }
}

function readJsonDir(dir, skip) {
  const out = [];
  if (!isRealDir(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || skip.includes(name)) continue;
    const path = join(dir, name);
    const stat = lstatSync(path); // a plain file only: a link could point anywhere on the runner
    if (!stat.isFile() || stat.size > FILE_MAX_BYTES) continue;
    out.push({ stem: name.slice(0, -5), name, text: readFileSync(path, 'utf8') });
  }
  return out;
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/* ------------------------------------------------------------------------------------------------- the run */

/**
 * One night: build every device's message and send it (or print it, with `dry`). A scheduled run that finds today
 * already sent tries again only the devices whose last status was 0, 429 or 5xx (`prior`: the night's earlier run).
 * @returns {Promise<{ status: 'sent'|'skipped'|'dry', today: string, sent: number, dead: string[], problems: object[],
 *   messages: object[], devices: Object<string, number|string>, revised: boolean, prior: object|null }>}
 */
export async function runWrap(dataDir, { dry = false, scheduled = false, nowMs = Date.now(), secret = '', via = null, fetchImpl = fetch } = {}) {
  const files = [];
  for (const one of readJsonDir(join(dataDir, 'wrap'), ['sent.json'])) {
    const read = readWrapFile(one.text);
    if (read.ok && read.file.device === one.stem) files.push(read.file);
  }
  const freshest = files.slice().sort((a, b) => Date.parse(b.writtenAt) - Date.parse(a.writtenAt))[0];
  const rollover = freshest ? freshest.rollover : 4;
  const today = gameDay(nowMs, rollover);
  const wrapDir = join(dataDir, 'wrap');
  const sent = readSentFile(isRealDir(wrapDir) ? readRegular(join(wrapDir, 'sent.json')) : null);
  const result = { status: 'sent', today, sent: 0, dead: [], problems: [], messages: [], devices: {}, revised: false, prior: null };
  // a scheduled run after tonight's scheduled wrap went out, whatever ran after it: only the devices whose push service
  // failed for a while (a manual run, the owner's test, does not stand for the night: the scheduled wrap goes to every
  // device after it)
  let only = null;
  const tonight = sent.last && sent.last.day === today ? sent.last : null;
  if (scheduled && !dry && tonight && tonight.scheduled) {
    const prior = tonight;
    only = new Set(Object.entries(prior ? prior.devices : {}).filter(([, status]) => transient(status)).map(([device]) => device));
    if (!only.size) {
      result.status = 'skipped';
      return result;
    }
    result.prior = prior;
  }

  // what came after the device files: the inbox, the income files and the shared answers
  const inbox = [];
  const inboxDir = join(dataDir, 'inbox');
  if (isRealDir(inboxDir)) {
    for (const name of readdirSync(inboxDir).sort()) {
      const stat = INBOX_NAME.test(name) ? lstatSync(join(inboxDir, name)) : null;
      if (!stat || !stat.isFile()) continue;
      inbox.push({ name, size: stat.size, text: stat.size <= ALERT_MAX_BYTES ? readText(join(inboxDir, name)) : null });
    }
  }
  const sources = {};
  for (const one of readJsonDir(join(dataDir, 'income'), [])) {
    const id = sourceIdOf(one.name);
    const read = id ? readIncomeFile(one.text, nowMs) : null;
    if (read && read.ok) sources[id] = { what: read.what, from: read.from, payers: read.payers, items: read.items };
  }
  let shared = null;
  try {
    const raw = JSON.parse(readRegular(join(dataDir, 'networth-shared.json')));
    if (isObject(raw) && isObject(raw.income)) shared = raw.income;
  } catch { /* no answers: every payment counts as not yet answered */ }
  const late = { today, rollover, inbox, income: { sources, shared } };

  // one device file per day, and what came after it that no picked figure has dealt with
  const { figs } = nightFigures(files, late);
  const todayFile = pickDay(files, today);
  const readAt = todayFile && todayFile.readAt ? Date.parse(todayFile.readAt) : NaN;
  const night = { day: today, in: figs[today].in, out: figs[today].out, noBank: !(readAt >= gameDayStartMs(today, rollover)) };
  // a backup run sends the devices it tries again the clause the night's first run told (its figures are now told); any
  // other run of the night carries the clause the night already told (its message replaces the earlier one on the lock
  // screen: the same tag), unless there is newer news: that day's figure or status is no longer what it told, or the
  // day before changed since. A clause that was only waiting comes on a later night.
  let revision = only ? (result.prior.revision || null) : revisionOf(today, figs, sent);
  const told = !only && tonight && tonight.revision && tonight.revision.told ? tonight.revision : null;
  if (told) {
    const fig = figs[told.day];
    const same = isObject(fig) && fig.in - fig.out === told.net && (fig.status === 'final') === told.final;
    if (same && !(revision && revision.day === addDays(today, -1))) revision = told;
  }

  const devices = [];
  for (const one of readJsonDir(join(dataDir, 'push'), ['vapid.json'])) {
    if (only && !only.has(one.stem)) continue;
    const read = readPushFile(one.text, one.stem);
    if (read.ok) devices.push(read.file);
    else {
      const device = DEVICE.test(one.stem) ? one.stem : null;
      result.problems.push({ device, status: 'file' });
      if (device) result.devices[device] = 'file';
    }
  }

  if (dry) {
    result.status = 'dry';
    for (const device of devices) result.messages.push({ device: device.device, message: pushPayload(night, revision, device, { test: !scheduled }) });
    return result;
  }

  try {
    let keys = null;
    if (secret) {
      try { keys = vapidKeys(secret); } catch { /* a secret that is not a key: recorded below */ }
    }
    let published = null;
    try {
      const raw = isRealDir(join(dataDir, 'push')) ? JSON.parse(readRegular(join(dataDir, 'push', 'vapid.json'))) : null;
      if (isObject(raw) && raw.format === VAPID_FORMAT && typeof raw.publicKey === 'string') published = raw.publicKey;
    } catch { /* no published key: the push service says whether it matches */ }
    if (!secret) {
      // no secret named VAPID_PRIVATE_KEY (none added, or added under another name): the devices say so
      result.problems.push({ device: null, status: 'nokey' });
    } else if (!keys || (published !== null && published !== keys.publicKey)) {
      // every subscription was made with the published key: the push service would refuse them all
      result.problems.push({ device: null, status: 'key' });
    } else {
      const tokens = new Map();
      for (const device of devices) {
        const { status, told } = await deliver(device, { night, revision, nowMs, keys, tokens, via, fetchImpl, test: !scheduled });
        result.devices[device.device] = status;
        if (delivered(status)) {
          result.sent += 1;
          if (told) result.revised = true;
        } else if (status === 404 || status === 410) result.dead.push(device.device);
        else result.problems.push({ device: device.device, status });
      }
    }
  } finally {
    // whatever happened to the devices, the night is recorded: a device that got 201 is not sent it again
    writeSent(dataDir, recordSent(sent, today, figs, revision, { ...result, night: tonight, event: scheduled ? 'schedule' : 'manual' }, nowMs));
  }
  return result;
}

/**
 * One device's message, built, encrypted, signed and sent on its own: whatever fails here is that device's problem
 * ('subscription'), never the run's. `told`: the body carried the revision clause to a lock screen that shows amounts.
 * @returns {Promise<{ status: number|string, told: boolean }>}
 */
async function deliver(device, { night, revision, nowMs, keys, tokens, via, fetchImpl, test = false }) {
  if (!allowedEndpoint(device.endpoint)) return { status: 'endpoint', told: false };
  let request;
  let told = false;
  try {
    const message = pushPayload(night, revision, device, { test });
    told = wrapText(night, revision, device.words, device.lock).revised;
    const { body } = encrypt(Buffer.from(JSON.stringify(message)), { p256dh: device.p256dh, auth: device.auth });
    const audience = new URL(device.endpoint).origin;
    const key = audience + ' ' + device.appUrl;
    if (!tokens.has(key)) tokens.set(key, vapidJwt({ audience, subject: device.appUrl, nowMs, privateKey: keys.privateKey }));
    request = { endpoint: device.endpoint, body, authorization: vapidAuthorization(tokens.get(key), keys.publicKey), via, fetchImpl };
  } catch {
    return { status: 'subscription', told: false };
  }
  try {
    const { status } = await send(request);
    return { status, told };
  } catch {
    return { status: 0, told: false }; // no answer: the backup run tries it again
  }
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isHttps(text, max) {
  if (typeof text !== 'string' || text.length > max) return false;
  try { return new URL(text).protocol === 'https:'; } catch { return false; }
}

/* ------------------------------------------------------------------------------------------- command line */

/** True when a night key was made: push/ is a real folder holding a regular push/vapid.json. */
function isSetUp(dataDir) {
  try { return isRealDir(join(dataDir, 'push')) && lstatSync(join(dataDir, 'push', 'vapid.json')).isFile(); } catch { return false; }
}

async function main(argv, env) {
  const args = argv.slice(2);
  const dataDir = args.find((a) => !a.startsWith('--'));
  const dry = args.includes('--dry');
  const scheduled = args.includes('--scheduled') || env.GITHUB_EVENT_NAME === 'schedule';
  if (!dataDir || !existsSync(dataDir)) {
    console.error('usage: node night/wrap.mjs <dataDir> [--dry] [--scheduled]');
    return 2;
  }
  const nowMs = env.WRAP_NOW ? Date.parse(env.WRAP_NOW) : Date.now();
  if (!Number.isFinite(nowMs)) {
    console.error('wrap: WRAP_NOW is not a time');
    return 2;
  }
  // not set up yet: no night key was ever made (push/vapid.json is absent), so there is nothing to send and nothing to
  // report. The run stays green and quiet until the owner makes the key, instead of failing every night before setup.
  if (!dry && !isSetUp(dataDir)) {
    console.log('wrap: not set up yet (no push/vapid.json); nothing to do');
    return 0;
  }
  const secret = env.VAPID_PRIVATE_KEY || '';
  let result;
  try {
    result = await runWrap(dataDir, { dry, scheduled, nowMs, secret, via: env.WRAP_PUSH_VIA || null });
  } catch (error) {
    console.error('wrap: ' + (error && error.message ? error.message : 'failed'));
    return 1;
  }
  if (result.status === 'skipped') console.log('wrap: already sent for ' + result.today + '; nothing to do');
  else if (result.status === 'dry') for (const m of result.messages) console.log(JSON.stringify(m));
  else console.log('wrap: ' + result.today + (result.prior ? ' (tried again)' : '') + ': sent ' + result.sent + ', turned off ' + result.dead.length + ', problems ' + result.problems.length);
  // no night key, one that does not parse, or one that is not the one the devices subscribed with, can send nothing on
  // any night: the run fails, so that GitHub shows it red and tells the owner (sent.json, written, says so to the devices)
  if (result.problems.some((p) => p.device === null && p.status === 'nokey')) {
    console.error('wrap: VAPID_PRIVATE_KEY is not set; nothing was sent');
    return 1;
  }
  if (result.problems.some((p) => p.device === null && p.status === 'key')) {
    console.error('wrap: VAPID_PRIVATE_KEY is not a key, or not the one in push/vapid.json; nothing was sent');
    return 1;
  }
  return 0;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathOf(process.argv[1]) === realpathOf(self)) {
  main(process.argv, process.env).then((code) => { process.exitCode = code; });
}

function realpathOf(path) {
  try { return realpathSync(path); } catch { return path; }
}
