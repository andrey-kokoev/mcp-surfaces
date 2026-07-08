# MCP Wiring

This repository ships standalone MCP surfaces. A surface can run without Narada, but if you want it inside a specific supported CLI or TUI, you still need carrier config for that host. In this repo, that means Codex, opencode, or Kimi through the registrar.

## What To Use

- `@narada2/local-filesystem-mcp` when you want governed filesystem access.
- `@narada2/mcp-registrar` when you want Narada to write the carrier config for Codex, opencode, or Kimi.

## Standalone Filesystem Example

```powershell
pnpm --filter @narada2/local-filesystem-mcp build
node <installed-package>/dist/src/main.js --mode read --allowed-root <your-workspace-root>
```

## Carrier Wiring Examples

The registrar emits carrier-specific config, not one universal file.

### Codex

Generated shape:

```toml
[mcp_servers.narada-andrey-local-filesystem]
command = "node"
args = ["<installed-package>/dist/src/main.js", "--mode", "read", "--allowed-root", "<your-workspace-root>"]
approval_mode = "approve"
```

### opencode

Generated shape:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "narada-andrey-local-filesystem": {
      "type": "local",
      "command": ["node", "<installed-package>/dist/src/main.js", "--mode", "read", "--allowed-root", "<your-workspace-root>"],
      "enabled": true
    }
  }
}
```

### Kimi

Generated shape:

```json
{
  "mcpServers": {
    "narada-andrey-local-filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": ["<installed-package>/dist/src/main.js", "--mode", "read", "--allowed-root", "<your-workspace-root>"],
      "approval_mode": "approve"
    }
  }
}
```

## Where The Truth Lives

- `docs/mcp-injection-scopes.md` explains host, user-site, and local-site ownership.
- `packages/mcp-registrar/README.md` explains the registrar tools.
- `packages/local-filesystem-mcp/README.md` explains standalone usage.

The surface itself does not need Narada. The wiring workflow may.
