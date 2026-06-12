# @narada2/sop-mcp

Versioned standard operating procedure runbook engine with SQLite-backed templates, runs, and events.

## Purpose

Manages reusable procedural templates (versioned) and durable run execution. Steps flow through a dependency DAG — non-blocking engine steps auto-execute with command spawning and context handoff (`{{step_id.field}}`), while blocking agent/operator steps pause for confirmation.

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

- **executor**: `engine` (auto), `agent` (programmatic), `operator` (human)
- **blocking**: `true` (pauses run, awaits `sop_run_advance`), `false` (auto-advances)

Engine steps with `command` + `args` spawn actual subprocesses. Context handoff via `{{step_id.field}}` interpolation in instructions, commands, and arguments.

## Quick Start

```
pnpm --filter @narada2/sop-mcp test
```
