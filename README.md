# mcp-surfaces

Standalone MCP surface packages shared by Narada sites and carriers.

## Packages

- `@narada2/mcp-transport`: MCP payload/output-ref helpers. See `packages/shared/mcp-transport/README.md`.
- `@narada2/mcp-telemetry`: optional MCP telemetry helpers. See `packages/shared/mcp-telemetry/README.md`.
- `@narada2/local-filesystem-mcp`: canonical local filesystem MCP surface exposing `fs_*` tools. See `packages/local-filesystem-mcp/README.md`.
- `@narada2/structured-command-mcp`: policy-gated command execution surface using structured argv schemas. See `packages/structured-command-mcp/README.md`.
- `@narada2/git-mcp`: governed Git inspection and publication MCP surface. See `packages/git-mcp/README.md`.
- `@narada2/completion-audit-mcp`: requirement/evidence/verdict completion audit MCP surface. See `packages/completion-audit-mcp/README.md`.
- `@narada2/site-inbox-mcp`: governed inbox intake and triage MCP surface. See `packages/site-inbox-mcp/README.md`.
- `@narada2/mailbox-mcp`: read-only MCP surface for site-local synced mailbox projections. See `packages/mailbox-mcp/README.md`.
- `@narada2/graph-mail-mcp`: policy-gated Microsoft Graph mail surface for live reads and draft management. See `packages/graph-mail-mcp/README.md`.
- `@narada2/calendar-mcp`: policy-gated Microsoft Graph calendar surface for live reads and guarded event management. See `packages/calendar-mcp/README.md`.
- `@narada2/task-lifecycle-mcp`: task lifecycle MCP surface. See `packages/task-lifecycle-mcp/README.md`.
- `@narada2/sonar-site-ops-mcp`: Sonar site operations MCP surface. See `packages/sonar-site-ops-mcp/README.md`.
- `@narada2/agent-context-mcp`: agent context MCP surface. See `packages/agent-context-mcp/README.md`.
- `@narada2/worker-delegation-mcp`: policy-gated worker delegation MCP surface. See `packages/worker-delegation-mcp/README.md`.
- `@narada2/delegated-task-mcp`: outcome-oriented delegated task orchestration MCP surface. See `packages/delegated-task-mcp/README.md`.
- `@narada2/sop-mcp`: versioned standard operating procedure runbook engine with SQLite-backed execution. See `packages/sop-mcp/README.md`.
- `@narada2/scheduler-mcp`: Windows Task Scheduler MCP surface for governed task registration, inspection, and execution. See `packages/scheduler-mcp/README.md`.
- `@narada2/mcp-registrar`: MCP surface registrar for binding/unbinding surfaces across Narada sites and carriers. See `packages/mcp-registrar/README.md`.
- `@narada2/surface-feedback-mcp`: cross-site MCP surface feedback intake and routing. See `packages/surface-feedback-mcp/README.md`.
- `@narada2/speech-mcp`: host-level speech surface for TTS, bounded capture, and transcription. See `packages/speech-mcp/README.md`.

## Verify

```powershell
pnpm install
pnpm test
```

## Surface Target And Ergonomics

See `docs/mcp-surfaces-target-shape.md` for the implementation-driving target
shape for MCP surfaces as Narada's governed crossing layer.

See `docs/mcp-injection-scopes.md` for the doctrine that separates host,
user-site, and local-site MCP injection from session aliases.

See `docs/mcp-output-refusal-conventions.md` for common output reference,
payload reference, and refusal conventions shared across surfaces.

See `docs/mcp-telemetry-target-shape.md` for the optional telemetry target
shape, persistence contract, and shared package factorization.

See `docs/agent-ergonomics-surfaces.md` for the boundary between mechanical MCP
evidence, multi-repository Git summaries, and agent completion audits.
