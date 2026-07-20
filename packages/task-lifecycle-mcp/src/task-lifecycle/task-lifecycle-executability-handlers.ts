/**
 * Task Executability MCP tool handlers.
 *
 * These handlers bridge the Task Lifecycle MCP surface to the durable
 * executability request/assessment/override state in task-governance-core.
 * They do not invoke an intelligence provider or launch workers; assessment
 * admission is performed by the consumer that ran the evaluator (e.g. Delegated
 * Task or a lifecycle hook).
 */

import {
  TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
  TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
  type TaskExecutabilityVerdict,
} from '@narada2/task-governance-core/task-executability-contract';
import {
  admitTaskExecutabilityAssessment,
  assembleDeclaredEnvironment,
  buildTaskExecutabilityPosture,
  checkTaskExecutabilityDispatch,
  computeDispatchFingerprint,
  createExecutabilityOverride,
  declaredEnvironmentDigest,
  enqueueTaskExecutabilityRequest,
  recordTaskExecutabilityFailure,
  resolveEffectiveTaskExecutabilityPolicy,
  taskExecutabilityRequestId,
  taskSpecDigest,
} from '@narada2/task-governance-core/task-executability-service';

export const TASK_LIFECYCLE_EXECUTABILITY_TOOL_NAMES = Object.freeze([
  'task_lifecycle_executability_request',
  'task_lifecycle_executability_status',
  'task_lifecycle_executability_requests_next',
  'task_lifecycle_executability_complete',
  'task_lifecycle_executability_override',
  'task_lifecycle_executability_dispatch_check',
]);

export function createTaskLifecycleExecutabilityHandlers(context) {
  const {
    store,
    siteRoot,
    jsonToolResult,
    stringField,
    numberField,
    enforceSessionIdentity,
  } = context;

  function requireLifecycleAndSpec(taskNumber: number) {
    const lifecycle = store.getLifecycleByNumber(taskNumber);
    if (!lifecycle) throw new Error(`task_not_found: ${taskNumber}`);
    const spec = store.getTaskSpec(lifecycle.task_id);
    if (!spec) throw new Error(`task_spec_not_found: ${taskNumber}`);
    return { lifecycle, spec };
  }

  function buildDigestableSpec(spec: { title: string; goal_markdown: string | null; context_markdown: string | null; required_work_markdown: string | null; non_goals_markdown: string | null; acceptance_criteria_json: string; dependencies_json: string }): {
    title: string;
    goal: string | null;
    context: string | null;
    required_work: string | null;
    non_goals: string | null;
    acceptance_criteria: string[];
    dependencies: number[];
  } {
    return {
      title: spec.title,
      goal: spec.goal_markdown ?? null,
      context: spec.context_markdown ?? null,
      required_work: spec.required_work_markdown ?? null,
      non_goals: spec.non_goals_markdown ?? null,
      acceptance_criteria: parseJsonStringArray(spec.acceptance_criteria_json),
      dependencies: parseJsonNumberArray(spec.dependencies_json),
    };
  }

  function currentEnvironmentDigest() {
    return assembleDeclaredEnvironment(siteRoot);
  }

  async function dispatchExecutabilityTool(canonicalName: string, args: Record<string, unknown>) {
    switch (canonicalName) {
      case 'task_lifecycle_executability_request': {
        const taskNumber = numberField(args, 'task_number');
        const agentId = stringField(args, 'agent_id');
        if (!taskNumber) throw new Error('task_number_required');
        if (!agentId) throw new Error('agent_id_required');
        enforceSessionIdentity(agentId);
        const { lifecycle, spec } = requireLifecycleAndSpec(taskNumber);
        const digestable = buildDigestableSpec(spec);
        const environment = currentEnvironmentDigest();
        const policy = resolveEffectiveTaskExecutabilityPolicy(siteRoot);
        const taskSpecDigestValue = taskSpecDigest(digestable);
        const environmentDigest = declaredEnvironmentDigest(environment);
        const requestId = taskExecutabilityRequestId({
          task_id: lifecycle.task_id,
          task_spec_digest: taskSpecDigestValue,
          environment_digest: environmentDigest,
          evaluator_profile: policy.evaluator_profile,
          evaluator_profile_version: '1.0.0',
        });
        const existing = store.getExecutabilityRequest(requestId);
        const request = enqueueTaskExecutabilityRequest({
          store,
          siteRoot,
          taskId: lifecycle.task_id,
          taskNumber,
          spec: digestable,
          environment,
        });
        return jsonToolResult({
          schema: 'narada.task_executability.request.v0',
          status: existing ? 'existing' : 'enqueued',
          request_id: request.request_id,
          task_number: request.task_number,
          task_id: request.task_id,
          state: request.state,
          task_spec_digest: request.task_spec_digest,
          environment_digest: request.environment_digest,
          evaluator_profile: request.evaluator_profile,
          evaluator_profile_version: request.evaluator_profile_version,
        });
      }

      case 'task_lifecycle_executability_status': {
        const taskNumber = numberField(args, 'task_number');
        if (!taskNumber) throw new Error('task_number_required');
        const { lifecycle, spec } = requireLifecycleAndSpec(taskNumber);
        const digestable = buildDigestableSpec(spec);
        const environment = currentEnvironmentDigest();
        const posture = buildTaskExecutabilityPosture({
          store,
          taskId: lifecycle.task_id,
          currentSpecDigest: taskSpecDigest(digestable),
          currentEnvDigest: declaredEnvironmentDigest(environment),
        });
        return jsonToolResult({
          schema: 'narada.task_executability.status.v0',
          status: 'ok',
          task_number: taskNumber,
          task_id: lifecycle.task_id,
          executable: posture.executable,
          currency: posture.currency,
          verdict: posture.verdict ?? null,
          reason: posture.reason,
          policy: posture.policy,
          request: posture.request
            ? {
                request_id: posture.request.request_id,
                state: posture.request.state,
                task_spec_digest: posture.request.task_spec_digest,
                environment_digest: posture.request.environment_digest,
                attempt_count: posture.request.attempt_count,
                lease_owner: posture.request.lease_owner,
                lease_expires_at: posture.request.lease_expires_at,
                superseded_by_request_id: posture.request.superseded_by_request_id,
                created_at: posture.request.created_at,
                updated_at: posture.request.updated_at,
              }
            : null,
          assessment: posture.assessment
            ? {
                assessment_id: posture.assessment.assessment_id,
                request_id: posture.assessment.request_id,
                verdict: posture.assessment.verdict,
                task_spec_digest: posture.assessment.task_spec_digest,
                environment_digest: posture.assessment.environment_digest,
                created_at: posture.assessment.created_at,
              }
            : null,
          findings: posture.findings ?? null,
        });
      }

      case 'task_lifecycle_executability_requests_next': {
        const consumerId = stringField(args, 'consumer_id');
        const leaseDurationMinutes = Math.max(1, Math.min(numberField(args, 'lease_duration_minutes') ?? 10, 120));
        const limit = Math.max(1, Math.min(numberField(args, 'limit') ?? 1, 20));
        if (!consumerId) throw new Error('consumer_id_required');
        const now = new Date().toISOString();
        const available = store.db
          .prepare(
            `SELECT * FROM task_executability_requests
             WHERE state = 'pending'
               AND (lease_expires_at IS NULL OR lease_expires_at < ?)
             ORDER BY created_at ASC, request_id ASC
             LIMIT ?`
          )
          .all(now, limit) as Array<{ request_id: string }>;
        const leased = [];
        for (const row of available) {
          const leasedRequest = store.leaseExecutabilityRequest(row.request_id, consumerId, leaseDurationMinutes);
          if (leasedRequest) {
            const spec = store.getTaskSpec(leasedRequest.task_id);
            leased.push({
              request_id: leasedRequest.request_id,
              task_number: leasedRequest.task_number,
              task_id: leasedRequest.task_id,
              task_spec_digest: leasedRequest.task_spec_digest,
              environment_digest: leasedRequest.environment_digest,
              evaluator_profile: leasedRequest.evaluator_profile,
              evaluator_profile_version: leasedRequest.evaluator_profile_version,
              lease_expires_at: leasedRequest.lease_expires_at,
              title: spec?.title ?? null,
            });
          }
        }
        return jsonToolResult({
          schema: 'narada.task_executability.requests_next.v0',
          status: leased.length > 0 ? 'leased' : 'empty',
          consumer_id: consumerId,
          lease_duration_minutes: leaseDurationMinutes,
          leased_count: leased.length,
          leased,
        });
      }

      case 'task_lifecycle_executability_complete': {
        const requestId = stringField(args, 'request_id');
        const assessmentInput = args.assessment;
        if (!requestId) throw new Error('request_id_required');
        if (!assessmentInput || typeof assessmentInput !== 'object' || Array.isArray(assessmentInput)) {
          throw new Error('assessment_required');
        }
        const assessment = assessmentInput as Record<string, unknown>;
        try {
          const row = admitTaskExecutabilityAssessment({
            store,
            requestId,
            assessment: {
              request_id: String(assessment.request_id ?? requestId),
              task_id: String(assessment.task_id),
              task_number: Number(assessment.task_number),
              task_spec_digest: String(assessment.task_spec_digest),
              environment_digest: String(assessment.environment_digest),
              verdict: assessment.verdict as TaskExecutabilityVerdict,
              findings: Array.isArray(assessment.findings) ? assessment.findings : [],
              evaluator: {
                schema: TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
                ...(assessment.evaluator as {
                  schema?: string;
                  profile: string;
                  profile_version: string;
                  cognition: 'low';
                  provider?: string;
                  model?: string;
                  delegated_task_id?: string;
                  worker_run_id?: string;
                }),
              },
              created_at: String(assessment.created_at),
            },
          });
          return jsonToolResult({
            schema: 'narada.task_executability.complete.v0',
            status: 'completed',
            assessment_id: row.assessment_id,
            request_id: row.request_id,
            task_number: row.task_number,
            task_id: row.task_id,
            verdict: row.verdict,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordTaskExecutabilityFailure({
            store,
            requestId,
            failure: { kind: 'assessment_admission_failed', message },
            state: 'failed_terminal',
          });
          return jsonToolResult(
            {
              schema: 'narada.task_executability.complete.v0',
              status: 'failed',
              reason: message,
              request_id: requestId,
            },
            true
          );
        }
      }

      case 'task_lifecycle_executability_dispatch_check': {
        const taskNumber = numberField(args, 'task_number');
        if (!taskNumber) throw new Error('task_number_required');
        const { lifecycle, spec } = requireLifecycleAndSpec(taskNumber);
        const digestable = buildDigestableSpec(spec);
        const environment = currentEnvironmentDigest();
        const dispatchFingerprint = stringField(args, 'dispatch_fingerprint') ?? computeDispatchFingerprint({
          taskId: lifecycle.task_id,
          taskSpecDigest: taskSpecDigest(digestable),
          environmentDigest: declaredEnvironmentDigest(environment),
        });
        const result = checkTaskExecutabilityDispatch({
          store,
          taskId: lifecycle.task_id,
          dispatchFingerprint,
          currentSpecDigest: taskSpecDigest(digestable),
          currentEnvDigest: declaredEnvironmentDigest(environment),
        });
        return jsonToolResult({
          schema: 'narada.task_executability.dispatch_check.v0',
          executable: result.executable,
          basis: result.basis,
          assessment_id: result.assessment?.assessment_id ?? null,
          override_consumed: result.override_consumed ?? false,
          dispatch_fingerprint: dispatchFingerprint,
          task_spec_digest: taskSpecDigest(digestable),
          environment_digest: declaredEnvironmentDigest(environment),
        });
      }

      case 'task_lifecycle_executability_override': {
        const taskNumber = numberField(args, 'task_number');
        const agentId = stringField(args, 'agent_id');
        const reason = stringField(args, 'reason');
        if (!taskNumber) throw new Error('task_number_required');
        if (!agentId) throw new Error('agent_id_required');
        if (!reason) throw new Error('override_reason_required');
        enforceSessionIdentity(agentId);
        const basisInput = args.authority_basis;
        if (!basisInput || typeof basisInput !== 'object' || Array.isArray(basisInput)) throw new Error('override_authority_basis_required');
        const basis = basisInput as Record<string, unknown>;
        const kind = stringField(basis, 'kind');
        const summary = stringField(basis, 'summary');
        if (!kind || !summary) throw new Error('override_authority_basis_requires_kind_and_summary');
        const { lifecycle, spec } = requireLifecycleAndSpec(taskNumber);
        const digestable = buildDigestableSpec(spec);
        const environment = currentEnvironmentDigest();
        const taskSpecDigestValue = taskSpecDigest(digestable);
        const environmentDigest = declaredEnvironmentDigest(environment);
        const dispatchFingerprint = stringField(args, 'dispatch_fingerprint') ?? computeDispatchFingerprint({
          taskId: lifecycle.task_id,
          taskSpecDigest: taskSpecDigestValue,
          environmentDigest,
        });
        const override = createExecutabilityOverride({
          store,
          taskId: lifecycle.task_id,
          taskSpecDigest: taskSpecDigestValue,
          dispatchFingerprint,
          actor: agentId,
          reason,
          authorityBasis: { kind, summary },
        });
        return jsonToolResult({
          schema: 'narada.task_executability.override.v0',
          status: 'admitted',
          task_number: taskNumber,
          task_id: lifecycle.task_id,
          override_id: override.override_id,
          task_spec_digest: taskSpecDigestValue,
          environment_digest: environmentDigest,
          dispatch_fingerprint: dispatchFingerprint,
          actor: agentId,
          reason,
          authority_basis: { kind, summary },
          consumed_at: null,
        });
      }

      default:
        throw new Error(`task_mcp_refused: ${canonicalName}`);
    }
  }

  return Object.fromEntries(
    TASK_LIFECYCLE_EXECUTABILITY_TOOL_NAMES.map((name) => [
      name,
      (args: Record<string, unknown>) => dispatchExecutabilityTool(name, args),
    ])
  );
}

export function buildCompactExecutabilityPosture(args: {
  store: { getTaskSpec: (taskId: string) => { title: string; goal_markdown: string | null; context_markdown: string | null; required_work_markdown: string | null; non_goals_markdown: string | null; acceptance_criteria_json: string; dependencies_json: string } | undefined };
  siteRoot: string;
  taskId: string;
}): {
  executable: boolean;
  currency: 'current' | 'stale' | 'superseded';
  verdict: TaskExecutabilityVerdict | null;
  reason: string;
} {
  const { store, siteRoot, taskId } = args;
  try {
    const spec = store.getTaskSpec(taskId);
    if (!spec) {
      return { executable: false, currency: 'stale', verdict: null, reason: 'Task spec not found.' };
    }
    const digestable = {
      title: spec.title,
      goal: spec.goal_markdown ?? null,
      context: spec.context_markdown ?? null,
      required_work: spec.required_work_markdown ?? null,
      non_goals: spec.non_goals_markdown ?? null,
      acceptance_criteria: parseJsonStringArray(spec.acceptance_criteria_json),
      dependencies: parseJsonNumberArray(spec.dependencies_json),
    };
    const environment = assembleDeclaredEnvironment(siteRoot);
    const posture = buildTaskExecutabilityPosture({
      store: args.store as unknown as import('@narada2/task-governance-core/task-lifecycle-store').TaskLifecycleStore,
      taskId,
      currentSpecDigest: taskSpecDigest(digestable),
      currentEnvDigest: declaredEnvironmentDigest(environment),
    });
    return {
      executable: posture.executable,
      currency: posture.currency,
      verdict: posture.verdict ?? null,
      reason: posture.reason,
    };
  } catch (error) {
    return {
      executable: false,
      currency: 'stale',
      verdict: null,
      reason: error instanceof Error ? `executability_posture_unavailable: ${error.message}` : 'executability_posture_unavailable',
    };
  }
}

function parseJsonStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonNumberArray(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'number') : [];
  } catch {
    return [];
  }
}
