# Task 1: Supervisor restart protocol

## Summary

Added a testable process supervisor and wired `scripts/start.mjs` to use it.
Only a web-child `{ type: 'restart', requestId }` IPC request restarts the
process pair. The supervisor acknowledges accepted and duplicate requests,
drains the worker with `SIGTERM`, then stops the web child and starts both
again after their close events. Ordinary child exits and external shutdowns
retain their previous stop-and-exit behavior; external shutdown cancels an
in-progress restart.

## RED/GREEN tests

- The prescribed test command initially found no tests because Vitest excluded
  `scripts/`; added that test path to `vitest.config.ts`.
- With the test path enabled and the supervisor module absent, the focused
  suite failed to import the module as expected.
- A regression test then exposed that an external shutdown during restart
  incorrectly spawned a new process pair (4 spawns instead of 2).
- Fixed by cancelling restart state when `stop(signal)` is called.
- GREEN: `npm test -- scripts/processSupervisor.test.ts` — 1 file, 5 tests
  passed.

## Full suite, typecheck, lint, and format

- `npm run check` — passed. This runs `tsc --noEmit`, ESLint, Prettier check,
  dependency-cruiser, and the full Vitest suite.
- Full suite: 41 test files and 549 tests passed.
- Prettier: all matched files use the repository's formatting.
- Dependency-cruiser: 173 modules, 786 dependencies, no violations.

## Files

- `scripts/processSupervisor.mjs` — supervisor state machine and restart IPC.
- `scripts/processSupervisor.test.ts` — restart, duplicate, crash, and shutdown
  behavior tests.
- `scripts/start.mjs` — supervisor integration and web-child IPC channel.
- `vitest.config.ts` — include the prescribed `scripts/**/*.test.ts` path.
- `.superpowers/sdd/2026-11-02-supervised-restart/task-1-report.md` — this
  report.

## Self-review and concerns

Reviewed the close-event sequence and exit-code handling against the original
`scripts/start.mjs`: unexpected exits still stop the sibling and exit only
after both children close; external signals still reach both children; only
accepted restart IPC triggers a respawn. The tests verify web IPC setup and
worker-before-web shutdown ordering. No process-semantics conflict remains.
The preceding configuration-editor commit (`d7458e7`) is untouched; no
source-file overlap was found.
