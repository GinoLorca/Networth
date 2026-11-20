/**
 * The property fuzz of PAYDAYS section 8, as step 3 ships it (PAYDAYS (a) to (e) without its section 4: NOTES-3 "The split
 * (after round 9)"). Random invented records (30 to 400 days, some over two years; payrolls of every cadence with raises,
 * stops and late starts, split payrolls, paychecks replaced on their payday and payrolls paid by the hour, bonuses,
 * corrections and refunds worded as the payroll, benefits a built-in rule files to Windfalls, reporting-app payers paid by
 * Zelle 0 to 5 days late, some waiting and some in cash, cash-outs and cheques fixed or varying by up to half, payouts,
 * Zelle and payment-app clients, interest, one-off deposits; for some, a second device 60 to 120 days shallower on the
 * same floor), then 10 to 20 random owner actions each (queue taps to sources of every kind, Windfalls and Leave it; This
 * deposit only, All from this payer or app; a source's kind, a removal, an accrue lock, Undo, a sharing round, a deposit
 * moved between rows). After every action, at 30, 90 and 365 days:
 * - I1: whenever the pay set is f414276's on the same record, In and out is f414276's own inAndOut (its `js/` from `git
 *   archive f414276`), the whole result deep-equal; otherwise it is f414276's arithmetic (a payday a day with a bank
 *   deposit linked to a pay stream, like with like stream by stream) on the pay set of PAYDAYS (b), written apart here;
 * - I2: the rows and Not yet filed add up to All earned, and All earned and Windfalls to In and out's Money in;
 * - I4: All earned's change + Windfalls' change = In and out's change, except beyond the queue with deposits filed to
 *   Windfalls one at a time, where All earned reads "—" (round 11, D6);
 * - Windfalls' change: its money's change less the like with like of the pay streams a built-in rule files there, over all
 *   their deposits wherever filed (round 11); beyond the queue its deposits filed one at a time are left out;
 * - I5: every Steady pay row's change is the oracle's arithmetic on its own rows (beyond the queue, its deposits filed
 *   one at a time left out; none left: no change), and a row holding exactly one stream reads In and out's figure for it;
 * - I6: a deposit moved between two rows that compare, the pay set unchanged, moves those two by its cents and nothing
 *   else; All earned and Windfalls move by its cents when it crosses between them; a payday moved out of a Steady row
 *   counts once more in other rows;
 * - I7: the streams that are no pay are the oracle's (the app's say by half, the payer's, a catch-all key's own deposits
 *   by at least two and a majority, per key and account); one filing on its own never changes pay; a lock wins; Undo
 *   puts the pay back;
 * - two devices of one floor read the same figures after a round, when their detection agrees;
 * - detection: with nothing filed, every stream reads as f414276's detection reads it (detect.js is f414276's but the
 *   pay fix's one condition, which nothing filed never meets).
 * The counts of what was exercised are asserted, so the fuzz fails if it stops reaching a case. Fixed seeds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { addDays, addMonthsYm, monthOf } from '../js/model/dates.js';
import { inAndOut, windowsOf } from '../js/model/flows.js';
import { makeLedger } from '../js/model/ledger.js';
import { merchantKeyOf } from '../js/model/corrections.js';
import { floorOf, notPayKeys, storedFlows } from '../js/model/flowsection.js';
import { payeeKey } from '../js/model/byhand.js';
import {
  LEAVE, WINDFALL, acceptOffer, appKey, attribute, depositQueue, editInlet, fileDeposit, fileQueueItem, filingOf, isCatchAllIn, keysOf, latestReal,
  lookOf, makeInlet, moneyInBySource, queueFrom, suggestions,
} from '../js/model/inlets.js';
import { MIN, NOW, PAYROLL, TODAY, bankRecord, deviceOf, item, memory, refresh, reportIn, row, settle } from './helpers/inlets-fixture.mjs';

const SEEDS = Array.from({ length: 32 }, (_, k) => 11 + 18 * k);
const PERIODS = [30, 90, 365];
const KINDS = ['steady', 'job', 'backend', 'oneoff'];

/** mulberry32: a seeded draw in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ the records */

const OTHER = 'HARBOR LIGHT CAFE PAYROLL PPD ID: 7781';
const CASHOUT = 'VENMO CASHOUT PPD ID: 5264681992';
const CHEQUE = 'MOBILE CHECK DEPOSIT';
const PAYOUT = 'STRIPE TRANSFER ST-8812';
const BENEFITS = 'NYS DOL UI DD BENEFITS';
const WALLET = 'VENMO PAYMENT FROM ORLA QUINN';
const LARK = 'Zelle payment from LARK FENN 31007';
const ROOK = 'Zelle payment from ROOK ABARA 31008';
const CLIENTS = ['Zelle payment from TAMSIN OKORO 55120', 'Zelle payment from IVO MARSH 55121'];

/** A record drawn from `draw`, `depth` days deep; the same draw and a smaller depth give a shallower device of it. */
function recordOf(spec, depth, detect = refresh) {
  const s = bankRecord();
  const start = addDays(TODAY, -depth);
  const on = (d, cents, raw, opts) => { if (d >= start && d <= TODAY) row(s, d, Math.round(cents), raw, opts); };
  // payrolls
  for (const p of spec.payrolls) {
    let k = 0;
    const days = [];
    if (p.cadence === 'semimonthly') {
      for (let m = 0; m < 15; m++) for (const dom of ['01', '15']) days.push(addMonthsYm(monthOf(TODAY), -m) + '-' + dom);
    } else for (let d = addDays(TODAY, -p.latest); d >= addDays(TODAY, -420); d = addDays(d, -p.step)) days.push(d);
    for (const d of days.sort().reverse()) {
      if (d > addDays(TODAY, -p.latest) || d < addDays(TODAY, -p.first)) { k++; continue; }
      let cents = d >= p.raiseFrom ? p.cents * p.raise : p.cents;
      // round 10: a paycheck replaced (short, or with a bonus in it), or the hours of each week
      if (p.swap && Object.hasOwn(p.swap, k)) cents *= p.swap[k];
      if (p.hours) cents *= p.hours[k % p.hours.length];
      on(d, cents, p.raw);
      if (p.split) on(d, d >= p.raiseFrom ? p.split * p.splitTo : p.split, p.raw, { account: 'acc_sav', n: 1 });
      k++;
    }
  }
  for (const o of spec.odd) on(o.day, o.cents, o.raw, { n: 2 });
  if (spec.benefits) for (let d = addDays(TODAY, -2); d >= start; d = addDays(d, -14)) on(d, 45000, BENEFITS);
  for (const c of spec.catchAlls) {
    let k = 0;
    for (let d = addDays(TODAY, -c.latest); d >= start; d = addDays(d, -c.step)) on(d, c.amounts[(k++) % c.amounts.length], c.raw, c.account ? { account: c.account } : {});
  }
  for (const z of spec.clients) for (let d = addDays(TODAY, -z.latest); d >= start; d = addDays(d, -z.step)) on(d, z.cents, z.raw);
  for (const d of spec.wallet) on(d, 6000, WALLET);
  for (let d = addDays(TODAY, -5); d >= start; d = addDays(d, -30)) on(d, 37, 'INTEREST PAID', { account: 'acc_sav' });
  for (const o of spec.oneOffs) on(o.day, o.cents, o.raw);
  // reporting-app payers paid by Zelle 0 to 5 days late (a payment's deposit), some in cash (no deposit), some waiting.
  // The app's file is one for every device: its payments are drawn over the deepest record, and a device holds the
  // deposits from its own first day
  const items = [];
  for (const a of spec.app) {
    let k = 0;
    for (let d = addDays(TODAY, -a.latest); d >= addDays(TODAY, -spec.depth); d = addDays(d, -7)) {
      const id = a.payer + '-' + k++;
      if (!a.cash.includes(k)) on(addDays(d, a.lag), a.cents, a.raw, { n: k });
      // the app reports the newest weeks only when it came after the payer did (deposits from before it stay unpaired)
      if (!(a.waiting && k === 1) && !(a.preApp && k > a.preApp)) items.push(item(id, a.payer, a.cents, d));
    }
  }
  detect(s, NOW);
  if (items.length) { reportIn(s, items, NOW); detect(s, NOW); }
  return s;
}

function specOf(draw) {
  const pick = (list) => list[Math.floor(draw() * list.length)];
  const between = (a, b) => a + Math.floor(draw() * (b - a + 1));
  // most records 30 to 400 days deep; some over two years, so the year before is compared (and lies beyond the queue)
  const depth = draw() < 0.2 ? between(740, 800) : between(30, 400);
  const payrolls = [];
  const n = draw() < 0.85 ? (draw() < 0.25 ? 2 : 1) : 0;
  for (let k = 0; k < n; k++) {
    const cadence = pick(['weekly', 'biweekly', 'biweekly', 'semimonthly', 'monthly']);
    const step = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 }[cadence];
    const stop = draw() < 0.15;
    const late = draw() < 0.2;
    payrolls.push({
      raw: k ? OTHER : PAYROLL, cadence, step, cents: between(150000, 300000),
      latest: stop ? between(20, 80) : between(0, step - 1), first: late ? between(20, 90) : 999,
      raise: draw() < 0.25 ? (draw() < 0.35 ? 2 + between(10, 80) / 100 : 1 + between(5, 90) / 100) : 1, raiseFrom: addDays(TODAY, -between(10, 120)),
      split: draw() < 0.2 ? between(20000, 60000) : 0, splitTo: draw() < 0.4 ? pick([2.2, 2.6, 0.4]) : 1,
    });
  }
  const odd = [];
  // bonuses, corrections and refunds worded as the payroll, some near the band's edges (half and twice the median)
  if (payrolls.length && draw() < 0.6) {
    for (let k = between(1, 2); k > 0; k--) {
      const cents = draw() < 0.4 ? pick([500000, 15000, 8000, 300000]) : payrolls[0].cents * pick([0.04, 0.3, 0.45, 0.55, 1.9, 2.1, 2.6, 3.3]);
      odd.push({ day: addDays(TODAY, -between(3, Math.min(depth, 200))), cents, raw: payrolls[0].raw });
    }
  }
  const catchAlls = [];
  for (const raw of [CASHOUT, CHEQUE, PAYOUT]) {
    if (draw() > 0.45) continue;
    const base = between(150, 450) * 100;
    const vary = draw() < 0.5;
    const amounts = vary ? [1, 0.6, 1.4, 0.8, 1.2, 0.5, 1.5].map((x) => Math.round(base * x)) : [base];
    catchAlls.push({ raw, step: raw === PAYOUT ? 30 : pick([7, 14]), latest: between(0, 6), amounts, vary, account: raw === CASHOUT && draw() < 0.2 ? 'acc_sav' : null });
  }
  const clients = draw() < 0.5 ? [{ raw: pick(CLIENTS), step: 7, latest: between(0, 6), cents: between(80, 200) * 100 }] : [];
  const wallet = draw() < 0.3 ? [addDays(TODAY, -between(1, 60)), addDays(TODAY, -between(61, 120))] : [];
  const oneOffs = draw() < 0.5 ? [{ day: addDays(TODAY, -between(1, Math.max(1, depth - 1))), cents: between(100, 900) * 100, raw: 'Zelle payment from WEDDING PARTY 5' }] : [];
  const app = draw() < 0.45 ? [
    { payer: 'p-lark', raw: LARK, cents: 9500, latest: between(1, 6), lag: between(0, 5), cash: [3, 7], waiting: draw() < 0.5, preApp: draw() < 0.5 ? between(4, 12) : 0 },
    { payer: 'p-rook', raw: ROOK, cents: 12000, latest: between(1, 6), lag: between(0, 5), cash: [2], waiting: draw() < 0.5, preApp: draw() < 0.5 ? between(4, 12) : 0 },
  ] : [];
  return { depth, payrolls, odd, benefits: draw() < 0.25, catchAlls, clients, wallet, oneOffs, app, shallow: draw() < 0.35 ? between(60, 120) : 0 };
}

/**
 * Round 10's draws, from a draw of their own so the records of rounds 7 to 9 keep theirs: some paychecks replaced on their
 * own payday (a short one, one with a bonus or retro pay in it), and some payrolls paid by the hour (each paycheck its
 * week's hours, a slow week below half the usual). Step 3 reads them as f414276 does (their band is step 3b's).
 */
function round10(spec, draw) {
  const pick = (list) => list[Math.floor(draw() * list.length)];
  for (const p of spec.payrolls) {
    const r = draw();
    if (r < 0.45) {
      p.swap = {};
      for (let n = 1 + Math.floor(draw() * 3); n > 0; n--) p.swap[Math.floor(draw() * 13)] = pick([0.3, 0.4, 0.45, 2.2, 2.4, 3.4]);
    } else if (r < 0.65) p.hours = [1, 0.35, 1.25, 0.9, 1.5, 0.3, 1.1, 0.8, 1.6, 0.4, 1, 1.3, 0.7].slice(Math.floor(draw() * 5));
  }
  return spec;
}

/* ------------------------------------------------------------------ the oracles */

const real = (look, cell) => !!cell && !cell.deleted && (cell.v === WINDFALL || (look.inlets.has(cell.v) && !look.inlets.get(cell.v).removed));
/** The owner's say in a filing: 'not' (Windfalls, a source that is not Steady pay), 'pay' (Steady pay), or null. */
function sayOf(look, cell) {
  if (!real(look, cell)) return null;
  return cell.v === WINDFALL || look.inlets.get(cell.v).kind !== 'steady' ? 'not' : 'pay';
}

/** PAYDAYS (b), written from the rule: the keys of the streams the owner said are not pay. */
function oracleNotPay(s) {
  const look = lookOf(s);
  const floor = floorOf(s);
  const out = new Set();
  const deposits = s.txs.filter((tx) => tx.source !== 'manual' && tx.flow === 'in' && tx.kind === 'income' && !tx.pending && !tx.pairId && tx.mkey
    && !(floor && tx.day < floor));
  const payers = new Map();
  for (const tx of deposits) {
    const p = payeeKey(tx.mkey);
    if (!payers.has(p)) payers.set(p, []);
    payers.get(p).push(tx);
  }
  for (const [p, txs] of payers) {
    // 1. the app most of whose payments pair with the payer's deposits, when it holds a say and at least half are paired
    const byApp = new Map();
    for (const tx of txs) for (const key of look.paired.get(tx.id) || []) {
      const app = appKey(key.slice(0, key.indexOf('/')));
      if (!sayOf(look, look.into[app])) continue;
      if (!byApp.has(app)) byApp.set(app, new Set());
      byApp.get(app).add(tx.id);
    }
    let best = null;
    for (const [app, rows] of byApp) {
      const at = look.into[app].at;
      if (!best || rows.size > best.n || (rows.size === best.n && (at > best.at || (at === best.at && app < best.app)))) best = { app, n: rows.size, at };
    }
    let say = best && 2 * best.n >= txs.length ? sayOf(look, look.into[best.app]) : null;
    if (!say) say = sayOf(look, look.into[p]);
    if (say === 'not') out.add(p);
    if (say) continue;
    // 3. a catch-all key's own deposits, per account
    const accounts = new Map();
    for (const tx of txs) if (isCatchAllIn(tx)) { if (!accounts.has(tx.accountId)) accounts.set(tx.accountId, []); accounts.get(tx.accountId).push(tx); }
    for (const [account, rows] of accounts) {
      let filed = 0;
      let away = 0;
      for (const tx of rows) {
        const own = latestReal(look, keysOf(look, tx).own);
        if (!own) continue;
        filed++;
        if (sayOf(look, own.cell) === 'not') away++;
      }
      if (away >= 2 && away * 2 > filed) out.add(p + '|' + account);
    }
  }
  for (const key of Object.keys(look.into)) if (key[0] === 'p' && !payers.has(key) && sayOf(look, look.into[key]) === 'not') out.add(key);
  return out;
}

/**
 * f414276's like with like, stream by stream, on these rows, written apart from the code: a payday is a day with a bank
 * deposit linked to a pay stream; a stream with more paydays than in the window before, or fewer, leaves out its extra
 * count times its mean a payday (this window's, else the window before's).
 */
function likeWithLike(nowRows, beforeRows, order) {
  const group = (rows) => {
    const g = new Map();
    for (const { tx, how } of rows) {
      if (how !== 'bank' || tx.streamId == null || !order.includes(tx.streamId)) continue;
      const one = g.get(tx.streamId) || { days: new Set(), cents: 0 };
      one.days.add(tx.day);
      one.cents += Math.round(tx.amount);
      g.set(tx.streamId, one);
    }
    return g;
  };
  const a = group(nowRows);
  const b = group(beforeRows);
  const out = [];
  for (const id of order) {
    const n = a.get(id);
    const m = b.get(id);
    const now = n ? n.days.size : 0;
    const before = m ? m.days.size : 0;
    if (!now && !before) continue;
    const mean = now ? n.cents / now : m.cents / before;
    out.push({ id, now, before, left: Math.round((now - before) * mean) });
  }
  return out;
}
const sum = (rows) => rows.reduce((n, { tx }) => n + Math.round(tx.amount), 0);

/** In and out under the rule: f414276's arithmetic on the pay set of PAYDAYS (b). */
function oracleIO(s, days) {
  const L = makeLedger(s, NOW);
  const floor = floorOf(s);
  const w = windowsOf(L.today, days, floor);
  const now = L.moneyIn(w.from, w.to);
  const order = L.payStreams().map((x) => x.id);
  const out = { cents: now.total, change: null, streams: null, w, L, order };
  if (!w.comparable) return out;
  const before = L.moneyIn(w.prevFrom, w.prevTo);
  const ll = likeWithLike(now.rows, before.rows, order);
  out.change = now.total - before.total - ll.reduce((n, x) => n + x.left, 0);
  out.streams = ll.map((x) => x.id + ' ' + x.now + '/' + x.before);
  out.now = now;
  out.before = before;
  return out;
}

/* ------------------------------------------------------------------ f414276 */

async function f414276(t) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'networth-f414276-'));
    const tar = execFileSync('git', ['archive', '--format=tar', 'f414276', 'js'], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    writeFileSync(join(dir, 'old.tar'), tar);
    execFileSync('tar', ['-xf', join(dir, 'old.tar'), '-C', dir]);
    const flows = await import(pathToFileURL(join(dir, 'js', 'model', 'flows.js')).href);
    const ledger = await import(pathToFileURL(join(dir, 'js', 'model', 'ledger.js')).href);
    const detect = await import(pathToFileURL(join(dir, 'js', 'model', 'detect.js')).href);
    return { flows, ledger, detect, dir };
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    t.skip('no git, or a copy without f414276');
    return null;
  }
}

/* ------------------------------------------------------------------ the fuzz */

test('paydays fuzz (PAYDAYS section 8): In and out, the rows, All earned, Windfalls and pay under random records and owner actions', async (t) => {
  const old = await f414276(t);
  if (!old) return;
  const started = Date.now();
  const count = { actions: 0, checks: 0, payEqual: 0, payChanged: 0, endedByB3: 0, i5Rows: 0, i5Stream: 0, moves: 0, crossings: 0, elsewhere: 0,
    varying: 0, rounds: 0, devicesCompared: 0, undos: 0, locks: 0, beyond: 0, oneFilingKept: 0, adds: 0, leftOut: 0, odd: 0, detectSame: 0,
    replaced: 0, windBeyond: 0, earnedDash: 0, ruleMoved: 0 };
  const fail = (msg, ctx) => assert.fail(msg + ' — ' + JSON.stringify(ctx));
  try {
    for (const seed of SEEDS) {
      const draw = rng(seed);
      const spec = round10(specOf(draw), rng(seed * 31 + 7));
      if (spec.catchAlls.some((c) => c.vary)) count.varying++;
      if (spec.payrolls.some((p) => p.swap || p.hours)) count.replaced++;
      // detection with nothing filed, against f414276's own on the same record: every stream alike (detect.js is f414276's
      // but the pay fix's one condition, which nothing filed never meets)
      {
        const mine = recordOf(spec, spec.depth);
        const theirs = recordOf(spec, spec.depth, old.detect.refresh);
        const streamsOf = (st) => st.streams.map((x) => [x.name, x.accountId, x.cadence, x.anchor, x.amount, x.accrue, x.active, x.kind].join('|')).sort();
        if (streamsOf(mine).join('\n') !== streamsOf(theirs).join('\n')) fail('detection: as f414276\'s with nothing filed', { seed, mine: streamsOf(mine), f414276: streamsOf(theirs) });
        count.detectSame++;
      }
      const a = deviceOf(recordOf(spec, spec.depth), () => NOW);
      const devices = [a];
      const repo = memory();
      if (spec.shallow && spec.depth - spec.shallow >= 150) {
        devices.push(deviceOf(recordOf(spec, spec.depth - spec.shallow), () => NOW + MIN));
        await settle(devices, repo);
      }
      let clock = NOW + 2 * MIN;
      const tick = () => (clock += MIN);
      const sources = [];
      const label = (step, what) => 'seed ' + seed + ' step ' + step + ' (' + what + ')';
      // for about half the records, the owner's first run: every suggestion added (the payroll as Steady pay, the app as
      // By the job, a royalty payer as Back-end), so Steady pay rows hold their pay from the start
      if (draw() < 0.5) {
        for (const offer of suggestions(a.state, NOW).shown) {
          const id = 'n' + (0x3000000000000 + seed * 1000 + 900 + sources.length).toString(16).slice(-13);
          let made = null;
          a.update((st) => { made = acceptOffer(st, offer, tick(), id); }, { undo: 'add' });
          if (made) { sources.push(made); count.adds++; }
        }
      }
      const steps = 10 + Math.floor(draw() * 11);
      for (let step = 0; step < steps; step++) {
        const s = a.state;
        const look = lookOf(s);
        const payBefore = makeLedger(s, NOW).payStreams().map((x) => x.id).sort().join();
        const b3Before = [...notPayKeys(s)].filter((key) => key.includes('|')).sort().join();
        const deposits = s.txs.filter((tx) => tx.flow === 'in' && tx.kind === 'income' && !tx.pending && tx.day >= floorOf(s));
        const pickOf = (list) => list[Math.floor(draw() * list.length)];
        const target = () => {
          const r = draw();
          if (r < 0.12 || !sources.length) {
            const id = 'n' + (0x3000000000000 + seed * 1000 + step * 10 + sources.length).toString(16).slice(-13);
            const kind = pickOf(KINDS);
            a.update((st) => makeInlet(st, { name: 'Source ' + sources.length, kind }, tick(), id), { undo: 'made' });
            sources.push(id);
            return id;
          }
          if (r < 0.2) return WINDFALL;
          return pickOf(sources);
        };
        const r = draw();
        let what = '';
        let moved = null;
        let ownOnly = false;
        const payIds = new Set(makeLedger(s, NOW).payStreams().map((x) => x.id));
        const steadyPay = deposits.filter((tx) => {
          if (tx.streamId == null || tx.source === 'manual' || !payIds.has(tx.streamId)) return false;
          const f = filingOf(look, tx);
          return !!f.to && look.inlets.has(f.to) && look.inlets.get(f.to).kind === 'steady';
        });
        if (r < 0.1 && steadyPay.length) {
          // a paycheck moved on its own out of its Steady pay source (This deposit only), in the period when one is
          const recent = steadyPay.filter((tx) => tx.day >= addDays(TODAY, -29));
          const tx = pickOf(recent.length ? recent : steadyPay);
          const from = filingOf(look, tx).to;
          let to = target();
          if (to === from) to = WINDFALL;
          const pre = JSON.parse(JSON.stringify(a.state));
          what = 'payday out ' + tx.raw + ' ' + tx.day + ' to ' + to;
          ownOnly = true;
          let done = false;
          a.update((st) => { done = fileDeposit(st, tx.id, to, 'one', tick()); }, { undo: 'one' });
          if (done) moved = { tx, pre };
        } else if (r < 0.32) {
          const items = depositQueue(s, NOW).items;
          if (!items.length) continue;
          const one = pickOf(items);
          const to = draw() < 0.12 ? LEAVE : target();
          what = 'queue ' + one.kind + ' to ' + to;
          ownOnly = one.kind === 'one';
          a.update((st) => fileQueueItem(st, one, to, tick()), { undo: 'file' });
        } else if (r < 0.52) {
          if (!deposits.length) continue;
          const tx = pickOf(deposits);
          const to = target();
          const pre = JSON.parse(JSON.stringify(a.state));
          what = 'one ' + tx.raw + ' ' + tx.day + ' to ' + to;
          ownOnly = true;
          let done = false;
          a.update((st) => { done = fileDeposit(st, tx.id, to, 'one', tick()); }, { undo: 'one' });
          if (done) moved = { tx, pre };
        } else if (r < 0.62) {
          if (!deposits.length) continue;
          const tx = pickOf(deposits);
          const to = target();
          what = 'all ' + tx.raw + ' to ' + to;
          a.update((st) => fileDeposit(st, tx.id, to, 'all', tick()), { undo: 'all' });
        } else if (r < 0.7 && sources.length) {
          const id = pickOf(sources);
          const kind = pickOf(KINDS);
          what = 'kind ' + id + ' ' + kind;
          a.update((st) => editInlet(st, id, { kind }, tick()), { undo: 'kind' });
        } else if (r < 0.74 && sources.length) {
          const id = pickOf(sources);
          what = 'remove ' + id;
          a.update((st) => editInlet(st, id, { removed: true }, tick()), { undo: 'removed' });
        } else if (r < 0.8) {
          what = 'undo';
          if (!a.undo()) continue;
          count.undos++;
        } else if (r < 0.84) {
          // an accrue lock set by hand on a stream (every device: corrections travel)
          const stream = pickOf(s.streams.filter((x) => x.mkey));
          if (!stream) continue;
          what = 'lock ' + stream.name;
          for (const d of devices) for (const one of d.state.streams) if (one.mkey === stream.mkey && one.accountId === stream.accountId) { one.locks = [...new Set([...(one.locks || []), 'accrue'])]; one.accrue = true; }
          count.locks++;
        } else if (devices.length > 1) {
          what = 'round';
          await settle(devices, repo);
          count.rounds++;
        } else continue;
        count.actions++;
        const st = a.state;
        const lk = lookOf(st);
        const L = makeLedger(st, NOW);
        const payNow = L.payStreams().map((x) => x.id).sort().join();
        // I7: the streams that are no pay are the oracle's
        const want = [...oracleNotPay(st)].sort();
        const got = [...notPayKeys(st)].sort();
        if (want.join() !== got.join()) fail('I7: notPayKeys', { at: label(step, what), want, got });
        for (const stream of L.payStreams()) {
          const p = payeeKey(stream.mkey);
          const not = want.includes(p) || want.includes(p + '|' + stream.accountId);
          const locked = Array.isArray(stream.locks) && stream.locks.includes('accrue') && stream.accrue;
          if (not && !locked) fail('I7: a stream said not pay is pay', { at: label(step, what), stream: stream.name });
        }
        const b3Now = want.filter((key) => key.includes('|')).sort().join();
        if (b3Now !== b3Before && b3Now.length > b3Before.length) count.endedByB3++;
        // a filing on its own changes pay only through a catch-all key's own deposits ((b)3: the second agreeing one)
        if (ownOnly && payNow !== payBefore) {
          if (b3Now === b3Before) fail('I7: an own filing changed pay', { at: label(step, what) });
        } else if (ownOnly) count.oneFilingKept++;
        for (const days of PERIODS) {
          count.checks++;
          const io = inAndOut(st, NOW, days);
          const o = oracleIO(st, days);
          // I1: the oracle
          if (io.in.cents !== o.cents || io.in.change !== o.change) fail('I1: In and out against the oracle', { at: label(step, what), days, io: [io.in.cents, io.in.change], oracle: [o.cents, o.change] });
          if (o.streams && io.paydays.streams.map((x) => x.id + ' ' + x.now + '/' + x.before).join() !== o.streams.join()) fail('I1: the caption', { at: label(step, what), days });
          // a period holding a deposit linked to a pay stream outside half to twice its usual (a bonus, a correction, a short
          // paycheck): f414276 reads it as a payday, and so does step 3 (its band is step 3b's)
          if (o.streams && [...o.now.rows, ...o.before.rows].some(({ tx, how }) => {
            if (how !== 'bank' || tx.streamId == null || !o.order.includes(tx.streamId)) return false;
            const usual = (L.payStreams().find((x) => x.id === tx.streamId) || {}).amount;
            return usual > 0 && (tx.amount * 2 < usual || tx.amount > 2 * usual);
          })) count.odd++;
          // I1: f414276 itself, whenever its pay set is this one: the whole result, exactly
          const oldL = old.ledger.makeLedger(st, NOW);
          const oldPay = oldL.payStreams().map((x) => x.id).sort().join();
          if (oldPay === payNow) {
            const was = old.flows.inAndOut(st, NOW, days, { ledger: oldL });
            if (JSON.stringify(was) !== JSON.stringify(io)) fail('I1: f414276', { at: label(step, what), days, was: [was.in, was.paydays], now: [io.in, io.paydays] });
            count.payEqual++;
          } else count.payChanged++;
          const sec = moneyInBySource(st, NOW, days, { io });
          // I2
          const rowsCents = sec.rows.reduce((n, x) => n + x.cents, 0);
          if (rowsCents + sec.unfiled.cents !== sec.earned.cents) fail('I2: rows + Not yet filed = All earned', { at: label(step, what), days });
          if (sec.earned.cents + sec.windfalls.cents !== io.in.cents) fail('I2: All earned + Windfalls = Money in', { at: label(step, what), days });
          const shares = [...sec.rows.map((x) => x.share), sec.unfiled.share].filter((x) => x != null).reduce((n, x) => n + x, 0);
          if (sec.earned.cents > 0 && Math.abs(shares - 1) > 1e-9) fail('I3: the shares make the whole', { at: label(step, what), days, shares });
          // I4
          if (io.in.change != null && sec.earned.change != null && sec.earned.change + sec.windfalls.change !== inAndOut(st, NOW, days).in.change) fail('I4', { at: label(step, what), days });
          if (!o.w.comparable) continue;
          // I5: each Steady pay row, and the beyond-the-queue rule for Steady pay and By the job
          const an = attribute(lk, o.now.rows);
          const ab = attribute(lk, o.before.rows);
          const beyond = o.w.prevFrom < queueFrom(o.L.today, floorOf(st));
          // Windfalls' change (round 10): its money's change less a rule's pay deposits' like with like; beyond the queue
          // its deposits filed one at a time left out of both windows, as a Steady pay or By the job row's are.
          // Round 11: the like with like of a rule's pay streams reads all their deposits, wherever filed; beyond the queue,
          // with deposits filed to Windfalls one at a time in either window, All earned has no change and Windfalls "—" when
          // nothing else is left (D6)
          {
            const wk = (rows) => (beyond ? rows.filter((one) => one.filing.how !== 'deposit') : rows);
            const ruleIds = new Set([...an.windfalls.rows, ...ab.windfalls.rows].filter((one) => one.filing.how === 'rule' && one.how === 'bank' && one.tx.streamId != null && o.order.includes(one.tx.streamId)).map((one) => one.tx.streamId));
            const ofRule = (rows) => rows.filter(({ tx, how }) => how === 'bank' && ruleIds.has(tx.streamId));
            if ([...o.now.rows, ...o.before.rows].some((one) => one.how === 'bank' && ruleIds.has(one.tx.streamId) && filingOf(lk, one.tx).how !== 'rule')) count.ruleMoved++;
            const oneByOne = beyond && [...an.windfalls.rows, ...ab.windfalls.rows].some((one) => one.filing.how === 'deposit');
            const nothing = oneByOne && !wk(an.windfalls.rows).length && !wk(ab.windfalls.rows).length;
            const wantW = nothing ? null : sum(wk(an.windfalls.rows)) - sum(wk(ab.windfalls.rows))
              - likeWithLike(ofRule(o.now.rows), ofRule(o.before.rows), o.order).reduce((n, one) => n + one.left, 0);
            if (sec.windfalls.change !== wantW || !!sec.windfalls.oneAtATime !== nothing) fail('Windfalls\' change', { at: label(step, what), days, got: sec.windfalls.change, want: wantW });
            if (oneByOne) {
              count.windBeyond++;
              if (sec.earned.change !== null || !sec.earned.oneAtATime) fail('D6: All earned beyond the queue, Windfalls filed one at a time', { at: label(step, what), days, got: sec.earned.change });
              count.earnedDash++;
            } else if (io.in.change != null && sec.earned.change !== io.in.change - sec.windfalls.change) fail('All earned = In and out less Windfalls', { at: label(step, what), days });
          }
          for (const x of sec.rows) {
            if (x.kind !== 'steady' && x.kind !== 'job') continue;
            const keep = (rows) => (beyond ? rows.filter((one) => one.filing.how !== 'deposit') : rows);
            const all = { now: (an.sources.get(x.id) || { rows: [] }).rows, before: (ab.sources.get(x.id) || { rows: [] }).rows };
            const hn = keep(all.now);
            const hb = keep(all.before);
            if (beyond && !hn.length && !hb.length && all.now.length + all.before.length > 0) {
              count.beyond++;
              if (x.change !== null || !x.oneAtATime) fail('beyond the queue: "—"', { at: label(step, what), days, row: x.name });
              continue;
            }
            // beyond the queue, a row that compares what is left counts the deposits it left out, for its caption
            const leftOut = beyond ? all.now.length - hn.length + all.before.length - hb.length : 0;
            if (x.leftOneAtATime !== leftOut) fail('beyond the queue: what a row left out', { at: label(step, what), days, row: x.name, got: x.leftOneAtATime, want: leftOut });
            if (leftOut) count.leftOut++;
            const ll = x.kind === 'steady' ? likeWithLike(hn, hb, o.order) : [];
            const want5 = sum(hn) - sum(hb) - ll.reduce((n, one) => n + one.left, 0);
            if (x.change !== want5) fail('I5: a row\'s change', { at: label(step, what), days, row: x.name, kind: x.kind, got: x.change, want: want5 });
            if (x.kind === 'steady') count.i5Rows++;
            // a row holding exactly one pay stream's bank deposits, all of them, and nothing else: In and out's figure
            if (x.kind === 'steady' && !beyond) {
              const ids = new Set([...hn, ...hb].map((one) => one.tx.streamId));
              const id = [...ids][0];
              const of = (rows) => rows.filter((one) => one.how === 'bank' && one.tx.streamId === id);
              if (ids.size === 1 && id != null && o.order.includes(id) && [...hn, ...hb].every((one) => one.how === 'bank')
                && of(o.now.rows).length === hn.length && of(o.before.rows).length === hb.length) {
                const one = io.paydays.streams.find((z) => z.id === id);
                const money = sum(of(o.now.rows)) - sum(of(o.before.rows));
                if (x.change !== money - (one ? one.left : 0)) fail('I5: one stream\'s row reads In and out', { at: label(step, what), days });
                count.i5Stream++;
              }
            }
          }
        }
        // I6: a deposit moved on its own, the pay set unchanged (30 and 90 days; the year beyond the queue reads apart)
        if (moved && payNow === payBefore) checkMove(moved, st, count, label(step, what), fail);
        // devices of one floor read alike after a round, when their detection agrees
        if (what === 'round') {
          for (const days of PERIODS) {
            const read = (d) => {
              const io = inAndOut(d.state, NOW + 3 * MIN, days);
              const sec = moneyInBySource(d.state, NOW + 3 * MIN, days, { io });
              return { pay: makeLedger(d.state, NOW + 3 * MIN).payStreams().map((x) => x.name + '|' + x.accountId).sort(), in: [io.in.cents, io.in.change],
                caption: io.paydays.streams.map((x) => x.name + ' ' + x.now + '/' + x.before), rows: sec.rows.map((x) => x.id + ' ' + x.cents + ' ' + x.change), earned: [sec.earned.cents, sec.earned.change] };
            };
            const ra = read(devices[0]);
            const rb = read(devices[1]);
            if (ra.pay.join() !== rb.pay.join()) continue;
            count.devicesCompared++;
            assert.deepEqual(rb, ra, label(step, what) + ': two devices at ' + days + ' days');
          }
        }
      }
    }
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
  }
  const ms = Date.now() - started;
  t.diagnostic(JSON.stringify({ ...count, ms }));
  // what the fuzz must keep reaching
  assert.ok(count.actions >= 150, 'actions: ' + count.actions);
  assert.ok(count.payEqual >= 100, 'periods compared with f414276 itself: ' + count.payEqual);
  assert.ok(count.payChanged >= 10, 'periods with a pay set the owner changed: ' + count.payChanged);
  assert.ok(count.endedByB3 >= 3, 'streams ended by a catch-all\'s own deposits: ' + count.endedByB3);
  assert.ok(count.i5Rows >= 100, 'Steady pay rows read by the oracle: ' + count.i5Rows);
  assert.ok(count.moves >= 30 && count.crossings >= 8, 'deposits moved, and across Windfalls: ' + count.moves + ', ' + count.crossings);
  assert.ok(count.varying >= 3, 'records with a varying catch-all stream: ' + count.varying);
  assert.ok(count.odd >= 50, 'periods holding a linked deposit outside half to twice its usual, read as f414276 reads it: ' + count.odd);
  assert.ok(count.replaced >= 8 && count.detectSame >= 32, 'records with payrolls replaced or by the hour, and records detected as f414276: ' + count.replaced + ', ' + count.detectSame);
  assert.ok(count.rounds >= 3 && count.devicesCompared >= 3, 'rounds and devices compared: ' + count.rounds + ', ' + count.devicesCompared);
  assert.ok(count.beyond >= 3, 'rows beyond the queue read "—": ' + count.beyond);
  assert.ok(count.windBeyond >= 3 && count.earnedDash >= 3, 'Windfalls beyond the queue, with deposits filed to it one at a time (rounds 10, 11): ' + count.windBeyond);
  assert.ok(count.ruleMoved >= 3, 'periods with a rule\'s pay deposit filed away from Windfalls (round 11): ' + count.ruleMoved);
  assert.ok(count.leftOut >= 3, 'rows beyond the queue that compare what is left: ' + count.leftOut);
  assert.ok(count.elsewhere >= 8, 'paydays moved out of a Steady pay row: ' + count.elsewhere);
  assert.ok(count.undos >= 10 && count.locks >= 5, 'Undos and locks: ' + count.undos + ', ' + count.locks);
  assert.ok(count.i5Stream >= 15, 'rows of one stream read as In and out: ' + count.i5Stream);
  assert.ok(count.adds >= 10, 'suggestions added on a first run: ' + count.adds);
  // about 20 s on a Mac; the bound leaves room for a busy machine running the suite's files side by side
  assert.ok(ms < 60000, 'time: ' + ms + ' ms');
});

/**
 * I6 for one deposit moved on its own (This deposit only), the pay set unchanged: the section before the move (`pre`)
 * against after, at 30 and 90 days.
 */
function checkMove(moved, after, count, at, fail) {
  const before = moved.pre;
  const tx = moved.tx;
  const cents = Math.round(tx.amount);
  const was = filingOf(lookOf(before), before.txs.find((x) => x.id === tx.id));
  const wasTo = was.to;
  const nowTo = filingOf(lookOf(after), after.txs.find((x) => x.id === tx.id)).to;
  if (wasTo === nowTo) return;
  const L = makeLedger(after, NOW);
  const payday = tx.streamId != null && L.payStreams().some((x) => x.id === tx.streamId);
  for (const days of [30, 90]) {
    const A = moneyInBySource(before, NOW, days);
    const B = moneyInBySource(after, NOW, days);
    if (!A.window.comparable) continue;
    const w = A.window;
    const sign = tx.day >= w.from && tx.day <= w.to ? 1 : tx.day >= w.prevFrom && tx.day <= w.prevTo ? -1 : 0;
    if (!sign) continue;
    count.moves++;
    const rowOf = (sec, id) => sec.rows.find((x) => x.id === id);
    const earnedSide = (to) => to !== WINDFALL;
    // All earned and Windfalls move by its cents when an owner-filed deposit crosses between them, and stay when it does
    // not (a payday a built-in rule files to Windfalls is compared payday for payday there, as In and out compares it)
    if (payday && was.how === 'rule') continue;
    if (earnedSide(wasTo) !== earnedSide(nowTo)) {
      count.crossings++;
      const d = earnedSide(nowTo) ? 1 : -1;
      if (B.earned.change - A.earned.change !== d * sign * cents) fail('I6: All earned across Windfalls', { at, days, by: B.earned.change - A.earned.change, want: d * sign * cents });
      if (B.windfalls.change - A.windfalls.change !== -d * sign * cents) fail('I6: Windfalls across', { at, days });
    } else if (B.earned.change !== A.earned.change || B.windfalls.change !== A.windfalls.change) fail('I6: All earned and Windfalls stay', { at, days });
    if (payday) {
      // a payday (a day with a deposit of a pay stream, f414276's) moved out of a Steady pay row in the period counts once
      // more in its other rows, while the row still holds a payday of its stream in either window (else the stream is no
      // longer one of the row's), unless its day stays a payday of the row or was one in another row already
      const was = rowOf(A, wasTo);
      const now = rowOf(B, wasTo);
      const look = lookOf(after);
      const lookBefore = lookOf(before);
      const ofStream = (st, lk, x) => x.id !== tx.id && x.streamId === tx.streamId && x.source !== 'manual' && !x.pending && x.flow === 'in' && x.kind === 'income';
      const holds = after.txs.some((x) => ofStream(after, look, x) && x.day >= w.prevFrom && x.day <= w.to && filingOf(look, x).to === wasTo);
      if (holds && was && now && was.kind === 'steady' && sign === 1) {
        const by = ((now.paydays && now.paydays.elsewhere) || 0) - ((was.paydays && was.paydays.elsewhere) || 0);
        const sameDay = before.txs.some((x) => ofStream(before, lookBefore, x) && x.day === tx.day);
        const want = sameDay ? by : 1;
        if (!sameDay) count.elsewhere++;
        if (by !== want) fail('I6: elsewhere', { at, days, by, want });
      }
      continue;
    }
    // a deposit linked to no pay stream: the two rows that compare move by its cents, every other row stays
    for (const x of B.rows) {
      const y = rowOf(A, x.id);
      if (!y || x.change == null || y.change == null) continue;
      const d = x.id === nowTo ? sign * cents : x.id === wasTo ? -sign * cents : 0;
      if (x.change - y.change !== d) fail('I6: a row moved by other than the deposit', { at, days, row: x.name, by: x.change - y.change, want: d });
    }
  }
}
