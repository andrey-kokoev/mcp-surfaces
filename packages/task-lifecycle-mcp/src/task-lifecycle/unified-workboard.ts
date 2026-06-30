/**
 * Unified workboard — compose task workboard, inbox backlog, and obligations
 * into a single prioritized work surface.
 */

import { buildWorkboard } from './workboard.js';
import { buildInboxWorkboard } from './inbox-workboard.js';

export function buildNextWorkContract(board, recommendation = null) {
  const executableCounts = {
    in_progress: board.in_progress?.length ?? 0,
    needs_continuation: board.needs_continuation?.length ?? 0,
    dependency_obligations: board.dependency_obligations?.length ?? 0,
    review_obligations_compat: board.my_review_obligations?.length ?? 0,
    local_followups: board.local_followups?.length ?? 0,
    role_wide_followups: board.role_wide_followups?.length ?? 0,
    actionable_deferred: board.actionable_deferred?.length ?? 0,
    high_severity_inbox: (board.inbox_backlog || []).filter((item) => item.severity >= 70).length,
  };
  const executableTotal = Object.values(executableCounts).reduce((sum, count) => sum + count, 0);
  const roleWidePresent = executableCounts.role_wide_followups > 0;

  return {
    schema: 'narada.task.next_work_contract.v0',
    observation_surface: 'task_lifecycle_next and workboard_snapshot are read-model evidence unless a separate claim/un_defer/review surface is called.',
    executable_work_rule: 'Role-wide claimable tasks and actionable deferred tasks count as executable next work.',
    no_work_rule: 'Do not report no executable work unless local/preferred, role-wide, dependency, inbox, actionable deferred, continuation, and blocker buckets are empty or explicitly blocked.',
    recommendation_rule: 'If recommendation.action is claim, claim_with_authority, continue, review, bridge_poll, or un_defer, the agent must take that action or record a concrete blocker.',
    executable_counts: executableCounts,
    executable_work_available: Boolean(recommendation) || executableTotal > 0,
    no_work_assertion_allowed: !recommendation && executableTotal === 0,
    no_work_assertion_guardrail: roleWidePresent
      ? 'Role-wide claimable tasks are present. It is invalid to summarize this workboard as no executable work.'
      : null,
    recommended_claim_command: recommendation?.task?.task_number
      ? `task-claim ${recommendation.task.task_number}`
      : null,
  };
}

function findTaskBoardItemByTaskId(taskBoard, taskId) {
  if (!taskId) return null;
  const buckets = [
    taskBoard.in_progress,
    taskBoard.needs_continuation,
    taskBoard.local_followups,
    taskBoard.role_wide_followups,
    taskBoard.actionable_deferred,
  ];
  for (const bucket of buckets) {
    const match = (bucket || []).find((item) => item.task_id === taskId);
    if (match) return match;
  }
  return null;
}

function isDependencyDirectedObligation(obligation) {
  return obligation?.kind === 'review_request' || obligation?.kind === 'dependency_request';
}

function normalizeDependencyObligation(obligation) {
  if (!isDependencyDirectedObligation(obligation)) return null;
  return {
    ...obligation,
    kind: 'dependency_request',
    legacy_kind: obligation.kind,
    dependency_kind: obligation.dependency_kind ?? 'review',
  };
}

function dependencyRecommendationFields(item) {
  if (!item?.dependency_id) return {};
  return {
    dependency_id: item.dependency_id,
    dependency_kind: item.dependency_kind,
    gates_task_number: item.gates_task_number,
    gates_task_id: item.gates_task_id,
    outcome_type: item.outcome_type,
    allowed_outcomes: item.allowed_outcomes || [],
    satisfying_outcomes: item.satisfying_outcomes || [],
    blocking_outcomes: item.blocking_outcomes || [],
    conflict_of_interest_risk: item.conflict_of_interest_risk ?? null,
    next_tool: item.next_tool,
    example_args: item.example_args,
  };
}

export function deriveNextRecommendation(board, agentId) {
  const myInProgress = board.in_progress.filter((t) => t.assigned_agent === agentId);
  const myNeedsContinuation = board.needs_continuation.filter((t) => t.assigned_agent === agentId);
  const highSeverityInbox = board.inbox_backlog.filter((b) => b.severity >= 70);

  if (highSeverityInbox.length > 0) {
    return {
      action: 'bridge_poll',
      reason: `There are ${highSeverityInbox.length} high-severity inbox envelope(s) ready to materialize into tasks.`,
      inbox_item: highSeverityInbox[0],
    };
  }
  if (myNeedsContinuation.length > 0) {
    return {
      action: 'continue',
      reason: 'You have a task that needs continuation. Resume work on it.',
      task: myNeedsContinuation[0],
    };
  }
  if (myInProgress.length > 0) {
    return {
      action: 'continue',
      reason: 'You have an active claimed task. Continue working on it.',
      task: myInProgress[0],
    };
  }
  if ((board.dependency_obligations || []).length > 0) {
    return {
      action: 'dependency_work',
      reason: 'You have pending dependency-directed work.',
      obligation: board.dependency_obligations[0],
    };
  }
  if (board.local_followups.length > 0) {
    const claimable = board.local_followups.filter((t) => !t.assigned_agent);
    if (claimable.length > 0) {
      return {
        action: 'claim',
        reason: 'No active work and no dependency-directed work. Claim the next available task.',
        task: claimable[0],
      };
    }
  }
  if ((board.role_wide_followups || []).length > 0) {
    const claimable = board.role_wide_followups.filter((t) => !t.assigned_agent);
    if (claimable.length > 0) {
      const task = claimable[0];
      return {
        action: task.claim_authority === 'preferred_agent_override_required' ? 'claim_with_authority' : 'claim',
        reason: task.claim_authority === 'preferred_agent_override_required'
          ? 'No local preferred work is available. Role-wide work exists, but this task prefers another agent and requires explicit override authority to claim.'
          : 'No local preferred work is available. Claim the next role-wide task for your role.',
        task,
      };
    }
  }
  if (board.actionable_deferred.length > 0) {
    return {
      action: 'un_defer',
      reason: 'Actionable deferred tasks are available. Consider un-deferring one to resume work.',
      task: board.actionable_deferred[0],
    };
  }
  return null;
}

export function buildUnifiedWorkboard({ store, siteRoot, agentId, agentRole, allTasks, limit = 8 }) {
  // Build task workboard
  const taskBoard = buildWorkboard({ store, siteRoot, agentId, agentRole, allTasks });

  // Build inbox workboard
  const inboxBoard = buildInboxWorkboard(siteRoot, { store });

  // Build obligations
  let obligations = [];
  if (agentId) {
    const rawObligations = store.listDirectedObligationsForTarget(agentId, agentRole, 'open');
    obligations = rawObligations.map((o) => ({
      obligation_id: o.obligation_id,
      kind: o.kind,
      task_number: o.task_number,
      task_id: o.task_id,
      title: o.task_number ? (store.getTaskSpecByNumber(o.task_number)?.title || '(untitled)') : '(untitled)',
      routed_by: o.source_agent_id || null,
      created_at: o.created_at,
      status: o.status,
    }));
  }

  // Generate next recommendation with priority:
  // 1. High-severity inbox items (severity >= 70)
  // 2. Directed dependency obligations
  // 3. Dependency-waiting parent context
  // 5. Needs continuation
  // 5. In-progress work
  // 7. Local followups (opened tasks)
  // 7. Lower-severity inbox items
  const recommendations = [];

  // 1. High-severity inbox
  for (const item of inboxBoard.backlog.filter((e) => e.severity >= 70)) {
    recommendations.push({
      type: 'inbox_high_severity',
      priority: 1,
      envelope_id: item.envelope_id,
      title: item.title,
      severity: item.severity,
      kind: item.kind,
      target_role: item.target_role,
      action: item.action,
    });
  }

  const dependencyObligations = obligations.map(normalizeDependencyObligation).filter(Boolean);

  // 2. Directed dependency obligations
  for (const item of dependencyObligations) {
    const dependencyTask = findTaskBoardItemByTaskId(taskBoard, item.task_id);
    recommendations.push({
      type: 'dependency_obligation',
      priority: 2,
      dependency_kind: item.dependency_kind,
      obligation_id: item.obligation_id,
      obligation_kind: item.kind,
      legacy_kind: item.legacy_kind,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      routed_by: item.routed_by,
      ...dependencyRecommendationFields(dependencyTask),
    });
  }

  // 3. Dependency-waiting parents are context, not directly claimable work.
  for (const item of taskBoard.dependency_waiting_parents || []) {
    recommendations.push({
      type: 'dependency_waiting_parent',
      priority: 3,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      blocked_by: 'dependencies',
      agent_actionable: false,
      reason: item.reason,
    });
  }

  // 4. Legacy pending review projections
  for (const item of taskBoard.legacy_review_tasks ?? []) {
    recommendations.push({
      type: 'legacy_pending_review',
      priority: 10,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      assigned_agent: item.assigned_agent,
      single_operator_review_risk: item.single_operator_review_risk ?? false,
      single_operator_review_kind: item.single_operator_review_kind ?? null,
    });
  }

  // 4. Needs continuation
  for (const item of taskBoard.needs_continuation) {
    recommendations.push({
      type: 'needs_continuation',
      priority: 4,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      assigned_agent: item.assigned_agent,
      ...dependencyRecommendationFields(item),
    });
  }

  // 6. In progress
  for (const item of taskBoard.in_progress) {
    recommendations.push({
      type: 'in_progress',
      priority: 5,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      assigned_agent: item.assigned_agent,
      ...dependencyRecommendationFields(item),
    });
  }

  // 6. Local followups (opened tasks)
  for (const item of taskBoard.local_followups) {
    recommendations.push({
      type: 'local_followup',
      priority: 6,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      target_role: item.target_role,
      preferred_agent_id: item.preferred_agent_id,
      claim_authority: item.claim_authority,
      preferred_agent_relation: item.preferred_agent_relation,
      pre_claim_warnings: item.pre_claim_warnings || [],
      ...dependencyRecommendationFields(item),
    });
  }

  // 8. Role-wide followups (opened tasks for this role but not preferred-local)
  for (const item of taskBoard.role_wide_followups || []) {
    recommendations.push({
      type: 'role_wide_followup',
      priority: 7,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      target_role: item.target_role,
      preferred_agent_id: item.preferred_agent_id,
      claim_authority: item.claim_authority,
      preferred_agent_relation: item.preferred_agent_relation,
      pre_claim_warnings: item.pre_claim_warnings || [],
      ...dependencyRecommendationFields(item),
    });
  }

  for (const item of taskBoard.non_actionable_parent_followups || []) {
    recommendations.push({
      type: 'non_actionable_parent_followup',
      priority: 8,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      target_role: item.target_role,
      preferred_agent_id: item.preferred_agent_id,
      claim_authority: item.claim_authority,
      preferred_agent_relation: item.preferred_agent_relation,
      reason: item.reason,
      child_task_numbers: item.child_task_numbers,
      active_child_task_numbers: item.active_child_task_numbers,
      agent_actionable: false,
    });
  }

  for (const item of taskBoard.closure_authority_conflicts || []) {
    recommendations.push({
      type: 'closure_authority_conflict',
      priority: 8,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      target_role: item.target_role,
      preferred_agent_id: item.preferred_agent_id,
      claim_authority: item.claim_authority,
      preferred_agent_relation: item.preferred_agent_relation,
      closure_authority: item.closure_authority,
      reason: item.reason,
      agent_actionable: false,
    });
  }

  // 9. Lower-severity inbox
  for (const item of inboxBoard.backlog.filter((e) => e.severity < 70)) {
    recommendations.push({
      type: 'inbox_backlog',
      priority: 8,
      envelope_id: item.envelope_id,
      title: item.title,
      severity: item.severity,
      kind: item.kind,
      target_role: item.target_role,
    });
  }

  // 10. Actionable deferred tasks. Blocked deferred tasks stay visible in
  // taskBoard.deferred but do not consume the executable recommendation channel.
  for (const item of taskBoard.actionable_deferred) {
    recommendations.push({
      type: 'actionable_deferred',
      priority: 9,
      task_number: item.task_number,
      task_id: item.task_id,
      title: item.title,
      assigned_agent: item.assigned_agent,
      target_role: item.target_role,
      preferred_agent_id: item.preferred_agent_id,
      ...dependencyRecommendationFields(item),
    });
  }

  // Detect recently materialized tasks (created within last hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentlyMaterialized = [
    ...taskBoard.local_followups,
    ...(taskBoard.role_wide_followups || []),
  ].filter((t) => t.updated_at && t.updated_at > oneHourAgo);

  const dependencyTasks = recommendations.filter((item) => item.dependency_id);
  return {
    dependency_waiting_parents: (taskBoard.dependency_waiting_parents || []).slice(0, limit),
    dependency_tasks: dependencyTasks.slice(0, limit),
    legacy_pending_reviews: (taskBoard.legacy_review_tasks ?? []).slice(0, limit),
    pending_reviews_compat: (taskBoard.legacy_review_tasks ?? []).slice(0, limit),
    in_progress: taskBoard.in_progress.slice(0, limit),
    needs_continuation: taskBoard.needs_continuation.slice(0, limit),
    local_followups: taskBoard.local_followups.slice(0, limit),
    role_wide_followups: (taskBoard.role_wide_followups || []).slice(0, limit),
    non_actionable_parent_followups: (taskBoard.non_actionable_parent_followups || []).slice(0, limit),
    closure_authority_conflicts: (taskBoard.closure_authority_conflicts || []).slice(0, limit),
    downstream_role_followups: (taskBoard.downstream_role_followups || []).slice(0, limit),
    deferred: taskBoard.deferred.slice(0, limit),
    actionable_deferred: taskBoard.actionable_deferred.slice(0, limit),
    dependency_obligations: dependencyObligations.slice(0, limit),
    dependency_obligations_compat_review: obligations.filter((o) => o.kind === 'review_request').slice(0, limit),
    my_review_obligations: obligations.filter((o) => o.kind === 'review_request').slice(0, limit),
    inbox_backlog: inboxBoard.backlog.slice(0, limit),
    inbox_linked_task_suppressed: inboxBoard.linked_task_suppressed.slice(0, limit),
    inbox_counts: inboxBoard.counts,
    inbox_index: inboxBoard.index,
    recommendations: recommendations.slice(0, limit),
    new_tasks_available: recentlyMaterialized.length > 0,
    recently_materialized: recentlyMaterialized.slice(0, limit),
    counts: {
      dependency_waiting_parents: (taskBoard.dependency_waiting_parents || []).length,
      dependency_tasks: dependencyTasks.length,
      legacy_pending_reviews: (taskBoard.legacy_review_tasks ?? []).length,
      pending_reviews_compat: (taskBoard.legacy_review_tasks ?? []).length,
      in_progress: taskBoard.in_progress.length,
      needs_continuation: taskBoard.needs_continuation.length,
      local_followups: taskBoard.local_followups.length,
      role_wide_followups: (taskBoard.role_wide_followups || []).length,
      non_actionable_parent_followups: (taskBoard.non_actionable_parent_followups || []).length,
      closure_authority_conflicts: (taskBoard.closure_authority_conflicts || []).length,
      downstream_role_followups: (taskBoard.downstream_role_followups || []).length,
      deferred: taskBoard.deferred.length,
      actionable_deferred: taskBoard.actionable_deferred.length,
      dependency_obligations: dependencyObligations.length,
      dependency_obligations_compat_review: obligations.filter((o) => o.kind === 'review_request').length,
      my_review_obligations: obligations.filter((o) => o.kind === 'review_request').length,
      inbox_total: inboxBoard.counts.total,
      inbox_high_severity: inboxBoard.counts.high_severity,
      inbox_linked_task_suppressed: inboxBoard.counts.linked_task_suppressed,
      recently_materialized: recentlyMaterialized.length,
    },
    schema: 'narada.unified_workboard.v3',
    generated_at: new Date().toISOString(),
  };
}
