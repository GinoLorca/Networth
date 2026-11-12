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
