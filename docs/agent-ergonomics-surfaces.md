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

## Local Search Accounting

`local-filesystem-mcp` search results keep the legacy `scanned` field for
compatibility and include `scanned_unit`. Rendered tool text labels the same value
as `matched_entries_scanned` when appropriate. For ripgrep-backed search, this is
matched result entries observed, not total filesystem entries traversed.
