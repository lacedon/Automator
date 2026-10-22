'use client';

import { unstable_rethrow } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import type { AppError } from '@core/index';
import type { ActionResult } from '../actions/types';
import { ErrorBox, errorMessage } from './ErrorBox';

type Props = {
  label: string;
  message: string;
  confirmLabel: string;
  dismissLabel?: string;
  action: () => Promise<ActionResult<unknown>>;
  danger?: boolean;
  disabledReason?: string;
  className?: string;
};

export function ConfirmDialog({
  label,
  message,
  confirmLabel,
  dismissLabel = 'Back',
  action,
  danger,
  disabledReason,
  className,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<AppError | string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () =>
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          setError(null);
          dialog.current?.close();
        } else {
          setError(result.error);
        }
      } catch (e) {
        // Redirects from Server Actions arrive as thrown errors; let Next handle them.
        unstable_rethrow(e);
        setError(errorMessage(e));
      }
    });

  return (
    <>
      <button
        type="button"
        className={className ?? (danger ? 'btn btn-danger' : 'btn btn-secondary')}
        disabled={disabledReason !== undefined}
        title={disabledReason}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        className="confirm"
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
        onClose={() => setError(null)}
      >
        <p>{message}</p>
        {error !== null && <ErrorBox error={error} />}
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending}
            onClick={() => dialog.current?.close()}
          >
            {dismissLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={pending}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}
