# Architecture and implementation design (v1)

Status: approved design, 2026-10-21. Defines how v1 is built. Behavior is defined by [README.md](../../../README.md), terms by [GLOSSARY.md](../../../GLOSSARY.md), the Repository/queue decision by [ADR 0001](../../adr/0001-serialize-runs-in-configured-repository-folders.md), and screens by the [dashboard UI design](./2026-10-21-dashboard-ui-design.md). This spec does not change any behavior defined there; where it adds a rule, the rule fills a gap and is marked **(new rule)**.

## Intent

Someone can build v1 from the README, the UI spec and this document without making structural decisions. Every unit below has one purpose, a small interface and injectable dependencies, so it can be tested without network, Copilot tokens or a browser.

## Decisions summary

| Topic | Decision |
| --- | --- |
| Copilot invocation | Spawn `copilot -p` as a child process in the Repository folder |
| Run result channel | Prompt tells Copilot to write `{outcome, summary}` to a per-Run file; the worker validates it |
| Process coordination | SQLite only; no network port between dashboard, CLI and worker |
| Repo layout | Single npm package; `src/core` shared by `app/`, `src/worker`, `src/cli` |
| Dashboard freshness | Visibility-aware `router.refresh()` every ~3 s |
| Testing | Vitest + temp SQLite + fake clock, `msw` for HTTP, fake `copilot` script, Playwright smoke |

## Processes

`npm start` runs both long-lived processes with `concurrently`:

- **web**: `next start --hostname 127.0.0.1 --port 4317` (port configurable via `PORT`). Server Components read through `core/read-models`; mutations are Server Actions calling core services. `proxy.ts` answers 403 to any request whose `Host` (or `X-Forwarded-Host`) isn't `127.0.0.1`, `localhost` or `[::1]` (DNS-rebinding guard) and sets `X-Content-Type-Options: nosniff`; Next.js itself rejects Server Actions whose `Origin` doesn't match the host.
- **worker**: `tsx src/worker/main.ts`. Owns scheduling, pre-checks, Copilot Runs, notifications and cleanup.

The **CLI** (`automator`, `tsx src/cli/main.ts`, exposed via `package.json#bin`) is a short-lived process calling the same core services as the dashboard. Neither the dashboard nor the CLI talks to the worker; they write SQLite rows the worker picks up.

### Worker single-instance lock

On startup the worker, in a `BEGIN IMMEDIATE` transaction, reads `worker_lock` (single row). If a row exists with `heartbeat_at` newer than 15 s and its `pid` is alive (`process.kill(pid, 0)`), the worker exits with code 1 and a clear message. Otherwise it writes its own `pid`, `started_at`, `heartbeat_at`. The heartbeat updates every loop iteration. The lock is cleared on graceful shutdown (SIGINT/SIGTERM): the worker stops claiming, waits for the active Run to finish, then exits. Signals within 1 s of the first count as the same Ctrl-C (one Ctrl-C reaches the worker from the terminal and from the start script); a later one SIGKILLs the active Copilot group and exits at once, leaving the Run to restart recovery. `scripts/start.mjs` replaces `concurrently`, whose tree-kill would also signal Copilot: it forwards signals to its two direct children only, stops the other process when one exits on its own, and runs the worker under plain `node --import tsx` because the tsx CLI SIGKILLs its child when several signals arrive at once.

### Worker loop

A single async loop, iteration every 1 s; no overlapping iterations:

1. Update heartbeat.
2. If a Run is active: watchdog check (cancel request, timeout).
3. If no Run is active: `queue.claimNext()`; if a row is claimed, start `RunExecutor.execute()` (not awaited by the loop; the loop keeps ticking the watchdog).
4. Every 30 s: scheduler tick.
5. When due (`meta.last_cleanup_at` + `cleanup.everyDays`): cleanup.

Startup order: load config → open DB and migrate → acquire lock → **restart recovery** (see Runs) → resolve Jira Done status names (when Jira is enabled) → loop.

## Source layout

```
app/                         Next.js App Router (routes from the UI spec)
  (dashboard)/layout.tsx     sidebar, top bar, <AutoRefresh/>
  page.tsx                   Home
  watches/  queue/  runs/  adhoc/
  actions/                   Server Actions (thin: parse FormData → core service → revalidate)
  components/                pills, tables, dialogs, AutoRefresh
src/core/
  config/                    zod schema, loader, secrets, duration parsing
  db/                        open(), migrations/index.ts (SQL per version), migrate()
  domain/                    targets, watch state machine, schedule math, Result/AppError
  watches/                   WatchService
  queue/                     QueueService
  prechecks/                 gitlab.ts, jira.ts, freeform.ts, types.ts
  runs/                      PromptBuilder, CopilotLauncher, RunExecutor, OutcomeApplier, recovery
  files/                     DataDir layout, atomic JSON write, attempt error files
  notify/                    TeamsNotifier
  cleanup/                   CleanupService
  read-models/               queries returning UI view models
  index.ts                   createCore(config, deps): composition root
src/worker/main.ts           loop, lock, signals
src/cli/main.ts              commander commands
prompts/                     mr.md, jira.md, free.md (default prompts, editable)
test/                        fixtures (fake-copilot.mjs, msw handlers), e2e/
automator.config.example.json
```

### Boundaries

- `src/core` never imports `next`, `src/worker` or `src/cli`. `app/`, `src/worker` and `src/cli` import only `src/core/index.ts` (and its exported types). Enforced by dependency-cruiser.
- Everything external is behind an injected interface, supplied by `createCore(config, deps)`:

```ts
interface Deps {
  clock: Clock;                // now(): number
  gitlab: (conn: string) => GitLabClient;
  jira: (conn: string) => JiraClient;
  copilot: CopilotLauncher;    // spawn + kill, returns a handle
  notifier: Notifier;          // notifyNeedsYou(event)
  fs?: FileStore;              // defaults to node:fs implementation
}
```

- `package.json`: `"type": "module"`; `next.config.ts` sets `serverExternalPackages: ['better-sqlite3']`. TypeScript `strict`, path alias `@core/*` → `src/core/*`.
- Main dependencies: `next`, `react`, `better-sqlite3`, `zod`, `commander`, `dotenv`, `tsx`, `concurrently`. Dev: `vitest`, `msw`, `@playwright/test`, `eslint`, `dependency-cruiser`, `typescript`.

## Configuration and secrets

Config file: `automator.config.json` in the project root (gitignored), overridable with `AUTOMATOR_CONFIG`. Validated with zod at process start; any error prints all issues and exits nonzero. Loading never touches the network. `automator.config.example.json` is committed without credentials. The real file is plain JSON; comments below are explanatory only.

```jsonc
{
  "dataDir": "~/.automator",
  "copilotBin": "copilot",                       // tests point this at the fake script
  "repositories": {
    "pages": {
      "folder": "~/work/pages",
      "gitlab": "corp",                          // gitlab connection name
      "jira": "corp",                            // optional jira connection name
      "validate": ["npm run lint", "npm test"]   // empty ⇒ Copilot must escalate before pushing
    }
  },
  "gitlab": { "corp": { "host": "https://gitlab.example.com", "tokenEnv": "GITLAB_TOKEN" } },
  "jira": {
    "enabled": false,
    "connections": {
      "corp": { "baseUrl": "https://jira.example.com", "emailEnv": "JIRA_EMAIL", "tokenEnv": "JIRA_TOKEN", "doneStatusIds": ["10001"] }
    }
  },
  "schedule": {
    "intervals": { "mr": "15m", "default": "2h" },
    "workingHours": { "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "19:00" }
  },
  "runs": {
    "timeoutMinutes": 30,
    "defaultModel": "claude-sonnet-4.5",
    "models": ["claude-sonnet-4.5", "gpt-5"],
    "initialReview": "baseline-only",
    "denyTools": []                               // Copilot CLI permission patterns, see CopilotLauncher
  },
  "prompts": { "dir": "./prompts" },
  "cleanup": { "enabled": true, "everyDays": 7, "retainClosedDays": 30 },
  "teams": {                                      // omit ⇒ notifications disabled
    "chatId": "19:abc@thread.v2",
    "tool": "teams-global(send_chat_message)",    // MCP permission pattern for the send tool (default shown)
    "dashboardUrl": "http://127.0.0.1:4317"       // used in the message link (default shown); optional "model"
  }
}
```

Rules:

- `~` expands to the home directory; relative paths resolve against the config file's folder.
- Every Repository's `gitlab`/`jira` must reference an existing connection (load error otherwise). A Repository folder that doesn't exist is **not** a load error; it is detected per Run/creation as described below.
- `doneStatusIds`: absent ⇒ Done status category; `[]` ⇒ auto-close disabled.
- `workingHours.days` must be non-empty without repeats and `start` must be earlier than `end` (no overnight windows); `runs.defaultModel` must be non-empty (load errors otherwise).
- Secrets come only from the environment, loaded with `dotenv` from `.env` in the project root. The config holds env var **names**, never values. A missing token var makes that connection "no token": GitLab pre-checks then fail with an auth error (Watch → Needs you); Jira falls back to MCP-based checking as the README describes.
- Config changes need a restart of both processes.

## Data model

SQLite at `<dataDir>/automator.db`. Connection pragmas: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`. Migrations are numbered `.sql` files applied in order and tracked with `PRAGMA user_version`; both processes call `migrate()` on start (idempotent, inside an immediate transaction). Times are INTEGER epoch milliseconds. IDs are INTEGER autoincrement; a Run's display number `#n` is `runs.id`.

### `watches`

| Column | Notes |
| --- | --- |
| id | PK |
| kind | `mr` \| `jira` \| `free` |
| target_url | as entered (normalized display form) |
| normalized_target | `gitlab:<host>/<project path>!<iid>`, `jira:<host>/<KEY>`, or the normalized URL for free-form |
| repository | Repository name from config |
| title | from GitLab/Jira preview when available, else target |
| state | `active` \| `paused` \| `needs_you` \| `closed` |
| instructions | extra instructions; required for `free` |
| interval_ms, model, initial_review | NULL ⇒ config default |
| mr_source_branch | refreshed on every MR snapshot |
| cursor_json | last handled point (see Pre-checks); NULL until first check |
| next_check_at | NULL while not scheduled (paused, needs_you, closed) |
| check_failures | consecutive failed pre-checks |
| needs_you_reason, needs_you_since, needs_you_run_id | set on entering Needs you, cleared on resume |
| resolution_note | set on resume; cleared after the next Run with result `success` |
| closed_reason | `merged` \| `mr-closed` \| `jira-done` \| `user` |
| closed_at, created_at, updated_at | |

Partial unique index `ux_watch_target ON watches(normalized_target, repository) WHERE state <> 'closed'` enforces "one non-Closed Watch per target and Repository" for every writer, including reopen. Services also check before insert so they can return a friendly `DUPLICATE_WATCH` with the existing Watch; the index is the backstop for races.

### `runs` (also the queue)

| Column | Notes |
| --- | --- |
| id | PK, display `#n` |
| watch_id | FK → watches, NULL for ad-hoc, `ON DELETE CASCADE` |
| repository | |
| status | `queued` \| `running` \| `finished` |
| trigger | `schedule` \| `manual` \| `adhoc` |
| priority | 0 = manual/ad-hoc, 1 = scheduled |
| reason | short text shown in the Queue page, e.g. "new comment by @anna" |
| adhoc_prompt, extra_instructions | |
| review_unresolved | 0/1 |
| model | resolved at enqueue |
| queued_at, started_at, ended_at | |
| pid | process group id of the Copilot child |
| cancel_requested_at | set by dashboard/CLI |
| exit_code | |
| result_status | `success` \| `error` |
| outcome | `nothing` \| `acted` \| `needs-you` (NULL on error) |
| summary | |
| error_json | structured error `{code, message, detail?}` |
| interrupted | `timeout` \| `cancelled` \| `worker-restart` \| NULL |
| cursor_candidate_json | snapshot cursor taken at Run start |
| branch | current branch of the checkout after the Run (`git rev-parse --abbrev-ref HEAD`) |
| prompt_path, transcript_path, result_path | |

Indexes:

- `ux_run_queued_per_watch ON runs(watch_id) WHERE status = 'queued'`: at most one queued request per Watch.
- `ux_run_running ON runs(status) WHERE status = 'running'`: at most one running Run globally.
- `ix_run_queue ON runs(status, priority, queued_at, id)`.

### `needs_you_events`

`id, watch_id (FK cascade), run_id (nullable), reason, created_at, teams_status (pending|sent|failed|disabled), teams_error`. One row per transition into Needs you. The Watch detail page shows the latest row's Teams status.

### `meta`

Key/value text: `jira_done_names:<conn>` (JSON map id → name), `last_cleanup_at`, `gitlab_me:<conn>` (cached user id/username).

### `worker_lock`

Single row: `pid, started_at, heartbeat_at`. The dashboard does **not** show worker health in v1.

### Data directory

```
<dataDir>/
  automator.db
  runs/<runId>/prompt.md
  runs/<runId>/transcript.md          (from --share; absent if Copilot never started)
  runs/<runId>/copilot-result.json    (written by Copilot)
  runs/<runId>/result.json            (final, versioned, written by the worker)
  runs/<runId>/cli.log                (Copilot stdout/stderr)
  attempts/<ISO-timestamp>-<uuid>.json
```

All worker-written JSON is written atomically (write `*.tmp`, `fsync`, `rename`).

## Domain rules

### Targets

`parseTarget(input, config)` → `{kind, normalizedTarget, displayUrl, gitlab?: {host, projectPath, iid}, jira?: {host, key}}` or `INVALID_TARGET`.

- GitLab MR: URL whose host matches a configured GitLab connection host and whose path matches `/<project path>/-/merge_requests/<iid>`. Normalization: lowercase host, strip trailing slash, query, fragment and sub-paths (`/diffs`, `/pipelines`).
- Jira: a bare key `ABC-123` (resolved against the chosen Repository's Jira connection) or a `/browse/ABC-123` URL on a configured Jira host. Key uppercased.
- Anything else with `http(s)` is free-form; normalization lowercases scheme/host and strips the fragment and trailing slash.

### Watch state machine

| From \ action | pause | resume | resume & run now | close | reopen | run now | delete |
| --- | --- | --- | --- | --- | --- | --- | --- |
| active | paused | – | – | closed | – | enqueue manual | if no running Run |
| paused | – | active | – | closed | – | enqueue manual | if no running Run |
| needs_you | paused | active | active + enqueue manual | closed | – | – | if no running Run |
| closed | – | – | – | – | active (dup check) | – | if no running Run |

- Invalid combinations return `INVALID_STATE`; the UI hides or disables them per the UI spec.
- **(new rule)** Run now is allowed on Paused Watches (a one-off manual Run; the Watch stays Paused). Scheduled queue rows of a Watch that becomes Paused are dropped at claim time.
- **(new rule)** Run now on a Jira Watch while `jira.enabled` is false returns `JIRA_DISABLED`.
- Close and delete remove the Watch's queued row in the same transaction. Delete while a Run is running returns `RUN_IN_PROGRESS`.
- Pause/close during a Run only change `watches.state`; the Run continues, and the outcome applier respects the new state (below).
- Entering `active` (create, resume, reopen) sets `next_check_at = now` so the Watch is checked on the next tick. Leaving `active` sets `next_check_at = NULL`.
- Reopen keeps `cursor_json`, so already handled events don't start new Runs.

### Schedule math

`isWithinWorkingHours(t)` and `nextWindowStart(t)` use the system local time zone. Interval strings (`15m`, `2h`, `1d`) are parsed by `parseDuration`. The Watches list "Next check" column comes from a read model that combines `next_check_at`, working hours, queue position, running state, Jira enabled and the cleanup date.

## Core services

All services are synchronous over `better-sqlite3` except where network or processes are involved. They return `Result<T, AppError>`:

```ts
type AppError =
  | { code: 'UNKNOWN_REPOSITORY'; name: string; known: string[]; attemptFile: string | null; attemptFileError?: string }
  | { code: 'DUPLICATE_WATCH'; existing: { id: number; state: WatchState; intervalMs: number } }
  | { code: 'INVALID_TARGET'; message: string }
  | { code: 'MISSING_INSTRUCTIONS' }
  | { code: 'INVALID_STATE'; state: WatchState; action: string }
  | { code: 'RUN_IN_PROGRESS'; runId: number }
  | { code: 'JIRA_DISABLED' }
  | { code: 'NOT_FOUND' };
```

### WatchService

`create(input)`, `update(id, {instructions, intervalMs, model, initialReview})`, `pause`, `resume(id, {note?, runNow?})`, `close`, `reopen`, `delete`, `runNow(id, {extraInstructions?, reviewUnresolved?})`, `preview(target, repository)` (async; GitLab MR title/state/branch, never blocks creation).

`create` order: validate Repository name → on unknown, write the attempt file (`{schemaVersion: 1, attemptId, at, status: "error", error: {code: "UNKNOWN_REPOSITORY", name, known}}`) and return the error with its path (or `null` + write error) → parse target → require instructions for free-form → duplicate check → insert (`state = active`, `next_check_at = now`). Creation does not call GitLab/Jira except for the optional title, which comes from `preview` when the dashboard has it; the CLI leaves the title empty and the first snapshot fills it.

### QueueService

- `enqueue({watchId | adhoc, trigger, reason, extraInstructions?, reviewUnresolved?, model})`: inserts a `queued` row; for Watch triggers, if a queued row already exists for the Watch it is **merged** instead: priority becomes `min(old, new)`, trigger becomes `manual` if either is manual, extra instructions are concatenated (blank line separated, de-duplicated), `review_unresolved` is OR-ed, reason is appended. `queued_at` keeps the original value.
- `claimNext()`: in `BEGIN IMMEDIATE`: if any row is `running`, return null. Select the first `queued` row by `priority, queued_at, id`. If it belongs to a Watch that is `closed` or `needs_you`, delete the row and repeat. Scheduled rows for a `paused` Watch are deleted too; manual rows for a paused Watch run. Set `status = running, started_at = now` and return it.
- `cancel(runId)`: queued ⇒ delete the row; running ⇒ set `cancel_requested_at`; finished ⇒ `INVALID_STATE`.
- `deleteAdhoc(runId)`: only for finished ad-hoc Runs; deletes the row and its `runs/<id>` folder.

### Pre-checks

```ts
interface Precheck {
  check(watch: Watch): Promise<PrecheckResult>;   // scheduler: decide whether to enqueue
  snapshot(watch: Watch, opts: { reviewUnresolved: boolean }): Promise<Snapshot>; // Run start
}
type PrecheckResult =
  | { kind: 'changed'; reason: string }
  | { kind: 'unchanged'; cursor?: Cursor }          // cursor set only for the baseline-only first check
  | { kind: 'close'; reason: 'merged' | 'mr-closed' | 'jira-done' }
  | { kind: 'failed'; auth: boolean; message: string };
type Snapshot = { events: EventSummary[]; cursorCandidate: Cursor; title: string; sourceBranch?: string; close?: ClosedReason };
```

**GitLab** (REST v4, `PRIVATE-TOKEN` header):

- `GET /user` once per connection, cached in `meta.gitlab_me:<conn>`.
- `GET /projects/:id/merge_requests/:iid` → `state`, `sha`, `detailed_merge_status`, `head_pipeline`, `source_branch`, `title`.
- `GET /projects/:id/merge_requests/:iid/discussions` (paginated) → notes.
- Cursor: `{ lastNoteId, handledPipelineId, handledConflictSha }`.
- Changed when any of the following holds:
  - a non-system note by someone other than "me" has `id > lastNoteId`,
  - `head_pipeline.status = failed` for the current `sha` and its id differs from `handledPipelineId`,
  - `detailed_merge_status` indicates a conflict and `sha` differs from `handledConflictSha`.
- First check (NULL cursor): `baseline-only` records `lastNoteId = max(note id)` and still treats a failed pipeline or conflict as changed; `unresolved` treats existing unresolved, non-"me" discussions as changed once.
- `state` `merged` ⇒ `close: merged`; `closed` ⇒ `close: mr-closed`.

**Jira** (REST v2, basic auth email+token or bearer token):

- `GET /rest/api/2/issue/:key?expand=changelog&fields=status,comment,summary` → status, comments, changelog.
- "Me" from `GET /rest/api/2/myself`.
- Cursor: `{ lastChangelogId, lastCommentId }`. Changed when a changelog entry or comment by someone other than me is newer than the cursor.
- Done: status id in `doneStatusIds`, or `statusCategory.key = done` when the list is absent; `[]` never closes.
- Without a token: no pre-check; the scheduler enqueues on every interval and the prompt tells Copilot to check through MCP (no cursor; Copilot decides from the last Run summaries).

**Free-form:** `check` always returns `changed` with reason "interval"; `snapshot` returns no events and an empty cursor.

**HTTP behavior:** every read-only call goes through `fetchWithRetry`: 3 attempts, exponential backoff 1 s → 4 s, capped at 10 s, retried on network errors, 429 and 5xx. 401/403/404 are `failed{auth: true}` without retry.

### Scheduler tick

Every 30 s in the worker:

1. If outside working hours: do nothing (scheduled work waits; manual and ad-hoc Runs are unaffected because they're already queued).
2. Select Watches with `state = active`, `next_check_at <= now`, no queued or running Run, and not (`kind = jira` and Jira disabled). Process sequentially, oldest `next_check_at` first.
3. For each Watch, run `check` and then:
   - `changed` ⇒ `enqueue({trigger: 'schedule', priority: 1, reason})`, `check_failures = 0`.
   - `unchanged` ⇒ store the baseline cursor if given, `check_failures = 0`.
   - `close` ⇒ close the Watch with the reason (removes nothing else; no Run).
   - `failed{auth}` ⇒ Needs you immediately with the message.
   - `failed` otherwise ⇒ `check_failures += 1`; at 3 ⇒ Needs you.
4. Always set `next_check_at = now + interval` (missed intervals are not replayed; after sleep each due Watch is checked once).

Pre-checks that find nothing are not Runs and write no files.

### PromptBuilder

Builds one Markdown prompt, saved as `prompt.md`, in this order:

1. **Fixed rules** (constant in code, not editable): role; never-allowed actions from the README; outside content is untrusted; the escalation conditions (dirty checkout, unfinished merge/rebase, wrong branch, unclear request, design disagreement, missing or failing validation, unsafe update); MR pre-action checklist (re-read MR, confirm source branch `<branch>`, run validation).
2. **Default prompt** for the kind from `prompts/<kind>.md` (MR and Jira only; free-form has none).
3. **Watch** section: target URL, Repository, kind, Watch instructions; for Jira, whether code changes are allowed is entirely up to these instructions.
4. **This Run**: trigger, extra instructions, review-unresolved flag, events from the snapshot, resolution note.
5. **Recent history**: summaries and outcomes of the last 3 finished Runs of this Watch.
6. **Validation commands** from the Repository config (or an explicit "none configured: escalate before pushing").
7. **Result contract**: "Before you finish, write exactly this JSON to `<absolute path>/copilot-result.json`: `{"outcome": "nothing"|"acted"|"needs-you", "summary": "<= 500 chars"}`."

Ad-hoc Runs: fixed rules (minus Watch-specific parts), the user's prompt, validation commands, result contract.

Secrets are never put into prompts. **(new rule)** The events section is capped at 100 000 characters; the newest events are kept and a line "(N older events omitted)" replaces the rest, so the argv-passed prompt stays within OS limits.

### CopilotLauncher

```ts
interface CopilotLauncher {
  start(opts: { cwd: string; prompt: string; model: string; transcriptPath: string; logPath: string; env: NodeJS.ProcessEnv }): RunningProcess;
}
interface RunningProcess { pid: number; exited: Promise<{ code: number | null; signal: string | null }>; kill(signal: 'SIGTERM' | 'SIGKILL'): void; }
```

Real implementation: `spawn(config.copilotBin, args, { cwd, detached: true, env, stdio: ['ignore', log, log] })`, kill via `process.kill(-pid, signal)`. Arguments:

```
-p <prompt> --model <model> --allow-all-tools --share <transcriptPath>
--no-color --no-ask-user --log-level error
--deny-tool <pattern>            (once per entry in runs.denyTools)
--secret-env-vars <all configured tokenEnv/emailEnv names>
```

The child env is `process.env` minus all configured `tokenEnv`/`emailEnv` variables.

`runs.denyTools` (config, default `[]`) holds Copilot CLI permission patterns. It is mainly for MCP tools that perform never-allowed actions, for example `"gitlab(merge_merge_request)"` or `"jira(transition_issue)"`; server and tool names depend on your MCP setup. CLI shell patterns match at the subcommand level (`shell(git push)`), not by flags, so force-push and remote-branch deletion can't be denied without also blocking normal pushes. Those rules, and any never-allowed action not covered by `denyTools`, are enforced only by the prompt. None of this is a sandbox (README trust boundary).

### RunExecutor

`execute(run)` for a claimed row:

1. **Preflight.** Create `runs/<id>/`. Fail with an error result and no transcript when:
   - the Repository is missing from config or its folder doesn't exist (`REPOSITORY_UNAVAILABLE`),
   - the Watch is Jira and Jira is disabled (`JIRA_DISABLED`),
   - the snapshot fails (`PRECHECK_FAILED`).
   If the snapshot reports the MR merged/closed or the ticket done, close the Watch, finish the Run as `success`/`nothing` with summary "Closed: <reason>", and don't start Copilot.
2. Update `title`, `mr_source_branch`; store `cursor_candidate_json`.
3. Build and save the prompt; `start()` Copilot; store `pid`.
4. **Watchdog** (called by the loop every second): if `cancel_requested_at` is set ⇒ `interrupted = cancelled`; if `now - started_at > timeoutMinutes` ⇒ `interrupted = timeout`. Send SIGTERM to the group, SIGKILL after 10 s if still alive.
5. On exit, read and zod-validate `copilot-result.json` (**(new rule)** extra keys are ignored and a summary over 500 characters is truncated, not rejected). Error codes, in precedence order: `INTERRUPTED` (cancel/timeout), `SPAWN_FAILED` (Copilot binary couldn't start), `EXIT_NONZERO`, `RESULT_MISSING`, `RESULT_INVALID`. Read the checkout's current branch.
6. Write `result.json`:

```json
{
  "schemaVersion": 1,
  "runId": 42,
  "watchId": 7,
  "repository": "pages",
  "trigger": "schedule",
  "startedAt": "2026-10-21T14:02:11.000Z",
  "endedAt": "2026-10-21T14:06:23.000Z",
  "status": "success",
  "outcome": "acted",
  "summary": "Replied to @anna and pushed fix for null check.",
  "error": null,
  "exitCode": 0,
  "transcriptPath": "/Users/me/.automator/runs/42/transcript.md"
}
```

7. Call **OutcomeApplier**, then the Notifier if a Needs-you event was created.

The executor never retries.

### OutcomeApplier

One transaction:

- Update the run row (`finished`, timestamps, exit code, result fields, paths, branch).
- For Watch Runs:
  - `success` with `nothing`/`acted` ⇒ `cursor_json = cursor_candidate_json`, clear `resolution_note`.
  - `success` with `needs-you`, or `error` ⇒ cursor unchanged.
  - State: **closed stays closed**; otherwise `needs-you` or `error` ⇒ `needs_you` (also from `paused`), with reason = summary or error message, `needs_you_run_id`, `needs_you_since`, `next_check_at = NULL`, and a `needs_you_events` row (`teams_status = pending`, or `disabled` when no `teams.chatId`); otherwise the state is unchanged and `next_check_at = now + interval` when active.
- Ad-hoc Runs never touch Watches.

### Restart recovery

At worker start, for each `running` row: if its process group is alive, SIGKILL it; then finalize as `error` with `interrupted = worker-restart` through the same path as step 5–7 (whatever result file exists is ignored). Watch ⇒ Needs you.

### TeamsNotifier

`notifyNeedsYou(event)`: spawns `copilot -p` with a fixed short prompt ("send this message to chat `<chatId>`: <Watch title, reason, dashboard URL>"), `--available-tools` limited to `teams.tool`, `cwd` = data dir, 2-minute timeout, model `teams.model` or `runs.defaultModel`. Exit 0 ⇒ `sent`; anything else ⇒ `failed` with stderr tail as `teams_error`. Runs after the Run is finalized and before the next claim; it is not a Run and is never retried. Failures appear on the Watch detail Needs you card.

### CleanupService

When enabled and due: in one transaction, select Watches with `state = closed AND closed_at < now - retainClosedDays`; delete them (runs and needs_you_events cascade); after commit, remove their `runs/<id>/` folders. Attempt files older than `retainClosedDays` are removed too. Ad-hoc Runs are never cleaned. Files in Repositories are never touched. Sets `meta.last_cleanup_at`.

### Read models

Plain query functions returning view-model objects shaped for the UI spec: `homeView()`, `watchList(filters)`, `watchDetail(id)`, `queueView()`, `runList(filters)`, `runDetail(id)` (reads transcript/result/prompt files lazily, size-capped at 5 MB with a truncation notice), `adhocView()`, `formOptions()` (Repositories with folder and host, models, defaults, Jira enabled). Watch counts and the "Next check" text are computed here so pages stay thin.

## Dashboard

- Routes and contents exactly as the UI spec: `/`, `/watches`, `/watches/new`, `/watches/[id]`, `/watches/[id]/edit`, `/queue`, `/runs`, `/runs/[id]`, `/adhoc`.
- Pages are dynamic Server Components (`export const dynamic = 'force-dynamic'`) calling read models. A single `createCore()` instance per server process is cached in a module-level singleton.
- Mutations are Server Actions in `app/actions/*` that parse `FormData` with zod, call a service, `revalidatePath` the affected routes and return `{ ok: true } | { ok: false; error: AppError }`. Forms use `useActionState` to render the red error boxes while keeping entered values.
- `<AutoRefresh intervalMs={3000}/>` in the layout calls `router.refresh()` while `document.visibilityState === 'visible'` and pauses while a form field is focused, a dialog is open, or the page renders `<NoAutoRefresh/>` (Run detail of a finished Run, whose files can't change). Elapsed timers tick client-side from `started_at`.
- Kind detection on the Watch form calls a `previewTarget` Server Action (debounced 500 ms).
- "Open" / "reveal" links for result files and transcripts go to a route handler `/files/run/[id]/[name]` and `/files/attempt/[name]` that only serves files inside `<dataDir>`, by whitelisted name.
- Confirmation dialogs, disabled-with-tooltip actions and empty states as in the UI spec.

## CLI

```
automator watch add <target> --repo <name> [--interval 30m] [--model m] [--instructions text|@file] [--initial-review baseline-only|unresolved]
automator watch list [--state s] [--repo name]
automator watch rm <id>
automator run --repo <name> --prompt <text|@file> [--model m]
automator run-now <watchId> [--instructions text] [--review-unresolved]
```

Prints a one-line result (`Watch #12 created`, `Run #43 queued`) or the error. Exit codes: 0 success, 1 domain error (including `UNKNOWN_REPOSITORY`, with the attempt file path or the write failure printed), 2 usage error. The CLI only enqueues; it doesn't wait for Runs.

## Scripts

| Script | Command |
| --- | --- |
| `dev` | `node scripts/start.mjs dev`: `next dev -H 127.0.0.1 -p ${PORT:-3000}` + `node --watch --import tsx src/worker/main.ts` |
| `build` | `next build` |
| `start` | `node scripts/start.mjs`: `next start -H 127.0.0.1 -p ${PORT:-4317}` + `node --import tsx src/worker/main.ts` |
| `automator` | `tsx src/cli/main.ts` (also `bin`) |
| `test` | `vitest run` |
| `e2e` | `playwright test` |
| `check` | `tsc --noEmit && eslint . && depcruise src app && vitest run` |

## Testing

- **Unit (Vitest)**, each against a fresh temp-file SQLite DB and a fake `Clock`:
  - target parsing/normalization
  - Watch state machine (every cell of the table)
  - duplicate rule, including reopen and the index backstop
  - queue merge, ordering and `claimNext` (closed/needs-you/paused drops, single running)
  - working hours and `nextWindowStart`
  - scheduler outcomes, including the 3-failure rule
  - the OutcomeApplier matrix (state × result, closed wins, paused → needs_you, cursor advance)
  - cleanup selection
  - attempt-file writing, including write failure
- **Pre-check adapters**: `msw` handlers with recorded-shape fixtures for GitLab (notes by me/others, system notes, failed pipeline, conflict, merged, 401) and Jira (changelog/comments, done by ID, done by category, empty list, invalid token).
- **RunExecutor integration**: `test/fixtures/fake-copilot.mjs` set as `copilotBin`. Behavior is selected by the `FAKE_COPILOT_MODE` env var: `acted`, `nothing`, `needs-you`, `invalid-json`, `no-result`, `exit-1`, `hang`. It writes a transcript to the `--share` path and records its argv/cwd/env for assertions (secrets stripped, one `--deny-tool` per `runs.denyTools` entry). Covers success, timeout (short timeout in test config), cancel, restart recovery and preflight failures.
- **CLI**: run `main()` in-process with a temp config; assert exit codes and output.
- **Playwright smoke**: build the app, seed a temp DB via core services, worker not running. Cover: Home Needs you card and Resume; Watches list ordering and Jira notice; Watch form unknown-Repository and duplicate errors; Run detail tabs.
- `npm run check` must pass before any merge.

## Out of scope (v1)

As in the README and UI spec, plus: worker health display, multiple worker instances, hot config reload, Windows support (process groups and paths assume macOS/Linux).
