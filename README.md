# Automator

A small personal tool to automate work with Jira and Git (GitLab or GitHub). It keeps track of outside items that need follow-up, such as merge requests waiting for review or Jira tickets. It checks them from time to time and runs a selected coding CLI when something needs doing. GitHub Copilot CLI remains the default. A local dashboard shows the current state.

> **Status:** v1 implemented.

See also:

- [GLOSSARY.md](./GLOSSARY.md): domain terms (Automation, Run, Repository, …)
- [ADR 0001: Serialize Runs in configured Repository folders](./docs/adr/0001-serialize-runs-in-configured-repository-folders.md)
- [ADR 0006: Interactive provider sessions](./docs/adr/0006-interactive-provider-sessions.md)
- [Architecture and implementation design](./docs/superpowers/specs/2026-10-21-architecture-design.md)
- [Dashboard UI design](./docs/superpowers/specs/2026-10-21-dashboard-ui-design.md)

## Getting started

Prerequisites:

- Node.js 24
- GitHub Copilot CLI installed and logged in (`copilot` on your `PATH`); it is the default Run provider
- For GitLab MR Automations: [`glab`](https://gitlab.com/gitlab-org/cli) installed and logged in (see below)
- For GitHub PR Automations: [`gh`](https://cli.github.com) installed and logged in (see below)

### Upgrading

From a terminal, stop any running Automator instance first (the command does not stop it), then run:

```
npm run upgrade-and-restart
```

It runs `git checkout master && git pull origin && npm ci && npm run build && npm run start`, stopping at the first failing step. It fails if the working tree has uncommitted changes that block the checkout or pull. The app runs in the foreground.

### GitLab access for Copilot

Copilot needs its own way to read and reply to MRs, because Automator removes `GITLAB_TOKEN` from the environment it starts Copilot with. GitLab's MCP endpoint (`/api/v4/mcp`) rejects classic personal access tokens (`403 insufficient_scope`), so use the `glab` CLI instead:

```sh
brew install glab
glab auth login --hostname gitlab.com --token <your token>   # a token with the `api` scope
glab auth status                                             # check it works
```

`glab` keeps the token in the system keyring (or in its config file, `~/.config/glab-cli/`, if no keyring is available), and Copilot's shell picks it up from there. Use the same host as the Repository's `gitlab.host`. Anything running as you, Copilot included, can read it.

### GitHub access for Copilot

GitHub works like GitLab: Automator reads pull requests with its own token, and Copilot needs its own access to read and reply to them. Use the `gh` CLI:

```sh
brew install gh
gh auth login --hostname github.com   # a login with the `repo` scope
gh auth status                        # check it works
```

Give Automator's token its own variable (for example `AUTOMATOR_GITHUB_TOKEN`, not `GITHUB_TOKEN`): Automator removes the configured token variables from the environment it starts Copilot with. A classic token needs the `repo` scope; a fine-grained token needs read access to pull requests, contents, checks and metadata. For GitHub Enterprise Server, set the connection's `host` to your server.

Set up and start:

```sh
npm install
cp automator.config.example.json automator.config.json   # then edit connections and Teams chat
cp .env.example .env                                     # then fill in GITLAB_TOKEN (and Jira tokens if used)
npm run build
npm start
```

`npm start` runs the dashboard and the worker together. Open <http://127.0.0.1:4317> (set `PORT` to change the port).

Add your local codebases on **Settings → Repositories**. If your existing `automator.config.json` has a `repositories` section, Automator imports it into SQLite the first time it starts with that database. After import, the database is the source of truth; later edits to the legacy config section are ignored.

Ctrl-C stops the dashboard at once, but the worker first waits for every active Run to finish (up to `runs.timeoutMinutes`) and records their results. Press Ctrl-C again (a second or more later) to force it to stop: the active provider processes are killed, and on the next start those Runs are marked interrupted and its Automation moves to Needs you.

CLI examples (the worker must be running for queued Runs to start):

```sh
npm run automator -- automation add <url> --repo <name>
npm run automator -- automation list
npm run automator -- run --repo <name> --prompt "Summarize open TODOs in src/"
npm run automator -- run --repo <name> --ticket ABC-123 --prompt "Use the existing helper"
```

`--ticket` takes a Jira key or any URL and the prompt is then optional. Jira keys are looked up for a title when the Run is queued; URLs are passed through as entered without provider-specific validation or Jira lookup. Like any ad-hoc Run, it goes straight into the shared queue, runs once and is driven by the prompt (branches, commits and MRs are allowed, never required). It never resolves discussions, force-pushes or pushes to protected branches, or deletes or reassigns tickets; merging or approving MRs and changing Jira statuses only happen when the prompt explicitly asks. See [ADR 0002](docs/adr/0002-ad-hoc-runs-are-prompt-driven.md).

## Run providers

Provider selection is installation-wide. Change it in **Settings → Configuration** or set `provider` in `automator.config.json`. Missing provider configuration continues to mean `copilot`. Copilot is configured like the other providers under `providers.copilot`; the legacy `copilotBin`, `runs.defaultModel` and `runs.models` keys are migrated there (and removed from the file) the next time the config is loaded, and legacy Project overrides are migrated by a database migration. The example config contains the executable, default model and supported-model list for each CLI; set a non-empty default model before selecting a non-Copilot provider. OpenCode and pi model IDs use the `provider/model` form. Run history stores the provider and model selected when the Run was queued, so later settings changes do not relabel old Runs or reroute queued/follow-up work.

Install each CLI and authenticate it as the same OS user that runs Automator, following its official setup guide:

| Provider                                    | Install / setup                                                                        | Native authentication               | Version check                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| GitHub Copilot CLI                          | [Install guide](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) | Complete login in the `copilot` CLI | `copilot --version`          |
| Claude Code                                 | [Setup guide](https://code.claude.com/docs/en/setup)                                   | `claude auth login`                 | `claude --version`           |
| OpenAI Codex CLI                            | [CLI guide](https://developers.openai.com/codex/cli)                                   | `codex login`                       | `codex --version`            |
| OpenCode                                    | [Install guide](https://opencode.ai/docs/)                                             | `opencode auth login`               | `opencode --version`         |
| pi                                          | [Install guide](https://docs.pi.dev/latest/quickstart)                                 | `pi auth login <provider>`          | `pi --version`               |
| Claude Code ACP adapter (Interactive Chats) | `npm i -g @agentclientprotocol/claude-agent-acp` (0.109.1 tested)                      | uses Claude Code's own login        | `claude-agent-acp --version` |
| Codex ACP adapter (not yet enabled)         | `npm i -g @agentclientprotocol/codex-acp`                                              | uses Codex's own login              | `codex-acp --version`        |

pi can be installed with `curl -fsSL https://pi.dev/install.sh | sh`.

Automator removes credential-like environment variables (API/access keys, tokens, secrets, passwords and credential-file paths) and configured Git/Jira credential variables before starting a coding CLI. For Copilot, its supported `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` authentication variables are preserved unless one is also configured as an Automator integration credential, and are marked secret so Copilot strips them from shell and MCP tool environments. Use each CLI's native login or supported authentication rather than putting provider credentials in the JSON config. Native auth stores remain in the OS user's profile; a coding agent with shell access is not isolated from files that user can read. Treat each provider account and its local credentials accordingly, and only run trusted repositories.

Every CLI starts in the selected Repository folder. Automator does not copy or translate repository instructions, skills, or MCP configuration; each CLI discovers these using its own conventions. For example, Copilot has its [custom-instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions), Claude Code uses `CLAUDE.md` and `.claude/skills/`, Codex uses `AGENTS.md` and `.agents/skills/`, OpenCode uses `AGENTS.md` plus `.opencode/skills/`, and pi discovers its own context files and skills. MCP servers and additional skills must be configured in the selected CLI's native format; see the linked provider documentation. The CLIs also differ in permissions: Codex uses the `workspace-write` sandbox and receives write access only to the current Run's artifact directory outside the Repository, Claude Code uses its non-interactive permission mode, OpenCode auto-approves permissions not explicitly denied, and pi has no permission model in non-interactive mode (it is not sandboxed). `runs.denyTools` is enforced by Copilot and pi (mapped to `--exclude-tools`); the other adapters fail visibly rather than ignoring it when it is configured.

Troubleshooting:

- `SPAWN_FAILED`: confirm the configured `bin` is installed and available to the worker. Use an absolute executable path if Automator runs as a service with a different `PATH`.
- `AUTH_FAILED`: complete the provider's native login as the Automator OS user, then restart Automator.
- `MODEL_UNSUPPORTED`: check the exact model ID against the provider CLI and add it to that provider's supported model list.
- `PROVIDER_CAPABILITY_UNSUPPORTED`: clear `runs.denyTools` or select Copilot, which is the only adapter that currently enforces that setting.
- `SPAWN_FAILED` in an Interactive Chat with Claude Code: the ACP adapter is missing. Install it with `npm i -g @agentclientprotocol/claude-agent-acp` as the Automator OS user, or set `providers.claude-code.acpBin` to its absolute path (default `claude-agent-acp`; Codex uses `providers.codex.acpBin`, default `codex-acp`).
- `SESSION_RESUME_FAILED`: the provider no longer knows the Chat's session (for example its session store was cleaned). The Chat's copy is intact; start a new Chat or branch it.

### Interactive Chats

A Chat created in **Interactive** mode keeps one provider process alive across its messages instead of starting a new one per reply. It is available for Claude Code (through the ACP adapter above) and pi. Copilot, Codex and OpenCode have ACP drivers that are covered by tests but stay disabled in the mode selector until their session resume is verified; their Chats can only use Follow-up mode.

- **Own copy.** An Interactive Chat works in a full recursive copy of the Repository folder under the Data Dir `chat-workspaces/<chat session id>/`, never in the shared checkout, regardless of `runs.isolation`. The copy is made on the first message and costs disk space like a copy-isolated Run. It survives worker restarts.
- **Turns.** Each message is one Run (trigger `adhoc`, outcome `done`, shown as "Replied"). Its summary is the agent's last message. No result file is required, and `result.json` is still written. Runs of one Chat never overlap, and they count toward the Repository's `runs.maxConcurrent`.
- **Idle timeout and eviction.** A process with no turn for `runs.interactiveIdleMinutes` (default 30) is stopped. At most `runs.maxInteractiveSessions` (default 3) processes live at once; starting another stops the least recently used idle one. Both can be overridden per Project. The next message restarts the process lazily and resumes the provider session by id; if the provider cannot resume, the turn fails with `SESSION_RESUME_FAILED` and no new session is started silently.
- **Restart.** A turn running when the worker restarts is recorded as interrupted and its process is killed; the copy is kept.
- **Close chat.** **Close chat** stops the process and deletes the copy. If the copy has uncommitted changes or commits that no remote has, you must confirm first. Deleting the last Run of a Chat also closes it. A closed Chat accepts no more messages.
- **Tool policy.** Permission requests are answered by policy and never shown to you; the rules are the same as in Follow-up mode (Agent tool settings only for Copilot, `runs.denyTools` for pi and Copilot). Questions are the one exception, see below.
- **Questions.** The agent can ask you something in the middle of a turn. A question shows in the Chat as a card that replaces the message box: buttons for a choice (plus an "Other answer" field), or a text field for a free-text question. While it is open, the Chat is **Waiting for you** (pill in the thread, the left menu and the Chats list). This is separate from **Needs you**, which is an Automation state; Waiting for you does not change when a finished Run can be closed, and it sends no Teams notification.
  - _Where questions come from._ Every Interactive provider gets Automator's own `ask_user` tool: Claude Code through a stdio MCP server that Automator passes in `session/new`/`session/load` (`node bin/automator.mjs mcp --chat-session <id> --nonce <hex> --config <file>`), and pi through the bundled extension (below). Claude Code's own `AskUserQuestion` is mapped as well (`elicitation/create`; Automator advertises `elicitation.form`). pi has no built-in question tool; any extension dialog (`select`, `confirm`, `input`, `editor`) becomes a question too, but the user's own extensions are not loaded (`--no-extensions`).
  - _Waiting time._ `runs.questionWaitMs` (default `600000`, 10 minutes; Settings → Configuration → Runs, per-Project override as a duration such as `10m`) is how long the turn waits. An answer in that time continues the same turn. After it, the agent is told `No answer yet. Stop and wait for the user` (for a native Claude question, the same text goes in as the custom answer, which makes the model stop cleanly; see the PR 4 follow-up in the provider spike), the turn ends as "Replied", and the Chat stays Waiting for you. Your later answer starts exactly one new turn (trigger `answer`) whose message is `Answer to your earlier question "<question>":` followed by your answer. The Run timeout (`runs.timeoutMinutes`, default 30) still applies to the whole turn, waiting included.
  - _One question at a time._ A second `ask_user` while a question is open is a tool error. You cannot send a normal message while a question is open (the server rejects it); answer it, or close the Chat. A worker restart expires a question whose turn was running, so your answer starts a new turn.
  - _The pi extension_ is plain JavaScript (no build step) at `src/core/chats/pi/automatorExtension.mjs` in the installed app. The pi driver loads it with `--no-extensions -e <that file>`. It registers the Automator chat tools from a JSON spec in the `AUTOMATOR_CHAT_TOOL` environment variable and runs each by calling `node bin/automator.mjs chat-tool <name> …` (JSON on stdin and stdout). It stops waiting when pi aborts the tool.
  - _Security and limits._ The session nonce is visible in the `mcp` process's argv and in pi's environment; it only ties a tool call to its Chat and is not a security boundary (anything that can read the SQLite file or run as your user can answer questions). The MCP server spec given to ACP providers has an empty `env` (no secrets). A pi dialog that times out is cancelled; pi offers no custom-text escape, so the late answer cannot reuse it. The `mcp` and `chat-tool` processes do not run migrations, so they must come from the same install as the worker.
  - _Troubleshooting._ The `mcp` and `chat-tool` commands are hidden, are started by the provider, and need no network. They open the SQLite file named by the config's `dataDir`. If a provider cannot start them, check that the worker's `node` can run `bin/automator.mjs`, and look at the Chat's log under `chat-sessions/<id>.log`.
- **Timers.** The agent can continue a Chat later with Automator's `schedule_wakeup` tool (`delay` such as `15m`, `2h`, `1d`, or an absolute ISO `at`, plus the message it wants back).
  - _Rules._ One wake-up per Chat (a new one replaces the old one and the tool result says so); at least 1 minute (`MIN_WAKEUP_MS`) and at most 30 days (`MAX_WAKEUP_MS`) ahead, otherwise the tool returns an error and nothing changes; stored in SQLite, so it survives worker restarts and the lazily restarted session. It fires only within the Repository's effective working hours (`schedule.workingHours`): a timer due at night or on a weekend waits for the next window, and the tool result tells the agent when that is. The worker's scheduler (every 30 s) enqueues it as a `timer` Run (priority 1, reason `timer`) on the Chat's latest Run, with the message `Scheduled wake-up (set <time>):` followed by the agent's message. If a turn of the Chat is queued or running at that time the timer waits for the first tick after the Chat is idle; a waiting question does not block it. A Chat that cannot fire its wake-up for a permanent reason (unknown Repository, provider no longer available) has the timer cancelled and a line logged by the worker; one such Chat never blocks the others. The Chat shows the pending wake-up with the time it can actually fire (moved into working hours when needed), the message and a **Cancel wake-up** button (it says so when nothing was pending); **Close chat** cancels it too.
  - _Native timers (Claude Code)._ Claude Code's own timers (`/loop`, `CronCreate`) fire inside the live process with no prompt from Automator. Automator records each such turn as an `agent` Run (trigger `agent`) on the Chat's latest Run and shows it as "Started by the agent (built-in timer)". It ends when the adapter reports the final usage (cost) or after `AGENT_SETTLE_MS` (5 s) without any update, but never while one of its tool calls is still pending or running (a long tool is silent, not finished). Cancelling an `agent` turn sends `session/cancel`, and the adapter's tail output is then ignored until it reports the final usage or goes quiet for 5 s, so it cannot start a new `agent` Run. These timers are lost if the session process stops (idle timeout, eviction, restart or close), which is why the first prompt tells the agent to prefer `schedule_wakeup`, and the Chat shows a warning for providers with native timers. An `agent` turn does not go through the queue, so it ignores `runs.maxConcurrent`; a queued message of the same Chat waits behind it and one Chat never runs two turns at once. pi has no native timers.
- **pi** sessions are stored in the Data Dir `chat-pi-sessions/`, not in your own pi directory. Protocol logs are written to `chat-sessions/<id>.log`; account details are never logged.
- **API.** A finished interactive turn reports `"outcome": "done"` with the agent's last message as `summary`.

### Provider smoke checklist

Run this checklist separately for each provider in a trusted test Repository. Record the output of the version command in the table above when you test; Automator does not pin or reject CLI versions. Automated tests use fake CLIs, and no live provider CLI smoke test was run for this implementation.

1. Install the CLI, record its version, complete native authentication, and confirm the CLI reports that it is ready.
2. Select the provider and configure its executable, default model and supported models in Settings; restart Automator.
3. Queue an ad-hoc Run and confirm its selected model, transcript, result and provider label in Run history.
4. Create an Automation in the same Repository, trigger an Automation Run and confirm its transcript, result and provider label.
5. Cancel a running test Run and verify it is recorded as interrupted. Send a follow-up to a completed Run and verify it continues the same provider session.
6. Interactive (Claude Code and pi only): create an Interactive Chat and send two messages; confirm both turns share one process (the session log under `chat-sessions/<id>.log` has a single `spawned … (pid N)` line for them, and the Chat's pid does not change) and one copy. Stop the process (wait for the idle timeout or lower `runs.interactiveIdleMinutes`), send a third message and confirm it remembers the earlier context. Leave an uncommitted file in the copy and confirm **Close chat** warns before deleting it.
7. Questions (Claude Code and pi): ask the agent to call `ask_user` with two options. Confirm the Chat shows Waiting for you in the thread, the left menu and the Chats list, and that clicking an option continues the same turn. Repeat with `runs.questionWaitMs` set to `20s` and no answer: the turn ends as "Replied", the Chat stays Waiting for you, and a later answer starts one `answer` Run. For Claude Code also ask it to use its own question tool (`AskUserQuestion`) and answer once in time and once not at all.
8. Timers (Claude Code and pi): ask the agent to call `schedule_wakeup` with a 1-minute delay while the working hours cover now; confirm the Chat lists the wake-up, and that a `timer` Run starts about a minute later (within the scheduler's 30 s tick). Repeat and restart Automator before it fires; confirm it still fires. For Claude Code, ask it to schedule a one-shot `CronCreate` for a minute ahead and confirm an `agent` Run appears and ends.

Tests:

```sh
npm test        # unit and integration tests (Vitest)
npm run e2e     # Playwright smoke tests; first run: npx playwright install chromium
npm run check   # type check, lint, dependency rules and Vitest
```

## Goals

1. Run the selected coding CLI in a chosen folder, with that folder's local skills and the configured MCP servers.
2. Create and delete **Automations** (local records of items that need follow-up later) in a local SQLite database.
3. Check Automations from time to time and run the selected provider when something needs doing. Most Automations will be pending merge requests: check for new comments, reply to them and make the requested changes.
4. Show the Automations and Runs in an HTML dashboard.

## Technology

- Node.js, TypeScript (ESM)
- Next.js App Router for the dashboard
- `better-sqlite3` for storage
- GitHub Copilot CLI, Claude Code, OpenAI Codex CLI, OpenCode or pi as the Run provider

## Architecture

- **Local accounts.** Every request except the sign-in page needs a session (unauthenticated pages redirect to `/login`; other requests get 401). Sessions last 7 days, are stored hashed and end on sign-out or when the user is disabled. Passwords are stored as salted scrypt hashes. An installation with no users gets `admin`:`admin` on startup, so existing installations migrate without lock-out; the first user also becomes the global Administrator. The server listens on `127.0.0.1` by default; set `HOST` (for example `HOST=0.0.0.0 npm start`) to serve a shared installation, and put TLS in front of it.
- **Audit log.** Sign-ins, sign-outs, access changes, tokens and credentials are logged to the process output (`audit: ...`), never to the database or UI. See [ADR 0005](docs/adr/0005-authenticated-shared-installation.md).
- **Access tokens.** Each user creates tokens at `/account` (several, optionally expiring); a token is shown once and can be regenerated or revoked. Clients send `Authorization: Bearer <token>` and act with that user's permissions; only a hash is stored, and a disabled user's tokens stop working.
- **Credentials and background Runs.** Each user stores their own credentials at `/account` (encrypted with a key in `<dataDir>/credentials.key`, never shown again). A Run gets its owner's credentials in the provider environment, falling back to the server's value when the owner has none; Repository connection tokens used by pre-checks remain server-wide. A Run acts with its owner's current permissions: a queued Run fails to start, and a running one is stopped, once the owner is disabled, deleted or loses write on its Repository.
- **Roles and permissions.** Roles are configured in Settings → Users & roles as sets of two permissions: `read` (see everything in a Project) and `write` (do actions with everything; includes `read`). A user can hold several roles, each assigned globally or for one Project; a permission is held if any assignment grants it, so nothing conflicts and access is denied by default. Managing users, roles and global settings takes a global `write`; the last global writer cannot be removed. There are no direct User–Repository grants: Project access covers every Repository in the Project. Server Actions, pages and file routes enforce this on the server: global settings need a global `write`, acting on an Automation or Run needs `write` on its Repository's Project, and lists, the project switcher and detail pages only show what the user can `read` (others answer 404). Existing Automations and Runs belong to `admin`; new ones belong to their creator.
- **Two processes, one start command:** the Next.js dashboard and a separate long-running **worker** that schedules checks and runs the selected provider. Both use the same SQLite database.
- **Repositories:** Repository records are managed in Settings and stored in SQLite. Each names a local folder, a GitLab and/or GitHub connection, an optional Jira connection, and validation commands. Connection hosts and credential environment-variable references remain in config. Every Automation and ad-hoc Run refers to a Repository by name; target URLs are matched against its named service connections. The selected CLI starts directly in the folder, so its supported local instructions, skills and MCP setup apply. The automator never clones repositories or creates worktrees.
- **Per-Repository queue:** Runs for different Repositories execute at the same time, while queued Runs wait in order for their own Repository without blocking the others. With the default `runs.isolation: "shared"`, a Repository (or several Repository records pointing at the same folder) runs one Run at a time in its configured folder. With `runs.isolation: "copy"`, each Run works in a full recursive copy of the folder (including `.git` and untracked files) under the Data Dir `workspaces/` folder, up to `runs.maxConcurrent` (default 2) Runs per Repository at once; the copy is deleted when the Run ends, and copies orphaned by a crash are removed at the next worker start. Interactive Chat turns always run in the Chat's own long-lived copy under `chat-workspaces/` (see Interactive Chats), count toward `runs.maxConcurrent`, and never overlap within one Chat. Both settings can be overridden per Project. Several protections stop the same work from running twice, including across processes.
- **Provider sessions:** each new Run starts a new provider session; a follow-up resumes its parent Run's session. Prompts include the Automation instructions, summaries of recent Runs and any resolution note you left.

## Domain

### Automation kinds

| Kind        | Target                              | Default behavior                                                    |
| ----------- | ----------------------------------- | ------------------------------------------------------------------- |
| GitLab MR   | Merge request URL                   | Handle new outside comments, pipeline failures and merge conflicts  |
| GitHub PR   | Pull request URL                    | Handle new outside comments, failed checks and merge conflicts      |
| Jira Ticket | Ticket key/URL                      | Look at changes and comments, and reply when the next step is clear |
| Free-form   | Any URL + **required** instructions | Follow the Automation's instructions                                |

Every Workflow type uses an Agent assigned to its Repository, falling back to the installation default. An optional operation template is shared by that Workflow type. Agent and template instructions live in local SQLite, not tracked prompt files; fixed Automator safeguards always take precedence. An Agent with empty instructions blocks Runs until it is configured. An Agent can also set **Allow all tools** (default on), **Allowed tools** and **Blocked tools** (Copilot tool patterns such as `shell(git push)`, one per line). Unchecking **Allow all tools** replaces `--allow-all-tools` with `--allow-tool` for each allowed entry; blocked entries are added to the global `runs.denyTools`, which always applies. Non-Copilot providers fail with `PROVIDER_CAPABILITY_UNSUPPORTED` for an Agent with custom tool settings. Each Automation can also use a different model. Agents open in modal editors, with an **Open full page** link (`/settings/agents/<id>`) for editing with the full window. Provider selection remains installation-wide in Settings → Configuration.

### Automation states

- **Active**: checked on its schedule.
- **Paused**: paused by you.
- **Needs you**: a human decision is needed, so scheduled checks stop until you resume.
- **Closed**: follow-up has ended. History is kept until cleanup.

Rules:

- Only one non-Closed Automation is allowed per normalized target and Repository. A duplicate is rejected with a visible error that points to the existing Automation, including when you reopen a Closed Automation.
- You can edit the instructions, interval, model and initial-review policy. Changing the target or Repository needs a new Automation.
- An Automation closes automatically when its MR is merged or closed.
- A Jira Automation closes automatically when its ticket reaches one of the configured Done status IDs, which you set per Jira connection. If none are configured, the Done status category is used. An explicitly empty list turns automatic closing off. Configured IDs are checked when the configuration is loaded, and their readable names are shown.
- Free-form Automations only close when you close them.
- Closed Automations never reopen automatically.

### Creating and deleting Automations

You can manage Automations from the dashboard or a CLI. Both go through the same validation and the same queue.

The former name for Automations was Watch. The CLI command `watch` remains a supported alias for `automation`, and `/watches` URLs redirect to `/automations`. Internal storage (the `watches` DB table) and stored workflow ids (`mr-watch` etc.) keep their old names for compatibility, so existing data needs no migration.

If the Repository name is unknown, creation is rejected and no Automation is saved. Instead: Instead:

- an **attempt-scoped** JSON error result file is written,
- the error and the file location are shown in the dashboard,
- the CLI exits with a nonzero code.

If the result file itself can't be written, that is reported too.

If a Repository's folder later disappears, its existing Automations move to **Needs you** and get an error result.

### Projects

Projects group Repositories so unrelated work stays visually apart. Manage them under **Settings → Projects**: create, rename, delete, and choose which Repositories each contains (a Repository belongs to at most one Project). The top-bar switcher scopes the dashboard to **All projects**, one Project, or **Unassigned** Repositories, and tints the UI with that Project's colour. Deleting a Project only unassigns its Repositories. Existing Repositories start unassigned, and the selection is remembered in a browser cookie. The old `/projects` link redirects to Settings.

## Checking and scheduling

### GitLab MR and GitHub PR pre-check

GitHub pull requests are checked the same way as GitLab merge requests, using the GitHub REST and GraphQL APIs: a failed check run on the latest commit counts as a failed pipeline, and review threads are the discussions. A cheap REST check runs before the selected provider is started. A Run is queued only when, since the last handled point, there is at least one of these:

- a new comment or discussion by **someone other than you**,
- a failed pipeline on the latest commit,
- a new merge conflict.

Further rules:

- Events that arrive during a Run stay pending for the next check.
- An unchanged event that was already handled doesn't start a new Run.
- `initialReview` decides what happens with existing comments when an Automation is created. It can be set globally and per Automation:
  - `baseline-only` (default): ignore existing comments.
  - `unresolved`: review existing unresolved discussions once.

  Failed pipelines and conflicts count in both modes.

- **Run now** can also be asked to review existing unresolved discussions.
- GitLab or GitHub credentials are required. If they are missing or invalid, or can't access the MR, the Automation moves to **Needs you** after a limited number of retries for temporary failures. It doesn't fall back silently.

### Jira

- `jira.enabled` turns Jira checking on or off for everything. It is **off by default**.
- While it's off, Jira Automations are kept and shown, but they don't run on schedule or through Run now. The dashboard explains why.
- While it's on:
  - With a configured REST token, a cheap change-detection pre-check runs. It uses the change history to ignore your own changes.
  - Without a token, the selected provider checks the ticket through MCP on the normal interval.
  - If a token is configured but invalid, the check fails visibly.

Credentials are always set explicitly. They are never taken from MCP settings.

### Free-form

Free-form Automations always run the selected provider on their interval.

### Schedule

- Default intervals: **15 min** for MRs and **2 h** for everything else. Each Automation can override its interval.
- Working hours: **Mon–Fri 08:00–19:00** local time by default, configurable (`start` must be earlier than `end`; overnight windows aren't supported). Scheduled work outside these hours waits.
- Manual and ad-hoc Runs ignore working hours and go ahead of queued scheduled work, but they never interrupt a Run that's already in progress.
- Scheduled work runs first-in, first-out (FIFO), with at most one queued request per Automation. Repeated triggers are combined into one.
- After sleep or a restart, each Automation that is due gets checked once. Missed intervals aren't replayed.
- Scheduling runs only in the worker, never in the browser, so it doesn't depend on the dashboard being open. Due pre-checks run up to 5 at a time and each is cut off after 90 s, so one slow or hung check (for example a stalled GitHub request) can't delay the others. A timed-out check counts as a failed check and is retried on the next interval.

## What the selected provider may do

### GitLab MRs: full autonomy

The selected provider may reply to discussions, fix code, commit and push to the MR's source branch, and address pipeline failures. Merge conflicts are not resolved automatically: the Automation moves to **Needs you** and nothing is merged, rebased or reverted. Before it changes anything, it must:

1. Re-read the current state of the MR, its branch and its discussions.
2. Be on the MR's source branch. If the checkout is clean but on another branch, the provider fetches and switches to the source branch itself (it never stashes or discards anything to do so); if the checkout isn't clean or the switch fails, it stops.
3. Run the Repository's configured validation commands.

It stops and marks the Automation **Needs you**, instead of guessing or pushing unchecked code, when:

- the checkout has uncommitted changes, an unfinished merge or rebase, or can't be safely switched to the source branch (your work is never stashed or thrown away automatically),
- a request is unclear or is a design disagreement,
- validation commands aren't configured or a required one fails (if a commit or push fails on a hook check, the provider first runs `npm ci` once and retries),
- the MR has merge conflicts with the target branch,
- updating the branch wouldn't be safe.

### Jira

By default the selected provider only looks at the ticket and replies. It may change code only when the Automation's instructions explicitly allow it.

### Never allowed

- Merging or approving MRs, or resolving discussions automatically
- Force-pushing, deleting remote branches, pushing to protected branches
- Changing Jira statuses, deleting or reassigning tickets, editing ticket descriptions

### Trust boundary

Reviewer comments and other outside content are treated as untrusted requests, not as permission. Prompt rules and CLI tool restrictions are **not** a security sandbox, because the coding CLI still has general shell and MCP access. You are responsible for not editing a checkout yourself while an automated Run is using it. When a Run finishes, the checkout stays on the branch the Run used.

## Runs, outcomes and failures

Every Run must finish with a JSON result:

- `outcome`: `nothing` | `acted` | `needs-you` (Interactive Chat turns finish with `done`, set by Automator rather than written by the agent)
- `summary`: what happened

When an Automation moves to **Needs you**:

- Scheduled checks stop for it, and it's shown at the top of the dashboard.
- One Teams message is sent per move into Needs you, on a best-effort basis, to a configurable chat through the existing MCP setup. If sending fails, that is shown, and no work that was already done gets repeated.
- You can **Resume** or **Resume and run now**, optionally with a resolution note. The next Run gets that note and continues from the last event that was successfully handled.

Failures:

- Read-only API calls are retried with capped exponential backoff.
- Provider Runs that fail, are interrupted, time out or return an invalid or missing result are **not** retried automatically. The Automation moves to **Needs you** instead, so replies and pushes aren't duplicated.
- The Run timeout is **30 minutes** by default, configurable.
- Cancelling a Run records it as interrupted. It can't undo replies or pushes that already happened.
- If you pause or close an Automation during a Run, that still applies after the Run ends. Exception: if that Run fails or asks for help, a paused Automation moves to Needs you so the failure isn't hidden. An Automation can't be deleted while its Run is still going unless you cancel the Run first.
- Ad-hoc Run failures stay in Run history and don't create an Automation.

## History and result files

- SQLite stores Run history: start and end times, trigger (schedule, manual or ad-hoc), provider and model, exit code, outcome and transcript location.
- Every completed Run writes a versioned **JSON result file** and saves its transcript separately. The result file contains:
  - schema version,
  - Run or attempt ID,
  - Automation ID (if any),
  - Repository,
  - timestamps,
  - `success` or `error` status,
  - outcome, summary and a structured error when there is one,
  - transcript location.
- Failures before the provider starts have no transcript.
- Pre-checks that find no changes are not Runs and produce no files.
- The transcript is written while the Run is in progress, and the Chat and Automation Run pages show its latest 64 KiB inline as plain text, refreshed every 3 seconds. The final file is the same as before. Claude Code, Codex and pi stream whole messages rather than tokens, OpenCode streams text parts, and Copilot streams its stdout (ANSI codes removed). When Copilot finishes, its `--share` export (written to `transcript.md.share.md` and renamed over `transcript.md`) replaces the stdout text if it exists. Copilot's live transcript updates per complete line, so a partial line appears at the next newline. If Copilot buffers stdout until it exits, its live transcript only appears at the end.

## Configuration and storage

- A validated, gitignored local **JSON config** holds:
  - GitLab, GitHub and Jira service connections,
  - schedules and working hours,
  - Jira settings,
  - cleanup settings,
  - model selections,
  - the Teams chat to notify.

  A credential-free example config is committed.

- **Repositories** (local folders, connection names and validation commands) are stored in SQLite and managed on **Settings → Repositories**. Existing config entries are imported once when the database is empty; after import, the legacy `repositories` section is ignored.
- A Repository must have a GitLab or GitHub connection and a valid local folder. Its configured validation commands are run as part of Runs. A Repository with Automations cannot be deleted; deleting one never deletes its local files.

- **Secrets** (GitLab and Jira tokens) are read from environment variables or a gitignored `.env`. They are never added to prompts or result files.
- **Data** (SQLite, result files, transcripts) lives in `~/.automator` by default, configurable. Transcripts can contain private code and stay on your machine.
- Settings manages Repositories and edits validated, non-secret values in the active config file. It never reads `.env` values or exposes environment-variable binding names.
- Settings shows compact summaries for Projects, Repositories, Agents, Workflow assignments/templates and Configuration. **New**, **Add** and **Open** buttons launch modal editors with save/create actions beside Cancel in a fixed footer. Cancel or Escape discards unsaved edits; failed saves keep the editor and entered values. Workflow assignment changes save immediately, while operation templates have a separate Save button.
- **Upgrade and restart** (Settings → Configuration) runs `npm run upgrade-and-restart` detached, then stops the running application without waiting for the upgrade. It is rejected with an error while Runs are active or queued. The page shows a spinner, polls until the server is back online and reloads. A failed upgrade is not reported in the UI.
- Restart is a separate, confirmed Settings action. The supervisor drains active work before restarting the web process and worker.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests into `master`, pushes to `master` and manual dispatch. It uses one Linux runner with Node.js 24, read-only permissions, SHA-pinned actions, a 20-minute timeout, and cancels superseded runs. It is validation-only: no publishing or deployment. Tests use seeded temporary data and need no secrets or live integrations.

Steps and their local equivalents:

1. `npm ci`
2. `npm run check` (types, lint, format, dependency rules, Vitest)
3. `npm run build`
4. `npx playwright install --with-deps chromium`, then `npm run e2e`

On failure, Playwright traces and results are uploaded as the `playwright-diagnostics` artifact (7 days). To reproduce locally, run the steps above with `CI=true` from a clean checkout.

Require the **CI / validate** status check in the `master` branch protection rules.

## Cleanup

A cleanup job is **on by default** and runs **weekly**. It deletes Automations that have been Closed for at least **30 days**, together with their Run history, result files and transcripts.

- How often it runs and how long Closed Automations are kept are configurable, and cleanup can be turned off.
- Active, Paused and Needs you Automations are never cleaned up.
- Files in your Repositories are never deleted.
- Ad-hoc Runs stay until you delete them yourself.

## Dashboard (v1)

- List and detail pages for Automations, plus forms to create and edit them
- Needs you items and errors shown first
- Pause / resume / close / reopen / delete controls
- Queue view and Run history, with completed transcripts and result files
- **Run now** with optional extra instructions
- Ad-hoc Runs (pick a Repository, optionally a Jira Ticket, and enter a prompt), with explicit cancellation
- **Home** prioritizes current Needs you Automations and links to their decision/resume flow, followed by the running Run, the next three queued items and five recent completions. Historical failures do not become current blockers.
- **Runs** is searchable execution history, with outcome, Repository, trigger and inclusive local-date filters. Dates use start time (queue time for Runs that never started). Historical Needs you outcomes remain visible even after resolution.
- **Settings** groups Projects, Repositories, Agents and Configuration. Manage Repository folders, named service connections and validation commands directly under Repositories, alongside Project membership. Repository changes are stored in SQLite and take effect without restarting; credentials remain in Configuration and environment variables.
- The project switcher remains in the header; Settings always covers the entire installation. On narrow screens the menu includes navigation, New automation and Ad-hoc run actions.

### Language

The web UI is available in English (default), Spanish (`es`), Chinese (`zh`) and Russian (`ru`). The language is a per-project setting chosen under Settings → Configuration; CLI, API and Run output are not translated. Missing translations fall back to English.

To add a locale (for example `de`):

1. Copy `messages/en.json` to `messages/de.json` and translate the values; keep the keys and `{placeholders}`. Partial catalogs are fine.
2. Register it in `app/lib/i18n.ts` (import the catalog and add it to `locales` and `catalogs`).
3. Add it to the `locale` enum in `src/core/config/schema.ts` and to `LOCALES` in `src/core/config/overrides.ts`.
4. Run `npm run check` and `npm run e2e`.

New UI text must go through `useTranslations` (client) or `getTranslations` (server) with a key added to `messages/en.json`; dates and numbers use the helpers in `app/lib/format.ts` with the active locale.

## CLI (v1)

- Add and delete Automations, for example `automator automation add <url> --repo <name>`
- Start ad-hoc Runs

## HTTP API (v1)

The dashboard server also exposes a JSON API for the two operations scripts need most: creating an Automation (`automator automation add`) and queueing an ad-hoc Run (`automator run`). Other CLI operations are not available over HTTP yet. Behavior, validation and permissions match the CLI and dashboard; the CLI is unchanged.

**Authentication.** Every request needs `Authorization: Basic <username:password>` (curl `-u user:password`) or `Authorization: Bearer <access token>`, and acts with that user's permissions. Missing or wrong credentials give `401`; lacking `write` on the Repository's Project gives `403`.

**Errors.** Failures never use a `2xx` status and always have the shape `{"error": {"code": "...", "message": "..."}}`: `400` for invalid input or an unknown Repository (`INVALID_INPUT`, `INVALID_TARGET`, `MISSING_INSTRUCTIONS`, `UNKNOWN_REPOSITORY`), `401`, `403` (`FORBIDDEN`), `404` (`NOT_FOUND`; also for a Run you cannot read), `409` for conflicts (`DUPLICATE_WATCH`, `JIRA_DISABLED`).

| Operation            | Request                 | Body fields                                                                                                                                                     | Success                                                      |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Create an Automation | `POST /api/automations` | `target`, `repository` (required); `interval` (e.g. `30m`), `model`, `instructions` (required for free-form), `initialReview` (`baseline-only` or `unresolved`) | `201 {"automationId": 1, "kind": "mr", "repository": "api"}` |
| Queue an ad-hoc Run  | `POST /api/runs`        | `repository` (required); `prompt` (optional with `ticket`), `ticket`, `model`                                                                                   | `202 {"runId": 7}`, plus `warning` when there is one         |
| Poll a Run           | `GET /api/runs/{id}`    | none                                                                                                                                                            | see below                                                    |

Queueing a Run returns at once; poll it with its id. A queued or running Run answers `202 {"runId": 7, "status": "pending", "error": null, "result": null}`. A finished Run answers `200` with `"status": "finished"` and either `"result": {"outcome": "acted", "summary": "...", "branch": "..."}` and `"error": null`, or `"error": {"code": "...", "message": "..."}` and `"result": null` when it failed or was interrupted.

```sh
curl -u me:secret -X POST http://127.0.0.1:3000/api/automations \
  -H 'Content-Type: application/json' \
  -d '{"target": "https://gitlab.com/group/project/-/merge_requests/1", "repository": "api", "interval": "30m"}'

curl -u me:secret -X POST http://127.0.0.1:3000/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"repository": "api", "prompt": "Update the CHANGELOG"}'

curl -u me:secret http://127.0.0.1:3000/api/runs/7
```

## Out of scope for v1

- Token-level streaming of transcripts (providers that emit whole messages show them as they complete)
- Editing secrets from the dashboard
- An MCP tool or skill that lets Copilot create Automations itself (easy to add later on top of the CLI)
- Worktrees or automatic cloning (see [ADR 0001](./docs/adr/0001-serialize-runs-in-configured-repository-folders.md))

## Telegram bot

Control Automator from Telegram. The bot runs inside the worker and **polls Telegram** (outbound HTTPS only), so there is no webhook, port or tunnel to set up: the machine just needs internet access. It stays off unless you enable it.

Setup:

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts. Copy the bot token it gives you.
2. Put the token in `.env` (never in the config file or git):

   ```sh
   AUTOMATOR_TELEGRAM_BOT_TOKEN=<token from BotFather>
   ```

3. Enable the bot in `automator.config.json`:

   ```json
   "telegram": { "enabled": true, "tokenEnv": "AUTOMATOR_TELEGRAM_BOT_TOKEN", "dashboardUrl": "http://127.0.0.1:4317" }
   ```

   `tokenEnv` names the variable that holds the token (default `AUTOMATOR_TELEGRAM_BOT_TOKEN`). `dashboardUrl` is the base of the links the bot sends (set it to an address you can open from your phone). If `telegram` is missing, `enabled` is false or the token variable is empty, the bot does not start.

4. Restart Automator (`npm start`).
5. Create an access token in Automator (Account → Access tokens), open your bot in Telegram and send `/login atk_…`. The bot deletes your message, links your Telegram account to your Automator user and does **not** store the token. From then on it acts with that user's permissions. If the token is revoked, regenerated or expires (or the user is disabled), the link is removed and you must `/login` again. Until you log in, the bot only answers `/login`. The bot only works in private chats.

Commands:

- `/watches`: open Automations (everything except Closed), those that need you first, with title or URL, kind and status. Tap one for details, its latest Runs and a Run's result (outcome and summary, split to Telegram's message size, with a dashboard link).
- From an Automation: **Pause / Resume**, **Run now**, and **Close** (asks for confirmation). Each action is authorized on the server for the linked user.
- `/watch <id>` and `/run <n>`: open an Automation or a Run directly.
- `/project`: choose the active Project; lists and new chats are limited to its Repositories.
- `/chat`: guided new Chat: Repository (within the active Project), optional Jira ticket, then model and Agent (defaults, with override), then your first message. The bot starts Follow-up mode Chats.
- `/chats`: your last 10 Chats. Open one to read its messages; plain text then continues the current Chat as a Follow-up run.
- `/cancel` leaves a flow; `/logout` unlinks the account.

Messages the bot sends on its own (once each, only to linked users allowed to see the item): an Automation needs you, a Chat Run finished, and a Run failed or was interrupted. Only events that happen after you log in are sent. If Telegram is unreachable, polling and sending are retried with backoff and logged by the worker; errors while handling a message are reported in the chat.
