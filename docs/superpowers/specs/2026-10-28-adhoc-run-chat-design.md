# Ad-hoc run chat: design

## Problem

An Ad-hoc run executes `copilot -p … --no-ask-user` with stdin ignored. When Copilot needs a clarification or a follow-up decision, the user has no way to answer from the dashboard. The Run can only end as "needs you".

## Goal

Let the user converse with Copilot from the Run detail page:

- **Live**: while the Run is active, Copilot may ask a question in the chat and the same Run continues once the user replies.
- **Follow-up**: after the Run has ended, a new message continues the work by resuming the Copilot session.

Typical use is clarifications and follow-ups. Success means the user can answer Copilot without leaving the dashboard, and that a Run never holds the Repository checkout indefinitely while waiting.

## Scope

- Ad-hoc runs only. Watch Runs keep the current non-interactive flow (consistent with ADR 0002).
- Out of scope: streaming partial tokens, editing or deleting messages, attachments.

## Design

### Data

Phase 1 migration (version 3):

- `runs.session_id TEXT`: the Copilot session id, persisted before Copilot starts so it survives a worker crash. A new Ad-hoc Run gets a generated UUID passed as `--session-id`; a follow-up Run reuses its parent's id.
- `runs.parent_run_id INTEGER` (`ON DELETE SET NULL`): set on a follow-up Run, pointing at the Run it continues.

In phase 1 the chat thread is derived from the chain of linked Runs (each Run contributes its request and its summary or error), so no message table is needed yet.

Phase 2 migration: table `run_messages` (`id`, `run_id`, `role` (`user` | `agent` | `system`), `body`, `created_at`, `delivered_at`, NULL until a user message reaches Copilot). The web app and the worker are separate processes; the database is their shared channel for live delivery.

### Chat UI

- A new **Chat** tab in the Run detail tabs, with a composer.
- The thread shows messages from the whole chain of linked Runs (root Run and its follow-ups).
- The `sendRunMessage` server action validates the request and enqueues a follow-up Run (phase 1). It does not talk to Copilot.
- A follow-up that has not started shows as "queued". The page keeps auto-refreshing while any Run in the chain is active.

### Follow-up mode (phase 1)

- A user message on a finished Ad-hoc Run that has a `session_id` creates a new queued Run: `trigger = adhoc`, same Repository and model, `parent_run_id` set, request text = the message.
- The launcher adds `--resume <session_id>` (or `--session-id`) for such Runs.
- The new Run goes through the existing queue, Repository lock, transcript and outcome handling. Each turn keeps its own history rather than reopening a finished Run.
- A message on a queued or running Run is stored and, once phase 2 exists, delivered live; in phase 1 messages on an active Run are rejected with a clear error.

### Live mode (phase 2)

- For Ad-hoc Runs the launcher starts `copilot --acp` and speaks JSON-RPC over stdio instead of using `-p`.
- Agent output and questions are written to `run_messages` and to the transcript.
- The worker's watchdog tick polls for undelivered user messages and delivers them to the live process, then sets `delivered_at`.
- While Copilot waits for a reply, the Run timeout is paused.
- If no reply arrives within `runs.liveReplyWaitMs` (default 300000, i.e. 5 minutes), the process is ended and the Run finishes as `needs-you`. The Repository lock is released and `session_id` is kept, so a later message continues as a follow-up.
- The Ad-hoc prompt rules change from "nobody answers questions" to "ask in the chat when a decision is needed". The safety rules (never allowed, only-on-explicit-request, untrusted content, escalation) are unchanged.
- Cancel works as today.

### Errors

- Worker down: messages stay "queued" and are shown as such.
- A follow-up whose parent Run has no stored session id fails with `SESSION_RESUME_FAILED`; any other resume failure surfaces as the usual `EXIT_NONZERO`. In phase 2, ACP failure or an unexpected exit fails the Run with `ACP_FAILED`. There is no silent fallback to `-p`.
- A follow-up message is accepted only on the latest finished Ad-hoc Run of a thread, up to 20000 characters.
- Worker crash recovery keeps `session_id`, so a follow-up is still possible.

### Testing

- Phase 1: service and action tests (create follow-up Run, validation), launcher argument tests, read-model tests for the thread.
- Phase 2: a fake ACP agent script (in the style of the existing fake launcher) for executor tests covering reply delivery, the 5-minute wait expiry, cancel and ACP failure.
- A Playwright smoke test for the Chat tab.

## Phasing and risks

- Phase 1: migration, read model, Chat tab and composer, follow-up via `--resume`.
- Phase 2: ACP launcher and client, live delivery, wait window.
- Risk: how Copilot's ACP surfaces "ask the user" requests is not yet verified. Phase 2 starts with a short spike against the real `copilot --acp`; if it falls short, the design stays valid with follow-up only.
- Docs to update on implementation: GLOSSARY.md (Chat, follow-up Run) and ADR 0002 consequences (Ad-hoc runs may now ask questions).
