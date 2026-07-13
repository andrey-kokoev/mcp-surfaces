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

export type McpProtocolSmokeOptions = {
  initializeParams?: JsonRecord;
  expectedServerName?: string;
  requiredTools?: readonly string[];
  initializeId?: number | string;
  toolsListId?: number | string;
};

export type McpProtocolSmokeResult = {
  initialize: JsonRecord;
  tools: JsonRecord;
  toolNames: string[];
};

export async function runMcpProtocolSmoke(
  client: JsonlMcpClient,
  options: McpProtocolSmokeOptions = {},
): Promise<McpProtocolSmokeResult> {
  const initializeId = options.initializeId ?? 1;
  const toolsListId = options.toolsListId ?? 2;
  const initialize = rpcResult(
    await client.request(initializeId, 'initialize', options.initializeParams ?? { protocolVersion: '2024-11-05' }),
    'initialize',
  );
  const serverInfo = asRecord(initialize.serverInfo);
  if (options.expectedServerName !== undefined && serverInfo.name !== options.expectedServerName) {
    throw new Error(`MCP initialize server name mismatch: expected ${options.expectedServerName}, got ${String(serverInfo.name)}`);
  }
  const tools = rpcResult(await client.request(toolsListId, 'tools/list', {}), 'tools/list');
  if (!Array.isArray(tools.tools)) throw new Error('MCP tools/list returned no tools array');
  const toolEntries = tools.tools;
  const toolNames = toolEntries.map((tool) => String(asRecord(tool).name));
  for (const requiredTool of options.requiredTools ?? []) {
    if (!toolNames.includes(requiredTool)) throw new Error(`MCP tools/list is missing required tool: ${requiredTool}`);
  }
  return { initialize, tools, toolNames };
}

export type OutputPageReader = (request: {
  offset: number;
  limit: number;
  pageNumber: number;
}) => Promise<JsonRecord>;

export type ReadMcpOutputTextOptions = {
  pageSize?: number;
  maxPages?: number;
  maxTextChars?: number;
  initialReadOffset?: number;
};

export type ReadMcpOutputTextResult = {
  text: string;
  pages: number;
  lastPage: JsonRecord;
};

export async function readMcpOutputText(
  firstPage: JsonRecord,
  readPage: OutputPageReader,
  options: ReadMcpOutputTextOptions = {},
): Promise<ReadMcpOutputTextResult> {
  const pageSize = boundedPositiveInteger(options.pageSize, 20_000, 20_000);
  const maxPages = boundedPositiveInteger(options.maxPages, 9, 100);
  const maxTextChars = boundedPositiveInteger(options.maxTextChars, 200_000, 2_000_000);
  let text = String(firstPage.output_text ?? '');
  if (text.length > maxTextChars) throw new Error(`MCP output readback exceeded the bounded character count (${maxTextChars})`);
  let pages = 1;
  let lastPage = firstPage;
  let nextOffset = options.initialReadOffset !== undefined
    ? requireNonNegativeOffset(options.initialReadOffset, 'initialReadOffset')
    : nextOutputOffset(firstPage.next_offset, 0);
  while (nextOffset !== null) {
    if (pages >= maxPages) throw new Error(`MCP output readback exceeded the bounded page count (${maxPages})`);
    const page = await readPage({ offset: nextOffset, limit: pageSize, pageNumber: pages });
    const pageText = String(page.output_text ?? '');
    text += pageText;
    if (text.length > maxTextChars) throw new Error(`MCP output readback exceeded the bounded character count (${maxTextChars})`);
    pages += 1;
    lastPage = page;
    const followingOffset = nextOutputOffset(page.next_offset, nextOffset);
    if (followingOffset !== null && followingOffset <= nextOffset) {
      throw new Error(`MCP output readback offset did not advance: ${nextOffset} -> ${followingOffset}`);
    }
    nextOffset = followingOffset;
  }
  return { text, pages, lastPage };
}

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

export type E2eArtifactRecorder = {
  update: (fields: JsonRecord) => void;
  finalize: (fields?: JsonRecord) => void;
};

export function installE2eArtifactRecorder(path: string, base: JsonRecord = {}): E2eArtifactRecorder {
  let result: JsonRecord = {
    schema: 'narada.mcp.e2e.result.v1',
    ...base,
    status: 'failed',
    started_at: new Date().toISOString(),
    cleanup: { status: 'unverified' },
  };
  let finalized = false;

  const write = (): void => {
    try {
      writeE2eResultArtifact(path, result);
    } catch (error) {
      process.stderr.write(`e2e_result_artifact_write_failed:${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  process.once('exit', () => {
    if (!finalized) {
      result = { ...result, finished_at: new Date().toISOString() };
      write();
    }
  });

  return {
    update(fields): void {
      if (!finalized) result = { ...result, ...fields };
    },
    finalize(fields = {}): void {
      if (finalized) return;
      result = { ...result, ...fields, finished_at: new Date().toISOString() };
      finalized = true;
      write();
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function rpcResult(response: JsonRpcResponse, operation: string): JsonRecord {
  if (response.error) throw new Error(`MCP ${operation} failed: ${JSON.stringify(response.error)}`);
  if (!response.result) throw new Error(`MCP ${operation} returned no result`);
  return response.result;
}

function nextOutputOffset(value: unknown, previousOffset: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`MCP output readback returned an invalid next_offset: ${String(value)}`);
  }
  if (value <= previousOffset) throw new Error(`MCP output readback offset did not advance: ${previousOffset} -> ${value}`);
  return value;
}

function requireNonNegativeOffset(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`MCP output readback ${name} is invalid: ${String(value)}`);
  return value;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'e2e';
}
