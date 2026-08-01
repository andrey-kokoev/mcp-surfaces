import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    `);
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

  private require(operationKey: string): TicketDraftOperationRow {
    const row = this.find(operationKey);
    if (!row) throw new Error(`graph_ticket_draft_operation_not_found:${operationKey}`);
    return row;
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
