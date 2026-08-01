import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada-core/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = ["sop_guidance","sop_doctor","sop_template_show","sop_template_export","sop_template_list","sop_template_search","sop_template_candidate_list","sop_template_candidate_show","sop_run_status","sop_handoff_list","sop_handoff_show","sop_action_list","sop_action_show","sop_run_list","sop_run_events","sop_run_coverage_since","sop_outbox_list"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'sop',
    surface_version: '0.2.0',
    package: '@narada-core/sop-mcp',
    entrypoint: '{mcp_surfaces_root}/sop-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: {
        kind: 'stdio',
        command: 'node',
        args: [
          '--sop-root', '{site_root}',
          '--server-name', '{site_id}-sop',
          '--sops-dir', '{site_root}/.narada/sops',
        ],
        env: [],
      },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'restart_required', restart_owner: 'local_site', reason: "SOP run execution owns an in-process SQLite connection and must be restarted by the Site owner." },
    }],
  });
}
