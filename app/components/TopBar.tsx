import Link from 'next/link';

export function TopBar() {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        ⚙ Automator
      </Link>
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
