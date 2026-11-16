import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from '../js/ui/dom.js';
import { sayHtml } from '../js/ui/say.js';
import { PHRASES, phrase } from '../js/model/words.js';

test('sayHtml writes a phrase as markup: its text as written, values filled as html`` fills them', () => {
  // a figure keeps its own markup; text from the record is escaped
  const amount = html`<span data-fig>$4.75</span>`;
  assert.equal(String(sayHtml('board.premise.habit', 'chess', { habit: amount, kind: 'workday' })),
    'Habit plays <span data-fig>$4.75</span> on a workday.');
  assert.equal(String(sayHtml('board.premise.habit', 'finance', { habit: amount, kind: 'workday' })),
    'The baseline is <span data-fig>$4.75</span> on a workday.');
  assert.equal(String(sayHtml('tx.scope.later.out', 'chess', { merchant: 'Joe & <Sons>' })),
    'All money out: later moves out to Joe &amp; &lt;Sons&gt; follow. This is the only one on record so far.');
  // the phrase's own markup goes in as written
  assert.equal(String(sayHtml('board.vs', 'finance')), 'Spending <i>vs.</i> baseline');
});

test('sayHtml leaves a placeholder it is not given in sight, and says nothing for a key that is not one', () => {
  assert.equal(String(sayHtml('book.noPayday', 'chess')), 'No payday is known yet, so the clock counts {days} days ahead instead.');
  assert.equal(String(sayHtml('no.such.key', 'chess')), '');
  assert.equal(String(sayHtml('book.title', undefined)), phrase('book.title', 'chess'));
});

test('every phrase a view writes as markup is the same text either way it is written', () => {
  // with no placeholders, sayHtml and phrase give the same characters (no escaping of the vocabulary's own text)
  for (const key of Object.keys(PHRASES)) {
    for (const mode of ['chess', 'finance']) {
      const text = phrase(key, mode);
      if (/\{\w+\}/.test(text)) continue;
      assert.equal(String(sayHtml(key, mode)), text, key + ' in ' + mode);
    }
  }
});
