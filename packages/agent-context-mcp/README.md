# @narada2/agent-context-mcp

Agent-context MCP surface for site-local startup hydration and checkpoints.

Use this package to identify a site-bound agent session, start durable session evidence, write checkpoints, and rehydrate prior context before resuming work.

## Boundary

- Allowed: resolve current agent identity from environment, roster, session evidence, and checkpoints.
- Allowed: materialize agent start events.
- Allowed: write and read durable checkpoints.
- Not allowed: task lifecycle mutation.
- Not allowed: arbitrary filesystem, shell, Git, mailbox, or worker delegation behavior.

## Runtime

The server uses a site root and these environment variables when present:

- `NARADA_AGENT_ID`
- `NARADA_SITE_ROOT`
- `NARADA_AGENT_CONTEXT_DB`

It expects site-local evidence such as `AGENTS.md` and `.ai/agents/roster.json` when validating identities.

```powershell
pnpm --filter @narada2/agent-context-mcp build
node packages/agent-context-mcp/dist/src/main.js --site-root D:/code/site --site-id narada.example
```

## Tools

- `agent_context_doctor`: check DB readiness and schema presence.
- `agent_context_whoami`: resolve current session identity.
- `agent_context_start_session`: validate roster identity and write a start event.
- `agent_context_checkpoint`: write a durable checkpoint and, when needed, one bounded canonical continuation state.
- `agent_context_rehydrate`: read the latest checkpoint, an exact current or archived checkpoint, or bounded checkpoint history for an agent.
- `agent_context_continuation_export`: render the latest canonical continuation to a Site-local Markdown projection and attach its verified reference.
- `agent_context_continuation_read`: verify and read the latest or explicitly selected canonical continuation and its Markdown projection.
- `agent_context_hydrate_current`: hydrate current session from identity, the latest or explicitly selected checkpoint, and session evidence.
- `agent_context_startup_sequence`: canonical alias for `agent_context_hydrate_current`, including exact checkpoint selection.
- `agent_context_list_sessions`: list local agent start sessions.

## Checkpoint and Continuation Content

Checkpoints can include active task context, files touched, key decisions, open questions, Git head, workboard freshness, next intended action, authority basis, continuation blockers, evidence refs, worktree state, and tactical resume notes.

An optional `continuation` object uses schema `narada.continuation.v1` and is persisted inside the existing checkpoint payload. It is the canonical bounded state for fresh-session handoff: objective, current state, completed work, decisions, evidence references, blockers, next action, canonical sources, constraints, and resume mode. The surface derives `source_checkpoint_ref` and `content_hash`; it does not create a second persistence table. Keep the object below 64 KiB and never use it for raw transcripts or unbounded history.

An optional `continuation_ref` links the checkpoint to a portable Markdown projection using schema `narada.continuation.handoff.v1`. The referenced artifact must be Site-relative, no larger than 256 KiB, and match its supplied SHA-256.

Use `agent_context_continuation_export` after checkpointing to create a projection under `.ai/continuations`. The default filename is derived from the agent and checkpoint ID; an explicit path must remain under that directory and end in `.md`. Existing projections are reused when identical, refused when different unless `overwrite: true` is explicit, and never become a second authority.

Omit `checkpoint_id` to use the latest current checkpoint. Pass an exact `checkpoint_id` to `agent_context_rehydrate`, `agent_context_continuation_read`, `agent_context_hydrate_current`, or `agent_context_startup_sequence` to select current or archived state scoped to the requested agent. An explicit ID that is absent returns `checkpoint_not_found` and never silently falls back to the latest checkpoint. `agent_context_continuation_export` remains latest-only.

Use `agent_context_continuation_read` to verify the selected reference, artifact size, artifact SHA-256, and the embedded canonical continuation content hash. `agent_context_hydrate_current` includes the same result as `portable_continuation`; stale projections are reported with `status: stale` while live checkpoint hydration remains available.

## Agent Guidance

Agents should hydrate at startup, checkpoint meaningful state transitions, and rehydrate before resuming long-running work. Agent-context evidence is not task completion evidence by itself; task lifecycle reports must still go through `task-lifecycle-mcp`.

## Verification

```powershell
pnpm --filter @narada2/agent-context-mcp test
```
