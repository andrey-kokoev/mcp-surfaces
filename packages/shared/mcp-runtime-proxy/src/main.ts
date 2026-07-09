#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, unknown>;
type PendingRequest = {
  id: string | number;
  method: string;
  framed: boolean;
  timeoutTimer: NodeJS.Timeout;
  requestedToolTimeoutMs: number | null;
};

const STDERR_TAIL_LIMIT = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;
const DEFAULT_REQUEST_TIMEOUT_KILL_GRACE_MS = 5_000;
const SUPPRESSED_RESPONSE_TTL_MS = 60_000;

function parseArgs(argv: string[]): { entrypoint: string; childArgs: string[]; surfaceId: string | null; requestTimeoutMs: number } {
  let entrypoint = '';
  let surfaceId: string | null = null;
  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  let passthroughIndex = argv.indexOf('--');
  if (passthroughIndex < 0) passthroughIndex = argv.length;
  const prelude = argv.slice(0, passthroughIndex);
  for (let index = 0; index < prelude.length; index += 1) {
    const arg = prelude[index];
    if (arg === '--entrypoint' && prelude[index + 1]) entrypoint = prelude[++index];
    else if (arg === '--surface-id' && prelude[index + 1]) surfaceId = prelude[++index];
    else if (arg === '--request-timeout-ms' && prelude[index + 1]) requestTimeoutMs = parsePositiveInteger(prelude[++index], 'request_timeout_ms');
  }
  if (!entrypoint) throw new Error('mcp_runtime_proxy_missing_entrypoint');
  return { entrypoint: resolve(entrypoint), childArgs: argv.slice(Math.min(passthroughIndex + 1, argv.length)), surfaceId, requestTimeoutMs };
}

export async function runProxy(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (!existsSync(options.entrypoint)) {
    process.stderr.write(`mcp_runtime_proxy_entrypoint_not_found:${options.entrypoint}\n`);
  }

  const pending = new Map<string | number, PendingRequest>();
  const timedOutRequests = new Map<string | number, NodeJS.Timeout>();
  const childTerminationTimers = new Set<NodeJS.Timeout>();
  let parentBuffer = '';
  let childBuffer = '';
  let stderrTail = '';
  let childClosed = false;

  const child = spawn(process.execPath, [options.entrypoint, ...options.childArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (!child.stdin.destroyed) child.stdin.write(chunk);
    parentBuffer += chunk;
    const drained = parentBuffer.includes('Content-Length:') ? drainJsonRpcFrames(parentBuffer) : drainJsonLines(parentBuffer);
    parentBuffer = drained.remaining;
    for (const request of drained.requests) {
      const id = request.id;
      if ((typeof id === 'string' || typeof id === 'number') && typeof request.method === 'string') {
        const timeoutTimer = setTimeout(() => {
          const pendingRequest = pending.get(id);
          if (!pendingRequest) return;
          pending.delete(id);
          rememberTimedOutRequest(timedOutRequests, id);
          writePendingError(pendingRequest, options, {
            code: 'child_request_timeout',
            message: `child_request_timeout:${request.method}:${options.requestTimeoutMs}ms`,
            stderrTail,
            exitCode: null,
            signal: null,
          });
          sendCancellationToChild(child, pendingRequest, 'request timed out in mcp runtime proxy');
          terminateChildAfterRequestTimeout(child, childTerminationTimers, () => childClosed);
        }, options.requestTimeoutMs);
        pending.set(id, {
          id,
          method: request.method,
          framed: drained.framed,
          timeoutTimer,
          requestedToolTimeoutMs: extractRequestedToolTimeoutMs(request),
        });
      }
    }
  });

  process.stdin.on('end', () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });

  child.stdout.on('data', (chunk) => {
    childBuffer += chunk;
    const drained = childBuffer.includes('Content-Length:') ? drainJsonRpcFrames(childBuffer) : drainJsonLines(childBuffer);
    childBuffer = drained.remaining;
    for (const response of drained.requests) {
      const id = response.id;
      if (typeof id === 'string' || typeof id === 'number') {
        const request = pending.get(id);
        if (request) clearTimeout(request.timeoutTimer);
        pending.delete(id);
        if (timedOutRequests.has(id)) continue;
      }
      writeJsonRpcMessage(response, drained.framed);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrTail = tail(`${stderrTail}${chunk}`, STDERR_TAIL_LIMIT);
    process.stderr.write(chunk);
  });

  child.on('error', (error) => {
    stderrTail = tail(`${stderrTail}${error.message}\n`, STDERR_TAIL_LIMIT);
    flushPendingErrors(pending, options, {
      code: 'child_spawn_error',
      message: error.message,
      stderrTail,
      exitCode: null,
      signal: null,
    });
  });

  child.on('close', (code, signal) => {
    childClosed = true;
    process.stdin.pause();
    if (pending.size > 0) {
      flushPendingErrors(pending, options, {
        code: 'child_exited_before_response',
        message: `child_exited_before_response:${code ?? signal ?? 'unknown'}`,
        stderrTail,
        exitCode: code,
        signal,
      });
    }
    clearTimedOutRequests(timedOutRequests);
    clearTimers(childTerminationTimers);
    process.exitCode = typeof code === 'number' ? code : 1;
  });

  await new Promise<void>((resolveDone) => {
    child.on('close', () => resolveDone());
    process.stdin.on('end', () => {
      if (childClosed) resolveDone();
    });
  });
}

function flushPendingErrors(
  pending: Map<string | number, PendingRequest>,
  options: { entrypoint: string; surfaceId: string | null },
  diagnostic: { code: string; message: string; stderrTail: string; exitCode: number | null; signal: NodeJS.Signals | null },
): void {
  for (const request of pending.values()) {
    writePendingError(request, options, diagnostic);
  }
  pending.clear();
}

function writePendingError(
  request: PendingRequest,
  options: { entrypoint: string; surfaceId: string | null; requestTimeoutMs?: number },
  diagnostic: { code: string; message: string; stderrTail: string; exitCode: number | null; signal: NodeJS.Signals | null },
): void {
  clearTimeout(request.timeoutTimer);
  const proxyRequestTimeoutMs = typeof options.requestTimeoutMs === 'number' ? options.requestTimeoutMs : null;
  const proxyWatchdogData = diagnostic.code === 'child_request_timeout'
    ? {
      timeout_layer: 'mcp_runtime_proxy_watchdog',
      proxy_request_timeout_ms: proxyRequestTimeoutMs,
      requested_tool_timeout_ms: request.requestedToolTimeoutMs,
      surface_timeout_expected_before_proxy:
        request.requestedToolTimeoutMs !== null &&
        proxyRequestTimeoutMs !== null &&
        request.requestedToolTimeoutMs < proxyRequestTimeoutMs,
      kill_grace_ms: DEFAULT_REQUEST_TIMEOUT_KILL_GRACE_MS,
    }
    : {};
  writeJsonRpcMessage({
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32000,
      message: diagnostic.message,
      data: {
        schema: 'narada.mcp_runtime_proxy.error.v1',
        code: diagnostic.code,
        method: request.method,
        surface_id: options.surfaceId,
        entrypoint: options.entrypoint,
        exit_code: diagnostic.exitCode,
        signal: diagnostic.signal,
        stderr_tail: diagnostic.stderrTail,
        ...proxyWatchdogData,
      },
    },
  }, request.framed);
}

function extractRequestedToolTimeoutMs(request: JsonRecord): number | null {
  const params = request.params;
  if (!isJsonRecord(params)) return null;
  const directTimeoutMs = normalizedPositiveInteger(params.timeout_ms);
  if (directTimeoutMs !== null) return directTimeoutMs;
  const toolArguments = params.arguments;
  if (!isJsonRecord(toolArguments)) return null;
  return normalizedPositiveInteger(toolArguments.timeout_ms);
}

function normalizedPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendCancellationToChild(child: ReturnType<typeof spawn>, request: PendingRequest, reason: string): void {
  if (child.stdin.destroyed || !child.stdin.writable) return;
  writeJsonRpcMessageToStream(child.stdin, {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: {
      requestId: request.id,
      reason,
    },
  }, request.framed);
}

function rememberTimedOutRequest(timedOutRequests: Map<string | number, NodeJS.Timeout>, id: string | number): void {
  const existingTimer = timedOutRequests.get(id);
  if (existingTimer) clearTimeout(existingTimer);
  const cleanupTimer = setTimeout(() => {
    timedOutRequests.delete(id);
  }, SUPPRESSED_RESPONSE_TTL_MS);
  timedOutRequests.set(id, cleanupTimer);
}

function clearTimedOutRequests(timedOutRequests: Map<string | number, NodeJS.Timeout>): void {
  for (const timer of timedOutRequests.values()) clearTimeout(timer);
  timedOutRequests.clear();
}

function terminateChildAfterRequestTimeout(
  child: ReturnType<typeof spawn>,
  timers: Set<NodeJS.Timeout>,
  isChildClosed: () => boolean,
): void {
  if (!child.stdin.destroyed) child.stdin.end();
  child.kill('SIGTERM');
  const sigkillTimer = setTimeout(() => {
    timers.delete(sigkillTimer);
    if (!isChildClosed()) child.kill('SIGKILL');
  }, DEFAULT_REQUEST_TIMEOUT_KILL_GRACE_MS);
  timers.add(sigkillTimer);
}

function clearTimers(timers: Set<NodeJS.Timeout>): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`mcp_runtime_proxy_invalid_${name}:${value}`);
  return parsed;
}

function drainJsonLines(buffer: string): { framed: boolean; remaining: string; requests: JsonRecord[] } {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return { framed: false, remaining, requests: lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as JsonRecord) };
}

function drainJsonRpcFrames(buffer: string): { framed: boolean; remaining: string; requests: JsonRecord[] } {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    const alternateHeaderEnd = remaining.indexOf('\n\n');
    const end = headerEnd >= 0 ? headerEnd : alternateHeaderEnd;
    const separatorLength = headerEnd >= 0 ? 4 : 2;
    if (end < 0) break;
    const header = remaining.slice(0, end);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const start = end + separatorLength;
    const finish = start + length;
    if (remaining.length < finish) break;
    requests.push(JSON.parse(remaining.slice(start, finish)) as JsonRecord);
    remaining = remaining.slice(finish);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcMessage(message: JsonRecord, framed: boolean): void {
  writeJsonRpcMessageToStream(process.stdout, message, framed);
}

function writeJsonRpcMessageToStream(stream: NodeJS.WritableStream, message: JsonRecord, framed: boolean): void {
  const json = JSON.stringify(message);
  if (framed) stream.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  else stream.write(`${json}\n`);
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runProxy().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
