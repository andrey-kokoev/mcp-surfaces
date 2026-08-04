import type {
  SurfaceRuntime,
  SurfaceRuntimeFactory,
  SurfaceRuntimeJson,
} from '@narada-core/mcp-fabric-contracts';
import { createServerState, handleRequest, listTools } from './main.js';

type JsonRecord = Record<string, unknown>;

export const createSurfaceRuntime: SurfaceRuntimeFactory = async (init): Promise<SurfaceRuntime> => {
  const configuration = init.configuration ?? {};
  const state = createServerState({
    narada_root: configuration.narada_root ?? init.site_root,
    registry_path: configuration.registry_path,
    projection_id: init.projection_id,
  });
  let disposed = false;

  return {
    tool_names: listTools().map((tool) => tool.name),
    async callTool(request): Promise<SurfaceRuntimeJson> {
      if (disposed) throw new Error('launcher_surface_runtime_disposed');
      const response = await handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: request.tool_name, arguments: request.arguments },
      }, state) as JsonRecord;
      const error = asRecord(response.error);
      if (Object.keys(error).length > 0) {
        const failure = new Error(String(error.message ?? 'launcher_surface_call_failed')) as Error & { code?: string };
        failure.code = String(asRecord(error.data).code ?? 'launcher_surface_call_failed');
        throw failure;
      }
      return asRecord(response.result);
    },
    async health() {
      return disposed
        ? { status: 'unavailable' as const, detail: 'disposed' }
        : { status: 'healthy' as const };
    },
    async assessReplacement(candidate) {
      return candidate.previous_tool_contract_digest === candidate.candidate_tool_contract_digest
        ? { compatible: true, reason: 'launcher_read_only_contract_unchanged' }
        : { compatible: false, reason: 'launcher_tool_contract_changed' };
    },
    async dispose() {
      disposed = true;
    },
  };
};

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}
