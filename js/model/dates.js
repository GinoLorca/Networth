/**
 * Calendar-day helpers.
 *
 * A "day" in Networth is a LOCAL calendar day written 'YYYY-MM-DD' (a Ymd string).
 * Ymd strings compare correctly with < and >. Day arithmetic is done on the
 * calendar (never by adding 86,400,000 ms) so daylight-saving changes cannot
 * shift a date. Timestamps (epoch ms) are used only for "when was this logged"
 * and for the fraction of the current day that has elapsed.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---- the app clock (overridable for tests, demos and screenshots) ---- */

let clockOffset = 0;

/** Current time in epoch ms. Use this instead of Date.now() everywhere. */
export function nowMs() {
  return Date.now() + clockOffset;
}

/** Pretend "now" is the given epoch ms (time keeps running from there). Pass null to reset. */
export function setNow(ms) {
  clockOffset = ms == null ? 0 : ms - Date.now();
}

/* ---- construction and parsing ---- */

function pad(n) { return String(n).padStart(2, '0'); }

/** Ymd for an epoch-ms timestamp (default: the app clock) in local time. */
export function ymd(ms = nowMs()) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** Today's Ymd on the app clock. */
export function today() {
  return ymd(nowMs());
}

export function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parts(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y + '-' + pad(m));
}

/** { y, m (1-12), d } */
export function parts(s) {
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

export function makeYmd(y, m, d) {
  return String(y).padStart(4, '0') + '-' + pad(m) + '-' + pad(d);
}

/** Local midnight (epoch ms) at the start of the given day. */
export function startOfDayMs(s) {
  const { y, m, d } = parts(s);
  return new Date(y, m - 1, d).getTime();
}

/** Parse loose date text from bank files: 2026-11-10, 11/10/2026, 11/10/26, 10-Nov-2026, "Nov 10, 2026". Returns Ymd or null. */
export function parseLooseDate(text, { dayFirst = false } = {}) {
  if (text == null) return null;
  const s = String(text).trim();
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/.exec(s))) {
    const a = Number(m[1]), b = Number(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return dayFirst ? valid(y, b, a) : valid(y, a, b);
  }
  if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s,]+(\d{4}|\d{2})(?!\d)/.exec(s))) {
    const mon = monthIndex(m[2]);
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mon ? valid(y, mon, Number(m[1])) : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s))) {
    const mon = monthIndex(m[1]);
    return mon ? valid(Number(m[3]), mon, Number(m[2])) : null;
  }
  return null;
}

function monthIndex(name) {
  const i = MONTHS_SHORT.findIndex((x) => x.toLowerCase() === name.slice(0, 3).toLowerCase());
  return i < 0 ? 0 : i + 1;
}

function valid(y, m, d) {
  const s = makeYmd(y, m, d);
  return isYmd(s) ? s : null;
}

/* ---- arithmetic ---- */

function utc(s) {
  const { y, m, d } = parts(s);
  return Date.UTC(y, m - 1, d);
}

/** Add n calendar days (n may be negative). */
export function addDays(s, n) {
  const t = new Date(utc(s) + n * 86400000);
  return makeYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole calendar days from a to b (b - a). diffDays('2026-11-01','2026-11-10') === 9. */
export function diffDays(a, b) {
  return Math.round((utc(b) - utc(a)) / 86400000);
}

/** Day of week, 0 = Sunday ... 6 = Saturday. */
export function dow(s) {
  return new Date(utc(s)).getUTCDay();
}

/** 'YYYY-MM' of a Ymd. */
export function monthOf(s) {
  return s.slice(0, 7);
}

/** Number of days in 'YYYY-MM'. */
export function daysInMonth(ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function startOfMonth(ym) { return ym.slice(0, 7) + '-01'; }
export function endOfMonth(ym) { return ym.slice(0, 7) + '-' + pad(daysInMonth(ym.slice(0, 7))); }

/** Add n months to 'YYYY-MM' -> 'YYYY-MM'. */
export function addMonthsYm(ym, n) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const idx = y * 12 + (m - 1) + n;
  return String(Math.floor(idx / 12)).padStart(4, '0') + '-' + pad((idx % 12 + 12) % 12 + 1);
}

/**
 * Add n months to a Ymd, clamping to the end of shorter months.
 * `anchorDay` keeps month-end schedules stable: addMonths('2026-02-28', 1, 31) === '2026-03-31'.
 */
export function addMonths(s, n, anchorDay) {
  const { d } = parts(s);
  const ym = addMonthsYm(monthOf(s), n);
  const day = Math.min(anchorDay || d, daysInMonth(ym));
  return ym + '-' + pad(day);
}

/** Every Ymd from a to b inclusive (empty when a > b). */
export function eachDay(a, b) {
  const out = [];
  for (let s = a; s <= b; s = addDays(s, 1)) out.push(s);
  return out;
}

/** All days of 'YYYY-MM'. */
export function monthDays(ym) {
  return eachDay(startOfMonth(ym), endOfMonth(ym));
}

export function minYmd(a, b) { return a <= b ? a : b; }
export function maxYmd(a, b) { return a >= b ? a : b; }

/**
 * Fraction (0..1) of the local calendar day that has elapsed at timestamp ms.
 * Correct on 23- and 25-hour daylight-saving days.
 */
export function dayFraction(ms = nowMs()) {
  const day = ymd(ms);
  const start = startOfDayMs(day);
  const end = startOfDayMs(addDays(day, 1));
  return Math.min(1, Math.max(0, (ms - start) / (end - start)));
}

/* ---- the game day (a day that rolls over a few hours after midnight) ---- */

/** Game day of a timestamp: the calendar day that started at the most recent `rolloverHour`:00. */
export function gameDay(ms = nowMs(), rolloverHour = 0) {
  const d = new Date(ms);
  if (d.getHours() < rolloverHour) return addDays(ymd(ms), -1);
  return ymd(ms);
}

/** Timestamp at which a game day starts (local `rolloverHour`:00 on that calendar day). */
export function gameDayStartMs(day, rolloverHour = 0) {
  const { y, m, d } = parts(day);
  return new Date(y, m - 1, d, rolloverHour).getTime();
}

/** Fraction (0..1) of the game day that has elapsed at timestamp ms. */
export function gameDayFraction(ms = nowMs(), rolloverHour = 0) {
  const day = gameDay(ms, rolloverHour);
  const start = gameDayStartMs(day, rolloverHour);
  const end = gameDayStartMs(addDays(day, 1), rolloverHour);
  return Math.min(1, Math.max(0, (ms - start) / (end - start)));
}

/**
 * Day of a timestamp that came from a bank feed (epoch SECONDS).
 * Banks mostly send date-only values encoded as an exact hour (midnight in some US zone, or
 * noon UTC); those must be read as the UTC calendar date or they slip a day in local time.
 * Anything else is a real instant and is converted with the game-day rollover.
 */
export function feedDay(epochSeconds, rolloverHour = 0) {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return null;
  const secOfDay = ((epochSeconds % 86400) + 86400) % 86400;
  if (secOfDay % 3600 === 0 && secOfDay <= 12 * 3600) {
    const t = new Date(epochSeconds * 1000);
    return makeYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  return gameDay(epochSeconds * 1000, rolloverHour);
}

/** True when a feed timestamp (epoch seconds) carries a real time of day rather than a bare date. */
export function feedHasTime(epochSeconds) {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) return false;
  const secOfDay = ((epochSeconds % 86400) + 86400) % 86400;
  return !(secOfDay % 3600 === 0 && secOfDay <= 12 * 3600);
}

/** Monday (Ymd) of the calendar week containing the given day. */
export function weekStart(s) {
  return addDays(s, -((dow(s) + 6) % 7));
}

/** Fractional days between two timestamps, measured on the local calendar (DST-safe). */
export function daysBetweenMs(fromMs, toMs) {
  const a = ymd(fromMs), b = ymd(toMs);
  return diffDays(a, b) + dayFraction(toMs) - dayFraction(fromMs);
}

/* ---- formatting ---- */

/**
 * Format a Ymd.
 *  'long'   Tuesday, November 10, 2026
 *  'full'   November 10, 2026
 *  'medium' Nov 10, 2026
 *  'short'  Nov 10
 *  'dow'    Tue
 *  'dowlong' Tuesday
 *  'dowshort' Tue, Nov 10
 *  'numeric' 11/10
 */
export function fmtDate(s, style = 'medium') {
  if (!s) return '—';
  const { y, m, d } = parts(s);
  const w = dow(s);
  switch (style) {
    case 'long': return DAYS[w] + ', ' + MONTHS[m - 1] + ' ' + d + ', ' + y;
    case 'full': return MONTHS[m - 1] + ' ' + d + ', ' + y;
    case 'short': return MONTHS_SHORT[m - 1] + ' ' + d;
    case 'dow': return DAYS_SHORT[w];
    case 'dowlong': return DAYS[w];
    case 'dowshort': return DAYS_SHORT[w] + ', ' + MONTHS_SHORT[m - 1] + ' ' + d;
    case 'numeric': return m + '/' + d;
    default: return MONTHS_SHORT[m - 1] + ' ' + d + ', ' + y;
  }
}

/** 'YYYY-MM' -> "November 2026" ('long') or "Nov 2026" ('short') or "November" ('name'). */
export function fmtMonth(ym, style = 'long') {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  if (style === 'name') return MONTHS[m - 1];
  return (style === 'short' ? MONTHS_SHORT[m - 1] : MONTHS[m - 1]) + ' ' + y;
}

/** "today", "yesterday", "tomorrow", "9 days ago", "in 3 days". */
export function relDay(s, ref = today()) {
  const n = diffDays(ref, s);
  if (n === 0) return 'today';
  if (n === -1) return 'yesterday';
  if (n === 1) return 'tomorrow';
  return n < 0 ? -n + ' days ago' : 'in ' + n + ' days';
}

/** Age of a date in whole days relative to ref (0 = today, 9 = nine days old). */
export function ageDays(s, ref = today()) {
  return Math.max(0, diffDays(s, ref));
}

/** Clock time of a timestamp: "2:36 PM". */
export function fmtTime(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + pad(d.getMinutes()) + ' ' + ap;
}

/** A duration given in days as clock-like text: 1.02 -> "1d 0h", 0.46 -> "11h 02m", 75.3 -> "75d 7h". */
export function fmtRunway(days) {
  if (days == null || !Number.isFinite(days) || days < 0) return '—';
  const totalMinutes = Math.floor(days * 24 * 60 + 1e-6);
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d >= 1) return d + 'd ' + h + 'h';
  return h + 'h ' + pad(m) + 'm';
}
