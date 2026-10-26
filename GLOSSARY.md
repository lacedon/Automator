# Automator

A personal tool that keeps track of outside work items (merge requests, Jira tickets) that need follow-up, and periodically lets Copilot act on them.

## Language

**Watch**:
A locally stored record of one outside item that needs follow-up in the future, together with instructions for acting on it.
_Avoid_: Ticket, task, tracker, follow-up

**Repository**:
A named codebase associated with a local working folder. Each Watch identifies the Repository where its follow-up work belongs.
_Avoid_: Workspace, project (when referring to the configured Repository)

**Watch kind**:
The type of outside item a Watch points to: a GitLab merge request, a Jira ticket, or a free-form item (any URL plus instructions).
_Avoid_: Type, category

**Ticket**:
An issue in Jira. Never used for local records.
_Avoid_: Jira issue (in prose), task

**Run**:
One execution of Copilot, either to follow up on a Watch or to carry out an ad-hoc request, with a retained outcome and transcript.
_Avoid_: Session, check

**Ad-hoc run**:
A Run requested directly by the user without an associated Watch. It happens once and may optionally be _for_ a Ticket; without one it is a generic request.

**Needs you**:
A Watch state indicating that follow-up requires a human decision before automatic work can continue.

**Closed Watch**:
A Watch whose follow-up has ended, either because its merge request was merged or closed, or because the user closed the Watch.
