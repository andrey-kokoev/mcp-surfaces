# @narada2/site-loop-mcp

Config-governed Site Loop MCP runtime and site operating-loop tools.

Site Loop behavior is generic. Site-specific identity, resident target, refs, command strings, policy defaults, docs, and approved test selectors belong in config, not hardcoded adapter code.

The config file path is:

```text
.narada/capabilities/site-loop-config.json
```

When the file is absent, doctor/readback reports `status: "missing"` with a neutral generic template, but active site-loop tools refuse to run. Production sites must provide this file explicitly so site identity, resident target, refs, policy, docs, and tests are site-owned config.

The canonical JSON Schema is published at:

```text
schemas/site-loop-config.schema.json
```

The runtime validator uses the same schema, then applies semantic checks that JSON Schema cannot express cleanly, such as safe relative paths and Narada schema-name conventions.

Minimal valid config:

```json
{
  "schema": "narada.site_loop.config.v1",
  "loop_id": "example.loop",
  "site_id": "narada-example",
  "display_name": "Example loop",
  "resident": {
    "agent_id": "example.resident",
    "role": "resident"
  },
  "refs": {
    "ticket_projection": {
      "kind": "ticket_projection",
      "ref": "example"
    }
  }
}
```

## Boundary

- Allowed: inspect configured Site Loop readiness and allowlisted docs/tests.
- Allowed: run approved local test selectors.
- Allowed: inspect and control the configured Site Operating Loop.
- Allowed: run one bounded site-loop pass.
- Not allowed: arbitrary shell commands.
- Not allowed: general task lifecycle mutation outside the explicit site-loop/task dispatch behavior.
- Not allowed: mailbox reading or Graph draft operations; those belong to `mailbox-mcp` and `graph-mail-mcp`.

## Tools

General Site Loop:

- `site_loop_guidance`
- `site_loop_doctor`
- `site_loop_config_validate`
- `site_docs_list`
- `site_docs_show`
- `site_test_list`
- `site_test_run`

Compatibility aliases retained for existing callers:


Configured site loop:

- `site_loop_status`
- `site_loop_health`
- `site_loop_operating_status`
- `site_loop_readiness`
- `site_loop_coherence`
- `site_loop_runs_list`
- `site_loop_run_show`
- `site_loop_attention_list`
- `site_loop_attention_show`
- `site_loop_attention_ack`
- `site_loop_control_set`
- `site_loop_run_once`

## Site Loop Notes

`site_loop_run_once` runs a bounded configured site loop pass. It can request configured `source_sync`, bridge inbox envelopes to task lifecycle work, reconcile configured ticket projection refs, reconcile pending Task Executability Assessment requests, and dispatch configured resident directives through the site loop logic. Source sync delegates to the configured command; this package does not itself implement mailbox sync.

The `task_executability_reconciliation` phase is a recovery coordinator, not a second authority. Task Lifecycle owns request, lease, attempt, and assessment state; the Site Loop only leases a bounded batch and invokes the shared task-executability orchestrator. The phase is capped at ten requests per pass, reclaims expired leases after restart, and uses the same Task Lifecycle database as the other task phases. Its result is `deferred` with warning attention when the store/orchestrator binding is absent, `ok` when work is idle/progressing without execution failures, and `attention` when bounded evaluator/delegation failures require review. It never turns evaluator execution failure into a task verdict and never hardcodes a provider or model.

The target shape is “just config”: if site behavior differs, express it in `site-loop-config.json`. If behavior cannot be expressed there, add a generic config primitive or delegate to an existing MCP/tool command that is itself referenced by config. Do not add a new site-specific adapter branch.

Core config fields:

- `loop_id`, `site_id`, `display_name`
- `resident.agent_id`, `resident.role`, required resident task tools
- `refs.ticket_projection`
- `schemas` for result packet names
- `commands` for source sync, ticket reconciliation, status/readiness/proof operator hints
- `policy` carrier admission and attention defaults
- `mailbox_proof` schema and freshness window
- `docs` and `tests` allowlists

Configured executable commands use an explicit `execution: "direct_spawn"` mode. The surface accepts argv-shaped command config only for the bounded source-sync and ticket-reconciliation slots; it rejects shell-string execution modes. Broader command execution remains owned by the structured-command surface.

Readiness/coherence tools report whether operating prerequisites are satisfied, including optional mailbox-chain proof checks when requested.

## Run

```powershell
pnpm --filter @narada2/site-loop-mcp build
site-loop-mcp --site-root D:/code/site
```

## Agent Guidance

Agents should use the docs and test selector tools instead of shelling out. Loop control mutations should include a reason and principal. Use `site_loop_run_once` for bounded operation, not as a general-purpose automation shell. When behavior looks site-specific, inspect `site_loop_doctor.site_loop_config` and the site config file before assuming the package owns that behavior.

See `docs/site-loop-doctrine.md` at the repository root for the doctrine,
surface-boundary contract, and target `test_authority` shape for full non-dry
e2e tests.

## Task Executability Proof

The deterministic cross-surface proof is the Site Loop closure gate:

```powershell
pnpm --filter @narada2/site-loop-mcp test:e2e:task-executability
```

It uses the real Task Lifecycle MCP child and the production NARS task-executability dispatch hook with a bounded local evaluator. The emitted evidence distinguishes the real NARS hook path, Site Loop reconciliation, and the injected fake evaluator port. It proves request creation, stale assessment replacement, NARS-versus-Site-Loop leasing (exactly one admitted execution), bounded concurrent leasing, restart recovery, no-NARS recovery, and strict task-linked dispatch. Store ownership and temporary-root cleanup are asserted; promise barriers, not sleeps, establish ordering. This does not prove that the task or its outcome is correct. The optional live provider proof and recovery runbook are documented in Narada's `docs/operations/task-executability-e2e-and-recovery.md` runbook.

## Verification

```powershell
pnpm --filter @narada2/site-loop-mcp test
```
