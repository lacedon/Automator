# Automator v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Automator v1: a localhost tool that stores Watches in SQLite, checks GitLab MRs / Jira tickets / free-form items on a schedule, runs Copilot CLI in configured Repository folders through one serialized queue, and shows everything in a Next.js dashboard and a CLI.

**Architecture:** One npm package. `src/core` holds all domain logic, persistence and adapters behind injected interfaces, assembled by `createCore(config, deps)`. Three entry points use it: the Next.js App Router dashboard (`app/`), the long-running worker (`src/worker`) and the CLI (`src/cli`). They coordinate only through SQLite rows.

**Tech Stack:** Node 24, TypeScript (strict, ESM), Next.js App Router, React, better-sqlite3, zod, commander, dotenv, tsx, concurrently; Vitest, msw, Playwright, ESLint, dependency-cruiser.

**Spec:** [docs/superpowers/specs/2026-10-21-architecture-design.md](../specs/2026-10-21-architecture-design.md). Also read [README.md](../../../README.md), [GLOSSARY.md](../../../GLOSSARY.md), [ADR 0001](../../adr/0001-serialize-runs-in-configured-repository-folders.md) and, for UI tasks, [the dashboard UI design](../specs/2026-10-21-dashboard-ui-design.md) with its mockups in `docs/superpowers/specs/assets/`.

## Global Constraints

- `package.json`: `"type": "module"`; TypeScript `strict: true`; path alias `@core/*` → `src/core/*`.
- `src/core` never imports `next`, `react`, `src/worker` or `src/cli`; `app/`, `src/worker`, `src/cli` import core only via `@core/index` (enforced by dependency-cruiser).
- Times are INTEGER epoch milliseconds in SQLite; IDs are INTEGER autoincrement; Run display number `#n` = `runs.id`.
- SQLite pragmas: `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`.
- Defaults: intervals `15m` (MR) / `2h` (others); working hours Mon–Fri `08:00`–`19:00` local; Run timeout `30` minutes; cleanup weekly (`everyDays: 7`), `retainClosedDays: 30`; `initialReview: "baseline-only"`; `jira.enabled: false`; data dir `~/.automator`.
- Dashboard binds to `127.0.0.1`. No auth.
- Secrets only from env / `.env`; never in prompts, result files, logs or the child Copilot env.
- All worker-written JSON is atomic (tmp + fsync + rename). `result.json` has `schemaVersion: 1`.
- Copilot Runs are never retried automatically. Read-only HTTP: 3 attempts, backoff 1 s → 4 s, cap 10 s; retry on network errors, 429, 5xx; 401/403/404 not retried.
- Process-group kill: SIGTERM, then SIGKILL after 10 s.
- Scheduler tick every 30 s; worker loop every 1 s; dashboard refresh every 3 s; preview debounce 500 ms; worker lock stale after 15 s; Needs you after 3 consecutive failed pre-checks.
- Every task ends with `npm run check` green (from Task 1 on) and a commit.
- Git remote: `origin` = `https://github.com/lacedon/Automator.git`, branch `master` (already has the GitHub "Initial commit" with `LICENSE`; build on it, never force-push).
- Commit messages end with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## Review Focus

1. **Copilot binary missing or not executable** (`copilotBin` wrong, `copilot` not on PATH for the worker): a reasonable person expects the Run to finish as `error` with code `SPAWN_FAILED` and the Watch in Needs you, not a crashed worker. → Task 15 test `spawn failure becomes SPAWN_FAILED error result`.
2. **Very large prompts** (MR with hundreds of notes): passing the prompt via argv can exceed OS limits. Expected: the events section is capped at 100 000 characters with a "(N older events omitted)" line, newest kept. → Task 12 test `caps events section at 100000 chars keeping newest`.
3. **Copilot result slightly off-contract** (summary longer than 500 chars, extra keys): expected to be accepted, with the summary truncated to 500 chars and extra keys ignored; only a missing or invalid `outcome` is `RESULT_INVALID`. → Task 15 test `accepts long summary by truncating and ignores extra keys`.
4. **Dashboard/CLI and worker writing at the same time**: expected no `SQLITE_BUSY` failures and no double claim. → Task 7 test `two connections claiming concurrently yield one running row`.
5. **Repository folder paths with `~` or spaces, and nested GitLab groups**: expected to resolve and spawn correctly, and to build `/projects/<url-encoded path>` API URLs. → Task 2 test `expands ~ and keeps spaces in repository folder`; Task 4 test `parses nested group MR URL and encodes project path`.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, playwright.config.ts, eslint.config.js,
.dependency-cruiser.cjs, next.config.ts, .gitignore, .env.example, automator.config.example.json
prompts/mr.md, prompts/jira.md, prompts/free.md
src/core/
  index.ts                     createCore + public exports
  domain/types.ts              Watch, Run, cursors, enums, view-independent row types
  domain/result.ts             Result, ok, err, AppError
  domain/duration.ts           parseDuration, formatDuration
  domain/targets.ts            parseTarget
  domain/watchState.ts         transition table
  domain/schedule.ts           isWithinWorkingHours, nextWindowStart, intervalFor
  config/schema.ts             zod schema + Config type
  config/load.ts               loadConfig, resolveSecrets
  db/open.ts                   openDb
  db/migrate.ts                migrate
  db/migrations/001_init.sql
  db/rows.ts                   row ↔ domain mappers
  files/dataDir.ts             DataDir paths
  files/atomic.ts              writeJsonAtomic
  files/attempts.ts            writeAttemptError
  queue/queueService.ts
  watches/watchService.ts
  http/fetchWithRetry.ts
  prechecks/types.ts, gitlab.ts, gitlabClient.ts, jira.ts, jiraClient.ts, freeform.ts, index.ts
  scheduler/scheduler.ts
  runs/promptBuilder.ts, copilotLauncher.ts, outcomeApplier.ts, runExecutor.ts, recovery.ts
  notify/teamsNotifier.ts
  cleanup/cleanupService.ts
  worker/lock.ts               (core part of the lock; used by src/worker)
  read-models/*.ts
src/worker/main.ts, src/worker/loop.ts
src/cli/main.ts
app/  (layout, pages, actions, components, files route)
test/helpers/*.ts, test/fixtures/fake-copilot.mjs, test/fixtures/msw/*.ts, test/e2e/*.spec.ts
```

Tests live next to code as `*.test.ts` except shared helpers, fixtures and e2e under `test/`.

---

### Task 1: Project scaffold, Result and durations

**Files:**
- Create: `package.json` (replace placeholder), `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.dependency-cruiser.cjs`, `.env.example`
- Modify: `.gitignore` (current content `.superpowers`, `.claude` stays)
- Create: `src/core/domain/result.ts`, `src/core/domain/duration.ts`, `src/core/domain/duration.test.ts`

**Interfaces:**
- Produces:
  - `type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E }`; `ok<T>(value: T)`, `err<E>(error: E)`.
  - `type AppError` exactly as the spec's "Core services" union, plus `{ code: 'JIRA_DISABLED' }` and `{ code: 'NOT_FOUND' }` (already in the spec).
  - `parseDuration(s: string): number` (ms; accepts `<int>(s|m|h|d)`, throws `Error('Invalid duration: <s>')` otherwise); `formatDuration(ms: number): string` (largest whole unit, e.g. `15m`, `2h`, `90s`).

- [ ] **Step 1: Initialize git on top of the existing GitHub repository**

The remote `https://github.com/lacedon/Automator` already has one commit on `master` ("Initial commit", containing only `LICENSE`). Adopt that history without touching the local files:

```bash
git init -b master
git remote add origin https://github.com/lacedon/Automator.git
git fetch origin master
git reset origin/master          # mixed reset: adopts remote history, keeps local files untracked
git checkout -- LICENSE          # materialize the remote LICENSE locally
git status --short               # expect only local docs/config as untracked; LICENSE clean
```

Commit the existing design docs and agent config before any code: `git add README.md GLOSSARY.md docs .agents skills-lock.json .gitignore && git commit -m "docs: add design, ADR and plan"`, then `git push -u origin master`. Expected: push succeeds as a fast-forward of `83b121e`.

Then write `package.json` with name `automator`, `"license": "MIT"` (matches `LICENSE`), `"repository": "github:lacedon/Automator"`, `"type": "module"`, `"private": true`, `"bin": { "automator": "./bin/automator.mjs" }` (Task 19 creates the bin), and the scripts from the spec's Scripts table, with `start` using `next start -H 127.0.0.1 -p 4317`. Install: `npm i next react react-dom better-sqlite3 zod commander dotenv tsx concurrently` and `npm i -D typescript @types/node @types/react @types/react-dom @types/better-sqlite3 vitest msw @playwright/test eslint typescript-eslint @eslint/js eslint-config-next dependency-cruiser`.
`.gitignore` adds: `node_modules`, `.next`, `automator.config.json`, `.env`, `test-results`, `playwright-report`, `coverage`.
`.env.example`: `GITLAB_TOKEN=`, `JIRA_EMAIL=`, `JIRA_TOKEN=`.

- [ ] **Step 2: Configure tooling**

`tsconfig.json`: `strict`, `module`/`moduleResolution` `bundler`, `target` `ES2023`, `jsx` `preserve`, `paths: { "@core/*": ["./src/core/*"] }`, Next plugin. `vitest.config.ts`: `include: ['src/**/*.test.ts', 'test/**/*.test.ts']`, alias `@core`. `.dependency-cruiser.cjs`: start from `.agents/skills/setup-ts-deep-modules/dependency-cruiser.config.cjs` and add rules `core-is-independent` (from `^src/core` to `^(app|src/worker|src/cli)|node_modules/(next|react)`) and `entrypoints-use-core-index` (from `^(app|src/worker|src/cli)` to `^src/core/(?!index\.ts$)`, excluding type-only imports).

- [ ] **Step 3: Write the failing test** `src/core/domain/duration.test.ts`

```ts
test('parses units', () => {
  expect(parseDuration('90s')).toBe(90_000);
  expect(parseDuration('15m')).toBe(900_000);
  expect(parseDuration('2h')).toBe(7_200_000);
  expect(parseDuration('1d')).toBe(86_400_000);
});
test('rejects bad input', () => { expect(() => parseDuration('15')).toThrow('Invalid duration: 15'); expect(() => parseDuration('-1m')).toThrow(); });
test('formats largest whole unit', () => { expect(formatDuration(900_000)).toBe('15m'); expect(formatDuration(7_200_000)).toBe('2h'); expect(formatDuration(90_000)).toBe('90s'); });
```

- [ ] **Step 4: Run** `npx vitest run src/core/domain/duration.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 5: Implement** `result.ts` and `duration.ts`.
- [ ] **Step 6: Run** `npm run check` (tsc, eslint, depcruise on `src`, vitest) — Expected: PASS. Until Task 21 adds `app/`, the `check` script's depcruise target is `src`; Task 21 changes it to `src app`.
- [ ] **Step 7: Commit** `chore: scaffold project with Result and duration helpers`

---

### Task 2: Config schema and loader

**Files:**
- Create: `src/core/config/schema.ts`, `src/core/config/load.ts`, `src/core/config/load.test.ts`, `automator.config.example.json`

**Interfaces:**
- Consumes: `parseDuration` (Task 1).
- Produces:
  - `type Config` (zod-inferred, after normalization) with: `dataDir: string` (absolute), `copilotBin: string`, `repositories: Record<string, { folder: string; gitlab: string; jira?: string; validate: string[] }>`, `gitlab: Record<string, { host: string; tokenEnv: string }>`, `jira: { enabled: boolean; connections: Record<string, { baseUrl: string; emailEnv?: string; tokenEnv?: string; doneStatusIds?: string[] }> }`, `schedule: { intervals: { mr: number; default: number }; workingHours: { days: number[]; start: string; end: string } }` (intervals in ms), `runs: { timeoutMs: number; defaultModel: string; models: string[]; initialReview: 'baseline-only' | 'unresolved'; denyTools: string[] }`, `prompts: { dir: string }`, `cleanup: { enabled: boolean; everyDays: number; retainClosedDays: number }`, `teams?: { chatId: string }`, `configDir: string`.
  - `loadConfig(opts?: { path?: string; env?: NodeJS.ProcessEnv }): Config` — reads `opts.path ?? env.AUTOMATOR_CONFIG ?? <cwd>/automator.config.json`, throws `ConfigError` (message lists every zod issue as `path: message`).
  - `type Secrets = { gitlab: Record<string, string | undefined>; jira: Record<string, { email?: string; token?: string }>; envNames: string[] }`; `resolveSecrets(config: Config, env: NodeJS.ProcessEnv): Secrets` (`envNames` = every configured `tokenEnv`/`emailEnv`).
  - `loadDotenv(configDir: string): void` — loads `<configDir>/.env` if present, without overriding existing env.

- [ ] **Step 1: Write failing tests** in `load.test.ts` (write temp config files with `fs.mkdtempSync`):
  - `applies defaults` — minimal config `{ repositories: {}, gitlab: {} }` gives `schedule.intervals.mr === 900_000`, `default === 7_200_000`, `workingHours` `{days:[1,2,3,4,5], start:'08:00', end:'19:00'}`, `runs.timeoutMs === 1_800_000`, `runs.initialReview === 'baseline-only'`, `runs.denyTools` `[]`, `jira.enabled === false`, `cleanup` `{enabled:true, everyDays:7, retainClosedDays:30}`, `dataDir === path.join(os.homedir(), '.automator')`, `copilotBin === 'copilot'`, `prompts.dir === <configDir>/prompts`.
  - `expands ~ and keeps spaces in repository folder` — `folder: '~/My Work/pages'` → `path.join(os.homedir(), 'My Work/pages')`; relative `./x` resolves against the config file's folder.
  - `rejects unknown connection reference` — repository `gitlab: 'nope'` throws `ConfigError` whose message contains `repositories.pages.gitlab`.
  - `reports all issues at once` — two invalid fields → both paths in the message.
  - `missing folder is not a load error` — nonexistent folder loads fine.
  - `doneStatusIds distinguishes absent from empty` — absent → `undefined`, `[]` → `[]`.
  - `resolveSecrets reads env names` — `GITLAB_TOKEN=abc` → `secrets.gitlab.corp === 'abc'`; `envNames` contains `GITLAB_TOKEN`, `JIRA_TOKEN`, `JIRA_EMAIL`.
  - `AUTOMATOR_CONFIG overrides default path`.
- [ ] **Step 2: Run** `npx vitest run src/core/config` — Expected: FAIL.
- [ ] **Step 3: Implement** `schema.ts` (zod with `.default()`s, interval/timeout strings converted via `parseDuration`; `runs.timeoutMinutes` input → `timeoutMs`; `superRefine` for connection references and `teams.chatId` non-empty) and `load.ts`. Write `automator.config.example.json` with the same content as the spec's example, minus the comments and with no secrets.
- [ ] **Step 4: Add test** `example config is valid` — `loadConfig({ path: 'automator.config.example.json' })` does not throw.
- [ ] **Step 5: Run** `npm run check` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(core): config schema, loader and secrets`

---

### Task 3: Database, schema migration, row types

**Files:**
- Create: `src/core/domain/types.ts`, `src/core/db/open.ts`, `src/core/db/migrate.ts`, `src/core/db/migrations/001_init.sql`, `src/core/db/rows.ts`, `src/core/db/db.test.ts`, `test/helpers/db.ts`, `test/helpers/clock.ts`

**Interfaces:**
- Produces:
  - `type WatchKind = 'mr' | 'jira' | 'free'`; `type WatchState = 'active' | 'paused' | 'needs_you' | 'closed'`; `type RunStatus = 'queued' | 'running' | 'finished'`; `type Trigger = 'schedule' | 'manual' | 'adhoc'`; `type Outcome = 'nothing' | 'acted' | 'needs-you'`; `type Interrupted = 'timeout' | 'cancelled' | 'worker-restart'`; `type ClosedReason = 'merged' | 'mr-closed' | 'jira-done' | 'user'`; `type InitialReview = 'baseline-only' | 'unresolved'`.
  - `type MrCursor = { lastNoteId: number; handledPipelineId: number | null; handledConflictSha: string | null }`; `type JiraCursor = { lastChangelogId: string | null; lastCommentId: string | null }`; `type Cursor = MrCursor | JiraCursor | Record<string, never>`.
  - `interface Watch` — camelCase of every `watches` column in the spec (`cursor: Cursor | null` parsed from `cursor_json`).
  - `interface Run` — camelCase of every `runs` column (`error: RunError | null` from `error_json`, `cursorCandidate: Cursor | null`, `reviewUnresolved: boolean`); `type RunError = { code: string; message: string; detail?: unknown }`.
  - `interface NeedsYouEvent { id; watchId; runId: number | null; reason; createdAt; teamsStatus: 'pending' | 'sent' | 'failed' | 'disabled'; teamsError: string | null }`.
  - `interface Clock { now(): number }`; `systemClock: Clock`.
  - `openDb(file: string): Database` (creates parent dir, sets pragmas); `migrate(db: Database): void` (applies `migrations/NNN_*.sql` with number > `user_version`, in one `BEGIN IMMEDIATE`, sets `user_version`).
  - `rows.ts`: `toWatch(row): Watch`, `toRun(row): Run`, `toNeedsYouEvent(row)`.
  - Test helpers: `tempDb(): { db: Database; file: string; cleanup(): void }` (migrated), `fakeClock(start = Date.parse('2026-10-21T10:00:00')): Clock & { set(t: number): void; advance(ms: number): void }`.

- [ ] **Step 1: Write failing tests** `db.test.ts`:
  - `migrate is idempotent and sets user_version 1`.
  - `pragmas applied` — `journal_mode` is `wal`, `foreign_keys` is 1, `busy_timeout` is 5000.
  - `rejects second non-closed watch for same target and repository` — insert two `active` rows with equal `(normalized_target, repository)` → second throws `SQLITE_CONSTRAINT_UNIQUE`; one `closed` + one `active` is allowed.
  - `allows only one queued run per watch` and `allows only one running run`.
  - `deleting a watch cascades runs and needs_you_events`.
- [ ] **Step 2: Run** `npx vitest run src/core/db` — Expected: FAIL.
- [ ] **Step 3: Write `001_init.sql`** with tables `watches`, `runs`, `needs_you_events`, `meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`, `worker_lock(id INTEGER PRIMARY KEY CHECK (id = 1), pid, started_at, heartbeat_at)` and the indexes `ux_watch_target`, `ux_run_queued_per_watch`, `ux_run_running`, `ix_run_queue` exactly as in the spec; `CHECK` constraints on every enum column. Implement `open.ts`, `migrate.ts` (read SQL files via `new URL('./migrations/', import.meta.url)`), `rows.ts`, helpers.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): sqlite schema, migrations and row types`

---

### Task 4: Target parsing

**Files:**
- Create: `src/core/domain/targets.ts`, `src/core/domain/targets.test.ts`

**Interfaces:**
- Consumes: `Config`, `Result`, `AppError`.
- Produces:
  - `type ParsedTarget = { kind: WatchKind; normalizedTarget: string; displayUrl: string; gitlab?: { conn: string; host: string; projectPath: string; iid: number; apiProjectId: string }; jira?: { conn: string; host: string; key: string } }` (`apiProjectId = encodeURIComponent(projectPath)`).
  - `parseTarget(input: string, config: Config, repository?: string): Result<ParsedTarget>` — bare Jira keys need `repository` with a `jira` connection, else `INVALID_TARGET` with message `Jira key needs a Repository with a Jira connection`.

- [ ] **Step 1: Write failing tests** (config fixture with gitlab `corp` host `https://gitlab.example.com`, jira `corp` baseUrl `https://jira.example.com`, repository `pages` using both):
  - `normalizes MR URL` — `https://GitLab.example.com/team/app/-/merge_requests/42/diffs?x=1#n` → kind `mr`, normalizedTarget `gitlab:gitlab.example.com/team/app!42`, displayUrl `https://gitlab.example.com/team/app/-/merge_requests/42`.
  - `parses nested group MR URL and encodes project path` — `.../a/b/c/-/merge_requests/7` → `projectPath 'a/b/c'`, `apiProjectId 'a%2Fb%2Fc'`, `iid 7`.
  - `parses Jira browse URL and bare key` — `https://jira.example.com/browse/abc-12` and `abc-12` (with repo `pages`) both → `jira:jira.example.com/ABC-12`.
  - `bare key without jira repository is INVALID_TARGET`.
  - `unknown host URL is free-form` — `https://Example.org/Path/#frag` → kind `free`, normalized `https://example.org/Path`.
  - `MR URL on unconfigured GitLab host is free-form`.
  - `rejects non-http input` — `ftp://x`, `hello` → `INVALID_TARGET`.
- [ ] **Step 2: Run** `npx vitest run src/core/domain/targets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** with `new URL()`; MR path regex `^/(.+?)/-/merge_requests/(\d+)(?:/.*)?$`; Jira key regex `^[A-Za-z][A-Za-z0-9_]+-\d+$`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): parse and normalize watch targets`

---

### Task 5: Watch state machine and schedule math

**Files:**
- Create: `src/core/domain/watchState.ts`, `src/core/domain/watchState.test.ts`, `src/core/domain/schedule.ts`, `src/core/domain/schedule.test.ts`

**Interfaces:**
- Produces:
  - `type WatchAction = 'pause' | 'resume' | 'resumeRunNow' | 'close' | 'reopen' | 'runNow' | 'delete'`.
  - `nextState(state: WatchState, action: WatchAction): WatchState | null` — `null` = invalid; `runNow` returns the unchanged state when valid; `delete` returns the unchanged state when valid (the running-Run check lives in WatchService).
  - `allowedActions(state: WatchState): WatchAction[]`.
  - `isWithinWorkingHours(t: number, wh: Config['schedule']['workingHours']): boolean` (local time; `start` inclusive, `end` exclusive; `days` uses `Date#getDay()` 0=Sun).
  - `nextWindowStart(t: number, wh): number`.
  - `intervalFor(watch: Pick<Watch, 'kind' | 'intervalMs'>, config: Config): number`.

- [ ] **Step 1: Write failing tests**
  - `watchState.test.ts`: `it.each` over all 28 cells of the spec's state-machine table (including the new rule that `runNow` is allowed on `paused` and returns `paused`; `pause` from `needs_you` → `paused`; `reopen` only from `closed` → `active`; `resumeRunNow` only from `needs_you` → `active`; `runNow` on `needs_you` and `closed` → `null`; `delete` valid from all states).
  - `schedule.test.ts`: `Wed 07:59 outside, 08:00 inside, 18:59 inside, 19:00 outside`; `Sat 10:00 outside`; `nextWindowStart(Fri 19:30) is Mon 08:00`; `nextWindowStart(Tue 06:00) is Tue 08:00`; `intervalFor uses override, then kind default (mr 15m, jira/free 2h)`. Build times with `new Date(2026, 9, 21, h, m).getTime()` (Wed 2026-10-21).
- [ ] **Step 2: Run** `npx vitest run src/core/domain` — Expected: FAIL.
- [ ] **Step 3: Implement** as a lookup table for `nextState`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): watch state machine and working-hours math`

---

### Task 6: Data directory, atomic writes, attempt files

**Files:**
- Create: `src/core/files/dataDir.ts`, `src/core/files/atomic.ts`, `src/core/files/attempts.ts`, `src/core/files/files.test.ts`

**Interfaces:**
- Produces:
  - `class DataDir { constructor(root: string); db: string; runDir(id: number): string; promptPath(id); transcriptPath(id); copilotResultPath(id); resultPath(id); cliLogPath(id); attemptsDir: string; ensureRunDir(id: number): string; removeRunDir(id: number): void; isInside(p: string): boolean }` — file names exactly `prompt.md`, `transcript.md`, `copilot-result.json`, `result.json`, `cli.log`.
  - `writeJsonAtomic(file: string, value: unknown): void` and `writeTextAtomic(file: string, text: string): void`.
  - `writeAttemptError(dir: DataDir, error: { code: string; [k: string]: unknown }, now: number): { path: string | null; writeError?: string }` — file `attempts/<ISO with ':' replaced by '-'>-<uuid>.json` containing `{ schemaVersion: 1, attemptId, at, status: 'error', error }`.

- [ ] **Step 1: Write failing tests**: `writes json atomically and leaves no tmp file`; `attempt file contains schemaVersion 1 and error`; `attempt write failure returns null path and message` (make `attemptsDir` a regular file so `mkdir` fails); `isInside rejects ../ traversal`.
- [ ] **Step 2: Run** `npx vitest run src/core/files` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): data dir layout and atomic file writes`

---

### Task 7: QueueService

**Files:**
- Create: `src/core/queue/queueService.ts`, `src/core/queue/queueService.test.ts`

**Interfaces:**
- Consumes: `Database`, `Clock`, `Run`, `toRun`, `DataDir`.
- Produces `class QueueService`:
  - `constructor(db: Database, clock: Clock, dataDir: DataDir)`
  - `enqueueWatch(input: { watchId: number; repository: string; trigger: 'schedule' | 'manual'; reason: string; model: string; extraInstructions?: string; reviewUnresolved?: boolean }): Run` (insert or merge)
  - `enqueueAdhoc(input: { repository: string; prompt: string; model: string }): Run`
  - `claimNext(): Run | null`
  - `cancel(runId: number): Result<'deleted' | 'cancel-requested'>`
  - `deleteAdhoc(runId: number): Result<void>`
  - `removeQueuedForWatch(watchId: number): void` (used inside other services' transactions)
  - `position(runId: number): number | null` (1-based among queued)

- [ ] **Step 1: Write failing tests** (temp DB, fake clock, seed watches directly via SQL helper `insertWatch(db, partial)` added to `test/helpers/db.ts`):
  - `orders manual and adhoc before scheduled, then FIFO`.
  - `merges second trigger into existing queued row` — scheduled then manual with extra `"A"` then manual with `"A"` and `"B"` → one row, priority 0, trigger `manual`, `extraInstructions === 'A\n\nB'`, `reviewUnresolved` OR-ed, `reason` `"r1; r2; r3"`, `queuedAt` unchanged.
  - `claimNext returns null while a run is running`.
  - `claimNext drops rows for closed or needs_you watches and scheduled rows for paused watches`; `manual row for paused watch is claimed`.
  - `two connections claiming concurrently yield one running row` — open a second `openDb` on the same file, call `claimNext` from both in sequence inside overlapping `BEGIN IMMEDIATE` attempts (the second waits on `busy_timeout`); assert exactly one `running` row.
  - `cancel deletes queued, flags running, rejects finished with INVALID_STATE`.
  - `deleteAdhoc removes finished adhoc row and its run dir; rejects watch runs and unfinished`.
- [ ] **Step 2: Run** `npx vitest run src/core/queue` — Expected: FAIL.
- [ ] **Step 3: Implement**; `claimNext` uses `db.transaction(...).immediate()`; merging uses `INSERT ... ON CONFLICT (watch_id) WHERE status = 'queued' DO UPDATE`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): serialized queue with merging and safe claiming`

---

### Task 8: WatchService

**Files:**
- Create: `src/core/watches/watchService.ts`, `src/core/watches/watchService.test.ts`, `test/helpers/config.ts`

**Interfaces:**
- Consumes: `parseTarget`, `nextState`, `intervalFor`, `QueueService`, `writeAttemptError`, `DataDir`, `Config`, `Clock`.
- Produces `class WatchService`:
  - `constructor(deps: { db: Database; clock: Clock; config: Config; queue: QueueService; dataDir: DataDir; preview?: (t: ParsedTarget, repository: string) => Promise<TargetPreview | null> })`
  - `create(input: { target: string; repository: string; instructions?: string; intervalMs?: number; model?: string; initialReview?: InitialReview; title?: string }): Result<Watch>`
  - `update(id: number, input: { instructions?: string | null; intervalMs?: number | null; model?: string | null; initialReview?: InitialReview | null }): Result<Watch>`
  - `pause(id)`, `close(id)`, `reopen(id)`, `delete(id)`: `Result<Watch | void>`
  - `resume(id: number, opts: { note?: string; runNow?: boolean }): Result<Watch>`
  - `runNow(id: number, opts: { extraInstructions?: string; reviewUnresolved?: boolean }): Result<Run>`
  - `previewTarget(target: string, repository: string): Promise<{ kind: WatchKind | null; preview: TargetPreview | null; previewError?: string; error?: AppError }>`; `type TargetPreview = { title: string; state: 'opened' | 'merged' | 'closed' | string; sourceBranch?: string }`
  - `get(id: number): Watch | null`
  - `test/helpers/config.ts`: `testConfig(overrides?: DeepPartial<Config>): Config` (repositories `pages` and `api` pointing at temp dirs, gitlab `corp`, jira `corp`).

- [ ] **Step 1: Write failing tests**:
  - `create unknown repository writes attempt file and saves nothing` — error `UNKNOWN_REPOSITORY` with `known: ['api','pages']`, `attemptFile` exists; `watches` table empty.
  - `create unknown repository reports attempt write failure` — `attemptFile === null`, `attemptFileError` set.
  - `free-form requires instructions` → `MISSING_INSTRUCTIONS`.
  - `duplicate returns existing watch` → `DUPLICATE_WATCH` with existing `id`, `state`, `intervalMs`.
  - `create sets active, next_check_at now, title default target`.
  - `reopen into duplicate is DUPLICATE_WATCH`; `reopen keeps cursor`.
  - `pause and close clear next_check_at; close removes queued row and sets closed_reason user and closed_at`.
  - `resume clears needs_you fields, stores note, sets next_check_at now; runNow variant enqueues manual run with reason 'Resume & run now'`.
  - `runNow on paused enqueues and keeps paused`; `runNow on needs_you is INVALID_STATE`; `runNow on jira watch with jira disabled is JIRA_DISABLED`.
  - `delete while running is RUN_IN_PROGRESS`; `delete removes watch and its run dirs`.
  - `update cannot change target or repository` (input type has no such fields; test that `update` changes `intervalMs` and clearing with `null` restores default).
  - `previewTarget returns kind only with reason when preview fails`.
- [ ] **Step 2: Run** `npx vitest run src/core/watches` — Expected: FAIL.
- [ ] **Step 3: Implement**; catch `SQLITE_CONSTRAINT_UNIQUE` on insert/reopen and map it to `DUPLICATE_WATCH` (index backstop).
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): watch service with validation and state actions`

---

### Task 9: HTTP retry and GitLab pre-check

**Files:**
- Create: `src/core/http/fetchWithRetry.ts`, `src/core/http/fetchWithRetry.test.ts`, `src/core/prechecks/types.ts`, `src/core/prechecks/gitlabClient.ts`, `src/core/prechecks/gitlab.ts`, `src/core/prechecks/gitlab.test.ts`, `test/fixtures/msw/gitlab.ts`

**Interfaces:**
- Produces:
  - `class HttpError extends Error { status: number | null; auth: boolean }`; `fetchWithRetry(url: string, init: RequestInit, opts?: { attempts?: 3; sleep?: (ms: number) => Promise<void> }): Promise<Response>` — backoff 1000, 4000 ms (capped 10 000); throws `HttpError` (`auth` true for 401/403/404).
  - `types.ts`: `PrecheckResult` and `Snapshot` exactly as in the spec; `type EventSummary = { at: number; author: string; text: string; url?: string }`; `interface Precheck { check(w: Watch): Promise<PrecheckResult>; snapshot(w: Watch, opts: { reviewUnresolved: boolean }): Promise<Snapshot> }`.
  - `interface GitLabClient { me(): Promise<{ id: number; username: string }>; mr(projectId: string, iid: number): Promise<GitLabMr>; discussions(projectId: string, iid: number): Promise<GitLabDiscussion[]> }` with `GitLabMr = { title; state; sha; sourceBranch; detailedMergeStatus; headPipeline: { id: number; status: string; sha: string } | null; webUrl }`, `GitLabDiscussion = { id: string; resolvable: boolean; resolved: boolean; notes: { id: number; system: boolean; authorId: number; authorUsername: string; body: string; createdAt: string }[] }`.
  - `createGitLabClient(host: string, token: string | undefined, fetchImpl = fetchWithRetry): GitLabClient` (missing token → every call throws `HttpError` with `auth: true`, message `GitLab token missing`). Paginates discussions via `x-next-page`, `per_page=100`.
  - `class GitLabPrecheck implements Precheck { constructor(deps: { clientFor(conn: string): GitLabClient; config: Config; meCache: { get(conn): Promise<{id:number;username:string}> } }) }` — the cache is backed by `meta.gitlab_me:<conn>` (wired in Task 18; tests pass an in-memory cache).

- [ ] **Step 1: Write failing tests**:
  - `fetchWithRetry`: `retries 503 twice then succeeds with sleeps 1000 and 4000`; `does not retry 401 and marks auth`; `retries network error`; `gives up after 3 attempts`.
  - `gitlab.test.ts` with msw handlers in `test/fixtures/msw/gitlab.ts` (me = id 1 `me`):
    - `first check baseline-only records max note id and is unchanged`.
    - `first check unresolved with unresolved discussion by other is changed`.
    - `new note by other after cursor is changed with reason 'new comment by @anna'`.
    - `own notes and system notes are ignored`.
    - `failed pipeline on head sha not yet handled is changed 'pipeline #55210 failed'`; `already handled pipeline is unchanged`.
    - `conflict on new sha is changed 'merge conflict'`; `same sha already handled is unchanged`.
    - `merged MR returns close merged; closed returns close mr-closed`.
    - `401 returns failed auth true`; `500 x3 returns failed auth false`.
    - `snapshot returns events since cursor, cursorCandidate with max note id, head pipeline id when failed, sha when conflicted, title and sourceBranch`.
    - `snapshot with reviewUnresolved includes unresolved discussions regardless of cursor`.
- [ ] **Step 2: Run** `npx vitest run src/core/http src/core/prechecks/gitlab.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Conflict detection: only `detailedMergeStatus === 'conflict'` counts (`need_rebase` does not). `cursorCandidate.handledPipelineId` = failed pipeline id if failed on head sha, else previous value; `handledConflictSha` = sha if conflicted, else previous value.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): gitlab pre-check with retrying http`

---

### Task 10: Jira and free-form pre-checks

**Files:**
- Create: `src/core/prechecks/jiraClient.ts`, `src/core/prechecks/jira.ts`, `src/core/prechecks/jira.test.ts`, `src/core/prechecks/freeform.ts`, `src/core/prechecks/index.ts`, `test/fixtures/msw/jira.ts`

**Interfaces:**
- Consumes: `fetchWithRetry`, `Precheck`, `Secrets`.
- Produces:
  - `interface JiraClient { myself(): Promise<{ accountId: string }>; issue(key: string): Promise<JiraIssue>; statuses(): Promise<{ id: string; name: string }[]> }`; `JiraIssue = { key; summary; status: { id: string; name: string; categoryKey: string }; comments: { id: string; authorId: string; authorName: string; body: string; created: string }[]; changelog: { id: string; authorId: string; created: string; items: { field: string; toString: string | null }[] }[] }`.
  - `createJiraClient(conn: { baseUrl: string }, secret: { email?: string; token?: string }, fetchImpl = fetchWithRetry): JiraClient` — basic auth when `email` + `token`, bearer when only `token`.
  - `class JiraPrecheck implements Precheck` — `hasToken(watch): boolean` additionally exposed for the scheduler.
  - `class FreeformPrecheck implements Precheck` — `check` → `{ kind: 'changed', reason: 'interval' }`; `snapshot` → `{ events: [], cursorCandidate: {}, title: watch.title }`.
  - `index.ts`: `precheckFor(kind: WatchKind): Precheck` factory type `Prechecks = { mr: GitLabPrecheck; jira: JiraPrecheck; free: FreeformPrecheck }`.

- [ ] **Step 1: Write failing tests** (msw; myself accountId `me`):
  - `first check records cursor and is unchanged`.
  - `comment by other after cursor is changed 'new comment by Anna'`; `changelog entry by other is changed 'status changed to In Review'`; `own changes ignored`.
  - `done by configured id closes jira-done`; `done by category when ids absent`; `empty id list never closes`.
  - `invalid token returns failed auth true`.
  - `snapshot returns events since cursor and new cursorCandidate`.
  - `hasToken false when tokenEnv unset`.
  - `freeform check always changed`.
- [ ] **Step 2: Run** `npx vitest run src/core/prechecks/jira.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Cursor ids compared numerically (Jira ids are numeric strings).
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): jira and free-form pre-checks`

---

### Task 11: Scheduler tick

**Files:**
- Create: `src/core/scheduler/scheduler.ts`, `src/core/scheduler/scheduler.test.ts`, `src/core/watches/needsYou.ts`, `src/core/watches/needsYou.test.ts` (tests: `enterNeedsYou on closed watch returns null`, `enterNeedsYou sets fields and inserts pending or disabled event`, `closeWatch removes queued row`)

**Interfaces:**
- Consumes: `Prechecks`, `QueueService`, `isWithinWorkingHours`, `intervalFor`, `Config`, `Clock`, `needsYou` helper from Task 14 — **to avoid a forward dependency, this task creates** `src/core/watches/needsYou.ts` with `enterNeedsYou(db: Database, input: { watchId: number; runId: number | null; reason: string; now: number; teamsEnabled: boolean }): NeedsYouEvent | null` (returns `null` if the Watch is closed; sets state `needs_you`, reason, since, run id, `next_check_at = NULL`, inserts the event with `pending` or `disabled`), and `closeWatch(db, watchId, reason: ClosedReason, now)` (also removes queued row).
- Produces: `class Scheduler { constructor(deps: { db; clock; config; queue: QueueService; prechecks: Prechecks; onNeedsYou(e: NeedsYouEvent): void }); tick(): Promise<{ checked: number; enqueued: number }> }`.

- [ ] **Step 1: Write failing tests** (stub prechecks returning scripted results):
  - `does nothing outside working hours`.
  - `checks only due active watches without queued or running runs, oldest first`.
  - `changed enqueues scheduled run with reason and resets failures`.
  - `unchanged stores baseline cursor`.
  - `close result closes watch with reason`.
  - `auth failure moves to needs_you immediately and calls onNeedsYou`.
  - `third consecutive non-auth failure moves to needs_you; second does not`.
  - `jira watches skipped when jira disabled`; `jira without token enqueues without calling check`.
  - `free-form enqueues every interval`.
  - `sets next_check_at to now + interval after each check (missed intervals not replayed)` — set `next_check_at` 5 intervals ago; one tick → one enqueue, `next_check_at = now + interval`.
- [ ] **Step 2: Run** `npx vitest run src/core/scheduler` — Expected: FAIL.
- [ ] **Step 3: Implement** `needsYou.ts` and `scheduler.ts`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): scheduler tick with pre-check outcomes`

---

### Task 12: PromptBuilder and default prompts

**Files:**
- Create: `src/core/runs/promptBuilder.ts`, `src/core/runs/promptBuilder.test.ts`, `prompts/mr.md`, `prompts/jira.md`, `prompts/free.md`

**Interfaces:**
- Produces:
  - `buildWatchPrompt(input: { watch: Watch; run: Run; snapshot: Snapshot; recent: Pick<Run, 'id' | 'outcome' | 'summary' | 'endedAt'>[]; config: Config; resultPath: string }): string`
  - `buildAdhocPrompt(input: { run: Run; config: Config; resultPath: string }): string`
  - `FIXED_RULES: string` (exported for tests)
  - `MAX_EVENTS_CHARS = 100_000`

- [ ] **Step 1: Write failing tests**:
  - `sections appear in spec order` — headings `## Rules`, `## Default instructions`, `## Watch`, `## This Run`, `## Recent Runs`, `## Validation`, `## Result` appear in this order for an MR Watch.
  - `fixed rules list every never-allowed action` — contains `merge`, `approve`, `resolve discussions`, `force-push`, `delete remote branches`, `protected branches`, `Jira statuses`, `reassign`, `ticket descriptions`, and `untrusted`.
  - `MR prompt names the source branch in the pre-action checklist`.
  - `free-form has no default instructions section`.
  - `jira without token tells Copilot to check via MCP`.
  - `includes resolution note and last 3 run summaries only`.
  - `empty validate yields escalate-before-pushing line`.
  - `result contract contains absolute result path and outcome values`.
  - `never includes secret values` — config secrets env `GITLAB_TOKEN=s3cr3t`; prompt does not contain `s3cr3t`.
  - `caps events section at 100000 chars keeping newest` — 5 000 events of 100 chars → events section ≤ 100 000 chars, contains newest event text, contains `older events omitted`.
  - `adhoc prompt includes user prompt and result contract, no Watch section`.
- [ ] **Step 2: Run** `npx vitest run src/core/runs/promptBuilder.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; read `prompts/<kind>.md` from `config.prompts.dir`. Write the three default prompts: MR (handle new outside comments, failed pipelines, conflicts; reply in the discussion; small focused commits), Jira (read changes/comments; reply when the next step is clear; do not change code unless the Watch instructions allow it), free (one line: "Follow the Watch instructions.").
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): prompt builder and default prompts`

---

### Task 13: CopilotLauncher and fake Copilot

**Files:**
- Create: `src/core/runs/copilotLauncher.ts`, `src/core/runs/copilotLauncher.test.ts`, `test/fixtures/fake-copilot.mjs`

**Interfaces:**
- Produces:
  - `interface CopilotLauncher { start(opts: { cwd: string; prompt: string; model: string; transcriptPath: string; logPath: string; env: NodeJS.ProcessEnv; extraArgs?: string[] }): RunningProcess }`; `interface RunningProcess { pid: number; exited: Promise<{ code: number | null; signal: string | null; spawnError?: string }>; kill(signal: 'SIGTERM' | 'SIGKILL'): void }`.
  - `createCopilotLauncher(config: Config, secrets: Secrets): CopilotLauncher` — args exactly as in the spec (`-p`, `--model`, `--allow-all-tools`, `--share`, `--no-color`, `--no-ask-user`, `--log-level error`, one `--deny-tool` per `runs.denyTools`, `--secret-env-vars` joined with `,` when non-empty); env = given env minus `secrets.envNames`; `detached: true`; stdout/stderr appended to `logPath`; `kill` uses `process.kill(-pid, sig)` and ignores `ESRCH`. Spawn `error` events resolve `exited` with `code: null, spawnError`.
  - `childEnv(env: NodeJS.ProcessEnv, secrets: Secrets): NodeJS.ProcessEnv` (exported).
  - `fake-copilot.mjs`: parses `-p`, `--share`; reads mode from `FAKE_COPILOT_MODE` (`acted|nothing|needs-you|invalid-json|no-result|exit-1|hang|long-summary`); extracts the result path from the prompt line matching `/write exactly this JSON to `([^`]+)`/`; writes a transcript to the `--share` path (except `hang` before kill); writes `{ argv, cwd, env }` to `$FAKE_COPILOT_RECORD` when set.

- [ ] **Step 1: Write failing tests**:
  - `passes required args and deny tools` (mode `nothing`, record file) — argv includes `--allow-all-tools`, `--share <path>`, `--model m1`, `--deny-tool gitlab(merge_merge_request)`; `cwd` equals the repo folder with a space in its name.
  - `strips secret env vars` — record env lacks `GITLAB_TOKEN`; `--secret-env-vars GITLAB_TOKEN,JIRA_EMAIL,JIRA_TOKEN`.
  - `kill terminates whole process group` — mode `hang` (fake spawns a `sleep 60` child); after `kill('SIGTERM')` both pids are gone within 2 s.
  - `missing binary resolves exited with spawnError` — `copilotBin: '/nonexistent/copilot'`.
- [ ] **Step 2: Run** `npx vitest run src/core/runs/copilotLauncher.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): copilot launcher with process-group control`

---

### Task 14: OutcomeApplier

**Files:**
- Create: `src/core/runs/outcomeApplier.ts`, `src/core/runs/outcomeApplier.test.ts`

**Interfaces:**
- Consumes: `enterNeedsYou` (Task 11), `intervalFor`.
- Produces:
  - `type RunFinal = { runId: number; endedAt: number; exitCode: number | null; resultStatus: 'success' | 'error'; outcome: Outcome | null; summary: string | null; error: RunError | null; interrupted: Interrupted | null; branch: string | null; promptPath: string | null; transcriptPath: string | null; resultPath: string }`
  - `applyOutcome(db: Database, config: Config, final: RunFinal): { needsYou: NeedsYouEvent | null }` — one transaction, rules exactly as the spec's OutcomeApplier section.

- [ ] **Step 1: Write failing tests** — `it.each` matrix over prior state {active, paused, closed} × result {success/nothing, success/acted, success/needs-you, error}:
  - closed stays closed in all 4 cases, no event;
  - success/nothing|acted: cursor := candidate, resolution note cleared, state unchanged, `next_check_at = now + interval` only when active;
  - success/needs-you and error: cursor unchanged, state `needs_you` (from active or paused), `needs_you_run_id = runId`, reason = summary (needs-you) or `error.message` (error), event `pending` (or `disabled` without `teams`).
  - `adhoc runs never touch watches`.
  - `run row finalized with all fields`.
- [ ] **Step 2: Run** `npx vitest run src/core/runs/outcomeApplier.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): apply run outcomes to watches`

---

### Task 15: RunExecutor and restart recovery

**Files:**
- Create: `src/core/runs/runExecutor.ts`, `src/core/runs/runExecutor.test.ts`, `src/core/runs/recovery.ts`, `src/core/runs/recovery.test.ts`

**Interfaces:**
- Consumes: `CopilotLauncher`, `Prechecks`, `buildWatchPrompt`, `buildAdhocPrompt`, `applyOutcome`, `DataDir`, `writeJsonAtomic`, `closeWatch`.
- Produces:
  - `class RunExecutor { constructor(deps: { db; clock; config; secrets: Secrets; dataDir: DataDir; launcher: CopilotLauncher; prechecks: Prechecks; currentBranch(cwd: string): Promise<string | null>; onNeedsYou(e: NeedsYouEvent): Promise<void> }); execute(run: Run): Promise<RunFinal>; watchdog(): void; isBusy(): boolean }`.
  - `copilotResultSchema` (zod): `{ outcome: enum, summary: string }`, passthrough extra keys; summary truncated to 500 chars.
  - Result file shape `ResultFileV1` exactly as the spec's `result.json` example (ISO timestamps).
  - `recoverInterruptedRuns(deps: same as RunExecutor): Promise<number>` — finalizes leftover `running` rows as `error`, `interrupted: 'worker-restart'`, error code `INTERRUPTED`.
  - Error codes: `REPOSITORY_UNAVAILABLE`, `JIRA_DISABLED`, `PRECHECK_FAILED`, `SPAWN_FAILED`, `INTERRUPTED`, `EXIT_NONZERO`, `RESULT_MISSING`, `RESULT_INVALID`.

- [ ] **Step 1: Write failing tests** (real launcher with fake Copilot, stub prechecks, `timeoutMs: 1500` in config):
  - `acted run writes result.json v1, transcript and advances cursor`.
  - `needs-you outcome moves watch to needs_you and calls onNeedsYou once`.
  - `exit 1 is EXIT_NONZERO error`; `missing result is RESULT_MISSING`; `invalid json is RESULT_INVALID`.
  - `accepts long summary by truncating and ignores extra keys` (mode `long-summary`).
  - `timeout kills process and records interrupted timeout` (mode `hang`).
  - `cancel request kills process and records interrupted cancelled` — set `cancel_requested_at` then call `watchdog()`.
  - `missing repository folder fails preflight without transcript` → `REPOSITORY_UNAVAILABLE`, `transcriptPath === null`, launcher not called.
  - `jira disabled fails preflight with JIRA_DISABLED`.
  - `snapshot failure is PRECHECK_FAILED`.
  - `snapshot reporting merged closes watch and finishes success nothing 'Closed: merged' without Copilot`.
  - `spawn failure becomes SPAWN_FAILED error result` (`copilotBin` nonexistent).
  - `adhoc run uses adhoc prompt and leaves watches untouched`.
  - `stores branch from currentBranch`.
  - `recovery.test.ts`: `leftover running row becomes worker-restart error and watch needs_you`; `kills live process group of leftover row` (spawn `sleep 60` detached, store its pid, assert dead after recovery).
- [ ] **Step 2: Run** `npx vitest run src/core/runs/runExecutor.test.ts src/core/runs/recovery.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Write `prompt.md` before spawning; `currentBranch` default uses `git rev-parse --abbrev-ref HEAD` via `execFile` with 5 s timeout, `null` on failure. Error precedence: `INTERRUPTED` > `SPAWN_FAILED` > `EXIT_NONZERO` > `RESULT_MISSING` > `RESULT_INVALID`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): run executor with timeout, cancel and recovery`

---

### Task 16: TeamsNotifier

**Files:**
- Create: `src/core/notify/teamsNotifier.ts`, `src/core/notify/teamsNotifier.test.ts`

**Interfaces:**
- Consumes: `CopilotLauncher`, `Config`, `NeedsYouEvent`, `Watch`.
- Produces:
  - `config.teams` keys per the spec: `chatId`, `tool` (default `"teams-global(send_chat_message)"`), `model?`, `dashboardUrl` (default `"http://127.0.0.1:4317"`). Add `tool`, `model`, `dashboardUrl` to `config/schema.ts` and the example config in this task.
  - `interface Notifier { notifyNeedsYou(event: NeedsYouEvent): Promise<void> }`; `createTeamsNotifier(deps: { db; config; launcher: CopilotLauncher; dataDir: DataDir; timeoutMs?: 120_000 }): Notifier` — no-op when `teams` is absent; spawns with `cwd = dataDir root`, `extraArgs: ['--available-tools', config.teams.tool]`, model = `teams.model ?? runs.defaultModel`; message `Automator: "<watch title>" needs you: <reason>. <dashboardUrl>/watches/<id>`; updates the event to `sent` (exit 0) or `failed` with last 500 chars of `cli.log`-equivalent stderr as `teams_error`. Never throws.

- [ ] **Step 1: Write failing tests** (fake Copilot): `sends with available-tools restricted and marks sent`; `exit 1 marks failed with error text`; `timeout marks failed`; `no teams config leaves event disabled and does not spawn`.
- [ ] **Step 2: Run** `npx vitest run src/core/notify` — Expected: FAIL.
- [ ] **Step 3: Implement.** Log file: `<dataDir>/notify/<eventId>.log`.
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): teams notification via copilot`

---

### Task 17: CleanupService

**Files:**
- Create: `src/core/cleanup/cleanupService.ts`, `src/core/cleanup/cleanupService.test.ts`

**Interfaces:**
- Produces: `class CleanupService { constructor(deps: { db; clock; config; dataDir }); isDue(): boolean; run(): { deletedWatches: number; deletedAttempts: number } }` — uses `meta.last_cleanup_at`.

- [ ] **Step 1: Write failing tests**: `deletes watches closed at least 30 days with runs, events and run dirs`; `keeps closed 29 days`; `never deletes active, paused, needs_you`; `keeps adhoc runs`; `removes attempt files older than retention`; `isDue after 7 days; disabled config is never due`.
- [ ] **Step 2: Run** `npx vitest run src/core/cleanup` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): weekly cleanup of closed watches`

---

### Task 18: Composition root, worker lock and worker loop

**Files:**
- Create: `src/core/index.ts`, `src/core/worker/lock.ts`, `src/core/worker/lock.test.ts`, `src/core/worker/jiraDoneNames.ts`, `src/worker/loop.ts`, `src/worker/main.ts`, `src/worker/loop.test.ts`

**Interfaces:**
- Consumes: everything in core so far.
- Produces:
  - `createCore(config: Config, deps?: Partial<Deps>): Core` where `Deps` is the spec's interface (`clock`, `gitlab(conn)`, `jira(conn)`, `copilot`, `notifier`) and `Core = { config; db; dataDir; watches: WatchService; queue: QueueService; scheduler: Scheduler; executor: RunExecutor; cleanup: CleanupService; notifier: Notifier; read: ReadModels; close(): void }` (`read` is filled by Task 20; until then export an empty object typed `ReadModels = {}`).
  - `bootstrap(opts?: { configPath?: string }): Core` — `loadDotenv`, `loadConfig`, `createCore`; shared by web, worker and CLI.
  - Re-exports: all domain types, `AppError`, `Result`, `parseDuration`, `formatDuration`, `allowedActions`.
  - `acquireWorkerLock(db, clock, pid: number, isAlive: (pid: number) => boolean): Result<void, { code: 'WORKER_RUNNING'; pid: number }>`; `heartbeat(db, clock, pid)`; `releaseWorkerLock(db, pid)`.
  - `resolveJiraDoneNames(core): Promise<void>` — for each Jira connection with `doneStatusIds`, fetch `statuses()`, store `meta.jira_done_names:<conn>` JSON; unknown ids logged as warnings and stored as `"<id> (unknown)"`; failures logged, never fatal.
  - `class WorkerLoop { constructor(core: Core, opts?: { tickMs?: 1000; schedulerEveryMs?: 30_000 }); iterate(): Promise<void>; start(): void; stop(): Promise<void> }` — `iterate` = heartbeat → `executor.watchdog()` → claim when not busy and start `execute` (not awaited; awaited by `stop`) → scheduler every 30 s → cleanup when due.

- [ ] **Step 1: Write failing tests**:
  - `lock.test.ts`: `second live worker is rejected with WORKER_RUNNING`; `stale heartbeat (16 s) is taken over`; `dead pid is taken over`; `release clears row`.
  - `loop.test.ts` (fake clock, fake Copilot): `iterate claims and runs one queued run at a time` (two queued adhoc → after first iterate one running, after completion second runs); `scheduler runs on first iterate and then every 30 s`; `cleanup runs when due`; `stop waits for the active run`.
- [ ] **Step 2: Run** `npx vitest run src/core/worker src/worker` — Expected: FAIL.
- [ ] **Step 3: Implement** `index.ts`, lock, done-names, loop. `src/worker/main.ts`: `bootstrap` → acquire lock (exit 1 with `Another worker is running (pid <n>)`) → `recoverInterruptedRuns` → `resolveJiraDoneNames` when Jira enabled → `loop.start()`. On SIGINT/SIGTERM: stop claiming, wait for the active Run (it is not cancelled; its own timeout still applies), release the lock, exit 0. A second signal exits immediately; the leftover Run is handled by restart recovery. Wire the GitLab `meCache` to `meta.gitlab_me:<conn>`.
- [ ] **Step 4: Manual check** — `AUTOMATOR_CONFIG=automator.config.example.json npx tsx src/worker/main.ts` starts, logs `worker started`, a second instance exits 1 with the message. Stop with Ctrl-C.
- [ ] **Step 5: Run** `npm run check` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(worker): composition root, lock and main loop`

---

### Task 19: CLI

**Files:**
- Create: `src/cli/main.ts`, `src/cli/main.test.ts`, `bin/automator.mjs`

**Interfaces:**
- Consumes: `bootstrap`, `Core`.
- Produces: `runCli(argv: string[], io: { out(s: string): void; err(s: string): void }, core?: Core): Promise<number>` (exit code). `bin/automator.mjs`: `#!/usr/bin/env node` that registers `tsx` (`import { register } from 'tsx/esm/api'; register()`) and calls `runCli(process.argv.slice(2), console-like io)` then `process.exit(code)`.

Commands exactly as in the spec's CLI section; `@file` reads text from a file. Output lines: `Watch #<id> created (<kind>, <repository>)`, `Watch #<id> deleted`, `Run #<id> queued (position <n>)`; `watch list` prints a table `ID STATE KIND REPOSITORY EVERY TARGET`. Errors: `UNKNOWN_REPOSITORY` → `Unknown Repository "<name>". No Watch was created. Known: a, b. Result file: <path>` (or `Result file could not be written: <msg>`); `DUPLICATE_WATCH` → `Already watched: Watch #<id> (<state>, every <interval>)`.

- [ ] **Step 1: Write failing tests**: `watch add success exits 0`; `unknown repository exits 1 and prints result file path`; `duplicate exits 1`; `missing --repo exits 2`; `run queues adhoc and prints position`; `run-now with --review-unresolved`; `watch rm while running exits 1 'Cancel the running Run first'`; `watch list filters by state`; `@file instructions are read`.
- [ ] **Step 2: Run** `npx vitest run src/cli` — Expected: FAIL.
- [ ] **Step 3: Implement** with commander (`exitOverride()` to map usage errors to 2).
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): watch and run commands`

---

### Task 20: Read models

**Files:**
- Create: `src/core/read-models/{home,watches,watchDetail,queue,runs,runDetail,adhoc,formOptions,nextCheck,index}.ts` and matching `*.test.ts` (one test file per model is fine: `readModels.test.ts`)
- Modify: `src/core/index.ts` (fill `ReadModels`)

**Interfaces:**
- Produces `ReadModels` with these functions (all synchronous except `runDetail`):
  - `homeView(): { needsYou: NeedsYouCard[]; running: RunningCard | null; recent: RunRow[] }`
  - `watchList(f: { state?: WatchState; kind?: WatchKind; repository?: string; q?: string }): { counts: Record<'all' | WatchState, number>; jiraNotice: boolean; rows: WatchRow[] }` — order: needs_you, active, paused, closed; then title.
  - `watchDetail(id): WatchDetailView | null` (watch, actions = `allowedActions` minus `delete` when running, settings with resolved defaults and Repository folder, last-handled-point lines, latest needs-you event, runs table)
  - `queueView(): { running: RunningCard | null; waiting: QueueRow[] }`
  - `runList(f: { outcome?: Outcome | 'error'; trigger?: Trigger; repository?: string }): RunRow[]`
  - `runDetail(id): Promise<RunDetailView | null>` — reads transcript, result JSON, prompt; each capped at 5 MB with `truncated: true`.
  - `adhocView(): { rows: AdhocRow[] }`
  - `formOptions(): { repositories: { name; folder; host: string | null }[]; models: string[]; defaultModel; intervals: { mr: number; default: number }; initialReview; jiraEnabled; defaultPromptFiles: Record<WatchKind, string | null> }`
  - `nextCheckText(w: Watch, ctx: { now; running: Run | null; queuedPos: number | null; config }): { kind: 'in' | 'running' | 'queued' | 'after-hours' | 'stopped' | 'jira-off' | 'cleanup' | 'paused'; text: string; since?: number }` — texts: `in 9m`, `queued #2`, `after hours · Mon 08:00`, `stopped`, `Jira off`, `cleanup in 12d`, `paused`.
  - View types exported from `read-models/index.ts`; field names are the UI spec's column names in camelCase.

- [ ] **Step 1: Write failing tests**: `home lists needs-you cards newest first with reason`; `watch list pins needs_you first and closed last, counts per state`; `jira notice only when jira disabled and a jira watch exists`; `nextCheckText covers every kind` (one assertion per kind with the exact texts above); `detail hides delete while running`; `queue view orders by priority then time and shows positions`; `run list error filter matches result_status error`; `run detail truncates files over 5 MB`; `form options list repositories with gitlab host`.
- [ ] **Step 2: Run** `npx vitest run src/core/read-models` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): read models for dashboard views`

---

### Task 21: Dashboard shell, theme, Home page

**Files:**
- Create: `next.config.ts`, `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `app/lib/core.ts`, `app/components/{Sidebar,TopBar,Pill,AutoRefresh,ConfirmDialog,Elapsed,EmptyState,RelativeTime}.tsx`, `app/actions/runs.ts`, `app/actions/watches.ts` (resume actions only for now), `app/files/run/[id]/[name]/route.ts`, `app/files/attempt/[name]/route.ts`
- Modify: `package.json` `check` script depcruise target → `src app`

**Interfaces:**
- Consumes: `bootstrap`, `ReadModels`, `WatchService`, `QueueService`.
- Produces:
  - `getCore(): Core` (`app/lib/core.ts`, module-level singleton, `import 'server-only'`).
  - `type ActionResult<T = void> = { ok: true; value?: T } | { ok: false; error: AppError }` (`app/actions/types.ts`).
  - Server Actions: `resumeWatch(prev, formData: { id, note?, runNow? })`, `cancelRun(id: number)`.
  - `<Pill variant="needs-you" | "good" | "running" | "neutral" | "paused" | "closed" | "info" | "interrupted">` with the UI spec's colours; CSS custom properties for every palette token in `globals.css`.
  - `<AutoRefresh intervalMs={3000}/>` — refreshes only when visible, no focused input/textarea/select, and no open `dialog[open]`.
  - `<Elapsed since={ms} limitMs?>` ticks every second, format `mm:ss` (`mm:ss / 30:00` with limit).
  - File routes serve only names `prompt.md|transcript.md|result.json|copilot-result.json|cli.log` (run) and `*.json` inside `attempts/` (attempt), verified with `DataDir.isInside`; 404 otherwise; `Content-Type: text/plain; charset=utf-8` or `application/json`.

- [ ] **Step 1: Implement** `next.config.ts` (`serverExternalPackages: ['better-sqlite3']`), layout (sidebar items Home, Watches (count), Queue (waiting count), Runs, Ad-hoc; top bar **+ Watch** secondary, **Ad-hoc run** primary), Home sections exactly as UI spec screen 1 (Needs you cards with Resume / Resume & run now; Now running with Cancel and confirmation "Cancelling can't undo replies or pushes that already happened."; Recent Runs). Match `docs/superpowers/specs/assets/01-home-palette.html` palette 1.
- [ ] **Step 2: Write route test** `app/files/files.test.ts` (Vitest, call the route `GET` handlers directly): `serves transcript inside data dir`; `rejects traversal name with 404`; `rejects unknown file name with 404`.
- [ ] **Step 3: Run** `npx vitest run app/files` — Expected: PASS after implementation.
- [ ] **Step 4: Visual check** — seed via `npx tsx test/helpers/seed.ts <dataDir>` (create this script: 1 needs-you MR Watch, 1 active, 1 running ad-hoc, 3 finished Runs with transcripts), run `npm run dev`, open `http://127.0.0.1:3000/`, compare with mockup 01.
- [ ] **Step 5: Run** `npm run check && npm run build` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): dashboard shell, theme and home page`

---

### Task 22: Watches list and Watch detail

**Files:**
- Create: `app/watches/page.tsx`, `app/watches/[id]/page.tsx`, `app/components/{WatchFilters,WatchRowMenu,RunNowPopover,NeedsYouCard,RunsTable}.tsx`
- Modify: `app/actions/watches.ts`

**Interfaces:**
- Consumes: `watchList`, `watchDetail`, `WatchService`.
- Produces Server Actions (each returns `ActionResult` and `revalidatePath('/', 'layout')`): `pauseWatch(id)`, `resumeWatch` (from Task 21), `closeWatch(id)`, `reopenWatch(id)`, `deleteWatch(id)` (redirects to `/watches`), `runWatchNow(prev, formData: { id, extraInstructions?, reviewUnresolved? })`.

- [ ] **Step 1: Implement** list page per UI spec screen 2 (filters via search params; Jira notice text: "Jira checking is off (`jira.enabled` is false). Jira Watches are kept but don't run on schedule or via Run now."; row menu shows only `allowedActions`) and detail page per screen 3 (Delete disabled with tooltip "Cancel the running Run first" while running; Run now ▾ popover with the review checkbox for MR only; Teams status `sent ✓` / `failed: <error>`). Errors from actions render in a red box at the top of the page. Destructive actions use `ConfirmDialog`. Match mockup 02.
- [ ] **Step 2: Visual check** with seeded data: filters, pinned Needs you rows, each Next check text, row menu contents per state, detail page right-column cards.
- [ ] **Step 3: Run** `npm run check && npm run build` — Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): watches list and detail pages`

---

### Task 23: Watch create/edit form

**Files:**
- Create: `app/watches/new/page.tsx`, `app/watches/[id]/edit/page.tsx`, `app/components/{WatchForm,ErrorBox,KindBadge}.tsx`
- Modify: `app/actions/watches.ts`

**Interfaces:**
- Consumes: `formOptions`, `WatchService.create/update/previewTarget`.
- Produces Server Actions: `createWatch(prev, formData)` → redirect to `/watches/<id>` on success, `ActionResult` with error and echoed values otherwise; `updateWatch(prev, formData)`; `previewTarget(target: string, repository: string)` → `{ kind; preview; previewError?; error? }`.
- `<ErrorBox error={AppError}/>` renders: `UNKNOWN_REPOSITORY` — title `Unknown Repository "<name>"`, line `No Watch was created`, known names, result file path with **open** link to `/files/attempt/<basename>`, or `The result file could not be written: <error>`; `DUPLICATE_WATCH` — `Already watched`, existing state + interval, link `/watches/<id>`; others — the message. Reused by Task 24's ad-hoc form.

- [ ] **Step 1: Implement** per UI spec screen 4: fields, debounced (500 ms) kind detection + MR preview, interval pre-filled with the kind default via `formatDuration`, model dropdown default first, initial review segmented control (MR only) with explanations ("Ignore existing comments" / "Review existing unresolved discussions once"), edit mode locks Target and Repository with the note "To change the target or Repository, close this Watch and create a new one.". Form uses `useActionState` and keeps entered values on error. Match mockup 03.
- [ ] **Step 2: Visual check**: unknown Repository typed via devtools-edited select value (or `?repository=nope` prefill), duplicate target, free-form without instructions, MR preview failure shows muted reason.
- [ ] **Step 3: Run** `npm run check && npm run build` — Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): watch create and edit form`

---

### Task 24: Queue, Runs, Run detail, Ad-hoc pages

**Files:**
- Create: `app/queue/page.tsx`, `app/runs/page.tsx`, `app/runs/[id]/page.tsx`, `app/adhoc/page.tsx`, `app/components/{RunTabs,RunMeta}.tsx`, `app/actions/adhoc.ts`
- Modify: `app/actions/runs.ts`

**Interfaces:**
- Consumes: `queueView`, `runList`, `runDetail`, `adhocView`, `QueueService`, `WatchService.close`.
- Produces Server Actions: `queueAdhoc(prev, formData: { repository, prompt, model })` (unknown Repository → same attempt-file behavior as Watch creation: **reuse** `writeAttemptError` via a new `QueueService.enqueueAdhocChecked(input, config): Result<Run>` added in this task with test `unknown repository writes attempt file and queues nothing` in `queueService.test.ts`), `cancelQueued(id)`, `closeWatchFromQueue(watchId)`, `deleteAdhocRun(id)`.

- [ ] **Step 1: Write the failing test** for `enqueueAdhocChecked` and make it pass; update the CLI `run` command to use it (CLI test `unknown repository for run exits 1` added to `src/cli/main.test.ts`).
- [ ] **Step 2: Implement pages** per UI spec screens 5–8: Queue running card with `Elapsed` against timeout and the note "Live transcript isn't available in v1. It appears when the Run finishes."; waiting table heading "Waiting · manual & ad-hoc go first"; Runs filters and `—` duration for pre-start errors, `timed out`/`cancelled` interrupted pills; Run detail metadata, red structured-error card, tabs Transcript / Result JSON / Prompt with the empty transcript text "No transcript — the Run failed before Copilot started"; Ad-hoc form helper text "Goes ahead of scheduled work, ignores working hours, never interrupts the current Run." and history actions. Match mockup 04.
- [ ] **Step 3: Visual check** with seeded data.
- [ ] **Step 4: Run** `npm run check && npm run build` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): queue, runs, run detail and ad-hoc pages`

---

### Task 25: Playwright smoke tests and run instructions

**Files:**
- Create: `playwright.config.ts`, `test/e2e/smoke.spec.ts`, `test/e2e/global-setup.ts`
- Modify: `README.md` (add "Getting started" section), `test/helpers/seed.ts` (export `seed(core)`)

**Interfaces:**
- Consumes: `seed`, `bootstrap`.

- [ ] **Step 1: Configure** Playwright: `globalSetup` creates a temp data dir and config (`AUTOMATOR_CONFIG`), seeds it; `webServer` runs `next build && next start -H 127.0.0.1 -p 4399` with that env; worker not started.
- [ ] **Step 2: Write tests** `smoke.spec.ts`:
  - `home shows needs-you card and resume moves it away` — click **Resume**, card disappears, "Nothing needs you." visible.
  - `watches list pins needs-you first and shows jira notice` (seed includes a Jira Watch; `jira.enabled` false).
  - `create form shows unknown repository error with result file path` — submit with a repository value forced to `nope` via `page.evaluate` on the select; red box contains `Unknown Repository "nope"` and `No Watch was created`.
  - `create form shows duplicate error with link to existing watch`.
  - `run detail shows transcript, result json and prompt tabs`.
- [ ] **Step 3: Run** `npm run e2e` — Expected: 5 passed.
- [ ] **Step 4: Write README "Getting started"**: prerequisites (Node 24, Copilot CLI logged in), `npm install`, copy `automator.config.example.json` → `automator.config.json` and `.env.example` → `.env`, `npm run build`, `npm start`, open `http://127.0.0.1:4317`, CLI examples from the spec. Update the status line to "v1 implemented".
- [ ] **Step 5: Run** `npm run check && npm run e2e` — Expected: PASS.
- [ ] **Step 6: Commit** `test(e2e): dashboard smoke tests and getting-started docs`
