/**
 * The split bar — <nw-split> — the signature of the app: one bar, a white part against a black part
 * (assets against liabilities, kept against spent, payments against new charges).
 * Loading this module registers the element (a side-effect import is enough). Styles: css/ui.css.
 *
 * PUBLIC CONTRACT
 *
 *   <nw-split data-island a="4231055" b="3987420" mark="centre" label="Assets $42,310.55 against liabilities $39,874.20"></nw-split>
 *
 *   Always write data-island on it (it draws its own children; morph() then only syncs attributes).
 *   Attributes (all read live):
 *     a, b    non-negative numbers in any one unit. The white part is a / (a + b) of the width, from the
 *             left. Missing, negative or non-numeric values count as 0; when both are 0 the bar is 50/50.
 *     slim    present = the thinner bar (12px; 14px on wide screens) instead of 18px (22px).
 *     mark    "centre" = the two small ticks above and below the bar at the half-way point, as in the
 *             mock (the element is then 12px taller: 6px above and 6px below). "none" or absent = no ticks.
 *     hatch   a number from 0 to 1: the share of the WHITE part that is drawn hatched, at its right-hand
 *             end, next to the divide (kept but not yet moved). Absent or 0 = none.
 *     label   the accessible name; the bar is exposed as role="img" with this aria-label. Without it the
 *             bar is hidden from assistive technology (aria-hidden) — do that only when the figures are
 *             printed right beside it.
 *     intro   present = on first appearance the bar starts at 50/50 and glides to its value.
 *
 *   Behaviour
 *     - Block-level, as wide as its container; colours come from --bar-white, --bar-black, --bar-edge.
 *     - It glides (0.9 s, --ease) whenever the numbers change; prefers-reduced-motion turns the glide off.
 *     - It dispatches no events and writes nothing to its own host: the state lives on its children
 *       (.sb > .sb-bar > .sb-w > svg.sb-h). The role and aria-label are on the inner .sb.
 *     - Labels and figures above the bar are the view's business; this element is the bar alone.
 */
import { define, prefersReducedMotion } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let serial = 0;

function amount(el, name) {
  const n = Number(el.getAttribute(name));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

class NwSplit extends HTMLElement {
  static get observedAttributes() {
    return ['a', 'b', 'hatch', 'label'];
  }

  constructor() {
    super();
    this._root = null;
    this._raf = 0;
  }

  connectedCallback() {
    const first = !this._root;
    if (first) this._build();
    if (first && this.hasAttribute('intro') && !prefersReducedMotion()) {
      this._white.style.width = '50%';
      this._hatch.style.width = '0%';
      this._syncLabel();
      // two frames: the first paints 50/50, the second starts the glide
      this._raf = requestAnimationFrame(() => {
        this._raf = requestAnimationFrame(() => { this._raf = 0; this._sync(); });
      });
    } else {
      this._sync();
    }
  }

  disconnectedCallback() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; this._sync(); }
  }

  attributeChangedCallback() {
    if (this._root && !this._raf) this._sync();
  }

  _build() {
    this.textContent = '';
    const id = 'sb-hatch-' + (++serial);
    const root = document.createElement('span');
    root.className = 'sb';
    const bar = document.createElement('span');
    bar.className = 'sb-bar';
    const white = document.createElement('span');
    white.className = 'sb-w';

    const hatch = svgEl('svg', { class: 'sb-h', 'aria-hidden': 'true', focusable: 'false' });
    const defs = svgEl('defs', {});
    const pattern = svgEl('pattern', { id, width: '5', height: '5', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.appendChild(svgEl('path', { class: 'sb-hl', d: 'M0 0V5' }));
    defs.appendChild(pattern);
    hatch.appendChild(defs);
    hatch.appendChild(svgEl('rect', { width: '100%', height: '100%', fill: 'url(#' + id + ')' }));

    white.appendChild(hatch);
    bar.appendChild(white);
    root.appendChild(bar);
    this.appendChild(root);
    this._root = root;
    this._white = white;
    this._hatch = hatch;
  }

  _syncLabel() {
    const label = this.getAttribute('label');
    const root = this._root;
    if (label) {
      root.setAttribute('role', 'img');
      root.setAttribute('aria-label', label);
      root.removeAttribute('aria-hidden');
    } else {
      root.removeAttribute('role');
      root.removeAttribute('aria-label');
      root.setAttribute('aria-hidden', 'true');
    }
  }

  _sync() {
    const a = amount(this, 'a');
    const b = amount(this, 'b');
    const share = a + b > 0 ? a / (a + b) : 0.5;
    const hatch = Math.min(1, amount(this, 'hatch'));
    this._white.style.width = (share * 100).toFixed(3) + '%';
    this._hatch.style.width = (hatch * 100).toFixed(3) + '%';
    this._syncLabel();
  }
}

define('nw-split', NwSplit);
