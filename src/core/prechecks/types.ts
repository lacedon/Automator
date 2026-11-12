import type { ClosedReason, Cursor, Watch } from '../domain/types';

export type EventSummary = { at: number; author: string; text: string; url?: string };

// What a pre-check script left behind: the output to remember, or the problem to show next to the Automation.
export type ScriptState = { output: string | null; problem: string | null };

export type PrecheckResult =
  | { kind: 'changed'; reason: string; script?: ScriptState }
  | { kind: 'unchanged'; cursor?: Cursor; script?: ScriptState }
  | { kind: 'close'; reason: 'merged' | 'mr-closed' | 'jira-done' }
  | { kind: 'blocked'; message: string }
  | { kind: 'failed'; auth: boolean; message: string };

export type Snapshot = {
  events: EventSummary[];
  cursorCandidate: Cursor;
  title: string;
  sourceBranch?: string;
  close?: ClosedReason;
};

export interface Precheck {
  check(w: Watch): Promise<PrecheckResult>;
  snapshot(w: Watch, opts: { reviewUnresolved: boolean }): Promise<Snapshot>;
}
