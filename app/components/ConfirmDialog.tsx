'use client';

import { useRef, useState, useTransition } from 'react';
import type { AppError } from '@core/index';
import type { ActionResult } from '../actions/types';
import { InlineError } from './InlineError';

type Props = {
  label: string;
  message: string;
  confirmLabel: string;
  dismissLabel?: string;
  action: () => Promise<ActionResult<unknown>>;
  danger?: boolean;
  disabledReason?: string;
};

export function ConfirmDialog({ label, message, confirmLabel, dismissLabel = 'Back', action, danger, disabledReason }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () =>
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setError(null);
        dialog.current?.close();
      } else {
        setError(result.error);
      }
    });

  return (
    <>
      <button
        type="button"
        className={danger ? 'btn btn-danger' : 'btn btn-secondary'}
        disabled={disabledReason !== undefined}
        title={disabledReason}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <dialog ref={dialog} className="confirm" onClose={() => setError(null)}>
        <p>{message}</p>
        {error && <InlineError error={error} />}
        <div className="actions">
          <button type="button" className="btn btn-secondary" onClick={() => dialog.current?.close()}>
            {dismissLabel}
          </button>
          <button type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={pending} onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}
