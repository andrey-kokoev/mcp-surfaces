# Agent Ergonomics Surfaces

This repository keeps mechanical MCP guarantees separate from agent intent.

## Multi-repository Git Work

`git-mcp` owns repository evidence:

- current branch, upstream, ahead/behind, dirty paths, and conflicts
- configured remotes and resolved or unresolved push target
- latest commit per repository
- caller-supplied `scope_label` on Git mutations
- `git_repositories_summary` for multi-repository handoff
- `git_workflow_record` for durable multi-repository commit/push ledger entries

It does not infer which dirty files belong to the current agent. Callers must pass
the intended scope explicitly, either through mutation `scope_label` values or
`expected_paths_by_repository` in `git_repositories_summary`.

## Completion Audit

Completion audit is not a Git operation. A coherent completion artifact has this
shape:

- `requirement`: concrete item that must be true
- `evidence`: command, tool result, rendered artifact, or source inspection
- `verdict`: `proved`, `contradicted`, `incomplete`, or `missing`
- `residual_risk`: remaining uncertainty, if any

That artifact is owned here by `@narada2/completion-audit-mcp` and its
`completion_audit_record` tool. It should not be hidden in `git_status` or
`git_push`.

## Local Search Accounting

`local-filesystem-mcp` search results keep the legacy `scanned` field for
compatibility and include `scanned_unit`. Rendered tool text labels the same value
as `matched_entries_scanned` when appropriate. For ripgrep-backed search, this is
matched result entries observed, not total filesystem entries traversed.
