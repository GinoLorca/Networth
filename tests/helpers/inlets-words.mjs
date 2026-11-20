// node tests/helpers/inlets-words.mjs '<json>'
// Calls the pure word functions of the money-in views (views/inflows.js, views/sheet-inlet.js) under node, in a process of
// its own (the views import the store, whose timers would keep a test file's process alive), and prints their results as
// JSON. The argument is a list of calls: [module, function, ...arguments], module 'inflows', 'sheet-inlet' or 'flows'.
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
const modules = {
  inflows: await import(new URL('views/inflows.js', js)),
  'sheet-inlet': await import(new URL('views/sheet-inlet.js', js)),
  flows: await import(new URL('views/flows.js', js)),
};
let out;
try {
  const calls = JSON.parse(process.argv[2] || '[]');
  out = calls.map(([module, fn, ...args]) => String(modules[module][fn](...args)));
} catch (e) { out = 'ERROR ' + e.stack; }
process.stdout.write(JSON.stringify(out), () => process.exit(0));
