'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import type { AppError, FormOptions, InitialReview, PreviewTargetResult, Watch, WatchKind } from '@core/index';
import { createWatch, previewTarget, updateWatch } from '../actions/watches';
import { formatInterval } from '../lib/format';
import { ErrorBox } from './ErrorBox';
import { KindBadge } from './KindBadge';

export type EditableWatch = Pick<
  Watch,
  'id' | 'kind' | 'targetUrl' | 'repository' | 'instructions' | 'intervalMs' | 'model' | 'initialReview'
>;

type Props = { options: FormOptions } & (
  | { mode: 'create'; initial: { target: string; repository: string } }
  | { mode: 'edit'; watch: EditableWatch }
);

const PREVIEW_DEBOUNCE_MS = 500;
const REVIEW_MODES: readonly InitialReview[] = ['baseline-only', 'unresolved'];
const PLACEHOLDER: Record<WatchKind, string> = {
  mr: 'Added to the default MR prompt…',
  jira: 'Added to the default Jira prompt…',
  free: 'What Copilot should do on every check…',
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

function useDetectedKind(enabled: boolean, target: string, repository: string): PreviewTargetResult | null {
  const [detected, setDetected] = useState<PreviewTargetResult | null>(null);
  useEffect(() => {
    if (!enabled || target.trim() === '') return;
    let stale = false;
    const timer = setTimeout(() => {
      previewTarget(target, repository).then(
        (result) => {
          if (!stale) setDetected(result);
        },
        () => {
          // Detection is a hint only; submitting still validates the target.
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [enabled, target, repository]);
  return enabled && target.trim() !== '' ? detected : null;
}

function DetectedKind({ detected }: { detected: PreviewTargetResult }) {
  if (detected.kind === null) {
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
  const [review, setReview] = useState<InitialReview>(watch?.initialReview ?? options.initialReview);

  const detected = useDetectedKind(mode === 'create', target, repository);
  const kind = watch?.kind ?? detected?.kind ?? null;
  const kindDefaultMs = kind === 'mr' ? options.intervals.mr : options.intervals.default;
  const intervalIsDefault = interval === null ? watch?.intervalMs == null : interval.trim() === '';
  const shownInterval = interval ?? formatInterval(watch?.intervalMs ?? kindDefaultMs);

  const invalid = errorField(state?.error);
  const inputClass = (field: string) => (invalid === field ? 'input-err' : undefined);
  const repo = options.repositories.find((r) => r.name === repository);
  const otherModels = options.models.filter((m) => m !== options.defaultModel);
  const promptFile = kind === null ? null : options.defaultPromptFiles[kind];

  return (
    <form action={formAction} className="watch-form">
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
              placeholder="https://gitlab.example.com/group/project/-/merge_requests/42, PROJ-123 or any URL"
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
                  {r.name}
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
          <p className="field-hint muted locked-note">To change the target or Repository, close this Watch and create a new one.</p>
        </>
      )}

      {kind === 'jira' && !options.jiraEnabled && (
        <div className="notice">Jira checking is off in the config, so this Watch won&apos;t be checked until it is turned on.</div>
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
        {promptFile !== null && (
          <div className="field-hint muted">
            Default prompt: <code>{promptFile}</code>
          </div>
        )}
        {kind === 'free' && <div className="field-hint muted">Free-form Watches have no default prompt: the instructions are the whole task.</div>}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-interval">
            Interval {intervalIsDefault && <span className="muted">(default)</span>}
          </label>
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
          <select id="wf-model" name="model" className={inputClass('model')} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">default ({options.defaultModel})</option>
            {model !== '' && !otherModels.includes(model) && <option value={model}>{model}</option>}
            {otherModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        {kind === 'mr' && (
          <div className="field">
            <span className="field-label">Initial review</span>
            <div className="seg" role="radiogroup" aria-label="Initial review">
              {REVIEW_MODES.map((option) => (
                <label key={option} className={review === option ? 'on' : undefined}>
                  <input
                    type="radio"
                    name="initialReview"
                    value={option === options.initialReview ? '' : option}
                    checked={review === option}
                    onChange={() => setReview(option)}
                  />
                  {option}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
      {kind === 'mr' && (
        <p className="field-hint muted review-hint">
          baseline-only: Ignore existing comments. unresolved: Review existing unresolved discussions once. Failed pipelines and conflicts
          count in both modes.
        </p>
      )}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {watch === null ? 'Create Watch' : 'Save changes'}
        </button>
        <Link href={watch === null ? '/watches' : `/watches/${watch.id}`} className="btn btn-secondary">
          Cancel
        </Link>
      </div>
    </form>
  );
}
