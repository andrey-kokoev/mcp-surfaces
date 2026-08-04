import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from '@narada-core/sqlite';

export type JsonRecord = Record<string, unknown>;

export interface TicketDraftOperationRow {
  operation_key: string;
  action_idempotency_key: string;
  request_digest: string;
  draft_request_digest: string;
  ticket_id: string;
  effect_claim_id: string;
  mailbox_id: string;
  source_message_id: string;
  reply_mode: 'reply' | 'reply_all';
  status: 'pending' | 'completed';
  draft_id: string | null;
  receipt_id: string | null;
  draft_ref: JsonRecord | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function hydrateDiscardIntent(row: JsonRecord): TicketDraftDiscardIntentRow {
  const status = String(row.status);
  if (status !== 'pending' && status !== 'verified' && status !== 'completed') {
    throw new Error('graph_ticket_draft_discard_intent_status_corrupt');
  }
  return {
    operation_key: String(row.operation_key),
    idempotency_key: String(row.idempotency_key),
    request_digest: String(row.request_digest),
    status,
    verified_etag: nullableString(row.verified_etag),
    verified_at: nullableString(row.verified_at),
    receipt: row.receipt_json === null ? null : parseRecord(row.receipt_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: nullableString(row.completed_at),
  };
}

export interface TicketDraftDiscardIntentRow {
  operation_key: string;
  idempotency_key: string;
  request_digest: string;
  status: 'pending' | 'verified' | 'completed';
  verified_etag: string | null;
  verified_at: string | null;
  receipt: JsonRecord | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface BeginTicketDraftOperationInput {
  operation_key: string;
  action_idempotency_key: string;
  request_digest: string;
  draft_request_digest: string;
  ticket_id: string;
  effect_claim_id: string;
  mailbox_id: string;
  source_message_id: string;
  reply_mode: 'reply' | 'reply_all';
  now: string;
}

export interface TicketDraftDispositionObservationRow {
  observation_id: string;
  operation_key: string;
  ticket_id: string;
  mailbox_id: string;
  draft_id: string;
  disposition: 'sent' | 'discarded';
  evidence_kind:
    | 'synchronized_graph_observation'
    | 'operator_confirmed_graph_discard'
    | 'operator_authorized_graph_absence_after_verified_discard';
  evidence_id: string;
  receipt: JsonRecord;
  observed_at: string;
}

export class TicketDraftOperationStore {
  readonly dbPath: string;
  readonly db: DatabaseSync;
  #transactionOpen = false;

  constructor(siteRoot: string) {
    this.dbPath = join(siteRoot, '.narada', 'runtime', 'graph-mail-domain', 'graph-mail-domain.db');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('pragma busy_timeout = 30000; pragma foreign_keys = on;');
    this.db.exec(`
      create table if not exists graph_ticket_draft_operations(
        operation_key text primary key,
        action_idempotency_key text not null unique,
        request_digest text not null,
        draft_request_digest text not null,
        ticket_id text not null,
        effect_claim_id text not null,
        mailbox_id text not null,
        source_message_id text not null,
        reply_mode text not null check(reply_mode in ('reply', 'reply_all')),
        status text not null check(status in ('pending', 'completed')),
        draft_id text,
        receipt_id text,
        draft_ref_json text,
        created_at text not null,
        updated_at text not null,
        completed_at text,
        check(
          (status = 'pending' and draft_id is null and receipt_id is null and draft_ref_json is null and completed_at is null)
          or
          (status = 'completed' and draft_id is not null and receipt_id is not null and draft_ref_json is not null and completed_at is not null)
        )
      ) strict;

      create table if not exists graph_ticket_draft_disposition_observations(
        observation_id text primary key,
        operation_key text not null unique references graph_ticket_draft_operations(operation_key),
        ticket_id text not null,
        mailbox_id text not null,
        draft_id text not null,
        disposition text not null check(disposition in ('sent', 'discarded')),
        evidence_kind text not null check(evidence_kind in (
          'synchronized_graph_observation',
          'operator_confirmed_graph_discard',
          'operator_authorized_graph_absence_after_verified_discard'
        )),
        evidence_id text not null unique,
        receipt_json text not null
          check(length(cast(receipt_json as blob)) <= 16384),
        observed_at text not null
      ) strict;

      create table if not exists graph_ticket_draft_disposition_receipts(
        observation_id text not null
          references graph_ticket_draft_disposition_observations(observation_id),
        consumer_id text not null,
        reconciliation_ref text not null,
        receipt_json text not null
          check(length(cast(receipt_json as blob)) <= 16384),
        acknowledged_at text not null,
        primary key(observation_id, consumer_id)
      ) strict;

      create table if not exists graph_ticket_draft_discard_intents(
        operation_key text primary key references graph_ticket_draft_operations(operation_key),
        idempotency_key text not null unique,
        request_digest text not null,
        status text not null check(status in ('pending', 'verified', 'completed')),
        verified_etag text,
        verified_at text,
        receipt_json text check(
          receipt_json is null or length(cast(receipt_json as blob)) <= 16384
        ),
        created_at text not null,
        updated_at text not null,
        completed_at text,
        check(
          (status = 'pending' and verified_etag is null and verified_at is null and receipt_json is null and completed_at is null)
          or
          (status = 'verified' and verified_etag is not null and verified_at is not null and receipt_json is null and completed_at is null)
          or
          (status = 'completed' and verified_etag is not null and verified_at is not null and receipt_json is not null and completed_at is not null)
        )
      ) strict;
    `);
    this.#migrateDispositionSchemaV1();
  }

  private requireDiscardIntent(operationKey: string): TicketDraftDiscardIntentRow {
    const row = this.db.prepare(`
      select * from graph_ticket_draft_discard_intents where operation_key = ?
    `).get(operationKey) as JsonRecord | undefined;
    if (!row) throw new Error(`graph_ticket_draft_discard_intent_not_found:${operationKey}`);
    return hydrateDiscardIntent(row);
  }

  #migrateDispositionSchemaV1(): void {
    const row = this.db.prepare(`
      select sql from sqlite_master
       where type = 'table' and name = 'graph_ticket_draft_disposition_observations'
    `).get() as JsonRecord | undefined;
    const sql = typeof row?.sql === 'string' ? row.sql : '';
    if (!/check\s*\(\s*disposition\s*=\s*'sent'\s*\)/i.test(sql)) return;
    this.db.exec('pragma foreign_keys = off;');
    try {
      this.db.exec(`
        begin immediate;
        alter table graph_ticket_draft_disposition_receipts
          rename to graph_ticket_draft_disposition_receipts_v1;
        alter table graph_ticket_draft_disposition_observations
          rename to graph_ticket_draft_disposition_observations_v1;
        create table graph_ticket_draft_disposition_observations(
          observation_id text primary key,
          operation_key text not null unique references graph_ticket_draft_operations(operation_key),
          ticket_id text not null,
          mailbox_id text not null,
          draft_id text not null,
          disposition text not null check(disposition in ('sent', 'discarded')),
          evidence_kind text not null check(evidence_kind in (
            'synchronized_graph_observation',
            'operator_confirmed_graph_discard',
            'operator_authorized_graph_absence_after_verified_discard'
          )),
          evidence_id text not null unique,
          receipt_json text not null check(length(cast(receipt_json as blob)) <= 16384),
          observed_at text not null
        ) strict;
        create table graph_ticket_draft_disposition_receipts(
          observation_id text not null references graph_ticket_draft_disposition_observations(observation_id),
          consumer_id text not null,
          reconciliation_ref text not null,
          receipt_json text not null check(length(cast(receipt_json as blob)) <= 16384),
          acknowledged_at text not null,
          primary key(observation_id, consumer_id)
        ) strict;
        insert into graph_ticket_draft_disposition_observations
          select * from graph_ticket_draft_disposition_observations_v1;
        insert into graph_ticket_draft_disposition_receipts
          select * from graph_ticket_draft_disposition_receipts_v1;
        drop table graph_ticket_draft_disposition_receipts_v1;
        drop table graph_ticket_draft_disposition_observations_v1;
        commit;
      `);
    } catch (error) {
      try { this.db.exec('rollback;'); } catch { /* no open transaction */ }
      throw error;
    } finally {
      this.db.exec('pragma foreign_keys = on;');
    }
  }

  beginDiscardIntent(input: {
    operation_key: string;
    idempotency_key: string;
    request_digest: string;
    now: string;
  }): { intent: TicketDraftDiscardIntentRow; created: boolean } {
    const result = this.db.prepare(`
      insert into graph_ticket_draft_discard_intents(
        operation_key, idempotency_key, request_digest, status,
        verified_etag, verified_at, receipt_json,
        created_at, updated_at, completed_at
      ) values (?, ?, ?, 'pending', null, null, null, ?, ?, null)
      on conflict(operation_key) do nothing
    `).run(
      input.operation_key,
      input.idempotency_key,
      input.request_digest,
      input.now,
      input.now,
    );
    const intent = this.requireDiscardIntent(input.operation_key);
    if (
      intent.idempotency_key !== input.idempotency_key
      || intent.request_digest !== input.request_digest
    ) throw new Error(`graph_ticket_draft_discard_idempotency_conflict:${input.operation_key}`);
    return { intent, created: Number(result.changes) === 1 };
  }

  verifyDiscardIntent(operationKey: string, etag: string, now: string): TicketDraftDiscardIntentRow {
    const normalizedEtag = etag.trim();
    if (!normalizedEtag) throw new Error('graph_ticket_draft_discard_etag_required');
    const current = this.requireDiscardIntent(operationKey);
    if (current.status === 'completed') return current;
    this.db.prepare(`
      update graph_ticket_draft_discard_intents
         set status = 'verified', verified_etag = ?, verified_at = ?, updated_at = ?
       where operation_key = ? and status in ('pending', 'verified')
    `).run(normalizedEtag, now, now, operationKey);
    return this.requireDiscardIntent(operationKey);
  }

  completeDiscardIntent(
    operationKey: string,
    observation: TicketDraftDispositionObservationRow,
    now: string,
  ): TicketDraftDiscardIntentRow {
    const receiptJson = canonicalJson(observation.receipt);
    if (Buffer.byteLength(receiptJson, 'utf8') > 16_384) {
      throw new Error('graph_ticket_draft_discard_receipt_too_large');
    }
    this.beginImmediate();
    try {
      const current = this.requireDiscardIntent(operationKey);
      if (current.status === 'completed') {
        if (canonicalJson(current.receipt) !== receiptJson) {
          throw new Error(`graph_ticket_draft_discard_completion_conflict:${operationKey}`);
        }
        this.commit();
        return current;
      }
      if (current.status !== 'verified') {
        throw new Error(`graph_ticket_draft_discard_not_verified:${operationKey}`);
      }
      this.recordDispositionObservation(observation);
      const result = this.db.prepare(`
        update graph_ticket_draft_discard_intents
           set status = 'completed', receipt_json = ?, updated_at = ?, completed_at = ?
         where operation_key = ? and status = 'verified'
      `).run(receiptJson, now, now, operationKey);
      if (Number(result.changes) !== 1) {
        throw new Error(`graph_ticket_draft_discard_completion_conflict:${operationKey}`);
      }
      const completed = this.requireDiscardIntent(operationKey);
      this.commit();
      return completed;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  beginImmediate(): void {
    if (this.#transactionOpen) throw new Error('graph_ticket_draft_transaction_already_open');
    this.db.exec('begin immediate;');
    this.#transactionOpen = true;
  }

  commit(): void {
    if (!this.#transactionOpen) throw new Error('graph_ticket_draft_transaction_not_open');
    this.db.exec('commit;');
    this.#transactionOpen = false;
  }

  rollback(): void {
    if (!this.#transactionOpen) return;
    this.db.exec('rollback;');
    this.#transactionOpen = false;
  }

  close(): void {
    try {
      this.rollback();
    } finally {
      this.db.close();
    }
  }

  find(operationKey: string): TicketDraftOperationRow | null {
    const row = this.db.prepare(
      'select * from graph_ticket_draft_operations where operation_key = ?',
    ).get(operationKey) as JsonRecord | undefined;
    return row ? hydrate(row) : null;
  }

  insertPending(input: BeginTicketDraftOperationInput): TicketDraftOperationRow {
    this.requireTransaction();
    this.db.prepare(`
      insert into graph_ticket_draft_operations(
        operation_key, action_idempotency_key, request_digest, draft_request_digest,
        ticket_id, effect_claim_id, mailbox_id, source_message_id, reply_mode,
        status, draft_id, receipt_id, draft_ref_json,
        created_at, updated_at, completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, null, null, ?, ?, null)
    `).run(
      input.operation_key,
      input.action_idempotency_key,
      input.request_digest,
      input.draft_request_digest,
      input.ticket_id,
      input.effect_claim_id,
      input.mailbox_id,
      input.source_message_id,
      input.reply_mode,
      input.now,
      input.now,
    );
    return this.require(input.operation_key);
  }

  complete(
    operationKey: string,
    input: { draft_id: string; receipt_id: string; draft_ref: JsonRecord; now: string },
  ): TicketDraftOperationRow {
    this.requireTransaction();
    const draftRefJson = canonicalJson(input.draft_ref);
    if (Buffer.byteLength(draftRefJson, 'utf8') > 16_384) {
      throw new Error('graph_ticket_draft_ref_too_large');
    }
    const result = this.db.prepare(`
      update graph_ticket_draft_operations
         set status = 'completed', draft_id = ?, receipt_id = ?, draft_ref_json = ?,
             updated_at = ?, completed_at = ?
       where operation_key = ? and status = 'pending'
    `).run(
      input.draft_id,
      input.receipt_id,
      draftRefJson,
      input.now,
      input.now,
      operationKey,
    );
    if (Number(result.changes) !== 1) {
      const existing = this.require(operationKey);
      if (
        existing.status !== 'completed'
        || existing.draft_id !== input.draft_id
        || existing.receipt_id !== input.receipt_id
        || canonicalJson(existing.draft_ref) !== draftRefJson
      ) throw new Error('graph_ticket_draft_completion_conflict');
      return existing;
    }
    return this.require(operationKey);
  }

  listDispositionScanCandidates(limit: number): TicketDraftOperationRow[] {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    return (this.db.prepare(`
      select operation.*
        from graph_ticket_draft_operations operation
       where operation.status = 'completed'
         and not exists (
           select 1
             from graph_ticket_draft_disposition_observations observation
            where observation.operation_key = operation.operation_key
         )
       order by operation.completed_at asc, operation.operation_key asc
       limit ?
    `).all(boundedLimit) as JsonRecord[]).map(hydrate);
  }

  recordDispositionObservation(input: TicketDraftDispositionObservationRow): {
    observation: TicketDraftDispositionObservationRow;
    recorded: boolean;
  } {
    const receiptJson = canonicalJson(input.receipt);
    if (Buffer.byteLength(receiptJson, 'utf8') > 16_384) {
      throw new Error('graph_ticket_draft_disposition_receipt_too_large');
    }
    const result = this.db.prepare(`
      insert into graph_ticket_draft_disposition_observations(
        observation_id, operation_key, ticket_id, mailbox_id, draft_id,
        disposition, evidence_kind, evidence_id, receipt_json, observed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(operation_key) do nothing
    `).run(
      input.observation_id,
      input.operation_key,
      input.ticket_id,
      input.mailbox_id,
      input.draft_id,
      input.disposition,
      input.evidence_kind,
      input.evidence_id,
      receiptJson,
      input.observed_at,
    );
    const observation = this.requireDispositionObservation(input.operation_key);
    if (
      observation.observation_id !== input.observation_id
      || canonicalJson(observation.receipt) !== receiptJson
    ) throw new Error(`graph_ticket_draft_disposition_observation_conflict:${input.operation_key}`);
    return { observation, recorded: Number(result.changes) === 1 };
  }

  listDispositionObservations(
    consumerId: string,
    limit: number,
  ): TicketDraftDispositionObservationRow[] {
    const consumer = consumerId.trim();
    if (!consumer) throw new Error('graph_ticket_draft_disposition_consumer_required');
    const boundedLimit = Math.min(5, Math.max(1, Math.trunc(limit)));
    return (this.db.prepare(`
      select observation.*
        from graph_ticket_draft_disposition_observations observation
       where not exists (
         select 1
           from graph_ticket_draft_disposition_receipts receipt
          where receipt.observation_id = observation.observation_id
            and receipt.consumer_id = ?
       )
       order by observation.observed_at asc, observation.observation_id asc
       limit ?
    `).all(consumer, boundedLimit) as JsonRecord[]).map(hydrateDispositionObservation);
  }

  acknowledgeDispositionObservation(input: {
    observation_id: string;
    consumer_id: string;
    reconciliation_ref: string;
    receipt: JsonRecord;
    acknowledged_at: string;
  }): { status: 'acknowledged' | 'already_acknowledged' } {
    const receiptJson = canonicalJson(input.receipt);
    if (Buffer.byteLength(receiptJson, 'utf8') > 16_384) {
      throw new Error('graph_ticket_draft_disposition_ack_receipt_too_large');
    }
    const result = this.db.prepare(`
      insert into graph_ticket_draft_disposition_receipts(
        observation_id, consumer_id, reconciliation_ref, receipt_json, acknowledged_at
      ) values (?, ?, ?, ?, ?)
      on conflict(observation_id, consumer_id) do nothing
    `).run(
      input.observation_id,
      input.consumer_id,
      input.reconciliation_ref,
      receiptJson,
      input.acknowledged_at,
    );
    const existing = this.db.prepare(`
      select reconciliation_ref, receipt_json
        from graph_ticket_draft_disposition_receipts
       where observation_id = ? and consumer_id = ?
    `).get(input.observation_id, input.consumer_id) as JsonRecord | undefined;
    if (
      !existing
      || String(existing.reconciliation_ref) !== input.reconciliation_ref
      || String(existing.receipt_json) !== receiptJson
    ) throw new Error(`graph_ticket_draft_disposition_ack_conflict:${input.observation_id}`);
    return { status: Number(result.changes) === 1 ? 'acknowledged' : 'already_acknowledged' };
  }

  private require(operationKey: string): TicketDraftOperationRow {
    const row = this.find(operationKey);
    if (!row) throw new Error(`graph_ticket_draft_operation_not_found:${operationKey}`);
    return row;
  }

  private requireDispositionObservation(operationKey: string): TicketDraftDispositionObservationRow {
    const row = this.db.prepare(`
      select * from graph_ticket_draft_disposition_observations where operation_key = ?
    `).get(operationKey) as JsonRecord | undefined;
    if (!row) throw new Error(`graph_ticket_draft_disposition_observation_not_found:${operationKey}`);
    return hydrateDispositionObservation(row);
  }

  private requireTransaction(): void {
    if (!this.#transactionOpen) throw new Error('graph_ticket_draft_transaction_not_open');
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function stableReceiptId(operationKey: string, draftId: string): string {
  return `graph_draft_receipt_${createHash('sha256')
    .update(`${operationKey}\u0000${draftId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export function stableDispositionObservationId(
  operationKey: string,
  disposition: 'sent' | 'discarded',
  observedMessageId: string,
): string {
  return `graph_draft_disposition_${createHash('sha256')
    .update(`${operationKey}\u0000${disposition}\u0000${observedMessageId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function hydrate(row: JsonRecord): TicketDraftOperationRow {
  const replyMode = String(row.reply_mode);
  const status = String(row.status);
  if (replyMode !== 'reply' && replyMode !== 'reply_all') {
    throw new Error('graph_ticket_draft_reply_mode_corrupt');
  }
  if (status !== 'pending' && status !== 'completed') {
    throw new Error('graph_ticket_draft_status_corrupt');
  }
  return {
    operation_key: String(row.operation_key),
    action_idempotency_key: String(row.action_idempotency_key),
    request_digest: String(row.request_digest),
    draft_request_digest: String(row.draft_request_digest),
    ticket_id: String(row.ticket_id),
    effect_claim_id: String(row.effect_claim_id),
    mailbox_id: String(row.mailbox_id),
    source_message_id: String(row.source_message_id),
    reply_mode: replyMode,
    status,
    draft_id: nullableString(row.draft_id),
    receipt_id: nullableString(row.receipt_id),
    draft_ref: row.draft_ref_json === null ? null : parseRecord(row.draft_ref_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: nullableString(row.completed_at),
  };
}

function hydrateDispositionObservation(row: JsonRecord): TicketDraftDispositionObservationRow {
  if (row.disposition !== 'sent' && row.disposition !== 'discarded') {
    throw new Error('graph_ticket_draft_disposition_corrupt');
  }
  if (
    row.evidence_kind !== 'synchronized_graph_observation'
    && row.evidence_kind !== 'operator_confirmed_graph_discard'
    && row.evidence_kind !== 'operator_authorized_graph_absence_after_verified_discard'
  ) {
    throw new Error('graph_ticket_draft_disposition_evidence_kind_corrupt');
  }
  return {
    observation_id: String(row.observation_id),
    operation_key: String(row.operation_key),
    ticket_id: String(row.ticket_id),
    mailbox_id: String(row.mailbox_id),
    draft_id: String(row.draft_id),
    disposition: row.disposition,
    evidence_kind: row.evidence_kind,
    evidence_id: String(row.evidence_id),
    receipt: parseRecord(row.receipt_json),
    observed_at: String(row.observed_at),
  };
}

function parseRecord(value: unknown): JsonRecord {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('graph_ticket_draft_ref_corrupt');
  }
  return parsed as JsonRecord;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
