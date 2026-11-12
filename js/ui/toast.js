/**
 * Toasts — one line at the bottom of the screen, above the phone bar: an ink block with paper text
 * and, optionally, one condensed-caps action. Styles: css/ui.css.
 *
 * PUBLIC CONTRACT
 *
 *   toast(message, opts?) -> dismiss()
 *       message  plain text (it is set as text, never parsed as markup). Keep it to one line.
 *       opts     { action?: string        label of the one action ("Undo")
 *                  onAction?: () => void  called when the action is pressed; the toast then leaves
 *                  duration?: number      milliseconds on screen. Default 4000, or 7000 with an action. }
 *       Returns a function that removes this toast early (a no-op once it has gone).
 *       At most one toast is on screen: a new one replaces the current one at once.
 *       The countdown pauses while the pointer is over the toast or focus is inside it.
 *
 *   dismissToast()   removes the current toast, if any.
 *
 *   Behaviour
 *     - The region is a polite live region (role="status"), created on first use and appended to
 *       document.body — or, while a modal dialog (a sheet) is open, inside that dialog so the toast is
 *       visible and reachable above it (placed just above a bottom sheet, below a centred dialog, or
 *       at the top of the screen when the sheet fills it); it moves back to the body when the dialog closes.
 *     - Position: fixed, centred, above the phone bar:
 *       bottom = var(--toast-lift, var(--bottom-bar)) + safe-area + 12px. On screens 1100px and wider,
 *       where there is no bottom bar, the default lift is 12px. The shell may set --toast-lift on :root
 *       (a length, e.g. 0px on a screen without the bar) to move it. Full width between the gutters on
 *       phones, at most 560px; from 720px it is as wide as its text (at least 320px).
 *     - Timing uses real time, not the app clock. prefers-reduced-motion: no fade or slide.
 *
 *   Structure created: .toast-region[data-at] > .toast[.is-leaving] > (.toast-msg, button.toast-action).
 */
import { prefersReducedMotion } from './dom.js';

const LEAVE_MS = 180;

let region = null;
let current = null; // { el, timer, left, started, gone }

function home() {
  let modal = null;
  try {
    modal = document.querySelector('dialog:modal:not([data-closing])');
  } catch (err) {
    modal = null; // :modal not supported
  }
  return modal || document.body;
}

function place() {
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
  }
  const target = home();
  if (region.parentNode !== target) {
    target.appendChild(region);
    if (target !== document.body) {
      target.addEventListener('close', () => {
        if (region.parentNode === target) document.body.appendChild(region);
      }, { once: true });
    }
  }
  // Inside a dialog the toast keeps clear of it: under a centred dialog, above a bottom sheet, or at
  // the top of the screen when the sheet fills it. (These hints only take effect inside a dialog.)
  region.style.removeProperty('--toast-over');
  region.removeAttribute('data-at');
  if (target !== document.body) {
    const r = target.getBoundingClientRect();
    const vh = window.innerHeight;
    if (r.bottom > vh - 68) {
      if (r.top >= 68) region.style.setProperty('--toast-over', Math.round(vh - r.top + 12) + 'px');
      else region.setAttribute('data-at', 'top');
    }
  }
}

function remove(item, animate) {
  if (!item || item.gone) return;
  item.gone = true;
  clearTimeout(item.timer);
  if (current === item) current = null;
  if (animate && !prefersReducedMotion()) {
    item.el.classList.add('is-leaving');
    setTimeout(() => item.el.remove(), LEAVE_MS);
  } else {
    item.el.remove();
  }
}

function run(item) {
  clearTimeout(item.timer);
  item.started = performance.now();
  item.timer = setTimeout(() => remove(item, true), item.left);
}

function pause(item) {
  if (item.gone || item.started == null) return;
  clearTimeout(item.timer);
  item.left = Math.max(1200, item.left - (performance.now() - item.started));
  item.started = null;
}

/** Show one line at the bottom of the screen. Returns a function that dismisses it. */
export function toast(message, opts = {}) {
  const action = opts.action ? String(opts.action) : '';
  const duration = Number.isFinite(opts.duration) ? opts.duration : action ? 7000 : 4000;

  place();
  remove(current, false);

  const el = document.createElement('div');
  el.className = 'toast';
  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = String(message);
  el.appendChild(msg);

  const item = { el, timer: 0, left: duration, started: null, gone: false };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action;
    btn.addEventListener('click', () => {
      remove(item, true);
      if (typeof opts.onAction === 'function') opts.onAction();
    });
    el.appendChild(btn);
  }

  el.addEventListener('pointerenter', () => pause(item));
  el.addEventListener('pointerleave', () => { if (!item.gone && !el.contains(document.activeElement)) run(item); });
  el.addEventListener('focusin', () => pause(item));
  el.addEventListener('focusout', () => { if (!item.gone) run(item); });

  region.appendChild(el);
  current = item;
  run(item);
  return () => remove(item, true);
}

/** Remove the toast on screen, if there is one. */
export function dismissToast() {
  remove(current, true);
}
