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

Example:

```powershell
node D:/code/mcp-surfaces/packages/local-filesystem-mcp/src/main.mjs --mode read --allowed-root D:/code/narada
```
