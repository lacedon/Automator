import { expect, test } from 'vitest';
import { formatDuration, parseDuration } from './duration';

test('parses units', () => {
  expect(parseDuration('90s')).toBe(90_000);
  expect(parseDuration('15m')).toBe(900_000);
  expect(parseDuration('2h')).toBe(7_200_000);
  expect(parseDuration('1d')).toBe(86_400_000);
});
test('rejects bad input', () => { expect(() => parseDuration('15')).toThrow('Invalid duration: 15'); expect(() => parseDuration('-1m')).toThrow(); });
test('formats largest whole unit', () => { expect(formatDuration(900_000)).toBe('15m'); expect(formatDuration(7_200_000)).toBe('2h'); expect(formatDuration(90_000)).toBe('90s'); });
