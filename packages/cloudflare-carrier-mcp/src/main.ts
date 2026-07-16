#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'cloudflare-carrier-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const DEFAULT_REPO_ROOT = 'D:/code/narada';
const DEFAULT_PACKAGE_FILTER = '@narada2/cloudflare-carrier';
const DEFAULT_SESSION_FILE = '.narada/auth/cloudflare-operator-session.json';
const DEFAULT_WORKER_URL = 'https://narada-cloudflare-carrier.andrei-kokoev.workers.dev';
const DEFAULT_HEALTH_FILE = '.narada/site-continuity/health/cloudflare-continuity-health-last.json';
const DEFAULT_PROJECTION_REGISTRY_ROOT = resolve(DEFAULT_REPO_ROOT, '.narada/crew/nars-projections');

type JsonRecord = Record<string, unknown>;

type CloudflareCarrierState = {
  repoRoot: string;
  packageFilter: string;
  sessionFile: string;
  workerUrl: string;
  healthFile: string;
  projectionRegistryRoot: string;
  fetchImpl?: typeof fetch;
};

export function createServerState(options: JsonRecord = {}): CloudflareCarrierState {
  const repoRoot = String(options.repoRoot ?? options['repo_root'] ?? options['repo-root'] ?? DEFAULT_REPO_ROOT).replace(/\\/g, '/');
  const projectionRegistryRoot = String(
    options.projectionRegistryRoot
      ?? options['projection_registry_root']
      ?? options['projection-registry-root']
      ?? (options.siteRoot ?? options.site_root ? resolve(String(options.siteRoot ?? options.site_root), '.narada', 'crew', 'nars-projections') : null)
      ?? process.env.NARADA_CLOUDFLARE_PROJECTION_REGISTRY_ROOT
      ?? resolve(repoRoot, '.narada', 'crew', 'nars-projections')
      ?? DEFAULT_PROJECTION_REGISTRY_ROOT,
  ).replace(/\\/g, '/');
  return {
    repoRoot,
    packageFilter: String(options.packageFilter ?? options['package-filter'] ?? DEFAULT_PACKAGE_FILTER),
    sessionFile: String(options.sessionFile ?? options['session-file'] ?? resolve(repoRoot, DEFAULT_SESSION_FILE)).replace(/\\/g, '/'),
    workerUrl: String(options.workerUrl ?? options['worker-url'] ?? process.env.CLOUDFLARE_CARRIER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, ''),
    healthFile: String(options.healthFile ?? options['health-file'] ?? resolve(repoRoot, DEFAULT_HEALTH_FILE)).replace(/\\/g, '/'),
    projectionRegistryRoot,
    fetchImpl: typeof options.fetch_impl === 'function' ? options.fetch_impl as typeof fetch : undefined,
  };
}

function cloudflareDoctorOperatorAction(sessionStatus: JsonRecord): string | null {
  if (sessionStatus.status === 'missing') return 'run_pnpm_cloudflare_operator_login';
  if (sessionStatus.status === 'present' && sessionStatus.is_fresh === false) return 'run_pnpm_cloudflare_operator_login_then_cloudflare_operator_check_human';
  if (sessionStatus.has_cookie === false) return 'run_pnpm_cloudflare_operator_login_to_capture_cookie';
  return null;
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
      description: 'Check Cloudflare carrier MCP readiness: operator session, health snapshot, worker URL, and the server-bound projection registry.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { title: 'cloudflare_doctor', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'cloudflare_carrier_health',
      description: 'Read one projection and its explicitly registered Cloudflare carrier lineage as a bounded joined health result. A healthy projection never masks an unauthorized or unavailable carrier API.',
      inputSchema: {
        type: 'object',
        properties: {
          projection_id: { type: 'string', description: 'Projection id resolved from the server-bound projection registry.' },
        },
        required: ['projection_id'],
        additionalProperties: false,
      },
      annotations: { title: 'cloudflare_carrier_health', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    case 'cloudflare_carrier_health': result = await cloudflareCarrierHealth(args, state); break;
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

type ProjectionLineageStatus = 'matched' | 'unknown' | 'mismatched';
type ProjectionLifecycleState = 'active' | 'revoked' | 'expired';

interface ProjectionRegistryEntry {
  projectionId: string;
  siteId: string | null;
  narsSessionId: string | null;
  sourceRef: JsonRecord | null;
  lineageStatus: ProjectionLineageStatus;
  projectionApiBaseUrl: string | null;
  browserTokenFingerprint: string | null;
  lifecycleState: ProjectionLifecycleState;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface ProjectionRegistryResolution {
  status: 'ok' | 'missing' | 'refused';
  code?: string;
  entry?: ProjectionRegistryEntry;
}

function readJsonRecord(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
  } catch {
    return null;
  }
}

function normalizeHttpBaseUrl(value: unknown): string | null {
  const raw = optionalString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function legacyProjectionBaseUrl(value: unknown): string | null {
  const endpoint = normalizeHttpBaseUrl(value);
  const registrationSuffix = '/api/nars/projections/register';
  if (!endpoint || !endpoint.endsWith(registrationSuffix)) return null;
  return endpoint.slice(0, -registrationSuffix.length).replace(/\/+$/, '') || null;
}

function normalizeProjectionSourceRef(value: unknown, siteId: string | null): { status: ProjectionLineageStatus; sourceRef: JsonRecord | null } {
  if (value == null) return { status: 'unknown', sourceRef: null };
  const source = asRecord(value);
  if (source.kind !== 'cloudflare_carrier') return { status: 'mismatched', sourceRef: null };
  const carrierSessionId = optionalString(source.carrier_session_id);
  const operationId = optionalString(source.operation_id);
  if (!carrierSessionId && !operationId) return { status: 'mismatched', sourceRef: null };
  return {
    status: siteId ? 'matched' : 'mismatched',
    sourceRef: { kind: 'cloudflare_carrier', carrier_session_id: carrierSessionId, operation_id: operationId },
  };
}

function resolveProjectionRegistry(state: CloudflareCarrierState, projectionId: string, now: string): ProjectionRegistryResolution {
  if (!/^[A-Za-z0-9._-]+$/.test(projectionId)) return { status: 'refused', code: 'projection_id_invalid' };
  const projectionRoot = join(state.projectionRegistryRoot, projectionId);
  const intent = readJsonRecord(join(projectionRoot, 'intent.json'));
  const remoteAccess = readJsonRecord(join(projectionRoot, 'remote-access.json'));
  if (!intent && !remoteAccess) return { status: 'missing', code: 'projection_registry_entry_missing' };

  const siteId = optionalString(intent?.site_id) ?? optionalString(remoteAccess?.site_id);
  const narsSessionId = optionalString(intent?.nars_session_id) ?? optionalString(remoteAccess?.nars_session_id);
  const normalizedSource = normalizeProjectionSourceRef(intent?.source_ref ?? remoteAccess?.source_ref, siteId);
  let projectionApiBaseUrl = normalizeHttpBaseUrl(intent?.projection_api_base_url) ?? normalizeHttpBaseUrl(remoteAccess?.projection_api_base_url);
  if (!projectionApiBaseUrl) {
    const intentRegistration = asRecord(intent?.remote_registration);
    const remoteRegistration = asRecord(remoteAccess?.remote_registration);
    projectionApiBaseUrl = legacyProjectionBaseUrl(intentRegistration.endpoint) ?? legacyProjectionBaseUrl(remoteRegistration.endpoint);
  }

  const browserTokens = Array.isArray(remoteAccess?.browser_access_tokens) ? remoteAccess.browser_access_tokens : [];
  const browserToken = browserTokens
    .map((candidate) => asRecord(candidate))
    .find((candidate) => optionalString(candidate.kind) === 'browser'
      && optionalString(candidate.token_fingerprint)
      && (candidate.status == null || candidate.status === 'active'));
  const expiresAt = optionalString(remoteAccess?.expires_at) ?? optionalString(intent?.expires_at);
  const revokedAt = optionalString(remoteAccess?.revoked_at) ?? optionalString(intent?.revoked_at);
  const declaredLifecycle = optionalString(remoteAccess?.lifecycle_state) ?? optionalString(intent?.lifecycle_state);
  const lifecycleState: ProjectionLifecycleState = revokedAt || declaredLifecycle === 'revoked'
    ? 'revoked'
    : expiresAt && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.parse(now)
      ? 'expired'
      : 'active';

  return {
    status: 'ok',
    entry: {
      projectionId,
      siteId,
      narsSessionId,
      sourceRef: normalizedSource.sourceRef,
      lineageStatus: normalizedSource.status,
      projectionApiBaseUrl,
      browserTokenFingerprint: optionalString(browserToken?.token_fingerprint),
      lifecycleState,
      expiresAt,
      revokedAt,
    },
  };
}

async function fetchJsonRecord(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<{ status: number; body: JsonRecord }> {
  try {
    const response = await fetchImpl(url, { method: 'GET', headers });
    const value: unknown = await response.json().catch(() => null);
    return {
      status: response.status,
      body: value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {},
    };
  } catch {
    return { status: 0, body: {} };
  }
}

function projectionUnavailableStatus(status: number): string {
  if (status === 401 || status === 403) return 'projection_browser_access_refused';
  if (status === 0) return 'projection_unavailable';
  return `projection_http_${status}`;
}

async function cloudflareCarrierHealth(args: JsonRecord, state: CloudflareCarrierState): Promise<JsonRecord> {
  const projectionId = requiredString(args.projection_id, 'projection_id_required');
  const observedAt = new Date().toISOString();
  const registry = resolveProjectionRegistry(state, projectionId, observedAt);
  if (registry.status !== 'ok' || !registry.entry) {
    return {
      schema: 'narada.cloudflare_carrier_mcp.carrier_health.v1',
      status: registry.status === 'missing' ? 'missing' : 'refused',
      code: registry.code,
      carrier_api: { status: 'not_checked', site_id: null, operation_id: null, auth_source: null },
      projection: { status: 'not_checked', projection_id: projectionId, lineage_status: 'unknown', last_event_sequence: null, last_projected_at: null, observed_at: observedAt },
      next_action: registry.status === 'missing'
        ? 'Configure the server-bound projection registry root and ensure the projection registration exists.'
        : 'Use a valid projection id from the server-bound projection registry.',
    };
  }

  const entry = registry.entry;
  const projection: JsonRecord = {
    status: entry.lifecycleState === 'revoked' ? 'revoked' : entry.lifecycleState === 'expired' ? 'expired' : 'not_checked',
    projection_id: projectionId,
    lineage_status: entry.lineageStatus,
    last_event_sequence: null,
    last_projected_at: null,
    observed_at: observedAt,
  };
  const carrier: JsonRecord = {
    status: 'not_checked',
    site_id: entry.siteId,
    operation_id: optionalString(entry.sourceRef?.operation_id),
    auth_source: null,
  };

  if (entry.lifecycleState === 'active' && entry.projectionApiBaseUrl && entry.browserTokenFingerprint) {
    const browserHeaders = { 'x-narada-browser-token-fingerprint': entry.browserTokenFingerprint };
    const healthRead = await fetchJsonRecord(state.fetchImpl ?? fetch, `${entry.projectionApiBaseUrl}/api/nars/projections/${encodeURIComponent(projectionId)}/health`, browserHeaders);
    if (healthRead.status >= 200 && healthRead.status < 300 && healthRead.body.status === 'healthy') {
      projection.status = 'healthy';
      projection.last_event_sequence = typeof healthRead.body.last_event_sequence === 'number' ? healthRead.body.last_event_sequence : null;
      projection.last_projected_at = optionalString(healthRead.body.last_projected_at);
      if (projection.last_event_sequence === null || projection.last_projected_at === null) {
        const eventsRead = await fetchJsonRecord(state.fetchImpl ?? fetch, `${entry.projectionApiBaseUrl}/api/nars/projections/${encodeURIComponent(projectionId)}/events?direction=backward&max_events=1`, browserHeaders);
        const cursor = asRecord(eventsRead.body.cursor);
        const firstEvent = Array.isArray(eventsRead.body.events) ? asRecord(eventsRead.body.events[0]) : {};
        projection.last_event_sequence = projection.last_event_sequence ?? (typeof cursor.last_sequence === 'number' ? cursor.last_sequence : null);
        projection.last_projected_at = projection.last_projected_at ?? optionalString(firstEvent.projected_at);
      }
    } else {
      projection.status = 'unavailable';
      projection.code = projectionUnavailableStatus(healthRead.status);
    }
  } else if (entry.lifecycleState === 'active') {
    projection.status = 'unavailable';
    projection.code = entry.projectionApiBaseUrl ? 'projection_browser_credential_missing' : 'projection_api_base_url_missing';
  }

  if (projection.status === 'healthy' && entry.lineageStatus === 'matched' && entry.siteId) {
    const operationId = optionalString(entry.sourceRef?.operation_id);
    const operation = operationId ? 'operation.read' : 'site.read';
    const auth = resolveSessionAuth(state.sessionFile);
    const carrierHeaders: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) carrierHeaders.cookie = `narada_operator_session=${auth}`;
    const params: JsonRecord = { site_id: entry.siteId };
    if (operationId) params.operation_id = operationId;
    const carrierRead = await fetchJsonRecordPost(state.fetchImpl ?? fetch, new URL('/api/carrier', state.workerUrl).toString(), carrierHeaders, {
      operation,
      request_id: `mcp_carrier_health_${Date.now()}`,
      params,
    });
    carrier.auth_source = auth ? 'operator_session_file' : null;
    if (carrierRead.status >= 200 && carrierRead.status < 300) {
      carrier.status = 'ok';
      const productStatus = asRecord(carrierRead.body.site_product_status ?? carrierRead.body.product_status);
      carrier.product_health = optionalString(productStatus.health);
      carrier.next_action = optionalString(productStatus.next_action);
    } else if (carrierRead.status === 401) {
      carrier.status = 'unauthorized';
      carrier.next_action = 'run_pnpm_cloudflare_operator_login_then_cloudflare_operator_check_human';
    } else if (carrierRead.status === 403) {
      carrier.status = 'forbidden';
      carrier.next_action = 'inspect_cloudflare_carrier_site_membership';
    } else {
      carrier.status = 'unavailable';
      carrier.next_action = 'inspect_cloudflare_carrier_worker_and_network';
    }
  }

  let status: 'healthy' | 'degraded' | 'unverified';
  let code: string | undefined;
  let nextAction: string | null = null;
  if (projection.status === 'healthy') {
    if (entry.lineageStatus !== 'matched') {
      status = 'unverified';
      code = entry.lineageStatus === 'unknown' ? 'projection_lineage_unknown' : 'projection_lineage_mismatched';
      nextAction = 'Register the projection with an explicit Cloudflare carrier source reference before claiming joined health.';
    } else if (carrier.status === 'ok') {
      status = 'healthy';
    } else if (carrier.status === 'unauthorized') {
      status = 'degraded';
      code = 'carrier_api_unauthorized_projection_available';
      nextAction = 'run_pnpm_cloudflare_operator_login_then_cloudflare_operator_check_human';
    } else if (carrier.status === 'forbidden') {
      status = 'degraded';
      code = 'carrier_api_forbidden_projection_available';
      nextAction = 'inspect_cloudflare_carrier_site_membership';
    } else {
      status = 'degraded';
      code = 'carrier_api_unavailable_projection_available';
      nextAction = 'inspect_cloudflare_carrier_worker_and_network';
    }
  } else if (projection.status === 'revoked' || projection.status === 'expired') {
    status = 'degraded';
    code = `projection_${projection.status}`;
    nextAction = 'Re-register or renew the projection before using it as a live readback source.';
  } else {
    status = 'unverified';
    code = String(projection.code ?? 'projection_unavailable');
    nextAction = 'Repair projection readback before relying on joined carrier health.';
  }

  return {
    schema: 'narada.cloudflare_carrier_mcp.carrier_health.v1',
    status,
    ...(code ? { code } : {}),
    carrier_api: carrier,
    projection,
    next_action: nextAction,
  };
}

async function fetchJsonRecordPost(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, body: JsonRecord): Promise<{ status: number; body: JsonRecord }> {
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const value: unknown = await response.json().catch(() => null);
    return {
      status: response.status,
      body: value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {},
    };
  } catch {
    return { status: 0, body: {} };
  }
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
    operator_action: cloudflareDoctorOperatorAction(sessionStatus),
    health_file: state.healthFile,
    health_file_exists: healthFileExists,
    health_status: healthStatus ?? 'missing',
    projection_registry_root: state.projectionRegistryRoot,
    projection_registry_exists: existsSync(state.projectionRegistryRoot),
    projection_registry_status: existsSync(state.projectionRegistryRoot) ? 'ready' : 'missing',
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
  if (result.carrier_api !== undefined && result.projection !== undefined) {
    const carrier = result.carrier_api as JsonRecord;
    const projection = result.projection as JsonRecord;
    return [
      `Cloudflare carrier health: ${result.status ?? 'unknown'}${result.code ? ` (${result.code})` : ''}`,
      `Projection: ${projection.status ?? 'unknown'} lineage=${projection.lineage_status ?? 'unknown'} last_sequence=${projection.last_event_sequence ?? '?'}`,
      `Carrier API: ${carrier.status ?? 'unknown'} site=${carrier.site_id ?? '?'} auth=${carrier.auth_source ?? 'none'}`,
      `Next action: ${result.next_action ?? 'none'}`,
    ].join('\n');
  }
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
    else if (arg === '--projection-registry-root') options.projectionRegistryRoot = argv[++i];
    else if (arg === '--site-root') options.projectionRegistryRoot = resolve(argv[++i], '.narada', 'crew', 'nars-projections');
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
