# @narada2/sop-mcp

Versioned standard operating procedure runbook engine with SQLite-backed templates, runs, and events.

## Purpose

Manages reusable procedural templates (versioned) and durable run execution. Steps flow through a dependency DAG: non-blocking engine steps auto-execute with command spawning and context handoff (`{{step_id.field}}`), SOP steps start child runs and wait for terminal status, while blocking agent/operator steps pause for confirmation.

## Tools

| Tool | Description |
|------|-------------|
| `sop_template_create` | Create a versioned SOP template with ordered steps |
| `sop_template_show` | Show a template by ID and optional version |
| `sop_template_export` | Export one template version with full recovery data |
| `sop_template_list` | List latest templates with status filter |
| `sop_template_search` | Search by title or description text |
| `sop_template_candidate_list` | List YAML template candidates in configured SOP dirs and classify their import state |
| `sop_template_candidate_show` | Show one YAML template candidate and its registry/import classification |
| `sop_template_update` | Update a template, creating a new version |
| `sop_template_deprecate` | Mark a template deprecated |
| `sop_template_unimport` | Remove an accidental registry import with no run references |
| `sop_template_import_yaml` | Import a YAML candidate into the durable template registry |
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

## Template Registry vs YAML Candidates

`sop_template_list`, `sop_template_show`, `sop_template_search`, and `sop_template_export` read the durable SOP template registry in SQLite. They report templates that have been imported or created as versioned registry records.

YAML files under configured `sops_dirs` are source candidates until imported. Use `sop_template_candidate_list` or `sop_template_candidate_show` to inspect those files without mutating the registry. Candidate tools classify files as `not_imported`, `imported_current`, `imported_changed`, `invalid_yaml`, or `shadowed`. Use `sop_template_import_yaml` to validate and import the selected candidate into the registry.

`sop_doctor` reports both registered template counts and YAML candidate counts so an empty registry is not confused with missing SOP files.

Use `sop_template_deprecate` when a real template should remain in history but no longer be selected for new runs. Use `sop_template_unimport` for accidental registry imports that have no SOP runs referencing the selected version. Unimport removes only the registry version, records an audit event, and never deletes YAML files.
