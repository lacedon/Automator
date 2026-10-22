import type { Watch } from '../domain/types';
import type { Precheck, PrecheckResult, Snapshot } from './types';

export class FreeformPrecheck implements Precheck {
  async check(): Promise<PrecheckResult> {
    return { kind: 'changed', reason: 'interval' };
  }

  async snapshot(w: Watch): Promise<Snapshot> {
    return { events: [], cursorCandidate: {}, title: w.title };
  }
}
