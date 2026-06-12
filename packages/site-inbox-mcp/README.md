# @narada2/site-inbox-mcp

Governed inbox intake and triage MCP surface.

Use this package for site-local inbox envelopes that need triage, acknowledgement, CAPA review, or task materialization through downstream lifecycle surfaces.

## Boundary

- Allowed: submit and inspect site-local inbox envelopes.
- Allowed: classify and prioritize envelopes for triage.
- Allowed: expose CAPA and capability-review queues derived from local inbox state.
- Not allowed: reading email mailboxes.
- Not allowed: live Microsoft Graph access.
- Not allowed: task lifecycle mutation beyond envelope intake and triage signals.

Use `@narada2/mailbox-mcp` for synced mailbox reads and `@narada2/graph-mail-mcp` for live Graph/draft operations.

## Storage

Inbox envelopes are stored under:

```text
.ai/inbox-envelopes
```

The package maintains an index at:

```text
.ai/state/inbox-index.sqlite
```

Envelope status is projected from envelope files and admission-log events.

## Tools

- `inbox_doctor`: inspect inbox MCP readiness, index path, counts, and storage mode.
- `inbox_list`: list envelopes with optional status, kind, target role, action, and limit filters.
- `inbox_show`: show one envelope by `envelope_id`.
- `inbox_submit`: submit a new site-local envelope and admit it to the local inbox log.
- `inbox_next`: return the next received envelope for triage.
- `capa_queue`: list CAPA review candidates and incidents.
- `capability_next`: return pending local capability-review items when configured.

## Envelope Kinds

Known envelope kinds include:

- `proposal`
- `observation`
- `command_request`
- `question`
- `knowledge_candidate`
- `task_candidate`
- `incident`
- `upstream_task_candidate`

## Agent Guidance

Agents should use `inbox_list` or `inbox_next`, then `inbox_show` before acting on an envelope. `inbox_submit` is for submitting structured local envelopes, not raw mailbox messages.

## Verification

```powershell
pnpm --filter @narada2/site-inbox-mcp test
```
