/**
 * Rendering core for Networth. Three small pieces:
 *
 *  1. html`...`   — a tagged template that ESCAPES every interpolated value by default.
 *                   Bank descriptions and anything the owner types are untrusted text;
 *                   they can never become markup. Nest templates freely; use raw() only
 *                   for strings you built yourself.
 *  2. morph()     — updates a container to match new HTML while keeping existing DOM
 *                   nodes alive, so focus, scroll position, CSS transitions and custom
 *                   elements survive every re-render.
 *  3. actions     — declarative event handling. Markup names an action
 *                   (data-action="board.sign"); views register the handler.
 *
 * RULES FOR VIEW AUTHORS
 *  - Always quote attribute values in templates: class="${x}", never class=${x}.
 *  - Give list items a stable data-key="..." (rows of transactions, days, accounts).
 *  - A custom element that draws its own children marks itself with the attribute
 *    data-island (set it in the template). morph() then syncs its attributes only.
 *  - Host attributes belong to the template. A component must keep its own state on
 *    its child nodes, never on the host's class/style/attributes (morph resets those).
 */

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for use in HTML content or inside a quoted attribute. */
export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Mark a string as trusted markup. Only for strings assembled by code, never for data. */
export function raw(markup) {
  return new Safe(String(markup));
}

function renderValue(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) { let out = ''; for (const item of v) out += renderValue(item); return out; }
  return esc(v);
}

/**
 * Tagged template producing safe markup.
 *   html`<li class="${cls}">${merchant}</li>`
 * Interpolations: strings/numbers are escaped; html`...`/raw() results are inserted as is;
 * arrays are concatenated; null, undefined, true and false render nothing.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new Safe(out);
}

/** Class list builder: cx('row', isOn && 'is-on', { 'is-stale': stale }) -> "row is-on is-stale". */
export function cx(...args) {
  const out = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') out.push(a);
    else if (Array.isArray(a)) { const s = cx(...a); if (s) out.push(s); }
    else if (typeof a === 'object') for (const k in a) if (a[k]) out.push(k);
  }
  return out.join(' ');
}

/**
 * Attribute list builder for optional and boolean attributes.
 *   html`<input ${attrs({ type: 'checkbox', checked: isOn, disabled: locked, 'aria-label': label })}>`
 * true -> bare attribute; false/null/undefined -> omitted; everything else -> name="escaped value".
 */
export function attrs(map) {
  let out = '';
  for (const name in map) {
    const v = map[name];
    if (v == null || v === false) continue;
    out += v === true ? ' ' + name : ' ' + name + '="' + esc(v) + '"';
  }
  return new Safe(out);
}

/** when(cond, a, b) — small ternary helper that reads well inside templates. */
export function when(cond, a, b = '') {
  return cond ? (typeof a === 'function' ? a() : a) : (typeof b === 'function' ? b() : b);
}

/* ------------------------------------------------------------------ morph */

function keyOf(node) {
  return node.nodeType === 1 ? (node.getAttribute('data-key') || node.id || null) : null;
}

function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
}

function syncAttributes(oldEl, newEl) {
  const isDetails = oldEl.nodeName === 'DETAILS';
  const oldAttrs = oldEl.attributes;
  for (let i = oldAttrs.length - 1; i >= 0; i--) {
    const name = oldAttrs[i].name;
    if (newEl.hasAttribute(name)) continue;
    if (name === 'data-island') continue;
    if (name === 'open' && isDetails) continue;
    oldEl.removeAttribute(name);
    if (name === 'checked') oldEl.checked = false;
    else if (name === 'selected') oldEl.selected = false;
    else if (name === 'value' && 'value' in oldEl && oldEl.nodeName !== 'OPTION') oldEl.value = '';
  }
  const newAttrs = newEl.attributes;
  for (let i = 0; i < newAttrs.length; i++) {
    const { name, value } = newAttrs[i];
    if (name === 'open' && isDetails) continue; // <details> stays as the owner left it
    if (oldEl.getAttribute(name) === value) continue;
    oldEl.setAttribute(name, value);
    if (name === 'value' && 'value' in oldEl && oldEl.value !== value) oldEl.value = value;
    else if (name === 'checked') oldEl.checked = true;
    else if (name === 'selected') oldEl.selected = true;
  }
}

function morphNode(oldNode, newNode) {
  if (oldNode.nodeType !== 1) {
    if (oldNode.data !== newNode.data) oldNode.data = newNode.data;
    return;
  }
  const wasIsland = oldNode.hasAttribute('data-island');
  syncAttributes(oldNode, newNode);
  if (wasIsland || newNode.hasAttribute('data-island')) return;
  if (oldNode.nodeName === 'TEXTAREA') {
    if (oldNode.defaultValue !== newNode.defaultValue) {
      oldNode.defaultValue = newNode.defaultValue;
      if (document.activeElement !== oldNode) oldNode.value = newNode.defaultValue;
    }
    return;
  }
  morphChildren(oldNode, newNode);
}

function morphChildren(oldParent, newParent) {
  let keyed = null;
  for (let c = oldParent.firstChild; c; c = c.nextSibling) {
    const k = keyOf(c);
    if (k) (keyed || (keyed = new Map())).set(k, c);
  }
  let oldChild = oldParent.firstChild;
  let newChild = newParent.firstChild;
  while (newChild) {
    const nextNew = newChild.nextSibling;
    const key = keyOf(newChild);
    let match = null;
    if (key) {
      const candidate = keyed && keyed.get(key);
      if (candidate && candidate.nodeName === newChild.nodeName) { match = candidate; keyed.delete(key); }
    } else if (oldChild && sameKind(oldChild, newChild)) {
      match = oldChild;
    }
    if (match) {
      if (match === oldChild) oldChild = oldChild.nextSibling;
      else oldParent.insertBefore(match, oldChild);
      morphNode(match, newChild);
    } else {
      oldParent.insertBefore(newChild, oldChild);
    }
    newChild = nextNew;
  }
  while (oldChild) {
    const next = oldChild.nextSibling;
    oldParent.removeChild(oldChild);
    oldChild = next;
  }
}

/**
 * Make `container`'s children match `markup` (an html`` result or string), reusing nodes.
 * Matching: elements with data-key (or id) are matched by key among siblings; everything
 * else by position and tag name.
 */
export function morph(container, markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(markup);
  morphChildren(container, tpl.content);
}

/* ---------------------------------------------------------------- actions */

const handlers = new Map();

/**
 * Register action handlers. Names are global; prefix with the view name: 'board.sign'.
 * A handler receives one object:
 *   { el, ev, data, values }
 *   el     — the element carrying the data-* attribute (button, form, input)
 *   ev     — the DOM event
 *   data   — el.dataset (strings)
 *   values — for data-submit forms: an object of the form's named fields
 */
export function registerActions(map) {
  for (const name in map) {
    if (handlers.has(name) && handlers.get(name) !== map[name]) console.warn('[actions] replacing handler', name);
    handlers.set(name, map[name]);
  }
}

function run(name, payload) {
  const fn = handlers.get(name);
  if (!fn) { console.warn('[actions] no handler for', name); return; }
  try {
    fn(payload);
  } catch (err) {
    console.error('[actions] ' + name + ' failed', err);
  }
}

function formValues(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * Wire declarative events inside `root` (call once on the app root):
 *   data-action="name"   click (buttons, links, any element)
 *   data-submit="name"   submit on a <form> (default prevented; values collected)
 *   data-input="name"    input event (live read-outs while typing)
 *   data-change="name"   change event (selects, checkboxes, date inputs)
 */
export function bindActions(root) {
  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    if (el.nodeName === 'A' && !el.hasAttribute('data-follow')) ev.preventDefault();
    run(el.dataset.action, { el, ev, data: el.dataset, values: null });
  });
  root.addEventListener('submit', (ev) => {
    const form = ev.target.closest('form[data-submit]');
    if (!form) return;
    ev.preventDefault();
    run(form.dataset.submit, { el: form, ev, data: form.dataset, values: formValues(form) });
  });
  root.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-input]');
    if (!el) return;
    run(el.dataset.input, { el, ev, data: el.dataset, values: el.form ? formValues(el.form) : null });
  });
  root.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-change]');
    if (!el) return;
    run(el.dataset.change, { el, ev, data: el.dataset, values: el.form ? formValues(el.form) : null });
  });
}

/* ------------------------------------------------------------------ misc */

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Define a custom element once (safe to call again after hot reloads). */
export function define(name, ctor) {
  if (!customElements.get(name)) customElements.define(name, ctor);
}
