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
- `delegated_task_validate`: preflight a task request without creating or running it.
- `delegated_task_run`: create a durable delegated task from intent/objective, constraints, workflow, acceptance contract, result policy, and execution policy; by default it starts worker/review steps through `worker-delegation-mcp`.
- `delegated_task_status`: return compact lifecycle state for one task.
- `delegated_task_wait`: wait on the delegated task handle while child worker runs advance.
- `delegated_tasks_list`: rediscover active or terminal delegated tasks.
- `delegated_task_result`: return the normalized handoff/result packet for one task.
- `delegated_task_summary`: return a compact human review handoff for one task.
- `delegated_task_events`: list durable task lifecycle events.
- `delegated_task_cancel`: mark a nonterminal delegated task cancelled.

## Runtime Contract

The MCP writes JSON task records under its configured task root. By default, the task root is the current working directory. Production site registration should pass a site-local runtime directory such as `.ai/runtime/delegated-task-mcp` and constrain it with allowed roots.

This surface is orchestration-state first and execution-capable. It does not run shell commands or mutate files itself; worker, review, repair, verify, and research steps are delegated through `worker-delegation-mcp` under the supplied mechanical constraints. Local gate, join, and note steps update orchestration state only.

Workflow state is durable in the task result. Steps move through `pending`, `running`, `completed`, `failed`, `skipped`, `blocked`, and `noted`; dependencies, richer string conditions, concurrency, retries, repair/review/quorum policy, and worker status refresh are handled at the task level. The consolidated task result records child worker `run_id`s in `worker_refs` by default. A caller may set `result_policy.expose_worker_refs` to `false` to hide detailed refs from compact result views, while `max_worker_refs`, `max_result_items`, and event limits keep large workflow handoffs bounded. Diagnostics still expose accountability evidence.

Large sections are compacted by default and materialized as task-local output references under the configured task root. Default results include counts, truncation flags, and output ref metadata so callers can page into full `worker_refs`, verification, changed files, residual risks, or incoherencies when needed.

Acceptance checks are evidence checks. `delegated-task-mcp` does not run tests or tools directly; worker outputs must provide verification evidence for required tests/tools. Required files are checked read-only under the constrained cwd.

The live worker integration test is separate from deterministic tests. It skips with a diagnostic when the local Codex runtime is unavailable, and passes when a real worker can be launched through `worker-delegation-mcp`.

## Verification

```powershell
pnpm --filter @narada2/delegated-task-mcp test
pnpm --filter @narada2/delegated-task-mcp test:live
```
