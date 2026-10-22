'use client';

import Link from 'next/link';
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
  const { id } = watch;
  const show = (a: WatchAction) => actions.includes(a) && !omit.includes(a);
  const secondary = itemClass('secondary');
  return (
    <>
      {show('runNow') && (
        <ActionButton
          className={secondary}
          disabledReason={watch.kind === 'jira' && !jiraEnabled ? 'Jira checking is off' : undefined}
          action={() => runWatchNow(null, form({ id }))}
          onDone={onDone}
        >
          Run now
        </ActionButton>
      )}
      {show('pause') && (
        <ActionButton className={secondary} action={() => pauseWatch(id)} onDone={onDone}>
          Pause
        </ActionButton>
      )}
      {show('resume') && (
        <ActionButton className={secondary} action={() => resumeWatch(null, form({ id }))} onDone={onDone}>
          Resume
        </ActionButton>
      )}
      {show('resumeRunNow') && (
        <ActionButton className={secondary} action={() => resumeWatch(null, form({ id, runNow: '1' }))} onDone={onDone}>
          Resume &amp; run now
        </ActionButton>
      )}
      {show('close') && (
        <ConfirmDialog
          className={secondary}
          label="Close"
          message="Closing stops follow-up. History is kept until cleanup."
          confirmLabel="Close Watch"
          dismissLabel="Keep watching"
          action={() => closeWatch(id)}
        />
      )}
      {show('reopen') && (
        <ActionButton className={secondary} action={() => reopenWatch(id)} onDone={onDone}>
          Reopen
        </ActionButton>
      )}
      <Link href={`/watches/${id}/edit`} className={secondary}>
        Edit
      </Link>
      {(show('delete') || watch.running) && (
        <ConfirmDialog
          className={itemClass('danger')}
          label="Delete"
          message="Deleting removes this Watch, its Run history, result files and transcripts."
          confirmLabel="Delete Watch"
          dismissLabel="Keep Watch"
          danger
          disabledReason={watch.running ? 'Cancel the running Run first' : undefined}
          action={() => deleteWatch(id)}
        />
      )}
    </>
  );
}

type Props = { watch: WatchMenuTarget; actions: WatchAction[]; jiraEnabled: boolean };

export function WatchRowMenu(props: Props) {
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
      <summary className="btn btn-secondary" aria-label="Watch actions" title="Watch actions">
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

// Header buttons on the Watch detail page; Run now and Resume live in their own components there.
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
  return <ActionButton action={() => resumeWatch(null, form({ id: watchId }))}>Resume</ActionButton>;
}
