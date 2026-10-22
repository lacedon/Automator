'use client';

import { unstable_rethrow } from 'next/navigation';
import { createContext, useContext, useState, useTransition, type ReactNode } from 'react';
import type { AppError } from '@core/index';
import type { ActionResult } from '../actions/types';
import { errorMessage, InlineError, UnexpectedError } from './InlineError';

type PageError = AppError | string | null;

const ReportError = createContext<(error: PageError) => void>(() => {});

// Errors from buttons anywhere below render in one red box at the top of the page.
export function ActionErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<PageError>(null);
  return (
    <ReportError value={setError}>
      {typeof error === 'string' && <UnexpectedError message={error} />}
      {error !== null && typeof error !== 'string' && <InlineError error={error} />}
      {children}
    </ReportError>
  );
}

type Props = {
  action: () => Promise<ActionResult<unknown>>;
  children: ReactNode;
  className?: string;
  disabledReason?: string;
  onDone?: () => void;
};

export function ActionButton({ action, children, className = 'btn btn-secondary', disabledReason, onDone }: Props) {
  const report = useContext(ReportError);
  const [pending, startTransition] = useTransition();
  const run = () =>
    startTransition(async () => {
      try {
        const result = await action();
        report(result.ok ? null : result.error);
        if (result.ok) onDone?.();
      } catch (e) {
        unstable_rethrow(e);
        report(errorMessage(e));
      }
    });
  return (
    <button type="button" className={className} disabled={pending || disabledReason !== undefined} title={disabledReason} onClick={run}>
      {children}
    </button>
  );
}
