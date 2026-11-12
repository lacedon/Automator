'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { resumeWatch } from '../actions/watches';
import { ErrorBox } from './ErrorBox';

export function ResumeForm({ watchId, withNote }: { watchId: number; withNote?: boolean }) {
  const t = useTranslations('ResumeForm');
  const [state, formAction, pending] = useActionState(resumeWatch, null);
  return (
    <form action={formAction} className="resume-form">
      <input type="hidden" name="id" value={watchId} />
      {withNote && <textarea name="note" rows={2} aria-label={t('note')} placeholder={t('notePlaceholder')} />}
      <div className="actions">
        <button type="submit" className="btn btn-secondary" disabled={pending}>
          {t('resume')}
        </button>
        <button type="submit" className="btn btn-primary" name="runNow" value="1" disabled={pending}>
          {t('resumeRunNow')}
        </button>
      </div>
      {state && !state.ok && <ErrorBox error={state.error} />}
    </form>
  );
}
