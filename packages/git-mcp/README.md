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
- `git_status`: branch, upstream, ahead/behind, and working tree status.
- `git_diff`: bounded working, staged, or commit diff.
- `git_log`: recent commits, optionally scoped by pathspec.
- `git_show`: one commit with metadata and optional patch.
- `mcp_output_show`: read materialized large output.

Write-mode tools:

- `git_add`: stage explicit file paths.
- `git_commit`: commit already staged changes.
- `git_push`: push current branch or explicit remote/branch; force push is not supported.

## Output Refs

Large results can be materialized through `@narada2/mcp-transport` as `mcp_output:*` refs. Use `mcp_output_show` with `offset` and `limit` to page them.

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
