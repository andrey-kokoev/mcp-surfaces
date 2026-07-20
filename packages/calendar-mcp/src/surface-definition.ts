import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["calendar_guidance","calendar_doctor","calendar_list","calendar_event_query","calendar_event_show","calendar_output_show"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'calendar',
    surface_version: '0.1.0',
    package: '@narada2/calendar-mcp',
    entrypoint: '{mcp_surfaces_root}/calendar-mcp/dist/src/main.js',
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
      lifecycle: { mode: 'replayable', reason: "Calendar requests are independently authorized and do not expose a session-pinned protocol." },
    }],
    metadata: { codex_startup_timeout_sec: 60 },
  });
}
