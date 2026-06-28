import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNextWorkContract, buildUnifiedWorkboard, deriveNextRecommendation } from './unified-workboard.js';
import { classifyPostCloseoutContinuation } from './follow-up-policy-service.js';
import { readAdmissionLog, resolveEnvelopeStatus } from '../inbox/admission-log.js';
import { resolveAgentRoleWithDiagnostics } from './agent-role-resolution.js';

type TaskLifecyclePayload = Record<string, unknown>;

let readModelSiteRoot = null;
let readModelStore = null;

export function setTaskLifecycleReadModelContext({ siteRoot, store }) {
  readModelSiteRoot = siteRoot;
  readModelStore = store;
}

export function computeStateFreshness(lastWorkboardCheckAt, generatedAt) {
  const now = new Date();
  const generated = generatedAt ? new Date(generatedAt) : now;
  const lastCheck = lastWorkboardCheckAt ? new Date(lastWorkboardCheckAt) : null;
  const staleThresholdMs = 10 * 60 * 1000;
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

export function buildWorkboardSnapshotPacket({ agentId, agentRole, roleBinding, generatedAt, board, recommendation, myInProgress, myNeedsContinuation, pendingReviews, responseCounts, lastWorkboardCheckAt, previousSnapshot, limit }) {
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
    freshness_input: { last_workboard_check_at: lastWorkboardCheckAt ?? null, source: lastWorkboardCheckAt ? 'caller_supplied' : 'missing' },
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
    evidence_refs: [`task_lifecycle_next:${board.generated_at ?? generatedAt}`, `workboard_snapshot:${generatedAt}`, `agent:${agentId}`],
  };
}

export function buildCorrectiveDebtReadiness({ allTasks = [] } = {}) {
  const inboxCapas = readActiveInboxCapaItems();
  const capabilityCapas = readPendingCapabilityCapaItems();
  const activeItems = [...inboxCapas.active, ...capabilityCapas.active]
    .map((item) => ({ ...item, corrective_task_coverage: detectCorrectiveTaskCoverage({ item, allTasks }) }))
    .sort((a, b) => b.severity - a.severity || String(a.capa_id).localeCompare(String(b.capa_id)));
  const terminalCoverageItems = activeItems.filter((item) => item.corrective_task_coverage.status === 'closed_corrective_implementation_coverage');
  const highSeverityItems = activeItems.filter((item) => item.severity >= 75);
  const correctiveCoveragePressureStatuses = new Set(['missing_corrective_task_coverage', 'historical_only_no_open_corrective_task']);
  const missingCoverageItems = highSeverityItems.filter((item) => correctiveCoveragePressureStatuses.has(item.corrective_task_coverage.status));
  const state = activeItems.length === 0 ? 'terminal_corrected' : terminalCoverageItems.length === activeItems.length ? 'corrective_complete_pending_review' : missingCoverageItems.length > 0 ? 'inventory_complete_corrective_open' : 'corrective_in_progress';
  return {
    schema: 'narada.task.corrective_debt_readiness.v0',
    authority: 'read_model_from_inbox_admission_log_capas_and_capability_announcements',
    read_only: true,
    state,
    state_vocabulary: ['inventory_in_progress', 'inventory_complete_corrective_open', 'corrective_in_progress', 'corrective_complete_pending_review', 'terminal_corrected', 'terminal_blocked'],
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
    missing_corrective_task_coverage: missingCoverageItems.slice(0, 25).map((item) => ({ capa_id: item.capa_id, capa_type: item.capa_type, severity: item.severity, concept_name: item.concept_name, corrective_task_coverage: item.corrective_task_coverage })),
    residual_surfaces: [
      'Coverage detection is a read model over task text/spec linkage; it does not mutate CAPA state or prove semantic correction.',
      'Startup hydration and post-closeout terminal guards must explicitly consume this evidence before it can block terminal readiness claims.',
      'Closed disposition and audit tasks may appear as historical links but do not count as terminal corrective implementation coverage.',
    ],
    sources: { inbox_admission_log: '.ai/state/inbox-admission.log', capability_announcements: 'operator-surfaces/capability-announcements.json', task_lifecycle_sqlite: 'task_specs + task_lifecycle read model' },
  };
}

export function buildPostCloseoutContinuation({ agentId, result }) {
  ensureReadModelContext();
  const roleResolution = resolveAgentRoleWithDiagnostics(readModelStore, readModelSiteRoot, agentId);
  const agentRole = roleResolution.role;
  const all = readModelStore.getAllLifecycle();
  const board = buildUnifiedWorkboard({ store: readModelStore, siteRoot: readModelSiteRoot, agentId, agentRole, allTasks: all, limit: 8 });
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
    corrective_debt_readiness,
    counts: { ...board.counts, all_in_review: board.counts.pending_reviews },
    downstream_role_followups: (board.downstream_role_followups || []).slice(0, 8),
  };
  return classifyPostCloseoutContinuation({ result, workboard });
}

export function buildConciseNextActionView(result) {
  const recommendation = result.recommendation ?? null;
  return {
    schema: 'narada.task.mcp.next.concise.v0',
    status: result.status,
    generated_at: result.generated_at,
    agent_id: result.agent_id,
    agent_role: result.agent_role,
    executable_work_available: result.executable_work_available,
    recommendation: recommendation ? { action: recommendation.action ?? null, reason: recommendation.reason ?? null, task: compactNextActionTask(recommendation.task ?? null), next_command: result.next_work_contract?.recommended_claim_command ?? null } : null,
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
    external_pressure: result.environment_pressure?.status === 'active' ? { status: 'active', agent_executable: result.environment_pressure.executable_by_agent === true, reason: result.environment_pressure.pressure?.reason ?? null } : { status: 'clear' },
    guardrail: result.no_work_assertion_guardrail ?? null,
  };
}

function ensureReadModelContext() {
  if (!readModelSiteRoot || !readModelStore) throw new Error('task_lifecycle_read_model_context_not_initialized');
}

function readActiveInboxCapaItems() {
  try {
    const events = readAdmissionLog(readModelSiteRoot);
    const byEnvelope = new Map();
    const latestPromotion = new Map();
    for (const event of events) {
      if (!event.envelope_id) continue;
      const list = byEnvelope.get(event.envelope_id) ?? [];
      list.push(event);
      byEnvelope.set(event.envelope_id, list);
      if (event.event_kind === 'envelope_promoted') {
        const current = latestPromotion.get(event.envelope_id);
        if (!current || (event.event_sequence ?? 0) > (current.event_sequence ?? 0)) latestPromotion.set(event.envelope_id, event);
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
  } catch {
    return { active: [], suppressed_count: 0 };
  }
}

function readPendingCapabilityCapaItems() {
  const capPath = join(readModelSiteRoot, 'operator-surfaces', 'capability-announcements.json');
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
    const severity = Number.isFinite(cap.severity) ? cap.severity : daysUntilDue === null ? 0 : daysUntilDue < 0 ? 85 : daysUntilDue <= 14 ? 60 : daysUntilDue <= 30 ? 40 : 0;
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
    const spec = row.task_number ? readModelStore.getTaskSpecByNumber(row.task_number) : null;
    const projectedTaskBody = readProjectedTaskBody(row.task_id);
    const text = normalizeLinkText([spec?.title, spec?.goal_markdown, spec?.context_markdown, spec?.required_work_markdown, spec?.non_goals_markdown, projectedTaskBody, row.task_id].filter(Boolean).join(' '));
    const reasons = [];
    if (item.capa_id && text.includes(normalizeLinkText(item.capa_id))) reasons.push('capa_id_link');
    if (normalizedConcept.length >= 16 && text.includes(normalizedConcept)) reasons.push('concept_name_link');
    if (reasons.length === 0) continue;
    matches.push({ task_number: row.task_number, task_id: row.task_id, status: row.status, title: spec?.title ?? row.title ?? '', reasons, closed_corrective_implementation: isClosedCorrectiveImplementationTask({ row, spec, item, projectedTaskBody }) });
  }
  const openStatuses = new Set(['opened', 'claimed', 'needs_continuation', 'in_review']);
  const openMatches = matches.filter((match) => openStatuses.has(match.status));
  if (openMatches.length > 0) {
    return { status: 'covered_by_open_task', reason: 'open linked task can carry the CAPA corrective implementation to terminal evidence', open_task_count: openMatches.length, historical_task_count: matches.length - openMatches.length, tasks: openMatches.slice(0, 5), actionable_next_states: correctiveCoverageNextStates(), remediation: 'Continue or finish the linked implementation task, then verify it contains completed acceptance criteria, execution notes, and verification evidence.' };
  }
  const terminalMatches = matches.filter((match) => match.closed_corrective_implementation === true);
  if (terminalMatches.length > 0) {
    return { status: 'closed_corrective_implementation_coverage', reason: 'closed linked task has completed acceptance criteria, execution notes, and verification and is not disposition/audit-only', open_task_count: 0, historical_task_count: matches.length, terminal_task_count: terminalMatches.length, tasks: terminalMatches.slice(0, 5), actionable_next_states: [], remediation: null };
  }
  if (matches.length > 0) {
    return { status: 'historical_only_no_open_corrective_task', reason: 'linked tasks exist, but they are historical disposition, intake, triage, audit, cluster, inventory, or review work rather than corrective implementation coverage', open_task_count: 0, historical_task_count: matches.length, tasks: matches.slice(0, 5), actionable_next_states: correctiveCoverageNextStates(), remediation: 'Create or link an implementation task, record an explicit defer/blocker state, or admit a no-action rationale; closed disposition or audit history alone is not terminal corrective coverage.' };
  }
  if (item.corrective_action_present || item.severity >= 75) {
    return { status: 'missing_corrective_task_coverage', reason: 'high-severity or corrective-action CAPA has no linked corrective implementation task coverage', open_task_count: 0, historical_task_count: 0, tasks: [], actionable_next_states: correctiveCoverageNextStates(), remediation: 'Create or link an implementation task, record an explicit defer/blocker state, or admit a no-action rationale before reporting CAPA terminality.' };
  }
  return { status: 'coverage_not_required_by_read_model', reason: 'no corrective action or high-severity pressure detected', open_task_count: 0, historical_task_count: 0, tasks: [], actionable_next_states: [], remediation: null };
}

function correctiveCoverageNextStates() { return ['linked_corrective_implementation_task', 'explicit_defer_or_blocker_state', 'admitted_no_action_rationale']; }

function isClosedCorrectiveImplementationTask({ row, spec, item, projectedTaskBody = null }) {
  if (!['closed', 'confirmed'].includes(row.status)) return false;
  const title = String(spec?.title ?? row.title ?? '');
  const taskText = [title, spec?.goal_markdown, spec?.context_markdown, spec?.required_work_markdown, spec?.non_goals_markdown, projectedTaskBody ?? readProjectedTaskBody(row.task_id)].filter(Boolean).join('\n');
  const normalized = normalizeLinkText(taskText);
  if (/\b(disposition|intake|triage|audit|cluster|inventory|review)\b/i.test(title)) return false;
  if (!/(implement|implemented|fix|fixed|guard|guarded|prevent|prevented|refuse|refused|enforce|enforced|validate|validated|test|coverage)/i.test(taskText)) return false;
  if (item.capa_id && !normalized.includes(normalizeLinkText(item.capa_id))) return false;
  const evidence = classifyProjectedTaskEvidence(taskText);
  return evidence.acceptance_complete && evidence.execution_notes_present && evidence.verification_present;
}

function readProjectedTaskBody(taskId) {
  if (!taskId) return '';
  const path = join(readModelSiteRoot, '.ai', 'do-not-open', 'tasks', `${taskId}.md`);
  if (!existsSync(path)) return '';
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function classifyProjectedTaskEvidence(body) {
  const acceptanceMatches = [...String(body).matchAll(/^\s*-\s+\[(x|X| )\]\s+\S.*$/gm)];
  const checkedCount = acceptanceMatches.filter((match) => match[1].toLowerCase() === 'x').length;
  return { acceptance_complete: acceptanceMatches.length > 0 && checkedCount === acceptanceMatches.length, execution_notes_present: sectionHasSubstantiveContent(body, 'Execution Notes'), verification_present: sectionHasSubstantiveContent(body, 'Verification') };
}

function sectionHasSubstantiveContent(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body).match(new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i'));
  if (!match) return false;
  const normalized = match[1].replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*[-*]\s*/gm, '').trim();
  return normalized.length >= 20;
}

function normalizeLinkText(value) { return String(value ?? '').toLowerCase().replace(/[^a-z0-9_\-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function finiteNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function stringOrNull(value) { return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null; }
function compactNextActionTask(task) { if (!task) return null; return { task_number: task.task_number ?? null, title: task.title ?? null, status: task.status ?? null, target_role: task.target_role ?? null, assigned_agent: task.assigned_agent ?? null, claim_authority: task.claim_authority ?? null }; }
