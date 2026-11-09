'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { createPortal, flushSync } from 'react-dom';

const Editor = createContext<{
  close: () => void;
  setPendingCount: Dispatch<SetStateAction<number>>;
  actions: HTMLDivElement | null;
} | null>(null);

export function SettingsDialogActions({ children }: { children: ReactNode }) {
  const editor = useContext(Editor);
  if (editor === null) return children;
  return editor.actions === null ? null : createPortal(children, editor.actions);
}

export function useSettingsDialog(pending = false) {
  const editor = useContext(Editor);
  const setPendingCount = editor?.setPendingCount;
  useEffect(() => {
    if (!pending || !setPendingCount) return;
    setPendingCount((count) => count + 1);
    return () => setPendingCount((count) => count - 1);
  }, [pending, setPendingCount]);
  return editor?.close;
}

export function SettingsDialog({
  title,
  trigger = 'Open',
  wide = false,
  children,
}: {
  title: string;
  trigger?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [session, setSession] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const close = useCallback(() => dialog.current?.close(), []);
  return (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => {
          // Reset before opening so native focus targets the fresh editor.
          flushSync(() => setSession((value) => value + 1));
          dialog.current?.showModal();
          // An overflowing content area would otherwise take the initial focus.
          dialog.current?.querySelector<HTMLElement>('.settings-dialog-content :is(input, select, textarea)')?.focus();
        }}
      >
        {trigger}
      </button>
      <dialog
        ref={dialog}
        className={`settings-dialog${wide ? ' settings-dialog-wide' : ''}`}
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (pendingCount > 0) event.preventDefault();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <Editor value={{ close, setPendingCount, actions }}>
          <div key={session} className="settings-dialog-content">
            {children}
          </div>
        </Editor>
        <div className="settings-dialog-footer">
          <div className="settings-dialog-actions" ref={setActions} />
          <button type="button" className="btn btn-secondary" disabled={pendingCount > 0} onClick={close}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  );
}
