#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_SURFACES_ROOT = normalizePath(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages'));

const SERVER_NAME = 'mcp-loader-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120000;
const DEFAULT_ATTACH_TIMEOUT_MS = 30000;

const DEFAULT_ALLOWED_ENTRYPOINT_PREFIXES = [
  'D:/code/mcp-surfaces/packages/',
  '{site_root}/tools/',
];

const DEFAULT_ALLOWED_SITE_ROOTS = [
  'D:/code',
];

const DEFAULT_ALLOWED_ENV_VARS = [
  'NODE_OPTIONS',
  'PATH',
  'PROCESSOR_ARCHITECTURE',
  'SystemRoot',
];

type JsonRecord = Record<string, unknown>;

type LoaderPolicy = {
  allowedSiteRoots: string[];
  allowedEntrypointPrefixes: string[];
  allowedSurfaceIds: string[] | 'site_fabric';
  allowedEnvVars: string[];
  maxConnections: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  attachTimeoutMs: number;
  toolCallTimeoutMs: number;
};

type ChildConnection = {
  connectionId: string;
  siteRoot: string;
  surfaceId: string;
  entrypoint: string;
  args: string[];
  process: ChildProcess;
  pending: Map<number | string, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>;
  nextId: number;
  buffer: string;
  initialized: boolean;
  capabilities: JsonRecord;
  serverInfo: JsonRecord;
  toolSnapshot: JsonRecord[] | null;
  detached: boolean;
};

type LoaderState = {
  policy: LoaderPolicy;
  connections: Map<string, ChildConnection>;
};

export function createServerState(options: JsonRecord = {}): LoaderState {
  const rawAllowedSiteRoots = normalizeStringArray(options.allowedSiteRoots) ?? DEFAULT_ALLOWED_SITE_ROOTS;
  const rawAllowedPrefixes = normalizeStringArray(options.allowedEntrypointPrefixes) ?? DEFAULT_ALLOWED_ENTRYPOINT_PREFIXES;
  const rawAllowedSurfaces = normalizeStringArray(options.allowedSurfaceIds);
  const allowedSurfaceIds: string[] | 'site_fabric' = rawAllowedSurfaces && rawAllowedSurfaces.length > 0 ? rawAllowedSurfaces : 'site_fabric';
  const policy: LoaderPolicy = {
    allowedSiteRoots: rawAllowedSiteRoots.map((p) => normalizePath(p)),
    allowedEntrypointPrefixes: rawAllowedPrefixes.map((p) => normalizePath(p)).sort((a, b) => b.length - a.length),
    allowedSurfaceIds,
    allowedEnvVars: normalizeStringArray(options.allowedEnvVars) ?? DEFAULT_ALLOWED_ENV_VARS,
    maxConnections: integer(options.maxConnections, DEFAULT_MAX_CONNECTIONS, 1, 64),
    maxRequestBytes: integer(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 4096, 16 * 1024 * 1024),
    maxResponseBytes: integer(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 4096, 64 * 1024 * 1024),
    attachTimeoutMs: integer(options.attachTimeoutMs, DEFAULT_ATTACH_TIMEOUT_MS, 1000, 300000),
    toolCallTimeoutMs: integer(options.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS, 1000, 600000),
  };
  return { policy, connections: new Map() };
}

export async function handleRequest(request: JsonRecord, state: LoaderState) {
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

async function dispatchMethod(method: string, params: JsonRecord, state: LoaderState): Promise<JsonRecord> {
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
    tool('mcp_loader_policy_inspect', 'Inspect the policy governing runtime MCP surface loading.', {}, []),
    tool('mcp_loader_list_site_surfaces', 'List resolvable MCP surfaces declared in a site\'s local fabric.', {
      site_root: { type: 'string', description: 'Site root directory.' },
    }, ['site_root']),
    tool('mcp_loader_site_fabric_diagnostics', 'Inspect site MCP fabric provenance and classify shared-registry drift or intentional entrypoint overrides.', {
      site_root: { type: 'string', description: 'Site root directory.' },
    }, ['site_root']),
    tool('mcp_loader_attach_surface', 'Spawn and initialize a stdio MCP surface and return a connection id.', {
      site_root: { type: 'string', description: 'Site root directory.' },
      surface_id: { type: 'string', description: 'Surface identifier from the site fabric or shared surface registry.' },
      entrypoint: { type: 'string', description: 'Optional explicit entrypoint path; must be allowed by policy if provided.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional additional args appended after resolved args.' },
    }, ['site_root', 'surface_id']),
    tool('mcp_loader_list_tools', 'List tools exposed by an attached MCP surface.', {
      connection_id: { type: 'string', description: 'Connection id returned by mcp_loader_attach_surface.' },
    }, ['connection_id']),
    tool('mcp_loader_tool_discovery_manifest', 'Return canonical semantic tool names for an attached surface and flag generated aliases as non-authoritative.', {
      connection_id: { type: 'string', description: 'Connection id returned by mcp_loader_attach_surface.' },
    }, ['connection_id']),
    tool('mcp_loader_call_tool', 'Call a tool on an attached MCP surface.', {
      connection_id: { type: 'string', description: 'Connection id returned by mcp_loader_attach_surface.' },
      tool_name: { type: 'string', description: 'Tool name on the attached surface.' },
      arguments: { type: 'object', description: 'Arguments object for the tool call.' },
    }, ['connection_id', 'tool_name']),
    tool('mcp_loader_detach', 'Detach and terminate an attached MCP surface.', {
      connection_id: { type: 'string', description: 'Connection id returned by mcp_loader_attach_surface.' },
    }, ['connection_id']),
  ];
}

async function callTool(params: JsonRecord, state: LoaderState): Promise<JsonRecord> {
  const name = requiredString(params.name, 'missing_tool_name');
  const args = asRecord(params.arguments);
  switch (name) {
    case 'mcp_loader_policy_inspect':
      return policyInspect(state);
    case 'mcp_loader_list_site_surfaces':
      return listSiteSurfaces(args, state);
    case 'mcp_loader_site_fabric_diagnostics':
      return siteFabricDiagnostics(args, state);
    case 'mcp_loader_attach_surface':
      return attachSurface(args, state);
    case 'mcp_loader_list_tools':
      return listAttachedTools(args, state);
    case 'mcp_loader_tool_discovery_manifest':
      return toolDiscoveryManifest(args, state);
    case 'mcp_loader_call_tool':
      return callAttachedTool(args, state);
    case 'mcp_loader_detach':
      return detachConnection(args, state);
    default:
      throw diagnosticError('unknown_tool', `unknown_tool:${name}`);
  }
}

function policyInspect(state: LoaderState): JsonRecord {
  return { schema: 'narada.mcp_loader.policy.v1', policy: state.policy };
}

function listSiteSurfaces(args: JsonRecord, state: LoaderState): JsonRecord {
  const siteRoot = normalizePath(requiredString(args.site_root, 'missing_site_root'));
  ensureSiteRootAllowed(siteRoot, state.policy);
  const fabric = readSiteFabric(siteRoot);
  const servers = asRecord(fabric.mcpServers);
  const surfaces: JsonRecord[] = [];
  for (const [surfaceId, server] of Object.entries(servers)) {
    const rec = asRecord(server);
    surfaces.push({
      surface_id: surfaceId,
      command: rec.command,
      args: rec.args,
      env_vars: rec.env ? Object.keys(asRecord(rec.env)) : [],
    });
  }
  return { schema: 'narada.mcp_loader.site_surfaces.v1', site_root: siteRoot, surfaces };
}

function siteFabricDiagnostics(args: JsonRecord, state: LoaderState): JsonRecord {
  const siteRoot = normalizePath(requiredString(args.site_root, 'missing_site_root'));
  ensureSiteRootAllowed(siteRoot, state.policy);
  const fabricPath = resolve(siteRoot, '.ai', 'mcp', 'config.json');
  const fabric = readSiteFabric(siteRoot);
  const servers = asRecord(fabric.mcpServers);
  const diagnostics = Object.entries(servers).map(([surfaceId, server]) => {
    const rec = asRecord(server);
    const command = String(rec.command ?? '');
    const rawArgs = stringArray(rec.args) ?? [];
    const declaredEntrypoint = extractNodeEntrypoint(command, rawArgs);
    const shared = SHARED_SURFACE_REGISTRY[surfaceId];
    const expectedEntrypoint = shared ? normalizePath(shared.entrypoint.replace(/{site_root}/g, siteRoot)) : null;
    const normalizedDeclared = declaredEntrypoint ? normalizePath(declaredEntrypoint.replace(/{site_root}/g, siteRoot)) : null;
    const entrypointExists = normalizedDeclared ? existsSync(normalizedDeclared) : false;
    const classification = classifyFabricEntrypoint({
      siteRoot,
      declaredEntrypoint: normalizedDeclared,
      expectedEntrypoint,
      entrypointExists,
    });
    return {
      surface_id: surfaceId,
      source: 'site_fabric',
      config_path: fabricPath,
      command,
      args: rawArgs,
      declared_entrypoint: normalizedDeclared,
      shared_registry_entrypoint: expectedEntrypoint,
      entrypoint_exists: entrypointExists,
      classification: classification.status,
      durability: {
        local_repair_durable: 'unknown',
        reason: 'mcp-loader reads site fabric but does not own the generator or VCS ignore rules for this config.',
      },
      provenance: {
        config_source: 'site_root/.ai/mcp/config.json',
        shared_registry_source: shared ? '@narada2/mcp-loader-mcp embedded registry' : null,
        generator: typeof fabric.generated_by === 'string' ? fabric.generated_by : null,
        generated_at: typeof fabric.generated_at === 'string' ? fabric.generated_at : null,
        tracking_state: 'unknown',
        tracking_state_reason: 'VCS tracking and ignore state are outside mcp-loader authority.',
      },
      remediation: classification.remediation,
    };
  });
  const sharedFallbacks = Object.entries(SHARED_SURFACE_REGISTRY)
    .filter(([surfaceId]) => !servers[surfaceId])
    .map(([surfaceId, shared]) => ({
      surface_id: surfaceId,
      source: 'shared_registry_fallback',
      shared_registry_entrypoint: normalizePath(shared.entrypoint.replace(/{site_root}/g, siteRoot)),
      classification: 'registry_fallback_available',
      provenance: {
        shared_registry_source: '@narada2/mcp-loader-mcp embedded registry',
      },
    }));
  return {
    schema: 'narada.mcp_loader.site_fabric_diagnostics.v1',
    site_root: siteRoot,
    config_path: fabricPath,
    config_exists: existsSync(fabricPath),
    diagnostics,
    shared_registry_fallbacks: sharedFallbacks,
  };
}

async function attachSurface(args: JsonRecord, state: LoaderState): Promise<JsonRecord> {
  const siteRoot = normalizePath(requiredString(args.site_root, 'missing_site_root'));
  const surfaceId = requiredString(args.surface_id, 'missing_surface_id');
  ensureSiteRootAllowed(siteRoot, state.policy);
  ensureSurfaceAllowed(surfaceId, siteRoot, state.policy);

  if (state.connections.size >= state.policy.maxConnections) {
    throw diagnosticError('max_connections_reached', `max_connections_reached:${state.connections.size}`);
  }

  const explicitEntrypoint = optionalString(args.entrypoint);
  const extraArgs = stringArray(args.args);
  const { entrypoint, resolvedArgs } = await resolveSurfaceEntrypoint(siteRoot, surfaceId, explicitEntrypoint, extraArgs);
  ensureEntrypointAllowed(siteRoot, entrypoint, state.policy);

  if (!existsSync(entrypoint)) {
    throw diagnosticError('entrypoint_not_found', `entrypoint_not_found:${entrypoint}`);
  }

  const connectionId = randomUUID();
  const child = spawn(process.execPath, [entrypoint, ...resolvedArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildChildEnv(siteRoot, state.policy),
    shell: false,
    windowsHide: true,
  });

  const connection: ChildConnection = {
    connectionId,
    siteRoot,
    surfaceId,
    entrypoint,
    args: resolvedArgs,
    process: child,
    pending: new Map(),
    nextId: 1,
    buffer: '',
    initialized: false,
    capabilities: {},
    serverInfo: {},
    toolSnapshot: null,
    detached: false,
  };

  state.connections.set(connectionId, connection);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => handleChildStdout(chunk as string, connection));
  child.stderr?.on('data', (chunk) => {
    void chunk;
  });
  child.on('error', (error) => childError(connection, error));
  child.on('exit', () => cleanupConnection(connection));

  const initResult = await sendChildRequest(connection, 'initialize', { protocolVersion: PROTOCOL_VERSION }, state.policy.attachTimeoutMs);
  connection.initialized = true;
  connection.capabilities = asRecord(initResult.capabilities);
  connection.serverInfo = asRecord(initResult.serverInfo);
  await sendChildNotification(connection, 'notifications/initialized', {});

  const toolsResult = await sendChildRequest(connection, 'tools/list', {}, state.policy.attachTimeoutMs);
  connection.toolSnapshot = (toolsResult.tools as JsonRecord[]) ?? [];

  return {
    schema: 'narada.mcp_loader.surface_attached.v1',
    connection_id: connectionId,
    site_root: siteRoot,
    surface_id: surfaceId,
    entrypoint,
    args: resolvedArgs,
    server_info: connection.serverInfo,
    tools: connection.toolSnapshot,
  };
}

async function listAttachedTools(args: JsonRecord, state: LoaderState): Promise<JsonRecord> {
  const connection = getConnection(args, state);
  return {
    schema: 'narada.mcp_loader.tools.v1',
    connection_id: connection.connectionId,
    surface_id: connection.surfaceId,
    tools: connection.toolSnapshot ?? [],
  };
}

async function toolDiscoveryManifest(args: JsonRecord, state: LoaderState): Promise<JsonRecord> {
  const connection = getConnection(args, state);
  const tools = connection.toolSnapshot ?? [];
  return {
    schema: 'narada.mcp_loader.tool_discovery_manifest.v1',
    connection_id: connection.connectionId,
    surface_id: connection.surfaceId,
    alias_policy: {
      canonical_name_source: 'tools/list.name',
      generated_aliases_authoritative: false,
      guidance: 'Use canonical_name/callable_name for directives and tool calls. Client-generated aliases should be treated as compatibility UI labels only.',
    },
    tools: tools.map((tool) => {
      const record = asRecord(tool);
      const name = String(record.name ?? '');
      return {
        canonical_name: name,
        callable_name: name,
        generated_aliases: [],
        description: record.description ?? null,
        inputSchema: record.inputSchema ?? null,
      };
    }),
  };
}

async function callAttachedTool(args: JsonRecord, state: LoaderState): Promise<JsonRecord> {
  const connection = getConnection(args, state);
  const toolName = requiredString(args.tool_name, 'missing_tool_name');
  const toolArgs = asRecord(args.arguments);
  enforceRequestSize(toolArgs, state.policy.maxRequestBytes);
  const result = await sendChildRequest(connection, 'tools/call', { name: toolName, arguments: toolArgs }, state.policy.toolCallTimeoutMs);
  enforceResponseSize(result, state.policy.maxResponseBytes);
  return {
    schema: 'narada.mcp_loader.tool_result.v1',
    connection_id: connection.connectionId,
    surface_id: connection.surfaceId,
    result,
  };
}

function detachConnection(args: JsonRecord, state: LoaderState): JsonRecord {
  const connection = getConnection(args, state);
  terminateConnection(connection);
  state.connections.delete(connection.connectionId);
  return {
    schema: 'narada.mcp_loader.detached.v1',
    connection_id: connection.connectionId,
    surface_id: connection.surfaceId,
    status: 'detached',
  };
}

async function resolveSurfaceEntrypoint(siteRoot: string, surfaceId: string, explicitEntrypoint: string | null, extraArgs: string[] | null): Promise<{ entrypoint: string; resolvedArgs: string[] }> {
  if (explicitEntrypoint) {
    return { entrypoint: normalizePath(explicitEntrypoint), resolvedArgs: extraArgs ?? [] };
  }
  const fabric = readSiteFabric(siteRoot);
  const servers = asRecord(fabric.mcpServers);
  const server = servers[surfaceId];
  if (server) {
    const rec = asRecord(server);
    const command = String(rec.command ?? '');
    const rawArgs = stringArray(rec.args) ?? [];
    if (!command || !command.includes('main.js')) {
      throw diagnosticError('surface_command_unsupported', `surface_command_unsupported:${surfaceId}:${command}`);
    }
    const args = rawArgs.filter((a) => a !== '--site-root' && a !== siteRoot);
    const entrypoint = normalizePath(command.replace(/^node\s+--import\s+tsx\s+/i, '').replace(/^node\s+/i, ''));
    return { entrypoint, resolvedArgs: [...args, ...extraArgs ?? []] };
  }
  const shared = SHARED_SURFACE_REGISTRY[surfaceId];
  if (shared) {
    const entrypoint = normalizePath(shared.entrypoint.replace(/{site_root}/g, siteRoot));
    const args = shared.args.map((a) => a.replace(/{site_root}/g, siteRoot).replace(/{site_id}/g, deriveSiteId(siteRoot)));
    return { entrypoint, resolvedArgs: [...args, ...extraArgs ?? []] };
  }
  throw diagnosticError('surface_not_found', `surface_not_found:${surfaceId}`);
}

function extractNodeEntrypoint(command: string, args: string[]): string | null {
  const commandEntrypoint = command.replace(/^node\s+--import\s+tsx\s+/i, '').replace(/^node\s+/i, '').trim();
  if (commandEntrypoint && commandEntrypoint !== 'node') return commandEntrypoint;
  return args.find((arg) => /\.m?js$/i.test(arg) || /\.cjs$/i.test(arg)) ?? null;
}

function classifyFabricEntrypoint({ siteRoot, declaredEntrypoint, expectedEntrypoint, entrypointExists }: {
  siteRoot: string;
  declaredEntrypoint: string | null;
  expectedEntrypoint: string | null;
  entrypointExists: boolean;
}): { status: string; remediation: string[] } {
  if (!declaredEntrypoint) {
    return {
      status: 'entrypoint_unresolved',
      remediation: ['Inspect the site fabric command and args; mcp-loader could not determine the Node entrypoint.'],
    };
  }
  if (!entrypointExists) {
    return {
      status: 'stale_entrypoint',
      remediation: ['Repair or regenerate the site MCP fabric so the declared entrypoint exists before attach.'],
    };
  }
  if (expectedEntrypoint && declaredEntrypoint === expectedEntrypoint) {
    return {
      status: 'matches_shared_registry',
      remediation: [],
    };
  }
  if (isUnderPath(declaredEntrypoint, siteRoot)) {
    return {
      status: expectedEntrypoint ? 'site_local_override' : 'site_local_surface',
      remediation: ['Treat this as site-local authority; compare expected tools before replacing it with the shared registry entrypoint.'],
    };
  }
  if (expectedEntrypoint) {
    return {
      status: 'external_entrypoint_override',
      remediation: ['Classify as intentional override or drift at the fabric generator/registrar layer before local repair. Compare tool counts and authority implications against the shared registry entrypoint.'],
    };
  }
  return {
    status: 'external_site_declared_surface',
    remediation: ['Verify the external entrypoint authority and allowed-entrypoint policy before attach.'],
  };
}

function isUnderPath(child: string, parent: string): boolean {
  const normalizedChild = normalizePath(child);
  const normalizedParent = normalizePath(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

const SHARED_SURFACE_REGISTRY: Record<string, { entrypoint: string; args: string[] }> = {
  'local-filesystem': { entrypoint: `${MCP_SURFACES_ROOT}/local-filesystem-mcp/dist/src/main.js`, args: ['--mode', 'write', '--allowed-root', '{site_root}', '--output-root', '{site_root}'] },
  'structured-command': { entrypoint: `${MCP_SURFACES_ROOT}/structured-command-mcp/dist/src/main.js`, args: ['--allowed-root', '{site_root}', '--allow-command', 'node', '--allow-command', 'pnpm', '--allow-command', 'npm'] },
  'git': { entrypoint: `${MCP_SURFACES_ROOT}/git-mcp/dist/src/main.js`, args: ['--allowed-root', '{site_root}', '--mode', 'write'] },
  'completion-audit': { entrypoint: `${MCP_SURFACES_ROOT}/completion-audit-mcp/dist/src/main.js`, args: ['--audit-root', '{site_root}'] },
  'site-inbox': { entrypoint: '{site_root}/tools/typed-mcp/inbox-mcp-server.mjs', args: ['--site-root', '{site_root}'] },
  'mailbox': { entrypoint: `${MCP_SURFACES_ROOT}/mailbox-mcp/dist/src/main.js`, args: ['--site-root', '{site_root}'] },
  'graph-mail': { entrypoint: `${MCP_SURFACES_ROOT}/graph-mail-mcp/dist/src/main.js`, args: ['--site-root', '{site_root}'] },
  'task-lifecycle': { entrypoint: '{site_root}/tools/task-lifecycle/task-mcp-server.mjs', args: ['--site-root', '{site_root}'] },
  'site-ops': { entrypoint: '{site_root}/tools/site-ops/site-ops-mcp-server.mjs', args: ['--site-root', '{site_root}'] },
  'agent-context': { entrypoint: `${MCP_SURFACES_ROOT}/agent-context-mcp/dist/src/main.js`, args: ['--site-root', '{site_root}'] },
  'worker-delegation': { entrypoint: `${MCP_SURFACES_ROOT}/worker-delegation-mcp/dist/src/main.js`, args: ['--allowed-root', '{site_root}', '--run-root', '{site_root}/.narada/runtime/worker-delegation'] },
  'delegated-task': { entrypoint: `${MCP_SURFACES_ROOT}/delegated-task-mcp/dist/src/main.js`, args: ['--task-root', '{site_root}', '--allowed-root', '{site_root}'] },
  'sop': { entrypoint: `${MCP_SURFACES_ROOT}/sop-mcp/dist/src/main.js`, args: ['--sop-root', '{site_root}', '--server-name', '{site_id}-sop'] },
  'scheduler': { entrypoint: `${MCP_SURFACES_ROOT}/scheduler-mcp/dist/src/main.js`, args: [] },
  'mcp-registrar': { entrypoint: `${MCP_SURFACES_ROOT}/mcp-registrar/dist/src/main.js`, args: [] },
  'surface-feedback': { entrypoint: `${MCP_SURFACES_ROOT}/surface-feedback-mcp/dist/src/main.js`, args: ['--feedback-root', '{site_root}'] },
  'speech': { entrypoint: `${MCP_SURFACES_ROOT}/speech-mcp/dist/src/main.js`, args: [] },
  'cloudflare-carrier': { entrypoint: `${MCP_SURFACES_ROOT}/cloudflare-carrier-mcp/dist/src/main.js`, args: ['--site-root', '{site_root}'] },
  'site-coherence': { entrypoint: `${MCP_SURFACES_ROOT}/site-coherence-mcp/dist/src/main.js`, args: ['--site-root', '{site_root}'] },
  'site-lifecycle': { entrypoint: `${MCP_SURFACES_ROOT}/site-lifecycle-mcp/dist/src/main.js`, args: ['--narada-root', 'D:/code/narada'] },
};

function readSiteFabric(siteRoot: string): JsonRecord {
  const fabricPath = resolve(siteRoot, '.ai', 'mcp', 'config.json');
  if (!existsSync(fabricPath)) {
    throw diagnosticError('site_fabric_not_found', `site_fabric_not_found:${fabricPath}`);
  }
  try {
    return JSON.parse(readFileSync(fabricPath, 'utf8'));
  } catch (error) {
    throw diagnosticError('site_fabric_parse_error', `site_fabric_parse_error:${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildChildEnv(siteRoot: string, policy: LoaderPolicy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of policy.allowedEnvVars) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.SITE_ROOT = siteRoot;
  return env;
}

function ensureSiteRootAllowed(siteRoot: string, policy: LoaderPolicy) {
  const realSiteRoot = normalizePath(siteRoot);
  for (const allowed of policy.allowedSiteRoots) {
    if (realSiteRoot === allowed || realSiteRoot.startsWith(allowed + '/')) return;
  }
  throw diagnosticError('site_root_not_allowed', `site_root_not_allowed:${siteRoot}`);
}

function ensureSurfaceAllowed(surfaceId: string, siteRoot: string, policy: LoaderPolicy) {
  if (policy.allowedSurfaceIds === 'site_fabric') {
    const fabric = readSiteFabric(siteRoot);
    const servers = asRecord(fabric.mcpServers);
    if (servers[surfaceId]) return;
    if (SHARED_SURFACE_REGISTRY[surfaceId]) return;
    throw diagnosticError('surface_not_allowed', `surface_not_allowed:${surfaceId}`);
  }
  if (!policy.allowedSurfaceIds.includes(surfaceId)) {
    throw diagnosticError('surface_not_allowed', `surface_not_allowed:${surfaceId}`);
  }
}

function ensureEntrypointAllowed(siteRoot: string, entrypoint: string, policy: LoaderPolicy) {
  const realEntrypoint = normalizePath(entrypoint);
  const resolvedSiteRoot = normalizePath(siteRoot);
  for (const prefix of policy.allowedEntrypointPrefixes) {
    const expanded = prefix.replace(/{site_root}/g, resolvedSiteRoot);
    if (realEntrypoint === expanded || realEntrypoint.startsWith(expanded)) return;
  }
  throw diagnosticError('entrypoint_not_allowed', `entrypoint_not_allowed:${entrypoint}`);
}

function getConnection(args: JsonRecord, state: LoaderState): ChildConnection {
  const connectionId = requiredString(args.connection_id, 'missing_connection_id');
  const connection = state.connections.get(connectionId);
  if (!connection) throw diagnosticError('connection_not_found', `connection_not_found:${connectionId}`);
  return connection;
}

async function sendChildRequest(connection: ChildConnection, method: string, params: JsonRecord, timeoutMs: number): Promise<JsonRecord> {
  if (connection.detached) throw diagnosticError('connection_detached', `connection_detached:${connection.connectionId}`);
  const id = connection.nextId++;
  const message = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.pending.delete(id);
      reject(diagnosticError('child_timeout', `child_timeout:${method}:${timeoutMs}ms`));
    }, timeoutMs);
    connection.pending.set(id, { resolve, reject, timeout });
    writeToChild(connection, message);
  });
}

async function sendChildNotification(connection: ChildConnection, method: string, params: JsonRecord): Promise<void> {
  if (connection.detached) return;
  writeToChild(connection, { jsonrpc: '2.0', method, params });
}

function writeToChild(connection: ChildConnection, message: JsonRecord) {
  const body = JSON.stringify(message);
  const stdin = connection.process.stdin;
  if (!stdin || stdin.destroyed) {
    throw diagnosticError('child_stdin_closed', `child_stdin_closed:${connection.connectionId}`);
  }
  stdin.write(`${body}\n`);
}

function handleChildStdout(chunk: string, connection: ChildConnection) {
  connection.buffer += chunk;
  const drained = connection.buffer.includes('Content-Length:') ? drainJsonRpcFrames(connection.buffer) : drainJsonLines(connection.buffer);
  connection.buffer = drained.remaining;
  for (const message of drained.requests) {
    const id = Number(message.id);
    if (Number.isFinite(id)) {
      const pending = connection.pending.get(id);
      if (pending) {
        connection.pending.delete(id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(String((message.error as JsonRecord).message ?? 'child_error')));
        else pending.resolve(asRecord(message.result));
      }
    }
  }
}

function childError(connection: ChildConnection, error: Error) {
  for (const [_, pending] of connection.pending) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  connection.pending.clear();
}

function cleanupConnection(connection: ChildConnection) {
  connection.detached = true;
  for (const [_, pending] of connection.pending) {
    clearTimeout(pending.timeout);
    pending.reject(diagnosticError('child_exited', 'child_exited'));
  }
  connection.pending.clear();
}

function terminateConnection(connection: ChildConnection) {
  connection.detached = true;
  const proc = connection.process;
  if (!proc.killed && proc.exitCode === null) {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL');
    }, 5000);
  }
}

function enforceRequestSize(args: JsonRecord, maxBytes: number) {
  const size = Buffer.byteLength(JSON.stringify(args), 'utf8');
  if (size > maxBytes) throw diagnosticError('request_too_large', `request_too_large:${size}:${maxBytes}`);
}

function enforceResponseSize(result: JsonRecord, maxBytes: number) {
  const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (size > maxBytes) throw diagnosticError('response_too_large', `response_too_large:${size}:${maxBytes}`);
}

function tool(name: string, description: string, properties: JsonRecord, required: string[]) {
  return {
    name,
    description,
    annotations: {
      title: name,
      readOnlyHint: name === 'mcp_loader_policy_inspect' || name === 'mcp_loader_list_site_surfaces' || name === 'mcp_loader_site_fabric_diagnostics' || name === 'mcp_loader_list_tools',
      destructiveHint: name === 'mcp_loader_detach',
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: { type: 'object', properties, additionalProperties: false, required },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, '/');
}

function deriveSiteId(siteRoot: string): string {
  const parts = siteRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? 'site';
  return last.replace(/^narada\./, '').replace(/^narada-/, '');
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

function stringArray(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.map((v) => String(v));
  return null;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function requiredString(value: unknown, code: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code);
  return text;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? clamp(Math.trunc(parsed), min, max) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return { schema: 'narada.mcp_loader.error.v1', code: String(record.codeName ?? 'mcp_loader_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
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

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  else process.stdout.write(`${body}\n`);
}

export function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  let i = 0;
  const collect = (key: string) => {
    if (!options[key]) options[key] = [] as string[];
    (options[key] as string[]).push(argv[++i]);
  };
  for (i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allowed-site-root') collect('allowedSiteRoots');
    else if (arg === '--allowed-entrypoint-prefix') collect('allowedEntrypointPrefixes');
    else if (arg === '--allowed-surface-id') collect('allowedSurfaceIds');
    else if (arg === '--allowed-env-var') collect('allowedEnvVars');
    else if (arg === '--max-connections') options.maxConnections = argv[++i];
    else if (arg === '--max-request-bytes') options.maxRequestBytes = argv[++i];
    else if (arg === '--max-response-bytes') options.maxResponseBytes = argv[++i];
    else if (arg === '--attach-timeout-ms') options.attachTimeoutMs = argv[++i];
    else if (arg === '--tool-call-timeout-ms') options.toolCallTimeoutMs = argv[++i];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
