import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import {
  assembleDeclaredEnvironment,
  computeDispatchFingerprint,
  createExecutabilityOverride,
  declaredEnvironmentDigest,
  enqueueTaskExecutabilityRequest,
  taskSpecDigest,
} from '@narada2/task-governance-core/task-executability-service';
import { createServerState, handleRequest } from '../src/main.js';
import { taskExecutabilityAssessmentTemplate } from '../src/task-executability-assessment.js';

type JsonRecord = Record<string, any>;

const root = mkdtempSync(join(tmpdir(), 'delegated-task-executability-dispatch-'));
const siteControl = join(root, '.ai');
mkdirSync(siteControl, { recursive: true });
const policyPath = join(siteControl, 'task-executability-policy.json');
const store = openTaskLifecycleStore(root);

const taskSpec = (taskNumber: number) => ({
  task_id: `task-${taskNumber}`,
  task_number: taskNumber,
  title: `Dispatch test task ${taskNumber}`,
  goal_markdown: 'Exercise canonical dispatch enforcement.',
  context_markdown: null,
  required_work_markdown: 'Run the bounded dispatch test.',
  non_goals_markdown: 'Do not invoke external systems.',
  acceptance_criteria_json: '["dispatch is governed"]',
  dependencies_json: '[]',
  updated_at: new Date().toISOString(),
});

function seedTask(taskNumber: number): ReturnType<typeof taskSpec> {
  const spec = taskSpec(taskNumber);
  store.upsertLifecycle({
    task_id: spec.task_id,
    task_number: taskNumber,
    status: 'opened',
    governed_by: null,
    closed_at: null,
    closed_by: null,
    reopened_at: null,
    reopened_by: null,
    continuation_packet_json: null,
    updated_at: spec.updated_at,
  });
  store.upsertTaskSpec(spec);
  return spec;
}

function seedExecutableAssessment(taskNumber: number): JsonRecord {
  const spec = seedTask(taskNumber);
  const base = assembleDeclaredEnvironment(root);
  const environment = { ...base, declared_tools: [], declared_authority: ['read'] };
  const digestable = {
    title: spec.title,
    goal: spec.goal_markdown,
    context: spec.context_markdown,
    required_work: spec.required_work_markdown,
    non_goals: spec.non_goals_markdown,
    acceptance_criteria: ['dispatch is governed'],
    dependencies: [],
  };
  const taskDigest = taskSpecDigest(digestable);
  const environmentDigest = declaredEnvironmentDigest(environment);
  const request = enqueueTaskExecutabilityRequest({
    store,
    siteRoot: root,
    taskId: spec.task_id,
    taskNumber,
    spec: digestable,
    environment,
  });
  store.upsertExecutabilityAssessment({
    assessment_id: `assessment-${taskNumber}`,
    request_id: request.request_id,
    task_id: spec.task_id,
    task_number: taskNumber,
    task_spec_digest: taskDigest,
    environment_digest: environmentDigest,
    verdict: 'executable',
    findings_json: '[]',
    evaluator_json: '{}',
    created_at: new Date().toISOString(),
  });
  store.completeExecutabilityRequest(request.request_id, `assessment-${taskNumber}`);
  return { spec, taskDigest, environmentDigest, environment };
}

function writePolicy(enforcement: 'off' | 'warn' | 'strict'): void {
  writeFileSync(policyPath, JSON.stringify({ schema: 'narada.task_executability_policy.v1', enforcement }), 'utf8');
}

function runArgs(taskNumber: number, id: string, overrides: JsonRecord = {}): JsonRecord {
  return {
    objective: `Dispatch task ${taskNumber}`,
    request_id: id,
    source_task_ref: { kind: 'task_lifecycle', task_number: taskNumber },
    constraints: { authority: 'read', cwd: root, site_root: root, ...overrides.constraints },
    workflow: overrides.workflow ?? { steps: [{ id: 'note', kind: 'note' }] },
    execution: { start: false },
  };
}

async function call(state: ReturnType<typeof createServerState>, args: JsonRecord): Promise<JsonRecord> {
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: `dispatch-${Date.now()}-${Math.random()}`,
    method: 'tools/call',
    params: { name: 'delegated_task_run', arguments: args },
  }, state);
  if (response?.error) return { error: response.error };
  return (response?.result?.structuredContent as JsonRecord) ?? {};
}

try {
  writePolicy('strict');
  const state = createServerState({ siteRoot: root, taskRoot: root, allowedRoots: [root], workerTool: async () => ({ status: 'completed' }) });
  state.taskLifecycleStore = store;

  const executable = seedExecutableAssessment(1);
  const admitted = await call(state, runArgs(1, 'dispatch-assessment'));
  assert.equal(admitted.task_executability_dispatch.decision, 'allow');
  assert.equal(admitted.task_executability_dispatch.basis, 'assessment');
  assert.equal(admitted.task_executability_dispatch.assessment_id, 'assessment-1');

  seedTask(2);
  const task2Environment = { ...assembleDeclaredEnvironment(root), declared_tools: [], declared_authority: ['read'] };
  const task2Fingerprint = computeDispatchFingerprint({
    taskId: 'task-2',
    taskSpecDigest: taskSpecDigest({ title: 'Dispatch test task 2', goal: 'Exercise canonical dispatch enforcement.', context: null, required_work: 'Run the bounded dispatch test.', non_goals: 'Do not invoke external systems.', acceptance_criteria: ['dispatch is governed'], dependencies: [] }),
    environmentDigest: declaredEnvironmentDigest(task2Environment),
    workflow: 'implement',
    siteId: task2Environment.site_id,
  });
  const task2Digest = taskSpecDigest({ title: 'Dispatch test task 2', goal: 'Exercise canonical dispatch enforcement.', context: null, required_work: 'Run the bounded dispatch test.', non_goals: 'Do not invoke external systems.', acceptance_criteria: ['dispatch is governed'], dependencies: [] });
  createExecutabilityOverride({
    store,
    taskId: 'task-2',
    taskSpecDigest: task2Digest,
    dispatchFingerprint: task2Fingerprint,
    actor: 'operator',
    reason: 'Operator authorized one bounded dispatch.',
    authorityBasis: { kind: 'operator_directive', summary: 'Test directive.' },
  });
  const overridden = await call(state, runArgs(2, 'dispatch-override'));
  assert.equal(overridden.task_executability_dispatch.decision, 'allow');
  assert.equal(overridden.task_executability_dispatch.basis, 'override');
  assert.equal(overridden.task_executability_dispatch.override_consumed, true);
  const consumed = await call(state, runArgs(2, 'dispatch-override-replay'));
  assert.equal(consumed.error.data.code, 'task_lifecycle_executability_dispatch_refused');

  seedExecutableAssessment(3);
  const changedEnvironment = await call(state, runArgs(3, 'dispatch-changed-environment', { constraints: { authority: 'write' } }));
  assert.equal(changedEnvironment.error.data.code, 'task_lifecycle_executability_dispatch_refused');

  writePolicy('warn');
  seedTask(4);
  const warned = await call(state, runArgs(4, 'dispatch-warn'));
  assert.equal(warned.task_executability_dispatch.decision, 'warn');
  assert.equal(warned.task_executability_dispatch.diagnostic.code, 'assessment_missing_or_pending');

  writePolicy('off');
  seedTask(5);
  const off = await call(state, runArgs(5, 'dispatch-off'));
  assert.equal(off.task_executability_dispatch.decision, 'allow');
  assert.equal(off.task_executability_dispatch.basis, 'policy_off');

  writePolicy('strict');
  const fixedAssessment = await call(state, runArgs(999, 'dispatch-assessment-worker', { workflow: { template_id: taskExecutabilityAssessmentTemplate().template_id } }));
  assert.equal(fixedAssessment.task_executability_dispatch.basis, 'assessment_workflow_exempt');

  const profileOnly = await call(state, runArgs(999, 'dispatch-profile-only', {
    workflow: { steps: [{ id: 'assessment', kind: 'worker', profile: 'shoshin-task-executability-v1' }] },
  }));
  assert.equal(profileOnly.error.data.code, 'task_lifecycle_executability_dispatch_refused');

  console.log('task executability dispatch tests passed');
} finally {
  store.db.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
