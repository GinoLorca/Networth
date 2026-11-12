/**
 * What every view can reach without importing the app shell (which imports the views):
 * the context of the current render, and a few app services.
 *
 * The context (`ctx`) handed to every view's render function, and available to action
 * handlers through context():
 *
 *   ctx.state     the document (model/schema.js). Read it; change it only through store.update().
 *   ctx.ui        ephemeral interface state (store.ui): filters, drafts.
 *   ctx.now       timestamp of this render (ms). Pass it to every engine call.
 *   ctx.today     today's game day, 'YYYY-MM-DD'.
 *   ctx.route     { view, segs, params, sheet } from the router.
 *   ctx.d         derived data for this render, computed lazily and once (see derive.js).
 *   ctx.demo      true while showing the sample game (nothing is saved, nothing syncs).
 *   ctx.sync      the bank link: { linked, busy, step, status, lastOk, error, problems, canRefresh, waitMs }.
 *   ctx.wide      true when the viewport is at least 900px wide (layout decisions belong in CSS; use this
 *                 only when the markup itself must differ).
 */

let current = null;

const services = {
  toast() {},
  rerender() {},
};

/** Called by the app shell at the start of every render. */
export function setContext(ctx) {
  current = ctx;
}

/** The context of the most recent render. Action handlers call this to read state and derived data. */
export function context() {
  return current;
}

/** Called once by the app shell to install the services below. */
export function setServices(impl) {
  Object.assign(services, impl);
}

/**
 * Show one line at the bottom of the screen.
 * @param {string} message
 * @param {{ action?: string, onAction?: () => void, duration?: number }} [opts]
 */
export function toast(message, opts) {
  services.toast(message, opts);
}

/** Ask for a re-render without changing any state (rarely needed). */
export function rerender() {
  services.rerender();
}
