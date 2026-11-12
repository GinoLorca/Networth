import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_TIMEOUT_MS, FEED_WINDOW_DAYS, FeedError, QUOTA,
  claimAccess, fetchSimplefin, normalizeSimplefin, parseAccessUrl, parseSetupToken, quotaAllows, syncWindows,
} from '../js/model/feed.js';
import { defaultState, makeTx } from '../js/model/schema.js';
import { startOfDayMs } from '../js/model/dates.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const NOW = new Date(2026, 10, 11, 15, 30).getTime();

/* Invented credentials: nothing here opens anything. */
const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/INVENTEDCLAIM';
const ACCESS_USER = 'inventeduser';
const ACCESS_PASS = 'inventedsecret';
const ACCESS_URL = 'https://' + ACCESS_USER + ':' + ACCESS_PASS + '@beta-bridge.simplefin.org/simplefin';
const ACCESS = { base: 'https://beta-bridge.simplefin.org/simplefin', auth: 'Basic ' + btoa(ACCESS_USER + ':' + ACCESS_PASS) };
const SECRETS = [ACCESS_USER, ACCESS_PASS, ACCESS.auth, btoa(ACCESS_USER + ':' + ACCESS_PASS), 'beta-bridge', 'INVENTEDCLAIM', 'https://'];

/* A trimmed copy of the public SimpleFIN demo account's answer (fictional data). */
const DEMO_RESPONSE = {
  errlist: [],
  accounts: [
    {
      id: 'Demo Savings', name: 'SimpleFIN Savings', currency: 'USD', balance: '113985.51', 'available-balance': '113985.51',
      'balance-date': 1794441600,
      transactions: [
        { id: '1794384000', posted: 1794384000, amount: '-55.50', description: 'Fishing bait', payee: "John's Fishin Shack", memo: 'JOHNS FISHIN SHACK BAIT', transacted_at: 1794384000, mcc: '5812' },
        { id: '1794412800', posted: 1794412800, amount: '-85.50', description: 'Grocery store', payee: 'Grocery store', memo: 'LOCAL GROCER STORE #1133', transacted_at: 1794412800, mcc: '5411' },
      ],
      holdings: [{ id: '25bc4910', created: 345427200, cost_basis: '55.00', currency: 'USD', description: 'Shares of Apple', market_value: '105884.8', shares: '550.0', symbol: 'AAPL' }],
      conn_id: 'CON-SIMPLEFIN-DEMO',
    },
    {
      id: 'Demo Checking', name: 'SimpleFIN Checking', currency: 'USD', balance: '24119.91', 'available-balance': '24119.91',
      'balance-date': 1794441600,
      transactions: [
        { id: '1794384000', posted: 1794384000, amount: '-72.20', description: 'Fishing bait', payee: "John's Fishin Shack", memo: 'JOHNS FISHIN SHACK BAIT', transacted_at: 1794384000, mcc: '5812' },
        { id: '1794412800', posted: 1794412800, amount: '-111.12', description: 'Grocery store', payee: 'Grocery store', memo: 'LOCAL GROCER STORE #1133', transacted_at: 1794412800, mcc: '5411' },
        { id: '1794470400', posted: 1794470400, amount: '-78.85', description: 'Fishing bait', payee: "John's Fishin Shack", memo: 'JOHNS FISHIN SHACK BAIT', transacted_at: 1794470400, mcc: '5812' },
      ],
      holdings: [],
      conn_id: 'CON-SIMPLEFIN-DEMO',
    },
    { id: 'Demo Empty Account', name: 'SimpleFIN Empty Account', currency: 'USD', balance: '0.00', 'available-balance': '0.00', 'balance-date': 1794441600, transactions: [], holdings: [], conn_id: 'CON-SIMPLEFIN-DEMO' },
  ],
  connections: [{ conn_id: 'CON-SIMPLEFIN-DEMO', name: 'SimpleFIN Demo', org_id: 'simplefin.demoorg', org_name: 'SimpleFIN Bridge', org_url: 'https://beta-bridge.simplefin.org', sfin_url: 'https://beta-bridge.simplefin.org/simplefin' }],
  'x-api-message': ["Provide a 'start-date' parameter to receive transactions prior to yesterday"],
};

const META = { fetchedAt: NOW, fromMs: NOW - 30 * DAY_MS, toMs: NOW };

function respond(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

/** A fetch stand-in that records every call and never goes online. */
function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === 'function' ? answer(url, init) : answer;
  };
  return { impl, calls };
}

function isFeedError(code) {
  return (err) => {
    assert.ok(err instanceof FeedError, 'a FeedError is thrown');
    assert.equal(err.name, 'FeedError');
    assert.equal(err.code, code);
    assert.ok(err.message.length > 20, 'the message says something specific');
    for (const secret of SECRETS) assert.ok(!err.message.includes(secret), 'the message carries no URL, credential or token');
    return true;
  };
}

/* ---------------------------------------------------------------- setup token */

test('parseSetupToken: decodes base64 to the claim URL', () => {
  assert.deepEqual(parseSetupToken(btoa(CLAIM_URL)), { claimUrl: CLAIM_URL });
});

test('parseSetupToken: tolerates whitespace, line breaks, missing padding and the URL-safe alphabet', () => {
  const token = btoa(CLAIM_URL);
  const wrapped = '  ' + token.slice(0, 20) + '\n' + token.slice(20, 40) + '\r\n\t' + token.slice(40) + '  \n';
  assert.equal(parseSetupToken(wrapped).claimUrl, CLAIM_URL);
  assert.equal(parseSetupToken(token.replace(/=+$/, '')).claimUrl, CLAIM_URL);

  const withSpecials = 'https://bridge.simplefin.org/simplefin/claim/a?b>c~~d';
  const standard = btoa(withSpecials);
  assert.match(standard, /[+/]/, 'the fixture exercises the characters that differ between alphabets');
  assert.equal(parseSetupToken(standard.replace(/\+/g, '-').replace(/\//g, '_')).claimUrl, parseSetupToken(standard).claimUrl);
});

test('parseSetupToken: accepts the bare host and any subdomain of simplefin.org', () => {
  assert.equal(parseSetupToken(btoa('https://simplefin.org/claim/x')).claimUrl, 'https://simplefin.org/claim/x');
  assert.equal(parseSetupToken(btoa('https://a.b.simplefin.org/claim/x')).claimUrl, 'https://a.b.simplefin.org/claim/x');
});

test('parseSetupToken: rejects anything that is not a token, with a code and a clean message', () => {
  const bad = [
    '', '   \n ', null, undefined, 42, {},
    'not base64 at all !!!',
    btoa('just some words'),
    CLAIM_URL,
    ACCESS_URL,
    btoa('http://beta-bridge.simplefin.org/simplefin/claim/INVENTEDCLAIM'),
    btoa('https://bridge.example.com/simplefin/claim/INVENTEDCLAIM'),
    btoa('https://simplefin.org.example.com/claim/INVENTEDCLAIM'),
    btoa('https://notsimplefin.org/claim/INVENTEDCLAIM'),
    btoa('https://example.com/simplefin.org/claim'),
    btoa('https://simplefin.org@example.com/claim'),
    btoa(ACCESS_URL),
    btoa('javascript:alert(1)'),
    'A',
  ];
  for (const token of bad) assert.throws(() => parseSetupToken(token), isFeedError('token'), 'rejected: ' + String(token).slice(0, 12));
});

test('parseSetupToken: the message tells a pasted address from a damaged token', () => {
  const pasted = (() => { try { parseSetupToken(CLAIM_URL); } catch (err) { return err.message; } return ''; })();
  const damaged = (() => { try { parseSetupToken('%%%%'); } catch (err) { return err.message; } return ''; })();
  const empty = (() => { try { parseSetupToken(''); } catch (err) { return err.message; } return ''; })();
  assert.match(pasted, /web address/);
  assert.match(damaged, /does not look like/);
  assert.match(empty, /Paste/);
});

/* ----------------------------------------------------------------- access URL */

test('parseAccessUrl: splits the credentials from the address', () => {
  const access = parseAccessUrl(ACCESS_URL);
  assert.deepEqual(access, ACCESS);
  assert.ok(!access.base.includes(ACCESS_USER) && !access.base.includes(ACCESS_PASS));
  assert.equal(atob(access.auth.slice('Basic '.length)), ACCESS_USER + ':' + ACCESS_PASS);
});

test('parseAccessUrl: trims whitespace and a trailing slash, drops query and fragment', () => {
  assert.deepEqual(parseAccessUrl('  ' + ACCESS_URL + '/\n'), ACCESS);
  assert.equal(parseAccessUrl(ACCESS_URL + '?x=1#y').base, ACCESS.base);
});

test('parseAccessUrl: percent-encoded and non-Latin credentials are sent as their real bytes', () => {
  const access = parseAccessUrl('https://us%40er:p%3Ass%2Fw%C3%B6rd@bridge.simplefin.org/simplefin');
  const bytes = Uint8Array.from(atob(access.auth.slice('Basic '.length)), (c) => c.charCodeAt(0));
  assert.equal(new TextDecoder().decode(bytes), 'us@er:p:ss/wörd');
});

test('parseAccessUrl: an already-split access object comes back unchanged', () => {
  assert.equal(parseAccessUrl(ACCESS), ACCESS);
});

test('parseAccessUrl: rejects what is not an https simplefin.org URL with credentials', () => {
  const bad = [
    '', null, undefined, 7,
    'https://beta-bridge.simplefin.org/simplefin',
    'https://' + ACCESS_USER + '@beta-bridge.simplefin.org/simplefin',
    'http://' + ACCESS_USER + ':' + ACCESS_PASS + '@beta-bridge.simplefin.org/simplefin',
    'https://' + ACCESS_USER + ':' + ACCESS_PASS + '@bridge.example.com/simplefin',
    'https://' + ACCESS_USER + ':' + ACCESS_PASS + '@simplefin.org.example.com/simplefin',
    'not a url',
    {},
    { base: ACCESS.base },
    { base: 'https://bridge.example.com/simplefin', auth: ACCESS.auth },
    { base: 'http://beta-bridge.simplefin.org/simplefin', auth: ACCESS.auth },
    { base: ACCESS_URL, auth: ACCESS.auth },
    { base: ACCESS.base, auth: 'Bearer abc' },
    { base: ACCESS.base, auth: 42 },
  ];
  for (const value of bad) assert.throws(() => parseAccessUrl(value), isFeedError('token'));
});

/* ---------------------------------------------------------------------- claim */

test('claimAccess: POSTs the claim URL with no body and no headers, and returns the split access', async () => {
  const { impl, calls } = fakeFetch(respond(200, ACCESS_URL + '\n'));
  const access = await claimAccess(CLAIM_URL, impl);
  assert.deepEqual(access, ACCESS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLAIM_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers, undefined);
});

test('claimAccess: HTTP 403 means the token was already used', async () => {
  const { impl } = fakeFetch(respond(403, 'Forbidden'));
  await assert.rejects(claimAccess(CLAIM_URL, impl), isFeedError('token'));
});

test('claimAccess: other HTTP failures are server errors that name the status', async () => {
  for (const status of [500, 502, 404, 0]) {
    const { impl } = fakeFetch(respond(status, 'oops'));
    await assert.rejects(claimAccess(CLAIM_URL, impl), (err) => isFeedError('server')(err) && (status === 0 || err.message.includes(String(status))));
  }
});

test('claimAccess: a fetch that throws, or a body that cannot be read, is a network error', async () => {
  const offline = async () => { throw new TypeError('Failed to fetch ' + ACCESS_URL); };
  await assert.rejects(claimAccess(CLAIM_URL, offline), isFeedError('network'));
  const cut = async () => ({ status: 200, ok: true, text: async () => { throw new TypeError('terminated ' + ACCESS_URL); } });
  await assert.rejects(claimAccess(CLAIM_URL, cut), isFeedError('network'));
  await assert.rejects(claimAccess(CLAIM_URL, undefined), isFeedError('network'));
});

test('claimAccess: an answer that is not an access URL is a server error and is not echoed', async () => {
  for (const body of ['<html>maintenance</html>', '', 'https://beta-bridge.simplefin.org/simplefin', 'https://u:p@bridge.example.com/simplefin']) {
    const { impl } = fakeFetch(respond(200, body));
    await assert.rejects(claimAccess(CLAIM_URL, impl), (err) => isFeedError('server')(err) && !err.message.includes('maintenance'));
  }
});

test('claimAccess: never contacts a host that is not SimpleFIN', async () => {
  const { impl, calls } = fakeFetch(respond(200, ACCESS_URL));
  for (const url of ['https://bridge.example.com/claim/x', 'http://beta-bridge.simplefin.org/claim/x', 'nonsense', null, ACCESS_URL]) {
    await assert.rejects(claimAccess(url, impl), isFeedError('token'));
  }
  assert.equal(calls.length, 0);
});

/* ---------------------------------------------------------------------- fetch */

test('fetchSimplefin: builds the request exactly and returns a normalised feed', async () => {
  const { impl, calls } = fakeFetch(respond(200, DEMO_RESPONSE));
  const fromMs = NOW - 30 * DAY_MS - 250;
  const feed = await fetchSimplefin(ACCESS, { fromMs, toMs: NOW + 400, pending: true }, impl, NOW);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://beta-bridge.simplefin.org/simplefin/accounts');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['end-date', 'pending', 'start-date', 'version']);
  assert.equal(url.searchParams.get('version'), '2');
  assert.equal(url.searchParams.get('pending'), '1');
  assert.equal(url.searchParams.get('start-date'), String(Math.floor(fromMs / 1000)));
  assert.equal(url.searchParams.get('end-date'), String(Math.ceil((NOW + 400) / 1000)));
  assert.match(url.searchParams.get('start-date'), /^\d+$/);
  assert.match(url.searchParams.get('end-date'), /^\d+$/);

  const { init } = calls[0];
  assert.equal(init.method, 'GET');
  assert.deepEqual(init.headers, { Authorization: ACCESS.auth });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.body, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);

  assert.equal(feed.src, 'simplefin');
  assert.equal(feed.fetchedAt, NOW);
  assert.equal(feed.fromMs, fromMs);
  assert.equal(feed.toMs, NOW + 400);
  assert.equal(feed.accounts.length, 3);
  assert.ok(!JSON.stringify(feed).includes(ACCESS_PASS) && !JSON.stringify(feed).includes(ACCESS.auth), 'the credential is not in the result');
});

test('fetchSimplefin: accepts the access URL itself and never puts its credentials in the address', async () => {
  const { impl, calls } = fakeFetch(respond(200, { accounts: [] }));
  await fetchSimplefin(ACCESS_URL, { fromMs: NOW - DAY_MS, toMs: NOW }, impl, NOW);
  assert.ok(!calls[0].url.includes(ACCESS_USER) && !calls[0].url.includes(ACCESS_PASS));
  assert.equal(calls[0].init.headers.Authorization, ACCESS.auth);
});

test('fetchSimplefin: a window longer than the limit is clamped to its most recent 89 days (a day inside the 90-day limit)', async () => {
  const { impl, calls } = fakeFetch(respond(200, { accounts: [] }));
  const feed = await fetchSimplefin(ACCESS, { fromMs: NOW - 400 * DAY_MS, toMs: NOW }, impl, NOW);
  const params = new URL(calls[0].url).searchParams;
  assert.equal(Number(params.get('end-date')) - Number(params.get('start-date')), (FEED_WINDOW_DAYS - 1) * 86400);
  assert.equal(feed.fromMs, NOW - (FEED_WINDOW_DAYS - 1) * DAY_MS);
  assert.equal(feed.toMs, NOW);
});

test('fetchSimplefin: missing or inverted window bounds still give a valid request', async () => {
  const { impl, calls } = fakeFetch(respond(200, { accounts: [] }));
  await fetchSimplefin(ACCESS, {}, impl, NOW);
  await fetchSimplefin(ACCESS, { fromMs: NOW + DAY_MS, toMs: NOW }, impl, NOW);
  await fetchSimplefin(ACCESS, null, impl, NOW);
  for (const call of calls) {
    const params = new URL(call.url).searchParams;
    const start = Number(params.get('start-date'));
    const end = Number(params.get('end-date'));
    assert.ok(Number.isInteger(start) && Number.isInteger(end) && start <= end && end - start <= FEED_WINDOW_DAYS * 86400);
  }
  assert.equal(new URL(calls[0].url).searchParams.get('end-date'), String(Math.ceil(NOW / 1000)));
});

test('fetchSimplefin: pending can be left out', async () => {
  const { impl, calls } = fakeFetch(respond(200, { accounts: [] }));
  await fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW, pending: false }, impl, NOW);
  assert.equal(new URL(calls[0].url).searchParams.has('pending'), false);
  await fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, impl, NOW);
  assert.equal(new URL(calls[1].url).searchParams.get('pending'), '1');
});

test('fetchSimplefin: HTTP failures map to their codes', async () => {
  const expected = { 403: 'relink', 401: 'relink', 402: 'payment', 429: 'rate', 500: 'server', 503: 'server', 404: 'server', 302: 'server' };
  for (const [status, code] of Object.entries(expected)) {
    const { impl } = fakeFetch(respond(Number(status), 'denied for ' + ACCESS_URL));
    await assert.rejects(fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, impl, NOW), isFeedError(code), 'HTTP ' + status);
  }
  const { impl } = fakeFetch(respond(503, 'down'));
  await assert.rejects(fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, impl, NOW), /503/);
});

test('fetchSimplefin: a fetch that throws or a body cut short is a network error', async () => {
  const offline = async (url) => { throw new TypeError('Failed to fetch ' + url); };
  await assert.rejects(fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, offline, NOW), isFeedError('network'));
  const cut = async () => ({ status: 200, ok: true, text: async () => { throw new TypeError('terminated'); } });
  await assert.rejects(fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, cut, NOW), isFeedError('network'));
  await assert.rejects(fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, null, NOW), isFeedError('network'));
});

test('fetchSimplefin: an answer that is not a JSON object is a server error', async () => {
  for (const body of ['<html>busy</html>', '', '[1,2]', '"text"', 'null', '{"accounts":']) {
    const { impl } = fakeFetch(respond(200, body));
    await assert.rejects(fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, impl, NOW), isFeedError('server'), body);
  }
});

test('fetchSimplefin: an unusable stored link asks for a new one without any request', async () => {
  const { impl, calls } = fakeFetch(respond(200, { accounts: [] }));
  for (const access of [null, {}, 'https://beta-bridge.simplefin.org/simplefin', { base: 'https://bridge.example.com/x', auth: ACCESS.auth }]) {
    await assert.rejects(fetchSimplefin(access, { fromMs: NOW - DAY_MS, toMs: NOW }, impl, NOW), isFeedError('relink'));
  }
  assert.equal(calls.length, 0);
});

test('fetchSimplefin: gives up after 30 seconds and aborts the request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal = null;
  const hanging = (url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  };
  const pending = fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, hanging, NOW);
  t.mock.timers.tick(FEED_TIMEOUT_MS - 1);
  assert.equal(signal.aborted, false, 'still waiting just before the limit');
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, (err) => isFeedError('network')(err) && /30 seconds/.test(err.message));
});

test('fetchSimplefin: times out even when the fetch ignores the abort signal, or stalls in the body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deaf = () => new Promise(() => {});
  const first = fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, deaf, NOW);
  t.mock.timers.tick(FEED_TIMEOUT_MS);
  await assert.rejects(first, isFeedError('network'));

  const stalledBody = async () => ({ status: 200, ok: true, text: () => new Promise(() => {}) });
  const second = fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, stalledBody, NOW);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(FEED_TIMEOUT_MS);
  await assert.rejects(second, isFeedError('network'));
});

test('fetchSimplefin: the timer is cleared once the answer is in', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { impl, calls } = fakeFetch(respond(200, { accounts: [] }));
  await fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, impl, NOW);
  t.mock.timers.tick(FEED_TIMEOUT_MS * 2);
  assert.equal(calls[0].init.signal.aborted, false);

  const failing = fakeFetch(respond(500, 'no'));
  await assert.rejects(fetchSimplefin(ACCESS, { fromMs: NOW - DAY_MS, toMs: NOW }, failing.impl, NOW), isFeedError('server'));
  t.mock.timers.tick(FEED_TIMEOUT_MS * 2);
  assert.equal(failing.calls[0].init.signal.aborted, false);
});

/* -------------------------------------------------------------- normalisation */

test('normalizeSimplefin: the demo account answer', () => {
  const feed = normalizeSimplefin(DEMO_RESPONSE, META);
  assert.equal(feed.src, 'simplefin');
  assert.equal(feed.fetchedAt, NOW);
  assert.equal(feed.fromMs, META.fromMs);
  assert.equal(feed.toMs, NOW);
  assert.deepEqual(feed.errors, [], 'x-api-message is advice, not a problem');
  assert.deepEqual(feed.accounts.map((a) => a.extId), ['Demo Savings', 'Demo Checking', 'Demo Empty Account']);

  const [savings, checking, empty] = feed.accounts;
  assert.deepEqual({ ...savings, txs: undefined }, {
    extId: 'Demo Savings', connId: 'CON-SIMPLEFIN-DEMO', institution: 'SimpleFIN Demo', name: 'SimpleFIN Savings', currency: 'USD',
    balance: 11398551, available: 11398551, asOf: 1794441600 * 1000, txs: undefined,
  });
  assert.equal(checking.balance, 2411991);
  assert.equal(empty.balance, 0);
  assert.deepEqual(empty.txs, []);
  assert.deepEqual(checking.txs.map((t) => t.amount), [-7220, -11112, -7885]);
  assert.deepEqual(savings.txs[0], {
    extId: '1794384000', amount: -5550, posted: 1794384000, at: 1794384000, pending: false,
    description: 'Fishing bait', payee: "John's Fishin Shack", memo: 'JOHNS FISHIN SHACK BAIT', mcc: '5812',
  });
  assert.equal(savings.txs[0].extId, checking.txs[0].extId, 'transaction ids repeat across accounts in the real feed');
});

test('normalizeSimplefin: amounts become integer cents with no floating-point error', () => {
  const amounts = ['0.10', '0.20', '0.30', '-0.07', '19.99', '-1234.56', '1,234.56', '105884.8', '7', '-4.755', '+3.00', 12.5, -0.29, '1.005', '4.35', '-8.2', '$5.00'];
  const expected = [10, 20, 30, -7, 1999, -123456, 123456, 10588480, 700, -476, 300, 1250, -29, 101, 435, -820, 500];
  const feed = normalizeSimplefin({
    accounts: [{ id: 'a', name: 'Checking', balance: '0.29', 'balance-date': 1794441600, transactions: amounts.map((amount, i) => ({ id: String(i), posted: 1794384000, amount })) }],
  }, META);
  assert.deepEqual(feed.accounts[0].txs.map((t) => t.amount), expected);
  assert.equal(feed.accounts[0].balance, 29);
  for (const tx of feed.accounts[0].txs) assert.ok(Number.isSafeInteger(tx.amount));
});

test('normalizeSimplefin: pending rows', () => {
  const feed = normalizeSimplefin({
    accounts: [{
      id: 'a', name: 'Card', balance: '-10.00', 'balance-date': 1794441600,
      transactions: [
        { id: 'p1', posted: 0, amount: '-4.75', description: 'DUNKIN', transacted_at: 1794400000, pending: true },
        { id: 'p2', posted: 0, amount: '-9.00', description: 'DELI' },
        { id: 'p3', posted: 1794384000, amount: '-3.00', description: 'HOLD', pending: true },
        { id: 'p4', amount: '-2.00', description: 'NO DATES', pending: false },
        { id: 'p5', posted: 1794384000, amount: '-1.00', description: 'POSTED', pending: false },
      ],
    }],
  }, META);
  const rows = Object.fromEntries(feed.accounts[0].txs.map((t) => [t.extId, t]));
  assert.deepEqual([rows.p1.pending, rows.p1.posted, rows.p1.at], [true, null, 1794400000]);
  assert.deepEqual([rows.p2.pending, rows.p2.posted, rows.p2.at], [true, null, null], 'posted 0 means pending');
  assert.deepEqual([rows.p3.pending, rows.p3.posted, rows.p3.at], [true, null, 1794384000], 'a pending row keeps its authorisation date as the day it happened');
  assert.deepEqual([rows.p4.pending, rows.p4.posted, rows.p4.at], [true, null, null]);
  assert.deepEqual([rows.p5.pending, rows.p5.posted, rows.p5.at], [false, 1794384000, null]);
});

test('normalizeSimplefin: the older response shape (org on the account, errors as strings)', () => {
  const feed = normalizeSimplefin({
    errors: ['Connection to Example Credit Union may need attention', '  ', 7],
    accounts: [
      { org: { domain: 'examplecu.example', name: 'Example Credit Union', 'sfin-url': 'https://bridge.simplefin.org/simplefin' }, id: 'ACT-1', name: 'Share Draft', currency: 'USD', balance: '100.00', 'balance-date': 1794441600, transactions: [] },
      { org: { domain: 'nameless.example' }, id: 'ACT-2', name: 'Visa', currency: 'USD', balance: '-20.00', 'balance-date': 1794441600 },
      { org: { id: 'ORG-9', name: 'Third Bank' }, id: 'ACT-3', name: 'Savings', balance: '5', 'balance-date': 1794441600 },
    ],
  }, META);
  assert.deepEqual(feed.errors, [{ code: '', message: 'Connection to Example Credit Union may need attention', connId: '', accountId: '' }]);
  assert.deepEqual(feed.accounts.map((a) => [a.connId, a.institution]), [
    ['examplecu.example', 'Example Credit Union'], ['nameless.example', 'nameless.example'], ['ORG-9', 'Third Bank'],
  ]);
  assert.deepEqual(feed.accounts[1].txs, []);
  assert.equal(feed.accounts[2].currency, '');
});

test('normalizeSimplefin: errlist entries keep their code, connection and account', () => {
  const feed = normalizeSimplefin({
    errlist: [
      { code: 'con.auth', msg: 'Sign in to  Example Bank\nagain', conn_id: 'CON-1' },
      { code: 'act.missingdata', msg: 'Transactions unavailable', conn_id: 'CON-1', account_id: 'ACT-1' },
      { code: 'con.auth', msg: 'Sign in to  Example Bank\nagain', conn_id: 'CON-1' },
      { code: 'gen.only_code' },
      { message: 'alternate key' },
      'a bare string',
      {}, null, 5, { msg: 12 },
    ],
    accounts: [],
  }, META);
  assert.deepEqual(feed.errors, [
    { code: 'con.auth', message: 'Sign in to Example Bank again', connId: 'CON-1', accountId: '' },
    { code: 'act.missingdata', message: 'Transactions unavailable', connId: 'CON-1', accountId: 'ACT-1' },
    { code: 'gen.only_code', message: 'gen.only_code', connId: '', accountId: '' },
    { code: '', message: 'alternate key', connId: '', accountId: '' },
    { code: '', message: 'a bare string', connId: '', accountId: '' },
  ]);
});

test('normalizeSimplefin: the connection name falls back to the organisation name', () => {
  const feed = normalizeSimplefin({
    accounts: [
      { id: 'a', name: 'One', balance: '1', conn_id: 'C1' },
      { id: 'b', name: 'Two', balance: '1', conn_id: 'C2' },
      { id: 'c', name: 'Three', balance: '1', conn_id: 'C-unknown' },
      { id: 'd', name: 'Four', balance: '1' },
    ],
    connections: [{ conn_id: 'C1', name: '', org_name: 'Org Only' }, { conn_id: 'C2', name: 'Named', org_name: 'Org' }, null, 'x', { name: 'no id' }],
  }, META);
  assert.deepEqual(feed.accounts.map((a) => [a.connId, a.institution]), [['C1', 'Org Only'], ['C2', 'Named'], ['C-unknown', ''], ['', '']]);
});

test('normalizeSimplefin: malformed accounts and rows are skipped, never thrown on, never NaN', () => {
  const feed = normalizeSimplefin({
    accounts: [
      null, 'text', 42, [], {},
      { id: '', name: 'No id', balance: '1.00' },
      { id: 'no-balance', name: 'No balance' },
      { id: 'bad-balance', name: 'Bad balance', balance: 'twelve' },
      { id: 'nan-balance', name: 'NaN balance', balance: NaN },
      { id: 'huge', name: 'Too large', balance: '99999999999999999999.00' },
      {
        id: 'ok', name: 42, currency: null, balance: '50.00', 'available-balance': 'n/a', 'balance-date': 'soon', conn_id: 99,
        transactions: [
          null, 'row', 7, [],
          { id: 't0' },
          { id: 't1', posted: 1794384000, amount: 'abc' },
          { id: 't2', posted: 1794384000, amount: '' },
          { id: 't3', posted: 1794384000, amount: null },
          { id: 't4', posted: 1794384000, amount: Infinity },
          { id: 't5', posted: 1794384000, amount: { cents: 5 } },
          { id: 't6', posted: 'yesterday', amount: '-1.00' },
          { id: 't7', posted: -5, amount: '-2.00', transacted_at: NaN },
          { id: 88, posted: '1794384000', amount: '-3.00', description: 77, payee: null, memo: {}, mcc: 5812 },
          { posted: 1794384000000, amount: '-4.00', description: 'x'.repeat(2000), mcc: '58123' },
          { id: 't9', posted: 1794384000.9, amount: '0.00', mcc: ' 0742 ' },
        ],
      },
      { id: 'ok', name: 'Duplicate id', balance: '1.00' },
      { id: 'no-list', name: 'Transactions not a list', balance: '2.00', transactions: { a: 1 } },
    ],
    connections: 'none',
    errlist: 'none',
  }, META);

  assert.deepEqual(feed.accounts.map((a) => a.extId), ['ok', 'no-list']);
  const [ok, noList] = feed.accounts;
  assert.equal(ok.name, '42');
  assert.equal(ok.currency, '');
  assert.equal(ok.available, null);
  assert.equal(ok.asOf, NOW, 'an unreadable balance date falls back to the fetch time');
  assert.equal(ok.connId, '99');
  assert.deepEqual(noList.txs, []);
  assert.deepEqual(feed.errors, []);

  assert.deepEqual(ok.txs.map((t) => t.extId), ['t6', 't7', '88', '', 't9']);
  const [t6, t7, t88, noId, t9] = ok.txs;
  assert.deepEqual([t6.pending, t6.posted, t6.at], [true, null, null]);
  assert.deepEqual([t7.pending, t7.posted, t7.at], [true, null, null]);
  assert.deepEqual(t88, { extId: '88', amount: -300, posted: 1794384000, at: null, pending: false, description: '77', payee: '', memo: '', mcc: '5812' });
  assert.equal(noId.posted, 1794384000, 'a millisecond timestamp is read as milliseconds');
  assert.equal(noId.description.length, 500);
  assert.equal(noId.mcc, null);
  assert.deepEqual([t9.amount, t9.posted, t9.mcc], [0, 1794384000, '0742']);

  for (const account of feed.accounts) {
    assert.ok(Number.isSafeInteger(account.balance) && Number.isFinite(account.asOf));
    for (const tx of account.txs) {
      assert.ok(Number.isSafeInteger(tx.amount));
      assert.ok(tx.posted === null || Number.isInteger(tx.posted));
      assert.ok(tx.at === null || Number.isInteger(tx.at));
      for (const key of ['extId', 'description', 'payee', 'memo']) assert.equal(typeof tx[key], 'string');
    }
  }
});

test('normalizeSimplefin: nothing usable in, an empty feed out', () => {
  for (const json of [null, undefined, 'text', 7, [], {}, { accounts: null }, { accounts: {} }]) {
    const feed = normalizeSimplefin(json, META);
    assert.deepEqual(feed, { src: 'simplefin', fetchedAt: NOW, fromMs: META.fromMs, toMs: NOW, accounts: [], errors: [] });
  }
  assert.deepEqual(normalizeSimplefin({}, undefined), { src: 'simplefin', fetchedAt: 0, fromMs: 0, toMs: 0, accounts: [], errors: [] });
});

test('normalizeSimplefin: bank text is carried as data, untouched', () => {
  const hostile = '<img src=x onerror=alert(1)> ${7*7} "; DROP TABLE';
  const feed = normalizeSimplefin({ accounts: [{ id: 'a', name: hostile, balance: '1', transactions: [{ id: 't', posted: 1794384000, amount: '-1', description: hostile, payee: hostile, memo: hostile }] }] }, META);
  assert.equal(feed.accounts[0].name, hostile);
  assert.deepEqual([feed.accounts[0].txs[0].description, feed.accounts[0].txs[0].payee, feed.accounts[0].txs[0].memo], [hostile, hostile, hostile]);
});

/* ---------------------------------------------------------------- sync windows */

function bankTx(fields) {
  return makeTx({ source: 'bank', accountId: 'acc_1', amount: 500, ...fields });
}

function syncedState(txs) {
  const state = defaultState(NOW - 100 * DAY_MS);
  state.sync.lastOk = NOW - 5 * HOUR_MS;
  state.txs = txs;
  return state;
}

test('syncWindows: never synced asks for two windows of 89 days, the older first', () => {
  const windows = syncWindows(defaultState(NOW), NOW);
  assert.deepEqual(windows, [
    { fromMs: NOW - 178 * DAY_MS, toMs: NOW - 89 * DAY_MS },
    { fromMs: NOW - 89 * DAY_MS, toMs: NOW },
  ]);
  for (const w of windows) assert.ok(w.toMs - w.fromMs <= FEED_WINDOW_DAYS * DAY_MS);
});

test('syncWindows: later syncs start 7 days before the newest posted bank row', () => {
  const state = syncedState([
    bankTx({ day: '2026-11-01', postedDay: '2026-11-02' }),
    bankTx({ day: '2026-11-07', postedDay: '2026-11-08' }),
    bankTx({ day: '2026-10-20', postedDay: '2026-10-21' }),
  ]);
  assert.deepEqual(syncWindows(state, NOW), [{ fromMs: startOfDayMs('2026-11-01'), toMs: NOW }]);
});

test('syncWindows: manual moves, demo rows and unreadable rows do not move the window', () => {
  const state = syncedState([
    bankTx({ day: '2026-10-20', postedDay: '2026-10-21' }),
    makeTx({ source: 'manual', day: '2026-11-10', postedDay: null }),
    makeTx({ source: 'demo', day: '2026-11-10', postedDay: '2026-11-10' }),
    bankTx({ day: 'soon', postedDay: 'whenever' }),
    null,
    'row',
  ]);
  assert.deepEqual(syncWindows(state, NOW), [{ fromMs: startOfDayMs('2026-10-14'), toMs: NOW }]);
});

test('syncWindows: never more than 89 days back', () => {
  const old = syncedState([bankTx({ day: '2026-03-01', postedDay: '2026-03-02' })]);
  assert.deepEqual(syncWindows(old, NOW), [{ fromMs: NOW - 89 * DAY_MS, toMs: NOW }]);
  const empty = syncedState([]);
  assert.deepEqual(syncWindows(empty, NOW), [{ fromMs: NOW - 89 * DAY_MS, toMs: NOW }], 'synced before, nothing stored: one window');
});

test('syncWindows: reaches back far enough to learn what became of an old pending row', () => {
  const state = syncedState([
    bankTx({ day: '2026-11-09', postedDay: '2026-11-10' }),
    bankTx({ day: '2026-10-25', postedDay: null, pending: true }),
  ]);
  assert.deepEqual(syncWindows(state, NOW), [{ fromMs: startOfDayMs('2026-10-23'), toMs: NOW }]);

  const onlyPending = syncedState([bankTx({ day: '2026-11-10', postedDay: null, pending: true })]);
  assert.deepEqual(syncWindows(onlyPending, NOW), [{ fromMs: NOW - 7 * DAY_MS, toMs: NOW }], 'and always at least a week');
});

test('syncWindows: a row dated in the future still leaves a week of overlap', () => {
  const state = syncedState([bankTx({ day: '2026-11-20', postedDay: '2026-11-20' })]);
  assert.deepEqual(syncWindows(state, NOW), [{ fromMs: NOW - 7 * DAY_MS, toMs: NOW }]);
});

test('syncWindows: tolerates a damaged document', () => {
  for (const state of [null, undefined, {}, { sync: null }, { sync: { lastOk: 'yes' }, txs: 'none' }]) {
    const windows = syncWindows(state, NOW);
    assert.equal(windows.length, 2);
    for (const w of windows) assert.ok(Number.isFinite(w.fromMs) && Number.isFinite(w.toMs) && w.fromMs < w.toMs);
  }
  assert.equal(syncWindows({ sync: { lastOk: NOW }, txs: 'none' }, NOW).length, 1);
});

/* ---------------------------------------------------------------------- quota */

test('quotaAllows: automatic sync runs when never synced or when the last success is over 3 hours old', () => {
  assert.deepEqual(quotaAllows([], null, NOW), { ok: true, waitMs: 0, reason: '' });
  assert.deepEqual(quotaAllows([], NOW - QUOTA.autoEveryMs, NOW, {}), { ok: true, waitMs: 0, reason: '' });
  assert.deepEqual(quotaAllows([], NOW - QUOTA.autoEveryMs - 1, NOW, { manual: false }), { ok: true, waitMs: 0, reason: '' });
  assert.deepEqual(quotaAllows([NOW - HOUR_MS], NOW - HOUR_MS, NOW), { ok: false, waitMs: 2 * HOUR_MS, reason: 'fresh' });
  assert.deepEqual(quotaAllows([NOW - 1000], null, NOW), { ok: true, waitMs: 0, reason: '' }, 'a failed attempt does not make the data fresh');
});

test('quotaAllows: a manual refresh is allowed 15 minutes after the last request', () => {
  assert.deepEqual(quotaAllows([], NOW - 1000, NOW, { manual: true }), { ok: true, waitMs: 0, reason: '' }, 'fresh data does not block the owner');
  assert.deepEqual(quotaAllows([NOW - 5 * 60000], NOW - 5 * 60000, NOW, { manual: true }), { ok: false, waitMs: 10 * 60000, reason: 'cooldown' });
  assert.deepEqual(quotaAllows([NOW - 2 * HOUR_MS, NOW - QUOTA.manualEveryMs], NOW, NOW, { manual: true }), { ok: true, waitMs: 0, reason: '' });
  assert.deepEqual(quotaAllows([NOW - 60000, NOW - 2 * HOUR_MS], null, NOW, { manual: true }).reason, 'cooldown', 'order of the list does not matter');
});

test('quotaAllows: never more than 20 requests in any 24 hours, counting the ones about to be made', () => {
  const spaced = (count) => Array.from({ length: count }, (unused, i) => NOW - (i + 1) * HOUR_MS);
  assert.equal(quotaAllows(spaced(19), null, NOW, { needed: 1 }).ok, true);
  assert.deepEqual(quotaAllows(spaced(19), null, NOW, { needed: 2 }), { ok: false, waitMs: 5 * HOUR_MS, reason: 'quota' });
  assert.deepEqual(quotaAllows(spaced(20), null, NOW, { manual: true }), { ok: false, waitMs: 4 * HOUR_MS, reason: 'quota' });
  assert.deepEqual(quotaAllows(spaced(20), null, NOW, { manual: true, needed: 2 }), { ok: false, waitMs: 5 * HOUR_MS, reason: 'quota' });
  assert.equal(quotaAllows(spaced(18), null, NOW, { needed: 2 }).ok, true);

  const yesterday = Array.from({ length: 30 }, (unused, i) => NOW - DAY_MS - i * 1000);
  assert.equal(quotaAllows(yesterday, null, NOW, { needed: 2 }).ok, true, 'requests older than a day no longer count');
  assert.deepEqual(quotaAllows([], null, NOW, { needed: 25 }), { ok: false, waitMs: DAY_MS, reason: 'quota' });
});

test('quotaAllows: when two limits apply the longer wait is reported', () => {
  const busy = Array.from({ length: 20 }, (unused, i) => NOW - 20 * HOUR_MS - i * 1000);
  assert.deepEqual(quotaAllows(busy, NOW - HOUR_MS, NOW), { ok: false, waitMs: 4 * HOUR_MS - 19000, reason: 'quota' });
  const burst = Array.from({ length: 20 }, (unused, i) => NOW - 23 * HOUR_MS - 59 * 60000 - i);
  const result = quotaAllows([...burst, NOW - 60000], null, NOW, { manual: true });
  assert.equal(result.reason, 'cooldown');
  assert.equal(result.waitMs, 14 * 60000);
});

test('quotaAllows: tolerates a damaged request log', () => {
  assert.deepEqual(quotaAllows(null, null, NOW), { ok: true, waitMs: 0, reason: '' });
  assert.deepEqual(quotaAllows(['x', NaN, null, NOW + HOUR_MS], undefined, NOW, { manual: true, needed: 'two' }), { ok: true, waitMs: 0, reason: '' });
  const result = quotaAllows([NOW - 1000], NaN, NOW, null);
  assert.ok(result.ok && Number.isFinite(result.waitMs));
});

test('normalizeSimplefin: the provider\'s notice about a capped date range is not a problem with the bank link', () => {
  const feed = normalizeSimplefin({
    errlist: [
      { code: 'gen.api', msg: 'Requested date range exceeds limit of 90 days and was capped.' },
      { code: 'con.auth', msg: 'Connection to Example Bank may need attention', conn_id: 'CON-1' },
    ],
    accounts: [],
  }, { fetchedAt: NOW, fromMs: NOW - DAY_MS, toMs: NOW });
  assert.deepEqual(feed.errors.map((e) => e.code), ['con.auth']);
});

test('claimAccess: a claim that never answers gives up after 30 seconds and says so', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal = null;
  const impl = (url, init) => { signal = init.signal; return new Promise(() => {}); };
  const pending = claimAccess(CLAIM_URL, impl);
  const outcome = assert.rejects(pending, (err) => err instanceof FeedError && err.code === 'network' && /30 seconds/.test(err.message));
  t.mock.timers.tick(FEED_TIMEOUT_MS);
  await outcome;
  assert.equal(signal.aborted, true);
});

test('claimAccess: a body that never arrives is bounded by the same 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const impl = async () => ({ status: 200, text: () => new Promise(() => {}) });
  const outcome = assert.rejects(claimAccess(CLAIM_URL, impl), (err) => err instanceof FeedError && err.code === 'network');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(FEED_TIMEOUT_MS);
  await outcome;
});

test('claimAccess: gives up after 30 seconds and aborts the request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal = null;
  const hanging = (url, init) => {
    signal = init.signal;
    return new Promise(() => {}); // never answers, ignores the abort
  };
  const pending = claimAccess(CLAIM_URL, hanging);
  await Promise.resolve();
  t.mock.timers.tick(FEED_TIMEOUT_MS - 1);
  assert.equal(signal.aborted, false, 'still waiting just before the limit');
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, isFeedError('network'));
});
