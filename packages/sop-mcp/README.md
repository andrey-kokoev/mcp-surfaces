# @narada2/sop-mcp

Versioned standard operating procedure runbook engine with SQLite-backed templates, runs, and events.

## Purpose

Manages reusable procedural templates (versioned) and durable run execution. Steps flow through a dependency DAG: non-blocking engine steps auto-execute with command spawning and context handoff (`{{step_id.field}}`), SOP steps start child runs and wait for terminal status, while blocking agent/operator steps pause for confirmation.

## Tools

| Tool | Description |
|------|-------------|
| `sop_template_create` | Create a versioned SOP template with ordered steps |
| `sop_template_show` | Show a template by ID and optional version |
| `sop_template_list` | List latest templates with status filter |
| `sop_template_search` | Search by title or description text |
| `sop_template_update` | Update a template, creating a new version |
| `sop_template_deprecate` | Mark a template deprecated |
| `sop_run_start` | Start a run from the latest active template version |
| `sop_run_status` | Check run status with per-step state and `next_step` projection |
| `sop_run_advance` | Complete a blocking step and auto-advance dependents |
| `sop_run_list` | List runs with filters |
| `sop_run_cancel` | Cancel a running run |
| `sop_run_events` | Read the append-only event audit trail |

## Step Model

Two dimensions, independent:

- **executor**: `engine` (auto), `agent` (programmatic), `operator` (human), `sop` (child SOP run)
- **blocking**: `true` (pauses run, awaits `sop_run_advance`), `false` (auto-advances)

Engine steps with `command` + `args` spawn actual subprocesses. Context handoff via `{{step_id.field}}` interpolation in instructions, commands, and arguments.

SOP steps use `executor: sop`, `sop_id`, optional `sop_version`, and `wait_policy: wait`. When dependencies are complete the parent run creates a child SOP run, records `child_run_id` on the parent step, and keeps the step running until the child is `completed`, `failed`, or `cancelled`. Child completion completes the parent step; child failure or cancellation fails it and prevents dependent work from continuing successfully. `sop_run_status` and `sop_run_events` expose the parent-child relationship for recovery.

## Quick Start

```
pnpm --filter @narada2/sop-mcp test
```
