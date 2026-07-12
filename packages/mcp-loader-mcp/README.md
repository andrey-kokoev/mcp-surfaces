# @narada2/mcp-loader-mcp

Policy-gated runtime attachment and proxying for MCP surfaces admitted by a Site fabric.

## Live Tool Inventory

`mcp_loader_site_tool_inventory_check` starts fresh child surfaces, compares each live `tools/list` response with the Site fabric, and materializes the complete observation as an immutable `mcp_payload` ref. Pass the returned `observation_ref` to `registrar_site_registry_conformance_check`; do not copy the three observation maps into a new request.

Inventory observations use the `site-tools-` payload-id namespace. Loader retains at most 32 observations per Site and removes observations older than seven days. Each result includes `observation_retention` with the applied limits and removals.

## Runtime-Affined Projections

Site fabric entries may declare `surface_projection.runtime_requirements`. The loader never infers a runtime from the entrypoint, process name, or current directory. `mcp_loader_attach_surface` and `mcp_loader_site_tool_inventory_check` accept an explicit `runtime_kind`; omitting it selects only runtime-neutral projections, while a runtime-affined surface is refused with `surface_runtime_required`. A supplied but incompatible runtime is refused with `surface_runtime_not_supported`.

Inventory results carry `runtime_kind` and `runtime_skipped_surface_ids`. A skipped runtime-affined surface is reported as `runtime_not_selected`, not as a missing or drifted surface. To inspect the NARS projection, pass `runtime_kind: "nars"`.

Surface requests resolve by exact declared `surface_id` metadata or exact fabric server key. The loader does not derive one identifier from another by name parsing.

The payload's declared creator and id namespace are lineage hints and accidental-misrouting guards, not cryptographic provenance or policy authority.

## Boundary

MCP Loader owns child attachment, initialization, tool discovery, call proxying, and detachment. It does not own the attached surfaces, authorize their domain operations, or materialize the Site action-admission registry.
