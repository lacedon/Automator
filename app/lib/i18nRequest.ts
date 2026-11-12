import { getRequestConfig } from 'next-intl/server';
import { getCore } from './core';
import { loadMessages } from './i18n';
import { currentSelection } from './scope';

// The language is a Project setting: the selected Project's effective config decides, otherwise the global one.
export default getRequestConfig(async () => {
  const selection = await currentSelection().catch(() => null);
  const locale = getCore().configs.forProject(typeof selection === 'number' ? selection : null).locale;
  return { locale, messages: loadMessages(locale) };
});
