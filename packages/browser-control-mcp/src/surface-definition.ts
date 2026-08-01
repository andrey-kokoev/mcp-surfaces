import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada-core/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = [
  'browser_control_guidance',
  'browser_control_session_inventory',
  'browser_control_status',
  'browser_control_accessibility_snapshot',
  'browser_control_screenshot',
  'browser_control_assert',
  'mcp_output_show',
] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'browser-control',
    surface_version: '0.1.0',
    package: '@narada-core/browser-control-mcp',
    entrypoint: '{mcp_surfaces_root}/browser-control-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'runtime_admin',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: [], env: [] },
      injection_scope: 'host',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.host'],
      lifecycle: {
        mode: 'restart_required',
        restart_owner: 'host',
        reason: 'The browser session is host-owned and this surface must reconnect after a carrier restart.',
      },
    }],
  });
}
