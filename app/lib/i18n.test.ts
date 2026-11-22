import { readFileSync } from 'node:fs';
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

  describe('raw catalog parity', () => {
    type Tree = { [key: string]: string | Tree };
    const raw = (locale: string): Tree =>
      JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf8')) as Tree;

    const flatten = (tree: Tree, prefix = ''): Map<string, string> => {
      const out = new Map<string, string>();
      for (const [key, value] of Object.entries(tree)) {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (typeof value === 'string') out.set(path, value);
        else for (const [k, v] of flatten(value, path)) out.set(k, v);
      }
      return out;
    };

    // Argument names of top-level ICU placeholders and rich-text tags, e.g. {id}, {state, select, ...}, <link>.
    const placeholders = (message: string): string[] => {
      const names = new Set<string>();
      let depth = 0;
      let start = -1;
      for (let i = 0; i < message.length; i++) {
        if (message[i] === '{') {
          if (depth === 0) start = i + 1;
          depth++;
        } else if (message[i] === '}') {
          depth--;
          if (depth === 0) names.add(message.slice(start, i).split(',')[0]!.trim());
        }
      }
      for (const m of message.matchAll(/<(\w+)>/g)) names.add(`<${m[1]}>`);
      return [...names].sort();
    };

    const english = flatten(raw('en'));

    for (const locale of locales.filter((l) => l !== defaultLocale)) {
      it(`${locale} has exactly the key paths of en`, () => {
        const catalog = flatten(raw(locale));
        expect([...catalog.keys()].filter((k) => !english.has(k))).toEqual([]);
        expect([...english.keys()].filter((k) => !catalog.has(k))).toEqual([]);
      });

      it(`${locale} uses the same ICU placeholders as en`, () => {
        const catalog = flatten(raw(locale));
        const mismatched = [...english]
          .filter(
            ([key, text]) => catalog.has(key) && placeholders(catalog.get(key)!).join() !== placeholders(text).join(),
          )
          .map(([key]) => key);
        expect(mismatched).toEqual([]);
      });
    }
  });
});
