/**
 * Money in, pass 3, as the page shows it: Fig. 1 (the chart kind `inlets`, DESIGN G.4), the sample game rendering every
 * money-in section in both word modes, the Board's quiet line counting moves in and out, and the words (both modes, the
 * glossary rows, no banned word in a new file). Every name and figure here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PHRASES, TERMS, phrase, placeholders, say, term } from '../js/model/words.js';

/** The chart reads the words from the root element, as app.js sets them (data-words); a stand-in root here. */
let rootWords = null;
globalThis.document = { documentElement: { getAttribute: (name) => (name === 'data-words' ? rootWords : null) } };
const { chartSummary, chartSvg } = await import('../js/ui/charts.js');

const MONTHS = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
const cells = (fn) => MONTHS.map((ym, k) => ({ ym, bank: 0, pencil: 0, ...fn(k) }));
/** A record of six months (from June): Day job every month, Print sales twice (once part in pencil), a small source. */
function fig(extra = {}) {
  return {
    months: MONTHS, first: '2026-06', today: '2026-11-18',
    rows: [
      { name: 'Day job', total: 2340000, paid: 6, onRecord: 6, goal: 400000, cells: cells((k) => (k < 6 ? { blank: true } : { bank: 390000 })) },
      { name: 'Print sales', total: 161000, est: true, paid: 2, onRecord: 6, cells: cells((k) => (k < 6 ? { blank: true } : k === 7 ? { bank: 100000 } : k === 10 ? { bank: 40000, pencil: 21000 } : {})) },
      { name: 'Odd jobs', total: 900, paid: 1, onRecord: 6, cells: cells((k) => (k < 6 ? { blank: true } : k === 8 ? { bank: 900 } : {})) },
      { name: '', unfiled: true, total: 97500, paid: 3, onRecord: 6, cells: cells((k) => (k < 6 ? { blank: true } : k % 2 ? { bank: 32500 } : {})) },
    ],
    ...extra,
  };
}

const rects = (svg, cls) => [...svg.matchAll(new RegExp('<rect class="' + cls + '"[^>]*>', 'g'))].map((m) => m[0]);
const attr = (tag, name) => Number((tag.match(new RegExp(' ' + name + '="([-0-9.]+)"')) || [])[1]);

/* ------------------------------------------------------------------ Fig. 1 */

test('Fig. 1: one scale for every row, a dot for a month with no money, the sliver, hatch for pencil, the month so far in the spot colour', () => {
  const svg = chartSvg('inlets', fig(), 800, 0);
  assert.equal(typeof svg, 'string');
  // one scale: the largest month (3,900.00, or the goal, 4,000.00) is the full height in every row
  const bars = rects(svg, 'nwc-in-bar');
  const tall = Math.max(...bars.map((tag) => attr(tag, 'height')));
  const day = bars.filter((tag) => attr(tag, 'height') === tall);
  assert.ok(day.length >= 5, 'the Day job months are the tallest');
  const print = bars.find((tag) => attr(tag, 'height') < tall && attr(tag, 'height') > tall * 0.2);
  assert.ok(print, 'Print sales is drawn smaller on the same scale');
  // the sliver: $9.00 against $4,000.00 still draws 2px
  assert.ok(bars.some((tag) => attr(tag, 'height') === 2), 'a small payment is never invisible');
  // dots for months on record with no money, none for the months before the record
  const dots = (svg.match(/<circle class="nwc-pt nwc-in-dot"/g) || []).length + (svg.match(/<circle class="nwc-dot"/g) || []).length;
  assert.equal(dots, (6 - 6) + (6 - 2) + (6 - 1) + (6 - 3), 'a dot for each month on record with no money');
  // pencil money hatched; the current month in the spot colour
  assert.equal((svg.match(/class="nwc-in-pencil"/g) || []).length, 1);
  assert.match(svg, /style="fill:url\(#[^)]*b\)"/);
  assert.ok(rects(svg, 'nwc-in-now').length >= 1, 'November so far in the spot colour');
  assert.match(svg, /<text class="nwc-t nwc-spot"[^>]*>NOV 18<\/text>/, 'labelled to the day');
  // a goal a month: a dashed tick across its row
  assert.equal((svg.match(/nwc-in-goal/g) || []).length, 1);
});

test('Fig. 1: a six-month record is blank before its hairline, "paid in n of m months on record", ≈ on a total with pencil', () => {
  const svg = chartSvg('inlets', fig(), 800, 0);
  assert.equal((svg.match(/nwc-in-floor/g) || []).length, 1, 'the hairline at the record\'s first month');
  assert.match(svg, /paid in 2 of 6 months on record/);
  assert.match(svg, /paid in 6 of 6 months on record/);
  assert.match(svg, /<text class="nwc-f nwc-f-s nwc-money nwc-est"[^>]*><tspan class="nwc-approx">≈<\/tspan> \$1,610<\/text>/, 'pencil in the total: italic with ≈');
  assert.match(svg, /nwc-money"[^>]*>\$23,400<\/text>/, 'bank money roman');
  // no baseline before the record: each row's hairline starts at June
  const base = [...svg.matchAll(/<path class="nwc-grid" d="M([0-9.]+) /g)].map((m) => Number(m[1]));
  assert.ok(base.every((x) => x > 300), 'baselines start at the record');
  // a full year: no hairline
  const full = fig({ first: '2025-11' });
  for (const row of full.rows) for (const cell of row.cells) cell.blank = false;
  assert.doesNotMatch(chartSvg('inlets', full, 800, 0), /nwc-in-floor/);
});

test('Fig. 1: under 480px two lines a source; the summary; the cover name; nothing to draw', () => {
  const wide = chartSvg('inlets', fig(), 800, 0);
  const narrow = chartSvg('inlets', fig(), 320, 0);
  const height = (svg) => Number((svg.match(/<path class="nwc-grid nwc-in-rule" d="M0 ([0-9.]+)H/) || [])[1]);
  assert.ok(height(narrow) > height(wide), 'a taller row: the name and total over the columns');
  const bars = rects(narrow, 'nwc-in-bar');
  assert.ok(bars.every((tag) => attr(tag, 'x') >= 0 && attr(tag, 'x') + attr(tag, 'width') <= 320), 'the columns fit the width');
  assert.equal(chartSummary('inlets', { ...fig(), summary: 'Money in by source, Jun to Nov, the record so far: …' }), 'Money in by source, Jun to Nov, the record so far: …');
  assert.match(chartSummary('inlets', fig()), /^Money in by source, Dec 2025 to Nov 2026: Day job \$23,400, paid in 6 of 6 months; Print sales ≈\$1,610/);
  assert.equal(chartSvg('inlets', { months: MONTHS, rows: [] }, 800, 0), null, 'no row: the empty frame');
  // every figure is a covered money text
  assert.ok((wide.match(/nwc-money/g) || []).length >= 4);
});

/* ------------------------------------------------------------------ the sample game */

function render(...args) {
  const helper = fileURLToPath(new URL('./helpers/render-flows.mjs', import.meta.url));
  const page = JSON.parse(execFileSync(process.execPath, [helper, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(!page.startsWith('ERROR'), page.slice(0, 600));
  return page;
}

test('the sample game renders every money-in section, in both word modes', () => {
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin');
    const section = page.slice(page.indexOf('class="band fl-in"'), page.indexOf('class="band fl-dev"'));
    assert.ok(section.length > 1000, words + ': Reinforcements');
    assert.match(section, new RegExp('<b>' + phrase('inlets.h', words) + '</b>'));
    for (const name of ['Day job', 'Photo shoots', 'Sittings', 'Stock photos']) assert.ok(section.includes(name), words + ': ' + name);
    for (const kind of ['steady', 'job', 'backend']) assert.ok(section.includes(phrase('inlets.kind.' + kind, words)), words + ' kind ' + kind);
    assert.ok(section.includes(phrase('inlets.focus', words)), 'the tag');
    assert.match(section, /paydays/, 'Steady pay compares paydays');
    assert.match(section, /sessions ·/, 'money per session, as reported');
    assert.match(section, /on record since <span data-cover-keep>Jul 2025<\/span> · paid in <span data-cover-keep>4<\/span> of/, 'Back-end over 12 months, the first month named (round 9)');
    assert.ok(section.includes(phrase('inlets.unfiled', words)) && section.includes('data-action="flows.queue" data-open="1"'), 'Not yet filed with file ↑');
    assert.ok(section.includes(phrase('inlets.windfalls', words)), 'Windfalls apart');
    assert.ok(section.includes('data-to="add"') && section.includes('data-to="not"'), 'a suggestion with Add and Not now');
    assert.match(section, /<details class="fl-s-gone">\s*<summary class="btn-link">Dismissed · <span data-cover-keep>1<\/span>/, '+ Dismissed · 1, collapsed');
    assert.match(section, /<nw-chart data-island kind="inlets"/, 'Fig. 1');
    assert.ok(section.includes('fl-fig-table'), '+ As a table');
    const dev = page.slice(page.indexOf('class="band fl-dev"'));
    assert.ok(dev.includes('App builds'), 'Development: the prospect');
    assert.match(dev, new RegExp(phrase('inlets.dev', words)));
    // the queue: the money in first, under its own label, and the line "n in · m out"
    const q = page.slice(page.indexOf('id="fl-q"'), page.indexOf('class="band fl-went"'));
    assert.match(q, /\d+ in · \d+ out/);
    assert.match(q, /data-side="in"/);
    assert.ok(q.indexOf('data-side="in"') < q.indexOf('data-side="out"'));
    assert.match(q, /data-action="inlets\.file"/);
  }
});

test('cover: every amount of the money-in sections is covered; counts and shares stay readable', () => {
  const page = render('chess', 'moneyin', 'cover');
  const section = page.slice(page.indexOf('class="band fl-in"'), page.indexOf('class="band fl-dev"'));
  // a dollar figure stands only inside a covered element: .fig, data-fig, or the chart's data (drawn as covered figures)
  const outside = section.replace(/<nw-chart[\s\S]*?<\/nw-chart>/g, '').replace(/<span class="approx">≈<\/span>/g, '')
    .replace(/<span class="[^"]*\bfig\b[^"]*"[^>]*>[\s\S]*?<\/span>/g, '')
    .replace(/<td class="[^"]*\bfig\b[^"]*"[^>]*>[\s\S]*?<\/td>/g, '')
    .replace(/<span class="[^"]*"\s+data-fig>[\s\S]*?<\/span>/g, '')
    .replace(/<span class="[^"]*row-value fig[^"]*">[\s\S]*?<\/span>/g, '');
  assert.doesNotMatch(outside.replace(/<[^>]+>/g, ' '), /\$\d/, 'no amount outside a covered element');
});

test('the Board\'s quiet line counts moves in and out', async () => {
  assert.equal(phrase('flows.queue.count', 'chess'), '{in} in · {out} out');
  assert.deepEqual(placeholders(phrase('board.file', 'finance')), ['count']);
  const board = await readFile(new URL('../js/views/board.js', import.meta.url), 'utf8');
  assert.match(board, /depositQueue\(ctx\.state/);
  assert.match(board, /say\('flows\.queue\.count', ctx\.words, \{ in: nIn, out: n \}\)/);
});

/* ------------------------------------------------------------------ words */

test('words: every money-in phrase in both modes with the same placeholders, and the glossary rows the page uses', () => {
  const keys = Object.keys(PHRASES).filter((key) => key.startsWith('inlets.') || key.startsWith('inlet.') || key === 'flows.queue.moneyIn');
  assert.ok(keys.length > 100);
  for (const key of keys) {
    assert.ok(PHRASES[key].chess && PHRASES[key].finance, key);
    assert.deepEqual(placeholders(PHRASES[key].chess), placeholders(PHRASES[key].finance), key);
  }
  for (const mode of ['chess', 'finance']) {
    assert.equal(term('reinforcements', mode), phrase('inlets.h', mode));
    assert.equal(term('development', mode), phrase('inlets.dev', mode));
    assert.equal(term('passed-pawn', mode), phrase('inlets.focus', mode));
    assert.equal(term('windfalls', mode), phrase('inlets.windfalls', mode));
    for (const kind of ['steady', 'job', 'backend', 'oneoff']) assert.equal(term('kind-' + kind, mode), phrase('inlets.kind.' + kind, mode));
    assert.equal(term('objective', mode), phrase('inlet.goal', mode));
    assert.equal(term('not-yet-filed', mode), phrase('inlets.unfiled', mode));
  }
  const names = (mode) => ['reinforcements', 'development', 'passed-pawn', 'windfalls', 'kind-steady', 'kind-job', 'kind-backend', 'kind-oneoff', 'objective'].map((key) => term(key, mode));
  assert.deepEqual(names('chess'), ['Reinforcements', 'Development', 'Passed pawn', 'Windfalls', 'Fortress', 'Tactics', 'Endgame', 'Prize', 'Objective']);
  assert.deepEqual(names('finance'), ['Money in', 'Prospects', 'Focus', 'Not earned', 'Steady pay', 'By the job', 'Back-end', 'One-off', 'Goal']);
  assert.equal(TERMS.filter((one) => one.group === 'income').length, 10);
});

test('no new file of this pass holds the banned words', async () => {
  const banned = new RegExp(['les' + 'son', 'plan' + 'ner', 'stu' + 'dent'].join('|'), 'i');
  const files = ['js/model/inlets.js', 'js/views/inflows.js', 'js/views/sheet-inlet.js', 'tests/inlets.test.js', 'tests/inlets-views.test.js', 'tests/helpers/inlets-fixture.mjs',
    'tests/helpers/sheet-inlet-focus.mjs'];
  for (const file of files) {
    const text = await readFile(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, banned, file);
  }
  // and no music-industry name or real payout company in the sample's money in
  const demo = await readFile(new URL('../js/model/demo.js', import.meta.url), 'utf8');
  const sample = demo.slice(demo.indexOf('const LIBRARY'), demo.indexOf('const RENTALS'));
  assert.doesNotMatch(sample + demo.slice(demo.indexOf('function addReported'), demo.indexOf('function addSources')), /distrokid|tunecore|ascap|\bbmi\b|soundexchange|cd ?baby|bandcamp|royalt|record label|music/i);
});

/* ------------------------------------------------------------------ fixes, round 1 */

test('a source\'s name wraps in every list (it never runs into its money), and the table opens on all 12 months', async () => {
  const css = await readFile(new URL('../css/views/flows.css', import.meta.url), 'utf8');
  const rule = (sel) => {
    const at = css.indexOf('\n' + sel + ' {');
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };
  assert.match(rule('.fl-in-open'), /white-space:\s*normal/, 'a text button keeps to one line elsewhere (.btn-link)');
  assert.match(rule('.fl-fig-table .table-scroll'), /--table-max:\s*none/);
  // every button that opens a source's sheet carries the class: Reinforcements, Development and the archive
  const page = render('chess', 'moneyin');
  const opens = [...page.matchAll(/<button class="([^"]*)" type="button" data-action="app.sheet" data-sheet="inlet" data-id=/g)].map((m) => m[1]);
  assert.ok(opens.length >= 5);
  assert.ok(opens.every((cls) => cls.split(' ').includes('fl-in-open')), opens.join(' | '));
});

test('Fig. 1: a long name is cut to its room with "…", the full name in a <title>, in both layouts', () => {
  const long = 'Wedding and portrait photography studios';
  const data = fig();
  data.rows[1] = { ...data.rows[1], name: long };
  // the chart's widths at screens of 1440 and 768 px, 552 px, and 320 px (16 px side gutters)
  for (const W of [1100, 800, 520, 288]) {
    const svg = chartSvg('inlets', data, W, 0);
    const m = svg.match(/<text class="nwc-t" x="0" y="[0-9.]+"><title>([^<]*)<\/title>([^<]*)<\/text>/);
    assert.ok(m, W + ': the name has a title');
    assert.equal(m[1], long);
    assert.ok(m[2].endsWith('…') && m[2].length < long.length, W + ': cut, ' + m[2]);
  }
  // under 480px the name keeps clear of the total on its line; at 390px (a 358px chart) it fits whole, unless the root
  // font is larger (the labels are sized in rem): at 20px it is cut too
  assert.ok(!chartSvg('inlets', data, 358, 0).includes('<title>'));
  globalThis.getComputedStyle = () => ({ fontSize: '20px' });
  try {
    const big = chartSvg('inlets', data, 358, 0).match(/<\/title>([^<]*)<\/text>/);
    assert.ok(big && big[1].endsWith('…'), 'cut with a 20px root');
  } finally {
    delete globalThis.getComputedStyle;
  }
  // a name that fits is drawn whole, with no title
  const svg = chartSvg('inlets', fig(), 800, 0);
  assert.ok(!svg.includes('<title>'));
  assert.match(svg, />PRINT SALES<\/text>/);
});

test('a suggested source names its period (12 months), as the source rows do, and its cash', () => {
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin');
    const at = page.indexOf('class="fl-in-offers"');
    const offers = page.slice(at, page.indexOf('</ul>', at));
    assert.match(offers, /data-fig>\$[\d,]+<\/span> in 12 months/, words + ': the period named');
    assert.match(offers, new RegExp('data-fig>\\$[\\d,]+</span> ' + phrase('inlets.cash', words).replace('{amount} ', '')), words + ': cash named');
    assert.doesNotMatch(offers, /<span class="row-value fig">/, words + ': no bare figure under the 30-day head');
  }
});

test('a deposit\'s sheet offers Not yet filed only where it takes effect', () => {
  for (const words of ['chess', 'finance']) {
    const rule = render(words, 'moneyin', 'tx=rule');
    assert.ok(!rule.includes('data-to="none"'), words + ': a built-in rule\'s Windfalls cannot be unfiled');
    assert.ok(rule.includes('class="cap tx-in-keep"'), words + ': the note says how to move it');
    const payer = render(words, 'moneyin', 'tx=payer');
    assert.ok(payer.includes('data-to="none"') && payer.includes('data-scope="all"'), words + ': its payer\'s filing can be removed');
    assert.ok(!payer.includes('tx-in-keep'));
  }
});

/* ------------------------------------------------------------------ fixes, round 2 */

test('the sample\'s Not yet filed names its cash, in both word modes', () => {
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin');
    const at = page.indexOf('class="fl-in-row fl-in-unfiled"');
    const row = page.slice(at, page.indexOf('</li>', at));
    // round 6: the way to file that cash follows it (Add Print orders below), beside "file ↑"
    assert.match(row, new RegExp('<p class="cap fl-in-why"><span class="nowrap" data-fig>\\$[\\d,]+</span> ' + phrase('inlets.cash', words).replace('{amount} ', '') + '( · [^<]+)?</p>'), words + ': cash named under Not yet filed');
    const section = page.slice(page.indexOf('class="band fl-in"'), page.indexOf('class="band fl-dev"'));
    assert.ok(section.includes(phrase('inlets.cap.cash', words)), words + ': the caption on cash');
  }
});

test('a payment another app reported opens its sheet on All from this app', () => {
  for (const words of ['chess', 'finance']) {
    const sheet = render(words, 'moneyin', 'tx=payment');
    assert.match(sheet, /<input type="radio" name="in-scope" value="all" checked>/, words + ': All from this app first');
    assert.ok(sheet.includes(phrase('inlets.tx.scope.app', words)), words);
    assert.ok(sheet.includes('data-scope="all"'), words + ': the chips file the app');
  }
});

test('a deposit\'s sheet on a phone: the two scopes stack and a source\'s chip wraps its name', async () => {
  const css = await readFile(new URL('../css/views/flows.css', import.meta.url), 'utf8');
  assert.match(css, /\.tx-in-chips \.chip \{ white-space: normal;[^}]*max-width: 100%; \}/);
  const phone = css.slice(css.indexOf('.tx-in-chips .chip'));
  assert.match(phone, /@media \(max-width: 599px\) \{\s*\.tx-in \.seg:has\(input\[name="in-scope"\]\) \{ display: grid; grid-auto-flow: row; \}/);
  assert.match(phone, /\.tx-in \.seg:has\(input\[name="in-scope"\]\) \.seg-opt \+ \.seg-opt \{ border-left: 0; border-top: 1px solid var\(--ink\); \}/);
});

test('words of round 2: the queue names payment-app deposits, Remove says where the deposits leave, unfiling is worded as such', () => {
  for (const mode of ['chess', 'finance']) {
    for (const key of ['flows.queue.leadIn', 'flows.queue.leadInOne']) assert.match(phrase(key, mode), /a check deposit, a payment-app deposit, a cash-out or a payout/, mode + ' ' + key);
    assert.doesNotMatch(phrase('inlet.remove.confirm', mode), /will read as Not yet filed/, mode);
    assert.equal((phrase('inlets.dev.empty', mode).match(/\bhere\b/g) || []).length, 1, mode + ': "here" once');
    assert.doesNotMatch(phrase('inlets.toast.unfiledOne', mode), /to \{name\}/, mode);
    assert.notEqual(phrase('inlets.undo.unfiled', mode), phrase('inlets.undo.filed', mode), mode);
    assert.match(phrase('settings.shared.what', mode), /the date of a deposit you (file|assign) or leave on its own,/, mode);
  }
});

/* ------------------------------------------------------------------ fixes, round 3 */

test('a deposit another app\'s payment pairs with, filed by its payer: the note says where to unfile it, never under a scope the sheet lacks', () => {
  for (const words of ['chess', 'finance']) {
    const sheet = render(words, 'moneyin', 'tx=paired');
    // the sample's rows carry no key of their own, so its chips file the app (keysOf: the app ranks above the payer)
    assert.ok(sheet.includes('data-scope="all"') && !sheet.includes(phrase('inlets.tx.scope.payer', words)), words + ': the chips file the app, not the payer');
    assert.ok(sheet.includes('class="cap tx-in-keep">' + phrase('inlets.tx.keep.payerApp', words)), words + ': the note names a deposit the app did not report');
    assert.ok(!sheet.includes(phrase('inlets.tx.keep.payer', words)), words + ': never "under All from this payer"');
  }
});

test('words of round 3: Remove\'s toast as its confirm, the app named when a sheet files it, Leave it in Settings, a source whose payers differ', async () => {
  for (const mode of ['chess', 'finance']) {
    assert.doesNotMatch(phrase('inlet.toast.removed', mode), /Not yet filed/, mode + ': Remove\'s toast promises no reading');
    assert.match(phrase('inlet.toast.removed', mode), /no longer count, on every device\.$/, mode);
    for (const key of ['inlets.toast.filedApp', 'inlets.toast.unfiledApp']) {
      assert.ok(phrase(key, mode).includes('{app}') && phrase(key, mode).includes('{name}'), mode + ' ' + key + ': names the app');
      assert.ok(!phrase(key, mode).includes('{merchant}'), mode + ' ' + key + ': never the payer');
    }
    assert.match(phrase('settings.shared.what', mode), /the date of a deposit you (file|assign) or leave on its own,/, mode);
    assert.ok(phrase('inlets.paydays.mixed', mode).includes('{before} in the {days} before'), mode);
  }
  const css = await readFile(new URL('../css/views/flows.css', import.meta.url), 'utf8');
  assert.match(css, /\.tx-in-keep \{ margin-top: var\(--s-2\); \}/, 'the note keeps clear of the chips');
});

/* ------------------------------------------------------------------ fixes, round 4 */

const unfiledRow = (page) => { const at = page.indexOf('class="fl-in-row fl-in-unfiled"'); return page.slice(at, page.indexOf('</li>', at)); };
const leadOf = (page) => (page.match(/<p class="cap fl-q-lead">[\s\S]*?<\/p>/) || [''])[0];

test('round 4: "file ↑" shows only while the queue holds a deposit; Not yet filed with none queued says where it is filed', () => {
  for (const words of ['chess', 'finance']) {
    assert.ok(unfiledRow(render(words, 'moneyin')).includes('data-action="flows.queue" data-open="1"'), words + ': a deposit waits');
    const none = unfiledRow(render(words, 'moneyin', 'allfiled'));
    assert.ok(none.includes(phrase('inlets.unfiled', words)) && !none.includes('data-action="flows.queue"'), words + ': nothing waits, at $0');
    assert.ok(!none.includes(phrase('inlets.unfiled.sheets', words)), words + ': nothing to say at $0');
    const cash = unfiledRow(render(words, 'moneyin', 'allfiled', 'year'));
    assert.ok(!cash.includes('data-action="flows.queue"'), words + ': cash your other app reported is never queued');
    assert.ok(cash.includes(phrase('inlets.unfiled.sheets', words)), words + ': where it is filed instead');
    assert.ok(cash.includes(phrase('inlets.cash', words).replace('{amount} ', '')), words + ': its cash named');
  }
});

test('round 4: "New source…" opens on Steady pay under the payroll; the lead counts your other app\'s item and says what one tap on it files', () => {
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin', 'newform');
    const form = (page.match(/<form class="fl-new"[\s\S]*?<\/form>/) || [''])[0];
    assert.match(form, /<input type="radio" name="kind" value="steady" checked>/, words + ': the payroll\'s form opens on Steady pay');
    assert.equal((form.match(/ checked>/g) || []).length, 1, words + ': one kind chosen');
    const app = leadOf(render(words, 'moneyin', 'appitem'));
    assert.ok(app.includes(phrase('inlets.q.itemsApp.one', words)), words + ': your other app among the items');
    assert.ok(app.includes(phrase('flows.queue.leadInApp', words)), words + ': what one tap on it files');
    const plain = leadOf(render(words, 'moneyin'));
    assert.ok(plain.includes(phrase('inlets.q.items.one', words)) && !plain.includes(phrase('flows.queue.leadInApp', words)), words + ': no app item, no app words');
  }
});

test('round 4: the words in both modes, no straight apostrophe in any phrase, the goal\'s own message, the pay a decision ends in its toast', async () => {
  for (const key of ['inlets.toast.payEnds', 'inlets.toast.payEndsMany', 'inlet.toast.badGoal', 'inlets.q.itemsApp.one', 'inlets.q.itemsApp.many', 'flows.queue.leadInApp', 'inlets.unfiled.sheets']) {
    for (const mode of ['chess', 'finance']) assert.ok(phrase(key, mode), key + ' in ' + mode + ' words');
  }
  for (const [key, one] of Object.entries(PHRASES)) {
    for (const mode of ['chess', 'finance']) assert.ok(!String(one[mode] || '').includes("'"), key + ' (' + mode + '): ’, never a straight apostrophe');
  }
  for (const mode of ['chess', 'finance']) assert.notEqual(phrase('inlet.toast.badGoal', mode), phrase('inlet.toast.bad', mode), mode);
  const sheet = await readFile(new URL('../js/views/sheet-inlet.js', import.meta.url), 'utf8');
  assert.match(sheet, /if \(!name \|\| !kind\) \{ toast\(say\('inlet\.toast\.bad', ctx\.words\)\); return; \}/, 'the name and the kind');
  assert.match(sheet, /if \(Number\.isNaN\(cents\)\) \{ toast\(say\('inlet\.toast\.badGoal', ctx\.words\)\); return; \}/, 'the goal, on its own');
  assert.match(sheet, /\+ payNote\(ctx[,)]/, 'a source\'s kind that ends pay says so');
  const inflows = await readFile(new URL('../js/views/inflows.js', import.meta.url), 'utf8');
  for (const action of ["'inlets.file'", "'inlets.new-save'", "'inlets.offer'", "'inlets.file-tx'"]) {
    const body = inflows.slice(inflows.indexOf('  ' + action + ':'), inflows.indexOf('\n  },', inflows.indexOf('  ' + action + ':')));
    assert.match(body, /payNote\(ctx[,)]/, action + ': the toast names the pay a filing ends');
  }
});

test('round 12: a tap on a payer or your other app left on an earlier day says in its Undo label that every deposit from them is asked about again, in both modes', async () => {
  for (const mode of ['chess', 'finance']) {
    for (const key of ['inlets.undo.leftAgain', 'inlets.undo.filedAgain', 'inlets.undo.unfiledAgain', 'inlets.undo.addAgain']) {
      assert.match(phrase(key, mode), /; every deposit from them is asked about again$/, key + ' (' + mode + ')');
    }
    assert.notEqual(phrase('inlets.undo.filedAgain', mode), phrase('inlets.undo.unfiledAgain', mode), mode);
  }
  assert.equal(phrase('inlets.undo.filedAgain', 'finance'), 'Deposits assigned; every deposit from them is asked about again');
  const inflows = await readFile(new URL('../js/views/inflows.js', import.meta.url), 'utf8');
  const body = (action) => inflows.slice(inflows.indexOf('  ' + action + ':'), inflows.indexOf('\n  },', inflows.indexOf('  ' + action + ':')));
  assert.match(body("'inlets.file'"), /item\.leftBefore \? 'inlets\.undo\.filedAgain' : 'inlets\.undo\.filed'/, 'the queue\'s filing');
  assert.match(body("'inlets.new-save'"), /item\.leftBefore \? 'inlets\.undo\.addAgain' : 'inlets\.undo\.add'/, 'a new source named from the item');
  assert.match(body("'inlets.offer'"), /act === 'add' && leftEarlier\(lookOf\(ctx\.state\), one\.intoKey, /, 'Add on a suggestion of a payer or an app left before');
  assert.match(body("'inlets.offer'"), /again \? 'inlets\.undo\.addAgain' : 'inlets\.undo\.' \+ act/);
  const tx = body("'inlets.file-tx'");
  assert.match(tx, /leftEarlier\(look, keys\.apps\[0\] \|\| keys\.payer, /, 'the deposit\'s sheet reads the key All from this payer or app files');
  assert.match(tx, /again \? 'inlets\.undo\.unfiledAgain' : 'inlets\.undo\.unfiled'/);
  assert.match(tx, /again \? 'inlets\.undo\.filedAgain' : 'inlets\.undo\.filed'/);
  assert.ok(tx.indexOf('leftEarlier(') < tx.indexOf('store.update('), 'read before the tap writes');
});

/* ------------------------------------------------------------------ fixes, round 5 */

/** The pure word functions of the money-in views, called in a process of their own (the views import the store). */
function words5(calls) {
  const helper = fileURLToPath(new URL('./helpers/inlets-words.mjs', import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [helper, JSON.stringify(calls)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  assert.ok(Array.isArray(out), String(out).slice(0, 600));
  return out;
}

test('round 5: the queue\'s toasts say what a tap filed: your other app\'s payments, a new source of the payer\'s name once, the pay it ended as "It"', async () => {
  const { merchantKeyOf } = await import('../js/model/corrections.js');
  const payroll = { id: 'st1', name: 'Brightwell Media Payroll', mkey: 'brightwell media payroll', accrue: true };
  const other = { id: 'st2', name: 'Harbor Light Cafe Payroll', mkey: 'harbor light cafe payroll', accrue: true };
  const payer = merchantKeyOf(payroll.mkey);
  for (const words of ['chess', 'finance']) {
    const [app, appNew, named, same, one, it, itNone, both, plain] = words5([
      ['inflows', 'queueToast', words, { kind: 'app', merchant: 'Print orders' }, 'Photo shoots'],
      ['inflows', 'queueToast', words, { kind: 'app', merchant: 'Print orders' }, 'Print orders', true],
      ['inflows', 'queueToast', words, { kind: 'payer', merchant: payroll.name }, 'Day job', true],
      ['inflows', 'queueToast', words, { kind: 'payer', merchant: payroll.name }, payroll.name, true],
      ['inflows', 'queueToast', words, { kind: 'one', merchant: 'MOBILE CHECK DEPOSIT' }, 'MOBILE CHECK DEPOSIT', true],
      ['inflows', 'payNoteOf', words, [payroll], payer],
      ['inflows', 'payNoteOf', words, [], payer],
      ['inflows', 'payNoteOf', words, [payroll, other], payer],
      ['inflows', 'payNoteOf', words, [payroll], null],
    ]);
    // your other app's item: every payment it reports, and their deposits, as the lead and the deposit's sheet say
    assert.equal(app, say('inlets.toast.filedApp', words, { app: 'Print orders', name: 'Photo shoots' }));
    assert.ok(!app.includes('every deposit on record'), words + ': not "every deposit on record"');
    assert.equal(appNew, say('inlets.toast.filedAppNew', words, { app: 'Print orders' }));
    // a new source named after the payer names it once; another name keeps the plain toast
    assert.equal(named, say('inlets.toast.filed', words, { merchant: payroll.name, name: 'Day job' }));
    assert.equal(same, say('inlets.toast.filedNew', words, { merchant: payroll.name }));
    assert.equal(same.split(payroll.name).length - 1, 1, words + ': the payer named once');
    assert.equal(one, say('inlets.toast.filedOneNew', words, { merchant: 'MOBILE CHECK DEPOSIT' }));
    // the pay ended is the payer the toast just named: "It"; with none, nothing; with another payer too, the names
    assert.equal(it, ' ' + phrase('inlets.toast.payEndsIt', words));
    assert.equal(itNone, '');
    assert.equal(both, ' ' + say('inlets.toast.payEndsMany', words, { names: payroll.name + ' and ' + other.name }));
    assert.equal(plain, ' ' + say('inlets.toast.payEnds', words, { names: payroll.name }));
    // the toast after "New source…" on the payroll, with Tactics: two short sentences, the payer named once
    assert.equal((same + it).split(payroll.name).length - 1, 1);
  }
  const inflows = await readFile(new URL('../js/views/inflows.js', import.meta.url), 'utf8');
  for (const action of ["'inlets.file'", "'inlets.new-save'"]) {
    const body = inflows.slice(inflows.indexOf('  ' + action + ':'), inflows.indexOf('\n  },', inflows.indexOf('  ' + action + ':')));
    assert.match(body, /queueToast\(ctx\.words, /, action + ': the toast is the queue\'s own');
    assert.match(body, /payNote\(ctx, before, item\.kind === 'payer' \? item\.intoKey : null\)/, action + ': the pay of the payer just named is "It"');
    assert.ok(body.indexOf('payBefore(ctx)') > 0 && body.indexOf('payBefore(ctx)') < body.indexOf('store.update('), action + ': the pay before is read before the update');
  }
});

test('round 5: the Remove confirm counts deposits apart from the payments your other app reported', () => {
  for (const words of ['chess', 'finance']) {
    const [only, both, pay, one, none] = words5([
      ['sheet-inlet', 'removeReach', words, { deposits: 13, payments: 0 }],
      ['sheet-inlet', 'removeReach', words, { deposits: 75, payments: 6 }],
      ['sheet-inlet', 'removeReach', words, { deposits: 0, payments: 2 }],
      ['sheet-inlet', 'removeReach', words, { deposits: 1, payments: 1 }],
      ['sheet-inlet', 'removeReach', words, { deposits: 0, payments: 0 }],
    ]);
    assert.equal(only, say('inlet.remove.reach', words, { n: 13 }), words + ': deposits only, as before');
    assert.equal(both, say('inlet.remove.reachAll', words, { what: say('inlet.remove.deposits', words, { n: 75 }) + ' ' + phrase('inlet.remove.and', words) + ' ' + say('inlet.remove.payments', words, { n: 6 }) }));
    assert.match(both, /^75 deposits and 6 payments your other app reported in the 12 months$/);
    assert.equal(pay, '2 payments your other app reported in the 12 months');
    assert.equal(one, '1 deposit and 1 payment your other app reported in the 12 months');
    assert.equal(none, '');
  }
});

test('round 5: with nothing queued, the note under Not yet filed names the way to file what it holds', () => {
  const offer = { key: 'r0123456789abc', intoKey: 'r0123456789abc', name: 'Print orders' };
  for (const words of ['chess', 'finance']) {
    const [app, pending, sheets, mixed] = words5([
      ['inflows', 'unfiledNote', words, { cents: 9000, pending: 0, apps: { [offer.intoKey]: 9000 } }, [offer]],
      ['inflows', 'unfiledNote', words, { cents: 13731, pending: 13731, apps: {} }, [offer]],
      ['inflows', 'unfiledNote', words, { cents: 9000, pending: 0, apps: { [offer.intoKey]: 9000 } }, []],
      ['inflows', 'unfiledNote', words, { cents: 30000, pending: 10000, apps: { [offer.intoKey]: 9000 } }, [offer]],
    ]);
    // a suggested app's payments: its suggestion's Add, right below
    assert.equal(app, say('inlets.unfiled.lead', words, { what: say('inlets.unfiled.offerPart', words, { app: 'Print orders' }) }));
    // a deposit that has not posted joins the queue once it posts (its sheet cannot file it)
    assert.equal(pending, say('inlets.unfiled.lead', words, { what: phrase('inlets.unfiled.pendingPart', words) }));
    // otherwise the sheets, in round 4's words
    assert.equal(sheets, phrase('inlets.unfiled.sheets', words));
    assert.equal(say('inlets.unfiled.lead', words, { what: phrase('inlets.unfiled.sheetsPart', words) }), phrase('inlets.unfiled.sheets', words), words + ': the same words');
    assert.ok(mixed.includes(say('inlets.unfiled.offerPart', words, { app: 'Print orders' })) && mixed.includes(phrase('inlets.unfiled.pendingPart', words))
      && mixed.includes(phrase('inlets.unfiled.sheetsPart', words)), words + ': each way, when it holds each');
    // the sample at 30 days, the queue filed: the cash of Print orders, suggested below
    const row = unfiledRow(render(words, 'moneyin', 'queuefiled'));
    assert.ok(!row.includes('data-action="flows.queue"'), words + ': nothing queued');
    assert.ok(row.includes(say('inlets.unfiled.offerPart', words, { app: 'Print orders' })), words + ': Add Print orders below');
    assert.ok(!row.includes(phrase('inlets.unfiled.sheetsPart', words)), words + ': not its sheet');
  }
});

test('round 5: Fig. 1 leaves out the quarter label that would touch the month so far, with a 20px root', () => {
  const MONTHS6 = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const cells6 = (fn) => MONTHS6.map((ym, k) => ({ ym, bank: 0, pencil: 0, ...fn(k) }));
  const data = { months: MONTHS6, first: '2025-07', today: '2026-06-18', paid: phrase('inlets.fig.paid', 'chess'), rows: [
    { name: 'Day job', total: 4719900, paid: 12, onRecord: 12, cells: cells6(() => ({ bank: 393325 })) },
    { name: 'Stock photos', total: 161000, est: true, paid: 4, onRecord: 12, cells: cells6((k) => (k % 3 === 0 ? { bank: 40000 } : {})) },
    { name: '', unfiled: true, total: 9000, paid: 1, onRecord: 12, cells: cells6((k) => (k === 11 ? { bank: 9000 } : {})) },
  ] };
  const wCaps = (s) => { let w = 0; for (const ch of String(s)) w += ch === 'W' || ch === 'M' ? 9.6 : ch === 'I' || ch === '1' || ch === ' ' || ch === '·' ? 4 : 6.6; return w; };
  const axis = (W) => [...chartSvg('inlets', data, W, 0).matchAll(/<text class="(nwc-t(?: nwc-spot)?)" x="([-0-9.]+)" y="11" text-anchor="middle">([^<]*)<\/text>/g)]
    .map((m) => ({ spot: m[1].includes('spot'), x: Number(m[2]), s: m[3] }));
  const gap = (labels, scale) => {
    const spot = labels.find((one) => one.spot);
    const prev = labels.filter((one) => !one.spot).pop();
    return (spot.x - wCaps(spot.s) * scale / 2) - (prev.x + wCaps(prev.s) * scale / 2);
  };
  // a 16px root: every quarter label, as before
  for (const W of [480, 502, 800]) assert.deepEqual(axis(W).map((one) => one.s), ['SEP', 'DEC', 'MAR', 'JUN 18'], W + ' at 16px');
  globalThis.getComputedStyle = () => ({ fontSize: '20px' });
  try {
    // the widths where the verifiers measured MAR 1 to 6 px from JUN 18 (charts of 480 to 502 px): MAR is left out
    for (const W of [480, 488, 502]) {
      const labels = axis(W);
      assert.deepEqual(labels.map((one) => one.s), ['SEP', 'DEC', 'JUN 18'], W + ' at 20px');
      assert.ok(gap(labels, 1.25) > 20, W + ': DEC stays clear');
    }
    // wider, it is drawn, more than half an em clear
    for (const W of [513, 519, 568, 800]) {
      const labels = axis(W);
      assert.deepEqual(labels.map((one) => one.s), ['SEP', 'DEC', 'MAR', 'JUN 18'], W + ' at 20px');
      assert.ok(gap(labels, 1.25) >= 6.5 * 1.25, W + ': ' + gap(labels, 1.25));
    }
  } finally {
    delete globalThis.getComputedStyle;
  }
});

/* ------------------------------------------------------------------ fixes, round 6 */

test('round 6: beside "file ↑", Not yet filed still names what the queue never asks about: a suggested app\'s payments, a pending deposit', () => {
  const offer = { key: 'r0123456789abc', intoKey: 'r0123456789abc', name: 'Print orders' };
  for (const words of ['chess', 'finance']) {
    const [app, pending, both, sheets] = words5([
      ['inflows', 'unfiledNote', words, { cents: 9000, pending: 0, apps: { [offer.intoKey]: 9000 } }, [offer], 1],
      ['inflows', 'unfiledNote', words, { cents: 23731, pending: 13731, apps: {} }, [offer], 2],
      ['inflows', 'unfiledNote', words, { cents: 30000, pending: 10000, apps: { [offer.intoKey]: 9000 } }, [offer], 1],
      ['inflows', 'unfiledNote', words, { cents: 9000, pending: 0, apps: {} }, [offer], 1],
    ]);
    // the queue holds deposits: no "nothing here is in the queue", only the ways the queue never offers
    assert.equal(app, say('inlets.unfiled.offerPart', words, { app: 'Print orders' }), words + ': Add Print orders below');
    assert.equal(pending, phrase('inlets.unfiled.pendingPart', words), words + ': a pending deposit');
    assert.equal(both, say('inlets.unfiled.offerPart', words, { app: 'Print orders' }) + '; ' + phrase('inlets.unfiled.pendingPart', words), words + ': both');
    assert.equal(sheets, '', words + ': the rest is in the queue');
    // the sample at 30 days: "file ↑" and, under it, the cash of Print orders with the way to file it
    const row = unfiledRow(render(words, 'moneyin'));
    assert.ok(row.includes('data-action="flows.queue" data-open="1"'), words + ': a deposit waits');
    assert.ok(row.includes(say('inlets.unfiled.offerPart', words, { app: 'Print orders' })), words + ': Add Print orders below, beside file ↑');
    assert.ok(!row.includes(say('inlets.unfiled.lead', words, { what: '' }).trim()), words + ': never "nothing here is in the queue" while it holds one');
  }
});

test('round 6: the shares of Reinforcements add up to 100%, rounded by largest remainders; a share under half a percent reads "under 1%"', () => {
  for (const words of ['chess', 'finance']) {
    const [three, tiny, none, sample] = words5([
      ['inflows', 'shareTexts', [0.405, 0.305, 0.29, 0], words],
      ['inflows', 'shareTexts', [0.6, 0.396, 0.003, 0.001], words],
      ['inflows', 'shareTexts', [null, null], words],
      ['inflows', 'shareTexts', [0.414, 0.313, 0.273, 0], words],
    ]).map((text) => text.split(','));
    const sum = (list) => list.reduce((n, one) => n + (/^\d+%$/.test(one) ? Number(one.slice(0, -1)) : 0), 0);
    assert.deepEqual(three, ['41%', '30%', '29%', '0%'], words + ': 40.5%, 30.5% and 29% sum to 100%');
    assert.deepEqual(tiny, ['60%', '40%', phrase('flows.pct.under', words), phrase('flows.pct.under', words)], words + ': under half a percent');
    assert.deepEqual(none, ['—', '—'], words + ': nothing earned');
    assert.equal(sum(sample), 100, words + ': ' + sample.join(' · '));
  }
  // the page: a column whose shares, each rounded on its own, would read 42% + 32% + 27% = 101%
  const one = (id, share) => ({ id, name: id, kind: 'job', focus: false, gone: false, cents: Math.round(share * 100000), bank: 0, pencil: 0, cash: 0, est: false, share,
    before: null, change: null, paydays: null, sessions: null, last: null, year: { cents: 0, est: false, paid: 0, months: 12, cash: 0, deposits: 0, payments: 0 } });
  const sec = { window: { days: 30, firstDay: '2025-01-01' }, rows: [one('A', 0.416), one('B', 0.316), one('C', 0.268)],
    unfiled: { cents: 0, est: false, cash: 0, share: 0, before: null, pending: 0, apps: {} }, earned: { cents: 100000, est: false, before: null, change: null },
    windfalls: { cents: 0, est: false, cash: 0, what: [] }, prospects: [], archived: [], frame: { firstOnRecord: '2025-01', onRecord: 12, from: '2025-12-01' } };
  for (const words of ['chess', 'finance']) {
    const [page] = words5([['inflows', 'inSection', { words }, sec, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0]]);
    const shares = [...page.matchAll(/<span class="fl-in-share" data-cover-keep>([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(shares, ['42%', '31%', '27%', '0%'], words + ': by largest remainders');
  }
  // the sample: the source rows and Not yet filed
  for (const words of ['chess', 'finance']) {
    for (const extra of [[], ['year']]) {
      const page = render(words, 'moneyin', ...extra);
      const section = page.slice(page.indexOf('class="band fl-in"'), page.indexOf('class="band fl-dev"'));
      const shares = [...section.matchAll(/<span class="fl-in-share" data-cover-keep>([^<]*)<\/span>/g)].map((m) => m[1]);
      assert.ok(shares.length >= 4, words + ': the rows');
      assert.equal(shares.reduce((n, one) => n + (/^\d+%$/.test(one) ? Number(one.slice(0, -1)) : 0), 0), 100, words + ' ' + extra.join('') + ': ' + shares.join(' · '));
    }
  }
});

/* ------------------------------------------------------------------ paydays, after round 7 */

test('round 7: a Steady pay row counts its paydays in other rows; a row beyond the queue reads "—" filed one at a time, or names what it left out; Windfalls shows its change (new pay is step 3b\'s)', () => {
  const year = { cents: 0, est: false, paid: 0, months: 12, cash: 0, deposits: 0, payments: 0 };
  for (const words of ['chess', 'finance']) {
    const ctx = { words };
    const steady = { kind: 'steady', year, paydays: { now: 1, before: 2, extra: -1, left: -210000, mixed: false, elsewhere: 1 } };
    const fresh = { kind: 'steady', year, paydays: { now: 2, before: 2, extra: 0, left: 0, mixed: false, elsewhere: 2 } };
    const beyond = { kind: 'job', year, change: null, oneAtATime: true, paydays: null };
    const part = { kind: 'job', year, change: 4000, oneAtATime: false, leftOneAtATime: 26, paydays: null };
    const [one, two, why, dash, none, partWhy] = words5([
      ['inflows', 'whyOf', ctx, steady, 30],
      ['inflows', 'whyOf', ctx, fresh, 90],
      ['inflows', 'whyOf', ctx, beyond, 365],
      ['inflows', 'changeOf', ctx, beyond, 365],
      ['inflows', 'changeOf', ctx, { ...beyond, oneAtATime: false }, 365],
      ['inflows', 'whyOf', ctx, part, 365],
    ]);
    assert.match(partWhy, words === 'chess' ? /deposits filed one at a time left out of this change/ : /deposits assigned one at a time left out of this change/, words + ': a row that compares what is left says what it left out');
    assert.match(one, /1 payday in these 30 days, 2 in the 30 before; the change leaves the missing one out · 1 more in another row/, words + ': a payday fewer, and where it is (round 10: one payday, the missing one, no period before " · ")');
    assert.match(two, /2 paydays, as in the 90 before · 2 more in other rows/, words + ': two elsewhere');
    assert.doesNotMatch(two, /new pay/, words + ': no new pay (step 3b)');
    assert.match(why, words === 'chess' ? /filed one at a time: compared over 30 or 90 days/ : /assigned one at a time: compared over 30 or 90 days/, words + ': the caption of "—"');
    assert.match(dash, />—</, words + ': "—" for its change');
    assert.equal(none, '', words + ': no change shown');
  }
  // Windfalls with money only in the window before: its line shows, $0 beside its change, so the changes add up on the page
  const one = { id: 'A', name: 'Studio', kind: 'job', focus: false, gone: false, cents: 100000, bank: 100000, pencil: 0, cash: 0, est: false, share: 1,
    before: 100000, change: 0, paydays: null, sessions: null, last: null, year: { cents: 0, est: false, paid: 0, months: 12, cash: 0, deposits: 0, payments: 0 } };
  const sec = { window: { days: 30, firstDay: '2025-01-01' }, rows: [one], unfiled: { cents: 0, est: false, cash: 0, share: 0, before: 0, pending: 0, apps: {} },
    earned: { cents: 100000, est: false, before: 100000, change: 0 }, windfalls: { cents: 0, est: false, cash: 0, what: [], before: 15000, change: -15000 },
    prospects: [], archived: [], frame: { firstOnRecord: '2025-01', onRecord: 12, from: '2025-12-01' } };
  for (const words of ['chess', 'finance']) {
    const [page, quiet] = words5([['inflows', 'inSection', { words }, sec, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0],
      ['inflows', 'inSection', { words }, { ...sec, windfalls: { ...sec.windfalls, before: 0, change: 0 } }, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0]]);
    const wind = page.slice(page.indexOf('class="fl-in-wind"'), page.indexOf('</p>', page.indexOf('class="fl-in-wind"')));
    assert.ok(page.includes('class="fl-in-wind"'), words + ': Windfalls with money only before shows its line');
    assert.match(wind, /\$0/, words + ': at $0');
    assert.match(wind, /−\$150/, words + ': beside its change');
    assert.ok(!quiet.includes('class="fl-in-wind"'), words + ': nothing now and no change: no line');
  }
  // the sample's Windfalls line shows its change beside its money, in both modes
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin');
    const wind = page.slice(page.indexOf('class="fl-in-wind"'), page.indexOf('</p>', page.indexOf('class="fl-in-wind"')));
    assert.ok(wind.length > 0, words + ': the Windfalls line');
    assert.match(wind, /<span class="fl-chg">[^<]*<span class="nowrap"/, words + ': its change beside its money');
  }
});

test('round 10: a Steady pay row says "1 payday", names a missing payday so, and ends no sentence before " · "; a change under 50 cents reads ±$0, and Windfalls\' line shows for one only when it reads in dollars', () => {
  const year = { cents: 0, est: false, paid: 0, months: 12, cash: 0, deposits: 0, payments: 0 };
  for (const words of ['chess', 'finance']) {
    const ctx = { words };
    const row = (paydays) => ({ kind: 'steady', year, paydays });
    const [same1, same2, more1, fewer2, mixed1, cents] = words5([
      ['inflows', 'whyOf', ctx, row({ now: 1, before: 1, extra: 0, left: 0, mixed: false, elsewhere: 0 }), 30],
      ['inflows', 'whyOf', ctx, row({ now: 2, before: 2, extra: 0, left: 0, mixed: false, elsewhere: 1 }), 30],
      ['inflows', 'whyOf', ctx, row({ now: 1, before: 0, extra: 1, left: 210000, mixed: false, elsewhere: 0 }), 30],
      ['inflows', 'whyOf', ctx, row({ now: 4, before: 6, extra: -2, left: -420000, mixed: false, elsewhere: 0 }), 90],
      ['inflows', 'whyOf', ctx, row({ now: 1, before: 2, extra: 0, left: 0, mixed: true, elsewhere: 0 }), 30],
      ['inflows', 'changeOf', ctx, { kind: 'job', year, change: 12, paydays: null }, 30],
    ]);
    assert.match(same1, />1 payday, as in the 30 before</, words + ': one payday as before');
    assert.match(same2, />2 paydays, as in the 30 before · 1 more in another row</, words + ': two');
    assert.match(more1, />1 payday in these 30 days, 0 in the 30 before; the change leaves the extra one out</, words + ': one more');
    assert.match(fewer2, />4 paydays in these 90 days, 6 in the 90 before; the change leaves the missing 2 out</, words + ': two missing');
    assert.match(mixed1, />1 payday, 2 in the 30 before; the change sets each payer/, words + ': mixed, one payday');
    for (const text of [same1, same2, more1, fewer2, mixed1]) assert.ok(!/1 paydays|\. · |\.<\/p>/.test(text), words + ': ' + text);
    assert.match(cents, />±\$0</, words + ': 12 cents reads ±$0');
  }
  // Windfalls: a change of 12 cents beside its interest reads ±$0; with no money and a change of 30 cents, no line
  const one = { id: 'A', name: 'Studio', kind: 'job', focus: false, gone: false, cents: 100000, bank: 100000, pencil: 0, cash: 0, est: false, share: 1,
    before: 100000, change: 0, paydays: null, sessions: null, last: null, year };
  const sec = { window: { days: 30, firstDay: '2025-01-01' }, rows: [one], unfiled: { cents: 0, est: false, cash: 0, share: 0, before: 0, pending: 0, apps: {} },
    earned: { cents: 100000, est: false, before: 100000, change: -12 }, windfalls: { cents: 9, est: false, cash: 0, what: ['interest'], before: -3, change: 12 },
    prospects: [], archived: [], frame: { firstOnRecord: '2025-01', onRecord: 12, from: '2025-12-01' } };
  for (const words of ['chess', 'finance']) {
    const [page, quiet] = words5([['inflows', 'inSection', { words }, sec, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0],
      ['inflows', 'inSection', { words }, { ...sec, windfalls: { ...sec.windfalls, cents: 0, before: 30, change: -30 } }, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0]]);
    const wind = page.slice(page.indexOf('class="fl-in-wind"'), page.indexOf('</p>', page.indexOf('class="fl-in-wind"')));
    assert.match(wind, /<span class="fl-chg"><span class="nowrap" data-fig>±\$0<\/span><\/span>/, words + ': 12 cents: ±$0');
    const total = page.slice(page.indexOf('class="fl-in-total"'), page.indexOf('</p>', page.indexOf('class="fl-in-total"')));
    assert.match(total, /±\$0/, words + ': All earned\'s 12 cents: ±$0');
    assert.ok(!quiet.includes('class="fl-in-wind"'), words + ': no money, a change of 30 cents: no line');
  }
});

/* ------------------------------------------------------------------ round 9: the triage's fixes */

test('round 9 (F3): every share of half a percent or more reads at least 1%, the excess from the parts above 1% with the smallest remainders; the sample at 365 days', () => {
  for (const words of ['chess', 'finance']) {
    const [sliver, three, round6, thirds, tiny] = words5([
      ['inflows', 'shareTexts', [0.337, 0.337, 0.319, 0.007], words],
      ['inflows', 'shareTexts', [0.006, 0.006, 0.006, 0.982], words],
      ['inflows', 'shareTexts', [0.405, 0.305, 0.29, 0], words],
      ['inflows', 'shareTexts', [1 / 3, 1 / 3, 1 / 3], words],
      ['inflows', 'shareTexts', [0.6, 0.396, 0.003, 0.001], words],
    ]).map((text) => text.split(','));
    assert.deepEqual(sliver, ['34%', '33%', '32%', '1%'], words + ': 0.7% reads 1%, the point back from the smallest remainder above 1%');
    assert.deepEqual(three, ['1%', '1%', '1%', '97%'], words + ': three of 0.6% read 1%, the excess from the one part above 1%');
    assert.deepEqual(round6, ['41%', '30%', '29%', '0%'], words + ': round 6\'s case unchanged (a share of 0 is no part)');
    assert.deepEqual(thirds, ['34%', '33%', '33%'], words + ': the thirds unchanged');
    assert.deepEqual(tiny, ['60%', '40%', phrase('flows.pct.under', words), phrase('flows.pct.under', words)], words + ': under half a percent still reads so');
  }
  // the sample at 365 days (round 7's screens: Not yet filed's $320 of about $58,000 read 0%): no row with money reads 0%
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin', 'year');
    const section = page.slice(page.indexOf('class="band fl-in"'), page.indexOf('class="band fl-dev"'));
    const rows = [...section.matchAll(/<span class="fig fl-in-amt[^"]*">([\s\S]*?)<\/span>\s*<span class="fl-in-share" data-cover-keep>([^<]*)<\/span>/g)].map((m) => [m[1].replace(/<[^>]+>/g, ''), m[2]]);
    assert.ok(rows.length >= 5, words + ': the rows and Not yet filed');
    for (const [money, share] of rows) if (money !== '—') assert.notEqual(share, '0%', words + ': ' + money + ' reads ' + share);
    assert.equal(rows.reduce((n, [, one]) => n + (/^\d+%$/.test(one) ? Number(one.slice(0, -1)) : 0), 0), 100, words + ': ' + rows.map((one) => one.join(' ')).join(' · '));
  }
});

test('round 9 (K20): the Remove confirm opens scrolled into view, the least distance (a phone on its side keeps its bar at the sheet\'s end); Cancel goes back to Remove', () => {
  const helper = fileURLToPath(new URL('./helpers/sheet-inlet-focus.mjs', import.meta.url));
  const out = JSON.parse(execFileSync(process.execPath, [helper], { encoding: 'utf8' }));
  assert.ok(out && typeof out === 'object', String(out).slice(0, 600));
  assert.deepEqual(out.ask, [{ focused: 'cancel' }, { scrolled: 'confirm', opts: { block: 'nearest' } }], 'Remove: Cancel focused, the confirm scrolled into view');
  assert.deepEqual(out.cancel, [{ focused: 'remove' }], 'Cancel: back to Remove, nothing scrolled');
});

test('round 9 (F2): the queue names a sender\'s first deposit that your other app paired with a payment, in both modes', async () => {
  const { fmtDate } = await import('../js/model/dates.js');
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin', 'aside');
    const q = page.slice(page.indexOf('data-side="in"'), page.indexOf('data-side="out"'));
    // round 10: it names the deposit it paired and the rule (the first deposit paired with the app), on an item of many too
    const note = say('inlets.q.paired', words, { deposit: '@@', payer: 'Ivy Marsh', what: 'Print orders', date: fmtDate('2026-05-16', 'short') });
    const re = new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('@@', '[A-Z][a-z]{2} \\d{1,2}'));
    assert.match(q, re, words + ': ' + note);
    assert.match(note, words === 'chess' ? /its deposit of @@ with .*first deposit paired with the app/ : /its deposit of @@ to .*first deposit matched to the app/, words + ': the deposit, and the rule');
    assert.ok(!q.includes(phrase('inlets.q.itemsApp.one', words)), words + ': no app item: the sender is asked about');
    assert.ok(q.includes(say('inlets.q.zelle', words)), words + ': under the sender');
  }
});

/* ------------------------------------------------------------------ round 11 */

test('round 11 (D6): beyond the queue, All earned and Windfalls read "—" with what they leave out, both modes; Windfalls with something left names what it left out; Leave it on a payer names its deposits so far', () => {
  const year = { cents: 0, est: false, paid: 0, months: 12, cash: 0, deposits: 0, payments: 0 };
  const one = { id: 'A', name: 'Studio', kind: 'job', focus: false, gone: false, cents: 100000, bank: 100000, pencil: 0, cash: 0, est: false, share: 1,
    before: 100000, change: 0, paydays: null, sessions: null, last: null, year };
  const sec = { window: { days: 365, firstDay: '2024-01-01' }, rows: [one], unfiled: { cents: 0, est: false, cash: 0, share: 0, before: 0, pending: 0, apps: {} },
    earned: { cents: 100000, est: false, before: 100000, change: null, oneAtATime: true },
    windfalls: { cents: 230000, est: false, cash: 0, what: ['yours'], before: 0, change: null, oneAtATime: true, leftOneAtATime: 0 },
    prospects: [], archived: [], frame: { firstOnRecord: '2024-01', onRecord: 12, from: '2025-12-01' } };
  const part = { ...sec, windfalls: { ...sec.windfalls, change: 4500, oneAtATime: false, leftOneAtATime: 2 } };
  for (const words of ['chess', 'finance']) {
    const [page, left] = words5([['inflows', 'inSection', { words }, sec, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0],
      ['inflows', 'inSection', { words }, part, { shown: [], dismissed: [] }, { rows: [], months: [] }, 0]]);
    const after = (html, cls) => html.slice(html.indexOf('class="' + cls + '"'), html.indexOf('</p>', html.indexOf('</p>', html.indexOf('class="' + cls + '"')) + 4));
    const total = after(page, 'fl-in-total');
    assert.match(total, /<span class="fl-chg"><span class="nowrap" data-fig>—<\/span><\/span>/, words + ': All earned "—"');
    assert.ok(total.includes(say('inlets.earned.oneAtATime', words)), words + ': All earned says why');
    const wind = after(page, 'fl-in-wind');
    assert.match(wind, /<span class="fl-chg"><span class="nowrap" data-fig>—<\/span><\/span>/, words + ': Windfalls "—"');
    assert.ok(wind.includes(say('inlets.oneAtATime', words)), words + ': Windfalls says why');
    const wind2 = after(left, 'fl-in-wind');
    assert.ok(wind2.includes(say('inlets.oneAtATime.part', words)) && /\+\$45/.test(wind2), words + ': Windfalls compares the rest and says what it left out');
    assert.ok(!PHRASES['inlets.earned.oneAtATime'][words].includes("'"), words + ': no straight apostrophe');
    // Leave it on a payer or an app: its deposits so far (round 9: the next one is asked about); one deposit: as before
    const aria = say('inlets.q.leave.aria.sofar', words, { merchant: 'Lark Fenn' });
    assert.match(aria, /Lark Fenn’s deposits so far/, words + ': the label for screen readers');
    assert.ok(!/every device/.test(say('inlets.toast.leftSoFar', words, { merchant: 'Lark Fenn' })) && /a later one is asked about/.test(say('inlets.toast.leftSoFar', words, { merchant: 'Lark Fenn' })), words + ': the toast');
  }
  for (const words of ['chess', 'finance']) {
    const page = render(words, 'moneyin');
    const q = page.slice(page.indexOf('data-side="in"'), page.indexOf('data-side="out"'));
    if (!q.includes('data-to="?"')) continue;
    assert.ok(!/aria-label="Leave [^"]* unfiled: stop asking"/.test(q.replace(/data-key="one:[^"]*"[^>]*data-to="\?"[^>]*>/g, '')) || q.includes('deposits so far'), words + ': a payer\'s Leave it names its deposits so far');
  }
});
