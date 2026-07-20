import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = [
  'mailbox_guidance', 'mailbox_doctor', 'mailbox_accounts_list',
  'mailbox_messages_list', 'mailbox_message_show', 'mailbox_output_show',
  'mailbox_search', 'mailbox_thread_show',
] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'mailbox',
    surface_version: '0.1.0',
    package: '@narada2/mailbox-mcp',
    entrypoint: '{mcp_surfaces_root}/mailbox-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'read',
    projections: [{
      id: 'stdio',
      transport: {
        kind: 'stdio',
        command: 'node',
        args: ['--site-root', '{site_root}'],
        env: [],
      },
      injection_scope: 'local_site',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'replayable', reason: 'Mailbox reads are safe to replay against the synced projection.' },
    }],
  });
}
