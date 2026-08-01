import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcpProtocolSmoke, spawnJsonlMcpServer } from '@narada-core/mcp-e2e-harness';

const root = mkdtempSync(join(tmpdir(), 'scheduler-mcp-protocol-'));
const serverPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const server = spawnJsonlMcpServer(process.execPath, [serverPath, '--allowed-root', root], { label: 'scheduler-mcp protocol smoke' });

try {
  const protocol = await runMcpProtocolSmoke(server.client, { expectedServerName: 'scheduler-mcp' });
  const tools = protocol.tools.tools as any[];
  const expectedTools = [
    'scheduler_guidance',
    'scheduler_runtime_status',
    'scheduler_task_list',
    'scheduler_task_show',
    'scheduler_task_create',
    'scheduler_task_delete',
    'scheduler_task_update_action',
    'scheduler_task_enable',
    'scheduler_task_disable',
    'scheduler_task_stop',
    'scheduler_task_run',
    'scheduler_task_history',
    'scheduler_activation_doctor',
    'scheduler_activation_prepare',
    'scheduler_binding_list',
    'scheduler_binding_show',
    'scheduler_binding_upsert',
    'scheduler_binding_pause',
    'scheduler_binding_resume',
    'scheduler_binding_retire',
    'scheduler_event_show',
    'scheduler_event_admit',
    'scheduler_activation_list',
    'scheduler_activation_claim',
    'scheduler_activation_admit_sop',
    'scheduler_activation_fail',
    'scheduler_activation_resolve',
    'scheduler_activation_unblock',
  ];
  assert.deepEqual(tools.map((t: { name: string }) => t.name), expectedTools);

  const runtimeStatusTool = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_runtime_status');
  assert.equal(runtimeStatusTool?.annotations.readOnlyHint, true);
  assert.equal(runtimeStatusTool?.annotations.destructiveHint, false);

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
  assert.ok(createProps.execution_time_limit_seconds);
  assert.ok(createProps.multiple_instances);
  assert.ok(createProps.implementation_id);
  assert.deepEqual((tools.find((t: { name: string }) => t.name === 'scheduler_task_create') as any).inputSchema.required, ['task_name', 'command', 'schedule', 'implementation_id']);

  const showTool = tools.find((t: { name: string; inputSchema: { properties: Record<string, unknown> } }) => t.name === 'scheduler_task_show');
  assert.deepEqual((showTool as any).inputSchema.required, ['task_name']);
  assert.ok(showTool.inputSchema.properties.task_name);

  const activationDoctor = tools.find((t: { name: string; annotations: Record<string, unknown> }) => t.name === 'scheduler_activation_doctor');
  assert.equal(activationDoctor.annotations.readOnlyHint, true);

  for (const name of ['scheduler_binding_upsert', 'scheduler_event_admit', 'scheduler_activation_claim']) {
    const tool = tools.find((candidate: { name: string }) => candidate.name === name) as any;
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.ok(tool.inputSchema.properties.implementation_id);
    assert.ok(tool.inputSchema.required.includes('implementation_id'));
  }

  for (const name of ['scheduler_activation_admit_sop', 'scheduler_activation_fail']) {
    const tool = tools.find((candidate: { name: string }) => candidate.name === name) as any;
    assert.ok(tool.inputSchema.properties.lease_token);
    assert.ok(tool.inputSchema.required.includes('lease_token'));
  }

  console.log('scheduler-mcp protocol smoke ok');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
