# @narada2/mcp-telemetry

Shared optional telemetry helpers for MCP surfaces.

This package is not an MCP server. It provides site-policy-gated event envelope construction and site-local JSONL persistence for operational telemetry.

## Boundary

- Allowed: load `.ai/mcp-telemetry.json`, apply static tool telemetry declarations, normalize metadata-only event envelopes, and write enabled telemetry to `.ai/telemetry/<surface_id>.jsonl`.
- Not allowed: replace mandatory audit logs, emit network telemetry, infer authority, or persist raw tool arguments/results by default.
- Not allowed: task lifecycle, filesystem, mail, command, Git, or worker domain behavior.

Telemetry is disabled by default. When disabled or absent, the emitter is a no-op and writes no telemetry files.

## Audit Versus Telemetry

Audit records remain surface-owned authority or safety evidence and continue to live under paths such as `.ai/audit/<surface>-mcp.jsonl`.

Telemetry is optional operational observability. It can be deleted without invalidating mutation evidence.

## Policy

Policy path:

```text
.ai/mcp-telemetry.json
```

Example:

```json
{
  "enabled": true,
  "sink": "site-local-jsonl",
  "level": "errors_only",
  "include_args": false,
  "include_results": false,
  "retention_days": 30,
  "surfaces": {
    "graph-mail": {
      "enabled": true,
      "level": "errors_only"
    }
  }
}
```

V1 persistence path:

```text
.ai/telemetry/<surface_id>.jsonl
```

`retention_days` is metadata only in v1. Pruning belongs to a future scheduler or site-lifecycle operation.

## Presets

Use the shared builders to keep event declarations metadata-only and consistent across surfaces:

- `buildMetadataOnlyTelemetryDeclaration` for explicit metadata-only declarations.
- `buildPathMetadataTelemetryDeclaration` for path and read-style surfaces.
- `buildReadOnlyTelemetryDeclaration` for read surfaces.
- `buildCommandMetadataTelemetryDeclaration` for command and write surfaces.
- `buildWriteTelemetryDeclaration` for write surfaces that should default to policy-decision telemetry.
- `buildGraphMailTelemetryDeclaration` for Graph mail policy metadata.
- `buildCalendarTelemetryDeclaration` for calendar policy metadata.
- `buildTaskTransitionTelemetryDeclaration` for task/id transition metadata.
- `buildArtifactTelemetryDeclaration` for artifact reference metadata.

Use `telemetryErrorCodeFromUnknown` and `telemetryRefusalCodeFromResult` to reduce diagnostic strings to stable code-like values before emitting telemetry.

## Verification

```powershell
pnpm --filter @narada2/mcp-telemetry test
```
