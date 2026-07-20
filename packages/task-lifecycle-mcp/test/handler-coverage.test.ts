import assert from 'node:assert/strict';
import {
  assertTaskLifecycleHandlerCoverage,
  createTaskLifecycleHandlerRegistry,
  PAYLOAD_OUTPUT_TOOL_NAMES,
} from '../src/task-lifecycle/task-lifecycle-handler-registry.js';
import { createTaskLifecycleToolCaller, isStoreRetrySafe, validateTaskCreatePayload } from '../src/kernel/tool-call-pipeline.js';

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
assert.throws(() => validateTaskCreatePayload({ title: 'Reject null tags', tags: null }), /task_lifecycle_create_payload_tags_invalid:task_tags_must_be_array/);
assert.throws(() => validateTaskCreatePayload({ title: 'Reject malformed tags', tags: ['not/a-label'] }), /task_lifecycle_create_payload_tags_invalid:task_tag_invalid_format/);
assert.equal(isStoreRetrySafe({ canonicalName: 'task_lifecycle_claim', args: {}, toolDef: { annotations: { readOnlyHint: false, idempotentHint: false } } }), false);
assert.equal(isStoreRetrySafe({ canonicalName: 'task_lifecycle_claim', args: { idempotency_key: 'claim-1' }, toolDef: { annotations: { readOnlyHint: false, idempotentHint: false } } }), true);
assert.equal(isStoreRetrySafe({ canonicalName: 'task_lifecycle_status', args: {}, toolDef: { annotations: { readOnlyHint: true, idempotentHint: false } } }), true);

const pipelineCaller = createTaskLifecycleToolCaller({
  toolAliases: {},
  taskLifecycleTools: () => [{
    name: 'task_lifecycle_claim',
    description: 'test',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: false, idempotentHint: false },
  }],
  siteRoot: 'D:\\code\\mcp-surfaces',
  dispatchTool: async () => {
    throw new Error('database is not open');
  },
  refreshStore: () => true,
  jsonToolResult: (payload: unknown, isError = false) => ({ payload, isError }),
  resolveToolPayloadArgs: ({ args }: { args: Record<string, unknown> }) => ({ args, payloadSource: null }),
  enforceInlinePayloadLimit: () => {},
  locusGuardedMutationTools: new Set(),
});

await assert.rejects(
  pipelineCaller({ name: 'task_lifecycle_claim', arguments: {} }),
  (error: unknown) => {
    assert.match(String(error instanceof Error ? error.message : error), /store_unavailable_after_attempt/);
    assert.match(String(error instanceof Error ? error.message : error), /original_error=database is not open/);
    return true;
  },
);

console.log('task-lifecycle-mcp handler coverage ok');
