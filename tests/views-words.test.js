/**
 * The words in a few views that the model tests do not reach: FIG. 2's result row, the income ladder's numbers and
 * Settings (the switch and the sharing sentences), in both modes (ARCHITECTURE.md section 11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { phrase, say } from '../js/model/words.js';
import { keepWhole, keptLine, rungNumber } from '../js/views/parts.js';
import { html } from '../js/ui/dom.js';

/** The chart reads the words from the root element, as app.js sets them (data-words); a stand-in root here. */
let rootWords = null;
globalThis.document = { documentElement: { getAttribute: (name) => (name === 'data-words' ? rootWords : null) } };
const { chartSvg } = await import('../js/ui/charts.js');

const ROUNDS = [
  { n: 1, day: '2026-06-01', kept: 1200, result: 1, status: 'final' },
  { n: 2, day: '2026-06-02', kept: 0, result: 0.5, status: 'final' },
  { n: 3, day: '2026-06-03', kept: -800, result: 0, status: 'final' },
  { n: 4, day: '2026-06-04', kept: 300, result: 1, status: 'provisional' },
  { n: 5, day: '2026-06-05', kept: 100, result: null, status: 'live' },
];

/** The marks of FIG. 2's result row, in order. */
function resultRow(svg) {
  return [...svg.matchAll(/<text[^>]*class="[^"]*nwc-res[^"]*"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

test('FIG. 2 prints the result marks of the words in force: 1 · ½ · 0 in Chess words, ✓ · = · ✗ in Finance words', () => {
  for (const [words, marks] of [[null, ['1', '½', '0', '1', '*']], ['chess', ['1', '½', '0', '1', '*']], ['finance', ['✓', '=', '✗', '✓', '*']]]) {
    rootWords = words;
    const svg = chartSvg('edge', { rounds: ROUNDS }, 720, 240);
    assert.equal(typeof svg, 'string', String(words));
    assert.deepEqual(resultRow(svg), marks, String(words));
  }
  rootWords = 'finance';
  assert.doesNotMatch(chartSvg('edge', { rounds: ROUNDS }, 720, 240), /½/);
  rootWords = null;
});

test('an income-ladder rung keeps its fixed number from the top, whatever the ladder’s length (GM 5 … NM 1)', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(rungNumber), [5, 4, 3, 2, 1]);
  assert.equal(rungNumber(5), null);
  assert.equal(rungNumber(-1), null);
  assert.equal(rungNumber(1.5), null);
});

const HELPER = fileURLToPath(new URL('./helpers/render-settings.mjs', import.meta.url));
const settingsPage = (words, share, forced, ...more) => JSON.parse(execFileSync(process.execPath, [HELPER, words, share, forced ? 'forced' : '-', ...more], { encoding: 'utf8' }));
const checked = (page) => [...page.matchAll(/<input type="radio" name="words" value="(\w+)"[^>]*?(checked)?>/g)].filter((m) => m[2]).map((m) => m[1]);
const forcedLine = (page) => { const m = page.match(/data-key="words-forced">([^<]*)</); return m ? m[1] : null; };

test('Settings: the switch shows the record’s choice, which is the words in force unless the address sets them', () => {
  const chess = settingsPage('chess', 'on', false, 'saved=chess');
  const finance = settingsPage('finance', 'on', false, 'saved=finance');
  assert.deepEqual(checked(chess), ['chess']);
  assert.deepEqual(checked(finance), ['finance']);
  assert.doesNotMatch(chess + finance, /data-key="words-forced"/, 'no line when the record sets the words');
});

test('Settings under an address that sets the words: the switch shows the saved choice, and the line names both', () => {
  // the record says Chess words; the address shows Finance words for this visit
  const forced = settingsPage('finance', 'on', true, 'saved=chess');
  assert.deepEqual(checked(forced), ['chess'], 'the radio shows what it controls: the saved choice');
  assert.equal(forcedLine(forced), 'This visit’s address sets Finance words; later visits use Chess words, chosen below.');
  assert.match(forced, /Exempt days a month/, 'the page itself speaks the forced words');
  const same = settingsPage('chess', 'on', true, 'saved=chess');
  assert.deepEqual(checked(same), ['chess']);
  assert.equal(forcedLine(same), 'This visit’s address sets Chess words; later visits use Chess words, chosen below.');
  assert.doesNotMatch(forced + same, /holds for later visits|follows? the words in force/);
});

test('Settings under an address that sets the words: a click updates the radio and the line at once, the page keeps the forced words', () => {
  const after = settingsPage('finance', 'on', true, 'saved=chess', 'click=finance');
  assert.deepEqual(checked(after), ['finance']);
  assert.equal(forcedLine(after), 'This visit’s address sets Finance words; later visits use Finance words, chosen below.');
  const back = settingsPage('chess', 'on', true, 'saved=finance', 'click=chess');
  assert.deepEqual(checked(back), ['chess']);
  assert.equal(forcedLine(back), 'This visit’s address sets Chess words; later visits use Chess words, chosen below.');
  // the forced words stay: Chess words on the page after choosing Finance for later visits, and the other way round
  const away = settingsPage('chess', 'on', true, 'saved=chess', 'click=finance');
  assert.deepEqual(checked(away), ['finance']);
  assert.equal(forcedLine(away), 'This visit’s address sets Chess words; later visits use Finance words, chosen below.');
  assert.equal(away, settingsPage('chess', 'on', true, 'saved=finance'), 'the same page as a visit whose record already says Finance');
  assert.doesNotMatch(away, /Exempt days a month/, 'the page keeps the address’s Chess words');
  assert.match(after, /Exempt days a month/, 'the page keeps the address’s Finance words');
});

test('Settings in the sample under an address that sets the words: the line promises nothing for later visits', () => {
  // the sample keeps nothing, so a choice made in it holds for no later visit
  for (const click of [null, 'finance', 'chess']) {
    const page = settingsPage('finance', 'sample', true, 'saved=chess', ...(click ? ['click=' + click] : []));
    assert.equal(forcedLine(page), 'This visit’s address sets Finance words; the sample keeps no choice.');
    assert.doesNotMatch(page, /later visits/);
  }
  assert.equal(forcedLine(settingsPage('chess', 'sample', true)), 'This visit’s address sets Chess words; the sample keeps no choice.');
});

test('keepWhole: Chess words keep the content as it is; Finance words keep a run of words on one line', () => {
  for (const words of ['chess', undefined]) {
    assert.equal(keepWhole('Thu, Jun 18', words), 'Thu, Jun 18', 'the very same string: Chess markup is unchanged');
    const markup = html`<b>Round 18</b>`;
    assert.equal(keepWhole(markup, words), markup, 'the very same markup');
  }
  assert.equal(String(html`${keepWhole('Thu, Jun 18', 'finance')}`), '<span class="nowrap">Thu, Jun 18</span>');
  assert.equal(String(html`${keepWhole('A & B', 'finance')}`), '<span class="nowrap">A &amp; B</span>', 'text is escaped as html`` escapes it');
  assert.equal(String(html`${keepWhole(html`<i>Day 18</i>`, 'finance')}`), '<span class="nowrap"><i>Day 18</i></span>');
});

test('the month review’s note on a card that rose: Chess words as they were, Finance words name the budget score', () => {
  assert.equal(say('scoresheet.review.cardHigher', 'chess', { month: 'June' }), 'The card ended June higher than it began, so the score is printed plainly.');
  assert.equal(say('scoresheet.review.cardHigher', 'finance', { month: 'June' }), 'The card ended June higher than it began, so the budget score is printed plainly.');
});

test('Settings: the two sharing sentences read in Finance words, and hold none of the Chess wording', () => {
  const corrections = phrase('settings.shared.corrections', 'finance');
  const what = phrase('settings.shared.what', 'finance');
  assert.notEqual(corrections, phrase('settings.shared.corrections', 'chess'));
  assert.notEqual(what, phrase('settings.shared.what', 'chess'));
  for (const share of ['on', 'off', 'refused', 'sample']) {
    const page = settingsPage('finance', share);
    assert.equal(page.split(corrections).length - 1, 1, share);
    assert.equal(page.split(what).length - 1, 1, share);
    assert.ok(page.indexOf(corrections) < page.indexOf(what), share);
    assert.ok(!page.includes(phrase('settings.shared.corrections', 'chess')) && !page.includes(phrase('settings.shared.what', 'chess')), share);
    assert.doesNotMatch(corrections + ' ' + what, /\bmoves?\b/i);
  }
});

test('the Last result figure: Chess words as they were; in Finance words the amount stays whole and the words keep together', () => {
  for (const [kept, amount] of [[157, '+$1.57'], [2289, '+$22.89'], [10450, '+$104.50'], [123456, '+$1,234.56'], [0, '$0.00']]) {
    assert.equal(String(keptLine({ kept }, 'chess')), amount + ' kept');
    assert.equal(String(keptLine({ kept })), amount + ' kept', 'no words given: Chess words');
    assert.equal(String(keptLine({ kept }, 'finance')), '<span class="kept-amt">' + amount + '</span> <span class="kept-words">under baseline</span>');
  }
  // over the baseline the figure is the amount alone, in both modes
  for (const words of ['chess', 'finance', undefined]) assert.equal(String(keptLine({ kept: -123456 }, words)), '−$1,234.56');
});
