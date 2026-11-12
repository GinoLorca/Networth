import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fmt, fmtSigned, fmtPlain, fmtCompact, splitMoney, roundCents, ratio, fmtPct, sum, MINUS } from '../js/model/money.js';

test('toCents parses the shapes banks and people write', () => {
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('$12'), 1200);
  assert.equal(toCents('(5.00)'), -500);
  assert.equal(toCents('-3'), -300);
  assert.equal(toCents('12.50-'), -1250);
  assert.equal(toCents(MINUS + '4.75'), -475);
  assert.equal(toCents('+ $6.5'), 650);
  assert.equal(toCents('.5'), 50);
  assert.equal(toCents('7.'), 700);
  assert.equal(toCents('0.005'), 1);
  assert.equal(toCents('0.004'), 0);
  assert.equal(toCents('19.999'), 2000);
  assert.equal(toCents(12.5), 1250);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(''), null);
  assert.equal(toCents('abc'), null);
  assert.equal(toCents('1.2.3'), null);
  assert.equal(toCents(null), null);
  assert.equal(toCents(NaN), null);
  assert.ok(Object.is(toCents('-0.00'), 0), 'never returns -0');
});

test('toCents never suffers binary float error', () => {
  assert.equal(toCents('8104.37'), 810437);
  assert.equal(toCents('2090.19'), 209019);
  assert.equal(toCents('640.58'), 64058);
  assert.equal(toCents('0.29'), 29);
  assert.equal(toCents('1.15'), 115);
});

test('fmt', () => {
  assert.equal(fmt(241786), '$2,417.86');
  assert.equal(fmt(-1429), MINUS + '$14.29');
  assert.equal(fmt(0), '$0.00');
  assert.equal(fmt(-0.2), '$0.00');
  assert.equal(fmt(5), '$0.05');
  assert.equal(fmt(4201935), '$42,019.35');
  assert.equal(fmt(241786, { decimals: 0 }), '$2,418');
  assert.equal(fmt(-49, { decimals: 0 }), '$0');
  assert.equal(fmt(null), '—');
  assert.equal(fmt(1165, { sign: 'always' }), '+$11.65');
  assert.equal(fmt(-1165, { sign: 'never' }), '$11.65');
  assert.equal(fmtSigned(-84), MINUS + '$0.84');
  assert.equal(fmtSigned(0), '$0.00');
  assert.equal(fmtPlain(475), '4.75');
});

test('fmtCompact', () => {
  assert.equal(fmtCompact(31200), '$312');
  assert.equal(fmtCompact(241786), '$2.42K');
  assert.equal(fmtCompact(8734000), '$87.3K');
  assert.equal(fmtCompact(10000000), '$100K');
  assert.equal(fmtCompact(100000000), '$1M');
  assert.equal(fmtCompact(125000000), '$1.25M');
  assert.equal(fmtCompact(-72512345), MINUS + '$725.1K');
  assert.equal(fmtCompact(0), '$0');
});

test('splitMoney for the ticker', () => {
  assert.deepEqual(splitMoney(241786.12), { neg: false, int: '2,417', dec: '86', sub: '12' });
  assert.deepEqual(splitMoney(0), { neg: false, int: '0', dec: '00', sub: '00' });
  assert.deepEqual(splitMoney(-1429.5), { neg: true, int: '14', dec: '29', sub: '50' });
  assert.deepEqual(splitMoney(99.999), { neg: false, int: '0', dec: '99', sub: '99' });
});

test('small helpers', () => {
  assert.equal(roundCents(10.5), 11);
  assert.ok(Object.is(roundCents(-0.4), 0));
  assert.equal(ratio(5, 10), 0.5);
  assert.equal(ratio(5, 0), 0);
  assert.equal(ratio(20, 10), 1);
  assert.equal(fmtPct(0.006), '0.6%');
  assert.equal(fmtPct(0.5), '50%');
  assert.equal(sum([{ a: 1 }, { a: 2 }, {}], (x) => x.a), 3);
});

test('toCents: one comma followed by exactly two digits and no point is a decimal comma', () => {
  assert.equal(toCents('4,75'), 475);
  assert.equal(toCents('$4,75'), 475);
  assert.equal(toCents('-12,50'), -1250);
  assert.equal(toCents('12,50-'), -1250);
  assert.equal(toCents('1,234'), 123400);
  assert.equal(toCents('1,234.50'), 123450);
  assert.equal(toCents('1,234,567'), 123456700);
  assert.equal(toCents('12,5'), 12500); // not two digits: the comma stays a separator
  assert.equal(toCents('1,23.4'), 12340); // a point is present: the comma is never the decimal mark
});
