# MCP Runtime Memory Observation

MCP runtime memory observation is an authority-bound evidence plane. It covers the PC Site surface service, factory workers, carrier proxies, loader/NARS stdio children, their known descendants, and the observer itself. Carrier applications and unrelated Narada processes are outside scope.

## Shape

Participating runtimes emit sanitized ownership and lifecycle JSONL records through `@narada-core/mcp-runtime-observation`. The canonical producer root is `<site-root>/.narada/runtime/mcp-runtime-observer/sources/`. Emission is mandatory for participating runtime code but best-effort: observation failure never refuses a tool, changes admission, or actuates lifecycle.

The dedicated Rust `@narada-core/pc-site-runtime-observer` process is the only writer of `observations.db`. It deduplicates registered PIDs, discovers only their descendants, validates process creation time to expose PID reuse, samples Windows process memory/handles/threads/CPU, and fetches worker-isolate V8 counters from the authenticated PC Site surface service. It measures itself as `observer_overhead`.

Normal sampling is every 10 seconds. A lifecycle change selects one-second sampling for 60 seconds. Raw samples remain for seven days and one-minute rollups for 90 days; incidents remain until explicit review. Imported source segments are retained as additional evidence rather than automatically deleted.

## Detection and attribution

Process private-memory growth requires at least six samples spanning one minute, growth of at least `max(32 MiB, 20% baseline)`, at least 1 MiB/min over 15 minutes, and three consecutive qualifying evaluations. Worker heap growth uses `max(16 MiB, 25% baseline)`, 0.5 MiB/min over ten minutes, and the same confirmation rule. Separate detectors cover post-release residual memory, handle growth of 256, and thread growth of eight.

Attribution is direct at 70% or more, partial from 40–70%, and residual below 40%. `arrayBuffers` is shown as evidence but is not added to `external`, avoiding false double-counting.

Detections only create sanitized reports. They do not restart, replace, detach, or kill anything. Heap snapshots are never automatic; the authenticated service requires an incident ID, reason, target, expected generation for a worker, and an explicit size cap.

## Reading evidence

`runtime-introspection-mcp` reads the canonical server-bound Site database read-only through:

- `runtime_introspection_memory_status`
- `runtime_introspection_memory_owners`
- `runtime_introspection_memory_timeline`
- `runtime_introspection_memory_attribution`
- `runtime_introspection_memory_incidents`
- `runtime_introspection_memory_incident_show`

These tools accept no database or Site-root path. A missing or stale observer is reported explicitly rather than inferred as healthy.
