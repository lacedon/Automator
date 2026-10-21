# Serialize Runs in configured Repository folders

Each Watch names a Repository mapped to an existing local folder; Copilot starts directly in that folder to reuse its local skills, instructions and configured MCP environment. All Watch-linked and ad-hoc Runs share one global serialized queue, deliberately choosing existing checkouts over managed worktrees or fresh clones to preserve the user's local setup.

## Consequences

- The automator does not clone repositories or create, remove or reset worktrees.
- A Run must escalate instead of changing code when the relevant checkout contains uncommitted changes, an unfinished merge/rebase or an unsafe branch state.
- Uncommitted local skills remain available to Copilot, but do not exempt a dirty checkout from write protection.
- Queue serialization prevents automator Runs from colliding; it does not prevent concurrent human edits. The checkout requires exclusive use while an automated Run is active and remains on the branch used by that Run.
- Repository names are required for Watch creation and ad-hoc Runs. An unknown name rejects creation with an explicit error and an attempt-scoped JSON result file; a folder that later becomes unavailable causes an existing Watch to require human attention.
- This design prioritizes local environment reuse over isolation and parallel throughput. Prompt instructions and CLI tool restrictions are not a security sandbox.
