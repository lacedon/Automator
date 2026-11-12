'use client';

import { unstable_rethrow } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { AppError } from '@core/index';
import type { ActionResult } from '../actions/types';
import { ErrorBox, errorMessage } from './ErrorBox';

type Props = {
  label: string;
  message: string;
  confirmLabel: string;
  dismissLabel?: string;
  action: () => Promise<ActionResult<unknown>>;
  prepare?: () => Promise<ActionResult<string>>;
  danger?: boolean;
  disabledReason?: string;
  className?: string;
};

export function ConfirmDialog({
  label,
  message,
  confirmLabel,
  dismissLabel,
  action,
  prepare,
  danger,
  disabledReason,
  className,
}: Props) {
  const t = useTranslations('ConfirmDialog');
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<AppError | string | null>(null);
  const [preparationError, setPreparationError] = useState<AppError | string | null>(null);
  const [preparedMessage, setPreparedMessage] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const preparationLock = useRef(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (preparedMessage !== null && !dialog.current?.open) dialog.current?.showModal();
  }, [preparedMessage]);

  const open = async () => {
    if (prepare === undefined) {
      dialog.current?.showModal();
      return;
    }
    if (preparationLock.current) return;
    preparationLock.current = true;
    setPreparing(true);
    setPreparationError(null);
    try {
      const result = await prepare();
      if (!result.ok) {
        setPreparationError(result.error);
        return;
      }
      if (result.value === undefined) {
        setPreparationError(t('noDetails'));
        return;
      }
      setPreparedMessage(result.value);
    } catch (e) {
      unstable_rethrow(e);
      setPreparationError(errorMessage(e));
    } finally {
      preparationLock.current = false;
      setPreparing(false);
    }
  };

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
        disabled={disabledReason !== undefined || preparing}
        title={disabledReason}
        aria-busy={preparing}
        onClick={open}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        className="confirm"
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
        onClose={() => {
          setError(null);
          setPreparationError(null);
          setPreparedMessage(null);
        }}
      >
        <p>{preparedMessage ?? message}</p>
        {error !== null && <ErrorBox error={error} />}
        <div className="actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending}
            onClick={() => dialog.current?.close()}
          >
            {dismissLabel ?? t('back')}
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
      {preparationError !== null && <ErrorBox error={preparationError} />}
    </>
  );
}
