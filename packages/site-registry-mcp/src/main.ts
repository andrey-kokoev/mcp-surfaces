#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGuidanceResult, guidanceToolDefinition } from './guidance.js';

const SERVER_NAME = 'site-registry-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_NARADA_ROOT = 'D:/code/narada';

type JsonRecord = Record<string, unknown>;
type ServerState = { naradaRoot: string; cliModulePath: string };
type RegistryCommandSpec = {
  tool: string;
  cli: string;
  functionName: string;
  description: string;
  properties: JsonRecord;
  required?: string[];
};

const COMMANDS: RegistryCommandSpec[] = [
  {
    tool: 'site_registry_list',
    cli: 'narada sites registry list',
    functionName: 'sitesRegistryListCommand',
    description: 'List canonical Site Registry records for browser and operator read models without exposing registry storage to callers.',
    properties: {},
  },
  {
    tool: 'site_registry_show',
    cli: 'narada sites registry show <reference>',
    functionName: 'sitesRegistryShowCommand',
    description: 'Show one canonical Site Registry record, including lifecycle and observation state, provenance, conflicts, revision, and next actions.',
    properties: { reference: stringSchema('Canonical Site id or registered alias to show.') },
    required: ['reference'],
  },
  {
    tool: 'site_registry_discover_plan',
    cli: 'narada sites registry discover --dry-run',
    functionName: 'sitesRegistryDiscoverCommand',
    description: 'Preview Site Registry discovery and reconciliation without mutating the registry.',
    properties: {
      source: stringSchema('Discovery source: filesystem, launch_registry, or all.'),
      root: stringSchema('Optional root used to bound discovery.'),
      actor: stringSchema('Optional actor recorded in the dry-run result.'),
    },
  },
];

export function createServerState(options: JsonRecord = {}): ServerState {
  const naradaRoot = normalizePath(String(options.naradaRoot ?? options.narada_root ?? process.env.NARADA_ROOT ?? DEFAULT_NARADA_ROOT));
  const cliModulePath = normalizePath(String(options.cliModulePath ?? options.cli_module_path ?? join(naradaRoot, 'packages', 'layers', 'cli', 'dist', 'commands', 'site-registry-management.js')));
  return { naradaRoot, cliModulePath };
}

export async function handleRequest(request: JsonRecord, state: ServerState) {
  if (request.id === undefined && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let queue = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:') ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer);
    buffer = drained.remaining;
    for (const request of drained.requests) {
      queue = queue.then(async () => {
        const response = await handleRequest(request, state);
        if (response) writeJsonRpcResponse(response, { framed: drained.framed });
      });
    }
  });
}

async function dispatchMethod(method: string, params: JsonRecord, state: ServerState) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    guidanceToolDefinition(),
    tool('site_registry_doctor', 'Inspect site registry MCP posture, Narada root, CLI module availability, and command coverage.', {}),
    tool('site_registry_command_map', 'List MCP tools and their aligned narada sites CLI commands.', {}),
    ...COMMANDS.map((spec) => tool(spec.tool, spec.description, spec.properties, spec.required)),
  ];
}

async function callTool(params: JsonRecord, state: ServerState) {
  const name = requiredString(params, 'name');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  if (name === 'site_registry_guidance') result = buildGuidanceResult(args);
  else if (name === 'site_registry_doctor') result = siteRegistryDoctor(state);
  else if (name === 'site_registry_command_map') result = siteRegistryCommandMap();
  else {
    const spec = COMMANDS.find((item) => item.tool === name);
    if (!spec) throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
    result = await invokeRegistryCommand(spec, args, state);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

function siteRegistryDoctor(state: ServerState): JsonRecord {
  return {
    status: existsSync(state.cliModulePath) ? 'ok' : 'cli_module_missing',
    server_name: SERVER_NAME,
    narada_root: state.naradaRoot,
    cli_module_path: state.cliModulePath,
    cli_module_exists: existsSync(state.cliModulePath),
    command_count: COMMANDS.length,
    coverage: COMMANDS.map(commandSummary),
    remediation: existsSync(state.cliModulePath) ? null : `Build the Narada CLI in ${state.naradaRoot}.`,
  };
}

function siteRegistryCommandMap(): JsonRecord {
  return { status: 'ok', commands: COMMANDS.map(commandSummary), count: COMMANDS.length };
}

async function invokeRegistryCommand(spec: RegistryCommandSpec, args: JsonRecord, state: ServerState): Promise<JsonRecord> {
  for (const key of spec.required ?? []) requiredString(args, key);
  const module = await loadCliModule(state);
  const fn = module[spec.functionName];
  if (typeof fn !== 'function') {
    throw diagnosticError('cli_function_missing', `cli_function_missing:${spec.functionName}`, {
      tool: spec.tool,
      cli_command: spec.cli,
      cli_module_path: state.cliModulePath,
    });
  }
  const normalizedArgs = normalizeCommandArgs(spec, args);
  const raw = await (fn as (options: JsonRecord, context: JsonRecord) => Promise<JsonRecord>)(normalizedArgs, silentCommandContext());
  return {
    status: raw?.exitCode && raw.exitCode !== 0 ? 'failed' : 'ok',
    tool: spec.tool,
    cli_command: spec.cli,
    cli_function: spec.functionName,
    read_only: true,
    mutation_performed: false,
    result: raw?.result ?? raw,
    exit_code: raw?.exitCode ?? 0,
  };
}

async function loadCliModule(state: ServerState): Promise<JsonRecord> {
  if (!existsSync(state.cliModulePath)) {
    throw diagnosticError('narada_cli_module_missing', `narada_cli_module_missing:${state.cliModulePath}`, {
      cli_module_path: state.cliModulePath,
      remediation: `Build the Narada CLI in ${state.naradaRoot}.`,
    });
  }
  return import(pathToFileURL(state.cliModulePath).href) as Promise<JsonRecord>;
}

function normalizeCommandArgs(spec: RegistryCommandSpec, args: JsonRecord): JsonRecord {
  const normalized: JsonRecord = { ...args, format: 'json', verbose: args.verbose === true };
  if (spec.tool === 'site_registry_discover_plan') {
    normalized.dryRun = true;
    delete normalized.apply;
  }
  return normalized;
}

function silentCommandContext() {
  return { logger: { info() {}, warn() {}, error() {}, debug() {} }, signal: undefined };
}

function commandSummary(spec: RegistryCommandSpec) {
  return {
    tool: spec.tool,
    cli_command: spec.cli,
    cli_function: spec.functionName,
    read_only: true,
    requires_execute: false,
    requires_authority: false,
  };
}

function tool(name: string, description: string, properties: JsonRecord, required: string[] = []) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { title: name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function stringSchema(description: string) {
  return { type: 'string', description };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function requiredString(args: JsonRecord, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw diagnosticError('required_argument_missing', `required_argument_missing:${key}`, { key });
  return value.trim();
}

function normalizePath(path: string) {
  return resolve(path).replace(/\\/g, '/');
}

function diagnosticError(code: string, message: string, detail: JsonRecord = {}) {
  const error = new Error(message) as Error & { code?: string; detail?: JsonRecord };
  error.code = code;
  error.detail = detail;
  return error;
}

function errorDiagnostic(error: unknown): JsonRecord {
  if (error instanceof Error) {
    const known = error as Error & { code?: string; detail?: JsonRecord };
    return { code: known.code ?? 'error', message: error.message, ...(known.detail ?? {}) };
  }
  return { code: 'error', message: String(error) };
}

function drainJsonRpcFrames(buffer: string): { requests: JsonRecord[]; remaining: string; framed: boolean } {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const crlfHeaderEnd = remaining.indexOf('\r\n\r\n');
    const lfHeaderEnd = remaining.indexOf('\n\n');
    const headerEnd = crlfHeaderEnd >= 0 ? crlfHeaderEnd : lfHeaderEnd;
    if (headerEnd < 0) break;
    const separatorLength = crlfHeaderEnd >= 0 ? 4 : 2;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + separatorLength;
    if (Buffer.byteLength(remaining.slice(bodyStart), 'utf8') < contentLength) break;
    const body = Buffer.from(remaining.slice(bodyStart), 'utf8').subarray(0, contentLength).toString('utf8');
    const consumed = bodyStart + Buffer.byteLength(body, 'utf8');
    requests.push(JSON.parse(body) as JsonRecord);
    remaining = remaining.slice(consumed);
  }
  return { requests, remaining, framed: true };
}

function drainJsonLines(buffer: string): { requests: JsonRecord[]; remaining: string; framed: boolean } {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  const requests = lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as JsonRecord);
  return { requests, remaining, framed: false };
}

function writeJsonRpcResponse(response: JsonRecord, options: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (options.framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runStdioServer(parseArgs(process.argv.slice(2)));
}

function parseArgs(argv: string[]): JsonRecord {
  const parsed: JsonRecord = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}
