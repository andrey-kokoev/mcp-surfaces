import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["operator_routing_guidance","operator_route_doctor"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'operator-routing',
    surface_version: '0.1.0',
    package: '@narada2/operator-routing-mcp',
    entrypoint: '{mcp_surfaces_root}/operator-routing-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ["--site-root","{site_root}"], env: [] },
      injection_scope: 'user_site',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.user_site'],
      lifecycle: { mode: 'replayable', reason: "Routing decisions are durable operator records rather than protocol session state." },
    }],
  });
}
