#!/usr/bin/env node
import { resolve } from 'node:path';
import { admitEnvelope, emitEnvelopeAcknowledged, emitEnvelopeDismissed, emitEnvelopePromoted, readAdmissionLog } from './admission-log.js';
import { INBOX_ENVELOPE_KINDS, assertKnownInboxEnvelopeKind } from './envelope-kinds.js';
import { readInboxEnvelopeById, readIndexedInboxBacklog, readIndexedInboxRows, readInboxIndexCounts, refreshInboxIndex } from './inbox-index.js';
import { evaluateEnvelopeSeverity } from './inbox-policy.js';

const SERVER_NAME = 'narada-site-inbox-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const INBOX_STATUSES = Object.freeze(['received', 'acknowledged', 'dismissed', 'promoted']);
const INBOX_ACTIONS = Object.freeze([
  'acknowledge',
  'acknowledge_duplicate',
  'archive',
  'materialize',
  'review',
  'review_capa_request',
  'triage',
]);
const TARGET_ROLES = Object.freeze(['architect', 'builder', 'operator']);

type InboxRecord = Record<string, unknown>;
type InboxServerState = InboxRecord & { siteRoot: string; serverName: string };

function asRecord(value: unknown): InboxRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as InboxRecord : {};
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export async function runStdioServer(options: unknown): Promise<void> {
  const state = createServerState(options);
  const activeRequests = new Map<string, AbortController>();
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let requests: InboxRecord[];
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
      if (!request.id && request.method === 'notifications/cancelled') {
        const requestId = String(asRecord(request.params).requestId ?? '');
        activeRequests.get(requestId)?.abort();
        continue;
      }
      if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) continue;
      const requestId = String(request.id ?? '');
      const abortController = new AbortController();
      activeRequests.set(requestId, abortController);
      sendProgress(request, 0, 'started', { framed: sawFramedInput });
      const response = handleRequest(request, state);
      sendProgress(request, 1, abortController.signal.aborted ? 'cancelled' : 'completed', { framed: sawFramedInput });
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
      activeRequests.delete(requestId);
    }
  }
}

export function createServerState(options: unknown = {}): InboxServerState {
  const optionsRecord = asRecord(options);
  return {
    siteRoot: resolve(String(optionsRecord.siteRoot ?? process.cwd())),
    serverName: String(optionsRecord.serverName ?? SERVER_NAME),
  };
}

export function handleRequest(request: InboxRecord, state: InboxServerState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

function dispatchMethod(method: string, params: InboxRecord, state: InboxServerState) {
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
      return { prompts: listPrompts() };
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

function listPrompts() {
  return [{ name: 'inbox_triage_workflow', title: 'Inbox Triage Workflow', description: 'Guidance for inbox intake and triage.', arguments: [] }];
}

function promptGet(params: InboxRecord) {
  const name = String(params.name ?? '');
  if (name !== 'inbox_triage_workflow') throw new Error(`unknown_prompt: ${name}`);
  return {
    description: 'Guidance for inbox intake and triage.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Use inbox_list or inbox_next to inspect actionable envelopes, then use inbox_show before disposition or follow-up workflows.' } }],
  };
}

function completeArgument(params: InboxRecord) {
  const argumentName = String(asRecord(asRecord(params).argument).name ?? '');
  const values = argumentName === 'name' ? listTools().map((tool: any) => tool.name).filter(Boolean).slice(0, 100) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

export function listTools(): unknown[] {
  return [
    tool('inbox_doctor', 'Inspect site-local inbox MCP readiness.', {}),
    tool('inbox_list', 'List site-local inbox envelopes ordered by actionability.', {
      status: { type: 'string', enum: INBOX_STATUSES, default: 'received', description: 'Optional status filter. Defaults to received.' },
      kind: { type: 'string', enum: INBOX_ENVELOPE_KINDS, description: 'Optional envelope kind filter.' },
      target_role: { type: 'string', enum: TARGET_ROLES, description: 'Optional target role filter.' },
      action: { type: 'string', enum: INBOX_ACTIONS, description: 'Optional triage action filter.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum envelopes. Defaults to 20.' },
    }),
    tool('inbox_show', 'Show one site-local inbox envelope by envelope_id.', {
      envelope_id: { type: 'string', description: 'Envelope id such as env_...' },
    }, ['envelope_id']),
    tool('inbox_submit', 'Submit one site-local inbox envelope and admit it to the local inbox log.', {
      kind: { type: 'string', enum: INBOX_ENVELOPE_KINDS, description: 'Envelope kind.' },
      title: { type: 'string', description: 'Envelope title.' },
      summary: { type: 'string', default: null, description: 'Optional summary.' },
      principal: { type: 'string', description: 'Submitting principal.' },
      target_role: { type: 'string', enum: TARGET_ROLES, description: 'Optional target role.' },
      severity: { type: 'integer', minimum: 0, maximum: 100, description: 'Optional explicit severity.' },
      authority_level: { type: 'string', enum: ['agent_reported', 'operator_confirmed', 'operator_directed'], default: 'agent_reported', description: 'Authority level for this submission.' },
      payload: { type: 'object', default: {}, description: 'Optional payload object.' },
    }, ['kind', 'title', 'principal']),
    tool('inbox_acknowledge', 'Acknowledge an envelope — mark it as reviewed with no further action needed.', {
      envelope_id: { type: 'string', description: 'Envelope id such as env_...' },
      principal: { type: 'string', description: 'Principal performing the acknowledgment.' },
      reason: { type: 'string', description: 'Optional reason for acknowledgment.' },
    }, ['envelope_id', 'principal']),
    tool('inbox_dismiss', 'Dismiss an envelope — mark it as rejected or superseded.', {
      envelope_id: { type: 'string', description: 'Envelope id such as env_...' },
      principal: { type: 'string', description: 'Principal performing the dismissal.' },
      reason: { type: 'string', description: 'Required reason for dismissal.' },
    }, ['envelope_id', 'principal', 'reason']),
    tool('inbox_promote_capa', 'Promote an envelope to CAPA review status.', {
      envelope_id: { type: 'string', description: 'Envelope id such as env_...' },
      principal: { type: 'string', description: 'Principal performing the promotion.' },
      reason: { type: 'string', description: 'Optional promotion rationale.' },
    }, ['envelope_id', 'principal']),
    tool('inbox_audit', 'Read recent admission log entries.', {
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Maximum entries. Defaults to 50.' },
      envelope_id: { type: 'string', description: 'Optional envelope id filter.' },
    }),
    tool('inbox_next', 'Return the next site-local inbox envelope for triage.', {
      target_role: { type: 'string', enum: TARGET_ROLES, description: 'Optional target role filter.' },
    }),
    tool('capa_queue', 'List inbox envelopes classified as CAPA review candidates.', {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum envelopes. Defaults to 20.' },
    }),
  ];
}

function callTool(params: InboxRecord, state: InboxServerState) {
  const name = params.name;
  const args = asRecord(params.arguments);
  let result: unknown;
  switch (name) {
    case 'inbox_doctor':
      result = inboxDoctor(state);
      break;
    case 'inbox_list':
      result = inboxList(args, state);
      break;
    case 'inbox_show':
      result = inboxShow(args, state);
      break;
    case 'inbox_submit':
      result = inboxSubmit(args, state);
      break;
    case 'inbox_acknowledge':
      result = inboxAcknowledge(args, state);
      break;
    case 'inbox_dismiss':
      result = inboxDismiss(args, state);
      break;
    case 'inbox_promote_capa':
      result = inboxPromoteCapa(args, state);
      break;
    case 'inbox_audit':
      result = inboxAudit(args, state);
      break;
    case 'inbox_next':
      result = inboxNext(args, state);
      break;
    case 'capa_queue':
      result = capaQueue(args, state);
      break;
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
  return { content: [assistantTextContent(JSON.stringify(result, null, 2))], structuredContent: result };
}

function assistantTextContent(text: string) {
  return { type: 'text', text, annotations: { audience: ['assistant'] } };
}

function inboxSubmit(args: InboxRecord, state: InboxServerState): InboxRecord {
  const kind = assertKnownInboxEnvelopeKind(requiredString(args, 'kind'));
  const title = requiredString(args, 'title');
  const principal = requiredString(args, 'principal');
  const envelope = {
    kind,
    title,
    summary: args.summary ?? null,
    status: 'received',
    target_role: args.target_role ?? null,
    severity: Number.isFinite(args.severity) ? Number(args.severity) : undefined,
    authority: { level: args.authority_level ?? 'agent_reported', principal },
    source: { kind: 'inbox_mcp_submit', principal },
    payload: {
      ...asRecord(args.payload),
      title,
      summary: args.summary ?? null,
      principal,
    },
  };
  const result = admitEnvelope(state.siteRoot, envelope);
  const index = refreshInboxIndex(state.siteRoot, { evaluateEnvelopeSeverity });
  index.db?.close();
  const event = asRecord(result.event);
  return {
    status: 'admitted',
    site_root: state.siteRoot,
    envelope_id: event.envelope_id,
    envelope_path: result.envelopePath,
    event_id: event.event_id,
    event_sequence: event.event_sequence,
  };
}

function inboxDoctor(state: InboxServerState): InboxRecord {
  const counts = readInboxIndexCounts(state.siteRoot, { evaluateEnvelopeSeverity });
  const countRecord = asRecord(counts);
  return {
    status: 'ok',
    site_root: state.siteRoot,
    db_path: countRecord.db_path,
    storage_mode: countRecord.storage,
    indexed_count: countRecord.indexed_count,
    invalid_count: countRecord.invalid_count,
    counts: countRecord.counts,
    server_name: state.serverName,
  };
}

function inboxList(args: InboxRecord, state: InboxServerState): InboxRecord {
  const limit = boundedLimit(args.limit, 20);
  const status = optionalEnum(args.status ?? 'received', INBOX_STATUSES, 'status');
  const kind = optionalEnum(args.kind, INBOX_ENVELOPE_KINDS, 'kind');
  const targetRole = optionalEnum(args.target_role, TARGET_ROLES, 'target_role');
  const action = optionalEnum(args.action, INBOX_ACTIONS, 'action');
  const index = asRecord(readIndexedInboxRows(state.siteRoot, { evaluateEnvelopeSeverity }));
  const rows = Array.isArray(index.rows) ? index.rows.map(asRecord).filter((row) => {
    if (status && row.status !== status) return false;
    if (kind && row.kind !== kind) return false;
    if (targetRole && row.target_role !== targetRole) return false;
    if (action && row.action !== action) return false;
    return true;
  }) : [];
  return {
    status: 'ok',
    site_root: state.siteRoot,
    storage_mode: index.storage ?? 'node_sqlite',
    filters: { status, kind: kind ?? null, target_role: targetRole ?? null, action: action ?? null },
    count: rows.length,
    envelopes: rows.slice(0, limit).map(summarizeRow),
  };
}

function inboxShow(args: InboxRecord, state: InboxServerState): InboxRecord {
  const envelopeId = requiredString(args, 'envelope_id');
  const row = readInboxEnvelopeById(state.siteRoot, envelopeId, { evaluateEnvelopeSeverity });
  if (!row) return { status: 'not_found', envelope_id: envelopeId };
  const rowRecord = asRecord(row);
  return { status: 'ok', site_root: state.siteRoot, envelope: { ...summarizeRow(rowRecord), payload: JSON.parse(String(rowRecord.payload_json)) } };
}

function inboxNext(args: InboxRecord, state: InboxServerState): InboxRecord {
  const targetRole = args.target_role ?? null;
  const backlog = asRecord(readIndexedInboxBacklog(state.siteRoot, { evaluateEnvelopeSeverity }));
  const rows = Array.isArray(backlog.rows)
    ? backlog.rows.map(asRecord).filter((row) => !targetRole || row.target_role === targetRole)
    : [];
  return { status: rows.length > 0 ? 'ok' : 'empty', site_root: state.siteRoot, envelope: rows[0] ? summarizeRow(rows[0]) : null };
}

function capaQueue(args: InboxRecord, state: InboxServerState): InboxRecord {
  const limit = boundedLimit(args.limit, 20);
  const backlog = asRecord(readIndexedInboxBacklog(state.siteRoot, { evaluateEnvelopeSeverity }));
  const rows = Array.isArray(backlog.rows)
    ? backlog.rows.map(asRecord).filter((row) => row.action === 'review_capa_request' || row.kind === 'incident')
    : [];
  return { status: 'ok', site_root: state.siteRoot, count: rows.length, envelopes: rows.slice(0, limit).map(summarizeRow) };
}

function inboxAcknowledge(args: InboxRecord, state: InboxServerState): InboxRecord {
  const envelopeId = requiredString(args, 'envelope_id');
  const principal = requiredString(args, 'principal');
  const row = readInboxEnvelopeById(state.siteRoot, envelopeId, { evaluateEnvelopeSeverity });
  if (!row) return { status: 'not_found', envelope_id: envelopeId };
  const event = emitEnvelopeAcknowledged(state.siteRoot, envelopeId, principal, typeof args.reason === 'string' ? args.reason : undefined);
  refreshInboxIndex(state.siteRoot, { evaluateEnvelopeSeverity }).db?.close();
  return { status: 'acknowledged', envelope_id: envelopeId, event_id: event.event_id, event_sequence: event.event_sequence };
}

function inboxDismiss(args: InboxRecord, state: InboxServerState): InboxRecord {
  const envelopeId = requiredString(args, 'envelope_id');
  const principal = requiredString(args, 'principal');
  const reason = requiredString(args, 'reason');
  const row = readInboxEnvelopeById(state.siteRoot, envelopeId, { evaluateEnvelopeSeverity });
  if (!row) return { status: 'not_found', envelope_id: envelopeId };
  const event = emitEnvelopeDismissed(state.siteRoot, envelopeId, principal, reason);
  refreshInboxIndex(state.siteRoot, { evaluateEnvelopeSeverity }).db?.close();
  return { status: 'dismissed', envelope_id: envelopeId, reason, event_id: event.event_id, event_sequence: event.event_sequence };
}

function inboxPromoteCapa(args: InboxRecord, state: InboxServerState): InboxRecord {
  const envelopeId = requiredString(args, 'envelope_id');
  const principal = requiredString(args, 'principal');
  const row = readInboxEnvelopeById(state.siteRoot, envelopeId, { evaluateEnvelopeSeverity });
  if (!row) return { status: 'not_found', envelope_id: envelopeId };
  const event = emitEnvelopePromoted(state.siteRoot, envelopeId, principal, typeof args.reason === 'string' ? args.reason : undefined);
  refreshInboxIndex(state.siteRoot, { evaluateEnvelopeSeverity }).db?.close();
  return { status: 'promoted', envelope_id: envelopeId, event_id: event.event_id, event_sequence: event.event_sequence };
}

function inboxAudit(args: InboxRecord, state: InboxServerState): InboxRecord {
  const limit = boundedLimit(args.limit, 50);
  const envelopeId = typeof args.envelope_id === 'string' ? args.envelope_id : null;
  let entries = readAdmissionLog(state.siteRoot);
  if (envelopeId) entries = entries.filter((e) => String(e.envelope_id) === envelopeId);
  const recent = entries.slice(-limit).reverse();
  return {
    status: 'ok',
    site_root: state.siteRoot,
    total_entries: entries.length,
    count: recent.length,
    entries: recent.map((e) => ({
      event_id: e.event_id,
      event_sequence: e.event_sequence,
      event_kind: e.event_kind,
      envelope_id: e.envelope_id,
      principal: e.principal,
      timestamp: e.timestamp,
      payload: e.event_payload,
    })),
  };
}

function summarizeRow(row: unknown): InboxRecord {
  const rowRecord = asRecord(row);
  return {
    envelope_id: rowRecord.envelope_id,
    status: rowRecord.status,
    kind: rowRecord.kind,
    title: rowRecord.title,
    summary: rowRecord.summary,
    received_at: rowRecord.received_at,
    target_role: rowRecord.target_role,
    severity: rowRecord.severity,
    severity_reason: rowRecord.severity_reason,
    action: rowRecord.action,
    file_path: rowRecord.file_path,
  };
}

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function optionalEnum(value: unknown, allowed: readonly string[], key: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${key}_must_be_one_of: ${allowed.join(',')}`);
  }
  return value;
}

function requiredString(args: unknown, key: string): string {
  const value = asRecord(args)[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key}_required`);
  return value;
}

function tool(name: string, description: string, properties: unknown, required: string[] = []): unknown {
  return {
    name,
    description,
    annotations: toolAnnotations(name),
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
    },
    outputSchema: genericToolOutputSchema(),
  };
}

function toolAnnotations(name: string) {
  const writes = /submit|acknowledge|dismiss|promote/.test(name);
  return {
    title: name,
    readOnlyHint: !writes,
    destructiveHint: name === 'inbox_dismiss',
    idempotentHint: /doctor|list|show|queue|audit/.test(name),
    openWorldHint: false,
  };
}

function genericToolOutputSchema() {
  return { type: 'object', additionalProperties: true };
}

function parseArgs(argv: string[]): InboxRecord {
  const parsed: InboxRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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

function drainJsonRpcFrames(buffer: string): { requests: InboxRecord[]; remaining: string } {
  const requests: InboxRecord[] = [];
  let rest = buffer;
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    const separatorLength = headerEnd >= 0 ? 4 : 2;
    const lfHeaderEnd = headerEnd >= 0 ? headerEnd : rest.indexOf('\n\n');
    if (lfHeaderEnd < 0) break;
    const header = rest.slice(0, lfHeaderEnd);
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
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
  const optionsRecord = asRecord(options);
  const text = JSON.stringify(payload);
  if (optionsRecord.framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
  else process.stdout.write(`${text}\n`);
}

function sendProgress(request: InboxRecord, progress: number, message: string, options: unknown): void {
  const progressToken = asRecord(asRecord(request.params)._meta).progressToken;
  if (progressToken === undefined) return;
  writeJsonRpcResponse({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken, progress, total: 1, message },
  }, options);
}

function errorDiagnostic(error: unknown): { schema: string; message: string } {
  return {
    schema: 'narada.inbox_mcp.error.v1',
    message: error instanceof Error ? error.message : String(error),
  };
}
