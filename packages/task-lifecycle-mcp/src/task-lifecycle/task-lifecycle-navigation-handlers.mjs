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
      const obligatedTaskIds = new Set(board.my_review_obligations.map((obligation) => obligation.task_id));
      const pendingReviews = board.pending_reviews.filter((task) => obligatedTaskIds.has(task.task_id));
      const responseCounts = {
        ...board.counts,
        all_in_review: board.counts.pending_reviews,
        corrective_debt_active: correctiveDebtReadiness.counts.active_total,
        corrective_debt_high_severity: correctiveDebtReadiness.counts.high_severity,
        corrective_debt_missing_coverage: correctiveDebtReadiness.counts.missing_corrective_task_coverage,
      };
      const identityBanner = `>>> YOU ARE QUERYING AS: ${agentId}${agentRole ? ` (${agentRole})` : ''} <<<`;
      const identityWarning = verifySessionIdentity(agentId);
      const responseGeneratedAt = new Date().toISOString();
      const responsePayload = {
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
        pending_reviews: pendingReviews.slice(0, limit),
        all_in_review: board.pending_reviews.slice(0, limit),
        local_followups: board.local_followups.slice(0, limit),
        role_wide_followups: (board.role_wide_followups || []).slice(0, limit),
        non_actionable_parent_followups: (board.non_actionable_parent_followups || []).slice(0, limit),
        closure_authority_conflicts: (board.closure_authority_conflicts || []).slice(0, limit),
        downstream_role_followups: (board.downstream_role_followups || []).slice(0, limit),
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
      const obligatedTaskIds = new Set(board.my_review_obligations.map((obligation) => obligation.task_id));
      const pendingReviews = board.pending_reviews.filter((task) => obligatedTaskIds.has(task.task_id));
      const responseCounts = { ...board.counts, all_in_review: board.counts.pending_reviews };
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
      if (!agentId) throw new Error('agent_id_required');
      const roleResolution = resolveAgentRoleWithDiagnostics(store, siteRoot, agentId);
      const agentRole = roleResolution.role;
      const obligations = store.listDirectedObligationsForTarget(agentId, agentRole, status)
        .map((obligation) => {
          const spec = obligation.task_number ? store.getTaskSpecByNumber(obligation.task_number) : null;
          return {
            obligation_id: obligation.obligation_id,
            kind: obligation.kind,
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
      return jsonToolResult({
        status: 'ok',
        agent_id: agentId,
        agent_role: agentRole,
        role_binding: roleResolution.role_binding,
        role_resolution: roleResolution,
        status_filter: status,
        count: obligations.length,
        obligations,
        schema: 'narada.task.mcp.obligations.v0',
      });
    },
  };
}
