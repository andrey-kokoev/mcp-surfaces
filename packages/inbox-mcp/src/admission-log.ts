import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeFileUtf8 } from './write-file-utf8.js';

const LOG_DIR = '.ai/state';
const LOG_FILE = 'inbox-admission.log';
const ENVELOPES_DIR = '.ai/inbox-envelopes';
const ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024;

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

export function appendAdmissionEvent(siteRoot: string, event: any): any {
  ensureDir(siteRoot);
  rotateIfNeeded(siteRoot);
  const fullEvent = {
    schema: 'narada.inbox.admission_log.entry.v0',
    event_id: `evt_${randomUUID().replace(/-/g, '')}`,
    event_sequence: getNextSequence(siteRoot),
    timestamp: new Date().toISOString(),
    ...event,
  };
  appendFileSync(logPath(siteRoot), `${JSON.stringify(fullEvent)}\n`, 'utf8');
  return fullEvent;
}

export function admitEnvelope(siteRoot: string, envelope: any): any {
  const envelopesPath = join(resolve(siteRoot), ENVELOPES_DIR);
  mkdirSync(envelopesPath, { recursive: true });
  const envelopeId = envelope.envelope_id ?? `env_${randomUUID()}`;
  const receivedAt = envelope.received_at ?? new Date().toISOString();
  const fullEnvelope = { ...envelope, envelope_id: envelopeId, received_at: receivedAt };
  const safeTs = receivedAt.replace(/[:.]/g, '-');
  const fileName = `${safeTs}-${envelopeId}.json`;
  const envelopePath = join(envelopesPath, fileName);
  writeFileUtf8(envelopePath, JSON.stringify(fullEnvelope, null, 2));
  const event = emitEnvelopeAdmitted(siteRoot, fullEnvelope, {
    principal: fullEnvelope.authority?.principal ?? 'unknown',
    authority_level: fullEnvelope.authority?.level ?? 'agent_reported',
    payload_uri: `${ENVELOPES_DIR}/${fileName}`,
    target_locus: fullEnvelope.target_locus ?? 'local_site',
  });
  return { envelopePath, event: { ...event, event_seq: event.event_sequence } };
}

export function emitEnvelopeAdmitted(siteRoot: string, envelope: any, meta: any = {}): any {
  const payloadHash = hashPayload(envelope);
  const payloadUri = meta.payload_uri ?? `.ai/inbox-envelopes/${envelope.envelope_id}.json`;
  appendAdmissionEvent(siteRoot, {
    envelope_id: envelope.envelope_id,
    event_kind: 'envelope_received',
    principal: meta.principal ?? envelope.source?.principal ?? 'unknown',
    authority_level: meta.authority_level ?? envelope.authority?.level ?? 'agent_reported',
    payload_hash: payloadHash,
    payload_uri: payloadUri,
    event_payload: {
      source_ref: envelope.source?.ref,
      source_kind: envelope.source?.kind,
      target_locus: meta.target_locus ?? 'local_site',
      transport: meta.transport ?? 'mcp_cli',
    },
  });
  return appendAdmissionEvent(siteRoot, {
    envelope_id: envelope.envelope_id,
    event_kind: 'envelope_admitted',
    principal: meta.principal ?? 'inbox_mcp',
    authority_level: 'system_detected',
    payload_hash: payloadHash,
    payload_uri: payloadUri,
    event_payload: {
      admission_gate: meta.admission_gate ?? 'inbox_mcp_submit',
      validation_result: 'passed',
      routing_decision: meta.target_locus ?? 'local_site',
    },
  });
}

export function readAdmissionLog(siteRoot: string): any[] {
  const path = logPath(siteRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function getLatestEventsByEnvelope(siteRoot: string): Map<string, any> {
  const map = new Map<string, any>();
  for (const event of readAdmissionLog(siteRoot)) {
    if (!event.envelope_id) continue;
    const existing = map.get(event.envelope_id);
    if (!existing || (event.event_sequence ?? 0) > (existing.event_sequence ?? 0)) {
      map.set(event.envelope_id, event);
    }
  }
  return map;
}
