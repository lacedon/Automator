'use client';

import Link from 'next/link';
import { startTransition, useActionState, useEffect, useState, type FormEvent } from 'react';
import type { AppError, FormOptions, InitialReview, PreviewTargetResult, Watch, WatchKind } from '@core/index';
import { createWatch, previewTarget, updateWatch } from '../actions/watches';
import { formatInterval } from '../lib/format';
import { providerLabel } from '../lib/providerLabel';
import { defaultAgentId } from '../lib/defaultAgent';
import { AgentSelect } from './AgentSelect';
import { ErrorBox } from './ErrorBox';
import { KindBadge } from './KindBadge';

export type EditableWatch = Pick<
  Watch,
  'id' | 'kind' | 'targetUrl' | 'repository' | 'instructions' | 'intervalMs' | 'model' | 'initialReview'
>;

type Props = { options: FormOptions } & (
  { mode: 'create'; initial: { target: string; repository: string } } | { mode: 'edit'; watch: EditableWatch }
);

const PREVIEW_DEBOUNCE_MS = 500;
const REVIEW_MODES: readonly InitialReview[] = ['baseline-only', 'unresolved'];
const PLACEHOLDER: Record<WatchKind, string> = {
  mr: 'Additional instructions for this MR Automation…',
  jira: 'Additional instructions for this Jira Automation…',
  free: 'What the selected provider should do on every check…',
};

function errorField(error: AppError | undefined): string | null {
  switch (error?.code) {
    case 'UNKNOWN_REPOSITORY':
      return 'repository';
    case 'DUPLICATE_WATCH':
    case 'INVALID_TARGET':
      return 'target';
    case 'MISSING_INSTRUCTIONS':
      return 'instructions';
    case 'INVALID_INPUT':
      return error.field;
    default:
      return null;
  }
}

const PREVIEW_UNAVAILABLE: PreviewTargetResult = { kind: null, preview: null, previewError: 'Preview unavailable' };

function useDetectedKind(enabled: boolean, target: string, repository: string): PreviewTargetResult | null {
  // Keyed by the input it was detected for, so a result never outlives a changed target or Repository.
  const [detected, setDetected] = useState<{ key: string; result: PreviewTargetResult } | null>(null);
  const key = `${repository}\n${target}`;
  useEffect(() => {
    if (!enabled || target.trim() === '') return;
    let stale = false;
    const timer = setTimeout(() => {
      previewTarget(target, repository).then(
        (result) => {
          if (!stale) setDetected({ key, result });
        },
        // Detection is a hint only; submitting still validates the target.
        () => {
          if (!stale) setDetected({ key, result: PREVIEW_UNAVAILABLE });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [enabled, target, repository, key]);
  return enabled && detected?.key === key ? detected.result : null;
}

function DetectedKind({ detected }: { detected: PreviewTargetResult }) {
  if (detected.kind === null) {
    if (detected.error === undefined) return <div className="field-hint muted">{detected.previewError}</div>;
    const reason = detected.error?.code === 'INVALID_TARGET' ? detected.error.message : detected.error?.code;
    return <div className="field-hint">Couldn&apos;t detect the kind: {reason}</div>;
  }
  const { preview, previewError } = detected;
  return (
    <div className="field-hint">
      Detected kind: <KindBadge kind={detected.kind} />
      {preview !== null && (
        <>
          {' · '}“{preview.title}” · {preview.state === 'opened' ? 'open' : preview.state}
          {preview.sourceBranch !== undefined && (
            <>
              {' · source '}
              <code>{preview.sourceBranch}</code>
            </>
          )}
        </>
      )}
      {previewError !== undefined && <span className="muted"> · {previewError}</span>}
    </div>
  );
}

export function WatchForm(props: Props) {
  const { options, mode } = props;
  const watch = mode === 'edit' ? props.watch : null;
  const [state, formAction, pending] = useActionState(mode === 'create' ? createWatch : updateWatch, null);

  const [target, setTarget] = useState(mode === 'create' ? props.initial.target : '');
  const [repository, setRepository] = useState(mode === 'create' ? props.initial.repository : '');
  const [instructions, setInstructions] = useState(watch?.instructions ?? '');
  // Until edited, the interval field shows the effective interval and is not submitted, so defaults stay defaults.
  const [interval, setIntervalText] = useState<string | null>(null);
  const [model, setModel] = useState(watch?.model ?? '');
  const [review, setReview] = useState<InitialReview | null>(watch?.initialReview ?? null);
  // Edit mode mirrors the interval rule: an untouched initial review is not submitted, so it stays as stored.
  const [reviewTouched, setReviewTouched] = useState(false);

  // React resets a form after its action runs, which reverts controlled selects and radios; submitting manually
  // keeps every entered value after a failed submit.
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  };

  const detected = useDetectedKind(mode === 'create', target, repository);
  const kind = watch?.kind ?? detected?.kind ?? null;
  // Settings in effect for the selected Repository, which include its Project's overrides.
  const settings = options.byRepository[repository] ?? options;
  const shownReview = review ?? settings.initialReview;
  const kindDefaultMs = kind === 'mr' ? settings.intervals.mr : settings.intervals.default;
  const intervalIsDefault = interval === null ? watch?.intervalMs == null : interval.trim() === '';
  const shownInterval = interval ?? formatInterval(watch?.intervalMs ?? kindDefaultMs);

  const invalid = errorField(state?.error);
  const inputClass = (field: string) => (invalid === field ? 'input-err' : undefined);
  const repo = options.repositories.find((r) => r.name === repository);
  const otherModels = settings.models.filter((m) => m !== settings.defaultModel);

  return (
    <form action={formAction} onSubmit={submit} className="watch-form">
      {state && <ErrorBox error={state.error} />}

      {watch === null ? (
        <>
          <div className="field">
            <label htmlFor="wf-target">Target URL or Jira key</label>
            <input
              id="wf-target"
              name="target"
              className={inputClass('target')}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="GitLab MR or GitHub PR URL, PROJ-123 or any URL"
              autoComplete="off"
            />
            {detected !== null && <DetectedKind detected={detected} />}
          </div>
          <div className="field">
            <label htmlFor="wf-repository">Repository</label>
            <select
              id="wf-repository"
              name="repository"
              className={inputClass('repository')}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            >
              {repo === undefined && <option value={repository}>{repository}</option>}
              {options.repositories.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.project === null ? r.name : `${r.name} (${r.project})`}
                </option>
              ))}
            </select>
            {repo !== undefined && (
              <div className="field-hint muted">
                <span className="mono">{repo.folder}</span>
                {repo.host !== null && ` · ${repo.host.replace(/^https?:\/\//, '')}`}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <input type="hidden" name="id" value={watch.id} />
          <div className="field-split">
            <div className="field">
              <label>Target 🔒</label>
              <div className="input-locked">{watch.targetUrl}</div>
            </div>
            <div className="field">
              <label>Repository 🔒</label>
              <div className="input-locked">{watch.repository}</div>
            </div>
          </div>
          <p className="field-hint muted locked-note">
            To change the target or Repository, close this Automation and create a new one.
          </p>
        </>
      )}

      {kind === 'jira' && !settings.jiraEnabled && (
        <div className="notice">
          Jira checking is off in the config, so this Automation won&apos;t be checked until it is turned on.
        </div>
      )}

      <div className="field">
        <label htmlFor="wf-instructions">
          Extra instructions <span className="muted">(optional for MR/Jira, required for free-form)</span>
        </label>
        <textarea
          id="wf-instructions"
          name="instructions"
          rows={3}
          className={inputClass('instructions')}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={kind === null ? undefined : PLACEHOLDER[kind]}
        />
        <div className="field-hint muted">
          Runs also use the Agent and optional operation template configured in{' '}
          <Link href="/settings/agents">Agent Settings</Link>.
        </div>
      </div>

      {watch === null && (
        <AgentSelect
          id="wf-agent"
          options={options}
          defaultAgent={kind === null ? null : defaultAgentId(options.agentAssignments, repository, `${kind}-watch`)}
          className={inputClass('agentId')}
        />
      )}

      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-interval">Interval {intervalIsDefault && <span className="muted">(default)</span>}</label>
          <input
            id="wf-interval"
            name={interval === null ? undefined : 'interval'}
            className={inputClass('interval')}
            value={shownInterval}
            onChange={(e) => setIntervalText(e.target.value)}
            placeholder={`${formatInterval(kindDefaultMs)} (default)`}
            autoComplete="off"
          />
          <div className="field-hint muted">e.g. 15m, 2h, 1d · blank = default</div>
        </div>
        <div className="field">
          <label htmlFor="wf-model">Model</label>
          <select
            id="wf-model"
            name="model"
            className={inputClass('model')}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">default ({settings.defaultModel})</option>
            {model !== '' && !otherModels.includes(model) && <option value={model}>{model}</option>}
            {otherModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="field-hint muted">Provider: {providerLabel(settings.provider)}</div>
        </div>
        {kind === 'mr' && (
          <div className="field">
            <span className="field-label">Initial review</span>
            <div className="seg" role="radiogroup" aria-label="Initial review">
              {REVIEW_MODES.map((option) => (
                <label key={option} className={shownReview === option ? 'on' : undefined}>
                  <input
                    type="radio"
                    name="initialReviewChoice"
                    checked={shownReview === option}
                    onChange={() => {
                      setReview(option);
                      setReviewTouched(true);
                    }}
                  />
                  {option}
                </label>
              ))}
            </div>
            {(watch === null || reviewTouched) && (
              <input
                type="hidden"
                name="initialReview"
                value={shownReview === settings.initialReview ? '' : shownReview}
              />
            )}
          </div>
        )}
      </div>
      {kind === 'mr' && (
        <p className="field-hint muted review-hint">
          baseline-only: Ignore existing comments. unresolved: Review existing unresolved discussions once. Failed
          pipelines and conflicts count in both modes.
        </p>
      )}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {watch === null ? 'Create Automation' : 'Save changes'}
        </button>
        <Link href={watch === null ? '/automations' : `/automations/${watch.id}`} className="btn btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  );
}
