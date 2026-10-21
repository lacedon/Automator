import type { ClosedReason, Cursor, Watch } from '../domain/types';

export type EventSummary = { at: number; author: string; text: string; url?: string };

export type PrecheckResult =
  | { kind: 'changed'; reason: string }
  | { kind: 'unchanged'; cursor?: Cursor }
  | { kind: 'close'; reason: 'merged' | 'mr-closed' | 'jira-done' }
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
