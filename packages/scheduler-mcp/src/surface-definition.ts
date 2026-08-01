import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada-core/mcp-fabric-contracts';
import { listTools } from './main.js';

export function surfaceDefinition(): DefinedSurface {
  const tools = listTools() as McpToolDefinition[];
  return defineNativeSurface({
    surface_id: 'scheduler',
    surface_version: '0.1.0',
    package: '@narada-core/scheduler-mcp',
    entrypoint: '{mcp_surfaces_root}/scheduler-mcp/dist/src/main.js',
    tools,
    read_only_tools: tools
      .filter((tool) => tool.annotations?.readOnlyHint)
      .map((tool) => tool.name),
    default_effect: 'runtime_admin',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ['--allowed-root', '{site_root}'], env: [] },
      injection_scope: 'local_site',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: "Task Scheduler is the authority; the MCP process holds no durable session state." },
    }],
  });
}
