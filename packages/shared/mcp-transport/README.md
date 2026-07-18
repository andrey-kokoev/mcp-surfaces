# @narada2/mcp-transport

Shared transport helpers for MCP payload and output-reference mechanics.

This package is not an MCP server. It provides reusable helpers used by MCP surfaces that need to accept large structured payloads or return large structured results without forcing everything inline into a tool call or transcript.

## Boundary

- Allowed: generic payload staging, immutable payload refs, output materialization, compact text rendering, and output resources.
- Not allowed: Narada task-domain behavior.
- Not allowed: package-specific policy decisions.
- Not allowed: filesystem, Git, command, mailbox, or task lifecycle tool behavior.

Domain packages should keep their own schemas and admission rules. This package only handles transport mechanics.

The canonical package-level target is documented in
`docs/mcp-surfaces-target-shape.md`. In particular, a transport instance is
bound to one site authority scope. It must not treat a caller-supplied site
root as authority or provide ambient cross-site output access.

## Payload Refs

Payload helpers support two inbound forms for tools that explicitly allow them:

- `payload_path`: a JSON file staged under the configured payload directory.
- `payload_ref`: an immutable ref such as `mcp_payload:<id>@v1`.

The helper enforces size limits, validates JSON objects, rejects paths outside the staging directory, and records payload source metadata. Package surfaces decide which tools accept payload refs and how resolved payloads merge with top-level tool arguments.

The `mcp_payload_create` and `mcp_payload_derive` tool schemas intentionally advertise their object and JSON-string routes as optional sibling fields instead of using a root `anyOf`, because some MCP clients reject that JSON Schema shape. Runtime validation still requires a valid route: use `payload` or `payload_json` for creation, and `overlay` or `overlay_json` for derivation. A JSON-string route may be accompanied by an empty object placeholder; non-empty ambiguous combinations remain rejected.

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

Output readers, when exposed by a surface, must remain bound to the same
transport scope that materialized the output. They must use bounded paging and
must not accept a raw `target_site_root` or equivalent path override. Cross-site
transfer belongs to an explicitly authorized User Site or artifact/export
surface, not to this package.

The default output page is 10,000 characters and the hard request maximum is
20,000 characters. The serialized inline response is bounded separately from
stored output, and MCP resource reads return bounded pages rather than the full
materialized record.

## Exports

- `@narada2/mcp-transport`
- `@narada2/mcp-transport/mcp-payload-file`

Primary helper areas:

- resolve staged payload files or payload refs.
- attach payload-source metadata.
- enforce inline payload limits.
- write materialized output refs.
- list/read output resources.
- render compact, deterministic MCP text content while preserving
  `structuredContent` as the authoritative payload.

## Verification

```powershell
pnpm --filter @narada2/mcp-transport test
```

## Runtime Contract

Construct a `McpTransportScope` once per MCP server with `createTransportScope` and pass that scope to payload/output helpers. The scope resolves the site root and managed directories, validates byte limits with Zod, and is immutable for the lifetime of the request path. Legacy root arguments remain only as a compatibility boundary for existing callers; they cannot be combined with an explicit scope.

Output hashes use generic canonical JSON for integrity, while rendered output preserves the producer's field order. The shared package must not encode domain-specific field priorities. Output/resource pages are bounded and resource listing is paged; callers must continue from `next_offset` rather than requesting an unbounded listing.

Immutable records are published through an fsynced temporary file and an exclusive hard-link publish. A competing writer either observes the complete immutable record or receives the existing-file conflict; it must never observe a destination that is still being written.
