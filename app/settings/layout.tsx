import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SettingsNavigation } from '../components/SettingsNavigation';
import { requireAdmin } from '../lib/guard';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('Settings');
  const admin = (await requireAdmin()).ok;
  return (
    <div className="settings">
      <div className="settings-intro">
        <p className="settings-title">{t('title')}</p>
        <p className="muted">{t('intro')}</p>
      </div>
      <div className="settings-layout">
        <SettingsNavigation />
        <div className="settings-content">{admin ? children : <p className="muted">{t('needsPermission')}</p>}</div>
      </div>
    </div>
  );
}
