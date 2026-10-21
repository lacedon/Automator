# Dashboard UI design (v1)

Status: approved design, 2026-10-21. Covers the visual design and screen contents of the v1 dashboard described in [README.md](../../../README.md). Behavior rules (states, queue, scheduling, permissions) are defined by the README, [GLOSSARY.md](../../../GLOSSARY.md) and [ADR 0001](../../adr/0001-serialize-runs-in-configured-repository-folders.md); this spec only decides how they are presented.

Mockups (standalone HTML, open in a browser):

- [01-home-palette.html](./assets/01-home-palette.html): Home page; palette **1 (graphite)** is the chosen one
- [02-watches-list-and-detail.html](./assets/02-watches-list-and-detail.html)
- [03-watch-form.html](./assets/03-watch-form.html)
- [04-queue-runs-adhoc.html](./assets/04-queue-runs-adhoc.html)

Mockup data (MR numbers, Repository names, models) is illustrative.

## Intent

A single-user localhost dashboard glanced at during the working day. Its main job is triage: see what **Needs you**, resolve it, and get back to work. Secondary jobs: inspect Run history and transcripts, manage Watches, start ad-hoc Runs.

Success: from any page, Needs you items and the currently running Run are reachable in one click, and every action the README allows on a Watch or Run is available without leaving the dashboard.

## Look and feel

- **Layout:** fixed left sidebar plus main content area. Top bar with the app name and two global actions: **+ Watch** (secondary button) and **Ad-hoc run** (primary button).
- **Sidebar items:** Home, Watches (total non-cleaned count), Queue (waiting count), Runs, Ad-hoc. Active item: highlighted background with a blue left bar.
- **Theme:** dark only (v1). Graphite palette:

| Token | Value | Use |
| --- | --- | --- |
| bg | `#0d1117` | page background |
| bg-sunken | `#010409` | top bar, sidebar, inputs, code blocks |
| surface | `#161b22` | cards, rows |
| border | `#30363d` | borders, dividers |
| text | `#e6edf3` | primary text |
| text-muted | `#8d96a0` | secondary text, table headers |
| link | `#58a6ff` | links |
| accent | `#2f81f7` | active nav, focused filter chip |
| primary | `#238636` | primary buttons |
| danger-text | `#ff7b72` | destructive buttons (Delete, Cancel run) |

- **Status pills** (rounded, small, bold): one colour family per meaning, used consistently for Watch states, Run outcomes and queue priority.

| Meaning | Background / text | Used for |
| --- | --- | --- |
| Needs you / error | `#5a1e22` / `#ff9492` | Watch state Needs you, outcome `needs-you`, Run errors |
| Good | `#12361f` / `#56d364` | Watch state Active, outcome `acted` |
| Running | `#3b2e0a` / `#e3b341` | Run in progress (with `●` and elapsed time) |
| Neutral | `#262c36` / `#8d96a0` | outcome `nothing`, scheduled queue items |
| Paused | `#262c36` / `#c9d1d9` | Watch state Paused |
| Closed | `#1c2128` / `#6e7681` | Watch state Closed |
| Info | `#0c2d6b` / `#79c0ff` | manual/ad-hoc queue priority, queued ad-hoc Runs, detected kind badge |
| Interrupted | `#3d1f00` / `#ffa657` | Run timed out, cancelled or interrupted |

- **Needs you emphasis:** cards with a dark red background (`#2d1517`, border `#6e2a2e`); list rows with a red tint (`#1d1214`).
- **Notices:** amber box (`#1c1a10`, border `#5c4813`, text `#e3b341`) for explanatory system state, e.g. Jira disabled.
- **Section headings:** small uppercase muted labels.
- **Typography:** system UI font, 12–13 px base; monospace for code, paths, transcripts.

## Screens

### 1. Home (`/`)

In order:

1. **Needs you**: heading with count pill; one card per Watch in Needs you showing title, Repository, reason, and **Resume** / **Resume & run now** buttons. Empty state: a single muted line "Nothing needs you."
2. **Now running**: the current Run (target, Repository, elapsed time) with **Cancel**. Hidden when idle.
3. **Recent Runs**: latest Runs with outcome pill, summary and relative time; each links to Run detail.

### 2. Watches list (`/watches`)

- **Filter bar:** state chips with counts (All, Needs you, Active, Paused, Closed), Kind dropdown, Repository dropdown, target search.
- **Jira notice:** when `jira.enabled` is false and at least one Jira Watch exists, show the amber notice explaining that Jira Watches are kept but don't run on schedule or via Run now.
- **Table columns:** State, Kind (MR / Jira / Free), Target (title), Repository, Every (interval), Next check, Last run (outcome pill + relative time), actions.
- **Ordering:** Needs you rows pinned first (red tint), then other states; Closed last.
- **Next check** shows one of: relative time (`in 9m`), `running` pill with elapsed time, `queued #n`, `after hours · <next window start>`, `stopped` (Needs you), `Jira off`, `cleanup in <n>d` (Closed).
- **Row actions:** Needs you rows show an inline **Resume** button; every row has a `⋯` menu with Run now, Pause/Resume, Close/Reopen, Edit, Delete (only the actions valid for the current state).

### 3. Watch detail (`/watches/[id]`)

- **Header:** breadcrumb (Watches / Repository), title, state pill; buttons **Run now ▾**, Pause/Resume, Close/Reopen, Edit, **Delete** (danger). Subline: kind, target link, MR source branch (MR only).
- **Run now ▾ popover:** optional extra-instructions textarea, checkbox "Review existing unresolved discussions" (MR only), submit.
- **Needs you card** (only in Needs you): reason, since-time and causing Run link; Teams notification status (sent ✓ / failed with error); resolution note textarea; **Resume** and **Resume & run now**.
- **Runs table:** #, Trigger, Started, Took, Outcome, Summary, links to transcript and result file (each Run row opens Run detail).
- **Right column cards:**
  - Settings: Repository (name + folder), interval, model, initial review, created.
  - Extra instructions (or "Uses default prompt" when empty).
  - Last handled point (MR: last comment, pipeline, conflicts; Jira: last change handled).
- **Delete while running:** Delete is disabled with a tooltip "Cancel the running Run first".

### 4. Create / edit Watch (`/watches/new`, `/watches/[id]/edit`)

- **Fields:** Target URL or Jira key; Repository dropdown (shows folder and host); Extra instructions (required for free-form, optional otherwise, with the default prompt file name shown); Interval (pre-filled default for the kind); Model dropdown (default first); Initial review segmented control `baseline-only` | `unresolved` with a one-line explanation (MR only).
- **Kind detection:** as the target is entered, show the detected kind badge. For GitLab MRs also show a preview (title, open/merged/closed, source branch) fetched via the GitLab REST connection of the chosen Repository; if the preview fails, show the kind only plus a muted reason; it does not block submission.
- **Errors** render in a red box above the form and keep the entered values:
  - **Unknown Repository:** "Unknown Repository "<name>"", "No Watch was created", the known Repository names, and the attempt-scoped result file path with an open link. If the file couldn't be written, an extra line states that and the error.
  - **Duplicate:** "Already watched", the existing Watch's state and interval, and a link to it. The same box is used when reopening a Closed Watch would create a duplicate.
- **Edit mode:** Target and Repository are shown locked (🔒) with the note "To change the target or Repository, close this Watch and create a new one."

### 5. Queue (`/queue`)

- **Running card** (amber): Running pill with elapsed / timeout (e.g. `04:12 / 30:00`), target, Repository, trigger, Run number, start time, **Cancel run** (danger). Note: "Live transcript isn't available in v1. It appears when the Run finishes." Empty state: "Nothing running."
- **Waiting table:** position, priority pill (manual / ad-hoc in Info colour, scheduled in Neutral), item, Repository, queued time, reason (e.g. "new comment by @anna", "pipeline #55210 failed", "Resume & run now"), action.
  - Watch items: **close Watch**, which moves the Watch to Closed and removes its queued request.
  - Ad-hoc items: **cancel**.
- Heading notes the ordering rule: "Waiting · manual & ad-hoc go first".

### 6. Runs (`/runs`)

- **Filters:** outcome chips (All, needs-you, acted, nothing, errors), Trigger dropdown (schedule / manual / ad-hoc), Repository dropdown.
- **Table columns:** #, Watch or ad-hoc prompt (ad-hoc prompts prefixed with italic "ad-hoc:"), Repository, Trigger, Started, Took, Outcome, Summary. Rows open Run detail.
- Errors before Copilot started show `—` for duration and an `error` pill; timeouts and cancellations use the Interrupted pill (`timed out` / `cancelled`).

### 7. Run detail (`/runs/[id]`)

- **Header:** "Run #n", linked Watch title (or "Ad-hoc run"), outcome pill.
- **Metadata card:** Summary; Trigger (with triggering event when known); Time (start → end, duration, exit code); Repository and branch; Files (result file and transcript paths, with "reveal").
- **Structured error** (when present) shown in a red card above the tabs.
- **Tabs:** Transcript (monospace, rendered after completion; "No transcript — the Run failed before Copilot started" when absent), Result JSON (pretty-printed), Prompt (the full prompt sent).

### 8. Ad-hoc (`/adhoc`)

- **Form:** Repository dropdown (with folder), Prompt textarea, Model dropdown, **Queue run**. Helper text: "Goes ahead of scheduled work, ignores working hours, never interrupts the current Run." Unknown-Repository errors use the same red box as the Watch form.
- **Ad-hoc history table:** #, prompt, Repository, status (queued #n / running / outcome pill), actions: **cancel** (queued or running), **open**, **delete** (finished).

## Cross-cutting behavior

- **Freshness:** pages reflect worker progress without manual reload (polling or server push is an implementation choice); running timers tick client-side.
- **Destructive confirmations:** Delete Watch, Cancel run and close Watch from the queue ask for confirmation in a small dialog that states the consequence (e.g. "Cancelling can't undo replies or pushes that already happened.").
- **Disabled actions** stay visible with a tooltip explaining why (Jira off, Run in progress, invalid for current state).
- **Empty states:** every list has a one-line muted empty message.
- **No config editing:** the dashboard never edits config or secrets; where config matters (Jira off, working hours) it explains, it doesn't offer toggles.

## Out of scope (v1)

- Light theme or theme switcher
- Live transcript streaming
- Worker health indicator
- Editing config or secrets
- Mobile layout (desktop browser only)
