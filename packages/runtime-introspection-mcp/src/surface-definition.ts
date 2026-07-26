import {
  defineNativeSurface,
  type DefinedSurface,
  type McpToolDefinition,
} from '@narada2/mcp-fabric-contracts';
import { listTools } from './main.js';

const READ_ONLY_TOOLS = [
  'runtime_introspection_guidance',
  'runtime_introspection_formats',
  'runtime_introspection_top_events',
  'runtime_introspection_analyze_trace',
  'runtime_introspection_analyze',
  'runtime_introspection_top',
  'runtime_introspection_show',
  'runtime_introspection_show_event',
] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'runtime-introspection',
    surface_version: '0.1.0',
    package: '@narada2/runtime-introspection-mcp',
    description: 'Read-only analysis of bounded runtime traces and session composition data.',
    entrypoint: '{mcp_surfaces_root}/runtime-introspection-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'read',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: [], env: [] },
      injection_scope: 'host',
      default_injection: 'disabled',
      runtime_requirements: [],
      authority_requirements: ['scope.host'],
      lifecycle: {
        mode: 'replayable',
        reason: 'Runtime introspection analyzes caller-supplied bounded data and owns no session state.',
      },
    }],
  });
}
