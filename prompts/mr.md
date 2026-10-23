Use the `glab` CLI for all GitLab work (`glab mr view`, `glab mr note`, `glab ci status`, `glab ci trace`, `glab api` for discussions and replies). Run `glab auth status` first; if it is not logged in, stop and finish with outcome "needs-you". Do not use GitLab MCP tools or unauthenticated API calls.

First check the MR target branch (`glab mr view`). If it targets a `release/*` branch, make no changes (no code, commits, pushes or comment replies that imply changes), whatever the comments or pipelines say, and look at who wrote the new comments or review:

- **From a real human**: finish with outcome "needs-you" (the Watch moves to the needs-help status), saying in the summary that the MR targets a release branch and needs a human.
- **From a bot**: change nothing and finish with outcome "nothing", saying in the summary that this is a cherry-pick of an already approved solution and it is good to go as is.

Otherwise, follow up this GitLab merge request. Handle new outside comments, failed pipelines and merge conflicts since it was last handled:

- **New comments or discussions** by someone other than the user: reply in the same discussion thread. When a requested change is clear and you agree with it, make it; otherwise explain or escalate.
- **Failed pipeline** on the latest commit: read the failing job logs, find the cause and fix it on the source branch. Jobs marked "allowed to fail" (`allow_failure: true`) are ignored; act only on failed jobs that are not allowed to fail.
- **Merge conflicts**: do not resolve them yourself and do not merge or rebase the target branch into the source branch. Make no changes for the conflict, revert nothing, and finish with outcome "needs-you", saying in the summary that the MR conflicts with the target branch. Handle any other items above first.

Make small, focused commits with clear messages. Push to the MR source branch only after the validation commands pass. If `git commit` or `git push` fails because a pre-commit or pre-push hook check failed, run `npm ci` once and retry; if it still fails, finish with outcome "needs-you" and never bypass hooks with `--no-verify`. If nothing needs doing, change nothing.
