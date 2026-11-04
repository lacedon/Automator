# Multi-provider Run Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Code, Codex CLI, and OpenCode as selectable Run providers while preserving Copilot defaults and the shared Run lifecycle.

**Architecture:** Add one validated global provider setting and snapshot provider/model on each queued Run. Provider adapters implement one process/session/output contract; `RunExecutor` remains responsible for shared lifecycle behavior. Settings and history expose provider/model details, and documentation describes installation and provider capability differences.

**Tech Stack:** TypeScript, Zod, SQLite migrations, Next.js Server Components/Actions, Vitest fake child processes, Markdown documentation.

**Spec:** [docs/superpowers/specs/2026-11-03-multi-provider-design.md](../specs/2026-11-03-multi-provider-design.md)

## Global Constraints

- Provider selection is installation-wide; Agent assignments select instructions, not providers.
- Missing provider configuration means Copilot; existing `copilotBin`, `runs.defaultModel`, and `runs.models` remain the Copilot settings.
- Persist provider and model on each Run at enqueue time; coalesced queued Watch Runs retain both; follow-ups inherit both from their parent.
- Never switch providers implicitly; unsupported options and failures remain visible and actionable.
- Every adapter supports non-interactive execution and continuation for follow-up Runs.
- The executor owns Repository cwd, queue serialization, timeout, cancellation, shutdown/recovery, and finalization.
- Provider API credentials are not exposed to the coding agent's tool subprocesses; credentials never live in JSON config.
- Do not add a dependency unless implementation demonstrates it is necessary.
- Do not commit or push unless requested.

## Review Focus

- Legacy config and pre-migration Run rows must still use Copilot — pin in Task 1 config and migration tests.
- A provider change while a Watch Run is queued must not reroute it or mismatch its model — pin in Task 2 coalescing tests.
- Follow-up Runs must retain the parent provider/session after global settings change — pin in Task 2 follow-up tests.
- Provider API keys and configured Git/Jira tokens must not leak into tool subprocess environments — pin in Task 3 environment tests.
- Provider-specific auth/model failures and malformed output must not become success or fall back — pin in Tasks 4–6 adapter tests.

---

### Task 1: Provider configuration and Run persistence

**Files:**

- Modify: `src/core/domain/types.ts`
- Modify: `src/core/config/schema.ts`
- Create: `src/core/config/providers.ts`
- Modify: `src/core/config/editor.ts`
- Modify: `src/core/db/migrations/index.ts`
- Modify: `src/core/db/rows.ts`
- Test: `src/core/config/load.test.ts`
- Test: `src/core/config/editor.test.ts`
- Test: `src/core/db/db.test.ts`

**Interfaces:**

- Produces `ProviderName = 'copilot' | 'claude-code' | 'codex' | 'opencode'`.
- Config uses `provider` (default `copilot`) and `providers` keys `'claude-code'`, `codex`, and `opencode`, each with `{ bin, defaultModel, models }`. Copilot continues to use `copilotBin` and `runs.defaultModel`/`runs.models`.
- Each non-Copilot `bin` defaults to its conventional executable name; its `defaultModel` and `models` default to empty values so the user can configure current model IDs in Settings. Reject selecting a provider without a configured default model.
- Produces `providerOptions(config: Config, provider: ProviderName): { bin: string; defaultModel: string; models: string[] }`, reading the matching settings above.
- `Run` gains `provider: ProviderName`; migration adds a constrained `runs.provider` column with default `copilot`.

- [x] **Step 1: Write config compatibility tests** named `legacy config defaults provider to Copilot and preserves Copilot options` and `provider options use the selected provider settings`; assert the legacy default is `copilot`, unchanged `copilotBin`/model values, conventional CLI binary defaults, and that selecting `codex` returns only `providers.codex` values.
- [x] **Step 2: Run `npx vitest run src/core/config/load.test.ts`** and verify the new expectations fail.
- [x] **Step 3: Implement the provider union, provider settings schema, and `providerOptions` helper** in the listed domain/config files. Keep Copilot settings on their existing fields; default non-Copilot model fields to empty and reject a selected provider with no default model.
- [x] **Step 4: Write config-editor tests** `legacy config exposes defaults for every provider` and `provider settings round-trip without exposing credentials`; assert legacy config exposes all three new CLI controls, edited provider binaries/models persist, and credential values/env-var names are absent from `EditableConfig`.
- [x] **Step 5: Run `npx vitest run src/core/config/editor.test.ts`** and verify the new expectations fail before the editor implementation.
- [x] **Step 6: Update `EditableConfig`, `projectConfig`, and merge behavior** to edit the provider fields while preserving existing secret-handling and fixed-key behavior.
- [x] **Step 7: Write migration/row-mapping test** `existing Runs migrate to Copilot and provider values round-trip`; start from the previous schema, assert old rows read `provider: 'copilot'`, and assert a new `codex` row maps to `provider: 'codex'`.
- [x] **Step 8: Run `npx vitest run src/core/db/db.test.ts`** and verify the new migration expectation fails before the migration implementation.
- [x] **Step 9: Add the next ordered SQLite migration and map `provider` in `toRun`**; retain the Copilot default for all existing rows.
- [x] **Step 10: Run `npx vitest run src/core/config src/core/db`** and verify all focused tests pass.

### Task 2: Queue provider snapshots and model options

**Files:**

- Modify: `src/core/queue/queueService.ts`
- Modify: `src/core/scheduler/scheduler.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/core/read-models/formOptions.ts`
- Modify: `src/core/read-models/watchDetail.ts`
- Modify: `src/core/read-models/index.ts`
- Modify: `src/core/watches/watchService.ts`
- Modify: `app/actions/adhoc.ts`
- Modify: `app/actions/watches.ts`
- Test: `src/core/queue/queueService.test.ts`
- Test: `src/core/scheduler/scheduler.test.ts`
- Test: `src/core/watches/watchService.test.ts`
- Test: `src/cli/main.test.ts`
- Test: `src/core/read-models/readModels.test.ts`
- Test: `app/actions/adhoc.test.ts`
- Test: `app/actions/watches.test.ts`

**Interfaces:**

- Consumes Task 1's `ProviderName` and `providerOptions`.
- Produces form options with selected global provider and that provider's configured `defaultModel`/`models`.
- Queue services snapshot the configured provider for new Runs; follow-up enqueue accepts the parent's provider explicitly.

- [x] **Step 1: Write queue tests** named `new Runs snapshot the selected provider`, `coalescing does not change a queued Run provider or model`, and `follow-up inherits provider, model, and session`; assert a provider change from `copilot` to `codex` never mutates the queued/copied parent values.
- [x] **Step 2: Run `npx vitest run src/core/queue/queueService.test.ts`** and verify the new expectations fail.
- [x] **Step 3: Implement provider snapshotting in `QueueService`**. Preserve provider/model on a coalesced queued Watch Run; query provider with parent model/session for follow-ups.
- [x] **Step 4: Write tests** `scheduler uses the selected provider default model` and `form options expose selected provider models`; assert `codex` schedules use `providers.codex.defaultModel` and return only `providers.codex.models` plus that default.
- [x] **Step 5: Run `npx vitest run src/core/scheduler/scheduler.test.ts src/core/read-models/readModels.test.ts`** and verify new expectations fail before updating those surfaces.
- [x] **Step 6: Update scheduler, CLI, form options, and ad-hoc/Watch action validation** to use `providerOptions`; reject a selected unsupported model with a visible validation error instead of falling back. WatchService and Watch detail use the selected provider's model configuration.
- [x] **Step 7: Run `npx vitest run src/core/queue/queueService.test.ts src/core/scheduler/scheduler.test.ts src/cli/main.test.ts src/core/read-models/readModels.test.ts app/actions/adhoc.test.ts app/actions/watches.test.ts`** and verify all tests pass.

### Task 3: Shared launcher contract and Copilot-preserving executor

**Files:**

- Create: `src/core/runs/providerLauncher.ts`
- Create: `src/core/runs/childProcess.ts`
- Modify: `src/core/runs/copilotLauncher.ts`
- Modify: `src/core/runs/runExecutor.ts`
- Modify: `src/core/index.ts`
- Modify: `src/core/notify/teamsNotifier.ts`
- Test: `src/core/runs/copilotLauncher.test.ts`
- Test: `src/core/runs/runExecutor.test.ts`

**Interfaces:**

- Produces `ProviderExit = { code: number | null; signal: string | null; error?: RunError }`.
- Produces `RunningProcess = { pid: number; sessionId: Promise<string | null>; exited: Promise<ProviderExit>; kill(signal: 'SIGTERM' | 'SIGKILL'): void }`.
- Produces `ProviderStartOptions = { cwd: string; prompt: string; model: string; transcriptPath: string; logPath: string; env: Env; sessionId?: string }`.
- Produces `ProviderLauncher.start(options: ProviderStartOptions): RunningProcess` and `ProviderLaunchers = Record<ProviderName, ProviderLauncher>`.
- `RunExecutorDeps` consumes `launchers: ProviderLaunchers`; Teams notifications continue to receive the Copilot launcher.

- [x] **Step 1: Write tests** `Copilot invocation remains compatible`, `executor selects the Run provider`, and `provider credentials are not inherited by tool subprocesses`; assert the Copilot CLI args/cwd/session stay unchanged, a `codex` Run starts the Codex launcher, and fake tools cannot read provider/Git/Jira credentials.
- [x] **Step 2: Run `npx vitest run src/core/runs/copilotLauncher.test.ts src/core/runs/runExecutor.test.ts`** and verify the new expectations fail.
- [x] **Step 3: Extract detached child spawning, log handling, process-group termination, and secret filtering** into `childProcess.ts`; define the common provider contract in `providerLauncher.ts`.
- [x] **Step 4: Adapt Copilot to `ProviderLauncher` and update `RunExecutor`** to select the persisted provider, await its native session identifier, map structured adapter errors to Run failures, and retain shared watchdog/finalization behavior.
- [x] **Step 5: Run the focused launcher, executor, and worker lifecycle tests** with `npx vitest run src/core/runs src/worker/loop.test.ts`; verify timeout, cancellation, one-active-Run, and restart behavior remain passing.

### Task 4: Claude Code adapter

**Files:**

- Create: `src/core/runs/claudeCodeLauncher.ts`
- Create: `src/core/runs/claudeCodeLauncher.test.ts`
- Create: `test/fixtures/fake-claude.mjs`
- Modify: `src/core/index.ts`

**Interfaces:**

- Consumes Task 3's `ProviderLauncher`, `ProviderStartOptions`, and shared child-process helper.
- Produces `createClaudeCodeLauncher(config: Config, secrets: Secrets): ProviderLauncher`.

- [x] **Step 1: Write fake-CLI tests** `Claude Code invocation normalizes output and session`, `Claude Code reports missing CLI/auth/model errors`, and `Claude Code does not expose API credentials`; assert non-interactive mode, selected model, resume ID, configured cwd, normalized transcript/session, and structured actionable failures.
- [x] **Step 2: Run `npx vitest run src/core/runs/claudeCodeLauncher.test.ts`** and verify the new tests fail.
- [x] **Step 3: Implement `createClaudeCodeLauncher`** using the official Claude Code CLI options documented in the spec; convert native output/session data to the shared contract.
- [x] **Step 4: Run `npx vitest run src/core/runs/claudeCodeLauncher.test.ts`** and verify all adapter tests pass.

### Task 5: Codex CLI adapter

**Files:**

- Create: `src/core/runs/codexLauncher.ts`
- Create: `src/core/runs/codexLauncher.test.ts`

**Interfaces:**

- Consumes Task 3's `ProviderLauncher`, `ProviderStartOptions`, and shared child-process helper.
- Produces `createCodexLauncher(config: Config, secrets: Secrets): ProviderLauncher`.

- [x] **Step 1: Write fake-CLI tests** `Codex invocation normalizes JSONL output and session`, `Codex reports missing CLI/auth/model errors`, and `Codex does not expose API credentials`; assert non-interactive mode, selected model, resume ID, configured cwd, normalized transcript/session, and structured actionable failures.
- [x] **Step 2: Run `npx vitest run src/core/runs/codexLauncher.test.ts`** and verify the new tests fail.
- [x] **Step 3: Implement `createCodexLauncher`** using `codex exec --json`, `--sandbox workspace-write`, a narrow `--add-dir` grant for Run artifacts, and `codex exec resume`; convert native JSONL/session data to the shared contract.
- [x] **Step 4: Run `npx vitest run src/core/runs/codexLauncher.test.ts`** and verify all adapter tests pass.

### Task 6: OpenCode adapter

**Files:**

- Create: `src/core/runs/openCodeLauncher.ts`
- Create: `src/core/runs/openCodeLauncher.test.ts`

**Interfaces:**

- Consumes Task 3's `ProviderLauncher`, `ProviderStartOptions`, and shared child-process helper.
- Produces `createOpenCodeLauncher(config: Config, secrets: Secrets): ProviderLauncher`.

- [x] **Step 1: Write fake-CLI tests** `OpenCode invocation normalizes JSON events and session`, `OpenCode reports missing CLI/auth/model errors`, and `OpenCode does not expose API credentials`; assert non-interactive mode, selected model, resume ID, configured cwd, normalized transcript/session, and structured actionable failures.
- [x] **Step 2: Run `npx vitest run src/core/runs/opencodeLauncher.test.ts`** and verify the new tests fail.
- [x] **Step 3: Implement `createOpenCodeLauncher`** using `opencode --auto run --format json`, `--session`, and provider/model IDs; convert native output/session data to the shared contract.
- [x] **Step 4: Run `npx vitest run src/core/runs/opencodeLauncher.test.ts`** and verify all adapter tests pass.

### Task 7: Provider Settings, Run history, and operator documentation

**Files:**

- Modify: `src/core/index.ts`
- Modify: `src/core/read-models/runs.ts`
- Modify: `app/components/ConfigForm.tsx`
- Modify: `app/components/AdhocForm.tsx`
- Modify: `app/components/WatchForm.tsx`
- Modify: `app/components/RunsTable.tsx`
- Modify: `app/components/RunMeta.tsx`
- Modify: `app/actions/config.test.ts`
- Modify: `src/core/read-models/readModels.test.ts`
- Modify: `test/e2e/smoke.spec.ts`
- Modify: `automator.config.example.json`
- Modify: `README.md`

**Interfaces:**

- Consumes `ProviderName`, `providerOptions`, the provider launchers, and provider-aware form options from Tasks 1–6.
- Run list/detail read models expose the persisted `provider`; the Settings/config editor shows the global selector and all provider executable/model settings.

- [x] **Step 1: Write tests** `Run history uses the persisted provider` and `provider Settings selector and model fields render`; assert a Run remains labeled `copilot` after global config changes to `codex`, all four provider options and executable/model fields render, and no credential is shown.
- [x] **Step 2: Run `npx vitest run src/core/read-models/readModels.test.ts app/actions/config.test.ts` and `npm run e2e -- --grep "provider settings"`**; verify the missing persisted-provider field and Settings executable control are detected.
- [x] **Step 3: Implement provider registration in `createCore`, expose provider in Run read models, display it in Run lists/details, and update Settings/ad-hoc/Watch forms** to use the provider-aware options.
- [x] **Step 4: Update the example config and README** with CLI install/authentication, configured models, repository instruction/skills/MCP differences, tested-version policy, troubleshooting, and an ad-hoc/Watch/cancel/follow-up smoke checklist for each provider.
- [x] **Step 5: Run `npm run check`** and verify type checking, lint, formatting, dependency rules, and all Vitest tests pass.
- [x] **Step 6: Run the targeted provider Settings and Run-history browser tests** and verify the selector, model/executable controls, provider labels, and Run details render correctly.
- [x] **Step 7: Review `git diff --check` and the complete diff** for provider fallback, secret exposure, stale Copilot-only labels, and accidental behavior changes; fix any issues and rerun affected tests.

Final post-review verification: `npm run check` passed (52 files, 637 tests); targeted provider Settings and Run-history e2e tests passed (3 tests); `git diff --check` passed. Follow-up fixes added Codex write access only to the per-Run artifact directory, broadened credential environment filtering, and made missing/resumed Claude session IDs explicit and stable.
