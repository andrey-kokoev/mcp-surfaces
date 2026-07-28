import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ['catalog_observation_guidance', 'catalog_observation_observe'] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'catalog-observation',
    surface_version: '0.1.0',
    package: '@narada2/catalog-observation-mcp',
    entrypoint: '{mcp_surfaces_root}/catalog-observation-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'read',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: [], env: [] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: 'Catalog observations are read-only point-in-time evidence.' },
    }],
  });
}
