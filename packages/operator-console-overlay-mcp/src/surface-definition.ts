import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = [
  'operator_console_overlay_guidance',
  'operator_console_overlay_status',
] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'operator-console-overlay',
    surface_version: '0.2.0',
    package: '@narada2/operator-console-overlay-mcp',
    entrypoint: '{mcp_surfaces_root}/operator-console-overlay-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'runtime_admin',
    projections: [{
      id: 'default',
      transport: {
        kind: 'stdio',
        command: 'node',
        args: [],
        env: [
          'NARADA_ROOT',
          'NARADA_WINDOW_SURFACE_OVERLAY_STATE_ROOT',
          'NARADA_OPERATOR_CONSOLE_URL',
          'NARADA_OPERATOR_ROUTER_URL',
          'NARADA_OPERATOR_ROUTER_STATE_ROOT',
          'NARADA_OPERATOR_CONSOLE_HOST',
          'NARADA_OPERATOR_CONSOLE_PORT',
          'NARADA_OPERATOR_CONSOLE_RUNTIME_STATE_ROOT',
          'NARADA_POWERSHELL',
        ],
      },
      injection_scope: 'host',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.host'],
      lifecycle: {
        mode: 'replayable',
        reason: 'The MCP process is stateless; the canonical overlay package owns durable overlay state and the OS window.',
      },
    }],
  });
}
