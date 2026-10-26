# Automator

A small personal tool to automate work with Jira and Git (GitLab). It keeps track of outside items that need follow-up, such as merge requests waiting for review or Jira tickets. It checks them from time to time and runs Copilot CLI when something needs doing. A local dashboard shows the current state.

> **Status:** v1 implemented.

See also:

- [GLOSSARY.md](./GLOSSARY.md): domain terms (Watch, Run, Repository, …)
- [ADR 0001: Serialize Runs in configured Repository folders](./docs/adr/0001-serialize-runs-in-configured-repository-folders.md)
- [Architecture and implementation design](./docs/superpowers/specs/2026-10-21-architecture-design.md)
- [Dashboard UI design](./docs/superpowers/specs/2026-10-21-dashboard-ui-design.md)

## Getting started

Prerequisites:

- Node.js 24
- GitHub Copilot CLI installed and logged in (`copilot` on your `PATH`)
- For GitLab MR Watches: [`glab`](https://gitlab.com/gitlab-org/cli) installed and logged in (see below)

### GitLab access for Copilot

Copilot needs its own way to read and reply to MRs, because Automator removes `GITLAB_TOKEN` from the environment it starts Copilot with. GitLab's MCP endpoint (`/api/v4/mcp`) rejects classic personal access tokens (`403 insufficient_scope`), so use the `glab` CLI instead:

```sh
brew install glab
glab auth login --hostname gitlab.com --token <your token>   # a token with the `api` scope
glab auth status                                             # check it works
```

`glab` keeps the token in the system keyring (or in its config file, `~/.config/glab-cli/`, if no keyring is available), and Copilot's shell picks it up from there. Use the same host as the Repository's `gitlab.host`. Anything running as you, Copilot included, can read it.

Set up and start:

```sh
npm install
cp automator.config.example.json automator.config.json   # then edit Repositories, connections, Teams chat
cp .env.example .env                                     # then fill in GITLAB_TOKEN (and Jira tokens if used)
npm run build
npm start
```

`npm start` runs the dashboard and the worker together. Open <http://127.0.0.1:4317> (set `PORT` to change the port).

Ctrl-C stops the dashboard at once, but the worker first waits for the active Run to finish (up to `runs.timeoutMinutes`) and records its result. Press Ctrl-C again (a second or more later) to force it to stop: the active Copilot process is killed, and on the next start the Run is marked interrupted and its Watch moves to Needs you.

CLI examples (the worker must be running for queued Runs to start):

```sh
npm run automator -- watch add <url> --repo <name>
npm run automator -- watch list
npm run automator -- run --repo <name> --prompt "Summarize open TODOs in src/"
npm run automator -- run --repo <name> --ticket ABC-123 --prompt "Use the existing helper"
```

`--ticket` takes a Jira key or `/browse/` URL and the prompt is then optional. The Ticket title is fetched when the Run is queued; if Jira can't be reached the Run is still queued with just the key and a warning. Like any ad-hoc Run, it goes straight into the shared queue, runs once and is driven by the prompt (branches, commits and MRs are allowed, never required). It never resolves discussions, force-pushes or pushes to protected branches, or deletes or reassigns tickets; merging or approving MRs and changing Jira statuses only happen when the prompt explicitly asks. See [ADR 0002](docs/adr/0002-ad-hoc-runs-are-prompt-driven.md).

Tests:

```sh
npm test        # unit and integration tests (Vitest)
npm run e2e     # Playwright smoke tests; first run: npx playwright install chromium
npm run check   # type check, lint, dependency rules and Vitest
```

## Goals

1. Run Copilot CLI in a chosen folder, with that folder's local skills and the configured MCP servers.
2. Create and delete **Watches** (local records of items that need follow-up later) in a local SQLite database.
3. Check Watches from time to time and run Copilot when something needs doing. Most Watches will be pending merge requests: check for new comments, reply to them and make the requested changes.
4. Show the Watches and Runs in an HTML dashboard.

## Technology

- Node.js, TypeScript (ESM)
- Next.js App Router for the dashboard
- `better-sqlite3` for storage
- GitHub Copilot CLI as the agent that does the work

## Architecture

- **Single user, localhost only.** No login. The dashboard answers only requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]` (403 otherwise), so a web page can't reach it through DNS rebinding.
- **Two processes, one start command:** the Next.js dashboard and a separate long-running **worker** that schedules checks and runs Copilot. Both use the same SQLite database.
- **Repositories:** the configuration maps Repository names to local folders and to service connections (GitLab host and credential, and the Jira connection where needed). Every Watch and ad-hoc Run must name a Repository. Copilot starts directly in that folder, so its local skills, instructions and MCP setup apply. The automator never clones repositories or creates worktrees.
- **One global queue:** all Copilot Runs are serialized, even across different Repositories. Several protections stop the same work from running twice, including across processes.
- **Fresh session per Run:** every Run starts a new Copilot session. Its prompt includes the Watch instructions, summaries of recent Runs and any resolution note you left.

## Domain

### Watch kinds

| Kind        | Target                              | Default behavior                                                    |
| ----------- | ----------------------------------- | ------------------------------------------------------------------- |
| GitLab MR   | Merge request URL                   | Handle new outside comments, pipeline failures and merge conflicts  |
| Jira Ticket | Ticket key/URL                      | Look at changes and comments, and reply when the next step is clear |
| Free-form   | Any URL + **required** instructions | Follow the Watch's instructions                                     |

MR and Jira Watches use the default prompt for their kind, plus optional extra instructions. Default prompts are editable Markdown files, one per kind. Each Watch can also use a different model.

### Watch states

- **Active**: checked on its schedule.
- **Paused**: paused by you.
- **Needs you**: a human decision is needed, so scheduled checks stop until you resume.
- **Closed**: follow-up has ended. History is kept until cleanup.

Rules:

- Only one non-Closed Watch is allowed per normalized target and Repository. A duplicate is rejected with a visible error that points to the existing Watch, including when you reopen a Closed Watch.
- You can edit the instructions, interval, model and initial-review policy. Changing the target or Repository needs a new Watch.
- A Watch closes automatically when its MR is merged or closed.
- A Jira Watch closes automatically when its ticket reaches one of the configured Done status IDs, which you set per Jira connection. If none are configured, the Done status category is used. An explicitly empty list turns automatic closing off. Configured IDs are checked when the configuration is loaded, and their readable names are shown.
- Free-form Watches only close when you close them.
- Closed Watches never reopen automatically.

### Creating and deleting Watches

You can manage Watches from the dashboard or a CLI. Both go through the same validation and the same queue.

If the Repository name is unknown, creation is rejected and no Watch is saved. Instead:

- an **attempt-scoped** JSON error result file is written,
- the error and the file location are shown in the dashboard,
- the CLI exits with a nonzero code.

If the result file itself can't be written, that is reported too.

If a Repository's folder later disappears, its existing Watches move to **Needs you** and get an error result.

## Checking and scheduling

### GitLab MR pre-check

A cheap REST check runs before Copilot is started. A Run is queued only when, since the last handled point, there is at least one of these:

- a new comment or discussion by **someone other than you**,
- a failed pipeline on the latest commit,
- a new merge conflict.

Further rules:

- Events that arrive during a Run stay pending for the next check.
- An unchanged event that was already handled doesn't start a new Run.
- `initialReview` decides what happens with existing comments when a Watch is created. It can be set globally and per Watch:
  - `baseline-only` (default): ignore existing comments.
  - `unresolved`: review existing unresolved discussions once.

  Failed pipelines and conflicts count in both modes.

- **Run now** can also be asked to review existing unresolved discussions.
- GitLab REST credentials are required. If they are missing or invalid, or can't access the MR, the Watch moves to **Needs you** after a limited number of retries for temporary failures. It doesn't fall back silently.

### Jira

- `jira.enabled` turns Jira checking on or off for everything. It is **off by default**.
- While it's off, Jira Watches are kept and shown, but they don't run on schedule or through Run now. The dashboard explains why.
- While it's on:
  - With a configured REST token, a cheap change-detection pre-check runs. It uses the change history to ignore your own changes.
  - Without a token, Copilot checks the ticket through MCP on the normal interval.
  - If a token is configured but invalid, the check fails visibly.

Credentials are always set explicitly. They are never taken from MCP settings.

### Free-form

Free-form Watches always run Copilot on their interval.

### Schedule

- Default intervals: **15 min** for MRs and **2 h** for everything else. Each Watch can override its interval.
- Working hours: **Mon–Fri 08:00–19:00** local time by default, configurable (`start` must be earlier than `end`; overnight windows aren't supported). Scheduled work outside these hours waits.
- Manual and ad-hoc Runs ignore working hours and go ahead of queued scheduled work, but they never interrupt a Run that's already in progress.
- Scheduled work runs first-in, first-out (FIFO), with at most one queued request per Watch. Repeated triggers are combined into one.
- After sleep or a restart, each Watch that is due gets checked once. Missed intervals aren't replayed.

## What Copilot may do

### GitLab MRs: full autonomy

Copilot may reply to discussions, fix code, commit and push to the MR's source branch, and address pipeline failures. Merge conflicts are not resolved automatically: the Watch moves to **Needs you** and nothing is merged, rebased or reverted. Before Copilot changes anything, it must:

1. Re-read the current state of the MR, its branch and its discussions.
2. Be on the MR's source branch. If the checkout is clean but on another branch, Copilot fetches and switches to the source branch itself (it never stashes or discards anything to do so); if the checkout isn't clean or the switch fails, it stops.
3. Run the Repository's configured validation commands.

It stops and marks the Watch **Needs you**, instead of guessing or pushing unchecked code, when:

- the checkout has uncommitted changes, an unfinished merge or rebase, or can't be safely switched to the source branch (your work is never stashed or thrown away automatically),
- a request is unclear or is a design disagreement,
- validation commands aren't configured or a required one fails (if a commit or push fails on a hook check, Copilot first runs `npm ci` once and retries),
- the MR has merge conflicts with the target branch,
- updating the branch wouldn't be safe.

### Jira

By default Copilot only looks at the ticket and replies. It may change code only when the Watch's instructions explicitly allow it.

### Never allowed

- Merging or approving MRs, or resolving discussions automatically
- Force-pushing, deleting remote branches, pushing to protected branches
- Changing Jira statuses, deleting or reassigning tickets, editing ticket descriptions

### Trust boundary

Reviewer comments and other outside content are treated as untrusted requests, not as permission. Prompt rules and CLI tool restrictions are **not** a security sandbox, because Copilot still has general shell and MCP access. You are responsible for not editing a checkout yourself while an automated Run is using it. When a Run finishes, the checkout stays on the branch the Run used.

## Runs, outcomes and failures

Every Run must finish with a JSON result:

- `outcome`: `nothing` | `acted` | `needs-you`
- `summary`: what happened

When a Watch moves to **Needs you**:

- Scheduled checks stop for it, and it's shown at the top of the dashboard.
- One Teams message is sent per move into Needs you, on a best-effort basis, to a configurable chat through the existing MCP setup. If sending fails, that is shown, and no work that was already done gets repeated.
- You can **Resume** or **Resume and run now**, optionally with a resolution note. The next Run gets that note and continues from the last event that was successfully handled.

Failures:

- Read-only API calls are retried with capped exponential backoff.
- Copilot Runs that fail, are interrupted, time out or return an invalid or missing result are **not** retried automatically. The Watch moves to **Needs you** instead, so replies and pushes aren't duplicated.
- The Run timeout is **30 minutes** by default, configurable.
- Cancelling a Run records it as interrupted. It can't undo replies or pushes that already happened.
- If you pause or close a Watch during a Run, that still applies after the Run ends. Exception: if that Run fails or asks for help, a paused Watch moves to Needs you so the failure isn't hidden. A Watch can't be deleted while its Run is still going unless you cancel the Run first.
- Ad-hoc Run failures stay in Run history and don't create a Watch.

## History and result files

- SQLite stores Run history: start and end times, trigger (schedule, manual or ad-hoc), exit code, outcome and transcript location.
- Every completed Run writes a versioned **JSON result file** and saves its transcript separately. The result file contains:
  - schema version,
  - Run or attempt ID,
  - Watch ID (if any),
  - Repository,
  - timestamps,
  - `success` or `error` status,
  - outcome, summary and a structured error when there is one,
  - transcript location.
- Failures before Copilot starts have no transcript.
- Pre-checks that find no changes are not Runs and produce no files.
- v1 only shows a transcript after the Run finishes. There's no live streaming.

## Configuration and storage

- A validated, gitignored local **JSON config** holds:
  - Repository mappings and service connections,
  - schedules and working hours,
  - Jira settings,
  - cleanup settings,
  - models and prompts,
  - the Teams chat to notify.

  A credential-free example config is committed.

- **Secrets** (GitLab and Jira tokens) are read from environment variables or a gitignored `.env`. They are never added to prompts or result files.
- **Data** (SQLite, result files, transcripts) lives in `~/.automator` by default, configurable. Transcripts can contain private code and stay on your machine.
- Changes to the config take effect after a restart (v1). The dashboard doesn't edit config or secrets.

## Cleanup

A cleanup job is **on by default** and runs **weekly**. It deletes Watches that have been Closed for at least **30 days**, together with their Run history, result files and transcripts.

- How often it runs and how long Closed Watches are kept are configurable, and cleanup can be turned off.
- Active, Paused and Needs you Watches are never cleaned up.
- Files in your Repositories are never deleted.
- Ad-hoc Runs stay until you delete them yourself.

## Dashboard (v1)

- List and detail pages for Watches, plus forms to create and edit them
- Needs you items and errors shown first
- Pause / resume / close / reopen / delete controls
- Queue view and Run history, with completed transcripts and result files
- **Run now** with optional extra instructions
- Ad-hoc Runs (pick a Repository, optionally a Jira Ticket, and enter a prompt), with explicit cancellation

## CLI (v1)

- Add and delete Watches, for example `automator watch add <url> --repo <name>`
- Start ad-hoc Runs

## Out of scope for v1

- Live streaming of transcripts
- Editing config or secrets from the dashboard
- An MCP tool or skill that lets Copilot create Watches itself (easy to add later on top of the CLI)
- Worktrees, automatic cloning, or running Runs in parallel (see [ADR 0001](./docs/adr/0001-serialize-runs-in-configured-repository-folders.md))
