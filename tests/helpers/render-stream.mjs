// node tests/helpers/render-stream.mjs <hidden|emptied|plain> <chess|finance> [alone] [arrival]
// Renders what the owner sees of a pay stream under node, and prints it as JSON: the Book, the stream sheet of that
// stream, Settings, the Board, and the assessment's notes. A payer pays every two weeks into a second checking account;
// another payer pays into the main one, where the rent is paid. 'hidden': the owner hid the second account. 'emptied':
// every deposit of the payer was let go of its stream (read as a transfer, as an Undo or a rule taken back leaves it).
// 'plain': neither. 'alone': the main account holds nothing. 'arrival': the owner set the stream to count on arrival.
// The few globals a browser has are stubbed here, in a process of its own, so no test file shares them. Every name and
// figure is invented.
const [kase = 'plain', words = 'chess', ...flags] = process.argv.slice(2);
const noop = () => {};
const el = () => ({ setAttribute: noop, getAttribute: () => null, addEventListener: noop, removeEventListener: noop, appendChild: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {} });
globalThis.BroadcastChannel = undefined;
globalThis.window = { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '', search: '' } };
globalThis.document = { addEventListener: noop, removeEventListener: noop, documentElement: el(), body: el(), createElement: el,
  querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', getElementById: () => null };
globalThis.addEventListener = noop;
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const js = new URL('../../js/', import.meta.url);
const dates = await import(new URL('model/dates.js', js));
const now = new Date('2026-11-14T15:00:00').getTime();
dates.setNow(now);
const { defaultState } = await import(new URL('model/schema.js', js));
const { mergeFeed } = await import(new URL('model/merge.js', js));
const { refresh } = await import(new URL('model/detect.js', js));
const { coachNotes } = await import(new URL('model/assess.js', js));
const { makeDerived } = await import(new URL('derive.js', js));
const { store } = await import(new URL('store.js', js));
const runtime = await import(new URL('runtime.js', js));
const book = await import(new URL('views/book.js', js));
const sheet = await import(new URL('views/sheet-stream.js', js));
const settings = await import(new URL('views/settings.js', js));
const board = await import(new URL('views/board.js', js));
const material = await import(new URL('views/material.js', js));
const analysis = await import(new URL('views/analysis.js', js));

const DAY = 86400000;
const dateOnly = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) / 1000; };
const row = (extId, amount, day, description) => ({ extId, amount, posted: dateOnly(day), at: null, pending: false, description, payee: '', memo: '', mcc: null });
const PAYDAYS = ['2026-07-10', '2026-07-24', '2026-08-07', '2026-08-21', '2026-09-04', '2026-09-18', '2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13'];
const SIDE = PAYDAYS.map((day) => row('QDEP-' + day, 182000, day, 'QUILLMERE STUDIOS'));
const MAIN = [...PAYDAYS.slice(2).map((day) => row('HDEP-' + day, 90000, day, 'HARROWGATE PAYROLL PPD')),
  row('RENT-1001', -145000, '2026-10-01', 'ALDERCREST PROPERTIES RENT'), row('RENT-1101', -145000, '2026-11-01', 'ALDERCREST PROPERTIES RENT')];
const account = (extId, name, txs) => ({ extId, connId: 'CON-1', institution: 'Example Bank', name, currency: 'USD', balance: 812345, available: 812345, asOf: now - 3600000, txs });

const state = defaultState(now - 200 * DAY);
state.meta.origin = 'bank';
mergeFeed(state, { src: 'simplefin', fetchedAt: now, fromMs: now - 200 * DAY, toMs: now, errors: [],
  accounts: [account('ACT-CHK-7', 'Main Checking', flags.includes('alone') ? [] : MAIN), account('ACT-CHK-9', 'Side Checking', SIDE)] }, now);
refresh(state, now);
const payer = state.txs.find((tx) => tx.ext && tx.ext.id === 'QDEP-2026-11-13');
if (flags.includes('arrival')) {
  const stream = state.streams.find((one) => one.mkey === payer.mkey);
  stream.accrue = false;
  stream.locks = [...(stream.locks || []), 'accrue'];
}
if (kase === 'hidden') {
  state.accounts.find((one) => one.id === payer.accountId).hidden = true;
  refresh(state, now);
} else if (kase === 'emptied') {
  const stream = state.streams.find((one) => one.mkey === payer.mkey);
  for (const tx of state.txs) if (tx.streamId === stream.id) { tx.streamId = null; tx.kind = 'transfer'; tx.category = 'transfer'; tx.locks = ['category']; }
  refresh(state, now);
}
store.load(state, { readonly: true });
const stream = store.state.streams.find((one) => one.mkey === payer.mkey) || null;
const contextOf = (view, sheetName) => ({
  state: store.state, ui: store.ui, now, words, wordsForced: false,
  today: dates.gameDay(now, store.state.settings.rolloverHour),
  route: { view, segs: [], params: {}, sheet: sheetName }, d: makeDerived(store.state, now, { words }), demo: false,
  sync: { state: 'off' }, share: { available: true, on: false, owner: 'example-owner' }, inbox: {}, income: {}, wide: true,
});
const run = (fn) => { try { return String(fn()); } catch (e) { return 'ERROR ' + e.stack; } };
const out = { stream: stream && { id: stream.id, active: stream.active, accrue: stream.accrue, accountId: stream.accountId } };
let ctx = contextOf('book', null);
if (runtime.setContext) runtime.setContext(ctx);
out.book = run(() => book.render(ctx));
out.sheet = stream ? run(() => sheet.render(ctx, { id: stream.id })) : null;
ctx = contextOf('settings', null);
if (runtime.setContext) runtime.setContext(ctx);
out.settings = run(() => settings.render(ctx));
ctx = contextOf('board', null);
if (runtime.setContext) runtime.setContext(ctx);
out.board = run(() => board.render(ctx));
ctx = contextOf('material', null);
if (runtime.setContext) runtime.setContext(ctx);
out.material = run(() => material.render(ctx));
ctx = contextOf('analysis', null);
if (runtime.setContext) runtime.setContext(ctx);
out.analysis = run(() => analysis.render(ctx));
out.notes = coachNotes(store.state, now, { words, limit: 20 }).map((note) => note && note.key);
// written at once, so that the whole of it reaches a pipe before the process ends
const { writeSync } = await import('node:fs');
const bytes = Buffer.from(JSON.stringify(out), 'utf8');
for (let at = 0; at < bytes.length;) at += writeSync(1, bytes, at, bytes.length - at);
process.exit(0);
