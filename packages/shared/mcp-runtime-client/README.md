# `@narada-core/mcp-runtime-client`

Bounded production JSON-RPC client used by finite Scheduler and SOP workers to call Site-declared MCP surfaces through `mcp-loader`.

The client does not resolve entrypoints, interpret domain authority, or execute arbitrary commands. `mcp-loader` remains the Site fabric and child-lifecycle authority. The client starts one loader process, attaches exact declared `surface_id` values, forwards bounded tool calls, and closes all children when the worker pass ends.

Materialized tool results are read back through `mcp-loader` in validated pages. The client enforces a finite page count, nesting depth, per-call deadline, exact ref/offset/length continuity, and a configurable `maxMaterializedResultChars` ceiling (1,000,000 by default).
