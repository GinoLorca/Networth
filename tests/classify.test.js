import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classify, confirmMove, inferAccountType, learnRule, merchantOf, normalizeDescription, reclassify, topMerchants,
} from '../js/model/classify.js';
import {
  CASH_RE, INCOME_RE, MCC, MERCHANT_RULES, NOISE, PAYMENT_RE, PENALTY_RE, REFUND_RE, TRANSFER_RE,
} from '../js/model/rules-data.js';
import {
  ACCOUNT_TYPES, CATEGORIES, FLOW_CATEGORIES, KLASSES, PURPOSES, defaultState, klassOf, makeAccount, makeTx,
} from '../js/model/schema.js';

/* ------------------------------------------------------------------ helpers */

const KINDS = ['spend', 'income', 'transfer', 'payment', 'refund'];

function run(description, flow = 'out', accountType = 'checking', extra = {}) {
  return classify({ description, amount: 1234, flow, accountType, ...extra });
}

/** Every classification, whatever the input, must be a complete and coherent record. */
function assertCoherent(result, label = '') {
  assert.ok(result && typeof result === 'object', label);
  assert.ok(KINDS.includes(result.kind), `${label} kind ${result.kind}`);
  assert.ok(Object.hasOwn(CATEGORIES, result.category) || Object.hasOwn(FLOW_CATEGORIES, result.category), `${label} category ${result.category}`);
  assert.ok(Object.hasOwn(KLASSES, result.klass), `${label} klass ${result.klass}`);
  assert.ok(PURPOSES.includes(result.purpose), `${label} purpose ${result.purpose}`);
  assert.equal(typeof result.merchant, 'string', label);
  assert.ok(result.merchant.length > 0 && result.merchant.length <= 48, `${label} merchant length`);
  assert.equal(typeof result.mkey, 'string', label);
  assert.ok(result.mkey.length <= 40, `${label} mkey length`);
  assert.equal(result.mkey, result.mkey.toLowerCase().trim(), `${label} mkey is lower-case and trimmed`);
  assert.ok(!/ {2}|[^\p{L}\p{N} ]/u.test(result.mkey), `${label} mkey holds letters, digits and single spaces only`);
  assert.equal(typeof result.review, 'boolean', label);
  assert.ok(result.ruleId === null || typeof result.ruleId === 'string', label);
  assert.ok(result.glyph === null || result.glyph === '??', label);
  const flowCategory = { income: 'income', transfer: 'transfer', payment: 'card_payment' }[result.kind];
  if (flowCategory) assert.equal(result.category, flowCategory, `${label} ${result.kind} carries its flow category`);
  else assert.ok(Object.hasOwn(CATEGORIES, result.category), `${label} ${result.kind} carries a spending category`);
  if (result.glyph) assert.equal(result.kind, 'spend', `${label} only a spend is a penalty`);
}

let seq = 0;

function bankTx(raw, fields = {}) {
  seq += 1;
  return makeTx({ id: 'tx_' + seq, raw, accountId: 'acc_chk', day: '2026-03-10', postedDay: '2026-03-10', amount: 500, flow: 'out', ...fields });
}

function doc(txs) {
  const state = defaultState(0);
  state.accounts = [
    makeAccount({ id: 'acc_chk', type: 'checking', source: 'bank' }),
    makeAccount({ id: 'acc_sav', type: 'savings', source: 'bank' }),
    makeAccount({ id: 'acc_card', type: 'credit_card', source: 'bank' }),
  ];
  state.txs = txs;
  return state;
}

function pick(tx, keys) {
  return Object.fromEntries(keys.map((key) => [key, tx[key]]));
}

/* --------------------------------------------------------------- rules data */

test('rules-data: every pattern compiles and every rule is well formed', () => {
  const ids = new Set();
  assert.ok(MERCHANT_RULES.length >= 200, 'the built-in list is substantial');
  for (const rule of MERCHANT_RULES) {
    assert.deepEqual(
      Object.keys(rule).filter((key) => !['flow', 'side'].includes(key)).sort(),
      ['category', 'glyph', 'id', 'klass', 'merchant', 'purpose', 're', 'review'],
      rule.id,
    );
    assert.ok(typeof rule.id === 'string' && /^[a-z0-9-]+$/.test(rule.id), rule.id);
    assert.ok(!ids.has(rule.id), 'duplicate id ' + rule.id);
    ids.add(rule.id);
    assert.equal(typeof rule.re, 'string', rule.id);
    assert.doesNotThrow(() => new RegExp(rule.re, 'i'), rule.id);
    assert.ok(!new RegExp(rule.re, 'i').test(''), rule.id + ' must not match empty text');
    assert.ok(Object.hasOwn(CATEGORIES, rule.category) || Object.hasOwn(FLOW_CATEGORIES, rule.category), rule.id);
    assert.ok(Object.hasOwn(KLASSES, rule.klass), rule.id);
    assert.ok(PURPOSES.includes(rule.purpose), rule.id);
    assert.ok(rule.merchant === null || (typeof rule.merchant === 'string' && rule.merchant.length > 0), rule.id);
    assert.equal(typeof rule.review, 'boolean', rule.id);
    assert.ok(rule.glyph === null || rule.glyph === '??', rule.id);
    if ('flow' in rule) assert.ok(rule.flow === 'in' || rule.flow === 'out', rule.id);
    if ('side' in rule) assert.equal(rule.side, 'card', rule.id);
  }
});

test('rules-data: classes follow the category default, with two stated exceptions', () => {
  const deviations = MERCHANT_RULES
    .filter((rule) => Object.hasOwn(CATEGORIES, rule.category) && rule.klass !== CATEGORIES[rule.category].klass)
    .map((rule) => rule.id);
  assert.deepEqual(deviations.sort(), ['car-rental', 'nyc-fine']);
});

test('rules-data: only avoidable penalties carry the blunder glyph', () => {
  const marked = MERCHANT_RULES.filter((rule) => rule.glyph === '??');
  assert.deepEqual(marked.map((rule) => rule.id).sort(), ['late-fee', 'over-limit-fee', 'overdraft-fee']);
  for (const rule of marked) assert.equal(rule.category, 'fees_interest');
  const penalty = new RegExp(PENALTY_RE, 'i');
  assert.ok(penalty.test('late fee') && penalty.test('overdraft fee') && penalty.test('over limit fee') && penalty.test('returned payment fee'));
  assert.ok(!penalty.test('interest charge on purchases'));
  assert.ok(!penalty.test('annual membership fee'));
});

test('rules-data: pattern sources and the MCC table are plain, valid data', () => {
  for (const [name, source] of Object.entries({ TRANSFER_RE, PAYMENT_RE, INCOME_RE, REFUND_RE, CASH_RE, PENALTY_RE })) {
    assert.equal(typeof source, 'string', name);
    assert.doesNotThrow(() => new RegExp(source, 'i'), name);
    assert.ok(!new RegExp(source, 'i').test(''), name + ' must not match empty text');
  }
  assert.ok(Array.isArray(NOISE) && NOISE.length > 10);
  for (const source of NOISE) assert.doesNotThrow(() => new RegExp(source, 'gi'), source);
  assert.ok(Object.keys(MCC).length > 100);
  for (const [code, category] of Object.entries(MCC)) {
    assert.match(code, /^\d{4}$/);
    assert.ok(Object.hasOwn(CATEGORIES, category), code + ' -> ' + category);
  }
  assert.ok(new RegExp(TRANSFER_RE, 'i').test('online transfer to sav'));
  assert.ok(new RegExp(PAYMENT_RE, 'i').test('capital one mobile pymt'));
  assert.ok(new RegExp(INCOME_RE, 'i').test('acme corp payroll'));
  assert.ok(new RegExp(REFUND_RE, 'i').test('merchandise return'));
  assert.ok(new RegExp(CASH_RE, 'i').test('atm withdrawal 123 broadway'));
});

test('module rules: allowed imports only, no clock, no default export', () => {
  const classifySource = readFileSync(new URL('../js/model/classify.js', import.meta.url), 'utf8');
  const dataSource = readFileSync(new URL('../js/model/rules-data.js', import.meta.url), 'utf8');
  const imported = [...classifySource.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(imported, ['./dates.js', './money.js', './rules-data.js', './schema.js']);
  assert.ok(!/^\s*import\b/m.test(dataSource), 'rules-data.js imports nothing');
  for (const source of [classifySource, dataSource]) {
    assert.ok(!/Date\.now|new Date\(|\bimport\(|export default|export \*|\bawait\b|document\.|window\.|localStorage|\bfetch\(|\beval\(|new Function/.test(source));
    for (const line of source.split('\n')) if (/\bexport\b/.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line)) assert.match(line, /^export /);
  }
});

test('rules-data: a broken pattern or a junk rule is skipped, never fatal', async () => {
  const junk = [
    { id: 'broken', re: '(((', category: 'gifts', klass: 'want', purpose: 'personal', merchant: 'Broken', review: false, glyph: null },
    { id: 'no-category', re: 'starbucks', category: 'nonsense', klass: 'want', purpose: 'personal', merchant: 'Nope', review: false, glyph: null },
    { id: 'no-pattern', re: null, category: 'gifts' }, { re: 'starbucks', category: 'gifts' }, null, undefined, 7, 'starbucks', [],
  ];
  MERCHANT_RULES.unshift(...junk);
  NOISE.unshift('[a-', null, 7);
  try {
    // a query string loads a second copy of the module, which compiles the damaged data
    const fresh = await import('../js/model/classify.js?damaged-rules');
    const result = fresh.classify({ description: 'Debit Card Purchase - STARBUCKS STORE 12345 NEW YORK NY', amount: 500, flow: 'out', accountType: 'checking' });
    assertCoherent(result);
    assert.deepEqual(pick(result, ['category', 'merchant', 'mkey', 'ruleId']), { category: 'cafe', merchant: 'Starbucks', mkey: 'starbucks', ruleId: 'builtin:starbucks' });
    assert.equal(fresh.normalizeDescription('POS DEBIT SQ *BIRCH COFFEE 0423 NEW YORK NY'), 'birch coffee');
  } finally {
    MERCHANT_RULES.splice(0, junk.length);
    NOISE.splice(0, 3);
  }
  assert.equal(MERCHANT_RULES[0].id, 'fee-reversal');
});

/* ------------------------------------------- the researcher's descriptor cases */

/** [bank descriptor, category, class] — purchases, as they print on US statements. */
const SPEND_CASES = [
  ['Debit Card Purchase - STARBUCKS STORE 12345 NEW YORK NY', 'cafe', 'game'],
  ['SQ *VARIETY COFFEE ROASTE Brooklyn NY', 'cafe', 'game'],
  ['TST* JOE COFFEE - 13TH ST NEW YORK NY', 'cafe', 'game'],
  ['DUNKIN #345678 Q35 JACKSON HEIGHT NY', 'cafe', 'game'],
  ['BLANK STREET COFFEE NEW YORK NY', 'cafe', 'game'],
  ['SQ *ZUCKERS BAGELS New York NY', 'cafe', 'game'],
  ['PRET A MANGER 0123 NEW YORK NY', 'cafe', 'game'],
  ['KUNG FU TEA FLUSHING NY', 'cafe', 'game'],
  ['CAPITAL ONE CAFE UNION SQ NEW YORK NY', 'cafe', 'game'],
  ['CHECKCARD 1103 STARBUCKS STORE 12345 NEW YORK NY 24692165308100123456789', 'cafe', 'game'],
  ['ATM Withdrawal - 123 BROADWAY NEW YORK NY', 'cash_withdrawal', 'need'],
  ['NON-CHASE ATM WITHDRAW 123456 11/03 BROOKLYN NY', 'cash_withdrawal', 'need'],
  ['Debit Card Purchase - 86 GOURMET DELI NEW YORK NY', 'convenience', 'game'],
  ['STOP 1 DELI GROCERY BROOKLYN NY', 'convenience', 'game'],
  ['A&M FOOD CORP BRONX NY', 'convenience', 'game'],
  ['LUCKY STAR CONVENIENCE ASTORIA NY', 'convenience', 'game'],
  ['7-ELEVEN 34567 NEW YORK NY', 'convenience', 'game'],
  ['HUDSON NEWS ST1234 NEW YORK NY', 'convenience', 'game'],
  ['USA*CANTEEN VENDING NEW YORK NY', 'convenience', 'game'],
  ['CTLP*SNACK SODA VENDING LONG ISLAND CI NY', 'convenience', 'game'],
  ['SUNNY DELI & GRILL QUEENS NY', 'convenience', 'game'],
  ['SUPREME DELI CORP NEW YORK NY', 'convenience', 'game'],
  ['SBA EIDL LOAN PAYMENT', 'debt_service', 'book'],
  ['AFFIRM * PAY 1234ABCD', 'debt_service', 'book'],
  ['UBER *EATS HELP.UBER.COM CA', 'delivery', 'game'],
  ['DD *DOORDASH CHIPOTLE 855-431-0459 CA', 'delivery', 'game'],
  ['GRUBHUB*HALALGUYS', 'delivery', 'game'],
  ['SEAMLSS*THAIVILLA', 'delivery', 'game'],
  ['CHIPOTLE 2345 NEW YORK NY', 'eating_out', 'game'],
  ['SWEETGREEN UNION SQ NEW YORK NY', 'eating_out', 'game'],
  ['SUBWAY 45678 BROOKLYN NY', 'eating_out', 'game'],
  ['JOES PIZZA CARMINE ST NEW YORK NY', 'eating_out', 'game'],
  ['TST* LOS TACOS NO 1 NEW YORK NY', 'eating_out', 'game'],
  ['THE HALAL GUYS NEW YORK NY', 'eating_out', 'game'],
  ['MCDONALD\'S F12345 NEW YORK NY', 'eating_out', 'game'],
  ['BENTO BOX SUSHI NEW YORK NY', 'eating_out', 'game'],
  ['US CHESS FEDERATION 931-787-1234 TN', 'education', 'oneoff'],
  ['CONTINENTAL CHESS ASSN', 'education', 'oneoff'],
  ['MARSHALL CHESS CLUB NEW YORK NY', 'education', 'oneoff'],
  ['Prime Video *1A2B3C4D5 888-802-3080 WA', 'entertainment', 'want'],
  ['Kindle Svcs*1A2B3C4D5 888-802-3080 WA', 'entertainment', 'want'],
  ['TM *TICKETMASTER 800-653-8000 CA', 'entertainment', 'want'],
  ['AMC 34TH ST 14 NEW YORK NY', 'entertainment', 'want'],
  ['ASTOR WINES & SPIRITS NEW YORK NY', 'entertainment', 'want'],
  ['INTEREST CHARGE:PURCHASES', 'fees_interest', 'need'],
  ['PAST DUE FEE', 'fees_interest', 'need'],
  ['PURCHASE INTEREST CHARGE', 'fees_interest', 'need'],
  ['ANNUAL MEMBERSHIP FEE', 'fees_interest', 'need'],
  ['SHELL OIL 57412345678 YONKERS NY', 'fuel_auto', 'need'],
  ['EXXONMOBIL 12345678 BRONX NY', 'fuel_auto', 'need'],
  ['ZIPCAR 866-494-7227 MA', 'fuel_auto', 'oneoff'],
  ['SWEETWATER SOUND 800-222-4700 IN', 'gear', 'oneoff'],
  ['GUITAR CENTER #812 NEW YORK NY', 'gear', 'oneoff'],
  ['B&H PHOTO 800-606-6969 NY', 'gear', 'oneoff'],
  ['REVERB.COM*GEAR CHICAGO IL', 'gear', 'oneoff'],
  ['VINTAGE KING AUDIO FERNDALE MI', 'gear', 'oneoff'],
  ['UNIVERSAL AUDIO INC SCOTTS VALLEY CA', 'gear', 'oneoff'],
  ['BESTBUYCOM806123456789 MN', 'gear', 'oneoff'],
  ['APPLE STORE #R095 NEW YORK NY', 'gear', 'oneoff'],
  ['IC* INSTACART*123 SAN FRANCISCO CA', 'groceries', 'need'],
  ['TRADER JOE S #123 NEW YORK NY', 'groceries', 'need'],
  ['KEY FOOD 1234 ASTORIA NY', 'groceries', 'need'],
  ['WHOLEFDS UNS 10160 NEW YORK NY', 'groceries', 'need'],
  ['CTOWN SUPERMARKET BRONX NY', 'groceries', 'need'],
  ['H MART MANHATTAN NEW YORK NY', 'groceries', 'need'],
  ['FRESHDIRECT 866-283-7374 NY', 'groceries', 'need'],
  ['AMAZON FRESH NEW YORK NY', 'groceries', 'need'],
  ['AMZN TIPS*AB1CD2EF3', 'groceries', 'need'],
  ['PURCHASE AUTHORIZED ON 11/03 TRADER JOE S #543 NEW YORK NY S306307512345678 CARD 1234', 'groceries', 'need'],
  ['DUANE READE #14123 NEW YORK NY', 'health', 'need'],
  ['CVS/PHARMACY #02345 BROOKLYN NY', 'health', 'need'],
  ['CITYMD URGENT CARE NEW YORK NY', 'health', 'need'],
  ['BLINK FITNESS 866-123-4567 NY', 'health', 'need'],
  ['PLANET FIT ANNUAL FEE 866-123-4567', 'health', 'need'],
  ['THE HOME DEPOT #1234 BROOKLYN NY', 'household', 'need'],
  ['IKEA BROOKLYN NY', 'household', 'need'],
  ['CSC SERVICEWORKS 877-264-6622', 'household', 'need'],
  ['MANHATTAN MINI STORAGE NEW YORK NY', 'housing', 'book'],
  ['BILT RENT PAYMENT', 'housing', 'book'],
  ['Withdrawal from ACME REALTY MGMT LLC RENT', 'housing', 'book'],
  ['GEICO *AUTO 800-841-3000 DC', 'insurance', 'book'],
  ['OSCAR HEALTH INSURANCE', 'insurance', 'book'],
  ['Zelle money sent to ALEX EXAMPLE', 'other', 'need'],
  ['VENMO PAYMENT 1023456789012', 'other', 'need'],
  ['PINTEREST ADS', 'other', 'need'],
  ['SQ *BROOKLYN FLEA Brooklyn NY', 'other', 'need'],
  ['CHECK # 1042', 'other', 'need'],
  ['SHOPPERS WORLD BROOKLYN NY', 'other', 'need'],
  ['RENT THE RUNWAY 800-509-0842 NY', 'other', 'need'],
  ['VZWRLSS*APOCC VISB 800-922-0204 FL', 'phone_internet', 'book'],
  ['SPECTRUM 855-707-7328 NY', 'phone_internet', 'book'],
  ['VERIZON*FIOS ONETIMEPAY', 'phone_internet', 'book'],
  ['T-MOBILE*AUTO PAY 800-937-8997 WA', 'phone_internet', 'book'],
  ['TMOBILE*POSTPAID PDA BELLEVUE WA', 'phone_internet', 'book'],
  ['UBER *TRIP HELP.UBER.COM CA', 'rideshare', 'want'],
  ['LYFT *RIDE SUN 9PM LYFT.COM CA', 'rideshare', 'want'],
  ['NYC TAXI 4M12 LONG ISLAND C NY', 'rideshare', 'want'],
  ['CURB NYC TAXI', 'rideshare', 'want'],
  ['AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA', 'shopping', 'want'],
  ['AMAZON.COM*1A2BC34D5 AMZN.COM/BILL WA', 'shopping', 'want'],
  ['AMAZON RETA* 123ABC456 WWW.AMAZON.CO WA', 'shopping', 'want'],
  ['TARGET 00012345 BROOKLYN NY', 'shopping', 'want'],
  ['UNIQLO 5TH AVE NEW YORK NY', 'shopping', 'want'],
  ['EBAY O*12-34567-89012 SAN JOSE CA', 'shopping', 'want'],
  ['PAYPAL *JOHNSMITH', 'shopping', 'want'],
  ['Amazon web services aws.amazon.co WA', 'software', 'oneoff'],
  ['PAYPAL *PLUGINBOUTI 402-935-7733', 'software', 'oneoff'],
  ['SPLICE.COM* SOUNDS NEW YORK NY', 'software', 'oneoff'],
  ['WAVES AUDIO LTD KNOXVILLE TN', 'software', 'oneoff'],
  ['AVID TECHNOLOGY 978-640-6789 MA', 'software', 'oneoff'],
  ['DRI*AVID PRO TOOLS', 'software', 'oneoff'],
  ['IZOTOPE INC CAMBRIDGE MA', 'software', 'oneoff'],
  ['DISTROKID 646-651-1248 NY', 'software', 'oneoff'],
  ['DROPBOX*ABC123DEF456 DROPBOX.COM CA', 'software', 'oneoff'],
  ['ADOBE *CREATIVE CLOUD 408-536-6000 CA', 'software', 'oneoff'],
  ['CHESS.COM 800-318-2827 CA', 'software', 'oneoff'],
  ['PAYPAL *CHESSABLE', 'software', 'oneoff'],
  ['LICHESS.ORG PATRON', 'software', 'oneoff'],
  ['CHESSBASE USA', 'software', 'oneoff'],
  ['GUSTO FEE 123456', 'software', 'oneoff'],
  ['UBER *ONE MEMBERSHIP', 'subscriptions', 'book'],
  ['Amazon Prime*1Z2YX3WV4 Amzn.com/bill WA', 'subscriptions', 'book'],
  ['Audible*AB12C34D5 Amzn.com/bill NJ', 'subscriptions', 'book'],
  ['APPLE.COM/BILL 866-712-7753 CA', 'subscriptions', 'book'],
  ['GOOGLE *Google One g.co/helppay CA', 'subscriptions', 'book'],
  ['NETFLIX.COM 866-579-7172 CA', 'subscriptions', 'book'],
  ['SPOTIFY USA 877-778-1161 NY', 'subscriptions', 'book'],
  ['GOOGLE *YouTubePremium g.co/helppay CA', 'subscriptions', 'book'],
  ['NYTIMES*NYTIMES 800-698-4637 NY', 'subscriptions', 'book'],
  ['PAYPAL INST XFER SPOTIFYUSA WEB ID: PAYPALSI77', 'subscriptions', 'book'],
  ['WHOLESALE CHESS 801-123-4567 UT', 'supplies', 'need'],
  ['STAPLES 00112345 NEW YORK NY', 'supplies', 'need'],
  ['USPS PO 3512340123 NEW YORK NY', 'supplies', 'need'],
  ['E-ZPASS NY REBILL 800-333-8655 NY', 'tolls_parking', 'need'],
  ['MTA B&T TOLLS BY MAIL', 'tolls_parking', 'need'],
  ['NYCDOT PARKNYC NEW YORK NY', 'tolls_parking', 'need'],
  ['ICON PARKING 1234 NEW YORK NY', 'tolls_parking', 'need'],
  ['NYC DOF PARKING/CAMERA VIOLATION', 'tolls_parking', 'oneoff'],
  ['SPOTHERO 844-324-7768 IL', 'tolls_parking', 'need'],
  ['PITTSBURGH*PARKING AUTH', 'tolls_parking', 'need'],
  ['LYFT *CITI BIKE NEW YORK NY', 'transit', 'need'],
  ['CITIBIK*ANNUAL MEMBERSHIP', 'transit', 'need'],
  ['MTA*NYCT PAYGO NEW YORK NY', 'transit', 'need'],
  ['OMNY MTA NYCT', 'transit', 'need'],
  ['MTA*LIRR ETIX TICKET', 'transit', 'need'],
  ['NJT RAIL MYTIX NEWARK NJ', 'transit', 'need'],
  ['PATH TAPP PAYGO CP JERSEY CITY NJ', 'transit', 'need'],
  ['MNR ETIX TICKET NEW YORK NY', 'transit', 'need'],
  ['LIRR ETIX TICKET NEW YORK NY', 'transit', 'need'],
  ['MARRIOTT PHILADELPHIA DOWNTOWN', 'travel', 'want'],
  ['Withdrawal from CON ED OF NY INTELL CK', 'utilities', 'book'],
  ['NATIONAL GRID NY UTILITYPAY', 'utilities', 'book'],
  ['NGRID08 DES:NGRID08WEB', 'utilities', 'book'],
];

test('built-in rules: statement descriptors land in the right category and class', () => {
  for (const [descriptor, category, klass] of SPEND_CASES) {
    const result = run(descriptor);
    assertCoherent(result, descriptor);
    assert.equal(result.kind, 'spend', descriptor);
    assert.equal(result.category, category, descriptor);
    assert.equal(result.klass, klass, descriptor);
  }
});

test('built-in rules: a purchase is the same purchase on a card', () => {
  for (const [descriptor, category, klass] of SPEND_CASES) {
    const result = run(descriptor, 'out', 'credit_card');
    assertCoherent(result, descriptor);
    assert.deepEqual([result.kind, result.category, result.klass], ['spend', category, klass], descriptor);
  }
});

test('built-in rules: classes follow the translation (convenience food is the daily game)', () => {
  for (const [descriptor, category, klass] of SPEND_CASES) {
    if (['NYC DOF PARKING/CAMERA VIOLATION', 'ZIPCAR 866-494-7227 MA'].includes(descriptor)) assert.equal(klass, 'oneoff');
    else assert.equal(klass, klassOf(category), descriptor);
  }
  assert.equal(run('SQ *VARIETY COFFEE ROASTE Brooklyn NY').klass, 'game');
  assert.equal(run('UBER *TRIP HELP.UBER.COM CA').klass, 'want');
  assert.equal(run('TM *TICKETMASTER 800-653-8000 CA').klass, 'want');
  assert.equal(run('MTA*NYCT PAYGO NEW YORK NY').klass, 'need');
});

test('built-in rules: descriptors nothing recognises fall back to "other" for review', () => {
  for (const descriptor of ['PINTEREST ADS', 'SHOPPERS WORLD BROOKLYN NY', 'RENT THE RUNWAY 800-509-0842 NY', 'ZXQV HOLDINGS 4471']) {
    const result = run(descriptor);
    assertCoherent(result, descriptor);
    assert.deepEqual(pick(result, ['kind', 'category', 'klass', 'purpose', 'review', 'ruleId', 'glyph']),
      { kind: 'spend', category: 'other', klass: 'need', purpose: 'personal', review: true, ruleId: null, glyph: null }, descriptor);
  }
});

test('built-in rules: Amazon in its descriptor forms is shopping for review; its named services are not', () => {
  const forms = [
    'AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA', 'AMAZON.COM*1A2BC34D5 AMZN.COM/BILL WA', 'AMAZON RETA* 123ABC456 WWW.AMAZON.CO WA',
    'Amazon.com*AB12C34D5', 'AMZN MKTP US', 'AMAZON MKTPL*ZZ9YY8XX7', 'AMAZON MARK* 1A2B3C4D5', 'Debit Card Purchase - AMZN MKTP US*1Q2W3E4R5 SEATTLE WA',
  ];
  for (const descriptor of forms) {
    const result = run(descriptor, 'out', 'credit_card');
    assert.deepEqual(pick(result, ['kind', 'category', 'klass', 'review', 'merchant', 'mkey', 'ruleId']),
      { kind: 'spend', category: 'shopping', klass: 'want', review: true, merchant: 'Amazon', mkey: 'amazon', ruleId: 'builtin:amazon' }, descriptor);
  }
  assert.deepEqual(pick(run('Amazon Prime*1Z2YX3WV4 Amzn.com/bill WA'), ['category', 'klass', 'merchant']), { category: 'subscriptions', klass: 'book', merchant: 'Amazon Prime' });
  assert.deepEqual(pick(run('Prime Video *1A2B3C4D5 888-802-3080 WA'), ['category', 'merchant']), { category: 'entertainment', merchant: 'Prime Video' });
  assert.deepEqual(pick(run('Amazon web services aws.amazon.co WA'), ['category', 'purpose', 'merchant']), { category: 'software', purpose: 'studio', merchant: 'Amazon Web Services' });
  assert.equal(run('AMAZON FRESH NEW YORK NY').category, 'groceries');
  assert.equal(run('WHOLEFDS UNS 10160 NEW YORK NY').merchant, 'Whole Foods');
});

test('built-in rules: purposes are translated (chess is coaching, the studio is studio)', () => {
  const expected = [
    ['CHESS.COM 800-318-2827 CA', 'coaching'], ['PAYPAL *CHESSABLE', 'coaching'], ['WHOLESALE CHESS 801-123-4567 UT', 'coaching'],
    ['MARSHALL CHESS CLUB NEW YORK NY', 'coaching'], ['SWEETWATER SOUND 800-222-4700 IN', 'studio'], ['DRI*AVID PRO TOOLS', 'studio'],
    ['ABLETON AG BERLIN', 'studio'], ['IZOTOPE INC CAMBRIDGE MA', 'studio'], ['STARBUCKS STORE 12345 NEW YORK NY', 'personal'],
    ['Deposit from KNIGHTS ACADEMY INC PAYROLL', 'work'],
  ];
  for (const [descriptor, purpose] of expected) {
    const flow = purpose === 'work' ? 'in' : 'out';
    assert.equal(run(descriptor, flow).purpose, purpose, descriptor);
  }
  for (const rule of MERCHANT_RULES) assert.ok(rule.purpose !== 'chess' && rule.purpose !== 'unknown', rule.id);
});

test('built-in rules: New York coverage beyond the ported cases', () => {
  const expected = [
    ['GREGORYS COFFEE 0042 NEW YORK NY', 'cafe', 'Gregorys Coffee'],
    ['SQ *BIRCH COFFEE NEW YORK NY', 'cafe', 'Birch Coffee'],
    ['BLUE BOTTLE COFFEE NEW YORK NY', 'cafe', 'Blue Bottle Coffee'],
    ['TST* THINK COFFEE NEW YORK NY', 'cafe', 'Think Coffee'],
    ['787 COFFEE NEW YORK NY', 'cafe', '787 Coffee'],
    ['CITIBIKE NYC BIKE SHARE', 'transit', 'Citi Bike'],
    ['CON EDISON CO OF NY', 'utilities', 'Con Edison'],
    ['ACH PMT CON ED OF NY', 'utilities', 'Con Edison'],
    ['WALGREENS #1234', 'health', 'Walgreens'],
    ['RITE AID 04512 BROOKLYN NY', 'health', 'Rite Aid'],
    ['FOOD BAZAAR 0012 BROOKLYN NY', 'groceries', 'Food Bazaar'],
    ['WESTERN BEEF 044 RIDGEWOOD NY', 'groceries', 'Western Beef'],
    ['LYFT *RIDE SUN 9PM LYFT.COM CA', 'rideshare', 'Lyft'],
    ['NYC TAXI 7K33 NEW YORK NY', 'rideshare', 'NYC taxi'],
    ['GOOGLE *FI 1A2B3C', 'phone_internet', 'Google Fi'],
    ['NETFLIX.COM 866-579-7172 CA', 'subscriptions', 'Netflix'],
    ['SAM ASH MUSIC 0031 NEW YORK NY', 'gear', 'Sam Ash'],
    ['FABFILTER SOFTWARE', 'software', 'FabFilter'],
    ['SOUNDTOYS INC', 'software', 'Soundtoys'],
    ['LICHESS.ORG PATRON', 'software', 'Lichess'],
  ];
  for (const [descriptor, category, merchant] of expected) {
    const result = run(descriptor);
    assert.deepEqual([result.category, result.merchant], [category, merchant], descriptor);
  }
});

/* ----------------------------------------------------------- noise stripping */

test('normalizeDescription: strips processor prefixes, bank verbs, numbers and place tails', () => {
  const expected = [
    ['POS DEBIT SQ *BIRCH COFFEE 0423 NEW YORK NY', 'birch coffee'],
    ['Debit Card Purchase - STARBUCKS STORE 12345 NEW YORK NY', 'starbucks'],
    ['CHECKCARD 1103 STARBUCKS STORE 12345 NEW YORK NY 246921653', 'starbucks'],
    ['PURCHASE AUTHORIZED ON 11/03 TRADER JOE S #543 NEW YORK NY CARD 1234', 'trader joe s'],
    ['TST* JOE COFFEE - 13TH ST NEW YORK NY', 'joe coffee - 13th st'],
    ['PAYPAL *PLUGINBOUTI 402-935-7733', 'pluginbouti'],
    ['APLPAY SWEETGREEN UNION SQ NEW YORK NY', 'sweetgreen union sq'],
    ['PENDING - DUNKIN #345678 Q35', 'dunkin q35'],
    ['SQ *SQ *CHESS LESSONS WITH SAM', 'chess lessons with sam'],
    ['ACME WIDGETS LLC', 'acme widgets'],
    ['www.example.com 800-555-1212', 'example.com'],
    ['   lots    of\t\n spaces   ', 'lots of spaces'],
    ['JOE\'S PIZZA &amp; PASTA', 'joe\'s pizza & pasta'],
    ['787 COFFEE NEW YORK NY', '787 coffee'],
  ];
  for (const [raw, clean] of expected) assert.equal(normalizeDescription(raw), clean, raw);
});

test('normalizeDescription: keeps a two-word name whole; output is lower-case, trimmed and single-spaced', () => {
  assert.equal(normalizeDescription('DELI NY'), 'deli ny');
  for (const [descriptor] of SPEND_CASES) {
    const once = normalizeDescription(descriptor);
    assert.equal(once, once.toLowerCase(), descriptor);
    assert.equal(once, once.trim(), descriptor);
    assert.ok(!/\s{2}/.test(once), descriptor);
    assert.ok(once.length > 0 && once.length <= descriptor.length, descriptor);
  }
});

test('normalizeDescription: the same row with a different date, card suffix or reference normalises alike', () => {
  const a = normalizeDescription('PURCHASE AUTHORIZED ON 11/03 MARIAS KITCHEN BROOKLYN NY S306307512345678 CARD 1234');
  const b = normalizeDescription('PURCHASE AUTHORIZED ON 12/19 MARIAS KITCHEN BROOKLYN NY S998877665544332 CARD 9876');
  assert.equal(a, 'marias kitchen');
  assert.equal(b, a);
});

test('normalizeDescription: anything that is not text is the empty string', () => {
  for (const value of [null, undefined, 42, {}, [], true, NaN, () => 'x']) assert.equal(normalizeDescription(value), '');
  assert.equal(normalizeDescription(''), '');
  assert.equal(normalizeDescription('     '), '');
});

/* --------------------------------------------------------- names and keys */

test('merchantOf: a chain has one name and one key across store numbers, cities and prefixes', () => {
  const chains = [
    ["Dunkin'", 'dunkin', ['DUNKIN #345123 NEW YORK NY', 'DUNKIN #300112 BOSTON MA', 'SQ *DUNKIN DONUTS Q35 JACKSON HEIGHT NY', 'Debit Card Purchase - DUNKIN #345678 Q35 JACKSON HEIGHT NY', 'PENDING - DUNKIN 0099']],
    ['Starbucks', 'starbucks', ['STARBUCKS STORE 12345 NEW YORK NY', 'STARBUCKS STORE 00455 CHICAGO IL', 'STARBUCKS 800-782-7282 WA', 'CHECKCARD 1103 STARBUCKS STORE 12345 NEW YORK NY 246921653', 'APLPAY STARBUCKS #8841 SEATTLE WA']],
    ["Trader Joe's", 'trader joes', ['TRADER JOE S #123 NEW YORK NY', 'TRADER JOE\'S #543 BROOKLYN NY', 'PURCHASE AUTHORIZED ON 11/03 TRADER JOE S #543 NEW YORK NY S306307512345678 CARD 1234']],
    ['Chipotle', 'chipotle', ['CHIPOTLE 2345 NEW YORK NY', 'CHIPOTLE ONLINE 1877 DENVER CO', 'TST* CHIPOTLE 0911']],
    ['MTA subway and bus', 'mta subway and bus', ['MTA*NYCT PAYGO NEW YORK NY', 'OMNY MTA NYCT', 'MTA*NYCT PAYGO 2125551212 NY']],
    ['Amazon', 'amazon', ['AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA', 'AMZN Mktp US*9Z8Y7X6W5 Amzn.com/bill WA', 'AMAZON.COM*1A2BC34D5 AMZN.COM/BILL WA']],
    ['CVS', 'cvs', ['CVS/PHARMACY #02345 BROOKLYN NY', 'CVS/PHARMACY #10112 NEW YORK NY']],
  ];
  for (const [merchant, mkey, descriptors] of chains) {
    for (const description of descriptors) assert.deepEqual(merchantOf({ description }), { merchant, mkey }, description);
  }
});

test('merchantOf: an independent shop is title-cased and keyed the same on every visit', () => {
  assert.deepEqual(merchantOf({ description: 'SUPREME DELI CORP NEW YORK NY' }), { merchant: 'Supreme Deli', mkey: 'supreme deli' });
  assert.deepEqual(merchantOf({ description: 'Debit Card Purchase - SUPREME DELI CORP #2 NEW YORK NY' }), { merchant: 'Supreme Deli', mkey: 'supreme deli' });
  assert.deepEqual(merchantOf({ description: '86 GOURMET DELI NEW YORK NY' }), { merchant: '86 Gourmet Deli', mkey: '86 gourmet deli' });
  assert.deepEqual(merchantOf({ description: 'A&M FOOD CORP BRONX NY' }), { merchant: 'A&M Food', mkey: 'a m food' });
  assert.deepEqual(merchantOf({ description: 'NYC DELI & MTA NEWS' }).merchant, 'NYC Deli & MTA News');
  assert.deepEqual(merchantOf({ description: 'DEVOCIÓN BROOKLYN NY' }), { merchant: 'Devocion', mkey: 'devocion' });
  assert.deepEqual(merchantOf({ description: 'CAFÉ ÀLA MODE BROOKLYN NY' }), { merchant: 'Café Àla Mode', mkey: 'cafe ala mode' });
});

test('merchantOf: payee and memo are read only when the description says nothing useful', () => {
  assert.deepEqual(merchantOf({ description: 'CARD PURCHASE 9912', payee: 'TRADER JOE S #543' }), { merchant: "Trader Joe's", mkey: 'trader joes' });
  assert.deepEqual(merchantOf({ description: 'STARBUCKS STORE 1', payee: 'DUNKIN', memo: 'CHIPOTLE' }), { merchant: 'Starbucks', mkey: 'starbucks' });
  assert.deepEqual(merchantOf({ description: null, payee: undefined, memo: 'LYFT *RIDE' }), { merchant: 'Lyft', mkey: 'lyft' });
});

test('merchantOf: text with nothing usable is Unknown with an empty key', () => {
  const unknown = { merchant: 'Unknown', mkey: '' };
  for (const parts of [null, undefined, {}, { description: '' }, { description: '   ' }, { description: null }, { description: 42 }, { description: '(((' }, { description: '🍕🍕🍕' }, { description: '***' }, 7, []]) {
    assert.deepEqual(merchantOf(parts), unknown);
  }
});

test('merchantOf and classify agree on the counterparty, whatever the flow or the account', () => {
  for (const [descriptor] of SPEND_CASES) {
    const identity = merchantOf({ description: descriptor });
    for (const [flow, accountType] of [['out', 'checking'], ['in', 'checking'], ['out', 'credit_card'], ['in', 'credit_card'], ['in', 'loan'], ['out', 'investment']]) {
      const result = run(descriptor, flow, accountType);
      assertCoherent(result, descriptor);
      assert.deepEqual({ merchant: result.merchant, mkey: result.mkey }, identity, `${descriptor} ${flow} ${accountType}`);
    }
  }
});

/* -------------------------------------------------- kinds: cash versus card */

test('kinds on a cash account', () => {
  const expected = [
    // description, flow, kind, category
    ['STARBUCKS STORE 12345 NEW YORK NY', 'out', 'spend', 'cafe'],
    ['CAPITAL ONE MOBILE PYMT', 'out', 'payment', 'card_payment'],
    ['Withdrawal from CAPITAL ONE MOBILE PMT', 'out', 'payment', 'card_payment'],
    ['CAPITAL ONE AUTOPAY PYMT', 'out', 'payment', 'card_payment'],
    ['Withdrawal from AMEX EPAYMENT ACH PMT', 'out', 'payment', 'card_payment'],
    ['CHASE CREDIT CRD AUTOPAY', 'out', 'payment', 'card_payment'],
    ['Withdrawal to 360 Performance Savings XXXXXXX1234', 'out', 'transfer', 'transfer'],
    ['Online Transfer to SAV ...1234', 'out', 'transfer', 'transfer'],
    ['Deposit from 360 Checking XXXXXXX5678', 'in', 'transfer', 'transfer'],
    ['OVERDRAFT PROTECTION TRANSFER FROM SAVINGS', 'in', 'transfer', 'transfer'],
    ['Deposit from KNIGHTS ACADEMY INC PAYROLL', 'in', 'income', 'income'],
    ['GUSTO PAY 123456 PPD', 'in', 'income', 'income'],
    ['SQUARE INC SQ241103 PPD', 'in', 'income', 'income'],
    ['Zelle money received from JORDAN SAMPLE', 'in', 'income', 'income'],
    ['VENMO CASHOUT PPD ID: 1234567890', 'in', 'income', 'income'],
    ['Check Deposit (Mobile)', 'in', 'income', 'income'],
    ['IRS TREAS 310 TAX REF', 'in', 'income', 'income'],
    ['Monthly Interest Paid', 'in', 'income', 'income'],
    ['INTEREST CREDIT', 'in', 'income', 'income'],
    ['SOME UNHEARD OF PAYER', 'in', 'income', 'income'],
    ['ATM FEE REBATE', 'in', 'refund', 'fees_interest'],
    ['AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA', 'in', 'refund', 'shopping'],
    ['REFUND MARIAS KITCHEN', 'in', 'refund', 'eating_out'],
    ['DEBIT CARD REFUND ZXQV HOLDINGS', 'in', 'refund', 'other'],
    ['ATM Withdrawal - 123 BROADWAY NEW YORK NY', 'out', 'spend', 'cash_withdrawal'],
    ['WIRE TRANSFER FEE', 'out', 'spend', 'fees_interest'],
    ['Zelle money sent to ALEX EXAMPLE', 'out', 'spend', 'other'],
    ['VENMO PAYMENT 1023456789012', 'out', 'spend', 'other'],
  ];
  for (const accountType of ['checking', 'savings', 'cash']) {
    for (const [description, flow, kind, category] of expected) {
      const result = run(description, flow, accountType);
      assertCoherent(result, description);
      assert.deepEqual([result.kind, result.category], [kind, category], `${description} (${accountType})`);
    }
  }
});

test('kinds on a cash account: what is certain and what is a guess', () => {
  assert.equal(run('Deposit from KNIGHTS ACADEMY INC PAYROLL', 'in').review, false);
  assert.equal(run('Withdrawal to 360 Performance Savings XXXXXXX1234').review, false);
  assert.equal(run('CAPITAL ONE MOBILE PYMT').review, false);
  assert.equal(run('SOME UNHEARD OF PAYER', 'in').review, true, 'an unexplained deposit is income, for review');
  assert.equal(run('Online Transfer to SAV ...1234').review, true, 'generic transfer wording could be to anyone');
  assert.equal(run('Zelle money sent to ALEX EXAMPLE').review, true);
  assert.equal(run('Zelle money received from JORDAN SAMPLE', 'in').review, true);
  assert.equal(run('MARIAS KITCHEN BROOKLYN NY', 'in').kind, 'income', 'an unnamed family rule does not make a refund by itself');
});

test('kinds on a card', () => {
  const expected = [
    ['STARBUCKS STORE 12345 NEW YORK NY', 'out', 'spend', 'cafe'],
    ['INTEREST CHARGE:PURCHASES', 'out', 'spend', 'fees_interest'],
    ['PURCHASE INTEREST CHARGE', 'out', 'spend', 'fees_interest'],
    ['ANNUAL MEMBERSHIP FEE', 'out', 'spend', 'fees_interest'],
    ['PAST DUE FEE', 'out', 'spend', 'fees_interest'],
    ['Payment Thank You-Mobile', 'in', 'payment', 'card_payment'],
    ['AUTOPAY PAYMENT - THANK YOU', 'in', 'payment', 'card_payment'],
    ['INTERNET PAYMENT - THANK YOU', 'in', 'payment', 'card_payment'],
    ['MOBILE PAYMENT - THANK YOU', 'in', 'payment', 'card_payment'],
    ['ONLINE PAYMENT, THANK YOU', 'in', 'payment', 'card_payment'],
    ['PAYMENT', 'in', 'payment', 'card_payment'],
    ['CAPITAL ONE MOBILE PYMT', 'in', 'payment', 'card_payment'],
    ['ACH DEPOSIT INTERNET TRANSFER FROM ACCOUNT ENDING IN 1234', 'in', 'payment', 'card_payment'],
    ['MTA*NYCT PAYGO NEW YORK NY', 'in', 'refund', 'transit'],
    ['AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA', 'in', 'refund', 'shopping'],
    ['SOME UNHEARD OF SHOP', 'in', 'refund', 'other'],
    ['LATE PAYMENT FEE REVERSAL', 'in', 'refund', 'fees_interest'],
    ['CASHBACK BONUS REDEMPTION', 'in', 'refund', 'other'],
    // wording that would be a transfer or income on a bank account is still a purchase on a card
    ['ROBINHOOD DEBITS', 'out', 'spend', 'other'],
    ['Online Transfer to SAV ...1234', 'out', 'spend', 'other'],
    ['ACME CORP PAYROLL SERVICES', 'out', 'spend', 'other'],
    ['VENMO *JOHN DOE', 'out', 'spend', 'other'],
  ];
  for (const [description, flow, kind, category] of expected) {
    const result = run(description, flow, 'credit_card');
    assertCoherent(result, description);
    assert.deepEqual([result.kind, result.category], [kind, category], description);
    assert.notEqual(result.kind, 'income', 'a card never earns income');
    assert.notEqual(result.kind, 'transfer', 'a card row is never a transfer');
  }
});

test('kinds: payment wording that only a card statement uses is not trusted on a bank account', () => {
  assert.equal(run('Payment Thank You-Mobile', 'in', 'checking').kind, 'income');
  assert.equal(run('ONLINE PAYMENT CON EDISON', 'out', 'checking').category, 'utilities');
  assert.equal(run('ONLINE PAYMENT CON EDISON', 'out', 'checking').kind, 'spend');
});

test('kinds: loans and investment accounts', () => {
  assert.deepEqual(pick(run('PRINCIPAL PAYMENT', 'in', 'loan'), ['kind', 'category']), { kind: 'payment', category: 'card_payment' });
  assert.deepEqual(pick(run('INTEREST CHARGE', 'out', 'loan'), ['kind', 'category', 'glyph']), { kind: 'spend', category: 'fees_interest', glyph: null });
  assert.deepEqual(pick(run('LATE FEE', 'out', 'loan'), ['kind', 'category', 'glyph']), { kind: 'spend', category: 'fees_interest', glyph: '??' });
  assert.equal(run('LOAN DISBURSEMENT', 'out', 'loan').kind, 'transfer');
  assert.deepEqual(pick(run('DIVIDEND PAID', 'in', 'investment'), ['kind', 'category']), { kind: 'income', category: 'income' });
  assert.equal(run('BUY VTI', 'out', 'investment').kind, 'transfer');
  assert.equal(run('CONTRIBUTION', 'in', 'investment').kind, 'transfer');
});

test('kinds: an unknown or missing account type is read as a cash account', () => {
  for (const accountType of [undefined, null, 'nonsense', 7, 'constructor', '__proto__', 'toString']) {
    assert.equal(run('STARBUCKS STORE 12345', 'out', accountType).kind, 'spend');
    assert.equal(run('Deposit from KNIGHTS ACADEMY INC PAYROLL', 'in', accountType).kind, 'income');
  }
});

/* ----------------------------------------------------------------- refunds */

test('refund: an in-flow that mirrors a recent spend at the same merchant takes its classification', () => {
  const recentSpends = [
    { mkey: 'starbucks', amount: 475 },
    { mkey: 'marias kitchen', amount: 1500, category: 'eating_out', klass: 'game', purpose: 'work' },
  ];
  const mirrored = classify({ description: 'MARIAS KITCHEN BROOKLYN NY', amount: 1500, flow: 'in', accountType: 'checking' }, { recentSpends });
  assert.deepEqual(pick(mirrored, ['kind', 'category', 'klass', 'purpose', 'review']), { kind: 'refund', category: 'eating_out', klass: 'game', purpose: 'work', review: false });

  const partial = classify({ description: 'MARIAS KITCHEN BROOKLYN NY', amount: 600, flow: 'in', accountType: 'checking' }, { recentSpends });
  assert.equal(partial.kind, 'refund', 'a partial refund still mirrors the larger spend');

  const tooLarge = classify({ description: 'MARIAS KITCHEN BROOKLYN NY', amount: 9900, flow: 'in', accountType: 'checking' }, { recentSpends });
  assert.equal(tooLarge.kind, 'income', 'more than was ever spent there is not a refund');

  const elsewhere = classify({ description: 'ZXQV HOLDINGS', amount: 1500, flow: 'in', accountType: 'checking' }, { recentSpends });
  assert.deepEqual(pick(elsewhere, ['kind', 'review']), { kind: 'income', review: true });

  const noContext = classify({ description: 'MARIAS KITCHEN BROOKLYN NY', amount: 1500, flow: 'in', accountType: 'checking' });
  assert.equal(noContext.kind, 'income');
});

test('refund: a mirror of an unrecognised merchant borrows the category of the spend', () => {
  const recentSpends = [{ mkey: 'zxqv holdings', amount: 4000, category: 'gear', klass: 'oneoff', purpose: 'studio' }];
  const result = classify({ description: 'ZXQV HOLDINGS 4471', amount: 4000, flow: 'in', accountType: 'checking' }, { recentSpends });
  assert.deepEqual(pick(result, ['kind', 'category', 'klass', 'purpose', 'review']), { kind: 'refund', category: 'gear', klass: 'oneoff', purpose: 'studio', review: false });
});

test('refund: transfers, pay and card payments are never turned into refunds by a mirror', () => {
  const recentSpends = [{ mkey: merchantOf({ description: 'Deposit from KNIGHTS ACADEMY INC PAYROLL' }).mkey, amount: 99999 }];
  assert.equal(classify({ description: 'Deposit from KNIGHTS ACADEMY INC PAYROLL', amount: 5000, flow: 'in', accountType: 'checking' }, { recentSpends }).kind, 'income');
  const own = [{ mkey: merchantOf({ description: 'Deposit from 360 Checking XXXXXXX5678' }).mkey, amount: 99999 }];
  assert.equal(classify({ description: 'Deposit from 360 Checking XXXXXXX5678', amount: 5000, flow: 'in', accountType: 'savings' }, { recentSpends: own }).kind, 'transfer');
  const pay = [{ mkey: merchantOf({ description: 'Payment Thank You-Mobile' }).mkey, amount: 99999 }];
  assert.equal(classify({ description: 'Payment Thank You-Mobile', amount: 5000, flow: 'in', accountType: 'credit_card' }, { recentSpends: pay }).kind, 'payment');
});

test('refund: reclassify finds the mirrored spend in the document, within 60 days', () => {
  const spend = bankTx('MARIAS KITCHEN BROOKLYN NY', { day: '2026-03-01', amount: 1500 });
  const refund = bankTx('MARIAS KITCHEN BROOKLYN NY', { day: '2026-03-10', amount: 1500, flow: 'in' });
  const stale = bankTx('MARIAS KITCHEN BROOKLYN NY', { day: '2026-06-15', amount: 1500, flow: 'in' });
  const before = bankTx('MARIAS KITCHEN BROOKLYN NY', { day: '2026-02-20', amount: 1500, flow: 'in' });
  const state = doc([spend, refund, stale, before]);
  reclassify(state);
  assert.deepEqual(pick(spend, ['kind', 'category', 'klass']), { kind: 'spend', category: 'eating_out', klass: 'game' });
  assert.deepEqual(pick(refund, ['kind', 'category', 'klass', 'review']), { kind: 'refund', category: 'eating_out', klass: 'game', review: false });
  assert.equal(stale.kind, 'income', 'a spend more than 60 days earlier is not mirrored');
  assert.equal(before.kind, 'income', 'a refund cannot come before its spend');
});

/* --------------------------------------------------------------- penalties */

test('penalties: only avoidable fees are blunders', () => {
  const penalties = [
    ['LATE FEE', 'credit_card'], ['LATE PAYMENT FEE', 'credit_card'], ['PAST DUE FEE', 'credit_card'], ['OVERLIMIT FEE', 'credit_card'],
    ['OVER LIMIT FEE', 'credit_card'], ['OVER-LIMIT FEE', 'credit_card'], ['RETURNED PAYMENT FEE', 'credit_card'],
    ['OVERDRAFT FEE', 'checking'], ['OVERDRAFT ITEM FEE 11/03', 'checking'], ['NSF FEE - ITEM RETURNED', 'checking'], ['INSUFFICIENT FUNDS FEE', 'checking'],
  ];
  for (const [description, accountType] of penalties) {
    const result = run(description, 'out', accountType);
    assertCoherent(result, description);
    assert.deepEqual(pick(result, ['kind', 'category', 'klass', 'glyph', 'review']), { kind: 'spend', category: 'fees_interest', klass: 'need', glyph: '??', review: false }, description);
  }
});

test('penalties: interest and ordinary fees are plain spends with no glyph', () => {
  const plain = [
    ['INTEREST CHARGE:PURCHASES', 'credit_card'], ['PURCHASE INTEREST CHARGE', 'credit_card'], ['INTEREST CHARGED ON PURCHASES', 'credit_card'],
    ['CASH ADVANCE INTEREST CHARGE', 'credit_card'], ['ANNUAL MEMBERSHIP FEE', 'credit_card'], ['FOREIGN TRANSACTION FEE', 'credit_card'],
    ['CASH ADVANCE FEE', 'credit_card'], ['WIRE TRANSFER FEE', 'checking'], ['MONTHLY SERVICE FEE', 'checking'], ['NON-CHASE ATM FEE', 'checking'],
  ];
  for (const [description, accountType] of plain) {
    const result = run(description, 'out', accountType);
    assert.deepEqual(pick(result, ['kind', 'category', 'glyph']), { kind: 'spend', category: 'fees_interest', glyph: null }, description);
  }
});

test('penalties: a reversed fee is a refund, and nothing but a spend ever carries a glyph', () => {
  const reversal = run('LATE PAYMENT FEE REVERSAL', 'in', 'credit_card');
  assert.deepEqual(pick(reversal, ['kind', 'category', 'glyph']), { kind: 'refund', category: 'fees_interest', glyph: null });
  assert.equal(run('OVERDRAFT FEE REFUND', 'in', 'checking').glyph, null);
  assert.equal(run('STARBUCKS LATE NIGHT STORE', 'out', 'checking').glyph, null);
});

/* ------------------------------------------------------------ MCC fallback */

test('mcc: used when no merchant rule names a category', () => {
  const coded = [['5812', 'eating_out', 'game'], ['5814', 'eating_out', 'game'], ['5411', 'groceries', 'need'], ['4121', 'rideshare', 'want'], ['5732', 'gear', 'oneoff'], ['4900', 'utilities', 'book'], ['3058', 'travel', 'want']];
  for (const [mcc, category, klass] of coded) {
    const result = run('ZXQV HOLDINGS 4471', 'out', 'credit_card', { mcc });
    assertCoherent(result, mcc);
    assert.deepEqual(pick(result, ['kind', 'category', 'klass', 'review', 'ruleId']), { kind: 'spend', category, klass, review: false, ruleId: 'mcc:' + mcc }, mcc);
  }
  assert.equal(run('ZXQV HOLDINGS', 'out', 'checking', { mcc: 5814 }).ruleId, 'mcc:5814', 'a numeric code is accepted');
  assert.equal(run('ZXQV HOLDINGS', 'out', 'checking', { mcc: ' 5814 ' }).category, 'eating_out');
});

test('mcc: a merchant rule beats the code; a bare processor rule does not', () => {
  const named = run('STARBUCKS STORE 12345', 'out', 'credit_card', { mcc: '5411' });
  assert.deepEqual(pick(named, ['category', 'ruleId']), { category: 'cafe', ruleId: 'builtin:starbucks' });
  const processor = run('SQ *BROOKLYN FLEA Brooklyn NY', 'out', 'credit_card', { mcc: '5814' });
  assert.deepEqual(pick(processor, ['category', 'klass', 'review', 'ruleId', 'merchant']), { category: 'eating_out', klass: 'game', review: false, ruleId: 'mcc:5814', merchant: 'Brooklyn Flea' });
});

test('mcc: unknown or malformed codes fall through to "other"', () => {
  for (const mcc of [null, undefined, '', 'abcd', '99999', '0000', '58', {}, [], NaN, -5812, 5812.5, 'constructor', '__proto__']) {
    const result = run('ZXQV HOLDINGS', 'out', 'credit_card', { mcc });
    assertCoherent(result, String(mcc));
    assert.deepEqual(pick(result, ['category', 'review', 'ruleId']), { category: 'other', review: true, ruleId: null }, String(mcc));
  }
});

test('mcc: an in-flow on a card with a code is a refund in that category', () => {
  const result = run('ZXQV HOLDINGS', 'in', 'credit_card', { mcc: '5812' });
  assert.deepEqual(pick(result, ['kind', 'category']), { kind: 'refund', category: 'eating_out' });
});

/* ------------------------------------------------------------ learned rules */

test('learned rule: beats the built-in rule for its merchant key', () => {
  const rules = [{ id: 'learned:abc', mkey: 'starbucks', category: 'supplies', purpose: 'work', merchant: 'Office coffee' }];
  const result = classify({ description: 'STARBUCKS STORE 12345 NEW YORK NY', amount: 500, flow: 'out', accountType: 'checking' }, { rules });
  assertCoherent(result);
  assert.deepEqual(result, {
    kind: 'spend', category: 'supplies', klass: 'need', purpose: 'work', merchant: 'Office coffee', mkey: 'starbucks',
    review: false, ruleId: 'learned:abc', glyph: null,
  });
  assert.equal(classify({ description: 'DUNKIN #1', amount: 500, flow: 'out', accountType: 'checking' }, { rules }).ruleId, 'builtin:dunkin');
});

test('learned rule: absent fields keep what the built-in rules decided', () => {
  const onlyPurpose = classify({ description: 'STARBUCKS', amount: 500, flow: 'out', accountType: 'checking' }, { rules: [{ id: 'learned:p', mkey: 'starbucks', purpose: 'coaching' }] });
  assert.deepEqual(pick(onlyPurpose, ['category', 'klass', 'purpose', 'merchant', 'ruleId']), { category: 'cafe', klass: 'game', purpose: 'coaching', merchant: 'Starbucks', ruleId: 'learned:p' });
  const onlyKlass = classify({ description: 'STARBUCKS', amount: 500, flow: 'out', accountType: 'checking' }, { rules: [{ id: 'learned:k', mkey: 'starbucks', klass: 'need' }] });
  assert.deepEqual(pick(onlyKlass, ['category', 'klass']), { category: 'cafe', klass: 'need' });
  const both = classify({ description: 'STARBUCKS', amount: 500, flow: 'out', accountType: 'checking' }, { rules: [{ id: 'learned:b', mkey: 'starbucks', category: 'groceries', klass: 'want' }] });
  assert.deepEqual(pick(both, ['category', 'klass']), { category: 'groceries', klass: 'want' }, 'an explicit class wins over the category default');
});

test('learned rule: clears review and decides the kind from the category', () => {
  const amazon = classify({ description: 'AMZN MKTP US', amount: 500, flow: 'out', accountType: 'credit_card' }, { rules: [{ id: 'learned:a', mkey: 'amazon', category: 'household' }] });
  assert.deepEqual(pick(amazon, ['kind', 'category', 'klass', 'review']), { kind: 'spend', category: 'household', klass: 'need', review: false });
  const zelleKey = merchantOf({ description: 'Zelle money sent to ALEX EXAMPLE' }).mkey;
  const asTransfer = classify({ description: 'Zelle money sent to ALEX EXAMPLE', amount: 500, flow: 'out', accountType: 'checking' }, { rules: [{ id: 'learned:z', mkey: zelleKey, category: 'transfer' }] });
  assert.deepEqual(pick(asTransfer, ['kind', 'category', 'review']), { kind: 'transfer', category: 'transfer', review: false });
  const refund = classify({ description: 'AMZN MKTP US', amount: 500, flow: 'in', accountType: 'credit_card' }, { rules: [{ id: 'learned:a', mkey: 'amazon', category: 'household' }] });
  assert.deepEqual(pick(refund, ['kind', 'category']), { kind: 'refund', category: 'household' });
});

test('learned rule: malformed rules are skipped, never thrown on', () => {
  const junk = [null, undefined, 7, 'starbucks', [], {}, { mkey: 'starbucks' }, { mkey: 'starbucks', category: 'nonsense', klass: 'zzz', purpose: 'chess', merchant: '   ' }, { mkey: null, category: 'gear' }];
  const result = classify({ description: 'STARBUCKS', amount: 500, flow: 'out', accountType: 'checking' }, { rules: junk });
  assert.deepEqual(pick(result, ['category', 'ruleId']), { category: 'cafe', ruleId: 'builtin:starbucks' });
  const income = classify({ description: 'STARBUCKS', amount: 500, flow: 'out', accountType: 'checking' }, { rules: [{ id: 'x', mkey: 'starbucks', category: 'income', purpose: 'work' }] });
  assert.deepEqual(pick(income, ['kind', 'category', 'purpose']), { kind: 'spend', category: 'cafe', purpose: 'work' }, 'money going out is never income');
  for (const rules of [null, 'x', 7, {}, () => []]) assert.equal(classify({ description: 'STARBUCKS', amount: 1, flow: 'out', accountType: 'checking' }, { rules }).category, 'cafe');
});

/* ---------------------------------------------------------------- reclassify */

test('reclassify: classifies stored rows from their bank text and is idempotent', () => {
  const coffee = bankTx('STARBUCKS STORE 12345 NEW YORK NY');
  const amazon = bankTx('AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA', { accountId: 'acc_card' });
  const pay = bankTx('Deposit from KNIGHTS ACADEMY INC PAYROLL', { flow: 'in', amount: 210000 });
  const cardPayment = bankTx('Payment Thank You-Mobile', { flow: 'in', accountId: 'acc_card' });
  const state = doc([coffee, amazon, pay, cardPayment]);
  assert.equal(reclassify(state), 4);
  assert.deepEqual(pick(coffee, ['kind', 'category', 'klass', 'merchant', 'mkey', 'ruleId', 'review']),
    { kind: 'spend', category: 'cafe', klass: 'game', merchant: 'Starbucks', mkey: 'starbucks', ruleId: 'builtin:starbucks', review: false });
  assert.deepEqual(pick(amazon, ['kind', 'category', 'klass', 'mkey', 'review']), { kind: 'spend', category: 'shopping', klass: 'want', mkey: 'amazon', review: true });
  assert.deepEqual(pick(pay, ['kind', 'category', 'purpose']), { kind: 'income', category: 'income', purpose: 'work' });
  assert.deepEqual(pick(cardPayment, ['kind', 'category']), { kind: 'payment', category: 'card_payment' });
  assert.equal(reclassify(state), 0, 'a second pass changes nothing');
  assert.equal(coffee.amount, 500);
  assert.equal(coffee.raw, 'STARBUCKS STORE 12345 NEW YORK NY');
});

test('reclassify: a locked field is never overwritten', () => {
  const lockedCategory = bankTx('STARBUCKS STORE 1', { category: 'supplies', klass: 'need', locks: ['category'] });
  const lockedKlass = bankTx('STARBUCKS STORE 2', { klass: 'want', locks: ['klass'] });
  const lockedPurpose = bankTx('STARBUCKS STORE 3', { purpose: 'coaching', locks: ['purpose'] });
  const lockedMerchant = bankTx('STARBUCKS STORE 4', { merchant: 'The usual', locks: ['merchant'] });
  const lockedKind = bankTx('STARBUCKS STORE 5', { kind: 'transfer', category: 'transfer', locks: ['kind'] });
  const lockedAll = bankTx('STARBUCKS STORE 6', { kind: 'spend', category: 'gifts', klass: 'oneoff', purpose: 'studio', merchant: 'Gift', locks: ['category', 'klass', 'purpose', 'merchant', 'kind'] });
  const state = doc([lockedCategory, lockedKlass, lockedPurpose, lockedMerchant, lockedKind, lockedAll]);
  reclassify(state);
  assert.deepEqual(pick(lockedCategory, ['kind', 'category', 'klass', 'merchant', 'review']), { kind: 'spend', category: 'supplies', klass: 'need', merchant: 'Starbucks', review: false });
  assert.deepEqual(pick(lockedKlass, ['category', 'klass']), { category: 'cafe', klass: 'want' });
  assert.deepEqual(pick(lockedPurpose, ['category', 'purpose']), { category: 'cafe', purpose: 'coaching' });
  assert.deepEqual(pick(lockedMerchant, ['merchant', 'mkey', 'category']), { merchant: 'The usual', mkey: 'starbucks', category: 'cafe' });
  assert.deepEqual(pick(lockedKind, ['kind', 'category']), { kind: 'transfer', category: 'transfer' });
  assert.deepEqual(pick(lockedAll, ['kind', 'category', 'klass', 'purpose', 'merchant']), { kind: 'spend', category: 'gifts', klass: 'oneoff', purpose: 'studio', merchant: 'Gift' });
  for (const tx of state.txs) assert.equal(tx.mkey, 'starbucks', 'the key is kept current even when the name is locked');
});

test('reclassify: paired legs, stream deposits and Book charges keep what links them', () => {
  const pairedLeg = bankTx('STARBUCKS STORE 1', { kind: 'transfer', category: 'transfer', pairId: 'tx_other' });
  const streamDeposit = bankTx('ZXQV HOLDINGS', { flow: 'in', kind: 'income', category: 'income', streamId: 'str_1' });
  const bookCharge = bankTx('STARBUCKS STORE 2', { klass: 'book', recurringId: 'rec_1' });
  const state = doc([pairedLeg, streamDeposit, bookCharge]);
  reclassify(state);
  assert.deepEqual(pick(pairedLeg, ['kind', 'category', 'pairId']), { kind: 'transfer', category: 'transfer', pairId: 'tx_other' });
  assert.deepEqual(pick(streamDeposit, ['kind', 'category', 'streamId', 'review']), { kind: 'income', category: 'income', streamId: 'str_1', review: false });
  assert.deepEqual(pick(bookCharge, ['category', 'klass', 'recurringId']), { category: 'cafe', klass: 'book', recurringId: 'rec_1' });
});

test('reclassify: declines and matched provisional moves are skipped', () => {
  const decline = bankTx('STARBUCKS', { source: 'manual', kind: 'decline', category: 'other', merchant: 'x', mkey: 'x' });
  const matched = bankTx('STARBUCKS', { source: 'manual', category: 'other', merchant: 'y', mkey: 'y', matchId: 'tx_bank' });
  const state = doc([decline, matched]);
  const snapshot = JSON.stringify(state.txs);
  assert.equal(reclassify(state), 0);
  assert.equal(JSON.stringify(state.txs), snapshot);
});

test('reclassify: can be limited to given ids', () => {
  const a = bankTx('STARBUCKS STORE 1');
  const b = bankTx('STARBUCKS STORE 2');
  const state = doc([a, b]);
  assert.equal(reclassify(state, [b.id, 'tx_missing']), 1);
  assert.equal(a.category, 'other');
  assert.equal(b.category, 'cafe');
  assert.equal(reclassify(state, []), 0);
  assert.equal(reclassify(state, null), 1);
});

test('reclassify: the account decides the kind; an unknown account is read as cash', () => {
  const onCard = bankTx('ZXQV HOLDINGS', { flow: 'in', accountId: 'acc_card' });
  const onChecking = bankTx('ZXQV HOLDINGS', { flow: 'in', accountId: 'acc_chk' });
  const orphan = bankTx('ZXQV HOLDINGS', { flow: 'in', accountId: 'acc_gone' });
  const state = doc([onCard, onChecking, orphan]);
  reclassify(state);
  assert.equal(onCard.kind, 'refund');
  assert.equal(onChecking.kind, 'income');
  assert.equal(orphan.kind, 'income');
});

test('reclassify: writes the penalty glyph only where the owner set none', () => {
  const late = bankTx('LATE FEE', { accountId: 'acc_card' });
  const annotated = bankTx('LATE FEE', { accountId: 'acc_card', glyph: '!' });
  const interest = bankTx('INTEREST CHARGE:PURCHASES', { accountId: 'acc_card' });
  const state = doc([late, annotated, interest]);
  reclassify(state);
  assert.equal(late.glyph, '??');
  assert.equal(annotated.glyph, '!');
  assert.equal(interest.glyph, null);
});

test('reclassify: applies learned rules, and a move without bank text is touched by nothing else', () => {
  const bank = bankTx('STARBUCKS STORE 12345');
  const tapped = bankTx('', { source: 'manual', merchant: 'Starbucks', mkey: 'starbucks', category: 'cafe', klass: 'game', amount: 475 });
  const tappedElsewhere = bankTx('', { source: 'manual', merchant: 'Corner cart', mkey: 'corner cart', category: 'eating_out', klass: 'game' });
  const state = doc([bank, tapped, tappedElsewhere]);
  state.settings.rules = [{ id: 'learned:w', mkey: 'starbucks', category: 'supplies', purpose: 'work' }];
  const untouched = JSON.stringify(tappedElsewhere);
  assert.equal(reclassify(state), 2);
  assert.deepEqual(pick(bank, ['category', 'klass', 'purpose', 'ruleId', 'review']), { category: 'supplies', klass: 'need', purpose: 'work', ruleId: 'learned:w', review: false });
  assert.deepEqual(pick(tapped, ['category', 'klass', 'purpose', 'ruleId', 'merchant', 'mkey', 'amount']),
    { category: 'supplies', klass: 'need', purpose: 'work', ruleId: 'learned:w', merchant: 'Starbucks', mkey: 'starbucks', amount: 475 });
  assert.equal(JSON.stringify(tappedElsewhere), untouched);
});

test('reclassify: survives malformed documents and rows', () => {
  for (const state of [null, undefined, {}, { txs: null }, { txs: 'x' }, 7, 'doc']) assert.equal(reclassify(state), 0);
  const good = bankTx('STARBUCKS');
  const state = { txs: [null, undefined, 5, 'row', {}, { id: 'tx_x', raw: 42 }, { id: 'tx_y', raw: 'DUNKIN', locks: 'category', amount: 'lots', flow: 'sideways', day: 'yesterday' }, good] };
  assert.doesNotThrow(() => reclassify(state));
  assert.equal(good.category, 'cafe');
  assert.equal(state.txs[6].category, 'cafe');
  const withBadSettings = { txs: [bankTx('STARBUCKS')], accounts: [null, 7, {}], settings: { rules: 'none' } };
  assert.equal(reclassify(withBadSettings), 1);
});

/* ----------------------------------------------------------------- learnRule */

function coffeeDoc() {
  const first = bankTx('STARBUCKS STORE 1', { day: '2026-03-01' });
  const second = bankTx('STARBUCKS STORE 2', { day: '2026-03-02' });
  const ownerLocked = bankTx('STARBUCKS STORE 3', { day: '2026-03-03', category: 'gifts', klass: 'want', locks: ['category'] });
  const other = bankTx('DUNKIN #345123', { day: '2026-03-04' });
  const state = doc([first, second, ownerLocked, other]);
  reclassify(state);
  return { state, first, second, ownerLocked, other };
}

test('learnRule: locks the correction, learns a rule and applies it to the merchant\'s other unlocked rows', () => {
  const { state, first, second, ownerLocked, other } = coffeeDoc();
  const otherBefore = JSON.stringify(other);
  const outcome = learnRule(state, first.id, { category: 'supplies', purpose: 'work' });

  assert.equal(outcome.changed, 3);
  assert.match(outcome.ruleId, /^learned:/);
  assert.deepEqual(state.settings.rules, [{ id: outcome.ruleId, mkey: 'starbucks', category: 'supplies', purpose: 'work' }]);

  assert.deepEqual(pick(first, ['kind', 'category', 'klass', 'purpose', 'review', 'ruleId']),
    { kind: 'spend', category: 'supplies', klass: 'need', purpose: 'work', review: false, ruleId: outcome.ruleId });
  assert.deepEqual([...first.locks].sort(), ['category', 'purpose']);

  assert.deepEqual(pick(second, ['category', 'klass', 'purpose', 'ruleId']), { category: 'supplies', klass: 'need', purpose: 'work', ruleId: outcome.ruleId });
  assert.deepEqual(second.locks, [], 'rows the rule reached are not locked');

  assert.deepEqual(pick(ownerLocked, ['category', 'klass', 'purpose']), { category: 'gifts', klass: 'want', purpose: 'work' }, 'the locked category stays; the unlocked purpose follows');
  assert.deepEqual(ownerLocked.locks, ['category']);
  assert.equal(JSON.stringify(other), otherBefore, 'another merchant is untouched');
});

test('learnRule: the rule holds for future rows and through a reclassify', () => {
  const { state, first, second } = coffeeDoc();
  const { ruleId } = learnRule(state, first.id, { category: 'supplies', purpose: 'work', merchant: 'Office coffee' });
  const future = classify({ description: 'STARBUCKS STORE 99 BOSTON MA', amount: 700, flow: 'out', accountType: 'credit_card' }, { rules: state.settings.rules });
  assert.deepEqual(pick(future, ['category', 'klass', 'purpose', 'merchant', 'mkey', 'ruleId', 'review']),
    { category: 'supplies', klass: 'need', purpose: 'work', merchant: 'Office coffee', mkey: 'starbucks', ruleId, review: false });
  assert.equal(reclassify(state), 0, 'reclassifying right after learning changes nothing');
  assert.deepEqual(pick(second, ['category', 'merchant', 'mkey']), { category: 'supplies', merchant: 'Office coffee', mkey: 'starbucks' });
  state.txs.push(bankTx('STARBUCKS STORE 7'));
  assert.equal(reclassify(state), 1);
  assert.deepEqual(pick(state.txs.at(-1), ['category', 'ruleId']), { category: 'supplies', ruleId });
});

test('learnRule: a second correction updates the same rule instead of adding one', () => {
  const { state, first, second } = coffeeDoc();
  const a = learnRule(state, first.id, { category: 'supplies' });
  const b = learnRule(state, second.id, { klass: 'want', purpose: 'coaching' });
  assert.equal(state.settings.rules.length, 1);
  assert.equal(b.ruleId, a.ruleId);
  assert.deepEqual(state.settings.rules[0], { id: a.ruleId, mkey: 'starbucks', category: 'supplies', klass: 'want', purpose: 'coaching' });
  assert.deepEqual(pick(first, ['category', 'klass', 'purpose']), { category: 'supplies', klass: 'want', purpose: 'coaching' }, 'the earlier move locked only its category');
  assert.deepEqual(pick(second, ['category', 'klass', 'purpose']), { category: 'supplies', klass: 'want', purpose: 'coaching' });
  assert.deepEqual([...second.locks].sort(), ['klass', 'purpose']);
});

test('learnRule: onlyThis changes one move and learns nothing', () => {
  const { state, first, second } = coffeeDoc();
  const secondBefore = JSON.stringify(second);
  const outcome = learnRule(state, first.id, { category: 'gifts', klass: 'want' }, { onlyThis: true });
  assert.deepEqual(outcome, { changed: 1, ruleId: null });
  assert.deepEqual(state.settings.rules, []);
  assert.deepEqual(pick(first, ['category', 'klass', 'review']), { category: 'gifts', klass: 'want', review: false });
  assert.deepEqual([...first.locks].sort(), ['category', 'klass']);
  assert.equal(JSON.stringify(second), secondBefore);
  assert.equal(reclassify(state), 0, 'the lock holds against the built-in rule');
  assert.equal(first.category, 'gifts');
});

test('learnRule: the owner outranks an existing lock on the corrected move', () => {
  const { state, ownerLocked } = coffeeDoc();
  learnRule(state, ownerLocked.id, { category: 'health' });
  assert.equal(ownerLocked.category, 'health');
  assert.deepEqual(ownerLocked.locks, ['category']);
});

test('learnRule: kind follows the new category, except on paired legs', () => {
  const zelle = bankTx('Zelle money sent to ALEX EXAMPLE', { amount: 120000 });
  const again = bankTx('Zelle money sent to ALEX EXAMPLE', { amount: 120000, day: '2026-04-10' });
  const paired = bankTx('Withdrawal to 360 Performance Savings XXXXXXX1234', { kind: 'transfer', category: 'transfer', pairId: 'tx_leg' });
  const state = doc([zelle, again, paired]);
  reclassify(state);
  assert.equal(zelle.kind, 'spend');
  learnRule(state, zelle.id, { category: 'housing' });
  assert.deepEqual(pick(zelle, ['kind', 'category', 'klass']), { kind: 'spend', category: 'housing', klass: 'book' });
  assert.deepEqual(pick(again, ['kind', 'category', 'klass']), { kind: 'spend', category: 'housing', klass: 'book' });
  learnRule(state, zelle.id, { category: 'transfer' });
  assert.deepEqual(pick(zelle, ['kind', 'category']), { kind: 'transfer', category: 'transfer' });
  assert.deepEqual(pick(again, ['kind', 'category']), { kind: 'transfer', category: 'transfer' });
  assert.deepEqual(learnRule(state, paired.id, { category: 'gifts' }), { changed: 0, ruleId: null });
  assert.deepEqual(pick(paired, ['kind', 'category', 'locks']), { kind: 'transfer', category: 'transfer', locks: [] }, 'a paired leg stays a transfer');
  assert.equal(state.settings.rules.length, 1, 'and no rule is learned from a refused correction');
  assert.equal(learnRule(state, paired.id, { category: 'gifts', purpose: 'studio' }).changed, 1);
  assert.deepEqual(pick(paired, ['kind', 'category', 'purpose', 'locks']), { kind: 'transfer', category: 'transfer', purpose: 'studio', locks: ['purpose'] });
});

test('learnRule: unusable input changes nothing', () => {
  const { state, first } = coffeeDoc();
  const before = JSON.stringify(state);
  const nothing = { changed: 0, ruleId: null };
  assert.deepEqual(learnRule(state, 'tx_missing', { category: 'gifts' }), nothing);
  assert.deepEqual(learnRule(state, first.id, {}), nothing);
  assert.deepEqual(learnRule(state, first.id, null), nothing);
  assert.deepEqual(learnRule(state, first.id, { category: 'nonsense', klass: 'zzz', purpose: 'chess', merchant: '  ' }), nothing);
  assert.deepEqual(learnRule(state, first.id, { category: 'income' }), nothing, 'a purchase cannot be income');
  assert.deepEqual(learnRule(state, first.id, { category: '__proto__', klass: 'constructor' }), nothing);
  assert.deepEqual(learnRule(null, first.id, { category: 'gifts' }), nothing);
  assert.deepEqual(learnRule({}, first.id, { category: 'gifts' }), nothing);
  assert.deepEqual(learnRule({ txs: [null, 7, {}] }, undefined, { category: 'gifts' }), nothing);
  assert.equal(JSON.stringify(state), before);
});

test('learnRule: a move with no merchant key is changed alone; missing settings are created', () => {
  const keyless = bankTx('', { mkey: '', merchant: 'Unknown' });
  const state = doc([keyless]);
  assert.deepEqual(learnRule(state, keyless.id, { category: 'gifts' }), { changed: 1, ruleId: null });
  assert.deepEqual(state.settings.rules, []);
  assert.equal(keyless.category, 'gifts');

  const coffee = bankTx('STARBUCKS', { mkey: 'starbucks' });
  const bare = { txs: [coffee] };
  const outcome = learnRule(bare, coffee.id, { purpose: 'work' });
  assert.equal(outcome.changed, 1);
  assert.deepEqual(bare.settings.rules, [{ id: outcome.ruleId, mkey: 'starbucks', purpose: 'work' }]);
});

test('learnRule: an owner-typed merchant name is stored as plain bounded text', () => {
  const { state, first } = coffeeDoc();
  learnRule(state, first.id, { merchant: '  <b>My\ncafé</b> ' + 'x'.repeat(200) });
  assert.ok(first.merchant.startsWith('<b>My café</b>'));
  assert.ok(first.merchant.length <= 48);
  assert.ok(!/[\n\r\t]/.test(first.merchant));
  assert.equal(first.mkey, 'starbucks', 'renaming never changes the key');
  assert.deepEqual(first.locks, ['merchant']);
});

/* -------------------------------------------------------------- topMerchants */

function gameSpend(merchant, mkey, day, amount, fields = {}) {
  return bankTx(merchant.toUpperCase(), { merchant, mkey, day, amount, kind: 'spend', category: 'cafe', klass: 'game', ...fields });
}

test('topMerchants: most frequent convenience stops, with the median amount', () => {
  const state = doc([
    gameSpend('Starbucks', 'starbucks', '2026-03-01', 450),
    gameSpend('Starbucks', 'starbucks', '2026-03-05', 550),
    gameSpend('Starbucks', 'starbucks', '2026-03-09', 500),
    gameSpend('Supreme Deli', 'supreme deli', '2026-03-02', 800, { category: 'convenience' }),
    gameSpend('Supreme Deli', 'supreme deli', '2026-03-08', 1001, { category: 'convenience' }),
    gameSpend('Joe Coffee', 'joe coffee', '2026-03-10', 425),
    gameSpend('Key Food', 'key food', '2026-03-03', 4200, { category: 'groceries', klass: 'need' }),
    gameSpend('Key Food', 'key food', '2026-03-04', 4200, { category: 'groceries', klass: 'need' }),
    gameSpend('Key Food', 'key food', '2026-03-06', 4200, { category: 'groceries', klass: 'need' }),
    gameSpend('Key Food', 'key food', '2026-03-07', 4200, { category: 'groceries', klass: 'need' }),
  ]);
  assert.deepEqual(topMerchants(state), [
    { merchant: 'Starbucks', mkey: 'starbucks', category: 'cafe', typical: 500, count: 3 },
    { merchant: 'Supreme Deli', mkey: 'supreme deli', category: 'convenience', typical: 901, count: 2 },
    { merchant: 'Joe Coffee', mkey: 'joe coffee', category: 'cafe', typical: 425, count: 1 },
  ]);
});

test('topMerchants: ties go to the more recent; limit and sinceDay apply', () => {
  const state = doc([
    gameSpend('Alpha Cafe', 'alpha cafe', '2026-03-01', 300),
    gameSpend('Beta Cafe', 'beta cafe', '2026-03-09', 400),
    gameSpend('Gamma Cafe', 'gamma cafe', '2026-03-05', 500),
    gameSpend('Gamma Cafe', 'gamma cafe', '2026-01-05', 700),
  ]);
  assert.deepEqual(topMerchants(state).map((m) => m.mkey), ['gamma cafe', 'beta cafe', 'alpha cafe']);
  assert.deepEqual(topMerchants(state, { limit: 2 }).map((m) => m.mkey), ['gamma cafe', 'beta cafe']);
  assert.deepEqual(topMerchants(state, { limit: 0 }), []);
  assert.deepEqual(topMerchants(state, { sinceDay: '2026-03-02' }).map((m) => [m.mkey, m.count, m.typical]), [['beta cafe', 1, 400], ['gamma cafe', 1, 500]]);
  assert.deepEqual(topMerchants(state, { sinceDay: '2027-01-01' }), []);
});

test('topMerchants: default limit is six; name and category come from the latest visit', () => {
  const txs = [];
  for (let i = 0; i < 9; i++) for (let visit = 0; visit <= i; visit++) txs.push(gameSpend('Cafe ' + i, 'cafe ' + i, '2026-03-1' + visit, 100 * (i + 1)));
  txs.push(gameSpend('Cafe Eight (renamed)', 'cafe 8', '2026-03-25', 900, { category: 'eating_out' }));
  const top = topMerchants(doc(txs));
  assert.equal(top.length, 6);
  assert.deepEqual(top[0], { merchant: 'Cafe Eight (renamed)', mkey: 'cafe 8', category: 'eating_out', typical: 900, count: 10 });
  assert.deepEqual(top.map((m) => m.count), [10, 8, 7, 6, 5, 4]);
});

test('topMerchants: only live game-class spends count', () => {
  const state = doc([
    gameSpend('Starbucks', 'starbucks', '2026-03-01', 450),
    gameSpend('Starbucks', 'starbucks', '2026-03-02', 450, { kind: 'decline', source: 'manual' }),
    gameSpend('Starbucks', 'starbucks', '2026-03-03', 450, { source: 'manual', matchId: 'tx_bank' }),
    gameSpend('Starbucks', 'starbucks', '2026-03-04', 450, { kind: 'refund', flow: 'in' }),
    gameSpend('Starbucks', 'starbucks', '2026-03-05', 450, { klass: 'book' }),
    gameSpend('No Key', '', '2026-03-06', 450),
    gameSpend('Zero', 'zero', '2026-03-07', 0),
    gameSpend('NaN', 'nan', '2026-03-07', NaN),
    null, undefined, 7, {}, { kind: 'spend', klass: 'game' },
  ]);
  assert.deepEqual(topMerchants(state), [{ merchant: 'Starbucks', mkey: 'starbucks', category: 'cafe', typical: 450, count: 1 }]);
});

test('topMerchants: malformed documents and options give an empty or default answer', () => {
  for (const state of [null, undefined, {}, { txs: null }, { txs: 'x' }, 7]) assert.deepEqual(topMerchants(state), []);
  const state = doc([gameSpend('Starbucks', 'starbucks', '2026-03-01', 450)]);
  for (const opts of [null, undefined, 7, 'x', { limit: 'many' }, { limit: NaN }, { sinceDay: 20260301 }]) assert.equal(topMerchants(state, opts).length, 1);
  assert.deepEqual(topMerchants(state, { limit: -3 }), []);
  assert.equal(topMerchants(state, { limit: 2.9 }).length, 1);
});

/* ---------------------------------------------------------- inferAccountType */

test('inferAccountType: reads the type from the account name', () => {
  const expected = [
    ['360 Checking', 'checking'], ['Student Checking', 'checking'], ['Rewards Checking', 'checking'], ['EVERYDAY CHK', 'checking'], ['Spending Account', 'checking'], ['Debit', 'checking'],
    ['360 Performance Savings', 'savings'], ['Online Savings', 'savings'], ['Discover Online Savings', 'savings'], ['Money Market', 'savings'], ['Premier MMA', 'savings'],
    ['12 Month CD', 'savings'], ['My Reserve', 'savings'], ['Emergency fund', 'savings'],
    ['Quicksilver', 'credit_card'], ['Savor Rewards', 'credit_card'], ['Venture Rewards', 'credit_card'], ['Sapphire Reserve', 'credit_card'], ['Platinum Card', 'credit_card'],
    ['Cash Rewards Visa Signature', 'credit_card'], ['World Mastercard', 'credit_card'], ['Amex Gold', 'credit_card'], ['Discover it Cash Back', 'credit_card'], ['Credit Card ...1234', 'credit_card'],
    ['Auto Loan', 'loan'], ['Toyota Auto Finance', 'loan'], ['Home Mortgage', 'loan'], ['Student Loan Group A', 'loan'], ['Personal Line of Credit', 'loan'],
    ['Brokerage Account', 'investment'], ['Roth IRA', 'investment'], ['Traditional IRA', 'investment'], ['401(k) Plan', 'investment'], ['Individual Investment', 'investment'], ['Retirement', 'investment'],
  ];
  for (const [name, type] of expected) {
    assert.equal(inferAccountType({ name, balance: 0 }), type, name);
    assert.equal(inferAccountType({ name: name.toUpperCase(), balance: -100 }), type, name + ' (upper case, negative)');
  }
});

test('inferAccountType: with no keyword, a negative balance is a card and anything else is checking', () => {
  assert.equal(inferAccountType({ name: 'Total', balance: -420000 }), 'credit_card');
  assert.equal(inferAccountType({ name: 'Total', balance: 420000 }), 'checking');
  assert.equal(inferAccountType({ name: 'Total', balance: 0 }), 'checking');
  assert.equal(inferAccountType({ name: '', balance: -1 }), 'credit_card');
  assert.equal(inferAccountType({ name: '', institution: 'Capital One', balance: 5 }), 'checking');
});

test('inferAccountType: always answers with a known type', () => {
  const hostile = [null, undefined, {}, 7, 'x', [], { name: null }, { name: 42, balance: 'lots' }, { name: {}, balance: NaN }, { name: 'x'.repeat(100000), balance: -Infinity },
    { name: '((((' }, { name: '🍕 card 🍕' }, { name: '__proto__' }, { name: 'constructor', balance: -1 }];
  for (const account of hostile) assert.ok(Object.hasOwn(ACCOUNT_TYPES, inferAccountType(account)), JSON.stringify(account));
  assert.equal(inferAccountType({ name: '🍕 card 🍕' }), 'credit_card');
  assert.equal(inferAccountType(null), 'checking');
});

/* ------------------------------------------------------------- hostile input */

test('hostile input: classify always returns a coherent record', () => {
  const descriptions = [
    '', ' ', '\n\t\r', null, undefined, 0, 42, NaN, true, {}, [], () => 1, Symbol.iterator.toString(),
    '(((((((', ')))))', '[a-z', '.*+?^${}()|[]\\', '(?<name>x)\\k<name>', '\\', '\\\\', '(a+)+$', '^$', '$1 $2 $&', '%s %d', '${amount}',
    '🍕', '🍕🍕🍕 PIZZA 🍕', '☕️ COFFEE ☕️', '👨‍👩‍👧‍👦', '\u0000\u0001\u0002', 'A\u0000B', '\ud83d', '\udc00\ud800', 'é'.repeat(200),
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"; DROP TABLE txs; --', 'javascript:alert(1)', '{{constructor.constructor("x")()}}',
    '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf',
    '寿司 さくら NEW YORK NY', 'КОФЕЙНЯ №5', 'مقهى', 'ＳＴＡＲＢＵＣＫＳ　ＳＴＯＲＥ',
    'x'.repeat(100000), 'a '.repeat(50000), '* '.repeat(50000), '1234 '.repeat(20000), '#1 '.repeat(20000), 'sq *'.repeat(20000),
    'a'.repeat(40) + '!'.repeat(40), ' '.repeat(100000), '-'.repeat(100000), ('deli ' + '9'.repeat(30) + ' ').repeat(2000),
  ];
  const started = process.hrtime.bigint();
  for (const description of descriptions) {
    for (const flow of ['out', 'in']) {
      for (const accountType of ['checking', 'credit_card', 'loan', 'investment', 'equipment']) {
        const label = String(description).slice(0, 40) + ' ' + flow + ' ' + accountType;
        let result;
        assert.doesNotThrow(() => { result = classify({ description, payee: description, memo: description, mcc: description, amount: 100, flow, accountType }); }, label);
        assertCoherent(result, label);
        assert.equal(result.glyph, null, label);
      }
    }
    assert.doesNotThrow(() => normalizeDescription(description));
    assert.doesNotThrow(() => merchantOf({ description }));
    assert.equal(typeof normalizeDescription(description), 'string');
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 5000, `hostile descriptions took ${elapsedMs.toFixed(0)} ms`);
});

test('hostile input: missing and malformed fields never throw or produce NaN', () => {
  const inputs = [
    null, undefined, 7, 'STARBUCKS', [], {}, { description: 'STARBUCKS' }, { description: 'STARBUCKS', amount: NaN }, { description: 'STARBUCKS', amount: -500, flow: 'IN' },
    { description: 'STARBUCKS', amount: Infinity, flow: 'in', accountType: 'credit_card' }, { description: 'STARBUCKS', amount: '500', flow: null, accountType: null },
    { description: ['STARBUCKS'], payee: { toString: () => { throw new Error('no'); } }, memo: Symbol('x'), mcc: Symbol('y'), amount: {}, flow: {}, accountType: {} },
  ];
  const contexts = [undefined, null, 7, 'x', [], {}, { rules: null, recentSpends: null }, { rules: [null, 7, 'x', {}], recentSpends: [null, 7, 'x', {}, { mkey: 'starbucks' }, { mkey: 'starbucks', amount: NaN }, { mkey: 'starbucks', amount: 'lots' }] }];
  for (const input of inputs) {
    for (const ctx of contexts) {
      let result;
      assert.doesNotThrow(() => { result = classify(input, ctx); });
      assertCoherent(result);
      for (const value of Object.values(result)) assert.ok(!Number.isNaN(value));
    }
  }
  assert.equal(classify({ description: 'STARBUCKS', amount: NaN, flow: 'in', accountType: 'credit_card' }, { recentSpends: [{ mkey: 'starbucks', amount: NaN }] }).kind, 'refund');
});

test('hostile input: full-width and accented text still finds its chain; bank text is never used as a pattern', () => {
  assert.equal(run('ＳＴＡＲＢＵＣＫＳ　ＳＴＯＲＥ １２３４５').mkey, 'starbucks');
  assert.equal(run('.*').category, 'other');
  assert.equal(run('STARBUCKS|DUNKIN').mkey, 'starbucks');
  const rules = [{ id: 'learned:x', mkey: '.*', category: 'gifts' }, { id: 'learned:y', mkey: 'star', category: 'gifts' }];
  assert.equal(classify({ description: 'STARBUCKS', amount: 1, flow: 'out', accountType: 'checking' }, { rules }).category, 'cafe', 'a learned rule matches its key exactly, never as a pattern or a prefix');
});

test('purity: classify does not change its arguments and gives the same answer every time', () => {
  const input = Object.freeze({ description: 'SQ *VARIETY COFFEE ROASTE Brooklyn NY', payee: 'x', memo: 'y', mcc: '5814', amount: 525, flow: 'out', accountType: 'credit_card' });
  const ctx = Object.freeze({ rules: Object.freeze([Object.freeze({ id: 'learned:v', mkey: 'variety coffee roasters', purpose: 'work' })]), recentSpends: Object.freeze([Object.freeze({ mkey: 'variety coffee roasters', amount: 525 })]) });
  const first = classify(input, ctx);
  const second = classify(input, ctx);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'each call returns its own record');
  first.category = 'changed';
  assert.equal(classify(input, ctx).category, 'cafe');
  assert.equal(classify(input, ctx).purpose, 'work');
});

/* ------------------------------------------------- review rulings (9) and glyph */

test('learnRule onlyThis: a purpose corrected on one move keeps it out of "needs a look" through a re-read', () => {
  const state = defaultState();
  const tx = bankTx('Zelle payment from PAT SAMPLE 0412', { amount: 9000, flow: 'in' });
  state.txs.push(tx);
  reclassify(state);
  tx.review = true;
  learnRule(state, tx.id, { purpose: 'work' }, { onlyThis: true });
  assert.equal(tx.review, false);
  reclassify(state);
  assert.equal(tx.review, false, 'the correction is not undone by the next re-read');
  assert.equal(tx.purpose, 'work');
});

test('confirmMove: clears the mark, changes nothing else, and holds through a re-read', () => {
  const state = defaultState();
  const tx = bankTx('Zelle payment from PAT SAMPLE 0412', { amount: 9000, flow: 'in' });
  state.txs.push(tx);
  reclassify(state);
  tx.review = true;
  const before = pick(tx, ['category', 'klass', 'purpose', 'merchant', 'kind']);
  assert.deepEqual(confirmMove(state, tx.id), { changed: true });
  assert.equal(tx.review, false);
  assert.ok(tx.locks.includes('review'));
  assert.deepEqual(pick(tx, ['category', 'klass', 'purpose', 'merchant', 'kind']), before);
  reclassify(state);
  assert.equal(tx.review, false);
  assert.deepEqual(confirmMove(state, tx.id), { changed: false });
  assert.deepEqual(confirmMove(state, 'tx_missing'), { changed: false });
  assert.deepEqual(state.settings.rules, []);
});

test('learnRule: a ?? leaves when the owner files the move out of Interest & fees, unless the glyph is locked', () => {
  const state = defaultState();
  const fee = bankTx('LATE FEE', { amount: 2900 });
  const kept = bankTx('LATE FEE', { amount: 2900 });
  state.txs.push(fee, kept);
  reclassify(state);
  assert.equal(fee.glyph, '??');
  kept.locks = ['glyph'];
  learnRule(state, fee.id, { category: 'other' }, { onlyThis: true });
  assert.equal(fee.category, 'other');
  assert.equal(fee.glyph, null);
  reclassify(state);
  assert.equal(fee.glyph, null, 'a re-read does not put the mark back on a move filed elsewhere');
  learnRule(state, kept.id, { category: 'other' }, { onlyThis: true });
  assert.equal(kept.glyph, '??');
});
