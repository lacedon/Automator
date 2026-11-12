// SQL lives in a TS module (not .sql files) so the Next.js server bundle carries it; versions apply in order.
export const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `CREATE TABLE watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('mr', 'jira', 'free')),
  target_url TEXT NOT NULL,
  normalized_target TEXT NOT NULL,
  repository TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'needs_you', 'closed')),
  instructions TEXT,
  interval_ms INTEGER,
  model TEXT,
  initial_review TEXT CHECK (initial_review IN ('baseline-only', 'unresolved')),
  mr_source_branch TEXT,
  cursor_json TEXT,
  next_check_at INTEGER,
  check_failures INTEGER NOT NULL DEFAULT 0,
  needs_you_reason TEXT,
  needs_you_since INTEGER,
  needs_you_run_id INTEGER,
  resolution_note TEXT,
  closed_reason TEXT CHECK (closed_reason IN ('merged', 'mr-closed', 'jira-done', 'user')),
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX ux_watch_target ON watches(normalized_target, repository) WHERE state <> 'closed';

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER REFERENCES watches(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'finished')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'adhoc')),
  priority INTEGER NOT NULL CHECK (priority IN (0, 1)),
  reason TEXT NOT NULL,
  adhoc_prompt TEXT,
  extra_instructions TEXT,
  review_unresolved INTEGER NOT NULL DEFAULT 0 CHECK (review_unresolved IN (0, 1)),
  model TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  pid INTEGER,
  cancel_requested_at INTEGER,
  exit_code INTEGER,
  result_status TEXT CHECK (result_status IN ('success', 'error')),
  outcome TEXT CHECK (outcome IN ('nothing', 'acted', 'needs-you')),
  summary TEXT,
  error_json TEXT,
  interrupted TEXT CHECK (interrupted IN ('timeout', 'cancelled', 'worker-restart')),
  cursor_candidate_json TEXT,
  branch TEXT,
  prompt_path TEXT,
  transcript_path TEXT,
  result_path TEXT
);

CREATE UNIQUE INDEX ux_run_queued_per_watch ON runs(watch_id) WHERE status = 'queued';
CREATE UNIQUE INDEX ux_run_running ON runs(status) WHERE status = 'running';
CREATE INDEX ix_run_queue ON runs(status, priority, queued_at, id);

CREATE TABLE needs_you_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  teams_status TEXT NOT NULL CHECK (teams_status IN ('pending', 'sent', 'failed', 'disabled')),
  teams_error TEXT
);

CREATE INDEX ix_needs_you_events_watch ON needs_you_events(watch_id, id);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE worker_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    sql: `ALTER TABLE runs ADD COLUMN ticket_key TEXT;
ALTER TABLE runs ADD COLUMN ticket_title TEXT;
`,
  },
  {
    version: 3,
    sql: `ALTER TABLE runs ADD COLUMN session_id TEXT;
ALTER TABLE runs ADD COLUMN parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
CREATE INDEX ix_run_parent ON runs(parent_run_id);
`,
  },
  {
    version: 4,
    sql: `ALTER TABLE runs ADD COLUMN workflow_type TEXT NOT NULL DEFAULT 'free-adhoc'
  CHECK (workflow_type IN ('mr-watch', 'jira-watch', 'free-watch', 'ticket-adhoc', 'free-adhoc'));

UPDATE runs
SET workflow_type = CASE
  WHEN watch_id IS NOT NULL THEN (
    SELECT CASE kind
      WHEN 'mr' THEN 'mr-watch'
      WHEN 'jira' THEN 'jira-watch'
      WHEN 'free' THEN 'free-watch'
    END
    FROM watches
    WHERE watches.id = runs.watch_id
  )
  ELSE CASE WHEN ticket_key IS NOT NULL THEN 'ticket-adhoc' ELSE 'free-adhoc' END
END
WHERE parent_run_id IS NULL;

WITH RECURSIVE inherited(run_id, workflow_type) AS (
  SELECT id, workflow_type FROM runs WHERE parent_run_id IS NULL
  UNION
  SELECT child.id, inherited.workflow_type
  FROM runs AS child
  JOIN inherited ON child.parent_run_id = inherited.run_id
)
UPDATE runs
SET workflow_type = COALESCE((
    SELECT inherited.workflow_type
    FROM inherited
    WHERE inherited.run_id = runs.id
    LIMIT 1
  ), workflow_type)
WHERE parent_run_id IS NOT NULL;

CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('mr-watch', 'jira-watch', 'free-watch', 'ticket-adhoc', 'free-adhoc')),
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_assignments (
  repository TEXT,
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('mr-watch', 'jira-watch', 'free-watch', 'ticket-adhoc', 'free-adhoc')),
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX ux_agent_assignment_default
  ON agent_assignments(workflow_type) WHERE repository IS NULL;
CREATE UNIQUE INDEX ux_agent_assignment_repository
  ON agent_assignments(repository, workflow_type) WHERE repository IS NOT NULL;

CREATE TABLE operation_templates (
  workflow_type TEXT PRIMARY KEY CHECK (workflow_type IN ('mr-watch', 'jira-watch', 'free-watch', 'ticket-adhoc', 'free-adhoc')),
  instructions TEXT NOT NULL
);

WITH workflows(workflow_type) AS (
  VALUES ('mr-watch'), ('jira-watch'), ('free-watch'), ('ticket-adhoc'), ('free-adhoc')
)
INSERT INTO agents (workflow_type, name, instructions, created_at, updated_at)
SELECT workflow_type, 'Default', '', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM workflows;

INSERT INTO agent_assignments (repository, workflow_type, agent_id)
SELECT NULL, workflow_type, id FROM agents;
`,
  },
  {
    version: 5,
    sql: `ALTER TABLE agents DROP COLUMN workflow_type;
`,
  },
  {
    version: 6,
    sql: `CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE project_repositories (
  repository TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX ix_project_repositories_project ON project_repositories(project_id);
`,
  },
  {
    version: 7,
    sql: `CREATE TABLE repositories (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  folder TEXT NOT NULL,
  gitlab TEXT,
  github TEXT,
  jira TEXT,
  validate_json TEXT NOT NULL
);
`,
  },
  {
    version: 8,
    sql: `ALTER TABLE runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'copilot'
  CHECK (provider IN ('copilot', 'claude-code', 'codex', 'opencode'));
`,
  },
  {
    version: 9,
    sql: `ALTER TABLE watches ADD COLUMN agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
`,
  },
  {
    version: 10,
    sql: `ALTER TABLE projects ADD COLUMN prompt_addition TEXT NOT NULL DEFAULT '';
ALTER TABLE repositories ADD COLUMN prompt_addition TEXT NOT NULL DEFAULT '';
`,
  },
  {
    version: 11,
    sql: `ALTER TABLE agents ADD COLUMN allow_all_tools INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN blocked_tools TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 12,
    sql: `ALTER TABLE projects ADD COLUMN config_overrides TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    version: 13,
    sql: `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX ix_sessions_user ON sessions(user_id);
`,
  },
  {
    version: 14,
    sql: `CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
);

CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE role_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX ux_role_assignments ON role_assignments(user_id, role_id, COALESCE(project_id, 0));
`,
  },
  {
    version: 15,
    sql: `ALTER TABLE watches ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE TRIGGER watches_default_owner AFTER INSERT ON watches WHEN NEW.owner_user_id IS NULL
BEGIN
  UPDATE watches SET owner_user_id = (
    SELECT id FROM users ORDER BY username = 'admin' COLLATE NOCASE DESC, id LIMIT 1
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER runs_default_owner AFTER INSERT ON runs WHEN NEW.owner_user_id IS NULL
BEGIN
  UPDATE runs SET owner_user_id = COALESCE(
    (SELECT owner_user_id FROM watches WHERE id = NEW.watch_id),
    (SELECT id FROM users ORDER BY username = 'admin' COLLATE NOCASE DESC, id LIMIT 1)
  ) WHERE id = NEW.id;
END;
`,
  },
  {
    version: 16,
    sql: `CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
`,
  },
  {
    version: 17,
    sql: `CREATE TABLE user_credentials (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);
`,
  },
  {
    version: 18,
    sql: `DROP INDEX ux_run_running;
ALTER TABLE runs ADD COLUMN isolation TEXT NOT NULL DEFAULT 'shared' CHECK (isolation IN ('shared', 'copy'));
`,
  },
  {
    version: 19,
    sql: `ALTER TABLE runs ADD COLUMN closed_at INTEGER;
`,
  },
  {
    version: 20,
    sql: `ALTER TABLE watches ADD COLUMN precheck_instructions TEXT;
ALTER TABLE watches ADD COLUMN precheck_script TEXT;
ALTER TABLE watches ADD COLUMN precheck_output TEXT;
ALTER TABLE watches ADD COLUMN precheck_problem TEXT;
`,
  },
];
