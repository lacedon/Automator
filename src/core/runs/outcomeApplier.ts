import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import { toWatch } from '../db/rows';
import type { Interrupted, NeedsYouEvent, Outcome, RunError } from '../domain/types';
import { intervalFor } from '../domain/schedule';
import { enterNeedsYou } from '../watches/needsYou';

export type RunFinal = {
  runId: number;
  endedAt: number;
  exitCode: number | null;
  resultStatus: 'success' | 'error';
  outcome: Outcome | null;
  summary: string | null;
  error: RunError | null;
  interrupted: Interrupted | null;
  branch: string | null;
  promptPath: string | null;
  transcriptPath: string | null;
  resultPath: string;
};

export function applyOutcome(db: Database, config: Config, final: RunFinal): { needsYou: NeedsYouEvent | null } {
  return db
    .transaction((): { needsYou: NeedsYouEvent | null } => {
      const now = final.endedAt;
      const run = db
        .prepare(
          `UPDATE runs SET status = 'finished', ended_at = ?, exit_code = ?, result_status = ?, outcome = ?, summary = ?,
                  error_json = ?, interrupted = ?, branch = ?, prompt_path = ?, transcript_path = ?, result_path = ?
           WHERE id = ? AND status = 'running' RETURNING watch_id, cursor_candidate_json`,
        )
        .get(
          now,
          final.exitCode,
          final.resultStatus,
          final.outcome,
          final.summary,
          final.error === null ? null : JSON.stringify(final.error),
          final.interrupted,
          final.branch,
          final.promptPath,
          final.transcriptPath,
          final.resultPath,
          final.runId,
        ) as { watch_id: number | null; cursor_candidate_json: string | null } | undefined;
      if (run === undefined) {
        if (db.prepare('SELECT 1 FROM runs WHERE id = ?').get(final.runId) === undefined) {
          throw new Error(`Run #${final.runId} not found`);
        }
        return { needsYou: null };
      }
      if (run.watch_id === null) return { needsYou: null };

      const row = db.prepare('SELECT * FROM watches WHERE id = ?').get(run.watch_id);
      if (row === undefined) return { needsYou: null };
      const watch = toWatch(row);

      const succeeded = final.resultStatus === 'success' && (final.outcome === 'nothing' || final.outcome === 'acted');
      if (!succeeded) {
        const reason =
          final.resultStatus === 'error'
            ? (final.error?.message ?? 'Run failed')
            : (final.summary ?? 'Copilot asked for help');
        const needsYou = enterNeedsYou(db, {
          watchId: watch.id,
          runId: final.runId,
          reason,
          now,
          teamsEnabled: config.teams !== undefined,
        });
        return { needsYou };
      }

      db.prepare(
        `UPDATE watches SET cursor_json = COALESCE(?, cursor_json), resolution_note = NULL, next_check_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        run.cursor_candidate_json,
        watch.state === 'active' ? now + intervalFor(watch, config) : watch.nextCheckAt,
        now,
        watch.id,
      );
      return { needsYou: null };
    })
    .immediate();
}
