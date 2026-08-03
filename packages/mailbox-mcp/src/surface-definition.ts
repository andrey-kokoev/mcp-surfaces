import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada-core/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = [
  'mailbox_guidance', 'mailbox_doctor', 'mailbox_accounts_list',
  'mailbox_messages_list', 'mailbox_message_show', 'mailbox_output_show',
  'mailbox_fact_show',
  'mailbox_admission_show',
  'mailbox_search', 'mailbox_thread_show', 'mailbox_generation_show',
  'mailbox_outbox_list',
] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'mailbox',
    surface_version: '0.2.0',
    package: '@narada-core/mailbox-mcp',
    entrypoint: '{mcp_surfaces_root}/mailbox-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
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
      lifecycle: { mode: 'replayable', reason: 'Mailbox reads are replayable; mutation tools enforce durable operation keys, leases, and receipts.' },
    }],
  });
}
