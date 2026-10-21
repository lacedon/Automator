import { expect, test } from 'vitest';
import { formatElapsed, formatRelative } from './format';

const S = 1000;
const M = 60 * S;
const H = 60 * M;

test('formats elapsed time as mm:ss', () => {
  expect(formatElapsed(0)).toBe('00:00');
  expect(formatElapsed(4 * M + 12 * S + 900)).toBe('04:12');
  expect(formatElapsed(125 * M)).toBe('125:00');
  expect(formatElapsed(-5 * S)).toBe('00:00');
});

test('formats elapsed time with a limit', () => {
  expect(formatElapsed(4 * M + 12 * S, 30 * M)).toBe('04:12 / 30:00');
});

test('formats relative time', () => {
  const now = Date.parse('2026-10-21T12:00:00');
  expect(formatRelative(now - 20 * S, now)).toBe('just now');
  expect(formatRelative(now - 3 * M, now)).toBe('3m ago');
  expect(formatRelative(now - 2 * H - 5 * M, now)).toBe('2h ago');
  expect(formatRelative(now - 30 * H, now)).toBe('yesterday');
  expect(formatRelative(now - 5 * 24 * H, now)).toBe('5d ago');
  expect(formatRelative(now + 10 * S, now)).toBe('just now');
});
