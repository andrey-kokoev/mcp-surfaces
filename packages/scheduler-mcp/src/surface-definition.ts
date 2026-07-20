import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["scheduler_guidance","scheduler_task_list","scheduler_task_show","scheduler_task_history"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'scheduler',
    surface_version: '0.1.0',
    package: '@narada2/scheduler-mcp',
    entrypoint: '{mcp_surfaces_root}/scheduler-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'runtime_admin',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: [], env: [] },
      injection_scope: 'local_site',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: "Task Scheduler is the authority; the MCP process holds no durable session state." },
    }],
  });
}
