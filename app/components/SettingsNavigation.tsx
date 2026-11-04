'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function SettingsNavigation() {
  const pathname = usePathname();
  return (
    <nav className="settings-nav" aria-label="Settings">
      {(
        [
          ['/settings/projects', 'Projects'],
          ['/settings/repositories', 'Repositories'],
          ['/settings/agents', 'Agents'],
          ['/settings/config', 'Configuration'],
        ] as const
      ).map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
