# AGENTS.md - mcp-surfaces Narada Project Site

This is the project-locus Narada Site for `D:\code\mcp-surfaces`.

## Posture

Treat `.narada` as project-local governance, not as a separate repository and not as Narada proper. The surrounding project repo owns the MCP surface implementations (including the canonical `agent-context-mcp` package). Do not mutate application files unless the user asks for project implementation work.

## Authority Boundaries

This Site may own:

- Site-local agent context, checkpoints, and session evidence under `.narada/.ai`
- Site-local MCP fabric materializations under `.narada/.ai/mcp`
- Site-local task lifecycle and inbox records

This Site may not own:

- The mcp-surfaces repository source tree outside `.narada`
- Other Narada Sites' roots or fabrics

## Concurrent Agent Streams

Each independently active automated stream uses a dedicated Git worktree and
`agent/<topic>` branch by default. Before project implementation, inspect
`git_status`; if another stream's uncommitted work is present, move to an
isolated worktree or issue an explicit shared-worktree warning and obtain an
operator-directed exception. Under an exception, preserve existing paths,
stage only the current task's files, and require the git-mcp
`expected_staged_paths` commit preflight so index drift is refused rather than
silently absorbed. Human-only repository use is not subject to this default.
