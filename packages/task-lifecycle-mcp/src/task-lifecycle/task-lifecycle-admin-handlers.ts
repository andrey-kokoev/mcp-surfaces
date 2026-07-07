export const TASK_LIFECYCLE_ADMIN_TOOL_NAMES = Object.freeze([
  'task_lifecycle_doctor',
  'task_lifecycle_restart',
]);

export function createTaskLifecycleAdminHandlers({
  jsonToolResult,
  getRegisteredTools,
  getSiteRoot,
  getToolAliases,
  getSitePolicy,
  buildTaskLifecycleFreshness,
  buildLifecycleTargetLocusStatus,
  taskLifecycleRestart,
}) {
  return {
    task_lifecycle_doctor: (args: any = {}) => {
      const registeredTools = getRegisteredTools();
      const deprecatedAliases = getToolAliases();
      const sitePolicy = getSitePolicy();
      const mcpFreshness = buildTaskLifecycleFreshness({ registeredTools });
      const targetLocusGuard = buildLifecycleTargetLocusStatus();
      const full = args?.verbose === true || args?.detail === 'full';
      if (!full) {
        return jsonToolResult({
          schema: 'narada.task_lifecycle.doctor.v1',
          status: 'ok',
          detail: 'summary',
          site_root: getSiteRoot(),
          authority_posture: 'facade_only',
          surface_type: 'task_lifecycle_mcp',
          tool_posture: {
            canonical_count: registeredTools.length,
            deprecated_alias_count: Object.keys(deprecatedAliases).length,
          },
          site_policy: {
            source: sitePolicy?.source ?? 'unknown',
            roster: {
              roles_are_obligation_targets: sitePolicy?.roster?.roles_are_obligation_targets === true,
            },
          },
          mcp_freshness: {
            schema: mcpFreshness?.schema,
            pending_restart: mcpFreshness?.pending_restart === true,
            stale_live_surface_possible: mcpFreshness?.stale_live_surface_possible === true,
            source_digest_changed: mcpFreshness?.source_digest_changed === true,
            restart_request_state: mcpFreshness?.restart_request?.state ?? null,
            tool_surface: {
              expected_count: mcpFreshness?.tool_surface?.expected_count ?? null,
              registered_count: mcpFreshness?.tool_surface?.registered_count ?? null,
              missing_expected_count: Array.isArray(mcpFreshness?.tool_surface?.missing_expected_tools) ? mcpFreshness.tool_surface.missing_expected_tools.length : null,
            },
          },
          target_locus_guard: {
            schema: targetLocusGuard?.schema,
            status: targetLocusGuard?.status ?? 'unknown',
            explicit_target_site_root_supported: targetLocusGuard?.explicit_target_site_root_supported === true,
          },
          full_detail_hint: { verbose: true, detail: 'full' },
        });
      }
      return jsonToolResult({
        schema: 'narada.task_lifecycle.doctor.v1',
        status: 'ok',
        detail: 'full',
        site_root: getSiteRoot(),
        authority_posture: 'facade_only',
        surface_type: 'task_lifecycle_mcp',
        canonical_tools: registeredTools,
        deprecated_aliases: deprecatedAliases,
        allowed_tools: registeredTools,
        site_policy: sitePolicy,
        mcp_freshness: mcpFreshness,
        target_locus_guard: targetLocusGuard,
        conceptual_role: {
          execution_context_relation: 'available MCP tool surface',
          intelligence_context_relation: 'materializes task/work context for evaluation',
          authority_state_relation: 'local task lifecycle authority state',
        },
      });
    },
    task_lifecycle_restart: (args) => jsonToolResult(taskLifecycleRestart(args)),
  };
}
