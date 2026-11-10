import { expect, test } from 'vitest';
import { safeNext } from './safeNext';

test.each([
  ['/runs/1', '/runs/1'],
  ['/', '/'],
  ['//evil.example', '/'],
  ['/\\evil.example', '/'],
  ['https://evil.example', '/'],
  ['', '/'],
  [undefined, '/'],
])('safeNext(%s) is %s', (input, expected) => {
  expect(safeNext(input)).toBe(expected);
});
