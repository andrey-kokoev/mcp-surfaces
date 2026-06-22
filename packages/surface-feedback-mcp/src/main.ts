#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
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
  dbPath: string;
  canonicalFeedbackRoot: string;
  db: DatabaseSync;
};

const DEFAULT_CANONICAL_FEEDBACK_ROOT = 'D:/code/mcp-surfaces';

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
    resolution_note TEXT,
    resolved_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
];

export function createServerState(options: JsonRecord = {}): FeedbackState {
  const feedbackRoot = resolve(String(options.feedbackRoot ?? options.outputRoot ?? process.cwd()));
  const canonicalFeedbackRoot = resolve(String(options.canonicalFeedbackRoot ?? process.env.NARADA_SURFACE_FEEDBACK_ROOT ?? DEFAULT_CANONICAL_FEEDBACK_ROOT));
  const dbPath = resolve(feedbackRoot, '.feedback', 'surface-feedback.db');
  const dbDir = resolve(dbPath, '..');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  for (const sql of CREATE_TABLES) db.exec(sql);
  ensureColumn(db, 'feedback_entries', 'resolution_note', 'TEXT');
  ensureColumn(db, 'feedback_entries', 'resolved_by', 'TEXT');
  return { feedbackRoot, dbPath, canonicalFeedbackRoot, db };
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
      name: 'surface_feedback_doctor',
      description: 'Inspect surface feedback MCP storage posture and backing store path.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'surface_feedback_doctor', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
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
      name: 'surface_feedback_update_status',
      description: 'Update one feedback entry status with a concise resolution or routing note.',
      inputSchema: {
        type: 'object',
        properties: {
          feedback_id: { type: 'string' },
          status: { type: 'string', enum: FEEDBACK_STATUSES },
          resolved_by: { type: 'string', description: 'Principal updating the feedback status.' },
          resolution_note: { type: 'string', description: 'Reason, fix summary, route destination, or acknowledgement note.' },
        },
        required: ['feedback_id', 'status', 'resolved_by', 'resolution_note'],
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_update_status', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'surface_feedback_import',
      description: 'Import explicit feedback entries from another local surface-feedback store into this store. Intended for repairing split-brain site-local stores.',
      inputSchema: {
        type: 'object',
        properties: {
          source_feedback_root: { type: 'string', description: 'Root containing .feedback/surface-feedback.db for the source store.' },
          source_db_path: { type: 'string', description: 'Direct path to a source surface-feedback.db. Use only when source_feedback_root is unavailable.' },
          feedback_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Feedback IDs to import from the source store.' },
        },
        required: ['feedback_ids'],
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_import', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'surface_feedback_list',
      description: 'List feedback entries scoped by caller site visibility. When caller_site_id is provided, entries are filtered to: (a) feedback for surfaces in owned_surface_ids, and (b) feedback submitted by the caller site. When absent, returns all feedback.',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string', description: 'Filter by surface identifier.' },
          submitter_site_id: { type: 'string', description: 'Filter by submitter site ID.' },
          kind: { type: 'string', enum: FEEDBACK_KINDS, description: 'Filter by feedback kind.' },
          status: { type: 'string', enum: FEEDBACK_STATUSES, description: 'Filter by status.' },
          caller_site_id: { type: 'string', description: 'Caller site ID for visibility scoping.' },
          owned_surface_ids: { type: 'array', items: { type: 'string' }, description: 'Surface IDs owned/maintained by the caller site. When provided with caller_site_id, the caller also sees all feedback for these surfaces.' },
          since: { type: 'string', description: 'ISO 8601 start date.' },
          until: { type: 'string', description: 'ISO 8601 end date.' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'surface_feedback_show',
      description: 'Show one feedback entry by feedback_id, scoped by visibility when caller_site_id is provided.',
      inputSchema: {
        type: 'object',
        properties: {
          feedback_id: { type: 'string' },
          caller_site_id: { type: 'string', description: 'Caller site ID for visibility scoping.' },
          owned_surface_ids: { type: 'array', items: { type: 'string' }, description: 'Surface IDs owned/maintained by the caller site.' },
        },
        required: ['feedback_id'],
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'surface_feedback_stats',
      description: 'Return aggregated feedback counts by surface, kind, and status, scoped by caller site visibility.',
      inputSchema: {
        type: 'object',
        properties: {
          surface_id: { type: 'string', description: 'Optional surface ID filter.' },
          caller_site_id: { type: 'string', description: 'Caller site ID for visibility scoping.' },
          owned_surface_ids: { type: 'array', items: { type: 'string' }, description: 'Surface IDs owned/maintained by the caller site.' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'surface_feedback_stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

function callTool(params: JsonRecord, state: FeedbackState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'surface_feedback_doctor': result = feedbackDoctor(state); break;
    case 'surface_feedback_submit': result = feedbackSubmit(args, state); break;
    case 'surface_feedback_update_status': result = feedbackUpdateStatus(args, state); break;
    case 'surface_feedback_import': result = feedbackImport(args, state); break;
    case 'surface_feedback_list': result = feedbackList(args, state); break;
    case 'surface_feedback_show': result = feedbackShow(args, state); break;
    case 'surface_feedback_stats': result = feedbackStats(args, state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function feedbackDoctor(state: FeedbackState): JsonRecord {
  const row = state.db.prepare('SELECT COUNT(*) AS count FROM feedback_entries').get() as JsonRecord;
  const usesCanonicalStore = samePath(state.feedbackRoot, state.canonicalFeedbackRoot);
  return {
    schema: 'narada.surface_feedback.doctor.v1',
    status: usesCanonicalStore ? 'ok' : 'warning',
    server_name: SERVER_NAME,
    server_version: SERVER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    storage_posture: usesCanonicalStore ? 'canonical_feedback_root' : 'noncanonical_feedback_root',
    feedback_root: state.feedbackRoot,
    canonical_feedback_root: state.canonicalFeedbackRoot,
    uses_canonical_store: usesCanonicalStore,
    db_path: state.dbPath,
    total_feedback_entries: Number(row.count ?? 0),
    diagnostic: usesCanonicalStore ? null : 'This server is writing feedback to a site-local/noncanonical store. Cross-site feedback may be invisible to maintainers using the canonical mcp-surfaces store.',
    remediation: usesCanonicalStore ? null : `Configure this surface with --feedback-root ${state.canonicalFeedbackRoot}`,
  };
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

function feedbackUpdateStatus(args: JsonRecord, state: FeedbackState): JsonRecord {
  const feedbackId = requiredString(args.feedback_id, 'feedback_requires_feedback_id');
  const status = requiredString(args.status, 'feedback_requires_status');
  if (!FEEDBACK_STATUSES.includes(status as typeof FEEDBACK_STATUSES[number])) throw diagnosticError('feedback_invalid_status', `feedback_invalid_status:${status}`, { allowed: FEEDBACK_STATUSES });
  const resolvedBy = requiredString(args.resolved_by, 'feedback_requires_resolved_by');
  const resolutionNote = requiredString(args.resolution_note, 'feedback_requires_resolution_note');
  const existing = state.db.prepare('SELECT feedback_id FROM feedback_entries WHERE feedback_id = ?').get(feedbackId) as JsonRecord | undefined;
  if (!existing) throw feedbackNotFound(feedbackId, state);
  const now = nowIso();
  state.db.prepare('UPDATE feedback_entries SET status = ?, resolved_by = ?, resolution_note = ?, updated_at = ? WHERE feedback_id = ?').run(status, resolvedBy, resolutionNote, now, feedbackId);
  const updated = state.db.prepare('SELECT * FROM feedback_entries WHERE feedback_id = ?').get(feedbackId) as JsonRecord;
  return { status: 'updated', feedback: hydrateFeedback(updated) };
}

function feedbackImport(args: JsonRecord, state: FeedbackState): JsonRecord {
  const sourceDbPath = sourceFeedbackDbPath(args);
  if (samePath(sourceDbPath, state.dbPath)) {
    throw diagnosticError('feedback_import_same_store', 'feedback_import_same_store', { source_db_path: sourceDbPath, target_db_path: state.dbPath });
  }
  if (!existsSync(sourceDbPath)) {
    throw diagnosticError('feedback_import_source_missing', `feedback_import_source_missing:${sourceDbPath}`, { source_db_path: sourceDbPath });
  }
  const feedbackIds = feedbackIdList(args.feedback_ids);
  const imported: JsonRecord[] = [];
  const skipped: JsonRecord[] = [];
  const missing: string[] = [];
  const sourceDb = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    const sourceRows = new Map<string, JsonRecord>();
    const selectSource = sourceDb.prepare('SELECT * FROM feedback_entries WHERE feedback_id = ?');
    for (const feedbackId of feedbackIds) {
      const row = selectSource.get(feedbackId) as JsonRecord | undefined;
      if (row) sourceRows.set(feedbackId, row);
      else missing.push(feedbackId);
    }
    const targetSelect = state.db.prepare('SELECT feedback_id FROM feedback_entries WHERE feedback_id = ?');
    const insert = state.db.prepare(
      'INSERT INTO feedback_entries (feedback_id, surface_id, submitter_site_id, submitter_principal, kind, summary, details, status, resolution_note, resolved_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    state.db.exec('BEGIN');
    try {
      for (const [feedbackId, row] of sourceRows.entries()) {
        const existing = targetSelect.get(feedbackId) as JsonRecord | undefined;
        if (existing) {
          skipped.push({ feedback_id: feedbackId, reason: 'already_exists' });
          continue;
        }
        insert.run(
          String(row.feedback_id),
          String(row.surface_id),
          String(row.submitter_site_id),
          String(row.submitter_principal),
          String(row.kind),
          String(row.summary),
          String(row.details ?? ''),
          String(row.status ?? 'submitted'),
          optionalString(row.resolution_note),
          optionalString(row.resolved_by),
          String(row.created_at),
          String(row.updated_at)
        );
        imported.push(hydrateFeedback(row));
      }
      state.db.exec('COMMIT');
    } catch (error) {
      state.db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    sourceDb.close();
  }
  return {
    schema: 'narada.surface_feedback.import.v1',
    status: missing.length || skipped.length ? 'partial' : 'imported',
    store: storeIdentity(state),
    source_db_path: sourceDbPath,
    target_db_path: state.dbPath,
    requested_count: feedbackIds.length,
    imported_count: imported.length,
    skipped_count: skipped.length,
    missing_count: missing.length,
    imported,
    skipped,
    missing_feedback_ids: missing,
  };
}

function visibilityClause(callerSiteId: string | null, ownedSurfaceIds: string[]): { sql: string; params: string[] } {
  if (!callerSiteId) return { sql: '', params: [] };
  if (ownedSurfaceIds.length > 0) {
    const placeholders = ownedSurfaceIds.map(() => '?').join(', ');
    return { sql: ` AND (submitter_site_id = ? OR surface_id IN (${placeholders}))`, params: [callerSiteId, ...ownedSurfaceIds] };
  }
  return { sql: ' AND submitter_site_id = ?', params: [callerSiteId] };
}

function ownedSurfaceIds(args: JsonRecord): string[] {
  const raw = args.owned_surface_ids;
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return [];
}

function feedbackList(args: JsonRecord, state: FeedbackState): JsonRecord {
  const limit = clamp(integer(args.limit, 50, 1, 200), 1, 200);
  const offset = Math.max(0, integer(args.offset, 0, 0, 10000));
  const surfaceId = optionalString(args.surface_id);
  const siteId = optionalString(args.submitter_site_id);
  const kind = optionalString(args.kind);
  const status = optionalString(args.status);
  const callerSiteId = optionalString(args.caller_site_id);
  const owned = ownedSurfaceIds(args);
  const since = optionalString(args.since);
  const until = optionalString(args.until);
  const vis = visibilityClause(callerSiteId, owned);
  let sql = 'SELECT * FROM feedback_entries WHERE 1=1';
  const params: (string | number)[] = [];
  if (surfaceId) { sql += ' AND surface_id = ?'; params.push(surfaceId); }
  if (siteId) { sql += ' AND submitter_site_id = ?'; params.push(siteId); }
  if (kind) { sql += ' AND kind = ?'; params.push(kind); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (since) { sql += ' AND created_at >= ?'; params.push(since); }
  if (until) { sql += ' AND created_at <= ?'; params.push(until); }
  sql += vis.sql;
  params.push(...vis.params);
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = state.db.prepare(sql).all(...params) as JsonRecord[];
  return { store: storeIdentity(state), items: rows.map(hydrateFeedback), count: rows.length, limit, offset };
}

function feedbackShow(args: JsonRecord, state: FeedbackState): JsonRecord {
  const feedbackId = requiredString(args.feedback_id, 'feedback_requires_feedback_id');
  const callerSiteId = optionalString(args.caller_site_id);
  const owned = ownedSurfaceIds(args);
  const row = state.db.prepare('SELECT * FROM feedback_entries WHERE feedback_id = ?').get(feedbackId) as JsonRecord | undefined;
  if (!row) throw feedbackNotFound(feedbackId, state);
  if (!isVisible(row, callerSiteId, owned)) throw diagnosticError('feedback_not_visible', `feedback_not_visible:${feedbackId}`);
  return { ...hydrateFeedback(row), store: storeIdentity(state) };
}

function feedbackStats(args: JsonRecord, state: FeedbackState): JsonRecord {
  const surfaceId = optionalString(args.surface_id);
  const callerSiteId = optionalString(args.caller_site_id);
  const owned = ownedSurfaceIds(args);
  const vis = visibilityClause(callerSiteId, owned);
  const bySurface: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let sql = 'SELECT surface_id, kind, status FROM feedback_entries WHERE 1=1';
  const params: string[] = [];
  if (surfaceId) { sql += ' AND surface_id = ?'; params.push(surfaceId); }
  sql += vis.sql;
  params.push(...vis.params);
  const rows = state.db.prepare(sql).all(...params) as JsonRecord[];
  for (const row of rows) {
    const s = String(row.surface_id);
    const k = String(row.kind);
    const st = String(row.status);
    bySurface[s] = (bySurface[s] ?? 0) + 1;
    byKind[k] = (byKind[k] ?? 0) + 1;
    byStatus[st] = (byStatus[st] ?? 0) + 1;
  }
  return { store: storeIdentity(state), by_surface: bySurface, by_kind: byKind, by_status: byStatus, total: rows.length };
}

function isVisible(row: JsonRecord, callerSiteId: string | null, ownedSurfaceIds: string[]): boolean {
  if (!callerSiteId) return true;
  if (String(row.submitter_site_id) === callerSiteId) return true;
  if (ownedSurfaceIds.includes(String(row.surface_id))) return true;
  return false;
}

function feedbackNotFound(feedbackId: string, state: FeedbackState) {
  return diagnosticError('feedback_not_found', `feedback_not_found:${feedbackId}`, {
    feedback_id: feedbackId,
    feedback_root: state.feedbackRoot,
    db_path: state.dbPath,
    store_hint: 'Feedback IDs are local to the configured feedback_root. If this ID was created from another site/session, compare surface_feedback_doctor.db_path for both sessions and migrate/rebind stale site-local feedback roots to the shared feedback root.',
  });
}

function storeIdentity(state: FeedbackState): JsonRecord {
  const usesCanonicalStore = samePath(state.feedbackRoot, state.canonicalFeedbackRoot);
  return {
    feedback_root: state.feedbackRoot,
    canonical_feedback_root: state.canonicalFeedbackRoot,
    uses_canonical_store: usesCanonicalStore,
    storage_posture: usesCanonicalStore ? 'canonical_feedback_root' : 'noncanonical_feedback_root',
    db_path: state.dbPath,
  };
}

function sourceFeedbackDbPath(args: JsonRecord): string {
  const sourceRoot = optionalString(args.source_feedback_root);
  const sourceDbPath = optionalString(args.source_db_path);
  if (sourceRoot && sourceDbPath) throw diagnosticError('feedback_import_source_ambiguous', 'feedback_import_source_ambiguous');
  if (sourceRoot) return resolve(sourceRoot, '.feedback', 'surface-feedback.db');
  if (sourceDbPath) return resolve(sourceDbPath);
  throw diagnosticError('feedback_import_requires_source', 'feedback_import_requires_source');
}

function feedbackIdList(value: unknown): string[] {
  if (!Array.isArray(value)) throw diagnosticError('feedback_import_requires_feedback_ids', 'feedback_import_requires_feedback_ids');
  const ids = [...new Set(value.map((v) => String(v ?? '').trim()).filter(Boolean))];
  if (!ids.length) throw diagnosticError('feedback_import_requires_feedback_ids', 'feedback_import_requires_feedback_ids');
  return ids;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as JsonRecord[];
  if (rows.some((row) => String(row.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    resolution_note: optionalString(row.resolution_note),
    resolved_by: optionalString(row.resolved_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function renderResult(result: JsonRecord): string {
  if (result.by_surface !== undefined) {
    const parts: string[] = [];
    const bySurface = result.by_surface as Record<string, number>;
    const byKind = result.by_kind as Record<string, number>;
    const byStatus = result.by_status as Record<string, number>;
    parts.push(`feedback stats: ${result.total} total`);
    for (const [s, c] of Object.entries(bySurface)) parts.push(`  surface ${s}: ${c}`);
    for (const [k, c] of Object.entries(byKind)) parts.push(`  kind ${k}: ${c}`);
    for (const [s, c] of Object.entries(byStatus)) parts.push(`  status ${s}: ${c}`);
    return parts.join('\n');
  }
  if (result.schema === 'narada.surface_feedback.doctor.v1') return compactLines([
    `surface_feedback_doctor: ${result.status}`,
    `storage_posture: ${result.storage_posture}`,
    `feedback_root: ${result.feedback_root}`,
    `canonical_feedback_root: ${result.canonical_feedback_root}`,
    `db_path: ${result.db_path}`,
    `total_feedback_entries: ${result.total_feedback_entries}`,
    result.diagnostic ? `diagnostic: ${result.diagnostic}` : null,
    result.remediation ? `remediation: ${result.remediation}` : null,
  ]);
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

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function compactLines(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n');
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
  const details = asRecord(record.details);
  return { schema: 'narada.surface_feedback.error.v1', code: String(record.codeName ?? 'surface_feedback_error'), message: error instanceof Error ? error.message : String(error), ...details, details };
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
    else if (arg === '--canonical-feedback-root') options.canonicalFeedbackRoot = argv[++i];
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
