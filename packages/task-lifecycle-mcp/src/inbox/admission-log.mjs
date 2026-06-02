/**
 * Inbox Admission Log
 *
 * Append-only log for inbox envelope admission events.
 * Format: NDJSON (newline-delimited JSON), one event per line.
 * Location: .ai/state/inbox-admission.log
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { writeFileUtf8 } from '../incubation/write-file-utf8.mjs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOG_DIR = '.ai/state';
const LOG_FILE = 'inbox-admission.log';
const ENVELOPES_DIR = '.ai/inbox-envelopes';
const DEFAULT_DISPOSITION_EXPORT_PATH = 'kb/operations/inbox-disposition-ledger.json';
const DISPOSITION_EVENT_KINDS = new Set(['envelope_acknowledged', 'envelope_dismissed', 'envelope_promoted']);
const ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

function logPath(cwd) {
  return join(resolve(cwd), LOG_DIR, LOG_FILE);
}

function ensureDir(cwd) {
  const dir = join(resolve(cwd), LOG_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function hashPayload(payload) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function getNextSequence(cwd) {
  const path = logPath(cwd);
  if (!existsSync(path)) return 1;
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 1;
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return (typeof last.event_sequence === 'number' ? last.event_sequence : lines.length) + 1;
  } catch {
    return lines.length + 1;
  }
}

function rotateIfNeeded(cwd) {
  const path = logPath(cwd);
  if (!existsSync(path)) return;
  const stats = statSync(path);
  if (stats.size < ROTATION_THRESHOLD_BYTES) return;

  const rotatedName = `inbox-admission-${new Date().toISOString().slice(0, 10)}.log`;
  const rotatedPath = join(resolve(cwd), LOG_DIR, rotatedName);
  writeFileUtf8(rotatedPath, readFileSync(path, 'utf8'));
  writeFileUtf8(path, '');
}

/**
 * Append an admission log event.
 *
 * @param {string} cwd - Site root
 * @param {object} event - Event object (without event_id, event_sequence, timestamp)
 * @returns {object} The full event with generated fields
 */
export function appendAdmissionEvent(cwd, event) {
  ensureDir(cwd);
  rotateIfNeeded(cwd);

  const eventId = 'evt_' + randomUUID().replace(/-/g, '');
  const eventSequence = getNextSequence(cwd);
  const timestamp = new Date().toISOString();

  const fullEvent = {
    schema: 'narada.inbox.admission_log.entry.v0',
    event_id: eventId,
    event_sequence: eventSequence,
    timestamp,
    ...event,
  };

  const line = JSON.stringify(fullEvent) + '\n';
  appendFileSync(logPath(cwd), line, 'utf8');

  return fullEvent;
}

/**
 * Emit the standard envelope_received + envelope_admitted pair for a successfully submitted envelope.
 *
 * @param {string} cwd - Site root
 * @param {object} envelope - The admitted envelope
 * @param {object} meta - Submission metadata
 * @returns {object} The admitted event
 */
export function admitEnvelope(cwd, envelope) {
  const envelopesPath = join(resolve(cwd), ENVELOPES_DIR);
  if (!existsSync(envelopesPath)) {
    mkdirSync(envelopesPath, { recursive: true });
  }

  const envelopeId = envelope.envelope_id ?? ('env_' + randomUUID());
  const receivedAt = envelope.received_at ?? new Date().toISOString();
  const fullEnvelope = {
    ...envelope,
    envelope_id: envelopeId,
    received_at: receivedAt,
  };

  const payloadJson = JSON.stringify(fullEnvelope, null, 2);
  const safeTs = receivedAt.replace(/[:.]/g, '-');
  const fileName = `${safeTs}-${envelopeId}.json`;
  const envelopePath = join(envelopesPath, fileName);
  writeFileUtf8(envelopePath, payloadJson);

  const event = emitEnvelopeAdmitted(cwd, fullEnvelope, {
    principal: fullEnvelope.authority?.principal ?? 'unknown',
    authority_level: fullEnvelope.authority?.level ?? 'agent_reported',
    payload_uri: `${ENVELOPES_DIR}/${fileName}`,
    target_locus: fullEnvelope.target_locus ?? 'local_site',
  });

  return { envelopePath, event: { ...event, event_seq: event.event_sequence } };
}

export function emitEnvelopeAdmitted(cwd, envelope, meta = {}) {
  const payloadHash = hashPayload(envelope);
  const payloadUri = meta.payload_uri ?? `.ai/inbox-envelopes/${envelope.envelope_id}.json`;

  appendAdmissionEvent(cwd, {
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

  const admittedEvent = appendAdmissionEvent(cwd, {
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

  return admittedEvent;
}

/**
 * Record an envelope_acknowledged event.
 *
 * @param {string} cwd - Site root
 * @param {string} envelopeId - Envelope ID
 * @param {string} principal - Agent or operator identity performing the acknowledgment
 * @param {string} [reason] - Optional reason for acknowledgment
 * @returns {object} The acknowledgment event
 */
export function acknowledgeEnvelope(cwd, envelopeId, principal, reason) {
  return appendAdmissionEvent(cwd, {
    envelope_id: envelopeId,
    event_kind: 'envelope_acknowledged',
    principal: principal ?? 'unknown',
    authority_level: 'agent_reported',
    payload_hash: null,
    payload_uri: null,
    event_payload: {
      reason: reason ?? null,
    },
  });
}

/**
 * Record an envelope_dismissed event.
 *
 * @param {string} cwd - Site root
 * @param {string} envelopeId - Envelope ID
 * @param {string} principal - Agent or operator identity performing the dismissal
 * @param {string} [reason] - Required reason for dismissal
 * @returns {object} The dismissal event
 */
export function dismissEnvelope(cwd, envelopeId, principal, reason) {
  return appendAdmissionEvent(cwd, {
    envelope_id: envelopeId,
    event_kind: 'envelope_dismissed',
    principal: principal ?? 'unknown',
    authority_level: 'agent_reported',
    payload_hash: null,
    payload_uri: null,
    event_payload: {
      reason: reason ?? null,
    },
  });
}

/**
 * Read all events from the admission log.
 *
 * @param {string} cwd - Site root
 * @returns {Array<object>} Events in chronological order
 */
export function readAdmissionLog(cwd) {
  const path = logPath(cwd);
  if (!existsSync(path)) return [];

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

export function exportDispositionLedger(cwd, options = {}) {
  const outputPath = options.output_path ?? DEFAULT_DISPOSITION_EXPORT_PATH;
  const siteId = options.site_id ?? 'Narada';
  const events = readAdmissionLog(cwd)
    .filter((event) => DISPOSITION_EVENT_KINDS.has(event.event_kind))
    .map((event) => ({
      event_id: event.event_id,
      event_sequence: event.event_sequence,
      timestamp: event.timestamp,
      envelope_id: event.envelope_id,
      event_kind: event.event_kind,
      principal: event.principal ?? null,
      authority_level: event.authority_level ?? null,
      reason: event.event_payload?.reason ?? null,
      payload_hash: event.payload_hash ?? null,
      payload_uri: event.payload_uri ?? null,
      source_event: {
        schema: event.schema ?? null,
        event_payload: event.event_payload ?? null,
      },
    }));

  const exportPath = resolve(cwd, outputPath);
  const payload = {
    schema: 'narada.inbox.disposition_export.v0',
    exported_at: options.exported_at ?? new Date().toISOString(),
    site_id: siteId,
    source_authority: '.ai/state/inbox-admission.log',
    projection_not_authority: true,
    tracked_portability_path: outputPath,
    event_kinds: [...DISPOSITION_EVENT_KINDS].sort(),
    count: events.length,
    events,
  };
  writeFileUtf8(exportPath, `${JSON.stringify(payload, null, 2)}\n`);
  return {
    status: 'exported',
    schema: payload.schema,
    output_path: outputPath,
    absolute_path: exportPath,
    count: events.length,
    events,
  };
}

/** 
 * Get the latest event per envelope_id.
 *
 * @param {string} cwd - Site root
 * @returns {Map<string, object>} Map of envelope_id -> latest event
 */
export function getLatestEventsByEnvelope(cwd) {
  const events = readAdmissionLog(cwd);
  const map = new Map();
  for (const evt of events) {
    if (!evt.envelope_id) continue;
    const existing = map.get(evt.envelope_id);
    if (!existing || (evt.event_sequence ?? 0) > (existing.event_sequence ?? 0)) {
      map.set(evt.envelope_id, evt);
    }
  }
  return map;
}

/**
 * Compute the effective status of an envelope from its event history.
 *
 * @param {Array<object>} events - All events for a single envelope_id
 * @returns {string} Effective status: received, admitted, promoted, acknowledged, dismissed
 */
export function resolveEnvelopeStatus(events) {
  const kinds = new Set(events.map((e) => e.event_kind));
  if (kinds.has('envelope_dismissed')) return 'dismissed';
  if (kinds.has('envelope_acknowledged')) return 'acknowledged';
  if (kinds.has('envelope_promoted')) return 'promoted';
  if (kinds.has('envelope_admitted')) return 'admitted';
  if (kinds.has('envelope_received')) return 'received';
  return 'unknown';
}

/**
 * Record an envelope_promoted event.
 *
 * @param {string} cwd - Site root
 * @param {string} envelopeId - Envelope ID
 * @param {object} promotion - Promotion details
 * @returns {object} The promotion event
 */
export function recordPromotion(cwd, envelopeId, promotion) {
  return appendAdmissionEvent(cwd, {
    envelope_id: envelopeId,
    event_kind: 'envelope_promoted',
    principal: promotion?.promoted_by ?? 'unknown',
    authority_level: 'system_generated',
    payload_hash: null,
    payload_uri: null,
    event_payload: {
      promotion,
    },
  });
}
