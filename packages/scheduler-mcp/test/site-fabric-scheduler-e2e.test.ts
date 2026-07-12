import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  runMcpProtocolSmoke,
  spawnJsonlMcpServer,
  type JsonRecord,
} from '@narada2/mcp-e2e-harness';

const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath], {
  label: 'scheduler host-authority e2e',
  timeoutMs: 40_000,
});
const taskName = `\\NaradaMcpSurfacesE2e-${Date.now()}`;
let created = false;

function structured(response: JsonRecord): JsonRecord {
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = response.result as JsonRecord;
  return (result.structuredContent as JsonRecord) ?? result;
}

function futureStartTime(): string {
  const start = new Date(Date.now() + 120_000);
  return `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
}

try {
  await runMcpProtocolSmoke(server.client, {
    expectedServerName: 'scheduler-mcp',
    requiredTools: ['scheduler_task_create', 'scheduler_task_show', 'scheduler_task_run', 'scheduler_task_history', 'scheduler_task_delete'],
  });

  const createResponse = await server.client.request(1, 'tools/call', {
    name: 'scheduler_task_create',
    arguments: {
      task_name: taskName,
      command: 'cmd.exe',
      arguments: '/c exit 0',
      schedule: 'once',
      start_time: futureStartTime(),
      description: 'Disposable MCP surface host-authority E2E task.',
    },
  });
  if (createResponse.error) {
    const message = String((createResponse.error as JsonRecord).message ?? 'scheduler authority unavailable');
    console.log(JSON.stringify({ status: 'not_run', test_id: 'scheduler.site-fabric.host-task', reason: 'scheduler_authority_unavailable', details: message, cleanup: 'not_required' }));
  } else {
    const createdResult = structured(createResponse);
    created = true;
    assert.equal(createdResult.status, 'created', JSON.stringify(createdResult));

    const shown = structured(await server.client.request(2, 'tools/call', { name: 'scheduler_task_show', arguments: { task_name: taskName } }));
    assert.equal((shown.task as JsonRecord).TaskName, taskName, JSON.stringify(shown));

    const run = structured(await server.client.request(3, 'tools/call', { name: 'scheduler_task_run', arguments: { task_name: taskName } }));
    assert.equal(run.status, 'started', JSON.stringify(run));

    const history = structured(await server.client.request(4, 'tools/call', { name: 'scheduler_task_history', arguments: { task_name: taskName, limit: 5 } }));
    assert.ok(Array.isArray(history.items), JSON.stringify(history));
    console.log(JSON.stringify({ status: 'passed', test_id: 'scheduler.site-fabric.host-task', task_name: taskName, cleanup: 'pending_until_finally' }));
  }
} finally {
  if (created) {
    const deleted = await server.client.request(5, 'tools/call', { name: 'scheduler_task_delete', arguments: { task_name: taskName } });
    assert.equal(deleted.error, undefined, JSON.stringify(deleted));
    assert.equal((structured(deleted)).status, 'deleted', JSON.stringify(deleted));
  }
  await server.close();
}

console.log('scheduler host-authority e2e complete');
