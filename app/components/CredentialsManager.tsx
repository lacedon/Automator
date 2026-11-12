'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { removeCredential, saveCredential } from '../actions/credentials';
import { ActionButton, ActionErrorProvider } from './ActionButton';
import { SettingsTable, SettingsTableRow } from './SettingsTable';

type Props = { names: string[]; stored: { name: string; updatedAt: number }[] };

export function CredentialsManager({ names, stored }: Props) {
  const t = useTranslations('Credentials');
  const [name, setName] = useState(names[0] ?? '');
  const [value, setValue] = useState('');
  return (
    <ActionErrorProvider>
      <div className="project-create">
        <select aria-label={t('nameLabel')} value={name} onChange={(e) => setName(e.target.value)}>
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <input
          aria-label={t('valueLabel')}
          type="password"
          autoComplete="off"
          placeholder={t('value')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <ActionButton
          className="btn btn-primary"
          disabledReason={value === '' ? t('enterValue') : undefined}
          action={() => saveCredential(name, value)}
          onDone={() => setValue('')}
        >
          {t('save')}
        </ActionButton>
      </div>
      <SettingsTable label={t('tableLabel')} headers={[t('name'), t('updated'), t('actions')]}>
        {stored.map((c) => (
          <SettingsTableRow
            key={c.name}
            name={c.name}
            actions={
              <ActionButton className="btn btn-danger" action={() => removeCredential(c.name)}>
                {t('remove')}
              </ActionButton>
            }
          >
            {new Date(c.updatedAt).toLocaleString()}
          </SettingsTableRow>
        ))}
      </SettingsTable>
    </ActionErrorProvider>
  );
}
