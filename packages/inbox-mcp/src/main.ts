#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { admitEnvelope } from './admission-log.js';
import { INBOX_ENVELOPE_KINDS, assertKnownInboxEnvelopeKind } from './envelope-kinds.js';
import { readInboxEnvelopeById, readIndexedInboxBacklog, readIndexedInboxRows, readInboxIndexCounts, refreshInboxIndex } from './inbox-index.js';
import { evaluateEnvelopeSeverity } from './inbox-policy.js';

const SERVER_NAME = 'narada-inbox-mcp';
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

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export async function runStdioServer(options: any): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let requests: any[];
    if (buffer.includes('Content-Length:')) {
      sawFramedInput = true;
      const drained = drainJsonRpcFrames(buffer);
      buffer = drained.remaining;
      requests = drained.requests;
    } else {
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      requests = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
    }
    for (const request of requests) {
      const response = handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

export function createServerState(options: any = {}): any {
  return { siteRoot: resolve(options.siteRoot ?? process.cwd()), serverName: options.serverName ?? SERVER_NAME };
}

export function handleRequest(request: any, state: any): any {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(request.method, request.params ?? {}, state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

function dispatchMethod(method: string, params: any, state: any): any {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: state.serverName, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return callTool(params, state);
    default:
      throw new Error(`unsupported_mcp_method: ${method}`);
  }
}

export function listTools(): any[] {
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
      payload: { type: 'object', default: {}, description: 'Optional payload object.' },
    }, ['kind', 'title', 'principal']),
    tool('inbox_next', 'Return the next site-local inbox envelope for triage.', {
      target_role: { type: 'string', enum: TARGET_ROLES, description: 'Optional target role filter.' },
    }),
    tool('capa_queue', 'List inbox envelopes classified as CAPA review candidates.', {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum envelopes. Defaults to 20.' },
    }),
    tool('capability_next', 'Return pending local capability-review items when the capability surface exists.', {}),
  ];
}

function callTool(params: any, state: any): any {
  const name = params?.name;
  const args = params?.arguments ?? {};
  let result: any;
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
    case 'inbox_next':
      result = inboxNext(args, state);
      break;
    case 'capa_queue':
      result = capaQueue(args, state);
      break;
    case 'capability_next':
      result = capabilityNext(state);
      break;
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
  return { structuredContent: result };
}

function inboxSubmit(args: any, state: any): any {
  const kind = assertKnownInboxEnvelopeKind(requiredString(args, 'kind'));
  const title = requiredString(args, 'title');
  const principal = requiredString(args, 'principal');
  const envelope = {
    kind,
    title,
    summary: args.summary ?? null,
    status: 'received',
    target_role: args.target_role ?? null,
    severity: Number.isFinite(args.severity) ? args.severity : undefined,
    authority: { level: 'agent_reported', principal },
    source: { kind: 'inbox_mcp_submit', principal },
    payload: {
      ...(args.payload && typeof args.payload === 'object' ? args.payload : {}),
      title,
      summary: args.summary ?? null,
      principal,
    },
  };
  const result = admitEnvelope(state.siteRoot, envelope);
  const index = refreshInboxIndex(state.siteRoot, { evaluateEnvelopeSeverity });
  index.db?.close();
  return {
    status: 'admitted',
    site_root: state.siteRoot,
    envelope_id: result.event.envelope_id,
    envelope_path: result.envelopePath,
    event_id: result.event.event_id,
    event_sequence: result.event.event_sequence,
  };
}

function inboxDoctor(state: any): any {
  const counts = readInboxIndexCounts(state.siteRoot, { evaluateEnvelopeSeverity });
  return {
    status: 'ok',
    site_root: state.siteRoot,
    db_path: counts.db_path,
    storage_mode: counts.storage,
    indexed_count: counts.indexed_count,
    invalid_count: counts.invalid_count,
    counts: counts.counts,
    server_name: state.serverName,
  };
}

function inboxList(args: any, state: any): any {
  const limit = boundedLimit(args.limit, 20);
  const status = optionalEnum(args.status ?? 'received', INBOX_STATUSES, 'status');
  const kind = optionalEnum(args.kind, INBOX_ENVELOPE_KINDS, 'kind');
  const targetRole = optionalEnum(args.target_role, TARGET_ROLES, 'target_role');
  const action = optionalEnum(args.action, INBOX_ACTIONS, 'action');
  const index = readIndexedInboxRows(state.siteRoot, { evaluateEnvelopeSeverity });
  const rows = index.rows.filter((row: any) => {
    if (status && row.status !== status) return false;
    if (kind && row.kind !== kind) return false;
    if (targetRole && row.target_role !== targetRole) return false;
    if (action && row.action !== action) return false;
    return true;
  });
  return {
    status: 'ok',
    site_root: state.siteRoot,
    storage_mode: index.storage ?? 'node_sqlite',
    filters: { status, kind: kind ?? null, target_role: targetRole ?? null, action: action ?? null },
    count: rows.length,
    envelopes: rows.slice(0, limit).map(summarizeRow),
  };
}

function inboxShow(args: any, state: any): any {
  const envelopeId = requiredString(args, 'envelope_id');
  const row = readInboxEnvelopeById(state.siteRoot, envelopeId, { evaluateEnvelopeSeverity });
  if (!row) return { status: 'not_found', envelope_id: envelopeId };
  return { status: 'ok', site_root: state.siteRoot, envelope: { ...summarizeRow(row), payload: JSON.parse(row.payload_json) } };
}

function inboxNext(args: any, state: any): any {
  const targetRole = args.target_role ?? null;
  const rows = readIndexedInboxBacklog(state.siteRoot, { evaluateEnvelopeSeverity }).rows
    .filter((row: any) => !targetRole || row.target_role === targetRole);
  return { status: rows.length > 0 ? 'ok' : 'empty', site_root: state.siteRoot, envelope: rows[0] ? summarizeRow(rows[0]) : null };
}

function capaQueue(args: any, state: any): any {
  const limit = boundedLimit(args.limit, 20);
  const rows = readIndexedInboxBacklog(state.siteRoot, { evaluateEnvelopeSeverity }).rows
    .filter((row: any) => row.action === 'review_capa_request' || row.kind === 'incident');
  return { status: 'ok', site_root: state.siteRoot, count: rows.length, envelopes: rows.slice(0, limit).map(summarizeRow) };
}

function capabilityNext(state: any): any {
  const path = join(state.siteRoot, 'operator-surfaces', 'capability-announcements.json');
  if (!existsSync(path)) {
    return { status: 'not_configured', site_root: state.siteRoot, message: 'No local capability announcements file exists.' };
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const capabilities = Array.isArray(doc.capabilities) ? doc.capabilities : [];
  const next = capabilities.find((item: any) => item.review_status !== 'completed') ?? null;
  return { status: next ? 'ok' : 'empty', site_root: state.siteRoot, capability: next };
}

function summarizeRow(row: any): any {
  return {
    envelope_id: row.envelope_id,
    status: row.status,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    received_at: row.received_at,
    target_role: row.target_role,
    severity: row.severity,
    severity_reason: row.severity_reason,
    action: row.action,
    file_path: row.file_path,
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

function requiredString(args: any, key: string): string {
  const value = args?.[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key}_required`);
  return value;
}

function tool(name: string, description: string, properties: any, required: string[] = []): any {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

function parseArgs(argv: string[]): any {
  const parsed: any = {};
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

function drainJsonRpcFrames(buffer: string): any {
  const requests: any[] = [];
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
    requests.push(JSON.parse(rest.slice(bodyStart, bodyStart + length)));
    rest = rest.slice(bodyStart + length);
  }
  return { requests, remaining: rest };
}

function writeJsonRpcResponse(payload: any, options: any = {}): void {
  const text = JSON.stringify(payload);
  if (options.framed) process.stdout.write(`Content-Length: ${Buffer.byteLength(text, 'utf8')}\r\n\r\n${text}`);
  else process.stdout.write(`${text}\n`);
}

function errorDiagnostic(error: unknown): any {
  return {
    schema: 'narada.inbox_mcp.error.v1',
    message: error instanceof Error ? error.message : String(error),
  };
}
