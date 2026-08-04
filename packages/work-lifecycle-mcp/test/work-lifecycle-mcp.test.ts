import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  openPreparedWorkLifecycleStore,
  prepareWorkLifecycleStore,
} from '@narada-core/work-lifecycle-core';
import {
  createWorkLifecycleRuntime,
  handleWorkLifecycleMcpRequest,
  listTools,
} from '../src/main.js';
import { surfaceDefinition } from '../src/surface-definition.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

async function call(
  runtime: ReturnType<typeof createWorkLifecycleRuntime>,
  id: number,
  name: string,
  args: JsonRecord,
): Promise<JsonRecord> {
  const response = await handleWorkLifecycleMcpRequest({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  }, runtime);
  assert.ok(response);
  if (response.error) throw new Error(JSON.stringify(response.error));
  return asRecord(asRecord(response.result).structuredContent);
}

test('surface composes first-class ticket tools and revision-gated task tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-lifecycle-mcp-'));
  prepareWorkLifecycleStore(root);
  const store = openPreparedWorkLifecycleStore(root);
  const runtime = createWorkLifecycleRuntime({ siteRoot: root, store });
  try {
    const definition = surfaceDefinition();
    assert.equal(definition.descriptor.surface_id, 'work-lifecycle');
    assert.equal(definition.descriptor.projections[0]?.lifecycle?.mode, 'replayable');
    const tools = listTools();
    assert.ok(tools.some((tool) => tool.name === 'ticket_admit_source'));
    assert.ok(tools.some((tool) => tool.name === 'task_lifecycle_create'));
    assert.equal(tools.some((tool) => tool.name === 'task_lifecycle_restart'), false);
    assert.equal(tools.some((tool) => tool.name === 'task_lifecycle_compatibility_reconcile'), false);

    const closeTool = tools.find((tool) => tool.name === 'task_lifecycle_close');
    assert.ok(closeTool);
    const closeInput = closeTool.inputSchema as JsonRecord;
    const closeRequired = closeInput.required as string[];
    assert.ok(closeRequired.includes('expected_revision'));

    const admittedOperation = await call(runtime, 1, 'ticket_admit_source', {
      source_kind: 'mailbox_message',
      source_scope: 'help@global-maxima.com',
      immutable_source_id: 'message-1',
      idempotency_key: 'admit:message-1',
      causation_id: 'sync:message-1',
      policy_version: 'admission-v1',
      summary: 'First support message',
      source_ref: { mailbox_id: 'support', message_id: 'message-1' },
      correlation_keys: [{
        kind: 'conversation_id',
        scope: 'help@global-maxima.com',
        value: 'conversation-1',
      }],
    });
    assert.equal(admittedOperation.schema, 'narada.domain_operation.v1');
    assert.equal(admittedOperation.outcome, 'completed');
    const admitted = asRecord(admittedOperation.result);
    assert.equal(admitted.status, 'created');

    const contextOperation = await call(runtime, 2, 'ticket_processing_context_load', {
      ticket_id: admitted.ticket_id,
      triggering_event_id: admitted.event_id,
      idempotency_key: 'load-context:message-1',
    });
    assert.equal(contextOperation.schema, 'narada.domain_operation.v1');
    const context = asRecord(contextOperation.result);
    assert.equal(asRecord(context.ticket).revision, 1);
    assert.equal(asRecord(context.triggering_event).event_id, admitted.event_id);

    const shown = await call(runtime, 3, 'ticket_show', {
      ticket_id: admitted.ticket_id,
    });
    assert.equal(asRecord(shown.ticket).revision, 1);
    assert.equal((shown.sources as unknown[]).length, 1);
    const doctor = await call(runtime, 4, 'work_lifecycle_doctor', {});
    assert.equal(asRecord(doctor.concurrency).posture, 'sqlite_wal_transactional_multi_process');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
