#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SERVER_NAME = 'surface-feedback-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const FEEDBACK_KINDS = ['bug', 'improvement', 'gap', 'observation'] as const;
const FEEDBACK_STATUSES = ['submitted', 'acknowledged', 'routed', 'closed'] as const;

type JsonRecord = Record<string, unknown>;

type FeedbackState = {
  feedbackRoot: string;
  db: DatabaseSync;
};

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS feedback_entries (
    feedback_id TEXT PRIMARY KEY,
    surface_id TEXT NOT NULL,
    submitter_site_id TEXT NOT NULL,
    submitter_principal TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
];

export function createServerState(options: JsonRecord = {}): FeedbackState {
  const feedbackRoot = resolve(String(options.feedbackRoot ?? options.outputRoot ?? process.cwd()));
  const dbPath = resolve(feedbackRoot, '.feedback', 'surface-feedback.db');
  const dbDir = resolve(dbPath, '..');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  for (const sql of CREATE_TABLES) db.exec(sql);
  return { feedbackRoot, db };
}

export async function handleRequest(request: JsonRecord, state: FeedbackState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = dispatchMethod(String(request.method), asRecord(request.params), state);
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

function dispatchMethod(method: string, params: JsonRecord, state: FeedbackState) {
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
    {
      name: 'surface_feedback_submit',
      description: 'Submit feedback about an MCP surface. Cross-site: any site may submit feedback about any surface.',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string', description: 'Surface identifier, e.g. sop or scheduler.' },
          submitter_site_id: { type: 'string', description: 'Site ID of the submitter, e.g. narada-sonar.' },
          submitter_principal: { type: 'string', description: 'Principal submitting the feedback.' },
          kind: { type: 'string', enum: FEEDBACK_KINDS, description: 'Feedback kind.' },
          summary: { type: 'string', description: 'One-line summary.' },
          details: { type: 'string', description: 'Extended description or context.' },
        },
        required: ['surface_id', 'submitter_site_id', 'submitter_principal', 'kind', 'summary'],
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_submit', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'surface_feedback_list',
      description: 'List feedback entries with optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string' },
          submitter_site_id: { type: 'string' },
          kind: { type: 'string', enum: FEEDBACK_KINDS },
          status: { type: 'string', enum: FEEDBACK_STATUSES },
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'surface_feedback_show',
      description: 'Show one feedback entry by feedback_id.',
      inputSchema: {
        type: 'object',
        properties: { feedback_id: { type: 'string' } },
        required: ['feedback_id'],
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

function callTool(params: JsonRecord, state: FeedbackState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'surface_feedback_submit': result = feedbackSubmit(args, state); break;
    case 'surface_feedback_list': result = feedbackList(args, state); break;
    case 'surface_feedback_show': result = feedbackShow(args, state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function feedbackSubmit(args: JsonRecord, state: FeedbackState): JsonRecord {
  const surfaceId = requiredString(args.surface_id, 'feedback_requires_surface_id');
  const siteId = requiredString(args.submitter_site_id, 'feedback_requires_submitter_site_id');
  const principal = requiredString(args.submitter_principal, 'feedback_requires_submitter_principal');
  const kind = requiredString(args.kind, 'feedback_requires_kind');
  if (!FEEDBACK_KINDS.includes(kind as typeof FEEDBACK_KINDS[number])) throw diagnosticError('feedback_invalid_kind', `feedback_invalid_kind:${kind}`, { allowed: FEEDBACK_KINDS });
  const summary = requiredString(args.summary, 'feedback_requires_summary');
  const details = optionalString(args.details) ?? '';
  const feedbackId = `sfb_${randomUUID().slice(0, 12)}`;
  const now = nowIso();
  state.db.prepare(
    'INSERT INTO feedback_entries (feedback_id, surface_id, submitter_site_id, submitter_principal, kind, summary, details, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(feedbackId, surfaceId, siteId, principal, kind, summary, details, 'submitted', now, now);
  return { status: 'submitted', feedback_id: feedbackId, surface_id: surfaceId, submitter_site_id: siteId, kind, summary, created_at: now };
}

function feedbackList(args: JsonRecord, state: FeedbackState): JsonRecord {
  const limit = clamp(integer(args.limit, 50, 1, 200), 1, 200);
  const surfaceId = optionalString(args.surface_id);
  const siteId = optionalString(args.submitter_site_id);
  const kind = optionalString(args.kind);
  const status = optionalString(args.status);
  let sql = 'SELECT * FROM feedback_entries WHERE 1=1';
  const params: (string | number)[] = [];
  if (surfaceId) { sql += ' AND surface_id = ?'; params.push(surfaceId); }
  if (siteId) { sql += ' AND submitter_site_id = ?'; params.push(siteId); }
  if (kind) { sql += ' AND kind = ?'; params.push(kind); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = state.db.prepare(sql).all(...params) as JsonRecord[];
  return { items: rows.map(hydrateFeedback), count: rows.length };
}

function feedbackShow(args: JsonRecord, state: FeedbackState): JsonRecord {
  const feedbackId = requiredString(args.feedback_id, 'feedback_requires_feedback_id');
  const row = state.db.prepare('SELECT * FROM feedback_entries WHERE feedback_id = ?').get(feedbackId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('feedback_not_found', `feedback_not_found:${feedbackId}`);
  return hydrateFeedback(row);
}

function hydrateFeedback(row: JsonRecord): JsonRecord {
  return {
    feedback_id: String(row.feedback_id),
    surface_id: String(row.surface_id),
    submitter_site_id: String(row.submitter_site_id),
    submitter_principal: String(row.submitter_principal),
    kind: String(row.kind),
    summary: String(row.summary),
    details: String(row.details),
    status: String(row.status),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function renderResult(result: JsonRecord): string {
  if (result.items !== undefined) {
    const items = result.items as JsonRecord[];
    return [`feedback: ${result.count ?? 0} entries`, ...items.map((i) => `  ${i.feedback_id} [${i.kind}] ${String(i.summary ?? '').slice(0, 80)} (${i.surface_id} <- ${i.submitter_site_id})`)].join('\n');
  }
  if (result.feedback_id) return `feedback: ${result.feedback_id} [${result.kind}] ${result.summary} (${result.surface_id} <- ${result.submitter_site_id})`;
  return `${result.status ?? 'ok'}: ${result.feedback_id ?? ''}`;
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

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return { schema: 'narada.surface_feedback.error.v1', code: String(record.codeName ?? 'surface_feedback_error'), message: error instanceof Error ? error.message : String(error), details: asRecord(record.details) };
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

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feedback-root') options.feedbackRoot = argv[++i];
    else if (arg === '--output-root') options.outputRoot = argv[++i];
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
