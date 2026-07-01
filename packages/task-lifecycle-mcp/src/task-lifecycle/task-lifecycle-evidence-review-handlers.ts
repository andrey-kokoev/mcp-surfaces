import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';

type TaskLifecyclePayload = Record<string, unknown>;

const ACTIVE_REMEDIATION_TASK_STATUSES = new Set(['opened', 'claimed', 'in_review', 'deferred']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeBlockedReportBlockers(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined);
  const text = nonEmptyString(value);
  return text ? [text] : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function siteRelativePath(siteRoot: string, filePath: string): string {
  const normalized = isAbsolute(filePath) ? relative(siteRoot, filePath) : filePath;
  return normalized.split('\\').join('/');
}

function siteRelativeChangedFiles(siteRoot: string, files: string[]): string[] {
  return files.map((file) => siteRelativePath(siteRoot, file)).filter((file) => file && !file.startsWith('..'));
}

function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseCapabilityList(value: unknown): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
    const record = asRecord(parsed);
    const capabilities = record?.capabilities;
    return Array.isArray(capabilities) ? capabilities.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function capabilitySatisfiesRequirement(capability: string, requirement: string): boolean {
  if (capability === requirement) return true;
  if (requirement === 'review') return capability === 'task_review' || capability === 'architect_as_reviewer';
  return false;
}

function findCapabilityEligibleAgents(store, requirement: string) {
  try {
    const rows = store.db.prepare('SELECT agent_id, role, capabilities_json FROM agent_roster WHERE status = ?').all('active');
    return rows
      .map((row) => ({
        agent_id: row.agent_id,
        role: row.role ?? null,
        capabilities: parseCapabilityList(row.capabilities_json),
      }))
      .filter((row) => row.capabilities.some((capability) => capabilitySatisfiesRequirement(capability, requirement)));
  } catch {
    return [];
  }
}

function evaluateOutcomeCapabilityPolicy({ store, agentId, capabilityRequirement, authorityBasis }) {
  const requirement = nonEmptyString(capabilityRequirement);
  if (!requirement) {
    return {
      capability_requirement: null,
      agent_id: agentId,
      agent_has_capability: true,
      enforcement_result: 'not_required',
      override_allowed: false,
      authority_basis: null,
      eligible_alternative_agents: [],
    };
  }
  const rosterEntry = store.getRosterEntry?.(agentId) ?? null;
  const capabilities = parseCapabilityList(rosterEntry?.capabilities_json);
  const agentHasCapability = capabilities.some((capability) => capabilitySatisfiesRequirement(capability, requirement));
  const overrideProvided = asRecord(authorityBasis) !== null;
  return {
    capability_requirement: requirement,
    agent_id: agentId,
    agent_role: rosterEntry?.role ?? null,
    agent_capabilities: capabilities,
    agent_has_capability: agentHasCapability,
    enforcement_result: agentHasCapability ? 'allowed' : overrideProvided ? 'overridden' : 'blocked',
    override_allowed: true,
    authority_basis: overrideProvided ? authorityBasis : null,
    eligible_alternative_agents: agentHasCapability ? [] : findCapabilityEligibleAgents(store, requirement),
  };
}

function defaultCompletionOutcomeContractForTask(taskId: string, agentId: string) {
  const now = new Date().toISOString();
  return {
    contract_id: `completion_contract_${taskId}`,
    task_id: taskId,
    outcome_type: 'completion',
    allowed_outcomes_json: JSON.stringify(['completed', 'blocked']),
    satisfying_outcomes_json: JSON.stringify(['completed']),
    blocking_outcomes_json: JSON.stringify(['blocked']),
    required_fields_json: JSON.stringify(['summary']),
    capability_requirement: 'implementation_work',
    created_by: agentId,
    created_at: now,
  };
}

type DependencyConflictTaskDependency = {
  dependency_id: string;
  parent_task_id: string;
  required_task_id: string;
};

type DependencyConflictRosterEntry = {
  operator_identity?: string | null;
};

type DependencyConflictSqlRow = {
  agent_id?: unknown;
  operator_identity?: unknown;
};

type DependencyConflictPolicyEvidence = {
  evidence_id: string;
  dependency_id: string;
  required_task_id: string;
  required_outcome_id: string;
  agent_id: string;
  effective_operator_identity: string | null;
  gated_work_operator_identity: string | null;
  conflict_detected: boolean;
  policy_mode: string;
  authorization_required: boolean;
  authorization_basis_json: string | null;
  annotation_recorded: boolean;
  created_at: string;
};

type DependencyConflictStore = {
  getRosterEntry?: (agentId: string) => DependencyConflictRosterEntry | null | undefined;
  db: {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => DependencyConflictSqlRow | undefined;
    };
  };
  listTaskDependenciesForRequired?: (taskId: string) => DependencyConflictTaskDependency[];
  upsertTaskConflictPolicyEvidence: (row: DependencyConflictPolicyEvidence) => void;
};

type DependencyConflictEvaluation = {
  dependency: DependencyConflictTaskDependency;
  evidence: DependencyConflictPolicyEvidence;
  satisfied: boolean;
};

function latestReportAgentId(store: DependencyConflictStore, taskId: string): string | null {
  try {
    const row = store.db.prepare('select agent_id from task_reports where task_id = ? order by submitted_at desc, rowid desc limit 1').get(taskId);
    return typeof row?.agent_id === 'string' ? row.agent_id : null;
  } catch {
    return null;
  }
}

function rosterOperatorIdentity(store: DependencyConflictStore, agentId: string | null): string | null {
  if (!agentId) return null;
  try {
    const entry = store.getRosterEntry?.(agentId);
    if (entry?.operator_identity) return entry.operator_identity;
    const row = store.db.prepare('select operator_identity from agent_roster where agent_id = ?').get(agentId);
    return typeof row?.operator_identity === 'string' ? row.operator_identity : null;
  } catch {
    return null;
  }
}

function dependencyConflictPolicyEvaluations({ store, lifecycle, outcomeId, agentId, authorityBasis, findReviewerCapableAgents }: {
  store: DependencyConflictStore;
  lifecycle: { task_id: string };
  outcomeId: string;
  agentId: string;
  authorityBasis: Record<string, unknown> | null;
  findReviewerCapableAgents: (store: unknown) => unknown[];
}) {
  const dependencies = store.listTaskDependenciesForRequired?.(lifecycle.task_id) ?? [];
  const agentOperatorIdentity = rosterOperatorIdentity(store, agentId);
  const evaluations: DependencyConflictEvaluation[] = dependencies.map((dependency) => {
    const gatedAgentId = latestReportAgentId(store, dependency.parent_task_id);
    const gatedOperatorIdentity = rosterOperatorIdentity(store, gatedAgentId);
    const conflictDetected = Boolean(agentOperatorIdentity && gatedOperatorIdentity && agentOperatorIdentity === gatedOperatorIdentity);
    const evidence = {
      evidence_id: `conflict_${randomUUID()}`,
      dependency_id: dependency.dependency_id,
      required_task_id: lifecycle.task_id,
      required_outcome_id: outcomeId,
      agent_id: agentId,
      effective_operator_identity: agentOperatorIdentity,
      gated_work_operator_identity: gatedOperatorIdentity,
      conflict_detected: conflictDetected,
      policy_mode: conflictDetected ? 'operator_override_allowed' : 'not_applicable',
      authorization_required: conflictDetected,
      authorization_basis_json: conflictDetected && authorityBasis ? JSON.stringify(authorityBasis) : null,
      annotation_recorded: !conflictDetected || Boolean(authorityBasis),
      created_at: new Date().toISOString(),
    };
    return {
      dependency,
      evidence,
      satisfied: !conflictDetected || Boolean(authorityBasis),
    };
  });
  const blocked = evaluations.filter((evaluation) => !evaluation.satisfied);
  return {
    evaluations,
    blocked,
    blocked_payload: blocked.length === 0 ? null : {
      status: 'blocked',
      error: 'dependency_conflict_policy_authorization_required',
      schema: 'narada.task.mcp.finish.dependency_conflict_policy.v0',
      required_task_id: lifecycle.task_id,
      agent_id: agentId,
      conflicts: blocked.map((evaluation) => ({
        dependency_id: evaluation.dependency.dependency_id,
        parent_task_id: evaluation.dependency.parent_task_id,
        required_task_id: evaluation.dependency.required_task_id,
        effective_operator_identity: evaluation.evidence.effective_operator_identity,
        gated_work_operator_identity: evaluation.evidence.gated_work_operator_identity,
        policy_mode: evaluation.evidence.policy_mode,
      })),
      eligible_alternatives: findReviewerCapableAgents(store),
      override_allowed: true,
      example_args: {
        task_number: '<current-task-number>',
        agent_id: agentId,
        outcome: '<allowed-outcome>',
        summary: '<outcome summary>',
        findings: [],
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Explicitly authorize same-operator dependency completion.' },
      },
      remediation: 'Use an eligible alternative agent, or retry with authority_basis when site policy permits operator override.',
    },
  };
}

function positiveTaskNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function taskNumberFromDisposition(value: unknown): number | null {
  const direct = positiveTaskNumber(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return positiveTaskNumber(record.task_number)
    ?? positiveTaskNumber(record.taskNumber)
    ?? positiveTaskNumber(record.created_task_number)
    ?? positiveTaskNumber(record.reopened_task_number)
    ?? positiveTaskNumber(record.routed_task_number);
}

function dispositionString(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return nonEmptyString(record.reason)
    ?? nonEmptyString(record.summary)
    ?? nonEmptyString(record.rationale)
    ?? nonEmptyString(record.question);
}

function validateBlockingFindingDispositions(findings: unknown, store): { ok: true } | { ok: false; errors: string[]; examples: Record<string, unknown> } {
  if (!Array.isArray(findings)) return { ok: true };
  const errors: string[] = [];
  findings.forEach((finding, index) => {
    const record = asRecord(finding);
    if (!record || record.severity !== 'blocking') return;

    const taskBacked = [
      ['remediation_task', record.remediation_task],
      ['created_task_number', record.created_task_number],
      ['reopened_task_number', record.reopened_task_number],
      ['covered_by_existing_task', record.covered_by_existing_task],
    ] as const;
    const taskDisposition = taskBacked.find(([, value]) => taskNumberFromDisposition(value) !== null);
    if (taskDisposition) {
      const taskNumber = taskNumberFromDisposition(taskDisposition[1])!;
      const lifecycle = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) {
        errors.push(`findings[${index}] ${taskDisposition[0]} references missing task #${taskNumber}.`);
        return;
      }
      if (!ACTIVE_REMEDIATION_TASK_STATUSES.has(String(lifecycle.status))) {
        errors.push(`findings[${index}] ${taskDisposition[0]} references task #${taskNumber} in non-actionable status '${lifecycle.status}'.`);
      }
      return;
    }

    const obligationId = nonEmptyString(record.routed_obligation_id)
      ?? nonEmptyString(asRecord(record.routed_obligation)?.obligation_id);
    if (obligationId) {
      const obligation = store.getDirectedObligation(obligationId);
      if (!obligation) {
        errors.push(`findings[${index}] routed_obligation_id '${obligationId}' does not exist.`);
        return;
      }
      if (obligation.status !== 'open') {
        errors.push(`findings[${index}] routed_obligation_id '${obligationId}' is not open; status is '${obligation.status}'.`);
      }
      return;
    }

    if (dispositionString(record.operator_decision_required)) return;
    if (dispositionString(record.operator_deferred_reason)) return;

    const outOfScope = asRecord(record.out_of_scope_or_rejected);
    if (outOfScope && dispositionString(outOfScope) && asRecord(outOfScope.authority_basis)) return;

    errors.push(`findings[${index}] is blocking but has no executable or explicitly deferred disposition.`);
  });

  if (errors.length === 0) return { ok: true };
  return {
    ok: false,
    errors,
    examples: {
      remediation_task: { task_number: 123, responsible_role: 'builder' },
      covered_by_existing_task: { task_number: 123, rationale: 'Existing opened task covers the finding.' },
      routed_obligation_id: 'obl_review_example',
      operator_decision_required: { owner: 'operator', question: 'Clarify intended product behavior.' },
      operator_deferred_reason: 'Blocked until operator selects the product direction.',
      out_of_scope_or_rejected: {
        reason: 'Finding is outside this review scope.',
        authority_basis: { kind: 'operator_direct_instruction', summary: 'Operator narrowed review scope.' },
      },
    },
  };
}

function dependencyDispositionCommandFromFindings(findings: unknown, store, dependencyId: string, agentId: string): Record<string, unknown> | null {
  if (!Array.isArray(findings)) return null;
  for (const finding of findings) {
    const record = asRecord(finding);
    if (!record || record.severity !== 'blocking') continue;
    const remediationTaskNumber = taskNumberFromDisposition(record.remediation_task);
    if (remediationTaskNumber) {
      const lifecycle = store.getLifecycleByNumber(remediationTaskNumber);
      if (!lifecycle?.task_id) return null;
      return {
        tool: 'task_lifecycle_dependency_disposition_record',
        args: {
          dependency_id: dependencyId,
          agent_id: agentId,
          kind: 'remediation_task',
          target_task_id: lifecycle.task_id,
          summary: dispositionString(record.remediation_task) ?? `Blocking review finding routed to remediation task #${remediationTaskNumber}.`,
        },
      };
    }
    const coveredTaskNumber = taskNumberFromDisposition(record.covered_by_existing_task);
    if (coveredTaskNumber) {
      const lifecycle = store.getLifecycleByNumber(coveredTaskNumber);
      if (!lifecycle?.task_id) return null;
      return {
        tool: 'task_lifecycle_dependency_disposition_record',
        args: {
          dependency_id: dependencyId,
          agent_id: agentId,
          kind: 'covered_by_existing_task',
          target_task_id: lifecycle.task_id,
          summary: dispositionString(record.covered_by_existing_task) ?? `Blocking review finding covered by existing task #${coveredTaskNumber}.`,
        },
      };
    }
    const routedObligationId = nonEmptyString(record.routed_obligation_id)
      ?? nonEmptyString(asRecord(record.routed_obligation)?.obligation_id);
    if (routedObligationId) {
      return {
        tool: 'task_lifecycle_dependency_disposition_record',
        args: {
          dependency_id: dependencyId,
          agent_id: agentId,
          kind: 'routed_obligation',
          routed_obligation_id: routedObligationId,
          summary: dispositionString(record.routed_obligation) ?? `Blocking review finding routed to obligation ${routedObligationId}.`,
        },
      };
    }
  }
  return null;
}

export const TASK_LIFECYCLE_EVIDENCE_REVIEW_TOOL_NAMES = Object.freeze([
  "task_lifecycle_self_certification_preflight",
  "task_lifecycle_admit_evidence",
  "task_lifecycle_prove_criteria",
  "task_lifecycle_disposition_closeout",
  "task_lifecycle_finish",
  "task_lifecycle_report_blocked",
  "task_lifecycle_close",
  "task_lifecycle_defer",
  "task_lifecycle_un_defer",
  "task_lifecycle_reopen",
  "task_lifecycle_review"
]);

export function createTaskLifecycleEvidenceReviewHandlers(context) {
  const {
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
    withAuthoredRosterJsonPreserved,
    openTaskLifecycleStore,
    detectSameOperatorReview,
    detectSelfReview,
    isReviewerCapable,
    findReviewerCapableAgents,
    getReviewerCapabilityPolicy,
    validateTaskFinishRecoveryTruthfulness,
    normalizeRosterCapabilitiesForSharedServices,
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
    recordBlockedTaskReport,
    ensureReviewContractDependency,
    markParentAwaitingDependencies,
  } = context;

  async function admitReviewMigrationOutcome({ taskNumber, agentId, verdict, summary, findings, structuralReviewInfo, effectiveSingleOperatorReview, conflictPolicyAuthorization }) {
    const parentLifecycle = store.getLifecycleByNumber(taskNumber);
    if (!parentLifecycle) return null;
    let dependency = (store.listTaskDependenciesForParent?.(parentLifecycle.task_id) ?? [])
      .find((candidate) => candidate.kind === 'review');
    let requiredLifecycle = dependency ? store.getLifecycle?.(dependency.required_task_id) : undefined;
    const now = new Date().toISOString();

    if (!dependency || !requiredLifecycle) {
      const maxTaskRow = store.db.prepare('select max(task_number) as max_task_number from task_lifecycle').get();
      const maxTaskNumber = typeof maxTaskRow?.max_task_number === 'number' ? maxTaskRow.max_task_number : taskNumber;
      store.ensureTaskNumberFloor?.(maxTaskNumber);
      const reviewTaskNumber = store.allocateTaskNumber();
      const safeParentId = parentLifecycle.task_id.replace(/[^A-Za-z0-9._-]+/g, '-');
      const reviewTaskId = `${now.slice(0, 10).replace(/-/g, '')}-${reviewTaskNumber}-legacy-review-${safeParentId}`;
      const dependencyId = `dep-review-${parentLifecycle.task_id}-${reviewTaskId}`;
      const contractId = `contract-review-${reviewTaskId}`;
      requiredLifecycle = {
        task_id: reviewTaskId,
        task_number: reviewTaskNumber,
        status: 'closed',
        governed_by: 'review',
        closed_at: now,
        closed_by: agentId,
        closure_mode: 'peer_reviewed',
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: now,
      };
      store.upsertLifecycle(requiredLifecycle);
      dependency = {
        dependency_id: dependencyId,
        parent_task_id: parentLifecycle.task_id,
        required_task_id: reviewTaskId,
        kind: 'review',
        satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
        status: 'open',
        created_by: agentId,
        created_at: now,
      };
      store.upsertTaskDependency(dependency);
      store.upsertTaskOutcomeContract({
        contract_id: contractId,
        task_id: reviewTaskId,
        outcome_type: 'review',
        allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
        satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
        blocking_outcomes_json: JSON.stringify(['rejected']),
        required_fields_json: JSON.stringify(['summary']),
        capability_requirement: 'review',
        created_by: agentId,
        created_at: now,
      });
    }

    const contract = store.getLatestTaskOutcomeContract?.(requiredLifecycle.task_id);
    if (!contract) return null;
    const normalizedOutcome = verdict === 'needs_changes' ? 'rejected' : verdict;
    const allowedOutcomes = parseStringArrayJson(contract.allowed_outcomes_json);
    if (!allowedOutcomes.includes(normalizedOutcome)) return null;
    const outcomeId = `outcome_${randomUUID()}`;
    const authorityBasis = conflictPolicyAuthorization
      ? {
          kind: nonEmptyString(conflictPolicyAuthorization.kind) ?? 'conflict_policy_authorization',
          summary: nonEmptyString(conflictPolicyAuthorization.summary) ?? structuralReviewInfo?.warning ?? 'Dependency outcome conflict-policy authorization was supplied.',
          ...conflictPolicyAuthorization,
        }
      : effectiveSingleOperatorReview
        ? {
            kind: 'legacy_single_operator_review_annotation',
            summary: structuralReviewInfo?.warning ?? 'Legacy task_lifecycle_review call explicitly allowed same-operator review.',
          }
        : null;
    const conflictPolicy = dependencyConflictPolicyEvaluations({
      store,
      lifecycle: { task_id: requiredLifecycle.task_id },
      outcomeId,
      agentId,
      authorityBasis,
      findReviewerCapableAgents,
    });
    const taskOutcome = {
      outcome_id: outcomeId,
      task_id: requiredLifecycle.task_id,
      contract_id: contract.contract_id,
      agent_id: agentId,
      outcome: normalizedOutcome,
      summary: summary ?? `Legacy task_lifecycle_review admitted ${normalizedOutcome}.`,
      findings_json: findings ?? JSON.stringify([]),
      evidence_refs_json: JSON.stringify([{ kind: 'legacy_task_lifecycle_review', parent_task_number: taskNumber }]),
      admitted_at: now,
    };
    store.insertTaskOutcome(taskOutcome);
    for (const evaluation of conflictPolicy.evaluations) {
      store.upsertTaskConflictPolicyEvidence(evaluation.evidence);
    }
    const parentDependencyWaitStatus = typeof markParentAwaitingDependencies === 'function'
      ? await markParentAwaitingDependencies({
        parentLifecycle,
        parentTaskNumber: taskNumber,
        updatedBy: agentId,
        updatedAt: now,
      })
      : null;
    const dependencySatisfaction = await buildTaskEvidencePreflight({ siteRoot, store, taskNumber });
    return {
      schema: 'narada.task.review_compatibility_dependency_outcome.v0',
      dependency,
      review_task: requiredLifecycle,
      parent_dependency_wait_status: parentDependencyWaitStatus,
      outcome_contract: contract,
      task_outcome: taskOutcome,
      conflict_policy_evidence: conflictPolicy.evaluations.map((evaluation) => evaluation.evidence),
      dependency_satisfaction: dependencySatisfaction.dependency_satisfaction ?? null,
    };
  }

  async function dispatchEvidenceReviewTool(canonicalName, args, dispatchContext = {}) {
    switch (canonicalName) {
    case 'task_lifecycle_self_certification_preflight': {
      const packet = objectField(args, 'self_certification');
      if (!packet) throw new Error('self_certification_required');
      const validation = validateSelfCertificationPacket({
        ...packet,
        surface: stringField(args, 'surface') ?? packet.surface,
        summary: stringField(args, 'summary') ?? packet.summary,
        body: stringField(args, 'body') ?? packet.body,
        actor_principal: stringField(args, 'actor_principal') ?? packet.actor_principal ?? packet.closer_principal ?? packet.reviewer_principal,
        terminal_correction_claim: booleanField(args, 'terminal_correction_claim') === true || packet.terminal_correction_claim === true,
      });
      return jsonToolResult({
        status: validation.ok ? 'allowed' : 'blocked',
        schema: 'narada.task.mcp.self_certification_preflight.v0',
        ok: validation.ok,
        close_blocked: !validation.ok,
        blockers: validation.errors,
        evaluation: validation.evaluation,
        required_fields: validation.evaluation.required_fields,
        allowed_pending_states: validation.evaluation.allowed_pending_states,
      }, !validation.ok);
    }

    case 'task_lifecycle_admit_evidence': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const selfCertification = objectField(args, 'self_certification');
      if (selfCertification) {
        const validation = validateSelfCertificationPacket({
          ...selfCertification,
          surface: 'evidence_admission',
          actor_principal: selfCertification.actor_principal ?? agentId,
        });
        if (!validation.ok) {
          return jsonToolResult({
            status: 'blocked',
            error: 'self_certification_guard_failed',
            close_blocked: true,
            close_blockers: validation.errors,
            task_number: taskNumber,
            schema: 'narada.task.mcp.evidence.self_certification_gate.v0',
            evaluation: validation.evaluation,
            remediation: 'Evidence admission may preserve same-subject evidence, but closure-sensitive architect-failure/deception/trust evidence must carry valid guard metadata and cannot assert terminal correction without independent review or operator acceptance.',
          }, true);
        }
      }
      const admission = await admitTaskEvidence({ cwd: siteRoot, taskNumber, admittedBy: agentId, methods: ['admission'] });
      return jsonToolResult({
        status: admission.blockers.length === 0 ? 'admitted' : 'rejected',
        task_number: taskNumber,
        admission_id: admission.result.admission_id,
        blockers: admission.blockers,
        verdict: admission.result.verdict,
        evidence_preflight: admission.blockers.length > 0 ? await buildTaskEvidencePreflight({ siteRoot, store, taskNumber }) : null,
        schema: 'narada.task.mcp.admit_evidence.v0',
      });
    }

    case 'task_lifecycle_prove_criteria': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      return jsonToolResult(await proveTaskCriteria({ siteRoot, store, taskNumber, agentId }));
    }

    case 'task_lifecycle_disposition_closeout': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const result = await taskLifecycleDispositionCloseout({
        siteRoot,
        store,
        taskNumber,
        agentId,
        envelopeId: stringField(args, 'envelope_id'),
        disposition: stringField(args, 'disposition'),
        summary: stringField(args, 'summary'),
        dryRun: booleanField(args, 'dry_run') === true,
        proveCriteria: booleanField(args, 'prove_criteria') === true,
        finish: booleanField(args, 'finish') === true,
        changedFiles: stringArrayField(args, 'changed_files'),
        noFilesChanged: booleanField(args, 'no_files_changed') === true,
        includeUnrelatedChangedFiles: booleanField(args, 'include_unrelated_changed_files') === true,
      });
      if (result.status !== 'error' && asRecord(result.finish_result)?.new_status === 'in_review' && typeof ensureReviewContractDependency === 'function') {
        const parentLifecycle = store.getLifecycleByNumber(taskNumber);
        const reviewer = stringField(args, 'reviewer') ?? findReviewerCapableAgents(store)?.[0]?.agent_id;
        if (parentLifecycle && reviewer) {
          const reviewDependency = await ensureReviewContractDependency({
            parentLifecycle,
            parentTaskNumber: taskNumber,
            reviewer,
            createdBy: agentId,
          });
          const finishResult = asRecord(result.finish_result);
          if (finishResult) {
            finishResult.review_action = 'dependency_requested';
            finishResult.review_dependency = reviewDependency;
            finishResult.dependency_action = reviewDependency.status;
            finishResult.blocked_by = 'dependencies';
            finishResult.new_status = asRecord(reviewDependency.parent_dependency_wait_status)?.new_status ?? 'awaiting_dependencies';
          }
        }
      }
      return jsonToolResult(result, result.status === 'error');
    }

    case 'task_lifecycle_finish': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const summary = stringField(args, 'summary');
      const verdict = stringField(args, 'verdict');
      const outcome = stringField(args, 'outcome');
      const findings = Array.isArray(args.findings) ? args.findings : undefined;
      const evidenceRefs = stringArrayField(args, 'evidence_refs') ?? [];
      const reviewer = stringField(args, 'reviewer');
      const changedFiles = stringArrayField(args, 'changed_files');
      const noFilesChanged = booleanField(args, 'no_files_changed') === true;
      const recoveryTruthfulness = objectField(args, 'recovery_truthfulness');
      const selfCertification = objectField(args, 'self_certification');
      const authorityBasis = objectField(args, 'authority_basis');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      if (args.findings !== undefined && !Array.isArray(args.findings)) throw new Error('findings_must_be_array');
      const validReviewVerdicts = ['accepted', 'accepted_with_notes', 'rejected'];
      if (verdict && !validReviewVerdicts.includes(verdict)) {
        return jsonToolResult({
          status: 'error',
          error: 'invalid_finish_verdict',
          schema: 'narada.task.mcp.finish.invalid_verdict.v0',
          task_number: taskNumber,
          completion_mode: 'report',
          invalid_verdict: verdict,
          valid_review_verdicts: validReviewVerdicts,
          remediation: 'For claimed-state finish/report submission, call this tool without verdict and provide summary plus changed_files or no_files_changed. Use accepted, accepted_with_notes, or rejected only for review-state tasks.',
        }, true);
      }
      if (verdict) {
        return jsonToolResult({
          status: 'blocked',
          error: 'finish_verdict_disallowed',
          schema: 'narada.task.mcp.finish.review_compatibility_gate.v0',
          task_number: taskNumber,
          completion_mode: 'blocked',
          invalid_field: 'verdict',
          remediation: 'task_lifecycle_finish is generic task completion. For outcome-contract tasks, use outcome. For legacy review compatibility, call task_lifecycle_review so the MCP can migrate the review into dependency/outcome authority.',
          example_outcome_args: {
            task_number: taskNumber,
            agent_id: agentId,
            outcome: verdict,
            summary: summary ?? '<review outcome summary>',
            findings: findings ?? [],
          },
          compatibility_tool: 'task_lifecycle_review',
          example_compatibility_args: {
            task_number: taskNumber,
            agent_id: agentId,
            verdict,
          },
        }, true);
      }
      if (changedFiles && noFilesChanged) {
        return jsonToolResult({
          status: 'error',
          error: 'changed_files_conflicts_with_no_files_changed',
          schema: 'narada.task.mcp.finish.changed_file_evidence.v0',
          remediation: 'Provide changed_files for code/document edits, or no_files_changed=true for legitimate design-only/research tasks, but not both.',
          examples: finishGateExamples('changed_files'),
        }, true);
      }
      enforceSessionIdentity(agentId);
      const identityWarning = verifySessionIdentity(agentId);
      const truthfulnessGate = validateTaskFinishRecoveryTruthfulness({
        taskNumber,
        summary,
        changedFiles,
        noFilesChanged,
        recoveryTruthfulness,
      });
      if (!truthfulnessGate.ok) {
        const payload: TaskLifecyclePayload = {
          status: 'blocked',
          error: 'recovery_truthfulness_guard_failed',
          close_blocked: true,
          task_number: taskNumber,
          schema: 'narada.task.mcp.finish.recovery_truthfulness_gate.v0',
          close_blockers: truthfulnessGate.errors,
          evaluation: truthfulnessGate.evaluation,
          recovery_state_vocabulary: truthfulnessGate.evaluation.state_vocabulary,
          required_fields: truthfulnessGate.evaluation.required_fields,
          remediation: 'For serious-failure recovery finish/report claims, provide recovery_truthfulness with known_facts, inferences, uncertainty, changed, not_changed, remaining_work, evidence_limits, capa_open_status, and state. Use terminal_corrected only when corrective implementation is complete, no related CAPA/task/review remains open, and repository_durability names committed/pushed state; task creation alone is not correction.',
          examples: finishGateExamples('recovery_truthfulness'),
        };
        if (identityWarning) {
          payload.identity_warning = identityWarning;
        }
        return jsonToolResult(payload, true);
      }
      const lifecycle = store.getLifecycleByNumber(taskNumber);
      const outcomeContract = lifecycle ? store.getLatestTaskOutcomeContract?.(lifecycle.task_id) : undefined;
      if (outcomeContract && !outcome) {
        return jsonToolResult({
          status: 'blocked',
          error: 'outcome_required_by_contract',
          schema: 'narada.task.mcp.finish.outcome_contract.v0',
          task_number: taskNumber,
          task_id: lifecycle?.task_id,
          outcome_contract: outcomeContract,
          allowed_outcomes: parseStringArrayJson(outcomeContract.allowed_outcomes_json),
          required_fields: parseStringArrayJson(outcomeContract.required_fields_json),
          remediation: 'This task has an outcome contract. Call task_lifecycle_finish with outcome, summary, and findings when applicable; contract_id is inferred from the task.',
          example_args: {
            task_number: taskNumber,
            agent_id: agentId,
            outcome: parseStringArrayJson(outcomeContract.allowed_outcomes_json)[0] ?? 'completed',
            summary: 'Outcome summary.',
            findings: [],
          },
        }, true);
      }
      if (outcomeContract && outcome) {
        const allowedOutcomes = parseStringArrayJson(outcomeContract.allowed_outcomes_json);
        if (!allowedOutcomes.includes(outcome)) {
          return jsonToolResult({
            status: 'error',
            error: 'outcome_not_allowed_by_contract',
            schema: 'narada.task.mcp.finish.outcome_contract.v0',
            task_number: taskNumber,
            task_id: lifecycle?.task_id,
            invalid_outcome: outcome,
            allowed_outcomes: allowedOutcomes,
            outcome_contract: outcomeContract,
            remediation: 'Use one of the contract allowed_outcomes. The MCP infers contract_id from the task; do not pass raw contract metadata.',
          }, true);
        }
        const requiredFields = parseStringArrayJson(outcomeContract.required_fields_json);
        if (requiredFields.includes('summary') && !summary) {
          return jsonToolResult({
            status: 'blocked',
            error: 'outcome_contract_required_field_missing',
            schema: 'narada.task.mcp.finish.outcome_contract.v0',
            task_number: taskNumber,
            task_id: lifecycle?.task_id,
            missing_fields: ['summary'],
            outcome_contract: outcomeContract,
            remediation: 'This outcome contract requires summary. Retry task_lifecycle_finish with outcome and summary.',
          }, true);
        }
        if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
        const outcomeId = `outcome_${randomUUID()}`;
        const outcomeCapabilityPolicy = evaluateOutcomeCapabilityPolicy({
          store,
          agentId,
          capabilityRequirement: outcomeContract.capability_requirement,
          authorityBasis,
        });
        if (outcomeCapabilityPolicy.enforcement_result === 'blocked') {
          return jsonToolResult({
            status: 'blocked',
            error: 'outcome_contract_capability_required',
            schema: 'narada.task.mcp.finish.outcome_capability_policy.v0',
            task_number: taskNumber,
            task_id: lifecycle.task_id,
            outcome,
            outcome_contract: outcomeContract,
            allowed_outcomes: allowedOutcomes,
            outcome_capability_policy: outcomeCapabilityPolicy,
            remediation: 'This outcome contract requires an admitted capability. Use an eligible agent, or pass authority_basis when site policy permits explicit operator override.',
            example_override_args: {
              task_number: taskNumber,
              agent_id: agentId,
              outcome,
              summary: summary ?? '<outcome summary>',
              findings: findings ?? [],
              authority_basis: { kind: 'operator_direct_instruction', summary: '<why this agent may complete this outcome contract>' },
            },
          }, true);
        }
        const activeAssignment = store.getActiveAssignment(lifecycle.task_id);
        if (activeAssignment && activeAssignment.agent_id !== agentId && !asRecord(authorityBasis)) {
          return jsonToolResult({
            status: 'blocked',
            error: 'outcome_contract_active_assignment_mismatch',
            schema: 'narada.task.mcp.finish.outcome_assignment_policy.v0',
            task_number: taskNumber,
            task_id: lifecycle.task_id,
            outcome,
            outcome_contract: outcomeContract,
            allowed_outcomes: allowedOutcomes,
            outcome_capability_policy: outcomeCapabilityPolicy,
            active_assignment: {
              assignment_id: activeAssignment.assignment_id,
              agent_id: activeAssignment.agent_id,
              claimed_at: activeAssignment.claimed_at,
            },
            actor_agent_id: agentId,
            remediation: 'Claimed outcome-contract tasks must be finished by the active assignee. Use the assigned agent, unclaim/reassign the task, or pass authority_basis when explicit operator override is intended.',
            example_override_args: {
              task_number: taskNumber,
              agent_id: agentId,
              outcome,
              summary: summary ?? '<outcome summary>',
              findings: findings ?? [],
              authority_basis: { kind: 'operator_direct_instruction', summary: '<why this agent may finish work assigned to another agent>' },
            },
          }, true);
        }
        const conflictPolicy = dependencyConflictPolicyEvaluations({
          store,
          lifecycle,
          outcomeId,
          agentId,
          authorityBasis,
          findReviewerCapableAgents,
        });
        if (conflictPolicy.blocked_payload) {
          return jsonToolResult({
            ...conflictPolicy.blocked_payload,
            task_number: taskNumber,
            outcome,
            outcome_contract: outcomeContract,
            allowed_outcomes: allowedOutcomes,
          }, true);
        }
        const taskOutcome = {
          outcome_id: outcomeId,
          task_id: lifecycle.task_id,
          contract_id: outcomeContract.contract_id,
          agent_id: agentId,
          outcome,
          summary,
          findings_json: JSON.stringify(findings ?? []),
          evidence_refs_json: JSON.stringify(evidenceRefs),
          admitted_at: new Date().toISOString(),
        };
        store.insertTaskOutcome(taskOutcome);
        for (const evaluation of conflictPolicy.evaluations) {
          store.upsertTaskConflictPolicyEvidence(evaluation.evidence);
        }
        const transition = await transitionLifecycleTask({
          siteRoot,
          store,
          taskNumber,
          agentId,
          reason: 'outcome_contract_finished',
          toStatus: 'closed',
          resultStatus: 'closed',
        });
        if (transition.status === 'error') {
          return jsonToolResult({
            status: 'error',
            error: 'outcome_admitted_but_lifecycle_transition_failed',
            task_number: taskNumber,
            task_id: lifecycle.task_id,
            task_outcome: taskOutcome,
            transition,
          }, true);
        }
        if (activeAssignment) store.releaseAssignment(activeAssignment.assignment_id, 'outcome_contract_finished');
        const payload: TaskLifecyclePayload = {
          status: 'success',
          completion_mode: 'outcome_contract',
          task_id: lifecycle.task_id,
          task_number: taskNumber,
          agent_id: agentId,
          new_status: 'closed',
          close_action: 'closed',
          assignment_released: Boolean(activeAssignment),
          task_outcome: taskOutcome,
          outcome_contract: outcomeContract,
          allowed_outcomes: allowedOutcomes,
          outcome_capability_policy: outcomeCapabilityPolicy,
          conflict_policy_evidence: conflictPolicy.evaluations.map((evaluation) => evaluation.evidence),
        };
        if (identityWarning) payload.identity_warning = identityWarning;
        return jsonToolResult(payload);
      }
      if (lifecycle?.status === 'in_review') {
        const payload: TaskLifecyclePayload = {
          status: 'blocked',
          error: 'finish_in_review_legacy_state_disallowed',
          schema: 'narada.task.mcp.finish.review_compatibility_gate.v0',
          task_number: taskNumber,
          completion_mode: 'blocked',
          legacy_status: 'in_review',
          remediation: 'task_lifecycle_finish is generic task completion and outcome-contract completion. For legacy in_review tasks, use task_lifecycle_review so the MCP can migrate review intent into dependency/outcome authority.',
          compatibility_tool: 'task_lifecycle_review',
          example_compatibility_args: {
            task_number: taskNumber,
            agent_id: agentId,
            verdict: '<accepted | accepted_with_notes | rejected>',
            findings: [],
          },
        };
        if (identityWarning) payload.identity_warning = identityWarning;
        return jsonToolResult(payload, true);
      }
      const testGate = lifecycle ? testResultArtifactGate(store, lifecycle.task_id) : { failed_test_artifacts: [], latest_passing_artifacts: [] };
      if (testGate.failed_test_artifacts.length > 0) {
        const payload: TaskLifecyclePayload = {
          status: 'blocked',
          schema: 'narada.task.mcp.finish.test_gate.v0',
          task_number: taskNumber,
          close_blocked: true,
          close_blockers: ['Task has current failed structured test evidence. Run the same selector again and produce a newer passing artifact before finish.'],
          failed_test_artifacts: testGate.failed_test_artifacts,
          latest_passing_artifacts: testGate.latest_passing_artifacts,
          remediation: 'Run task_lifecycle_run_tests with the same selector as each failed artifact. A newer passed artifact for that selector supersedes earlier failures.',
        };
        if (identityWarning) {
          payload.identity_warning = identityWarning;
        }
        return jsonToolResult(payload, true);
      }
      const taskFile = await findTaskFile(siteRoot, taskNumber);
      if (!taskFile && lifecycle) {
        return jsonToolResult(buildTaskFileResolutionFailure({ siteRoot, store, taskNumber, lifecycle, surface: 'task_lifecycle_finish' }), true);
      }
      if (taskFile) {
        const { body } = await readTaskFile(taskFile.path);
        const selfCertificationValidation = selfCertification
          ? validateSelfCertificationPacket({
            ...selfCertification,
            actor_principal: selfCertification.actor_principal ?? selfCertification.closer_principal ?? agentId,
            summary,
            body,
            terminal_correction_claim: true,
            surface: 'task_lifecycle_finish',
          })
          : validateSelfCertificationBody({ body, summary, actor_principal: agentId });
        if (!selfCertificationValidation.ok) {
          const payload: TaskLifecyclePayload = {
            status: 'blocked',
            error: 'self_certification_guard_failed',
            close_blocked: true,
            close_blockers: selfCertificationValidation.errors,
            task_number: taskNumber,
            schema: 'narada.task.mcp.finish.self_certification_gate.v0',
            evaluation: selfCertificationValidation.evaluation,
            required_fields: selfCertificationValidation.evaluation.required_fields,
            allowed_pending_states: selfCertificationValidation.evaluation.allowed_pending_states,
            remediation: 'For architect-failure/deception/trust same-subject terminal correction, provide self_certification with target_category, subject_principal, requires_independent_review, misleading_completion_answer, allowed_pending_state, and either eligible independent review refs or explicit operator acceptance. Otherwise keep the work in a review-required/pending/blocker state.',
          };
          if (identityWarning) {
            payload.identity_warning = identityWarning;
          }
          return jsonToolResult(payload, true);
        }
        const followUpValidation = validateFollowUpLedger(body);
        if (!followUpValidation.ok) {
          const payload: TaskLifecyclePayload = {
            status: 'error',
            error: 'follow_up_ledger_required',
            close_blocked: true,
            close_blockers: followUpValidation.errors,
            task_number: taskNumber,
            remediation: 'Add a ## Follow-Up Ledger section to the task, with one accepted ledger line for each preserved follow-up or remaining-work disposition. Accepted prefixes include created #N, covered by #N, envelope env_<id>, CAPA <capa_id>, deferred:, and no follow-up needed: .',
            next_command: `Update task ${taskNumber} with a ## Follow-Up Ledger linking each preserved follow-up to created #N, covered by #N, envelope env_<id>, CAPA <capa_id>, deferred: <reason>, or no follow-up needed: <rationale>.`,
            schema: 'narada.task.mcp.finish.follow_up_ledger_gate.v0',
            examples: finishGateExamples('follow_up_ledger'),
          };
          if (identityWarning) {
            payload.identity_warning = identityWarning;
          }
          return jsonToolResult(payload, true);
        }
        const recoveryTruthfulnessValidation = recoveryTruthfulness
          ? { ok: true }
          : validateRecoveryTruthfulnessBody({ body, summary, context: `task:${taskNumber}` });
        if (!recoveryTruthfulnessValidation.ok) {
          const payload: TaskLifecyclePayload = {
            status: 'error',
            error: 'recovery_truthfulness_guard_required',
            close_blocked: true,
            close_blockers: recoveryTruthfulnessValidation.errors,
            task_number: taskNumber,
            trigger_evaluation: recoveryTruthfulnessValidation.evaluation,
            next_command: `Update task ${taskNumber} with a ## Recovery Truthfulness section naming known facts, inferences, uncertainty, changed, not changed, remaining work, evidence limits, CAPA-open status, and state. For terminal_corrected, also name repository durability / commit-push state.`,
            schema: 'narada.task.mcp.finish.recovery_truthfulness_gate.v0',
            examples: finishGateExamples('recovery_truthfulness'),
          };
          if (identityWarning) {
            payload.identity_warning = identityWarning;
          }
          return jsonToolResult(payload, true);
        }
      }
      normalizeRosterCapabilitiesForSharedServices?.();
      ensureStaticRosterAgentInSql(store, siteRoot, agentId);
      const includeUnrelatedChangedFiles = booleanField(args, 'include_unrelated_changed_files') === true;
      const rawAutoDetectedChangedFiles = !changedFiles && !noFilesChanged ? detectGitChangedFiles(siteRoot) : [];
      const scopedChangedFiles = scopeChangedFiles(siteRoot, rawAutoDetectedChangedFiles, { includeUnrelated: includeUnrelatedChangedFiles });
      const autoDetectedChangedFiles = scopedChangedFiles.files;
      const finishOptions: TaskLifecyclePayload = { cwd: siteRoot, taskNumber, agent: agentId, summary, close: true, store };
      if (outcomeContract) finishOptions.allowReviewIntentReport = true;
      if (reviewer) finishOptions.suppressLegacyReviewRouting = true;
      if (verdict) finishOptions.verdict = verdict;
      if (reviewer) finishOptions.reviewer = reviewer;
      if (changedFiles) finishOptions.changedFiles = JSON.stringify(changedFiles);
      if (!changedFiles && autoDetectedChangedFiles.length > 0) finishOptions.changedFiles = JSON.stringify(siteRelativeChangedFiles(siteRoot, autoDetectedChangedFiles));
      if (noFilesChanged) finishOptions.changedFiles = JSON.stringify([NO_FILES_CHANGED_MARKER]);
      const result = await withAuthoredRosterJsonPreserved(siteRoot, () => finishTaskService(finishOptions));
      const payload = result.result || result;
      const isBlocked = payload.close_action === 'blocked';
      if (!changedFiles && !noFilesChanged) {
        payload.changed_files_scoping = scopedChangedFiles;
      }
      if (!isBlocked && result.exitCode === 0 && reviewer && lifecycle && typeof ensureReviewContractDependency === 'function') {
        const existingReviewDependency = (store.listTaskDependenciesForParent?.(lifecycle.task_id) ?? [])
          .find((dependency) => dependency.kind === 'review');
        const existingReviewLifecycle = existingReviewDependency ? store.getLifecycle?.(existingReviewDependency.required_task_id) : null;
        const reviewDependency = existingReviewDependency
          ? {
              status: 'existing',
              dependency_id: existingReviewDependency.dependency_id,
              parent_task_id: existingReviewDependency.parent_task_id,
              parent_task_number: taskNumber,
              required_task_id: existingReviewDependency.required_task_id,
              required_task_number: existingReviewLifecycle?.task_number ?? null,
              dependency_kind: existingReviewDependency.kind,
              reviewer,
              parent_dependency_wait_status: {
                task_id: lifecycle.task_id,
                task_number: taskNumber,
                old_status: lifecycle.status,
                new_status: store.getLifecycleByNumber(taskNumber)?.status ?? payload.new_status ?? 'awaiting_dependencies',
                blocked_by: 'dependencies',
                projection_updated: false,
              },
              outcome_contract: store.getLatestTaskOutcomeContract(existingReviewDependency.required_task_id) ?? null,
            }
          : await ensureReviewContractDependency({
              parentLifecycle: lifecycle,
              parentTaskNumber: taskNumber,
              reviewer,
              createdBy: agentId,
            });
        payload.review_action = 'dependency_requested';
        payload.review_dependency = reviewDependency;
        payload.dependency_action = reviewDependency.status;
        payload.legacy_review_routing_suppressed = true;
        payload.dependency_native_review_routing = true;
        payload.obligation_id = null;
        payload.blocked_by = 'dependencies';
        payload.new_status = asRecord(reviewDependency.parent_dependency_wait_status)?.new_status ?? 'awaiting_dependencies';
      }
      if (isBlocked) {
        payload.close_blocked = true;
        payload.evidence_preflight = await buildTaskEvidencePreflight({ siteRoot, store, taskNumber });
        if (!payload.evidence_reason && payload.close_blockers?.length > 0) {
          payload.evidence_reason = payload.close_blockers.join('; ');
        }
        const remediation = buildStateAwareFinishBlockerRemediation({ taskNumber, agentId, lifecycle, payload });
        payload.next_action = remediation.next_action;
        payload.next_command = remediation.next_command;
        payload.remediation = remediation.remediation;
      }
      if (!isBlocked && result.exitCode === 0 && lifecycle && !outcomeContract) {
        const completionContract = defaultCompletionOutcomeContractForTask(lifecycle.task_id, agentId);
        store.upsertTaskOutcomeContract(completionContract);
        const latestOutcome = store.getLatestTaskOutcome?.(lifecycle.task_id);
        if (latestOutcome?.contract_id === completionContract.contract_id) {
          payload.task_outcome = latestOutcome;
          payload.outcome_contract = completionContract;
          payload.outcome_admission = 'existing';
        } else {
          const reportId = typeof payload.report_id === 'string' ? payload.report_id : null;
          const taskOutcome = {
            outcome_id: `outcome_${randomUUID()}`,
            task_id: lifecycle.task_id,
            contract_id: completionContract.contract_id,
            agent_id: agentId,
            outcome: 'completed',
            summary: summary ?? 'Task finished successfully.',
            findings_json: JSON.stringify([]),
            evidence_refs_json: JSON.stringify([
              ...evidenceRefs,
              { kind: 'task_lifecycle_finish', task_number: taskNumber, report_id: reportId },
            ]),
            admitted_at: new Date().toISOString(),
          };
          store.insertTaskOutcome(taskOutcome);
          payload.task_outcome = taskOutcome;
          payload.outcome_contract = completionContract;
          payload.outcome_admission = 'created';
        }
      }
      payload.follow_up_policy = evaluatePostTransitionFollowups({
        event: { transition_kind: payload.close_action ?? 'finish', task_number: taskNumber, task_id: payload.task_id, agent_id: agentId },
        source_task: { task_number: taskNumber, task_id: payload.task_id },
        actor: { agent_id: agentId },
        result: payload,
        signals: { evidence_blocked: isBlocked },
      });
      if (!isBlocked && result.exitCode === 0) {
        payload.post_closeout_continuation = buildPostCloseoutContinuation({ agentId, result: payload });
      }
      if (!isBlocked && result.exitCode === 0) {
        try {
          const checkpointResult = await emitCheckpoint({
            cwd: siteRoot,
            agentId,
            sessionId: process.env.KIMI_SESSION_ID || process.env.SESSION_ID || 'unknown',
            taskNumber,
            taskId: payload.task_id || null,
            boundaryType: 'finish',
            summary,
          });
          payload.checkpoint_event = checkpointResult;
        } catch {
          // Non-blocking: checkpoint emission failure must not prevent finish
        }
      }
      if (identityWarning) {
        payload.identity_warning = identityWarning;
      }
      return jsonToolResult(payload);
    }

    case 'task_lifecycle_close': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const mode = stringField(args, 'mode') || 'agent_finish';
      const noContinuationNeeded = stringField(args, 'no_continuation_needed');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const selfCertification = objectField(args, 'self_certification');
      if (selfCertification) {
        const validation = validateSelfCertificationPacket({
          ...selfCertification,
          surface: 'task_lifecycle_close',
          actor_principal: selfCertification.actor_principal ?? selfCertification.closer_principal ?? agentId,
          terminal_correction_claim: true,
        });
        if (!validation.ok) {
          return jsonToolResult({
            status: 'blocked',
            error: 'self_certification_guard_failed',
            close_blocked: true,
            close_blockers: validation.errors,
            task_number: taskNumber,
            schema: 'narada.task.mcp.close.self_certification_gate.v0',
            evaluation: validation.evaluation,
            remediation: 'Task close for same-subject architect-failure/deception/trust material requires eligible independent review or explicit operator acceptance, otherwise use a pending/blocker state.',
          }, true);
        }
      }
      const evidencePreflight = await buildTaskEvidencePreflight({ siteRoot, store, taskNumber });
      if (asRecord(evidencePreflight.dependency_satisfaction)?.all_satisfied === false) {
        return jsonToolResult({
          status: 'blocked',
          error: 'task_close_dependencies_unsatisfied',
          close_action: 'blocked',
          close_blocked: true,
          close_blockers: evidencePreflight.blockers,
          task_number: taskNumber,
          task_id: evidencePreflight.task_id,
          schema: 'narada.task.mcp.close.dependency_satisfaction_gate.v0',
          dependency_satisfaction: evidencePreflight.dependency_satisfaction,
          evidence_preflight: evidencePreflight,
          remediation: 'Complete each required dependency task with an admitted satisfying outcome before closing the parent task.',
          next_action: evidencePreflight.next_action,
        });
      }
      const result = await withAuthoredRosterJsonPreserved(siteRoot, () => closeTaskService({ cwd: siteRoot, taskNumber, agent: agentId, mode, noContinuationNeeded }));
      const payload = result.result || result;
      const isBlocked = result.exitCode !== 0 || payload.close_action === 'blocked';
      if (!isBlocked) {
        payload.post_closeout_continuation = buildPostCloseoutContinuation({ agentId, result: payload });
      }
      return jsonToolResult(payload, isBlocked);
    }

    case 'task_lifecycle_defer': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const reason = stringField(args, 'reason');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const serviceResult = await transitionLifecycleTask({ siteRoot, store, taskNumber, agentId, reason, toStatus: 'deferred', resultStatus: 'deferred' });
      return jsonToolResult(serviceResult, serviceResult.status === 'error');
    }

    case 'task_lifecycle_report_blocked': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const reason = stringField(args, 'reason');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      if (!reason) throw new Error('reason_required');
      enforceSessionIdentity(agentId);
      const lifecycle = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
      const blockers = normalizeBlockedReportBlockers(args.blockers);
      const nextAction = stringField(args, 'next_action');
      const defer = booleanField(args, 'defer') !== false;
      const now = new Date().toISOString();
      const activeAssignment = store.getActiveAssignment ? store.getActiveAssignment(lifecycle.task_id) : null;
      const reportId = `blocked_${randomUUID()}`;
      const report = {
        report_id: reportId,
        task_number: taskNumber,
        task_id: lifecycle.task_id,
        assignment_id: activeAssignment?.assignment_id ?? null,
        agent_id: agentId,
        reported_at: now,
        summary: reason,
        changed_files: [],
        verification: [],
        known_residuals: blockers,
        ready_for_review: false,
        report_status: 'blocked',
        blocked: true,
        next_action: nextAction,
      };
      recordBlockedTaskReport({ store, report });
      let lifecycleTransition = null;
      if (defer && lifecycle.status !== 'deferred') {
        lifecycleTransition = await transitionLifecycleTask({ siteRoot, store, taskNumber, agentId, reason, toStatus: 'deferred', resultStatus: 'deferred' });
      }
      return jsonToolResult({
        status: 'blocked_reported',
        schema: 'narada.task.mcp.blocked_report.v0',
        task_number: taskNumber,
        task_id: lifecycle.task_id,
        report_id: reportId,
        report_status: 'blocked',
        lifecycle_status: store.getLifecycleByNumber(taskNumber)?.status ?? lifecycle.status,
        lifecycle_transition: lifecycleTransition,
        blockers,
        reason,
        next_action: nextAction ?? 'Resolve blockers, then continue or finish with completion evidence.',
      }, false);
    }

    case 'task_lifecycle_un_defer': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const reason = stringField(args, 'reason');
      const authorityBasis = objectField(args, 'authority_basis');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const serviceResult = await unDeferLifecycleTask({ siteRoot, store, taskNumber, agentId, reason, authorityBasis });
      return jsonToolResult(serviceResult, serviceResult.status === 'error');
    }

    case 'task_lifecycle_reopen': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const reason = stringField(args, 'reason');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const serviceResult = await transitionLifecycleTask({ siteRoot, store, taskNumber, agentId, reason, toStatus: 'opened', resultStatus: 'reopened' });
      return jsonToolResult(serviceResult, serviceResult.status === 'error');
    }

    case 'task_lifecycle_review': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const verdict = stringField(args, 'verdict');
      let findings = args.findings;
      if (Array.isArray(findings)) {
        findings = JSON.stringify(findings);
      }
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      if (!verdict) throw new Error('verdict_required');
      enforceSessionIdentity(agentId);
      const identityWarning = verifySessionIdentity(agentId);

      const reviewerCapabilityPolicy = getReviewerCapabilityPolicy ? getReviewerCapabilityPolicy() : { mode: 'advisory', source: 'default' };
      const reviewerHasCapability = isReviewerCapable(store, agentId);
      if (!reviewerHasCapability && reviewerCapabilityPolicy.mode === 'strict') {
        const eligibleReviewers = findReviewerCapableAgents(store);
        const outcomeCapabilityPolicy = { ...reviewerCapabilityPolicy, capability_requirement: 'review', agent_has_capability: false, enforcement_result: 'blocked' };
        return jsonToolResult({
          status: 'error',
          error: 'outcome_capability_not_admitted',
          message: `Agent ${agentId} does not have admitted capability for review outcome contracts.`,
          outcome_capability_policy: outcomeCapabilityPolicy,
          reviewer_capability_policy: { ...reviewerCapabilityPolicy, reviewer_has_capability: false, enforcement_result: 'blocked' },
          required_capability: 'review',
          eligible_alternative_agents: eligibleReviewers,
          remediation: eligibleReviewers.length > 0
            ? `Use a dependency task agent with admitted review capability: ${eligibleReviewers.map((r) => r.agent_id).join(', ')}.`
            : 'No agents with admitted review capability are present in the roster. Admit a capable identity with task_lifecycle_roster_admit before completing this outcome contract.',
        }, true);
      }
      const reviewerCapabilityPolicyEvidence = {
        ...reviewerCapabilityPolicy,
        reviewer_has_capability: reviewerHasCapability,
        enforcement_result: reviewerHasCapability ? 'satisfied' : reviewerCapabilityPolicy.mode === 'disabled' ? 'skipped_by_site_policy' : 'advisory_warning',
      };
      const outcomeCapabilityPolicyEvidence = {
        ...reviewerCapabilityPolicy,
        capability_requirement: 'review',
        agent_has_capability: reviewerHasCapability,
        enforcement_result: reviewerCapabilityPolicyEvidence.enforcement_result,
      };

      const selfCertification = objectField(args, 'self_certification');
      if (selfCertification) {
        const validation = validateSelfCertificationPacket({
          ...selfCertification,
          surface: 'task_lifecycle_review',
          actor_principal: selfCertification.actor_principal ?? selfCertification.reviewer_principal ?? agentId,
          terminal_correction_claim: ['accepted', 'accepted_with_notes'].includes(verdict),
        });
        if (!validation.ok) {
          const payload: TaskLifecyclePayload = {
            status: 'blocked',
            error: 'self_certification_guard_failed',
            close_blocked: true,
            close_blockers: validation.errors,
            task_number: taskNumber,
            schema: 'narada.task.mcp.review.self_certification_gate.v0',
            evaluation: validation.evaluation,
            remediation: 'Same-subject review cannot satisfy final independent review for architect-failure/deception/trust material without eligible independent-review metadata or explicit operator acceptance.',
          };
          if (identityWarning) payload.identity_warning = identityWarning;
          return jsonToolResult(payload, true);
        }
      }

      // Same-operator and self-review detection
      let structuralReviewInfo = null;
      try {
        const reviewStore = openTaskLifecycleStore(siteRoot);
        try {
          structuralReviewInfo = detectSameOperatorReview(reviewStore, agentId, taskNumber);
          if (!structuralReviewInfo?.sameOperator) {
            structuralReviewInfo = detectSelfReview(reviewStore, agentId, taskNumber);
          }
        } finally {
          reviewStore.db.close();
        }
      } catch {
        // Best-effort
      }

      let isStructuralReview = structuralReviewInfo?.sameOperator || structuralReviewInfo?.selfReview;
      const autoAcceptSingleOperator = booleanField(args, 'auto_accept_single_operator') === true;
      const reviewerCapableAgents = findReviewerCapableAgents(store);
      const isSingletonReviewer = reviewerCapableAgents.length === 1 && reviewerCapableAgents[0].agent_id === agentId;
      if (autoAcceptSingleOperator && !isStructuralReview && isSingletonReviewer) {
        isStructuralReview = true;
        structuralReviewInfo = {
          selfReview: true,
          kind: 'singleton_reviewer',
          reviewerAgent: agentId,
          warning: `Singleton reviewer detected: only one reviewer-capable agent is available (${agentId}).`,
        };
      }
      const conflictPolicyAuthorization = asRecord(args.conflict_policy_authorization);
      if (isStructuralReview && !args.single_operator_review && !conflictPolicyAuthorization && !autoAcceptSingleOperator) {
        return jsonToolResult({
          status: 'error',
          error: 'dependency_conflict_policy_authorization_required',
          compatibility_error: 'single_operator_review_blocked',
          message: structuralReviewInfo.warning,
          hint: 'Pass conflict_policy_authorization with an authority basis to admit this dependency outcome, or use compatibility alias single_operator_review: true.',
        }, true);
      }

      // Prepend annotation when single-operator review is explicitly requested or auto-accepted
      const effectiveSingleOperatorReview = args.single_operator_review === true || (autoAcceptSingleOperator && isStructuralReview);
      let parsedFindings = null;
      if (findings) {
        try {
          parsedFindings = JSON.parse(findings);
          if (!Array.isArray(parsedFindings)) parsedFindings = null;
        } catch {
          parsedFindings = null;
        }
      }
      const blockingDispositionValidation = validateBlockingFindingDispositions(parsedFindings, store);
      if (blockingDispositionValidation.ok === false) {
        return jsonToolResult({
          status: 'blocked',
          error: 'blocking_outcome_disposition_required',
          compatibility_error: 'blocking_review_finding_disposition_required',
          close_blocked: true,
          task_number: taskNumber,
          schema: 'narada.task.mcp.dependency.blocking_outcome_disposition_gate.v0',
          close_blockers: blockingDispositionValidation.errors,
          remediation: 'Every blocking dependency outcome finding must name an executable or explicitly deferred disposition before it can gate parent closure.',
          next_tool: 'task_lifecycle_dependency_disposition_record',
          example_args: {
            dependency_id: '<dependency_id>',
            agent_id: agentId,
            kind: 'remediation_task',
            target_task_id: '<task_id>',
            summary: 'Record how this blocking dependency outcome will be resolved.',
          },
          allowed_kinds: ['remediation_task', 'covered_by_existing_task', 'routed_obligation', 'operator_decision_required', 'operator_deferred', 'out_of_scope_or_rejected'],
          examples: blockingDispositionValidation.examples,
        }, true);
      }
      if (isStructuralReview && effectiveSingleOperatorReview) {
        const annotation = {
          severity: 'note',
          description: `single_operator_review: ${structuralReviewInfo.warning} This review is annotated as single-operator review (kind: ${structuralReviewInfo.kind || 'same_operator'}).`,
          location: 'review_authority',
        };
        if (Array.isArray(parsedFindings)) {
          parsedFindings.unshift(annotation);
        } else {
          parsedFindings = [annotation];
        }
        findings = JSON.stringify(parsedFindings);
      }

      const migrationOutcome = await admitReviewMigrationOutcome({
        taskNumber,
        agentId,
        verdict,
        summary: stringField(args, 'summary'),
        findings,
        structuralReviewInfo,
        effectiveSingleOperatorReview,
        conflictPolicyAuthorization,
      });
      if (!migrationOutcome) {
        return jsonToolResult({
          status: 'error',
          error: 'review_migration_outcome_not_admitted',
          schema: 'narada.task.review_compatibility_dependency_outcome.v0',
          task_number: taskNumber,
          agent_id: agentId,
          remediation: 'Use task_lifecycle_submit_work with reviewer to create a review-contract dependency, or finish the existing dependency task with task_lifecycle_finish outcome arguments.',
        }, true);
      }
      const payload: TaskLifecyclePayload = {
        status: 'success',
        schema: 'narada.task.review_compatibility_dependency_outcome.v0',
        completion_mode: 'review_compatibility_dependency_outcome',
        task_number: taskNumber,
        agent_id: agentId,
        outcome_capability_policy: outcomeCapabilityPolicyEvidence,
        reviewer_capability_policy: reviewerCapabilityPolicyEvidence,
        review_compatibility_dependency_outcome: migrationOutcome,
        conflict_policy_evidence: asRecord(migrationOutcome)?.conflict_policy_evidence ?? [],
        close_action: 'skipped',
        close_reason: 'task_lifecycle_review is compatibility migration only; parent closure is governed by dependency satisfaction.',
      };
      const dependencySatisfaction = asRecord(migrationOutcome)?.dependency_satisfaction;
      const dependencyRecord = asRecord(asRecord(migrationOutcome)?.dependency);
      const dependencyId = typeof dependencyRecord?.dependency_id === 'string' ? dependencyRecord.dependency_id : '<dependency_id>';
      const nextCommand = dependencyDispositionCommandFromFindings(parsedFindings, store, dependencyId, agentId);
      if (asRecord(dependencySatisfaction)?.disposition_required === true || nextCommand) {
        payload.blocking_outcome_remediation = {
          next_tool: 'task_lifecycle_dependency_disposition_record',
          example_args: {
            dependency_id: dependencyId,
            agent_id: agentId,
            kind: 'remediation_task',
            summary: 'Record how this blocking dependency outcome will be resolved.',
          },
          next_command: nextCommand,
          directly_executable: nextCommand !== null,
          allowed_kinds: ['remediation_task', 'covered_by_existing_task', 'routed_obligation', 'operator_decision_required', 'operator_deferred', 'out_of_scope_or_rejected'],
        };
      }
      if (isStructuralReview) {
        payload.conflict_policy_authorization = conflictPolicyAuthorization ?? null;
        payload.conflict_policy_conflict_detected = true;
        payload.conflict_policy_annotation = structuralReviewInfo.warning;
        payload.conflict_policy_kind = structuralReviewInfo.kind || 'same_operator';
        payload.single_operator_review = true;
        payload.single_operator_annotation = structuralReviewInfo.warning;
        payload.single_operator_kind = structuralReviewInfo.kind || 'same_operator';
      }
      if (identityWarning) {
        payload.identity_warning = identityWarning;
      }
      return jsonToolResult(payload);
    }

      default:
        throw new Error(`task_mcp_refused: ${canonicalName}`);
    }
  }

  return Object.fromEntries(TASK_LIFECYCLE_EVIDENCE_REVIEW_TOOL_NAMES.map((name) => [name, (args, dispatchContext) => dispatchEvidenceReviewTool(name, args, dispatchContext)]));
}
