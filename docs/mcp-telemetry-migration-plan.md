# MCP Telemetry Migration Plan

## Current State

Telemetry now has a documented target shape and a shared implementation package at `packages/shared/mcp-telemetry`.

Implemented proving integrations:

- `runtime-introspection-mcp`: read-only, metadata-only telemetry, disabled by default.
- `calendar-mcp`: audited mutation surface, metadata-only telemetry, disabled by default, audit remains authoritative.

Shared packages:

- `mcp-transport`: shared payload/output-ref helpers under `packages/shared/mcp-transport`.
- `mcp-telemetry`: optional site-policy-gated telemetry helpers under `packages/shared/mcp-telemetry`.

## Classification And Recommended Posture

| Package | Classification | Telemetry Posture | Args/Results | Waits On | CL |
| --- | --- | --- | --- | --- | --- |
| `local-filesystem-mcp` | mutation-audited filesystem | errors_only initially; all for safe metadata later | no raw paths until path policy is explicit; path class/hash only | path redaction helper | 0.91 |
| `structured-command-mcp` | command/execution | errors_only | command id, catalog id, exit status only; no stdout/stderr/env | command redaction helper | 0.94 |
| `git-mcp` | mutation-audited publication | errors_only for mutations, all for status/show | repo-relative metadata only; no patch bodies by default | path/diff redaction helper | 0.90 |
| `completion-audit-mcp` | durable audit/evidence | errors_only | no requirement/evidence bodies | audit-boundary review | 0.82 |
| `site-inbox-mcp` | intake/triage mutation | errors_only | no message bodies; ids/status only | message redaction helper | 0.88 |
| `mailbox-mcp` | read-only mailbox projection | errors_only; all optional for operator debugging | no subject/body/sender by default; ids/counts only | message redaction helper | 0.92 |
| `graph-mail-mcp` | external-service audited mail draft lifecycle | errors_only for writes/refusals; all optional for reads | no body, recipients, upload URLs, attachment bytes, tokens | message/attachment redaction helper | 0.95 |
| `calendar-mcp` | external-service audited calendar lifecycle | implemented | no event body/attendees/raw Graph result | none | 0.99 |
| `task-lifecycle-mcp` | task lifecycle state machine | errors_only first | no task body/report bodies by default; ids/status/transitions only | task-domain redaction helper | 0.89 |
| `sonar-site-ops-mcp` | site operations | errors_only | operation/status only; no external output blobs | site-ops review | 0.82 |
| `agent-context-mcp` | startup/context hydration | errors_only; all for startup diagnostics where enabled | identity/status only; no context bodies | context redaction helper | 0.86 |
| `worker-delegation-mcp` | orchestration/runtime launch | errors_only | profile/run id/status only; no prompts/transcripts | worker redaction helper | 0.91 |
| `delegated-task-mcp` | outcome-oriented orchestration | errors_only | task/run ids/status only; no instructions/results bodies | delegated-task redaction helper | 0.90 |
| `sop-mcp` | SOP execution records | errors_only | SOP id/step status only; no step body/output by default | SOP redaction helper | 0.88 |
| `scheduler-mcp` | Windows scheduler mutation | errors_only | task name/status only; no command bodies/secrets | command redaction helper | 0.93 |
| `mcp-registrar` | config mutation registrar | errors_only | surface/site ids and action only; no full config dumps | config redaction helper | 0.92 |
| `surface-feedback-mcp` | feedback intake | errors_only | feedback ids/status only; no details text by default | feedback redaction helper | 0.88 |
| `launcher-mcp` | read-only launcher registry | all when enabled | launcher ids/options only | none | 0.96 |
| `runtime-introspection-mcp` | read-only runtime analysis | implemented | no raw trace args/results | none | 0.99 |
| `speech-mcp` | host speech/capture/external OpenAI | errors_only | no transcripts/audio paths by default; ids/status only | speech redaction helper | 0.91 |
| `cloudflare-carrier-mcp` | external-service operations/readiness | errors_only | carrier/session ids/status only; no tokens or remote bodies | carrier redaction helper | 0.90 |
| `site-coherence-mcp` | read-only coherence readback | all when enabled | status ids/counts only | none | 0.96 |
| `site-lifecycle-mcp` | site lifecycle planning/config mutation | errors_only | site ids/actions only; no full configs | config redaction helper | 0.89 |
| `operator-routing-mcp` | operator transcript routing | errors_only | route decision/status only; no transcript text by default | transcript redaction helper | 0.90 |
| `artifacts-mcp` | artifact registration/reference | errors_only | artifact refs/kinds/status only; no content | artifact redaction helper | 0.94 |
| `mcp-loader-mcp` | loader package present, not listed in AGENTS.md | classify before telemetry | unknown | package purpose review | 0.72 |

## Layout Cleanup

Target layout remains:

```text
packages/
  surfaces/
    <surface packages>
  shared/
    mcp-transport/
    mcp-telemetry/
```

Current state intentionally moved only shared libraries. Runnable surfaces still live at top-level `packages/*` to avoid mixing telemetry work with a broad path migration.

Remaining layout move:

- Move runnable surfaces from `packages/<surface>` to `packages/surfaces/<surface>`.
- Update workspace globs, root scripts, tsconfig references, package-local references, docs, and lockfile.
- Risk: high churn and conflict risk while many surface tasks are open. Defer until telemetry package shape is reviewed.

## High-Confidence Next Tasks

Create follow-up tasks for:

1. #1674 Graph-mail telemetry integration with strict mail/attachment redaction.
2. #1675 Structured-command telemetry integration with command/output redaction.
3. #1676 Launcher and site-coherence read-only telemetry integration.
4. #1677 Shared redaction preset helpers in `mcp-telemetry` before broad migration.
5. #1678 Investigate `mcp-loader-mcp` package purpose and AGENTS.md listing coherence.

Do not yet create broad migration tasks for every surface. Several domains need redaction helpers first, and the `packages/surfaces/*` layout move should happen as a separate mechanical refactor after current shared-package changes are stable.
