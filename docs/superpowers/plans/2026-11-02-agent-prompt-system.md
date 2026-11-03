# Agent Prompt System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tracked prompt files with local SQLite Agents, workflow assignments, and optional shared operation templates.

**Architecture:** Add prompt-profile storage to the existing SQLite database, persist a Workflow type on every Run, and resolve the current Repository assignment before building the prompt. Add a localhost Settings area to manage profiles, and an explicit importer that moves the three selected legacy prompts into the user's local database before the files are removed.

**Tech Stack:** TypeScript, better-sqlite3, Next.js Server Actions, React, Zod, Vitest.

**Spec:** [2026-11-02-agent-prompt-configuration-design.md](../specs/2026-11-02-agent-prompt-configuration-design.md)

## Global Constraints

- Store Agents, assignments, and operation templates in the existing SQLite database under `dataDir`.
- Fixed Automator safety rules remain immutable and higher priority than Agent instructions, templates, Watch instructions, ticket text, and per-Run requests.
- An absent or empty required Agent blocks execution before Copilot starts and reports an actionable error identifying the Repository and Workflow type.
- The import creates the corresponding Agents and assignments for `inspire-mbdp-pages` only: MR Watch, Jira Watch, and Ticket Ad-hoc.
- The import does not import `free.md`.

## Review Focus

- Existing Runs must receive the correct Workflow type during migration; cover Watch, ticket Ad-hoc, and follow-up rows in `src/core/db/db.test.ts`.
- A follow-up must keep its root Workflow type even after its parent is deleted; cover enqueue and parent cleanup in `src/core/queue/queueService.test.ts`.
- A Repository override must win over the default, while an explicitly deleted Agent reference blocks instead of silently falling through; cover in `src/core/agents/agentService.test.ts`.
- Empty or whitespace-only Agent instructions must prevent Copilot launch; cover in `src/core/runs/runExecutor.test.ts`.
- External/task-specific text must not remove fixed safety rules or outrank Agent instructions; cover section order and fixed-rule presence in `src/core/runs/promptBuilder.test.ts`.

---

### Task 1: Persist workflow types and prompt profiles

**Files:**

- Modify: `src/core/db/migrations/index.ts`
- Modify: `src/core/db/rows.ts`
- Modify: `src/core/domain/types.ts`
- Modify: `src/core/db/db.test.ts`

**Interfaces:**

- Produces `WorkflowType = 'mr-watch' | 'jira-watch' | 'free-watch' | 'ticket-adhoc' | 'free-adhoc'`.
- Produces `Run.workflowType`, `Agent { id, name, instructions, createdAt, updatedAt }`, `AgentAssignment { repository: string | null, workflowType, agentId: number | null }`, and `OperationTemplate { workflowType, instructions }`.
- Schema version 4 adds `workflow_type` to `runs`, `agents`, `agent_assignments`, and `operation_templates`. Seed one empty default Agent and default assignment per Workflow type.
- A repository assignment row with `agent_id = NULL` is an explicit blocked override; deleting an override row restores default fallback.

- [ ] **Step 1: Write failing migration tests** for version 4, five empty defaults, uniqueness of default/repository assignment slots, and backfill of existing Watch, ticket Ad-hoc, and follow-up Runs.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- src/core/db/db.test.ts`. Expected: migration/domain assertions fail against schema version 3.
- [ ] **Step 3: Implement the migration and row mapping.** Backfill Watch types from `watches.kind`, root Ad-hoc types from `ticket_key`, and follow-up types from their parent chain.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- src/core/db/db.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/core/db/migrations/index.ts src/core/db/rows.ts src/core/domain/types.ts src/core/db/db.test.ts
git commit -m "feat: persist workflow and agent profiles"
```

### Task 2: Add Agent assignment and template services

**Files:**

- Create: `src/core/agents/agentService.ts`
- Test: `src/core/agents/agentService.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**

- Consumes: `WorkflowType`, `Agent`, `AgentAssignment`, and `OperationTemplate` from Task 1.
- Produces `AgentService.listAgents(): Agent[]`, `listAssignments(): AgentAssignment[]`, `getAgent(id: number): Agent | null`, `createAgent(input: { name: string; instructions: string }): Agent`, `updateAgent(id: number, input: { name: string; instructions: string }): Agent | null`, `assignmentReferences(id: number): AgentAssignment[]`, `deleteAgent(id: number): AgentAssignment[] | null`, `assign(repository: string | null, workflowType: WorkflowType, agentId: number): void`, `clearRepositoryOverride(repository: string, workflowType: WorkflowType): void`, `getTemplate(workflowType: WorkflowType): OperationTemplate | null`, `setTemplate(workflowType: WorkflowType, instructions: string | null): void`, `resolve(repository: string, workflowType: WorkflowType): { agent: Agent | null; template: OperationTemplate | null; assignmentScope: 'repository' | 'default' | 'blocked' }`, and `importLegacyPrompts(repository: string, prompts: Pick<Record<WorkflowType, string>, 'mr-watch' | 'jira-watch' | 'ticket-adhoc'>): 'imported' | 'already-imported'`.
- `resolve` returns the Repository-specific assignment when present, otherwise the installation default; a null Agent in an existing slot returns no Agent and suppresses fallback.

- [ ] **Step 1: Write failing tests** for profile CRUD, assignment reference listing, repository override/default fallback, explicit-null blocking, clearing an override, and optional templates.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- src/core/agents/agentService.test.ts`. Expected: service imports fail.
- [ ] **Step 3: Implement `AgentService`** using transactional SQLite writes and expose it from `Core`.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- src/core/agents/agentService.test.ts src/core/index.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/core/agents src/core/index.ts
git commit -m "feat: manage agent assignments and templates"
```

### Task 3: Resolve workflow types and build prompts from SQLite

**Files:**

- Modify: `src/core/queue/queueService.ts`
- Modify: `src/core/runs/runExecutor.ts`
- Modify: `src/core/runs/promptBuilder.ts`
- Modify: `src/core/runs/promptBuilder.test.ts`
- Modify: `src/core/runs/runExecutor.test.ts`
- Modify: `src/core/queue/queueService.test.ts`

**Interfaces:**

- Consumes: `AgentService.resolve(repository, workflowType)` from Task 2.
- Produces persisted Workflow types for all queue paths; follow-ups copy `parent.workflowType`.
- `buildWatchPrompt` and `buildAdhocPrompt` receive `agentInstructions` and nullable `operationTemplate`; neither reads prompt files.

- [ ] **Step 1: Add failing queue and prompt tests** for all five mappings, follow-up inheritance, fixed-rules/Agent/template/request ordering, and missing/blank Agent behavior.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- src/core/queue/queueService.test.ts src/core/runs/promptBuilder.test.ts src/core/runs/runExecutor.test.ts`.
- [ ] **Step 3: Persist the Workflow type on enqueue, resolve Agent/template before Copilot launch, and pass those layers into prompt builders.** Return a `PROMPT_FAILED` Run error naming the Repository and Workflow type when the resolved Agent is absent or blank.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- src/core/queue/queueService.test.ts src/core/runs/promptBuilder.test.ts src/core/runs/runExecutor.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/core/queue src/core/runs
git commit -m "feat: build run prompts from assigned agents"
```

### Task 4: Manage Agents, assignments, and templates in Settings

**Files:**

- Create: `app/settings/agents/page.tsx`
- Create: `app/actions/agents.ts`
- Create: `app/components/AgentSettings.tsx`
- Test: `app/actions/agents.test.ts`
- Modify: `app/components/Sidebar.tsx`

**Interfaces:**

- Consumes: `Core.agents` from Task 2 and prompt resolution behavior from Task 3.
- Server Actions validate input and return the existing `ActionResult` shape.
- The page exposes profile CRUD, default/repository assignments, and one optional template per Workflow type.

- [ ] **Step 1: Write failing Server Action tests** for create/update, assignment validation, template save, and delete confirmation data containing all affected references.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- app/actions/agents.test.ts`.
- [ ] **Step 3: Implement the Settings UI and actions.** Use the existing form/error patterns and native confirmation dialog; deleting an Agent must clear references to explicit-null slots.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- app/actions/agents.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add app/settings/agents app/actions/agents.ts app/actions/agents.test.ts app/components/AgentSettings.tsx app/components/Sidebar.tsx
git commit -m "feat: add agent settings"
```

### Task 5: Import legacy prompts safely

**Files:**

- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.test.ts`
- Modify: `bin/automator.mjs`
- Modify: `src/core/agents/agentService.ts`

**Interfaces:**

- Adds `automator prompts import-legacy --repo <name> [--source <directory>]`.
- Extends `CliIo` with required `confirm(prompt: string): Promise<boolean>`; update the CLI test helper and have the executable supply a `readline/promises` implementation.
- Import reads only `mr.md`, `jira.md`, and `jira-adhoc.md`, shows the source, SQLite path, and Repository key without printing prompt content, and writes profiles/assignments transactionally.
- Names the imported profiles `<repository> / MR Watch`, `<repository> / Jira Watch`, and `<repository> / Ticket Ad-hoc`.
- Calls `AgentService.importLegacyPrompts` so profile creation, assignments, conflict detection, and the migration marker share one SQLite transaction.
- A migration marker makes successful imports safe to repeat. Conflicting assignments abort without writes.

- [ ] **Step 1: Write failing CLI tests** for preview without confirmation, declined import, missing Repository/source, transactional conflict, repeat import, and successful mappings.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- src/cli/main.test.ts`.
- [ ] **Step 3: Implement the explicit importer** and interactive confirmation; never include legacy prompt contents in source or logs.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- src/cli/main.test.ts src/core/agents/agentService.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/cli/main.ts src/cli/main.test.ts bin/automator.mjs src/core/agents/agentService.ts
git commit -m "feat: import legacy prompts into local agents"
```

### Task 6: Retire tracked prompt files and record the decision

**Files:**

- Modify: `src/core/config/schema.ts`
- Modify: `src/core/config/load.test.ts`
- Modify: `src/core/read-models/formOptions.ts`
- Modify: `src/core/read-models/readModels.test.ts`
- Modify: `app/components/WatchForm.tsx`
- Modify: `automator.config.example.json`
- Create: `docs/adr/0003-local-agent-prompt-configuration.md`
- Delete: `prompts/mr.md`, `prompts/jira.md`, `prompts/jira-adhoc.md`, `prompts/free.md`

**Interfaces:**

- Consumes: the importer from Task 5.
- Removes `prompts.dir`, prompt-file paths from Watch form options, and the tracked prompt directory from runtime behavior.
- Before deleting source files, run the importer against the existing local database; it must display and verify the resolved destination first.

- [ ] **Step 1: Update failing config/read-model tests** to assert that prompt directories are no longer part of runtime configuration or Watch form options.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- src/core/config/load.test.ts src/core/read-models/readModels.test.ts src/core/runs/promptBuilder.test.ts`.
- [ ] **Step 3: Remove file-based prompt configuration and UI references, delete the four tracked prompt files, and add ADR 0003.** First run `npm run automator -- prompts import-legacy --repo inspire-mbdp-pages --source ./prompts`; confirm only after checking the printed database path and Repository key.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- src/core/config/load.test.ts src/core/read-models/readModels.test.ts src/core/runs/promptBuilder.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add -A src/core/config src/core/read-models app/components/WatchForm.tsx automator.config.example.json prompts docs/adr/0003-local-agent-prompt-configuration.md
git commit -m "refactor: remove tracked prompt files"
```
