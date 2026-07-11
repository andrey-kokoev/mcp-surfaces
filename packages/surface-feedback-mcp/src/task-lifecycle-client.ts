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
  close(): void;
};

const require = createRequire(import.meta.url);

function taskLifecycleEntrypoint(): string {
  return require.resolve('@narada2/task-lifecycle-mcp/task-lifecycle-mcp-server');
}

export function createTaskLifecycleProcessClient({
  siteRoot,
  env = process.env,
  requestTimeoutMs = 120_000,
}: {
  siteRoot: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}): TaskLifecycleProcessClient {
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  let closed = false;
  const pending = new Map<string, PendingRequest>();

  const rejectPending = (error: Error) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  };

  const processError = (reason: string, error?: unknown) => {
    const suffix = stderrTail ? ` stderr=${stderrTail.slice(-2000)}` : '';
    const detail = error instanceof Error ? ` ${error.message}` : error ? ` ${String(error)}` : '';
    const failure = new Error(`${reason}${detail}${suffix}`);
    child = null;
    stdoutBuffer = '';
    rejectPending(failure);
    return failure;
  };

  const handleStdout = (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRecord;
      try {
        response = JSON.parse(line) as JsonRecord;
      } catch (error) {
        processError('task_lifecycle_invalid_stdout', error);
        continue;
      }
      const id = String(response.id ?? '');
      const request = pending.get(id);
      if (!request) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve(response);
    }
  };

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child && !child.killed) return child;
    if (closed) throw new Error('task_lifecycle_client_closed');
    const spawned = spawn(process.execPath, [taskLifecycleEntrypoint(), '--site-root', siteRoot], {
      cwd: siteRoot,
      env: { ...env, NARADA_SITE_ROOT: siteRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawned;
    stdoutBuffer = '';
    stderrTail = '';
    spawned.stdout.setEncoding('utf8');
    spawned.stderr.setEncoding('utf8');
    spawned.stdout.on('data', handleStdout);
    spawned.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });
    spawned.once('error', (error) => processError('task_lifecycle_process_error', error));
    spawned.once('exit', (code, signal) => {
      if (closed) return;
      processError(`task_lifecycle_process_exit:${code ?? 'null'}:${signal ?? 'null'}`);
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
        const failure = processError(`task_lifecycle_request_timeout:${id}`);
        reject(failure);
        try { spawned.kill(); } catch { /* process exit will finish cleanup */ }
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        spawned.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(processError('task_lifecycle_stdin_error', error));
      }
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    rejectPending(new Error('task_lifecycle_client_closed'));
    const current = child;
    child = null;
    if (current && !current.killed) {
      try { current.kill(); } catch { /* already exited */ }
    }
  };

  return { request, close };
}
