import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerState, handleRequest } from '../src/main.js';

type JsonRecord = Record<string, unknown>;

const root = mkdtempSync(join(tmpdir(), 'delegated-task-mcp-boundary-'));

try {
  const state = createServerState({
    siteRoot: root,
    taskRoot: root,
    allowedRoots: [root],
    workerTool: async () => ({ status: 'completed' }),
    policy: { allowed_workflow_kinds: ['worker', 'review', 'repair', 'verify', 'research', 'gate', 'join', 'note'] },
  });
  const binding = {
    workspace_root: root,
    executor_kind: 'delegated_task',
    correlation_key: 'boundary-idempotency-1',
  };
  const first = await call(state, {
    objective: 'Create one durable delegated task.',
    idempotency_key: 'boundary-idempotency-1',
    execution_binding: binding,
    execution: { start: false },
    workflow: { steps: [{ id: 'note', kind: 'note' }] },
  });
  assert.equal(first.status, 'accepted_for_execution');
  assert.equal(first.created, true);
  assert.equal((first.execution_binding as JsonRecord).workspace_root, root);

  const taskPath = String(first.task_path);
  const persisted = JSON.parse(readFileSync(taskPath, 'utf8')) as JsonRecord;
  assert.equal(persisted.request_fingerprint, first.request_fingerprint);
  assert.deepEqual(persisted.execution_binding, first.execution_binding);

  const retry = await call(state, {
    objective: 'Create one durable delegated task.',
    idempotency_key: 'boundary-idempotency-1',
    execution_binding: binding,
    execution: { start: false },
    workflow: { steps: [{ id: 'note', kind: 'note' }] },
  });
  assert.equal(retry.created, false);
  assert.equal(retry.task_id, first.task_id);

  const conflict = await call(state, {
    objective: 'A different request must not reuse the first key.',
    idempotency_key: 'boundary-idempotency-1',
    execution_binding: binding,
    execution: { start: false },
    workflow: { steps: [{ id: 'note', kind: 'note' }] },
  });
  assert.equal(conflict.error_code, 'delegated_task_idempotency_conflict');

  const dependent = await call(state, {
    objective: 'Wait for the first task before scheduling work.',
    idempotency_key: 'boundary-dependent-1',
    execution_binding: { ...binding, correlation_key: 'boundary-dependent-1' },
    depends_on_task_ids: [String(first.task_id)],
    workflow: { steps: [{ id: 'note', kind: 'note' }] },
  });
  assert.equal((dependent.external_dependency_status as JsonRecord).status, 'waiting');
  assert.equal((dependent.external_dependency_status as JsonRecord).blocking instanceof Array, true);

  const outsideBinding = await call(state, {
    objective: 'Reject a workspace outside the admitted execution roots.',
    idempotency_key: 'boundary-outside-root-1',
    execution_binding: { ...binding, workspace_root: join(root, '..'), correlation_key: 'boundary-outside-root-1' },
    execution: { start: false },
    workflow: { steps: [{ id: 'note', kind: 'note' }] },
  });
  assert.equal(outsideBinding.error_code, 'delegated_task_execution_binding_workspace_outside_allowed_roots');
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function call(state: ReturnType<typeof createServerState>, argumentsValue: JsonRecord): Promise<JsonRecord> {
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: `boundary-${Date.now()}-${Math.random()}`,
    method: 'tools/call',
    params: { name: 'delegated_task_run', arguments: argumentsValue },
  }, state);
  const result = response?.result as JsonRecord | undefined;
  return (result?.structuredContent as JsonRecord | undefined) ?? { error_code: String(response?.error?.message ?? 'missing_result') };
}

console.log('delegated execution boundary tests passed');
