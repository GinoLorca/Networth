/**
 * The glossary sheet: every term, both ways (ARCHITECTURE.md section 11). Its address is `sheet=words` over any
 * screen; Settings → Appearance opens it ("See every term"), and so does the Board's key band.
 *
 * It lists every term of model/words.js TERMS by group, as "Chess name · Finance name" with its one-line meaning.
 * Both names show in either mode, since the sheet teaches; the name the app speaks now is set in bold. The group
 * headings and the sheet's own words follow the mode. A screen reader hears each pair as "Board, in Finance words,
 * Overview" before its meaning (a description list: one term, one meaning). Read-only: no actions.
 */

import { html, cx } from '../ui/dom.js';
import { TERMS, phrase, say, termsByGroup, wordsMode } from '../model/words.js';

/** The sheet's name, for the dialog and the address. */
export function label(ctx) {
  return phrase('words.sheet', ctx ? ctx.words : undefined);
}

export function render(ctx) {
  const words = wordsMode(ctx ? ctx.words : undefined);
  return html`<div class="sheet-body wd">
    <p class="sheet-head lab"><b>${phrase('words.head', words)}</b><i class="sep"></i>${say('words.count', words, { count: TERMS.length })}</p>
    <h2 class="sheet-title">${phrase('words.title', words)}</h2>
    <p class="cap wd-lede">${phrase('words.lede', words)}</p>
    ${termsByGroup().map(({ group, terms }) => html`<section class="wd-group" aria-labelledby="wd-${group.key}">
      <h3 class="lab wd-head" id="wd-${group.key}"><b>${group[words]}</b></h3>
      <dl class="wd-list">
        ${terms.map((one) => html`<div class="wd-term">
          <dt class="wd-names"><span class="${cx('wd-name', words === 'chess' && 'wd-now')}">${one.chess}</span><span class="wd-dot" aria-hidden="true"> · </span><span class="vh">, in ${
            phrase('words.column.finance', words)}, </span><span class="${cx('wd-name', words === 'finance' && 'wd-now')}">${one.finance}</span></dt>
          <dd class="cap wd-meaning">${one.meaning}</dd>
        </div>`)}
      </dl>
    </section>`)}
  </div>`;
}
