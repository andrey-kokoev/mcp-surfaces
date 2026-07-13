# Site Loop Doctrine

Site Loop is the site-owned operating loop surface. It exposes configured loop
readback, health, control, docs, tests, and bounded run orchestration through an
MCP interface.

Site Loop is not the task lifecycle surface, SOP engine, scheduler, agent
context store, shell, filesystem surface, mailbox surface, or Graph mail
surface. It may coordinate with those surfaces only through explicit config,
typed adapters, or governed tool boundaries.

## Implemented Shape

`@narada2/site-loop-mcp` owns:

- validation of `.narada/capabilities/site-loop-config.json`
- allowlisted documentation and test selector exposure
- loop status, health, run, attention, and control readback/mutation
- bounded `site_loop_run_once` orchestration

### Resident Target Selection

Resident selection keeps the runtime host and carrier preference distinct.
`resident_runtime.preferred_runtime` and `resident_launch.runtime` name the
runtime host/substrate emitted in a launch result, such as
`narada-agent-runtime-server`. `resident_runtime.preferred_preference` names
the preferred carrier posture, such as `interactive_agent_cli`.

For a launch expressed as `--Carrier agent-cli --Runtime
narada-agent-runtime-server`, Site Loop must compare the result packet's
runtime to `narada-agent-runtime-server` and its carrier preference to
`interactive_agent_cli`. It must never compare the carrier kind `agent-cli`
with the packet runtime and conclude that the resident is absent.

Site identity, resident identity, refs, schema names, scheduler hints, recovery
steps, docs, tests, and configured commands are site config. They must not be
hardcoded as sonar-specific package behavior.

## Boundaries

Task lifecycle owns tasks, claims, evidence, reviews, closeout, and task
database authority. Site Loop may inspect or coordinate configured task
dispatch, but it must not become a general task mutation surface.

SOP owns procedure templates and SOP run state. Site Loop may invoke or observe
site-configured SOP adapter commands, but it does not own SOP definitions.

Scheduler owns platform task registration and task execution. Site Loop may
report configured scheduler posture and recovery hints, but it must not become a
general scheduler mutation surface.

Agent context owns identity/session hydration and agent context persistence.
Site Loop may consume resident/session evidence, but it does not own agent
identity or startup state.

Structured command owns policy-gated command execution. Site Loop accepts only
argv-shaped configured command slots for bounded loop work; it must not accept
arbitrary shell strings.

Filesystem, mailbox, graph-mail, and calendar surfaces own their domains. Site
Loop may refer to their evidence or configured commands, but it must not embed
their domain behavior.

## Target Shape

The target factorization is:

- generic Site Loop MCP package
- site-owned config and policy
- optional site-owned adapters for site-specific workflows
- adjacent MCP surfaces for domain authority

When a new site needs different behavior, first express it in
`site-loop-config.json`. If config is insufficient, add a generic config
primitive or delegate to an existing MCP/tool command. Add site-specific adapter
code only when the behavior is genuinely local to that site.

## Test Authority Target Shape

Full Site Loop e2e tests should not rely on `dry_run` as their main safety
mechanism. Dry-run proves transport and planning, but it intentionally skips
important mutating phases. A full e2e needs the loop to execute mutating phases
against non-production authority.

The target primitive is a site-declared `test_authority` binding. When enabled
for a run, every external authority edge must be rebound from production state
to declared test state, or the run must refuse before mutation.

The external authority edges are:

- source sync command execution
- inbox projection and bridge input
- task lifecycle DB and task projection files
- Site Loop run store
- resident status, carrier/session state, and outcome evidence
- resident launch/supervisor behavior
- directive dispatch
- operator attention and escalation output
- scheduler or platform recovery evidence
- configured direct-spawn commands

Target config shape:

```json
{
  "test_authority": {
    "enabled": true,
    "state_root": ".ai/test-authority/site-loop",
    "allow_live_mailbox": false,
    "allow_live_resident": false,
    "allow_live_scheduler": false,
    "allow_configured_commands": false,
    "task_lifecycle_db": ".ai/test-authority/site-loop/.ai/task-lifecycle.db",
    "task_projection_root": ".ai/test-authority/site-loop/.ai/tasks",
    "inbox_projection": ".ai/test-authority/site-loop/.ai/inbox-envelopes",
    "site_loop_store": ".ai/test-authority/site-loop/.ai/task-lifecycle.db",
    "resident_adapter": "fixture",
    "dispatch_adapter": "fixture",
    "operator_attention_root": ".ai/test-authority/site-loop/operator-attention"
  }
}
```

Target run shape:

```json
{
  "dry_run": false,
  "test_authority": true,
  "limit": 1,
  "source_sync": false,
  "ensureResident": false,
  "requireLiveCarrier": false
}
```

Required behavior:

- `test_authority` runs are opt-in per call and allowed only when declared by
  site config.
- Relative paths resolve under `test_authority.state_root`; absolute paths must
  be rejected unless explicitly allowlisted by the test-authority policy.
- Live mailbox, live resident, live scheduler, production task DB, production
  operator attention, and configured command execution are refused unless the
  matching `allow_live_*` or command allowance is explicit.
- The result packet must include `authority_mode: "test"`, the resolved
  authority roots, and a refusal reason for any edge that could not be rebound.
- Production readiness/coherence tools must not treat test-authority evidence as
  production proof.

The intended e2e is a non-dry `site_loop_run_once` that mutates only the
declared test authority roots, verifies run records and expected fixture
processing, and proves no production state changed.

## Minimal Site Config

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

## Sonar-Style Config

A sonar-style config should still be data: resident identity, mailbox proof
schemas, ticket projection refs, recovery commands, allowed tests, docs, and
configured source-sync/reconciliation commands belong in config or sonar-owned
adapters. Shared Site Loop code should not require the site id to be sonar.
