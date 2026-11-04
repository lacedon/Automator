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
    { href: '/watches', label: 'Watches', count: counts.watches },
    { href: '/queue', label: 'Queue', count: counts.queued },
    { href: '/runs', label: 'Runs' },
    { href: '/adhoc', label: 'Ad-hoc' },
    { href: '/projects', label: 'Projects' },
    { href: '/settings/repositories', label: 'Repositories' },
    { href: '/settings/agents', label: 'Settings' },
  ];
  return items.map(({ href, label, count }) => {
    const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        className={active ? 'nav-item active' : 'nav-item'}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
      >
        <span>{label}</span>
        {count !== undefined && <span className="nav-count">{count}</span>}
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
        <nav aria-label="Main">
          <NavigationItems counts={counts} onNavigate={close} />
          <Link href="/watches/new" className="nav-item" onClick={close}>
            New watch
          </Link>
        </nav>
      </div>
    </details>
  );
}
