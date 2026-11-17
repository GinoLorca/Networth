// node tests/helpers/render-wrap.mjs <chess|finance> <wrap state> [share=<on|off>]
// Renders Settings under node from the sample record set up as a linked one, with the nightly wrap in the state named
// (ARCHITECTURE 3.10), and the day sheet of today, of a day in pencil and of a final day; prints { settings, days } as
// JSON. The few globals a browser has are stubbed here, in a process of its own, so no test file shares them.
const [words = 'chess', which = 'nokey', ...more] = process.argv.slice(2);
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
const daySheet = await import(new URL('views/sheet-day.js', js));

const state = buildDemoState(now);
state.meta.origin = 'bank';
store.load(state, { readonly: true });
const share = opt('share') === 'off'
  ? { available: true, on: false, owner: 'example-owner', canShare: false }
  : { available: true, on: true, owner: 'example-owner', canShare: true, lastAt: now - 60000, state: 'ok' };
const vapid = { publicKey: 'B' + 'A'.repeat(86), madeAt: now - 3 * 86400000 };
const status = (over) => ({ lastAt: null, lastDay: null, got: false, dead: false, keyProblem: false, noKey: false, problem: null, retry: false, refused: false, nextRun: 'night', ...over });
const base = { available: true, on: share.on, standalone: false, pushable: true, device: 'dev1example0000x', owner: 'example-owner', vapid,
  reading: false, busy: null, code: null, made: null, subscribed: false, gone: false, lock: 'cover', status: status({}),
  secretUrl: 'https://github.com/example-owner/networth-data/settings/secrets/actions/new',
  secretsUrl: 'https://github.com/example-owner/networth-data/settings/secrets/actions', replacing: false };
const WRAPS = {
  reading: { ...base, vapid: undefined, reading: true },
  failed: { ...base, vapid: undefined, code: 'network' },
  nokey: { ...base, vapid: null },
  made: { ...base, made: 'k'.repeat(43) },
  key: { ...base },
  standalone: { ...base, standalone: true },
  on: { ...base, standalone: true, subscribed: true, lock: 'show', status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', got: true }) },
  gone: { ...base, standalone: true, gone: true },
  dead: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', dead: true }) },
  keyproblem: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', keyProblem: true }) },
  nosecret: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', noKey: true }) },
  keytab: { ...base, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', keyProblem: true }) },
  problem: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 600000, lastDay: '2026-06-18', problem: 429, retry: true }) },
  problemprev: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', problem: 429, retry: true }) },
  problemlate: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', problem: 429 }) },
  refused: { ...base, standalone: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', problem: 403, refused: true }) },
  pushfile: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', problem: 'file' }) },
  subfail: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', problem: 'subscription' }) },
  oddtoken: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', problem: 'weird-token' }) },
  nosecretfirst: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 600000, lastDay: '2026-06-18', noKey: true, nextRun: 'backup' }) },
  nosecretstale: { ...base, standalone: true, subscribed: true, status: status({ lastAt: now - 17 * 3600000, lastDay: '2026-06-17', noKey: true, nextRun: 'backup' }) },
  replace: { ...base, made: 'k'.repeat(43), replacing: true },
  replaceunknown: { ...base, made: 'k'.repeat(43), replacing: null },
};
const contextNow = (route) => ({
  state: store.state, ui: store.ui, now, words, wordsForced: false,
  today: dates.gameDay(now, store.state.settings.rolloverHour),
  route, d: makeDerived(store.state, now, { words }), demo: false,
  sync: { state: 'off' }, share, inbox: {}, income: {}, wrap: WRAPS[which], wide: true,
});
const out = { settings: '', days: {} };
try {
  const ctx = contextNow({ view: 'settings', segs: [], params: {}, sheet: null });
  if (runtime.setContext) runtime.setContext(ctx);
  out.settings = String(settings.render(ctx));
  const today = ctx.today;
  for (const day of [today, dates.addDays(today, -1), dates.addDays(today, -6), dates.addDays(today, 3)]) {
    const c = contextNow({ view: 'board', segs: [], params: {}, sheet: { name: 'day', params: { day } } });
    if (runtime.setContext) runtime.setContext(c);
    out.days[day] = String(daySheet.render(c, { day }));
  }
} catch (e) { out.settings = 'ERROR ' + e.stack; }
process.stdout.write(JSON.stringify(out));
process.exit(0);
