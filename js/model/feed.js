/**
 * The bank feed: a provider-neutral shape, and the SimpleFIN Bridge adapter that produces it.
 * See ARCHITECTURE.md section 3.1.
 *
 * This is the only module in js/model that touches the network, and only in `claimAccess`
 * and `fetchSimplefin`. Both take the fetch implementation as a parameter so tests never
 * go online. The access credential is passed in by the caller and is never logged, never
 * put in an error message and never returned in any result.
 *
 * SimpleFIN protocol notes (verified against the public Bridge, November 2026):
 *  - A setup token is base64 of a claim URL. `POST claimUrl` (no body, no custom headers)
 *    returns the access URL as plain text: https://USER:PASS@host/simplefin . A claim URL
 *    works once (HTTP 403 afterwards).
 *  - `GET {base}/accounts?version=2&pending=1&start-date=SEC&end-date=SEC` (and `account=ID`, repeatable:
 *    only those accounts are returned) with
 *    `Authorization: Basic base64(USER:PASS)`. The Bridge answers CORS preflights for the
 *    authorization header, so the browser can call it directly. An account id the Bridge does not know
 *    answers 200 with no accounts and no error. A range longer than 45 days is answered in full with the notice
 *    "Requested date range exceeds recommended range of 45 days. In the future, this may be capped." in errlist
 *    (45 days and one second is enough; exactly 45 days is not), so no request here spans more than 44 days.
 *    Windows far back are answered (one that ended 256 days before the day it was asked returned rows).
 *  - Response: { errlist: [...], accounts: [...], connections: [...] }.
 *    account: { id, name, conn_id, currency, balance: "123.45", "available-balance"?: "…",
 *               "balance-date": epochSeconds, transactions?: [...] }
 *    (older responses carry `org: { name, domain }` on the account instead of conn_id/connections,
 *     and `errors: [strings]` instead of errlist — accept both.)
 *    transaction: { id, posted: epochSeconds (0 when pending), amount: "-4.75" (negative = money out),
 *                   description, payee?, memo?, transacted_at?: epochSeconds, pending?: boolean, mcc?: "5814" }
 *    connections: [{ conn_id, name, org_id, org_name, org_url }]
 *  - HTTP 403: the access URL was revoked -> relink. HTTP 402: the subscription lapsed.
 *  - Expect at most 24 requests a day per access URL.
 *  - Transaction ids are only unique within their account (the demo account reuses them across accounts).
 */

import { toCents } from './money.js';
import { addDays, isYmd, startOfDayMs, ymd } from './dates.js';

/**
 * @typedef {Object} FeedTx
 * @property {string} extId            provider transaction id (some banks re-issue these; '' when the provider sent none)
 * @property {number} amount           SIGNED cents: negative = money leaving the account, positive = money in
 * @property {number|null} posted      epoch SECONDS it posted; null while pending
 * @property {number|null} at          epoch SECONDS it happened, when the provider gives it
 * @property {boolean} pending
 * @property {string} description
 * @property {string} payee
 * @property {string} memo
 * @property {string|null} mcc
 */

/**
 * @typedef {Object} FeedAccount
 * @property {string} extId            provider account id
 * @property {string} connId           provider connection id ('' when unknown)
 * @property {string} institution      bank / connection name
 * @property {string} name
 * @property {string} currency
 * @property {number} balance          SIGNED cents exactly as reported (debts are normally negative)
 * @property {number|null} available   signed cents, when reported
 * @property {number} asOf             timestamp (ms) the balance was true
 * @property {FeedTx[]} txs
 */

/**
 * @typedef {Object} Feed
 * @property {'simplefin'|'demo'} src
 * @property {number} fetchedAt        timestamp (ms)
 * @property {number} fromMs           start of the window requested (ms)
 * @property {number} toMs             end of the window requested (ms)
 * @property {FeedAccount[]} accounts
 * @property {string[]} [only]         provider account ids the request was limited to (absent when it was not limited); such a feed says nothing about any other account
 * @property {number} [reading]        timestamp (ms) the reading this feed belongs to began: feeds of one reading share it
 * @property {{ code: string, message: string, connId: string, accountId: string }[]} errors   provider-reported problems
 */

/** @typedef {{ base: string, auth: string }} Access  base = URL without credentials; auth = the Authorization header value */

/** Longest window a single request may cover, in days: a day inside the 45 the provider recommends. */
export const FEED_WINDOW_DAYS = 44;
/** How far back anything is ever asked, in days: four windows. */
export const FEED_REACH_DAYS = 4 * FEED_WINDOW_DAYS;

/** Request budget (see ARCHITECTURE 3.1). */
export const QUOTA = { perDay: 20, autoEveryMs: 3 * 3600 * 1000, manualEveryMs: 15 * 60 * 1000 };

/**
 * History for an account that needs it (see ARCHITECTURE 3.1): at most `perReading` accounts are asked in one
 * reading, each no sooner than `everyMs` after its last attempt, and only while `spare` of the day's requests are
 * unused; an account whose record is still without a row after `maxTries` counted attempts gives up.
 */
export const HISTORY = { perReading: 2, everyMs: 12 * 3600 * 1000, spare: 8, maxTries: 6, steps: 4 };

/** How long one request may take before it is abandoned. */
export const FEED_TIMEOUT_MS = 30 * 1000;

const DAY_MS = 24 * 3600 * 1000;
/** The longest span one request asks for. */
const WINDOW_MS = FEED_WINDOW_DAYS * DAY_MS;
const WINDOW_SECONDS = FEED_WINDOW_DAYS * 24 * 3600;
const REACH_MS = FEED_REACH_DAYS * DAY_MS;
/** Provider notices that say nothing about the owner's bank link and are not shown as problems. */
const BENIGN_NOTICE = /date range\b.*\b(capped|limit)/i;
/** A later sync re-reads this many days before the newest posted row (banks back-date and re-issue). */
const OVERLAP_DAYS = 7;
/** ...and starts this many days before the oldest row still pending (at most one window back), so its fate is seen. */
const PENDING_MARGIN_DAYS = 2;
const PROVIDER_HOST = 'simplefin.org';
const MAX_TEXT = 500;
const MAX_MESSAGE = 300;
const MAX_ID = 200;
/** An epoch value above this cannot be seconds (it would be the year 5138): it is milliseconds. */
const SECONDS_CEILING = 1e11;

const MESSAGES = {
  tokenEmpty: 'Paste the setup token from SimpleFIN Bridge first.',
  tokenIsAddress: 'That is a web address, not a setup token. Copy the setup token from SimpleFIN Bridge and paste it here.',
  tokenUnreadable: 'That does not look like a SimpleFIN setup token. Copy the whole token and paste it again.',
  tokenForeign: 'That token does not come from SimpleFIN Bridge, so it was not used.',
  tokenSpent: 'This setup token was already used or has expired. Create a new one in SimpleFIN Bridge and paste it here.',
  accessUnreadable: 'The bank link could not be read. Create a new setup token in SimpleFIN Bridge and link again.',
  claimTimeout: 'SimpleFIN Bridge did not answer within 30 seconds, so the bank was not linked. The token may still be unused: try again, and create a new one if it is refused.',
  claimUnreachable: 'SimpleFIN Bridge could not be reached, so the bank was not linked. Check your connection and try again.',
  claimInterrupted: 'The link was interrupted before it finished. Create a new setup token in SimpleFIN Bridge and try again.',
  claimUnexpected: 'SimpleFIN Bridge sent an answer that could not be read. Create a new setup token and try again.',
  relink: 'The bank link was revoked or has expired. Link your bank again with a new setup token.',
  payment: 'SimpleFIN Bridge reports that its subscription has lapsed. Renew it at SimpleFIN Bridge, then refresh.',
  rate: 'SimpleFIN Bridge is limiting requests for now. Nothing was lost; Networth will try again later.',
  unreachable: 'The bank feed could not be reached. Check your connection; nothing was lost.',
  timeout: 'The bank feed did not answer within 30 seconds. Nothing was lost; try again later.',
  unreadable: 'The bank feed sent an answer that could not be read. Nothing was lost; try again later.',
};

/** An error with a machine-readable code: 'token' | 'relink' | 'payment' | 'network' | 'rate' | 'server'. */
export class FeedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FeedError';
    this.code = code;
  }
}

/* ------------------------------------------------------------ URLs and base64 */

function parseUrl(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function isProviderUrl(url) {
  return url.protocol === 'https:' && (url.hostname === PROVIDER_HOST || url.hostname.endsWith('.' + PROVIDER_HOST));
}

/** Decode standard or URL-safe base64, with or without padding. Returns null when it is not base64. */
function decodeBase64(text) {
  const body = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!body || !/^[A-Za-z0-9+/]+$/.test(body)) return null;
  try {
    return atob(body + '='.repeat((4 - (body.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** base64 of the UTF-8 bytes of `text` (btoa alone rejects anything outside Latin-1). */
function encodeBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeUrlPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function isAccess(value) {
  if (typeof value.base !== 'string' || typeof value.auth !== 'string') return false;
  if (!/^Basic [A-Za-z0-9+/]+=*$/.test(value.auth)) return false;
  const url = parseUrl(value.base);
  return !!url && isProviderUrl(url) && !url.username && !url.password;
}

/**
 * Decode a setup token into its claim URL.
 * Accepts surrounding whitespace and line breaks. Rejects anything that is not base64 of an
 * `https://` URL on a `simplefin.org` host (or a subdomain of it).
 * @param {string} token
 * @returns {{ claimUrl: string }}
 * @throws {FeedError} code 'token' with a message the owner can act on
 */
export function parseSetupToken(token) {
  const compact = typeof token === 'string' ? token.replace(/\s+/g, '') : '';
  if (!compact) throw new FeedError('token', MESSAGES.tokenEmpty);
  if (/^https?:/i.test(compact)) throw new FeedError('token', MESSAGES.tokenIsAddress);
  const decoded = decodeBase64(compact);
  const url = decoded == null ? null : parseUrl(decoded.trim());
  if (!url) throw new FeedError('token', MESSAGES.tokenUnreadable);
  if (!isProviderUrl(url) || url.username || url.password) throw new FeedError('token', MESSAGES.tokenForeign);
  return { claimUrl: url.href };
}

/**
 * Split an access URL (https://USER:PASS@host/path) into a credential-free base and a Basic auth header.
 * Also accepts an already-split Access object and returns it unchanged.
 * @param {string|Access} accessUrl
 * @returns {Access}
 * @throws {FeedError} code 'token' when it is not an https URL on a simplefin.org host with credentials
 */
export function parseAccessUrl(accessUrl) {
  if (accessUrl && typeof accessUrl === 'object') {
    if (isAccess(accessUrl)) return accessUrl;
    throw new FeedError('token', MESSAGES.accessUnreadable);
  }
  const url = typeof accessUrl === 'string' ? parseUrl(accessUrl.trim()) : null;
  if (!url || !isProviderUrl(url) || !url.username || !url.password) throw new FeedError('token', MESSAGES.accessUnreadable);
  const credentials = decodeUrlPart(url.username) + ':' + decodeUrlPart(url.password);
  return {
    base: url.origin + url.pathname.replace(/\/+$/, ''),
    auth: 'Basic ' + encodeBase64(credentials),
  };
}

/* ------------------------------------------------------------------ requests */

function isOk(response) {
  return !!response && Number.isFinite(response.status) && response.status >= 200 && response.status < 300;
}

function statusOf(response) {
  return response && Number.isFinite(response.status) ? response.status : 0;
}

/**
 * Exchange a claim URL for the access credential (one time only).
 * @param {string} claimUrl
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Access>}
 * @throws {FeedError} 'token' (HTTP 403: already used or unknown), 'network', 'server'
 */
export async function claimAccess(claimUrl, fetchImpl) {
  const url = typeof claimUrl === 'string' ? parseUrl(claimUrl.trim()) : null;
  if (!url || !isProviderUrl(url) || url.username || url.password) throw new FeedError('token', MESSAGES.tokenForeign);

  // The same 30-second limit as the accounts request: a claim that never answers must not leave "Linking" forever.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new FeedError('network', MESSAGES.claimTimeout));
    }, FEED_TIMEOUT_MS);
  });
  const init = { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' };
  if (controller) init.signal = controller.signal;

  let text;
  try {
    let response;
    try {
      response = await Promise.race([fetchImpl(url.href, init), timeout]);
    } catch (err) {
      if (err instanceof FeedError) throw err;
      throw new FeedError('network', MESSAGES.claimUnreachable);
    }
    if (statusOf(response) === 403) throw new FeedError('token', MESSAGES.tokenSpent);
    if (!isOk(response)) {
      throw new FeedError('server', 'SimpleFIN Bridge could not complete the link (error ' + statusOf(response) + '). Try again in a few minutes.');
    }
    try {
      text = await Promise.race([response.text(), timeout]);
    } catch (err) {
      if (err instanceof FeedError) throw err;
      throw new FeedError('network', MESSAGES.claimInterrupted);
    }
  } finally {
    clearTimeout(timer);
    timeout.catch(() => {}); // the losing side of the race must not surface as an unhandled rejection
  }
  try {
    return parseAccessUrl(typeof text === 'string' ? text : '');
  } catch {
    throw new FeedError('server', MESSAGES.claimUnexpected);
  }
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** The window actually requested: never longer than the provider allows, never inside out. */
function clampWindow(range, nowMs) {
  const asked = range && typeof range === 'object' ? range : {};
  const toMs = finiteOr(asked.toMs, finiteOr(nowMs, 0));
  const fromMs = Math.min(Math.max(finiteOr(asked.fromMs, toMs - WINDOW_MS), toMs - WINDOW_MS), toMs);
  return { fromMs, toMs, pending: asked.pending !== false, only: idsOf(asked.only) };
}

/** The provider account ids a request is limited to, or null for every account. */
function idsOf(value) {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map(idOf).filter(Boolean))];
  return ids.length ? ids : null;
}

function accountsUrl(access, range) {
  const url = new URL(access.base + '/accounts');
  const query = new URLSearchParams({ version: '2' });
  if (range.pending) query.set('pending', '1');
  // whole seconds: the span sent is never above the window, whatever the rounding of its two ends
  const end = Math.ceil(range.toMs / 1000);
  query.set('start-date', String(Math.max(Math.floor(range.fromMs / 1000), end - WINDOW_SECONDS)));
  query.set('end-date', String(end));
  for (const id of range.only || []) query.append('account', id);
  url.search = query.toString();
  return url.href;
}

function failureFor(status) {
  if (status === 403 || status === 401) return new FeedError('relink', MESSAGES.relink);
  if (status === 402) return new FeedError('payment', MESSAGES.payment);
  if (status === 429) return new FeedError('rate', MESSAGES.rate);
  return new FeedError('server', 'SimpleFIN Bridge had a problem (error ' + status + '). Nothing was lost; try again later.');
}

async function requestAccounts(href, auth, fetchImpl, signal) {
  let response;
  let text;
  try {
    response = await fetchImpl(href, {
      method: 'GET',
      headers: { Authorization: auth },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (isOk(response)) text = await response.text();
  } catch {
    throw new FeedError('network', MESSAGES.unreachable);
  }
  if (!isOk(response)) throw failureFor(statusOf(response));
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new FeedError('server', MESSAGES.unreadable);
  return json;
}

/**
 * Fetch one window of accounts and transactions.
 * @param {Access} access
 * @param {{ fromMs: number, toMs: number, pending?: boolean, only?: string[] }} window  only = provider account ids to
 *   limit the request to (the feed returned then carries `only` and holds no other account)
 * @param {typeof fetch} fetchImpl
 * @param {number} nowMs
 * @returns {Promise<Feed>} already normalised
 * @throws {FeedError} 'relink' (403; also 401 and a stored link that cannot be read), 'payment' (402),
 *   'rate' (429), 'network' (unreachable, interrupted, or no answer in 30 seconds), 'server'
 */
export async function fetchSimplefin(access, window, fetchImpl, nowMs) {
  let link;
  try {
    link = parseAccessUrl(access);
  } catch {
    throw new FeedError('relink', MESSAGES.relink);
  }
  const range = clampWindow(window, nowMs);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FeedError('network', MESSAGES.timeout));
    }, FEED_TIMEOUT_MS);
  });
  try {
    const json = await Promise.race([requestAccounts(accountsUrl(link, range), link.auth, fetchImpl, controller.signal), timeout]);
    return normalizeSimplefin(json, { fetchedAt: finiteOr(nowMs, range.toMs), fromMs: range.fromMs, toMs: range.toMs, only: range.only });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- normalisation */

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Bank text as received (untrusted), only bounded in length. */
function textOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim().slice(0, MAX_ID) : '';
}

/** One line of provider text for a coach's note. */
function messageOf(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
}

/** Signed integer cents of a provider amount ("-4.75", 12.5), or null when it is not an amount. */
function centsOf(value) {
  const cents = typeof value === 'string' || typeof value === 'number' ? toCents(value) : null;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Whole epoch seconds of a provider timestamp, or null when it is absent, zero or not a time. */
function secondsOf(value) {
  const n = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n > SECONDS_CEILING ? n / 1000 : n);
}

function mccOf(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9999) return String(value).padStart(4, '0');
  return typeof value === 'string' && /^\d{4}$/.test(value.trim()) ? value.trim() : null;
}

/** @returns {FeedTx|null} null for a row with no readable amount. */
function readTx(raw) {
  if (!isRecord(raw)) return null;
  const amount = centsOf(raw.amount);
  if (amount == null) return null;
  const postedAt = secondsOf(raw.posted);
  const happenedAt = secondsOf(raw.transacted_at);
  // pending: the provider says so, or the row has neither a posting time nor a time it happened
  const pending = raw.pending === true || (postedAt == null && happenedAt == null);
  return {
    extId: idOf(raw.id),
    amount,
    // a pending row's "posted" is the day it was authorised: keep it as the day it happened;
    // a row with no posting time that is not pending posted on the day it happened
    posted: pending ? null : postedAt != null ? postedAt : happenedAt,
    at: happenedAt != null ? happenedAt : pending ? postedAt : null,
    pending,
    description: textOf(raw.description),
    payee: textOf(raw.payee),
    memo: textOf(raw.memo),
    mcc: mccOf(raw.mcc),
  };
}

function connectionNames(json) {
  const names = new Map();
  for (const conn of listOf(json.connections)) {
    if (!isRecord(conn)) continue;
    const id = idOf(conn.conn_id);
    if (id) names.set(id, textOf(conn.name).trim() || textOf(conn.org_name).trim());
  }
  return names;
}

/** Connection id and institution name, from either response shape. */
function readConnection(raw, names) {
  const org = isRecord(raw.org) ? raw.org : {};
  const orgName = textOf(org.name).trim() || textOf(org.domain).trim();
  const connId = idOf(raw.conn_id) || idOf(org.id) || idOf(org.domain);
  return { connId, institution: names.get(connId) || orgName };
}

/** @returns {FeedAccount|null} null for an account with no id or no readable balance */
function readAccount(raw, names, fetchedAt) {
  if (!isRecord(raw)) return null;
  const extId = idOf(raw.id);
  const balance = centsOf(raw.balance);
  if (!extId || balance == null) return null;
  const balanceAt = secondsOf(raw['balance-date']);
  return {
    extId,
    ...readConnection(raw, names),
    name: textOf(raw.name).trim(),
    currency: textOf(raw.currency).trim(),
    balance,
    available: centsOf(raw['available-balance']),
    asOf: balanceAt != null ? balanceAt * 1000 : fetchedAt,
    txs: listOf(raw.transactions).map(readTx).filter(Boolean),
  };
}

/** Provider problems from `errlist` (current) and `errors` (older: plain strings), without repeats. */
function readErrors(json) {
  const errors = [];
  const seen = new Set();
  const add = (code, message, connId, accountId) => {
    const key = [code, message, connId, accountId].join('\u0000');
    if (!message || seen.has(key) || BENIGN_NOTICE.test(message)) return;
    seen.add(key);
    errors.push({ code, message, connId, accountId });
  };
  for (const item of [...listOf(json.errlist), ...listOf(json.errors)]) {
    if (typeof item === 'string') {
      add('', messageOf(item), '', '');
    } else if (isRecord(item)) {
      const code = messageOf(item.code);
      add(code, messageOf(item.msg) || messageOf(item.message) || code, idOf(item.conn_id), idOf(item.account_id));
    }
  }
  return errors;
}

/**
 * Turn a raw SimpleFIN /accounts response into a Feed. Pure; tolerant of missing and
 * malformed fields (a bad row is skipped, never thrown on). Amount strings are parsed to
 * integer cents without floating-point error.
 * A pending row keeps whatever date the bank gave as `at`; when it gave none, `posted` and `at`
 * are both null. A second account with an id already seen in the response is dropped.
 * @param {object} json
 * @param {{ fetchedAt: number, fromMs: number, toMs: number, only?: string[]|null }} meta  only = the provider account
 *   ids the request was limited to: any other account in the answer is left out
 * @returns {Feed}
 */
export function normalizeSimplefin(json, meta) {
  const source = isRecord(json) ? json : {};
  const info = isRecord(meta) ? meta : {};
  const fetchedAt = finiteOr(info.fetchedAt, 0);
  const names = connectionNames(source);
  const accounts = [];
  const seen = new Set();
  const only = idsOf(info.only);
  for (const raw of listOf(source.accounts)) {
    const account = readAccount(raw, names, fetchedAt);
    if (!account || seen.has(account.extId) || (only && !only.includes(account.extId))) continue;
    seen.add(account.extId);
    accounts.push(account);
  }
  return {
    src: 'simplefin',
    fetchedAt,
    fromMs: finiteOr(info.fromMs, fetchedAt),
    toMs: finiteOr(info.toMs, fetchedAt),
    accounts,
    ...(only ? { only } : {}),
    errors: readErrors(source),
  };
}

/* ------------------------------------------------------------------ scheduling */

/**
 * Where the stored bank rows ask the next reading to start: a week before the newest posted row (`posted`),
 * and just before the oldest row still pending (`pending`). Each is null when there is no such row.
 */
function resumeFromMs(state) {
  let newestPosted = '';
  let oldestPending = '';
  for (const tx of listOf(state && state.txs)) {
    if (!tx || tx.source !== 'bank') continue;
    if (tx.pending) {
      if (isYmd(tx.day) && (!oldestPending || tx.day < oldestPending)) oldestPending = tx.day;
    } else if (isYmd(tx.postedDay) && tx.postedDay > newestPosted) {
      newestPosted = tx.postedDay;
    }
  }
  return {
    posted: newestPosted ? startOfDayMs(addDays(newestPosted, -OVERLAP_DAYS)) : null,
    pending: oldestPending ? startOfDayMs(addDays(oldestPending, -PENDING_MARGIN_DAYS)) : null,
  };
}

/**
 * The windows to request for the next reading, consecutive and oldest first, none longer than 44 days.
 *  - no reading of this device has completed yet (state.sync.completed is not true): the last 176 days,
 *    as four windows of 44 days (four requests);
 *  - otherwise: from 7 days before the newest stored posted bank transaction to now, never more than 176 days
 *    back (a device back after a long absence); a span longer than 44 days is cut into windows of 44 days, the
 *    last one ending now. A bank row still pending pulls the start back to 2 days before its day, at most to
 *    44 days before now: a pending row never makes a reading cost more than one request. The reading always
 *    reaches back at least 7 days. With no bank row on the record it is the last 44 days.
 * @param {object} state  the document
 * @param {number} nowMs
 * @returns {{ fromMs: number, toMs: number }[]}
 */
export function syncWindows(state, nowMs) {
  const now = finiteOr(nowMs, 0);
  const reach = now - REACH_MS;
  let fromMs = reach;
  if (!isFirstReading(state)) {
    const resume = resumeFromMs(state);
    const starts = [];
    if (resume.posted != null) starts.push(Math.max(reach, resume.posted));
    if (resume.pending != null) starts.push(Math.max(now - WINDOW_MS, resume.pending));
    fromMs = starts.length ? Math.min(now - OVERLAP_DAYS * DAY_MS, ...starts) : now - WINDOW_MS;
  }
  const windows = [];
  for (let start = fromMs; start < now; start += WINDOW_MS) windows.push({ fromMs: start, toMs: Math.min(start + WINDOW_MS, now) });
  return windows.length ? windows : [{ fromMs: now, toMs: now }];
}

/* --------------------------------------------------------------------- history */

function providerIdOf(account) {
  return isRecord(account) && account.source === 'bank' && isRecord(account.ext) ? idOf(account.ext.id) : '';
}

/**
 * An account's history state, or null when it has none.
 * @param {object} account
 * @returns {{ need: true, step: number, done: boolean, gaveUp: boolean, tries: number, at: number|null }|null}
 *   step = the number of windows had (0 to 4)
 */
export function backfillOf(account) {
  const kept = isRecord(account) && isRecord(account.backfill) ? account.backfill : null;
  if (!kept || kept.need !== true) return null;
  return {
    need: true,
    step: Number.isInteger(kept.step) && kept.step > 0 ? Math.min(kept.step, HISTORY.steps) : 0,
    done: kept.done === true,
    gaveUp: kept.gaveUp === true,
    tries: Number.isInteger(kept.tries) && kept.tries > 0 ? kept.tries : 0,
    at: Number.isFinite(kept.at) ? kept.at : null,
  };
}

/** A history state that has everything still to do. */
export function openBackfill() {
  return { need: true, step: 0, done: false, gaveUp: false, tries: 0, at: null };
}

/**
 * Is this account still to be asked for its history? True for an account that came from the bank, is not left
 * out, and whose history state says there is a need that is not done. Nothing is derived from the age of rows.
 * @param {object} account  one of the document's accounts
 * @returns {boolean}
 */
export function lacksHistory(account) {
  if (!providerIdOf(account) || account.hidden === true) return false;
  const book = backfillOf(account);
  return !!book && !book.done;
}

/**
 * The history request this account is due, or null. History is asked in steps, newest first: step k (0 to 3)
 * asks, for this account alone, the 44 days that end k times 44 days before now.
 * @param {object} state
 * @param {object} account
 * @param {number} nowMs
 * @returns {{ accountId: string, step: number, fromMs: number, toMs: number, pending: true, only: string[] }|null}
 */
export function historyStep(state, account, nowMs) {
  if (!lacksHistory(account)) return null;
  const step = backfillOf(account).step;
  if (step >= HISTORY.steps) return null;
  const toMs = finiteOr(nowMs, 0) - step * WINDOW_MS;
  return { accountId: account.id, step, fromMs: toMs - WINDOW_MS, toMs, pending: true, only: [providerIdOf(account)] };
}

/** How many of the day's requests are still unused. */
function unusedRequests(requests, nowMs) {
  const used = listOf(requests).filter((at) => Number.isFinite(at) && at <= nowMs && nowMs - at < DAY_MS).length;
  return QUOTA.perDay - used;
}

/**
 * May one more history request be made now? Only while at least 8 of the day's 20 requests are unused, so the
 * ordinary readings of the day always have theirs. Ask before every history request.
 * @param {object} state  the document (its sync.requests is the day's request log)
 * @param {number} nowMs
 * @returns {boolean}
 */
export function historyAllowed(state, nowMs) {
  if (!isRecord(state) || !Number.isFinite(nowMs)) return false;
  return unusedRequests(isRecord(state.sync) ? state.sync.requests : [], nowMs) >= HISTORY.spare;
}

/**
 * Has no reading of this device completed yet? state.sync.completed is set where a reading ends well, so a first
 * reading that was interrupted is still a first reading when it is tried again.
 */
export function isFirstReading(state) {
  return !(isRecord(state) && isRecord(state.sync) && state.sync.completed === true);
}

/**
 * The accounts whose history is begun after the ordinary windows of a reading have been merged, each with the
 * step it is due: none during a device's first reading (its four windows have just asked for everything);
 * otherwise at most 2 accounts whose last attempt was at least 12 hours ago (or never), the one waited longest
 * first. The steps that follow in the same reading come from historyStep, one after each step that was had.
 * @param {object} state  the document
 * @param {number} nowMs
 * @param {boolean} [first]  this reading is the device's first (isFirstReading, asked before its windows)
 * @returns {{ accountId: string, step: number, fromMs: number, toMs: number, pending: true, only: string[] }[]}
 */
export function historyRequests(state, nowMs, first) {
  if (first === true || !historyAllowed(state, nowMs)) return [];
  const due = [];
  for (const account of listOf(state.accounts)) {
    const step = historyStep(state, account, nowMs);
    if (!step) continue;
    const at = backfillOf(account).at;
    if (at != null && nowMs - at < HISTORY.everyMs && nowMs >= at) continue;
    due.push({ step, at: at == null ? -Infinity : at });
  }
  due.sort((a, b) => a.at - b.at);
  return due.slice(0, HISTORY.perReading).map((item) => item.step);
}

/** Do the feed's problems name this account or its connection? */
function namedInErrors(feed, account) {
  const ext = isRecord(account.ext) ? account.ext : {};
  return listOf(feed && feed.errors).some((problem) => isRecord(problem)
    && ((problem.accountId && problem.accountId === ext.id) || (problem.connId && problem.connId === ext.conn)));
}

/** Did the answer carry a transaction for this account? */
function carriedRows(feed, account) {
  const id = providerIdOf(account);
  return listOf(feed && feed.accounts).some((entry) => isRecord(entry) && entry.extId === id && listOf(entry.txs).length > 0);
}

/**
 * Does the record hold a bank row of this account dated inside the window? A row on the window's first day is
 * never inside (it may lie before the window began). For step 0, whose window ends now, a row dated up to and
 * including the day of now is inside, that day being the later of its UTC and its local day; for the earlier
 * steps a row on the last day is not inside either (it may lie after the window ended).
 */
function holdsRowInside(state, account, step, fromMs, toMs) {
  const fromDay = dayOfMs(fromMs);
  const utcDay = dayOfMs(toMs);
  const localDay = ymd(finiteOr(toMs, 0));
  const endsNow = step === 0;
  const toDay = endsNow && localDay > utcDay ? localDay : utcDay;
  return listOf(state && state.txs).some((tx) => {
    if (!isRecord(tx) || tx.source !== 'bank' || tx.accountId !== account.id) return false;
    const day = !tx.pending && isYmd(tx.postedDay) ? tx.postedDay : tx.day;
    return isYmd(day) && day > fromDay && (day < toDay || (endsNow && day === toDay));
  });
}

/** The calendar day (UTC) of a time. */
function dayOfMs(ms) {
  return new Date(finiteOr(ms, 0)).toISOString().slice(0, 10);
}

/**
 * Record a history request once it is over. Every attempt, answered or failed, sets the time the account was last
 * asked; only a request that never reached the provider (offline) is not recorded at all — do not call this then.
 *  - `feed` null: the request failed (network, 429, 5xx). Nothing else changes.
 *  - a sound answer, whatever it brought (an empty answer is an answer): the step is had; at 4 the account is done.
 *  - an answer that is not sound — the feed's problems name the account or its connection, or it carried no
 *    transaction for the account although the record holds a bank row of it dated inside the window asked — is
 *    counted: the same step is asked again 12 hours later, and after HISTORY.maxTries such answers in all the
 *    account gives up.
 * @param {object} state
 * @param {{ accountId: string, step: number, fromMs: number, toMs: number }} asked  the request, as historyStep gave it
 * @param {number} nowMs
 * @param {Feed|null} feed  the answer, already merged; null when the request failed
 * @returns {{ need: true, step: number, done: boolean, gaveUp: boolean, tries: number, at: number|null, had: boolean }|null}
 *   the account's history state, and whether this step was had; null when there is no such account
 */
export function recordHistory(state, asked, nowMs, feed) {
  const request = isRecord(asked) ? asked : {};
  const account = listOf(state && state.accounts).find((a) => isRecord(a) && a.id === request.accountId);
  if (!account) return null;
  const book = backfillOf(account) || openBackfill();
  book.at = finiteOr(nowMs, 0);
  let had = false;
  if (feed != null && !book.done) {
    const sound = !namedInErrors(feed, account)
      && (carriedRows(feed, account) || !holdsRowInside(state, account, request.step, request.fromMs, request.toMs));
    if (sound) {
      had = true;
      book.step = Math.min(book.step + 1, HISTORY.steps);
      if (book.step >= HISTORY.steps) book.done = true;
    } else {
      book.tries += 1;
      if (book.tries >= HISTORY.maxTries) {
        book.done = true;
        book.gaveUp = true;
      }
    }
  }
  account.backfill = book;
  return { ...book, had };
}

/**
 * May a sync run now?
 * @param {number[]} requests  timestamps (ms) of recent requests (state.sync.requests)
 * @param {number|null} lastOk timestamp of the last successful sync
 * @param {number} nowMs
 * @param {{ manual?: boolean, needed?: number }} [opts]  manual = the owner pressed refresh; needed = requests this sync will make
 * @returns {{ ok: boolean, waitMs: number, reason: ''|'fresh'|'cooldown'|'quota' }}
 *   automatic: ok when lastOk is null or older than QUOTA.autoEveryMs; manual: ok when the last request is older than
 *   QUOTA.manualEveryMs; both require fewer than QUOTA.perDay requests in the trailing 24 hours (counting `needed`).
 *   When two limits apply, the one with the longer wait is reported.
 */
export function quotaAllows(requests, lastOk, nowMs, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const needed = Number.isFinite(options.needed) ? Math.max(1, Math.floor(options.needed)) : 1;
  const recent = listOf(requests)
    .filter((at) => Number.isFinite(at) && at <= nowMs && nowMs - at < DAY_MS)
    .sort((a, b) => a - b);

  let pause = { waitMs: 0, reason: '' };
  if (options.manual) {
    const last = recent.length ? recent[recent.length - 1] : null;
    if (last != null && nowMs - last < QUOTA.manualEveryMs) pause = { waitMs: last + QUOTA.manualEveryMs - nowMs, reason: 'cooldown' };
  } else if (Number.isFinite(lastOk) && nowMs - lastOk < QUOTA.autoEveryMs) {
    pause = { waitMs: Math.min(lastOk + QUOTA.autoEveryMs - nowMs, QUOTA.autoEveryMs), reason: 'fresh' };
  }

  const excess = recent.length + needed - QUOTA.perDay;
  if (excess > 0) {
    // the sync fits once the `excess` oldest requests are more than a day old
    const blocking = recent[Math.min(excess, recent.length) - 1];
    const waitMs = blocking == null ? DAY_MS : blocking + DAY_MS - nowMs;
    if (waitMs > pause.waitMs) pause = { waitMs, reason: 'quota' };
  }
  return { ok: pause.reason === '', waitMs: pause.waitMs, reason: pause.reason };
}
