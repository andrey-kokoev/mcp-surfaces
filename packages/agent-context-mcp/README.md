# @narada2/agent-context-mcp

Agent-context MCP surface for site-local startup hydration and checkpoints.

Use this package to identify a Sonar-bound agent session, start durable session evidence, write checkpoints, and rehydrate prior context before resuming work.

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
node packages/agent-context-mcp/dist/src/main.js --site-root D:/code/site
```

## Tools

- `agent_context_doctor`: check DB readiness and schema presence.
- `agent_context_whoami`: resolve current session identity.
- `agent_context_start_session`: validate roster identity and write a start event.
- `agent_context_checkpoint`: write a durable checkpoint.
- `agent_context_rehydrate`: read latest checkpoint or checkpoint history for an agent.
- `agent_context_hydrate_current`: hydrate current session from identity, checkpoint, and session evidence.
- `agent_context_startup_sequence`: canonical alias for `agent_context_hydrate_current`.
- `agent_context_list_sessions`: list local agent start sessions.

## Checkpoint Content

Checkpoints can include active task context, files touched, key decisions, open questions, Git head, workboard freshness, next intended action, authority basis, continuation blockers, evidence refs, worktree state, and tactical resume notes.

## Agent Guidance

Agents should hydrate at startup, checkpoint meaningful state transitions, and rehydrate before resuming long-running work. Agent-context evidence is not task completion evidence by itself; task lifecycle reports must still go through `task-lifecycle-mcp`.

## Verification

```powershell
pnpm --filter @narada2/agent-context-mcp test
```
