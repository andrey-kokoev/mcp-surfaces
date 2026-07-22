#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RUNTIME_STATUS_TOOL_NAME,
  captureRuntimeFreshness,
  classifyRuntimeInstance,
  evaluateRuntimeFreshness,
  listRuntimeInstances,
  processIsAlive,
  runtimeInstancePath,
  runtimeStatusToolDefinition,
  writeRuntimeInstance,
  type RuntimeInstanceRecord,
} from './runtime-lifecycle.js';

type JsonRecord = Record<string, unknown>;
type RequestLifecycleEvent = {
  at: string;
  event: string;
  detail?: JsonRecord;
};
type StartupTrace = {
  path: string | null;
  startedAt: string;
  completed: boolean;
  events: RequestLifecycleEvent[];
};
type PendingRequest = {
  id: string | number;
  method: string;
  framed: boolean;
  timeoutTimer: NodeJS.Timeout;
  requestedTransportTimeoutMs: number | null;
  effectiveTimeoutMs: number;
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
  toolTimeoutGraceMs: number;
  diagnosticsDir: string | null;
  livenessCheckMs: number;
  orphanGraceMs: number;
};

const STDERR_TAIL_LIMIT = 8000;
const STDOUT_TAIL_LIMIT = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;
const DEFAULT_REQUEST_TIMEOUT_KILL_GRACE_MS = 5_000;
const DEFAULT_TOOL_TIMEOUT_GRACE_MS = 15_000;
const MAX_TRANSPORT_TIMEOUT_MS = 900_000;
const MAX_TOOL_TIMEOUT_GRACE_MS = 60_000;
const DEFAULT_LIVENESS_CHECK_MS = 5_000;
const DEFAULT_ORPHAN_GRACE_MS = 15_000;
const MAX_LIVENESS_CHECK_MS = 60_000;
const MAX_ORPHAN_GRACE_MS = 120_000;
const SUPPRESSED_RESPONSE_TTL_MS = 60_000;
const FORENSIC_ARTIFACT_SCHEMA = 'narada.mcp_runtime_proxy.forensic_artifact.v1';
const STARTUP_TRACE_SCHEMA = 'narada.mcp_runtime_proxy.startup_trace.v1';

function parseArgs(argv: string[]): ProxyOptions {
  let entrypoint = '';
  let surfaceId: string | null = null;
  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  let toolTimeoutGraceMs = DEFAULT_TOOL_TIMEOUT_GRACE_MS;
  let diagnosticsDir = process.env.NARADA_MCP_RUNTIME_PROXY_DIAGNOSTICS_DIR ?? '';
  let livenessCheckMs = DEFAULT_LIVENESS_CHECK_MS;
  let orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS;
  let passthroughIndex = argv.indexOf('--');
  if (passthroughIndex < 0) passthroughIndex = argv.length;
  const prelude = argv.slice(0, passthroughIndex);
  for (let index = 0; index < prelude.length; index += 1) {
    const arg = prelude[index];
    if (arg === '--entrypoint' && prelude[index + 1]) entrypoint = prelude[++index];
    else if (arg === '--surface-id' && prelude[index + 1]) surfaceId = prelude[++index];
    else if (arg === '--request-timeout-ms' && prelude[index + 1]) requestTimeoutMs = parsePositiveInteger(prelude[++index], 'request_timeout_ms');
    else if (arg === '--tool-timeout-grace-ms' && prelude[index + 1]) toolTimeoutGraceMs = parsePositiveInteger(prelude[++index], 'tool_timeout_grace_ms', MAX_TOOL_TIMEOUT_GRACE_MS);
    else if (arg === '--diagnostics-dir' && prelude[index + 1]) diagnosticsDir = prelude[++index];
    else if (arg === '--liveness-check-ms' && prelude[index + 1]) livenessCheckMs = parsePositiveInteger(prelude[++index], 'liveness_check_ms', MAX_LIVENESS_CHECK_MS);
    else if (arg === '--orphan-grace-ms' && prelude[index + 1]) orphanGraceMs = parsePositiveInteger(prelude[++index], 'orphan_grace_ms', MAX_ORPHAN_GRACE_MS);
  }
  if (!entrypoint) throw new Error('mcp_runtime_proxy_missing_entrypoint');
  return {
    entrypoint: resolve(entrypoint),
    childArgs: argv.slice(Math.min(passthroughIndex + 1, argv.length)),
    surfaceId,
    requestTimeoutMs,
    toolTimeoutGraceMs,
    diagnosticsDir: diagnosticsDir ? resolve(diagnosticsDir) : defaultDiagnosticsDir(),
    livenessCheckMs,
    orphanGraceMs,
  };
}

// The watchdog guards against a hung child. Callers that own a surface timeout
// must carry it in the transport-level _meta field below; arbitrary tool
// arguments remain domain data and are never interpreted here.
export function effectiveRequestTimeoutMs(proxyTimeoutMs: number, requestedTransportTimeoutMs: number | null, toolTimeoutGraceMs: number): number {
  if (requestedTransportTimeoutMs === null) return proxyTimeoutMs;
  const boundedRequestedTimeoutMs = Math.min(MAX_TRANSPORT_TIMEOUT_MS, requestedTransportTimeoutMs);
  // The 15-minute bound applies to the admitted transport timeout. Grace is
  // additive, so a timeout at the bound still receives the configured grace.
  return Math.max(proxyTimeoutMs, boundedRequestedTimeoutMs + toolTimeoutGraceMs);
}

function createStartupTrace(
  options: ProxyOptions,
  child: ReturnType<typeof spawn>,
  childIdentity: JsonRecord,
): StartupTrace {
  const trace: StartupTrace = {
    path: options.diagnosticsDir
      ? join(options.diagnosticsDir, `startup-${safeSegment(options.surfaceId ?? basename(options.entrypoint))}.json`)
      : null,
    startedAt: new Date().toISOString(),
    completed: false,
    events: [],
  };
  recordStartupTrace(trace, options, child, childIdentity, 'proxy_started', {
    proxy_pid: process.pid,
    child_pid: child.pid ?? null,
  });
  return trace;
}

function recordStartupTrace(
  trace: StartupTrace,
  options: ProxyOptions,
  child: ReturnType<typeof spawn>,
  childIdentity: JsonRecord,
  event: string,
  detail?: JsonRecord,
  completed = false,
): void {
  trace.events.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
  if (completed) trace.completed = true;
  if (!trace.path) return;
  try {
    mkdirSync(dirname(trace.path), { recursive: true });
    writeFileSync(trace.path, JSON.stringify({
      schema: STARTUP_TRACE_SCHEMA,
      surface_id: options.surfaceId,
      entrypoint: options.entrypoint,
      child_args: options.childArgs,
      started_at: trace.startedAt,
      updated_at: new Date().toISOString(),
      completed: trace.completed,
      proxy_pid: process.pid,
      child_pid: child.pid ?? null,
      child_identity: childIdentity,
      events: trace.events,
    }, null, 2) + '\n', 'utf8');
  } catch {
    // Startup tracing must never prevent the proxy from serving MCP traffic.
  }
}

function startsWithJsonRpcFrame(buffer: string): boolean {
  return /^\s*Content-Length:\s*\d+\r?\n/i.test(buffer);
}

export async function runProxy(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--list-runtime-instances')) {
    const diagnosticsIndex = argv.indexOf('--diagnostics-dir');
    const diagnosticsDir = diagnosticsIndex >= 0 && argv[diagnosticsIndex + 1]
      ? resolve(argv[diagnosticsIndex + 1])
      : defaultDiagnosticsDir();
    process.stdout.write(`${JSON.stringify(listRuntimeInstances(diagnosticsDir), null, 2)}\n`);
    return;
  }
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
  const startupTrace = createStartupTrace(options, child, childIdentity);
  const parentPid = process.ppid;
  const freshnessTracker = captureRuntimeFreshness({
    proxyRuntimePath: fileURLToPath(import.meta.url),
    childEntrypoint: options.entrypoint,
  });
  const instancePath = runtimeInstancePath(options.diagnosticsDir ?? defaultDiagnosticsDir());
  let reclamationReason: string | null = null;
  let orphanTerminationTimer: NodeJS.Timeout | null = null;
  let orphanForceKillTimer: NodeJS.Timeout | null = null;
  const writeInstance = (
    state: RuntimeInstanceRecord['state'],
    evidence: JsonRecord,
    closedAt: string | null = null,
  ) => {
    const now = new Date();
    const runtimeFreshness = evaluateRuntimeFreshness({
      tracker: freshnessTracker,
      surfaceId: options.surfaceId,
      proxyPid: process.pid,
      childPid: child.pid ?? null,
    });
    const record: RuntimeInstanceRecord = {
      schema: 'narada.mcp_runtime_proxy.instance.v1',
      surface_id: options.surfaceId,
      proxy_pid: process.pid,
      parent_pid: parentPid,
      child_pid: child.pid ?? null,
      entrypoint: options.entrypoint,
      started_at: freshnessTracker.started_at,
      heartbeat_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + options.livenessCheckMs * 3).toISOString(),
      state,
      liveness_evidence: evidence,
      runtime_freshness: runtimeFreshness,
      closed_at: closedAt,
    };
    writeRuntimeInstance(instancePath, record);
    return record;
  };
  let runtimeInstance = writeInstance('live', {
    parent_pid_alive: processIsAlive(parentPid),
    carrier_stdin_open: true,
  });
  const scheduleOrphanReclamation = (reason: string) => {
    if (childClosed || reclamationReason) return;
    reclamationReason = reason;
    runtimeInstance = writeInstance('stale', {
      reason,
      parent_pid_alive: processIsAlive(parentPid),
      carrier_stdin_open: reason !== 'carrier_stdin_closed',
      grace_ms: options.orphanGraceMs,
    });
    if (!child.stdin.destroyed) child.stdin.end();
    orphanTerminationTimer = setTimeout(() => {
      if (childClosed) return;
      runtimeInstance = writeInstance('reclaiming', {
        reason,
        signal: 'SIGTERM',
        grace_ms: options.orphanGraceMs,
      });
      child.kill('SIGTERM');
      orphanForceKillTimer = setTimeout(() => {
        if (!childClosed) child.kill('SIGKILL');
      }, Math.min(options.orphanGraceMs, 5_000));
      orphanForceKillTimer.unref();
    }, options.orphanGraceMs);
    orphanTerminationTimer.unref();
  };
  const livenessTimer = setInterval(() => {
    const parentAlive = processIsAlive(parentPid);
    if (!parentAlive) {
      scheduleOrphanReclamation('parent_carrier_pid_not_alive');
      return;
    }
    if (!reclamationReason && !childClosed) {
      runtimeInstance = writeInstance('live', {
        parent_pid_alive: true,
        carrier_stdin_open: !process.stdin.readableEnded,
      });
    }
  }, options.livenessCheckMs);
  livenessTimer.unref();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    parentBuffer += chunk;
    const drained = startsWithJsonRpcFrame(parentBuffer) ? drainJsonRpcFrames(parentBuffer) : drainJsonLines(parentBuffer);
    parentBuffer = drained.remaining;
    if (drained.requests.length > 0) parentFramed = drained.framed;
    for (const request of drained.requests) {
      const params = isJsonRecord(request.params) ? request.params : {};
      if (request.method === 'tools/call' && params.name === RUNTIME_STATUS_TOOL_NAME) {
        const id = request.id;
        if (typeof id === 'string' || typeof id === 'number') {
          const runtimeFreshness = evaluateRuntimeFreshness({
            tracker: freshnessTracker,
            surfaceId: options.surfaceId,
            proxyPid: process.pid,
            childPid: child.pid ?? null,
          });
          const liveness = classifyRuntimeInstance(runtimeInstance);
          const payload = {
            schema: 'narada.mcp_runtime_proxy.status.v1',
            status: 'ok',
            surface_id: options.surfaceId,
            liveness,
            runtime_freshness: runtimeFreshness,
          };
          writeJsonRpcMessage({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `mcp_runtime_proxy_status: ${runtimeFreshness.status}\nproxy_pid: ${process.pid}\nchild_pid: ${child.pid ?? 'unknown'}\nrestart_owner: carrier_or_runtime_supervisor` }],
              structuredContent: payload,
            },
          }, drained.framed);
        }
        continue;
      }
      if (!child.stdin.destroyed) writeJsonRpcMessageToStream(child.stdin, request, false);
      if (request.method === 'initialize' || request.method === 'tools/list') {
        recordStartupTrace(startupTrace, options, child, childIdentity, 'request_forwarded', {
          method: request.method,
          request_id: request.id ?? null,
        });
      }
      const id = request.id;
      if ((typeof id === 'string' || typeof id === 'number') && typeof request.method === 'string') {
        const requestedTransportTimeoutMs = extractRequestedTransportTimeoutMs(request);
        const effectiveTimeoutMs = effectiveRequestTimeoutMs(options.requestTimeoutMs, requestedTransportTimeoutMs, options.toolTimeoutGraceMs);
        const timeoutTimer = setTimeout(() => {
          const pendingRequest = pending.get(id);
          if (!pendingRequest) return;
          pending.delete(id);
          rememberTimedOutRequest(timedOutRequests, id);
          recordLifecycle(pendingRequest, 'proxy_timeout', {
            proxy_request_timeout_ms: options.requestTimeoutMs,
            effective_request_timeout_ms: pendingRequest.effectiveTimeoutMs,
            requested_transport_timeout_ms: pendingRequest.requestedTransportTimeoutMs,
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
              message: `child_request_timeout:${request.method}:${pendingRequest.effectiveTimeoutMs}ms`,
              exitCode: null,
              signal: null,
            },
          });
          writePendingError(pendingRequest, options, {
            code: 'child_request_timeout',
            message: `child_request_timeout:${request.method}:${pendingRequest.effectiveTimeoutMs}ms`,
            stderrTail,
            stdoutTail,
            exitCode: null,
            signal: null,
            forensicArtifactPath: artifactPath,
          });
          sendCancellationToChild(child, pendingRequest, 'request timed out in mcp runtime proxy');
          recordLifecycle(pendingRequest, 'cancellation_sent');
          terminateChildAfterRequestTimeout(child, childTerminationTimers, () => childClosed);
        }, effectiveTimeoutMs);
        const requestMetadata = requestMetadataFor(request);
        pending.set(id, {
          id,
          method: request.method,
          framed: drained.framed,
          timeoutTimer,
          requestedTransportTimeoutMs,
          effectiveTimeoutMs,
          ...requestMetadata,
          startedAt: new Date().toISOString(),
          lastProgress: null,
          lifecycle: [{ at: new Date().toISOString(), event: 'request_forwarded' }],
        });
      }
    }
  });

  process.stdin.on('end', () => {
    scheduleOrphanReclamation('carrier_stdin_closed');
  });

  child.stdout.on('data', (chunk) => {
    stdoutTail = tail(`${stdoutTail}${chunk}`, STDOUT_TAIL_LIMIT);
    childBuffer += chunk;
    const drained = startsWithJsonRpcFrame(childBuffer) ? drainJsonRpcFrames(childBuffer) : drainJsonLines(childBuffer);
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
          if (request.method === 'initialize' || request.method === 'tools/list') {
            recordStartupTrace(startupTrace, options, child, childIdentity, 'child_response', {
              method: request.method,
              request_id: request.id,
            }, request.method === 'tools/list');
          }
          clearTimeout(request.timeoutTimer);
          if (request.method === 'tools/list' && isJsonRecord(response.result) && Array.isArray(response.result.tools)) {
            if (!response.result.tools.some((tool) => isJsonRecord(tool) && tool.name === RUNTIME_STATUS_TOOL_NAME)) {
              response.result.tools.push(runtimeStatusToolDefinition());
            }
          }
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
    recordStartupTrace(startupTrace, options, child, childIdentity, 'child_error', { message: error.message });
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
    if (!startupTrace.completed) {
      recordStartupTrace(startupTrace, options, child, childIdentity, 'child_closed_before_tools_list', {
        exit_code: code,
        signal,
      });
    }
    childClosed = true;
    clearInterval(livenessTimer);
    if (orphanTerminationTimer) clearTimeout(orphanTerminationTimer);
    if (orphanForceKillTimer) clearTimeout(orphanForceKillTimer);
    runtimeInstance = writeInstance(reclamationReason ? 'reclaimed' : 'closed', {
      reason: reclamationReason ?? 'child_closed',
      exit_code: code,
      signal,
      parent_pid_alive: processIsAlive(parentPid),
    }, new Date().toISOString());
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
  // A terminal child failure can be observed in the same tick as the proxy's
  // exit. Close stdout only after the diagnostic write has drained so callers
  // never lose the structured child_exited_before_response error.
  await flushProxyStdout();
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
  options: { entrypoint: string; surfaceId: string | null; requestTimeoutMs?: number; toolTimeoutGraceMs?: number },
  diagnostic: ProxyDiagnostic,
): void {
  clearTimeout(request.timeoutTimer);
  const proxyRequestTimeoutMs = typeof options.requestTimeoutMs === 'number' ? options.requestTimeoutMs : null;
  const toolTimeoutGraceMs = typeof options.toolTimeoutGraceMs === 'number' ? options.toolTimeoutGraceMs : DEFAULT_TOOL_TIMEOUT_GRACE_MS;
  const proxyWatchdogData = diagnostic.code === 'child_request_timeout'
    ? {
      timeout_layer: 'mcp_runtime_proxy_watchdog',
      proxy_request_timeout_ms: proxyRequestTimeoutMs,
      effective_request_timeout_ms: request.effectiveTimeoutMs,
      requested_transport_timeout_ms: request.requestedTransportTimeoutMs,
      tool_timeout_grace_ms: toolTimeoutGraceMs,
      surface_timeout_expected_before_proxy:
        request.requestedTransportTimeoutMs !== null &&
        request.requestedTransportTimeoutMs + toolTimeoutGraceMs <= request.effectiveTimeoutMs,
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

function extractRequestedTransportTimeoutMs(request: JsonRecord): number | null {
  const params = request.params;
  if (!isJsonRecord(params)) return null;
  const meta = params._meta;
  if (!isJsonRecord(meta)) return null;
  return normalizedPositiveInteger(meta.narada_request_timeout_ms);
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
  options: ProxyOptions;
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
        tool_timeout_grace_ms: input.options.toolTimeoutGraceMs,
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
    requested_transport_timeout_ms: request.requestedTransportTimeoutMs,
    effective_request_timeout_ms: request.effectiveTimeoutMs,
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
  return date.toISOString().replace(/[-:.]/g, '');
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

function parsePositiveInteger(value: string, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`mcp_runtime_proxy_invalid_${name}:${value}`);
  return parsed;
}

function drainJsonLines(buffer: string): { framed: boolean; remaining: string; requests: JsonRecord[] } {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return {
    framed: false,
    remaining,
    // A carrier may append a presentation continuation marker after an
    // otherwise complete JSON-RPC line. Never let that marker crash the
    // proxy; recover the complete JSON object and discard only the trailing
    // non-protocol text. Standalone malformed lines are ignored as well so
    // child stdout cannot become an uncaught parser exception.
    requests: lines
      .map(parseJsonLine)
      .filter((line): line is JsonRecord => line !== null),
  };
}

function parseJsonLine(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    const prefixEnd = firstJsonValueEnd(trimmed);
    if (prefixEnd === null || prefixEnd >= trimmed.length) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(0, prefixEnd));
      return isJsonRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function firstJsonValueEnd(text: string): number | null {
  const first = text[0];
  if (first !== '{' && first !== '[') return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }
    if (character !== '}' && character !== ']') continue;
    const expected = character === '}' ? '{' : '[';
    if (stack.pop() !== expected) return null;
    if (stack.length === 0) return index + 1;
  }
  return null;
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

async function flushProxyStdout(): Promise<void> {
  if (process.stdout.writableEnded || process.stdout.destroyed) return;
  await new Promise<void>((resolve) => {
    process.stdout.end(() => resolve());
  });
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
