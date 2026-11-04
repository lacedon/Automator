# Multi-provider Run execution

## Status

Approved. Implements the intent of [issue #33](https://github.com/lacedon/Automator/issues/33), with provider selection confirmed as installation-wide rather than per Agent.

## Intent

Allow one Automator installation to run queued and ad-hoc work with GitHub Copilot CLI, Claude Code, Codex CLI, or OpenCode. Preserve the existing queue and Run lifecycle, use Copilot for installations that have not opted in to another provider, and make the provider used by each Run visible in its history.

## Decisions

| Area               | Decision                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection          | One global provider setting, editable in Settings. Agent assignments continue to select instructions, not providers.                                                                                                                                                                     |
| Compatibility      | Missing provider configuration means Copilot. Existing `copilotBin`, `runs.defaultModel`, and `runs.models` remain the Copilot executable and model settings; new provider-specific settings cover Claude Code, Codex, and OpenCode. No existing installation is switched automatically. |
| Run identity       | Persist provider and model on each Run at enqueue time. Existing rows migrate to `copilot`. A queued Watch Run keeps its provider and model when later events coalesce into it; a follow-up inherits its parent Run's provider and model.                                                |
| Execution boundary | Provider adapters own CLI invocation, model and session arguments, process output normalization, and provider-specific errors. The shared executor owns cwd, serialization, timeout, cancellation, shutdown/recovery, and finalization.                                                  |
| Fallback           | Never switch providers implicitly. Missing executables, authentication errors, invalid models, unsupported capabilities, and non-zero exits remain visible Run failures with provider-specific next steps.                                                                               |
| Models             | Keep a configurable default and supported-model list for each provider. Settings and Run forms use the configured list; adapters validate options and report provider rejections rather than retrying with another model.                                                                |
| Notifications      | Teams notification remains on its existing Copilot path; it is not a queued Agent Run.                                                                                                                                                                                                   |
| CLI versions       | Document versions used for smoke validation; do not hard-reject newer versions solely by version number.                                                                                                                                                                                 |

## Configuration and persistence

Add a validated global `provider` selector and provider-specific executable/model settings for Claude Code, Codex, and OpenCode. Keep the existing Copilot fields canonical for Copilot. Preserve the current config editor's rule that secret values and environment-variable names never reach the browser. Prefer each CLI's native authentication store; an environment credential may be used only when the CLI can keep it out of the coding agent's tool environment. Never put provider credentials in the JSON config.

Add a SQLite migration that adds a constrained `provider` value to `runs`, defaulting old rows to `copilot`. Pass provider through queue creation, Watch queue coalescing, ad-hoc requests, and follow-ups. A follow-up must retain its parent provider/session even if the global setting changes. Validate the selected provider and model before starting a process; reject unsupported configured options with an actionable error.

Expose provider-specific model options to ad-hoc and Watch model controls. A Watch's saved model remains an override; if the selected provider cannot use it, fail validation visibly rather than changing the provider or silently using its default.

## Execution architecture

Replace the executor's Copilot-only dependency with a common provider launcher contract. Each adapter accepts the Repository folder, prompt, model, transcript/result/log paths, environment, and opaque session data, and returns a process handle compatible with the existing watchdog. Every supported adapter must support non-interactive execution and continuation for follow-up Runs.

All adapters use the existing prompt and normalized `{ outcome, summary }` result-file contract. Provider-native output is normalized into the Run transcript and logged; malformed/missing result data, spawn errors, authentication failures, and provider exits map to the existing structured `RunError` lifecycle. Run records (and Run detail/list views) include the provider used. Any result-file version change must remain readable alongside existing result artifacts.

The worker continues to start the CLI in the configured Repository folder. This preserves repository-local instructions, skills, and MCP configuration where each CLI recognizes them. Adapters do not copy or translate those files. The shared Automator rules and configured restrictions remain in force; each adapter must use its supported non-interactive permission controls and either enforce a configured restriction or fail clearly when it cannot. Provider API credentials are not exposed to the coding agent's tool subprocesses. Capability differences and authentication setup are documented per provider.

Codex uses the `workspace-write` sandbox and receives a narrow additional write grant for the current Run's artifact directory, which is outside the Repository and contains its required result file. It must not be granted broader filesystem access for this purpose.

## Settings and user documentation

The existing Settings config editor exposes the global provider, executable, default model, and supported model list for all four CLIs. Run lists and detail pages identify the provider independently of the current global selection. Update the example config and README with installation, native authentication, model configuration, provider-specific repository instructions/skills/MCP behavior, and troubleshooting.

Document a manual smoke procedure per provider: verify CLI version and authentication, execute an ad-hoc Run, execute a Watch-triggered Run in the assigned Repository, verify transcript/result/history, then verify cancellation and follow-up continuation. Record the version used; a live smoke is not a substitute for automated tests.

## Acceptance and tests

- Selecting any configured provider works for ad-hoc and Watch-triggered Runs; Copilot remains the default for legacy configuration.
- Provider/model selection is validated and persisted per Run, including queue coalescing and follow-ups.
- Each adapter has fake-CLI tests for arguments, cwd, session/model propagation, output normalization, missing CLI, authentication, unsupported options, and execution failures.
- Existing lifecycle tests continue to cover one active Run, timeout, cancellation, shutdown/recovery, and no provider fallback.
- Settings, model choices, and Run history identify the selected/used provider.
- README and example configuration document setup and capability differences for all four providers.

Run the focused configuration, queue, executor, read-model, and Settings tests, then `npm run check`. Live CLI smoke checks require the user's installed CLIs and authentication and are documented rather than run in CI.

## References

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [session management](https://code.claude.com/docs/en/sessions)
- [Codex CLI documentation](https://developers.openai.com/codex/cli/)
- [OpenCode CLI documentation](https://opencode.ai/docs/cli/)
- [GitHub Copilot CLI documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/using-copilot-cli)
