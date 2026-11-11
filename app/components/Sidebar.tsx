'use client';

import { Fragment, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Counts = { watches: number; queued: number };
export type NavChat = { id: number; title: string };

function NavigationItems({
  counts,
  chats,
  onNavigate,
}: {
  counts: Counts;
  chats: NavChat[];
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const pathname = usePathname();
  const items = [
    { href: '/', label: 'Home' },
    { href: '/automations', label: 'Automations', count: counts.watches },
    { href: '/queue', label: 'Queue', count: counts.queued },
    { href: '/runs', label: 'Chats' },
    { href: '/settings', label: 'Settings' },
  ];
  return items.map(({ href, label, count }) => {
    const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Fragment key={href}>
        <Link
          href={href}
          className={`nav-item${active ? ' active' : ''}${href === '/settings' ? ' nav-settings' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={onNavigate}
        >
          <span>{label}</span>
          {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
        </Link>
        {href === '/runs' &&
          chats.map((chat) => (
            <Link
              key={chat.id}
              href={`/runs/${chat.id}`}
              className="nav-item nav-chat"
              title={chat.title}
              onClick={onNavigate}
            >
              <span>{chat.title}</span>
            </Link>
          ))}
      </Fragment>
    );
  });
}

export function Sidebar({ counts, chats }: { counts: Counts; chats: NavChat[] }) {
  return (
    <nav className="sidebar" aria-label="Main">
      <NavigationItems counts={counts} chats={chats} />
    </nav>
  );
}

export function MobileNavigation({ counts, chats }: { counts: Counts; chats: NavChat[] }) {
  const close = (event: MouseEvent<HTMLAnchorElement>) => {
    const menu = event.currentTarget.closest('details');
    if (menu) menu.open = false;
  };

  return (
    <details className="mobile-nav">
      <summary className="mobile-nav-trigger">Menu</summary>
      <div className="mobile-nav-sheet">
        <nav aria-label="Main mobile">
          <NavigationItems counts={counts} chats={chats} onNavigate={close} />
          <Link href="/automations/new" className="nav-item" onClick={close}>
            New automation
          </Link>
          <Link href="/adhoc" className="nav-item" onClick={close}>
            Chat
          </Link>
        </nav>
      </div>
    </details>
  );
}
