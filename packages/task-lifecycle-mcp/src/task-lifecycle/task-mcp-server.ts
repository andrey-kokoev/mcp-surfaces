#!/usr/bin/env node
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { finishTaskService } from '@narada2/task-governance-core/task-finish-service';
import { classifyPostCloseoutContinuation, evaluatePostTransitionFollowups } from './follow-up-policy-service.js';
import { closeTaskService } from '@narada2/task-governance-core/task-close-service';
import { searchTasksService } from '@narada2/task-governance-core/task-search-service';
import { continueTaskService } from '@narada2/task-governance-core/task-assignment-lifecycle-service';
import { inspectTaskEvidence, findTaskFile, readTaskFile, writeTaskProjection, allocateTaskNumbers } from '@narada2/task-governance-core/task-governance';
import { renderTaskBodyFromSpec } from '@narada2/task-governance-core/task-spec';
import { buildWorkboard } from './workboard.js';
import { buildNextWorkContract, buildUnifiedWorkboard, deriveNextRecommendation } from './unified-workboard.js';
import {
  buildConciseNextActionView as buildConciseNextActionViewCore,
  buildCorrectiveDebtReadiness as buildCorrectiveDebtReadinessCore,
  buildPostCloseoutContinuation as buildPostCloseoutContinuationCore,
  buildWorkboardSnapshotPacket as buildWorkboardSnapshotPacketCore,
  computeStateFreshness as computeStateFreshnessCore,
  setTaskLifecycleReadModelContext,
} from './task-lifecycle-read-models.js';
import { admitTaskEvidence } from '@narada2/task-governance-core/evidence-admission';
import { evaluateTaskDependencySatisfaction } from '@narada2/task-governance-core/task-dependency-satisfaction';
import { randomUUID } from 'crypto';
import { relative, resolve, join, sep } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'child_process';
import { pollInboxBridge, targetInboxEnvelope, readUnprocessedEnvelopes, evaluateEnvelopeSeverity } from './inbox-bridge.js';
import { readAdmissionLog, resolveEnvelopeStatus } from '../inbox/admission-log.js';
import { refreshInboxIndex } from '../inbox/inbox-index.js';
import { emitCheckpoint } from './emit-checkpoint.js';
import { detectSameOperatorReview, detectSelfReview, getSingleOperatorReviewMeta, findReviewerCapableAgents, isReviewerCapable } from './operator-identity.js';
import { findRelatedTasks } from './task-relatedness.js';
import { validateFollowUpLedger } from './follow-up-ledger-validation.js';
import { validateRecoveryTruthfulnessBody, validateRecoveryTruthfulnessPacket } from './recovery-truthfulness-guard.js';
import { validateSelfCertificationBody, validateSelfCertificationPacket } from './self-certification-guard.js';
import { claimLifecycleTask, proveTaskCriteria, transitionLifecycleTask, unclaimLifecycleTask, unDeferLifecycleTask } from './task-lifecycle-mutation-services.js';
import { TASK_LIFECYCLE_TOOL_ALIASES, taskLifecycleDomainTools } from '@narada2/task-governance-core/task-lifecycle-mcp-contract';
import {
  buildLifecycleTargetLocusStatus as buildPipelineLifecycleTargetLocusStatus,
  createTaskLifecycleToolCaller,
} from '../kernel/tool-call-pipeline.js';
import { runJsonRpcStdioServer } from '../kernel/stdio-json-rpc.js';
import { deriveClosureAuthority } from './closure-authority.js';
import {
  attachPayloadSource,
  enforceInlinePayloadLimit,
  listOutputResources,
  listPayloadTools,
  payloadCreate,
  payloadDerive,
  payloadObjectFromArgs,
  payloadShow,
  payloadValidate,
  readOutputResource,
  resolveToolPayloadArgs,
} from '../mcp-payload-file.js';
import {
  acknowledgeMcpRestartRequest,
  buildMcpFreshnessStatus,
  buildMcpRestartPressure,
  buildStaleLiveNavigationDegradation,
  deriveMcpRestartPressureRecommendation,
  readJsonFile as readMcpFreshnessJsonFile,
  writeMcpRuntimeInstanceObservation,
  writeMcpRestartRequest,
} from '../mcp-freshness-service.js';
import { agentExistsWithRole, checkTaskRoleEligibilityLocal, resolveAgentRole, resolveAgentRoleWithDiagnostics, roleExistsInRoster } from './agent-role-resolution.js';
import { createTaskLifecycleHandlerRegistry } from './task-lifecycle-handler-registry.js';
import { createTaskLifecycleAdminHandlers } from './task-lifecycle-admin-handlers.js';
import { createTaskLifecycleReadHandlers } from './task-lifecycle-read-handlers.js';
import { createTaskLifecycleAssignmentHandlers } from './task-lifecycle-assignment-handlers.js';
import { createTaskLifecycleNavigationHandlers } from './task-lifecycle-navigation-handlers.js';
import { createTaskLifecycleInspectionHandlers } from './task-lifecycle-inspection-handlers.js';
import { createTaskLifecycleEvidenceReviewHandlers } from './task-lifecycle-evidence-review-handlers.js';
import { createTaskLifecycleOperationsHandlers } from './task-lifecycle-operations-handlers.js';
import { createTaskLifecycleCreateRecurringHandlers } from './task-lifecycle-create-recurring-handlers.js';
import {
  buildStateAwareFinishBlockerRemediation as buildStateAwareFinishBlockerRemediationCore,
  buildTaskEvidencePreflight as buildTaskEvidencePreflightCore,
  buildTaskFileResolutionFailure as buildTaskFileResolutionFailureCore,
  detectGitChangedFiles as detectGitChangedFilesCore,
  scopeChangedFiles as scopeChangedFilesCore,
  taskLifecycleDispositionCloseout as taskLifecycleDispositionCloseoutCore,
  validateCapaDispositionCorrectiveCoverage as validateCapaDispositionCorrectiveCoverageCore,
} from './task-lifecycle-closeout.js';
import {
  admitRosterIdentity as admitRosterIdentityCore,
  buildRoutingAssignmentDivergence as buildRoutingAssignmentDivergenceCore,
  ensureStaticRosterAgentInSql as ensureStaticRosterAgentInSqlCore,
  normalizeClaimAuthorityBasis as normalizeClaimAuthorityBasisCore,
  normalizeRosterAuthorityBasis as normalizeRosterAuthorityBasisCore,
  recordClaimIntent as recordClaimIntentCore,
  readTaskRouting as readTaskRoutingCore,
  sanitizeSqlRosterCapabilities as sanitizeSqlRosterCapabilitiesCore,
  sanitizeRosterCapabilitiesJson as sanitizeRosterCapabilitiesJsonCore,
  validatePreferredAgentMismatchAuthority as validatePreferredAgentMismatchAuthorityCore,
  validateRosterIdentifier as validateRosterIdentifierCore,
  withAuthoredRosterJsonPreserved as withAuthoredRosterJsonPreservedCore,
  normalizeCapabilitiesJson as normalizeCapabilitiesJsonCore,
} from './task-lifecycle-routing-roster.js';

const PROTOCOL_VERSION = '2026-04-18';
const SERVER_NAME = 'narada-task-lifecycle-mcp';
const SERVER_BOOTED_AT = new Date().toISOString();
const NO_FILES_CHANGED_MARKER = '__narada_no_files_changed_declared__';
const LOCUS_GUARDED_MUTATION_TOOLS = new Set([
  'task_lifecycle_claim',
  'task_lifecycle_continue',
  'task_lifecycle_unclaim',
  'task_lifecycle_admit_evidence',
  'task_lifecycle_prove_criteria',
  'task_lifecycle_finish',
  'task_lifecycle_submit_work',
  'task_lifecycle_report_blocked',
  'task_lifecycle_close',
  'task_lifecycle_defer',
  'task_lifecycle_un_defer',
  'task_lifecycle_reopen',
  'task_lifecycle_review',
  'task_lifecycle_submit_observation',
  'task_lifecycle_bridge_poll',
  'task_lifecycle_inbox_target',
  'task_lifecycle_create',
  'task_lifecycle_set_routing',
  'task_lifecycle_dependency_declare',
  'task_lifecycle_dependency_disposition_record',
  'task_lifecycle_recurring_create',
  'task_lifecycle_recurring_run_due',
  'task_lifecycle_recurring_suspend',
  'task_lifecycle_recurring_retire',
]);

// Session identity binding for mechanical identity verification.
// If NARADA_AGENT_ID is set, mutating operations warn/block on mismatched agent_id params.
let SESSION_IDENTITY = null;
let taskLifecycleToolCaller = null;
let taskLifecycleHandlerRegistry = null;

const TOOL_ALIASES = TASK_LIFECYCLE_TOOL_ALIASES;

function taskLifecycleTools() {
  return [
    ...taskLifecycleDomainTools().map(patchLocalToolDefinition),
    {
      name: 'task_lifecycle_guidance',
      description: 'Show canonical operating guidance for task lifecycle workflows: ordinary work, blocked work, payloads, review/dependency state, and truthful closeout reporting.',
      inputSchema: objectSchema({
        workflow: stringSchema('Optional guidance section: ordinary_task, blocked_task, payloads, review_and_dependencies, closeout_truthfulness, or all.'),
        tool: stringSchema('Optional lifecycle tool name for tool-specific guidance, such as task_lifecycle_submit_work or task_lifecycle_report_blocked.'),
      }),
      annotations: { title: 'task_lifecycle_guidance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'task_lifecycle_payload_schema',
      description: 'Show accepted payload_ref shapes, inline length thresholds, and examples for lifecycle create, finish, closeout, blocked-report, review, and evidence payloads.',
      inputSchema: objectSchema({
        tool: stringSchema('Optional lifecycle tool name such as task_lifecycle_review or task_lifecycle_finish.'),
      }),
      annotations: { title: 'task_lifecycle_payload_schema', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'task_lifecycle_inspect_range',
      description: 'Read-only compact inspection for an explicit task-number range or chapter membership, including closure/evidence posture.',
      inputSchema: objectSchema({
        start_task_number: { type: 'number', description: 'First task number in the inclusive range.' },
        end_task_number: { type: 'number', description: 'Last task number in the inclusive range.' },
        chapter_id: { type: 'string', description: 'Optional chapter id to inspect instead of a numeric range.' },
        limit: { type: 'number', description: 'Maximum tasks to return; defaults to 50.' },
        include_body: { type: 'boolean', description: 'Include task body snippets. Defaults false.' },
      }),
      annotations: { title: 'task_lifecycle_inspect_range', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'task_lifecycle_report_blocked',
      description: 'Record exact blockers for claimed work without implying finish/completion. Defaults to deferring the task after writing a blocked report. For long next_action/blocker details, create a payload and call with payload_ref plus top-level task_number and agent_id.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to report blocked.'),
        agent_id: stringSchema('Agent id reporting the blocker.'),
        reason: stringSchema('Concise blocker summary.'),
        blockers: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Specific blocker objects, including evidence limits or required external decisions.' },
        next_action: stringSchema('Concrete action needed to unblock continuation. Inline strings over 200 chars should be carried in payload_ref.'),
        payload_ref: stringSchema('Optional immutable payload ref carrying long reason, blockers, next_action, or defer. Payload fields are merged with top-level arguments; top-level task_number and agent_id win.'),
        defer: { type: 'boolean', description: 'When false, record the blocked report without transitioning to deferred. Defaults true.' },
      }, ['task_number', 'agent_id', 'reason']),
      annotations: { title: 'task_lifecycle_report_blocked', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'task_lifecycle_chapter_add_task',
      description: 'Add an existing task to a named chapter membership list. Defaults to appending after the current maximum order_index.',
      inputSchema: {
        type: 'object',
        properties: {
          chapter_id: { type: 'string', description: 'Stable chapter identifier.' },
          task_number: { type: 'number', description: 'Existing task number to add.' },
          order_index: { type: 'number', description: 'Optional explicit order index. Used as an insertion point only when append is false.' },
          append: { type: 'boolean', description: 'When omitted or true, append after the current maximum order_index.' },
          note: { type: 'string', description: 'Optional membership note.' },
          actor_agent_id: { type: 'string', description: 'Principal adding the membership.' },
        },
        required: ['chapter_id', 'task_number'],
        additionalProperties: false,
      },
      annotations: { title: 'task_lifecycle_chapter_add_task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'task_lifecycle_chapter_show',
      description: 'Show task memberships for one chapter, ordered by order_index.',
      inputSchema: {
        type: 'object',
        properties: {
          chapter_id: { type: 'string', description: 'Stable chapter identifier.' },
        },
        required: ['chapter_id'],
        additionalProperties: false,
      },
      annotations: { title: 'task_lifecycle_chapter_show', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'task_lifecycle_submit_work',
      description: 'Compound governed work submission helper: optionally claim, write execution/verification notes, prove criteria, admit evidence, and finish while preserving primitive lifecycle records and gates.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to submit work for.'),
        agent_id: stringSchema('Agent id submitting the work.'),
        summary: stringSchema('Finish/report summary.'),
        execution_notes: stringSchema('Substantive authored ## Execution Notes replacement text.'),
        verification: stringSchema('Substantive authored ## Verification replacement text.'),
        reviewer: stringSchema('Optional admitted reviewer agent id or unique reviewer role alias for generated review-contract dependency work.'),
        changed_files: { type: 'array', items: { type: 'string' }, description: 'Changed-file evidence for finish. Mutually exclusive with no_files_changed.' },
        no_files_changed: { type: 'boolean', description: 'Declare no files changed for legitimate no-edit work. Mutually exclusive with changed_files.' },
        claim: { type: 'boolean', description: 'When true, call task_lifecycle_claim first. Defaults true unless task is already claimed.' },
        prove_criteria: { type: 'boolean', description: 'When true, call task_lifecycle_prove_criteria after writing notes. Defaults true.' },
        admit_evidence: { type: 'boolean', description: 'When true, call task_lifecycle_admit_evidence before finish. Defaults true.' },
        finish: { type: 'boolean', description: 'When true, call task_lifecycle_finish after evidence admission. Defaults true.' },
        payload_ref: stringSchema('Optional immutable payload ref for long execution_notes, verification, summary, changed_files, or guard packets. Payload fields are merged with top-level arguments; top-level task_number and agent_id win.'),
        auto_materialize_payload: { type: 'boolean', description: 'Opt-in fallback for one-call long-field submit_work. When true and payload_ref is absent, the surface creates an immutable payload artifact from companion fields before executing; default false preserves inline length refusal.' },
        authority_basis: authorityBasisSchema('Required by underlying claim when crossing role/preferred-agent gates.'),
        recovery_truthfulness: { type: 'object', additionalProperties: true, description: 'Passed through to task_lifecycle_finish when recovery truthfulness is triggered.' },
        self_certification: { type: 'object', additionalProperties: true, description: 'Passed through to evidence admission/finish when self-certification gates are triggered.' },
      }, ['task_number', 'agent_id']),
      annotations: { title: 'task_lifecycle_submit_work', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    {
      name: 'task_lifecycle_dependency_declare',
      description: 'Declare that an existing parent task is gated by an existing required task. Optional outcome_contract attaches the required task outcome shape; normal agents should prefer task-native helpers such as submit_work.reviewer when available.',
      inputSchema: objectSchema({
        parent_task_number: numberSchema('Parent task number that will be blocked by this dependency.'),
        required_task_number: numberSchema('Existing required task number that must admit a satisfying outcome.'),
        agent_id: stringSchema('Agent id declaring the dependency.'),
        kind: stringSchema('Dependency kind, for example review, verification, operator_decision, or downstream_work.'),
        satisfying_outcomes: { type: 'array', items: { type: 'string' }, description: 'Outcomes on the required task that satisfy this dependency.' },
        outcome_contract: { type: 'object', additionalProperties: true, description: 'Optional outcome contract for the required task. Fields: outcome_type, allowed_outcomes, satisfying_outcomes, blocking_outcomes, required_fields, capability_requirement.' },
        dependency_id: stringSchema('Optional stable dependency id. Defaults to a deterministic id from parent, required task, and kind.'),
      }, ['parent_task_number', 'required_task_number', 'agent_id', 'kind', 'satisfying_outcomes']),
    },
    {
      name: 'task_lifecycle_dependency_disposition_record',
      description: 'Record explicit disposition for a blocking dependency outcome. Use after dependency satisfaction reports disposition_required=true; required_outcome_id is inferred from the latest outcome when omitted.',
      inputSchema: objectSchema({
        dependency_id: stringSchema('Dependency id whose blocking outcome is being dispositioned.'),
        agent_id: stringSchema('Agent id recording the disposition.'),
        kind: stringSchema('Disposition kind: remediation_task, covered_by_existing_task, routed_obligation, operator_decision_required, operator_deferred, or out_of_scope_or_rejected.'),
        summary: stringSchema('Concise disposition summary and authority rationale.'),
        required_outcome_id: stringSchema('Optional specific task_outcomes.outcome_id. Defaults to latest outcome on the required task.'),
        status: stringSchema('Disposition status. Defaults to open, or deferred for operator_deferred/out_of_scope_or_rejected.'),
        target_task_id: stringSchema('Optional task_id for remediation_task or covered_by_existing_task disposition.'),
        routed_obligation_id: stringSchema('Optional directed obligation id for routed_obligation disposition.'),
        authority_basis: authorityBasisSchema('Required authority basis for operator_deferred and out_of_scope_or_rejected dispositions; optional otherwise.'),
      }, ['dependency_id', 'agent_id', 'kind', 'summary']),
      annotations: { title: 'task_lifecycle_dependency_disposition_record', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      outputSchema: { type: 'object', additionalProperties: true },
    },
    ...listPayloadTools(),
  ];
}

function ensureRecurringTaskTables(taskStore) {
  taskStore.db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_task_definitions (
      recurrence_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recurring_task_events (
      event_id TEXT PRIMARY KEY,
      recurrence_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_agent_id TEXT NOT NULL,
      authority_basis_json TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recurring_task_runs (
      run_id TEXT PRIMARY KEY,
      recurrence_id TEXT NOT NULL,
      task_id TEXT,
      task_number INTEGER,
      due_key TEXT,
      trigger_mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      run_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_task_definitions_status ON recurring_task_definitions(status);
    CREATE INDEX IF NOT EXISTS idx_recurring_task_runs_recurrence ON recurring_task_runs(recurrence_id, created_at DESC);
  `);
}

function insertRecurringDefinition(taskStore, definition) {
  ensureRecurringTaskTables(taskStore);
  taskStore.db.prepare(`
    INSERT INTO recurring_task_definitions (recurrence_id, status, definition_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(recurrence_id) DO UPDATE SET
      status = excluded.status,
      definition_json = excluded.definition_json,
      updated_at = excluded.updated_at
  `).run(definition.recurrence_id, definition.status, JSON.stringify(definition), definition.updated_at ?? new Date().toISOString());
}

function hydrateRecurringDefinition(row) {
  if (!row) return null;
  const parsed = parseJsonOrNull(row.definition_json) ?? {};
  return { ...parsed, recurrence_id: row.recurrence_id, status: row.status, updated_at: row.updated_at };
}

function getRecurringDefinition(taskStore, recurrenceId) {
  ensureRecurringTaskTables(taskStore);
  const row = taskStore.db.prepare('SELECT * FROM recurring_task_definitions WHERE recurrence_id = ?').get(recurrenceId);
  return hydrateRecurringDefinition(row);
}

function listRecurringDefinitions(taskStore, { status = null, limit = 20 } = {}) {
  ensureRecurringTaskTables(taskStore);
  const rows = status
    ? taskStore.db.prepare('SELECT * FROM recurring_task_definitions WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
    : taskStore.db.prepare('SELECT * FROM recurring_task_definitions ORDER BY updated_at DESC LIMIT ?').all(limit);
  return rows.map(hydrateRecurringDefinition);
}

function insertRecurringEvent(taskStore, { recurrenceId, eventType, actorAgentId, authorityBasis, event, now, stateAfter = null }) {
  ensureRecurringTaskTables(taskStore);
  taskStore.db.prepare(`
    INSERT INTO recurring_task_events (event_id, recurrence_id, event_type, actor_agent_id, authority_basis_json, event_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`rtevt_${randomUUID()}`, recurrenceId, eventType, actorAgentId, JSON.stringify(authorityBasis ?? null), JSON.stringify({ ...(event ?? {}), state_after: stateAfter }), now ?? new Date().toISOString());
}

function insertRecurringRun(taskStore, run) {
  ensureRecurringTaskTables(taskStore);
  taskStore.db.prepare(`
    INSERT INTO recurring_task_runs (run_id, recurrence_id, task_id, task_number, due_key, trigger_mode, reason, created_at, run_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.run_id, run.recurrence_id, run.task_id ?? null, run.task_number ?? null, run.due_key ?? null, run.trigger_mode, run.reason, run.created_at, JSON.stringify(run));
}

function listRecurringRuns(taskStore, recurrenceId, limit = 20) {
  ensureRecurringTaskTables(taskStore);
  const rows = taskStore.db.prepare('SELECT run_json FROM recurring_task_runs WHERE recurrence_id = ? ORDER BY created_at DESC LIMIT ?').all(recurrenceId, limit);
  return rows.map((row) => parseJsonOrNull(row.run_json)).filter(Boolean);
}

function listDueRecurringDefinitions(taskStore, now = new Date()) {
  void now;
  return listRecurringDefinitions(taskStore, { status: 'active', limit: 100 });
}

function recordBlockedTaskReport({ store, report }) {
  const reportJson = JSON.stringify(report);
  if (store.upsertReportRecord) {
    store.upsertReportRecord({
      report_id: report.report_id,
      task_id: report.task_id,
      assignment_id: report.assignment_id,
      agent_id: report.agent_id,
      reported_at: report.reported_at,
      report_json: reportJson,
    });
  }
  const tableExists = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('task_reports');
  if (!tableExists) return;
  store.db.prepare(`
    INSERT INTO task_reports (
      report_id, task_id, agent_id, summary, changed_files_json, verification_json, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_id) DO UPDATE SET
      task_id = excluded.task_id,
      agent_id = excluded.agent_id,
      summary = excluded.summary,
      changed_files_json = excluded.changed_files_json,
      verification_json = excluded.verification_json,
      submitted_at = excluded.submitted_at
  `).run(
    report.report_id,
    report.task_id,
    report.agent_id,
    report.summary,
    JSON.stringify([]),
    JSON.stringify([]),
    report.reported_at,
  );
}

function gitVisiblePathSubset(cwd, files) {
  return files.filter((file) => {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (tracked.status === 0) return true;
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', file], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return untracked.status === 0 && untracked.stdout.trim().length > 0;
  });
}

function extractEnvelopeId(body) {
  const match = String(body ?? '').match(/\benv_[A-Za-z0-9_-]+\b/);
  return match ? match[0] : null;
}

function inferDisposition(envelopeStatus) {
  if (envelopeStatus === 'promoted') return 'already_promoted';
  if (envelopeStatus === 'dismissed') return 'dismissed';
  if (envelopeStatus === 'acknowledged') return 'acknowledged';
  return 'no_code';
}

function readIndexedEnvelope(root, envelopeId, refreshIndex, severityEvaluator) {
  try {
    refreshIndex(root);
  } catch {
    // Index refresh is opportunistic; direct admission-log readback follows.
  }
  const events = readAdmissionLog(root).filter((event) => event.envelope_id === envelopeId);
  const status = resolveEnvelopeStatus(events);
  if (!status || status === 'unknown') return null;
  const latestPayload = events.at(-1)?.event_payload ?? {};
  return {
    envelope_id: envelopeId,
    status,
    title: latestPayload.title ?? null,
    kind: latestPayload.kind ?? null,
    received_at: latestPayload.received_at ?? null,
    severity: typeof severityEvaluator === 'function' ? severityEvaluator({ ...latestPayload, status }) : null,
  };
}

function buildPostCloseoutContinuation({ agentId, result }) {
  refreshStore();
  const roleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
  const agentRole = roleResolution.role;
  const all = store.getAllLifecycle();
  const board = buildUnifiedWorkboard({ store, siteRoot, agentId, agentRole, allTasks: all, limit: 8 });
  const recommendation = deriveNextRecommendation(board, agentId);
  const nextWorkContract = buildNextWorkContract(board, recommendation ?? null);
  const correctiveDebtReadiness = buildCorrectiveDebtReadinessCore({ allTasks: all });
  const workboard = {
    status: 'ok',
    agent_id: agentId,
    agent_role: agentRole,
    role_binding: roleResolution.role_binding,
    role_resolution: roleResolution,
    generated_at: new Date().toISOString(),
    workboard_generated_at: board.generated_at ?? null,
    recommendation: recommendation ?? null,
    next_work_contract: nextWorkContract,
    no_work_assertion_guardrail: nextWorkContract.no_work_assertion_guardrail,
    executable_work_available: nextWorkContract.executable_work_available,
    agent_actionable_recommendation: Boolean(recommendation),
    environment_pressure: { status: 'clear', executable_by_agent: false, pressure: null },
    corrective_debt_readiness: correctiveDebtReadiness,
    counts: { ...board.counts },
    downstream_role_followups: (board.downstream_role_followups || []).slice(0, 8),
  };
  return classifyPostCloseoutContinuation({ result, workboard });
}

function patchLocalToolDefinition(toolDef) {
  if (toolDef?.name !== 'task_lifecycle_review') return toolDef;
  return {
    ...toolDef,
    description: `${toolDef.description} For long findings, create payload { findings: [{ severity, description, location? }] } and retry with payload_ref plus top-level task_number, agent_id, and verdict.`,
    inputSchema: {
      ...toolDef.inputSchema,
      properties: {
        ...(toolDef.inputSchema?.properties ?? {}),
        findings: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Array of finding objects. Blocking findings must include one disposition: remediation_task, covered_by_existing_task, routed_obligation_id, operator_decision_required, operator_deferred_reason, or out_of_scope_or_rejected with authority_basis.' },
      },
    },
  };
}

let siteRoot = null;
let store = null;
let runtimeConfigured = false;
let runtimeStderr = process.stderr;

export function configureTaskLifecycleMcpRuntime({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write('Usage: task-lifecycle-mcp --site-root <path>\n');
    return { status: 'help' };
  }

  runtimeStderr = stderr;
  SESSION_IDENTITY = env.NARADA_AGENT_ID || null;
  siteRoot = resolve(String(options.siteRoot ?? cwd));
  try {
    store = openTaskLifecycleStore(siteRoot);
  } catch (error) {
    throw new Error(`Failed to open task lifecycle store: ${error.message}`);
  }
  runtimeConfigured = true;
  taskLifecycleToolCaller = null;
  taskLifecycleHandlerRegistry = null;
  setTaskLifecycleReadModelContext({ siteRoot, store });
  recordTaskLifecycleRuntimeObservation();
  return { status: 'configured', siteRoot };
}

function ensureRuntimeConfigured() {
  if (!runtimeConfigured) configureTaskLifecycleMcpRuntime();
}

function refreshStore() {
  ensureRuntimeConfigured();
  try {
    // This MCP process shares `store` across dispatch helpers. With node:sqlite,
    // closing a handle immediately invalidates helpers still holding it, so
    // refresh must be non-destructive.
    store = openTaskLifecycleStore(siteRoot);
    return true;
  } catch (error) {
    runtimeStderr.write(`Failed to refresh task lifecycle store: ${error.message}\n`);
    return false;
  }
}

function readReviewerCapabilityPolicy(root: string) {
  const allowedModes = ['strict', 'advisory', 'disabled'];
  const defaultPolicy = { mode: 'advisory', source: 'default', config_path: null, allowed_modes: allowedModes };
  for (const configPath of [
    join(root, '.ai', 'task-lifecycle-policy.json'),
    join(root, '.ai', 'task-lifecycle', 'config.json'),
  ]) {
    if (!existsSync(configPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      const reviewConfig = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.review : null;
      const nestedMode = reviewConfig && typeof reviewConfig === 'object' && !Array.isArray(reviewConfig) ? reviewConfig.reviewer_capability_enforcement : null;
      const rawMode = parsed.reviewer_capability_enforcement ?? nestedMode;
      const mode = rawMode === 'open' ? 'disabled' : allowedModes.includes(rawMode) ? rawMode : 'advisory';
      return { mode, source: rawMode ? 'site_config' : 'site_config_defaulted', config_path: configPath, allowed_modes: allowedModes };
    } catch (error) {
      return {
        ...defaultPolicy,
        source: 'site_config_error_defaulted',
        config_path: configPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return defaultPolicy;
}

function recordTaskLifecycleRuntimeObservation() {
  try {
    writeMcpRuntimeInstanceObservation({
      siteRoot,
      surfaceId: 'task-lifecycle-mcp.local',
      serverName: SERVER_NAME,
      serverEntryPoint: 'task-lifecycle-mcp',
      serverBootedAt: SERVER_BOOTED_AT,
      watchedPaths: ['node_modules/@narada2/task-lifecycle-mcp/src', 'node_modules/@narada2/mcp-transport'],
      restartRequestPath: join(siteRoot, '.ai', 'tmp', 'task-lifecycle-restart-request.json'),
      baselinePath: join(siteRoot, '.ai', 'tmp', 'mcp-baseline.json'),
      freshnessEvidencePath: '.ai/runtime/typed-mcp/task-lifecycle-mcp',
      transport: { type: 'stdio', runtime_kind: 'node-stdio' },
    });
  } catch (error) {
    runtimeStderr.write(`Failed to record task-lifecycle MCP runtime observation: ${error.message}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTaskLifecycleMcpStdioServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export async function runTaskLifecycleMcpStdioServer({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const configured = configureTaskLifecycleMcpRuntime({ argv, cwd, env, stdout, stderr });
  if (configured.status === 'help') return;
  await runJsonRpcStdioServer({
    stdin,
    stdout,
    handleRequest,
    parseJsonRpcInput,
  });
}

export async function handleTaskLifecycleMcpRequest(request, runtimeOptions = null) {
  if (runtimeOptions) configureTaskLifecycleMcpRuntime(runtimeOptions);
  ensureRuntimeConfigured();
  return handleRequest(request);
}

async function handleRequest(request) {
  if (!request?.id && typeof request?.method === 'string' && request.method.startsWith('notifications/')) return null;
  // Pass through transport-level parse errors directly
  if (request?.error) {
    return { jsonrpc: '2.0', id: request.id ?? null, error: request.error };
  }
  try {
    const result = await dispatchMethod(request.method, request.params ?? {});
    return { jsonrpc: '2.0', id: request.id ?? null, result };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function dispatchMethod(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          completions: {},
          logging: {},
        },
        serverInfo: {
          name: 'narada-task-lifecycle-mcp',
          version: '0.1.0'
        }
      };
    case 'tools/list':
      return {
        tools: taskLifecycleTools()
      };
    case 'tools/call':
      return await callTool(params);
    case 'resources/list':
      return listOutputResources({ siteRoot });
    case 'resources/read':
      return readOutputResource({ siteRoot, uri: params.uri });
    case 'prompts/list':
      return { prompts: listPrompts() };
    case 'prompts/get':
      return promptGet(params);
    case 'completion/complete':
      return completeArgument(params);
    case 'logging/setLevel':
      return {};
    default:
      throw new Error(`unsupported_mcp_method: ${method}`);
  }
}

function listPrompts() {
  return [{ name: 'task_lifecycle_workflow', title: 'Task Lifecycle Workflow', description: 'Guidance for governed task lifecycle operations.', arguments: [] }];
}

function promptGet(params) {
  const name = String(params.name ?? '');
  if (name !== 'task_lifecycle_workflow') throw new Error(`unknown_prompt: ${name}`);
  return {
    description: 'Guidance for governed task lifecycle operations.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Inspect task state before mutation. Admit evidence before finish/close transitions and preserve lifecycle authority details in structuredContent.' } }],
  };
}

function completeArgument(params) {
  const argumentName = String((params.argument && typeof params.argument === 'object' ? params.argument.name : '') ?? '');
  const values = argumentName === 'name' ? taskLifecycleTools().map((tool) => tool.name).filter(Boolean).slice(0, 100) : [];
  return { completion: { values, total: values.length, hasMore: false } };
}

/**
 * Best-effort session identity verification.
 * If NARADA_AGENT_ID is set in the MCP server environment and the caller's agent_id
 * does not match, returns an identity_mismatch warning object.
 * This is advisory (does not block) to avoid breaking sessions where env is not propagated.
 */
function verifySessionIdentity(agentId) {
  if (!SESSION_IDENTITY || !agentId) return null;
  if (SESSION_IDENTITY !== agentId) {
    return {
      identity_mismatch: true,
      session_identity: SESSION_IDENTITY,
      requested_identity: agentId,
      warning: `SESSION IDENTITY MISMATCH: You are operating as ${SESSION_IDENTITY}, but requested action as ${agentId}. ` +
        `If you intended to act as ${agentId}, re-start the session with NARADA_AGENT_ID=${agentId}. ` +
        `Otherwise, correct the agent_id parameter to ${SESSION_IDENTITY}.`,
    };
  }
  return null;
}

/**
 * Hard session identity enforcement for mutating operations.
 * If NARADA_AGENT_ID is set and the caller's agent_id does not match,
 * throws an error that blocks the operation.
 * Grace period: if NARADA_AGENT_ID is not set, this is a no-op.
 */
function enforceSessionIdentity(agentId) {
  if (!SESSION_IDENTITY || !agentId) return;
  if (SESSION_IDENTITY !== agentId) {
    throw new Error(
      `identity_mismatch_blocked: SESSION IDENTITY MISMATCH. ` +
      `You are operating as ${SESSION_IDENTITY}, but requested a mutating action as ${agentId}. ` +
      `Re-start the session with NARADA_AGENT_ID=${agentId}, or correct the agent_id parameter to ${SESSION_IDENTITY}.`
    );
  }
}

function getTaskLifecycleToolCaller() {
  ensureRuntimeConfigured();
  if (!taskLifecycleToolCaller) {
    taskLifecycleToolCaller = createTaskLifecycleToolCaller({
      toolAliases: TOOL_ALIASES,
      taskLifecycleTools,
      siteRoot,
      dispatchTool,
      refreshStore,
      jsonToolResult,
      resolveToolPayloadArgs,
      enforceInlinePayloadLimit,
      locusGuardedMutationTools: LOCUS_GUARDED_MUTATION_TOOLS,
      setActiveOutputToolName: () => {},
    });
  }
  return taskLifecycleToolCaller;
}

async function callTool(params) {
  return getTaskLifecycleToolCaller()(params);
}

function buildLifecycleTargetLocusStatus() {
  return buildPipelineLifecycleTargetLocusStatus({ siteRoot, env: process.env });
}

function getTaskLifecycleHandlerRegistry() {
  if (!taskLifecycleHandlerRegistry) {
    taskLifecycleHandlerRegistry = createTaskLifecycleHandlerRegistry({
      toolNames: taskLifecycleTools().map((tool) => tool.name),
      domainDispatch: (name) => {
        throw new Error(`task_mcp_refused: ${name}`);
      },
      explicitHandlers: {
        ...createTaskLifecycleAdminHandlers({
          jsonToolResult,
          getRegisteredTools: () => taskLifecycleTools().map((tool) => tool.name),
          getSiteRoot: () => siteRoot,
          getToolAliases: () => TOOL_ALIASES,
          buildTaskLifecycleFreshness,
          buildLifecycleTargetLocusStatus,
          taskLifecycleRestart,
        }),
        ...createTaskLifecycleReadHandlers({
          store,
          jsonToolResult,
          stringField,
          numberField,
        }),
        ...createTaskLifecycleAssignmentHandlers({
          store,
          siteRoot,
          jsonToolResult,
          stringField,
          numberField,
          enforceSessionIdentity,
          verifySessionIdentity,
          checkTaskRoleEligibilityLocal,
          validatePreferredAgentMismatchAuthority: validatePreferredAgentMismatchAuthorityCore,
          recordClaimIntent: recordClaimIntentCore,
          claimLifecycleTask,
          continueTaskService,
          unclaimLifecycleTask,
          withAuthoredRosterJsonPreserved: (root, fn) => withAuthoredRosterJsonPreservedCore(root, fn, store),
        }),
        ...createTaskLifecycleNavigationHandlers({
          store,
          siteRoot,
          jsonToolResult,
          stringField,
          numberField,
          booleanField,
          objectField,
          resolveAgentRoleWithDiagnostics,
          buildUnifiedWorkboard,
          buildCorrectiveDebtReadiness: buildCorrectiveDebtReadinessCore,
          deriveNextRecommendation,
          buildTaskLifecycleFreshness: ({ registeredTools }) => buildTaskLifecycleFreshness({ registeredTools: registeredTools ?? taskLifecycleTools().map((tool) => tool.name) }),
          buildMcpRestartPressure,
          buildStaleLiveNavigationDegradation,
          deriveMcpRestartPressureRecommendation,
          buildNextWorkContract,
          computeStateFreshness,
          buildConciseNextActionView: buildConciseNextActionViewCore,
          buildWorkboardSnapshotPacket,
          verifySessionIdentity,
        }),
        ...createTaskLifecycleInspectionHandlers({
          store,
          siteRoot,
          jsonToolResult,
          stringField,
          numberField,
          getSingleOperatorReviewMeta,
          findTaskFile,
          readTaskFile,
          deriveClosureAuthority,
          getTaskRouting,
          inspectTaskEvidence,
          readTaskRouting: readTaskRoutingCore,
          buildTaskEvidencePreflight,
          buildBlockedTaskReportPosture,
          buildRoutingAssignmentDivergence: buildRoutingAssignmentDivergenceCore,
          searchTasksService,
          findRelatedTasks,
        }),
        ...createTaskLifecycleEvidenceReviewHandlers({
          NO_FILES_CHANGED_MARKER,
          store,
          siteRoot,
          jsonToolResult,
          stringField,
          numberField,
          booleanField,
          objectField,
          stringArrayField,
          enforceSessionIdentity,
          verifySessionIdentity,
          validateSelfCertificationPacket,
          validateRecoveryTruthfulnessPacket,
          validateSelfCertificationBody,
          validateRecoveryTruthfulnessBody,
          admitTaskEvidence,
          proveTaskCriteria,
          taskLifecycleDispositionCloseout: (options) => taskLifecycleDispositionCloseoutCore({
            ...options,
            findTaskFile,
            buildTaskFileResolutionFailure: buildTaskFileResolutionFailureCore,
            readIndexedEnvelope,
            inferDisposition,
            relativeSitePath,
            gitVisiblePathSubset,
            validateCapaDispositionCorrectiveCoverage: validateCapaDispositionCorrectiveCoverageCore,
            replaceTaskSection,
            extractEnvelopeId,
            refreshInboxIndex,
            evaluateEnvelopeSeverity,
            admitTaskEvidence,
            withAuthoredRosterJsonPreserved: withAuthoredRosterJsonPreservedCore,
            finishTaskService,
            evaluatePostTransitionFollowups,
            buildPostCloseoutContinuation,
            detectGitChangedFiles: detectGitChangedFilesCore,
            scopeChangedFiles: scopeChangedFilesCore,
          }),
          finishTaskService,
          closeTaskService,
          transitionLifecycleTask,
          unDeferLifecycleTask,
          withAuthoredRosterJsonPreserved: withAuthoredRosterJsonPreservedCore,
          openTaskLifecycleStore,
          detectSameOperatorReview,
          detectSelfReview,
          findReviewerCapableAgents,
          isReviewerCapable,
          getReviewerCapabilityPolicy: () => readReviewerCapabilityPolicy(siteRoot),
          validateTaskFinishRecoveryTruthfulness,
          normalizeRosterCapabilitiesForSharedServices: () => sanitizeSqlRosterCapabilitiesCore(store),
          finishGateExamples,
          buildStateAwareFinishBlockerRemediation: buildStateAwareFinishBlockerRemediationCore,
          buildTaskFileResolutionFailure: buildTaskFileResolutionFailureCore,
          detectGitChangedFiles: detectGitChangedFilesCore,
          scopeChangedFiles: scopeChangedFilesCore,
          buildTaskEvidencePreflight,
          buildBlockedTaskReportPosture,
          recordBlockedTaskReport,
          buildPostCloseoutContinuation,
          emitCheckpoint,
          evaluatePostTransitionFollowups,
          findTaskFile,
          readTaskFile,
          testResultArtifactGate,
          validateFollowUpLedger,
          ensureStaticRosterAgentInSql: ensureStaticRosterAgentInSqlCore,
          ensureReviewContractDependency: ensureReviewContractDependencyForSubmitWork,
          markParentAwaitingDependencies,
        }),
        ...createTaskLifecycleOperationsHandlers({
          store,
          siteRoot,
          jsonToolResult,
          stringField,
          numberField,
          booleanField,
          nullableStringField,
          enforceSessionIdentity,
          pollInboxBridge,
          targetInboxEnvelope,
          roleExistsInRoster,
          agentExistsWithRole,
          resolveAgentRoleWithDiagnostics,
          ensureTaskRoutingTables,
          getTaskRouting,
          findTaskFile,
          readTaskFile,
          writeTaskProjection,
          testMcpTool,
          testTargetsForSelector,
          randomUUID,
        }),
        ...createTaskLifecycleCreateRecurringHandlers({
          store,
          siteRoot,
          jsonToolResult,
          stringField,
          numberField,
          booleanField,
          arrayOfStrings,
          admitRosterIdentity: (args) => admitRosterIdentityCore(args, { store, enforceSessionIdentity }),
          enforceSessionIdentity,
          allocateTaskNumbers,
          slugify,
          todayYmd,
          renderTaskBodyFromSpec,
          writeFileSync,
          join,
          randomUUID,
          attachPayloadSource,
          roleExistsInRoster,
          normalizeRecurringAuthorityBasis,
          requireRecurringAuthorityActor,
          ensureTaskRoutingTables,
          ensureRecurringTaskTables,
          insertRecurringDefinition,
          insertRecurringEvent,
          hydrateRecurringDefinition,
          getRecurringDefinition,
          listRecurringRuns,
          listRecurringDefinitions,
          updateRecurringDefinitionStatus,
          parseIsoOrNow,
          listDueRecurringDefinitions,
          recurringDueKey,
          createRecurringTaskInstance,
          insertRecurringRun,
        }),
        mcp_payload_create: (args) => jsonToolResult(taskLifecyclePayloadCreate(args)),
        mcp_payload_show: (args) => jsonToolResult(payloadShow({ siteRoot, args })),
        mcp_payload_derive: (args) => jsonToolResult(payloadDerive({ siteRoot, args })),
        mcp_payload_validate: (args) => jsonToolResult(payloadValidate({ siteRoot, args })),
        task_lifecycle_chapter_add_task: (args) => jsonToolResult(taskLifecycleChapterAddTask(args)),
        task_lifecycle_chapter_show: (args) => jsonToolResult(taskLifecycleChapterShow(args)),
        task_lifecycle_submit_work: (args, context) => taskLifecycleSubmitWork(args, context),
        task_lifecycle_dependency_declare: (args) => taskLifecycleDependencyDeclare(args),
        task_lifecycle_dependency_disposition_record: (args) => jsonToolResult(taskLifecycleDependencyDispositionRecord(args)),
      },
    });
  }
  return taskLifecycleHandlerRegistry;
}

async function dispatchTool(canonicalName, args, dispatchContext = {}) {
  const handler = getTaskLifecycleHandlerRegistry().get(canonicalName);
  if (!handler) throw new Error(`task_mcp_refused: ${canonicalName}`);
  return handler(args, dispatchContext);
}

function buildTaskLifecycleFreshness({ registeredTools }) {
  return buildMcpFreshnessStatus({
    siteRoot,
    serverName: SERVER_NAME,
    serverEntryPoint: 'task-lifecycle-mcp',
    serverBootedAt: SERVER_BOOTED_AT,
    watchedPaths: ['node_modules/@narada2/task-lifecycle-mcp/src', 'node_modules/@narada2/mcp-transport'],
    expectedTools: taskLifecycleTools().map((tool) => tool.name),
    registeredTools,
    restartRequestPath: join(siteRoot, '.ai', 'tmp', 'task-lifecycle-restart-request.json'),
    baselinePath: join(siteRoot, '.ai', 'tmp', 'mcp-baseline.json'),
    restartToolName: 'task_lifecycle_restart',
  });
}

function taskLifecycleRestart(args) {
  const mode = stringField(args, 'mode') ?? 'request';
  if (!['request', 'status', 'acknowledge', 'clear'].includes(mode)) {
    throw new Error(`invalid_restart_mode: ${mode}`);
  }
  const requestPath = join(siteRoot, '.ai', 'tmp', 'task-lifecycle-restart-request.json');
  const baselinePath = join(siteRoot, '.ai', 'tmp', 'mcp-baseline.json');
  const watchedPaths = ['tools/task-lifecycle', 'tools/mcp-freshness-service.js'];
  const existingRequest = readMcpFreshnessJsonFile(requestPath);

  if (mode === 'acknowledge' || mode === 'clear') {
    return acknowledgeMcpRestartRequest({
      siteRoot,
      serverName: SERVER_NAME,
      targetSurface: 'task-lifecycle-mcp.local',
      targetEntrypoint: 'tools/task-lifecycle/task-mcp-server.js',
      restartRequestPath: requestPath,
      baselinePath,
      watchedPaths,
      expectedTools: taskLifecycleTools().map((tool) => tool.name),
      registeredTools: taskLifecycleTools().map((tool) => tool.name),
      acknowledgedBy: process.env.NARADA_AGENT_ID ?? null,
      reason: stringField(args, 'reason') ?? 'task_lifecycle_restart acknowledged after external restart',
      note: 'Task-lifecycle MCP external restart acknowledged; restart request marker cleared.',
    });
  }

  if (mode === 'status') {
    return {
      status: existingRequest ? 'restart_requested' : 'no_restart_request',
      schema: 'narada.task_lifecycle.restart_request.v0',
      can_self_restart: false,
      restart_mechanism: 'external_stdio_mcp_restart_required',
      request_path: requestPath,
      baseline_path: baselinePath,
      request: existingRequest,
      mcp_freshness: buildTaskLifecycleFreshness({ registeredTools: taskLifecycleTools().map((tool) => tool.name) }),
      message: existingRequest
        ? 'Task-lifecycle MCP restart has been requested. Restart the carrier/session MCP servers externally to load new code.'
        : 'No task-lifecycle MCP restart request file is present.',
    };
  }

  return writeMcpRestartRequest({
    siteRoot,
    serverName: SERVER_NAME,
    targetSurface: 'task-lifecycle-mcp.local',
    targetEntrypoint: 'tools/task-lifecycle/task-mcp-server.js',
    restartRequestPath: requestPath,
    baselinePath,
    requestedBy: process.env.NARADA_AGENT_ID ?? null,
    reason: stringField(args, 'reason') ?? 'task_lifecycle_restart requested through MCP',
    note: 'This tool cannot restart its own stdio MCP process. Restart the carrier/session MCP servers externally to load task-lifecycle source changes.',
  });
}

function chapterStorePath() {
  return join(siteRoot, '.ai', 'do-not-open', 'task-chapters.json');
}

function readChapterStore() {
  const path = chapterStorePath();
  if (!existsSync(path)) {
    return { schema: 'narada.task.chapters.v1', chapters: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      schema: 'narada.task.chapters.v1',
      chapters: parsed && typeof parsed.chapters === 'object' && !Array.isArray(parsed.chapters) ? parsed.chapters : {},
    };
  } catch (error) {
    throw new Error(`task_chapter_store_unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeChapterStore(doc) {
  mkdirSync(join(siteRoot, '.ai', 'do-not-open'), { recursive: true });
  writeFileSync(chapterStorePath(), JSON.stringify({ schema: 'narada.task.chapters.v1', updated_at: new Date().toISOString(), chapters: doc.chapters ?? {} }, null, 2) + '\n', 'utf8');
}

function taskLifecyclePayloadCreate(args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const payload = payloadObjectFromArgs(input, {
    objectField: 'payload',
    jsonField: 'payload_json',
    objectMessage: 'payload_create_payload_must_be_object',
    jsonMessage: 'payload_create_payload_json_must_be_object',
    ambiguityMessage: 'payload_create_must_choose_one_of_payload_or_payload_json: send either non-empty payload object or payload_json string; empty payload object may accompany payload_json only as a client placeholder',
  });
  if (Object.keys(payload).length === 0) {
    throw new Error('task_lifecycle_payload_create_empty_payload_rejected: payload object must include at least one field');
  }
  return payloadCreate({ siteRoot, args });
}

function taskLifecycleChapterAddTask(args) {
  refreshStore();
  const chapterId = normalizeChapterId(args.chapter_id);
  const taskNumber = normalizeChapterTaskNumber(args.task_number);
  const taskSpec = store.getTaskSpecByNumber(taskNumber);
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!taskSpec && !lifecycle) throw new Error(`task_not_found: ${taskNumber}`);

  const doc = readChapterStore();
  const chapters = doc.chapters ?? {};
  const chapter = chapters[chapterId] && typeof chapters[chapterId] === 'object' ? chapters[chapterId] : {};
  const memberships = Array.isArray(chapter.memberships) ? chapter.memberships : [];
  const existing = memberships.find((item) => Number(item.task_number) === taskNumber);
  if (existing) {
    return buildChapterMembershipResult({ status: 'already_present', chapterId, taskNumber, memberships });
  }

  const appendMode = args.append !== false || args.order_index === undefined || args.order_index === null;
  const now = new Date().toISOString();
  let orderIndex = appendMode
    ? memberships.reduce((max, item) => Math.max(max, Number(item.order_index ?? 0)), 0) + 1
    : normalizeOrderIndex(args.order_index);
  if (!appendMode) {
    for (const item of memberships) {
      if (Number(item.order_index ?? 0) >= orderIndex) item.order_index = Number(item.order_index ?? 0) + 1;
    }
  }
  memberships.push({
    task_number: taskNumber,
    order_index: orderIndex,
    note: stringField(args, 'note') ?? null,
    added_by: stringField(args, 'actor_agent_id') ?? process.env.NARADA_AGENT_ID ?? null,
    added_at: now,
  });
  memberships.sort(compareChapterMemberships);
  chapters[chapterId] = { chapter_id: chapterId, updated_at: now, memberships };
  writeChapterStore({ chapters });
  return buildChapterMembershipResult({ status: 'added', chapterId, taskNumber, memberships, appendMode });
}

function taskLifecycleChapterShow(args) {
  const chapterId = normalizeChapterId(args.chapter_id);
  const doc = readChapterStore();
  const chapter = doc.chapters?.[chapterId];
  const memberships = Array.isArray(chapter?.memberships) ? [...chapter.memberships].sort(compareChapterMemberships) : [];
  return {
    schema: 'narada.task.chapter.v1',
    status: 'ok',
    chapter_id: chapterId,
    membership_count: memberships.length,
    memberships,
  };
}

async function taskLifecycleSubmitWork(args, dispatchContext: Record<string, unknown> = {}) {
  const taskNumber = numberField(args, 'task_number');
  const agentId = stringField(args, 'agent_id');
  const summary = stringField(args, 'summary');
  const executionNotes = stringField(args, 'execution_notes');
  const verification = stringField(args, 'verification');
  const reviewer = stringField(args, 'reviewer');
  const changedFiles = stringArrayField(args, 'changed_files');
  const noFilesChanged = booleanField(args, 'no_files_changed') === true;
  const autoMaterializePayload = booleanField(args, 'auto_materialize_payload') === true;
  let payloadSource = dispatchContext.payloadSource;
  if (!taskNumber) throw new Error('task_number_required');
  if (!agentId) throw new Error('agent_id_required');
  if (!summary) throw new Error('summary_required');
  assertSubstantiveSubmitWorkText(executionNotes, 'execution_notes');
  assertSubstantiveSubmitWorkText(verification, 'verification');
  if (changedFiles && noFilesChanged) throw new Error('changed_files_conflicts_with_no_files_changed');
  enforceSessionIdentity(agentId);
  if (autoMaterializePayload && !payloadSource) {
    payloadSource = autoMaterializeSubmitWorkPayload({ taskNumber, agentId, args });
  }

  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  const primitiveResults = [];
  const agentRoleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
  if (!agentRoleResolution.role) {
    const rosterResult = {
      status: 'blocked',
      schema: 'narada.task.submit_work.roster_preflight.v1',
      error: 'submit_work_agent_not_in_roster',
      task_number: taskNumber,
      agent_id: agentId,
      role_resolution: agentRoleResolution,
      remediation: 'Admit the agent into the task lifecycle roster before submit_work, or correct agent_id to a rostered session identity. submit_work refuses before claim so it cannot leave an unfinishable assignment behind.',
    };
    primitiveResults.push({ tool: 'task_lifecycle_submit_work.roster_preflight', result: rosterResult, is_error: true });
    return submitWorkResult({ status: 'blocked', taskNumber, agentId, primitiveResults, blockedAt: 'task_lifecycle_submit_work.roster_preflight', payloadSource }, true);
  }
  const claim = args.claim === undefined ? lifecycle.status === 'opened' : booleanField(args, 'claim') === true;
  if (claim) {
    const claimArgs: Record<string, unknown> = { task_number: taskNumber, agent_id: agentId };
    const authorityBasis = objectField(args, 'authority_basis');
    if (authorityBasis) claimArgs.authority_basis = authorityBasis;
    const claimResult = await dispatchTool('task_lifecycle_claim', claimArgs, { compound_tool: 'task_lifecycle_submit_work' });
    primitiveResults.push({ tool: 'task_lifecycle_claim', result: claimResult.structuredContent ?? null, is_error: claimResult.isError === true });
    if (claimResult.isError) return submitWorkResult({ status: 'blocked', taskNumber, agentId, primitiveResults, blockedAt: 'task_lifecycle_claim', payloadSource }, true);
  }

  const taskFile = await findTaskFile(siteRoot, String(taskNumber));
  if (!taskFile) return jsonToolResult(buildTaskFileResolutionFailureCore({ siteRoot, store, taskNumber, lifecycle, surface: 'task_lifecycle_submit_work' }), true);
  const original = readFileSync(taskFile.path, 'utf8');
  const withExecution = replaceTaskSection(original, 'Execution Notes', executionNotes);
  const withVerification = replaceTaskSection(withExecution, 'Verification', verification);
  writeFileSync(taskFile.path, withVerification, 'utf8');
  primitiveResults.push({
    tool: 'task_lifecycle_submit_work.write_task_notes',
    result: { status: 'written', task_number: taskNumber, path: relativeSitePath(siteRoot, taskFile.path), sections: ['Execution Notes', 'Verification'] },
    is_error: false,
  });

  if (args.prove_criteria !== false) {
    const proveResult = await dispatchTool('task_lifecycle_prove_criteria', { task_number: taskNumber, agent_id: agentId }, { compound_tool: 'task_lifecycle_submit_work' });
    primitiveResults.push({ tool: 'task_lifecycle_prove_criteria', result: proveResult.structuredContent ?? null, is_error: proveResult.isError === true });
    if (proveResult.isError) return submitWorkResult({ status: 'blocked', taskNumber, agentId, primitiveResults, blockedAt: 'task_lifecycle_prove_criteria', payloadSource }, true);
  }

  if (args.admit_evidence !== false) {
    const admitArgs: Record<string, unknown> = { task_number: taskNumber, agent_id: agentId };
    const selfCertification = objectField(args, 'self_certification');
    if (selfCertification) admitArgs.self_certification = selfCertification;
    const admitResult = await dispatchTool('task_lifecycle_admit_evidence', admitArgs, { compound_tool: 'task_lifecycle_submit_work' });
    primitiveResults.push({ tool: 'task_lifecycle_admit_evidence', result: admitResult.structuredContent ?? null, is_error: admitResult.isError === true });
    if (admitResult.isError || admitResult.structuredContent?.status === 'rejected') return submitWorkResult({ status: 'blocked', taskNumber, agentId, primitiveResults, blockedAt: 'task_lifecycle_admit_evidence', payloadSource }, true);
  }

  if (args.finish !== false) {
    const finishArgs: Record<string, unknown> = { task_number: taskNumber, agent_id: agentId, summary };
    if (reviewer) finishArgs.reviewer = reviewer;
    if (changedFiles) finishArgs.changed_files = changedFiles;
    if (noFilesChanged) finishArgs.no_files_changed = true;
    const recoveryTruthfulness = objectField(args, 'recovery_truthfulness');
    const selfCertification = objectField(args, 'self_certification');
    if (recoveryTruthfulness) finishArgs.recovery_truthfulness = recoveryTruthfulness;
    if (selfCertification) finishArgs.self_certification = selfCertification;
    const finishResult = await dispatchTool('task_lifecycle_finish', finishArgs, { compound_tool: 'task_lifecycle_submit_work' });
    primitiveResults.push({ tool: 'task_lifecycle_finish', result: finishResult.structuredContent ?? null, is_error: finishResult.isError === true });
    if (finishResult.isError) return submitWorkResult({ status: 'blocked', taskNumber, agentId, primitiveResults, blockedAt: 'task_lifecycle_finish', payloadSource }, true);
    if (reviewer) {
      const finishPayload = finishResult.structuredContent && typeof finishResult.structuredContent === 'object' && !Array.isArray(finishResult.structuredContent) ? finishResult.structuredContent as Record<string, unknown> : null;
      const reviewDependency = finishPayload?.review_dependency ?? await ensureReviewContractDependencyForSubmitWork({
        parentLifecycle: lifecycle,
        parentTaskNumber: taskNumber,
        reviewer,
        createdBy: agentId,
      });
      primitiveResults.push({ tool: 'task_lifecycle_submit_work.create_review_dependency', result: reviewDependency, is_error: false });
    }
  }

  return submitWorkResult({ status: 'submitted', taskNumber, agentId, primitiveResults, blockedAt: null, payloadSource }, false);
}

function autoMaterializeSubmitWorkPayload({ taskNumber, agentId, args }) {
  const payload: Record<string, unknown> = {};
  for (const field of ['summary', 'execution_notes', 'verification', 'changed_files', 'no_files_changed', 'recovery_truthfulness', 'self_certification']) {
    if (Object.prototype.hasOwnProperty.call(args, field)) payload[field] = args[field];
  }
  const created = payloadCreate({
    siteRoot,
    args: {
      payload,
      payload_id: `submit-work-${taskNumber}-${randomUUID()}`,
      created_by: agentId,
    },
  });
  return {
    kind: 'auto_materialized_payload',
    ref: created.ref,
    payload_id: created.payload_id,
    revision: created.revision,
    byte_size: created.byte_size,
    sha256: created.sha256,
    created_at: created.created_at,
    created_by: created.created_by,
    transient_not_authority: true,
    immutable_revision: true,
  };
}

async function ensureReviewContractDependencyForSubmitWork({ parentLifecycle, parentTaskNumber, reviewer, createdBy }) {
  const existing = store.listTaskDependenciesForParent(parentLifecycle.task_id)
    .find((dependency) => dependency.kind === 'review');
  if (existing) {
    store.db.prepare('delete from task_dependencies where parent_task_id = ? and kind = ? and dependency_id <> ?')
      .run(parentLifecycle.task_id, 'review', existing.dependency_id);
    return {
      status: 'existing',
      dependency_id: existing.dependency_id,
      parent_task_id: existing.parent_task_id,
      required_task_id: existing.required_task_id,
      dependency_kind: existing.kind,
      outcome_contract: store.getLatestTaskOutcomeContract(existing.required_task_id) ?? null,
    };
  }

  const maxTaskRow = store.db.prepare('select max(task_number) as max_task_number from task_lifecycle').get();
  const maxTaskNumber = typeof maxTaskRow?.max_task_number === 'number' ? maxTaskRow.max_task_number : parentTaskNumber;
  store.ensureTaskNumberFloor?.(maxTaskNumber);
  const [reviewTaskNumber] = await allocateTaskNumbers(siteRoot, 1);
  if (!reviewTaskNumber) throw new Error('review_dependency_task_number_allocation_failed');
  const now = new Date().toISOString();
  const safeParentId = parentLifecycle.task_id.replace(/[^A-Za-z0-9._-]+/g, '-');
  const reviewTaskId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${reviewTaskNumber}-review-${safeParentId}`;
  const dependencyId = `dep-review-${parentLifecycle.task_id}-${reviewTaskId}`;
  const contractId = `contract-review-${reviewTaskId}`;
  const reviewerRosterEntry = store.getRosterEntry(reviewer);
  const targetRole = reviewerRosterEntry?.role ?? reviewer;
  const preferredAgentId = reviewerRosterEntry ? reviewer : null;
  const taskFilePath = join(siteRoot, '.ai', 'do-not-open', 'tasks', `${reviewTaskId}.md`);
  mkdirSync(join(siteRoot, '.ai', 'do-not-open', 'tasks'), { recursive: true });

  const body = renderTaskBodyFromSpec({
    spec: {
      title: `Review task #${parentTaskNumber}`,
      chapter: null,
      goal: `Review the submitted work for task #${parentTaskNumber} and finish this task with the review outcome contract.`,
      context: `This is ordinary dependency work generated by task_lifecycle_submit_work for parent task #${parentTaskNumber}.`,
      required_work: [
        `Inspect parent task #${parentTaskNumber} and its submitted evidence.`,
        'Finish this review task with outcome accepted, accepted_with_notes, or rejected.',
      ].join('\n'),
      non_goals: 'Do not mutate the reviewed work while performing this review dependency.',
      acceptance_criteria: [
        'A structured review outcome is admitted through task_lifecycle_finish.',
        'Findings are recorded when the outcome is accepted_with_notes or rejected.',
      ],
    },
  });
  await writeTaskProjection(taskFilePath, {
    task_id: reviewTaskId,
    task_number: reviewTaskNumber,
    status: 'opened',
    target_role: targetRole,
    preferred_agent_id: preferredAgentId,
    gates_task_id: parentLifecycle.task_id,
    gates_task_number: parentTaskNumber,
    dependency_id: dependencyId,
    dependency_kind: 'review',
    outcome_type: 'review',
  }, body);

  store.upsertLifecycle({
    task_id: reviewTaskId,
    task_number: reviewTaskNumber,
    status: 'opened',
    governed_by: targetRole,
    closed_at: null,
    closed_by: null,
    closure_mode: null,
    reopened_at: null,
    reopened_by: null,
    continuation_packet_json: null,
    updated_at: now,
  });
  ensureTaskRoutingTables(store);
  store.db.prepare(`
    INSERT INTO narada_andrey_task_role_preferences (task_id, preferred_role, target_role, preferred_agent_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      preferred_role = excluded.preferred_role,
      target_role = excluded.target_role,
      preferred_agent_id = excluded.preferred_agent_id,
      updated_at = excluded.updated_at
  `).run(reviewTaskId, targetRole, targetRole, preferredAgentId, now);
  store.upsertTaskDependency({
    dependency_id: dependencyId,
    parent_task_id: parentLifecycle.task_id,
    required_task_id: reviewTaskId,
    kind: 'review',
    satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
    status: 'open',
    created_by: createdBy,
    created_at: now,
  });
  store.upsertTaskOutcomeContract({
    contract_id: contractId,
    task_id: reviewTaskId,
    outcome_type: 'review',
    allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
    satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
    blocking_outcomes_json: JSON.stringify(['rejected']),
    required_fields_json: JSON.stringify(['summary']),
    capability_requirement: 'review',
    created_by: createdBy,
    created_at: now,
  });
  store.db.prepare('delete from task_dependencies where parent_task_id = ? and kind = ? and dependency_id <> ?')
    .run(parentLifecycle.task_id, 'review', dependencyId);
  const parentDependencyWaitStatus = await markParentAwaitingDependencies({
    parentLifecycle,
    parentTaskNumber,
    updatedBy: createdBy,
    updatedAt: now,
  });

  return {
    status: 'created',
    dependency_id: dependencyId,
    parent_task_id: parentLifecycle.task_id,
    parent_task_number: parentTaskNumber,
    required_task_id: reviewTaskId,
    required_task_number: reviewTaskNumber,
    dependency_kind: 'review',
    reviewer,
    target_role: targetRole,
    preferred_agent_id: preferredAgentId,
    parent_dependency_wait_status: parentDependencyWaitStatus,
    outcome_contract: {
      contract_id: contractId,
      outcome_type: 'review',
      allowed_outcomes: ['accepted', 'accepted_with_notes', 'rejected'],
      satisfying_outcomes: ['accepted', 'accepted_with_notes'],
      blocking_outcomes: ['rejected'],
      required_fields: ['summary'],
      capability_requirement: 'review',
    },
  };
}

async function markParentAwaitingDependencies({ parentLifecycle, parentTaskNumber, updatedBy, updatedAt }) {
  store.updateStatus(parentLifecycle.task_id, 'awaiting_dependencies', updatedBy, {
    governed_by: 'dependencies',
    updated_at: updatedAt,
  });
  let projection_updated = false;
  try {
    const taskFile = await findTaskFile(siteRoot, String(parentTaskNumber));
    if (taskFile) {
      const fileData = await readTaskFile(taskFile.path);
      await writeTaskProjection(taskFile.path, {
        ...fileData.frontMatter,
        status: 'awaiting_dependencies',
        governed_by: 'dependencies',
      }, fileData.body);
      projection_updated = true;
    }
  } catch {
    projection_updated = false;
  }
  return {
    task_id: parentLifecycle.task_id,
    task_number: parentTaskNumber,
    old_status: parentLifecycle.status,
    new_status: 'awaiting_dependencies',
    blocked_by: 'dependencies',
    projection_updated,
  };
}

async function taskLifecycleDependencyDeclare(args) {
  const parentTaskNumber = numberField(args, 'parent_task_number');
  const requiredTaskNumber = numberField(args, 'required_task_number');
  const agentId = stringField(args, 'agent_id');
  const kind = stringField(args, 'kind');
  const satisfyingOutcomes = Array.isArray(args.satisfying_outcomes)
    ? args.satisfying_outcomes.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
  if (!parentTaskNumber) throw new Error('parent_task_number_required');
  if (!requiredTaskNumber) throw new Error('required_task_number_required');
  if (!agentId) throw new Error('agent_id_required');
  if (!kind) throw new Error('kind_required');
  if (satisfyingOutcomes.length === 0) throw new Error('satisfying_outcomes_required');
  enforceSessionIdentity(agentId);

  const allowedKinds = new Set(['review', 'verification', 'operator_decision', 'downstream_work']);
  if (!allowedKinds.has(kind)) throw new Error(`unsupported_dependency_kind: ${kind}`);
  const parentLifecycle = store.getLifecycleByNumber(parentTaskNumber);
  if (!parentLifecycle) throw new Error(`parent_task_not_found: ${parentTaskNumber}`);
  const requiredLifecycle = store.getLifecycleByNumber(requiredTaskNumber);
  if (!requiredLifecycle) throw new Error(`required_task_not_found: ${requiredTaskNumber}`);
  if (parentLifecycle.task_id === requiredLifecycle.task_id) throw new Error('dependency_self_cycle_not_allowed');

  const now = new Date().toISOString();
  const dependencyId = stringField(args, 'dependency_id')
    ?? `dep-${kind}-${parentLifecycle.task_id}-${requiredLifecycle.task_id}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const dependency = {
    dependency_id: dependencyId,
    parent_task_id: parentLifecycle.task_id,
    required_task_id: requiredLifecycle.task_id,
    kind,
    satisfying_outcomes_json: JSON.stringify(satisfyingOutcomes),
    status: 'open',
    created_by: agentId,
    created_at: now,
  };
  store.upsertTaskDependency(dependency);

  let outcomeContract = null;
  const outcomeContractInput = objectField(args, 'outcome_contract');
  if (outcomeContractInput) {
    const outcomeType = nonEmptyString(outcomeContractInput.outcome_type) ?? kind;
    const allowedOutcomes = Array.isArray(outcomeContractInput.allowed_outcomes)
      ? outcomeContractInput.allowed_outcomes.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : [];
    const contractSatisfyingOutcomes = Array.isArray(outcomeContractInput.satisfying_outcomes)
      ? outcomeContractInput.satisfying_outcomes.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : satisfyingOutcomes;
    const blockingOutcomes = Array.isArray(outcomeContractInput.blocking_outcomes)
      ? outcomeContractInput.blocking_outcomes.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : [];
    const requiredFields = Array.isArray(outcomeContractInput.required_fields)
      ? outcomeContractInput.required_fields.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : ['summary'];
    if (allowedOutcomes.length === 0) throw new Error('outcome_contract_allowed_outcomes_required');
    if (contractSatisfyingOutcomes.length === 0) throw new Error('outcome_contract_satisfying_outcomes_required');
    outcomeContract = {
      contract_id: nonEmptyString(outcomeContractInput.contract_id) ?? `contract-${kind}-${requiredLifecycle.task_id}`.replace(/[^A-Za-z0-9._-]+/g, '-'),
      task_id: requiredLifecycle.task_id,
      outcome_type: outcomeType,
      allowed_outcomes_json: JSON.stringify(allowedOutcomes),
      satisfying_outcomes_json: JSON.stringify(contractSatisfyingOutcomes),
      blocking_outcomes_json: JSON.stringify(blockingOutcomes),
      required_fields_json: JSON.stringify(requiredFields),
      capability_requirement: nonEmptyString(outcomeContractInput.capability_requirement) ?? kind,
      created_by: agentId,
      created_at: now,
    };
    store.upsertTaskOutcomeContract(outcomeContract);
  }

  const parentDependencyWaitStatus = await markParentAwaitingDependencies({
    parentLifecycle,
    parentTaskNumber,
    updatedBy: agentId,
    updatedAt: now,
  });
  return jsonToolResult({
    schema: 'narada.task.mcp.dependency_declare.v0',
    status: 'declared',
    dependency,
    parent_task_number: parentTaskNumber,
    required_task_number: requiredTaskNumber,
    parent_dependency_wait_status: parentDependencyWaitStatus,
    outcome_contract: outcomeContract,
    dependency_satisfaction: evaluateTaskDependencySatisfaction(store, parentLifecycle.task_id),
  });
}

function taskLifecycleDependencyDispositionRecord(args) {
  const dependencyId = stringField(args, 'dependency_id');
  const agentId = stringField(args, 'agent_id');
  const kind = stringField(args, 'kind');
  const summary = stringField(args, 'summary');
  if (!dependencyId) throw new Error('dependency_id_required');
  if (!agentId) throw new Error('agent_id_required');
  if (!kind) throw new Error('kind_required');
  if (!summary) throw new Error('summary_required');
  enforceSessionIdentity(agentId);

  const allowedKinds = new Set([
    'remediation_task',
    'covered_by_existing_task',
    'routed_obligation',
    'operator_decision_required',
    'operator_deferred',
    'out_of_scope_or_rejected',
  ]);
  if (!allowedKinds.has(kind)) throw new Error(`unsupported_dependency_disposition_kind: ${kind}`);

  const dependency = store.getTaskDependency(dependencyId);
  if (!dependency) throw new Error(`dependency_not_found: ${dependencyId}`);
  const latestOutcome = store.getLatestTaskOutcome(dependency.required_task_id);
  const explicitOutcomeId = stringField(args, 'required_outcome_id');
  const requiredOutcomeId = explicitOutcomeId ?? latestOutcome?.outcome_id ?? null;
  if (!requiredOutcomeId) throw new Error(`dependency_outcome_missing: ${dependencyId}`);
  if (explicitOutcomeId && latestOutcome?.outcome_id !== explicitOutcomeId) {
    const matchingOutcome = store.listTaskOutcomes(dependency.required_task_id).find((outcome) => outcome.outcome_id === explicitOutcomeId);
    if (!matchingOutcome) throw new Error(`required_outcome_not_found_for_dependency: ${explicitOutcomeId}`);
  }

  const targetTaskId = stringField(args, 'target_task_id');
  const routedObligationId = stringField(args, 'routed_obligation_id');
  const authorityBasis = objectField(args, 'authority_basis');
  if ((kind === 'remediation_task' || kind === 'covered_by_existing_task') && !targetTaskId) throw new Error(`${kind}_target_task_id_required`);
  if (kind === 'routed_obligation' && !routedObligationId) throw new Error('routed_obligation_id_required');
  if ((kind === 'operator_deferred' || kind === 'out_of_scope_or_rejected') && !authorityBasis) throw new Error(`${kind}_authority_basis_required`);

  const status = stringField(args, 'status') ?? (kind === 'operator_deferred' || kind === 'out_of_scope_or_rejected' ? 'deferred' : 'open');
  const allowedStatuses = new Set(['open', 'deferred', 'resolved', 'superseded']);
  if (!allowedStatuses.has(status)) throw new Error(`unsupported_dependency_disposition_status: ${status}`);
  const now = new Date().toISOString();
  const disposition = {
    disposition_id: `depdisp_${randomUUID()}`,
    dependency_id: dependencyId,
    required_outcome_id: requiredOutcomeId,
    kind,
    status,
    target_task_id: targetTaskId,
    routed_obligation_id: routedObligationId,
    authority_basis_json: JSON.stringify(authorityBasis ?? null),
    summary,
    created_by: agentId,
    created_at: now,
  };
  store.upsertTaskDependencyDisposition(disposition);
  return {
    schema: 'narada.task.mcp.dependency_disposition_record.v0',
    status: 'recorded',
    dependency_id: dependencyId,
    parent_task_id: dependency.parent_task_id,
    required_task_id: dependency.required_task_id,
    disposition,
    dependency_satisfaction: evaluateTaskDependencySatisfaction(store, dependency.parent_task_id),
  };
}

function submitWorkResult({ status, taskNumber, agentId, primitiveResults, blockedAt, payloadSource }, isError) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  const finalLifecycleStatus = lifecycle?.status ?? null;
  const closureStatus = status === 'blocked'
    ? 'blocked'
    : finalLifecycleStatus === 'closed' || finalLifecycleStatus === 'confirmed'
    ? 'closed'
    : finalLifecycleStatus === 'in_review' || finalLifecycleStatus === 'awaiting_dependencies'
    ? 'submitted_for_review_not_closed'
    : 'submitted_not_closed';
  return jsonToolResult({
    schema: 'narada.task.mcp.submit_work.v0',
    status,
    task_number: taskNumber,
    agent_id: agentId,
    blocked_at: blockedAt,
    final_lifecycle_status: finalLifecycleStatus,
    closure_status: closureStatus,
    submitted_for_review_not_closed: closureStatus === 'submitted_for_review_not_closed',
    payload_source: payloadSource ?? null,
    long_field_transport: payloadSource?.kind === 'auto_materialized_payload' ? 'auto_materialized_payload' : payloadSource ? 'payload_ref' : 'inline',
    primitive_record_count: primitiveResults.length,
    primitive_results: primitiveResults,
    review_obligation_preserved: true,
    authority_gates_preserved: true,
  }, isError);
}

function assertSubstantiveSubmitWorkText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 20 || /Record what was done|Record commands run|<!--|TODO|TBD/i.test(text)) {
    throw new Error(`task_lifecycle_submit_work_${field}_not_substantive`);
  }
}

function buildChapterMembershipResult({ status, chapterId, taskNumber, memberships, appendMode = null }) {
  const ordered = [...memberships].sort(compareChapterMemberships);
  const membership = ordered.find((item) => Number(item.task_number) === taskNumber) ?? null;
  return {
    schema: 'narada.task.chapter_membership.v1',
    status,
    chapter_id: chapterId,
    task_number: taskNumber,
    order_index: membership ? Number(membership.order_index) : null,
    append_mode: appendMode,
    membership_count: ordered.length,
    membership,
    memberships: ordered,
  };
}

function compareChapterMemberships(a, b) {
  return Number(a.order_index ?? 0) - Number(b.order_index ?? 0) || Number(a.task_number ?? 0) - Number(b.task_number ?? 0);
}

function normalizeChapterId(value) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new Error('invalid_chapter_id');
  return text;
}

function normalizeChapterTaskNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`invalid_task_number: ${value}`);
  return number;
}

function normalizeOrderIndex(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`invalid_order_index: ${value}`);
  return number;
}

async function buildTaskEvidencePreflight({ siteRoot, store, taskNumber }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  const evidence = await inspectTaskEvidence(siteRoot, String(taskNumber), store);
  const taskFile = await findTaskFile(siteRoot, taskNumber);
  let body = '';
  if (taskFile) {
    const taskData = await readTaskFile(taskFile.path);
    body = taskData.body;
  }
  const reports = store.listReportRecords ? store.listReportRecords(lifecycle.task_id) : [];
  const sqliteReports = store.listReports ? store.listReports(lifecycle.task_id) : [];
  const verificationRuns = store.listVerificationRunsForTask ? store.listVerificationRunsForTask(lifecycle.task_id) : [];
  const observations = store.db.prepare('SELECT artifact_uri, created_at FROM observation_artifacts WHERE task_id = ? ORDER BY created_at DESC').all(lifecycle.task_id);
  const changedFileEvidence = collectChangedFileEvidenceFromReports(reports, sqliteReports);
  const blockedWorkPosture = buildBlockedTaskReportPosture({ store, lifecycle, changedFileEvidence });
  const dependencySatisfaction = evaluateTaskDependencySatisfaction(store, lifecycle.task_id);
  const closedComplete = lifecycle.status === 'closed' && evidence.verdict === 'complete';
  const followUpValidation = validateFollowUpLedger(body);
  const recoveryTruthfulnessValidation = validateRecoveryTruthfulnessBody({ body, summary: '', context: `task:${taskNumber}` });
  const requirements = [];

  addRequirement(requirements, {
    id: 'execution_notes',
    label: 'Execution Notes',
    satisfied: evidence.has_execution_notes === true,
    observed: { has_execution_notes: evidence.has_execution_notes, has_report: evidence.has_report },
    remediation: evidence.has_report
      ? 'Task has a structured report, but authored ## Execution Notes are still recommended for closeout readability.'
      : 'Add substantive authored notes under ## Execution Notes or submit a task report before finish.',
  });
  addRequirement(requirements, {
    id: 'verification',
    label: 'Verification',
    satisfied: evidence.has_verification === true,
    observed: {
      passed_verification_runs: verificationRuns.filter((run) => run.status === 'passed').map((run) => run.run_id),
      report_verification_count: countReportVerificationEntries(reports, sqliteReports),
      observation_artifact_count: observations.length,
    },
    remediation: observations.length > 0
      ? 'Structured observation artifacts are recorded context but do not satisfy the verification gate. Add substantive ## Verification notes, finish with a summary plus changed_files/no_files_changed, or attach a governed passed verification run.'
      : 'Add substantive ## Verification notes, finish with a summary plus changed_files/no_files_changed, or attach a governed passed verification run.',
  });
  addRequirement(requirements, {
    id: 'acceptance_criteria',
    label: 'Acceptance Criteria',
    satisfied: evidence.all_criteria_checked !== false,
    observed: { all_criteria_checked: evidence.all_criteria_checked, unchecked_count: evidence.unchecked_count },
    remediation: evidence.all_criteria_checked === false
      ? `Prove criteria with task_lifecycle_prove_criteria or check ${evidence.unchecked_count} remaining acceptance criteria in the task body.`
      : 'Acceptance criteria are checked or not present.',
  });
  addRequirement(requirements, {
    id: 'follow_up_ledger',
    label: 'Follow-Up Ledger',
    satisfied: followUpValidation.ok === true,
    observed: {
      required: followUpValidation.required,
      has_canonical_section: /^##\s+Follow-Up Ledger\s*$/mi.test(body),
      recovery_truthfulness_triggered: recoveryTruthfulnessValidation.evaluation?.triggered === true,
    },
    remediation: followUpValidation.ok === false
      ? 'Add a top-level ## Follow-Up Ledger section or provide the canonical no-follow-up rationale.'
      : 'Follow-Up Ledger is present and satisfies the current gate.',
  });
  addRequirement(requirements, {
    id: 'changed_files',
    label: 'Changed Files',
    satisfied: closedComplete || changedFileEvidence.changedFiles.length > 0 || changedFileEvidence.noFilesChangedDeclarations.length > 0,
    observed: {
      changed_files: changedFileEvidence.changedFiles,
      no_files_changed_declarations: changedFileEvidence.noFilesChangedDeclarations,
      closed_complete_exemption: closedComplete,
      blocked_report_present: blockedWorkPosture.state === 'blocked_reported',
    },
    remediation: closedComplete
      ? 'Task is already closed with complete evidence; changed-file evidence is an active finish gate, not a post-close blocker.'
      : changedFileEvidence.changedFiles.length > 0 || changedFileEvidence.noFilesChangedDeclarations.length > 0
      ? 'Changed-file evidence is present in task reports, or an explicit no-files-changed declaration was submitted.'
      : blockedWorkPosture.state === 'blocked_reported'
      ? 'A blocked-work report is recorded. Do not finish as complete until blockers are resolved; continue or defer the task instead.'
      : 'Finish/closeout must include changed files, or explicitly declare no files changed for design-only/research work.',
    examples: finishGateExamples('changed_files'),
  });
  addRequirement(requirements, {
    id: 'dependencies',
    label: 'Dependencies',
    satisfied: dependencySatisfaction.all_satisfied,
    observed: dependencySatisfaction,
    remediation: dependencySatisfaction.all_satisfied
      ? 'All dependency outcomes satisfy the parent task.'
      : 'Complete each required dependency task with an admitted satisfying outcome before closing the parent task.',
  });

  const blockers = requirements.filter((item) => item.satisfied !== true);
  const remediationSummary = blockers.map((item) => `${item.id}: ${item.remediation}`);
  const nextAction = blockedWorkPosture.state === 'blocked_reported'
    ? 'Blocked report is recorded. Do not finish as complete until blockers are resolved; continue or defer the task instead.'
    : blockedWorkPosture.state === 'stale_blocked_report_superseded'
    ? 'Prior blocked report is superseded by newer completion evidence; continue normal finish/review checks.'
    : blockers[0]?.remediation ?? 'No blocked-work report currently blocks finish.';
  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    schema: 'narada.task.mcp.evidence_preflight.v0',
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    blocked_work_posture: blockedWorkPosture,
    dependency_satisfaction: dependencySatisfaction,
    blockers,
    requirements,
    remediation_summary: remediationSummary,
    next_action: nextAction,
    structured_artifact_policy: {
      observation_artifacts_count: observations.length,
      observation_artifacts_satisfy_verification_gate: false,
      explanation: 'Evidence admission counts authored task sections, task reports, and governed verification runs. Observation artifacts remain context unless promoted into those recognized evidence shapes.',
    },
  };
}

function buildBlockedTaskReportPosture({ store, lifecycle, changedFileEvidence = null }) {
  const reports = store.listReportRecords ? store.listReportRecords(lifecycle.task_id) : [];
  const blockedReports = [];
  for (const report of reports) {
    try {
      const parsed = JSON.parse(report.report_json);
      if (parsed.report_status === 'blocked') blockedReports.push({ ...parsed, report_id: parsed.report_id ?? report.report_id, reported_at: parsed.reported_at ?? report.reported_at });
    } catch {
      // Ignore malformed historical report records.
    }
  }
  blockedReports.sort((a, b) => String(b.reported_at ?? '').localeCompare(String(a.reported_at ?? '')));
  const latest = blockedReports[0] ?? null;
  if (!latest) return { state: 'clear', report_id: null };
  if (lifecycle.status === 'closed' || lifecycle.status === 'confirmed') {
    return {
      state: 'closed_supersedes_blocked_report',
      report_id: latest.report_id,
      historical_blocked_reports: blockedReports,
      next_action: null,
    };
  }
  const hasSupersedingChangeEvidence = Boolean(changedFileEvidence)
    && (changedFileEvidence.changedFiles?.length > 0 || changedFileEvidence.noFilesChangedDeclarations?.length > 0);
  if (hasSupersedingChangeEvidence) {
    return { state: 'stale_blocked_report_superseded', report_id: latest.report_id, superseded_by: { evidence: changedFileEvidence } };
  }
  return {
    state: 'blocked_reported',
    report_id: latest.report_id,
    reason: latest.reason ?? latest.summary ?? null,
    blockers: Array.isArray(latest.blockers) ? latest.blockers : [],
    next_action: latest.next_action ?? null,
    reported_at: latest.reported_at ?? null,
  };
}

function validateTaskFinishRecoveryTruthfulness({ recoveryTruthfulness }) {
  if (!recoveryTruthfulness) return { ok: true, evaluation: { triggered: false }, errors: [] };
  return validateRecoveryTruthfulnessPacket(recoveryTruthfulness);
}

function addRequirement(requirements, item) {
  requirements.push({
    required_for_finish: true,
    ...item,
  });
}

function finishGateExamples(kind) {
  const examples = {
    follow_up_ledger: {
      heading: '## Follow-Up Ledger',
      valid_entries: [
        'created #123: implements the preserved follow-up.',
        'covered by #123: existing task already implements this follow-up.',
        'deferred: blocked on explicit operator decision.',
        'no follow-up needed: documentation-only task has no preserved follow-up.',
      ],
    },
    recovery_truthfulness: {
      inline_packet: {
        known_facts: ['What is mechanically true from task/tool evidence.'],
        inferences: ['What was inferred from the facts.'],
        uncertainty: ['What remains unknown.'],
        changed: ['Files or state changed by this work.'],
        not_changed: ['Authority/runtime/mailbox state intentionally not changed.'],
        remaining_work: ['Open follow-up, or none.'],
        evidence_limits: ['Static readback only, no runtime restart, etc.'],
        capa_open_status: 'not_applicable',
        state: 'corrective_complete_pending_review',
      },
      large_packet: 'If inline recovery_truthfulness is rejected as too long, create an MCP payload and pass {"payload_ref":"mcp_payload:<id>@v1"}.',
    },
    changed_files: {
      changed_files: ['docs/example.md', 'tools/example.js'],
      no_files_changed: true,
      rule: 'Use changed_files for edited files. Use no_files_changed only for legitimate no-edit closeout. Do not send both.',
    },
    architect_review_closeout: {
      accepted: {
        verdict: 'accepted',
        no_files_changed: true,
        summary: 'Reviewed task #N; evidence satisfies the acceptance criteria.',
      },
      rejected: {
        verdict: 'rejected',
        no_files_changed: true,
        summary: 'Rejected: specific blocker and required repair.',
      },
    },
  };
  return kind ? examples[kind] : examples;
}

function hasMaterialTaskSection(body, heading) {
  const section = extractTaskSection(body, heading);
  if (!section) return false;
  const cleaned = section.replace(/<!--.*?-->/gs, '').trim();
  return cleaned.length > 0;
}

function extractTaskSection(body, heading) {
  const pattern = '^##\\s+' + escapeRegex(heading) + '\\s*$';
  const match = body.match(new RegExp(pattern, 'mi'));
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.match(/^##\s/m);
  const end = nextHeading ? start + nextHeading.index : body.length;
  return body.slice(start, end).trim();
}

function escapeRegex(value) {
  const special = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
  return Array.from(String(value), (char) => special.has(char) ? `\\${char}` : char).join('');
}

function collectChangedFileEvidenceFromReports(reportRecords, sqliteReports) {
  const files = [];
  const noFilesChangedDeclarations = [];
  for (const report of reportRecords) {
    try {
      const parsed = JSON.parse(report.report_json);
      if (Array.isArray(parsed.changed_files)) files.push(...parsed.changed_files);
      if (parsed.no_files_changed === true || parsed.changed_files?.includes?.(NO_FILES_CHANGED_MARKER)) {
        noFilesChangedDeclarations.push({
          report_id: parsed.report_id ?? report.report_id ?? null,
          agent_id: parsed.agent_id ?? report.agent_id ?? null,
          declared_at: parsed.reported_at ?? report.reported_at ?? null,
        });
      }
    } catch {
      // ignore malformed report records
    }
  }
  for (const report of sqliteReports) {
    try {
      const parsed = JSON.parse(report.changed_files_json ?? '[]');
      if (Array.isArray(parsed)) {
        files.push(...parsed);
        if (parsed.includes(NO_FILES_CHANGED_MARKER)) {
          noFilesChangedDeclarations.push({
            report_id: report.report_id ?? null,
            agent_id: report.agent_id ?? null,
            declared_at: report.submitted_at ?? null,
          });
        }
      }
    } catch {
      // ignore malformed sqlite reports
    }
  }
  const declarationKeys = new Set();
  const uniqueDeclarations = [];
  for (const declaration of noFilesChangedDeclarations) {
    const key = declaration.report_id ?? `${declaration.agent_id ?? 'unknown'}:${declaration.declared_at ?? 'unknown'}`;
    if (declarationKeys.has(key)) continue;
    declarationKeys.add(key);
    uniqueDeclarations.push(declaration);
  }
  const changedFiles = [...new Set(files.filter((file) => typeof file === 'string' && file.trim().length > 0 && file !== NO_FILES_CHANGED_MARKER))];
  return {
    changedFiles,
    changed_files_count: changedFiles.length,
    noFilesChangedDeclarations: uniqueDeclarations,
    no_files_changed_declaration_count: uniqueDeclarations.length,
  };
}

function countReportVerificationEntries(reportRecords, sqliteReports) {
  let count = 0;
  for (const report of reportRecords) {
    try {
      const parsed = JSON.parse(report.report_json);
      if (Array.isArray(parsed.verification)) count += parsed.verification.length;
    } catch {
      // ignore malformed report records
    }
  }
  for (const report of sqliteReports) {
    try {
      const parsed = JSON.parse(report.verification_json ?? '[]');
      if (Array.isArray(parsed)) count += parsed.length;
    } catch {
      // ignore malformed sqlite reports
    }
  }
  return count;
}

function legacyTaskLifecycleToolsSnapshot() {
  return [
    {
      name: 'task_lifecycle_doctor',
      description: 'Inspect Task Lifecycle MCP readiness without mutating.',
      inputSchema: objectSchema({}),
    },
    {
      name: 'task_lifecycle_list',
      description: 'List tasks with optional status and agent filters.',
      inputSchema: objectSchema({
        status: stringSchema('Filter by status: draft, opened, claimed, in_review, closed, confirmed, etc.'),
        agent_id: stringSchema('Filter by assigned agent_id.'),
        limit: numberSchema('Maximum results; defaults to 50.'),
      }),
    },
    {
      name: 'task_lifecycle_show',
      description: 'Show full task details: lifecycle, spec, assignment, and observations.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to inspect.'),
      }, ['task_number']),
    },
    {
      name: 'task_lifecycle_roster',
      description: 'List the agent roster.',
      inputSchema: objectSchema({}),
    },
    {
      name: 'task_lifecycle_guidance',
      description: 'Show canonical operating guidance for task lifecycle workflows: ordinary work, blocked work, payloads, review/dependency state, and truthful closeout reporting.',
      inputSchema: objectSchema({
        workflow: stringSchema('Optional guidance section: ordinary_task, blocked_task, payloads, review_and_dependencies, closeout_truthfulness, or all.'),
        tool: stringSchema('Optional lifecycle tool name for tool-specific guidance, such as task_lifecycle_submit_work or task_lifecycle_report_blocked.'),
      }),
    },
    {
      name: 'task_lifecycle_payload_schema',
      description: 'Show accepted payload_ref shapes, inline length thresholds, and examples for lifecycle create, finish, closeout, blocked-report, review, and evidence payloads.',
      inputSchema: objectSchema({
        tool: stringSchema('Optional lifecycle tool name such as task_lifecycle_review or task_lifecycle_finish.'),
      }),
    },
    {
      name: 'task_lifecycle_roster_admit',
      description: 'Append an admitted roster identity event and project it into the agent_roster read model.',
      inputSchema: objectSchema({
        agent_id: stringSchema('Canonical agent identity to admit into task lifecycle roster authority.'),
        role: stringSchema('Canonical role for the agent.'),
        actor_agent_id: stringSchema('Verified session agent recording the roster admission.'),
        capabilities: { type: 'array', items: stringSchema('Capability name.'), description: 'Capabilities to project for this roster identity.' },
        operator_identity: stringSchema('Optional operator identity associated with the agent.'),
        authority_basis: authorityBasisSchema('Required authority basis for roster admission.'),
        reason: stringSchema('Optional admission reason.'),
        dry_run: { type: 'boolean', description: 'Plan only; do not append event or project roster.' },
      }, ['agent_id', 'role', 'actor_agent_id', 'authority_basis']),
    },
    {
      name: 'task_lifecycle_claim',
      description: 'Claim an unassigned task for an agent. If the claiming agent differs from preferred_agent_id, include authority_basis { kind, summary }.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to claim.'),
        agent_id: stringSchema('Agent id claiming the task.'),
        authority_basis: authorityBasisSchema('Required when the task has a different preferred_agent_id.'),
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_continue',
      description: 'Continue a task that is in needs_continuation or evidence_repair state.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to continue.'),
        agent_id: stringSchema('Agent id continuing the task.'),
        reason: stringSchema('Continuation reason: evidence_repair, review_fix, handoff, blocked_agent, operator_override.'),
      }, ['task_number', 'agent_id', 'reason']),
    },
    {
      name: 'task_lifecycle_unclaim',
      description: 'Release an active task assignment.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to unclaim.'),
        agent_id: stringSchema('Optional agent_id guard; must match current claimant.'),
        reason: stringSchema('Release reason.'),
      }, ['task_number']),
    },
    {
      name: 'task_lifecycle_next',
      description: 'Get the next recommended action for an agent: active work, directed dependency work, dependency-waiting context, or claimable tasks.',
      inputSchema: objectSchema({
        agent_id: stringSchema('Agent id to query workboard for.'),
        limit: numberSchema('Maximum results per category; defaults to 8.'),
        last_workboard_check_at: stringSchema('ISO timestamp of the agent\'s last workboard check. Enables state_freshness computation.'),
      }, ['agent_id']),
    },
    {
      name: 'task_lifecycle_workboard_snapshot',
      description: 'Return a read-only, trace-ready workboard evidence packet for IS movement. Does not claim, route, rank, or reconcile tasks.',
      inputSchema: objectSchema({
        agent_id: stringSchema('Agent id to query workboard evidence for.'),
        limit: numberSchema('Maximum sample items per category; defaults to 8.'),
        last_workboard_check_at: stringSchema('ISO timestamp of the agent\'s last workboard check. Enables freshness evidence.'),
        previous_snapshot: { type: 'object', description: 'Optional prior snapshot payload for drift comparison.', additionalProperties: true },
      }, ['agent_id']),
    },
    {
      name: 'task_lifecycle_obligations',
      description: 'List directed obligations and ordinary dependency work for an agent.',
      inputSchema: objectSchema({
        agent_id: stringSchema('Agent id to query obligations for.'),
        status: stringSchema('Filter by status: open, completed, rejected. Defaults to open.'),
        limit: numberSchema('Maximum dependency work items to include; defaults to 50.'),
      }, ['agent_id']),
    },
    {
      name: 'task_lifecycle_inspect',
      description: 'Deep-inspect a task: lifecycle state, evidence summary, assignment, obligations, and reports.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to inspect.'),
      }, ['task_number']),
    },
    {
      name: 'task_lifecycle_admit_evidence',
      description: 'Admit evidence for a task through the admission gate (report, verification, criteria).',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to admit evidence for.'),
        agent_id: stringSchema('Agent id performing the admission.'),
        self_certification: { type: 'object', description: 'Optional self-certification guard metadata for closure-sensitive evidence.', additionalProperties: true },
        payload_ref: stringSchema('Optional immutable payload ref carrying self_certification guard metadata. Evidence is read from the lifecycle store.'),
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_prove_criteria',
      description: 'Auto-check all acceptance criteria in the task body and run evidence admission.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to prove criteria for.'),
        agent_id: stringSchema('Agent id performing the proof.'),
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_disposition_closeout',
      description: 'Prepare or complete a lightweight inbox-disposition close-out: resolve envelope status, write execution/verification notes, optionally prove criteria and finish, and return task-owned changed files. For long summaries, create a payload and call with payload_ref plus top-level task_number and agent_id.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to close out.'),
        agent_id: stringSchema('Agent id performing the close-out.'),
        envelope_id: stringSchema('Optional envelope id. If omitted, the task body is scanned for env_<id>.'),
        disposition: stringSchema('Optional disposition label, e.g. already_promoted, acknowledged, dismissed, no_code.'),
        summary: stringSchema('Optional close-out summary. Inline strings over 200 chars should be carried in payload_ref.'),
        payload_ref: stringSchema('Optional immutable payload ref carrying long summary, changed_files, or no_files_changed. Payload fields are merged with top-level arguments; top-level task_number and agent_id win.'),
        dry_run: { type: 'boolean', description: 'Plan without writing task notes or finishing.' },
        prove_criteria: { type: 'boolean', description: 'Auto-check criteria after writing notes. Default false.' },
        finish: { type: 'boolean', description: 'Finish the task after writing/proving. Default false.' },
        changed_files: { type: 'array', items: { type: 'string' }, description: 'Explicit changed-file evidence for the optional finish report.' },
        no_files_changed: { type: 'boolean', description: 'Explicitly declare that the optional finish legitimately changed no files.' },
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_audit',
      description: 'Timeline of recent task lifecycle events: claims, reports, dependency outcomes, admissions, closes.',
      inputSchema: objectSchema({
        since: stringSchema('ISO timestamp start. Defaults to 24 hours ago.'),
        until: stringSchema('ISO timestamp end. Defaults to now.'),
      }),
    },
    {
      name: 'task_lifecycle_finish',
      description: 'Finish a claimed task by submitting a report. If the task has an outcome contract, include outcome and optional findings; contract_id is inferred from the task. Use payload_ref only for long companion fields; top-level task_number and agent_id remain authoritative.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to finish.'),
        agent_id: stringSchema('Agent id finishing the task.'),
        summary: stringSchema('Finish summary.'),
        outcome: stringSchema('Structured outcome for tasks with an outcome contract. Allowed values are inferred from the task contract, for example accepted, accepted_with_notes, rejected, completed, or blocked.'),
        findings: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Structured findings for outcome-contract tasks. Use [] when there are no findings.' },
        evidence_refs: { type: 'array', items: { type: 'string' }, description: 'Optional evidence references supporting the structured outcome.' },
        reviewer: stringSchema('Optional admitted reviewer agent id or unique reviewer role alias for generated review-contract dependency work.'),
        changed_files: { type: 'array', items: { type: 'string' }, description: 'Explicit changed-file evidence for this finish report.' },
        no_files_changed: { type: 'boolean', description: 'Explicitly declare that this finish legitimately changed no files.' },
        authority_basis: authorityBasisSchema('Required when conflict-of-interest policy allows explicit operator override for an outcome-contract dependency task.'),
        payload_ref: stringSchema('Optional immutable payload ref carrying long finish/report companion fields such as summary, changed_files, outcome, findings, recovery_truthfulness, or self_certification. Payload fields are merged with top-level arguments; top-level task_number and agent_id win.'),
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_close',
      description: 'Close a task. Requires the task to be in a closable state.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to close.'),
        agent_id: stringSchema('Agent id closing the task.'),
        mode: stringSchema('Closure mode: operator_direct, peer_reviewed, agent_finish, emergency. Defaults to agent_finish.'),
        no_continuation_needed: stringSchema('Rationale for closing without a continuation task (for design-only/spike tasks).'),
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_dependency_disposition_record',
      description: 'Record explicit disposition for a blocking dependency outcome. Use after dependency satisfaction reports disposition_required=true; required_outcome_id is inferred from the latest outcome when omitted.',
      inputSchema: objectSchema({
        dependency_id: stringSchema('Dependency id whose blocking outcome is being dispositioned.'),
        agent_id: stringSchema('Agent id recording the disposition.'),
        kind: stringSchema('Disposition kind: remediation_task, covered_by_existing_task, routed_obligation, operator_decision_required, operator_deferred, or out_of_scope_or_rejected.'),
        summary: stringSchema('Concise disposition summary and authority rationale.'),
        required_outcome_id: stringSchema('Optional specific task_outcomes.outcome_id. Defaults to latest outcome on the required task.'),
        status: stringSchema('Disposition status. Defaults to open, or deferred for operator_deferred/out_of_scope_or_rejected.'),
        target_task_id: stringSchema('Optional task_id for remediation_task or covered_by_existing_task disposition.'),
        routed_obligation_id: stringSchema('Optional directed obligation id for routed_obligation disposition.'),
        authority_basis: authorityBasisSchema('Required authority basis for operator_deferred and out_of_scope_or_rejected dispositions; optional otherwise.'),
      }, ['dependency_id', 'agent_id', 'kind', 'summary']),
    },
    {
      name: 'task_lifecycle_report_blocked',
      description: 'Record exact blockers for claimed work without implying finish/completion. Defaults to deferring the task after writing a blocked report. For long next_action/blocker details, create a payload and call with payload_ref plus top-level task_number and agent_id.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to report blocked.'),
        agent_id: stringSchema('Agent id reporting the blocker.'),
        reason: stringSchema('Concise blocker summary.'),
        blockers: { type: 'array', items: { type: ['string', 'object'] }, description: 'Specific blockers, including evidence limits or required external decisions.' },
        next_action: stringSchema('Concrete action needed to unblock continuation. Inline strings over 200 chars should be carried in payload_ref.'),
        payload_ref: stringSchema('Optional immutable payload ref carrying long reason, blockers, next_action, or defer. Payload fields are merged with top-level arguments; top-level task_number and agent_id win.'),
        defer: { type: 'boolean', description: 'When false, record the blocked report without transitioning to deferred. Defaults true.' },
      }, ['task_number', 'agent_id', 'reason']),
    },
    {
      name: 'task_lifecycle_search',
      description: 'Search tasks by title or content.',
      inputSchema: objectSchema({
        query: stringSchema('Search query string.'),
        status: stringSchema('Optional status filter.'),
        limit: numberSchema('Maximum results; defaults to 20.'),
      }, ['query']),
    },
    {
      name: 'task_lifecycle_related',
      description: 'Find tasks related to a given task by tag overlap. Returns semantically similar tasks based on shared terms extracted from title, goal, and context.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to find related tasks for.'),
        limit: numberSchema('Maximum results; defaults to 8.'),
      }, ['task_number']),
    },
    {
      name: 'task_lifecycle_defer',
      description: 'Defer a task. Valid for open work and compatibility review/dependency wait states.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to defer.'),
        agent_id: stringSchema('Agent id deferring the task.'),
        reason: stringSchema('Optional reason for deferral.'),
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_reopen',
      description: 'Reopen a closed or confirmed task.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to reopen.'),
        agent_id: stringSchema('Agent id reopening the task.'),
        reason: stringSchema('Optional reason for reopening.'),
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_review',
      description: 'Compatibility migration tool for legacy review calls. Normal review work should be a review-contract dependency task finished with task_lifecycle_finish. This tool preserves old review-row readback while admitting dependency/outcome authority.',
      inputSchema: objectSchema({
        task_number: numberSchema('Legacy parent task number being reviewed.'),
        agent_id: stringSchema('Reviewer agent id for compatibility migration.'),
        verdict: stringSchema('Legacy verdict mapped to a review outcome: accepted, accepted_with_notes, rejected.'),
        findings: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Array of finding objects. Blocking findings must include one disposition: remediation_task, covered_by_existing_task, routed_obligation_id, operator_decision_required, operator_deferred_reason, or out_of_scope_or_rejected with authority_basis.' },
        conflict_policy_authorization: { type: 'object', additionalProperties: true, description: 'Generic conflict-policy authorization basis for admitting an outcome when the dependency worker shares an operator_identity with gated work.' },
        single_operator_review: { type: 'boolean', description: 'Compatibility alias for conflict_policy_authorization on legacy same-operator review calls.' },
      }, ['task_number', 'agent_id', 'verdict']),
    },
    {
      name: 'task_lifecycle_submit_observation',
      description: 'Submit an observation artifact attached to a task or as a general observation.',
      inputSchema: objectSchema({
        task_number: numberSchema('Optional task number to attach to.'),
        artifact_uri: { type: 'string' },
        content: { type: 'object', additionalProperties: true },
        source_operator: stringSchema('Source operator name.'),
        agent_id: stringSchema('Agent id.'),
      }, ['artifact_uri']),
    },
    {
      name: 'task_lifecycle_bridge_poll',
      description: 'Poll the inbox-to-task-lifecycle bridge: evaluate unprocessed envelopes and auto-materialize high-severity tasks.',
      inputSchema: objectSchema({
        dry_run: { type: 'boolean', description: 'If true, evaluate without creating tasks.' },
        threshold: numberSchema('Minimum severity to auto-materialize. Defaults to 50.'),
        limit: numberSchema('Maximum envelopes to evaluate. Defaults to 20.'),
      }),
    },
    {
      name: 'task_lifecycle_inbox_target',
      description: 'Target one inbox envelope by envelope_id for bridge preview/materialization or explicit disposition without relying on broad bridge polling order.',
      inputSchema: objectSchema({
        envelope_id: stringSchema('Inbox envelope ID to inspect or disposition.'),
        dry_run: { type: 'boolean', description: 'If true, preview the targeted action without mutation.' },
        disposition: stringSchema('Disposition: materialize, acknowledge, already_routed, dismiss, defer, or preview. Defaults to materialize.'),
        principal: stringSchema('Principal recorded on disposition evidence.'),
        agent_id: stringSchema('Agent id used as fallback disposition principal.'),
        reason: stringSchema('Disposition reason; required for dismiss.'),
      }, ['envelope_id']),
    },
    {
      name: 'task_lifecycle_create',
      description: 'Create a new task from an immutable payload_ref carrying title, goal, context, required work, non-goals, acceptance criteria, and optional preferred/target roles. required_work and non_goals accept markdown strings or string arrays normalized to newline text.',
      inputSchema: objectSchema({
        payload_ref: stringSchema('Required immutable transient payload ref such as mcp_payload:<id>@v1. Payload must contain the task definition. Use task_lifecycle_payload_schema with tool=task_lifecycle_create for exact shapes and examples.'),
      }, ['payload_ref']),
    },
    ...listPayloadTools(),
    {
      name: 'task_lifecycle_set_routing',
      description: 'Route an opened task to a target role, preferred agent, and/or relative priority without claiming it as that agent.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to route. Must currently be opened.'),
        actor_agent_id: stringSchema('Architect/operator agent id performing the routing mutation.'),
        target_role: nullableStringSchema('Optional target role. Pass null to clear.'),
        preferred_agent_id: nullableStringSchema('Optional preferred agent id. Pass null to clear.'),
        relative_priority: numberSchema('Optional relative priority for workboard ranking.'),
        reason: stringSchema('Reason/authority basis for the routing change.'),
      }, ['task_number', 'actor_agent_id', 'reason']),
    },
    {
      name: 'task_lifecycle_test_mcp_tool',
      description: 'Spawn a fresh MCP server process and invoke a single tool to verify code changes without restarting the live session server.',
      inputSchema: objectSchema({
        server_path: stringSchema('Path to the MCP server script relative to site root (e.g., "tools/task-lifecycle/task-mcp-server.js").'),
        tool_name: stringSchema('Tool name to invoke on the spawned server.'),
        arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments object.' },
        timeout_seconds: numberSchema('Fresh server invocation timeout in seconds. Defaults to 10, max 300.'),
      }, ['server_path', 'tool_name']),
    },
    {
      name: 'task_lifecycle_run_tests',
      description: 'Run an approved test selector through Test MCP and record structured test evidence on a task.',
      inputSchema: objectSchema({
        selector: stringSchema('Test selector: task-lifecycle, typed-mcp, operator-surface, or all. Defaults to task-lifecycle.'),
        task_number: numberSchema('Task number to attach structured test evidence to.'),
        agent_id: stringSchema('Agent id running the tests.'),
        timeout_seconds: numberSchema('Per-test timeout in seconds. Defaults to 120, max 300.'),
      }, ['agent_id']),
    },
  ];
}

function testResultArtifactGate(store, taskId) {
  const rows = store.db.prepare("SELECT artifact_id, artifact_uri, admitted_view_json, created_at FROM observation_artifacts WHERE task_id = ? AND artifact_type = 'test_result' ORDER BY created_at DESC, artifact_id DESC").all(taskId);
  const latestBySelector = new Map<string, Record<string, unknown>>();
  const latestPassing = new Map<string, Record<string, unknown>>();
  for (const artifact of rows.flatMap(parseTestResultArtifact)) {
    const selectorKey = artifact.selector ?? '__unknown_selector__';
    if (!latestBySelector.has(selectorKey)) latestBySelector.set(selectorKey, artifact);
    if (artifact.status === 'passed' && !latestPassing.has(selectorKey)) latestPassing.set(selectorKey, artifact);
  }
  return {
    failed_test_artifacts: [...latestBySelector.values()].filter((artifact) => artifact.status === 'failed'),
    latest_passing_artifacts: [...latestPassing.values()],
  };
}

function parseTestResultArtifact(row) {
  try {
    const payload = JSON.parse(row.admitted_view_json || '{}');
    if (!['failed', 'passed'].includes(payload.status)) return [];
    return [{
      artifact_id: row.artifact_id,
      artifact_uri: row.artifact_uri,
      created_at: row.created_at,
      status: payload.status,
      selector: payload.selector ?? null,
      total: payload.total ?? null,
      passed: payload.passed ?? null,
      failed: payload.failed ?? null,
    }];
  } catch {
    return [];
  }
}

function failedTestResultArtifacts(store, taskId) {
  return testResultArtifactGate(store, taskId).failed_test_artifacts.map((artifact) => ({
    artifact_id: artifact.artifact_id,
    artifact_uri: artifact.artifact_uri,
    created_at: artifact.created_at,
    selector: artifact.selector,
    failed: artifact.failed,
  }));
}

function testTargetsForSelector(selector) {
  switch (selector) {
    case 'task-lifecycle':
      return [
        { test_id: 'task_next_cli' },
        { path: 'tools/task-lifecycle/tests/Test-TaskRoutingMcp.js' },
        { path: 'tools/task-lifecycle/tests/Test-PreferredAgentMismatchClaimAuthority.js' },
        { path: 'tools/task-lifecycle/tests/Test-RecoveryTruthfulnessGuard.js' },
        { path: 'tools/task-lifecycle/tests/Test-McpFinishChangedFileEvidence.js' },
        { path: 'tools/task-lifecycle/tests/Test-SelfCertificationGuard.js' },
        { path: 'tools/task-lifecycle/tests/Test-SelfCertificationMcpFinishGuard.js' },
        { path: 'tools/task-lifecycle/tests/Test-AgentsPostureAudit.js' },
        { path: 'tools/task-lifecycle/tests/Test-RosterSqlVolatileState.js' },
        { path: 'tools/task-lifecycle/tests/Test-CapaDispositionCorrectiveCoverage.js' },
      ];
    case 'typed-mcp':
      return [{ test_id: 'mcp_surface_registry_validation' }];
    case 'operator-surface':
      return [
        { path: 'tools/operator-surface-carriers/Test-AcceptanceCriteriaBodyEnforcement.test.js' },
        { path: 'tools/operator-surface-carriers/agent-desktop-shortcuts-authority.test.js' },
        { path: 'tools/operator-surface/osm-send-permission-policy.test.js' },
        { path: 'tools/operator-surface/operator-surface-shutdown-paths.test.js' },
      ];
    case 'all':
      return [
        { test_id: 'task_next_cli' },
        { test_id: 'shell_mcp' },
        { test_id: 'test_mcp' },
        { test_id: 'mcp_surface_registry_validation' },
        { path: 'tools/operator-surface-carriers/Test-AcceptanceCriteriaBodyEnforcement.test.js' },
      ];
    default:
      throw new Error(`unknown_test_selector: ${selector}`);
  }
}

function parseArgs(argv) {
  const parsed: Record<string, unknown> = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--site-root' && next) {
      parsed.siteRoot = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }
  return parsed;
}

function drainJsonRpcFrames(input) {
  const requests = [];
  let cursor = 0;
  while (cursor < input.length) {
    const headerEnd = input.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) break;
    const header = input.slice(cursor, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error('mcp_stdio_frame_missing_content_length');
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (input.length < bodyEnd) break;
    const body = input.slice(bodyStart, bodyEnd);
    try {
      requests.push(JSON.parse(body));
    } catch {
      requests.push({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: { frame_body: body.slice(0, 200) } } });
    }
    cursor = bodyEnd;
    while (input[cursor] === '\r' || input[cursor] === '\n') cursor += 1;
  }
  return { requests, remaining: input.slice(cursor) };
}

function parseJsonRpcInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (/^Content-Length:/im.test(trimmed)) {
    const parsed = drainJsonRpcFrames(input);
    if (parsed.remaining.trim().length > 0) throw new Error('mcp_stdio_trailing_frame_bytes');
    return parsed.requests;
  }
  return trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error', data: { line: line.slice(0, 200) } } };
    }
  });
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, additionalProperties: false, ...(required.length > 0 ? { required } : {}) };
}

function stringSchema(description) {
  return { type: 'string', description };
}

function authorityBasisSchema(description) {
  return {
    type: 'object',
    description,
    properties: {
      kind: stringSchema('Authority kind: operator_direct_instruction, directed_obligation, or task_owner_handoff.'),
      summary: stringSchema('Concise authority basis summary.'),
    },
  };
}

function nullableStringSchema(description) {
  return { type: 'string', nullable: true, description };
}

function numberSchema(description) {
  return { type: 'number', description };
}

function computeStateFreshness(lastWorkboardCheckAt, generatedAt) {
  const now = new Date();
  const generated = generatedAt ? new Date(generatedAt) : now;
  const lastCheck = lastWorkboardCheckAt ? new Date(lastWorkboardCheckAt) : null;

  const staleThresholdMs = 10 * 60 * 1000; // 10 minutes

  if (!lastCheck) {
    return {
      status: 'unknown',
      stale: true,
      reason: 'No last_workboard_check_at provided. Agent should checkpoint after every workboard check.',
      last_workboard_check_at: null,
      generated_at: generated.toISOString(),
      seconds_since_check: null,
    };
  }

  const secondsSinceCheck = Math.floor((generated.getTime() - lastCheck.getTime()) / 1000);
  const stale = secondsSinceCheck > staleThresholdMs / 1000;

  return {
    status: stale ? 'stale' : 'fresh',
    stale,
    reason: stale
      ? `Last workboard check was ${secondsSinceCheck}s ago (> ${staleThresholdMs / 1000}s threshold). Re-check workboard before declaring state.`
      : `Last workboard check was ${secondsSinceCheck}s ago (within ${staleThresholdMs / 1000}s threshold).`,
    last_workboard_check_at: lastCheck.toISOString(),
    generated_at: generated.toISOString(),
    seconds_since_check: secondsSinceCheck,
  };
}

function buildWorkboardSnapshotPacket({
  agentId,
  agentRole,
  roleBinding,
  generatedAt,
  board,
  recommendation,
  myInProgress,
  myNeedsContinuation,
  pendingReviews,
  responseCounts,
  lastWorkboardCheckAt,
  previousSnapshot,
  limit,
}) {
  const freshness = computeStateFreshness(lastWorkboardCheckAt, generatedAt);
  const nextWorkContract = buildNextWorkContract(board, recommendation ?? null);
  const localFollowups = board.local_followups.slice(0, limit);
  const roleWideFollowups = (board.role_wide_followups || []).slice(0, limit);
  const dependencyWaitingParents = (board.dependency_waiting_parents || []).slice(0, limit);
  const dependencyObligations = (board.dependency_obligations || []).slice(0, limit);
  const dependencyTasks = (board.dependency_tasks || []).slice(0, limit);
  const nonActionableParentFollowups = (board.non_actionable_parent_followups || []).slice(0, limit);
  const closureAuthorityConflicts = (board.closure_authority_conflicts || []).slice(0, limit);
  const recommendationTask = recommendation?.task ?? null;
  const preferredAgentMismatch = recommendationTask?.preferred_agent_id && recommendationTask.preferred_agent_id !== agentId
    ? {
        present: true,
        task_number: recommendationTask.task_number,
        preferred_agent_id: recommendationTask.preferred_agent_id,
        claiming_agent: agentId,
      }
    : { present: false };
  const current = {
    recommendation_action: recommendation?.action ?? null,
    recommendation_task_number: recommendationTask?.task_number ?? null,
    counts: responseCounts,
  };
  const prior = previousSnapshot?.snapshot ? {
    recommendation_action: previousSnapshot.snapshot.recommendation?.action ?? null,
    recommendation_task_number: previousSnapshot.snapshot.recommendation?.task?.task_number ?? null,
    counts: previousSnapshot.snapshot.counts ?? null,
  } : null;
  const drift = prior ? {
    status: JSON.stringify(prior) === JSON.stringify(current) ? 'unchanged' : 'changed',
    previous: prior,
    current,
  } : {
    status: 'no_baseline',
    previous: null,
    current,
  };

  return {
    status: 'ok',
    schema: 'narada.task_lifecycle.workboard_snapshot.v0',
    authority: 'task_lifecycle_sqlite_read_model',
    observational_only: true,
    trace_ready: true,
    no_task_mutation: true,
    no_claim: true,
    no_route: true,
    no_reconcile: true,
    agent_id: agentId,
    agent_role: agentRole,
    role_binding: roleBinding ?? null,
    generated_at: generatedAt,
    workboard_generated_at: board.generated_at ?? null,
    freshness_input: {
      last_workboard_check_at: lastWorkboardCheckAt ?? null,
      source: lastWorkboardCheckAt ? 'caller_supplied' : 'missing',
    },
    state_freshness: freshness,
    recommendation: {
      action: recommendation?.action ?? null,
      reason: recommendation?.reason ?? null,
      task: recommendationTask ? summarizeWorkboardTask(recommendationTask) : null,
      obligation: recommendation?.obligation ?? null,
      inbox_item: recommendation?.inbox_item ?? null,
    },
    next_work_contract: nextWorkContract,
    no_work_assertion_guardrail: nextWorkContract.no_work_assertion_guardrail,
    counts: responseCounts,
    active_state: {
      my_in_progress: myInProgress.map(summarizeWorkboardTask),
      my_needs_continuation: myNeedsContinuation.map(summarizeWorkboardTask),
      dependency_obligations: dependencyObligations,
      dependency_tasks: dependencyTasks.map(summarizeWorkboardTask),
      dependency_waiting_parents: dependencyWaitingParents.map(summarizeWorkboardTask),
      legacy_pending_reviews: pendingReviews.map(summarizeWorkboardTask),
      my_pending_reviews_compat: pendingReviews.map(summarizeWorkboardTask),
      local_followups_sample: localFollowups.map(summarizeWorkboardTask),
      role_wide_followups_sample: roleWideFollowups.map(summarizeWorkboardTask),
      non_actionable_parent_followups_sample: nonActionableParentFollowups.map(summarizeWorkboardTask),
      closure_authority_conflicts_sample: closureAuthorityConflicts.map(summarizeWorkboardTask),
      recently_materialized_sample: (board.recently_materialized || []).slice(0, limit).map(summarizeWorkboardTask),
    },
    preferred_agent_mismatch: preferredAgentMismatch,
    observed_drift: drift,
    evidence_refs: [
      `task_lifecycle_next:${board.generated_at ?? generatedAt}`,
      `workboard_snapshot:${generatedAt}`,
      `agent:${agentId}`,
    ],
  };
}

function summarizeWorkboardTask(task) {
  if (!task) return null;
  return {
    task_number: task.task_number,
    task_id: task.task_id,
    status: task.status,
    title: task.title,
    assigned_agent: task.assigned_agent ?? null,
    target_role: task.target_role ?? null,
    preferred_agent_id: task.preferred_agent_id ?? null,
    preferred_agent_relation: task.preferred_agent_relation ?? null,
    claim_authority: task.claim_authority ?? null,
    visibility: task.visibility ?? null,
    reason: task.reason ?? null,
    child_task_numbers: task.child_task_numbers ?? null,
    active_child_task_numbers: task.active_child_task_numbers ?? null,
    closure_authority: task.closure_authority ?? null,
    pre_claim_warnings: task.pre_claim_warnings ?? [],
    relative_priority: task.relative_priority ?? null,
    updated_at: task.updated_at ?? null,
  };
}

function jsonToolResult(value, isError = false, toolName = null) {
  void toolName;
  const text = JSON.stringify(value);
  const inlineLimit = 4000;
  const truncated = text.length > inlineLimit;
  const renderedText = truncated
    ? `Output truncated; use structuredContent for the complete payload. ${text.slice(0, inlineLimit)}`
    : text;
  return {
    content: [{ type: 'text', text: renderedText, annotations: { audience: ['assistant'] } }],
    structuredContent: {
      ...(value && typeof value === 'object' && !Array.isArray(value) ? value : { value }),
      inline_text_truncated: truncated,
      rendered_text_char_length: Math.min(text.length, inlineLimit),
      full_output_char_length: text.length,
    },
    ...(isError ? { isError: true } : {}),
  };
}

function numberField(record, key) {
  const value = record[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringField(record, key) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function nullableStringField(record, key) {
  const value = record?.[key];
  if (value === null) return null;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function booleanField(record, key) {
  return record?.[key] === true ? true : record?.[key] === false ? false : null;
}

function objectField(record, key) {
  return asRecord(record?.[key]);
}

function stringArrayField(record, key) {
  const value = record?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function relativeSitePath(root, targetPath) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(targetPath);
  return relative(resolvedRoot, resolvedTarget).split(sep).join('/');
}

function replaceTaskSection(body, heading, replacement) {
  const pattern = '^##\\s+' + escapeRegex(heading) + '\\s*$';
  const match = body.match(new RegExp(pattern, 'mi'));
  if (!match) return `${body.trimEnd()}\n\n## ${heading}\n\n${replacement.trim()}\n`;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.match(/^##\s/m);
  const end = nextHeading ? start + nextHeading.index : body.length;
  return `${body.slice(0, start)}\n\n${replacement.trim()}\n\n${body.slice(end).trimStart()}`;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function normalizeRecurringAuthorityBasis(value) {
  const record = asRecord(value);
  const kind = stringField(record, 'kind');
  const summary = stringField(record, 'summary');
  const allowedKinds = new Set(['operator_direct_instruction', 'architect_review', 'task_acceptance', 'manual_trigger', 'scheduled_trigger']);
  if (!kind || !allowedKinds.has(kind) || !summary) return null;
  return { kind, summary };
}

function parseIsoOrNow(value) {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('invalid_current_time');
  return parsed;
}

async function createRecurringTaskInstance({ store, siteRoot, definition, actorAgentId, actorRole, authorityBasis, triggerMode, runReason, eventType, now, dueKey = null }) {
  const nowIso = now instanceof Date ? now.toISOString() : new Date().toISOString();
  const taskNumber = (await allocateTaskNumbers(siteRoot, 1))[0];
  const taskTitle = `${definition.title} (${nowIso.slice(0, 10)})`;
  const taskId = `${todayYmd()}-${taskNumber}-${slugify(taskTitle)}`;
  const tasksDir = join(siteRoot, '.ai', 'do-not-open', 'tasks');
  const filePath = join(tasksDir, `${taskId}.md`);
  const evidenceRequirements = definition.evidence_requirements;
  const triggerLabel = triggerMode === 'schedule' ? 'Scheduled run reason' : 'Manual run reason';
  const recurrenceContext = [
    definition.context_markdown,
    '',
    `Recurring task definition: ${definition.recurrence_id}`,
    `${triggerLabel}: ${runReason}`,
    dueKey ? `Scheduled due key: ${dueKey}` : null,
    evidenceRequirements.length > 0 ? `Evidence requirements: ${evidenceRequirements.join('; ')}` : null,
  ].filter(Boolean).join('\n');
  const body = renderTaskBodyFromSpec({
    spec: {
      title: taskTitle,
      goal: definition.goal_markdown || definition.title,
      context: recurrenceContext,
      chapter: null,
      required_work: definition.required_work_markdown || 'Execute the recurring task instance.',
      non_goals: definition.non_goals_markdown,
      acceptance_criteria: definition.acceptance_criteria,
    },
    executionNotes: null,
    verification: null,
  });
  const frontMatterLines = [
    '---',
    `number: ${taskNumber}`,
    `governed_by: ${definition.preferred_role || definition.target_role || 'unknown'}`,
    'status: opened',
    `recurring_task_id: ${definition.recurrence_id}`,
    `recurring_trigger_mode: ${triggerMode}`,
  ];
  if (dueKey) frontMatterLines.push(`recurring_due_key: ${dueKey}`);
  if (definition.preferred_role) frontMatterLines.push(`preferred_role: ${definition.preferred_role}`);
  if (definition.target_role) frontMatterLines.push(`target_role: ${definition.target_role}`);
  frontMatterLines.push('---');
  const runId = `rtrun_${randomUUID()}`;
  store.db.exec('BEGIN');
  try {
    if (triggerMode === 'schedule' && dueKey) {
      const fresh = getRecurringDefinition(store, definition.recurrence_id);
      if (!fresh || fresh.status !== 'active') {
        store.db.exec('ROLLBACK');
        return { status: 'skipped', recurrence_id: definition.recurrence_id, reason: 'recurrence_not_active' };
      }
      if (fresh.last_due_key === dueKey) {
        store.db.exec('ROLLBACK');
        return { status: 'skipped', recurrence_id: definition.recurrence_id, reason: 'due_key_already_created', due_key: dueKey };
      }
    }
    writeFileSync(filePath, `${frontMatterLines.join('\n')}\n${body}`, 'utf8');
    store.upsertLifecycle({
      task_id: taskId,
      task_number: taskNumber,
      status: 'opened',
      governed_by: definition.preferred_role || definition.target_role || null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: nowIso,
    });
    store.upsertTaskSpec({
      task_id: taskId,
      task_number: taskNumber,
      title: taskTitle,
      chapter_markdown: null,
      goal_markdown: definition.goal_markdown || definition.title,
      context_markdown: recurrenceContext,
      required_work_markdown: definition.required_work_markdown || 'Execute the recurring task instance.',
      non_goals_markdown: definition.non_goals_markdown,
      acceptance_criteria_json: JSON.stringify(definition.acceptance_criteria),
      dependencies_json: '[]',
      updated_at: nowIso,
    });
    ensureTaskRoutingTables(store);
    if (definition.preferred_role || definition.target_role) {
      store.db.prepare(`
        INSERT INTO narada_andrey_task_role_preferences (task_id, preferred_role, target_role, preferred_agent_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          preferred_role = excluded.preferred_role,
          target_role = excluded.target_role,
          preferred_agent_id = excluded.preferred_agent_id,
          updated_at = excluded.updated_at
      `).run(taskId, definition.preferred_role, definition.target_role || definition.preferred_role, null, nowIso);
    }
    insertRecurringRun(store, {
      run_id: runId,
      recurrence_id: definition.recurrence_id,
      task_id: taskId,
      task_number: taskNumber,
      trigger_mode: triggerMode,
      run_reason: runReason,
      actor_agent_id: actorAgentId,
      authority_basis_json: JSON.stringify(authorityBasis),
      created_at: nowIso,
    });
    if (triggerMode === 'schedule' && dueKey) {
      store.db.prepare(`
        UPDATE recurring_task_definitions
        SET last_due_key = ?, last_auto_triggered_at = ?, updated_at = ?
        WHERE recurrence_id = ?
      `).run(dueKey, nowIso, nowIso, definition.recurrence_id);
    }
    insertRecurringEvent(store, {
      recurrenceId: definition.recurrence_id,
      eventType,
      stateAfter: definition.status,
      actorAgentId,
      authorityBasis,
      event: { actor_role: actorRole, run_id: runId, task_id: taskId, task_number: taskNumber, run_reason: runReason, due_key: dueKey },
      now: nowIso,
    });
    store.db.exec('COMMIT');
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw error;
  }
  return {
    status: 'triggered',
    recurrence_id: definition.recurrence_id,
    run_id: runId,
    task_number: taskNumber,
    task_id: taskId,
    file_path: filePath,
    trigger_mode: triggerMode,
    due_key: dueKey,
  };
}

function updateRecurringDefinitionStatus({ store, siteRoot, recurrenceId, actorAgentId, authorityBasis, nextStatus, eventType, reason }) {
  if (!recurrenceId) throw new Error('recurrence_id_required');
  if (!actorAgentId) throw new Error('actor_agent_id_required');
  if (!authorityBasis) throw new Error('valid_authority_basis_required');
  if (!reason) throw new Error('reason_required');
  enforceSessionIdentity(actorAgentId);
  const actorRole = requireRecurringAuthorityActor({ store, siteRoot, actorAgentId });
  const definition = getRecurringDefinition(store, recurrenceId);
  if (!definition) return { status: 'not_found', recurrence_id: recurrenceId };
  if (definition.status === 'retired' && nextStatus !== 'retired') {
    return { status: 'blocked', reason: 'recurrence_retired', recurrence_id: recurrenceId };
  }
  const now = new Date().toISOString();
  ensureRecurringTaskTables(store);
  store.db.exec('BEGIN');
  try {
    const timestampColumn = nextStatus === 'retired' ? 'retired_at' : 'suspended_at';
    store.db.prepare(`
      UPDATE recurring_task_definitions
      SET status = ?, updated_at = ?, ${timestampColumn} = ?
      WHERE recurrence_id = ?
    `).run(nextStatus, now, now, recurrenceId);
    insertRecurringEvent(store, {
      recurrenceId,
      eventType,
      stateAfter: nextStatus,
      actorAgentId,
      authorityBasis,
      event: { actor_role: actorRole, reason },
      now,
    });
    store.db.exec('COMMIT');
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw error;
  }
  return {
    schema: 'narada.task.recurring.transition.v0',
    status: nextStatus,
    recurrence_id: recurrenceId,
    reason,
  };
}

function requireRecurringAuthorityActor({ store, siteRoot, actorAgentId }) {
  const actorRoleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, actorAgentId);
  const actorRole = actorRoleResolution.role;
  if (!['architect', 'operator'].includes(String(actorRole))) {
    throw new Error(`recurring_task_actor_not_authorized: ${actorAgentId}`);
  }
  return String(actorRole);
}

function recurringDueKey(definition, now) {
  if (definition.trigger_mode !== 'schedule') return null;
  if (definition.schedule_kind !== 'daily') return null;
  return now.toISOString().slice(0, 10);
}


function arrayOfStrings(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return strings.length > 0 ? strings : fallback;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function ensureTaskRoutingTables(taskStore) {
  taskStore.db.exec(`
    CREATE TABLE IF NOT EXISTS narada_andrey_task_role_preferences (
      task_id TEXT PRIMARY KEY,
      preferred_role TEXT,
      target_role TEXT,
      preferred_agent_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_routing_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_number INTEGER NOT NULL,
      actor_agent_id TEXT NOT NULL,
      actor_role TEXT,
      reason TEXT NOT NULL,
      changed_fields_json TEXT NOT NULL,
      previous_routing_json TEXT NOT NULL,
      new_routing_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_routing_events_task_id
      ON task_routing_events(task_id);
  `);
  ensureColumn(taskStore, 'narada_andrey_task_role_preferences', 'preferred_role', 'TEXT');
  ensureColumn(taskStore, 'narada_andrey_task_role_preferences', 'target_role', 'TEXT');
  ensureColumn(taskStore, 'narada_andrey_task_role_preferences', 'preferred_agent_id', 'TEXT');
}

function getTaskRouting(taskStore, taskId) {
  ensureTaskRoutingTables(taskStore);
  const lifecycle = taskStore.getLifecycle(taskId);
  const rolePref = taskStore.db.prepare(`
    SELECT target_role, preferred_role, preferred_agent_id
    FROM narada_andrey_task_role_preferences
    WHERE task_id = ?
  `).get(taskId);
  return {
    target_role: rolePref?.target_role || rolePref?.preferred_role || null,
    preferred_agent_id: rolePref?.preferred_agent_id || null,
    relative_priority: lifecycle?.relative_priority ?? 0,
  };
}

function ensureColumn(taskStore, tableName, columnName, columnType) {
  const columns = taskStore.db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    taskStore.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}

function ensureAgentRosterEventsTable(taskStore) {
  taskStore.db.exec(`
    CREATE TABLE IF NOT EXISTS agent_roster_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT,
      capabilities_json TEXT,
      operator_identity TEXT,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      authority_basis_json TEXT NOT NULL,
      admission_status TEXT NOT NULL,
      admitted_by TEXT,
      admitted_at TEXT,
      reason TEXT,
      payload_json TEXT,
      supersedes_event_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_roster_events_agent_id
      ON agent_roster_events(agent_id, requested_at);
    CREATE INDEX IF NOT EXISTS idx_agent_roster_events_status
      ON agent_roster_events(admission_status, requested_at);
  `);
}

function normalizeRosterAuthorityBasis(value) {
  const record = asRecord(value);
  const kind = stringField(record, 'kind');
  const summary = stringField(record, 'summary');
  const allowedKinds = new Set(['operator_direct_instruction', 'directed_obligation', 'task_owner_handoff']);
  if (!kind || !allowedKinds.has(kind) || !summary) return null;
  return { kind, summary };
}

function validateRosterIdentifier(value, fieldName) {
  if (!value) throw new Error(`${fieldName}_required`);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${fieldName}_invalid: expected letters, numbers, dot, underscore, or hyphen only`);
  }
}

function admitRosterIdentity(args) {
  const agentId = stringField(args, 'agent_id');
  const role = stringField(args, 'role');
  const actorAgentId = stringField(args, 'actor_agent_id');
  const capabilitiesProvided = Object.prototype.hasOwnProperty.call(args, 'capabilities');
  const capabilities = stringArrayField(args, 'capabilities') ?? [];
  const operatorIdentity = stringField(args, 'operator_identity') ?? null;
  const authorityBasis = normalizeRosterAuthorityBasis(args.authority_basis);
  const reason = stringField(args, 'reason') ?? authorityBasis?.summary ?? null;
  const dryRun = booleanField(args, 'dry_run') === true;

  validateRosterIdentifier(agentId, 'agent_id');
  validateRosterIdentifier(role, 'role');
  validateRosterIdentifier(actorAgentId, 'actor_agent_id');
  enforceSessionIdentity(actorAgentId);
  if (!authorityBasis) throw new Error('authority_basis_required: kind must be operator_direct_instruction, directed_obligation, or task_owner_handoff and summary is required');

  ensureAgentRosterEventsTable(store);
  const now = new Date().toISOString();
  const existing = store.db.prepare('SELECT * FROM agent_roster WHERE agent_id = ?').get(agentId);
  const operatorIdentityCol = store.db.prepare("PRAGMA table_info(agent_roster)").all().some((column) => column.name === 'operator_identity');
  const projectedCapabilitiesJson = capabilitiesProvided
    ? JSON.stringify(capabilities)
    : (existing?.capabilities_json ?? JSON.stringify(capabilities));
  const projectedRosterEntry = existing ? {
    ...existing,
    role,
    capabilities_json: projectedCapabilitiesJson,
    updated_at: now,
    ...(operatorIdentityCol ? { operator_identity: operatorIdentity ?? existing.operator_identity ?? null } : {}),
  } : {
    agent_id: agentId,
    role,
    capabilities_json: JSON.stringify(capabilities),
    status: 'idle',
    task_number: null,
    last_done: null,
    ...(operatorIdentityCol ? { operator_identity: operatorIdentity } : {}),
  };
  const capabilitiesChanged = existing
    ? JSON.stringify(existing?.capabilities_json ? JSON.parse(existing.capabilities_json) : []) !== projectedCapabilitiesJson
    : false;
  const projectionChanged = !existing || capabilitiesChanged || role !== (existing.role ?? null) || (operatorIdentityCol && operatorIdentity !== (existing.operator_identity ?? null));
  const event = {
    event_id: `roster-${randomUUID()}`,
    event_type: 'admit_agent',
    agent_id: agentId,
    role,
    capabilities_json: JSON.stringify(capabilities),
    operator_identity: operatorIdentity,
    requested_by: actorAgentId,
    requested_at: now,
    authority_basis_json: JSON.stringify(authorityBasis),
    admission_status: existing ? (projectionChanged ? 'updated' : 'already_present') : 'admitted',
    admitted_by: actorAgentId,
    admitted_at: now,
    reason,
    payload_json: JSON.stringify({
      dry_run: dryRun,
      projection_target: 'agent_roster',
      existing_agent_present: Boolean(existing),
      capabilities_changed: capabilitiesChanged,
    }),
    supersedes_event_id: null,
  };

  if (dryRun) {
    return {
      status: existing ? (projectionChanged ? 'would_update' : 'already_present') : 'would_admit',
      schema: 'narada.task.roster_admission.v0',
      dry_run: true,
      event,
      projected_roster_entry: projectedRosterEntry,
    };
  }

  const insertEvent = store.db.prepare(`
    INSERT INTO agent_roster_events (
      event_id, event_type, agent_id, role, capabilities_json, operator_identity,
      requested_by, requested_at, authority_basis_json, admission_status,
      admitted_by, admitted_at, reason, payload_json, supersedes_event_id
    ) VALUES (
      @event_id, @event_type, @agent_id, @role, @capabilities_json, @operator_identity,
      @requested_by, @requested_at, @authority_basis_json, @admission_status,
      @admitted_by, @admitted_at, @reason, @payload_json, @supersedes_event_id
    )
  `);
  insertEvent.run(event);

  if (existing) {
    if (operatorIdentityCol) {
      store.db.prepare(`
        UPDATE agent_roster
        SET role = ?, capabilities_json = ?, operator_identity = ?, updated_at = ?
        WHERE agent_id = ?
      `).run(role, projectedCapabilitiesJson, projectedRosterEntry.operator_identity, now, agentId);
    } else {
      store.db.prepare(`
        UPDATE agent_roster
        SET role = ?, capabilities_json = ?, updated_at = ?
        WHERE agent_id = ?
      `).run(role, projectedCapabilitiesJson, now, agentId);
    }
  } else {
    store.upsertRosterEntry({
      agent_id: agentId,
      role,
      capabilities_json: JSON.stringify(capabilities),
      first_seen_at: now,
      last_active_at: now,
      status: 'idle',
      task_number: null,
      last_done: null,
      updated_at: now,
      ...(operatorIdentityCol ? { operator_identity: operatorIdentity } : {}),
    });
  }

  return {
    status: existing ? (projectionChanged ? 'updated' : 'already_present') : 'admitted',
    schema: 'narada.task.roster_admission.v0',
    dry_run: false,
    event_id: event.event_id,
    agent_id: agentId,
    role,
    capabilities,
    capabilities_changed: capabilitiesChanged,
    append_only_event_recorded: true,
    roster_projection_changed: projectionChanged,
    projection: existing
      ? (projectionChanged ? 'agent_roster_existing_row_updated_from_admitted_event' : 'agent_roster_existing_row_preserved')
      : 'agent_roster_inserted_from_admitted_event',
  };
}

function ensureStaticRosterAgentInSql(taskStore, root, agentId) {
  if (!agentId) return;
  try {
    const existing = taskStore.db.prepare('SELECT agent_id FROM agent_roster WHERE agent_id = ?').get(agentId);
    if (existing) return;
  } catch {
    return;
  }

  const rosterPath = join(root, '.ai', 'agents', 'roster.json');
  let staticAgent = null;
  try {
    const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
    staticAgent = Array.isArray(roster.agents) ? roster.agents.find((agent) => agent?.agent_id === agentId) : null;
  } catch {
    return;
  }
  if (!staticAgent?.role) return;

  const now = new Date().toISOString();
  taskStore.upsertRosterEntry({
    agent_id: staticAgent.agent_id,
    role: staticAgent.role,
    capabilities_json: normalizeCapabilitiesJson(JSON.stringify(staticAgent.capabilities ?? [])),
    first_seen_at: staticAgent.first_seen_at ?? now,
    last_active_at: staticAgent.last_active_at ?? now,
    status: staticAgent.status ?? 'idle',
    task_number: staticAgent.task_number ?? staticAgent.task ?? null,
    last_done: staticAgent.last_done ?? null,
    updated_at: now,
    ...(staticAgent.operator_identity ? { operator_identity: staticAgent.operator_identity } : {}),
  });
}

async function withAuthoredRosterJsonPreserved(root, fn, store = null) {
  const rosterPath = join(root, '.ai', 'agents', 'roster.json');
  let before = null;
  try {
    before = readFileSync(rosterPath, 'utf8');
    const sanitized = sanitizeRosterCapabilitiesJson(before);
    if (sanitized && sanitized !== before) writeFileSync(rosterPath, sanitized, 'utf8');
  } catch {
    before = null;
  }
  if (store) sanitizeSqlRosterCapabilities(store);
  const result = await fn();
  if (before !== null) {
    try {
      const after = readFileSync(rosterPath, 'utf8');
      if (after !== before) {
        writeFileSync(rosterPath, before, 'utf8');
      }
    } catch {
      // Roster JSON is static compatibility config; preservation is best-effort.
    }
  }
  return result;
}

function sanitizeSqlRosterCapabilities(store) {
  try {
    const rows = store.db.prepare('SELECT agent_id, capabilities_json FROM agent_roster').all();
    const update = store.db.prepare('UPDATE agent_roster SET capabilities_json = ? WHERE agent_id = ?');
    for (const row of rows) {
      const normalized = normalizeCapabilitiesJson(row.capabilities_json);
      if (normalized !== row.capabilities_json) update.run(normalized, row.agent_id);
    }
  } catch {
    // Best-effort compatibility normalization before shared governance services run.
  }
}

function sanitizeRosterCapabilitiesJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.agents)) return text;
    let changed = false;
    const agents = parsed.agents.map((agent) => {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return agent;
      const capabilities = agent.capabilities;
      if (Array.isArray(capabilities)) return agent;
      const nested = capabilities && typeof capabilities === 'object' && Array.isArray(capabilities.capabilities)
        ? capabilities.capabilities.filter((item) => typeof item === 'string')
        : [];
      changed = true;
      return { ...agent, capabilities: nested };
    });
    return changed ? JSON.stringify({ ...parsed, agents }, null, 2) : text;
  } catch {
    return text;
  }
}

function normalizeCapabilitiesJson(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    if (Array.isArray(parsed)) return JSON.stringify(parsed.filter((item) => typeof item === 'string'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.capabilities)) return JSON.stringify(parsed.capabilities.filter((item) => typeof item === 'string'));
    return JSON.stringify([]);
  } catch {
    return JSON.stringify([]);
  }
}

/**
 * Spawn a fresh MCP server process and invoke a single tool.
 * Returns the parsed tool result. Used to verify code changes without
 * restarting the long-lived session MCP server.
 */
async function testMcpTool(cwd, serverPath, toolName, toolArgs, options: Record<string, unknown> = {}) {
  const fullServerPath = resolve(cwd, serverPath);
  const init = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test_mcp_tool', version: '1.0' } } });
  const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: toolArgs } });
  const stdin = init + '\n' + req + '\n';
  const timeoutSeconds = Math.min(300, Math.max(1, typeof options.timeoutSeconds === 'number' && Number.isFinite(options.timeoutSeconds) ? options.timeoutSeconds : 10));
  const timeoutMs = timeoutSeconds * 1000;

  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, [fullServerPath, '--site-root', cwd], { cwd });
    let out = '';
    let err = '';
    let settled = false;
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.stdin.write(stdin);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (!proc.killed) proc.kill();
      rej(new Error(`test_mcp_tool timed out after ${timeoutSeconds}s. stderr: ${err}`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const results = out.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const callResult = results.find(r => r.id === 1);
      if (!callResult) {
        rej(new Error(`No tools/call response from ${serverPath}. stderr: ${err}`));
        return;
      }
      if (callResult.error) {
        rej(new Error(`MCP error from ${serverPath}: ${callResult.error.message}`));
        return;
      }
      const content = callResult.result?.content;
      if (content && content[0]?.type === 'text') {
        try {
          res(JSON.parse(content[0].text));
        } catch (e) {
          res({ raw_text: content[0].text });
        }
      } else {
        res(callResult.result);
      }
    });

    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rej(new Error(`Failed to spawn ${serverPath}: ${e.message}`));
    });
  });
}
