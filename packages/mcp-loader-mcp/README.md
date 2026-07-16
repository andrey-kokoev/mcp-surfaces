# @narada2/mcp-loader-mcp

Policy-gated runtime attachment and proxying for MCP surfaces admitted by a Site fabric.

## Guidance

Use mcp_loader_guidance for model-facing orientation, workflow selection, recovery guidance, and loader boundaries. Use the standard child tools/list response, mcp_loader_list_tools, or mcp_loader_tool_discovery_manifest for exact attached-tool interface schemas.

Every loader lifecycle projection uses the `narada.mcp_loader.runtime_lifecycle.v1` shape. Attached responses expose `runtime_lifecycle` with `managed_by: "mcp-loader"`, `restartable: true`, and connection-scoped inspect/restart actions. Pre-attachment guidance exposes the same shape with `restartable: null` and `restartability_status: "available_after_successful_attach"`. Inspect `mcp_loader_surface_status` or `mcp_loader_connection_inventory`, then call `mcp_loader_surface_restart({ connection_id, reason })` to replace only the child process. The agent session does not need to restart. Child-surface domain policy remains authoritative, and restart invalidates refs owned by the replaced child.

When a proxied child guidance tool is called, its `structuredContent` is augmented with `loader_runtime_lifecycle` and `loader_runtime_freshness`, so the attached surface guidance itself advertises loader ownership and recovery.

## Loader Runtime Freshness

A long-lived loader process can outlive a source or runtime rebuild. Call `mcp_loader_runtime_status` to compare the running loader entrypoint and source entrypoint with the loader process start time. `status: "stale"` means the loader process must be restarted through its carrier or runtime supervisor; `mcp_loader_surface_restart` replaces only an attached child and does not hot-reload the loader. `status: "unknown"` means the freshness evidence is unavailable and should not be treated as current.

## Live Tool Inventory

`mcp_loader_site_tool_inventory_check` starts fresh child surfaces, compares each live `tools/list` response with the Site fabric, and materializes the complete observation as an immutable `mcp_payload` ref. Pass the returned `observation_ref` to `registrar_site_registry_conformance_check`; do not copy the three observation maps into a new request.

Inventory observations use the `site-tools-` payload-id namespace. Loader retains at most 32 observations per Site and removes observations older than seven days. Each result includes `observation_retention` with the applied limits and removals.

## Runtime-Affined Projections

Site fabric entries may declare `surface_projection.runtime_requirements`. The loader never infers a runtime from the entrypoint, process name, or current directory. `mcp_loader_attach_surface` and `mcp_loader_site_tool_inventory_check` accept an explicit `runtime_kind`; omitting it selects only runtime-neutral projections, while a runtime-affined surface is refused with `surface_runtime_required`. A supplied but incompatible runtime is refused with `surface_runtime_not_supported`.

Inventory results carry `runtime_kind` and `runtime_skipped_surface_ids`. A skipped runtime-affined surface is reported as `runtime_not_selected`, not as a missing or drifted surface. To inspect the NARS projection, pass `runtime_kind: "nars"`.

Attached child surfaces receive `NARADA_SITE_ROOT` set to the requested `site_root`. This is the authoritative Site binding for the child process; the loader does not let an ambient caller Site root override it.

The loader also preserves a narrow, explicit carrier-context allowlist for child surfaces that need caller identity or session binding: `NARADA_AGENT_ID`, `NARADA_OPERATOR_ID`, `NARADA_NARS_SESSION_SOURCE_KIND`, `NARADA_CARRIER_SESSION_ID`, and `NARADA_SITE_ID`. These values identify the caller context; they do not grant authority or bypass the attached surface's own policy.

Surface requests resolve by exact declared `surface_id` metadata or exact fabric server key. The loader does not derive one identifier from another by name parsing.

The payload's declared creator and id namespace are lineage hints and accidental-misrouting guards, not cryptographic provenance or policy authority.

## Boundary

MCP Loader owns child attachment, initialization, tool discovery, call proxying, and detachment. It does not own the attached surfaces, authorize their domain operations, or materialize the Site action-admission registry.
