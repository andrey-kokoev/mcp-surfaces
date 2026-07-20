import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './site-loop-mcp-server.js';

const READ_ONLY_TOOLS = [
  'site_loop_guidance', 'site_loop_doctor', 'site_loop_config_validate',
  'site_loop_output_show', 'site_loop_operator_affordances', 'site_docs_list',
  'site_docs_show', 'site_test_list', 'site_loop_status', 'site_loop_unified_status',
  'site_loop_recovery_plan', 'site_loop_health', 'site_loop_operating_status',
  'site_loop_proof_status', 'site_loop_readiness', 'site_loop_coherence',
  'site_loop_runs_list', 'site_loop_run_show', 'site_loop_attention_list',
  'site_loop_attention_show',
] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'site-loop',
    surface_version: '0.1.0',
    package: '@narada2/site-loop-mcp',
    entrypoint: '{mcp_surfaces_root}/site-loop-mcp/dist/src/site-loop-mcp-server.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'local_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ['{mcp_surfaces_root}/site-loop-mcp/dist/src/site-loop-mcp-server.js', '--site-root', '{site_root}'], env: [] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'restart_required', restart_owner: 'local_site', reason: 'Site Loop owns active run and control state in process memory.' },
    }],
  });
}
