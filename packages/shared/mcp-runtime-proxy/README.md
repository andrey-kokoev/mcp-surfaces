# @narada2/mcp-runtime-proxy

Strict sealed-artifact stdio runtime for carrier-launched MCP servers.

## Runtime contract

Every admitted launch is pinned by one immutable
`narada.mcp_carrier_generation.v3` document. A binding contains the exact
carrier launch, the canonical surface descriptor, a fresh-only artifact
selector, the child entrypoint and arguments, the admitted child environment
names, and the source roots used to prove freshness. The generation also pins
the runtime proxy's own closure and receipt.

The carrier invokes the sealed proxy entrypoint with:

```text
--runtime-contract-version 3
--carrier-generation <immutable-generation.json>
--server-key <binding-key>
--artifact-store <content-addressed-store>
```

Before starting a child, the proxy verifies:

- the generation schema and digest;
- the exact binding launch still present in the carrier config;
- the executing proxy entrypoint and arguments against the sealed proxy pin;
- the proxy closure and receipt;
- the selected child closure, receipt, compatibility channel, and declared
  entrypoint;
- source freshness for the proxy and child package closures.

Any mismatch is a structured preflight refusal. The runtime does not rebuild,
retry, consult an alternate artifact, or fall back to an older contract.

The running process remains pinned to the admitted closure. New processes
select the latest compatible fresh closure. Source changes can make a live
instance diagnostically stale, but they do not mutate or replace that process.

## Process lifecycle

The proxy forwards MCP stdin/stdout, captures bounded diagnostic tails, and
uses the native process supervisor on Windows. Carrier stdin closure, parent
loss, or an unrecoverable child failure terminates the owned process tree
immediately. There is no generation overlap, drain period, or legacy runtime
fallback.

Diagnostic instance records live under the configured diagnostics directory
and distinguish proxy, supervisor, and server PIDs. They are observations only;
they grant no restart, carrier, Site, or policy authority.

## Surface contract

The proxy validates the child's live `tools/list` result against the descriptor
sealed into the carrier generation. It supplies the universal read-only tools
`surface_describe` and `surface_contract_describe`. The description results
expose the sealed descriptor, interface shape, contract digests, live process
liveness, sealed generation identity, artifact closure/receipt identity, and
runtime freshness. V3 has no separate legacy runtime-status tool.

## Request watchdog

Pending child requests have a proxy-owned deadline. If a child does not answer,
the proxy returns `child_request_timeout`, sends cancellation, terminates the
child, and exits non-zero so the carrier can start a new process.

An owned caller timeout may be declared in
`params._meta["narada.transport_timeout_ms"]`. The watchdog admits that bounded
timeout plus the configured tool-timeout safety margin. Optional launch
settings are `--request-timeout-ms`, `--tool-timeout-grace-ms`,
`--diagnostics-dir`, and `--liveness-check-ms`; because the complete argv is
part of the immutable binding, these settings cannot be appended or changed
after materialization.

Operators can inspect diagnostic records without starting a child:

```powershell
node dist/src/main.js --list-runtime-instances --diagnostics-dir <dir>
```
