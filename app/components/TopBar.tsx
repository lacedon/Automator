import Link from 'next/link';
import { ProjectSwitcher } from './ProjectSwitcher';
import { MobileNavigation } from './Sidebar';
import { Logo } from './Logo';
import { signOut } from '../actions/auth';

type Props = {
  counts: { watches: number; queued: number };
  projects: { id: number; name: string }[];
  scope: number | 'none' | null;
  username: string;
};

export function TopBar({ counts, projects, scope, username }: Props) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <Logo /> Automator
      </Link>
      <MobileNavigation counts={counts} />
      <ProjectSwitcher projects={projects} scope={scope} />
      <span className="spacer" />
      <Link href="/automations/new" className="btn btn-secondary">
        + Automation
      </Link>
      <Link href="/adhoc" className="btn btn-primary">
        Ad-hoc run
      </Link>
      <form action={signOut}>
        <button type="submit" className="btn btn-secondary" title={`Signed in as ${username}`}>
          Sign out
        </button>
      </form>
    </header>
  );
}
