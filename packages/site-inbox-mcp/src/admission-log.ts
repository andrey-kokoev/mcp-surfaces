import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeFileUtf8 } from './write-file-utf8.js';

const LOG_DIR = '.ai/state';
const LOG_FILE = 'inbox-admission.log';
const ENVELOPES_DIR = '.ai/inbox-envelopes';
const ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024;

type InboxRecord = Record<string, unknown>;

function asRecord(value: unknown): InboxRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as InboxRecord : {};
}

function logPath(siteRoot: string): string {
  return join(resolve(siteRoot), LOG_DIR, LOG_FILE);
}

function ensureDir(siteRoot: string): void {
  mkdirSync(join(resolve(siteRoot), LOG_DIR), { recursive: true });
}

function hashPayload(payload: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function getNextSequence(siteRoot: string): number {
  const path = logPath(siteRoot);
  if (!existsSync(path)) return 1;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return 1;
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return (typeof last.event_sequence === 'number' ? last.event_sequence : lines.length) + 1;
  } catch {
    return lines.length + 1;
  }
}

function rotateIfNeeded(siteRoot: string): void {
  const path = logPath(siteRoot);
  if (!existsSync(path) || statSync(path).size < ROTATION_THRESHOLD_BYTES) return;
  const rotatedName = `inbox-admission-${new Date().toISOString().slice(0, 10)}.log`;
  writeFileUtf8(join(resolve(siteRoot), LOG_DIR, rotatedName), readFileSync(path, 'utf8'));
  writeFileUtf8(path, '');
}

export function appendAdmissionEvent(siteRoot: string, event: unknown): InboxRecord {
  ensureDir(siteRoot);
  rotateIfNeeded(siteRoot);
  const eventRecord = asRecord(event);
  const fullEvent = {
    schema: 'narada.inbox.admission_log.entry.v0',
    event_id: `evt_${randomUUID().replace(/-/g, '')}`,
    event_sequence: getNextSequence(siteRoot),
    timestamp: new Date().toISOString(),
    ...eventRecord,
  };
  appendFileSync(logPath(siteRoot), `${JSON.stringify(fullEvent)}\n`, 'utf8');
  return fullEvent;
}

export function admitEnvelope(siteRoot: string, envelope: unknown): InboxRecord {
  const envelopesPath = join(resolve(siteRoot), ENVELOPES_DIR);
  mkdirSync(envelopesPath, { recursive: true });
  const envelopeRecord = asRecord(envelope);
  const authority = asRecord(envelopeRecord.authority);
  const envelopeId = typeof envelopeRecord.envelope_id === 'string' ? envelopeRecord.envelope_id : `env_${randomUUID()}`;
  const receivedAt = typeof envelopeRecord.received_at === 'string' ? envelopeRecord.received_at : new Date().toISOString();
  const fullEnvelope = { ...envelopeRecord, envelope_id: envelopeId, received_at: receivedAt };
  const safeTs = receivedAt.replace(/[:.]/g, '-');
  const fileName = `${safeTs}-${envelopeId}.json`;
  const envelopePath = join(envelopesPath, fileName);
  writeFileUtf8(envelopePath, JSON.stringify(fullEnvelope, null, 2));
  const event = emitEnvelopeAdmitted(siteRoot, fullEnvelope, {
    principal: authority.principal ?? 'unknown',
    authority_level: authority.level ?? 'agent_reported',
    payload_uri: `${ENVELOPES_DIR}/${fileName}`,
    target_locus: fullEnvelope['target_locus'] ?? 'local_site',
  });
  return { envelopePath, event: { ...event, event_seq: event.event_sequence } };
}
export function emitEnvelopeAdmitted(siteRoot: string, envelope: unknown, meta: unknown = {}): InboxRecord {
  const envelopeRecord = asRecord(envelope);
  const metaRecord = asRecord(meta);
  const source = asRecord(envelopeRecord.source);
  const authority = asRecord(envelopeRecord.authority);
  const envelopeId = String(envelopeRecord.envelope_id ?? 'unknown');
  const payloadHash = hashPayload(envelopeRecord);
  const payloadUri = metaRecord.payload_uri ?? `.ai/inbox-envelopes/${envelopeId}.json`;
  appendAdmissionEvent(siteRoot, {
    envelope_id: envelopeId,
    event_kind: 'envelope_received',
    principal: metaRecord.principal ?? source.principal ?? 'unknown',
    authority_level: metaRecord.authority_level ?? authority.level ?? 'agent_reported',
    payload_hash: payloadHash,
    payload_uri: payloadUri,
    event_payload: {
      source_ref: source.ref,
      source_kind: source.kind,
      target_locus: metaRecord.target_locus ?? 'local_site',
      transport: metaRecord.transport ?? 'mcp_cli',
    },
  });
  return appendAdmissionEvent(siteRoot, {
    envelope_id: envelopeId,
    event_kind: 'envelope_admitted',
    principal: metaRecord.principal ?? 'inbox_mcp',
    authority_level: 'system_detected',
    payload_hash: payloadHash,
    payload_uri: payloadUri,
    event_payload: {
      admission_gate: metaRecord.admission_gate ?? 'inbox_mcp_submit',
      validation_result: 'passed',
      routing_decision: metaRecord.target_locus ?? 'local_site',
    },
  });
}

export function readAdmissionLog(siteRoot: string): InboxRecord[] {
  const path = logPath(siteRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line)));
}

export function getLatestEventsByEnvelope(siteRoot: string): Map<string, InboxRecord> {
  const map = new Map<string, InboxRecord>();
  for (const event of readAdmissionLog(siteRoot)) {
    if (!event.envelope_id) continue;
    const envelopeId = String(event.envelope_id);
    const existing = map.get(envelopeId);
    const eventSequence = typeof event.event_sequence === 'number' ? event.event_sequence : 0;
    const existingSequence = typeof existing?.event_sequence === 'number' ? existing.event_sequence : 0;
    if (!existing || eventSequence > existingSequence) {
      map.set(envelopeId, event);
    }
  }
  return map;
}

export function emitEnvelopeAcknowledged(siteRoot: string, envelopeId: string, principal: string, reason?: string): InboxRecord {
  return appendAdmissionEvent(siteRoot, {
    envelope_id: envelopeId,
    event_kind: 'envelope_acknowledged',
    principal,
    authority_level: 'agent_reported',
    event_payload: { reason: reason ?? null },
  });
}

export function emitEnvelopeDismissed(siteRoot: string, envelopeId: string, principal: string, reason: string): InboxRecord {
  return appendAdmissionEvent(siteRoot, {
    envelope_id: envelopeId,
    event_kind: 'envelope_dismissed',
    principal,
    authority_level: 'agent_reported',
    event_payload: { reason },
  });
}

export function emitEnvelopePromoted(siteRoot: string, envelopeId: string, principal: string, reason?: string): InboxRecord {
  return appendAdmissionEvent(siteRoot, {
    envelope_id: envelopeId,
    event_kind: 'envelope_promoted',
    principal,
    authority_level: 'agent_reported',
    event_payload: { reason: reason ?? null },
  });
}
