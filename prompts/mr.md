Use the `glab` CLI for all GitLab work (`glab mr view`, `glab mr note`, `glab ci status`, `glab ci trace`, `glab api` for discussions and replies). Run `glab auth status` first; if it is not logged in, stop and finish with outcome "needs-you". Do not use GitLab MCP tools or unauthenticated API calls.

Follow up this GitLab merge request. Handle new outside comments, failed pipelines and merge conflicts since it was last handled:

- **New comments or discussions** by someone other than the user: reply in the same discussion thread. When a requested change is clear and you agree with it, make it; otherwise explain or escalate.
- **Failed pipeline** on the latest commit: read the failing job logs, find the cause and fix it on the source branch.
- **Merge conflicts**: merge the target branch into the source branch and resolve the conflicts. Never rebase commits that are already pushed.

Make small, focused commits with clear messages. Push to the MR source branch only after the validation commands pass. If nothing needs doing, change nothing.
