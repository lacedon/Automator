'use client';

import { useState } from 'react';
import type { FileView, ThreadView } from '@core/index';
import { ChatPane } from './ChatPane';

type Tab = 'transcript' | 'result' | 'prompt' | 'chat';

const TAB_LABEL: Record<Tab, string> = {
  transcript: 'Transcript',
  result: 'Result JSON',
  prompt: 'Prompt',
  chat: 'Chat',
};

type Props = {
  transcript: FileView;
  result: FileView;
  prompt: FileView;
  noTranscript: string;
  thread: ThreadView | null;
  currentRunId: number;
};

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// Files are shown as plain text in <pre>, never rendered as HTML or Markdown.
function FilePane({ file, empty, format }: { file: FileView; empty: string; format?: (text: string) => string }) {
  if (file.content === null) return <p className="empty">{empty}</p>;
  return (
    <>
      <pre className="file-view">{format && !file.truncated ? format(file.content) : file.content}</pre>
      {file.truncated && <p className="muted">(truncated at 5 MB)</p>}
    </>
  );
}

export function RunTabs({ transcript, result, prompt, noTranscript, thread, currentRunId }: Props) {
  const [tab, setTab] = useState<Tab>('transcript');
  return (
    <div>
      <div className="tabs" role="tablist">
        {(Object.keys(TAB_LABEL) as Tab[])
          .filter((t) => t !== 'chat' || thread !== null)
          .map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'tab on' : 'tab'}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
      </div>
      <div role="tabpanel">
        {tab === 'transcript' && <FilePane file={transcript} empty={noTranscript} />}
        {tab === 'result' && <FilePane file={result} empty="No result file." format={prettyJson} />}
        {tab === 'prompt' && <FilePane file={prompt} empty="No prompt file." />}
        {tab === 'chat' && thread !== null && <ChatPane thread={thread} currentRunId={currentRunId} />}
      </div>
    </div>
  );
}
