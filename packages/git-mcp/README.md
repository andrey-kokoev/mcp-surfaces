# @narada2/git-mcp

Structured, policy-gated Git MCP surface.

Use this package when agents need bounded Git inspection or publication operations without arbitrary shell access.

## Boundary

- Allowed: inspect status, diffs, logs, and commits under admitted repository roots.
- Allowed in write mode: stage explicit paths, commit staged changes, and push without force.
- Not allowed: arbitrary Git subcommands.
- Not allowed: shell strings or shell interpolation.
- Not allowed: force push.
- Not allowed: path access outside admitted roots.

## Modes

Read mode exposes inspection tools and renders write tools as unavailable by policy.

Write mode admits mutation tools:

- `git_add`
- `git_commit`
- `git_push`

Launch with write mode only for agents that are allowed to publish repository changes.

## Tools

Read tools:

- `git_policy_inspect`: inspect active Git MCP policy.
- `git_status`: branch, upstream, remotes, push readiness, and working tree status.
- `git_diff`: paged working, staged, or commit diff. Pass `offset`, `limit`, and the returned `next_offset` to continue reading. Pass `include_untracked: true` with `scope: "working"` to append bounded untracked-file patches.
- `git_log`: recent commits, optionally scoped by pathspec.
- `git_show`: one commit with metadata and optional patch.
- `git_repositories_summary`: multi-repository status and push-readiness summary for handoffs.
- `git_workflow_record`: durable record for completed multi-repository stage/commit/push workflows.

Write-mode tools:

- `git_add`: stage explicit file paths.
- `git_commit`: commit already staged changes.
- `git_push`: push current branch or explicit remote/branch; force push is not supported.

## Large Output

Git tools return bounded output directly in their own result payloads. For `git_diff`, use `next_offset` from the result to fetch the next page. Request narrower pathspecs, lower limits, or `include_patch: false` when a result would be too large.

## Run

```powershell
pnpm --filter @narada2/git-mcp build
node packages/git-mcp/dist/src/main.js --allowed-root D:/code/example --mode read
```

Use write mode only when mutation is intended:

```powershell
node packages/git-mcp/dist/src/main.js --allowed-root D:/code/example --mode write
```

## Verification

```powershell
pnpm --filter @narada2/git-mcp test
```
