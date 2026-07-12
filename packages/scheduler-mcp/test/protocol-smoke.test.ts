import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada2/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'scheduler-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--allowed-root', root], { label: 'scheduler-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'scheduler-mcp' });
  const tools = protocol.tools.tools as Record<string, any>[];
  const expectedTools = [
    'scheduler_guidance',
    'scheduler_task_list',
    'scheduler_task_show',
    'scheduler_task_create',
    'scheduler_task_delete',
    'scheduler_task_update_action',
    'scheduler_task_enable',
    'scheduler_task_disable',
    'scheduler_task_run',
    'scheduler_task_history',
  ];
  assert.deepEqual(tools.map((t: { name: string }) => t.name), expectedTools);

  const listTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_task_list');
  assert.equal(listTool.annotations.readOnlyHint, true);

  const createTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_task_create');
  assert.equal(createTool.annotations.readOnlyHint, false);
  assert.equal(createTool.annotations.destructiveHint, false);

  const deleteTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_task_delete');
  assert.equal(deleteTool.annotations.destructiveHint, true);

  const createProps = (tools.find((t: { name: string }) => t.name === 'scheduler_task_create') as any).inputSchema.properties;
  assert.ok(createProps.task_name);
  assert.ok(createProps.command);
  assert.ok(createProps.schedule);
  assert.ok(createProps.arguments);
  assert.ok(createProps.working_dir);

  const showTool = tools.find((t: { name: string; inputSchema: { properties: Record<string, unknown> } }) => t.name === 'scheduler_task_show');
  assert.ok(showTool.inputSchema.properties.task_name);

  console.log('scheduler-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
