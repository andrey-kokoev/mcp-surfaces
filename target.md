# Worker Delegation MCP Target

This file is the normative target for a new MCP surface that delegates bounded work to child worker runtimes. Only `MUST` and `MUST NOT` are normative keywords in this document. There is no `SHOULD` or `MAY` behavior in this target.

## 1. Fixed Scope

The package name MUST be `@narada2/worker-delegation-mcp`.

The binary name MUST be `worker-delegation-mcp`.

The MCP server info name MUST be `worker-delegation-mcp`.

The first implementation MUST support exactly one worker runtime: `codex`.

The `codex` worker runtime MUST launch Codex through `codex exec`.

The first implementation MUST expose exactly four MCP tools:

1. `worker_policy_inspect`
2. `worker_run`
3. `worker_resume`
4. `worker_output_show`

The first implementation MUST NOT expose `worker_autopilot`.

The first implementation MUST NOT expose skills selection.

The first implementation MUST NOT expose any runtime other than `codex`.

## 2. Non-Goals

The surface MUST NOT reconfigure the MCP host that called it.

The surface MUST NOT expose a general shell command runner.

The surface MUST NOT accept raw process command strings from tool callers.

The surface MUST NOT require the MCP host to be Codex.

The surface MUST NOT model interactive terminal control as delegated execution.

The surface MUST NOT treat `agent-cli` or `agent-tui` as worker runtimes in the first implementation.

The surface MUST NOT add placeholder runtime adapters.

The surface MUST NOT pass unvalidated config keys to a worker runtime.

## 3. Terms

`Front-End`: The human-facing program. Examples: Codex TUI, `agent-cli`, `agent-tui`.

`MCP Host`: The process that owns the MCP client connection and invokes MCP tools.

`MCP Surface`: The MCP server defined by this target.

`Tool Call`: One invocation of one tool exposed by the MCP surface.

`Worker Runtime`: A configured executable family that performs delegated work. The only first-version worker runtime is `codex`.

`Worker Adapter`: Package code that translates a resolved worker config into one worker runtime invocation.

`Worker Run`: One child process execution started by a worker adapter.

`Worker Session`: A persistent worker-runtime conversation identifier. For the `codex` runtime, this is the thread id extracted from `codex exec --json` events.

`Execution Policy`: Server-owned rules that decide allowed roots, runtimes, sandboxes, config keys, byte limits, and parallelism.

`Run Record`: The durable artifact directory created for one `worker_run` or `worker_resume` tool call.

`Resolved Worker Config`: The exact worker runtime, command, argv, cwd, sandbox, model, reasoning effort, config values, limits, and environment keys used for one worker run.

`Structured Result`: The MCP `structuredContent` payload returned by a tool.

`Rendered Result`: The deterministic text returned in MCP `content[0].text`.

## 4. Boundary Model

The MCP host calls the MCP surface.

The MCP surface validates tool input against execution policy.

The MCP surface resolves a worker config.

The selected worker adapter receives only the resolved worker config and the worker prompt.

The worker adapter starts one worker run.

The worker runtime performs the delegated task.

The MCP surface returns a structured result and a rendered result to the MCP host.

No configuration flows from the worker run back to the MCP host.

The MCP host identity MUST NOT affect worker policy. Codex, `agent-cli`, and `agent-tui` are all hosts from the perspective of this surface.

## 5. Configuration

The server MUST accept configuration from CLI flags.

The server MUST accept configuration from one TOML file specified by a CLI flag named `--config`.

If a value is present in both CLI flags and the TOML file, the CLI value MUST override the TOML value.

The generic configuration namespace MUST be `worker`.

The configuration MUST have this logical shape after defaults are applied:

```toml
[worker]
default_runtime = "codex"
run_root = "C:/Users/Andrey/.codex/worker-delegation/runs"
audit_log_dir = "C:/Users/Andrey/.codex/log/worker-delegation-mcp"

[worker.roots]
allowed_roots = []
roots_from_trust_config = ""

[worker.policy]
allowed_runtimes = ["codex"]
allowed_sandboxes = ["read-only", "workspace-write"]
allowed_config_keys = ["model", "model_reasoning_effort"]
allow_raw_config_overrides = false
allow_danger_full_access = false
max_parallel_runs = 1
max_prompt_bytes = 1048576
max_output_bytes = 2097152
max_run_ms = 1800000

[worker.runtimes.codex]
command = "codex"
default_sandbox = "read-only"
default_reasoning_effort = "medium"
ephemeral = true
json_events = true
```

`worker.default_runtime` MUST equal `codex` in the first implementation.

`worker.policy.allowed_runtimes` MUST equal `["codex"]` in the first implementation.

`worker.policy.allow_raw_config_overrides` MUST default to `false`.

`worker.policy.allow_danger_full_access` MUST default to `false`.

The implementation MUST reject startup config where `worker.default_runtime` is not included in `worker.policy.allowed_runtimes`.

The implementation MUST reject startup config where an allowed runtime has no matching `worker.runtimes.<name>` section.

The implementation MUST reject `danger-full-access` unless both conditions are true:

1. `worker.policy.allow_danger_full_access = true`
2. `danger-full-access` is present in `worker.policy.allowed_sandboxes`

The implementation MUST reject every requested config key not listed in `worker.policy.allowed_config_keys` when `worker.policy.allow_raw_config_overrides = false`.

`worker_policy_inspect` MUST expose the final resolved policy, including unsafe booleans.

## 6. Tool Contracts

Every tool result MUST include `structuredContent`.

Every successful tool result MUST include exactly one text content item at `content[0]`.

Every tool error MUST use the error model in section 12.

### 6.1 `worker_policy_inspect`

Purpose: return the active execution policy and configured runtimes.

Input schema: object with no properties.

Structured result schema: `narada.worker.policy.v1`.

Structured result fields:

- `schema`: exact string `narada.worker.policy.v1`
- `status`: exact string `ok`
- `default_runtime`: string
- `run_root`: string
- `audit_log_dir`: string or null
- `allowed_roots`: string array
- `roots_from_trust_config`: string or null
- `allowed_runtimes`: string array
- `allowed_sandboxes`: string array
- `allowed_config_keys`: string array
- `allow_raw_config_overrides`: boolean
- `allow_danger_full_access`: boolean
- `max_parallel_runs`: integer
- `max_prompt_bytes`: integer
- `max_output_bytes`: integer
- `max_run_ms`: integer
- `runtimes`: object keyed by runtime name

### 6.2 `worker_run`

Purpose: start one new worker session for one new task.

Input schema fields:

- `cwd`: required string.
- `task`: required non-empty string.
- `runtime`: optional string. Default: `worker.default_runtime`.
- `role`: optional string. Default: `specialist`.
- `sandbox`: optional enum. Allowed values: `read-only`, `workspace-write`, `danger-full-access`. Default: selected runtime default sandbox.
- `model`: optional string. Maps to config key `model`.
- `reasoning_effort`: optional string. Maps to config key `model_reasoning_effort`.
- `config`: optional object. Keys are config keys. Values are TOML-serializable primitives: string, number, boolean.
- `skip_git_repo_check`: optional boolean. Default: false.

The first implementation input schema MUST NOT include `skills`, `skills_mode`, `max_skills`, `include_repo_skills`, or `include_global_skills`.

Structured result schema: `narada.worker.run.v1`.

Structured result fields:

- `schema`: exact string `narada.worker.run.v1`
- `status`: one of `completed`, `failed`, `cancelled`
- `run_id`: string
- `run_dir`: string
- `runtime`: exact string `codex` in the first implementation
- `worker_session_id`: string or null
- `resolved_worker_config`: object matching section 7
- `summary`: string
- `deliverables`: array of `{ path: string, description: string }`
- `open_questions`: string array
- `next_actions`: string array
- `artifacts`: array of `{ name: string, path: string }`
- `timing`: `{ started_at: string, finished_at: string or null, duration_ms: number or null }`
- `error`: string or null

### 6.3 `worker_resume`

Purpose: continue one existing worker session.

Input schema fields:

- `cwd`: required string.
- `worker_session_id`: required non-empty string.
- `task`: optional string. Default: `Continue the previous worker session and return an updated structured result.`
- `runtime`: optional string. Default: `worker.default_runtime`.
- `role`: optional string. Default: `specialist`.
- `sandbox`: optional enum. Allowed values: `read-only`, `workspace-write`, `danger-full-access`. Default: selected runtime default sandbox.
- `model`: optional string. Maps to config key `model`.
- `reasoning_effort`: optional string. Maps to config key `model_reasoning_effort`.
- `config`: optional object. Keys are config keys. Values are TOML-serializable primitives: string, number, boolean.
- `skip_git_repo_check`: optional boolean. Default: false.

If the selected runtime does not support sessions, `worker_resume` MUST fail with code `worker_runtime_resume_not_supported`.

Structured result schema: `narada.worker.run.v1`.

### 6.4 `worker_output_show`

Purpose: read materialized output by output reference.

Input schema fields:

- `output_ref`: required string.
- `offset`: optional non-negative integer. Default: 0.
- `limit`: optional positive integer. Default: 10000.

Structured result schema: `narada.worker.output_show.v1`.

The tool MUST return exact stored output text for the requested reference slice.

## 7. Resolved Worker Config

Every worker run MUST write and return this resolved config shape:

- `runtime`: string
- `command`: string
- `argv`: string array
- `cwd`: string
- `sandbox`: string
- `model`: string or null
- `reasoning_effort`: string or null
- `config`: object of resolved config keys and TOML-serializable primitive values
- `skip_git_repo_check`: boolean
- `ephemeral`: boolean
- `json_events`: boolean
- `prompt_byte_length`: integer
- `max_output_bytes`: integer
- `max_run_ms`: integer
- `environment_keys`: string array

The resolved config MUST NOT contain secrets.

The resolved config MUST NOT contain unvalidated raw command fragments.

## 8. Worker Adapter Contract

Each worker adapter MUST implement these functions:

- `runtimeName()`: returns stable runtime name.
- `supportsResume()`: returns boolean.
- `buildInvocation(resolvedWorkerConfig)`: returns `{ command: string, argv: string[], cwd: string, environment: Record<string, string> }`.
- `run(resolvedWorkerConfig, prompt, abortSignal)`: starts a worker run and writes artifacts.
- `resume(resolvedWorkerConfig, workerSessionId, prompt, abortSignal)`: resumes a worker session or returns `worker_runtime_resume_not_supported`.
- `parseResult(runRecord)`: returns normalized fields for `narada.worker.run.v1`.

Adapters MUST NOT receive raw tool input.

Adapters MUST NOT decide execution policy.

Adapters MUST NOT invoke a shell.

## 9. Codex Worker Adapter

The Codex adapter runtime name MUST be `codex`.

The Codex adapter MUST invoke the configured command with an argv array.

For `worker_run`, the Codex argv MUST be exactly this ordered array before config overrides and final stdin marker are appended:

```json
["exec", "-C", "<cwd>", "--sandbox", "<sandbox>", "--json", "--output-schema", "<worker_output_schema_path>", "-o", "<last_message_path>"]
```

For `worker_resume`, the Codex argv MUST be exactly this ordered array before config overrides and final stdin marker are appended:

```json
["exec", "-C", "<cwd>", "--sandbox", "<sandbox>", "--json", "--output-schema", "<worker_output_schema_path>", "-o", "<last_message_path>", "resume", "<worker_session_id>"]
```

If `ephemeral = true`, the adapter MUST insert `--ephemeral` after `exec`.

If `skip_git_repo_check = true`, the adapter MUST insert `--skip-git-repo-check` before config overrides.

For each resolved config key, the adapter MUST append `-c` and `key=value` as two separate argv entries.

The adapter MUST append `-` as the final argv entry.

The adapter MUST provide the worker prompt through stdin.

The adapter MUST write every JSON event emitted by `codex exec --json` to `events.jsonl`.

The adapter MUST write runtime diagnostic text to `diagnostic.log`.

The adapter MUST extract `worker_session_id` from the first non-empty event field among these names, searched recursively in JSON objects: `thread_id`, `threadId`, `session_id`, `sessionId`, `conversation_id`, `conversationId`.

## 10. Run Record

Each `worker_run` and `worker_resume` MUST create exactly one run directory under `worker.run_root`.

The run directory name MUST be `run-<UTC timestamp>-<random suffix>`.

The timestamp format MUST be `YYYYMMDDTHHMMSSZ`.

The random suffix MUST be at least eight lowercase hexadecimal characters.

A run directory MUST contain these reserved files:

- `request.json`: original tool input after schema validation.
- `resolved_worker_config.json`: exact resolved worker config from section 7.
- `worker_prompt.txt`: prompt sent to the worker runtime.
- `worker_invocation.json`: command, argv, cwd, and environment key names used.
- `events.jsonl`: runtime event stream. Empty file if the runtime emits no events.
- `diagnostic.log`: runtime diagnostic text. Empty file if the runtime emits no diagnostic text.
- `last_message.json`: final worker output. If no final message is produced, an explicit absence object with `absent: true` and a string `reason`.
- `result.json`: normalized worker result.
- `worker_output.schema.json`: JSON schema required from the worker.

A run directory can contain additional files only if their names do not conflict with reserved files.

## 11. Worker Prompt

The worker prompt MUST include these sections in this order:

1. `Role`
2. `Working directory`
3. `Task`
4. `Recursion guard`
5. `Output requirements`

The recursion guard text MUST include: `Do not call any worker_* MCP tools.`

The output requirements MUST require one JSON object matching `worker_output.schema.json`.

## 12. Result Rendering

Every successful tool result MUST return:

- `structuredContent`: authoritative machine payload.
- `content[0].type`: exact string `text`.
- `content[0].text`: deterministic rendered text.

Rendered text MUST NOT be JSON for `worker_policy_inspect`, `worker_run`, or `worker_resume`.

`worker_output_show` MUST return exact stored output text in `content[0].text`.

Rendered text MUST be bounded by `worker.policy.max_output_bytes`.

Large results MUST be materialized and represented by an output reference.

Materialized structured results MUST include:

- `result_materialized`: exact boolean `true`
- `output_ref`: string
- `reader_tool`: exact string `worker_output_show`
- `full_output_byte_length`: integer

## 13. Error Model

Expected failures MUST return typed MCP errors with schema `narada.worker.error.v1`.

Error payload fields:

- `schema`: exact string `narada.worker.error.v1`
- `code`: string
- `message`: string
- `details`: object

Required error codes:

- `worker_unknown_tool`
- `worker_invalid_runtime`
- `worker_runtime_not_allowed`
- `worker_invalid_sandbox`
- `worker_invalid_config_file`
- `worker_invalid_config_value`
- `worker_invalid_cli_args`
- `worker_danger_full_access_not_allowed`
- `worker_config_key_not_allowed`
- `worker_raw_config_overrides_not_allowed`
- `worker_cwd_outside_allowed_roots`
- `worker_prompt_too_large`
- `worker_runtime_resume_not_supported`
- `worker_runtime_failed`
- `worker_runtime_timed_out`
- `worker_output_materialization_failed`
- `worker_unrenderable_result_schema`
- `worker_unhandled_error`

Plain untyped exceptions MUST be converted to `worker_unhandled_error` before returning to the MCP host.

## 14. Security Rules

The surface MUST validate `cwd` against allowed roots before building a worker invocation.

Allowed roots MUST be the union of `worker.roots.allowed_roots` and trusted project roots loaded from `worker.roots.roots_from_trust_config`.

The surface MUST reject startup if the allowed root set is empty.

The surface MUST NOT pass arbitrary environment variables to worker runs.

The first implementation environment allowlist MUST contain exactly these keys when present in the server environment:

- `PATH`
- `USERPROFILE`
- `HOME`
- `APPDATA`
- `LOCALAPPDATA`
- `CODEX_HOME`
- `OPENAI_API_KEY`

The resolved worker config MUST record only environment key names, not values.

The surface MUST write one audit JSONL record for each `worker_run` and `worker_resume`.

The surface MUST NOT infer mutability from the MCP host identity.

## 15. Host Registration

Codex, `agent-cli`, and `agent-tui` are MCP hosts for this target.

Each host registers the same server binary independently.

Host registration MUST only start the MCP surface.

Host registration MUST NOT change worker runtime policy.

Host-specific config files MUST point to the same server binary and the same worker policy file when identical behavior is desired across hosts.

## 16. Implementation Order

The implementation MUST be built in this order:

1. package scaffold
2. policy loading
3. `worker_policy_inspect`
4. Codex worker adapter invocation builder
5. run record writer
6. `worker_run`
7. deterministic renderer and output materialization
8. `worker_output_show`
9. `worker_resume`
10. package tests
11. protocol smoke test

No later step is complete until all earlier steps have tests.

## 17. Completion Criteria

The target is implemented only when all criteria below are true:

- The package exists at `packages/worker-delegation-mcp`.
- The package name is `@narada2/worker-delegation-mcp`.
- The package has TypeScript sources under `packages/worker-delegation-mcp/src`.
- The package has tests under `packages/worker-delegation-mcp/test`.
- The package builds with `tsc -b`.
- Package tests cover policy inspection.
- Package tests cover allowed runtime validation.
- Package tests cover denied runtime validation.
- Package tests cover allowed sandbox validation.
- Package tests cover denied sandbox validation.
- Package tests cover config key allowlisting.
- Package tests cover rejected raw config overrides.
- Package tests cover Codex argv construction.
- Package tests cover run record creation.
- Package tests cover `resolved_worker_config.json` contents.
- Package tests cover rendered text.
- Package tests cover structured content.
- Package tests cover output materialization.
- Package tests cover `worker_output_show` exact text slicing.
- Package tests cover `worker_resume` argv construction.
- Package tests cover typed error payloads.
- Protocol smoke test starts the MCP server and calls `worker_policy_inspect`.
- No tool accepts raw shell command strings.
- No tool forwards unvalidated config keys.
- No worker adapter performs policy decisions.
- Every run writes `resolved_worker_config.json`.
- Every expected failure returns `narada.worker.error.v1`.
- `pnpm --filter @narada2/worker-delegation-mcp test` passes.
- `pnpm build` passes.

## 18. Naming Invariants

Use `worker` for the generic delegated execution domain.

Use `runtime` for a configured executable family.

Use `adapter` for implementation code that knows one runtime.

Use `run` for one child process execution.

Use `session` only for persistent runtime conversation identity.

Use `host` only for the MCP caller process.

Do not use `agent` to mean runtime, host, and worker interchangeably.

Do not use `codex` in generic tool names.

Do not use `executor` anywhere in the first implementation.
