import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  resolve: (response: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type TaskLifecycleProcessClient = {
  request(request: JsonRecord): Promise<JsonRecord>;
  close(): Promise<void>;
};

const require = createRequire(import.meta.url);

function defaultTaskLifecycleEntrypoint(): string {
  return require.resolve('@narada2/task-lifecycle-mcp/task-lifecycle-mcp-server');
}

export function createTaskLifecycleProcessClient({
  siteRoot,
  entrypoint = defaultTaskLifecycleEntrypoint(),
  env = process.env,
  requestTimeoutMs = 120_000,
}: {
  siteRoot: string;
  entrypoint?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}): TaskLifecycleProcessClient {
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  const pending = new Map<string, PendingRequest>();
  const liveChildren = new Set<ChildProcessWithoutNullStreams>();

  const rejectPending = (error: Error) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  };

  const processError = (source: ChildProcessWithoutNullStreams | null, stderrTail: string, reason: string, error?: unknown) => {
    const suffix = stderrTail ? ` stderr=${stderrTail.slice(-2000)}` : '';
    const detail = error instanceof Error ? ` ${error.message}` : error ? ` ${String(error)}` : '';
    const failure = new Error(`${reason}${detail}${suffix}`);
    if (source === null || child === source) {
      child = null;
      rejectPending(failure);
    }
    return failure;
  };

  const handleStdout = (source: ChildProcessWithoutNullStreams, buffer: string, stderrTail: string, chunk: string): string => {
    if (child !== source) return buffer;
    const lines = `${buffer}${chunk}`.split(/\r?\n/);
    const remaining = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRecord;
      try {
        response = JSON.parse(line) as JsonRecord;
      } catch (error) {
        processError(source, stderrTail, 'task_lifecycle_invalid_stdout', error);
        if (!source.killed) {
          try { source.kill(); } catch { /* process exit will finish cleanup */ }
        }
        continue;
      }
      const id = String(response.id ?? '');
      const request = pending.get(id);
      if (!request) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve(response);
    }
    return remaining;
  };

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child && !child.killed) return child;
    if (closed) throw new Error('task_lifecycle_client_closed');
    const spawned = spawn(process.execPath, [entrypoint, '--site-root', siteRoot], {
      cwd: siteRoot,
      env: { ...env, NARADA_SITE_ROOT: siteRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = spawned;
    liveChildren.add(spawned);
    let stdoutBuffer = '';
    let stderrTail = '';
    spawned.stdout.setEncoding('utf8');
    spawned.stderr.setEncoding('utf8');
    spawned.stdout.on('data', (chunk: string) => {
      stdoutBuffer = handleStdout(spawned, stdoutBuffer, stderrTail, chunk);
    });
    spawned.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });
    spawned.once('error', (error) => processError(spawned, stderrTail, 'task_lifecycle_process_error', error));
    spawned.once('exit', (code, signal) => {
      liveChildren.delete(spawned);
      if (closed) return;
      processError(spawned, stderrTail, `task_lifecycle_process_exit:${code ?? 'null'}:${signal ?? 'null'}`);
    });
    return spawned;
  };

  const request = (input: JsonRecord): Promise<JsonRecord> => {
    if (closed) return Promise.reject(new Error('task_lifecycle_client_closed'));
    let spawned: ChildProcessWithoutNullStreams;
    try {
      spawned = ensureChild();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const id = String(input.id ?? randomUUID());
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const failure = processError(spawned, '', `task_lifecycle_request_timeout:${id}`);
        reject(failure);
        try { spawned.kill(); } catch { /* process exit will finish cleanup */ }
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        spawned.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(processError(spawned, '', 'task_lifecycle_stdin_error', error));
      }
    });
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    rejectPending(new Error('task_lifecycle_client_closed'));
    child = null;
    const terminate = (processToStop: ChildProcessWithoutNullStreams) => new Promise<void>((resolve) => {
        if (processToStop.exitCode !== null || processToStop.signalCode !== null) {
          liveChildren.delete(processToStop);
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          liveChildren.delete(processToStop);
          resolve();
        };
        processToStop.once('exit', finish);
        const timer = setTimeout(() => {
          try { processToStop.kill('SIGKILL'); } catch { /* already exited */ }
          finish();
        }, 2_000);
        timer.unref?.();
        try {
          if (!processToStop.killed && !processToStop.kill()) finish();
        } catch {
          finish();
        }
      });
    await Promise.all([...liveChildren].map(terminate));
  };

  return { request, close };
}
