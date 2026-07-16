export const LOADER_RUNTIME_LIFECYCLE_SCHEMA = 'narada.mcp_loader.runtime_lifecycle.v1' as const;

export type LoaderRuntimeLifecycle = {
  schema: typeof LOADER_RUNTIME_LIFECYCLE_SCHEMA;
  managed_by: 'mcp-loader';
  restartable: boolean | null;
  restartability_status: 'available' | 'available_after_successful_attach';
  restart_scope: 'attached_child_process';
  session_restart_required: false;
  connection_id_required: true;
  inventory_tool: 'mcp_loader_connection_inventory';
  status_tool: 'mcp_loader_surface_status';
  restart_tool: 'mcp_loader_surface_restart';
  guidance: string;
  actions?: {
    inspect: {
      tool_name: 'mcp_loader_surface_status';
      arguments: { connection_id: string };
    };
    restart: {
      tool_name: 'mcp_loader_surface_restart';
      arguments: { connection_id: string };
    };
  };
};

export function loaderRuntimeLifecycle(connectionId?: string): LoaderRuntimeLifecycle {
  const attached = typeof connectionId === 'string' && connectionId.length > 0;
  const lifecycle: LoaderRuntimeLifecycle = {
    schema: LOADER_RUNTIME_LIFECYCLE_SCHEMA,
    managed_by: 'mcp-loader',
    restartable: attached ? true : null,
    restartability_status: attached ? 'available' : 'available_after_successful_attach',
    restart_scope: 'attached_child_process',
    session_restart_required: false,
    connection_id_required: true,
    inventory_tool: 'mcp_loader_connection_inventory',
    status_tool: 'mcp_loader_surface_status',
    restart_tool: 'mcp_loader_surface_restart',
    guidance: 'Restart replaces only the attached child surface process; it does not restart the agent session or reload the mcp-loader process.',
  };
  if (attached) {
    lifecycle.actions = {
      inspect: { tool_name: 'mcp_loader_surface_status', arguments: { connection_id: connectionId } },
      restart: { tool_name: 'mcp_loader_surface_restart', arguments: { connection_id: connectionId } },
    };
  }
  return lifecycle;
}
