import { expect, test, vi } from 'vitest';

vi.mock('./core', () => ({ getCore: () => null }));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));

const { parseScope, projectHue } = await import('./scope');

const projects = [{ id: 2, name: 'Alpha', repositories: [], promptAddition: '' }];

test('parseScope accepts none and existing Project ids only', () => {
  expect(parseScope(undefined, projects)).toBeNull();
  expect(parseScope('none', projects)).toBe('none');
  expect(parseScope('2', projects)).toBe(2);
  expect(parseScope('9', projects)).toBeNull();
  expect(parseScope('abc', projects)).toBeNull();
});

test('projectHue is stable and within the hue range', () => {
  expect(projectHue('Alpha')).toBe(projectHue('Alpha'));
  expect(projectHue('Alpha')).toBeLessThan(360);
});
