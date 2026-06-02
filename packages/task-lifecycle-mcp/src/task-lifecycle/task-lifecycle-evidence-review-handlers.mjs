export const TASK_LIFECYCLE_EVIDENCE_REVIEW_TOOL_NAMES = Object.freeze([
  "task_lifecycle_self_certification_preflight",
  "task_lifecycle_admit_evidence",
  "task_lifecycle_prove_criteria",
  "task_lifecycle_disposition_closeout",
  "task_lifecycle_finish",
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
    reviewTaskService,
    withAuthoredRosterJsonPreserved,
    openTaskLifecycleStore,
    detectSameOperatorReview,
    detectSelfReview,
    validateTaskFinishRecoveryTruthfulness,
    finishGateExamples,
    buildStateAwareFinishBlockerRemediation,
    detectGitChangedFiles,
    buildTaskEvidencePreflight,
    buildPostCloseoutContinuation,
    emitCheckpoint,
    evaluatePostTransitionFollowups,
    findTaskFile,
    readTaskFile,
    testResultArtifactGate,
    validateFollowUpLedger,
    ensureStaticRosterAgentInSql,
  } = context;

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
      });
      return jsonToolResult(result, result.status === 'error');
    }

    case 'task_lifecycle_finish': {
      const taskNumber = numberField(args, 'task_number');
      const agentId = stringField(args, 'agent_id');
      const summary = stringField(args, 'summary');
      const verdict = stringField(args, 'verdict');
      const reviewer = stringField(args, 'reviewer');
      const changedFiles = stringArrayField(args, 'changed_files');
      const noFilesChanged = booleanField(args, 'no_files_changed') === true;
      const recoveryTruthfulness = objectField(args, 'recovery_truthfulness');
      const selfCertification = objectField(args, 'self_certification');
      if (!taskNumber) throw new Error('task_number_required');
      if (!agentId) throw new Error('agent_id_required');
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
        const payload = {
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
      const testGate = lifecycle ? testResultArtifactGate(store, lifecycle.task_id) : { failed_test_artifacts: [], latest_passing_artifacts: [] };
      if (testGate.failed_test_artifacts.length > 0) {
        const payload = {
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
          const payload = {
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
          const payload = {
            status: 'error',
            error: 'follow_up_ledger_required',
            close_blocked: true,
            close_blockers: followUpValidation.errors,
            task_number: taskNumber,
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
          const payload = {
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
      ensureStaticRosterAgentInSql(store, siteRoot, agentId);
      const autoDetectedChangedFiles = !changedFiles && !noFilesChanged ? detectGitChangedFiles(siteRoot) : [];
      const finishOptions = { cwd: siteRoot, taskNumber, agent: agentId, summary, verdict, close: true };
      if (reviewer) finishOptions.reviewer = reviewer;
      if (changedFiles) finishOptions.changedFiles = JSON.stringify(changedFiles);
      if (!changedFiles && autoDetectedChangedFiles.length > 0) finishOptions.changedFiles = JSON.stringify(autoDetectedChangedFiles);
      if (noFilesChanged) finishOptions.changedFiles = JSON.stringify([NO_FILES_CHANGED_MARKER]);
      const result = await withAuthoredRosterJsonPreserved(siteRoot, () => finishTaskService(finishOptions));
      const payload = result.result || result;
      const isBlocked = payload.close_action === 'blocked';
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
      return jsonToolResult(payload, result.exitCode !== 0 || isBlocked);
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
      const selfCertification = objectField(args, 'self_certification');
      if (selfCertification) {
        const validation = validateSelfCertificationPacket({
          ...selfCertification,
          surface: 'task_lifecycle_review',
          actor_principal: selfCertification.actor_principal ?? selfCertification.reviewer_principal ?? agentId,
          terminal_correction_claim: ['accepted', 'accepted_with_notes'].includes(verdict),
        });
        if (!validation.ok) {
          const payload = {
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
        const store = openTaskLifecycleStore(siteRoot);
        try {
          structuralReviewInfo = detectSameOperatorReview(store, agentId, taskNumber);
          if (!structuralReviewInfo?.sameOperator) {
            structuralReviewInfo = detectSelfReview(store, agentId, taskNumber);
          }
        } finally {
          store.db.close();
        }
      } catch {
        // Best-effort
      }

      const isStructuralReview = structuralReviewInfo?.sameOperator || structuralReviewInfo?.selfReview;
      if (isStructuralReview && !args.single_operator_review) {
        return jsonToolResult({
          status: 'error',
          error: 'single_operator_review_blocked',
          message: structuralReviewInfo.warning,
          hint: 'Pass single_operator_review: true to allow single-operator review with annotation recorded.',
        }, true);
      }

      // Prepend annotation when single-operator review is explicitly requested
      let parsedFindings = null;
      if (findings) {
        try {
          parsedFindings = JSON.parse(findings);
          if (!Array.isArray(parsedFindings)) parsedFindings = null;
        } catch {
          parsedFindings = null;
        }
      }
      if (isStructuralReview && args.single_operator_review) {
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

      const result = await withAuthoredRosterJsonPreserved(siteRoot, () => reviewTaskService({ cwd: siteRoot, taskNumber, agent: agentId, verdict, findings }));
      const payload = result.result || result;
      const isBlocked = payload.evidence_blocked === true || payload.close_action === 'blocked';
      if (isBlocked) {
        payload.close_blocked = true;
      }
      if (isStructuralReview) {
        payload.single_operator_review = true;
        payload.single_operator_annotation = structuralReviewInfo.warning;
        payload.single_operator_kind = structuralReviewInfo.kind || 'same_operator';
      }
      if (identityWarning) {
        payload.identity_warning = identityWarning;
      }
      return jsonToolResult(payload, result.exitCode !== 0 || isBlocked);
    }

      default:
        throw new Error(`task_mcp_refused: ${canonicalName}`);
    }
  }

  return Object.fromEntries(TASK_LIFECYCLE_EVIDENCE_REVIEW_TOOL_NAMES.map((name) => [name, (args, dispatchContext) => dispatchEvidenceReviewTool(name, args, dispatchContext)]));
}
