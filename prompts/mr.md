Use the `glab` CLI for all GitLab work (`glab mr view`, `glab mr note`, `glab ci status`, `glab ci trace`, `glab api` for discussions and replies). Run `glab auth status` first; if it is not logged in, stop and finish with outcome "needs-you". Do not use GitLab MCP tools or unauthenticated API calls.

First check the MR target branch (`glab mr view`). If it targets a `release/*` branch, make no changes because of comments or reviews (no code, commits, pushes or comment replies that imply changes), whatever they say. The only exception is the pipeline rule below: fix failed pipeline jobs that are not allowed to fail, and ask for help when a job that is allowed to fail has failed. For new comments or reviews, look at who wrote them:

- **From a real human**: finish with outcome "needs-you" (the Watch moves to the needs-help status), saying in the summary that the MR targets a release branch and needs a human.
- **From a bot**: change no code, but still reply in the bot's discussion thread (skip resolved threads, and ignore bot comments that did not open a thread), mentioning the bot (`@username`) at the start, saying politely that no changes are required here. Where possible, argue with facts why the current behavior is better (for example, what the code does and why the suggestion would not improve it, or that it matches the already approved solution), instead of only saying that this is a cherry-pick; if you cannot find any concrete argument, fall back to saying that this is a cherry-pick of an already approved solution and it is good to go as is. Finish with outcome "acted" and a short version of the same explanation in the summary.

Otherwise (and, for `release/*` MRs, only for the failed pipeline item), follow up this GitLab merge request. Handle new outside comments, failed pipelines and merge conflicts since it was last handled:

- **New comments or discussions** by someone other than the user: reply in the same discussion thread, starting every reply by mentioning the person or bot you are responding to (`@username`). When a requested change is clear and you agree with it, make it; otherwise explain or escalate.
  - Ignore all threads that are already resolved.
  - Never open new threads or post new top-level MR notes on the user's own MRs. If a bot just commented and the comment did not open a thread, ignore it.
- **Failed pipeline** on the latest commit (applies to every target branch, including `release/*`): read the failing job logs, find the cause and fix it on the source branch. A failed job that is not allowed to fail must always be fixed. A failed job marked "allowed to fail" (`allow_failure: true`) is handled by target branch:
  - `release/*`: do not fix it; finish with outcome "needs-you", saying in the summary which job failed and that it needs a human.
  - `qa`: fix it like any other failed job.
  - any other branch: ignore it.
- **Merge conflicts**: do not resolve them yourself and do not merge or rebase the target branch into the source branch. Make no changes for the conflict, revert nothing, and finish with outcome "needs-you", saying in the summary that the MR conflicts with the target branch. Handle any other items above first.

Make small, focused commits with clear messages. Push to the MR source branch only after the validation commands pass. If `git commit` or `git push` fails because a pre-commit or pre-push hook check failed, run `npm ci` once and retry; if it still fails, finish with outcome "needs-you" and never bypass hooks with `--no-verify`. If nothing needs doing, change nothing.
