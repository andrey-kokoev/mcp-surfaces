# @narada2/structured-command-mcp

Structured MCP surface for bounded local command execution.

This package executes commands as argv arrays, not shell strings.

```json
{
  "command": "node",
  "args": ["--version"],
  "working_directory": "D:/code/example"
}
```

The server requires:

- a working directory under an allowed root
- a command admitted by `--allow-command`, `--allow-prefix`, or the default allowed command set
- no shell parsing or shell interpolation
- timeout and output limits
- optional audit log directory

By default, `railway` and `wrangler` are admitted so deployment tools can be used without repeated per-server flags. Execution is still bounded by the same controls as explicitly allowed commands: callers provide argv arrays rather than shell strings, the working directory must be inside an allowed root, blocked shell commands stay blocked, and timeout/output limits still apply. The policy inspection tool exposes these defaults in `structuredContent.default_allowed_commands`.

## Run

```powershell
pnpm --filter @narada2/structured-command-mcp build
node packages/structured-command-mcp/dist/src/main.js --allowed-root D:/code --allow-command node --allow-command git
```

## Tools

- `structured_command_execute`
- `structured_command_execution_policy_inspect`
