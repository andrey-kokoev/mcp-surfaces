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

## Build artifact preflight

Every launch must provide `--artifact-manifest <path>`. The workspace build
creates `.ai/runtime/workspace-artifact-manifest.json`; it records the package
metadata, TypeScript source fingerprints, local dependency metadata, declared
runtime export targets, and their emitted artifact fingerprints. Before the
entrypoint is spawned, the proxy verifies the manifest fingerprint and refuses
with a structured preflight error if the manifest is missing, stale, or no
longer matches an export target. Re-run the workspace build before retrying;
the proxy never starts a server against an unverified workspace.

Carrier materialization adds a second contract gate. Every generated proxy
launch declares `--runtime-contract-version 2`, the current
`--artifact-manifest`, and, for a materialized carrier file, a
`--materialization-sidecar` path. The registrar validates every generated
proxy, child entrypoint, and manifest reference before writing the carrier
file. It records `<carrier-config>.narada-generation.json` with the config,
manifest, registrar-build, and contract fingerprints. The proxy refuses to
spawn the child when that sidecar is missing or stale, including after the
carrier config or registrar build changes.

Materialization requests run in a fresh built registrar subprocess rather than
using a resident registrar's loaded module graph. A failed validation is a
structured refusal; the registrar does not rebuild or retry automatically.

Workspace build and carrier materialization are intentionally separate
lifecycles: `pnpm build` refreshes the workspace artifact manifest but does not
silently rewrite a user's Codex, Kimi, or OpenCode configuration. After a
successful build, refresh a carrier explicitly with:

```powershell
pnpm materialize:carrier -- --materialize-carrier <carrier-id> --output-path <carrier-config>
```

The command is owned by the built registrar and remains usable when the MCP
registrar surface itself cannot start. Omit `--output-path` to use the
registrar's configured path for the carrier. The generated sidecar is the
proof that the carrier config and current workspace generation were produced
together.

When a proxy refuses a stale generation, its structured error includes a
`narada.mcp_runtime_proxy.materialization_recovery.v1` record. Use its
`recovery_group_id` to report one recovery action for all bootstrap surfaces
with the same carrier failure, run the supplied registrar command once, then
follow the `restart` instruction. Regeneration never restarts the carrier
implicitly; Codex, Kimi, and OpenCode must reload their carrier configuration
in a new or restarted session.

On Windows, the proxy starts the native Rust process supervisor after preflight.
The supervisor owns the MCP server in a Job Object configured to terminate the
managed server when the supervisor exits, and monitors the proxy PID. The
diagnostic instance record identifies `proxy_pid`, `supervisor_pid`, and
`managed_child_pid`/`server_pid` separately; `child_pid` is the supervisor PID
on Windows and the server PID on platforms without the Windows supervisor.
The supervisor preserves the server's inherited stdio and terminates the
managed server when its proxy parent disappears. The supervisor executable is
also required before a Windows launch is admitted.

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
`<diagnostics-dir>/instance-<proxy-pid>.json`. The lease includes parent,
proxy, supervisor/server PIDs, artifact freshness evidence, and
live/stale/reclaiming/closed state. If carrier stdin closes or the captured
parent PID dies, the proxy first closes the managed server's stdin, waits the
bounded orphan grace period, then terminates the owned process tree. On
Windows this is a supervisor-tree termination; on other platforms it is the
existing signal-based child termination. A live parent and open carrier stream
are never reclaimed. Defaults are a 5-second liveness check and a 15-second
grace; tests/supervisors may set `--liveness-check-ms` and
`--orphan-grace-ms`.

Operators can list all recorded instances without starting a child:

```powershell
node dist/src/main.js --list-runtime-instances --diagnostics-dir <dir>
```

The listing classifies each record from PID liveness and lease expiry, so stale
and live server pairs are explicit rather than inferred from process names.
