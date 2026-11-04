# SQLite Repository Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Repository definitions in SQLite and manage them from Settings while preserving name-based Watch and Run behavior.

**Architecture:** Add one DB-backed Repository service for storage, validation, migration import, and CRUD. Keep service connection definitions in config and inject the Repository service into the existing worker, dashboard, CLI, project, and read-model flows.

**Tech Stack:** TypeScript, Zod, SQLite (`better-sqlite3`), Next.js Server Actions, React, Vitest.

**Spec:** [2026-11-03-repository-management-design.md](../specs/2026-11-03-repository-management-design.md)

## Global Constraints

- GitLab, GitHub, and Jira connection hosts and credential environment-variable references remain in config.
- Credential values are not stored in SQLite or tracked configuration.
- Repository references are by name; no GitLab-backed discovery or storage is introduced.
- Removing a Repository never deletes files from its local folder.
- A Repository with Watches cannot be deleted.
- Import legacy Repository definitions only when the legacy config list is present, the table is empty, and the persistent import marker is absent.
- After successful import, ignore the legacy config list as a Repository source.

## Review Focus

- A case-insensitive rename collision must fail without changing any references; test the update transaction in Task 1.
- A Repository imported with a missing connection or folder must remain visible and be clearly diagnosed, then become usable after corrected; test status and repair in Task 1 and Task 3.
- An absent legacy list must not block startup or mark an import complete; test in Task 1.
- A populated repository table must not be overwritten by a changed legacy list; test in Task 1.
- Unknown Repository names must produce explicit Watch/Run errors rather than config fallback; test in Task 2.

---

### Task 1: Persist, validate, and import Repositories

**Files:**

- Modify: `src/core/db/migrations/index.ts`
- Modify: `src/core/db/db.test.ts`
- Modify: `src/core/config/schema.ts`
- Modify: `src/core/config/load.ts`
- Modify: `src/core/config/load.test.ts`
- Modify: `src/core/config/editor.ts`
- Modify: `src/core/config/editor.test.ts`
- Create: `src/core/repositories/repositoryService.ts`
- Create: `src/core/repositories/repositoryService.test.ts`
- Create: `src/core/repositories/legacyImport.ts`
- Create: `src/core/repositories/legacyImport.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**

- `Repository`: `{ name: string; folder: string; gitlab: string | null; github: string | null; jira: string | null; validate: string[] }`.
- `RepositoryInput`: same fields as `Repository`; names and folders are strings, connection references may be `null`, and `validate` is a string array.
- `RepositoryService.list(): Repository[]`, `get(name: string): Repository | null`, `status(name: string): string[]`, `create(input: RepositoryInput): Result<Repository>`, `update(name: string, input: RepositoryInput): Result<Repository>`, and `delete(name: string): Result<void>`.
- A valid Repository has at least one GitLab or GitHub connection. `status` reports a missing folder or missing configured connection by name. `create` and `update` reject invalid folder/connection references and case-insensitive name collisions. `update` preserves references transactionally across Watches, Runs, Projects, and Repository-specific Agent assignments. `delete` rejects if any Watch references the Repository, and otherwise removes Project/Agent references without deleting Runs or files.
- The legacy importer reads `repositories` from the raw config only if its DB table is empty and its `meta` marker is absent. An absent key is a no-op; a present legacy object is imported transactionally, and the marker is written only on successful import. It logs imported Repository names.
- Remove the legacy list from runtime `Config`; the runtime schema ignores the raw legacy property. Legacy import parses the old `folder`, optional connection names, and `validate` fields, resolving folders against the config directory.

- [ ] **Step 1: Write failing tests** for DB table creation; Repository CRUD/status; case-insensitive duplicate and rename collision; no GitLab/GitHub connection; rename reference preservation; Watch-protected deletion; deletion preserving files and Runs; legacy import, absent-list no-op, malformed data error, marker idempotency, and populated-table non-overwrite. Verify the config editor neither exposes nor overwrites the legacy Repository list.
- [ ] **Step 2: Run focused tests to confirm failures.** Run: `npm test -- src/core/db/db.test.ts src/core/repositories/repositoryService.test.ts src/core/repositories/legacyImport.test.ts src/core/config/load.test.ts`.
- [ ] **Step 3: Implement the schema, runtime config adjustment, Repository service, and legacy importer.** Use a versioned migration for the new table and use the existing `meta` table for the import marker.
- [ ] **Step 4: Wire startup and expose the service from `Core`.** Run the importer after `migrate` and before constructing DB-backed consumers; ensure import logs do not include secret values.
- [ ] **Step 5: Run focused tests.** Run: `npm test -- src/core/db/db.test.ts src/core/repositories/repositoryService.test.ts src/core/repositories/legacyImport.test.ts src/core/config/load.test.ts src/core/index.test.ts`.

### Task 2: Use persisted Repositories in worker, CLI, and dashboard data flows

**Files:**

- Modify: `src/core/index.ts`
- Modify: `src/core/domain/targets.ts` and related tests
- Modify: `src/core/prechecks/jiraClient.ts`
- Modify: `src/core/watches/watchService.ts` and related tests
- Modify: `src/core/queue/queueService.ts` and related tests
- Modify: `src/core/runs/runExecutor.ts` and related tests
- Modify: `src/core/runs/recovery.ts` and related tests
- Modify: `src/core/runs/promptBuilder.ts` and related tests
- Modify: `src/core/read-models/deps.ts`, `formOptions.ts`, `watchDetail.ts`, `thread.ts`, and related tests
- Modify: `src/core/projects/projectService.ts` and related tests
- Modify: `src/cli/main.ts` and related tests
- Modify: `app/actions/agents.ts` and related tests
- Modify: `app/settings/agents/page.tsx`
- Modify: `app/projects/page.tsx`
- Modify: `app/watches/new/page.tsx`
- Modify: `app/components/AdhocForm.tsx`

**Interfaces:**

- Consume `RepositoryService` from Task 1 via the shared `Core` and read/worker dependencies; do not read `config.repositories`.
- `formOptions` continues returning `{ name, folder, host, project }` per Repository, deriving host from the Repository's named connection and current config.
- Preserve Watch/Run repository identifiers as names. Use `RepositoryService.get` for lookup and its status/operational validation before starting work.
- Preserve existing error/result conventions for unknown Repository names, missing folders, and missing connection references; do not silently select another Repository or connection.

- [ ] **Step 1: Add focused failing tests** for Watch and ad-hoc Run resolution by name, persisted folder and validation commands, a Repository referencing both GitLab/GitHub, missing folder/connection errors, unknown names, recovery, CLI validation, and read-model/Project/Agent Repository lists.
- [ ] **Step 2: Run focused tests to confirm failures.** Run the test files listed above for each modified service, along with `src/core/index.test.ts`.
- [ ] **Step 3: Replace config-list lookups with Repository service lookups.** Keep service hosts/secrets sourced only from the config connection maps.
- [ ] **Step 4: Run focused tests.** Run: `npm test -- src/core/domain/targets.test.ts src/core/watches/watchService.test.ts src/core/queue/queueService.test.ts src/core/runs/runExecutor.test.ts src/core/runs/recovery.test.ts src/core/runs/promptBuilder.test.ts src/core/read-models/readModels.test.ts src/core/projects/projectService.test.ts src/cli/main.test.ts app/actions/agents.test.ts src/core/index.test.ts`.

### Task 3: Add Repository management to Settings

**Files:**

- Create: `app/settings/repositories/page.tsx`
- Create: `app/components/RepositoriesManager.tsx`
- Create: `app/components/RepositoriesManager.test.ts`
- Create: `app/actions/repositories.ts`
- Create: `app/actions/repositories.test.ts`
- Modify: `app/components/Sidebar.tsx`
- Modify: `app/settings/config/page.tsx`
- Modify: `app/actions/projects.test.ts`

**Interfaces:**

- Server actions `createRepository`, `updateRepository`, and `deleteRepository` parse inputs, call `getCore().repositories`, return existing `ActionResult`/`FormResult` errors, and revalidate the dashboard layout after success.
- The page renders all DB records with their `status` diagnostics and links from Configuration Settings.
- The manager supports create/edit/delete of name, local folder, GitLab/GitHub/Jira connection references, and validation commands. Connection choices come from config names; the UI never displays token values or environment-variable binding names.
- Failed operations show actionable errors. Delete confirmation states that Watches block deletion and that local files are never deleted.

- [ ] **Step 1: Write failing tests** for action CRUD, invalid folder/connection rejection, visible status of imported invalid entries, name collision, watch-protected delete, and loopback request enforcement consistent with existing action patterns.
- [ ] **Step 2: Run focused tests to confirm failures.** Run: `npm test -- app/actions/repositories.test.ts app/components/RepositoriesManager.test.ts`.
- [ ] **Step 3: Implement the Settings page, manager, and actions** with existing Server Action and error component patterns.
- [ ] **Step 4: Run focused tests.** Run: `npm test -- app/actions/repositories.test.ts app/components/RepositoriesManager.test.ts app/actions/projects.test.ts`.

### Task 4: Update setup and Repository documentation

**Files:**

- Modify: `README.md`
- Modify: `automator.config.example.json`
- Modify: `GLOSSARY.md`

**Interfaces:**

- The example config omits the `repositories` key and retains connection definitions without credentials.
- README documents adding Repositories in Settings and the automatic one-time import of existing config entries, including that the legacy list is ignored after import.
- README describes the SQLite ownership model, name-based references, validation behavior, Watch-protected deletion, and that local Repository files are never deleted.
- GLOSSARY defines Repository consistently with the DB-backed Settings-managed record.

- [ ] **Step 1: Update the example config, README, and glossary** to reflect the behavior above without documenting or including secrets.
- [ ] **Step 2: Verify documentation/config shape.** Run: `npm run format:check`; inspect `automator.config.example.json` to confirm no `repositories` key or credential values remain.
