import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type JsonRecord = Record<string, unknown>;

export type JsonRpcResponse = {
  id?: number | string;
  result?: JsonRecord;
  error?: JsonRecord;
};

export type JsonlMcpClient = {
  request: (id: number | string, method: string, params?: JsonRecord) => Promise<JsonRpcResponse>;
  close: () => Promise<void>;
};

export type JsonlMcpClientOptions = {
  timeoutMs?: number;
  closeTimeoutMs?: number;
  label?: string;
};

export type SpawnJsonlMcpServerOptions = JsonlMcpClientOptions & {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type SpawnedJsonlMcpServer = {
  child: ChildProcessWithoutNullStreams;
  client: JsonlMcpClient;
  close: () => Promise<void>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

export function createJsonlClient(
  child: ChildProcessWithoutNullStreams,
  options: JsonlMcpClientOptions = {},
): JsonlMcpClient {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
  const label = options.label ?? 'MCP child';
  let buffer = '';
  let stderrTail = '';
  const pending = new Map<string, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4_000);
  });
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch (error) {
        rejectAll(new Error(label + ' emitted invalid JSON: ' + (error instanceof Error ? error.message : String(error))));
        return;
      }
      const entry = message.id === undefined ? undefined : pending.get(String(message.id));
      if (!entry) continue;
      pending.delete(String(message.id));
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });

  child.on('error', (error) => rejectAll(error instanceof Error ? error : new Error(String(error))));
  child.on('close', (code, signal) => {
    const detail = stderrTail ? ', stderr=' + JSON.stringify(stderrTail) : '';
    rejectAll(new Error(label + ' exited before all responses were received (code=' + (code ?? 'null') + ', signal=' + (signal ?? 'null') + detail + ')'));
  });

  return {
    request(id, method, params = {}) {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        return Promise.reject(new Error(label + ' stdin is closed'));
      }
      const key = String(id);
      if (pending.has(key)) return Promise.reject(new Error(label + ' request id is already pending: ' + id));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error('timed out waiting for ' + label + ' response ' + id));
        }, timeoutMs);
        pending.set(key, { resolve, reject, timer });
        try {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        } catch (error) {
          clearTimeout(timer);
          pending.delete(key);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async close() {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Cleanup remains best effort after the bounded grace period.
          }
          resolve();
        }, closeTimeoutMs);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };

  function rejectAll(error: Error): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  }
}

export function spawnJsonlMcpServer(
  command: string,
  args: string[],
  options: SpawnJsonlMcpServerOptions = {},
): SpawnedJsonlMcpServer {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const client = createJsonlClient(child, options);
  return { child, client, close: client.close };
}

export type ContentLengthMcpClient = JsonlMcpClient;
export type ContentLengthMcpClientOptions = JsonlMcpClientOptions;
export type SpawnContentLengthMcpServerOptions = ContentLengthMcpClientOptions & {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
export type SpawnedContentLengthMcpServer = {
  child: ChildProcessWithoutNullStreams;
  client: ContentLengthMcpClient;
  close: () => Promise<void>;
};

export function createContentLengthClient(
  child: ChildProcessWithoutNullStreams,
  options: ContentLengthMcpClientOptions = {},
): ContentLengthMcpClient {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
  const label = options.label ?? 'MCP Content-Length child';
  let buffer = Buffer.alloc(0);
  let stderrTail = '';
  const pending = new Map<string, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4_000);
  });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    while (true) {
      const crlfHeaderEnd = buffer.indexOf('\r\n\r\n');
      const lfHeaderEnd = buffer.indexOf('\n\n');
      const headerEnd = crlfHeaderEnd >= 0 && (lfHeaderEnd < 0 || crlfHeaderEnd < lfHeaderEnd)
        ? crlfHeaderEnd
        : lfHeaderEnd;
      if (headerEnd < 0) return;
      const separatorLength = headerEnd === crlfHeaderEnd ? 4 : 2;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        rejectAll(new Error(label + ' emitted a frame without Content-Length'));
        return;
      }
      const bodyStart = headerEnd + separatorLength;
      const bodyLength = Number(match[1]);
      if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) {
        rejectAll(new Error(label + ' emitted an invalid Content-Length: ' + match[1]));
        return;
      }
      if (buffer.length < bodyStart + bodyLength) return;
      const body = buffer.subarray(bodyStart, bodyStart + bodyLength).toString('utf8');
      buffer = buffer.subarray(bodyStart + bodyLength);
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(body) as JsonRpcResponse;
      } catch (error) {
        rejectAll(new Error(label + ' emitted invalid JSON: ' + (error instanceof Error ? error.message : String(error))));
        return;
      }
      const entry = message.id === undefined ? undefined : pending.get(String(message.id));
      if (!entry) continue;
      pending.delete(String(message.id));
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });

  child.on('error', (error) => rejectAll(error instanceof Error ? error : new Error(String(error))));
  child.on('close', (code, signal) => {
    const detail = stderrTail ? ', stderr=' + JSON.stringify(stderrTail) : '';
    rejectAll(new Error(label + ' exited before all responses were received (code=' + (code ?? 'null') + ', signal=' + (signal ?? 'null') + detail + ')'));
  });

  return {
    request(id, method, params = {}) {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        return Promise.reject(new Error(label + ' stdin is closed'));
      }
      const key = String(id);
      if (pending.has(key)) return Promise.reject(new Error(label + ' request id is already pending: ' + id));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error('timed out waiting for ' + label + ' response ' + id));
        }, timeoutMs);
        pending.set(key, { resolve, reject, timer });
        try {
          const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
          child.stdin.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(key);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async close() {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Cleanup remains best effort after the bounded grace period.
          }
          resolve();
        }, closeTimeoutMs);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };

  function rejectAll(error: Error): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  }
}

export function spawnContentLengthMcpServer(
  command: string,
  args: string[],
  options: SpawnContentLengthMcpServerOptions = {},
): SpawnedContentLengthMcpServer {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const client = createContentLengthClient(child, options);
  return { child, client, close: client.close };
}

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export function structured(response: JsonRpcResponse): JsonRecord {
  if (response.error) throw new Error('MCP response error: ' + JSON.stringify(response.error));
  const result = asRecord(response.result);
  return asRecord(result.structuredContent ?? result);
}

export function createTemporaryE2eRoot(testId: string): string {
  return mkdtempSync(join(tmpdir(), safeSegment(testId) + '-'));
}

export function removeTemporaryE2eRoot(root: string): boolean {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === 4) return false;
    }
  }
  return false;
}

export function tomlPath(value: string): string {
  return value.replaceAll('\\', '/').replaceAll('"', '\\"');
}

export function readJsonLines(path: string): JsonRecord[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

export function writeE2eResultArtifact(path: string, result: JsonRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'e2e';
}
