#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'cloudflare-carrier-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const DEFAULT_REPO_ROOT = 'D:/code/narada';
const DEFAULT_PACKAGE_FILTER = '@narada2/cloudflare-carrier';
const DEFAULT_SESSION_FILE = '.narada/auth/cloudflare-operator-session.json';
const DEFAULT_WORKER_URL = 'https://narada-cloudflare-carrier.andrei-kokoev.workers.dev';
const DEFAULT_HEALTH_FILE = '.narada/site-continuity/health/cloudflare-continuity-health-last.json';

type JsonRecord = Record<string, unknown>;

type CloudflareCarrierState = {
  repoRoot: string;
  packageFilter: string;
  sessionFile: string;
  workerUrl: string;
  healthFile: string;
};

export function createServerState(options: JsonRecord = {}): CloudflareCarrierState {
  const repoRoot = String(options.repoRoot ?? options['repo_root'] ?? options['repo-root'] ?? DEFAULT_REPO_ROOT).replace(/\\/g, '/');
  return {
    repoRoot,
    packageFilter: String(options.packageFilter ?? options['package-filter'] ?? DEFAULT_PACKAGE_FILTER),
    sessionFile: String(options.sessionFile ?? options['session-file'] ?? resolve(repoRoot, DEFAULT_SESSION_FILE)).replace(/\\/g, '/'),
    workerUrl: String(options.workerUrl ?? options['worker-url'] ?? process.env.CLOUDFLARE_CARRIER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, ''),
    healthFile: String(options.healthFile ?? options['health-file'] ?? resolve(repoRoot, DEFAULT_HEALTH_FILE)).replace(/\\/g, '/'),
  };
}

export async function handleRequest(request: JsonRecord, state: CloudflareCarrierState) {
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

function dispatchMethod(method: string, params: JsonRecord, state: CloudflareCarrierState) {
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
    {
      name: 'cloudflare_product_read',
      description: 'Read the Cloudflare carrier product surface (site.list, site.read, operation.list, operation.read). Bakes in repo root, worker URL, and operator session file.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['site.list', 'site.read', 'operation.list', 'operation.read'], description: 'Product read operation. Defaults to site.list.' },
          site_id: { type: 'string', description: 'Site id. Required for site.read, operation.list, and operation.read.' },
          operation_id: { type: 'string', description: 'Operation id. Required for operation.read.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Result limit.' },
          format: { type: 'string', enum: ['json', 'summary', 'text'], description: 'Output format. Defaults to json.' },
          continuation: { type: 'boolean', description: 'Include needs_continuation operations. Only for operation.list.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'cloudflare_product_read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'cloudflare_session_status',
      description: 'Check the operator session file freshness and whether it contains a valid cookie.',
      inputSchema: {
        type: 'object',
        properties: {
          session_file: { type: 'string', description: 'Override the default operator session file path.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'cloudflare_session_status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'cloudflare_health',
      description: 'Read the Cloudflare continuity health snapshot and report local sync, inbound, scheduler, and Cloudflare product posture status.',
      inputSchema: {
        type: 'object',
        properties: {
          health_file: { type: 'string', description: 'Override the default health file path.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'cloudflare_health', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'cloudflare_doctor',
      description: 'Check Cloudflare carrier MCP readiness: operator session, health snapshot, and worker URL.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { title: 'cloudflare_doctor', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, state: CloudflareCarrierState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'cloudflare_carrier_guidance':
      result = buildGuidanceResult(args);
      break;
    case 'cloudflare_product_read': result = await cloudflareProductRead(args, state); break;
    case 'cloudflare_session_status': result = cloudflareSessionStatus(args, state); break;
    case 'cloudflare_health': result = cloudflareHealth(args, state); break;
    case 'cloudflare_doctor': result = cloudflareDoctor(state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

async function cloudflareProductRead(args: JsonRecord, state: CloudflareCarrierState): Promise<JsonRecord> {
  const operation = optionalString(args.operation) ?? 'site.list';
  const siteId = optionalString(args.site_id) ?? null;
  const operationId = optionalString(args.operation_id) ?? null;
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : undefined;
  const format = optionalString(args.format) ?? 'json';
  const continuation = args.continuation === true;

  const body: JsonRecord = { operation, request_id: `mcp_product_read_${Date.now()}` };
  if (siteId) body.params = { site_id: siteId };
  if (siteId && operationId) body.params = { ...(body.params as JsonRecord), operation_id: operationId };
  if (limit !== undefined) body.params = { ...(body.params as JsonRecord), limit };

  const auth = resolveSessionAuth(state.sessionFile);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) {
    headers.cookie = `narada_operator_session=${auth}`;
  }

  const response = await fetch(new URL('/api/carrier', state.workerUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const responseBody = parseJsonText(text);

  if (response.status < 200 || response.status >= 300) {
    throw diagnosticError('cloudflare_product_read_failed', `cloudflare_product_read_failed:${response.status}`, {
      status: response.status,
      code: responseBody?.code ?? responseBody?.error ?? null,
      body: responseBody,
    });
  }

  if (format === 'summary') {
    return {
      schema: 'narada.cloudflare_carrier_mcp.product_read.v1',
      status: 'ok',
      operation,
      worker_url: state.workerUrl,
      session_file: state.sessionFile,
      has_session: auth !== null,
      summary: summarizeProductResponse(operation, responseBody, continuation),
    };
  }

  return {
    schema: 'narada.cloudflare_carrier_mcp.product_read.v1',
    status: 'ok',
    operation,
    worker_url: state.workerUrl,
    session_file: state.sessionFile,
    has_session: auth !== null,
    response: responseBody,
    commands: buildProductCommands(operation, state),
  };
}

function cloudflareSessionStatus(args: JsonRecord, state: CloudflareCarrierState): JsonRecord {
  const sessionFile = optionalString(args.session_file) ?? state.sessionFile;
  const exists = existsSync(sessionFile);
  if (!exists) {
    return { status: 'missing', session_file: sessionFile, has_cookie: false, is_fresh: false };
  }
  const stat = statSync(sessionFile);
  const ageMs = Date.now() - stat.mtimeMs;
  const ageMinutes = Math.round(ageMs / 60000);
  try {
    const content = readFileSync(sessionFile, 'utf8');
    const session = JSON.parse(content);
    const hasCookie = typeof session?.cookie === 'string' && session.cookie.length > 0;
    return {
      status: hasCookie ? 'present' : 'incomplete',
      session_file: sessionFile,
      has_cookie: hasCookie,
      captured_at: session?.captured_at ?? null,
      worker_url: session?.worker_url ?? null,
      principal: session?.principal ?? null,
      age_minutes: ageMinutes,
      is_fresh: ageMinutes < 60,
      size_bytes: stat.size,
    };
  } catch {
    return { status: 'invalid_json', session_file: sessionFile, has_cookie: false, is_fresh: false, age_minutes: ageMinutes };
  }
}

function cloudflareHealth(args: JsonRecord, state: CloudflareCarrierState): JsonRecord {
  const healthFile = optionalString(args.health_file) ?? state.healthFile;
  if (!existsSync(healthFile)) {
    return { status: 'missing', health_file: healthFile };
  }
  try {
    const content = readFileSync(healthFile, 'utf8');
    const health = JSON.parse(content);
    const continuityHealth = health?.continuity_health ?? {};
    const cloudflarePosture = health?.cloudflare_product_posture ?? {};
    const bindingAlignment = health?.cloudflare_product_binding_alignment ?? {};
    const schedulerReadback = health?.scheduler_task_readback ?? {};

    return {
      schema: 'narada.cloudflare_carrier_mcp.health.v1',
      status: 'ok',
      generated_at: health?.generated_at ?? null,
      health_file: healthFile,
      local: {
        sync_status: continuityHealth?.local_sync_status ?? null,
        sync_artifacts: continuityHealth?.local_sync_artifact_count ?? 0,
        inbound_status: continuityHealth?.local_inbound_status ?? null,
        inbound_artifacts: continuityHealth?.local_inbound_artifact_count ?? 0,
        reconciliation_status: continuityHealth?.reconciliation_execution_status ?? null,
        reconciliation_plan: continuityHealth?.reconciliation_execution_plan_status ?? null,
      },
      scheduler: {
        task_state: schedulerReadback?.scheduled_task_state ?? null,
        last_run: schedulerReadback?.last_run_time ?? null,
        last_result: schedulerReadback?.last_result ?? null,
        next_run: schedulerReadback?.next_run_time ?? null,
        cadence: schedulerReadback?.cadence_status ?? null,
      },
      cloudflare: {
        posture_state: cloudflarePosture?.state ?? null,
        posture_status: cloudflarePosture?.status ?? null,
        site_count: cloudflarePosture?.site_product_overview?.site_count ?? 0,
        health_counts: cloudflarePosture?.site_product_overview?.health_counts ?? null,
        next_action: cloudflarePosture?.site_product_overview?.next_action ?? null,
        next_reason: cloudflarePosture?.site_product_overview?.next_reason ?? null,
      },
      alignment: {
        state: bindingAlignment?.state ?? null,
        status: bindingAlignment?.status ?? null,
        reason: bindingAlignment?.reason ?? null,
        local_site_count: bindingAlignment?.local_site_count ?? 0,
        cloudflare_next_action: bindingAlignment?.cloudflare_product_next_action ?? null,
      },
    };
  } catch (error) {
    throw diagnosticError('cloudflare_health_parse_failed', `cloudflare_health_parse_failed:${healthFile}`, { error: String(error) });
  }
}

function cloudflareDoctor(state: CloudflareCarrierState): JsonRecord {
  const sessionStatus = cloudflareSessionStatus({}, state);
  const healthFileExists = existsSync(state.healthFile);
  let healthStatus: string | null = null;
  if (healthFileExists) {
    try {
      const health = JSON.parse(readFileSync(state.healthFile, 'utf8'));
      healthStatus = health?.status ?? 'unknown';
    } catch {
      healthStatus = 'invalid_json';
    }
  }

  return {
    schema: 'narada.cloudflare_carrier_mcp.doctor.v1',
    status: 'ok',
    repo_root: state.repoRoot,
    package_filter: state.packageFilter,
    worker_url: state.workerUrl,
    session_file: state.sessionFile,
    session_status: sessionStatus.status,
    session_fresh: sessionStatus.is_fresh,
    health_file: state.healthFile,
    health_file_exists: healthFileExists,
    health_status: healthStatus ?? 'missing',
  };
}

function resolveSessionAuth(sessionFile: string): string | null {
  if (!existsSync(sessionFile)) return null;
  try {
    const session = JSON.parse(readFileSync(sessionFile, 'utf8'));
    const raw = session?.cookie ?? '';
    const match = /narada_operator_session=([^;]+)/.exec(String(raw));
    return match ? match[1] : raw || null;
  } catch {
    return null;
  }
}

function summarizeProductResponse(operation: string, body: JsonRecord, continuation: boolean): JsonRecord {
  if (operation === 'site.list') {
    const overview = body?.site_product_overview as JsonRecord ?? {};
    return {
      operation,
      site_count: overview?.site_count ?? 0,
      next_health: overview?.next_health ?? null,
      next_action: overview?.next_action ?? null,
      next_reason: overview?.next_reason ?? null,
      health_counts: overview?.health_counts ?? null,
    };
  }
  if (operation === 'site.read') {
    const status = (body?.site_product_status ?? body?.product_status ?? {}) as JsonRecord;
    return {
      operation,
      site_id: (body?.site as JsonRecord)?.site_id ?? body?.site_id ?? null,
      health: status?.health ?? null,
      next_action: status?.next_action ?? null,
      continuity_state: status?.continuity_state ?? null,
      continuity_loop_state: status?.continuity_loop_state ?? null,
      continuity_reconciliation_state: status?.continuity_reconciliation_execution_state ?? null,
    };
  }
  if (operation === 'operation.list') {
    const operations = Array.isArray(body?.operations) ? body.operations : [];
    const continuationOps = continuation ? operations.filter((o: JsonRecord) => o?.status === 'needs_continuation') : [];
    return {
      operation,
      operation_count: operations.length,
      needs_continuation_count: continuationOps.length,
      next_continuation_id: continuationOps[0]?.operation_id ?? null,
    };
  }
  if (operation === 'operation.read') {
    const lifecycle = (body?.operation_lifecycle_status ?? {}) as JsonRecord;
    return {
      operation,
      operation_id: (body?.operation as JsonRecord)?.operation_id ?? null,
      current_status: (body?.operation as JsonRecord)?.status ?? null,
      phase: lifecycle?.phase ?? null,
      health: lifecycle?.health ?? null,
      next_action: lifecycle?.next_action ?? null,
    };
  }
  return { operation };
}

function buildProductCommands(operation: string, state: CloudflareCarrierState): string[] {
  const base = `pnpm --filter ${state.packageFilter} product:${operation === 'site.read' ? 'site:read' : operation === 'operation.read' ? 'operation:read' : operation === 'operation.list' ? 'operation:list' : 'product:list'}:${'text'}`;
  const url = `--url ${state.workerUrl}`;
  const session = `--operator-session-file ${state.sessionFile}`;
  return [`${base} -- ${url} --site <site-id> ${session}`];
}

function renderResult(result: JsonRecord): string {
  if (result.operation !== undefined) {
    const lines = [`Cloudflare product read: ${result.operation}`, `Worker: ${result.worker_url ?? 'unknown'}`];
    if (result.summary) {
      const s = result.summary as JsonRecord;
      if (s.site_count !== undefined) lines.push(`Sites: ${s.site_count} next_action=${s.next_action ?? 'none'}`);
      if (s.site_id) lines.push(`Site: ${s.site_id} health=${s.health ?? 'unknown'} next=${s.next_action ?? 'none'}`);
    }
    if (result.has_session !== undefined) lines.push(`Session: ${result.has_session ? 'present' : 'missing'}`);
    return lines.join('\n');
  }
  if (result.session_file !== undefined && result.has_cookie !== undefined) {
    return `Session: ${result.status ?? 'unknown'} ${result.session_file} age=${result.age_minutes ?? '?'}min cookie=${result.has_cookie}`;
  }
  if (result.local !== undefined) {
    const l = result.local as JsonRecord;
    const c = result.cloudflare as JsonRecord;
    const a = result.alignment as JsonRecord;
    return [
      'Cloudflare Health',
      `Local: sync=${l.sync_status ?? '?'} inbound=${l.inbound_status ?? '?'}`,
      `Reconciliation: ${l.reconciliation_status ?? '?'} (${l.reconciliation_plan ?? '?'})`,
      `      Scheduler: ${(result.scheduler as JsonRecord)?.last_run ?? '?'} result=${(result.scheduler as JsonRecord)?.last_result ?? '?'}`,
      `Cloudflare: ${c.next_action ?? '?'} sites=${c.site_count ?? 0}`,
      `Alignment: ${a.state ?? '?'} — ${a.reason ?? ''}`,
    ].join('\n');
  }
  if (result.repo_root !== undefined) {
    return `Cloudflare carrier MCP: repo=${result.repo_root} worker=${result.worker_url} session=${result.session_status} health=${result.health_status}`;
  }
  return `cloudflare: ${result.status ?? 'ok'}`;
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
  return { schema: 'narada.cloudflare_carrier_mcp.error.v1', code: String(record.codeName ?? 'cloudflare_carrier_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
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

function parseJsonText(text: string): JsonRecord {
  try { return JSON.parse(text); } catch { return {}; }
}

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo-root') options.repoRoot = argv[++i];
    else if (arg === '--package-filter') options.packageFilter = argv[++i];
    else if (arg === '--session-file') options.sessionFile = argv[++i];
    else if (arg === '--worker-url') options.workerUrl = argv[++i];
    else if (arg === '--health-file') options.healthFile = argv[++i];
  }
  return options;
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
