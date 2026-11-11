import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { MobileNavigation, Sidebar } from './Sidebar';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const counts = { watches: 0, queued: 0 };
const chats = [
  { id: 1, title: 'waiting chat', needsYou: true },
  { id: 2, title: 'done chat', needsYou: false },
];

for (const [name, Nav] of [
  ['desktop sidebar', Sidebar],
  ['mobile navigation', MobileNavigation],
] as const) {
  test(`${name} badges only chats whose latest run needs you`, () => {
    const html = renderToStaticMarkup(createElement(Nav, { counts, chats }));
    expect(html.match(/Needs you/g)).toHaveLength(1);
    expect(html).toMatch(/waiting chat<\/span><span class="pill pill-needs-you">Needs you/);
  });
}
