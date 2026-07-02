#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGraphUrl, graphCalendarPath, graphRequest, graphTop, requiredString } from './graph-client.js';
import { decideEventWrite, loadCalendarPolicy, recordCalendarAudit } from './policy.js';
import { buildCalendarTelemetryDeclaration, emitTelemetryEvent, type TelemetryDeclaration, type TelemetryEventKind } from '@narada2/mcp-telemetry';

const SERVER_NAME = 'narada-calendar-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const SURFACE_ID = 'calendar';

type CalendarRecord = Record<string, unknown>;
type CalendarServerState = CalendarRecord & {
  siteRoot: string;
  serverName: string;
  accessToken: string | null;
  tenantId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
  tokenCache: { accessToken: string; expiresAtMs: number } | null;
  fetchImpl: typeof fetch;
};

function asRecord(value: unknown): CalendarRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CalendarRecord : {};
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export function createServerState(options: unknown = {}): CalendarServerState {
  const optionsRecord = asRecord(options);
  const siteRoot = resolve(String(optionsRecord.siteRoot ?? process.cwd()));
  const env = loadCalendarEnvironment(siteRoot);
  const explicitAccessToken = stringOption(optionsRecord.accessToken) ?? env.GRAPH_ACCESS_TOKEN ?? null;
  const tenantId = stringOption(optionsRecord.tenantId) ?? env.GRAPH_TENANT_ID ?? null;
  const clientId = stringOption(optionsRecord.clientId) ?? env.GRAPH_CLIENT_ID ?? null;
  const clientSecret = stringOption(optionsRecord.clientSecret) ?? env.GRAPH_CLIENT_SECRET ?? null;
  const hasClientCredentials = !!(tenantId && clientId && clientSecret);
  return {
    siteRoot,
    serverName: String(optionsRecord.serverName ?? SERVER_NAME),
    accessToken: explicitAccessToken ?? (hasClientCredentials ? null : env.MS_GRAPH_ACCESS_TOKEN ?? null),
    tenantId,
    clientId,
    clientSecret,
    tokenEndpoint: stringOption(optionsRecord.tokenEndpoint) ?? env.GRAPH_TOKEN_ENDPOINT ?? null,
    tokenCache: null,
    fetchImpl: typeof optionsRecord.fetchImpl === 'function' ? optionsRecord.fetchImpl as typeof fetch : fetch,
  };
}

export async function handleRequest(request: CalendarRecord, state: CalendarServerState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

export async function runStdioServer(options: unknown): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let requests: CalendarRecord[];
    if (buffer.includes('Content-Length:')) {
      sawFramedInput = true;
      const drained = drainJsonRpcFrames(buffer);
      buffer = drained.remaining;
      requests = drained.requests;
    } else {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      requests = lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line)));
    }
    for (const request of requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

async function dispatchMethod(method: string, params: CalendarRecord, state: CalendarServerState) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {}, completions: {}, logging: {} },
        serverInfo: { name: state.serverName, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    case 'prompts/list':
      return { prompts: [{ name: 'calendar_workflow', title: 'Calendar Workflow', description: 'Live calendar reads and guarded event writes.', arguments: [] }] };
    case 'prompts/get':
      return promptGet(params);
    case 'completion/complete':
      return completeArgument(params);
    case 'logging/setLevel':
      return {};
    default:
      throw new Error(`unsupported_mcp_method: ${method}`);
  }
}

function promptGet(params: CalendarRecord) {
  const name = String(params.name ?? '');
  if (name !== 'calendar_workflow') throw new Error(`unknown_prompt: ${name}`);
  return {
    description: 'Live calendar reads and guarded event writes.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Use calendar_event_query with explicit start and end timestamps. Event writes require site policy opt-in, confirm_write=true, and any configured approval token.' } }],
  };
}

function completeArgument(params: CalendarRecord) {
  const argumentName = String(asRecord(asRecord(params).argument).name ?? '');
  const values = argumentName === 'name' ? listTools().map((tool) => asRecord(tool).name).filter((value): value is string => typeof value === 'string').slice(0, 100) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

export function listTools(): unknown[] {
  return [
    guidanceToolDefinition(),
    tool('calendar_doctor', 'Inspect Microsoft Graph calendar MCP readiness and policy.', {}),
    tool('calendar_list', 'List calendars for an allowed mailbox.', {
      mailbox_id: mailboxProperty(),
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum calendars.' },
    }),
    tool('calendar_event_query', 'Query calendar view events over an explicit time window.', {
      mailbox_id: mailboxProperty(),
      calendar_id: { type: 'string', description: 'Optional calendar id. Defaults to the mailbox default calendar view.' },
      start_datetime: { type: 'string', description: 'Inclusive ISO start timestamp for calendarView.' },
      end_datetime: { type: 'string', description: 'Exclusive ISO end timestamp for calendarView.' },
      select: { type: 'string', description: 'Optional comma-separated Graph $select list.' },
      filter: { type: 'string', description: 'Optional Graph $filter expression.' },
      orderby: { type: 'string', default: 'start/dateTime', description: 'Optional Graph $orderby expression.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum events.' },
    }, ['start_datetime', 'end_datetime']),
    tool('calendar_event_show', 'Read one live Microsoft Graph calendar event.', {
      mailbox_id: mailboxProperty(),
      event_id: { type: 'string', description: 'Graph event id.' },
      select: { type: 'string', description: 'Optional comma-separated Graph $select list.' },
    }, ['event_id']),
    tool('calendar_event_create', 'Create an event when explicitly allowed by policy.', { ...eventWriteProperties(), calendar_id: { type: 'string', description: 'Optional calendar id.' } }, ['subject', 'start_datetime', 'end_datetime', 'time_zone']),
    tool('calendar_event_update', 'Update an event when explicitly allowed by policy.', { ...eventWriteProperties(), event_id: { type: 'string', description: 'Graph event id.' } }, ['event_id']),
    tool('calendar_event_delete', 'Delete an event when explicitly allowed by policy.', {
      mailbox_id: mailboxProperty(),
      event_id: { type: 'string', description: 'Graph event id.' },
      confirm_write: { type: 'boolean', default: false, description: 'Must be true for write attempts.' },
      approval_token: { type: 'string', description: 'Optional site-configured approval token.' },
    }, ['event_id']),
  ];
}

function mailboxProperty() {
  return { type: 'string', default: 'me', description: 'Mailbox id or user principal. Defaults to the only allowed mailbox when policy has one, otherwise me.' };
}

function eventWriteProperties() {
  return {
    mailbox_id: mailboxProperty(),
    subject: { type: 'string', description: 'Event subject.' },
    body_text: { type: 'string', description: 'Plain text body.' },
    body_html: { type: 'string', description: 'HTML body.' },
    start_datetime: { type: 'string', description: 'Event start dateTime.' },
    end_datetime: { type: 'string', description: 'Event end dateTime.' },
    time_zone: { type: 'string', description: 'Graph time zone name.' },
    location: { type: 'string', description: 'Display location.' },
    attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses or Graph attendee objects.' },
    is_online_meeting: { type: 'boolean', description: 'Create an online meeting when true.' },
    online_meeting_provider: { type: 'string', description: 'Graph online meeting provider.' },
    show_as: { type: 'string', enum: ['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown'], description: 'Free/busy display state.' },
    sensitivity: { type: 'string', enum: ['normal', 'personal', 'private', 'confidential'], description: 'Event sensitivity.' },
    confirm_write: { type: 'boolean', default: false, description: 'Must be true for write attempts.' },
    approval_token: { type: 'string', description: 'Optional site-configured approval token.' },
  };
}

async function callTool(params: CalendarRecord, state: CalendarServerState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  const startedAt = Date.now();
  try {
    const result = await callNamedTool(name, args, state);
    const resultRecord = asRecord(result);
    const status = String(resultRecord.status ?? 'ok');
    const eventKind = status === 'refused' ? 'tool_refused' : 'tool_completed';
    emitCalendarTelemetry(name, eventKind, status, startedAt, state, resultRecord);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2), annotations: { audience: ['assistant'] } }], structuredContent: result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    emitCalendarTelemetry(name, 'tool_failed', 'error', startedAt, state, { message: diagnostic.message });
    throw error;
  }
}

function emitCalendarTelemetry(toolName: string, eventKind: TelemetryEventKind, status: string, startedAt: number, state: CalendarServerState, result: CalendarRecord): void {
  const declaration = calendarTelemetryDeclaration(toolName);
  if (!declaration) return;
  try {
    emitTelemetryEvent({
      context: {
        siteRoot: state.siteRoot,
        siteId: process.env.NARADA_SITE_ID ?? null,
        surfaceId: SURFACE_ID,
        agentId: process.env.NARADA_AGENT_ID ?? null,
        carrierSessionId: process.env.NARADA_CARRIER_SESSION_ID ?? null,
      },
      declaration,
      event: {
        toolName,
        eventKind,
        status,
        startedAt,
        completedAt: Date.now(),
        policyDecision: policyDecisionFromResult(result),
        errorCode: eventKind === 'tool_failed' ? errorCodeFromMessage(String(result.message ?? 'calendar_tool_failed')) : null,
        refusalCode: eventKind === 'tool_refused' ? String(result.reason ?? 'calendar_tool_refused') : null,
      },
    });
  } catch (error) {
    process.stderr.write(`calendar_telemetry_error:${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function calendarTelemetryDeclaration(toolName: string): TelemetryDeclaration | null {
  if (!listTools().map((toolDef) => String(asRecord(toolDef).name ?? '')).includes(toolName)) return null;
  const writes = /event_create|event_update|event_delete/.test(toolName);
  return buildCalendarTelemetryDeclaration({
    sensitivity: writes ? 'high' : 'medium',
    policyDecision: writes,
  });
}

function policyDecisionFromResult(result: CalendarRecord): CalendarRecord | null {
  if (result.status !== 'refused') return null;
  return { status: 'refused', code: typeof result.reason === 'string' ? result.reason : 'calendar_write_refused' };
}

function errorCodeFromMessage(message: string): string {
  return message.split(':')[0]?.trim() || 'calendar_tool_failed';
}

async function callNamedTool(name: string, args: CalendarRecord, state: CalendarServerState): Promise<unknown> {
  switch (name) {
    case 'calendar_guidance':
      return buildGuidanceResult(args);
    case 'calendar_doctor':
      return calendarDoctor(state);
    case 'calendar_list':
      return calendarList(args, state);
    case 'calendar_event_query':
      return calendarEventQuery(args, state);
    case 'calendar_event_show':
      return calendarEventShow(args, state);
    case 'calendar_event_create':
      return calendarEventCreate(args, state);
    case 'calendar_event_update':
      return calendarEventUpdate(args, state);
    case 'calendar_event_delete':
      return calendarEventDelete(args, state);
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
}

async function calendarDoctor(state: CalendarServerState): Promise<CalendarRecord> {
  const policy = loadCalendarPolicy(state.siteRoot);
  const auth = await resolveAccessToken(state, { probeOnly: true });
  return {
    schema: 'narada.calendar_mcp.doctor.v1',
    status: 'ok',
    site_root: policy.site_root,
    graph_base_url: policy.graph_base_url,
    has_access_token: auth.available,
    auth_mode: auth.authMode,
    allowed_mailboxes: policy.allowed_mailboxes,
    allow_event_writes: policy.allow_event_writes,
    write_approval_token_configured: !!policy.write_approval_token,
    server_name: state.serverName,
  };
}

async function calendarList(args: CalendarRecord, state: CalendarServerState): Promise<CalendarRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const path = graphCalendarPath(args.mailbox_id, 'calendars', policy);
  const query = { '$top': graphTop(args.limit, 20) };
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { path, query });
  return { schema: 'narada.calendar_mcp.calendars.v1', status: 'ok', request_url: buildGraphUrl(policy, path, query), calendars: graph };
}

async function calendarEventQuery(args: CalendarRecord, state: CalendarServerState): Promise<CalendarRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const calendarId = stringOption(args.calendar_id);
  const suffix = calendarId ? `calendars/${encodeURIComponent(calendarId)}/calendarView` : 'calendarView';
  const path = graphCalendarPath(args.mailbox_id, suffix, policy);
  const query: Record<string, string | number | boolean> = {
    startDateTime: requiredString(args, 'start_datetime'),
    endDateTime: requiredString(args, 'end_datetime'),
    '$top': graphTop(args.limit, 20),
    '$orderby': typeof args.orderby === 'string' && args.orderby.trim() !== '' ? args.orderby : 'start/dateTime',
  };
  if (typeof args.select === 'string') query['$select'] = args.select;
  if (typeof args.filter === 'string') query['$filter'] = args.filter;
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { path, query });
  return { schema: 'narada.calendar_mcp.events.v1', status: 'ok', request_url: buildGraphUrl(policy, path, query), events: graph };
}

async function calendarEventShow(args: CalendarRecord, state: CalendarServerState): Promise<CalendarRecord> {
  const { policy, accessToken, fetchImpl } = await clientParts(state);
  const eventId = requiredString(args, 'event_id');
  const path = graphCalendarPath(args.mailbox_id, `events/${encodeURIComponent(eventId)}`, policy);
  const query = typeof args.select === 'string' ? { '$select': args.select } : {};
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { path, query });
  return { schema: 'narada.calendar_mcp.event.v1', status: 'ok', event: graph };
}

async function calendarEventCreate(args: CalendarRecord, state: CalendarServerState): Promise<CalendarRecord> {
  const policy = loadCalendarPolicy(state.siteRoot);
  const decision = decideEventWrite(policy, args);
  if (decision.status !== 'allowed') return refusedWrite(state, args, 'event_create_refused', decision.reason);
  const { accessToken, fetchImpl } = await clientParts(state, policy);
  const calendarId = stringOption(args.calendar_id);
  const suffix = calendarId ? `calendars/${encodeURIComponent(calendarId)}/events` : 'events';
  const path = graphCalendarPath(args.mailbox_id, suffix, policy);
  const body = eventBodyFromArgs(args, { requireTimes: true });
  recordCalendarAudit(state.siteRoot, { event_kind: 'event_create_requested', mailbox_id: args.mailbox_id ?? 'me', subject: body.subject ?? null });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'POST', path, body });
  recordCalendarAudit(state.siteRoot, { event_kind: 'event_create_completed', mailbox_id: args.mailbox_id ?? 'me', event_id: asRecord(graph).id ?? null });
  return { schema: 'narada.calendar_mcp.event.v1', status: 'created', event: graph };
}

async function calendarEventUpdate(args: CalendarRecord, state: CalendarServerState): Promise<CalendarRecord> {
  const policy = loadCalendarPolicy(state.siteRoot);
  const eventId = requiredString(args, 'event_id');
  const decision = decideEventWrite(policy, args);
  if (decision.status !== 'allowed') return refusedWrite(state, args, 'event_update_refused', decision.reason, eventId);
  const { accessToken, fetchImpl } = await clientParts(state, policy);
  const path = graphCalendarPath(args.mailbox_id, `events/${encodeURIComponent(eventId)}`, policy);
  recordCalendarAudit(state.siteRoot, { event_kind: 'event_update_requested', mailbox_id: args.mailbox_id ?? 'me', event_id: eventId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'PATCH', path, body: eventBodyFromArgs(args, { requireTimes: false }) });
  recordCalendarAudit(state.siteRoot, { event_kind: 'event_update_completed', mailbox_id: args.mailbox_id ?? 'me', event_id: eventId });
  return { schema: 'narada.calendar_mcp.event.v1', status: 'updated', event: graph };
}

async function calendarEventDelete(args: CalendarRecord, state: CalendarServerState): Promise<CalendarRecord> {
  const policy = loadCalendarPolicy(state.siteRoot);
  const eventId = requiredString(args, 'event_id');
  const decision = decideEventWrite(policy, args);
  if (decision.status !== 'allowed') return refusedWrite(state, args, 'event_delete_refused', decision.reason, eventId);
  const { accessToken, fetchImpl } = await clientParts(state, policy);
  const path = graphCalendarPath(args.mailbox_id, `events/${encodeURIComponent(eventId)}`, policy);
  recordCalendarAudit(state.siteRoot, { event_kind: 'event_delete_requested', mailbox_id: args.mailbox_id ?? 'me', event_id: eventId });
  const graph = await graphRequest({ policy, accessToken, fetchImpl }, { method: 'DELETE', path });
  recordCalendarAudit(state.siteRoot, { event_kind: 'event_delete_completed', mailbox_id: args.mailbox_id ?? 'me', event_id: eventId });
  return { schema: 'narada.calendar_mcp.event_delete.v1', status: 'deleted', result: graph };
}

function refusedWrite(state: CalendarServerState, args: CalendarRecord, eventKind: string, reason = 'event_write_refused', eventId: string | null = null): CalendarRecord {
  recordCalendarAudit(state.siteRoot, { event_kind: eventKind, mailbox_id: args.mailbox_id ?? 'me', event_id: eventId, reason });
  return { schema: 'narada.calendar_mcp.event_write.v1', status: 'refused', reason, event_id: eventId };
}

function eventBodyFromArgs(args: CalendarRecord, options: { requireTimes: boolean }): CalendarRecord {
  const body: CalendarRecord = {};
  if (typeof args.subject === 'string') body.subject = args.subject;
  if (typeof args.body_text === 'string') body.body = { contentType: 'Text', content: args.body_text };
  if (typeof args.body_html === 'string') body.body = { contentType: 'HTML', content: args.body_html };
  const hasStart = typeof args.start_datetime === 'string' && args.start_datetime.trim() !== '';
  const hasEnd = typeof args.end_datetime === 'string' && args.end_datetime.trim() !== '';
  const timeZone = typeof args.time_zone === 'string' && args.time_zone.trim() !== '' ? args.time_zone : null;
  if (options.requireTimes && (!hasStart || !hasEnd || !timeZone)) throw new Error('event_time_window_required');
  if ((hasStart || hasEnd) && !timeZone) throw new Error('time_zone_required_for_event_time');
  if (hasStart) body.start = { dateTime: args.start_datetime, timeZone };
  if (hasEnd) body.end = { dateTime: args.end_datetime, timeZone };
  if (typeof args.location === 'string') body.location = { displayName: args.location };
  if (Array.isArray(args.attendees)) body.attendees = args.attendees.map((item) => typeof item === 'string' ? { emailAddress: { address: item }, type: 'required' } : item);
  if (typeof args.is_online_meeting === 'boolean') body.isOnlineMeeting = args.is_online_meeting;
  if (typeof args.online_meeting_provider === 'string') body.onlineMeetingProvider = args.online_meeting_provider;
  if (typeof args.show_as === 'string') body.showAs = args.show_as;
  if (typeof args.sensitivity === 'string') body.sensitivity = args.sensitivity;
  return body;
}

async function clientParts(state: CalendarServerState, policy = loadCalendarPolicy(state.siteRoot)) {
  const auth = await resolveAccessToken(state);
  return { policy, accessToken: auth.accessToken, fetchImpl: state.fetchImpl };
}

async function resolveAccessToken(state: CalendarServerState, options: { probeOnly?: boolean } = {}): Promise<{ available: true; accessToken: string; authMode: string } | { available: false; accessToken: null; authMode: 'missing' }> {
  if (state.accessToken) return { available: true, accessToken: state.accessToken, authMode: 'access_token' };
  if (!state.tenantId || !state.clientId || !state.clientSecret) {
    if (options.probeOnly) return { available: false, accessToken: null, authMode: 'missing' };
    throw new Error('ms_graph_auth_required: set MS_GRAPH_ACCESS_TOKEN or GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET');
  }
  if (state.tokenCache && state.tokenCache.expiresAtMs > Date.now() + 60_000) return { available: true, accessToken: state.tokenCache.accessToken, authMode: 'client_credentials' };
  if (options.probeOnly) return { available: true, accessToken: '<client_credentials_available>', authMode: 'client_credentials' };
  const endpoint = state.tokenEndpoint ?? `https://login.microsoftonline.com/${encodeURIComponent(state.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({ client_id: state.clientId, client_secret: state.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const response = await state.fetchImpl(endpoint, { method: 'POST', body } as RequestInit);
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!response.ok || response.status < 200 || response.status >= 300) throw new Error(`ms_graph_token_request_failed:${response.status}:${redactTokenResponse(text || response.statusText || 'unknown_error')}`);
  let payload: CalendarRecord;
  try {
    payload = asRecord(JSON.parse(text));
  } catch {
    throw new Error('ms_graph_token_response_invalid_json');
  }
  const accessToken = stringOption(payload.access_token);
  if (!accessToken) throw new Error('ms_graph_token_response_missing_access_token');
  const expiresInSeconds = Number(payload.expires_in ?? 3599);
  state.tokenCache = { accessToken, expiresAtMs: Date.now() + Math.max(60, Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3599) * 1000 };
  return { available: true, accessToken, authMode: 'client_credentials' };
}

function loadCalendarEnvironment(siteRoot: string): Record<string, string> {
  return { ...readEnvFile(resolve(siteRoot, '..', '.env')), ...readEnvFile(resolve(siteRoot, '.env')), ...process.env };
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([^#=\s]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function stringOption(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function redactTokenResponse(text: string): string {
  return text.replace(/("(?:access_token|client_secret|refresh_token)"\s*:\s*")([^"]+)(")/gi, '$1<redacted>$3');
}

function tool(name: string, description: string, properties: unknown, required: string[] = []): unknown {
  return {
    name,
    description,
    annotations: toolAnnotations(name),
    inputSchema: { type: 'object', properties, additionalProperties: false, ...(required.length > 0 ? { required } : {}) },
    outputSchema: { type: 'object', additionalProperties: true },
  };
}

function toolAnnotations(name: string) {
  const writes = /event_create|event_update|event_delete/.test(name);
  return {
    title: name,
    readOnlyHint: !writes,
    destructiveHint: /event_delete/.test(name),
    idempotentHint: /doctor|list|query|show/.test(name),
    openWorldHint: true,
  };
}

function parseArgs(argv: string[]): CalendarRecord {
  const parsed: CalendarRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function drainJsonRpcFrames(buffer: string): { requests: CalendarRecord[]; remaining: string } {
  const requests: CalendarRecord[] = [];
  let rest = buffer;
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    const separatorLength = headerEnd >= 0 ? 4 : 2;
    const lfHeaderEnd = headerEnd >= 0 ? headerEnd : rest.indexOf('\n\n');
    if (lfHeaderEnd < 0) break;
    const match = /^Content-Length:\s*(\d+)/im.exec(rest.slice(0, lfHeaderEnd));
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = lfHeaderEnd + separatorLength;
    if (rest.length < bodyStart + length) break;
    requests.push(asRecord(JSON.parse(rest.slice(bodyStart, bodyStart + length))));
    rest = rest.slice(bodyStart + length);
  }
  return { requests, remaining: rest };
}

function writeJsonRpcResponse(payload: unknown, options: unknown = {}): void {
  const text = JSON.stringify(payload);
  if (asRecord(options).framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
  else process.stdout.write(`${text}\n`);
}

function errorDiagnostic(error: unknown): { schema: string; message: string } {
  return { schema: 'narada.calendar_mcp.error.v1', message: error instanceof Error ? error.message : String(error) };
}
