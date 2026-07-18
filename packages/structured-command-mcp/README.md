# @narada2/structured-command-mcp

Structured, policy-gated local command execution MCP surface.

This package executes commands as argv arrays, not shell strings. It is intended for bounded, auditable command execution under explicit root and command policy.

## Boundary

- Allowed: execute admitted commands with explicit argv arrays.
- Allowed: inspect execution policy.
- Allowed: page command stdout/stderr by re-calling the producing execution tool with its `execution_ref`.
- Not allowed: shell strings, shell interpolation, pipes, redirection, command separators, or wildcard expansion by this surface.
- Not allowed: working directories outside admitted roots.
- Not allowed: broad mutation authority; command admission must be explicit and narrow.

## Command Contract

Tool calls provide a command, arguments, and working directory:

```json
{
  "command": "node",
  "args": ["--version"],
  "working_directory": "D:/code/example"
}
```

The server validates:

- `working_directory` is under an allowed root.
- `command` is admitted by `--allow-command`, `--allow-prefix`, or default policy.
- the request uses argv, not shell syntax.
- timeout/output limits are respected.
- blocked shell commands remain blocked even if present on the host.

## Tools

- `structured_command_execute`: execute one admitted command.
- `structured_command_input_create`: create a scoped structured command input ref for later execution.
- `structured_command_output_show`: page large stdout/stderr payloads by output ref.
- `structured_command_execution_policy_inspect`: inspect roots, command admission, blocked commands, limits, and default allowed commands.
- `structured_command_powershell_parse_check`: parse-check one `.ps1` file under an allowed root without admitting arbitrary `pwsh -Command` text.
- `structured_command_elevated_window_execute`: launch a policy-approved command in a visible elevated UAC window (Windows only; output is not captured).

## Timeouts and Process-Tree Cleanup

`structured_command_execute` accepts an optional `timeout_ms`. When a command exceeds its bound, the call returns the surface's own bounded result (`status: "timed_out"`, `timed_out: true`) together with the `execution_ref`, so captured output remains pageable after a timeout — the MCP transport stays usable and subsequent calls on the same surface keep working.

A timed-out command never leaves its descendant tree running:

- Windows: the tree is terminated with `taskkill /pid <pid> /T /F`.
- POSIX: the child leads its own process group; the group receives `SIGTERM`, then after a bounded grace period any remaining members are escalated to `SIGKILL`. Descendants that ignore `SIGTERM` are still reaped.

## Policy

The default command timeout policy is bounded at 15 minutes. Sites may select
a lower `maxTimeoutMs` in policy; the command-line form is
`--max-timeout-ms <ms>`. The longer bound exists for governed known-slow
workspace verification such as the serial root test; it does not broaden
command admission or allowed roots.

Policy is configured at server launch. Common flags include:

- `--allowed-root <path>`: admit a working-directory root; repeatable.
- `--allow-command <command>`: admit an executable name.
- `--allow-prefix <prefix>`: admit a command plus leading argv prefix.
- `--blocked-command <command>`: block an executable even if otherwise admitted.
- `--audit-log-dir <path>`: append execution audit records.
- timeout/output limit flags, depending on server launch wiring.

By default, selected deployment tools such as `railway` and `wrangler` may be admitted by policy. PowerShell Core script execution is admitted as `pwsh -File ...`, `pwsh -NoProfile -File ...`, or `pwsh -NoProfile -ExecutionPolicy Bypass -File ...`; `pwsh -Command` and Windows PowerShell remain disallowed unless site policy changes. All commands are still executed as argv arrays under the same root, timeout, and output controls.

`structured_command_execute` accepts optional `test_scope` (`focused`, `broad`, `known_slow`, `unknown`) and `expected_cost` (`low`, `medium`, `high`, `unknown`) metadata. When omitted, simple test commands are classified conservatively in the result envelope so verification posture is explicit without expanding command admission.

Use `structured_command_powershell_parse_check` to parse-check one `.ps1` file under an allowed root. The tool invokes the PowerShell parser internally and does not admit arbitrary `pwsh -Command` text from callers.

## Telemetry

Telemetry is optional and off by default. When enabled, this surface emits metadata-only tool status events. It does not persist raw argv arrays, command output, shell text, or execution results beyond the minimal status metadata needed for observability.

## Output Refs

Large stdout/stderr payloads are paged by `structured_command_execute`. Re-call `structured_command_execute` with the returned `execution_ref` plus `stdout_offset`/`stdout_limit` or `stderr_offset`/`stderr_limit` to read later pages.

## Audit

When an audit log directory is configured, command decisions and executions are recorded for later inspection. Audit records should be treated as operational evidence of what command was requested and whether policy admitted it.

## Run

```powershell
pnpm --filter @narada2/structured-command-mcp build
node packages/structured-command-mcp/dist/src/main.js --allowed-root D:/code --allow-command node --allow-command git
```

## Agent Guidance

Agents should use package-specific MCP surfaces when available. Use this surface only when the operation is genuinely command-shaped and the command is admitted by policy. Do not try to encode shell pipelines or destructive filesystem sweeps into argv requests.

## Verification

```powershell
pnpm --filter @narada2/structured-command-mcp test
```
