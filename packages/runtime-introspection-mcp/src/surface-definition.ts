import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada-core/mcp-fabric-contracts';
import { listTools } from './main.js';

export function surfaceDefinition(): DefinedSurface {
  const tools = listTools() as McpToolDefinition[];
  return defineNativeSurface({
    surface_id: 'runtime-introspection',
    surface_version: '0.1.0',
    package: '@narada-core/runtime-introspection-mcp',
    entrypoint: '{mcp_surfaces_root}/runtime-introspection-mcp/dist/src/main.js',
    tools,
    read_only_tools: tools.map((tool) => tool.name),
    default_effect: 'read',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: [], env: ['NARADA_SITE_ROOT', 'NARADA_SITE_ID'] },
      injection_scope: 'user_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.user_site'],
      lifecycle: { mode: 'replayable', reason: 'The surface is a read-only view over canonical Site evidence and holds no runtime authority.' },
    }],
  });
}
