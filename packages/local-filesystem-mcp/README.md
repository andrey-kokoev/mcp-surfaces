# @narada2/local-filesystem-mcp

Canonical local filesystem MCP server.

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

Example:

```powershell
pnpm --filter @narada2/local-filesystem-mcp build
node D:/code/mcp-surfaces/packages/local-filesystem-mcp/dist/src/main.js --mode read --allowed-root D:/code/narada
```
