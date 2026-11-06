'use client';

import { useState } from 'react';
import type { FormOptions } from '@core/index';

// Only an override is submitted, so leaving the preselected Agent keeps following the Agent Settings assignment.
export function AgentSelect({
  id,
  options,
  defaultAgent,
  className,
}: {
  id: string;
  options: Pick<FormOptions, 'agents'>;
  defaultAgent: number | null;
  className?: string;
}) {
  const [picked, setPicked] = useState<{ forDefault: number | null; value: string } | null>(null);
  // A choice made against an earlier default is dropped when the default changes (Repository or type switch).
  const value = picked !== null && picked.forDefault === defaultAgent ? picked.value : String(defaultAgent ?? '');
  const overridden = value !== String(defaultAgent ?? '') && value !== '';

  return (
    <div className="field">
      <label htmlFor={id}>Agent</label>
      <select
        id={id}
        className={className}
        value={value}
        onChange={(e) => setPicked({ forDefault: defaultAgent, value: e.target.value })}
      >
        {defaultAgent === null && <option value="">none assigned</option>}
        {options.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.id === defaultAgent ? ' (default)' : ''}
          </option>
        ))}
      </select>
      {overridden && <input type="hidden" name="agentId" value={value} />}
    </div>
  );
}
