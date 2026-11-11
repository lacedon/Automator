import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, loadMessages } from './i18n';

// The per-project locale setting is wired in a follow-up; until then every request uses the default locale.
export default getRequestConfig(async () => ({
  locale: defaultLocale,
  messages: loadMessages(defaultLocale),
}));
