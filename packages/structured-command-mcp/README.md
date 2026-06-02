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
- a command admitted by `--allow-command` or `--allow-prefix`
- no shell parsing or shell interpolation
- timeout and output limits
- optional audit log directory

## Run

```powershell
pnpm --filter @narada2/structured-command-mcp build
node packages/structured-command-mcp/dist/src/main.js --allowed-root D:/code --allow-command node --allow-command git
```

## Tools

- `structured_command_execute`
- `structured_command_execution_policy_inspect`
