# @narada2/mcp-runtime-proxy

Small stdio proxy for carrier-launched MCP servers.

The proxy launches a Node MCP entrypoint, forwards stdin/stdout, captures stderr,
and turns child startup exits into JSON-RPC errors for pending requests. This is
for carrier diagnostics only; it does not authorize tools, mutate policy, or
interpret MCP domain behavior.

Pending child requests have a proxy-owned deadline. If the child stays alive but
does not answer, the proxy returns a structured `child_request_timeout` JSON-RPC
error to the carrier, sends `notifications/cancelled` to the child, terminates
the child, and exits non-zero so the carrier can restart the surface cleanly.
Use `--request-timeout-ms <ms>` before `--` to override the default timeout.

The watchdog never preempts a tool's own declared timeout: when a request
carries `timeout_ms` (top-level or in `arguments`), the per-request deadline is
the declared timeout plus a grace margin (`--tool-timeout-grace-ms <ms>`,
default 15000), capped at 15 minutes, whichever interacts with the configured
proxy timeout to produce the later deadline. Only when the child outlives that
effective deadline does the proxy terminate it, so a long-running
`structured_command_execute` call returns the surface's own timeout result
instead of losing the shared transport.
