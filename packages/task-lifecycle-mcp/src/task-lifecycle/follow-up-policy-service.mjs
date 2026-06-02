const FOLLOW_UP_SCHEMA = 'narada.task.follow_up_policy.v0';
const POST_CLOSEOUT_CONTINUATION_SCHEMA = 'narada.task.post_closeout_continuation.v0';

export function evaluatePostTransitionFollowups(input = {}) {
  const event = input.event && typeof input.event === 'object' ? input.event : {};
  const sourceTask = input.source_task && typeof input.source_task === 'object' ? input.source_task : {};
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const signals = input.signals && typeof input.signals === 'object' ? input.signals : {};
  const actor = input.actor && typeof input.actor === 'object' ? input.actor : {};
  const transitionKind = stringValue(event.transition_kind ?? event.kind ?? result.transition ?? result.close_action ?? 'unknown');
  const sourceTaskNumber = numberValue(sourceTask.task_number ?? event.task_number ?? result.task_number);
  const sourceTaskId = stringValue(sourceTask.task_id ?? event.task_id ?? result.task_id);
  const targetPrincipal = stringValue(actor.agent_id ?? event.agent_id ?? result.agent_id);

  const candidates = [];
  if (isEvidenceBlocked(result, signals)) {
    candidates.push(taskCandidate({
      followUpKind: 'evidence_repair',
      title: `Repair evidence for task #${sourceTaskNumber ?? sourceTaskId ?? 'unknown'}`,
      summary: 'Lifecycle finish/close transition was blocked by evidence gates; route a repair task to the acting agent or source owner.',
      targetPrincipal,
      sourceTaskNumber,
      sourceTaskId,
      transitionKind,
      reason: 'finish_or_close_blocked_by_evidence',
    }));
  }

  if (signals.follow_up_ledger_required === true || hasFollowUpLedgerBlocker(result)) {
    candidates.push(taskCandidate({
      followUpKind: 'follow_up_ledger_materialization',
      title: `Materialize follow-up ledger for task #${sourceTaskNumber ?? sourceTaskId ?? 'unknown'}`,
      summary: 'A preserved follow-up lacks created/covered/deferred/no-follow-up disposition; route explicit residual materialization.',
      targetPrincipal,
      sourceTaskNumber,
      sourceTaskId,
      transitionKind,
      reason: 'follow_up_ledger_gate',
    }));
  }

  if (signals.review_rejected === true || result.review_action === 'rejected' || result.verdict === 'rejected') {
    candidates.push(taskCandidate({
      followUpKind: 'review_repair',
      title: `Address review repair for task #${sourceTaskNumber ?? sourceTaskId ?? 'unknown'}`,
      summary: 'Review rejected or materially blocked the task; route repair to the original implementer when known.',
      targetPrincipal,
      sourceTaskNumber,
      sourceTaskId,
      transitionKind,
      reason: 'review_rejection_or_material_notes',
    }));
  }

  if (signals.doctrine_friction === true || signals.missing_mcp_capability === true || signals.cross_locus_trace_required === true) {
    candidates.push(observationCandidate({
      followUpKind: 'doctrine_or_cross_locus_friction',
      title: `Capture doctrine friction after task #${sourceTaskNumber ?? sourceTaskId ?? 'unknown'}`,
      summary: 'Transition exposed locus, authority, missing MCP capability, or projection/authority friction; record through inbox/observation authority.',
      targetPrincipal: 'architect',
      sourceTaskNumber,
      sourceTaskId,
      transitionKind,
      reason: 'doctrine_or_cross_locus_signal',
    }));
  }

  if (signals.template_created_task === true && transitionKind === 'close') {
    candidates.push(observationCandidate({
      followUpKind: 'template_maturation_feedback',
      title: `Record template feedback from task #${sourceTaskNumber ?? sourceTaskId ?? 'unknown'}`,
      summary: 'A template-created task closed; route firsthand ergonomics feedback to the completing agent.',
      targetPrincipal,
      sourceTaskNumber,
      sourceTaskId,
      transitionKind,
      reason: 'template_created_task_closed',
    }));
  }

  return {
    schema: FOLLOW_UP_SCHEMA,
    read_only_workboard_rule: 'workboard_must_surface_existing_followups_only',
    mutation_owner: 'task_lifecycle_or_inbox_transition_services',
    status: candidates.length > 0 ? 'followups_recommended' : 'noop',
    transition_kind: transitionKind,
    source_task_number: sourceTaskNumber,
    source_task_id: sourceTaskId,
    count: candidates.length,
    candidates,
  };
}

export function classifyPostCloseoutContinuation(input = {}) {
  const workboard = input.workboard && typeof input.workboard === 'object' ? input.workboard : {};
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const pauseTrigger = input.pause_trigger && typeof input.pause_trigger === 'object' ? input.pause_trigger : null;
  const recommendation = workboard.recommendation ?? null;
  const environmentPressure = workboard.environment_pressure ?? null;
  const correctiveDebtReadiness = workboard.corrective_debt_readiness ?? null;
  const correctiveDebtPressure = classifyCorrectiveDebtPressure(correctiveDebtReadiness);
  const actionable = Boolean(workboard.agent_actionable_recommendation ?? workboard.executable_work_available ?? recommendation);
  const downstreamCount = Number(workboard.counts?.downstream_role_followups ?? 0);

  if (pauseTrigger) {
    return baseContinuation({
      status: 'pause_trigger',
      expected_agent_behavior: 'pause_and_report',
      reason: pauseTrigger.reason ?? pauseTrigger.kind ?? 'pause_trigger_present',
      workboard,
      result,
      pauseTrigger,
    });
  }

  if (actionable) {
    return baseContinuation({
      status: 'actionable_next_work',
      expected_agent_behavior: 'continue',
      reason: 'Fresh workboard reports actionable next work for this agent; closeout is not terminal.',
      workboard,
      result,
    });
  }

  if (environmentPressure?.status === 'active') {
    return baseContinuation({
      status: 'terminal_blocked_no_next_action',
      expected_agent_behavior: 'report_blocker',
      reason: environmentPressure.pressure?.reason ?? 'environment_pressure_active_without_agent_actionable_work',
      workboard,
      result,
    });
  }

  if (correctiveDebtPressure.status === 'active') {
    return baseContinuation({
      status: 'terminal_blocked_no_next_action',
      expected_agent_behavior: 'report_blocker',
      reason: correctiveDebtPressure.reason,
      workboard,
      result,
      correctiveDebtPressure,
    });
  }

  if (downstreamCount > 0) {
    return baseContinuation({
      status: 'terminal_blocked_no_next_action',
      expected_agent_behavior: 'report_downstream_role_work_without_claiming',
      reason: 'Fresh workboard reports only downstream-role work; preserve role authority and do not claim it.',
      workboard,
      result,
    });
  }

  return baseContinuation({
    status: 'terminal_complete',
    expected_agent_behavior: 'stop_after_reporting_terminal_state',
    reason: 'Fresh workboard reports no actionable next work, no external pressure, and no downstream role work.',
    workboard,
    result,
    correctiveDebtPressure,
  });
}

function baseContinuation({ status, expected_agent_behavior: expectedAgentBehavior, reason, workboard, result, pauseTrigger = null, correctiveDebtPressure = null }) {
  return {
    schema: POST_CLOSEOUT_CONTINUATION_SCHEMA,
    status,
    expected_agent_behavior: expectedAgentBehavior,
    reason,
    fresh_workboard_required_before_final_response: true,
    source_transition: result.close_action ?? result.transition ?? 'unknown',
    source_task_number: numberValue(result.task_number),
    source_task_id: stringValue(result.task_id),
    next_recommendation: workboard.recommendation ?? null,
    counts: workboard.counts ?? {},
    downstream_role_followups: arrayValue(workboard.downstream_role_followups).slice(0, 3),
    environment_pressure: workboard.environment_pressure ?? null,
    corrective_debt_readiness: workboard.corrective_debt_readiness ?? null,
    corrective_debt_pressure: correctiveDebtPressure,
    pause_trigger: pauseTrigger,
  };
}

function classifyCorrectiveDebtPressure(correctiveDebtReadiness) {
  if (!correctiveDebtReadiness || typeof correctiveDebtReadiness !== 'object') {
    return { status: 'unknown', reason: 'corrective_debt_readiness_unavailable' };
  }
  const counts = correctiveDebtReadiness.counts ?? {};
  const highSeverity = Number(counts.high_severity ?? 0);
  const missingCoverage = Number(counts.missing_corrective_task_coverage ?? 0);
  const state = correctiveDebtReadiness.state ?? 'unknown';
  if (highSeverity > 0 || missingCoverage > 0) {
    return {
      status: 'active',
      reason: `unresolved_corrective_debt_blocks_terminal_complete: state=${state}, high_severity=${highSeverity}, missing_corrective_task_coverage=${missingCoverage}`,
      state,
      high_severity: highSeverity,
      missing_corrective_task_coverage: missingCoverage,
    };
  }
  return { status: 'clear', reason: 'no_high_severity_corrective_debt_detected', state };
}

function taskCandidate(args) {
  return candidate({ ...args, action: 'generated_task', route: 'task_materialization' });
}

function observationCandidate(args) {
  return candidate({ ...args, action: 'observation', route: 'inbox_or_observation' });
}

function candidate({ action, route, followUpKind, title, summary, targetPrincipal, sourceTaskNumber, sourceTaskId, transitionKind, reason }) {
  return {
    action,
    route,
    follow_up_kind: followUpKind,
    dedupe_key: buildDedupeKey({ sourceTaskNumber, sourceTaskId, transitionKind, followUpKind, targetPrincipal }),
    title,
    summary,
    target_principal: targetPrincipal || null,
    source_task_number: sourceTaskNumber ?? null,
    source_task_id: sourceTaskId || null,
    transition_kind: transitionKind,
    reason,
  };
}

function buildDedupeKey({ sourceTaskNumber, sourceTaskId, transitionKind, followUpKind, targetPrincipal }) {
  const source = sourceTaskNumber ? `task:${sourceTaskNumber}` : `task_id:${sourceTaskId || 'unknown'}`;
  return [source, transitionKind || 'unknown', followUpKind, targetPrincipal || 'unassigned'].join('|');
}

function isEvidenceBlocked(result, signals) {
  return result.close_blocked === true
    || result.close_action === 'blocked'
    || signals.evidence_blocked === true
    || Array.isArray(result.close_blockers) && result.close_blockers.length > 0;
}

function hasFollowUpLedgerBlocker(result) {
  const blockers = [
    ...arrayValue(result.close_blockers),
    ...arrayValue(result.blockers),
  ].map((entry) => String(entry).toLowerCase());
  return blockers.some((entry) => entry.includes('follow-up ledger') || entry.includes('follow_up_ledger'));
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
