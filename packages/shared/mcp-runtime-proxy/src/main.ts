#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLiveToolsConform,
  completeLiveSurfaceTools,
  isStandardSurfaceToolName,
  standardSurfaceToolResult,
  type McpToolDefinition,
} from '@narada2/mcp-fabric-contracts';
import {
  acquireArtifactLease,
  type ArtifactLeaseHandle,
  type Sha256Digest,
} from '@narada2/artifact-integrity';
import { processSupervisorEntrypoint } from '@narada2/process-launch-posture';
import {
  CarrierGenerationError,
  MCP_RUNTIME_CONTRACT_VERSION,
  resolveCarrierBinding,
  resolvePinnedRuntimeProxy,
  type CarrierGeneration,
  type CarrierGenerationBinding,
} from './carrier-generation.js';
import {
  RUNTIME_INSTANCE_SCHEMA,
  captureRuntimeFreshness,
  classifyRuntimeInstance,
  defaultRuntimeDiagnosticsDir,
  evaluateRuntimeFreshness,
  listRuntimeInstances,
  processIsAlive,
  runtimeInstancePath,
  writeRuntimeInstance,
  type RuntimeInstanceRecord,
} from './runtime-lifecycle.js';

type JsonRecord = Record<string, unknown>;

type PendingRequest = {
  id: string | number;
  method: string;
  framed: boolean;
  timeout: NodeJS.Timeout;
  started_at: string;
  tool_name: string | null;
  effective_timeout_ms: number;
};

type ProxyOptions = {
  runtimeContractVersion: number;
  carrierGenerationPath: string;
  serverKey: string;
  artifactStore: string;
  requestTimeoutMs: number;
  toolTimeoutGraceMs: number;
  diagnosticsDir: string;
  livenessCheckMs: number;
};

type ResolvedRuntime = {
  generation: CarrierGeneration;
  binding: CarrierGenerationBinding;
  entrypoint: string;
  childArgs: string[];
  closureDigest: Sha256Digest;
  receiptDigest: Sha256Digest;
};

type ChildLaunch = {
  child: ChildProcessWithoutNullStreams;
  supervisorPath: string | null;
  supervisorIdentityPath: string | null;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;
const DEFAULT_TOOL_TIMEOUT_GRACE_MS = 15_000;
const MAX_TRANSPORT_TIMEOUT_MS = 900_000;
const MAX_TOOL_TIMEOUT_GRACE_MS = 60_000;
const DEFAULT_LIVENESS_CHECK_MS = 5_000;
const MAX_LIVENESS_CHECK_MS = 60_000;
const STDERR_TAIL_LIMIT = 8_000;
const STDOUT_TAIL_LIMIT = 8_000;
const REQUEST_ID_TOMBSTONE_MS = 60_000;
const STARTUP_TRACE_SCHEMA = 'narada.mcp_runtime_proxy.startup_trace.v3';

function requiredArgument(value: string | null, name: string): string {
  if (!value) throw new CarrierGenerationError('runtime_argument_missing', `Missing required ${name}.`);
  return value;
}

function parsePositiveInteger(value: string, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new CarrierGenerationError('runtime_argument_invalid', `${name} must be a positive integer.`, {
      argument: name,
      value,
      maximum,
    });
  }
  return parsed;
}

function parseArgs(argv: string[]): ProxyOptions {
  const values = new Map<string, string>();
  const admitted = new Set([
    '--runtime-contract-version',
    '--carrier-generation',
    '--server-key',
    '--artifact-store',
    '--request-timeout-ms',
    '--tool-timeout-grace-ms',
    '--diagnostics-dir',
    '--liveness-check-ms',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !admitted.has(name) || !value || value.startsWith('--')) {
      throw new CarrierGenerationError(
        'runtime_argument_invalid',
        `Unsupported or incomplete runtime proxy argument at index ${index}.`,
        { argv },
      );
    }
    if (values.has(name)) {
      throw new CarrierGenerationError('runtime_argument_invalid', `Duplicate runtime proxy argument: ${name}`);
    }
    values.set(name, value);
  }
  const runtimeContractVersion = parsePositiveInteger(
    requiredArgument(values.get('--runtime-contract-version') ?? null, '--runtime-contract-version'),
    'runtime_contract_version',
  );
  if (runtimeContractVersion !== MCP_RUNTIME_CONTRACT_VERSION) {
    throw new CarrierGenerationError(
      'runtime_contract_version_mismatch',
      'The launch does not declare MCP runtime contract V3.',
      { expected: MCP_RUNTIME_CONTRACT_VERSION, actual: runtimeContractVersion },
    );
  }
  return {
    runtimeContractVersion,
    carrierGenerationPath: resolve(requiredArgument(
      values.get('--carrier-generation') ?? null,
      '--carrier-generation',
    )),
    serverKey: requiredArgument(values.get('--server-key') ?? null, '--server-key'),
    artifactStore: resolve(requiredArgument(values.get('--artifact-store') ?? null, '--artifact-store')),
    requestTimeoutMs: values.has('--request-timeout-ms')
      ? parsePositiveInteger(values.get('--request-timeout-ms')!, 'request_timeout_ms')
      : DEFAULT_REQUEST_TIMEOUT_MS,
    toolTimeoutGraceMs: values.has('--tool-timeout-grace-ms')
      ? parsePositiveInteger(
          values.get('--tool-timeout-grace-ms')!,
          'tool_timeout_grace_ms',
          MAX_TOOL_TIMEOUT_GRACE_MS,
        )
      : DEFAULT_TOOL_TIMEOUT_GRACE_MS,
    diagnosticsDir: resolve(
      values.get('--diagnostics-dir')
      ?? process.env.NARADA_MCP_RUNTIME_PROXY_DIAGNOSTICS_DIR
      ?? defaultRuntimeDiagnosticsDir(),
    ),
    livenessCheckMs: values.has('--liveness-check-ms')
      ? parsePositiveInteger(
          values.get('--liveness-check-ms')!,
          'liveness_check_ms',
          MAX_LIVENESS_CHECK_MS,
        )
      : DEFAULT_LIVENESS_CHECK_MS,
  };
}

export function effectiveRequestTimeoutMs(
  proxyTimeoutMs: number,
  requestedTransportTimeoutMs: number | null,
  toolTimeoutGraceMs: number,
): number {
  if (requestedTransportTimeoutMs === null) return proxyTimeoutMs;
  return Math.max(
    proxyTimeoutMs,
    Math.min(MAX_TRANSPORT_TIMEOUT_MS, requestedTransportTimeoutMs) + toolTimeoutGraceMs,
  );
}

export function clientVisibleToolDefinitions(
  binding: Pick<CarrierGenerationBinding, 'descriptor' | 'client_tool_names' | 'surface_id'>,
  liveTools: McpToolDefinition[],
): McpToolDefinition[] {
  assertLiveToolsConform(binding.descriptor, liveTools);
  const completeTools = completeLiveSurfaceTools(liveTools);
  const admittedNames = new Set(binding.client_tool_names);
  const completeNames = new Set(completeTools.map((tool) => tool.name));
  const missingNames = binding.client_tool_names.filter((name) => !completeNames.has(name));
  if (missingNames.length > 0) {
    throw new CarrierGenerationError(
      'binding_artifact_incompatible',
      'The sealed child does not provide every client-visible tool in the immutable binding.',
      {
        surface_id: binding.surface_id,
        missing_client_tool_names: missingNames,
      },
    );
  }
  return completeTools.filter((tool) => admittedNames.has(tool.name));
}

function currentLaunchArgs(argv: string[]): string[] {
  return [resolve(fileURLToPath(import.meta.url)), ...argv];
}

function pathEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function validateExecutingLaunch(binding: CarrierGenerationBinding, argv: string[]): void {
  if (!pathEqual(binding.proxy_launch.command, process.execPath)) {
    throw new CarrierGenerationError(
      'carrier_runtime_proxy_unsealed',
      'The executing runtime does not match the immutable carrier binding.',
      {
        expected_command: binding.proxy_launch.command,
        actual_command: process.execPath,
      },
    );
  }
  const expected = binding.proxy_launch.args;
  const actual = currentLaunchArgs(argv);
  if (expected.length !== actual.length || !pathEqual(expected[0] ?? '', actual[0] ?? '')) {
    throw new CarrierGenerationError(
      'carrier_runtime_proxy_unsealed',
      'The executing proxy launch does not match the immutable carrier binding.',
      { expected_args: expected, actual_args: actual },
    );
  }
  for (let index = 1; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) {
      throw new CarrierGenerationError(
        'carrier_binding_stale',
        'The executing proxy arguments do not match the immutable carrier binding.',
        { expected_args: expected, actual_args: actual, mismatch_index: index },
      );
    }
  }
}

async function resolveRuntime(options: ProxyOptions, argv: string[]): Promise<ResolvedRuntime> {
  const resolvedBinding = await resolveCarrierBinding({
    generation_path: options.carrierGenerationPath,
    server_key: options.serverKey,
    artifact_store: options.artifactStore,
  });
  validateExecutingLaunch(resolvedBinding.binding, argv);
  await resolvePinnedRuntimeProxy({
    generation: resolvedBinding.generation,
    runtime_entrypoint: fileURLToPath(import.meta.url),
  });
  return {
    generation: resolvedBinding.generation,
    binding: resolvedBinding.binding,
    entrypoint: resolvedBinding.child_entrypoint,
    childArgs: resolvedBinding.binding.child_args,
    closureDigest: resolvedBinding.closure_digest,
    receiptDigest: resolvedBinding.receipt_digest,
  };
}

export async function runProxy(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--list-runtime-instances')) {
    const diagnosticsIndex = argv.indexOf('--diagnostics-dir');
    const diagnosticsDir = diagnosticsIndex >= 0 && argv[diagnosticsIndex + 1]
      ? resolve(argv[diagnosticsIndex + 1]!)
      : defaultRuntimeDiagnosticsDir();
    process.stdout.write(`${JSON.stringify(listRuntimeInstances(diagnosticsDir), null, 2)}\n`);
    return;
  }

  let options: ProxyOptions;
  let runtime: ResolvedRuntime;
  let artifactLeases: ArtifactLeaseHandle[] = [];
  try {
    options = parseArgs(argv);
    runtime = await resolveRuntime(options, argv);
    const supervisor = processSupervisorEntrypoint();
    if (process.platform === 'win32' && (!supervisor || !existsSync(supervisor))) {
      throw new CarrierGenerationError(
        'runtime_supervisor_missing',
        'The sealed Windows process supervisor is missing.',
        { supervisor_path: supervisor },
      );
    }
    artifactLeases = [
      await acquireArtifactLease({
        store_root: runtime.binding.artifact_selector.store_root,
        package_name: runtime.binding.artifact_selector.package_name,
        compatibility: runtime.binding.artifact_selector.compatibility,
        closure_digest: runtime.closureDigest,
        receipt_digest: runtime.receiptDigest,
      }),
      await acquireArtifactLease({
        store_root: runtime.generation.runtime_proxy.artifact_selector.store_root,
        package_name: runtime.generation.runtime_proxy.artifact_selector.package_name,
        compatibility: runtime.generation.runtime_proxy.artifact_selector.compatibility,
        closure_digest: runtime.generation.runtime_proxy.closure_digest,
        receipt_digest: runtime.generation.runtime_proxy.receipt_digest,
      }),
    ];
  } catch (error) {
    let refusalSource: unknown = error;
    try {
      await releaseArtifactLeases(artifactLeases);
    } catch (cleanupError) {
      refusalSource = new CarrierGenerationError(
        'runtime_preflight_cleanup_failed',
        'Runtime preflight failed and artifact lease cleanup also failed.',
        {
          original_error: error instanceof Error ? error.message : String(error),
          cleanup_error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        },
        { cause: cleanupError },
      );
    }
    const refusal = refusalSource instanceof CarrierGenerationError
      ? refusalSource
      : new CarrierGenerationError(
          'runtime_preflight_failed',
          refusalSource instanceof Error ? refusalSource.message : String(refusalSource),
          {},
          { cause: refusalSource },
        );
    await writePreflightRefusal(refusal);
    process.exitCode = 1;
    return;
  }

  const supervisorPath = processSupervisorEntrypoint();
  const childLaunch = spawnProxyChild(runtime, options, supervisorPath);
  const child = childLaunch.child;
  const parentPid = process.ppid;
  const pending = new Map<string | number, PendingRequest>();
  const tombstonedRequestIds = new Map<string | number, NodeJS.Timeout>();
  let parentBuffer = '';
  let childBuffer = '';
  let stderrTail = '';
  let stdoutTail = '';
  let parentFramed = false;
  let childClosed = false;
  let observedCapabilities: JsonRecord = {};
  const runtimePath = fileURLToPath(import.meta.url);
  const freshnessTracker = captureRuntimeFreshness({
    proxyRuntimePath: runtimePath,
    childEntrypoint: runtime.entrypoint,
    carrierGenerationPath: options.carrierGenerationPath,
    carrierGenerationDigest: runtime.generation.generation_digest,
  });
  const instancePath = runtimeInstancePath(options.diagnosticsDir);
  const startupTracePath = join(
    options.diagnosticsDir,
    `startup-${safeSegment(runtime.binding.surface_id)}-${process.pid}.json`,
  );
  const startupEvents: JsonRecord[] = [];

  const recordStartup = (event: string, detail: JsonRecord = {}) => {
    startupEvents.push({ at: new Date().toISOString(), event, detail });
    try {
      mkdirSync(dirname(startupTracePath), { recursive: true });
      writeFileSync(startupTracePath, `${JSON.stringify({
        schema: STARTUP_TRACE_SCHEMA,
        surface_id: runtime.binding.surface_id,
        server_key: runtime.binding.server_key,
        runtime_contract_version: options.runtimeContractVersion,
        carrier_generation_path: options.carrierGenerationPath,
        carrier_generation_digest: runtime.generation.generation_digest,
        closure_digest: runtime.closureDigest,
        receipt_digest: runtime.receiptDigest,
        proxy_pid: process.pid,
        child_pid: child.pid ?? null,
        events: startupEvents,
      }, null, 2)}\n`, 'utf8');
    } catch {
      // Diagnostics never acquire runtime-control authority.
    }
  };

  const writeInstance = (
    state: RuntimeInstanceRecord['state'],
    evidence: JsonRecord,
    closedAt: string | null = null,
  ): RuntimeInstanceRecord => {
    const now = new Date();
    const supervisorIdentity = childLaunch.supervisorIdentityPath
      ? readSupervisorIdentity(childLaunch.supervisorIdentityPath)
      : null;
    const managedChildPid = typeof supervisorIdentity?.managed_child_pid === 'number'
      ? supervisorIdentity.managed_child_pid
      : null;
    const runtimeFreshness = evaluateRuntimeFreshness({
      tracker: freshnessTracker,
      surfaceId: runtime.binding.surface_id,
      proxyPid: process.pid,
      childPid: child.pid ?? null,
    });
    const record: RuntimeInstanceRecord = {
      schema: RUNTIME_INSTANCE_SCHEMA,
      surface_id: runtime.binding.surface_id,
      server_key: runtime.binding.server_key,
      proxy_pid: process.pid,
      parent_pid: parentPid,
      child_pid: child.pid ?? null,
      supervisor_pid: childLaunch.supervisorPath ? child.pid ?? null : null,
      managed_child_pid: managedChildPid,
      server_pid: managedChildPid ?? (childLaunch.supervisorPath ? null : child.pid ?? null),
      entrypoint: runtime.entrypoint,
      started_at: freshnessTracker.started_at,
      heartbeat_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + options.livenessCheckMs * 3).toISOString(),
      state,
      liveness_evidence: evidence,
      runtime_freshness: runtimeFreshness,
      carrier_generation_path: options.carrierGenerationPath,
      carrier_generation_digest: runtime.generation.generation_digest,
      closure_digest: runtime.closureDigest,
      receipt_digest: runtime.receiptDigest,
      generation_id: runtime.generation.generation_id,
      closed_at: closedAt,
    };
    writeRuntimeInstance(instancePath, record);
    return record;
  };

  let runtimeInstance = writeInstance('live', {
    parent_pid_alive: processIsAlive(parentPid),
    carrier_stdin_open: true,
  });
  const admittedClientTools = new Set(runtime.binding.client_tool_names);
  const currentRuntimeObservation = (): JsonRecord => {
    const runtimeFreshness = evaluateRuntimeFreshness({
      tracker: freshnessTracker,
      surfaceId: runtime.binding.surface_id,
      proxyPid: process.pid,
      childPid: child.pid ?? null,
    });
    const classified = classifyRuntimeInstance({
      ...runtimeInstance,
      runtime_freshness: runtimeFreshness,
    });
    return {
      schema: 'narada.mcp_surface.runtime.v1',
      status: classified.observed_state === 'live' && runtimeFreshness.status === 'pinned'
        ? 'ok'
        : 'degraded',
      runtime_contract_version: options.runtimeContractVersion,
      carrier_id: runtime.generation.carrier_id,
      carrier_kind: runtime.generation.carrier_kind,
      server_key: runtime.binding.server_key,
      generation_id: runtime.generation.generation_id,
      generation_digest: runtime.generation.generation_digest,
      closure_digest: runtime.closureDigest,
      receipt_digest: runtime.receiptDigest,
      process: {
        proxy_pid: process.pid,
        parent_pid: parentPid,
        child_pid: child.pid ?? null,
        server_pid: runtimeInstance.server_pid,
      },
      liveness: {
        state: classified.observed_state,
        stale_reasons: classified.stale_reasons,
        evidence: runtimeInstance.liveness_evidence,
      },
      runtime_freshness: runtimeFreshness,
      restart_action: runtimeFreshness.restart_action,
    };
  };
  recordStartup('preflight_ok', {
    proxy_entrypoint: runtimePath,
    child_entrypoint: runtime.entrypoint,
  });

  const livenessTimer = setInterval(() => {
    if (childClosed) return;
    const parentAlive = processIsAlive(parentPid);
    runtimeInstance = writeInstance(parentAlive ? 'live' : 'stale', {
      parent_pid_alive: parentAlive,
      carrier_stdin_open: !process.stdin.readableEnded,
    });
    if (!parentAlive) terminateProxyChild(child, false);
  }, options.livenessCheckMs);
  livenessTimer.unref();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    parentBuffer += chunk;
    const drained = drainTransportBuffer(parentBuffer);
    parentBuffer = drained.remaining;
    if (drained.messages.length > 0) parentFramed = drained.framed;
    for (const request of drained.messages) {
      const id = request.id;
      const params = isRecord(request.params) ? request.params : {};
      if (
        (typeof id === 'string' || typeof id === 'number')
        && tombstonedRequestIds.has(id)
      ) {
        writeJsonRpcMessage({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32004,
            message: 'mcp_runtime_proxy_request_id_quarantined',
            data: {
              schema: 'narada.mcp_runtime_proxy.error.v3',
              code: 'request_id_quarantined',
              reason: 'The request id timed out and is still quarantined against a late child response.',
              quarantine_ms: REQUEST_ID_TOMBSTONE_MS,
              surface_id: runtime.binding.surface_id,
            },
          },
        }, drained.framed);
        continue;
      }
      if (
        request.method === 'tools/call'
        && typeof params.name === 'string'
        && !admittedClientTools.has(params.name)
      ) {
        if (typeof id === 'string' || typeof id === 'number') {
          writeJsonRpcMessage({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: 'mcp_runtime_proxy_tool_not_exposed',
              data: {
                schema: 'narada.mcp_runtime_proxy.error.v3',
                code: 'tool_not_exposed',
                surface_id: runtime.binding.surface_id,
                tool_name: params.name,
              },
            },
          }, drained.framed);
        }
        continue;
      }
      if (
        request.method === 'tools/call'
        && typeof params.name === 'string'
        && isStandardSurfaceToolName(params.name)
        && (typeof id === 'string' || typeof id === 'number')
      ) {
        try {
          const result = standardSurfaceToolResult({
            descriptor: runtime.binding.descriptor,
            tool_name: params.name,
            arguments: isRecord(params.arguments) ? params.arguments : {},
            observed_capabilities: observedCapabilities,
            runtime_observation: currentRuntimeObservation(),
            client_tool_names: runtime.binding.client_tool_names,
          });
          writeJsonRpcMessage({ jsonrpc: '2.0', id, result }, drained.framed);
        } catch (error) {
          writeJsonRpcMessage({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            },
          }, drained.framed);
        }
        continue;
      }

      if (!child.stdin.destroyed) writeJsonRpcMessageToStream(child.stdin, request, false);
      if (request.method === 'initialize' || request.method === 'tools/list') {
        recordStartup('request_forwarded', { method: request.method, request_id: id ?? null });
      }
      if ((typeof id === 'string' || typeof id === 'number') && typeof request.method === 'string') {
        const requestedTransportTimeoutMs = extractRequestedTransportTimeoutMs(request);
        const effectiveTimeoutMs = effectiveRequestTimeoutMs(
          options.requestTimeoutMs,
          requestedTransportTimeoutMs,
          options.toolTimeoutGraceMs,
        );
        const timeout = setTimeout(() => {
          const requestState = pending.get(id);
          if (!requestState) return;
          pending.delete(id);
          quarantineRequestId(tombstonedRequestIds, id);
          writeJsonRpcMessage({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32001,
              message: 'mcp_runtime_proxy_child_request_timeout',
              data: {
                schema: 'narada.mcp_runtime_proxy.error.v3',
                code: 'child_request_timeout',
                method: requestState.method,
                tool_name: requestState.tool_name,
                effective_timeout_ms: requestState.effective_timeout_ms,
                surface_id: runtime.binding.surface_id,
                closure_digest: runtime.closureDigest,
              },
            },
          }, requestState.framed);
          sendCancellationToChild(child, requestState.id);
          terminateProxyChild(child, false);
        }, effectiveTimeoutMs);
        pending.set(id, {
          id,
          method: request.method,
          framed: drained.framed,
          timeout,
          started_at: new Date().toISOString(),
          tool_name: request.method === 'tools/call' && typeof params.name === 'string'
            ? params.name
            : null,
          effective_timeout_ms: effectiveTimeoutMs,
        });
      }
    }
  });

  process.stdin.on('end', () => {
    recordStartup('carrier_stdin_closed');
    if (!child.stdin.destroyed) child.stdin.end();
    terminateProxyChild(child, false);
  });

  child.stdout.on('data', (chunk) => {
    stdoutTail = tail(`${stdoutTail}${chunk}`, STDOUT_TAIL_LIMIT);
    childBuffer += chunk;
    const drained = drainTransportBuffer(childBuffer);
    childBuffer = drained.remaining;
    for (const response of drained.messages) {
      const id = response.id;
      let framed = parentFramed;
      let requestState: PendingRequest | undefined;
      if (typeof id === 'string' || typeof id === 'number') {
        requestState = pending.get(id);
        if (requestState) {
          framed = requestState.framed;
          clearTimeout(requestState.timeout);
          pending.delete(id);
        }
        if (!requestState && tombstonedRequestIds.has(id)) continue;
      }
      if (requestState?.method === 'initialize' && isRecord(response.result)) {
        observedCapabilities = isRecord(response.result.capabilities)
          ? response.result.capabilities
          : {};
      }
      if (requestState?.method === 'tools/list' && isRecord(response.result)) {
        const rawTools = Array.isArray(response.result.tools)
          ? response.result.tools.filter(isRecord) as McpToolDefinition[]
          : [];
        try {
          const exposedTools = clientVisibleToolDefinitions(runtime.binding, rawTools);
          response.result.tools = exposedTools;
          recordStartup('tools_list_conformant', {
            child_tool_count: rawTools.length,
            binding_tool_count: runtime.binding.client_tool_names.length,
            exposed_tool_count: exposedTools.length,
          });
        } catch (error) {
          delete response.result;
          response.error = {
            code: -32002,
            message: 'mcp_runtime_proxy_interface_mismatch',
            data: {
              schema: 'narada.mcp_runtime_proxy.error.v3',
              code: 'binding_artifact_incompatible',
              surface_id: runtime.binding.surface_id,
              detail: error instanceof Error ? error.message : String(error),
            },
          };
          terminateProxyChild(child, false);
        }
      }
      writeJsonRpcMessage(response, framed);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrTail = tail(`${stderrTail}${chunk}`, STDERR_TAIL_LIMIT);
    process.stderr.write(chunk);
  });

  child.on('error', (error) => {
    stderrTail = tail(`${stderrTail}${error.message}\n`, STDERR_TAIL_LIMIT);
    recordStartup('child_error', { message: error.message });
    flushPendingErrors(pending, runtime, {
      code: 'child_spawn_error',
      message: error.message,
      stderr_tail: stderrTail,
      stdout_tail: stdoutTail,
    });
  });

  child.on('close', (code, signal) => {
    childClosed = true;
    clearInterval(livenessTimer);
    runtimeInstance = writeInstance('closed', {
      reason: 'child_closed',
      exit_code: code,
      signal,
      parent_pid_alive: processIsAlive(parentPid),
    }, new Date().toISOString());
    recordStartup('child_closed', { exit_code: code, signal });
    if (pending.size > 0) {
      flushPendingErrors(pending, runtime, {
        code: 'child_exited_before_response',
        message: `child_exited_before_response:${code ?? signal ?? 'unknown'}`,
        stderr_tail: stderrTail,
        stdout_tail: stdoutTail,
      });
    }
    process.stdin.pause();
    process.exitCode = typeof code === 'number' ? code : 1;
  });

  await new Promise<void>((resolveDone) => child.once('close', () => resolveDone()));
  clearRequestIdTombstones(tombstonedRequestIds);
  await releaseArtifactLeases(artifactLeases);
  void runtimeInstance;
  await flushProxyStdout();
}

async function releaseArtifactLeases(leases: ArtifactLeaseHandle[]): Promise<void> {
  let firstError: unknown;
  for (const lease of [...leases].reverse()) {
    try {
      await lease.release();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function writePreflightRefusal(error: CarrierGenerationError): Promise<void> {
  process.stderr.write(`mcp_runtime_proxy_preflight_refused:${error.code}:${error.message}\n`);
  await new Promise<void>((resolveDone) => {
    let buffer = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      process.stdin.off('data', onData);
      process.stdin.off('end', finish);
      process.stdin.pause();
      resolveDone();
    };
    const onData = (chunk: string) => {
      buffer += chunk;
      const drained = drainTransportBuffer(buffer);
      buffer = drained.remaining;
      for (const request of drained.messages) {
        if (typeof request.id !== 'string' && typeof request.id !== 'number') continue;
        writeJsonRpcMessage({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: `mcp_runtime_proxy_preflight_refused:${error.code}`,
            data: {
              ...error.toJSON(),
              method: request.method ?? null,
            },
          },
        }, drained.framed);
        finish();
        break;
      }
    };
    const timeout = setTimeout(finish, 5_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', finish);
    process.stdin.resume();
  });
  await flushProxyStdout();
}

function flushPendingErrors(
  pending: Map<string | number, PendingRequest>,
  runtime: ResolvedRuntime,
  diagnostic: JsonRecord & { code: string; message: string },
): void {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    writeJsonRpcMessage({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32003,
        message: diagnostic.message,
        data: {
          ...diagnostic,
          schema: 'narada.mcp_runtime_proxy.error.v3',
          code: diagnostic.code,
          method: request.method,
          tool_name: request.tool_name,
          started_at: request.started_at,
          surface_id: runtime.binding.surface_id,
          closure_digest: runtime.closureDigest,
        },
      },
    }, request.framed);
  }
  pending.clear();
}

function quarantineRequestId(
  tombstones: Map<string | number, NodeJS.Timeout>,
  id: string | number,
): void {
  const prior = tombstones.get(id);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => tombstones.delete(id), REQUEST_ID_TOMBSTONE_MS);
  timer.unref();
  tombstones.set(id, timer);
}

function clearRequestIdTombstones(
  tombstones: Map<string | number, NodeJS.Timeout>,
): void {
  for (const timer of tombstones.values()) clearTimeout(timer);
  tombstones.clear();
}

function spawnProxyChild(
  runtime: ResolvedRuntime,
  options: ProxyOptions,
  supervisorPath: string | null,
): ChildLaunch {
  const spawnOptions: import('node:child_process').SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvironment(runtime, options),
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  };
  if (process.platform === 'win32' && supervisorPath) {
    const supervisorIdentityPath = join(options.diagnosticsDir, `supervisor-${process.pid}.json`);
    return {
      child: spawn(supervisorPath, [
        '--identity-path',
        supervisorIdentityPath,
        '--parent-pid',
        String(process.pid),
        '--',
        process.execPath,
        runtime.entrypoint,
        ...runtime.childArgs,
      ], spawnOptions) as ChildProcessWithoutNullStreams,
      supervisorPath,
      supervisorIdentityPath,
    };
  }
  return {
    child: spawn(
      process.execPath,
      [runtime.entrypoint, ...runtime.childArgs],
      spawnOptions,
    ) as ChildProcessWithoutNullStreams,
    supervisorPath: null,
    supervisorIdentityPath: null,
  };
}

function childEnvironment(runtime: ResolvedRuntime, options: ProxyOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const baselineNames = process.platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
  for (const name of new Set([...baselineNames, ...runtime.binding.child_env_names])) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.NARADA_MCP_WORKSPACE_ROOT = runtime.binding.source.workspace_root;
  environment.NARADA_MCP_SURFACES_ROOT = join(runtime.binding.source.workspace_root, 'packages');
  environment.NARADA_MCP_ARTIFACT_STORE = options.artifactStore;
  environment.NARADA_MCP_CARRIER_GENERATION = options.carrierGenerationPath;
  environment.NARADA_MCP_SERVER_KEY = runtime.binding.server_key;
  return environment;
}

function terminateProxyChild(child: ChildProcessWithoutNullStreams, force: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } else {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Process already exited.
    }
  }
  if (!force) {
    const timer = setTimeout(() => terminateProxyChild(child, true), 5_000);
    timer.unref();
  }
}

function sendCancellationToChild(child: ChildProcessWithoutNullStreams, id: string | number): void {
  if (child.stdin.destroyed) return;
  writeJsonRpcMessageToStream(child.stdin, {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: id, reason: 'request timed out in sealed MCP runtime proxy' },
  }, false);
}

function readSupervisorIdentity(path: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractRequestedTransportTimeoutMs(request: JsonRecord): number | null {
  if (!isRecord(request.params) || !isRecord(request.params._meta)) return null;
  const value = request.params._meta['narada.transport_timeout_ms'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function startsWithJsonRpcFrame(buffer: string): boolean {
  return /^\s*Content-Length:\s*\d+\r?\n/iu.test(buffer);
}

function parseJsonLine(line: string): JsonRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function drainJsonLines(buffer: string): {
  framed: false;
  remaining: string;
  messages: JsonRecord[];
} {
  const lines = buffer.split(/\r?\n/u);
  const remaining = lines.pop() ?? '';
  return {
    framed: false,
    remaining,
    messages: lines.flatMap((line) => {
      if (!line.trim()) return [];
      const parsed = parseJsonLine(line);
      return parsed ? [parsed] : [];
    }),
  };
}

function drainJsonRpcFrames(buffer: string): {
  framed: true;
  remaining: string;
  messages: JsonRecord[];
} {
  let remaining = buffer;
  const messages: JsonRecord[] = [];
  for (;;) {
    const headerEnd = remaining.search(/\r?\n\r?\n/u);
    if (headerEnd < 0) break;
    const separator = remaining.slice(headerEnd).startsWith('\r\n\r\n') ? 4 : 2;
    const header = remaining.slice(0, headerEnd);
    const lengthMatch = /(?:^|\r?\n)Content-Length:\s*(\d+)\s*(?:\r?\n|$)/iu.exec(header);
    if (!lengthMatch) break;
    const length = Number.parseInt(lengthMatch[1]!, 10);
    const bodyStart = headerEnd + separator;
    if (Buffer.byteLength(remaining.slice(bodyStart), 'utf8') < length) break;
    let bodyEnd = bodyStart;
    while (bodyEnd <= remaining.length && Buffer.byteLength(remaining.slice(bodyStart, bodyEnd), 'utf8') < length) {
      bodyEnd += 1;
    }
    const body = remaining.slice(bodyStart, bodyEnd);
    const parsed = parseJsonLine(body);
    if (parsed) messages.push(parsed);
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, messages };
}

function drainTransportBuffer(buffer: string): {
  framed: boolean;
  remaining: string;
  messages: JsonRecord[];
} {
  return startsWithJsonRpcFrame(buffer) ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer);
}

function writeJsonRpcMessage(message: JsonRecord, framed: boolean): void {
  writeJsonRpcMessageToStream(process.stdout, message, framed);
}

function writeJsonRpcMessageToStream(
  stream: NodeJS.WritableStream,
  message: JsonRecord,
  framed: boolean,
): void {
  const body = JSON.stringify(message);
  stream.write(framed ? `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}` : `${body}\n`);
}

async function flushProxyStdout(): Promise<void> {
  await new Promise<void>((resolveDone) => {
    process.stdout.write('', () => resolveDone());
  });
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 80) || basename(value);
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

if (process.argv[1] && pathEqual(process.argv[1], fileURLToPath(import.meta.url))) {
  runProxy().catch(async (error: unknown) => {
    const refusal = error instanceof CarrierGenerationError
      ? error
      : new CarrierGenerationError(
          'runtime_internal_error',
          error instanceof Error ? error.message : String(error),
        );
    await writePreflightRefusal(refusal).catch(() => undefined);
    process.exitCode = 1;
  });
}
