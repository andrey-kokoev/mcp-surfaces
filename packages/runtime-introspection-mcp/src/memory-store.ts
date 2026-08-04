import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

type JsonRecord = Record<string, unknown>;
const require = createRequire(import.meta.url);

function databasePath(siteRoot: string): string {
  return join(resolve(siteRoot), '.narada', 'runtime', 'mcp-runtime-observer', 'observations.db');
}

function siteRoot(explicit?: string): string {
  const value = explicit ?? process.env.NARADA_SITE_ROOT;
  if (!value?.trim()) throw new Error('runtime_introspection_site_authority_unavailable');
  return resolve(value);
}

function open(explicit?: string): { db: DatabaseSyncType; path: string } {
  const path = databasePath(siteRoot(explicit));
  if (!existsSync(path)) throw new Error('runtime_introspection_memory_store_unavailable');
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  return { db: new DatabaseSync(path, { readOnly: true }), path };
}

export function memoryStatus(_args: JsonRecord = {}, explicitSiteRoot?: string): JsonRecord {
  const { db, path } = open(explicitSiteRoot);
  try {
    const processStats = row(db, 'SELECT COUNT(*) samples,MAX(sampled_at_ms) last_sample_at_ms,COUNT(DISTINCT owner_id) sampled_owners FROM process_samples');
    const workerStats = row(db, 'SELECT COUNT(*) samples,MAX(sampled_at_ms) last_sample_at_ms,COUNT(DISTINCT owner_id) sampled_owners FROM worker_samples');
    const owners = row(db, 'SELECT COUNT(*) owners,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active_owners FROM owners');
    const incidents = row(db, "SELECT COUNT(*) incidents,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_incidents FROM incidents");
    const last = Math.max(Number(processStats.last_sample_at_ms ?? 0), Number(workerStats.last_sample_at_ms ?? 0));
    return {
      schema: 'narada.runtime_introspection.memory_status.v1',
      status: last === 0 ? 'empty' : Date.now() - last > 30_000 ? 'stale' : 'ready',
      observed_at: new Date().toISOString(),
      database_updated_at: statSync(path).mtime.toISOString(),
      last_sample_at: last ? new Date(last).toISOString() : null,
      process: processStats,
      workers: workerStats,
      ...owners,
      ...incidents,
      authority: 'server_bound_site',
      response: 'evidence_only_no_automatic_actuation',
    };
  } finally { db.close(); }
}

export function memoryOwners(args: JsonRecord = {}, explicitSiteRoot?: string): JsonRecord {
  const { db } = open(explicitSiteRoot);
  try {
    const limit = boundedInt(args.limit, 50, 1, 200);
    const active = args.active_only === false ? 0 : 1;
    const items = rows(db, `SELECT o.*,
      (SELECT private_bytes FROM process_samples p WHERE p.owner_id=COALESCE(o.parent_owner_id,o.owner_id) ORDER BY sampled_at_ms DESC LIMIT 1) private_bytes,
      (SELECT working_set_bytes FROM process_samples p WHERE p.owner_id=COALESCE(o.parent_owner_id,o.owner_id) ORDER BY sampled_at_ms DESC LIMIT 1) working_set_bytes,
      (SELECT heap_used_bytes FROM worker_samples w WHERE w.owner_id=o.owner_id ORDER BY sampled_at_ms DESC LIMIT 1) heap_used_bytes,
      (SELECT sampled_at_ms FROM process_samples p WHERE p.owner_id=COALESCE(o.parent_owner_id,o.owner_id) ORDER BY sampled_at_ms DESC LIMIT 1) last_sample_at_ms
      FROM owners o WHERE (?1=0 OR active=1) ORDER BY active DESC,last_sample_at_ms DESC LIMIT ?2`, active, limit);
    return { schema: 'narada.runtime_introspection.memory_owners.v1', items, count: items.length, limit };
  } finally { db.close(); }
}

export function memoryTimeline(args: JsonRecord = {}, explicitSiteRoot?: string): JsonRecord {
  const { db } = open(explicitSiteRoot);
  try {
    const owner = requiredString(args.owner_id, 'owner_id');
    const limit = boundedInt(args.limit, 100, 1, 500);
    const before = Number.isFinite(Number(args.before_ms)) ? Number(args.before_ms) : Date.now() + 1;
    const items = rows(db, `SELECT sampled_at_ms,'process' sample_kind,private_bytes primary_bytes,working_set_bytes,commit_bytes,handle_count,thread_count,NULL heap_used_bytes,NULL external_bytes,NULL array_buffers_bytes
      FROM process_samples WHERE owner_id=?1 AND sampled_at_ms<?2
      UNION ALL
      SELECT sampled_at_ms,'worker',heap_used_bytes,NULL,NULL,NULL,NULL,heap_used_bytes,external_bytes,array_buffers_bytes
      FROM worker_samples WHERE owner_id=?1 AND sampled_at_ms<?2
      ORDER BY sampled_at_ms DESC LIMIT ?3`, owner, before, limit);
    return { schema: 'narada.runtime_introspection.memory_timeline.v1', owner_id: owner, items, count: items.length, next_before_ms: items.length === limit ? items.at(-1)?.sampled_at_ms ?? null : null };
  } finally { db.close(); }
}

export function memoryAttribution(args: JsonRecord = {}, explicitSiteRoot?: string): JsonRecord {
  const { db } = open(explicitSiteRoot);
  try {
    const owner = requiredString(args.owner_id, 'owner_id');
    const process = row(db, `SELECT * FROM process_samples WHERE owner_id IN (
      ?1, COALESCE((SELECT parent_owner_id FROM owners WHERE owner_id=?1), ?1)
    ) ORDER BY CASE WHEN owner_id=?1 THEN 0 ELSE 1 END,sampled_at_ms DESC LIMIT 1`, owner);
    const worker = row(db, 'SELECT * FROM worker_samples WHERE owner_id=?1 ORDER BY sampled_at_ms DESC LIMIT 1', owner);
    const privateBytes = Number(process.private_bytes ?? 0);
    const heap = Number(worker.heap_used_bytes ?? 0);
    const external = Number(worker.external_bytes ?? 0);
    const arrayBuffers = Number(worker.array_buffers_bytes ?? 0);
    const v8Attributed = Math.min(privateBytes, heap + external);
    const ratio = privateBytes > 0 ? v8Attributed / privateBytes : 0;
    return {
      schema: 'narada.runtime_introspection.memory_attribution.v1', owner_id: owner,
      attribution: ratio >= 0.7 ? 'direct' : ratio >= 0.4 ? 'partial' : 'residual',
      confidence: ratio >= 0.7 ? 0.92 : ratio >= 0.4 ? 0.7 : 0.45,
      process_private_bytes: privateBytes || null,
      worker_heap_used_bytes: heap || null,
      worker_external_bytes: external || null,
      worker_array_buffers_bytes: arrayBuffers || null,
      attributed_v8_bytes: v8Attributed || null,
      non_v8_residual_bytes: privateBytes ? Math.max(0, privateBytes - v8Attributed) : null,
      note: 'array_buffers_are_reported_as_evidence_but_not_added_to_external_to_avoid_double_counting',
    };
  } finally { db.close(); }
}

export function memoryIncidents(args: JsonRecord = {}, explicitSiteRoot?: string): JsonRecord {
  const { db } = open(explicitSiteRoot);
  try {
    const limit = boundedInt(args.limit, 50, 1, 200);
    const status = typeof args.status === 'string' ? args.status : 'open';
    const items = rows(db, 'SELECT * FROM incidents WHERE (?1=\'all\' OR status=?1) ORDER BY updated_at_ms DESC LIMIT ?2', status, limit);
    return { schema: 'narada.runtime_introspection.memory_incidents.v1', status, items, count: items.length };
  } finally { db.close(); }
}

export function memoryIncidentShow(args: JsonRecord = {}, explicitSiteRoot?: string): JsonRecord {
  const { db } = open(explicitSiteRoot);
  try {
    const id = requiredString(args.incident_id, 'incident_id');
    const incident = row(db, 'SELECT * FROM incidents WHERE incident_id=?1', id);
    if (!incident.incident_id) throw new Error('runtime_introspection_memory_incident_not_found');
    return {
      schema: 'narada.runtime_introspection.memory_incident.v1',
      incident,
      evidence: rows(db, 'SELECT evidence_id,created_at_ms,evidence_type,payload_json FROM evidence WHERE incident_id=?1 ORDER BY created_at_ms', id).map(parsePayload),
      artifacts: rows(db, 'SELECT artifact_id,created_at_ms,path,kind,bytes FROM artifacts WHERE incident_id=?1 ORDER BY created_at_ms', id),
    };
  } finally { db.close(); }
}

type SqlValue = string | number | bigint | Uint8Array | null;
function row(db: DatabaseSyncType, sql: string, ...args: SqlValue[]): JsonRecord { return (db.prepare(sql).get(...args) ?? {}) as JsonRecord; }
function rows(db: DatabaseSyncType, sql: string, ...args: SqlValue[]): JsonRecord[] { return db.prepare(sql).all(...args) as JsonRecord[]; }
function parsePayload(value: JsonRecord): JsonRecord { try { return { ...value, payload: JSON.parse(String(value.payload_json)), payload_json: undefined }; } catch { return value; } }
function requiredString(value: unknown, name: string): string { const result = typeof value === 'string' ? value.trim() : ''; if (!result) throw new Error(`runtime_introspection_memory_argument_required:${name}`); return result; }
function boundedInt(value: unknown, fallback: number, min: number, max: number): number { const n = Number(value ?? fallback); if (!Number.isInteger(n) || n < min || n > max) throw new Error('runtime_introspection_memory_limit_invalid'); return n; }
