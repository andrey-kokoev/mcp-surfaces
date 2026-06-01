# mcp-surfaces

Standalone MCP surface packages shared by Narada sites and carriers.

## Packages

- `@narada2/mcp-transport`: MCP payload/output-ref helpers.
- `@narada2/local-filesystem-mcp`: canonical local filesystem MCP surface exposing `fs_*` tools.
- `@narada2/structured-command-mcp`: policy-gated command execution surface using structured argv schemas.

## Verify

```powershell
pnpm install
pnpm test
```
