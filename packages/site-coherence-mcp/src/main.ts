#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_NAME = 'site-coherence-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const DEFAULT_REPO_ROOT = 'D:/code/narada';
const DEFAULT_CONTINUITY_DIR = '.narada/site-continuity';
const DEFAULT_HEALTH_FILE = '.narada/site-continuity/health/cloudflare-continuity-health-last.json';
const DEFAULT_BINDINGS_FILE = '.narada/site-continuity/bindings.json';
const DEFAULT_SESSION_FILE = '.narada/auth/cloudflare-operator-session.json';
const DEFAULT_WORKER_URL = 'https://narada-cloudflare-carrier.andrei-kokoev.workers.dev';

type JsonRecord = Record<string, unknown>;

type SiteCoherenceState = {
  repoRoot: string;
  continuityDir: string;
  healthFile: string;
  bindingsFile: string;
  sessionFile: string;
  workerUrl: string;
};

export function createServerState(options: JsonRecord = {}): SiteCoherenceState {
  const repoRoot = String(options.repoRoot ?? options['repo-root'] ?? DEFAULT_REPO_ROOT).replace(/\\/g, '/');
  return {
    repoRoot,
    continuityDir: resolve(repoRoot, String(options.continuityDir ?? options['continuity-dir'] ?? DEFAULT_CONTINUITY_DIR)).replace(/\\/g, '/'),
    healthFile: resolve(repoRoot, String(options.healthFile ?? options['health-file'] ?? DEFAULT_HEALTH_FILE)).replace(/\\/g, '/'),
    bindingsFile: resolve(repoRoot, String(options.bindingsFile ?? options['bindings-file'] ?? DEFAULT_BINDINGS_FILE)).replace(/\\/g, '/'),
    sessionFile: resolve(repoRoot, String(options.sessionFile ?? options['session-file'] ?? DEFAULT_SESSION_FILE)).replace(/\\/g, '/'),
    workerUrl: String(options.workerUrl ?? options['worker-url'] ?? process.env.CLOUDFLARE_CARRIER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, ''),
  };
}

export async function handleRequest(request: JsonRecord, state: SiteCoherenceState) {
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

function dispatchMethod(method: string, params: JsonRecord, state: SiteCoherenceState) {
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
      name: 'site_coherence_check',
      description: 'Check site-level continuity coherence: read local health snapshot, query Cloudflare site.read for the given site, compare postures, and report mismatches. The primary tool for detecting gaps between local and Cloudflare embodiments.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Site id to check coherence for (e.g. site_live_smoke, site_narada_cloudflare). Required.' },
          fetch_cloudflare: { type: 'boolean', default: true, description: 'When true, calls Cloudflare site.read to get live posture. When false, only reads local state.' },
        },
        required: ['site_id'],
        additionalProperties: false,
      },
      annotations: { title: 'site_coherence_check', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'site_coherence_doctor',
      description: 'Check site coherence MCP readiness: health file, bindings, operator session, and worker URL.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { title: 'site_coherence_doctor', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, state: SiteCoherenceState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'site_coherence_guidance':
      result = buildGuidanceResult(args);
      break;
    case 'site_coherence_check': result = await siteCoherenceCheck(args, state); break;
    case 'site_coherence_doctor': result = siteCoherenceDoctor(state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

async function siteCoherenceCheck(args: JsonRecord, state: SiteCoherenceState): Promise<JsonRecord> {
  const siteId = requiredString(args.site_id, 'site_coherence_requires_site_id');
  const fetchCloudflare = args.fetch_cloudflare !== false;

  const localPosture = readLocalHealth(state.healthFile);

  if (!localPosture) {
    return {
      schema: 'narada.site_coherence.check.v1',
      status: 'missing_local',
      site_id: siteId,
      health_file: state.healthFile,
      local: null,
      cloudflare: null,
      coherence: { state: 'unknown', local_available: false, cloudflare_available: false },
      attention: ['local_health_snapshot_missing'],
    };
  }

  const localSiteSync = findSiteSync(state.continuityDir, siteId);
  const localPostureSummary = buildLocalPostureSummary(localPosture, localSiteSync, siteId);

  let cloudflareSiteRead: JsonRecord | null = null;
  let cloudflareError: JsonRecord | null = null;
  if (fetchCloudflare) {
    try {
      cloudflareSiteRead = await fetchCloudflareSiteRead(state, siteId);
    } catch (error) {
      cloudflareError = { message: error instanceof Error ? error.message : String(error) };
    }
  }

  const cloudflarePosture = cloudflareSiteRead
    ? buildCloudflarePostureSummary(cloudflareSiteRead, siteId)
    : null;

  const coherence = computeCoherence(localPostureSummary, cloudflarePosture, cloudflareError, fetchCloudflare, siteId);

  return {
    schema: 'narada.site_coherence.check.v1',
    status: 'ok',
    site_id: siteId,
    checked_at: new Date().toISOString(),
    local: localPostureSummary,
    cloudflare: cloudflarePosture,
    coherence,
  };
}

function readLocalHealth(healthFile: string): JsonRecord | null {
  if (!existsSync(healthFile)) return null;
  try {
    return JSON.parse(readFileSync(healthFile, 'utf8'));
  } catch {
    return null;
  }
}

function findSiteSync(continuityDir: string, siteId: string): JsonRecord | null {
  const syncFile = resolve(continuityDir, `${siteId}-cloudflare-sync.json`);
  if (!existsSync(syncFile)) return null;
  try {
    return JSON.parse(readFileSync(syncFile, 'utf8'));
  } catch {
    return null;
  }
}

function buildLocalPostureSummary(health: JsonRecord, siteSync: JsonRecord | null, siteId: string): JsonRecord {
  const continuityHealth = (health?.continuity_health ?? {}) as JsonRecord;
  const bindingAlignment = (health?.cloudflare_product_binding_alignment ?? {}) as JsonRecord;
  const schedulerReadback = (health?.scheduler_task_readback ?? {}) as JsonRecord;
  const cloudflarePosture = (health?.cloudflare_product_posture ?? {}) as JsonRecord;
  const overview = (cloudflarePosture?.site_product_overview ?? {}) as JsonRecord;

  return {
    schema: 'narada.site_coherence.local_posture.v1',
    site_id: siteId,
    health_file_exists: true,
    health_generated_at: health?.generated_at ?? health?.persisted_at ?? null,
    local_sync_status: continuityHealth?.local_sync_status ?? null,
    local_sync_artifacts: continuityHealth?.local_sync_artifact_count ?? 0,
    local_inbound_status: continuityHealth?.local_inbound_status ?? null,
    local_inbound_artifacts: continuityHealth?.local_inbound_artifact_count ?? 0,
    reconciliation_status: continuityHealth?.reconciliation_execution_status ?? null,
    reconciliation_plan: continuityHealth?.reconciliation_execution_plan_status ?? null,
    scheduler_task_state: schedulerReadback?.scheduled_task_state ?? null,
    scheduler_last_run: schedulerReadback?.last_run_time ?? null,
    scheduler_last_result: schedulerReadback?.last_result ?? null,
    scheduler_next_run: schedulerReadback?.next_run_time ?? null,
    scheduler_cadence: schedulerReadback?.cadence_status ?? null,
    overall_product_posture_state: cloudflarePosture?.state ?? null,
    overall_product_next_action: overview?.next_action ?? (cloudflarePosture?.site_posture_route as JsonRecord)?.next_action ?? null,
    binding_alignment_state: bindingAlignment?.state ?? null,
    binding_alignment_reason: bindingAlignment?.reason ?? null,
    has_site_sync: siteSync !== null,
    site_sync_status: siteSync?.status ?? null,
    site_sync_admission_action: (siteSync?.local_packet_admission as JsonRecord)?.action ?? null,
    cloudflare_admission_action: (siteSync?.cloudflare_packet_admission as JsonRecord)?.action ?? null,
  };
}

async function fetchCloudflareSiteRead(state: SiteCoherenceState, siteId: string): Promise<JsonRecord> {
  const auth = resolveSessionAuth(state.sessionFile);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.cookie = `narada_operator_session=${auth}`;

  const body: JsonRecord = {
    operation: 'site.read',
    request_id: `coherence_site_read_${Date.now()}`,
    params: { site_id: siteId },
  };

  const response = await fetch(new URL('/api/carrier', state.workerUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const bodyParsed = parseJsonText(text);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`site_read_failed:${response.status}:${bodyParsed?.code ?? 'unknown'}`);
  }

  return bodyParsed;
}

function buildCloudflarePostureSummary(response: JsonRecord, siteId: string): JsonRecord {
  const site = response?.site as JsonRecord ?? {};
  const status = (response?.site_product_status ?? response?.product_status ?? {}) as JsonRecord;

  return {
    schema: 'narada.site_coherence.cloudflare_posture.v1',
    site_id: siteId,
    site_record_available: !!response?.site,
    health: status?.health ?? null,
    next_action: status?.next_action ?? null,
    continuity_state: status?.continuity_state ?? null,
    continuity_direction_state: status?.continuity_direction_state ?? null,
    continuity_direction_missing: status?.continuity_direction_missing ?? null,
    continuity_loop_state: status?.continuity_loop_state ?? null,
    continuity_reconciliation_state: status?.continuity_reconciliation_execution_state ?? null,
    continuity_reconciliation_health: (status?.site_continuity_reconciliation_execution_status as JsonRecord)?.health ?? status?.continuity_reconciliation_execution_health ?? null,
    continuity_packet_count: status?.continuity_packet_count ?? 0,
    continuity_loop_report_count: status?.continuity_loop_report_count ?? 0,
    persistence_state: (status?.cloudflare_persistence_posture as JsonRecord)?.state ?? (response?.cloudflare_persistence_posture as JsonRecord)?.state ?? null,
    recovery_state: (status?.cloudflare_recovery_posture as JsonRecord)?.state ?? (response?.cloudflare_recovery_posture as JsonRecord)?.state ?? null,
    session_count: status?.session_count ?? 0,
    membership_count: Array.isArray(response?.memberships) ? response.memberships.length : 0,
    raw_next_action: status?.next_action ?? null,
  };
}

function computeCoherence(local: JsonRecord | null, cloudflare: JsonRecord | null, cloudflareError: JsonRecord | null, fetchRequested: boolean, siteId: string): JsonRecord {
  if (!local) return { state: 'unknown', mismatches: [], attention: ['local_unavailable'] };

  const mismatches: JsonRecord[] = [];
  const attention: string[] = [];

  if (!cloudflare && fetchRequested) {
    attention.push('cloudflare_unavailable');
    if (cloudflareError) attention.push(`cloudflare_error:${cloudflareError.message}`);
  }

  if (!cloudflare && fetchRequested) {
    return {
      state: 'degraded',
      site_id: siteId,
      mismatches,
      attention,
      local_next_action: local.overall_product_next_action,
      cloudflare_next_action: null,
      posture_agrees: false,
      diagnosis: 'cloudflare_site_read_unavailable_cannot_compare',
    };
  }

  if (!cloudflare) {
    return {
      state: 'local_only',
      site_id: siteId,
      mismatches,
      attention: [],
      local_next_action: local.overall_product_next_action,
      cloudflare_next_action: null,
      posture_agrees: null,
      diagnosis: 'cloudflare_not_queried',
    };
  }

  const localAction = local.overall_product_next_action ?? 'unknown';
  const cloudflareAction = cloudflare.next_action ?? 'unknown';

  if (cloudflareAction !== localAction) {
    mismatches.push({
      field: 'next_action',
      local: localAction,
      cloudflare: cloudflareAction,
      severity: 'mismatch',
      description: `Local product posture says '${localAction}' but Cloudflare site.read says '${cloudflareAction}' for site ${siteId}.`,
    });
  }

  const localContinuityOk = local.local_sync_status === 'synced' && local.local_inbound_status === 'synced';
  if (!localContinuityOk) {
    attention.push(`local_sync_degraded:sync=${local.local_sync_status}_inbound=${local.local_inbound_status}`);
  }

  const localSchedulerOk = local.scheduler_task_state === 'Enabled' && local.scheduler_last_result === '0' && local.scheduler_cadence === 'matches_plan';
  if (!localSchedulerOk) {
    attention.push(`scheduler_degraded:state=${local.scheduler_task_state}_result=${local.scheduler_last_result}_cadence=${local.scheduler_cadence}`);
  }

  const cloudflareContinuityOk = cloudflare.continuity_state === 'synced' || cloudflare.continuity_state === 'ready';
  if (!cloudflareContinuityOk && cloudflare.continuity_state !== null) {
    attention.push(`cloudflare_continuity:${cloudflare.continuity_state}`);
  }

  const postureAgrees = mismatches.length === 0 && attention.length === 0;

  return {
    state: postureAgrees ? 'coherent' : mismatches.length > 0 ? 'mismatch' : 'attention',
    site_id: siteId,
    mismatches,
    attention,
    local_next_action: localAction,
    cloudflare_next_action: cloudflareAction,
    posture_agrees: mismatches.length === 0,
    posture_attention: attention.length > 0,
    diagnosis: mismatches.length > 0
      ? `posture_mismatch:${mismatches.length}_fields_diverge`
      : attention.length > 0
        ? `attention_required:${attention.length}_issues`
        : 'posture_coherent',
  };
}

function siteCoherenceDoctor(state: SiteCoherenceState): JsonRecord {
  const healthExists = existsSync(state.healthFile);
  let healthStatus: string | null = null;
  let healthGeneratedAt: string | null = null;
  if (healthExists) {
    try {
      const health = JSON.parse(readFileSync(state.healthFile, 'utf8'));
      healthStatus = health?.status ?? 'unknown';
      healthGeneratedAt = health?.generated_at ?? null;
    } catch {
      healthStatus = 'invalid_json';
    }
  }

  const bindingsExist = existsSync(state.bindingsFile);
  let bindingsCount = 0;
  if (bindingsExist) {
    try {
      const bindings = JSON.parse(readFileSync(state.bindingsFile, 'utf8'));
      bindingsCount = Array.isArray(bindings?.bindings) ? bindings.bindings.length : 0;
    } catch { /* ignore */ }
  }

  const sessionExists = existsSync(state.sessionFile);
  let sessionHasCookie = false;
  if (sessionExists) {
    try {
      const session = JSON.parse(readFileSync(state.sessionFile, 'utf8'));
      sessionHasCookie = typeof session?.cookie === 'string' && session.cookie.length > 0;
    } catch { /* ignore */ }
  }

  return {
    schema: 'narada.site_coherence.doctor.v1',
    status: 'ok',
    repo_root: state.repoRoot,
    worker_url: state.workerUrl,
    health_file: state.healthFile,
    health_exists: healthExists,
    health_status: healthStatus,
    health_generated_at: healthGeneratedAt,
    bindings_file: state.bindingsFile,
    bindings_exist: bindingsExist,
    bindings_count: bindingsCount,
    session_file: state.sessionFile,
    session_exists: sessionExists,
    session_has_cookie: sessionHasCookie,
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

function renderResult(result: JsonRecord): string {
  if (result.schema === 'narada.site_coherence.check.v1') {
    const c = result.coherence as JsonRecord ?? {};
    const l = result.local as JsonRecord ?? {};
    const cf = result.cloudflare as JsonRecord ?? {};
    const lines = [
      `Site Coherence: ${result.site_id}`,
      `State: ${c.state ?? 'unknown'}`,
      `Posture agrees: ${c.posture_agrees ?? '?'}`,
      `Local next action: ${l.overall_product_next_action ?? 'unknown'}`,
      `Cloudflare next action: ${cf?.next_action ?? 'not queried'}`,
    ];
    if (c.diagnosis) lines.push(`Diagnosis: ${c.diagnosis}`);
    const mismatches = c.mismatches as JsonRecord[] | undefined;
    if (mismatches && mismatches.length > 0) {
      mismatches.forEach((m) => lines.push(`  Mismatch: ${m.field} local=${m.local} cloudflare=${m.cloudflare}`));
    }
    const attention = c.attention as string[] | undefined;
    if (attention && attention.length > 0) {
      attention.forEach((a) => lines.push(`  Attention: ${a}`));
    }
    return lines.join('\n');
  }
  if (result.schema === 'narada.site_coherence.doctor.v1') {
    return [
      `Site Coherence MCP: repo=${result.repo_root}`,
      `Health: ${result.health_exists ? result.health_status : 'missing'}`,
      `Bindings: ${result.bindings_count} sites`,
      `Session: ${result.session_exists && result.session_has_cookie ? 'present' : 'missing'}`,
    ].join('\n');
  }
  return `site_coherence: ${result.status ?? 'ok'}`;
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
  return { schema: 'narada.site_coherence.error.v1', code: String(record.codeName ?? 'site_coherence_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
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
    else if (arg === '--continuity-dir') options.continuityDir = argv[++i];
    else if (arg === '--health-file') options.healthFile = argv[++i];
    else if (arg === '--bindings-file') options.bindingsFile = argv[++i];
    else if (arg === '--session-file') options.sessionFile = argv[++i];
    else if (arg === '--worker-url') options.workerUrl = argv[++i];
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
