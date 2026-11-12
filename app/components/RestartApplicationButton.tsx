'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { requestApplicationRestart } from '../actions/restart';
import { ConfirmDialog } from './ConfirmDialog';

export function RestartApplicationButton() {
  const t = useTranslations('Restart');
  const [accepted, setAccepted] = useState(false);

  const restart = async () => {
    setAccepted(false);
    const result = await requestApplicationRestart();
    if (result.ok && result.value?.accepted) setAccepted(true);
    return result;
  };

  return (
    <>
      <ConfirmDialog label={t('label')} message={t('message')} confirmLabel={t('confirm')} action={restart} danger />
      {accepted && (
        <p className="success-box" role="status">
          {t('accepted')}
        </p>
      )}
    </>
  );
}
