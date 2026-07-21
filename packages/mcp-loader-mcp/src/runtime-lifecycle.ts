export const LOADER_RUNTIME_LIFECYCLE_SCHEMA = 'narada.mcp_loader.runtime_lifecycle.v1' as const;
export const LOADER_SUPERVISOR_RESTART_ACTION_SCHEMA = 'narada.mcp_loader.supervisor_restart_action.v1' as const;

export type LoaderSupervisorRestartAction = {
  schema: typeof LOADER_SUPERVISOR_RESTART_ACTION_SCHEMA;
  kind: 'restart_loader_process';
  target: 'mcp-loader-process';
  owner: 'carrier_or_runtime_supervisor';
  operation: 'restart';
  capability: 'restart_mcp_loader_process';
  tool_name: 'restart_mcp_loader_process';
  arguments: Record<string, never>;
  actuator_scope: 'external_supervisor_capability';
  agent_callable: false;
  availability: 'external_supervisor_only';
  invocation_note: string;
  next_call: {
    tool_name: 'restart_mcp_loader_process';
    arguments: Record<string, never>;
  };
  connection_id_required: false;
  session_restart_required: false;
};

export function loaderSupervisorRestartAction(): LoaderSupervisorRestartAction {
  return {
    schema: LOADER_SUPERVISOR_RESTART_ACTION_SCHEMA,
    kind: 'restart_loader_process',
    target: 'mcp-loader-process',
    owner: 'carrier_or_runtime_supervisor',
    operation: 'restart',
    capability: 'restart_mcp_loader_process',
    tool_name: 'restart_mcp_loader_process',
    arguments: {},
    actuator_scope: 'external_supervisor_capability',
    agent_callable: false,
    availability: 'external_supervisor_only',
    invocation_note: 'This is a carrier/runtime-supervisor capability name, not a tool exposed by mcp-loader. The agent must call the carrier supervisor only when that capability is separately present.',
    next_call: {
      tool_name: 'restart_mcp_loader_process',
      arguments: {},
    },
    connection_id_required: false,
    session_restart_required: false,
  };
}

export type LoaderRuntimeLifecycle = {
  schema: typeof LOADER_RUNTIME_LIFECYCLE_SCHEMA;
  managed_by: 'mcp-loader';
  restartable: boolean | null;
  restartability_status: 'available' | 'available_after_successful_attach' | 'unavailable_for_lifecycle';
  restart_scope: 'attached_child_process' | 'carrier_supervisor';
  session_restart_required: false;
  connection_id_required: true;
  inventory_tool: 'mcp_loader_connection_inventory';
  status_tool: 'mcp_loader_surface_status';
  restart_tool: 'mcp_loader_surface_restart' | null;
  loader_restart_action: LoaderSupervisorRestartAction;
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

export function loaderRuntimeLifecycle(
  connectionId?: string,
  lifecycleRequirement?: { mode: 'replayable' | 'session_pinned' | 'restart_required'; reason?: string },
): LoaderRuntimeLifecycle {
  const attached = typeof connectionId === 'string' && connectionId.length > 0;
  const replayable = lifecycleRequirement?.mode === 'replayable';
  const nonReplayable = attached && lifecycleRequirement !== undefined && !replayable;
  const lifecycle: LoaderRuntimeLifecycle = {
    schema: LOADER_RUNTIME_LIFECYCLE_SCHEMA,
    managed_by: 'mcp-loader',
    restartable: nonReplayable ? false : attached ? true : null,
    restartability_status: nonReplayable
      ? 'unavailable_for_lifecycle'
      : attached ? 'available' : 'available_after_successful_attach',
    restart_scope: nonReplayable ? 'carrier_supervisor' : 'attached_child_process',
    session_restart_required: false,
    connection_id_required: true,
    inventory_tool: 'mcp_loader_connection_inventory',
    status_tool: 'mcp_loader_surface_status',
    restart_tool: nonReplayable ? null : 'mcp_loader_surface_restart',
    loader_restart_action: loaderSupervisorRestartAction(),
    guidance: nonReplayable
      ? `This projection declares lifecycle mode ${lifecycleRequirement?.mode}; mcp-loader must not replace its child. Ask the carrier or runtime supervisor to invoke restart_mcp_loader_process, then reconnect the surface.`
      : 'Restart replaces only the attached child surface process; it does not restart the agent session or reload the mcp-loader process.',
  };
  if (attached && replayable) {
    lifecycle.actions = {
      inspect: { tool_name: 'mcp_loader_surface_status', arguments: { connection_id: connectionId } },
      restart: { tool_name: 'mcp_loader_surface_restart', arguments: { connection_id: connectionId } },
    };
  }
  return lifecycle;
}
