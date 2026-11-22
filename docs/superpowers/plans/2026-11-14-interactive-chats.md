# Interactive Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream every Run's transcript into the Chat as it is written, and add an opt-in **Interactive mode** for Chats. An Interactive Chat keeps one long-lived provider session that can ask the user questions mid-turn and schedule itself to continue later. Follow-up mode and Automation Runs keep their current lifecycle.

**Architecture:** Five independently mergeable PRs. PR 1 adds incremental `transcript.md` writing to the five one-shot launchers and an inline transcript excerpt in the thread read model and ChatPane. PR 2 adds the `chat_sessions` table and a Chat mode selector. Interactive mode stays disabled for every provider because all capability flags start `false`. PR 3 adds a session driver contract next to `ProviderLauncher`, one ACP driver (Copilot, OpenCode, Claude adapter, Codex adapter), a pi RPC driver, and a worker-owned `ChatSessionManager` (process lifetime, per-Chat copies, idle timeout, eviction, lazy restart, recovery). The executor gains an interactive turn path that does not read `copilot-result.json`. PR 3 starts with a provider spike, and its results set the capability flags. PR 4 adds the Automator `ask_user` MCP tool, maps each provider's native questions, and adds the Waiting for you state. PR 5 adds `schedule_wakeup`, which the scheduler fires as `timer` turns, and passes native timers through as `agent` turns. The dashboard and worker stay separate processes that communicate only through SQLite, using request columns that the worker polls, as `cancel_requested_at` does today.

**Tech Stack:** TypeScript, Zod, SQLite migrations (`better-sqlite3`), Next.js Server Components/Actions, newline-delimited JSON-RPC 2.0 (ACP, MCP stdio) and pi RPC JSONL written by hand without new dependencies, Vitest with fake child processes, Playwright smoke tests.

**Spec:** [docs/superpowers/specs/2026-11-14-interactive-chats-design.md](../specs/2026-11-14-interactive-chats-design.md)

## Global Constraints

- The spec's decisions are final. Where the code contradicts the spec, this plan follows the **Spec deviations / clarifications** section below and does not reinterpret the decision.
- Follow-up mode and Automation Runs keep their lifecycle unchanged. The one exception is that the transcript file now grows while the process runs. `result.json`/`copilot-result.json` contracts, `requestFollowUp`, `requestBranch`, `claimNext` rules for non-chat Runs, recovery of non-chat Runs and Teams notifications do not change.
- Every PR can be shipped on its own. In PR 2, Interactive mode is visible but disabled for every provider, and the server rejects it, until PR 3 sets the capability flags.
- Never switch providers or modes implicitly. A failed resume never silently starts a new provider session. Unsupported capabilities fail visibly with `PROVIDER_CAPABILITY_UNSUPPORTED`.
- Provider credentials and configured Git/Jira credentials never reach agent tool subprocesses. Every new process (session drivers, MCP server) is spawned through `childEnv`/`spawnChild` rules in `src/core/runs/childProcess.ts`.
- Live provider processes run only in the worker. The dashboard never spawns or signals them. It writes requests to SQLite: answers, close requests and timer cancels.
- All UI text goes through `next-intl` with keys in `messages/en.json`. Chat text is rendered as React text nodes only (no HTML, no Markdown).
- New config keys are Project-overridable through `src/core/config/overrides.ts` and appear in Settings → Configuration → Runs through `src/core/config/editor.ts`.
- Do not add a runtime dependency unless the PR 3 spike shows a hand-written protocol client is not viable. If one is needed, record why in the ADR.
- Each PR runs its focused Vitest files first, then `npm run check`. Live provider smoke checks are documented in README, not run in CI.
- Do not commit or push unless requested.

## Review Focus

- Follow-up Chats and Automation Runs must produce byte-identical final transcripts and identical result/outcome behaviour. PR 1 pins this in the existing launcher tests, which must stay green unchanged except for the Copilot `--share` path.
- A partial or failed live-transcript write must never fail or hang a Run. PR 1 pins this in `liveTranscript.test.ts`.
- PR 2 must not make Interactive mode reachable through a hand-crafted form post. PR 2 pins this in `queueService.test.ts` and `app/actions/adhoc.test.ts`.
- An Interactive Chat must never run two turns at once, and its unprompted turns must not fork the Chat chain. PR 3 and PR 5 pin this in `queueService.test.ts` and `sessionManager.test.ts`.
- Worker restart must neither delete an open Interactive Chat's copy nor leave a provider process group running. PR 3 pins this in `recovery.test.ts`.
- Closing a Chat whose copy has uncommitted or unpushed work must require explicit confirmation. PR 3 pins this in `copyStatus.test.ts` and `app/actions/chat.test.ts`.
- An answer that races the question timeout must either resolve in-turn or start exactly one `answer` turn, never both and never neither. PR 4 pins this in `questions.test.ts`.
- `schedule_wakeup` rules must hold: one timer, a 1-minute minimum, working hours, survival across restart, and cancellation on close. PR 5 pins these in `chatTools.test.ts` and `scheduler.test.ts`.
- Tool-permission requests are answered by policy and never shown to the user. PR 3 pins this in the driver tests.

---

## Spec deviations / clarifications

Each item states what the code does today, what the spec assumes, and what this plan does. None of them changes a spec decision. Each one makes a decision executable.

1. **There is no `done` Outcome.** `Outcome` is `'nothing' | 'acted' | 'needs-you'` (`src/core/domain/types.ts`, `runs.outcome` CHECK). The existing "Done" pill in `app/components/Pill.tsx` means `closedAt !== null`, not an outcome. Plan: PR 3's `runs` rebuild adds `'done'` to the outcome CHECK and `Outcome` union. The new outcome uses the `good` pill variant, and its label key is `Pill.outcomeDone`, rendered **"Replied"** (confirmed by the user, 2026-11-14) so it is never confused with the closed "Done" pill. The public `GET /api/runs/{id}` can now return `"outcome": "done"`, and README documents this.
2. **"Interactive turns do not use `result.json`."** Today two files exist. `copilot-result.json` is written by the agent and parsed by `RunExecutor.evaluate`. `result.json` (`ResultFileV1`) is written by Automator in `finalizeRun` for every Run. Plan: interactive turns never ask for or read `copilot-result.json`. `finalizeRun` still writes Automator's own `result.json` so the Run page, file route and API behave the same for both modes.
3. **There is no general "close Chat" today.** `QueueService.closeRun` only marks a finished Needs-you/Error tip as Done (`canClose` in `ChatPane.tsx`). Plan: PR 3 adds a separate **Close chat** action for Interactive Chats only. It is available when no turn of the Chat is queued or running, whatever the tip's outcome, and it sets `chat_sessions.close_requested_at`. The worker then stops the process, deletes the copy and sets `closed_at`, and from PR 5 it also cancels the timer. A closed Interactive Chat blocks replies ("This chat is closed"). Branching from it is still allowed. The existing per-Run `closeRun`/`canClose` stays unchanged for both modes, so Waiting for you does not affect `canClose`, as the spec requires.
4. **Orphaned copies "as today".** `recoverInterruptedRuns` calls `dataDir.clearWorkspaces()`, which deletes all of `<dataDir>/workspaces/`. That would destroy every live Interactive Chat copy, and the spec's lazy restart needs those copies. Plan: per-Chat copies live under `<dataDir>/chat-workspaces/<sessionId>/<folder basename>`. Recovery still clears `workspaces/` (per-Run copies) and also removes `chat-workspaces/<id>` entries whose session is closed, has a close request (the close is finalized), or has no row.
5. **`runs.maxConcurrent` only applies under `runs.isolation: "copy"` today.** An interactive turn is claimed with `isolation = 'copy'` (it works in a copy). Existing `claimNext` rules therefore apply unchanged. The turn counts against `maxConcurrent` for its checkout and waits while a `shared` Run of that checkout is running. A queued `shared` Run waits while any Run of the checkout is running, interactive turns included. That is today's rule for mixed isolation, kept as is. Idle live sessions hold no slot.
6. **`runs.maxInteractiveSessions` is "global, Project-overridable".** Plan: the limit counts all live session processes installation-wide. Starting or keeping a process for a Chat in Repository R uses R's effective value. If the live process count is already at or above that value, the least-recently-used **idle** process is stopped, whatever its Project. Busy processes are never evicted, so the limit can be exceeded temporarily while every live session is mid-turn. The next idle transition then evicts.
7. **The idle timeout key is not named in the spec.** Plan: `runs.interactiveIdleMinutes`, a positive integer, default `30`, Project-overridable, editable in Settings.
8. **`runs.questionWaitMs` is named in milliseconds.** Existing Run durations are configured as `timeoutMinutes` and transformed to `timeoutMs`. Plan: the JSON key is literally `runs.questionWaitMs` (a positive integer in ms, default `600000`), as the spec names it. The Project override field `runs/questionWaitMs` accepts a duration string (`10m`, parsed with `parseDuration`) and displays one with `formatDuration`.
9. **Settings shows only `runs` keys already in the config file.** `projectConfig` in `src/core/config/editor.ts` picks `runs` keys from the raw file, so a new key with a default would not appear in Settings. Plan: the editor fills `questionWaitMs`, `maxInteractiveSessions` and `interactiveIdleMinutes` from parsed defaults when they are absent, as it already does for `providers`.
10. **Copilot `--share` overwrites the transcript on exit.** It also may include the full prompt (this is checked in PR 1). Plan: during the Run, Copilot's stdout is appended to `transcript.md`. `--share` targets a sidecar, `<transcriptPath>.share.md`. On exit the sidecar is renamed over `transcript.md`, so the final file matches today's. If the sidecar is missing, the stdout transcript stays. If the PR 1 check shows the share export starts with the user prompt, the bubble excerpt helper drops the leading prompt section when rendering. That happens at render time only, and the file is unchanged.
11. **Streaming granularity of one-shot launchers.** Claude `stream-json` (without `--include-partial-messages`), Codex `--json` and pi `--mode json` emit whole messages, not token deltas. PR 1 streams at message granularity for those launchers and leaves their CLI arguments unchanged, to avoid touching the Follow-up lifecycle. Token-level streaming exists only in Interactive mode (driver text deltas).
12. **The tool policy is Copilot-pattern based.** Agent tool settings and `runs.denyTools` use Copilot patterns. Today Claude Code, Codex and OpenCode fail with `PROVIDER_CAPABILITY_UNSUPPORTED` when `runs.denyTools` is set, and every non-Copilot provider fails for an Agent with custom tool settings. Plan: Interactive mode keeps exactly these rules. ACP `session/request_permission` is answered `allow` under `allowAll` (and pi has none). Copilot ACP receives the same `--allow-tool`/`--deny-tool` flags at server start, because Copilot fixes tool filtering at server start. Mapping patterns for other providers is out of scope.
13. **pi has no MCP client.** Automator's `ask_user`/`schedule_wakeup` reach pi through a bundled pi extension loaded with `--extension`. The extension calls the same core tool implementation through a hidden CLI subcommand (`automator chat-tool <name>`). ACP providers get the tools as an Automator stdio MCP server passed in `session/new`/`session/load` `mcpServers`.
14. **Branching an Interactive Chat.** `requestBranch` builds a text context from summaries. Plan: the branch creates a **new** `chat_sessions` row with a fresh provider session and a fresh copy taken from the Repository folder. The original Chat's uncommitted copy work is not carried over (confirmed by the user, 2026-11-14). The UI hint says so.
15. **Unprompted (`agent`) turns cannot wait in the queue.** A native timer firing inside the live process is already running when Automator sees it. Plan: the session manager inserts the `agent` Run directly as `running` and hands it to the executor's watchdog/finalize path, without passing through `claimNext` or `maxConcurrent`. If a queued turn already hangs off the Chat tip, it is re-parented onto the new `agent` Run in the same transaction, so `runThread` stays a single chain.
16. **Ad-hoc CLI and HTTP API.** `automator run` and `POST /api/runs` keep creating Follow-up Chats. Selecting the mode is dashboard-only in this work (confirmed by the user, 2026-11-14).
17. **ADR numbering.** The new ADR is `docs/adr/0006-interactive-provider-sessions.md` (0005 is the highest existing ADR, verified 2026-11-14).

---

## PR 1: Live transcript and inline bubbles

**Scope:** All five launchers (`copilot`, `claude-code`, `codex`, `opencode`, `pi`) append to `transcript.md` while the process runs. The thread read model exposes a per-Run transcript excerpt. ChatPane shows the excerpt inline as plain text for queued, running and finished Runs, and keeps auto-refreshing while any Run is unfinished. Automation Run pages benefit through the same ChatPane path. README drops the "no live streaming" statements.

**Out of scope:** SSE or websockets (the existing 3 s `AutoRefresh` stays). Markdown rendering. Token-level streaming for message-granular CLIs (clarification 11). Any change to result files, outcomes, timeouts or recovery. Chat modes.

**Files:**

- Create: `src/core/runs/liveTranscript.ts`
- Create: `src/core/runs/liveTranscript.test.ts`
- Modify: `src/core/runs/copilotLauncher.ts`, `src/core/runs/claudeCodeLauncher.ts`, `src/core/runs/codexLauncher.ts`, `src/core/runs/opencodeLauncher.ts`, `src/core/runs/piLauncher.ts`
- Modify tests: `src/core/runs/copilotLauncher.test.ts`, `src/core/runs/claudeCodeLauncher.test.ts`, `src/core/runs/codexLauncher.test.ts`, `src/core/runs/opencodeLauncher.test.ts`, `src/core/runs/piLauncher.test.ts`
- Modify fixtures: `test/fixtures/fake-claude.mjs` and the fake CLIs used by the other launcher tests (`test/fixtures/fake-*.mjs`). Each gains a `stream-wait` mode.
- Create: `src/core/read-models/transcriptExcerpt.ts`
- Modify: `src/core/read-models/thread.ts`, `src/core/read-models/runDetail.ts`, `src/core/read-models/index.ts` (export the new types)
- Modify test: `src/core/read-models/readModels.test.ts`
- Create: `app/lib/chatBubble.ts`, `app/lib/chatBubble.test.ts`
- Modify: `app/components/ChatPane.tsx`, `app/runs/[id]/page.tsx` (remove its local `singleRunThread` in favour of the core one), `app/globals.css`, `messages/en.json`
- Modify: `test/e2e/smoke.spec.ts` (one live-transcript scenario)
- Modify: `README.md` ("History and result files" and "Out of scope for v1")

**Interfaces:**

```ts
// src/core/runs/liveTranscript.ts
export interface LiveTranscript {
  // Appends one text part; parts after the first are preceded by the separator so the live file equals
  // the launcher's final `parts.join(separator)`. Never throws: the first write error is kept in `failed`
  // and later appends are skipped.
  append(text: string): void;
  // Atomically replaces the file with the launcher's final normalized transcript (today's behaviour).
  finish(finalText: string | null): void;
  readonly failed: Error | null;
}
export function createLiveTranscript(file: string, options?: { separator?: string }): LiveTranscript;

// Splits a byte stream into complete UTF-8 lines (StringDecoder; keeps a partial trailing line).
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void };

// src/core/read-models/transcriptExcerpt.ts
export const TRANSCRIPT_EXCERPT_BYTES = 64 * 1024;
export type TranscriptExcerpt = { text: string; truncated: boolean };
// Reads the last `maxBytes` of the file synchronously, dropping a split leading UTF-8 sequence; null if absent/empty.
export function readTranscriptExcerpt(file: string, maxBytes?: number): TranscriptExcerpt | null;

// src/core/read-models/thread.ts
export type ThreadRun = {
  /* existing fields */
  trigger: Trigger;
  transcript: TranscriptExcerpt | null;
};
export function singleRunThread(deps: ReadDeps, run: Run): ThreadView; // moved from app/runs/[id]/page.tsx

// src/core/read-models/runDetail.ts
export type RunDetailView = { /* existing */ chat: ThreadView }; // runThread(...) ?? singleRunThread(...)

// app/lib/chatBubble.ts (pure, unit-tested)
export function bubbleTranscript(run: Pick<ThreadRun, 'transcript'>, provider?: ProviderName): string | null;
```

Each JSON launcher refactors its per-line extraction into a function shared by the live path and the existing final `normalize*` function. An example is `claudeEvent(value: JsonRecord): { text?: string; sessionId?: string }`. The final transcript is still produced by `normalize*` on the full stdout buffer and written with `finish()`.

**Tasks:**

- [ ] **Step 1: Write `liveTranscript.test.ts`.** Cover `append makes text visible before finish`, `parts are joined with the separator exactly like the final transcript`, `lineSplitter handles lines split across chunks and split multibyte characters`, `a write failure is recorded and never thrown` (target a path inside a file, so `mkdir` fails), and `finish replaces the live file atomically`.
- [ ] **Step 2:** Run `npx vitest run src/core/runs/liveTranscript.test.ts` and confirm the tests fail.
- [ ] **Step 3: Implement `liveTranscript.ts`.** Use `fs.appendFileSync` for appends, and use `writeTextAtomic` from `src/core/files/atomic.ts` for `finish`.
- [ ] **Step 4: Copilot spike (30 min, recorded in the PR description).** Run the configured Copilot CLI with today's flags in a scratch repo. Record whether stdout streams progressively under `-p --no-color --log-level error`, whether it is plain text, and whether the `--share` export includes the prompt. If Copilot offers a structured stdout mode, note it but do not adopt it in this PR, so the Copilot argument list stays as compatible as possible.
- [ ] **Step 5: Write launcher tests.** In each of the five launcher tests, add `writes the transcript while the provider is still running`. The fake runs in `stream-wait` mode: it emits the first event, waits for the file named by `FAKE_*_RELEASE`, then emits the rest and exits. The test polls `transcriptPath` until it contains the first text, creates the release file, awaits `exited`, and asserts the final file equals today's normalized transcript. In `copilotLauncher.test.ts`, update `Copilot invocation remains compatible` so it expects `--share <transcriptPath>.share.md`. Add `share export replaces the live stdout transcript on exit` and `stdout transcript is kept when the share export is missing`.
- [ ] **Step 6:** Run `npx vitest run src/core/runs/copilotLauncher.test.ts src/core/runs/claudeCodeLauncher.test.ts src/core/runs/codexLauncher.test.ts src/core/runs/opencodeLauncher.test.ts src/core/runs/piLauncher.test.ts` and confirm the new tests fail while every existing test still passes.
- [ ] **Step 7: Implement live writing in each launcher.**
  - Pass `onStdout: (chunk) => { stdout.push(chunk); splitter.push(chunk); }`. Each complete line goes through the shared extractor, and extracted text goes to `live.append`.
  - On exit, call `splitter.end()`, then `live.finish(normalized.transcript || null)`. This replaces the current `writeTextAtomic` call.
  - Copilot appends ANSI-stripped stdout chunks. On exit it renames `<transcriptPath>.share.md` over `transcriptPath` if the sidecar exists.
  - Error mapping, session detection and exit handling stay unchanged.
- [ ] **Step 8:** Rerun the Step 6 command and confirm everything passes.
- [ ] **Step 9: Write read-model tests in `readModels.test.ts`.** Cover `thread runs expose the live transcript of a running Run` (the file is at `dataDir.transcriptPath(id)` while `transcript_path` is still NULL), `finished Runs use the recorded transcript path`, `the excerpt keeps the tail and marks truncation`, `a Run without a transcript has a null excerpt`, and `automation Run detail returns a single-run chat with its transcript`.
- [ ] **Step 10:** Run `npx vitest run src/core/read-models/readModels.test.ts` and confirm the tests fail.
- [ ] **Step 11: Implement `transcriptExcerpt.ts`, `ThreadRun.trigger/transcript`, the core `singleRunThread`, and `RunDetailView.chat`.** `ReadDeps` already carries `dataDir`.
- [ ] **Step 12: Write `app/lib/chatBubble.test.ts`.** Cover `bubble shows transcript text as-is` and `the Copilot share prompt section is dropped only when present`, based on the Step 4 findings. If Step 4 shows no prompt in the export, the second test asserts pass-through.
- [ ] **Step 13: Implement `chatBubble.ts` and update ChatPane `RunExchange`.**
  - Queued Runs keep the muted status bubble.
  - Running Runs show the running pill, then the excerpt in `<div className="chat-transcript">`.
  - Finished Runs show the pill, the excerpt, then the summary or error as today.
  - A truncated excerpt shows `Chat.transcriptTruncated` next to the existing `RunFileLinks`.
  - Add `.chat-transcript { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 60vh; overflow: auto; }` to `app/globals.css`.
  - `app/runs/[id]/page.tsx` passes `view.chat`. `keepsRefreshing` stays unchanged: it already refreshes while any Run is unfinished, and `app/lib/autoRefresh.test.ts` already pins that.
- [ ] **Step 14: Add the e2e scenario `chat shows a running Run's transcript inline`** to `test/e2e/smoke.spec.ts`, using the suite's seeded-data approach: a running ad-hoc Run plus a transcript file.
- [ ] **Step 15: Update README.** Replace "v1 only shows a transcript after the Run finishes. There's no live streaming." with the live-transcript behaviour, and remove "Live streaming of transcripts" from "Out of scope for v1".
- [ ] **Step 16: Verify.** Run `npx vitest run src/core/runs src/core/read-models app/lib`, then `npm run check`, then `npm run e2e -- --grep "transcript"`.

**Acceptance criteria:**

- For each provider, `transcript.md` grows while the fake provider is still running, and the final file is byte-identical to the pre-PR output. For Copilot, it is identical to the `--share` export.
- The Chat page and Automation Run page show the transcript text inline while a Run is running and after it finishes, as plain text, refreshed every 3 s.
- No result, outcome, timeout, cancellation or recovery test changes.

**Risks / spikes:**

- Copilot stdout format (Step 4). If stdout is buffered until exit, the live transcript for Copilot only appears at exit. Record this in README as a known limitation. Do not change the Copilot flags in this PR, because Copilot gets real streaming through ACP in PR 3.
- Reading up to 64 KiB per thread Run on every 3 s refresh. The read is capped and tail-only. If profiling shows a problem, cap the excerpt to the last 10 Runs of a thread.

---

## PR 2: Chat mode

**Scope:** Add the `chat_sessions` table and `runs.chat_session_id`. Add a Chat mode selector to the new-chat form: Follow-up is the default, and Interactive is disabled per provider capability with a tooltip. Mode is fixed for the Chat and inherited on branch. Add capability flags, which are all `false` in this PR. Add Glossary entries and the new ADR.

**Out of scope:** Executing Interactive turns. Session processes. Copies. Questions. Timers. CLI/API mode selection (clarification 16).

**Files:**

- Modify: `src/core/db/migrations/index.ts` (version 27), `src/core/db/rows.ts` (`toRun.chatSessionId`, new `toChatSession`)
- Modify: `src/core/domain/types.ts` (`ChatMode`, `ChatSession`, `Run.chatSessionId`)
- Create: `src/core/chats/capabilities.ts`, `src/core/chats/chatSessionService.ts`, `src/core/chats/chatSessionService.test.ts`
- Modify: `src/core/queue/queueService.ts` (`AdhocRequest.mode`, `requestAdhoc`, `requestBranch`, `requestFollowUp` guard)
- Modify: `src/core/runs/runExecutor.ts` (defensive guard)
- Modify: `src/core/read-models/formOptions.ts` (`interactive` capability per provider), `src/core/read-models/thread.ts` (`ThreadView.chat`)
- Modify: `src/core/index.ts` (exports, `core.chats`)
- Modify: `app/actions/adhoc.ts`, `app/components/AdhocForm.tsx`, `app/components/ChatPane.tsx` (mode label), `messages/en.json`
- Modify tests: `src/core/db/db.test.ts`, `src/core/queue/queueService.test.ts`, `src/core/read-models/readModels.test.ts`, `src/core/runs/runExecutor.test.ts`, `app/actions/adhoc.test.ts`, `app/actions/chat.test.ts`
- Modify: `GLOSSARY.md`
- Create: `docs/adr/<next>-interactive-provider-sessions.md` (clarification 17)

**Schema (migration 27):**

```sql
CREATE TABLE chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Only 'interactive' rows are written: a Run with chat_session_id IS NULL is a Follow-up Chat Run.
  mode TEXT NOT NULL CHECK (mode IN ('follow-up', 'interactive')),
  repository TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('copilot', 'claude-code', 'codex', 'opencode', 'pi')),
  model TEXT NOT NULL,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  provider_session_id TEXT,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  close_requested_at INTEGER,
  closed_at INTEGER
);
ALTER TABLE runs ADD COLUMN chat_session_id INTEGER REFERENCES chat_sessions(id);
CREATE INDEX ix_run_chat_session ON runs(chat_session_id);
```

Follow-up Chats get no row (the spec leaves this to the plan), so Follow-up behaviour cannot change. Sessions are never deleted while a Run still references them. `deleteAdhoc` of the last Run of an Interactive Chat sets `close_requested_at`, which takes effect in PR 3.

**Interfaces:**

```ts
// src/core/domain/types.ts
export type ChatMode = 'follow-up' | 'interactive';
export interface ChatSession {
  id: number;
  mode: 'interactive';
  repository: string;
  provider: ProviderName;
  model: string;
  agentId: number | null;
  providerSessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  closeRequestedAt: number | null;
  closedAt: number | null;
}
// Run gains: chatSessionId: number | null;

// src/core/chats/capabilities.ts
export type InteractiveCapabilities = {
  interactive: boolean; // gates Interactive mode (all false in PR 2)
  protocol: 'acp' | 'pi-rpc';
  resume: boolean; // provider session can be reloaded by id
  automatorTools: 'mcp' | 'pi-extension' | 'none';
  nativeQuestions: 'acp-elicitation' | 'pi-extension-ui' | 'none';
  nativeTimers: boolean; // unprompted turns may occur
  reason: string | null; // tooltip text when interactive is false
};
export const INTERACTIVE_CAPABILITIES: Record<ProviderName, InteractiveCapabilities>;
export function interactiveSupport(provider: ProviderName): { supported: boolean; reason: string | null };

// src/core/chats/chatSessionService.ts
export class ChatSessionService {
  constructor(db: Database, clock: Clock);
  create(input: { repository: string; provider: ProviderName; model: string; agentId: number | null }): ChatSession; // inside caller's tx
  get(id: number): ChatSession | null;
  forRun(runId: number): ChatSession | null;
  modeOfRun(runId: number): ChatMode;
}

// src/core/queue/queueService.ts
export interface AdhocRequest {
  /* existing */ mode?: ChatMode;
} // default 'follow-up'
export interface EnqueueAdhocInput {
  /* existing */ chatSessionId?: number;
}

// src/core/read-models/thread.ts
export type ThreadView = { /* existing */ chat: { mode: ChatMode; sessionId: number | null } };

// src/core/read-models/formOptions.ts
export type RepositorySettings = { /* existing */ interactive: { supported: boolean; reason: string | null } };
```

**Tasks:**

- [ ] **Step 1: Write the migration test in `db.test.ts`.** `migration 27 adds chat_sessions and leaves existing Runs as Follow-up`: migrate from version 26 with a seeded Run, assert `chat_session_id IS NULL`, and assert that `toRun` maps `chatSessionId: null`. Add `chat session rows round-trip`.
- [ ] **Step 2:** Run `npx vitest run src/core/db/db.test.ts` and confirm the tests fail.
- [ ] **Step 3: Implement migration 27, `toRun.chatSessionId`, `toChatSession`, and `ChatSessionService`.**
- [ ] **Step 4: Write queue tests.**
  - `requestAdhoc defaults to Follow-up and creates no chat session`.
  - `requestAdhoc rejects Interactive mode for an unsupported provider`: `INVALID_INPUT` on field `mode`, no Run is queued and no session is created.
  - `requestAdhoc in Interactive mode creates a session and links the first Run`, with the capability stubbed to supported through an injected `QueueDeps.interactiveSupport`.
  - `branching an Interactive Chat creates a new Interactive session with the same provider/model/agent`.
  - `branching a Follow-up Chat stays Follow-up`.
  - `requestFollowUp is unchanged for Follow-up Chats`. Existing tests cover most of this. Add one assertion that `chat_session_id` stays NULL.
- [ ] **Step 5:** Run `npx vitest run src/core/queue/queueService.test.ts` and confirm the tests fail.
- [ ] **Step 6: Implement mode handling in `QueueService`.**
  - Add `QueueDeps.interactiveSupport?: (provider) => {supported; reason}`, defaulting to `interactiveSupport` from `capabilities.ts`.
  - In Interactive mode, `requestAdhoc` creates the session and the Run in the same `.immediate()` transaction.
  - `requestBranch` copies the mode. A new session is created when the source Run has `chat_session_id`.
  - `enqueueAdhoc` writes `chat_session_id`.
  - In PR 2, `requestFollowUp` returns `INVALID_STATE` with message `Interactive Chats are not available yet` for Interactive Chats. This is unreachable in practice because creation is rejected.
- [ ] **Step 7: Write the executor guard test in `runExecutor.test.ts`.** `a Run of an Interactive Chat fails with PROVIDER_CAPABILITY_UNSUPPORTED while the provider is unsupported`: seed the row directly, assert no launcher was started, and assert the error is recorded.
- [ ] **Step 8: Implement the guard** at the start of `RunExecutor.conclude`, after `ensureRunDir`.
- [ ] **Step 9: Write read-model and action tests.**
  - In `readModels.test.ts`, add `form options expose interactive support per Repository provider` and `thread view reports the chat mode`.
  - In `app/actions/adhoc.test.ts`, add `queueAdhoc passes the selected mode and rejects unknown modes`.
  - In `app/actions/chat.test.ts`, add `branchRun keeps the mode`.
- [ ] **Step 10:** Run `npx vitest run src/core/read-models/readModels.test.ts app/actions/adhoc.test.ts app/actions/chat.test.ts` and confirm the tests fail.
- [ ] **Step 11: Implement the form options, the `adhocSchema.mode` field (`z.enum(['follow-up','interactive']).default('follow-up')`, with `mode` added to `FORM_FIELDS`), and the `AdhocForm` selector.**
  - The selector is a `<select id="ah-mode" name="mode">`. Its Interactive `<option>` is `disabled` with `title={settings.interactive.reason}` when unsupported, and a hint below it explains why.
  - The selector resets to Follow-up when switching to a Repository whose provider is unsupported.
  - ChatPane shows a muted `Chat.mode` label (Follow-up / Interactive) above the thread.
  - New `messages/en.json` keys: `Adhoc.mode`, `Adhoc.modeFollowUp`, `Adhoc.modeInteractive`, `Adhoc.modeInteractiveUnavailable`, `Chat.modeFollowUp`, `Chat.modeInteractive`.
- [ ] **Step 12: Update `GLOSSARY.md`.**
  - Add **Chat mode**, **Follow-up mode**, **Interactive mode**, **Chat session**, and **Waiting for you** (a Chat-session state, distinct from Needs you).
  - Update **Chat** to cover both modes and per-turn Runs.
  - Keep **Follow-up run** as it is.
- [ ] **Step 13: Write the ADR "Interactive provider sessions".** It covers long-lived per-Chat processes in per-Chat copies, amends ADR 0001 for Interactive Chats (they never use the shared checkout), records ACP as the common protocol with a pi RPC driver, and records Automator-owned questions and timers alongside native ones. Under Consequences, record SQLite as the dashboard→worker channel, the `chat-workspaces/` location, and the capability gating. Add the ADR to README's "See also".
- [ ] **Step 14: Verify.** Run `npx vitest run src/core/db src/core/chats src/core/queue src/core/runs/runExecutor.test.ts src/core/read-models app/actions`, then `npm run check`.

**Acceptance criteria:**

- A new Chat defaults to Follow-up and behaves exactly as before.
- The Interactive option is visible and disabled for all providers, with a tooltip. Posting `mode=interactive` is rejected with a field error and creates nothing.
- Branching keeps the mode. Glossary and ADR are updated.

**Risks:** None at runtime, because the mode cannot be selected yet. Migration 27 uses `ALTER TABLE ... ADD COLUMN ... REFERENCES`, which SQLite allows with a NULL default. `db.test.ts` checks the foreign-key pragma.

---

## PR 3: Interactive runtime

**Scope:**

- Provider spike, then capability flags.
- Session driver contract. Hand-written JSON-RPC framing. ACP driver (Copilot `copilot --acp`, OpenCode `opencode acp`, Claude via `claude-agent-acp`, Codex via `codex-acp`). pi RPC driver (`pi --mode rpc`).
- Tool policy enforcement (clarification 12).
- `ChatSessionManager`: one process per Chat, per-Chat copy, idle timeout, `runs.maxInteractiveSessions` LRU eviction, lazy restart by provider session id, close requests, stop-all on shutdown.
- Executor turn path without `copilot-result.json` (outcome `done`, summary = last agent message).
- Trigger values `answer`, `timer` and `agent` in the schema.
- Recovery.
- Close chat with a work warning.
- Interactive prompt.
- Enabling Interactive mode for providers that pass the spike.

**Out of scope:** `ask_user` and native questions (PR 4). If a native question arrives in PR 3, the driver answers it with a cancel/decline response and logs it. `schedule_wakeup`. Creating `agent` Runs for unprompted turns: PR 3 drivers emit the event, and the manager only logs it until PR 5. Notifications. Markdown.

**Files:**

- Create: `docs/superpowers/specs/2026-11-14-interactive-chats-provider-spike.md` (spike results)
- Create: `src/core/chats/drivers/sessionDriver.ts`, `src/core/chats/drivers/jsonRpc.ts`, `src/core/chats/drivers/acpDriver.ts`, `src/core/chats/drivers/piRpcDriver.ts`, `src/core/chats/drivers/toolPolicy.ts`
- Create: `src/core/chats/sessionManager.ts`, `src/core/chats/interactiveTurn.ts`, `src/core/chats/copyStatus.ts`
- Create tests: `src/core/chats/drivers/jsonRpc.test.ts`, `src/core/chats/drivers/acpDriver.test.ts`, `src/core/chats/drivers/piRpcDriver.test.ts`, `src/core/chats/drivers/toolPolicy.test.ts`, `src/core/chats/sessionManager.test.ts`, `src/core/chats/copyStatus.test.ts`
- Create fixtures: `test/fixtures/fake-acp-agent.mjs`, `test/fixtures/fake-pi-rpc.mjs`. Both are scriptable through an env-provided JSON script, and both record argv, cwd, env and received messages.
- Modify: `src/core/chats/capabilities.ts` (flags from the spike), `src/core/chats/chatSessionService.ts`
- Modify: `src/core/db/migrations/index.ts` (version 28), `src/core/db/rows.ts`, `src/core/domain/types.ts`
- Modify: `src/core/config/schema.ts`, `src/core/config/overrides.ts`, `src/core/config/editor.ts`, `src/core/config/providers.ts` (ACP bins), `automator.config.example.json`
- Modify: `src/core/files/dataDir.ts` (`chatWorkspacePath`, `removeChatWorkspace`, `chatWorkspaceIds`, `chatSessionLogPath`)
- Modify: `src/core/runs/runExecutor.ts` (interactive branch, `Active` adapter, `killActive`), `src/core/runs/recovery.ts`, `src/core/runs/promptBuilder.ts` (`buildInteractivePrompt`)
- Modify: `src/core/queue/queueService.ts` (`requestFollowUp` for Interactive, claim guard, `requestCloseChat`, `deleteAdhoc` close request)
- Modify: `src/core/read-models/thread.ts` (`chat.state`, reply block reasons, display of new triggers), `src/core/read-models/runs.ts` (trigger filter values)
- Modify: `src/core/index.ts` (`sessionDrivers`, `chatSessions` manager, executor deps), `src/worker/loop.ts` (tick and stop), `src/worker/main.ts` (forced exit kills sessions)
- Modify: `app/actions/chat.ts` (`closeChat`), `app/components/ChatPane.tsx` (Close chat with warning, session state line), `app/components/Pill.tsx` (`done` outcome), `app/components/RunsTable.tsx` and the Runs filter (new trigger/outcome labels), `messages/en.json`
- Modify tests: `src/core/db/db.test.ts`, `src/core/config/load.test.ts`, `src/core/config/editor.test.ts`, `src/core/config/resolver.test.ts`, `src/core/runs/runExecutor.test.ts`, `src/core/runs/recovery.test.ts`, `src/core/runs/promptBuilder.test.ts`, `src/core/queue/queueService.test.ts`, `src/core/read-models/readModels.test.ts`, `src/worker/loop.test.ts`, `app/actions/chat.test.ts`, `test/e2e/smoke.spec.ts`
- Modify: `README.md` (Interactive Chats section, provider table rows for ACP adapters, smoke checklist), `GLOSSARY.md` (Trigger values if listed)

**Schema (migration 28, `rebuildsTables: true`):**

- Rebuild `runs` with the version 26 column list plus `chat_session_id INTEGER REFERENCES chat_sessions(id)`. Change `trigger CHECK (trigger IN ('schedule','manual','adhoc','answer','timer','agent'))` and `outcome CHECK (outcome IN ('nothing','acted','needs-you','done'))`. Recreate `ux_run_queued_per_watch`, `ix_run_queue`, `ix_run_parent`, `ix_run_chat_session` and the `runs_default_owner` trigger, and preserve `sqlite_sequence` exactly as migration 26 does.
- `ALTER TABLE chat_sessions ADD COLUMN process_state TEXT NOT NULL DEFAULT 'stopped' CHECK (process_state IN ('stopped','starting','idle','busy'));`
- `ALTER TABLE chat_sessions ADD COLUMN pid INTEGER;`
- `ALTER TABLE chat_sessions ADD COLUMN copy_path TEXT;`

**Config keys:**

| Key                               | Type / default                  | Project override field                 | Settings                                                 |
| --------------------------------- | ------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| `runs.maxInteractiveSessions`     | positive int, `3`               | `runs/maxInteractiveSessions` (number) | Runs fieldset; default filled in when absent (clarif. 9) |
| `runs.interactiveIdleMinutes`     | positive int, `30`              | `runs/interactiveIdleMinutes` (number) | Runs fieldset; default filled in when absent             |
| `providers['claude-code'].acpBin` | non-empty, `'claude-agent-acp'` | `providers/claude-code/acpBin` (text)  | Provider fieldset                                        |
| `providers.codex.acpBin`          | non-empty, `'codex-acp'`        | `providers/codex/acpBin` (text)        | Provider fieldset                                        |

Add `runFields` and `providerFields` entries in `editor.ts`. `acpBin` is picked only for the two providers that have it.

**Interfaces:**

```ts
// src/core/domain/types.ts
export type Trigger = 'schedule' | 'manual' | 'adhoc' | 'answer' | 'timer' | 'agent';
export type Outcome = 'nothing' | 'acted' | 'needs-you' | 'done';
export type ChatProcessState = 'stopped' | 'starting' | 'idle' | 'busy';
export interface ChatSession { /* PR 2 fields */ processState: ChatProcessState; pid: number | null; copyPath: string | null }

// src/core/chats/drivers/sessionDriver.ts
export type ToolPolicy = { allowAll: boolean; allowed: string[]; blocked: string[]; denyTools: string[] };
export type McpServerSpec = { name: 'automator'; command: string; args: string[]; env: Record<string, string> };

export type SessionEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'turn-start'; prompted: boolean }
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
  | { type: 'permission'; tool: string; decision: 'allow' | 'deny' }        // already answered by policy; log only
  | { type: 'question'; requestId: string; text: string; options: string[] | null } // native (PR 4)
  | { type: 'turn-end'; stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | 'error'; error?: RunError }
  | { type: 'error'; error: RunError }
  | { type: 'exit'; exit: ProviderExit };

export type SessionStartOptions = {
  cwd: string;
  model: string;
  env: Env;
  logPath: string;                 // raw protocol + stderr log, per Chat session
  providerSessionId?: string;      // resume; failure => SESSION_RESUME_FAILED, never a silent new session
  tools: ToolPolicy;
  mcpServer?: McpServerSpec;       // PR 4+
  scope?: { config: Config; secrets: Secrets };
};

export type QuestionAnswer = { kind: 'answer'; text: string } | { kind: 'timeout'; text: string } | { kind: 'cancel' };

export interface SessionHandle {
  readonly pid: number;
  ready: Promise<{ providerSessionId: string }>;   // after initialize + session/new|load (ACP) or get_state (pi)
  send(message: string): Promise<void>;            // starts a turn; rejects if a turn is in flight
  respond(requestId: string, answer: QuestionAnswer): void;
  cancelTurn(): void;                              // ACP session/cancel, pi {"type":"abort"}
  stop(): Promise<ProviderExit>;                   // close stdin, SIGTERM, SIGKILL after KILL_GRACE_MS
  kill(): void;                                    // immediate SIGKILL of the process group
  onEvent(listener: (event: SessionEvent) => void): () => void;
  exited: Promise<ProviderExit>;
}

export interface SessionDriver {
  readonly provider: ProviderName;
  start(options: SessionStartOptions): SessionHandle;
}
export type SessionDrivers = Partial<Record<ProviderName, SessionDriver>>;

// src/core/chats/drivers/jsonRpc.ts — newline-delimited JSON-RPC 2.0 peer
export interface JsonRpcPeer {
  request<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): void;
  close(): void;
}
export function createJsonRpcPeer(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, log?: (line: string) => void): JsonRpcPeer;

// src/core/chats/drivers/acpDriver.ts
export type AcpCommand = { bin: string; args: string[]; preserveCopilotAuth?: boolean };
export function acpCommand(config: Config, provider: Exclude<ProviderName, 'pi'>): AcpCommand;
//   copilot:     providers.copilot.bin --acp --model <m> [tool flags as in copilotLauncher] [--secret-env-vars ...]
//   opencode:    providers.opencode.bin acp
//   claude-code: providers['claude-code'].acpBin          (model via session/set_model or env, per spike)
//   codex:       providers.codex.acpBin                   (model/sandbox via -c overrides, per spike)
export function createAcpDriver(provider: Exclude<ProviderName, 'pi'>, config: Config, secrets: Secrets): SessionDriver;

// src/core/chats/drivers/piRpcDriver.ts
export function createPiRpcDriver(config: Config, secrets: Secrets): SessionDriver;
//   pi --mode rpc --model <m> [--session <id>] [--exclude-tools ...] [--extension <automator pi extension> (PR 4)]

// src/core/chats/drivers/toolPolicy.ts
export function permissionDecision(provider: ProviderName, policy: ToolPolicy, request: { tool: string; kind?: string }): 'allow' | 'deny';
export function unsupportedPolicy(provider: ProviderName, policy: ToolPolicy): RunError | null; // same rules as the launchers

// src/core/chats/sessionManager.ts
export interface ChatSessionManagerDeps {
  db: Database; clock: Clock; dataDir: DataDir; drivers: SessionDrivers;
  configFor: ConfigFor; secretsFor: (config: Config) => Secrets;
  repositories: RepositoryService;
}
export type TurnHandle = RunningProcess & { lastMessage(): string | null };
export class ChatSessionManager {
  constructor(deps: ChatSessionManagerDeps);
  // Ensures copy + live process (lazy start/resume, eviction), sends the prompt, appends events to the
  // Run's transcript.md, and resolves `exited` when the turn settles. kill('SIGTERM') => cancelTurn,
  // kill('SIGKILL') => stop the session process (the next turn resumes by id).
  startTurn(run: Run, session: ChatSession, prompt: string, start: Omit<SessionStartOptions, 'cwd' | 'providerSessionId'>): Promise<TurnHandle>;
  tick(): void;                    // idle timeout, eviction, close requests; PR 4/5 extend
  stopAll(): Promise<void>;        // graceful, for worker shutdown
  killAll(): void;                 // forced exit
  liveCount(): number;
}

// src/core/chats/copyStatus.ts
export type CopyWork = { uncommitted: boolean; unpushedCommits: number };
// git status --porcelain; git rev-list --count --branches --not --remotes
export function copyWork(copyPath: string): Promise<CopyWork | null>;   // null when the copy does not exist

// src/core/queue/queueService.ts
requestCloseChat(runId: number): Result<void>;   // INVALID_STATE while a turn of the Chat is queued/running

// src/core/runs/promptBuilder.ts
export function buildInteractivePrompt(input: {
  run: Run; config: Config; repository: Repository; firstTurn: boolean;
  agentInstructions: string; operationTemplate: string | null; projectPromptAddition?: string | null;
}): string; // first turn: INTERACTIVE_RULES + agent + ticket + branch context + request + validation + additions; later turns: message only
```

The rules for the executor's interactive path live in `src/core/chats/interactiveTurn.ts`:

- `RunExecutor.conclude` keeps every shared step: authorize, Repository checks, Agent resolution, tool-capability check, prompt write and cancel check. It then branches on `run.chatSessionId !== null` and calls `runInteractiveTurn(...)` instead of copying and launching.
- The turn's `TurnHandle` becomes `active.proc`, so `supervise` (cancel, `FORBIDDEN`, timeout, SIGTERM→SIGKILL escalation) works unchanged.
- Evaluation:
  - `turn-end end_turn` gives `resultStatus 'success'`, `outcome 'done'`, and `summary = lastMessage()?.slice(0, 500) ?? ''`.
  - `cancelled` after an Automator-initiated interrupt maps through `active.interrupted` exactly as today.
  - Process exit mid-turn gives `PROVIDER_ERROR` (`exit.error` if present).
  - A resume failure gives `SESSION_RESUME_FAILED`.
  - `refusal` and `max_tokens` give `PROVIDER_ERROR` with that stop reason.
- `isolation` is recorded as `'copy'`. The `finally` block's `removeWorkspace(run.id)` stays harmless.

**Tasks:**

- [ ] **Step 1: Run the provider spike first.** Write `docs/superpowers/specs/2026-11-14-interactive-chats-provider-spike.md`. For each provider (Copilot `--acp`, OpenCode `acp`, `claude-agent-acp`, `codex-acp`, `pi --mode rpc`), using the installed CLIs in a scratch repo, record:
  - (a) version and install command;
  - (b) `initialize` result (`agentCapabilities.loadSession`, prompt capabilities, advertised elicitation) and pi `get_state`;
  - (c) `session/new` and `session/load` by id after a process restart, or the pi `--session` resume;
  - (d) how the model is selected (flag, `session/set_model`, env);
  - (e) streaming events and turn completion signal (ACP `session/prompt` response `stopReason`; pi `agent_end`/`agent_settled`);
  - (f) `session/request_permission` shape and whether `allow_once` replies suffice under each provider's permission mode, and whether Copilot ACP honours `--allow-all-tools`/`--deny-tool` at start;
  - (g) whether `mcpServers` in `session/new` is honoured (stdio), how its env is filtered, and the **maximum MCP tool-call duration** (does it allow `runs.questionWaitMs` = 10 min? do progress notifications extend it? can it be configured per session, for example a Codex `tool_timeout_sec` override?);
  - (h) native question mechanism and wire shape over the protocol (Claude `AskUserQuestion` via adapter, Codex `requestUserInput`, OpenCode `elicitation/create`, pi `extension_ui_request`), plus Copilot's undocumented behaviour;
  - (i) native timers and whether unprompted turns emit `session/update` while idle, and how they end (needed by PR 5);
  - (j) `session/cancel`/`abort` behaviour;
  - (k) crash behaviour and exit codes;
  - (l) whether pi loads an `--extension` in rpc mode and how long its tool calls may block.

  Capture one real JSONL exchange per provider into the spike doc. The fake fixtures replay these. Set `INTERACTIVE_CAPABILITIES` from the results. A provider whose resume, streaming or turn completion is not verified stays `interactive: false` with a reason. If Automator tools cannot be served to a provider (item g/l), set `automatorTools: 'none'`, and PR 4 decides per its own spike notes. **Stop and ask the user** if fewer than two providers pass, or if the results contradict a spec decision.

- [ ] **Step 2: Write migration and config tests.**
  - `db.test.ts`: `migration 28 rebuilds runs preserving rows, ids, owners and chat links` and `runs accept answer/timer/agent triggers and the done outcome`.
  - `load.test.ts`: `interactive Run settings have defaults`.
  - `resolver.test.ts`: `interactive settings are Project-overridable and validated`.
  - `editor.test.ts`: `Settings shows interactive Run settings with defaults when absent from the file` and `ACP adapter executables round-trip`.
- [ ] **Step 3:** Run `npx vitest run src/core/db/db.test.ts src/core/config` and confirm the tests fail. Then implement migration 28, the types, schema keys, override fields, editor projection and `automator.config.example.json`, and rerun until they pass.
- [ ] **Step 4: Write `jsonRpc.test.ts`.** Cover `frames newline-delimited messages split across chunks`, `correlates responses by id including out-of-order`, `rejects pending requests with the error object`, `dispatches agent-to-client requests and replies with the handler result or a JSON-RPC error`, `a malformed line is logged and does not crash the peer`, and `pending requests reject when the stream closes`.
- [ ] **Step 5:** Run `npx vitest run src/core/chats/drivers/jsonRpc.test.ts` and confirm the tests fail. Implement `jsonRpc.ts` and rerun until they pass.
- [ ] **Step 6: Write `toolPolicy.test.ts`.** Cover `allowAll answers permission requests with allow`, `Copilot policy is passed as start flags identical to copilotLauncher`, `non-Copilot providers reject denyTools and custom Agent tools like their launchers`, and `pi maps denyTools to --exclude-tools`. Implement `toolPolicy.ts` and confirm they pass.
- [ ] **Step 7: Write `acpDriver.test.ts`** against `fake-acp-agent.mjs`, with each test parameterized over the four ACP providers' command lines:
  - `starts the provider's ACP command in the Chat copy with filtered credentials`;
  - `initialize then session/new with cwd, model and mcpServers`;
  - `resume uses session/load with the stored id`;
  - `resume fails with SESSION_RESUME_FAILED when loadSession is unsupported or rejected` (no new session is created);
  - `agent_message_chunk updates become text events and turn-end follows the prompt response`;
  - `tool_call updates become tool-call events`;
  - `permission requests are answered by policy and never surface as questions`;
  - `a second send while a turn is in flight is rejected`;
  - `cancelTurn sends session/cancel and the turn ends cancelled`;
  - `a crash mid-turn emits an error turn-end then exit`;
  - `stop closes stdin then escalates to SIGTERM and SIGKILL`;
  - `native questions are declined until PR 4 and logged`;
  - `updates without an active prompt emit turn-start prompted=false`.
- [ ] **Step 8:** Run `npx vitest run src/core/chats/drivers/acpDriver.test.ts` and confirm the tests fail. Implement `acpDriver.ts`, using `spawnChild` from `childProcess.ts` with `stdio` extended to a piped stdin. Add an optional `stdin: 'pipe'` to `ChildProcessOptions` and return `stdin` on the handle, leaving existing callers unchanged. Rerun until the tests pass.
- [ ] **Step 9: Write `piRpcDriver.test.ts`** against `fake-pi-rpc.mjs`. Cover `starts pi --mode rpc with model, session and exclude-tools`, `prompt command starts a turn and message_update text deltas stream`, `agent_end settles the turn`, `abort cancels`, `resume by session id and SESSION_RESUME_FAILED on an unknown session`, `extension_ui_request is declined until PR 4`, and `crash mid-turn`. Implement `piRpcDriver.ts` and confirm the tests pass.
- [ ] **Step 10: Write `copyStatus.test.ts`** using a real temporary git repo with a bare remote. Cover `a clean pushed copy reports no work`, `uncommitted changes are reported`, `local commits not on any remote are counted`, and `a missing copy returns null`. Implement `copyStatus.ts` with `execFile('git', ...)` and a 5 s timeout, as `gitCurrentBranch` does.
- [ ] **Step 11: Write `sessionManager.test.ts`** with fake drivers and a fake clock:
  - `two turns of one Chat reuse one process and one copy`: the copy is created on the first turn with `fsp.cp(..., { recursive: true, verbatimSymlinks: true })` under `chat-workspaces/<id>/`, and `copy_path`, `pid` and `process_state` are persisted;
  - `each turn's events are appended to that Run's transcript.md and lastMessage is the final agent message`;
  - `an idle process is stopped after runs.interactiveIdleMinutes and the next turn resumes by provider session id`;
  - `starting a session beyond maxInteractiveSessions stops the least-recently-used idle process` (uses the effective value of the starting Chat's Repository);
  - `busy sessions are never evicted`;
  - `a close request stops the process, deletes the copy and sets closed_at`;
  - `stopAll stops every live process`;
  - `a copy failure ends the turn with WORKSPACE_COPY_FAILED`;
  - `the provider session id from the session event is stored on the chat session and the Run`;
  - `an unprompted turn-start is logged only` (PR 5 replaces this).
- [ ] **Step 12:** Run `npx vitest run src/core/chats/sessionManager.test.ts` and confirm the tests fail. Implement `sessionManager.ts` and the `DataDir` helpers, and rerun until they pass.
- [ ] **Step 13: Write executor, prompt and queue tests.**
  - `runExecutor.test.ts`:
    - `an interactive turn finishes done with the last agent message as summary and without copilot-result.json`;
    - `result.json is still written for interactive turns`;
    - `cancel during an interactive turn cancels the turn and records interrupted`;
    - `timeout applies to interactive turns`;
    - `a provider crash fails the turn and the session process is marked stopped`;
    - `interactive turns of unsupported providers or tool policies fail with PROVIDER_CAPABILITY_UNSUPPORTED`;
    - `Follow-up and Automation Runs still use the launcher path`, using the existing tests plus one assertion that the session manager is not called.
  - `promptBuilder.test.ts`:
    - `first interactive turn carries rules, agent instructions, request and validation but no result-file section`;
    - `later turns send only the message`;
    - `a branched Interactive Chat's first turn includes the earlier conversation`.
  - `queueService.test.ts`:
    - `replying to an Interactive Chat queues a turn without requiring a provider session id`;
    - `claimNext records copy isolation for interactive turns and honours maxConcurrent`;
    - `claimNext skips a queued turn while another turn of the same Chat is running`;
    - `requestCloseChat is rejected while a turn is queued or running`;
    - `a closed Chat rejects replies`;
    - `deleting the last Run of an Interactive Chat requests its close`.
- [ ] **Step 14:** Run `npx vitest run src/core/runs/runExecutor.test.ts src/core/runs/promptBuilder.test.ts src/core/queue/queueService.test.ts` and confirm the tests fail. Implement `interactiveTurn.ts`, the executor branch, `buildInteractivePrompt` (`INTERACTIVE_RULES` = `ADHOC_RULES` with the "non-interactively / nobody answers" sentences replaced by "If you need a decision, say so in your reply and end your turn"), and the queue changes. Rerun until the tests pass.
- [ ] **Step 15: Write `recovery.test.ts` and `src/worker/loop.test.ts` tests.**
  - `a turn running at restart is finalized interrupted and its session process group is killed and marked stopped`;
  - `open Interactive Chat copies survive restart while closed, close-requested and orphan chat copies are deleted`;
  - `per-Run copies are still cleared`;
  - `the next turn after restart starts the process lazily and resumes by session id`;
  - `the worker ticks the session manager and stops all sessions on graceful stop`;
  - `forced exit kills live sessions`.
- [ ] **Step 16:** Implement the `recovery.ts` changes, the `WorkerLoop.iterate` guard step `chat sessions` → `core.chatSessions.tick()`, the `stop()` call to `await core.chatSessions.stopAll()` after active turns drain, and the force path in `src/worker/main.ts` calling `core.executor.killActive()` plus `core.chatSessions.killAll()`. Confirm the tests pass.
- [ ] **Step 17: Write read-model and action tests.**
  - `readModels.test.ts`:
    - `thread view reports interactive session state (live, stopped, closed)`;
    - `reply is blocked with a reason while a turn runs or after close`;
    - `runs list filters by the new triggers`.
  - `app/actions/chat.test.ts`:
    - `closeChat with uncommitted or unpushed work returns needsConfirmation and does not close`;
    - `closeChat with confirm requests the close`;
    - `closeChat of a clean copy closes without confirmation`;
    - `closeChat needs write on the Run`.
- [ ] **Step 18: Implement the read models, the `closeChat(runId, confirmed)` server action, and the UI.**
  - The `closeChat` action returns `{ ok: false; needsConfirmation: true; work: CopyWork }` when the copy has work and `confirmed` is false.
  - In ChatPane, Interactive Chats show a `Chat.sessionState` line and a **Close chat** button. The button opens `ConfirmDialog` with `Chat.closeChatWorkWarning`, listing uncommitted changes and unpushed commits, when the action reports work.
  - `Pill.tsx` gets the `done` outcome variant.
  - Add trigger labels `Trigger.answer`, `Trigger.timer` and `Trigger.agent`, and outcome filter labels.
  - Enable the `AdhocForm` Interactive option from the capabilities.
- [ ] **Step 19: Add the e2e scenario `interactive chat option follows provider capability`** to `test/e2e/smoke.spec.ts`.
- [ ] **Step 20: Update README.**
  - Add an Interactive Chats section: mode choice, per-Chat copy under `chat-workspaces/`, idle timeout, `maxInteractiveSessions`, lazy restart, Close chat warning, tool policy parity, the `done` outcome in the API.
  - Add ACP adapter install rows (`claude-agent-acp`, `codex-acp`) with versions from the spike.
  - Extend the smoke checklist with an interactive item per provider: two turns share one process, idle stop and resume, Close chat with dirty copy.
  - Update the "Per-Repository queue" bullet for interactive turns.
- [ ] **Step 21: Verify.** Run `npx vitest run src/core/chats src/core/runs src/core/queue src/core/db src/core/config src/core/read-models src/worker app/actions`, then `npm run check`, then `npm run e2e -- --grep "interactive"`.

**Acceptance criteria:**

- For every provider marked supported, an Interactive Chat runs successive turns in one process and one copy, streams text into each turn's transcript, and finishes turns as `done` with the last agent message as summary.
- Idle timeout and eviction stop processes, and the next turn resumes by session id. A failed resume is a visible `SESSION_RESUME_FAILED`.
- After a worker restart, a mid-run turn is `interrupted`, the process is gone, the copy is kept, and the next turn restarts lazily.
- Close chat warns when the copy has uncommitted or unpushed work, requires confirmation, and deletes the copy.
- Permission requests never reach the user. Unsupported tool policies fail exactly as in Follow-up mode.
- Follow-up and Automation tests are unchanged and green.

**Risks / open spikes:**

- **ACP maturity.** Copilot ACP is in preview. `session/load`, `session/set_model` and elicitation are unstable or draft in ACP. Each provider's flag is set only from verified behaviour, and unverified items stay off.
- **Turn completion for unprompted output** has no explicit ACP end signal. PR 5 needs the spike's finding. The fallback is a settle window: no update for `AGENT_SETTLE_MS = 5000` ends an unprompted turn.
- **Adapters are separate executables** (`acpBin`). Missing adapters surface as `SPAWN_FAILED` with README troubleshooting.
- **Codex sandbox and Run artifacts:** interactive turns need no artifact write grant, because no result file is written. Verify that `codex-acp` defaults to a workspace-write sandbox rooted at the copy.
- **Copy cost:** a full recursive copy per Chat, the same as copy isolation today. Document the disk cost in README.
- **Process supervision:** session processes are detached process groups. `killAll` must run on every forced exit path, or recovery cleans them up by `chat_sessions.pid`.

---

## PR 4: Questions

**Scope:**

- An Automator MCP server exposing `ask_user`, served to ACP providers through `mcpServers` and to pi through a bundled extension.
- Native question mapping per driver: ACP elicitation (OpenCode `elicitation/create`, adapters as verified), and pi `extension_ui_request` (`select`, `confirm`, `input`).
- The Waiting for you session state in the thread, left menu and Chats list.
- An inline question UI with choice buttons or free text.
- `runs.questionWaitMs` with an in-turn answer, a timeout reply of `No answer yet. Stop and wait for the user`, and a later answer starting an `answer` turn.

**Out of scope:** Teams notification for Waiting for you. Questions in Follow-up mode or Automation Runs. Several simultaneous questions per Chat: a second `ask_user` while one is pending returns a tool error.

**Files:**

- Create: `src/core/chats/questions.ts`, `src/core/chats/questions.test.ts`
- Create: `src/core/chats/chatTools.ts` (tool schemas and handlers shared by MCP and pi), `src/core/chats/chatTools.test.ts`
- Create: `src/core/chats/mcpServer.ts` (stdio MCP protocol: `initialize`, `tools/list`, `tools/call`, `notifications/progress`), `src/core/chats/mcpServer.test.ts`
- Create: `src/core/chats/pi/automatorExtension.ts` (pi extension source registering `ask_user`/`schedule_wakeup`, each delegating to `automator chat-tool`)
- Modify: `src/cli/main.ts` (hidden `mcp --chat-session <id> --nonce <hex>` and `chat-tool <name> --chat-session <id> --nonce <hex>` subcommands, lightweight: `loadConfig` + `openDb`, no `createCore`), `src/cli/main.test.ts`
- Modify: `src/core/chats/drivers/acpDriver.ts`, `src/core/chats/drivers/piRpcDriver.ts` (native questions → `question` events; `respond` mapping; `mcpServer`/extension wiring)
- Modify: `src/core/chats/sessionManager.ts` (persist native questions, resolve answers and timeouts on `tick`)
- Modify: `src/core/db/migrations/index.ts` (version 29), `src/core/db/rows.ts`, `src/core/domain/types.ts`
- Modify: `src/core/config/schema.ts`, `overrides.ts`, `editor.ts`, `automator.config.example.json`
- Modify: `src/core/runs/promptBuilder.ts` (ask_user guidance in `INTERACTIVE_RULES`)
- Modify: `src/core/queue/queueService.ts` (`answerQuestion`), `src/core/read-models/thread.ts`, `src/core/read-models/runs.ts` (`chatState`)
- Modify: `app/actions/chat.ts` (`answerQuestion`), `app/components/ChatPane.tsx` (question card), `app/components/Sidebar.tsx` (`NavChatStatus` `'waiting'`), `app/layout.tsx` (`chatStatus`), `app/components/RunsTable.tsx` (Waiting for you pill), `messages/en.json`
- Modify tests: `src/core/db/db.test.ts`, `src/core/config/*.test.ts`, `src/core/chats/drivers/acpDriver.test.ts`, `src/core/chats/drivers/piRpcDriver.test.ts`, `src/core/chats/sessionManager.test.ts`, `src/core/queue/queueService.test.ts`, `src/core/read-models/readModels.test.ts`, `src/core/runs/promptBuilder.test.ts`, `app/actions/chat.test.ts`, `test/e2e/smoke.spec.ts`
- Modify: `README.md`

**Schema (migration 29):**

```sql
ALTER TABLE chat_sessions ADD COLUMN mcp_nonce TEXT;                -- random per session; checked by the MCP/CLI tool entry points
ALTER TABLE chat_sessions ADD COLUMN question_text TEXT;
ALTER TABLE chat_sessions ADD COLUMN question_options_json TEXT;    -- JSON string[] or NULL (free text)
ALTER TABLE chat_sessions ADD COLUMN question_source TEXT CHECK (question_source IN ('automator', 'native'));
ALTER TABLE chat_sessions ADD COLUMN question_request_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN question_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN question_asked_at INTEGER;
ALTER TABLE chat_sessions ADD COLUMN question_expires_at INTEGER;   -- asked_at + effective runs.questionWaitMs
ALTER TABLE chat_sessions ADD COLUMN question_expired_at INTEGER;   -- set when the timeout reply was given
ALTER TABLE chat_sessions ADD COLUMN question_answer TEXT;          -- in-turn answer awaiting pickup
```

**Config key:** `runs.questionWaitMs`, a positive integer in ms, default `600000` (clarification 8). Project override field `runs/questionWaitMs` takes a duration text. Settings shows it in the Runs fieldset, with the default filled in when absent.

**Interfaces:**

```ts
// src/core/domain/types.ts
export type ChatState = 'idle' | 'running' | 'waiting' | 'closed';
export interface PendingQuestion {
  text: string;
  options: string[] | null;
  source: 'automator' | 'native';
  requestId: string;
  runId: number | null;
  askedAt: number;
  expiresAt: number;
  expiredAt: number | null; // non-null: the turn was told to stop; the next answer starts an `answer` turn
}
// ChatSession gains: question: PendingQuestion | null; mcpNonce: string | null

// src/core/chats/chatTools.ts — MCP tool schema (also used for the pi extension's parameters)
export const ASK_USER_TOOL = {
  name: 'ask_user',
  description:
    'Ask the user a question and wait for the answer. Use options for a choice; omit them for free text. ' +
    'If the result is "No answer yet. Stop and wait for the user", end your turn without further changes.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 2000 },
      options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 2, maxItems: 10 },
    },
    required: ['question'],
    additionalProperties: false,
  },
} as const;
export const QUESTION_TIMEOUT_REPLY = 'No answer yet. Stop and wait for the user';
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
export interface ChatToolContext {
  db: Database;
  clock: Clock;
  sessionId: number;
  nonce: string;
  configFor: ConfigFor;
  pollMs?: number;
  signal?: AbortSignal;
}
export function askUser(ctx: ChatToolContext, input: unknown): Promise<ToolResult>;

// src/core/chats/questions.ts — every transition is one IMMEDIATE transaction
export function openQuestion(
  db: Database,
  input: {
    sessionId: number;
    runId: number | null;
    text: string;
    options: string[] | null;
    source: 'automator' | 'native';
    requestId: string;
    now: number;
    waitMs: number;
  },
): Result<PendingQuestion>;
// Called by the waiter (MCP poller or session manager tick). Exactly one of: answered | expired | pending.
export function settleQuestion(
  db: Database,
  sessionId: number,
  requestId: string,
  now: number,
): { kind: 'answered'; text: string } | { kind: 'expired' } | { kind: 'pending' } | { kind: 'gone' };
// Called by the dashboard. In-turn (pending, not expired, Run still running) => stores question_answer.
// Otherwise (expired, or its Run ended) => clears the question and enqueues an `answer` turn.
export function answerQuestion(
  db: Database,
  queue: QueueService,
  input: { runId: number; answer: string; now: number },
): Result<{ delivered: 'in-turn' } | { delivered: 'new-turn'; runId: number }>;

// src/core/chats/mcpServer.ts
export function serveMcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  tools: McpTool[],
): { closed: Promise<void> };
export type McpTool = {
  definition: { name: string; description: string; inputSchema: object };
  call(args: unknown, progress: (message: string) => void): Promise<ToolResult>;
};

// src/core/read-models/thread.ts
export type ThreadView = {
  /* … */ chat: { mode: ChatMode; sessionId: number | null; state: ChatState; question: PendingQuestion | null };
};
// src/core/read-models/runs.ts
export type RunRow = { /* … */ chatState: ChatState | null };
// app/components/Sidebar.tsx
export type NavChatStatus = 'needs-you' | 'error' | 'queued' | 'running' | 'waiting';
```

**Question flow:**

1. **The agent asks.**
   - With Automator `ask_user`, the MCP process calls `openQuestion` and then polls `settleQuestion` every `pollMs` (default 500 ms). While polling it sends MCP progress notifications every 30 s if the spike showed they extend the client timeout.
   - With a native question, the driver emits `question`, and the manager calls `openQuestion(source 'native')`.
   - The turn's Run stays `running`, and `chat.state` becomes `waiting`.
2. **The user answers in time.** `answerQuestion` stores `question_answer`. The waiter's next `settleQuestion` returns `answered` and clears the question.
   - For MCP, the tool result text is the answer.
   - For a native question, `respond(requestId, { kind: 'answer', text })`. A choice answer is mapped back to the native option id.
   - The turn continues.
3. **Timeout.** `settleQuestion` sets `question_expired_at` atomically (only if `question_answer IS NULL`).
   - For MCP, the tool result is `QUESTION_TIMEOUT_REPLY`.
   - For a native question, `respond(..., { kind: 'timeout', text })` sends free text where the protocol allows it, and decline/cancel otherwise.
   - The question stays pending with `expiredAt` set. The turn finishes `done`, and the Chat keeps Waiting for you.
4. **A late answer** clears the question and enqueues a Run with `trigger 'answer'`, priority 0, `adhoc_prompt` = the answer, and parent = Chat tip. Its prompt is `Answer to your earlier question "<text>":\n\n<answer>`.
5. **Restart.** A mid-wait turn is interrupted as in PR 3. Recovery sets `question_expired_at` for questions whose Run is no longer running, so the question stays pending and the next answer starts an `answer` turn.
6. **Close chat** clears any pending question.

While a question is pending, the Chat composer is replaced by the question card:

- choice buttons when options exist, and a free-text field when there are none;
- for choice questions, an "Other answer" text input, because the composer is hidden;
- `answerQuestion` handles every submission.

**Tasks:**

- [ ] **Step 1: Run a short spike follow-up** (append it to the PR 3 spike doc). Confirm items (g), (h) and (l) on the current provider versions:
  - the MCP stdio launch command (`process.execPath`, `[bin/automator.mjs, 'mcp', ...]`) works from each ACP provider;
  - the maximum `ask_user` blocking duration per provider;
  - native question wire shapes.

  For providers that cannot hold a 10-minute tool call even with progress or configuration, **ask the user** before shipping `ask_user` for them. Options: per-provider timeout configuration in the start command, or marking `automatorTools: 'none'` for that provider. Do not silently shorten the wait.

- [ ] **Step 2: Write migration and config tests** (`migration 29 adds question columns`, `questionWaitMs default, override as duration and Settings default`). Confirm they fail, then implement.
- [ ] **Step 3: Write `questions.test.ts`.**
  - `opening a question while one is pending is rejected`;
  - `an in-time answer is delivered exactly once`;
  - `timeout marks the question expired only when unanswered`;
  - `an answer racing the timeout either lands in-turn or starts one answer turn` (interleave `settleQuestion` and `answerQuestion` in both orders);
  - `an answer after the question's Run ended starts an answer turn on the Chat tip`;
  - `answers are trimmed, required and limited to MAX_FOLLOW_UP_CHARS`;
  - `answering a closed Chat is rejected`.
- [ ] **Step 4:** Run `npx vitest run src/core/chats/questions.test.ts` and confirm the tests fail. Implement `questions.ts`, plus `QueueService.enqueueAdhoc` support for `trigger: 'answer'` through a new `EnqueueAdhocInput.trigger?: 'adhoc' | 'answer' | 'timer'` (default `'adhoc'`, so Follow-up callers are unchanged). Rerun until the tests pass.
- [ ] **Step 5: Write `chatTools.test.ts` and `mcpServer.test.ts`.**
  - `ask_user validates input against the schema`;
  - `ask_user returns the answer`;
  - `ask_user returns the timeout reply after questionWaitMs` (fake clock and fast `pollMs`);
  - `ask_user rejects a wrong nonce or closed session`;
  - `MCP initialize/tools/list/tools/call framing`;
  - `tools/call for an unknown tool is a JSON-RPC error`;
  - `progress notifications are sent while waiting`.
- [ ] **Step 6:** Implement `chatTools.ts`, `mcpServer.ts`, and the CLI subcommands. In `src/cli/main.test.ts`, add `mcp subcommand serves ask_user for a session` and `chat-tool subcommand reads JSON from stdin`. Confirm the tests pass.
- [ ] **Step 7: Write driver tests.**
  - `acpDriver.test.ts`:
    - `session/new and session/load pass the Automator MCP server`;
    - `elicitation requests become question events and respond maps choices back to option ids`;
    - `a timeout response declines or sends the timeout text per capability`.
  - `piRpcDriver.test.ts`:
    - `the Automator extension is loaded`;
    - `extension_ui_request select/confirm/input become question events`;
    - `respond sends extension_ui_response`.
- [ ] **Step 8:** Implement the driver changes. `ChatSessionManager.startTurn` builds the `McpServerSpec` with the session nonce, generated on first start and stored. Update `capabilities.ts` (`nativeQuestions`, `automatorTools`). Confirm the tests pass.
- [ ] **Step 9: Write `sessionManager.test.ts` additions.**
  - `a native question puts the Chat in Waiting for you and an in-time answer resolves it in-turn`;
  - `a native question times out with the timeout response and the turn ends done while the Chat stays waiting`;
  - `close clears a pending question`;
  - `recovery expires questions whose Run is gone`.

  Implement the changes and confirm the tests pass.

- [ ] **Step 10: Write read-model, prompt and action tests.**
  - `thread view exposes the pending question and waiting state`;
  - `runs list and left-menu rows report Waiting for you`;
  - `the first interactive prompt tells the agent to use ask_user and to stop on the timeout reply`;
  - `answerQuestion delivers in-turn or queues an answer turn and needs write on the Run`.

  Implement the read models, `app/actions/chat.ts#answerQuestion`, the ChatPane question card, `Sidebar`/`layout.tsx` `'waiting'` (pill variant `needs-you`, label `Pill.waiting` "Waiting for you"), and the `RunsTable` pill. `chatStatus` returns `'waiting'` before the outcome checks when `run.chatState === 'waiting'`.

- [ ] **Step 11: Add the e2e scenario `a pending question shows choice buttons and the Chat is Waiting for you in the left menu`** (seeded session row).
- [ ] **Step 12: Update README.** Cover questions, `runs.questionWaitMs`, Waiting for you versus Needs you, per-provider native question support from the spike, and the absence of Teams notifications.
- [ ] **Step 13: Verify.** Run `npx vitest run src/core/chats src/cli src/core/queue src/core/db src/core/config src/core/read-models src/core/runs/promptBuilder.test.ts app/actions`, then `npm run check`, then `npm run e2e -- --grep "question"`.

**Acceptance criteria:**

- `ask_user` and each verified native mechanism show Waiting for you inline, in the left menu and in the Chats list.
- An answer within `runs.questionWaitMs` resolves in the same turn.
- After the timeout, the agent receives `No answer yet. Stop and wait for the user`, the turn ends `done`, and the Chat keeps Waiting for you. The eventual answer starts exactly one `answer` turn.
- Permission requests are still never shown. Needs you, `canClose` and Teams behaviour are unchanged.

**Risks / open spikes:**

- MCP tool-call timeouts per provider (Step 1) are the main risk.
- The ACP elicitation RFD may change shape. The mapping is isolated in `acpDriver.ts`.
- The MCP process opens the SQLite database directly (WAL). Contention is low (a 500 ms poll), but the poll must use read-only statements except inside `settleQuestion`.
- The nonce check limits accidental cross-session calls. It is not a security boundary, consistent with README's trust-boundary statement.

---

## PR 5: Timers

**Scope:**

- Automator `schedule_wakeup`, with a delay or absolute time plus a message. It allows one pending timer per Chat (a new timer replaces the old), requires at least 1 minute, and is stored in SQLite.
- The scheduler fires due timers into the queue as `trigger = 'timer'` Runs, respecting the Repository's effective working hours.
- The Chat lists the pending timer with a Cancel action. Timers are cancelled on close and survive restart.
- Native timers pass through, with unprompted turns recorded as `trigger = 'agent'` Runs.
- Prompt guidance prefers `schedule_wakeup`, and the Chat UI warns that native timers are lost if the session process stops.

**Out of scope:** Listing or cancelling native timers. Recurring Automator timers. Teams notifications.

**Files:**

- Modify: `src/core/chats/chatTools.ts` (`SCHEDULE_WAKEUP_TOOL`, `scheduleWakeup`), `src/core/chats/chatTools.test.ts`, `src/core/chats/mcpServer.ts` (register the tool), `src/core/chats/pi/automatorExtension.ts`
- Create: `src/core/chats/timers.ts`, `src/core/chats/timers.test.ts`
- Modify: `src/core/scheduler/scheduler.ts` (`fireChatTimers` in `tick`), `src/core/scheduler/scheduler.test.ts`
- Modify: `src/core/chats/sessionManager.ts` (unprompted turns become `agent` Runs), `src/core/runs/runExecutor.ts` (`adoptTurn(run, handle)` for already-running `agent` Runs), `src/core/chats/sessionManager.test.ts`, `src/core/runs/runExecutor.test.ts`
- Modify: `src/core/queue/queueService.ts` (close cancels the timer; `cancelChatTimer`), `src/core/queue/queueService.test.ts`
- Modify: `src/core/db/migrations/index.ts` (version 30), `src/core/db/rows.ts`, `src/core/domain/types.ts`, `src/core/db/db.test.ts`
- Modify: `src/core/runs/promptBuilder.ts`, `src/core/runs/promptBuilder.test.ts`
- Modify: `src/core/read-models/thread.ts`, `src/core/read-models/readModels.test.ts`
- Modify: `app/actions/chat.ts` (`cancelChatTimer`), `app/actions/chat.test.ts`, `app/components/ChatPane.tsx` (timer card and native-timer warning), `messages/en.json`, `test/e2e/smoke.spec.ts`
- Modify: `README.md`, `GLOSSARY.md` (mention Automator timer under Chat session if useful)

**Schema (migration 30):**

```sql
ALTER TABLE chat_sessions ADD COLUMN timer_fire_at INTEGER;
ALTER TABLE chat_sessions ADD COLUMN timer_message TEXT;
ALTER TABLE chat_sessions ADD COLUMN timer_created_at INTEGER;
CREATE INDEX ix_chat_sessions_timer ON chat_sessions(timer_fire_at) WHERE timer_fire_at IS NOT NULL AND closed_at IS NULL;
```

**Interfaces:**

```ts
// src/core/domain/types.ts
export interface PendingTimer { fireAt: number; message: string; createdAt: number }
// ChatSession gains: timer: PendingTimer | null

// src/core/chats/chatTools.ts
export const SCHEDULE_WAKEUP_TOOL = {
  name: 'schedule_wakeup',
  description:
    'Continue this chat later. Give either `delay` (e.g. "15m", "2h", "1d"; at least 1 minute) or `at` ' +
    '(ISO 8601 date-time, at least 1 minute from now), plus the message you will receive when it fires. ' +
    'Only one wake-up is kept per chat: a new one replaces the previous one. It fires within the ' +
    "Repository's working hours. Prefer this over built-in timers, which are lost if the session stops.",
  inputSchema: {
    type: 'object',
    properties: {
      delay: { type: 'string', minLength: 2, maxLength: 20 },
      at: { type: 'string', format: 'date-time' },
      message: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    required: ['message'],
    oneOf: [{ required: ['delay'] }, { required: ['at'] }],
    additionalProperties: false,
  },
} as const;
export const MIN_WAKEUP_MS = 60_000;
// Result text: `Wake-up scheduled for <ISO>` plus `(replaced the previous one)` / `(first run within working hours: <ISO>)`.
export function scheduleWakeup(ctx: ChatToolContext, input: unknown): Promise<ToolResult>;

// src/core/chats/timers.ts
export function setTimer(db: Database, sessionId: number, timer: PendingTimer): { replaced: PendingTimer | null };
export function cancelTimer(db: Database, sessionId: number): boolean;
// Earliest instant >= fireAt inside the effective working hours (uses isWithinWorkingHours semantics).
export function nextFiringTime(fireAt: number, workingHours: Config['schedule']['workingHours']): number;
// Enqueues one `timer` Run per due, open Chat whose tip is finished and that has no queued/running turn and no close request;
// clears the timer in the same IMMEDIATE transaction. Returns the Run ids enqueued.
export function fireDueChatTimers(deps: { db: Database; clock: Clock; queue: QueueService; configFor: ConfigFor }): number[];

// src/core/runs/runExecutor.ts
adoptTurn(run: Run, handle: TurnHandle): Promise<RunFinal>; // watchdog + finalizeRun for an already-running `agent` Run
```

**Timer and unprompted-turn rules:**

- **Timer delay.** Parsed with `parseDuration`. A delay under `MIN_WAKEUP_MS`, an unparsable value, an `at` less than one minute from now, or both or neither of `delay`/`at` all return a tool error (`isError: true`) and change nothing.
- **Working hours.** The stored `timer_fire_at` is the requested time. The scheduler fires only when `isWithinWorkingHours(now, configFor(repository).schedule.workingHours)`, so a timer due outside hours waits for the next window, as scheduled Automation checks do. The tool result reports `nextFiringTime` so the agent knows.
- **Timer Run.** Priority 1 (scheduled work), `reason 'timer'`, `adhoc_prompt` = the timer message, parent = Chat tip, and the session's provider and model. Its prompt is `Scheduled wake-up (set <ISO>):\n\n<message>`.
- **When the Chat is busy at the due time.** If the tip is running or queued, or a question turn is mid-wait, the timer stays pending and fires on the first scheduler tick after the Chat is idle. A pending question does not block a timer.
- **Cancel and close.** Cancel from the UI and Close chat both clear the timer columns.
- **Restart.** The timer columns survive restart, and the scheduler fires the timer after restart even though the process starts lazily.
- **Unprompted turns.** On `turn-start prompted=false` with no Automator turn in flight, the manager does the following in one IMMEDIATE transaction:
  - it inserts a `runs` row `status 'running'`, `trigger 'agent'`, `priority 0`, `reason 'agent'`, `adhoc_prompt NULL`, `isolation 'copy'`, `started_at now`, owner = Chat owner, parent = Chat tip;
  - it re-parents any queued turn of the Chat onto the new Run (clarification 15).

  It then calls `executor.adoptTurn`. Turn end follows the driver's signal, or the settle window from the PR 3 spike. ChatPane shows `agent` turns with the request label `Chat.agentTurn`, and `timer` turns with `Chat.timerTurn` plus the message.

- **Native timer warning.** It is shown on every Interactive Chat whose provider has `nativeTimers: true`. Text: "Timers set by the agent's built-in tools (for example Claude /loop) are lost if this session's process stops (idle timeout, eviction, restart or close). Ask the agent to use Automator wake-ups for reliable continuation."

**Tasks:**

- [ ] **Step 1: Write the migration test** (`migration 30 adds timer columns`). Confirm it fails, then implement.
- [ ] **Step 2: Write `chatTools.test.ts` additions.**
  - `schedule_wakeup accepts a delay or an absolute time`;
  - `rejects delays under one minute, past or near times, both or neither fields`;
  - `a new wake-up replaces the pending one and says so`;
  - `reports the first firing time inside working hours`;
  - `rejects a closed session or wrong nonce`.
- [ ] **Step 3: Write `timers.test.ts`.**
  - `nextFiringTime skips nights and non-working days`;
  - `fireDueChatTimers enqueues one timer Run on the tip and clears the timer`;
  - `does not fire outside working hours, for closed or close-requested Chats, or while a turn is queued or running`;
  - `fires after a simulated restart` (a fresh `QueueService`/DB handle with the same file);
  - `concurrent ticks cannot enqueue twice`.
- [ ] **Step 4:** Run `npx vitest run src/core/chats/chatTools.test.ts src/core/chats/timers.test.ts` and confirm the tests fail. Implement `timers.ts`, `scheduleWakeup`, MCP registration, and the pi extension tool. Rerun until the tests pass.
- [ ] **Step 5: Write the scheduler test `scheduler tick fires due chat timers` in `scheduler.test.ts`**, including the case where no Automation is due. Implement it in `Scheduler.tick` as a guarded step that does not depend on `dueWatches`. Add `queue` and `configFor` usage through the existing deps. Confirm the test passes.
- [ ] **Step 6: Write the unprompted-turn tests.**
  - `sessionManager.test.ts`:
    - `an unprompted turn creates a running agent Run on the Chat tip and streams into its transcript`;
    - `a queued turn is re-parented under the agent Run so the chain stays linear`;
    - `an unprompted turn ends by the driver signal or the settle window`.
  - `runExecutor.test.ts`: `adopted agent turns are supervised and finalized done`, and `cancelling an agent turn cancels it`.
  - `queueService.test.ts`: `claimNext waits for a running agent turn of the same Chat`.

  Implement the changes and confirm the tests pass.

- [ ] **Step 7: Write the close and cancel tests.**
  - `queueService.test.ts`: `closing a Chat cancels its timer` and `cancelChatTimer clears only that Chat's timer`.
  - `app/actions/chat.test.ts`: `cancelChatTimer needs write on the Run`.

  Implement the changes.

- [ ] **Step 8: Write the prompt and read-model tests.**
  - `the first interactive prompt prefers schedule_wakeup over native timers`;
  - `thread view exposes the pending timer`;
  - `agent and timer turns are labelled in the thread`.

  Implement the ChatPane timer card (fire time via `app/lib/format.ts`, message, Cancel through `ConfirmDialog`) and the native-timer warning.

- [ ] **Step 9: Add the e2e scenario `a pending wake-up is listed and can be cancelled`.**
- [ ] **Step 10: Update README.** Cover timers, the rules, working hours, restart survival, native timer loss, and `agent` turns. Add to the smoke checklist: schedule a 1-minute wake-up, restart Automator, confirm it fires; for Claude, run `/loop` and confirm an `agent` Run.
- [ ] **Step 11: Verify.** Run `npx vitest run src/core/chats src/core/scheduler src/core/queue src/core/runs src/core/db src/core/read-models app/actions`, then `npm run check`, then `npm run e2e -- --grep "wake-up"`.

**Acceptance criteria:**

- `schedule_wakeup` enforces one timer per Chat, the 1-minute minimum and working hours. It survives restart, can be cancelled from the UI, and is cancelled on close.
- Fired timers appear as `timer` Runs. Native unprompted turns appear as `agent` Runs in the same linear Chat chain.
- The prompt and UI state the native-timer caveat.

**Risks / open spikes:**

- Unprompted-turn detection and termination over each ACP adapter (PR 3 spike item i). If a provider emits nothing observable, its `nativeTimers` flag stays `false` and the warning is not shown for it.
- An `agent` turn bypasses `maxConcurrent` (clarification 15). If this becomes a problem, it is documented, not throttled, because throttling would require pausing the provider.
- Clock skew between the MCP process and the scheduler is irrelevant, because both read the same system clock through `Clock`. Tests use the injected clock.

---

## Final cross-PR verification (after PR 5)

- [ ] `npm run check` passes.
- [ ] `npm run build && npm run e2e` passes.
- [ ] `git diff --check` is clean.
- [ ] Review the complete diff for Follow-up or Automation behaviour changes beyond the live transcript, secret exposure in new processes, a dashboard that spawns or signals provider processes, and missing translations.
- [ ] Run the README live smoke checklist manually for each provider the spike marked supported, and record CLI versions in README. It is not run in CI.
