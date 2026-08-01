# `@narada-core/mcp-runtime-client`

Bounded production JSON-RPC client used by finite Scheduler and SOP workers to call Site-declared MCP surfaces through `mcp-loader`.

The client does not resolve entrypoints, interpret domain authority, or execute arbitrary commands. `mcp-loader` remains the Site fabric and child-lifecycle authority. The client starts one loader process, attaches exact declared `surface_id` values, forwards bounded tool calls, and closes all children when the worker pass ends.
