# mcp-surfaces

Standalone MCP surface packages shared by Narada sites and carriers.

## Packages

- `@narada-core/mcp-transport`: MCP payload/output-ref helpers. See `packages/shared/mcp-transport/README.md`.
- `@narada-core/mcp-telemetry`: optional MCP telemetry helpers. See `packages/shared/mcp-telemetry/README.md`.
- `@narada-core/mcp-runtime-proxy`: carrier stdio proxy for MCP startup diagnostics. See `packages/shared/mcp-runtime-proxy/README.md`.
- `@narada-core/mcp-surface-runtime`: authority-bound execution engine for explicit surface factories with a stdio compatibility adapter. See `packages/shared/mcp-surface-runtime/README.md`.
- `@narada-core/local-filesystem-mcp`: canonical local filesystem MCP surface exposing `fs_*` tools. See `packages/local-filesystem-mcp/README.md`.
- `@narada-core/structured-command-mcp`: policy-gated command execution surface using structured argv schemas. See `packages/structured-command-mcp/README.md`.
- `@narada-core/git-mcp`: governed Git inspection and publication MCP surface. See `packages/git-mcp/README.md`.
- `@narada-core/site-inbox-mcp`: governed inbox intake and triage MCP surface. See `packages/site-inbox-mcp/README.md`.
- `@narada-core/mailbox-mcp`: read-only MCP surface for site-local synced mailbox projections. See `packages/mailbox-mcp/README.md`.
- `@narada-core/graph-mail-mcp`: policy-gated Microsoft Graph mail surface for live reads and draft management. See `packages/graph-mail-mcp/README.md`.
- `@narada-core/calendar-mcp`: policy-gated Microsoft Graph calendar surface for live reads and guarded event management. See `packages/calendar-mcp/README.md`.
- `@narada-core/task-lifecycle-mcp`: task lifecycle MCP surface. See `packages/task-lifecycle-mcp/README.md`.
- `@narada-core/site-loop-mcp`: config-governed site loop MCP surface. See `packages/site-loop-mcp/README.md`.
- `@narada-core/agent-context-mcp`: agent context MCP surface. See `packages/agent-context-mcp/README.md`.
- `@narada-core/worker-delegation-mcp`: policy-gated worker delegation MCP surface. See `packages/worker-delegation-mcp/README.md`.
- `@narada-core/delegated-task-mcp`: outcome-oriented delegated task orchestration MCP surface. See `packages/delegated-task-mcp/README.md`.
- `@narada-core/sop-mcp`: versioned standard operating procedure runbook engine with SQLite-backed execution. See `packages/sop-mcp/README.md`.
- `@narada-core/scheduler-mcp`: Windows Task Scheduler MCP surface for governed task registration, inspection, and execution. See `packages/scheduler-mcp/README.md`.
- `@narada-core/site-lifecycle-mcp`: governed Local Site lifecycle inspection and mutation surface. See `packages/site-lifecycle-mcp/README.md`.
- `@narada-core/site-registry-mcp`: read-only User Site surface for canonical cross-site registry inspection and reconciliation planning. See `packages/site-registry-mcp/README.md`.
- `@narada-core/mcp-registrar`: MCP surface registrar for binding/unbinding surfaces across Narada sites and carriers. See `packages/mcp-registrar/README.md`.
- `@narada-core/surface-feedback-mcp`: cross-site MCP surface feedback intake and routing. See `packages/surface-feedback-mcp/README.md`.
- `@narada-core/speech-mcp`: host-level speech surface for TTS, bounded capture, and transcription. See `packages/speech-mcp/README.md`.
- `@narada-core/nars-session-mcp`: governed input and bounded readback for existing NARS sessions. See `docs/nars-session-mcp-target.md`.
- `@narada-core/quota-meter-mcp`: host-level quota-meter glide status and desktop overlay lifecycle management. See `packages/quota-meter-mcp/README.md`.

- @narada-core/operator-console-overlay-mcp: host-level dedicated MCP surface for the Narada Operator Console Windows overlay. See packages/operator-console-overlay-mcp/README.md.

## Verify

```powershell
pnpm install
pnpm build
pnpm test
```

## Build Availability

`pnpm build` validates the project-reference graph without deleting existing
`dist/` trees, force-emits the current graph, runs package post-compilation,
and publishes the workspace artifact manifest only after those steps succeed.
An interrupted or failed build therefore leaves the last successful MCP
entrypoints present. The manifest and runtime proxy remain responsible for
refusing stale or partially replaced artifacts; do not add workspace-wide
pre-build cleanup to the routine build path.

## Surface Target And Ergonomics

See `docs/mcp-surfaces-target-shape.md` for the implementation-driving target
shape for MCP surfaces as Narada's governed crossing layer.

See `docs/mcp-surface-runtime-target-shape.md` for the proof-first path from
per-session stdio children to one supervised, authority-partitioned PC Site
surface service.

See `docs/mcp-injection-scopes.md` for the doctrine that separates host,
user-site, and local-site MCP injection from session aliases.

See `docs/site-root-contract.md` for the canonical workspace/control-root and
generated Site marker contract.

See `docs/mcp-output-refusal-conventions.md` for common output reference,
payload reference, and refusal conventions shared across surfaces.

See `docs/mcp-telemetry-target-shape.md` for the optional telemetry target
shape, persistence contract, and shared package factorization.

See `docs/rust-surface-portfolio.md` for the Rust/JavaScript/dual-runtime
surface decisions, evidence ledger, and implementation order.

See `docs/agent-ergonomics-surfaces.md` for the boundary between mechanical MCP
evidence, multi-repository Git summaries, and agent completion audits.
