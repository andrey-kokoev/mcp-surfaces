export const TASK_LIFECYCLE_ASSIGNMENT_TOOL_NAMES = Object.freeze([
  'task_lifecycle_claim',
  'task_lifecycle_continue',
  'task_lifecycle_unclaim',
]);

export function createTaskLifecycleAssignmentHandlers({
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
}) {
  return {
    task_lifecycle_claim: async (args) => {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      enforceSessionIdentity(agentId);
      const identityWarning = verifySessionIdentity(agentId);
      const lifecycle = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);

      const eligibility = checkTaskRoleEligibilityLocal({ store, siteRoot, taskId: lifecycle.task_id, taskNumber, agentId });
      if (!eligibility.eligible) {
        return jsonToolResult({
          status: 'role_mismatch',
          task_number: taskNumber,
          target_role: eligibility.targetRole,
          agent_role: eligibility.agentRole,
          role_resolution: eligibility.roleResolution,
          message: eligibility.warning,
        }, true);
      }
      const mismatchAuthority = validatePreferredAgentMismatchAuthority({ args, eligibility, lifecycle, taskNumber, agentId });
      if (mismatchAuthority.status === 'blocked') {
        recordClaimIntent({
          store,
          lifecycle,
          taskNumber,
          agentId,
          status: 'rejected',
          rejectionReason: 'preferred_agent_mismatch_requires_authority',
          authorityBasis: mismatchAuthority.authority_basis,
          preferredAgentWarning: mismatchAuthority.preferred_agent_warning,
        });
        return jsonToolResult({
          status: 'preferred_agent_mismatch_requires_authority',
          task_number: taskNumber,
          preferred_agent_id: eligibility.preferredAgentId,
          claiming_agent: agentId,
          pre_claim_warnings: [mismatchAuthority.preferred_agent_warning],
          remediation: 'Retry the claim with authority_basis: { kind: "operator_direct_instruction" | "directed_obligation" | "task_owner_handoff", summary: "..." }.',
          preferred_agent_warning: mismatchAuthority.preferred_agent_warning,
          schema: 'narada.task.claim.preferred_agent_authority.v0',
        }, true);
      }

      const serviceResult = await claimLifecycleTask({ siteRoot, store, taskNumber, agentId });
      if (serviceResult.status === 'closure_authority_blocks_claim') return jsonToolResult(serviceResult, true);
      if (serviceResult.status === 'already_claimed') {
        return jsonToolResult({
          status: 'already_claimed',
          assignment: serviceResult.assignment,
          pre_claim_warnings: [{
            kind: 'active_assignment',
            severity: 'blocker',
            assigned_agent: serviceResult.assignment?.agent_id ?? null,
            claimed_at: serviceResult.assignment?.claimed_at ?? null,
            message: `Task already has an active assignment by ${serviceResult.assignment?.agent_id ?? 'unknown'}.`,
          }],
        }, true);
      }
      const result = { status: 'claimed', assignment_id: serviceResult.assignment_id, task_number: taskNumber };
      if (eligibility.warning) {
        result.preferred_agent_warning = {
          kind: 'preferred_agent_mismatch',
          severity: 'requires_authority',
          warning: 'preferred_agent_mismatch',
          preferred_agent_id: eligibility.preferredAgentId,
          claiming_agent: agentId,
          message: eligibility.warning,
        };
        result.pre_claim_warnings = [result.preferred_agent_warning];
        result.preferred_agent_mismatch_authority = mismatchAuthority.authority_basis;
      }
      recordClaimIntent({
        store,
        lifecycle,
        taskNumber,
        agentId,
        status: 'claimed',
        assignmentId: serviceResult.assignment_id,
        authorityBasis: mismatchAuthority.authority_basis,
        preferredAgentWarning: result.preferred_agent_warning ?? null,
      });
      if (identityWarning) result.identity_warning = identityWarning;
      return jsonToolResult(result);
    },

    task_lifecycle_continue: async (args) => {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const reason = stringField(args, 'reason');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
      if (!reason) throw new Error('reason_required');
      enforceSessionIdentity(agentId);
      const lifecycle = store.getLifecycleByNumber(taskNumber);
      if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);

      const eligibility = checkTaskRoleEligibilityLocal({ store, siteRoot, taskId: lifecycle.task_id, taskNumber, agentId });
      if (!eligibility.eligible) {
        return jsonToolResult({
          status: 'role_mismatch',
          task_number: taskNumber,
          target_role: eligibility.targetRole,
          agent_role: eligibility.agentRole,
          role_resolution: eligibility.roleResolution,
          message: eligibility.warning,
        }, true);
      }

      const result = await withAuthoredRosterJsonPreserved(siteRoot, () => continueTaskService({ cwd: siteRoot, taskNumber, agent: agentId, reason }));
      return jsonToolResult(result.result || result, result.exitCode !== 0);
    },

    task_lifecycle_unclaim: async (args) => {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const reason = stringField(args, 'reason') ?? 'mcp_unclaim';
      if (!taskNumber) throw new Error('task_number_required');
      if (agentId) enforceSessionIdentity(agentId);
      const serviceResult = await unclaimLifecycleTask({ siteRoot, store, taskNumber, agentId, reason });
      return jsonToolResult(serviceResult, ['not_claimed', 'claimed_by_other', 'closure_authority_blocks_unclaim'].includes(serviceResult.status));
    },
  };
}
