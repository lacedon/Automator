# Ad-hoc Run Chat, Phase 1 (Follow-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user continue an Ad-hoc run from a Chat tab on the Run detail page: a message on a finished Ad-hoc Run queues a follow-up Run that resumes the same Copilot session.

**Architecture:** Two new nullable columns on `runs` (`session_id`, `parent_run_id`) link Runs into a thread. `QueueService.requestFollowUp` validates and enqueues the follow-up Run through the existing queue. The executor passes `--session-id` to Copilot (new UUID for a root Run, the parent's id for a follow-up). A `thread` read model derives the chat from the chain of Runs, so no message table is needed yet.

**Tech Stack:** TypeScript, Next.js 16 (server actions, React 19 `useActionState`), better-sqlite3, zod, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-adhoc-run-chat-design.md` (phase 1 only; live ACP mode and the `run_messages` table are a separate plan after the `copilot --acp` spike).

## Global Constraints

- Ad-hoc Runs only (`watch_id IS NULL`, `trigger = 'adhoc'`). Watch Runs are unchanged and get no `--session-id`.
- A follow-up Run has the same Repository and model as its parent and `parent_run_id` set; it goes through the existing queue, Repository lock, transcript and outcome code.
- A message is accepted only on the latest finished Ad-hoc Run of a thread, 1 to 20000 characters after trimming.
- No silent fallback: a follow-up whose parent has no `session_id` fails with error code `SESSION_RESUME_FAILED`.
- `ADHOC_RULES` safety text is unchanged in phase 1.
- Code in `app/` imports server code only through `@core/index`; export new types there (`npm run check` runs `depcruise src app`).
- Message text renders as plain text, never HTML or Markdown.
- Commit messages: short imperative sentence, with the trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## Review Focus

- Follow-up on a Run whose Repository was removed from the config: expect `UNKNOWN_REPOSITORY`, no Run created (Task 4).
- Double submit or reply on a Run that already has a follow-up: expect one follow-up only, the second is rejected (Task 4).
- Whitespace-only, empty or over-long message: expect `INVALID_INPUT` on field `message` (Task 4).
- Parent Run deleted while the follow-up exists: the thread still loads, rooted at the follow-up (Task 5).
- Message containing `<b>x</b>` or Markdown: shown literally (Task 8).

---

## File Structure

- Modify `src/core/db/migrations/index.ts`: migration version 3.
- Modify `src/core/domain/types.ts`, `src/core/db/rows.ts`: `Run.sessionId`, `Run.parentRunId`.
- Modify `src/core/runs/copilotLauncher.ts`: optional `sessionId` option.
- Modify `src/core/runs/runExecutor.ts`, `src/core/runs/promptBuilder.ts`: session handling and follow-up prompt.
- Modify `src/core/queue/queueService.ts`: `requestFollowUp`.
- Create `src/core/read-models/thread.ts`; modify `runDetail.ts`, `read-models/index.ts`, `core/index.ts` (exports).
- Create `app/actions/chat.ts`, `app/components/ChatPane.tsx`; modify `app/components/RunTabs.tsx`, `app/runs/[id]/page.tsx`, `app/globals.css`.
- Modify `test/helpers/seed.ts`, `test/e2e/smoke.spec.ts`, `GLOSSARY.md`.

---

### Task 1: Migration and Run fields

**Files:**

- Modify: `src/core/db/migrations/index.ts`, `src/core/domain/types.ts` (`Run`), `src/core/db/rows.ts` (`toRun`)
- Test: `src/core/db/db.test.ts`

**Interfaces:**

- Produces: `Run.sessionId: string | null`, `Run.parentRunId: number | null`; columns `runs.session_id`, `runs.parent_run_id` (`ON DELETE SET NULL`).

- [ ] **Step 1: Write the failing test** in `db.test.ts`, following its existing style: `migration 3 adds session and parent columns` inserts an Ad-hoc Run, then a second with `parent_run_id` = the first, asserts `toRun` returns `sessionId: null` / `parentRunId: <id>`; a second test `deleting a parent Run nulls parent_run_id on the child` deletes the parent and asserts the child's `parent_run_id` is NULL.
- [ ] **Step 2: Run** `npx vitest run src/core/db/db.test.ts`. Expected: FAIL (no such column).
- [ ] **Step 3: Add migration `version: 3`** with `ALTER TABLE runs ADD COLUMN session_id TEXT;`, `ALTER TABLE runs ADD COLUMN parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;` and `CREATE INDEX ix_run_parent ON runs(parent_run_id);`. Add the two fields to `Run` and `toRun`.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run`. Expected: PASS. Update any existing fixture that asserts the full `Run` shape (add the two `null` fields).
- [ ] **Step 5: Commit** `Add session and parent columns to Runs`.

### Task 2: Launcher passes the session id

**Files:**

- Modify: `src/core/runs/copilotLauncher.ts`
- Test: `src/core/runs/copilotLauncher.test.ts`

**Interfaces:**

- Produces: `CopilotLauncher.start` option `sessionId?: string`. When set, args contain `--session-id <sessionId>`; when absent, no such flag (the Teams notifier also calls `start` and must be unaffected).

- [ ] **Step 1: Verify the CLI contract by hand** (a real, cheap call). Run in a scratch dir: `copilot -p "Reply with the word one" --allow-all-tools --no-ask-user --session-id <fresh-uuid> -s`, then `copilot -p "What word did you just reply with?" --allow-all-tools --no-ask-user --session-id <same-uuid> -s`. Expected: the second answer says "one". If it does not, use `--resume <id>` for follow-ups instead and adjust Tasks 2 and 3 (root Runs still use `--session-id`).
- [ ] **Step 2: Write the failing tests** next to the existing launcher tests (they read argv from the fake's record file): `passes --session-id when a sessionId is given` asserts `argv` contains `['--session-id', 'abc-123']` adjacent; `omits --session-id when none is given` asserts `argv` does not include `--session-id`.
- [ ] **Step 3: Run** `npx vitest run src/core/runs/copilotLauncher.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement:** add `sessionId?: string` to the `start` options and spread `['--session-id', opts.sessionId]` into `args` when defined.
- [ ] **Step 5: Run** the same file. Expected: PASS.
- [ ] **Step 6: Commit** `Pass the Copilot session id to the launcher`.

### Task 3: Executor sessions and follow-up prompt

**Files:**

- Modify: `src/core/runs/runExecutor.ts` (`conclude`), `src/core/runs/promptBuilder.ts` (`buildAdhocPrompt`)
- Test: `src/core/runs/runExecutor.test.ts`, `src/core/runs/promptBuilder.test.ts`

**Interfaces:**

- Consumes: `Run.sessionId`, `Run.parentRunId` (Task 1); launcher `sessionId` option (Task 2).
- Produces: before launching an Ad-hoc Run, `runs.session_id` is set (root: `crypto.randomUUID()`; follow-up: the parent's `session_id`) and passed to `launcher.start({ sessionId })`. Watch Runs pass no `sessionId` and keep `session_id` NULL. A follow-up whose parent has no `session_id` concludes via `failure('SESSION_RESUME_FAILED', ...)` before Copilot starts.

- [ ] **Step 1: Write failing executor tests** (use the existing fake-launcher setup in `runExecutor.test.ts`): (a) `ad-hoc Run gets a generated session id, saved before Copilot exits` asserts `launcher.start` received a UUID-shaped `sessionId` and the row's `session_id` equals it; (b) `follow-up Run reuses the parent's session id`; (c) `follow-up Run fails with SESSION_RESUME_FAILED when the parent has no session` asserts `error.code === 'SESSION_RESUME_FAILED'` and the launcher was not called; (d) `Watch Run passes no session id`.
- [ ] **Step 2: Write failing prompt tests:** `follow-up prompt labels the message` asserts the output of `buildAdhocPrompt` for a Run with `parentRunId: 7` and `adhocPrompt: 'Use the staging URL'` contains `## Follow-up message`, the message and the result path, and does not contain `## Request`; `root prompt is unchanged` asserts `## Request` is still present when `parentRunId` is null.
- [ ] **Step 3: Run** `npx vitest run src/core/runs`. Expected: FAIL.
- [ ] **Step 4: Implement** a private `sessionFor(run: Run): string | null` in the executor (returns null only for the missing-parent-session case, called only when `run.watchId === null`) and use it in `conclude` after the prompt is written. In `buildAdhocPrompt`, when `run.parentRunId !== null` use the heading `## Follow-up message` with a first line `This continues the earlier conversation in this session.`
- [ ] **Step 5: Run** `npx vitest run src/core/runs`. Expected: PASS.
- [ ] **Step 6: Commit** `Run follow-up Ad-hoc Runs in the parent's Copilot session`.

### Task 4: Queue a follow-up Run

**Files:**

- Modify: `src/core/queue/queueService.ts`, `src/core/index.ts` (export `MAX_FOLLOW_UP_CHARS`)
- Test: `src/core/queue/queueService.test.ts`

**Interfaces:**

- Consumes: `Run.sessionId` (Task 1).
- Produces: `export const MAX_FOLLOW_UP_CHARS = 20_000;` and `QueueService.requestFollowUp(runId: number, message: string): Result<{ run: Run }>`. `EnqueueAdhocInput` gains `parentRunId?: number`, written to `parent_run_id` by `enqueueAdhoc`. Checks run in one immediate transaction, in this order, with these errors:
  1. no such Run: `NOT_FOUND`
  2. Watch Run: `INVALID_INPUT` field `run`, message `Chat is only available for ad-hoc Runs`
  3. message empty after trim: `INVALID_INPUT` field `message`, `Message is required`; longer than the cap: `Message is too long (max 20000 characters)`
  4. status not `finished`: `INVALID_STATE` with `action: 'followUp'`
  5. a Run with this `parent_run_id` exists: `INVALID_INPUT` field `run`, `Reply on the latest Run in the thread`
  6. `session_id` NULL: `INVALID_INPUT` field `run`, `This Run has no Copilot session to continue`
  7. Repository missing from config: the error from `unknownRepositoryError`
     Success enqueues with the parent's repository and model, `prompt` = trimmed message, no ticket, `parentRunId` = `runId`.

- [ ] **Step 1: Write failing tests** (one per rule above, plus): `queues a follow-up with the parent's repository, model and session link` asserts the new Run is `queued`, `trigger: 'adhoc'`, `parentRunId` set; `a second follow-up on the same Run is rejected` calls twice and asserts only one child row exists; `removed Repository gives UNKNOWN_REPOSITORY and creates no Run`; `message of 20001 characters is rejected, 20000 accepted`.
- [ ] **Step 2: Run** `npx vitest run src/core/queue`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified above; reuse `enqueueAdhoc` for the insert.
- [ ] **Step 4: Run** `npx vitest run src/core/queue`. Expected: PASS.
- [ ] **Step 5: Commit** `Queue follow-up Runs for finished Ad-hoc Runs`.

### Task 5: Thread read model

**Files:**

- Create: `src/core/read-models/thread.ts`
- Modify: `src/core/read-models/runDetail.ts` (`RunDetailView.thread`), `src/core/read-models/index.ts`, `src/core/index.ts` (type exports)
- Test: `src/core/read-models/readModels.test.ts`

**Interfaces:**

- Consumes: `Run.parentRunId`, `Run.sessionId`, `ReadDeps` (`db`, `config`).
- Produces:
  - `type ThreadRun = { id: number; status: RunStatus; outcome: Outcome | null; request: string | null; ticketKey: string | null; summary: string | null; error: RunError | null; queuedAt: number; endedAt: number | null }`
  - `type ThreadView = { runs: ThreadRun[]; replyToRunId: number | null; replyBlockedReason: string | null }`
  - `function runThread(deps: ReadDeps, run: Run): ThreadView | null` (null for Watch Runs). `runs` is ordered root to tip. `replyToRunId` is the tip's id when `requestFollowUp` would accept a message, else null with a short `replyBlockedReason` (`Waiting for Run #N to finish`, `No Copilot session to continue`, `Repository "x" is no longer configured`).
  - `RunDetailView.thread: ThreadView | null`, filled in `runDetail`.

- [ ] **Step 1: Write failing tests:** `Watch Run has no thread`; `thread lists root to tip for any Run in the chain` (open the detail of the root and of the tip, same `runs`); `reply target is the finished tip`; `reply blocked while the tip is queued, with a reason naming the Run`; `thread of a follow-up whose parent was deleted starts at the follow-up`.
- [ ] **Step 2: Run** `npx vitest run src/core/read-models`. Expected: FAIL.
- [ ] **Step 3: Implement** walking up via `parent_run_id` to the root, then down with `SELECT * FROM runs WHERE parent_run_id = ? ORDER BY id LIMIT 1`. Export the two types from `read-models/index.ts` and `core/index.ts` the same way existing view types are.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run src/core/read-models`. Expected: PASS.
- [ ] **Step 5: Commit** `Add the Ad-hoc thread read model`.

### Task 6: Server action

**Files:**

- Create: `app/actions/chat.ts`
- Test: `app/actions/chat.test.ts`

**Interfaces:**

- Consumes: `QueueService.requestFollowUp` (Task 4).
- Produces: `type ChatFormState = { ok: true; value: { runId: number } } | { ok: false; error: AppError; values: { message?: string } } | null` and `sendRunMessage(_prev: ChatFormState, formData: FormData): Promise<ChatFormState>`. Fields: `runId` (positive integer string), `message` (string). Success revalidates `'/'` layout and returns the new Run id; failure echoes `values.message`.

- [ ] **Step 1: Write failing tests** copying the setup of `app/actions/adhoc.test.ts` (mocked `getCore` and `next/cache`): `queues a follow-up and revalidates`; `returns INVALID_INPUT for a non-numeric runId`; `echoes the message when the queue rejects it`.
- [ ] **Step 2: Run** `npx vitest run app/actions/chat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `'use server'`, `parseInput` and a zod schema like `adhoc.ts`.
- [ ] **Step 4: Run** the same file. Expected: PASS.
- [ ] **Step 5: Commit** `Add the send-message action`.

### Task 7: Chat tab

**Files:**

- Create: `app/components/ChatPane.tsx`
- Modify: `app/components/RunTabs.tsx`, `app/runs/[id]/page.tsx`, `app/globals.css`

**Interfaces:**

- Consumes: `ThreadView` (Task 5), `sendRunMessage` (Task 6).
- Produces: `ChatPane({ thread, currentRunId }: { thread: ThreadView; currentRunId: number })` and a `thread: ThreadView | null` prop on `RunTabs`; the **Chat** tab exists only when `thread !== null`. The default tab stays Transcript.

- [ ] **Step 1: Implement `ChatPane`** (client component, `useActionState(sendRunMessage, null)`): per Run, a request bubble (`request`, or the ticket key when `request` is null) and, when `status === 'finished'`, an agent bubble (`summary`, or the error message; outcome shown with the existing `Pill`); a Run with `status` queued or running shows a "queued" or "running" bubble. Each Run header links to `/runs/<id>`. Below the thread, a form with hidden `runId` = `replyToRunId` and a textarea `message`; when `replyToRunId` is null show `replyBlockedReason` instead of the form. Show a rejected submission's error the way `AdhocForm` does and keep the typed message from `values`. All text rendered as React text nodes.
- [ ] **Step 2: Wire it in:** pass `view.thread` from `page.tsx` to `RunTabs`; add the `chat` tab to `RunTabs` when the thread is present. Add small `.chat-*` rules to `globals.css` reusing existing color variables.
- [ ] **Step 3: Verify** `npx tsc --noEmit && npx eslint app && npx prettier --check app`. Expected: no errors. Check the page by eye with the seeded data from Task 8 once that exists.
- [ ] **Step 4: Commit** `Add the Chat tab to Ad-hoc Run details`.

### Task 8: Smoke test, seed and docs

**Files:**

- Modify: `test/helpers/seed.ts`, `test/e2e/smoke.spec.ts`, `GLOSSARY.md`

- [ ] **Step 1: Seed** one finished Ad-hoc Run with `outcome = 'needs-you'`, `session_id = 'seed-session'`, a summary, and an `adhoc_prompt` of `Check <b>the</b> export job` (HTML-looking text on purpose).
- [ ] **Step 2: Write the failing e2e test** `ad-hoc chat: reply queues a follow-up Run` in `smoke.spec.ts`: open the seeded Run, click the **Chat** tab, assert the request text is shown literally (the `<b>` tags visible, no bold element), type `Use the staging URL`, submit, assert a bubble for the new Run shows as queued and the textarea is gone (reply blocked while queued).
- [ ] **Step 3: Run** `npx playwright test -g "ad-hoc chat"`. Expected: PASS after Tasks 1 to 7 (it fails first if run before the UI exists).
- [ ] **Step 4: Docs:** add to `GLOSSARY.md` the term **Follow-up run** ("An Ad-hoc run started by replying in the Chat tab of an earlier Ad-hoc run; it resumes the same Copilot session. Avoid: continuation, reopen") and extend **Ad-hoc run** with one sentence mentioning the chat.
- [ ] **Step 5: Full check** `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** `Test and document the Ad-hoc run chat`.

---

## Out of scope (separate plan after the `copilot --acp` spike)

Live replies while a Run is active, the `run_messages` table, the `runs.liveReplyWaitMs` window, ACP launcher/client, relaxed `ADHOC_RULES`, ADR 0002 update.
