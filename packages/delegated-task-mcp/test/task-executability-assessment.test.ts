import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION,
  TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
  TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID,
  taskExecutabilityAssessmentIdempotencyKey,
  taskExecutabilityAssessmentTemplate,
  taskExecutabilityAssessmentOutputSchema,
  validateTaskExecutabilityAssessment,
} from '../src/task-executability-assessment.js';
import { createServerState, handleRequest } from '../src/main.js';

type JsonRecord = Record<string, any>;

const root = mkdtempSync(join(tmpdir(), 'delegated-task-executability-assessment-'));

function fixture(overrides: JsonRecord = {}): JsonRecord {
  return {
    schema: TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
    version: 1,
    dimensions: [{ id: 'scope', status: 'clear' }],
    first_actions: [{ id: 'inspect', order: 1 }],
    reference_resolutions: [{ reference: 'src/main.ts', status: 'resolved' }],
    acceptance_mappings: [{ criterion: 'bounded', evidence: 'read-only worker' }],
    required_decisions: [],
    findings: [],
    evaluator_provenance: {
      runtime: 'narada-agent-runtime-server',
      provider: 'test',
      model: 'test-low',
      cognition: 'low',
      profile_version: TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION,
    },
    ...overrides,
  };
}

async function callTool(state: ReturnType<typeof createServerState>, name: string, args: JsonRecord) {
  return await handleRequest({
    jsonrpc: '2.0',
    id: `${name}-${Date.now()}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  }, state);
}

try {
  const template = taskExecutabilityAssessmentTemplate();
  assert.equal(template.template_id, TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID);
  assert.deepEqual(template.bounds, {
    authority: 'read',
    cognition: 'low',
    runtime: 'narada-agent-runtime-server',
    max_worker_runs: 1,
    max_run_ms: 120000,
    max_retries: 0,
    max_result_items: 32,
    max_events: 32,
    write_set: [],
  });
  assert.deepEqual((template.steps as JsonRecord[])[0].constraints.required_mcp_tools, []);
  assert.deepEqual(template.result_policy, {
    expose_worker_refs: true,
    compact_completed_worker_refs: true,
    max_events: 32,
    max_worker_refs: 1,
    max_result_items: 32,
  });
  assert.deepEqual(taskExecutabilityAssessmentOutputSchema().required, [
    'dimensions',
    'first_actions',
    'reference_resolutions',
    'acceptance_mappings',
    'required_decisions',
    'findings',
    'evaluator_provenance',
  ]);

  const idempotencyInput = { request_id: 'request-1', task_digest: 'task-a', environment_digest: 'env-a', profile_version: TASK_EXECUTABILITY_ASSESSMENT_PROFILE_VERSION };
  assert.equal(taskExecutabilityAssessmentIdempotencyKey(idempotencyInput), taskExecutabilityAssessmentIdempotencyKey(idempotencyInput));
  assert.notEqual(taskExecutabilityAssessmentIdempotencyKey(idempotencyInput), taskExecutabilityAssessmentIdempotencyKey({ ...idempotencyInput, environment_digest: 'env-b' }));

  const accepted = validateTaskExecutabilityAssessment({ [TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID]: fixture() }, fixture().evaluator_provenance);
  assert.equal(accepted.status, 'accepted');
  assert.equal(validateTaskExecutabilityAssessment('prose only').status, 'rejected');
  assert.equal(validateTaskExecutabilityAssessment({ ...fixture(), findings: undefined }).status, 'rejected');
  assert.equal(validateTaskExecutabilityAssessment(fixture({ evaluator_provenance: { ...fixture().evaluator_provenance, cognition: 'medium' } })).status, 'rejected');
  assert.equal(validateTaskExecutabilityAssessment(fixture({ required_decisions: [{ id: 'provider-choice', status: 'ambiguous' }], findings: [{ kind: 'missing_capability', status: 'open' }] })).status, 'accepted');

  let workerCalls = 0;
  const state = createServerState({
    siteRoot: root,
    taskRoot: root,
    allowedRoots: [root],
    workerTool: async (_name: string, args: JsonRecord) => {
      workerCalls += 1;
      const instruction = String(args.intent?.instruction ?? '');
      return {
        schema: 'narada.worker.run.v1',
        status: 'completed',
        run_id: `assessment-run-${workerCalls}`,
        runtime: 'narada-agent-runtime-server',
        provider: 'test',
        resolved_worker_config: {
          runtime: 'narada-agent-runtime-server',
          provider: 'test',
          model: 'test-low',
          cognition: 'low',
          max_run_ms: 120000,
        },
        summary: instruction.includes('prose-only') ? 'prose-only result' : 'structured assessment result',
        structured_outputs: instruction.includes('prose-only') ? {} : { [TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID]: fixture() },
        changed_files: [],
        target_state_changed: false,
        verification: [],
      };
    },
    policy: { allowed_workflow_kinds: ['worker', 'research', 'review', 'repair', 'verify', 'gate', 'join', 'note'] },
  });

  const common = {
    constraints: { authority: 'read', cwd: root, site_root: root },
    execution_binding: { workspace_root: root, site_root: root, executor_kind: 'delegated_task', correlation_key: 'assessment-run' },
    workflow: { template_id: TASK_EXECUTABILITY_ASSESSMENT_TEMPLATE_ID },
    execution: { start: true, wait_for_completion: false },
  };
  const validRun = await callTool(state, 'delegated_task_run', { ...common, request_id: 'assessment-request-valid', objective: 'Assess a clear task.' });
  assert.equal(validRun.error, undefined, JSON.stringify(validRun));
  const validView = validRun.result?.structuredContent as JsonRecord;
  assert.equal(validView.task_status, 'completed');
  assert.equal(validView.worker_refs[0].output_schema_validation.status, 'passed');
  assert.equal(validView.worker_refs[0].output.resolved_worker_config.max_run_ms, 120000);

  const proseRun = await callTool(state, 'delegated_task_run', { ...common, request_id: 'assessment-request-prose', objective: 'Reject prose-only output.' });
  const proseView = proseRun.result?.structuredContent as JsonRecord;
  assert.equal(proseView.task_status, 'failed');
  assert.equal(proseView.worker_refs[0].output_schema_validation.status, 'failed');

  const missingRequest = await callTool(state, 'delegated_task_validate', { objective: 'Assessment without stable request identity.', constraints: common.constraints, workflow: common.workflow });
  const missingRequestView = missingRequest.result?.structuredContent as JsonRecord;
  assert.equal(missingRequestView.status, 'rejected');
  assert.equal(missingRequestView.diagnostics.some((item: JsonRecord) => item.code === 'task_executability_assessment_requires_request_id'), true);

  const templateStep = (taskExecutabilityAssessmentTemplate().steps as JsonRecord[])[0];
  const overBound = await callTool(state, 'delegated_task_validate', {
    request_id: 'assessment-request-over-bound',
    objective: 'Assessment with an unsafe timeout.',
    constraints: common.constraints,
    workflow: { steps: [{ ...templateStep, constraints: { ...templateStep.constraints, max_run_ms: 120001 } }] },
  });
  const overBoundView = overBound.result?.structuredContent as JsonRecord;
  assert.equal(overBoundView.status, 'rejected');
  assert.equal(overBoundView.diagnostics.some((item: JsonRecord) => item.code === 'task_executability_assessment_max_run_ms_invalid'), true);

  console.log('task executability assessment tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
