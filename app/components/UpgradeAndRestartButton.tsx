'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { upgradeAndRestart } from '../actions/upgrade';
import { ConfirmDialog } from './ConfirmDialog';

const POLL_INTERVAL_MS = 2_000;

// /login is the one page that is public, so it answers without a session once the new server is up.
async function isServerUp(): Promise<boolean> {
  try {
    return (await fetch('/login', { cache: 'no-store' })).ok;
  } catch {
    return false;
  }
}

export function UpgradeAndRestartButton() {
  const t = useTranslations('Upgrade');
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    if (!upgrading) return;
    let seenDown = false;
    const timer = setInterval(async () => {
      const up = await isServerUp();
      if (!up) seenDown = true;
      else if (seenDown) window.location.reload();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [upgrading]);

  const upgrade = async () => {
    const result = await upgradeAndRestart();
    if (result.ok) setUpgrading(true);
    return result;
  };

  if (upgrading)
    return (
      <p className="muted" role="status" aria-busy="true">
        {t('upgrading')}
      </p>
    );

  return <ConfirmDialog label={t('label')} message={t('message')} confirmLabel={t('label')} action={upgrade} danger />;
}
