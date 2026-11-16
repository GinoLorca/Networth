// node tests/helpers/render-settings.mjs <chess|finance> <on|off|refused|sample> [forced] [saved=<chess|finance>] [click=<chess|finance>]
// Renders the Settings page under node, from the sample record set up as a linked one, and prints its markup as JSON.
// saved= sets the record's own choice; click= chooses through the switch's own handler, then renders again with the
// same words in force (the address keeps forcing them). The few globals a browser has are stubbed here, in a process
// of its own, so no test file shares them.
const [words = 'chess', share = 'on', forced = '', ...more] = process.argv.slice(2);
const opt = (name) => { const hit = more.find((x) => x.startsWith(name + '=')); return hit ? hit.slice(name.length + 1) : null; };
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
const settings = await import(new URL('views/settings.js', js));

const state = buildDemoState(now);
state.meta.origin = 'bank';
if (opt('saved')) state.settings.words = opt('saved');
store.load(state, { readonly: true });
const shares = {
  on: { available: true, on: true, owner: 'example-owner', canShare: true, lastAt: now - 60000, state: 'ok' },
  off: { available: true, on: false, owner: 'example-owner', canShare: false },
  refused: { available: true, on: true, owner: 'example-owner', code: 'key', message: ' The key was refused.', canShare: true },
  sample: { available: true, on: false, owner: 'example-owner' },
};
const contextNow = () => ({
  state: store.state, ui: store.ui, now, words, wordsForced: forced === 'forced',
  today: dates.gameDay(now, store.state.settings.rolloverHour),
  route: { view: 'settings', segs: [], params: {}, sheet: null },
  d: makeDerived(store.state, now, { words }), demo: share === 'sample',
  sync: { state: 'off' }, share: shares[share], inbox: {}, income: {}, wide: true,
});
let ctx = contextNow();
if (runtime.setContext) runtime.setContext(ctx);
let out;
try {
  out = String(settings.render(ctx));
  if (opt('click')) {
    settings.actions['settings.words']({ el: { value: opt('click') }, data: {} });
    ctx = contextNow();
    if (runtime.setContext) runtime.setContext(ctx);
    out = String(settings.render(ctx));
  }
} catch (e) { out = 'ERROR ' + e.stack; }
process.stdout.write(JSON.stringify(out));
process.exit(0);
