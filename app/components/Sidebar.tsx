'use client';

import { Fragment, type MouseEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Pill } from './Pill';

type Counts = { watches: number; queued: number };
export type NavChat = { id: number; title: string; needsYou: boolean };

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
  const t = useTranslations('Navigation');
  const items = [
    { href: '/', label: t('home') },
    { href: '/automations', label: t('automations'), count: counts.watches },
    { href: '/queue', label: t('queue'), count: counts.queued },
    { href: '/runs', label: t('chats') },
    { href: '/settings', label: t('settings') },
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
              {chat.needsYou && <Pill variant="needs-you">{t('needsYou')}</Pill>}
            </Link>
          ))}
      </Fragment>
    );
  });
}

export function Sidebar({ counts, chats }: { counts: Counts; chats: NavChat[] }) {
  const t = useTranslations('Navigation');
  return (
    <nav className="sidebar" aria-label={t('main')}>
      <NavigationItems counts={counts} chats={chats} />
    </nav>
  );
}

export function MobileNavigation({ counts, chats }: { counts: Counts; chats: NavChat[] }) {
  const t = useTranslations('Navigation');
  const close = (event: MouseEvent<HTMLAnchorElement>) => {
    const menu = event.currentTarget.closest('details');
    if (menu) menu.open = false;
  };

  return (
    <details className="mobile-nav">
      <summary className="mobile-nav-trigger">{t('menu')}</summary>
      <div className="mobile-nav-sheet">
        <nav aria-label={t('mainMobile')}>
          <NavigationItems counts={counts} chats={chats} onNavigate={close} />
          <Link href="/automations/new" className="nav-item" onClick={close}>
            {t('newAutomation')}
          </Link>
          <Link href="/adhoc" className="nav-item" onClick={close}>
            {t('chat')}
          </Link>
        </nav>
      </div>
    </details>
  );
}
