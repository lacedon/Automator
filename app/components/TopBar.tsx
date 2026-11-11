import Link from 'next/link';
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

export function TopBar({ counts, chats, projects, scope, username }: Props) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <Logo /> Automator
      </Link>
      <MobileNavigation counts={counts} chats={chats} />
      <ProjectSwitcher projects={projects} scope={scope} />
      <span className="spacer" />
      <Link href="/automations/new" className="btn btn-secondary">
        + Automation
      </Link>
      <Link href="/adhoc" className="btn btn-primary">
        Chat
      </Link>
      <Link href="/account" className="btn btn-secondary" title="Access tokens">
        {username}
      </Link>
      <form action={signOut}>
        <button type="submit" className="btn btn-secondary" title={`Signed in as ${username}`}>
          Sign out
        </button>
      </form>
    </header>
  );
}
