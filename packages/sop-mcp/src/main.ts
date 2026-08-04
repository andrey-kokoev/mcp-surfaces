#!/usr/bin/env node
import { buildGuidanceResult } from './guidance.js';
import { guidanceToolDefinition } from './guidance.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from '@narada-core/sqlite';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import { Ajv } from 'ajv';
import {
  MAX_INLINE_VALUE_BYTES,
  MAX_RUN_STATE_BYTES,
  MAX_TEMPLATE_DEFINITION_BYTES,
  assertInlineValue,
  assertSerializedBound,
  canonicalJson,
  collectStepReferences,
  deterministicId,
  evaluateCondition,
  fingerprint,
  isJsonObject,
  normalizeCondition,
  normalizeValueRef,
  resolveMapping,
  validateDag,
  validateMappingReferences,
  validateStepReferences,
  type Condition,
  type JsonValue,
  type ValueContext,
  type ValueRef,
} from './procedure-contract.js';
import {
  SOP_HANDOFF_EXECUTORS,
  SOP_HANDOFF_STATUSES,
  SOP_TERMINAL_TOPIC,
  acknowledgeSopOutbox,
  cancelSopHandoffsForRun,
  claimSopHandoff,
  compactSopOutbox,
  completeSopHandoff,
  ensureSopHandoff,
  getSopHandoff,
  listSopHandoffs,
  listSopOutbox,
  prepareSopDurabilitySchema,
  publicSopHandoff,
  putSopTerminalOutbox,
  reopenSopTerminalOutboxForRetry,
  registerSopOutboxConsumer,
  releaseSopHandoff,
  renewSopHandoff,
  sopDurabilityStats,
} from './durability.js';

const DEFAULT_SERVER_NAME = 'sop-mcp';
const SERVER_VERSION = '0.2.0';
const PROTOCOL_VERSION = '2024-11-05';

const TEMPLATE_STATUSES = ['draft', 'active', 'deprecated'] as const;
const TRIGGER_KINDS = ['manual', 'inbox_event', 'schedule'] as const;
const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'awaiting_confirmation'] as const;
const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STEP_EXECUTORS = ['engine', 'agent', 'operator', 'sop', 'action'] as const;
const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
const STEP_TERMINAL = new Set(['completed', 'failed', 'skipped']);
const ACTION_STATUSES = ['pending', 'completed', 'failed', 'cancelled'] as const;

type JsonRecord = Record<string, unknown>;

type SopState = {
  sopRoot: string;
  db: DatabaseSync;
  serverName: string;
  sopsDirs: string[];
  transactionDepth: number;
  reconciling: boolean;
  startupReconciliationErrors: JsonRecord[];
};

type ActionBinding = {
  surface_id: string;
  tool_name: string;
  arguments: JsonValue;
  idempotency_key_argument: string;
};

type SopTemplate = {
  schema: string;
  render_mode: string;
  full_step_definitions_path: string;
  sop_id: string;
  version: number;
  title: string;
  status: string;
  description: string;
  steps: SopStep[];
  trigger_kind: string;
  input_schema: JsonRecord | null;
  output: JsonValue | null;
  output_ref: JsonValue | null;
  output_schema: JsonRecord | null;
  acceptance_criteria: string[];
  evidence_requirements: string[];
  created_at: string;
  updated_at: string;
};

type SopStep = {
  id: string;
  executor: string;
  blocking: boolean;
  title: string;
  depends_on: string[];
  instructions: string;
  when: Condition | null;
  input: JsonValue | null;
  input_ref: JsonValue | null;
  result_schema: JsonRecord | null;
  action: ActionBinding | null;
  sop_id: string | null;
  sop_version: number | null;
  wait_policy: string | null;
  legacy_command: string | null;
};

type SopRun = {
  run_id: string;
  sop_id: string;
  sop_version: number;
  sop_title: string;
  status: string;
  occurrence_key: string;
  request_fingerprint: string;
  definition_fingerprint: string;
  definition: JsonRecord;
  input: JsonValue;
  input_ref: ValueRef | null;
  output: JsonValue;
  output_ref: ValueRef | null;
  step_states: SopStepState[];
  step_states_parse_error?: string | null;
  trigger_source_kind: string;
  trigger_source_ref: string;
  triggered_by: string;
  parent_run_id: string | null;
  parent_step_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type SopStepState = {
  step_id: string;
  executor: string;
  blocking: boolean;
  title: string;
  status: string;
  depends_on: string[];
  instructions: string;
  when: Condition | null;
  input: JsonValue | null;
  input_ref: JsonValue | null;
  result_schema: JsonRecord | null;
  action: ActionBinding | null;
  sop_id: string | null;
  sop_version: number | null;
  wait_policy: string | null;
  pinned_child_definition_fingerprint: string | null;
  child_run_id: string | null;
  action_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: JsonRecord;
  result_ref: ValueRef | null;
  completion_key: string | null;
  completion_fingerprint: string | null;
  error_message: string | null;
};

type SopAction = {
  schema: 'narada.sop.action.v1';
  action_id: string;
  run_id: string;
  step_id: string;
  occurrence_key: string;
  surface_id: string;
  tool_name: string;
  arguments: JsonRecord;
  request_fingerprint: string;
  status: string;
  completion_key: string | null;
  completion_fingerprint: string | null;
  operation_ref: string | null;
  result: JsonRecord;
  result_ref: ValueRef | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type SopEvent = {
  event_id: string;
  run_id: string;
  step_id: string;
  event_kind: string;
  details: JsonRecord;
  recorded_at: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_SOPS_DIR = resolve(__dirname, '..', '..', 'sops');

const ajv = new Ajv({ allErrors: true });
const SCHEMA_PATH = resolve(DEFAULT_SOPS_DIR, 'sop-template.schema.json');
const validateYamlSchema: ReturnType<typeof ajv.compile> = (() => {
  try {
    return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
  } catch (error) {
    throw new Error(`sop_schema_load_failed:${SCHEMA_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
})();

const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS sop_templates (
    sop_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    description TEXT NOT NULL DEFAULT '',
    steps_json TEXT NOT NULL DEFAULT '[]',
    trigger_kind TEXT NOT NULL DEFAULT 'manual',
    input_schema_json TEXT,
    output_mapping_json TEXT,
    output_ref_mapping_json TEXT,
    output_schema_json TEXT,
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
    evidence_requirements_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (sop_id, version)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sop_runs (
    run_id TEXT PRIMARY KEY,
    sop_id TEXT NOT NULL,
    sop_version INTEGER NOT NULL,
    sop_title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    occurrence_key TEXT NOT NULL DEFAULT '',
    request_fingerprint TEXT NOT NULL DEFAULT '',
    definition_fingerprint TEXT NOT NULL DEFAULT '',
    definition_json TEXT NOT NULL DEFAULT '{}',
    input_json TEXT NOT NULL DEFAULT '{}',
    input_ref_json TEXT,
    output_json TEXT NOT NULL DEFAULT '{}',
    output_ref_json TEXT,
    step_states_json TEXT NOT NULL DEFAULT '[]',
    trigger_source_kind TEXT NOT NULL DEFAULT 'manual',
    trigger_source_ref TEXT NOT NULL DEFAULT '',
    triggered_by TEXT NOT NULL DEFAULT '',
    parent_run_id TEXT,
    parent_step_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sop_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    recorded_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS sop_actions (
    action_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    surface_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    completion_key TEXT,
    completion_fingerprint TEXT,
    operation_ref TEXT,
    result_json TEXT NOT NULL DEFAULT '{}',
    result_ref_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (run_id, step_id),
    UNIQUE (occurrence_key)
  ) STRICT`,
];

export function createServerState(options: JsonRecord = {}): SopState {
  const sopRoot = resolve(String(options.sopRoot ?? options.outputRoot ?? process.cwd()));
  const dbPath = resolve(sopRoot, '.sop', 'sop.db');
  const dbDir = resolve(dbPath, '..');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  for (const sql of CREATE_TABLES) db.exec(sql);
  migrateDatabase(db);
  prepareSopDurabilitySchema(db);
  const sopsDirs: string[] = [];
  if (Array.isArray(options.sopsDirs)) {
    for (const d of options.sopsDirs as string[]) sopsDirs.push(resolve(String(d)));
  } else if (options.sopsDir) {
    sopsDirs.push(resolve(String(options.sopsDir)));
  }
  if (sopsDirs.length === 0) sopsDirs.push(DEFAULT_SOPS_DIR);
  const state: SopState = {
    sopRoot,
    db,
    serverName: String(options.serverName || DEFAULT_SERVER_NAME),
    sopsDirs,
    transactionDepth: 0,
    reconciling: false,
    startupReconciliationErrors: [],
  };
  reconcileActiveRuns(state);
  return state;
}

function sopHandoffRetry(args: JsonRecord, state: SopState): JsonRecord {
  return inTransaction(state, () => {
    const handoffId = requiredString(args.handoff_id, 'sop_handoff_id_required');
    const principal = boundedString(args.principal, 'sop_handoff_retry_principal_required', 512);
    const reason = boundedString(args.reason, 'sop_handoff_retry_reason_required', 4096);
    const handoff = getSopHandoff(state.db, handoffId);
    if (handoff.status === 'pending' || handoff.status === 'leased') {
      return {
        ...runResult(getRunById(handoff.run_id, state)),
        handoff: publicSopHandoff(handoff),
        retry_replayed: true,
      };
    }
    if (handoff.status !== 'failed') {
      throw diagnosticError('sop_handoff_retry_requires_failed', `sop_handoff_retry_requires_failed:${handoffId}`, { status: handoff.status });
    }
    if (handoff.executor !== 'agent') {
      throw diagnosticError('sop_handoff_retry_agent_only', `sop_handoff_retry_agent_only:${handoffId}`, { executor: handoff.executor });
    }
    const run = getRunById(handoff.run_id, state);
    if (run.step_states_parse_error) throw diagnosticError('sop_run_corrupt', `sop_run_corrupt:${run.run_id}`, { reason: run.step_states_parse_error });
    const step = run.step_states.find((candidate) => candidate.step_id === handoff.step_id);
    if (!step || step.executor !== 'agent' || step.status !== 'failed' || !step.completion_fingerprint) {
      throw diagnosticError('sop_handoff_retry_state_conflict', `sop_handoff_retry_state_conflict:${handoffId}`, {
        run_id: run.run_id,
        step_id: handoff.step_id,
        run_status: run.status,
        step_status: step?.status ?? null,
      });
    }
    if (step.completion_fingerprint !== handoff.completion_fingerprint) {
      throw diagnosticError('sop_handoff_retry_completion_conflict', `sop_handoff_retry_completion_conflict:${handoffId}`, { run_id: run.run_id, step_id: handoff.step_id });
    }
    let reopenedOutbox: { event_id: string | null; reopened: boolean };
    try {
      reopenedOutbox = reopenSopTerminalOutboxForRetry(state.db, run.run_id);
    } catch (error) {
      const diagnostic = errorDiagnostic(error);
      if (diagnostic.code !== 'sop_outbox_retry_requires_new_run') throw error;
      return retryFailedHandoffAsNewRun(state, { handoff, run, principal, reason, diagnostic });
    }
    const now = nowIso();
    const resetStepIds = resetRetryableDependentSteps(run, step.step_id);
    const retryMarker = `worker_retryable:reopened:${reason}`.slice(0, 4096);
    state.db.prepare(`
      UPDATE sop_handoffs
         SET status = 'pending', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             completion_key = NULL, completion_fingerprint = NULL, principal = NULL,
             result_json = '{}', result_ref_json = NULL, error_message = NULL,
             last_error = ?, updated_at = ?, completed_at = NULL
       WHERE handoff_id = ? AND status = 'failed'
    `).run(retryMarker, now, handoffId);
    step.status = 'running';
    step.started_at = now;
    step.completed_at = null;
    step.result = { handoff_id: handoff.handoff_id, handoff_occurrence_key: handoff.occurrence_key };
    step.result_ref = null;
    step.completion_key = null;
    step.completion_fingerprint = null;
    step.error_message = null;
    run.status = 'awaiting_confirmation';
    run.output = {};
    run.output_ref = null;
    run.completed_at = null;
    persistRunState(run, state);
    appendRunEvent(state, run.run_id, step.step_id, 'handoff_reopened', {
      handoff_id: handoff.handoff_id,
      principal,
      reason,
      retry_marker: retryMarker,
      reset_step_ids: resetStepIds,
      reopened_outbox_event_id: reopenedOutbox.event_id,
    });
    reconcileRunAndAncestors(run.run_id, state);
    return {
      ...runResult(getRunById(run.run_id, state)),
      handoff: publicSopHandoff(getSopHandoff(state.db, handoffId)),
      retry_replayed: false,
    };
  });
}

function retryFailedHandoffAsNewRun(
  state: SopState,
  input: { handoff: ReturnType<typeof getSopHandoff>; run: SopRun; principal: string; reason: string; diagnostic: ReturnType<typeof errorDiagnostic> },
): JsonRecord {
  const occurrenceKey = deterministicId('sop_retry_', input.handoff.handoff_id);
  const admitted = admitRun({
    sop_id: input.run.sop_id,
    sop_version: input.run.sop_version,
    occurrence_key: occurrenceKey,
    input: input.run.input,
    input_ref: input.run.input_ref,
    trigger_source_kind: 'manual',
    trigger_source_ref: `sop_handoff_retry:${input.handoff.handoff_id}`,
    triggered_by: 'sop-handoff-retry',
  }, state, { parent_run_id: null, parent_step_id: null });
  reconcileRunAndAncestors(admitted.run.run_id, state);
  const retryRun = getRunById(admitted.run.run_id, state);
  const retryHandoffRow = state.db.prepare('SELECT handoff_id FROM sop_handoffs WHERE run_id = ? AND step_id = ?').get(retryRun.run_id, input.handoff.step_id) as JsonRecord | undefined;
  const retryHandoff = retryHandoffRow ? getSopHandoff(state.db, String(retryHandoffRow.handoff_id)) : null;
  if (admitted.admission === 'created') {
    appendRunEvent(state, input.run.run_id, input.handoff.step_id, 'handoff_retry_spawned', {
      handoff_id: input.handoff.handoff_id,
      principal: input.principal,
      reason: input.reason,
      retry_run_id: retryRun.run_id,
      retry_handoff_id: retryHandoff?.handoff_id ?? null,
      retry_occurrence_key: occurrenceKey,
      original_outbox_event_id: input.diagnostic.details.event_id ?? null,
      original_outbox_preserved: true,
    });
  }
  return {
    ...runResult(retryRun, admitted.admission),
    handoff: retryHandoff ? publicSopHandoff(retryHandoff) : null,
    retry_replayed: admitted.admission === 'replayed',
    retry_mode: 'new_run',
    retry_of_run_id: input.run.run_id,
    retry_of_handoff_id: input.handoff.handoff_id,
    retry_reason: input.reason,
    original_outbox_preserved: true,
  };
}

function resetRetryableDependentSteps(run: SopRun, rootStepId: string): string[] {
  const reset = new Set([rootStepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of run.step_states) {
      if (reset.has(candidate.step_id) || candidate.status !== 'failed' || !candidate.error_message?.startsWith('failed_dependency:')) continue;
      if (!candidate.depends_on.some((dependency) => reset.has(dependency))) continue;
      candidate.status = 'pending';
      candidate.started_at = null;
      candidate.completed_at = null;
      candidate.result = {};
      candidate.result_ref = null;
      candidate.completion_key = null;
      candidate.completion_fingerprint = null;
      candidate.error_message = null;
      candidate.child_run_id = null;
      candidate.action_id = null;
      candidate.pinned_child_definition_fingerprint = null;
      reset.add(candidate.step_id);
      changed = true;
    }
  }
  return [...reset].filter((stepId) => stepId !== rootStepId);
}

function assertRunStepDefinitionsMatch(runId: string, definition: JsonRecord, stepStates: SopStepState[]): void {
  if (!Array.isArray(definition.steps)) throw diagnosticError('sop_definition_steps_invalid', `sop_definition_steps_invalid:${runId}`, { run_id: runId });
  const definitionSteps = definition.steps.map((step) => migrateStep(asRecord(step)));
  validateDag(definitionSteps);
  validateStepReferences(definitionSteps);
  if (definitionSteps.length !== stepStates.length) {
    throw diagnosticError('sop_run_step_definition_mismatch', `sop_run_step_definition_mismatch:${runId}`, { run_id: runId, reason: 'step_count' });
  }
  for (let index = 0; index < definitionSteps.length; index += 1) {
    const expected = definitionSteps[index];
    const actual = stepStates[index];
    const expectedProjection: JsonRecord = {
      step_id: expected.id,
      executor: expected.executor,
      blocking: expected.blocking,
      title: expected.title,
      depends_on: expected.depends_on,
      instructions: expected.instructions,
      when: expected.when,
      input: expected.input,
      input_ref: expected.input_ref,
      result_schema: expected.result_schema,
      action: expected.action,
      sop_id: expected.sop_id,
      wait_policy: expected.wait_policy,
    };
    const actualProjection: JsonRecord = {
      step_id: actual.step_id,
      executor: actual.executor,
      blocking: actual.blocking,
      title: actual.title,
      depends_on: actual.depends_on,
      instructions: actual.instructions,
      when: actual.when,
      input: actual.input,
      input_ref: actual.input_ref,
      result_schema: actual.result_schema,
      action: actual.action,
      sop_id: actual.sop_id,
      wait_policy: actual.wait_policy,
    };
    if (expected.executor !== 'sop' || expected.sop_version !== null) {
      expectedProjection.sop_version = expected.sop_version;
      actualProjection.sop_version = actual.sop_version;
    }
    if (canonicalJson(expectedProjection) !== canonicalJson(actualProjection)) {
      throw diagnosticError('sop_run_step_definition_mismatch', `sop_run_step_definition_mismatch:${runId}:${actual.step_id}`, {
        run_id: runId,
        step_id: actual.step_id,
      });
    }
    if (actual.executor === 'sop') {
      if (!Number.isInteger(actual.sop_version) || Number(actual.sop_version) < 1 || !/^[a-f0-9]{64}$/.test(actual.pinned_child_definition_fingerprint ?? '')) {
        throw diagnosticError('sop_child_definition_pin_invalid', `sop_child_definition_pin_invalid:${runId}:${actual.step_id}`, { run_id: runId, step_id: actual.step_id });
      }
    } else if (actual.pinned_child_definition_fingerprint !== null) {
      throw diagnosticError('sop_child_definition_pin_invalid', `sop_child_definition_pin_invalid:${runId}:${actual.step_id}`, { run_id: runId, step_id: actual.step_id });
    }
  }
}

function completeStepWithBoundedRunState(
  run: SopRun,
  step: SopStepState,
  completedAt: string,
  fullResult: JsonRecord,
  resultRef: ValueRef | null,
  compactResult: JsonRecord,
  state: SopState,
): boolean {
  step.status = 'completed';
  step.completed_at = completedAt;
  step.error_message = null;
  step.result = fullResult;
  step.result_ref = resultRef;
  try {
    assertSerializedBound(run.step_states, 'sop_run_state', MAX_RUN_STATE_BYTES);
    return true;
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    if (diagnostic.code !== 'sop_run_state_too_large') throw error;
    failStep(step, `${diagnostic.code}:${diagnostic.message}`);
    step.result = { ...compactResult, inline_result_omitted: true };
    step.result_ref = resultRef;
    assertSerializedBound(run.step_states, 'sop_run_state', MAX_RUN_STATE_BYTES);
    appendRunEvent(state, run.run_id, step.step_id, 'step_failed', { diagnostic, result_ref: resultRef, inline_result_omitted: true });
    return false;
  }
}

function actionResolutionRunView(runId: string, state: SopState): JsonRecord {
  try {
    return runResult(getRunById(runId, state));
  } catch (error) {
    const row = state.db.prepare('SELECT run_id, sop_id, sop_version, status, occurrence_key, updated_at FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
    return { ...(row ?? { run_id: runId }), unavailable: true, diagnostic: errorDiagnostic(error) };
  }
}

function migrateDatabase(db: DatabaseSync): void {
  const ensureColumn = (table: string, column: string, declaration: string): void => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as JsonRecord[];
    if (!columns.some((entry) => String(entry.name) === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  };
  ensureColumn('sop_templates', 'input_schema_json', 'TEXT');
  ensureColumn('sop_templates', 'output_mapping_json', 'TEXT');
  ensureColumn('sop_templates', 'output_ref_mapping_json', 'TEXT');
  ensureColumn('sop_templates', 'output_schema_json', 'TEXT');
  ensureColumn('sop_runs', 'occurrence_key', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('sop_runs', 'request_fingerprint', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('sop_runs', 'definition_fingerprint', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('sop_runs', 'definition_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('sop_runs', 'input_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('sop_runs', 'input_ref_json', 'TEXT');
  ensureColumn('sop_runs', 'output_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('sop_runs', 'output_ref_json', 'TEXT');
  ensureColumn('sop_runs', 'parent_run_id', 'TEXT');
  ensureColumn('sop_runs', 'parent_step_id', 'TEXT');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sop_runs_occurrence_unique ON sop_runs (sop_id, occurrence_key) WHERE occurrence_key <> ''");
  db.exec('CREATE INDEX IF NOT EXISTS sop_runs_status_idx ON sop_runs (status, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS sop_runs_parent_idx ON sop_runs (parent_run_id, parent_step_id)');
  db.exec('CREATE INDEX IF NOT EXISTS sop_actions_status_idx ON sop_actions (status, created_at)');
}

export function closeServerState(state: SopState): void {
  state.db.close();
}

export async function handleRequest(request: JsonRecord, state: SopState) {
  if (!request.id && typeof request.method === 'string' && request.method.startsWith('notifications/')) return null;
  try {
    const result = await dispatchMethod(String(request.method), asRecord(request.params), state);
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    const diagnostic = errorDiagnostic(error);
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: diagnostic.message, data: diagnostic } };
  }
}

const VALUE_REF_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: 'Opaque immutable reference owned by another surface.' },
    sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'Digest pin for the referenced bytes.' },
    byte_length: { type: 'integer', minimum: 0 },
    media_type: { type: 'string' },
  },
  required: ['ref', 'sha256'],
  additionalProperties: false,
};

const CONDITION_TOOL_SCHEMA = {
  type: 'object',
  description: 'Deterministic predicate. Use a leaf {ref,op,value?}, or one of all/any/not containing predicates.',
  properties: {
    ref: { type: 'string', description: 'input.*, input_ref.*, steps.<dependency>.status/result/result_ref.*' },
    op: { type: 'string', enum: ['equals', 'not_equals', 'exists', 'not_exists', 'truthy', 'falsy', 'in', 'contains'] },
    value: {},
    all: { type: 'array', minItems: 1, items: { type: 'object' } },
    any: { type: 'array', minItems: 1, items: { type: 'object' } },
    not: { type: 'object' },
  },
  additionalProperties: false,
};

function stepToolSchema(): JsonRecord {
  return {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Stable step identifier.' },
      executor: { type: 'string', enum: STEP_EXECUTORS, description: 'engine is a pure internal transition; agent/operator await governed completion; sop starts a pinned child occurrence; action emits a governed domain-MCP intent.' },
      blocking: { type: 'boolean', description: 'Only agent/operator steps may block for sop_run_advance; other executor kinds have fixed semantics.' },
      title: { type: 'string' },
      depends_on: { type: 'array', items: { type: 'string' }, description: 'Predecessor step IDs in this procedure DAG.' },
      instructions: { type: 'string', description: 'Bounded human/model-facing handoff instructions.' },
      when: CONDITION_TOOL_SCHEMA,
      input: { description: 'JSON mapping for a child SOP input; exact {$ref:"..."} objects preserve referenced value types.' },
      input_ref: { description: 'JSON mapping that resolves to an immutable value-ref for a child SOP.' },
      result_schema: { type: 'object', description: 'Optional JSON Schema applied to a successful step inline result.' },
      action: {
        type: 'object',
        properties: {
          surface_id: { type: 'string', description: 'Owning domain MCP surface.' },
          tool_name: { type: 'string', description: 'Owning domain MCP effect tool.' },
          arguments: { type: 'object', description: 'Mapped exact argument object persisted before handoff.' },
          idempotency_key_argument: { type: 'string', description: 'Target argument into which SOP injects the stable action occurrence key.' },
        },
        required: ['surface_id', 'tool_name', 'arguments', 'idempotency_key_argument'],
        additionalProperties: false,
      },
      sop_id: { type: 'string', description: 'For sop steps: child SOP identifier.' },
      sop_version: { type: 'integer', minimum: 1, description: 'Optional child version; omitted versions are resolved and pinned at parent admission.' },
      wait_policy: { type: 'string', enum: ['wait'] },
    },
    required: ['id', 'executor', 'title', 'instructions'],
    additionalProperties: false,
  };
}

function templateSummary(template: SopTemplate): JsonRecord {
  return {
    schema: 'narada.sop.template_summary.v2',
    sop_id: template.sop_id,
    version: template.version,
    title: template.title,
    status: template.status,
    description: template.description,
    trigger_kind: template.trigger_kind,
    step_count: template.steps.length,
    updated_at: template.updated_at,
  };
}

function hydrateAction(row: JsonRecord): SopAction {
  const actionId = requiredString(row.action_id, 'sop_action_corrupt');
  const runId = requiredString(row.run_id, 'sop_action_corrupt');
  const stepId = requiredString(row.step_id, 'sop_action_corrupt');
  const occurrenceKey = requiredString(row.occurrence_key, 'sop_action_corrupt');
  const surfaceId = requiredString(row.surface_id, 'sop_action_corrupt');
  const toolName = requiredString(row.tool_name, 'sop_action_corrupt');
  const argumentsObject = parseJsonObject(row.arguments_json, {});
  assertInlineValue(argumentsObject, 'sop_action_arguments');
  const requestFingerprint = requiredString(row.request_fingerprint, 'sop_action_corrupt');
  const expectedActionId = deterministicId('soa_', `${runId}\0${stepId}`);
  const expectedOccurrenceKey = deterministicId('sop_action_', `${runId}\0${stepId}`);
  if (actionId !== expectedActionId || occurrenceKey !== expectedOccurrenceKey) {
    throw diagnosticError('sop_action_identity_mismatch', `sop_action_identity_mismatch:${actionId}`, {
      action_id: actionId,
      expected_action_id: expectedActionId,
      occurrence_key: occurrenceKey,
      expected_occurrence_key: expectedOccurrenceKey,
    });
  }
  const actualRequestFingerprint = fingerprint({ surface_id: surfaceId, tool_name: toolName, arguments: argumentsObject });
  if (requestFingerprint !== actualRequestFingerprint) {
    throw diagnosticError('sop_action_request_fingerprint_mismatch', `sop_action_request_fingerprint_mismatch:${actionId}`, {
      action_id: actionId,
      expected: requestFingerprint,
      actual: actualRequestFingerprint,
    });
  }
  const status = normalizeActionStatus(row.status);
  const completionKey = optionalString(row.completion_key);
  const completionFingerprint = optionalString(row.completion_fingerprint);
  const operationRef = optionalString(row.operation_ref);
  const result = parseJsonObject(row.result_json, {});
  assertInlineValue(result, 'sop_result');
  const resultRef = normalizeValueRef(parseNullableJsonValue(row.result_ref_json), 'sop_result_ref');
  const errorMessage = optionalString(row.error_message);
  if (completionFingerprint) {
    if (!completionKey || !operationRef || (status !== 'completed' && status !== 'failed')) {
      throw diagnosticError('sop_action_completion_identity_invalid', `sop_action_completion_identity_invalid:${actionId}`, { action_id: actionId, status });
    }
    const actualCompletionFingerprint = fingerprint({
      completion_key: completionKey,
      outcome: status,
      operation_ref: operationRef,
      result,
      result_ref: resultRef,
      error_message: errorMessage,
    });
    if (completionFingerprint !== actualCompletionFingerprint) {
      throw diagnosticError('sop_action_completion_fingerprint_mismatch', `sop_action_completion_fingerprint_mismatch:${actionId}`, {
        action_id: actionId,
        expected: completionFingerprint,
        actual: actualCompletionFingerprint,
      });
    }
  } else if (completionKey || operationRef || status === 'completed' || status === 'failed') {
    throw diagnosticError('sop_action_completion_identity_invalid', `sop_action_completion_identity_invalid:${actionId}`, { action_id: actionId, status });
  }
  return {
    schema: 'narada.sop.action.v1',
    action_id: actionId,
    run_id: runId,
    step_id: stepId,
    occurrence_key: occurrenceKey,
    surface_id: surfaceId,
    tool_name: toolName,
    arguments: argumentsObject,
    request_fingerprint: requestFingerprint,
    status,
    completion_key: completionKey,
    completion_fingerprint: completionFingerprint,
    operation_ref: operationRef,
    result,
    result_ref: resultRef,
    error_message: errorMessage,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: optionalString(row.completed_at),
  };
}

export async function runStdioServer(options: JsonRecord = {}): Promise<void> {
  const state = createServerState(options);
  let buffer = '';
  let sawFramedInput = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const drained = buffer.includes('Content-Length:')
      ? drainJsonRpcFrames(buffer)
      : drainJsonLines(buffer);
    sawFramedInput ||= drained.framed;
    buffer = drained.remaining;
    for (const request of drained.requests) {
      const response = await handleRequest(request, state);
      if (response) writeJsonRpcResponse(response, { framed: sawFramedInput });
    }
  }
}

async function dispatchMethod(method: string, params: JsonRecord, state: SopState) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: state.serverName, version: SERVER_VERSION },
      };
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call':
      return await callTool(params, state);
    default:
      throw diagnosticError('unsupported_mcp_method', `unsupported_mcp_method:${method}`);
  }
}

export function listTools() {
  return [
    guidanceToolDefinition(),
    {
      name: 'sop_doctor',
      description: 'Inspect SOP MCP server posture, build/schema metadata, database path, and available recovery tools.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'sop_doctor', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_create',
      description: 'Create a new versioned SOP template with ordered steps.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string', description: 'Stable SOP identifier, e.g. site-onboarding.' },
          title: { type: 'string', description: 'Human-readable title.' },
          description: { type: 'string', description: 'Purpose and scope of this SOP.' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 128,
            items: stepToolSchema(),
          },
          input_schema: { type: 'object', description: 'Optional JSON Schema for each admitted occurrence inline input.' },
          output: { type: 'object', description: 'Optional mapping used to derive the bounded procedure output from input and step results.' },
          output_ref: { type: 'object', description: 'Optional mapping that must resolve to an immutable value-ref for the procedure output.' },
          output_schema: { type: 'object', description: 'Optional JSON Schema for the derived inline procedure output.' },
          trigger_kind: { type: 'string', enum: ['manual', 'inbox_event', 'schedule'], default: 'manual' },
          acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria for validating SOP completion.' },
          evidence_requirements: { type: 'array', items: { type: 'string' }, description: 'Evidence expected from each run.' },
        },
        required: ['sop_id', 'title', 'steps'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_create', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_show',
      description: 'Show the latest version of an SOP template.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          version: { type: 'number', description: 'Specific version; defaults to latest.' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_export',
      description: 'Export one SOP template version with raw persisted JSON and full parsed step definitions for recovery workflows.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          version: { type: 'number', description: 'Specific version; defaults to latest.' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_export', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_list',
      description: 'List SOP templates with optional status filter.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: TEMPLATE_STATUSES },
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_search',
      description: 'Search SOP templates by title or description text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text matched against title and description.' },
          status: { type: 'string', enum: TEMPLATE_STATUSES },
          limit: { type: 'number', default: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_candidate_list',
      description: 'List SOP YAML template files found in configured sops directories and classify their import state against the registry.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_candidate_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_candidate_show',
      description: 'Show one SOP YAML template candidate from configured sops directories and classify its import state against the registry.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string', description: 'SOP identifier matching a .sop.yaml file in configured sops directories.' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_candidate_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_update',
      description: 'Update an SOP template, creating a new version.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 128,
            items: stepToolSchema(),
          },
          input_schema: { type: 'object' },
          output: { type: 'object' },
          output_ref: { type: 'object' },
          output_schema: { type: 'object' },
          trigger_kind: { type: 'string', enum: ['manual', 'inbox_event', 'schedule'] },
          status: { type: 'string', enum: ['draft', 'active', 'deprecated'], description: 'Template status. Defaults to draft.' },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          evidence_requirements: { type: 'array', items: { type: 'string' } },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_update', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_deprecate',
      description: 'Deprecate an SOP template.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_deprecate', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_unimport',
      description: 'Remove an accidentally imported SOP template version from the registry when no runs reference it. Does not delete YAML files.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          version: { type: 'number', description: 'Specific imported version to remove. Defaults to latest version.' },
          reason: { type: 'string', description: 'Why this registry import is being removed.' },
          principal: { type: 'string', description: 'Identity of the principal requesting cleanup.' },
        },
        required: ['sop_id', 'reason', 'principal'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_unimport', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_template_import_yaml',
      description: 'Import an SOP template from a YAML file in the sops/ directory. Validates against the SOP JSON Schema before inserting.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string', description: 'SOP identifier matching a .sop.yaml file in the sops/ directory, e.g. site-onboarding.' },
        },
        required: ['sop_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_template_import_yaml', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_start',
      description: 'Idempotently admit one parameterized SOP occurrence. Scheduler/event owners call this tool; SOP does not own activation policy.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          sop_version: { type: 'integer', minimum: 1, description: 'Specific version; defaults to latest non-deprecated version and is pinned by the admitted occurrence.' },
          occurrence_key: { type: 'string', description: 'Stable caller-owned identity for this one procedure occurrence.' },
          input: { type: 'object', description: `Bounded inline occurrence input (maximum ${MAX_INLINE_VALUE_BYTES} UTF-8 JSON bytes).` },
          input_ref: VALUE_REF_TOOL_SCHEMA,
          trigger_source_kind: { type: 'string', default: 'manual' },
          trigger_source_ref: { type: 'string' },
          triggered_by: { type: 'string' },
        },
        required: ['sop_id', 'occurrence_key', 'triggered_by'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_start', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_status',
      description: 'Get the durable status, pinned definition identity, inputs/outputs, and step states for one SOP occurrence.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string' } },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_refresh',
      description: 'Explicitly reconcile one run as a repair/readback operation. Normal child/action completion reconciles and advances ancestors automatically.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string' } },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_refresh', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_advance',
      description: 'Idempotently complete or fail one leased agent/operator handoff and automatically reconcile its occurrence and ancestors.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff_id: { type: 'string', description: 'Durable handoff identity returned by sop_handoff_claim.' },
          run_id: { type: 'string' },
          step_id: { type: 'string' },
          consumer_id: { type: 'string', description: 'Stable consumer identity that owns the active lease.' },
          lease_token: { type: 'string', description: 'Opaque active lease token returned by sop_handoff_claim.' },
          completion_key: { type: 'string', description: 'Stable completion-attempt key. Exact retries return the already-recorded outcome.' },
          outcome: { type: 'string', enum: ['completed', 'failed'] },
          result: { type: 'object', additionalProperties: true, description: `Bounded successful inline result (maximum ${MAX_INLINE_VALUE_BYTES} UTF-8 JSON bytes).` },
          result_ref: VALUE_REF_TOOL_SCHEMA,
          error_message: { type: 'string', description: 'Required for a failed outcome.' },
          principal: { type: 'string', description: 'Identity of the principal completing the handoff.' },
        },
        required: ['handoff_id', 'run_id', 'step_id', 'consumer_id', 'lease_token', 'completion_key', 'outcome', 'principal'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_advance', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_handoff_list',
      description: 'List durable agent/operator handoffs without exposing lease tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          executor: { type: 'string', enum: SOP_HANDOFF_EXECUTORS },
          status: { type: 'string', enum: SOP_HANDOFF_STATUSES },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'sop_handoff_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_handoff_show',
      description: 'Show one durable agent/operator handoff without exposing its lease token.',
      inputSchema: {
        type: 'object',
        properties: { handoff_id: { type: 'string' } },
        required: ['handoff_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_handoff_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_handoff_claim',
      description: 'Atomically claim the oldest eligible agent/operator handoff, including recovery of an expired lease.',
      inputSchema: {
        type: 'object',
        properties: {
          consumer_id: { type: 'string', description: 'Stable handoff-consumer identity.' },
          handoff_id: { type: 'string', description: 'Optional exact handoff to claim; omitted claims the oldest eligible handoff.' },
          executor: { type: 'string', enum: SOP_HANDOFF_EXECUTORS },
          lease_ms: { type: 'integer', minimum: 1000, maximum: 300000, default: 60000 },
        },
        required: ['consumer_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_handoff_claim', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_handoff_renew',
      description: 'Renew an unexpired handoff lease owned by the supplied consumer and token.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff_id: { type: 'string' },
          consumer_id: { type: 'string' },
          lease_token: { type: 'string' },
          lease_ms: { type: 'integer', minimum: 1000, maximum: 300000, default: 60000 },
        },
        required: ['handoff_id', 'consumer_id', 'lease_token'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_handoff_renew', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_handoff_release',
      description: 'Return an owned handoff lease to the durable pending queue without failing the SOP step.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff_id: { type: 'string' },
          consumer_id: { type: 'string' },
          lease_token: { type: 'string' },
          error_message: { type: 'string' },
        },
        required: ['handoff_id', 'consumer_id', 'lease_token'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_handoff_release', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_handoff_retry',
      description: 'Reopen one failed agent handoff and its terminal SOP occurrence for a governed retry. Completed handoffs cannot be reopened.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff_id: { type: 'string' },
          principal: { type: 'string', description: 'Identity authorizing the retry.' },
          reason: { type: 'string', description: 'Bounded reason the failed handoff is safe to retry.' },
        },
        required: ['handoff_id', 'principal', 'reason'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_handoff_retry', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_action_list',
      description: 'List bounded summaries of durable domain-action handoffs. Use sop_action_show for exact persisted target arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          status: { type: 'string', enum: ACTION_STATUSES },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'sop_action_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_action_show',
      description: 'Show one durable action intent, including the exact domain surface/tool, mapped arguments, and injected occurrence idempotency key.',
      inputSchema: {
        type: 'object',
        properties: { action_id: { type: 'string' } },
        required: ['action_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_action_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_action_resolve',
      description: 'Idempotently acknowledge a domain-owned MCP action outcome, bind its external operation reference, and automatically continue the SOP occurrence.',
      inputSchema: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
          completion_key: { type: 'string' },
          outcome: { type: 'string', enum: ['completed', 'failed'] },
          operation_ref: { type: 'string', description: 'Stable owning-surface operation/audit reference proving the external effect outcome.' },
          result: { type: 'object', additionalProperties: true, description: `Bounded successful inline result (maximum ${MAX_INLINE_VALUE_BYTES} UTF-8 JSON bytes).` },
          result_ref: VALUE_REF_TOOL_SCHEMA,
          error_message: { type: 'string', description: 'Required for a failed outcome.' },
        },
        required: ['action_id', 'completion_key', 'outcome', 'operation_ref'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_action_resolve', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_list',
      description: 'List SOP runs with optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          sop_id: { type: 'string' },
          status: { type: 'string', enum: RUN_STATUSES },
          include_terminal: { type: 'boolean' },
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_coverage_since',
      description: 'List latest SOP run coverage for templates and classify active templates not run since a supplied timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO 8601 timestamp used as the freshness threshold.' },
          template_status: { type: 'string', enum: TEMPLATE_STATUSES, default: 'active' },
          status: { type: 'string', enum: RUN_STATUSES, description: 'Optional latest-run status filter.' },
          include_terminal: { type: 'boolean', default: true },
          limit: { type: 'number', default: 200 },
        },
        required: ['since'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_coverage_since', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_cancel',
      description: 'Cancel a pending or running SOP run.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_cancel', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_run_events',
      description: 'List events for an SOP run.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_run_events', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_outbox_consumer_register',
      description: 'Durably register a required terminal-event consumer from an explicit start boundary.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', const: SOP_TERMINAL_TOPIC, default: SOP_TERMINAL_TOPIC },
          consumer_id: { type: 'string' },
          start_at: { type: 'string', description: 'ISO timestamp; defaults to registration time. Backdated registration is refused if required history was compacted.' },
        },
        required: ['consumer_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_outbox_consumer_register', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_outbox_list',
      description: 'List unacknowledged durable SOP events for one registered consumer.',
      inputSchema: {
        type: 'object',
        properties: {
          consumer_id: { type: 'string' },
          topic: { type: 'string', const: SOP_TERMINAL_TOPIC },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
        required: ['consumer_id'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_outbox_list', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_outbox_ack',
      description: 'Idempotently record one consumer receipt for a durable SOP event.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: { type: 'string' },
          consumer_id: { type: 'string' },
          receipt: { type: 'object', additionalProperties: true },
        },
        required: ['event_id', 'consumer_id', 'receipt'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_outbox_ack', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'sop_outbox_compact',
      description: 'Compact acknowledged outbox payloads before an ISO cutoff while retaining event and receipt identity.',
      inputSchema: {
        type: 'object',
        properties: { before: { type: 'string' } },
        required: ['before'],
        additionalProperties: false,
      },
      annotations: { title: 'sop_outbox_compact', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
  ];
}

async function callTool(params: JsonRecord, state: SopState) {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);
  let result: JsonRecord;
  switch (name) {
    case 'sop_guidance':
      result = buildGuidanceResult(args);
      break;
    case 'sop_doctor': result = sopDoctor(state); break;
    case 'sop_template_create': result = sopTemplateCreate(args, state); break;
    case 'sop_template_show': result = sopTemplateShow(args, state); break;
    case 'sop_template_export': result = sopTemplateExport(args, state); break;
    case 'sop_template_list': result = sopTemplateList(args, state); break;
    case 'sop_template_search': result = sopTemplateSearch(args, state); break;
    case 'sop_template_candidate_list': result = sopTemplateCandidateList(args, state); break;
    case 'sop_template_candidate_show': result = sopTemplateCandidateShow(args, state); break;
    case 'sop_template_import_yaml': result = sopTemplateImportYaml(args, state); break;
    case 'sop_template_update': result = sopTemplateUpdate(args, state); break;
    case 'sop_template_deprecate': result = sopTemplateDeprecate(args, state); break;
    case 'sop_template_unimport': result = sopTemplateUnimport(args, state); break;
    case 'sop_run_start': result = await sopRunStart(args, state); break;
    case 'sop_run_status': result = await sopRunStatus(args, state); break;
    case 'sop_run_refresh': result = await sopRunRefresh(args, state); break;
    case 'sop_run_advance': result = await sopRunAdvance(args, state); break;
    case 'sop_handoff_list': result = sopHandoffList(args, state); break;
    case 'sop_handoff_show': result = sopHandoffShow(args, state); break;
    case 'sop_handoff_claim': result = sopHandoffClaim(args, state); break;
    case 'sop_handoff_renew': result = sopHandoffRenew(args, state); break;
    case 'sop_handoff_release': result = sopHandoffRelease(args, state); break;
    case 'sop_handoff_retry': result = sopHandoffRetry(args, state); break;
    case 'sop_action_list': result = sopActionList(args, state); break;
    case 'sop_action_show': result = sopActionShow(args, state); break;
    case 'sop_action_resolve': result = sopActionResolve(args, state); break;
    case 'sop_run_list': result = sopRunList(args, state); break;
    case 'sop_run_coverage_since': result = sopRunCoverageSince(args, state); break;
    case 'sop_run_cancel': result = sopRunCancel(args, state); break;
    case 'sop_run_events': result = sopRunEvents(args, state); break;
    case 'sop_outbox_consumer_register': result = sopOutboxConsumerRegister(args, state); break;
    case 'sop_outbox_list': result = sopOutboxList(args, state); break;
    case 'sop_outbox_ack': result = sopOutboxAck(args, state); break;
    case 'sop_outbox_compact': result = sopOutboxCompact(args, state); break;
    default: throw diagnosticError('unknown_tool', `unknown_tool:${name}`, { tool_name: name });
  }
  return { content: [{ type: 'text', text: renderResult(result) }], structuredContent: result };
}

function sopTemplateCreate(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const title = requiredString(args.title, 'sop_requires_title');
  const steps = validateSteps(arrayOfRecords(args.steps, true), state, sopId);
  const inputSchema = optionalJsonSchema(args.input_schema, 'input_schema');
  const output = optionalJsonValue(args.output, 'output');
  const outputRef = optionalJsonValue(args.output_ref, 'output_ref');
  const outputSchema = optionalJsonSchema(args.output_schema, 'output_schema');
  validateOutputReferences(output, steps);
  validateOutputReferences(outputRef, steps);
  const criteria = stringList(args.acceptance_criteria);
  const evidenceReq = stringList(args.evidence_requirements);
  assertTemplateBound({ sop_id: sopId, title, steps, input_schema: inputSchema, output, output_ref: outputRef, output_schema: outputSchema, acceptance_criteria: criteria, evidence_requirements: evidenceReq });
  const existing = state.db.prepare('SELECT MAX(version) as v FROM sop_templates WHERE sop_id = ?').get(sopId) as JsonRecord | undefined;
  const version = existing && existing.v ? (Number(existing.v) + 1) : 1;
  const now = nowIso();
  const triggerKind = normalizeTriggerKind(args.trigger_kind);
  state.db.prepare(
    'INSERT INTO sop_templates (sop_id, version, title, status, description, steps_json, trigger_kind, input_schema_json, output_mapping_json, output_ref_mapping_json, output_schema_json, acceptance_criteria_json, evidence_requirements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sopId, version, title, 'draft', optionalString(args.description) ?? '', JSON.stringify(steps), triggerKind, nullableJson(inputSchema), nullableJson(output), nullableJson(outputRef), nullableJson(outputSchema), JSON.stringify(criteria), JSON.stringify(evidenceReq), now, now);
  appendSopEvent(state, 'template_created', { sop_id: sopId, version });
  return { status: 'created', sop_id: sopId, version, title, step_count: steps.length };
}

function sopTemplateShow(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const version = args.version !== undefined && args.version !== null ? Number(args.version) : undefined;
  const row = version !== undefined
    ? state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? AND version = ?').get(sopId, version) as JsonRecord | undefined
    : state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}${version ? `@v${version}` : ''}`);
  return hydrateTemplate(row);
}

function sopTemplateExport(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const version = args.version !== undefined && args.version !== null ? Number(args.version) : undefined;
  const row = version !== undefined
    ? state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? AND version = ?').get(sopId, version) as JsonRecord | undefined
    : state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}${version ? `@v${version}` : ''}`);
  return {
    ...hydrateTemplate(row),
    export_schema: 'narada.sop.template_export.v1',
    raw: {
      steps_json: String(row.steps_json),
      input_schema_json: row.input_schema_json == null ? null : String(row.input_schema_json),
      output_mapping_json: row.output_mapping_json == null ? null : String(row.output_mapping_json),
      output_ref_mapping_json: row.output_ref_mapping_json == null ? null : String(row.output_ref_mapping_json),
      output_schema_json: row.output_schema_json == null ? null : String(row.output_schema_json),
      acceptance_criteria_json: String(row.acceptance_criteria_json),
      evidence_requirements_json: String(row.evidence_requirements_json),
    },
  };
}

function sopTemplateCandidateList(args: JsonRecord, state: SopState) {
  const limit = clamp(integer(args.limit, 50, 1, 200), 1, 200);
  const discovery = discoverTemplateCandidates(state);
  return {
    schema: 'narada.sop.template_candidates.v1',
    sops_dirs: state.sopsDirs,
    sops_dir_errors: discovery.dir_errors,
    items: discovery.candidates.slice(0, limit),
    count: Math.min(discovery.candidates.length, limit),
    total_count: discovery.candidates.length,
  };
}

function sopTemplateCandidateShow(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const discovery = discoverTemplateCandidates(state);
  const candidates = discovery.candidates.filter((candidate) => candidate.sop_id === sopId);
  if (candidates.length === 0) {
    throw diagnosticError('sop_yaml_not_found', `sop_yaml_not_found:${sopId}`, { searched: state.sopsDirs, file: `${sopId}.sop.yaml`, sops_dir_errors: discovery.dir_errors });
  }
  return {
    schema: 'narada.sop.template_candidate.v1',
    sop_id: sopId,
    sops_dir_errors: discovery.dir_errors,
    candidates,
    count: candidates.length,
    selected_candidate: candidates.find((candidate) => candidate.import_resolution === 'selected') ?? candidates[0],
  };
}

function sopDoctor(state: SopState): JsonRecord {
  const discovery = discoverTemplateCandidates(state);
  const candidates = discovery.candidates;
  const durability = sopDurabilityStats(state.db);
  const registeredTemplateCount = Number((state.db.prepare(
    'SELECT COUNT(*) as c FROM (SELECT sop_id, MAX(version) FROM sop_templates GROUP BY sop_id)'
  ).get() as JsonRecord | undefined)?.c ?? 0);
  const notImportedCandidateCount = candidates.filter((candidate) => candidate.import_status === 'not_imported').length;
  const invalidCandidateCount = candidates.filter((candidate) => candidate.import_status === 'invalid_yaml').length;
  return {
    schema: 'narada.sop.doctor.v1',
    status: 'ok',
    server_name: state.serverName,
    server_version: SERVER_VERSION,
    protocol_version: PROTOCOL_VERSION,
    template_response_schema: 'narada.sop.template.v2',
    run_response_schema: 'narada.sop.run.v2',
    action_response_schema: 'narada.sop.action.v1',
    handoff_response_schema: 'narada.sop.handoff.v1',
    terminal_event_schema: 'narada.sop.run_terminal.v2',
    template_show_render_mode: 'summary_text_with_full_structured_content',
    full_step_definitions_path: 'structuredContent.steps',
    recovery_tools: ['sop_template_show', 'sop_template_export', 'sop_template_candidate_list', 'sop_template_candidate_show', 'sop_run_refresh', 'sop_action_show', 'sop_handoff_list', 'sop_handoff_show', 'sop_handoff_claim', 'sop_outbox_list'],
    execution_posture: {
      occurrence_admission: 'idempotent',
      definition_pinning: 'template_and_child_versions_with_definition_fingerprints',
      reconciliation: 'automatic_transactional',
      activation_owner: 'scheduler_or_event_caller',
      effect_owner: 'domain_mcp_surfaces',
      handoff_delivery: 'durable_expiring_consumer_leases',
      terminal_delivery: 'transactional_outbox_with_required_consumer_receipts',
      direct_command_execution: 'unsupported',
      max_inline_value_bytes: MAX_INLINE_VALUE_BYTES,
      max_run_state_bytes: MAX_RUN_STATE_BYTES,
    },
    startup_reconciliation: {
      status: state.startupReconciliationErrors.length === 0 ? 'ok' : 'partial',
      error_count: state.startupReconciliationErrors.length,
      errors: state.startupReconciliationErrors,
    },
    durability,
    sop_root: state.sopRoot,
    db_path: resolve(state.sopRoot, '.sop', 'sop.db'),
    sops_dirs: state.sopsDirs,
    registered_template_count: registeredTemplateCount,
    candidate_template_file_count: candidates.length,
    not_imported_candidate_count: notImportedCandidateCount,
    invalid_candidate_count: invalidCandidateCount,
    sops_dir_errors: discovery.dir_errors,
    next_actions: [
      'Use sop_template_list/show/search for imported registry templates.',
      'Use sop_template_candidate_list/show for YAML files in configured sops_dirs.',
      'Use sop_template_import_yaml to validate and import a candidate into the registry.',
    ],
  };
}

function sopTemplateList(args: JsonRecord, state: SopState) {
  const limit = clamp(integer(args.limit, 50, 1, 200), 1, 200);
  const status = optionalString(args.status);
  if (status && !TEMPLATE_STATUSES.includes(status as typeof TEMPLATE_STATUSES[number])) {
    throw diagnosticError('sop_template_status_unsupported', `sop_template_status_unsupported:${status}`, { status, allowed: TEMPLATE_STATUSES });
  }
  let rows: JsonRecord[];
  if (status && TEMPLATE_STATUSES.includes(status as typeof TEMPLATE_STATUSES[number])) {
    rows = state.db.prepare(
      `SELECT t.* FROM sop_templates t JOIN (SELECT sop_id, MAX(version) as mv FROM sop_templates GROUP BY sop_id) latest ON t.sop_id = latest.sop_id AND t.version = latest.mv WHERE t.status = ? ORDER BY t.updated_at DESC LIMIT ?`
    ).all(status, limit) as JsonRecord[];
  } else {
    rows = state.db.prepare(
      `SELECT t.* FROM sop_templates t JOIN (SELECT sop_id, MAX(version) as mv FROM sop_templates GROUP BY sop_id) latest ON t.sop_id = latest.sop_id AND t.version = latest.mv ORDER BY t.updated_at DESC LIMIT ?`
    ).all(limit) as JsonRecord[];
  }
  return { schema: 'narada.sop.template_list.v2', items: rows.map((row) => templateSummary(hydrateTemplate(row))), count: rows.length };
}

function sopTemplateSearch(args: JsonRecord, state: SopState) {
  const query = requiredString(args.query, 'sop_requires_query');
  const limit = clamp(integer(args.limit, 20, 1, 100), 1, 100);
  const status = optionalString(args.status);
  const like = `%${query}%`;
  let sql = `SELECT t.* FROM sop_templates t JOIN (SELECT sop_id, MAX(version) as mv FROM sop_templates GROUP BY sop_id) latest ON t.sop_id = latest.sop_id AND t.version = latest.mv WHERE (t.title LIKE ? OR t.description LIKE ?)`;
  const params: (string | number)[] = [like, like];
  if (status && TEMPLATE_STATUSES.includes(status as typeof TEMPLATE_STATUSES[number])) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY t.updated_at DESC LIMIT ?';
  params.push(limit);
  const rows = state.db.prepare(sql).all(...params) as JsonRecord[];
  return { schema: 'narada.sop.template_search.v2', items: rows.map((row) => templateSummary(hydrateTemplate(row))), count: rows.length, query };
}

function discoverTemplateCandidates(state: SopState): { candidates: JsonRecord[]; dir_errors: JsonRecord[] } {
  const paths: Array<{ directory: string; path: string; file_name: string; sop_id: string; order: number }> = [];
  const dirErrors: JsonRecord[] = [];
  state.sopsDirs.forEach((dir, order) => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sop.yaml'))
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      dirErrors.push({
        directory: dir,
        code: 'sop_sops_dir_read_error',
        message: err instanceof Error ? err.message : String(err),
      });
      entries = [];
    }
    for (const fileName of entries) {
      paths.push({
        directory: dir,
        path: resolve(dir, fileName),
        file_name: fileName,
        sop_id: fileName.slice(0, -'.sop.yaml'.length),
        order,
      });
    }
  });

  const firstBySopId = new Map<string, string>();
  const countBySopId = new Map<string, number>();
  for (const candidate of paths) {
    countBySopId.set(candidate.sop_id, (countBySopId.get(candidate.sop_id) ?? 0) + 1);
    if (!firstBySopId.has(candidate.sop_id)) firstBySopId.set(candidate.sop_id, candidate.path);
  }

  return {
    candidates: paths.map((candidate) => classifyTemplateCandidate(state, candidate, firstBySopId.get(candidate.sop_id) === candidate.path, countBySopId.get(candidate.sop_id) ?? 1)),
    dir_errors: dirErrors,
  };
}

function classifyTemplateCandidate(
  state: SopState,
  candidate: { directory: string; path: string; file_name: string; sop_id: string; order: number },
  selected: boolean,
  duplicateCount: number,
): JsonRecord {
  const base = {
    sop_id: candidate.sop_id,
    file_name: candidate.file_name,
    path: candidate.path,
    directory: candidate.directory,
    directory_order: candidate.order,
    import_resolution: selected ? 'selected' : 'shadowed',
    duplicate_count: duplicateCount,
  };

  let parsed: TemplateYamlCandidate;
  try {
    parsed = parseTemplateYamlFile(candidate.path, candidate.sop_id, state);
  } catch (err) {
    const diagnostic = errorDiagnostic(err);
    return {
      ...base,
      import_status: 'invalid_yaml',
      diagnostic,
      title: null,
      version_if_imported: null,
    };
  }

  if (!selected) {
    return {
      ...base,
      import_status: 'shadowed',
      title: parsed.title,
      status: parsed.status,
      step_count: parsed.steps.length,
      version_if_imported: null,
    };
  }

  const current = latestTemplateRow(state, parsed.sop_id);
  if (!current) {
    return {
      ...base,
      sop_id: parsed.sop_id,
      import_status: 'not_imported',
      title: parsed.title,
      status: parsed.status,
      step_count: parsed.steps.length,
      version_if_imported: 1,
    };
  }

  const previous = hydrateTemplate(current);
  const unchanged = templateYamlMatchesImportUnchangedSemantics(previous, parsed);
  return {
    ...base,
    sop_id: parsed.sop_id,
    import_status: unchanged ? 'imported_current' : 'imported_changed',
    title: parsed.title,
    status: parsed.status,
    step_count: parsed.steps.length,
    current_version: previous.version,
    version_if_imported: unchanged ? previous.version : Number(previous.version) + 1,
  };
}

type TemplateYamlCandidate = {
  sop_id: string;
  title: string;
  description: string;
  trigger_kind: string;
  status: string;
  steps: SopStep[];
  input_schema: JsonRecord | null;
  output: JsonValue | null;
  output_ref: JsonValue | null;
  output_schema: JsonRecord | null;
  acceptance_criteria: string[];
  evidence_requirements: string[];
};

function parseTemplateYamlFile(yamlPath: string, expectedSopId: string, state: SopState): TemplateYamlCandidate {
  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch (err) {
    throw diagnosticError('sop_yaml_read_error', `sop_yaml_read_error:${expectedSopId}`, { yaml_path: yamlPath, message: err instanceof Error ? err.message : String(err) });
  }

  let doc: unknown;
  try {
    doc = loadYaml(raw, { schema: JSON_SCHEMA, filename: yamlPath });
  } catch (err) {
    throw diagnosticError('sop_yaml_parse_error', `sop_yaml_parse_error:${expectedSopId}`, { yaml_path: yamlPath, message: err instanceof Error ? err.message : String(err) });
  }

  if (!validateYamlSchema(doc)) {
    const errors = (validateYamlSchema.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw diagnosticError('sop_yaml_schema_error', `sop_yaml_schema_error:${expectedSopId}`, { yaml_path: yamlPath, errors });
  }

  const data = doc as JsonRecord;
  const yamlSopId = requiredString(data.sop_id, 'sop_yaml_requires_sop_id', { yaml_path: yamlPath });
  if (yamlSopId !== expectedSopId) {
    throw diagnosticError('sop_yaml_id_mismatch', `sop_yaml_id_mismatch:arg=${expectedSopId} yaml=${yamlSopId}`, { yaml_path: yamlPath });
  }

  const steps = validateSteps(arrayOfRecords(data.steps, true), state, yamlSopId);
  const inputSchema = optionalJsonSchema(data.input_schema, 'input_schema');
  const output = optionalJsonValue(data.output, 'output');
  const outputRef = optionalJsonValue(data.output_ref, 'output_ref');
  const outputSchema = optionalJsonSchema(data.output_schema, 'output_schema');
  validateOutputReferences(output, steps);
  validateOutputReferences(outputRef, steps);
  const candidate: TemplateYamlCandidate = {
    sop_id: yamlSopId,
    title: requiredString(data.title, 'sop_yaml_requires_title', { yaml_path: yamlPath }),
    description: optionalString(data.description) ?? '',
    trigger_kind: normalizeTriggerKind(data.trigger_kind),
    status: normalizeTemplateStatus(data.status),
    steps,
    input_schema: inputSchema,
    output,
    output_ref: outputRef,
    output_schema: outputSchema,
    acceptance_criteria: stringList(data.acceptance_criteria),
    evidence_requirements: stringList(data.evidence_requirements),
  };
  assertTemplateBound(candidate);
  return candidate;
}

function latestTemplateRow(state: SopState, sopId: string): JsonRecord | undefined {
  return state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
}

function templateYamlMatchesImportUnchangedSemantics(previous: SopTemplate, next: TemplateYamlCandidate): boolean {
  return previous.title === next.title &&
    previous.status === next.status &&
    previous.description === next.description &&
    previous.trigger_kind === next.trigger_kind &&
    JSON.stringify(previous.steps) === JSON.stringify(next.steps) &&
    canonicalJson(previous.input_schema) === canonicalJson(next.input_schema) &&
    canonicalJson(previous.output) === canonicalJson(next.output) &&
    canonicalJson(previous.output_ref) === canonicalJson(next.output_ref) &&
    canonicalJson(previous.output_schema) === canonicalJson(next.output_schema) &&
    JSON.stringify(previous.acceptance_criteria) === JSON.stringify(next.acceptance_criteria) &&
    JSON.stringify(previous.evidence_requirements) === JSON.stringify(next.evidence_requirements);
}

function sopTemplateImportYaml(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const fileName = `${sopId}.sop.yaml`;

  let yamlPath: string | null = null;
  for (const dir of state.sopsDirs) {
    const candidate = resolve(dir, fileName);
    if (existsSync(candidate)) { yamlPath = candidate; break; }
  }
  if (!yamlPath) {
    throw diagnosticError('sop_yaml_not_found', `sop_yaml_not_found:${sopId}`, { searched: state.sopsDirs, file: fileName });
  }

  const parsed = parseTemplateYamlFile(yamlPath, sopId, state);

  const current = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;

  if (current) {
    const prev = hydrateTemplate(current);
    if (templateYamlMatchesImportUnchangedSemantics(prev, parsed)) {
      return { status: 'unchanged', sop_id: sopId, version: prev.version, title: parsed.title, step_count: parsed.steps.length };
    }
  }

  const version = current ? (Number(current.version) + 1) : 1;
  const now = nowIso();

  state.db.prepare(
    'INSERT INTO sop_templates (sop_id, version, title, status, description, steps_json, trigger_kind, input_schema_json, output_mapping_json, output_ref_mapping_json, output_schema_json, acceptance_criteria_json, evidence_requirements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sopId, version, parsed.title, parsed.status, parsed.description, JSON.stringify(parsed.steps), parsed.trigger_kind, nullableJson(parsed.input_schema), nullableJson(parsed.output), nullableJson(parsed.output_ref), nullableJson(parsed.output_schema), JSON.stringify(parsed.acceptance_criteria), JSON.stringify(parsed.evidence_requirements), now, now);

  const eventKind = current ? 'template_updated' : 'template_created';
  appendSopEvent(state, eventKind, { sop_id: sopId, version, previous_version: current ? current.version : undefined, source: 'yaml_import', yaml_path: yamlPath });
  return { status: current ? 'updated' : 'created', sop_id: sopId, version, previous_version: current ? current.version : undefined, title: parsed.title, step_count: parsed.steps.length };
}

function sopTemplateUpdate(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const current = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!current) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}`);
  const nextVersion = Number(current.version) + 1;
  const now = nowIso();
  const title = optionalString(args.title) ?? String(current.title);
  const description = optionalString(args.description) ?? String(current.description);
  const steps = args.steps !== undefined ? validateSteps(arrayOfRecords(args.steps, true), state, sopId) : (JSON.parse(String(current.steps_json)) as JsonRecord[]).map(migrateStep);
  const inputSchema = args.input_schema !== undefined ? optionalJsonSchema(args.input_schema, 'input_schema') : parseNullableJsonObject(current.input_schema_json);
  const output = args.output !== undefined ? optionalJsonValue(args.output, 'output') : parseNullableJsonValue(current.output_mapping_json);
  const outputRef = args.output_ref !== undefined ? optionalJsonValue(args.output_ref, 'output_ref') : parseNullableJsonValue(current.output_ref_mapping_json);
  const outputSchema = args.output_schema !== undefined ? optionalJsonSchema(args.output_schema, 'output_schema') : parseNullableJsonObject(current.output_schema_json);
  validateOutputReferences(output, steps);
  validateOutputReferences(outputRef, steps);
  const triggerKind = normalizeTriggerKind(args.trigger_kind ?? current.trigger_kind);
  const status = normalizeTemplateStatus(args.status);
  const criteria = stringList(args.acceptance_criteria !== undefined ? args.acceptance_criteria : JSON.parse(String(current.acceptance_criteria_json)));
  const evidenceReq = stringList(args.evidence_requirements !== undefined ? args.evidence_requirements : JSON.parse(String(current.evidence_requirements_json)));
  assertTemplateBound({ sop_id: sopId, title, steps, input_schema: inputSchema, output, output_ref: outputRef, output_schema: outputSchema, acceptance_criteria: criteria, evidence_requirements: evidenceReq });
  state.db.prepare(
    'INSERT INTO sop_templates (sop_id, version, title, status, description, steps_json, trigger_kind, input_schema_json, output_mapping_json, output_ref_mapping_json, output_schema_json, acceptance_criteria_json, evidence_requirements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sopId, nextVersion, title, status, description, JSON.stringify(steps), triggerKind, nullableJson(inputSchema), nullableJson(output), nullableJson(outputRef), nullableJson(outputSchema), JSON.stringify(criteria), JSON.stringify(evidenceReq), now, now);
  appendSopEvent(state, 'template_updated', { sop_id: sopId, version: nextVersion, previous_version: current.version });
  return { status: 'updated', sop_id: sopId, version: nextVersion, previous_version: current.version, title, step_count: steps.length };
}

function sopTemplateDeprecate(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const current = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!current) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}`);
  state.db.prepare('UPDATE sop_templates SET status = ? WHERE sop_id = ? AND version = ?').run('deprecated', sopId, Number(current.version));
  appendSopEvent(state, 'template_deprecated', { sop_id: sopId, version: current.version, reason: optionalString(args.reason) });
  return { status: 'deprecated', sop_id: sopId, version: current.version };
}

function sopTemplateUnimport(args: JsonRecord, state: SopState) {
  const sopId = requiredString(args.sop_id, 'sop_requires_sop_id');
  const reason = requiredString(args.reason, 'sop_unimport_requires_reason');
  const principal = requiredString(args.principal, 'sop_unimport_requires_principal');
  const version = args.version !== undefined && args.version !== null ? Number(args.version) : undefined;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw diagnosticError('sop_invalid_version', `sop_invalid_version:${version}`, { sop_id: sopId });
  }

  const row = version !== undefined
    ? state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? AND version = ?').get(sopId, version) as JsonRecord | undefined
    : state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? ORDER BY version DESC LIMIT 1').get(sopId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}${version ? `@v${version}` : ''}`);

  const selectedVersion = Number(row.version);
  const runRefs = state.db.prepare(
    'SELECT run_id, status, created_at FROM sop_runs WHERE sop_id = ? AND sop_version = ? ORDER BY created_at DESC LIMIT 10'
  ).all(sopId, selectedVersion) as JsonRecord[];
  const runCount = Number((state.db.prepare(
    'SELECT COUNT(*) as c FROM sop_runs WHERE sop_id = ? AND sop_version = ?'
  ).get(sopId, selectedVersion) as JsonRecord | undefined)?.c ?? 0);
  const pinnedChildRefs = (state.db.prepare('SELECT run_id, step_states_json FROM sop_runs').all() as JsonRecord[]).flatMap((run) => {
    try {
      const states = JSON.parse(String(run.step_states_json)) as JsonRecord[];
      return states.filter((step) => String(step.sop_id ?? '') === sopId && Number(step.sop_version ?? 0) === selectedVersion).map((step) => ({ run_id: String(run.run_id), step_id: String(step.step_id ?? '') }));
    } catch {
      return [];
    }
  }).slice(0, 20);
  if (runCount > 0 || pinnedChildRefs.length > 0) {
    throw diagnosticError('sop_template_has_runs', `sop_template_has_runs:${sopId}@v${selectedVersion}`, {
      sop_id: sopId,
      version: selectedVersion,
      run_count: runCount,
      run_refs: runRefs,
      pinned_child_refs: pinnedChildRefs,
    });
  }

  state.db.prepare('DELETE FROM sop_templates WHERE sop_id = ? AND version = ?').run(sopId, selectedVersion);
  const remainingRows = state.db.prepare('SELECT version FROM sop_templates WHERE sop_id = ? ORDER BY version ASC').all(sopId) as JsonRecord[];
  const remainingVersions = remainingRows.map((remaining) => Number(remaining.version));
  const eventId = appendSopEvent(state, 'template_unimported', {
    sop_id: sopId,
    version: selectedVersion,
    reason,
    principal,
    remaining_versions: remainingVersions,
  });
  return {
    status: 'unimported',
    sop_id: sopId,
    version: selectedVersion,
    remaining_versions: remainingVersions,
    runs_checked: runCount,
    event_id: eventId,
  };
}

function nextSteps(stepStates: SopStepState[]): JsonRecord[] {
  return stepStates.filter((step) => step.status === 'running').map((step) => ({
    step_id: step.step_id,
    executor: step.executor,
    title: step.title,
    instructions: String(step.result.instructions ?? step.instructions),
    child_run_id: step.child_run_id,
    child_sop_id: step.sop_id,
    action_id: step.action_id,
    action_target: step.action ? { surface_id: step.action.surface_id, tool_name: step.action.tool_name } : null,
    result: step.result,
    result_ref: step.result_ref,
  }));
}

function runResult(run: SopRun, admission: 'created' | 'replayed' | null = null): JsonRecord {
  const next = nextSteps(run.step_states);
  const { definition: _definition, ...publicRun } = run;
  return {
    schema: 'narada.sop.run.v2',
    ...publicRun,
    definition_snapshot: {
      stored: true,
      fingerprint: run.definition_fingerprint,
      sop_id: run.sop_id,
      sop_version: run.sop_version,
      child_pins: run.step_states.filter((step) => step.executor === 'sop').map((step) => ({
        step_id: step.step_id,
        sop_id: step.sop_id,
        sop_version: step.sop_version,
        definition_fingerprint: step.pinned_child_definition_fingerprint,
      })),
    },
    admission,
    next_awaits_confirmation: run.step_states.some((step) => step.status === 'running' && (step.executor === 'agent' || step.executor === 'operator')),
    next_steps: next,
    next_step: next[0] ?? null,
    relationship_reconciliation: { mode: 'automatic', repair_tool: 'sop_run_refresh' },
  };
}

async function sopRunStart(args: JsonRecord, state: SopState) {
  return inTransaction(state, () => {
    const admitted = admitRun(args, state, { parent_run_id: null, parent_step_id: null });
    reconcileRunAndAncestors(admitted.run.run_id, state);
    return runResult(getRunById(admitted.run.run_id, state), admitted.admission);
  });
}

function sopHandoffList(args: JsonRecord, state: SopState): JsonRecord {
  const items = listSopHandoffs(state.db, {
    run_id: optionalString(args.run_id),
    executor: optionalString(args.executor),
    status: optionalString(args.status),
    limit: args.limit === undefined ? undefined : Number(args.limit),
  }).map((handoff) => publicSopHandoff(handoff));
  return { schema: 'narada.sop.handoff_list.v1', items, count: items.length };
}

function sopHandoffShow(args: JsonRecord, state: SopState): JsonRecord {
  return publicSopHandoff(getSopHandoff(state.db, requiredString(args.handoff_id, 'sop_handoff_id_required')));
}

function sopHandoffClaim(args: JsonRecord, state: SopState): JsonRecord {
  return inTransaction(state, () => {
    const handoff = claimSopHandoff(state.db, {
      consumer_id: requiredString(args.consumer_id, 'sop_handoff_consumer_id_required'),
      handoff_id: optionalString(args.handoff_id),
      executor: optionalString(args.executor),
      lease_ms: args.lease_ms === undefined ? undefined : Number(args.lease_ms),
    });
    return {
      schema: 'narada.sop.handoff_claim.v1',
      status: handoff ? 'claimed' : 'empty',
      handoff: handoff ? publicSopHandoff(handoff, true) : null,
    };
  });
}

function sopHandoffRenew(args: JsonRecord, state: SopState): JsonRecord {
  return inTransaction(state, () => publicSopHandoff(renewSopHandoff(state.db, {
    handoff_id: requiredString(args.handoff_id, 'sop_handoff_id_required'),
    consumer_id: requiredString(args.consumer_id, 'sop_handoff_consumer_id_required'),
    lease_token: requiredString(args.lease_token, 'sop_handoff_lease_token_required'),
    lease_ms: args.lease_ms === undefined ? undefined : Number(args.lease_ms),
  }), true));
}

function sopHandoffRelease(args: JsonRecord, state: SopState): JsonRecord {
  return inTransaction(state, () => publicSopHandoff(releaseSopHandoff(state.db, {
    handoff_id: requiredString(args.handoff_id, 'sop_handoff_id_required'),
    consumer_id: requiredString(args.consumer_id, 'sop_handoff_consumer_id_required'),
    lease_token: requiredString(args.lease_token, 'sop_handoff_lease_token_required'),
    error_message: optionalBoundedString(args.error_message, 'sop_handoff_error_message_too_long', 4096),
  })));
}

function sopActionList(args: JsonRecord, state: SopState): JsonRecord {
  const limit = clamp(integer(args.limit, 50, 1, 100), 1, 100);
  const runId = optionalString(args.run_id);
  const status = optionalString(args.status);
  if (status && !ACTION_STATUSES.includes(status as typeof ACTION_STATUSES[number])) throw diagnosticError('sop_action_status_invalid', `sop_action_status_invalid:${status}`, { allowed: ACTION_STATUSES });
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (runId) { conditions.push('run_id = ?'); params.push(runId); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = state.db.prepare(`SELECT action_id, run_id, step_id, occurrence_key, surface_id, tool_name, status, operation_ref, created_at, updated_at, completed_at FROM sop_actions${where} ORDER BY created_at ASC LIMIT ?`).all(...params, limit) as JsonRecord[];
  return { schema: 'narada.sop.action_list.v1', items: rows, count: rows.length };
}

function sopActionShow(args: JsonRecord, state: SopState): JsonRecord {
  return hydrateAction(actionRow(requiredString(args.action_id, 'sop_requires_action_id'), state));
}

function sopActionResolve(args: JsonRecord, state: SopState): JsonRecord {
  const actionId = requiredString(args.action_id, 'sop_requires_action_id');
  const completionKey = boundedString(args.completion_key, 'sop_requires_completion_key', 512);
  const outcome = requiredString(args.outcome, 'sop_requires_outcome');
  if (outcome !== 'completed' && outcome !== 'failed') throw diagnosticError('sop_outcome_invalid', `sop_outcome_invalid:${outcome}`, { allowed: ['completed', 'failed'] });
  const operationRef = boundedString(args.operation_ref, 'sop_requires_operation_ref', 2048);
  const result = args.result === undefined ? {} : args.result;
  assertInlineValue(result, 'sop_result');
  if (!isJsonObject(result)) throw diagnosticError('sop_result_must_be_object');
  const resultRef = normalizeValueRef(args.result_ref, 'sop_result_ref');
  const errorMessage = optionalBoundedString(args.error_message, 'sop_error_message_too_long', 4096);
  if (outcome === 'failed' && !errorMessage) throw diagnosticError('sop_failed_outcome_requires_error_message');
  const completionFingerprint = fingerprint({ completion_key: completionKey, outcome, operation_ref: operationRef, result, result_ref: resultRef, error_message: errorMessage });

  const receipt = inTransaction(state, () => {
    const existing = hydrateAction(actionRow(actionId, state));
    if (existing.completion_fingerprint) {
      if (existing.completion_key === completionKey && existing.completion_fingerprint === completionFingerprint) {
        const runRow = state.db.prepare('SELECT status FROM sop_runs WHERE run_id = ?').get(existing.run_id) as JsonRecord | undefined;
        return { action: existing, completion_replayed: true, late_cancellation_acknowledgement: String(runRow?.status ?? '') === 'cancelled' };
      }
      throw diagnosticError('sop_action_completion_conflict', `sop_action_completion_conflict:${actionId}`, { recorded_completion_key: existing.completion_key, supplied_completion_key: completionKey });
    }
    const runRow = state.db.prepare('SELECT status FROM sop_runs WHERE run_id = ?').get(existing.run_id) as JsonRecord | undefined;
    if (!runRow) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${existing.run_id}`);
    const lateCancellationAcknowledgement = existing.status === 'cancelled' && String(runRow.status) === 'cancelled';
    if (existing.status !== 'pending' && !lateCancellationAcknowledgement) {
      throw diagnosticError('sop_action_not_pending', `sop_action_not_pending:${actionId}`, { status: existing.status });
    }
    const now = nowIso();
    state.db.prepare('UPDATE sop_actions SET status = ?, completion_key = ?, completion_fingerprint = ?, operation_ref = ?, result_json = ?, result_ref_json = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE action_id = ?').run(
      outcome, completionKey, completionFingerprint, operationRef, JSON.stringify(result), nullableJson(resultRef), outcome === 'failed' ? errorMessage : null, now, now, actionId,
    );
    const eventKind = lateCancellationAcknowledgement
      ? (outcome === 'completed' ? 'action_completed_after_cancellation' : 'action_failed_after_cancellation')
      : (outcome === 'completed' ? 'action_completed' : 'action_failed');
    appendRunEvent(state, existing.run_id, existing.step_id, eventKind, { action_id: actionId, completion_key: completionKey, operation_ref: operationRef, result_ref: resultRef, error_message: errorMessage });
    return { action: hydrateAction(actionRow(actionId, state)), completion_replayed: false, late_cancellation_acknowledgement: lateCancellationAcknowledgement };
  });

  let reconciliationDiagnostic: JsonRecord | null = null;
  if (!receipt.late_cancellation_acknowledgement) {
    try {
      inTransaction(state, () => reconcileRunAndAncestors(receipt.action.run_id, state));
    } catch (error) {
      reconciliationDiagnostic = errorDiagnostic(error);
    }
  }
  return {
    ...hydrateAction(actionRow(actionId, state)),
    completion_replayed: receipt.completion_replayed,
    late_cancellation_acknowledgement: receipt.late_cancellation_acknowledgement,
    reconciliation: reconciliationDiagnostic ? { status: 'failed', diagnostic: reconciliationDiagnostic } : { status: 'completed' },
    run: actionResolutionRunView(receipt.action.run_id, state),
  };
}

function actionRow(actionId: string, state: SopState): JsonRecord {
  const row = state.db.prepare('SELECT * FROM sop_actions WHERE action_id = ?').get(actionId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_action_not_found', `sop_action_not_found:${actionId}`);
  return row;
}

async function sopRunStatus(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  return runResult(getRunById(runId, state));
}

async function sopRunRefresh(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  return inTransaction(state, () => {
    const before = getRunById(runId, state);
    reconcileRunAndAncestors(runId, state);
    const after = getRunById(runId, state);
    return { ...runResult(after), explicit_reconciliation: { changed: before.updated_at !== after.updated_at, automatic_mode: true } };
  });
}

async function sopRunAdvance(args: JsonRecord, state: SopState) {
  return inTransaction(state, () => {
    const handoffId = requiredString(args.handoff_id, 'sop_handoff_id_required');
    const runId = requiredString(args.run_id, 'sop_requires_run_id');
    const stepId = requiredString(args.step_id, 'sop_requires_step_id');
    const consumerId = boundedString(args.consumer_id, 'sop_handoff_consumer_id_required', 512);
    const leaseToken = boundedString(args.lease_token, 'sop_handoff_lease_token_required', 512);
    const completionKey = boundedString(args.completion_key, 'sop_requires_completion_key', 512);
    const principal = boundedString(args.principal, 'sop_requires_principal', 512);
    const outcome = requiredString(args.outcome, 'sop_requires_outcome');
    if (outcome !== 'completed' && outcome !== 'failed') throw diagnosticError('sop_outcome_invalid', `sop_outcome_invalid:${outcome}`, { allowed: ['completed', 'failed'] });
    const result = args.result === undefined ? {} : args.result;
    assertInlineValue(result, 'sop_result');
    if (!isJsonObject(result)) throw diagnosticError('sop_result_must_be_object');
    const resultRef = normalizeValueRef(args.result_ref, 'sop_result_ref');
    const errorMessage = optionalBoundedString(args.error_message, 'sop_error_message_too_long', 4096);
    if (outcome === 'failed' && !errorMessage) throw diagnosticError('sop_failed_outcome_requires_error_message');
    const completionFingerprint = fingerprint({ completion_key: completionKey, outcome, principal, result, result_ref: resultRef, error_message: errorMessage });
    const run = getRunById(runId, state);
    if (run.step_states_parse_error) throw diagnosticError('sop_run_corrupt', `sop_run_corrupt:${runId}`, { reason: run.step_states_parse_error });
    const target = run.step_states.find((step) => step.step_id === stepId);
    if (!target) throw diagnosticError('sop_step_not_found', `sop_step_not_found:${stepId}`);
    if (target.executor !== 'agent' && target.executor !== 'operator') throw diagnosticError('sop_step_not_manual_handoff', `sop_step_not_manual_handoff:${stepId}`, { executor: target.executor });
    if (!target.completion_fingerprint && RUN_TERMINAL.has(run.status)) throw diagnosticError('sop_run_terminal', `sop_run_terminal:${runId}`, { status: run.status });
    if (!target.completion_fingerprint && target.status !== 'running') throw diagnosticError('sop_step_not_running', `sop_step_not_running:${stepId}`, { status: target.status });
    if (outcome === 'completed') validateAgainstSchema(target.result_schema, result, 'sop_step_result_schema_mismatch', { run_id: runId, step_id: stepId });
    const handoffReceipt = completeSopHandoff(state.db, {
      handoff_id: handoffId,
      run_id: runId,
      step_id: stepId,
      consumer_id: consumerId,
      lease_token: leaseToken,
      completion_key: completionKey,
      outcome,
      principal,
      result,
      result_ref: resultRef,
      error_message: outcome === 'failed' ? errorMessage : null,
    });
    if (target.completion_fingerprint) {
      if (target.completion_key === completionKey && target.completion_fingerprint === completionFingerprint && handoffReceipt.completion_replayed) {
        return { ...runResult(run), handoff: publicSopHandoff(handoffReceipt.handoff), completion_replayed: true };
      }
      throw diagnosticError('sop_step_completion_conflict', `sop_step_completion_conflict:${runId}:${stepId}`, { recorded_completion_key: target.completion_key, supplied_completion_key: completionKey });
    }
    target.status = outcome;
    target.completed_at = handoffReceipt.handoff.completed_at ?? nowIso();
    target.result = result as JsonRecord;
    target.result_ref = resultRef;
    target.completion_key = completionKey;
    target.completion_fingerprint = completionFingerprint;
    target.error_message = outcome === 'failed' ? errorMessage : null;
    appendRunEvent(state, runId, stepId, outcome === 'completed' ? 'step_completed' : 'step_failed', { handoff_id: handoffId, consumer_id: consumerId, principal, completion_key: completionKey, result_ref: resultRef, error_message: target.error_message });
    persistRunState(run, state);
    reconcileRunAndAncestors(runId, state);
    return { ...runResult(getRunById(runId, state)), handoff: publicSopHandoff(handoffReceipt.handoff), completion_replayed: false };
  });
}

function sopRunList(args: JsonRecord, state: SopState) {
  const limit = clamp(integer(args.limit, 50, 1, 200), 1, 200);
  const sopId = optionalString(args.sop_id);
  const status = optionalString(args.status);
  if (status && !RUN_STATUSES.includes(status as typeof RUN_STATUSES[number])) {
    throw diagnosticError('sop_run_status_unsupported', `sop_run_status_unsupported:${status}`, { status, allowed: RUN_STATUSES });
  }
  const includeTerminal = args.include_terminal === undefined ? false : Boolean(args.include_terminal);
  let sql = 'SELECT * FROM sop_runs';
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  if (sopId) { conditions.push('sop_id = ?'); params.push(sopId); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (!includeTerminal) { conditions.push("status NOT IN ('completed','failed','cancelled')"); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = state.db.prepare(sql).all(...params) as JsonRecord[];
  return { schema: 'narada.sop.run_list.v2', items: rows.map((row) => runSummary(hydrateRun(row))), count: rows.length };
}

function sopRunCoverageSince(args: JsonRecord, state: SopState) {
  const since = requiredString(args.since, 'sop_requires_since');
  const sinceTime = Date.parse(since);
  if (!Number.isFinite(sinceTime)) throw diagnosticError('sop_since_must_be_iso_timestamp', `sop_since_must_be_iso_timestamp:${since}`, { since });
  const limit = clamp(integer(args.limit, 200, 1, 500), 1, 500);
  const templateStatus = optionalString(args.template_status) ?? 'active';
  if (!TEMPLATE_STATUSES.includes(templateStatus as typeof TEMPLATE_STATUSES[number])) throw diagnosticError('sop_template_status_unsupported', `sop_template_status_unsupported:${templateStatus}`, { template_status: templateStatus, allowed: TEMPLATE_STATUSES });
  const runStatus = optionalString(args.status);
  if (runStatus && !RUN_STATUSES.includes(runStatus as typeof RUN_STATUSES[number])) throw diagnosticError('sop_run_status_unsupported', `sop_run_status_unsupported:${runStatus}`, { status: runStatus, allowed: RUN_STATUSES });
  const includeTerminal = args.include_terminal === undefined ? true : Boolean(args.include_terminal);
  const templates = state.db.prepare(
    `SELECT t.* FROM sop_templates t JOIN (SELECT sop_id, MAX(version) as mv FROM sop_templates GROUP BY sop_id) latest ON t.sop_id = latest.sop_id AND t.version = latest.mv WHERE t.status = ? ORDER BY t.updated_at DESC LIMIT ?`
  ).all(templateStatus, limit) as JsonRecord[];
  const runStatement = state.db.prepare('SELECT * FROM sop_runs WHERE sop_id = ? AND sop_version = ? ORDER BY created_at DESC LIMIT 1');
  const items = templates.map((template) => {
    const latestRun = runStatement.get(String(template.sop_id), Number(template.version)) as JsonRecord | undefined;
    const hydratedRun = latestRun ? hydrateRun(latestRun) : null;
    const latestRunAt = latestRun ? String(latestRun.created_at ?? latestRun.updated_at ?? '') : null;
    const latestRunTime = latestRunAt ? Date.parse(latestRunAt) : NaN;
    const classification = !latestRun
      ? 'not_run'
      : Number.isFinite(latestRunTime) && latestRunTime >= sinceTime
        ? 'recent'
        : 'stale';
    return {
      sop_id: String(template.sop_id),
      version: Number(template.version),
      title: String(template.title ?? ''),
      template_status: String(template.status ?? ''),
      classification,
      stale: classification !== 'recent',
      latest_run_id: hydratedRun?.run_id ?? null,
      latest_run_at: latestRunAt,
      latest_run_status: hydratedRun?.status ?? null,
      latest_run: hydratedRun ? runSummary(hydratedRun) : null,
    };
  }).filter((item) => {
    if (!includeTerminal && item.latest_run_status && RUN_TERMINAL.has(String(item.latest_run_status))) return false;
    if (runStatus && item.latest_run_status !== runStatus) return false;
    return item.classification !== 'recent';
  });
  return {
    schema: 'narada.sop.run_coverage_since.v1',
    status: 'ok',
    since,
    template_status: templateStatus,
    run_status: runStatus ?? null,
    include_terminal: includeTerminal,
    items,
    count: items.length,
    classification_counts: items.reduce((acc: Record<string, number>, item) => {
      acc[item.classification] = (acc[item.classification] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

function sopRunCancel(args: JsonRecord, state: SopState) {
  return inTransaction(state, () => {
    const runId = requiredString(args.run_id, 'sop_requires_run_id');
    const run = getRunById(runId, state);
    if (run.status === 'cancelled') return { ...runResult(run), cancellation_replayed: true };
    if (run.status === 'completed' || run.status === 'failed') throw diagnosticError('sop_run_already_terminal', `sop_run_already_terminal:${runId}`, { status: run.status });
    cancelRunInternal(runId, optionalBoundedString(args.reason, 'sop_cancellation_reason_too_long', 4096) ?? 'cancelled_by_caller', state, new Set());
    reconcileRunAndAncestors(runId, state);
    return { ...runResult(getRunById(runId, state)), cancellation_replayed: false };
  });
}

function cancelRunInternal(runId: string, reason: string, state: SopState, seen: Set<string>): void {
  if (seen.has(runId)) return;
  seen.add(runId);
  const run = getRunById(runId, state);
  if (RUN_TERMINAL.has(run.status)) return;
  for (const step of run.step_states) {
    if (step.child_run_id) cancelRunInternal(step.child_run_id, `parent_cancelled:${runId}`, state, seen);
    if (step.status === 'pending' || step.status === 'running') skipStep(step, `run_cancelled:${reason}`);
  }
  const now = nowIso();
  state.db.prepare("UPDATE sop_actions SET status = 'cancelled', error_message = ?, updated_at = ?, completed_at = ? WHERE run_id = ? AND status = 'pending'").run(`run_cancelled:${reason}`, now, now, runId);
  cancelSopHandoffsForRun(state.db, runId, `run_cancelled:${reason}`, new Date(now));
  run.status = 'cancelled';
  run.completed_at = now;
  run.output = {};
  run.output_ref = null;
  persistRunState(run, state);
  appendRunEvent(state, runId, null, 'run_cancelled', { reason });
  appendTerminalOutbox(state, run, new Date(now));
}

function sopRunEvents(args: JsonRecord, state: SopState) {
  const runId = requiredString(args.run_id, 'sop_requires_run_id');
  const limit = clamp(integer(args.limit, 50, 1, 500), 1, 500);
  const offset = clamp(integer(args.offset, 0, 0, 100000), 0, 100000);
  const rows = state.db.prepare(
    'SELECT * FROM sop_events WHERE run_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?'
  ).all(runId, limit, offset) as JsonRecord[];
  return { items: rows.map(hydrateEvent), count: rows.length, run_id: runId };
}

function sopOutboxConsumerRegister(args: JsonRecord, state: SopState): JsonRecord {
  return inTransaction(state, () => registerSopOutboxConsumer(state.db, {
    topic: optionalString(args.topic) ?? SOP_TERMINAL_TOPIC,
    consumer_id: requiredString(args.consumer_id, 'sop_outbox_consumer_id_required'),
    start_at: optionalString(args.start_at),
  }));
}

function sopOutboxList(args: JsonRecord, state: SopState): JsonRecord {
  const items = listSopOutbox(state.db, {
    consumer_id: requiredString(args.consumer_id, 'sop_outbox_consumer_id_required'),
    topic: optionalString(args.topic),
    limit: args.limit === undefined ? undefined : Number(args.limit),
  });
  return { schema: 'narada.sop.outbox_list.v1', items, count: items.length };
}

function sopOutboxAck(args: JsonRecord, state: SopState): JsonRecord {
  if (!isJsonObject(args.receipt)) throw diagnosticError('sop_outbox_receipt_must_be_object');
  return inTransaction(state, () => acknowledgeSopOutbox(state.db, {
    event_id: requiredString(args.event_id, 'sop_outbox_event_id_required'),
    consumer_id: requiredString(args.consumer_id, 'sop_outbox_consumer_id_required'),
    receipt: args.receipt as JsonRecord,
  }));
}

function sopOutboxCompact(args: JsonRecord, state: SopState): JsonRecord {
  return inTransaction(state, () => compactSopOutbox(state.db, requiredString(args.before, 'sop_outbox_compact_before_required')));
}

function inTransaction<T>(state: SopState, work: () => T): T {
  if (state.transactionDepth > 0) return work();
  state.db.exec('BEGIN IMMEDIATE');
  state.transactionDepth += 1;
  try {
    const result = work();
    state.db.exec('COMMIT');
    return result;
  } catch (error) {
    state.db.exec('ROLLBACK');
    throw error;
  } finally {
    state.transactionDepth -= 1;
  }
}

function valueContext(run: SopRun): ValueContext {
  return {
    input: run.input,
    input_ref: run.input_ref,
    steps: run.step_states.map((step) => ({ step_id: step.step_id, status: step.status, result: step.result as JsonValue, result_ref: step.result_ref })),
  };
}

function renderInstructions(text: string, context: ValueContext): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_match, ref: string) => {
    const resolved = resolveMapping({ $ref: ref.trim() }, context);
    return typeof resolved === 'string' ? resolved : typeof resolved === 'number' || typeof resolved === 'boolean' ? String(resolved) : canonicalJson(resolved);
  });
}

function reconcileActiveRuns(state: SopState): void {
  const rows = state.db.prepare("SELECT run_id FROM sop_runs WHERE request_fingerprint <> '' AND status NOT IN ('completed','failed','cancelled') ORDER BY created_at ASC").all() as JsonRecord[];
  for (const row of rows) {
    const runId = String(row.run_id);
    try {
      inTransaction(state, () => reconcileRunAndAncestors(runId, state));
    } catch (error) {
      state.startupReconciliationErrors.push({ run_id: runId, diagnostic: errorDiagnostic(error) });
    }
  }
}

type RunLinks = { parent_run_id: string | null; parent_step_id: string | null };
type RunAdmission = { run: SopRun; admission: 'created' | 'replayed' };

function admitRun(args: JsonRecord, state: SopState, links: RunLinks): RunAdmission {
  const sopId = boundedString(args.sop_id, 'sop_requires_sop_id', 256);
  const occurrenceKey = boundedString(args.occurrence_key, 'sop_requires_occurrence_key', 512);
  const triggeredBy = boundedString(args.triggered_by, 'sop_requires_triggered_by', 512);
  const triggerSourceKind = boundedString(args.trigger_source_kind ?? 'manual', 'sop_requires_trigger_source_kind', 128);
  const triggerSourceRef = optionalString(args.trigger_source_ref) ?? '';
  if (triggerSourceRef.length > 2048) throw diagnosticError('sop_trigger_source_ref_too_long', 'sop_trigger_source_ref_too_long', { max_length: 2048 });
  const input = args.input === undefined ? {} : args.input;
  assertInlineValue(input, 'sop_input');
  if (!isJsonObject(input)) throw diagnosticError('sop_input_must_be_object');
  const inputRef = normalizeValueRef(args.input_ref, 'sop_input_ref');
  const existingRow = state.db.prepare('SELECT * FROM sop_runs WHERE sop_id = ? AND occurrence_key = ?').get(sopId, occurrenceKey) as JsonRecord | undefined;
  let version: number;
  if (args.sop_version !== undefined && args.sop_version !== null) {
    version = Number(args.sop_version);
    if (!Number.isInteger(version) || version < 1) throw diagnosticError('sop_invalid_version', `sop_invalid_version:${args.sop_version}`);
  } else if (existingRow) {
    version = Number(existingRow.sop_version);
  } else {
    version = latestRunnableTemplateVersion(sopId, state);
  }
  const template = templateByVersion(sopId, version, state);
  assertNoLegacyEffects(template);
  validateAgainstSchema(template.input_schema, input, 'sop_input_schema_mismatch', { sop_id: sopId, sop_version: version });
  const admissionRequest = {
    sop_id: sopId,
    sop_version: version,
    occurrence_key: occurrenceKey,
    input,
    input_ref: inputRef,
    trigger_source_kind: triggerSourceKind,
    trigger_source_ref: triggerSourceRef,
    triggered_by: triggeredBy,
    parent_run_id: links.parent_run_id,
    parent_step_id: links.parent_step_id,
  };
  const requestFingerprint = fingerprint(admissionRequest);
  if (existingRow) {
    const existing = hydrateRun(existingRow);
    if (existing.request_fingerprint !== requestFingerprint) {
      throw diagnosticError('sop_occurrence_conflict', `sop_occurrence_conflict:${sopId}:${occurrenceKey}`, {
        occurrence_key: occurrenceKey,
        recorded_request_fingerprint: existing.request_fingerprint,
        supplied_request_fingerprint: requestFingerprint,
        recorded_sop_version: existing.sop_version,
        supplied_sop_version: version,
      });
    }
    return { run: existing, admission: 'replayed' };
  }
  if (links.parent_run_id && links.parent_step_id) assertNoRecursiveChild(links.parent_run_id, sopId, version, state);
  const definition = executableDefinition(template);
  assertSerializedBound(definition, 'sop_definition', MAX_TEMPLATE_DEFINITION_BYTES);
  const definitionFingerprint = fingerprint(definition);
  const stepStates = initializeStepStates(template, state);
  assertSerializedBound(stepStates, 'sop_run_state', MAX_RUN_STATE_BYTES);
  const runId = `sop_run_${stamp()}_${randomUUID().slice(0, 8)}`;
  const now = nowIso();
  state.db.prepare(
    'INSERT INTO sop_runs (run_id, sop_id, sop_version, sop_title, status, occurrence_key, request_fingerprint, definition_fingerprint, definition_json, input_json, input_ref_json, output_json, output_ref_json, step_states_json, trigger_source_kind, trigger_source_ref, triggered_by, parent_run_id, parent_step_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    runId, sopId, version, template.title, 'pending', occurrenceKey, requestFingerprint, definitionFingerprint, JSON.stringify(definition), JSON.stringify(input), nullableJson(inputRef), '{}', null, JSON.stringify(stepStates), triggerSourceKind, triggerSourceRef, triggeredBy, links.parent_run_id, links.parent_step_id, now, now,
  );
  appendRunEvent(state, runId, null, 'run_admitted', { sop_id: sopId, sop_version: version, occurrence_key: occurrenceKey, request_fingerprint: requestFingerprint, definition_fingerprint: definitionFingerprint, triggered_by: triggeredBy, parent_run_id: links.parent_run_id, parent_step_id: links.parent_step_id });
  return { run: getRunById(runId, state), admission: 'created' };
}

function latestRunnableTemplateVersion(sopId: string, state: SopState): number {
  const version = Number((state.db.prepare('SELECT MAX(version) as v FROM sop_templates WHERE sop_id = ? AND status != ?').get(sopId, 'deprecated') as JsonRecord | undefined)?.v ?? 0);
  if (!version) throw diagnosticError('sop_no_active_version', `sop_no_active_version:${sopId}`);
  return version;
}

function templateByVersion(sopId: string, version: number, state: SopState): SopTemplate {
  const row = state.db.prepare('SELECT * FROM sop_templates WHERE sop_id = ? AND version = ?').get(sopId, version) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_not_found', `sop_not_found:${sopId}@v${version}`);
  return hydrateTemplate(row);
}

function executableDefinition(template: SopTemplate): JsonRecord {
  return {
    schema: 'narada.sop.definition.v2',
    sop_id: template.sop_id,
    version: template.version,
    title: template.title,
    steps: template.steps,
    input_schema: template.input_schema,
    output: template.output,
    output_ref: template.output_ref,
    output_schema: template.output_schema,
    acceptance_criteria: template.acceptance_criteria,
    evidence_requirements: template.evidence_requirements,
  };
}

function initializeStepStates(template: SopTemplate, state: SopState): SopStepState[] {
  return template.steps.map((step) => {
    let pinnedVersion = step.sop_version;
    let pinnedFingerprint: string | null = null;
    if (step.executor === 'sop') {
      const childSopId = requiredString(step.sop_id, 'sop_step_requires_child_sop_id');
      pinnedVersion = pinnedVersion ?? latestRunnableTemplateVersion(childSopId, state);
      const child = templateByVersion(childSopId, pinnedVersion, state);
      assertNoLegacyEffects(child);
      pinnedFingerprint = fingerprint(executableDefinition(child));
    }
    return {
      step_id: step.id,
      executor: step.executor,
      blocking: step.blocking,
      title: step.title,
      status: 'pending',
      depends_on: [...step.depends_on],
      instructions: step.instructions,
      when: step.when,
      input: step.input,
      input_ref: step.input_ref,
      result_schema: step.result_schema,
      action: step.action,
      sop_id: step.sop_id,
      sop_version: pinnedVersion,
      wait_policy: step.wait_policy,
      pinned_child_definition_fingerprint: pinnedFingerprint,
      child_run_id: null,
      action_id: null,
      started_at: null,
      completed_at: null,
      result: {},
      result_ref: null,
      completion_key: null,
      completion_fingerprint: null,
      error_message: null,
    };
  });
}

function assertNoLegacyEffects(template: SopTemplate): void {
  const legacy = template.steps.filter((step) => step.legacy_command).map((step) => step.id);
  if (legacy.length) throw diagnosticError('sop_legacy_command_unsupported', `sop_legacy_command_unsupported:${template.sop_id}@v${template.version}`, { step_ids: legacy, remediation: 'Replace each command step with a governed action step targeting the domain MCP surface that owns the effect.' });
}

function assertNoRecursiveChild(parentRunId: string, childSopId: string, childVersion: number, state: SopState): void {
  const chain: Array<{ run_id: string; sop_id: string; sop_version: number }> = [];
  let current: string | null = parentRunId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw diagnosticError('sop_parent_chain_cycle', `sop_parent_chain_cycle:${current}`);
    seen.add(current);
    const run = getRunById(current, state);
    chain.push({ run_id: run.run_id, sop_id: run.sop_id, sop_version: run.sop_version });
    if (run.sop_id === childSopId) throw diagnosticError('sop_recursive_child_occurrence', `sop_recursive_child_occurrence:${childSopId}@v${childVersion}`, { ancestor_chain: chain });
    current = run.parent_run_id;
  }
}

function reconcileRunAndAncestors(runId: string, state: SopState): void {
  if (state.reconciling) {
    reconcileRun(runId, state, new Set());
    return;
  }
  state.reconciling = true;
  try {
    let current: string | null = runId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) throw diagnosticError('sop_parent_chain_cycle', `sop_parent_chain_cycle:${current}`);
      seen.add(current);
      reconcileRun(current, state, new Set());
      current = getRunById(current, state).parent_run_id;
    }
  } finally {
    state.reconciling = false;
  }
}

function reconcileRun(runId: string, state: SopState, stack: Set<string>): SopRun {
  if (stack.has(runId)) throw diagnosticError('sop_child_run_cycle', `sop_child_run_cycle:${runId}`);
  stack.add(runId);
  try {
    const run = getRunById(runId, state);
    if (RUN_TERMINAL.has(run.status)) return run;
    if (run.step_states_parse_error) throw diagnosticError('sop_run_corrupt', `sop_run_corrupt:${runId}`, { reason: run.step_states_parse_error });
    let changed = false;
    let progress = true;
    let passes = 0;
    while (progress) {
      progress = false;
      passes += 1;
      if (passes > run.step_states.length * 4 + 8) throw diagnosticError('sop_reconciliation_did_not_converge', `sop_reconciliation_did_not_converge:${runId}`);
      for (const step of run.step_states) {
        if (step.status !== 'running') continue;
        if (step.executor === 'agent' || step.executor === 'operator') {
          const handoff = ensureHandoffIntent(run, step, state);
          if (step.result.handoff_id !== handoff.handoff_id) {
            step.result = { ...step.result, handoff_id: handoff.handoff_id, handoff_occurrence_key: handoff.occurrence_key };
            changed = true;
          }
        } else if (step.executor === 'sop' && step.child_run_id) {
          reconcileRun(step.child_run_id, state, stack);
          const child = getRunById(step.child_run_id, state);
          assertChildRunBinding(run, step, child);
          if (child.status === 'completed') {
            try {
              validateAgainstSchema(step.result_schema, child.output, 'sop_step_result_schema_mismatch', { run_id: runId, step_id: step.step_id });
            } catch (error) {
              const diagnostic = errorDiagnostic(error);
              failStep(step, `${diagnostic.code}:${diagnostic.message}`);
              appendRunEvent(state, runId, step.step_id, 'step_failed', { child_run_id: child.run_id, diagnostic });
              changed = progress = true;
              continue;
            }
            const retained = completeStepWithBoundedRunState(run, step, nowIso(), {
              child_run_id: child.run_id,
              child_sop_id: child.sop_id,
              child_sop_version: child.sop_version,
              child_status: child.status,
              output: child.output,
            }, child.output_ref, {
              child_run_id: child.run_id,
              child_sop_id: child.sop_id,
              child_sop_version: child.sop_version,
              child_status: child.status,
            }, state);
            if (retained) appendRunEvent(state, runId, step.step_id, 'child_sop_completed', { child_run_id: child.run_id, child_status: child.status, output_ref: child.output_ref });
            changed = progress = true;
          } else if (child.status === 'failed' || child.status === 'cancelled') {
            failStep(step, `child_sop_${child.status}:${child.run_id}`);
            step.result = { child_run_id: child.run_id, child_sop_id: child.sop_id, child_sop_version: child.sop_version, child_status: child.status };
            appendRunEvent(state, runId, step.step_id, 'child_sop_failed', { child_run_id: child.run_id, child_status: child.status });
            changed = progress = true;
          }
        } else if (step.executor === 'action' && step.action_id) {
          const action = ensureActionIntent(run, step, state);
          assertActionRunBinding(run, step, action);
          if (action.status === 'completed') {
            try {
              validateAgainstSchema(step.result_schema, action.result, 'sop_step_result_schema_mismatch', { run_id: runId, step_id: step.step_id });
            } catch (error) {
              const diagnostic = errorDiagnostic(error);
              failStep(step, `${diagnostic.code}:${diagnostic.message}`);
              step.result = { action_id: action.action_id, operation_ref: action.operation_ref, surface_id: action.surface_id, tool_name: action.tool_name };
              step.result_ref = action.result_ref;
              appendRunEvent(state, runId, step.step_id, 'step_failed', { action_id: action.action_id, diagnostic });
              changed = progress = true;
              continue;
            }
            completeStepWithBoundedRunState(run, step, action.completed_at ?? nowIso(), {
              ...action.result,
              action_id: action.action_id,
              operation_ref: action.operation_ref,
              surface_id: action.surface_id,
              tool_name: action.tool_name,
            }, action.result_ref, {
              action_id: action.action_id,
              operation_ref: action.operation_ref,
              surface_id: action.surface_id,
              tool_name: action.tool_name,
            }, state);
            changed = progress = true;
          } else if (action.status === 'failed' || action.status === 'cancelled') {
            failStep(step, action.error_message ?? `action_${action.status}:${action.action_id}`);
            step.result = { action_id: action.action_id, operation_ref: action.operation_ref, surface_id: action.surface_id, tool_name: action.tool_name };
            step.result_ref = action.result_ref;
            changed = progress = true;
          }
        }
      }
      for (const step of run.step_states) {
        if (step.status !== 'pending') continue;
        const dependencies = step.depends_on.map((id) => run.step_states.find((candidate) => candidate.step_id === id));
        const failed = dependencies.filter((dependency) => dependency?.status === 'failed').map((dependency) => String(dependency?.step_id));
        if (failed.length) {
          failStep(step, `failed_dependency:${failed.join(',')}`);
          appendRunEvent(state, runId, step.step_id, 'step_failed', { failed_dependencies: failed });
          changed = progress = true;
          continue;
        }
        if (!dependencies.every((dependency) => dependency?.status === 'completed' || dependency?.status === 'skipped')) continue;
        const context = valueContext(run);
        try {
          if (!evaluateCondition(step.when, context)) {
            skipStep(step, 'condition_false');
            appendRunEvent(state, runId, step.step_id, 'step_skipped', { reason: 'condition_false', when: step.when });
            changed = progress = true;
            continue;
          }
          const instructions = renderInstructions(step.instructions, context);
          step.started_at = nowIso();
          if (step.executor === 'engine') {
            step.status = 'completed';
            step.completed_at = nowIso();
            step.result = {};
            appendRunEvent(state, runId, step.step_id, 'step_completed', { executor: 'engine' });
          } else if (step.executor === 'agent' || step.executor === 'operator') {
            const handoff = ensureHandoffIntent(run, step, state, instructions);
            step.status = 'running';
            step.result = { instructions, handoff_id: handoff.handoff_id, handoff_occurrence_key: handoff.occurrence_key };
            appendRunEvent(state, runId, step.step_id, 'step_started', { executor: step.executor, handoff: true, handoff_id: handoff.handoff_id, occurrence_key: handoff.occurrence_key });
          } else if (step.executor === 'action') {
            const action = ensureActionIntent(run, step, state);
            step.status = 'running';
            step.action_id = action.action_id;
            step.result = { instructions, action_id: action.action_id, occurrence_key: action.occurrence_key, surface_id: action.surface_id, tool_name: action.tool_name };
            appendRunEvent(state, runId, step.step_id, 'action_admitted', { action_id: action.action_id, occurrence_key: action.occurrence_key, surface_id: action.surface_id, tool_name: action.tool_name, request_fingerprint: action.request_fingerprint });
          } else if (step.executor === 'sop') {
            const child = startChildSopRun(run, step, state);
            step.status = 'running';
            step.child_run_id = child.run_id;
            step.result = { instructions, child_run_id: child.run_id, child_sop_id: child.sop_id, child_sop_version: child.sop_version, child_status: child.status, wait_policy: 'wait' };
            appendRunEvent(state, runId, step.step_id, 'child_sop_admitted', { child_run_id: child.run_id, child_sop_id: child.sop_id, child_sop_version: child.sop_version, child_definition_fingerprint: child.definition_fingerprint });
          } else {
            throw diagnosticError('sop_invalid_executor', `sop_invalid_executor:${step.executor}`);
          }
          changed = progress = true;
        } catch (error) {
          const diagnostic = errorDiagnostic(error);
          failStep(step, `${diagnostic.code}:${diagnostic.message}`);
          appendRunEvent(state, runId, step.step_id, 'step_failed', { diagnostic });
          changed = progress = true;
        }
      }
    }
    const priorStatus = run.status;
    if (run.step_states.every((step) => STEP_TERMINAL.has(step.status))) {
      run.status = run.step_states.some((step) => step.status === 'failed') ? 'failed' : 'completed';
      if (run.status === 'completed') {
        try {
          deriveRunOutput(run);
        } catch (error) {
          const diagnostic = errorDiagnostic(error);
          run.status = 'failed';
          run.output = {};
          run.output_ref = null;
          appendRunEvent(state, runId, null, 'run_output_failed', { diagnostic });
        }
      } else { run.output = {}; run.output_ref = null; }
      run.completed_at = run.completed_at ?? nowIso();
    } else {
      run.status = run.step_states.some((step) => step.status === 'running' && (step.executor === 'agent' || step.executor === 'operator')) ? 'awaiting_confirmation' : 'running';
      run.completed_at = null;
    }
    if (changed || priorStatus !== run.status) {
      persistRunState(run, state);
      if (priorStatus !== run.status) {
        appendRunEvent(state, runId, null, RUN_TERMINAL.has(run.status) ? (run.status === 'completed' ? 'run_completed' : 'run_failed') : 'run_state_changed', { from: priorStatus, to: run.status, step_states: run.step_states.map((step) => ({ step_id: step.step_id, status: step.status })) });
        if (RUN_TERMINAL.has(run.status)) appendTerminalOutbox(state, run);
      }
    }
    return run;
  } finally {
    stack.delete(runId);
  }
}

function failStep(step: SopStepState, message: string): void {
  step.status = 'failed';
  step.completed_at = nowIso();
  step.error_message = message;
}

function skipStep(step: SopStepState, reason: string): void {
  step.status = 'skipped';
  step.completed_at = nowIso();
  step.result = { reason };
  step.error_message = null;
}

function deriveRunOutput(run: SopRun): void {
  const definition = asRecord(run.definition);
  const outputMapping = definition.output as JsonValue | null | undefined;
  const outputRefMapping = definition.output_ref as JsonValue | null | undefined;
  const output = outputMapping === undefined || outputMapping === null ? {} : resolveMapping(outputMapping, valueContext(run));
  assertInlineValue(output, 'sop_output');
  if (!isJsonObject(output)) throw diagnosticError('sop_output_must_be_object');
  validateAgainstSchema(asNullableRecord(definition.output_schema), output, 'sop_output_schema_mismatch', { run_id: run.run_id });
  const outputRefValue = outputRefMapping === undefined || outputRefMapping === null ? null : resolveMapping(outputRefMapping, valueContext(run));
  run.output = output;
  run.output_ref = normalizeValueRef(outputRefValue, 'sop_output_ref');
}

function persistRunState(run: SopRun, state: SopState): void {
  assertSerializedBound(run.step_states, 'sop_run_state', MAX_RUN_STATE_BYTES);
  const now = nowIso();
  run.updated_at = now;
  state.db.prepare('UPDATE sop_runs SET status = ?, output_json = ?, output_ref_json = ?, step_states_json = ?, updated_at = ?, completed_at = ? WHERE run_id = ?').run(
    run.status, JSON.stringify(run.output), nullableJson(run.output_ref), JSON.stringify(run.step_states), now, run.completed_at, run.run_id,
  );
}

function ensureHandoffIntent(run: SopRun, step: SopStepState, state: SopState, renderedInstructions?: string) {
  if (step.executor !== 'agent' && step.executor !== 'operator') {
    throw diagnosticError('sop_step_not_manual_handoff', `sop_step_not_manual_handoff:${step.step_id}`, { executor: step.executor });
  }
  const context = valueContext(run);
  const input = step.input === null ? {} : resolveMapping(step.input, context);
  assertInlineValue(input, 'sop_handoff_input');
  const inputRefValue = step.input_ref === null ? null : resolveMapping(step.input_ref, context);
  const inputRef = normalizeValueRef(inputRefValue, 'sop_handoff_input_ref');
  const instructions = renderedInstructions ?? String(step.result.instructions ?? renderInstructions(step.instructions, context));
  return ensureSopHandoff(state.db, {
    run_id: run.run_id,
    step_id: step.step_id,
    sop_id: run.sop_id,
    sop_version: run.sop_version,
    executor: step.executor,
    title: step.title,
    instructions,
    input,
    input_ref: inputRef,
    result_schema: step.result_schema,
  });
}

function ensureActionIntent(run: SopRun, step: SopStepState, state: SopState): SopAction {
  if (!step.action) throw diagnosticError('sop_action_binding_required', `sop_action_binding_required:${step.step_id}`);
  const actionId = deterministicId('soa_', `${run.run_id}\0${step.step_id}`);
  const occurrenceKey = deterministicId('sop_action_', `${run.run_id}\0${step.step_id}`);
  const mapped = resolveMapping(step.action.arguments, valueContext(run));
  if (!isJsonObject(mapped)) throw diagnosticError('sop_action_arguments_must_be_object', `sop_action_arguments_must_be_object:${step.step_id}`);
  const argumentsObject: JsonRecord = { ...mapped };
  const idempotencyField = step.action.idempotency_key_argument;
  if (Object.hasOwn(argumentsObject, idempotencyField) && argumentsObject[idempotencyField] !== occurrenceKey) throw diagnosticError('sop_action_idempotency_argument_conflict', `sop_action_idempotency_argument_conflict:${step.step_id}`, { field: idempotencyField });
  argumentsObject[idempotencyField] = occurrenceKey;
  assertInlineValue(argumentsObject, 'sop_action_arguments');
  const requestFingerprint = fingerprint({ surface_id: step.action.surface_id, tool_name: step.action.tool_name, arguments: argumentsObject });
  const existing = state.db.prepare('SELECT * FROM sop_actions WHERE run_id = ? AND step_id = ?').get(run.run_id, step.step_id) as JsonRecord | undefined;
  if (existing) {
    const action = hydrateAction(existing);
    if (action.action_id !== actionId || action.request_fingerprint !== requestFingerprint) throw diagnosticError('sop_action_intent_conflict', `sop_action_intent_conflict:${run.run_id}:${step.step_id}`);
    return action;
  }
  const now = nowIso();
  state.db.prepare('INSERT INTO sop_actions (action_id, run_id, step_id, occurrence_key, surface_id, tool_name, arguments_json, request_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    actionId, run.run_id, step.step_id, occurrenceKey, step.action.surface_id, step.action.tool_name, JSON.stringify(argumentsObject), requestFingerprint, 'pending', now, now,
  );
  return hydrateAction(actionRow(actionId, state));
}

function getRunById(runId: string, state: SopState): SopRun {
  const row = state.db.prepare('SELECT * FROM sop_runs WHERE run_id = ?').get(runId) as JsonRecord | undefined;
  if (!row) throw diagnosticError('sop_run_not_found', `sop_run_not_found:${runId}`);
  return hydrateRun(row);
}

function startChildSopRun(parentRun: SopRun, stepState: SopStepState, state: SopState): SopRun {
  const childSopId = stepState.sop_id;
  const childVersion = stepState.sop_version;
  if (!childSopId || !childVersion) throw diagnosticError('sop_step_requires_pinned_child', `sop_step_requires_pinned_child:${stepState.step_id}`);
  const context = valueContext(parentRun);
  const childInput = stepState.input === null ? {} : resolveMapping(stepState.input, context);
  assertInlineValue(childInput, 'sop_input');
  if (!isJsonObject(childInput)) throw diagnosticError('sop_child_input_must_be_object', `sop_child_input_must_be_object:${stepState.step_id}`);
  const childInputRefValue = stepState.input_ref === null ? null : resolveMapping(stepState.input_ref, context);
  const childInputRef = normalizeValueRef(childInputRefValue, 'sop_input_ref');
  const occurrenceKey = deterministicId('sop_child_', `${parentRun.occurrence_key}\0${parentRun.run_id}\0${stepState.step_id}`);
  const admitted = admitRun({
    sop_id: childSopId,
    sop_version: childVersion,
    occurrence_key: occurrenceKey,
    input: childInput,
    input_ref: childInputRef,
    trigger_source_kind: 'parent_sop_step',
    trigger_source_ref: `${parentRun.run_id}:${stepState.step_id}`,
    triggered_by: `sop:${parentRun.run_id}`,
  }, state, { parent_run_id: parentRun.run_id, parent_step_id: stepState.step_id });
  assertChildRunBinding(parentRun, stepState, admitted.run);
  reconcileRun(admitted.run.run_id, state, new Set());
  return getRunById(admitted.run.run_id, state);
}

function assertChildRunBinding(parentRun: SopRun, step: SopStepState, child: SopRun): void {
  const expectedOccurrenceKey = deterministicId('sop_child_', `${parentRun.occurrence_key}\0${parentRun.run_id}\0${step.step_id}`);
  const identityMatches = child.parent_run_id === parentRun.run_id
    && child.parent_step_id === step.step_id
    && child.sop_id === step.sop_id
    && child.sop_version === step.sop_version
    && child.occurrence_key === expectedOccurrenceKey;
  if (!identityMatches) {
    throw diagnosticError('sop_child_run_binding_mismatch', `sop_child_run_binding_mismatch:${parentRun.run_id}:${step.step_id}`, {
      parent_run_id: parentRun.run_id,
      step_id: step.step_id,
      child_run_id: child.run_id,
    });
  }
  if (!step.pinned_child_definition_fingerprint || child.definition_fingerprint !== step.pinned_child_definition_fingerprint) {
    throw diagnosticError('sop_child_definition_pin_mismatch', `sop_child_definition_pin_mismatch:${step.step_id}`, {
      expected: step.pinned_child_definition_fingerprint,
      actual: child.definition_fingerprint,
    });
  }
}

function assertActionRunBinding(run: SopRun, step: SopStepState, action: SopAction): void {
  if (!step.action || step.action_id !== action.action_id || action.run_id !== run.run_id || action.step_id !== step.step_id
    || action.surface_id !== step.action.surface_id || action.tool_name !== step.action.tool_name) {
    throw diagnosticError('sop_action_run_binding_mismatch', `sop_action_run_binding_mismatch:${run.run_id}:${step.step_id}`, {
      run_id: run.run_id,
      step_id: step.step_id,
      action_id: action.action_id,
    });
  }
}

function validateSteps(steps: JsonRecord[], _state: SopState, ownerSopId?: string): SopStep[] {
  const validated: SopStep[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    const id = boundedString(step.id, 'sop_step_requires_id', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw diagnosticError('sop_step_id_invalid', `sop_step_id_invalid:${id}`);
    if (ids.has(id)) throw diagnosticError('sop_duplicate_step_id', `sop_duplicate_step_id:${id}`);
    ids.add(id);
    const executor = requiredString(step.executor, 'sop_step_requires_executor', { step_id: id });
    if (!STEP_EXECUTORS.includes(executor as typeof STEP_EXECUTORS[number])) throw diagnosticError('sop_invalid_executor', `sop_invalid_executor:${executor}`, { step_id: id, allowed: STEP_EXECUTORS });
    for (const legacyField of ['command', 'args', 'timeout_ms', 'cwd']) {
      if (step[legacyField] !== undefined) throw diagnosticError('sop_effect_must_be_governed_action', `sop_effect_must_be_governed_action:${id}`, { step_id: id, legacy_field: legacyField, remediation: 'Use executor=action with an owning MCP surface/tool and idempotency_key_argument.' });
    }
    const blocking = executor === 'agent' || executor === 'operator';
    if (step.blocking !== undefined && Boolean(step.blocking) !== blocking) throw diagnosticError('sop_blocking_semantics_fixed', `sop_blocking_semantics_fixed:${id}`, { executor, required_blocking: blocking });
    const sopId = optionalString(step.sop_id);
    const sopVersion = step.sop_version !== undefined && step.sop_version !== null ? Number(step.sop_version) : null;
    const waitPolicy = optionalString(step.wait_policy) ?? (executor === 'sop' ? 'wait' : null);
    if (executor === 'sop') {
      if (!sopId) throw diagnosticError('sop_step_requires_child_sop_id', `sop_step_requires_child_sop_id:${id}`, { step_id: id });
      if (ownerSopId && sopId === ownerSopId) throw diagnosticError('sop_recursive_child_definition', `sop_recursive_child_definition:${ownerSopId}`, { step_id: id });
      if (waitPolicy !== 'wait') throw diagnosticError('sop_invalid_wait_policy', `sop_invalid_wait_policy:${waitPolicy}`, { step_id: id, allowed: ['wait'] });
      if (sopVersion !== null && (!Number.isInteger(sopVersion) || sopVersion < 1)) throw diagnosticError('sop_invalid_child_sop_version', `sop_invalid_child_sop_version:${sopVersion}`, { step_id: id });
    } else if (sopId || sopVersion !== null || step.wait_policy !== undefined) {
      throw diagnosticError('sop_child_fields_require_sop_executor', `sop_child_fields_require_sop_executor:${id}`);
    }
    const when = normalizeCondition(step.when, `steps.${id}.when`);
    const input = optionalJsonValue(step.input, `steps.${id}.input`);
    const inputRef = optionalJsonValue(step.input_ref, `steps.${id}.input_ref`);
    const resultSchema = optionalJsonSchema(step.result_schema, `steps.${id}.result_schema`);
    const action = normalizeActionBinding(step.action, id);
    validateMappingReferences(input);
    validateMappingReferences(inputRef);
    validateMappingReferences(action?.arguments);
    if (executor === 'action' && !action) throw diagnosticError('sop_action_binding_required', `sop_action_binding_required:${id}`);
    if (executor !== 'action' && action) throw diagnosticError('sop_action_binding_requires_action_executor', `sop_action_binding_requires_action_executor:${id}`);
    validated.push({
      id,
      executor,
      blocking,
      title: boundedString(step.title, 'sop_step_requires_title', 512),
      depends_on: stringList(step.depends_on),
      instructions: boundedString(step.instructions, 'sop_step_requires_instructions', 16 * 1024),
      when,
      input,
      input_ref: inputRef,
      result_schema: resultSchema,
      action,
      sop_id: sopId,
      sop_version: sopVersion,
      wait_policy: waitPolicy,
      legacy_command: null,
    });
  }
  validateDag(validated);
  validateStepReferences(validated);
  return validated;
}

function appendSopEvent(state: SopState, eventKind: string, details: JsonRecord): string {
  const eventId = `soe_${randomUUID().slice(0, 12)}`;
  state.db.prepare('INSERT INTO sop_events (event_id, run_id, step_id, event_kind, details_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, '', '', eventKind, JSON.stringify(details), nowIso());
  return eventId;
}

function appendRunEvent(state: SopState, runId: string, stepId: string | null, eventKind: string, details: JsonRecord) {
  const eventId = `soe_${randomUUID().slice(0, 12)}`;
  state.db.prepare('INSERT INTO sop_events (event_id, run_id, step_id, event_kind, details_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, runId, stepId ?? '', eventKind, JSON.stringify(details), nowIso());
}

function appendTerminalOutbox(state: SopState, run: SopRun, now?: Date): void {
  if (state.transactionDepth <= 0) throw diagnosticError('sop_terminal_outbox_requires_transaction', `sop_terminal_outbox_requires_transaction:${run.run_id}`);
  putSopTerminalOutbox(state.db, run, now);
}

function hydrateTemplate(row: JsonRecord): SopTemplate {
  const steps: JsonRecord[] = JSON.parse(String(row.steps_json));
  const migrated = steps.map(migrateStep);
  validateDag(migrated);
  validateStepReferences(migrated);
  const template: SopTemplate = {
    schema: 'narada.sop.template.v2',
    render_mode: 'summary_text_with_full_structured_content',
    full_step_definitions_path: 'structuredContent.steps',
    sop_id: String(row.sop_id),
    version: Number(row.version),
    title: String(row.title),
    status: normalizeTemplateStatus(row.status),
    description: String(row.description),
    steps: migrated,
    trigger_kind: normalizeTriggerKind(row.trigger_kind),
    input_schema: parseNullableJsonObject(row.input_schema_json),
    output: parseNullableJsonValue(row.output_mapping_json),
    output_ref: parseNullableJsonValue(row.output_ref_mapping_json),
    output_schema: parseNullableJsonObject(row.output_schema_json),
    acceptance_criteria: stringList(JSON.parse(String(row.acceptance_criteria_json))),
    evidence_requirements: stringList(JSON.parse(String(row.evidence_requirements_json))),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
  assertTemplateBound({
    sop_id: template.sop_id,
    title: template.title,
    steps: template.steps,
    input_schema: template.input_schema,
    output: template.output,
    output_ref: template.output_ref,
    output_schema: template.output_schema,
    acceptance_criteria: template.acceptance_criteria,
    evidence_requirements: template.evidence_requirements,
  });
  return template;
}

function migrateStep(step: JsonRecord): SopStep {
  const executor = String(step.executor ?? (step.kind === 'manual' ? 'operator' : step.kind === 'note' ? 'engine' : step.kind));
  if (!STEP_EXECUTORS.includes(executor as typeof STEP_EXECUTORS[number])) {
    throw diagnosticError('sop_persisted_step_executor_invalid', `sop_persisted_step_executor_invalid:${executor}`, { executor, step_id: step.id ?? null });
  }
  const normalizedExecutor = executor;
  return {
    id: String(step.id),
    executor: normalizedExecutor,
    blocking: normalizedExecutor === 'agent' || normalizedExecutor === 'operator',
    title: String(step.title),
    depends_on: Array.isArray(step.depends_on) ? step.depends_on.map(String) : [],
    instructions: String(step.instructions),
    when: normalizeCondition(step.when),
    input: parseEmbeddedJsonValue(step.input),
    input_ref: parseEmbeddedJsonValue(step.input_ref),
    result_schema: asNullableRecord(step.result_schema),
    action: migrateActionBinding(step.action),
    sop_id: step.sop_id != null ? String(step.sop_id) : null,
    sop_version: step.sop_version != null ? Number(step.sop_version) : null,
    wait_policy: step.wait_policy != null ? String(step.wait_policy) : (normalizedExecutor === 'sop' ? 'wait' : null),
    legacy_command: step.command != null ? String(step.command) : null,
  };
}

function migrateStepState(step: JsonRecord): SopStepState {
  const migrated = migrateStep(step);
  const status = String(step.status ?? 'pending');
  if (!STEP_STATUSES.includes(status as typeof STEP_STATUSES[number])) {
    throw diagnosticError('sop_persisted_step_status_invalid', `sop_persisted_step_status_invalid:${status}`, { status, step_id: step.step_id ?? migrated.id });
  }
  const result = step.result === undefined || step.result === null ? {} : step.result;
  if (!isJsonObject(result)) throw diagnosticError('sop_persisted_step_result_invalid', 'sop_persisted_step_result_invalid', { step_id: step.step_id ?? migrated.id });
  return {
    step_id: String(step.step_id ?? migrated.id),
    executor: migrated.executor,
    blocking: migrated.blocking,
    title: migrated.title,
    status,
    depends_on: migrated.depends_on,
    instructions: migrated.instructions,
    when: migrated.when,
    input: migrated.input,
    input_ref: migrated.input_ref,
    result_schema: migrated.result_schema,
    action: migrated.action,
    sop_id: migrated.sop_id,
    sop_version: migrated.sop_version,
    wait_policy: migrated.wait_policy,
    pinned_child_definition_fingerprint: optionalString(step.pinned_child_definition_fingerprint),
    child_run_id: step.child_run_id != null ? String(step.child_run_id) : (asRecord(step.result).child_run_id != null ? String(asRecord(step.result).child_run_id) : null),
    action_id: step.action_id != null ? String(step.action_id) : (asRecord(step.result).action_id != null ? String(asRecord(step.result).action_id) : null),
    started_at: step.started_at != null ? String(step.started_at) : null,
    completed_at: step.completed_at != null ? String(step.completed_at) : null,
    result,
    result_ref: normalizeValueRef(step.result_ref, 'sop_result_ref'),
    completion_key: optionalString(step.completion_key),
    completion_fingerprint: optionalString(step.completion_fingerprint),
    error_message: step.error_message != null ? String(step.error_message) : null,
  };
}

function hydrateRun(row: JsonRecord): SopRun {
  let stepStates: SopStepState[];
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(String(row.step_states_json));
    if (!Array.isArray(parsed)) {
      parseError = 'step_states_json is not an array';
      stepStates = [];
    } else {
      stepStates = parsed.map((s) => migrateStepState(asRecord(s)));
      validateDag(stepStates.map((step) => ({ id: step.step_id, depends_on: step.depends_on })));
      validateStepReferences(stepStates.map((step) => ({
        id: step.step_id,
        depends_on: step.depends_on,
        instructions: step.instructions,
        when: step.when,
        input: step.input,
        input_ref: step.input_ref,
        action: step.action,
      })));
      for (const step of stepStates) {
        if (step.status === 'running' && step.executor === 'action' && !step.action_id) throw diagnosticError('sop_run_corrupt', 'sop_run_corrupt', { step_id: step.step_id, reason: 'running_action_missing_action_id' });
        if (step.status === 'running' && step.executor === 'sop' && !step.child_run_id) throw diagnosticError('sop_run_corrupt', 'sop_run_corrupt', { step_id: step.step_id, reason: 'running_child_missing_child_run_id' });
        if (Boolean(step.completion_key) !== Boolean(step.completion_fingerprint)) throw diagnosticError('sop_run_corrupt', 'sop_run_corrupt', { step_id: step.step_id, reason: 'incomplete_completion_identity' });
      }
    }
  } catch (e) {
    parseError = String(e instanceof Error ? e.message : e);
    stepStates = [];
  }
  const runId = String(row.run_id);
  const sopId = String(row.sop_id);
  const sopVersion = Number(row.sop_version);
  const status = String(row.status);
  if (!RUN_STATUSES.includes(status as typeof RUN_STATUSES[number])) throw diagnosticError('sop_run_status_invalid', `sop_run_status_invalid:${status}`, { run_id: runId });
  const occurrenceKey = String(row.occurrence_key ?? '');
  const requestFingerprint = String(row.request_fingerprint ?? '');
  const definitionFingerprint = String(row.definition_fingerprint ?? '');
  const definition = parseJsonObject(row.definition_json, {});
  const input = parseJsonValue(row.input_json, {});
  const inputRef = normalizeValueRef(parseNullableJsonValue(row.input_ref_json), 'sop_input_ref');
  const triggerSourceKind = String(row.trigger_source_kind);
  const triggerSourceRef = String(row.trigger_source_ref);
  const triggeredBy = String(row.triggered_by);
  const parentRunId = optionalString(row.parent_run_id);
  const parentStepId = optionalString(row.parent_step_id);
  if (definitionFingerprint) {
    if (definition.schema !== 'narada.sop.definition.v2' || definition.sop_id !== sopId || Number(definition.version) !== sopVersion) {
      throw diagnosticError('sop_definition_identity_mismatch', `sop_definition_identity_mismatch:${runId}`, { run_id: runId });
    }
    const actualDefinitionFingerprint = fingerprint(definition);
    if (actualDefinitionFingerprint !== definitionFingerprint) {
      throw diagnosticError('sop_definition_fingerprint_mismatch', `sop_definition_fingerprint_mismatch:${runId}`, { run_id: runId, expected: definitionFingerprint, actual: actualDefinitionFingerprint });
    }
    if (!parseError) assertRunStepDefinitionsMatch(runId, definition, stepStates);
  }
  if (requestFingerprint) {
    const actualRequestFingerprint = fingerprint({
      sop_id: sopId,
      sop_version: sopVersion,
      occurrence_key: occurrenceKey,
      input,
      input_ref: inputRef,
      trigger_source_kind: triggerSourceKind,
      trigger_source_ref: triggerSourceRef,
      triggered_by: triggeredBy,
      parent_run_id: parentRunId,
      parent_step_id: parentStepId,
    });
    if (actualRequestFingerprint !== requestFingerprint) {
      throw diagnosticError('sop_request_fingerprint_mismatch', `sop_request_fingerprint_mismatch:${runId}`, { run_id: runId, expected: requestFingerprint, actual: actualRequestFingerprint });
    }
  }
  return {
    run_id: runId,
    sop_id: sopId,
    sop_version: sopVersion,
    sop_title: String(row.sop_title),
    status,
    occurrence_key: occurrenceKey,
    request_fingerprint: requestFingerprint,
    definition_fingerprint: definitionFingerprint,
    definition,
    input,
    input_ref: inputRef,
    output: parseJsonValue(row.output_json, {}),
    output_ref: normalizeValueRef(parseNullableJsonValue(row.output_ref_json), 'sop_output_ref'),
    step_states: stepStates,
    step_states_parse_error: parseError,
    trigger_source_kind: triggerSourceKind,
    trigger_source_ref: triggerSourceRef,
    triggered_by: triggeredBy,
    parent_run_id: parentRunId,
    parent_step_id: parentStepId,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: optionalString(row.completed_at) || null,
  };
}

function hydrateEvent(row: JsonRecord): SopEvent {
  return {
    event_id: String(row.event_id),
    run_id: String(row.run_id),
    step_id: String(row.step_id),
    event_kind: String(row.event_kind),
    details: JSON.parse(String(row.details_json)),
    recorded_at: String(row.recorded_at),
  };
}

function renderResult(result: JsonRecord): string {
  if (result.status === 'created' || result.status === 'updated' || result.status === 'deprecated' || result.status === 'unchanged') {
    return [
      `sop_template: ${result.status}`,
      `sop_id: ${result.sop_id ?? ''}`,
      `version: ${result.version ?? ''}`,
      `title: ${result.title ?? ''}`,
      result.previous_version ? `previous_version: ${result.previous_version}` : '',
      `step_count: ${result.step_count ?? ''}`,
    ].filter(Boolean).join('\n');
  }
  if (result.items !== undefined) {
    const items = result.items as JsonRecord[];
    const header = items.length > 0 && items[0].event_kind
      ? [`events: ${result.count ?? 0}`]
      : result.schema === 'narada.sop.template_candidates.v1'
        ? [`sop_template_candidates: ${result.count ?? 0}${result.total_count !== undefined ? `/${result.total_count}` : ''}`]
      : [`sop_list: ${result.count ?? 0}`];
    const lines = items.map((item) => {
      if (item.event_kind) {
        return `  ${item.event_kind}: step=${item.step_id || '-'} at ${(String(item.recorded_at ?? '')).slice(0, 19)}`;
      }
      if (item.import_status) {
        return `  ${item.sop_id ?? ''}: ${item.title ?? item.file_name ?? ''} [${item.import_status}]`;
      }
      return `  ${item.sop_id ?? item.run_id ?? ''}: ${item.title ?? item.sop_title ?? ''} [${item.status ?? ''}]`;
    });
    return [...header, ...lines].join('\n');
  }
  if (result.run_id) {
    const steps = (result.step_states as JsonRecord[] | undefined) ?? [];
    const stepSummary = steps.map((s) => {
      const marker = s.status === 'running' ? '>' : s.status === 'completed' ? '+' : s.status === 'failed' ? '!' : ' ';
      return `  ${marker} ${s.step_id} [${s.executor ?? '?'}${s.blocking ? ':block' : ''}] ${s.status}`;
    });
    return [
      `sop_run: ${result.status ?? 'ok'}`,
      `run_id: ${result.run_id}`,
      `sop_id: ${result.sop_id ?? ''}`,
      result.sop_title ? `title: ${result.sop_title}` : '',
      result.completed_at ? `completed_at: ${result.completed_at}` : '',
      result.next_awaits_confirmation ? 'next_awaits_confirmation: true' : '',
      result.next_step ? `next_step: ${(result.next_step as JsonRecord).step_id} (${(result.next_step as JsonRecord).executor}) — ${String((result.next_step as JsonRecord).instructions ?? '').slice(0, 120)}` : '',
      ...stepSummary,
    ].filter(Boolean).join('\n');
  }
  if (Array.isArray(result.steps)) {
    return [
      `sop_template: ${result.sop_id} v${result.version} [${result.status}]`,
      `title: ${result.title ?? ''}`,
      `description: ${String(result.description ?? '').slice(0, 120)}`,
      `trigger: ${result.trigger_kind ?? ''}`,
      `render_mode: ${result.render_mode ?? 'summary_text'}`,
      `full_step_definitions: ${result.full_step_definitions_path ?? 'structuredContent.steps'}`,
      `steps_summary: ${(result.steps as JsonRecord[]).map((s: JsonRecord) => `${s.id} (${s.executor}${s.blocking ? ':block' : ''})`).join(', ')}`,
      result.acceptance_criteria ? `criteria: ${JSON.stringify(result.acceptance_criteria)}` : '',
    ].filter(Boolean).join('\n');
  }
  return result.status ? `sop: ${result.status}` : 'sop: ok';
}

function optionalJsonValue(value: unknown, field: string): JsonValue | null {
  if (value === undefined || value === null) return null;
  assertInlineValue(value, field);
  return value;
}

function optionalJsonSchema(value: unknown, field: string): JsonRecord | null {
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) throw diagnosticError('sop_json_schema_must_be_object', `sop_json_schema_must_be_object:${field}`, { field });
  assertInlineValue(value, 'sop_json_schema');
  try {
    ajv.compile(value);
  } catch (error) {
    throw diagnosticError('sop_json_schema_invalid', `sop_json_schema_invalid:${field}`, { field, message: error instanceof Error ? error.message : String(error) });
  }
  return value;
}

function validateAgainstSchema(schema: JsonRecord | null, value: unknown, code: string, details: JsonRecord = {}): void {
  if (!schema) return;
  let validator: ReturnType<typeof ajv.compile>;
  try {
    validator = ajv.compile(schema);
  } catch (error) {
    throw diagnosticError('sop_pinned_schema_invalid', 'sop_pinned_schema_invalid', { ...details, message: error instanceof Error ? error.message : String(error) });
  }
  if (!validator(value)) {
    throw diagnosticError(code, code, { ...details, errors: (validator.errors ?? []).map((entry) => ({ instance_path: entry.instancePath, keyword: entry.keyword, message: entry.message })) });
  }
}

function normalizeActionBinding(value: unknown, stepId: string): ActionBinding | null {
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) throw diagnosticError('sop_action_binding_invalid', `sop_action_binding_invalid:${stepId}`, { reason: 'must_be_object' });
  const allowed = new Set(['surface_id', 'tool_name', 'arguments', 'idempotency_key_argument']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw diagnosticError('sop_action_binding_invalid', `sop_action_binding_invalid:${stepId}`, { reason: 'unknown_fields', fields: unknown });
  const surfaceId = boundedString(value.surface_id, 'sop_action_requires_surface_id', 256);
  const toolName = boundedString(value.tool_name, 'sop_action_requires_tool_name', 256);
  const idempotencyField = boundedString(value.idempotency_key_argument, 'sop_action_requires_idempotency_key_argument', 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(idempotencyField)) throw diagnosticError('sop_action_idempotency_key_argument_invalid', `sop_action_idempotency_key_argument_invalid:${idempotencyField}`);
  const argumentsValue = value.arguments ?? {};
  assertInlineValue(argumentsValue, 'sop_action_arguments_mapping');
  if (!isJsonObject(argumentsValue)) throw diagnosticError('sop_action_arguments_must_be_object', `sop_action_arguments_must_be_object:${stepId}`);
  if (Object.hasOwn(argumentsValue, idempotencyField)) throw diagnosticError('sop_action_idempotency_argument_reserved', `sop_action_idempotency_argument_reserved:${stepId}`, { field: idempotencyField });
  return { surface_id: surfaceId, tool_name: toolName, arguments: argumentsValue, idempotency_key_argument: idempotencyField };
}

function migrateActionBinding(value: unknown): ActionBinding | null {
  if (value === undefined || value === null) return null;
  return normalizeActionBinding(value, 'persisted');
}

function validateOutputReferences(mapping: JsonValue | null, steps: SopStep[]): void {
  if (mapping === null) return;
  validateMappingReferences(mapping);
  const ids = new Set(steps.map((step) => step.id));
  for (const reference of collectStepReferences(mapping)) {
    if (!ids.has(reference)) throw diagnosticError('sop_output_reference_unknown', `sop_output_reference_unknown:${reference}`);
  }
}

function assertTemplateBound(value: unknown): void {
  assertSerializedBound(value, 'sop_template_definition', MAX_TEMPLATE_DEFINITION_BYTES);
}

function parseNullableJsonValue(value: unknown): JsonValue | null {
  if (value === undefined || value === null || value === '') return null;
  return parseJsonValue(value, null);
}

function parseNullableJsonObject(value: unknown): JsonRecord | null {
  const parsed = parseNullableJsonValue(value);
  if (parsed === null) return null;
  if (!isJsonObject(parsed)) throw diagnosticError('sop_persisted_json_object_invalid');
  return parsed;
}

function parseEmbeddedJsonValue(value: unknown): JsonValue | null {
  if (value === undefined || value === null) return null;
  assertInlineValue(value, 'sop_persisted_mapping');
  return value;
}

function parseJsonValue(value: unknown, fallback: JsonValue): JsonValue {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  assertInlineValue(parsed, 'sop_persisted_value', MAX_RUN_STATE_BYTES);
  return parsed;
}

function parseJsonObject(value: unknown, fallback: JsonRecord): JsonRecord {
  const parsed = parseJsonValue(value, fallback as JsonValue);
  if (!isJsonObject(parsed)) throw diagnosticError('sop_persisted_json_object_invalid');
  return parsed;
}

function asNullableRecord(value: unknown): JsonRecord | null {
  if (value === undefined || value === null) return null;
  return isJsonObject(value) ? value : null;
}

function nullableJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function boundedString(value: unknown, code: string, maxLength: number): string {
  const text = requiredString(value, code);
  if (text.length > maxLength) throw diagnosticError(`${code}_too_long`, `${code}_too_long`, { length: text.length, max_length: maxLength });
  return text;
}

function runSummary(run: SopRun): JsonRecord {
  return {
    schema: 'narada.sop.run_summary.v2',
    run_id: run.run_id,
    sop_id: run.sop_id,
    sop_version: run.sop_version,
    sop_title: run.sop_title,
    occurrence_key: run.occurrence_key,
    status: run.status,
    parent_run_id: run.parent_run_id,
    parent_step_id: run.parent_step_id,
    created_at: run.created_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
  };
}

function requiredString(value: unknown, code: string, details: JsonRecord = {}): string {
  const text = String(value ?? '').trim();
  if (!text) throw diagnosticError(code, code, details);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function optionalBoundedString(value: unknown, code: string, maxLength: number): string | null {
  const text = optionalString(value);
  if (text === null) return null;
  if (text.length > maxLength) throw diagnosticError(code, code, { length: text.length, max_length: maxLength });
  return text;
}

function normalizeTriggerKind(value: unknown): string {
  const triggerKind = optionalString(value) ?? 'manual';
  if (!TRIGGER_KINDS.includes(triggerKind as typeof TRIGGER_KINDS[number])) {
    throw diagnosticError('sop_invalid_trigger_kind', `sop_invalid_trigger_kind:${triggerKind}`, { trigger_kind: triggerKind, allowed: TRIGGER_KINDS });
  }
  return triggerKind;
}

function normalizeTemplateStatus(value: unknown): string {
  const status = optionalString(value) ?? 'draft';
  if (!TEMPLATE_STATUSES.includes(status as typeof TEMPLATE_STATUSES[number])) {
    throw diagnosticError('sop_invalid_template_status', `sop_invalid_template_status:${status}`, { status, allowed: TEMPLATE_STATUSES });
  }
  return status;
}

function normalizeActionStatus(value: unknown): string {
  const status = requiredString(value, 'sop_action_status_invalid');
  if (!ACTION_STATUSES.includes(status as typeof ACTION_STATUSES[number])) {
    throw diagnosticError('sop_action_status_invalid', `sop_action_status_invalid:${status}`, { status, allowed: ACTION_STATUSES });
  }
  return status;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function arrayOfRecords(value: unknown, required: boolean = false): JsonRecord[] {
  if (!Array.isArray(value)) {
    if (required) throw diagnosticError('sop_requires_array');
    return [];
  }
  return value.map((entry, index) => {
    if (!isJsonObject(entry)) throw diagnosticError('sop_array_entry_must_be_object', 'sop_array_entry_must_be_object', { index });
    return entry;
  });
}

function stringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw diagnosticError('sop_string_list_invalid', 'sop_string_list_invalid', { reason: 'must_be_array' });
  const items = value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) throw diagnosticError('sop_string_list_invalid', 'sop_string_list_invalid', { reason: 'entry_must_be_nonempty_string', index });
    return entry.trim();
  });
  if (new Set(items).size !== items.length) throw diagnosticError('sop_string_list_invalid', 'sop_string_list_invalid', { reason: 'duplicate_entries' });
  return items;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
}

function diagnosticError(code: string, message: string = code, details: JsonRecord = {}) {
  const error = new Error(message);
  Object.assign(error, { codeName: code, details });
  return error;
}

function errorDiagnostic(error: unknown) {
  const record = asRecord(error);
  return {
    schema: 'narada.sop.error.v1',
    code: String(record.codeName ?? 'sop_error'),
    message: error instanceof Error ? error.message : String(error),
    details: asRecord(record.details),
  };
}

function drainJsonLines(buffer: string) {
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? '';
  return {
    framed: false,
    remaining,
    requests: lines.filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line))),
  };
}

function drainJsonRpcFrames(buffer: string) {
  const requests: JsonRecord[] = [];
  let remaining = buffer;
  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    requests.push(asRecord(JSON.parse(remaining.slice(bodyStart, bodyEnd))));
    remaining = remaining.slice(bodyEnd);
  }
  return { framed: true, remaining, requests };
}

function writeJsonRpcResponse(response: JsonRecord, { framed }: { framed: boolean }) {
  const body = JSON.stringify(response);
  if (framed) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function parseArgs(argv: string[]) {
  const options: JsonRecord = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sop-root') options.sopRoot = argv[++i];
    else if (arg === '--sops-dir') {
      if (!Array.isArray(options.sopsDirs)) options.sopsDirs = [];
      (options.sopsDirs as string[]).push(argv[++i]);
    }
    else if (arg === '--output-root') options.outputRoot = argv[++i];
    else if (arg === '--server-name') options.serverName = argv[++i];
    else throw new Error(`unknown_argument:${arg}`);
  }
  return options;
}

export { parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
