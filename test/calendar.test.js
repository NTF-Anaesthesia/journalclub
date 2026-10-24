import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthGrid, parseMonth, monthKey } from '../src/calendar.js';

test('monthGrid lays a month out in whole weeks from Monday', () => {
  const oct = monthGrid(2026, 9); // 1 Oct 2026 is a Thursday
  assert.deepEqual(oct[0], [null, null, null, 1, 2, 3, 4]);
  assert.equal(oct.flat().filter(Boolean).length, 31);
  assert.ok(oct.every((w) => w.length === 7));
  assert.deepEqual(monthGrid(2021, 1).length, 4); // Feb 2021 starts on a Monday and fills four weeks exactly
});

test('parseMonth reads yyyy-mm and falls back to this month', () => {
  assert.deepEqual(parseMonth('2026-12'), { y: 2026, m: 11 });
  const now = new Date(2026, 3, 9);
  assert.deepEqual(parseMonth('2026-13', now), { y: 2026, m: 3 });
  assert.deepEqual(parseMonth(undefined, now), { y: 2026, m: 3 });
  assert.equal(monthKey(2026, 0), '2026-01');
});
