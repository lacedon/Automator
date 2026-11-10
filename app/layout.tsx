import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import { AutoRefresh } from './components/AutoRefresh';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { getCore } from './lib/core';
import { currentScope, currentSelection, projectHue, readableProjects } from './lib/scope';
import { currentUser } from './lib/session';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Automator' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (user === null)
    return (
      <html lang="en">
        <body>{children}</body>
      </html>
    );
  const core = getCore();
  const selection = await currentSelection();
  const counts = core.read.navCounts(await currentScope());
  const projects = await readableProjects();
  const active = typeof selection === 'number' ? projects.find((p) => p.id === selection) : undefined;
  const hue = active ? projectHue(active.name) : undefined;
  const accent = hue === undefined ? undefined : `hsl(${hue} 65% 55%)`;
  const header = hue === undefined ? undefined : `hsl(${hue} 55% 24%)`;
  return (
    <html lang="en">
      <body style={accent ? ({ '--project-accent': accent, '--project-header': header } as CSSProperties) : undefined}>
        <TopBar counts={counts} projects={projects} scope={selection} username={user.username} />
        <div className="shell">
          <Sidebar counts={counts} />
          <main className="main">{children}</main>
        </div>
        <AutoRefresh intervalMs={3000} />
      </body>
    </html>
  );
}
