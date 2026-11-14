import type { Watch } from '../domain/types';
import type { DataDir } from '../files/dataDir';
import { denyListViolations, runPrecheckScript } from './script';
import type { Precheck, PrecheckResult, Snapshot } from './types';

export class FreeformPrecheck implements Precheck {
  constructor(private readonly dataDir?: DataDir) {}

  async check(w: Watch): Promise<PrecheckResult> {
    if (w.precheckScript === null || this.dataDir === undefined) return { kind: 'changed', reason: 'interval' };
    // A script without instructions was entered by the user, who is trusted: no deny-list check.
    const violations = w.precheckInstructions === null ? [] : denyListViolations(w.precheckScript);
    if (violations.length > 0) {
      return this.broken(`The pre-check script is not allowed: it ${violations.join('; ')}`);
    }
    const run = await runPrecheckScript(w.precheckScript, this.dataDir.precheckDir(w.id));
    if (!run.ok) return this.broken(`The pre-check script failed: ${run.message}`);
    const script = { output: run.output, problem: null };
    return w.precheckOutput === run.output
      ? { kind: 'unchanged', script }
      : { kind: 'changed', reason: 'pre-check output changed', script };
  }

  async snapshot(w: Watch): Promise<Snapshot> {
    return { events: [], cursorCandidate: {}, title: w.title };
  }

  // A broken script must not silence the Automation, so the Run goes ahead and the problem is flagged.
  private broken(problem: string): PrecheckResult {
    return { kind: 'changed', reason: 'interval', script: { output: null, problem } };
  }
}
