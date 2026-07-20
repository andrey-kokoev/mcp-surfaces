import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["site_coherence_guidance","site_coherence_check","site_coherence_doctor"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'site-coherence',
    surface_version: '0.1.0',
    package: '@narada2/site-coherence-mcp',
    entrypoint: '{mcp_surfaces_root}/site-coherence-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'read',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ["--repo-root","D:/code/narada"], env: [] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: "Coherence checks are read-only observations." },
    }],
  });
}
