import type { ReactNode } from 'react';
import { SettingsNavigation } from '../components/SettingsNavigation';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="settings">
      <div className="settings-intro">
        <p className="settings-title">Settings</p>
        <p className="muted">Manage your installation. Settings apply across all projects.</p>
      </div>
      <div className="settings-layout">
        <SettingsNavigation />
        <div className="settings-content">{children}</div>
      </div>
    </div>
  );
}
