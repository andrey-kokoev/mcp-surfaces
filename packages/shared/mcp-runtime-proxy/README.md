# @narada2/mcp-runtime-proxy

Small stdio proxy for carrier-launched MCP servers.

The package also exports `./generation-manager`, a transport-neutral logical
endpoint manager for V2 replacements. It models `starting`, `warming`,
`active`, `draining`, `terminated`, and `failed` generations. Warm-up
performs initialize, initialized notification where applicable, tools/list
contract verification, and an optional declared read-only health call before
atomic activation.

Replayable stdio replacements route new calls to the active generation and
allow old in-flight calls to drain. Streamable HTTP sessions remain pinned to
their original generation while new sessions select the replacement. Drain
expiry returns `session_generation_retired` with reconnect guidance and asks
the adapter to terminate the old process tree. A failed warm-up leaves the old
generation active. `restart_required` descriptors are refused with the exact
carrier/session restart owner; the manager never assumes that authority.

## Runtime observation records

`AtomicRuntimeObservationStore` persists normalized generation observations as exclusive temp-file plus rename records under the configured runtime root. `observe()` is process-inspection readback and marks expired leases stale/unreachable; `createRuntimeObservationSink()` is optional and does not grant Narada Site authority. A carrier or loader adapter may emit observations, but the proxy remains transport diagnostics only and never applies reconciliation plans.

The proxy launches a Node MCP entrypoint, forwards stdin/stdout, captures stderr,
and turns child startup exits into JSON-RPC errors for pending requests. This is
for carrier diagnostics only; it does not authorize tools, mutate policy, or
interpret MCP domain behavior.

Every proxied surface advertises one proxy-owned read-only tool,
`mcp_runtime_proxy_status`, in its normal `tools/list` response. Call it when
a carrier-bound surface may be running an old build. Its
`runtime_freshness.status` distinguishes `current`, `stale`, and `unknown`
using the runtime files loaded at proxy start plus matching TypeScript source
mtimes. `runtime_freshness.reload_action` is the machine-readable operation
for the carrier or runtime supervisor; it never implies an automatic restart.

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

The proxy also writes a heartbeat lease at
`<diagnostics-dir>/instance-<proxy-pid>.json`. The lease includes parent
carrier PID, proxy/child PIDs, freshness evidence, and live/stale/reclaimed
state. If carrier stdin closes or the captured parent PID dies, the proxy first
closes child stdin, waits the bounded orphan grace period, then sends
`SIGTERM` (and finally `SIGKILL` only if needed). A live parent and open
carrier stream are never reclaimed. Defaults are a 5-second liveness check and
a 15-second grace; tests/supervisors may set `--liveness-check-ms` and
`--orphan-grace-ms`.

Operators can list all recorded instances without starting a child:

```powershell
node dist/src/main.js --list-runtime-instances --diagnostics-dir <dir>
```

The listing classifies each record from PID liveness and lease expiry, so stale
and live server pairs are explicit rather than inferred from process names.
