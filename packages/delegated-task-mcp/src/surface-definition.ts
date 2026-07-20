import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["delegated_task_guidance","delegated_task_policy_inspect","delegated_task_template_catalog","delegated_task_validate","delegated_task_status","delegated_task_summary","delegated_task_result","delegated_task_wait","delegated_task_events","delegated_tasks_list"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'delegated-task',
    surface_version: '0.1.0',
    package: '@narada2/delegated-task-mcp',
    entrypoint: '{mcp_surfaces_root}/delegated-task-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ["--site-root","{site_root}","--task-root","{site_root}","--allowed-root","{workspace_root}"], env: [] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: "Durable delegated-task records are authoritative; the adapter does not own a session." },
    }],
  });
}
