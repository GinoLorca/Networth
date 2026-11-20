/**
 * Money in, pass 3: an invented record for the tests of model/inlets.js (tests/inlets.test.js). A checking account and a
 * card at the bank, deposits of invented payers, one reporting app with two invented payers (one paid in cash), and a
 * device as the app runs it (the store's update with its Undo copies, the `past` path and the restore hook). Every name,
 * payer and figure is invented.
 */

import { defaultState, makeAccount, makeTx } from '../../js/model/schema.js';
import { addDays, gameDay } from '../../js/model/dates.js';
import { refresh } from '../../js/model/detect.js';
import { applyIncomeReading, INCOME_FORMAT } from '../../js/model/income.js';
import { restampFlows } from '../../js/model/flowsection.js';
import { restampCorrections } from '../../js/model/corrections.js';
import { roundShared } from '../../js/model/share.js';

export const at = (y, m, d, hour = 12) => new Date(y, m - 1, d, hour).getTime();
export const NOW = at(2026, 11, 16);
export const TODAY = gameDay(NOW, 4);
export const MIN = 60000;

let seq = 0;

/** A record with a checking account and a card at the bank, its rows from `first` on. */
export function bankRecord() {
  const s = defaultState(at(2026, 1, 1));
  s.meta.origin = 'bank';
  s.accounts.push(makeAccount({ id: 'acc_chk', source: 'bank', type: 'checking', name: 'Everyday', balance: 500000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'ext-chk-1', conn: 'c1' } }));
  s.accounts.push(makeAccount({ id: 'acc_card', source: 'bank', type: 'credit_card', name: 'Card', balance: -1000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'ext-card-1', conn: 'c1' } }));
  s.accounts.push(makeAccount({ id: 'acc_sav', source: 'bank', type: 'savings', name: 'Savings', balance: 1000, asOf: NOW, basis: 'bank', ext: { src: 'simplefin', id: 'ext-sav-1', conn: 'c1' } }));
  return s;
}

/** One row as the bank reports it (signed cents: money in is positive). */
export function row(s, day, cents, raw, opts = {}) {
  seq += 1;
  const account = opts.account || 'acc_chk';
  const tx = makeTx({
    id: opts.id || 'tx_i' + seq, source: 'bank', accountId: account, day, postedDay: day, amount: Math.abs(cents), flow: cents > 0 ? 'in' : 'out', raw,
    fp: account + '|' + day + '|' + cents + '|' + raw.toLowerCase() + '|0', ext: { id: opts.ext || 'ext-' + account + '-' + raw + '-' + day + '-' + cents + (opts.n ? '-' + opts.n : '') }, loggedAt: at(2026, 1, 1),
    pending: !!opts.pending,
  });
  s.txs.push(tx);
  return tx;
}

/** Every `every` days from `from` to `to`. */
export function every(from, to, step) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, step)) out.push(d);
  return out;
}

/** The invented payers. */
export const PAYROLL = 'NORTHWIND TOOLING PAYROLL PPD ID: 4455';
export const ZELLE_A = 'Zelle payment from ROBIN VALE 77812';
export const ZELLE_B = 'Zelle payment from KAI MORROW 77813';
export const CHEQUE = 'MOBILE CHECK DEPOSIT';
export const INTEREST = 'INTEREST PAID';

/** The reporting app 'sessions' (income/sessions.json): payments of two invented payers. */
export function reportIn(s, items, nowMs = NOW, what = 'Sitting') {
  const text = JSON.stringify({ format: INCOME_FORMAT, what, writtenAt: new Date(nowMs).toISOString(),
    payers: [{ id: 'p-lark', name: 'Lark Fenn' }, { id: 'p-rook', name: 'Rook Abara' }], items });
  return applyIncomeReading(s, { listed: [{ source: 'sessions', sha: 'sha-' + items.length }], files: { sessions: { sha: 'sha-' + items.length, text } } }, nowMs);
}

/** A payment the app reports: paid on `day`, marked at noon that day. */
export function item(id, payer, cents, day) {
  return { id, payer, cents, day, at: new Date(day + 'T12:00:00Z').toISOString() };
}

/** A transport that holds one file in memory. */
export function memory() {
  const t = { text: null, sha: null, writes: 0 };
  t.read = async () => ({ text: t.text, sha: t.sha });
  t.write = async (body) => { t.writes += 1; t.text = body; t.sha = 's' + t.writes; return {}; };
  return t;
}

/** A device as the app runs it: the store's update with its Undo copies and the `past` path, and the restore hook. */
export function deviceOf(state, clock) {
  const undo = [];
  const d = {
    state,
    clock,
    update(fn, opts = {}) {
      if (opts.undo) undo.push(JSON.stringify(d.state));
      if (typeof opts.past === 'function') {
        for (let i = 0; i < undo.length; i++) {
          const copy = JSON.parse(undo[i]);
          opts.past(copy);
          undo[i] = JSON.stringify(copy);
        }
      }
      fn(d.state);
    },
    undo() {
      const json = undo.pop();
      if (!json) return false;
      const before = d.state;
      d.state = JSON.parse(json);
      // as the app's restore hook does (app.js): restamps only, no run of detection
      restampCorrections(before, d.state);
      restampFlows(before, d.state, d.clock());
      return true;
    },
    round(repo) {
      return roundShared({ state: () => d.state, stale: () => false, update: (now, past) => d.update(now, { past }) }, repo, d.clock);
    },
  };
  return d;
}

export async function settle(devices, repo) {
  for (let pass = 0; pass < 2; pass++) for (const d of devices) await d.round(repo);
}

export { refresh };
