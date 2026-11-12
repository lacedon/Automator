'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { AppError, ApiToken } from '@core/index';
import { createToken, regenerateToken, revokeToken } from '../actions/tokens';
import type { ActionResult } from '../actions/types';
import { ErrorBox } from './ErrorBox';
import { SettingsTable, SettingsTableRow } from './SettingsTable';

const DAY_MS = 24 * 60 * 60 * 1000;

export function TokensManager({ tokens }: { tokens: ApiToken[] }) {
  const t = useTranslations('Tokens');
  const when = (ms: number | null) => (ms === null ? t('never') : new Date(ms).toLocaleString());
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
          {t('copy')} <code>{secret}</code>
        </p>
      )}
      <div className="project-create">
        <input
          aria-label={t('nameLabel')}
          placeholder={t('name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label={t('expiresLabel')}
          type="number"
          min="1"
          placeholder={t('expiresPlaceholder')}
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
          {t('create')}
        </button>
      </div>
      <SettingsTable label={t('tableLabel')} headers={[t('token'), t('usage'), t('actions')]}>
        {tokens.map((token) => (
          <SettingsTableRow
            key={token.id}
            name={token.name}
            actions={
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={pending}
                  onClick={() => run(() => regenerateToken(token.id))}
                >
                  {t('regenerate')}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={pending}
                  onClick={() => run(() => revokeToken(token.id))}
                >
                  {t('revoke')}
                </button>
              </>
            }
          >
            {t('usageText', { expires: when(token.expiresAt), lastUsed: when(token.lastUsedAt) })}
          </SettingsTableRow>
        ))}
      </SettingsTable>
    </>
  );
}
