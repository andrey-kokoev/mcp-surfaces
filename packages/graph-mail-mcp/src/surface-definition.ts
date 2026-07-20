import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["graph_mail_guidance","graph_mail_doctor","graph_mail_auth_status","graph_mail_query","graph_mail_message_show","graph_mail_output_show","graph_mail_folder_list","graph_mail_attachment_list","graph_mail_attachment_get"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'graph-mail',
    surface_version: '0.1.0',
    package: '@narada2/graph-mail-mcp',
    entrypoint: '{mcp_surfaces_root}/graph-mail-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'external_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ["--site-root","{site_root}"], env: [] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: "Graph requests are independently authorized and do not expose a session-pinned protocol." },
    }],
  });
}
