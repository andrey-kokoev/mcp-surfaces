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
- compatibility aliases for the older `site_ops_*` naming

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

## Naming

New callers should use `site_loop_*` names. The older `site_ops_*` tool and
prompt names are compatibility aliases retained for registered callers created
before the Site Loop extraction.

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
