# @narada2/structured-shell-mcp

Structured MCP surface for bounded local command execution.

This package executes commands as argv arrays, not shell strings. It is meant for
commands such as:

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
- no shell metacharacter parsing
- timeout and output limits
- optional audit log directory

## Run

```powershell
node packages/structured-shell-mcp/src/main.mjs --allowed-root D:/code --allow-command node --allow-command git
```

## Tools

- `shell_command_run`: execute a structured argv command.
- `shell_command_policy`: inspect allowed roots and command policy.
- `mcp_output_show`: read truncated output refs.
