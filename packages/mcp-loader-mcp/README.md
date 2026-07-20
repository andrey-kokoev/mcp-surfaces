# @narada2/mcp-loader-mcp

Policy-gated runtime attachment and proxying for MCP surfaces admitted by a Site fabric.

## Guidance

Use mcp_loader_guidance for model-facing orientation, workflow selection, recovery guidance, and loader boundaries. Use the standard child tools/list response, mcp_loader_list_tools, or mcp_loader_tool_discovery_manifest for exact attached-tool interface schemas.

Every loader lifecycle projection uses the `narada.mcp_loader.runtime_lifecycle.v1` shape. Attached responses expose `runtime_lifecycle` with `managed_by: "mcp-loader"`, `restartable: true`, connection-scoped inspect/restart actions, and a machine-readable `loader_restart_action` describing the carrier/runtime-supervisor operation required to restart the loader itself. Its `next_call.tool_name` is the external supervisor capability `restart_mcp_loader_process`; it is deliberately not a child-surface tool and is not implemented by the loader process itself. Pre-attachment guidance exposes the same shape with `restartable: null` and `restartability_status: "available_after_successful_attach"`. Inspect `mcp_loader_surface_status` or `mcp_loader_connection_inventory`, then call `mcp_loader_surface_restart({ connection_id, reason })` to replace only the child process. The agent session does not need to restart. Child-surface domain policy remains authoritative, and restart invalidates refs owned by the replaced child.

When a proxied child guidance tool is called, its `structuredContent` is augmented with `loader_runtime_lifecycle` and `loader_runtime_freshness`, so the attached surface guidance itself advertises loader ownership and recovery.

## Runtime observation

Call `mcp_loader_runtime_observation({ connection_id, carrier_kind })` after attach to obtain `RuntimeObservationV2`. The result includes stable logical identity, active generation state, heartbeat/lease freshness, descriptor and live tool-contract digests, lifecycle eligibility, and one bounded recovery actuator. A replayable child names `mcp_loader_surface_restart`; a session-pinned or restart-required projection names the carrier supervisor capability. The loader reports `runtime_state_root: null` because persistent observation records belong to the generic runtime-proxy observation store or another explicitly configured owner.

## Tool Call Timeouts

`mcp_loader_call_tool` forwards the nested `arguments` object unchanged. When `arguments` include `timeout_ms`, the child tool bounds itself at that value and the loader honors it up to its bounded maximum (`--tool-call-timeout-ms`, default 120000, max 900000). The loader's own outer wait deadline is the declared timeout plus a bounded grace (`--tool-timeout-grace-ms`, default 1000 ms, max 60000 ms), including at the maximum; the outer deadline may therefore reach 960000 ms. This lets a child return its own bounded timeout result instead of losing the race to the loader's `child_timeout` error. Calls without a nested `timeout_ms` are bounded by the policy default with no grace; the loader's deadline is the only timer.

The full timeout stack, shortest to longest: the tool's own `timeout_ms` < the loader's outer deadline (tool timeout + grace) < the runtime proxy watchdog (`--request-timeout-ms`). The proxy never interprets tool arguments; a caller that owns a surface-level timeout carries it in the transport-level `params._meta.narada_request_timeout_ms` field, and the proxy waits for that transport timeout plus its own bounded grace (`--tool-timeout-grace-ms`). Each layer yields to the layer below it, so a bounded tool returns its own result and the transport survives.


## Loader Runtime Freshness

A long-lived loader process can outlive a source, dependency, build-configuration, or runtime rebuild. Call `mcp_loader_runtime_status` to compare the running loader files with their source files and to inspect dependency/configuration evidence. `status: "stale"` means the loader process must be restarted through its carrier or runtime supervisor; invoke `reload_action.next_call` (`restart_mcp_loader_process`) through that supervisor. `mcp_loader_surface_restart` replaces only an attached child and does not hot-reload the loader. `status: "unknown"` means required freshness evidence is unavailable and should not be treated as current.

The default allowed roots and entrypoint prefixes derive from the loader's resolved surfaces root, the active `NARADA_SITE_ROOT`, optional `NARADA_MCP_ALLOWED_SITE_ROOTS`/`NARADA_MCP_ALLOWED_ENTRYPOINT_PREFIXES`, and the current user's Narada root. They do not depend on a fixed checkout path or User Site identifier.

## Live Tool Inventory

`mcp_loader_site_tool_inventory_check` starts fresh child surfaces, compares each live `tools/list` response with the Site fabric, and materializes the complete observation as an immutable `mcp_payload` ref. Its compact model-facing result includes each finding's status plus bounded missing, extra, duplicate, and unclassified tool names; probe failures include their diagnostic. Pass the returned `observation_ref` to `registrar_site_registry_conformance_check`; do not copy the observation maps into a new request.

Inventory observations use the `site-tools-` payload-id namespace. Loader retains at most 32 observations per Site and removes observations older than seven days. Each result includes `observation_retention` with the applied limits and removals. If a runtime-affined surface is skipped because no compatible `runtime_kind` was supplied, the overall observation status is `partial`, never `ok`; pass the required runtime kind for complete coverage.

Site fabric resolution prefers a non-empty `.ai/mcp/config.json`. When that compatibility path exists but declares no MCP servers, the loader falls through to the canonical Site aggregate or fragments; the empty file is used only when no aggregate exists. This prevents retired empty sidecars from shadowing the active fabric while preserving intentionally empty Sites.

## Runtime-Affined Projections

Site fabric entries may declare `surface_projection.runtime_requirements`. The loader never infers a runtime from the entrypoint, process name, or current directory. `mcp_loader_attach_surface` and `mcp_loader_site_tool_inventory_check` accept an explicit `runtime_kind`; omitting it selects only runtime-neutral projections, while a runtime-affined surface is refused with `surface_runtime_required`. A supplied but incompatible runtime is refused with `surface_runtime_not_supported`.

Inventory results carry `runtime_kind` and `runtime_skipped_surface_ids`. A skipped runtime-affined surface is reported as `runtime_not_selected` at finding level and makes the aggregate observation `partial`, not as a missing or drifted surface. To inspect the NARS projection, pass `runtime_kind: "nars"`.

Attached child surfaces receive `NARADA_SITE_ROOT` set to the requested `site_root`. This is the authoritative Site binding for the child process; the loader does not let an ambient caller Site root override it.

The loader also preserves a narrow, explicit carrier-context allowlist for child surfaces that need caller identity or session binding: `NARADA_AGENT_ID`, `NARADA_OPERATOR_ID`, `NARADA_NARS_SESSION_SOURCE_KIND`, `NARADA_CARRIER_SESSION_ID`, and `NARADA_SITE_ID`. These values identify the caller context; they do not grant authority or bypass the attached surface's own policy.

Surface requests resolve by exact declared `surface_id` metadata or exact fabric server key. The loader does not derive one identifier from another by name parsing.

The payload's declared creator and id namespace are lineage hints and accidental-misrouting guards, not cryptographic provenance or policy authority.

## Boundary

MCP Loader owns child attachment, initialization, tool discovery, call proxying, and detachment. It does not own the attached surfaces, authorize their domain operations, or materialize the Site action-admission registry.