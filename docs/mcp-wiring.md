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

Carrier-native config files are host/user-site bootstrap profiles. A naked carrier launch receives host-level MCP surfaces, User Site MCP surfaces, and any Local Site MCP surfaces the operator has explicitly selected for that carrier profile. Local Site surfaces are never inferred from the current directory or from an unchosen Site; Narada launch/session materialization is the authority that binds them.

The registrar emits carrier-specific config, not one universal file.

### Codex

Generated shape:

```toml
[mcp_servers.narada-andrey-user-local-filesystem]
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
    "narada-andrey-user-local-filesystem": {
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
    "narada-andrey-user-local-filesystem": {
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

## V2 Descriptor And Runtime Boundaries

The registrar catalog is materialized from each package's native V2 descriptor. The descriptor owns the live `tools/list` contract, effect metadata, projection transport, injection scope, runtime requirements, and lifecycle requirement. Carrier-specific files are projections of that descriptor; they are not a second source of tool or scope truth.

Runtime observation is separate from config wiring. The runtime proxy records generation, heartbeat, lease, freshness, health, and contract-digest state. `mcp-loader_runtime_observation` reports the loader's stable logical connection and active/draining generations. A child replacement is requested through `mcp_loader_surface_restart`; a loader-process restart belongs to the carrier or runtime supervisor. Registrar config apply, loader generation replacement, and carrier restart remain separate actuators.

## Native descriptor coverage gate

Every registered package must expose a package-owned `./surface-definition` export. The registrar's native catalog is the only catalog authority; loader fallback entries must use the same built package entrypoint and argument placeholders as the native projection. Operator-specific roots must not be embedded in a descriptor: use `{site_root}`, `{site_control_root}`, `{site_runtime_root}`, `{workspace_root}`, or `{mcp_surfaces_root}` and let the selected binding interpolate them.

The native registrar test checks descriptor coverage, tool-contract conformance, projection transport equivalence, package-version agreement, explicit lifecycle metadata, and portable path interpolation. The shared descriptor builder rejects stale or duplicate read-only inventories. `mcp_loader_site_tool_inventory_check` remains the runtime gate for comparing a live child process with its declared descriptor.

For lifecycle discovery, read `metadata.lifecycle_readback` on the descriptor. First call its `discovery.tool_name` (`mcp_loader_connection_inventory`), select the entry whose declared `select.field` equals `select.equals`, and take the selected `result_field` (`connection_id`). Substitute that value into `status.arguments` and call `mcp_loader_surface_status`. Never fabricate a connection id from `surface_id`; the inventory is the authoritative mapping. This reports the child generation and lifecycle posture without implying that a direct standalone process can be restarted by the loader.
