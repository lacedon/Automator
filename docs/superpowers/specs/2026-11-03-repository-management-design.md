# SQLite Repository Management Design

## Goal

Move Automator's Repository list from `automator.config.json` into its local SQLite database and manage it in Settings, without changing how Watches and Runs identify a Repository by name.

## Current context

The application already shares one SQLite database between the worker and dashboard. Repository definitions currently live in the JSON config and are read by Watch/Run validation, execution, recovery, CLI, dashboard form options, Projects, and Agent settings. GitLab, GitHub, and Jira connection definitions remain in config; their token and email values continue to come from environment variables.

## Design

Add a `repositories` table to the existing versioned database schema. Each row stores a case-preserving Repository name, resolved local folder, nullable GitLab/GitHub/Jira connection names, and JSON-encoded validation commands. Repository names remain the public identifier used by existing Watch and Run records. Repository persistence must never store credential values.

Introduce a Repository service as the single source for listing, lookup, CRUD, and operational validation. Operational validation checks that the folder exists and each configured connection name exists in the corresponding config connection map. Settings must show invalid records and actionable errors; use of an invalid Repository by Watch or Run creation/execution must fail explicitly instead of falling back to another source or connection.

Each usable Repository must reference at least one GitLab or GitHub connection; Jira remains optional and may be configured independently.

Repository names are unique case-insensitively. A rename is one transaction that updates references in Watches, Runs, Project membership, and Repository-specific Agent assignments, preserving their associations. Deletion is blocked while any Watch references the Repository; successful deletion removes its Project membership and Repository-specific Agent assignments but preserves Runs and all local files.

On startup, after opening and migrating the database, import the legacy config `repositories` object only when it is present, the database table is empty, and a migration marker is absent. Import rows transactionally, set the marker only after success, and log the imported names. Once the marker exists, ignore the legacy list even if it is later edited or becomes empty. Keep the legacy shape parseable for import, but do not use it as runtime Repository data.

The Settings UI gains a Repositories section for create, edit, and delete. Save validates non-empty names, an existing local folder, and connection references. Invalid imported rows remain visible so the user can correct them. Deletion is rejected when Watches reference the Repository; no operation may delete or modify files inside the Repository folder. Project membership and Agent assignments continue to refer to Repository names and are updated or removed as described above.

Dashboard and worker consumers, including form options, CLI validation, Watch/Run creation, prompt validation commands, Run execution, recovery, and read models, obtain Repository records from the service. Missing or invalid Repository information is reported in the existing result/error channels.

## Migration and compatibility

The DB schema migration creates the table without changing existing Watch/Run rows. The config importer is independent from schema migration and guarded by its own persistent marker so it is safe on every startup. When no legacy list exists, startup completes without inserting rows. After import, config saves must neither serialize nor overwrite a Repository list. The example config omits `repositories` and documents managing them in Settings.

## Validation and tests

- Repository-store tests cover list/get/create/update/delete, case-insensitive duplicate names, reference preservation on rename, connection references, folder existence, watch-protected deletion, and preservation of folder contents.
- Startup/import tests cover import, absent legacy data, idempotency, empty-table guarding, transactional failure behavior, and ignoring later config changes.
- Consumer tests cover Repository resolution by name, validation failures, and use of persisted folder, connections, and validation commands.
- Settings tests cover CRUD actions, visible validation failures, and watch-protected deletion.
- Update README migration/setup guidance, the Repository section, `automator.config.example.json`, and the Repository entry in `GLOSSARY.md`.

## Constraints

- GitLab, GitHub, and Jira connection hosts and credential environment-variable references remain in config.
- Credential values are not stored in SQLite or tracked configuration.
- Repository references are by name; no GitLab-backed discovery or storage is introduced.
- Removing a Repository never deletes files from its local folder.
- A Repository with Watches cannot be deleted.
