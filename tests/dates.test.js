import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ymd, isYmd, addDays, diffDays, dow, monthOf, daysInMonth, startOfMonth, endOfMonth, addMonthsYm, addMonths,
  eachDay, monthDays, dayFraction, daysBetweenMs, fmtDate, fmtMonth, relDay, ageDays, fmtRunway, parseLooseDate,
  startOfDayMs, setNow, nowMs, today, fmtTime, gameDay, gameDayStartMs, gameDayFraction, feedDay, feedHasTime, weekStart,
} from '../js/model/dates.js';

test('ymd and validity', () => {
  assert.equal(ymd(new Date(2026, 10, 10, 14, 36).getTime()), '2026-11-10');
  assert.ok(isYmd('2026-02-28'));
  assert.ok(!isYmd('2026-02-30'));
  assert.ok(isYmd('2028-02-29'));
  assert.ok(!isYmd('2026-2-3'));
  assert.ok(!isYmd(null));
});

test('day arithmetic is calendar-based', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(addDays('2026-03-07', 2), '2026-03-09'); // across US spring-forward
  assert.equal(addDays('2026-10-31', 2), '2026-11-02'); // across US fall-back
  assert.equal(addDays('2027-12-31', 1), '2028-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(diffDays('2026-11-01', '2026-11-10'), 9);
  assert.equal(diffDays('2026-10-29', '2026-11-10'), 12);
  assert.equal(diffDays('2026-11-10', '2026-11-01'), -9);
  assert.equal(diffDays('2026-03-01', '2026-03-31'), 30);
  assert.equal(dow('2026-11-10'), 2); // Tuesday
  assert.equal(dow('2026-11-01'), 0); // Sunday
});

test('months', () => {
  assert.equal(monthOf('2026-11-10'), '2026-11');
  assert.equal(daysInMonth('2026-11'), 30);
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(startOfMonth('2026-11'), '2026-11-01');
  assert.equal(endOfMonth('2026-11'), '2026-11-30');
  assert.equal(addMonthsYm('2026-11', 2), '2027-01');
  assert.equal(addMonthsYm('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(addMonths('2026-11-15', 12), '2027-11-15');
  assert.equal(monthDays('2026-11').length, 30);
  assert.deepEqual(eachDay('2026-11-29', '2026-12-01'), ['2026-11-29', '2026-11-30', '2026-12-01']);
  assert.deepEqual(eachDay('2026-12-02', '2026-12-01'), []);
});

test('fraction of day and fractional spans', () => {
  const noon = new Date(2026, 10, 10, 12, 0).getTime();
  assert.equal(dayFraction(noon), 0.5);
  assert.equal(dayFraction(startOfDayMs('2026-11-10')), 0);
  const a = new Date(2026, 5, 10, 18, 0).getTime(); // June: no daylight-saving change nearby
  const b = new Date(2026, 5, 19, 6, 0).getTime();
  assert.ok(Math.abs(daysBetweenMs(a, b) - 8.5) < 1e-9);
  assert.equal(daysBetweenMs(noon, noon), 0);
});

test('formatting', () => {
  assert.equal(fmtDate('2026-11-10', 'long'), 'Tuesday, November 10, 2026');
  assert.equal(fmtDate('2026-11-10', 'full'), 'November 10, 2026');
  assert.equal(fmtDate('2026-11-10'), 'Nov 10, 2026');
  assert.equal(fmtDate('2026-11-10', 'short'), 'Nov 10');
  assert.equal(fmtDate('2026-11-10', 'dowshort'), 'Tue, Nov 10');
  assert.equal(fmtMonth('2026-11'), 'November 2026');
  assert.equal(fmtMonth('2026-11', 'short'), 'Nov 2026');
  assert.equal(relDay('2026-11-10', '2026-11-10'), 'today');
  assert.equal(relDay('2026-11-09', '2026-11-10'), 'yesterday');
  assert.equal(relDay('2026-11-01', '2026-11-10'), '9 days ago');
  assert.equal(relDay('2026-11-13', '2026-11-10'), 'in 3 days');
  assert.equal(ageDays('2026-10-29', '2026-11-10'), 12);
  assert.equal(ageDays('2026-11-12', '2026-11-10'), 0);
  assert.equal(fmtRunway(1.0065), '1d 0h');
  assert.equal(fmtRunway(0.46), '11h 02m');
  assert.equal(fmtRunway(75.3), '75d 7h');
  assert.equal(fmtRunway(0), '0h 00m');
  assert.equal(fmtTime(new Date(2026, 10, 10, 14, 36).getTime()), '2:36 PM');
  assert.equal(fmtTime(new Date(2026, 10, 10, 0, 5).getTime()), '12:05 AM');
});

test('loose date parsing for bank files', () => {
  assert.equal(parseLooseDate('2026-11-10'), '2026-11-10');
  assert.equal(parseLooseDate('11/10/2026'), '2026-11-10');
  assert.equal(parseLooseDate('11/10/26'), '2026-11-10');
  assert.equal(parseLooseDate('1/5/2026'), '2026-01-05');
  assert.equal(parseLooseDate('10/11/2026', { dayFirst: true }), '2026-11-10');
  assert.equal(parseLooseDate('10-Nov-2026'), '2026-11-10');
  assert.equal(parseLooseDate('Nov 10, 2026'), '2026-11-10');
  assert.equal(parseLooseDate('2026-11-10T08:15:00'), '2026-11-10');
  assert.equal(parseLooseDate('13/40/2026'), null);
  assert.equal(parseLooseDate('pending'), null);
  assert.equal(parseLooseDate(''), null);
});

test('the app clock can be set', () => {
  setNow(new Date(2026, 10, 10, 14, 36).getTime());
  assert.equal(today(), '2026-11-10');
  assert.ok(Math.abs(nowMs() - new Date(2026, 10, 10, 14, 36).getTime()) < 2000);
  setNow(null);
  assert.ok(Math.abs(nowMs() - Date.now()) < 50);
});

test('game day rolls over at the configured hour', () => {
  const late = new Date(2026, 5, 13, 1, 30).getTime(); // 1:30 am Saturday
  assert.equal(gameDay(late, 4), '2026-06-12');
  assert.equal(gameDay(late, 0), '2026-06-13');
  assert.equal(gameDay(new Date(2026, 5, 13, 4, 0).getTime(), 4), '2026-06-13');
  assert.equal(gameDayStartMs('2026-06-13', 4), new Date(2026, 5, 13, 4, 0).getTime());
  assert.equal(gameDayFraction(new Date(2026, 5, 13, 16, 0).getTime(), 4), 0.5);
  assert.equal(gameDayFraction(new Date(2026, 5, 13, 3, 59).getTime(), 4) > 0.99, true);
});

test('bank feed timestamps: date-only values keep their date', () => {
  const noonUtc = Date.UTC(2026, 5, 10, 12, 0, 0) / 1000;
  const midnightUtc = Date.UTC(2026, 5, 10, 0, 0, 0) / 1000;
  const midnightPacific = Date.UTC(2026, 5, 10, 8, 0, 0) / 1000;
  assert.equal(feedDay(noonUtc, 4), '2026-06-10');
  assert.equal(feedDay(midnightUtc, 4), '2026-06-10');
  assert.equal(feedDay(midnightPacific, 4), '2026-06-10');
  assert.equal(feedHasTime(noonUtc), false);
  const instant = new Date(2026, 5, 10, 21, 17, 30).getTime() / 1000; // a real local time
  assert.equal(feedHasTime(instant), true);
  assert.equal(feedDay(instant, 4), '2026-06-10');
  assert.equal(feedDay(0, 4), null);
  assert.equal(feedDay(undefined, 4), null);
});

test('week start is Monday', () => {
  assert.equal(weekStart('2026-06-10'), '2026-06-08'); // Wednesday -> Monday
  assert.equal(weekStart('2026-06-08'), '2026-06-08');
  assert.equal(weekStart('2026-06-14'), '2026-06-08'); // Sunday belongs to the week that began Monday
});
