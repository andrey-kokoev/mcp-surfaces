import { executionRequestFingerprint, type ExecutionBinding } from '@narada2/execution-contract';

type SqliteStoreLike = {
  db: {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...args: unknown[]): unknown;
      run(...args: unknown[]): unknown;
    };
  };
};

export type TaskCreationReservation = {
  idempotency_key: string;
  payload_sha256: string;
  task_id: string;
  task_number: number;
  file_path: string;
  execution_binding_json: string;
  status: 'reserved' | 'created' | 'failed';
  created_at: string;
  updated_at: string;
};

export function ensureTaskExecutionTables(store: SqliteStoreLike): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS narada_task_creation_requests (
      idempotency_key TEXT PRIMARY KEY,
      payload_sha256 TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      task_number INTEGER NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      execution_binding_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'created', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_narada_task_creation_requests_status
      ON narada_task_creation_requests(status);
    CREATE TABLE IF NOT EXISTS narada_task_execution_bindings (
      task_id TEXT PRIMARY KEY,
      task_number INTEGER NOT NULL UNIQUE,
      binding_json TEXT NOT NULL,
      correlation_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function taskCreationPayloadFingerprint(value: unknown, payloadSha256?: unknown): string {
  return typeof payloadSha256 === 'string' && payloadSha256.trim()
    ? payloadSha256.trim()
    : executionRequestFingerprint(value);
}

export function getTaskCreationReservation(store: SqliteStoreLike, idempotencyKey: string): TaskCreationReservation | null {
  ensureTaskExecutionTables(store);
  const row = store.db.prepare(`
    SELECT idempotency_key, payload_sha256, task_id, task_number, file_path,
           execution_binding_json, status, created_at, updated_at
    FROM narada_task_creation_requests
    WHERE idempotency_key = ?
  `).get(idempotencyKey) as Record<string, unknown> | undefined;
  return row ? taskCreationReservationFromRow(row) : null;
}

export function reserveTaskCreation(
  store: SqliteStoreLike,
  reservation: Omit<TaskCreationReservation, 'status' | 'created_at' | 'updated_at'>,
): { reservation: TaskCreationReservation; created: boolean } {
  ensureTaskExecutionTables(store);
  const existing = getTaskCreationReservation(store, reservation.idempotency_key);
  if (existing) return { reservation: assertReservationMatches(existing, reservation), created: false };
  const now = new Date().toISOString();
  try {
    store.db.prepare(`
      INSERT INTO narada_task_creation_requests (
        idempotency_key, payload_sha256, task_id, task_number, file_path,
        execution_binding_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
    `).run(
      reservation.idempotency_key,
      reservation.payload_sha256,
      reservation.task_id,
      reservation.task_number,
      reservation.file_path,
      reservation.execution_binding_json,
      now,
      now,
    );
  } catch (error) {
    const concurrent = getTaskCreationReservation(store, reservation.idempotency_key);
    if (concurrent) return { reservation: assertReservationMatches(concurrent, reservation), created: false };
    throw error;
  }
  return {
    reservation: { ...reservation, status: 'reserved', created_at: now, updated_at: now },
    created: true,
  };
}

export function markTaskCreationStatus(store: SqliteStoreLike, idempotencyKey: string, status: TaskCreationReservation['status']): void {
  ensureTaskExecutionTables(store);
  store.db.prepare(`
    UPDATE narada_task_creation_requests
    SET status = ?, updated_at = ?
    WHERE idempotency_key = ?
  `).run(status, new Date().toISOString(), idempotencyKey);
}

export function bindTaskExecution(
  store: SqliteStoreLike,
  task: { task_id: string; task_number: number },
  binding: ExecutionBinding,
): void {
  ensureTaskExecutionTables(store);
  const bindingJson = JSON.stringify(binding);
  const existing = store.db.prepare(`
    SELECT binding_json, correlation_key
    FROM narada_task_execution_bindings
    WHERE task_id = ?
  `).get(task.task_id) as Record<string, unknown> | undefined;
  if (existing && (existing.binding_json !== bindingJson || existing.correlation_key !== binding.correlation_key)) {
    throw new Error(`execution_binding_conflict: ${task.task_id}`);
  }
  const now = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO narada_task_execution_bindings (
      task_id, task_number, binding_json, correlation_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      task_number = excluded.task_number,
      binding_json = excluded.binding_json,
      correlation_key = excluded.correlation_key,
      updated_at = excluded.updated_at
  `).run(task.task_id, task.task_number, bindingJson, binding.correlation_key, now, now);
}

function assertReservationMatches(
  existing: TaskCreationReservation,
  requested: Omit<TaskCreationReservation, 'status' | 'created_at' | 'updated_at'>,
): TaskCreationReservation {
  if (
    existing.payload_sha256 !== requested.payload_sha256
    || existing.task_id !== requested.task_id
    || existing.task_number !== requested.task_number
    || existing.execution_binding_json !== requested.execution_binding_json
  ) {
    throw new Error(`task_creation_idempotency_conflict: ${requested.idempotency_key}`);
  }
  return existing;
}

function taskCreationReservationFromRow(row: Record<string, unknown>): TaskCreationReservation {
  return {
    idempotency_key: String(row.idempotency_key),
    payload_sha256: String(row.payload_sha256),
    task_id: String(row.task_id),
    task_number: Number(row.task_number),
    file_path: String(row.file_path),
    execution_binding_json: String(row.execution_binding_json),
    status: String(row.status) as TaskCreationReservation['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
