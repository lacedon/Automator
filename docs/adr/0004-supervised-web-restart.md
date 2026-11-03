# Restart the application through the supervisor

The Configuration Settings page exposes restart as a separate, confirmed action. Saving configuration never restarts the application implicitly.

## Decision

- The Server Action validates the request with `isAllowedRequest`, which requires a loopback `Host` and, when present, a loopback `X-Forwarded-Host`.
- The web child sends `{ type: 'restart', requestId }` over its supervisor IPC channel and waits up to five seconds for the matching `restart-accepted` or `restart-rejected` acknowledgement.
- The action reports success only after a matching acceptance. Missing or disconnected IPC, send failures, rejection, and timeout are explicit errors.
- The Settings control uses the existing native confirmation dialog and shows accepted/draining status only after acceptance.
- The supervisor remains responsible for shutdown ordering: it signals the worker and waits for the existing worker drain before stopping and restarting the web child. No second worker shutdown mechanism is introduced.

## Consequences

- Restart can be requested only from loopback requests, including when a forwarded host is present.
- A timeout or rejected request is not presented as a successful restart. The five-second acknowledgement timeout bounds how long the Settings action waits; it does not cancel a request already received by the supervisor.
- Acceptance means the supervisor accepted the restart request, not that the new process pair is ready.
