#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'site-lifecycle-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_NARADA_ROOT = 'D:/code/narada';

type JsonRecord = Record<string, unknown>;
type ServerState = { naradaRoot: string; cliModulePath: string };
type SiteCommandSpec = {
  tool: string;
  cli: string;
  functionName: string;
  readOnly: boolean;
  requiresExecute?: boolean;
  requiresAuthority?: boolean;
  description: string;
  properties: JsonRecord;
  required?: string[];
};

const COMMANDS: SiteCommandSpec[] = [
  {
    tool: 'site_create_presets_list',
    cli: 'narada sites create-presets',
    functionName: 'sitesCreatePresetsCommand',
    readOnly: true,
    description: 'List greenfield create-site presets from the Narada CLI template catalog.',
    properties: {},
  },
  {
    tool: 'site_create_plan',
    cli: 'narada sites create --dry-run',
    functionName: 'sitesCreateCommand',
    readOnly: true,
    description: 'Plan greenfield Narada Site creation using the same semantics as narada sites create --dry-run.',
    properties: createSiteProperties(),
  },
  {
    tool: 'site_list',
    cli: 'narada sites list',
    functionName: 'sitesListCommand',
    readOnly: true,
    description: 'List discovered Narada Sites using narada sites list semantics.',
    properties: {},
  },
  {
    tool: 'site_discover',
    cli: 'narada sites discover',
    functionName: 'sitesDiscoverCommand',
    readOnly: false,
    requiresExecute: true,
    description: 'Refresh Narada site discovery registry using narada sites discover semantics.',
    properties: mutationProperties(),
  },
  {
    tool: 'site_show',
    cli: 'narada sites show <site-id>',
    functionName: 'sitesShowCommand',
    readOnly: true,
    description: 'Show Site metadata and last-known health using narada sites show semantics.',
    properties: { site_id: stringSchema('Site id to show.') },
    required: ['site_id'],
  },
  {
    tool: 'site_doctor',
    cli: 'narada sites doctor <site-id>',
    functionName: 'sitesDoctorCommand',
    readOnly: true,
    description: 'Validate a Site root and authority posture using narada sites doctor semantics.',
    properties: {
      site_id: stringSchema('Site id to inspect.'),
      root: stringSchema('Optional site workspace/root path to inspect.'),
      authority_locus: stringSchema('Optional authority locus.'),
      kind: stringSchema('Site kind, e.g. windows, client, project.'),
    },
    required: ['site_id'],
  },
  {
    tool: 'site_init',
    cli: 'narada sites init <site-id>',
    functionName: 'sitesInitCommand',
    readOnly: false,
    requiresExecute: true,
    requiresAuthority: true,
    description: 'Initialize a new Narada Site using narada sites init semantics.',
    properties: {
      ...mutationProperties(),
      site_id: stringSchema('Site id to initialize.'),
      substrate: stringSchema('Substrate: windows-native, windows-wsl, macos, linux-user, linux-system.'),
      operation: stringSchema('Optional operation id to bind.'),
      root: stringSchema('Optional site root override.'),
      authority_locus: stringSchema('Optional authority locus.'),
      sync: stringSchema('Optional sync posture.'),
      execution_surface: stringSchema('Optional execution surface.'),
      dry_run: booleanSchema('Preview without making changes. Defaults true unless execute is true.'),
    },
    required: ['site_id', 'substrate', 'authority_basis'],
  },
  {
    tool: 'site_lifecycle_kinds',
    cli: 'narada sites lifecycle kinds',
    functionName: 'sitesLifecycleKindsCommand',
    readOnly: true,
    description: 'List governed Site lifecycle transformation kinds.',
    properties: {},
  },
  {
    tool: 'site_lifecycle_preflight',
    cli: 'narada sites lifecycle preflight <kind>',
    functionName: 'sitesLifecyclePreflightCommand',
    readOnly: true,
    description: 'Preflight a governed Site lifecycle transformation without mutation.',
    properties: {
      kind: stringSchema('Lifecycle transformation kind.'),
      source_site: stringSchema('Optional source Site id or path.'),
      target_site: stringSchema('Optional target Site id or path.'),
      authority_mode: stringSchema('Optional authority mode.'),
    },
    required: ['kind'],
  },
  {
    tool: 'site_relation_list',
    cli: 'narada sites relation list',
    functionName: 'sitesRelationListCommand',
    readOnly: true,
    description: 'List durable Site relation records.',
    properties: {
      kind: stringSchema('Optional relation kind filter.'),
      source_site: stringSchema('Optional source Site filter.'),
      target_site: stringSchema('Optional target Site filter.'),
      status: stringSchema('Optional relation status filter.'),
      limit: numberSchema('Maximum relations.'),
      cwd: stringSchema('Working directory. Defaults to current Narada root.'),
    },
  },
  {
    tool: 'site_relation_validate',
    cli: 'narada sites relation validate',
    functionName: 'sitesRelationValidateCommand',
    readOnly: true,
    description: 'Validate reciprocal and authority posture of Site relation records.',
    properties: { cwd: stringSchema('Working directory. Defaults to current Narada root.') },
  },
  {
    tool: 'site_authority_preflight',
    cli: 'narada sites authority preflight',
    functionName: 'siteMutationAuthorityPreflightCommand',
    readOnly: true,
    description: 'Preflight whether a site mutation would occur at the declared authority locus.',
    properties: {
      cwd: stringSchema('Working directory to inspect.'),
      mutation_family: stringSchema('Mutation family: task_lifecycle, inbox, publication, secret, or site.'),
    },
  },
  {
    tool: 'site_deps_sync',
    cli: 'narada sites deps sync',
    functionName: 'sitesDepsSyncCommand',
    readOnly: false,
    requiresExecute: true,
    requiresAuthority: true,
    description: 'Synchronize shared Narada package links and provenance for a Site.',
    properties: {
      ...mutationProperties(),
      root: stringSchema('Site root or containing workspace root.'),
      apply: booleanSchema('Create or repair package links and provenance.'),
    },
    required: ['authority_basis'],
  },
];

export function createServerState(options: JsonRecord = {}): ServerState {
  const naradaRoot = normalizePath(String(options.naradaRoot ?? options.narada_root ?? process.env.NARADA_ROOT ?? DEFAULT_NARADA_ROOT));
  const cliModulePath = normalizePath(String(options.cliModulePath ?? options.cli_module_path ?? join(naradaRoot, 'packages', 'layers', 'cli', 'dist', 'commands', 'sites.js')));
  return { naradaRoot, cliModulePath };
}

export async function handleRequest(request: JsonRecord, state: ServerState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
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
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:') ? drainJsonRpcFrames(buffer) : drainJsonLines(buffer);
    sawFramedInput ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

async function dispatchMethod(method: string, params: JsonRecord, state: ServerState) {
  switch (method) {
    case 'initialize': return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
    case 'tools/list': return { tools: listTools() };
    case 'tools/call': return callTool(params, state);
    default: throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    guidanceToolDefinition(),
    tool('site_lifecycle_doctor', 'Inspect site lifecycle MCP posture, Narada root, CLI module availability, and command coverage.', {}, [], true),
    tool('site_lifecycle_command_map', 'List MCP tools and their aligned narada sites CLI commands.', {}, [], true),
    ...COMMANDS.map((spec) => tool(spec.tool, spec.description, spec.properties, spec.required ?? [], spec.readOnly)),
  ];
}

async function callTool(params: JsonRecord, state: ServerState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  if (name === 'site_lifecycle_guidance') result = buildGuidanceResult(args);
  else   if (name === 'site_lifecycle_doctor') result = siteLifecycleDoctor(state);
  else if (name === 'site_lifecycle_command_map') result = siteLifecycleCommandMap();
  else {
    const spec = COMMANDS.find((item) => item.tool === name);
    if (!spec) throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
    result = await invokeSiteCommand(spec, args, state);
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function siteLifecycleDoctor(state: ServerState): JsonRecord {
  return {
    status: existsSync(state.cliModulePath) ? 'ok' : 'cli_module_missing',
    server_name: SERVER_NAME,
    narada_root: state.naradaRoot,
    cli_module_path: state.cliModulePath,
    cli_module_exists: existsSync(state.cliModulePath),
    command_count: COMMANDS.length,
    coverage: COMMANDS.map(commandSummary),
    remediation: existsSync(state.cliModulePath) ? null : `Build the Narada CLI first, e.g. run pnpm --filter @narada2/cli build in ${state.naradaRoot}.`,
  };
}

function siteLifecycleCommandMap(): JsonRecord {
  return { status: 'ok', commands: COMMANDS.map(commandSummary), count: COMMANDS.length };
}

async function invokeSiteCommand(spec: SiteCommandSpec, args: JsonRecord, state: ServerState): Promise<JsonRecord> {
  const execute = args.execute === true || args.mutation_authorized === true;
  if (!spec.readOnly && spec.requiresExecute && !execute) {
    return {
      status: 'planned',
      read_only: true,
      mutation_performed: false,
      tool: spec.tool,
      cli_command: spec.cli,
      reason: 'mutation_requires_execute_true',
      required_arguments: ['execute:true', ...(spec.requiresAuthority ? ['authority_basis'] : [])],
      normalized_args: normalizeCommandArgs(spec, args, { dryRunDefault: true }),
    };
  }
  if (spec.requiresAuthority && !isPlainObject(args.authority_basis)) {
    throw diagnosticError('authority_basis_required', `authority_basis_required:${spec.tool}`, { tool: spec.tool, cli_command: spec.cli });
  }
  const module = await loadCliModule(state);
  const fn = module[spec.functionName];
  if (typeof fn !== 'function') {
    throw diagnosticError('cli_function_missing', `cli_function_missing:${spec.functionName}`, { tool: spec.tool, cli_command: spec.cli, cli_module_path: state.cliModulePath });
  }
  const normalizedArgs = normalizeCommandArgs(spec, args, { dryRunDefault: spec.tool === 'site_create_plan' });
  const raw = await callCliFunction(fn, spec, normalizedArgs);
  return {
    status: raw?.exitCode && raw.exitCode !== 0 ? 'failed' : 'ok',
    tool: spec.tool,
    cli_command: spec.cli,
    cli_function: spec.functionName,
    mutation_performed: !spec.readOnly && execute,
    result: raw?.result ?? raw,
    exit_code: raw?.exitCode ?? 0,
  };
}

async function loadCliModule(state: ServerState): Promise<JsonRecord> {
  if (!existsSync(state.cliModulePath)) {
    throw diagnosticError('narada_cli_module_missing', `narada_cli_module_missing:${state.cliModulePath}`, {
      cli_module_path: state.cliModulePath,
      remediation: `Build the Narada CLI first, e.g. run pnpm --filter @narada2/cli build in ${state.naradaRoot}.`,
    });
  }
  return import(pathToFileURL(state.cliModulePath).href) as Promise<JsonRecord>;
}

async function callCliFunction(fn: Function, spec: SiteCommandSpec, args: JsonRecord) {
  const context = silentCommandContext();
  if (['site_show', 'site_doctor', 'site_init'].includes(spec.tool)) {
    const siteId = requiredString(args, 'site_id');
    return fn(siteId, stripKeys(args, ['site_id', 'execute', 'mutation_authorized', 'authority_basis']), context);
  }
  return fn(stripKeys(args, ['execute', 'mutation_authorized', 'authority_basis']), context);
}

function normalizeCommandArgs(spec: SiteCommandSpec, args: JsonRecord, options: { dryRunDefault?: boolean } = {}): JsonRecord {
  const normalized: JsonRecord = { ...args, format: 'json', verbose: args.verbose === true };
  for (const [from, to] of [['site_id', 'siteId'], ['site_kind', 'siteKind'], ['authority_locus', 'authorityLocus'], ['execution_surface', 'executionSurface'], ['source_site', 'sourceSite'], ['target_site', 'targetSite'], ['authority_mode', 'authorityMode'], ['mutation_family', 'mutationFamily']] as const) {
    if (normalized[from] !== undefined && normalized[to] === undefined) normalized[to] = normalized[from];
  }
  if (spec.tool === 'site_create_plan') normalized.dryRun = true;
  if (options.dryRunDefault && normalized.dryRun === undefined) normalized.dryRun = true;
  if (spec.tool === 'site_deps_sync' && normalized.apply === undefined) normalized.apply = normalized.execute === true;
  return normalized;
}

function silentCommandContext() {
  return { logger: { info() {}, warn() {}, error() {}, debug() {} }, signal: undefined };
}

function commandSummary(spec: SiteCommandSpec) {
  return {
    tool: spec.tool,
    cli_command: spec.cli,
    cli_function: spec.functionName,
    read_only: spec.readOnly,
    requires_execute: spec.requiresExecute === true,
    requires_authority: spec.requiresAuthority === true,
  };
}

function tool(name: string, description: string, properties: JsonRecord, required: string[] = [], readOnly = true) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { title: name, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function createSiteProperties() {
  return {
    config: stringSchema('Create-site config JSON path.'),
    preset: stringSchema('Greenfield template preset.'),
    site_id: stringSchema('Site id for shorthand create-site planning.'),
    root: stringSchema('Site root for shorthand create-site planning.'),
    site_kind: stringSchema('Site kind for shorthand create-site planning.'),
    authority_locus: stringSchema('Authority locus for shorthand create-site planning.'),
    output_plan: stringSchema('Optional path to write the dry-run plan JSON artifact.'),
  };
}

function mutationProperties() {
  return {
    execute: booleanSchema('Perform the mutation. Omit or false returns a plan/refusal where supported.'),
    mutation_authorized: booleanSchema('Explicit mutation authorization alias for execute.'),
    authority_basis: { type: 'object', description: 'Required authority basis for mutation tools.', additionalProperties: true },
  };
}

function stringSchema(description: string) { return { type: 'string', description }; }
function booleanSchema(description: string) { return { type: 'boolean', description }; }
function numberSchema(description: string) { return { type: 'number', description }; }

function asRecord(value: unknown): JsonRecord {
  return isPlainObject(value) ? value as JsonRecord : {};
}

function isPlainObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(args: JsonRecord, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw diagnosticError('required_string_missing', `required_string_missing:${key}`, { key });
  return value.trim();
}

function stripKeys(input: JsonRecord, keys: string[]): JsonRecord {
  const result = { ...input };
  for (const key of keys) delete result[key];
  return result;
}

function normalizePath(path: string) {
  return resolve(path).replace(/\\/g, '/');
}

function renderResult(result: JsonRecord) {
  return JSON.stringify(result, null, 2);
}

function diagnosticError(code: string, message: string, detail: JsonRecord = {}) {
  const error = new Error(message) as Error & { code?: string; detail?: JsonRecord };
  error.code = code;
  error.detail = detail;
  return error;
}

function errorDiagnostic(error: unknown): JsonRecord {
  if (error instanceof Error) {
    const anyError = error as Error & { code?: string; detail?: JsonRecord };
    return { code: anyError.code ?? 'error', message: error.message, ...(anyError.detail ?? {}) };
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
    const bodyStart = headerEnd + separatorLength;
    const bodyEnd = bodyStart + Number(match[1]);
    if (remaining.length < bodyEnd) break;
    requests.push(JSON.parse(remaining.slice(bodyStart, bodyEnd)));
    remaining = remaining.slice(bodyEnd);
  }
  return { requests, remaining, framed: requests.length > 0 };
}

function drainJsonLines(buffer: string): { requests: JsonRecord[]; remaining: string; framed: boolean } {
  const requests: JsonRecord[] = [];
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) requests.push(JSON.parse(line));
  }
  return { requests, remaining, framed: false };
}

function writeJsonRpcResponse(response: JsonRecord, options: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (options.framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\n\n${body}`);
  else process.stdout.write(`${body}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const parsed = parseArgs(process.argv.slice(2));
  runStdioServer(parsed).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function parseArgs(argv: string[]): JsonRecord {
  const parsed: JsonRecord = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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
