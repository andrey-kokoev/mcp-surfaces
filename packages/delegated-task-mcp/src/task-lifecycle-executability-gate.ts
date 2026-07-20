import { openTaskLifecycleStore, type TaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import {
  assembleDeclaredEnvironment,
  checkTaskExecutabilityDispatch,
  computeDispatchFingerprint,
  declaredEnvironmentDigest,
  resolveEffectiveTaskExecutabilityPolicy,
  taskSpecDigest,
} from '@narada2/task-governance-core/task-executability-service';
import { TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION, TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID, taskExecutabilityAssessmentTemplate } from './task-executability-assessment.js';

type JsonRecord = Record<string, unknown>;

export type TaskLifecycleDispatchGateState = {
  siteRoot: string;
  currentSiteId: string | null;
  environment: Record<string, string | undefined>;
  taskLifecycleStore: TaskLifecycleStore | null;
};

export function checkCanonicalTaskLifecycleDispatch(
  state: TaskLifecycleDispatchGateState,
  input: {
    sourceRef: JsonRecord;
    constraints: JsonRecord;
    workflow: JsonRecord;
  },
): JsonRecord {
  const taskNumberValue = input.sourceRef.task_number;
  if (typeof taskNumberValue !== 'number' || !Number.isInteger(taskNumberValue)) throw new Error('task_lifecycle_source_ref_requires_task_number');
  const taskNumber = taskNumberValue;

  const policy = resolveEffectiveTaskExecutabilityPolicy(state.siteRoot);
  const workflowName = firstString(input.workflow.template_id, input.workflow.strategy, input.workflow.template) ?? 'implement';
  const fixedAssessmentWorkflow = isFixedAssessmentWorkflow(input.workflow);
  const baseEnvironment = assembleDeclaredEnvironment(state.siteRoot, state.environment);
  const policyProjection = {
    schema: 'narada.task_executability.dispatch_gate.v1',
    source_task_ref: input.sourceRef,
    task_number: taskNumber,
    task_id: null,
    workflow: workflowName,
    enforcement: policy.enforcement,
    effective_policy: policy,
    policy_provenance: policy.provenance,
  };

  if (fixedAssessmentWorkflow) {
    return {
      ...policyProjection,
      decision: 'allow',
      basis: 'assessment_workflow_exempt',
      diagnostic: { code: 'fixed_read_only_assessment_workflow' },
      assessment_id: null,
      task_spec_digest: null,
      environment_digest: null,
      dispatch_fingerprint: null,
      override_consumed: false,
    };
  }

  if (policy.enforcement === 'off') {
    return {
      ...policyProjection,
      decision: 'allow',
      basis: 'policy_off',
      diagnostic: { code: 'task_executability_policy_off' },
      assessment_id: null,
      task_spec_digest: null,
      environment_digest: null,
      dispatch_fingerprint: null,
      override_consumed: false,
    };
  }

  const store = state.taskLifecycleStore ?? openTaskLifecycleStore(state.siteRoot);
  state.taskLifecycleStore = store;
  const lifecycle = store.getLifecycleByNumber(taskNumber);
  if (!lifecycle) return unavailable(policyProjection, 'task_lifecycle_task_not_found', policy.enforcement);
  const sourceTaskId = firstString(input.sourceRef.task_id);
  if (sourceTaskId && sourceTaskId !== lifecycle.task_id) {
    return unavailable(policyProjection, 'task_lifecycle_source_task_id_mismatch', policy.enforcement, {
      source_task_id: sourceTaskId,
      canonical_task_id: lifecycle.task_id,
    });
  }
  const spec = store.getTaskSpec(lifecycle.task_id);
  if (!spec) return unavailable(policyProjection, 'task_lifecycle_task_spec_not_found', policy.enforcement, { task_id: lifecycle.task_id });

  const digestableSpec = {
    title: spec.title,
    goal: spec.goal_markdown ?? null,
    context: spec.context_markdown ?? null,
    required_work: spec.required_work_markdown ?? null,
    non_goals: spec.non_goals_markdown ?? null,
    acceptance_criteria: parseJsonStringArray(spec.acceptance_criteria_json),
    dependencies: parseJsonNumberArray(spec.dependencies_json),
  };
  const taskDigest = taskSpecDigest(digestableSpec);
  const environment = {
    ...baseEnvironment,
    declared_tools: stringList(input.constraints.required_mcp_tools),
    declared_authority: declaredAuthority(input.constraints),
  };
  const environmentDigest = declaredEnvironmentDigest(environment);
  const dispatchFingerprint = computeDispatchFingerprint({
    taskId: lifecycle.task_id,
    taskSpecDigest: taskDigest,
    environmentDigest,
    workflow: workflowName,
    siteId: state.currentSiteId ?? baseEnvironment.site_id,
  });
  const dispatch = checkTaskExecutabilityDispatch({
    store,
    taskId: lifecycle.task_id,
    dispatchFingerprint,
    currentSpecDigest: taskDigest,
    currentEnvDigest: environmentDigest,
  });
  const assessment = dispatch.assessment;
  const assessmentSpecMatches = assessment?.task_spec_digest === taskDigest;
  const assessmentEnvironmentMatches = assessment?.environment_digest === environmentDigest;
  const diagnostic = dispatch.executable
    ? null
    : !assessment
      ? { code: 'assessment_missing_or_pending', reason: 'No current assessment is available.' }
      : !assessmentSpecMatches || !assessmentEnvironmentMatches
        ? { code: 'assessment_spec_or_environment_mismatch', reason: 'The assessed task or dispatch environment is not current.' }
        : { code: 'assessment_not_executable', reason: `Assessment verdict is ${assessment.verdict}.` };
  const gate = {
    ...policyProjection,
    task_id: lifecycle.task_id,
    decision: dispatch.executable ? 'allow' : policy.enforcement === 'strict' ? 'refuse' : 'warn',
    basis: dispatch.executable ? dispatch.basis : 'none',
    diagnostic,
    assessment_id: assessment?.assessment_id ?? null,
    assessment_verdict: assessment?.verdict ?? null,
    assessment_spec_matches: assessmentSpecMatches,
    assessment_environment_matches: assessmentEnvironmentMatches,
    task_spec_digest: taskDigest,
    environment_digest: environmentDigest,
    dispatch_fingerprint: dispatchFingerprint,
    override_consumed: dispatch.override_consumed ?? false,
  };
  return gate;
}

function unavailable(policy: JsonRecord, code: string, enforcement: string, details: JsonRecord = {}): JsonRecord {
  return {
    ...policy,
    decision: enforcement === 'strict' ? 'refuse' : 'warn',
    basis: 'authority_unavailable',
    diagnostic: { code, ...details },
    assessment_id: null,
    task_spec_digest: null,
    environment_digest: null,
    dispatch_fingerprint: null,
    override_consumed: false,
  };
}

function isFixedAssessmentWorkflow(workflow: JsonRecord): boolean {
  const expected = taskExecutabilityAssessmentTemplate();
  const bounds = rec(workflow.bounds);
  const expectedBounds = rec(expected.bounds);
  const resultPolicy = rec(workflow.result_policy);
  const expectedResultPolicy = rec(expected.result_policy);
  const steps = records(workflow.steps);
  const step = steps[0] ?? {};
  const expectedStep = records(expected.steps)[0] ?? {};
  const constraints = rec(step.constraints);
  const expectedConstraints = rec(expectedStep.constraints);
  return workflow.template_id === TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID
    && workflow.strategy === TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID
    && workflow.profile_version === TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION
    && bounds.authority === expectedBounds.authority
    && bounds.cognition === expectedBounds.cognition
    && bounds.runtime === expectedBounds.runtime
    && JSON.stringify(bounds.write_set ?? null) === JSON.stringify(expectedBounds.write_set ?? null)
    && JSON.stringify(resultPolicy) === JSON.stringify(expectedResultPolicy)
    && steps.length === 1
    && step.id === expectedStep.id
    && step.kind === expectedStep.kind
    && step.profile === TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION
    && JSON.stringify(step.write_set ?? null) === JSON.stringify(expectedStep.write_set ?? null)
    && step.output_schema && rec(step.output_schema).name === TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID
    && constraints.authority === expectedConstraints.authority
    && constraints.cognition === expectedConstraints.cognition
    && constraints.runtime === expectedConstraints.runtime
    && constraints.max_run_ms === expectedConstraints.max_run_ms
    && constraints.max_retries === expectedConstraints.max_retries
    && constraints.resumable === expectedConstraints.resumable
    && JSON.stringify(constraints.required_mcp_tools ?? null) === JSON.stringify(expectedConstraints.required_mcp_tools ?? null)
    && JSON.stringify(constraints.preflight_paths ?? null) === JSON.stringify(expectedConstraints.preflight_paths ?? null);
}

function declaredAuthority(constraints: JsonRecord): string[] {
  const values = new Set<string>();
  const authority = constraints.authority;
  if (typeof authority === 'string') values.add(authority);
  else if (Array.isArray(authority)) stringList(authority).forEach((value) => values.add(value));
  else if (authority && typeof authority === 'object') {
    Object.entries(authority as JsonRecord).forEach(([key, value]) => {
      if (value === true) values.add(key);
      else if (typeof value === 'string' || typeof value === 'number') values.add(`${key}:${value}`);
    });
  }
  records(constraints.preflight_paths).forEach((path) => {
    const access = firstString(path.access);
    if (access) values.add(access);
  });
  return [...values].sort();
}

function parseJsonStringArray(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonNumberArray(json: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === 'number') : [];
  } catch {
    return [];
  }
}

function rec(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(rec).filter((item) => Object.keys(item).length > 0) : [];
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const single = firstString(value);
  return single ? [single] : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}
