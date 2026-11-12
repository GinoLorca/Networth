/**
 * The sheet host — one native <dialog> that every sheet of the app is shown in.
 * A bottom sheet on phones (full width, ruled top edge, a short grab line), a centred ruled column
 * on wide screens. Styles: css/ui.css.
 *
 * PUBLIC CONTRACT
 *
 *   mountSheet(container) -> HTMLDialogElement
 *       Creates the dialog once and appends it to `container`; later calls return the same dialog.
 *       Give it an element of its own inside the app root (so bindActions(root) sees clicks inside
 *       the sheet) that is never the target of a morph(). If showSheet() is called before
 *       mountSheet(), the dialog is mounted on document.body.
 *
 *   showSheet(markup, opts?)
 *       markup  an html`` result (or string) for the content. It is applied with dom.morph(), so
 *               calling showSheet() again while the sheet is open re-renders in place: focus, caret,
 *               typed values and scroll position survive.
 *       opts    { label?: string   accessible name of the dialog (aria-label). When the label differs
 *                                  from the one showing, the content is treated as a different sheet
 *                                  and scrolls back to the top.
 *                 wide?: boolean   wide screens only: an 880px column instead of 560px }
 *       Opens the dialog modally when it is not open. Focus goes to the first element in the markup
 *       that carries the `autofocus` attribute, otherwise to the sheet itself (Tab then enters the
 *       content) — so a phone keyboard never opens unless the content asks for it.
 *
 *   hideSheet()       Closes it (a short slide/fade out unless reduced motion), empties the content and
 *                     lets the browser return focus to the element that had it before the sheet opened.
 *                     Safe to call when no sheet is open.
 *   isSheetOpen()     -> boolean (false from the moment hideSheet() is called).
 *
 *   Event  "sheet-dismiss"  (bubbles, cancelable) dispatched on the CONTAINER when the owner asks to
 *       leave: detail.reason is 'escape' (Escape key or the system back gesture), 'backdrop' (a click
 *       outside the sheet), 'close' (the Close button) or 'swipe' (the grab line pulled down).
 *       The sheet never closes itself on these — the router decides and calls hideSheet().
 *       One exception the platform imposes: a browser may force a modal dialog shut (a second system
 *       back gesture). The event is then sent with detail.reason 'native' after the fact and
 *       isSheetOpen() is already false; treat it like any other dismissal.
 *
 *   Markup conventions inside a sheet (the content is the view's; these are the only hooks)
 *     .sheet-actions   put it last in the markup: it stays pinned to the bottom edge while the content
 *                      scrolls, on phones and on wide screens (paper background, hairline above, full
 *                      bleed, safe-area padding below). Its children are laid out in equal columns
 *                      unless a design-system rule says otherwise.
 *     .sheet-close     optional: a Close button of the content's own (any element with this class or
 *                      the attribute data-sheet-close). The host then hides its built-in Close and a
 *                      click on yours dispatches "sheet-dismiss" (reason 'close') — unless yours carries
 *                      data-action, in which case the action is all that runs.
 *     --sheet-pad      the sheet's side padding as a custom property (18px on phones, 28px on wide
 *                      screens), for full-bleed rules: margin-inline: calc(-1 * var(--sheet-pad)).
 *     The built-in Close sits in the top right corner, over the first line of the content: keep the
 *     first line short (a label), or leave 72px free on its right.
 *
 *   Structure created (all host classes are scoped to dialog.sheet, so content may use any class names,
 *   including .sheet-body, .sheet-head and .sheet-title):
 *     dialog.sheet[data-wide] > .sheet-frame > (.sheet-grab, .sheet-scroll, button.sheet-x)
 *   The content is morphed into .sheet-scroll, which is the element that scrolls.
 *   While a sheet is open the page behind does not scroll (css: html:has(dialog.sheet[open])).
 */
import { morph, prefersReducedMotion } from './dom.js';

const CLOSE_MS = 200;
const SWIPE_PX = 72;

let dialog = null;
let host = null;
let frame = null;
let body = null;
let open = false;
let closeTimer = 0;
let shownLabel = null;

function dismiss(reason) {
  if (!host) return;
  host.dispatchEvent(new CustomEvent('sheet-dismiss', { bubbles: true, cancelable: true, detail: { reason } }));
}

function finishClose() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
  dialog.removeAttribute('data-closing');
  dialog.style.transform = '';
  if (dialog.open) dialog.close();
  body.textContent = '';
  shownLabel = null;
}

function wireGrab(grab) {
  let startY = null;
  let dy = 0;
  grab.addEventListener('pointerdown', (ev) => {
    startY = ev.clientY;
    dy = 0;
    if (grab.setPointerCapture) grab.setPointerCapture(ev.pointerId);
  });
  grab.addEventListener('pointermove', (ev) => {
    if (startY == null) return;
    dy = Math.max(0, ev.clientY - startY);
    dialog.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    const pulled = dy >= SWIPE_PX;
    dy = 0;
    if (!pulled) { dialog.style.transform = ''; return; }
    dismiss('swipe');
    // The router may answer a moment later (a hash change); if it kept the sheet, settle back.
    setTimeout(() => { if (open) dialog.style.transform = ''; }, 120);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}

/** Create the dialog (once) inside `container`. */
export function mountSheet(container) {
  if (dialog) return dialog;
  host = container || document.body;
  dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.innerHTML =
    '<div class="sheet-frame" tabindex="-1">' +
    '<div class="sheet-grab" aria-hidden="true"></div>' +
    '<div class="sheet-scroll"></div>' +
    '<button class="sheet-x" type="button">Close</button>' +
    '</div>';
  frame = dialog.firstChild;
  body = frame.querySelector('.sheet-scroll');
  wireGrab(frame.querySelector('.sheet-grab'));

  frame.querySelector('.sheet-x').addEventListener('click', () => dismiss('close'));
  // A Close button that belongs to the content (see the header): same event, unless it names an action.
  body.addEventListener('click', (ev) => {
    const el = ev.target.closest('.sheet-close, [data-sheet-close]');
    if (!el || !body.contains(el) || el.hasAttribute('data-action') || el.disabled) return;
    dismiss('close');
  });

  // Escape: handled on keydown so the browser never starts closing the dialog by itself.
  dialog.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing) return;
    ev.preventDefault();
    dismiss('escape');
  });
  // The system back gesture (and Escape where keydown did not reach us) arrives as "cancel".
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    dismiss('escape');
  });
  // A click on the backdrop: the pointer went down and came up outside the sheet's box.
  let downOutside = false;
  const outside = (ev) => {
    const r = dialog.getBoundingClientRect();
    return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
  };
  dialog.addEventListener('pointerdown', (ev) => { downOutside = ev.target === dialog && outside(ev); });
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog && downOutside && outside(ev)) dismiss('backdrop');
    downOutside = false;
  });
  // Forced shut by the browser: tell the router so the address follows.
  dialog.addEventListener('close', () => {
    if (!open || dialog.open) return;
    open = false;
    finishClose();
    dismiss('native');
  });

  host.appendChild(dialog);
  return dialog;
}

/** Fill the sheet and open it (or re-render it in place when it is already open). */
export function showSheet(markup, opts = {}) {
  if (!dialog) mountSheet(document.body);
  const label = opts.label || null;
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
  dialog.removeAttribute('data-closing');

  morph(body, markup);

  if (label) dialog.setAttribute('aria-label', label);
  else dialog.removeAttribute('aria-label');
  dialog.toggleAttribute('data-wide', !!opts.wide);

  const fresh = !dialog.open;
  if (fresh || label !== shownLabel) body.scrollTop = 0;
  shownLabel = label;

  if (fresh) {
    // The dialog focuses its first [autofocus] descendant; give that to the frame unless the content asks for it.
    frame.toggleAttribute('autofocus', !body.querySelector('[autofocus]'));
    dialog.style.transform = '';
    dialog.showModal();
  }
  open = true;
}

/** Close the sheet. Safe to call when it is not open. */
export function hideSheet() {
  if (!dialog || !open) return;
  open = false;
  // A toast shown above the open sheet lives inside the dialog (toast.js); it must not leave with it.
  for (const el of dialog.querySelectorAll(':scope > .toast-region')) document.body.appendChild(el);
  if (!dialog.open || prefersReducedMotion()) { finishClose(); return; }
  dialog.setAttribute('data-closing', '');
  closeTimer = setTimeout(finishClose, CLOSE_MS);
}

export function isSheetOpen() {
  return open;
}
