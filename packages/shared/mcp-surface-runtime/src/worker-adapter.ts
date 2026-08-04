import { Worker } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type {
  SurfaceInvocationContext,
  SurfaceReplacementAssessment,
  SurfaceReplacementCandidate,
  SurfaceRuntimeHealth,
  SurfaceRuntimeJson,
  SurfaceRuntimeRequest,
} from '@narada-core/mcp-fabric-contracts';
import type { AdapterStartInput, RuntimeGenerationAdapter, RuntimeWorkerResourceSnapshot } from './types.js';

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export class WorkerSurfaceAdapter implements RuntimeGenerationAdapter {
  readonly kind = 'surface_factory' as const;
  readonly worker: Worker;
  readonly toolNames: readonly string[];
  readonly runtime: RuntimeGenerationAdapter['runtime'];
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;
  #failure: Error | null = null;

  private constructor(worker: Worker, toolNames: string[]) {
    this.worker = worker;
    this.toolNames = Object.freeze([...toolNames]);
    this.runtime = {
      executable: process.execPath,
      version: process.version,
      pid: process.pid,
      worker_thread_id: worker.threadId,
    };
    worker.on('message', (message: Record<string, unknown>) => this.#onMessage(message));
    worker.on('error', (error) => this.#fail(error));
    worker.on('exit', (code) => {
      if (!this.#closed) this.#fail(new Error(`mcp_surface_runtime_worker_exited:${code}`));
    });
  }

  static async start(input: AdapterStartInput): Promise<WorkerSurfaceAdapter> {
    if (input.adapter.kind !== 'surface_factory') throw new Error('mcp_surface_runtime_factory_adapter_required');
    const worker = new Worker(new URL('./worker-entry.js', import.meta.url), {
      workerData: { module_path: input.adapter.module_path, init: input.init },
    });
    const ready = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mcp_surface_runtime_worker_start_timeout')), 15_000);
      const onMessage = (message: Record<string, unknown>) => {
        if (message.type !== 'ready') return;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        resolve(Array.isArray(message.tool_names) ? message.tool_names.map(String) : []);
      };
      const onError = (error: Error) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        reject(error);
      };
      const onExit = (code: number) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        reject(new Error(`mcp_surface_runtime_worker_exited_before_ready:${code}`));
      };
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
    }).catch(async (error) => {
      await worker.terminate();
      throw error;
    });
    return new WorkerSurfaceAdapter(worker, ready);
  }

  call(request: SurfaceRuntimeRequest, context: SurfaceInvocationContext): Promise<SurfaceRuntimeJson> {
    const { abort_signal: signal, ...serializableContext } = context;
    const id = this.#nextId++;
    const pending = this.#requestWithId(id, 'call', { request, context: serializableContext });
    if (signal) {
      const cancel = () => this.worker.postMessage({ id: this.#nextId++, method: 'cancel', payload: { request_id: id } });
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      void pending.then(
        () => signal.removeEventListener('abort', cancel),
        () => signal.removeEventListener('abort', cancel),
      );
    }
    return pending as Promise<SurfaceRuntimeJson>;
  }

  health(): Promise<SurfaceRuntimeHealth> {
    return this.#request('health') as Promise<SurfaceRuntimeHealth>;
  }

  assessReplacement(candidate: SurfaceReplacementCandidate): Promise<SurfaceReplacementAssessment | null> {
    return this.#request('assess_replacement', { candidate }) as Promise<SurfaceReplacementAssessment | null>;
  }

  resourceSnapshot(): Promise<RuntimeWorkerResourceSnapshot> {
    return this.#request('resource_snapshot') as Promise<RuntimeWorkerResourceSnapshot>;
  }

  async writeHeapSnapshot(path: string, maxBytes: number): Promise<number> {
    const stream = await this.worker.getHeapSnapshot();
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error('mcp_surface_runtime_heap_snapshot_size_limit') : null, chunk);
      },
    });
    try {
      await pipeline(stream, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      return (await stat(path)).size;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await Promise.race([
        this.#request('dispose'),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    } catch {
      // Termination below is the bounded fallback.
    }
    this.#closed = true;
    this.#rejectPending(new Error('mcp_surface_runtime_worker_closed'));
    await this.worker.terminate();
  }

  #request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.#requestWithId(this.#nextId++, method, payload);
  }

  #requestWithId(id: number, method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new Error('mcp_surface_runtime_worker_closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`mcp_surface_runtime_worker_request_timeout:${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, method, payload });
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #onMessage(message: Record<string, unknown>): void {
    if (message.type !== 'response' || typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error && typeof message.error === 'object') {
      const error = message.error as { code?: unknown; message?: unknown };
      const failure = new Error(String(error.message ?? 'surface_runtime_error'));
      Object.assign(failure, { code: String(error.code ?? 'surface_runtime_error') });
      pending.reject(failure);
    } else {
      pending.resolve(message.result);
    }
  }

  #fail(error: Error): void {
    if (this.#failure || this.#closed) return;
    this.#failure = error;
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
