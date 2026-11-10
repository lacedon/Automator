'use client';

import { useState, useTransition } from 'react';
import type { AppError, ApiToken } from '@core/index';
import { createToken, regenerateToken, revokeToken } from '../actions/tokens';
import type { ActionResult } from '../actions/types';
import { ErrorBox } from './ErrorBox';
import { SettingsTable, SettingsTableRow } from './SettingsTable';

const DAY_MS = 24 * 60 * 60 * 1000;

function when(ms: number | null) {
  return ms === null ? 'never' : new Date(ms).toLocaleString();
}

export function TokensManager({ tokens }: { tokens: ApiToken[] }) {
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<ActionResult<string>>, onOk?: () => void) =>
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setError(null);
        setSecret(result.value ?? null);
        onOk?.();
      } else setError(result.error);
    });

  return (
    <>
      {error !== null && <ErrorBox error={error} />}
      {secret !== null && (
        <p className="token-secret">
          Copy this token now; it will not be shown again: <code>{secret}</code>
        </p>
      )}
      <div className="project-create">
        <input aria-label="Token name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          aria-label="Expires in days"
          type="number"
          min="1"
          placeholder="Expires in days (blank: never)"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || name.trim() === ''}
          onClick={() =>
            run(
              () => createToken(name, days === '' ? null : Date.now() + Number(days) * DAY_MS),
              () => {
                setName('');
                setDays('');
              },
            )
          }
        >
          Create token
        </button>
      </div>
      <SettingsTable label="Access tokens" headers={['Token', 'Usage', 'Actions']}>
        {tokens.map((t) => (
          <SettingsTableRow
            key={t.id}
            name={t.name}
            actions={
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={pending}
                  onClick={() => run(() => regenerateToken(t.id))}
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={pending}
                  onClick={() => run(() => revokeToken(t.id))}
                >
                  Revoke
                </button>
              </>
            }
          >
            Expires: {when(t.expiresAt)} · Last used: {when(t.lastUsedAt)}
          </SettingsTableRow>
        ))}
      </SettingsTable>
    </>
  );
}
