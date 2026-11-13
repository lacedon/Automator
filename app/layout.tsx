import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import type { CSSProperties, ReactNode } from 'react';
import { AutoRefresh } from './components/AutoRefresh';
import { Sidebar, type NavChatStatus } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { getCore } from './lib/core';
import { currentScope, currentSelection, projectHue, readableProjects } from './lib/scope';
import { currentUser } from './lib/session';
import type { RunRow } from '@core/index';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Automator' };

function chatStatus(run: RunRow): NavChatStatus | null {
  if (run.closedAt !== null || run.interrupted !== null) return null;
  if (run.outcome === 'needs-you') return 'needs-you';
  if (run.resultStatus === 'error') return 'error';
  if (run.outcome !== null) return null;
  return run.status === 'running' || run.status === 'queued' ? run.status : null;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const locale = await getLocale();
  const scheme = getCore().settings.effectiveColorScheme(user?.id ?? null);
  if (user === null)
    return (
      <html lang={locale} data-scheme={scheme}>
        <body>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
        </body>
      </html>
    );
  const core = getCore();
  const t = await getTranslations('Navigation');
  const selection = await currentSelection();
  const counts = core.read.navCounts(await currentScope());
  const chats = core.read.runList({ project: await currentScope(), limit: 10 }).map((run) => ({
    id: run.id,
    title: run.adhocPrompt || (run.ticket?.key ?? t('chatFallback', { id: run.id })),
    status: chatStatus(run),
  }));
  const projects = await readableProjects();
  const active = typeof selection === 'number' ? projects.find((p) => p.id === selection) : undefined;
  const hue = active ? projectHue(active.name) : undefined;
  const accent = hue === undefined ? undefined : `hsl(${hue} 10% 15%)`;
  const header = hue === undefined ? undefined : `hsl(${hue} 80% 15%)`;
  return (
    <html lang={locale} data-scheme={scheme}>
      <body style={accent ? ({ '--project-accent': accent, '--project-header': header } as CSSProperties) : undefined}>
        <NextIntlClientProvider>
          <TopBar counts={counts} chats={chats} projects={projects} scope={selection} username={user.username} />
          <div className="shell">
            <Sidebar counts={counts} chats={chats} />
            <main className="main">{children}</main>
          </div>
          <AutoRefresh intervalMs={3000} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
