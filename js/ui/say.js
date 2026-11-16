/**
 * A phrase of the vocabulary (model/words.js) as markup, for views. Its own text is code-authored and goes in as
 * written; each {placeholder} is filled from `vars` the way html`` fills a value: text escaped, markup (html``,
 * raw()) kept. For an attribute or plain text, use the vocabulary's own say() instead.
 */
import { html, raw } from './dom.js';
import { phrase } from '../model/words.js';

/**
 * @param {string} key
 * @param {*} mode   'chess' or 'finance' (ctx.words)
 * @param {Object<string, *>} [vars]
 */
export function sayHtml(key, mode, vars = {}) {
  const template = phrase(key, mode);
  const parts = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    parts.push(raw(template.slice(last, m.index)));
    parts.push(Object.hasOwn(vars, m[1]) ? vars[m[1]] : m[0]);
    last = m.index + m[0].length;
  }
  parts.push(raw(template.slice(last)));
  return html`${parts}`;
}
