import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import type {
  SurfaceInvocationContext,
  SurfaceReplacementCandidate,
  SurfaceRuntime,
  SurfaceRuntimeFactory,
  SurfaceRuntimeInit,
  SurfaceRuntimeRequest,
} from '@narada-core/mcp-fabric-contracts';

type WorkerRequest = {
  id: number;
  method: 'call' | 'health' | 'assess_replacement' | 'resource_snapshot' | 'dispose' | 'cancel';
  payload?: Record<string, unknown>;
};

const port = parentPort;
if (!port) throw new Error('mcp_surface_runtime_worker_parent_port_missing');

const data = workerData as { module_path: string; init: SurfaceRuntimeInit };
const moduleSpecifier = /^(?:file|data|node):/i.test(data.module_path)
  ? data.module_path
  : pathToFileURL(data.module_path).href;
const loaded = await import(moduleSpecifier) as { createSurfaceRuntime?: SurfaceRuntimeFactory };
if (typeof loaded.createSurfaceRuntime !== 'function') {
  throw new Error('mcp_surface_runtime_factory_export_missing');
}
const runtime: SurfaceRuntime = await loaded.createSurfaceRuntime(data.init);
const toolNames = [...runtime.tool_names];
if (toolNames.length === 0 || toolNames.some((name) => typeof name !== 'string' || !name.trim())) {
  throw new Error('mcp_surface_runtime_factory_tool_inventory_invalid');
}
const controllers = new Map<number, AbortController>();
let invocationCount = 0;

port.postMessage({ type: 'ready', tool_names: toolNames });
port.on('message', async (request: WorkerRequest) => {
  if (request.method === 'cancel') {
    controllers.get(Number(request.payload?.request_id))?.abort();
    return;
  }
  try {
    let result: unknown;
    if (request.method === 'call') {
      invocationCount += 1;
      const controller = new AbortController();
      controllers.set(request.id, controller);
      const context = request.payload?.context as SurfaceInvocationContext;
      result = await runtime.callTool(
        request.payload?.request as SurfaceRuntimeRequest,
        { ...context, abort_signal: controller.signal },
      );
      controllers.delete(request.id);
    } else if (request.method === 'health') {
      result = await runtime.health();
    } else if (request.method === 'assess_replacement') {
      result = runtime.assessReplacement
        ? await runtime.assessReplacement(request.payload?.candidate as SurfaceReplacementCandidate)
        : null;
    } else if (request.method === 'resource_snapshot') {
      const memory = process.memoryUsage();
      const heap = getHeapStatistics();
      result = {
        sampled_at: new Date().toISOString(),
        heap_total_bytes: memory.heapTotal,
        heap_used_bytes: memory.heapUsed,
        external_bytes: memory.external,
        array_buffers_bytes: memory.arrayBuffers,
        heap_limit_bytes: heap.heap_size_limit,
        active_resource_counts: countActiveResourceClasses(),
        invocation_count: invocationCount,
        inflight: controllers.size,
      };
    } else if (request.method === 'dispose') {
      await runtime.dispose();
      result = { disposed: true };
    } else {
      throw new Error(`mcp_surface_runtime_worker_method_unsupported:${request.method}`);
    }
    port.postMessage({ type: 'response', id: request.id, result });
  } catch (error) {
    controllers.delete(request.id);
    port.postMessage({
      type: 'response',
      id: request.id,
      error: {
        code: String((error as { code?: unknown })?.code ?? 'surface_runtime_error'),
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

function countActiveResourceClasses(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) {
    const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'unknown';
    counts[safe] = (counts[safe] ?? 0) + 1;
  }
  return counts;
}
