import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["cloudflare_carrier_guidance","cloudflare_product_read","cloudflare_session_status","cloudflare_health","cloudflare_doctor","cloudflare_carrier_health"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'cloudflare-carrier',
    surface_version: '0.1.0',
    package: '@narada2/cloudflare-carrier-mcp',
    entrypoint: '{mcp_surfaces_root}/cloudflare-carrier-mcp/dist/src/main.js',
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
      lifecycle: { mode: 'replayable', reason: "Carrier product reads are independently observable and do not pin a client session." },
    }],
  });
}
