# Automator

A personal tool that keeps track of outside work items (merge requests, Jira tickets) that need follow-up, and periodically lets Copilot act on them.

## Language

**Automation**:
A locally stored record of one outside item that needs follow-up in the future, together with instructions for acting on it.
_Avoid_: Watch (the former name), Ticket, task, tracker, follow-up

**Repository**:
A named codebase associated with a local working folder. Each Automation identifies the Repository where its follow-up work belongs.
_Avoid_: Workspace, project (when referring to the configured Repository)

**Automation kind**:
The type of outside item an Automation points to: a GitLab merge request, a GitHub pull request, a Jira ticket, or a free-form item (any URL plus instructions).
_Avoid_: Type, category

**Ticket**:
An issue in Jira. Never used for local records.
_Avoid_: Jira issue (in prose), task

**Run**:
One execution of Copilot, either to follow up on an Automation or to carry out an ad-hoc request, with a retained outcome and transcript.
_Avoid_: Session, check

**Ad-hoc run**:
A Run requested directly by the user without an associated Automation. It happens once and may optionally be _for_ a Ticket; without one it is a generic request. A finished one can be followed up by replying in its Chat tab.

**Follow-up run**:
An Ad-hoc run started by replying in the Chat tab of an earlier Ad-hoc run; it resumes the same Copilot session.
_Avoid_: continuation, reopen

**Workflow type**:
The kind of work a Run performs: MR Automation, Jira Automation, Free Automation, Ticket Ad-hoc, or free-form Ad-hoc.
_Avoid_: Trigger

**Project**:
A named group of Repositories used to separate work visually. A Repository belongs to at most one Project; Repositories without one are "Unassigned". Selecting a Project in the top bar scopes Home, Automations, Queue, Runs and Ad-hoc to its Repositories and tints the UI with the Project's colour.
_Avoid_: Workspace

**Agent**:
A reusable set of instructions selected for a Repository and Workflow type.

**Agent assignment**:
The selection of one Agent for a Workflow type, either for a specific Repository or as the installation-wide default.

**Operation template**:
Optional shared instructions for a kind of operation, subordinate to an Agent's instructions.

**Needs you**:
An Automation state indicating that follow-up requires a human decision before automatic work can continue.

**Closed Automation**:
An Automation whose follow-up has ended, either because its merge request was merged or closed, or because the user closed the Automation.
