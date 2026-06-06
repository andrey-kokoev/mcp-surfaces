# AGENTS.md

Guidance for agents working in this repository.

## Repository Purpose

`mcp-surfaces` contains standalone MCP surface packages shared by Narada sites and carriers.

Current packages:

- `@narada2/mcp-transport`: MCP payload/output-ref helpers.
- `@narada2/local-filesystem-mcp`: governed filesystem MCP surface.
- `@narada2/structured-command-mcp`: policy-gated structured command MCP surface.
- `@narada2/git-mcp`: governed Git inspection and publication MCP surface.
- `@narada2/inbox-mcp`: governed inbox intake and triage MCP surface.
- `@narada2/mailbox-mcp`: read-only synced mailbox projection MCP surface.
- `@narada2/graph-mail-mcp`: policy-gated Microsoft Graph mail MCP surface for live reads and draft management.
- `@narada2/task-lifecycle-mcp`: task lifecycle MCP surface.
- `@narada2/sonar-site-ops-mcp`: Sonar site operations MCP surface.
- `@narada2/agent-context-mcp`: agent context MCP surface.
- `@narada2/worker-delegation-mcp`: policy-gated worker delegation MCP surface.

## Development Rules

- Use TypeScript sources under `packages/*/src` and tests under `packages/*/test`.
- Do not add new `.mjs` source files; this repo has migrated MCP package code to `.ts`.
- Preserve ESM/NodeNext package behavior.
- Prefer package-local tests for narrow changes, then root tests when shared behavior changes.
- Keep MCP tool schemas explicit and conservative: no broad shell strings, wildcard filesystem access, or implicit mutation paths.
- Keep transport helpers generic. Do not add Narada task-domain behavior to `@narada2/mcp-transport`.

## Common Commands

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm test:mcp-transport
pnpm test:local-filesystem
pnpm test:structured-command
pnpm test:git
pnpm test:worker-delegation
pnpm test:inbox
pnpm test:mailbox
pnpm test:graph-mail
pnpm test:task-lifecycle
pnpm test:sonar-site-ops
pnpm test:agent-context
```

## Verification Expectations

Before handing off changes:

- Run the most specific package test for the touched package.
- Run `pnpm build` or `pnpm typecheck` when package exports, TypeScript config, or shared types change.
- Run root `pnpm test` for changes affecting shared MCP behavior or package boundaries.

## Boundary Notes

- `local-filesystem-mcp` owns governed file inspection and mutation tools.
- `structured-command-mcp` owns argv-based command execution policy.
- `worker-delegation-mcp` owns policy-gated delegation to worker runtimes; it is not a general shell, task lifecycle, or recursive worker-control surface.
- `mcp-transport` owns reusable payload/output reference mechanics.
- `mailbox-mcp` owns read-only access to site-local synced mailbox projections; it must not become a general PowerShell, Graph, Outlook, or message-sending surface.
- `graph-mail-mcp` owns policy-gated Microsoft Graph mail access and draft lifecycle tools; sending drafts must stay disallowed unless explicit site policy enables it.
- Task lifecycle/domain behavior belongs in dedicated MCP surface packages with explicit shared-domain dependencies.

