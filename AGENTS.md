# AGENTS.md

Guidance for agents working in this repository.

## Repository Purpose

`mcp-surfaces` contains standalone MCP surface packages shared by Narada sites and carriers.

Current packages:

- `@narada2/mcp-transport`: shared MCP payload/output-ref helpers.
- `@narada2/mcp-telemetry`: shared optional MCP telemetry helpers.
- `@narada2/local-filesystem-mcp`: governed filesystem MCP surface.
- `@narada2/structured-command-mcp`: policy-gated structured command MCP surface.
- `@narada2/git-mcp`: governed Git inspection and publication MCP surface.
- `@narada2/completion-audit-mcp`: requirement/evidence/verdict completion audit MCP surface.
- `@narada2/site-inbox-mcp`: governed inbox intake and triage MCP surface.
- `@narada2/mailbox-mcp`: read-only synced mailbox projection MCP surface.
- `@narada2/graph-mail-mcp`: policy-gated Microsoft Graph mail MCP surface for live reads and draft management.
- `@narada2/calendar-mcp`: policy-gated Microsoft Graph calendar MCP surface for live calendar reads and guarded event management.
- `@narada2/task-lifecycle-mcp`: task lifecycle MCP surface.
- `@narada2/sonar-site-ops-mcp`: Sonar site operations MCP surface.
- `@narada2/agent-context-mcp`: agent context MCP surface.
- `@narada2/worker-delegation-mcp`: policy-gated worker delegation MCP surface.
- `@narada2/delegated-task-mcp`: outcome-oriented delegated task orchestration MCP surface.
- `@narada2/sop-mcp`: versioned standard operating procedure runbook engine with SQLite-backed execution.
- `@narada2/scheduler-mcp`: Windows Task Scheduler MCP surface for governed task registration, inspection, and execution.
- `@narada2/mcp-registrar`: MCP surface registrar for binding/unbinding surfaces across Narada sites and carriers.
- `@narada2/surface-feedback-mcp`: cross-site MCP surface feedback intake and routing MCP surface.
- `@narada2/launcher-mcp`: read-only launcher registry, option matrix, plan, and coherence MCP surface.
- `@narada2/mcp-loader-mcp`: policy-gated runtime MCP surface loader and proxy.
- `@narada2/runtime-introspection-mcp`: Narada-owned runtime trace and session composition analysis MCP surface.
- `@narada2/speech-mcp`: host-level speech MCP surface for TTS, bounded capture, transcription, prompt-response, and listen sessions.
- `@narada2/cloudflare-carrier-mcp`: Cloudflare-carrier live operations MCP surface wrapping product-read, session status, and continuity health.
- `@narada2/site-coherence-mcp`: Site-level continuity coherence readback MCP surface for detecting posture mismatches between local and Cloudflare embodiments.
- `@narada2/site-lifecycle-mcp`: governed MCP surface aligned with `narada sites ...` CLI commands for Site creation planning, lifecycle inspection, relations, and gated configuration mutations.
- `@narada2/operator-routing-mcp`: User Site operator routing surface for transcript-to-target decisions and inbox fallback packaging.
- `@narada2/artifacts-mcp`: NARS session artifact registration and renderable artifact reference MCP surface.

## MCP Guidance Commands

Most MCP surface packages should expose a read-only `_guidance` command using the surface's normal tool prefix, for example `task_lifecycle_guidance`, `git_guidance`, `fs_guidance`, or `graph_mail_guidance`.

These commands are for model-facing operating guidance. They should explain the surface's purpose, first-use workflow, preferred tool sequence, state semantics, examples, anti-patterns, recovery steps, payload/output-ref conventions when relevant, and boundary notes. They must not mutate state, weaken policy, or replace authoritative tool schemas and policy checks.

When a model is unfamiliar with a surface, uncertain about the correct workflow, or recovering from a refusal/error, prefer calling that surface's `_guidance` command before guessing. If the guidance is missing, unclear, stale, or contradicted by live behavior, submit feedback through `@narada2/surface-feedback-mcp`.

## Surface Feedback

Agents can submit feedback about any MCP surface via `@narada2/surface-feedback-mcp`:

- `surface_feedback_submit` — submit a bug, improvement, gap, or observation about a surface.
- `surface_feedback_list` — list feedback with visibility scoping.
- `surface_feedback_show` — show one feedback entry.
- `surface_feedback_stats` — aggregated counts by surface, kind, and status.

Kinds:

- `bug` — something is broken or fails unexpectedly.
- `improvement` — an enhancement to existing behavior.
- `gap` — missing capability that should exist.
- `observation` — usage note, discoverability finding, or non-urgent concern.

When submitting, include:

- `surface_id` (e.g. `worker-delegation`, `graph-mail`, `mcp-registrar`).
- `submitter_site_id` (e.g. `narada-andrey`, `narada-sonar`).
- `submitter_principal` (your agent identity).
- `kind` and a concise `summary`.
- `details` with reproduction steps, expected behavior, and impact.

Use this surface for any MCP usage friction, runtime failures, schema issues, or documentation gaps before opening a task or CAPA.

## Development Rules

- Use TypeScript sources under `packages/*/src` or `packages/shared/*/src` and tests under the matching package `test` directory.
- Do not add new `.mjs` source files; this repo has migrated MCP package code to `.ts`.
- Preserve ESM/NodeNext package behavior.
- Prefer package-local tests for narrow changes, then root tests when shared behavior changes.
- Keep MCP tool schemas explicit and conservative: no broad shell strings, wildcard filesystem access, or implicit mutation paths.
- Keep transport helpers generic. Do not add Narada task-domain behavior to `@narada2/mcp-transport`.
- Shared libraries such as `@narada2/mcp-transport` live under `packages/shared/*`; runnable MCP surfaces remain top-level packages until the broader `packages/surfaces/*` migration is executed.

## Common Commands

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm test:mcp-transport
pnpm test:mcp-telemetry
pnpm test:local-filesystem
pnpm test:structured-command
pnpm test:git
pnpm test:completion-audit
pnpm test:worker-delegation
pnpm test:inbox
pnpm test:mailbox
pnpm test:graph-mail
pnpm test:calendar
pnpm test:task-lifecycle
pnpm test:sonar-site-ops
pnpm test:agent-context
pnpm test:delegated-task
pnpm test:sop
pnpm test:scheduler
pnpm test:registrar
pnpm test:launcher
pnpm test:cloudflare-carrier
pnpm test:site-coherence
pnpm test:artifacts
```

## Verification Expectations

Before handing off changes:

- Run the most specific package test for the touched package.
- Run `pnpm build` or `pnpm typecheck` when package exports, TypeScript config, or shared types change.
- Run root `pnpm test` for changes affecting shared MCP behavior or package boundaries.

## Boundary Notes

- `local-filesystem-mcp` owns governed file inspection and mutation tools.
- `structured-command-mcp` owns argv-based command execution policy.
- `completion-audit-mcp` owns durable requirement/evidence/verdict completion audit records; it must not inspect repositories, execute commands, or infer whether a requirement is true.
- `worker-delegation-mcp` owns policy-gated delegation to worker runtimes; it is not a general shell, task lifecycle, or recursive worker-control surface.
- `delegated-task-mcp` owns durable delegated task records, workflow plans, acceptance contracts, events, and handoff packets; it must not become a shell, git, filesystem mutation, worker runtime, or Narada workboard surface.
- `sop-mcp` owns versioned SOP templates and durable run execution; it orchestrates procedural steps but does not own tasks, workers, filesystem access, or shell execution directly — it delegates those to their respective MCP surfaces.
- `scheduler-mcp` owns Windows Task Scheduler registration, inspection, and execution; it must not become a general shell or process orchestration surface — scheduling policy is defined at the caller level.
- `mcp-registrar` owns the surface-to-site-to-carrier weave; it edits config files (JSON/TOML) but does not start or stop servers or mutate the surfaces themselves.
- `mcp-loader-mcp` owns runtime attachment/proxying for allowed MCP surfaces; it does not own the surfaces it attaches to and must not become a general orchestration layer.
- `mcp-transport` owns reusable payload/output reference mechanics.
- `mcp-telemetry` owns optional site-policy-gated telemetry helpers; it must not replace mandatory audit logs or persist raw args/results by default.
- `mailbox-mcp` owns read-only access to site-local synced mailbox projections; it must not become a general PowerShell, Graph, Outlook, or message-sending surface.
- `graph-mail-mcp` owns policy-gated Microsoft Graph mail access and draft lifecycle tools; sending drafts must stay disallowed unless explicit site policy enables it.
- `calendar-mcp` owns policy-gated Microsoft Graph calendar access and event lifecycle tools; event writes must stay disallowed unless explicit site policy enables them.
- Task lifecycle/domain behavior belongs in dedicated MCP surface packages with explicit shared-domain dependencies.

