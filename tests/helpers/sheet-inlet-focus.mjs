// node tests/helpers/sheet-inlet-focus.mjs
// Round 9 (K20): taps Remove and then Cancel on a source's sheet (views/sheet-inlet.js) with a stand-in document, in a
// process of its own (the view imports the store), and prints what each tap focused and scrolled, as JSON.
const noop = () => {};
const el = () => ({ setAttribute: noop, getAttribute: () => null, addEventListener: noop, removeEventListener: noop, appendChild: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {} });
const seen = [];
const confirm = { scrollIntoView: (opts) => seen.push({ scrolled: 'confirm', opts }) };
const node = (name, inConfirm) => ({ focus: () => seen.push({ focused: name }), closest: (sel) => (sel === '.inlet-confirm' && inConfirm ? confirm : null),
  scrollIntoView: (opts) => seen.push({ scrolled: name, opts }) });
const host = { querySelector: (sel) => (sel.includes('inlet.remove-cancel') ? node('cancel', true) : sel.includes('inlet.remove-ask') ? node('remove', false) : null) };
globalThis.BroadcastChannel = undefined;
globalThis.window = { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '', search: '' } };
globalThis.document = { addEventListener: noop, removeEventListener: noop, documentElement: el(), body: el(), createElement: el,
  querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', getElementById: (id) => (id === 'sheet-host' ? host : null) };
globalThis.addEventListener = noop;
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
let out;
try {
  const { actions } = await import(new URL('../../js/views/sheet-inlet.js', import.meta.url));
  actions['inlet.remove-ask']({ data: { id: 'n0000000000001' } });
  const ask = seen.splice(0);
  actions['inlet.remove-cancel']({ data: {} });
  out = { ask, cancel: seen.splice(0) };
} catch (e) { out = 'ERROR ' + e.stack; }
process.stdout.write(JSON.stringify(out), () => process.exit(0));
