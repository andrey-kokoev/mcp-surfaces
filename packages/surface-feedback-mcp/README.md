# @narada2/surface-feedback-mcp

Cross-site MCP surface feedback intake and routing. Any site may submit feedback about any surface — bugs, improvements, gaps, observations.

## Purpose

Provides a single durable feedback channel for MCP surfaces. Agents across all Narada sites can report surface issues without needing to know which site owns the surface. SQLite-backed for durability.

## Tools

| Tool | Description |
|------|-------------|
| `surface_feedback_submit` | Submit feedback (surface, declared submitter site, principal, kind, summary, details) |
| `surface_feedback_convert_to_task` | Create and link one visible feedback entry through task-lifecycle; returns the next lifecycle action but does not execute the task |
| `surface_feedback_list` | List entries with an explicit read scope and bounded metadata filters |
| `surface_feedback_actionable_queue` | Read the bounded actionable queue with an explicit read scope |
| `surface_feedback_show` | Show one entry by ID within an explicit read scope |
| `surface_feedback_stats` | Aggregate visible entries within an explicit read scope |

## Read scopes

Every list, queue, show, and stats call must provide `scope` explicitly:

| Scope | Meaning | Required server posture |
|------|---------|-------------------------|
| `all_authorized` | Canonical cross-site feedback view | `feedback_root` must equal `canonical_feedback_root` and server-bound Site authority must be configured |
| `authority_visible` | Entries whose declared submitter site matches the bound Site or that are attached to its owned surfaces | Server-bound Site authority |
| `owned_surfaces` | Entries for surfaces owned by the bound Site | Server-bound Site authority and owned surface IDs |
| `authority_site_submissions` | Entries whose declared `submitter_site_id` matches the bound Site | Server-bound Site authority |

`submitter_site_id_filter` is an optional metadata filter for list and queue. It does not authenticate the submitter, establish provenance, or expand authorization. The submitter site recorded in a feedback entry remains declarative submission metadata.

The canonical User Site projection should pass `--feedback-root`, `--canonical-feedback-root`, `--site-id`, and repeated `--owned-surface-id` arguments explicitly. Do not rely on the current directory or an ambient caller-supplied site filter. A scoped show of an entry outside the scope returns `feedback_not_found` so existence is not disclosed.

`surface_feedback_convert_to_task` is idempotent per feedback entry. It uses an isolated task-lifecycle stdio process and a durable handoff ledger. The ledger preserves payload and task references across failures, excludes concurrent conversion with a lease, and links feedback only after successful task creation. Retry the same conversion after a retryable failure; it resumes from the last durable stage.

Mutation authority and audit identity are server-bound. Configure the serving Site with `--site-id` or `NARADA_SITE_ID`, optionally set `NARADA_AGENT_ID` for the audit principal, and optionally repeat `--owned-surface-id` or set `NARADA_OWNED_SURFACE_IDS` for surfaces maintained by that Site. Without an explicit agent identity, the service principal is `surface-feedback@<site-id>`. Caller-supplied authority fields are rejected; legacy `resolved_by` fields are ignored.

Task lifecycle root resolution is, in order: `--task-lifecycle-root`, `NARADA_TASK_LIFECYCLE_ROOT`, `NARADA_SITE_ROOT`, then the feedback root. The selected path must be a Site root containing `.ai`; `surface_feedback_doctor` reports static configuration validity separately from observed child health. Health starts `unverified`, becomes `healthy` after a valid lifecycle response, and becomes `unhealthy` after transport/startup failure. Prefer explicit configuration when feedback storage and task lifecycle belong to different roots.

`surface_feedback_show` includes first-class `audit_events` and the current `task_handoff`, including retry diagnostics and durable task linkage state.

## Kinds

- `bug` — something is broken
- `improvement` — enhancement request
- `gap` — missing capability
- `observation` — general observation

## Quick Start

```
pnpm --filter @narada2/surface-feedback-mcp test
```
