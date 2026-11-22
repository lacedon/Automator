# Interactive Chats: provider spike (PR 3, Step 1)

Run on 2026-11-21 in a scratch git repo under `/tmp`. Nothing was installed globally. Every real call used each provider's cheapest model with a minimal prompt.

## Legend and environment

- **VERIFIED**: observed in this spike. The evidence is quoted or summarized, and the JSONL samples are in [Captured exchanges](#captured-exchanges).
- **FROM DOCS**: taken from official documentation or the package README (URL or path given). Not run.
- **UNVERIFIED**: neither run nor documented well enough to rely on.

| Provider    | Tested with                                                                                                                                                        | Real calls       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Claude Code | `claude` 2.1.330 (logged in) and `@agentclientprotocol/claude-agent-acp` 0.109.1 (SDK `@anthropic-ai/claude-agent-sdk` 0.3.330), model `claude-haiku-4-5-20251001` | about 14 prompts |
| pi          | `pi` 1.6.0, `--mode rpc`, model `anthropic/claude-haiku-4-5`                                                                                                       | about 21 prompts |
| Codex       | `@agentclientprotocol/codex-acp` 2.9.0 (bundles `codex-cli` 0.171.0 as a local npm dependency). No Codex auth, so `initialize` only                                | 0                |
| Copilot     | `copilot` not installed. Docs only                                                                                                                                 | 0                |
| OpenCode    | `opencode` not installed. Docs only                                                                                                                                | 0                |

Method notes:

- The ACP adapters were installed with a **local** `npm i` under `/tmp/spike/acp` (not global, no `npx` needed). Both ran without extra setup. A hand-written newline-delimited JSON-RPC client (about 40 lines of Node) drove them, so a hand-written client is viable and no runtime dependency is needed. The final ADR check is "no new dependency".
- `pi` was driven by a hand-written JSONL client. `PI_*` variables were removed from the child environment (the spike itself ran inside pi).
- The default Claude model for the adapter is `sonnet`. Haiku does not support Auto mode, and the adapter says so with an `agent_message_chunk` (see item d and the risks).

## Summary

| Provider    | Interactive                                       | Resume                           | Streaming  | Turn completion            | Automator tools                                                        | Native questions                  | Native timers                                                 |
| ----------- | ------------------------------------------------- | -------------------------------- | ---------- | -------------------------- | ---------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| Claude Code | **yes** (VERIFIED)                                | VERIFIED (`session/load`)        | VERIFIED   | VERIFIED (`stopReason`)    | MCP stdio VERIFIED, a 660 s tool call VERIFIED                         | VERIFIED (`elicitation/create`)   | VERIFIED: fires unprompted while idle, no explicit end marker |
| pi          | **yes** (VERIFIED)                                | VERIFIED (`--session`)           | VERIFIED   | VERIFIED (`agent_settled`) | extension VERIFIED (blocks at least 660 s); native MCP client VERIFIED | VERIFIED (`extension_ui_request`) | none built in                                                 |
| Codex       | no: no auth available, only `initialize` verified | UNVERIFIED (docs: `loadSession`) | UNVERIFIED | UNVERIFIED                 | FROM DOCS (stdio, default tool timeout 60 s)                           | FROM DOCS                         | none                                                          |
| Copilot     | no: CLI not installed                             | UNVERIFIED                       | FROM DOCS  | FROM DOCS                  | FROM DOCS                                                              | undocumented                      | none (`/tasks` unsupported over ACP)                          |
| OpenCode    | no: CLI not installed                             | FROM DOCS                        | FROM DOCS  | FROM DOCS                  | FROM DOCS                                                              | FROM DOCS (`elicitation/create`)  | none                                                          |

Two providers pass (Claude Code, pi).

### Findings that contradict or refine the spec and plan

1. **pi does have an MCP client (clarification 13 is out of date).** In pi 1.6.0 the built-in `builtin:mcp` extension connects stdio servers from `~/.pi/agent/mcp.json` or the project's `.pi/mcp.json` (project file needs trust, `--approve` grants it for one run). A tool is only callable by the model when the server has `"exposure": "direct"` (otherwise it is reachable through `codemode`/`tool_search`, and without those pi warns "they cannot be called"). Its default per-request timeout is **60 s** and is configurable per server (`timeout`, seconds). This does not change the plan's decision to use a bundled pi extension, which needs no config files or trust prompt and was verified to block for 660 s. The note in clarification 13 should say "pi has an MCP client but Automator uses an extension because it needs neither user config nor project trust".
2. **User extensions and MCP load in `--mode rpc` by default.** With the user's normal install, `pi --mode rpc` loaded the user's extensions and emitted many `extension_ui_request` records (`notify`, `setStatus`) before the first prompt. The pi driver must pass `--no-extensions` and then `-e <automator extension>` (and `-e builtin:mcp` only if MCP is wanted), and must ignore fire-and-forget `extension_ui_request` methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`).
3. **The Claude adapter reads the user's Claude settings** (user plugins, agents and slash commands show up in `available_commands_update`, 134 to 139 commands, and in the `agent` config option). The one-shot Claude launcher does the same through the `claude` CLI, so this matches today's behaviour. It is a prompt-size and noise concern, not a blocker.
4. **Claude MCP servers inherit the adapter's environment.** An environment variable set on the adapter process (`SPIKE_SECRET_TOKEN`) was visible in the MCP server child. Automator must therefore pass the adapter a `childEnv`-filtered environment, which the plan already requires. The adapter also adds its own `CLAUDE_CODE_MESSAGING_TOKEN` to MCP children (session-internal).
5. **Claude Auto permission mode is unavailable for Haiku**, and the adapter reports it as an `agent_message_chunk` (`"> **Auto mode unavailable:** ..."`) when the model or mode is set. The driver should set `mode` to `bypassPermissions` for `allowAll` (zero permission requests, see item f), and should drop `agent_message_chunk` text that arrives outside a `session/prompt` call or before the first prompt of a session from the transcript (this text arrives during `session/set_config_option`, before the prompt).
6. **`session/load` replays history as `session/update` notifications** (Claude, and per docs OpenCode). The driver must swallow updates received between sending `session/load` and its response, or they would be appended to the new turn's transcript. `session/resume` (advertised) avoids the replay but was not tested.
7. **No explicit start or end signal for unprompted Claude turns.** See item i. PR 5 needs the settle-window fallback (`AGENT_SETTLE_MS`) or the adapter-specific final `usage_update` carrying `cost`.

No result blocks a spec decision. MCP tool calls can block 10 minutes on Claude (verified at 11 minutes with no progress) and pi (extension verified; MCP verified with a raised timeout). Native timers do fire over ACP. Resume works for both runnable providers.

## Claude Code (`@agentclientprotocol/claude-agent-acp`)

- **(a) Version and install: VERIFIED.** `claude` 2.1.330. Adapter `@agentclientprotocol/claude-agent-acp` 0.109.1, `npm i @agentclientprotocol/claude-agent-acp`, binary `claude-agent-acp` (`dist/index.js`, runs under plain `node`). Authentication reuses the existing `claude` login (`authMethods: []`). A run with an environment that has no credential-looking variables authenticated and ran a Bash tool call, so the `childEnv` filtering is compatible. The package name is `@agentclientprotocol/claude-agent-acp`, not `@zed-industries/...`.
- **(b) `initialize`: VERIFIED.** Result: `loadSession: true`, `promptCapabilities {image, embeddedContext}`, `mcpCapabilities {http, sse, acp}`, `sessionCapabilities {additionalDirectories, close, delete, fork, list, options, resume, status, systemPrompt, title}`, `_meta.claudeCode.promptQueueing: true`, `_meta.steering.supported: true`. The client advertised `clientCapabilities.elicitation.form` (see item h). The adapter also sends non-standard notifications (`_auth/status_update`, `auth/status_update`) that include the account email. The driver must ignore unknown notifications and must not log them verbatim into a shared log.
- **(c) `session/new` and `session/load` after restart: VERIFIED.** `session/new {cwd, mcpServers}` returns `{sessionId, modes, configOptions}`. After the process exited, a new process answered `session/load {sessionId, cwd, mcpServers}` in 265 ms with the same session, replayed the history (2 `user_message_chunk`, 2 `agent_message_chunk`, 1 `tool_call`, 1 `tool_call_update`), and a follow-up prompt ("what command did I ask you to run earlier?") answered `echo hi > x.txt`. An unknown id returns JSON-RPC error `-32002 "Resource not found"` with `data.sessionId`, so a failed resume is detectable (`SESSION_RESUME_FAILED`). Load restores the permission mode (`default`) but the model must be re-applied (item d).
- **(d) Model selection: VERIFIED.** `session/set_config_option {sessionId, configId: "model", value}` with a value from `configOptions[model].options` (`claude-haiku-4-5-20251001`, `sonnet`, `haiku`, `opus`, ...). The response lists the new `configOptions`. There is no start flag. The initial model is `sonnet`. Setting a model that lacks Auto mode switches the mode to `acceptEdits` and emits the notice text described in finding 5. `session/set_model` was not tried.
- **(e) Streaming and completion: VERIFIED.** `session/update` with `sessionUpdate: "agent_message_chunk"` and `content {type: "text", text}` (token-level pieces such as `"The"`, `" A"`, `"skUserQuestion tool could"`), `tool_call` / `tool_call_update` (`status` `pending`, `in_progress`, `completed`, `failed`), `usage_update`, `available_commands_update`, `session_info_update`, `current_mode_update`. The turn ends when the `session/prompt` request returns `{stopReason: "end_turn" | "cancelled", usage, _meta}`. Long tool calls send `tool_call_update` with `status: "in_progress"` and `_meta.claudeCode.toolResponse.elapsedTimeSeconds` every 30 s.
- **(f) Permissions: VERIFIED.** Mode `default` sends the client request `session/request_permission` with `toolCall {toolCallId, name, status, rawInput, title, kind, content, locations, _meta}` and `options [{optionId: "allow-once", kind: "allow_once"}, {optionId: "allow-with-updates", kind: "allow_always"}, {optionId: "reject", kind: "reject_once"}]`. Replying `{outcome: {outcome: "selected", optionId: "allow-once"}}` let the tool run. MCP tools also go through this request (`kind: "other"`, `name: "mcp__sleepy__sleep_tool"`), so a policy must allow `mcp__automator__*`. **Setting `configId: "mode"`, `value: "bypassPermissions"` produced zero permission requests** and the tool ran, which matches the one-shot launcher (`--permission-mode bypassPermissions`). Recommended: `allowAll` maps to `bypassPermissions`, and the driver still answers any request by policy.
- **(g) MCP servers: VERIFIED.** `mcpServers: [{name, command, args, env: [{name, value}]}]` in `session/new` is honoured: the adapter listed the tool, called it, and returned the result (the model reaches deferred MCP tools through `ToolSearch` first, one extra `tool_call` in the transcript). `tools/call` carries `_meta.progressToken` and `_meta["claudecode/toolUseId"]`. **A 660 s (11 min) tool call with no progress notifications completed** (`stopReason end_turn`, 664 s wall time). So `runs.questionWaitMs` = 10 min is feasible without progress; progress notifications were not needed. The MCP server's environment was the adapter's environment plus the listed `env` (finding 4). `mcpServers` are also accepted by `session/load`. Not measured: the adapter's own tool timeout setting. The SDK default is far above 10 minutes. Automator should still send progress notifications (harmless) and set `MCP_TOOL_TIMEOUT` explicitly in the adapter environment as a safeguard (UNVERIFIED that the env var is honoured).
- **(h) Native questions: VERIFIED.** The model's `AskUserQuestion` tool arrives as a `tool_call` (`name: "AskUserQuestion"`, `title: "Asking for your input"`, then `rawInput {questions: [{question, header, options: [{label, description}], multiSelect}]}`) followed by a client request `elicitation/create` `{mode: "form", sessionId, toolCallId, message, requestedSchema: {type: "object", properties: {question_0: {type: "string", title, oneOf: [{const, title, description}]}, question_0_custom: {type: "string", title: "Other"}}}}`. It only appears when the client advertised `clientCapabilities.elicitation.form`. Answering `{action: "accept", content: {question_0: "Blue"}}` made the tool complete with `Your questions have been answered: "Which color?"="Blue"` and the model replied `Blue`. Answering `{action: "cancel"}` made the tool fail (`Tool permission request failed: Error: Tool use aborted`) and the model reported that it could not ask. Free text goes in `question_N_custom`. The request stays pending until the client answers (not timed out in the 3 s the test waited, and the same transport allowed a 660 s tool call). Multi-select and several questions use more `question_N` keys (UNVERIFIED).
- **(i) Native timers: VERIFIED.** The adapter advertises `/loop` and `/schedule` as commands and the model has `CronCreate` (`rawInput {cron, prompt, recurring}`). With one-shot `CronCreate` set for the next minute, the session was idle (no `session/prompt` in flight) when the timer fired. The adapter sent, with no request from the client: `usage_update`, then `agent_message_chunk {text: "tick"}` (with a `messageId`), then two more `usage_update` notifications, the last one carrying `cost`. **There is no turn-start notification and no end signal.** The tail `usage_update` with `cost` is adapter-specific. `ScheduleWakeup` was not exercised. Timers are in-process: they are lost when the adapter stops (documented for Claude Code scheduled tasks, not retested).
- **(j) Cancel: VERIFIED.** The notification `session/cancel {sessionId}` made the pending `session/prompt` return `{stopReason: "cancelled"}` within 12 ms, and the session accepted the next prompt (`end_turn`).
- **(k) Crash: VERIFIED.** `SIGKILL` on the adapter closed the pipes. The exit is `code null, signal SIGKILL` and the pending `session/prompt` never resolves, so the driver must reject all pending requests on process exit (`exit` event) and map it to `PROVIDER_ERROR`. A clean `stdin.end()` exited with code 0.
- **(l)**: not applicable.

## pi (`pi --mode rpc`)

- **(a) Version and install: VERIFIED.** `pi` 1.6.0 at `~/.pi/agent/bin/pi` (managed install). Models: `pi --list-models`.
- **(b) `get_state`: VERIFIED.** `{model: {id, provider, ...}, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile, sessionId, sessionName?, autoCompactionEnabled, messageCount, pendingMessageCount}`. `--mode rpc` has no `initialize`; the process is ready after the first response (about 150 ms).
- **(c) Session resume: VERIFIED.** `--session-id <id>` creates the session with that id (FROM DOCS: or reopens the existing one for the same working directory, `cli.md`; only the creation was run). Spike: `--session-id spike-one` (get_state `sessionId: "spike-one"`, `messageCount 0`), prompt "Remember the codeword PELICAN", stdin closed (exit 0). A new process with `--session spike-one` reported `messageCount: 3`, and answered the next prompt with `PELICAN`. `--session <unknown>` exits with code 1 and stderr `No session found matching '<id>'` before any record is written, so a failed resume is detectable (`SESSION_RESUME_FAILED`). Use `--session-dir <dataDir>/...` so sessions live outside the user's directory. A session is stored per working directory, which fits the stable per-Chat copy path. UNVERIFIED: resuming from a different working directory (docs say pi offers a fork interactively).
- **(d) Model selection: VERIFIED.** `--model anthropic/claude-haiku-4-5` (provider/id). `set_model` also exists (FROM DOCS, `rpc-commands.md`). `--thinking <level>` optional.
- **(e) Streaming and completion: VERIFIED.** The `prompt` command returns `{type: "response", command: "prompt", success: true, data: {disposition: "started"}}` immediately. Events: `agent_start`, `turn_start`, `message_start/end` (roles `system`, `user`, `assistant`, `toolResult`), `message_update` with `assistantMessageEvent {type: "text_delta", delta}` (other types for thinking and tool calls), `tool_execution_start/update/end`, `turn_end`, `agent_end`, then **`agent_settled {aborted}`**. `agent_end` can be followed by more work (a second `turn_start` appeared after an abort), so the driver must complete the turn on `agent_settled`, not `agent_end`. A `disposition` other than `started` (for example `handled`) means no `agent_settled` will follow (FROM DOCS, `rpc.md`). The `message_start` for the `system` role carries the whole system prompt and must not be written to the transcript.
- **(f) Permissions: VERIFIED (none).** pi has no tool-permission request. Tool policy is applied at start with `--tools` / `--exclude-tools` (FROM DOCS, `pi --help`; the exclusion flag was not exercised).
- **(g) MCP: VERIFIED.** pi has a built-in MCP client (finding 1). With `-ne -e builtin:mcp --approve` and `.pi/mcp.json` `{"mcpServers": {"sleepy": {"command", "args", "timeout": 60, "exposure": "direct"}}}`: a 3 s tool call returned `slept 3` (tool name `mcp__sleepy__sleep_tool`). **With the default 60 s timeout, a 90 s call failed after 60 s** with the tool result `MCP request timed out after 60000ms` (`isError: true`) and the server received `notifications/cancelled {reason: "Request timed out"}`. **With `"timeout": 600` and progress notifications every 20 s, a 90 s call succeeded.** A 600 s timeout equals `questionWaitMs` exactly, so a configured MCP timeout would need margin. Not used by the plan (extension chosen).
- **(h) Native questions: VERIFIED.** An extension tool calling `ctx.ui.select(title, options)` produced `{"type":"extension_ui_request","id":"<uuid>","method":"select","title":"Pick one","options":["red","blue"]}` on stdout. The tool blocked until the client wrote `{"type":"extension_ui_response","id":"<uuid>","value":"blue"}` and the model then saw `user chose: blue`. Held for 95 s before answering with no timeout (the request carries a `timeout` field only if the extension passed one). Other dialog methods: `confirm` (`confirmed: true/false`), `input` (`value`), `editor` (`value`); `cancelled: true` for any (FROM DOCS, `rpc-extension-ui.md`). pi has no built-in question tool, so a question exists only when an extension raises it. Automator's bundled extension is that source.
- **(i) Native timers: FROM DOCS.** None built in (spec research table). Not re-verified.
- **(j) Abort: VERIFIED.** `{"type":"abort"}` during a running extension tool: the tool received its `AbortSignal`, the response `{"type":"response","command":"abort","success":true}` arrived 5 ms later with `agent_settled {aborted: true}`, and the next `prompt` worked (`agent_settled {aborted: false}`). **If the tool ignores its `AbortSignal`, the `abort` response is delayed until the tool returns** (the first attempt timed out at 30 s with a 60 s tool). The bundled extension must honour `signal`, and the driver must still escalate to `stop()` after a deadline.
- **(k) Crash: VERIFIED.** `SIGKILL` mid-turn: exit `code null, signal SIGKILL`, no further records. Closing stdin: exit 0 (orderly shutdown, FROM DOCS: SIGTERM does the same).
- **(l) Extension in rpc mode: VERIFIED.** `--no-extensions -e /path/ext.mjs` loaded a plain JavaScript extension (default export `function (pi) { pi.registerTool({name, label, description, parameters: <JSON Schema>, execute(id, params, signal, onUpdate, ctx)}) }`, no TypeBox import needed). `ctx.ui.select` works in rpc mode (`ctx.hasUI` is true, per docs). **A tool call that blocked for 660 s (11 min, `durationMs: 660002`) completed normally, with no progress updates, and a pending `ctx.ui.select` held for 95 s resolved when answered.** pi applies no timeout to extension tools, so `runs.questionWaitMs` = 10 min is feasible.

## Codex (`@agentclientprotocol/codex-acp`)

`codex` is not installed and there is no Codex login, so only `initialize` was run.

- **(a) Install: VERIFIED/FROM DOCS.** `npm i @agentclientprotocol/codex-acp` 2.9.0 (binary `codex-acp`). It pulls in `@openai/codex` 0.171.0 as a dependency (a local `node_modules/.bin/codex`), so no separate global Codex CLI is required (`CODEX_PATH` overrides). The npm name is `@agentclientprotocol/codex-acp` (the spec says the same). `@zed-industries/codex-acp` 0.16.0 is an older name.
- **(b) `initialize`: VERIFIED.** `loadSession: true`, `promptCapabilities {embeddedContext, image}`, `mcpCapabilities {acp, http, sse: false}`, `sessionCapabilities {resume, list, close, delete, fork, title, additionalDirectories, systemPrompt}`, `authMethods [api-key, chat-gpt]`. It needs a writable `CODEX_HOME` (`CODEX_HOME` pointing to a missing directory exits 1). `session/new` without auth returns `-32000 "Authentication required"`.
- **(c) to (k): UNVERIFIED (no auth).** From the package README: model, effort, approval and sandbox mode are session config options; `INITIAL_AGENT_MODE` (`read-only`, `workspace-write`, `agent`, `agent-full-access`) and `CODEX_CONFIG` (JSON merged into the Codex config) are environment options; `CODEX_API_KEY`/`OPENAI_API_KEY` authenticate. `session/load` and `session/resume` exist per `initialize`. MCP servers: stdio, HTTP and MCP-over-ACP.
- **(g) FROM DOCS** (https://learn.chatgpt.com/docs/extend/mcp.md): per-server `tool_timeout_sec` default **60 s**, configurable; `startup_timeout_sec` default 10 s. Over ACP the timeout would have to be set through `CODEX_CONFIG`/`config.toml` `mcp_servers.<name>.tool_timeout_sec` (UNVERIFIED that the adapter forwards `mcpServers` with that field).
- **(h) FROM DOCS** (https://raw.githubusercontent.com/agentclientprotocol/codex-acp/main/docs/async-questions.md): Codex's blocking `request_user_input` and the async `request_user_input_async` are mapped to `elicitation/create` (async ones with `_meta.codex.delivery: "async"`, answered by `turn/steer`). Blocking behaviour over ACP is UNVERIFIED.
- **(i) FROM DOCS**: no native timers in the CLI.
- **Result:** resume, streaming and turn completion are not verified, so `interactive` stays `false`.

## Copilot (`copilot --acp`)

`copilot` is not installed. Everything below is FROM DOCS (https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server, fetched 2026-11-21) and not verified.

- **(a)** public preview. Install per GitHub's Copilot CLI docs (not run).
- **(b)** `initialize` result not documented. The docs' example uses an empty `clientCapabilities` and `session/new {cwd, mcpServers: []}`.
- **(c)** The docs say sessions are "created or loaded" and `/resume` is not available over ACP. `session/load` support is UNVERIFIED.
- **(d)** `--model` at server start (as in `copilotLauncher`). `session/set_model` UNVERIFIED.
- **(e)** `session/update` `agent_message_chunk`; `session/prompt` result `stopReason` (the docs' example checks `promptResult.stopReason !== "end_turn"`).
- **(f)** `requestPermission` client method exists in the docs' example. Tool filtering is fixed at server start: `--available-tools`, `--excluded-tools`, `--effort`. Whether `--allow-all-tools` / `--deny-tool` are honoured over ACP is UNVERIFIED.
- **(g)** `session/new` accepts `mcpServers`. Tool-call timeout UNVERIFIED.
- **(h)** Not documented.
- **(i)** None.
- **(j) to (k)** UNVERIFIED. stdio mode shuts down when stdin closes.
- **Result:** `interactive: false`.

## OpenCode (`opencode acp`)

`opencode` is not installed. Everything below is FROM DOCS (https://opencode.ai/docs/cli/acp/, fetched 2026-11-21) and not verified.

- **(b)** `loadSession: true`, `mcpCapabilities {http: true, sse: false}` (stdio is ACP baseline), `promptCapabilities {embeddedContext, image}`, `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}`.
- **(c)** `session/load` replays messages; `session/resume` does not. The client must pass the session's original `cwd`.
- **(d)** `session/set_config_option {configId: "model", value: "provider/model"}` (and `effort`, `mode`).
- **(e)** `session/update` chunks, `stopReason` and `usage`. One prompt at a time; a second `session/prompt` is an error.
- **(f)** `session/request_permission` with options `once` (allow_once), `always` (allow_always), `reject` (reject_once).
- **(g)** stdio and HTTP MCP servers in `session/new|load|resume|fork`. Tool timeout not documented.
- **(h)** `elicitation/create` (form mode) when the client advertises `elicitation.form`; `<key>_custom` for typed answers; cancel on decline.
- **(i)** None.
- **(j)** `session/cancel` ends the prompt with `stopReason: "cancelled"`, rejects pending permission requests.
- **(k)** Exits when stdin closes. Crash behaviour UNVERIFIED.
- **Result:** `interactive: false` until verified.

## Captured exchanges

Trimmed: long fields replaced by `(trimmed)`, `usage_update`, `session_info_update` and `current_mode_update` notifications dropped, the account email redacted, `$HOME` paths redacted. `→` is client to agent, `←` is agent to client.

### Claude (`claude-agent-acp` 0.109.1, one prompt)

```jsonl
→ {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {"elicitation": {"form": {}}}, "clientInfo": {"name": "automator-spike", "version": "0"}}}
← {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": true, "promptCapabilities": {"image": true, "embeddedContext": true}, "mcpCapabilities": {"http": true, "sse": true, "acp": true}}, "agentInfo": {"name": "@agentclientprotocol/claude-agent-acp", "title": "Claude Agent", "version": "0.109.1"}, "authMethods": []}}
→ {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/tmp/spike/repo", "mcpServers": []}}
← {"jsonrpc": "2.0", "method": "auth/status_update", "params": {"state": "authenticated", "accounts": [{"label": "Claude Pro", "active": true, "email": "<redacted-email>", "organization": "<redacted>", "_meta": {"claudeCode": {"kind": "account", "plan": "pro"}}}]}}
← {"jsonrpc": "2.0", "id": 2, "result": {"configOptions": [{"id": "model", "currentValue": "sonnet", "options": "(trimmed)"}, {"id": "effort", "currentValue": "default", "options": "(trimmed)"}, {"id": "mode", "currentValue": "auto", "options": "(trimmed)"}, {"id": "agent", "currentValue": "default", "options": "(trimmed)"}], "sessionId": "6daa984d-0745-4c53-991f-70d5078f4224", "modes": {"currentModeId": "auto", "availableModes": "(trimmed)"}}}
→ {"jsonrpc": "2.0", "id": 3, "method": "session/set_config_option", "params": {"sessionId": "6daa984d-0745-4c53-991f-70d5078f4224", "configId": "model", "value": "claude-haiku-4-5-20251001"}}
← {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "6daa984d-0745-4c53-991f-70d5078f4224", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "\n\n> **Auto mode unavailable:** the selected model does not support Auto mode; using Accept edits instead.\n\n"}}}}
← {"jsonrpc": "2.0", "id": 3, "result": {"configOptions": [{"id": "model", "currentValue": "claude-haiku-4-5-20251001", "options": "(trimmed)"}, {"id": "mode", "currentValue": "acceptEdits", "options": "(trimmed)"}, {"id": "agent", "currentValue": "default", "options": "(trimmed)"}]}}
→ {"jsonrpc": "2.0", "id": 4, "method": "session/prompt", "params": {"sessionId": "6daa984d-0745-4c53-991f-70d5078f4224", "prompt": [{"type": "text", "text": "Reply with the word ok and nothing else."}]}}
← {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "6daa984d-0745-4c53-991f-70d5078f4224", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "ok"}, "messageId": "msg_011ChHAhEn1hcsrH3jQw6czC"}}}
← {"jsonrpc": "2.0", "id": 4, "result": {"stopReason": "end_turn", "usage": "(trimmed)", "_meta": "(trimmed)"}}
```

### Claude: permission request, native question, unprompted timer turn (excerpts)

```jsonl
← {"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"<id>","toolCall":{"toolCallId":"toolu_01...","name":"mcp__sleepy__sleep_tool","status":"pending","rawInput":{"seconds":2},"title":"sleepy: sleep_tool","kind":"other","content":[]},"options":[{"optionId":"allow-once","name":"Yes","kind":"allow_once"},{"optionId":"allow-with-updates","name":"Yes, and don't ask again for Sleep Tool commands","kind":"allow_always"},{"optionId":"reject","name":"No","kind":"reject_once"}]}}
→ {"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}

← {"jsonrpc":"2.0","id":1,"method":"elicitation/create","params":{"mode":"form","sessionId":"<id>","toolCallId":"toolu_01...","message":"Which color?","requestedSchema":{"type":"object","properties":{"question_0":{"type":"string","title":"Color","oneOf":[{"const":"Red","title":"Red","description":"The color red"},{"const":"Blue","title":"Blue","description":"The color blue"}]},"question_0_custom":{"type":"string","title":"Other","description":"Type your own answer, or add a note to the option you chose above (optional)."}}}}
→ {"jsonrpc":"2.0","id":1,"result":{"action":"accept","content":{"question_0":"Blue"}}}
← ... tool_call_update status completed, rawOutput "Your questions have been answered: \"Which color?\"=\"Blue\". ..."

(no session/prompt in flight; CronCreate one-shot fired)
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<id>","update":{"sessionUpdate":"usage_update","used":30451,"size":200000}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<id>","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"tick"},"messageId":"msg_01..."}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<id>","update":{"sessionUpdate":"usage_update","used":30525,"size":200000}}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<id>","update":{"sessionUpdate":"usage_update","used":30525,"size":200000,"cost":{"amount":0.040729,"currency":"USD"}}}}
```

### pi (`pi --mode rpc`, one prompt)

```jsonl
→ {"id": "1", "type": "get_state"}
← {"id": "1", "type": "response", "command": "get_state", "success": true, "data": {"model": {"id": "claude-haiku-4-5", "provider": "anthropic", "...": "(trimmed)"}, "thinkingLevel": "medium", "isStreaming": false, "sessionFile": "/tmp/spike/pi/sessions/2026-11-22T02-20-47-650Z_sample-1.jsonl", "sessionId": "sample-1", "messageCount": 0, "pendingMessageCount": 0}}
→ {"id": "2", "type": "prompt", "message": "Reply with the word ok and nothing else."}
← {"id": "2", "type": "response", "command": "prompt", "success": true, "data": {"disposition": "started"}}
← {"type": "agent_start"}
← {"type": "turn_start"}
← {"type": "message_start", "message": {"role": "user", "content": [{"type": "text", "text": "Reply with the word ok and nothing else."}], "stopReason": null}}
← {"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "Reply with the word ok and nothing else."}], "stopReason": null}}
← {"type": "message_start", "message": {"role": "assistant", "content": [], "stopReason": "pending"}}
← {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 1, "delta": "ok"}}
← {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "(trimmed)"}, {"type": "text", "text": "ok"}], "stopReason": "stop"}}
← {"type": "turn_end", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "(trimmed)"}, {"type": "text", "text": "ok"}], "stopReason": "stop"}}
← {"type": "agent_end", "messages": "(trimmed)"}
← {"type": "agent_settled", "aborted": false}
```

### pi: extension UI question, abort, resume failure

```jsonl
← {"type":"extension_ui_request","id":"35b2c16c-a9bc-45ec-bfce-3448b27e3867","method":"select","title":"Pick one","options":["red","blue"]}
→ {"type":"extension_ui_response","id":"35b2c16c-a9bc-45ec-bfce-3448b27e3867","value":"blue"}
← {"type":"tool_execution_end","toolName":"ask_test","result":{"content":[{"type":"text","text":"user chose: blue"}]},"isError":false}

→ {"id":"ab","type":"abort"}
← {"type":"tool_execution_end","toolName":"slow_tool","isError":false,"durationMs":2000}
← {"type":"agent_end","messages":"(trimmed)"}
← {"type":"agent_settled","aborted":true}
← {"id":"ab","type":"response","command":"abort","success":true}

$ pi --mode rpc --session does-not-exist-123   ->  exit 1, stderr: No session found matching 'does-not-exist-123'
```

## What the fixtures must replay

- `test/fixtures/fake-acp-agent.mjs`: the Claude exchange above (initialize, `session/new`, `session/set_config_option`, `session/prompt` with `agent_message_chunk`, `tool_call`, `session/request_permission`, `elicitation/create`, `session/load` with replay, the `-32002` error, the unsolicited chunks with trailing `usage_update`+`cost`, `session/cancel` returning `cancelled`).
- `test/fixtures/fake-pi-rpc.mjs`: the pi exchange (`get_state`, `prompt` with `disposition`, `message_update`, `agent_settled`, `abort`, `extension_ui_request`/`extension_ui_response`, exit code 1 with the "No session found" stderr for an unknown `--session`).

## Notes for PR 3, PR 4 and PR 5

- **PR 3 ACP driver (Claude):**
  - Send `clientCapabilities.elicitation.form` only once PR 4 handles questions. Until then do not advertise it, and answer any `elicitation/create` that still arrives with `{action: "cancel"}`.
  - Apply the model with `session/set_config_option` right after `session/new` and `session/load`, and apply the mode with the same call (`allowAll` gives `bypassPermissions`).
  - Swallow `session/update` notifications that arrive before the first prompt of a session and during `session/load`.
  - Treat `session/load` error `-32002` as `SESSION_RESUME_FAILED`.
  - Reject all pending requests when the process exits.
  - Build the adapter environment with `childEnv`.
- **PR 3 pi driver:** start with `--no-extensions`, `--session-id <id>` on the first start and `--session <id>` afterwards (or always `--session-id`, which creates or reopens), `--session-dir <dataDir>/chat-pi-sessions`, `--model`. Complete the turn on `agent_settled`. Ignore `message_start` with `role: "system"`.
- **PR 4:** Claude MCP and pi extension need no progress notifications for 10 minutes. pi MCP needs a per-server `timeout` above `questionWaitMs` (default is 60 s). Native Claude questions use `elicitation/create`, answered with `{action: "accept", content: {question_N: "<label>"}}` and free text in `question_N_custom`. On timeout answer `{action: "cancel"}` (the model sees "Tool use aborted") or accept with the timeout reply text in `question_N_custom` (UNVERIFIED which is better). pi questions are `extension_ui_request` `select`/`confirm`/`input`, answered with `extension_ui_response`.
- **PR 5:** Claude native timers fire unprompted over ACP. Detect an unprompted turn by the first `session/update` that is not `usage_update`, `session_info_update`, `available_commands_update` or `current_mode_update` while no prompt is in flight. End it when a `usage_update` carrying `cost` arrives, or after `AGENT_SETTLE_MS` without updates, whichever comes first. pi has no native timers.

## Proposed INTERACTIVE_CAPABILITIES

A provider whose resume, streaming or turn completion is not VERIFIED stays `interactive: false` with a reason.

| Provider      | interactive | protocol | resume  | automatorTools | nativeQuestions   | nativeTimers | reason                                                                                       |
| ------------- | ----------- | -------- | ------- | -------------- | ----------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `claude-code` | `true`      | `acp`    | `true`  | `mcp`          | `acp-elicitation` | `true`       | `null`                                                                                       |
| `pi`          | `true`      | `pi-rpc` | `true`  | `pi-extension` | `pi-extension-ui` | `false`      | `null`                                                                                       |
| `copilot`     | `false`     | `acp`    | `false` | `none`         | `none`            | `false`      | `Interactive mode is not available for Copilot yet: its ACP session resume is not verified`  |
| `codex`       | `false`     | `acp`    | `false` | `none`         | `none`            | `false`      | `Interactive mode is not available for Codex yet: its ACP session resume is not verified`    |
| `opencode`    | `false`     | `acp`    | `false` | `none`         | `none`            | `false`      | `Interactive mode is not available for OpenCode yet: its ACP session resume is not verified` |
