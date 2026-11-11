import en from '../../messages/en.json';
import es from '../../messages/es.json';
import ru from '../../messages/ru.json';
import zh from '../../messages/zh.json';

export const locales = ['en', 'es', 'zh', 'ru'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

type Messages = { [key: string]: string | Messages };

const catalogs: Record<Locale, Messages> = { en, es, zh, ru };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/** Deep-merges a locale catalog over the default one, so missing keys fall back to English. */
export function mergeMessages(base: Messages, override: Messages): Messages {
  const result: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] = typeof value === 'object' && typeof existing === 'object' ? mergeMessages(existing, value) : value;
  }
  return result;
}

export function loadMessages(locale: Locale): Messages {
  return mergeMessages(catalogs[defaultLocale], catalogs[locale]);
}

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(locale: Locale, value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(value);
}
