// node tests/helpers/render-flows.mjs <chess|finance> [dismissed] [notice] [year] [shared] [moneyin] [cover] [tx=rule|payer|payment|paired] [allfiled] [queuefiled] [appitem] [aside] [newform]
// Renders the Money in and out page under node from the sample record and prints its markup as JSON. `dismissed` says
// Not one to the first possible line first; `notice` gives the page a notice of a replaced line added by hand; `year`
// shows 365 days; `shared` renders as with sharing on. The few globals a browser has are stubbed here, in a process of
// its own, so no test file shares them.
const [words = 'chess', ...more] = process.argv.slice(2);
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
const now = new Date('2026-06-18T14:30:00').getTime();
dates.setNow(now);
const { buildDemoState } = await import(new URL('model/demo.js', js));
const { makeDerived } = await import(new URL('derive.js', js));
const { store } = await import(new URL('store.js', js));
const runtime = await import(new URL('runtime.js', js));
const flowsection = await import(new URL('model/flowsection.js', js));
const flows = await import(new URL('model/flows.js', js));
const view = await import(new URL('views/flows.js', js));

// `moneyin`: the app's own sample, with the invented money in of pass 3 (buildDemoState's moneyIn)
const state = buildDemoState(now, { moneyIn: more.includes('moneyin') });
flowsection.seedFlows(state, now);
if (more.includes('dismissed')) {
  const one = flows.repertoire(state, now).possible[0];
  if (one) flowsection.decideLine(state, one.kind === 'line' ? state.recurring.find((rec) => rec.id === one.id) : one.line, 'sub', false, now);
}
if (more.includes('notice')) {
  state.share.flowsNotice = [{ path: 'added/a0000000000001', kind: 'added', key: 'a0000000000001', was: { name: 'Harbor Gym', amount: 6000 }, now: { name: 'Harbor Gym', amount: 4500 } }];
}
if (more.includes('cover')) state.settings.cover = true;
// `tx=paired` (round 3): the first deposit filed by its payer, said to pair with a payment of the app the sample does not
// file (Print orders), as a bank deposit of a payer filed from the queue does once that app reports its payment; round 9
// (F2): a later deposit of the same sender pairs too, so the sender is a regular of the app and the app files them
let pairedId = null;
if (more.includes('tx=paired')) {
  const inlets = await import(new URL('model/inlets.js', js));
  const look = inlets.lookOf(state);
  const tx = state.txs.find((one) => one.kind === 'income' && one.flow === 'in' && one.source !== 'manual' && !one.pending && inlets.filingOf(look, one).how === 'payer');
  const next = tx ? state.txs.find((one) => one.id !== tx.id && one.mkey === tx.mkey && one.source !== 'manual' && !one.pending && one.day > tx.day) : null;
  if (tx) { state.income.pairs = { ...(state.income.pairs || {}), 'prints/im1': tx.id, ...(next ? { 'prints/im2': next.id } : {}) }; pairedId = tx.id; }
}
// round 4: `allfiled`, the suggestions added and every deposit of the queue's In filed (to Windfalls), so nothing waits in
// the queue; `appitem`, the queue's first deposit said to pair with a payment of Print orders (the app the sample does not
// file), so the queue holds the app's item; `newform`, the payroll's payer filing removed and the queue's "New source…"
// form open under its item
let openNew = null;
if (more.includes('allfiled') || more.includes('queuefiled') || more.includes('appitem') || more.includes('aside') || more.includes('newform')) {
  const inlets = await import(new URL('model/inlets.js', js));
  if (more.includes('allfiled')) {
    for (const one of inlets.suggestions(state, now).shown) inlets.acceptOffer(state, one, now);
    for (const one of inlets.depositQueue(state, now).items) inlets.fileQueueItem(state, one, inlets.WINDFALL, now);
  }
  // `queuefiled`: every item of the queue's In filed, the suggestions left as they are (round 5)
  if (more.includes('queuefiled')) for (const one of inlets.depositQueue(state, now).items) inlets.fileQueueItem(state, one, inlets.WINDFALL, now);
  // round 9 (F2): the queue's first deposit's sender is made a regular of the app (a second deposit of theirs, a week
  // earlier, pairs too: a sender's only paired deposit is asked about under the sender); `aside`, its one deposit pairs
  // alone, so the queue asks about it under its sender and names the pairing
  if (more.includes('appitem') || more.includes('aside')) {
    const first = inlets.depositQueue(state, now).items[0];
    const tx = first ? state.txs.find((one) => one.id === first.txId) : null;
    if (tx) state.income.pairs = { ...(state.income.pairs || {}), 'prints/im1': tx.id };
    if (tx && more.includes('appitem')) {
      const day = dates.addDays(tx.day, -7);
      const twin = { ...JSON.parse(JSON.stringify(tx)), id: tx.id + '-twin', day, postedDay: day, fp: String(tx.fp || '').replace(tx.day, day) + '|twin',
        ext: { ...(tx.ext || {}), id: String((tx.ext && tx.ext.id) || tx.id) + '-twin' } };
      state.txs.push(twin);
      state.income.pairs['prints/im2'] = twin.id;
    }
  }
  if (more.includes('newform')) {
    const look = inlets.lookOf(state);
    const tx = state.txs.find((one) => one.kind === 'income' && one.flow === 'in' && one.source !== 'manual' && !one.pending && one.streamId != null
      && inlets.filingOf(look, one).how === 'payer' && (look.inlets.get(inlets.filingOf(look, one).to) || {}).kind === 'steady');
    const key = tx ? inlets.filingOf(look, tx).key : null;
    if (key) { inlets.fileQueueItem(state, { intoKey: key }, null, now); openNew = 'payer:' + key; }
  }
}
store.load(state, { readonly: true });
if (openNew) store.setUi({ flNewIn: openNew });
const ctx = {
  state: store.state, ui: store.ui, now, words, wordsForced: true,
  today: dates.gameDay(now, store.state.settings.rolloverHour),
  route: { view: 'flows', segs: [], params: more.includes('year') ? { p: '365' } : {}, sheet: null },
  d: makeDerived(store.state, now, { words }), demo: true,
  sync: { state: 'off' }, share: more.includes('shared') ? { available: true, on: true, state: 'ok' } : { available: false, on: false, state: 'off' },
  inbox: {}, income: {}, wide: true,
};
if (runtime.setContext) runtime.setContext(ctx);
let out;
// `tx=rule` or `tx=payer`: the source block of the sheet of the first deposit filed that way (by a built-in rule, by its
// payer), instead of the page
const txArg = more.find((one) => one.startsWith('tx='));
try {
  if (txArg) {
    const inflows = await import(new URL('views/inflows.js', js));
    const inlets = await import(new URL('model/inlets.js', js));
    const look = inlets.lookOf(store.state);
    const how = txArg.slice(3);
    // `tx=payment`: the first payment another app reported (cash, or pencil until the bank shows it)
    const tx = how === 'payment' ? store.state.txs.find((one) => inflows.isMoneyInMove(one) && one.source === 'manual' && one.via === 'income')
      : how === 'paired' ? store.state.txs.find((one) => one.id === pairedId)
        : store.state.txs.find((one) => inflows.isMoneyInMove(one) && !one.pending && inlets.filingOf(look, one).how === how);
    out = tx ? String(inflows.txSourceBlock(ctx, tx)) : 'ERROR no deposit filed by ' + how;
  } else {
    out = String(view.render(ctx));
  }
} catch (e) { out = 'ERROR ' + e.stack; }
// the page is long: exit once the whole of it is written to the pipe
process.stdout.write(JSON.stringify(out), () => process.exit(0));
