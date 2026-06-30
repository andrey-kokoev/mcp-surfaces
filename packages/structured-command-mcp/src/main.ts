#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildAllowedRoots,
  createExecutionPolicy,
  decideStructuredCommandExecution,
  publicExecutionPolicy,
} from './policy.js';

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_RESULT_CHAR_LIMIT = 4000;
const STREAM_PREVIEW_CHAR_LIMIT = 1000;
const TOOL_OUTPUT_SHOW_MAX_LIMIT = 20000;
const TOOL_INPUT_CHAR_LIMIT = 20000;
const REF_PATTERN = /^structured_command_(input|execution):([A-Za-z0-9_-]{8,80})$/;
const ROOTS_LIST_REQUEST_PREFIX = 'structured_command_roots_';

type StructuredCommandState = Record<string, unknown> & {
  policy: ReturnType<typeof createExecutionPolicy>;
  auditLogDir: string | null;
  storageRoot: string;
  env: NodeJS.ProcessEnv;
  clientRoots: {
    supported: boolean;
    roots: Array<{ uri: string; name?: string }>;
    lastUpdatedAt: string | null;
  };
};

type SpawnStructuredOptions = {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
};

type SpawnStructuredResult = {
  exit_code: number | null;
  timed_out: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
};

type RequestContext = {
  abortSignal?: AbortSignal;
  progress?: (progress: number, message: string) => void;
};

class StructuredCommandError extends Error {
  codeName: string;
  details: unknown;

  constructor(codeName: string, message: string, details: unknown = {}) {
    super(message);
    this.name = 'StructuredCommandError';
    this.codeName = codeName;
    this.details = details;
  }
}

if (isMainModule()) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export async function runStdioServer(options: Record<string, unknown>) {
  const state = createServerState(options);
  const activeRequests = new Map<string, AbortController>();
  const pendingServerRequests = new Map<string, (message: Record<string, unknown>) => void>();
  let nextServerRequestId = 1;
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let requests = [];
    if (buffer.includes('Content-Length:')) {
      sawFramedInput = true;
      const drained = drainJsonRpcFrames(buffer);
      buffer = drained.remaining;
      requests = drained.requests;
    } else {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      requests = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
    }
    for (const request of requests) {
      const record = asRecord(request);
      if (record.method === undefined && record.id !== undefined) {
        const handler = pendingServerRequests.get(String(record.id));
        if (handler) {
          pendingServerRequests.delete(String(record.id));
          handler(record);
        }
        continue;
      }
      if (!record.id && record.method === 'notifications/roots/list_changed' && state.clientRoots.supported) {
        requestClientRoots(state, pendingServerRequests, () => `${ROOTS_LIST_REQUEST_PREFIX}${nextServerRequestId++}`, { framed: sawFramedInput });
        continue;
      }
      if (record.method === 'initialize') {
        const response = await handleRequest(record, state);
        if (response) writeJsonRpcMessage(response, { framed: sawFramedInput });
        if (clientSupportsRoots(asRecord(record.params))) {
          state.clientRoots.supported = true;
          requestClientRoots(state, pendingServerRequests, () => `${ROOTS_LIST_REQUEST_PREFIX}${nextServerRequestId++}`, { framed: sawFramedInput });
        }
        continue;
      }
      processStdioRequest(record, state, activeRequests, { framed: sawFramedInput });
    }
  }
}

export function createServerState(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): StructuredCommandState {
  const siteRoot = resolve(String(options.siteRoot ?? options.storageRoot ?? firstOption(options.allowedRoot) ?? firstOption(options.allowedRoots) ?? process.cwd()));
  const stateEnv = { ...env };
  loadSiteSecrets(siteRoot, stateEnv);
  const siteExtraRoots = loadSiteExtraAllowedRoots(siteRoot);
  const allowedRoots = buildAllowedRoots({
    trustConfigPaths: optionList(options.rootsFromTrustConfig),
    explicitRoots: [...siteExtraRoots, ...optionList(options.allowedRoot), ...optionList(options.allowedRoots)],
  });
  if (allowedRoots.length === 0) throw new Error('structured_command_requires_allowed_root');
  return {
    policy: createExecutionPolicy({
      allowedRoots,
      allowedCommands: optionList(options.allowCommand ?? options.allowedCommands),
      allowedPrefixes: optionList(options.allowPrefix ?? options.allowedPrefixes),
      blockedCommands: optionList(options.blockCommand ?? options.blockedCommands),
      maxTimeoutMs: options.maxTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    }),
    auditLogDir: options.auditLogDir ? resolve(String(options.auditLogDir)) : null,
    storageRoot: resolve(String(options.storageRoot ?? allowedRoots[0])),
    env: stateEnv,
    clientRoots: { supported: false, roots: [], lastUpdatedAt: null },
  };
}

async function processStdioRequest(request: Record<string, unknown>, state: StructuredCommandState, activeRequests: Map<string, AbortController>, options: { framed: boolean }) {
  if (!request?.id && request.method === 'notifications/cancelled') {
    const requestId = String(asRecord(request.params).requestId ?? '');
    activeRequests.get(requestId)?.abort();
    return;
  }
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return;
  const requestId = String(request.id ?? '');
  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);
  const progressToken = asRecord(asRecord(request.params)._meta).progressToken;
  const progress = (progressValue: number, message: string) => {
    if (progressToken === undefined) return;
    writeJsonRpcMessage({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken, progress: progressValue, total: 1, message },
    }, options);
  };
  progress(0, 'started');
  handleRequest(request, state, { abortSignal: abortController.signal, progress }).then((response) => {
    progress(abortController.signal.aborted ? 1 : 1, abortController.signal.aborted ? 'cancelled' : 'completed');
    if (response) writeJsonRpcMessage(response, options);
  }).finally(() => {
    activeRequests.delete(requestId);
  });
}

export async function handleRequest(request: Record<string, unknown>, state: StructuredCommandState, context: RequestContext = {}) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state, context);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return {
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: {
        code: -32000,
        message: diagnostic.message,
        data: diagnostic,
      },
    };
  }
}

async function dispatchMethod(method: string, params: Record<string, unknown>, state: StructuredCommandState, context: RequestContext = {}): Promise<unknown> {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {}, completions: {}, logging: {} },
      serverInfo: { name: 'structured-command-mcp', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') return { tools: listTools() };
  if (method === 'tools/call') return callTool(params, state, context);
  if (method === 'resources/list') return listStructuredCommandResources(state);
  if (method === 'resources/read') return readStructuredCommandResource(params, state);
  if (method === 'prompts/list') return { prompts: listPrompts() };
  if (method === 'prompts/get') return promptGet(params);
  if (method === 'completion/complete') return completeArgument(params, state);
  if (method === 'logging/setLevel') return {};
  throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`, { method });
}

function listPrompts() {
  return [{ name: 'structured_command_safe_execution', title: 'Structured Command Safe Execution', description: 'Guidance for argv-only command execution.', arguments: [] }];
}

function promptGet(params: Record<string, unknown>) {
  const name = String(params.name ?? '');
  if (name !== 'structured_command_safe_execution') throw diagnosticError('unknown_prompt', `unknown_prompt:${name}`, { name });
  return {
    description: 'Guidance for argv-only command execution.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Use structured_command_execute with explicit argv arrays only. Inspect policy before relying on command availability, and use output refs for long results.' } }],
  };
}

function completeArgument(params: Record<string, unknown>, state: StructuredCommandState) {
  const argumentName = String(asRecord(asRecord(params).argument).name ?? '');
  const values = argumentName === 'name'
    ? listTools().map((tool) => tool.name).filter(Boolean).slice(0, 100)
    : ['working_directory', 'cwd', 'directory'].includes(argumentName) ? clientRootCompletionValues(state) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

export function listTools() {
  return decorateTools([
    {
      name: 'structured_command_execution_policy_inspect',
      description: 'Inspect the policy governing structured command execution.',
      inputSchema: objectSchema({}),
    },
    {
      name: 'structured_command_execute',
      description: 'Execute a structured argv command under allowed-root and command policy.',
      inputSchema: objectSchema({
        input_ref: { type: 'string', description: 'Structured command input ref from structured_command_input_create.' },
        execution_ref: { type: 'string', description: 'Prior execution ref returned by structured_command_execute; use to read later stdout/stderr pages without re-running.' },
        command: { type: 'string', description: 'Executable name or absolute executable path admitted by policy.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument vector. No shell parsing is performed.' },
        working_directory: { type: 'string', description: 'Working directory under an allowed root.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds.' },
        test_scope: { type: 'string', enum: ['focused', 'broad', 'known_slow', 'unknown'], description: 'Optional caller-declared verification scope/cost posture for test commands.' },
        expected_cost: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'], description: 'Optional caller-declared expected cost for this command.' },
        stdout_offset: { type: 'integer', description: 'Character offset for stdout page. Defaults 0.' },
        stderr_offset: { type: 'integer', description: 'Character offset for stderr page. Defaults 0.' },
        stdout_limit: { type: 'integer', description: `Stdout page size. Default ${STREAM_PREVIEW_CHAR_LIMIT}, max ${TOOL_OUTPUT_SHOW_MAX_LIMIT}.` },
        stderr_limit: { type: 'integer', description: `Stderr page size. Default ${STREAM_PREVIEW_CHAR_LIMIT}, max ${TOOL_OUTPUT_SHOW_MAX_LIMIT}.` },
      }),
    },
    {
      name: 'structured_command_powershell_parse_check',
      description: 'Parse-check one allowed-root PowerShell script without admitting arbitrary pwsh command execution.',
      inputSchema: objectSchema({
        path: { type: 'string', description: 'PowerShell script path under an allowed root.' },
        working_directory: { type: 'string', description: 'Optional working directory under an allowed root. Defaults to the script directory.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds.' },
      }, ['path']),
    },
    {
      name: 'structured_command_input_create',
      description: 'Create a scoped structured command input ref.',
      inputSchema: objectSchema({
        input_id: { type: 'string', description: 'Optional caller-chosen id, max 80 chars.' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        working_directory: { type: 'string' },
        timeout_ms: { type: 'integer' },
        test_scope: { type: 'string', enum: ['focused', 'broad', 'known_slow', 'unknown'] },
        expected_cost: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
      }, ['command']),
    },
    {
      name: 'structured_command_elevated_window_execute',
      description: 'On Windows, launch a policy-approved command in a visible elevated UAC window. Output is not captured from the elevated process.',
      inputSchema: objectSchema({
        command: { type: 'string', description: 'Executable name or absolute executable path admitted by policy.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument vector for the elevated process.' },
        working_directory: { type: 'string', description: 'Working directory under an allowed root.' },
        confirm_elevation: { type: 'boolean', description: 'Must be true to show a UAC/elevated execution prompt.' },
        wait: { type: 'boolean', description: 'When true, the broker waits for the elevated process to exit. Defaults false.' },
        dry_run: { type: 'boolean', description: 'When true, return the planned broker command without invoking UAC.' },
      }, ['command', 'working_directory']),
    },
  ]);
}

async function callTool(params: Record<string, unknown>, state: StructuredCommandState, context: RequestContext = {}) {
  const name = params?.name;
  const args = asRecord(params.arguments);
  if (name === 'structured_command_guidance') return toolResult(buildGuidanceResult(args), state);
  enforceInputCharLimit(args);
  if (name === 'structured_command_execution_policy_inspect') return toolResult(publicExecutionPolicy(state.policy), state);
  if (name === 'structured_command_execute') return toolResult(await executeStructuredCommand(args, state, context), state);
  if (name === 'structured_command_powershell_parse_check') return toolResult(await powershellParseCheck(args, state, context), state);
  if (name === 'structured_command_input_create') return toolResult(createStructuredCommandInput(args, state), state);
  if (name === 'structured_command_elevated_window_execute') return toolResult(await executeStructuredCommandElevatedWindow(args, state), state);
  throw diagnosticError('structured_command_unknown_tool', `structured_command_unknown_tool:${name}`, { tool_name: name ?? null });
}

export async function executeStructuredCommand(args: unknown, state: StructuredCommandState, context: RequestContext = {}): Promise<unknown> {
  const argsRecord = asRecord(args);
  enforceInputCharLimit(argsRecord);
  if (argsRecord.execution_ref) {
    const execution = readStructuredCommandExecution(String(argsRecord.execution_ref), state);
    return buildPagedExecutionResult(execution.result, argsRecord, String(argsRecord.execution_ref));
  }
  const effectiveArgs = argsRecord.input_ref ? asRecord(readStructuredCommandInput(String(argsRecord.input_ref), state).input) : argsRecord;
  const timeoutMs = Math.min(state.policy.maxTimeoutMs, Math.max(1, Number(effectiveArgs.timeout_ms ?? 60_000)));
  const workingDirectory = effectiveArgs.working_directory ? resolve(String(effectiveArgs.working_directory)) : state.policy.allowedRoots[0];
  const executionPosture = structuredCommandExecutionPosture(effectiveArgs);
  const decision = decideStructuredCommandExecution({
    command: effectiveArgs.command,
    args: Array.isArray(effectiveArgs.args) ? effectiveArgs.args : [],
    workingDirectory,
  }, state.policy);
  if (decision.status !== 'allowed') {
    return {
      schema: 'narada.structured_command.execution_result.v0',
      status: 'refused',
      decision,
      refusal_reasons: decision.reasons,
      remediation_hints: decision.remediation_hints,
      mcp_fallbacks: decision.mcp_fallbacks,
      command: decision.command,
      args: decision.args,
    working_directory: decision.working_directory,
    execution_posture: executionPosture,
    test_scope: executionPosture.test_scope,
    expected_cost: executionPosture.expected_cost,
    executed: false,
    };
  }

  const startedAt = new Date().toISOString();
  context.progress?.(0.1, 'executing');
  const result = await spawnStructured(decision.command, decision.args, {
    cwd: decision.working_directory,
    timeoutMs,
    maxOutputBytes: state.policy.maxOutputBytes,
    env: state.env,
    abortSignal: context.abortSignal,
  });
  const finishedAt = new Date().toISOString();
  const payload = {
    schema: 'narada.structured_command.execution_result.v0',
    status: result.cancelled ? 'cancelled' : result.timed_out ? 'timed_out' : result.exit_code === 0 ? 'ok' : 'failed',
    executed: true,
    command: decision.command,
    args: decision.args,
    working_directory: decision.working_directory,
    started_at: startedAt,
    finished_at: finishedAt,
    timeout_ms: timeoutMs,
    execution_posture: executionPosture,
    test_scope: executionPosture.test_scope,
    expected_cost: executionPosture.expected_cost,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    timed_out: result.timed_out,
    cancelled: result.cancelled,
    input_ref: argsRecord.input_ref ?? null,
  };
  audit(state, payload);
  const executionRef = createStructuredCommandExecution(payload, state);
  return buildPagedExecutionResult(payload, argsRecord, executionRef);
}

export function createStructuredCommandInput(args, state) {
  const inputId = normalizeRefId(args.input_id ?? `i_${randomUUID().replace(/-/g, '').slice(0, 24)}`);
  const input = {
    command: String(args.command ?? ''),
    args: Array.isArray(args.args) ? args.args.map(String) : [],
    ...(args.working_directory ? { working_directory: String(args.working_directory) } : {}),
    ...(args.timeout_ms ? { timeout_ms: Number(args.timeout_ms) } : {}),
    ...structuredCommandInputPosture(args),
  };
  const record = {
    schema: 'narada.structured_command.input.v0',
    ref: `structured_command_input:${inputId}`,
    created_at: new Date().toISOString(),
    sha256: sha256Json(input),
    input,
  };
  writeJsonRecord(inputPath(state, inputId), record);
  return {
    schema: 'narada.structured_command.input_create_result.v0',
    status: 'created',
    input_ref: record.ref,
    sha256: record.sha256,
  };
}

async function powershellParseCheck(args: Record<string, unknown>, state: StructuredCommandState, context: RequestContext = {}): Promise<unknown> {
  const scriptPath = resolve(String(args.path ?? ''));
  if (!scriptPath || !scriptPath.toLowerCase().endsWith('.ps1')) {
    throw diagnosticError('structured_command_powershell_parse_check_requires_ps1', 'structured_command_powershell_parse_check_requires_ps1', { path: String(args.path ?? '') });
  }
  if (!isInsideAnyRoot(scriptPath, state.policy.allowedRoots)) {
    throw diagnosticError('structured_command_powershell_parse_check_path_outside_allowed_roots', 'structured_command_powershell_parse_check_path_outside_allowed_roots', { path: scriptPath, allowed_roots: state.policy.allowedRoots });
  }
  if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
    throw diagnosticError('structured_command_powershell_parse_check_file_not_found', 'structured_command_powershell_parse_check_file_not_found', { path: scriptPath });
  }
  const workingDirectory = args.working_directory ? resolve(String(args.working_directory)) : dirname(scriptPath);
  if (!isInsideAnyRoot(workingDirectory, state.policy.allowedRoots)) {
    throw diagnosticError('structured_command_powershell_parse_check_cwd_outside_allowed_roots', 'structured_command_powershell_parse_check_cwd_outside_allowed_roots', { working_directory: workingDirectory, allowed_roots: state.policy.allowedRoots });
  }
  const timeoutMs = Math.min(state.policy.maxTimeoutMs, Math.max(1, Number(args.timeout_ms ?? 30_000)));
  const parseScript = [
    '$ErrorActionPreference = "Stop"',
    '$tokens = $null',
    '$errors = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile(${psSingleQuote(scriptPath)}, [ref]$tokens, [ref]$errors) > $null`,
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error ($_.ToString()) }; exit 1 }',
    'Write-Output "parse_ok"',
  ].join('; ');
  const result = await spawnStructured('pwsh', ['-NoProfile', '-Command', parseScript], {
    cwd: workingDirectory,
    timeoutMs,
    maxOutputBytes: state.policy.maxOutputBytes,
    env: state.env,
    abortSignal: context.abortSignal,
  });
  const payload = {
    schema: 'narada.structured_command.powershell_parse_check.v0',
    status: result.cancelled ? 'cancelled' : result.timed_out ? 'timed_out' : result.exit_code === 0 ? 'ok' : 'failed',
    path: scriptPath,
    working_directory: workingDirectory,
    timeout_ms: timeoutMs,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    timed_out: result.timed_out,
    cancelled: result.cancelled,
    arbitrary_command_execution_admitted: false,
    parser_api: 'System.Management.Automation.Language.Parser.ParseFile',
  };
  audit(state, payload);
  return payload;
}

function spawnStructured(command: string, args: string[], { cwd, timeoutMs, maxOutputBytes, env, abortSignal }: SpawnStructuredOptions): Promise<SpawnStructuredResult> {
  return new Promise((resolvePromise) => {
    if (abortSignal?.aborted) {
      resolvePromise({
        exit_code: null,
        stdout: '',
        stderr: '',
        stdout_truncated: false,
        stderr_truncated: false,
        timed_out: false,
        cancelled: true,
      });
      return;
    }
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const abortHandler = () => {
      cancelled = true;
      child.kill();
    };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });
    child.stdout.on('data', (chunk) => {
      const next = stdout + chunk.toString();
      stdoutTruncated ||= Buffer.byteLength(next, 'utf8') > maxOutputBytes;
      stdout = truncateUtf8(next, maxOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      const next = stderr + chunk.toString();
      stderrTruncated ||= Buffer.byteLength(next, 'utf8') > maxOutputBytes;
      stderr = truncateUtf8(next, maxOutputBytes);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', abortHandler);
      resolvePromise({
        exit_code: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        timed_out: timedOut,
        cancelled,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', abortHandler);
      resolvePromise({
        exit_code: code,
        stdout,
        stderr,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        timed_out: timedOut,
        cancelled,
      });
    });
  });
}

export async function executeStructuredCommandElevatedWindow(args, state) {
  if (process.platform !== 'win32') {
    return {
      schema: 'narada.structured_command.elevated_window_result.v0',
      status: 'refused',
      executed: false,
      refusal_reasons: ['windows_only'],
    };
  }
  const argsRecord = asRecord(args);
  enforceInputCharLimit(argsRecord);
  const workingDirectory = resolve(String(argsRecord.working_directory ?? state.policy.allowedRoots[0]));
  const commandArgs = Array.isArray(argsRecord.args) ? argsRecord.args.map(String) : [];
  const decision = decideStructuredCommandExecution({
    command: argsRecord.command,
    args: commandArgs,
    workingDirectory,
  }, state.policy);
  if (decision.status !== 'allowed') {
    return {
      schema: 'narada.structured_command.elevated_window_result.v0',
      status: 'refused',
      executed: false,
      decision,
      refusal_reasons: decision.reasons,
      command: decision.command,
      args: decision.args,
      working_directory: decision.working_directory,
    };
  }
  const dryRun = argsRecord.dry_run === true;
  if (!dryRun && argsRecord.confirm_elevation !== true) {
    return {
      schema: 'narada.structured_command.elevated_window_result.v0',
      status: 'refused',
      executed: false,
      decision,
      refusal_reasons: ['confirm_elevation_required'],
      command: decision.command,
      args: decision.args,
      working_directory: decision.working_directory,
    };
  }
  const wait = argsRecord.wait === true;
  const broker = buildElevatedWindowBrokerCommand({ command: decision.command, args: decision.args, workingDirectory: decision.working_directory, wait });
  if (dryRun) {
    return {
      schema: 'narada.structured_command.elevated_window_result.v0',
      status: 'planned',
      executed: false,
      decision,
      broker,
      command: decision.command,
      args: decision.args,
      working_directory: decision.working_directory,
      wait,
    };
  }
  const startedAt = new Date().toISOString();
  const result = await spawnStructured(broker.command, broker.args, {
    cwd: decision.working_directory,
    timeoutMs: 60_000,
    maxOutputBytes: state.policy.maxOutputBytes,
    env: state.env,
  });
  const payload = {
    schema: 'narada.structured_command.elevated_window_result.v0',
    status: result.exit_code === 0 ? 'uac_prompt_completed' : 'broker_failed',
    executed: result.exit_code === 0,
    decision,
    broker_exit_code: result.exit_code,
    broker_stdout: result.stdout,
    broker_stderr: result.stderr,
    command: decision.command,
    args: decision.args,
    working_directory: decision.working_directory,
    wait,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    note: 'The elevated process runs in a separate Windows UAC context; its stdout/stderr are not captured by this MCP call.',
  };
  audit(state, payload);
  const executionRef = createStructuredCommandExecution(payload, state);
  return buildPagedExecutionResult(payload, argsRecord, executionRef);
}

function buildPagedExecutionResult(payload, args, executionRef) {
  if (payload.executed === false) return { ...payload, execution_ref: executionRef ?? null };
  const stdoutPage = pageText(String(payload.stdout ?? ''), args.stdout_offset, args.stdout_limit, STREAM_PREVIEW_CHAR_LIMIT);
  const stderrPage = pageText(String(payload.stderr ?? ''), args.stderr_offset, args.stderr_limit, STREAM_PREVIEW_CHAR_LIMIT);
  return {
    ...payload,
    execution_ref: executionRef,
    stdout: stdoutPage.text,
    stderr: stderrPage.text,
    stdout_offset: stdoutPage.offset,
    stderr_offset: stderrPage.offset,
    stdout_limit: stdoutPage.limit,
    stderr_limit: stderrPage.limit,
    stdout_next_offset: stdoutPage.next_offset,
    stderr_next_offset: stderrPage.next_offset,
    stdout_output_truncated: stdoutPage.output_truncated,
    stderr_output_truncated: stderrPage.output_truncated,
    stdout_char_length: stdoutPage.full_output_char_length,
    stderr_char_length: stderrPage.full_output_char_length,
    page_source: args.execution_ref ? 'persisted_execution' : 'new_execution',
  };
}

function pageText(text, offsetValue, limitValue, defaultLimit) {
  const offset = Math.max(0, Number(offsetValue ?? 0));
  const limit = clampInteger(limitValue, 1, TOOL_OUTPUT_SHOW_MAX_LIMIT, defaultLimit);
  const chunk = text.slice(offset, offset + limit);
  const nextOffset = offset + chunk.length < text.length ? offset + chunk.length : null;
  return {
    text: chunk,
    offset,
    limit,
    next_offset: nextOffset,
    output_truncated: nextOffset !== null,
    full_output_char_length: text.length,
  };
}

export function buildElevatedWindowBrokerCommand({ command, args, workingDirectory, wait }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath ${psSingleQuote(command)} -ArgumentList ${psArrayLiteral(args)} -WorkingDirectory ${psSingleQuote(workingDirectory)} -Verb RunAs -WindowStyle Normal -PassThru`,
    wait ? 'if ($p) { $p.WaitForExit(); exit $p.ExitCode }' : 'if ($p) { Write-Output ("started_pid=" + $p.Id) }',
  ].join('; ');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    script,
  };
}

function toolResult(payload, state) {
  const text = renderToolResultText(payload);
  const truncated = text.length > TOOL_RESULT_CHAR_LIMIT;
  const rendered = truncated ? text.slice(0, TOOL_RESULT_CHAR_LIMIT) : text;
  return {
    content: [assistantTextContent(rendered)],
    structuredContent: buildStructuredContent(payload, {
      truncated,
      renderedTextLength: rendered.length,
      fullTextLength: text.length,
      state,
    }),
  };
}

function assistantTextContent(text) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

function buildStructuredContent(payload, { truncated, renderedTextLength, fullTextLength, state }) {
  if (payload?.schema === 'narada.structured_command.execution_result.v0') {
    return buildExecutionStructuredContent(payload, { truncated, renderedTextLength, fullTextLength, state });
  }
  if (payload?.schema === 'narada.structured_command.execution_policy.v0') {
    return {
      ...payload,
      truncated,
      rendered_text_char_length: renderedTextLength,
      full_output_char_length: fullTextLength,
    };
  }
  if (payload?.schema === 'narada.structured_command.input_create_result.v0') {
    return {
      ...payload,
      truncated,
      rendered_text_char_length: renderedTextLength,
      full_output_char_length: fullTextLength,
    };
  }
  if (payload?.schema === 'narada.structured_command.elevated_window_result.v0') {
    return {
      ...payload,
      truncated,
      rendered_text_char_length: renderedTextLength,
      full_output_char_length: fullTextLength,
    };
  }
  if (payload?.schema === 'narada.structured_command.powershell_parse_check.v0') {
    return {
      ...payload,
      truncated,
      rendered_text_char_length: renderedTextLength,
      full_output_char_length: fullTextLength,
    };
  }
  return {
    schema: payload?.schema,
    status: payload?.status,
    truncated,
    ...(payload?.input_ref ? { input_ref: payload.input_ref } : {}),
    ...(payload?.sha256 ? { sha256: payload.sha256 } : {}),
    rendered_text_char_length: renderedTextLength,
    full_output_char_length: fullTextLength,
  };
}

function buildExecutionStructuredContent(payload, { truncated, renderedTextLength, fullTextLength, state: _state }) {
  if (payload.executed === false) {
    return {
      schema: payload.schema,
      status: payload.status,
      executed: false,
      command: payload.command,
      args: payload.args,
      working_directory: payload.working_directory,
      execution_posture: payload.execution_posture ?? null,
      test_scope: payload.test_scope ?? null,
      expected_cost: payload.expected_cost ?? null,
      refusal_reasons: payload.refusal_reasons ?? payload.decision?.reasons ?? [],
      remediation_hints: payload.remediation_hints ?? payload.decision?.remediation_hints ?? [],
      mcp_fallbacks: payload.mcp_fallbacks ?? payload.decision?.mcp_fallbacks ?? [],
      decision: payload.decision ?? null,
      execution_ref: payload.execution_ref ?? null,
      truncated,
      rendered_text_char_length: renderedTextLength,
      full_output_char_length: fullTextLength,
    };
  }
  const stdout = String(payload.stdout ?? '');
  const stderr = String(payload.stderr ?? '');
  return {
    schema: payload.schema,
    status: payload.status,
    executed: payload.executed,
    command: payload.command,
    args: payload.args,
    working_directory: payload.working_directory,
    timeout_ms: payload.timeout_ms,
    execution_posture: payload.execution_posture ?? null,
    test_scope: payload.test_scope ?? null,
    expected_cost: payload.expected_cost ?? null,
    exit_code: payload.exit_code,
    timed_out: payload.timed_out,
    cancelled: payload.cancelled,
    execution_ref: payload.execution_ref,
    page_source: payload.page_source,
    stdout,
    stderr,
    stdout_truncated: payload.stdout_truncated,
    stderr_truncated: payload.stderr_truncated,
    stdout_char_length: payload.stdout_char_length ?? stdout.length,
    stderr_char_length: payload.stderr_char_length ?? stderr.length,
    stdout_offset: payload.stdout_offset ?? 0,
    stderr_offset: payload.stderr_offset ?? 0,
    stdout_limit: payload.stdout_limit ?? STREAM_PREVIEW_CHAR_LIMIT,
    stderr_limit: payload.stderr_limit ?? STREAM_PREVIEW_CHAR_LIMIT,
    stdout_next_offset: payload.stdout_next_offset ?? null,
    stderr_next_offset: payload.stderr_next_offset ?? null,
    stdout_output_truncated: payload.stdout_output_truncated ?? false,
    stderr_output_truncated: payload.stderr_output_truncated ?? false,
    ...(payload.input_ref ? { input_ref: payload.input_ref } : {}),
    truncated,
    rendered_text_char_length: renderedTextLength,
    full_output_char_length: fullTextLength,
  };
}

function renderToolResultText(payload) {
  if (payload?.schema === 'narada.structured_command.execution_result.v0' && payload.executed === false) {
    const reasons = payload.refusal_reasons ?? payload.decision?.reasons ?? [];
    const hints = payload.remediation_hints ?? payload.decision?.remediation_hints ?? [];
    return [
    guidanceToolDefinition(),
      `structured_command_execute: ${payload.status}`,
      `command: ${payload.command ?? ''}`,
      `working_directory: ${payload.working_directory ?? ''}`,
      `refusal_reasons: ${Array.isArray(reasons) && reasons.length ? reasons.join('; ') : 'none'}`,
      Array.isArray(hints) && hints.length ? `remediation_hints: ${hints.join('; ')}` : null,
    ].filter(Boolean).join('\n');
  }
  if (payload?.schema === 'narada.structured_command.execution_result.v0' && payload.executed === true) {
    const lines = [
      `structured_command_execute: ${payload.status}`,
      `exit_code: ${payload.exit_code}`,
    ];
    const stdoutLines = renderStreamPreviewLines('stdout', payload.stdout, payload.stdout_truncated, payload.stdout_output_truncated);
    const stderrLines = renderStreamPreviewLines('stderr', payload.stderr, payload.stderr_truncated, payload.stderr_output_truncated);
    if (payload.status === 'ok') lines.push(...stdoutLines, ...stderrLines);
    else lines.push(...stderrLines, ...stdoutLines);
    return lines.join('\n');
  }
  if (payload?.schema === 'narada.structured_command.elevated_window_result.v0') {
    const reasons = payload.refusal_reasons ?? [];
    return [
      `structured_command_elevated_window_execute: ${payload.status}`,
      `executed: ${payload.executed === true}`,
      `command: ${payload.command ?? ''}`,
      `working_directory: ${payload.working_directory ?? ''}`,
      Array.isArray(reasons) && reasons.length ? `refusal_reasons: ${reasons.join('; ')}` : null,
      payload.note ? `note: ${payload.note}` : null,
    ].filter(Boolean).join('\n');
  }
  if (payload?.schema === 'narada.structured_command.powershell_parse_check.v0') {
    return [
      `structured_command_powershell_parse_check: ${payload.status}`,
      `path: ${payload.path ?? ''}`,
      `exit_code: ${payload.exit_code ?? ''}`,
      payload.stderr ? `stderr:\n${payload.stderr}` : null,
      payload.stdout ? `stdout:\n${payload.stdout}` : null,
    ].filter(Boolean).join('\n');
  }
  return JSON.stringify(payload, null, 2);
}

function renderStreamPreviewLines(label, value, streamTruncated, pageTruncated) {
  if (!value && !streamTruncated) return [];
  const text = String(value ?? '');
  const preview = text.slice(0, STREAM_PREVIEW_CHAR_LIMIT);
  const lines = [`${label}:`, preview];
  if (text.length > preview.length || pageTruncated) lines.push(`[${label} preview truncated]`);
  if (streamTruncated) lines.push(`[${label} truncated]`);
  return lines;
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psArrayLiteral(values) {
  return `@(${values.map((value) => psSingleQuote(value)).join(', ')})`;
}

function enforceInputCharLimit(value, path = 'arguments') {
  if (typeof value === 'string' && value.length > TOOL_INPUT_CHAR_LIMIT) {
    throw diagnosticError('structured_command_input_too_long', `structured_command_input_too_long:${path}:${value.length}>${TOOL_INPUT_CHAR_LIMIT}`, {
      path,
      length: value.length,
      limit: TOOL_INPUT_CHAR_LIMIT,
    });
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => enforceInputCharLimit(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      enforceInputCharLimit(child, `${path}.${key}`);
    }
  }
}

function structuredCommandExecutionPosture(args: Record<string, unknown>): Record<string, unknown> {
  const testScope = stringEnumValue(args.test_scope, ['focused', 'broad', 'known_slow', 'unknown'], inferTestScope(args));
  const expectedCost = stringEnumValue(args.expected_cost, ['low', 'medium', 'high', 'unknown'], inferExpectedCost(args, testScope));
  return {
    schema: 'narada.structured_command.execution_posture.v0',
    test_scope: testScope,
    expected_cost: expectedCost,
    source: args.test_scope || args.expected_cost ? 'caller_declared' : 'derived',
  };
}

function structuredCommandInputPosture(args: Record<string, unknown>): Record<string, unknown> {
  const posture = structuredCommandExecutionPosture(args);
  return {
    test_scope: posture.test_scope,
    expected_cost: posture.expected_cost,
  };
}

function inferTestScope(args: Record<string, unknown>): string {
  const command = String(args.command ?? '').toLowerCase();
  const argv = Array.isArray(args.args) ? args.args.map((item) => String(item).toLowerCase()) : [];
  if (command === 'pnpm' && argv.includes('test')) return argv.includes('--filter') ? 'focused' : 'broad';
  if (command === 'npm' && argv.includes('test')) return 'broad';
  return 'unknown';
}

function inferExpectedCost(_args: Record<string, unknown>, testScope: string): string {
  if (testScope === 'focused') return 'low';
  if (testScope === 'broad' || testScope === 'known_slow') return 'high';
  return 'unknown';
}

function stringEnumValue(value: unknown, allowed: string[], fallback: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!allowed.includes(text)) throw diagnosticError('structured_command_invalid_enum', 'structured_command_invalid_enum', { value: text, allowed });
  return text;
}

function audit(state, payload) {
  if (!state.auditLogDir) return;
  mkdirSync(state.auditLogDir, { recursive: true });
  appendFileSync(join(state.auditLogDir, 'structured-command.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
}

function createStructuredCommandExecution(result, state) {
  if (!state) return null;
  const executionId = `e_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const record = {
    schema: 'narada.structured_command.execution.v0',
    ref: `structured_command_execution:${executionId}`,
    created_at: new Date().toISOString(),
    sha256: sha256Json(result),
    result,
  };
  writeJsonRecord(executionPath(state, executionId), record);
  return record.ref;
}

function readStructuredCommandExecution(ref, state) {
  const { id } = parseRef(ref, 'execution');
  return readJsonRecord(executionPath(state, id));
}

function readStructuredCommandInput(ref, state) {
  const { id } = parseRef(ref, 'input');
  return readJsonRecord(inputPath(state, id));
}

function parseRef(ref, kind) {
  const match = String(ref ?? '').match(REF_PATTERN);
  if (!match || match[1] !== kind) throw diagnosticError(`structured_command_invalid_${kind}_ref`, `structured_command_invalid_${kind}_ref`, { ref: String(ref ?? ''), expected_kind: kind });
  return { kind: match[1], id: match[2] };
}

function inputPath(state, id) {
  return join(state.storageRoot, 'inputs', `${id}.json`);
}

function executionPath(state, id) {
  return join(state.storageRoot, 'executions', `${id}.json`);
}

function listStructuredCommandResources(state) {
  const dir = join(state.storageRoot, 'executions');
  if (!existsSync(dir)) return { resources: [] };
  return {
    resources: readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => {
      const id = name.replace(/\.json$/, '');
      const ref = `structured_command_execution:${id}`;
      return { uri: structuredCommandExecutionUri(ref), name: ref, title: ref, description: 'Structured command execution artifact.', mimeType: 'application/json' };
    }),
  };
}

function readStructuredCommandResource(params, state) {
  const ref = structuredCommandExecutionRefFromUri(String(params.uri ?? ''));
  const { id } = parseRef(ref, 'execution');
  const record = readJsonRecord(executionPath(state, id));
  return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(record, null, 2) }] };
}

function structuredCommandExecutionUri(ref) {
  return `structured-command-execution:${encodeURIComponent(ref)}`;
}

function structuredCommandExecutionRefFromUri(uri) {
  if (!uri.startsWith('structured-command-execution:')) throw diagnosticError('structured_command_resource_uri_invalid', 'structured_command_resource_uri_invalid', { uri });
  return decodeURIComponent(uri.slice('structured-command-execution:'.length));
}

function writeJsonRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function readJsonRecord(path) {
  if (!existsSync(path)) throw diagnosticError('structured_command_ref_not_found', 'structured_command_ref_not_found', { path });
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeRefId(value) {
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw diagnosticError('structured_command_invalid_ref_id', 'structured_command_invalid_ref_id', { input_id: id, pattern: '^[A-Za-z0-9_-]{8,80}$' });
  return id;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function truncateUtf8(value, maxBytes) {
  let out = value;
  if (Buffer.byteLength(out, 'utf8') <= maxBytes) return out;
  const marker = '[structured-command omitted earlier output; preserved tail]\n';
  if (maxBytes <= Buffer.byteLength(marker, 'utf8')) {
    while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(1);
    return out;
  }
  out = `${marker}${out}`;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = `${marker}${out.slice(marker.length + 1)}`;
  return out;
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function decorateTools(tools) {
  return tools.map((tool) => ({
    ...tool,
    canonical_name: tool.name,
    annotations: { ...toolAnnotations(tool.name), canonicalName: tool.name },
    outputSchema: genericToolOutputSchema(),
  }));
}

function toolAnnotations(name) {
  return {
    title: String(name),
    readOnlyHint: !/execute|create/.test(String(name)),
    destructiveHint: false,
    idempotentHint: /inspect|show/.test(String(name)),
    openWorldHint: true,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      const current = parsed[key];
      parsed[key] = current === undefined ? next : Array.isArray(current) ? [...current, next] : [current, next];
      i++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionList(value: unknown): string[] {
  if (value === undefined || value === null || value === true) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function diagnosticError(codeName, message, details: unknown = {}) {
  return new StructuredCommandError(codeName, message, details);
}

function errorDiagnostic(error) {
  if (error instanceof StructuredCommandError) {
    return {
      schema: 'narada.structured_command.error.v0',
      code: error.codeName,
      message: error.message,
      details: error.details,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(/[:\s]/)[0] || 'structured_command_error';
  return {
    schema: 'narada.structured_command.error.v0',
    code,
    message,
    details: {},
  };
}

function drainJsonRpcFrames(buffer) {
  const requests = [];
  let remaining = buffer;
  while (true) {
    const match = remaining.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
    if (!match) break;
    const headerLength = match[0].length;
    const length = Number(match[1]);
    if (remaining.length < headerLength + length) break;
    const body = remaining.slice(headerLength, headerLength + length);
    requests.push(JSON.parse(body));
    remaining = remaining.slice(headerLength + length);
  }
  return { requests, remaining };
}

function writeJsonRpcMessage(message: unknown, options: { framed: boolean }) {
  const body = JSON.stringify(message);
  if (options.framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

function clientSupportsRoots(initializeParams: Record<string, unknown>): boolean {
  return Boolean(asRecord(asRecord(initializeParams).capabilities).roots);
}

function requestClientRoots(state: StructuredCommandState, pendingServerRequests: Map<string, (message: Record<string, unknown>) => void>, nextId: () => string, options: { framed: boolean }): void {
  const id = nextId();
  pendingServerRequests.set(id, (message) => {
    updateClientRoots(state, asRecord(message.result));
  });
  writeJsonRpcMessage({ jsonrpc: '2.0', id, method: 'roots/list', params: {} }, options);
}

function updateClientRoots(state: StructuredCommandState, result: Record<string, unknown>): void {
  const roots = Array.isArray(result.roots) ? result.roots.map((root) => asRecord(root)).filter((root) => typeof root.uri === 'string') : [];
  state.clientRoots = {
    supported: true,
    roots: roots.map((root) => ({
      uri: String(root.uri),
      ...(typeof root.name === 'string' ? { name: root.name } : {}),
    })),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function clientRootCompletionValues(state: StructuredCommandState): string[] {
  return state.clientRoots.roots.map((root) => {
    const uri = root.uri;
    if (uri.startsWith('file:')) {
      try {
        return fileURLToPath(uri);
      } catch {
        return uri;
      }
    }
    return uri;
  }).filter(Boolean).slice(0, 100);
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel));
  });
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function firstOption(value: unknown): string | null {
  const values = optionList(value);
  return values.length > 0 ? values[0] : null;
}

function loadSiteExtraAllowedRoots(siteRoot: string): string[] {
  try {
    const configPath = join(siteRoot, '.narada', 'allowed-roots.json');
    if (!existsSync(configPath)) return [];
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    if (Array.isArray(data.extra_allowed_roots)) return data.extra_allowed_roots.filter((r: unknown) => typeof r === 'string' && r.trim().length > 0);
  } catch {
    // Best-effort.
  }
  return [];
}

function loadSiteSecrets(siteRoot: string, targetEnv: NodeJS.ProcessEnv): void {
  try {
    const configPath = join(siteRoot, '.narada', 'secrets.json');
    if (!existsSync(configPath)) return;
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    const secretEnv = data.env;
    if (secretEnv && typeof secretEnv === 'object' && !Array.isArray(secretEnv)) {
      for (const [key, value] of Object.entries(secretEnv)) {
        if (typeof value === 'string' && value.trim() && !targetEnv[key]) {
          targetEnv[key] = value;
        }
      }
    }
  } catch {
    // Best-effort.
  }
}
