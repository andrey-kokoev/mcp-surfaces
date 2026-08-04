# MCP Surface Runtime Target Shape

## Outcome

The target is one externally supervised surface service per PC Site, not one
process per surface and not one global process for every authority. Carrier
sessions connect as clients. The service hosts admitted surface instances and
partitions them by the authority recorded in the admitted Site binding.

The implementation includes the reusable execution engine, an authenticated
PC Site service in Narada proper, and a guarded production canary. The
`launcher` surface is the first canary because every tool is read-only; its
`stdio` projection remains the explicit rollback path. No other surface
changes execution posture implicitly. Narada proper owns service lifecycle,
Site discovery, carrier authentication, action admission, and operational
evidence.

## Authority And Contract Sources

Three sources must remain distinct:

1. The package-owned `SurfaceDescriptorV2` is the authored tool, effect,
   projection, lifecycle, and execution contract.
2. The admitted Site-registry binding is the runtime authority contract. It
   selects the Site, authority reference, surface, projection, and exact tool
   contract digest.
3. The live factory or stdio child inventory is observed implementation
   evidence. It must match the admitted tool names before calls are accepted.

The registrar compiles and materializes these records. It does not become
runtime binding authority. Filesystem reachability, current directory, server
name, entrypoint path, and carrier fluency do not establish authority.

## Explicit Execution Declaration

Every projection has an execution posture:

```json
{
  "adapter": "stdio | surface_factory",
  "tenancy": "session_isolated | authority_shared",
  "replacement": "manual | generation_swap"
}
```

Omission normalizes to `stdio`, `session_isolated`, and `manual`. This keeps all
existing surfaces on their current behavior. Sharing and replacement require a
descriptor change, a new descriptor digest, materialization, and normal review.

`surface_factory` means the package exports `createSurfaceRuntime(init)`. The
factory receives only explicit binding/configuration data. Its runtime reports
its tool inventory, health, optional replacement assessment, and dispose hook.
Worker threads provide lifecycle and fault isolation; they are not a security
boundary. Host permissions and secrets still require separate process policy.

## Instance Identity And Calls

Logical instance identity is derived from Site ID, authority reference, binding
ID, projection ID, tenancy, and—only for session-isolated bindings—the carrier
session ID. PID and worker thread ID are observations, never identity or
authority.

An authority-shared instance may be reused by multiple carrier sessions only
when all authority and binding fields match. A different authority reference
always creates a different instance. Every call carries its carrier session,
agent, Site, authority, request, and exact action-admission decision. A refused,
deferred, or routed decision returns without entering the surface handler.

The engine validates request and declared response schemas. A generic approval
to connect to the runtime, loader, or service never authorizes a nested tool
effect.

Carrier sessions release their handles explicitly when the NARS capability
gateway closes. The Site service also expires idle handles after a bounded
interval (15 minutes by default). Releasing the final handle disposes the
worker and removes the logical instance, so authority sharing does not imply
unbounded process or state retention.

## Replacement

Generation replacement is available only when the projection explicitly says
`generation_swap` and uses `surface_factory`. The candidate must match the
admitted tool-contract digest, start healthy, expose the exact tool inventory,
and return a compatible replacement assessment that does not require state
migration. The request must name the expected active generation, and only one
replacement may run per logical instance. Calls pause at an explicit barrier
while the old generation drains. Failure leaves the old generation
authoritative.

Manual bindings remain manual. No descriptor lifecycle label, file mtime, or
successful build implicitly grants hot replacement.

The Narada PC Site service owns the explicit authenticated replacement
actuator. Its request identifies the Site authority, exact factory projection,
logical instance, expected active generation, request ID, and operator reason;
it does not accept an arbitrary module path. The service rereads the
registrar-generated Site registry and uses its entrypoint and tool-contract
digest as candidate authority. Outcomes are retained in bounded authenticated
status and appended to the Site-local replacement event log. A compatible
implementation-only replacement therefore needs no carrier restart, while a
descriptor or tool-contract change still requires normal registrar review and
materialization and is not smuggled through generation replacement.

## Compatibility And Migration

`mcp-loader` remains the stdio compatibility client/adapter. It reports the
execution posture and refuses `surface_factory` projections rather than
mislaunching them as stdio. Existing static and progressive bindings continue
unchanged because their posture defaults to stdio/session/manual.

Migration is surface-by-surface:

1. Keep the descriptor on the conservative defaults.
2. Add a package-owned factory beside the existing stdio entrypoint.
3. Prove handler parity, state ownership, cancellation, crash isolation, and
   rollback.
4. Opt one projection into `surface_factory`; keep stdio as the rollback path.
5. Opt into `authority_shared` only after cross-session and cross-authority
   tests pass.
6. Opt into `generation_swap` only after compatibility assessment and drain
   behavior pass.

The proof suites cover a read-only factory, a real SQLite-backed factory,
two carrier sessions sharing one authority, different-authority isolation,
refusal before mutation, session isolation, compatible and refused swaps,
worker crash isolation, real stdio fallback and factory restoration, plus
external-watchdog recovery after a deliberate service stop.

## Narada Integration Boundary

The PC Site service is implemented in Narada proper and is supervised by the
existing host lifecycle. It resolves an admitted Site binding, authenticates a
carrier session, asks Carrier Action Admission for the exact tool, then invokes
this engine. NARS calls continue to cross `createNarsCapabilityGateway`; the
gateway may use the Site service as a dispatch backend only after admission.

The service may expose local Streamable HTTP and a bounded stdio bridge for
carriers that cannot connect directly. Transport does not change authority,
tenancy, or effect admission.

The launcher canary is admitted only through NARS, uses the authenticated Site
service, has explicit session release and bounded idle eviction, and retains
the stdio projection for rollback. An external hidden watchdog invokes the
service's idempotent `ensure` command; it does not own tool admission or runtime
state. Wider production adoption remains
surface-by-surface and requires the same live E2E, authority, lifecycle,
supervisor, and rollback evidence. Factory execution is not a repository-wide
default.
