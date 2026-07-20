import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["site_registry_guidance","site_registry_doctor","site_registry_command_map","site_registry_list","site_registry_show","site_registry_discover_plan"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'site-registry',
    surface_version: '0.1.0',
    package: '@narada2/site-registry-mcp',
    entrypoint: '{mcp_surfaces_root}/site-registry-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ["--narada-root","{site_root}"], env: [] },
      injection_scope: 'user_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.user_site'],
      lifecycle: { mode: 'replayable', reason: "Registry reads and plans are persisted/read from the User Site and are independently reproducible." },
    }],
  });
}
