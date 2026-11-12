/**
 * The hero number — <nw-ticker> — and its still sibling, figureHtml().
 * Loading this module registers the element (a side-effect import is enough). Styles: css/ui.css.
 *
 * PUBLIC CONTRACT
 *
 *   <nw-ticker data-island value="241786.12" rate="0.0203" t0="1794345600000" approx from="240749"></nw-ticker>
 *
 *   Always write data-island on it (it draws its own children; morph() then only syncs attributes).
 *   Attributes (all read live; change them through the template and the element follows):
 *     value   cents, may be fractional. Absent or not a number: an em dash is shown.
 *     rate    cents per SECOND. 0 or absent: the figure stands still.
 *     t0      epoch milliseconds at which `value` was true. The element shows
 *             value + rate × (dates.nowMs() − t0) / 1000. Absent: the moment the attributes were read.
 *     approx  present = an estimate ("in pencil"): italic figure, the ≈ sign in the spot colour, and two
 *             small extra digits (hundredths of a cent) in the spot colour that move as it ticks.
 *             absent  = a fact from the bank ("in ink"): roman, cents only, no sign, no extra digits.
 *     from    cents. Used once, the first time the element appears on screen: the figure starts at `from`
 *             and rolls to the current value (the "since you last looked" roll, about 1.4 s).
 *     sign    "always" = a plus on positive values. Default: none. Negative values always carry the
 *             true minus (U+2212).
 *     cover   present = a redaction bar of fixed width instead of the digits; ticking stops.
 *             The element is also covered, with no attribute of its own, whenever any ancestor carries
 *             the attribute data-cover (the app's cover mode) — it watches for that itself.
 *     label   optional words put before the amount for screen readers ("Net worth, live estimate").
 *
 *   Behaviour
 *     - Size: the element is inline-block, line-height 1, in the display face; its size is the host's
 *       CSS font-size and everything inside is in em/ch. Set e.g. `nw-ticker.hero { font-size: var(--t-hero) }`.
 *       Width in Didot is about 0.53em per digit, 0.2em per comma or point, 0.65em for the dollar sign,
 *       0.6em for a sign, plus 0.33em (≈) and 0.5em (small digits) when approx — "≈ $2,417.86 12" is 4.9em.
 *     - Every digit and every point sits in a fixed-width cell, so nothing jitters as it ticks.
 *     - When the value changes (or the clock jumps, or the page comes back from the background) by more
 *       than a tick explains, the figure rolls to the new value in about 0.9 s through intermediate
 *       values, easing out. Smaller differences are simply shown.
 *     - While rate ≠ 0 it repaints about eight times a second; it stops while the page is hidden or the
 *       element is off screen, and catches up when it returns.
 *     - prefers-reduced-motion: no roll; the figure still updates (once a second).
 *     - Screen readers get one image named "{label} approximately $2,417.86" (rounded to the cent,
 *       refreshed at most every four seconds; "hidden" under cover). The digit cells are aria-hidden.
 *     - It dispatches no events and writes nothing to its own host: all state lives on child nodes
 *       (.tk, .tk-approx, .tk-main, .tk-mini, .tk-bar and the cells .tk-c / .tk-p / .tk-s).
 *
 *   figureHtml(cents, opts?) -> safe markup (an html`` result) for a STILL figure with the same cells,
 *   for tables and tallies. It inherits font-size and colour and is set in the figure face.
 *     opts  { approx?: boolean          italic, preceded by the ≈ sign in the spot colour
 *             sign?: 'auto'|'always'|'never'   'always' adds + on positive amounts; 'never' drops the minus
 *             decimals?: 2|0            0 = whole dollars (rounded)
 *             sub?: boolean             with approx: also the two small extra digits (floored, not rounded)
 *             cover?: boolean           a redaction bar of fixed width instead (assistive technology
 *                                       hears "hidden"). Not needed under the app's cover mode: inside any
 *                                       ancestor with data-cover every figureHtml() figure is redacted by
 *                                       css/ui.css (an ink bar of the figure's own width, silent to
 *                                       assistive technology), so nothing has to be threaded through.
 *             symbol?: string           currency symbol, default '$'; '' for scoresheet notation
 *             display?: boolean         use the display face (Didot) instead of the figure face (Bodoni)
 *           }
 *     null / undefined / NaN cents render an em dash.
 *     Emits: <span class="fg [fg--approx] [fg--display] [fg--cover]"> containing a visually hidden
 *     reading (.fg-sr) and the aria-hidden cells (.fg-v > .fg-approx, .tk-c, .tk-p, .tk-s, .fg-sub; or .fg-bar).
 */
import { define, html, raw, esc, prefersReducedMotion } from './dom.js';
import { nowMs } from '../model/dates.js';
import { MINUS } from '../model/money.js';

const ROLL_MS = 900;
const FROM_ROLL_MS = 1400;
const TICK_MS = 125;
const TICK_MS_REDUCED = 1000;
const LABEL_MS = 4000;

/* ------------------------------------------------------------ formatting */

function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Split cents for display.
 *   floorSub = true : hundredths of a cent are kept and floored (a ticking figure never shows a value it has not reached)
 *   floorSub = false: floored to the cent (the signed value, R5), or rounded to the dollar when decimals is 0
 */
function split(cents, floorSub, decimals) {
  const abs = Math.abs(cents);
  let whole;
  let sub = 0;
  if (floorSub) {
    const hundredths = Math.abs(Math.floor(cents * 100 + 1e-6));   // floored as a signed value: never rounded up (R5)
    whole = Math.floor(hundredths / 100);
    sub = hundredths % 100;
  } else if (decimals === 0) {
    whole = Math.round(abs / 100) * 100;
  } else {
    whole = Math.abs(Math.floor(cents));   // the cent reached, never rounded up (R5)
  }
  const nonZero = whole > 0 || sub > 0;
  return {
    neg: cents < 0 && nonZero,
    pos: cents > 0 && nonZero,
    int: group(Math.floor(whole / 100)),
    dec: String(whole % 100).padStart(2, '0'),
    sub: String(sub).padStart(2, '0'),
  };
}

function cellClass(ch) {
  if (ch >= '0' && ch <= '9') return 'tk-c';
  if (ch === ',' || ch === '.') return 'tk-c tk-p';
  return 'tk-c tk-s';
}

/* ---------------------------------------------------------- still figure */

function cellsMarkup(text) {
  let out = '';
  for (const ch of text) out += '<span class="' + cellClass(ch) + '">' + esc(ch) + '</span>';
  return out;
}

/** A still figure in fixed-width cells. See the header for the options. */
export function figureHtml(cents, opts = {}) {
  const { approx = false, sign = 'auto', decimals = 2, sub = false, cover = false, symbol = '$', display = false } = opts;
  const cls = 'fg' + (approx ? ' fg--approx' : '') + (display ? ' fg--display' : '');
  if (cover) {
    return html`<span class="${cls} fg--cover"><span class="fg-sr">hidden</span><span class="fg-bar" aria-hidden="true"></span></span>`;
  }
  if (cents == null || !Number.isFinite(cents)) return html`<span class="${cls} fg--empty">—</span>`;
  const withSub = approx && sub && decimals !== 0;
  const p = split(cents, withSub, decimals);
  const prefix = sign === 'never' ? '' : p.neg ? MINUS : sign === 'always' && p.pos ? '+' : '';
  const body = prefix + symbol + p.int + (decimals === 0 ? '' : '.' + p.dec);
  return html`<span class="${cls}"><span class="fg-sr">${approx ? 'approximately ' : ''}${body}</span><span class="fg-v" aria-hidden="true">${approx ? raw('<span class="fg-approx">≈</span>') : ''}${raw(cellsMarkup(body))}${withSub ? raw('<span class="fg-sub">' + cellsMarkup(p.sub) + '</span>') : ''}</span></span>`;
}

/* ------------------------------------------------------------ the element */

const live = new Set();
let observer = null;
let coverObserver = null;
let listening = false;

function onVisibility() {
  for (const el of live) el._step();
}

function onCoverChange() {
  for (const el of live) el._sync();
}

function watch(el) {
  live.add(el);
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', onVisibility);
  }
  // cover mode is an attribute on some ancestor: one observer tells every live ticker when it changes
  if (!coverObserver && typeof MutationObserver === 'function') {
    coverObserver = new MutationObserver(onCoverChange);
    coverObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-cover'], subtree: true });
  }
  if (typeof IntersectionObserver !== 'function') { el._seen = true; return; }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const t = e.target;
        const seen = e.isIntersecting;
        if (t._seen !== seen) { t._seen = seen; t._step(); }
      }
    });
  }
  observer.observe(el);
}

function unwatch(el) {
  live.delete(el);
  if (observer) observer.unobserve(el);
  el._seen = null;
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  if (text) s.textContent = text;
  return s;
}

function easeOut(p) {
  return 1 - Math.pow(1 - p, 3);
}

class NwTicker extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'rate', 't0', 'approx', 'sign', 'cover', 'label'];
  }

  constructor() {
    super();
    this._root = null;
    this._cells = [];
    this._miniCells = [];
    this._shown = null;      // the value on screen, in cents
    this._roll = null;       // { from, start, dur } while rolling
    this._hold = false;      // holding the `from` value until first seen
    this._nextRoll = ROLL_MS;
    this._seen = null;       // null = not known yet, true/false from the IntersectionObserver
    this._timer = 0;
    this._raf = 0;
    this._lineKey = '';
    this._stateKey = '';
    this._anchor = 0;
    this._labelAt = -Infinity;
    this._forceLabel = true;
    this._usedFrom = false;
    this._stepBound = () => this._step();
  }

  connectedCallback() {
    if (!this._root) this._build();
    watch(this);
    this._sync();
  }

  disconnectedCallback() {
    this._stop();
    unwatch(this);
    this._roll = null;
  }

  attributeChangedCallback() {
    if (this._root && this.isConnected) this._sync();
  }

  _num(name) {
    const s = this.getAttribute(name);
    if (s == null || s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  _build() {
    this.textContent = '';
    const root = span('tk');
    root.setAttribute('role', 'img');
    this._approxEl = span('tk-approx', '≈');
    this._main = span('tk-main');
    this._mini = span('tk-mini');
    this._bar = span('tk-bar');
    for (const part of [this._approxEl, this._main, this._mini, this._bar]) {
      part.setAttribute('aria-hidden', 'true');
      root.appendChild(part);
    }
    this.appendChild(root);
    this._root = root;
  }

  /** Read the attributes and bring the child nodes in line. */
  _sync() {
    const value = this._num('value');
    const rate = this._num('rate') || 0;
    const t0 = this._num('t0');
    const lineKey = value + '|' + rate + '|' + t0;
    if (lineKey !== this._lineKey) {
      this._lineKey = lineKey;
      this._anchor = t0 != null ? t0 : nowMs();
      if (this._roll) this._roll = { from: this._shown, start: performance.now(), dur: ROLL_MS };
    }
    this._value = value;
    this._rate = rate;
    this._approx = this.hasAttribute('approx');
    this._cover = this.hasAttribute('cover') || this.closest('[data-cover]') != null;
    this._plus = this.getAttribute('sign') === 'always';
    this._prefix = (this.getAttribute('label') || '').trim();

    const stateKey = [this._approx, this._cover, this._plus, this._prefix, value == null].join('|');
    if (stateKey !== this._stateKey) { this._stateKey = stateKey; this._forceLabel = true; }

    const cls = 'tk' + (this._approx ? ' tk--approx' : '') + (this._cover ? ' tk--cover' : '') + (value == null ? ' tk--empty' : '');
    if (this._root.className !== cls) this._root.className = cls;

    if (value != null && this._shown == null) {
      const from = this._usedFrom ? null : this._num('from');
      this._usedFrom = true;
      if (from != null && !prefersReducedMotion()) {
        this._shown = from;
        this._hold = true;
        this._nextRoll = FROM_ROLL_MS;
      } else {
        this._shown = this._target();
      }
    }
    this._step();
  }

  _target() {
    return this._value + (this._rate * (nowMs() - this._anchor)) / 1000;
  }

  _stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = 0; }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  /** One beat: work out what to show, paint it, and book the next beat if one is needed. */
  _step() {
    this._stop();
    if (!this._root || !this.isConnected) return;
    if (this._value == null) { this._paintText('—'); this._label('', true); return; }
    if (this._cover) { this._label('hidden', this._forceLabel); return; }

    const target = this._target();
    const reduced = prefersReducedMotion();
    const visible = !document.hidden && this._seen === true;
    let settled = false;

    if (this._roll) {
      const p = visible && !reduced ? (performance.now() - this._roll.start) / this._roll.dur : 1;
      if (p >= 1) { this._roll = null; this._shown = target; settled = true; }
      else this._shown = this._roll.from + (target - this._roll.from) * easeOut(p);
    } else if (Math.abs(target - this._shown) > 0.5 + Math.abs(this._rate) * 1.5) {
      if (visible && !reduced) {
        this._roll = { from: this._shown, start: performance.now(), dur: this._nextRoll };
        this._nextRoll = ROLL_MS;
        this._hold = false;
      } else if (!(this._hold && !reduced)) {
        this._shown = target;
      }
    } else {
      this._shown = target;
      this._hold = false;
    }

    this._paint(this._shown);
    if (!this._roll) this._label(this._words(target), this._forceLabel || settled);

    if (this._roll) this._raf = requestAnimationFrame(this._stepBound);
    else if (this._rate !== 0 && visible) this._timer = setTimeout(this._stepBound, reduced ? TICK_MS_REDUCED : TICK_MS);
  }

  _paint(cents) {
    const p = split(cents, this._approx, 2);
    const sign = p.neg ? MINUS : this._plus && p.pos ? '+' : '';
    this._cells = this._fill(this._main, this._cells, sign + '$' + p.int + '.' + p.dec);
    this._miniCells = this._fill(this._mini, this._miniCells, this._approx ? p.sub : '');
  }

  _paintText(text) {
    this._cells = this._fill(this._main, this._cells, text);
    this._miniCells = this._fill(this._mini, this._miniCells, '');
  }

  /** Put `text` into fixed cells inside `box`, touching only the cells that changed. */
  _fill(box, cells, text) {
    if (cells.length !== text.length) {
      box.textContent = '';
      cells = [];
      for (let i = 0; i < text.length; i++) cells.push(box.appendChild(document.createElement('span')));
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const cell = cells[i];
      if (cell.textContent !== ch) {
        cell.textContent = ch;
        const cls = cellClass(ch);
        if (cell.className !== cls) cell.className = cls;
      }
    }
    return cells;
  }

  _words(cents) {
    const p = split(cents, false, 2);
    const sign = p.neg ? 'minus ' : this._plus && p.pos ? 'plus ' : '';
    return (this._approx ? 'approximately ' : '') + sign + '$' + p.int + '.' + p.dec;
  }

  _label(words, force) {
    const now = performance.now();
    if (!force && now - this._labelAt < LABEL_MS) return;
    this._labelAt = now;
    this._forceLabel = false;
    const text = (this._prefix ? this._prefix + ' ' : '') + words;
    if (this._root.getAttribute('aria-label') !== text) this._root.setAttribute('aria-label', text);
  }
}

define('nw-ticker', NwTicker);
