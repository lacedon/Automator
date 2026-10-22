import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AutoRefresh } from './components/AutoRefresh';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { getCore } from './lib/core';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Automator' };

export default function RootLayout({ children }: { children: ReactNode }) {
  const counts = getCore().read.navCounts();
  return (
    <html lang="en">
      <body>
        <TopBar />
        <div className="shell">
          <Sidebar counts={counts} />
          <main className="main">{children}</main>
        </div>
        <AutoRefresh intervalMs={3000} />
      </body>
    </html>
  );
}
