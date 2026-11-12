'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { runWatchNow } from '../actions/watches';
import { ErrorBox } from './ErrorBox';

type Props = { watchId: number; isMr: boolean; disabledReason?: string };

export function RunNowPopover({ watchId, isMr, disabledReason }: Props) {
  const t = useTranslations('RunNow');
  const popover = useRef<HTMLDetailsElement>(null);
  const [state, formAction, pending] = useActionState(runWatchNow, null);

  useEffect(() => {
    if (state?.ok && popover.current) popover.current.open = false;
  }, [state]);

  if (disabledReason !== undefined) {
    return (
      <button type="button" className="btn btn-primary" disabled title={disabledReason}>
        {t('runNow')}
      </button>
    );
  }

  return (
    <details ref={popover} className="menu">
      <summary className="btn btn-primary">{t('runNow')}</summary>
      <form action={formAction} className="menu-pop popover-form">
        <input type="hidden" name="id" value={watchId} />
        <label htmlFor={`extra-${watchId}`} className="muted">
          {t('extra')}
        </label>
        <textarea id={`extra-${watchId}`} name="extraInstructions" rows={3} />
        {isMr && (
          <label className="check">
            <input type="checkbox" name="reviewUnresolved" /> {t('reviewUnresolved')}
          </label>
        )}
        {state && !state.ok && <ErrorBox error={state.error} />}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {t('queue')}
          </button>
        </div>
      </form>
    </details>
  );
}
