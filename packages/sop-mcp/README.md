# `@narada2/sop-mcp`

SQLite-backed execution of versioned, parameterized procedure occurrences.

## Ownership

An SOP run is one unit of procedural work. SOP MCP owns its pinned definition, input/output envelope, dependency and condition state, child/action handoffs, and automatic reconciliation.

It does not own activation or domain effects:

- Scheduler and durable event consumers decide when to call `sop_run_start`, including event fan-out into one occurrence per durable event.
- Domain MCP surfaces authorize and perform effects.
- Worker/delegation surfaces own worker execution, leases, and liveness.
- `engine` steps are pure internal transitions. SOP MCP does not spawn commands or provide shell, filesystem, task, mail, or other domain mutation paths.

## Occurrence contract

`sop_run_start` requires a stable `occurrence_key`. The key is unique within one `sop_id`:

- an exact retry returns the existing run;
- a different request under the same key is refused;
- the selected SOP version and executable definition fingerprint are persisted;
- child versions omitted by the template are resolved and pinned when the parent occurrence is admitted.

Inputs and results use a bounded inline object plus an optional immutable reference:

```json
{
  "ref": "artifact:owner/object",
  "sha256": "<64 hex characters>",
  "byte_length": 1234,
  "media_type": "application/json"
}
```

Inline values are capped at 16 KiB and aggregate run step state at 128 KiB. Large evidence remains with its owning surface and crosses the SOP boundary only as a digest-pinned reference plus a bounded summary.

## Steps

| Executor | Meaning |
|---|---|
| `engine` | Pure, immediate internal transition |
| `agent` | Durable agent handoff completed with `sop_run_advance` |
| `operator` | Durable human handoff completed with `sop_run_advance` |
| `sop` | Idempotently admitted child SOP occurrence at a pinned version |
| `action` | Durable intent for one named domain MCP tool |

Dependencies form a validated acyclic graph. A failed predecessor fails dependents. A skipped predecessor is settled, so downstream joins can continue; use a downstream `when` predicate on `steps.<id>.status` when that branch must also be skipped. Eligible steps may use deterministic `equals`, `not_equals`, `exists`, `not_exists`, `truthy`, `falsy`, `in`, or `contains` predicates, composed with `all`, `any`, and `not`.

Mappings use exact `$ref` objects, for example:

```yaml
arguments:
  source_message_id: { $ref: input.message_id }
output:
  ticket_id: { $ref: steps.create_ticket.result.ticket_id }
```

A step may read only `input`, `input_ref`, and dependency-ancestor step state. Output mappings may read any step.

## Governed actions

An action step names `surface_id`, `tool_name`, mapped `arguments`, and `idempotency_key_argument`. When eligible, SOP atomically persists one action intent and injects a stable occurrence key into that reserved target argument.

The dispatcher workflow is:

1. `sop_action_list` finds pending summaries.
2. `sop_action_show` returns the exact persisted target and arguments.
3. The dispatcher calls the owning domain MCP tool with those arguments.
4. `sop_action_resolve` records the domain operation reference and bounded result/reference.

Exact action-resolution retries are idempotent. Conflicting retries are refused. The external operation receipt commits before downstream reconciliation, so a later definition/state fault cannot erase an acknowledged effect. Cancelling a run suppresses a still-pending action, but a late domain receipt remains admissible and auditable. SOP never invokes the domain effect itself; the target’s injected idempotency key closes the external retry window.

Persisted action identity, target arguments, and completion receipts are fingerprint-verified whenever they are read. If retaining an otherwise valid inline action result would exceed the aggregate run-state bound, the action receipt and full action record remain durable while the SOP step fails with a compact `inline_result_omitted` diagnostic; `sop_action_show` remains the authoritative result readback.

Child and manual completion reconcile the run and all ancestors transactionally. Action resolution first durably records the domain receipt, then automatically reconciles in a separate transaction so receipt durability does not depend on downstream state validity. `sop_run_refresh` remains an explicit repair/readback tool, not a normal continuation requirement.

`result_schema` describes successful handoff output. A failed agent/operator handoff records its bounded diagnostic result and `error_message` without requiring that failure payload to satisfy the success schema.

## Tool groups

- Templates: `sop_template_create`, `sop_template_show`, `sop_template_export`, `sop_template_list`, `sop_template_search`, `sop_template_candidate_list`, `sop_template_candidate_show`, `sop_template_update`, `sop_template_deprecate`, `sop_template_unimport`, `sop_template_import_yaml`
- Runs: `sop_run_start`, `sop_run_status`, `sop_run_refresh`, `sop_run_advance`, `sop_run_list`, `sop_run_coverage_since`, `sop_run_cancel`, `sop_run_events`
- Actions: `sop_action_list`, `sop_action_show`, `sop_action_resolve`
- Orientation: `sop_guidance`, `sop_doctor`

## Verification

```powershell
pnpm --filter @narada2/sop-mcp test
```

The package E2E restarts the MCP process with an action pending, proves only one intent exists, resolves it, restarts again, and proves terminal state plus exact resolution replay.
