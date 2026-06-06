# @narada2/worker-delegation-mcp

Policy-gated MCP surface for delegating bounded work to a worker runtime.

The surface starts or resumes one worker run at a time, records the worker request and artifacts under a run directory, and returns deterministic text plus authoritative `structuredContent`. Large results are materialized as `worker_output:*` refs and can be read with `worker_output_show`.

The current runtime is Codex only. The worker prompt includes a recursion guard: workers must not call `worker_*` MCP tools.

## Tools

- `worker_policy_inspect`: inspect the active delegation policy.
- `worker_run`: start one new delegated worker run.
- `worker_edit`: start one new edit-capable worker run using write authority and low cognition; this is worker delegation, not a deterministic filesystem write tool.
- `worker_resume`: continue one existing worker session.
- `worker_output_show`: read materialized worker output by output ref.

Additional MCP surfaces:

- `resources/list` and `resources/read` expose materialized worker output resources.
- `prompts/list` and `prompts/get` expose the `worker_delegation_task` prompt.
- `completion/complete` completes tool names for prompt/tool arguments.
- `logging/setLevel` is accepted as a no-op for client compatibility.

## Policy

The server requires at least one allowed root. A worker `cwd` must be inside an allowed root. Roots can be supplied directly or loaded from trusted projects in a Codex-style trust config.

Defaults:

- runtime: `codex`
- default authority: `read`
- default cognition: `low`
- allowed runtimes: `codex`
- allowed authorities: `read`, `write`, `command`
- allowed cognition: `low`, `medium`, `high`
- allowed sandboxes: `read-only`, `workspace-write`
- default sandbox: `read-only`
- allowed config keys: `model`, `model_reasoning_effort`
- raw config overrides: disabled
- `danger-full-access`: disabled unless explicitly admitted
- cognition defaults: `low` uses `gpt-5.4-mini` with low reasoning, `medium` uses `gpt-5.4-mini` with medium reasoning, and `high` uses `gpt-5.4` with high reasoning
- worker runs are non-resumable by default; set `constraints.resumable: true` when the returned session should be continued with `worker_resume`
- max parallel runs: `10`
- max prompt bytes: `1048576`
- max output bytes: `2097152`
- max run time: `1800000` ms

Only a small environment allowlist is passed to workers: `PATH`, `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, and `OPENAI_API_KEY` when present. Run records store environment key names, not secret values.

## Run

```powershell
pnpm --filter @narada2/worker-delegation-mcp build
node D:/code/mcp-surfaces/packages/worker-delegation-mcp/dist/src/main.js --allowed-root D:/code/example --run-root D:/tmp/worker-runs
```

Common flags:

- `--allowed-root <path>`: add an allowed worker cwd root; repeatable.
- `--roots-from-trust-config <path>`: admit trusted project roots from a Codex-style config.
- `--run-root <path>`: directory for run records and output refs.
- `--audit-log-dir <path>`: append worker delegation audit events.
- `--codex-command <command>`: Codex executable, default `codex`.
- `--codex-command-arg <arg>`: prepend a fixed argument to the Codex runtime invocation; repeatable. Useful for `node <codex.js>` on Windows.
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
- `constraints`: the executable bounds the server validates or applies. `cwd` selects the worker directory, `authority` selects read, write, or command capability, `cognition` selects the default model and reasoning tier, `resumable` controls whether the returned session can be continued, and `overrides` carries explicit low-level execution overrides when policy admits them.

The worker MCP surface enforces constraints and records the resolved executor request. It does not admit worker output as task evidence, close work, or create Narada role authority by itself.

Normalized constraints:

- `authority: "read"`: inspection within the admitted root envelope; default sandbox `read-only`.
- `authority: "write"`: edit-capable work within the admitted root envelope; default sandbox `workspace-write`.
- `authority: "command"`: command-capable delegation through governed MCP command surfaces such as `structured-command`; default sandbox `workspace-write`.
- `cognition: "low"`: default model `gpt-5.4-mini`, default reasoning `low`.
- `cognition: "medium"`: default model `gpt-5.4-mini`, default reasoning `medium`.
- `cognition: "high"`: default model `gpt-5.4`, default reasoning `high`.

There are no internal named execution modes or presets in the worker contract. `worker_run` accepts explicit normalized constraints. `worker_edit` is only MCP surface sugar: it accepts top-level `cwd`, `instruction`, optional `resumable`, and optional `overrides`, then mechanically compiles to `authority: "write"` and `cognition: "low"`. It may use the worker runtime's admitted tools and MCP surfaces; use deterministic filesystem MCP tools when the requested operation is a direct file mutation rather than delegated agent work. Do not ask a worker to call `worker_run`, `worker_edit`, `worker_resume`, or other `worker_*` tools.

When a resumable run completes, the server records a session entry under `run_root/sessions`. `worker_resume` uses that entry to inherit the original authority, cognition, sandbox, model, reasoning effort, and config unless the caller explicitly overrides them. This keeps resumable `worker_edit` sessions on write authority and low cognition across continuations and MCP restarts.

Successful worker runs return `schema: "narada.worker.run.v1"` with:

- `status`: `completed`, `failed`, or `cancelled`
- `run_id` and `run_dir`
- `worker_session_id`
- `executor_request`
- `resolved_worker_config`
- `summary`, `deliverables`, `open_questions`, and `next_actions`
- `artifacts` pointing at request, prompt, invocation, event, diagnostic, last-message, result, and schema files
- resumable sessions additionally write `run_root/sessions/<worker_session_id>.json` with the latest inherited execution policy
- `timing`

A failed runtime call raises `worker_runtime_failed` or `worker_runtime_timed_out` and includes `run_id` and `run_dir` in error details when available. Inspect the run directory for diagnostics.

If a response is materialized, call `worker_output_show` with the returned `output_ref`. `worker_output_show` returns exact stored output text and supports `offset` and `limit`.

## Example Tool Arguments

```json
{
  "intent": {
    "instruction": "Inspect the failing test and propose the smallest safe fix. Do not edit files."
  },
  "constraints": {
    "cwd": "D:/code/example",
    "authority": "read",
    "cognition": "medium",
    "resumable": false,
    "overrides": {
      "sandbox": "read-only",
      "reasoning_effort": "medium"
    }
  }
}
```

Edit shortcut:

```json
{
  "cwd": "D:/code/example",
  "instruction": "Fix the narrow test failure, keep the change scoped, and report what changed.",
  "resumable": false
}
```

Model overrides are intentionally absent from the edit shortcut example. `worker_edit` uses the low cognition defaults; add `overrides.model` only when the active Codex account and runtime are known to support a different model.

## Verification

```powershell
pnpm --filter @narada2/worker-delegation-mcp test
```
