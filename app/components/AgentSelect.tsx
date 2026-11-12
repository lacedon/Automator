'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { FormOptions } from '@core/index';

export type AgentPick = { forDefault: number | null; value: string };

// Only an override is submitted, so leaving the preselected Agent keeps following the Agent Settings assignment.
export function AgentSelect({
  id,
  options,
  defaultAgent,
  className,
  picked: controlledPick,
  onPick,
}: {
  id: string;
  options: Pick<FormOptions, 'agents'>;
  defaultAgent: number | null;
  className?: string;
  // Lets a parent drive the choice (e.g. the chat prompt's @agent mentions).
  picked?: AgentPick | null;
  onPick?: (pick: AgentPick) => void;
}) {
  const t = useTranslations('Agent');
  const [ownPick, setOwnPick] = useState<AgentPick | null>(null);
  const picked = controlledPick !== undefined ? controlledPick : ownPick;
  const setPicked = onPick ?? setOwnPick;
  // A choice made against an earlier default is dropped when the default changes (Repository or type switch).
  const value = picked !== null && picked.forDefault === defaultAgent ? picked.value : String(defaultAgent ?? '');
  const overridden = value !== String(defaultAgent ?? '') && value !== '';

  return (
    <div className="field">
      <label htmlFor={id}>{t('label')}</label>
      <select
        id={id}
        className={className}
        value={value}
        onChange={(e) => setPicked({ forDefault: defaultAgent, value: e.target.value })}
      >
        {defaultAgent === null && <option value="">{t('none')}</option>}
        {options.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.id === defaultAgent ? t('default', { name: a.name }) : a.name}
          </option>
        ))}
      </select>
      {overridden && <input type="hidden" name="agentId" value={value} />}
    </div>
  );
}
