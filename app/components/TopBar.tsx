import Link from 'next/link';
import { MobileNavigation } from './Sidebar';

export function TopBar({ counts }: { counts: { watches: number; queued: number } }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        Automator
      </Link>
      <MobileNavigation counts={counts} />
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
