import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["nars_session_guidance","nars_session_list","nars_session_show","nars_session_input_status"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'nars-session',
    surface_version: '0.1.0',
    package: '@narada2/nars-session-mcp',
    entrypoint: '{mcp_surfaces_root}/nars-session-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'runtime_admin',
    projections: [{
      id: 'user-site-operator',
      transport: { kind: 'stdio', command: 'node', args: [], env: ['NARADA_AGENT_ID', 'NARADA_CARRIER_SESSION_ID', 'NARADA_SITE_ID', 'NARADA_SITE_ROOT', 'NARADA_NARS_SESSION_ALLOW_STEER'] },
      injection_scope: 'user_site',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.user_site'],
      lifecycle: { mode: 'session_pinned', reason: "Existing NARS session identity is pinned to the current carrier session." },
    }, {
      id: 'local-site-nars-runtime',
      transport: { kind: 'stdio', command: 'node', args: [], env: ['NARADA_AGENT_ID', 'NARADA_CARRIER_SESSION_ID', 'NARADA_SITE_ID', 'NARADA_SITE_ROOT', 'NARADA_NARS_SESSION_ALLOW_STEER'] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: ['nars'],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'session_pinned', reason: 'NARS session identity and runtime are pinned to the selected local Site runtime.' },
    }],
  });
}
