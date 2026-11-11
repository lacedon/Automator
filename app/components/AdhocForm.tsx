'use client';

import Link from 'next/link';
import { startTransition, useActionState, useRef, useState, type FormEvent } from 'react';
import type { FormOptions } from '@core/index';
import { queueAdhoc, type AdhocFormState } from '../actions/adhoc';
import { defaultAgentId } from '../lib/defaultAgent';
import { AgentSelect, type AgentPick } from './AgentSelect';
import { ErrorBox } from './ErrorBox';
import { providerLabel } from '../lib/providerLabel';
import { PromptInput, type Suggestion } from './PromptInput';

type Sent = { runId: number; text: string; position: number | null; warning?: string };

export function AdhocForm({
  options,
}: {
  options: Pick<
    FormOptions,
    'repositories' | 'provider' | 'models' | 'defaultModel' | 'byRepository' | 'agents' | 'agentAssignments'
  >;
}) {
  const [state, formAction, pending] = useActionState(queueAdhoc, null);
  const [repository, setRepository] = useState(options.repositories[0]?.name ?? '');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [ticket, setTicket] = useState('');
  const [agentPick, setAgentPick] = useState<AgentPick | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const ticketRef = useRef<HTMLInputElement>(null);
  const submitted = useRef('');

  // A successful submit clears the prompt and Ticket for the next Run; failures keep everything as entered.
  const [seen, setSeen] = useState<AdhocFormState>(null);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) {
      const { runId, position, warning } = state.value;
      setSent((all) => [...all, { runId, text: submitted.current, position, warning }]);
      setPrompt('');
      setTicket('');
    }
  }

  // Submitting manually avoids React's automatic form reset, which would revert the controlled selects.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    submitted.current = [data.get('ticket'), data.get('prompt')]
      .filter((v) => typeof v === 'string' && v !== '')
      .join(' · ');
    startTransition(() => formAction(data));
  };

  const workflowType = ticket.trim() === '' ? 'free-adhoc' : 'ticket-adhoc';
  const defaultAgent = defaultAgentId(options.agentAssignments, repository, workflowType);
  const repo = options.repositories.find((r) => r.name === repository);
  const settings = options.byRepository[repository] ?? options;
  const otherModels = settings.models.filter((m) => m !== settings.defaultModel);
  const failed = state?.ok === false ? state.error : null;
  const inputClass = (field: string) =>
    (failed?.code === 'UNKNOWN_REPOSITORY' && field === 'repository') ||
    (failed?.code === 'INVALID_INPUT' && failed.field === field)
      ? 'input-err'
      : undefined;

  const commands: Suggestion[] = [
    { id: 'ticket', label: '/ticket', hint: 'Link a Ticket', apply: () => ticketRef.current?.focus() },
    ...settings.models.map((m) => ({
      id: `model:${m}`,
      label: `/model ${m}`,
      hint: 'Use this model',
      apply: () => setModel(m === settings.defaultModel ? '' : m),
    })),
  ];
  const mentions: Suggestion[] = options.agents.map((a) => ({
    id: `agent:${a.id}`,
    label: a.name,
    hint: 'Use this agent',
    apply: () => setAgentPick({ forDefault: defaultAgent, value: String(a.id) }),
  }));

  return (
    <form ref={formRef} action={formAction} onSubmit={submit} className="chat-window">
      <div className="chat-history" aria-live="polite">
        {sent.length === 0 && <p className="muted chat-empty">Start a new chat: ask for something below.</p>}
        {sent.map((m) => (
          <div key={m.runId} className="chat-run">
            <div className="chat-bubble chat-request">{m.text}</div>
            <div className="chat-bubble chat-agent muted" role="status">
              <Link href={`/runs/${m.runId}`}>Run #{m.runId}</Link> queued
              {m.position !== null && ` (position ${m.position})`}
              {m.warning !== undefined && <div>{m.warning}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="chat-composer">
        {failed !== null && <ErrorBox error={failed} unknownRepositoryOutcome="No Run was queued." />}
        <div className="chat-prompt">
          <PromptInput
            id="ah-prompt"
            name="prompt"
            value={prompt}
            onChange={setPrompt}
            required={ticket.trim() === ''}
            className={inputClass('prompt')}
            commands={commands}
            mentions={mentions}
            onSubmit={() => formRef.current?.requestSubmit()}
          />
          <button type="submit" className="btn btn-primary" disabled={pending}>
            Send
          </button>
        </div>
        <div className="chat-fields">
          <div className="field">
            <label htmlFor="ah-repository">Repository</label>
            <select
              id="ah-repository"
              name="repository"
              className={inputClass('repository')}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            >
              {repo === undefined && <option value={repository}>{repository}</option>}
              {options.repositories.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ah-ticket">Ticket (optional)</label>
            <input
              id="ah-ticket"
              ref={ticketRef}
              name="ticket"
              type="text"
              className={inputClass('ticket')}
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="Ticket number or URL"
            />
          </div>
          <AgentSelect
            id="ah-agent"
            options={options}
            defaultAgent={defaultAgent}
            className={inputClass('agentId')}
            picked={agentPick}
            onPick={setAgentPick}
          />
          <div className="field">
            <label htmlFor="ah-model">Model</label>
            <select
              id="ah-model"
              name="model"
              className={inputClass('model')}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">default ({settings.defaultModel})</option>
              {otherModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-hint muted">
          Provider: {providerLabel(settings.provider)}. Goes ahead of scheduled work, ignores working hours, never
          interrupts the current Run.
        </div>
      </div>
    </form>
  );
}
