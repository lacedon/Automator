'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function SettingsNavigation() {
  const pathname = usePathname();
  const t = useTranslations('SettingsNav');
  return (
    <nav className="settings-nav" aria-label={t('label')}>
      {(
        [
          ['/settings/projects', 'projects'],
          ['/settings/repositories', 'repositories'],
          ['/settings/agents', 'agents'],
          ['/settings/access', 'access'],
          ['/settings/config', 'config'],
        ] as const
      ).map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
        >
          {t(label)}
        </Link>
      ))}
    </nav>
  );
}
