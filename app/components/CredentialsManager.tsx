'use client';

import { useState } from 'react';
import { removeCredential, saveCredential } from '../actions/credentials';
import { ActionButton, ActionErrorProvider } from './ActionButton';
import { SettingsTable, SettingsTableRow } from './SettingsTable';

type Props = { names: string[]; stored: { name: string; updatedAt: number }[] };

export function CredentialsManager({ names, stored }: Props) {
  const [name, setName] = useState(names[0] ?? '');
  const [value, setValue] = useState('');
  return (
    <ActionErrorProvider>
      <div className="project-create">
        <select aria-label="Credential name" value={name} onChange={(e) => setName(e.target.value)}>
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <input
          aria-label="Credential value"
          type="password"
          autoComplete="off"
          placeholder="Value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <ActionButton
          className="btn btn-primary"
          disabledReason={value === '' ? 'Enter a value' : undefined}
          action={() => saveCredential(name, value)}
          onDone={() => setValue('')}
        >
          Save credential
        </ActionButton>
      </div>
      <SettingsTable label="Credentials" headers={['Name', 'Updated', 'Actions']}>
        {stored.map((c) => (
          <SettingsTableRow
            key={c.name}
            name={c.name}
            actions={
              <ActionButton className="btn btn-danger" action={() => removeCredential(c.name)}>
                Remove
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
