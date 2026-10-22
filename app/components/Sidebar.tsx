'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Sidebar({ counts }: { counts: { watches: number; queued: number } }) {
  const pathname = usePathname();
  const items = [
    { href: '/', label: 'Home' },
    { href: '/watches', label: 'Watches', count: counts.watches },
    { href: '/queue', label: 'Queue', count: counts.queued },
    { href: '/runs', label: 'Runs' },
    { href: '/adhoc', label: 'Ad-hoc' },
  ];
  return (
    <nav className="sidebar" aria-label="Main">
      {items.map(({ href, label, count }) => {
        const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} className={active ? 'nav-item active' : 'nav-item'} aria-current={active ? 'page' : undefined}>
            <span>{label}</span>
            {count !== undefined && <span className="nav-count">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
