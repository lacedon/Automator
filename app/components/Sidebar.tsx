'use client';

import type { MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Counts = { watches: number; queued: number };

function NavigationItems({
  counts,
  onNavigate,
}: {
  counts: Counts;
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const pathname = usePathname();
  const items = [
    { href: '/', label: 'Home' },
    { href: '/watches', label: 'Watches' },
    { href: '/queue', label: 'Queue', count: counts.queued },
    { href: '/runs', label: 'Runs' },
    { href: '/settings', label: 'Settings' },
  ];
  return items.map(({ href, label, count }) => {
    const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        className={`nav-item${active ? ' active' : ''}${href === '/settings' ? ' nav-settings' : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
      >
        <span>{label}</span>
        {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
      </Link>
    );
  });
}

export function Sidebar({ counts }: { counts: Counts }) {
  return (
    <nav className="sidebar" aria-label="Main">
      <NavigationItems counts={counts} />
    </nav>
  );
}

export function MobileNavigation({ counts }: { counts: Counts }) {
  const close = (event: MouseEvent<HTMLAnchorElement>) => {
    const menu = event.currentTarget.closest('details');
    if (menu) menu.open = false;
  };

  return (
    <details className="mobile-nav">
      <summary className="mobile-nav-trigger">Menu</summary>
      <div className="mobile-nav-sheet">
        <nav aria-label="Main mobile">
          <NavigationItems counts={counts} onNavigate={close} />
          <Link href="/watches/new" className="nav-item" onClick={close}>
            New watch
          </Link>
          <Link href="/adhoc" className="nav-item" onClick={close}>
            Ad-hoc run
          </Link>
        </nav>
      </div>
    </details>
  );
}
