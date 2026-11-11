import { describe, expect, it } from 'vitest';
import { formatFile } from './RunFileLinks';

describe('formatFile', () => {
  it('pretty-prints result.json', () => {
    expect(formatFile('result.json', '{"a":1}')).toBe('{\n  "a": 1\n}');
  });
  it('leaves invalid JSON and other files untouched', () => {
    expect(formatFile('result.json', 'nope')).toBe('nope');
    expect(formatFile('prompt.md', '{"a":1}')).toBe('{"a":1}');
  });
});
