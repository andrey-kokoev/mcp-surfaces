import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

const root = mkdtempSync(join(tmpdir(), 'delegated-task-mcp-behavior-'));
const workerCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const runStatuses = new Map<string, Record<string, unknown>>();

try {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export const ok = true;\n', 'utf8');
  writeFileSync(join(root, 'src', 'policy.ts'), 'export const policy = "review";\n', 'utf8');

  const state = createServerState({
    taskRoot: root,
    allowedRoots: [root],
    policy: { allowed_workflow_kinds: ['worker', 'review', 'repair', 'verify', 'research', 'gate', 'join', 'note'] },
    workerTool: async (name: string, args: Record<string, unknown>) => {
      workerCalls.push({ name, args });
      if (name === 'worker_run_status') {
        const runId = String(args.run_id);
        const status = runStatuses.get(runId);
        if (!status) throw new Error(`missing run status: ${runId}`);
        runStatuses.set(runId, { ...status, status: 'completed', summary: `${runId} completed after wait` });
        return runStatuses.get(runId)!;
      }

      const instruction = JSON.stringify(args);
      const runId = `run-test-${workerCalls.filter((call) => call.name === 'worker_run').length}`;
      const status = instruction.includes('async worker') ? 'running'
        : instruction.includes('fail once') && ![...runStatuses.values()].some((run) => String(run.summary).includes('fail once')) ? 'failed'
          : 'completed';
      const result = {
        schema: 'narada.worker.run.v1',
        status,
        run_id: runId,
        run_dir: join(root, 'worker-runs', runId),
        worker_session_id: null,
        confidence: 'complete',
        summary: instruction.includes('fail once') ? 'fail once recovered' : `${runId} ${status}`,
        acceptance_verdict: instruction.includes('explicit review failure') ? 'failed' : undefined,
        changed_files: ['src/main.ts'],
        verification_results: [{ tool: 'structured-command', command: 'pnpm test:delegated-task', status: 'passed' }],
        residual_risks: status === 'running' ? ['worker still running'] : [],
        observed_incoherencies: [],
      };
      runStatuses.set(runId, result);
      return result;
    },
  });

  const policy = await callTool(state, 'delegated_task_policy_inspect', {});
  const policyView = policy.result.structuredContent as Record<string, any>;
  assert.equal(policyView.status, 'ok');
  assert.equal(policyView.allowed_workflow_kinds.includes('review'), true);
  assert.equal(policyView.condition_language.includes('all(<expr>,<expr>)'), true);
  assert.equal(policyView.policy_schema, 'narada.delegated_task.policy.v1');

  const invalid = await callTool(state, 'delegated_task_validate', {
    objective: 'Invalid graph',
    workflow: {
      steps: [
        { id: 'a', kind: 'worker', depends_on: ['missing'], if: 'all(step:a:completed)' },
      ],
    },
    acceptance: { residual_risk_policy: 'invalid-policy' },
  });
  const invalidView = invalid.result.structuredContent as Record<string, any>;
  assert.equal(invalidView.status, 'rejected');
  assert.equal(invalidView.diagnostics.some((item: Record<string, unknown>) => item.code === 'unknown_dependency'), true);
  assert.equal(invalidView.diagnostics.some((item: Record<string, unknown>) => item.code === 'invalid_condition'), true);
  assert.equal(invalidView.diagnostics.some((item: Record<string, unknown>) => item.code === 'acceptance_residual_risk_policy_invalid'), true);

  const unknownShape = await callTool(state, 'delegated_task_validate', {
    objective: 'Unknown keys',
    constraints: { authority: 'read', cwd: root, surprise: true },
    acceptance: { required_files: ['src/main.ts'], surprise: true },
    result_policy: { max_worker_refs: 2, surprise: true },
  });
  const unknownShapeView = unknownShape.result.structuredContent as Record<string, any>;
  assert.equal(unknownShapeView.status, 'rejected');
  assert.equal(unknownShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'constraints_unknown_key'), true);
  assert.equal(unknownShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'acceptance_unknown_key'), true);
  assert.equal(unknownShapeView.diagnostics.some((item: Record<string, unknown>) => item.code === 'result_policy_unknown_key'), true);

  const preset = await callTool(state, 'delegated_task_validate', {
    objective: 'Preset graph',
    workflow: { strategy: 'implement_review_repair_verify' },
  });
  const presetView = preset.result.structuredContent as Record<string, any>;
  assert.equal(presetView.status, 'ok');
  assert.deepEqual(presetView.workflow_preview.steps.map((step: Record<string, unknown>) => step.id), ['implement', 'review', 'repair', 'verify']);

  const run = await callTool(state, 'delegated_task_run', {
    objective: 'Implement complete delegated task orchestration',
    idempotency_key: 'same-key',
    constraints: { authority: 'write', cwd: root, max_concurrency: 3 },
    workflow: {
      steps: [
        { id: 'implement-a', kind: 'worker', instruction: 'Implement part A' },
        { id: 'implement-b', kind: 'worker', instruction: 'Implement part B' },
        { id: 'review', kind: 'review', depends_on: ['implement-a', 'implement-b'], instruction: 'Review the implementation' },
        { id: 'join', kind: 'join', depends_on: ['implement-a', 'implement-b', 'review'] },
        { id: 'gate', kind: 'gate', depends_on: ['join'] },
        { id: 'note', kind: 'note', depends_on: ['gate'], instruction: 'Record final note' },
      ],
    },
    acceptance: {
      required_files: ['src/main.ts', { path: 'src/policy.ts', contains: 'review' }],
      required_tests: [{ command: 'pnpm test:delegated-task', status: 'passed' }],
      required_tools: [{ name: 'structured-command' }],
      forbidden_patterns: [{ pattern: 'forbidden-never' }],
      review_quorum: { min_passed: 1, max_failed: 0 },
      residual_risk_policy: 'none_allowed',
    },
    result_policy: { expose_worker_refs: false, max_events: 4, max_worker_refs: 2, max_result_items: 1, compact_completed_worker_refs: true },
    execution: { wait_for_completion: true, max_concurrency: 3 },
  });

  assert.equal(run.error, undefined);
  const runResult = run.result.structuredContent as Record<string, any>;
  assert.equal(runResult.status, 'accepted_for_execution');
  assert.equal(runResult.task_status, 'completed');
  assert.match(runResult.task_id, /^task_/);
  assert.ok(statSync(runResult.task_path).isFile());
  assert.match(readFileSync(runResult.task_path, 'utf8'), /"objective": "Implement complete delegated task orchestration"/);

  const repeat = await callTool(state, 'delegated_task_run', { idempotency_key: 'same-key' });
  assert.equal((repeat.result.structuredContent as Record<string, any>).task_id, runResult.task_id);

  const status = await callTool(state, 'delegated_task_status', { task_id: runResult.task_id });
  const statusResult = status.result.structuredContent as Record<string, any>;
  assert.equal(statusResult.task_status, 'completed');
  assert.equal(statusResult.step_counts.total, 6);
  assert.equal(statusResult.step_status_counts.completed, 5);
  assert.equal(statusResult.step_status_counts.noted, 1);
  assert.equal(statusResult.acceptance_verdict, 'passed');

  const result = await callTool(state, 'delegated_task_result', { task_id: runResult.task_id, include_diagnostics: true });
  const resultView = result.result.structuredContent as Record<string, any>;
  assert.equal(resultView.result.acceptance_verdict, 'passed');
  assert.deepEqual(resultView.result.worker_refs.map((ref: Record<string, unknown>) => ref.run_id), ['run-test-1', 'run-test-2']);
  assert.equal(resultView.result.worker_refs_truncated, true);
  assert.equal(Array.isArray(resultView.result.output_refs), true);
  assert.equal(resultView.result.output_refs.some((ref: Record<string, unknown>) => ref.name === 'worker_refs'), true);
  assert.deepEqual(resultView.result.changed_files, ['src/main.ts']);
  assert.equal(resultView.result.changed_files_count, 1);
  assert.equal(resultView.result.verification.length, 1);
  assert.equal(resultView.result.verification_count, 1);
  assert.equal(resultView.diagnostics.task_id, runResult.task_id);

  const compactResult = await callTool(state, 'delegated_task_result', { task_id: runResult.task_id });
  const compactResultView = compactResult.result.structuredContent as Record<string, any>;
  assert.equal(compactResultView.result.worker_refs, undefined);
  assert.equal(compactResultView.result.worker_ref_count, 3);
  assert.equal(compactResultView.result.worker_refs_redacted, true);

  const summary = await callTool(state, 'delegated_task_summary', { task_id: runResult.task_id });
  const summaryView = summary.result.structuredContent as Record<string, any>;
  assert.equal(summaryView.status, 'ok');
  assert.equal(summaryView.child_evidence.length, 3);
  assert.deepEqual(summaryView.changed_files, ['src/main.ts']);

  const failedReviewRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise explicit review failure',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'review', kind: 'review', instruction: 'explicit review failure' }] },
    acceptance: { review_quorum: { min_passed: 1, max_failed: 0 } },
    execution: { wait_for_completion: true },
  });
  const failedReviewView = failedReviewRun.result.structuredContent as Record<string, any>;
  assert.equal(failedReviewView.task_status, 'failed');

  const cappedEvents = await callTool(state, 'delegated_task_events', { task_id: runResult.task_id, limit: 10, offset: 0 });
  const cappedEventsView = cappedEvents.result.structuredContent as Record<string, any>;
  assert.equal(cappedEventsView.limit, 4);
  assert.equal(cappedEventsView.events.length, 4);
  assert.equal(cappedEventsView.compacted, true);
  assert.equal(cappedEventsView.event_counts_by_kind.task_created, 1);
  assert.equal(Object.values(cappedEventsView.event_summary_by_step).some((step: any) => step.event_counts_by_kind.step_completed === 1), true);

  const conditionalRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise rich conditions',
    constraints: { authority: 'read', cwd: root },
    workflow: {
      steps: [
        { id: 'base', kind: 'worker', instruction: 'Base work' },
        { id: 'conditional', kind: 'note', depends_on: ['base'], if: 'all(step:base:completed,not(result_has:absent-token))', instruction: 'Conditional note' },
      ],
    },
    execution: { wait_for_completion: true },
  });
  const conditionalView = conditionalRun.result.structuredContent as Record<string, any>;
  assert.equal(conditionalView.task_status, 'completed');
  const conditionalResult = await callTool(state, 'delegated_task_result', { task_id: conditionalView.task_id, include_diagnostics: true });
  const conditionalResultView = conditionalResult.result.structuredContent as Record<string, any>;
  assert.equal(conditionalResultView.result.step_states.conditional.status, 'noted');

  const listed = await callTool(state, 'delegated_tasks_list', { limit: 5 });
  const listedView = listed.result.structuredContent as Record<string, any>;
  assert.equal(listedView.tasks.some((task: Record<string, unknown>) => task.task_id === runResult.task_id), true);

  const beforeConcurrencyCalls = workerCalls.filter((call) => call.name === 'worker_run').length;
  const limitedRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise max concurrency',
    constraints: { authority: 'read', cwd: root, max_concurrency: 2 },
    workflow: {
      steps: [
        { id: 'a', kind: 'worker', instruction: 'async worker a' },
        { id: 'b', kind: 'worker', instruction: 'async worker b' },
        { id: 'c', kind: 'worker', instruction: 'async worker c' },
      ],
    },
  });
  const limitedView = limitedRun.result.structuredContent as Record<string, any>;
  assert.equal(limitedView.task_status, 'running');
  assert.equal(workerCalls.filter((call) => call.name === 'worker_run').length - beforeConcurrencyCalls, 2);
  const limitedEvents = await callTool(state, 'delegated_task_events', { task_id: limitedView.task_id, limit: 10 });
  const limitedEventsView = limitedEvents.result.structuredContent as Record<string, any>;
  assert.ok(limitedEventsView.last_meaningful_event_by_active_step.a);
  assert.ok(limitedEventsView.last_meaningful_event_by_active_step.b);
  const cancelled = await callTool(state, 'delegated_task_cancel', { task_id: limitedView.task_id, reason: 'caller stopped concurrency test' });
  assert.equal((cancelled.result.structuredContent as Record<string, any>).task_status, 'cancelled');
  const cancelledResult = await callTool(state, 'delegated_task_result', { task_id: limitedView.task_id, include_diagnostics: true });
  const cancelledResultView = cancelledResult.result.structuredContent as Record<string, any>;
  assert.equal(cancelledResultView.result.acceptance_verdict, 'cancelled');
  assert.equal(cancelledResultView.result.worker_refs.every((ref: Record<string, any>) => ref.cancellation.requested === true), true);

  const asyncRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise async wait',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'async', kind: 'worker', instruction: 'async worker' }] },
  });
  const asyncTask = asyncRun.result.structuredContent as Record<string, any>;
  assert.equal(asyncTask.task_status, 'running');
  const waited = await callTool(state, 'delegated_task_wait', { task_id: asyncTask.task_id, timeout_ms: 1000, poll_ms: 50 });
  const waitedView = waited.result.structuredContent as Record<string, any>;
  assert.equal(workerCalls.some((call) => call.name === 'worker_run_status'), true);
  assert.equal(waitedView.status, 'finished');
  assert.equal(waitedView.task_status, 'completed', JSON.stringify(waitedView));

  const retryRun = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise retry repair',
    constraints: { authority: 'write', cwd: root, max_retries: 1 },
    workflow: { steps: [{ id: 'repair', kind: 'repair', instruction: 'fail once then repair' }] },
    execution: { wait_for_completion: true, max_retries: 1 },
  });
  const retryView = retryRun.result.structuredContent as Record<string, any>;
  assert.equal(retryView.task_status, 'completed');
  const retryResult = await callTool(state, 'delegated_task_result', { task_id: retryView.task_id, include_diagnostics: true });
  const retryResultView = retryResult.result.structuredContent as Record<string, any>;
  assert.equal(retryResultView.result.step_states.repair.attempts, 2);

  const blocked = await callTool(state, 'delegated_task_run', {
    objective: 'Exercise blocked dependency',
    constraints: { authority: 'read', cwd: root },
    workflow: { steps: [{ id: 'downstream', kind: 'worker', depends_on: ['missing'], instruction: 'Should block' }] },
    execution: { wait_for_completion: true },
  });
  const blockedError = blocked.error as Record<string, any>;
  assert.equal(blockedError.data.code, 'delegated_task_validation_failed');

  const missing = await callTool(state, 'delegated_task_status', { task_id: 'task_missing' });
  const missingError = missing.error as Record<string, any>;
  assert.equal(missingError.data.code, 'delegated_task_not_found');
  assert.match(missingError.message, /delegated_task_not_found/);

  console.log('delegated-task-mcp behavior ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function callTool(state: ReturnType<typeof createServerState>, name: string, arguments_: Record<string, unknown>) {
  return await handleRequest({
    jsonrpc: '2.0',
    id: `${name}-${Date.now()}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: arguments_ },
  }, state);
}
