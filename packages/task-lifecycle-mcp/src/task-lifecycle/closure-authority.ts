export function deriveClosureAuthority(lifecycle) {
  const terminalStatus = ['closed', 'confirmed'].includes(lifecycle?.status);
  const closedAt = lifecycle?.closed_at ?? null;
  const closedBy = lifecycle?.closed_by ?? null;
  const hasClosureEvidence = Boolean(closedAt && closedBy);
  if (!hasClosureEvidence && !terminalStatus) {
    return {
      status: 'no_closure_evidence',
      closure_dominates: false,
      has_closure_evidence: false,
      terminal_status: false,
      terminal_state_requires_reopen: false,
    };
  }

  const reopenedAfterClosure = closedAt
    ? isAfter(lifecycle?.reopened_at, closedAt)
    : isIsoTimestamp(lifecycle?.reopened_at);
  const continuationAfterClosure = hasContinuationAfterClosure(lifecycle?.continuation_packet_json, closedAt);
  const traceableReopenOrContinue = reopenedAfterClosure || continuationAfterClosure;
  const contradictoryStatus = !terminalStatus && hasClosureEvidence && !traceableReopenOrContinue;
  const terminalStateRequiresReopen = terminalStatus && !traceableReopenOrContinue;
  const closureDominates = contradictoryStatus || terminalStateRequiresReopen;

  return {
    status: closureDominates
      ? terminalStateRequiresReopen
        ? 'terminal_state_requires_reopen_or_continue'
        : 'closure_evidence_conflicts_with_lifecycle_status'
      : 'closure_evidence_consistent',
    closure_dominates: closureDominates,
    has_closure_evidence: hasClosureEvidence,
    terminal_status: terminalStatus,
    terminal_state_requires_reopen: terminalStateRequiresReopen,
    contradictory_status: contradictoryStatus,
    reason: terminalStateRequiresReopen
      ? `Task is in terminal status '${lifecycle?.status}' and has no later reopen/continue trace.`
      : contradictoryStatus
        ? `Task has authoritative closure evidence (${closedAt} by ${closedBy}) with status '${lifecycle?.status}' and no later reopen/continue trace.`
        : 'Closure evidence is closed or superseded by a later reopen/continue trace.',
    closed_at: closedAt,
    closed_by: closedBy,
    reopened_at: lifecycle?.reopened_at ?? null,
    reopened_by: lifecycle?.reopened_by ?? null,
    reopened_after_closure: reopenedAfterClosure,
    continuation_after_closure: continuationAfterClosure,
  };
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isAfter(candidate, baseline) {
  if (!candidate || !baseline) return false;
  const candidateMs = Date.parse(candidate);
  const baselineMs = Date.parse(baseline);
  return Number.isFinite(candidateMs) && Number.isFinite(baselineMs) && candidateMs > baselineMs;
}

function hasContinuationAfterClosure(packetJson, closedAt) {
  if (!packetJson) return false;
  let packet;
  try {
    packet = JSON.parse(packetJson);
  } catch {
    return false;
  }
  const timestamps = [];
  collectIsoLikeValues(packet, timestamps);
  return closedAt ? timestamps.some((value) => isAfter(value, closedAt)) : timestamps.length > 0;
}

export function terminalTaskMutationGuard(lifecycle, operation) {
  const closureAuthority = deriveClosureAuthority(lifecycle);
  if (!closureAuthority.closure_dominates) return null;
  return {
    error: 'terminal_task_mutation_requires_reopen',
    schema: 'narada.task.mcp.terminal_state_gate.v1',
    operation,
    task_number: lifecycle?.task_number ?? null,
    task_id: lifecycle?.task_id ?? null,
    current_status: lifecycle?.status ?? null,
    closure_authority: closureAuthority,
    remediation: 'Use task_lifecycle_reopen or task_lifecycle_continue to create an explicit post-terminal trace before claiming or submitting a new outcome.',
  };
}

function collectIsoLikeValues(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIsoLikeValues(item, out);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectIsoLikeValues(item, out);
  }
}
