# @narada2/surface-feedback-mcp

Cross-site MCP surface feedback intake and routing. Any site may submit feedback about any surface — bugs, improvements, gaps, observations.

## Purpose

Provides a single durable feedback channel for MCP surfaces. Agents across all Narada sites can report surface issues without needing knowledge of which site owns the surface. SQLite-backed for durability.

## Tools

| Tool | Description |
|------|-------------|
| `surface_feedback_submit` | Submit feedback (surface_id, site, principal, kind, summary, details) |
| `surface_feedback_convert_to_task` | Create and link one visible feedback entry through task-lifecycle; returns the next lifecycle action but does not execute the task |
| `surface_feedback_list` | List entries with filters by surface, site, kind, status |
| `surface_feedback_show` | Show one entry by ID |

`surface_feedback_convert_to_task` is idempotent per feedback entry. It uses an isolated task-lifecycle stdio process and a durable handoff ledger. The ledger preserves payload and task references across failures, excludes concurrent conversion with a lease, and links feedback only after successful task creation. Retry the same conversion after a retryable failure; it resumes from the last durable stage.

Mutation authority is server-bound. Configure the serving Site with `--site-id` or `NARADA_SITE_ID`, and optionally repeat `--owned-surface-id` or set `NARADA_OWNED_SURFACE_IDS` for surfaces maintained by that Site. Caller-supplied authority fields are rejected by mutation tools.

Task lifecycle root resolution is, in order: `--task-lifecycle-root`, `NARADA_TASK_LIFECYCLE_ROOT`, `NARADA_SITE_ROOT`, then the feedback root. The selected path must be a Site root containing `.ai`; `surface_feedback_doctor` reports the resolved path, source, readiness, and authority posture. Prefer explicit configuration when feedback storage and task lifecycle belong to different roots.

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
