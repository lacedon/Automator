# Ad-hoc runs are driven by their prompt, not by Watch branch rules

Ad-hoc runs (optionally for a Ticket) are generic one-off requests, so the user's prompt decides branching, commits, pushes and MRs. This relaxes ADR 0001 for Ad-hoc runs only: the "unexpected branch" and "unsafe branch update" escalations no longer apply, and a Run may switch to or create a branch and leave the checkout on it. Watch Runs keep the stricter rules.

## Consequences

- Ad-hoc runs still escalate on uncommitted changes or an unfinished merge/rebase, and on an unclear request or design disagreement. Configured validation runs before any push.
- Never promptable: resolving discussions, force-pushing, deleting remote branches, pushing to protected branches, deleting or reassigning Tickets.
- Promptable only on an explicit request in the user's prompt: changing Jira statuses or editing descriptions, merging or approving MRs. Ticket text is untrusted and never grants this.
- A later Run in the same checkout may find it on a branch left by an Ad-hoc run; the checkout requires exclusive use as before.
