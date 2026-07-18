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

The watchdog never interprets a surface's tool arguments. A caller that owns a
surface-level timeout may carry the transport contract in
`params._meta.narada_request_timeout_ms`; the proxy then waits for that
transport timeout plus a bounded grace margin
(`--tool-timeout-grace-ms <ms>`, default 15000) before declaring the child
unresponsive. The admitted transport timeout is capped at 15 minutes and the
grace is additive, so the effective watchdog deadline can be at most 15 minutes
plus the configured grace. Callers that use a surface-owned timeout should
forward this metadata so the surface can return its own bounded result without
losing the shared transport.
