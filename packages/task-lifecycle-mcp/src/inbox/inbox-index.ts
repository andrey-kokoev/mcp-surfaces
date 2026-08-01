import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Database } from '@narada-core/task-governance-core/sqlite-database';
import { getLatestEventsByEnvelope } from './admission-log.js';

const INBOX_DIR: any = '.ai/inbox-envelopes';
const INDEX_PATH: any = '.ai/state/inbox-index.sqlite';
const INDEX_SCHEMA_VERSION: any = 1;
const ENVELOPE_ID_PATTERN: any = /^env_[A-Za-z0-9][A-Za-z0-9_-]*$/;
type TaskLifecyclePayload = Record<string, unknown>;

export function isValidEnvelopeId(envelopeId: any) {
  return typeof envelopeId === 'string' && ENVELOPE_ID_PATTERN.test(envelopeId);
}

function indexPath(siteRoot: any) {
  return join(resolve(siteRoot), INDEX_PATH);
}

function openInboxIndex(siteRoot: any) {
  const dbPath: any = indexPath(siteRoot);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db: any = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox_envelopes (
      envelope_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      authority_level TEXT,
      title TEXT,
      summary TEXT,
      principal TEXT,
      source_ref TEXT,
      received_at TEXT,
      target_role TEXT,
      severity INTEGER,
      severity_reason TEXT,
      action TEXT,
      payload_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_envelopes_status_received
      ON inbox_envelopes(status, received_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_envelopes_severity
      ON inbox_envelopes(status, severity DESC, received_at);
  `);
  const now: any = new Date().toISOString();
  db.prepare(`
    INSERT INTO inbox_index_meta (key, value, updated_at)
    VALUES ('schema_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(INDEX_SCHEMA_VERSION), now);
  return { db, dbPath };
}

function envelopeFiles(siteRoot: any) {
  const envelopeDir: any = join(resolve(siteRoot), INBOX_DIR);
  if (!existsSync(envelopeDir)) return [];
  return readdirSync(envelopeDir)
    .filter((fileName: any) => fileName.endsWith('.json'))
    .map((fileName: any) => join(envelopeDir, fileName));
}

function readEnvelopeFile(filePath: any) {
  try {
    const text: any = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const envelope: any = JSON.parse(text);
    if (!isValidEnvelopeId(envelope?.envelope_id)) return null;
    return { envelope, text };
  } catch {
    return null;
  }
}

function effectiveStatus(envelope: any, latestEvents: any) {
  const latest: any = latestEvents.get(envelope.envelope_id);
  if (latest?.event_kind === 'envelope_acknowledged') return 'acknowledged';
  if (latest?.event_kind === 'envelope_dismissed') return 'dismissed';
  if (latest?.event_kind === 'envelope_promoted') return 'promoted';
  return envelope.status ?? 'received';
}
export function refreshInboxIndex(siteRoot: any, { evaluateEnvelopeSeverity }: TaskLifecyclePayload = {}) {
  const severityEvaluator: any = typeof evaluateEnvelopeSeverity === 'function' ? evaluateEnvelopeSeverity as (envelope: TaskLifecyclePayload) => TaskLifecyclePayload : null;
  const { db, dbPath } = openInboxIndex(siteRoot);
  const now: any = new Date().toISOString();
  const latestEvents: any = getLatestEventsByEnvelope(siteRoot);
  const files: any = envelopeFiles(siteRoot);

  const seen: any = new Set();
  const invalidRecords: any[] = [];
  const upsert: any = db.prepare(`
    INSERT INTO inbox_envelopes (
      envelope_id, file_path, status, kind, authority_level, title, summary,
      principal, source_ref, received_at, target_role, severity, severity_reason,
      action, payload_json, indexed_at
    ) VALUES (
      @envelope_id, @file_path, @status, @kind, @authority_level, @title, @summary,
      @principal, @source_ref, @received_at, @target_role, @severity, @severity_reason,
      @action, @payload_json, @indexed_at
    )
    ON CONFLICT(envelope_id) DO UPDATE SET
      file_path = excluded.file_path,
      status = excluded.status,
      kind = excluded.kind,
      authority_level = excluded.authority_level,
      title = excluded.title,
      summary = excluded.summary,
      principal = excluded.principal,
      source_ref = excluded.source_ref,
      received_at = excluded.received_at,
      target_role = excluded.target_role,
      severity = excluded.severity,
      severity_reason = excluded.severity_reason,
      action = excluded.action,
      payload_json = excluded.payload_json,
      indexed_at = excluded.indexed_at
  `);

  const purgeMissing: any = db.prepare('DELETE FROM inbox_envelopes WHERE envelope_id NOT IN (SELECT value FROM json_each(?))');
  const transaction: any = db.transaction(() => {
    for (const filePath of files) {
      const raw: any = readEnvelopeFile(filePath);
      if (!raw) {
        invalidRecords.push({ file_path: filePath, reason: 'invalid_json_or_envelope_id' });
        continue;
      }
      const { envelope, text } = raw;
      const severity: any = severityEvaluator ? severityEvaluator(envelope) : {};
      const envelopeId: any = envelope.envelope_id;
      seen.add(envelopeId);
      upsert.run({
        envelope_id: envelopeId,
        file_path: filePath,
        status: effectiveStatus(envelope, latestEvents),
        kind: envelope.kind ?? 'observation',
        authority_level: envelope.authority?.level ?? 'agent_reported',
        title: envelope.title ?? envelope.payload?.title ?? '(untitled)',
        summary: envelope.summary ?? envelope.payload?.summary ?? null,
        principal: envelope.principal ?? envelope.authority?.principal ?? envelope.payload?.principal ?? null,
        source_ref: envelope.source_ref ?? envelope.source?.ref ?? null,
        received_at: envelope.received_at ?? null,
        target_role: severity.targetRole ?? envelope.target_role ?? null,
        severity: severity.severity ?? null,
        severity_reason: severity.reason ?? null,
        action: severity.action ?? null,
        payload_json: text,
        indexed_at: now,
      });
    }
    if (seen.size === 0) {
      db.prepare('DELETE FROM inbox_envelopes').run();
    } else {
      purgeMissing.run(JSON.stringify([...seen]));
    }
    db.prepare(`
      INSERT INTO inbox_index_meta (key, value, updated_at)
      VALUES ('last_refreshed_at', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now, now);
  });
  transaction();

  const total: any = (db.prepare('SELECT COUNT(*) AS count FROM inbox_envelopes').get() as TaskLifecyclePayload).count;
  return {
    status: 'ok',
    db,
    db_path: dbPath,
    indexed_count: total,
    invalid_count: invalidRecords.length,
    invalid_records: invalidRecords,
    refreshed_at: now,
  };
}

export function readIndexedInboxBacklog(siteRoot: any, { evaluateEnvelopeSeverity }: TaskLifecyclePayload = {}) {
  const index: any = refreshInboxIndex(siteRoot, { evaluateEnvelopeSeverity });
  try {
    const rows: any = index.db.prepare(`
      SELECT *
      FROM inbox_envelopes
      WHERE status = 'received'
      ORDER BY COALESCE(severity, 0) DESC, COALESCE(received_at, '') ASC
    `).all() as TaskLifecyclePayload[];
    return {
      ...index,
      rows: rows.map((row: any) => ({
        ...row,
        envelope: JSON.parse(String(row.payload_json)),
      })),
    };
  } finally {
    index.db.close();
  }
}

export function readInboxIndexCounts(siteRoot: any, { evaluateEnvelopeSeverity }: TaskLifecyclePayload = {}) {
  const index: any = refreshInboxIndex(siteRoot, { evaluateEnvelopeSeverity });
  try {
    const receivedStatus: any = { status: 'received' };
    const count: any = (where: any, params: TaskLifecyclePayload = {}) => (index.db.prepare(`SELECT COUNT(*) AS count FROM inbox_envelopes ${where}`).get(params) as TaskLifecyclePayload).count;
    return {
      ...index,
      counts: {
        total: count('WHERE status = @status', receivedStatus),
        high_severity: count('WHERE status = @status AND COALESCE(severity, 0) >= 70', receivedStatus),
        incidents: count("WHERE status = @status AND kind = 'incident'", receivedStatus),
        capa_requests: count("WHERE status = @status AND action = 'review_capa_request'", receivedStatus),
        observations: count("WHERE status = @status AND kind = 'observation'", receivedStatus),
        proposals: count("WHERE status = @status AND kind = 'proposal'", receivedStatus),
      },
    };
  } finally {
    index.db.close();
  }
}
