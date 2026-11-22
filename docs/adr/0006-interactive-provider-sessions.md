# Interactive provider sessions

Chats used to be one-shot: every reply started a new provider process that resumed the provider session and exited. Interactive mode keeps one long-lived provider process per Chat so the agent can ask the user questions mid-turn and schedule itself to continue later. Follow-up mode and Automation Runs keep their current lifecycle.

## Decision

- A Chat has a fixed mode: Follow-up (default) or Interactive. Interactive Chats are recorded in `chat_sessions`; a Run with `chat_session_id IS NULL` belongs to a Follow-up Chat or an Automation. Branching keeps the mode and creates a new session.
- An Interactive Chat runs one long-lived provider process per Chat, in its own copy of the Repository folder under `<dataDir>/chat-workspaces/<sessionId>/`. It never uses the shared checkout, which amends [ADR 0001](./0001-serialize-runs-in-configured-repository-folders.md) for Interactive Chats only: they are not serialized against the folder.
- The common protocol is the Agent Client Protocol (ACP) over stdio (Copilot, OpenCode, and the Claude and Codex adapters), plus a pi RPC driver for pi. Both clients are written by hand, without new runtime dependencies.
- Questions to the user and timers are Automator-owned tools (`ask_user`, `schedule_wakeup`) offered to the provider, alongside the provider's native questions and timers where they exist.
- Each provider has capability flags (`src/core/chats/capabilities.ts`). Interactive mode is available only where the flag is true. A Run of an Interactive Chat for an unsupported provider fails with `PROVIDER_CAPABILITY_UNSUPPORTED`; Automator never switches provider or mode implicitly, and a failed resume never silently starts a new provider session.
- Only the worker starts and signals provider processes. The dashboard writes requests to SQLite (answers, close requests, timer cancels) and the worker polls them, as it does for `cancel_requested_at`.

## Consequences

- SQLite stays the only channel between the dashboard and the worker; no new IPC.
- Per-Chat copies live in `chat-workspaces/`, separate from the per-Run `workspaces/` directory that recovery clears, so a worker restart does not delete an open Interactive Chat's copy.
- The first release (schema, mode selector, capability gating) ships with every flag `false`: the option is visible but disabled, and the server rejects it. Later releases enable it per provider.
- `automator run` and `POST /api/runs` keep creating Follow-up Chats; choosing the mode is dashboard-only.
- An Interactive Chat's uncommitted copy work is not carried into a branch.
