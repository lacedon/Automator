# Automator

A personal tool that keeps track of outside work items (merge requests, Jira tickets) that need follow-up, and periodically lets Copilot act on them.

## Language

**Automation**:
A locally stored record of one outside item that needs follow-up in the future, together with instructions for acting on it.
_Avoid_: Watch (the former name), Ticket, task, tracker, follow-up

**Repository**:
A Settings-managed record stored in SQLite that names a local codebase folder, service connections, and validation commands. Automations and Runs refer to it by name.
_Avoid_: Workspace, project (when referring to the configured Repository)

**Automation kind**:
The type of outside item an Automation points to: a GitLab merge request, a GitHub pull request, a Jira ticket, or a free-form item (any URL plus instructions).
_Avoid_: Type, category

**Ticket**:
An issue in Jira. Never used for local records.
_Avoid_: Jira issue (in prose), task

**Run**:
One execution of Copilot, either to follow up on an Automation or to carry out an ad-hoc request, with a retained outcome and transcript.
_Avoid_: Session, check

**Ad-hoc run**:
A Run requested directly by the user without an associated Automation. It happens once and may optionally be _for_ a Ticket; without one it is a generic request. A finished one can be followed up by replying in its Chat tab.

**Chat**:
An Ad-hoc run together with the Runs that continue it (one per turn), listed once (as its newest Run, titled by its first request) in the Chats list and left menu. A Chat has a fixed Chat mode. Runs created for an Automation are not chats; they appear only on that Automation's page.

**Chat mode**:
How a Chat continues, chosen when the Chat is created and fixed for its life: Follow-up mode or Interactive mode. Branching a Chat keeps its mode.
_Avoid_: Chat type

**Follow-up mode**:
The default Chat mode. Each reply starts a new one-shot provider process that resumes the provider session. A Follow-up Chat has no Chat session.

**Interactive mode**:
A Chat mode in which one long-lived provider process per Chat can ask the user questions mid-turn and schedule itself to continue later. It works in its own copy of the Repository folder, never the shared checkout. Available for Claude Code and pi; the other providers stay disabled until their ACP session resume is verified. Each message is a turn, recorded as a Run with outcome `done` (shown as "Replied"); the Chat's process stops after an idle timeout and resumes by provider session id on the next message.

**Chat session**:
The stored record of an Interactive Chat: provider, model, Agent, provider session id, close state and its one pending **Wake-up**. The Runs of one Interactive Chat all refer to it.

**Wake-up**:
The Automator timer an Interactive Chat's agent sets with `schedule_wakeup` (at least 1 minute ahead, one per Chat). The scheduler fires it within the Repository's working hours as a `timer` Run. Different from a provider's built-in timer (for example Claude Code `/loop`), which fires inside the live process as an unprompted `agent` Run and is lost if the process stops.

**Waiting for you**:
The state of an Interactive Chat whose agent asked the user a question (the Automator `ask_user` tool or a provider's native question) and has not been answered yet. The turn waits for `runs.questionWaitMs`; after that the turn ends and the Chat keeps waiting, and the answer starts an `answer` turn. Distinct from **Needs you**, which is an Automation state.

**Follow-up run**:
An Ad-hoc run started by replying in the Chat tab of an earlier Ad-hoc run; it resumes the same provider session.
_Avoid_: continuation, reopen

**Workflow type**:
The kind of work a Run performs: MR Automation, Jira Automation, Free Automation, Ticket Ad-hoc, or free-form Ad-hoc.
_Avoid_: Trigger

**Project**:
A named group of Repositories used to separate work visually. A Repository belongs to at most one Project; Repositories without one are "Unassigned". Selecting a Project in the top bar scopes Home, Automations, Queue, Runs and Ad-hoc to its Repositories and tints the UI with the Project's colour.

**Project overrides**:
Sparse per-Project settings (Schedule, Copilot bin, Provider, Runs, Cleanup, GitLab/GitHub/Jira/Teams) edited in Settings → Projects → Settings. Blank inherits the global config; effective config is computed at use from global plus the Repository's current Project, so a Repository without a Project uses global. Applies to newly started work only; Runs keep no snapshot. Precedence: per-Run/Automation values > Repository > Project overrides > global. Credentials are env-var names only (`tokenEnv`, `emailEnv`); secrets stay in `.env`.
_Avoid_: Workspace

**Prompt addition**:
Optional free text on a Project or Repository, appended after a `---` rule under `# Project clarifications:` then `# Repository clarifications:` headings at the end of every Automation and Ad-hoc prompt. Blank additions are skipped.

**Agent**:
A reusable set of instructions selected for a Repository and Workflow type.

**Agent assignment**:
The selection of one Agent for a Workflow type, either for a specific Repository or as the installation-wide default.

**Operation template**:
Optional shared instructions for a kind of operation, subordinate to an Agent's instructions.

**Needs you**:
An Automation state indicating that follow-up requires a human decision before automatic work can continue.

**Closed Automation**:
An Automation whose follow-up has ended, either because its merge request was merged or closed, or because the user closed the Automation.

**Telegram bot**:
An optional remote control that runs inside the worker and polls Telegram over outbound HTTPS (no webhook, port or tunnel). A Telegram account is linked to an Automator user with `/login <access token>`; the token is not stored, and the bot acts with that user's permissions. It lists open Automations (every state except Closed), shows Runs and results, pauses, resumes, closes or runs Automations, starts and continues Chats (Follow-up runs), and pushes a message when an Automation needs you, a Chat Run finishes or a Run fails.
_Avoid_: Notifier (that is the Teams message sent for Needs you)

**Telegram link**:
The stored tie between one Telegram account (and its private chat) and an Automator user. It ends on `/logout`, or when the access token it was created with is revoked, regenerated or expires, or the user is disabled.
