import { afterEach, beforeEach, expect, test } from 'vitest';
import { tempDb } from '../../../test/helpers/db';
import { UserService } from '../users/userService';
import { COLOR_SCHEMES, resolveColorScheme } from './colorSchemes';
import { SettingsService } from './settingsService';

let handle: ReturnType<typeof tempDb>;
let settings: SettingsService;
let alice: number;
let bob: number;

beforeEach(() => {
  handle = tempDb();
  const users = new UserService(handle.db);
  const id = (name: string) => {
    const r = users.create(name, 'pw');
    if (!r.ok) throw new Error('create failed');
    return r.value.id;
  };
  alice = id('alice');
  bob = id('bob');
  settings = new SettingsService(handle.db);
});
afterEach(() => handle.cleanup());

test('resolveColorScheme prefers the user choice over the application default', () => {
  expect(resolveColorScheme('light', 'dark')).toBe('light');
  expect(resolveColorScheme('dark', 'light')).toBe('dark');
  expect(resolveColorScheme(null, 'light')).toBe('light');
  expect(resolveColorScheme(undefined, 'bogus')).toBe('dark');
  expect(resolveColorScheme('bogus', 'light')).toBe('light');
});

test('every registered scheme lists its three main colors', () => {
  expect(COLOR_SCHEMES.map((s) => s.id)).toEqual(['dark', 'light']);
  for (const scheme of COLOR_SCHEMES) expect(Object.keys(scheme.colors)).toEqual(['bg', 'text', 'primary']);
});

test('the application default is dark until changed, and people without a choice follow it', () => {
  expect(settings.applicationColorScheme()).toBe('dark');
  expect(settings.effectiveColorScheme(alice)).toBe('dark');
  expect(settings.effectiveColorScheme(null)).toBe('dark');

  expect(settings.setApplicationColorScheme('light').ok).toBe(true);
  expect(settings.effectiveColorScheme(alice)).toBe('light');
  expect(settings.effectiveColorScheme(null)).toBe('light');
});

test("a user's own choice overrides the default for that user only and can be cleared", () => {
  settings.setApplicationColorScheme('light');
  expect(settings.setUserColorScheme(alice, 'dark').ok).toBe(true);

  expect(settings.userColorScheme(alice)).toBe('dark');
  expect(settings.effectiveColorScheme(alice)).toBe('dark');
  expect(settings.userColorScheme(bob)).toBeNull();
  expect(settings.effectiveColorScheme(bob)).toBe('light');

  settings.setUserColorScheme(alice, null);
  expect(settings.userColorScheme(alice)).toBeNull();
  expect(settings.effectiveColorScheme(alice)).toBe('light');
});

test('unknown schemes are rejected', () => {
  expect(settings.setApplicationColorScheme('neon').ok).toBe(false);
  expect(settings.setUserColorScheme(alice, 'neon').ok).toBe(false);
  expect(settings.applicationColorScheme()).toBe('dark');
  expect(settings.userColorScheme(alice)).toBeNull();
});
