# @narada2/task-lifecycle-mcp

Task lifecycle MCP stdio runtime and tool dispatch surface.

This package exposes governed task lifecycle operations for Narada sites: task discovery, claiming, routing, evidence admission, finish/review/close flows, inbox bridge materialization, and selected test evidence capture.

## Boundary

- Allowed: mutate task lifecycle state through explicit lifecycle tools.
- Allowed: route, claim, continue, defer, reopen, review, finish, and close tasks under lifecycle rules.
- Allowed: admit task evidence and bridge inbox envelopes into task work.
- Not allowed: arbitrary filesystem, shell, Git, mailbox, or worker delegation behavior.
- Not allowed: bypassing lifecycle gates such as evidence admission, review findings disposition, or closure authority.

## Runtime

The stdio server binary is:

```text
task-lifecycle-mcp
```

It is launched against a site root and uses site-local task governance state and projections.

```powershell
pnpm --filter @narada2/task-lifecycle-mcp build
node packages/task-lifecycle-mcp/dist/src/task-lifecycle/task-mcp-server.js --site-root D:/code/site
```

## Tool Groups

Inspection and workboard:

- `task_lifecycle_doctor` returns a concise startup-safe readiness summary by default; pass `verbose=true` or `detail=full` for the full diagnostic dump.
- `task_lifecycle_list`
- `task_lifecycle_show`
- `task_lifecycle_roster`
- `task_lifecycle_next`
- `task_lifecycle_workboard_snapshot`
- `task_lifecycle_obligations`
- `task_lifecycle_inspect`
- `task_lifecycle_audit`
- `task_lifecycle_search`
- `task_lifecycle_related`

Assignment and routing:

- `task_lifecycle_roster_admit`
- `task_lifecycle_claim`
- `task_lifecycle_continue`
- `task_lifecycle_unclaim`
- `task_lifecycle_set_routing`

Evidence and closeout:

- `task_lifecycle_admit_evidence`
- `task_lifecycle_prove_criteria`
- `task_lifecycle_disposition_closeout`
- `task_lifecycle_finish`
- `task_lifecycle_close`
- `task_lifecycle_submit_observation`

Compatibility migration:

- `task_lifecycle_review` legacy review-call migration over dependency/outcome authority

Lifecycle mutation:

- `task_lifecycle_create`
- `task_lifecycle_defer`
- `task_lifecycle_reopen`

Inbox bridge:

- `task_lifecycle_bridge_poll`
- `task_lifecycle_inbox_target`

Verification helpers:

- `task_lifecycle_test_mcp_tool`
- `task_lifecycle_run_tests`

Transport helpers:

- payload tools from `@narada2/mcp-transport`

## Payload Refs

Some tools accept `payload_ref` for large structured companion payloads. `task_lifecycle_create` requires an immutable payload ref carrying the task definition. Payload transport is generic and comes from `@narada2/mcp-transport`; task lifecycle tools remain responsible for domain validation.

## Agent Guidance

Agents should call `task_lifecycle_next` for work selection, claim before doing task work when required, and use `task_lifecycle_finish` to submit work reports or complete outcome-contract tasks. Review work is represented as ordinary dependency work with a review outcome contract, so new review outcomes should be admitted with `task_lifecycle_finish` using `outcome`, `summary`, and `findings`. `task_lifecycle_review` remains compatibility migration for legacy callers. Closeout and closure can be blocked by evidence, unsatisfied dependencies, conflict-policy gates, or undisposed blocking outcomes; do not treat a successful tool call as authority to skip those gates.

## Verification

```powershell
pnpm --filter @narada2/task-lifecycle-mcp test
```
