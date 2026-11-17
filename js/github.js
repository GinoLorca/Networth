/**
 * The transport of the shared file: one file in the owner's private repository on GitHub.
 * See ARCHITECTURE.md section 3.5.
 *
 * `fetch` is passed in, so tests use a fake and no request is ever made from here by itself.
 * The key is used for one thing only, the Authorization header of a request to api.github.com:
 * it is never put in a URL, a body, a log line or the message of an error. Every failure leaves
 * here as a ShareError with a fixed message; the error fetch itself gave is dropped.
 */

const API = 'https://api.github.com';
const REPOSITORY = 'networth-data';
const FILE = 'networth-shared.json';
const MESSAGE = 'Networth: shared file';
const TIMEOUT_MS = 20000;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const KEY = /^[\x21-\x7e]{20,400}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const HOST = /^([a-z0-9-]+)\.github\.io$/i;

const MESSAGES = {
  key: 'GitHub refused the key: it may have expired. Paste a new one.',
  missing: 'GitHub finds no repository networth-data that this key can see. The key needs that 1 repository, with Contents: Read and write.',
  conflict: 'Another device wrote the shared file at the same moment, 4 times in a row.',
  network: 'GitHub could not be reached, or gave no answer in 20 seconds.',
  server: 'GitHub answered with an error of its own (a 5xx).',
  rate: 'GitHub asked for a pause; nothing is asked of it for 10 minutes.',
  file: 'The shared file is not one this version of Networth can read. It was left as it is.',
  large: 'The shared file is larger than 1 MB and GitHub did not give its content. It was left as it is.',
};

/** A failed call. `code`: 'key' | 'missing' | 'conflict' | 'network' | 'server' | 'rate' | 'file' | 'large'. */
export class ShareError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.network);
    this.name = 'ShareError';
    this.code = MESSAGES[code] ? code : 'network';
  }
}

/** The plain words of an error code, for the interface. */
export function shareMessage(code) {
  return MESSAGES[code] || MESSAGES.network;
}

/** Whether a pasted text has the shape of a key (printable, no spaces, 20 to 400 characters). */
export function isShareKey(key) {
  return typeof key === 'string' && KEY.test(key);
}

/**
 * Whose repository this page shares through: on `<name>.github.io` it is `<name>`; on a development
 * host (localhost) it is the `?share=<owner>` the page was opened with; anywhere else there is none.
 * @param {{ hostname: string, search: string }} where  the page's address
 * @returns {string|null}
 */
export function shareOwner(where) {
  const host = where && typeof where.hostname === 'string' ? where.hostname : '';
  const m = HOST.exec(host);
  if (m) return OWNER.test(m[1]) ? m[1] : null;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return null;
  let asked = null;
  try { asked = new URLSearchParams(where.search || '').get('share'); } catch { asked = null; }
  return asked && OWNER.test(asked) ? asked : null;
}

/** The one address every request goes to. */
export function sharedUrl(owner) {
  if (typeof owner !== 'string' || !OWNER.test(owner)) throw new ShareError('missing');
  return API + '/repos/' + owner + '/' + REPOSITORY + '/contents/' + FILE;
}

/** Text to base64 through UTF-8 (never btoa on the text itself). */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 (line breaks allowed) to text through UTF-8; null when it is not base64 or not UTF-8. */
export function fromBase64(encoded) {
  if (typeof encoded !== 'string') return null;
  try {
    const binary = atob(encoded.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}

function codeOf(res) {
  const status = res.status;
  if (status === 429) return 'rate';
  if (status === 403) {
    let left = null;
    try { left = res.headers.get('x-ratelimit-remaining'); } catch { left = null; }
    return left === '0' ? 'rate' : 'key';
  }
  if (status === 401) return 'key';
  if (status === 404) return 'missing';
  if (status === 409 || status === 422) return 'conflict';
  return 'server';
}

/**
 * The server's time an answer carries, for the daily game's noting limit (ARCHITECTURE 3.9): its Date header where the
 * page may read it, else the start of the rate-limit window (X-RateLimit-Reset less an hour; GitHub lets a page on
 * another origin read that header and not Date): never after the server's now, at most an hour before it. null when the
 * answer has neither. No device clock is read.
 */
function servedAt(res) {
  let date = null;
  let reset = null;
  try {
    date = res.headers.get('date');
    reset = res.headers.get('x-ratelimit-reset');
  } catch { return null; }
  const dated = typeof date === 'string' ? Date.parse(date) : NaN;
  if (Number.isFinite(dated) && dated > 0) return dated;
  return typeof reset === 'string' && /^\d{9,11}$/.test(reset) ? Number(reset) * 1000 - 3600000 : null;
}

/** A time GitHub wrote in an answer's body (an ISO date), or null. */
function dateIn(text) {
  const ms = typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** An answer with the server's time when one was heard (`serverMs`), else as it was. */
function withServer(answer, heard) {
  return heard.ms === null ? answer : { ...answer, serverMs: heard.ms };
}

/**
 * One request; resolves with the parsed answer of a 2xx, rejects with a ShareError otherwise. `heard.ms` takes the
 * server's time of any answer (servedAt).
 */
async function call(owner, key, init, doFetch, at = sharedUrl(owner), heard = null) {
  const url = at;
  if (!isShareKey(key)) throw new ShareError('key');
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => { if (abort) abort.abort(); reject(new ShareError('network')); }, TIMEOUT_MS);
  });
  const asked = (async () => {
    let res = null;
    try {
      res = await doFetch(url, {
        ...init,
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: abort ? abort.signal : undefined,
      });
    } catch {
      throw new ShareError('network'); // whatever fetch said is dropped: it may quote the request
    }
    if (heard && res) {
      const ms = servedAt(res);
      if (ms !== null) heard.ms = ms;
    }
    if (!res || !(res.status >= 200 && res.status < 300)) throw new ShareError(res ? codeOf(res) : 'network');
    try { return await res.json(); } catch { throw new ShareError('server'); }
  })();
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
    asked.catch(() => {}); // an answer that arrives after the 20 seconds is nobody's
  }
}

/**
 * Read the shared file. Above 1 MB the Contents API gives the file's sha and no content (`encoding: 'none'`): the
 * content is then read by that sha from the blob API (up to 100 MB). That answer is never "no file": when the blob
 * cannot be read either, the read fails, so the round stops and nothing is written over a file this device could not read.
 * @returns {Promise<{ text: string|null, sha: string|null, serverMs?: number }>} text null when there is no file yet
 *          (GitHub says 404 for that, and also when the key cannot see the repository); serverMs, the server's time
 *          of the answer, when it carries one
 */
export async function readSharedText(owner, key, doFetch) {
  sharedUrl(owner); // an owner that is none is an error here, not "no file yet"
  const heard = { ms: null };
  let body = null;
  try {
    body = await call(owner, key, { method: 'GET' }, doFetch, sharedUrl(owner), heard);
  } catch (err) {
    if (err instanceof ShareError && err.code === 'missing') return withServer({ text: null, sha: null }, heard);
    throw err;
  }
  const sha = body && typeof body.sha === 'string' && SHA.test(body.sha) ? body.sha : null;
  if (body && body.encoding === 'none' && sha) {
    // a 404 here is not "no file" either: the file was just listed with this sha
    const blob = await call(owner, key, { method: 'GET' }, doFetch, blobUrl(owner, sha)).catch((err) => {
      throw err instanceof ShareError && err.code === 'missing' ? new ShareError('large') : err;
    });
    const text = blob && blob.encoding === 'base64' && blob.sha === sha ? fromBase64(blob.content) : null;
    if (text === null) throw new ShareError('large');
    return withServer({ text, sha }, heard);
  }
  const text = body && body.encoding === 'base64' ? fromBase64(body.content) : null;
  if (text === null || !sha) throw new ShareError('file');
  return withServer({ text, sha }, heard);
}

/** The blob API's address for a file's content by its sha (the Contents API gives no content above 1 MB). */
function blobUrl(owner, sha) {
  return API + '/repos/' + owner + '/' + REPOSITORY + '/git/blobs/' + sha;
}

/**
 * Write the shared file. `sha` is the one just read, or null when there was no file.
 * @returns {Promise<{ sha: string|null, serverMs?: number }>} serverMs: the server's time of the answer (its headers,
 *          else the date GitHub gave the commit), when it carries one
 */
export async function writeSharedText(owner, key, text, sha, doFetch) {
  const payload = { message: MESSAGE, content: toBase64(text) };
  if (typeof sha === 'string' && SHA.test(sha)) payload.sha = sha;
  const heard = { ms: null };
  const body = await call(owner, key, { method: 'PUT', body: JSON.stringify(payload) }, doFetch, sharedUrl(owner), heard);
  const next = body && body.content && typeof body.content.sha === 'string' ? body.content.sha : null;
  if (heard.ms === null && body && body.commit && body.commit.committer) heard.ms = dateIn(body.commit.committer.date);
  return withServer({ sha: next }, heard);
}

/* ------------------------------------------------------------- the card alert inbox */

const INBOX = 'inbox';
const INBOX_NAME = /^\d{8}-\d{6}-\d{3}\.txt$/;
const INBOX_DELETE = 'Networth: alert read';

/** The inbox folder, or one file in it (a name of the phone's form only). */
export function inboxUrl(owner, name) {
  if (typeof owner !== 'string' || !OWNER.test(owner)) throw new ShareError('missing');
  if (name !== undefined && !(typeof name === 'string' && INBOX_NAME.test(name))) throw new ShareError('file');
  return API + '/repos/' + owner + '/' + REPOSITORY + '/contents/' + INBOX + (name === undefined ? '' : '/' + name);
}

/**
 * List the inbox folder. No folder (GitHub's 404) is an empty inbox.
 * @returns {Promise<{ name: string, sha: string, size: number }[]>} only files named as the phone names them
 */
export async function listInbox(owner, key, doFetch) {
  const url = inboxUrl(owner);
  let body = null;
  try {
    body = await call(owner, key, { method: 'GET' }, doFetch, url);
  } catch (err) {
    if (err instanceof ShareError && err.code === 'missing') return [];
    throw err;
  }
  if (!Array.isArray(body)) throw new ShareError('file');
  return body
    .filter((e) => e && e.type === 'file' && typeof e.name === 'string' && INBOX_NAME.test(e.name)
      && typeof e.sha === 'string' && SHA.test(e.sha) && Number.isFinite(e.size))
    .slice(0, 500)
    .map((e) => ({ name: e.name, sha: e.sha, size: e.size }));
}

/** Read one inbox file's text; null when it is gone or is not UTF-8 text. */
export async function readInboxFile(owner, key, name, doFetch) {
  const url = inboxUrl(owner, name);
  let body = null;
  try {
    body = await call(owner, key, { method: 'GET' }, doFetch, url);
  } catch (err) {
    if (err instanceof ShareError && err.code === 'missing') return null;
    throw err;
  }
  return body && body.encoding === 'base64' ? fromBase64(body.content) : null;
}

/** Delete one inbox file. A file already gone (another device deleted it) is not an error. */
export async function deleteInboxFile(owner, key, name, sha, doFetch) {
  const url = inboxUrl(owner, name);
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new ShareError('file');
  try {
    await call(owner, key, { method: 'DELETE', body: JSON.stringify({ message: INBOX_DELETE, sha }) }, doFetch, url);
  } catch (err) {
    if (err instanceof ShareError && (err.code === 'missing' || err.code === 'conflict')) return false;
    throw err;
  }
  return true;
}

/* ------------------------------------------------------- income the owner's other apps report */

const INCOME = 'income';
/** A file of income/: an id of 1 to 80 letters, digits and `_ . : -`, then `.json`. */
const INCOME_NAME = /^[A-Za-z0-9_.:-]{1,80}\.json$/;

/** The folder income/, or one file in it (a name of the expected form only). Nothing here writes to it. */
export function incomeUrl(owner, name) {
  if (typeof owner !== 'string' || !OWNER.test(owner)) throw new ShareError('missing');
  if (name !== undefined && !(typeof name === 'string' && INCOME_NAME.test(name))) throw new ShareError('file');
  return API + '/repos/' + owner + '/' + REPOSITORY + '/contents/' + INCOME + (name === undefined ? '' : '/' + encodeURIComponent(name));
}

/**
 * List income/. No folder (GitHub's 404) gives null, not an empty list: nothing has arrived yet, or the key cannot
 * see the repository any more, so a reading drops nothing on it.
 * @returns {Promise<{ name: string, sha: string, size: number }[]|null>} the `*.json` files directly inside it
 */
export async function listIncome(owner, key, doFetch) {
  const url = incomeUrl(owner);
  let body = null;
  try {
    body = await call(owner, key, { method: 'GET' }, doFetch, url);
  } catch (err) {
    if (err instanceof ShareError && err.code === 'missing') return null;
    throw err;
  }
  if (!Array.isArray(body)) throw new ShareError('file');
  return body
    .filter((e) => e && e.type === 'file' && typeof e.name === 'string' && INCOME_NAME.test(e.name)
      && typeof e.sha === 'string' && SHA.test(e.sha) && Number.isFinite(e.size))
    .slice(0, 100)
    .map((e) => ({ name: e.name, sha: e.sha, size: e.size }));
}

/** Read one file of income/; null when it is gone or is not UTF-8 text. */
export async function readIncomeText(owner, key, name, doFetch) {
  const url = incomeUrl(owner, name);
  let body = null;
  try {
    body = await call(owner, key, { method: 'GET' }, doFetch, url);
  } catch (err) {
    if (err instanceof ShareError && err.code === 'missing') return null;
    throw err;
  }
  return body && body.encoding === 'base64' ? fromBase64(body.content) : null;
}

/* ------------------------------------------------------------------------------------- the nightly wrap (3.10) */

/** A file of the nightly wrap: push/<device or vapid>.json or wrap/<device or sent>.json, and nothing else. */
const REPO_FILE = /^(push|wrap)\/[A-Za-z0-9_-]{1,40}\.json$/;
const REPO_MESSAGE = 'Networth: nightly wrap';
/** A write GitHub refused because another device wrote meanwhile starts again from the read, at most this many more times. */
const REPO_RETRIES = 3;

/** The address of one file of the nightly wrap (push/ or wrap/) in the owner's private repository. */
export function repoFileUrl(owner, path) {
  if (typeof owner !== 'string' || !OWNER.test(owner)) throw new ShareError('missing');
  if (typeof path !== 'string' || !REPO_FILE.test(path)) throw new ShareError('file');
  return API + '/repos/' + owner + '/' + REPOSITORY + '/contents/' + path;
}

/**
 * Read one file of the nightly wrap by path.
 * @returns {Promise<{ text: string|null, sha: string|null }>} text null when there is no file (GitHub's 404)
 */
export async function readRepoFile(owner, key, path, doFetch) {
  const url = repoFileUrl(owner, path);
  let body = null;
  try {
    body = await call(owner, key, { method: 'GET' }, doFetch, url);
  } catch (err) {
    if (err instanceof ShareError && err.code === 'missing') return { text: null, sha: null };
    throw err;
  }
  const sha = body && typeof body.sha === 'string' && SHA.test(body.sha) ? body.sha : null;
  const text = body && body.encoding === 'base64' ? fromBase64(body.content) : null;
  if (text === null || !sha) throw new ShareError('file');
  return { text, sha };
}

/**
 * Write one file of the nightly wrap by path, with the sha just read (null when there was no file).
 * @returns {Promise<{ sha: string|null }>}
 */
export async function writeRepoFile(owner, key, path, text, sha, doFetch) {
  const url = repoFileUrl(owner, path);
  const payload = { message: REPO_MESSAGE, content: toBase64(text) };
  if (typeof sha === 'string' && SHA.test(sha)) payload.sha = sha;
  const body = await call(owner, key, { method: 'PUT', body: JSON.stringify(payload) }, doFetch, url);
  return { sha: body && body.content && typeof body.content.sha === 'string' ? body.content.sha : null };
}

/**
 * Read a file, make its new text from what is there, and write it with that sha, as the shared file's round does: when
 * GitHub answers that another device wrote meanwhile (409, 422), it starts again from the read, at most 3 more times.
 * `make(text|null)` gives the new text, or null when there is nothing to write (then no request is sent but the read).
 * @returns {Promise<{ written: boolean, text: string|null }>} text: what the file now holds
 */
export async function putRepoFile(owner, key, path, make, doFetch) {
  for (let turn = 0; ; turn++) {
    const { text, sha } = await readRepoFile(owner, key, path, doFetch);
    const next = make(text);
    if (typeof next !== 'string') return { written: false, text };
    try {
      await writeRepoFile(owner, key, path, next, sha, doFetch);
      return { written: true, text: next };
    } catch (err) {
      if (!(err instanceof ShareError && err.code === 'conflict') || turn >= REPO_RETRIES) throw err;
    }
  }
}

/**
 * Remove one file of the nightly wrap by path (read for its sha first, again after a conflict, at most 3 more times).
 * A file already gone is not an error.
 * @returns {Promise<boolean>} whether a file was removed
 */
export async function deleteRepoFile(owner, key, path, doFetch) {
  const url = repoFileUrl(owner, path);
  for (let turn = 0; ; turn++) {
    const { sha } = await readRepoFile(owner, key, path, doFetch);
    if (!sha) return false;
    try {
      await call(owner, key, { method: 'DELETE', body: JSON.stringify({ message: REPO_MESSAGE, sha }) }, doFetch, url);
      return true;
    } catch (err) {
      if (err instanceof ShareError && err.code === 'missing') return false;
      if (!(err instanceof ShareError && err.code === 'conflict') || turn >= REPO_RETRIES) throw err;
    }
  }
}
