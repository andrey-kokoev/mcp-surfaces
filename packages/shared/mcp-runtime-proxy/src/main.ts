#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonRecord = Record<string, unknown>;
type RequestLifecycleEvent = {
  at: string;
  event: string;
  detail?: JsonRecord;
};
type PendingRequest = {
  id: string | number;
  method: string;
  framed: boolean;
  timeoutTimer: NodeJS.Timeout;
  requestedToolTimeoutMs: number | null;
  toolName: string | null;
  argsHash: string | null;
  argsSummary: JsonRecord;
  startedAt: string;
  progressToken: string | number | null;
  lastProgress: JsonRecord | null;
  lifecycle: RequestLifecycleEvent[];
};
type ProxyOptions = {
  entrypoint: string;
  childArgs: string[];
  surfaceId: string | null;
  requestTimeoutMs: number;
  diagnosticsDir: string | null;
};

const STDERR_TAIL_LIMIT = 8000;
const STDOUT_TAIL_LIMIT = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;
const DEFAULT_REQUEST_TIMEOUT_KILL_GRACE_MS = 5_000;
const SUPPRESSED_RESPONSE_TTL_MS = 60_000;
const FORENSIC_ARTIFACT_SCHEMA = 'narada.mcp_runtime_proxy.forensic_artifact.v1';

function parseArgs(argv: string[]): ProxyOptions {
  let entrypoint = '';
  let surfaceId: string | null = null;
  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  let diagnosticsDir = process.env.NARADA_MCP_RUNTIME_PROXY_DIAGNOSTICS_DIR ?? '';
  let passthroughIndex = argv.indexOf('--');
  if (passthroughIndex < 0) passthroughIndex = argv.length;
  const prelude = argv.slice(0, passthroughIndex);
  for (let index = 0; index < prelude.length; index += 1) {
    const arg = prelude[index];
    if (arg === '--entrypoint' && prelude[index + 1]) entrypoint = prelude[++index];
    else if (arg === '--surface-id' && prelude[index + 1]) surfaceId = prelude[++index];
    else if (arg === '--request-timeout-ms' && prelude[index + 1]) requestTimeoutMs = parsePositiveInteger(prelude[++index], 'request_timeout_ms');
    else if (arg === '--diagnostics-dir' && prelude[index + 1]) diagnosticsDir = prelude[++index];
  }
  if (!entrypoint) throw new Error('mcp_runtime_proxy_missing_entrypoint');
  return {
    entrypoint: resolve(entrypoint),
    childArgs: argv.slice(Math.min(passthroughIndex + 1, argv.length)),
    surfaceId,
    requestTimeoutMs,
    diagnosticsDir: diagnosticsDir ? resolve(diagnosticsDir) : defaultDiagnosticsDir(),
  };
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
  let stdoutTail = '';
  let childClosed = false;
  let parentFramed = false;
  const childIdentity = buildChildIdentity(options.entrypoint, options.childArgs);

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
    parentBuffer += chunk;
    const drained = parentBuffer.includes('Content-Length:') ? drainJsonRpcFrames(parentBuffer) : drainJsonLines(parentBuffer);
    parentBuffer = drained.remaining;
    if (drained.requests.length > 0) parentFramed = drained.framed;
    for (const request of drained.requests) {
      if (!child.stdin.destroyed) writeJsonRpcMessageToStream(child.stdin, request, false);
      const id = request.id;
      if ((typeof id === 'string' || typeof id === 'number') && typeof request.method === 'string') {
        const timeoutTimer = setTimeout(() => {
          const pendingRequest = pending.get(id);
          if (!pendingRequest) return;
          pending.delete(id);
          rememberTimedOutRequest(timedOutRequests, id);
          recordLifecycle(pendingRequest, 'proxy_timeout', {
            proxy_request_timeout_ms: options.requestTimeoutMs,
            requested_tool_timeout_ms: pendingRequest.requestedToolTimeoutMs,
          });
          recordLifecycle(pendingRequest, 'child_termination_requested', { signal: 'SIGTERM' });
          const artifactPath = writeForensicArtifact({
            event: 'proxy_child_request_timeout',
            request: pendingRequest,
            pending,
            options,
            child,
            childIdentity,
            stderrTail,
            stdoutTail,
            childBuffer,
            diagnostic: {
              code: 'child_request_timeout',
              message: `child_request_timeout:${request.method}:${options.requestTimeoutMs}ms`,
              exitCode: null,
              signal: null,
            },
          });
          writePendingError(pendingRequest, options, {
            code: 'child_request_timeout',
            message: `child_request_timeout:${request.method}:${options.requestTimeoutMs}ms`,
            stderrTail,
            stdoutTail,
            exitCode: null,
            signal: null,
            forensicArtifactPath: artifactPath,
          });
          sendCancellationToChild(child, pendingRequest, 'request timed out in mcp runtime proxy');
          recordLifecycle(pendingRequest, 'cancellation_sent');
          terminateChildAfterRequestTimeout(child, childTerminationTimers, () => childClosed);
        }, options.requestTimeoutMs);
        const requestMetadata = requestMetadataFor(request);
        pending.set(id, {
          id,
          method: request.method,
          framed: drained.framed,
          timeoutTimer,
          requestedToolTimeoutMs: extractRequestedToolTimeoutMs(request),
          ...requestMetadata,
          startedAt: new Date().toISOString(),
          lastProgress: null,
          lifecycle: [{ at: new Date().toISOString(), event: 'request_forwarded' }],
        });
      }
    }
  });

  process.stdin.on('end', () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });

  child.stdout.on('data', (chunk) => {
    stdoutTail = tail(`${stdoutTail}${chunk}`, STDOUT_TAIL_LIMIT);
    childBuffer += chunk;
    const drained = childBuffer.includes('Content-Length:') ? drainJsonRpcFrames(childBuffer) : drainJsonLines(childBuffer);
    childBuffer = drained.remaining;
    for (const response of drained.requests) {
      observeChildMessage(response, pending);
      const id = response.id;
      let responseFramed = parentFramed;
      if (typeof id === 'string' || typeof id === 'number') {
        const request = pending.get(id);
        if (request) {
          responseFramed = request.framed;
          recordLifecycle(request, 'child_response');
          clearTimeout(request.timeoutTimer);
        }
        pending.delete(id);
        if (timedOutRequests.has(id)) continue;
      }
      writeJsonRpcMessage(response, responseFramed);
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
      stdoutTail,
      exitCode: null,
      signal: null,
    }, child, childIdentity, childBuffer);
  });

  child.on('close', (code, signal) => {
    childClosed = true;
    process.stdin.pause();
    if (pending.size > 0) {
      flushPendingErrors(pending, options, {
        code: 'child_exited_before_response',
        message: `child_exited_before_response:${code ?? signal ?? 'unknown'}`,
        stderrTail,
        stdoutTail,
        exitCode: code,
        signal,
      }, child, childIdentity, childBuffer);
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
  options: ProxyOptions,
  diagnostic: ProxyDiagnostic,
  child: ReturnType<typeof spawn>,
  childIdentity: JsonRecord,
  childBuffer: string,
): void {
  for (const request of pending.values()) {
    const forensicArtifactPath = writeForensicArtifact({
      event: diagnostic.code,
      request,
      pending,
      options,
      child,
      childIdentity,
      stderrTail: diagnostic.stderrTail,
      stdoutTail: diagnostic.stdoutTail,
      childBuffer,
      diagnostic,
    });
    writePendingError(request, options, { ...diagnostic, forensicArtifactPath });
  }
  pending.clear();
}

type ProxyDiagnostic = {
  code: string;
  message: string;
  stderrTail: string;
  stdoutTail: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forensicArtifactPath?: string | null;
};

function writePendingError(
  request: PendingRequest,
  options: { entrypoint: string; surfaceId: string | null; requestTimeoutMs?: number },
  diagnostic: ProxyDiagnostic,
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
        stdout_tail: diagnostic.stdoutTail,
        forensic_artifact_path: diagnostic.forensicArtifactPath ?? null,
        ...proxyWatchdogData,
      },
    },
  }, false);
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

function requestMetadataFor(request: JsonRecord): Pick<PendingRequest, 'toolName' | 'argsHash' | 'argsSummary' | 'progressToken'> {
  const params = isJsonRecord(request.params) ? request.params : {};
  const toolName = typeof params.name === 'string' ? params.name : null;
  const toolArguments = isJsonRecord(params.arguments) ? params.arguments : {};
  const meta = isJsonRecord(params._meta) ? params._meta : {};
  const progressToken = typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number' ? meta.progressToken : null;
  return {
    toolName,
    argsHash: Object.keys(toolArguments).length > 0 ? sha256Json(toolArguments) : null,
    argsSummary: summarizeJson(toolArguments),
    progressToken,
  };
}

function observeChildMessage(message: JsonRecord, pending: Map<string | number, PendingRequest>): void {
  if (message.method === 'notifications/progress') {
    const params = isJsonRecord(message.params) ? message.params : {};
    const progressToken = params.progressToken;
    for (const request of pending.values()) {
      if (request.progressToken !== null && request.progressToken === progressToken) {
        request.lastProgress = summarizeJson(params);
        recordLifecycle(request, 'child_progress', request.lastProgress);
      }
    }
  }
}

function recordLifecycle(request: PendingRequest, event: string, detail?: JsonRecord): void {
  request.lifecycle.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
}

function writeForensicArtifact(input: {
  event: string;
  request: PendingRequest;
  pending: Map<string | number, PendingRequest>;
  options: { entrypoint: string; childArgs: string[]; surfaceId: string | null; requestTimeoutMs: number; diagnosticsDir: string | null };
  child: ReturnType<typeof spawn>;
  childIdentity: JsonRecord;
  stderrTail: string;
  stdoutTail: string;
  childBuffer: string;
  diagnostic: { code: string; message: string; exitCode: number | null; signal: NodeJS.Signals | null };
}): string | null {
  if (!input.options.diagnosticsDir) return null;
  try {
    mkdirSync(input.options.diagnosticsDir, { recursive: true });
    const now = new Date();
    const artifact = {
      schema: FORENSIC_ARTIFACT_SCHEMA,
      event: input.event,
      captured_at: now.toISOString(),
      proxy: {
        pid: process.pid,
        ppid: process.ppid,
        argv: process.argv,
        cwd: process.cwd(),
        request_timeout_ms: input.options.requestTimeoutMs,
        kill_grace_ms: DEFAULT_REQUEST_TIMEOUT_KILL_GRACE_MS,
      },
      surface: {
        surface_id: input.options.surfaceId,
        entrypoint: input.options.entrypoint,
        child_args: input.options.childArgs,
      },
      child_process: {
        pid: input.child.pid ?? null,
        killed: input.child.killed,
        exit_code: input.diagnostic.exitCode,
        signal: input.diagnostic.signal,
        ...input.childIdentity,
      },
      diagnostic: input.diagnostic,
      request: serializeRequest(input.request),
      pending_requests: [...input.pending.values()].map(serializeRequest),
      stream_tails: {
        stderr_tail: input.stderrTail,
        stdout_tail: input.stdoutTail,
        child_stdout_partial_buffer_tail: tail(input.childBuffer, STDOUT_TAIL_LIMIT),
      },
    };
    const fileName = `${toArtifactTimestamp(now)}-${safeSegment(input.options.surfaceId ?? 'surface')}-${safeSegment(String(input.request.id))}-${safeSegment(input.event)}.json`;
    const artifactPath = join(input.options.diagnosticsDir, fileName);
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    return artifactPath;
  } catch {
    return null;
  }
}

function serializeRequest(request: PendingRequest): JsonRecord {
  return {
    id: request.id,
    method: request.method,
    tool_name: request.toolName,
    started_at: request.startedAt,
    age_ms: Date.now() - Date.parse(request.startedAt),
    requested_tool_timeout_ms: request.requestedToolTimeoutMs,
    progress_token: request.progressToken,
    last_progress: request.lastProgress,
    args_hash: request.argsHash,
    args_summary: request.argsSummary,
    lifecycle: request.lifecycle,
  };
}

function buildChildIdentity(entrypoint: string, childArgs: string[]): JsonRecord {
  const entrypointStat = safeStat(entrypoint);
  const sourcePath = sourcePathForEntrypoint(entrypoint);
  const sourceStat = sourcePath ? safeStat(sourcePath) : null;
  return {
    parent_pid: process.pid,
    command: process.execPath,
    entrypoint,
    child_args: childArgs,
    entrypoint_basename: basename(entrypoint),
    entrypoint_sha256: sha256File(entrypoint),
    entrypoint_mtime: entrypointStat?.mtime.toISOString() ?? null,
    entrypoint_size: entrypointStat?.size ?? null,
    source_path: sourcePath,
    source_sha256: sourcePath ? sha256File(sourcePath) : null,
    source_mtime: sourceStat?.mtime.toISOString() ?? null,
    source_size: sourceStat?.size ?? null,
    build_freshness: sourceStat && entrypointStat
      ? sourceStat.mtimeMs > entrypointStat.mtimeMs ? 'source_newer_than_entrypoint' : 'entrypoint_not_older_than_source'
      : 'unknown',
    package: packageMetadataFor(entrypoint),
  };
}

function sourcePathForEntrypoint(entrypoint: string): string | null {
  const normalized = entrypoint.replace(/\\/g, '/');
  const marker = '/dist/src/';
  const index = normalized.indexOf(marker);
  if (index < 0) return null;
  const candidate = `${normalized.slice(0, index)}/src/${normalized.slice(index + marker.length).replace(/\.js$/, '.ts')}`;
  return existsSync(candidate) ? candidate : null;
}

function packageMetadataFor(entrypoint: string): JsonRecord | null {
  let current = dirname(entrypoint);
  for (let i = 0; i < 8; i += 1) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as JsonRecord;
        return {
          package_json_path: packagePath,
          name: typeof parsed.name === 'string' ? parsed.name : null,
          version: typeof parsed.version === 'string' ? parsed.version : null,
          package_json_sha256: sha256File(packagePath),
        };
      } catch {
        return { package_json_path: packagePath, status: 'unreadable' };
      }
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return null;
}

function defaultDiagnosticsDir(): string | null {
  const siteRoot = process.env.NARADA_SITE_ROOT || process.env.NARADA_WORKSPACE_ROOT || '';
  if (siteRoot) return join(resolve(siteRoot), '.ai', 'runtime', 'mcp-runtime-proxy');
  return join(process.cwd(), '.ai', 'runtime', 'mcp-runtime-proxy');
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function summarizeJson(value: JsonRecord): JsonRecord {
  const summary: JsonRecord = {};
  for (const [key, raw] of Object.entries(value).slice(0, 25)) {
    if (typeof raw === 'string') summary[key] = raw.length > 120 ? { type: 'string', length: raw.length, prefix: raw.slice(0, 120) } : raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) summary[key] = raw;
    else if (Array.isArray(raw)) summary[key] = { type: 'array', length: raw.length };
    else if (typeof raw === 'object') summary[key] = { type: 'object', keys: Object.keys(raw as JsonRecord).slice(0, 20) };
    else summary[key] = { type: typeof raw };
  }
  if (Object.keys(value).length > 25) summary.__truncated_keys = Object.keys(value).length - 25;
  return summary;
}

function toArtifactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z');
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'unknown';
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
