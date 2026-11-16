/**
 * The clock's payday countdown (ARCHITECTURE section 9, Board): the words beside the days on the clock and the
 * mark on the 7-day runway. Every date here is invented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { paydayMark, paydayWords } from '../js/views/clock-words.js';

const TODAY = '2026-11-14'; // a Saturday

test('the countdown in words', () => {
  assert.equal(paydayWords(TODAY, { nextPayday: '2026-11-20', payAwaited: null }), 'Payday in 6 days · Fri, Nov 20');
  assert.equal(paydayWords(TODAY, { nextPayday: '2026-11-15', payAwaited: null }), 'Payday tomorrow · Sun, Nov 15');
  assert.equal(paydayWords(TODAY, { nextPayday: '2026-12-01', payAwaited: null }), 'Payday in 17 days · Tue, Dec 1');
});

test('no countdown without a payday, on the payday itself, or while pay is awaited', () => {
  assert.equal(paydayWords(TODAY, { nextPayday: null, payAwaited: null }), '', 'no payday on record');
  assert.equal(paydayWords(TODAY, { nextPayday: TODAY, payAwaited: null }), '', 'the clock says "Payday is today."');
  assert.equal(paydayWords(TODAY, { nextPayday: TODAY, payAwaited: '2026-11-13' }), '', 'the clock says pay is expected');
  assert.equal(paydayWords(TODAY, { nextPayday: '2026-11-27', payAwaited: '2026-11-13' }), '', 'awaited, with the next one ahead');
  assert.equal(paydayWords(TODAY, { nextPayday: '2026-11-10', payAwaited: null }), '', 'a payday in the past is never counted down');
  assert.equal(paydayWords(TODAY, null), '');
  assert.equal(paydayWords('not a day', { nextPayday: '2026-11-20' }), '');
});

test('the mark on the runway falls on the payday, within its 7 days only', () => {
  assert.equal(paydayMark(TODAY, { nextPayday: '2026-11-15' }, 7), 1 / 7);
  assert.equal(paydayMark(TODAY, { nextPayday: '2026-11-18' }, 7), 4 / 7);
  assert.equal(paydayMark(TODAY, { nextPayday: '2026-11-21' }, 7), 1, 'in 7 days: at the flag');
  assert.equal(paydayMark(TODAY, { nextPayday: '2026-11-22' }, 7), null, 'beyond the runway');
  assert.equal(paydayMark(TODAY, { nextPayday: TODAY }, 7), null);
  assert.equal(paydayMark(TODAY, { nextPayday: '2026-11-18', payAwaited: '2026-11-13' }, 7), null);
  assert.equal(paydayMark(TODAY, { nextPayday: null }, 7), null);
});

test('the Board shows both: the words in the clock and the mark on the runway', () => {
  const board = readFileSync(new URL('../js/views/board.js', import.meta.url), 'utf8');
  assert.match(board, /paydayWords\(ctx\.today, c\)/);
  assert.match(board, /paydayMark\(ctx\.today, c, RUNWAY_SEGMENTS\)/);
  assert.match(board, /class="cap clock-payday"/);
  assert.match(board, /class="runway-payday"/);
  const css = readFileSync(new URL('../css/components.css', import.meta.url), 'utf8');
  assert.match(css, /\.runway \{ position: relative;/, 'the mark is placed within the runway');
  assert.match(css, /\.runway-payday \{[^}]*background-color: var\(--gain\)/, 'in the colour of money arriving');
});
