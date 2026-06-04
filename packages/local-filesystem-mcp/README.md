# @narada2/local-filesystem-mcp

Canonical local filesystem MCP server.

Tool results use `structuredContent` as the authoritative machine payload. The text content is a deterministic, compact rendering for agent transcripts. Large read and search results are materialized as `mcp_output:*` refs; in that case `structuredContent` is the authoritative locator payload and `mcp_output_show` returns the full stored domain payload.

Read mode tools:

- `fs_read_file`
- `fs_read_file_range`
- `fs_stat`
- `fs_glob_search`
- `fs_grep_search`
- `mcp_output_show`

Write mode tools are exposed only when launched with `--mode write`.

- `fs_write_file`
- `fs_str_replace_file`
- `fs_replace_range`
- `fs_apply_patch`
- `fs_move_path`
- `fs_create_directory`
- `fs_rename_directory`
- `fs_delete_directory`

Behavior notes:

- `fs_read_file` and `fs_read_file_range` return line-window metadata plus file content; large windows are returned through `mcp_output_show`.
- `fs_glob_search` and `fs_grep_search` return newline-separated matches in text and bounded match arrays in `structuredContent`. Search paging uses `has_more` and `next_offset`; `count_exact: false` means ripgrep was stopped after the requested page plus lookahead. Non-initial offset pages materialize and cache a complete result snapshot for the same search arguments, so repeated deep pages are served from cache. `order: "ripgrep_traversal"` means page order follows ripgrep emission order, not sorted path order.
- `fs_grep_search` includes `output_mode` and parsed `match_objects` in `structuredContent` so callers can interpret matches without parsing ripgrep text.
- `fs_write_file` supports `overwrite`, `create_only`, and `expected_sha256` guards.
- `fs_replace_range` supports an `expected_sha256` guard for stale-file detection.
- `fs_create_directory` is idempotent for existing directories and returns `status: "exists"`.
- `fs_apply_patch` accepts unified diffs and Codex-style `*** Begin Patch` patches, including delete and move targets.

Example:

```powershell
pnpm --filter @narada2/local-filesystem-mcp build
node D:/code/mcp-surfaces/packages/local-filesystem-mcp/dist/src/main.js --mode read --allowed-root D:/code/narada
```
