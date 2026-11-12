'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

export type Suggestion = { id: string; label: string; hint?: string; apply: () => void };

// `/` at the start of a line triggers commands; `@` after whitespace triggers mentions.
const TRIGGER = /(?:^|\n)\/([^\n]*)$|(?:^|\s)@([\w.-]*)$/;

function triggerAt(text: string, caret: number): { kind: '/' | '@'; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = TRIGGER.exec(before);
  if (match === null) return null;
  const kind = match[1] !== undefined ? '/' : '@';
  const query = match[1] ?? match[2] ?? '';
  return { kind, query, start: caret - query.length - 1 };
}

export function PromptInput({
  id,
  name,
  value,
  onChange,
  required,
  className,
  commands,
  mentions,
  onSubmit,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  required: boolean;
  className?: string;
  commands: Suggestion[];
  mentions: Suggestion[];
  onSubmit: () => void;
}) {
  const t = useTranslations('PromptInput');
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const trigger = dismissed ? null : triggerAt(value, caret);
  const items =
    trigger === null
      ? []
      : (trigger.kind === '/' ? commands : mentions).filter((s) =>
          s.label.toLowerCase().includes(trigger.query.toLowerCase()),
        );
  const open = trigger !== null && items.length > 0;
  const current = Math.min(active, Math.max(items.length - 1, 0));

  const pick = (item: Suggestion) => {
    if (trigger === null) return;
    const next = value.slice(0, trigger.start) + value.slice(caret);
    onChange(next);
    setCaret(trigger.start);
    item.apply();
    requestAnimationFrame(() => ref.current?.setSelectionRange(trigger.start, trigger.start));
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((current + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(items[current]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="prompt-input">
      {open && (
        <ul
          className="prompt-suggestions"
          role="listbox"
          aria-label={trigger.kind === '/' ? t('commands') : t('agents')}
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={index === current}
              className={index === current ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
            >
              <span>{item.label}</span>
              {item.hint !== undefined && <span className="muted">{item.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        id={id}
        name={name}
        rows={3}
        required={required}
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          setDismissed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={keyDown}
        placeholder={t('placeholder')}
      />
    </div>
  );
}
