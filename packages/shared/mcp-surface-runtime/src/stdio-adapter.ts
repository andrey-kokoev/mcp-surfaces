import type {
  SurfaceInvocationContext,
  SurfaceReplacementAssessment,
  SurfaceReplacementCandidate,
  SurfaceRuntimeHealth,
  SurfaceRuntimeJson,
  SurfaceRuntimeRequest,
} from '@narada-core/mcp-fabric-contracts';
import { McpProcessClient } from '@narada-core/mcp-runtime-client';
import type { AdapterStartInput, RuntimeGenerationAdapter, RuntimeWorkerResourceSnapshot } from './types.js';

export class StdioSurfaceAdapter implements RuntimeGenerationAdapter {
  readonly kind = 'stdio' as const;
  readonly client: McpProcessClient;
  readonly toolNames: readonly string[];
  readonly runtime: RuntimeGenerationAdapter['runtime'];

  private constructor(client: McpProcessClient, toolNames: string[]) {
    this.client = client;
    this.toolNames = Object.freeze([...toolNames]);
    this.runtime = {
      executable: client.process.spawnfile,
      version: 'unknown',
      pid: client.process.pid ?? -1,
    };
  }

  static async start(input: AdapterStartInput): Promise<StdioSurfaceAdapter> {
    if (input.adapter.kind !== 'stdio') throw new Error('mcp_surface_runtime_stdio_adapter_required');
    const client = await McpProcessClient.start({
      executable: input.adapter.executable,
      args: input.adapter.args,
      cwd: input.adapter.cwd,
      env: input.adapter.env,
      clientName: 'narada-mcp-surface-runtime',
    });
    try {
      const inventory = await client.request('tools/list');
      const tools = Array.isArray(inventory.tools) ? inventory.tools : [];
      const names = tools.map((tool) => String((tool as Record<string, unknown>).name ?? '')).filter(Boolean);
      return new StdioSurfaceAdapter(client, names);
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async call(request: SurfaceRuntimeRequest, _context: SurfaceInvocationContext): Promise<SurfaceRuntimeJson> {
    return this.client.callTool(request.tool_name, request.arguments);
  }

  async health(): Promise<SurfaceRuntimeHealth> {
    return this.client.process.exitCode === null && this.client.process.signalCode === null
      ? { status: 'healthy' }
      : { status: 'unavailable', detail: 'stdio child exited' };
  }

  async assessReplacement(_candidate: SurfaceReplacementCandidate): Promise<SurfaceReplacementAssessment | null> {
    return null;
  }

  async resourceSnapshot(_inflight: number, _invocationCount: number): Promise<RuntimeWorkerResourceSnapshot | null> {
    return null;
  }

  async writeHeapSnapshot(_path: string, _maxBytes: number): Promise<number> {
    throw new Error('mcp_surface_runtime_heap_snapshot_stdio_unsupported');
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
