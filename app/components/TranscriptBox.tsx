'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

// Plain-text transcript tail. It follows new output unless the user has scrolled up from the bottom.
export function TranscriptBox({ text }: { text: string }) {
  const t = useTranslations('Chat');
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    const element = box.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <div
      ref={box}
      className="chat-transcript"
      tabIndex={0}
      aria-label={t('transcriptLabel')}
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
    >
      {text}
    </div>
  );
}
