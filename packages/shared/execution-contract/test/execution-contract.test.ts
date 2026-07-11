import assert from 'node:assert/strict';
import { executionRequestFingerprint, normalizeExecutionBinding } from '../src/main.js';

const binding = normalizeExecutionBinding({
  workspace_root: 'D:\\code\\mcp-surfaces',
  executor_kind: 'delegated_task',
  correlation_key: 'request-1',
});
assert.equal(binding.workspace_root.toLowerCase(), 'd:\\code\\mcp-surfaces');
assert.equal(executionRequestFingerprint({ b: 2, a: 1 }), executionRequestFingerprint({ a: 1, b: 2 }));
assert.throws(() => normalizeExecutionBinding({ executor_kind: 'delegated_task', correlation_key: 'x' }), /workspace_root_required/);
assert.throws(() => normalizeExecutionBinding({ workspace_root: 'D:\\code\\mcp-surfaces', executor_kind: 'delegated_task', correlation_key: 'x', unexpected: true }), /unknown_fields/);
assert.throws(() => normalizeExecutionBinding({ workspace_root: 42, executor_kind: 'delegated_task', correlation_key: 'x' }), /workspace_root_must_be_string/);
console.log('execution-contract tests passed');
