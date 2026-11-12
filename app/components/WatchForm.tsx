'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
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
const PLACEHOLDER_KEY = { mr: 'phMr', jira: 'phJira', free: 'phFree' } as const satisfies Record<WatchKind, string>;

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
  const t = useTranslations('WatchForm');
  const previewError =
    detected.previewError === PREVIEW_UNAVAILABLE.previewError ? t('previewUnavailable') : detected.previewError;
  if (detected.kind === null) {
    if (detected.error === undefined) return <div className="field-hint muted">{previewError}</div>;
    const reason = detected.error?.code === 'INVALID_TARGET' ? detected.error.message : detected.error?.code;
    return <div className="field-hint">{t('detectFailed', { reason: reason ?? '' })}</div>;
  }
  const { preview } = detected;
  return (
    <div className="field-hint">
      {t('detectedKind')} <KindBadge kind={detected.kind} />
      {preview !== null && (
        <>
          {' · '}“{preview.title}” · {preview.state === 'opened' ? t('open') : preview.state}
          {preview.sourceBranch !== undefined && (
            <>
              {` · ${t('sourceBranch')} `}
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
  const t = useTranslations('WatchForm');
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
            <label htmlFor="wf-target">{t('target')}</label>
            <input
              id="wf-target"
              name="target"
              className={inputClass('target')}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={t('targetPlaceholder')}
              autoComplete="off"
            />
            {detected !== null && <DetectedKind detected={detected} />}
          </div>
          <div className="field">
            <label htmlFor="wf-repository">{t('repository')}</label>
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
              <label>{t('lockedTarget')}</label>
              <div className="input-locked">{watch.targetUrl}</div>
            </div>
            <div className="field">
              <label>{t('lockedRepository')}</label>
              <div className="input-locked">{watch.repository}</div>
            </div>
          </div>
          <p className="field-hint muted locked-note">{t('lockedNote')}</p>
        </>
      )}

      {kind === 'jira' && !settings.jiraEnabled && <div className="notice">{t('jiraOff')}</div>}

      <div className="field">
        <label htmlFor="wf-instructions">
          {t('extra')} <span className="muted">{t('extraHint')}</span>
        </label>
        <textarea
          id="wf-instructions"
          name="instructions"
          rows={3}
          className={inputClass('instructions')}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={kind === null ? undefined : t(PLACEHOLDER_KEY[kind])}
        />
        <div className="field-hint muted">
          {t.rich('agentSettingsNote', { link: (chunks) => <Link href="/settings/agents">{chunks}</Link> })}
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
          <label htmlFor="wf-interval">
            {t('interval')} {intervalIsDefault && <span className="muted">{t('default')}</span>}
          </label>
          <input
            id="wf-interval"
            name={interval === null ? undefined : 'interval'}
            className={inputClass('interval')}
            value={shownInterval}
            onChange={(e) => setIntervalText(e.target.value)}
            placeholder={t('intervalPlaceholder', { interval: formatInterval(kindDefaultMs) })}
            autoComplete="off"
          />
          <div className="field-hint muted">{t('intervalHint')}</div>
        </div>
        <div className="field">
          <label htmlFor="wf-model">{t('model')}</label>
          <select
            id="wf-model"
            name="model"
            className={inputClass('model')}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">{t('defaultModel', { model: settings.defaultModel })}</option>
            {model !== '' && !otherModels.includes(model) && <option value={model}>{model}</option>}
            {otherModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="field-hint muted">{t('provider', { provider: providerLabel(settings.provider) })}</div>
        </div>
        {kind === 'mr' && (
          <div className="field">
            <span className="field-label">{t('initialReview')}</span>
            <div className="seg" role="radiogroup" aria-label={t('initialReview')}>
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
                  {t(option === 'baseline-only' ? 'baselineOnly' : 'unresolved')}
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
      {kind === 'mr' && <p className="field-hint muted review-hint">{t('reviewHint')}</p>}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {watch === null ? t('create') : t('save')}
        </button>
        <Link href={watch === null ? '/automations' : `/automations/${watch.id}`} className="btn btn-secondary">
          {t('cancel')}
        </Link>
      </div>
    </form>
  );
}
