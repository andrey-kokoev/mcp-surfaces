import { defineNativeSurface, type DefinedSurface, type McpToolDefinition } from '@narada2/mcp-fabric-contracts';
import { listTools } from './tool-list.js';

const READ_ONLY_TOOLS = ['speech_guidance', 'speech_voices', 'speech_listen_status'] as const;

export function surfaceDefinition(): DefinedSurface {
  return defineNativeSurface({
    surface_id: 'speech',
    surface_version: '0.1.0',
    package: '@narada2/speech-mcp',
    entrypoint: '{mcp_surfaces_root}/speech-mcp/dist/src/main.js',
    tools: listTools() as McpToolDefinition[],
    read_only_tools: READ_ONLY_TOOLS,
    default_effect: 'external_write',
    projections: [{
      id: 'default',
      transport: { kind: 'stdio', command: 'node', args: ['--provider-registry-path', '{mcp_surfaces_root}/speech-mcp/config/provider-registry.v2.json'], env: ['OPENAI_API_KEY'] },
      injection_scope: 'host',
      default_injection: 'enabled',
      runtime_requirements: [],
      authority_requirements: ['scope.host'],
      lifecycle: { mode: 'session_pinned', reason: 'Bounded capture/listen sessions remain pinned to the host speech process.' },
    }],
  });
}
