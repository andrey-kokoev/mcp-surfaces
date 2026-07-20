import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["artifacts_guidance","artifacts_doctor","artifact_list","artifact_read","artifact_message_part_create"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'artifacts',
    surface_version: '0.1.0',
    package: '@narada2/artifacts-mcp',
    entrypoint: '{mcp_surfaces_root}/artifacts-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: [], env: ['NARADA_SESSION_ID', 'NARADA_SITE_ROOT', 'NARADA_NARS_BASE_URL'] },
      injection_scope: 'local_site',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: "Artifacts are registered in durable Site/session storage and can be reattached safely." },
    }],
  });
}
