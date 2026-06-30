export const TASK_LIFECYCLE_NAVIGATION_TOOL_NAMES = Object.freeze([
  'task_lifecycle_next',
  'task_lifecycle_workboard_snapshot',
  'task_lifecycle_obligations',
]);

export function createTaskLifecycleNavigationHandlers({
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
  buildTaskLifecycleFreshness,
  buildMcpRestartPressure,
  buildStaleLiveNavigationDegradation,
  deriveMcpRestartPressureRecommendation,
  buildNextWorkContract,
  computeStateFreshness,
  buildConciseNextActionView,
  buildWorkboardSnapshotPacket,
  verifySessionIdentity,
}) {
  return {
    task_lifecycle_next: (args) => {
      const agentId = stringField(args, 'agent_id');
      const limit = numberField(args, 'limit') ?? 8;
      const lastWorkboardCheckAt = stringField(args, 'last_workboard_check_at');
      const view = stringField(args, 'view');
      const conciseOnly = view === 'concise' || booleanField(args, 'concise') === true;
      if (!agentId) throw new Error('agent_id_required');

      const roleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
      const agentRole = roleResolution.role;
      const all = store.getAllLifecycle();
      const board = buildUnifiedWorkboard({ store, siteRoot, agentId, agentRole, allTasks: all, limit });
      const correctiveDebtReadiness = buildCorrectiveDebtReadiness({ allTasks: all });
      const recommendation = deriveNextRecommendation(board, agentId);
      const mcpFreshness = buildTaskLifecycleFreshness({ registeredTools: null });
      const mcpRestartPressure = buildMcpRestartPressure([mcpFreshness]);
      const staleLiveNavigation = buildStaleLiveNavigationDegradation(mcpRestartPressure);
      const restartRecommendation = deriveMcpRestartPressureRecommendation(mcpRestartPressure);
      const environmentPressure = restartRecommendation ? {
        status: 'active',
        executable_by_agent: false,
        pressure: restartRecommendation,
      } : { status: 'clear', executable_by_agent: false, pressure: null };
      const finalRecommendation = recommendation ?? null;
      const nextWorkContract = buildNextWorkContract(board, finalRecommendation);
      const myInProgress = board.in_progress.filter((task) => task.assigned_agent === agentId);
      const myNeedsContinuation = board.needs_continuation.filter((task) => task.assigned_agent === agentId);
      const obligatedTaskIds = new Set((board.dependency_obligations || []).map((obligation) => obligation.task_id));
      const dependencyObligationTasks = board.legacy_pending_reviews.filter((task) => obligatedTaskIds.has(task.task_id));
      const responseCounts = {
        ...board.counts,
        dependency_waiting_parents: board.counts.dependency_waiting_parents,
        dependency_obligations: board.counts.dependency_obligations,
        dependency_tasks: board.counts.dependency_tasks ?? board.counts.legacy_pending_reviews,
        legacy_all_in_review: board.counts.legacy_pending_reviews,
        all_in_review_compat: board.counts.legacy_pending_reviews,
        corrective_debt_active: correctiveDebtReadiness.counts.active_total,
        corrective_debt_high_severity: correctiveDebtReadiness.counts.high_severity,
        corrective_debt_missing_coverage: correctiveDebtReadiness.counts.missing_corrective_task_coverage,
      };
      const identityBanner = `>>> YOU ARE QUERYING AS: ${agentId}${agentRole ? ` (${agentRole})` : ''} <<<`;
      const identityWarning = verifySessionIdentity(agentId);
      const responseGeneratedAt = new Date().toISOString();
      const responsePayload: Record<string, unknown> = {
        status: 'ok',
        agent_id: agentId,
        agent_role: agentRole,
        role_binding: roleResolution.role_binding,
        role_resolution: roleResolution,
        identity_banner: identityBanner,
        identity_warning: identityWarning,
        stale_live_navigation: staleLiveNavigation,
        navigation_critical_field_quality: staleLiveNavigation.field_quality,
        stale_live_warning: staleLiveNavigation.warning,
        recommendation: finalRecommendation,
        next_work_contract: nextWorkContract,
        no_work_assertion_guardrail: nextWorkContract.no_work_assertion_guardrail,
        executable_work_available: nextWorkContract.executable_work_available,
        agent_actionable_recommendation: Boolean(recommendation),
        environment_pressure: environmentPressure,
        blocked_external: !recommendation && restartRecommendation ? environmentPressure : null,
        recommendation_quality: staleLiveNavigation.field_quality.recommendation,
        in_progress: myInProgress.slice(0, limit),
        needs_continuation: myNeedsContinuation.slice(0, limit),
        dependency_obligation_tasks: dependencyObligationTasks.slice(0, limit),
        dependency_tasks: board.dependency_tasks?.slice(0, limit) ?? board.legacy_pending_reviews.slice(0, limit),
        dependency_waiting_parents: (board.dependency_waiting_parents || []).slice(0, limit),
        dependency_obligations: (board.dependency_obligations || []).slice(0, limit),
        legacy_pending_reviews: board.legacy_pending_reviews.slice(0, limit),
        pending_reviews_compat: dependencyObligationTasks.slice(0, limit),
        all_in_review_compat: board.legacy_pending_reviews.slice(0, limit),
        local_followups: board.local_followups.slice(0, limit),
        role_wide_followups: (board.role_wide_followups || []).slice(0, limit),
        non_actionable_parent_followups: (board.non_actionable_parent_followups || []).slice(0, limit),
        closure_authority_conflicts: (board.closure_authority_conflicts || []).slice(0, limit),
        downstream_role_followups: (board.downstream_role_followups || []).slice(0, limit),
        dependency_obligations_compat_review: board.dependency_obligations_compat_review?.slice(0, limit) ?? board.my_review_obligations.slice(0, limit),
        my_review_obligations: board.my_review_obligations.slice(0, limit),
        deferred: board.deferred.slice(0, limit),
        actionable_deferred: board.actionable_deferred.slice(0, limit),
        inbox_backlog: board.inbox_backlog.slice(0, limit),
        inbox_linked_task_suppressed: (board.inbox_linked_task_suppressed || []).slice(0, limit),
        inbox_index: board.inbox_index ?? null,
        corrective_debt_readiness: correctiveDebtReadiness,
        recommendations: [
          ...(restartRecommendation ? [{
            type: 'mcp_restart_pressure',
            priority: staleLiveNavigation.status === 'degraded' ? 0 : 9,
            action: restartRecommendation.action,
            title: restartRecommendation.reason,
            authority_boundary: restartRecommendation.authority_boundary,
            agent_actionable: restartRecommendation.authority_boundary?.agent_can_execute_restart === true,
          }] : []),
          ...board.recommendations,
        ].slice(0, limit),
        new_tasks_available: board.new_tasks_available ?? false,
        recently_materialized: (board.recently_materialized || []).slice(0, limit),
        counts: responseCounts,
        schema: 'narada.task.mcp.next.v3',
        generated_at: responseGeneratedAt,
        workboard_generated_at: board.generated_at ?? null,
        state_freshness: computeStateFreshness(lastWorkboardCheckAt, responseGeneratedAt),
        mcp_freshness: mcpFreshness,
        mcp_restart_pressure: mcpRestartPressure,
      };
      responsePayload.concise_next_action = buildConciseNextActionView(responsePayload);
      return jsonToolResult(conciseOnly ? responsePayload.concise_next_action : responsePayload);
    },

    task_lifecycle_workboard_snapshot: (args) => {
      const agentId = stringField(args, 'agent_id');
      const limit = numberField(args, 'limit') ?? 8;
      const lastWorkboardCheckAt = stringField(args, 'last_workboard_check_at');
      const previousSnapshot = objectField(args, 'previous_snapshot');
      if (!agentId) throw new Error('agent_id_required');

      const roleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
      const agentRole = roleResolution.role;
      const all = store.getAllLifecycle();
      const board = buildUnifiedWorkboard({ store, siteRoot, agentId, agentRole, allTasks: all, limit });
      const generatedAt = new Date().toISOString();
      const recommendation = deriveNextRecommendation(board, agentId);
      const myInProgress = board.in_progress.filter((task) => task.assigned_agent === agentId);
      const myNeedsContinuation = board.needs_continuation.filter((task) => task.assigned_agent === agentId);
      const obligatedTaskIds = new Set((board.dependency_obligations || []).map((obligation) => obligation.task_id));
      const pendingReviews = board.legacy_pending_reviews.filter((task) => obligatedTaskIds.has(task.task_id));
      const responseCounts = {
        ...board.counts,
        dependency_waiting_parents: board.counts.dependency_waiting_parents,
        dependency_obligations: board.counts.dependency_obligations,
        dependency_tasks: board.counts.dependency_tasks ?? board.dependency_tasks?.length ?? 0,
        legacy_all_in_review: board.counts.legacy_pending_reviews,
        all_in_review_compat: board.counts.legacy_pending_reviews,
      };
      const snapshot = buildWorkboardSnapshotPacket({
        agentId,
        agentRole,
        roleBinding: roleResolution.role_binding,
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
      });
      return jsonToolResult(snapshot);
    },

    task_lifecycle_obligations: (args) => {
      const agentId = stringField(args, 'agent_id');
      const status = stringField(args, 'status') || 'open';
      const limit = numberField(args, 'limit') ?? 50;
      if (!agentId) throw new Error('agent_id_required');
      const roleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
      const agentRole = roleResolution.role;
      const all = store.getAllLifecycle();
      const board = buildUnifiedWorkboard({ store, siteRoot, agentId, agentRole, allTasks: all, limit });
      const obligations = store.listDirectedObligationsForTarget(agentId, agentRole, status)
        .map((obligation) => {
          const spec = obligation.task_number ? store.getTaskSpecByNumber(obligation.task_number) : null;
          const dependencyObligation = normalizeDependencyObligation(obligation);
          return {
            obligation_id: obligation.obligation_id,
            kind: dependencyObligation?.kind ?? obligation.kind,
            legacy_kind: dependencyObligation?.legacy_kind ?? null,
            dependency_kind: dependencyObligation?.dependency_kind ?? null,
            status: obligation.status,
            task_number: obligation.task_number,
            task_id: obligation.task_id,
            title: spec?.title || '(untitled)',
            target_agent_id: obligation.target_agent_id,
            target_role: obligation.target_role,
            source_agent_id: obligation.source_agent_id,
            created_at: obligation.created_at,
            updated_at: obligation.updated_at,
          };
        });
      const dependencyWork = [
        ...board.in_progress,
        ...board.needs_continuation,
        ...board.local_followups,
        ...(board.role_wide_followups || []),
        ...(board.actionable_deferred || []),
      ]
        .filter((item) => item?.dependency_id)
        .map((item) => ({
          type: 'dependency_work',
          task_number: item.task_number,
          task_id: item.task_id,
          title: item.title,
          status: item.status,
          assigned_agent: item.assigned_agent,
          target_role: item.target_role,
          preferred_agent_id: item.preferred_agent_id,
          dependency_id: item.dependency_id,
          dependency_kind: item.dependency_kind,
          gates_task_id: item.gates_task_id,
          gates_task_number: item.gates_task_number,
          outcome_type: item.outcome_type,
          allowed_outcomes: item.allowed_outcomes || [],
          satisfying_outcomes: item.satisfying_outcomes || [],
          blocking_outcomes: item.blocking_outcomes || [],
          conflict_of_interest_risk: item.conflict_of_interest_risk ?? null,
          next_tool: item.next_tool,
          example_args: item.example_args,
        }))
        .slice(0, limit);
      return jsonToolResult({
        status: 'ok',
        agent_id: agentId,
        agent_role: agentRole,
        role_binding: roleResolution.role_binding,
        role_resolution: roleResolution,
        status_filter: status,
        count: obligations.length,
        obligations,
        dependency_work_count: dependencyWork.length,
        dependency_work: dependencyWork,
        schema: 'narada.task.mcp.obligations.v1',
      });
    },
  };
}

function normalizeDependencyObligation(obligation) {
  if (!obligation || (obligation.kind !== 'review_request' && obligation.kind !== 'dependency_request')) return null;
  const evidence = parseJsonObject(obligation.evidence_json);
  const evidenceDependencyKind = typeof evidence.dependency_kind === 'string' && evidence.dependency_kind.trim().length > 0
    ? evidence.dependency_kind.trim()
    : null;
  return {
    kind: 'dependency_request',
    legacy_kind: obligation.kind,
    dependency_kind: evidenceDependencyKind ?? (obligation.kind === 'review_request' ? 'review' : null),
  };
}

function parseJsonObject(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
