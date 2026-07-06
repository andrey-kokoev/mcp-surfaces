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
