import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { expect, test, vi } from 'vitest';
import en from '../../messages/en.json';
import { MobileNavigation, Sidebar } from './Sidebar';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const counts = { watches: 0, queued: 0 };
const chats = [
  { id: 1, title: 'waiting chat', status: 'needs-you' as const },
  { id: 2, title: 'queued chat', status: 'queued' as const },
  { id: 3, title: 'running chat', status: 'running' as const },
  { id: 4, title: 'failed chat', status: 'error' as const },
  { id: 5, title: 'done chat', status: null },
];

for (const [name, Nav] of [
  ['desktop sidebar', Sidebar],
  ['mobile navigation', MobileNavigation],
] as const) {
  test(`${name} badges chats whose latest run needs you, errored, is queued or running`, () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- the provider's props type requires children
      createElement(NextIntlClientProvider, {
        locale: 'en',
        messages: en,
        children: createElement(Nav, { counts, chats }),
      }),
    );
    expect(html.match(/class="pill /g)).toHaveLength(4);
    expect(html).toMatch(/waiting chat<\/span><span class="pill pill-needs-you">Needs you/);
    expect(html).toMatch(/queued chat<\/span><span class="pill pill-info">queued/);
    expect(html).toMatch(/running chat<\/span><span class="pill pill-running">running/);
    expect(html).toMatch(/failed chat<\/span><span class="pill pill-needs-you">error/);
    expect(html).toMatch(/done chat<\/span><\/a>/);
  });
}
