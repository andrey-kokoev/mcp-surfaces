import {
  defineNativeSurface,
  type DefinedSurface,
  type McpToolDefinition,
} from '@narada-core/mcp-fabric-contracts';
import { listTools } from './main.js';

export function surfaceDefinition(): DefinedSurface {
  const tools = listTools();
  const readOnlyTools = tools
    .filter((tool) => tool.annotations?.readOnlyHint)
    .map((tool) => tool.name);
  return defineNativeSurface({
    surface_id: 'work-lifecycle',
    surface_version: '0.1.0',
    package: '@narada-core/work-lifecycle-mcp',
    entrypoint: '{mcp_surfaces_root}/work-lifecycle-mcp/dist/src/main.js',
    tools: tools as McpToolDefinition[],
    read_only_tools: readOnlyTools,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: {
        kind: 'stdio',
        command: 'node',
        args: ['--site-root', '{site_root}'],
        env: ['NARADA_AGENT_ID'],
      },
      injection_scope: 'local_site',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: {
        mode: 'restart_required',
        restart_owner: 'mcp-loader',
        reason: 'One runtime owns the Site-scoped Work Lifecycle writer lease.',
      },
    }],
    metadata: { codex_startup_timeout_sec: 15 },
  });
}
