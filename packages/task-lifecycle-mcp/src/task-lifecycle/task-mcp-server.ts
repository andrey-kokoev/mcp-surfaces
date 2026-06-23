#!/usr/bin/env node
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { finishTaskService } from '@narada2/task-governance-core/task-finish-service';
import { classifyPostCloseoutContinuation, evaluatePostTransitionFollowups } from './follow-up-policy-service.js';
import { closeTaskService } from '@narada2/task-governance-core/task-close-service';
import { searchTasksService } from '@narada2/task-governance-core/task-search-service';
import { reviewTaskService } from '@narada2/task-governance-core/task-review-service';
import { continueTaskService } from '@narada2/task-governance-core/task-assignment-lifecycle-service';
import { inspectTaskEvidence, findTaskFile, readTaskFile, writeTaskProjection, allocateTaskNumbers } from '@narada2/task-governance-core/task-governance';
import { renderTaskBodyFromSpec } from '@narada2/task-governance-core/task-spec';
import { buildWorkboard } from './workboard.js';
import { buildNextWorkContract, buildUnifiedWorkboard, deriveNextRecommendation } from './unified-workboard.js';
import { admitTaskEvidence } from '@narada2/task-governance-core/evidence-admission';
import { randomUUID } from 'crypto';
import { relative, resolve, join, sep } from 'path';
import { pathToFileURL } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
    ...taskLifecycleDomainTools(),
    ...listPayloadTools(),
  ];
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

function buildCorrectiveDebtReadiness({ allTasks = [] } = {}) {
  const inboxCapas = readActiveInboxCapaItems();
  const capabilityCapas = readPendingCapabilityCapaItems();
  const activeItems = [...inboxCapas.active, ...capabilityCapas.active]
    .map((item) => ({
      ...item,
      corrective_task_coverage: detectCorrectiveTaskCoverage({ item, allTasks }),
    }))
    .sort((a, b) => b.severity - a.severity || String(a.capa_id).localeCompare(String(b.capa_id)));

  const terminalCoverageItems = activeItems.filter((item) => item.corrective_task_coverage.status === 'closed_corrective_implementation_coverage');
  const highSeverityItems = activeItems.filter((item) => item.severity >= 75);
  const correctiveCoveragePressureStatuses = new Set(['missing_corrective_task_coverage', 'historical_only_no_open_corrective_task']);
  const missingCoverageItems = highSeverityItems.filter((item) => correctiveCoveragePressureStatuses.has(item.corrective_task_coverage.status));
  const state = activeItems.length === 0
    ? 'terminal_corrected'
    : terminalCoverageItems.length === activeItems.length
      ? 'corrective_complete_pending_review'
      : missingCoverageItems.length > 0
      ? 'inventory_complete_corrective_open'
      : 'corrective_in_progress';

  return {
    schema: 'narada.task.corrective_debt_readiness.v0',
    authority: 'read_model_from_inbox_admission_log_capas_and_capability_announcements',
    read_only: true,
    state,
    state_vocabulary: [
      'inventory_in_progress',
      'inventory_complete_corrective_open',
      'corrective_in_progress',
      'corrective_complete_pending_review',
      'terminal_corrected',
      'terminal_blocked',
    ],
    high_severity_threshold: 75,
    counts: {
      active_total: activeItems.length,
      active_inbox_capas: inboxCapas.active.length,
      active_capability_reviews: capabilityCapas.active.length,
      high_severity: highSeverityItems.length,
      missing_corrective_task_coverage: missingCoverageItems.length,
      linked_or_covered: activeItems.filter((item) => ['covered_by_open_task', 'closed_corrective_implementation_coverage'].includes(item.corrective_task_coverage.status)).length,
      terminal_or_suppressed_sources: terminalCoverageItems.length + inboxCapas.suppressed_count + capabilityCapas.suppressed_count,
    },
    active_items: activeItems.slice(0, 25),
    missing_corrective_task_coverage: missingCoverageItems.slice(0, 25).map((item) => ({
      capa_id: item.capa_id,
      capa_type: item.capa_type,
      severity: item.severity,
      concept_name: item.concept_name,
      corrective_task_coverage: item.corrective_task_coverage,
    })),
    residual_surfaces: [
      'Coverage detection is a read model over task text/spec linkage; it does not mutate CAPA state or prove semantic correction.',
      'Startup hydration and post-closeout terminal guards must explicitly consume this evidence before it can block terminal readiness claims.',
      'Closed disposition and audit tasks may appear as historical links but do not count as terminal corrective implementation coverage.',
    ],
    sources: {
      inbox_admission_log: '.ai/state/inbox-admission.log',
      capability_announcements: 'operator-surfaces/capability-announcements.json',
      task_lifecycle_sqlite: 'task_specs + task_lifecycle read model',
    },
  };
}

function readActiveInboxCapaItems() {
  let events = [];
  try {
    events = readAdmissionLog(siteRoot);
  } catch {
    return { active: [], suppressed_count: 0 };
  }
  const byEnvelope = new Map();
  const latestPromotion = new Map();
  for (const event of events) {
    if (!event.envelope_id) continue;
    const list = byEnvelope.get(event.envelope_id) ?? [];
    list.push(event);
    byEnvelope.set(event.envelope_id, list);
    if (event.event_kind === 'envelope_promoted') {
      const current = latestPromotion.get(event.envelope_id);
      if (!current || (event.event_sequence ?? 0) > (current.event_sequence ?? 0)) {
        latestPromotion.set(event.envelope_id, event);
      }
    }
  }

  const active = [];
  let suppressedCount = 0;
  for (const [envelopeId, promotionEvent] of latestPromotion.entries()) {
    const history = byEnvelope.get(envelopeId) ?? [];
    const effectiveStatus = resolveEnvelopeStatus(history);
    if (['acknowledged', 'dismissed'].includes(effectiveStatus)) {
      suppressedCount += 1;
      continue;
    }
    const promotion = promotionEvent.event_payload?.promotion ?? {};
    const severity = finiteNumber(promotion.severity, 60);
    const correctiveAction = stringOrNull(promotion.corrective_action);
    active.push({
      capa_id: envelopeId,
      capa_type: 'inbox_capa',
      source_kind: 'promoted_admission_log_envelope',
      status: effectiveStatus,
      severity,
      concept_name: stringOrNull(promotion.concept_name) ?? envelopeId,
      corrective_action_present: Boolean(correctiveAction),
      corrective_action_summary: correctiveAction,
      preventive_action_present: Boolean(stringOrNull(promotion.preventive_action)),
      responsible_agent_id: stringOrNull(promotion.promoted_by) ?? '',
      admitted_at: promotionEvent.timestamp ?? '',
    });
  }
  return { active, suppressed_count: suppressedCount };
}

function readPendingCapabilityCapaItems() {
  const capPath = join(siteRoot, 'operator-surfaces', 'capability-announcements.json');
  if (!existsSync(capPath)) return { active: [], suppressed_count: 0 };
  let capabilities = [];
  try {
    const doc = JSON.parse(readFileSync(capPath, 'utf8'));
    capabilities = Array.isArray(doc.capabilities) ? doc.capabilities : [];
  } catch {
    return { active: [], suppressed_count: 0 };
  }

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const active = [];
  let suppressedCount = 0;
  for (const cap of capabilities) {
    const reviewStatus = cap.review_status ?? 'pending';
    if (reviewStatus === 'completed') {
      suppressedCount += 1;
      continue;
    }
    const reviewDueMs = cap.review_due ? new Date(cap.review_due).getTime() : NaN;
    const daysUntilDue = Number.isFinite(reviewDueMs) ? Math.floor((reviewDueMs - now) / dayMs) : null;
    const severity = Number.isFinite(cap.severity)
      ? cap.severity
      : daysUntilDue === null
        ? 0
        : daysUntilDue < 0
          ? 85
          : daysUntilDue <= 14
            ? 60
            : daysUntilDue <= 30
              ? 40
              : 0;
    if (severity <= 0) continue;
    active.push({
      capa_id: cap.capability_id,
      capa_type: 'capability_announcement',
      source_kind: 'capability_review_obligation',
      status: cap.status ?? reviewStatus,
      review_status: reviewStatus,
      severity,
      concept_name: cap.concept_name ?? cap.capability_id,
      corrective_action_present: false,
      corrective_action_summary: null,
      preventive_action_present: false,
      responsible_agent_id: cap.responsible_agent_id ?? '',
      review_due: cap.review_due ?? '',
      days_until_due: daysUntilDue,
      admitted_at: cap.admitted_at ?? '',
    });
  }
  return { active, suppressed_count: suppressedCount };
}

function detectCorrectiveTaskCoverage({ item, allTasks }) {
  const matches = [];
  const normalizedConcept = normalizeLinkText(item.concept_name);
  for (const row of allTasks ?? []) {
    const spec = row.task_number ? store.getTaskSpecByNumber(row.task_number) : null;
    const projectedTaskBody = readProjectedTaskBody(row.task_id);
    const text = normalizeLinkText([
      spec?.title,
      spec?.goal_markdown,
      spec?.context_markdown,
      spec?.required_work_markdown,
      spec?.non_goals_markdown,
      projectedTaskBody,
      row.task_id,
    ].filter(Boolean).join(' '));
    const reasons = [];
    if (item.capa_id && text.includes(normalizeLinkText(item.capa_id))) reasons.push('capa_id_link');
    if (normalizedConcept.length >= 16 && text.includes(normalizedConcept)) reasons.push('concept_name_link');
    if (reasons.length === 0) continue;
    matches.push({
      task_number: row.task_number,
      task_id: row.task_id,
      status: row.status,
      title: spec?.title ?? row.title ?? '',
      reasons,
      closed_corrective_implementation: isClosedCorrectiveImplementationTask({ row, spec, item, projectedTaskBody }),
    });
  }
  const openStatuses = new Set(['opened', 'claimed', 'needs_continuation', 'in_review']);
  const openMatches = matches.filter((match) => openStatuses.has(match.status));
  if (openMatches.length > 0) {
    return {
      status: 'covered_by_open_task',
      reason: 'open linked task can carry the CAPA corrective implementation to terminal evidence',
      open_task_count: openMatches.length,
      historical_task_count: matches.length - openMatches.length,
      tasks: openMatches.slice(0, 5),
      actionable_next_states: correctiveCoverageNextStates(),
      remediation: 'Continue or finish the linked implementation task, then verify it contains completed acceptance criteria, execution notes, and verification evidence.',
    };
  }
  const terminalMatches = matches.filter((match) => match.closed_corrective_implementation === true);
  if (terminalMatches.length > 0) {
    return {
      status: 'closed_corrective_implementation_coverage',
      reason: 'closed linked task has completed acceptance criteria, execution notes, and verification and is not disposition/audit-only',
      open_task_count: 0,
      historical_task_count: matches.length,
      terminal_task_count: terminalMatches.length,
      tasks: terminalMatches.slice(0, 5),
      actionable_next_states: [],
      remediation: null,
    };
  }
  if (matches.length > 0) {
    return {
      status: 'historical_only_no_open_corrective_task',
      reason: 'linked tasks exist, but they are historical disposition, intake, triage, audit, cluster, inventory, or review work rather than corrective implementation coverage',
      open_task_count: 0,
      historical_task_count: matches.length,
      tasks: matches.slice(0, 5),
      actionable_next_states: correctiveCoverageNextStates(),
      remediation: 'Create or link an implementation task, record an explicit defer/blocker state, or admit a no-action rationale; closed disposition or audit history alone is not terminal corrective coverage.',
    };
  }
  if (item.corrective_action_present || item.severity >= 75) {
    return {
      status: 'missing_corrective_task_coverage',
      reason: 'high-severity or corrective-action CAPA has no linked corrective implementation task coverage',
      open_task_count: 0,
      historical_task_count: 0,
      tasks: [],
      actionable_next_states: correctiveCoverageNextStates(),
      remediation: 'Create or link an implementation task, record an explicit defer/blocker state, or admit a no-action rationale before reporting CAPA terminality.',
    };
  }
  return { status: 'coverage_not_required_by_read_model', reason: 'no corrective action or high-severity pressure detected', open_task_count: 0, historical_task_count: 0, tasks: [], actionable_next_states: [], remediation: null };
}

function correctiveCoverageNextStates() {
  return [
    'linked_corrective_implementation_task',
    'explicit_defer_or_blocker_state',
    'admitted_no_action_rationale',
  ];
}

function isClosedCorrectiveImplementationTask({ row, spec, item, projectedTaskBody = null }) {
  if (!['closed', 'confirmed'].includes(row.status)) return false;
  const title = String(spec?.title ?? row.title ?? '');
  const taskText = [
    title,
    spec?.goal_markdown,
    spec?.context_markdown,
    spec?.required_work_markdown,
    spec?.non_goals_markdown,
    projectedTaskBody ?? readProjectedTaskBody(row.task_id),
  ].filter(Boolean).join('\n');
  const normalized = normalizeLinkText(taskText);
  if (/\b(disposition|intake|triage|audit|cluster|inventory|review)\b/i.test(title)) return false;
  if (!/(implement|implemented|fix|fixed|guard|guarded|prevent|prevented|refuse|refused|enforce|enforced|validate|validated|test|coverage)/i.test(taskText)) return false;
  if (item.capa_id && !normalized.includes(normalizeLinkText(item.capa_id))) return false;
  const evidence = classifyProjectedTaskEvidence(taskText);
  return evidence.acceptance_complete && evidence.execution_notes_present && evidence.verification_present;
}

function readProjectedTaskBody(taskId) {
  if (!taskId) return '';
  const path = join(siteRoot, '.ai', 'do-not-open', 'tasks', `${taskId}.md`);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function classifyProjectedTaskEvidence(body) {
  const acceptanceMatches = [...String(body).matchAll(/^\s*-\s+\[(x|X| )\]\s+\S.*$/gm)];
  const checkedCount = acceptanceMatches.filter((match) => match[1].toLowerCase() === 'x').length;
  return {
    acceptance_complete: acceptanceMatches.length > 0 && checkedCount === acceptanceMatches.length,
    execution_notes_present: sectionHasSubstantiveContent(body, 'Execution Notes'),
    verification_present: sectionHasSubstantiveContent(body, 'Verification'),
  };
}

function sectionHasSubstantiveContent(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body).match(new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i'));
  if (!match) return false;
  const normalized = match[1]
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*[-*]\s*/gm, '')
    .trim();
  return normalized.length >= 20;
}

function normalizeLinkText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildPostCloseoutContinuation({ agentId, result }) {
  refreshStore();
  const roleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
  const agentRole = roleResolution.role;
  const all = store.getAllLifecycle();
  const board = buildUnifiedWorkboard({ store, siteRoot, agentId, agentRole, allTasks: all, limit: 8 });
  const recommendation = deriveNextRecommendation(board, agentId);
  const nextWorkContract = buildNextWorkContract(board, recommendation ?? null);
  const correctiveDebtReadiness = buildCorrectiveDebtReadiness({ allTasks: all });
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
    counts: {
      ...board.counts,
      all_in_review: board.counts.pending_reviews,
    },
    downstream_role_followups: (board.downstream_role_followups || []).slice(0, 8),
  };
  return classifyPostCloseoutContinuation({ result, workboard });
}

function compactNextActionTask(task) {
  if (!task) return null;
  return {
    task_number: task.task_number ?? null,
    title: task.title ?? null,
    status: task.status ?? null,
    target_role: task.target_role ?? null,
    assigned_agent: task.assigned_agent ?? null,
    claim_authority: task.claim_authority ?? null,
  };
}

function buildConciseNextActionView(result) {
  const recommendation = result.recommendation ?? null;
  return {
    schema: 'narada.task.mcp.next.concise.v0',
    status: result.status,
    generated_at: result.generated_at,
    agent_id: result.agent_id,
    agent_role: result.agent_role,
    executable_work_available: result.executable_work_available,
    recommendation: recommendation ? {
      action: recommendation.action ?? null,
      reason: recommendation.reason ?? null,
      task: compactNextActionTask(recommendation.task ?? null),
      next_command: result.next_work_contract?.recommended_claim_command ?? null,
    } : null,
    counts: {
      in_progress: result.counts?.in_progress ?? 0,
      needs_continuation: result.counts?.needs_continuation ?? 0,
      review_obligations: result.my_review_obligations?.length ?? 0,
      local_followups: result.counts?.local_followups ?? 0,
      role_wide_followups: result.counts?.role_wide_followups ?? 0,
      actionable_deferred: result.counts?.actionable_deferred ?? 0,
      inbox_backlog: result.counts?.inbox_total ?? 0,
    },
    actionable_samples: {
      in_progress: (result.in_progress ?? []).slice(0, 3).map(compactNextActionTask),
      needs_continuation: (result.needs_continuation ?? []).slice(0, 3).map(compactNextActionTask),
      local_followups: (result.local_followups ?? []).slice(0, 3).map(compactNextActionTask),
      role_wide_followups: (result.role_wide_followups ?? []).slice(0, 3).map(compactNextActionTask),
      actionable_deferred: (result.actionable_deferred ?? []).slice(0, 3).map(compactNextActionTask),
    },
    external_pressure: result.environment_pressure?.status === 'active'
      ? {
        status: 'active',
        agent_executable: result.environment_pressure.executable_by_agent === true,
        reason: result.environment_pressure.pressure?.reason ?? null,
      }
      : { status: 'clear' },
    guardrail: result.no_work_assertion_guardrail ?? null,
  };
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
          validatePreferredAgentMismatchAuthority,
          recordClaimIntent,
          claimLifecycleTask,
          continueTaskService,
          unclaimLifecycleTask,
          withAuthoredRosterJsonPreserved,
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
          buildCorrectiveDebtReadiness,
          deriveNextRecommendation,
          buildTaskLifecycleFreshness: ({ registeredTools }) => buildTaskLifecycleFreshness({ registeredTools: registeredTools ?? taskLifecycleTools().map((tool) => tool.name) }),
          buildMcpRestartPressure,
          buildStaleLiveNavigationDegradation,
          deriveMcpRestartPressureRecommendation,
          buildNextWorkContract,
          computeStateFreshness,
          buildConciseNextActionView,
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
          readTaskRouting,
          buildTaskEvidencePreflight,
          buildRoutingAssignmentDivergence,
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
          taskLifecycleDispositionCloseout,
          finishTaskService,
          closeTaskService,
          transitionLifecycleTask,
          unDeferLifecycleTask,
          reviewTaskService,
          withAuthoredRosterJsonPreserved,
          openTaskLifecycleStore,
          detectSameOperatorReview,
          detectSelfReview,
          findReviewerCapableAgents,
          isReviewerCapable,
          validateTaskFinishRecoveryTruthfulness,
          finishGateExamples,
          buildStateAwareFinishBlockerRemediation,
          buildTaskFileResolutionFailure,
          detectGitChangedFiles,
          scopeChangedFiles,
          buildTaskEvidencePreflight,
          buildPostCloseoutContinuation,
          emitCheckpoint,
          evaluatePostTransitionFollowups,
          findTaskFile,
          readTaskFile,
          testResultArtifactGate,
          validateFollowUpLedger,
          ensureStaticRosterAgentInSql,
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
          admitRosterIdentity,
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
        mcp_payload_create: (args) => jsonToolResult(payloadCreate({ siteRoot, args })),
        mcp_payload_show: (args) => jsonToolResult(payloadShow({ siteRoot, args })),
        mcp_payload_derive: (args) => jsonToolResult(payloadDerive({ siteRoot, args })),
        mcp_payload_validate: (args) => jsonToolResult(payloadValidate({ siteRoot, args })),
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
  const closedComplete = lifecycle.status === 'closed' && evidence.verdict === 'complete';
  const followUpValidation = validateFollowUpLedger(body);
  const recoveryTruthfulnessValidation = validateRecoveryTruthfulnessBody({ body, summary: '', context: `task:${taskNumber}` });
  const recoveryTruthfulnessTriggered = recoveryTruthfulnessValidation.evaluation?.triggered === true;
  const hasCanonicalFollowUpLedger = /^##\s+Follow-Up Ledger\s*$/mi.test(body);
  const mentionsFollowUpLedger = /Follow-Up Ledger/i.test(body);
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
      has_markdown_verification: hasMaterialTaskSection(body, 'Verification'),
      passed_verification_runs: verificationRuns.filter((run) => run.status === 'passed').map((run) => run.run_id),
      report_verification_count: countReportVerificationEntries(reports, sqliteReports),
      observation_artifact_count: observations.length,
    },
    remediation: observations.length > 0
      ? 'Structured observation artifacts are recorded context but do not satisfy the verification gate. Add substantive ## Verification notes, submit a task report with verification_json, or attach a governed passed verification run.'
      : 'Add substantive ## Verification notes, submit a task report with verification_json, or attach a governed passed verification run.',
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
      has_canonical_section: hasCanonicalFollowUpLedger,
      misplaced_or_nested_ledger_hint: mentionsFollowUpLedger && !hasCanonicalFollowUpLedger,
      errors: followUpValidation.errors,
    },
    remediation: followUpValidation.ok
      ? 'No Follow-Up Ledger remediation is required.'
      : 'Add a canonical top-level ## Follow-Up Ledger section. Each preserved follow-up must say created #N, covered by #N, envelope env_<id>, CAPA <capa_id>, deferred: <reason>, or no follow-up needed: <rationale>. A mention inside another section does not satisfy this gate.',
    examples: finishGateExamples('follow_up_ledger'),
  });
  addRequirement(requirements, {
    id: 'recovery_truthfulness',
    label: 'Recovery Truthfulness',
    required_for_finish: recoveryTruthfulnessTriggered,
    satisfied: recoveryTruthfulnessValidation.ok === true,
    observed: {
      triggered: recoveryTruthfulnessTriggered,
      triggers: recoveryTruthfulnessValidation.evaluation?.triggers ?? [],
      required_fields: recoveryTruthfulnessValidation.evaluation?.required_fields ?? [],
      recovery_section_present: recoveryTruthfulnessValidation.recovery_section_present ?? false,
      recovery_state_vocabulary: recoveryTruthfulnessValidation.evaluation?.state_vocabulary ?? [],
      errors: recoveryTruthfulnessValidation.errors ?? [],
    },
    remediation: recoveryTruthfulnessTriggered
      ? 'Add or repair a top-level ## Recovery Truthfulness section naming Known facts, Inferences, Uncertainty, Changed, Not changed, Remaining work, Evidence limits, CAPA open status, and State. For terminal_corrected, also name repository durability / commit-push state and prove no related task/CAPA/review remains open.'
      : 'Recovery Truthfulness is not required unless the task asserts serious-failure recovery, CAPA correction, operator-trust recovery, authority/locus repair, or terminal completion for corrective work.',
    examples: finishGateExamples('recovery_truthfulness'),
  });
  addRequirement(requirements, {
    id: 'changed_files',
    label: 'Changed-file Evidence',
    satisfied: closedComplete || changedFileEvidence.changedFiles.length > 0 || changedFileEvidence.noFilesChangedDeclarations.length > 0,
    observed: {
      changed_files: changedFileEvidence.changedFiles,
      no_files_changed_declarations: changedFileEvidence.noFilesChangedDeclarations,
      closed_complete_exemption: closedComplete,
    },
    remediation: closedComplete
      ? 'Task is already closed with complete evidence; changed-file evidence is an active finish gate, not a post-close blocker.'
      : changedFileEvidence.changedFiles.length > 0 || changedFileEvidence.noFilesChangedDeclarations.length > 0
      ? 'Changed-file evidence is present in task reports, or an explicit no-files-changed declaration was submitted.'
      : 'Finish/closeout must include changed files, or explicitly declare no files changed for design-only/research work.',
    examples: finishGateExamples('changed_files'),
  });

  const blockers = requirements.filter((item) => item.required_for_finish && item.satisfied !== true).map((item) => ({
    id: item.id,
    label: item.label,
    remediation: item.remediation,
    examples: item.examples,
  }));
  const remediationSummary = blockers.map((item) => `${item.id}: ${item.remediation}`);
  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    schema: 'narada.task.mcp.evidence_preflight.v0',
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    lifecycle_status: lifecycle.status,
    verdict: evidence.verdict,
    finish_ready: blockers.length === 0,
    remediation_summary: remediationSummary,
    next_action: blockers.length === 0 ? 'Submit finish/report evidence.' : 'Resolve each remediation_summary item before finish/report closeout.',
    blockers,
    requirements,
    structured_artifact_policy: {
      observation_artifacts_count: observations.length,
      observation_artifacts_satisfy_verification_gate: false,
      explanation: 'Evidence admission counts authored task sections, task reports, and governed verification runs. Observation artifacts remain context unless promoted into those recognized evidence shapes.',
    },
  };
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
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  return {
    changedFiles: [...new Set(files.filter((file) => typeof file === 'string' && file.trim().length > 0 && file !== NO_FILES_CHANGED_MARKER))],
    noFilesChangedDeclarations: uniqueDeclarations,
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
      description: 'Get the next recommended action for an agent: active work, review obligations, or claimable tasks.',
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
      description: 'List directed obligations for an agent (review requests, etc.).',
      inputSchema: objectSchema({
        agent_id: stringSchema('Agent id to query obligations for.'),
        status: stringSchema('Filter by status: open, completed, rejected. Defaults to open.'),
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
      description: 'Prepare or complete a lightweight inbox-disposition close-out: resolve envelope status, write execution/verification notes, optionally prove criteria and finish, and return task-owned changed files.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to close out.'),
        agent_id: stringSchema('Agent id performing the close-out.'),
        envelope_id: stringSchema('Optional envelope id. If omitted, the task body is scanned for env_<id>.'),
        disposition: stringSchema('Optional disposition label, e.g. already_promoted, acknowledged, dismissed, no_code.'),
        summary: stringSchema('Optional close-out summary.'),
        dry_run: { type: 'boolean', description: 'Plan without writing task notes or finishing.' },
        prove_criteria: { type: 'boolean', description: 'Auto-check criteria after writing notes. Default false.' },
        finish: { type: 'boolean', description: 'Finish the task after writing/proving. Default false.' },
        changed_files: { type: 'array', items: { type: 'string' }, description: 'Explicit changed-file evidence for the optional finish report.' },
        no_files_changed: { type: 'boolean', description: 'Explicitly declare that the optional finish legitimately changed no files.' },
      }, ['task_number', 'agent_id']),
    },
    {
      name: 'task_lifecycle_audit',
      description: 'Timeline of recent task lifecycle events: claims, reports, reviews, admissions, closes.',
      inputSchema: objectSchema({
        since: stringSchema('ISO timestamp start. Defaults to 24 hours ago.'),
        until: stringSchema('ISO timestamp end. Defaults to now.'),
      }),
    },
    {
      name: 'task_lifecycle_finish',
      description: 'Finish a claimed task by submitting a report without verdict using summary plus changed_files or no_files_changed. Review verdicts belong on task_lifecycle_review. Use payload_ref only for long companion fields; top-level task_number and agent_id remain authoritative.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to finish.'),
        agent_id: stringSchema('Agent id finishing the task.'),
        summary: stringSchema('Finish summary.'),
        verdict: { type: 'string', enum: ['accepted', 'accepted_with_notes', 'rejected'], description: 'Review-state verdict only. Omit for claimed-state finish/report submission; claimed tasks should use summary plus changed_files or no_files_changed.' },
        reviewer: stringSchema('Optional admitted reviewer agent id or unique reviewer role alias for the generated review obligation.'),
        changed_files: { type: 'array', items: { type: 'string' }, description: 'Explicit changed-file evidence for this finish report.' },
        no_files_changed: { type: 'boolean', description: 'Explicitly declare that this finish legitimately changed no files.' },
        payload_ref: stringSchema('Optional immutable payload ref carrying long finish/report companion fields such as summary, changed_files, recovery_truthfulness, or self_certification. Payload fields are merged with top-level arguments; top-level task_number and agent_id win.'),
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
      description: 'Defer a task. Only valid from opened or in_review status.',
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
      description: 'Review a task in_review: accept, accept_with_notes, or reject. Response includes close_blocked when evidence admission blocks closure despite accepted review.',
      inputSchema: objectSchema({
        task_number: numberSchema('Task number to review.'),
        agent_id: stringSchema('Reviewer agent id.'),
        verdict: stringSchema('Verdict: accepted, accepted_with_notes, rejected.'),
        findings: { type: 'array', description: 'Array of finding objects. Blocking findings must include one disposition: remediation_task, covered_by_existing_task, routed_obligation_id, operator_decision_required, operator_deferred_reason, or out_of_scope_or_rejected with authority_basis.' },
        single_operator_review: { type: 'boolean', description: 'Set to true to allow and annotate a same-operator review (reviewer and finisher share operator_identity).' },
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
      description: 'Create a new task from an immutable payload_ref carrying title, goal, context, required work, non-goals, acceptance criteria, and optional preferred/target roles.',
      inputSchema: objectSchema({
        payload_ref: stringSchema('Required immutable transient payload ref such as mcp_payload:<id>@v1. Payload must contain the task definition.'),
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
  const latestBySelector = new Map();
  const latestPassingBySelector = new Map();
  for (const artifact of rows.flatMap(parseTestResultArtifact)) {
    const selectorKey = artifact.selector ?? '__unknown_selector__';
    if (!latestBySelector.has(selectorKey)) latestBySelector.set(selectorKey, artifact);
    if (artifact.status === 'passed' && !latestPassingBySelector.has(selectorKey)) latestPassingBySelector.set(selectorKey, artifact);
  }
  return {
    failed_test_artifacts: [...latestBySelector.values()].filter((artifact) => artifact.status === 'failed'),
    latest_passing_artifacts: [...latestPassingBySelector.values()],
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
      my_pending_reviews: pendingReviews.map(summarizeWorkboardTask),
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

function buildStateAwareFinishBlockerRemediation({ taskNumber, agentId, lifecycle, payload }) {
  const closeBlockers = Array.isArray(payload.close_blockers) ? payload.close_blockers : [];
  const blockerText = closeBlockers.join('\n');
  const currentStatus = lifecycle?.status ?? payload.current_status ?? null;
  if (/no-continuation-needed|no continuation needed|continuation task evidence/i.test(blockerText)) {
    return {
      next_action: {
        tool: 'task_lifecycle_close',
        arguments: {
          task_number: taskNumber,
          agent_id: agentId,
          mode: 'agent_finish',
          no_continuation_needed: '<one-line rationale>',
        },
        lifecycle_status: currentStatus,
      },
      next_command: `task_lifecycle_close({ "task_number": ${taskNumber}, "agent_id": "${agentId}", "mode": "agent_finish", "no_continuation_needed": "<one-line rationale>" })`,
      remediation: 'Close scope-complete facade/prototype/spike/design-only work with task_lifecycle_close and no_continuation_needed, or add a concrete continuation task before retrying finish.',
    };
  }
  if (/Latest Evidence Admission result is not eligible for lifecycle close/i.test(blockerText)) {
    if (currentStatus === 'in_review') {
      return {
        next_action: {
          tool: 'task_lifecycle_review',
          arguments: {
            task_number: taskNumber,
            agent_id: '<eligible_reviewer_agent_id>',
            verdict: 'accepted',
          },
          lifecycle_status: currentStatus,
        },
        next_command: `task_lifecycle_show({ "task_number": ${taskNumber} }) to see eligible_reviewers, then task_lifecycle_review({ "task_number": ${taskNumber}, "agent_id": "<eligible_reviewer>", "verdict": "accepted" })`,
        remediation: 'Task is in_review awaiting review. Use task_lifecycle_show or task_lifecycle_inspect to discover eligible reviewers, then call task_lifecycle_review with an admitted reviewer agent id. Do not call finish/close until review is accepted.',
      };
    }
    return {
      next_action: {
        tool: 'task_lifecycle_evidence_preflight',
        arguments: { task_number: taskNumber },
        lifecycle_status: currentStatus,
      },
      next_command: `task_lifecycle_evidence_preflight({ "task_number": ${taskNumber} })`,
      remediation: 'Evidence admission is not eligible for close. Inspect preflight blockers and repair evidence before retrying finish/close.',
    };
  }
  if (/Latest Evidence Admission result is rejected|evidence repair/i.test(blockerText)) {
    const continueAllowed = currentStatus === 'needs_continuation' || currentStatus === 'in_review';
    return {
      next_action: {
        tool: continueAllowed ? 'task_lifecycle_continue' : 'task_lifecycle_evidence_preflight',
        arguments: continueAllowed
          ? { task_number: taskNumber, agent_id: agentId, reason: 'evidence_repair' }
          : { task_number: taskNumber },
        lifecycle_status: currentStatus,
      },
      next_command: continueAllowed
        ? `task_lifecycle_continue({ "task_number": ${taskNumber}, "agent_id": "${agentId}", "reason": "evidence_repair" })`
        : `task_lifecycle_evidence_preflight({ "task_number": ${taskNumber} })`,
      remediation: continueAllowed
        ? 'Repair rejected evidence through task_lifecycle_continue with reason evidence_repair, then rerun evidence admission and finish.'
        : 'Current lifecycle status does not admit evidence-repair continuation; inspect preflight before choosing a lifecycle mutation.',
    };
  }
  if (/lacks an Evidence Admission result/i.test(blockerText)) {
    return {
      next_action: {
        tool: 'task_lifecycle_evidence_preflight',
        arguments: { task_number: taskNumber },
        lifecycle_status: currentStatus,
      },
      next_command: `task_lifecycle_evidence_preflight({ "task_number": ${taskNumber} })`,
      remediation: 'Inspect finish evidence requirements before retrying finish.',
    };
  }
  return {
    next_action: {
      tool: 'task_lifecycle_evidence_preflight',
      arguments: { task_number: taskNumber },
      lifecycle_status: currentStatus,
    },
    next_command: `task_lifecycle_evidence_preflight({ "task_number": ${taskNumber} })`,
    remediation: 'Inspect finish evidence requirements before choosing the next lifecycle action.',
  };
}

function readTaskRouting(store, taskId, spec = null) {
  let rolePref = null;
  try {
    rolePref = store.db.prepare(
      'SELECT target_role, preferred_role, preferred_agent_id FROM narada_andrey_task_role_preferences WHERE task_id = ?'
    ).get(taskId);
  } catch {
    rolePref = null;
  }
  return {
    policy: 'preferred_agent_id_is_soft_affinity_target_role_is_role_gate',
    target_role: rolePref?.target_role || rolePref?.preferred_role || spec?.target_role || spec?.preferred_role || null,
    preferred_agent_id: rolePref?.preferred_agent_id || spec?.preferred_agent_id || null,
    override_authority_required_when_claiming_nonpreferred: true,
    allowed_override_authority_kinds: ['operator_direct_instruction', 'directed_obligation', 'task_owner_handoff'],
  };
}

function buildRoutingAssignmentDivergence({ lifecycle, routing, assignment, reports }) {
  const preferredAgentId = routing?.preferred_agent_id ?? null;
  const activeAgentId = assignment?.agent_id ?? null;
  const reportAgentIds = [...new Set((reports || []).map((report) => report.agent_id).filter(Boolean))];
  const finishedBy = lifecycle.closed_by ?? (reportAgentIds.length === 1 ? reportAgentIds[0] : null);
  const activeMismatch = Boolean(preferredAgentId && activeAgentId && preferredAgentId !== activeAgentId);
  const finishedMismatch = Boolean(preferredAgentId && finishedBy && preferredAgentId !== finishedBy);
  return {
    policy: 'preferred_agent_id_is_not_assignment',
    preferred_agent_id: preferredAgentId,
    active_assignment_agent_id: activeAgentId,
    finished_by: finishedBy,
    report_agent_ids: reportAgentIds,
    active_assignment_diverges_from_preferred: activeMismatch,
    finished_assignment_diverges_from_preferred: finishedMismatch,
    explanation: activeMismatch || finishedMismatch
      ? 'Preferred routing diverges from active or finished assignment; this is allowed only when claim intent evidence records override authority.'
      : 'No preferred-agent divergence observed.',
  };
}

function jsonToolResult(value, isError = false, toolName = null) {
  void toolName;
  const text = JSON.stringify(value, null, 2);
  const inlineLimit = 4000;
  const truncated = text.length > inlineLimit;
  return {
    content: [{ type: 'text', text: truncated ? text.slice(0, inlineLimit) : text, annotations: { audience: ['assistant'] } }],
    structuredContent: {
      ...(value && typeof value === 'object' && !Array.isArray(value) ? value : { value }),
      inline_text_truncated: truncated,
      rendered_text_char_length: Math.min(text.length, inlineLimit),
      full_output_char_length: text.length,
    },
    ...(isError ? { isError: true } : {}),
  };
}

function validatePreferredAgentMismatchAuthority({ args, eligibility, lifecycle, taskNumber, agentId }) {
  if (!eligibility.warning || !eligibility.preferredAgentId || eligibility.preferredAgentId === agentId) {
    return { status: 'not_required', authority_basis: null, preferred_agent_warning: null };
  }
  const preferredAgentWarning = {
    kind: 'preferred_agent_mismatch',
    severity: 'requires_authority',
    warning: 'preferred_agent_mismatch',
    task_number: taskNumber,
    preferred_agent_id: eligibility.preferredAgentId,
    claiming_agent: agentId,
    message: eligibility.warning,
  };
  const authorityBasis = normalizeClaimAuthorityBasis(args.authority_basis);
  if (!authorityBasis) {
    return {
      status: 'blocked',
      authority_basis: null,
      preferred_agent_warning: preferredAgentWarning,
    };
  }
  return {
    status: 'ok',
    authority_basis: {
      ...authorityBasis,
      task_id: lifecycle.task_id,
      task_number: taskNumber,
      preferred_agent_id: eligibility.preferredAgentId,
      claiming_agent: agentId,
    },
    preferred_agent_warning: preferredAgentWarning,
  };
}

function normalizeClaimAuthorityBasis(value) {
  const record = asRecord(value);
  const kind = stringField(record, 'kind');
  const summary = stringField(record, 'summary');
  const allowedKinds = new Set(['operator_direct_instruction', 'directed_obligation', 'task_owner_handoff']);
  if (!kind || !allowedKinds.has(kind) || !summary) return null;
  return { kind, summary };
}

function recordClaimIntent({ store, lifecycle, taskNumber, agentId, status, assignmentId = null, rejectionReason = null, authorityBasis = null, preferredAgentWarning = null }) {
  if (!store.upsertAssignmentIntent) return;
  const now = new Date().toISOString();
  store.upsertAssignmentIntent({
    request_id: `claim-${randomUUID()}`,
    kind: 'claim',
    task_id: lifecycle.task_id,
    task_number: taskNumber,
    agent_id: agentId,
    requested_by: agentId,
    requested_at: now,
    reason: authorityBasis?.summary ?? preferredAgentWarning?.message ?? null,
    no_claim: status === 'claimed' ? 0 : 1,
    status,
    rejection_reason: rejectionReason,
    assignment_id: assignmentId,
    previous_agent_id: null,
    lifecycle_status_before: lifecycle.status,
    lifecycle_status_after: status === 'claimed' ? 'claimed' : lifecycle.status,
    roster_status_after: status === 'claimed' ? 'busy' : null,
    confirmation_json: JSON.stringify({
      authority_basis: authorityBasis,
      preferred_agent_mismatch_acknowledged: Boolean(authorityBasis && preferredAgentWarning),
    }),
    warnings_json: JSON.stringify(preferredAgentWarning ? [preferredAgentWarning] : []),
    updated_at: now,
  });
}

function validateTaskFinishRecoveryTruthfulness({ taskNumber, summary, changedFiles, noFilesChanged, recoveryTruthfulness }) {
  const packet = {
    ...(recoveryTruthfulness ?? {}),
    task_number: taskNumber,
    surface: 'task_lifecycle_finish',
  };
  if (!packet.summary && summary) packet.summary = summary;
  if (!packet.closeout_text && summary) packet.closeout_text = summary;
  if (!packet.changed && changedFiles) packet.changed = changedFiles;
  if (!packet.not_changed && noFilesChanged) packet.not_changed = ['No files changed in this finish/report.'];
  return validateRecoveryTruthfulnessPacket(packet);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function booleanField(record, key) {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return undefined;
}

function nullableStringField(record, key) {
  if (!(key in record)) return undefined;
  if (record[key] === null) return null;
  return stringField(record, key) ?? null;
}

function stringField(record, key) {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function objectField(record, key) {
  const value = record?.[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return undefined;
}

function stringArrayField(record, key) {
  const value = record?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter((entry) => entry.length > 0);
  return strings.length > 0 && strings.length === value.length ? strings : undefined;
}

function detectGitChangedFiles(cwd, basePath = cwd) {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0 || !result.stdout) return [];
  const base = resolve(basePath);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => resolve(cwd, line))
    .filter((absolute) => absolute.startsWith(base + sep) || absolute === base)
    .map((absolute) => relative(base, absolute).replace(/\\/g, '/'));
}

const SCOPED_CHANGED_FILE_EXCLUDE_PATTERNS = [
  /^\.ai\/tmp\b/i,
  /^\.ai\/tmp-/i,
  /^\.ai\/mcp\/carriers\//i,
  /^\.ai\/inbox-envelopes\//i,
  /^vendor\//i,
  /^node_modules\//i,
  /^\.git\//i,
];

const SCOPED_CHANGED_FILE_INCLUDE_PATTERNS = [
  /^(packages|tools|docs|kb|config|operator-surfaces|templates)\//i,
  /^AGENTS\.md$/i,
  /^README\.md$/i,
  /^\.ai\/do-not-open\/tasks\//i,
];

const CHANGED_FILES_SUMMARY_LIMIT = 100;

export function scopeChangedFiles(siteRoot, files, { includeUnrelated = false, taskFilePath = null } = {}) {
  if (includeUnrelated) {
    return { files, scoped: false, truncated: false };
  }
  let scoped = files.filter((file) => !SCOPED_CHANGED_FILE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(file)));
  if (scoped.length > CHANGED_FILES_SUMMARY_LIMIT) {
    scoped = scoped.slice(0, CHANGED_FILES_SUMMARY_LIMIT);
  }
  return {
    files: scoped,
    scoped: true,
    truncated: scoped.length < files.length,
    full_count: files.length,
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

async function taskLifecycleDispositionCloseout({ siteRoot, store, taskNumber, agentId, envelopeId, disposition, summary, dryRun, proveCriteria, finish, changedFiles: finishChangedFiles, noFilesChanged, includeUnrelatedChangedFiles = false }) {
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
  const taskFile = await findTaskFile(siteRoot, taskNumber);
  if (!taskFile) return buildTaskFileResolutionFailure({ siteRoot, store, taskNumber, lifecycle, surface: 'task_lifecycle_disposition_closeout' });
  const original = readFileSync(taskFile.path, 'utf8');
  const resolvedEnvelopeId = envelopeId ?? extractEnvelopeId(original);
  const envelope = resolvedEnvelopeId ? readIndexedEnvelope(siteRoot, resolvedEnvelopeId) : null;
  const envelopeStatus = envelope?.status ?? null;
  const inferredDisposition = disposition ?? inferDisposition(envelopeStatus);
  const changedFiles = [relativeSitePath(siteRoot, taskFile.path)];
  const now = new Date().toISOString();
  const executionNotes = [
    `- Close-out workflow: \`task_lifecycle_disposition_closeout\` invoked by \`${agentId}\` at ${now}.`,
    resolvedEnvelopeId ? `- Envelope: \`${resolvedEnvelopeId}\` (${envelopeStatus ?? 'not_found'}).` : '- Envelope: none detected in task body.',
    envelope?.title ? `- Envelope title: ${envelope.title}` : null,
    `- Disposition: ${inferredDisposition}.`,
    summary ? `- Summary: ${summary}` : null,
  ].filter(Boolean).join('\n');
  const verificationNotes = [
    `- Inbox index refreshed through \`refreshInboxIndex\`; envelope status resolved as \`${envelopeStatus ?? 'not_found'}\`.`,
    '- Scoped changed-file list returned by the workflow for commit planning.',
    proveCriteria ? '- Acceptance criteria proof requested after note materialization.' : '- Acceptance criteria proof not requested by this invocation.',
    finish ? '- Finish requested after note materialization.' : '- Finish not requested by this invocation.',
  ].join('\n');
  const plannedContent = replaceTaskSection(replaceTaskSection(original, 'Execution Notes', executionNotes), 'Verification', verificationNotes);
  const capaCoverageValidation = validateCapaDispositionCorrectiveCoverage({ envelope, body: plannedContent, store });
  if (!capaCoverageValidation.ok) {
    return {
      status: dryRun ? 'dry_run_blocked' : 'blocked',
      error: 'capa_corrective_action_coverage_required',
      schema: 'narada.task.mcp.disposition_closeout.capa_corrective_coverage_gate.v0',
      task_number: taskNumber,
      task_id: lifecycle.task_id,
      envelope: resolvedEnvelopeId ? {
        envelope_id: resolvedEnvelopeId,
        status: envelopeStatus ?? 'not_found',
        title: envelope?.title ?? null,
        kind: envelope?.kind ?? null,
        received_at: envelope?.received_at ?? null,
      } : null,
      close_blocked: true,
      close_blockers: capaCoverageValidation.errors,
      capa_corrective_action_coverage: capaCoverageValidation,
      remediation: 'Add a top-level ## Follow-Up Ledger entry that links the CAPA corrective action to an active implementation task (`created #N` or `covered by #N`), records `deferred:` / blocker rationale, or records `no follow-up needed:` with admitted no-action rationale. Closed audit/disposition tasks alone do not count as corrective-action coverage.',
    };
  }
  let criteriaResult = null;
  let finishResult = null;
  if (!dryRun) {
    writeFileSync(taskFile.path, plannedContent, 'utf8');
    if (proveCriteria) {
      const afterNotes = readFileSync(taskFile.path, 'utf8');
      const proved = afterNotes.replace(/^(\s*)- \[ \](.*)$/gm, '$1- [x]$2');
      if (proved !== afterNotes) writeFileSync(taskFile.path, proved, 'utf8');
      const evidenceMethods: NonNullable<Parameters<typeof admitTaskEvidence>[0]['methods']> = ['criteria_proof'];
      const admission = await admitTaskEvidence({ cwd: siteRoot, taskNumber, admittedBy: agentId, methods: evidenceMethods });
      criteriaResult = {
        status: admission.blockers.length === 0 ? 'proved' : 'proved_with_blockers',
        admission_id: admission.result.admission_id,
        blockers: admission.blockers,
        verdict: admission.result.verdict,
      };
    }
    if (finish) {
      if (finishChangedFiles && noFilesChanged) {
        throw new Error('changed_files_conflicts_with_no_files_changed');
      }
      const rawAutoDetectedChangedFiles = !finishChangedFiles && !noFilesChanged ? detectGitChangedFiles(siteRoot) : [];
      const scopedChangedFiles = scopeChangedFiles(siteRoot, rawAutoDetectedChangedFiles, { includeUnrelated: includeUnrelatedChangedFiles });
      const autoDetectedChangedFiles = scopedChangedFiles.files;
      const finishOptions: Record<string, unknown> = { cwd: siteRoot, taskNumber, agent: agentId, summary: summary ?? `Disposition close-out: ${inferredDisposition}`, close: true };
      if (proveCriteria) finishOptions.proveCriteria = true;
      if (finishChangedFiles) finishOptions.changedFiles = JSON.stringify(finishChangedFiles);
      if (!finishChangedFiles && autoDetectedChangedFiles.length > 0) finishOptions.changedFiles = JSON.stringify(autoDetectedChangedFiles);
      if (noFilesChanged) finishOptions.changedFiles = JSON.stringify([NO_FILES_CHANGED_MARKER]);
      const result = await withAuthoredRosterJsonPreserved(siteRoot, () => finishTaskService(finishOptions));
      finishResult = result.result || result;
      finishResult.follow_up_policy = evaluatePostTransitionFollowups({
        event: { transition_kind: finishResult.close_action ?? 'close', task_number: taskNumber, task_id: lifecycle.task_id, agent_id: agentId },
        source_task: { task_number: taskNumber, task_id: lifecycle.task_id },
        actor: { agent_id: agentId },
        result: finishResult,
        signals: { evidence_blocked: finishResult.close_action === 'blocked' },
      });
      if (finishResult.close_action !== 'blocked') {
        finishResult.post_closeout_continuation = buildPostCloseoutContinuation({ agentId, result: finishResult });
      }
      if (!finishChangedFiles && !noFilesChanged) {
        finishResult.changed_files_scoping = scopedChangedFiles;
      }
    }
  }
  return {
    status: dryRun ? 'dry_run' : 'prepared',
    schema: 'narada.task.mcp.disposition_closeout.v0',
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    envelope: resolvedEnvelopeId ? {
      envelope_id: resolvedEnvelopeId,
      status: envelopeStatus ?? 'not_found',
      title: envelope?.title ?? null,
      kind: envelope?.kind ?? null,
      received_at: envelope?.received_at ?? null,
    } : null,
    disposition: inferredDisposition,
    capa_corrective_action_coverage: capaCoverageValidation,
    changed_files: changedFiles,
    committable_path_set: {
      schema: 'narada.task.disposition_closeout.committable_path_set.v0',
      task_owned_paths: changedFiles,
      ordinary_task_closeout_paths: changedFiles,
      ignored_envelope_projection_paths: [],
      envelope_handoff_tool: 'git_handoff_inbox_envelope_export',
      guidance: 'Stage ordinary_task_closeout_paths with git_task_closeout_commit_and_push. Ignored .ai/inbox-envelopes projections are not ordinary task-owned paths; use git_handoff_inbox_envelope_export for an exact admitted envelope JSON export when one must be committed.',
    },
    notes_written: !dryRun,
    criteria_result: criteriaResult,
    finish_result: finishResult,
    commit_ready: {
      stage_paths: changedFiles,
      ordinary_task_closeout_paths: changedFiles,
      ignored_envelope_projection_paths: [],
      envelope_handoff_tool: 'git_handoff_inbox_envelope_export',
      exclude_unrelated_dirty_files: true,
    },
  };
}

function buildTaskFileResolutionFailure({ siteRoot, store, taskNumber, lifecycle, surface }) {
  const expectedPath = resolve(siteRoot, '.ai', 'do-not-open', 'tasks', `${lifecycle.task_id}.md`);
  const spec = store.getTaskSpec(lifecycle.task_id) ?? store.getTaskSpecByNumber?.(taskNumber) ?? null;
  const assignment = store.getActiveAssignment?.(lifecycle.task_id) ?? null;
  return {
    status: 'error',
    error: 'task_file_resolution_failed',
    schema: 'narada.task.mcp.task_file_resolution_failed.v1',
    surface,
    task_number: taskNumber,
    task_id: lifecycle.task_id,
    lifecycle_task_id: lifecycle.task_id,
    lifecycle_status: lifecycle.status,
    lifecycle_row_exists: true,
    task_spec_exists: Boolean(spec),
    active_assignment_agent_id: assignment?.agent_id ?? null,
    expected_path: expectedPath,
    task_file_exists: false,
    resolution_source: 'sqlite_lifecycle_without_markdown_projection',
    recommended_next_tool: 'task_lifecycle_show',
    repair_options: [
      {
        tool: 'task_lifecycle_show',
        reason: 'Inspect the SQLite-backed task state and task_id before choosing a repair path.',
        arguments: { task_number: taskNumber },
      },
      {
        tool: 'task_lifecycle_record_observation',
        reason: 'Record evidence without mutating the missing task markdown projection.',
        arguments: { task_number: taskNumber },
      },
      {
        tool: 'task_lifecycle_reopen',
        reason: 'Use only if the lifecycle state itself needs a governed transition before regenerating or replacing the task projection.',
        arguments: { task_number: taskNumber },
      },
    ],
    remediation: 'The task exists in SQLite lifecycle state but its markdown task projection could not be resolved. Do not retry closeout/report blindly. Inspect the task, restore/regenerate the expected markdown projection if needed, or use DB-backed observation/transition tools that do not require the markdown file.',
  };
}

function validateCapaDispositionCorrectiveCoverage({ envelope, body, store }) {
  const payload = envelope?.envelope?.payload ?? envelope?.envelope ?? envelope?.payload ?? {};
  const envelopeId = envelope?.envelope_id ?? envelope?.envelope?.envelope_id ?? null;
  const classification = String(payload.classification ?? envelope?.kind ?? '').toLowerCase();
  const correctiveAction = typeof payload.corrective_action === 'string' ? payload.corrective_action.trim() : '';
  const capaLike = Boolean(correctiveAction)
    || classification.includes('capa')
    || Array.isArray(payload.related_capas)
    || Array.isArray(payload.acceptance_evidence);
  if (!capaLike || !correctiveAction) {
    return { ok: true, required: false, status: 'not_required', errors: [] };
  }

  const ledger = extractTaskSection(body, 'Follow-Up Ledger');
  if (!ledger) {
    return {
      ok: false,
      required: true,
      status: 'missing_corrective_action_coverage',
      envelope_id: envelopeId,
      corrective_action_present: true,
      corrective_action_summary: correctiveAction,
      errors: [`CAPA ${envelopeId ?? 'unknown'} has corrective_action but no Follow-Up Ledger entry proving implementation coverage, deferral/blocker state, or no-action rationale.`],
    };
  }

  const lines = ledger.split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s+/, '')).filter(Boolean);
  const activeStatuses = new Set(['opened', 'claimed', 'needs_continuation', 'in_review']);
  const taskLinks = [];
  for (const line of lines) {
    const taskMatches = [...line.matchAll(/\b(?:created|covered by)\s+#(\d+)\b/gi)];
    for (const match of taskMatches) {
      const taskNumber = Number(match[1]);
      const lifecycle = Number.isFinite(taskNumber) ? store.getLifecycleByNumber(taskNumber) : null;
      taskLinks.push({
        task_number: taskNumber,
        status: lifecycle?.status ?? 'not_found',
        active_implementation_coverage: lifecycle ? activeStatuses.has(lifecycle.status) : false,
        line,
      });
    }
  }
  const activeTaskLinks = taskLinks.filter((link) => link.active_implementation_coverage);
  const deferredOrBlocked = lines.find((line) => /\b(?:deferred|blocked|blocker)\s*:/i.test(line));
  const noAction = lines.find((line) => /\bno follow-?up needed\s*:/i.test(line) || /\bno[- ]action rationale\s*:/i.test(line));
  if (activeTaskLinks.length > 0 || deferredOrBlocked || noAction) {
    return {
      ok: true,
      required: true,
      status: activeTaskLinks.length > 0 ? 'covered_by_active_implementation_task' : deferredOrBlocked ? 'explicit_defer_or_blocker_state' : 'admitted_no_action_rationale',
      envelope_id: envelopeId,
      corrective_action_present: true,
      corrective_action_summary: correctiveAction,
      task_links: taskLinks,
      accepted_line: deferredOrBlocked ?? noAction ?? null,
      errors: [],
    };
  }

  return {
    ok: false,
    required: true,
    status: 'missing_corrective_action_coverage',
    envelope_id: envelopeId,
    corrective_action_present: true,
    corrective_action_summary: correctiveAction,
    task_links: taskLinks,
    errors: [`CAPA ${envelopeId ?? 'unknown'} corrective action lacks active implementation coverage. Link an active task with created #N / covered by #N, record deferred/blocker state, or record no follow-up needed with no-action rationale. Closed historical/disposition tasks do not count.`],
  };
}

function extractEnvelopeId(text) {
  const match = text.match(/env_[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

function readIndexedEnvelope(siteRoot, envelopeId): Record<string, unknown> | null {
  const index = refreshInboxIndex(siteRoot, { evaluateEnvelopeSeverity });
  try {
    const row = index.db.prepare('SELECT * FROM inbox_envelopes WHERE envelope_id = ?').get(envelopeId) as Record<string, unknown>;
    if (!row) return null;
    return { ...row, envelope: JSON.parse(String(row.payload_json)) };
  } finally {
    index.db.close();
  }
}

function inferDisposition(envelopeStatus) {
  if (envelopeStatus === 'promoted') return 'already_promoted';
  if (envelopeStatus === 'acknowledged') return 'already_acknowledged';
  if (envelopeStatus === 'dismissed') return 'already_dismissed';
  if (envelopeStatus === 'received') return 'received_pending_disposition';
  return 'no_envelope_or_unknown_status';
}

function replaceTaskSection(markdown, heading, replacement) {
  const pattern = new RegExp(`(## ${heading}\\r?\\n\\r?\\n)[\\s\\S]*?(?=\\r?\\n## )`);
  if (!pattern.test(markdown)) return `${markdown.trimEnd()}\n\n## ${heading}\n\n${replacement}\n`;
  return markdown.replace(pattern, `$1${replacement}\n`);
}

function relativeSitePath(siteRoot, filePath) {
  return relative(resolve(siteRoot), resolve(filePath)).replace(/\\/g, '/');
}

function ensureRecurringTaskTables(taskStore) {
  taskStore.db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_task_definitions (
      recurrence_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_mode TEXT NOT NULL,
      trigger_description TEXT,
      target_role TEXT,
      preferred_role TEXT,
      goal_markdown TEXT,
      context_markdown TEXT,
      required_work_markdown TEXT,
      non_goals_markdown TEXT,
      acceptance_criteria_json TEXT NOT NULL,
      evidence_requirements_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      suspended_at TEXT,
      retired_at TEXT,
      schedule_kind TEXT,
      schedule_interval INTEGER,
      schedule_timezone TEXT,
      last_due_key TEXT,
      last_auto_triggered_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_task_definitions_status
      ON recurring_task_definitions(status, updated_at);

    CREATE TABLE IF NOT EXISTS recurring_task_runs (
      run_id TEXT PRIMARY KEY,
      recurrence_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_number INTEGER NOT NULL,
      trigger_mode TEXT NOT NULL,
      run_reason TEXT NOT NULL,
      actor_agent_id TEXT NOT NULL,
      authority_basis_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (recurrence_id) REFERENCES recurring_task_definitions(recurrence_id),
      FOREIGN KEY (task_id) REFERENCES task_lifecycle(task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_task_runs_recurrence
      ON recurring_task_runs(recurrence_id, created_at);

    CREATE TABLE IF NOT EXISTS recurring_task_events (
      event_id TEXT PRIMARY KEY,
      recurrence_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      state_after TEXT NOT NULL,
      actor_agent_id TEXT NOT NULL,
      authority_basis_json TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (recurrence_id) REFERENCES recurring_task_definitions(recurrence_id)
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_task_events_recurrence
      ON recurring_task_events(recurrence_id, created_at);
  `);
  ensureRecurringColumn(taskStore, 'schedule_kind', 'TEXT');
  ensureRecurringColumn(taskStore, 'schedule_interval', 'INTEGER');
  ensureRecurringColumn(taskStore, 'schedule_timezone', 'TEXT');
  ensureRecurringColumn(taskStore, 'last_due_key', 'TEXT');
  ensureRecurringColumn(taskStore, 'last_auto_triggered_at', 'TEXT');
}

function ensureRecurringColumn(taskStore, columnName, columnType) {
  const columns = taskStore.db.prepare('PRAGMA table_info(recurring_task_definitions)').all();
  if (columns.some((column) => column.name === columnName)) return;
  taskStore.db.exec(`ALTER TABLE recurring_task_definitions ADD COLUMN ${columnName} ${columnType}`);
}

function insertRecurringDefinition(taskStore, definition) {
  ensureRecurringTaskTables(taskStore);
  taskStore.db.prepare(`
    INSERT INTO recurring_task_definitions (
      recurrence_id, title, status, trigger_mode, trigger_description,
      target_role, preferred_role, goal_markdown, context_markdown,
      required_work_markdown, non_goals_markdown, acceptance_criteria_json,
      evidence_requirements_json, created_by, created_at, updated_at,
      suspended_at, retired_at, schedule_kind, schedule_interval,
      schedule_timezone, last_due_key, last_auto_triggered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    definition.recurrence_id,
    definition.title,
    definition.status,
    definition.trigger_mode,
    definition.trigger_description,
    definition.target_role,
    definition.preferred_role,
    definition.goal_markdown,
    definition.context_markdown,
    definition.required_work_markdown,
    definition.non_goals_markdown,
    definition.acceptance_criteria_json,
    definition.evidence_requirements_json,
    definition.created_by,
    definition.created_at,
    definition.updated_at,
    definition.suspended_at,
    definition.retired_at,
    definition.schedule_kind ?? null,
    definition.schedule_interval ?? null,
    definition.schedule_timezone ?? null,
    definition.last_due_key ?? null,
    definition.last_auto_triggered_at ?? null,
  );
}

function insertRecurringEvent(taskStore, { recurrenceId, eventType, stateAfter, actorAgentId, authorityBasis, event, now }) {
  ensureRecurringTaskTables(taskStore);
  taskStore.db.prepare(`
    INSERT INTO recurring_task_events (
      event_id, recurrence_id, event_type, state_after, actor_agent_id,
      authority_basis_json, event_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `rtevt_${randomUUID()}`,
    recurrenceId,
    eventType,
    stateAfter,
    actorAgentId,
    JSON.stringify(authorityBasis),
    JSON.stringify(event ?? {}),
    now,
  );
}

function insertRecurringRun(taskStore, run) {
  ensureRecurringTaskTables(taskStore);
  taskStore.db.prepare(`
    INSERT INTO recurring_task_runs (
      run_id, recurrence_id, task_id, task_number, trigger_mode,
      run_reason, actor_agent_id, authority_basis_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.run_id,
    run.recurrence_id,
    run.task_id,
    run.task_number,
    run.trigger_mode,
    run.run_reason,
    run.actor_agent_id,
    run.authority_basis_json,
    run.created_at,
  );
}

function getRecurringDefinition(taskStore, recurrenceId) {
  ensureRecurringTaskTables(taskStore);
  const row = taskStore.db.prepare('SELECT * FROM recurring_task_definitions WHERE recurrence_id = ?').get(recurrenceId);
  return row ? hydrateRecurringDefinition(row) : null;
}

function listRecurringDefinitions(taskStore, { status = null, limit = 50 } = {}) {
  ensureRecurringTaskTables(taskStore);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const rows = status
    ? taskStore.db.prepare('SELECT * FROM recurring_task_definitions WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, boundedLimit)
    : taskStore.db.prepare('SELECT * FROM recurring_task_definitions ORDER BY updated_at DESC LIMIT ?').all(boundedLimit);
  return rows.map(hydrateRecurringDefinition);
}

function listDueRecurringDefinitions(taskStore, { now, limit = 20 }: Record<string, unknown> = {}) {
  ensureRecurringTaskTables(taskStore);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const rows = taskStore.db.prepare(`
    SELECT * FROM recurring_task_definitions
    WHERE status = 'active'
      AND trigger_mode = 'schedule'
      AND schedule_kind = 'daily'
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(boundedLimit * 2);
  return rows.map(hydrateRecurringDefinition).filter((definition) => {
    const dueKey = recurringDueKey(definition, now);
    return Boolean(dueKey && definition.last_due_key !== dueKey);
  }).slice(0, boundedLimit);
}

function listRecurringRuns(taskStore, recurrenceId, limit = 20) {
  ensureRecurringTaskTables(taskStore);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  return taskStore.db.prepare(`
    SELECT r.*, s.title
    FROM recurring_task_runs r
    LEFT JOIN task_specs s ON r.task_id = s.task_id
    WHERE r.recurrence_id = ?
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(recurrenceId, boundedLimit).map((row) => ({
    run_id: row.run_id,
    recurrence_id: row.recurrence_id,
    task_id: row.task_id,
    task_number: row.task_number,
    title: row.title ?? null,
    trigger_mode: row.trigger_mode,
    run_reason: row.run_reason,
    actor_agent_id: row.actor_agent_id,
    authority_basis: parseJsonOrNull(row.authority_basis_json),
    created_at: row.created_at,
  }));
}

function hydrateRecurringDefinition(row) {
  return {
    recurrence_id: row.recurrence_id,
    title: row.title,
    status: row.status,
    trigger_mode: row.trigger_mode,
    trigger_description: row.trigger_description ?? null,
    target_role: row.target_role ?? null,
    preferred_role: row.preferred_role ?? null,
    goal_markdown: row.goal_markdown ?? null,
    context_markdown: row.context_markdown ?? null,
    required_work_markdown: row.required_work_markdown ?? null,
    non_goals_markdown: row.non_goals_markdown ?? null,
    acceptance_criteria: parseJsonArray(row.acceptance_criteria_json),
    evidence_requirements: parseJsonArray(row.evidence_requirements_json),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    suspended_at: row.suspended_at ?? null,
    retired_at: row.retired_at ?? null,
    schedule_kind: row.schedule_kind ?? null,
    schedule_interval: row.schedule_interval ?? null,
    schedule_timezone: row.schedule_timezone ?? null,
    last_due_key: row.last_due_key ?? null,
    last_auto_triggered_at: row.last_auto_triggered_at ?? null,
  };
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
    capabilities_json: JSON.stringify(staticAgent.capabilities ?? []),
    first_seen_at: staticAgent.first_seen_at ?? now,
    last_active_at: staticAgent.last_active_at ?? now,
    status: staticAgent.status ?? 'idle',
    task_number: staticAgent.task_number ?? staticAgent.task ?? null,
    last_done: staticAgent.last_done ?? null,
    updated_at: now,
    ...(staticAgent.operator_identity ? { operator_identity: staticAgent.operator_identity } : {}),
  });
}

async function withAuthoredRosterJsonPreserved(root, fn) {
  const rosterPath = join(root, '.ai', 'agents', 'roster.json');
  let before = null;
  try {
    before = readFileSync(rosterPath, 'utf8');
  } catch {
    before = null;
  }
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
