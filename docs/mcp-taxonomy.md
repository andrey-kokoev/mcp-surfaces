# MCP Taxonomy

This repository mixes reusable substrate surfaces with Narada-specific control-plane surfaces. The split is practical, not metaphysical: some packages are generic MCP building blocks, others are Narada-owned orchestration or site surfaces.

## Generic Or Reusable

- `@narada2/mcp-transport`
- `@narada2/mcp-telemetry`
- `@narada2/mcp-affordances`
- `@narada2/mcp-runtime-proxy`
- `@narada2/local-filesystem-mcp`
- `@narada2/structured-command-mcp`
- `@narada2/git-mcp`

## Narada-Specific

- `@narada2/site-inbox-mcp`
- `@narada2/mailbox-mcp`
- `@narada2/graph-mail-mcp`
- `@narada2/calendar-mcp`
- `@narada2/task-lifecycle-mcp`
- `@narada2/site-loop-mcp`
- `@narada2/agent-context-mcp`
- `@narada2/worker-delegation-mcp`
- `@narada2/delegated-task-mcp`
- `@narada2/sop-mcp`
- `@narada2/scheduler-mcp`
- `@narada2/mcp-registrar`
- `@narada2/mcp-loader-mcp`
- `@narada2/runtime-introspection-mcp`
- `@narada2/speech-mcp`
- `@narada2/cloudflare-carrier-mcp`
- `@narada2/site-coherence-mcp`
- `@narada2/site-lifecycle-mcp`
- `@narada2/site-registry-mcp`
- `@narada2/operator-routing-mcp`
- `@narada2/artifacts-mcp`
- `@narada2/nars-session-mcp`
- `@narada2/surface-feedback-mcp`
- `@narada2/launcher-mcp`

## Ambiguous Infrastructure

These are Narada-owned infrastructure surfaces that can feel generic because they support other surfaces, but they still belong to the Narada control plane:

- `@narada2/mcp-registrar`
- `@narada2/mcp-loader-mcp`
- `@narada2/runtime-introspection-mcp`
- `@narada2/launcher-mcp`

## How To Use This Split

- Treat generic surfaces as reusable substrate unless a package doc says otherwise.
- Treat Narada-specific surfaces as control-plane or site-owned surfaces unless a package doc explicitly says they are portable.
- When in doubt, follow the package README and the injection-scope doctrine in `docs/mcp-injection-scopes.md`.
