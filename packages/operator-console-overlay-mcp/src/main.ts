#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGuidanceResult, guidanceToolDefinition } from './guidance.js';

const SERVER_NAME = 'operator-console-overlay-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 16_000;
const COMMANDS = ['inspect', 'start', 'refresh', 'stop'] as const;
const VISIBILITY_POLICIES = ['windows-terminal', 'always'] as const;

export type JsonRecord = Record<string, unknown>;

export type OperatorConsoleOverlayState = {
  naradaRoot: string;
  overlayEntrypoint: string;
  nodePath: string;
  stateRoot: string | null;
  env: NodeJS.ProcessEnv;
  serverName: string;
};

class OperatorConsoleOverlayError extends Error {
  codeName: string;
  details: JsonRecord;

  constructor(codeName: string, message: string, details: JsonRecord = {}) {
    super(message);
    this.name = 'OperatorConsoleOverlayError';
    this.codeName = codeName;
    this.details = details;
  }
}

if (isMainModule()) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n');
    process.exit(1);
  });
}

async function materializeOverlayEntrypoint(state: OperatorConsoleOverlayState, timeoutMs: number): Promise<void> {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  let stdout = '';
  let stderr = '';
  const exitCode = await new Promise<number>((resolveResult, rejectResult) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(pnpm, ['--filter', '@narada-core/operator-console-overlay', 'build'], {
      cwd: state.naradaRoot,
      env: state.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    child.once('error', (error) => finish(() => rejectResult(error)));
    child.once('close', (code) => finish(() => resolveResult(code ?? 1)));
    timer = setTimeout(() => {
      finish(() => {
        void terminateProcessTree(child, state.env).then((cleanup) => {
          rejectResult(diagnosticError(
            'operator_console_overlay_build_timeout',
            'operator_console_overlay_build_timeout:' + timeoutMs,
            {
              command: 'build',
              timeout_ms: timeoutMs,
              stdout,
              stderr,
              process_cleanup: cleanup,
              ...stateDiagnostics(state),
            },
          ));
        }).catch((error) => {
          rejectResult(diagnosticError(
            'operator_console_overlay_build_timeout',
            'operator_console_overlay_build_timeout:' + timeoutMs,
            {
              command: 'build',
              timeout_ms: timeoutMs,
              stdout,
              stderr,
              process_cleanup_error: error instanceof Error ? error.message : String(error),
              ...stateDiagnostics(state),
            },
          ));
        });
      });
    }, timeoutMs);
  }).catch((error) => {
    if (error instanceof OperatorConsoleOverlayError) throw error;
    throw diagnosticError(
      'operator_console_overlay_build_failed',
      'operator_console_overlay_build_failed:' + (error instanceof Error ? error.message : String(error)),
      { narada_root: state.naradaRoot, stdout, stderr },
    );
  });
  if (exitCode !== 0 || !existsSync(state.overlayEntrypoint)) {
    throw diagnosticError(
      'operator_console_overlay_build_failed',
      'operator_console_overlay_build_failed',
      { narada_root: state.naradaRoot, exit_code: exitCode, stdout, stderr, overlay_entrypoint: state.overlayEntrypoint },
    );
  }
}

export function createServerState(
  options: JsonRecord = {},
  env: NodeJS.ProcessEnv = process.env,
): OperatorConsoleOverlayState {
  const sourceRoot = env.NARADA_SRC_ROOT?.trim() || join(homedir(), 'src');
  const naradaRoot = resolve(String(
    options.naradaRoot
    ?? options.narada_root
    ?? env.NARADA_ROOT
    ?? env.NARADA_PROPER_ROOT
    ?? join(sourceRoot, 'narada'),
  ));
  const overlayEntrypoint = resolve(String(
    options.overlayEntrypoint
    ?? options.overlay_entrypoint
    ?? join(naradaRoot, 'packages', 'operator-console-overlay', 'dist', 'cli.js'),
  ));
  assertUnderRoot(overlayEntrypoint, naradaRoot, 'operator_console_overlay_entrypoint_outside_narada_root');
  const stateEnv = normalizeWindowsEnvironment({ ...env, NARADA_ROOT: env.NARADA_ROOT ?? naradaRoot });
  const configuredStateRoot = options.stateRoot ?? options.state_root ?? stateEnv.NARADA_WINDOW_SURFACE_OVERLAY_STATE_ROOT;
  return {
    naradaRoot,
    overlayEntrypoint,
    nodePath: String(options.nodePath ?? options.node_path ?? process.execPath),
    stateRoot: configuredStateRoot ? resolve(String(configuredStateRoot)) : null,
    env: stateEnv,
    serverName: String(options.serverName ?? options.server_name ?? SERVER_NAME),
  };
}

export function listTools(): JsonRecord[] {
  return [
    guidanceToolDefinition(),
    tool('operator_console_overlay_status', 'Inspect the Narada Operator Console overlay without changing it.', {}, [], {
      readOnlyHint: true,
      idempotentHint: true,
    }),
    tool('operator_console_overlay_open', 'Open or update the Narada Operator Console Windows overlay through its canonical Narada implementation.', {
      url: { type: 'string', description: 'Optional HTTP(S) Operator Console URL. Defaults to the configured local console URL.' },
      title: { type: 'string', description: 'Optional overlay title.' },
      visibility: { type: 'string', enum: [...VISIBILITY_POLICIES], default: 'windows-terminal', description: 'Overlay visibility policy.' },
      refresh_seconds: { type: 'integer', minimum: 1, maximum: 3600, default: 2, description: 'Document refresh interval in seconds.' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: 'Bounded wait for the canonical runtime and overlay command.' },
    }, [], {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    }),
    tool('operator_console_overlay_refresh', 'Request a document refresh for the existing Operator Console overlay.', {
      timeout_ms: { type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: 'Bounded wait for the canonical overlay command.' },
    }, [], {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    }),
    tool('operator_console_overlay_close', 'Close the Narada Operator Console overlay owned by this surface.', {
      timeout_ms: { type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: 'Bounded wait for the canonical overlay command.' },
    }, [], {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    }),
  ];
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let framed = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:')
      ? drainJsonRpcFrames(buffer)
      : drainJsonLines(buffer);
    framed ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, framed);
    }
  }
}

export async function handleRequest(
  request: JsonRecord,
  state: OperatorConsoleOverlayState,
): Promise<JsonRecord | null> {
  if (
    request.id === undefined
    && typeof request.method === 'string'
    && request.method.startsWith('notifications/')
  ) return null;
  try {
    const result = await dispatchMethod(
      String(request.method ?? ''),
      asRecord(request.params),
      state,
    );
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code: -32000, message: diagnostic.message, data: diagnostic },
    };
  }
}

export async function runOverlayCommand(
  command: typeof COMMANDS[number],
  state: OperatorConsoleOverlayState,
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JsonRecord> {
  if (!COMMANDS.includes(command)) {
    throw diagnosticError('operator_console_overlay_command_invalid', 'operator_console_overlay_command_invalid', { command });
  }
  const effectiveTimeoutMs = normalizeCommandTimeout(timeoutMs);
  if (!existsSync(state.overlayEntrypoint) && command === 'start') {
    await materializeOverlayEntrypoint(state, effectiveTimeoutMs);
  }
  if (!existsSync(state.overlayEntrypoint)) {
    throw diagnosticError(
      'operator_console_overlay_entrypoint_not_found',
      'operator_console_overlay_entrypoint_not_found:' + state.overlayEntrypoint,
      { narada_root: state.naradaRoot, overlay_entrypoint: state.overlayEntrypoint },
    );
  }
  return new Promise((resolveResult, rejectResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(state.nodePath, [state.overlayEntrypoint, command, ...args], {
      cwd: state.naradaRoot,
      env: state.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const fail = (error: unknown) => finish(() => rejectResult(error));
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      void terminateProcessTree(child, state.env).then((cleanup) => {
        rejectResult(diagnosticError(
          'operator_console_overlay_command_timeout',
          'operator_console_overlay_command_timeout:' + effectiveTimeoutMs,
          {
            command,
            timeout_ms: effectiveTimeoutMs,
            stdout,
            stderr,
            process_cleanup: cleanup,
            ...stateDiagnostics(state),
          },
        ));
      }).catch((error) => {
        rejectResult(diagnosticError(
          'operator_console_overlay_command_timeout',
          'operator_console_overlay_command_timeout:' + effectiveTimeoutMs,
          {
            command,
            timeout_ms: effectiveTimeoutMs,
            stdout,
            stderr,
            process_cleanup_error: error instanceof Error ? error.message : String(error),
            ...stateDiagnostics(state),
          },
        ));
      });
    }, effectiveTimeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => {
      fail(diagnosticError(
        'operator_console_overlay_process_error',
        'operator_console_overlay_process_error:' + error.message,
        { command, stdout, stderr, ...stateDiagnostics(state) },
      ));
    });
    child.once('close', (exitCode) => {
      finish(() => {
        if (exitCode !== 0) {
          rejectResult(diagnosticError(
            'operator_console_overlay_command_failed',
            'operator_console_overlay_command_failed:' + command,
            { command, exit_code: exitCode, stdout, stderr, ...stateDiagnostics(state) },
          ));
          return;
        }
        try {
          const value = JSON.parse(stdout.trim());
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('result_not_object');
          resolveResult(value as JsonRecord);
        } catch (error) {
          rejectResult(diagnosticError(
            'operator_console_overlay_result_invalid_json',
            'operator_console_overlay_result_invalid_json:' + (error instanceof Error ? error.message : String(error)),
            { command, stdout, stderr, ...stateDiagnostics(state) },
          ));
        }
      });
    });
  });
}

async function dispatchMethod(
  method: string,
  params: JsonRecord,
  state: OperatorConsoleOverlayState,
): Promise<JsonRecord> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: state.serverName, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', 'unsupported_mcp_method:' + method, { method });
  }
}

async function callTool(
  params: JsonRecord,
  state: OperatorConsoleOverlayState,
): Promise<JsonRecord> {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'operator_console_overlay_guidance':
      result = buildGuidanceResult(args, state);
      break;
    case 'operator_console_overlay_status':
      result = wrapResult('status', 'inspect', await runOverlayCommand('inspect', state, stateRootArgs(state)), state);
      break;
    case 'operator_console_overlay_open':
      result = await openOverlay(args, state);
      break;
    case 'operator_console_overlay_refresh':
      result = wrapResult('refresh', 'refresh', await runOverlayCommand('refresh', state, stateRootArgs(state), normalizeCommandTimeout(args.timeout_ms)), state);
      break;
    case 'operator_console_overlay_close':
      result = wrapResult('close', 'stop', await runOverlayCommand('stop', state, stateRootArgs(state), normalizeCommandTimeout(args.timeout_ms)), state);
      break;
    default:
      throw diagnosticError('unknown_tool', 'unknown_tool:' + name, { tool_name: name });
  }
  return {
    content: [{ type: 'text', text: renderResult(result) }],
    structuredContent: result,
  };
}

async function openOverlay(
  args: JsonRecord,
  state: OperatorConsoleOverlayState,
): Promise<JsonRecord> {
  const commandArgs: string[] = [];
  const url = normalizeUrl(args.url);
  const title = normalizeText(args.title, 'title', 200);
  const visibility = normalizeVisibility(args.visibility);
  const refreshSeconds = normalizeRefreshSeconds(args.refresh_seconds);
  const timeoutMs = normalizeCommandTimeout(args.timeout_ms);
  if (url) commandArgs.push('--url', url);
  if (title) commandArgs.push('--title', title);
  commandArgs.push('--visibility', visibility, '--refresh-seconds', String(refreshSeconds));
  if (state.stateRoot) commandArgs.push('--state-root', state.stateRoot);
  return wrapResult('open', 'start', await runOverlayCommand('start', state, commandArgs, timeoutMs), state);
}

function wrapResult(
  operation: string,
  command: string,
  overlay: JsonRecord,
  state: OperatorConsoleOverlayState,
): JsonRecord {
  return {
    schema: 'narada.operator_console_overlay.mcp_result.v1',
    status: 'ok',
    operation,
    command,
    overlay_id: 'operator-console',
    narada_root: state.naradaRoot,
    overlay,
  };
}

function stateRootArgs(state: OperatorConsoleOverlayState): string[] {
  return state.stateRoot ? ['--state-root', state.stateRoot] : [];
}

function normalizeUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const url = String(value).trim();
  if (!url || url.length > 2048) throw diagnosticError('operator_console_overlay_url_invalid', 'operator_console_overlay_url_invalid', { received: value });
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    throw diagnosticError('operator_console_overlay_url_invalid', 'operator_console_overlay_url_invalid', { received: value });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw diagnosticError('operator_console_overlay_url_scheme_invalid', 'operator_console_overlay_url_scheme_invalid', { protocol: parsed.protocol });
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength) {
    throw diagnosticError('operator_console_overlay_' + field + '_invalid', 'operator_console_overlay_' + field + '_invalid', {
      max_length: maxLength,
    });
  }
  return text;
}

function normalizeVisibility(value: unknown): string {
  const visibility = value === undefined || value === null || value === ''
    ? 'windows-terminal'
    : String(value);
  if (!(VISIBILITY_POLICIES as readonly string[]).includes(visibility)) {
    throw diagnosticError('operator_console_overlay_visibility_invalid', 'operator_console_overlay_visibility_invalid', {
      allowed: VISIBILITY_POLICIES,
      received: value,
    });
  }
  return visibility;
}

function normalizeRefreshSeconds(value: unknown): number {
  const refreshSeconds = value === undefined || value === null ? 2 : Number(value);
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 1 || refreshSeconds > 3600) {
    throw diagnosticError('operator_console_overlay_refresh_seconds_invalid', 'operator_console_overlay_refresh_seconds_invalid', {
      minimum: 1,
      maximum: 3600,
      received: value,
    });
  }
  return refreshSeconds;
}

function normalizeCommandTimeout(value: unknown): number {
  const timeoutMs = value === undefined || value === null ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw diagnosticError('operator_console_overlay_timeout_invalid', 'operator_console_overlay_timeout_invalid', {
      minimum: 100,
      maximum: MAX_TIMEOUT_MS,
      received: value,
    });
  }
  return timeoutMs;
}

function defaultLocalAppDataRoot(env: NodeJS.ProcessEnv): string {
  return env.LOCALAPPDATA?.trim()
    || join(env.USERPROFILE?.trim() || env.HOME?.trim() || homedir(), 'AppData', 'Local');
}

function normalizeWindowsEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...env };
  if (process.platform !== 'win32') return normalized;
  normalized.LOCALAPPDATA ||= defaultLocalAppDataRoot(normalized);
  const extensions = (normalized.PATHEXT ?? '').split(';').map((value) => value.trim().toUpperCase()).filter(Boolean);
  for (const extension of ['.EXE', '.CMD']) {
    if (!extensions.includes(extension)) extensions.push(extension);
  }
  normalized.PATHEXT = extensions.join(';');
  if (!normalized.windir) normalized.windir = normalized.SystemRoot ?? normalized.WINDIR;
  normalized.NARADA_OPERATOR_CONSOLE_RUNTIME_STATE_ROOT ||= join(normalized.LOCALAPPDATA, 'Narada', 'operator-console-runtime');
  normalized.NARADA_OPERATOR_ROUTER_STATE_ROOT ||= join(normalized.LOCALAPPDATA, 'Narada', 'operator-router');
  normalized.NARADA_WINDOW_SURFACE_OVERLAY_STATE_ROOT ||= join(normalized.LOCALAPPDATA, 'Narada', 'window-surface-overlays');
  return normalized;
}

function stateDiagnostics(state: OperatorConsoleOverlayState): JsonRecord {
  return {
    narada_root: state.naradaRoot,
    overlay_entrypoint: state.overlayEntrypoint,
    overlay_state_root: state.stateRoot,
    runtime_state_root: state.env.NARADA_OPERATOR_CONSOLE_RUNTIME_STATE_ROOT ?? null,
    router_state_root: state.env.NARADA_OPERATOR_ROUTER_STATE_ROOT ?? null,
    environment: {
      localappdata_present: Boolean(state.env.LOCALAPPDATA),
      pathext: state.env.PATHEXT ?? null,
      powershell: state.env.NARADA_POWERSHELL ?? 'pwsh',
    },
  };
}

function terminateProcessTree(child: ChildProcess, env: NodeJS.ProcessEnv): Promise<JsonRecord> {
  const pid = child.pid;
  if (!pid || pid <= 0) return Promise.resolve({ status: 'no_pid' });
  if (process.platform !== 'win32') {
    let killed = false;
    try { killed = child.kill('SIGTERM'); } catch {}
    return Promise.resolve({ status: killed ? 'terminated' : 'already_exited', pid });
  }
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: JsonRecord) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    killer.stdout?.setEncoding('utf8');
    killer.stderr?.setEncoding('utf8');
    killer.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    killer.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ status: 'fallback_terminated', pid, stdout, stderr });
    }, 5_000);
    timer.unref?.();
    killer.once('error', (error) => {
      clearTimeout(timer);
      try { child.kill(); } catch {}
      finish({ status: 'fallback_terminated', pid, error: error.message, stdout, stderr });
    });
    killer.once('close', (code) => {
      clearTimeout(timer);
      finish({ status: code === 0 ? 'terminated_tree' : 'termination_failed', pid, exit_code: code, stdout, stderr });
    });
  });
}

function tool(
  name: string,
  description: string,
  properties: JsonRecord,
  required: string[] = [],
  annotations: JsonRecord = {},
): JsonRecord {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: {
      title: name,
      readOnlyHint: name.endsWith('_status') || name.endsWith('_guidance'),
      destructiveHint: false,
      idempotentHint: name.endsWith('_status') || name.endsWith('_guidance'),
      openWorldHint: false,
      ...annotations,
    },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function parseArgs(argv: string[]): JsonRecord {
  const options: JsonRecord = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--narada-root') options.naradaRoot = nextValue(argv, ++index, arg);
    else if (arg === '--node-path') options.nodePath = nextValue(argv, ++index, arg);
    else if (arg === '--state-root') options.stateRoot = nextValue(argv, ++index, arg);
    else if (arg === '--server-name') options.serverName = nextValue(argv, ++index, arg);
    else throw new Error('unknown_argument:' + arg);
  }
  return options;
}

function nextValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error('missing_argument_value:' + option);
  return value;
}

function drainJsonLines(buffer: string): { framed: false; remaining: string; requests: JsonRecord[] } {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return {
    framed: false,
    remaining,
    requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))),
  };
}

function drainJsonRpcFrames(buffer: string): { framed: true; remaining: string; requests: JsonRecord[] } {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, framed: boolean): void {
  const payload = JSON.stringify(response);
  if (framed) {
    process.stdout.write('Content-Length: ' + Buffer.byteLength(payload, 'utf8') + '\r\n\r\n' + payload);
  } else {
    process.stdout.write(payload + '\n');
  }
}

function assertUnderRoot(child: string, root: string, code: string): void {
  const childPath = resolve(child);
  const rootPath = resolve(root);
  const pathFromRoot = relative(rootPath, childPath);
  if (pathFromRoot === '..' || pathFromRoot.startsWith('..' + pathSeparator()) || isAbsolute(pathFromRoot)) {
    throw diagnosticError(code, code + ':' + childPath, { child: childPath, root: rootPath });
  }
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function appendBounded(current: string, chunk: unknown): string {
  return (current + String(chunk)).slice(0, MAX_OUTPUT_CHARS);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function diagnosticError(code: string, message = code, details: JsonRecord = {}): OperatorConsoleOverlayError {
  return new OperatorConsoleOverlayError(code, message, details);
}

function errorDiagnostic(error: unknown): { code: string; message: string; details: JsonRecord } {
  if (error instanceof OperatorConsoleOverlayError) {
    return { code: error.codeName, message: error.message, details: error.details };
  }
  if (error instanceof Error) return { code: 'operator_console_overlay_error', message: error.message, details: {} };
  return { code: 'operator_console_overlay_error', message: String(error), details: {} };
}

function renderResult(result: JsonRecord): string {
  if (result.operation === 'status' || result.operation === 'open' || result.operation === 'close' || result.operation === 'refresh') {
    const overlay = asRecord(result.overlay);
    const state = overlay.state ?? overlay.status ?? 'unknown';
    return 'operator console overlay: ' + result.operation + ' (' + state + ')';
  }
  return JSON.stringify(result, null, 2);
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
}
