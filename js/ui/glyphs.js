/**
 * Glyphs — the chess notation of Networth, as pure functions that return safe markup
 * (results of html``; interpolate them straight into a template). Styles: css/ui.css.
 * No emoji and no Unicode chess pieces anywhere: evaluation signs are inline SVG drawn
 * with currentColor on an em square, so they take the colour and size of the text they
 * sit in and rest on its baseline.
 *
 * PUBLIC CONTRACT
 *
 *   evalGlyph(symbol, opts?)            -> <svg class="ev [ev-wide]" role="img" aria-label="…"><title>…</title>…</svg>
 *       symbol  'winning' | 'clear_plus' | 'slight_plus' | 'equal' | 'slight_minus' | 'clear_minus'
 *               | 'losing' | 'unclear'          (assess.SYMBOLS; anything else renders nothing)
 *               The Informant signs: plus-minus (decisive), plus over minus, plus over equals,
 *               equals, equals over plus, minus over plus, minus-plus (decisive), infinity.
 *       opts    { title?: string, decorative?: boolean }
 *               title       replaces the built-in name ("Slight advantage") read by assistive technology
 *               decorative  true = aria-hidden, no title (use when the name is printed next to it)
 *       'winning', 'losing' and 'unclear' are one and a half ems wide (class ev-wide, the same
 *       name the design system uses); the rest 1em.
 *
 *   timeTroubleGlyph(opts?)             -> <svg class="ev ev--tt" …>  a plus in a circle; same opts; name "Time trouble"
 *                                          (colour it with the spot colour from the parent: it uses currentColor)
 *
 *   moveGlyph(glyph, opts?)             -> <span class="mg" role="img" aria-label="Good move" title="Good move">!</span>
 *       glyph   '!!' | '!' | '!?' | '?!' | '?' | '??' | '□' (also 'box' or 'only')   (schema.GLYPHS keys)
 *               null, '' or anything unknown renders nothing — most moves carry no annotation.
 *       opts    { title?: string }      replaces the built-in name
 *       The marks are type, set upright and bold in the figure face whatever the surrounding style;
 *       the only-move box is an SVG square (class mg mg--box).
 *
 *   resultMark(result, status, opts?)   -> <span class="rm rm--{status}" role="img" aria-label="Win, provisional" title="…">1</span>
 *       result  1 | 0.5 | 0 | null
 *       status  'final'        roman 1, ½ or 0                ("in ink")
 *               'provisional'  the same in italic             ("in pencil")
 *               'live'         an asterisk
 *               'awaiting'     a dash (the bank has not reported the day)
 *               'future'       a middle dot, in the hairline colour
 *               'prematch'     the exhibition result in the tertiary ink, or a middle dot without one
 *       opts    { glyph?: string }      an annotation ('!!', '!', '?' …) hung as a superscript to the right of
 *               the result without changing its width (class rm-sup), as in the crosstable
 *       The element is inline, in the figure face, and inherits its size: set font-size on a parent.
 *
 *   verifiedMark()                      -> <i class="vm" aria-hidden="true"></i>
 *       the small ink square that precedes a figure or label that comes straight from the bank.
 *       It is 0.6em square and brings its own right margin; it says nothing to assistive technology,
 *       so the label beside it must carry the meaning.
 *
 * CLASSES EMITTED (all styled in css/ui.css): ev, ev-wide, ev--tt, mg, mg--box, rm, rm--final,
 * rm--provisional, rm--live, rm--awaiting, rm--future, rm--prematch, rm-sup, vm.
 */
import { html, raw } from './dom.js';

/* Geometry on a 20-unit em square (wide signs: 30 by 20). Strokes only. */
const EVAL = {
  winning: { name: 'Winning', wide: true, d: 'M8 5v10M3 10h10M18 10h9' },
  clear_plus: { name: 'Clear advantage', d: 'M10 2.5v10M5 7.5h10M5 17h10' },
  slight_plus: { name: 'Slight advantage', d: 'M10 1.5v9M5.5 6h9M5.5 14h9M5.5 17.8h9' },
  equal: { name: 'Equal', d: 'M4 7.5h12M4 12.5h12' },
  slight_minus: { name: 'Slightly worse', d: 'M5.5 2.2h9M5.5 6h9M10 9.5v9M5.5 14h9' },
  clear_minus: { name: 'Clearly worse', d: 'M5 3h10M10 7.5v10M5 12.5h10' },
  losing: { name: 'Losing', wide: true, d: 'M3 10h9M22 5v10M17 10h10' },
  unclear: {
    name: 'Unclear',
    wide: true,
    d: 'M15 10c-2.6-4-5-5.6-7.4-5.6a5.6 5.6 0 0 0 0 11.2c2.4 0 4.8-1.6 7.4-5.6zm0 0c2.6 4 5 5.6 7.4 5.6a5.6 5.6 0 0 0 0-11.2c-2.4 0-4.8 1.6-7.4 5.6z',
  },
};

const MOVE = {
  '!!': 'Brilliant',
  '!': 'Good move',
  '!?': 'Interesting',
  '?!': 'Dubious',
  '?': 'Mistake',
  '??': 'Blunder',
  '□': 'Only move',
};

function svg(cls, wide, inner, name, decorative) {
  const box = wide ? '0 0 30 20' : '0 0 20 20';
  if (decorative) {
    return html`<svg class="${cls}" viewBox="${box}" aria-hidden="true" focusable="false">${raw(inner)}</svg>`;
  }
  return html`<svg class="${cls}" viewBox="${box}" role="img" aria-label="${name}" focusable="false"><title>${name}</title>${raw(inner)}</svg>`;
}

/** One of the eight evaluation signs as inline SVG. Unknown symbols render nothing. */
export function evalGlyph(symbol, opts = {}) {
  const g = Object.prototype.hasOwnProperty.call(EVAL, symbol) ? EVAL[symbol] : null;
  if (!g) return raw('');
  return svg(g.wide ? 'ev ev-wide' : 'ev', g.wide, '<path d="' + g.d + '"/>', opts.title || g.name, opts.decorative);
}

/** The time-trouble sign: a plus in a circle. */
export function timeTroubleGlyph(opts = {}) {
  return svg('ev ev--tt', false, '<circle cx="10" cy="10" r="7.6"/><path d="M10 2.4v15.2M2.4 10h15.2"/>', opts.title || 'Time trouble', opts.decorative);
}

/** An annotation mark for a move: !!, !, !?, ?!, ?, ?? or the only-move box. */
export function moveGlyph(glyph, opts = {}) {
  const key = glyph === 'box' || glyph === 'only' ? '□' : glyph;
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(MOVE, key)) return raw('');
  const name = opts.title || MOVE[key];
  if (key === '□') {
    return html`<span class="mg mg--box" role="img" aria-label="${name}" title="${name}"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="13" height="13"/></svg></span>`;
  }
  return html`<span class="mg" role="img" aria-label="${name}" title="${name}">${key}</span>`;
}

const RESULT_TEXT = { 1: '1', 0.5: '½', 0: '0' };
const RESULT_NAME = { 1: 'Win', 0.5: 'Draw', 0: 'Loss' };

/** The mark of a round in a crosstable or a list of rounds. */
export function resultMark(result, status, opts = {}) {
  const has = result === 1 || result === 0.5 || result === 0;
  let text;
  let name;
  let cls;
  if (status === 'live') { text = '*'; name = 'In play'; cls = 'live'; }
  else if (status === 'awaiting') { text = '–'; name = 'Awaiting the bank'; cls = 'awaiting'; }
  else if (status === 'future') { text = '·'; name = 'Not yet played'; cls = 'future'; }
  else if (status === 'prematch') {
    text = has ? RESULT_TEXT[result] : '·';
    name = has ? RESULT_NAME[result] + ', before the match' : 'Before the match';
    cls = 'prematch';
  } else if (has) {
    const provisional = status === 'provisional';
    text = RESULT_TEXT[result];
    name = RESULT_NAME[result] + (provisional ? ', provisional' : '');
    cls = provisional ? 'provisional' : 'final';
  } else { text = '–'; name = 'No result'; cls = 'awaiting'; }
  const sup = opts.glyph && Object.prototype.hasOwnProperty.call(MOVE, opts.glyph) && opts.glyph !== '□' ? opts.glyph : '';
  if (sup) name += ', ' + MOVE[sup].toLowerCase();
  return html`<span class="rm rm--${cls}" role="img" aria-label="${name}" title="${name}">${text}${sup ? html`<sup class="rm-sup">${sup}</sup>` : ''}</span>`;
}

/** The small ink square: this figure comes straight from the bank. */
export function verifiedMark() {
  return raw('<i class="vm" aria-hidden="true"></i>');
}
