import { describe, expect, it } from 'vitest';
import { type Config, createConfigSchema } from '../config/schema';
import { intervalFor, isWithinWorkingHours, nextWindowStart } from './schedule';

const config: Config = { ...createConfigSchema('/cfg').parse({ repositories: {}, gitlab: {} }), configDir: '/cfg' };
const wh = config.schedule.workingHours;
// 2026-10-21 is a Wednesday.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();

describe('isWithinWorkingHours', () => {
  it.each([
    ['Wed 07:59', at(21, 7, 59), false],
    ['Wed 08:00', at(21, 8, 0), true],
    ['Wed 18:59', at(21, 18, 59), true],
    ['Wed 19:00', at(21, 19, 0), false],
    ['Sat 10:00', at(24, 10, 0), false],
  ])('%s → %s', (_label, t, expected) => {
    expect(isWithinWorkingHours(t, wh)).toBe(expected);
  });
});

describe('nextWindowStart', () => {
  it('Fri 19:30 → Mon 08:00', () => { expect(nextWindowStart(at(23, 19, 30), wh)).toBe(at(26, 8, 0)); });
  it('Tue 06:00 → Tue 08:00', () => { expect(nextWindowStart(at(20, 6, 0), wh)).toBe(at(20, 8, 0)); });
  it('returns t itself inside working hours', () => { expect(nextWindowStart(at(21, 10, 15), wh)).toBe(at(21, 10, 15)); });
  it('throws when working hours define no window', () => {
    expect(() => nextWindowStart(at(21, 6, 0), { ...wh, days: [] })).toThrow('no working days');
    expect(() => nextWindowStart(at(21, 6, 0), { ...wh, start: '19:00', end: '08:00' })).toThrow('define no window');
  });
});

describe('intervalFor', () => {
  it('uses override, then kind default (mr 15m, jira/free 2h)', () => {
    expect(intervalFor({ kind: 'mr', intervalMs: 60_000 }, config)).toBe(60_000);
    expect(intervalFor({ kind: 'jira', intervalMs: 60_000 }, config)).toBe(60_000);
    expect(intervalFor({ kind: 'mr', intervalMs: null }, config)).toBe(900_000);
    expect(intervalFor({ kind: 'jira', intervalMs: null }, config)).toBe(7_200_000);
    expect(intervalFor({ kind: 'free', intervalMs: null }, config)).toBe(7_200_000);
  });
});
