/**
 * Icons — a small set of quiet line icons, drawn to sit with the type.
 *
 * PUBLIC CONTRACT
 *
 *   icon(name, opts?)  -> safe markup (an html`` result): <svg class="ic ic--{name}" viewBox="0 0 24 24" aria-hidden="true">…</svg>
 *       name   'plus' | 'refresh' | 'close' | 'check' | 'chevron-left' | 'chevron-right' | 'chevron-down'
 *              | 'eye' | 'eye-off' | 'link' | 'unlink' | 'undo' | 'external' | 'dots'
 *              An unknown name renders nothing (and warns once in the console).
 *       opts   { label?: string }   with a label the icon is exposed as an image with that name
 *              (role="img", aria-label, <title>); without one it is decorative (aria-hidden) and the
 *              button or link around it must carry the accessible name.
 *
 *   ICON_NAMES         -> the list of names, for specimen pages and tests.
 *
 * The icon is 1em square, uses currentColor, and its strokes are always 1.5px on screen whatever the
 * font size (non-scaling strokes, square ends, mitred corners). It sits slightly below the baseline
 * so it centres on lower-case text; set font-size on the icon or its parent to size it.
 * Style: .ic in css/ui.css.
 */
import { html, raw } from './dom.js';

const PATHS = {
  plus: '<path d="M12 4.5v15M4.5 12h15"/>',
  close: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
  check: '<path d="M4.5 12.5l5 5L19.5 6.5"/>',
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
  'chevron-down': '<path d="M5 9l7 7 7-7"/>',
  refresh: '<path d="M19 3.5V8h-4.5"/><path d="M19 8a8 8 0 1 0 1 4"/>',
  undo: '<path d="M8.5 4.5L4 9l4.5 4.5"/><path d="M4 9h10a5.5 5.5 0 0 1 0 11H9"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.75"/>',
  'eye-off': '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.75"/><path d="M4.5 3.5l15 17"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4L11.6 5.9"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>',
  unlink: '<path d="M16.4 13.9l3-3a4.5 4.5 0 0 0-6.4-6.4L11.6 5.9"/><path d="M7.6 10.1l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/><path d="M8 2.5v3M2.5 8h3M16 21.5v-3M21.5 16h-3"/>',
  external: '<path d="M13.5 4.5h6v6"/><path d="M19.5 4.5L11 13"/><path d="M17.5 14v5.5h-13v-13H10"/>',
  dots: '<circle class="ic-dot" cx="5" cy="12" r="1.4"/><circle class="ic-dot" cx="12" cy="12" r="1.4"/><circle class="ic-dot" cx="19" cy="12" r="1.4"/>',
};

export const ICON_NAMES = Object.keys(PATHS);

const warned = new Set();

/** Inline SVG for one icon. */
export function icon(name, opts = {}) {
  const inner = Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name] : null;
  if (!inner) {
    if (!warned.has(name)) { warned.add(name); console.warn('[icons] unknown icon', name); }
    return raw('');
  }
  if (opts.label) {
    return html`<svg class="ic ic--${name}" viewBox="0 0 24 24" role="img" aria-label="${opts.label}" focusable="false"><title>${opts.label}</title>${raw(inner)}</svg>`;
  }
  return html`<svg class="ic ic--${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${raw(inner)}</svg>`;
}
