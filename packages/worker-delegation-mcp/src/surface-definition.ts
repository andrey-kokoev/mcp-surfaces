import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './tool-list.js';

const READ_ONLY_TOOLS = ["worker_guidance","worker_policy_inspect","worker_config_resolve","worker_cognition_defaults_inspect","worker_run_status","worker_runs_list","worker_run_wait","worker_run_wait_batch","worker_runs_synthesize","worker_dashboard_describe","worker_output_show","worker_operator_affordances"] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'worker-delegation',
    surface_version: '0.1.0',
    package: '@narada2/worker-delegation-mcp',
    entrypoint: '{mcp_surfaces_root}/worker-delegation-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'runtime_admin',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ["--site-root","{site_root}","--allowed-root","{workspace_root}","--run-root","{site_runtime_root}/worker-delegation"], env: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API_BASE_URL', 'NARADA_WORKER_MCP_CONFIG'] },
      injection_scope: 'local_site',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.local_site'],
      lifecycle: { mode: 'restart_required', restart_owner: 'local_site', reason: "Active worker subprocess ownership is process-local; replacement requires the worker runtime owner." },
    }],
  });
}
