import { describe, expect, it } from 'vitest';
import { defaultLocale, formatDate, formatNumber, isLocale, loadMessages, locales, mergeMessages } from './i18n';

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

  it('formats numbers and dates per locale', () => {
    expect(formatNumber('en', 1234.5)).toBe('1,234.5');
    expect(formatNumber('ru', 1234.5)).not.toBe(formatNumber('en', 1234.5));
    expect(formatDate('en', Date.UTC(2024, 0, 2), { dateStyle: 'short' })).toBe('1/2/24');
    expect(formatDate('ru', Date.UTC(2024, 0, 2), { dateStyle: 'short' })).toBe('02.01.2024');
  });
});
