'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { WatchAction, WatchKind, WatchState } from '@core/index';
import { closeWatch, deleteWatch, pauseWatch, reopenWatch, resumeWatch, runWatchNow } from '../actions/watches';
import { ActionButton } from './ActionButton';
import { ConfirmDialog } from './ConfirmDialog';

export type WatchMenuTarget = { id: number; kind: WatchKind; state: WatchState; running: boolean };

type ItemsProps = {
  watch: WatchMenuTarget;
  actions: WatchAction[];
  jiraEnabled: boolean;
  itemClass: (variant: 'secondary' | 'danger') => string;
  // Actions rendered elsewhere on the page (e.g. the Run now popover or the Needs you card).
  omit?: WatchAction[];
  onDone?: () => void;
};

function form(fields: Record<string, string | number>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, String(v));
  return data;
}

function WatchActionItems({ watch, actions, jiraEnabled, itemClass, omit = [], onDone }: ItemsProps) {
  const t = useTranslations('WatchActions');
  const { id } = watch;
  const show = (a: WatchAction) => actions.includes(a) && !omit.includes(a);
  const secondary = itemClass('secondary');
  return (
    <>
      {show('runNow') && (
        <ActionButton
          className={secondary}
          disabledReason={watch.kind === 'jira' && !jiraEnabled ? t('jiraOff') : undefined}
          action={() => runWatchNow(null, form({ id }))}
          onDone={onDone}
        >
          {t('runNow')}
        </ActionButton>
      )}
      {show('pause') && (
        <ActionButton className={secondary} action={() => pauseWatch(id)} onDone={onDone}>
          {t('pause')}
        </ActionButton>
      )}
      {show('resume') && (
        <ActionButton className={secondary} action={() => resumeWatch(null, form({ id }))} onDone={onDone}>
          {t('resume')}
        </ActionButton>
      )}
      {show('resumeRunNow') && (
        <ActionButton className={secondary} action={() => resumeWatch(null, form({ id, runNow: '1' }))} onDone={onDone}>
          {t('resumeRunNow')}
        </ActionButton>
      )}
      {show('close') && (
        <ConfirmDialog
          className={secondary}
          label={t('close')}
          message={t('closeMessage')}
          confirmLabel={t('closeConfirm')}
          dismissLabel={t('keep')}
          action={() => closeWatch(id)}
        />
      )}
      {show('reopen') && (
        <ActionButton className={secondary} action={() => reopenWatch(id)} onDone={onDone}>
          {t('reopen')}
        </ActionButton>
      )}
      <Link href={`/automations/${id}/edit`} className={secondary}>
        {t('edit')}
      </Link>
      {(show('delete') || watch.running) && (
        <ConfirmDialog
          className={itemClass('danger')}
          label={t('delete')}
          message={t('deleteMessage')}
          confirmLabel={t('deleteConfirm')}
          dismissLabel={t('keep')}
          danger
          disabledReason={watch.running ? t('cancelFirst') : undefined}
          action={() => deleteWatch(id)}
        />
      )}
    </>
  );
}

type Props = { watch: WatchMenuTarget; actions: WatchAction[]; jiraEnabled: boolean };

export function WatchRowMenu(props: Props) {
  const t = useTranslations('WatchActions');
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (e: MouseEvent) => {
      if (menu.current?.open && !menu.current.contains(e.target as Node)) menu.current.open = false;
    };
    document.addEventListener('click', closeOutside);
    return () => document.removeEventListener('click', closeOutside);
  }, []);
  const close = () => {
    if (menu.current) menu.current.open = false;
  };
  return (
    <details ref={menu} className="menu">
      <summary className="btn btn-secondary" aria-label={t('menu')} title={t('menu')}>
        ⋯
      </summary>
      <div className="menu-pop">
        <WatchActionItems
          {...props}
          itemClass={(v) => (v === 'danger' ? 'menu-item menu-item-danger' : 'menu-item')}
          onDone={close}
        />
      </div>
    </details>
  );
}

// Header buttons on the Automation detail page; Run now and Resume live in their own components there.
export function WatchActionBar(props: Props) {
  const omit: WatchAction[] = [
    'runNow',
    ...(props.watch.state === 'needs_you' ? (['resume', 'resumeRunNow'] as const) : []),
  ];
  return (
    <WatchActionItems
      {...props}
      omit={omit}
      itemClass={(v) => (v === 'danger' ? 'btn btn-danger' : 'btn btn-secondary')}
    />
  );
}

export function ResumeButton({ watchId }: { watchId: number }) {
  const t = useTranslations('WatchActions');
  return <ActionButton action={() => resumeWatch(null, form({ id: watchId }))}>{t('resume')}</ActionButton>;
}
