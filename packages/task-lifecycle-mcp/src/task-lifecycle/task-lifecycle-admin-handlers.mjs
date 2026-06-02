export const TASK_LIFECYCLE_ADMIN_TOOL_NAMES = Object.freeze([
  'task_lifecycle_doctor',
  'task_lifecycle_restart',
]);

export function createTaskLifecycleAdminHandlers({
  jsonToolResult,
  getRegisteredTools,
  getSiteRoot,
  getToolAliases,
  buildTaskLifecycleFreshness,
  buildLifecycleTargetLocusStatus,
  taskLifecycleRestart,
}) {
  return {
    task_lifecycle_doctor: () => {
      const registeredTools = getRegisteredTools();
      return jsonToolResult({
        status: 'ok',
        site_root: getSiteRoot(),
        authority_posture: 'facade_only',
        surface_type: 'task_lifecycle_mcp',
        canonical_tools: registeredTools,
        deprecated_aliases: getToolAliases(),
        allowed_tools: registeredTools,
        mcp_freshness: buildTaskLifecycleFreshness({ registeredTools }),
        target_locus_guard: buildLifecycleTargetLocusStatus(),
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
