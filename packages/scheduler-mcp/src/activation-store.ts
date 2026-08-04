import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEDULER_ACTIVATION_SCHEMA_VERSION = 2 as const;
export const SCHEDULER_DATABASE_PATH = '.ai/scheduler.db' as const;

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, unknown>;

interface Statement {
  all(...values: SqlValue[]): unknown[];
  get(...values: SqlValue[]): unknown;
  run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SchedulerDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

export type SchedulerBindingStatus = 'active' | 'paused' | 'retired';
export type SchedulerTriggerKind = 'bootstrap' | 'completion' | 'domain_event';
export type SchedulerConcurrencyKind = 'singleton' | 'partitioned';
export type SchedulerActivationStatus =
  | 'pending'
  | 'leased'
  | 'admitted'
  | 'terminal'
  | 'blocked';

export interface SchedulerBindingInput {
  binding_id: string;
  trigger_kind: SchedulerTriggerKind;
  source_topic: string;
  source_sop_id?: string | null;
  terminal_outcomes?: string[];
  target_sop_id: string;
  target_template_version: string;
  concurrency: SchedulerConcurrencyKind;
  delay_by_outcome_ms?: Record<string, number>;
  default_delay_ms?: number;
  retry_base_ms?: number;
  retry_max_ms?: number;
  max_attempts?: number;
  blocked_policy?: 'manual_unblock';
  expected_revision?: number;
}

export interface SchedulerBindingRecord extends SchedulerBindingInput {
  status: SchedulerBindingStatus;
  revision: number;
  spec_digest: string;
  created_at: string;
  updated_at: string;
}

export interface SchedulerSourceEvent {
  event_id: string;
  topic: string;
  partition_key: string;
  aggregate_id: string;
  aggregate_revision: number;
  schema_version: number;
  causation_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export interface SchedulerActivation {
  activation_id: string;
  binding_id: string;
  source_event_id: string;
  occurrence_key: string;
  target_sop_id: string;
  target_template_version: string;
  partition_key: string;
  due_at: string;
  status: SchedulerActivationStatus;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  sop_run_id: string | null;
  terminal_outcome: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchedulerEventAdmission {
  status: 'admitted' | 'replayed';
  event_id: string;
  activation_count: number;
  activations: SchedulerActivation[];
}

const MAX_EVENT_BYTES = 16_384;
const MAX_ERROR_BYTES = 2_048;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 32)}`;
}

function requiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

function boundedJson(value: unknown, field: string, maxBytes: number): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error(`${field}_too_large`);
  return json;
}

function resolveDatabasePath(
  siteRoot: string,
  databasePath: string = SCHEDULER_DATABASE_PATH,
): string {
  return isAbsolute(databasePath)
    ? resolve(databasePath)
    : resolve(siteRoot, databasePath);
}

function configureConnection(db: SchedulerDatabase, mutateJournalMode: boolean): void {
  db.exec('pragma foreign_keys = on; pragma busy_timeout = 30000;');
  if (mutateJournalMode) db.exec('pragma journal_mode = wal;');
  const row = db.prepare('pragma journal_mode').get() as SqlRow | undefined;
  const value = row ? String(Object.values(row)[0] ?? '').toLowerCase() : '';
  if (value !== 'wal') throw new Error(`scheduler_activation_store_not_prepared:journal_mode_${value || 'unknown'}`);
  db.exec('pragma synchronous = normal;');
}

function initializeSchema(db: SchedulerDatabase): void {
  db.exec(`
    begin immediate;
    create table if not exists scheduler_meta (
      singleton integer primary key check (singleton = 1),
      schema_version integer not null,
      prepared_at text not null
    );

    create table if not exists scheduler_bindings (
      binding_id text primary key,
      trigger_kind text not null check (trigger_kind in ('bootstrap', 'completion', 'domain_event')),
      source_topic text not null,
      source_sop_id text,
      terminal_outcomes_json text not null,
      target_sop_id text not null,
      target_template_version text not null,
      concurrency text not null check (concurrency in ('singleton', 'partitioned')),
      delay_by_outcome_ms_json text not null,
      default_delay_ms integer not null check (default_delay_ms >= 0),
      retry_base_ms integer not null check (retry_base_ms >= 0),
      retry_max_ms integer not null check (retry_max_ms >= retry_base_ms),
      max_attempts integer not null check (max_attempts > 0),
      blocked_policy text not null check (blocked_policy = 'manual_unblock'),
      status text not null check (status in ('active', 'paused', 'retired')),
      revision integer not null check (revision > 0),
      spec_digest text not null,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists idx_scheduler_bindings_topic
      on scheduler_bindings(source_topic, status);

    create table if not exists scheduler_source_events (
      event_id text primary key,
      topic text not null,
      partition_key text not null,
      aggregate_id text not null,
      aggregate_revision integer not null,
      schema_version integer not null,
      causation_id text not null,
      idempotency_key text not null,
      payload_json text not null
        check (length(cast(payload_json as blob)) <= ${MAX_EVENT_BYTES}),
      event_digest text not null,
      occurred_at text not null,
      admitted_at text not null
    );

    create table if not exists scheduler_activations (
      activation_id text primary key,
      binding_id text not null references scheduler_bindings(binding_id),
      source_event_id text not null references scheduler_source_events(event_id),
      occurrence_key text not null,
      target_sop_id text not null,
      target_template_version text not null,
      partition_key text not null,
      due_at text not null,
      status text not null check (status in ('pending', 'leased', 'admitted', 'terminal', 'blocked')),
      attempt_count integer not null default 0,
      lease_owner text,
      lease_token text,
      lease_expires_at text,
      sop_run_id text,
      terminal_outcome text,
      last_error text,
      created_at text not null,
      updated_at text not null,
      unique(binding_id, source_event_id),
      unique(target_sop_id, occurrence_key)
    );

    create index if not exists idx_scheduler_activations_due
      on scheduler_activations(status, due_at, binding_id, partition_key);

    create index if not exists idx_scheduler_activations_sop_run
      on scheduler_activations(sop_run_id);

    create table if not exists scheduler_activation_receipts (
      activation_id text not null references scheduler_activations(activation_id),
      receipt_kind text not null,
      receipt_id text not null,
      receipt_json text not null
        check (length(cast(receipt_json as blob)) <= ${MAX_EVENT_BYTES}),
      recorded_at text not null,
      primary key(activation_id, receipt_kind),
      unique(receipt_id)
    );

    commit;
  `);
  const columns = db.prepare('pragma table_info(scheduler_activations)').all() as SqlRow[];
  if (!columns.some((row) => String(row.name) === 'lease_token')) {
    db.exec(`
      begin immediate;
      alter table scheduler_activations add column lease_token text;
      update scheduler_activations
         set status = 'pending', lease_owner = null, lease_expires_at = null,
             attempt_count = attempt_count + 1,
             last_error = 'schema_upgrade_invalidated_lease'
       where status = 'leased';
      commit;
    `);
  }
  db.exec(`
    begin immediate;
    create unique index if not exists idx_scheduler_activations_sop_run_unique
      on scheduler_activations(sop_run_id) where sop_run_id is not null;
    insert into scheduler_meta(singleton, schema_version, prepared_at)
      values (1, ${SCHEDULER_ACTIVATION_SCHEMA_VERSION}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      on conflict(singleton) do update set
        schema_version = excluded.schema_version,
        prepared_at = excluded.prepared_at;
    commit;
  `);
}

export function prepareSchedulerActivationStore(
  siteRoot: string,
  databasePath?: string,
): { status: 'prepared'; db_path: string; schema_version: number } {
  const path = resolveDatabasePath(siteRoot, databasePath);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path) as unknown as SchedulerDatabase;
  try {
    configureConnection(db, true);
    initializeSchema(db);
    return {
      status: 'prepared',
      db_path: path,
      schema_version: SCHEDULER_ACTIVATION_SCHEMA_VERSION,
    };
  } finally {
    db.close();
  }
}

export function inspectSchedulerActivationStore(
  siteRoot: string,
  databasePath?: string,
): {
  status: 'prepared' | 'missing' | 'stale' | 'invalid';
  db_path: string;
  schema_version: number | null;
  reason?: string;
} {
  const path = resolveDatabasePath(siteRoot, databasePath);
  if (!existsSync(path)) {
    return { status: 'missing', db_path: path, schema_version: null, reason: 'database_missing' };
  }
  const db = new DatabaseSync(path) as unknown as SchedulerDatabase;
  try {
    configureConnection(db, false);
    const row = db.prepare(
      'select schema_version from scheduler_meta where singleton = 1',
    ).get() as SqlRow | undefined;
    const version = row ? Number(row.schema_version) : null;
    return version === SCHEDULER_ACTIVATION_SCHEMA_VERSION
      ? { status: 'prepared', db_path: path, schema_version: version }
      : {
        status: 'stale',
        db_path: path,
        schema_version: version,
        reason: `schema_version_${version ?? 'missing'}`,
      };
  } catch (error) {
    return {
      status: 'invalid',
      db_path: path,
      schema_version: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

export function openPreparedSchedulerActivationStore(
  siteRoot: string,
  options: { databasePath?: string; now?: () => Date } = {},
): SchedulerActivationStore {
  const inspection = inspectSchedulerActivationStore(siteRoot, options.databasePath);
  if (inspection.status !== 'prepared') {
    throw new Error(`scheduler_activation_store_not_prepared:${inspection.reason ?? inspection.status}`);
  }
  const db = new DatabaseSync(inspection.db_path) as unknown as SchedulerDatabase;
  try {
    configureConnection(db, false);
    return new SchedulerActivationStore(db, inspection.db_path, options.now);
  } catch (error) {
    db.close();
    throw error;
  }
}

function bindingFromRow(row: SqlRow): SchedulerBindingRecord {
  return {
    binding_id: String(row.binding_id),
    trigger_kind: String(row.trigger_kind) as SchedulerTriggerKind,
    source_topic: String(row.source_topic),
    source_sop_id: row.source_sop_id === null ? null : String(row.source_sop_id),
    terminal_outcomes: JSON.parse(String(row.terminal_outcomes_json)) as string[],
    target_sop_id: String(row.target_sop_id),
    target_template_version: String(row.target_template_version),
    concurrency: String(row.concurrency) as SchedulerConcurrencyKind,
    delay_by_outcome_ms: JSON.parse(String(row.delay_by_outcome_ms_json)) as Record<string, number>,
    default_delay_ms: Number(row.default_delay_ms),
    retry_base_ms: Number(row.retry_base_ms),
    retry_max_ms: Number(row.retry_max_ms),
    max_attempts: Number(row.max_attempts),
    blocked_policy: 'manual_unblock',
    status: String(row.status) as SchedulerBindingStatus,
    revision: Number(row.revision),
    spec_digest: String(row.spec_digest),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function activationFromRow(row: SqlRow): SchedulerActivation {
  return {
    activation_id: String(row.activation_id),
    binding_id: String(row.binding_id),
    source_event_id: String(row.source_event_id),
    occurrence_key: String(row.occurrence_key),
    target_sop_id: String(row.target_sop_id),
    target_template_version: String(row.target_template_version),
    partition_key: String(row.partition_key),
    due_at: String(row.due_at),
    status: String(row.status) as SchedulerActivationStatus,
    attempt_count: Number(row.attempt_count),
    lease_owner: row.lease_owner === null ? null : String(row.lease_owner),
    lease_token: row.lease_token === null ? null : String(row.lease_token),
    lease_expires_at: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    sop_run_id: row.sop_run_id === null ? null : String(row.sop_run_id),
    terminal_outcome: row.terminal_outcome === null ? null : String(row.terminal_outcome),
    last_error: row.last_error === null ? null : String(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function sourceEventFromRow(row: SqlRow): SchedulerSourceEvent {
  return {
    event_id: String(row.event_id),
    topic: String(row.topic),
    partition_key: String(row.partition_key),
    aggregate_id: String(row.aggregate_id),
    aggregate_revision: Number(row.aggregate_revision),
    schema_version: Number(row.schema_version),
    causation_id: String(row.causation_id),
    idempotency_key: String(row.idempotency_key),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    occurred_at: String(row.occurred_at),
  };
}

export class SchedulerActivationStore {
  readonly #db: SchedulerDatabase;
  readonly #now: () => Date;
  readonly databasePath: string;

  constructor(db: SchedulerDatabase, databasePath: string, now?: () => Date) {
    this.#db = db;
    this.databasePath = databasePath;
    this.#now = now ?? (() => new Date());
  }

  close(): void {
    this.#db.close();
  }

  upsertBinding(input: SchedulerBindingInput): SchedulerBindingRecord {
    const normalized = this.#normalizeBinding(input);
    const specDigest = digest(normalized.spec);
    const now = this.#now().toISOString();
    return this.#transaction(() => {
      const existing = this.#db.prepare(
        'select * from scheduler_bindings where binding_id = ?',
      ).get(normalized.spec.binding_id) as SqlRow | undefined;
      if (existing) {
        const current = bindingFromRow(existing);
        if (input.expected_revision === undefined) {
          if (current.spec_digest === specDigest) return current;
          throw new Error('scheduler_binding_expected_revision_required');
        }
        if (current.revision !== input.expected_revision) {
          throw new Error(
            `scheduler_binding_revision_conflict:expected_${input.expected_revision}:actual_${current.revision}`,
          );
        }
        this.#db.prepare(`
          update scheduler_bindings set
            trigger_kind = ?, source_topic = ?, source_sop_id = ?,
            terminal_outcomes_json = ?, target_sop_id = ?,
            target_template_version = ?, concurrency = ?,
            delay_by_outcome_ms_json = ?, default_delay_ms = ?,
            retry_base_ms = ?, retry_max_ms = ?, max_attempts = ?,
            blocked_policy = ?, revision = revision + 1,
            spec_digest = ?, updated_at = ?
          where binding_id = ?
        `).run(
          normalized.spec.trigger_kind,
          normalized.spec.source_topic,
          normalized.spec.source_sop_id ?? null,
          canonicalJson(normalized.spec.terminal_outcomes),
          normalized.spec.target_sop_id,
          normalized.spec.target_template_version,
          normalized.spec.concurrency,
          canonicalJson(normalized.spec.delay_by_outcome_ms),
          normalized.spec.default_delay_ms,
          normalized.spec.retry_base_ms,
          normalized.spec.retry_max_ms,
          normalized.spec.max_attempts,
          normalized.spec.blocked_policy,
          specDigest,
          now,
          normalized.spec.binding_id,
        );
      } else {
        if (input.expected_revision !== undefined) {
          throw new Error('scheduler_binding_not_found');
        }
        this.#db.prepare(`
          insert into scheduler_bindings(
            binding_id, trigger_kind, source_topic, source_sop_id,
            terminal_outcomes_json, target_sop_id, target_template_version,
            concurrency, delay_by_outcome_ms_json, default_delay_ms,
            retry_base_ms, retry_max_ms, max_attempts, blocked_policy,
            status, revision, spec_digest, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
        `).run(
          normalized.spec.binding_id,
          normalized.spec.trigger_kind,
          normalized.spec.source_topic,
          normalized.spec.source_sop_id ?? null,
          canonicalJson(normalized.spec.terminal_outcomes),
          normalized.spec.target_sop_id,
          normalized.spec.target_template_version,
          normalized.spec.concurrency,
          canonicalJson(normalized.spec.delay_by_outcome_ms),
          normalized.spec.default_delay_ms,
          normalized.spec.retry_base_ms,
          normalized.spec.retry_max_ms,
          normalized.spec.max_attempts,
          normalized.spec.blocked_policy,
          specDigest,
          now,
          now,
        );
      }
      return this.requireBinding(normalized.spec.binding_id);
    });
  }

  getBinding(bindingId: string): SchedulerBindingRecord | undefined {
    const row = this.#db.prepare(
      'select * from scheduler_bindings where binding_id = ?',
    ).get(bindingId) as SqlRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  requireBinding(bindingId: string): SchedulerBindingRecord {
    const binding = this.getBinding(bindingId);
    if (!binding) throw new Error(`scheduler_binding_not_found:${bindingId}`);
    return binding;
  }

  listBindings(status?: SchedulerBindingStatus): SchedulerBindingRecord[] {
    const rows = status
      ? this.#db.prepare(
        'select * from scheduler_bindings where status = ? order by binding_id',
      ).all(status) as SqlRow[]
      : this.#db.prepare(
        'select * from scheduler_bindings order by binding_id',
      ).all() as SqlRow[];
    return rows.map(bindingFromRow);
  }

  setBindingStatus(
    bindingId: string,
    status: SchedulerBindingStatus,
    expectedRevision: number,
  ): SchedulerBindingRecord {
    const now = this.#now().toISOString();
    return this.#transaction(() => {
      const binding = this.requireBinding(bindingId);
      if (binding.revision !== expectedRevision) {
        throw new Error(
          `scheduler_binding_revision_conflict:expected_${expectedRevision}:actual_${binding.revision}`,
        );
      }
      this.#db.prepare(`
        update scheduler_bindings
           set status = ?, revision = revision + 1, updated_at = ?
         where binding_id = ?
      `).run(status, now, bindingId);
      if (status === 'paused') {
        this.#db.prepare(`
          update scheduler_activations
             set status = 'terminal',
                 terminal_outcome = 'cancelled_binding_paused',
                 lease_owner = null,
                 lease_token = null,
                 lease_expires_at = null,
                 last_error = 'binding_paused_before_admission',
                 updated_at = ?
           where binding_id = ?
             and (
               status = 'pending'
               or (status = 'leased' and lease_expires_at <= ?)
             )
        `).run(now, bindingId, now);
      }
      return this.requireBinding(bindingId);
    });
  }

  admitEvent(input: SchedulerSourceEvent): SchedulerEventAdmission {
    const event = this.#normalizeEvent(input);
    const eventDigest = digest(event);
    const now = this.#now().toISOString();
    return this.#transaction(() => {
      const existing = this.#db.prepare(
        'select event_digest from scheduler_source_events where event_id = ?',
      ).get(event.event_id) as SqlRow | undefined;
      if (existing && String(existing.event_digest) !== eventDigest) {
        throw new Error(`scheduler_event_idempotency_conflict:${event.event_id}`);
      }
      if (!existing) {
        this.#db.prepare(`
          insert into scheduler_source_events(
            event_id, topic, partition_key, aggregate_id, aggregate_revision,
            schema_version, causation_id, idempotency_key, payload_json,
            event_digest, occurred_at, admitted_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          event.event_id,
          event.topic,
          event.partition_key,
          event.aggregate_id,
          event.aggregate_revision,
          event.schema_version,
          event.causation_id,
          event.idempotency_key,
          boundedJson(event.payload, 'scheduler_event_payload', MAX_EVENT_BYTES),
          eventDigest,
          event.occurred_at,
          now,
        );
      }

      const bindings = this.#db.prepare(`
        select * from scheduler_bindings
         where source_topic = ? and status = 'active'
         order by binding_id
      `).all(event.topic) as SqlRow[];
      for (const row of bindings) {
        const binding = bindingFromRow(row);
        if (!this.#bindingMatches(binding, event)) continue;
        const activationId = stableId('activation', {
          binding_id: binding.binding_id,
          source_event_id: event.event_id,
        });
        const existingActivation = this.getActivation(activationId);
        if (existingActivation) continue;
        const outcome = typeof event.payload.outcome === 'string'
          ? event.payload.outcome
          : 'default';
        const delay = this.#delayFor(binding, outcome, event.payload);
        const dueAt = new Date(new Date(event.occurred_at).getTime() + delay).toISOString();
        const blocked = outcome === 'blocked' && binding.blocked_policy === 'manual_unblock';
        const partitionKey = binding.concurrency === 'singleton'
          ? binding.binding_id
          : requiredString(event.partition_key, 'scheduler_event_partition_key');
        this.#db.prepare(`
          insert into scheduler_activations(
            activation_id, binding_id, source_event_id, occurrence_key,
            target_sop_id, target_template_version, partition_key, due_at,
            status, attempt_count, lease_owner, lease_expires_at, sop_run_id,
            terminal_outcome, last_error, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, null, null, null, null, ?, ?, ?)
        `).run(
          activationId,
          binding.binding_id,
          event.event_id,
          `${binding.binding_id}:${event.event_id}`,
          binding.target_sop_id,
          binding.target_template_version,
          partitionKey,
          dueAt,
          blocked ? 'blocked' : 'pending',
          blocked ? 'blocked_outcome_requires_explicit_unblock' : null,
          now,
          now,
        );
      }
      const activations = this.listActivations({ sourceEventId: event.event_id });
      return {
        status: existing ? 'replayed' : 'admitted',
        event_id: event.event_id,
        activation_count: activations.length,
        activations,
      };
    });
  }

  getActivation(activationId: string): SchedulerActivation | undefined {
    const row = this.#db.prepare(
      'select * from scheduler_activations where activation_id = ?',
    ).get(activationId) as SqlRow | undefined;
    return row ? activationFromRow(row) : undefined;
  }

  getSourceEvent(eventId: string): SchedulerSourceEvent | undefined {
    const row = this.#db.prepare(
      'select * from scheduler_source_events where event_id = ?',
    ).get(eventId) as SqlRow | undefined;
    return row ? sourceEventFromRow(row) : undefined;
  }

  requireSourceEvent(eventId: string): SchedulerSourceEvent {
    const event = this.getSourceEvent(requiredString(eventId, 'event_id'));
    if (!event) throw new Error(`scheduler_source_event_not_found:${eventId}`);
    return event;
  }

  listActivations(options: {
    status?: SchedulerActivationStatus;
    bindingId?: string;
    sourceEventId?: string;
    sopRunId?: string;
    limit?: number;
  } = {}): SchedulerActivation[] {
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (options.status) {
      clauses.push('status = ?');
      values.push(options.status);
    }
    if (options.bindingId) {
      clauses.push('binding_id = ?');
      values.push(options.bindingId);
    }
    if (options.sourceEventId) {
      clauses.push('source_event_id = ?');
      values.push(options.sourceEventId);
    }
    if (options.sopRunId) {
      clauses.push('sop_run_id = ?');
      values.push(options.sopRunId);
    }
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    values.push(limit);
    const rows = this.#db.prepare(`
      select * from scheduler_activations
      ${clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''}
      order by due_at, activation_id
      limit ?
    `).all(...values) as SqlRow[];
    return rows.map(activationFromRow);
  }

  claimDue(consumerId: string, leaseMs = 30_000): SchedulerActivation | undefined {
    const consumer = requiredString(consumerId, 'consumer_id');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new Error('scheduler_activation_lease_ms_invalid');
    }
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const expires = new Date(nowDate.getTime() + leaseMs).toISOString();
    return this.#transaction(() => {
      this.#db.prepare(`
        update scheduler_activations
           set status = 'terminal',
               lease_owner = null,
               lease_token = null,
               lease_expires_at = null,
               terminal_outcome = 'cancelled_binding_paused',
               last_error = 'binding_paused_after_lease_expiry',
               updated_at = ?
         where status = 'leased'
           and lease_expires_at <= ?
           and binding_id in (
             select binding_id from scheduler_bindings where status = 'paused'
           )
      `).run(now, now);
      this.#db.prepare(`
        update scheduler_activations
           set status = 'pending',
               lease_owner = null,
               lease_token = null,
               lease_expires_at = null,
               attempt_count = attempt_count + 1,
               last_error = 'lease_expired',
               updated_at = ?
         where status = 'leased'
           and lease_expires_at <= ?
           and binding_id in (
             select binding_id from scheduler_bindings where status in ('active', 'retired')
           )
      `).run(now, now);
      const row = this.#db.prepare(`
        select activation.*
          from scheduler_activations activation
          join scheduler_bindings binding on binding.binding_id = activation.binding_id
         where activation.status = 'pending'
           and activation.due_at <= ?
           and binding.status in ('active', 'retired')
           and not exists (
             select 1 from scheduler_activations active
              where active.binding_id = activation.binding_id
                and active.partition_key = activation.partition_key
                and active.activation_id <> activation.activation_id
                and active.status in ('leased', 'admitted')
           )
         order by activation.due_at, activation.activation_id
         limit 1
      `).get(now) as SqlRow | undefined;
      if (!row) return undefined;
      const activationId = String(row.activation_id);
      const leaseToken = randomUUID();
      this.#db.prepare(`
        update scheduler_activations
           set status = 'leased', lease_owner = ?, lease_token = ?, lease_expires_at = ?,
               updated_at = ?
         where activation_id = ? and status = 'pending'
      `).run(consumer, leaseToken, expires, now, activationId);
      return this.getActivation(activationId);
    });
  }

  markAdmitted(input: {
    activationId: string;
    consumerId: string;
    leaseToken: string;
    sopRunId: string;
    receiptId: string;
    receipt: Record<string, unknown>;
  }): SchedulerActivation {
    const now = this.#now().toISOString();
    return this.#transaction(() => {
      const activation = this.#requireLeased(input.activationId, input.consumerId, input.leaseToken);
      this.#db.prepare(`
        update scheduler_activations
           set status = 'admitted', sop_run_id = ?, lease_owner = null,
               lease_token = null, lease_expires_at = null, updated_at = ?
         where activation_id = ?
      `).run(requiredString(input.sopRunId, 'sop_run_id'), now, activation.activation_id);
      this.#recordReceipt(
        activation.activation_id,
        'sop_admission',
        input.receiptId,
        input.receipt,
        now,
      );
      return this.getActivation(activation.activation_id)!;
    });
  }

  failClaim(input: {
    activationId: string;
    consumerId: string;
    leaseToken: string;
    retryable: boolean;
    error: string;
  }): SchedulerActivation {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    return this.#transaction(() => {
      const activation = this.#requireLeased(input.activationId, input.consumerId, input.leaseToken);
      const binding = this.requireBinding(activation.binding_id);
      const nextAttempt = activation.attempt_count + 1;
      const retry = input.retryable && nextAttempt < (binding.max_attempts ?? 5);
      const delay = Math.min(
        binding.retry_max_ms ?? 300_000,
        (binding.retry_base_ms ?? 1_000) * (2 ** Math.max(0, nextAttempt - 1)),
      );
      this.#db.prepare(`
        update scheduler_activations
           set status = ?, attempt_count = ?, lease_owner = null,
               lease_token = null, lease_expires_at = null, due_at = ?, last_error = ?, updated_at = ?
         where activation_id = ?
      `).run(
        retry ? 'pending' : 'blocked',
        nextAttempt,
        new Date(nowDate.getTime() + delay).toISOString(),
        input.error.slice(0, MAX_ERROR_BYTES),
        now,
        activation.activation_id,
      );
      return this.getActivation(activation.activation_id)!;
    });
  }

  resolveActivation(input: {
    activationId?: string;
    sopRunId?: string;
    outcome: string;
    receiptId: string;
    receipt: Record<string, unknown>;
  }): SchedulerActivation {
    const now = this.#now().toISOString();
    return this.#transaction(() => {
      const row = input.activationId
        ? this.#db.prepare(
          'select * from scheduler_activations where activation_id = ?',
        ).get(input.activationId) as SqlRow | undefined
        : this.#db.prepare(
          'select * from scheduler_activations where sop_run_id = ?',
        ).get(requiredString(input.sopRunId ?? '', 'sop_run_id')) as SqlRow | undefined;
      if (!row) throw new Error('scheduler_activation_not_found');
      const activation = activationFromRow(row);
      if (activation.status === 'terminal') {
        const receipt = this.#db.prepare(`
          select receipt_id from scheduler_activation_receipts
           where activation_id = ? and receipt_kind = 'terminal'
        `).get(activation.activation_id) as SqlRow | undefined;
        if (receipt && String(receipt.receipt_id) === input.receiptId) return activation;
        throw new Error('scheduler_activation_terminal_conflict');
      }
      if (activation.status !== 'admitted') {
        throw new Error(`scheduler_activation_not_admitted:${activation.status}`);
      }
      this.#db.prepare(`
        update scheduler_activations
           set status = 'terminal', terminal_outcome = ?, updated_at = ?
         where activation_id = ?
      `).run(requiredString(input.outcome, 'outcome'), now, activation.activation_id);
      this.#recordReceipt(
        activation.activation_id,
        'terminal',
        input.receiptId,
        input.receipt,
        now,
      );
      return this.getActivation(activation.activation_id)!;
    });
  }

  unblockActivation(activationId: string, dueAt?: string): SchedulerActivation {
    const now = this.#now().toISOString();
    return this.#transaction(() => {
      const activation = this.getActivation(activationId);
      if (!activation) throw new Error('scheduler_activation_not_found');
      if (activation.status !== 'blocked') {
        throw new Error(`scheduler_activation_not_blocked:${activation.status}`);
      }
      const parsedDue = dueAt ? new Date(dueAt) : this.#now();
      if (Number.isNaN(parsedDue.getTime())) throw new Error('scheduler_activation_due_at_invalid');
      this.#db.prepare(`
        update scheduler_activations
           set status = 'pending', due_at = ?, last_error = null, updated_at = ?
         where activation_id = ?
      `).run(parsedDue.toISOString(), now, activationId);
      return this.getActivation(activationId)!;
    });
  }

  #normalizeBinding(input: SchedulerBindingInput): {
    spec: Required<Omit<SchedulerBindingInput, 'expected_revision' | 'source_sop_id'>>
      & { source_sop_id: string | null };
  } {
    if (!['bootstrap', 'completion', 'domain_event'].includes(input.trigger_kind)) {
      throw new Error('scheduler_binding_trigger_kind_invalid');
    }
    if (!['singleton', 'partitioned'].includes(input.concurrency)) {
      throw new Error('scheduler_binding_concurrency_invalid');
    }
    const delays: Record<string, number> = {};
    for (const [outcome, delay] of Object.entries(input.delay_by_outcome_ms ?? {})) {
      if (!Number.isInteger(delay) || delay < 0) throw new Error('scheduler_binding_delay_invalid');
      delays[outcome] = delay;
    }
    const positiveInteger = (value: number | undefined, fallback: number, field: string): number => {
      const result = value ?? fallback;
      if (!Number.isInteger(result) || result < 0) throw new Error(`${field}_invalid`);
      return result;
    };
    const retryBase = positiveInteger(input.retry_base_ms, 1_000, 'retry_base_ms');
    const retryMax = positiveInteger(input.retry_max_ms, 300_000, 'retry_max_ms');
    if (retryMax < retryBase) throw new Error('retry_max_ms_below_base');
    const maxAttempts = positiveInteger(input.max_attempts, 5, 'max_attempts');
    if (maxAttempts < 1) throw new Error('max_attempts_invalid');
    return {
      spec: {
        binding_id: requiredString(input.binding_id, 'binding_id'),
        trigger_kind: input.trigger_kind,
        source_topic: requiredString(input.source_topic, 'source_topic'),
        source_sop_id: input.source_sop_id
          ? requiredString(input.source_sop_id, 'source_sop_id')
          : null,
        terminal_outcomes: [...new Set(input.terminal_outcomes ?? [])].sort(),
        target_sop_id: requiredString(input.target_sop_id, 'target_sop_id'),
        target_template_version: requiredString(
          input.target_template_version,
          'target_template_version',
        ),
        concurrency: input.concurrency,
        delay_by_outcome_ms: delays,
        default_delay_ms: positiveInteger(input.default_delay_ms, 0, 'default_delay_ms'),
        retry_base_ms: retryBase,
        retry_max_ms: retryMax,
        max_attempts: maxAttempts,
        blocked_policy: input.blocked_policy ?? 'manual_unblock',
      },
    };
  }

  #normalizeEvent(input: SchedulerSourceEvent): SchedulerSourceEvent {
    const occurredAt = new Date(input.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) throw new Error('scheduler_event_occurred_at_invalid');
    if (!Number.isInteger(input.aggregate_revision) || input.aggregate_revision < 0) {
      throw new Error('scheduler_event_aggregate_revision_invalid');
    }
    if (!Number.isInteger(input.schema_version) || input.schema_version < 1) {
      throw new Error('scheduler_event_schema_version_invalid');
    }
    boundedJson(input.payload, 'scheduler_event_payload', MAX_EVENT_BYTES);
    return {
      ...input,
      event_id: requiredString(input.event_id, 'event_id'),
      topic: requiredString(input.topic, 'topic'),
      partition_key: requiredString(input.partition_key, 'partition_key'),
      aggregate_id: requiredString(input.aggregate_id, 'aggregate_id'),
      causation_id: requiredString(input.causation_id, 'causation_id'),
      idempotency_key: requiredString(input.idempotency_key, 'idempotency_key'),
      occurred_at: occurredAt.toISOString(),
    };
  }

  #bindingMatches(binding: SchedulerBindingRecord, event: SchedulerSourceEvent): boolean {
    if (
      binding.source_sop_id
      && String(event.payload.sop_id ?? '') !== binding.source_sop_id
    ) return false;
    if (
      (binding.terminal_outcomes?.length ?? 0) > 0
      && !binding.terminal_outcomes!.includes(String(event.payload.outcome ?? ''))
    ) return false;
    return true;
  }

  #delayFor(
    binding: SchedulerBindingRecord,
    outcome: string,
    payload: Record<string, unknown>,
  ): number {
    if (outcome === 'retryable_failure') {
      const attempt = typeof payload.attempt === 'number' && Number.isInteger(payload.attempt)
        ? Math.max(1, payload.attempt)
        : 1;
      return Math.min(
        binding.retry_max_ms ?? 300_000,
        (binding.retry_base_ms ?? 1_000) * (2 ** (attempt - 1)),
      );
    }
    return binding.delay_by_outcome_ms?.[outcome] ?? binding.default_delay_ms ?? 0;
  }

  #requireLeased(activationId: string, consumerId: string, leaseToken: string): SchedulerActivation {
    const activation = this.getActivation(requiredString(activationId, 'activation_id'));
    if (!activation) throw new Error('scheduler_activation_not_found');
    if (activation.status !== 'leased') {
      throw new Error(`scheduler_activation_not_leased:${activation.status}`);
    }
    if (activation.lease_owner !== consumerId) {
      throw new Error('scheduler_activation_lease_owner_mismatch');
    }
    if (activation.lease_token !== requiredString(leaseToken, 'lease_token')) {
      throw new Error('scheduler_activation_lease_token_mismatch');
    }
    if (!activation.lease_expires_at || activation.lease_expires_at <= this.#now().toISOString()) {
      throw new Error('scheduler_activation_lease_expired');
    }
    return activation;
  }

  #recordReceipt(
    activationId: string,
    kind: string,
    receiptId: string,
    receipt: Record<string, unknown>,
    recordedAt: string,
  ): void {
    this.#db.prepare(`
      insert into scheduler_activation_receipts(
        activation_id, receipt_kind, receipt_id, receipt_json, recorded_at
      ) values (?, ?, ?, ?, ?)
    `).run(
      activationId,
      kind,
      requiredString(receiptId, 'receipt_id'),
      boundedJson(receipt, 'scheduler_activation_receipt', MAX_EVENT_BYTES),
      recordedAt,
    );
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec('begin immediate');
    try {
      const result = action();
      this.#db.exec('commit');
      return result;
    } catch (error) {
      try {
        this.#db.exec('rollback');
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }
}
