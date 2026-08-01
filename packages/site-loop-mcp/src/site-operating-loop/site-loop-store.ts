import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SqliteTaskLifecycleStore } from '@narada-core/task-governance-core/task-lifecycle-store';
import { getSiteOperatingLoopRuntimeHost as getCanonicalSiteOperatingLoopRuntimeHost } from '@narada-core/site-operating-loop/site-loop-store';
import {
  boundedSiteLoopSummary,
  pruneSiteLoopEvidence,
  readSiteLoopEvidence,
  readSiteLoopEvidenceIfAvailable,
  recordSiteLoopPayload,
  removeSiteLoopEvidence,
  siteLoopEvidenceStoreFromDb,
  SiteLoopEvidenceError,
  type SiteLoopEvidenceStore,
  type SiteLoopEvidenceRef,
} from './site-loop-evidence.js';

export const SITE_LOOP_STORAGE_SCHEMA = 'narada.site_loop.storage.v3';
const SITE_LOOP_MEMORY_EVIDENCE_ROOT = ':memory:';

const SITE_LOOP_STORAGE_TABLES: Record<string, string[]> = {
  site_loop_runs: [
    'run_id', 'loop_id', 'status', 'dry_run', 'started_at', 'finished_at', 'summary_json', 'error_json',
    'evidence_ref', 'evidence_sha256', 'evidence_bytes',
  ],
  site_loop_step_runs: [
    'step_run_id', 'run_id', 'step_id', 'status', 'started_at', 'finished_at',
    'input_ref_count', 'output_ref_count', 'input_refs_digest', 'output_refs_digest',
    'summary_json', 'evidence_ref', 'evidence_sha256', 'evidence_bytes', 'error_json',
  ],
  site_loop_locks: [
    'loop_id', 'run_id', 'owner_id', 'acquired_at', 'expires_at', 'stale_recovery_count', 'updated_at',
  ],
  site_loop_health: [
    'loop_id', 'status', 'consecutive_failures', 'last_successful_run_id', 'last_success_at',
    'last_run_id', 'last_run_at', 'failing_step', 'last_error_json', 'last_error_evidence_ref',
    'last_error_evidence_sha256', 'last_error_evidence_bytes', 'updated_at',
  ],
  site_loop_control: ['loop_id', 'paused', 'mode', 'reason', 'updated_at'],
  site_loop_classification_observations: [
    'observation_id', 'loop_id', 'directive_id', 'classification', 'observed_at', 'run_id', 'task_id', 'observation_digest',
  ],
  site_loop_escalations: [
    'escalation_id', 'loop_id', 'directive_id', 'classification', 'status', 'envelope_id', 'created_at',
    'acknowledged_at', 'acknowledged_by', 'ack_reason', 'escalation_summary_json', 'escalation_ref',
    'escalation_sha256', 'escalation_bytes',
  ],
  directive_outcomes: [
    'outcome_id', 'loop_id', 'directive_id', 'outcome', 'agent_id', 'task_id', 'report_id', 'receipt_id',
    'reason', 'event_at', 'observed_at', 'recorded_at', 'evidence_summary_json', 'evidence_ref',
    'evidence_sha256', 'evidence_bytes',
  ],
  directive_outcome_latest: [
    'loop_id', 'directive_id', 'outcome_id', 'outcome', 'agent_id', 'task_id', 'report_id', 'receipt_id',
    'reason', 'event_at', 'observed_at', 'recorded_at', 'evidence_summary_json', 'evidence_ref',
    'evidence_sha256', 'evidence_bytes',
  ],
  site_loop_classification_current: [
    'loop_id', 'directive_id', 'classification', 'observation_id', 'observed_at', 'run_id', 'task_id', 'observation_digest',
  ],
  site_loop_storage_meta: [
    'storage_id', 'schema', 'cutover_at', 'evidence_root', 'persistence_schema', 'last_pruned_at', 'evidence_prune_cursor',
  ],
};

const SITE_LOOP_STORAGE_INDEXES = [
  'idx_site_loop_runs_loop_started',
  'idx_site_loop_runs_retention',
  'idx_site_loop_step_runs_run',
  'idx_site_loop_classification_directive',
  'idx_site_loop_classification_retention',
  'idx_site_loop_escalations_loop_status',
  'idx_site_loop_escalations_retention',
  'idx_directive_outcome_latest_outcome',
  'idx_directive_outcomes_latest',
  'idx_directive_outcomes_outcome',
  'idx_directive_outcomes_retention',
  'idx_site_loop_classification_current_classification',
];

export class SiteLoopStorageCutoverRequiredError extends Error {
  constructor(public readonly reason = 'legacy_site_loop_storage_detected') {
    super(`site_loop_storage_cutover_required:${reason}`);
    this.name = 'SiteLoopStorageCutoverRequiredError';
  }
}

export const DEFAULT_SITE_OPERATING_LOOP_ID = 'site.operating-loop';
export const DEFAULT_SITE_OPERATING_LOOP_OWNER_ID = 'site-operating-loop';

type JsonValue = unknown;
type JsonObject = Record<string, JsonValue>;
type SiteLoopSqliteStatement = {
  all(...args: unknown[]): JsonObject[];
  get(...args: unknown[]): JsonObject;
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};
export type SiteLoopDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SiteLoopSqliteStatement;
  pragma(sql: string): unknown;
  inTransaction?: boolean;
};
type SiteLoopDatabaseInput = SqliteTaskLifecycleStore['db'] | SiteLoopDatabase;
export type SiteLoopStore = {
  db: SiteLoopDatabase;
  evidenceStore?: SiteLoopEvidenceStore | null;
  siteRoot?: string;
};
type SiteLoopStoreOrNull = SiteLoopStore | null;
type StoredSiteLoopPayload = {
  summary: unknown;
  evidence: SiteLoopEvidenceRef | null;
};

export function asSiteLoopDatabase(db: unknown): SiteLoopDatabase {
  return db as unknown as SiteLoopDatabase;
}

function sqliteRecord(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonObject;
}

interface DirectiveOutcomeRecordOptions {
  loopId?: string;
  directiveId?: string;
  outcome?: string;
  agentId?: string | null;
  taskId?: string | null;
  reportId?: string | null;
  receiptId?: string | null;
  reason?: string | null;
  evidence?: JsonValue;
  at?: string | null;
  eventAt?: string | null;
  observedAt?: string | null;
  recordedAt?: string | null;
}

interface DirectiveOutcomeLookupOptions {
  loopId?: string;
  directiveId?: string;
  outcomeId?: string;
  outcome?: string | null;
  limit?: number;
}

interface LoopLockOptions {
  loopId?: string;
  runId?: string;
  ownerId?: string;
  ttlMs?: number;
  now?: Date;
}

interface LoopHealthSuccessOptions {
  loopId?: string;
  runId?: string;
  at?: string;
}

interface LoopHealthFailureOptions extends LoopHealthSuccessOptions {
  failingStep?: string | null;
  error?: JsonValue;
  forcedStatus?: string | null;
}

interface LoopRunFinishOptions {
  status: string;
  finished_at: string;
  summary?: JsonValue;
  error?: JsonValue;
}

interface StaleLoopRunReconciliationOptions {
  loopId?: string;
  activeRunId?: string | null;
  staleAfterMs?: number;
  now?: Date;
}

interface LoopControlOptions {
  loopId?: string;
  paused?: boolean;
  mode?: string;
  reason?: string | null;
  at?: string;
}

interface LoopClassificationOptions {
  loopId?: string;
  directiveId?: string;
  classification?: string;
  observation?: JsonValue;
  limit?: number;
  at?: string;
}

interface LoopClassificationRecoveryOptions {
  loopId?: string;
  directiveId?: string;
  classification?: string;
  since?: string | null;
}

interface LoopEscalationOptions {
  loopId?: string;
  directiveId?: string;
  classification?: string;
  envelopeId?: string | null;
  escalation?: JsonValue;
  at?: string;
}

interface LoopAttentionLookupOptions {
  attentionId?: string;
}

interface LoopAttentionAckOptions extends LoopAttentionLookupOptions {
  reason?: string;
  acknowledgedBy?: string;
  at?: string;
}

interface DirectiveOutcomeResolveOptions {
  loopId?: string;
  directiveId?: string;
  reason?: string;
  resolvedBy?: string;
  at?: string;
}

export function ensureSiteLoopTables(database: SiteLoopDatabaseInput) {
  const db = database as SiteLoopDatabase;
  const managedTablesPresent = Object.keys(SITE_LOOP_STORAGE_TABLES)
    .filter((table) => tableExists(db, table));
  if (managedTablesPresent.length > 0) {
    assertSiteLoopStorageSchema(db);
    ensureTaskReportDirectiveColumn(db);
    return {
      schema: 'narada.site_operating_loop.schema_repair.v1',
      status: 'ok',
      repairs: [],
    };
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_loop_runs (
      run_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      summary_json TEXT,
      error_json TEXT,
      evidence_ref TEXT,
      evidence_sha256 TEXT,
      evidence_bytes INTEGER
    );

    CREATE TABLE IF NOT EXISTS site_loop_step_runs (
      step_run_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      input_ref_count INTEGER NOT NULL DEFAULT 0,
      output_ref_count INTEGER NOT NULL DEFAULT 0,
      input_refs_digest TEXT,
      output_refs_digest TEXT,
      summary_json TEXT,
      evidence_ref TEXT,
      evidence_sha256 TEXT,
      evidence_bytes INTEGER,
      error_json TEXT,
      FOREIGN KEY (run_id) REFERENCES site_loop_runs(run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_site_loop_runs_loop_started
      ON site_loop_runs(loop_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_site_loop_runs_retention
      ON site_loop_runs(status, finished_at, started_at);

    CREATE INDEX IF NOT EXISTS idx_site_loop_step_runs_run
      ON site_loop_step_runs(run_id, step_id);

    CREATE TABLE IF NOT EXISTS site_loop_locks (
      loop_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      stale_recovery_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_loop_health (
      loop_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_successful_run_id TEXT,
      last_success_at TEXT,
      last_run_id TEXT,
      last_run_at TEXT,
      failing_step TEXT,
      last_error_json TEXT,
      last_error_evidence_ref TEXT,
      last_error_evidence_sha256 TEXT,
      last_error_evidence_bytes INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_loop_control (
      loop_id TEXT PRIMARY KEY,
      paused INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'running',
      reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_loop_classification_observations (
      observation_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      run_id TEXT,
      task_id TEXT,
      observation_digest TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_site_loop_classification_directive
      ON site_loop_classification_observations(loop_id, directive_id, classification, observed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_site_loop_classification_retention
      ON site_loop_classification_observations(observed_at);

    CREATE TABLE IF NOT EXISTS site_loop_escalations (
      escalation_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      status TEXT NOT NULL,
      envelope_id TEXT,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      ack_reason TEXT,
      escalation_summary_json TEXT NOT NULL,
      escalation_ref TEXT,
      escalation_sha256 TEXT,
      escalation_bytes INTEGER,
      UNIQUE(loop_id, directive_id, classification)
    );

    CREATE INDEX IF NOT EXISTS idx_site_loop_escalations_loop_status
      ON site_loop_escalations(loop_id, status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_site_loop_escalations_retention
      ON site_loop_escalations(status, created_at);

    CREATE TABLE IF NOT EXISTS directive_outcomes (
      outcome_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      report_id TEXT,
      receipt_id TEXT,
      reason TEXT,
      event_at TEXT,
      observed_at TEXT,
      recorded_at TEXT NOT NULL,
      evidence_summary_json TEXT NOT NULL,
      evidence_ref TEXT,
      evidence_sha256 TEXT,
      evidence_bytes INTEGER
    );

    CREATE TABLE IF NOT EXISTS directive_outcome_latest (
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      report_id TEXT,
      receipt_id TEXT,
      reason TEXT,
      event_at TEXT,
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      evidence_summary_json TEXT NOT NULL,
      evidence_ref TEXT,
      evidence_sha256 TEXT,
      evidence_bytes INTEGER,
      PRIMARY KEY (loop_id, directive_id)
    );

    CREATE INDEX IF NOT EXISTS idx_directive_outcome_latest_outcome
      ON directive_outcome_latest(loop_id, outcome, observed_at DESC, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_latest
      ON directive_outcomes(loop_id, directive_id, observed_at DESC, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_outcome
      ON directive_outcomes(loop_id, outcome, observed_at DESC, recorded_at DESC);

    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_retention
      ON directive_outcomes(recorded_at, outcome_id);

    CREATE TABLE IF NOT EXISTS site_loop_classification_current (
      loop_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      classification TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      run_id TEXT,
      task_id TEXT,
      observation_digest TEXT NOT NULL,
      PRIMARY KEY (loop_id, directive_id)
    );

    CREATE INDEX IF NOT EXISTS idx_site_loop_classification_current_classification
      ON site_loop_classification_current(loop_id, classification, observed_at DESC);

    CREATE TABLE IF NOT EXISTS site_loop_storage_meta (
      storage_id INTEGER PRIMARY KEY CHECK (storage_id = 1),
      schema TEXT NOT NULL,
      cutover_at TEXT NOT NULL,
      evidence_root TEXT NOT NULL,
      persistence_schema TEXT NOT NULL,
      last_pruned_at TEXT,
      evidence_prune_cursor TEXT
    );
  `);
  ensureSiteLoopStorageMeta(db);
  ensureTaskReportDirectiveColumn(db);
  return {
    schema: 'narada.site_operating_loop.schema_repair.v1',
    status: 'ok',
    repairs: [],
  };
}

export function assertSiteLoopStorageSchema(database: SiteLoopDatabaseInput, { allowMissing = false } : { allowMissing?: boolean } = {}) {
  const db = database as SiteLoopDatabase;
  const targetTables = Object.keys(SITE_LOOP_STORAGE_TABLES);
  const present = targetTables.filter((table) => tableExists(db, table));
  if (present.length === 0) {
    if (allowMissing) return;
    throw new SiteLoopStorageCutoverRequiredError('site_loop_storage_missing');
  }
  if (present.length !== targetTables.length) {
    throw new SiteLoopStorageCutoverRequiredError('site_loop_storage_partial');
  }

  const legacyColumns: Record<string, string[]> = {
    site_loop_step_runs: ['input_refs_json', 'output_refs_json', 'evidence_json'],
    site_loop_classification_observations: ['observation_json'],
    site_loop_escalations: ['escalation_json'],
    directive_outcomes: ['evidence_json'],
    directive_outcome_latest: ['evidence_json'],
  };
  for (const [table, columns] of Object.entries(legacyColumns)) {
    const presentColumns = tableColumns(db, table);
    if (columns.some((column) => presentColumns.includes(column))) {
      throw new SiteLoopStorageCutoverRequiredError(`legacy_columns:${table}`);
    }
  }
  for (const [table, columns] of Object.entries(SITE_LOOP_STORAGE_TABLES)) {
    const presentColumns = tableColumns(db, table);
    if (columns.some((column) => !presentColumns.includes(column))) {
      throw new SiteLoopStorageCutoverRequiredError(`v3_columns_missing:${table}`);
    }
  }
  for (const indexName of SITE_LOOP_STORAGE_INDEXES) {
    if (!hasIndex(db, indexName)) {
      throw new SiteLoopStorageCutoverRequiredError(`v3_index_missing:${indexName}`);
    }
  }
  const stepForeignKeys: any[] = db.prepare('PRAGMA foreign_key_list(site_loop_step_runs)').all();
  if (!stepForeignKeys.some((row: any) => row.table === 'site_loop_runs' && row.from === 'run_id' && row.to === 'run_id')) {
    throw new SiteLoopStorageCutoverRequiredError('v3_foreign_key_missing:site_loop_step_runs.run_id');
  }
  if (!/UNIQUE\s*\(\s*loop_id\s*,\s*directive_id\s*,\s*classification\s*\)/i.test(tableSql(db, 'site_loop_escalations'))) {
    throw new SiteLoopStorageCutoverRequiredError('v3_unique_constraint_missing:site_loop_escalations');
  }
  if (!/CHECK\s*\(\s*storage_id\s*=\s*1\s*\)/i.test(tableSql(db, 'site_loop_storage_meta'))) {
    throw new SiteLoopStorageCutoverRequiredError('v3_check_constraint_missing:site_loop_storage_meta');
  }
  const meta: any = db.prepare(`
    SELECT schema, evidence_root, persistence_schema
    FROM site_loop_storage_meta
    WHERE storage_id = 1
  `).get();
  if (!meta || String(meta.schema) !== SITE_LOOP_STORAGE_SCHEMA) {
    throw new SiteLoopStorageCutoverRequiredError('storage_meta_mismatch');
  }
  const expectedEvidence = evidenceMetadataForDb(db);
  if (comparablePath(meta.evidence_root) !== comparablePath(expectedEvidence.root)) {
    throw new SiteLoopStorageCutoverRequiredError('evidence_root_mismatch');
  }
  if (String(meta.persistence_schema) !== expectedEvidence.persistenceSchema) {
    throw new SiteLoopStorageCutoverRequiredError('persistence_schema_mismatch');
  }
}

export function ensureSiteLoopStorageIndexes(database: SiteLoopDatabaseInput) {
  const db = database as SiteLoopDatabase;
  const missingTables = Object.keys(SITE_LOOP_STORAGE_TABLES).filter((table) => !tableExists(db, table));
  if (missingTables.length > 0) {
    throw new SiteLoopStorageCutoverRequiredError(`site_loop_storage_partial:${missingTables.join(',')}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_site_loop_runs_loop_started
      ON site_loop_runs(loop_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_loop_runs_retention
      ON site_loop_runs(status, finished_at, started_at);
    CREATE INDEX IF NOT EXISTS idx_site_loop_step_runs_run
      ON site_loop_step_runs(run_id, step_id);
    CREATE INDEX IF NOT EXISTS idx_site_loop_classification_directive
      ON site_loop_classification_observations(loop_id, directive_id, classification, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_loop_classification_retention
      ON site_loop_classification_observations(observed_at);
    CREATE INDEX IF NOT EXISTS idx_site_loop_escalations_loop_status
      ON site_loop_escalations(loop_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_site_loop_escalations_retention
      ON site_loop_escalations(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_directive_outcome_latest_outcome
      ON directive_outcome_latest(loop_id, outcome, observed_at DESC, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_latest
      ON directive_outcomes(loop_id, directive_id, observed_at DESC, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_outcome
      ON directive_outcomes(loop_id, outcome, observed_at DESC, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_directive_outcomes_retention
      ON directive_outcomes(recorded_at, outcome_id);
    CREATE INDEX IF NOT EXISTS idx_site_loop_classification_current_classification
      ON site_loop_classification_current(loop_id, classification, observed_at DESC);
  `);
}

function ensureSiteLoopStorageMeta(db: SiteLoopDatabase) {
  const evidence = evidenceMetadataForDb(db);
  const existing: any = tableExists(db, 'site_loop_storage_meta')
    ? db.prepare('SELECT schema FROM site_loop_storage_meta WHERE storage_id = 1').get()
    : null;
  if (existing && String(existing.schema) !== SITE_LOOP_STORAGE_SCHEMA) {
    throw new SiteLoopStorageCutoverRequiredError('storage_meta_mismatch');
  }
  if (!existing) {
    db.prepare(`
      INSERT INTO site_loop_storage_meta (
        storage_id, schema, cutover_at, evidence_root, persistence_schema, last_pruned_at, evidence_prune_cursor
      ) VALUES (1, ?, ?, ?, ?, NULL, NULL)
    `).run(SITE_LOOP_STORAGE_SCHEMA, new Date().toISOString(), evidence.root, evidence.persistenceSchema);
  }
}

function tableColumns(db: SiteLoopDatabase, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => String(row.name));
}

function tableSql(db: SiteLoopDatabase, table: string): string {
  const row: any = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table);
  return String(row?.sql ?? '');
}

function hasIndex(db: SiteLoopDatabase, indexName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1
  `).get(indexName));
}

function evidenceMetadataForDb(db: SiteLoopDatabase) {
  const store = siteLoopEvidenceStoreFromDb(db);
  return {
    root: store?.root ?? SITE_LOOP_MEMORY_EVIDENCE_ROOT,
    persistenceSchema: store?.persistenceSchema ?? 'narada.site_loop.persistence.v2',
  };
}

function comparablePath(value: unknown): string {
  const text = String(value ?? '');
  if (text === SITE_LOOP_MEMORY_EVIDENCE_ROOT) return text;
  const normalized = resolve(text);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function ensureTaskReportDirectiveColumn(db: SiteLoopDatabase) {
  if (!tableExists(db, 'task_reports')) return;
  ensureColumn(db, 'task_reports', 'directive_id', 'TEXT');
  db.prepare('CREATE INDEX IF NOT EXISTS idx_task_reports_directive_id ON task_reports(directive_id)').run();
}

function evidenceStoreForStore(store: SiteLoopStoreOrNull): SiteLoopEvidenceStore | null {
  return store?.evidenceStore ?? siteLoopEvidenceStoreFromDb(store?.db);
}

function inlineSummaryBytesForStore(store: SiteLoopStore): number {
  return Math.max(1024, Number(evidenceStoreForStore(store)?.inlineSummaryBytes ?? 16_384));
}

function storedSummary(value: unknown, evidenceRef: string | null, store: SiteLoopStore): unknown {
  return boundedSiteLoopSummary(value, evidenceRef, inlineSummaryBytesForStore(store));
}

function boundedText(value: unknown, maxBytes = 2048): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = text.slice(0, maxBytes);
  while (Buffer.byteLength(`${result}...`, 'utf8') > maxBytes && result.length > 0) result = result.slice(0, -1);
  return `${result}...`;
}

function cleanupStoredEvidence(store: SiteLoopStore, storedEvidence: StoredSiteLoopPayload): void {
  cleanupEvidenceRef(store, storedEvidence?.evidence?.ref ?? null);
}

function cleanupEvidenceRef(store: SiteLoopStore, ref: unknown): void {
  if (typeof ref !== 'string' || ref.length === 0) return;
  try {
    const references: Array<[string, string]> = [
      ['site_loop_runs', 'evidence_ref'],
      ['site_loop_step_runs', 'evidence_ref'],
      ['site_loop_health', 'last_error_evidence_ref'],
      ['site_loop_escalations', 'escalation_ref'],
      ['directive_outcomes', 'evidence_ref'],
      ['directive_outcome_latest', 'evidence_ref'],
    ];
    for (const [table, column] of references) {
      if (store?.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(ref)) return;
    }
    removeSiteLoopEvidence(evidenceStoreForStore(store), ref);
  } catch {
    // Retention maintenance remains the final orphan cleanup path.
  }
}

export function recordDirectiveOutcome(store: SiteLoopStore, {
  loopId = DEFAULT_SITE_OPERATING_LOOP_ID,
  directiveId,
  outcome,
  agentId = null,
  taskId = null,
  reportId = null,
  receiptId = null,
  reason = null,
  evidence = null,
  at = null,
  eventAt = null,
  observedAt = null,
  recordedAt = null,
}: DirectiveOutcomeRecordOptions = {}) {
  const finalRecordedAt = recordedAt ?? at ?? new Date().toISOString();
  const finalObservedAt: string = observedAt ?? finalRecordedAt;
  const finalEventAt: string = eventAt ?? finalObservedAt;
  const finalReason = boundedText(reason);
  const outcomeId = `dirout_${hashStable({ loopId, directiveId, outcome, finalRecordedAt, finalObservedAt, nonce: randomUUID() }).slice(0, 32)}`;
  const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'directive_outcome', evidence ?? {}, {
    loop_id: loopId,
    directive_id: directiveId,
    outcome_id: outcomeId,
  });
  const evidenceSummary = stringifyJson(storedEvidence.summary);
  const alreadyInTransaction = Boolean(store.db.inTransaction);
  if (!alreadyInTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare(`
      INSERT INTO directive_outcomes (
        outcome_id, loop_id, directive_id, outcome, agent_id, task_id, report_id,
        receipt_id, reason, event_at, observed_at, recorded_at,
        evidence_summary_json, evidence_ref, evidence_sha256, evidence_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcomeId,
      loopId,
      directiveId,
      outcome,
      agentId,
      taskId,
      reportId,
      receiptId,
      finalReason,
      finalEventAt,
      finalObservedAt,
      finalRecordedAt,
      evidenceSummary,
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
    );
    upsertDirectiveOutcomeLatest(store.db, {
      outcome_id: outcomeId,
      loop_id: loopId,
      directive_id: directiveId,
      outcome,
      agent_id: agentId,
      task_id: taskId,
      report_id: reportId,
      receipt_id: receiptId,
      reason: finalReason,
      event_at: finalEventAt,
      observed_at: finalObservedAt,
      recorded_at: finalRecordedAt,
      evidence_summary_json: evidenceSummary,
      evidence_ref: storedEvidence.evidence?.ref ?? null,
      evidence_sha256: storedEvidence.evidence?.sha256 ?? null,
      evidence_bytes: storedEvidence.evidence?.compressed_bytes ?? null,
    });
    if (!alreadyInTransaction) store.db.exec('COMMIT');
  } catch (error) {
    if (!alreadyInTransaction) {
      try {
        store.db.exec('ROLLBACK');
      } catch {
        // Preserve the original persistence error.
      }
    }
    cleanupStoredEvidence(store, storedEvidence);
    throw error;
  }
  return getDirectiveOutcome(store, { outcomeId });
}

export function getDirectiveOutcome(store: SiteLoopStore, { outcomeId }: DirectiveOutcomeLookupOptions = {}) {
  const row: any = store.db.prepare('SELECT * FROM directive_outcomes WHERE outcome_id = ?').get(outcomeId);
  return row ? parseDirectiveOutcomeRow(row, store) : null;
}

export function getLatestDirectiveOutcome(store: SiteLoopStore, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID, directiveId }: DirectiveOutcomeLookupOptions = {}) {
  const row: any = store.db.prepare(`
    SELECT * FROM directive_outcome_latest
    WHERE loop_id = ? AND directive_id = ?
    LIMIT 1
  `).get(loopId, directiveId);
  return row ? parseDirectiveOutcomeRow(row, store) : null;
}

export function listDirectiveOutcomes(store: SiteLoopStore, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID, outcome = null, limit = 50 }: DirectiveOutcomeLookupOptions = {}) {
  const max = Math.max(1, Math.min(500, Number(limit ?? 50)));
  const rows: any = outcome
    ? store.db.prepare(`
        SELECT * FROM directive_outcomes
        WHERE loop_id = ? AND outcome = ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT ?
      `).all(loopId, outcome, max)
    : store.db.prepare(`
        SELECT * FROM directive_outcomes
        WHERE loop_id = ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT ?
      `).all(loopId, max);
  return rows.map((row: any) => parseDirectiveOutcomeRow(row, store));
}

export function getDirectiveOutcomeSummary(store: SiteLoopStore, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID }: DirectiveOutcomeLookupOptions = {}) {
  const rows: any = store.db.prepare(`
    SELECT outcome, COUNT(*) AS count
    FROM directive_outcome_latest
    WHERE loop_id = ?
    GROUP BY outcome
  `).all(loopId);
  const counts: Record<string, number> = {};
  let latestCount = 0;
  for (const row of rows) {
    counts[String(row.outcome)] = Number(row.count ?? 0);
    latestCount += Number(row.count ?? 0);
  }
  return {
    schema: 'narada.site_operating_loop.directive_outcome_summary.v1',
    loop_id: loopId,
    counts,
    latest_count: latestCount,
  };
}

export function acquireLoopLock(store: SiteLoopStore, {
  loopId,
  runId,
  ownerId = DEFAULT_SITE_OPERATING_LOOP_OWNER_ID,
  ttlMs = 5 * 60 * 1000,
  now = new Date(),
}: LoopLockOptions = {}) {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing: any = store.db.prepare('SELECT * FROM site_loop_locks WHERE loop_id = ?').get(loopId);
    if (!existing) {
      store.db.prepare(`
        INSERT INTO site_loop_locks (loop_id, run_id, owner_id, acquired_at, expires_at, stale_recovery_count, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(loopId, runId, ownerId, nowIso, expiresAt, nowIso);
      store.db.exec('COMMIT');
      return { status: 'acquired', schema: 'narada.site_operating_loop.lock.v1', loop_id: loopId, run_id: runId, expires_at: expiresAt };
    }

    if (String(existing.expires_at) > nowIso) {
      store.db.exec('COMMIT');
      return {
        status: 'contended',
        schema: 'narada.site_operating_loop.lock.v1',
        loop_id: loopId,
        run_id: runId,
        active_run_id: String(existing.run_id),
        owner_id: String(existing.owner_id),
        expires_at: String(existing.expires_at),
      };
    }

    const staleRecoveryCount = Number(existing.stale_recovery_count ?? 0) + 1;
    store.db.prepare(`
      UPDATE site_loop_locks
      SET run_id = ?, owner_id = ?, acquired_at = ?, expires_at = ?, stale_recovery_count = ?, updated_at = ?
      WHERE loop_id = ?
    `).run(runId, ownerId, nowIso, expiresAt, staleRecoveryCount, nowIso, loopId);
    store.db.exec('COMMIT');
    return {
      status: 'stale_recovered',
      schema: 'narada.site_operating_loop.lock.v1',
      loop_id: loopId,
      run_id: runId,
      previous_run_id: String(existing.run_id),
      previous_expires_at: String(existing.expires_at),
      expires_at: expiresAt,
      stale_recovery_count: staleRecoveryCount,
    };
  } catch (error: unknown) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      // Preserve original lock acquisition error.
    }
    throw error;
  }
}

export function releaseLoopLock(store: SiteLoopStore, { loopId, runId }: LoopLockOptions = {}) {
  const row: any = store.db.prepare('SELECT run_id FROM site_loop_locks WHERE loop_id = ?').get(loopId);
  if (!row) return { status: 'not_held', loop_id: loopId, run_id: runId };
  if (String(row.run_id) !== runId) {
    return { status: 'not_owner', loop_id: loopId, run_id: runId, active_run_id: String(row.run_id) };
  }
  store.db.prepare('DELETE FROM site_loop_locks WHERE loop_id = ? AND run_id = ?').run(loopId, runId);
  return { status: 'released', loop_id: loopId, run_id: runId };
}

export function getLoopLock(store: SiteLoopStore, loopId: string) {
  const row: any = store.db.prepare('SELECT * FROM site_loop_locks WHERE loop_id = ?').get(loopId);
  if (!row) return null;
  return {
    schema: 'narada.site_operating_loop.lock.v1',
    loop_id: String(row.loop_id),
    run_id: String(row.run_id),
    owner_id: String(row.owner_id),
    acquired_at: String(row.acquired_at),
    expires_at: String(row.expires_at),
    stale_recovery_count: Number(row.stale_recovery_count ?? 0),
    updated_at: String(row.updated_at),
  };
}

export function recordLoopHealthSuccess(store: SiteLoopStore, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID, runId, at = new Date().toISOString() }: LoopHealthSuccessOptions = {}) {
  const previous: any = store.db.prepare(
    'SELECT last_error_evidence_ref FROM site_loop_health WHERE loop_id = ?',
  ).get(loopId);
  store.db.prepare(`
    INSERT INTO site_loop_health (
      loop_id, status, consecutive_failures, last_successful_run_id, last_success_at,
      last_run_id, last_run_at, failing_step, last_error_json,
      last_error_evidence_ref, last_error_evidence_sha256, last_error_evidence_bytes, updated_at
    ) VALUES (?, 'healthy', 0, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(loop_id) DO UPDATE SET
      status = 'healthy',
      consecutive_failures = 0,
      last_successful_run_id = excluded.last_successful_run_id,
      last_success_at = excluded.last_success_at,
      last_run_id = excluded.last_run_id,
      last_run_at = excluded.last_run_at,
      failing_step = NULL,
      last_error_json = NULL,
      last_error_evidence_ref = NULL,
      last_error_evidence_sha256 = NULL,
      last_error_evidence_bytes = NULL,
      updated_at = excluded.updated_at
  `).run(loopId, runId, at, runId, at, at);
  cleanupEvidenceRef(store, previous?.last_error_evidence_ref ?? null);
  return getLoopHealth(store, loopId);
}

export function recordLoopHealthFailure(store: SiteLoopStore, {
  loopId = DEFAULT_SITE_OPERATING_LOOP_ID,
  runId,
  failingStep = null,
  error = null,
  forcedStatus = null,
  at = new Date().toISOString(),
}: LoopHealthFailureOptions = {}) {
  const previous: any = getLoopHealth(store, loopId);
  const consecutiveFailures = Number(previous?.consecutive_failures ?? 0) + 1;
  const status = forcedStatus ?? (consecutiveFailures >= 3 ? 'critical' : 'degraded');
  const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'loop_health_error', error, {
    loop_id: loopId,
    run_id: runId,
  });
  try {
    store.db.prepare(`
      INSERT INTO site_loop_health (
        loop_id, status, consecutive_failures, last_successful_run_id, last_success_at,
        last_run_id, last_run_at, failing_step, last_error_json,
        last_error_evidence_ref, last_error_evidence_sha256, last_error_evidence_bytes, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(loop_id) DO UPDATE SET
        status = excluded.status,
        consecutive_failures = excluded.consecutive_failures,
        last_run_id = excluded.last_run_id,
        last_run_at = excluded.last_run_at,
        failing_step = excluded.failing_step,
        last_error_json = excluded.last_error_json,
        last_error_evidence_ref = excluded.last_error_evidence_ref,
        last_error_evidence_sha256 = excluded.last_error_evidence_sha256,
        last_error_evidence_bytes = excluded.last_error_evidence_bytes,
        updated_at = excluded.updated_at
    `).run(
      loopId,
      status,
      consecutiveFailures,
      runId,
      at,
      failingStep,
      stringifyJson(storedSummary(error, storedEvidence.evidence?.ref ?? null, store)),
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
      at,
    );
  } catch (error) {
    cleanupStoredEvidence(store, storedEvidence);
    throw error;
  }
  if (previous?.last_error_evidence_ref !== storedEvidence.evidence?.ref) {
    cleanupEvidenceRef(store, previous?.last_error_evidence_ref ?? null);
  }
  return getLoopHealth(store, loopId);
}

export function getLoopHealth(store: SiteLoopStore, loopId: string) {
  const row: any = store.db.prepare('SELECT * FROM site_loop_health WHERE loop_id = ?').get(loopId);
  const attention: any = getLoopAttentionSummary(store, { loopId });
  const unresolvedBacklog: any = getLoopUnresolvedBacklogSummary(store, { loopId });
  const directiveOutcomes: any = getDirectiveOutcomeSummary(store, { loopId });
  if (!row) {
    return {
      schema: 'narada.site_operating_loop.health.v1',
      loop_id: loopId,
      status: 'unknown',
      consecutive_failures: 0,
      attention,
      unresolved_backlog: unresolvedBacklog,
      directive_outcomes: directiveOutcomes,
    };
  }
  const storedStatus = String(row.status);
  const effectiveStatus: string = storedStatus === 'healthy' && (attention.open_count > 0 || unresolvedBacklog.unresolved_count > 0) ? 'degraded' : storedStatus;
  return {
    schema: 'narada.site_operating_loop.health.v1',
    loop_id: String(row.loop_id),
    status: effectiveStatus,
    persisted_status: storedStatus,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    last_successful_run_id: row.last_successful_run_id ? String(row.last_successful_run_id) : null,
    last_success_at: row.last_success_at ? String(row.last_success_at) : null,
    last_run_id: row.last_run_id ? String(row.last_run_id) : null,
    last_run_at: row.last_run_at ? String(row.last_run_at) : null,
    failing_step: row.failing_step ? String(row.failing_step) : null,
    last_error: parseJson(row.last_error_json),
    last_error_evidence_ref: row.last_error_evidence_ref ? String(row.last_error_evidence_ref) : null,
    last_error_evidence_sha256: row.last_error_evidence_sha256 ? String(row.last_error_evidence_sha256) : null,
    last_error_evidence_bytes: row.last_error_evidence_bytes == null ? null : Number(row.last_error_evidence_bytes),
    updated_at: String(row.updated_at),
    attention,
    unresolved_backlog: unresolvedBacklog,
    directive_outcomes: directiveOutcomes,
  };
}

export function beginLoopRun(store: SiteLoopStore, run: JsonObject) {
  const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'loop_run', {
    summary: run.summary ?? null,
    error: run.error ?? null,
  }, {
    run_id: run.run_id,
  });
  try {
    store.db.prepare(`
      INSERT INTO site_loop_runs (
        run_id, loop_id, status, dry_run, started_at, summary_json, error_json,
        evidence_ref, evidence_sha256, evidence_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.run_id,
      run.loop_id,
      run.status,
      run.dry_run ? 1 : 0,
      run.started_at,
      stringifyJson(storedSummary(run.summary ?? null, storedEvidence.evidence?.ref ?? null, store)),
      stringifyJson(storedSummary(run.error ?? null, storedEvidence.evidence?.ref ?? null, store)),
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
    );
  } catch (error) {
    cleanupStoredEvidence(store, storedEvidence);
    throw error;
  }
}

export function finishLoopRun(store: SiteLoopStore, runId: string, { status, finished_at, summary = null, error = null }: LoopRunFinishOptions) {
  const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'loop_run', { summary, error }, {
    run_id: runId,
  });
  const previous: any = store.db.prepare(
    'SELECT evidence_ref FROM site_loop_runs WHERE run_id = ?',
  ).get(runId);
  const summaryJson = stringifyJson(storedSummary(
    summary,
    storedEvidence.evidence?.ref ?? null,
    store,
  ));
  const errorJson = stringifyJson(storedSummary(
    error,
    storedEvidence.evidence?.ref ?? null,
    store,
  ));
  try {
    const update: any = store.db.prepare(`
      UPDATE site_loop_runs
      SET status = ?, finished_at = ?, summary_json = ?, error_json = ?,
          evidence_ref = ?, evidence_sha256 = ?, evidence_bytes = ?
      WHERE run_id = ?
    `).run(
      status,
      finished_at,
      summaryJson,
      errorJson,
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
      runId,
    );
    if (Number(update.changes ?? 0) === 0) {
      cleanupStoredEvidence(store, storedEvidence);
      return;
    }
  } catch (error) {
    cleanupStoredEvidence(store, storedEvidence);
    throw error;
  }
  if (previous?.evidence_ref !== storedEvidence.evidence?.ref) {
    cleanupEvidenceRef(store, previous?.evidence_ref ?? null);
  }
}

export type SiteLoopPersistenceCompactionResult = {
  schema: 'narada.site_loop.persistence_compaction.v1';
  status: 'compacted';
  before_page_count: number;
  before_freelist_count: number;
  before_bytes: number;
  after_page_count: number;
  after_freelist_count: number;
  after_bytes: number;
  freed_bytes: number;
};

export function compactSiteLoopPersistence(store: SiteLoopStore): SiteLoopPersistenceCompactionResult {
  const db = store?.db;
  if (!db) throw new Error('site_loop_persistence_compaction_db_required');
  if (db.inTransaction) throw new Error('site_loop_persistence_compaction_transaction_active');
  const before = sqlitePageStats(db);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  const after = sqlitePageStats(db);
  return {
    schema: 'narada.site_loop.persistence_compaction.v1',
    status: 'compacted',
    before_page_count: before.pageCount,
    before_freelist_count: before.freelistCount,
    before_bytes: before.bytes,
    after_page_count: after.pageCount,
    after_freelist_count: after.freelistCount,
    after_bytes: after.bytes,
    freed_bytes: Math.max(0, before.bytes - after.bytes),
  };
}

function sqlitePageStats(db: SiteLoopDatabase): { pageCount: number; freelistCount: number; bytes: number } {
  const pageCount = Number(Object.values(db.prepare('PRAGMA page_count').get() ?? {})[0] ?? 0);
  const freelistCount = Number(Object.values(db.prepare('PRAGMA freelist_count').get() ?? {})[0] ?? 0);
  const pageSize = Number(Object.values(db.prepare('PRAGMA page_size').get() ?? {})[0] ?? 0);
  return {
    pageCount,
    freelistCount,
    bytes: pageCount * pageSize,
  };
}

export function pruneSiteLoopPersistence(
  store: SiteLoopStore,
  now = new Date(),
  { maxRows = 500, maxEvidenceFiles = 5000 }: { maxRows?: number; maxEvidenceFiles?: number } = {},
) {
  const evidenceStore: SiteLoopEvidenceStore | null = evidenceStoreForStore(store);
  const summaryRetentionDays = Math.max(1, Number(evidenceStore?.summaryRetentionDays ?? 90));
  const cutoff = new Date(now.getTime() - summaryRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = Math.max(1, Math.min(5000, Math.floor(Number(maxRows) || 500)));
  const deleted: Record<string, number> = {};
  const meta: any = store.db.prepare(`
    SELECT evidence_prune_cursor FROM site_loop_storage_meta WHERE storage_id = 1
  `).get();
  if (store.db.inTransaction) {
    throw new Error('site_loop_persistence_prune_transaction_active');
  }
  store.db.exec('BEGIN IMMEDIATE');
  try {
    deleted.step_runs = deletePruneBatch(store.db, `
      SELECT rowid FROM site_loop_step_runs
      WHERE run_id IN (
        SELECT run_id FROM site_loop_runs
        WHERE (finished_at < ? OR (finished_at IS NULL AND started_at < ?)) AND status <> 'running'
      )
      LIMIT ?
    `, [cutoff, cutoff, batchSize], 'site_loop_step_runs');
    deleted.runs = deletePruneBatch(store.db, `
      SELECT rowid FROM site_loop_runs
      WHERE (finished_at < ? OR (finished_at IS NULL AND started_at < ?)) AND status <> 'running'
        AND NOT EXISTS (
          SELECT 1 FROM site_loop_step_runs
          WHERE site_loop_step_runs.run_id = site_loop_runs.run_id
        )
      LIMIT ?
    `, [cutoff, cutoff, batchSize], 'site_loop_runs');
    deleted.classification_observations = deletePruneBatch(store.db, `
      SELECT rowid FROM site_loop_classification_observations
      WHERE observed_at < ?
      LIMIT ?
    `, [cutoff, batchSize], 'site_loop_classification_observations');
    deleted.acknowledged_escalations = deletePruneBatch(store.db, `
      SELECT rowid FROM site_loop_escalations
      WHERE created_at < ? AND status = 'acknowledged'
      LIMIT ?
    `, [cutoff, batchSize], 'site_loop_escalations');
    deleted.directive_outcomes = deletePruneBatch(store.db, `
      SELECT rowid FROM directive_outcomes
      WHERE recorded_at < ?
        AND outcome_id NOT IN (SELECT outcome_id FROM directive_outcome_latest)
      LIMIT ?
    `, [cutoff, batchSize], 'directive_outcomes');
    store.db.exec('COMMIT');
  } catch (error) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
  const evidence = evidenceStore
    ? pruneSiteLoopEvidence(evidenceStore, now, {
        maxFiles: maxEvidenceFiles,
        cursor: meta?.evidence_prune_cursor ?? null,
      })
    : { deleted_count: 0, scanned_count: 0, complete: true, next_cursor: null };
  store.db.prepare(`
    UPDATE site_loop_storage_meta
    SET last_pruned_at = ?, evidence_prune_cursor = ?
    WHERE storage_id = 1
  `).run(now.toISOString(), evidence.next_cursor);
  return {
    schema: 'narada.site_loop.persistence_prune.v1',
    cutoff,
    summary_retention_days: summaryRetentionDays,
    deleted,
    raw_evidence_deleted_count: evidence.deleted_count,
    raw_evidence_scanned_count: evidence.scanned_count,
    raw_evidence_scan_complete: evidence.complete,
    next_evidence_cursor: evidence.next_cursor,
  };
}

function deletePruneBatch(db: SiteLoopDatabase, rowidQuery: string, params: unknown[], table: string): number {
  const rows: Array<{ rowid: unknown }> = db.prepare(rowidQuery).all(...params)
    .map((row) => ({ rowid: row.rowid }));
  if (rows.length === 0) return 0;
  const placeholders = rows.map(() => '?').join(', ');
  return Number(db.prepare(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`).run(...rows.map(({ rowid }) => rowid)).changes ?? 0);
}

export function reconcileStaleLoopRuns(store: SiteLoopStore, {
  loopId,
  activeRunId = null,
  staleAfterMs = 5 * 60 * 1000,
  now = new Date(),
}: StaleLoopRunReconciliationOptions = {}) {
  const finalStaleAfterMs = Math.max(1, Number(staleAfterMs));
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - finalStaleAfterMs).toISOString();
  const rows: any = store.db.prepare(`
    SELECT run_id, loop_id, started_at, evidence_ref
    FROM site_loop_runs
    WHERE loop_id = ?
      AND status = 'running'
      AND started_at <= ?
      AND (? IS NULL OR run_id <> ?)
    ORDER BY started_at ASC
  `).all(loopId, staleBefore, activeRunId, activeRunId);
  const recoveredRuns: any[] = [];
  const update: any = store.db.prepare(`
    UPDATE site_loop_runs
    SET status = 'abandoned',
        finished_at = ?,
        summary_json = ?,
        error_json = ?,
        evidence_ref = ?,
        evidence_sha256 = ?,
        evidence_bytes = ?
    WHERE run_id = ? AND status = 'running'
  `);
  for (const row of rows) {
    const recovery: any = {
      schema: 'narada.site_operating_loop.stale_run_recovery.v1',
      kind: 'stale_loop_run_recovered',
      loop_id: String(row.loop_id),
      run_id: String(row.run_id),
      started_at: String(row.started_at),
      recovered_at: nowIso,
      stale_before: staleBefore,
      active_run_id: activeRunId,
    };
    const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'stale_loop_run_recovery', recovery, {
      loop_id: row.loop_id,
      run_id: row.run_id,
    });
    let result: any;
    try {
      result = update.run(
        nowIso,
        stringifyJson(storedSummary({ stale_run_recovery: recovery }, storedEvidence.evidence?.ref ?? null, store)),
        stringifyJson(storedSummary(recovery, storedEvidence.evidence?.ref ?? null, store)),
        storedEvidence.evidence?.ref ?? null,
        storedEvidence.evidence?.sha256 ?? null,
        storedEvidence.evidence?.compressed_bytes ?? null,
        row.run_id,
      );
    } catch (error) {
      cleanupStoredEvidence(store, storedEvidence);
      throw error;
    }
    if (Number(result.changes ?? 0) === 1) {
      cleanupEvidenceRef(store, row.evidence_ref ?? null);
      recoveredRuns.push(recovery);
    }
  }
  return {
    schema: 'narada.site_operating_loop.stale_run_reconciliation.v1',
    status: 'ok',
    loop_id: loopId,
    active_run_id: activeRunId,
    stale_before: staleBefore,
    recovered_count: recoveredRuns.length,
    recovered_runs: recoveredRuns,
  };
}

export function recordLoopStep(store: SiteLoopStore, step: JsonObject) {
  const inputRefs: any[] = Array.isArray(step.input_refs) ? step.input_refs : [];
  const outputRefs: any[] = Array.isArray(step.output_refs) ? step.output_refs : [];
  const payload: any = {
    input_refs: inputRefs,
    output_refs: outputRefs,
    evidence: step.evidence ?? null,
    error: step.error ?? null,
  };
  const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'step_run', payload, {
    run_id: step.run_id,
    step_run_id: step.step_run_id,
    step_id: step.step_id,
  }, {
    forceEvidence: inputRefs.length > 0 || outputRefs.length > 0,
  });
  const summary: any = {
    evidence: boundedSiteLoopSummary(step.evidence ?? null, storedEvidence.evidence?.ref ?? null),
    error: boundedSiteLoopSummary(step.error ?? null, storedEvidence.evidence?.ref ?? null),
  };
  try {
    store.db.prepare(`
      INSERT INTO site_loop_step_runs (
        step_run_id, run_id, step_id, status, started_at, finished_at,
        input_ref_count, output_ref_count, input_refs_digest, output_refs_digest,
        summary_json, evidence_ref, evidence_sha256, evidence_bytes, error_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      step.step_run_id,
      step.run_id,
      step.step_id,
      step.status,
      step.started_at,
      step.finished_at,
      inputRefs.length,
      outputRefs.length,
      hashStable(inputRefs),
      hashStable(outputRefs),
      stringifyJson(summary),
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
      stringifyJson(summary.error),
    );
  } catch (error) {
    cleanupStoredEvidence(store, storedEvidence);
    throw error;
  }
}

export function listLoopRuns(store: SiteLoopStore, { limit = 10, loopId = null } : any= {}) {
  const rows: any = loopId
    ? store.db.prepare(`
        SELECT * FROM site_loop_runs
        WHERE loop_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      `).all(loopId, limit)
    : store.db.prepare(`
        SELECT * FROM site_loop_runs
        ORDER BY started_at DESC
        LIMIT ?
      `).all(limit);
  return rows.map((row: any) => parseRunRow(row, store, false));
}

export function getLoopRun(store: SiteLoopStore, runId: string, { hydrate = true }: { hydrate?: boolean } = {}) {
  const run = sqliteRecord(store.db.prepare('SELECT * FROM site_loop_runs WHERE run_id = ?').get(runId));
  if (!run) return null;
  const steps: any = store.db.prepare(`
    SELECT * FROM site_loop_step_runs
    WHERE run_id = ?
    ORDER BY rowid ASC
  `).all(runId).map((row: any) => parseStepRow(row, store, hydrate));
  return { ...parseRunRow(run, store, hydrate), steps };
}

export function getLoopStatus(store: SiteLoopStore, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID } : any= {}) {
  const latest: any = store.db.prepare(`
    SELECT * FROM site_loop_runs
    WHERE loop_id = ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(loopId);
  const counts: any = store.db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM site_loop_runs
    WHERE loop_id = ?
    GROUP BY status
  `).all(loopId);
  return {
    schema: 'narada.site_operating_loop.status.v1',
    loop_id: loopId,
    latest: latest ? parseRunRow(latest, store, false) : null,
    counts: Object.fromEntries(counts.map((row: any) => [row.status, row.count])),
    health: getLoopHealth(store, loopId),
    lock: getLoopLock(store, loopId),
    control: getLoopControl(store, loopId),
    attention: getLoopAttentionSummary(store, { loopId }),
    directive_outcomes: getDirectiveOutcomeSummary(store, { loopId }),
    runtime_host: hasTable(store.db, 'site_loop_runtime_hosts')
      ? getCanonicalSiteOperatingLoopRuntimeHost({ db: store.db }, loopId)
      : null,
  };
}

function hasTable(db: SiteLoopDatabase, name: any) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name));
}

export function getLoopControl(store: SiteLoopStore, loopId: string) {
  const row: any = store.db.prepare('SELECT * FROM site_loop_control WHERE loop_id = ?').get(loopId);
  if (!row) {
    return {
      schema: 'narada.site_operating_loop.control.v1',
      loop_id: loopId,
      paused: false,
      mode: 'running',
      reason: null,
      updated_at: null,
    };
  }
  return {
    schema: 'narada.site_operating_loop.control.v1',
    loop_id: String(row.loop_id),
    paused: Boolean(row.paused),
    mode: String(row.mode),
    reason: row.reason ? String(row.reason) : null,
    updated_at: String(row.updated_at),
  };
}

export function setLoopControl(store: SiteLoopStore, { loopId, paused = false, mode = paused ? 'paused' : 'running', reason = null, at = new Date().toISOString() }: LoopControlOptions = {}) {
  const resolvedLoopId = loopId ?? DEFAULT_SITE_OPERATING_LOOP_ID;
  store.db.prepare(`
    INSERT INTO site_loop_control (loop_id, paused, mode, reason, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(loop_id) DO UPDATE SET
      paused = excluded.paused,
      mode = excluded.mode,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `).run(resolvedLoopId, paused ? 1 : 0, boundedText(mode, 128), boundedText(reason), at);
  return getLoopControl(store, resolvedLoopId);
}

export function recordLoopClassificationObservation(store: SiteLoopStore, { loopId, directiveId, classification, observation, at = new Date().toISOString() }: LoopClassificationOptions = {}) {
  const observationId = `loopobs_${hashStable({ loopId, directiveId, classification, at }).slice(0, 32)}`;
  const observationRecord: any = observation && typeof observation === 'object' && !Array.isArray(observation)
    ? observation as Record<string, any>
    : {};
  const runId = observationRecord.run_id ? String(observationRecord.run_id) : null;
  const taskId = observationRecord.task_id ? String(observationRecord.task_id) : null;
  const observationDigest = hashStable({ loopId, directiveId, classification, at, observation });
  store.db.prepare(`
    INSERT OR IGNORE INTO site_loop_classification_observations (
      observation_id, loop_id, directive_id, classification, observed_at, run_id, task_id, observation_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(observationId, loopId, directiveId, classification, at, runId, taskId, observationDigest);
  const current: any = store.db.prepare(`
    SELECT observed_at
    FROM site_loop_classification_current
    WHERE loop_id = ? AND directive_id = ?
  `).get(loopId, directiveId);
  if (!current || compareObservationTime(at, current.observed_at) >= 0) {
    store.db.prepare(`
      INSERT INTO site_loop_classification_current (
        loop_id, directive_id, classification, observation_id, observed_at, run_id, task_id, observation_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(loop_id, directive_id) DO UPDATE SET
        classification = excluded.classification,
        observation_id = excluded.observation_id,
        observed_at = excluded.observed_at,
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        observation_digest = excluded.observation_digest
    `).run(loopId, directiveId, classification, observationId, at, runId, taskId, observationDigest);
  }
  return {
    observation_id: observationId,
    loop_id: loopId,
    directive_id: directiveId,
    classification,
    observed_at: at,
    run_id: runId,
    task_id: taskId,
    observation_digest: observationDigest,
  };
}

export function countRecentLoopClassificationObservations(store: SiteLoopStore, { loopId, directiveId, classification, limit = 3 }: LoopClassificationOptions = {}) {
  const rows: any = store.db.prepare(`
    SELECT observation_id
    FROM site_loop_classification_observations
    WHERE loop_id = ? AND directive_id = ? AND classification = ?
    ORDER BY observed_at DESC
    LIMIT ?
  `).all(loopId, directiveId, classification, limit);
  return rows.length;
}

export function countRecentConsecutiveLoopClassificationObservations(store: SiteLoopStore, { loopId, directiveId, classification, limit = 3 }: LoopClassificationOptions = {}) {
  const rows: any = store.db.prepare(`
    SELECT classification
    FROM site_loop_classification_observations
    WHERE loop_id = ? AND directive_id = ?
    ORDER BY observed_at DESC
    LIMIT ?
  `).all(loopId, directiveId, limit);
  let count = 0;
  for (const row of rows) {
    if (String(row.classification) !== classification) break;
    count += 1;
  }
  return count;
}

export function hasLoopClassificationRecoverySince(store: SiteLoopStore, { loopId, directiveId, classification, since }: LoopClassificationRecoveryOptions = {}) {
  if (!since) return false;
  const row: any = store.db.prepare(`
    SELECT 1
    FROM site_loop_classification_observations
    WHERE loop_id = ?
      AND directive_id = ?
      AND observed_at >= ?
      AND classification <> ?
    LIMIT 1
  `).get(loopId, directiveId, since, classification);
  return Boolean(row);
}

export function getLoopEscalation(store: SiteLoopStore, { loopId, directiveId, classification }: LoopEscalationOptions = {}) {
  const row: any = store.db.prepare(`
    SELECT * FROM site_loop_escalations
    WHERE loop_id = ? AND directive_id = ? AND classification = ?
  `).get(loopId, directiveId, classification);
  if (!row) return null;
  const escalation: any = readSiteLoopEvidenceIfAvailable(
    store?.evidenceStore ?? siteLoopEvidenceStoreFromDb(store?.db),
    row.escalation_ref,
  ) ?? parseJson(row.escalation_summary_json);
  return {
    escalation_id: String(row.escalation_id),
    loop_id: String(row.loop_id),
    directive_id: String(row.directive_id),
    classification: String(row.classification),
    status: String(row.status),
    envelope_id: row.envelope_id ? String(row.envelope_id) : null,
    created_at: String(row.created_at),
    acknowledged_at: row.acknowledged_at ? String(row.acknowledged_at) : null,
    acknowledged_by: row.acknowledged_by ? String(row.acknowledged_by) : null,
    ack_reason: row.ack_reason ? String(row.ack_reason) : null,
    escalation,
    escalation_ref: row.escalation_ref ? String(row.escalation_ref) : null,
    escalation_sha256: row.escalation_sha256 ? String(row.escalation_sha256) : null,
    escalation_bytes: row.escalation_bytes == null ? null : Number(row.escalation_bytes),
  };
}

export function recordLoopEscalation(store: SiteLoopStore, { loopId, directiveId, classification, envelopeId, escalation, at = new Date().toISOString() }: LoopEscalationOptions = {}) {
  const escalationId = `loopesc_${hashStable({ loopId, directiveId, classification }).slice(0, 32)}`;
  const previous: any = store.db.prepare(`
    SELECT escalation_ref FROM site_loop_escalations WHERE escalation_id = ?
  `).get(escalationId);
  const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'loop_escalation', escalation ?? {}, {
    loop_id: loopId,
    directive_id: directiveId,
    classification,
    escalation_id: escalationId,
  });
  const escalationSummary = stringifyJson(storedEvidence.summary);
  const alreadyInTransaction = Boolean(store.db.inTransaction);
  if (!alreadyInTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare(`
      INSERT OR IGNORE INTO site_loop_escalations (
        escalation_id, loop_id, directive_id, classification, status, envelope_id, created_at,
        escalation_summary_json, escalation_ref, escalation_sha256, escalation_bytes
      ) VALUES (?, ?, ?, ?, 'opened', ?, ?, ?, ?, ?, ?)
    `).run(
      escalationId,
      loopId,
      directiveId,
      classification,
      envelopeId ?? null,
      at,
      escalationSummary,
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
    );
    const update: any = store.db.prepare(`
      UPDATE site_loop_escalations
      SET envelope_id = COALESCE(envelope_id, ?),
          escalation_summary_json = ?,
          escalation_ref = ?,
          escalation_sha256 = ?,
          escalation_bytes = ?
      WHERE escalation_id = ? AND status = 'opened'
    `).run(
      envelopeId ?? null,
      escalationSummary,
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
      escalationId,
    );
    if (!alreadyInTransaction) store.db.exec('COMMIT');
    if (Number(update.changes ?? 0) === 0) {
      cleanupStoredEvidence(store, storedEvidence);
    } else if (!alreadyInTransaction && previous?.escalation_ref !== storedEvidence.evidence?.ref) {
      cleanupEvidenceRef(store, previous?.escalation_ref ?? null);
    }
  } catch (error) {
    if (!alreadyInTransaction) {
      try {
        store.db.exec('ROLLBACK');
      } catch {
        // Preserve the original persistence error.
      }
    }
    cleanupStoredEvidence(store, storedEvidence);
    throw error;
  }
  return getLoopEscalation(store, { loopId, directiveId, classification });
}

export function reopenLoopEscalation(store: SiteLoopStore, { loopId, directiveId, classification, envelopeId, escalation, at = new Date().toISOString() }: LoopEscalationOptions = {}) {
  const escalationId = `loopesc_${hashStable({ loopId, directiveId, classification }).slice(0, 32)}`;
  const previous: any = store.db.prepare(`
    SELECT escalation_ref FROM site_loop_escalations WHERE escalation_id = ?
  `).get(escalationId);
  const storedEvidence: StoredSiteLoopPayload = recordSiteLoopPayload(store, 'loop_escalation', escalation ?? {}, {
    loop_id: loopId,
    directive_id: directiveId,
    classification,
    escalation_id: escalationId,
  });
  const escalationSummary = stringifyJson(storedEvidence.summary);
  const alreadyInTransaction = Boolean(store.db.inTransaction);
  if (!alreadyInTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    const update: any = store.db.prepare(`
      UPDATE site_loop_escalations
      SET status = 'opened',
          envelope_id = COALESCE(envelope_id, ?),
          escalation_summary_json = ?,
          escalation_ref = ?,
          escalation_sha256 = ?,
          escalation_bytes = ?,
          acknowledged_at = NULL,
          acknowledged_by = NULL,
          ack_reason = NULL
      WHERE escalation_id = ? AND status = 'acknowledged'
    `).run(
      envelopeId ?? null,
      escalationSummary,
      storedEvidence.evidence?.ref ?? null,
      storedEvidence.evidence?.sha256 ?? null,
      storedEvidence.evidence?.compressed_bytes ?? null,
      escalationId,
    );
    if (!alreadyInTransaction) store.db.exec('COMMIT');
    if (Number(update.changes ?? 0) === 0) {
      cleanupStoredEvidence(store, storedEvidence);
    } else if (!alreadyInTransaction && previous?.escalation_ref !== storedEvidence.evidence?.ref) {
      cleanupEvidenceRef(store, previous?.escalation_ref ?? null);
    }
  } catch (error) {
    if (!alreadyInTransaction) {
      try {
        store.db.exec('ROLLBACK');
      } catch {
        // Preserve the original persistence error.
      }
    }
    cleanupStoredEvidence(store, storedEvidence);
    throw error;
  }
  return getLoopEscalation(store, { loopId, directiveId, classification });
}

export function listLoopAttention(store: SiteLoopStore, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID, status = null, limit = 50 } : any= {}) {
  const max = Math.max(1, Math.min(500, Number(limit ?? 50)));
  const clauses = ['loop_id = ?'];
  const params: unknown[] = [loopId];
  const canonicalStatus: any = status === 'open' ? 'opened' : status;
  if (canonicalStatus) {
    clauses.push('status = ?');
    params.push(canonicalStatus);
  }
  params.push(max);
  const rows: any = store.db.prepare(`
    SELECT * FROM site_loop_escalations
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, escalation_id DESC
    LIMIT ?
  `).all(...params);
  return rows.map((row: any) => parseEscalationRow(row, store));
}

export function getLoopAttention(store: SiteLoopStore, { attentionId }: LoopAttentionLookupOptions = {}) {
  const row: any = store.db.prepare(`
    SELECT * FROM site_loop_escalations
    WHERE envelope_id = ? OR escalation_id = ?
    LIMIT 1
  `).get(attentionId, attentionId);
  return row ? parseEscalationRow(row, store) : null;
}

export function acknowledgeLoopAttention(store: SiteLoopStore, {
  attentionId,
  reason,
  acknowledgedBy = 'operator',
  at = new Date().toISOString(),
}: LoopAttentionAckOptions = {}) {
  const existing: any = getLoopAttention(store, { attentionId });
  if (!existing) return { status: 'not_found', attention_id: attentionId };
  store.db.prepare(`
    UPDATE site_loop_escalations
    SET status = 'acknowledged',
        acknowledged_at = ?,
        acknowledged_by = ?,
        ack_reason = ?
    WHERE escalation_id = ?
  `).run(at, boundedText(acknowledgedBy, 256), boundedText(reason), existing.escalation_id);
  return { status: 'acknowledged', attention: getLoopAttention(store, { attentionId }) };
}

export function getLoopAttentionSummary(store: SiteLoopStore, { loopId = DEFAULT_SITE_OPERATING_LOOP_ID } : any= {}) {
  const rows: any = store.db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM site_loop_escalations
    WHERE loop_id = ?
    GROUP BY status
  `).all(loopId);
  const counts: any = Object.fromEntries(rows.map((row: any) => [String(row.status), Number(row.count ?? 0)]));
  const severityRows: any = store.db.prepare(`
    SELECT
      CASE
        WHEN json_valid(escalation_summary_json) THEN COALESCE(
          json_extract(escalation_summary_json, '$.severity'),
          json_extract(escalation_summary_json, '$.fields.severity'),
          'warning'
        )
        ELSE 'warning'
      END AS severity,
      COUNT(*) AS count
    FROM site_loop_escalations
    WHERE loop_id = ? AND status = 'opened'
    GROUP BY severity
  `).all(loopId);
  const openBySeverity: any = {};
  for (const row of severityRows) {
    openBySeverity[String(row.severity ?? 'warning')] = Number(row.count ?? 0);
  }
  return {
    schema: 'narada.site_operating_loop.attention_summary.v1',
    loop_id: loopId,
    counts,
    open_count: Number(counts.opened ?? 0),
    acknowledged_count: Number(counts.acknowledged ?? 0),
    open_by_severity: openBySeverity,
  };
}

export function getLoopUnresolvedBacklogSummary(store: SiteLoopStore, {
  loopId = DEFAULT_SITE_OPERATING_LOOP_ID,
  limit = 25,
} : any= {}) {
  const max = Math.max(1, Math.min(100, Number(limit ?? 25)));
  const unresolvedStatuses = ['received', 'carrier_accepted', 'delivery_stale', 'action_stale', 'blocked_no_carrier'];
  const countRows: any = store.db.prepare(`
    SELECT outcome, COUNT(*) AS count
    FROM directive_outcome_latest
    WHERE loop_id = ? AND outcome IN (${unresolvedStatuses.map(() => '?').join(', ')})
    GROUP BY outcome
  `).all(loopId, ...unresolvedStatuses);
  const counts: Record<string, number> = {};
  let unresolvedCount = 0;
  for (const row of countRows) {
    counts[String(row.outcome)] = Number(row.count ?? 0);
    unresolvedCount += Number(row.count ?? 0);
  }
  const rows: any = store.db.prepare(`
    SELECT directive_id, outcome, observed_at, recorded_at
    FROM directive_outcome_latest
    WHERE loop_id = ? AND outcome IN (${unresolvedStatuses.map(() => '?').join(', ')})
    ORDER BY observed_at DESC, recorded_at DESC
    LIMIT ?
  `).all(loopId, ...unresolvedStatuses, max);
  const unresolved: any = rows
    .map((row: any) => ({
      directive_id: String(row.directive_id),
      status: String(row.outcome),
      observed_at: String(row.observed_at ?? row.recorded_at),
    }));
  return {
    schema: 'narada.site_operating_loop.unresolved_backlog_summary.v1',
    loop_id: loopId,
    unresolved_count: unresolvedCount,
    counts,
    directives: unresolved,
    returned_count: unresolved.length,
    truncated: unresolved.length < unresolvedCount,
  };
}

export function resolveDirectiveOutcome(store: SiteLoopStore, {
  loopId = DEFAULT_SITE_OPERATING_LOOP_ID,
  directiveId,
  reason = 'operator_cleanup',
  resolvedBy = 'operator',
  at = new Date().toISOString(),
}: DirectiveOutcomeResolveOptions = {}) {
  if (!directiveId) {
    return { schema: 'narada.site_operating_loop.directive_outcome_resolve.v1', status: 'refused', reason: 'directive_id_required' };
  }
  const existing: any = getLatestDirectiveOutcome(store, { loopId, directiveId });
  if (!existing) {
    return { schema: 'narada.site_operating_loop.directive_outcome_resolve.v1', status: 'not_found', loop_id: loopId, directive_id: directiveId };
  }
  const outcome: any = recordDirectiveOutcome(store, {
    loopId,
    directiveId,
    outcome: 'superseded',
    agentId: existing.agent_id ?? null,
    taskId: existing.task_id ?? null,
    reportId: existing.report_id ?? null,
    receiptId: existing.receipt_id ?? null,
    reason,
    evidence: {
      schema: 'narada.site_operating_loop.directive_outcome_resolution.v1',
      previous_outcome: existing,
      resolved_by: resolvedBy,
      reason,
    },
    eventAt: at,
    observedAt: at,
    recordedAt: at,
  });
  return {
    schema: 'narada.site_operating_loop.directive_outcome_resolve.v1',
    status: 'resolved',
    loop_id: loopId,
    directive_id: directiveId,
    previous_outcome: existing.outcome,
    outcome,
  };
}

function parseDirectiveOutcomeRow(row: JsonObject, store: SiteLoopStoreOrNull = null) {
  const evidence = readSiteLoopEvidenceIfAvailable(
    store?.evidenceStore ?? siteLoopEvidenceStoreFromDb(store?.db),
    row.evidence_ref,
  ) ?? parseJson(row.evidence_summary_json);
  return {
    schema: 'narada.site_operating_loop.directive_outcome.v1',
    outcome_id: String(row.outcome_id),
    loop_id: String(row.loop_id),
    directive_id: String(row.directive_id),
    outcome: String(row.outcome),
    agent_id: row.agent_id ? String(row.agent_id) : null,
    task_id: row.task_id ? String(row.task_id) : null,
    report_id: row.report_id ? String(row.report_id) : null,
    receipt_id: row.receipt_id ? String(row.receipt_id) : null,
    reason: row.reason ? String(row.reason) : null,
    event_at: row.event_at ? String(row.event_at) : null,
    observed_at: row.observed_at ? String(row.observed_at) : String(row.recorded_at),
    recorded_at: String(row.recorded_at),
    evidence,
    evidence_ref: row.evidence_ref ? String(row.evidence_ref) : null,
    evidence_sha256: row.evidence_sha256 ? String(row.evidence_sha256) : null,
    evidence_bytes: row.evidence_bytes == null ? null : Number(row.evidence_bytes),
  };
}

function upsertDirectiveOutcomeLatest(db: SiteLoopDatabase, row: JsonObject) {
  const existing: any = db.prepare(`
    SELECT outcome, observed_at, recorded_at
    FROM directive_outcome_latest
    WHERE loop_id = ? AND directive_id = ?
  `).get(row.loop_id, row.directive_id);
  if (existing && compareOutcomeLatest(row, existing) < 0) return;
  db.prepare(`
    INSERT INTO directive_outcome_latest (
      loop_id, directive_id, outcome_id, outcome, agent_id, task_id, report_id,
      receipt_id, reason, event_at, observed_at, recorded_at,
      evidence_summary_json, evidence_ref, evidence_sha256, evidence_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(loop_id, directive_id) DO UPDATE SET
      outcome_id = excluded.outcome_id,
      outcome = excluded.outcome,
      agent_id = excluded.agent_id,
      task_id = excluded.task_id,
      report_id = excluded.report_id,
      receipt_id = excluded.receipt_id,
      reason = excluded.reason,
      event_at = excluded.event_at,
      observed_at = excluded.observed_at,
      recorded_at = excluded.recorded_at,
      evidence_summary_json = excluded.evidence_summary_json,
      evidence_ref = excluded.evidence_ref,
      evidence_sha256 = excluded.evidence_sha256,
      evidence_bytes = excluded.evidence_bytes
  `).run(
    row.loop_id,
    row.directive_id,
    row.outcome_id,
    row.outcome,
    row.agent_id ?? null,
    row.task_id ?? null,
    row.report_id ?? null,
    row.receipt_id ?? null,
    row.reason ?? null,
    row.event_at ?? row.recorded_at,
    row.observed_at ?? row.recorded_at,
    row.recorded_at,
    row.evidence_summary_json ?? stringifyJson({}),
    row.evidence_ref ?? null,
    row.evidence_sha256 ?? null,
    row.evidence_bytes ?? null,
  );
}

function compareOutcomeLatest(next: any, existing: JsonObject) {
  const nextObserved = Date.parse(String(next.observed_at ?? next.recorded_at ?? ''));
  const existingObserved = Date.parse(String(existing.observed_at ?? existing.recorded_at ?? ''));
  if (Number.isFinite(nextObserved) && Number.isFinite(existingObserved) && nextObserved !== existingObserved) {
    return nextObserved > existingObserved ? 1 : -1;
  }
  const nextRank = outcomePrecedence(next.outcome);
  const existingRank = outcomePrecedence(existing.outcome);
  if (nextRank !== existingRank) return nextRank > existingRank ? 1 : -1;
  const nextRecorded = Date.parse(String(next.recorded_at ?? ''));
  const existingRecorded = Date.parse(String(existing.recorded_at ?? ''));
  if (Number.isFinite(nextRecorded) && Number.isFinite(existingRecorded) && nextRecorded !== existingRecorded) {
    return nextRecorded > existingRecorded ? 1 : -1;
  }
  return 0;
}

function outcomePrecedence(outcome: any) {
  return {
    pending: 10,
    leased: 20,
    delivery_stale: 30,
    blocked_no_carrier: 35,
    received: 40,
    carrier_accepted: 45,
    action_stale: 50,
    accepted: 60,
    refused: 80,
    reported: 90,
    superseded: 100,
  }[String(outcome)] ?? 0;
}

function parseEscalationRow(row: JsonObject, store: SiteLoopStoreOrNull = null) {
  const escalation: any = readSiteLoopEvidenceIfAvailable(
    store?.evidenceStore ?? siteLoopEvidenceStoreFromDb(store?.db),
    row.escalation_ref,
  ) ?? parseJson(row.escalation_summary_json);
  return {
    schema: 'narada.site_operating_loop.attention.v1',
    attention_id: row.envelope_id ? String(row.envelope_id) : String(row.escalation_id),
    escalation_id: String(row.escalation_id),
    loop_id: String(row.loop_id),
    directive_id: String(row.directive_id),
    classification: String(row.classification),
    status: String(row.status),
    envelope_id: row.envelope_id ? String(row.envelope_id) : null,
    created_at: String(row.created_at),
    acknowledged_at: row.acknowledged_at ? String(row.acknowledged_at) : null,
    acknowledged_by: row.acknowledged_by ? String(row.acknowledged_by) : null,
    ack_reason: row.ack_reason ? String(row.ack_reason) : null,
    severity: escalation?.severity ?? 'warning',
    escalation,
    escalation_ref: row.escalation_ref ? String(row.escalation_ref) : null,
    escalation_sha256: row.escalation_sha256 ? String(row.escalation_sha256) : null,
    escalation_bytes: row.escalation_bytes == null ? null : Number(row.escalation_bytes),
  };
}

function ensureColumn(db: SiteLoopDatabase, table: string, column: any, type: any, repairs : any= null) {
  if (!tableExists(db, table)) return;
  const columns: any = db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => row.name);
  if (columns.includes(column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  repairs?.push({ kind: 'column_added', table, column, type });
}

function tableExists(db: SiteLoopDatabase, table: string) {
  const row: any = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
  return Boolean(row);
}

function readHydratedEvidence(store: SiteLoopStoreOrNull, ref: unknown, kind: string): any {
  if (!ref) return null;
  const evidenceStore = evidenceStoreForStore(store);
  if (!evidenceStore) {
    throw new SiteLoopEvidenceError(`site_loop_evidence_store_unavailable:${kind}`);
  }
  return readSiteLoopEvidence(evidenceStore, String(ref));
}

function parseRunRow(row: JsonObject, store: SiteLoopStoreOrNull = null, hydrate = true) {
  const payload: any = hydrate
    ? readHydratedEvidence(store, row.evidence_ref, 'loop_run')
    : null;
  return {
    run_id: row.run_id,
    loop_id: row.loop_id,
    status: row.status,
    dry_run: Boolean(row.dry_run),
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    summary: payload?.summary ?? parseJson(row.summary_json),
    error: payload?.error ?? parseJson(row.error_json),
    evidence_ref: row.evidence_ref ? String(row.evidence_ref) : null,
    evidence_sha256: row.evidence_sha256 ? String(row.evidence_sha256) : null,
    evidence_bytes: row.evidence_bytes == null ? null : Number(row.evidence_bytes),
    evidence_available: row.evidence_ref ? Boolean(payload) : false,
  };
}

function parseStepRow(row: JsonObject, store: SiteLoopStoreOrNull = null, hydrate = true) {
  const summary: any = parseJson(row.summary_json) ?? {};
  const payload: any = hydrate
    ? readHydratedEvidence(store, row.evidence_ref, 'step_run')
    : null;
  return {
    step_run_id: row.step_run_id,
    run_id: row.run_id,
    step_id: row.step_id,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    input_refs: payload?.input_refs ?? [],
    output_refs: payload?.output_refs ?? [],
    input_ref_count: Number(row.input_ref_count ?? 0),
    output_ref_count: Number(row.output_ref_count ?? 0),
    input_refs_digest: row.input_refs_digest ? String(row.input_refs_digest) : null,
    output_refs_digest: row.output_refs_digest ? String(row.output_refs_digest) : null,
    evidence: payload?.evidence ?? summary.evidence ?? null,
    evidence_summary: summary.evidence ?? null,
    error: payload?.error ?? summary.error ?? parseJson(row.error_json),
    evidence_ref: row.evidence_ref ? String(row.evidence_ref) : null,
    evidence_sha256: row.evidence_sha256 ? String(row.evidence_sha256) : null,
    evidence_bytes: row.evidence_bytes == null ? null : Number(row.evidence_bytes),
    evidence_available: row.evidence_ref ? Boolean(payload) : false,
  };
}

function compareObservationTime(next: any, existing: JsonObject) {
  const nextTime = Date.parse(String(next ?? ''));
  const existingTime = Date.parse(String(existing ?? ''));
  if (Number.isFinite(nextTime) && Number.isFinite(existingTime)) return nextTime - existingTime;
  return String(next ?? '').localeCompare(String(existing ?? ''));
}

function stringifyJson(value: any) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: any) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hashStable(value: any) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
