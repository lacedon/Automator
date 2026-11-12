import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ProjectSwitcher } from './ProjectSwitcher';
import { MobileNavigation, type NavChat } from './Sidebar';
import { Logo } from './Logo';
import { signOut } from '../actions/auth';

type Props = {
  counts: { watches: number; queued: number };
  chats: NavChat[];
  projects: { id: number; name: string }[];
  scope: number | 'none' | null;
  username: string;
};

export async function TopBar({ counts, chats, projects, scope, username }: Props) {
  const t = await getTranslations('Navigation');
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <Logo /> Automator
      </Link>
      <MobileNavigation counts={counts} chats={chats} />
      <ProjectSwitcher projects={projects} scope={scope} />
      <span className="spacer" />
      <Link href="/automations/new" className="btn btn-secondary">
        {t('addAutomation')}
      </Link>
      <Link href="/adhoc" className="btn btn-primary">
        {t('chat')}
      </Link>
      <Link href="/account" className="btn btn-secondary" title={t('accessTokens')}>
        {username}
      </Link>
      <form action={signOut}>
        <button type="submit" className="btn btn-secondary" title={t('signedInAs', { username })}>
          {t('signOut')}
        </button>
      </form>
    </header>
  );
}
