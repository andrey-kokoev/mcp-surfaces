# Runtime Introspection MCP

Read-only analysis of runtime traces and authority-bound MCP memory evidence. Memory tools resolve only the server-bound `NARADA_SITE_ROOT` and open the canonical observer SQLite database read-only; callers cannot supply arbitrary roots or database paths.

Start with `runtime_introspection_guidance`, then use `runtime_introspection_memory_status` before owner, timeline, attribution, or incident reads. A stale or unavailable observer is reported explicitly. This surface never restarts runtimes, writes incident review state, or captures heap snapshots.
