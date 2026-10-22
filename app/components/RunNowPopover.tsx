'use client';

import { useActionState, useEffect, useRef } from 'react';
import { runWatchNow } from '../actions/watches';
import { InlineError } from './InlineError';

type Props = { watchId: number; isMr: boolean; disabledReason?: string };

export function RunNowPopover({ watchId, isMr, disabledReason }: Props) {
  const popover = useRef<HTMLDetailsElement>(null);
  const [state, formAction, pending] = useActionState(runWatchNow, null);

  useEffect(() => {
    if (state?.ok && popover.current) popover.current.open = false;
  }, [state]);

  if (disabledReason !== undefined) {
    return (
      <button type="button" className="btn btn-primary" disabled title={disabledReason}>
        Run now ▾
      </button>
    );
  }

  return (
    <details ref={popover} className="menu">
      <summary className="btn btn-primary">Run now ▾</summary>
      <form action={formAction} className="menu-pop popover-form">
        <input type="hidden" name="id" value={watchId} />
        <label htmlFor={`extra-${watchId}`} className="muted">
          Extra instructions for this Run (optional)
        </label>
        <textarea id={`extra-${watchId}`} name="extraInstructions" rows={3} />
        {isMr && (
          <label className="check">
            <input type="checkbox" name="reviewUnresolved" /> Review existing unresolved discussions
          </label>
        )}
        {state && !state.ok && <InlineError error={state.error} />}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            Queue Run
          </button>
        </div>
      </form>
    </details>
  );
}
