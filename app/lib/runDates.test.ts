import { expect, test } from 'vitest';
import { runDates } from './runDates';

test('date filters cover complete local calendar days', () => {
  expect(runDates('2026-11-04', '2026-11-04')).toEqual({
    ok: true,
    startedFrom: new Date(2026, 10, 4).getTime(),
    startedBefore: new Date(2026, 10, 5).getTime(),
  });
  expect(runDates('', '')).toEqual({ ok: true, startedFrom: undefined, startedBefore: undefined });
  expect(runDates('', '2026-12-31')).toEqual({
    ok: true,
    startedFrom: undefined,
    startedBefore: new Date(2027, 0, 1).getTime(),
  });
});

test('invalid or reversed calendar dates produce a visible validation error', () => {
  for (const [from, to] of [
    ['2026-02-30', ''],
    ['2026-13-01', ''],
    ['11/04/2026', ''],
    ['', 'invalid'],
    ['2026-11-05', '2026-11-04'],
  ]) {
    expect(runDates(from!, to!)).toMatchObject({ ok: false, error: expect.any(String) });
  }
});
