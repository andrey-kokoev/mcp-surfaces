# @narada-core/project-state-mcp

Read-only local-site MCP projection for a Narada project's virtual project-state
registry.

The adapter owns no SQLite schema and does not mutate a site. It invokes the
site-owned `scripts/project-state-cli.mjs` with a fixed executable, fixed
project root, and bounded stdout. The site's authored SQL snapshot remains the
authority; generated SQLite/JSON files are derived outputs. Every tool is
replayable, virtual-only, and disabled by default in the local-site projection.

Tools:

- `project_state_guidance`
- `project_state_doctor`
- `project_state_command_map`
- `project_state_program_list` / `project_state_program_show`
- `project_state_project_list` / `project_state_project_show`
- `project_state_matrix`
- `project_state_gaps`
- `project_state_validate`

The projection receives `--project-root {site_root}`. Callers cannot replace the
root or CLI path through tool arguments.
