# @narada2/delegated-task-mcp

Outcome-oriented delegated task orchestration MCP surface.

Use this package when a caller wants to delegate a task outcome rather than manually manage individual worker runs. Low-level worker process/session control remains owned by `@narada2/worker-delegation-mcp`.

## Boundary

- Owns durable delegated task records, workflow plans, acceptance contracts, events, and final handoff packets.
- Accepts explicit workflow graphs/lists so orchestration can include implement, review, repair, research, fan-out, and join steps.
- Does not execute shell commands directly.
- Does not mutate repositories directly.
- Does not replace `worker-delegation-mcp`; it composes with that surface to launch constrained child worker runs and records their run IDs as task evidence.
- Does not own Narada domain workboards or task-lifecycle governance.

## Tools

- `delegated_task_policy_inspect`: inspect orchestration policy, defaults, allowed workflow kinds/profiles, condition language, and the composed worker policy.
- `delegated_task_template_catalog`: list built-in workflow templates, milestone objects, authority gates, and worker-delegation output contracts.
- `delegated_task_validate`: preflight a task request without creating or running it.
- `delegated_task_run`: create a durable delegated task from intent/objective, constraints, workflow, acceptance contract, result policy, and execution policy; by default it starts worker/review steps through `worker-delegation-mcp`.
- `delegated_task_status`: return compact lifecycle state for one task; `refresh=true` updates already-running workers and schedules any newly ready steps once.
- `delegated_task_advance`: explicitly refresh workers and schedule ready pending steps once.
- `delegated_task_wait`: wait on the delegated task handle while child worker runs advance.
- `delegated_tasks_list`: rediscover the current site's active delegated tasks by default; set `include_terminal=true` for terminal history rows and `site_scope=all_sites` or `site_scope=user_global` for shared/legacy queue projections.
- `delegated_task_result`: return the normalized handoff/result packet for one task.
- `delegated_task_summary`: return a compact human review handoff for one task.
- `delegated_task_events`: list durable task lifecycle events.
- `delegated_task_cancel`: mark a nonterminal delegated task cancelled.

## Quick Example

Minimal `delegated_task_run` payload with a single worker step:

```json
{
  "objective": "Fix typo in README",
  "constraints": {
    "cwd": "/home/user/project",
    "allowed_roots": ["/home/user/project"]
  },
  "workflow": {
    "steps": [
      {
        "id": "fix-typo",
        "kind": "worker",
        "instruction": "Fix the typo in README.md"
      }
    ]
  },
  "execution": {
    "wait_for_completion": true
  }
}
```

Invoke via `delegated_task_run` with the payload above to create and execute a single-step delegated task. Set `wait_for_completion` to `true` to block until the task reaches a terminal state.

## Runtime Contract

The MCP writes JSON task records under its configured task root. By default, the task root is the current working directory. Production site registration should pass a site-local runtime directory such as `.ai/runtime/delegated-task-mcp` and constrain it with allowed roots.

New task records carry `owner_site_id`, `owner_site_root`, `created_by_site_id`, `visibility_scope`, and `task_root_scope` when the current site can be resolved from options, environment, `.narada/site.json`, or the site-root directory name. `delegated_tasks_list` defaults to `view=active_queue` and `site_scope=current_site` when a current site is known, preventing active work from other sites in a shared physical store from leaking into the default queue. Shared views must be explicit with `site_scope=all_sites`; legacy records without ownership metadata are labeled `owner_site_id=unknown` and `visibility_scope=user_global_legacy` and appear in `site_scope=user_global` or `all_sites`, not silently under the current site. Cancel, acknowledge, and parent-takeover reject known cross-site records and legacy global records unless `allow_cross_site=true` is supplied; callers can also pass `expected_owner_site_id` to fail fast if the stored owner is not the intended site.

This surface is orchestration-state first and execution-capable. It does not run shell commands or mutate files itself; worker, review, repair, verify, and research steps are delegated through `worker-delegation-mcp` under the supplied mechanical constraints. Local gate, join, and note steps update orchestration state only.

Workflow state is durable in the task result. Steps move through `pending`, `running`, `completed`, `failed`, `skipped`, `blocked`, and `noted`; dependencies, richer string conditions, concurrency, retries, repair/review/quorum policy, and worker status refresh are handled at the task level. Active execution is represented by `current_run_id` and `progress.running_run_ids`; terminal or retryable history is preserved separately in `run_ids` and `progress.historical_run_ids`. Status, wait, list, and advance responses include `scheduler_state`; when `refresh=true` observes a dependency complete, it also schedules newly ready pending steps once so polling callers do not strand DAGs in `ready_pending_steps`. `delegated_task_advance` remains available for explicit one-shot advancement. Terminal, cancelled, completed, and failed task rows report `operator_posture.active=false`, no active run ids, and a terminal/history category so callers do not mistake history for running work. The consolidated task result records child worker `run_id`s in `worker_refs` by default. A caller may set `result_policy.expose_worker_refs` to `false` to hide detailed refs from compact result views, while `max_worker_refs`, `max_result_items`, and event limits keep large workflow handoffs bounded. Diagnostics still expose accountability evidence.

Workflow templates can be addressed by `workflow.template_id`, `workflow.strategy`, or legacy `workflow.template`. The built-in catalog includes milestone objects (`milestones[]` with `id`, `title`, `depends_on`, `step_ids`, and `acceptance_scope`) and step-level `milestone_id` so callers can preview and report progress at a coarser level than individual worker runs.

`workflow.work_order` supports three orchestration shapes. A legacy array is still accepted as a step-list alias when `workflow.steps` is omitted. A first-class object is treated as a governing contract layered over explicit `workflow.steps`; it can carry `scope`, `budget`, `verification.required_tests`, `verification.focused_tests`, `verification.verification_budget`, and `acceptance` without conflicting with the execution DAG. Work-order verification and acceptance fields are normalized into the task acceptance contract and echoed in validation previews and result diagnostics.

For declarative orchestration, `workflow.work_order.items` plus `workflow.work_order.stages` expands into ordinary explicit DAG steps before validation and persistence. A stage with `mode: "map"` or `map: true` creates one step per item, supports `{{item.id}}`, `{{item.value}}`, and `{{item.<field>}}` template replacement in `instruction` and `write_set`, and can add a local join with `join: true` or `join: { "id": "..." }`. Later stages can depend on a stage id; if the prior stage had a join, the dependency resolves to the join step. This models shapes such as `items -> map research(item) -> join -> synthesize -> map execute(item) -> join -> review` while preserving the underlying explicit DAG. Runtime synthesis-derived node creation is intentionally not implicit; callers should pass the derived item set/stages explicitly in the request so validation can inspect the final graph before workers launch.

When `workflow.work_order.stage_policy.execution.schedule_by_disjoint_write_set` is true, worker steps with overlapping `write_set` entries are not launched concurrently. Overlap is path/resource-prefix based (`src` conflicts with `src/main.ts`; distinct paths do not conflict). `scheduler_state.write_set_conflicts` reports pending steps currently waiting for a running step's write set, and `graph_execution_synthesis.derived_topology` reports the expanded topology and write-set metadata in result views.

Commit and push are modeled as explicit authority gates, not executed by this surface. `workflow.authority_gates` and step-level `authority_gate` can declare `commit` or `push` with `mode`, `required_authority`, and `reason`; validation rejects natural-language commit requests without write authority and push requests without command authority. Actual git inspection/publication remains owned by the git and worker surfaces under caller policy.

The template catalog carries the routed worker-delegation schema contract for child worker outputs: workers should return summaries, changes, verification, residual risks, and observed incoherencies. `delegated-task-mcp` records those as evidence but does not become a worker runtime or shell.

Large sections are compacted by default and materialized as task-local output references under the configured task root. Default results include counts, truncation flags, and output ref metadata so callers can page into full `worker_refs`, verification, changed files, residual risks, or incoherencies when needed.

Conditions are parsed as a small expression language, not arbitrary code: `always`, `on_success`, `on_failure`, `review_failed`, `acceptance:<verdict>`, `step:<step_id>:<status>`, `kind:<kind>:<status>`, `result_has:<text>`, `no_residual_risks`, and nested `all(...)`, `any(...)`, `not(...)`. Malformed calls are rejected by `delegated_task_validate` before workers launch.

Acceptance checks are evidence checks. `delegated-task-mcp` does not run tests or tools directly; worker outputs must provide verification evidence for required tests/tools. Required files are checked read-only under the constrained cwd. Required file checks pass when the file exists and any requested `contains` text is present; required test/tool checks pass only when worker evidence reports the requested command/tool with `passed` status; focused tests use the same evidence semantics while marking the evidence as `focused_test`; missing evidence is pending; explicit failed evidence fails. `verification_budget` records a budget check against verification evidence count. `residual_risk_policy: none_allowed` fails acceptance when residual risks remain.

Cancellation marks the delegated task cancelled and annotates running child worker refs with a cancellation request. Site ownership guards prevent accidental foreign-site or legacy-global destructive updates by default. It does not yet terminate the underlying worker process; low-level worker cancellation remains a separate worker-delegation capability when supported.

The live worker integration test is separate from deterministic tests. It skips with a diagnostic when the local Codex runtime is unavailable, and passes when a real worker can be launched through `worker-delegation-mcp`.

## Condition Language

Step transitions and gate conditions use a small expression language (not arbitrary code). Malformed expressions are rejected by `delegated_task_validate` before workers launch.

| Condition | Description |
|---|---|
| `always` | Always true; unconditional transition. |
| `on_success` | True when the referenced step completed successfully. |
| `on_failure` | True when the referenced step failed. |
| `review_failed` | True when a review step returned a failing verdict. |
| `acceptance:<verdict>` | True when the acceptance check produced the given verdict (e.g. `passed`, `failed`, `pending`). |
| `step:<id>:<status>` | True when step `<id>` has status `<status>` (e.g. `step:fix-typo:completed`). |
| `kind:<kind>:<status>` | True when all steps of kind `<kind>` have status `<status>` (e.g. `kind:worker:completed`). |
| `result_has:<text>` | True when the referenced step result contains `<text>`. |
| `no_residual_risks` | True when no residual risks remain in the task evidence. |
| `all(...)` | True when all nested conditions are true. |
| `any(...)` | True when at least one nested condition is true. |
| `not(...)` | True when the nested condition is false. |

## Workflow Steps

| Kind | Description |
|---|---|
| `worker` | Execute an implementation step via a child worker run. |
| `review` | Review outputs of preceding steps via a child worker run. |
| `repair` | Repair or fix issues found by review via a child worker run. |
| `verify` | Verify outputs or repairs via a child worker run. |
| `research` | Research or investigate via a child worker run. |
| `gate` | Orchestration-only conditional: evaluate conditions and branch locally. |
| `join` | Orchestration-only merge: wait for multiple preceding steps to converge locally. |
| `note` | Orchestration-only annotation: record a note in the task event log locally. |

## Verification

```powershell
pnpm --filter @narada2/delegated-task-mcp test
pnpm --filter @narada2/delegated-task-mcp test:live
```
