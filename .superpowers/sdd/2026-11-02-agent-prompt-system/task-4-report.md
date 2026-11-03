# Task 4 report: Agent settings

## Status
DONE_WITH_CONCERNS (see Concerns).

## RED
`npm test -- app/actions/agents.test.ts` before `app/actions/agents.ts` existed: the import of `./agents` failed.
Excerpt: `await import('./agents');` -> `Test Files  1 failed (1)  Tests  no tests`.

## GREEN
`npm test -- app/actions/agents.test.ts`: `Test Files  1 passed (1)  Tests  9 passed (9)`.
Full `npm test`: `Test Files  38 passed (38)  Tests  525 passed (525)`.
`npx tsc --noEmit`: no output (clean). `npx next build` succeeded and lists `/settings/agents`.
No lint script exists in package.json.

## Files
- `app/actions/agents.ts`: `saveAgent` (create/update, form), `assignAgent`, `clearRepositoryAgent`, `saveTemplate` (blank clears), `agentDeletionImpact` (read-only, all references), `deleteAgent` (returns cleared references). Zod validation via `parseInput`; `ActionResult`/`FormResult` shapes; unknown Repository -> `UNKNOWN_REPOSITORY`, missing Agent -> `NOT_FOUND`.
- `app/actions/agents.test.ts`: 9 tests (create/update/missing/blank name, assignment validation, clear override, template save/replace/clear, deletion impact, delete -> blocked null slot).
- `app/components/AgentSettings.tsx`: per-Workflow cards (default and per-Repository Agent selects, shared template form), Agent cards with edit form and `ConfirmDialog` delete listing every assigned slot, New Agent form.
- `app/settings/agents/page.tsx`: server page reading real data from `Core.agents` and config Repositories.
- `app/components/Sidebar.tsx`: added "Settings" -> `/settings/agents`.
- `app/globals.css` (not in the task file list): 15 lines, `.agent-grid` auto-fit grid (single column when narrow) and full-width textarea. Everything else reuses existing classes/palette.

## Design decisions
- Agents are workflow-neutral: every select lists all Agents.
- Null slots render as a disabled "No Agent: Runs blocked" option; the UI cannot create a null slot directly, only deletion does (service has no API for it). Repository selects have "Inherit default" (clears the override).
- Deletion confirmation message is built from the assignment list already loaded on the page (same data as `assignmentReferences`); the `agentDeletionImpact` action exposes it for tests/other callers. Confirmation uses the existing native `<dialog>` `ConfirmDialog`.
- Empty Agent instructions are allowed (the seeded defaults are empty); a hint says Runs resolving to them are blocked. Name is required.
- Forms submit via `startTransition` so a failed save keeps entered values (same pattern as `WatchForm`).

## Concerns
- Touching `globals.css` is outside the listed files; kept narrowly scoped.
- Not visually verified in a browser (build + types only), to avoid touching the real `~/.automator` database.
- RED output captured was the truncated tail of the run.

## Follow-up fix: fresh deletion preview

The delete button now calls `agentDeletionImpact` before opening the native confirmation dialog. The dialog message is built from those fresh references, while lookup failures render through `ErrorBox` without opening the dialog. Preparation is disabled and guarded against duplicate requests; existing `ConfirmDialog` callers keep their original flow.

### RED
Added coverage for all assignment slots and the unassigned wording. Before implementation, `npm test -- app/components/AgentSettings.test.ts` failed because `buildAgentDeletionMessage` was not yet exported.

### Validation
- `npm test -- app/actions/agents.test.ts`: 1 file passed, 10 tests passed.
- `npm test`: 39 files passed, 528 tests passed.
- `npx tsc --noEmit`: clean (no output).
- `npx next build`: succeeded; `/settings/agents` included.
- `npx prettier --check app/components/AgentSettings.tsx app/components/ConfirmDialog.tsx app/actions/agents.test.ts app/components/AgentSettings.test.ts`: passed.
- `git diff --check`: passed.

The Next build emitted four Turbopack dynamic-file-pattern warnings from existing `src/core/files/dataDir.ts`, `src/core/config/load.ts`, and `src/core/index.ts`; compilation, type-checking, and build completed successfully.
