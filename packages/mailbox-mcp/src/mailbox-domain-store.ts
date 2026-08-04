import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JsonRecord = Record<string, unknown>;

export type SyncGenerationStatus = 'accepted' | 'staged' | 'completed' | 'failed';

export interface SyncGenerationRow {
  generation_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  scope_id: string;
  config_fingerprint: string;
  status: SyncGenerationStatus;
  parent_cursor: string | null;
  next_cursor: string | null;
  batch_path: string | null;
  batch_sha256: string | null;
  batch_record_count: number;
  receipt: JsonRecord | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface OutboxPage {
  items: JsonRecord[];
  has_more: boolean;
}

export interface StagedGenerationRecord {
  record_id: string;
  ordinal: string | null;
  fact_id: string;
  event_kind: string;
  message_id: string | null;
  mailbox_id: string | null;
  conversation_id: string | null;
  source_version: string | null;
}

export interface GenerationRecordRow extends StagedGenerationRecord {
  generation_id: string;
  application_status: 'staged' | 'already_applied' | 'projected' | 'not_applied' | 'reconciled';
}

export interface GenerationClaim {
  generation: SyncGenerationRow;
  lease_token: string | null;
}

export interface FirstObservationCandidate {
  mailbox_id: string;
  message_id: string;
  fact_id: string;
  conversation_id: string | null;
}

const LEASE_MS = 30_000;

export class MailboxDomainStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = WAL; pragma foreign_keys = ON; pragma busy_timeout = 5000;');
    try {
      this.initSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  observationByMessage(scopeId: string, messageId: string): JsonRecord | null {
    const row = this.db.prepare(`
      select observation.observation_id, observation.mailbox_id, observation.message_id,
             observation.first_generation_id, observation.first_fact_id, observation.observed_at,
             event.event_id
      from mailbox_message_observations observation
      join mailbox_sync_generations generation
        on generation.generation_id = observation.first_generation_id
      left join mailbox_outbox event
        on event.aggregate_id = observation.observation_id
       and event.topic = 'mailbox.message.first_observed'
      where generation.scope_id = ? and observation.message_id = ?
    `).get(scopeId, messageId) as JsonRecord | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }

  claimGeneration(input: {
    generation_id: string;
    idempotency_key: string;
    request_fingerprint: string;
    scope_id: string;
    config_fingerprint: string;
    now: string;
  }): GenerationClaim {
    return this.transaction(() => {
      let row = this.generationByIdempotencyKey(input.idempotency_key);
      if (!row) {
        this.db.prepare(`
          insert into mailbox_sync_generations(
            generation_id, idempotency_key, request_fingerprint, scope_id,
            config_fingerprint, status, created_at, updated_at
          ) values (?, ?, ?, ?, ?, 'accepted', ?, ?)
        `).run(
          input.generation_id,
          input.idempotency_key,
          input.request_fingerprint,
          input.scope_id,
          input.config_fingerprint,
          input.now,
          input.now,
        );
        row = this.requireGeneration(input.generation_id);
      }
      if (row.generation_id !== input.generation_id
        || row.request_fingerprint !== input.request_fingerprint
        || row.scope_id !== input.scope_id
        || row.config_fingerprint !== input.config_fingerprint) {
        throw new Error(`mailbox_sync_idempotency_conflict:${input.idempotency_key}`);
      }
      if (row.status === 'completed' || row.status === 'failed') {
        return { generation: row, lease_token: null };
      }

      const active = this.db.prepare(`
        select generation_id, lease_token, expires_at
        from mailbox_sync_scope_leases where scope_id = ?
      `).get(input.scope_id) as JsonRecord | undefined;
      if (active && String(active.expires_at) > input.now) {
        throw new Error(`mailbox_sync_scope_busy:${input.scope_id}:${String(active.generation_id)}`);
      }
      if (active) {
        this.db.prepare('delete from mailbox_sync_scope_leases where scope_id = ?').run(input.scope_id);
      }

      const token = randomUUID();
      const expiresAt = new Date(Date.parse(input.now) + LEASE_MS).toISOString();
      this.db.prepare(`
        insert into mailbox_sync_scope_leases(scope_id, generation_id, lease_token, expires_at, updated_at)
        values (?, ?, ?, ?, ?)
      `).run(input.scope_id, row.generation_id, token, expiresAt, input.now);
      this.db.prepare(`
        update mailbox_sync_generations
        set lease_token = ?, lease_expires_at = ?, updated_at = ?
        where generation_id = ?
      `).run(token, expiresAt, input.now, row.generation_id);
      return { generation: this.requireGeneration(row.generation_id), lease_token: token };
    });
  }

  renewLease(scopeId: string, generationId: string, token: string, now: string): void {
    this.transaction(() => {
      const expiresAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
      const result = this.db.prepare(`
        update mailbox_sync_scope_leases set expires_at = ?, updated_at = ?
        where scope_id = ? and generation_id = ? and lease_token = ?
      `).run(expiresAt, now, scopeId, generationId, token);
      if (Number(result.changes) !== 1) throw new Error(`mailbox_sync_lease_lost:${scopeId}`);
      this.db.prepare(`
        update mailbox_sync_generations set lease_expires_at = ?, updated_at = ?
        where generation_id = ? and lease_token = ?
      `).run(expiresAt, now, generationId, token);
    });
  }

  assertLease(scopeId: string, generationId: string, token: string, now: string): void {
    const row = this.db.prepare(`
      select generation_id, lease_token, expires_at from mailbox_sync_scope_leases
      where scope_id = ?
    `).get(scopeId) as JsonRecord | undefined;
    if (!row
      || row.generation_id !== generationId
      || row.lease_token !== token
      || String(row.expires_at) <= now) {
      throw new Error(`mailbox_sync_lease_lost:${scopeId}`);
    }
  }

  releaseLease(scopeId: string, generationId: string, token: string, now: string): void {
    this.transaction(() => {
      this.db.prepare(`
        delete from mailbox_sync_scope_leases
        where scope_id = ? and generation_id = ? and lease_token = ?
      `).run(scopeId, generationId, token);
      this.db.prepare(`
        update mailbox_sync_generations
        set lease_token = null, lease_expires_at = null, updated_at = ?
        where generation_id = ? and lease_token = ?
      `).run(now, generationId, token);
    });
  }

  stageGeneration(input: {
    generation_id: string;
    lease_token: string;
    parent_cursor: string | null;
    next_cursor: string | null;
    batch_path: string;
    batch_sha256: string;
    records: StagedGenerationRecord[];
    now: string;
  }): void {
    this.transaction(() => {
      const generation = this.requireGeneration(input.generation_id);
      if (generation.status === 'staged') {
        if (generation.parent_cursor !== input.parent_cursor
          || generation.next_cursor !== input.next_cursor
          || generation.batch_path !== input.batch_path
          || generation.batch_sha256 !== input.batch_sha256
          || generation.batch_record_count !== input.records.length) {
          throw new Error(`mailbox_sync_staged_batch_conflict:${input.generation_id}`);
        }
        return;
      }
      if (generation.status !== 'accepted') {
        throw new Error(`mailbox_sync_generation_not_stageable:${generation.status}`);
      }
      const tokenRow = this.db.prepare('select lease_token from mailbox_sync_generations where generation_id = ?').get(input.generation_id) as JsonRecord | undefined;
      if (!tokenRow || tokenRow.lease_token !== input.lease_token) {
        throw new Error(`mailbox_sync_lease_lost:${generation.scope_id}`);
      }
      this.db.prepare(`
        update mailbox_sync_generations
        set status = 'staged', parent_cursor = ?, next_cursor = ?, batch_path = ?,
            batch_sha256 = ?, batch_record_count = ?, staged_at = ?, updated_at = ?
        where generation_id = ?
      `).run(
        input.parent_cursor,
        input.next_cursor,
        input.batch_path,
        input.batch_sha256,
        input.records.length,
        input.now,
        input.now,
        input.generation_id,
      );
      const insert = this.db.prepare(`
        insert into mailbox_sync_generation_records(
          generation_id, record_id, ordinal, fact_id, event_kind, message_id,
          mailbox_id, conversation_id, source_version, application_status
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged')
      `);
      for (const record of input.records) {
        insert.run(
          input.generation_id,
          record.record_id,
          record.ordinal,
          record.fact_id,
          record.event_kind,
          record.message_id,
          record.mailbox_id,
          record.conversation_id,
          record.source_version,
        );
      }
    });
  }

  markRecordApplication(
    generationId: string,
    recordId: string,
    status: GenerationRecordRow['application_status'],
  ): void {
    const result = this.db.prepare(`
      update mailbox_sync_generation_records set application_status = ?
      where generation_id = ? and record_id = ?
    `).run(status, generationId, recordId);
    if (Number(result.changes) !== 1) throw new Error(`mailbox_sync_record_unknown:${recordId}`);
  }

  reconcileApplicationAfterCursorCommit(generationId: string): void {
    this.db.prepare(`
      update mailbox_sync_generation_records set application_status = 'reconciled'
      where generation_id = ? and application_status = 'staged'
    `).run(generationId);
  }

  generationRecords(generationId: string): GenerationRecordRow[] {
    const rows = this.db.prepare(`
      select * from mailbox_sync_generation_records
      where generation_id = ? order by rowid asc
    `).all(generationId) as JsonRecord[];
    return rows.map((row) => ({
      generation_id: String(row.generation_id),
      record_id: String(row.record_id),
      ordinal: nullableString(row.ordinal),
      fact_id: String(row.fact_id),
      event_kind: String(row.event_kind),
      message_id: nullableString(row.message_id),
      mailbox_id: nullableString(row.mailbox_id),
      conversation_id: nullableString(row.conversation_id),
      source_version: nullableString(row.source_version),
      application_status: String(row.application_status) as GenerationRecordRow['application_status'],
    }));
  }

  finalizeGeneration(generationId: string, token: string, now: string): SyncGenerationRow {
    return this.transaction(() => {
      const generation = this.requireGeneration(generationId);
      if (generation.status === 'completed') return generation;
      if (generation.status !== 'staged') throw new Error(`mailbox_sync_generation_not_finalizable:${generation.status}`);
      const records = this.generationRecords(generationId);
      const incomplete = records.find((record) => record.application_status === 'staged');
      if (incomplete) throw new Error(`mailbox_sync_generation_incomplete:${incomplete.record_id}`);

      let firstObservationCount = 0;
      const observedRefs = new Map<string, JsonRecord>();
      let tombstoneCount = 0;
      for (const record of records) {
        if (record.application_status === 'not_applied') continue;
        if (record.event_kind === 'delete' || record.event_kind === 'deleted') {
          tombstoneCount += 1;
          continue;
        }
        if (!record.message_id || !record.mailbox_id) continue;
        const identity = `${record.mailbox_id}\u0000${record.message_id}`;
        observedRefs.set(identity, {
          mailbox_id: record.mailbox_id,
          message_id: record.message_id,
          fact_id: record.fact_id,
          ...(record.conversation_id ? { conversation_id: record.conversation_id } : {}),
        });
        const observationId = stableId('mobs_', identity);
        const inserted = this.db.prepare(`
          insert or ignore into mailbox_message_observations(
            observation_id, mailbox_id, message_id, first_generation_id,
            first_fact_id, observed_at
          ) values (?, ?, ?, ?, ?, ?)
        `).run(observationId, record.mailbox_id, record.message_id, generationId, record.fact_id, now);
        if (Number(inserted.changes) !== 1) continue;
        firstObservationCount += 1;
        const eventId = stableId('mbe_', `first-observed\u0000${identity}`);
        const payload = {
          schema: 'narada.mailbox.message_first_observed.v1',
          generation_id: generationId,
          observation_id: observationId,
          mailbox_id: record.mailbox_id,
          message_id: record.message_id,
          fact_id: record.fact_id,
          ...(record.conversation_id ? { conversation_id: record.conversation_id } : {}),
        };
        this.db.prepare(`
          insert into mailbox_outbox(
            event_id, scope_id, topic, aggregate_id, aggregate_revision, schema_version,
            causation_id, idempotency_key, partition_key, occurred_at, payload_json
          ) values (?, ?, 'mailbox.message.first_observed', ?, 1, 1, ?, ?, ?, ?, ?)
        `).run(
          eventId,
          generation.scope_id,
          observationId,
          generationId,
          eventId,
          observationId,
          now,
          JSON.stringify(payload),
        );
      }

      const observed = [...observedRefs.values()];
      const receipt: JsonRecord = {
        schema: 'narada.mailbox.sync_generation_receipt.v1',
        generation_id: generationId,
        scope_id: generation.scope_id,
        status: firstObservationCount > 0 ? 'synced' : 'no_change',
        config_fingerprint: generation.config_fingerprint,
        parent_cursor_sha256: nullableHash(generation.parent_cursor),
        next_cursor_sha256: nullableHash(generation.next_cursor),
        record_count: records.length,
        observed_message_count: observed.length,
        first_observation_count: firstObservationCount,
        tombstone_count: tombstoneCount,
        observed_message_refs: observed.slice(0, 100),
        observed_message_refs_truncated: observed.length > 100,
        completed_at: now,
      };
      const result = this.db.prepare(`
        update mailbox_sync_generations
        set status = 'completed', receipt_json = ?, error_message = null,
            completed_at = ?, updated_at = ?, lease_token = null, lease_expires_at = null
        where generation_id = ? and lease_token = ?
      `).run(JSON.stringify(receipt), now, now, generationId, token);
      if (Number(result.changes) !== 1) throw new Error(`mailbox_sync_lease_lost:${generation.scope_id}`);
      this.db.prepare(`
        delete from mailbox_sync_scope_leases
        where scope_id = ? and generation_id = ? and lease_token = ?
      `).run(generation.scope_id, generationId, token);
      return this.requireGeneration(generationId);
    });
  }

  failGeneration(generationId: string, token: string, message: string, now: string): SyncGenerationRow {
    return this.transaction(() => {
      const generation = this.requireGeneration(generationId);
      const result = this.db.prepare(`
        update mailbox_sync_generations
        set status = 'failed', error_message = ?, completed_at = ?, updated_at = ?,
            lease_token = null, lease_expires_at = null
        where generation_id = ? and lease_token = ?
      `).run(message.slice(0, 2048), now, now, generationId, token);
      if (Number(result.changes) !== 1) throw new Error(`mailbox_sync_lease_lost:${generation.scope_id}`);
      this.db.prepare(`
        delete from mailbox_sync_scope_leases
        where scope_id = ? and generation_id = ? and lease_token = ?
      `).run(generation.scope_id, generationId, token);
      return this.requireGeneration(generationId);
    });
  }

  requireGeneration(generationId: string): SyncGenerationRow {
    const row = this.db.prepare('select * from mailbox_sync_generations where generation_id = ?').get(generationId) as JsonRecord | undefined;
    if (!row) throw new Error(`mailbox_sync_generation_not_found:${generationId}`);
    return hydrateGeneration(row);
  }

  generationByIdempotencyKey(key: string): SyncGenerationRow | null {
    const row = this.db.prepare('select * from mailbox_sync_generations where idempotency_key = ?').get(key) as JsonRecord | undefined;
    return row ? hydrateGeneration(row) : null;
  }

  observedMessageKeys(scopeId: string): Set<string> {
    const rows = this.db.prepare(`
      select mailbox_id, message_id
      from mailbox_message_observations
      where mailbox_id = ?
    `).all(scopeId) as JsonRecord[];
    return new Set(rows.map((row) => `${String(row.mailbox_id)}\u0000${String(row.message_id)}`));
  }

  reconcileFirstObservations(input: {
    operation_id: string;
    idempotency_key: string;
    request_fingerprint: string;
    scope_id: string;
    generation_id: string;
    candidates: FirstObservationCandidate[];
    remaining_unobserved: number;
    has_more: boolean;
    now: string;
  }): { result: JsonRecord; replayed: boolean } {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        select request_fingerprint, result_json
        from mailbox_reconciliation_operations
        where idempotency_key = ?
      `).get(input.idempotency_key) as JsonRecord | undefined;
      if (existing) {
        if (existing.request_fingerprint !== input.request_fingerprint) {
          throw new Error(`mailbox_reconciliation_idempotency_conflict:${input.idempotency_key}`);
        }
        return { result: parseRecord(existing.result_json), replayed: true };
      }

      const generation = this.requireGeneration(input.generation_id);
      if (generation.scope_id !== input.scope_id) {
        throw new Error(`mailbox_reconciliation_scope_mismatch:${input.scope_id}:${generation.scope_id}`);
      }
      if (generation.status !== 'completed') {
        throw new Error(`mailbox_reconciliation_generation_not_completed:${generation.status}`);
      }

      let observationsRecorded = 0;
      let eventsPublished = 0;
      let skippedExisting = 0;
      for (const candidate of input.candidates) {
        const identity = `${candidate.mailbox_id}\u0000${candidate.message_id}`;
        const observationId = stableId('mobs_', identity);
        const observation = this.db.prepare(`
          insert or ignore into mailbox_message_observations(
            observation_id, mailbox_id, message_id, first_generation_id,
            first_fact_id, observed_at
          ) values (?, ?, ?, ?, ?, ?)
        `).run(
          observationId,
          candidate.mailbox_id,
          candidate.message_id,
          input.generation_id,
          candidate.fact_id,
          input.now,
        );
        if (Number(observation.changes) === 1) observationsRecorded += 1;
        else skippedExisting += 1;

        const eventId = stableId('mbe_', `first-observed\u0000${identity}`);
        const payload = {
          schema: 'narada.mailbox.message_first_observed.v1',
          generation_id: input.generation_id,
          observation_id: observationId,
          mailbox_id: candidate.mailbox_id,
          message_id: candidate.message_id,
          fact_id: candidate.fact_id,
          ...(candidate.conversation_id ? { conversation_id: candidate.conversation_id } : {}),
        };
        const event = this.db.prepare(`
          insert or ignore into mailbox_outbox(
            event_id, scope_id, topic, aggregate_id, aggregate_revision, schema_version,
            causation_id, idempotency_key, partition_key, occurred_at, payload_json
          ) values (?, ?, 'mailbox.message.first_observed', ?, 1, 1, ?, ?, ?, ?, ?)
        `).run(
          eventId,
          input.scope_id,
          observationId,
          input.generation_id,
          eventId,
          observationId,
          input.now,
          JSON.stringify(payload),
        );
        if (Number(event.changes) === 1) eventsPublished += 1;
      }

      const result: JsonRecord = {
        schema: 'narada.mailbox.reconcile_first_observations_receipt.v1',
        operation_id: input.operation_id,
        scope_id: input.scope_id,
        generation_id: input.generation_id,
        candidates_scanned: input.candidates.length,
        observations_recorded: observationsRecorded,
        events_published: eventsPublished,
        skipped_existing: skippedExisting,
        remaining_unobserved: input.remaining_unobserved,
        has_more: input.has_more,
        status: 'completed',
      };
      this.db.prepare(`
        insert into mailbox_reconciliation_operations(
          operation_id, idempotency_key, request_fingerprint, scope_id,
          generation_id, result_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.operation_id,
        input.idempotency_key,
        input.request_fingerprint,
        input.scope_id,
        input.generation_id,
        JSON.stringify(result),
        input.now,
      );
      return { result, replayed: false };
    });
  }

  recordAdmission(input: {
    admission_id: string;
    idempotency_key: string;
    request_fingerprint: string;
    scope_id: string;
    fact_id: string;
    policy_version: string;
    decision: JsonRecord;
    event_topic: 'mailbox.message.admitted' | 'mailbox.message.rejected';
    event_payload: JsonRecord;
    source_event_id: string;
    now: string;
  }): { decision: JsonRecord; replayed: boolean } {
    return this.transaction(() => {
      const existing = this.db.prepare(`
        select scope_id, fact_id, decision_json from mailbox_admission_receipts
        where idempotency_key = ?
      `).get(input.idempotency_key) as JsonRecord | undefined;
      if (existing) {
        if (existing.scope_id !== input.scope_id || existing.fact_id !== input.fact_id) {
          throw new Error(`mailbox_admission_idempotency_conflict:${input.idempotency_key}`);
        }
        return { decision: parseRecord(existing.decision_json), replayed: true };
      }
      const canonical = this.db.prepare(`
        select decision_json from mailbox_admission_receipts
        where scope_id = ? and fact_id = ?
      `).get(input.scope_id, input.fact_id) as JsonRecord | undefined;
      if (canonical) return { decision: parseRecord(canonical.decision_json), replayed: true };
      this.db.prepare(`
        insert into mailbox_admission_receipts(
          admission_id, idempotency_key, request_fingerprint, scope_id, fact_id,
          policy_version, decision_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.admission_id,
        input.idempotency_key,
        input.request_fingerprint,
        input.scope_id,
        input.fact_id,
        input.policy_version,
        JSON.stringify(input.decision),
        input.now,
      );
      const eventId = stableId('mbe_', `admission\u0000${input.scope_id}\u0000${input.fact_id}`);
      this.db.prepare(`
        insert into mailbox_outbox(
          event_id, scope_id, topic, aggregate_id, aggregate_revision, schema_version,
          causation_id, idempotency_key, partition_key, occurred_at, payload_json
        ) values (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        input.scope_id,
        input.event_topic,
        input.admission_id,
        input.source_event_id,
        eventId,
        input.admission_id,
        input.now,
        JSON.stringify(input.event_payload),
      );
      return { decision: input.decision, replayed: false };
    });
  }

  admissionByFact(scopeId: string, factId: string): JsonRecord | null {
    const row = this.db.prepare(`
      select decision_json from mailbox_admission_receipts where scope_id = ? and fact_id = ?
    `).get(scopeId, factId) as JsonRecord | undefined;
    return row ? parseRecord(row.decision_json) : null;
  }

  requireFirstObservedEvent(eventId: string, scopeId: string, factId: string): JsonRecord {
    const row = this.db.prepare(`
      select scope_id, topic, payload_json from mailbox_outbox where event_id = ?
    `).get(eventId) as JsonRecord | undefined;
    if (!row) throw new Error(`mailbox_admission_source_event_not_found:${eventId}`);
    const payload = parseRecord(row.payload_json);
    if (row.topic !== 'mailbox.message.first_observed'
      || row.scope_id !== scopeId
      || payload.fact_id !== factId
      || payload.mailbox_id !== scopeId) {
      throw new Error(`mailbox_admission_source_event_mismatch:${eventId}`);
    }
    return payload;
  }

  registerOutboxConsumer(consumerId: string, scopeId: string, topics: string[], startAt: string, now: string): JsonRecord {
    const topicsJson = canonicalJson(topics);
    return this.transaction(() => {
      const existing = this.db.prepare('select * from mailbox_outbox_consumers where consumer_id = ?').get(consumerId) as JsonRecord | undefined;
      if (existing) {
        if (existing.scope_id === null && existing.topics_json === null) {
          this.db.prepare(`
            update mailbox_outbox_consumers set scope_id = ?, topics_json = ? where consumer_id = ?
          `).run(scopeId, topicsJson, consumerId);
          return this.db.prepare('select * from mailbox_outbox_consumers where consumer_id = ?').get(consumerId) as JsonRecord;
        }
        if (existing.start_at !== startAt || existing.scope_id !== scopeId || existing.topics_json !== topicsJson) {
          throw new Error(`mailbox_outbox_consumer_conflict:${consumerId}`);
        }
        return existing;
      }
      this.db.prepare(`
        insert into mailbox_outbox_consumers(consumer_id, scope_id, topics_json, start_at, created_at)
        values (?, ?, ?, ?, ?)
      `).run(consumerId, scopeId, topicsJson, startAt, now);
      return this.db.prepare('select * from mailbox_outbox_consumers where consumer_id = ?').get(consumerId) as JsonRecord;
    });
  }

  outboxConsumer(consumerId: string): JsonRecord | null {
    const row = this.db.prepare(`
      select consumer_id, scope_id, topics_json, start_at, created_at
      from mailbox_outbox_consumers where consumer_id = ?
    `).get(consumerId) as JsonRecord | undefined;
    if (!row) return null;
    const topics = typeof row.topics_json === 'string' ? JSON.parse(row.topics_json) as unknown : null;
    if (!Array.isArray(topics) || topics.some((topic) => typeof topic !== 'string')) {
      throw new Error(`mailbox_outbox_consumer_topics_invalid:${consumerId}`);
    }
    return {
      consumer_id: String(row.consumer_id),
      scope_id: row.scope_id === null ? null : String(row.scope_id),
      topics,
      start_at: String(row.start_at),
      created_at: String(row.created_at),
    };
  }

  listOutbox(consumerId: string, limit: number): OutboxPage {
    const consumer = this.db.prepare('select scope_id, topics_json, start_at from mailbox_outbox_consumers where consumer_id = ?').get(consumerId) as JsonRecord | undefined;
    if (!consumer) throw new Error(`mailbox_outbox_consumer_not_registered:${consumerId}`);
    if (typeof consumer.scope_id !== 'string' || typeof consumer.topics_json !== 'string') {
      throw new Error(`mailbox_outbox_consumer_v2_registration_required:${consumerId}`);
    }
    const topics = JSON.parse(consumer.topics_json) as unknown;
    if (!Array.isArray(topics) || topics.length === 0 || topics.some((topic) => typeof topic !== 'string')) {
      throw new Error(`mailbox_outbox_consumer_topics_invalid:${consumerId}`);
    }
    const placeholders = topics.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      select event_id, scope_id, topic, aggregate_id, aggregate_revision, schema_version,
             causation_id, idempotency_key, partition_key, occurred_at, payload_json
      from mailbox_outbox event
      where event.occurred_at >= ?
        and event.scope_id = ?
        and event.topic in (${placeholders})
        and not exists (
          select 1 from mailbox_outbox_receipts receipt
          where receipt.consumer_id = ? and receipt.event_id = event.event_id
        )
      order by event.occurred_at asc, event.event_id asc limit ?
    `).all(String(consumer.start_at), String(consumer.scope_id), ...topics, consumerId, limit + 1) as JsonRecord[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      schema: 'narada.mailbox.outbox_event.v1',
      event_id: String(row.event_id),
      scope_id: String(row.scope_id),
      topic: String(row.topic),
      aggregate_id: String(row.aggregate_id),
      aggregate_revision: Number(row.aggregate_revision),
      schema_version: Number(row.schema_version),
      causation_id: String(row.causation_id),
      idempotency_key: String(row.idempotency_key),
      partition_key: String(row.partition_key),
      occurred_at: String(row.occurred_at),
      payload: parseRecord(row.payload_json),
    }));
    return { items, has_more: hasMore };
  }

  ackOutbox(consumerId: string, eventId: string, receipt: JsonRecord, now: string): JsonRecord {
    return this.transaction(() => {
      const consumer = this.db.prepare('select scope_id, topics_json from mailbox_outbox_consumers where consumer_id = ?').get(consumerId) as JsonRecord | undefined;
      if (!consumer) throw new Error(`mailbox_outbox_consumer_not_registered:${consumerId}`);
      if (typeof consumer.scope_id !== 'string' || typeof consumer.topics_json !== 'string') {
        throw new Error(`mailbox_outbox_consumer_v2_registration_required:${consumerId}`);
      }
      const topics = JSON.parse(consumer.topics_json) as unknown;
      const event = this.db.prepare('select event_id, scope_id, topic from mailbox_outbox where event_id = ?').get(eventId) as JsonRecord | undefined;
      if (!event) throw new Error(`mailbox_outbox_event_not_found:${eventId}`);
      if (event.scope_id !== consumer.scope_id || !Array.isArray(topics) || !topics.includes(event.topic)) {
        throw new Error(`mailbox_outbox_event_not_subscribed:${consumerId}:${eventId}`);
      }
      const fingerprint = sha256(canonicalJson(receipt));
      const existing = this.db.prepare(`
        select receipt_fingerprint, receipt_json from mailbox_outbox_receipts
        where consumer_id = ? and event_id = ?
      `).get(consumerId, eventId) as JsonRecord | undefined;
      if (existing) {
        if (existing.receipt_fingerprint !== fingerprint) throw new Error(`mailbox_outbox_ack_conflict:${consumerId}:${eventId}`);
        return { consumer_id: consumerId, event_id: eventId, replayed: true, receipt: parseRecord(existing.receipt_json) };
      }
      this.db.prepare(`
        insert into mailbox_outbox_receipts(
          consumer_id, event_id, receipt_fingerprint, receipt_json, acknowledged_at
        ) values (?, ?, ?, ?, ?)
      `).run(consumerId, eventId, fingerprint, JSON.stringify(receipt), now);
      return { consumer_id: consumerId, event_id: eventId, replayed: false, receipt };
    });
  }

  private initSchema(): void {
    this.db.exec(`
      create table if not exists mailbox_sync_generations(
        generation_id text primary key,
        idempotency_key text not null unique,
        request_fingerprint text not null,
        scope_id text not null,
        config_fingerprint text not null,
        status text not null check(status in ('accepted','staged','completed','failed')),
        parent_cursor text,
        next_cursor text,
        batch_path text,
        batch_sha256 text,
        batch_record_count integer not null default 0,
        staged_at text,
        receipt_json text,
        error_message text,
        lease_token text,
        lease_expires_at text,
        created_at text not null,
        updated_at text not null,
        completed_at text
      );
      create table if not exists mailbox_sync_generation_records(
        generation_id text not null references mailbox_sync_generations(generation_id),
        record_id text not null,
        ordinal text,
        fact_id text not null,
        event_kind text not null,
        message_id text,
        mailbox_id text,
        conversation_id text,
        source_version text,
        application_status text not null check(application_status in ('staged','already_applied','projected','not_applied','reconciled')),
        primary key(generation_id, record_id)
      );
      create table if not exists mailbox_sync_scope_leases(
        scope_id text primary key,
        generation_id text not null references mailbox_sync_generations(generation_id),
        lease_token text not null,
        expires_at text not null,
        updated_at text not null
      );
      create table if not exists mailbox_message_observations(
        observation_id text primary key,
        mailbox_id text not null,
        message_id text not null,
        first_generation_id text not null references mailbox_sync_generations(generation_id),
        first_fact_id text not null,
        observed_at text not null,
        unique(mailbox_id, message_id)
      );
      create table if not exists mailbox_outbox(
        event_id text primary key,
        scope_id text not null,
        topic text not null,
        aggregate_id text not null,
        aggregate_revision integer not null,
        schema_version integer not null,
        causation_id text not null,
        idempotency_key text not null unique,
        partition_key text not null,
        occurred_at text not null,
        payload_json text not null
      );
      create table if not exists mailbox_outbox_consumers(
        consumer_id text primary key,
        scope_id text,
        topics_json text,
        start_at text not null,
        created_at text not null
      );
      create table if not exists mailbox_outbox_receipts(
        consumer_id text not null references mailbox_outbox_consumers(consumer_id),
        event_id text not null references mailbox_outbox(event_id),
        receipt_fingerprint text not null,
        receipt_json text not null,
        acknowledged_at text not null,
        primary key(consumer_id, event_id)
      );
      create table if not exists mailbox_admission_receipts(
        admission_id text primary key,
        idempotency_key text not null unique,
        request_fingerprint text not null,
        scope_id text not null,
        fact_id text not null,
        policy_version text not null,
        decision_json text not null,
        created_at text not null
      );
      create table if not exists mailbox_reconciliation_operations(
        operation_id text primary key,
        idempotency_key text not null unique,
        request_fingerprint text not null,
        scope_id text not null,
        generation_id text not null references mailbox_sync_generations(generation_id),
        result_json text not null,
        created_at text not null
      );
      create index if not exists mailbox_outbox_order_idx on mailbox_outbox(occurred_at, event_id);
      create index if not exists mailbox_generation_scope_idx on mailbox_sync_generations(scope_id, created_at);
    `);
    this.migrateSchemaV2();
  }

  private migrateSchemaV2(): void {
    this.transaction(() => {
      const outboxColumns = this.tableColumns('mailbox_outbox');
      if (!outboxColumns.has('scope_id')) this.db.exec('alter table mailbox_outbox add column scope_id text;');
      this.db.exec(`
        update mailbox_outbox
        set scope_id = coalesce(json_extract(payload_json, '$.mailbox_id'), json_extract(payload_json, '$.scope_id'))
        where scope_id is null
      `);
      const missingScope = this.db.prepare('select event_id from mailbox_outbox where scope_id is null limit 1').get() as JsonRecord | undefined;
      if (missingScope) throw new Error(`mailbox_outbox_scope_migration_failed:${String(missingScope.event_id)}`);

      const consumerColumns = this.tableColumns('mailbox_outbox_consumers');
      if (!consumerColumns.has('scope_id')) this.db.exec('alter table mailbox_outbox_consumers add column scope_id text;');
      if (!consumerColumns.has('topics_json')) this.db.exec('alter table mailbox_outbox_consumers add column topics_json text;');

      const duplicates = this.db.prepare(`
        select scope_id, fact_id from mailbox_admission_receipts
        group by scope_id, fact_id having count(*) > 1
      `).all() as JsonRecord[];
      for (const duplicate of duplicates) {
        const rows = this.db.prepare(`
          select rowid, decision_json from mailbox_admission_receipts
          where scope_id = ? and fact_id = ? order by rowid
        `).all(String(duplicate.scope_id), String(duplicate.fact_id)) as JsonRecord[];
        if (rows.some((row) => row.decision_json !== rows[0]?.decision_json)) {
          throw new Error(`mailbox_admission_migration_divergent_duplicate:${String(duplicate.scope_id)}:${String(duplicate.fact_id)}`);
        }
        for (const row of rows.slice(1)) this.db.prepare('delete from mailbox_admission_receipts where rowid = ?').run(Number(row.rowid));
      }
      this.db.exec(`
        create unique index if not exists mailbox_admission_scope_fact_idx
        on mailbox_admission_receipts(scope_id, fact_id);
        create index if not exists mailbox_outbox_subscription_idx
        on mailbox_outbox(scope_id, topic, occurred_at, event_id);
        pragma user_version = 2;
      `);
    });
  }

  private tableColumns(table: string): Set<string> {
    return new Set((this.db.prepare(`pragma table_info(${table})`).all() as JsonRecord[]).map((row) => String(row.name)));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try {
      const result = fn();
      this.db.exec('commit');
      return result;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }
}

function hydrateGeneration(row: JsonRecord): SyncGenerationRow {
  return {
    generation_id: String(row.generation_id),
    idempotency_key: String(row.idempotency_key),
    request_fingerprint: String(row.request_fingerprint),
    scope_id: String(row.scope_id),
    config_fingerprint: String(row.config_fingerprint),
    status: String(row.status) as SyncGenerationStatus,
    parent_cursor: nullableString(row.parent_cursor),
    next_cursor: nullableString(row.next_cursor),
    batch_path: nullableString(row.batch_path),
    batch_sha256: nullableString(row.batch_sha256),
    batch_record_count: Number(row.batch_record_count),
    receipt: row.receipt_json == null ? null : parseRecord(row.receipt_json),
    error_message: nullableString(row.error_message),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: nullableString(row.completed_at),
  };
}

function parseRecord(value: unknown): JsonRecord {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('mailbox_domain_record_invalid');
  return parsed as JsonRecord;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableHash(value: string | null): string | null {
  return value === null ? null : sha256(value);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}${sha256(value).slice(0, 40)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as JsonRecord;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}
