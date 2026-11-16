/**
 * The clock's payday countdown (ARCHITECTURE section 9, Board): how far off the next payday is, in words beside the
 * days on the clock, and where it falls on the 7-day runway. Pure: days in, words and a fraction out (importable
 * under node for the tests).
 */

import { diffDays, fmtDate, isYmd } from '../model/dates.js';

/** How many days away the next payday is, or null when no countdown is shown. */
function daysToPayday(today, clock) {
  if (!clock || !isYmd(today) || !isYmd(clock.nextPayday)) return null;
  // the clock already speaks for the payday itself ("Payday is today.") and for an awaited one
  // ("Pay expected … is not on the bank's record yet."): no countdown then
  if (isYmd(clock.payAwaited) || clock.nextPayday <= today) return null;
  const n = diffDays(today, clock.nextPayday);
  return n >= 1 ? n : null;
}

/**
 * "Payday tomorrow · Sat, Nov 15" or "Payday in 6 days · Fri, Nov 20"; '' when no payday is known, on the payday
 * itself and while a payday's deposit is awaited.
 * @param {string} today  the game day
 * @param {{ nextPayday: string|null, payAwaited?: string|null }} clock
 */
export function paydayWords(today, clock) {
  const n = daysToPayday(today, clock);
  if (n === null) return '';
  return 'Payday ' + (n === 1 ? 'tomorrow' : 'in ' + n + ' days') + ' · ' + fmtDate(clock.nextPayday, 'dowshort');
}

/**
 * Where the next payday falls on the runway of `segments` days, as a fraction of its width (n / segments), or
 * null when the countdown is not shown or the payday lies beyond the runway.
 */
export function paydayMark(today, clock, segments) {
  const n = daysToPayday(today, clock);
  if (n === null || !(segments > 0) || n > segments) return null;
  return n / segments;
}
