import { randomUUID } from 'node:crypto';
import { DatabaseSync } from '@narada-core/sqlite';
import {
  MAX_INLINE_VALUE_BYTES,
  assertSerializedBound,
  canonicalJson,
  deterministicId,
  fingerprint,
  isJsonObject,
  normalizeValueRef,
  type JsonValue,
  type ValueRef,
} from './procedure-contract.js';

type JsonRecord = Record<string, unknown>;

export const SOP_TERMINAL_TOPIC = 'sop.run.terminal.v1';
export const SOP_HANDOFF_STATUSES = ['pending', 'leased', 'completed', 'failed', 'cancelled'] as const;
export const SOP_HANDOFF_EXECUTORS = ['agent', 'operator'] as const;

const MAX_HANDOFF_INSTRUCTIONS_BYTES = 16 * 1024;
const MAX_HANDOFF_SCHEMA_BYTES = 64 * 1024;
const MAX_OUTBOX_PAYLOAD_BYTES = 16 * 1024;
const MAX_OUTBOX_RECEIPT_BYTES = 8 * 1024;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60_000;

export type SopHandoff = {
  schema: 'narada.sop.handoff.v1';
  handoff_id: string;
  run_id: string;
  step_id: string;
  occurrence_key: string;
  sop_id: string;
  sop_version: number;
  executor: 'agent' | 'operator';
  title: string;
  instructions: string;
  input: JsonValue;
  input_ref: ValueRef | null;
  result_schema: JsonRecord | null;
  request_fingerprint: string;
  status: typeof SOP_HANDOFF_STATUSES[number];
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  completion_key: string | null;
  completion_fingerprint: string | null;
  principal: string | null;
  result: JsonRecord;
  result_ref: ValueRef | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type SopOutboxEvent = {
  schema: 'narada.sop.outbox_event.v1';
  event_id: string;
  topic: string;
  partition_key: string;
  run_id: string;
  sop_id: string;
  sop_version: number;
  occurrence_key: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  payload: JsonRecord;
  created_at: string;
  available_at: string;
  compacted_at: string | null;
};

export function prepareSopDurabilitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sop_handoffs (
      handoff_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES sop_runs(run_id),
      step_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE,
      sop_id TEXT NOT NULL,
      sop_version INTEGER NOT NULL,
      executor TEXT NOT NULL CHECK (executor IN ('agent', 'operator')),
      title TEXT NOT NULL,
      instructions TEXT NOT NULL
        CHECK (length(CAST(instructions AS BLOB)) <= ${MAX_HANDOFF_INSTRUCTIONS_BYTES}),
      input_json TEXT NOT NULL
        CHECK (length(CAST(input_json AS BLOB)) <= ${MAX_INLINE_VALUE_BYTES}),
      input_ref_json TEXT,
      result_schema_json TEXT,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'leased', 'completed', 'failed', 'cancelled')),
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      completion_key TEXT,
      completion_fingerprint TEXT,
      principal TEXT,
      result_json TEXT NOT NULL DEFAULT '{}'
        CHECK (length(CAST(result_json AS BLOB)) <= ${MAX_INLINE_VALUE_BYTES}),
      result_ref_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (run_id, step_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS sop_handoffs_delivery_idx
      ON sop_handoffs(status, lease_expires_at, created_at);

    CREATE TABLE IF NOT EXISTS sop_outbox (
      event_id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE REFERENCES sop_runs(run_id),
      sop_id TEXT NOT NULL,
      sop_version INTEGER NOT NULL,
      occurrence_key TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL
        CHECK (length(CAST(payload_json AS BLOB)) <= ${MAX_OUTBOX_PAYLOAD_BYTES}),
      created_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      compacted_at TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS sop_outbox_delivery_idx
      ON sop_outbox(topic, available_at, created_at);

    CREATE TABLE IF NOT EXISTS sop_outbox_consumer_requirements (
      topic TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      PRIMARY KEY(topic, consumer_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sop_outbox_receipts (
      event_id TEXT NOT NULL REFERENCES sop_outbox(event_id),
      consumer_id TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      receipt_json TEXT NOT NULL
        CHECK (length(CAST(receipt_json AS BLOB)) <= ${MAX_OUTBOX_RECEIPT_BYTES}),
      PRIMARY KEY(event_id, consumer_id)
    ) STRICT;
  `);
}

export function ensureSopHandoff(
  db: DatabaseSync,
  input: {
    run_id: string;
    step_id: string;
    sop_id: string;
    sop_version: number;
    executor: string;
    title: string;
    instructions: string;
    input: JsonValue;
    input_ref: ValueRef | null;
    result_schema: JsonRecord | null;
  },
  now = new Date(),
): SopHandoff {
  const runId = boundedString(input.run_id, 'sop_handoff_run_id_required', 512);
  const stepId = boundedString(input.step_id, 'sop_handoff_step_id_required', 512);
  const sopId = boundedString(input.sop_id, 'sop_handoff_sop_id_required', 512);
  const sopVersion = positiveInteger(input.sop_version, 'sop_handoff_sop_version_invalid');
  const executor = normalizeExecutor(input.executor);
  const title = boundedString(input.title, 'sop_handoff_title_required', 512);
  const instructions = boundedString(input.instructions, 'sop_handoff_instructions_required', MAX_HANDOFF_INSTRUCTIONS_BYTES);
  assertSerializedBound(input.input, 'sop_handoff_input', MAX_INLINE_VALUE_BYTES);
  const inputRef = normalizeValueRef(input.input_ref, 'sop_handoff_input_ref');
  const resultSchema = input.result_schema;
  if (resultSchema !== null) assertSerializedBound(resultSchema, 'sop_handoff_result_schema', MAX_HANDOFF_SCHEMA_BYTES);

  const handoffId = deterministicId('soh_', `${runId}\0${stepId}`);
  const occurrenceKey = deterministicId('sop_handoff_', `${runId}\0${stepId}`);
  const requestFingerprint = fingerprint({
    run_id: runId,
    step_id: stepId,
    sop_id: sopId,
    sop_version: sopVersion,
    executor,
    title,
    instructions,
    input: input.input,
    input_ref: inputRef,
    result_schema: resultSchema,
  });
  const existing = db.prepare('SELECT * FROM sop_handoffs WHERE run_id = ? AND step_id = ?').get(runId, stepId) as JsonRecord | undefined;
  if (existing) {
    const handoff = hydrateSopHandoff(existing);
    if (handoff.handoff_id !== handoffId || handoff.request_fingerprint !== requestFingerprint) {
      throw durabilityError('sop_handoff_intent_conflict', { run_id: runId, step_id: stepId });
    }
    return handoff;
  }

  const timestamp = now.toISOString();
  db.prepare(`
    INSERT INTO sop_handoffs(
      handoff_id, run_id, step_id, occurrence_key, sop_id, sop_version,
      executor, title, instructions, input_json, input_ref_json,
      result_schema_json, request_fingerprint, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    handoffId,
    runId,
    stepId,
    occurrenceKey,
    sopId,
    sopVersion,
    executor,
    title,
    instructions,
    canonicalJson(input.input),
    nullableJson(inputRef),
    nullableJson(resultSchema),
    requestFingerprint,
    timestamp,
    timestamp,
  );
  return getSopHandoff(db, handoffId);
}

export function getSopHandoff(db: DatabaseSync, handoffId: string): SopHandoff {
  const id = boundedString(handoffId, 'sop_handoff_id_required', 512);
  const row = db.prepare('SELECT * FROM sop_handoffs WHERE handoff_id = ?').get(id) as JsonRecord | undefined;
  if (!row) throw durabilityError('sop_handoff_not_found', { handoff_id: id });
  return hydrateSopHandoff(row);
}

export function listSopHandoffs(
  db: DatabaseSync,
  options: { run_id?: string | null; executor?: string | null; status?: string | null; limit?: number },
): SopHandoff[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.run_id) {
    conditions.push('run_id = ?');
    params.push(boundedString(options.run_id, 'sop_handoff_run_id_required', 512));
  }
  if (options.executor) {
    conditions.push('executor = ?');
    params.push(normalizeExecutor(options.executor));
  }
  if (options.status) {
    conditions.push('status = ?');
    params.push(normalizeHandoffStatus(options.status));
  }
  const limit = boundedInteger(options.limit ?? 50, 1, 100, 'sop_handoff_limit_invalid');
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sop_handoffs${where} ORDER BY created_at, handoff_id LIMIT ?`).all(...params, limit) as JsonRecord[];
  return rows.map(hydrateSopHandoff);
}

export function claimSopHandoff(
  db: DatabaseSync,
  input: { consumer_id: string; handoff_id?: string | null; executor?: string | null; lease_ms?: number },
  now = new Date(),
): SopHandoff | null {
  const consumerId = boundedString(input.consumer_id, 'sop_handoff_consumer_id_required', 512);
  const requestedHandoffId = input.handoff_id
    ? boundedString(input.handoff_id, 'sop_handoff_id_required', 512)
    : null;
  const executor = input.executor ? normalizeExecutor(input.executor) : null;
  const leaseMs = boundedInteger(input.lease_ms ?? 60_000, MIN_LEASE_MS, MAX_LEASE_MS, 'sop_handoff_lease_ms_invalid');
  const nowText = now.toISOString();
  const conditions = [
    "(handoff.status = 'pending' OR (handoff.status = 'leased' AND handoff.lease_expires_at <= ?))",
    "run.status NOT IN ('completed', 'failed', 'cancelled')",
  ];
  const params: string[] = [nowText];
  if (requestedHandoffId) {
    conditions.push('handoff.handoff_id = ?');
    params.push(requestedHandoffId);
  }
  if (executor) {
    conditions.push('handoff.executor = ?');
    params.push(executor);
  }
  const candidate = db.prepare(`
    SELECT handoff.* FROM sop_handoffs handoff
    JOIN sop_runs run ON run.run_id = handoff.run_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY handoff.created_at, handoff.handoff_id LIMIT 1
  `).get(...params) as JsonRecord | undefined;
  if (!candidate) return null;

  const handoffId = String(candidate.handoff_id);
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = db.prepare(`
    UPDATE sop_handoffs
       SET status = 'leased', lease_owner = ?, lease_token = ?, lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           last_error = CASE WHEN status = 'leased' THEN 'lease_expired' ELSE last_error END,
           updated_at = ?
     WHERE handoff_id = ?
       AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= ?))
  `).run(consumerId, leaseToken, leaseExpiresAt, nowText, handoffId, nowText);
  if (result.changes !== 1) throw durabilityError('sop_handoff_claim_race', { handoff_id: handoffId });
  return getSopHandoff(db, handoffId);
}

export function renewSopHandoff(
  db: DatabaseSync,
  input: { handoff_id: string; consumer_id: string; lease_token: string; lease_ms?: number },
  now = new Date(),
): SopHandoff {
  const handoff = requireLease(db, input, now, false);
  const leaseMs = boundedInteger(input.lease_ms ?? 60_000, MIN_LEASE_MS, MAX_LEASE_MS, 'sop_handoff_lease_ms_invalid');
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  db.prepare('UPDATE sop_handoffs SET lease_expires_at = ?, updated_at = ? WHERE handoff_id = ?').run(leaseExpiresAt, now.toISOString(), handoff.handoff_id);
  return getSopHandoff(db, handoff.handoff_id);
}

export function releaseSopHandoff(
  db: DatabaseSync,
  input: { handoff_id: string; consumer_id: string; lease_token: string; error_message?: string | null },
  now = new Date(),
): SopHandoff {
  const handoff = requireLease(db, input, now, true);
  const errorMessage = input.error_message === undefined || input.error_message === null
    ? null
    : boundedString(input.error_message, 'sop_handoff_error_message_too_long', 4096);
  db.prepare(`
    UPDATE sop_handoffs
       SET status = 'pending', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, last_error = ?, updated_at = ?
     WHERE handoff_id = ?
  `).run(errorMessage, now.toISOString(), handoff.handoff_id);
  return getSopHandoff(db, handoff.handoff_id);
}

export function completeSopHandoff(
  db: DatabaseSync,
  input: {
    handoff_id: string;
    run_id: string;
    step_id: string;
    consumer_id: string;
    lease_token: string;
    completion_key: string;
    outcome: 'completed' | 'failed';
    principal: string;
    result: JsonRecord;
    result_ref: ValueRef | null;
    error_message: string | null;
  },
  now = new Date(),
): { handoff: SopHandoff; completion_replayed: boolean } {
  const handoff = getSopHandoff(db, input.handoff_id);
  const runId = boundedString(input.run_id, 'sop_handoff_run_id_required', 512);
  const stepId = boundedString(input.step_id, 'sop_handoff_step_id_required', 512);
  const consumerId = boundedString(input.consumer_id, 'sop_handoff_consumer_id_required', 512);
  const leaseToken = boundedString(input.lease_token, 'sop_handoff_lease_token_required', 512);
  const completionKey = boundedString(input.completion_key, 'sop_handoff_completion_key_required', 512);
  const principal = boundedString(input.principal, 'sop_handoff_principal_required', 512);
  if (handoff.run_id !== runId || handoff.step_id !== stepId) {
    throw durabilityError('sop_handoff_run_binding_mismatch', { handoff_id: handoff.handoff_id, run_id: runId, step_id: stepId });
  }
  if (input.outcome !== 'completed' && input.outcome !== 'failed') throw durabilityError('sop_handoff_outcome_invalid');
  assertSerializedBound(input.result, 'sop_handoff_result', MAX_INLINE_VALUE_BYTES);
  const resultRef = normalizeValueRef(input.result_ref, 'sop_handoff_result_ref');
  const errorMessage = input.error_message === null ? null : boundedString(input.error_message, 'sop_handoff_error_message_too_long', 4096);
  if (input.outcome === 'failed' && !errorMessage) throw durabilityError('sop_handoff_failed_requires_error_message');
  const completionFingerprint = fingerprint({
    completion_key: completionKey,
    outcome: input.outcome,
    principal,
    result: input.result,
    result_ref: resultRef,
    error_message: errorMessage,
  });

  if (handoff.completion_fingerprint) {
    if (handoff.completion_key === completionKey && handoff.completion_fingerprint === completionFingerprint) {
      return { handoff, completion_replayed: true };
    }
    throw durabilityError('sop_handoff_completion_conflict', {
      handoff_id: handoff.handoff_id,
      recorded_completion_key: handoff.completion_key,
      supplied_completion_key: completionKey,
    });
  }
  if (handoff.status !== 'leased') throw durabilityError('sop_handoff_not_leased', { handoff_id: handoff.handoff_id, status: handoff.status });
  if (handoff.lease_owner !== consumerId || handoff.lease_token !== leaseToken) {
    throw durabilityError('sop_handoff_lease_mismatch', { handoff_id: handoff.handoff_id, lease_owner: handoff.lease_owner });
  }
  if (!handoff.lease_expires_at || handoff.lease_expires_at <= now.toISOString()) {
    throw durabilityError('sop_handoff_lease_expired', { handoff_id: handoff.handoff_id, lease_expires_at: handoff.lease_expires_at });
  }

  const completedAt = now.toISOString();
  db.prepare(`
    UPDATE sop_handoffs
       SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           completion_key = ?, completion_fingerprint = ?, principal = ?,
           result_json = ?, result_ref_json = ?, error_message = ?,
           updated_at = ?, completed_at = ?
     WHERE handoff_id = ?
  `).run(
    input.outcome,
    completionKey,
    completionFingerprint,
    principal,
    canonicalJson(input.result),
    nullableJson(resultRef),
    errorMessage,
    completedAt,
    completedAt,
    handoff.handoff_id,
  );
  return { handoff: getSopHandoff(db, handoff.handoff_id), completion_replayed: false };
}

export function cancelSopHandoffsForRun(db: DatabaseSync, runId: string, reason: string, now = new Date()): number {
  const result = db.prepare(`
    UPDATE sop_handoffs
       SET status = 'cancelled', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, last_error = ?, updated_at = ?, completed_at = ?
     WHERE run_id = ? AND status IN ('pending', 'leased')
  `).run(
    boundedString(reason, 'sop_handoff_cancellation_reason_too_long', 4096),
    now.toISOString(),
    now.toISOString(),
    boundedString(runId, 'sop_handoff_run_id_required', 512),
  );
  return Number(result.changes);
}

export function putSopTerminalOutbox(
  db: DatabaseSync,
  run: {
    run_id: string;
    sop_id: string;
    sop_version: number;
    occurrence_key: string;
    status: string;
    definition_fingerprint: string;
    trigger_source_kind: string;
    trigger_source_ref: string;
    output: JsonValue;
    output_ref: ValueRef | null;
    completed_at: string | null;
  },
  now = new Date(),
): SopOutboxEvent {
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
    throw durabilityError('sop_outbox_requires_terminal_run', { run_id: run.run_id, status: run.status });
  }
  if (!isJsonObject(run.output)) {
    throw durabilityError('sop_outbox_output_invalid', { run_id: run.run_id });
  }
  const output = run.output as JsonRecord;
  const eventId = deterministicId('sote_', run.run_id);
  const createdAt = run.completed_at ?? now.toISOString();
  const procedureOutcome = run.status === 'completed' && typeof output.outcome === 'string'
    ? boundedString(output.outcome, 'sop_outbox_procedure_outcome_invalid', 128)
    : run.status;
  const payload: JsonRecord = {
    schema: 'narada.sop.run_terminal.v2',
    event_id: eventId,
    topic: SOP_TERMINAL_TOPIC,
    run_id: run.run_id,
    sop_id: run.sop_id,
    sop_version: run.sop_version,
    occurrence_key: run.occurrence_key,
    run_outcome: run.status,
    outcome: procedureOutcome,
    definition_fingerprint: run.definition_fingerprint,
    trigger_source_kind: run.trigger_source_kind,
    trigger_source_ref: run.trigger_source_ref,
    output,
    output_ref: run.output_ref,
    completed_at: createdAt,
  };
  assertSerializedBound(payload, 'sop_outbox_payload', MAX_OUTBOX_PAYLOAD_BYTES);
  const payloadJson = canonicalJson(payload);
  const existing = db.prepare('SELECT * FROM sop_outbox WHERE event_id = ? OR run_id = ?').get(eventId, run.run_id) as JsonRecord | undefined;
  if (existing) {
    const hydrated = hydrateOutboxEvent(existing);
    const identityMatches = hydrated.event_id === eventId
      && hydrated.topic === SOP_TERMINAL_TOPIC
      && hydrated.run_id === run.run_id
      && hydrated.sop_id === run.sop_id
      && hydrated.sop_version === run.sop_version
      && hydrated.occurrence_key === run.occurrence_key
      && hydrated.outcome === run.status;
    const payloadMatches = hydrated.compacted_at !== null || (
      String(hydrated.payload.definition_fingerprint ?? '') === run.definition_fingerprint
      && String(hydrated.payload.trigger_source_kind ?? '') === run.trigger_source_kind
      && String(hydrated.payload.trigger_source_ref ?? '') === run.trigger_source_ref
      && String(hydrated.payload.run_outcome ?? '') === run.status
      && String(hydrated.payload.outcome ?? '') === procedureOutcome
      && canonicalJson((hydrated.payload.output ?? {}) as JsonValue) === canonicalJson(output as JsonValue)
      && canonicalJson((hydrated.payload.output_ref ?? null) as JsonValue) === canonicalJson(run.output_ref)
    );
    if (!identityMatches || !payloadMatches) throw durabilityError('sop_outbox_event_conflict', { event_id: eventId, run_id: run.run_id });
    return hydrated;
  }
  db.prepare(`
    INSERT INTO sop_outbox(
      event_id, topic, partition_key, run_id, sop_id, sop_version,
      occurrence_key, outcome, payload_json, created_at, available_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    SOP_TERMINAL_TOPIC,
    run.sop_id,
    run.run_id,
    run.sop_id,
    run.sop_version,
    run.occurrence_key,
    run.status,
    payloadJson,
    createdAt,
    createdAt,
  );
  return requireOutboxEvent(db, eventId);
}

export function reopenSopTerminalOutboxForRetry(db: DatabaseSync, runId: string): { event_id: string | null; reopened: boolean } {
  const boundedRunId = boundedString(runId, 'sop_outbox_run_id_required', 512);
  const existing = db.prepare('SELECT event_id, compacted_at FROM sop_outbox WHERE run_id = ?').get(boundedRunId) as JsonRecord | undefined;
  if (!existing) return { event_id: null, reopened: false };
  const eventId = boundedString(existing.event_id, 'sop_outbox_event_id_invalid', 512);
  const receipt = db.prepare('SELECT 1 FROM sop_outbox_receipts WHERE event_id = ? LIMIT 1').get(eventId) as JsonRecord | undefined;
  if (receipt || existing.compacted_at !== null) {
    throw durabilityError('sop_outbox_retry_requires_new_run', { event_id: eventId, run_id: boundedRunId, consumed: Boolean(receipt), compacted: existing.compacted_at !== null });
  }
  db.prepare('DELETE FROM sop_outbox WHERE event_id = ? AND run_id = ?').run(eventId, boundedRunId);
  return { event_id: eventId, reopened: true };
}

export function registerSopOutboxConsumer(
  db: DatabaseSync,
  input: { topic?: string; consumer_id: string; start_at?: string | null },
  now = new Date(),
): JsonRecord {
  const topic = normalizeTopic(input.topic ?? SOP_TERMINAL_TOPIC);
  const consumerId = boundedString(input.consumer_id, 'sop_outbox_consumer_id_required', 512);
  const startAt = normalizeTimestamp(input.start_at ?? now.toISOString(), 'sop_outbox_start_at_invalid');
  const existing = db.prepare('SELECT * FROM sop_outbox_consumer_requirements WHERE topic = ? AND consumer_id = ?').get(topic, consumerId) as JsonRecord | undefined;
  if (existing) {
    if (String(existing.start_at) !== startAt) {
      throw durabilityError('sop_outbox_consumer_registration_conflict', {
        topic,
        consumer_id: consumerId,
        recorded_start_at: existing.start_at,
        supplied_start_at: startAt,
      });
    }
    return { schema: 'narada.sop.outbox_consumer.v1', ...existing, registration_replayed: true };
  }
  const compacted = db.prepare(`
    SELECT event_id, created_at FROM sop_outbox
     WHERE topic = ? AND created_at >= ? AND compacted_at IS NOT NULL
     ORDER BY created_at LIMIT 1
  `).get(topic, startAt) as JsonRecord | undefined;
  if (compacted) {
    throw durabilityError('sop_outbox_registration_history_compacted', {
      topic,
      consumer_id: consumerId,
      start_at: startAt,
      first_compacted_event_id: compacted.event_id,
      first_compacted_event_created_at: compacted.created_at,
    });
  }
  const registeredAt = now.toISOString();
  db.prepare('INSERT INTO sop_outbox_consumer_requirements(topic, consumer_id, start_at, registered_at) VALUES (?, ?, ?, ?)').run(topic, consumerId, startAt, registeredAt);
  return { schema: 'narada.sop.outbox_consumer.v1', topic, consumer_id: consumerId, start_at: startAt, registered_at: registeredAt, registration_replayed: false };
}

export function listSopOutbox(
  db: DatabaseSync,
  input: { consumer_id: string; topic?: string | null; limit?: number },
  now = new Date(),
): SopOutboxEvent[] {
  const consumerId = boundedString(input.consumer_id, 'sop_outbox_consumer_id_required', 512);
  const topic = input.topic ? normalizeTopic(input.topic) : null;
  const limit = boundedInteger(input.limit ?? 100, 1, 500, 'sop_outbox_limit_invalid');
  const requirements = topic
    ? db.prepare('SELECT * FROM sop_outbox_consumer_requirements WHERE consumer_id = ? AND topic = ?').all(consumerId, topic) as JsonRecord[]
    : db.prepare('SELECT * FROM sop_outbox_consumer_requirements WHERE consumer_id = ? ORDER BY topic').all(consumerId) as JsonRecord[];
  if (requirements.length === 0) throw durabilityError('sop_outbox_consumer_not_registered', { consumer_id: consumerId, topic });
  const topics = requirements.map((row) => String(row.topic));
  const rows = db.prepare(`
    SELECT outbox.* FROM sop_outbox outbox
    JOIN sop_outbox_consumer_requirements requirement
      ON requirement.topic = outbox.topic AND requirement.consumer_id = ?
    WHERE outbox.topic IN (${topics.map(() => '?').join(', ')})
      AND outbox.created_at >= requirement.start_at
      AND outbox.available_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM sop_outbox_receipts receipt
         WHERE receipt.event_id = outbox.event_id AND receipt.consumer_id = ?
      )
    ORDER BY outbox.created_at, outbox.event_id LIMIT ?
  `).all(consumerId, ...topics, now.toISOString(), consumerId, limit) as JsonRecord[];
  return rows.map(hydrateOutboxEvent);
}

export function acknowledgeSopOutbox(
  db: DatabaseSync,
  input: { event_id: string; consumer_id: string; receipt: JsonRecord },
  now = new Date(),
): JsonRecord {
  const eventId = boundedString(input.event_id, 'sop_outbox_event_id_required', 512);
  const consumerId = boundedString(input.consumer_id, 'sop_outbox_consumer_id_required', 512);
  assertSerializedBound(input.receipt, 'sop_outbox_receipt', MAX_OUTBOX_RECEIPT_BYTES);
  const receiptJson = canonicalJson(input.receipt);
  const event = requireOutboxEvent(db, eventId);
  const requirement = db.prepare('SELECT * FROM sop_outbox_consumer_requirements WHERE topic = ? AND consumer_id = ?').get(event.topic, consumerId) as JsonRecord | undefined;
  if (!requirement) throw durabilityError('sop_outbox_consumer_not_registered', { consumer_id: consumerId, topic: event.topic });
  if (event.created_at < String(requirement.start_at)) {
    throw durabilityError('sop_outbox_event_before_consumer_start', { event_id: eventId, consumer_id: consumerId, start_at: requirement.start_at });
  }
  const existing = db.prepare('SELECT * FROM sop_outbox_receipts WHERE event_id = ? AND consumer_id = ?').get(eventId, consumerId) as JsonRecord | undefined;
  if (existing) {
    if (canonicalJson(parseJsonRecord(existing.receipt_json, 'sop_outbox_receipt_corrupt')) !== receiptJson) {
      throw durabilityError('sop_outbox_receipt_conflict', { event_id: eventId, consumer_id: consumerId });
    }
    return { schema: 'narada.sop.outbox_ack.v1', event_id: eventId, consumer_id: consumerId, processed_at: existing.processed_at, acknowledgement_replayed: true };
  }
  const processedAt = now.toISOString();
  db.prepare('INSERT INTO sop_outbox_receipts(event_id, consumer_id, processed_at, receipt_json) VALUES (?, ?, ?, ?)').run(eventId, consumerId, processedAt, receiptJson);
  return { schema: 'narada.sop.outbox_ack.v1', event_id: eventId, consumer_id: consumerId, processed_at: processedAt, acknowledgement_replayed: false };
}

export function compactSopOutbox(db: DatabaseSync, before: string, now = new Date()): JsonRecord {
  const cutoff = normalizeTimestamp(before, 'sop_outbox_compact_before_invalid');
  const compactedAt = now.toISOString();
  const result = db.prepare(`
    UPDATE sop_outbox AS outbox
       SET payload_json = '{}', compacted_at = ?
     WHERE outbox.compacted_at IS NULL
       AND outbox.created_at < ?
       AND EXISTS (
         SELECT 1 FROM sop_outbox_consumer_requirements requirement
          WHERE requirement.topic = outbox.topic AND requirement.start_at <= outbox.created_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM sop_outbox_consumer_requirements requirement
          WHERE requirement.topic = outbox.topic
            AND requirement.start_at <= outbox.created_at
            AND NOT EXISTS (
              SELECT 1 FROM sop_outbox_receipts receipt
               WHERE receipt.event_id = outbox.event_id
                 AND receipt.consumer_id = requirement.consumer_id
            )
       )
  `).run(compactedAt, cutoff);
  return { schema: 'narada.sop.outbox_compaction.v1', before: cutoff, compacted_at: compactedAt, compacted: Number(result.changes) };
}

export function sopDurabilityStats(db: DatabaseSync): JsonRecord {
  const handoffs = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased
    FROM sop_handoffs
  `).get() as JsonRecord;
  const outbox = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN compacted_at IS NULL THEN 1 ELSE 0 END) AS retained_payloads,
      SUM(CASE WHEN compacted_at IS NOT NULL THEN 1 ELSE 0 END) AS compacted
    FROM sop_outbox
  `).get() as JsonRecord;
  const consumers = db.prepare('SELECT COUNT(*) AS total FROM sop_outbox_consumer_requirements').get() as JsonRecord;
  return {
    handoffs: { total: Number(handoffs.total ?? 0), pending: Number(handoffs.pending ?? 0), leased: Number(handoffs.leased ?? 0) },
    outbox: { total: Number(outbox.total ?? 0), retained_payloads: Number(outbox.retained_payloads ?? 0), compacted: Number(outbox.compacted ?? 0) },
    outbox_consumers: Number(consumers.total ?? 0),
  };
}

export function publicSopHandoff(handoff: SopHandoff, includeLeaseToken = false): JsonRecord {
  const { lease_token: leaseToken, ...rest } = handoff;
  return includeLeaseToken ? { ...rest, lease_token: leaseToken } : rest;
}

function hydrateSopHandoff(row: JsonRecord): SopHandoff {
  const runId = requiredString(row.run_id, 'sop_handoff_corrupt');
  const stepId = requiredString(row.step_id, 'sop_handoff_corrupt');
  const handoffId = requiredString(row.handoff_id, 'sop_handoff_corrupt');
  const occurrenceKey = requiredString(row.occurrence_key, 'sop_handoff_corrupt');
  const expectedHandoffId = deterministicId('soh_', `${runId}\0${stepId}`);
  const expectedOccurrenceKey = deterministicId('sop_handoff_', `${runId}\0${stepId}`);
  if (handoffId !== expectedHandoffId || occurrenceKey !== expectedOccurrenceKey) {
    throw durabilityError('sop_handoff_identity_mismatch', { handoff_id: handoffId, expected_handoff_id: expectedHandoffId });
  }
  const input = parseJsonValue(row.input_json, 'sop_handoff_input_corrupt');
  const inputRef = normalizeValueRef(parseNullableJson(row.input_ref_json, 'sop_handoff_input_ref_corrupt'), 'sop_handoff_input_ref');
  const resultSchemaValue = parseNullableJson(row.result_schema_json, 'sop_handoff_result_schema_corrupt');
  const resultSchema = resultSchemaValue === null ? null : asJsonRecord(resultSchemaValue, 'sop_handoff_result_schema_corrupt');
  const result = parseJsonRecord(row.result_json, 'sop_handoff_result_corrupt');
  const resultRef = normalizeValueRef(parseNullableJson(row.result_ref_json, 'sop_handoff_result_ref_corrupt'), 'sop_handoff_result_ref');
  const executor = normalizeExecutor(row.executor);
  const status = normalizeHandoffStatus(row.status);
  const requestFingerprint = requiredString(row.request_fingerprint, 'sop_handoff_corrupt');
  const actualRequestFingerprint = fingerprint({
    run_id: runId,
    step_id: stepId,
    sop_id: String(row.sop_id),
    sop_version: Number(row.sop_version),
    executor,
    title: String(row.title),
    instructions: String(row.instructions),
    input,
    input_ref: inputRef,
    result_schema: resultSchema,
  });
  if (requestFingerprint !== actualRequestFingerprint) {
    throw durabilityError('sop_handoff_request_fingerprint_mismatch', { handoff_id: handoffId });
  }
  const leaseOwner = optionalString(row.lease_owner);
  const leaseToken = optionalString(row.lease_token);
  const leaseExpiresAt = optionalString(row.lease_expires_at);
  if (status === 'leased') {
    if (!leaseOwner || !leaseToken || !leaseExpiresAt) throw durabilityError('sop_handoff_lease_corrupt', { handoff_id: handoffId });
  } else if (leaseOwner || leaseToken || leaseExpiresAt) {
    throw durabilityError('sop_handoff_lease_corrupt', { handoff_id: handoffId, status });
  }
  const completionKey = optionalString(row.completion_key);
  const completionFingerprint = optionalString(row.completion_fingerprint);
  const principal = optionalString(row.principal);
  const errorMessage = optionalString(row.error_message);
  if (completionFingerprint) {
    if (!completionKey || !principal || (status !== 'completed' && status !== 'failed')) {
      throw durabilityError('sop_handoff_completion_identity_invalid', { handoff_id: handoffId, status });
    }
    const actualCompletionFingerprint = fingerprint({
      completion_key: completionKey,
      outcome: status,
      principal,
      result,
      result_ref: resultRef,
      error_message: errorMessage,
    });
    if (completionFingerprint !== actualCompletionFingerprint) {
      throw durabilityError('sop_handoff_completion_fingerprint_mismatch', { handoff_id: handoffId });
    }
  } else if (completionKey || principal || status === 'completed' || status === 'failed') {
    throw durabilityError('sop_handoff_completion_identity_invalid', { handoff_id: handoffId, status });
  }
  return {
    schema: 'narada.sop.handoff.v1',
    handoff_id: handoffId,
    run_id: runId,
    step_id: stepId,
    occurrence_key: occurrenceKey,
    sop_id: requiredString(row.sop_id, 'sop_handoff_corrupt'),
    sop_version: positiveInteger(row.sop_version, 'sop_handoff_corrupt'),
    executor,
    title: requiredString(row.title, 'sop_handoff_corrupt'),
    instructions: requiredString(row.instructions, 'sop_handoff_corrupt'),
    input,
    input_ref: inputRef,
    result_schema: resultSchema,
    request_fingerprint: requestFingerprint,
    status,
    lease_owner: leaseOwner,
    lease_token: leaseToken,
    lease_expires_at: leaseExpiresAt,
    attempt_count: nonNegativeInteger(row.attempt_count, 'sop_handoff_attempt_count_invalid'),
    last_error: optionalString(row.last_error),
    completion_key: completionKey,
    completion_fingerprint: completionFingerprint,
    principal,
    result,
    result_ref: resultRef,
    error_message: errorMessage,
    created_at: requiredString(row.created_at, 'sop_handoff_corrupt'),
    updated_at: requiredString(row.updated_at, 'sop_handoff_corrupt'),
    completed_at: optionalString(row.completed_at),
  };
}

function requireLease(
  db: DatabaseSync,
  input: { handoff_id: string; consumer_id: string; lease_token: string },
  now: Date,
  allowExpired: boolean,
): SopHandoff {
  const handoff = getSopHandoff(db, input.handoff_id);
  const consumerId = boundedString(input.consumer_id, 'sop_handoff_consumer_id_required', 512);
  const leaseToken = boundedString(input.lease_token, 'sop_handoff_lease_token_required', 512);
  if (handoff.status !== 'leased') throw durabilityError('sop_handoff_not_leased', { handoff_id: handoff.handoff_id, status: handoff.status });
  if (handoff.lease_owner !== consumerId || handoff.lease_token !== leaseToken) {
    throw durabilityError('sop_handoff_lease_mismatch', { handoff_id: handoff.handoff_id, lease_owner: handoff.lease_owner });
  }
  if (!allowExpired && (!handoff.lease_expires_at || handoff.lease_expires_at <= now.toISOString())) {
    throw durabilityError('sop_handoff_lease_expired', { handoff_id: handoff.handoff_id, lease_expires_at: handoff.lease_expires_at });
  }
  return handoff;
}

function requireOutboxEvent(db: DatabaseSync, eventId: string): SopOutboxEvent {
  const row = db.prepare('SELECT * FROM sop_outbox WHERE event_id = ?').get(eventId) as JsonRecord | undefined;
  if (!row) throw durabilityError('sop_outbox_event_not_found', { event_id: eventId });
  return hydrateOutboxEvent(row);
}

function hydrateOutboxEvent(row: JsonRecord): SopOutboxEvent {
  const outcome = String(row.outcome);
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') throw durabilityError('sop_outbox_outcome_corrupt');
  return {
    schema: 'narada.sop.outbox_event.v1',
    event_id: requiredString(row.event_id, 'sop_outbox_event_corrupt'),
    topic: normalizeTopic(row.topic),
    partition_key: requiredString(row.partition_key, 'sop_outbox_event_corrupt'),
    run_id: requiredString(row.run_id, 'sop_outbox_event_corrupt'),
    sop_id: requiredString(row.sop_id, 'sop_outbox_event_corrupt'),
    sop_version: positiveInteger(row.sop_version, 'sop_outbox_event_corrupt'),
    occurrence_key: requiredString(row.occurrence_key, 'sop_outbox_event_corrupt'),
    outcome,
    payload: parseJsonRecord(row.payload_json, 'sop_outbox_payload_corrupt'),
    created_at: requiredString(row.created_at, 'sop_outbox_event_corrupt'),
    available_at: requiredString(row.available_at, 'sop_outbox_event_corrupt'),
    compacted_at: optionalString(row.compacted_at),
  };
}

function normalizeExecutor(value: unknown): 'agent' | 'operator' {
  const executor = String(value ?? '');
  if (executor !== 'agent' && executor !== 'operator') throw durabilityError('sop_handoff_executor_invalid', { executor });
  return executor;
}

function normalizeHandoffStatus(value: unknown): typeof SOP_HANDOFF_STATUSES[number] {
  const status = String(value ?? '');
  if (!SOP_HANDOFF_STATUSES.includes(status as typeof SOP_HANDOFF_STATUSES[number])) throw durabilityError('sop_handoff_status_invalid', { status });
  return status as typeof SOP_HANDOFF_STATUSES[number];
}

function normalizeTopic(value: unknown): string {
  const topic = boundedString(value, 'sop_outbox_topic_required', 256);
  if (topic !== SOP_TERMINAL_TOPIC) throw durabilityError('sop_outbox_topic_unsupported', { topic, allowed: [SOP_TERMINAL_TOPIC] });
  return topic;
}

function normalizeTimestamp(value: unknown, code: string): string {
  const text = requiredString(value, code);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw durabilityError(code, { value: text });
  return parsed.toISOString();
}

function boundedInteger(value: unknown, min: number, max: number, code: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw durabilityError(code, { value, min, max });
  return parsed;
}

function positiveInteger(value: unknown, code: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, code);
}

function nonNegativeInteger(value: unknown, code: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, code);
}

function boundedString(value: unknown, code: string, maxLength: number): string {
  const text = requiredString(value, code);
  if (text.length > maxLength) throw durabilityError(code, { length: text.length, max_length: maxLength });
  return text;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw durabilityError(code);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullableJson(value: unknown): string | null {
  return value === null || value === undefined ? null : canonicalJson(value as JsonValue);
}

function parseJsonValue(value: unknown, code: string): JsonValue {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (parsed === undefined) throw new Error('undefined');
    return parsed as JsonValue;
  } catch {
    throw durabilityError(code);
  }
}

function parseNullableJson(value: unknown, code: string): unknown {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    throw durabilityError(code);
  }
}

function parseJsonRecord(value: unknown, code: string): JsonRecord {
  return asJsonRecord(parseJsonValue(value, code), code);
}

function asJsonRecord(value: unknown, code: string): JsonRecord {
  if (!isJsonObject(value)) throw durabilityError(code);
  return value;
}

function durabilityError(code: string, details: JsonRecord = {}): Error {
  const error = new Error(code);
  Object.assign(error, { codeName: code, details });
  return error;
}
