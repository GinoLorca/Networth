import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDoc, defaultState, makeAccount, makeTx, makeRecurring, makeStream, migrate, TX_KINDS, ACCOUNT_TYPES, categoryLabel } from '../js/model/schema.js';
import { buildDemoState } from '../js/model/demo.js';

const NOW = Date.UTC(2026, 5, 10, 18, 36);
const TYPE = Object.keys(ACCOUNT_TYPES)[0];
const KIND = Object.keys(TX_KINDS)[0];

function sound() {
  const d = JSON.parse(JSON.stringify(defaultState(NOW)));
  d.meta.origin = 'bank';
  d.accounts.push(JSON.parse(JSON.stringify({ ...makeAccount({ type: TYPE }), id: 'acc_base', name: 'Fictional Checking', balance: 5000 })));
  d.txs.push(JSON.parse(JSON.stringify({ ...makeTx(), id: 'tx_1', kind: KIND, amount: 475, day: '2026-06-07', accountId: 'acc_base' })));
  d.recurring.push(JSON.parse(JSON.stringify(makeRecurring())));
  d.streams.push(JSON.parse(JSON.stringify(makeStream())));
  d.habits.push({ from: '2026-05-01' });
  return d;
}

test('checkDoc accepts a sound record, the sample game, and a record after migrate', () => {
  assert.equal(checkDoc(sound()), null);
  assert.equal(checkDoc(JSON.parse(JSON.stringify(buildDemoState(NOW)))), null);
  assert.equal(checkDoc(migrate(sound())), null);
  assert.equal(checkDoc(JSON.parse(JSON.stringify(defaultState(NOW)))), null);
});

test('checkDoc refuses anything that is not shaped like a record', () => {
  const variants = {
    habitsNull: (d) => { d.habits = [null]; },
    habitNoDay: (d) => { d.habits = [{ from: 'soon' }]; },
    recurringNull: (d) => { d.recurring = [null]; },
    streamsString: (d) => { d.streams = ['a']; },
    accountNameObject: (d) => { d.accounts[0].name = { x: 1 }; },
    accountBalanceText: (d) => { d.accounts[0].balance = '5000'; },
    txBadDay: (d) => { d.txs[0].day = 'nonsense'; },
    txImpossibleDay: (d) => { d.txs[0].day = '2026-02-30'; },
    txNoId: (d) => { delete d.txs[0].id; },
    daysString: (d) => { d.days = 'str'; },
    requestsString: (d) => { d.sync.requests = 'abc'; },
    requestsMixed: (d) => { d.sync.requests = [1, 'x']; },
    settingsArray: (d) => { d.settings = []; },
    syncString: (d) => { d.sync = 'x'; },
    metaArray: (d) => { d.meta = [1]; },
    sweepsNull: (d) => { d.sweeps = [null]; },
    protoKey: (d) => { Object.defineProperty(d.settings, '__proto__', { value: { cover: true }, enumerable: true }); },
    constructorKey: (d) => { d.accounts[0].constructor = { prototype: {} }; },
    longText: (d) => { d.accounts[0].name = 'x'.repeat(20001); },
    tooManyAccounts: (d) => { for (let i = 0; i < 5001; i++) d.accounts.push({ ...d.accounts[0], id: 'a' + i }); },
    newer: (d) => { d.meta.v = 9999; },
    versionFraction: (d) => { d.meta.v = -7.5; },
    accountTypeInherited: (d) => { d.accounts[0].type = 'constructor'; },
    accountTypeToString: (d) => { d.accounts[0].type = 'toString'; },
    txKindInherited: (d) => { d.txs[0].kind = 'constructor'; },
    txNegative: (d) => { d.txs[0].amount = -d.txs[0].amount - 1; },
    txFractionCents: (d) => { d.txs[0].amount = 4.75; },
    txFlowUnknown: (d) => { d.txs[0].flow = 'sideways'; },
    balanceHuge: (d) => { d.accounts[0].balance = 1e300; },
  };
  for (const [name, change] of Object.entries(variants)) {
    const d = sound();
    change(d);
    assert.equal(typeof checkDoc(d), 'string', name + ' is refused');
  }
  for (const junk of [null, 5, 'x', [], {}, { meta: { v: '1' } }]) assert.equal(typeof checkDoc(junk), 'string');
});

test('checkDoc refuses a parsed file that carries a __proto__ key', () => {
  const text = JSON.stringify(sound()).replace('"settings":{', '"settings":{"__proto__":{"cover":true},');
  assert.equal(typeof checkDoc(JSON.parse(text)), 'string');
});

test('category labels use American spelling: the catch-all and an unknown key read "Uncategorized"', () => {
  assert.equal(categoryLabel('other'), 'Uncategorized');
  assert.equal(categoryLabel('no-such-category'), 'Uncategorized');
});


/* ---- a record that passed through the placeholder build gets the built-in rules and goals back ---- */

/** A record as the placeholder build made it at `madeAt`: its own defaults, and the list only it wrote. */
function placeholderRecord(madeAt) {
  const doc = defaultState(madeAt);
  doc.settings.principles = [];
  doc.settings.insteads = ['Went without', 'Used what I had', 'Made it at home', 'Left it for later'];
  doc.settings.preps = [];
  doc.goals.reserve.target = 500000;
  doc.goals.income = { ladder: [5000000, 7500000, 10000000, 15000000], by: (new Date(madeAt).getFullYear() + 4) + '-12-31' };
  return doc;
}

test('migrate: a record made by the placeholder build gets the built-in rules and goals back, once', () => {
  const builtIn = defaultState(NOW);
  const doc = migrate(placeholderRecord(NOW));
  assert.deepEqual(doc.settings.principles, builtIn.settings.principles);
  assert.equal(doc.settings.principles.length > 0, true);
  assert.deepEqual(doc.settings.insteads, builtIn.settings.insteads);
  assert.equal(doc.goals.reserve.target, builtIn.goals.reserve.target);
  assert.deepEqual(doc.goals.income, builtIn.goals.income);
  assert.equal('preps' in doc.settings, false, 'the marker is gone, so nothing is restored a second time');
  assert.equal(checkDoc(doc), null);
  // a second pass changes nothing, even after the owner clears the list on purpose
  doc.settings.principles = [];
  doc.goals.reserve.target = 500000;
  migrate(doc);
  assert.deepEqual(doc.settings.principles, []);
  assert.equal(doc.goals.reserve.target, 500000);
});

test('migrate: what the owner changed under the placeholder build is left as it is', () => {
  const doc = placeholderRecord(NOW);
  doc.settings.principles = ['Mine.'];
  doc.settings.insteads = ['Walked'];
  doc.settings.preps = ['Bag packed'];
  doc.goals.reserve.target = 750000;
  doc.goals.income = { ladder: [6000000, 9000000], by: '2031-06-30' };
  migrate(doc);
  assert.deepEqual(doc.settings.principles, ['Mine.']);
  assert.deepEqual(doc.settings.insteads, ['Walked']);
  assert.equal(doc.goals.reserve.target, 750000);
  assert.deepEqual(doc.goals.income, { ladder: [6000000, 9000000], by: '2031-06-30' });
  assert.equal('preps' in doc.settings, false);
});

test('migrate: a record the placeholder build never touched is not altered, and odd shapes do not throw', () => {
  const never = defaultState(NOW);
  never.settings.principles = [];           // cleared by the owner: there is no marker, so it stays cleared
  never.goals.reserve.target = 500000;      // a goal that happens to equal the placeholder
  migrate(never);
  assert.deepEqual(never.settings.principles, []);
  assert.equal(never.goals.reserve.target, 500000);

  for (const odd of [{ preps: 'x' }, { preps: [], principles: 'none', insteads: null }, { preps: [], principles: [] }]) {
    const doc = defaultState(NOW);
    doc.settings = { ...doc.settings, ...odd };
    doc.goals = odd.principles === 'none' ? { reserve: null, income: 'soon' } : doc.goals;
    assert.doesNotThrow(() => migrate(doc));
  }
});

test('an account keeps what the last reading carried and its history bookkeeping; a record without them is valid', () => {
  const fresh = makeAccount();
  assert.deepEqual([fresh.feed, fresh.backfill], [null, null]);
  const doc = defaultState(0);
  doc.accounts.push(makeAccount({
    source: 'bank', ext: { src: 'simplefin', id: 'ACT-1', conn: 'CON-1' }, type: 'credit_card',
    feed: { readAt: 1794400000000, rows: 12, first: '2026-08-01', last: '2026-11-10', askedFrom: '2026-05-17', askedTo: '2026-11-11', askedFromMs: 1779200000000, askedToMs: 1794400000000 },
    backfill: { need: true, step: 2, done: false, gaveUp: false, tries: 2, at: 1794400000000 },
  }));
  assert.equal(checkDoc(doc), null);
  const older = makeAccount({ type: 'checking' });
  delete older.feed;
  delete older.backfill;
  doc.accounts.push(older);
  assert.equal(checkDoc(doc), null, 'a record written before these fields existed is still read');
  const migrated = migrate(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual([migrated.accounts[1].feed, migrated.accounts[1].backfill], [null, null]);
  assert.deepEqual(migrated.accounts[0].backfill, { need: true, step: 2, done: false, gaveUp: false, tries: 2, at: 1794400000000 });
});

/* ------------------------------------------------ a payment the owner sends, and what travels between devices */

const BY_HAND_FIELDS = ['byHand', 'dueDay', 'payee', 'payeeAt', 'marks', 'skips', 'editedAt'];

function withFlatShare(fields = {}) {
  const d = sound();
  d.recurring.push(JSON.parse(JSON.stringify(makeRecurring({
    id: 'rec_flat', name: 'Flat share', amount: 25000, cadence: 'monthly', anchor: '2026-06-05', source: 'manual', mkey: '', since: '2026-06-01',
    byHand: true, dueDay: 5, payee: 'p0123456789abc', payeeAt: 7, editedAt: 9,
    marks: { '2026-06-05': { paid: true, at: 11 } }, skips: { '2026-06-04|p0123456789abc': { on: false, at: 12 } },
    ...fields,
  }))));
  return d;
}

test('a Book line is not a payment the owner sends until it is made one; the record keeps the removals to share', () => {
  const line = makeRecurring();
  assert.deepEqual(BY_HAND_FIELDS.map((field) => line[field]), [false, null, null, 0, {}, {}, 0]);
  assert.notEqual(makeRecurring().marks, line.marks, 'each line has its own marks');
  assert.notEqual(makeRecurring().skips, line.skips);
  assert.deepEqual(defaultState(NOW).share, { tombs: {} });
});

test('checkDoc accepts a record with a payment the owner sends, and one from before there were any', () => {
  const d = withFlatShare();
  d.share.tombs.rec_gone = 1794300000000;
  assert.equal(checkDoc(d), null);
  assert.equal(checkDoc(migrate(JSON.parse(JSON.stringify(d)))), null);

  const older = withFlatShare();
  delete older.share;
  for (const line of older.recurring) for (const field of BY_HAND_FIELDS) delete line[field];
  assert.equal(checkDoc(older), null);
  migrate(older);
  assert.deepEqual(older.share, { tombs: {} });
  assert.deepEqual(BY_HAND_FIELDS.map((field) => older.recurring[0][field]), [false, null, null, 0, {}, {}, 0]);
  assert.equal(checkDoc(older), null);

  // a payment the owner sends with no day, or with another cadence, would be due and on no checklist: refused
  assert.notEqual(checkDoc(withFlatShare({ dueDay: null })), null);
  assert.notEqual(checkDoc(withFlatShare({ cadence: 'weekly' })), null);
  const partial = withFlatShare({ marks: null, skips: null, payee: null });
  partial.share = {};
  assert.equal(checkDoc(partial), null);
  migrate(partial);
  assert.deepEqual([partial.recurring[0].marks, partial.recurring[0].skips, partial.share], [{}, {}, { tombs: {} }]);
});

test('migrate leaves the marks, the skips and the removals of a record as they are', () => {
  const d = withFlatShare();
  d.share.tombs.rec_gone = 1794300000000;
  const before = JSON.parse(JSON.stringify({ line: d.recurring[0], share: d.share }));
  migrate(d);
  assert.deepEqual({ line: d.recurring[0], share: d.share }, before);
});

test('checkDoc refuses a payment the owner sends, or a removal, that is not shaped like one', () => {
  const bad = [
    withFlatShare({ dueDay: 0 }), withFlatShare({ dueDay: 32 }), withFlatShare({ dueDay: 5.5 }), withFlatShare({ dueDay: '5' }),
    withFlatShare({ payee: 7 }), withFlatShare({ payee: {} }),
    withFlatShare({ marks: [] }), withFlatShare({ marks: 'paid' }), withFlatShare({ marks: { '2026-06-05': true } }), withFlatShare({ marks: { '2026-06-05': [] } }),
    withFlatShare({ skips: 3 }), withFlatShare({ skips: { '2026-06-04|p0123456789abc': 'on' } }),
    withFlatShare({ byHand: 'yes' }), withFlatShare({ payeeAt: 'now' }), withFlatShare({ editedAt: {} }),
  ];
  for (const d of bad) assert.equal(typeof checkDoc(d), 'string', JSON.stringify(d.recurring[0]).slice(0, 200));
  for (const share of ['x', [], { tombs: [] }, { tombs: 'none' }, { tombs: { rec_gone: 'yesterday' } }, { tombs: { rec_gone: null } }]) {
    const d = withFlatShare();
    d.share = share;
    assert.equal(typeof checkDoc(d), 'string', JSON.stringify(share));
  }
});
