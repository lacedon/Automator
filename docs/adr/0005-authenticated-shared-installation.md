# Authenticated, shared installation

Automator used to assume one trusted local user. It is now a shared server with local accounts and per-Project access.

## Decision

- Every request except `/login` needs a session cookie or an `Authorization: Bearer` access token; `proxy.ts` enforces it. The loopback-only restriction is gone; `HOST` selects the listen address.
- Accounts are local (scrypt password hashes). Sessions and access tokens are stored only as SHA-256 hashes. Tokens are shown once, may expire, and can be regenerated or revoked.
- Roles are dynamic sets of `read` and `write`, assigned globally or per Project; a permission is held if any assignment grants it. `write` implies `read`. There are no direct User–Repository grants.
- Global settings, users and roles need a global `write`. Acting on an Automation or Run needs `write` on its Repository's Project. Lists and detail pages are limited to readable Projects, and unreadable entities answer 404. Enforcement is in Server Actions and route handlers, not only the UI.
- Automations and Runs have an owner: existing data belongs to `admin`, new data to its creator. A background Run acts with its owner's current permissions and credentials, and fails or is stopped when the owner is disabled, deleted or loses write access.
- Per-user credentials are AES-256-GCM encrypted with a key file beside the database and are never shown again.
- Empty installations are seeded with `admin`:`admin` so upgrades are never locked out. Security events are written to the process log only, not to the database or UI.

## Consequences

- Repository connection tokens used by pre-checks remain server-wide.
- The CLI opens the database directly and is not authenticated; tokens cover HTTP clients.
- Output of past Runs is not preserved for users who lose access.
