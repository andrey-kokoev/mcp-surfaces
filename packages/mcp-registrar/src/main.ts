#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'mcp-registrar';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

type JsonRecord = Record<string, unknown>;

type SurfaceDef = {
  id: string;
  package: string;
  entrypoint: string;
  kind: string;
  args: string[];
  tools: string[];
  env_vars?: string[];
  sops_dir?: string;
};

type SiteDef = {
  site_id: string;
  root: string;
  surfaces: string[];
};

type CarrierDef = {
  carrier_id: string;
  kind: string;
  config_path: string;
  surfaces: string[];
};

const MCP_SURFACES_ROOT = 'D:/code/mcp-surfaces/packages';

const SURFACES: SurfaceDef[] = [
  {
    id: 'local-filesystem', package: 'local-filesystem-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/local-filesystem-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--mode', 'write', '--allowed-root', '{site_root}', '--output-root', '{site_root}'],
    tools: ['fs_read_file', 'fs_read_file_range', 'fs_stat', 'fs_glob_search', 'fs_grep_search', 'mcp_output_show', 'fs_write_file', 'fs_str_replace_file', 'fs_replace_range', 'fs_apply_patch', 'fs_move_path', 'fs_create_directory', 'fs_rename_directory', 'fs_delete_directory'],
  },
  {
    id: 'structured-command', package: 'structured-command-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/structured-command-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-root', '{site_root}', '--allow-command', 'node', '--allow-command', 'pnpm', '--allow-command', 'npm', '--allow-command', 'git'],
    tools: ['structured_command_execution_policy_inspect', 'structured_command_output_show', 'structured_command_execute', 'structured_command_input_create'],
  },
  {
    id: 'git', package: 'git-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/git-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-root', '{site_root}', '--mode', 'write'],
    tools: ['git_policy_inspect', 'git_status', 'git_diff', 'git_log', 'git_show', 'mcp_output_show', 'git_add', 'git_commit', 'git_push'],
  },
  {
    id: 'completion-audit', package: 'completion-audit-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/completion-audit-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--audit-root', '{site_root}'],
    tools: ['completion_audit_record'],
  },
  {
    id: 'inbox', package: 'site-inbox-mcp',
    entrypoint: '{site_root}/tools/inbox/inbox-mcp-server.mjs',
    kind: 'site_tool',
    args: ['--site-root', '{site_root}'],
    tools: ['inbox_doctor', 'inbox_list', 'inbox_show', 'inbox_submit', 'inbox_next', 'capa_queue', 'capability_next'],
  },
  {
    id: 'mailbox', package: 'mailbox-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/mailbox-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['mailbox_doctor', 'mailbox_accounts_list', 'mailbox_messages_list', 'mailbox_message_show', 'mailbox_search', 'mailbox_thread_show'],
  },
  {
    id: 'graph-mail', package: 'graph-mail-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/graph-mail-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['graph_mail_doctor', 'graph_mail_query', 'graph_mail_message_show', 'graph_mail_draft_create', 'graph_mail_reply_draft_create', 'graph_mail_reply_all_draft_create', 'graph_mail_forward_draft_create', 'graph_mail_draft_update', 'graph_mail_draft_discard', 'graph_mail_draft_send'],
  },
  {
    id: 'task-lifecycle', package: 'task-lifecycle-mcp',
    entrypoint: '{site_root}/tools/task-lifecycle/task-mcp-server.mjs',
    kind: 'site_tool',
    args: ['--site-root', '{site_root}'],
    tools: ['task_lifecycle_doctor'],
  },
  {
    id: 'agent-context', package: 'agent-context-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/agent-context-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--site-root', '{site_root}'],
    tools: ['agent_context_doctor', 'agent_context_whoami', 'agent_context_start_session', 'agent_context_checkpoint', 'agent_context_rehydrate', 'agent_context_hydrate_current', 'agent_context_startup_sequence'],
  },
  {
    id: 'worker-delegation', package: 'worker-delegation-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/worker-delegation-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--allowed-root', '{site_root}', '--run-root', '{site_root}/.narada/runtime/worker-delegation'],
    tools: ['worker_policy_inspect', 'worker_output_show', 'worker_run', 'worker_edit', 'worker_resume'],
  },
  {
    id: 'delegated-task', package: 'delegated-task-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/delegated-task-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--task-root', '{site_root}', '--allowed-root', '{site_root}'],
    tools: ['delegated_task_policy_inspect', 'delegated_task_validate', 'delegated_task_run', 'delegated_task_status'],
  },
  {
    id: 'sop', package: 'sop-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/sop-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--sop-root', '{site_root}', '--server-name', '{site_id}-sop'],
    tools: ['sop_template_create', 'sop_template_show', 'sop_template_list', 'sop_template_search', 'sop_template_update', 'sop_template_deprecate', 'sop_template_import_yaml', 'sop_run_start', 'sop_run_status', 'sop_run_advance', 'sop_run_list', 'sop_run_cancel', 'sop_run_events'],
    sops_dir: `${MCP_SURFACES_ROOT}/sop-mcp/sops`,
  },
  {
    id: 'scheduler', package: 'scheduler-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/scheduler-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: ['scheduler_task_list', 'scheduler_task_show', 'scheduler_task_create', 'scheduler_task_delete', 'scheduler_task_enable', 'scheduler_task_disable', 'scheduler_task_run', 'scheduler_task_history'],
  },
  {
    id: 'mcp-registrar', package: 'mcp-registrar',
    entrypoint: `${MCP_SURFACES_ROOT}/mcp-registrar/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: ['registrar_surface_list', 'registrar_site_list', 'registrar_site_surfaces', 'registrar_site_bind', 'registrar_site_unbind', 'registrar_carrier_list', 'registrar_carrier_bind', 'registrar_carrier_unbind', 'registrar_sync'],
    sops_dir: `${MCP_SURFACES_ROOT}/mcp-registrar/sops`,
  },
  {
    id: 'surface-feedback', package: 'surface-feedback-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/surface-feedback-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--feedback-root', '{site_root}'],
    tools: ['surface_feedback_submit', 'surface_feedback_list', 'surface_feedback_show'],
  },
  {
    id: 'speech', package: 'speech-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/speech-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: [],
    tools: ['speech_speak', 'speech_voices'],
    env_vars: ['OPENAI_API_KEY'],
  },
  {
    id: 'cloudflare-carrier', package: 'cloudflare-carrier-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/cloudflare-carrier-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--repo-root', 'D:/code/narada', '--session-file', 'D:/code/narada/.narada/auth/cloudflare-operator-session.json'],
    tools: ['cloudflare_product_read', 'cloudflare_session_status', 'cloudflare_health', 'cloudflare_doctor'],
  },
  {
    id: 'site-coherence', package: 'site-coherence-mcp',
    entrypoint: `${MCP_SURFACES_ROOT}/site-coherence-mcp/dist/src/main.js`,
    kind: 'mcp_surface',
    args: ['--repo-root', 'D:/code/narada'],
    tools: ['site_coherence_check', 'site_coherence_doctor'],
  },
];

const KNOWN_SITES: SiteDef[] = [
  { site_id: 'narada-andrey', root: 'C:/Users/Andrey/Narada', surfaces: [] },
  { site_id: 'narada-proper', root: 'D:/code/narada', surfaces: [] },
  { site_id: 'narada-sonar', root: 'D:/code/narada.sonar', surfaces: [] },
  { site_id: 'narada-revolution', root: 'D:/code/narada.revolution', surfaces: [] },
  { site_id: 'narada-staccato', root: 'D:/code/narada.staccato', surfaces: [] },
  { site_id: 'narada-cpy', root: 'D:/code/narada.cpy', surfaces: [] },
  { site_id: 'narada-utz', root: 'D:/code/narada.utz', surfaces: [] },
  { site_id: 'narada-timour', root: 'D:/code/narada.timour-marketing-agent', surfaces: [] },
];

const CARRIERS: CarrierDef[] = [
  { carrier_id: 'opencode-sonar', kind: 'opencode', config_path: 'D:/code/narada.sonar/opencode.json', surfaces: [] },
  { carrier_id: 'kimi-andrey', kind: 'kimi', config_path: 'C:/Users/Andrey/.kimi-code/mcp.json', surfaces: [] },
  { carrier_id: 'codex-andrey', kind: 'codex', config_path: 'C:/Users/Andrey/.codex/config.toml', surfaces: [] },
];

type RegistrarState = JsonRecord;

export function createServerState(_options: JsonRecord = {}): RegistrarState {
  return {};
}

export async function handleRequest(request: JsonRecord, state: RegistrarState) {
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

async function dispatchMethod(method: string, params: JsonRecord, state: RegistrarState) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return await callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    {
      name: 'registrar_surface_list',
      description: 'List all known MCP surfaces with their packages, tools, and entrypoints.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'registrar_surface_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_list',
      description: 'List all known Narada sites with their root paths.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'registrar_site_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_surfaces',
      description: 'Show which surfaces are bound to a site.',
      inputSchema: { type: 'object', properties: { site_id: { type: 'string' } }, required: ['site_id'], additionalProperties: false },
      annotations: { title: 'registrar_site_surfaces', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_bind',
      description: 'Bind a surface to a Narada site MCP config. Creates or updates the site config file.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site identifier, e.g. narada-sonar.' },
          surface_id: { type: 'string', description: 'Surface identifier, e.g. scheduler.' },
        },
        required: ['site_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_bind', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_site_unbind',
      description: 'Remove a surface from a Narada site MCP config.',
      inputSchema: {
        type: 'object',
        properties: { site_id: { type: 'string' }, surface_id: { type: 'string' } },
        required: ['site_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_site_unbind', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_list',
      description: 'List all known carriers with their config paths.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'registrar_carrier_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_bind',
      description: 'Bind a surface to a carrier config (opencode, Kimi, or Codex).',
      inputSchema: {
        type: 'object',
        properties: {
          carrier_id: { type: 'string', description: 'Carrier identifier, e.g. codex-andrey.' },
          surface_id: { type: 'string', description: 'Surface identifier, e.g. scheduler.' },
          site_id: { type: 'string', description: 'Site context for arg interpolation, e.g. narada-sonar. Defaults to narada-andrey.' },
        },
        required: ['carrier_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_bind', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_carrier_unbind',
      description: 'Remove a surface from a carrier config.',
      inputSchema: {
        type: 'object',
        properties: { carrier_id: { type: 'string' }, surface_id: { type: 'string' } },
        required: ['carrier_id', 'surface_id'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_carrier_unbind', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'registrar_sync',
      description: 'Bind a surface to all sites/carriers, or bind all surfaces to carriers.',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string', description: 'Surface identifier. Required unless target is all_surfaces_to_carriers or all_surfaces_to_all_carriers.' },
          target: { type: 'string', enum: ['all_sites', 'all_carriers', 'all', 'all_surfaces_to_carriers', 'all_surfaces_to_all_carriers'], description: 'all_sites/all_carriers/all: bind one surface. all_surfaces_to_carriers: bind all surfaces to a specific carrier. all_surfaces_to_all_carriers: bind all surfaces to all carriers.' },
          carrier_id: { type: 'string', description: 'Required when target is all_surfaces_to_carriers.' },
          site_filter: { type: 'string', description: 'Optional prefix filter for site IDs, e.g. narada-.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
      annotations: { title: 'registrar_sync', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, _state: RegistrarState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'registrar_surface_list': result = registrarSurfaceList(args); break;
    case 'registrar_site_list': result = registrarSiteList(args); break;
    case 'registrar_site_surfaces': result = registrarSiteSurfaces(args); break;
    case 'registrar_site_bind': result = registrarSiteBind(args); break;
    case 'registrar_site_unbind': result = registrarSiteUnbind(args); break;
    case 'registrar_carrier_list': result = registrarCarrierList(args); break;
    case 'registrar_carrier_bind': result = registrarCarrierBind(args); break;
    case 'registrar_carrier_unbind': result = registrarCarrierUnbind(args); break;
    case 'registrar_sync': result = registrarSync(args); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function lookupSurface(surfaceId: string): SurfaceDef {
  const surface = SURFACES.find((s) => s.id === surfaceId);
  if (!surface) throw diagnosticError('registrar_unknown_surface', `registrar_unknown_surface:${surfaceId}`, { known: SURFACES.map((s) => s.id) });
  return surface;
}

function lookupSite(siteId: string): SiteDef {
  const site = KNOWN_SITES.find((s) => s.site_id === siteId);
  if (!site) throw diagnosticError('registrar_unknown_site', `registrar_unknown_site:${siteId}`, { known: KNOWN_SITES.map((s) => s.site_id) });
  return site;
}

function lookupCarrier(carrierId: string): CarrierDef {
  const carrier = CARRIERS.find((c) => c.carrier_id === carrierId);
  if (!carrier) throw diagnosticError('registrar_unknown_carrier', `registrar_unknown_carrier:${carrierId}`, { known: CARRIERS.map((c) => c.carrier_id) });
  return carrier;
}

function interpolateArgs(args: string[], siteId: string, siteRoot: string): string[] {
  return args.map((a) => interpolateArg(a, siteId, siteRoot));
}

function interpolateArg(value: string, siteId: string, siteRoot: string): string {
  return value.replace(/\{site_root\}/g, siteRoot).replace(/\{site_id\}/g, siteId);
}

function appendSopsDirs(args: string[]): string[] {
  for (const def of SURFACES) {
    if (def.sops_dir) {
      args.push('--sops-dir', def.sops_dir);
    }
  }
  return args;
}

function registrarSurfaceList(_args: JsonRecord): JsonRecord {
  return { items: SURFACES, count: SURFACES.length };
}

function registrarSiteList(_args: JsonRecord): JsonRecord {
  return { items: KNOWN_SITES, count: KNOWN_SITES.length };
}

function registrarSiteSurfaces(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const site = lookupSite(siteId);
  const configDir = join(site.root, '.ai', 'mcp');
  if (!existsSync(configDir)) return { site_id: siteId, surfaces: [], count: 0 };
  const files = readdirSync(configDir).filter((f: string) => f.endsWith('.json'));
  const allFound: string[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(configDir, file), 'utf8');
      const cfg = JSON.parse(content);
      const servers = asRecord(cfg.mcpServers);
      for (const surfaceId of SURFACES.map((s) => s.id)) {
        const key = `${siteId.replace('narada-', '')}-${surfaceId}`;
        if (servers[key] && !allFound.includes(surfaceId)) allFound.push(surfaceId);
      }
    } catch { /* skip */ }
  }
  return { site_id: siteId, surfaces: allFound, count: allFound.length };
}

function registrarSiteBind(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const site = lookupSite(siteId);
  const surface = lookupSurface(surfaceId);
  const configDir = join(site.root, '.ai', 'mcp');
  mkdirSync(configDir, { recursive: true });
  const serverKey = `${siteId.replace('narada-', '')}-${surfaceId}`;
  const fileName = `${siteId}-${surfaceId}-mcp.json`;
  const filePath = join(configDir, fileName);
  const resolvedArgs = interpolateArgs(surface.args, siteId, site.root);
  if (surfaceId === 'sop') appendSopsDirs(resolvedArgs);

  const config = {
    schema: 'narada.mcp.client_config.v0',
    site_id: siteId,
    description: `${surface.package} MCP surface bound by registrar.`,
    mcpServers: {
      [serverKey]: {
        transport: 'stdio',
        command: 'node',
        args: [surface.entrypoint, ...resolvedArgs],
        tools: surface.tools,
        env_vars: ['NARADA_AGENT_ID', 'NARADA_AGENT_START_EVENT_ID', 'NARADA_CARRIER_SESSION_ID', 'NARADA_SITE_ROOT', ...(surface.env_vars ?? [])],
        surface_id: `${surfaceId}-mcp.${siteId}`,
        authority_posture: 'site_local_mcp_surface',
      },
    },
  };
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { status: 'bound', site_id: siteId, surface_id: surfaceId, file: fileName, server_key: serverKey };
}

function registrarSiteUnbind(args: JsonRecord): JsonRecord {
  const siteId = requiredString(args.site_id, 'registrar_requires_site_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const site = lookupSite(siteId);
  const configDir = join(site.root, '.ai', 'mcp');
  if (!existsSync(configDir)) return { status: 'not_found', site_id: siteId, surface_id: surfaceId };
  const files = readdirSync(configDir).filter((f: string) => f.endsWith('.json'));
  const serverKey = `${siteId.replace('narada-', '')}-${surfaceId}`;
  let removed = 0;
  for (const file of files) {
    try {
      const content = readFileSync(join(configDir, file), 'utf8');
      const cfg = JSON.parse(content);
      const servers = asRecord(cfg.mcpServers);
      if (servers[serverKey]) {
        unlinkSync(join(configDir, file));
        removed++;
        return { status: 'unbound', site_id: siteId, surface_id: surfaceId, file };
      }
    } catch { /* skip */ }
  }
  return { status: 'not_bound', site_id: siteId, surface_id: surfaceId };
}

function registrarCarrierList(_args: JsonRecord): JsonRecord {
  return { items: CARRIERS, count: CARRIERS.length };
}

function registrarCarrierBind(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const carrier = lookupCarrier(carrierId);
  const surface = lookupSurface(surfaceId);
  const defaultSiteId = optionalString(args.site_id) ?? 'narada-andrey';
  const site = KNOWN_SITES.find((s) => s.site_id === defaultSiteId);
  const siteRoot = site ? site.root : defaultSiteId;

  const resolvedArgs = interpolateArgs(surface.args, defaultSiteId, siteRoot);
  const resolvedEntrypoint = interpolateArg(surface.entrypoint, defaultSiteId, siteRoot);
  if (surfaceId === 'sop') appendSopsDirs(resolvedArgs);

  switch (carrier.kind) {
    case 'opencode':
      return opencodeBind(carrier.config_path, surfaceId, resolvedEntrypoint, resolvedArgs);
    case 'kimi':
      return kimiBind(carrier.config_path, surfaceId, resolvedEntrypoint, resolvedArgs);
    case 'codex':
      return codexBind(carrier.config_path, surfaceId, resolvedEntrypoint, resolvedArgs);
    default:
      throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }
}

function registrarCarrierUnbind(args: JsonRecord): JsonRecord {
  const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id');
  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  const carrier = lookupCarrier(carrierId);
  switch (carrier.kind) {
    case 'opencode':
      return opencodeUnbind(carrier.config_path, surfaceId);
    case 'kimi':
      return kimiUnbind(carrier.config_path, surfaceId);
    case 'codex':
      return codexUnbind(carrier.config_path, surfaceId);
    default:
      throw diagnosticError('registrar_unknown_carrier_kind', `registrar_unknown_carrier_kind:${carrier.kind}`);
  }
}

function opencodeBind(configPath: string, surfaceId: string, entrypoint: string, resolvedArgs: string[]): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcp);
  const serverKey = `narada-sonar-${surfaceId}`;
  if (mcp[serverKey]) return { status: 'already_bound', carrier_id: 'opencode-sonar', surface_id: surfaceId, server_key: serverKey };
  mcp[serverKey] = {
    type: 'local',
    command: ['node', entrypoint, ...resolvedArgs],
    enabled: true,
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'bound', carrier_id: 'opencode-sonar', surface_id: surfaceId, server_key: serverKey };
}

function opencodeUnbind(configPath: string, surfaceId: string): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcp);
  const serverKey = `narada-sonar-${surfaceId}`;
  if (!mcp[serverKey]) return { status: 'not_bound', carrier_id: 'opencode-sonar', surface_id: surfaceId };
  delete mcp[serverKey];
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'unbound', carrier_id: 'opencode-sonar', surface_id: surfaceId, server_key: serverKey };
}

function kimiBind(configPath: string, surfaceId: string, entrypoint: string, resolvedArgs: string[]): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcpServers);
  const serverKey = `narada-andrey-${surfaceId}`;
  if (mcp[serverKey]) return { status: 'already_bound', carrier_id: 'kimi-andrey', surface_id: surfaceId, server_key: serverKey };
  mcp[serverKey] = {
    transport: 'stdio',
    command: 'node',
    args: [entrypoint, ...resolvedArgs],
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'bound', carrier_id: 'kimi-andrey', surface_id: surfaceId, server_key: serverKey };
}

function kimiUnbind(configPath: string, surfaceId: string): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  const content = readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(content);
  const mcp = asRecord(cfg.mcpServers);
  const serverKey = `narada-andrey-${surfaceId}`;
  if (!mcp[serverKey]) return { status: 'not_bound', carrier_id: 'kimi-andrey', surface_id: surfaceId };
  delete mcp[serverKey];
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { status: 'unbound', carrier_id: 'kimi-andrey', surface_id: surfaceId, server_key: serverKey };
}

function codexBind(configPath: string, surfaceId: string, entrypoint: string, resolvedArgs: string[]): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  let content = readFileSync(configPath, 'utf8');
  const sectionKey = `[mcp_servers.${surfaceId}]`;
  if (content.includes(sectionKey)) return { status: 'already_bound', carrier_id: 'codex-andrey', surface_id: surfaceId };
  content += `\n${sectionKey}\ncommand = "node"\nargs = ${JSON.stringify([entrypoint, ...resolvedArgs])}\n`;
  writeFileSync(configPath, content, 'utf8');
  return { status: 'bound', carrier_id: 'codex-andrey', surface_id: surfaceId };
}

function codexUnbind(configPath: string, surfaceId: string): JsonRecord {
  if (!existsSync(configPath)) throw diagnosticError('registrar_config_not_found', `registrar_config_not_found:${configPath}`);
  let content = readFileSync(configPath, 'utf8');
  const sectionKey = `[mcp_servers.${surfaceId}]`;
  if (!content.includes(sectionKey)) return { status: 'not_bound', carrier_id: 'codex-andrey', surface_id: surfaceId };
  const idx = content.indexOf(sectionKey);
  const nextSection = content.indexOf('\n[', idx + sectionKey.length);
  if (nextSection >= 0) {
    content = content.slice(0, idx) + content.slice(nextSection);
  } else {
    content = content.slice(0, idx).trimEnd();
  }
  writeFileSync(configPath, content, 'utf8');
  return { status: 'unbound', carrier_id: 'codex-andrey', surface_id: surfaceId, server_key: surfaceId };
}

function registrarSync(args: JsonRecord): JsonRecord {
  const target = requiredString(args.target, 'registrar_requires_target');
  const results: JsonRecord[] = [];

  if (target === 'all_surfaces_to_carriers') {
    const carrierId = requiredString(args.carrier_id, 'registrar_requires_carrier_id_for_target');
    lookupCarrier(carrierId);
    for (const surface of SURFACES) {
      try { results.push(registrarCarrierBind({ carrier_id: carrierId, surface_id: surface.id })); }
      catch (e) { results.push({ carrier_id: carrierId, surface_id: surface.id, error: e instanceof Error ? e.message : String(e) }); }
    }
    return { target, carrier_id: carrierId, results, count: results.length };
  }

  if (target === 'all_surfaces_to_all_carriers') {
    for (const carrier of CARRIERS) {
      for (const surface of SURFACES) {
        try { results.push(registrarCarrierBind({ carrier_id: carrier.carrier_id, surface_id: surface.id })); }
        catch (e) { results.push({ carrier_id: carrier.carrier_id, surface_id: surface.id, error: e instanceof Error ? e.message : String(e) }); }
      }
    }
    return { target, results, count: results.length };
  }

  const surfaceId = requiredString(args.surface_id, 'registrar_requires_surface_id');
  lookupSurface(surfaceId);
  if (target === 'all_sites' || target === 'all') {
    for (const site of KNOWN_SITES) {
      try { results.push(registrarSiteBind({ site_id: site.site_id, surface_id: surfaceId })); }
      catch (e) { results.push({ site_id: site.site_id, surface_id: surfaceId, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  if (target === 'all_carriers' || target === 'all') {
    for (const carrier of CARRIERS) {
      try { results.push(registrarCarrierBind({ carrier_id: carrier.carrier_id, surface_id: surfaceId })); }
      catch (e) { results.push({ carrier_id: carrier.carrier_id, surface_id: surfaceId, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return { surface_id: surfaceId, target, results, count: results.length };
}

function renderResult(result: JsonRecord): string {
  if (result.items !== undefined) return `registrar: ${result.count ?? 0} items\n${(result.items as JsonRecord[]).map((i) => `  ${i.id ?? i.site_id ?? i.carrier_id ?? ''}`).join('\n')}`;
  if (result.results) return `registrar sync: ${result.count ?? 0} results\n${(result.results as JsonRecord[]).map((r) => `  ${r.status ?? r.error ?? ''}`).join('\n')}`;
  return `${result.status ?? 'ok'}: ${result.surface_id ?? ''} @ ${result.site_id ?? result.carrier_id ?? ''}`;
}

function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
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
  return { schema: 'narada.registrar.error.v1', code: String(record.codeName ?? 'registrar_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  return { framed: false, remaining: lines.pop() ?? '', requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))) };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const match = /Content-Length:\s*(\d+)/i.exec(remaining.slice(0, headerEnd));
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

function parseArgs(_argv: string[]) {
  return {};
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
