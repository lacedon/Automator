# Web Configuration Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit validated, non-secret Automator settings from the localhost web interface while keeping credentials in `.env`.

**Architecture:** Add a server-only config editor that reads and validates the active config, returns an allowlisted public projection, and merges validated edits back while preserving hidden environment-variable binding names. Add a form page under the Settings navigation created by the Agent Prompt System plan.

**Tech Stack:** TypeScript, Zod, Next.js Server Actions, React, Vitest.

**Spec:** [2026-11-02-agent-prompt-configuration-design.md](../specs/2026-11-02-agent-prompt-configuration-design.md)

## Global Constraints

- The application-settings form follows the existing validated config schema and saves to the active `automator.config.json` file.
- Preserve existing environment-variable binding names server-side without returning them to the browser.
- Do not return or accept secret values; `.env` remains the only credential source.
- The restart endpoint remains localhost-only.

## Review Focus

- Invalid edits must leave the original config file intact; test invalid schema and reference inputs in `src/core/config/editor.test.ts`.
- A config with GitLab/Jira bindings must omit their names from the browser projection but preserve them after save; test both invariants in `src/core/config/editor.test.ts`.
- Missing or unreadable config files must show a visible error, not a success-shaped default; test in `app/actions/config.test.ts`.
- A non-loopback Host or forwarded Host must be rejected; test in `app/actions/config.test.ts` using `isAllowedRequest`.
- Connection binding names cannot be added or edited through the web form; verify actions reject unknown connection keys in `app/actions/config.test.ts`.

---

### Task 1: Add a safe validated config editor service

**Files:**

- Create: `src/core/config/editor.ts`
- Test: `src/core/config/editor.test.ts`
- Modify: `src/core/config/schema.ts`

**Interfaces:**

- Produces `EditableConfig`, an allowlisted projection of non-secret config values. It includes existing connection keys and non-secret host/base URL/status fields, but excludes `tokenEnv` and `emailEnv`.
- `EditableConfig = Omit<z.input<ReturnType<typeof createConfigSchema>>, 'gitlab' | 'jira' | 'prompts'> & { gitlab: Record<string, { host: string }>; jira: { enabled: boolean; connections: Record<string, { baseUrl: string; doneStatusIds?: string[] }> } }`.
- Produces `readEditableConfig(configPath: string): EditableConfig`.
- Produces `writeEditableConfig(configPath: string, input: EditableConfig): void`; it merges allowed edits into the original raw JSON, validates with `createConfigSchema` and `findReferenceIssues`, then atomically replaces the file.
- Web edits may not add/remove connection records because their environment-variable bindings are intentionally local-JSON-only.

- [ ] **Step 1: Write failing tests** for safe projection, hidden binding preservation, valid save, invalid schema/reference rejection, and no partial file overwrite.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- src/core/config/editor.test.ts`.
- [ ] **Step 3: Implement the allowlisted editor** using the existing config schema; never read `.env` values into `EditableConfig`.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- src/core/config/editor.test.ts src/core/config/load.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add src/core/config/editor.ts src/core/config/editor.test.ts src/core/config/schema.ts
git commit -m "feat: safely edit local app configuration"
```

### Task 2: Add the Settings configuration form

**Files:**

- Create: `app/settings/config/page.tsx`
- Create: `app/actions/config.ts`
- Create: `app/actions/config.test.ts`
- Create: `app/components/ConfigForm.tsx`

**Interfaces:**

- Consumes: `readEditableConfig` and `writeEditableConfig` from Task 1.
- `ConfigFormState = FormResult<EditableConfig>`. `saveConfig(_prev: ConfigFormState, formData: FormData): Promise<ConfigFormState>` returns the existing form error pattern and revalidates the Settings layout on success.
- The page provides controls for supported non-secret config fields, links to Agent Settings, and displays validation and file-system errors.

- [ ] **Step 1: Write failing action tests** for valid save, schema error display, unreadable config error, hidden binding-name preservation, and Host/X-Forwarded-Host rejection.
- [ ] **Step 2: Run tests to verify they fail.** Run: `npm test -- app/actions/config.test.ts`.
- [ ] **Step 3: Implement the page, action, and form** with existing server-action/error patterns and `isAllowedRequest`; leave `.env` editing and binding-name fields unavailable.
- [ ] **Step 4: Run tests to verify they pass.** Run: `npm test -- app/actions/config.test.ts src/core/config/editor.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add app/settings/config app/actions/config.ts app/actions/config.test.ts app/components/ConfigForm.tsx
git commit -m "feat: add web configuration editor"
```
