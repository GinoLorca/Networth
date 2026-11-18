// node tests/helpers/flows-save.mjs [cover]
// The transaction sheet's own Save and the queue's own one tap, run under node through the store and the views' own
// actions, on a record read from an invented feed; prints what they left as JSON. The few globals a browser has are
// stubbed here, in a process of its own, so no test file shares them. Every merchant and figure is invented.
const cover = process.argv[2] === 'cover';
const noop = () => {};
const el = () => ({ setAttribute: noop, getAttribute: () => null, addEventListener: noop, removeEventListener: noop, appendChild: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {} });
globalThis.BroadcastChannel = undefined;
globalThis.window = { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '', search: '' } };
globalThis.location = globalThis.window.location;
globalThis.history = { state: null, length: 1, pushState: noop, replaceState: noop, back: noop };
globalThis.document = { addEventListener: noop, removeEventListener: noop, documentElement: el(), body: el(), createElement: el,
  querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', getElementById: () => null };
globalThis.addEventListener = noop;
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const js = new URL('../../js/', import.meta.url);
const dates = await import(new URL('model/dates.js', js));
const now = new Date(2026, 5, 16, 12).getTime();
dates.setNow(now);
const { defaultState } = await import(new URL('model/schema.js', js));
const { mergeFeed } = await import(new URL('model/merge.js', js));
const { refresh } = await import(new URL('model/detect.js', js));
const { exportCorrections } = await import(new URL('model/corrections.js', js));
const { moveQueue, whereItWent } = await import(new URL('model/flows.js', js));
const { makeDerived } = await import(new URL('derive.js', js));
const { store } = await import(new URL('store.js', js));
const runtime = await import(new URL('runtime.js', js));
const sheet = await import(new URL('views/sheet-tx.js', js));
const flows = await import(new URL('views/flows.js', js));

const DAY = 86400;
const day = (d) => Date.UTC(2026, 5, d) / 1000;
const row = (extId, amount, d, description) => ({ extId, amount, posted: day(d), at: null, pending: false, description, payee: '', memo: '', mcc: null });
const feed = {
  src: 'simplefin', fetchedAt: now, fromMs: now - 200 * DAY * 1000, toMs: now, errors: [],
  accounts: [{ extId: 'ACT-CHK-7', connId: 'CON-1', institution: 'Example Bank', name: 'Main Checking', currency: 'USD', balance: 512300, available: 512300, asOf: now - 3600000,
    txs: [
      row('C1', -1250, 2, 'FERNLEAF CAFE 0042'), row('C2', -980, 9, 'FERNLEAF CAFE 0042'),
      row('G1', -6400, 4, 'QUARRY MARKET 118'), row('G2', -5150, 11, 'QUARRY MARKET 118'),
      row('A1', -2399, 3, 'AMZN Mktp US*2K4XY12Z3 Amzn.com/bill WA'), row('A2', -4150, 8, 'AMZN Mktp US*7Q2RT88W1 Amzn.com/bill WA'),
    ] }],
};
const state = defaultState(now - 200 * DAY * 1000);
mergeFeed(state, feed, now);
refresh(state, now);
state.settings.cover = cover;
store.load(state, { readonly: true });

const toasts = [];
runtime.setServices({ toast: (message, opts) => toasts.push({ message, action: opts && opts.action ? opts.action : null }) });
const setCtx = () => runtime.setContext({
  state: store.state, ui: store.ui, now, words: 'chess', today: dates.gameDay(now, store.state.settings.rolloverHour),
  route: { view: 'flows', segs: [], params: {}, sheet: null }, d: makeDerived(store.state, now, { words: 'chess' }), demo: false,
  sync: { state: 'off' }, share: {}, inbox: {}, income: {}, wide: false,
});
const queued = () => moveQueue(store.state, now).items.map((item) => item.mkey + (item.catchAll ? ' (one)' : ''));
const out = { before: queued() };

// 1. the transaction sheet: the cafe's latest move saved as it stands (its guess, the whole merchant)
setCtx();
const cafe = store.state.txs.filter((t) => t.mkey === 'fernleaf cafe').sort((a, b) => (a.day < b.day ? 1 : -1))[0];
out.cafeGuess = cafe.category;
sheet.actions['tx.save']({ values: { category: cafe.category, klass: cafe.klass, purpose: cafe.purpose, scope: 'all' }, data: { id: cafe.id } });
const saved = store.state.txs.find((t) => t.id === cafe.id);
const copy = exportCorrections(store.state) || { moves: {}, rules: {} };
out.sheet = {
  locked: Array.isArray(saved.locks) && saved.locks.includes('category'),
  category: saved.category,
  moves: Object.values(copy.moves || {}).map((entry) => entry.category && entry.category.v),
  rules: Object.keys(copy.rules || {}).filter((key) => key.endsWith(':out')).length,
  toast: toasts.at(-1),
  queue: queued(),
};

// 2. the queue's one tap: the grocer at its guess, in one undoable update
setCtx();
const grocer = moveQueue(store.state, now).items.find((item) => item.mkey === 'quarry market');
flows.actions['flows.file']({ data: { key: grocer.key, cat: grocer.guess } });
out.tap = { toast: toasts.at(-1), queue: queued(), undoLabel: store.undoLabel || null };
// its Undo puts the grocer back in the queue
store.undo();
out.undone = queued();

// 3. one Amazon order, on its own
setCtx();
const order = moveQueue(store.state, now).items.find((item) => item.mkey === 'amazon');
flows.actions['flows.file']({ data: { key: order.key, cat: 'household' } });
out.order = { toast: toasts.at(-1), queue: queued(), amazonRule: (store.state.settings.rules || []).some((rule) => rule.mkey === 'amazon') };

// a record of its own for each case below, read from the same invented bank
const fresh = (txs) => {
  const next = defaultState(now - 200 * DAY * 1000);
  mergeFeed(next, { ...feed, accounts: [{ ...feed.accounts[0], txs }] }, now);
  refresh(next, now);
  next.settings.cover = cover;
  store.load(next, { readonly: true });
};
const byExt = (id) => store.state.txs.find((t) => t.ext && t.ext.id === id);
const ruleOf = (mkey) => (store.state.settings.rules || []).filter((rule) => rule.mkey === mkey && rule.flow === 'out').map((rule) => rule.category);

// 4. a note alone, saved on a move filed "this move only" at a store whose other moves follow a learned rule: the form
// posts the move's category as it stands and "All money out" (the default for a store that is no catch-all); the rule
// and the other moves stay as they are, and only the note changes
fresh([row('Q1', -6400, 4, 'QUARRY MARKET 118'), row('Q2', -5150, 8, 'QUARRY MARKET 118'), row('Q3', -4800, 11, 'QUARRY MARKET 118')]);
setCtx();
sheet.actions['tx.save']({ values: { category: 'groceries', scope: 'all' }, data: { id: byExt('Q3').id } });
setCtx();
sheet.actions['tx.save']({ values: { category: 'household', scope: 'one' }, data: { id: byExt('Q2').id } });
const filedBefore = { rule: ruleOf('quarry market'), categories: ['Q1', 'Q2', 'Q3'].map((id) => byExt(id).category) };
setCtx();
sheet.actions['tx.save']({ values: { category: 'household', scope: 'all', note: 'paper towels' }, data: { id: byExt('Q2').id } });
const travels = exportCorrections(store.state) || { rules: {} };
out.note = {
  before: filedBefore,
  rule: ruleOf('quarry market'),
  categories: ['Q1', 'Q2', 'Q3'].map((id) => byExt(id).category),
  note: byExt('Q2').note,
  travels: Object.entries(travels.rules || {}).filter(([key]) => key.endsWith(':out')).map(([, entry]) => entry.category && entry.category.v),
  toast: toasts.at(-1),
};

// 5. one tap on a store's money-out item while one of its refunds waits beside it: the refund follows the rule (3.3), the
// item says so before the tap, and the toast names it
fresh([row('R1', -6400, 4, 'QUARRY MARKET 118'), row('R2', -5150, 9, 'QUARRY MARKET 118'), row('R3', 1200, 10, 'QUARRY MARKET 118')]);
setCtx();
const spends = moveQueue(store.state, now).items.find((item) => item.key === 'out:quarry market');
out.refund = { before: moveQueue(store.state, now).items.map((item) => item.key), refunds: spends ? spends.refunds : null };
flows.actions['flows.file']({ data: { key: 'out:quarry market', cat: 'groceries' } });
out.refund.toast = toasts.at(-1);
out.refund.after = moveQueue(store.state, now).items.map((item) => item.key);
out.refund.refundCategory = byExt('R3').category;

// 6. a move at Uncategorized files nothing by being saved: a note alone, then Save with nothing changed, on a Zelle payment
// to one person (the person's key; the built-in rule reads it as Uncategorized and marks it for a look). Neither writes
// a rule or a lock, so the payments stay in the queue and in "Not yet filed" alike
const unfiled = () => (whereItWent(store.state, now, 30).groups.find((group) => group.klass === 'other') || { amount: 0 }).amount;
const queuedOf = (mkey) => moveQueue(store.state, now).items.filter((item) => item.mkey === mkey).reduce((n, item) => n + item.count, 0);
const read = (ids) => ids.map((id) => { const t = byExt(id); return [t.category, t.klass, (t.locks || []).filter((lock) => lock !== 'review').join('+') || '-', t.ruleId]; });
const travelled = () => { const c = exportCorrections(store.state) || {}; return { rules: Object.keys(c.rules || {}).length, moves: Object.keys(c.moves || {}).length }; };
fresh([row('Z1', -4000, 3, 'Zelle payment to Robin Vale Conf# k7q2'), row('Z2', -2500, 9, 'Zelle payment to Robin Vale Conf# p3x8'), row('G1', -6400, 4, 'QUARRY MARKET 118')]);
out.zelle = { before: { queued: queuedOf('zelle to robin vale'), unfiled: unfiled() } };
setCtx();
let z = byExt('Z1');
sheet.actions['tx.save']({ values: { category: z.category, klass: z.klass, purpose: z.purpose, scope: 'all', note: 'shared dinner' }, data: { id: z.id } });
out.zelle.note = { toast: toasts.at(-1), rows: read(['Z1', 'Z2']), note: byExt('Z1').note, rules: (store.state.settings.rules || []).length, travels: travelled(), queued: queuedOf('zelle to robin vale'), unfiled: unfiled() };
setCtx();
z = byExt('Z2');
sheet.actions['tx.save']({ values: { category: z.category, klass: z.klass, purpose: z.purpose, scope: 'all', note: '' }, data: { id: z.id } });
out.zelle.asIs = { toast: toasts.at(-1), rows: read(['Z1', 'Z2']), rules: (store.state.settings.rules || []).length, travels: travelled(), queued: queuedOf('zelle to robin vale'), unfiled: unfiled() };

// 7. the same note on one payment-app move (a catch-all: the sheet defaults to this move only): no lock, still queued
fresh([row('V1', -4000, 3, 'VENMO PAYMENT 1024781'), row('V2', -2500, 9, 'VENMO PAYMENT 1024799'), row('G1', -6400, 4, 'QUARRY MARKET 118')]);
const venmoBefore = queuedOf('venmo payment');
setCtx();
z = byExt('V1');
sheet.actions['tx.save']({ values: { category: z.category, klass: z.klass, purpose: z.purpose, scope: 'one', note: 'rent share' }, data: { id: z.id } });
out.venmo = { before: venmoBefore, after: queuedOf('venmo payment'), rows: read(['V1', 'V2']), travels: travelled(), toast: toasts.at(-1) };

// 8. a note on a mobile check deposit: money in that is no refund keeps its own filing for later, so nothing is learned
fresh([row('D1', 42000, 3, 'MOBILE CHECK DEPOSIT'), row('D2', 7550, 10, 'MOBILE CHECK DEPOSIT'), row('G1', -6400, 4, 'QUARRY MARKET 118')]);
setCtx();
z = byExt('D1');
sheet.actions['tx.save']({ values: { category: z.category, klass: z.klass, purpose: z.purpose, scope: 'all', note: 'birthday check' }, data: { id: z.id } });
out.cheque = { rows: read(['D1', 'D2']), note: byExt('D1').note, rules: (store.state.settings.rules || []).length, travels: travelled(), toast: toasts.at(-1) };

// 9. parking fines, which the built-in rule files under Tolls and parking as One-off: a note on one files the guess for
// the whole merchant with its class, so every fine stays One-off; then Save as it stands on another says "Filed"
fresh([row('N1', -6500, 3, 'NYC FINANCE PARKING 0193'), row('N2', -6500, 9, 'NYC FINANCE PARKING 0571'), row('N3', -11500, 12, 'NYC FINANCE PARKING 0610')]);
out.fines = { before: read(['N1', 'N2', 'N3']) };
setCtx();
z = byExt('N1');
sheet.actions['tx.save']({ values: { category: z.category, klass: z.klass, purpose: z.purpose, scope: 'all', note: 'street cleaning' }, data: { id: z.id } });
out.fines.note = { rows: read(['N1', 'N2', 'N3']), rule: (store.state.settings.rules || []).map((rule) => [rule.category, rule.klass || null]), toast: toasts.at(-1) };
fresh([row('N1', -6500, 3, 'NYC FINANCE PARKING 0193'), row('N2', -6500, 9, 'NYC FINANCE PARKING 0571')]);
setCtx();
z = byExt('N2');
sheet.actions['tx.save']({ values: { category: z.category, klass: z.klass, purpose: z.purpose, scope: 'all' }, data: { id: z.id } });
out.fines.asIs = { rows: read(['N1', 'N2']), toast: toasts.at(-1), queued: queuedOf(z.mkey) };

process.stdout.write(JSON.stringify(out));
process.exit(0);
