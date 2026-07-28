import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openTaskLifecycleStoreWithDiscipline } from './sqlite-discipline.js';
import {
  boundedSiteLoopSummary,
} from '../site-operating-loop/site-loop-evidence.js';
import {
  assertSiteLoopStorageSchema,
  compactSiteLoopPersistence,
  ensureSiteLoopStorageIndexes,
  ensureSiteLoopTables,
  asSiteLoopDatabase,
  SITE_LOOP_STORAGE_SCHEMA,
  type SiteLoopPersistenceCompactionResult,
  SiteLoopStorageCutoverRequiredError,
} from '../site-operating-loop/site-loop-store.js';

const LEGACY_TABLES = [
  'site_loop_runs',
  'site_loop_step_runs',
  'site_loop_classification_observations',
  'site_loop_escalations',
  'directive_outcomes',
  'directive_outcome_latest',
];

const OPTIONAL_PARTIAL_TABLES = [
  'site_loop_classification_current',
  'site_loop_locks',
  'site_loop_health',
  'site_loop_control',
];

const PARTIAL_SOURCE_COLUMNS: Record<string, string[]> = {
  site_loop_classification_current: [
    'loop_id', 'directive_id', 'classification', 'observation_id', 'observed_at', 'run_id', 'task_id', 'observation_digest',
  ],
  site_loop_locks: ['loop_id', 'run_id', 'owner_id', 'acquired_at', 'expires_at'],
  site_loop_health: [
    'loop_id', 'status', 'consecutive_failures', 'last_successful_run_id', 'last_success_at',
    'last_run_id', 'last_run_at', 'failing_step', 'last_error_json', 'updated_at',
  ],
  site_loop_control: ['loop_id', 'paused', 'mode', 'reason', 'updated_at'],
};

const RENAMED_SUFFIX = '_pre_cutover';
type SqliteDatabase = ReturnType<typeof openTaskLifecycleStoreWithDiscipline>['db'];
type SqliteRow = Record<string, unknown>;

export type SiteLoopStorageCutoverResult = {
  schema: 'narada.site_loop.storage_cutover.v1';
  status: 'refused' | 'initialized' | 'already_cut_over' | 'cut_over';
  reason?: string;
  cutover_at?: string;
  authoritative_task_state_untouched?: boolean;
  legacy_runs_dropped?: number;
  legacy_steps_dropped?: number;
  current_classifications_rehydrated?: number;
  latest_outcomes_rehydrated?: number;
  escalations_rehydrated?: number;
  locks_reset?: number;
  health_rows_preserved?: number;
  control_rows_preserved?: number;
  partial_tables_dropped?: number;
  partial_rows_dropped?: number;
  compaction?: SiteLoopPersistenceCompactionResult;
};

export function cutoverSiteLoopStorage(
  cwd: string,
  { ackCutover = false }: { ackCutover?: boolean } = {},
): SiteLoopStorageCutoverResult {
  if (!String(cwd ?? '').trim()) {
    throw new Error('site_root_required');
  }
  const siteRoot = resolve(cwd);
  if (!ackCutover) {
    return {
      schema: 'narada.site_loop.storage_cutover.v1',
      status: 'refused',
      reason: 'ack_cutover_required',
    };
  }

  const lifecycleStore = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true });
  try {
    const db = lifecycleStore.db;
    const meta = tableExists(db, 'site_loop_storage_meta')
      ? sqliteRow(db.prepare('SELECT schema, cutover_at FROM site_loop_storage_meta WHERE storage_id = 1').get())
      : null;
    if (meta?.schema === SITE_LOOP_STORAGE_SCHEMA) {
      ensureSiteLoopStorageIndexes(db);
      assertSiteLoopStorageSchema(db);
      return {
        schema: 'narada.site_loop.storage_cutover.v1',
        status: 'already_cut_over',
        cutover_at: String(meta.cutover_at),
        authoritative_task_state_untouched: true,
      };
    }
    if (meta) throw new SiteLoopStorageCutoverRequiredError('storage_meta_mismatch');

    const presentLegacyTables = LEGACY_TABLES.filter((table) => tableExists(db, table));
    const presentPartialTables = OPTIONAL_PARTIAL_TABLES.filter((table) => tableExists(db, table));
    if (presentLegacyTables.length === 0) {
      if (presentPartialTables.length > 0) {
        return cutoverPartialSiteLoopStorage(db, presentPartialTables);
      }
      ensureSiteLoopTables(db);
      const cutoverAt = storageCutoverAt(db);
      return {
        schema: 'narada.site_loop.storage_cutover.v1',
        status: 'initialized',
        cutover_at: cutoverAt,
        authoritative_task_state_untouched: true,
        locks_reset: 0,
      };
    }
    if (presentLegacyTables.length !== LEGACY_TABLES.length) {
      throw new SiteLoopStorageCutoverRequiredError('site_loop_storage_partial');
    }
    assertLegacyShape(db);

    const legacyRunCount = countRows(db, 'site_loop_runs');
    const legacyStepCount = countRows(db, 'site_loop_step_runs');
    const legacyLockCount = tableExists(db, 'site_loop_locks') ? countRows(db, 'site_loop_locks') : 0;
    const renamedTables = [...LEGACY_TABLES, ...OPTIONAL_PARTIAL_TABLES]
      .filter((table) => tableExists(db, table));
    const oldNames = Object.fromEntries(renamedTables.map((table) => [table, `${table}${RENAMED_SUFFIX}`]));
    const previousForeignKeys = Number(firstSqliteValue(db.pragma('foreign_keys')) ?? 0);
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      for (const table of renamedTables) {
        db.prepare(`ALTER TABLE ${table} RENAME TO ${oldNames[table]}`).run();
      }

      ensureSiteLoopTables(db);
      const cutoverAt = storageCutoverAt(db);
      const classifications = rehydrateCurrentClassifications(db, oldNames.site_loop_classification_observations);
      const outcomes = rehydrateLatestOutcomes(
        db,
        oldNames.directive_outcomes,
        oldNames.directive_outcome_latest,
        cutoverAt,
      );
      const escalations = rehydrateEscalations(db, oldNames.site_loop_escalations, cutoverAt);
      const preservedState = rehydratePreservedSiteLoopState(db, oldNames, cutoverAt);
      const locksReset = legacyLockCount;

      for (const table of renamedTables) {
        db.prepare(`DROP TABLE ${oldNames[table]}`).run();
      }
      ensureSiteLoopStorageIndexes(db);
      db.exec('COMMIT');
      committed = true;
      if (previousForeignKeys !== 0) db.pragma('foreign_keys = ON');
      const compaction = compactSiteLoopPersistence({ db: asSiteLoopDatabase(db) });
      return {
        schema: 'narada.site_loop.storage_cutover.v1',
        status: 'cut_over',
        cutover_at: cutoverAt,
        authoritative_task_state_untouched: true,
        legacy_runs_dropped: legacyRunCount,
        legacy_steps_dropped: legacyStepCount,
        current_classifications_rehydrated: classifications,
        latest_outcomes_rehydrated: outcomes,
        escalations_rehydrated: escalations,
        locks_reset: locksReset,
        health_rows_preserved: preservedState.health,
        control_rows_preserved: preservedState.control,
        compaction,
      };
    } catch (error) {
      if (!committed) {
        try {
          db.exec('ROLLBACK');
        } finally {
          if (previousForeignKeys !== 0) db.pragma('foreign_keys = ON');
        }
      } else if (previousForeignKeys !== 0) {
        db.pragma('foreign_keys = ON');
      }
      throw error;
    }
  } finally {
    lifecycleStore.db.close();
  }
}

function cutoverPartialSiteLoopStorage(db: SqliteDatabase, presentPartialTables: string[]): SiteLoopStorageCutoverResult {
  assertPartialSourceShape(db, presentPartialTables);
  const partialRowCounts = Object.fromEntries(
    presentPartialTables.map((table) => [table, countRows(db, table)]),
  ) as Record<string, number>;
  const oldNames = Object.fromEntries(
    presentPartialTables.map((table) => [table, `${table}${RENAMED_SUFFIX}`]),
  );
  const previousForeignKeys = Number(firstSqliteValue(db.pragma('foreign_keys')) ?? 0);
  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    for (const table of presentPartialTables) {
      db.prepare(`ALTER TABLE ${table} RENAME TO ${oldNames[table]}`).run();
    }

    ensureSiteLoopTables(db);
    const cutoverAt = storageCutoverAt(db);
    const classifications = rehydrateCurrentClassificationsFromPartial(db, oldNames.site_loop_classification_current);
    const preservedState = rehydratePreservedSiteLoopState(db, oldNames, cutoverAt);
    const locksReset = partialRowCounts.site_loop_locks ?? 0;
    const partialRowsDropped = Object.values(partialRowCounts).reduce((sum, count) => sum + count, 0);

    for (const table of presentPartialTables) {
      db.prepare(`DROP TABLE ${oldNames[table]}`).run();
    }
    ensureSiteLoopStorageIndexes(db);
    db.exec('COMMIT');
    committed = true;
    if (previousForeignKeys !== 0) db.pragma('foreign_keys = ON');
    const compaction = compactSiteLoopPersistence({ db: asSiteLoopDatabase(db) });
    return {
      schema: 'narada.site_loop.storage_cutover.v1',
      status: 'cut_over',
      cutover_at: cutoverAt,
      authoritative_task_state_untouched: true,
      legacy_runs_dropped: 0,
      legacy_steps_dropped: 0,
      current_classifications_rehydrated: classifications,
      latest_outcomes_rehydrated: 0,
      escalations_rehydrated: 0,
      locks_reset: locksReset,
      health_rows_preserved: preservedState.health,
      control_rows_preserved: preservedState.control,
      partial_tables_dropped: presentPartialTables.length,
      partial_rows_dropped: partialRowsDropped,
      compaction,
    };
  } catch (error) {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } finally {
        if (previousForeignKeys !== 0) db.pragma('foreign_keys = ON');
      }
    } else if (previousForeignKeys !== 0) {
      db.pragma('foreign_keys = ON');
    }
    throw error;
  }
}

function assertPartialSourceShape(db: SqliteDatabase, presentPartialTables: string[]): void {
  for (const table of presentPartialTables) {
    const requiredColumns = PARTIAL_SOURCE_COLUMNS[table] ?? [];
    const actualColumns = tableColumns(db, table);
    if (requiredColumns.some((column) => !actualColumns.includes(column))) {
      throw new SiteLoopStorageCutoverRequiredError(`partial_shape_mismatch:${table}`);
    }
  }
}

function rehydrateCurrentClassificationsFromPartial(db: SqliteDatabase, legacyTable?: string): number {
  if (!legacyTable) return 0;
  const insert = db.prepare(`
    INSERT INTO site_loop_classification_current (
      loop_id, directive_id, classification, observation_id, observed_at, run_id, task_id, observation_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const rawRow of db.prepare(`
    SELECT loop_id, directive_id, classification, observation_id, observed_at, run_id, task_id, observation_digest
    FROM ${legacyTable}
    ORDER BY rowid ASC
  `).all()) {
    const row = sqliteRow(rawRow);
    insert.run(
      boundedText(row.loop_id),
      boundedText(row.directive_id),
      boundedText(row.classification),
      boundedText(row.observation_id),
      row.observed_at,
      boundedText(row.run_id),
      boundedText(row.task_id),
      boundedText(row.observation_digest),
    );
    count += 1;
  }
  return count;
}

function assertLegacyShape(db: SqliteDatabase): void {
  const expected: Record<string, string[]> = {
    site_loop_step_runs: ['input_refs_json', 'output_refs_json', 'evidence_json'],
    site_loop_classification_observations: ['observation_json'],
    site_loop_escalations: ['escalation_json'],
    directive_outcomes: ['evidence_json'],
    directive_outcome_latest: ['evidence_json'],
  };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = tableColumns(db, table);
    if (columns.some((column) => !actual.includes(column))) {
      throw new SiteLoopStorageCutoverRequiredError(`legacy_shape_mismatch:${table}`);
    }
  }
}

function rehydrateCurrentClassifications(db: SqliteDatabase, legacyTable: string): number {
  const latest = new Map<string, SqliteRow>();
  for (const rawRow of db.prepare(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY loop_id, directive_id
        ORDER BY observed_at DESC, rowid DESC
      ) AS cutover_rank
      FROM ${legacyTable}
    )
    WHERE cutover_rank = 1
  `).all()) {
    const row = sqliteRow(rawRow);
    const observation = parseJson(row.observation_json);
    const record = observation && typeof observation === 'object' && !Array.isArray(observation)
      ? observation as SqliteRow
      : {};
    const candidate = {
      loop_id: String(row.loop_id),
      directive_id: String(row.directive_id),
      classification: String(row.classification),
      observation_id: String(row.observation_id),
      observed_at: String(row.observed_at),
      run_id: record.run_id ? String(record.run_id) : null,
      task_id: record.task_id ? String(record.task_id) : null,
      observation_digest: hashStable({
        loop_id: row.loop_id,
        directive_id: row.directive_id,
        classification: row.classification,
        observed_at: row.observed_at,
        observation,
      }),
    };
    const key = `${candidate.loop_id}\u0000${candidate.directive_id}`;
    const current = latest.get(key);
    if (!current || compareTimes(candidate.observed_at, current.observed_at) >= 0) latest.set(key, candidate);
  }
  const insert = db.prepare(`
    INSERT INTO site_loop_classification_current (
      loop_id, directive_id, classification, observation_id, observed_at, run_id, task_id, observation_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of latest.values()) {
    insert.run(
      row.loop_id,
      row.directive_id,
      row.classification,
      row.observation_id,
      row.observed_at,
      row.run_id,
      row.task_id,
      row.observation_digest,
    );
  }
  return latest.size;
}

function rehydrateLatestOutcomes(
  db: SqliteDatabase,
  legacyOutcomesTable: string,
  legacyLatestTable: string,
  cutoverAt: string,
): number {
  const latest = new Map<string, SqliteRow>();
  for (const rawRow of db.prepare(`SELECT * FROM ${legacyLatestTable} ORDER BY rowid ASC`).all()) {
    const row = sqliteRow(rawRow);
    latest.set(`${row.loop_id}\u0000${row.directive_id}`, row);
  }
  if (latest.size === 0) {
    for (const rawRow of db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY loop_id, directive_id
          ORDER BY COALESCE(observed_at, recorded_at) DESC, recorded_at DESC, rowid DESC
        ) AS cutover_rank
        FROM ${legacyOutcomesTable}
      )
      WHERE cutover_rank = 1
    `).all()) {
      const row = sqliteRow(rawRow);
      const key = `${row.loop_id}\u0000${row.directive_id}`;
      const current = latest.get(key);
      if (!current || compareOutcomeRows(row, current) >= 0) latest.set(key, row);
    }
  }

  const insertOutcome = db.prepare(`
    INSERT INTO directive_outcomes (
      outcome_id, loop_id, directive_id, outcome, agent_id, task_id, report_id, receipt_id,
      reason, event_at, observed_at, recorded_at, evidence_summary_json,
      evidence_ref, evidence_sha256, evidence_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `);
  const insertLatest = db.prepare(`
    INSERT INTO directive_outcome_latest (
      loop_id, directive_id, outcome_id, outcome, agent_id, task_id, report_id, receipt_id,
      reason, event_at, observed_at, recorded_at, evidence_summary_json,
      evidence_ref, evidence_sha256, evidence_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `);
  for (const row of latest.values()) {
    const evidence = parseJson(row.evidence_json);
    const summary = stringifyJson(boundedSiteLoopSummary(evidence, null, 16_384) ?? {});
    const observedAt = row.observed_at ?? row.recorded_at ?? cutoverAt;
    const eventAt = row.event_at ?? observedAt;
    const values = [
      String(row.outcome_id), String(row.loop_id), String(row.directive_id), String(row.outcome),
      row.agent_id ?? null, row.task_id ?? null, row.report_id ?? null, row.receipt_id ?? null,
      row.reason ?? null, eventAt, observedAt, cutoverAt, summary,
    ];
    insertOutcome.run(...values);
    insertLatest.run(
      String(row.loop_id), String(row.directive_id), String(row.outcome_id), String(row.outcome),
      row.agent_id ?? null, row.task_id ?? null, row.report_id ?? null, row.receipt_id ?? null,
      row.reason ?? null, eventAt, observedAt, cutoverAt, summary,
    );
  }
  return latest.size;
}

function rehydrateEscalations(db: SqliteDatabase, legacyTable: string, cutoverAt: string): number {
  const insert = db.prepare(`
    INSERT INTO site_loop_escalations (
      escalation_id, loop_id, directive_id, classification, status, envelope_id, created_at,
      acknowledged_at, acknowledged_by, ack_reason, escalation_summary_json,
      escalation_ref, escalation_sha256, escalation_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `);
  let count = 0;
  for (const rawRow of db.prepare(`SELECT * FROM ${legacyTable} ORDER BY rowid ASC`).all()) {
    const row = sqliteRow(rawRow);
    const escalation = parseJson(row.escalation_json);
    insert.run(
      String(row.escalation_id),
      String(row.loop_id),
      String(row.directive_id),
      String(row.classification),
      String(row.status),
      row.envelope_id ?? null,
      row.created_at ?? cutoverAt,
      row.acknowledged_at ?? null,
      row.acknowledged_by ?? null,
      row.ack_reason ?? null,
      stringifyJson(boundedSiteLoopSummary(escalation, null, 16_384) ?? {}),
    );
    count += 1;
  }
  return count;
}

function rehydratePreservedSiteLoopState(
  db: SqliteDatabase,
  oldNames: Record<string, string>,
  cutoverAt: string,
): { health: number; control: number } {
  let health = 0;
  let control = 0;
  if (oldNames.site_loop_health) {
    const insert = db.prepare(`
      INSERT INTO site_loop_health (
        loop_id, status, consecutive_failures, last_successful_run_id, last_success_at,
        last_run_id, last_run_at, failing_step, last_error_json,
        last_error_evidence_ref, last_error_evidence_sha256, last_error_evidence_bytes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `);
    for (const rawRow of db.prepare(`SELECT * FROM ${oldNames.site_loop_health} ORDER BY rowid ASC`).all()) {
      const row = sqliteRow(rawRow);
      insert.run(
        boundedText(row.loop_id),
        boundedText(row.status),
        Math.max(0, Number(row.consecutive_failures ?? 0)),
        boundedText(row.last_successful_run_id),
        row.last_success_at ?? null,
        boundedText(row.last_run_id),
        row.last_run_at ?? null,
        boundedText(row.failing_step),
        boundedLegacyJson(row.last_error_json),
        row.updated_at ?? cutoverAt,
      );
      health += 1;
    }
  }
  if (oldNames.site_loop_control) {
    const insert = db.prepare(`
      INSERT INTO site_loop_control (loop_id, paused, mode, reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const rawRow of db.prepare(`SELECT * FROM ${oldNames.site_loop_control} ORDER BY rowid ASC`).all()) {
      const row = sqliteRow(rawRow);
      insert.run(
        boundedText(row.loop_id),
        Number(row.paused) ? 1 : 0,
        boundedText(row.mode, 128),
        boundedText(row.reason),
        row.updated_at ?? cutoverAt,
      );
      control += 1;
    }
  }
  return { health, control };
}

function storageCutoverAt(db: SqliteDatabase): string {
  const row = sqliteRow(db.prepare('SELECT cutover_at FROM site_loop_storage_meta WHERE storage_id = 1').get());
  return String(row.cutover_at);
}

function countRows(db: SqliteDatabase, table: string): number {
  const row = sqliteRow(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
  return Number(row?.count ?? 0);
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(table));
}

function tableColumns(db: SqliteDatabase, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(sqliteRow(row).name));
}

function sqliteRow(value: unknown): SqliteRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sqlite_row_expected');
  }
  return value as SqliteRow;
}

function firstSqliteValue(value: unknown): unknown {
  if (Array.isArray(value)) return firstSqliteValue(value[0]);
  if (value && typeof value === 'object') return Object.values(value as SqliteRow)[0] ?? null;
  return value;
}

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function boundedText(value: unknown, maxBytes = 2048): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = text.slice(0, maxBytes);
  while (Buffer.byteLength(`${result}...`, 'utf8') > maxBytes && result.length > 0) result = result.slice(0, -1);
  return `${result}...`;
}

function boundedLegacyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    parsed = { schema: 'narada.site_loop.legacy_json_summary.v1', value_type: 'invalid_json' };
  }
  const summary = boundedSiteLoopSummary(parsed, null, 16_384);
  return summary === null ? null : stringifyJson(summary);
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareTimes(next: unknown, existing: unknown): number {
  const nextTime = Date.parse(String(next ?? ''));
  const existingTime = Date.parse(String(existing ?? ''));
  if (Number.isFinite(nextTime) && Number.isFinite(existingTime)) return nextTime - existingTime;
  return String(next ?? '').localeCompare(String(existing ?? ''));
}

function compareOutcomeRows(next: SqliteRow, existing: SqliteRow): number {
  const observed = compareTimes(next.observed_at ?? next.recorded_at, existing.observed_at ?? existing.recorded_at);
  if (observed !== 0) return observed;
  return compareTimes(next.recorded_at, existing.recorded_at);
}

export function parseSiteLoopStorageCutoverCliArgs(argv: string[]) {
  let siteRoot: string | null = null;
  let ackCutover = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      return { help: true, siteRoot, ackCutover };
    }
    if (arg === '--ack-cutover') {
      ackCutover = true;
    } else if (arg === '--site-root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('site_root_value_required');
      siteRoot = value;
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return { help: false, siteRoot, ackCutover };
}

function printCliHelp() {
  console.log('Usage: site-loop-storage-cutover --site-root <path> --ack-cutover');
  console.log('Performs the irreversible Site Loop v3 hard cutover under the task-lifecycle write lock.');
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseSiteLoopStorageCutoverCliArgs(process.argv.slice(2));
    if (args.help) {
      printCliHelp();
    } else if (!args.siteRoot) {
      throw new Error('site_root_required');
    } else {
      const result = cutoverSiteLoopStorage(args.siteRoot, { ackCutover: args.ackCutover });
      console.log(JSON.stringify(result));
      if (result.status === 'refused') process.exitCode = 2;
    }
  } catch (error: unknown) {
    console.error(JSON.stringify({
      schema: 'narada.site_loop.storage_cutover.v1',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 2;
  }
}
