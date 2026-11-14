/**
 * Charts for Networth — figures drawn the way a printed book draws them: fine ink lines,
 * hairline grid, small condensed caps, hatching instead of fills, figures in the figure face.
 *
 * ONE CUSTOM ELEMENT
 *
 *   <nw-chart data-island kind="worth" data="${JSON.stringify(data)}"></nw-chart>
 *
 *   kind   one of: worth · edge · months · lines · payoff · spark
 *   data   a JSON string (html`` escapes it; always quote the attribute)
 *   cover  optional bare attribute: replace every figure with a redaction bar. The same happens
 *          under any ancestor carrying data-cover (the app sets it on the page). While covered,
 *          the text alternative names the chart and gives no amounts.
 *
 * The element draws inline SVG at its own pixel size (text never scales), redraws when it is
 * resized and when kind or data change. Its height comes from CSS: aspect-ratio through the
 * custom property --chart-ratio, kept between --chart-min-h and --chart-max-h. Two kinds size
 * themselves instead: "months" is as tall as its rows, "spark" is an inline box (--spark-w by --spark-h).
 * The caption ("FIG. 1 — ...") is written by the screen in a <figcaption>, never by the chart.
 * Colours come from the tokens through CSS, so a change of theme needs no redraw. Nothing moves:
 * there is no animation to turn off. The element keeps no state on its own attributes or class.
 *
 * Unknown kinds, missing data and malformed JSON draw an empty frame with a quiet
 * "no record yet". Nothing here throws. Each chart is role="img" with an aria-label taken from
 * the optional "summary" field of its data, else computed (first value, last value, range).
 *
 * DATA SHAPES — money is integer cents, days are 'YYYY-MM-DD', months are 'YYYY-MM'.
 * Every kind takes an object; where the object has one obvious list, the bare list is accepted too.
 * Every object may carry  summary: string  (the text alternative).
 *
 *  worth    { days: [{ day, smooth, bank, partial }], events?: [{ day, label }], live?: cents }
 *           or the bare days array. Net worth by day (ledger DayClose rows work as they are).
 *           smooth  the smoothed net worth: the ink line. Missing -> bank is used.
 *           bank    net worth at the bank: a fine dotted line (omitted when equal to smooth throughout).
 *           partial true for today and for days the bank has not fully reported: that tail is in pencil.
 *           events  owner revaluations: an open square on the line, with its label when there is room.
 *           live    the live value now: the last point (spot ring) and its end label, floored to the
 *                   cent it has reached (Math.floor), the same cent as the Board's ticking hero.
 *           est     true when the end figure is an estimate (smoothing, a provisional move, an account
 *                   kept by hand at an estimate): the end label is italic with "≈". Without est: true the
 *                   end label is roman, a figure made only of posted bank rows and reported balances.
 *           Missing days are bridged with a dotted "no record" line.
 *
 *  edge     { rounds: [{ day, n, kept, cum, result, status }], moved: cents }   or the bare rounds array.
 *           Kept versus habit since the match began, one slot per round (ledger Round rows work).
 *           n       the round number printed under the slot (day of month)
 *           kept    cents kept that round (so far, for the live round)
 *           cum     cumulative kept through that round; when absent it is the running sum of kept
 *                   (a round the bank has not reported adds nothing until it is provisional)
 *           result  1 | 0.5 | 0 | null
 *           status  'final' (ink) · 'provisional' (pencil) · 'awaiting' · 'live' (today, spot colour);
 *                   'prematch' and 'future' rounds are ignored
 *           moved   the part of the edge already swept: drawn solid from the habit line up.
 *           Pass these fields only — a ledger Round also carries its moves, which do not belong in an attribute.
 *
 *  months   { months: [{ ym, start, end, charges, payments, current? }] }   or the bare array.
 *           Card months, oldest first (cards CardMonth rows work). One row each: a split bar of
 *           payments (white) against charges (black) and the change end − start as a signed figure
 *           (a `change` field, when given, is used as it is). In a column too narrow for them the two
 *           amounts under the bar are left out and the bar stands alone.
 *           current  true marks the month "so far"; when no row has the field, the month of today is used.
 *
 *  lines    { start: cents, months: number, lines: [{ key, label, points: cents[] }], from?: 'YYYY-MM' }
 *           Scenario lines (forecast.projectNetWorth returns exactly this). points[0] = start,
 *           points[m] = the value after m months. At most three lines are drawn:
 *           key 'pace' solid · 'scenario' dashed · 'habit' dotted (other keys: solid, dashed, dotted in order).
 *           from    the month of points[0]; default: the month of the app clock.
 *
 *  payoff   { schedule: [{ month, owed }], from?: 'YYYY-MM' }   or the bare schedule array.
 *           A declining balance; month counts months from `from` (0 = now), owed is positive cents.
 *           The first month with owed <= 0 is labelled as the payoff month.
 *
 *  spark    number[]   or { values: number[] }.  A tiny inline trend: no axes, last point in the spot colour.
 *
 * EXPORTS
 *   niceScale(min, max, count)   tick values on round numbers covering [min, max]
 *   chartSummary(kind, data)     the computed text alternative for a data object (not a JSON string)
 *   NwChart                      the element class (registered as nw-chart on import)
 * Compact money for axes is money.fmtCompact — import it from ../model/money.js.
 */

import { define, esc } from './dom.js';
import { fmt, fmtCompact, fmtSigned } from '../model/money.js';
import { nowMs, ymd, isYmd, fmtDate, fmtMonth, addMonthsYm, monthOf } from '../model/dates.js';

const NOTE = 'no record yet';
const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* ------------------------------------------------------------ small helpers */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const f1 = (n) => Math.round(n * 10) / 10;
/** A coordinate on the half pixel, so a 1px line is crisp. */
const hp = (n) => Math.floor(n) + 0.5;
const isYm = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

function dayNum(day) {
  return Math.round(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86400000);
}

/** Rough width of a string in px for a face whose average character is `k` em wide. */
function estW(s, size, k) {
  return String(s).length * size * k;
}
/** Width of a condensed-caps label (10.5px, tracked): wide and narrow letters counted apart. */
function wCaps(s) {
  let w = 0;
  for (const ch of String(s)) w += ch === 'W' || ch === 'M' ? 9.6 : ch === 'I' || ch === '1' || ch === ' ' || ch === '·' ? 4 : 6.6;
  return w;
}
const wNum = (s) => estW(s, 10.5, 0.56);
const wFig = (s, size = 16) => estW(s, size, 0.5);

function txt(cls, x, y, s, anchor) {
  return '<text class="' + cls + '" x="' + f1(x) + '" y="' + f1(y) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(s) + '</text>';
}

/** A money figure. est = computed / not final: italic, with the approximately sign in the spot colour. */
function fig(cls, x, y, s, anchor, est) {
  return '<text class="' + cls + ' nwc-money' + (est ? ' nwc-est' : '') + '" x="' + f1(x) + '" y="' + f1(y) + '"' +
    (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + (est ? '<tspan class="nwc-approx">≈</tspan> ' : '') + esc(s) + '</text>';
}

function extent(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Tick values on round numbers (1, 2, 2.5, 5 × a power of ten) covering [min, max].
 * `count` is the number of intervals aimed for; the result has between 2 and count + 3 values.
 * A flat range is opened a little so a level series sits mid-frame.
 */
export function niceScale(min, max, count = 4) {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : lo;
  if (lo > hi) { const s = lo; lo = hi; hi = s; }
  // a level series, or a range too fine for the numbers to carry: open it so the line sits mid-frame
  const size = Math.max(Math.abs(lo), Math.abs(hi));
  if (hi - lo < Math.max(1e-6, size * 1e-9)) { const pad = size === 0 ? 100 : Math.max(size * 0.02, 1); lo -= pad; hi += pad; }
  const n = Math.max(1, Math.round(Number.isFinite(count) ? count : 4));
  const rough = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const from = Math.floor(lo / step + 1e-9);
  const to = Math.ceil(hi / step - 1e-9);
  const out = [];
  for (let i = from; i <= to && out.length < 64; i++) out.push(Number((i * step).toFixed(6)) + 0);
  return out;
}

/** Axis labels for a set of ticks: compact money when it is exact and distinct, else plainer money. */
function axisLabels(ticks, signed) {
  const exact = ticks.every((v) => {
    const d = Math.abs(v) / 100;
    const unit = d >= 9_999_500 ? 10_000_000 : d >= 999_950 ? 1_000_000 : d >= 9_995 ? 10_000 : d >= 1000 ? 1000 : 100;
    return Math.abs(v) % unit === 0;
  });
  const sign = signed ? 'always' : 'auto';
  let out = ticks.map((v) => (signed && v > 0 ? '+' : '') + fmtCompact(v));
  if (!exact || new Set(out).size !== out.length) {
    const whole = ticks.every((v) => v % 100 === 0);
    out = ticks.map((v) => fmt(v, { decimals: whole ? 0 : 2, sign }));
  }
  return out;
}

/** Grid lines and their labels. `notch` = { x0, x1, y0, y1 }: a box (a key) the grid lines step around. */
function yAxis(ticks, labels, y, l, right, notch) {
  let grid = '', text = '';
  for (let i = 0; i < ticks.length; i++) {
    const yy = hp(y(ticks[i]));
    if (notch && yy > notch.y0 && yy < notch.y1 && notch.x1 < right - 8) {
      if (notch.x0 > l + 0.5) grid += 'M' + f1(l) + ' ' + yy + 'H' + f1(notch.x0);
      grid += 'M' + f1(notch.x1) + ' ' + yy + 'H' + f1(right);
    } else grid += 'M' + f1(l) + ' ' + yy + 'H' + f1(right);
    text += txt('nwc-n nwc-money', l - 7, yy + 3.6, labels[i], 'end');
  }
  return '<path class="nwc-grid" d="' + grid + '"/>' + text;
}

function hatchDefs(id) {
  const tile = (suffix, angle, cls) =>
    '<pattern id="' + id + suffix + '" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(' + angle + ')">' +
    '<path class="nwc-hatch ' + cls + '" d="M2.5 0V5"/></pattern>';
  // a: the edge (spot colour) · b: below the habit line (ink) · c: a wide, quiet hatch for large areas
  return '<defs>' + tile('a', 45, 'nwc-hatch-a') + tile('b', -45, 'nwc-hatch-b') +
    tile('c', -45, 'nwc-hatch-b nwc-hatch-wide').replace('width="5" height="5"', 'width="7" height="7"').replace('V5', 'V7').replace('M2.5', 'M3.5') + '</defs>';
}

/** The month, k months after `ym`, as { m: 0..11, y }. */
function monthAt(ym, k) {
  const at = addMonthsYm(ym, k);
  return { ym: at, m: Number(at.slice(5, 7)) - 1, y: Number(at.slice(0, 4)) };
}

/**
 * A month axis for kinds whose x is "months from now": an ink baseline with a tick per month,
 * labelled on calendar boundaries (quarters, half-years, Januaries) and thinned to fit. The year is
 * printed under each January; a span of years is labelled with the years alone, at their Januaries.
 */
function monthAxis(from, m0, m1, x, l, pw, ay, firstLabel) {
  const span = Math.max(1, m1 - m0);
  const per = pw / span;
  const step = [1, 2, 3, 6].find((k) => k * per >= 44) || 12;
  const yearEvery = step < 12 ? 1 : [1, 2, 5, 10, 20].find((k) => k * 12 * per >= 40) || 50;
  const y0 = hp(ay);
  let d = 'M' + f1(l) + ' ' + y0 + 'H' + f1(l + pw);
  let text = '';
  const boxes = [];
  const place = (xx, s, year) => {
    const w = wCaps(s);
    const anchor = xx - l < w / 2 ? 'start' : l + pw - xx < w / 2 ? 'end' : 'middle';
    const p = anchor === 'start' ? xx : anchor === 'end' ? xx - w : xx - w / 2;
    if (boxes.some(([a, z]) => p < z + 9 && p + w > a - 9)) return false;
    boxes.push([p, p + w]);
    text += txt('nwc-t', xx, y0 + 17, s, anchor);
    if (year != null) text += txt('nwc-n', xx, y0 + 29, String(year), anchor);
    return true;
  };
  // the year goes under the first label that falls in a year not yet named ("NOW" names its own)
  let yearShown = null;
  if (firstLabel && m0 === 0) { place(x(0), firstLabel, null); d += 'M' + hp(x(0)) + ' ' + y0 + 'v5'; yearShown = monthAt(from, 0).y; }
  for (let m = Math.ceil(m0); m <= m1 + 1e-9; m++) {
    const at = monthAt(from, m);
    const xx = x(m);
    const major = step < 12 ? at.m % step === 0 : at.m === 0 && at.y % yearEvery === 0;
    if (!major) { if (per >= 5 || (at.m === 0 && per * 12 >= 5)) d += 'M' + (m >= m1 ? hp(xx) - 1 : hp(xx)) + ' ' + y0 + 'v3'; continue; }
    d += 'M' + (m >= m1 ? hp(xx) - 1 : hp(xx)) + ' ' + y0 + 'v5';
    if (m === 0 && firstLabel) continue;
    if (step >= 12) place(xx, String(at.y), null);
    else if (place(xx, MONTHS_SHORT[at.m], at.y !== yearShown ? at.y : null)) yearShown = at.y;
  }
  return '<path class="nwc-ax" d="' + d + '"/>' + text;
}

/* ------------------------------------------------------------------- empty */

function emptyFrame(W, H, kind) {
  if (kind === 'spark') return '<path class="nwc-grid" d="M1 ' + hp(H / 2) + 'H' + f1(W - 1) + '"/>';
  const ay = hp(H - 20);
  const top = 12, bottom = ay - 12;
  let grid = '';
  for (let i = 0; i < 3; i++) grid += 'M0 ' + hp(top + ((bottom - top) * i) / 2) + 'H' + W;
  return '<path class="nwc-grid" d="' + grid + '"/>' +
    '<path class="nwc-ax" d="M0.5 ' + ay + 'H' + (W - 0.5) + 'M0.5 ' + ay + 'v5M' + (W - 0.5) + ' ' + ay + 'v5"/>' +
    txt('nwc-i nwc-note', W / 2, (top + bottom) / 2 + 4, NOTE, 'middle');
}

/* ------------------------------------------------------------------- worth */

function readWorth(raw) {
  const src = Array.isArray(raw) ? { days: raw } : obj(raw);
  const days = [];
  for (const d of arr(src.days)) {
    if (!d || !isYmd(d.day)) continue;
    const s = num(d.smooth), b = num(d.bank);
    if (s == null && b == null) continue;
    days.push({ day: d.day, t: dayNum(d.day), s: s == null ? b : s, b, partial: d.partial === true });
  }
  days.sort((a, b) => a.t - b.t);
  const events = [];
  for (const e of arr(src.events)) if (e && isYmd(e.day)) events.push({ day: e.day, t: dayNum(e.day), label: e.label == null ? '' : String(e.label) });
  return { days, events, live: num(src.live), est: src.est === true, summary: src.summary };
}

function sumWorth(d) {
  if (!d.days.length) return 'Net worth: ' + NOTE + '.';
  const first = d.days[0], last = d.days[d.days.length - 1];
  const end = d.live != null ? d.live : last.s;
  const [lo, hi] = extent(d.days.map((x) => x.s).concat(d.live));
  const est = d.est;
  if (d.days.length === 1) return 'Net worth on ' + fmtDate(last.day) + ': ' + (est ? 'about ' : '') + fmt(Math.floor(end)) + '.';
  return 'Net worth, ' + fmtDate(first.day) + ' to ' + fmtDate(last.day) + ': began at ' + fmt(first.s) + ', now ' +
    (est ? 'about ' : '') + fmt(Math.floor(end)) + '; low ' + fmt(lo) + ', high ' + fmt(hi) + '.';
}

function drawWorth(d, W, H) {
  const days = d.days;
  if (!days.length) return null;
  const n = days.length;
  const first = days[0], last = days[n - 1];
  const span = last.t - first.t;
  let endVal = last.s;
  const est = d.est;
  let lastY = last.s;
  if (d.live != null) { endVal = d.live; if (last.partial) lastY = d.live; }

  const showBank = days.some((x) => x.b != null && x.b !== x.s);
  const [lo, hi] = extent(days.map((x) => x.s).concat(showBank ? days.map((x) => x.b) : [], d.live, lastY));
  const ticks = niceScale(lo, hi, H < 210 ? 3 : 4);
  const labels = axisLabels(ticks);
  const long = span > 62;
  const l = Math.ceil(Math.max(...labels.map(wNum))) + 13;
  const r = 12, t = 30, b = long ? 46 : 34;
  const pw = Math.max(20, W - l - r), ph = Math.max(20, H - t - b);
  const d0 = ticks[0], d1 = ticks[ticks.length - 1];
  const x = (tt) => l + (span ? (tt - first.t) / span : 0.5) * pw;
  const y = (v) => t + (1 - (v - d0) / (d1 - d0)) * ph;

  // the smoothed line: ink where the day is complete, pencil where it is partial, dotted where no record
  const pts = days.map((p, i) => ({ x: x(p.t), y: y(i === n - 1 ? lastY : p.s), t: p.t, partial: p.partial }));
  const paths = { ink: '', pencil: '', gap: '' };
  let pen = null;
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], p = pts[i];
    const kind = p.t - a.t > 1 ? 'gap' : p.partial ? 'pencil' : 'ink';
    if (pen !== kind) { paths[kind] += 'M' + f1(a.x) + ' ' + f1(a.y); pen = kind; }
    paths[kind] += 'L' + f1(p.x) + ' ' + f1(p.y);
  }
  let end = pts[n - 1];
  if (d.live != null && !last.partial) {
    const yy = y(d.live);
    paths.pencil += 'M' + f1(end.x) + ' ' + f1(end.y) + 'V' + f1(yy);
    end = { x: end.x, y: yy };
  }

  let bank = '';
  if (showBank) {
    let prev = null;
    for (const p of days) {
      if (p.b == null) { prev = null; continue; }
      const px = f1(x(p.t)), py = f1(y(p.b));
      bank += (prev != null && p.t - prev <= 1 ? 'L' : 'M') + px + ' ' + py;
      prev = p.t;
    }
  }

  let out = yAxis(ticks, labels, y, l, l + pw);
  if (bank) out += '<path class="nwc-bank" d="' + bank + '"/>';
  if (paths.gap) out += '<path class="nwc-norec" d="' + paths.gap + '"/>';
  if (paths.ink) out += '<path class="nwc-line" d="' + paths.ink + '"/>';
  if (paths.pencil) out += '<path class="nwc-pencil" d="' + paths.pencil + '"/>';

  // the value label of the last point: above it when the line leaves room, else below
  const label = fmt(Math.floor(endVal));
  const lw = wFig(label) + (est ? 14 : 0);
  let lx, anchor;
  if (n === 1) { lx = end.x; anchor = 'middle'; } else { lx = l + pw + 6; anchor = 'end'; }
  const x0 = anchor === 'middle' ? lx - lw / 2 : lx - lw;
  const others = pts.slice(0, n - 1);
  if (showBank) for (const p of days) if (p.b != null) others.push({ x: x(p.t), y: y(p.b) });
  const inSpan = others.filter((p) => p.x >= x0 - 4);
  const hits = (base) => {
    let c = 0;
    for (const p of inSpan) if (p.y > base - 17 && p.y < base + 6) c++;
    return c;
  };
  // candidates, nearest first: just above the point, just below it, then clear of every line above or below.
  // A candidate that would sit on a grid line is nudged off it, away from the point.
  const gridYs = ticks.map((v) => y(v));
  const onGrid = (v) => gridYs.find((g) => g > v - 13 && g < v + 3);
  const ys = inSpan.map((p) => p.y).concat(end.y);
  const tries = [[end.y - 11, -1], [end.y + 23, 1], [Math.min(...ys) - 9, -1], [Math.max(...ys) + 21, 1]]
    .map(([v, dir]) => { const g = onGrid(v); return g == null ? v : dir < 0 ? g - 5 : g + 15; })
    .filter((v) => v >= 14 && v <= t + ph + 4);
  let base = tries.length ? tries[0] : Math.max(14, end.y - 11);
  let fewest = Infinity;
  for (const v of tries) { const c = hits(v) + (onGrid(v) == null ? 0 : 0.5); if (c < fewest) { fewest = c; base = v; } }

  // owner revaluations: an open square on the line, labelled when there is room
  const evs = d.events.filter((e) => e.t >= first.t && e.t <= last.t);
  const labelEvents = evs.length <= 3 && pw >= 200;
  for (const e of evs) {
    let near = pts[0];
    for (const p of pts) if (Math.abs(p.t - e.t) < Math.abs(near.t - e.t)) near = p;
    const ex = x(e.t), ey = near.y;
    out += '<rect class="nwc-sq" x="' + f1(ex - 2.8) + '" y="' + f1(ey - 2.8) + '" width="5.6" height="5.6"/>';
    if (labelEvents && e.label) {
      // the label goes where the line is not: up and to the left of a rising line, up and to the right of a falling one
      const i = pts.indexOf(near);
      const before = pts[Math.max(0, i - 4)], after = pts[Math.min(n - 1, i + 4)];
      const w = estW(e.label, 12, 0.46);
      let left = before.y >= after.y;
      if (left && ex - 8 - w < l) left = false;
      if (!left && ex + 8 + w > l + pw - (Math.abs(base - ey) < 26 ? lw : 0)) left = true;
      const up = ey - 20 > t;
      // the side it lies on, kept inside the chart: a count is made today, at the right edge
      let right = left !== up;
      if (right && ex + 7 + w > W - 2) right = false;
      else if (!right && ex - 7 - w < 2) right = true;
      out += txt('nwc-i', right ? ex + 7 : ex - 7, up ? ey - 8 : ey + 17, e.label, right ? 'start' : 'end');
    }
  }

  out += '<circle class="nwc-ring" cx="' + f1(end.x) + '" cy="' + f1(end.y) + '" r="3.2"/>';
  out += fig('nwc-f', lx, base, label, anchor, est);

  // the day axis: month ticks; a short span also names its first and last day
  const ay = hp(t + ph + 10);
  let ax = 'M' + f1(l) + ' ' + ay + 'H' + f1(l + pw) + 'M' + hp(l) + ' ' + ay + 'v5M' + (hp(l + pw) - 1) + ' ' + ay + 'v5';
  const months = [];
  let ym = monthOf(first.day);
  if (first.day.slice(8) !== '01') ym = addMonthsYm(ym, 1);
  for (let guard = 0; ym + '-01' <= last.day && guard < 2400; guard++) {
    months.push({ ym, x: x(dayNum(ym + '-01')), m: Number(ym.slice(5, 7)) - 1, y: ym.slice(0, 4) });
    ym = addMonthsYm(ym, 1);
  }
  const short = (day) => fmtDate(day, 'short').toUpperCase();
  let text = '';
  if (!long) {
    const boxes = [];
    if (span === 0) {
      text += txt('nwc-t', end.x, ay + 17, short(first.day), 'middle');
    } else {
      const a = short(first.day), z = short(last.day);
      text += txt('nwc-t', l, ay + 17, a) + txt('nwc-t', l + pw, ay + 17, z, 'end');
      boxes.push([l, l + wCaps(a)], [l + pw - wCaps(z), l + pw]);
      for (const mo of months) {
        ax += 'M' + hp(mo.x) + ' ' + ay + 'v5';
        const s = MONTHS_SHORT[mo.m] + ' 1', hw = wCaps(s) / 2;
        if (boxes.some(([p, q]) => mo.x + hw + 8 > p && mo.x - hw - 8 < q)) continue;
        text += txt('nwc-t', mo.x, ay + 17, s, 'middle');
        boxes.push([mo.x - hw, mo.x + hw]);
      }
    }
  } else {
    const per = pw / (span / 30.44);
    const k = [1, 2, 3, 6, 12].find((s) => s * per >= 40) || 12;
    let shown = 0;
    for (const mo of months) {
      const major = mo.m % k === 0;
      ax += 'M' + hp(mo.x) + ' ' + ay + (major ? 'v5' : 'v3');
      if (!major) continue;
      const anchorM = mo.x - l < 12 ? 'start' : l + pw - mo.x < 12 ? 'end' : 'middle';
      text += txt('nwc-t', mo.x, ay + 17, MONTHS_SHORT[mo.m], anchorM);
      if (mo.m === 0 || shown === 0) text += txt('nwc-n', mo.x, ay + 29, mo.y, anchorM);
      shown++;
    }
  }
  out += '<path class="nwc-ax" d="' + ax + '"/>' + text;
  return { body: out };
}

/* -------------------------------------------------------------------- edge */

function readEdge(raw) {
  const src = Array.isArray(raw) ? { rounds: raw } : obj(raw);
  const rounds = [];
  let run = 0;
  for (const r of arr(src.rounds)) {
    if (!r || typeof r !== 'object' || r.status === 'prematch' || r.status === 'future') continue;
    if (num(r.kept) == null && num(r.cum) == null) continue;
    const kept = num(r.kept) || 0;
    const cum = num(r.cum);
    const status = r.status === 'live' || r.status === 'awaiting' || r.status === 'provisional' ? r.status : 'final';
    run = cum != null ? cum : status === 'awaiting' ? run : run + kept;
    rounds.push({ day: isYmd(r.day) ? r.day : null, n: num(r.n) == null ? rounds.length + 1 : r.n, kept, cum: run, result: num(r.result), status });
  }
  return { rounds, moved: Math.max(0, num(src.moved) || 0), summary: src.summary };
}

/** The kept total that counts: through the last round that is not today's. */
function edgeTotal(rounds) {
  const N = rounds.length;
  const liveLast = N > 0 && rounds[N - 1].status === 'live';
  const counted = liveLast ? N - 1 : N;
  return { liveLast, counted, kept: counted ? rounds[counted - 1].cum : 0, final: rounds.slice(0, counted).every((r) => r.status === 'final') };
}

function sumEdge(d) {
  if (!d.rounds.length) return 'Kept versus habit: ' + NOTE + '.';
  const tot = edgeTotal(d.rounds);
  const [lo, hi] = extent([0].concat(d.rounds.map((r) => r.cum)));
  return 'Kept versus habit over ' + d.rounds.length + (d.rounds.length === 1 ? ' round' : ' rounds') + ': began level, now ' +
    (tot.final ? '' : 'about ') + fmtSigned(tot.kept) + (d.moved > 0 ? ', of which ' + fmt(d.moved) + ' moved' : '') +
    '; range ' + fmtSigned(lo) + ' to ' + fmtSigned(hi) + '.';
}

function resultMark(r) {
  if (r.status === 'live') return '*';
  if (r.result === 1) return '1';
  if (r.result === 0.5) return '½';
  if (r.result === 0) return '0';
  return '·';
}

function drawEdge(d, W, H, id) {
  const rounds = d.rounds;
  const N = rounds.length;
  if (!N) return null;
  const tot = edgeTotal(rounds);
  const slots = Math.max(N, 7);

  const r = 12, t = 26;
  const rowLabelW = Math.ceil(wCaps('RESULT')) + 12;
  // a first pass at the left margin, refined once the tick labels are known
  let l = rowLabelW;
  let pw = Math.max(20, W - l - r);
  let sw = pw / slots;
  const mode = sw >= 15 ? 'all' : N <= 62 && sw * 5 >= 20 ? 'fives' : 'months';
  const showRes = sw >= 14;
  const b = 22 + 5 + 14 + (showRes || mode === 'months' ? 15 : 0) + 3;
  const ph = Math.max(20, H - t - b);

  const showKey = H >= 200 && W >= 250;
  const keyFig = fmtSigned(tot.kept);
  const keyH = d.moved > 0 ? 62 : 44;
  const keyW = 8 + Math.max(21 + wFig(keyFig, 24) + (tot.final ? 0 : 24), wCaps('KEPT VS HABIT'),
    d.moved > 0 ? 16 + wCaps('MOVED') + 8 + wNum(fmt(d.moved)) : 0) + 10;

  const [lo, hi] = extent([0].concat(rounds.map((x) => x.cum)));
  let ticks = niceScale(lo, hi, H < 230 ? 3 : 4);
  if (showKey && keyH + 10 < ph * 0.8) {
    // open the scale upward until the line clears the key in the top-left corner
    let vmax = 0, before = 0;
    for (let i = 0; i < N && i * sw < keyW + 10; i++) { vmax = Math.max(vmax, before, rounds[i].cum); before = rounds[i].cum; }
    const f = (keyH + 10) / ph;
    for (let pass = 0; pass < 3; pass++) {
      const B = ticks[0], T = ticks[ticks.length - 1];
      if ((T - vmax) / (T - B) >= f) break;
      ticks = niceScale(lo, (vmax - f * B) / (1 - f), H < 230 ? 3 : 4);
    }
  }
  const labels = axisLabels(ticks, true);
  l = Math.max(rowLabelW, Math.ceil(Math.max(...labels.map(wNum))) + 13);
  pw = Math.max(20, W - l - r);
  sw = pw / slots;
  const d0 = ticks[0], d1 = ticks[ticks.length - 1];
  const y = (v) => t + (1 - (v - d0) / (d1 - d0)) * ph;
  const y0 = y(0);

  // the step line: level through a round's slot, stepping at its right edge; ink when final, pencil otherwise
  const paths = { ink: '', pencil: '' };
  let pen = null, cx = l, cy = y0, pencilH = false;
  const seg = (kind, cmd) => {
    if (pen !== kind) { paths[kind] += 'M' + f1(cx) + ' ' + f1(cy); pen = kind; }
    paths[kind] += cmd;
  };
  let area = 'M' + f1(l) + ' ' + f1(y0);
  let livePath = '';
  for (let i = 0; i < N; i++) {
    const rd = rounds[i];
    const xl = l + i * sw, xr = xl + sw, yy = y(rd.cum);
    if (i === N - 1 && tot.liveLast) {
      const xm = xl + sw / 2;
      seg(pencilH ? 'pencil' : 'ink', 'H' + f1(xm));
      area += 'H' + f1(xl);
      livePath = 'M' + f1(xm) + ' ' + f1(cy) + 'V' + f1(yy);
      cx = xm; cy = yy;
    } else {
      const pencilV = rd.status !== 'final';
      seg(pencilH ? 'pencil' : 'ink', 'H' + f1(xr));
      cx = xr;
      seg(pencilV ? 'pencil' : 'ink', 'V' + f1(yy));
      cy = yy;
      area += 'H' + f1(xr) + 'V' + f1(yy);
      pencilH = pencilV;
    }
  }
  area += 'V' + f1(y0) + 'Z';

  const yMoved = d.moved > 0 ? Math.max(t, y(Math.min(d.moved, d1))) : y0;
  const clip = (suffix, top, bottom) =>
    '<clipPath id="' + id + suffix + '"><rect x="' + f1(l) + '" y="' + f1(top) + '" width="' + f1(pw) + '" height="' + f1(Math.max(0, bottom - top)) + '"/></clipPath>';

  // the grid lines step around the key in the top-left corner
  const kx = l + 8, ky = t;
  const notch = showKey ? { x0: l, x1: l + keyW, y0: ky - 2, y1: ky + keyH - 2 } : null;

  let out = hatchDefs(id) + '<defs>' + clip('u', t - 2, yMoved) + clip('m', yMoved, y0) + clip('d', y0, t + ph + 2) + '</defs>';
  out += yAxis(ticks, labels, y, l, l + pw, notch);
  out += '<path style="fill:url(#' + id + 'a)" clip-path="url(#' + id + 'u)" d="' + area + '"/>';
  if (d.moved > 0) out += '<path class="nwc-moved" clip-path="url(#' + id + 'm)" d="' + area + '"/>';
  out += '<path style="fill:url(#' + id + 'b)" clip-path="url(#' + id + 'd)" d="' + area + '"/>';
  out += '<path class="nwc-habit" d="M' + f1(l) + ' ' + hp(y0) + 'H' + f1(l + pw) + '"/>';
  if (paths.ink) out += '<path class="nwc-line nwc-step" d="' + paths.ink + '"/>';
  if (paths.pencil) out += '<path class="nwc-pencil nwc-step" d="' + paths.pencil + '"/>';

  // the habit line's label: under the line, or above it where the edge has gone below
  let under = 0, over = 0, level = 0;
  for (let i = 0; i < N && i * sw < 84; i++) {
    under = Math.max(under, y(Math.min(level, rounds[i].cum)) - y0);
    over = Math.max(over, y0 - y(Math.max(level, rounds[i].cum)));
    level = rounds[i].cum;
  }
  const habitUnder = under <= 3 || under <= over || y0 - t < 20;
  out += txt('nwc-t', l + 6, habitUnder ? y0 + 14 : y0 - 7, 'HABIT LINE');

  if (tot.liveLast) {
    const today = rounds[N - 1];
    out += '<path class="nwc-live" d="' + livePath + '"/>';
    out += '<circle class="nwc-ring" cx="' + f1(cx) + '" cy="' + f1(cy) + '" r="3.2"/>';
    const s = fmtSigned(today.kept) + ' today';
    const room = l + pw - cx - 8 >= estW(s, 12, 0.5);
    // beside the ring when there is room, else above it and lifted clear of a grid line
    let ly = Math.max(12, cy - 9);
    const g = ticks.map((v) => y(v)).find((gy) => gy > ly - 10 && gy < ly + 3);
    if (g != null && g - 5 >= 10) ly = g - 5;
    out += '<text class="nwc-i nwc-spot nwc-money" x="' + f1(room ? cx + 8 : l + pw + 4) + '" y="' + f1(room ? cy + 4 : ly) + '"' +
      (room ? '' : ' text-anchor="end"') + '>' + esc(s) + '</text>';
  } else {
    out += '<rect class="nwc-pt" x="' + f1(cx - 2.8) + '" y="' + f1(cy - 2.8) + '" width="5.6" height="5.6"/>';
  }

  if (showKey) {
    out += '<rect x="' + kx + '" y="' + (ky + 5) + '" width="13" height="13" style="fill:url(#' + id + (tot.kept < 0 ? 'b' : 'a') + ')"/>' +
      '<rect class="nwc-swatch' + (tot.kept < 0 ? ' nwc-swatch-b' : '') + '" x="' + (kx + 0.5) + '" y="' + (ky + 5.5) + '" width="12" height="12"/>';
    out += fig('nwc-f nwc-big', kx + 21, ky + 19, keyFig, null, !tot.final);
    out += txt('nwc-t', kx, ky + 37, 'KEPT VS HABIT');
    if (d.moved > 0) {
      out += '<rect class="nwc-moved nwc-moved-key" x="' + (kx + 0.5) + '" y="' + (ky + 45.5) + '" width="9" height="9"/>' +
        txt('nwc-t', kx + 16, ky + 54, 'MOVED') + txt('nwc-n nwc-money', kx + 16 + wCaps('MOVED') + 8, ky + 54, fmt(d.moved));
    }
  }

  // the axis: round numbers and results under their slots, or month names for a long match
  const ay = hp(t + ph + 22);
  let ax = 'M' + f1(l) + ' ' + ay + 'H' + f1(l + pw);
  let text = '';
  const rowN = ay + 18, rowR = ay + 33;
  if (mode !== 'months') {
    for (let i = 0; i <= slots; i++) {
      if (sw >= 6 || i % 5 === 0 || i === slots) ax += 'M' + (i === slots ? hp(l + pw) - 1 : hp(l + i * sw)) + ' ' + ay + 'v5';
    }
    text += txt('nwc-t', l - 7, rowN, 'ROUND', 'end');
    if (showRes) text += txt('nwc-t', l - 7, rowR, 'RESULT', 'end');
    // round numbers: all of them when the slots are wide; else today's, then each month's first, then every fifth,
    // and a number that would touch one already set is left out
    const rank = (rd) => (rd.status === 'live' ? 2 : rd.n === 1 ? 1 : 0);
    const numbered = rounds.map((rd, i) => i)
      .filter((i) => mode === 'all' || rounds[i].n === 1 || rounds[i].n % 5 === 0 || rounds[i].status === 'live')
      .sort((p, q) => rank(rounds[q]) - rank(rounds[p]) || p - q);
    const set = [];
    for (const i of numbered) {
      const rd = rounds[i];
      const label = String(rd.n), mid = l + (i + 0.5) * sw, hw = wCaps(label) / 2;
      if (mode !== 'all' && set.some(([p, q]) => mid - hw < q + 5 && mid + hw > p - 5)) continue;
      set.push([mid - hw, mid + hw]);
      text += txt('nwc-t' + (rd.status === 'live' ? ' nwc-spot' : ''), mid, rowN, label, 'middle');
    }
    if (showRes) {
      for (let i = 0; i < N; i++) {
        const rd = rounds[i];
        const cls = rd.status === 'live' ? 'nwc-n nwc-spot' : rd.status === 'final' ? 'nwc-n' : 'nwc-n nwc-est';
        text += txt(cls + ' nwc-res', l + (i + 0.5) * sw, rowR, resultMark(rd), 'middle');
      }
    }
  } else {
    ax += 'M' + hp(l) + ' ' + ay + 'v5M' + (hp(l + pw) - 1) + ' ' + ay + 'v5';
    let lastX = -Infinity, lastYear = null;
    for (let i = 0; i < N; i++) {
      const rd = rounds[i];
      if (!rd.day || (i > 0 && rd.day.slice(8) !== '01')) continue;
      const xx = l + i * sw;
      if (i > 0 && xx - l > 6) ax += 'M' + hp(xx) + ' ' + ay + 'v5';
      // a match that began in the last days of a month: let the next month take the first label
      if (i === 0 && rd.day.slice(8) !== '01') {
        const next = rounds.findIndex((q) => q.day && q.day.slice(8) === '01');
        if (next > 0 && next * sw < 34) continue;
      }
      if (xx - lastX < 34 || l + pw - xx < 16) continue;
      const anchor = xx - l < 12 ? 'start' : 'middle';
      text += txt('nwc-t', xx, rowN, MONTHS_SHORT[Number(rd.day.slice(5, 7)) - 1], anchor);
      const yr = rd.day.slice(0, 4);
      if (yr !== lastYear) { text += txt('nwc-n', xx, rowN + 12, yr, anchor); lastYear = yr; }
      lastX = xx;
    }
  }
  out += '<path class="nwc-ax" d="' + ax + '"/>' + text;
  return { body: out };
}

/* ------------------------------------------------------------------ months */

function readMonths(raw) {
  const src = Array.isArray(raw) ? { months: raw } : obj(raw);
  const rows = [];
  let flagged = false;
  for (const m of arr(src.months)) {
    if (!m || !isYm(m.ym)) continue;
    const start = num(m.start), end = num(m.end);
    if (typeof m.current === 'boolean') flagged = true;
    rows.push({
      ym: m.ym,
      charges: Math.max(0, num(m.charges) || 0),
      payments: Math.max(0, num(m.payments) || 0),
      change: num(m.change) != null ? m.change : start != null && end != null ? end - start : null,
      current: m.current === true,
    });
  }
  rows.sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
  if (!flagged) { const now = monthOf(ymd(nowMs())); for (const r of rows) r.current = r.ym === now; }
  return { rows, summary: src.summary };
}

function changeWord(c) {
  return c == null ? '' : c < 0 ? 'lower' : c > 0 ? 'higher' : 'unchanged';
}

function sumMonths(d) {
  if (!d.rows.length) return 'Card months: ' + NOTE + '.';
  const say = (r) => fmtMonth(r.ym, 'short') + (r.change == null ? ' has no record' : ' ended ' + (r.change === 0 ? 'unchanged' : fmt(Math.abs(r.change)) + ' ' + changeWord(r.change)) + (r.current ? ' so far' : ''));
  const first = d.rows[0], last = d.rows[d.rows.length - 1];
  const ext = extent(d.rows.map((r) => r.change));
  return 'Card months: ' + say(first) + (d.rows.length > 1 ? '; ' + say(last) : '') +
    (ext && d.rows.length > 2 ? '; changes range from ' + fmtSigned(ext[0]) + ' to ' + fmtSigned(ext[1]) : '') + '.';
}

function drawMonths(d, W) {
  const rows = d.rows;
  if (!rows.length) return null;
  const lw = 44;
  const cw = Math.round(Math.min(150, Math.max(96, W * 0.3)));
  const bx0 = lw, bx1 = Math.max(bx0 + 40, W - cw - 14), bw = bx1 - bx0;
  const mid = hp(bx0 + bw / 2);
  // in a narrow column the bar stands alone: its two amounts and their headings would run into each other
  const need = Math.max(wCaps('PAYMENTS') + wCaps('CHARGES'), ...rows.map((r) => wNum(fmt(r.payments)) + wNum(fmt(r.charges)))) + 16;
  const tight = bw < need;
  const head = 21, rowH = tight ? 44 : 50;
  const H = head + rows.length * rowH;

  let out = (tight ? '' : txt('nwc-t', bx0, 11, 'PAYMENTS') + txt('nwc-t', bx1, 11, 'CHARGES', 'end')) + txt('nwc-t', W, 11, 'CHANGE', 'end');
  out += '<path class="nwc-ax" d="M0 ' + hp(head - 1) + 'H' + W + '"/>';
  let hair = '';
  rows.forEach((r, i) => {
    const y0 = head + i * rowH;
    const by = hp(y0 + (tight ? 16 : 13)), bh = 9;
    const total = r.payments + r.charges;
    const m = Number(r.ym.slice(5, 7)) - 1;
    out += txt('nwc-t nwc-month' + (r.current ? ' nwc-spot' : ''), 0, y0 + 22, MONTHS_SHORT[m]);
    if (i === 0 || m === 0) out += txt('nwc-n', 0, y0 + 35, r.ym.slice(0, 4));
    if (total > 0) {
      const split = f1(bx0 + bw * (r.payments / total));
      out += '<rect class="nwc-bar-w" x="' + hp(bx0) + '" y="' + by + '" width="' + f1(bw - 1) + '" height="' + bh + '"/>' +
        '<rect class="nwc-bar-b" x="' + split + '" y="' + by + '" width="' + f1(Math.max(0, hp(bx0) + bw - 1 - split)) + '" height="' + bh + '"/>';
    } else {
      out += '<rect class="nwc-bar-0" x="' + hp(bx0) + '" y="' + by + '" width="' + f1(bw - 1) + '" height="' + bh + '"/>';
    }
    out += '<path class="nwc-ax" d="M' + mid + ' ' + (by - 4) + 'V' + (by + bh) + '"/>';
    if (!tight) out += txt('nwc-n nwc-money', bx0, by + bh + 14.5, fmt(r.payments)) + txt('nwc-n nwc-money', bx1, by + bh + 14.5, fmt(r.charges), 'end');
    if (r.change == null) {
      out += txt('nwc-i', W, y0 + 26, NOTE, 'end');
    } else {
      const tone = r.change < 0 ? ' nwc-gain' : r.change > 0 ? ' nwc-loss' : '';
      out += fig('nwc-f nwc-delta' + tone, W, y0 + 24, fmtSigned(r.change), 'end', false);
      out += '<text class="nwc-i" x="' + W + '" y="' + (y0 + 39) + '" text-anchor="end">' + changeWord(r.change) +
        (r.current ? ', <tspan class="nwc-spot">so far</tspan>' : '') + '</text>';
    }
    if (i < rows.length - 1) hair += 'M0 ' + hp(y0 + rowH - 1) + 'H' + W;
  });
  if (hair) out += '<path class="nwc-grid" d="' + hair + '"/>';
  return { body: out, height: H };
}

/* ------------------------------------------------------------------- lines */

const LINE_STYLE = { pace: 'nwc-line', scenario: 'nwc-scn', habit: 'nwc-bank' };
const LINE_ORDER = ['nwc-line', 'nwc-scn', 'nwc-bank'];

function readLines(raw) {
  const src = obj(raw);
  const lines = [];
  for (const ln of arr(src.lines)) {
    if (!ln || typeof ln !== 'object') continue;
    const points = arr(ln.points).map(num);
    while (points.length && points[points.length - 1] == null) points.pop();
    if (!points.length || points.some((p) => p == null)) continue;
    lines.push({ key: String(ln.key == null ? '' : ln.key), label: String(ln.label == null ? ln.key || '' : ln.label), points });
    if (lines.length === 3) break;
  }
  const longest = Math.max(0, ...lines.map((ln) => ln.points.length - 1));
  const months = Math.max(1, Math.min(num(src.months) || longest, longest || 1));
  return { lines, months, start: num(src.start), from: isYm(src.from) ? src.from : monthOf(ymd(nowMs())), summary: src.summary };
}

function sumLines(d) {
  if (!d.lines.length) return 'Scenario lines: ' + NOTE + '.';
  const start = d.start != null ? d.start : d.lines[0].points[0];
  const [lo, hi] = extent(d.lines.flatMap((ln) => ln.points));
  return 'Scenario, not a prediction. Over ' + d.months + (d.months === 1 ? ' month' : ' months') + ' from ' + fmt(start) + ': ' +
    d.lines.map((ln) => ln.label + ' reaches about ' + fmt(ln.points[Math.min(d.months, ln.points.length - 1)])).join('; ') +
    '; range ' + fmt(lo) + ' to ' + fmt(hi) + '.';
}

function drawLines(d, W, H) {
  if (!d.lines.length) return null;
  const N = d.months;
  const all = d.lines.flatMap((ln) => ln.points.slice(0, N + 1));
  const [lo, hi] = extent(all.concat(d.start));
  const ticks = niceScale(lo, hi, H < 210 ? 3 : 4);
  const labels = axisLabels(ticks);
  const ends = d.lines.map((ln, i) => {
    const m = Math.min(N, ln.points.length - 1);
    return { ln, m, v: ln.points[m], text: fmt(ln.points[m], { decimals: 0 }), cls: LINE_STYLE[ln.key] || LINE_ORDER[i % 3] };
  });
  const l = Math.ceil(Math.max(...labels.map(wNum))) + 13;
  const want = Math.max(...ends.map((e) => Math.max(wCaps(e.ln.label), wFig(e.text, 15) + 14))) + 18;
  const r = Math.round(Math.min(want, W * 0.42));
  const t = 26, b = 46;
  const pw = Math.max(20, W - l - r), ph = Math.max(20, H - t - b);
  const d0 = ticks[0], d1 = ticks[ticks.length - 1];
  const x = (m) => l + (m / N) * pw;
  const y = (v) => t + (1 - (v - d0) / (d1 - d0)) * ph;

  let out = yAxis(ticks, labels, y, l, l + pw);
  if (d0 < 0 && d1 > 0) out += '<path class="nwc-zero" d="M' + f1(l) + ' ' + hp(y(0)) + 'H' + f1(l + pw) + '"/>';
  out += txt('nwc-t nwc-scenario', l, 11, 'SCENARIO');

  for (const e of ends) {
    let p = '';
    for (let m = 0; m <= e.m; m++) p += (m ? 'L' : 'M') + f1(x(m)) + ' ' + f1(y(e.ln.points[m]));
    if (e.m === 0) p += 'h0.01';
    out += '<path class="' + e.cls + '" d="' + p + '"/>';
    e.x = x(e.m); e.y = y(e.v); e.ly = e.y;
  }
  const s0 = d.start != null ? d.start : d.lines[0].points[0];
  out += '<rect class="nwc-pt" x="' + f1(x(0) - 2.8) + '" y="' + f1(y(s0) - 2.8) + '" width="5.6" height="5.6"/>';

  // each line ends in its label and value; blocks are pushed apart so they never overlap
  const order = ends.slice().sort((a, c) => a.y - c.y);
  const gap = 34;
  for (let i = 1; i < order.length; i++) if (order[i].ly < order[i - 1].ly + gap) order[i].ly = order[i - 1].ly + gap;
  const over = order[order.length - 1].ly + 16 - (t + ph + 14);
  if (over > 0) for (const e of order) e.ly -= over;
  for (let i = order.length - 2; i >= 0; i--) if (order[i].ly > order[i + 1].ly - gap) order[i].ly = order[i + 1].ly - gap;
  const lx = l + pw + 14;
  for (const e of order) {
    if (Math.abs(e.ly - e.y) > 4 || e.x < l + pw - 1) out += '<path class="nwc-grid nwc-lead" d="M' + f1(e.x + 4) + ' ' + f1(e.y) + 'L' + f1(lx - 4) + ' ' + f1(e.ly + 3) + '"/>';
    out += '<circle class="nwc-end" cx="' + f1(e.x) + '" cy="' + f1(e.y) + '" r="2"/>';
    out += txt('nwc-t', lx, e.ly - 3, e.ln.label.toUpperCase());
    out += fig('nwc-f nwc-f-s', lx, e.ly + 13, e.text, null, true);
  }

  out += monthAxis(d.from, 0, N, x, l, pw, t + ph + 10, 'NOW');
  return { body: out };
}

/* ------------------------------------------------------------------ payoff */

function readPayoff(raw) {
  const src = Array.isArray(raw) ? { schedule: raw } : obj(raw);
  const rows = [];
  for (const p of arr(src.schedule)) {
    if (!p) continue;
    const month = num(p.month), owed = num(p.owed);
    if (month == null || owed == null) continue;
    rows.push({ month, owed: Math.max(0, owed) });
  }
  rows.sort((a, b) => a.month - b.month);
  return { rows, from: isYm(src.from) ? src.from : monthOf(ymd(nowMs())), summary: src.summary };
}

function payoffRow(rows) {
  return rows.find((p) => p.owed <= 0) || null;
}

function sumPayoff(d) {
  if (!d.rows.length) return 'Card payoff: ' + NOTE + '.';
  const first = d.rows[0], last = d.rows[d.rows.length - 1];
  const done = payoffRow(d.rows);
  const [lo, hi] = extent(d.rows.map((p) => p.owed));
  return 'Scenario: balance owed falls from ' + fmt(first.owed) + (done
    ? ' to nothing in ' + fmtMonth(addMonthsYm(d.from, Math.round(done.month)), 'long') + ', ' + Math.round(done.month - first.month) + ' months on'
    : ' to about ' + fmt(last.owed) + ' after ' + Math.round(last.month - first.month) + ' months, not paid off') +
    '; range ' + fmt(lo) + ' to ' + fmt(hi) + '.';
}

function drawPayoff(d, W, H, id) {
  const all = d.rows;
  if (!all.length) return null;
  const done = payoffRow(all);
  const rows = done ? all.slice(0, all.indexOf(done) + 1) : all;
  const first = rows[0], last = rows[rows.length - 1];
  const m0 = first.month, m1 = Math.max(last.month, m0 + 1);
  const [, hi] = extent(rows.map((p) => p.owed));
  const ticks = niceScale(0, hi || 100, H < 210 ? 3 : 4);
  const labels = axisLabels(ticks);
  const l = Math.ceil(Math.max(...labels.map(wNum))) + 13;
  const r = 14, t = 30, b = 46;
  const pw = Math.max(20, W - l - r), ph = Math.max(20, H - t - b);
  const d1 = ticks[ticks.length - 1];
  const x = (m) => l + ((m - m0) / (m1 - m0)) * pw;
  const y = (v) => t + (1 - v / d1) * ph;
  const y0 = y(0);

  const pts = rows.map((p) => ({ x: x(p.month), y: y(p.owed) }));
  let line = '';
  pts.forEach((p, i) => { line += (i ? 'L' : 'M') + f1(p.x) + ' ' + f1(p.y); });
  const end = pts[pts.length - 1];

  let out = hatchDefs(id) + yAxis(ticks, labels, y, l, l + pw);
  if (pts.length > 1) {
    out += '<path style="fill:url(#' + id + 'c)" d="' + line + 'V' + f1(y0) + 'H' + f1(pts[0].x) + 'Z"/>';
    out += '<path class="nwc-scn nwc-thin" d="' + line + '"/>';
  }
  out += '<rect class="nwc-pt" x="' + f1(pts[0].x - 2.8) + '" y="' + f1(pts[0].y - 2.8) + '" width="5.6" height="5.6"/>';
  // the opening balance, a fact from the bank: above its square, lifted clear of a grid line
  let sy = Math.max(15, pts[0].y - 9);
  const sg = ticks.map((v) => y(v)).find((gy) => gy > sy - 13 && gy < sy + 3);
  if (sg != null && sg - 5 >= 13) sy = sg - 5;
  out += fig('nwc-f', pts[0].x + 9, sy, fmt(first.owed), null, false);

  if (pts.length > 1) {
    // the label of the last point floats above the curve, tied to its point by a hairline
    const when = fmtMonth(addMonthsYm(d.from, Math.round(last.month)), 'long');
    const value = done ? when : fmt(last.owed, { decimals: 0 });
    const caps = done ? 'PAID OFF' : 'STILL OWED · ' + fmtMonth(addMonthsYm(d.from, Math.round(last.month)), 'short').toUpperCase();
    const lw = Math.max(wCaps(caps), wFig(value) + (done ? 0 : 14)) + 8;
    let top = end.y, low = end.y;
    for (const p of pts) if (p.x >= end.x - lw - 8) { if (p.y < top) top = p.y; if (p.y > low) low = p.y; }
    const base = Math.max(t + 34, Math.min(top - 16, end.y - 20));
    // no room above the curve (a balance that barely falls): the label goes under it, inside the hatching
    const under = base > top - 10 && low + 36 <= y0 - 6;
    const by = under ? low + 36 : base;
    out += '<path class="nwc-grid" d="M' + hp(end.x) + ' ' + (under ? f1(end.y + 5) + 'V' + f1(by - 27) : f1(end.y - 5) + 'V' + f1(by + 5)) + '"/>';
    out += txt('nwc-t', end.x + 2, by - 17, caps, 'end');
    out += done ? txt('nwc-f nwc-est', end.x + 2, by, value, 'end') : fig('nwc-f', end.x + 2, by, value, 'end', true);
  }
  out += '<circle class="nwc-ring" cx="' + f1(end.x) + '" cy="' + f1(end.y) + '" r="3.2"/>';
  out += monthAxis(d.from, m0, m1, x, l, pw, t + ph + 10, m0 === 0 ? 'NOW' : null);
  return { body: out };
}

/* ------------------------------------------------------------------- spark */

function readSpark(raw) {
  const src = Array.isArray(raw) ? { values: raw } : obj(raw);
  return { values: arr(src.values).map(num).filter((v) => v != null), summary: src.summary };
}

function sumSpark(d) {
  const v = d.values;
  if (!v.length) return 'Trend: ' + NOTE + '.';
  const [lo, hi] = extent(v);
  return 'Trend: from ' + fmt(v[0]) + ' to ' + fmt(v[v.length - 1]) + '; range ' + fmt(lo) + ' to ' + fmt(hi) + '.';
}

function drawSpark(d, W, H) {
  const v = d.values;
  if (!v.length) return null;
  const pad = 3;
  const [lo, hi] = extent(v);
  const n = v.length;
  const x = (i) => (n > 1 ? pad + (i / (n - 1)) * (W - pad * 2) : W - pad);
  const y = (val) => (hi > lo ? pad + (1 - (val - lo) / (hi - lo)) * (H - pad * 2) : H / 2);
  let p = '';
  for (let i = 0; i < n; i++) p += (i ? 'L' : 'M') + f1(x(i)) + ' ' + f1(y(v[i]));
  return {
    body: (n > 1 ? '<path class="nwc-spark" d="' + p + '"/>' : '') +
      '<circle class="nwc-dot" cx="' + f1(x(n - 1)) + '" cy="' + f1(y(v[n - 1])) + '" r="2"/>',
  };
}

/* --------------------------------------------------------------- the kinds */

const KINDS = {
  worth: { read: readWorth, sum: sumWorth, draw: drawWorth },
  edge: { read: readEdge, sum: sumEdge, draw: drawEdge },
  months: { read: readMonths, sum: sumMonths, draw: drawMonths },
  lines: { read: readLines, sum: sumLines, draw: drawLines },
  payoff: { read: readPayoff, sum: sumPayoff, draw: drawPayoff },
  spark: { read: readSpark, sum: sumSpark, draw: drawSpark },
};

/**
 * The text alternative of a chart: the data's own `summary` when it has one, else a computed
 * sentence with the first value, the last value and the range.
 * @param {string} kind
 * @param {object|Array} data  the data object (not a JSON string)
 * @returns {string}
 */
/** The drawing of a chart as svg markup, outside the element (for the tests): null when there is nothing to draw. */
export function chartSvg(kind, data, W, H) {
  const k = KINDS[kind];
  const drawn = k ? k.draw(k.read(data), W, H) : null;
  return drawn && typeof drawn.body === 'string' ? drawn.body : null;
}

export function chartSummary(kind, data) {
  const k = KINDS[kind];
  if (!k) return 'Chart: ' + NOTE + '.';
  try {
    const d = k.read(data);
    return typeof d.summary === 'string' && d.summary.trim() ? d.summary.trim() : k.sum(d);
  } catch (err) {
    return 'Chart: ' + NOTE + '.';
  }
}

const COVER_NAMES = { worth: 'Net worth by day', edge: 'Kept versus habit by round', months: 'Card months',
  lines: 'Scenario lines', payoff: 'Card payoff', spark: 'Trend' };

/** The text alternative while figures are covered: what the chart is, and no amounts. */
function coverLabel(kind) {
  return (COVER_NAMES[kind] || 'Chart') + '. Figures are covered.';
}

let serial = 0;

/* Charts on the page, told when an ancestor's data-cover comes or goes so their text alternative follows. */
const mounted = new Set();
let coverWatch = null;
function watchCover() {
  if (coverWatch || typeof MutationObserver !== 'function') return;
  coverWatch = new MutationObserver(() => { for (const el of mounted) el._relabel(); });
  coverWatch.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-cover'] });
}

/** Build the SVG markup for one chart. Never throws. Returns { markup, height } (height only when the kind sizes itself). */
function render(kind, data, W, H, id, covered) {
  const k = KINDS[kind];
  let made = null, label = 'Chart: ' + NOTE + '.', problem = '';
  if (!k) problem = 'unknown kind';
  else {
    try {
      const d = k.read(data);
      label = typeof d.summary === 'string' && d.summary.trim() ? d.summary.trim() : k.sum(d);
      made = k.draw(d, W, H, id);
    } catch (err) {
      made = null;
      problem = String(err && err.message ? err.message : err);
    }
  }
  let height = made && made.height ? made.height : null;
  if (!made && kind === 'months') height = 96;
  const h = height || H;
  const body = made ? made.body : emptyFrame(W, h, kind);
  return {
    height,
    label,
    markup: '<svg class="nwc nwc-' + (k ? kind : 'none') + (made ? '' : ' nwc-empty') + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + h +
      '" width="' + W + '" height="' + h + '" role="img" aria-label="' + esc(covered ? coverLabel(kind) : label) + '"' +
      (problem ? ' data-problem="' + esc(problem) + '"' : '') + '>' + body + '</svg>',
  };
}

/** Give every money figure a redaction bar of its own size (shown by CSS when the app is covered). */
function addBars(svg) {
  const figs = svg.querySelectorAll('text.nwc-money');
  const boxes = [];
  for (const el of figs) {
    let box = null;
    try { box = el.getBBox(); } catch (err) { box = null; }
    boxes.push(box && box.width > 0 ? box : null);
  }
  figs.forEach((el, i) => {
    const box = boxes[i];
    if (!box) return;
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bar.setAttribute('class', 'nwc-cover');
    bar.setAttribute('x', f1(box.x));
    bar.setAttribute('y', f1(box.y + box.height * 0.3));
    bar.setAttribute('width', f1(box.width));
    bar.setAttribute('height', f1(Math.max(3, box.height * 0.46)));
    el.parentNode.insertBefore(bar, el.nextSibling);
  });
}

/* Outside a browser (a test importing niceScale or chartSummary) there is no element to extend or define. */
const ElementBase = typeof HTMLElement === 'function' ? HTMLElement : class {};

export class NwChart extends ElementBase {
  static get observedAttributes() { return ['kind', 'data', 'cover']; }

  constructor() {
    super();
    this._id = 'nwc' + (++serial);
    this._queued = false;
    this._w = -1;
    this._h = -1;
    this._raw = null;
    this._parsed = null;
    this._ro = null;
    this._mo = null;
    this._label = '';
  }

  connectedCallback() {
    if (!this._ro && typeof ResizeObserver === 'function') this._ro = new ResizeObserver(() => this._resized());
    if (this._ro) this._ro.observe(this);
    // if something empties the element (a template written without data-island), draw again
    if (!this._mo && typeof MutationObserver === 'function') this._mo = new MutationObserver(() => { if (!this.firstElementChild) this._queue(); });
    if (this._mo) this._mo.observe(this, { childList: true });
    mounted.add(this);
    watchCover();
    this._queue();
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
    if (this._mo) this._mo.disconnect();
    mounted.delete(this);
  }

  attributeChangedCallback(name, before, after) {
    if (before === after || !this.isConnected) return;
    if (name === 'cover') this._relabel();
    else this._queue();
  }

  /** Covered by its own attribute or by any ancestor carrying data-cover. */
  _covered() {
    return this.hasAttribute('cover') || this.closest('[data-cover]') != null;
  }

  /** The drawing is the same covered or not (CSS swaps figures for bars); only the text alternative changes. */
  _relabel() {
    const svg = this.firstElementChild;
    if (svg && this._label) svg.setAttribute('aria-label', this._covered() ? coverLabel(this.getAttribute('kind') || '') : this._label);
  }

  _queue() {
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => { this._queued = false; if (this.isConnected) this._draw(); });
  }

  _resized() {
    const w = Math.round(this.clientWidth), h = Math.round(this.clientHeight);
    const selfSized = this.getAttribute('kind') === 'months';
    if (w !== this._w || (!selfSized && h !== this._h)) this._draw();
  }

  _data() {
    const raw = this.getAttribute('data');
    if (raw !== this._raw) {
      this._raw = raw;
      try { this._parsed = raw == null || raw === '' ? null : JSON.parse(raw); } catch (err) { this._parsed = null; }
    }
    return this._parsed;
  }

  _draw() {
    const kind = this.getAttribute('kind') || '';
    const W = Math.round(this.clientWidth);
    let H = Math.round(this.clientHeight);
    if (W < 8) return;                       // not laid out yet: the resize observer will call back
    if (H < 8) H = kind === 'spark' ? 16 : Math.round(W / 1.45);   // no stylesheet: fall back to a sane shape
    this._w = W;
    this._h = Math.round(this.clientHeight);
    const covered = this._covered();
    let made;
    try {
      made = render(kind, this._data(), W, H, this._id, covered);
    } catch (err) {
      made = render('', null, W, H, this._id, covered);
    }
    this._label = made.label;
    this.innerHTML = made.markup;
    const svg = this.firstElementChild;
    if (svg) { try { addBars(svg); } catch (err) { /* figures simply keep no bar */ } }
    if (made.height) this._h = made.height;
  }
}

if (typeof customElements !== 'undefined') define('nw-chart', NwChart);
