/**
 * Card purchases within minutes: the alert parser, the inbox transport against a fake GitHub, and the
 * whole path on three devices sharing one inbox. Every alert, bank, merchant, owner and key here is
 * invented; no request leaves the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ALERT_KEEP_DAYS, addAlertMove, alertFile, alertStatus, cardFor, parseAlert, roundAlerts } from '../js/model/alerts.js';
import { ALERT_REMOVED_DAYS, addProvisional, mergeFeed, removeManual } from '../js/model/merge.js';
import { recentTransactions } from '../js/model/recent.js';
import { checkDoc, defaultState } from '../js/model/schema.js';
import { position, spendingByCategory } from '../js/model/ledger.js';
import { ShareError, deleteInboxFile, fromBase64, inboxUrl, listInbox, readInboxFile, toBase64 } from '../js/github.js';

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const NOW = new Date(2026, 10, 11, 15, 30).getTime();
const OWNER = 'someone';
const KEY = 'invented_key_for_tests_0123456789';
const SHA = (n) => n.toString(16).padStart(40, '0');

/* ------------------------------------------------------------------ the parser */

const PURCHASES = [
  ['Northlight Bank: A $12.34 transaction was made at CORNER DELI on card ending in 4321.', 1234, 'CORNER DELI', '4321'],
  ['Harbor Union Alert: Your card ending in 9876 was charged $5.00 at JOE\'S COFFEE CART.', 500, 'JOE\'S COFFEE CART', '9876'],
  ['You made a $1,234.56 purchase at Lumen Electronics on your credit card ending in 1111', 123456, 'Lumen Electronics', '1111'],
  ['Pinecrest CU: $8.99 spent at STREAMBOX DIGITAL, card ending 2222. Txt STOP to end.', 899, 'STREAMBOX DIGITAL', '2222'],
  ['Purchase of $43.10 at Greenleaf Market on 11/11 with card ending in 3333', 4310, 'Greenleaf Market', '3333'],
  ['Card ending in 4444 used for $2.50 at 3:45 PM at CITY TRANSIT KIOSK.', 250, 'CITY TRANSIT KIOSK', '4444'],
  ['Meridian: a charge of $19.00 was authorized at BLUE OX HARDWARE', 1900, 'BLUE OX HARDWARE', null],
  ['A $0.01 transaction was made on your credit card ending in 5555.', 1, 'Card purchase', '5555'],
  ['Transaction alert: $66.00 at "Orchard Pharmacy #12" on card ending in 6666', 6600, 'Orchard Pharmacy #12', '6666'],
  ['Your Credit Card purchase of $15.75 at QUICKMART 42 was approved.', 1575, 'QUICKMART 42', null],
  ['Northlight Bank: You made a $12.34 transaction with CORNER DELI on Nov 11, 2026 at 3:45 PM ET.', 1234, 'CORNER DELI', null],
  ['A $7.10 charge at KIOSK NINE has been authorized on card ending in 4321.', 710, 'KIOSK NINE', '4321'],
  ['Harbor Union: card ending 51004 used for $8.47 at LUMEN LAMPS on 11/11.', 847, 'LUMEN LAMPS', '1004'],
  // boilerplate is cut before anything is refused
  ['A purchase of $8.47 was made at CORNER DELI on card ending in 4321. Reply STOP to opt out.', 847, 'CORNER DELI', '4321'],
  ['Card ending 4321: $8.47 purchase at CORNER DELI. Msg&data rates may apply. Reply HELP for help.', 847, 'CORNER DELI', '4321'],
  ['A $8.47 transaction at CORNER DELI was made on your card ending in 4321. Not you? Report fraud at 800-555-0100.', 847, 'CORNER DELI', '4321'],
  ['Purchase alert: $8.47 at CORNER DELI on card ending 4321. Available credit: $4,000.00', 847, 'CORNER DELI', '4321'],
  ['A $8.47 charge at CORNER DELI on card ending in 4321 exceeded your alert limit of $0.00.', 847, 'CORNER DELI', '4321'],
  ['A $8.47 charge at CORNER DELI on card ending in 4321 is more than the $0.00 amount you set.', 847, 'CORNER DELI', '4321'],
  ['Transaction: $8.47 at CORNER DELI, card ending in 4321. To stop these alerts, reply STOP.', 847, 'CORNER DELI', '4321'],
  ['Credit card ending 4321: $8.47 at CORNER DELI. Security tip: we never ask for your PIN.', 847, 'CORNER DELI', '4321'],
  ['$100,000.00 purchase at Big Ticket Auctions, card ending in 7777', 10000000, 'Big Ticket Auctions', '7777'],
  ['Elmwood Card: $3.20 charged at AMZN.MKTP US on card ending 8888.', 320, 'AMZN.MKTP US', '8888'],
  ['A $9.00 transaction was made at ' + 'X'.repeat(90) + ' on card ending in 1212.', 900, 'X'.repeat(60), '1212'],
];

test('a purchase alert is read: amount in cents, merchant, last 4 digits', () => {
  for (const [text, amount, merchant, last4] of PURCHASES) {
    assert.deepEqual(parseAlert(text), { amount, merchant, last4 }, text);
  }
});

const REFUSED = [
  'Northlight Bank: Your security code is 482913. Do not share it.',
  'Your one-time passcode is 1234. A $0.00 hold may appear.',
  'Use verification code 7781 to approve the $25.00 purchase at CORNER DELI.',
  'Harbor Union: New sign-in from a new device. If this was not you, call us.',
  'You signed in to online banking at 9:02 AM.',
  'Pinecrest CU: Your payment of $250.00 was received. Thank you.',
  'Thank you for your payment of $80.00 on card ending in 4321.',
  'A credit of $12.34 from CORNER DELI was posted to card ending in 4321.',
  'Refund: $12.34 from CORNER DELI on card ending in 4321.',
  'A $40.00 deposit was made to your account ending in 4321.',
  'Your $55.00 transaction at Lumen Electronics was declined.',
  'Purchase of $55.00 at Lumen Electronics was denied on card ending in 4321.',
  'Your balance of $1,204.33 is due on 11/25. Minimum payment $35.00.',
  'Reminder: your statement is ready. Amount due $412.00.',
  'Your available balance is $310.00 after a $12.34 purchase at CORNER DELI.',
  'Did you make a $500.00 purchase at Lumen Electronics? Reply YES or NO.',
  'Suspicious charge of $999.00 at Unknown Merchant on card ending in 4321.',
  'Transfer of $100.00 to savings completed.',
  'A $12.34 transaction was made at CORNER DELI and $5.00 at JOE\'S COFFEE.',
  'A transaction was made at CORNER DELI on card ending in 4321.',
  'A $12 transaction was made at CORNER DELI.',
  'A $0.00 transaction was made at CORNER DELI.',
  'A $100,000.01 purchase at Big Ticket Auctions.',
  'A $1,000,000.00 purchase at Big Ticket Auctions.',
  'A -$12.34 transaction was made at CORNER DELI.',
  '<b>A $12.34 transaction</b> was made at <script>CORNER DELI</script>',
  'A $12.34 transaction was made at CORNER &amp; DELI',
  '{"amount": "$12.34", "purchase": true}',
  'Hello! Lunch tomorrow? I owe you $12.34 for the purchase.'.replace('purchase', 'thing'),
  'Cash back reward of $5.00 posted to card ending in 4321 after a purchase.',
  'ATM withdrawal of $60.00 on card ending in 4321.',
  // approval and confirmation codes in any wording; bare digits are a code
  'Use 552211 to approve your $45.00 purchase at CORNER DELI',
  'Enter 552211 to confirm the $45.00 transaction at CORNER DELI',
  'Northlight Bank: 552211 is for your $45.00 purchase at CORNER DELI. Do not share.',
  'Authorization number 7788 for $20.00 purchase at CORNER DELI',
  'Your token 998877 authorizes the $30.00 charge',
  // not a completed purchase
  'Your $25.00 transaction at CORNER DELI was voided',
  'Your $25.00 transaction at CORNER DELI was canceled',
  'Your $25.00 purchase at CORNER DELI was not authorized',
  'Transaction of $25.00 at CORNER DELI could not be completed',
  'Your $25.00 purchase at CORNER DELI was rejected',
  'Your $25.00 purchase at CORNER DELI was flagged',
  'Card locked: $25.00 transaction at CORNER DELI stopped',
  'Pre-authorization hold of $1.00 at KIOSK NINE',
  'A $100.00 charge from LAKESIDE INN is held on card ending in 4321',
  'Upcoming charge: $15.99 from STREAMBOX renews tomorrow',
  'Scheduled charge of $15.99 at STREAMBOX on 11/20',
  'Your STREAMBOX renewal: $15.99 will be charged on card ending in 4321',
  'Money received: $50.00 transaction from a friend',
  'Is this you? $500.00 purchase at Lumen Electronics. Text Y or N',
  'Confirm: $500.00 purchase at Lumen Electronics. Text 1 if you made it, 2 if not',
  'Possible unauthorized $500.00 transaction at Lumen Electronics',
  'Interest charge of $12.00 on card ending in 4321',
  'Annual fee of $95.00 charged to card ending 4321',
  'Your card was added to a wallet. A $1.00 temporary charge may appear',
  // boilerplate does not hide a refusal
  'Your $25.00 purchase at CORNER DELI was declined. Reply STOP to opt out.',
  '',
  'no money here at all',
  '$$$$',
];

test('anything that is not plainly a purchase or a charge is refused', () => {
  for (const text of REFUSED) assert.equal(parseAlert(text), null, text);
  assert.equal(parseAlert(null), null);
  assert.equal(parseAlert(42), null);
  assert.equal(parseAlert('A $1.00 purchase at X. ' + 'y'.repeat(2100)), null, 'too long to be an alert');
});

test('a bare run of 4 to 8 digits is a code, unless it is the card\'s, the amount, a phone number, a date or a time', () => {
  assert.equal(parseAlert('A $12.34 purchase at CORNER DELI on card ending in 4321. 482913'), null);
  assert.equal(parseAlert('A $12.34 purchase at CORNER DELI 2026-11-11 on card ending in 4321.').amount, 1234);
  assert.equal(parseAlert('A $12.34 purchase at CORNER DELI on 11/11/2026, card ending in 4321. Questions: 1-800-555-0100.').amount, 1234);
  assert.equal(parseAlert('A $1,234.56 purchase at CORNER DELI at 13:45, card ending in 4321.').amount, 123456);
});

test('base64 with line breaks is read as well (a shortcut left on its default line breaks)', () => {
  const text = 'Northlight Bank: A $12.34 transaction was made at CORNER DELI on card ending in 4321.';
  const plain = toBase64(text);
  assert.equal(fromBase64(plain.replace(/(.{76})/g, '$1\n')), text);
  assert.equal(fromBase64(plain.replace(/(.{76})/g, '$1\r\n') + '\n'), text);
});

test('a file name is the phone\'s local time; anything else is not an inbox file', () => {
  const file = alertFile('20261111-151200-123.txt');
  assert.equal(file.id, 'alert_20261111-151200-123');
  assert.equal(file.ms, new Date(2026, 10, 11, 15, 12, 0, 123).getTime());
  for (const name of ['20261131-151200-123.txt', '20261111-251200-123.txt', 'notes.txt', '../20261111-151200-123.txt', '20261111-151200-123.json', '.keep']) {
    assert.equal(alertFile(name), null, name);
  }
});

/* ---------------------------------------------------------------- the transport */

/** A fake GitHub holding only the inbox folder. */
function fakeInbox() {
  const repo = { files: new Map(), calls: [], fail: null, n: 0 };
  const answer = (status, body, headers = {}) => ({ status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body });
  const base = 'https://api.github.com/repos/' + OWNER + '/networth-data/contents/inbox';
  repo.fetch = async (url, init = {}) => {
    repo.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'Authorization'], 'no other header');
    if (repo.fail === 'rate') return answer(403, {}, { 'x-ratelimit-remaining': '0' });
    if (init.headers.Authorization !== 'Bearer ' + KEY) return answer(401, { message: 'Bad credentials' });
    if (url === base && init.method === 'GET') {
      if (!repo.files.size) return answer(404, { message: 'Not Found' });
      return answer(200, [...repo.files].map(([name, f]) => ({ type: 'file', name, path: 'inbox/' + name, sha: f.sha, size: f.size })));
    }
    const name = url.startsWith(base + '/') ? url.slice(base.length + 1) : null;
    const file = name && repo.files.get(name);
    if (init.method === 'GET') return file ? answer(200, { encoding: 'base64', content: file.content.replace(/(.{60})/g, '$1\n'), sha: file.sha }) : answer(404, {});
    if (init.method === 'DELETE') {
      const body = JSON.parse(init.body);
      assert.equal(body.message, 'Networth: alert read');
      if (!file) return answer(404, {});
      if (body.sha !== file.sha) return answer(409, {});
      repo.files.delete(name);
      return answer(200, { commit: {} });
    }
    return answer(405, {});
  };
  /** What the phone's shortcut does: PUT a new file, base64 of the message. */
  repo.phone = (name, text) => {
    const content = toBase64(text);
    repo.files.set(name, { content, sha: SHA(++repo.n), size: new TextEncoder().encode(text).length });
  };
  return repo;
}

function transportOf(repo, key = KEY) {
  return {
    list: () => listInbox(OWNER, key, repo.fetch),
    read: (name) => readInboxFile(OWNER, key, name, repo.fetch),
    remove: (name, sha) => deleteInboxFile(OWNER, key, name, sha, repo.fetch),
  };
}

async function codeOf(promise) {
  try { await promise; } catch (err) { assert.ok(err instanceof ShareError); return err.code; }
  return 'no error';
}

test('the inbox: listed, read and deleted at api.github.com with the key in the header only', async () => {
  const repo = fakeInbox();
  assert.deepEqual(await listInbox(OWNER, KEY, repo.fetch), [], 'no folder is an empty inbox');
  repo.phone('20261111-151200-123.txt', 'Northlight Bank: A $12.34 transaction was made at CORNER DELI on card ending in 4321.');
  const listed = await listInbox(OWNER, KEY, repo.fetch);
  assert.equal(listed.length, 1);
  assert.equal(await readInboxFile(OWNER, KEY, listed[0].name, repo.fetch), 'Northlight Bank: A $12.34 transaction was made at CORNER DELI on card ending in 4321.');
  assert.equal(await deleteInboxFile(OWNER, KEY, listed[0].name, listed[0].sha, repo.fetch), true);
  assert.equal(await deleteInboxFile(OWNER, KEY, listed[0].name, listed[0].sha, repo.fetch), false, 'already gone is not an error');
  assert.equal(await readInboxFile(OWNER, KEY, listed[0].name, repo.fetch), null);
  for (const call of repo.calls) {
    assert.ok(call.url.startsWith('https://api.github.com/repos/someone/networth-data/contents/inbox'));
    assert.ok(!call.url.includes(KEY) && !(call.body || '').includes(KEY));
  }
  assert.throws(() => inboxUrl(OWNER, '../networth-shared.json'), ShareError);
  assert.equal(await codeOf(listInbox(OWNER, 'not a key', repo.fetch)), 'key', 'no key: nothing is asked');
  assert.equal(await codeOf(listInbox(OWNER, KEY.replace('0', '9'), repo.fetch)), 'key', 'a refused key');
  repo.fail = 'rate';
  assert.equal(await codeOf(listInbox(OWNER, KEY, repo.fetch)), 'rate');
});

/* ------------------------------------------------------------- the whole path */

function dateOnly(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}
function posted(extId, amount, day, description) {
  return { extId, amount, posted: dateOnly(day), at: null, pending: false, description, payee: '', memo: '', mcc: null };
}
function feedAccount(extId, name, balance, txs, at) {
  return { extId, connId: 'CON-1', institution: 'Example Bank', name, currency: 'USD', balance, available: balance, asOf: at - HOUR_MS, txs };
}
function feedAt(at, cardBalance, cardRows) {
  return {
    src: 'simplefin', fetchedAt: at, fromMs: at - 30 * DAY_MS, toMs: at, errors: [],
    accounts: [
      feedAccount('ACT-CHK', 'Everyday Checking', 241991, [posted('C1', -2500, '2026-11-02', 'GREENLEAF MARKET')], at),
      feedAccount('ACT-CARD', 'Everyday Credit Card 4321', cardBalance, cardRows, at),
    ],
  };
}
const OLD_ROWS = [posted('K1', -4000, '2026-11-03', 'BLUE OX HARDWARE')];
const BANK_ROW = posted('K2', -1234, '2026-11-11', 'CORNER DELI #42 SPRINGFIELD');

function makeDevice(repo) {
  const state = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(state, feedAt(NOW - 2 * HOUR_MS, -125000, OLD_ROWS), NOW - 2 * HOUR_MS);
  const device = { state: () => state, stale: () => false, update: (change) => change(state), seen: new Set(), doc: state };
  device.round = (at) => roundAlerts(device, transportOf(repo), at);
  device.alerts = () => state.txs.filter((tx) => tx.via === 'alert');
  return device;
}

const ALERT = 'Northlight Bank: A $12.34 transaction was made at CORNER DELI on card ending in 4321.';
const NAME = '20261111-151200-123.txt';

test('three devices, one inbox: each shows the purchase once, the live figure drops and cash does not; the bank\'s row takes it over', async () => {
  const repo = fakeInbox();
  const devices = [makeDevice(repo), makeDevice(repo), makeDevice(repo)];
  const before = devices.map((d) => position(d.doc, NOW));
  repo.phone(NAME, ALERT);

  for (const d of devices) assert.equal((await d.round(NOW)).added, 1);
  for (const d of devices) assert.equal((await d.round(NOW + 60000)).added, 0, 'read again: nothing new');
  devices.forEach((d, i) => {
    const moves = d.alerts();
    assert.equal(moves.length, 1);
    const [move] = moves;
    const card = d.doc.accounts.find((a) => a.type === 'credit_card');
    assert.equal(move.id, 'alert_20261111-151200-123');
    assert.equal(move.accountId, card.id, 'on the card');
    assert.deepEqual([move.amount, move.merchant, move.day, move.source, move.kind], [1234, 'CORNER DELI', '2026-11-11', 'manual', 'spend']);
    assert.equal(JSON.stringify(d.doc).includes('Northlight'), false, 'the alert\'s text is not kept');
    const now = position(d.doc, NOW);
    assert.equal(now.live, before[i].live - 1234, 'the live figure drops by the amount');
    assert.equal(now.cash, before[i].cash, 'cash on hand does not: it is on the card');
    assert.equal(now.provisional, 1234);
    assert.equal(checkDoc(d.doc), null);
  });
  assert.equal(repo.files.size, 1, 'the file waits for the bank');
  assert.deepEqual(alertStatus(devices[0].doc, '2026-11-11').waiting, 1);

  // the next day the bank's row arrives on the first device: it takes the move over and the file is deleted
  const next = NOW + DAY_MS;
  const [a, b, c] = devices;
  mergeFeed(a.doc, feedAt(next, -126234, [...OLD_ROWS, BANK_ROW]), next);
  const [moveA] = a.alerts();
  assert.ok(moveA.matchId, 'the bank\'s row confirmed the alert');
  const afterA = position(a.doc, next);
  assert.equal(afterA.provisional, 0);
  assert.equal(afterA.live, before[0].live - 1234, 'counted once: by the bank, not the alert');
  assert.equal((await a.round(next)).deleted, 1);
  assert.equal(repo.files.size, 0);

  // the second device reads the inbox before its own reading of the bank: the move stays until the bank's row
  await b.round(next);
  assert.equal(b.alerts().length, 1);
  assert.equal(position(b.doc, next).live, before[1].live - 1234);
  mergeFeed(b.doc, feedAt(next, -126234, [...OLD_ROWS, BANK_ROW]), next);
  assert.ok(b.alerts()[0].matchId);
  assert.equal(position(b.doc, next).live, before[1].live - 1234, 'still counted once');
  mergeFeed(c.doc, feedAt(next, -126234, [...OLD_ROWS, BANK_ROW]), next);
  assert.equal(position(c.doc, next).live, before[2].live - 1234);
  assert.equal(alertStatus(c.doc, '2026-11-12').waiting, 0);
});

test('a device that holds the bank\'s row before it reads the alert never counts the purchase twice', async () => {
  const repo = fakeInbox();
  const d = makeDevice(repo);
  const before = position(d.doc, NOW);
  const next = NOW + DAY_MS;
  mergeFeed(d.doc, feedAt(next, -126234, [...OLD_ROWS, BANK_ROW]), next);
  repo.phone(NAME, ALERT);
  const result = await d.round(next);
  assert.equal(result.added, 1);
  assert.ok(d.alerts()[0].matchId, 'the stored bank row confirms it at once');
  assert.equal(result.deleted, 1, 'and the file is done with');
  assert.equal(position(d.doc, next).live, before.live - 1234);
});

test('a code, a refund, nonsense: deleted at once and never shown', async () => {
  const repo = fakeInbox();
  const d = makeDevice(repo);
  repo.phone('20261111-151200-001.txt', 'Northlight Bank: Your security code is 482913.');
  repo.phone('20261111-151200-002.txt', 'Refund: $12.34 from CORNER DELI on card ending in 4321.');
  repo.phone('20261111-151200-003.txt', '<html>$5.00 purchase</html>');
  const result = await d.round(NOW);
  assert.deepEqual([result.added, result.deleted, result.refused], [0, 3, 3], 'each one refused is counted');
  assert.equal(repo.files.size, 0);
  assert.equal(d.alerts().length, 0);
});

test('a duplicate listing, a file another device deleted, an old file, a file too large', async () => {
  const repo = fakeInbox();
  const d = makeDevice(repo);
  repo.phone(NAME, ALERT);
  const twice = { ...transportOf(repo), list: async () => { const l = await listInbox(OWNER, KEY, repo.fetch); return [...l, ...l]; } };
  await roundAlerts({ state: () => d.doc, stale: () => false, update: (c) => c(d.doc), seen: d.seen }, twice, NOW);
  assert.equal(d.alerts().length, 1, 'the same file listed twice is 1 move');

  // another device deleted the file between the listing and the read
  const gone = { ...transportOf(repo), read: async () => null };
  repo.phone('20261111-161500-000.txt', 'A $7.00 purchase at Kiosk Nine on card ending in 4321.');
  await roundAlerts({ state: () => d.doc, stale: () => false, update: (c) => c(d.doc), seen: d.seen }, gone, NOW);
  assert.equal(d.alerts().length, 1, 'nothing to read: no move');

  const old = new Date(2026, 10, 11 - ALERT_KEEP_DAYS - 2, 12, 0).getTime();
  const oldName = alertFile('20261026-120000-000.txt');
  assert.ok(oldName && oldName.ms === old);
  repo.phone('20261026-120000-000.txt', 'A $9.00 purchase at Old Stand on card ending in 4321.');
  repo.files.set('20261111-170000-000.txt', { content: toBase64('A $1.00 purchase at Big'), sha: SHA(99), size: 50000 });
  await d.round(NOW);
  assert.equal(repo.files.has('20261026-120000-000.txt'), false, 'older than 14 days: deleted, not shown');
  assert.equal(repo.files.has('20261111-170000-000.txt'), false, 'too large: deleted unread');
  assert.equal(d.alerts().length, 1);
});

test('the owner removed a move: this device does not bring it back', async () => {
  const repo = fakeInbox();
  const d = makeDevice(repo);
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  d.doc.txs = d.doc.txs.filter((tx) => tx.via !== 'alert');
  await d.round(NOW + 60000);
  assert.equal(d.alerts().length, 0);
});

test('a removed alert move does not come back: its file is deleted at the next reading, and its id is kept 30 days', async () => {
  const repo = fakeInbox();
  const d = makeDevice(repo);
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  const [move] = d.alerts();
  assert.equal(removeManual(d.doc, move.id, NOW + 1000), true);
  assert.deepEqual(d.doc.alertsRemoved, [{ id: move.id, at: NOW + 1000 }]);
  assert.equal(checkDoc(d.doc), null, 'the record with the list is a record');
  // the page was reloaded before the file was deleted: nothing this device saw is remembered but the record
  const fresh = { ...d, seen: new Set() };
  const result = await roundAlerts(fresh, transportOf(repo), NOW + 60000);
  assert.deepEqual([result.added, result.deleted], [0, 1]);
  assert.equal(d.alerts().length, 0);
  assert.equal(repo.files.size, 0);
  // and a file of the same name written again (another device's late reading) is not read into a move
  repo.phone(NAME, ALERT);
  await roundAlerts({ ...d, seen: new Set() }, transportOf(repo), NOW + 120000);
  assert.equal(d.alerts().length, 0);
  // after 30 days the id is forgotten
  await roundAlerts({ ...d, seen: new Set() }, transportOf(repo), NOW + (ALERT_REMOVED_DAYS + 1) * DAY_MS);
  assert.deepEqual(d.doc.alertsRemoved, []);
  const older = defaultState(NOW);
  delete older.alertsRemoved;
  assert.equal(checkDoc(older), null, 'an older record lacks the list');
  assert.notEqual(checkDoc({ ...older, alertsRemoved: [{ id: 5 }] }), null);
});

test('an alert move is matched by a bank charge of its amount up to 35% more, dated on its day or up to 5 days after', () => {
  const cases = [
    [1234, '2026-11-11', true], [1665, '2026-11-11', true], [1666, '2026-11-11', false], [1233, '2026-11-11', false],
    [1234, '2026-11-16', true], [1234, '2026-11-17', false], [1234, '2026-11-10', false],
  ];
  for (const [amount, day, matched] of cases) {
    const state = defaultState(NOW - 200 * DAY_MS);
    mergeFeed(state, feedAt(NOW - HOUR_MS, -125000, OLD_ROWS), NOW - HOUR_MS);
    const move = addAlertMove(state, parseAlert(ALERT), alertFile(NAME), NOW);
    const at = new Date(2026, 10, 18, 12).getTime();
    mergeFeed(state, feedAt(at, -125000 - amount, [...OLD_ROWS, posted('K9', -amount, day, 'CORNER DELI TIP')]), at);
    assert.equal(!!move.matchId, matched, amount + ' on ' + day);
  }
});

test('no key, a refused key: nothing is read and nothing changes', async () => {
  const repo = fakeInbox();
  const d = makeDevice(repo);
  repo.phone(NAME, ALERT);
  const count = d.doc.txs.length;
  assert.equal(await codeOf(roundAlerts(d, transportOf(repo, ''), NOW)), 'key');
  assert.equal(await codeOf(roundAlerts(d, transportOf(repo, 'invented_but_refused_key_000000'), NOW)), 'key');
  assert.equal(d.doc.txs.length, count);
  assert.equal(repo.files.size, 1);
  assert.equal(repo.calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('the card: named by its last 4 digits, else the only card, else none', () => {
  const state = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(state, feedAt(NOW, -125000, OLD_ROWS), NOW);
  const card = state.accounts.find((a) => a.type === 'credit_card');
  assert.equal(cardFor(state, '4321'), card);
  assert.equal(cardFor(state, '0000'), card, 'the only card');
  assert.equal(cardFor(state, null), card);
  state.accounts.push({ ...card, id: 'acc_second', name: 'Travel Card 5555' });
  assert.equal(cardFor(state, '0000'), null, 'two cards and no name: none');
  assert.equal(cardFor(state, '5555').id, 'acc_second');
  const move = addAlertMove(state, { amount: 700, merchant: 'Kiosk Nine', last4: '0000' }, alertFile('20261111-151200-999.txt'), NOW);
  assert.equal(move.accountId, null, 'spending from no known account');
  assert.equal(position(state, NOW).provisional, 700);
});

test('an alert is never matched by a tapped-in move\'s merchant rule, only by card, amount and day', () => {
  const state = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(state, feedAt(NOW - HOUR_MS, -125000, OLD_ROWS), NOW - HOUR_MS);
  const typed = addProvisional(state, { amount: 1234, merchant: 'Somewhere Else', day: '2026-11-11' }, NOW);
  const alert = addAlertMove(state, parseAlert(ALERT), alertFile(NAME), NOW);
  mergeFeed(state, feedAt(NOW + DAY_MS, -126234, [...OLD_ROWS, BANK_ROW]), NOW + DAY_MS);
  assert.ok(alert.matchId, 'the alert is taken over by the bank\'s row');
  assert.equal(typed.matchId, null, 'the move tapped in for another merchant is not');
  assert.equal(fromBase64(toBase64('ok')), 'ok');
});

/* ------------------------------------------- a card the bank gives no rows of (balance-only) */

const CARD_ONLY = 'Everyday Credit Card 4321';
function plainAccount(extId, connId, institution, name, balance, txs, at) {
  return { extId, connId, institution, name, currency: 'USD', balance, available: balance, asOf: at - HOUR_MS, txs };
}
/** A reading where the card carries its balance and never a row; checking carries rows. */
function balanceOnlyFeed(at, cardOwed, checking = 241991, cardRows = []) {
  return {
    src: 'simplefin', fetchedAt: at, fromMs: at - 30 * DAY_MS, toMs: at, errors: [],
    accounts: [
      plainAccount('ACT-CHK', 'CON-1', 'Example Bank', 'Everyday Checking', checking, [posted('C1', -2500, '2026-11-02', 'GREENLEAF MARKET')], at),
      plainAccount('ACT-CARD', 'CON-2', 'Northlight Bank', CARD_ONLY, -cardOwed, cardRows, at),
    ],
  };
}
function balanceOnlyDevice(repo) {
  const state = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(state, balanceOnlyFeed(NOW - 2 * HOUR_MS, 125000), NOW - 2 * HOUR_MS);
  const device = { state: () => state, stale: () => false, update: (change) => change(state), seen: new Set(), doc: state };
  device.round = (at) => roundAlerts(device, transportOf(repo), at);
  device.alerts = () => state.txs.filter((tx) => tx.via === 'alert');
  device.read = (at, owed, checking) => mergeFeed(state, balanceOnlyFeed(at, owed, checking), at);
  return device;
}
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('balance-only card: a purchase that posts the next day is taken in at that reading, never counted twice nor left out', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const base = position(d.doc, NOW).live;
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  const [move] = d.alerts();
  assert.deepEqual([move.seenOwed, move.inBalance], [125000, undefined], 'the owed amount the record held is kept on the move');
  assert.equal(position(d.doc, NOW).live, base - 1234);
  d.read(at(11, 20), 125000);
  assert.equal(move.inBalance, undefined, 'the same balance: still counted');
  assert.equal(position(d.doc, at(11, 20)).live, base - 1234);
  d.read(at(12, 9), 126234);
  assert.equal(move.inBalance, true, 'the owed amount rose by the purchase: taken in');
  const p = position(d.doc, at(12, 9));
  assert.equal(p.live, base - 1234, 'counted once, by the balance');
  assert.equal(p.provisional, 0);
  assert.equal(alertStatus(d.doc, '2026-11-12').waiting, 0);
  const row = recentTransactions(d.doc, '2026-11-12').rows.find((r) => r.tx.id === move.id);
  assert.ok(row && row.provisional === false, 'still listed, as settled');
  assert.equal((await d.round(at(12, 9, 5))).deleted, 1, 'its file is done with');
  // a week later it is still listed: the purchase's only record
  d.read(at(20, 9), 126234);
  assert.ok(recentTransactions(d.doc, '2026-11-20').rows.some((r) => r.tx.id === move.id));
  assert.equal(position(d.doc, at(20, 9)).live, base - 1234);
  assert.equal(checkDoc(d.doc), null);
});

test('balance-only card: two purchases posting on different days are each taken in when the balance holds it', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const base = position(d.doc, NOW).live;
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  repo.phone('20261111-170000-000.txt', 'Northlight Bank: A $5.00 transaction was made at KIOSK NINE on card ending in 4321.');
  await d.round(at(11, 17, 1));
  const [first, second] = d.alerts();
  assert.equal(position(d.doc, at(11, 17, 1)).live, base - 1734);
  d.read(at(12, 9), 125500); // only the second posted
  assert.deepEqual([first.inBalance, second.inBalance], [undefined, undefined], 'a rise of $5.00 is not $12.34, nor $12.34 and $5.00');
  assert.equal(position(d.doc, at(12, 9)).live, base - 1234 - 500 - 500, 'the second is counted by both until it is taken in');
  d.read(at(13, 9), 126734); // the first posted too
  assert.deepEqual([first.inBalance, second.inBalance], [true, true]);
  assert.equal(position(d.doc, at(13, 9)).live, base - 1734);
});

test('balance-only card: a purchase posting next day with its rise in place is taken in, the later one waits', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const base = position(d.doc, NOW).live;
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  d.read(at(12, 9), 126234);
  repo.phone('20261112-120000-000.txt', 'Northlight Bank: A $5.00 transaction was made at KIOSK NINE on card ending in 4321.');
  await d.round(at(12, 12, 1));
  const [first, second] = d.alerts();
  assert.deepEqual([first.inBalance, second.inBalance, second.seenOwed], [true, undefined, 126234]);
  assert.equal(position(d.doc, at(12, 12, 1)).live, base - 1734);
  d.read(at(13, 9), 126734);
  assert.equal(second.inBalance, true);
  assert.equal(position(d.doc, at(13, 9)).live, base - 1734);
});

test('balance-only card: a payment posting the same day as a purchase falls back to the 4-day rule', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const base = position(d.doc, NOW).live;
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  const [move] = d.alerts();
  for (const day of [12, 13, 14]) {
    d.read(at(day, 9), 125000 + 1234 - 10000, 241991 - 10000);
    assert.equal(move.inBalance, undefined, 'day ' + day);
    // the balance holds the purchase but the payment hides its rise: until the 4-day rule, it shows twice
    assert.equal(position(d.doc, at(day, 9)).live, base - 2468, 'counted by the balance and the alert, day ' + day);
  }
  d.read(at(15, 9), 125000 + 1234 - 10000, 241991 - 10000);
  assert.equal(move.inBalance, true, 'a balance dated 4 days after the purchase');
  assert.equal(position(d.doc, at(15, 9)).live, base - 1234);
});

test('balance-only card: a purchase still pending after 3 days is counted until the balance is 4 days later', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const base = position(d.doc, NOW).live;
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  const [move] = d.alerts();
  for (const day of [12, 13, 14]) {
    d.read(at(day, 9), 125000);
    assert.equal(position(d.doc, at(day, 9)).live, base - 1234, 'counted, day ' + day);
  }
  assert.equal(alertStatus(d.doc, '2026-11-14').waiting, 1);
  d.read(at(15, 9), 125000);
  assert.equal(move.inBalance, true);
  assert.equal(position(d.doc, at(15, 9)).provisional, 0);
});

test('a card that begins to carry its rows is no longer balance-only: its row takes the move over', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  const [move] = d.alerts();
  mergeFeed(d.doc, balanceOnlyFeed(at(12, 9), 125000, 241991, [posted('N1', -1234, '2026-11-12', 'CORNER DELI')]), at(12, 9));
  assert.ok(move.matchId);
  assert.equal(move.inBalance, undefined);
});

test('balance-only card: a later purchase never rides on the rise of an earlier one already taken in', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const base = position(d.doc, NOW).live;
  repo.phone('20261111-151200-001.txt', 'Northlight Bank: A $50.00 transaction was made at BLUE OX HARDWARE on card ending in 4321.');
  repo.phone('20261111-151500-002.txt', 'Northlight Bank: A $40.00 transaction was made at KIOSK NINE on card ending in 4321.');
  await d.round(NOW);
  const [one, two] = d.alerts();
  assert.deepEqual([one.seenOwed, two.seenOwed], [125000, 125000]);
  d.read(at(12, 9), 130000); // the $50.00 posted
  assert.deepEqual([one.inBalance, two.inBalance], [true, undefined]);
  assert.equal(position(d.doc, at(12, 9)).live, base - 9000, 'the $40.00 is still counted by its alert');
  d.read(at(13, 9), 130000); // nothing new posted: the rise since the $40.00's balance is the $50.00's alone
  assert.equal(two.inBalance, undefined, 'not taken in on the $50.00 already taken in');
  assert.equal(position(d.doc, at(13, 9)).live, base - 9000);
  d.read(at(14, 9), 134000); // the $40.00 posted
  assert.equal(two.inBalance, true);
  assert.equal(position(d.doc, at(14, 9)).live, base - 9000);
});

test('balance-only card that begins to carry its rows: a purchase already taken in is matched by its row and counted once', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const base = position(d.doc, NOW).live;
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  const [move] = d.alerts();
  d.read(at(12, 9), 126234);
  assert.equal(move.inBalance, true);
  const spent = (day, now) => spendingByCategory(d.doc, '2026-11-01', day, now).reduce((sum, c) => sum + c.amount, 0);
  const before = spent('2026-11-13', at(13, 9));
  mergeFeed(d.doc, balanceOnlyFeed(at(13, 9), 126234, 241991, [posted('N1', -1234, '2026-11-12', 'CORNER DELI')]), at(13, 9));
  assert.ok(move.matchId, 'the bank\'s row takes over the move taken in');
  assert.equal(spent('2026-11-13', at(13, 9)), before, 'the purchase is spent once, not twice');
  assert.equal(position(d.doc, at(13, 9)).live, base - 1234);
});

test('texts that are not a completed charge are refused; "with card ...4321" ends the merchant and gives the digits', () => {
  for (const text of [
    '$12.34 purchase at CORNER DELI was not completed.', 'Your $12.34 purchase at CORNER DELI did not go through.',
    'A $12.34 purchase attempt at CORNER DELI.', '$12.34 purchase at CORNER DELI needs your OK.',
    'You will be charged $12.34 at CORNER DELI.', 'A $12.34 charge at CORNER DELI will post on 11/20.',
    'Your card expires soon; $12.34 purchase at CORNER DELI.', 'Your card was frozen; $12.34 purchase at CORNER DELI.',
    'Your card is locked: $12.34 purchase at CORNER DELI.',
  ]) assert.equal(parseAlert(text), null, text);
  assert.deepEqual(parseAlert('$12.34 purchase with CORNER DELI using card ending 4321'), { amount: 1234, merchant: 'CORNER DELI', last4: '4321' });
  assert.deepEqual(parseAlert('Northlight: $12.34 purchase at CORNER DELI with card ...4321.'), { amount: 1234, merchant: 'CORNER DELI', last4: '4321' });
});

/* ---------------------------------------------------------- a bank removed and added again */

function bankFeed(at, list) {
  return { src: 'simplefin', fetchedAt: at, fromMs: at - 30 * DAY_MS, toMs: at, errors: [], accounts: list.map((a) => plainAccount(...a, at)) };
}

test('a card re-added at the provider, with a new id and connection, is the same account with its settings and alert moves', async () => {
  const repo = fakeInbox();
  const d = balanceOnlyDevice(repo);
  const card = d.doc.accounts.find((a) => a.name === CARD_ONLY);
  card.nick = 'The everyday card';
  repo.phone(NAME, ALERT);
  await d.round(NOW);
  const count = d.doc.accounts.length;
  const base = position(d.doc, NOW).live;
  const t = at(11, 20);
  mergeFeed(d.doc, bankFeed(t, [
    ['ACT-CHK', 'CON-1', 'Example Bank', 'Everyday Checking', 241991, [posted('C1', -2500, '2026-11-02', 'GREENLEAF MARKET')]],
    ['ACT-CARD-NEW', 'CON-9', 'Northlight Bank', CARD_ONLY, -125000, []],
  ]), t);
  assert.equal(d.doc.accounts.length, count, 'no second card');
  assert.equal(card.ext.id, 'ACT-CARD-NEW');
  assert.equal(card.ext.conn, 'CON-9');
  assert.equal(card.nick, 'The everyday card');
  assert.equal(d.alerts()[0].accountId, card.id);
  assert.equal(position(d.doc, t).live, base, 'counted once');
});

test('two same-named accounts at one bank are never merged; an account of another bank with the same name is never adopted', () => {
  const t0 = NOW - 2 * HOUR_MS;
  const t1 = NOW;
  const twin = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(twin, bankFeed(t0, [['A1', 'CON-1', 'Example Bank', 'Savings', 1000, []], ['A2', 'CON-1', 'Example Bank', 'Savings', 2000, []]]), t0);
  mergeFeed(twin, bankFeed(t1, [['B1', 'CON-2', 'Example Bank', 'Savings', 1000, []]]), t1);
  assert.equal(twin.accounts.length, 3, 'two former accounts of the name: none is adopted');
  const pair = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(pair, bankFeed(t0, [['A1', 'CON-1', 'Example Bank', 'Savings', 1000, []]]), t0);
  mergeFeed(pair, bankFeed(t1, [['B1', 'CON-2', 'Example Bank', 'Savings', 1000, []], ['B2', 'CON-2', 'Example Bank', 'Savings', 2000, []]]), t1);
  assert.equal(pair.accounts.length, 3, 'two new accounts of the name: none adopts it');
  const other = defaultState(NOW - 200 * DAY_MS);
  mergeFeed(other, bankFeed(t0, [['A1', 'CON-1', 'Example Bank', 'Savings', 1000, []]]), t0);
  mergeFeed(other, bankFeed(t1, [['B1', 'CON-2', 'Harbor Union', 'Savings', 1000, []]]), t1);
  assert.equal(other.accounts.length, 2, 'another bank\'s account is another account');
  assert.equal(other.accounts[0].ext.id, 'A1');
});
