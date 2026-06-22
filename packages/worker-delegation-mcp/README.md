# @narada2/worker-delegation-mcp

Policy-gated MCP surface for delegating bounded work to a worker runtime.

The surface starts or resumes one worker run at a time, records the worker request and artifacts under a run directory, and returns deterministic text plus authoritative `structuredContent`. Large results are materialized as `worker_output:*` refs and can be read with `worker_output_show`.

Supported runtimes: `codex` (Codex CLI), `deepseek-api` (self-contained agent loop using DeepSeek `/chat/completions`), and `narada-agent-runtime-server` (Narada Agent Runtime Server over JSONL stdio). The worker prompt includes a recursion guard: workers must not call `worker_*` MCP tools.

## Quick Start

Start a read-only audit worker with `worker_run`:

```json
{
  "intent": {
    "instruction": "List all TypeScript files under src/ and report their sizes.",
    "mode": "audit_only"
  },
  "constraints": {
    "cwd": "D:/code/mcp-surfaces",
    "authority": "read",
    "cognition": "low"
  }
}
```

The call returns immediately with `run_id` and `status: "running"`. Poll `worker_run_status` with the returned `run_id` to collect the result, or use `worker_run_wait` for a bounded wait.

## Tools

- `worker_policy_inspect`: inspect the active delegation policy.
- `worker_run`: start one new delegated worker run with explicit constraints (cwd, authority, cognition, mode).
- `worker_edit`: start one new edit-capable worker run using write authority and low cognition; this is worker delegation, not a deterministic filesystem write tool.
- `worker_resume`: continue one existing worker session.
- `worker_run_status`: inspect a worker run by `run_id` without waiting.
- `worker_runs_list`: list recent runs so a caller can rediscover running or completed work without remembering the run id.
- `worker_run_wait`: wait briefly for one run to finish, returning the latest run payload if the wait times out.
- `worker_output_show`: read materialized worker output by output ref.

Additional MCP surfaces:

- `resources/list` and `resources/read` expose materialized worker output resources.
- `prompts/list` and `prompts/get` expose the `worker_delegation_task` prompt.
- `completion/complete` completes tool names for prompt/tool arguments.
- `logging/setLevel` is accepted as a no-op for client compatibility.

## Policy

The server requires at least one allowed root. A worker `cwd` must be inside an allowed root. Roots can be supplied directly or loaded from trusted projects in a Codex-style trust config.

Defaults:

- runtime: `codex` (default), `deepseek-api` and `narada-agent-runtime-server` available
- default authority: `read`
- default cognition: `low`
- allowed runtimes: `codex`, `deepseek-api`, `narada-agent-runtime-server`
- allowed authorities: `read`, `write`, `command`
- allowed cognition: `low`, `medium`, `high`
- allowed sandboxes: `read-only`, `workspace-write`
- default sandbox: `read-only` (codex), `read-only` (deepseek), `workspace-write` (narada-agent-runtime-server)
- allowed config keys: `model`, `model_reasoning_effort`
- raw config overrides: disabled
- `danger-full-access`: disabled unless explicitly admitted
- cognition defaults: model and reasoning effort are runtime-default opaque unless configured by policy or request overrides
- worker runs are non-resumable by default; set `constraints.resumable: true` when the returned session should be continued with `worker_resume`
- worker runs are asynchronous by default; set `constraints.wait_for_completion: true` or `wait_for_completion: true` on `worker_edit` when the caller intentionally wants to block for completion
- max parallel runs: `10`
- max prompt bytes: `1048576`
- max output bytes: `2097152`
- max run time: `1800000` ms

Only a small environment allowlist is passed to workers: `PATH`, `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DEEPSEEK_API_BASE_URL`, `KIMI_API_KEY`, `KIMI_CODE_API_KEY`, `MOONSHOT_API_KEY`, and `NARADA_WORKER_MCP_CONFIG` when present. For `narada-agent-runtime-server`, worker-delegation resolves a real Narada Site root before launch and projects `NARADA_SITE_ROOT` plus `NARADA_WORKSPACE_ROOT` into the worker environment. Run records store environment key names, not secret values.

## Run

```powershell
pnpm --filter @narada2/worker-delegation-mcp build
node D:/code/mcp-surfaces/packages/worker-delegation-mcp/dist/src/main.js --allowed-root D:/code/mcp-surfaces --run-root D:/tmp/worker-runs
```

Common flags:

- `--allowed-root <path>`: add an allowed worker cwd root; repeatable.
- `--roots-from-trust-config <path>`: admit trusted project roots from a Codex-style config.
- `--run-root <path>`: directory for run records and output refs.
- `--audit-log-dir <path>`: append worker delegation audit events.
- `--codex-command <command>`: Codex executable, default `codex`.
- `--codex-command-arg <arg>`: prepend a fixed argument to the Codex runtime invocation; repeatable.
- `--deepseek-command <command>`: Node.js executable for the DeepSeek worker, default `node`.
- `--deepseek-command-arg <arg>`: prepend a fixed argument to the DeepSeek worker invocation; repeatable.
- `--deepseek-model <model>`: override default model for DeepSeek runtime.
- `--agent-runtime-server-command <command>`: Narada Agent Runtime Server executable, default `agent-runtime-server`.
- `--agent-runtime-server-command-arg <arg>`: prepend a fixed argument to the Agent Runtime Server invocation; repeatable.
- `--allowed-sandbox <mode>`: add an allowed sandbox; repeatable.
- `--allowed-config-key <key>`: allow a Codex config key; repeatable. Omit model overrides unless the runtime account is known to accept the selected model.
- `--cognition-low-model <model>` and `--cognition-low-reasoning-effort <value>`: defaults for low cognition.
- `--cognition-medium-model <model>` and `--cognition-medium-reasoning-effort <value>`: defaults for medium cognition.
- `--cognition-high-model <model>` and `--cognition-high-reasoning-effort <value>`: defaults for high cognition.
- `--max-parallel-runs <count>`: maximum simultaneous worker runs, default `10`; enforced for `worker_run`, `worker_edit`, and `worker_resume`.
- `--max-run-ms <ms>`, `--max-prompt-bytes <bytes>`, `--max-output-bytes <bytes>`: set limits.

## Agent Contract

Agents should use `worker_policy_inspect` before delegating. A delegation request separates non-mechanically-enforceable intent from mechanically-enforceable constraints:

- `intent.instruction`: what the worker is asked to do and how it should report. This is prompt intent, not enforcement.
- `constraints`: the executable bounds the server validates or applies. `cwd` selects the worker directory, `site_root` optionally selects the Narada Site root for `narada-agent-runtime-server`, `authority` selects read, write, or command capability, `cognition` selects the default model and reasoning tier, `resumable` controls whether the returned session can be continued, `wait_for_completion` controls whether the MCP call blocks, and `overrides` carries explicit low-level execution overrides when policy admits them.

The worker MCP surface enforces constraints and records the resolved executor request. It does not admit worker output as task evidence, close work, or create Narada role authority by itself.

Normalized constraints:

- `authority: "read"`: inspection within the admitted root envelope; default sandbox `read-only`.
- `authority: "write"`: edit-capable work within the admitted root envelope; default sandbox `workspace-write`.
- `authority: "command"`: command-capable delegation through governed MCP command surfaces such as `structured-command`; default sandbox `workspace-write`.
- `cognition: "low"`: policy-selected low cognition tier; model and reasoning effort are runtime-default opaque unless configured.
- `cognition: "medium"`: policy-selected medium cognition tier; model and reasoning effort are runtime-default opaque unless configured.
- `cognition: "high"`: policy-selected high cognition tier; model and reasoning effort are runtime-default opaque unless configured.

Delegation mode is explicit intent, not mechanical authority. `intent.mode` may be `audit_only`, `plan_only`, `implement`, or `implement_and_verify`. Read authority defaults to `audit_only`; write and command authority default to `implement`. The mode is recorded as `requested_mode`, included in the worker prompt, and summarized in run/list output so an audit cannot be mistaken for a migration or implementation. Mechanical enforcement still comes from `constraints.authority`, sandbox, allowed roots, and policy.

`constraints.preflight_paths` can declare path capability checks before the worker starts. Each entry has `path`, `access` (`read`, `write`, or `create`), and optional `label`. This is useful for migration work: declare the old authority path as readable and the proposed new repo path as creatable. `constraints.required_mcp_tools` can declare tool names the worker must verify before work; worker-delegation records this as advisory preflight because it cannot inspect the worker runtime's future MCP inventory. Preflight results are recorded in `executor_request.preflight`, `preflight`, and `blocked_paths`; they are also placed in the worker prompt as evidence. For `implement` and `implement_and_verify`, any blocked preflight check fails before worker dispatch with `worker_preflight_blocked`. Use `plan_only` for a dry implementation plan under read authority.

`worker_run` accepts explicit normalized constraints:

- `intent.instruction` (string, required): natural-language task description.
- `intent.mode` (string, default `"implement"`): `"audit_only"`, `"plan_only"`, `"implement"`, or `"implement_and_verify"`.
- `intent.step_id` (string, optional): caller-chosen step identifier.
- `intent.step_kind` (string, optional): `"worker"` for delegated work.
- `intent.acceptance` (object, optional): acceptance criteria such as `required_files`.
- `constraints.cwd` (string, required): working directory inside an allowed root.
- `constraints.site_root` (string, optional): explicit Narada Site root for `narada-agent-runtime-server`; when omitted, the nearest parent Site marker above `cwd` is used.
- `constraints.authority` (string, default `"read"`): `"read"`, `"write"`, or `"command"`.
- `constraints.cognition` (string, default `"low"`): `"low"`, `"medium"`, or `"high"`.
- `constraints.resumable` (boolean, default `false`): enable continuation via `worker_resume`.
- `constraints.wait_for_completion` (boolean, default `false`): block until worker finishes.
- `constraints.overrides` (object, optional): set `runtime` (`"codex"`, `"deepseek-api"`, or `"narada-agent-runtime-server"`), `sandbox`, `model`, or `reasoning_effort`.
- `constraints.preflight_paths` (array, optional): path existence/access checks before delegation.
- `constraints.required_mcp_tools` (array, optional): MCP tool names the worker must have.

`worker_edit` is only MCP surface sugar: it accepts top-level `cwd`, optional `site_root`, `instruction`, optional `resumable`, optional `wait_for_completion`, and optional `overrides`, then mechanically compiles to `authority: "write"`, `cognition: "low"`, and `mode: "implement"`. It may use the worker runtime's admitted tools and MCP surfaces; use deterministic filesystem MCP tools when the requested operation is a direct file mutation rather than delegated agent work. Do not ask a worker to call `worker_run`, `worker_edit`, `worker_resume`, or other `worker_*` tools.

When a resumable run completes, the server records a session entry under `run_root/sessions`. `worker_resume` uses that entry to inherit the original authority, cognition, sandbox, model, reasoning effort, and config unless the caller explicitly overrides them. This keeps resumable `worker_edit` sessions on write authority and low cognition across continuations and MCP restarts.

Worker-starting tools return `schema: "narada.worker.run.v1"` with:

- `status`: `running`, `completed`, `completed_with_errors`, `failed`, or `cancelled`
- `run_id` and `run_dir`
- `worker_session_id`
- `executor_request`
- `resolved_worker_config`
- `requested_mode`, `edits_performed`, `target_state_changed`, `confidence`, `blocked_paths`, `verification`, `preflight`, and `final_checklist`
- `summary`, `deliverables`, `open_questions`, `next_actions`, `changes`, and `verification_results`
- `artifacts` pointing at request, prompt, invocation, event, diagnostic, last-message, result, and schema files
- resumable sessions additionally write `run_root/sessions/<worker_session_id>.json` with the latest inherited execution policy
- `timing`

By default, `worker_run`, `worker_edit`, and `worker_resume` return after launch with `status: "running"`. Use `worker_run_status` with the returned `run_id` to inspect completion and read the final full payload. Use `worker_runs_list` to rediscover recent or still-running work after the main agent has stopped or lost the run id. It is compact by default: each item includes run id, status, requested mode, whether requested mode was inferred for an old run, authority, started/finished timing, a short summary preview, and an error preview. Set `include_summary: true` for full summaries and `verbose: true` for full list item metadata. Use `worker_run_wait` for a bounded wait, for example `timeout_ms: 10000`, when a run is likely near completion. It returns a compact run status by default; set `summary_only: true` for the smallest useful response or `verbose: true` to include the full run payload as `full_run`. Set `wait_for_completion: true` only for intentionally short calls where blocking the main agent is acceptable.

Worker output must explicitly include `edits_performed`, `target_state_changed`, `changes`, and `verification`. The server does not infer implementation state from deliverables. `changes` is for files or target artifacts changed; `verification` is structured check evidence with `status`, `summary`, and optional `tool` or `command`.

Runs that produce a valid `last_message.json` but also encounter runtime or tool errors finish as `completed_with_errors`. The error remains on the payload, but the summary and deliverables are preserved as usable worker output.

Worker prompts include MCP-first tool guidance: use available filesystem, git, and structured-command MCP tools for inspection and verification, and avoid direct shell commands for file discovery or file reads when narrower MCP tools can do the work.

A failed runtime call raises `worker_runtime_failed` or `worker_runtime_timed_out` and includes `run_id` and `run_dir` in error details when available. Inspect the run directory for diagnostics.

If a response is materialized, call `worker_output_show` with the returned `output_ref`. `worker_output_show` also accepts a `path` copied from a run artifact entry when that path is inside the worker run root, so callers can read `executor_request.json`, `worker_prompt.txt`, `last_message.json`, or diagnostics without switching tools. It returns exact stored output text and supports `offset` and `limit`.

## Narada Agent Runtime Server

Override the runtime with `overrides.runtime: 'narada-agent-runtime-server'` on `worker_run` or `worker_edit`. This starts a Narada Agent Runtime Server in raw JSONL stdio mode, sends one `conversation.send` frame, records the server event stream in `events.jsonl`, and materializes the final `assistant_message` into the normal worker `last_message.json` contract.

This runtime is a carrier-server posture, not a direct model substrate. It projects `NARADA_SITE_ROOT` and `NARADA_WORKSPACE_ROOT` from the worker `cwd` when those variables are absent, so the child runtime has an explicit Site/workspace anchor. On Windows, npm/pnpm `.cmd` shims are unwrapped to `node <agent-runtime-server entrypoint>` before launch so the JSONL pipe is attached to the real server process; the resolved config records the configured command, while `worker_invocation.json` records the actual spawned command. Use this runtime for delegated work that benefits from Narada carrier semantics, Site MCP fabric, durable session evidence, or later resume/handoff behavior. Keep `codex` or `deepseek-api` for cheap direct one-shot substrate work.

## DeepSeek Runtime

Override the runtime with `overrides.runtime: 'deepseek-api'` on `worker_run` or `worker_edit`. The deepseek worker implements its own agent loop using `node:https` (no external dependencies). It connects to MCP servers via the config file at `NARADA_WORKER_MCP_CONFIG` environment variable.

Key differences from Codex runtime:

- The deepseek worker spawns as a subprocess, reads the prompt from stdin, and runs the agent loop autonomously.
- Thinking mode is always enabled (`thinking: { type: "enabled" }`) with `reasoning_effort: "high"`.
- When tools are used, `reasoning_content` is preserved across turns (required by DeepSeek API).
- The worker writes debug artifacts: `api_requests.jsonl`, `api_responses.jsonl`, `mcp_tools.json`, `conversation.json`.
- Session resume is supported: use `worker_resume` with the returned `worker_session_id`.
- If no MCP config is available, the worker runs without tools (degraded single-shot mode).

Environment variables:

- `DEEPSEEK_API_KEY`: required; used for `Authorization: Bearer` header.
- `DEEPSEEK_API_BASE_URL`: optional; defaults to `https://api.deepseek.com`.
- `NARADA_WORKER_MCP_CONFIG`: path to MCP server config JSON (shape: `{ mcpServers: { name: { command, args, env } } }`).

## Example Tool Arguments

```json
{
  "intent": {
    "instruction": "Inspect the failing test and propose the smallest safe fix. Do not edit files.",
    "mode": "audit_only"
  },
  "constraints": {
    "cwd": "D:/code/mcp-surfaces",
    "authority": "read",
    "cognition": "medium",
    "resumable": false,
    "wait_for_completion": false,
    "overrides": {
      "sandbox": "read-only",
      "reasoning_effort": "medium"
    }
  }
}
```

Migration audit with explicit preflight:

```json
{
  "intent": {
    "instruction": "Audit the proposed authority migration. Do not edit files. Report old-path dependencies, target repo readiness, risks, and verification steps.",
    "mode": "audit_only"
  },
  "constraints": {
    "cwd": "D:/code/mcp-surfaces",
    "authority": "read",
    "cognition": "medium",
    "wait_for_completion": false,
    "preflight_paths": [
      { "label": "old authority", "path": "D:/code/narada.revolution", "access": "read" },
      { "label": "new repo", "path": "D:/code/narada.revolution", "access": "create" }
    ],
    "required_mcp_tools": [
      "local-filesystem-read.fs_glob_search",
      "local-filesystem-read.fs_read_file",
      "structured-command.structured_command_execute"
    ]
  }
}
```

Edit shortcut:

```json
{
  "cwd": "D:/code/mcp-surfaces",
  "instruction": "Fix the narrow test failure, keep the change scoped, and report what changed.",
  "resumable": false
}
```

Model overrides are intentionally absent from the edit shortcut example. `worker_edit` uses the low cognition defaults; add `overrides.model` only when the active Codex account and runtime are known to support a different model.

## Verification

```powershell
pnpm --filter @narada2/worker-delegation-mcp test
```
