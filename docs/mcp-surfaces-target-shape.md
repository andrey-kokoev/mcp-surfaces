# MCP Surfaces Target Shape

This document defines the implementation-driving target shape for `mcp-surfaces` as Narada's governed crossing layer. It is scoped to this repository: it does not replace Narada doctrine, but it translates the doctrine into package-level expectations that can drive implementation tasks and review.

## Purpose

An MCP surface is a typed boundary where a caller asks for inspection, proposal, mutation, execution, or orchestration. The surface owns the mechanical contract for that boundary: schemas, policy checks, output limits, materialized references, typed errors, audit evidence, and precise refusal.

The target shape is:

```text
caller intent
-> typed MCP input
-> surface-owned policy / authority check
-> governed effect or typed refusal
-> durable evidence or bounded observation
-> readback / review / reconciliation path
```

Surfaces must be ergonomic, but ergonomics must compose governed primitives rather than hiding authority or evidence.

## Surface Contract Invariants

Every surface should make these properties inspectable or mechanically enforced when relevant:

- **Typed inputs**: schemas reject invalid shapes instead of silently coercing them. Long or nested companion data uses `payload_ref`, `payload_json`, or another explicitly documented transport path.
- **Typed outputs**: successful calls return structured content plus deterministic rendered text. Large outputs materialize behind explicit output refs and reader tools.
- **Policy readback**: policy-gated surfaces expose an inspect/doctor tool that reports allowed roots, roles, commands, profiles, limits, and unsafe toggles without leaking secrets.
- **Bounded execution**: command/process surfaces use argv/config structures, not raw command strings; adapters receive resolved policy, not raw tool input.
- **Authority evidence**: mutations record who requested them, what authority basis admitted them, what target was changed, and what readback or review remains.
- **Observation/evidence separation**: readback, CLI output, and generated summaries are observations until a surface admits them as evidence under its lifecycle rules.
- **Precise refusal**: expected failures use domain-specific error/status codes with actionable remediation; no policy failure should fall through to a generic unhandled error.
- **No host-policy leakage**: Codex, OpenCode, `agent-cli`, and other MCP hosts may invoke the same surface, but host identity must not silently change policy.

## Boundary Rules By Package Family

- `mcp-transport` owns generic payload and output-reference mechanics only. It must not acquire task lifecycle, mail, git, or worker domain behavior.
- Filesystem, command, and git surfaces own governed substrate access. They must keep read/write/execute authority separate and disclose scope, freshness, and audit posture.
- Task lifecycle and completion surfaces own work records, evidence admission, reports, reviews, and closure gates. Task Markdown is an authored projection/evidence surface, not lifecycle authority by itself.
- Worker delegation owns policy-gated worker runtime invocation. It is not a shell, task lifecycle surface, recursive worker-control surface, or general orchestrator.
- Delegated task owns durable delegated task records, workflow plans, acceptance contracts, events, and handoff packets. It should coordinate outcomes without taking over worker runtime, filesystem, git, or shell authority.
- Mailbox owns read-only synced mailbox projection. Graph mail owns policy-gated live Graph reads and draft lifecycle. Sending remains disallowed unless explicit site policy admits it.
- Registrar and site lifecycle own the weave between surfaces, sites, and carriers. They may write config under their authority, but they do not start processes or mutate the surface implementations themselves.
- Surface feedback owns MCP usage friction intake. Bugs, gaps, schema failures, and ergonomics observations should enter there before becoming implementation tasks.

## Ergonomic Composition Rules

Higher-level helpers are allowed when they preserve the underlying governed records.

A compound helper may combine steps such as claim, write notes, prove criteria, admit evidence, and submit report, but it must still emit the same claim intent, evidence admission, report, review obligation, and changed-file evidence that primitive calls would emit.

A helper must not:

- infer authority from caller fluency or model judgment;
- hide a policy crossing inside a convenience path;
- mutate through a read surface;
- collapse draft, send, execution, and confirmation into one unreviewable act;
- replace explicit payload refs with larger ad hoc inline limits.

## Gap Map From Current State

The current dirty tree and `defects.md` indicate these implementation themes:

1. **Worker delegation hardening**
   - Replace partial/fallback parsing and coercion with strict input/config validation.
   - Preserve absent worker output as a domain-specific failure instead of normalizing to fallback empty fields.
   - Convert output-ref read failures to typed materialization errors.
   - Strengthen tests around real binary/package surfaces and prompt/output evidence.

2. **Task lifecycle ergonomics and evidence**
   - Consolidate create payload schema, safe list-field normalization, long-field payload-ref guidance, and generic engineer claim authority into a coherent task-lifecycle ergonomics change set.
   - Keep role crossing narrow: generic `engineer` may accept site-specific `*-engineer` only with recorded operator authority; unrelated roles still reject.
   - Consider a compound governed work-submission helper only after primitive evidence records remain stable.

3. **Local filesystem / structured command / git substrate surfaces**
   - Continue making policy, ignored paths, output pagination, and refusal reasons first-class and consistent across read, write, execute, and publication surfaces.
   - Avoid broad shells, wildcard mutation paths, or silent coercion of policy-relevant flags.

4. **Delegated task and worker workflow split**
   - Keep delegated-task as the durable orchestration/contract surface and worker-delegation as the runtime execution surface.
   - Add fan-out/fan-in review ergonomics only through durable workflow records, not recursive worker-control leakage.

5. **Graph mail attachment and draft workflow**
   - Attachment operations should be first-class Graph mail tools, not ad hoc structured-command scripts that dump large base64 into model context.
   - Draft creation, attachment upload, attachment list/readback, and send policy must remain separate authority steps.

## Task Derivation Rule

When converting gaps into tasks, each task should name:

- the target invariant it advances;
- the current behavior or defect;
- the surface that owns the fix;
- the public schema/tool behavior that changes;
- package-local tests and any cross-surface smoke tests;
- whether the change is primitive behavior or ergonomic composition.

Do not create tasks that merely say "clean up" or "improve ergonomics" without tying them to one of the target invariants above.

## Ready Task Candidates

These candidates are intentionally phrased as task payload material. Before creating them, check for duplicate open work by title and surface.

### Worker delegation strict policy/input hardening

- Target invariant: typed inputs, policy readback, precise refusal.
- Current gap: worker-delegation accepts or masks malformed config/tool inputs through partial TOML parsing, silent trust-config skipping, broad truthiness for `skip_git_repo_check`, non-object `config` coercion, and missing CLI flag values.
- Surface: `worker-delegation-mcp`.
- Public behavior: malformed policy/config/tool input must fail with typed worker errors and actionable details instead of defaulting or silently ignoring values.
- Tests: `pnpm test:worker-delegation`; include package-local regressions for malformed TOML, malformed trust config, non-object `config`, string `skip_git_repo_check`, and missing CLI flag values.

### Worker delegation runtime/output evidence hardening

- Target invariant: typed outputs, bounded execution, precise refusal.
- Current gap: worker-delegation normalizes absent or invalid worker output into fallback empty fields and reports missing last-message output as generic invalid shape.
- Surface: `worker-delegation-mcp`.
- Public behavior: absent output, invalid output shape, runtime startup failure, and output-ref read failure must remain distinguishable typed states in `result.json`, rendered output, and MCP errors.
- Tests: `pnpm test:worker-delegation`; include absent last-message, invalid last-message, output-ref missing file, and spawned-process failure after process creation.

### Worker delegation packaged runtime smoke coverage

- Target invariant: bounded execution, typed outputs, no artifact-first test false positives.
- Current gap: successful tests use fake Codex-shaped fixtures and protocol smoke starts built source instead of the package bin surface.
- Surface: `worker-delegation-mcp`.
- Public behavior: package bin mapping and real invocation argv/schema behavior must be covered by a smoke path; fixture tests must assert prompt construction evidence instead of allowing fallback branches.
- Tests: `pnpm test:worker-delegation`; add a packaged-bin smoke test and, where real Codex cannot be required in CI, a clearly named optional/manual real-Codex compatibility smoke.

### Task lifecycle compound work submission helper

- Target invariant: ergonomic composition without authority collapse.
- Current gap: normal task completion still requires many primitive calls and manual task-file edits, which creates friction and repeated evidence mistakes.
- Surface: `task-lifecycle-mcp`.
- Public behavior: add a compound helper that can claim with explicit authority, write execution/verification notes, prove criteria, admit evidence, and submit a report while emitting the same primitive evidence records. It must not bypass role gates, changed-file evidence, recovery truthfulness, or review obligations.
- Tests: `pnpm test:task-lifecycle`; include happy path, role authority required, scaffold-placeholder rejection, changed-file/no-files-changed validation, and recovery-truthfulness-triggered work.

### Graph mail first-class attachment lifecycle

- Target invariant: bounded execution, observation/evidence separation, no command workaround for governed mail effects.
- Current gap: attachment upload workflows can require ad hoc structured-command scripts and large base64 output, risking model-context overflow and hidden Graph behavior.
- Surface: `graph-mail-mcp`.
- Public behavior: expose first-class draft attachment tools for small direct attachments and large upload-session chunking, with list/readback verification and send still separately policy-gated.
- Tests: `pnpm test:graph-mail`; include small attachment create, large upload-session chunking with bounded output, attachment list readback, token/policy failures, and no-send default.

### Cross-surface output/ref and refusal consistency audit

- Target invariant: typed outputs, materialized refs, precise refusal.
- Current gap: local-filesystem, structured-command, git, worker-delegation, and task-lifecycle have converged unevenly on output paging, output refs, refusal details, and payload refs.
- Surfaces: `local-filesystem-mcp`, `structured-command-mcp`, `git-mcp`, `worker-delegation-mcp`, `task-lifecycle-mcp`.
- Public behavior: document and test common output/ref/refusal conventions without forcing all surfaces into one domain schema.
- Tests: package-local tests for touched surfaces plus root `pnpm test` if shared transport helpers change.

