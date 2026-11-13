'use client';

import { useTranslations } from 'next-intl';
import { unstable_rethrow } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { AppError, ColorScheme } from '@core/index';
import type { ActionResult } from '../actions/types';
import { ErrorBox, errorMessage } from './ErrorBox';

type Props = {
  schemes: readonly ColorScheme[];
  // The chosen scheme id, or null when the user follows the application default.
  value: string | null;
  // Offer a "use application default" option, which selects null.
  allowDefault?: boolean;
  label: string;
  action: (scheme: string | null) => Promise<ActionResult>;
};

// Lists every registered scheme with its main colors, so adding a scheme to the registry needs no change here.
export function ColorSchemePicker({ schemes, value, allowDefault = false, label, action }: Props) {
  const t = useTranslations('ColorScheme');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<AppError | string | null>(null);
  const choose = (scheme: string | null) =>
    startTransition(async () => {
      try {
        const result = await action(scheme);
        setError(result.ok ? null : result.error);
      } catch (e) {
        unstable_rethrow(e);
        setError(errorMessage(e));
      }
    });
  const option = (id: string | null, name: string, colors?: ColorScheme['colors']) => (
    <button
      key={id ?? 'default'}
      type="button"
      className={`scheme-option${value === id ? ' scheme-option-selected' : ''}`}
      aria-pressed={value === id}
      disabled={pending}
      onClick={() => choose(id)}
    >
      {colors !== undefined && (
        <span className="scheme-swatches" data-testid={`swatches-${id}`}>
          {Object.entries(colors).map(([role, color]) => (
            <span key={role} className="scheme-swatch" style={{ background: color }} title={color} />
          ))}
        </span>
      )}
      {name}
    </button>
  );
  return (
    <>
      {error !== null && <ErrorBox error={error} />}
      <div className="scheme-options" role="group" aria-label={label}>
        {allowDefault && option(null, t('useDefault'))}
        {schemes.map((scheme) => option(scheme.id, scheme.label, scheme.colors))}
      </div>
    </>
  );
}
