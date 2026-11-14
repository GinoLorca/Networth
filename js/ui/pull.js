/**
 * Pull down to refresh, by touch, for the installed app (it has no address bar and no browser
 * pull-to-refresh). Styles: css/ui.css (.pull).
 *
 * PUBLIC CONTRACT
 *
 *   installPull({ enabled, onRefresh })
 *       enabled    () => boolean   may a pull begin now (the shell: standalone, no sheet open)
 *       onRefresh  () => Promise<string>   runs the refresh; resolves to a short result for the label
 *
 *   Behaviour
 *     - A pull begins only when the page is scrolled to its very top, `enabled()` says yes, and the touch
 *       began on the page itself: not inside a dialog, a form field, a chart, a split bar or a horizontal
 *       scroller. One finger only.
 *     - The first 10px decide: sideways or upwards and the gesture is not a pull (the page scrolls, the
 *       scroller swipes, a tap stays a tap); downwards and it is, and only then is the touch's default
 *       (the page's own bounce) held back.
 *     - A hairline and a label in small capitals follow the finger with resistance, over the page (fixed;
 *       nothing below moves). "Pull to refresh" -> past TRIGGER_PX of finger travel "Release to refresh"
 *       -> released: "Refreshing…" -> the result, then it springs back. Released short of it: it springs back.
 *     - A second finger landing during a pull ends it: the indicator springs back and nothing refreshes.
 *     - The page's own rubber-band bounce is turned off while the pull is installed (html.pull-ready), so
 *       the page never moves under the indicator.
 *     - prefers-reduced-motion: nothing moves; only the label shows.
 */

export const TRIGGER_PX = 72;
const DECIDE_PX = 10;
const MAX_SHOW_PX = 64;
const RESULT_MS = 1800;

let el = null;
let label = null;
let line = null;

function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function atTop() {
  const se = document.scrollingElement || document.documentElement;
  return (se.scrollTop || 0) <= 0 && (window.scrollY || 0) <= 0;
}

/** Inside something that has its own gesture or its own meaning for a touch. */
function excluded(target) {
  if (!(target instanceof Element)) return true;
  if (target.closest('dialog, [role="dialog"], input, textarea, select, [contenteditable], nw-chart, nw-split, [data-no-pull], .toast-region')) return true;
  for (let n = target; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

function mount() {
  if (el) return;
  el = document.createElement('div');
  el.className = 'pull';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<i class="pull-line"></i><span class="pull-label lab"></span>';
  line = el.querySelector('.pull-line');
  label = el.querySelector('.pull-label');
  document.body.appendChild(el);
}

/** Resistance: the indicator moves less and less the further the finger goes. */
function shown(dy) {
  return MAX_SHOW_PX * (1 - Math.exp(-Math.max(0, dy) / 90));
}

function draw(state, dy, text) {
  mount();
  el.setAttribute('data-state', state);
  const still = reducedMotion();
  el.toggleAttribute('data-still', still);
  const progress = Math.min(1, Math.max(0, dy) / TRIGGER_PX);
  el.style.setProperty('--pull-y', (still ? 0 : shown(dy)).toFixed(1) + 'px');
  el.style.setProperty('--pull-p', String(state === 'idle' ? 0 : state === 'pulling' ? progress : 1));
  label.textContent = text;
}

/** @param {{ enabled: () => boolean, onRefresh: () => Promise<string> }} opts */
export function installPull(opts) {
  // the installed app's own rubber-band bounce is turned off, so only the indicator moves under the finger (the
  // first 10px of a touch are not ours to prevent yet); ordinary scrolling is unchanged
  document.documentElement.classList.add('pull-ready');
  let start = null; // { x, y, id }
  let mode = 'none'; // none | undecided | pulling | refreshing
  let dy = 0;

  const reset = () => {
    start = null;
    if (mode !== 'refreshing') { mode = 'none'; dy = 0; draw('idle', 0, ''); }
  };

  document.addEventListener('touchstart', (ev) => {
    if (mode === 'refreshing') return;
    // a second finger landing mid-pull ends the pull: the indicator goes back, nothing refreshes
    if (mode === 'pulling') draw('idle', 0, '');
    start = null;
    mode = 'none';
    dy = 0;
    if (ev.touches.length !== 1 || !opts.enabled() || !atTop() || excluded(ev.target)) return;
    const t = ev.touches[0];
    start = { x: t.clientX, y: t.clientY, id: t.identifier };
    mode = 'undecided';
    dy = 0;
  }, { passive: true });

  document.addEventListener('touchmove', (ev) => {
    if (!start || (mode !== 'undecided' && mode !== 'pulling')) return;
    if (ev.touches.length !== 1) { reset(); return; }
    const t = ev.touches[0];
    const dx = t.clientX - start.x;
    const y = t.clientY - start.y;
    if (mode === 'undecided') {
      if (Math.abs(dx) < DECIDE_PX && Math.abs(y) < DECIDE_PX) return;
      if (y <= 0 || Math.abs(dx) >= Math.abs(y) || !atTop()) { start = null; mode = 'none'; return; }
      mode = 'pulling';
    }
    dy = Math.max(0, y);
    if (ev.cancelable) ev.preventDefault(); // the pull is ours: no bounce, no scroll under it
    draw('pulling', dy, dy >= TRIGGER_PX ? 'Release to refresh' : 'Pull to refresh');
  }, { passive: false });

  const end = async (ev) => {
    if (mode !== 'pulling') { if (mode === 'undecided') { start = null; mode = 'none'; } return; }
    const go = ev.type === 'touchend' && dy >= TRIGGER_PX;
    start = null;
    if (!go) { mode = 'none'; draw('idle', 0, ''); return; }
    mode = 'refreshing';
    draw('refreshing', TRIGGER_PX, 'Refreshing…');
    let result = '';
    try { result = await opts.onRefresh(); } catch { result = ''; }
    if (result) {
      draw('done', TRIGGER_PX, result);
      await new Promise((r) => { setTimeout(r, RESULT_MS); });
    }
    mode = 'none';
    dy = 0;
    draw('idle', 0, label ? label.textContent : '');
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}
