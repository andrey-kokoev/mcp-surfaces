# Task Lifecycle Store Preparation

Task Lifecycle separates protocol startup from SQLite preparation.

## Why

The MCP process must be able to complete the protocol handshake and expose
startup-safe tools without opening, migrating, or repairing the task database.
SQLite remains the authoritative lifecycle-state store; Markdown task files
remain authored specifications and are reconciled into the SQLite projection
during explicit preparation.

## Prepare a Site

Build the package, then run the package-owned preparation command:

```powershell
pnpm --filter @narada-core/task-lifecycle-mcp build
node packages/task-lifecycle-mcp/dist/src/task-lifecycle/task-mcp-server.js --prepare --site-root <src-root>/site
```

Preparation creates or upgrades `.ai/task-lifecycle.db`, verifies the current
core schema, prepares Task Lifecycle auxiliary tables, and performs the
explicit legacy Markdown-spec reconciliation. It prints one JSON result and
exits; it does not start an MCP protocol server.

Run preparation as a preflight step when creating a Site, after an intentional
schema migration, or when the doctor reports `missing` or `stale`.

## Runtime Contract

A normal runtime launch should use the same explicit Site root:

```powershell
node packages/task-lifecycle-mcp/dist/src/task-lifecycle/task-mcp-server.js --site-root <src-root>/site
```

The following requests are store-independent and must remain available before
preparation:

- `initialize`
- `tools/list`
- `prompts/list`
- `task_lifecycle_doctor`
- `task_lifecycle_restart`
- `task_lifecycle_chapter_show`
- guidance and payload/output transport helpers

Stateful Task Lifecycle tools fail fast with the structured
`task_lifecycle_store_not_prepared:<reason>` error instead of creating or
migrating SQLite during a request. Call `task_lifecycle_doctor` to inspect the
effective Site root and its `preparation` status, then run the preflight
command. The JSON-RPC error `data` uses
`narada.task_lifecycle.not_ready.v1` and includes the reason, effective
`site_root`, and the remediation tuple (`task_lifecycle_doctor`, the explicit
`--prepare` command, then runtime restart/reattach). A `stale` result requires
the operator-approved migration/preparation path; runtime calls never guess at
migrations.

Runtime observation and restart reconciliation are deferred until after the
initialize response so optional filesystem evidence cannot delay the protocol
handshake.

## Core API

New integrations should use the explicit core APIs:

- `prepareTaskLifecycleStore(siteRoot)` — create/upgrade and stamp the current
  prepared schema version.
- `openPreparedTaskLifecycleStore(siteRoot)` — open only an existing,
  current, correctly-postured store; it never mutates schema.
- `inspectPreparedTaskLifecycleStore(siteRoot)` — return
  `prepared`, `missing`, `stale`, or `invalid` diagnostics.

The legacy `openTaskLifecycleStore(siteRoot)` behavior remains available for
compatibility with older library callers. New runtime surfaces must pass
`{ mode: 'runtime' }`; new setup/maintenance code must call the explicit
preparation API rather than relying on first-use initialization.
