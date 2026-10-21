'use client';

import { useActionState } from 'react';
import { resumeWatch } from '../actions/watches';
import { InlineError } from './InlineError';

export function ResumeForm({ watchId }: { watchId: number }) {
  const [state, formAction, pending] = useActionState(resumeWatch, null);
  return (
    <form action={formAction} className="resume-form">
      <input type="hidden" name="id" value={watchId} />
      <div className="actions">
        <button type="submit" className="btn btn-secondary" disabled={pending}>
          Resume
        </button>
        <button type="submit" className="btn btn-primary" name="runNow" value="1" disabled={pending}>
          Resume &amp; run now
        </button>
      </div>
      {state && !state.ok && <InlineError error={state.error} />}
    </form>
  );
}
