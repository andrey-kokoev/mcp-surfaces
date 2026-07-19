import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskLifecycleStore } from '@narada2/task-governance-core/task-lifecycle-store';
import { createTaskLifecycleExecutabilityHandlers } from '../src/task-lifecycle/task-lifecycle-executability-handlers.js';

function stringField(args: Record<string, unknown>, field: string): string | undefined {
  return typeof args?.[field] === 'string' ? (args[field] as string) : undefined;
}

function numberField(args: Record<string, unknown>, field: string): number | undefined {
  return typeof args?.[field] === 'number' ? (args[field] as number) : undefined;
}

function jsonToolResult(value: unknown, isError = false) {
  return { structuredContent: value, isError };
}

function makeStore(siteRoot: string) {
  mkdirSync(join(siteRoot, '.ai'), { recursive: true });
  return openTaskLifecycleStore(siteRoot);
}

function seedTask(store: ReturnType<typeof makeStore>, taskNumber: number, title: string) {
  const now = new Date().toISOString();
  const taskId = `task-${taskNumber}`;
  store.db.prepare(`
    INSERT INTO task_lifecycle (task_id, task_number, status, governed_by, closed_at, closed_by, reopened_at, reopened_by, continuation_packet_json, updated_at)
    VALUES (?, ?, 'opened', NULL, NULL, NULL, NULL, NULL, NULL, ?)
  `).run(taskId, taskNumber, now);
  store.db.prepare(`
    INSERT INTO task_specs (task_id, task_number, title, chapter_markdown, goal_markdown, context_markdown, required_work_markdown, non_goals_markdown, acceptance_criteria_json, dependencies_json, tags_json, updated_at)
    VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?)
  `).run(taskId, taskNumber, title, `Goal: ${title}`, `Required: ${title}`, JSON.stringify(['criterion']), '[]', '[]', now);
  return taskId;
}

function makeHandlers(store: ReturnType<typeof makeStore>, siteRoot: string) {
  let identity: string | null = null;
  return createTaskLifecycleExecutabilityHandlers({
    store,
    siteRoot,
    jsonToolResult,
    stringField,
    numberField,
    enforceSessionIdentity: (agentId: string) => {
      if (!identity) identity = agentId;
      if (agentId !== identity) throw new Error('session_identity_mismatch');
    },
  });
}

const siteRoot = mkdtempSync(join(process.cwd(), '.tmp-tests', 'task-exec-test-'));
let store: ReturnType<typeof makeStore>;

try {
  store = makeStore(siteRoot);
  const handlers = makeHandlers(store, siteRoot);

  // 1. Request enqueues a new executability request.
  const taskId = seedTask(store, 2224, 'Task executability surface test');
  const requestResult = await handlers.task_lifecycle_executability_request({ task_number: 2224, agent_id: 'operator' });
  assert.equal(requestResult.structuredContent.schema, 'narada.task_executability.request.v0');
  assert.equal(requestResult.structuredContent.status, 'enqueued');
  assert.equal(requestResult.structuredContent.task_number, 2224);
  assert.equal(requestResult.structuredContent.task_id, taskId);
  assert.equal(typeof requestResult.structuredContent.request_id, 'string');
  const requestId = requestResult.structuredContent.request_id as string;

  // 2. Idempotent re-request returns existing.
  const requestAgain = await handlers.task_lifecycle_executability_request({ task_number: 2224, agent_id: 'operator' });
  assert.equal(requestAgain.structuredContent.status, 'existing');
  assert.equal(requestAgain.structuredContent.request_id, requestId);

  // 3. Status reflects pending/stale posture before assessment.
  const statusResult = await handlers.task_lifecycle_executability_status({ task_number: 2224 });
  assert.equal(statusResult.structuredContent.schema, 'narada.task_executability.status.v0');
  assert.equal(statusResult.structuredContent.executable, false);
  assert.equal(statusResult.structuredContent.currency, 'stale');
  assert.equal(statusResult.structuredContent.verdict, null);

  // 4. Lease next returns the pending request.
  const leaseResult = await handlers.task_lifecycle_executability_requests_next({ consumer_id: 'shoshin-evaluator-1' });
  assert.equal(leaseResult.structuredContent.schema, 'narada.task_executability.requests_next.v0');
  assert.equal(leaseResult.structuredContent.status, 'leased');
  assert.equal(leaseResult.structuredContent.leased_count, 1);
  assert.equal(leaseResult.structuredContent.leased[0].request_id, requestId);
  assert.equal(leaseResult.structuredContent.leased[0].task_number, 2224);

  // 5. Complete admits an assessment and marks the request completed.
  const completeResult = await handlers.task_lifecycle_executability_complete({
    request_id: requestId,
    assessment: {
      request_id: requestId,
      task_id: taskId,
      task_number: 2224,
      task_spec_digest: requestResult.structuredContent.task_spec_digest,
      environment_digest: requestResult.structuredContent.environment_digest,
      verdict: 'executable',
      findings: [],
      evaluator: {
        profile: 'shoshin-v1',
        profile_version: '1.0.0',
        cognition: 'low',
        provider: 'test-provider',
        model: 'test-model',
      },
      created_at: new Date().toISOString(),
    },
  });
  assert.equal(completeResult.structuredContent.schema, 'narada.task_executability.complete.v0');
  if (completeResult.structuredContent.status !== 'completed') {
    console.error('complete failed:', completeResult.structuredContent.reason);
  }
  assert.equal(completeResult.structuredContent.status, 'completed');
  assert.equal(completeResult.structuredContent.verdict, 'executable');
  assert.equal(completeResult.structuredContent.task_number, 2224);

  // 6. Status now reflects executable/current posture.
  const statusAfter = await handlers.task_lifecycle_executability_status({ task_number: 2224 });
  assert.equal(statusAfter.structuredContent.executable, true);
  assert.equal(statusAfter.structuredContent.currency, 'current');
  assert.equal(statusAfter.structuredContent.verdict, 'executable');

  // 7. Dispatch check allows execution based on the current assessment.
  const dispatchResult = await handlers.task_lifecycle_executability_dispatch_check({ task_number: 2224 });
  assert.equal(dispatchResult.structuredContent.executable, true);
  assert.equal(dispatchResult.structuredContent.basis, 'assessment');

  // 8. Re-leasing returns empty because request is completed.
  const leaseEmpty = await handlers.task_lifecycle_executability_requests_next({ consumer_id: 'shoshin-evaluator-2' });
  assert.equal(leaseEmpty.structuredContent.status, 'empty');
  assert.equal(leaseEmpty.structuredContent.leased_count, 0);

  console.log('task executability handler tests passed');
} finally {
  try { (store as { close?: () => void } | undefined)?.close?.(); } catch { /* ignore */ }
  try { rmSync(siteRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}
