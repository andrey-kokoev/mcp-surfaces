import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cutoverSiteLoopStorage,
  parseSiteLoopStorageCutoverCliArgs,
} from '../src/task-lifecycle/site-loop-storage-cutover.js';
import {
  parseSiteLoopStorageMaintenanceCliArgs,
  runSiteLoopStorageMaintenance,
} from '../src/task-lifecycle/site-loop-storage-maintenance.js';
import {
  compactSiteLoopPersistence,
  pruneSiteLoopPersistence,
} from '../src/site-operating-loop/site-loop-store.js';
import { openTaskLifecycleStoreWithDiscipline } from '../src/task-lifecycle/sqlite-discipline.js';
import { openSiteLoopStore } from '../src/site-loop/site-loop-store.js';

function sqliteRow(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const siteRoot = mkdtempSync(join(tmpdir(), 'site-loop-storage-cutover-'));
mkdirSync(join(siteRoot, '.narada', 'capabilities'), { recursive: true });
mkdirSync(join(siteRoot, '.ai', 'state'), { recursive: true });
writeFileSync(join(siteRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v2',
  loop_id: 'cutover.test.loop',
  site_id: 'narada-cutover-test',
  display_name: 'Cutover test loop',
  resident: { agent_id: 'resident', role: 'resident' },
}, null, 2), 'utf8');

const store = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true, storeMode: 'prepare' });
store.db.exec(`
  CREATE TABLE site_loop_runs (
    run_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, status TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT,
    summary_json TEXT, error_json TEXT
  );
  CREATE TABLE site_loop_step_runs (
    step_run_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
    status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    input_refs_json TEXT, output_refs_json TEXT, evidence_json TEXT, error_json TEXT
  );
  CREATE TABLE site_loop_classification_observations (
    observation_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, directive_id TEXT NOT NULL,
    classification TEXT NOT NULL, observed_at TEXT NOT NULL, observation_json TEXT
  );
  CREATE TABLE site_loop_escalations (
    escalation_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, directive_id TEXT NOT NULL,
    classification TEXT NOT NULL, status TEXT NOT NULL, envelope_id TEXT,
    created_at TEXT NOT NULL, acknowledged_at TEXT, acknowledged_by TEXT, ack_reason TEXT,
    escalation_json TEXT, UNIQUE(loop_id, directive_id, classification)
  );
  CREATE TABLE directive_outcomes (
    outcome_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL, directive_id TEXT NOT NULL,
    outcome TEXT NOT NULL, agent_id TEXT, task_id TEXT, report_id TEXT, receipt_id TEXT,
    reason TEXT, event_at TEXT, observed_at TEXT, recorded_at TEXT NOT NULL, evidence_json TEXT
  );
  CREATE TABLE directive_outcome_latest (
    loop_id TEXT NOT NULL, directive_id TEXT NOT NULL, outcome_id TEXT NOT NULL,
    outcome TEXT NOT NULL, agent_id TEXT, task_id TEXT, report_id TEXT, receipt_id TEXT,
    reason TEXT, event_at TEXT, observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
    evidence_json TEXT, PRIMARY KEY(loop_id, directive_id)
  );
  CREATE TABLE site_loop_locks (
    loop_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    stale_recovery_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  );
`);
store.db.exec(`CREATE INDEX idx_site_loop_runs_loop_started ON site_loop_runs(loop_id, started_at)`);
store.db.exec(`
  CREATE TABLE site_loop_health (
    loop_id TEXT PRIMARY KEY, status TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_successful_run_id TEXT, last_success_at TEXT, last_run_id TEXT, last_run_at TEXT,
    failing_step TEXT, last_error_json TEXT, updated_at TEXT NOT NULL, lifecycle_json TEXT
  );
  CREATE TABLE site_loop_control (
    loop_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'running',
    reason TEXT, updated_at TEXT NOT NULL
  );
`);
store.db.prepare(`
  INSERT INTO site_loop_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run('old_run', 'cutover.test.loop', 'ok', 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:01:00.000Z', '{"old":true}', null);
store.db.prepare(`
  INSERT INTO site_loop_step_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('old_step', 'old_run', 'giant_step', 'ok', '2025-01-01T00:00:01.000Z', '2025-01-01T00:00:02.000Z', '[]', '[]', JSON.stringify({ raw: 'x'.repeat(80_000) }), null);
store.db.prepare(`INSERT INTO site_loop_classification_observations VALUES (?, ?, ?, ?, ?, ?)`)
  .run('old_obs_1', 'cutover.test.loop', 'directive-1', 'delivery_stale', '2025-01-01T00:00:00.000Z', '{"task_id":"task-1"}');
store.db.prepare(`INSERT INTO site_loop_classification_observations VALUES (?, ?, ?, ?, ?, ?)`)
  .run('old_obs_2', 'cutover.test.loop', 'directive-1', 'recovered', '2025-01-02T00:00:00.000Z', '{"task_id":"task-1"}');
store.db.prepare(`INSERT INTO site_loop_escalations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('old_escalation', 'cutover.test.loop', 'directive-1', 'delivery_stale', 'opened', 'attention-1', '2025-01-01T00:00:00.000Z', null, null, null, '{"severity":"warning","old":"x"}');
store.db.prepare(`INSERT INTO directive_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('old_outcome', 'cutover.test.loop', 'directive-1', 'accepted', null, 'task-1', null, null, null, '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '{"old":"evidence"}');
store.db.prepare(`INSERT INTO directive_outcome_latest VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('cutover.test.loop', 'directive-1', 'old_outcome', 'accepted', null, 'task-1', null, null, null, '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z', '{"old":"evidence"}');
store.db.prepare(`INSERT INTO site_loop_locks VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run('cutover.test.loop', 'old_run', 'old-owner', '2025-01-01T00:00:00.000Z', '2025-01-01T01:00:00.000Z', 0, '2025-01-01T00:00:00.000Z');
store.db.prepare(`INSERT INTO site_loop_health VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('cutover.test.loop', 'degraded', 2, 'old_run_success', '2025-01-02T00:00:00.000Z', 'old_run', '2025-01-03T00:00:00.000Z', 'dispatch', '{"message":"old health"}', '2025-01-03T00:00:00.000Z', '{"state":"old"}');
store.db.prepare(`INSERT INTO site_loop_control VALUES (?, ?, ?, ?, ?)`)
  .run('cutover.test.loop', 1, 'paused', 'operator hold', '2025-01-03T00:00:00.000Z');
store.db.prepare(`CREATE TABLE cutover_task_state (id TEXT PRIMARY KEY, state TEXT NOT NULL)`).run();
store.db.prepare(`INSERT INTO cutover_task_state VALUES ('authoritative-1', 'preserved')`).run();
store.db.close();

assert.throws(
  () => openSiteLoopStore(siteRoot, { write: false }),
  /site_loop_storage_cutover_required/,
);
const refused = cutoverSiteLoopStorage(siteRoot);
assert.equal(refused.status, 'refused');
const result = cutoverSiteLoopStorage(siteRoot, { ackCutover: true });
assert.equal(result.status, 'cut_over');
assert.equal(result.legacy_runs_dropped, 1);
assert.equal(result.legacy_steps_dropped, 1);
assert.equal(result.current_classifications_rehydrated, 1);
assert.equal(result.latest_outcomes_rehydrated, 1);
assert.equal(result.escalations_rehydrated, 1);
assert.equal(result.locks_reset, 1);
assert.equal(result.health_rows_preserved, 1);
assert.equal(result.control_rows_preserved, 1);
assert.equal(result.compaction?.status, 'compacted');
assert.ok(Number(result.compaction?.after_bytes) <= Number(result.compaction?.before_bytes));

const after = openSiteLoopStore(siteRoot, { write: false });
assert.equal(sqliteRow(after.db.prepare(`SELECT COUNT(*) AS count FROM site_loop_runs`).get()).count, 0);
assert.equal(sqliteRow(after.db.prepare(`SELECT COUNT(*) AS count FROM site_loop_step_runs`).get()).count, 0);
assert.equal(sqliteRow(after.db.prepare(`SELECT COUNT(*) AS count FROM site_loop_classification_observations`).get()).count, 0);
assert.equal(sqliteRow(after.db.prepare(`SELECT classification FROM site_loop_classification_current`).get()).classification, 'recovered');
assert.equal(sqliteRow(after.db.prepare(`SELECT status FROM site_loop_health`).get()).status, 'degraded');
assert.equal(sqliteRow(after.db.prepare(`SELECT consecutive_failures FROM site_loop_health`).get()).consecutive_failures, 2);
assert.equal(sqliteRow(after.db.prepare(`SELECT paused FROM site_loop_control`).get()).paused, 1);
assert.equal(sqliteRow(after.db.prepare(`SELECT mode FROM site_loop_control`).get()).mode, 'paused');
assert.equal(sqliteRow(after.db.prepare(`SELECT reason FROM site_loop_control`).get()).reason, 'operator hold');
assert.equal(sqliteRow(after.db.prepare(`SELECT outcome FROM directive_outcome_latest`).get()).outcome, 'accepted');
assert.equal(sqliteRow(after.db.prepare(`SELECT COUNT(*) AS count FROM site_loop_locks`).get()).count, 0);
assert.equal(sqliteRow(after.db.prepare(`SELECT state FROM cutover_task_state`).get()).state, 'preserved');
assert.equal(after.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'site_loop_step_runs_pre_cutover'`).get(), undefined);
after.close();

const already = cutoverSiteLoopStorage(siteRoot, { ackCutover: true });
assert.equal(already.status, 'already_cut_over');

assert.deepEqual(
  parseSiteLoopStorageCutoverCliArgs(['--site-root', siteRoot, '--ack-cutover']),
  { help: false, siteRoot, ackCutover: true },
);
assert.throws(
  () => parseSiteLoopStorageCutoverCliArgs(['--unknown']),
  /unknown_argument/,
);
assert.throws(
  () => parseSiteLoopStorageCutoverCliArgs(['--site-root']),
  /site_root_value_required/,
);
assert.deepEqual(
  parseSiteLoopStorageMaintenanceCliArgs(['--site-root', siteRoot, '--ack-maintenance']),
  { help: false, siteRoot, ackMaintenance: true, compact: false },
);
assert.deepEqual(
  parseSiteLoopStorageMaintenanceCliArgs(['--site-root', siteRoot, '--ack-maintenance', '--compact']),
  { help: false, siteRoot, ackMaintenance: true, compact: true },
);
assert.equal(runSiteLoopStorageMaintenance(siteRoot).status, 'refused');
assert.equal(runSiteLoopStorageMaintenance(siteRoot, { ackMaintenance: true }).status, 'pruned');
const maintenanceCompaction = runSiteLoopStorageMaintenance(siteRoot, {
  ackMaintenance: true,
  compact: true,
});
assert.equal(maintenanceCompaction.status, 'pruned');
assert.ok('compaction' in maintenanceCompaction);
assert.equal(maintenanceCompaction.compaction?.status, 'compacted');

const noBackfillBefore = openSiteLoopStore(siteRoot, { write: true });
const latestBefore = Number(sqliteRow(noBackfillBefore.db.prepare(
  `SELECT COUNT(*) AS count FROM directive_outcome_latest`,
).get()).count);
noBackfillBefore.db.prepare(`
  INSERT INTO directive_outcomes (
    outcome_id, loop_id, directive_id, outcome, agent_id, task_id, report_id, receipt_id,
    reason, event_at, observed_at, recorded_at, evidence_summary_json
  ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
`).run(
  'no_latest_outcome',
  'cutover.test.loop',
  'no-latest-directive',
  'accepted',
  '2025-01-03T00:00:00.000Z',
  '2025-01-03T00:00:00.000Z',
  '2025-01-03T00:00:00.000Z',
  '{}',
);
noBackfillBefore.close();
const noBackfillAfter = openSiteLoopStore(siteRoot, { write: false });
assert.equal(
  Number(sqliteRow(noBackfillAfter.db.prepare(`SELECT COUNT(*) AS count FROM directive_outcome_latest`).get()).count),
  latestBefore,
);
assert.equal(
  noBackfillAfter.db.prepare(`
    SELECT 1 FROM directive_outcome_latest WHERE directive_id = 'no-latest-directive'
  `).get(),
  undefined,
);
noBackfillAfter.close();

const pruneStore = openSiteLoopStore(siteRoot, { write: true });
for (const suffix of ['a', 'b']) {
  const runId = `old_prune_run_${suffix}`;
  pruneStore.db.prepare(`
    INSERT INTO site_loop_runs (
      run_id, loop_id, status, dry_run, started_at, finished_at, summary_json, error_json
    ) VALUES (?, ?, 'ok', 0, ?, ?, '{}', NULL)
  `).run(runId, 'cutover.test.loop', '2025-01-03T00:00:00.000Z', '2025-01-03T00:01:00.000Z');
  pruneStore.db.prepare(`
    INSERT INTO site_loop_step_runs (
      step_run_id, run_id, step_id, status, started_at, finished_at,
      input_ref_count, output_ref_count, summary_json, error_json
    ) VALUES (?, ?, 'old-step', 'ok', ?, ?, 0, 0, '{}', NULL)
  `).run(`old_prune_step_${suffix}`, runId, '2025-01-03T00:00:01.000Z', '2025-01-03T00:00:02.000Z');
}
const firstPrune = pruneSiteLoopPersistence(
  pruneStore,
  new Date('2026-07-26T00:00:00.000Z'),
  { maxRows: 1, maxEvidenceFiles: 1 },
);
assert.equal(firstPrune.deleted.step_runs, 1);
assert.equal(firstPrune.deleted.runs, 1);
const secondPrune = pruneSiteLoopPersistence(
  pruneStore,
  new Date('2026-07-26T00:00:00.000Z'),
  { maxRows: 1, maxEvidenceFiles: 1 },
);
assert.equal(secondPrune.deleted.step_runs, 1);
assert.equal(secondPrune.deleted.runs, 1);
assert.equal(sqliteRow(pruneStore.db.prepare(`SELECT COUNT(*) AS count FROM site_loop_runs WHERE run_id LIKE 'old_prune_run_%'`).get()).count, 0);
pruneStore.db.exec(`CREATE TABLE compaction_fixture (payload TEXT)`);
pruneStore.db.prepare(`INSERT INTO compaction_fixture VALUES (?)`).run('x'.repeat(1_000_000));
pruneStore.db.prepare(`DELETE FROM compaction_fixture`).run();
const compacted = compactSiteLoopPersistence(pruneStore);
assert.equal(compacted.status, 'compacted');
assert.ok(compacted.after_bytes < compacted.before_bytes);
pruneStore.db.exec('BEGIN IMMEDIATE');
assert.throws(
  () => compactSiteLoopPersistence(pruneStore),
  /site_loop_persistence_compaction_transaction_active/,
);
pruneStore.db.exec('ROLLBACK');
pruneStore.close();

const partialRoot = mkdtempSync(join(tmpdir(), 'site-loop-storage-partial-'));
mkdirSync(join(partialRoot, '.narada', 'capabilities'), { recursive: true });
writeFileSync(join(partialRoot, '.narada', 'capabilities', 'site-loop-config.json'), JSON.stringify({
  schema: 'narada.site_loop.config.v2',
  loop_id: 'partial.test.loop',
  site_id: 'narada-partial-test',
  display_name: 'Partial test loop',
  resident: { agent_id: 'resident', role: 'resident' },
}, null, 2), 'utf8');
const partialStore = openTaskLifecycleStoreWithDiscipline(partialRoot, { write: true, storeMode: 'prepare' });
partialStore.db.exec(`
  CREATE TABLE site_loop_classification_current (
    loop_id TEXT NOT NULL, directive_id TEXT NOT NULL, classification TEXT NOT NULL,
    observation_id TEXT NOT NULL, observed_at TEXT NOT NULL, run_id TEXT, task_id TEXT,
    observation_digest TEXT NOT NULL, PRIMARY KEY (loop_id, directive_id)
  );
  CREATE TABLE site_loop_locks (
    loop_id TEXT NOT NULL, run_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE site_loop_health (
    loop_id TEXT PRIMARY KEY, status TEXT NOT NULL, consecutive_failures INTEGER NOT NULL,
    last_successful_run_id TEXT, last_success_at TEXT, last_run_id TEXT, last_run_at TEXT,
    failing_step TEXT, last_error_json TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE site_loop_control (
    loop_id TEXT PRIMARY KEY, paused INTEGER NOT NULL, mode TEXT NOT NULL,
    reason TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE partial_task_state (id TEXT PRIMARY KEY, state TEXT NOT NULL);
`);
partialStore.db.prepare(`
  INSERT INTO site_loop_classification_current
    (loop_id, directive_id, classification, observation_id, observed_at, run_id, task_id, observation_digest)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run('partial.test.loop', 'directive-1', 'recovered', 'observation-1', '2025-01-01T00:00:00.000Z', 'run-1', 'task-1', 'digest-1');
partialStore.db.prepare(`INSERT INTO site_loop_locks VALUES (?, ?, ?, ?, ?)`).run(
  'partial.test.loop', 'run-1', 'owner-1', '2025-01-01T00:00:00.000Z', '2025-01-01T01:00:00.000Z',
);
partialStore.db.prepare(`
  INSERT INTO site_loop_health
    (loop_id, status, consecutive_failures, last_successful_run_id, last_success_at, last_run_id, last_run_at, failing_step, last_error_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('partial.test.loop', 'degraded', 1, 'run-0', '2025-01-01T00:00:00.000Z', 'run-1', '2025-01-01T00:01:00.000Z', 'dispatch', '{"old":true}', '2025-01-01T00:01:00.000Z');
partialStore.db.prepare(`INSERT INTO site_loop_control VALUES (?, ?, ?, ?, ?)`).run(
  'partial.test.loop', 1, 'paused', 'operator hold', '2025-01-01T00:02:00.000Z',
);
partialStore.db.prepare(`INSERT INTO partial_task_state VALUES (?, ?)`).run('authoritative-1', 'preserved');
partialStore.db.close();

const partialResult = cutoverSiteLoopStorage(partialRoot, { ackCutover: true });
assert.equal(partialResult.status, 'cut_over');
assert.equal(partialResult.current_classifications_rehydrated, 1);
assert.equal(partialResult.health_rows_preserved, 1);
assert.equal(partialResult.control_rows_preserved, 1);
assert.equal(partialResult.locks_reset, 1);
assert.equal(partialResult.partial_tables_dropped, 4);
assert.equal(partialResult.partial_rows_dropped, 4);
const partialAfter = openTaskLifecycleStoreWithDiscipline(partialRoot, { write: false });
assert.equal(sqliteRow(partialAfter.db.prepare(`SELECT state FROM partial_task_state`).get()).state, 'preserved');
assert.equal(sqliteRow(partialAfter.db.prepare(`SELECT classification FROM site_loop_classification_current`).get()).classification, 'recovered');
assert.equal(sqliteRow(partialAfter.db.prepare(`SELECT status FROM site_loop_health`).get()).status, 'degraded');
assert.equal(sqliteRow(partialAfter.db.prepare(`SELECT paused FROM site_loop_control`).get()).paused, 1);
assert.equal(Number(sqliteRow(partialAfter.db.prepare(`SELECT COUNT(*) AS count FROM site_loop_locks`).get()).count), 0);
assert.equal(partialAfter.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'site_loop_health_pre_cutover'`).get(), undefined);
assert.equal(sqliteRow(partialAfter.db.prepare(`SELECT schema FROM site_loop_storage_meta`).get()).schema, 'narada.site_loop.storage.v3');
partialAfter.db.close();

const malformed = openTaskLifecycleStoreWithDiscipline(siteRoot, { write: true });
malformed.db.exec('DROP TABLE site_loop_classification_current');
malformed.db.close();
assert.throws(
  () => cutoverSiteLoopStorage(siteRoot, { ackCutover: true }),
  /site_loop_storage_partial/,
);
console.log('site-loop storage hard cutover ok');
