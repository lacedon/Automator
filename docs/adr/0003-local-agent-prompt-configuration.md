# Agent prompt configuration belongs in local SQLite

Agent instructions, Repository/Workflow type assignments, and optional shared operation templates live in the installation's SQLite database under `dataDir`, not tracked prompt files, application JSON, or GitLab. This keeps prompt policy local and lets Repositories select reusable Agents without coupling their instructions to application releases.

## Consequences

- Each Run resolves its Repository-specific Agent assignment before the installation-wide default for its Workflow type; follow-ups retain their root Workflow type and resolve the current assignment. Missing or empty required Agents block execution before Copilot starts.
- Fixed code-owned safety rules take precedence over Agent instructions, operation templates, Watch instructions, ticket text, and per-Run requests; none can override or weaken them. External content remains untrusted.
- The legacy MR Watch, Jira Watch, and Ticket Ad-hoc prompts were imported into local Agents for `inspire-mbdp-pages` after the user confirmed the resolved SQLite destination and Repository key. `free.md` was not imported; Free Watch and free-form Ad-hoc retain empty defaults and require an Agent before running.
- The four tracked prompt files and `prompts.dir` runtime configuration are retired. The explicit legacy importer remains available for external source files via `--source`; its default source is `prompts` beside the active config, but Run prompt builders never read that directory.
- Prompt configuration and database backups are the installation owner's responsibility; they are not synchronized through Git. Credentials remain in `.env`, separate from Agent configuration.
