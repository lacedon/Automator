import { describe, expect, it } from 'vitest';
import { defaultLocale, isLocale, loadMessages, locales, mergeMessages } from './i18n';

describe('i18n', () => {
  it('falls back to the default catalog for missing keys', () => {
    expect(mergeMessages({ a: { x: 'X', y: 'Y' }, b: 'B' }, { a: { x: 'Ж' } })).toEqual({
      a: { x: 'Ж', y: 'Y' },
      b: 'B',
    });
  });

  it('loads every supported locale with all default keys present', () => {
    const keys = Object.keys(loadMessages(defaultLocale));
    for (const locale of locales) expect(Object.keys(loadMessages(locale))).toEqual(keys);
  });

  it('recognises only supported locales', () => {
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});
