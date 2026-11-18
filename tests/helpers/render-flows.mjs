// node tests/helpers/render-flows.mjs <chess|finance> [dismissed] [notice] [year] [shared]
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

const state = buildDemoState(now);
flowsection.seedFlows(state, now);
if (more.includes('dismissed')) {
  const one = flows.repertoire(state, now).possible[0];
  if (one) flowsection.decideLine(state, one.kind === 'line' ? state.recurring.find((rec) => rec.id === one.id) : one.line, 'sub', false, now);
}
if (more.includes('notice')) {
  state.share.flowsNotice = [{ path: 'added/a0000000000001', kind: 'added', key: 'a0000000000001', was: { name: 'Harbor Gym', amount: 6000 }, now: { name: 'Harbor Gym', amount: 4500 } }];
}
store.load(state, { readonly: true });
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
try { out = String(view.render(ctx)); } catch (e) { out = 'ERROR ' + e.stack; }
// the page is long: exit once the whole of it is written to the pipe
process.stdout.write(JSON.stringify(out), () => process.exit(0));
