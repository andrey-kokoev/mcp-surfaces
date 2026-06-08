# Delegated Task MCP Target Shape

## Purpose

`@narada2/delegated-task-mcp` provides a higher-level delegation surface than `worker-delegation-mcp`.

A caller should be able to ask for an outcome, provide mechanical constraints and an acceptance contract, and receive a durable task handle. The caller should not need to manage worker run IDs, reviewer fan-out, repair loops, or internal implementation choices unless it explicitly asks for diagnostic detail.

## Core Distinction

### Worker Run

Owned by `worker-delegation-mcp`.

A worker run is one constrained worker process/session. It answers:

- What worker was launched?
- What cwd/profile/model/authority constrained it?
- Is it running or complete?
- What raw output did it produce?
- Can it be resumed?

### Delegated Task

Owned by `delegated-task-mcp`.

A delegated task is one outcome-level unit of work. It answers:

- What outcome was delegated?
- What constraints govern the task as a whole?
- What workflow plan should execute it?
- What acceptance contract defines done?
- What happened during orchestration?
- What is the final normalized handoff?

## First-Class Objects

### DelegatedTask

Durable record with:

- `task_id`
- `objective`
- `status`
- `constraints`
- `workflow`
- `acceptance`
- `result_policy`
- `execution`
- `created_at`
- `updated_at`
- `cancelled_at`
- `summary`
- `result`

### WorkflowPlan

Explicit graph/list of steps. It is data, not hidden prompt convention.

Step fields:

- `id`
- `kind`: `worker`, `review`, `repair`, `verify`, `research`, `gate`, `join`, `note`
- `profile`
- `instruction`
- `depends_on`
- `if`
- `acceptance_scope`

Step state is durable and explicit:

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`
- `blocked`
- `noted`

Known useful strategies should be expressible as workflow data:

- implement only
- implement then review
- implement, review, repair
- parallel research, synthesis, implementation
- fan-out reviewers with join gate

The workflow engine owns dependency resolution, simple conditional execution, max concurrency, retry scheduling, worker status refresh, and local join/gate/note steps. Worker execution remains delegated to `worker-delegation-mcp`.

Conditions are explicit strings, not arbitrary code. Supported forms include `always`, `on_success`, `on_failure`, `review_failed`, `acceptance:<verdict>`, `step:<id>:<status>`, `kind:<kind>:<status>`, `result_has:<text>`, `no_residual_risks`, and nested `all(...)`, `any(...)`, `not(...)`.

### AcceptanceContract

Defines what done means.

Fields should allow:

- required files
- required tests or verification commands
- required surfaced tools or API names
- forbidden behavior/patterns
- review questions
- reviewer quorum
- residual-risk policy

The contract is not expected to prove everything mechanically, but it must provide a stable review target.

### HandoffPacket

Normalized result from task execution:

- changed files
- verification evidence
- acceptance verdict
- residual risks
- observed incoherencies
- worker run references as accountability evidence, redacted from compact views only when result policy explicitly asks for that
- final summary
- bounded compact views for large workflows

## Public Tool Shape

### delegated_task_policy_inspect

Return delegated task policy and defaults.

Output:

- task root and allowed roots
- allowed workflow kinds and profiles
- execution defaults
- result policy defaults and compaction limits
- condition language
- composed worker policy

### delegated_task_validate

Preflight a delegated task request without creating a task or launching workers.

Validation covers:

- workflow graph shape
- duplicate/unknown step ids
- dependency cycles
- unsupported conditions
- policy-disallowed workflow kinds or profiles
- repair policy references
- acceptance contract shape

Output:

- `ok` or `rejected`
- diagnostics with codes and policy context
- expanded workflow preview

### delegated_task_run

Create a task, optionally start its workflow, and return a task handle.

Inputs:

- `objective` string or `intent.objective`, required for new tasks
- `intent` object, optional
- `constraints` object, optional
- `workflow` object, optional but preferred
- `acceptance` object, optional but preferred
- `result_policy` object, optional
- `execution` object, optional
- `idempotency_key` string, optional

Output:

- task id
- status
- created path
- compact summary
- child worker run IDs when workflow execution starts

### delegated_task_status

Return compact task status.

Inputs:

- `task_id`

Output:

- status
- objective
- step counts
- step status counts
- compact progress summary
- acceptance verdict if available
- updated timestamp

### delegated_task_wait

Wait on the delegated task handle rather than individual worker runs.

Inputs:

- `task_id`
- optional `timeout_ms`
- optional `poll_ms`
- optional `include_diagnostics`

Output:

- wait status
- task status
- progress summary
- normalized result view

### delegated_tasks_list

Rediscover active or terminal delegated tasks.

Inputs:

- optional `limit`
- optional `include_terminal`
- optional `include_active`

Output:

- compact task records
- task status
- progress summary
- acceptance verdict

### delegated_task_result

Return normalized result/handoff packet.

Inputs:

- `task_id`
- optional `include_diagnostics`

Output:

- objective
- status
- result packet
- workflow summary
- acceptance summary
- compaction counts and output refs when large sections are truncated

### delegated_task_summary

Return a compact human review handoff.

Output:

- final summary
- changed files
- verification count
- residual risks
- observed incoherencies
- child evidence refs

### delegated_task_events

List task lifecycle events.

Inputs:

- `task_id`
- optional `limit`
- optional `offset`

Output:

- events
- pagination metadata

### delegated_task_cancel

Mark a nonterminal task as cancelled.

Inputs:

- `task_id`
- optional `reason`

Output:

- cancelled status and event

## Non-Goals

- Direct shell execution.
- Direct file mutation.
- Direct git publication.
- Owning Narada workboard/task-lifecycle domain semantics.
- Hiding final evidence from the caller.
- Replacing low-level worker debugging tools.

## Coherence Rule

`delegated-task-mcp` may hide internal orchestration by default, but it must not hide accountability. Final status must expose enough evidence to support acceptance or rejection.
