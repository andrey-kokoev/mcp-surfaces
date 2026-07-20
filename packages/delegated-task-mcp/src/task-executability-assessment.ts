import { createHash } from 'node:crypto';

export const TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID = 'task_executability_assessment_v1';
export const TASK_EXECUTABILITY_ASSESSMENT_SCHEMA = 'narada.task.executability.assessment.v1';
export const TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION = 'shoshin-task-executability-v1';

type JsonRecord = Record<string, unknown>;

const arrayFields = [
  'dimensions',
  'first_actions',
  'reference_resolutions',
  'acceptance_mappings',
  'required_decisions',
  'findings',
] as const;

export type TaskExecutabilityAssessment = JsonRecord & {
  schema: typeof TASK_EXECUTABILITY_ASSESSMENT_SCHEMA;
  version: 1;
  dimensions: JsonRecord[];
  first_actions: JsonRecord[];
  reference_resolutions: JsonRecord[];
  acceptance_mappings: JsonRecord[];
  required_decisions: JsonRecord[];
  findings: JsonRecord[];
  evaluator_provenance: JsonRecord;
};

export type TaskExecutabilityAssessmentValidation =
  | { status: 'accepted'; assessment: TaskExecutabilityAssessment; diagnostics: [] }
  | { status: 'rejected'; assessment: null; diagnostics: JsonRecord[] };

export function taskExecutabilityAssessmentOutputSchema(): JsonRecord {
  return {
    schema: 'narada.delegated_task.output_schema.v1',
    name: TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID,
    version: 1,
    required: [...arrayFields, 'evaluator_provenance'],
    fields: {
      dimensions: 'array<object>',
      first_actions: 'array<object>',
      reference_resolutions: 'array<object>',
      acceptance_mappings: 'array<object>',
      required_decisions: 'array<object>',
      findings: 'array<object>',
      evaluator_provenance: 'object',
    },
    provenance_required: ['runtime', 'provider', 'model', 'cognition', 'profile_version'],
    rejection_rules: ['missing_required_field', 'prose_only', 'invalid_schema', 'invalid_provenance'],
  };
}

export function taskExecutabilityAssessmentTemplate(): JsonRecord {
  return {
    template_id: TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID,
    strategy: TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID,
    title: 'Bounded Shoshin task executability assessment',
    profile_version: TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION,
    purpose: 'Assess one canonical task snapshot without changing it.',
    idempotency: {
      schema: 'narada.task.executability.idempotency.v1',
      inputs: ['request_id', 'task_digest', 'environment_digest', 'profile_version'],
      formula: 'sha256(canonical_json({request_id, task_digest, environment_digest, profile_version}))',
    },
    bounds: {
      authority: 'read',
      cognition: 'low',
      runtime: 'narada-agent-runtime-server',
      max_worker_runs: 1,
      max_run_ms: 120000,
      max_retries: 0,
      max_result_items: 32,
      max_events: 32,
      write_set: [],
    },
    result_policy: {
      expose_worker_refs: true,
      compact_completed_worker_refs: true,
      max_events: 32,
      max_worker_refs: 1,
      max_result_items: 32,
    },
    output_schema: taskExecutabilityAssessmentOutputSchema(),
    milestones: [{ id: 'assessment', title: 'Assess canonical task snapshot', step_ids: ['assessment'] }],
    steps: [{
      id: 'assessment',
      kind: 'worker',
      profile: TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION,
      milestone_id: 'assessment',
      write_set: [],
      constraints: {
        authority: 'read',
        cognition: 'low',
        runtime: 'narada-agent-runtime-server',
        max_run_ms: 120000,
        max_retries: 0,
        max_concurrency: 1,
        wait_for_completion: false,
        resumable: false,
        required_mcp_tools: [],
        preflight_paths: [],
        overrides: { skip_git_repo_check: true },
      },
      output_schema: taskExecutabilityAssessmentOutputSchema(),
    }],
    worker_delegation_contract: {
      surface_id: 'worker-delegation',
      caller_sets_worker_constraints: true,
      worker_run_is_child_execution: true,
      required_worker_output_fields: ['summary', 'structured_outputs', 'verification', 'target_state_changed'],
      forbidden_authorities: ['write', 'command'],
      required_structured_output: TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID,
    },
  };
}

export function taskExecutabilityAssessmentIdempotencyKey(input: {
  request_id: string;
  task_digest: string;
  environment_digest: string;
  profile_version?: string;
}): string {
  const canonical = JSON.stringify({
    request_id: input.request_id,
    task_digest: input.task_digest,
    environment_digest: input.environment_digest,
    profile_version: input.profile_version ?? TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION,
  });
  return `task-executability:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function validateTaskExecutabilityAssessment(
  value: unknown,
  expected: { runtime?: string; provider?: string; model?: string; cognition?: string; profile_version?: string } = {},
): TaskExecutabilityAssessmentValidation {
  const candidate = record(value);
  const assessment = candidate ? record(candidate[TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID]) ?? candidate : null;
  const diagnostics: JsonRecord[] = [];
  if (!assessment) return rejected('prose_only', 'A structured assessment object is required.');
  if (assessment.schema !== TASK_EXECUTABILITY_ASSESSMENT_SCHEMA) diagnostics.push({ code: 'invalid_schema', expected: TASK_EXECUTABILITY_ASSESSMENT_SCHEMA, actual: assessment.schema ?? null });
  if (assessment.version !== 1) diagnostics.push({ code: 'invalid_version', expected: 1, actual: assessment.version ?? null });
  for (const field of arrayFields) {
    if (!Array.isArray(assessment[field])) diagnostics.push({ code: 'missing_required_field', field, expected: 'array' });
    else if ((field === 'dimensions' || field === 'first_actions' || field === 'acceptance_mappings') && assessment[field].length === 0) diagnostics.push({ code: 'incomplete_assessment', field, reason: 'must contain at least one item' });
  }
  const provenance = record(assessment.evaluator_provenance);
  if (!provenance) diagnostics.push({ code: 'invalid_provenance', reason: 'evaluator_provenance must be an object' });
  else {
    for (const field of ['runtime', 'provider', 'model', 'cognition', 'profile_version']) {
      if (typeof provenance[field] !== 'string' || !String(provenance[field]).trim()) diagnostics.push({ code: 'invalid_provenance', field, reason: 'non-empty string required' });
    }
    for (const [field, expectedValue] of Object.entries({ ...expected, cognition: expected.cognition ?? 'low' })) {
      if (expectedValue !== undefined && provenance[field] !== expectedValue) diagnostics.push({ code: 'provenance_mismatch', field, expected: expectedValue, actual: provenance[field] ?? null });
    }
  }
  if (diagnostics.length > 0) return { status: 'rejected', assessment: null, diagnostics };
  return { status: 'accepted', assessment: assessment as TaskExecutabilityAssessment, diagnostics: [] };
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function rejected(code: string, message: string): TaskExecutabilityAssessmentValidation {
  return { status: 'rejected', assessment: null, diagnostics: [{ code, message }] };
}
