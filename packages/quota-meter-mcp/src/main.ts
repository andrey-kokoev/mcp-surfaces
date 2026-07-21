#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGuidanceResult, guidanceToolDefinition } from './guidance.js';

const SERVER_NAME = 'quota-meter-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const PROVIDER_SELECTIONS = ['all', 'codex', 'kimi', 'codex,kimi', 'kimi,codex'] as const;
const DEFAULT_REFRESH_SECONDS = 60;
const COMMAND_TIMEOUT_MS = 30_000;

export type JsonRecord = Record<string, unknown>;

export type QuotaMeterState = {
  quotaMeterRoot: string;
  nodePath: string;
  cliPath: string;
  stateRoot: string;
  pidPath: string;
  positionPath: string;
  env: NodeJS.ProcessEnv;
  serverName: string;
};

type CommandResult = {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
};

class QuotaMeterError extends Error {
  codeName: string;
  details: JsonRecord;

  constructor(codeName: string, message: string, details: JsonRecord = {}) {
    super(message);
    this.name = 'QuotaMeterError';
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

export function createServerState(options: JsonRecord = {}, env: NodeJS.ProcessEnv = process.env): QuotaMeterState {
  const quotaMeterRoot = resolve(String(options.quotaMeterRoot ?? options.quota_meter_root ?? env.QUOTA_METER_ROOT ?? 'D:\\code\\quota-meter'));
  const stateRoot = resolve(String(options.stateRoot ?? options.state_root ?? env.QUOTA_METER_STATE_ROOT ?? join(env.LOCALAPPDATA ?? env.TEMP ?? env.TMP ?? process.cwd(), 'quota-meter')));
  const stateEnv: NodeJS.ProcessEnv = { ...env, QUOTA_METER_STATE_ROOT: stateRoot };
  if (process.platform === 'win32' && !stateEnv.windir) {
    const windowsRoot = stateEnv.SystemRoot ?? stateEnv.WINDIR ?? process.env.SystemRoot;
    if (windowsRoot) stateEnv.windir = windowsRoot;
  }
  return {
    quotaMeterRoot,
    nodePath: String(options.nodePath ?? options.node_path ?? env.QUOTA_METER_NODE ?? process.execPath),
    cliPath: join(quotaMeterRoot, 'src', 'cli.js'),
    stateRoot,
    pidPath: join(stateRoot, 'overlay.pid'),
    positionPath: join(stateRoot, 'overlay-position.json'),
    env: stateEnv,
    serverName: String(options.serverName ?? options.server_name ?? SERVER_NAME),
  };
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let framed = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:') ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer);
    framed ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, framed);
    }
  }
}

export async function handleRequest(request: JsonRecord, state: QuotaMeterState): Promise<JsonRecord | null> {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
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

export function listTools(): JsonRecord[] {
  return [
    guidanceToolDefinition(),
    tool('quota_meter_glide_status', 'Read current quota windows and glide factors from quota-meter without launching provider login.', {
      providers: { type: 'string', enum: [...PROVIDER_SELECTIONS], default: 'all', description: 'Provider selection.' },
    }),
    tool('quota_meter_overlay_status', 'Inspect whether the quota-meter overlay is running and read its persisted position.', {}),
    tool('quota_meter_overlay_start', 'Start the quota-meter transparent glide overlay using native provider CLI authentication.', {
      providers: { type: 'string', enum: [...PROVIDER_SELECTIONS], default: 'all', description: 'Providers to display.' },
      refresh_seconds: { type: 'integer', minimum: 5, maximum: 3600, default: DEFAULT_REFRESH_SECONDS, description: 'Overlay refresh interval.' },
    }, [], { readOnlyHint: false, destructiveHint: false, idempotentHint: true }),
    tool('quota_meter_overlay_stop', 'Stop the quota-meter overlay owned by this user.', {}, [], { readOnlyHint: false, destructiveHint: false, idempotentHint: true }),
  ];
}

async function dispatchMethod(method: string, params: JsonRecord, state: QuotaMeterState): Promise<JsonRecord> {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: state.serverName, version: SERVER_VERSION } };
    case 'tools/list': return { tools: listTools() };
    case 'tools/call': return callTool(params, state);
    default: throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`, { method });
  }
}

async function callTool(params: JsonRecord, state: QuotaMeterState): Promise<JsonRecord> {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'quota_meter_guidance': result = buildGuidanceResult(args, state); break;
    case 'quota_meter_glide_status': result = await quotaMeterGlideStatus(args, state); break;
    case 'quota_meter_overlay_status': result = quotaMeterOverlayStatus(state); break;
    case 'quota_meter_overlay_start': result = await quotaMeterOverlayStart(args, state); break;
    case 'quota_meter_overlay_stop': result = await quotaMeterOverlayStop(state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

export function normalizeProviderSelection(value: unknown): string {
  const selection = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'all';
  if (!(PROVIDER_SELECTIONS as readonly string[]).includes(selection)) {
    throw diagnosticError('quota_meter_invalid_provider_selection', `quota_meter_invalid_provider_selection:${selection}`, { allowed: PROVIDER_SELECTIONS });
  }
  return selection;
}

export function normalizeRefreshSeconds(value: unknown): number {
  const refresh = value === undefined || value === null ? DEFAULT_REFRESH_SECONDS : Number(value);
  if (!Number.isInteger(refresh) || refresh < 5 || refresh > 3600) {
    throw diagnosticError('quota_meter_invalid_refresh_seconds', 'quota_meter_invalid_refresh_seconds', { minimum: 5, maximum: 3600, received: value });
  }
  return refresh;
}

export function quotaMeterOverlayStatus(state: QuotaMeterState): JsonRecord {
  const pid = readPid(state.pidPath);
  const running = pid !== null && processAlive(pid);
  return {
    schema: 'narada.quota_meter.overlay_status.v1',
    status: running ? 'running' : pid === null ? 'stopped' : 'stale',
    running,
    pid,
    pid_path: state.pidPath,
    position_path: state.positionPath,
    position: readPosition(state.positionPath),
  };
}

async function quotaMeterGlideStatus(args: JsonRecord, state: QuotaMeterState): Promise<JsonRecord> {
  const providers = normalizeProviderSelection(args.providers);
  const result = await runQuotaMeter(['glide-path', '--provider', providers, '--json', '--no-login'], state);
  const payload = parseQuotaJson(result, 'quota_meter_glide_output_invalid_json');
  const providerResults = Array.isArray(payload.providers) ? payload.providers : [];
  return {
    schema: 'narada.quota_meter.glide_status.v1',
    status: providerResults.every((provider) => asRecord(provider).status === 'ok') ? 'ok' : 'partial',
    provider_selection: providers,
    exit_code: result.exit_code,
    generated_at: payload.generatedAt ?? null,
    providers: providerResults,
  };
}

async function quotaMeterOverlayStart(args: JsonRecord, state: QuotaMeterState): Promise<JsonRecord> {
  const providers = normalizeProviderSelection(args.providers);
  const refreshSeconds = normalizeRefreshSeconds(args.refresh_seconds);
  const result = await runQuotaMeter(['overlay', '--provider', providers, '--refresh', String(refreshSeconds)], state);
  assertCommandSucceeded(result, 'quota_meter_overlay_start_failed');
  const status = quotaMeterOverlayStatus(state);
  return {
    schema: 'narada.quota_meter.overlay_lifecycle.v1',
    status: result.stdout.includes('already running') ? 'already_running' : 'started',
    provider_selection: providers,
    refresh_seconds: refreshSeconds,
    cli_output: result.stdout,
    overlay: status,
  };
}

async function quotaMeterOverlayStop(state: QuotaMeterState): Promise<JsonRecord> {
  const result = await runQuotaMeter(['overlay', '--stop'], state);
  assertCommandSucceeded(result, 'quota_meter_overlay_stop_failed');
  return {
    schema: 'narada.quota_meter.overlay_lifecycle.v1',
    status: result.stdout.includes('not running') ? 'already_stopped' : 'stopped',
    cli_output: result.stdout,
    overlay: quotaMeterOverlayStatus(state),
  };
}

function ensureQuotaMeter(state: QuotaMeterState): void {
  if (!existsSync(state.cliPath)) {
    throw diagnosticError('quota_meter_cli_not_found', `quota_meter_cli_not_found:${state.cliPath}`, {
      quota_meter_root: state.quotaMeterRoot,
      remediation: 'Set QUOTA_METER_ROOT to the quota-meter checkout and restart the MCP surface.',
    });
  }
}

function runQuotaMeter(args: string[], state: QuotaMeterState, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  ensureQuotaMeter(state);
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(state.nodePath, [state.cliPath, ...args], {
      cwd: state.quotaMeterRoot,
      env: state.env,
      windowsHide: true,
    });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    timer = setTimeout(() => {
      child.kill();
      finish({ exit_code: -2, stdout, stderr: `${stderr}\nquota-meter timed out after ${timeoutMs}ms`.trim(), timed_out: true });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ exit_code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timed_out: false }));
    child.on('close', (code) => finish({ exit_code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim(), timed_out: false }));
  });
}

function parseQuotaJson(result: CommandResult, errorCode: string): JsonRecord {
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as JsonRecord;
  } catch {
    throw diagnosticError(errorCode, errorCode, { exit_code: result.exit_code, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) });
  }
}

function assertCommandSucceeded(result: CommandResult, code: string): void {
  if (result.exit_code !== 0) throw diagnosticError(code, code, { exit_code: result.exit_code, timed_out: result.timed_out, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) });
}

function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPosition(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value = asRecord(JSON.parse(readFileSync(path, 'utf8')));
    return { left: value.left ?? null, top: value.top ?? null, updated_at: value.updatedAt ?? null };
  } catch {
    return null;
  }
}

function renderResult(result: JsonRecord): string {
  const lines = [`quota-meter: ${result.status ?? 'ok'}`];
  if (result.provider_selection) lines.push(`providers: ${result.provider_selection}`);
  const overlay = asRecord(result.overlay);
  if (Object.keys(overlay).length > 0) lines.push(`overlay: ${overlay.status ?? 'unknown'}${overlay.pid ? ` (pid ${overlay.pid})` : ''}`);
  const providers = Array.isArray(result.providers) ? result.providers : [];
  for (const provider of providers) {
    const record = asRecord(provider);
    for (const window of Array.isArray(record.windows) ? record.windows : []) {
      const windowRecord = asRecord(window);
      const glide = asRecord(windowRecord.glidePath);
      lines.push(`${record.displayName ?? record.id ?? 'provider'} ${windowRecord.label ?? 'window'}: ${glide.glidePathFactor ?? 'n/a'} (${glide.status ?? 'unknown'})`);
    }
  }
  return lines.join('\n');
}

function tool(name: string, description: string, properties: JsonRecord, required: string[] = [], annotations: JsonRecord = {}): JsonRecord {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { title: name, readOnlyHint: name.endsWith('_status') || name.endsWith('_guidance') || name === 'quota_meter_glide_status', destructiveHint: false, idempotentHint: name.endsWith('_status') || name.endsWith('_guidance'), openWorldHint: false, ...annotations },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function parseArgs(argv: string[]): JsonRecord {
  const options: JsonRecord = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--quota-meter-root') options.quotaMeterRoot = argv[++index];
    else if (arg === '--node-path') options.nodePath = argv[++index];
    else if (arg === '--state-root') options.stateRoot = argv[++index];
    else if (arg === '--server-name') options.serverName = argv[++index];
    else throw new Error(`unknown_argument:${arg}`);
  }
  return options;
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return { framed: false, remaining, requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) };
}

function drainJsonRpcFrames(buffer: string) {
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
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function diagnosticError(code: string, message = code, details: JsonRecord = {}): QuotaMeterError {
  return new QuotaMeterError(code, message, details);
}

function errorDiagnostic(error: unknown): { code: string; message: string; details: JsonRecord } {
  if (error instanceof QuotaMeterError) return { code: error.codeName, message: error.message, details: error.details };
  if (error instanceof Error) return { code: 'quota_meter_error', message: error.message, details: {} };
  return { code: 'quota_meter_error', message: String(error), details: {} };
}
