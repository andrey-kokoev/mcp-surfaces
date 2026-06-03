import assert from 'node:assert/strict';
import {
  assertTaskLifecycleHandlerCoverage,
  createTaskLifecycleHandlerRegistry,
  PAYLOAD_OUTPUT_TOOL_NAMES,
} from '../src/task-lifecycle/task-lifecycle-handler-registry.js';

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

console.log('task-lifecycle-mcp handler coverage ok');
