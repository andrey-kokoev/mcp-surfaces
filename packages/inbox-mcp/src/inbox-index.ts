import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getLatestEventsByEnvelope } from './admission-log.js';

const INBOX_DIR = '.ai/inbox-envelopes';
const INDEX_PATH = '.ai/state/inbox-index.sqlite';
const INDEX_SCHEMA_VERSION = 1;
const ENVELOPE_ID_PATTERN = /^env_[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidEnvelopeId(envelopeId: unknown): boolean {
  return typeof envelopeId === 'string' && ENVELOPE_ID_PATTERN.test(envelopeId);
}

function openInboxIndex(siteRoot: string): any {
  const dbPath = join(resolve(siteRoot), INDEX_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`);
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
  const now = new Date().toISOString();
  runStatement(db.prepare(`
    INSERT INTO inbox_index_meta (key, value, updated_at)
    VALUES ('schema_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `), String(INDEX_SCHEMA_VERSION), now);
  return { db, dbPath };
}

function envelopeFiles(siteRoot: string): string[] {
  const envelopeDir = join(resolve(siteRoot), INBOX_DIR);
  if (!existsSync(envelopeDir)) return [];
  return readdirSync(envelopeDir).filter((fileName) => fileName.endsWith('.json')).map((fileName) => join(envelopeDir, fileName));
}

function readEnvelopeFile(filePath: string): any {
  try {
    const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const envelope = JSON.parse(text);
    if (!isValidEnvelopeId(envelope?.envelope_id)) return null;
    return { envelope, text };
  } catch {
    return null;
  }
}

function effectiveStatus(envelope: any, latestEvents: Map<string, any>): string {
  const latest = latestEvents.get(envelope.envelope_id);
  if (latest?.event_kind === 'envelope_acknowledged') return 'acknowledged';
  if (latest?.event_kind === 'envelope_dismissed') return 'dismissed';
  if (latest?.event_kind === 'envelope_promoted') return 'promoted';
  return envelope.status ?? 'received';
}

export function refreshInboxIndex(siteRoot: string, { evaluateEnvelopeSeverity }: any = {}): any {
  const { db, dbPath } = openInboxIndex(siteRoot);
  const now = new Date().toISOString();
  const latestEvents = getLatestEventsByEnvelope(siteRoot);
  const files = envelopeFiles(siteRoot);
  const seen = new Set<string>();
  const invalidRecords: any[] = [];
  const upsert = db.prepare(`
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
  db.exec('BEGIN');
  try {
    for (const filePath of files) {
      const raw = readEnvelopeFile(filePath);
      if (!raw) {
        invalidRecords.push({ file_path: filePath, reason: 'invalid_json_or_envelope_id' });
        continue;
      }
      const { envelope, text } = raw;
      const severity = evaluateEnvelopeSeverity ? evaluateEnvelopeSeverity(envelope) : {};
      seen.add(envelope.envelope_id);
      runStatement(upsert, {
        envelope_id: envelope.envelope_id,
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
      runStatement(db.prepare('DELETE FROM inbox_envelopes'));
    } else {
      runStatement(db.prepare('DELETE FROM inbox_envelopes WHERE envelope_id NOT IN (SELECT value FROM json_each(?))'), JSON.stringify([...seen]));
    }
    runStatement(db.prepare(`
      INSERT INTO inbox_index_meta (key, value, updated_at)
      VALUES ('last_refreshed_at', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `), now, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const total = db.prepare('SELECT COUNT(*) AS count FROM inbox_envelopes').get().count;
  return { status: 'ok', storage: 'node_sqlite', db, db_path: dbPath, indexed_count: total, invalid_count: invalidRecords.length, invalid_records: invalidRecords, refreshed_at: now };
}

function runStatement(statement: any, ...args: any[]): any {
  if (args.length === 0) return statement.run();
  if (args.length === 1) return statement.run(args[0]);
  return statement.run(...args);
}

export function readIndexedInboxBacklog(siteRoot: string, options: any = {}): any {
  const index = refreshInboxIndex(siteRoot, options);
  try {
    const rows = index.db.prepare(`
      SELECT *
      FROM inbox_envelopes
      WHERE status = 'received'
      ORDER BY COALESCE(severity, 0) DESC, COALESCE(received_at, '') ASC
    `).all();
    return { ...index, rows: rows.map((row: any) => ({ ...row, envelope: JSON.parse(row.payload_json) })) };
  } finally {
    index.db.close();
  }
}

export function readIndexedInboxRows(siteRoot: string, options: any = {}): any {
  const index = refreshInboxIndex(siteRoot, options);
  try {
    const rows = index.db.prepare(`
      SELECT *
      FROM inbox_envelopes
      ORDER BY COALESCE(severity, 0) DESC, COALESCE(received_at, '') ASC
    `).all();
    return { ...index, rows: rows.map((row: any) => ({ ...row, envelope: JSON.parse(row.payload_json) })) };
  } finally {
    index.db.close();
  }
}

export function readInboxIndexCounts(siteRoot: string, options: any = {}): any {
  const index = refreshInboxIndex(siteRoot, options);
  try {
    const receivedStatus = { status: 'received' };
    const count = (where: string, params: any = {}) => index.db.prepare(`SELECT COUNT(*) AS count FROM inbox_envelopes ${where}`).get(params).count;
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

export function readInboxEnvelopeById(siteRoot: string, envelopeId: string, options: any = {}): any {
  const index = refreshInboxIndex(siteRoot, options);
  try {
    return index.db.prepare('SELECT * FROM inbox_envelopes WHERE envelope_id = ?').get(envelopeId) ?? null;
  } finally {
    index.db.close();
  }
}
