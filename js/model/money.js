/**
 * Money helpers.
 *
 * Every stored amount in Networth is an INTEGER number of cents. Fractional
 * cents exist only inside live accrual (the ticking estimate) and are rounded
 * when shown. Never store dollars as floats.
 */

/** True minus sign, used for every negative amount on screen. */
export const MINUS = '−';

/**
 * Parse user or bank input into integer cents.
 * Accepts "1,234.56", "$12", "(5.00)", "-3", "12.50-", "−4.75", "4,75" (a decimal comma), 12.5 (a number of dollars).
 * @param {string|number|null|undefined} input
 * @returns {number|null} integer cents, or null when the input is not a number
 */
export function toCents(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? normalizeZero(Math.round(input * 100)) : null;
  let s = String(input).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/−/g, '-').replace(/[\s$]/g, '').replace(/usd$/i, '');
  // One comma followed by exactly two digits and no point is a decimal comma ("4,75" is 4.75);
  // every other comma is a thousands separator ("1,234" is 1234).
  if (!s.includes('.') && /^[^,]*,\d{2}(-?)$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const two = (frac + '00').slice(0, 2);
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5;
  const cents = Number(whole || '0') * 100 + Number(two) + (roundUp ? 1 : 0);
  return normalizeZero(neg ? -cents : cents);
}

function normalizeZero(n) { return n === 0 ? 0 : n; }

/** Round a possibly fractional cent amount to integer cents (never returns -0). */
export function roundCents(x) {
  return normalizeZero(Math.round(x));
}

/**
 * Format cents as money: "$2,417.86", "−$14.29".
 * @param {number|null|undefined} cents
 * @param {{sign?: 'auto'|'always'|'never', decimals?: 0|2, symbol?: string}} [opts]
 *   sign 'always' prefixes "+" on positive amounts; 'never' drops the sign.
 */
export function fmt(cents, opts = {}) {
  const { sign = 'auto', decimals = 2, symbol = '$' } = opts;
  if (cents == null || !Number.isFinite(cents)) return '—';
  const rounded = decimals === 0 ? Math.round(cents / 100) * 100 : Math.round(cents);
  const abs = Math.abs(rounded);
  const dollars = Math.floor(abs / 100);
  const body = dollars.toLocaleString('en-US') + (decimals === 0 ? '' : '.' + String(abs % 100).padStart(2, '0'));
  let prefix = '';
  if (sign !== 'never' && abs > 0) {
    if (rounded < 0) prefix = MINUS;
    else if (sign === 'always') prefix = '+';
  }
  return prefix + symbol + body;
}

/** "+$11.65" / "−$14.29" / "$0.00" */
export function fmtSigned(cents, opts = {}) {
  return fmt(cents, { ...opts, sign: 'always' });
}

/** "2,417.86" — no currency symbol (scoresheet notation). Negative uses the true minus. */
export function fmtPlain(cents, opts = {}) {
  return fmt(cents, { ...opts, symbol: '' });
}

/** Compact money for axes and tight labels: "$312", "$1.3K", "$91.8K", "$1.25M". */
export function fmtCompact(cents) {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const neg = cents < 0;
  const d = Math.abs(cents) / 100;
  let body;
  if (d >= 999_950) body = trimZeros((d / 1_000_000).toFixed(d >= 9_999_500 ? 1 : 2)) + 'M';
  else if (d >= 9_995) body = trimZeros((d / 1000).toFixed(1)) + 'K';
  else if (d >= 1000) body = trimZeros((d / 1000).toFixed(2)) + 'K';
  else body = String(Math.round(d));
  return (neg && body !== '0' ? MINUS : '') + '$' + body;
}

function trimZeros(s) {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Split a (possibly fractional) cent value for the hero ticker.
 * 241786.12 -> { neg: false, int: "2,417", dec: "86", sub: "12" }
 * `sub` is the two digits after the cents (hundredths of a cent), floored so the ticker never shows a value it has not reached.
 */
export function splitMoney(centsFloat) {
  const neg = centsFloat < 0;
  const abs = Math.abs(centsFloat);
  const hundredths = Math.floor(abs * 100 + 1e-6);
  const sub = hundredths % 100;
  const cents = Math.floor(hundredths / 100);
  return {
    neg: neg && hundredths > 0,
    int: Math.floor(cents / 100).toLocaleString('en-US'),
    dec: String(cents % 100).padStart(2, '0'),
    sub: String(sub).padStart(2, '0'),
  };
}

/** Sum integer cents over a list. */
export function sum(list, pick = (x) => x) {
  let total = 0;
  for (const item of list) total += pick(item) || 0;
  return total;
}

/** part / whole as a 0..1 fraction, safe for zero and clamped. */
export function ratio(part, whole) {
  if (!whole || !Number.isFinite(part / whole)) return 0;
  return Math.min(1, Math.max(0, part / whole));
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Percentage text: 0.3456 -> "34.6%"; digits configurable. */
export function fmtPct(fraction, digits = 1) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return (fraction * 100).toFixed(digits).replace(/\.0+$/, '').replace(/^-/, MINUS) + '%';
}
