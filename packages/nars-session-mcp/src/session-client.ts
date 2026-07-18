import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { resolveNaradaSitePaths } from '@narada2/site-paths';

export type JsonRecord = Record<string, unknown>;
export type DeliveryConstructor = 'send' | 'enqueue' | 'steer';

const INPUT_EVENT_SCHEMA = 'narada.carrier.input_event.v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_HEARTBEAT_FRESH_MS = 30_000;
const MAX_INLINE_CONTENT = 20_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const SEMANTIC_HEALTH_STATUSES = new Set(['starting', 'healthy', 'degraded', 'unhealthy', 'closing', 'unavailable']);

export class NarsSessionMcpError extends Error {
  readonly code: string;
  readonly details: JsonRecord;

  constructor(code: string, message = code, details: JsonRecord = {}) {
    super(message);
    this.name = 'NarsSessionMcpError';
    this.code = code;
    this.details = details;
  }
}

function semanticHealthStatus(value: JsonRecord, fallback: string): string {
  const status = optionalText(value.status)?.toLowerCase();
  return status && SEMANTIC_HEALTH_STATUSES.has(status) ? status : fallback;
}

type SessionRecord = JsonRecord & {
  session_id: string;
  site_id?: string | null;
  site_root?: string | null;
  event_endpoint?: string | null;
  health_endpoint?: string | null;
  authority_epoch?: number | null;
  authority_runtime_id?: string | null;
  source_write_admission?: string | null;
  heartbeat_path?: string | null;
  session_dir?: string | null;
  terminal_state?: string | null;
  superseded_by_session_id?: string | null;
};

type SessionAuthority = {
  siteId: string | null;
  siteRoot: string;
  sessionsRoot: string;
};

type BindingArgs = {
  projection?: string;
  userSiteRoot?: string;
  sourceKind?: string;
  operatorId?: string;
};

type ClientConfig = {
  env: NodeJS.ProcessEnv;
  scope: 'local_site' | 'user_site';
  siteRoot: string;
  siteId: string | null;
  sessionsRoot: string;
  authorities: SessionAuthority[];
  sourceKind: 'agent' | 'operator';
  sourceId: string;
  carrierSessionId: string | null;
  allowSteer: boolean;
  requestTimeoutMs: number;
  healthTimeoutMs: number;
  maxSessions: number;
};

export type NarsSessionClient = ReturnType<typeof createSessionClient>;

export function createSessionClient(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)) {
  return {
    siteRoot: () => configFromEnv(env, argv).siteRoot,
    guidance: () => ({ status: 'ok' as const }),
    list: (args: JsonRecord = {}) => listSessions(configFromEnv(env, argv), args),
    show: (args: JsonRecord = {}) => showSession(configFromEnv(env, argv), args),
    deliver: (args: JsonRecord = {}) => deliverSessionInput(configFromEnv(env, argv), args),
    status: (args: JsonRecord = {}) => inputStatus(configFromEnv(env, argv), args),
  };
}

function parseBindingArgs(argv: string[]): BindingArgs {
  const binding: BindingArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--projection' && value) binding.projection = value;
    else if (arg === '--user-site-root' && value) binding.userSiteRoot = value;
    else if (arg === '--source-kind' && value) binding.sourceKind = value;
    else if (arg === '--operator-id' && value) binding.operatorId = value;
    if (arg?.startsWith('--') && value) index += 1;
  }
  return binding;
}

function defaultUserSiteRoot(env: NodeJS.ProcessEnv): string {
  const profile = optionalText(env.USERPROFILE);
  if (!profile) throw new NarsSessionMcpError('user_site_root_required', 'User Site root is not configured');
  return join(profile, 'Narada');
}

function readUserSiteAuthorities(userSiteRoot: string, env: NodeJS.ProcessEnv): SessionAuthority[] {
  const registryPath = env.NARADA_SITE_REGISTRY_DB
    ? resolve(env.NARADA_SITE_REGISTRY_DB)
    : join(userSiteRoot, 'registry.db');
  if (!existsSync(registryPath)) {
    throw new NarsSessionMcpError('user_site_registry_required', 'User Site registry is not available', { registry_path: registryPath });
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(registryPath, { readOnly: true });
    const rows = db.prepare('SELECT site_id, site_root FROM site_registry ORDER BY created_at ASC, site_id ASC').all() as Array<{ site_id?: unknown; site_root?: unknown }>;
    const authorities = rows.flatMap((row) => {
      const siteId = optionalText(row.site_id);
      const siteRoot = optionalText(row.site_root);
      if (!siteId || !siteRoot) return [];
      const resolvedSiteRoot = resolve(siteRoot);
      return [{
        siteId,
        siteRoot: resolvedSiteRoot,
        sessionsRoot: resolveNaradaSitePaths({ siteRoot: resolvedSiteRoot }).narsSessionsRoot,
      } satisfies SessionAuthority];
    });
    if (authorities.length === 0) {
      throw new NarsSessionMcpError('user_site_registry_empty', 'User Site registry contains no admitted Sites', { registry_path: registryPath });
    }
    return authorities;
  } catch (error) {
    if (error instanceof NarsSessionMcpError) throw error;
    throw new NarsSessionMcpError('user_site_registry_unreadable', 'User Site registry could not be read', {
      registry_path: registryPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db?.close();
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)): ClientConfig {
  const binding = parseBindingArgs(argv);
  const projection = optionalText(binding.projection) ?? optionalText(env.NARADA_NARS_SESSION_PROJECTION);
  const userSiteProjection = projection === 'user-site-operator' || env.NARADA_NARS_SESSION_SCOPE === 'user_site';
  const sourceKind = optionalText(binding.sourceKind)
    ?? optionalText(env.NARADA_NARS_SESSION_SOURCE_KIND)
    ?? (userSiteProjection ? 'operator' : 'agent');
  if (sourceKind !== 'agent' && sourceKind !== 'operator') {
    throw new NarsSessionMcpError('source_kind_unsupported', `source_kind_unsupported:${sourceKind}`);
  }
  const sourceId = sourceKind === 'agent'
    ? requiredText(env.NARADA_AGENT_ID, 'caller_agent_identity_required')
    : requiredText(binding.operatorId ?? env.NARADA_OPERATOR_ID, 'caller_operator_identity_required');
  if (userSiteProjection) {
    const siteRoot = resolve(requiredText(
      binding.userSiteRoot ?? env.NARADA_USER_SITE_ROOT ?? defaultUserSiteRoot(env),
      'user_site_root_required',
    ));
    const authorities = readUserSiteAuthorities(siteRoot, env);
    return {
      env,
      scope: 'user_site',
      siteRoot,
      siteId: null,
      sessionsRoot: '',
      authorities,
      sourceKind,
      sourceId,
      carrierSessionId: optionalText(env.NARADA_CARRIER_SESSION_ID),
      allowSteer: env.NARADA_NARS_SESSION_ALLOW_STEER === '1' || env.NARADA_NARS_SESSION_ALLOW_STEER === 'true',
      requestTimeoutMs: boundedNumber(env.NARADA_NARS_SESSION_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 500, 15_000),
      healthTimeoutMs: boundedNumber(env.NARADA_NARS_SESSION_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS, 250, 5000),
      maxSessions: boundedNumber(env.NARADA_NARS_SESSION_MAX_SESSIONS, DEFAULT_MAX_SESSIONS, 1, 100),
    };
  }
  const siteRoot = requiredText(env.NARADA_SITE_ROOT, 'site_root_required');
  const sitePaths = resolveNaradaSitePaths({ siteRoot });
  const authority = { siteId: optionalText(env.NARADA_SITE_ID), siteRoot: resolve(siteRoot), sessionsRoot: sitePaths.narsSessionsRoot } satisfies SessionAuthority;
  return {
    env,
    scope: 'local_site',
    siteRoot: authority.siteRoot,
    siteId: authority.siteId,
    sessionsRoot: sitePaths.narsSessionsRoot,
    authorities: [authority],
    sourceKind,
    sourceId,
    carrierSessionId: optionalText(env.NARADA_CARRIER_SESSION_ID),
    allowSteer: env.NARADA_NARS_SESSION_ALLOW_STEER === '1' || env.NARADA_NARS_SESSION_ALLOW_STEER === 'true',
    requestTimeoutMs: boundedNumber(env.NARADA_NARS_SESSION_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 500, 15_000),
    healthTimeoutMs: boundedNumber(env.NARADA_NARS_SESSION_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS, 250, 5000),
    maxSessions: boundedNumber(env.NARADA_NARS_SESSION_MAX_SESSIONS, DEFAULT_MAX_SESSIONS, 1, 100),
  };
}

export async function listSessions(config: ClientConfig, args: JsonRecord = {}) {
  const limit = boundedNumber(args.limit, Math.min(config.maxSessions, 20), 1, config.maxSessions);
  const includeHealth = args.include_health === true;
  const authorities = selectAuthorities(config, args);
  const entries = authorities.flatMap((authority) => readSessionEntries(authority.sessionsRoot, limit)
    .filter((entry) => typeof entry.session_id === 'string' && SESSION_ID_PATTERN.test(entry.session_id))
    .map((entry) => ({ authority, entry }))).slice(0, limit);
  const sessions = await Promise.all(entries.flatMap(({ authority, entry }) => {
    const record = tryReadSessionRecord(authority, String(entry.session_id));
    return record ? [{ authority, record }] : [];
  }).map(async ({ record }) => {
    const health = includeHealth ? await probeSession(config, record) : { status: 'not_requested' };
    return publicSession(record, health);
  }));
  return {
    schema: 'narada.nars_session_mcp.sessions.v1',
    status: 'ok',
    site_id: optionalText(args.site_id) ?? config.siteId ?? null,
    authority_root: config.siteRoot,
    scope_root: config.siteRoot,
    site_root: config.siteRoot,
    scope: config.scope,
    scope_semantics: 'The envelope roots identify the bound discovery authority; each session.site_root identifies that session\'s admitted Site root.',
    authority_count: authorities.length,
    selected_site_ids: authorities.map((authority) => authority.siteId),
    count: sessions.length,
    sessions,
  };
}

export async function showSession(config: ClientConfig, args: JsonRecord = {}) {
  const { record } = resolveSessionAuthority(config, args, requiredSessionId(args.session_id));
  const health = args.include_health === false ? { status: 'not_requested' } : await probeSession(config, record);
  return {
    schema: 'narada.nars_session_mcp.session.v1',
    status: 'ok',
    scope: config.scope,
    authority_root: config.siteRoot,
    scope_root: config.siteRoot,
    session: publicSession(record, health),
    authority: authoritySummary(record),
  };
}

export async function deliverSessionInput(config: ClientConfig, args: JsonRecord = {}) {
  const { record } = resolveSessionAuthority(config, args, requiredSessionId(args.session_id));
  assertWritableAuthority(config, record, args);
  const delivery = normalizeDelivery(args.delivery ?? args.delivery_mode);
  if (delivery === 'steer' && !config.allowSteer) {
    throw new NarsSessionMcpError('steer_not_admitted', 'steer delivery is disabled by site policy');
  }
  const content = directiveContent(args);
  const idempotencyKey = requiredIdempotencyKey(args.idempotency_key);
  const health = await probeSession(config, record);
  if (health.status !== 'healthy') {
    throw new NarsSessionMcpError('session_health_unavailable', 'session health did not confirm a live authority runtime', { health });
  }
  const input = buildInputEvent({
    content,
    delivery,
    siteId: record.site_id ?? config.siteId,
    sessionId: record.session_id,
    sourceKind: config.sourceKind,
    sourceId: config.sourceId,
    carrierSessionId: config.carrierSessionId,
    authorityEpoch: record.authority_epoch ?? null,
    authorityRuntimeId: record.authority_runtime_id ?? null,
    idempotencyKey,
  });
  const requestId = `nars_input_request_${randomToken()}`;
  const response = await requestWebSocket(record.event_endpoint, {
    id: requestId,
    method: 'carrier.input.deliver',
    params: {
      input,
      delivery_constructor: delivery,
    },
  }, { timeoutMs: config.requestTimeoutMs, waitFor: (message) => inputDeliveryResponse(message, requestId) });
  if (isErrorMessage(response)) {
    throw new NarsSessionMcpError(String(response.code ?? 'session_input_refused'), String(response.message ?? 'session input refused'), response);
  }
  const eventName = eventNameOf(response);
  return {
    schema: 'narada.nars_session_mcp.input_delivery.v1',
    status: 'admitted',
    admission: eventName === 'input_event_queued' ? 'queued' : 'accepted',
    site_id: record.site_id ?? config.siteId,
    session_id: record.session_id,
    request_id: requestId,
    input_event_id: input.event_id,
    directive_id: input.directive_id,
    delivery,
    protocol_method: 'carrier.input.deliver',
    authority: authoritySummary(record),
    queue_state: asRecord(response.payload).queue_state ?? 'queued_for_turn_boundary',
    evidence: {
      event: eventName,
      request_id: requestId,
      source: config.sourceId,
      idempotency_key: idempotencyKey,
    },
  };
}

export async function inputStatus(config: ClientConfig, args: JsonRecord = {}) {
  const { record } = resolveSessionAuthority(config, args, requiredSessionId(args.session_id));
  const inputEventId = optionalText(args.input_event_id);
  const requestId = optionalText(args.request_id);
  const directiveId = optionalText(args.directive_id);
  if (!inputEventId && !requestId && !directiveId) {
    throw new NarsSessionMcpError('input_status_selector_required', 'input_event_id, request_id, or directive_id is required');
  }
  const readRequestId = `nars_input_status_${randomToken()}`;
  const filters = {
    any_of: Object.fromEntries([
      ['input_event_id', inputEventId],
      ['request_id', requestId],
      ['directive_id', directiveId],
    ].filter(([, value]) => Boolean(value))),
  };
  const limit = boundedNumber(args.limit, 100, 1, 200);
  const response = await requestWebSocket(record.event_endpoint, {
    id: readRequestId,
    method: 'session.events.read',
    params: { direction: 'backward', limit, filters },
  }, { timeoutMs: config.requestTimeoutMs, waitFor: (message) => eventNameOf(message) === 'session_events_read' && message.request_id === readRequestId });
  const events = Array.isArray(response.events) ? response.events.filter((event) => eventMatches(event, { inputEventId, requestId, directiveId })) : [];
  const corruptLineCount = Number(response.corrupt_line_count ?? 0);
  const hasMore = response.has_more === true;
  const historyTruncated = response.truncated === true || corruptLineCount > 0;
  const evidenceComplete = !hasMore && !historyTruncated;
  const summary = summarizeInputEvents(events);
  return {
    schema: 'narada.nars_session_mcp.input_status.v1',
    status: summary.status,
    status_semantics: summary.status_semantics,
    admission_status: summary.admission_status,
    terminal_state: summary.terminal_state,
    request_state: summary.request_state,
    outcome: summary.outcome,
    outcome_reason: summary.outcome_reason,
    terminal_event: summary.terminal_event,
    site_id: record.site_id ?? config.siteId,
    session_id: record.session_id,
    selectors: { input_event_id: inputEventId, request_id: requestId, directive_id: directiveId },
    events,
    evidence_complete: evidenceComplete,
    history_truncated: historyTruncated,
    corrupt_line_count: corruptLineCount,
    evidence: {
      source: response.source ?? 'events_jsonl',
      complete: evidenceComplete,
      has_more: hasMore,
      event_count: response.event_count ?? events.length,
      cursor: response.cursor ?? null,
      filters,
    },
    authority: authoritySummary(record),
  };
}

export function buildInputEvent({ content, delivery, siteId, sessionId, sourceKind, sourceId, carrierSessionId, authorityEpoch, authorityRuntimeId, idempotencyKey, now = new Date() }: {
  content: string;
  delivery: DeliveryConstructor;
  siteId: string | null;
  sessionId: string;
  sourceKind: 'agent' | 'operator';
  sourceId: string;
  carrierSessionId: string | null;
  authorityEpoch: number | null;
  authorityRuntimeId: string | null;
  idempotencyKey: string;
  now?: Date;
}) {
  const inputEventId = `input_${randomToken()}`;
  const directiveId = `dir_nars_input_${randomToken()}`;
  const authorityRef = `nars-session-mcp:${siteId ?? 'site'}:${sessionId}:${authorityEpoch ?? 'unknown'}`;
  return {
    schema: INPUT_EVENT_SCHEMA,
    event_id: inputEventId,
    source_kind: sourceKind,
    source_id: sourceId,
    source: sourceKind === 'agent' ? 'agent_control' : 'operator_control',
    transport: 'carrier_server_api',
    delivery_mode: delivery === 'send' ? 'admit_for_current_turn' : 'admit_after_active_turn',
    hold_condition: null,
    content,
    created_at: now.toISOString(),
    authority_ref: authorityRef,
    directive_id: directiveId,
    metadata: {
      input_source: 'nars_session_mcp',
      ...(sourceKind === 'agent' ? { agent_control_input: true } : {}),
      directive_provenance: {
        kind: sourceKind === 'agent' ? 'agent_directive_surface' : 'explicit_operator_directive_surface',
        surface_id: 'nars-session-mcp',
      },
      nars_session_input: {
        delivery_constructor: delivery,
        idempotency_key: idempotencyKey,
        target_session_id: sessionId,
        target_site_id: siteId,
        authority_epoch: authorityEpoch,
        authority_runtime_id: authorityRuntimeId,
        caller_carrier_session_id: carrierSessionId,
      },
    },
  };
}

function configSessionIndexPath(sessionsRoot: string) {
  return join(sessionsRoot, 'index.json');
}

function readSessionEntries(sessionsRoot: string, limit: number): JsonRecord[] {
  const aggregate = readJson(configSessionIndexPath(sessionsRoot));
  if (Array.isArray(aggregate.sessions)) return aggregate.sessions.slice(0, limit).map(asRecord);
  if (!existsSync(sessionsRoot)) return [];
  return readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
    .slice(0, limit)
    .map((entry) => ({ session_id: entry.name }));
}

function readSessionRecord(authority: SessionAuthority, sessionId: string): SessionRecord {
  const path = join(authority.sessionsRoot, sessionId, 'session-index-record.json');
  const record = readJson(path);
  if (!record || record.session_id !== sessionId) {
    throw new NarsSessionMcpError('session_not_found', `session_not_found:${sessionId}`);
  }
  if (record.site_root && resolve(String(record.site_root)) !== authority.siteRoot) {
    throw new NarsSessionMcpError('session_site_root_mismatch', 'session record is outside the bound Site root');
  }
  if (authority.siteId && record.site_id && record.site_id !== authority.siteId) {
    throw new NarsSessionMcpError('session_site_id_mismatch', 'session record belongs to a different Site');
  }
  return record as SessionRecord;
}

function tryReadSessionRecord(authority: SessionAuthority, sessionId: string): SessionRecord | null {
  try {
    return readSessionRecord(authority, sessionId);
  } catch {
    return null;
  }
}

function selectAuthorities(config: ClientConfig, args: JsonRecord): SessionAuthority[] {
  const requested = optionalText(args.site_id);
  if (!requested) return config.authorities;
  const matches = config.authorities.filter((authority) => authority.siteId === requested);
  if (matches.length > 0) return matches;
  if (config.scope === 'local_site' && config.authorities.length === 1 && config.authorities[0].siteId === null) return config.authorities;
  throw new NarsSessionMcpError('site_scope_refused', `site_scope_refused:${requested}`);
}

function resolveSessionAuthority(config: ClientConfig, args: JsonRecord, sessionId: string): { authority: SessionAuthority; record: SessionRecord } {
  const matches = selectAuthorities(config, args).flatMap((authority) => {
    const record = tryReadSessionRecord(authority, sessionId);
    return record ? [{ authority, record }] : [];
  });
  if (matches.length === 0) throw new NarsSessionMcpError('session_not_found', `session_not_found:${sessionId}`);
  if (matches.length > 1) {
    throw new NarsSessionMcpError('session_ambiguous', `session_ambiguous:${sessionId}`, {
      session_id: sessionId,
      site_ids: matches.map(({ authority }) => authority.siteId),
    });
  }
  return matches[0];
}

function publicSession(record: SessionRecord, health: JsonRecord) {
  const liveness = deriveSessionLiveness(record, health);
  return {
    session_id: record.session_id,
    carrier_session_id: record.carrier_session_id ?? record.session_id,
    nars_session_id: record.nars_session_id ?? record.session_id,
    site_id: record.site_id ?? null,
    site_root: record.site_root ?? null,
    agent_id: record.agent_id ?? null,
    runtime_kind: record.runtime_kind ?? null,
    launch_operator_surface_kind: record.launch_operator_surface_kind ?? null,
    display_state: liveness.display_state,
    display_state_reason: liveness.display_state_reason,
    persisted_display_state: record.display_state ?? null,
    status_hint: record.status_hint ?? null,
    started_at: record.started_at ?? null,
    last_seen_at: record.last_seen_at ?? null,
    last_seen_source: 'session_index_projection',
    heartbeat_at: liveness.heartbeat_at,
    heartbeat_fresh: liveness.heartbeat_fresh,
    heartbeat_age_ms: liveness.heartbeat_age_ms,
    health_observed_at: liveness.health_observed_at,
    liveness: {
      source: liveness.source,
      observed_at: liveness.health_observed_at,
      heartbeat_path: liveness.heartbeat_path,
      heartbeat_at: liveness.heartbeat_at,
      heartbeat_age_ms: liveness.heartbeat_age_ms,
      heartbeat_fresh: liveness.heartbeat_fresh,
    },
    terminal_state: record.terminal_state ?? null,
    health,
    event_endpoint_available: Boolean(record.event_endpoint),
    health_endpoint_available: Boolean(record.health_endpoint),
    authority: authoritySummary(record),
  };
}

function authoritySummary(record: SessionRecord) {
  return {
    authority_runtime_id: record.authority_runtime_id ?? null,
    authority_epoch: record.authority_epoch ?? null,
    source_write_admission: record.source_write_admission ?? null,
    authority_transition_state: record.authority_transition_state ?? null,
    superseded_by_session_id: record.superseded_by_session_id ?? null,
    authority_locator_ref: record.authority_locator_ref ?? null,
  };
}

async function probeSession(config: ClientConfig, record: SessionRecord): Promise<JsonRecord> {
  if (record.health_endpoint) {
    try {
      const response = await fetch(String(record.health_endpoint), { signal: AbortSignal.timeout(config.healthTimeoutMs) });
      const body = await response.json().catch(() => ({}));
      const bodyRecord = asRecord(body);
      return {
        ...bodyRecord,
        status: semanticHealthStatus(bodyRecord, response.ok ? 'healthy' : 'unhealthy'),
        http_status: response.status,
        http_ok: response.ok,
        probe_status: 'reachable',
        health_observed_at: new Date().toISOString(),
        health_source: 'health_endpoint',
      };
    } catch (error) {
      return {
        status: 'unavailable',
        probe_status: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
        health_observed_at: new Date().toISOString(),
        health_source: 'health_endpoint',
      };
    }
  }
  if (record.event_endpoint) {
    try {
      const requestId = `nars_health_${randomToken()}`;
      const response = await requestWebSocket(record.event_endpoint, { id: requestId, method: 'session.health', params: {} }, {
        timeoutMs: config.healthTimeoutMs,
        waitFor: (message) => message.request_id === requestId || eventNameOf(message) === 'session_health',
      });
      return {
        ...response,
        status: semanticHealthStatus(response, isErrorMessage(response) ? 'unhealthy' : 'healthy'),
        probe_status: 'reachable',
        health_observed_at: new Date().toISOString(),
        health_source: 'event_endpoint',
      };
    } catch (error) {
      return {
        status: 'unavailable',
        probe_status: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
        health_observed_at: new Date().toISOString(),
        health_source: 'event_endpoint',
      };
    }
  }
  return {
    status: 'unavailable',
    probe_status: 'unavailable',
    reason: 'session_health_endpoint_missing',
    health_observed_at: new Date().toISOString(),
    health_source: 'endpoint_missing',
  };
}

function assertWritableAuthority(config: ClientConfig, record: SessionRecord, args: JsonRecord) {
  if (!record.event_endpoint) throw new NarsSessionMcpError('session_event_endpoint_missing', 'session has no live event endpoint');
  if (record.terminal_state === 'closed') throw new NarsSessionMcpError('session_closed', 'session is closed');
  if (record.superseded_by_session_id) throw new NarsSessionMcpError('session_superseded', 'session has been superseded', { superseded_by_session_id: record.superseded_by_session_id });
  if (record.source_write_admission !== 'active') {
    throw new NarsSessionMcpError('session_authority_not_writable', `session source write admission is ${record.source_write_admission ?? 'unknown'}`, authoritySummary(record));
  }
  if (!Number.isInteger(record.authority_epoch) || Number(record.authority_epoch) < 1) {
    throw new NarsSessionMcpError('session_authority_epoch_missing', 'session authority epoch is missing or invalid', authoritySummary(record));
  }
  if (!optionalText(record.authority_runtime_id)) {
    throw new NarsSessionMcpError('session_authority_runtime_missing', 'session authority runtime identity is missing', authoritySummary(record));
  }
  const expectedEpoch = args.expected_authority_epoch;
  if (expectedEpoch !== undefined && Number(expectedEpoch) !== Number(record.authority_epoch)) {
    throw new NarsSessionMcpError('authority_epoch_mismatch', 'session authority epoch changed', { expected: expectedEpoch, actual: record.authority_epoch });
  }
  if (!config.sourceId) throw new NarsSessionMcpError('caller_identity_required', 'caller identity is required');
}

function assertRequestedSite(config: ClientConfig, args: JsonRecord) {
  const requested = optionalText(args.site_id);
  if (requested && config.siteId && requested !== config.siteId) {
    throw new NarsSessionMcpError('site_scope_refused', `site_scope_refused:${requested}`);
  }
}

function directiveContent(args: JsonRecord): string {
  const direct = optionalText(args.content);
  const directive = asRecord(args.directive);
  const content = asRecord(directive.content);
  const text = direct ?? optionalText(content.text);
  if (!text) throw new NarsSessionMcpError('content_required', 'content or directive.content.text is required');
  if (text.length > MAX_INLINE_CONTENT) throw new NarsSessionMcpError('content_too_large', `content exceeds ${MAX_INLINE_CONTENT} characters`);
  return text;
}

function inputDeliveryResponse(message: JsonRecord, requestId: string): boolean {
  const event = eventNameOf(message);
  const messageRequestId = message.request_id ?? asRecord(message.payload).request_id;
  if (messageRequestId !== requestId) return false;
  return event === 'input_event_queued'
    || event === 'input_event_started'
    || event === 'input_admitted_to_turn'
    || event === 'session_control_accepted'
    || event === 'input_completed'
    || event === 'user_message'
    || event === 'turn_started'
    || event === 'error'
    || event === 'websocket_error';
}

function eventMatches(event: unknown, selectors: { inputEventId: string | null; requestId: string | null; directiveId: string | null }) {
  const record = asRecord(event);
  const payload = asRecord(record.payload);
  const inputEventId = optionalText(record.input_event_id) ?? optionalText(record.event_id) ?? optionalText(payload.input_event_id) ?? optionalText(payload.event_id);
  const requestId = optionalText(record.request_id) ?? optionalText(payload.request_id);
  const directiveId = optionalText(record.directive_id) ?? optionalText(payload.directive_id);
  return (selectors.inputEventId && inputEventId === selectors.inputEventId)
    || (selectors.requestId && requestId === selectors.requestId)
    || (selectors.directiveId && directiveId === selectors.directiveId);
}

export function summarizeInputEvents(events: unknown[]): JsonRecord {
  const admissionStatus = classifyInputStatus(events);
  const candidates = events.map((event) => terminalEvidence(event)).filter((candidate) => candidate !== null) as Array<{
    state: string;
    event: string;
    reason: string | null;
    rank: number;
  }>;
  const terminal = candidates
    .sort((left, right) => right.rank - left.rank)
    .at(0) ?? null;
  const terminalReason = terminal?.reason
    ?? candidates.find((candidate) => candidate.state === terminal?.state && candidate.reason)?.reason
    ?? null;
  const requestStates = events
    .map((event) => requestStateFromEvent(event))
    .filter((state): state is string => state !== null);
  const requestState = requestStates.at(-1)
    ?? terminal?.state
    ?? null;
  const outcome = terminal
    ? terminal.state === 'completed'
      ? 'completed'
      : terminal.state === 'rejected'
        ? 'refused'
        : terminal.state === 'interrupted'
          ? 'interrupted'
          : 'failed'
    : admissionStatus === 'unknown' ? 'unknown' : 'pending';
  return {
    status: admissionStatus,
    status_semantics: 'admission',
    admission_status: admissionStatus,
    terminal_state: terminal?.state ?? null,
    request_state: requestState,
    outcome,
    outcome_reason: terminalReason,
    terminal_event: terminal?.event ?? null,
  };
}

function classifyInputStatus(events: unknown[]): string {
  if (events.some((event) => ['error', 'turn_failed', 'websocket_error'].includes(eventNameOf(asRecord(event))))) return 'refused_or_failed';
  if (events.some((event) => ['input_completed', 'input_event_completed', 'turn_complete'].includes(eventNameOf(asRecord(event))))) return 'processed';
  if (events.some((event) => ['input_event_started', 'turn_started', 'user_message'].includes(eventNameOf(asRecord(event))))) return 'admitted_to_turn';
  if (events.some((event) => eventNameOf(asRecord(event)) === 'input_event_queued')) return 'queued';
  return 'unknown';
}

function terminalEvidence(event: unknown): { state: string; event: string; reason: string | null; rank: number } | null {
  const record = asRecord(event);
  const payload = asRecord(record.payload);
  const name = eventNameOf(record);
  const fields = { ...payload, ...record };
  const explicit = terminalStateFromValue(fields.terminal_state)
    ?? terminalStateFromValue(fields.request_state)
    ?? terminalStateFromValue(fields.turn_state)
    ?? terminalStateFromValue(fields.state);
  let state = explicit;
  if (!state && name === 'session_control_rejected') {
    state = optionalText(fields.code) === 'request_dispatch_failed' ? 'failed' : 'rejected';
  }
  if (!state && ['error', 'turn_failed', 'carrier_turn_failed', 'websocket_error', 'input_event_failed', 'runtime_request_failed'].includes(name)) state = 'failed';
  if (!state && ['input_completed', 'input_event_completed', 'turn_complete'].includes(name)) state = 'completed';
  if (!state) return null;
  return {
    state,
    event: name,
    reason: optionalText(fields.error) ?? optionalText(fields.message) ?? optionalText(fields.code),
    rank: (state === 'completed' ? 1 : state === 'interrupted' ? 2 : 3)
      + (name === 'runtime_request_state_transition' ? 1 : 0),
  };
}

function requestStateFromEvent(event: unknown): string | null {
  const record = asRecord(event);
  const payload = asRecord(record.payload);
  const state = optionalText(record.request_state) ?? optionalText(payload.request_state);
  return state;
}

function terminalStateFromValue(value: unknown): string | null {
  const normalized = optionalText(value)?.toLowerCase();
  if (!normalized) return null;
  if (['completed', 'complete', 'success', 'succeeded'].includes(normalized)) return 'completed';
  if (['failed', 'error'].includes(normalized)) return 'failed';
  if (['rejected', 'refused'].includes(normalized)) return 'rejected';
  if (['interrupted', 'cancelled', 'canceled'].includes(normalized)) return 'interrupted';
  return null;
}

function deriveSessionLiveness(record: SessionRecord, health: JsonRecord) {
  const heartbeatPath = optionalText(record.heartbeat_path)
    ?? (optionalText(record.session_dir) ? join(String(record.session_dir), 'heartbeat.json') : null);
  const heartbeat = heartbeatPath ? readJson(heartbeatPath) : {};
  const heartbeatValue = heartbeat.heartbeat_at ?? heartbeat.last_written_at ?? heartbeat.timestamp ?? null;
  const heartbeatAtMs = timestampMs(heartbeatValue);
  const heartbeatAgeMs = heartbeatAtMs === null ? null : Math.max(0, Date.now() - heartbeatAtMs);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= DEFAULT_HEARTBEAT_FRESH_MS;
  const healthStatus = optionalText(health.status)?.toLowerCase();
  const healthObservedAt = optionalText(health.health_observed_at);
  if (healthStatus === 'healthy') {
    return {
      display_state: 'active',
      display_state_reason: 'health_probe_succeeded',
      source: 'health_probe',
      heartbeat_path: heartbeatPath,
      heartbeat_at: heartbeatValue,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      health_observed_at: healthObservedAt,
    };
  }
  if (healthStatus === 'starting' || healthStatus === 'degraded') {
    return {
      display_state: 'starting_or_degraded',
      display_state_reason: `health_probe_${healthStatus}`,
      source: 'health_probe',
      heartbeat_path: heartbeatPath,
      heartbeat_at: heartbeatValue,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      health_observed_at: healthObservedAt,
    };
  }
  if (healthStatus === 'closing') {
    return {
      display_state: 'closing',
      display_state_reason: 'health_probe_closing',
      source: 'health_probe',
      heartbeat_path: heartbeatPath,
      heartbeat_at: heartbeatValue,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      health_observed_at: healthObservedAt,
    };
  }
  if (record.terminal_state === 'closed') {
    return {
      display_state: 'closed',
      display_state_reason: 'terminal_state_closed',
      source: 'session_index_and_heartbeat',
      heartbeat_path: heartbeatPath,
      heartbeat_at: heartbeatValue,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      health_observed_at: healthObservedAt,
    };
  }
  if (healthStatus === 'unhealthy' || healthStatus === 'unavailable') {
    return {
      display_state: healthStatus,
      display_state_reason: `health_probe_${healthStatus}`,
      source: 'health_probe',
      heartbeat_path: heartbeatPath,
      heartbeat_at: heartbeatValue,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      health_observed_at: healthObservedAt,
    };
  }
  if (heartbeatFresh) {
    return {
      display_state: 'starting_or_degraded',
      display_state_reason: 'fresh_heartbeat_without_health',
      source: 'heartbeat',
      heartbeat_path: heartbeatPath,
      heartbeat_at: heartbeatValue,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      health_observed_at: healthObservedAt,
    };
  }
  if (heartbeatAtMs !== null || record.status_hint === 'alive') {
    return {
      display_state: 'stale',
      display_state_reason: 'stale_or_missing_liveness',
      source: 'session_index_and_heartbeat',
      heartbeat_path: heartbeatPath,
      heartbeat_at: heartbeatValue,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_fresh: heartbeatFresh,
      health_observed_at: healthObservedAt,
    };
  }
  return {
    display_state: 'historical',
    display_state_reason: 'historical_record_only',
    source: 'session_index',
    heartbeat_path: heartbeatPath,
    heartbeat_at: heartbeatValue,
    heartbeat_age_ms: heartbeatAgeMs,
    heartbeat_fresh: heartbeatFresh,
    health_observed_at: healthObservedAt,
  };
}

export function websocketEndpointProtocol(endpoint: string): 'ws:' | 'wss:' {
  const protocol = new URL(endpoint).protocol;
  if (protocol !== 'ws:' && protocol !== 'wss:') throw new NarsSessionMcpError('websocket_protocol_unsupported', `unsupported_websocket_protocol:${protocol}`);
  return protocol;
}

async function requestWebSocket(endpoint: unknown, request: JsonRecord, { timeoutMs, waitFor }: { timeoutMs: number; waitFor: (message: JsonRecord) => boolean }): Promise<JsonRecord> {
  const endpointText = optionalText(endpoint);
  if (!endpointText) throw new NarsSessionMcpError('session_event_endpoint_missing', 'session event endpoint is required');
  const url = new URL(endpointText);
  const protocol = websocketEndpointProtocol(endpointText);
  const port = Number(url.port || (protocol === 'wss:' ? 443 : 80));
  const path = `${url.pathname || '/'}${url.search || ''}`;
  const key = randomBytes(16).toString('base64');
  const handshake = [
    `GET ${path} HTTP/1.1`,
    `Host: ${url.hostname}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
  const expectedAccept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  return new Promise((resolvePromise, rejectPromise) => {
    const socket: Socket | TLSSocket = protocol === 'wss:'
      ? tlsConnect({ host: url.hostname, port, servername: url.hostname })
      : new Socket();
    let settled = false;
    let handshakeComplete = false;
    let actualRequestSent = false;
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const subscriptionRequestId = `${String(request.id)}_events`;
    const timer = setTimeout(() => settle(new NarsSessionMcpError('nars_session_request_timeout', 'NARS session request timed out', { request_id: request.id })), timeoutMs);
    const settle = (error: Error | null, value: JsonRecord | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value ?? {});
    };
    socket.once('error', (error) => settle(new NarsSessionMcpError('websocket_request_failed', error.message)));
    socket.once('close', () => {
      if (!settled) settle(new NarsSessionMcpError('websocket_closed_before_response', 'NARS websocket closed before response'));
    });
    const sendHandshake = () => { if (!settled) socket.write(handshake); };
    if (protocol === 'wss:') socket.once('secureConnect', sendHandshake);
    else socket.connect(port, url.hostname, sendHandshake);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeComplete) {
        const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString('utf8');
        if (!/^HTTP\/1\.1 101\b/.test(header)) return settle(new NarsSessionMcpError('websocket_handshake_failed', header.split(/\r?\n/)[0] ?? 'unknown'));
        if (!header.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) return settle(new NarsSessionMcpError('websocket_accept_mismatch'));
        buffer = buffer.subarray(headerEnd + 4);
        handshakeComplete = true;
        socket.write(encodeClientFrame(JSON.stringify({
          id: subscriptionRequestId,
          method: 'session.events.subscribe',
          params: {
            subscription_id: `nars_session_mcp_${String(request.id)}`,
            filters: { request_id: request.id },
            include_replay: false,
            max_replay: 0,
          },
        })));
      }
      for (const frame of decodeServerFrames(buffer)) {
        buffer = frame.rest;
        if (frame.opcode === 0x9) {
          socket.write(encodeClientFrame(frame.payload, 0xA));
          continue;
        }
        if (frame.opcode === 0x8) return settle(new NarsSessionMcpError('websocket_closed_before_response', 'NARS websocket closed before response'));
        if (frame.opcode !== 0x1) continue;
        let message: JsonRecord;
        try { message = asRecord(JSON.parse(frame.payload)); } catch { continue; }
        if (eventNameOf(message) === 'websocket_connected') continue;
        if (eventNameOf(message) === 'session_events_subscription_started' && message.request_id === subscriptionRequestId && !actualRequestSent) {
          actualRequestSent = true;
          socket.write(encodeClientFrame(JSON.stringify(request)));
          continue;
        }
        if (waitFor(message)) settle(null, message);
      }
    });
  });
}

function decodeServerFrames(input: Buffer): Array<{ opcode: number; payload: string; rest: Buffer }> {
  const frames: Array<{ opcode: number; payload: string; rest: Buffer }> = [];
  let buffer = input;
  while (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];
    let length = second & 0x7F;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) break;
      const longLength = Number(buffer.readBigUInt64BE(2));
      if (!Number.isSafeInteger(longLength) || longLength > 4 * 1024 * 1024) throw new NarsSessionMcpError('websocket_frame_too_large');
      length = longLength;
      offset = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskOffset = masked ? 4 : 0;
    if (buffer.length < offset + maskOffset + length) break;
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    const payloadOffset = offset + maskOffset;
    const payloadBuffer = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (mask) for (let index = 0; index < payloadBuffer.length; index += 1) payloadBuffer[index] ^= mask[index % 4];
    buffer = buffer.subarray(payloadOffset + length);
    frames.push({ opcode: first & 0x0F, payload: payloadBuffer.toString('utf8'), rest: buffer });
  }
  return frames;
}

function encodeClientFrame(text: string, opcode = 0x1): Buffer {
  const body = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  let header: Buffer;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function isErrorMessage(message: JsonRecord) {
  return eventNameOf(message) === 'error' || eventNameOf(message) === 'websocket_error' || typeof message.error === 'object';
}

function eventNameOf(message: JsonRecord) {
  if (message.event === 'session_event') {
    const payload = asRecord(message.payload);
    if (payload.event || payload.event_kind || payload.type) return eventNameOf(payload);
  }
  return String(message.event ?? message.event_kind ?? message.type ?? '');
}

function requiredSessionId(value: unknown): string {
  const sessionId = requiredText(value, 'session_id_required');
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new NarsSessionMcpError('session_id_invalid', 'session_id contains unsupported characters');
  return sessionId;
}

function normalizeDelivery(value: unknown): DeliveryConstructor {
  const delivery = String(value ?? '').trim();
  if (delivery !== 'send' && delivery !== 'enqueue' && delivery !== 'steer') throw new NarsSessionMcpError('delivery_required', 'delivery must be send, enqueue, or steer');
  return delivery;
}

function requiredIdempotencyKey(value: unknown) {
  const key = requiredText(value, 'idempotency_key_required');
  if (key.length > 128) throw new NarsSessionMcpError('idempotency_key_too_long');
  return key;
}

function readJson(path: string): JsonRecord {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) return {};
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return asRecord(value);
  } catch {
    return {};
  }
}

function randomToken() {
  return randomUUID().replaceAll('-', '').slice(0, 24);
}

function requiredText(value: unknown, code: string): string {
  const text = optionalText(value);
  if (!text) throw new NarsSessionMcpError(code, code);
  return text;
}

function optionalText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
