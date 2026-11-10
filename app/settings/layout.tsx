import type { ReactNode } from 'react';
import { SettingsNavigation } from '../components/SettingsNavigation';
import { requireAdmin } from '../lib/guard';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const admin = (await requireAdmin()).ok;
  return (
    <div className="settings">
      <div className="settings-intro">
        <p className="settings-title">Settings</p>
        <p className="muted">Manage your installation. Settings apply across all projects.</p>
      </div>
      <div className="settings-layout">
        <SettingsNavigation />
        <div className="settings-content">
          {admin ? children : <p className="muted">Settings need the global write permission.</p>}
        </div>
      </div>
    </div>
  );
}
