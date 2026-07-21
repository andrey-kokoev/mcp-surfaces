import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = [
  'quota_meter_guidance',
  'quota_meter_glide_status',
  'quota_meter_overlay_status',
] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'quota-meter',
    surface_version: '0.1.0',
    package: '@narada2/quota-meter-mcp',
    entrypoint: '{mcp_surfaces_root}/quota-meter-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'runtime_admin',
    projections: [{
      id: 'default',
      transport: {
        kind: 'stdio',
        command: 'node',
        args: [],
        env: ['QUOTA_METER_ROOT', 'QUOTA_METER_NODE', 'QUOTA_METER_STATE_ROOT'],
      },
      injection_scope: 'host',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.host'],
      lifecycle: { mode: 'replayable', reason: 'The MCP process holds no durable session state; quota-meter owns the overlay process and persisted position.' },
    }],
  });
}
