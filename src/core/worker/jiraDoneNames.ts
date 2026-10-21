import type { Config } from '../config/schema';
import type { Database } from '../db/open';
import type { JiraClient } from '../prechecks/jiraClient';

type DoneNamesCore = { config: Config; db: Database; deps: { jira(conn: string): JiraClient } };

const ts = () => new Date().toISOString();

export async function resolveJiraDoneNames(core: DoneNamesCore): Promise<void> {
  for (const [conn, { doneStatusIds }] of Object.entries(core.config.jira.connections)) {
    if (doneStatusIds === undefined || doneStatusIds.length === 0) continue;
    try {
      const known = new Map((await core.deps.jira(conn).statuses()).map((s) => [s.id, s.name]));
      const names: Record<string, string> = {};
      for (const id of doneStatusIds) {
        const name = known.get(id);
        if (name === undefined) console.warn(`${ts()} jira: unknown Done status id ${id} on connection "${conn}"`);
        names[id] = name ?? `${id} (unknown)`;
      }
      core.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(`jira_done_names:${conn}`, JSON.stringify(names));
    } catch (e) {
      console.error(`${ts()} jira: cannot resolve Done status names for "${conn}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
