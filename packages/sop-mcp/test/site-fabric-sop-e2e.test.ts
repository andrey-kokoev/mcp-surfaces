import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  createTemporaryE2eRoot,
  removeTemporaryE2eRoot,
  runMcpProtocolSmoke,
  siteFabricChildEnv,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada-core/mcp-e2e-harness';

const siteRoot = createTemporaryE2eRoot('sop-site-fabric-e2e');
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const valueRef = { ref: 'artifact:site-fixture/ticket', sha256: 'b'.repeat(64), byte_length: 100, media_type: 'application/json' };

function startServer(label: string) {
  return spawnJsonlMcpServer(process.execPath, [serverPath, '--sop-root', siteRoot], {
    cwd: siteRoot,
    env: siteFabricChildEnv(siteRoot, { NARADA_SITE_ID: 'fixture-site' }),
    label,
  });
}

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

let server = startServer('sop Site-fabric durable action e2e');
let runId = '';
let actionId = '';
const resolution = {
  action_id: '',
  completion_key: 'domain-operation:fixture-1',
  outcome: 'completed',
  operation_ref: 'task_event:fixture-1',
  result: { ticket_id: 'ticket-fixture-1' },
  result_ref: valueRef,
};

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'sop-mcp',
    requiredTools: ['sop_template_create', 'sop_run_start', 'sop_run_status', 'sop_action_show', 'sop_action_list', 'sop_action_resolve', 'sop_run_events'],
  });
  const created = structured(await server.client.request(1, 'tools/call', {
    name: 'sop_template_create',
    arguments: {
      sop_id: 'site-fabric-action',
      title: 'Site Fabric Durable Action',
      description: 'Restart boundary fixture for one governed action handoff.',
      input_schema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'], additionalProperties: false },
      output: { ticket_id: { $ref: 'steps.create_ticket.result.ticket_id' } },
      output_ref: { $ref: 'steps.create_ticket.result_ref' },
      steps: [{
        id: 'create_ticket', executor: 'action', blocking: false, title: 'Create ticket', instructions: 'Create ticket for {{input.message_id}}.', depends_on: [],
        action: {
          surface_id: 'task-lifecycle',
          tool_name: 'task_create',
          idempotency_key_argument: 'occurrence_key',
          arguments: { source_message_id: { $ref: 'input.message_id' } },
        },
      }],
      trigger_kind: 'manual',
    },
  }));
  assert.equal(created.status, 'created', JSON.stringify(created));

  const started = structured(await server.client.request(2, 'tools/call', {
    name: 'sop_run_start',
    arguments: { sop_id: 'site-fabric-action', occurrence_key: 'message:fixture-1', input: { message_id: 'fixture-1' }, triggered_by: 'fixture-scheduler' },
  }));
  runId = String(started.run_id);
  actionId = String((started.step_states as JsonRecord[])[0].action_id);
  resolution.action_id = actionId;
  assert.equal(started.status, 'running', JSON.stringify(started));
  assert.match(actionId, /^soa_/);
  await server.close();

  // Process restart after intent persistence but before the domain effect acknowledgement.
  server = startServer('sop Site-fabric pending-action resume');
  await runMcpProtocolSmoke(server.client, { expectedServerName: 'sop-mcp', requiredTools: ['sop_action_show', 'sop_action_list', 'sop_action_resolve', 'sop_run_status'] });
  const pendingAction = structured(await server.client.request(3, 'tools/call', { name: 'sop_action_show', arguments: { action_id: actionId } }));
  assert.equal(pendingAction.status, 'pending', JSON.stringify(pendingAction));
  const pendingList = structured(await server.client.request(4, 'tools/call', { name: 'sop_action_list', arguments: { run_id: runId, status: 'pending' } }));
  assert.equal(pendingList.count, 1, JSON.stringify(pendingList));
  const resolved = structured(await server.client.request(5, 'tools/call', { name: 'sop_action_resolve', arguments: resolution }));
  assert.equal((resolved.run as JsonRecord).status, 'completed', JSON.stringify(resolved));
  await server.close();

  // A second restart preserves the terminal acknowledgement and exact retry semantics.
  server = startServer('sop Site-fabric completed-action resume');
  const completed = structured(await server.client.request(6, 'tools/call', { name: 'sop_run_status', arguments: { run_id: runId } }));
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.deepEqual(completed.output, { ticket_id: 'ticket-fixture-1' });
  assert.deepEqual(completed.output_ref, valueRef);
  const replayed = structured(await server.client.request(7, 'tools/call', { name: 'sop_action_resolve', arguments: resolution }));
  assert.equal(replayed.completion_replayed, true, JSON.stringify(replayed));
  const events = structured(await server.client.request(8, 'tools/call', { name: 'sop_run_events', arguments: { run_id: runId, limit: 50 } }));
  assert.ok(Number(events.count) >= 4, JSON.stringify(events));

  console.log(JSON.stringify({ status: 'passed', test_id: 'sop.site-fabric.durable-action-restart', site_root: siteRoot, run_id: runId, action_id: actionId }));
} finally {
  await server.close().catch(() => undefined);
  assert.equal(removeTemporaryE2eRoot(siteRoot), true);
}

console.log('sop Site fabric e2e ok');
