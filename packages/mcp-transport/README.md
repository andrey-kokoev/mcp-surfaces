# @narada2/mcp-transport

Shared transport helpers for MCP payload and output-reference mechanics.

This package is not an MCP server. It provides reusable helpers used by MCP surfaces that need to accept large structured payloads or return large structured results without forcing everything inline into a tool call or transcript.

## Boundary

- Allowed: generic payload staging, immutable payload refs, output materialization, compact text rendering, and output-ref readback helpers.
- Not allowed: Narada task-domain behavior.
- Not allowed: package-specific policy decisions.
- Not allowed: filesystem, Git, command, mailbox, or task lifecycle tool behavior.

Domain packages should keep their own schemas and admission rules. This package only handles transport mechanics.

## Payload Refs

Payload helpers support two inbound forms for tools that explicitly allow them:

- `payload_path`: a JSON file staged under the configured payload directory.
- `payload_ref`: an immutable ref such as `mcp_payload:<id>@v1`.

The helper enforces size limits, validates JSON objects, rejects paths outside the staging directory, and records payload source metadata. Package surfaces decide which tools accept payload refs and how resolved payloads merge with top-level tool arguments.

Default staging path:

```text
.ai/tmp/mcp-payloads
```

## Output Refs

Output helpers materialize large results under:

```text
.ai/tmp/mcp-outputs
```

Materialized results are addressed as:

```text
mcp_output:<id>
```

Surfaces can expose `mcp_output_show` using the transport helper’s output tools. `mcp_output_show` supports `offset` and `limit` so large stored outputs can be paged deterministically.

## Exports

- `@narada2/mcp-transport`
- `@narada2/mcp-transport/mcp-payload-file`

Primary helper areas:

- resolve staged payload files or payload refs.
- attach payload-source metadata.
- enforce inline payload limits.
- write materialized output refs.
- list/read output-ref tools.
- render compact, deterministic MCP text content while preserving `structuredContent` as the authoritative payload.

## Verification

```powershell
pnpm --filter @narada2/mcp-transport test
```
