import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["inbox_guidance","inbox_doctor","inbox_list","inbox_show","inbox_audit","inbox_next","capa_queue","inbox_output_show"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'site-inbox',
    surface_version: '0.1.0',
    package: '@narada2/site-inbox-mcp',
    entrypoint: '{mcp_surfaces_root}/site-inbox-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ["--site-root","{site_root}"], env: [] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: "Inbox state is persisted by the Site and calls do not depend on an in-process session." },
    }],
  });
}
