# @narada2/structured-command-mcp

Structured, policy-gated local command execution MCP surface.

This package executes commands as argv arrays, not shell strings. It is intended for bounded, auditable command execution under explicit root and command policy.

## Boundary

- Allowed: execute admitted commands with explicit argv arrays.
- Allowed: inspect execution policy.
- Allowed: read materialized command output refs.
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
- `structured_command_execution_policy_inspect`: inspect roots, command admission, blocked commands, limits, and default allowed commands.
- `structured_command_output_show`: read materialized command output by output ref.

## Policy

Policy is configured at server launch. Common flags include:

- `--allowed-root <path>`: admit a working-directory root; repeatable.
- `--allow-command <command>`: admit an executable name.
- `--allow-prefix <prefix>`: admit a command plus leading argv prefix.
- `--blocked-command <command>`: block an executable even if otherwise admitted.
- `--audit-log-dir <path>`: append execution audit records.
- timeout/output limit flags, depending on server launch wiring.

By default, selected deployment tools such as `railway` and `wrangler` may be admitted by policy. PowerShell Core script execution is admitted as `pwsh -File ...`, `pwsh -NoProfile -File ...`, or `pwsh -NoProfile -ExecutionPolicy Bypass -File ...`; `pwsh -Command` and Windows PowerShell remain disallowed unless site policy changes. All commands are still executed as argv arrays under the same root, timeout, and output controls.

## Output Refs

Large stdout/stderr payloads can be materialized and returned as refs. Use `structured_command_output_show` with `offset` and `limit` to read them.

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
