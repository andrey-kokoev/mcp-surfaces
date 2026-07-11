import assert from 'node:assert/strict';
import {
  assertTaskLifecycleHandlerCoverage,
  createTaskLifecycleHandlerRegistry,
  PAYLOAD_OUTPUT_TOOL_NAMES,
} from '../src/task-lifecycle/task-lifecycle-handler-registry.js';
import { isStoreRetrySafe, validateTaskCreatePayload } from '../src/kernel/tool-call-pipeline.js';

const domainTools = ['task_lifecycle_status', 'task_lifecycle_claim', 'task_lifecycle_close'];
const toolNames = [...domainTools, ...PAYLOAD_OUTPUT_TOOL_NAMES];
const payloadOutputHandlers = Object.fromEntries(PAYLOAD_OUTPUT_TOOL_NAMES.map((name) => [name, () => ({ status: 'ok' })]));
const handlers = createTaskLifecycleHandlerRegistry({
  toolNames,
  payloadOutputHandlers,
  domainDispatch: (name) => ({ status: 'domain', name }),
});

const coverage = assertTaskLifecycleHandlerCoverage({ toolNames, handlers });
assert.equal(coverage.status, 'ok');
assert.equal(coverage.tool_count, toolNames.length);
assert.equal(coverage.handler_count, toolNames.length);
assert.deepEqual(coverage.missing, []);
assert.deepEqual(handlers.get('task_lifecycle_status')({}), { status: 'domain', name: 'task_lifecycle_status' });
assert.deepEqual(handlers.get('mcp_payload_create')({}), { status: 'ok' });
assert.throws(() => validateTaskCreatePayload({}), /task_lifecycle_create_payload_empty_object_refused/);
assert.doesNotThrow(() => validateTaskCreatePayload({ title: 'Create a focused task' }));
assert.equal(isStoreRetrySafe({ canonicalName: 'task_lifecycle_claim', args: {}, toolDef: { annotations: { readOnlyHint: false, idempotentHint: false } } }), false);
assert.equal(isStoreRetrySafe({ canonicalName: 'task_lifecycle_claim', args: { idempotency_key: 'claim-1' }, toolDef: { annotations: { readOnlyHint: false, idempotentHint: false } } }), true);
assert.equal(isStoreRetrySafe({ canonicalName: 'task_lifecycle_status', args: {}, toolDef: { annotations: { readOnlyHint: true, idempotentHint: false } } }), true);

console.log('task-lifecycle-mcp handler coverage ok');
