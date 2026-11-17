/**
 * The nightly wrap's day, in the time zone the night job runs in. The game day rolls over at 4 AM local time
 * (dates.gameDay reads local time), so the job runs with TZ set to the owner's zone. These tests run in
 * America/New_York, across the spring and fall clock changes of 2026, and show what a job left in UTC would get wrong.
 * Everything here is invented.
 */

process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addLate, emptyDay, exportWrap, nightFigures, readWrapFile, wrapDays } from '../js/model/wrap.js';
import { defaultState } from '../js/model/schema.js';
import { addAlertMove, alertFile, parseAlert } from '../js/model/alerts.js';
import { applyIncomeReading, rebuildIncome } from '../js/model/income.js';
import { gameDay } from '../js/model/dates.js';

const DAY_MS = 24 * 3600 * 1000;
const utc = (text) => Date.parse(text);
const ALERT = 'Northlight: A charge of $6.00 at FERNLEAF CAFE was made on your card ending in 4321.';

function record(nowMs) {
  const state = defaultState(nowMs - 100 * DAY_MS);
  state.settings.rolloverHour = 4;
  return state;
}

test('the zone is New York for these tests', () => {
  assert.equal(new Date(utc('2026-07-01T16:00:00Z')).getHours(), 12);
  assert.equal(new Date(utc('2026-12-01T17:00:00Z')).getHours(), 12);
});

test('an ordinary night: the day turns at 4 AM, not at midnight', () => {
  assert.equal(wrapDays(record(0), utc('2026-11-17T02:33:00Z')).today, '2026-11-16', '9:33 PM');
  assert.equal(wrapDays(record(0), utc('2026-11-17T08:59:00Z')).today, '2026-11-16', '3:59 AM');
  assert.equal(wrapDays(record(0), utc('2026-11-17T09:00:00Z')).today, '2026-11-17', '4:00 AM');
});

test('spring forward (March 8, 2026: 2 AM becomes 3 AM): the day still turns at 4 AM local', () => {
  assert.equal(wrapDays(record(0), utc('2026-03-08T07:59:00Z')).today, '2026-03-07', '3:59 AM EDT');
  assert.equal(wrapDays(record(0), utc('2026-03-08T08:00:00Z')).today, '2026-03-08', '4:00 AM EDT');
  assert.equal(wrapDays(record(0), utc('2026-03-09T01:33:00Z')).today, '2026-03-08', '9:33 PM EDT');
  // a card alert written at 2:30 AM on the phone's clock (an hour that does not exist) is the night before
  const now = utc('2026-03-09T01:33:00Z');
  const state = record(now);
  addAlertMove(state, parseAlert(ALERT), alertFile('20260308-023000-000.txt'), now);
  const { days } = wrapDays(state, now);
  assert.equal(days['2026-03-07'].out, 600);
  assert.deepEqual(days['2026-03-07'].seen.alerts, ['20260308-023000-000']);
  assert.equal(days['2026-03-08'].out, 0);
  assert.deepEqual(Object.keys(days), ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
});

test('fall back (November 1, 2026: 2 AM becomes 1 AM): both 1:30s belong to the night before', () => {
  assert.equal(gameDay(utc('2026-11-01T05:30:00Z'), 4), '2026-10-31', '1:30 AM EDT');
  assert.equal(gameDay(utc('2026-11-01T06:30:00Z'), 4), '2026-10-31', '1:30 AM EST');
  assert.equal(wrapDays(record(0), utc('2026-11-01T08:59:00Z')).today, '2026-10-31', '3:59 AM EST');
  assert.equal(wrapDays(record(0), utc('2026-11-01T09:00:00Z')).today, '2026-11-01', '4:00 AM EST');
  // payments marked in the repeated hour count on the night before; one marked after 4 AM on the new day
  const now = utc('2026-11-02T02:33:00Z');
  const state = record(now);
  const items = [
    { id: 'a', payer: 'p', cents: 1000, day: '2026-10-31', at: '2026-11-01T05:30:00.000Z' },
    { id: 'b', payer: 'p', cents: 2000, day: '2026-10-31', at: '2026-11-01T06:30:00.000Z' },
    { id: 'c', payer: 'p', cents: 4000, day: '2026-11-01', at: '2026-11-01T09:00:00.000Z' },
  ];
  const text = JSON.stringify({ format: 'income/1', what: 'Workshop', payers: [{ id: 'p', name: 'Robin' }], items });
  applyIncomeReading(state, { listed: [{ source: 'club', sha: 's' }], files: { club: { sha: 's', text } } }, now);
  state.income.shared.since = now - 30 * DAY_MS;
  state.income.shared.payers['club/p'] = { how: 'cash', at: now - 20 * DAY_MS };
  rebuildIncome(state, now);
  const { days } = wrapDays(state, now);
  assert.equal(days['2026-10-31'].in, 3000);
  assert.equal(days['2026-11-01'].in, 4000);
  // the night job reads them the same way
  const income = { sources: { club: { what: 'Workshop', from: null, payers: [{ id: 'p', name: 'Robin' }], items: items.map((i) => ({ ...i, at: Date.parse(i.at) })) } }, shared: state.income.shared };
  const { fig } = addLate(null, '2026-10-31', { today: '2026-11-01', rollover: 4, inbox: [], income });
  assert.equal(fig.in, 3000);
});

test('the same instant in UTC lands on another day: the job must run in the owner’s zone', () => {
  const late = utc('2026-11-17T04:15:00Z'); // 11:15 PM in New York
  assert.equal(gameDay(late, 4), '2026-11-16');
  process.env.TZ = 'UTC';
  try {
    assert.equal(gameDay(late, 4), '2026-11-17');
  } finally {
    process.env.TZ = 'America/New_York';
  }
  assert.equal(gameDay(late, 4), '2026-11-16');
});

/* ------------------------------------------------- a device whose clock, zone or rollover differs from the job's */

const STAMP = '20261117-040010-000'; // the phone wrote it at 4:00:10 AM in New York on November 17
const DINER = 'Northlight: A charge of $31.00 at DINER was made on your card ending in 4321.';
const inboxOf = (stem, text) => [{ name: stem + '.txt', size: Buffer.byteLength(text), text }];
const JOB_LATE = { today: '2026-11-17', rollover: 4, inbox: inboxOf(STAMP, DINER), income: { sources: {}, shared: null } };

/** The device's file, made by the app's own exporter after the alert reached the device. */
function deviceFileAfterAlert(deviceNowMs, rolloverHour = 4) {
  const state = record(deviceNowMs);
  state.settings.rolloverHour = rolloverHour;
  addAlertMove(state, parseAlert(DINER), alertFile(STAMP + '.txt'), deviceNowMs);
  const read = readWrapFile(JSON.stringify(exportWrap(state, deviceNowMs, 'den')));
  assert.equal(read.ok, true, read.problem);
  return read.file;
}

function countedOnce(file, late = JOB_LATE, others = []) {
  const counted = Object.entries(file.days).filter(([, fig]) => fig.parts.alerts === 3100).map(([day]) => day);
  assert.deepEqual(counted.length, 1, 'the device counted it on one day');
  const { figs, alerts } = nightFigures([file, ...others], late);
  assert.equal(alerts, 0, 'the job does not add it again');
  const total = Object.values(figs).reduce((sum, fig) => sum + fig.parts.alerts, 0);
  assert.equal(total, 3100, 'counted once across the nights’ figures');
  return counted[0];
}

test('a device clock behind the phone at the rollover: the alert counts once', () => {
  // the device's clock says 3:59 AM: the alert is dated to its today, November 16 (alerts.alertDay)
  const file = deviceFileAfterAlert(new Date(2026, 10, 17, 3, 59).getTime());
  assert.equal(countedOnce(file), '2026-11-16');
  // the job, run that evening, dates the same alert November 17 (no device file holds that day)
  assert.equal(nightFigures([file], JOB_LATE).figs['2026-11-17'].out, 0);
});

test('a device whose zone is behind the phone’s: the alert counts once', () => {
  process.env.TZ = 'America/Chicago';
  let file;
  try {
    file = deviceFileAfterAlert(utc('2026-11-17T09:30:00Z')); // 3:30 AM in Chicago, 4:30 AM in New York
  } finally {
    process.env.TZ = 'America/New_York';
  }
  assert.equal(countedOnce(file), '2026-11-16');
});

test('a device with another rollover hour: the alert counts once, whichever file the job takes its rollover from', () => {
  // device den turns its day at 5 AM: the 4:00 AM alert is its November 16; device elm (4 AM, written last) gives the
  // job its rollover; den read the bank last, so its figures are the ones used
  const file = { ...deviceFileAfterAlert(new Date(2026, 10, 17, 20, 0).getTime(), 5), readAt: '2026-11-18T00:50:00.000Z' };
  const elm = { ...file, device: 'elm', rollover: 4, readAt: '2026-11-17T12:00:00.000Z', writtenAt: '2026-11-18T02:00:00.000Z', days: {} };
  for (const day of Object.keys(file.days)) elm.days[day] = emptyDay(file.days[day].status);
  assert.equal(countedOnce(file, JOB_LATE, [elm]), '2026-11-16');
});

test('marked payments: a payment a picked figure has dealt with counts once, whatever day the job gives it', () => {
  const now = utc('2026-11-18T02:33:00Z');
  const income = {
    sources: { club: { what: 'Workshop', from: null, payers: [{ id: 'p', name: 'Robin' }], items: [{ id: 'x', payer: 'p', cents: 2500, day: '2026-11-17', at: utc('2026-11-17T09:00:10Z') }] } },
    shared: { since: now - 30 * DAY_MS, payers: { 'club/p': { how: 'cash', at: now - 20 * DAY_MS } }, items: {}, counts: [] },
  };
  // the device (5 AM rollover) dated it November 16 and counted it there
  const days = {};
  for (let d = 10; d <= 17; d += 1) days['2026-11-' + d] = emptyDay(d === 17 ? 'live' : 'provisional');
  days['2026-11-16'] = { ...emptyDay('provisional'), in: 2500, parts: { ...emptyDay().parts, cash: 2500 }, seen: { alerts: [], income: ['club/x'] } };
  const file = { format: 'wrap/1', device: 'den', writtenAt: '2026-11-17T20:00:00.000Z', readAt: '2026-11-17T19:00:00.000Z', dataAt: null, rollover: 5, countPending: true, days };
  const { figs, payments } = nightFigures([file], { today: '2026-11-17', rollover: 4, inbox: [], income });
  assert.equal(payments, 0);
  assert.equal(Object.values(figs).reduce((sum, fig) => sum + fig.in, 0), 2500);
});
