# MCP Telemetry Target Shape

This document defines the implementation-driving target shape for optional MCP telemetry in `mcp-surfaces`. It is scoped to shared package design and surface integration. It does not replace mandatory audit logs, task lifecycle evidence, or runtime-introspection analysis.

## Purpose

Telemetry is operational observability for MCP surfaces. It answers questions such as:

- which surface/tool was called;
- whether the call completed, failed, or refused;
- how long it took;
- which site/session/agent context was attached;
- which policy or refusal code shaped the outcome.

Telemetry is not authority evidence. Mutation audit, task lifecycle reports, completion audit verdicts, and surface-owned durable records remain the authoritative records for governed effects.

## Repository Factorization

The target package layout separates runnable surfaces from shared libraries:

```text
packages/
  surfaces/
    local-filesystem-mcp/
    graph-mail-mcp/
    ...
  shared/
    mcp-transport/
    mcp-telemetry/
```

Shared packages are not MCP servers. They provide reusable mechanics that surfaces import. In this model:

- `@narada2/mcp-transport` owns payload refs, output refs, materialization, and compact rendering helpers.
- `@narada2/mcp-telemetry` owns optional telemetry policy loading, declaration enforcement, event envelope construction, redaction, and local JSONL persistence.

`mcp-transport` must not absorb telemetry. Transport and telemetry are separate concerns.

## Audit Versus Telemetry

Audit and telemetry must stay mechanically distinct.

Audit:

- is durable authority or safety evidence for governed effects;
- may be mandatory for mutation surfaces;
- belongs to the owning surface's domain semantics;
- remains under paths such as `.ai/audit/<surface>-mcp.jsonl`;
- can include domain-specific mutation evidence after that surface has applied its own safety rules.

Telemetry:

- is optional operational observability;
- is disabled by default;
- is site-policy-gated;
- must be safe to delete without invalidating mutation evidence;
- must not include raw sensitive inputs or results by default;
- is persisted under `.ai/telemetry/` only when enabled.

Telemetry must never be required to prove a mutation happened. Audit and readback remain the authority path.

## Tool Telemetry Declarations

Each tool can declare a static telemetry contract. The declaration is reviewable source code; it names the maximum information the tool is allowed to emit if site policy enables telemetry.

Example shape:

```ts
type TelemetryDeclaration = {
  events: Array<'tool_started' | 'tool_completed' | 'tool_refused' | 'tool_failed'>;
  sensitivity: 'low' | 'medium' | 'high';
  args: 'none' | 'schema_safe' | 'redacted';
  result: 'none' | 'summary' | 'redacted_summary';
  timing: boolean;
  policy_decision: boolean;
  authority_locus: boolean;
};
```

The first implementation should prefer metadata-only declarations:

```ts
{
  events: ['tool_completed', 'tool_refused', 'tool_failed'],
  sensitivity: 'medium',
  args: 'none',
  result: 'none',
  timing: true,
  policy_decision: true,
  authority_locus: true
}
```

A tool declaration is a ceiling, not a request to emit. Site policy can only narrow it.

## Site Telemetry Policy

Telemetry policy is site-local and defaults to disabled when absent.

Policy path:

```text
.ai/mcp-telemetry.json
```

Minimal default-equivalent policy:

```json
{
  "enabled": false
}
```

A conservative enabled policy:

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

Global policy applies first. Per-surface overrides may narrow or enable a specific surface only when global telemetry is enabled, unless a later design explicitly introduces `surfaces.<id>.enabled_without_global`. That exception is not part of v1.

## Emission Rule

Telemetry emission is the intersection of three policies:

```text
emitted fields = tool declaration intersect site policy intersect sink policy
```

Consequences:

- A tool cannot emit fields it did not declare.
- A site cannot accidentally enable fields the tool did not declare.
- A sink cannot persist fields its own policy disallows.
- When policy is absent or disabled, the telemetry helper is a no-op and writes no files.

## Persistence Contract

Default disabled means no telemetry files are written.

When enabled, v1 persists telemetry to per-surface JSONL files:

```text
.ai/telemetry/<surface_id>.jsonl
```

Per-surface files are the v1 default because they are easier to inspect, rotate, delete, and reason about by sensitivity. A single combined file such as `.ai/telemetry/mcp-events.jsonl` may be added later as an explicit sink option, not as the initial default.

Each line is one event envelope. The telemetry helper creates parent directories only after policy admits emission.

## Event Envelope

V1 event envelope:

```json
{
  "schema": "narada.mcp_telemetry.event.v1",
  "recorded_at": "2026-07-02T18:00:00.000Z",
  "site_id": "narada.staccato",
  "site_root": "D:/code/narada.staccato",
  "surface_id": "graph-mail",
  "tool_name": "graph_mail_query",
  "event_kind": "tool_completed",
  "status": "ok",
  "duration_ms": 42,
  "agent_id": "narada-staccato.resident",
  "carrier_session_id": "carrier_...",
  "correlation_id": "...",
  "authority_locus": {
    "kind": "local_site",
    "site_root": "D:/code/narada.staccato"
  },
  "policy_decision": {
    "status": "allowed"
  }
}
```

Allowed metadata fields in v1:

- `schema`
- `recorded_at`
- `site_id`
- `site_root`
- `surface_id`
- `tool_name`
- `event_kind`
- `status`
- `duration_ms`
- `agent_id`
- `carrier_session_id`
- `correlation_id`
- `authority_locus`
- `policy_decision.status`
- `error_code` or `refusal_code` when present

## Forbidden Persisted Fields In V1

V1 telemetry must not persist:

- raw tool arguments;
- raw tool results;
- secrets or bearer tokens;
- Microsoft Graph access tokens;
- approval tokens;
- message bodies;
- mailbox message content;
- file contents;
- command stdout or stderr;
- upload URLs;
- base64 content;
- binary data;
- full rendered assistant text;
- arbitrary caller-supplied objects unless a tool declaration and policy explicitly admit a redacted summary in a later version.

This forbidden list applies even when telemetry is enabled.

## Retention

V1 telemetry does not run a retention daemon and does not delete files automatically.

`retention_days` is policy metadata only. It records operator intent for later pruning. A future scheduler or site-lifecycle task can implement explicit cleanup under its own authority.

## Runtime Introspection Relationship

`runtime-introspection-mcp` is a reader/analyzer. It can consume telemetry JSONL later, but it should not own telemetry emission.

`mcp-telemetry` is the write-side helper for surfaces. `runtime-introspection-mcp` remains the read/analyze surface for event streams, transcript adapters, and coherence analysis.

## Initial Integration Strategy

1. Document the target shape and persistence contract.
2. Move shared packages under `packages/shared/` while preserving published package names.
3. Create `@narada2/mcp-telemetry` with no-op default behavior and tests.
4. Integrate with one low-risk read surface to validate ergonomics.
5. Integrate with one audited mutation surface to prove telemetry does not replace audit.
6. Inventory remaining surfaces and create high-confidence migration tasks only after the first integrations settle.

## Non-Goals

- No network telemetry sinks in v1.
- No global host daemon in v1.
- No replacement of `.ai/audit/*.jsonl` records.
- No raw args/results by default.
- No telemetry requirement for task completion evidence.
- No hidden side effects when telemetry is disabled.

## Review Checklist

A telemetry integration is coherent only if:

- the surface still works with no telemetry config;
- no telemetry files are created when disabled;
- enabled telemetry writes only declared and policy-admitted fields;
- sensitive fields are absent in tests;
- existing audit behavior is unchanged;
- errors/refusals include safe machine-readable codes;
- package-local tests prove disabled and enabled behavior.
