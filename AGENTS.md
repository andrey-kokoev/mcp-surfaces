# AGENTS.md

Guidance for agents working in this repository.

## Repository Purpose

`mcp-surfaces` contains MCP surface packages shared by Narada sites and carriers. Some surfaces are standalone and can be used outside Narada; package READMEs and wiring docs carry the setup details. See `docs/mcp-taxonomy.md` for the generic-versus-Narada-specific split.

Current packages:

- `@narada2/mcp-transport`: shared MCP payload/output-ref helpers.
- `@narada2/mcp-telemetry`: shared optional MCP telemetry helpers.
- `@narada2/mcp-affordances`: shared UI-neutral MCP affordance schema and validation helpers.
- `@narada2/mcp-runtime-proxy`: shared carrier stdio proxy for MCP startup diagnostics.
- `@narada2/mcp-e2e-harness`: shared bounded mechanics for real MCP end-to-end tests.
- `@narada2/execution-contract`: shared typed execution binding and request fingerprint contract.
- `@narada2/provider-registry`: shared typed, policy-neutral provider/model capability registry loading and resolution.
- `@narada2/local-filesystem-mcp`: governed filesystem MCP surface.
- `@narada2/structured-command-mcp`: policy-gated structured command MCP surface.
- `@narada2/git-mcp`: governed Git inspection and publication MCP surface.
- `@narada2/site-inbox-mcp`: governed inbox intake and triage MCP surface.
- `@narada2/mailbox-mcp`: read-only synced mailbox projection MCP surface.
- `@narada2/graph-mail-mcp`: policy-gated Microsoft Graph mail MCP surface for live reads and draft management.
- `@narada2/calendar-mcp`: policy-gated Microsoft Graph calendar MCP surface for live calendar reads and guarded event management.
- `@narada2/task-lifecycle-mcp`: task lifecycle MCP surface.
- `@narada2/site-loop-mcp`: config-governed site loop MCP surface.
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
- `@narada2/site-registry-mcp`: User Site MCP surface for canonical cross-site registry inspection and reconciliation planning.
- `@narada2/operator-routing-mcp`: User Site operator routing surface for transcript-to-target decisions and inbox fallback packaging.
- `@narada2/artifacts-mcp`: NARS session artifact registration and renderable artifact reference MCP surface.
- `@narada2/nars-session-mcp`: governed input and bounded readback for existing NARS sessions.

Site Loop doctrine and boundaries are documented in `docs/site-loop-doctrine.md`.

## Getting Started

- Use `pnpm@10.9.0` (pinned via `packageManager` in the root `package.json`; `corepack enable` provides it).
- Run `pnpm install` after cloning or pulling workspace changes, then `pnpm build`. Package test scripts compile through `tsc -b` into `dist/` and run the compiled output, so a successful build is a prerequisite for any test run.
- After editing the root `tsconfig.json` (or any shared build configuration), run a full rebuild with `pnpm exec tsc -b --force`. Incremental builds will not re-emit unchanged packages, and the `mcp-loader-mcp` freshness test compares build-configuration mtimes against `dist/` and will fail until everything is re-emitted.
- Layout: runnable MCP surfaces live in `packages/*`, shared libraries in `packages/shared/*`, design and doctrine docs in `docs/`, and the root UI-neutrality boundary test in `test/`.
- The root `README.md` gives repo-level framing; each package has its own `README.md` with setup details.
- Key docs: `docs/mcp-taxonomy.md` (generic versus Narada-specific split), `docs/mcp-wiring.md` and `docs/mcp-injection-scopes.md` (how surfaces reach carriers and sites), `docs/mcp-surfaces-target-shape.md` (target architecture), `docs/site-loop-doctrine.md` (Site Loop doctrine), `docs/mcp-output-refusal-conventions.md` (output-ref and refusal patterns).

## Carrier and Site MCP Fabric

Carrier-native config files are host/user-site bootstrap profiles. A naked carrier launch receives host-level MCP surfaces, User Site MCP surfaces, and any Local Site MCP surfaces the operator has explicitly selected for that carrier profile, wired through carrier-specific mechanics such as Codex TOML, OpenCode JSONC, or Kimi MCP JSON. The launch must not infer Local Site surfaces from the current directory or from an unchosen Site.

Local Site MCP fabric is injected by Narada launch/session materialization, not by creating carrier profiles named for individual sites. Do not add site-specific carrier profiles such as `opencode-sonar`; bind the Site through the launcher/site fabric instead. If a carrier needs a different local Site, launch it through Narada so the Site-owned MCP aggregate is selected at session start.

Registrar tests must cover generated carrier configs for all supported carrier kinds and prove that shared surfaces use shared package entrypoints and current tool metadata. Generated carrier configs must not preserve legacy Site-local entrypoints or obsolete tool names after a surface migrates to a shared package.

## MCP Guidance Commands

Most MCP surface packages should expose a read-only `_guidance` command using the surface's normal tool prefix, for example `task_lifecycle_guidance`, `git_guidance`, `fs_guidance`, or `graph_mail_guidance`.

These commands are for model-facing operating guidance. They should explain the surface's purpose, first-use workflow, preferred tool sequence, state semantics, examples, anti-patterns, recovery steps, payload/output-ref conventions when relevant, and boundary notes. They must not mutate state, weaken policy, or replace authoritative tool schemas and policy checks.

When a model is unfamiliar with a surface, uncertain about the correct workflow, or recovering from a refusal/error, prefer calling that surface's `_guidance` command before guessing. If the guidance is missing, unclear, stale, or contradicted by live behavior, submit feedback through `@narada2/surface-feedback-mcp`.

## Surface Feedback

Agents can submit feedback about any MCP surface via `@narada2/surface-feedback-mcp`:

- `surface_feedback_submit` — submit a bug, improvement, gap, or observation about a surface.
- `surface_feedback_list` — list feedback with an explicit server-bound read scope.
- `surface_feedback_actionable_queue` — read the bounded actionable queue with an explicit server-bound read scope.
- `surface_feedback_show` — show one feedback entry within an explicit read scope.
- `surface_feedback_stats` — aggregated counts by surface, kind, and status within an explicit read scope.

Read calls must pass `scope` explicitly. `all_authorized` requires the canonical feedback store and server-bound User Site authority; `authority_visible`, `owned_surfaces`, and `authority_site_submissions` are narrower server-bound views. Submitter-site visibility compares server-bound authority to declared metadata and is not authenticated provenance; `submitter_site_id_filter` is declarative metadata filtering only and never establishes provenance or authorization.

Kinds:

- `bug` — something is broken or fails unexpectedly.
- `improvement` — an enhancement to existing behavior.
- `gap` — missing capability that should exist.
- `observation` — usage note, discoverability finding, or non-urgent concern.

When submitting, include:

- `surface_id` (e.g. `worker-delegation`, `graph-mail`, `mcp-registrar`).
- `submitter_site_id` (e.g. `andrey-user`, `narada-sonar`).
- `submitter_principal` (your agent identity).
- `kind` and a concise `summary`.
- `details` with reproduction steps, expected behavior, and impact.

Use this surface for any MCP usage friction, runtime failures, schema issues, or documentation gaps before opening a task or CAPA.

## Development Rules

- Use TypeScript sources under `packages/*/src` or `packages/shared/*/src` and tests under the matching package `test` directory.
- Do not add new `.mjs` source files under `packages/*`; MCP package code and package tests are TypeScript. The root `test/ui-neutral-boundary.test.mjs` harness is a pre-existing exception, not a pattern to copy.
- Preserve ESM/NodeNext package behavior.
- Prefer package-local tests for narrow changes, then root tests when shared behavior changes.
- Keep MCP tool schemas explicit and conservative: no broad shell strings, wildcard filesystem access, or implicit mutation paths.
- Keep transport helpers generic. Do not add Narada task-domain behavior to `@narada2/mcp-transport`.
- Model-facing MCP tool output that can exceed a small inline envelope must pass through the shared `mcp-transport` output-ref boundary or an explicit package-owned equivalent. Large domain results should be materialized and returned with a bounded inline envelope plus a reader tool.
- Keep shared transport readers bound to one site authority scope. Do not accept raw cross-site roots or infer cross-site authority from local filesystem reachability; explicit cross-site transfer belongs to an authorized User Site or artifact/export surface. See `docs/mcp-surfaces-target-shape.md`.
- Shared libraries such as `@narada2/mcp-transport` live under `packages/shared/*`; runnable MCP surfaces remain top-level packages until the broader `packages/surfaces/*` migration is executed.
- Register every package in the root `tsconfig.json` `references`; root `pnpm build` and `pnpm typecheck` only cover referenced packages.
- When you add or rename a package, root test alias, command, or convention, update this `AGENTS.md` in the same change.

## Common Commands

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm test:ui-boundary
pnpm test:mcp-transport
pnpm test:mcp-telemetry
pnpm test:mcp-affordances
pnpm test:mcp-runtime-proxy
pnpm test:mcp-e2e-harness
pnpm test:provider-registry
pnpm test:local-filesystem
pnpm test:structured-command
pnpm test:git
pnpm test:worker-delegation
pnpm test:inbox
pnpm test:mailbox
pnpm test:graph-mail
pnpm test:calendar
pnpm test:task-lifecycle
pnpm test:site-loop
pnpm test:site-registry
pnpm test:site-lifecycle
pnpm test:agent-context
pnpm test:delegated-task
pnpm test:sop
pnpm test:scheduler
pnpm test:registrar
pnpm test:registrar:kimi-contract
pnpm test:surface-feedback
pnpm test:launcher
pnpm test:mcp-loader
pnpm test:operator-routing
pnpm test:runtime-introspection
pnpm test:speech
pnpm test:cloudflare-carrier
pnpm test:site-coherence
pnpm test:artifacts
pnpm test:nars-session
```

The following variants require a live host, a live carrier, or explicit host authority. They are not part of `pnpm test`; do not run them without operator approval:

```powershell
pnpm test:worker-delegation:e2e
pnpm test:worker-delegation:e2e:edit
pnpm test:worker-delegation:e2e:site-fabric
pnpm test:worker-delegation:e2e:carrier
pnpm test:delegated-task:live
pnpm test:delegated-task:e2e
pnpm test:scheduler:e2e:host
pnpm test:launcher:e2e:host
pnpm test:registrar:kimi-live
```

## Verification Expectations

Before handing off changes:

- Run the most specific package test for the touched package (`pnpm test:<name>`).
- Run `pnpm build` or `pnpm typecheck` when package exports, TypeScript config, or shared types change. These cover exactly the packages listed in the root `tsconfig.json` `references`; if a package is missing there, add it rather than working around the gap.
- Run root `pnpm test` for changes affecting shared MCP behavior or package boundaries.

## Adding a New Package

Do all of the following in the same change:

1. Create the package under `packages/<name>-mcp` (runnable surfaces) or `packages/shared/<name>` (shared libraries), with TypeScript sources in `src/` and tests in `test/`.
2. Add the package to the root `tsconfig.json` `references` and verify `pnpm build` and `pnpm typecheck` pass.
3. Add a root `package.json` `test:<name>` alias following the existing `pnpm --filter <package> test` pattern.
4. Expose a read-only `<prefix>_guidance` tool on new surfaces.
5. Register new surfaces in the registrar catalog and cover them in registrar carrier-config tests.
6. Add the package to the inventory and boundary notes in this `AGENTS.md`.

## Git Workflow

- Do feature work on `agent/<topic>` branches.
- This repo does not use changesets; the `narada` repo does — do not copy that convention here.
- Stage only paths explicitly scoped to your change and leave unrelated worktree state untouched.

### One Worktree per Agent Stream

- The default for automated agent work is one dedicated Git worktree and one
  `agent/<topic>` branch per independently active stream. Two live agent
  streams must not share a physical worktree or Git index, even when their task
  scopes appear disjoint.
- Before claiming implementation work, call `git_status`. If the selected
  worktree already contains changes not established as belonging to the current
  stream, do not silently continue: use or create a separate worktree, or emit
  an explicit shared-worktree warning and obtain an operator-directed exception.
- A shared-worktree exception is temporary. Record it in task execution notes,
  preserve all pre-existing paths, and scope every stage operation explicitly.
  Before commit, call `git_commit` with `expected_staged_paths`; treat any
  index divergence as a refusal requiring a fresh status/diff review.
- This discipline applies to concurrent automated streams. It does not mandate
  extra worktrees for ordinary human-only repository use.

## Boundary Notes

- `local-filesystem-mcp` owns governed file inspection and mutation tools.
- `structured-command-mcp` owns argv-based command execution policy.
- `worker-delegation-mcp` owns policy-gated delegation to worker runtimes; it is not a general shell, task lifecycle, or recursive worker-control surface.
- `delegated-task-mcp` owns durable delegated task records, workflow plans, acceptance contracts, events, and handoff packets; it must not become a shell, git, filesystem mutation, worker runtime, or Narada workboard surface.
- `sop-mcp` owns versioned SOP templates and durable run execution; it orchestrates procedural steps but does not own tasks, workers, filesystem access, or shell execution directly — it delegates those to their respective MCP surfaces.
- `scheduler-mcp` owns Windows Task Scheduler registration, inspection, and execution; it must not become a general shell or process orchestration surface — scheduling policy is defined at the caller level.
- `mcp-registrar` owns the surface-to-site-to-carrier weave; it edits config files (JSON/TOML) but does not start or stop servers or mutate the surfaces themselves.
- Registrar catalog entries may expose explicit projections over one package entrypoint. Projection scope and `runtime_requirements` select availability; they never replace surface policy. Multi-projection bindings must provide an explicit `projection_id` or a runtime kind that selects exactly one projection. Do not infer projection from server names, current directories, or entrypoint paths.
- `site-registry-mcp` owns User Site access to the canonical cross-site registry. It is read-only, exposes reconciliation planning rather than apply, and must not acquire Local Site lifecycle responsibilities.
- `mcp-loader-mcp` owns runtime attachment/proxying for allowed MCP surfaces; it does not own the surfaces it attaches to and must not become a general orchestration layer. It honors explicit `surface_projection.runtime_requirements`: omitted runtime context selects only neutral projections, and runtime-affined projections require a matching `runtime_kind`.
- `mcp-transport` owns reusable payload/output reference mechanics.
- `mcp-telemetry` owns optional site-policy-gated telemetry helpers; it must not replace mandatory audit logs or persist raw args/results by default.
- `mcp-affordances` owns UI-neutral MCP affordance document types, builders, and validation helpers. It must not encode renderer-specific components or bypass MCP tool schemas and policy checks.
- `mcp-runtime-proxy` owns carrier-facing stdio proxy diagnostics for MCP startup. It must not authorize tools, mutate policy, or interpret surface domain behavior.
- `mcp-e2e-harness` owns bounded child-process transport (JSONL and Content-Length), temporary roots, cleanup, and result artifacts for real MCP E2E tests. It must not create Site fabric, define surface policy, or encode domain assertions.
- `execution-contract` owns shared execution binding and request fingerprint types only. It must not launch runtimes, authorize paths, or acquire task/domain behavior.
- `nars-session-mcp` owns only the MCP adapter for concrete existing NARS sessions; NARS carrier protocol and session authority remain in Narada proper.
- `mailbox-mcp` owns read-only access to site-local synced mailbox projections; it must not become a general PowerShell, Graph, Outlook, or message-sending surface.
- `graph-mail-mcp` owns policy-gated Microsoft Graph mail access and draft lifecycle tools; sending drafts must stay disallowed unless explicit site policy enables it.
- `calendar-mcp` owns policy-gated Microsoft Graph calendar access and event lifecycle tools; event writes must stay disallowed unless explicit site policy enables them.
- Task lifecycle/domain behavior belongs in dedicated MCP surface packages with explicit shared-domain dependencies.

