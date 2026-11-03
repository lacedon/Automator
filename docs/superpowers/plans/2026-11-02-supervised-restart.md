# Supervised Application Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a confirmed restart from Settings while the worker drains its active Run and the supervisor reloads both application processes.

**Architecture:** Extend the existing `scripts/start.mjs` supervisor with a private IPC restart protocol from the web child. The supervisor drains the worker before stopping and respawning the web process; normal crashes and external shutdown signals keep their current behavior.

**Tech Stack:** Node.js child-process IPC, Next.js Server Actions, React, Vitest.

**Spec:** [2026-11-02-agent-prompt-configuration-design.md](../specs/2026-11-02-agent-prompt-configuration-design.md)

## Global Constraints

- Provide a separate explicit restart action with confirmation and a draining/restarting status.
- The supervisor signals the worker to stop claiming work and drain its active Run, then restarts both web and worker with the saved configuration.
- Only an explicit restart IPC message triggers an in-place restart; normal child crashes and external shutdown signals retain their existing stop behavior.
- The restart endpoint remains localhost-only.

## Review Focus

- Duplicate restart requests during drain must be rejected with a clear result; test in `scripts/processSupervisor.test.ts`.
- An unexpected web or worker exit must stop the other process and must not accidentally respawn; test in `scripts/processSupervisor.test.ts`.
- External SIGINT/SIGTERM must retain shutdown semantics; test in `scripts/processSupervisor.test.ts`.
- Restart acknowledgement must reach the web process before it is stopped; test message ordering in `scripts/processSupervisor.test.ts`.
- A web process without a supervisor IPC channel or a non-loopback request must return a visible failure; test in `app/actions/restart.test.ts`.

---

### Task 1: Add the supervisor restart protocol

**Files:**

- Create: `scripts/processSupervisor.mjs`
- Test: `scripts/processSupervisor.test.ts`
- Modify: `scripts/start.mjs`

**Interfaces:**

- Produces `createProcessSupervisor({ spawn, commands, env, exit, log })`, returning `start()` and `stop(signal)`.
- The web child may send `{ type: 'restart', requestId }`; the supervisor replies with `{ type: 'restart-accepted' | 'restart-rejected', requestId }`.
- On accepted restart, signal the worker with SIGTERM and wait for its close event before stopping the web child; after both close, spawn both again.

- [ ] **Step 1: Write failing supervisor tests** for accepted restart ordering, duplicate rejection, unexpected child exit, and external shutdown.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- scripts/processSupervisor.test.ts`.
- [ ] **Step 3: Extract and implement the testable supervisor state machine**, then wire `scripts/start.mjs` to pass an IPC channel to the web child and route its restart messages.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- scripts/processSupervisor.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add scripts/processSupervisor.mjs scripts/processSupervisor.test.ts scripts/start.mjs
git commit -m "feat: restart supervised application processes"
```

### Task 2: Add the confirmed restart action to Settings

**Files:**

- Create: `app/actions/restart.ts`
- Create: `app/actions/restart.test.ts`
- Create: `app/components/RestartApplicationButton.tsx`
- Modify: `app/settings/config/page.tsx`
- Create: `docs/adr/0004-supervised-web-restart.md`

**Interfaces:**

- `requestApplicationRestart(): Promise<ActionResult<{ accepted: boolean }>>` sends a request ID to the supervisor and awaits its matching acknowledgement.
- The action validates the loopback Host and forwarded Host with `isAllowedRequest`; missing IPC, rejection, and timeout are explicit errors.
- The UI uses the existing native confirmation dialog, displays accepted/draining state, and never reports success before receiving an acceptance acknowledgement.

- [ ] **Step 1: Write failing action tests** for accepted/rejected acknowledgements, no supervisor channel, timeout, and non-loopback Host.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- app/actions/restart.test.ts`.
- [ ] **Step 3: Implement the restart action, Settings control, and ADR 0004.** Reuse the existing worker SIGTERM drain; do not add a second worker shutdown mechanism.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- app/actions/restart.test.ts scripts/processSupervisor.test.ts src/worker/shutdownSignals.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add app/actions/restart.ts app/actions/restart.test.ts app/components/RestartApplicationButton.tsx app/settings/config/page.tsx docs/adr/0004-supervised-web-restart.md
git commit -m "feat: add restart control to settings"
```
