import Link from 'next/link';
import { ProjectSwitcher } from './ProjectSwitcher';
import { MobileNavigation } from './Sidebar';
import { Logo } from './Logo';

type Props = {
  counts: { watches: number; queued: number };
  projects: { id: number; name: string }[];
  scope: number | 'none' | null;
};

export function TopBar({ counts, projects, scope }: Props) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <Logo /> Automator
      </Link>
      <MobileNavigation counts={counts} />
      <ProjectSwitcher projects={projects} scope={scope} />
      <span className="spacer" />
      <Link href="/watches/new" className="btn btn-secondary">
        + Watch
      </Link>
      <Link href="/adhoc" className="btn btn-primary">
        Ad-hoc run
      </Link>
    </header>
  );
}
