'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

const FILES = [
  { label: 'transcript', name: 'transcript.md' },
  { label: 'result', name: 'result.json' },
  { label: 'prompt', name: 'prompt.md' },
] as const;

type FileName = (typeof FILES)[number]['name'];

export function formatFile(name: FileName, text: string): string {
  if (name !== 'result.json') return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// Files are shown as plain text in <pre>, never rendered as HTML or Markdown.
export function RunFileLinks({ runId }: { runId: number }) {
  const t = useTranslations('RunFiles');
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<(typeof FILES)[number] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const open = async (file: (typeof FILES)[number]) => {
    setCurrent(file);
    setContent(null);
    setMissing(false);
    dialog.current?.showModal();
    try {
      const response = await fetch(`/files/run/${runId}/${file.name}`);
      if (!response.ok) setMissing(true);
      else setContent(formatFile(file.name, await response.text()));
    } catch {
      setMissing(true);
    }
  };

  return (
    <span className="run-file-links">
      {FILES.map((file) => (
        <button key={file.name} type="button" className="link-button" onClick={() => open(file)}>
          {t(file.label)}
        </button>
      ))}
      <dialog ref={dialog} className="file-dialog" aria-label={current === null ? t('file') : t(current.label)}>
        <div className="file-dialog-head">
          <strong>{current !== null && t('heading', { file: t(current.label), id: runId })}</strong>
          <button type="button" className="btn btn-secondary" onClick={() => dialog.current?.close()}>
            {t('close')}
          </button>
        </div>
        {missing ? (
          <p className="empty">{current !== null && t('missing', { file: t(current.label) })}</p>
        ) : content === null ? (
          <p className="muted">{t('loading')}</p>
        ) : (
          <pre className="file-view">{content}</pre>
        )}
      </dialog>
    </span>
  );
}
