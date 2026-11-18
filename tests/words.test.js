/**
 * The words of the interface in its two modes (model/words.js): every term with both names and a meaning, every
 * phrase in both modes with the same placeholders, the signs named once, and the model's own text in Finance words
 * free of the other mode's terms. Every figure here comes from the invented sample (model/demo.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WORDS, EVAL_NAMES, GLYPH_NAMES, PHRASES, TERMS, TERM_GROUPS, WORDS, evalName, glyphName, lowerFirst, phrase, placeholders,
  resultName, resultText, resultWords, say, term, termsByGroup, wordsMode, wordsOf,
} from '../js/model/words.js';
import {
  GLYPHS, KLASSES, TX_KINDS, ACCOUNT_TYPES, accountLabel, accountShort, accountTypeLabel, checkDoc, defaultState, klassLabel, klassShort, txKindLabel,
} from '../js/model/schema.js';
import { SYMBOLS, SYMBOL_LABELS, assess, coachNotes, monthReview } from '../js/model/assess.js';
import { annotateRound, previewMove, reviewRounds } from '../js/model/annotate.js';
import { projectNetWorth, purchaseImpact } from '../js/model/forecast.js';
import { buildDemoState } from '../js/model/demo.js';
import { CASH_NAME } from '../js/model/income.js';
import { makeLedger } from '../js/model/ledger.js';
import { addDays, monthOf } from '../js/model/dates.js';
import { evalGlyph, moveGlyph, resultMark, timeTroubleGlyph } from '../js/ui/glyphs.js';
import { makeDerived } from '../js/derive.js';
import { label as glossaryLabel, render as glossary } from '../js/views/sheet-words.js';
import { fmtScore, scoreOf } from '../js/views/parts.js';

/**
 * The words of the default mode that must not be read in Finance words: every term the glossary renames, as the
 * interface writes it. A finance phrase holding one of these has kept a word of the other mode.
 */
const OTHER_MODE = [
  /\bboard\b/i, /scoresheet/i, /\bmaterial\b/i, /\bbook\b/i, /\bvariations?\b/i, /smoothed/i, /pay earned/i, /bills used/i,
  /slow to sell/i, /sold fast/i, /quick-sale/i, /reckoning/i, /worked down/i, /\bretention\b/i, /\bthe position\b/i,
  /\binitiative\b/i, /\bstructure\b/i, /\bnorms?\b/i, /\bclock\b/i, /time trouble/i, /\bflag\b/i, /\breserve\b/i,
  /measured in time/i, /outflow/i, /cash in hand/i, /\bmoves?\b/i, /candidate/i, /play it/i, /\bplayed\b/i, /\bplays\b/i,
  /adjourn/i, /sealed/i, /declined/i, /\brounds?\b/i, /\bmatch\b/i, /exhibition/i, /\bhabit\b/i, /opponent/i, /\bseat/i,
  /win line/i, /loss line/i, /\bwins?\b/i, /\bdraws?\b/i, /\bloss\b/i, /\bkept\b/i, /\bedge\b/i, /\bstanding\b/i, /\bbyes?\b/i,
  /\bblack\b/i, /\bwhite\b/i, /crosstable/i, /opening/i, /preparation/i, /daily game/i, /in play/i, /not yet played/i,
  /pencil/i, /\bink\b/i, /annotat/i, /brilliant/i, /clean sheet/i, /good move/i, /interesting/i, /dubious/i, /mistake/i,
  /blunder/i, /only move/i, /forced move/i, /winning/i, /advantage/i, /slightly worse/i, /clearly worse/i, /losing/i,
  /unclear/i, /best move/i, /costliest move/i, /set aside by time/i, /sample game/i, /coach/i, /principles?\b/i,
  /three moves/i, /perfect/i, /sweep/i, /\bgame\b/i, /½/,
];

/** Finance words call the measure the budget score: "score" on its own (a word, not "scored") outside "Budget score". */
const BARE_SCORE = /\bscore\b/i;

/** The other mode's words a text holds; a template's placeholders are names in code, not text, and are left out. */
function otherModeWords(text) {
  const shown = String(text).replace(/\{\w+\}/g, '');
  const found = OTHER_MODE.filter((pattern) => pattern.test(shown)).map(String);
  if (BARE_SCORE.test(shown.replace(/budget score/gi, ''))) found.push(String(BARE_SCORE));
  return found;
}

/** The fields of the model's results that name things in code (keys, addresses, symbols), not text to read. */
const CODE_FIELDS = new Set(['key', 'href', 'sheet', 'action', 'symbol', 'glyph', 'day', 'ym', 'id', 'status', 'type']);

/* -------------------------------------------------------------------- the modes */

test('two modes: Chess words by default, Finance words only when asked for by name', () => {
  assert.deepEqual([...WORDS], ['chess', 'finance']);
  assert.equal(DEFAULT_WORDS, 'chess');
  assert.equal(wordsMode('finance'), 'finance');
  for (const other of [undefined, null, '', 'Finance', 'plain', 1, {}, 'chess']) assert.equal(wordsMode(other), 'chess');
  assert.equal(wordsOf(defaultState(0)), 'chess');
  assert.equal(wordsOf({ settings: { words: 'finance' } }), 'finance');
  assert.equal(wordsOf({ settings: { words: 'nonsense' } }), 'chess');
  assert.equal(wordsOf(null), 'chess');
  assert.equal(wordsOf({}), 'chess');
});

/* -------------------------------------------------------------------- the glossary */

test('every term has both names and a one-line meaning, in a known group', () => {
  assert.equal(TERMS.length, 98);
  const keys = new Set();
  const groups = new Set(TERM_GROUPS.map((group) => group.key));
  for (const one of TERMS) {
    assert.ok(!keys.has(one.key), 'one entry per key: ' + one.key);
    keys.add(one.key);
    assert.ok(groups.has(one.group), one.key + ' is in a known group');
    for (const field of ['chess', 'finance', 'meaning']) {
      assert.equal(typeof one[field], 'string', one.key + '.' + field);
      assert.ok(one[field].length > 0 && one[field] === one[field].trim(), one.key + '.' + field + ' is written');
    }
    assert.ok(!one.meaning.includes('\n') && one.meaning.length <= 160, one.key + ': one line');
    assert.match(one.meaning, /^[A-Z0-9].*\.$/, one.key + ': a sentence');
    assert.doesNotMatch(one.meaning, /js\/|\.js\b|:\d/, one.key + ': no file or line of code');
  }
});

test('the glossary lists every term once, by group, in order, each group named in both modes', () => {
  const listed = termsByGroup();
  assert.deepEqual(listed.map((one) => one.group.key), TERM_GROUPS.map((group) => group.key));
  assert.equal(listed.reduce((sum, one) => sum + one.terms.length, 0), TERMS.length);
  for (const { group, terms } of listed) {
    assert.ok(terms.length > 0, group.key + ' has terms');
    assert.ok(group.chess && group.finance, group.key + ' is named both ways');
    assert.deepEqual(otherModeWords(group.finance), [], group.key + ' in Finance words');
  }
});

test('a term reads in the mode asked for; an unknown key reads as nothing', () => {
  assert.equal(term('board', 'chess'), 'Board');
  assert.equal(term('board', 'finance'), 'Overview');
  assert.equal(term('board'), 'Board');
  assert.equal(term('reserve', 'finance'), 'Emergency fund');
  assert.equal(term('nothing-of-the-sort', 'finance'), '');
});

test('the lead’s names: pages, factors, the counterfactual, notices, marks and the signs', () => {
  const finance = (key) => term(key, 'finance');
  assert.deepEqual(['board', 'scoresheet', 'material-page', 'book', 'analysis', 'variations'].map(finance),
    ['Overview', 'Transactions', 'Balance sheet', 'Recurring', 'Analysis', 'Scenarios']);
  assert.deepEqual(['position', 'factor-material', 'factor-time', 'factor-structure', 'factor-initiative'].map(finance),
    ['Financial health', 'Net worth trend', 'Liquidity', 'Debt trend', 'Savings rate']);
  assert.equal(finance('cash-in-hand'), 'Physical cash');
  assert.equal(finance('kept'), 'Under baseline');
  assert.equal(finance('retention'), 'Savings rate');
  assert.equal(finance('edge'), 'Running total under baseline');
  assert.equal(finance('coach-notes'), 'Notices');
  assert.equal(finance('annotation'), 'Mark');
  assert.equal(finance('flag'), 'Out of cash');
  assert.equal(finance('time-trouble'), 'Cash crunch');
  assert.equal(finance('reserve'), 'Emergency fund');
  assert.equal(finance('declined'), 'Skipped');
  assert.equal(finance('opening-prep'), 'Morning plan');
  assert.equal(finance('score'), 'Budget score');
  assert.equal(finance('result-mark'), '✓ · = · ✗');
  assert.equal(finance('colour'), 'Workday · Day off');
  // the counterfactual is never called saved
  for (const key of ['kept', 'edge', 'sweep']) assert.doesNotMatch(finance(key) + ' ' + TERMS.find((one) => one.key === key).meaning, /\bsav(ed|ing)\b/i);
});

test('the meanings and the finance names hold none of the other mode’s words', () => {
  for (const one of TERMS) {
    assert.deepEqual(otherModeWords(one.finance), [], one.key + ' finance name');
    assert.deepEqual(otherModeWords(one.meaning), [], one.key + ' meaning');
  }
});

/* -------------------------------------------------------------------- phrases */

test('every phrase is written in both modes with the same placeholders', () => {
  const keys = Object.keys(PHRASES);
  assert.ok(keys.length > 80);
  for (const key of keys) {
    assert.match(key, /^[a-z]+(\.[A-Za-z!?]+)+$/, key + ' is a dotted key');
    const one = PHRASES[key];
    assert.deepEqual(Object.keys(one).sort(), ['chess', 'finance'], key);
    for (const mode of WORDS) assert.ok(typeof one[mode] === 'string' && one[mode].length > 0, key + ' in ' + mode);
    assert.deepEqual(placeholders(one.finance), placeholders(one.chess), key + ' takes the same placeholders');
  }
});

test('no phrase in Finance words holds a word of the other mode', () => {
  for (const key of Object.keys(PHRASES)) {
    assert.deepEqual(otherModeWords(phrase(key, 'finance')), [], key + ': ' + phrase(key, 'finance'));
  }
});

test('say fills the placeholders and leaves the text around them as written', () => {
  assert.equal(say('assess.sweep.kept', 'chess', { amount: '$47' }), 'Last week you kept $47 against habit.');
  assert.equal(say('assess.sweep.kept', 'finance', { amount: '$47' }), 'Last week came in $47 under baseline.');
  assert.equal(say('assess.sweep.kept', undefined, { amount: '$47' }), 'Last week you kept $47 against habit.');
  // a dollar sign in a value is written as it is (no replacement pattern)
  assert.equal(say('annotate.manual', 'finance', { amount: '$&$1' }), 'Marked by you: $&$1');
  // a placeholder the vars do not name stays visible; no vars at all gives the template
  assert.equal(say('annotate.manual', 'finance', {}), 'Marked by you: {amount}');
  assert.equal(say('annotate.manual', 'finance'), 'Marked by you: {amount}');
  assert.equal(say('no.such.phrase', 'finance', {}), '');
  assert.equal(phrase('page.board', 'finance'), 'Overview');
  assert.deepEqual(placeholders('{a} and {b}, {a}'), ['a', 'b']);
});

/* -------------------------------------------------------------------- signs */

test('the signs are named once: the schema, the assessment and the glyphs read the vocabulary', () => {
  assert.deepEqual(Object.keys(GLYPH_NAMES), Object.keys(GLYPHS));
  for (const glyph of Object.keys(GLYPHS)) {
    assert.equal(GLYPHS[glyph].name, GLYPH_NAMES[glyph].chess);
    assert.equal(glyphName(glyph), GLYPH_NAMES[glyph].chess);
    assert.equal(glyphName(glyph, 'finance'), GLYPH_NAMES[glyph].finance);
  }
  assert.equal(glyphName('box', 'finance'), 'Fixed obligation');
  assert.equal(glyphName('only'), 'Only move');
  assert.equal(glyphName('nothing'), '');
  assert.deepEqual(Object.keys(EVAL_NAMES), SYMBOLS);
  for (const symbol of SYMBOLS) {
    assert.equal(SYMBOL_LABELS[symbol], EVAL_NAMES[symbol].chess);
    assert.equal(evalName(symbol, 'finance'), EVAL_NAMES[symbol].finance);
  }
  assert.deepEqual(['!!', '!', '!?', '?!', '?', '??', '□'].map((glyph) => glyphName(glyph, 'finance')),
    ['No-spend day', 'Good decision', 'ROI pending', 'Unplanned purchase', 'Poor decision', 'Penalty fee', 'Fixed obligation']);
});

test('a result: its mark, its name and its words, in both modes', () => {
  assert.deepEqual([1, 0.5, 0].map((r) => resultText(r)), ['1', '½', '0']);
  assert.deepEqual([1, 0.5, 0].map((r) => resultText(r, 'finance')), ['✓', '=', '✗']);
  assert.deepEqual([1, 0.5, 0].map((r) => resultName(r, 'finance')), ['Under budget', 'On budget', 'Over budget']);
  assert.deepEqual([1, 0.5, 0].map((r) => resultWords(r)), ['a win', 'a draw', 'a loss']);
  assert.equal(resultText(null), '');
  assert.equal(resultName(2, 'finance'), '');
});

test('lowerFirst reads a name inside a sentence; an acronym keeps its capitals', () => {
  for (const glyph of Object.keys(GLYPH_NAMES)) assert.equal(lowerFirst(GLYPH_NAMES[glyph].chess), GLYPH_NAMES[glyph].chess.toLowerCase());
  assert.equal(lowerFirst('ROI pending'), 'ROI pending');
  assert.equal(lowerFirst('Good decision'), 'good decision');
  assert.equal(lowerFirst(''), '');
  assert.equal(lowerFirst(null), '');
});

test('the glyphs speak the words asked for, and Chess words when none are', () => {
  assert.match(String(evalGlyph('clear_plus')), /aria-label="Clear advantage"/);
  assert.match(String(evalGlyph('clear_plus', { words: 'finance' })), /aria-label="Favorable"/);
  assert.match(String(timeTroubleGlyph()), /aria-label="Time trouble"/);
  assert.match(String(timeTroubleGlyph({ words: 'finance' })), /aria-label="Cash crunch"/);
  assert.match(String(moveGlyph('?!')), /aria-label="Dubious"/);
  assert.match(String(moveGlyph('□', { words: 'finance' })), /aria-label="Fixed obligation"/);
  assert.match(String(resultMark(0.5, 'provisional', { glyph: '!' })), /aria-label="Draw, provisional, good move"[^>]*>½</);
  assert.match(String(resultMark(1, 'final', { glyph: '!?', words: 'finance' })), /aria-label="Under budget, ROI pending"[^>]*>✓</);
  assert.match(String(resultMark(1, 'prematch', { words: 'finance' })), /aria-label="Under budget, baseline period"/);
  assert.match(String(resultMark(null, 'future', { words: 'finance' })), /aria-label="Upcoming"/);
  assert.match(String(resultMark(null, 'live', { words: 'finance' })), /aria-label="In progress"/);
});

/* -------------------------------------------------------------------- schema labels */

test('the schema’s labels in both modes; Chess words when none are asked for', () => {
  assert.equal(KLASSES.book.label, 'The Book');
  assert.equal(klassLabel('book', 'finance'), 'Recurring bills');
  assert.equal(klassShort('book', 'finance'), 'Recurring');
  assert.equal(klassShort('game', 'finance'), 'Daily budget');
  assert.equal(klassShort('game'), KLASSES.game.short);
  assert.equal(klassLabel('need', 'finance'), KLASSES.need.label);
  assert.equal(klassLabel('nothing'), '');
  assert.equal(TX_KINDS.decline.label, 'Declined');
  assert.equal(txKindLabel('decline', 'finance'), 'Skipped');
  assert.equal(txKindLabel('spend', 'finance'), TX_KINDS.spend.label);
  assert.equal(ACCOUNT_TYPES.cash.label, 'Cash in hand');
  assert.equal(accountTypeLabel('cash', 'finance'), 'Physical cash');
  assert.equal(accountTypeLabel('savings', 'finance'), 'Savings');
  assert.equal(accountLabel({ type: 'cash', name: '' }, 'finance'), 'Physical cash');
  assert.equal(accountLabel({ type: 'cash', name: '' }), 'Cash in hand');
  assert.equal(accountShort({ type: 'cash', name: 'Wallet 1234' }, 'finance'), 'Physical cash ··1234');
  // the cash account the app makes is named after its kind, so its name follows the words; the owner's own name stays
  const made = { type: 'cash', name: CASH_NAME };
  assert.equal(accountLabel(made), CASH_NAME);
  assert.equal(accountShort(made), CASH_NAME);
  assert.equal(accountLabel(made, 'finance'), 'Physical cash');
  assert.equal(accountShort(made, 'finance'), 'Physical cash');
  assert.equal(accountLabel({ ...made, nick: 'Jar' }, 'finance'), 'Jar');
  assert.equal(accountLabel({ type: 'savings', name: CASH_NAME }, 'finance'), CASH_NAME);
});

test('an unreadable copy is described in the words asked for', () => {
  const doc = defaultState(0);
  doc.txs.push({ id: 'tx_1', kind: 'nothing', amount: 100, flow: 'out', day: '2026-01-01' });
  assert.equal(checkDoc(doc), 'This copy contains an unreadable move.');
  assert.equal(checkDoc(doc, { words: 'finance' }), 'This copy contains an unreadable transaction.');
  const other = defaultState(0);
  other.habits.push({ from: 'not a day' });
  assert.equal(checkDoc(other, { words: 'finance' }), 'This copy contains an unreadable baseline.');
});

/* -------------------------------------------------------------------- model text */

const NOW = new Date(2026, 5, 18, 14, 30).getTime();

/** Every string the model writes for the sample, in one mode, with where it came from. */
function modelText(state, nowMs, words) {
  const opts = words ? { words } : {};
  const ledger = makeLedger(state, nowMs);
  const today = ledger.today;
  const shared = { ledger, ...opts };
  const out = [];
  const collect = (where, value) => {
    if (typeof value === 'string') out.push([where, value]);
    else if (Array.isArray(value)) value.forEach((item, i) => collect(where + '[' + i + ']', item));
    else if (value instanceof Map) [...value.entries()].forEach(([key, item]) => collect(where + '.' + key, item));
    else if (value && typeof value === 'object') {
      Object.keys(value).filter((key) => !CODE_FIELDS.has(key)).forEach((key) => collect(where + '.' + key, value[key]));
    }
  };
  collect('assess', assess(state, nowMs, shared));
  collect('notes', coachNotes(state, nowMs, { limit: 50, ledger, ...opts }));
  for (const back of [0, 1, 2]) {
    const ym = monthOf(addDays(today, -31 * back));
    collect('review:' + ym, monthReview(state, ym, nowMs, shared));
  }
  const rounds = [];
  for (let i = 0; i < 40; i++) rounds.push(ledger.round(addDays(today, -i)));
  rounds.forEach((round) => collect('ann:' + round.day, annotateRound(round, opts)));
  collect('rounds', reviewRounds(rounds, opts));
  for (const category of ['cafe', 'groceries', 'eating_out']) {
    for (const amount of [450, 1800, 9000]) collect('preview', previewMove(ledger.round(today), { amount, category }, opts));
  }
  collect('projection', projectNetWorth(state, nowMs, shared));
  for (const amount of [2500, 90000, 4000000]) {
    collect('impact', purchaseImpact(state, nowMs, { amount, on: 'cash' }, shared));
    collect('impact', purchaseImpact(state, nowMs, { amount, on: 'card' }, shared));
  }
  return out;
}

test('the model writes the same text in Chess words as with no words asked for', () => {
  for (const nowMs of [NOW, NOW + 9 * 86400000]) {
    const state = buildDemoState(nowMs);
    assert.deepEqual(modelText(state, nowMs, 'chess'), modelText(state, nowMs, undefined));
  }
});

test('the model’s text in Finance words holds none of the other mode’s words', () => {
  for (const nowMs of [NOW, NOW + 9 * 86400000, NOW + 40 * 86400000]) {
    const state = buildDemoState(nowMs);
    const text = modelText(state, nowMs, 'finance');
    assert.ok(text.length > 50, 'the sample says enough to read');
    const kept = text.filter(([, value]) => otherModeWords(value).length).map(([where, value]) => where + ': ' + value);
    assert.deepEqual(kept, []);
  }
});

test('the assessment names its factors and verdict in Finance words', () => {
  const state = buildDemoState(NOW);
  const read = assess(state, NOW, { words: 'finance' });
  assert.deepEqual(['material', 'time', 'structure', 'initiative'].map((key) => read[key].title),
    ['Net worth trend', 'Liquidity', 'Debt trend', 'Savings rate']);
  for (const key of ['material', 'time', 'structure', 'initiative']) assert.equal(read[key].label, evalName(read[key].symbol, 'finance'));
  assert.equal(read.label, evalName(read.symbol, 'finance'));
  assert.ok(read.sentence.startsWith(read.label + ' — '));
  const same = assess(state, NOW);
  for (const key of ['material', 'time', 'structure', 'initiative']) assert.equal(read[key].symbol, same[key].symbol, 'only words change');
});

test('only words change: figures, signs and order are the same in both modes', () => {
  const state = buildDemoState(NOW);
  const ledger = makeLedger(state, NOW);
  const strip = (value) => JSON.parse(JSON.stringify(value, (key, item) => (typeof item === 'string' ? 0 : item)));
  for (const [inDefault, inFinance] of [
    [assess(state, NOW, { ledger }), assess(state, NOW, { ledger, words: 'finance' })],
    [coachNotes(state, NOW, { ledger, limit: 50 }).map((n) => n.priority), coachNotes(state, NOW, { ledger, limit: 50, words: 'finance' }).map((n) => n.priority)],
    [projectNetWorth(state, NOW, { ledger }), projectNetWorth(state, NOW, { ledger, words: 'finance' })],
  ]) assert.deepEqual(strip(inFinance), strip(inDefault));
  const round = ledger.round(ledger.today);
  const a = annotateRound(round);
  const b = annotateRound(round, { words: 'finance' });
  assert.deepEqual([...b.moves.keys()], [...a.moves.keys()]);
  assert.deepEqual([...b.moves.values()].map((one) => one.glyph), [...a.moves.values()].map((one) => one.glyph));
});

/* -------------------------------------------------------------------- the render's words */

test('the derived data of a render writes in the render’s words', () => {
  const state = buildDemoState(NOW);
  const plain = makeDerived(state, NOW);
  const finance = makeDerived(state, NOW, { words: 'finance' });
  assert.equal(plain.words, 'chess');
  assert.equal(finance.words, 'finance');
  assert.equal(plain.assessment.material.title, 'Material');
  assert.equal(finance.assessment.material.title, 'Net worth trend');
  assert.deepEqual(plain.notes.map((one) => one.key), finance.notes.map((one) => one.key), 'the same notes, in other words');
  const said = finance.notes.map((one) => one.text + ' ' + (one.cta ? one.cta.label : ''));
  assert.deepEqual(said.filter((text) => otherModeWords(text).length), []);
  assert.deepEqual(otherModeWords(finance.projection.lines.map((line) => line.label).join(' ')), []);
});

/* -------------------------------------------------------------------- the glossary sheet */

test('the glossary sheet lists every term both ways, the name in use in bold, as a description list', () => {
  for (const words of ['chess', 'finance']) {
    const page = String(glossary({ words }));
    assert.equal((page.match(/<dt /g) || []).length, TERMS.length, words + ': one term per entry');
    assert.equal((page.match(/<dd /g) || []).length, TERMS.length, words + ': one meaning per term');
    assert.equal((page.match(/wd-now/g) || []).length, TERMS.length, words + ': one name in bold per term');
    assert.equal((page.match(/<section /g) || []).length, TERM_GROUPS.length);
    for (const group of TERM_GROUPS) assert.ok(page.includes('>' + group[words] + '<'), group.key + ' heading in ' + words);
    // both names of a term show in either mode, the one in use in bold
    assert.match(page, words === 'chess'
      ? /<span class="wd-name wd-now">Board<\/span>.*?<span class="wd-name">Overview<\/span>/s
      : /<span class="wd-name">Board<\/span>.*?<span class="wd-name wd-now">Overview<\/span>/s);
    assert.match(page, /<span class="vh">, in Finance words, <\/span>/);
  }
  assert.equal(glossaryLabel({ words: 'finance' }), 'Every term');
  assert.match(String(glossary({ words: 'finance' })), /The app speaks Finance words now\./);
  assert.match(String(glossary({})), /The app speaks Chess words now\./);
});

test('a score keeps its half point in Chess words and is a decimal in Finance words', () => {
  assert.equal(fmtScore(6.5), '6½');
  assert.equal(fmtScore(6.5, 'chess'), '6½');
  assert.equal(fmtScore(0.5, 'chess'), '½');
  assert.equal(fmtScore(7, 'chess'), '7');
  assert.equal(fmtScore(0, 'chess'), '0');
  assert.equal(fmtScore(6.5, 'finance'), '6.5');
  assert.equal(fmtScore(6.5, { words: 'finance' }), '6.5');
  assert.equal(fmtScore(0.5, 'finance'), '0.5');
  assert.equal(fmtScore(7, 'finance'), '7');
  assert.equal(fmtScore(0, 'finance'), '0');
  assert.equal(fmtScore(NaN, 'finance'), '—');
  assert.equal(scoreOf(12.5, 17), '12½/17');
  assert.equal(scoreOf(12.5, 17, 'finance'), '12.5/17');
  for (const x of [0, 0.5, 1, 3.5, 12.5, 24.5, 60]) assert.deepEqual(otherModeWords(scoreOf(x, 60, 'finance')), [], x + ' in Finance words');
});

test('Finance words say "budget score", never "score" on its own: the word-boundary check', () => {
  assert.deepEqual(otherModeWords('The score, the marks and the best day'), [String(BARE_SCORE)]);
  assert.deepEqual(otherModeWords('no score is recorded for it'), [String(BARE_SCORE)]);
  assert.deepEqual(otherModeWords('Budget score 6.5/10'), []);
  assert.deepEqual(otherModeWords('BUDGET SCORE'), []);
  assert.deepEqual(otherModeWords('that window would have had a budget score of 41%'), []);
  assert.deepEqual(otherModeWords('no day is scored yet; Workdays {score},'), []);
  for (const key of ['habit.backtest', 'habit.offer.scored', 'parts.legend.score', 'scoresheet.noScore.notBegun', 'scoresheet.noScore.before']) {
    assert.ok(phrase(key, 'finance'), key);
    assert.deepEqual(otherModeWords(phrase(key, 'finance')), [], key + ': ' + phrase(key, 'finance'));
  }
  assert.equal(phrase('parts.legend.score', 'finance'), 'Budget score');
  assert.equal(phrase('parts.legend.score', 'chess'), 'Score');
  assert.equal(say('habit.backtest', 'finance', { pct: 41 }), 'Under these lines that window would have had a budget score of 41%. The target is set where the budget score comes nearest 40%.');
  assert.equal(say('habit.offer.scored', 'chess', { score: '24½/60' }), '; that window would have scored 24½/60');
  assert.equal(say('habit.offer.scored', 'finance', { score: '24.5/60' }), '; that window would have had a budget score of 24.5/60');
});
