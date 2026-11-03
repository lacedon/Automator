# Agent Profiles, Configuration, and Restart

## Context

Automator currently loads operation prompts from tracked Markdown files and reads application settings from `automator.config.json`. This makes prompt behavior shared by every Repository and means settings changes require editing files outside the web interface. The change makes prompt policy and app configuration local to an Automator installation, while preserving the existing Copilot execution backend and fixed safety rules.

## Goals

- Manage reusable Agent instructions and their Repository/Workflow type assignments in local SQLite.
- Manage optional shared operation templates in local SQLite.
- Edit non-secret application settings in the localhost web interface.
- Keep credentials in `.env`; do not expose credentials or environment-variable binding names to the browser.
- Restart the web application and worker from the interface, draining active work before reload.
- Import the existing prompts into the user's local SQLite database before deleting the tracked prompt files.

## Non-goals

- Synchronizing configuration or prompts through GitLab.
- Replacing Copilot or introducing a provider/runtime abstraction for Agents.
- Editing `.env` or credential values from the web interface.
- Allowing configurable instructions to relax Automator's fixed safety safeguards.

## Domain model

Automator supports five Workflow types: MR Watch, Jira Watch, Free Watch, Ticket Ad-hoc, and free-form Ad-hoc. Each Run records its root Workflow type; a follow-up retains that type and resolves the current Agent assignment when it executes.

An Agent is an instruction-only profile. For every Workflow type there is an installation-wide empty default Agent. A Repository-specific assignment overrides that default. An optional operation template is shared instruction text for a Workflow type, reused across Repositories and independent of Agent assignment.

## Design

### Approaches considered

- **Store prompts in local SQLite with Repository/Workflow assignments (selected):** keeps prompt content out of tracked files and allows different instructions per Repository without duplicating application settings.
- **Keep prompts in files or move them into JSON:** simpler initially, but still couples prompt policy to repository-local file editing and does not provide Agent assignment management.
- **Synchronize prompt policy through GitLab:** rejected because configuration and prompt content are intended to remain local to the Automator installation.

### Local prompt storage and resolution

Store Agents, assignments, and operation templates in the existing SQLite database under `dataDir`. Enforce one assignment for each `(Repository, Workflow type)` pair and one installation-wide default per Workflow type. Repository keys are the names from application configuration.

Resolve each Run's Workflow type from its Watch kind or Ad-hoc form (ticket versus free-form), and persist it on the Run so follow-ups do not become a different kind of work. Resolve the Repository-specific Agent first, then the installation-wide default. Each Workflow type can have one optional shared operation template. Add the selected Agent instructions and template to the prompt before task-specific request text.

Fixed Automator safety rules remain immutable and higher priority than Agent instructions, templates, Watch instructions, ticket text, and per-Run requests. Ticket and other external content remain untrusted. An absent or empty required Agent blocks execution before Copilot starts and reports an actionable error identifying the Repository and Workflow type. Operation templates are optional and empty initially.

Deleting an Agent requires confirmation that lists every assignment it serves. Confirmed deletion clears those references; Runs that subsequently resolve no non-empty Agent fail with the same actionable configuration error.

### Web configuration

Add a Settings area for Agent profiles, assignments, operation templates, and application settings. The application-settings form follows the existing validated config schema and saves to the active `automator.config.json` file. Validate before writing and preserve existing environment-variable binding names server-side without returning them to the browser. Do not return or accept secret values; `.env` remains the only credential source. Existing example configuration remains placeholder-only.

Saving configuration does not silently restart processes. Provide a separate explicit restart action with confirmation and a draining/restarting status, and report whether it was accepted or failed.

### Restart lifecycle

The web process requests restart through a private parent/child IPC message to the `scripts/start.mjs` supervisor. The supervisor signals the worker to stop claiming work and drain its active Run, then restarts both web and worker with the saved configuration. Normal child crashes and external shutdown signals retain their existing stop behavior; only the explicit restart message triggers an in-place restart. The restart endpoint remains localhost-only.

### Legacy prompt import

Provide a one-time explicit CLI importer that reads the existing `prompts/mr.md`, `prompts/jira.md`, and `prompts/jira-adhoc.md` files at runtime, without embedding their contents in source. It displays the resolved SQLite path and target Repository key, verifies that the Repository exists, and asks for confirmation before writing. It creates the corresponding Agents and assignments for `inspire-mbdp-pages` only: MR Watch, Jira Watch, and Ticket Ad-hoc. It does not import `free.md`. The import is transactional and safe to repeat; if any destination assignment conflicts with an existing profile, report the conflict and make no changes.

After a successful import, remove the tracked prompt files and `prompts.dir` runtime configuration. Free Watch and free-form Ad-hoc retain empty defaults and therefore require an Agent before they can run.

## Acceptance criteria

- Agent selection is repository-specific with a per-Workflow-type installation default; follow-ups retain their root Workflow type.
- A missing or empty required Agent produces a clear error without launching Copilot; optional empty templates do not block Runs.
- Fixed safety rules cannot be overridden by Agents, templates, ticket text, or per-Run instructions.
- The web UI can manage Agent content, assignments, templates, and non-secret settings; secret values and environment-variable binding names never reach the browser.
- Configuration is validated and persisted locally, and restart drains active work before loading the saved configuration.
- The importer displays and verifies its destination before writing, imports only the three selected prompts for `inspire-mbdp-pages`, and does not overwrite existing assignments.
- Tracked prompt contents and real local configuration/credentials are absent from the repository after migration.
- Unit tests cover workflow resolution, assignment fallback, safety-rule precedence, import conflict/idempotency behavior, config validation, and restart coordination.
