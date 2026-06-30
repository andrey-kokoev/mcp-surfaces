# Task Lifecycle MCP Target Shape

This document defines the implementation target for simplifying review mechanics in `@narada2/task-lifecycle-mcp`.

## Target

There are no review mechanics.

There are task dependencies. Some dependency tasks require structured outcomes. Parent task closure reads dependency satisfaction. Conflict-of-interest is generic gating policy.

The reduced model is:

```text
Task A depends on Task B.
Task B has an outcome contract.
Task B records an admitted outcome.
Task A can close only when the dependency is satisfied.
```

Review is only a built-in outcome contract template:

```text
outcome_type: review
allowed_outcomes: accepted | accepted_with_notes | rejected
satisfying_outcomes: accepted | accepted_with_notes
blocking_outcomes: rejected
```

## Why

The current implementation has review-specific mechanics:

- `task_lifecycle_review`
- review rows and review verdict storage
- `in_review` as a special lifecycle posture
- `eligible_reviewers` special readback
- reviewer capability policy inside the review handler
- same-operator review annotation inside review handling
- blocking review finding disposition rules inside review handling

Those mechanics preserve important authority and closure truth, but they duplicate concepts that should be generic task lifecycle concepts: dependencies, outcomes, role/capability admission, conflict-of-interest policy, and evidence-gated closure.

The target is to preserve the guarantees while removing the special review subsystem.

## Authority Records

The implementation should make the authority locus explicit. Markdown may project these records, but Markdown is not the authority.

### `task_dependencies`

Declares that one task gates another task.

Required fields:

- `dependency_id`
- `parent_task_id`
- `required_task_id`
- `kind`
- `satisfying_outcomes`
- `status`
- `created_by`
- `created_at`

Target dependency kinds include:

- `review`
- `verification`
- `operator_decision`
- `downstream_work`

These are not separate lifecycle systems. They are labels on dependency records.

### `task_outcome_contracts`

Declares what outcome shape a task must produce to satisfy its own completion contract or a parent dependency.

Required fields:

- `contract_id`
- `task_id`
- `outcome_type`
- `allowed_outcomes`
- `satisfying_outcomes`
- `blocking_outcomes`
- `required_fields`
- `capability_requirement`

For review tasks:

```json
{
  "outcome_type": "review",
  "allowed_outcomes": ["accepted", "accepted_with_notes", "rejected"],
  "satisfying_outcomes": ["accepted", "accepted_with_notes"],
  "blocking_outcomes": ["rejected"],
  "required_fields": ["summary"],
  "capability_requirement": "review"
}
```

### `task_outcomes`

Records the admitted structured result of task work.

Required fields:

- `outcome_id`
- `task_id`
- `contract_id`
- `agent_id`
- `outcome`
- `summary`
- `findings`
- `evidence_refs`
- `admitted_at`

For ordinary implementation tasks, `outcome` may be `completed` or `blocked`. For review-contract tasks, `outcome` is one of `accepted`, `accepted_with_notes`, or `rejected`.

Parent closure reads `task_outcomes`; it does not infer acceptance from a claimed dependency task, Markdown text, or an unadmitted report.

### `task_dependency_satisfaction`

Records the evaluated state of a dependency.

Required fields:

- `dependency_id`
- `parent_task_id`
- `required_task_id`
- `required_outcome_id`
- `satisfied`
- `blocking_reason`
- `evaluated_at`

This can be materialized or computed, but readback must expose the same shape.

### `task_conflict_policy_evidence`

Records conflict-of-interest evaluation for any dependency task that gates another task.

Required fields:

- `dependency_id`
- `required_task_id`
- `agent_id`
- `effective_operator_identity`
- `gated_work_operator_identity`
- `conflict_detected`
- `policy_mode`
- `authorization_required`
- `authorization_basis`
- `annotation_recorded`

The policy checks effective operator identity, not only `agent_id`.

## Lifecycle Semantics

### Parent Tasks

A parent task with unsatisfied dependencies is not `in_review`. It is blocked by dependencies.

Target status/readback should use one of these approaches:

- keep lifecycle status `blocked` and report `blocked_by: dependencies`, or
- introduce `awaiting_dependencies` as a generic status.

Do not keep `in_review` as the authority state. If compatibility requires it temporarily, it must be a projection of dependency state, not the source of truth.

### Dependency Tasks

A dependency task is an ordinary task with extra metadata:

- `gates_task_id`
- `dependency_id`
- `dependency_kind`
- `outcome_contract`

It is claimed, finished, blocked, reopened, and closed through ordinary task lifecycle tools.

Do not introduce a second task class named `dependency_task`. In readback, use metadata such as `dependency_kind` and `gates_task_number` to explain why the task exists.

### Dependency Satisfaction

A dependency is satisfied when the required task has an admitted `task_outcome` matching the dependency's satisfying outcomes and all relevant conflict policy checks pass.

A required task does not need a separate ceremonial close step before its outcome can satisfy the parent, unless the outcome contract explicitly requires close-state evidence. This avoids adding new ceremony merely to replace review ceremony.

### Blocking Outcomes

A blocking outcome does not automatically create follow-up work. It requires disposition.

Disposition may be:

- create remediation task
- link covered-by-existing task
- route a directed obligation
- mark operator decision required
- defer with operator authority
- reject as out of scope with authority basis

This rule is generic. It applies to rejected reviews, failed verifications, failed audits, and other blocking dependency outcomes.

## Tool Shape

The internal authority model is generic dependency and outcome records. The ordinary agent experience must stay simpler:

```text
next -> claim task -> do work -> finish with the required outcome
```

Agents should not normally create raw dependency, outcome-contract, satisfaction, or conflict-policy records. Those records are emitted by task lifecycle tools and exposed through inspection/readback.

### Keep Generic Lifecycle Tools

Use normal task tools for all work:

- `task_lifecycle_create`
- `task_lifecycle_claim`
- `task_lifecycle_finish`
- `task_lifecycle_close`
- `task_lifecycle_next`
- `task_lifecycle_obligations`
- `task_lifecycle_show`
- `task_lifecycle_inspect`

`task_lifecycle_finish` must be able to admit a structured outcome when the task has an outcome contract.

### Add Or Generalize Dependency Tools

The lifecycle surface needs first-class dependency read/write tools or equivalent fields on existing tools.

Target capabilities:

- create a dependency from parent task to required task
- create a task with an outcome contract
- generate a review-contract task for a parent task
- list dependencies blocking a task
- inspect whether dependencies are satisfied
- route dependency tasks by role, capability, or explicit agent

If helper tools exist, they must still emit generic dependency records and ordinary task/outcome records.

Raw dependency and outcome-record tools, if exposed, are inspect/admin-level tools. They are not the normal agent workflow.

### Ergonomic Surface

Normal callers should have task-native operations over the generic model.

Target caller-facing actions:

- request review or another dependency for a parent task in one call
- claim a dependency task through the same claim tool as any other task
- finish an outcome-contract task through `task_lifecycle_finish`
- let `task_lifecycle_finish` infer required outcome shape from the task's contract
- receive precise remediation when an outcome, disposition, or conflict-policy requirement is missing

For a review-contract task, a finish call should be this simple:

```json
{
  "task_number": 456,
  "agent_id": "site.reviewer",
  "outcome": "accepted_with_notes",
  "summary": "Implementation satisfies the criteria; one non-blocking note remains.",
  "findings": []
}
```

The MCP should infer that `outcome` must be one of the task contract's allowed outcomes. Callers should not have to pass `contract_id`, `dependency_id`, or satisfying outcome lists in ordinary use.

Blocking outcomes must return a remediation menu with exact follow-up shapes. For example, a rejected review should return options to create a remediation task, link an existing task, request an operator decision, or defer with authority. It should not leave the agent to invent the disposition schema.

Conflict-of-interest failures must return:

- why the action is blocked
- the gated task and dependency involved
- the effective operator identities compared
- eligible alternative agents or roles when known
- whether operator override is allowed
- an exact next tool call shape when override is allowed

### Compound Work Submission

Current `task_lifecycle_submit_work` has a `reviewer` field for generated review obligation. In the target shape, that field should create or route a review-contract dependency task, not create review-native authority.

The helper must emit:

- parent task finish/report records
- dependency record when review is requested
- review-contract task record
- directed obligation or routing record for the reviewer

### Compatibility Tooling

`task_lifecycle_review` may remain temporarily, but it is not a simple shim. It is migration machinery.

If present, it must:

- find or create the dependency record for the reviewed parent task
- find or create the review-contract task
- admit a `task_outcome` on that review-contract task
- evaluate dependency satisfaction
- preserve historical readback for old clients

The durable authority must be the dependency task and its outcome, not a review row.

## Workboard Semantics

`task_lifecycle_next` should prefer work in this order:

1. active claimed work
2. directed dependency tasks assigned to the agent or role
3. claimable ordinary tasks

A dependency task appears as ordinary work with relationship metadata:

- `dependency_id`
- `dependency_kind`
- `gates_task_number`
- `outcome_type`
- `allowed_outcomes`
- `conflict_of_interest_risk`

Workboard recommendations must include ready-to-call guidance. A review-contract task recommendation should include:

```json
{
  "type": "task",
  "task_number": 456,
  "dependency_kind": "review",
  "gates_task_number": 123,
  "allowed_outcomes": ["accepted", "accepted_with_notes", "rejected"],
  "next_tool": "task_lifecycle_finish",
  "example_args": {
    "task_number": 456,
    "agent_id": "site.reviewer",
    "outcome": "accepted",
    "summary": "...",
    "findings": []
  }
}
```

There is no review-only eligible reviewer readback. Instead, task routing and outcome capability readback identify who can claim or complete the dependency task.

## Permissions

Authority for dependency work is ordinary task authority plus outcome capability.

Permission precedence:

1. site policy
2. outcome contract capability requirement
3. task routing or explicit assignee
4. roster capability admission
5. explicit operator authority basis when policy permits override

Roster role binding remains routing evidence, not a capability grant. Capability admission must stay separate and visible in policy readback.

An agent may claim or finish a review-contract task only if all applicable checks pass:

- task routing admits the agent's role or explicit agent id
- outcome contract capability requirement is satisfied or overridden with admitted authority
- conflict-of-interest policy is satisfied
- site policy does not require an independent operator or explicit operator acceptance

## Close Semantics

Parent task closure checks:

1. required evidence on the parent task
2. all required dependencies are satisfied
3. each dependency has an admitted acceptable outcome
4. conflict-of-interest policy is satisfied for every gating dependency
5. blocking outcomes have executable or explicitly deferred disposition

Closure must not infer acceptance merely because a dependency task exists, is claimed, is mentioned in Markdown, or has an unadmitted report.

## Migration

Migration should be staged.

1. Add generic dependency, outcome-contract, outcome, dependency-satisfaction, and conflict-policy records while keeping current review behavior.
2. Make `task_lifecycle_finish` able to complete outcome-contract tasks with structured outcomes.
3. Make `task_lifecycle_submit_work.reviewer` create review-contract dependency tasks instead of review-native obligations.
4. Make parent closure depend on dependency satisfaction instead of native review rows.
5. Teach `task_lifecycle_next`, `task_lifecycle_obligations`, `show`, and `inspect` to render dependency tasks ergonomically.
6. Convert `task_lifecycle_review` into migration machinery over dependency task mechanics.
7. Migrate existing review rows into dependency task outcome evidence where possible.
8. Remove review-native authority paths after compatibility coverage is no longer needed.

## Non-Goals

- Do not weaken closure authority.
- Do not make review a markdown-only convention.
- Do not collapse role binding and capability admission.
- Do not allow same-operator gating completion without explicit policy evidence.
- Do not hide dependency creation inside an unobservable helper.
- Do not introduce a second class of task under the name `dependency_task`.

## Acceptance Criteria For The Target Implementation

- A parent task can depend on another task.
- A dependency task can carry a review outcome contract.
- Ordinary agents can request a review/dependency without manually creating raw dependency or outcome-contract records.
- A dependency task is claimed, finished, blocked, reopened, and closed through ordinary task lifecycle tools.
- `task_lifecycle_finish` infers the required outcome shape from the task contract and accepts simple outcome arguments.
- A parent task cannot close until dependency satisfaction readback says all required dependencies are satisfied.
- A rejected review outcome blocks parent closure until it has executable or explicitly deferred disposition.
- Blocking outcome refusals return exact remediation options and example tool-call shapes.
- Conflict-of-interest refusals identify compared operator identities and provide eligible alternatives or override shape when policy allows it.
- Same-operator or self-review is handled by generic conflict-of-interest policy.
- Workboard and obligations show dependency tasks as normal directed work with parent/dependency context and ready-to-call next actions.
- `task_lifecycle_submit_work.reviewer` creates review-contract dependency work.
- `task_lifecycle_review`, if still present, is only migration machinery over dependency task mechanics.
