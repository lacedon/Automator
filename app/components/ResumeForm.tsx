'use client';

import { useActionState } from 'react';
import { resumeWatch } from '../actions/watches';
import { InlineError } from './InlineError';

export function ResumeForm({ watchId, withNote }: { watchId: number; withNote?: boolean }) {
  const [state, formAction, pending] = useActionState(resumeWatch, null);
  return (
    <form action={formAction} className="resume-form">
      <input type="hidden" name="id" value={watchId} />
      {withNote && <textarea name="note" rows={2} aria-label="Resolution note" placeholder="Resolution note for the next run (optional)…" />}
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
